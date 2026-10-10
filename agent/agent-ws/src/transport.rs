//! The outbound connection. One thread with its own current-thread runtime exists only while the
//! layer is armed; it dials the relay, authenticates, answers resyncs and moves frames.

use crate::backoff::{jitter, Backoff};
use crate::identity::{auth_message, random_b64u, Identity};
use crate::tls;
use agent_core::{
    decode, encode, reject_undecodable_action, Frame, Hello, RemoteControl, Role, PING_FRAME,
    PONG_FRAME, PROTOCOL_VERSION,
};
use agent_core::{AuthResponse, ErrorCode, MAX_FRAME_BYTES};
use futures_util::{SinkExt, StreamExt};
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tokio::sync::Notify;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async_tls_with_config, Connector};

/// Transport settings. The defaults suit production; tests shorten them.
#[derive(Debug, Clone)]
pub struct WsConfig {
    /// Sent in `hello`: 1 to 32 characters of letters, digits, `.`, `+` and `-`.
    pub agent_version: String,
    /// How often the outbound queue is checked even if nothing woke the thread.
    pub poll_interval: Duration,
    /// How often the byte-constant `ping` frame is sent.
    pub ping_interval: Duration,
    /// A connection that hears nothing for this long is dropped.
    pub idle_timeout: Duration,
    /// Longest wait for the TCP/TLS/WebSocket upgrade and for each handshake frame.
    pub connect_timeout: Duration,
    pub backoff_min: Duration,
    pub backoff_max: Duration,
    /// How long to wait before retrying after the relay says the install is locked.
    pub locked_retry: Duration,
    /// A connection must stay authenticated this long before the backoff resets.
    pub healthy_after: Duration,
    /// Trust the OS certificate store (needs the `os-roots` feature; otherwise ignored).
    pub trust_os_store: bool,
}

impl Default for WsConfig {
    fn default() -> Self {
        Self {
            agent_version: env!("CARGO_PKG_VERSION").to_string(),
            poll_interval: Duration::from_millis(200),
            ping_interval: Duration::from_secs(25),
            idle_timeout: Duration::from_secs(75),
            connect_timeout: Duration::from_secs(15),
            backoff_min: Duration::from_secs(1),
            backoff_max: Duration::from_secs(60),
            locked_retry: Duration::from_secs(60),
            healthy_after: Duration::from_secs(10),
            trust_os_store: false,
        }
    }
}

/// What the transport reports to an optional observer. Codes only: no URLs, no error text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportEvent {
    Connecting,
    Authenticated,
    /// The connection ended; the reason is a short kebab-case code.
    Disconnected(&'static str),
    /// The next attempt is this many milliseconds away.
    Waiting(u64),
}

type Observer = Arc<dyn Fn(TransportEvent) + Send + Sync>;

struct State {
    running: bool,
    handle: Option<JoinHandle<()>>,
}

struct Shared {
    rc: Arc<RemoteControl>,
    identity: Identity,
    cfg: WsConfig,
    observer: Option<Observer>,
    state: Mutex<State>,
    wake: Notify,
    stop: AtomicBool,
}

/// How a connection ended.
struct Outcome {
    reason: &'static str,
    authenticated: bool,
    locked: bool,
}

impl Outcome {
    fn new(reason: &'static str) -> Self {
        Self {
            reason,
            authenticated: false,
            locked: false,
        }
    }
}

/// The transport. Dropping it stops the thread.
pub struct AgentWs {
    shared: Arc<Shared>,
}

impl AgentWs {
    /// Hooks the transport into the layer. Nothing runs until the layer is armed, and the thread
    /// exits again when it is disarmed.
    pub fn install(
        rc: Arc<RemoteControl>,
        identity: Identity,
        cfg: WsConfig,
        observer: Option<Observer>,
    ) -> Self {
        let shared = Arc::new(Shared {
            rc: rc.clone(),
            identity,
            cfg,
            observer,
            state: Mutex::new(State {
                running: false,
                handle: None,
            }),
            wake: Notify::new(),
            stop: AtomicBool::new(false),
        });
        let weak: Weak<Shared> = Arc::downgrade(&shared);
        rc.set_waker(Arc::new(move || {
            if let Some(shared) = weak.upgrade() {
                shared.on_wake();
            }
        }));
        shared.on_wake();
        Self { shared }
    }

    /// True while the transport thread exists.
    pub fn is_running(&self) -> bool {
        self.shared.lock().running
    }

