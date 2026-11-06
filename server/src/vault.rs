//! Secrets at rest: the Cloudflare and tunnel tokens, SMTP and OAuth credentials
//! and the session signing key are sealed in the database with a key kept outside
//! it, so a copy of the data volume or a backup of it does not give them away.

use std::path::Path;

use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use rand::RngCore;

/// Marks a sealed value, and which way it was sealed.
const PREFIX: &str = "enc1:";

/// Settings that hold a secret.
pub fn is_secret(key: &str) -> bool {
    matches!(key, "cf_token" | "cf_tunnel_token" | "smtp" | "token_key")
        || key.starts_with("oauth_")
}

pub fn is_sealed(value: &str) -> bool {
    value.starts_with(PREFIX)
}

pub struct Vault(ChaCha20Poly1305);

impl Vault {
    pub fn new(key: &[u8; 32]) -> Self {
        Self(ChaCha20Poly1305::new(Key::from_slice(key)))
    }

    /// Seals `value`, bound to the setting `name` it is stored under.
    pub fn seal(&self, name: &str, value: &str) -> Result<String> {
        let mut nonce = [0u8; 12];
        rand::rngs::OsRng.fill_bytes(&mut nonce);
        let sealed = self
            .0
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: value.as_bytes(),
                    aad: name.as_bytes(),
                },
            )
            .map_err(|_| anyhow::anyhow!("cannot seal {name}"))?;
        let mut out = nonce.to_vec();
        out.extend(sealed);
        Ok(format!("{PREFIX}{}", B64.encode(out)))
    }

    /// The value sealed under `name`, or `None` if another key sealed it.
    pub fn open(&self, name: &str, value: &str) -> Option<String> {
        let raw = B64.decode(value.strip_prefix(PREFIX)?).ok()?;
        if raw.len() < 12 {
            return None;
        }
        let (nonce, sealed) = raw.split_at(12);
        let plain = self
            .0
            .decrypt(
                Nonce::from_slice(nonce),
                Payload {
                    msg: sealed,
                    aad: name.as_bytes(),
                },
            )
            .ok()?;
        String::from_utf8(plain).ok()
    }
}

/// The key from `SECRET_KEY` (64 hex digits), or from the key file, made on
/// first start.
pub fn load_key(file: &Path) -> Result<[u8; 32]> {
    if let Ok(hex_key) = std::env::var("SECRET_KEY") {
        if !hex_key.trim().is_empty() {
            return parse(&hex_key).context("SECRET_KEY must be 64 hex digits");
        }
    }
    match std::fs::read_to_string(file) {
        Ok(text) => parse(&text).with_context(|| format!("{} is not a key", file.display())),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            let mut key = [0u8; 32];
            rand::rngs::OsRng.fill_bytes(&mut key);
            if let Some(dir) = file.parent().filter(|d| !d.as_os_str().is_empty()) {
                std::fs::create_dir_all(dir)
                    .with_context(|| format!("cannot create {}", dir.display()))?;
            }
            write_private(file, &hex::encode(key))
                .with_context(|| format!("cannot write {}", file.display()))?;
            tracing::info!("made the secrets key at {}", file.display());
            Ok(key)
        }
        Err(err) => Err(err).with_context(|| format!("cannot read {}", file.display())),
    }
}

fn parse(text: &str) -> Result<[u8; 32]> {
    let bytes = hex::decode(text.trim())?;
    match <[u8; 32]>::try_from(bytes.as_slice()) {
        Ok(key) => Ok(key),
        Err(_) => bail!("wrong length"),
    }
}

/// Writes a file only its owner can read.
fn write_private(file: &Path, text: &str) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(file)?;
        f.write_all(text.as_bytes())
    }
    #[cfg(not(unix))]
    {
        std::fs::write(file, text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seals_and_opens_only_under_its_name_and_key() {
        let vault = Vault::new(&[7; 32]);
        let sealed = vault.seal("cf_token", "secret").unwrap();
        assert!(is_sealed(&sealed));
        assert_eq!(vault.open("cf_token", &sealed).as_deref(), Some("secret"));
        assert_eq!(vault.open("smtp", &sealed), None);
        assert_eq!(Vault::new(&[8; 32]).open("cf_token", &sealed), None);
    }

    #[test]
    fn knows_which_settings_are_secret() {
        assert!(is_secret("cf_token"));
        assert!(is_secret("oauth_github"));
        assert!(!is_secret("cf_account_id"));
    }
}
