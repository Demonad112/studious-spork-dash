//! Configuration. Remote control is off unless the host switches it on.

use crate::arm::ArmTtl;
use crate::error::{Error, Result};
use std::path::PathBuf;

const HOUR_MS: u64 = 3_600_000;

/// What happens when a prompt stays open with nobody answering.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptTimeout {
    /// Keep waiting. The default.
    Hold,
    /// Close the prompt as `timed-out` and ask the app to cancel.
    AutoCancel { after_ms: u64 },
}

/// Settings for [`RemoteControl`](crate::RemoteControl).
#[derive(Debug, Clone)]
pub struct Config {
    /// Master switch. `false` by default; while `false` nothing is created and arming fails.
    pub enabled: bool,
    /// Short lowercase id of the host app, sent in `hello`.
    pub app_id: String,
    /// `wss://` URL of the relay. `ws://localhost` is accepted for development.
    pub relay_url: String,
    /// The only folder the agent writes to. The host passes it in; the agent never derives one.
    pub data_dir: PathBuf,
    /// TTL used when the host arms without choosing one.
    pub default_ttl: ArmTtl,
    /// Disarm after this long with no job running.
    pub idle_timeout_ms: u64,
    /// No session can outlive this, whatever TTL was chosen.
    pub hard_cap_ms: u64,
    pub prompt_timeout: PromptTimeout,
    /// Stay armed after a job ends instead of disarming.
    pub stay_armed_after_job: bool,
    /// Discrete events kept for replay.
    pub ring_capacity: usize,
    /// Most often a progress snapshot is sent.
    pub progress_interval_ms: u64,
    /// Actions allowed per second.
    pub action_rate_per_sec: u32,
    /// Action ids remembered to answer duplicates.
    pub dedup_capacity: usize,
    /// Hold the [`PowerGuard`](crate::PowerGuard) while armed.
    pub keep_awake_while_armed: bool,
    /// Rotate the audit log at this size.
    pub audit_max_bytes: u64,
    /// Rotated audit files to keep.
    pub audit_keep_files: usize,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: false,
            app_id: "app".to_string(),
            relay_url: String::new(),
            data_dir: PathBuf::new(),
            default_ttl: ArmTtl::FourHours,
            idle_timeout_ms: 15 * 60_000,
            hard_cap_ms: 24 * HOUR_MS,
            prompt_timeout: PromptTimeout::Hold,
            stay_armed_after_job: false,
            ring_capacity: 256,
            progress_interval_ms: 1_000,
            action_rate_per_sec: 5,
            dedup_capacity: 128,
            keep_awake_while_armed: false,
            audit_max_bytes: 256 * 1024,
            audit_keep_files: 2,
        }
    }
}

fn invalid(what: &str) -> Result<()> {
    Err(Error::InvalidConfig(what.to_string()))
}

impl Config {
    /// Checks every setting. A disabled configuration only needs sane limits.
    pub fn validate(&self) -> Result<()> {
        if !(8..=4096).contains(&self.ring_capacity) {
            return invalid("ring_capacity must be 8 to 4096");
        }
        if self.hard_cap_ms == 0 || self.hard_cap_ms > 24 * HOUR_MS {
            return invalid("hard_cap_ms must be 1 ms to 24 h");
        }
        if self.idle_timeout_ms < 1_000 {
            return invalid("idle_timeout_ms must be at least 1 s");
        }
        if self.progress_interval_ms < 100 {
            return invalid("progress_interval_ms must be at least 100 ms");
        }
        if !(1..=100).contains(&self.action_rate_per_sec) {
            return invalid("action_rate_per_sec must be 1 to 100");
        }
        if !(8..=4096).contains(&self.dedup_capacity) {
            return invalid("dedup_capacity must be 8 to 4096");
        }
        if let PromptTimeout::AutoCancel { after_ms } = self.prompt_timeout {
            if after_ms < 1_000 {
                return invalid("prompt timeout must be at least 1 s");
            }
        }
        let app_ok = !self.app_id.is_empty()
            && self.app_id.len() <= 32
            && self
                .app_id
                .bytes()
                .all(|b| b.is_ascii_digit() || b.is_ascii_lowercase() || b == b'-');
        if !app_ok {
            return invalid("app_id must be 1 to 32 characters of a-z, 0-9 and -");
        }
        if self.enabled {
            if self.data_dir.as_os_str().is_empty() {
                return invalid("data_dir is required when enabled");
            }
            let url = self.relay_url.as_str();
            let local = url.starts_with("ws://localhost") || url.starts_with("ws://127.0.0.1");
            if !(url.starts_with("wss://") || local) {
                return invalid("relay_url must be wss:// (ws://localhost for development)");
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn enabled() -> Config {
        Config {
            enabled: true,
            relay_url: "wss://relay.example.workers.dev".into(),
            data_dir: PathBuf::from("data"),
            ..Config::default()
        }
    }

    #[test]
    fn the_default_configuration_is_disabled_and_valid() {
        let c = Config::default();
        assert!(!c.enabled);
        assert!(c.validate().is_ok());
    }

    #[test]
    fn an_enabled_configuration_needs_a_relay_url_and_a_data_dir() {
        assert!(enabled().validate().is_ok());
        let mut c = enabled();
        c.relay_url = String::new();
        assert!(c.validate().is_err());
        let mut c = enabled();
        c.data_dir = PathBuf::new();
        assert!(c.validate().is_err());
    }

    #[test]
    fn a_plain_http_or_ws_relay_url_is_refused_except_for_localhost() {
        let mut c = enabled();
        c.relay_url = "ws://relay.example.com".into();
        assert!(c.validate().is_err());
        c.relay_url = "https://relay.example.com".into();
        assert!(c.validate().is_err());
        c.relay_url = "ws://localhost:8787".into();
        assert!(c.validate().is_ok());
    }

    #[test]
    fn limits_outside_their_ranges_are_refused() {
        let bad = [
            Config {
                ring_capacity: 2,
                ..enabled()
            },
            Config {
                hard_cap_ms: 25 * HOUR_MS,
                ..enabled()
            },
            Config {
                idle_timeout_ms: 10,
                ..enabled()
            },
            Config {
                progress_interval_ms: 10,
                ..enabled()
            },
            Config {
                action_rate_per_sec: 0,
                ..enabled()
            },
            Config {
                dedup_capacity: 1,
                ..enabled()
            },
            Config {
                app_id: "Has Space".into(),
                ..enabled()
            },
            Config {
                prompt_timeout: PromptTimeout::AutoCancel { after_ms: 5 },
                ..enabled()
            },
        ];
        for c in bad {
            assert!(c.validate().is_err(), "{c:?}");
        }
    }
}
