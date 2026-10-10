//! The action allowlist, the rate limiter and the duplicate cache.
//!
//! Remote actions are exactly `status`, `next`, `done` and `cancel`. Anything else fails closed.

use crate::wire::{
    Action, ActionKind, ActionResult, Expects, PromptObject, RejectReason, SessionState,
};
use std::collections::{HashMap, VecDeque};

/// Decides whether `action` may run in the current state. Pure, shared with the relay through
/// `protocol/fixtures/action-rules.json`.
///
/// `was_issued` says whether a prompt id was offered earlier in this session, which turns a
/// lost race with a local press into `stale-prompt` instead of `invalid-state`.
pub fn decide(
    action: &Action,
    state: SessionState,
    prompt: Option<&PromptObject>,
    was_issued: impl Fn(&str) -> bool,
) -> Result<(), RejectReason> {
    match action.action {
        ActionKind::Status => Ok(()),
        ActionKind::Cancel => match state {
            SessionState::Running | SessionState::AwaitingUser => Ok(()),
            _ => Err(RejectReason::InvalidState),
        },
        ActionKind::Next | ActionKind::Done => {
            let wanted = if action.action == ActionKind::Next {
                Expects::Next
            } else {
                Expects::Done
            };
            let Some(id) = action.prompt_id.as_deref() else {
                return Err(RejectReason::Malformed);
            };
            match prompt {
                Some(open) if open.prompt_id == id => {
                    if open.expects == wanted {
                        Ok(())
                    } else {
                        Err(RejectReason::InvalidState)
                    }
                }
                Some(_) => Err(RejectReason::StalePrompt),
                None if was_issued(id) => Err(RejectReason::StalePrompt),
                None => Err(RejectReason::InvalidState),
            }
        }
    }
}

/// A token bucket: `rate` actions per second with a burst of the same size.
#[derive(Debug, Clone)]
pub struct TokenBucket {
    rate: u64,
    capacity_milli: u64,
    tokens_milli: u64,
    last_ms: u64,
}

impl TokenBucket {
    pub fn new(rate_per_sec: u32, now_ms: u64) -> Self {
        let capacity_milli = u64::from(rate_per_sec) * 1000;
        Self {
            rate: u64::from(rate_per_sec),
            capacity_milli,
            tokens_milli: capacity_milli,
            last_ms: now_ms,
        }
    }

    /// Takes one token if there is one.
    pub fn try_take(&mut self, now_ms: u64) -> bool {
        let elapsed = now_ms.saturating_sub(self.last_ms);
        self.last_ms = now_ms.max(self.last_ms);
        self.tokens_milli = (self.tokens_milli + elapsed * self.rate).min(self.capacity_milli);
        if self.tokens_milli >= 1000 {
            self.tokens_milli -= 1000;
            true
        } else {
            false
        }
    }
}

/// Remembers recent action ids and their results so a duplicate is answered, never re-applied.
#[derive(Debug, Clone)]
pub struct Dedup {
    capacity: usize,
    order: VecDeque<String>,
    results: HashMap<String, ActionResult>,
}

