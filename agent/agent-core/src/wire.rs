//! Wire types for protocol version 1, shared with the relay and the dashboard.
//!
//! Structs serialise in camelCase and every `type`, event kind and reason code is kebab-case.
//! Inbound frames are decoded leniently for events (unknown kinds and enum values are ignored
//! or mapped to `other`) and strictly for everything else. The JSON Schemas and golden fixtures
//! in `protocol/` are the source of truth and are exercised by `tests/contract.rs`.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize};
use std::fmt;

/// The protocol version this crate speaks.
pub const PROTOCOL_VERSION: u32 = 1;
/// Largest accepted or produced frame, in bytes.
pub const MAX_FRAME_BYTES: usize = 16 * 1024;
/// Longest optional prompt text, in characters.
pub const MAX_TEXT_CHARS: usize = 80;
/// Largest integer that survives a round trip through JavaScript numbers.
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
/// Byte-constant keepalive frame, answered by the relay without waking its Durable Object.
pub const PING_FRAME: &str = r#"{"v":1,"type":"ping"}"#;
/// Byte-constant reply to [`PING_FRAME`].
pub const PONG_FRAME: &str = r#"{"v":1,"type":"pong"}"#;

/// Why a frame could not be decoded or produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WireError {
    /// The frame is larger than [`MAX_FRAME_BYTES`].
    FrameTooLarge,
    /// The frame names a protocol version this crate does not speak.
    UnsupportedVersion(u64),
    /// The frame is not valid for the protocol. The text names a field, never a value.
    Malformed(String),
}

impl fmt::Display for WireError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WireError::FrameTooLarge => write!(f, "frame exceeds {MAX_FRAME_BYTES} bytes"),
            WireError::UnsupportedVersion(v) => write!(f, "unsupported protocol version {v}"),
            WireError::Malformed(what) => write!(f, "malformed frame: {what}"),
        }
    }
}

impl std::error::Error for WireError {}

/// Result alias for wire operations.
pub type Result<T> = std::result::Result<T, WireError>;

fn bad<T>(what: &str) -> Result<T> {
    Err(WireError::Malformed(what.to_string()))
}

/// Which end of the relay a socket belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Role {
    Agent,
    Browser,
}

/// The kind of long-running task.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum JobKind {
    RecordCopy,
    RecordWatch,
    Compare,
    DiskScan,
    Simulated,
    #[serde(other)]
    Other,
}

/// A step or phase of a job. `Done` closes a step, never the job.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Step {
    ListingSource,
    Copying,
    Watching,
    Finishing,
    Done,
    #[serde(other)]
    Other,
}

/// The label of a prompt's button, as an id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LabelId {
    FinishAndCheck,
    Continue,
    Confirm,
    #[serde(other)]
    Other,
}

/// What the open prompt waits for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Expects {
    Next,
    Done,
    /// A value this version does not know. Never produced locally.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// Why a prompt closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CloseReason {
    AnsweredRemote,
    AnsweredLocal,
    Auto,
    Superseded,
    TimedOut,
    JobEnded,
    /// A value this version does not know. Never produced locally.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// How a job ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TerminalStatus {
    Completed,
    Cancelled,
    Failed,
    /// A value this version does not know. Never produced locally.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// A coarse failure code. Error text never travels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FailureCode {
    Cancelled,
    DestinationNotWritable,
    NotEnoughSpace,
    SourceUnavailable,
    Internal,
    #[serde(other)]
    Other,
}

/// The four remote actions. Nothing else is reachable remotely.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ActionKind {
    Status,
    Next,
    Done,
    Cancel,
}

/// Why an action was rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RejectReason {
    Disarmed,
    Expired,
    UnknownAction,
    InvalidState,
    StalePrompt,
    Malformed,
    RateLimited,
    Locked,
}

/// The coarse state of a session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionState {
    Idle,
    Running,
    AwaitingUser,
    Completed,
    Cancelled,
    Failed,
}

/// Why the peer is telling you something went wrong.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCode {
    Malformed,
    UnsupportedVersion,
    Unauthorized,
    NotPaired,
    Locked,
    Expired,
    TooManyConnections,
    RateLimited,
    FrameTooLarge,
    Internal,
}