    /// Waits up to `timeout` for the thread to be gone. True when it is.
    pub fn wait_stopped(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if !self.is_running() {
                self.shared.reap();
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        !self.is_running()
    }

    /// Stops the transport for good and joins the thread.
    pub fn shutdown(&self) {
        self.shared.stop.store(true, Ordering::SeqCst);
        self.shared.wake.notify_one();
        let handle = self.shared.lock().handle.take();
        if let Some(handle) = handle {
            let _ = handle.join();
        }
    }
}

impl Drop for AgentWs {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl Shared {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn emit(&self, event: TransportEvent) {
        if let Some(observer) = &self.observer {
            observer(event);
        }
    }

    fn should_run(&self) -> bool {
        !self.stop.load(Ordering::SeqCst) && self.rc.is_armed()
    }

    /// Joins a thread that has already announced its exit.
    fn reap(&self) {
        let handle = {
            let mut st = self.lock();
            if st.running {
                return;
            }
            st.handle.take()
        };
        if let Some(handle) = handle {
            let _ = handle.join();
        }
    }

    /// The layer's waker: start the thread if armed and none runs, otherwise nudge it.
    fn on_wake(self: &Arc<Self>) {
        self.wake.notify_one();
        let old = {
            let mut st = self.lock();
            if st.running || !self.should_run() {
                return;
            }
            let shared = self.clone();
            let spawned = std::thread::Builder::new()
                .name("remote-console-ws".into())
                .spawn(move || shared.thread_main());
            match spawned {
                Ok(handle) => {
                    st.running = true;
                    st.handle.replace(handle)
                }
                Err(_) => return,
            }
        };
        if let Some(old) = old {
            let _ = old.join();
        }
    }

    fn thread_main(self: Arc<Self>) {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
        if let Ok(runtime) = runtime {
            runtime.block_on(self.run());
        }
        self.rc.set_connected(false);
        self.lock().running = false;
    }

    /// Reconnects until the layer is disarmed. The exit decision is taken under the state lock,
    /// so a re-arm either keeps this loop alive or starts a fresh thread: never neither.
    async fn run(&self) {
        let mut backoff = Backoff::new(self.cfg.backoff_min, self.cfg.backoff_max);
        loop {
            {
                let mut st = self.lock();
                if !self.should_run() {
                    st.running = false;
                    return;
                }
            }
            self.emit(TransportEvent::Connecting);
            let started = Instant::now();
            let outcome = self.connection().await;
            self.rc.set_connected(false);
            self.emit(TransportEvent::Disconnected(outcome.reason));
            if outcome.authenticated && started.elapsed() >= self.cfg.healthy_after {
                backoff.reset();
            }
            let delay = if outcome.locked {
                let base = self.cfg.locked_retry.as_millis() as u64;
                Duration::from_millis(base / 2 + jitter(base / 2 + 1))
            } else {
                backoff.next_delay()
            };
            if !self.should_run() {
                continue;
            }
            self.emit(TransportEvent::Waiting(delay.as_millis() as u64));
            self.sleep_while_running(delay).await;
        }
    }

    async fn sleep_while_running(&self, total: Duration) {
        let deadline = Instant::now() + total;
        while self.should_run() && Instant::now() < deadline {
            let step = (deadline - Instant::now()).min(Duration::from_millis(100));
            tokio::time::sleep(step).await;
        }
    }

