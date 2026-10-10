//! [`RemoteControl`]: the transport-free heart of the agent.
//!
//! It is `Send + Sync` behind one mutex. Every method computes what it must do while holding the
//! lock and runs the side effects (host callbacks, audit rows, power guard, wake-ups) only after
//! releasing it. Nothing here opens a socket or spawns a thread.

use crate::actions::{decide, Dedup, TokenBucket};
use crate::arm::{ArmRequest, ArmTrigger, DisarmReason};
use crate::audit::{AuditEntry, AuditKind, AuditSink, NullAuditSink};
use crate::bridge::{AppAction, AppBridge, ApplyOutcome, PromptSpec, StatusReport};
use crate::cleanup::CleanupRegistry;
use crate::clock::{Clock, SystemClock};
use crate::config::{Config, PromptTimeout};
use crate::error::{Error, Result};
use crate::ids::{IdSource, StdIds};
use crate::power::{NoopPowerGuard, PowerGuard};
use crate::ring::ReplayRing;
use crate::state::Machine;
use crate::wire::*;
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, SystemTime};

const ISSUED_PROMPTS_KEPT: usize = 32;
const TEMP_PREFIX: &str = "remote-console-";

/// Everything the layer needs from its host besides the configuration.
pub struct Deps {
    pub bridge: Arc<dyn AppBridge>,
    pub clock: Arc<dyn Clock>,
    pub ids: Arc<dyn IdSource>,
    pub audit: Arc<dyn AuditSink>,
    pub power: Arc<dyn PowerGuard>,
    pub trigger: Option<Arc<dyn ArmTrigger>>,
}

impl Deps {
    /// Real clock, random ids, no audit trail, no power guard, no arm trigger.
    pub fn new(bridge: Arc<dyn AppBridge>) -> Self {
        Self {
            bridge,
            clock: Arc::new(SystemClock),
            ids: Arc::new(StdIds::default()),
            audit: Arc::new(NullAuditSink),
            power: Arc::new(NoopPowerGuard),
            trigger: None,
        }
    }

    pub fn with_clock(mut self, clock: Arc<dyn Clock>) -> Self {
        self.clock = clock;
        self
    }

    pub fn with_ids(mut self, ids: Arc<dyn IdSource>) -> Self {
        self.ids = ids;
        self
    }

    pub fn with_audit(mut self, audit: Arc<dyn AuditSink>) -> Self {
        self.audit = audit;
        self
    }

    pub fn with_power(mut self, power: Arc<dyn PowerGuard>) -> Self {
        self.power = power;
        self
    }

    pub fn with_trigger(mut self, trigger: Arc<dyn ArmTrigger>) -> Self {
        self.trigger = Some(trigger);
        self
    }
}

/// A read-only view for the host's "Remote control on" indicator.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteStatus {
    pub armed: bool,
    pub session_id: Option<String>,
    pub expires_at_ms: Option<u64>,
    /// Dashboards attached, as reported by the relay.
    pub viewers: u64,
    pub connected: bool,
    /// The relay revoked this install: it cannot connect until unlocked.
    pub locked: bool,
    pub state: SessionState,
}

enum Effect {
    Audit(AuditEntry),
    Apply(AppAction),
    PowerAcquire,
    PowerRelease,
    Cleanup,
    Sweep,
    Wake,
}

struct Session {
    session_id: String,
    expires_at_ms: u64,
    until_job_ends: bool,
    idle_since_ms: Option<u64>,
    seq: u64,
    ring: ReplayRing,
    machine: Machine,
    outbox: VecDeque<Frame>,
    progress_dirty: bool,
    last_progress_sent_ms: u64,
    bucket: TokenBucket,
    dedup: Dedup,
    issued_prompts: VecDeque<String>,
    prompt_opened_at_ms: Option<u64>,
    /// A remote done or next was accepted for this prompt and the app has not closed it yet.
    pending_remote: Option<String>,
    terminal_flushed: bool,
}

