//! Signed session tokens: JSON Web Tokens with HS256. The key is made on first start
//! and kept in the database, so sessions survive a restart and nothing has to be set up.

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// The only header accepted, so a token can never name another algorithm or "none".
const HEADER: &str = r#"{"alg":"HS256","typ":"JWT"}"#;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Claims {
    /// This token's own ID, for signing it out alone.
    pub jti: String,
    /// What it opens: admin, device, pass or user.
    pub kind: String,
    /// Whose it is: a device, tunnel or account ID.
    pub sub: String,
    /// Stops it working once the password it was opened with changes.
    #[serde(default)]
    pub tag: String,
    /// The hash of the device key it was opened on, if bound to one.
    #[serde(default)]
    pub dev: String,
    /// Opened with an emailed code as well.
    #[serde(default)]
    pub mfa: bool,
    pub iat: i64,
    pub exp: i64,
}

fn mac(key: &[u8]) -> HmacSha256 {
    HmacSha256::new_from_slice(key).expect("HMAC takes a key of any length")
}

pub fn sign(key: &[u8], claims: &Claims) -> String {
    let body = serde_json::to_vec(claims).unwrap_or_default();
    let message = format!("{}.{}", B64.encode(HEADER), B64.encode(body));
    let mut m = mac(key);
    m.update(message.as_bytes());
    format!("{message}.{}", B64.encode(m.finalize().into_bytes()))
}

/// The claims of a token signed with `key` that has not expired.
pub fn verify(key: &[u8], token: &str, now: i64) -> Option<Claims> {
    let (message, signature) = token.rsplit_once('.')?;
    let (header, body) = message.split_once('.')?;
    if B64.decode(header).ok()? != HEADER.as_bytes() {
        return None;
    }
    let mut m = mac(key);
    m.update(message.as_bytes());
    m.verify_slice(&B64.decode(signature).ok()?).ok()?;
    let claims: Claims = serde_json::from_slice(&B64.decode(body).ok()?).ok()?;
    (claims.exp > now).then_some(claims)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claims() -> Claims {
        Claims {
            jti: "j".into(),
            kind: "user".into(),
            sub: "u1".into(),
            tag: "t".into(),
            dev: String::new(),
            mfa: false,
            iat: 100,
            exp: 200,
        }
    }

    #[test]
    fn round_trip() {
        let token = sign(b"key", &claims());
        assert_eq!(verify(b"key", &token, 150), Some(claims()));
    }

    #[test]
    fn refuses_other_keys_tampering_and_expiry() {
        let token = sign(b"key", &claims());
        assert_eq!(verify(b"other", &token, 150), None);
        assert_eq!(verify(b"key", &token, 200), None);
        let mut forged = claims();
        forged.sub = "admin".into();
        let (_, sig) = token.rsplit_once('.').unwrap();
        let body = B64.encode(serde_json::to_vec(&forged).unwrap());
        let tampered = format!("{}.{body}.{sig}", B64.encode(HEADER));
        assert_eq!(verify(b"key", &tampered, 150), None);
    }

    #[test]
    fn refuses_alg_none() {
        let body = B64.encode(serde_json::to_vec(&claims()).unwrap());
        let none = format!("{}.{body}.", B64.encode(r#"{"alg":"none","typ":"JWT"}"#));
        assert_eq!(verify(b"key", &none, 150), None);
    }
}
