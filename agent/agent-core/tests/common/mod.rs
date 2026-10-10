#![allow(dead_code)]

use agent_core::*;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

static COUNTER: AtomicUsize = AtomicUsize::new(0);

pub fn temp_dir(tag: &str) -> PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    std::env::temp_dir().join(format!("agent-core-it-{tag}-{}-{n}", std::process::id()))
}

pub const START_MS: u64 = 1_790_000_000_000;

/// A bridge that records what it was asked and answers as configured.
pub struct TestBridge {
    pub applied: Mutex<Vec<AppAction>>,
    pub outcome: Mutex<ApplyOutcome>,
}

impl TestBridge {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            applied: Mutex::new(Vec::new()),
            outcome: Mutex::new(ApplyOutcome::Applied),
        })
    }

    pub fn calls(&self) -> Vec<AppAction> {
        self.applied.lock().unwrap().clone()
    }

    pub fn answer(&self, outcome: ApplyOutcome) {
        *self.outcome.lock().unwrap() = outcome;
    }
}

impl AppBridge for TestBridge {
    fn apply(&self, action: AppAction) -> ApplyOutcome {
        self.applied.lock().unwrap().push(action);
        *self.outcome.lock().unwrap()
    }
}

#[derive(Default)]
pub struct CountingPower {
    pub acquired: AtomicU32,
    pub released: AtomicU32,
}

impl PowerGuard for CountingPower {
    fn acquire(&self) {
        self.acquired.fetch_add(1, Ordering::SeqCst);
    }
    fn release(&self) {
        self.released.fetch_add(1, Ordering::SeqCst);
    }
}

pub struct Rig {
    pub clock: Arc<ManualClock>,
    pub audit: Arc<MemoryAuditSink>,
    pub bridge: Arc<TestBridge>,
    pub power: Arc<CountingPower>,
    pub rc: Arc<RemoteControl>,
    pub events: AppEvents,
    pub dir: PathBuf,
}

pub fn test_config(dir: &Path) -> Config {
    Config {
        enabled: true,
        relay_url: "wss://relay.example.workers.dev".into(),
        data_dir: dir.to_path_buf(),
        app_id: "test-app".into(),
        ..Config::default()
    }
}

pub fn rig_with(tag: &str, tweak: impl FnOnce(&mut Config)) -> Rig {
    let dir = temp_dir(tag);
    let mut config = test_config(&dir);
    tweak(&mut config);
    let clock = Arc::new(ManualClock::new(START_MS));
    let audit = Arc::new(MemoryAuditSink::default());
    let bridge = TestBridge::new();
    let power = Arc::new(CountingPower::default());
    let deps = Deps::new(bridge.clone())
        .with_clock(clock.clone())
        .with_ids(Arc::new(SequentialIds::default()))
        .with_audit(audit.clone())
        .with_power(power.clone());
    let rc = RemoteControl::new(config, deps).unwrap();
    let events = rc.events();
    Rig {
        clock,
        audit,
        bridge,
        power,
        rc,
        events,
        dir,
    }
}

pub fn rig(tag: &str) -> Rig {
    rig_with(tag, |_| {})
}

/// An armed, connected rig.
pub fn armed(tag: &str) -> Rig {
    let r = rig(tag);
    r.rc.arm_default().unwrap();
    r.rc.set_connected(true);
    r
}

pub fn progress_fields(step: Step, done: u64) -> ProgressFields {
    ProgressFields {
        step,
        percent: Some(done.min(100) as u8),
        files_done: done,
        files_total: Some(100),
        bytes_done: done,
        bytes_total: Some(100),
        ok: done,
        skipped: 0,
        failed: 0,
    }
}

pub fn action(id: &str, kind: ActionKind, prompt: Option<&str>) -> Action {
    Action {
        action_id: id.to_string(),
        action: kind,
        prompt_id: prompt.map(str::to_string),
    }
}

/// The event bodies in a batch of frames, in order.
pub fn bodies(frames: &[Frame]) -> Vec<EventBody> {
    frames
        .iter()
        .filter_map(|f| match f {
            Frame::Event(e) => Some(e.body.clone()),
            _ => None,
        })
        .collect()
}

pub fn kinds(frames: &[Frame]) -> Vec<String> {
    bodies(frames)
        .iter()
        .map(|b| {
            serde_json::to_value(b).unwrap()["kind"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect()
}