/// Deserialises an `Option` that must be present, with `null` meaning "not known yet".
fn required_option<'de, D, T>(d: D) -> std::result::Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d)
}

/// Counters and totals for the running job. Totals are `None` until the source is listed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressFields {
    pub step: Step,
    /// Whole percent, or `None` while the total is not known.
    #[serde(deserialize_with = "required_option")]
    pub percent: Option<u8>,
    pub files_done: u64,
    #[serde(deserialize_with = "required_option")]
    pub files_total: Option<u64>,
    pub bytes_done: u64,
    #[serde(deserialize_with = "required_option")]
    pub bytes_total: Option<u64>,
    pub ok: u64,
    pub skipped: u64,
    pub failed: u64,
}

/// Counts only: the report of how a job ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub files_planned: u64,
    pub bytes_planned: u64,
    pub ok: u64,
    pub ok_bytes: u64,
    pub skipped: u64,
    pub failed: u64,
    pub failed_bytes: u64,
    pub duration_ms: u64,
}

/// A control the app is currently offering.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptObject {
    pub prompt_id: String,
    pub expects: Expects,
    pub label_id: LabelId,
    pub blocking: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

/// The final outcome of a job.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub status: TerminalStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_code: Option<FailureCode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<Summary>,
}

/// The first frame on every socket.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Hello {
    pub role: Role,
    pub protocol_versions: Vec<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_version: Option<String>,
}

/// The relay's challenge to an agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthChallenge {
    pub nonce: String,
}

/// The agent's signed answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthResponse {
    pub agent_nonce: String,
    pub signature: String,
}

/// Authentication succeeded. The frame's `v` is the negotiated version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthOk {
    pub server_time_ms: u64,
}

/// The armed state, with the viewer count filled in by the relay.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArmedState {
    pub armed: bool,
    #[serde(deserialize_with = "required_option")]
    pub expires_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewers: Option<u64>,
}

/// The payload of an event, selected by `kind`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum EventBody {
    #[serde(rename_all = "camelCase")]
    JobStarted {
        job_id: String,
        job_kind: JobKind,
    },
    Step {
        step: Step,
    },
    Progress(ProgressFields),
    PromptOpened(PromptObject),
    #[serde(rename_all = "camelCase")]
    PromptClosed {
        prompt_id: String,
        reason: CloseReason,
    },
    Status(TerminalInfo),
    ArmedState(ArmedState),
    /// An event kind (or enum value) this version does not know. Keeps its `seq`.
    #[serde(other)]
    Unknown,
}

impl EventBody {
    /// Turns an event carrying a value this version does not know into [`EventBody::Unknown`].
    fn normalised(self) -> EventBody {
        let unknown = match &self {
            EventBody::PromptOpened(p) => p.expects == Expects::Unknown,
            EventBody::PromptClosed { reason, .. } => *reason == CloseReason::Unknown,
            EventBody::Status(t) => t.status == TerminalStatus::Unknown,
            _ => false,
        };
        if unknown {
            EventBody::Unknown
        } else {
            self
        }
    }
}

/// One numbered event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventFrame {
    pub seq: u64,
    #[serde(flatten)]
    pub body: EventBody,
}

/// A remote action. Unknown fields are rejected.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Action {
    pub action_id: String,
    pub action: ActionKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_id: Option<String>,
}

/// The answer to an action.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionResult {
    pub action_id: String,
    pub outcome: Outcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<RejectReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<SessionState>,
}

/// Whether an action was taken up.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Outcome {
    Accepted,
    Rejected,
}

/// A request to replay events after `last_seq`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Resync {
    pub last_seq: u64,
}

/// The header that precedes a replay.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResyncResult {
    pub from_seq: u64,
    pub to_seq: u64,
    pub gap: bool,
}

