mod common;

use agent_core::*;
use common::*;
use std::sync::Arc;

struct Play {
    clock: Arc<ManualClock>,
    rc: Arc<RemoteControl>,
    sim: Arc<SimulatedAppBridge>,
    frames: Vec<Frame>,
    /// The simulated time each frame was polled.
    times: Vec<u64>,
    next_action: u32,
}

impl Play {
    fn start(script: SimScript) -> Play {
        let dir = temp_dir(script.name());
        let clock = Arc::new(ManualClock::new(START_MS));
        let sim = SimulatedAppBridge::new(script);
        let deps = Deps::new(sim.clone())
            .with_clock(clock.clone())
            .with_ids(Arc::new(SequentialIds::default()));
        let rc = RemoteControl::new(test_config(&dir), deps).unwrap();
        sim.attach(rc.events());
        rc.arm(ArmRequest {
            ttl: ArmTtl::TwelveHours,
        })
        .unwrap();
        rc.set_connected(true);
        Play {
            clock,
            rc,
            sim,
            frames: Vec::new(),
            times: Vec::new(),
            next_action: 0,
        }
    }

    /// One 100 ms step of simulated time.
    fn step(&mut self) {
        self.clock.advance(100);
        self.sim.tick();
        self.rc.tick();
        let out = self.rc.poll_outbound();
        let now = self.clock.now_ms();
        self.times.extend(out.iter().map(|_| now));
        self.frames.extend(out);
    }

    fn run_until(&mut self, what: &str, done: impl Fn(&[EventBody]) -> bool) {
        for _ in 0..2_000 {
            if done(&bodies(&self.frames)) {
                return;
            }
            self.step();
        }
        panic!("never reached: {what}; saw {:?}", kinds(&self.frames));
    }

    fn run_to_end(&mut self) {
        for _ in 0..2_000 {
            if self.sim.is_finished() {
                self.step();
                self.step();
                return;
            }
            self.step();
        }
        panic!("script did not finish: {:?}", kinds(&self.frames));
    }

    fn act(&mut self, kind: ActionKind, prompt: Option<&str>) -> ActionResult {
        self.next_action += 1;
        let a = action(&format!("act-{:04}-simx", self.next_action), kind, prompt);
        let res = self.rc.handle_action(a);
        self.step();
        res
    }

    fn open_prompt(&self) -> Option<PromptObject> {
        bodies(&self.frames).iter().rev().find_map(|b| match b {
            EventBody::PromptOpened(p) => Some(p.clone()),
            _ => None,
        })
    }

    fn progress(&self) -> Vec<ProgressFields> {
        bodies(&self.frames)
            .into_iter()
            .filter_map(|b| match b {
                EventBody::Progress(p) => Some(p),
                _ => None,
            })
            .collect()
    }

    fn status(&self) -> Option<TerminalInfo> {
        bodies(&self.frames).into_iter().find_map(|b| match b {
            EventBody::Status(t) => Some(t),
            _ => None,
        })
    }

    fn close_reasons(&self) -> Vec<CloseReason> {
        bodies(&self.frames)
            .into_iter()
            .filter_map(|b| match b {
                EventBody::PromptClosed { reason, .. } => Some(reason),
                _ => None,
            })
            .collect()
    }
}

fn has_prompt_open(b: &[EventBody]) -> bool {
    b.iter().any(|e| matches!(e, EventBody::PromptOpened(_)))
}

fn steps(b: &[EventBody]) -> Vec<Step> {
    b.iter()
        .filter_map(|e| match e {
            EventBody::Step { step } => Some(*step),
            _ => None,
        })
        .collect()
}

// ---- watch-finish ----------------------------------------------------------------------------

#[test]
fn watch_finish_lists_with_unknown_totals_then_a_step_called_done_that_is_not_terminal() {
    let mut p = Play::start(SimScript::WatchFinish);
    p.run_until("prompt", has_prompt_open);
    let first = &p.progress()[0];
    assert_eq!(
        (
            first.step,
            first.percent,
            first.files_total,
            first.bytes_total
        ),
        (Step::ListingSource, None, None, None)
    );
    let before_prompt = bodies(&p.frames);
    assert_eq!(
        &steps(&before_prompt)[..3],
        &[Step::ListingSource, Step::Done, Step::Watching]
    );
    assert_eq!(
        p.rc.view().state,
        SessionState::AwaitingUser,
        "done step did not end the job"
    );
}