    /// Runs `fut` unless the layer is disarmed first.
    async fn unless_stopped<T>(&self, fut: impl Future<Output = T>) -> Option<T> {
        tokio::select! {
            out = fut => Some(out),
            _ = async {
                while self.should_run() {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            } => None,
        }
    }

    async fn connection(&self) -> Outcome {
        let Some(session_id) = self.rc.session_id() else {
            return Outcome::new("disarmed");
        };
        let url = format!(
            "{}/agent/ws?install={}",
            self.rc.config().relay_url.trim_end_matches('/'),
            self.identity.install_id()
        );
        let ws_config = WebSocketConfig::default()
            .max_message_size(Some(MAX_FRAME_BYTES))
            .max_frame_size(Some(MAX_FRAME_BYTES));
        let connector = Connector::Rustls(tls::client_config(self.cfg.trust_os_store));
        let dial = tokio::time::timeout(
            self.cfg.connect_timeout,
            connect_async_tls_with_config(url, Some(ws_config), false, Some(connector)),
        );
        let mut ws = match self.unless_stopped(dial).await {
            None => return Outcome::new("disarmed"),
            Some(Err(_)) => return Outcome::new("connect-timeout"),
            Some(Ok(Err(_))) => return Outcome::new("connect-failed"),
            Some(Ok(Ok((ws, _response)))) => ws,
        };
        let outcome = match self
            .unless_stopped(self.handshake(&mut ws, &session_id))
            .await
        {
            None => Outcome::new("disarmed"),
            Some(Err(outcome)) => outcome,
            Some(Ok(())) => self.serve(&mut ws, &session_id).await,
        };
        let _ = tokio::time::timeout(
            Duration::from_millis(500),
            ws.close(Some(tokio_tungstenite::tungstenite::protocol::CloseFrame {
                code: tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::Normal,
                reason: "".into(),
            })),
        )
        .await;
        outcome
    }

    /// `hello`, then answer the challenge, then wait for `auth-ok`.
    async fn handshake<S>(&self, ws: &mut S, session_id: &str) -> Result<(), Outcome>
    where
        S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
            + SinkExt<Message>
            + Unpin,
    {
        let hello = Frame::Hello(Hello {
            role: Role::Agent,
            protocol_versions: vec![PROTOCOL_VERSION],
            install_id: Some(self.identity.install_id().to_string()),
            session_id: Some(session_id.to_string()),
            app_id: Some(self.rc.config().app_id.clone()),
            agent_version: Some(self.cfg.agent_version.clone()),
        });
        send_frame(ws, &hello, self.cfg.connect_timeout).await?;
        let nonce = match self.next_frame(ws).await? {
            Frame::AuthChallenge(c) => c.nonce,
            Frame::Error(e) => return Err(self.error_outcome(e.code)),
            _ => return Err(Outcome::new("unexpected-frame")),
        };
        let agent_nonce = random_b64u::<32>().map_err(|_| Outcome::new("no-randomness"))?;
        let signature = self.identity.sign(&auth_message(
            self.identity.install_id(),
            session_id,
            &nonce,
            &agent_nonce,
        ));
        let response = Frame::AuthResponse(AuthResponse {
            agent_nonce,
            signature,
        });
        send_frame(ws, &response, self.cfg.connect_timeout).await?;
        match self.next_frame(ws).await? {
            Frame::AuthOk(_) => {
                self.rc.set_locked(false);
                self.rc.set_connected(true);
                self.emit(TransportEvent::Authenticated);
                Ok(())
            }
            Frame::Error(e) => Err(self.error_outcome(e.code)),
            _ => Err(Outcome::new("unexpected-frame")),
        }
    }

    fn error_outcome(&self, code: ErrorCode) -> Outcome {
        let reason = match code {
            ErrorCode::Malformed => "relay-malformed",
            ErrorCode::UnsupportedVersion => "relay-unsupported-version",
            ErrorCode::Unauthorized => "relay-unauthorized",
            ErrorCode::NotPaired => "relay-not-paired",
            ErrorCode::Locked => "relay-locked",
            ErrorCode::Expired => "relay-expired",
            ErrorCode::TooManyConnections => "relay-too-many-connections",
            ErrorCode::RateLimited => "relay-rate-limited",
            ErrorCode::FrameTooLarge => "relay-frame-too-large",
            ErrorCode::Internal => "relay-internal",
        };
        let locked = matches!(code, ErrorCode::Locked);
        if locked {
            self.rc.set_locked(true);
        }
        Outcome {
            reason,
            authenticated: false,
            // A not-paired install also waits the long interval: retrying quickly helps nobody.
            locked: locked || matches!(code, ErrorCode::NotPaired | ErrorCode::Unauthorized),
        }
    }

    /// The next decodable frame, within the connect timeout.
    async fn next_frame<S>(&self, ws: &mut S) -> Result<Frame, Outcome>
    where
        S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
    {
        let limit = self.cfg.connect_timeout;
        loop {
            match tokio::time::timeout(limit, ws.next()).await {
                Err(_) => return Err(Outcome::new("handshake-timeout")),
                Ok(None) => return Err(Outcome::new("closed-by-relay")),
                Ok(Some(Err(_))) => return Err(Outcome::new("socket-error")),
                Ok(Some(Ok(Message::Text(text)))) => {
                    return decode(text.as_str()).map_err(|_| Outcome::new("undecodable-frame"))
                }
                Ok(Some(Ok(Message::Close(_)))) => return Err(Outcome::new("closed-by-relay")),
                Ok(Some(Ok(_))) => continue,
            }
        }
    }

    /// The authenticated phase: answer the relay, flush our queue, keep the link alive.
    async fn serve<S>(&self, ws: &mut S, session_id: &str) -> Outcome
    where
        S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
            + SinkExt<Message>
            + Unpin,
    {
        let mut last_rx = Instant::now();
        let mut last_ping = Instant::now();
        let mut synced = false;
        let mut poll = tokio::time::interval(self.cfg.poll_interval);
        let done = |reason: &'static str, locked: bool| Outcome {
            reason,
            authenticated: true,
            locked,
        };
        loop {
            tokio::select! {
                incoming = ws.next() => match incoming {
                    None => return done("closed-by-relay", false),
                    Some(Err(_)) => return done("socket-error", false),
                    Some(Ok(Message::Close(_))) => return done("closed-by-relay", self.rc.view().locked),
                    Some(Ok(Message::Text(text))) => {
                        last_rx = Instant::now();
                        match self.on_text(ws, text.as_str(), &mut synced).await {
                            Ok(()) => {}
                            Err(outcome) => return Outcome { authenticated: true, ..outcome },
                        }
                    }
                    Some(Ok(Message::Binary(_))) => return done("binary-frame", false),
                    Some(Ok(_)) => { last_rx = Instant::now(); }
                },
                _ = poll.tick() => {}
                _ = self.wake.notified() => {}
            }
            if !self.should_run() || self.rc.session_id().as_deref() != Some(session_id) {
                return done("disarmed", false);
            }
            if synced {
                for frame in self.rc.poll_outbound() {
                    if let Err(outcome) = send_frame(ws, &frame, self.cfg.connect_timeout).await {
                        return Outcome {
                            authenticated: true,
                            ..outcome
                        };
                    }
                }
            }
            if last_ping.elapsed() >= self.cfg.ping_interval {
                last_ping = Instant::now();
                if send_text(ws, PING_FRAME, self.cfg.connect_timeout)
                    .await
                    .is_err()
                {
                    return done("socket-error", false);
                }
            }
            if last_rx.elapsed() >= self.cfg.idle_timeout {
                return done("idle-timeout", false);
            }
        }
    }

