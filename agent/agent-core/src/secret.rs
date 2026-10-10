//! Secrets never print: `SecretString` redacts itself in `Debug` and `Display`.

use crate::error::{Error, Result};
use std::collections::HashMap;
use std::fmt;
use std::sync::Mutex;

/// A string that must not reach logs. `Debug` prints `**redacted**`.
#[derive(Clone, PartialEq, Eq)]
pub struct SecretString(String);

impl SecretString {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// The only way to read the value. Call it at the point of use and let it go.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SecretString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "**redacted**")
    }
}

impl fmt::Display for SecretString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "**redacted**")
    }
}

/// Where the agent keeps its private key. The host supplies a DPAPI-backed store on Windows.
pub trait SecretStore: Send + Sync {
    fn get(&self, name: &str) -> Result<Option<SecretString>>;
    fn set(&self, name: &str, value: &SecretString) -> Result<()>;
    fn remove(&self, name: &str) -> Result<()>;
}

/// A store that lives only as long as the process.
#[derive(Debug, Default)]
pub struct MemorySecretStore {
    items: Mutex<HashMap<String, SecretString>>,
}

impl SecretStore for MemorySecretStore {
    fn get(&self, name: &str) -> Result<Option<SecretString>> {
        let items = self
            .items
            .lock()
            .map_err(|_| Error::Secret("poisoned".into()))?;
        Ok(items.get(name).cloned())
    }

    fn set(&self, name: &str, value: &SecretString) -> Result<()> {
        let mut items = self
            .items
            .lock()
            .map_err(|_| Error::Secret("poisoned".into()))?;
        items.insert(name.to_string(), value.clone());
        Ok(())
    }

    fn remove(&self, name: &str) -> Result<()> {
        let mut items = self
            .items
            .lock()
            .map_err(|_| Error::Secret("poisoned".into()))?;
        items.remove(name);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_secret_prints_as_redacted_in_debug_and_display() {
        let s = SecretString::new("hunter2");
        assert_eq!(format!("{s:?}"), "**redacted**");
        assert_eq!(format!("{s}"), "**redacted**");
        assert_eq!(s.expose(), "hunter2");
    }

    #[test]
    fn a_secret_inside_a_struct_stays_redacted_in_debug() {
        #[derive(Debug)]
        struct Holder {
            #[allow(dead_code)]
            key: SecretString,
        }
        let text = format!(
            "{:?}",
            Holder {
                key: SecretString::new("hunter2")
            }
        );
        assert!(!text.contains("hunter2"));
        assert!(text.contains("**redacted**"));
    }

    #[test]
    fn the_memory_store_round_trips_and_removes() {
        let store = MemorySecretStore::default();
        assert_eq!(store.get("k").unwrap(), None);
        store.set("k", &SecretString::new("v")).unwrap();
        assert_eq!(store.get("k").unwrap().unwrap().expose(), "v");
        store.remove("k").unwrap();
        assert_eq!(store.get("k").unwrap(), None);
    }
}
