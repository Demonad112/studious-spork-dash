//! Random identifiers for installs, sessions, jobs and prompts.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};

/// Produces identifiers. They are labels, not secrets: never derive a key from them.
pub trait IdSource: Send + Sync {
    /// 32 lowercase hex characters (128 bits).
    fn hex32(&self) -> String;
    /// A short prompt id, 1 to 32 characters of `[A-Za-z0-9-]`.
    fn prompt_id(&self) -> String;
}

/// Identifiers seeded from the standard library's per-process random keys.
#[derive(Debug, Default)]
pub struct StdIds {
    counter: AtomicU64,
}

impl StdIds {
    fn next_u64(&self) -> u64 {
        let n = self.counter.fetch_add(1, Ordering::Relaxed);
        let mut h = RandomState::new().build_hasher();
        h.write_u64(n);
        h.finish()
    }
}

impl IdSource for StdIds {
    fn hex32(&self) -> String {
        format!("{:016x}{:016x}", self.next_u64(), self.next_u64())
    }

    fn prompt_id(&self) -> String {
        format!("p-{:08x}", self.next_u64() as u32)
    }
}

/// Predictable identifiers for tests.
#[derive(Debug, Default)]
pub struct SequentialIds {
    counter: AtomicU64,
}

impl IdSource for SequentialIds {
    fn hex32(&self) -> String {
        format!("{:032x}", self.counter.fetch_add(1, Ordering::SeqCst) + 1)
    }

    fn prompt_id(&self) -> String {
        format!("p-{}", self.counter.fetch_add(1, Ordering::SeqCst) + 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn std_ids_are_32_hex_characters_and_differ() {
        let ids = StdIds::default();
        let a = ids.hex32();
        let b = ids.hex32();
        assert_eq!(a.len(), 32);
        assert!(a
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(a, b);
    }

    #[test]
    fn std_prompt_ids_fit_the_wire_pattern() {
        let id = StdIds::default().prompt_id();
        assert!(id.len() <= 32 && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-'));
    }

    #[test]
    fn sequential_ids_count_up() {
        let ids = SequentialIds::default();
        assert_eq!(ids.hex32(), "00000000000000000000000000000001");
        assert_eq!(ids.prompt_id(), "p-2");
    }
}