/// Everything a client needs to rebuild its view.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub seq: u64,
    pub armed: bool,
    pub state: SessionState,
    #[serde(deserialize_with = "required_option")]
    pub job_id: Option<String>,
    #[serde(deserialize_with = "required_option")]
    pub job_kind: Option<JobKind>,
    #[serde(deserialize_with = "required_option")]
    pub progress: Option<ProgressFields>,
    #[serde(deserialize_with = "required_option")]
    pub prompt: Option<PromptObject>,
    #[serde(deserialize_with = "required_option")]
    pub terminal: Option<TerminalInfo>,
}

/// A frame with no fields besides its type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Empty {}

/// A fault report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ErrorFrame {
    pub code: ErrorCode,
    pub fatal: bool,
}

/// Any frame, selected by `type`. The version lives outside, see [`encode`] and [`decode`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Frame {
    Hello(Hello),
    AuthChallenge(AuthChallenge),
    AuthResponse(AuthResponse),
    AuthOk(AuthOk),
    Event(EventFrame),
    Action(Action),
    ActionResult(ActionResult),
    Resync(Resync),
    ResyncResult(ResyncResult),
    Snapshot(Snapshot),
    Ping(Empty),
    Pong(Empty),
    Error(ErrorFrame),
}

#[derive(Serialize)]
struct Versioned<'a> {
    v: u32,
    #[serde(flatten)]
    frame: &'a Frame,
}

