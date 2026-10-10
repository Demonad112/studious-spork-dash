//! Data-minimisation scanner: finds paths, drive letters and forbidden field names in JSON.
//!
//! The key list mirrors `protocol/deny-list.json`, which the TypeScript scanner reads directly;
//! a test keeps the two in step.

use serde_json::Value;

/// Field names that must never appear in any event, fixture, log or audit row.
pub const DENIED_KEYS: &[&str] = &[
    "path",
    "paths",
    "relativePath",
    "file",
    "fileName",
    "filename",
    "current",
    "folder",
    "source",
    "destination",
    "hostname",
    "host",
    "machine",
    "machineName",
    "computerName",
    "user",
    "userName",
    "username",
    "client",
    "ticket",
    "technician",
    "runId",
    "errorText",
    "errorMessage",
    "message",
    "hash",
];

/// What a finding is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Why {
    ForbiddenKey,
    PathSeparator,
    DriveLetter,
}

/// One place where data would leak.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    pub at: String,
    pub why: Why,
}

fn has_drive_letter(s: &str) -> bool {
    let b = s.as_bytes();
    (0..b.len().saturating_sub(1)).any(|i| {
        b[i].is_ascii_alphabetic()
            && b[i + 1] == b':'
            && (i == 0 || !b[i - 1].is_ascii_alphanumeric())
    })
}

/// True when `s` contains a path separator or a drive letter.
pub fn looks_like_path(s: &str) -> bool {
    s.contains('/') || s.contains('\\') || has_drive_letter(s)
}

/// Returns every place in `value` that would leak a path, a drive letter or a forbidden field.
pub fn find_denied(value: &Value) -> Vec<Finding> {
    let mut out = Vec::new();
    walk(value, "$", &mut out);
    out
}

fn walk(value: &Value, at: &str, out: &mut Vec<Finding>) {
    match value {
        Value::String(s) => {
            if s.contains('/') || s.contains('\\') {
                out.push(Finding {
                    at: at.to_string(),
                    why: Why::PathSeparator,
                });
            } else if has_drive_letter(s) {
                out.push(Finding {
                    at: at.to_string(),
                    why: Why::DriveLetter,
                });
            }
        }
        Value::Array(items) => {
            for (i, item) in items.iter().enumerate() {
                walk(item, &format!("{at}[{i}]"), out);
            }
        }
        Value::Object(map) => {
            for (k, v) in map {
                let here = format!("{at}.{k}");
                if DENIED_KEYS.contains(&k.as_str()) {
                    out.push(Finding {
                        at: here.clone(),
                        why: Why::ForbiddenKey,
                    });
                }
                walk(v, &here, out);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_clean_event_has_no_findings() {
        assert!(
            find_denied(&json!({"v":1,"type":"event","seq":3,"kind":"step","step":"copying"}))
                .is_empty()
        );
    }

    #[test]
    fn a_windows_path_a_unix_path_and_a_drive_letter_are_flagged() {
        assert_eq!(
            find_denied(&json!({"text":"D:\\reports"}))[0].why,
            Why::PathSeparator
        );
        assert_eq!(
            find_denied(&json!({"text":"/etc/x"}))[0].why,
            Why::PathSeparator
        );
        assert_eq!(
            find_denied(&json!({"text":"D:report"}))[0].why,
            Why::DriveLetter
        );
    }

    #[test]
    fn a_forbidden_key_is_flagged_even_with_a_harmless_value() {
        let found = find_denied(&json!({"nested":[{"hostname":"x"}]}));
        assert_eq!(
            found,
            vec![Finding {
                at: "$.nested[0].hostname".into(),
                why: Why::ForbiddenKey
            }]
        );
    }

    #[test]
    fn a_letter_colon_inside_a_word_is_not_a_drive_letter() {
        assert!(!has_drive_letter("step1: ok"));
        assert!(!has_drive_letter("ab:cd"));
        assert!(has_drive_letter("see c:"));
    }
}