#[test]
fn watch_finish_offers_a_non_blocking_done_prompt_and_progress_keeps_rising_while_it_is_open() {
    let mut p = Play::start(SimScript::WatchFinish);
    p.run_until("prompt", has_prompt_open);
    let prompt = p.open_prompt().unwrap();
    assert_eq!(
        (prompt.expects, prompt.label_id, prompt.blocking),
        (Expects::Done, LabelId::FinishAndCheck, false)
    );
    let seen = p.progress().len();
    for _ in 0..25 {
        p.step();
    }
    let later: Vec<u64> = p.progress()[seen..].iter().map(|x| x.files_done).collect();
    assert!(
        later.len() >= 2,
        "progress frames while the prompt is open: {later:?}"
    );
    assert!(later.windows(2).all(|w| w[0] < w[1]), "{later:?}");
    assert_eq!(p.rc.view().state, SessionState::AwaitingUser);
    assert!(p
        .progress()
        .iter()
        .skip(1)
        .any(|x| x.percent.is_some() && x.files_total == Some(200)));
}

#[test]
fn watch_finish_ends_after_a_remote_done_with_some_files_not_copied() {
    let mut p = Play::start(SimScript::WatchFinish);
    p.run_until("prompt", has_prompt_open);
    for _ in 0..20 {
        p.step();
    }
    let id = p.open_prompt().unwrap().prompt_id;
    let res = p.act(ActionKind::Done, Some(&id));
    assert_eq!(res.outcome, Outcome::Accepted);
    p.run_to_end();
    assert_eq!(p.close_reasons(), vec![CloseReason::AnsweredRemote]);
    let all = bodies(&p.frames);
    assert_eq!(steps(&all).last(), Some(&Step::Finishing));
    let t = p.status().unwrap();
    assert_eq!(t.status, TerminalStatus::Completed);
    let s = t.summary.unwrap();
    assert!(s.failed > 0 && s.ok + s.failed == s.files_planned);
}

// ---- watch-auto ------------------------------------------------------------------------------

#[test]
fn watch_auto_closes_the_prompt_by_itself_and_completes_with_nothing_missing() {
    let mut p = Play::start(SimScript::WatchAuto);
    p.run_to_end();
    assert_eq!(p.close_reasons(), vec![CloseReason::Auto]);
    let s = p.status().unwrap().summary.unwrap();
    assert_eq!((s.failed, s.ok), (0, 200));
    assert_eq!(
        p.rc.view().state,
        SessionState::Idle,
        "the session disarmed after the status"
    );
}

#[test]
fn watch_auto_needs_no_remote_action_at_any_point() {
    let mut p = Play::start(SimScript::WatchAuto);
    p.run_to_end();
    assert!(p.rc.snapshot().is_none() || p.rc.snapshot().unwrap().state == SessionState::Completed);
    assert_eq!(p.status().unwrap().status, TerminalStatus::Completed);
}

// ---- watch-local-finish ----------------------------------------------------------------------

#[test]
fn watch_local_finish_closes_the_prompt_as_answered_local_and_a_later_remote_done_is_stale() {
    let mut p = Play::start(SimScript::WatchLocalFinish);
    p.run_until("prompt", has_prompt_open);
    let id = p.open_prompt().unwrap().prompt_id;
    p.run_until("local close", |b| {
        b.iter()
            .any(|e| matches!(e, EventBody::PromptClosed { .. }))
    });
    assert_eq!(p.close_reasons(), vec![CloseReason::AnsweredLocal]);
    let res = p.act(ActionKind::Done, Some(&id));
    assert_eq!(
        (res.outcome, res.reason),
        (Outcome::Rejected, Some(RejectReason::StalePrompt))
    );
    p.run_to_end();
    assert_eq!(p.status().unwrap().status, TerminalStatus::Completed);
}

