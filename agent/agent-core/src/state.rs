//! The session state machine. The relay implements the same table; both run
//! `protocol/fixtures/state-machine.json`.
//!
//! | From                  | Trigger                           | To                          |
//! | --------------------- | --------------------------------- | --------------------------- |
//! | Idle, terminal        | `job-started`                     | Running                     |
//! | Running               | `prompt-opened`                   | AwaitingUser                |
//! | AwaitingUser          | `prompt-closed` (open prompt)     | Running                     |
//! | Running, AwaitingUser | `step`, `progress`                | unchanged                   |
//! | Running, AwaitingUser | `status` completed/cancelled/failed | Completed/Cancelled/Failed |
//! | any                   | `armed-state`, unknown events     | unchanged                   |
//!
//! Anything else is an illegal transition and leaves the state untouched. A step named `done` is
//! an ordinary step, never a terminal one.

use crate::wire::{
    EventBody, JobKind, ProgressFields, PromptObject, SessionState, Snapshot, TerminalInfo,
    TerminalStatus,
};

/// The event is not allowed in the current state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IllegalTransition;

/// Tracks what a session is doing, from the events it has seen.
#[derive(Debug, Clone)]
pub struct Machine {
    state: SessionState,
    job_id: Option<String>,
    job_kind: Option<JobKind>,
    progress: Option<ProgressFields>,
    prompt: Option<PromptObject>,
    terminal: Option<TerminalInfo>,
}

impl Default for Machine {
    fn default() -> Self {
        Self::new()
    }
}

impl Machine {
    pub fn new() -> Self {
        Self {
            state: SessionState::Idle,
            job_id: None,
            job_kind: None,
            progress: None,
            prompt: None,
            terminal: None,
        }
    }

    pub fn state(&self) -> SessionState {
        self.state
    }

    pub fn job_id(&self) -> Option<&str> {
        self.job_id.as_deref()
    }

    pub fn prompt(&self) -> Option<&PromptObject> {
        self.prompt.as_ref()
    }

    pub fn progress(&self) -> Option<&ProgressFields> {
        self.progress.as_ref()
    }

    pub fn terminal(&self) -> Option<&TerminalInfo> {
        self.terminal.as_ref()
    }

    /// A job is running, possibly waiting on a prompt.
    pub fn is_job_active(&self) -> bool {
        matches!(
            self.state,
            SessionState::Running | SessionState::AwaitingUser
        )
    }

    /// The last job ended.
    pub fn is_terminal(&self) -> bool {
        matches!(
            self.state,
            SessionState::Completed | SessionState::Cancelled | SessionState::Failed
        )
    }

    /// Applies one event, or refuses it without changing anything.
    pub fn apply(&mut self, body: &EventBody) -> Result<(), IllegalTransition> {
        match body {
            EventBody::JobStarted { job_id, job_kind } => {
                if self.is_job_active() {
                    return Err(IllegalTransition);
                }
                *self = Machine::new();
                self.state = SessionState::Running;
                self.job_id = Some(job_id.clone());
                self.job_kind = Some(*job_kind);
                Ok(())
            }
            EventBody::Step { .. } => self.require_active(),
            EventBody::Progress(p) => {
                self.require_active()?;
                self.progress = Some(p.clone());
                Ok(())
            }
            EventBody::PromptOpened(p) => {
                if self.state != SessionState::Running {
                    return Err(IllegalTransition);
                }
                self.prompt = Some(p.clone());
                self.state = SessionState::AwaitingUser;
                Ok(())
            }
            EventBody::PromptClosed { prompt_id, .. } => {
                let open = self
                    .prompt
                    .as_ref()
                    .is_some_and(|p| &p.prompt_id == prompt_id);
                if self.state != SessionState::AwaitingUser || !open {
                    return Err(IllegalTransition);
                }
                self.prompt = None;
                self.state = SessionState::Running;
                Ok(())
            }
            EventBody::Status(t) => {
                self.require_active()?;
                let next = match t.status {
                    TerminalStatus::Completed => SessionState::Completed,
                    TerminalStatus::Cancelled => SessionState::Cancelled,
                    TerminalStatus::Failed => SessionState::Failed,
                    TerminalStatus::Unknown => return Err(IllegalTransition),
                };
                self.prompt = None;
                self.terminal = Some(t.clone());
                self.state = next;
                Ok(())
            }
            EventBody::ArmedState(_) | EventBody::Unknown => Ok(()),
        }
    }

