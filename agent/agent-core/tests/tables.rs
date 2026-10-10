//! Runs the shared behaviour tables in `protocol/fixtures` against the Rust implementations.

use agent_core::actions::decide;
use agent_core::state::Machine;
use agent_core::wire::*;
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

fn load(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../protocol/fixtures")
        .join(name);
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

fn state_of(code: &str) -> SessionState {
    serde_json::from_value(Value::String(code.to_string())).unwrap()
}

fn body_of(event: &Value) -> EventBody {
    let mut wire = event.clone();
    let obj = wire.as_object_mut().unwrap();
    obj.insert("v".into(), 1.into());
    obj.insert("type".into(), "event".into());
    obj.insert("seq".into(), 1.into());
    match decode(&wire.to_string()).unwrap() {
        Frame::Event(e) => e.body,
        other => panic!("not an event: {}", other.type_name()),
    }
}

#[test]
fn the_state_machine_agrees_with_the_shared_table() {
    let table = load("state-machine.json");
    let cases = table["cases"].as_array().unwrap();
    assert!(cases.len() >= 73, "table shrank to {}", cases.len());
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let mut m = Machine::new();
        for (i, step) in case["steps"].as_array().unwrap().iter().enumerate() {
            let result = m.apply(&body_of(&step["event"]));
            let expect = &step["expect"];
            assert_eq!(
                result.is_ok(),
                expect["ok"].as_bool().unwrap(),
                "{name} step {i}"
            );
            assert_eq!(
                m.state(),
                state_of(expect["state"].as_str().unwrap()),
                "{name} step {i}"
            );
        }
    }
}

#[test]
fn the_action_allowlist_agrees_with_the_shared_table() {
    let table = load("action-rules.json");
    let cases = table["cases"].as_array().unwrap();
    assert!(cases.len() >= 22, "table shrank to {}", cases.len());
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let action = Action {
            action_id: "act-0001-abcd".into(),
            action: serde_json::from_value(case["action"]["action"].clone()).unwrap(),
            prompt_id: case["action"]["promptId"].as_str().map(str::to_string),
        };
        let prompt = (!case["prompt"].is_null()).then(|| PromptObject {
            prompt_id: case["prompt"]["promptId"].as_str().unwrap().to_string(),
            expects: serde_json::from_value(case["prompt"]["expects"].clone()).unwrap(),
            label_id: LabelId::Other,
            blocking: false,
            text: None,
        });
        let issued: Vec<&str> = case["issued"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        let got = decide(
            &action,
            state_of(case["state"].as_str().unwrap()),
            prompt.as_ref(),
            |p| issued.contains(&p),
        );
        let expected = case["expect"].as_str().unwrap();
        match got {
            Ok(()) => assert_eq!(expected, "accepted", "{name}"),
            Err(reason) => {
                let code = serde_json::to_value(reason).unwrap();
                assert_eq!(code.as_str().unwrap(), expected, "{name}");
            }
        }
    }
}
