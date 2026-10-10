//! A simulated host app that behaves like the real one described in `docs/host-profile.md`.
//!
//! [`SimulatedAppBridge`] plays one named script. Call [`tick`](SimulatedAppBridge::tick) once per
//! 100 ms of (simulated) time: tests drive it with a [`ManualClock`](crate::ManualClock), the
//! `agent-sim` binary drives it with real sleeps.

use crate::bridge::{AppAction, AppBridge, ApplyOutcome, PromptSpec, StatusReport};
use crate::remote::AppEvents;
use crate::wire::*;
use std::sync::{Arc, Mutex, OnceLock};

const FILES: u64 = 200;
const BYTES: u64 = 2_000_000_000;
const TICK_MS: u64 = 100;

/// The behaviours the simulator reproduces.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SimScript {
    /// Watch mode; the remote user presses Finish; not every file arrived.
    WatchFinish,
    /// Watch mode; every file arrives and the app finishes by itself.
    WatchAuto,
    /// Watch mode; the local user finishes first, so a later remote Finish is stale.
    WatchLocalFinish,
    /// Copy mode to 100 percent with no prompt.
    Copy,
    /// Copy mode that fails before copying: not enough space.
    CopyFail,
    /// Copy mode that is cancelled remotely part-way.
    CancelMidway,
    /// A blocking pre-flight prompt before copying.
    PreflightNext,
}

impl SimScript {
    pub const ALL: [SimScript; 7] = [
        SimScript::WatchFinish,
        SimScript::WatchAuto,
        SimScript::WatchLocalFinish,
        SimScript::Copy,
        SimScript::CopyFail,
        SimScript::CancelMidway,
        SimScript::PreflightNext,
    ];

