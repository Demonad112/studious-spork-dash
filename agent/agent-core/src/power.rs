//! Keeps the PC awake for a session that must outlive a job. A no-op for most hosts.

/// Held while armed when [`Config::keep_awake_while_armed`](crate::Config) is set.
pub trait PowerGuard: Send + Sync {
    fn acquire(&self);
    fn release(&self);
}

/// Does nothing. The default.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoopPowerGuard;

impl PowerGuard for NoopPowerGuard {
    fn acquire(&self) {}
    fn release(&self) {}
}
