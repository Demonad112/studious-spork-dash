//! Simulated host app for the remote console.
//!
//! ```text
//! agent-sim pair [--relay ws://localhost:8787] [--data-dir .agent-sim]
//! agent-sim run <script> [--relay ...] [--data-dir ...]
//! ```
//!
//! `pair` enrols this install with a relay and waits for the owner to approve the code in the
//! dashboard. `run` arms the layer, plays one simulated script and prints what the transport
//! does. It is a development tool: the key lives in a plain file under the data folder.

mod file_store;

use agent_core::{Clock, SessionState};
use agent_core::{
    Config, Deps, JsonlAuditSink, RemoteControl, SimScript, SimulatedAppBridge, SystemClock,
};
use agent_ws::pairing::{pair_start, pair_status};
use agent_ws::{AgentWs, Identity, PairStatus, TransportEvent, WsConfig};
use file_store::FileSecretStore;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::{Duration, Instant};

const DEFAULT_RELAY: &str = "ws://localhost:8787";
const DEFAULT_DATA_DIR: &str = ".agent-sim";

struct Options {
    relay: String,
    data_dir: PathBuf,
}

fn usage() -> ExitCode {
    let names: Vec<&str> = SimScript::ALL.iter().map(|s| s.name()).collect();
    eprintln!("usage: agent-sim pair [options]");
    eprintln!("       agent-sim run <script> [options]");
    eprintln!("scripts: {}", names.join(", "));
    eprintln!("options: --relay <ws or wss url> (default {DEFAULT_RELAY})");
    eprintln!("         --data-dir <folder>     (default {DEFAULT_DATA_DIR})");
    ExitCode::from(2)
}

fn parse(args: &[String]) -> Option<(Options, Vec<String>)> {
    let mut options = Options {
        relay: DEFAULT_RELAY.to_string(),
        data_dir: PathBuf::from(DEFAULT_DATA_DIR),
    };
    let mut rest = Vec::new();
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--relay" => options.relay = it.next()?.clone(),
            "--data-dir" => options.data_dir = PathBuf::from(it.next()?),
            other if other.starts_with("--") => return None,
            other => rest.push(other.to_string()),
        }
    }
    Some((options, rest))
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some((command, args)) = args.split_first() else {
        return usage();
    };
    let Some((options, rest)) = parse(args) else {
        return usage();
    };
    match (command.as_str(), rest.as_slice()) {
        ("pair", []) => pair(&options),
        ("run", [script]) => match SimScript::parse(script) {
            Some(script) => run(&options, script),
            None => usage(),
        },
        _ => usage(),
    }
}

fn identity(options: &Options) -> Result<Identity, ExitCode> {
    let store = FileSecretStore::new(options.data_dir.clone());
    Identity::load_or_create(&store).map_err(|e| {
        eprintln!("cannot load the identity: {e}");
        ExitCode::FAILURE
    })
}

fn pair(options: &Options) -> ExitCode {
    let identity = match identity(options) {
        Ok(i) => i,
        Err(code) => return code,
    };
    let start = match pair_start(&options.relay, &identity) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("pairing failed: {e}");
            return ExitCode::FAILURE;
        }
    };
    println!("Pairing code : {}", start.pairing_code);
    println!("Fingerprint  : {}", start.fingerprint);
    println!(
        "Approve it in the dashboard within {} minutes, after checking that the fingerprint matches.",
        start.expires_in_sec / 60
    );
    let deadline = Instant::now() + Duration::from_secs(start.expires_in_sec);
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_secs(2));
        match pair_status(&options.relay, &identity, SystemClock.now_ms()) {
            Ok(PairStatus::Pending) => {}
            Ok(PairStatus::Approved) => {
                println!("Paired.");
                return ExitCode::SUCCESS;
            }
            Ok(PairStatus::Expired) => {
                eprintln!("The code expired.");
                return ExitCode::FAILURE;
            }
            Ok(PairStatus::Rejected) => {
                eprintln!("The owner rejected the pairing.");
                return ExitCode::FAILURE;
            }
            Err(e) => eprintln!("status check failed: {e}"),
        }
    }
    eprintln!("Gave up waiting.");
    ExitCode::FAILURE
}

fn describe(event: &TransportEvent) -> String {
    match event {
        TransportEvent::Connecting => "connecting".to_string(),
        TransportEvent::Authenticated => "authenticated".to_string(),
        TransportEvent::Disconnected(reason) => format!("disconnected ({reason})"),
        TransportEvent::Waiting(ms) => format!("retrying in {ms} ms"),
    }
}

fn run(options: &Options, script: SimScript) -> ExitCode {
    let identity = match identity(options) {
        Ok(i) => i,
        Err(code) => return code,
    };
    let config = Config {
        enabled: true,
        app_id: "agent-sim".to_string(),
        relay_url: options.relay.clone(),
        data_dir: options.data_dir.clone(),
        ..Config::default()
    };
    let bridge = SimulatedAppBridge::new(script);
    let audit = JsonlAuditSink::new(
        options.data_dir.clone(),
        config.audit_max_bytes,
        config.audit_keep_files,
    );
    let rc = match RemoteControl::new(
        config,
        Deps::new(bridge.clone()).with_audit(Arc::new(audit)),
    ) {
        Ok(rc) => rc,
        Err(e) => {
            eprintln!("cannot start: {e}");
            return ExitCode::FAILURE;
        }
    };
    bridge.attach(rc.events());
    let observer: Arc<dyn Fn(TransportEvent) + Send + Sync> =
        Arc::new(|event| println!("[transport] {}", describe(&event)));
    let ws = AgentWs::install(rc.clone(), identity, WsConfig::default(), Some(observer));
    match rc.arm_default() {
        Ok(_) => println!("[app] armed, playing {}", script.name()),
        Err(e) => {
            eprintln!("cannot arm: {e}");
            return ExitCode::FAILURE;
        }
    }
    let mut last_state = SessionState::Idle;
    let mut ticks = 0u64;
    loop {
        std::thread::sleep(Duration::from_millis(100));
        bridge.tick();
        ticks += 1;
        if ticks % 10 == 0 {
            rc.tick();
        }
        let state = rc.view().state;
        if state != last_state {
            println!("[app] state {state:?}");
            last_state = state;
        }
        if bridge.is_finished() && !rc.is_armed() {
            break;
        }
    }
    let disarmed_at = Instant::now();
    if ws.wait_stopped(Duration::from_secs(2)) {
        println!(
            "[transport] stopped {} ms after disarm",
            disarmed_at.elapsed().as_millis()
        );
        ExitCode::SUCCESS
    } else {
        eprintln!("[transport] still running 2 s after disarm");
        ExitCode::FAILURE
    }
}
