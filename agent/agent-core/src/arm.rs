//! Arming: only a local gesture can switch remote control on.

use serde::Serialize;
use std::sync::Mutex;

/// How long remote control stays on once armed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ArmTtl {
    /// Four hours, the default.
    FourHours,
    TwelveHours,
    /// Until the current or next job ends.
    UntilJobEnds,
    /// An explicit number of milliseconds, still capped by the hard limit.
    Custom(u64),
}

impl ArmTtl {
    /// Milliseconds until expiry, capped at `hard_cap_ms`. `None` means "until the job ends",
    /// which the hard cap still bounds.
    pub fn resolve_ms(&self, hard_cap_ms: u64) -> Option<u64> {
        let ms = match self {
            ArmTtl::FourHours => 4 * 3_600_000,
            ArmTtl::TwelveHours => 12 * 3_600_000,
            ArmTtl::UntilJobEnds => return None,
            ArmTtl::Custom(ms) => *ms,
        };
        Some(ms.min(hard_cap_ms))
    }

    /// A kebab-case code for the audit log.
    pub fn code(&self) -> &'static str {
        match self {
            ArmTtl::FourHours => "four-hours",
            ArmTtl::TwelveHours => "twelve-hours",
            ArmTtl::UntilJobEnds => "until-job-ends",
            ArmTtl::Custom(_) => "custom",
        }
    }
}

/// A request to arm, produced by a local gesture.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArmRequest {
    pub ttl: ArmTtl,
}

/// Why remote control switched off.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DisarmReason {
    /// The local user switched it off.
    Local,
    /// The time chosen at arm time ran out.
    TtlExpired,
    /// Fifteen quiet minutes with no job running.
    Idle,
    /// The job ended and the host did not ask to stay armed.
    JobEnded,
    /// The control object was dropped, for example at app exit.
    Dropped,
}

impl DisarmReason {
    pub fn code(&self) -> &'static str {
        match self {
            DisarmReason::Local => "local",
            DisarmReason::TtlExpired => "ttl-expired",
            DisarmReason::Idle => "idle",
            DisarmReason::JobEnded => "job-ended",
            DisarmReason::Dropped => "dropped",
        }
    }
}

/// The host's switch. Implement it over a settings toggle or a button; the layer polls it from
/// `tick()`. There is deliberately no way to arm from a received frame.
pub trait ArmTrigger: Send + Sync {
    /// Returns a pending request once, then `None` until the user asks again.
    fn take_request(&self) -> Option<ArmRequest>;
}

/// A trigger the host (or a test) fires by hand.
#[derive(Debug, Default)]
pub struct ManualArmTrigger {
    pending: Mutex<Option<ArmRequest>>,
}

impl ManualArmTrigger {
    /// Records the user's gesture.
    pub fn request(&self, ttl: ArmTtl) {
        if let Ok(mut p) = self.pending.lock() {
            *p = Some(ArmRequest { ttl });
        }
    }
}

impl ArmTrigger for ManualArmTrigger {
    fn take_request(&self) -> Option<ArmRequest> {
        self.pending.lock().ok().and_then(|mut p| p.take())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: u64 = 24 * 3_600_000;

    #[test]
    fn the_preset_ttls_resolve_to_four_and_twelve_hours() {
        assert_eq!(ArmTtl::FourHours.resolve_ms(DAY), Some(4 * 3_600_000));
        assert_eq!(ArmTtl::TwelveHours.resolve_ms(DAY), Some(12 * 3_600_000));
    }

    #[test]
    fn a_custom_ttl_is_capped_at_the_hard_limit() {
        assert_eq!(ArmTtl::Custom(100 * DAY).resolve_ms(DAY), Some(DAY));
    }

    #[test]
    fn until_job_ends_has_no_fixed_expiry() {
        assert_eq!(ArmTtl::UntilJobEnds.resolve_ms(DAY), None);
    }

    #[test]
    fn a_manual_trigger_hands_out_each_request_once() {
        let t = ManualArmTrigger::default();
        assert_eq!(t.take_request(), None);
        t.request(ArmTtl::TwelveHours);
        assert_eq!(
            t.take_request(),
            Some(ArmRequest {
                ttl: ArmTtl::TwelveHours
            })
        );
        assert_eq!(t.take_request(), None);
    }
}
