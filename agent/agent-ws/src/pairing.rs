//! Enrolment over HTTP. The agent asks the relay for a pairing code, the owner approves it in
//! the dashboard, and the agent learns the outcome by polling with a signed request.

use crate::identity::{pair_status_message, Identity};
use serde::Deserialize;
use serde_json::json;
use std::fmt;
use std::time::Duration;

/// Where a pairing stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairStatus {
    Pending,
    Approved,
    Expired,
    Rejected,
}

/// What the owner needs to see on screen to approve.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingStart {
    pub pairing_code: String,
    pub fingerprint: String,
    pub expires_in_sec: u64,
}

/// Why a pairing call failed. Codes only, never response text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairError {
    /// The relay URL is not usable.
    BadUrl,
    /// No answer from the relay.
    Network,
    /// The relay refused with this code (for example `already-paired` or `rate-limited`).
    Refused { status: u16, code: String },
    /// The relay answered with something that is not a pairing body.
    Protocol,
}

impl fmt::Display for PairError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PairError::BadUrl => write!(f, "the relay URL is not usable"),
            PairError::Network => write!(f, "the relay did not answer"),
            PairError::Refused { status, code } => write!(f, "refused ({status}): {code}"),
            PairError::Protocol => write!(f, "unexpected answer from the relay"),
        }
    }
}

impl std::error::Error for PairError {}

/// `wss://host` becomes `https://host`; `ws://localhost:8787` becomes `http://localhost:8787`.
pub fn http_base(relay_url: &str) -> Result<String, PairError> {
    let trimmed = relay_url.trim_end_matches('/');
    if let Some(rest) = trimmed.strip_prefix("wss://") {
        Ok(format!("https://{rest}"))
    } else if let Some(rest) = trimmed.strip_prefix("ws://") {
        Ok(format!("http://{rest}"))
    } else {
        Err(PairError::BadUrl)
    }
}

fn post(base: &str, path: &str, body: serde_json::Value) -> Result<String, PairError> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(10)))
        .build()
        .into();
    let mut response = agent
        .post(format!("{base}{path}"))
        .header("content-type", "application/json")
        .send(body.to_string())
        .map_err(|_| PairError::Network)?;
    let status = response.status().as_u16();
    let text = response
        .body_mut()
        .read_to_string()
        .map_err(|_| PairError::Network)?;
    if (200..300).contains(&status) {
        return Ok(text);
    }
    #[derive(Deserialize)]
    struct Failure {
        error: String,
    }
    let code = serde_json::from_str::<Failure>(&text)
        .ok()
        .map(|f| f.error)
        .filter(|c| c.len() <= 32 && c.bytes().all(|b| b.is_ascii_lowercase() || b == b'-'))
        .unwrap_or_else(|| "unknown".to_string());
    Err(PairError::Refused { status, code })
}

/// Registers the public key and returns the code to show.
pub fn pair_start(relay_url: &str, identity: &Identity) -> Result<PairingStart, PairError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Result_ {
        kind: String,
        pairing_code: String,
        fingerprint: String,
        expires_in_sec: u64,
    }
    let body = json!({
        "kind": "pair-start",
        "installId": identity.install_id(),
        "publicKey": identity.public_key(),
    });
    let text = post(&http_base(relay_url)?, "/pair/start", body)?;
    let r: Result_ = serde_json::from_str(&text).map_err(|_| PairError::Protocol)?;
    if r.kind != "pair-start-result" {
        return Err(PairError::Protocol);
    }
    Ok(PairingStart {
        pairing_code: r.pairing_code,
        fingerprint: r.fingerprint,
        expires_in_sec: r.expires_in_sec,
    })
}

/// Asks how the pairing is going. The request is signed, so only the key holder can ask.
pub fn pair_status(
    relay_url: &str,
    identity: &Identity,
    now_ms: u64,
) -> Result<PairStatus, PairError> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Result_ {
        kind: String,
        status: String,
    }
    let body = json!({
        "kind": "pair-status",
        "installId": identity.install_id(),
        "timestampMs": now_ms,
        "signature": identity.sign(&pair_status_message(identity.install_id(), now_ms)),
    });
    let text = post(&http_base(relay_url)?, "/pair/status", body)?;
    let r: Result_ = serde_json::from_str(&text).map_err(|_| PairError::Protocol)?;
    if r.kind != "pair-status-result" {
        return Err(PairError::Protocol);
    }
    match r.status.as_str() {
        "pending" => Ok(PairStatus::Pending),
        "approved" => Ok(PairStatus::Approved),
        "expired" => Ok(PairStatus::Expired),
        "rejected" => Ok(PairStatus::Rejected),
        _ => Err(PairError::Protocol),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn websocket_urls_map_to_http_urls() {
        assert_eq!(http_base("wss://r.example/").unwrap(), "https://r.example");
        assert_eq!(
            http_base("ws://localhost:8787").unwrap(),
            "http://localhost:8787"
        );
        assert_eq!(http_base("https://r.example"), Err(PairError::BadUrl));
    }
}
