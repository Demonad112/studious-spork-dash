//! Transport-free layer of the remote console agent.
//!
//! Nothing here opens a socket or spawns a thread. A host embeds [`RemoteControl`], implements
//! [`AppBridge`], reports its job through [`AppEvents`], and lets a transport (see `agent-ws`)
//! move the frames.

pub mod actions;
pub mod arm;
pub mod audit;
pub mod bridge;
pub mod cleanup;
pub mod clock;
pub mod config;
pub mod deny;
pub mod error;
pub mod ids;
pub mod power;
pub mod remote;
pub mod ring;
pub mod secret;
pub mod sim;
pub mod state;
pub mod wire;

pub use arm::{ArmRequest, ArmTrigger, ArmTtl, DisarmReason, ManualArmTrigger};
pub use audit::{AuditEntry, AuditKind, AuditSink, JsonlAuditSink, MemoryAuditSink, NullAuditSink};
pub use bridge::{AppAction, AppBridge, ApplyOutcome, PromptSpec, StatusReport};
pub use cleanup::{Artifact, CleanupRegistry};
pub use clock::{Clock, ManualClock, SystemClock};
pub use config::{Config, PromptTimeout};
pub use error::{Error, Result};
pub use ids::{IdSource, SequentialIds, StdIds};
pub use power::{NoopPowerGuard, PowerGuard};
pub use remote::{AppEvents, Deps, RemoteControl, RemoteStatus};
pub use ring::{ReplayRing, ResyncPlan};
pub use secret::{MemorySecretStore, SecretStore, SecretString};
pub use sim::{SimScript, SimulatedAppBridge};
pub use state::{IllegalTransition, Machine};
pub use wire::*;
