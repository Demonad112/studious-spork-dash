//! The agent's identity: a random install id and an Ed25519 key pair. The private seed lives in
//! the host's [`SecretStore`]; the public half is what pairing sends to the relay.

use agent_core::{Error, Result, SecretStore, SecretString};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use sha2::{Digest, Sha256};

const INSTALL_ID: &str = "remote-console-install-id";
const SIGNING_KEY: &str = "remote-console-signing-key";

/// Who this install is. Cheap to clone; the key is zeroised by its own `Drop`.
#[derive(Clone)]
pub struct Identity {
    install_id: String,
    key: SigningKey,
}

impl std::fmt::Debug for Identity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Identity")
            .field("install_id", &self.install_id)
            .field("key", &"**redacted**")
            .finish()
    }
}

fn random<const N: usize>() -> Result<[u8; N]> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).map_err(|_| Error::Secret("no randomness".into()))?;
    Ok(bytes)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `n` random bytes as base64url, for nonces.
pub fn random_b64u<const N: usize>() -> Result<String> {
    Ok(URL_SAFE_NO_PAD.encode(random::<N>()?))
}

impl Identity {
    /// Reads the identity from the store, creating and saving one on first use.
    pub fn load_or_create(store: &dyn SecretStore) -> Result<Self> {
        let id = store.get(INSTALL_ID)?;
        let seed = store.get(SIGNING_KEY)?;
        if let (Some(id), Some(seed)) = (&id, &seed) {
            if let Some(identity) = Self::decode(id.expose(), seed.expose()) {
                return Ok(identity);
            }
        }
        Self::create(store)
    }

    /// Replaces the stored identity with a fresh one. The relay must be re-paired afterwards.
    pub fn create(store: &dyn SecretStore) -> Result<Self> {
        let install_id = hex(&random::<16>()?);
        let seed = random::<32>()?;
        store.set(INSTALL_ID, &SecretString::new(install_id.clone()))?;
        store.set(
            SIGNING_KEY,
            &SecretString::new(URL_SAFE_NO_PAD.encode(seed)),
        )?;
        Ok(Self {
            install_id,
            key: SigningKey::from_bytes(&seed),
        })
    }

    fn decode(install_id: &str, seed_b64u: &str) -> Option<Self> {
        let valid_id = install_id.len() == 32
            && install_id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        if !valid_id {
            return None;
        }
        let seed: [u8; 32] = URL_SAFE_NO_PAD.decode(seed_b64u).ok()?.try_into().ok()?;
        Some(Self {
            install_id: install_id.to_string(),
            key: SigningKey::from_bytes(&seed),
        })
    }

    /// 32 lowercase hex characters.
    pub fn install_id(&self) -> &str {
        &self.install_id
    }

    /// The raw 32-byte public key as base64url.
    pub fn public_key(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.key.verifying_key().to_bytes())
    }

    /// The first 8 bytes of SHA-256 of the public key as `xxxx-xxxx-xxxx-xxxx`. The owner
    /// compares it with the one the dashboard shows before approving.
    pub fn fingerprint(&self) -> String {
        let digest = Sha256::digest(self.key.verifying_key().to_bytes());
        let h = hex(&digest[..8]);
        format!("{}-{}-{}-{}", &h[0..4], &h[4..8], &h[8..12], &h[12..16])
    }

    /// Signs UTF-8 text and returns the 64-byte signature as base64url.
    pub fn sign(&self, message: &str) -> String {
        URL_SAFE_NO_PAD.encode(self.key.sign(message.as_bytes()).to_bytes())
    }
}

/// The string signed to answer the relay's challenge.
pub fn auth_message(install_id: &str, session_id: &str, nonce: &str, agent_nonce: &str) -> String {
    format!("agent-auth-v1|{install_id}|{session_id}|{nonce}|{agent_nonce}")
}

/// The string signed to ask how a pairing is going.
pub fn pair_status_message(install_id: &str, timestamp_ms: u64) -> String {
    format!("pair-status-v1|{install_id}|{timestamp_ms}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_core::MemorySecretStore;
    use ed25519_dalek::{Signature, Verifier};

    #[test]
    fn the_identity_is_created_once_and_then_reloaded() {
        let store = MemorySecretStore::default();
        let a = Identity::load_or_create(&store).unwrap();
        let b = Identity::load_or_create(&store).unwrap();
        assert_eq!(a.install_id(), b.install_id());
        assert_eq!(a.public_key(), b.public_key());
        assert_eq!(a.install_id().len(), 32);
        assert_eq!(a.public_key().len(), 43);
    }

    #[test]
    fn a_damaged_stored_identity_is_replaced() {
        let store = MemorySecretStore::default();
        store.set(INSTALL_ID, &SecretString::new("nope")).unwrap();
        store.set(SIGNING_KEY, &SecretString::new("nope")).unwrap();
        let id = Identity::load_or_create(&store).unwrap();
        assert_eq!(id.install_id().len(), 32);
        assert_eq!(
            store.get(INSTALL_ID).unwrap().unwrap().expose(),
            id.install_id()
        );
    }

    #[test]
    fn a_signature_verifies_against_the_published_public_key() {
        let id = Identity::load_or_create(&MemorySecretStore::default()).unwrap();
        let message = auth_message(id.install_id(), &"a".repeat(32), "n", "m");
        let sig = URL_SAFE_NO_PAD.decode(id.sign(&message)).unwrap();
        assert_eq!(sig.len(), 64);
        let public: [u8; 32] = URL_SAFE_NO_PAD
            .decode(id.public_key())
            .unwrap()
            .try_into()
            .unwrap();
        let verifying = ed25519_dalek::VerifyingKey::from_bytes(&public).unwrap();
        let sig = Signature::from_slice(&sig).unwrap();
        assert!(verifying.verify(message.as_bytes(), &sig).is_ok());
        assert!(verifying.verify(b"other", &sig).is_err());
    }

    #[test]
    fn the_fingerprint_has_four_groups_of_four_hex_digits() {
        let id = Identity::load_or_create(&MemorySecretStore::default()).unwrap();
        let f = id.fingerprint();
        let groups: Vec<&str> = f.split('-').collect();
        assert_eq!(groups.len(), 4);
        assert!(groups
            .iter()
            .all(|g| g.len() == 4 && g.bytes().all(|b| b.is_ascii_hexdigit())));
    }

    #[test]
    fn debug_output_never_shows_the_key() {
        let id = Identity::load_or_create(&MemorySecretStore::default()).unwrap();
        assert!(format!("{id:?}").contains("**redacted**"));
    }

    #[test]
    fn the_signed_messages_have_the_documented_shape() {
        assert_eq!(pair_status_message("i", 5), "pair-status-v1|i|5");
        assert_eq!(auth_message("i", "s", "n", "a"), "agent-auth-v1|i|s|n|a");
    }
}