    async fn on_text<S>(&self, ws: &mut S, text: &str, synced: &mut bool) -> Result<(), Outcome>
    where
        S: SinkExt<Message> + Unpin,
    {
        if text == PONG_FRAME {
            return Ok(());
        }
        match decode(text) {
            Ok(Frame::Error(e)) => {
                let outcome = self.error_outcome(e.code);
                if e.fatal {
                    return Err(outcome);
                }
                Ok(())
            }
            Ok(frame) => {
                let first_resync = matches!(frame, Frame::Resync(_)) && !*synced;
                if matches!(frame, Frame::Resync(_)) {
                    *synced = true;
                }
                for out in self.rc.handle_frame(frame) {
                    send_frame(ws, &out, self.cfg.connect_timeout).await?;
                }
                if first_resync {
                    // Tells the relay when this session ends, so dashboards can show the countdown.
                    let armed = Frame::Event(agent_core::EventFrame {
                        seq: 0,
                        body: agent_core::EventBody::ArmedState(agent_core::ArmedState {
                            armed: true,
                            expires_at_ms: self.rc.view().expires_at_ms,
                            viewers: None,
                        }),
                    });
                    send_frame(ws, &armed, self.cfg.connect_timeout).await?;
                }
                Ok(())
            }
            Err(_) => {
                if let Some(result) = reject_undecodable_action(text) {
                    send_frame(ws, &Frame::ActionResult(result), self.cfg.connect_timeout).await?;
                }
                Ok(())
            }
        }
    }
}

async fn send_text<S>(ws: &mut S, text: &str, limit: Duration) -> Result<(), Outcome>
where
    S: SinkExt<Message> + Unpin,
{
    match tokio::time::timeout(limit, ws.send(Message::text(text.to_string()))).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(_)) => Err(Outcome::new("socket-error")),
        Err(_) => Err(Outcome::new("send-timeout")),
    }
}

async fn send_frame<S>(ws: &mut S, frame: &Frame, limit: Duration) -> Result<(), Outcome>
where
    S: SinkExt<Message> + Unpin,
{
    match encode(frame) {
        Ok(text) => send_text(ws, &text, limit).await,
        // A frame we cannot encode is our bug, not the connection's: drop it and carry on.
        Err(_) => Ok(()),
    }
}
