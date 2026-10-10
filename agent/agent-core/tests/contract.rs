//! Runs the shared golden fixtures in `protocol/fixtures` against the Rust wire types.

use agent_core::deny::{find_denied, DENIED_KEYS};
use agent_core::wire::{decode, encode, EventBody, Frame, MAX_FRAME_BYTES};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

fn protocol_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../protocol")
}

fn fixtures(dir: &str) -> Vec<(String, String, Value)> {
    let mut out: Vec<_> = fs::read_dir(protocol_dir().join("fixtures").join(dir))
        .unwrap()
        .filter_map(|e| {
            let path = e.unwrap().path();
            if path.extension()? != "json" {
                return None;
            }
            let name = path.file_stem()?.to_string_lossy().into_owned();
            let text = fs::read_to_string(&path).unwrap();
            let json = serde_json::from_str(&text).unwrap();
            Some((name, text, json))
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    assert!(!out.is_empty(), "no fixtures in {dir}");
    out
}

#[test]
fn every_valid_fixture_decodes_and_round_trips_unchanged() {
    for (name, text, json) in fixtures("valid") {
        let frame = decode(&text).unwrap_or_else(|e| panic!("{name}: {e}"));
        let again: Value = serde_json::from_str(&encode(&frame).unwrap()).unwrap();
        assert_eq!(again, json, "{name} did not round-trip");
    }
}

#[test]
fn every_invalid_fixture_is_rejected() {
    for (name, text, _) in fixtures("invalid") {
        assert!(decode(&text).is_err(), "{name} was accepted");
    }
}

#[test]
fn every_lenient_fixture_is_accepted_and_normalised_as_expected() {
    for (name, _, json) in fixtures("lenient") {
        let input = serde_json::to_string(&json["input"]).unwrap();
        let frame = decode(&input).unwrap_or_else(|e| panic!("{name}: {e}"));
        if json["normalized"].is_null() {
            let seq = json["input"]["seq"].as_u64().unwrap();
            match frame {
                Frame::Event(e) => {
                    assert_eq!(e.seq, seq, "{name}");
                    assert_eq!(e.body, EventBody::Unknown, "{name}");
                }
                other => panic!("{name}: expected an event, got {}", other.type_name()),
            }
        } else {
            let again: Value = serde_json::from_str(&encode(&frame).unwrap()).unwrap();
            assert_eq!(again, json["normalized"], "{name}");
        }
    }
}

#[test]
fn a_frame_over_sixteen_kib_is_rejected_as_too_large() {
    let big = format!(
        r#"{{"v":1,"type":"ping","pad":"{}"}}"#,
        "x".repeat(MAX_FRAME_BYTES)
    );
    assert!(matches!(
        decode(&big),
        Err(agent_core::wire::WireError::FrameTooLarge)
    ));
}

#[test]
fn clean_fixtures_carry_no_path_drive_letter_or_forbidden_field() {
    for dir in ["valid", "pairing/valid"] {
        for (name, _, json) in fixtures(dir) {
            assert_eq!(find_denied(&json), vec![], "{dir}/{name}");
        }
    }
    for (name, _, json) in fixtures("lenient") {
        assert_eq!(find_denied(&json), vec![], "lenient/{name}");
    }
}

#[test]
fn the_scanner_flags_every_planted_leak() {
    for (name, _, json) in fixtures("deny") {
        assert!(
            !find_denied(&json).is_empty(),
            "deny/{name} was not flagged"
        );
    }
}

#[test]
fn the_rust_key_list_matches_the_shared_deny_list() {
    let text = fs::read_to_string(protocol_dir().join("deny-list.json")).unwrap();
    let json: Value = serde_json::from_str(&text).unwrap();
    let shared: Vec<&str> = json["keys"]
        .as_array()
        .unwrap()
        .iter()
        .map(|k| k.as_str().unwrap())
        .collect();
    assert_eq!(shared, DENIED_KEYS);
}
