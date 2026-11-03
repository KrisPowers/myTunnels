//! Passwords: hashing, checking, and the strength every password here must have.

use std::sync::OnceLock;

use anyhow::{anyhow, Result};
use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;

use crate::util::sha256_hex;

pub const RULE: &str = "Use 10 or more characters with upper and lower case, a number and a symbol";

pub fn hash(password: &str) -> Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| anyhow!("could not hash password: {e}"))
}

pub fn verify(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash).is_ok_and(|parsed| {
        Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok()
    })
}

/// Checks against `hash`, or against a stand-in when there is none, so a wrong
/// account name takes as long to refuse as a wrong password.
pub fn verify_or_waste(password: &str, hash: Option<&str>) -> bool {
    static STAND_IN: OnceLock<String> = OnceLock::new();
    match hash {
        Some(hash) => verify(password, hash),
        None => {
            let stand_in = STAND_IN.get_or_init(|| self::hash("stand-in").unwrap_or_default());
            let _ = verify(password, stand_in);
            false
        }
    }
}

/// 10 or more characters with upper and lower case, a number and a symbol.
pub fn strong(p: &str) -> bool {
    p.chars().count() >= 10
        && p.chars().any(|c| c.is_uppercase())
        && p.chars().any(|c| c.is_lowercase())
        && p.chars().any(|c| c.is_ascii_digit())
        && p.chars().any(|c| !c.is_ascii_alphanumeric())
}

/// A short mark of a hash. Sessions carry it, so changing a password ends them.
pub fn tag(hash: &str) -> String {
    sha256_hex(hash)[..16].to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passwords_need_length_case_number_and_symbol() {
        assert!(strong("Homelab-2026"));
        assert!(!strong("Homelab2026"));
        assert!(!strong("homelab-2026"));
        assert!(!strong("HOMELAB-2026"));
        assert!(!strong("Homelab-ab"));
        assert!(!strong("Hl-2026"));
    }

    #[test]
    fn hashes_verify_and_tags_differ() {
        let a = hash("Homelab-2026").unwrap();
        assert!(verify("Homelab-2026", &a));
        assert!(!verify("homelab-2026", &a));
        assert!(!verify_or_waste("anything", None));
        assert_ne!(tag(&a), tag(&hash("Homelab-2026").unwrap()));
    }
}