    fn require_active(&self) -> Result<(), IllegalTransition> {
        if self.is_job_active() {
            Ok(())
        } else {
            Err(IllegalTransition)
        }
    }

    /// Everything a client needs to rebuild its view.
    pub fn snapshot(&self, seq: u64, armed: bool) -> Snapshot {
        Snapshot {
            seq,
            armed,
            state: self.state,
            job_id: self.job_id.clone(),
            job_kind: self.job_kind,
            progress: self.progress.clone(),
            prompt: self.prompt.clone(),
            terminal: self.terminal.clone(),
        }
    }
}

#[cfg(test)]
pub(crate) mod testing {
    use crate::wire::*;

    pub fn job_started() -> EventBody {
        EventBody::JobStarted {
            job_id: "0".repeat(32),
            job_kind: JobKind::RecordWatch,
        }
    }

    pub fn progress() -> EventBody {
        EventBody::Progress(ProgressFields {
            step: Step::Copying,
            percent: Some(10),
            files_done: 1,
            files_total: Some(10),
            bytes_done: 1,
            bytes_total: Some(10),
            ok: 1,
            skipped: 0,
            failed: 0,
        })
    }

    pub fn prompt_opened(id: &str, expects: Expects) -> EventBody {
        EventBody::PromptOpened(PromptObject {
            prompt_id: id.to_string(),
            expects,
            label_id: LabelId::FinishAndCheck,
            blocking: false,
            text: None,
        })
    }

    pub fn prompt_closed(id: &str) -> EventBody {
        EventBody::PromptClosed {
            prompt_id: id.to_string(),
            reason: CloseReason::AnsweredRemote,
        }
    }

