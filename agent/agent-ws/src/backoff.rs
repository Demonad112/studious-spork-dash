//! Reconnect delays: exponential with jitter, so a restarted relay is not hit by every agent at
//! the same moment.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::time::Duration;

/// A random number in `0..bound` (`bound` of 0 gives 0). Not for secrets.
pub fn jitter(bound: u64) -> u64 {
    if bound == 0 {
        return 0;
    }
    RandomState::new().build_hasher().finish() % bound
}

/// Doubles from `min` up to `max`. Each delay is spread over its upper half.
#[derive(Debug, Clone)]
pub struct Backoff {
    min_ms: u64,
    max_ms: u64,
    next_ms: u64,
}

impl Backoff {
    pub fn new(min: Duration, max: Duration) -> Self {
        let min_ms = (min.as_millis() as u64).max(1);
        let max_ms = (max.as_millis() as u64).max(min_ms);
        Self {
            min_ms,
            max_ms,
            next_ms: min_ms,
        }
    }

    /// The delay to wait now. The next call waits up to twice as long, up to the maximum.
    pub fn next_delay(&mut self) -> Duration {
        let base = self.next_ms;
        self.next_ms = (self.next_ms.saturating_mul(2)).min(self.max_ms);
        Duration::from_millis(base / 2 + jitter(base / 2 + 1))
    }

    /// A healthy connection happened: start again from the minimum.
    pub fn reset(&mut self) {
        self.next_ms = self.min_ms;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delays_grow_and_stay_inside_their_window() {
        let mut b = Backoff::new(Duration::from_secs(1), Duration::from_secs(8));
        let windows = [(500, 1_000), (1_000, 2_000), (2_000, 4_000), (4_000, 8_000)];
        for (lo, hi) in windows {
            let d = b.next_delay().as_millis() as u64;
            assert!((lo..=hi).contains(&d), "{d} not in {lo}..={hi}");
        }
        for _ in 0..20 {
            let d = b.next_delay().as_millis() as u64;
            assert!((4_000..=8_000).contains(&d));
        }
    }

    #[test]
    fn reset_starts_again_from_the_minimum() {
        let mut b = Backoff::new(Duration::from_secs(1), Duration::from_secs(60));
        for _ in 0..5 {
            b.next_delay();
        }
        b.reset();
        assert!(b.next_delay() <= Duration::from_secs(1));
    }

    #[test]
    fn jitter_stays_below_its_bound() {
        assert_eq!(jitter(0), 0);
        for _ in 0..100 {
            assert!(jitter(7) < 7);
        }
    }
}