    /// The script's kebab-case name, as used on the `agent-sim` command line.
    pub fn name(&self) -> &'static str {
        match self {
            SimScript::WatchFinish => "watch-finish",
            SimScript::WatchAuto => "watch-auto",
            SimScript::WatchLocalFinish => "watch-local-finish",
            SimScript::Copy => "copy",
            SimScript::CopyFail => "copy-fail",
            SimScript::CancelMidway => "cancel-midway",
            SimScript::PreflightNext => "preflight-next",
        }
    }

    pub fn parse(name: &str) -> Option<SimScript> {
        SimScript::ALL.into_iter().find(|s| s.name() == name)
    }

    fn is_watch(&self) -> bool {
        matches!(
            self,
            SimScript::WatchFinish | SimScript::WatchAuto | SimScript::WatchLocalFinish
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Start,
    Listing,
    Preflight,
    Watching,
    Finishing(u32),
    Copying,
    Cancelling(u32),
    Finished,
}

struct SimState {
    phase: Phase,
    ticks: u64,
    found: u64,
    arrived: u64,
    watch_ticks: u64,
    finish_requested: bool,
    next_requested: bool,
    cancel_requested: bool,
    prompt_open: bool,
}

/// Plays a [`SimScript`] against the layer.
pub struct SimulatedAppBridge {
    events: OnceLock<AppEvents>,
    script: SimScript,
    state: Mutex<SimState>,
}

fn progress(step: Step, found: u64, arrived: u64, known: bool) -> ProgressFields {
    if !known {
        return ProgressFields {
            step,
            percent: None,
            files_done: found,
            files_total: None,
            bytes_done: 0,
            bytes_total: None,
            ok: 0,
            skipped: 0,
            failed: 0,
        };
    }
    let done_bytes = BYTES / FILES * arrived;
    ProgressFields {
        step,
        percent: Some((arrived * 100 / FILES) as u8),
        files_done: arrived,
        files_total: Some(FILES),
        bytes_done: done_bytes,
        bytes_total: Some(BYTES),
        ok: arrived,
        skipped: 0,
        failed: 0,
    }
}

fn summary(ok: u64, failed: u64, ticks: u64) -> Summary {
    Summary {
        files_planned: FILES,
        bytes_planned: BYTES,
        ok,
        ok_bytes: BYTES / FILES * ok,
        skipped: 0,
        failed,
        failed_bytes: BYTES / FILES * failed,
        duration_ms: ticks * TICK_MS,
    }
}

impl SimulatedAppBridge {
    /// Creates the simulator. Call [`attach`](Self::attach) once the layer exists: the layer holds
    /// the bridge and the bridge holds a handle back to the layer.
    pub fn new(script: SimScript) -> Arc<Self> {
        Arc::new(Self {
            events: OnceLock::new(),
            script,
            state: Mutex::new(SimState {
                phase: Phase::Start,
                ticks: 0,
                found: 0,
                arrived: 0,
                watch_ticks: 0,
                finish_requested: false,
                next_requested: false,
                cancel_requested: false,
                prompt_open: false,
            }),
        })
    }

    /// Connects the simulator to the layer's event handle. Only the first call counts.
    pub fn attach(&self, events: AppEvents) {
        let _ = self.events.set(events);
    }

    pub fn script(&self) -> SimScript {
        self.script
    }

    /// True once the script has reported its final status.
    pub fn is_finished(&self) -> bool {
        self.state
            .lock()
            .map(|s| s.phase == Phase::Finished)
            .unwrap_or(true)
    }

    /// Models the local user pressing "Finish and check" in the app itself.
    pub fn press_local_finish(&self) {
        let Some(e) = self.events.get() else {
            return;
        };
        if let Ok(mut s) = self.state.lock() {
            if s.phase == Phase::Watching && s.prompt_open {
                s.prompt_open = false;
                s.phase = Phase::Finishing(0);
                e.prompt_closed(CloseReason::AnsweredLocal);
                e.step(Step::Finishing);
            }
        }
    }

    /// Advances the script by 100 ms of simulated time. Returns true when it has finished.
    pub fn tick(&self) -> bool {
        let Some(e) = self.events.get() else {
            return false;
        };
        let Ok(mut s) = self.state.lock() else {
            return true;
        };
        if s.phase == Phase::Finished {
            return true;
        }
        s.ticks += 1;
        if s.cancel_requested && !matches!(s.phase, Phase::Cancelling(_) | Phase::Start) {
            s.phase = Phase::Cancelling(3);
        }
        match s.phase {
            Phase::Start => {
                let kind = if self.script.is_watch() {
                    JobKind::RecordWatch
                } else {
                    JobKind::RecordCopy
                };
                e.job_started(kind);
                e.step(Step::ListingSource);
                s.phase = Phase::Listing;
            }
            Phase::Listing => {
                s.found += FILES / 10;
                e.progress(progress(Step::ListingSource, s.found, 0, false));
                let list_ticks = if self.script == SimScript::CopyFail {
                    3
                } else {
                    10
                };
                if self.script == SimScript::CopyFail && s.found >= FILES / 10 * list_ticks {
                    e.status(StatusReport::failed(FailureCode::NotEnoughSpace));
                    s.phase = Phase::Finished;
                } else if s.found >= FILES {
                    e.step(Step::Done);
                    self.after_listing(e, &mut s);
                }
            }
            Phase::Preflight => {
                if s.next_requested {
                    s.prompt_open = false;
                    e.prompt_closed(CloseReason::AnsweredLocal);
                    e.step(Step::Copying);
                    s.phase = Phase::Copying;
                }
            }
            Phase::Watching => self.tick_watching(e, &mut s),
            Phase::Finishing(n) => {
                e.progress(progress(Step::Finishing, 0, s.arrived, true));
                if n >= 2 {
                    let failed = FILES - s.arrived;
                    let ticks = s.ticks;
                    let ok = s.arrived;
                    e.status(StatusReport::completed(summary(ok, failed, ticks)));
                    s.phase = Phase::Finished;
                } else {
                    s.phase = Phase::Finishing(n + 1);
                }
            }
            Phase::Copying => self.tick_copying(e, &mut s),
            Phase::Cancelling(n) => {
                e.progress(progress(Step::Copying, 0, s.arrived, true));
                if n <= 1 {
                    let ticks = s.ticks;
                    let ok = s.arrived;
                    e.status(StatusReport::cancelled(Some(summary(ok, 0, ticks))));
                    s.phase = Phase::Finished;
                } else {
                    s.phase = Phase::Cancelling(n - 1);
                }
            }
            Phase::Finished => {}
        }
        s.phase == Phase::Finished
    }

    fn after_listing(&self, e: &AppEvents, s: &mut SimState) {
        match self.script {
            SimScript::PreflightNext => {
                e.prompt_opened(PromptSpec::new(Expects::Next, LabelId::Continue, true));
                s.prompt_open = true;
                s.phase = Phase::Preflight;
            }
            sc if sc.is_watch() => {
                e.step(Step::Watching);
                e.progress(progress(Step::Watching, 0, 0, true));
                e.prompt_opened(PromptSpec::new(
                    Expects::Done,
                    LabelId::FinishAndCheck,
                    false,
                ));
                s.prompt_open = true;
                s.phase = Phase::Watching;
            }
            _ => {
                e.step(Step::Copying);
                s.phase = Phase::Copying;
            }
        }
    }

    fn tick_watching(&self, e: &AppEvents, s: &mut SimState) {
        s.watch_ticks += 1;
        let limit = if self.script == SimScript::WatchAuto {
            FILES
        } else {
            FILES - 10
        };
        s.arrived = (s.arrived + 5).min(limit);
        e.progress(progress(Step::Watching, 0, s.arrived, true));
        let finish = match self.script {
            SimScript::WatchFinish => s.finish_requested.then_some(CloseReason::AnsweredLocal),
            SimScript::WatchAuto => (s.arrived >= FILES).then_some(CloseReason::Auto),
            _ => (s.watch_ticks >= 5).then_some(CloseReason::AnsweredLocal),
        };
        if let Some(reason) = finish {
            s.prompt_open = false;
            e.prompt_closed(reason);
            e.step(Step::Finishing);
            s.phase = Phase::Finishing(0);
        }
    }

    fn tick_copying(&self, e: &AppEvents, s: &mut SimState) {
        let ceiling = if self.script == SimScript::CancelMidway {
            FILES * 40 / 100
        } else {
            FILES
        };
        s.arrived = (s.arrived + FILES / 20).min(ceiling);
        e.progress(progress(Step::Copying, 0, s.arrived, true));
        if s.arrived >= FILES {
            let ticks = s.ticks;
            e.status(StatusReport::completed(summary(FILES, 0, ticks)));
            s.phase = Phase::Finished;
        }
    }
}

impl AppBridge for SimulatedAppBridge {
    fn apply(&self, action: AppAction) -> ApplyOutcome {
        let Ok(mut s) = self.state.lock() else {
            return ApplyOutcome::NotApplicable;
        };
        let running = !matches!(s.phase, Phase::Start | Phase::Finished);
        match action {
            AppAction::Done if s.phase == Phase::Watching && s.prompt_open => {
                s.finish_requested = true;
                ApplyOutcome::Applied
            }
            AppAction::Next if s.phase == Phase::Preflight && s.prompt_open => {
                s.next_requested = true;
                ApplyOutcome::Applied
            }
            AppAction::Cancel if running => {
                s.cancel_requested = true;
                ApplyOutcome::Applied
            }
            _ => ApplyOutcome::NotApplicable,
        }
    }
}