fn is_hex32(s: &str) -> bool {
    s.len() == 32
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn all_of(s: &str, min: usize, max: usize, ok: impl Fn(u8) -> bool) -> bool {
    (min..=max).contains(&s.len()) && s.bytes().all(ok)
}

fn is_prompt_id(s: &str) -> bool {
    all_of(s, 1, 32, |b| b.is_ascii_alphanumeric() || b == b'-')
}

fn is_action_id(s: &str) -> bool {
    all_of(s, 8, 64, |b| b.is_ascii_alphanumeric() || b == b'-')
}

fn is_b64url(s: &str, len: usize) -> bool {
    all_of(s, len, len, |b| {
        b.is_ascii_alphanumeric() || b == b'-' || b == b'_'
    })
}

fn counter(v: u64, what: &str) -> Result<()> {
    if v > MAX_SAFE_INTEGER {
        bad(what)
    } else {
        Ok(())
    }
}

fn opt_counter(v: Option<u64>, what: &str) -> Result<()> {
    v.map_or(Ok(()), |v| counter(v, what))
}

/// True when `text` is acceptable free text: short, no control characters, no path separators.
pub fn is_clean_text(text: &str) -> bool {
    text.chars().count() <= MAX_TEXT_CHARS
        && !text
            .chars()
            .any(|c| c.is_control() || c == '/' || c == '\\')
}

/// Keeps at most 80 characters, strips control characters and drops text that looks like a path.
pub fn sanitize_text(input: &str) -> Option<String> {
    let stripped: String = input.chars().filter(|c| !c.is_control()).collect();
    let trimmed: String = stripped.chars().take(MAX_TEXT_CHARS).collect();
    let mut chars = trimmed.chars();
    let drive_like = matches!(
        (chars.next(), chars.next()),
        (Some(a), Some(':')) if a.is_ascii_alphabetic()
    );
    if trimmed.is_empty() || !is_clean_text(&trimmed) || drive_like {
        None
    } else {
        Some(trimmed)
    }
}

fn validate_progress(p: &ProgressFields) -> Result<()> {
    if p.percent.is_some_and(|v| v > 100) {
        return bad("percent");
    }
    counter(p.files_done, "filesDone")?;
    opt_counter(p.files_total, "filesTotal")?;
    counter(p.bytes_done, "bytesDone")?;
    opt_counter(p.bytes_total, "bytesTotal")?;
    counter(p.ok, "ok")?;
    counter(p.skipped, "skipped")?;
    counter(p.failed, "failed")
}

fn validate_summary(s: &Summary) -> Result<()> {
    counter(s.files_planned, "filesPlanned")?;
    counter(s.bytes_planned, "bytesPlanned")?;
    counter(s.ok, "summary.ok")?;
    counter(s.ok_bytes, "okBytes")?;
    counter(s.skipped, "summary.skipped")?;
    counter(s.failed, "summary.failed")?;
    counter(s.failed_bytes, "failedBytes")?;
    counter(s.duration_ms, "durationMs")
}

fn validate_prompt(p: &PromptObject) -> Result<()> {
    if !is_prompt_id(&p.prompt_id) {
        return bad("promptId");
    }
    if p.text.as_deref().is_some_and(|t| !is_clean_text(t)) {
        return bad("text");
    }
    Ok(())
}

fn validate_terminal(t: &TerminalInfo) -> Result<()> {
    t.summary.as_ref().map_or(Ok(()), validate_summary)
}

impl Frame {
    /// Checks everything the serde types cannot: id formats, ranges, and field combinations.
    pub fn validate(&self) -> Result<()> {
        match self {
            Frame::Hello(h) => {
                let n = h.protocol_versions.len();
                if !(1..=8).contains(&n)
                    || h.protocol_versions.iter().any(|v| !(1..=65535).contains(v))
                {
                    return bad("protocolVersions");
                }
                match h.role {
                    Role::Agent => {
                        if !h.install_id.as_deref().is_some_and(is_hex32) {
                            return bad("installId");
                        }
                        if !h.session_id.as_deref().is_some_and(is_hex32) {
                            return bad("sessionId");
                        }
                        let app_ok = h.app_id.as_deref().is_some_and(|a| {
                            all_of(a, 1, 32, |b| {
                                b.is_ascii_digit() || b.is_ascii_lowercase() || b == b'-'
                            })
                        });
                        if !app_ok {
                            return bad("appId");
                        }
                        let ver_ok = h.agent_version.as_deref().is_some_and(|a| {
                            all_of(a, 1, 32, |b| {
                                b.is_ascii_alphanumeric() || matches!(b, b'.' | b'+' | b'-')
                            })
                        });
                        if !ver_ok {
                            return bad("agentVersion");
                        }
                    }
                    Role::Browser => {
                        if h.install_id.is_some()
                            || h.session_id.is_some()
                            || h.app_id.is_some()
                            || h.agent_version.is_some()
                        {
                            return bad("agent fields on a browser hello");
                        }
                    }
                }
                Ok(())
            }
            Frame::AuthChallenge(c) => {
                if is_b64url(&c.nonce, 43) {
                    Ok(())
                } else {
                    bad("nonce")
                }
            }
            Frame::AuthResponse(r) => {
                if !is_b64url(&r.agent_nonce, 43) {
                    return bad("agentNonce");
                }
                if !is_b64url(&r.signature, 86) {
                    return bad("signature");
                }
                Ok(())
            }
            Frame::AuthOk(a) => counter(a.server_time_ms, "serverTimeMs"),
            Frame::Event(e) => {
                counter(e.seq, "seq")?;
                match &e.body {
                    EventBody::JobStarted { job_id, .. } if !is_hex32(job_id) => bad("jobId"),
                    EventBody::Progress(p) => validate_progress(p),
                    EventBody::PromptOpened(p) => validate_prompt(p),
                    EventBody::PromptClosed { prompt_id, .. } if !is_prompt_id(prompt_id) => {
                        bad("promptId")
                    }
                    EventBody::Status(t) => validate_terminal(t),
                    EventBody::ArmedState(a) => {
                        opt_counter(a.expires_at_ms, "expiresAtMs")?;
                        opt_counter(a.viewers, "viewers")
                    }
                    _ => Ok(()),
                }
            }
            Frame::Action(a) => {
                if !is_action_id(&a.action_id) {
                    return bad("actionId");
                }
                if a.prompt_id.as_deref().is_some_and(|p| !is_prompt_id(p)) {
                    return bad("promptId");
                }
                if matches!(a.action, ActionKind::Next | ActionKind::Done) && a.prompt_id.is_none()
                {
                    return bad("promptId required for next and done");
                }
                Ok(())
            }
            Frame::ActionResult(r) => {
                if !is_action_id(&r.action_id) {
                    return bad("actionId");
                }
                match (r.outcome, r.reason) {
                    (Outcome::Rejected, None) => bad("reason required when rejected"),
                    (Outcome::Accepted, Some(_)) => bad("reason not allowed when accepted"),
                    _ => Ok(()),
                }
            }
            Frame::Resync(r) => counter(r.last_seq, "lastSeq"),
            Frame::ResyncResult(r) => {
                counter(r.from_seq, "fromSeq")?;
                counter(r.to_seq, "toSeq")
            }
            Frame::Snapshot(s) => {
                counter(s.seq, "seq")?;
                if s.job_id.as_deref().is_some_and(|j| !is_hex32(j)) {
                    return bad("jobId");
                }
                if let Some(p) = &s.progress {
                    validate_progress(p)?;
                }
                if let Some(p) = &s.prompt {
                    validate_prompt(p)?;
                    if p.expects == Expects::Unknown {
                        return bad("expects");
                    }
                }
                if let Some(t) = &s.terminal {
                    validate_terminal(t)?;
                    if t.status == TerminalStatus::Unknown {
                        return bad("status");
                    }
                }
                Ok(())
            }
            Frame::Ping(_) | Frame::Pong(_) | Frame::Error(_) => Ok(()),
        }
    }

    /// The `type` string of this frame.
    pub fn type_name(&self) -> &'static str {
        match self {
            Frame::Hello(_) => "hello",
            Frame::AuthChallenge(_) => "auth-challenge",
            Frame::AuthResponse(_) => "auth-response",
            Frame::AuthOk(_) => "auth-ok",
            Frame::Event(_) => "event",
            Frame::Action(_) => "action",
            Frame::ActionResult(_) => "action-result",
            Frame::Resync(_) => "resync",
            Frame::ResyncResult(_) => "resync-result",
            Frame::Snapshot(_) => "snapshot",
            Frame::Ping(_) => "ping",
            Frame::Pong(_) => "pong",
            Frame::Error(_) => "error",
        }
    }
}

