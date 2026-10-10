//! The only surface a host app implements.
//!
//! Host to layer: call the emit methods on [`AppEvents`](crate::AppEvents) from the code that runs
//! the job. They are cheap, never block, never fail, and do nothing while disarmed.
//!
//! Layer to host: implement [`AppBridge::apply`] so a remote `done`, `next` or `cancel` runs the
//! same function as the matching local button.

use crate::wire::{Expects, FailureCode, LabelId, Summary, TerminalStatus};

/// A remote request, after the layer has checked it against the allowlist and the state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppAction {
    /// Same as pressing "Finish and check".
    Done,
    /// Same as pressing "Continue" on a pre-flight review.
    Next,
    /// Same as pressing "Cancel". Cooperative: the job stops at its next check.
    Cancel,
}

/// Whether the app took the action up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApplyOutcome {
    /// The app acted on it. `accepted` on the wire means "requested", not "finished".
    Applied,
    /// Nothing was running that this could apply to.
    NotApplicable,
}

/// What the host implements.
pub trait AppBridge: Send + Sync {
    /// Runs on the transport thread: be quick, and never block on the UI.
    fn apply(&self, action: AppAction) -> ApplyOutcome;
}

/// A control the app is offering right now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptSpec {
    pub expects: Expects,
    pub label_id: LabelId,
    /// Informational: whether the job waits for the answer.
    pub blocking: bool,
    /// Optional short text. Control characters are stripped and path-like text is dropped.
    pub text: Option<String>,
}

impl PromptSpec {
    pub fn new(expects: Expects, label_id: LabelId, blocking: bool) -> Self {
        Self {
            expects,
            label_id,
            blocking,
            text: None,
        }
    }
}

/// How a job ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusReport {
    pub status: TerminalStatus,
    pub failure_code: Option<FailureCode>,
    pub summary: Option<Summary>,
}

impl StatusReport {
    pub fn completed(summary: Summary) -> Self {
        Self {
            status: TerminalStatus::Completed,
            failure_code: None,
            summary: Some(summary),
        }
    }

    pub fn cancelled(summary: Option<Summary>) -> Self {
        Self {
            status: TerminalStatus::Cancelled,
            failure_code: Some(FailureCode::Cancelled),
            summary,
        }
    }

    pub fn failed(code: FailureCode) -> Self {
        Self {
            status: TerminalStatus::Failed,
            failure_code: Some(code),
            summary: None,
        }
    }
}