#[test]
fn pressing_finish_in_the_simulated_app_by_hand_behaves_like_a_local_press() {
    let mut p = Play::start(SimScript::WatchFinish);
    p.run_until("prompt", has_prompt_open);
    p.sim.press_local_finish();
    p.run_to_end();
    assert_eq!(p.close_reasons(), vec![CloseReason::AnsweredLocal]);
}

// ---- copy ------------------------------------------------------------------------------------

#[test]
fn copy_runs_to_one_hundred_percent_with_no_prompt_at_any_point() {
    let mut p = Play::start(SimScript::Copy);
    p.run_to_end();
    let all = bodies(&p.frames);
    assert!(!has_prompt_open(&all));
    assert_eq!(
        &steps(&all)[..3],
        &[Step::ListingSource, Step::Done, Step::Copying]
    );
    let last = p
        .progress()
        .into_iter()
        .rfind(|x| x.step == Step::Copying)
        .unwrap();
    assert_eq!(last.percent, Some(100));
    assert_eq!(p.status().unwrap().status, TerminalStatus::Completed);
}

#[test]
fn copy_has_no_percent_until_the_source_is_listed() {
    let mut p = Play::start(SimScript::Copy);
    p.run_to_end();
    let listing: Vec<_> = p
        .progress()
        .into_iter()
        .filter(|x| x.step == Step::ListingSource)
        .collect();
    assert!(!listing.is_empty() && listing.iter().all(|x| x.percent.is_none()));
}

// ---- copy-fail -------------------------------------------------------------------------------

#[test]
fn copy_fail_ends_failed_with_not_enough_space_before_any_copying() {
    let mut p = Play::start(SimScript::CopyFail);
    p.run_to_end();
    let t = p.status().unwrap();
    assert_eq!(
        (t.status, t.failure_code),
        (TerminalStatus::Failed, Some(FailureCode::NotEnoughSpace))
    );
    assert!(!steps(&bodies(&p.frames)).contains(&Step::Copying));
    assert!(p.progress().iter().all(|x| x.step == Step::ListingSource));
}

// ---- cancel-midway ---------------------------------------------------------------------------

#[test]
fn cancel_midway_accepts_the_cancel_as_requested_then_confirms_with_a_status_event() {
    let mut p = Play::start(SimScript::CancelMidway);
    p.run_until("copying progress", |b| steps(b).contains(&Step::Copying));
    for _ in 0..15 {
        p.step();
    }
    let res = p.act(ActionKind::Cancel, None);
    assert_eq!(res.outcome, Outcome::Accepted);
    assert_eq!(
        p.rc.view().state,
        SessionState::Running,
        "cancelling until the status event arrives"
    );
    assert!(p.status().is_none());
    let seen = p.progress().len();
    p.run_to_end();
    assert!(
        p.progress().len() > seen,
        "a few more progress events after the cancel"
    );
    let t = p.status().unwrap();
    assert_eq!(
        (t.status, t.failure_code),
        (TerminalStatus::Cancelled, Some(FailureCode::Cancelled))
    );
}

// ---- preflight-next --------------------------------------------------------------------------

#[test]
fn preflight_next_shows_a_blocking_continue_prompt_and_pauses_progress_until_answered() {
    let mut p = Play::start(SimScript::PreflightNext);
    p.run_until("prompt", has_prompt_open);
    let prompt = p.open_prompt().unwrap();
    assert_eq!(
        (prompt.expects, prompt.label_id, prompt.blocking),
        (Expects::Next, LabelId::Continue, true)
    );
    let seen = p.progress().len();
    for _ in 0..30 {
        p.step();
    }
    assert_eq!(
        p.progress().len(),
        seen,
        "no progress while the prompt blocks"
    );
    assert!(!steps(&bodies(&p.frames)).contains(&Step::Copying));
    let res = p.act(ActionKind::Next, Some(&prompt.prompt_id));
    assert_eq!(res.outcome, Outcome::Accepted);
    p.run_to_end();
    assert_eq!(p.close_reasons(), vec![CloseReason::AnsweredRemote]);
    assert_eq!(p.status().unwrap().status, TerminalStatus::Completed);
}