struct Inner {
    session: Option<Session>,
    connected: bool,
    locked: bool,
    viewers: u64,
}

/// The remote console agent layer.
pub struct RemoteControl {
    config: Config,
    clock: Arc<dyn Clock>,
    ids: Arc<dyn IdSource>,
    audit: Arc<dyn AuditSink>,
    power: Arc<dyn PowerGuard>,
    bridge: Arc<dyn AppBridge>,
    trigger: Option<Arc<dyn ArmTrigger>>,
    cleanup: CleanupRegistry,
    waker: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    inner: Mutex<Inner>,
}

fn code_of<T: Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

fn event_frame(seq: u64, body: EventBody) -> Frame {
    Frame::Event(EventFrame { seq, body })
}

fn reject(action_id: &str, reason: RejectReason) -> ActionResult {
    ActionResult {
        action_id: action_id.to_string(),
        outcome: Outcome::Rejected,
        reason: Some(reason),
        state: None,
    }
}

fn accept(action_id: &str, state: Option<SessionState>) -> ActionResult {
    ActionResult {
        action_id: action_id.to_string(),
        outcome: Outcome::Accepted,
        reason: None,
        state,
    }
}

impl Session {
    /// Records a discrete event: advances the state machine, numbers it, keeps it for replay and
    /// queues it. Any pending progress snapshot goes out first. Illegal events are dropped.
    fn push(&mut self, connected: bool, body: EventBody, fx: &mut Vec<Effect>) -> bool {
        if self.machine.apply(&body).is_err() {
            return false;
        }
        if connected && self.progress_dirty {
            self.queue_progress(fx);
        }
        self.seq += 1;
        let frame = EventFrame {
            seq: self.seq,
            body,
        };
        self.ring.push(frame.clone());
        if connected {
            self.outbox.push_back(Frame::Event(frame));
            fx.push(Effect::Wake);
        }
        true
    }

    /// Queues the latest progress snapshot, numbered with the newest discrete sequence number.
    fn queue_progress(&mut self, fx: &mut Vec<Effect>) {
        if let Some(p) = self.machine.progress() {
            self.outbox
                .push_back(event_frame(self.seq, EventBody::Progress(p.clone())));
            fx.push(Effect::Wake);
        }
        self.progress_dirty = false;
    }

    fn close_prompt(&mut self, connected: bool, reason: CloseReason, fx: &mut Vec<Effect>) {
        let Some(id) = self.machine.prompt().map(|p| p.prompt_id.clone()) else {
            return;
        };
        let reason = match reason {
            CloseReason::AnsweredLocal if self.pending_remote.as_deref() == Some(id.as_str()) => {
                CloseReason::AnsweredRemote
            }
            other => other,
        };
        self.pending_remote = None;
        self.prompt_opened_at_ms = None;
        self.push(
            connected,
            EventBody::PromptClosed {
                prompt_id: id,
                reason,
            },
            fx,
        );
    }
}

impl RemoteControl {
    /// Builds the layer. Nothing is created, spawned or connected until [`arm`](Self::arm).
    pub fn new(config: Config, deps: Deps) -> Result<Arc<Self>> {
        config.validate()?;
        Ok(Arc::new(Self {
            config,
            clock: deps.clock,
            ids: deps.ids,
            audit: deps.audit,
            power: deps.power,
            bridge: deps.bridge,
            trigger: deps.trigger,
            cleanup: CleanupRegistry::default(),
            waker: Mutex::new(None),
            inner: Mutex::new(Inner {
                session: None,
                connected: false,
                locked: false,
                viewers: 0,
            }),
        }))
    }

    /// A handle for the host's job code. Cheap to clone; holds no strong reference.
    pub fn events(self: &Arc<Self>) -> AppEvents {
        AppEvents(Arc::downgrade(self))
    }

    pub fn config(&self) -> &Config {
        &self.config
    }

    /// The registry the host and the layer use for anything persistent.
    pub fn cleanup(&self) -> &CleanupRegistry {
        &self.cleanup
    }

