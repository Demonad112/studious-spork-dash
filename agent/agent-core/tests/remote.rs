mod common;

use agent_core::*;
use common::*;
use std::sync::Arc;

const MIN: u64 = 60_000;
const HOUR: u64 = 3_600_000;

fn open_watch_prompt(r: &Rig) -> String {
    r.events.job_started(JobKind::RecordWatch);
    r.events.prompt_opened(PromptSpec::new(
        Expects::Done,
        LabelId::FinishAndCheck,
        false,
    ));
    let frames = r.rc.poll_outbound();
    bodies(&frames)
        .iter()
        .find_map(|b| match b {
            EventBody::PromptOpened(p) => Some(p.prompt_id.clone()),
            _ => None,
        })
        .expect("prompt opened")
}

#[test]
fn the_control_object_is_send_and_sync() {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<RemoteControl>();
    assert_send_sync::<AppEvents>();
}

// ---- arming ---------------------------------------------------------------------------------

#[test]
fn arming_is_refused_while_the_feature_is_disabled() {
    let r = rig_with("disabled", |c| c.enabled = false);
    assert!(matches!(r.rc.arm_default(), Err(Error::Disabled)));
    assert!(!r.rc.is_armed());
}

#[test]
fn arming_gives_a_session_id_and_an_armed_view() {
    let r = rig("arm-view");
    let id = r.rc.arm_default().unwrap();
    let v = r.rc.view();
    assert!(v.armed && !v.connected && !v.locked);
    assert_eq!(v.session_id.as_deref(), Some(id.as_str()));
    assert_eq!(v.expires_at_ms, Some(START_MS + 4 * HOUR));
    assert_eq!(v.state, SessionState::Idle);
}

#[test]
fn arming_while_armed_keeps_the_session_and_moves_the_expiry() {
    let r = rig("rearm");
    let a =
        r.rc.arm(ArmRequest {
            ttl: ArmTtl::FourHours,
        })
        .unwrap();
    r.clock.advance(HOUR);
    let b =
        r.rc.arm(ArmRequest {
            ttl: ArmTtl::TwelveHours,
        })
        .unwrap();
    assert_eq!(a, b);
    assert_eq!(r.rc.view().expires_at_ms, Some(START_MS + HOUR + 12 * HOUR));
}

#[test]
fn a_new_arming_after_disarm_starts_a_fresh_session_with_its_own_sequence() {
    let r = armed("fresh-session");
    r.events.job_started(JobKind::Simulated);
    let first = r.rc.session_id().unwrap();
    r.rc.disarm(DisarmReason::Local);
    let second = r.rc.arm_default().unwrap();
    assert_ne!(first, second);
    r.rc.set_connected(true);
    r.events.job_started(JobKind::Simulated);
    match &r.rc.poll_outbound()[0] {
        Frame::Event(e) => assert_eq!(e.seq, 1),
        other => panic!("{}", other.type_name()),
    }
}

#[test]
fn the_default_session_expires_after_four_hours() {
    let r = armed("ttl-4h");
    r.events.job_started(JobKind::RecordCopy);
    r.clock.advance(4 * HOUR - 1);
    r.rc.tick();
    assert!(r.rc.is_armed());
    r.clock.advance(1);
    r.rc.tick();
    assert!(!r.rc.is_armed());
    assert_eq!(
        r.audit.entries().last().unwrap().detail.as_deref(),
        Some("ttl-expired")
    );
}

#[test]
fn a_twelve_hour_session_outlives_four_hours_and_expires_after_twelve() {
    let r = rig("ttl-12h");
    r.rc.arm(ArmRequest {
        ttl: ArmTtl::TwelveHours,
    })
    .unwrap();
    r.events.job_started(JobKind::Simulated);
    r.clock.advance(11 * HOUR);
    r.rc.tick();
    assert!(r.rc.is_armed());
    r.clock.advance(HOUR);
    r.rc.tick();
    assert!(!r.rc.is_armed());
}

#[test]
fn the_hard_cap_limits_a_custom_ttl_to_twenty_four_hours() {
    let r = rig("hard-cap");
    r.rc.arm(ArmRequest {
        ttl: ArmTtl::Custom(100 * 24 * HOUR),
    })
    .unwrap();
    assert_eq!(r.rc.view().expires_at_ms, Some(START_MS + 24 * HOUR));
}

