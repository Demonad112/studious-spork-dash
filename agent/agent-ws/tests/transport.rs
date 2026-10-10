//! The transport against a stand-in relay running on localhost.

use agent_core::{
    decode, AppAction, AppBridge, ApplyOutcome, Config, Deps, Frame, MemorySecretStore,
    RemoteControl,
};
use agent_ws::identity::auth_message;
use agent_ws::{AgentWs, Identity, TransportEvent, WsConfig};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use futures_util::{SinkExt, StreamExt};
use std::net::TcpListener;
use std::sync::mpsc::{channel, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio_tungstenite::tungstenite::Message;

const NONCE: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

struct Bridge;

impl AppBridge for Bridge {
    fn apply(&self, _action: AppAction) -> ApplyOutcome {
        ApplyOutcome::NotApplicable
    }
}

#[derive(Clone, Copy, Default)]
struct Behaviour {
    /// Close the first connection right after `hello`.
    drop_first: bool,
    /// Answer `hello` with a fatal `locked` error.
    locked: bool,
    /// Send a `status` action after the resync.
    send_action: bool,
    /// Never send `auth-ok`.
    silent_after_response: bool,
}

#[derive(Debug)]
enum Seen {
    Connection,
    SignatureOk(bool),
    Frame(Box<Frame>),
}

struct Server {
    port: u16,
    seen: Receiver<Seen>,
}

fn spawn_server(identity: &Identity, behaviour: Behaviour) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, seen) = channel();
    let public: [u8; 32] = URL_SAFE_NO_PAD
        .decode(identity.public_key())
        .unwrap()
        .try_into()
        .unwrap();
    let key = VerifyingKey::from_bytes(&public).unwrap();
    let install = identity.install_id().to_string();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async move {
            let listener = tokio::net::TcpListener::from_std(listener).unwrap();
            let mut count = 0;
            loop {
                let Ok((tcp, _)) = listener.accept().await else {
                    return;
                };
                count += 1;
                let tx = tx.clone();
                let key = key;
                let install = install.clone();
                let first = count == 1;
                tokio::spawn(async move {
                    let Ok(mut ws) = tokio_tungstenite::accept_async(tcp).await else {
                        return;
                    };
                    let _ = tx.send(Seen::Connection);
                    let Some(Ok(Message::Text(hello))) = ws.next().await else {
                        return;
                    };
                    let Ok(Frame::Hello(h)) = decode(hello.as_str()) else {
                        return;
                    };
                    let session = h.session_id.clone().unwrap();
                    if behaviour.drop_first && first {
                        return;
                    }
                    if behaviour.locked {
                        let _ = ws
                            .send(Message::text(
                                r#"{"v":1,"type":"error","code":"locked","fatal":true}"#,
                            ))
                            .await;
                        return;
                    }
                    let challenge = format!(r#"{{"v":1,"type":"auth-challenge","nonce":"{NONCE}"}}"#);
                    let _ = ws.send(Message::text(challenge)).await;
                    let Some(Ok(Message::Text(response))) = ws.next().await else {
                        return;
                    };
                    let Ok(Frame::AuthResponse(r)) = decode(response.as_str()) else {
                        return;
                    };
                    let message = auth_message(&install, &session, NONCE, &r.agent_nonce);
                    let sig = URL_SAFE_NO_PAD.decode(&r.signature).unwrap_or_default();
                    let ok = Signature::from_slice(&sig)
                        .map(|s| key.verify(message.as_bytes(), &s).is_ok())
                        .unwrap_or(false);
                    let _ = tx.send(Seen::SignatureOk(ok));
                    if behaviour.silent_after_response {
                        tokio::time::sleep(Duration::from_secs(30)).await;
                        return;
                    }
                    let _ = ws
                        .send(Message::text(
                            r#"{"v":1,"type":"auth-ok","serverTimeMs":1}"#,
                        ))
                        .await;
                    let _ = ws
                        .send(Message::text(r#"{"v":1,"type":"resync","lastSeq":0}"#))
                        .await;
                    if behaviour.send_action {
                        let action = r#"{"v":1,"type":"action","actionId":"act-00000001","action":"status"}"#;
                        let _ = ws.send(Message::text(action)).await;
                    }
                    while let Some(Ok(msg)) = ws.next().await {
                        if let Message::Text(t) = msg {
                            if let Ok(frame) = decode(t.as_str()) {
                                let _ = tx.send(Seen::Frame(Box::new(frame)));
                            }
                        }
                    }
                });
            }
        });
    });
    Server { port, seen }
}

struct Rig {
    rc: Arc<RemoteControl>,
    ws: AgentWs,
    server: Server,
    events: Arc<Mutex<Vec<TransportEvent>>>,
}