/// Decodes and validates one frame. Events carrying unknown kinds or values become
/// [`EventBody::Unknown`] and keep their `seq`.
pub fn decode(raw: &str) -> Result<Frame> {
    if raw.len() > MAX_FRAME_BYTES {
        return Err(WireError::FrameTooLarge);
    }
    let mut value: serde_json::Value =
        serde_json::from_str(raw).map_err(|_| WireError::Malformed("not JSON".into()))?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| WireError::Malformed("not an object".into()))?;
    let version = match object.remove("v") {
        Some(serde_json::Value::Number(n)) => {
            n.as_u64().ok_or_else(|| WireError::Malformed("v".into()))?
        }
        _ => return bad("v"),
    };
    if version != u64::from(PROTOCOL_VERSION) {
        return Err(WireError::UnsupportedVersion(version));
    }
    let mut frame = from_value::<Frame>(value)?;
    if let Frame::Event(e) = &mut frame {
        e.body = std::mem::replace(&mut e.body, EventBody::Unknown).normalised();
    }
    frame.validate()?;
    Ok(frame)
}

fn from_value<T: DeserializeOwned>(value: serde_json::Value) -> Result<T> {
    // Only the error's category is kept: serde's messages can echo field values.
    serde_json::from_value(value).map_err(|e| WireError::Malformed(format!("{:?}", e.classify())))
}

/// Validates and serialises one frame with `"v":1` first.
pub fn encode(frame: &Frame) -> Result<String> {
    frame.validate()?;
    let text = serde_json::to_string(&Versioned {
        v: PROTOCOL_VERSION,
        frame,
    })
    .map_err(|_| WireError::Malformed("serialise".into()))?;
    if text.len() > MAX_FRAME_BYTES {
        return Err(WireError::FrameTooLarge);
    }
    Ok(text)
}