#[test]
fn until_job_ends_disarms_after_the_job_ends_even_when_the_host_asked_to_stay_armed() {
    let r = rig_with("until-job", |c| c.stay_armed_after_job = true);
    r.rc.arm(ArmRequest {
        ttl: ArmTtl::UntilJobEnds,
    })
    .unwrap();
    r.rc.set_connected(true);
    r.events.job_started(JobKind::Simulated);
    r.events.status(StatusReport::failed(FailureCode::Internal));
    r.rc.poll_outbound();
    r.rc.tick();
    assert!(!r.rc.is_armed());
}

#[test]
fn an_idle_session_disarms_after_fifteen_minutes_with_no_job() {
    let r = armed("idle");
    r.clock.advance(15 * MIN - 1);
    r.rc.tick();
    assert!(r.rc.is_armed());
    r.clock.advance(1);
    r.rc.tick();
    assert!(!r.rc.is_armed());
    assert_eq!(
        r.audit.entries().last().unwrap().detail.as_deref(),
        Some("idle")
    );
}

#[test]
fn a_quiet_twenty_minute_job_is_not_idle_disarmed() {
    let r = armed("quiet-job");
    r.events.job_started(JobKind::RecordCopy);
    r.events.progress(progress_fields(Step::Copying, 10));
    for _ in 0..20 {
        r.clock.advance(MIN);
        r.rc.tick();
        assert!(r.rc.is_armed());
    }
    assert_eq!(r.rc.view().state, SessionState::Running);
}

#[test]
fn the_idle_clock_restarts_when_a_job_ends_and_the_session_stays_armed() {
    let r = rig_with("idle-after-job", |c| c.stay_armed_after_job = true);
    r.rc.arm_default().unwrap();
    r.rc.set_connected(true);
    r.events.job_started(JobKind::Simulated);
    r.clock.advance(HOUR);
    r.events.status(StatusReport::completed(Summary {
        files_planned: 1,
        bytes_planned: 1,
        ok: 1,
        ok_bytes: 1,
        skipped: 0,
        failed: 0,
        failed_bytes: 0,
        duration_ms: 1,
    }));
    r.rc.poll_outbound();
    r.clock.advance(14 * MIN);
    r.rc.tick();
    assert!(r.rc.is_armed());
    r.clock.advance(MIN);
    r.rc.tick();
    assert!(!r.rc.is_armed());
}

#[test]
fn expiry_in_the_middle_of_a_job_closes_the_remote_side_and_the_job_carries_on_locally() {
    let r = armed("ttl-mid-job");
    r.events.job_started(JobKind::RecordCopy);
    r.rc.poll_outbound();
    r.clock.advance(4 * HOUR);
    r.rc.tick();
    assert!(!r.rc.is_armed());
    r.events.progress(progress_fields(Step::Copying, 50));
    r.events.status(StatusReport::failed(FailureCode::Other));
    assert!(r.rc.poll_outbound().is_empty());
    assert!(r.bridge.calls().is_empty());
}

#[test]
fn after_a_job_ends_the_status_is_sent_then_the_session_disarms() {
    let r = armed("after-job");
    r.events.job_started(JobKind::RecordCopy);
    r.events
        .status(StatusReport::failed(FailureCode::NotEnoughSpace));
    let frames = r.rc.poll_outbound();
    assert_eq!(kinds(&frames), vec!["job-started", "status"]);
    assert!(
        r.rc.is_armed(),
        "still armed until the frames are flushed and tick runs"
    );
    r.rc.tick();
    assert!(!r.rc.is_armed());
    assert_eq!(
        r.audit.entries().last().unwrap().detail.as_deref(),
        Some("job-ended")
    );
}

#[test]
fn staying_armed_after_a_job_keeps_the_session_open_for_the_next_job() {
    let r = rig_with("stay-armed", |c| c.stay_armed_after_job = true);
    r.rc.arm_default().unwrap();
    r.rc.set_connected(true);
    r.events.job_started(JobKind::RecordCopy);
    r.events.status(StatusReport::failed(FailureCode::Other));
    r.rc.poll_outbound();
    r.rc.tick();
    assert!(r.rc.is_armed());
    r.events.job_started(JobKind::RecordCopy);
    assert_eq!(r.rc.view().state, SessionState::Running);
}