fn rig(behaviour: Behaviour) -> Rig {
    let identity = Identity::load_or_create(&MemorySecretStore::default()).unwrap();
    let server = spawn_server(&identity, behaviour);
    let config = Config {
        enabled: true,
        app_id: "test".into(),
        relay_url: format!("ws://127.0.0.1:{}", server.port),
        data_dir: std::env::temp_dir().join("agent-ws-tests"),
        ..Config::default()
    };
    let rc = RemoteControl::new(config, Deps::new(Arc::new(Bridge))).unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let cfg = WsConfig {
        poll_interval: Duration::from_millis(20),
        backoff_min: Duration::from_millis(40),
        backoff_max: Duration::from_millis(200),
        locked_retry: Duration::from_millis(400),
        connect_timeout: Duration::from_secs(2),
        ..WsConfig::default()
    };
    let ws = AgentWs::install(
        rc.clone(),
        identity,
        cfg,
        Some(Arc::new(move |e| sink.lock().unwrap().push(e))),
    );
    Rig {
        rc,
        ws,
        server,
        events,
    }
}

fn wait_for(what: &str, mut cond: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if cond() {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("timed out waiting for {what}");
}

fn next_frame(rig: &Rig) -> Frame {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if let Ok(Seen::Frame(f)) = rig.server.seen.recv_timeout(Duration::from_millis(50)) {
            return *f;
        }
    }
    panic!("no frame arrived");
}

#[test]
fn a_disarmed_layer_runs_no_transport_thread_and_opens_no_connection() {
    let rig = rig(Behaviour::default());
    std::thread::sleep(Duration::from_millis(300));
    assert!(!rig.ws.is_running());
    assert!(rig.server.seen.try_recv().is_err());
    assert!(rig.events.lock().unwrap().is_empty());
}

#[test]
fn arming_authenticates_with_a_valid_signature_and_answers_the_relay_resync() {
    let rig = rig(Behaviour::default());
    rig.rc.arm_default().unwrap();
    wait_for("the connection", || rig.rc.view().connected);
    assert!(rig.ws.is_running());
    let mut sig_ok = None;
    let mut got = Vec::new();
    wait_for("the resync answer", || {
        while let Ok(seen) = rig.server.seen.try_recv() {
            match seen {
                Seen::SignatureOk(ok) => sig_ok = Some(ok),
                Seen::Frame(f) => got.push(f.type_name()),
                Seen::Connection => {}
            }
        }
        got.len() >= 2
    });
    assert_eq!(sig_ok, Some(true));
    assert_eq!(&got[..2], ["resync-result", "snapshot"]);
}

#[test]
fn the_transport_thread_is_gone_within_two_seconds_of_disarm() {
    let rig = rig(Behaviour::default());
    rig.rc.arm_default().unwrap();
    wait_for("the connection", || rig.rc.view().connected);
    let started = Instant::now();
    rig.rc.disarm(agent_core::DisarmReason::Local);
    assert!(rig.ws.wait_stopped(Duration::from_secs(2)));
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(!rig.rc.view().connected);
    // Arming again starts a fresh thread.
    rig.rc.arm_default().unwrap();
    wait_for("the second connection", || rig.rc.view().connected);
}

#[test]
fn a_dropped_connection_is_retried_after_a_short_wait() {
    let rig = rig(Behaviour {
        drop_first: true,
        ..Behaviour::default()
    });
    rig.rc.arm_default().unwrap();
    wait_for("the retry to authenticate", || rig.rc.view().connected);
    let events = rig.events.lock().unwrap().clone();
    assert!(events
        .iter()
        .any(|e| matches!(e, TransportEvent::Waiting(_))));
}

#[test]
fn a_locked_error_marks_the_layer_locked_and_waits_longer() {
    let rig = rig(Behaviour {
        locked: true,
        ..Behaviour::default()
    });
    rig.rc.arm_default().unwrap();
    wait_for("the locked flag", || rig.rc.view().locked);
    assert!(!rig.rc.view().connected);
    wait_for("the wait", || {
        rig.events
            .lock()
            .unwrap()
            .iter()
            .any(|e| matches!(e, TransportEvent::Waiting(ms) if *ms >= 200))
    });
}

#[test]
fn a_remote_action_is_answered_through_the_layer() {
    let rig = rig(Behaviour {
        send_action: true,
        ..Behaviour::default()
    });
    rig.rc.arm_default().unwrap();
    wait_for("the connection", || rig.rc.view().connected);
    let mut answered = false;
    for _ in 0..5 {
        if let Frame::ActionResult(r) = next_frame(&rig) {
            assert_eq!(r.action_id, "act-00000001");
            answered = true;
            break;
        }
    }
    assert!(answered, "no action-result arrived");
}

#[test]
fn a_relay_that_never_confirms_is_given_up_on_at_the_connect_timeout() {
    let rig = rig(Behaviour {
        silent_after_response: true,
        ..Behaviour::default()
    });
    rig.rc.arm_default().unwrap();
    wait_for("the handshake to time out", || {
        rig.events
            .lock()
            .unwrap()
            .iter()
            .any(|e| matches!(e, TransportEvent::Disconnected("handshake-timeout")))
    });
    assert!(!rig.rc.view().connected);
}