/// For a frame that failed [`decode`]: if it was an `action` with a usable id, the rejection to
/// send back. An action kind outside the allowlist is `unknown-action`; anything else wrong with
/// it is `malformed`. Returns `None` when there is no id to answer.
pub fn reject_undecodable_action(raw: &str) -> Option<ActionResult> {
    if raw.len() > MAX_FRAME_BYTES {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    if value.get("type")?.as_str()? != "action" {
        return None;
    }
    let id = value.get("actionId")?.as_str()?;
    if !is_action_id(id) {
        return None;
    }
    let unknown_kind = value
        .get("action")
        .and_then(|a| a.as_str())
        .is_some_and(|a| !matches!(a, "status" | "next" | "done" | "cancel"));
    let reason = if unknown_kind {
        RejectReason::UnknownAction
    } else {
        RejectReason::Malformed
    };
    Some(ActionResult {
        action_id: id.to_string(),
        outcome: Outcome::Rejected,
        reason: Some(reason),
        state: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_action_outside_the_allowlist_is_answered_as_unknown_action() {
        let raw = r#"{"v":1,"type":"action","actionId":"act-del-0001","action":"delete"}"#;
        assert!(decode(raw).is_err());
        let r = reject_undecodable_action(raw).unwrap();
        assert_eq!(
            (r.outcome, r.reason),
            (Outcome::Rejected, Some(RejectReason::UnknownAction))
        );
        assert_eq!(r.action_id, "act-del-0001");
    }

    #[test]
    fn an_allowlisted_action_with_an_extra_field_is_answered_as_malformed() {
        let raw =
            r#"{"v":1,"type":"action","actionId":"act-can-0001","action":"cancel","path":"x"}"#;
        let r = reject_undecodable_action(raw).unwrap();
        assert_eq!(r.reason, Some(RejectReason::Malformed));
    }

    #[test]
    fn an_undecodable_frame_without_a_usable_action_id_gets_no_answer() {
        assert_eq!(reject_undecodable_action(r#"{"v":1,"type":"ping"}"#), None);
        assert_eq!(
            reject_undecodable_action(r#"{"v":1,"type":"action","actionId":"a1","action":"x"}"#),
            None
        );
        assert_eq!(reject_undecodable_action("nope"), None);
    }

    #[test]
    fn a_ping_frame_encodes_to_the_byte_constant() {
        assert_eq!(encode(&Frame::Ping(Empty {})).unwrap(), PING_FRAME);
        assert_eq!(encode(&Frame::Pong(Empty {})).unwrap(), PONG_FRAME);
    }

    #[test]
    fn the_byte_constant_frames_decode_to_ping_and_pong() {
        assert_eq!(decode(PING_FRAME).unwrap(), Frame::Ping(Empty {}));
        assert_eq!(decode(PONG_FRAME).unwrap(), Frame::Pong(Empty {}));
    }

    #[test]
    fn a_frame_over_the_cap_is_rejected_before_parsing() {
        let big = format!(
            r#"{{"v":1,"type":"ping","pad":"{}"}}"#,
            "x".repeat(MAX_FRAME_BYTES)
        );
        assert_eq!(decode(&big), Err(WireError::FrameTooLarge));
    }

    #[test]
    fn an_unsupported_version_is_reported_as_such() {
        assert_eq!(
            decode(r#"{"v":2,"type":"ping"}"#),
            Err(WireError::UnsupportedVersion(2))
        );
    }

    #[test]
    fn text_that_is_not_json_is_malformed() {
        assert!(matches!(decode("nope"), Err(WireError::Malformed(_))));
        assert!(matches!(decode("[1]"), Err(WireError::Malformed(_))));
    }

    #[test]
    fn sanitising_strips_controls_truncates_and_drops_paths() {
        assert_eq!(
            sanitize_text("Review first").as_deref(),
            Some("Review first")
        );
        assert_eq!(sanitize_text("a\nb\u{7}c").as_deref(), Some("abc"));
        assert_eq!(sanitize_text("C:\\Users\\bob"), None);
        assert_eq!(sanitize_text("/etc/passwd"), None);
        assert_eq!(sanitize_text(&"x".repeat(200)).unwrap().chars().count(), 80);
    }

    #[test]
    fn an_error_message_never_echoes_a_field_value() {
        let err =
            decode(r#"{"v":1,"type":"action","actionId":"secret-value-123","action":"delete"}"#)
                .unwrap_err();
        assert!(!err.to_string().contains("secret-value-123"));
        assert!(!err.to_string().contains("delete"));
    }
}
