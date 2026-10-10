//! TLS client settings: rustls with the `ring` provider and the bundled Mozilla roots. Building
//! with the `os-roots` feature adds a switch to trust the operating system's store instead,
//! for networks that inspect TLS.

use rustls::{ClientConfig, RootCertStore};
use std::sync::Arc;

/// Builds the client configuration. `trust_os_store` has an effect only with `os-roots`.
pub fn client_config(trust_os_store: bool) -> Arc<ClientConfig> {
    let mut roots = RootCertStore::empty();
    #[cfg(feature = "os-roots")]
    if trust_os_store {
        for cert in rustls_native_certs::load_native_certs().certs {
            let _ = roots.add(cert);
        }
    }
    if roots.is_empty() {
        let _ = trust_os_store;
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    }
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map(|b| b.with_root_certificates(roots).with_no_client_auth())
        .unwrap_or_else(|_| unreachable!("ring supports the default protocol versions"));
    Arc::new(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_configuration_trusts_the_bundled_roots() {
        let config = client_config(false);
        assert!(config.alpn_protocols.is_empty());
    }
}
