//! Authenticator app codes (TOTP, RFC 6238): six digits from a shared secret and
//! the time, new every 30 seconds. Once an account sets one up, every sign-in to
//! the dashboard and to tunnels asks for a code from the app, or one of its
//! recovery codes, each good once.

use hmac::{Hmac, KeyInit, Mac};
use rand::{Rng, RngCore};
use serde_json::Value;
use sha1::Sha1;

use crate::db::Db;
use crate::util::{now, sha256_hex};

const STEP: i64 = 30;
const DIGITS: u32 = 6;
/// Recovery codes made when an app is set up.
const RECOVERY_CODES: usize = 10;
const BASE32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

fn secret_key(subject: &str) -> String {
    format!("totp:{subject}")
}

fn pending_key(subject: &str) -> String {
    format!("totp_pending:{subject}")
}

fn recovery_key(subject: &str) -> String {
    format!("totp_recovery:{subject}")
}

fn used_key(subject: &str) -> String {
    format!("totp_used:{subject}")
}

/// True when `subject` ("admin" or an account ID) has an authenticator app set up.
pub fn enrolled(db: &Db, subject: &str) -> bool {
    db.setting(&secret_key(subject)).ok().flatten().is_some()
}

/// Starts setting up an app: a new secret, kept until it is confirmed.
pub fn start(db: &Db, subject: &str) -> anyhow::Result<String> {
    let mut raw = [0u8; 20];
    rand::rngs::OsRng.fill_bytes(&mut raw);
    let secret = base32(&raw);
    db.set_setting(&pending_key(subject), &secret)?;
    Ok(secret)
}

/// The link an authenticator app reads from the QR code.
pub fn uri(secret: &str, label: &str) -> String {
    let label: String = label
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || "@._-".contains(*c))
        .collect();
    format!("otpauth://totp/myTunnels:{label}?secret={secret}&issuer=myTunnels")
}

/// Finishes setting up with a code from the app; returns the recovery codes,
/// shown once, or `None` when the code is wrong.
pub fn confirm(db: &Db, subject: &str, code: &str) -> anyhow::Result<Option<Vec<String>>> {
    let Some(secret) = db.setting(&pending_key(subject))? else {
        return Ok(None);
    };
    let Some(step) = matching_step(&secret, code, now()) else {
        return Ok(None);
    };
    let codes: Vec<String> = (0..RECOVERY_CODES)
        .map(|_| {
            let n: u64 = rand::rngs::OsRng.gen_range(0..10_000_000_000);
            let digits = format!("{n:010}");
            format!("{}-{}", &digits[..5], &digits[5..])
        })
        .collect();
    let hashes: Vec<String> = codes.iter().map(|c| sha256_hex(&plain(c))).collect();
    db.set_setting(&secret_key(subject), &secret)?;
    db.set_setting(&recovery_key(subject), &serde_json::to_string(&hashes)?)?;
    db.set_setting(&used_key(subject), &step.to_string())?;
    db.delete_setting(&pending_key(subject))?;
    Ok(Some(codes))
}

/// Turns the app off for `subject`.
pub fn remove(db: &Db, subject: &str) -> anyhow::Result<()> {
    for key in [
        secret_key(subject),
        pending_key(subject),
        recovery_key(subject),
        used_key(subject),
    ] {
        db.delete_setting(&key)?;
    }
    Ok(())
}

/// Checks a code from the app, which works once, or a recovery code, which is
/// then used up.
pub fn verify(db: &Db, subject: &str, code: &str) -> bool {
    let Some(secret) = db.setting(&secret_key(subject)).ok().flatten() else {
        return false;
    };
    let entered = plain(code);
    if entered.len() == DIGITS as usize {
        let last: i64 = db
            .setting(&used_key(subject))
            .ok()
            .flatten()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        return match matching_step(&secret, &entered, now()) {
            Some(step) if step > last => db
                .set_setting(&used_key(subject), &step.to_string())
                .is_ok(),
            _ => false,
        };
    }
    let key = recovery_key(subject);
    let mut hashes: Vec<String> = db
        .setting(&key)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    let hash = sha256_hex(&entered);
    let Some(at) = hashes.iter().position(|h| *h == hash) else {
        return false;
    };
    hashes.remove(at);
    serde_json::to_string(&hashes)
        .ok()
        .is_some_and(|raw| db.set_setting(&key, &raw).is_ok())
}

/// The digits of a code, without spaces or dashes.
fn plain(code: &str) -> String {
    code.chars().filter(char::is_ascii_digit).collect()
}

/// The time step `code` belongs to, allowing one step either side for clock drift.
fn matching_step(secret: &str, code: &str, at: i64) -> Option<i64> {
    let code = plain(code);
    let key = unbase32(secret)?;
    let now = at / STEP;
    (now - 1..=now + 1).find(|&step| hotp(&key, step as u64) == code)
}

fn hotp(key: &[u8], counter: u64) -> String {
    let mut mac = Hmac::<Sha1>::new_from_slice(key).expect("HMAC takes a key of any length");
    mac.update(&counter.to_be_bytes());
    let hash = mac.finalize().into_bytes();
    let offset = (hash[19] & 0x0f) as usize;
    let value = u32::from_be_bytes([
        hash[offset] & 0x7f,
        hash[offset + 1],
        hash[offset + 2],
        hash[offset + 3],
    ]);
    format!("{:06}", value % 10u32.pow(DIGITS))
}

fn base32(bytes: &[u8]) -> String {
    let mut out = String::new();
    let (mut buffer, mut bits) = (0u32, 0u32);
    for &b in bytes {
        buffer = (buffer << 8) | u32::from(b);
        bits += 8;
        while bits >= 5 {
            out.push(BASE32[((buffer >> (bits - 5)) & 31) as usize] as char);
            bits -= 5;
        }
    }
    if bits > 0 {
        out.push(BASE32[((buffer << (5 - bits)) & 31) as usize] as char);
    }
    out
}

fn unbase32(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let (mut buffer, mut bits) = (0u32, 0u32);
    for c in text.bytes().filter(|c| *c != b'=') {
        let value = BASE32.iter().position(|&b| b == c.to_ascii_uppercase())? as u32;
        buffer = (buffer << 5) | value;
        bits += 5;
        if bits >= 8 {
            out.push((buffer >> (bits - 8)) as u8);
            bits -= 8;
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_rfc_test_vector() {
        // RFC 6238, SHA-1, secret "12345678901234567890", at 59 seconds.
        let key = b"12345678901234567890";
        assert_eq!(hotp(key, 59 / 30), "287082");
        let secret = base32(key);
        assert_eq!(unbase32(&secret).as_deref(), Some(&key[..]));
        assert_eq!(matching_step(&secret, "287082", 59), Some(1));
        assert_eq!(matching_step(&secret, "287082", 59 + 120), None);
    }

    #[test]
    fn links_name_the_issuer() {
        assert_eq!(
            uri("ABC", "kris@example.com"),
            "otpauth://totp/myTunnels:kris@example.com?secret=ABC&issuer=myTunnels"
        );
    }
}
