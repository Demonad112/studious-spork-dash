//! Anything persistent the agent ever creates is registered here so it can be removed.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

/// Something the agent created on disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Artifact {
    File(PathBuf),
    Dir(PathBuf),
}

/// Tracks artifacts and removes them on disarm, and sweeps stale leftovers of a crashed run.
#[derive(Debug, Default)]
pub struct CleanupRegistry {
    items: Mutex<Vec<Artifact>>,
}

impl CleanupRegistry {
    /// Remembers an artifact for later removal.
    pub fn register(&self, artifact: Artifact) {
        if let Ok(mut items) = self.items.lock() {
            if !items.contains(&artifact) {
                items.push(artifact);
            }
        }
    }

    /// How many artifacts are registered.
    pub fn len(&self) -> usize {
        self.items.lock().map(|i| i.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Removes every registered artifact, newest first, and forgets them. Returns how many were
    /// actually removed. Failures are swallowed: cleanup must never block a disarm.
    pub fn run(&self) -> usize {
        let items = match self.items.lock() {
            Ok(mut i) => std::mem::take(&mut *i),
            Err(_) => return 0,
        };
        let mut removed = 0;
        for item in items.into_iter().rev() {
            let ok = match &item {
                Artifact::File(p) => fs::remove_file(p).is_ok(),
                Artifact::Dir(p) => fs::remove_dir_all(p).is_ok(),
            };
            removed += usize::from(ok);
        }
        removed
    }

    /// Deletes files in `dir` whose names start with `prefix` and that were last modified more
    /// than `max_age` before `now`. Returns how many were deleted.
    pub fn sweep_stale(dir: &Path, prefix: &str, max_age: Duration, now: SystemTime) -> usize {
        let Ok(entries) = fs::read_dir(dir) else {
            return 0;
        };
        let mut removed = 0;
        for entry in entries.flatten() {
            let name = entry.file_name();
            if !name.to_string_lossy().starts_with(prefix) {
                continue;
            }
            let stale = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|m| now.duration_since(m).ok())
                .is_some_and(|age| age > max_age);
            if stale && entry.path().is_file() && fs::remove_file(entry.path()).is_ok() {
                removed += 1;
            }
        }
        removed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;

    fn temp(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("agent-core-clean-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn running_the_registry_removes_files_and_folders_and_forgets_them() {
        let dir = temp("run");
        let file = dir.join("a.tmp");
        let sub = dir.join("sub");
        File::create(&file).unwrap();
        fs::create_dir_all(&sub).unwrap();
        let reg = CleanupRegistry::default();
        reg.register(Artifact::File(file.clone()));
        reg.register(Artifact::File(file.clone()));
        reg.register(Artifact::Dir(sub.clone()));
        assert_eq!(reg.len(), 2);
        assert_eq!(reg.run(), 2);
        assert!(!file.exists() && !sub.exists());
        assert!(reg.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn running_the_registry_tolerates_artifacts_that_are_already_gone() {
        let reg = CleanupRegistry::default();
        reg.register(Artifact::File(PathBuf::from(
            "/nonexistent/never-there.tmp",
        )));
        assert_eq!(reg.run(), 0);
    }

    #[test]
    fn the_stale_sweep_only_removes_old_files_with_the_prefix() {
        let dir = temp("sweep");
        let old = dir.join("rc-old.tmp");
        let fresh = dir.join("rc-fresh.tmp");
        let other = dir.join("keep-old.tmp");
        for p in [&old, &fresh, &other] {
            File::create(p).unwrap();
        }
        let long_ago = SystemTime::now() - Duration::from_secs(7200);
        File::options()
            .write(true)
            .open(&old)
            .unwrap()
            .set_modified(long_ago)
            .unwrap();
        File::options()
            .write(true)
            .open(&other)
            .unwrap()
            .set_modified(long_ago)
            .unwrap();
        let removed =
            CleanupRegistry::sweep_stale(&dir, "rc-", Duration::from_secs(3600), SystemTime::now());
        assert_eq!(removed, 1);
        assert!(!old.exists() && fresh.exists() && other.exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