#[test]
fn preflight_next_rejects_done_because_the_prompt_expects_next() {
    let mut p = Play::start(SimScript::PreflightNext);
    p.run_until("prompt", has_prompt_open);
    let id = p.open_prompt().unwrap().prompt_id;
    let res = p.act(ActionKind::Done, Some(&id));
    assert_eq!(res.reason, Some(RejectReason::InvalidState));
}

// ---- every script ----------------------------------------------------------------------------

fn finish_script(script: SimScript) -> Play {
    let mut p = Play::start(script);
    match script {
        SimScript::WatchFinish => {
            p.run_until("prompt", has_prompt_open);
            let id = p.open_prompt().unwrap().prompt_id;
            p.act(ActionKind::Done, Some(&id));
        }
        SimScript::CancelMidway => {
            p.run_until("copying", |b| steps(b).contains(&Step::Copying));
            p.act(ActionKind::Cancel, None);
        }
        SimScript::PreflightNext => {
            p.run_until("prompt", has_prompt_open);
            let id = p.open_prompt().unwrap().prompt_id;
            p.act(ActionKind::Next, Some(&id));
        }
        _ => {}
    }
    p.run_to_end();
    p
}

#[test]
fn every_script_ends_in_a_terminal_status_and_disarms() {
    for script in SimScript::ALL {
        let p = finish_script(script);
        assert!(p.status().is_some(), "{}", script.name());
        assert!(!p.rc.is_armed(), "{}", script.name());
    }
}

#[test]
fn every_script_emits_only_legal_events_with_contiguous_sequence_numbers() {
    for script in SimScript::ALL {
        let p = finish_script(script);
        let mut machine = Machine::new();
        let mut last_seq = 0;
        for f in &p.frames {
            let Frame::Event(e) = f else { continue };
            if matches!(e.body, EventBody::Progress(_)) {
                assert_eq!(
                    e.seq,
                    last_seq,
                    "{} progress carries the newest discrete seq",
                    script.name()
                );
                machine
                    .apply(&e.body)
                    .unwrap_or_else(|_| panic!("{}: illegal progress", script.name()));
                continue;
            }
            assert_eq!(e.seq, last_seq + 1, "{}", script.name());
            last_seq = e.seq;
            machine
                .apply(&e.body)
                .unwrap_or_else(|_| panic!("{}: illegal {:?}", script.name(), e.body));
        }
        assert!(machine.is_terminal(), "{}", script.name());
    }
}

#[test]
fn every_script_event_encodes_within_the_cap_and_leaks_nothing() {
    for script in SimScript::ALL {
        let p = finish_script(script);
        assert!(!p.frames.is_empty());
        for f in &p.frames {
            let text = encode(f).unwrap_or_else(|e| panic!("{}: {e}", script.name()));
            let value: serde_json::Value = serde_json::from_str(&text).unwrap();
            assert_eq!(
                deny::find_denied(&value),
                vec![],
                "{}: {text}",
                script.name()
            );
            assert_eq!(&decode(&text).unwrap(), f, "{} round trip", script.name());
        }
    }
}

#[test]
fn every_script_sends_progress_at_most_once_a_second_apart_from_the_flush_before_an_event() {
    for script in SimScript::ALL {
        let p = finish_script(script);
        let mut last_regular: Option<u64> = None;
        for (i, f) in p.frames.iter().enumerate() {
            let Frame::Event(e) = f else { continue };
            if !matches!(e.body, EventBody::Progress(_)) {
                continue;
            }
            let flush_before_event = matches!(
                p.frames.get(i + 1),
                Some(Frame::Event(n)) if !matches!(n.body, EventBody::Progress(_))
            ) && p.times.get(i + 1) == p.times.get(i);
            if flush_before_event {
                continue;
            }
            if let Some(prev) = last_regular {
                assert!(
                    p.times[i] - prev >= 1_000,
                    "{}: progress {} ms after the previous one",
                    script.name(),
                    p.times[i] - prev
                );
            }
            last_regular = Some(p.times[i]);
        }
    }
}