    /// Called whenever there is something new to send. Set by the transport.
    pub fn set_waker(&self, waker: Arc<dyn Fn() + Send + Sync>) {
        if let Ok(mut w) = self.waker.lock() {
            *w = Some(waker);
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn locked<R>(&self, f: impl FnOnce(&mut Inner, u64, &mut Vec<Effect>) -> R) -> R {
        let now = self.clock.now_ms();
        let mut fx = Vec::new();
        let result = {
            let mut guard = self.lock();
            f(&mut guard, now, &mut fx)
        };
        self.dispatch(fx);
        result
    }

    fn dispatch(&self, effects: Vec<Effect>) {
        let mut wake = false;
        for effect in effects {
            match effect {
                Effect::Audit(entry) => self.audit.record(&entry),
                Effect::Apply(action) => {
                    let _ = self.bridge.apply(action);
                }
                Effect::PowerAcquire => self.power.acquire(),
                Effect::PowerRelease => self.power.release(),
                Effect::Cleanup => {
                    self.cleanup.run();
                }
                Effect::Sweep => {
                    CleanupRegistry::sweep_stale(
                        &self.config.data_dir,
                        TEMP_PREFIX,
                        Duration::from_millis(self.config.hard_cap_ms),
                        SystemTime::now(),
                    );
                }
                Effect::Wake => wake = true,
            }
        }
        if wake {
            let waker = self.waker.lock().ok().and_then(|w| w.clone());
            if let Some(w) = waker {
                w();
            }
        }
    }

    fn audit_fx(now: u64, kind: AuditKind, detail: Option<&str>, fx: &mut Vec<Effect>) {
        fx.push(Effect::Audit(AuditEntry::new(now, kind, detail)));
    }

    // ---- arming -------------------------------------------------------------------------

    /// Switches remote control on after a local gesture. Returns the session id.
    pub fn arm(&self, request: ArmRequest) -> Result<String> {
        if !self.config.enabled {
            return Err(Error::Disabled);
        }
        let cap = self.config.hard_cap_ms;
        let ttl_ms = request.ttl.resolve_ms(cap).unwrap_or(cap);
        let until_job_ends = request.ttl.resolve_ms(cap).is_none();
        let new_id = self.ids.hex32();
        Ok(self.locked(|inner, now, fx| {
            let expires = now.saturating_add(ttl_ms);
            if let Some(s) = inner.session.as_mut() {
                s.expires_at_ms = expires;
                s.until_job_ends = until_job_ends;
                return s.session_id.clone();
            }
            let session_id = new_id;
            inner.session = Some(Session {
                session_id: session_id.clone(),
                expires_at_ms: expires,
                until_job_ends,
                idle_since_ms: Some(now),
                seq: 0,
                ring: ReplayRing::new(self.config.ring_capacity),
                machine: Machine::new(),
                outbox: VecDeque::new(),
                progress_dirty: false,
                last_progress_sent_ms: 0,
                bucket: TokenBucket::new(self.config.action_rate_per_sec, now),
                dedup: Dedup::new(self.config.dedup_capacity),
                issued_prompts: VecDeque::new(),
                prompt_opened_at_ms: None,
                pending_remote: None,
                terminal_flushed: false,
            });
            if self.config.keep_awake_while_armed {
                fx.push(Effect::PowerAcquire);
            }
            fx.push(Effect::Sweep);
            Self::audit_fx(now, AuditKind::Armed, Some(request.ttl.code()), fx);
            fx.push(Effect::Wake);
            session_id
        }))
    }

    /// Arms with the configured default time.
    pub fn arm_default(&self) -> Result<String> {
        self.arm(ArmRequest {
            ttl: self.config.default_ttl,
        })
    }

    /// Switches remote control off. The running job, if any, carries on locally.
    pub fn disarm(&self, reason: DisarmReason) {
        self.locked(|inner, now, fx| self.disarm_locked(inner, reason, now, fx));
    }

    fn disarm_locked(
        &self,
        inner: &mut Inner,
        reason: DisarmReason,
        now: u64,
        fx: &mut Vec<Effect>,
    ) {
        if inner.session.take().is_none() {
            return;
        }
        inner.viewers = 0;
        if self.config.keep_awake_while_armed {
            fx.push(Effect::PowerRelease);
        }
        fx.push(Effect::Cleanup);
        Self::audit_fx(now, AuditKind::Disarmed, Some(reason.code()), fx);
        fx.push(Effect::Wake);
    }

    pub fn is_armed(&self) -> bool {
        self.lock().session.is_some()
    }

    pub fn session_id(&self) -> Option<String> {
        self.lock().session.as_ref().map(|s| s.session_id.clone())
    }

    /// What the host's indicator shows.
    pub fn view(&self) -> RemoteStatus {
        let inner = self.lock();
        RemoteStatus {
            armed: inner.session.is_some(),
            session_id: inner.session.as_ref().map(|s| s.session_id.clone()),
            expires_at_ms: inner.session.as_ref().map(|s| s.expires_at_ms),
            viewers: inner.viewers,
            connected: inner.connected,
            locked: inner.locked,
            state: inner
                .session
                .as_ref()
                .map_or(SessionState::Idle, |s| s.machine.state()),
        }
    }

    /// The snapshot a client would receive on resync.
    pub fn snapshot(&self) -> Option<Snapshot> {
        let inner = self.lock();
        inner
            .session
            .as_ref()
            .map(|s| s.machine.snapshot(s.ring.head_seq(), true))
    }

    // ---- transport hooks -----------------------------------------------------------------

    /// The transport reports its connection. A new connection starts from the relay's `resync`.
    pub fn set_connected(&self, connected: bool) {
        self.locked(|inner, now, fx| {
            if inner.connected == connected {
                return;
            }
            inner.connected = connected;
            if connected {
                if let Some(s) = inner.session.as_mut() {
                    s.outbox.clear();
                    s.last_progress_sent_ms = 0;
                }
            }
            let kind = if connected {
                AuditKind::ConnectionOpened
            } else {
                inner.viewers = 0;
                AuditKind::ConnectionClosed
            };
            if inner.session.is_some() {
                Self::audit_fx(now, kind, None, fx);
            }
        });
    }

    /// The relay revoked (or restored) this install.
    pub fn set_locked(&self, locked: bool) {
        self.locked(|inner, now, fx| {
            if inner.locked != locked {
                inner.locked = locked;
                let kind = if locked {
                    AuditKind::Locked
                } else {
                    AuditKind::Unlocked
                };
                Self::audit_fx(now, kind, None, fx);
            }
        });
    }

    /// Frames to send now, oldest first. Progress is coalesced to one snapshot per interval and
    /// always precedes the discrete event that follows it.
    pub fn poll_outbound(&self) -> Vec<Frame> {
        self.locked(|inner, now, fx| {
            let connected = inner.connected;
            let Some(s) = inner.session.as_mut() else {
                return Vec::new();
            };
            if connected
                && s.progress_dirty
                && now.saturating_sub(s.last_progress_sent_ms) >= self.config.progress_interval_ms
            {
                s.queue_progress(fx);
                s.last_progress_sent_ms = now;
            }
            let frames: Vec<Frame> = s.outbox.drain(..).collect();
            let has_terminal = frames.iter().any(|f| {
                matches!(
                    f,
                    Frame::Event(EventFrame {
                        body: EventBody::Status(_),
                        ..
                    })
                )
            });
            if has_terminal {
                s.terminal_flushed = true;
            }
            frames
        })
    }

    /// Handles one frame received from the relay and returns the frames to send back.
    pub fn handle_frame(&self, frame: Frame) -> Vec<Frame> {
        match frame {
            Frame::Action(action) => vec![Frame::ActionResult(self.handle_action(action))],
            Frame::Resync(r) => self.handle_resync(r.last_seq),
            Frame::Ping(_) => vec![Frame::Pong(Empty {})],
            Frame::Event(EventFrame {
                body: EventBody::ArmedState(a),
                ..
            }) => {
                if let Some(v) = a.viewers {
                    self.locked(|inner, _, _| inner.viewers = v);
                }
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn handle_resync(&self, last_seq: u64) -> Vec<Frame> {
        self.locked(|inner, _, _| {
            let Some(s) = inner.session.as_mut() else {
                return Vec::new();
            };
            let plan = s.ring.plan(last_seq);
            let mut out = vec![
                Frame::ResyncResult(ResyncResult {
                    from_seq: plan.from_seq,
                    to_seq: plan.to_seq,
                    gap: plan.gap,
                }),
                Frame::Snapshot(s.machine.snapshot(s.ring.head_seq(), true)),
            ];
            out.extend(plan.events.into_iter().map(Frame::Event));
            s.outbox.clear();
            s.progress_dirty = false;
            out
        })
    }

    // ---- actions -------------------------------------------------------------------------

    /// Validates and runs one remote action. Both sides check; the agent never trusts the relay.
    pub fn handle_action(&self, action: Action) -> ActionResult {
        let id = action.action_id.clone();
        if Frame::Action(action.clone()).validate().is_err() {
            return reject(&id, RejectReason::Malformed);
        }
        enum Plan {
            Done(ActionResult),
            Run(Option<AppAction>, SessionState, String),
        }
        let plan = self.locked(|inner, now, fx| {
            let locked = inner.locked;
            // Disarmed: answer, but record nothing. A disarmed agent creates no files.
            let Some(s) = inner.session.as_mut() else {
                return Plan::Done(reject(&id, RejectReason::Disarmed));
            };
            if let Some(prev) = s.dedup.get(&id) {
                return Plan::Done(prev.clone());
            }
            let transient = if locked {
                Some(RejectReason::Locked)
            } else if now >= s.expires_at_ms {
                Some(RejectReason::Expired)
            } else if !s.bucket.try_take(now) {
                Some(RejectReason::RateLimited)
            } else {
                None
            };
            if let Some(reason) = transient {
                Self::audit_fx(
                    now,
                    AuditKind::ActionRejected,
                    Some(&format!("{} {}", code_of(&action.action), code_of(&reason))),
                    fx,
                );
                return Plan::Done(reject(&id, reason));
            }
            let issued = s.issued_prompts.clone();
            let verdict = decide(&action, s.machine.state(), s.machine.prompt(), |p| {
                issued.iter().any(|i| i == p)
            });
            match verdict {
                Err(reason) => {
                    let r = reject(&id, reason);
                    s.dedup.insert(r.clone());
                    Self::audit_fx(
                        now,
                        AuditKind::ActionRejected,
                        Some(&format!("{} {}", code_of(&action.action), code_of(&reason))),
                        fx,
                    );
                    Plan::Done(r)
                }
                Ok(()) => {
                    let app = match action.action {
                        ActionKind::Status => None,
                        ActionKind::Next => Some(AppAction::Next),
                        ActionKind::Done => Some(AppAction::Done),
                        ActionKind::Cancel => Some(AppAction::Cancel),
                    };
                    Plan::Run(app, s.machine.state(), s.session_id.clone())
                }
            }
        });
        let (app, state, session_id) = match plan {
            Plan::Done(result) => return result,
            Plan::Run(app, state, session_id) => (app, state, session_id),
        };
        let applied = app.map(|a| self.bridge.apply(a));
        let kind = code_of(&action.action);
        self.locked(|inner, now, fx| {
            let result = match applied {
                Some(ApplyOutcome::NotApplicable) => reject(&id, RejectReason::InvalidState),
                Some(ApplyOutcome::Applied) => accept(&id, None),
                None => accept(&id, Some(state)),
            };
            if let Some(s) = inner
                .session
                .as_mut()
                .filter(|s| s.session_id == session_id)
            {
                if result.outcome == Outcome::Accepted
                    && matches!(action.action, ActionKind::Done | ActionKind::Next)
                {
                    s.pending_remote = action.prompt_id.clone();
                }
                s.dedup.insert(result.clone());
            }
            let (audit_kind, detail) = if result.outcome == Outcome::Accepted {
                (AuditKind::ActionAccepted, kind)
            } else {
                (
                    AuditKind::ActionRejected,
                    format!(
                        "{kind} {}",
                        result.reason.map(|r| code_of(&r)).unwrap_or_default()
                    ),
                )
            };
            Self::audit_fx(now, audit_kind, Some(&detail), fx);
            result
        })
    }

    // ---- host to layer: events -------------------------------------------------------------

    /// The app started a long-running job. A job still running is ended as cancelled first.
    pub fn job_started(&self, kind: JobKind) {
        let job_id = self.ids.hex32();
        self.locked(|inner, now, fx| {
            let connected = inner.connected;
            let Some(s) = inner.session.as_mut() else {
                return;
            };
            if s.machine.is_job_active() {
                s.close_prompt(connected, CloseReason::JobEnded, fx);
                s.push(
                    connected,
                    EventBody::Status(TerminalInfo {
                        status: TerminalStatus::Cancelled,
                        failure_code: Some(FailureCode::Cancelled),
                        summary: None,
                    }),
                    fx,
                );
            }
            if s.push(
                connected,
                EventBody::JobStarted {
                    job_id,
                    job_kind: kind,
                },
                fx,
            ) {
                s.idle_since_ms = None;
                s.terminal_flushed = false;
                s.pending_remote = None;
                s.issued_prompts.clear();
                Self::audit_fx(now, AuditKind::JobStarted, Some(&code_of(&kind)), fx);
            }
        });
    }

    /// The job moved to another step.
    pub fn step(&self, step: Step) {
        self.locked(|inner, _, fx| {
            let connected = inner.connected;
            if let Some(s) = inner.session.as_mut() {
                s.push(connected, EventBody::Step { step }, fx);
            }
        });
    }

    /// New counters. Safe to call ten times a second: only the latest is kept and sent.
    pub fn progress(&self, progress: ProgressFields) {
        self.locked(|inner, now, fx| {
            let connected = inner.connected;
            let Some(s) = inner.session.as_mut() else {
                return;
            };
            if s.machine.apply(&EventBody::Progress(progress)).is_err() {
                return;
            }
            s.progress_dirty = true;
            if connected
                && now.saturating_sub(s.last_progress_sent_ms) >= self.config.progress_interval_ms
            {
                s.queue_progress(fx);
                s.last_progress_sent_ms = now;
            }
        });
    }

    /// The app is offering a control. An earlier open prompt is closed as superseded.
    pub fn prompt_opened(&self, spec: PromptSpec) {
        let prompt_id = self.ids.prompt_id();
        self.locked(|inner, now, fx| {
            let connected = inner.connected;
            let Some(s) = inner.session.as_mut() else {
                return;
            };
            if !s.machine.is_job_active() {
                return;
            }
            s.close_prompt(connected, CloseReason::Superseded, fx);
            let body = EventBody::PromptOpened(PromptObject {
                prompt_id: prompt_id.clone(),
                expects: spec.expects,
                label_id: spec.label_id,
                blocking: spec.blocking,
                text: spec.text.as_deref().and_then(sanitize_text),
            });
            if s.push(connected, body, fx) {
                s.issued_prompts.push_back(prompt_id);
                while s.issued_prompts.len() > ISSUED_PROMPTS_KEPT {
                    s.issued_prompts.pop_front();
                }
                s.prompt_opened_at_ms = Some(now);
            }
        });
    }

    /// The offered control is gone. Report what the app saw: a local press as `AnsweredLocal`,
    /// the app finishing by itself as `Auto`. A press that follows an accepted remote action is
    /// attributed to the remote action.
    pub fn prompt_closed(&self, reason: CloseReason) {
        self.locked(|inner, _, fx| {
            let connected = inner.connected;
            if let Some(s) = inner.session.as_mut() {
                s.close_prompt(connected, reason, fx);
            }
        });
    }

    /// The job ended.
    pub fn status(&self, report: StatusReport) {
        self.locked(|inner, now, fx| {
            let connected = inner.connected;
            let Some(s) = inner.session.as_mut() else {
                return;
            };
            if !s.machine.is_job_active() {
                return;
            }
            s.close_prompt(connected, CloseReason::JobEnded, fx);
            let failure_code = match (report.status, report.failure_code) {
                (TerminalStatus::Cancelled, None) => Some(FailureCode::Cancelled),
                (_, code) => code,
            };
            let code = code_of(&report.status);
            let body = EventBody::Status(TerminalInfo {
                status: report.status,
                failure_code,
                summary: report.summary,
            });
            if s.push(connected, body, fx) {
                s.idle_since_ms = Some(now);
                s.pending_remote = None;
                Self::audit_fx(now, AuditKind::JobEnded, Some(&code), fx);
            }
        });
    }

    // ---- time ------------------------------------------------------------------------------

    /// Time-driven work: polls the arm trigger, expires the session, disarms when idle or when
    /// the job has ended, and applies the prompt timeout policy. Call about once a second.
    pub fn tick(&self) {
        if let Some(trigger) = &self.trigger {
            if let Some(request) = trigger.take_request() {
                let _ = self.arm(request);
            }
        }
        self.locked(|inner, now, fx| {
            let connected = inner.connected;
            let Some(s) = inner.session.as_mut() else {
                return;
            };
            let reason = if now >= s.expires_at_ms {
                Some(DisarmReason::TtlExpired)
            } else if s.terminal_flushed && (s.until_job_ends || !self.config.stay_armed_after_job)
            {
                Some(DisarmReason::JobEnded)
            } else if !s.machine.is_job_active()
                && s.idle_since_ms
                    .is_some_and(|since| now.saturating_sub(since) >= self.config.idle_timeout_ms)
            {
                Some(DisarmReason::Idle)
            } else {
                None
            };
            if let Some(reason) = reason {
                self.disarm_locked(inner, reason, now, fx);
                return;
            }
            if let PromptTimeout::AutoCancel { after_ms } = self.config.prompt_timeout {
                let expired = s
                    .prompt_opened_at_ms
                    .is_some_and(|at| now.saturating_sub(at) >= after_ms);
                if expired && s.machine.prompt().is_some() {
                    s.close_prompt(connected, CloseReason::TimedOut, fx);
                    fx.push(Effect::Apply(AppAction::Cancel));
                }
            }
        });
    }
}

impl Drop for RemoteControl {
    fn drop(&mut self) {
        let now = self.clock.now_ms();
        let mut fx = Vec::new();
        {
            let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            self.disarm_locked(&mut guard, DisarmReason::Dropped, now, &mut fx);
        }
        fx.retain(|e| !matches!(e, Effect::Apply(_) | Effect::Wake));
        self.dispatch(fx);
    }
}

/// The host's handle for reporting a job. Cheap to clone and `Send + Sync`. Every method returns
/// immediately, never fails, and does nothing while disarmed or after the layer is gone.
#[derive(Clone)]
pub struct AppEvents(Weak<RemoteControl>);

impl AppEvents {
    fn with(&self, f: impl FnOnce(&RemoteControl)) {
        if let Some(rc) = self.0.upgrade() {
            f(&rc);
        }
    }

    pub fn job_started(&self, kind: JobKind) {
        self.with(|rc| rc.job_started(kind));
    }

    pub fn step(&self, step: Step) {
        self.with(|rc| rc.step(step));
    }

    pub fn progress(&self, progress: ProgressFields) {
        self.with(|rc| rc.progress(progress));
    }

    pub fn prompt_opened(&self, spec: PromptSpec) {
        self.with(|rc| rc.prompt_opened(spec));
    }

    pub fn prompt_closed(&self, reason: CloseReason) {
        self.with(|rc| rc.prompt_closed(reason));
    }

    pub fn status(&self, report: StatusReport) {
        self.with(|rc| rc.status(report));
    }
}