#[test]
fn dropping_the_control_object_disarms_and_releases_the_power_guard() {
    let r = rig_with("drop", |c| c.keep_awake_while_armed = true);
    r.rc.arm_default().unwrap();
    assert_eq!(
        r.power.acquired.load(std::sync::atomic::Ordering::SeqCst),
        1
    );
    let Rig {
        rc, power, audit, ..
    } = r;
    drop(rc);
    assert_eq!(power.released.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert_eq!(
        audit.entries().last().unwrap().detail.as_deref(),
        Some("dropped")
    );
}

#[test]
fn the_power_guard_is_only_held_while_armed_when_asked_for() {
    let r = rig_with("power", |c| c.keep_awake_while_armed = true);
    r.rc.arm_default().unwrap();
    r.rc.disarm(DisarmReason::Local);
    let o = std::sync::atomic::Ordering::SeqCst;
    assert_eq!((r.power.acquired.load(o), r.power.released.load(o)), (1, 1));
    let quiet = rig("no-power");
    quiet.rc.arm_default().unwrap();
    assert_eq!(quiet.power.acquired.load(o), 0);
}

#[test]
fn the_arm_trigger_arms_on_the_next_tick() {
    let dir = temp_dir("trigger");
    let trigger = Arc::new(ManualArmTrigger::default());
    let clock = Arc::new(ManualClock::new(START_MS));
    let deps = Deps::new(TestBridge::new())
        .with_clock(clock)
        .with_trigger(trigger.clone());
    let rc = RemoteControl::new(test_config(&dir), deps).unwrap();
    rc.tick();
    assert!(!rc.is_armed());
    trigger.request(ArmTtl::TwelveHours);
    rc.tick();
    assert!(rc.is_armed());
    assert_eq!(rc.view().expires_at_ms, Some(START_MS + 12 * HOUR));
}

#[test]
fn no_received_frame_can_arm_a_disarmed_agent() {
    let r = rig("no-remote-arm");
    let dir =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../protocol/fixtures/valid");
    for entry in std::fs::read_dir(dir).unwrap() {
        let text = std::fs::read_to_string(entry.unwrap().path()).unwrap();
        let frame = decode(&text).unwrap();
        r.rc.handle_frame(frame);
        assert!(!r.rc.is_armed());
    }
    r.rc.tick();
    assert!(!r.rc.is_armed());
}

// ---- outbound ordering ----------------------------------------------------------------------

#[test]
fn events_are_numbered_from_one_and_queued_in_order() {
    let r = armed("numbering");
    r.events.job_started(JobKind::RecordCopy);
    r.events.step(Step::ListingSource);
    r.events.step(Step::Copying);
    let frames = r.rc.poll_outbound();
    let seqs: Vec<u64> = frames
        .iter()
        .map(|f| match f {
            Frame::Event(e) => e.seq,
            _ => 0,
        })
        .collect();
    assert_eq!(seqs, vec![1, 2, 3]);
    assert!(r.rc.poll_outbound().is_empty());
}

#[test]
fn illegal_events_are_dropped_without_using_a_sequence_number() {
    let r = armed("illegal");
    r.events.step(Step::Copying);
    r.events.progress(progress_fields(Step::Copying, 1));
    r.events.prompt_closed(CloseReason::Auto);
    r.events.status(StatusReport::failed(FailureCode::Other));
    assert!(r.rc.poll_outbound().is_empty());
    r.events.job_started(JobKind::Simulated);
    match &r.rc.poll_outbound()[0] {
        Frame::Event(e) => assert_eq!(e.seq, 1),
        _ => panic!(),
    }
}

#[test]
fn progress_is_coalesced_to_one_snapshot_per_second() {
    let r = armed("coalesce");
    r.events.job_started(JobKind::RecordCopy);
    r.rc.poll_outbound();
    let mut sent = 0;
    for i in 1..=30u64 {
        r.clock.advance(100);
        r.events.progress(progress_fields(Step::Copying, i));
        sent += bodies(&r.rc.poll_outbound())
            .iter()
            .filter(|b| matches!(b, EventBody::Progress(_)))
            .count();
    }
    assert!(
        (3..=4).contains(&sent),
        "sent {sent} progress frames in 3 seconds"
    );
}

#[test]
fn the_latest_progress_is_flushed_before_the_next_discrete_event() {
    let r = armed("flush-first");
    r.events.job_started(JobKind::RecordCopy);
    r.rc.poll_outbound();
    r.clock.advance(100);
    r.events.progress(progress_fields(Step::Copying, 41));
    r.clock.advance(100);
    r.events.progress(progress_fields(Step::Copying, 42));
    r.events.step(Step::Finishing);
    let frames = r.rc.poll_outbound();
    let bs = bodies(&frames);
    match (&bs[bs.len() - 2], &bs[bs.len() - 1]) {
        (
            EventBody::Progress(p),
            EventBody::Step {
                step: Step::Finishing,
            },
        ) => {
            assert_eq!(p.files_done, 42);
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_progress_frame_carries_the_newest_discrete_sequence_number() {
    let r = armed("progress-seq");
    r.events.job_started(JobKind::RecordCopy);
    r.events.step(Step::Copying);
    r.clock.advance(1_000);
    r.events.progress(progress_fields(Step::Copying, 5));
    let frames = r.rc.poll_outbound();
    match frames.last().unwrap() {
        Frame::Event(e) => {
            assert!(matches!(e.body, EventBody::Progress(_)));
            assert_eq!(e.seq, 2);
        }
        _ => panic!(),
    }
}

#[test]
fn the_final_progress_is_flushed_before_the_terminal_status() {
    let r = armed("final-progress");
    r.events.job_started(JobKind::RecordCopy);
    r.rc.poll_outbound();
    r.clock.advance(100);
    r.events.progress(progress_fields(Step::Copying, 100));
    r.events.status(StatusReport::failed(FailureCode::Other));
    assert_eq!(kinds(&r.rc.poll_outbound()), vec!["progress", "status"]);
}

#[test]
fn nothing_is_queued_while_disconnected_but_the_ring_keeps_every_event() {
    let r = rig("disconnected");
    r.rc.arm_default().unwrap();
    r.events.job_started(JobKind::RecordCopy);
    r.events.step(Step::Copying);
    assert!(r.rc.poll_outbound().is_empty());
    let frames = r.rc.handle_frame(Frame::Resync(Resync { last_seq: 0 }));
    assert_eq!(kinds(&frames), vec!["job-started", "step"]);
}

#[test]
fn a_prompt_opening_while_another_is_open_closes_the_first_as_superseded() {
    let r = armed("supersede");
    r.events.job_started(JobKind::RecordCopy);
    r.events
        .prompt_opened(PromptSpec::new(Expects::Next, LabelId::Continue, true));
    r.events.prompt_opened(PromptSpec::new(
        Expects::Done,
        LabelId::FinishAndCheck,
        false,
    ));
    let bs = bodies(&r.rc.poll_outbound());
    assert!(matches!(
        &bs[2],
        EventBody::PromptClosed {
            reason: CloseReason::Superseded,
            ..
        }
    ));
    assert!(matches!(&bs[3], EventBody::PromptOpened(_)));
}

#[test]
fn a_status_while_a_prompt_is_open_closes_the_prompt_as_job_ended_first() {
    let r = armed("job-ended");
    open_watch_prompt(&r);
    r.events.status(StatusReport::cancelled(None));
    let bs = bodies(&r.rc.poll_outbound());
    assert!(matches!(
        &bs[0],
        EventBody::PromptClosed {
            reason: CloseReason::JobEnded,
            ..
        }
    ));
    match &bs[1] {
        EventBody::Status(t) => {
            assert_eq!(t.status, TerminalStatus::Cancelled);
            assert_eq!(t.failure_code, Some(FailureCode::Cancelled));
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_new_job_while_one_runs_ends_the_old_one_as_cancelled_first() {
    let r = armed("overlap");
    r.events.job_started(JobKind::Compare);
    r.events.job_started(JobKind::DiskScan);
    assert_eq!(
        kinds(&r.rc.poll_outbound()),
        vec!["job-started", "status", "job-started"]
    );
    assert_eq!(r.rc.view().state, SessionState::Running);
}

#[test]
fn prompt_text_is_sanitised_and_path_like_text_is_dropped() {
    let r = armed("prompt-text");
    r.events.job_started(JobKind::RecordCopy);
    let mut spec = PromptSpec::new(Expects::Next, LabelId::Continue, true);
    spec.text = Some("Review\nfirst".into());
    r.events.prompt_opened(spec);
    let mut spec = PromptSpec::new(Expects::Next, LabelId::Continue, true);
    spec.text = Some("C:\\Users\\bob".into());
    r.events.prompt_opened(spec);
    let texts: Vec<Option<String>> = bodies(&r.rc.poll_outbound())
        .iter()
        .filter_map(|b| match b {
            EventBody::PromptOpened(p) => Some(p.text.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(texts, vec![Some("Reviewfirst".to_string()), None]);
}

#[test]
fn the_waker_fires_when_something_is_ready_to_send() {
    let r = armed("waker");
    let hits = Arc::new(std::sync::atomic::AtomicU32::new(0));
    let h = hits.clone();
    r.rc.set_waker(Arc::new(move || {
        h.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }));
    r.events.job_started(JobKind::Simulated);
    assert!(hits.load(std::sync::atomic::Ordering::SeqCst) >= 1);
}

// ---- resync ----------------------------------------------------------------------------------

#[test]
fn a_resync_returns_the_header_a_snapshot_and_only_the_later_events() {
    let r = armed("resync");
    r.events.job_started(JobKind::RecordCopy);
    r.events.step(Step::ListingSource);
    r.events.step(Step::Copying);
    let frames = r.rc.handle_frame(Frame::Resync(Resync { last_seq: 1 }));
    match &frames[0] {
        Frame::ResyncResult(h) => assert_eq!((h.from_seq, h.to_seq, h.gap), (2, 3, false)),
        other => panic!("{}", other.type_name()),
    }
    match &frames[1] {
        Frame::Snapshot(s) => {
            assert_eq!((s.seq, s.state), (3, SessionState::Running));
            assert!(s.job_id.is_some());
        }
        other => panic!("{}", other.type_name()),
    }
    assert_eq!(kinds(&frames[2..]), vec!["step", "step"]);
}

#[test]
fn a_resync_older_than_the_ring_reports_a_gap() {
    let r = rig_with("resync-gap", |c| c.ring_capacity = 8);
    r.rc.arm_default().unwrap();
    r.rc.set_connected(true);
    r.events.job_started(JobKind::RecordCopy);
    for _ in 0..20 {
        r.events.step(Step::Copying);
    }
    let frames = r.rc.handle_frame(Frame::Resync(Resync { last_seq: 2 }));
    match &frames[0] {
        Frame::ResyncResult(h) => assert!(h.gap && h.to_seq == 21 && h.from_seq == 14),
        other => panic!("{}", other.type_name()),
    }
}

#[test]
fn a_resync_while_disarmed_gets_no_answer() {
    let r = rig("resync-disarmed");
    assert!(r
        .rc
        .handle_frame(Frame::Resync(Resync { last_seq: 0 }))
        .is_empty());
}

#[test]
fn a_ping_gets_a_pong() {
    let r = rig("ping");
    assert_eq!(
        r.rc.handle_frame(Frame::Ping(Empty {})),
        vec![Frame::Pong(Empty {})]
    );
}

#[test]
fn the_relay_reports_the_viewer_count_in_an_armed_state_event() {
    let r = armed("viewers");
    r.rc.handle_frame(Frame::Event(EventFrame {
        seq: 0,
        body: EventBody::ArmedState(ArmedState {
            armed: true,
            expires_at_ms: None,
            viewers: Some(2),
        }),
    }));
    assert_eq!(r.rc.view().viewers, 2);
    r.rc.set_connected(false);
    assert_eq!(r.rc.view().viewers, 0);
}

// ---- actions ---------------------------------------------------------------------------------

#[test]
fn an_action_while_disarmed_is_rejected_as_disarmed() {
    let r = rig("act-disarmed");
    let res =
        r.rc.handle_action(action("act-0001-aaaa", ActionKind::Status, None));
    assert_eq!(
        (res.outcome, res.reason),
        (Outcome::Rejected, Some(RejectReason::Disarmed))
    );
}

#[test]
fn a_status_action_is_accepted_and_reports_the_state() {
    let r = armed("act-status");
    let res =
        r.rc.handle_action(action("act-0001-aaaa", ActionKind::Status, None));
    assert_eq!(
        (res.outcome, res.state),
        (Outcome::Accepted, Some(SessionState::Idle))
    );
    assert!(r.bridge.calls().is_empty());
}

#[test]
fn an_action_missing_its_prompt_id_is_rejected_as_malformed() {
    let r = armed("act-malformed");
    let res =
        r.rc.handle_action(action("act-0001-aaaa", ActionKind::Done, None));
    assert_eq!(res.reason, Some(RejectReason::Malformed));
    let res = r.rc.handle_action(action("x", ActionKind::Cancel, None));
    assert_eq!(res.reason, Some(RejectReason::Malformed));
}

#[test]
fn cancel_is_rejected_when_nothing_is_running() {
    let r = armed("act-cancel-idle");
    let res =
        r.rc.handle_action(action("act-0001-aaaa", ActionKind::Cancel, None));
    assert_eq!(res.reason, Some(RejectReason::InvalidState));
    assert!(r.bridge.calls().is_empty());
}

#[test]
fn cancel_while_running_is_accepted_as_requested_and_the_job_ends_only_on_status() {
    let r = armed("act-cancel");
    r.events.job_started(JobKind::RecordCopy);
    let res =
        r.rc.handle_action(action("act-0001-aaaa", ActionKind::Cancel, None));
    assert_eq!(res.outcome, Outcome::Accepted);
    assert_eq!(r.bridge.calls(), vec![AppAction::Cancel]);
    assert_eq!(r.rc.view().state, SessionState::Running);
    r.events.status(StatusReport::cancelled(None));
    assert_eq!(r.rc.view().state, SessionState::Cancelled);
}

#[test]
fn done_for_the_open_prompt_is_accepted_and_the_close_is_attributed_to_the_remote_user() {
    let r = armed("act-done");
    let id = open_watch_prompt(&r);
    let res =
        r.rc.handle_action(action("act-0001-aaaa", ActionKind::Done, Some(&id)));
    assert_eq!(res.outcome, Outcome::Accepted);
    assert_eq!(r.bridge.calls(), vec![AppAction::Done]);
    assert_eq!(
        r.rc.view().state,
        SessionState::AwaitingUser,
        "waits for the app to close it"
    );
    r.events.prompt_closed(CloseReason::AnsweredLocal);
    let closed = bodies(&r.rc.poll_outbound());
    assert!(matches!(
        closed.last().unwrap(),
        EventBody::PromptClosed {
            reason: CloseReason::AnsweredRemote,
            ..
        }
    ));
}

#[test]
fn a_local_press_with_no_remote_action_stays_answered_local() {
    let r = armed("local-press");
    open_watch_prompt(&r);
    r.events.prompt_closed(CloseReason::AnsweredLocal);
    let closed = bodies(&r.rc.poll_outbound());
    assert!(matches!(
        closed.last().unwrap(),
        EventBody::PromptClosed {
            reason: CloseReason::AnsweredLocal,
            ..
        }
    ));
}

#[test]
fn done_after_a_local_press_closed_the_prompt_is_rejected_as_stale() {
    let r = armed("act-stale");
    let id = open_watch_prompt(&r);
    r.events.prompt_closed(CloseReason::AnsweredLocal);
    let res =
        r.rc.handle_action(action("act-0001-aaaa", ActionKind::Done, Some(&id)));
    assert_eq!(res.reason, Some(RejectReason::StalePrompt));
    assert!(r.bridge.calls().is_empty());
}

#[test]
fn next_for_a_done_prompt_is_rejected_as_an_invalid_state() {
    let r = armed("act-wrong-kind");
    let id = open_watch_prompt(&r);
    let res =
        r.rc.handle_action(action("act-0001-aaaa", ActionKind::Next, Some(&id)));
    assert_eq!(res.reason, Some(RejectReason::InvalidState));
}

#[test]
fn an_action_the_app_cannot_apply_is_rejected_as_an_invalid_state() {
    let r = armed("act-not-applicable");
    r.events.job_started(JobKind::Simulated);
    r.bridge.answer(ApplyOutcome::NotApplicable);
    let res =
        r.rc.handle_action(action("act-0001-aaaa", ActionKind::Cancel, None));
    assert_eq!(res.reason, Some(RejectReason::InvalidState));
}

#[test]
fn a_duplicate_action_id_returns_the_original_result_and_is_never_applied_twice() {
    let r = armed("act-dup");
    r.events.job_started(JobKind::Simulated);
    let a =
        r.rc.handle_action(action("act-0001-aaaa", ActionKind::Cancel, None));
    let b =
        r.rc.handle_action(action("act-0001-aaaa", ActionKind::Cancel, None));
    assert_eq!(a, b);
    assert_eq!(r.bridge.calls().len(), 1);
}

#[test]
fn a_duplicate_of_a_rejected_action_returns_the_same_rejection() {
    let r = armed("act-dup-rej");
    let a =
        r.rc.handle_action(action("act-0001-aaaa", ActionKind::Cancel, None));
    r.events.job_started(JobKind::Simulated);
    let b =
        r.rc.handle_action(action("act-0001-aaaa", ActionKind::Cancel, None));
    assert_eq!((a.reason, a.clone()), (Some(RejectReason::InvalidState), b));
}

#[test]
fn a_sixth_action_within_the_same_instant_is_rate_limited_and_recovers_after_200_ms() {
    let r = armed("act-rate");
    let mut reasons = Vec::new();
    for i in 0..6 {
        let res = r.rc.handle_action(action(
            &format!("act-{i:04}-aaaa"),
            ActionKind::Status,
            None,
        ));
        reasons.push(res.reason);
    }
    assert_eq!(&reasons[..5], &[None, None, None, None, None]);
    assert_eq!(reasons[5], Some(RejectReason::RateLimited));
    r.clock.advance(200);
    let ok =
        r.rc.handle_action(action("act-0099-aaaa", ActionKind::Status, None));
    assert_eq!(ok.outcome, Outcome::Accepted);
}

#[test]
fn a_rate_limited_action_id_may_be_retried_later() {
    let r = armed("act-rate-retry");
    for i in 0..5 {
        r.rc.handle_action(action(
            &format!("act-{i:04}-aaaa"),
            ActionKind::Status,
            None,
        ));
    }
    let limited =
        r.rc.handle_action(action("act-0009-aaaa", ActionKind::Status, None));
    assert_eq!(limited.reason, Some(RejectReason::RateLimited));
    r.clock.advance(1_000);
    let again =
        r.rc.handle_action(action("act-0009-aaaa", ActionKind::Status, None));
    assert_eq!(again.outcome, Outcome::Accepted);
}

#[test]
fn an_action_after_the_session_expired_but_before_the_tick_is_rejected_as_expired() {
    let r = armed("act-expired");
    r.clock.advance(4 * HOUR);
    let res =
        r.rc.handle_action(action("act-0001-aaaa", ActionKind::Status, None));
    assert_eq!(res.reason, Some(RejectReason::Expired));
}

#[test]
fn an_action_while_the_install_is_revoked_is_rejected_as_locked() {
    let r = armed("act-locked");
    r.rc.set_locked(true);
    let res =
        r.rc.handle_action(action("act-0001-aaaa", ActionKind::Status, None));
    assert_eq!(res.reason, Some(RejectReason::Locked));
    r.rc.set_locked(false);
    let res =
        r.rc.handle_action(action("act-0002-aaaa", ActionKind::Status, None));
    assert_eq!(res.outcome, Outcome::Accepted);
}

#[test]
fn an_action_frame_is_answered_with_an_action_result_frame() {
    let r = armed("act-frame");
    let out = r.rc.handle_frame(Frame::Action(action(
        "act-0001-aaaa",
        ActionKind::Status,
        None,
    )));
    assert!(matches!(&out[0], Frame::ActionResult(res) if res.outcome == Outcome::Accepted));
}

#[test]
fn accepted_and_rejected_actions_are_audited_with_codes_only() {
    let r = armed("act-audit");
    r.events.job_started(JobKind::Simulated);
    r.rc.handle_action(action("act-0001-aaaa", ActionKind::Cancel, None));
    r.rc.handle_action(action("act-0002-aaaa", ActionKind::Done, Some("p-9")));
    let rows = r.audit.entries();
    let details: Vec<(AuditKind, Option<String>)> = rows
        .iter()
        .filter(|e| {
            matches!(
                e.kind,
                AuditKind::ActionAccepted | AuditKind::ActionRejected
            )
        })
        .map(|e| (e.kind, e.detail.clone()))
        .collect();
    assert_eq!(
        details,
        vec![
            (AuditKind::ActionAccepted, Some("cancel".to_string())),
            (
                AuditKind::ActionRejected,
                Some("done invalid-state".to_string())
            ),
        ]
    );
    for row in rows {
        assert!(deny::find_denied(&serde_json::to_value(&row).unwrap()).is_empty());
    }
}

#[test]
fn the_bridge_may_call_back_into_the_layer_from_apply_without_deadlocking() {
    use std::sync::OnceLock;
    struct Reentrant {
        events: OnceLock<AppEvents>,
    }
    impl AppBridge for Reentrant {
        fn apply(&self, action: AppAction) -> ApplyOutcome {
            if let (AppAction::Done, Some(e)) = (action, self.events.get()) {
                e.prompt_closed(CloseReason::AnsweredLocal);
                e.step(Step::Finishing);
            }
            ApplyOutcome::Applied
        }
    }
    let bridge = Arc::new(Reentrant {
        events: OnceLock::new(),
    });
    let dir = temp_dir("reentrant");
    let clock = Arc::new(ManualClock::new(START_MS));
    let deps = Deps::new(bridge.clone()).with_clock(clock);
    let rc = RemoteControl::new(test_config(&dir), deps).unwrap();
    bridge.events.set(rc.events()).ok().unwrap();
    rc.arm_default().unwrap();
    rc.set_connected(true);
    let ev = rc.events();
    ev.job_started(JobKind::RecordWatch);
    ev.prompt_opened(PromptSpec::new(
        Expects::Done,
        LabelId::FinishAndCheck,
        false,
    ));
    let id = bodies(&rc.poll_outbound())
        .iter()
        .find_map(|b| match b {
            EventBody::PromptOpened(p) => Some(p.prompt_id.clone()),
            _ => None,
        })
        .unwrap();
    let res = rc.handle_action(action("act-0001-aaaa", ActionKind::Done, Some(&id)));
    assert_eq!(res.outcome, Outcome::Accepted);
    assert_eq!(kinds(&rc.poll_outbound()), vec!["prompt-closed", "step"]);
}

#[test]
fn concurrent_emitters_and_actions_never_deadlock_or_lose_the_sequence() {
    let r = armed("threads");
    r.events.job_started(JobKind::RecordCopy);
    let mut handles = Vec::new();
    for t in 0..4u64 {
        let ev = r.events.clone();
        handles.push(std::thread::spawn(move || {
            for i in 0..200 {
                ev.progress(progress_fields(Step::Copying, (t * 200 + i) % 100));
                ev.step(Step::Copying);
            }
        }));
    }
    let rc = r.rc.clone();
    handles.push(std::thread::spawn(move || {
        for i in 0..200 {
            rc.handle_action(action(
                &format!("act-{i:04}-bbbb"),
                ActionKind::Status,
                None,
            ));
            rc.poll_outbound();
        }
    }));
    for h in handles {
        h.join().unwrap();
    }
    let frames = r.rc.handle_frame(Frame::Resync(Resync { last_seq: 0 }));
    match &frames[0] {
        Frame::ResyncResult(h) => assert_eq!(h.to_seq, 801),
        _ => panic!(),
    }
}

// ---- prompt timeout policy --------------------------------------------------------------------

#[test]
fn the_hold_policy_leaves_an_unanswered_prompt_open() {
    let r = armed("hold");
    open_watch_prompt(&r);
    r.clock.advance(2 * HOUR);
    r.rc.tick();
    assert_eq!(r.rc.view().state, SessionState::AwaitingUser);
    assert!(r.bridge.calls().is_empty());
}

#[test]
fn the_auto_cancel_policy_closes_the_prompt_as_timed_out_and_asks_the_app_to_cancel() {
    let r = rig_with("auto-cancel", |c| {
        c.prompt_timeout = PromptTimeout::AutoCancel { after_ms: 5 * MIN };
    });
    r.rc.arm_default().unwrap();
    r.rc.set_connected(true);
    open_watch_prompt(&r);
    r.clock.advance(5 * MIN - 1);
    r.rc.tick();
    assert!(r.bridge.calls().is_empty());
    r.clock.advance(1);
    r.rc.tick();
    assert_eq!(r.bridge.calls(), vec![AppAction::Cancel]);
    let closed = bodies(&r.rc.poll_outbound());
    assert!(matches!(
        closed.last().unwrap(),
        EventBody::PromptClosed {
            reason: CloseReason::TimedOut,
            ..
        }
    ));
    r.rc.tick();
    assert_eq!(r.bridge.calls().len(), 1, "only once");
}

// ---- connection and lock bookkeeping ----------------------------------------------------------

#[test]
fn connection_changes_and_locks_are_audited() {
    let r = rig("conn-audit");
    r.rc.arm_default().unwrap();
    r.rc.set_connected(true);
    r.rc.set_connected(true);
    r.rc.set_locked(true);
    r.rc.set_connected(false);
    r.rc.set_locked(false);
    let kinds: Vec<AuditKind> = r.audit.entries().iter().map(|e| e.kind).collect();
    assert_eq!(
        kinds,
        vec![
            AuditKind::Armed,
            AuditKind::ConnectionOpened,
            AuditKind::Locked,
            AuditKind::ConnectionClosed,
            AuditKind::Unlocked
        ]
    );
}

#[test]
fn reconnecting_discards_stale_unsent_frames_because_the_relay_resyncs() {
    let r = armed("reconnect");
    r.events.job_started(JobKind::Simulated);
    r.rc.set_connected(false);
    r.rc.set_connected(true);
    assert!(r.rc.poll_outbound().is_empty());
    let frames = r.rc.handle_frame(Frame::Resync(Resync { last_seq: 0 }));
    assert_eq!(kinds(&frames), vec!["job-started"]);
}