    pub fn status(status: TerminalStatus) -> EventBody {
        EventBody::Status(TerminalInfo {
            status,
            failure_code: None,
            summary: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;
    use crate::wire::{ArmedState, Expects, Step};

    fn running() -> Machine {
        let mut m = Machine::new();
        m.apply(&job_started()).unwrap();
        m
    }

    fn awaiting() -> Machine {
        let mut m = running();
        m.apply(&prompt_opened("p-1", Expects::Done)).unwrap();
        m
    }

    fn terminal(status: TerminalStatus) -> Machine {
        let mut m = running();
        m.apply(&status_body(status)).unwrap();
        m
    }

    fn status_body(s: TerminalStatus) -> EventBody {
        status(s)
    }

    #[test]
    fn a_job_starting_from_idle_runs() {
        let m = running();
        assert_eq!(m.state(), SessionState::Running);
        assert!(m.is_job_active());
    }

    #[test]
    fn a_job_starting_after_a_terminal_state_runs_again_and_clears_the_old_outcome() {
        for s in [
            TerminalStatus::Completed,
            TerminalStatus::Cancelled,
            TerminalStatus::Failed,
        ] {
            let mut m = terminal(s);
            assert!(m.is_terminal());
            m.apply(&job_started()).unwrap();
            assert_eq!(m.state(), SessionState::Running);
            assert!(m.terminal().is_none() && m.progress().is_none());
        }
    }

    #[test]
    fn a_job_starting_while_one_runs_is_illegal() {
        let mut m = running();
        assert_eq!(m.apply(&job_started()), Err(IllegalTransition));
        let mut m = awaiting();
        assert_eq!(m.apply(&job_started()), Err(IllegalTransition));
        assert_eq!(m.state(), SessionState::AwaitingUser);
    }

    #[test]
    fn a_prompt_opening_while_running_awaits_the_user() {
        let m = awaiting();
        assert_eq!(m.state(), SessionState::AwaitingUser);
        assert_eq!(m.prompt().unwrap().prompt_id, "p-1");
    }

    #[test]
    fn a_prompt_opening_while_idle_awaiting_or_terminal_is_illegal() {
        assert_eq!(
            Machine::new().apply(&prompt_opened("p", Expects::Done)),
            Err(IllegalTransition)
        );
        assert_eq!(
            awaiting().apply(&prompt_opened("p-2", Expects::Done)),
            Err(IllegalTransition)
        );
        assert_eq!(
            terminal(TerminalStatus::Completed).apply(&prompt_opened("p", Expects::Done)),
            Err(IllegalTransition)
        );
    }

    #[test]
    fn closing_the_open_prompt_returns_to_running() {
        let mut m = awaiting();
        m.apply(&prompt_closed("p-1")).unwrap();
        assert_eq!(m.state(), SessionState::Running);
        assert!(m.prompt().is_none());
    }

    #[test]
    fn closing_a_prompt_that_is_not_open_is_illegal() {
        assert_eq!(
            running().apply(&prompt_closed("p-1")),
            Err(IllegalTransition)
        );
        assert_eq!(
            awaiting().apply(&prompt_closed("other")),
            Err(IllegalTransition)
        );
        assert_eq!(
            Machine::new().apply(&prompt_closed("p-1")),
            Err(IllegalTransition)
        );
    }

    #[test]
    fn progress_and_steps_are_legal_while_running_and_while_awaiting_the_user() {
        for mut m in [running(), awaiting()] {
            let before = m.state();
            m.apply(&progress()).unwrap();
            m.apply(&EventBody::Step {
                step: Step::Watching,
            })
            .unwrap();
            assert_eq!(m.state(), before);
            assert!(m.progress().is_some());
        }
    }

    #[test]
    fn progress_and_steps_are_illegal_when_idle_or_terminal() {
        for mut m in [Machine::new(), terminal(TerminalStatus::Failed)] {
            assert_eq!(m.apply(&progress()), Err(IllegalTransition));
            assert_eq!(
                m.apply(&EventBody::Step {
                    step: Step::Copying
                }),
                Err(IllegalTransition)
            );
        }
    }

    #[test]
    fn a_step_named_done_never_ends_the_job() {
        let mut m = running();
        m.apply(&EventBody::Step { step: Step::Done }).unwrap();
        assert_eq!(m.state(), SessionState::Running);
    }

    #[test]
    fn a_status_event_ends_a_running_job_in_each_terminal_state() {
        for (status, expected) in [
            (TerminalStatus::Completed, SessionState::Completed),
            (TerminalStatus::Cancelled, SessionState::Cancelled),
            (TerminalStatus::Failed, SessionState::Failed),
        ] {
            let mut m = running();
            m.apply(&status_body(status)).unwrap();
            assert_eq!(m.state(), expected);
        }
    }

    #[test]
    fn a_status_event_ends_a_job_that_is_awaiting_the_user_and_clears_the_prompt() {
        let mut m = awaiting();
        m.apply(&status_body(TerminalStatus::Cancelled)).unwrap();
        assert_eq!(m.state(), SessionState::Cancelled);
        assert!(m.prompt().is_none());
    }

    #[test]
    fn a_status_event_is_illegal_when_idle_terminal_or_unknown() {
        assert_eq!(
            Machine::new().apply(&status_body(TerminalStatus::Completed)),
            Err(IllegalTransition)
        );
        assert_eq!(
            terminal(TerminalStatus::Completed).apply(&status_body(TerminalStatus::Failed)),
            Err(IllegalTransition)
        );
        assert_eq!(
            running().apply(&status_body(TerminalStatus::Unknown)),
            Err(IllegalTransition)
        );
    }

    #[test]
    fn armed_state_and_unknown_events_never_change_the_state() {
        let armed = EventBody::ArmedState(ArmedState {
            armed: true,
            expires_at_ms: None,
            viewers: None,
        });
        for mut m in [
            Machine::new(),
            running(),
            awaiting(),
            terminal(TerminalStatus::Completed),
        ] {
            let before = m.state();
            m.apply(&armed).unwrap();
            m.apply(&EventBody::Unknown).unwrap();
            assert_eq!(m.state(), before);
        }
    }

    #[test]
    fn the_snapshot_reflects_the_job_progress_prompt_and_outcome() {
        let mut m = awaiting();
        m.apply(&progress()).unwrap();
        let s = m.snapshot(9, true);
        assert_eq!(
            (s.seq, s.armed, s.state),
            (9, true, SessionState::AwaitingUser)
        );
        assert!(s.job_id.is_some() && s.progress.is_some() && s.prompt.is_some());
        assert!(s.terminal.is_none());
        let t = terminal(TerminalStatus::Completed).snapshot(3, false);
        assert!(t.terminal.is_some() && t.prompt.is_none());
    }
}