impl Dedup {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            order: VecDeque::new(),
            results: HashMap::new(),
        }
    }

    pub fn get(&self, action_id: &str) -> Option<&ActionResult> {
        self.results.get(action_id)
    }

    /// Stores a result, forgetting the oldest id once the cache is full.
    pub fn insert(&mut self, result: ActionResult) {
        let id = result.action_id.clone();
        if self.results.insert(id.clone(), result).is_none() {
            self.order.push_back(id);
            while self.order.len() > self.capacity {
                if let Some(old) = self.order.pop_front() {
                    self.results.remove(&old);
                }
            }
        }
    }

    pub fn len(&self) -> usize {
        self.results.len()
    }

    pub fn is_empty(&self) -> bool {
        self.results.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::{LabelId, Outcome};

    fn act(kind: ActionKind, prompt: Option<&str>) -> Action {
        Action {
            action_id: "act-0001-abcd".into(),
            action: kind,
            prompt_id: prompt.map(str::to_string),
        }
    }

    fn open(id: &str, expects: Expects) -> PromptObject {
        PromptObject {
            prompt_id: id.into(),
            expects,
            label_id: LabelId::Continue,
            blocking: false,
            text: None,
        }
    }

    #[test]
    fn status_is_allowed_in_every_state() {
        for s in [
            SessionState::Idle,
            SessionState::Running,
            SessionState::AwaitingUser,
            SessionState::Completed,
            SessionState::Cancelled,
            SessionState::Failed,
        ] {
            assert_eq!(
                decide(&act(ActionKind::Status, None), s, None, |_| false),
                Ok(())
            );
        }
    }

    #[test]
    fn cancel_is_allowed_only_while_running_or_awaiting_the_user() {
        let cancel = act(ActionKind::Cancel, None);
        assert_eq!(
            decide(&cancel, SessionState::Running, None, |_| false),
            Ok(())
        );
        assert_eq!(
            decide(&cancel, SessionState::AwaitingUser, None, |_| false),
            Ok(())
        );
        for s in [
            SessionState::Idle,
            SessionState::Completed,
            SessionState::Cancelled,
            SessionState::Failed,
        ] {
            assert_eq!(
                decide(&cancel, s, None, |_| false),
                Err(RejectReason::InvalidState)
            );
        }
    }

    #[test]
    fn done_is_allowed_only_for_an_open_prompt_that_expects_done() {
        let p = open("p-1", Expects::Done);
        let done = act(ActionKind::Done, Some("p-1"));
        assert_eq!(
            decide(&done, SessionState::AwaitingUser, Some(&p), |_| true),
            Ok(())
        );
        let wrong = open("p-1", Expects::Next);
        assert_eq!(
            decide(&done, SessionState::AwaitingUser, Some(&wrong), |_| true),
            Err(RejectReason::InvalidState)
        );
    }

    #[test]
    fn next_is_allowed_only_for_an_open_prompt_that_expects_next() {
        let p = open("p-1", Expects::Next);
        let next = act(ActionKind::Next, Some("p-1"));
        assert_eq!(
            decide(&next, SessionState::AwaitingUser, Some(&p), |_| true),
            Ok(())
        );
        let wrong = open("p-1", Expects::Done);
        assert_eq!(
            decide(&next, SessionState::AwaitingUser, Some(&wrong), |_| true),
            Err(RejectReason::InvalidState)
        );
    }

    #[test]
    fn an_action_naming_another_prompt_is_stale() {
        let p = open("p-2", Expects::Done);
        let done = act(ActionKind::Done, Some("p-1"));
        assert_eq!(
            decide(&done, SessionState::AwaitingUser, Some(&p), |_| true),
            Err(RejectReason::StalePrompt)
        );
    }

    #[test]
    fn an_action_for_a_prompt_already_closed_is_stale() {
        let done = act(ActionKind::Done, Some("p-1"));
        assert_eq!(
            decide(&done, SessionState::Running, None, |id| id == "p-1"),
            Err(RejectReason::StalePrompt)
        );
    }

    #[test]
    fn an_action_for_a_prompt_never_offered_is_an_invalid_state() {
        let done = act(ActionKind::Done, Some("p-9"));
        assert_eq!(
            decide(&done, SessionState::Running, None, |_| false),
            Err(RejectReason::InvalidState)
        );
        assert_eq!(
            decide(&done, SessionState::Idle, None, |_| false),
            Err(RejectReason::InvalidState)
        );
    }

    #[test]
    fn next_or_done_without_a_prompt_id_is_malformed() {
        assert_eq!(
            decide(
                &act(ActionKind::Done, None),
                SessionState::Running,
                None,
                |_| false
            ),
            Err(RejectReason::Malformed)
        );
    }

    #[test]
    fn the_bucket_allows_a_burst_then_refuses_then_refills() {
        let mut b = TokenBucket::new(5, 0);
        assert!((0..5).all(|_| b.try_take(0)));
        assert!(!b.try_take(0));
        assert!(!b.try_take(100));
        assert!(b.try_take(200));
        assert!(!b.try_take(200));
        assert!((0..5).all(|_| b.try_take(10_000)));
        assert!(!b.try_take(10_000));
    }

    #[test]
    fn the_bucket_tolerates_a_clock_that_goes_backwards() {
        let mut b = TokenBucket::new(5, 1_000);
        assert!((0..5).all(|_| b.try_take(1_000)));
        assert!(!b.try_take(500));
    }

    fn result(id: &str) -> ActionResult {
        ActionResult {
            action_id: id.into(),
            outcome: Outcome::Accepted,
            reason: None,
            state: None,
        }
    }

    #[test]
    fn the_dedup_cache_returns_the_stored_result() {
        let mut d = Dedup::new(8);
        d.insert(result("act-1"));
        assert_eq!(d.get("act-1").unwrap().outcome, Outcome::Accepted);
        assert!(d.get("act-2").is_none());
    }

    #[test]
    fn the_dedup_cache_forgets_the_oldest_id_when_full() {
        let mut d = Dedup::new(8);
        for i in 0..10 {
            d.insert(result(&format!("act-{i}")));
        }
        assert_eq!(d.len(), 8);
        assert!(d.get("act-0").is_none() && d.get("act-1").is_none());
        assert!(d.get("act-9").is_some());
    }

    #[test]
    fn inserting_the_same_id_twice_keeps_one_entry() {
        let mut d = Dedup::new(8);
        d.insert(result("act-1"));
        d.insert(result("act-1"));
        assert_eq!(d.len(), 1);
    }
}
