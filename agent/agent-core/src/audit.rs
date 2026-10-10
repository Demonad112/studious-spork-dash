//! Local audit trail. Rows carry codes only: no paths, names or payloads.

use serde::Serialize;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

/// What happened.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AuditKind {
    Armed,
    Disarmed,
    ConnectionOpened,
    ConnectionClosed,
    ActionAccepted,
    ActionRejected,
    JobStarted,
    JobEnded,
    Locked,
    Unlocked,
}

/// One audit row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub at_ms: u64,
    pub kind: AuditKind,
    /// A kebab-case code such as a disarm reason, an action kind or a reject reason.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl AuditEntry {
    pub fn new(at_ms: u64, kind: AuditKind, detail: Option<&str>) -> Self {
        Self {
            at_ms,
            kind,
            detail: detail.map(str::to_string),
        }
    }
}

/// Receives audit rows. Implementations must never fail a job: swallow errors.
pub trait AuditSink: Send + Sync {
    fn record(&self, entry: &AuditEntry);
}

/// Drops every row. The default when the host does not want a local trail.
#[derive(Debug, Default, Clone, Copy)]
pub struct NullAuditSink;

impl AuditSink for NullAuditSink {
    fn record(&self, _entry: &AuditEntry) {}
}

/// Keeps rows in memory. Used by tests and by hosts that show a live view.
#[derive(Debug, Default)]
pub struct MemoryAuditSink {
    entries: Mutex<Vec<AuditEntry>>,
}

impl MemoryAuditSink {
    pub fn entries(&self) -> Vec<AuditEntry> {
        self.entries.lock().map(|e| e.clone()).unwrap_or_default()
    }
}

impl AuditSink for MemoryAuditSink {
    fn record(&self, entry: &AuditEntry) {
        if let Ok(mut e) = self.entries.lock() {
            e.push(entry.clone());
        }
    }
}

/// Appends JSON lines to `<dir>/remote-audit.jsonl`, rotating by size. The file and folder are
/// created on the first row, never before.
#[derive(Debug)]
pub struct JsonlAuditSink {
    dir: PathBuf,
    max_bytes: u64,
    keep: usize,
    state: Mutex<Option<(File, u64)>>,
}

const FILE_NAME: &str = "remote-audit.jsonl";

impl JsonlAuditSink {
    pub fn new(dir: impl Into<PathBuf>, max_bytes: u64, keep: usize) -> Self {
        Self {
            dir: dir.into(),
            max_bytes: max_bytes.max(256),
            keep,
            state: Mutex::new(None),
        }
    }

    fn path(&self, n: usize) -> PathBuf {
        if n == 0 {
            self.dir.join(FILE_NAME)
        } else {
            self.dir.join(format!("{FILE_NAME}.{n}"))
        }
    }

    fn open(&self) -> std::io::Result<(File, u64)> {
        fs::create_dir_all(&self.dir)?;
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.path(0))?;
        let len = file.metadata()?.len();
        Ok((file, len))
    }

    fn rotate(&self) {
        let _ = fs::remove_file(self.path(self.keep.max(1)));
        for n in (0..self.keep.max(1)).rev() {
            let _ = fs::rename(self.path(n), self.path(n + 1));
        }
    }

    fn write_line(&self, line: &str) -> std::io::Result<()> {
        let mut guard = self.state.lock().map_err(|_| std::io::ErrorKind::Other)?;
        if guard.is_none() {
            *guard = Some(self.open()?);
        }
        let needs_rotation = guard
            .as_ref()
            .is_some_and(|(_, len)| *len + line.len() as u64 > self.max_bytes && *len > 0);
        if needs_rotation {
            *guard = None;
            self.rotate();
            *guard = Some(self.open()?);
        }
        if let Some((file, len)) = guard.as_mut() {
            file.write_all(line.as_bytes())?;
            *len += line.len() as u64;
        }
        Ok(())
    }
}

impl AuditSink for JsonlAuditSink {
    fn record(&self, entry: &AuditEntry) {
        if let Ok(mut line) = serde_json::to_string(entry) {
            line.push('\n');
            let _ = self.write_line(&line);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("agent-core-audit-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn the_jsonl_sink_creates_nothing_until_the_first_row() {
        let dir = temp("lazy");
        let sink = JsonlAuditSink::new(&dir, 10_000, 2);
        assert!(!dir.exists());
        sink.record(&AuditEntry::new(1, AuditKind::Armed, Some("four-hours")));
        let text = fs::read_to_string(dir.join(FILE_NAME)).unwrap();
        assert_eq!(
            text,
            "{\"atMs\":1,\"kind\":\"armed\",\"detail\":\"four-hours\"}\n"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_jsonl_sink_rotates_by_size_and_keeps_a_fixed_number_of_files() {
        let dir = temp("rotate");
        let sink = JsonlAuditSink::new(&dir, 256, 2);
        for i in 0..40 {
            sink.record(&AuditEntry::new(
                i,
                AuditKind::ActionRejected,
                Some("rate-limited"),
            ));
        }
        assert!(dir.join(FILE_NAME).exists());
        assert!(dir.join(format!("{FILE_NAME}.1")).exists());
        assert!(dir.join(format!("{FILE_NAME}.2")).exists());
        assert!(!dir.join(format!("{FILE_NAME}.3")).exists());
        for n in 0..=2 {
            let len = fs::metadata(sink.path(n)).unwrap().len();
            assert!(len <= 256, "file {n} is {len} bytes");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_memory_sink_keeps_rows_in_order() {
        let sink = MemoryAuditSink::default();
        sink.record(&AuditEntry::new(1, AuditKind::Armed, None));
        sink.record(&AuditEntry::new(2, AuditKind::Disarmed, Some("local")));
        let kinds: Vec<_> = sink.entries().iter().map(|e| e.kind).collect();
        assert_eq!(kinds, vec![AuditKind::Armed, AuditKind::Disarmed]);
    }

    #[test]
    fn a_row_serialises_without_paths_or_forbidden_fields() {
        let entry = AuditEntry::new(7, AuditKind::ActionAccepted, Some("done"));
        let value = serde_json::to_value(&entry).unwrap();
        assert!(crate::deny::find_denied(&value).is_empty());
    }
}
