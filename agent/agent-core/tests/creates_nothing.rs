//! With the feature off or the agent disarmed nothing is created: no files, no folders, no
//! threads. Linux counts threads through /proc.
//!
//! One test function runs every scenario in turn: the test harness runs separate tests on
//! parallel threads, which would make the thread count meaningless.

mod common;

use agent_core::*;
use common::*;
use std::fs;

fn thread_count() -> Option<usize> {
    fs::read_dir("/proc/self/task").ok().map(|d| d.count())
}

fn exercise(r: &Rig) {
    r.events.job_started(JobKind::RecordCopy);
    r.events.step(Step::Copying);
    r.events.progress(progress_fields(Step::Copying, 3));
    r.events.prompt_opened(PromptSpec::new(
        Expects::Done,
        LabelId::FinishAndCheck,
        false,
    ));
    r.events.prompt_closed(CloseReason::Auto);
    r.events.status(StatusReport::failed(FailureCode::Other));
    r.clock.advance(60_000);
    r.rc.tick();
    r.rc.poll_outbound();
    r.rc.handle_frame(Frame::Action(action(
        "act-0001-aaaa",
        ActionKind::Cancel,
        None,
    )));
    r.rc.handle_frame(Frame::Resync(Resync { last_seq: 0 }));
    r.rc.set_connected(true);
    r.rc.set_connected(false);
    let _ = r.rc.view();
    let _ = r.rc.snapshot();
}

#[test]
fn nothing_is_created_while_the_feature_is_off_or_the_agent_is_disarmed() {
    let before = thread_count();

    // Feature disabled.
    let r = rig_with("nothing-disabled", |c| c.enabled = false);
    exercise(&r);
    assert!(r.rc.arm_default().is_err());
    assert!(!r.dir.exists(), "disabled: data dir was created");
    assert_eq!(thread_count(), before, "disabled: threads were spawned");

    // Enabled but never armed.
    let r = rig("nothing-disarmed");
    exercise(&r);
    assert!(!r.rc.is_armed());
    assert!(!r.dir.exists(), "disarmed: data dir was created");
    assert!(
        r.audit.entries().is_empty(),
        "disarmed: something was audited"
    );
    assert_eq!(thread_count(), before, "disarmed: threads were spawned");

    // Armed and disarmed again with a real audit sink: only the audit file appears.
    let dir = temp_dir("nothing-armed");
    let clock = std::sync::Arc::new(ManualClock::new(START_MS));
    let sink = std::sync::Arc::new(JsonlAuditSink::new(&dir, 64 * 1024, 2));
    let deps = Deps::new(TestBridge::new())
        .with_clock(clock)
        .with_audit(sink);
    let rc = RemoteControl::new(test_config(&dir), deps).unwrap();
    assert!(!dir.exists(), "constructing created something");
    rc.handle_action(action("act-0001-aaaa", ActionKind::Status, None));
    assert!(
        !dir.exists(),
        "a rejected action while disarmed created something"
    );
    rc.arm_default().unwrap();
    rc.disarm(DisarmReason::Local);
    let names: Vec<String> = fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, vec!["remote-audit.jsonl".to_string()]);
    let text = fs::read_to_string(dir.join("remote-audit.jsonl")).unwrap();
    for line in text.lines() {
        let value: serde_json::Value = serde_json::from_str(line).unwrap();
        assert!(deny::find_denied(&value).is_empty(), "{line}");
    }
    assert_eq!(thread_count(), before, "armed: threads were spawned");
    let _ = fs::remove_dir_all(&dir);
}
