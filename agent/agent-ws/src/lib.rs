//! Outbound WebSocket transport for the remote console agent.
//!
//! [`AgentWs::install`] hooks into [`agent_core::RemoteControl`]. While the layer is disarmed
//! nothing exists here: no thread, no socket. Arming starts one thread with its own
//! current-thread runtime; disarming makes it close the socket and exit. [`pairing`] is the
//! one-off HTTP side of enrolment.

pub mod backoff;
pub mod identity;
pub mod pairing;
pub mod tls;
pub mod transport;

pub use identity::Identity;
pub use pairing::{PairError, PairStatus, PairingStart};
pub use transport::{AgentWs, TransportEvent, WsConfig};
