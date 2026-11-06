//! Passkeys (WebAuthn): sign in with a fingerprint, face or security key. The
//! device keeps a private key; myTunnels keeps its public key and checks a
//! signature over a one-time challenge. A passkey sign-in asks the device to
//! verify its owner, so it counts as a password and a code together.
//!
//! A passkey belongs to a domain (its relying party): the tunnel's zone, such as
//! `example.com`, so one passkey works on every tunnel and on a dashboard published
//! under it; or the name the dashboard was opened by on the LAN.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use ciborium::Value as Cbor;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::db::{Db, Passkey};
use crate::util::{lock, now, random_hex};

/// How long a browser has to answer a challenge.
const CHALLENGE_TTL: i64 = 5 * 60;
/// COSE algorithms accepted: ES256, then RS256 (older Windows Hello).
const ES256: i64 = -7;
const RS256: i64 = -257;

/// Authenticator data flags.
const USER_PRESENT: u8 = 0x01;
const USER_VERIFIED: u8 = 0x04;
const HAS_CREDENTIAL: u8 = 0x40;

enum Purpose {
    Register { subject: String },
    SignIn,
}

struct Pending {
    purpose: Purpose,
    rp_id: String,
    origin: String,
    expires: i64,
}

static CHALLENGES: LazyLock<Mutex<HashMap<String, Pending>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn remember(challenge: &str, pending: Pending) {
    let mut all = lock(&CHALLENGES);
    let now = now();
    all.retain(|_, p| p.expires > now);
    all.insert(challenge.to_owned(), pending);
}

fn new_challenge() -> String {
    B64.encode(hex::decode(random_hex(32)).unwrap_or_default())
}

/// What `navigator.credentials.create` needs to make a passkey for `subject`,
/// with binary fields as base64url.
pub fn begin_register(
    subject: &str,
    label: &str,
    rp_id: &str,
    origin: &str,
    existing: &[Passkey],
) -> Value {
    let challenge = new_challenge();
    remember(
        &challenge,
        Pending {
            purpose: Purpose::Register {
                subject: subject.to_owned(),
            },
            rp_id: rp_id.to_owned(),
            origin: origin.to_owned(),
            expires: now() + CHALLENGE_TTL,
        },
    );
    let exclude: Vec<Value> = existing
        .iter()
        .filter(|p| p.rp_id == rp_id)
        .map(|p| json!({ "type": "public-key", "id": p.id }))
        .collect();
    json!({
        "challenge": challenge,
        "rp": { "id": rp_id, "name": "myTunnels" },
        "user": { "id": B64.encode(subject), "name": label, "displayName": label },
        "pubKeyCredParams": [
            { "type": "public-key", "alg": ES256 },
            { "type": "public-key", "alg": RS256 }
        ],
        "authenticatorSelection": { "residentKey": "required", "userVerification": "required" },
        "attestation": "none",
        "excludeCredentials": exclude,
        "timeout": CHALLENGE_TTL * 1000,
    })
}

/// What `navigator.credentials.get` needs to sign in with any passkey for `rp_id`.
pub fn begin_sign_in(rp_id: &str, origin: &str) -> Value {
    let challenge = new_challenge();
    remember(
        &challenge,
        Pending {
            purpose: Purpose::SignIn,
            rp_id: rp_id.to_owned(),
            origin: origin.to_owned(),
            expires: now() + CHALLENGE_TTL,
        },
    );
    json!({
        "challenge": challenge,
        "rpId": rp_id,
        "userVerification": "required",
        "timeout": CHALLENGE_TTL * 1000,
    })
}

/// A new passkey, as the browser sends it back (base64url fields).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Created {
    pub id: String,
    pub client_data_json: String,
    pub attestation_object: String,
}

/// A passkey sign-in, as the browser sends it back (base64url fields).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asserted {
    pub id: String,
    pub client_data_json: String,
    pub authenticator_data: String,
    pub signature: String,
}

/// A passkey's public key.
#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(tag = "alg")]
enum Key {
    #[serde(rename = "ES256")]
    Es256 { x: String, y: String },
    #[serde(rename = "RS256")]
    Rs256 { n: String, e: String },
}

/// Takes the challenge `client_data` answers, checked against what was asked.
fn answer(client_data: &[u8], kind: &str) -> Result<Pending, &'static str> {
    let data: Value =
        serde_json::from_slice(client_data).map_err(|_| "Unreadable passkey reply")?;
    let challenge = data["challenge"].as_str().unwrap_or_default();
    let pending = lock(&CHALLENGES)
        .remove(challenge)
        .filter(|p| p.expires > now())
        .ok_or("This passkey request expired. Try again.")?;
    if data["type"].as_str() != Some(kind) {
        return Err("Unexpected passkey reply");
    }
    if data["origin"].as_str() != Some(pending.origin.as_str()) {
        return Err("This passkey reply came from another site");
    }
    Ok(pending)
}

/// Flags and sign count from authenticator data made for `rp_id`, and what follows.
fn auth_data<'a>(data: &'a [u8], rp_id: &str) -> Result<(u8, u32, &'a [u8]), &'static str> {
    if data.len() < 37 {
        return Err("Unreadable passkey reply");
    }
    if data[..32] != Sha256::digest(rp_id.as_bytes())[..] {
        return Err("This passkey is for another site");
    }
    let flags = data[32];
    if flags & USER_PRESENT == 0 || flags & USER_VERIFIED == 0 {
        return Err("The device did not check who you are");
    }
    let count = u32::from_be_bytes([data[33], data[34], data[35], data[36]]);
    Ok((flags, count, &data[37..]))
}

/// Checks a new passkey and keeps it for `subject`, who must be the one it was
/// asked for.
pub fn finish_register(
    db: &Db,
    body: &Created,
    name: &str,
    subject: &str,
) -> Result<(), &'static str> {
    let client_data = decode(&body.client_data_json)?;
    let pending = answer(&client_data, "webauthn.create")?;
    if !matches!(&pending.purpose, Purpose::Register { subject: asked } if asked == subject) {
        return Err("Unexpected passkey reply");
    }
    let attestation: Cbor = ciborium::de::from_reader(decode(&body.attestation_object)?.as_slice())
        .map_err(|_| "Unreadable passkey reply")?;
    let data = cbor_field(&attestation, "authData")
        .and_then(Cbor::as_bytes)
        .ok_or("Unreadable passkey reply")?;
    let (flags, count, rest) = auth_data(data, &pending.rp_id)?;
    if flags & HAS_CREDENTIAL == 0 || rest.len() < 18 {
        return Err("Unreadable passkey reply");
    }
    let id_len = u16::from_be_bytes([rest[16], rest[17]]) as usize;
    let id = rest
        .get(18..18 + id_len)
        .ok_or("Unreadable passkey reply")?;
    if B64.encode(id) != body.id {
        return Err("Unexpected passkey reply");
    }
    let cose: Cbor =
        ciborium::de::from_reader(&rest[18 + id_len..]).map_err(|_| "Unreadable passkey reply")?;
    let key = cose_key(&cose).ok_or("This kind of passkey is not supported")?;
    let passkey = Passkey {
        id: body.id.clone(),
        subject: subject.to_owned(),
        rp_id: pending.rp_id,
        public_key: serde_json::to_string(&key).map_err(|_| "Cannot keep this passkey")?,
        sign_count: count,
        name: name.trim().chars().take(60).collect(),
        created_at: now(),
        last_used: None,
    };
    db.add_passkey(&passkey)
        .map_err(|_| "This passkey is already added")
}

/// Checks a passkey sign-in; returns whose passkey it was.
pub fn finish_sign_in(db: &Db, body: &Asserted) -> Result<String, &'static str> {
    let client_data = decode(&body.client_data_json)?;
    let pending = answer(&client_data, "webauthn.get")?;
    let stored = db
        .passkey(&body.id)
        .ok()
        .flatten()
        .filter(|p| p.rp_id == pending.rp_id)
        .ok_or("This passkey is not known here")?;
    let data = decode(&body.authenticator_data)?;
    let (_, count, _) = auth_data(&data, &pending.rp_id)?;
    let mut message = data.clone();
    message.extend(Sha256::digest(&client_data));
    let key: Key =
        serde_json::from_str(&stored.public_key).map_err(|_| "This passkey cannot be read")?;
    if !verify(&key, &message, &decode(&body.signature)?) {
        return Err("The passkey's signature is not right");
    }
    // A counter that goes backwards means a copied key.
    if (count != 0 || stored.sign_count != 0) && count <= stored.sign_count {
        return Err("This passkey looks copied; it was refused");
    }
    let _ = db.touch_passkey(&stored.id, count, now());
    Ok(stored.subject)
}

fn decode(text: &str) -> Result<Vec<u8>, &'static str> {
    B64.decode(text.trim_end_matches('='))
        .map_err(|_| "Unreadable passkey reply")
}

fn cbor_field<'a>(map: &'a Cbor, name: &str) -> Option<&'a Cbor> {
    map.as_map()?
        .iter()
        .find(|(k, _)| k.as_text() == Some(name))
        .map(|(_, v)| v)
}

fn cose_field(map: &Cbor, label: i64) -> Option<&Cbor> {
    map.as_map()?
        .iter()
        .find(|(k, _)| {
            k.as_integer()
                .is_some_and(|i| i128::from(i) == i128::from(label))
        })
        .map(|(_, v)| v)
}

fn cose_bytes(map: &Cbor, label: i64) -> Option<String> {
    cose_field(map, label)?.as_bytes().map(hex::encode)
}

/// The public key in a COSE key, if it is one of the accepted kinds.
fn cose_key(map: &Cbor) -> Option<Key> {
    let alg = i128::from(cose_field(map, 3)?.as_integer()?);
    if alg == i128::from(ES256) {
        return Some(Key::Es256 {
            x: cose_bytes(map, -2)?,
            y: cose_bytes(map, -3)?,
        });
    }
    if alg == i128::from(RS256) {
        return Some(Key::Rs256 {
            n: cose_bytes(map, -1)?,
            e: cose_bytes(map, -2)?,
        });
    }
    None
}

fn verify(key: &Key, message: &[u8], signature: &[u8]) -> bool {
    match key {
        Key::Es256 { x, y } => {
            use p256::ecdsa::signature::Verifier;
            let (Ok(x), Ok(y)) = (hex::decode(x), hex::decode(y)) else {
                return false;
            };
            let mut point = vec![0x04];
            point.extend(x);
            point.extend(y);
            let (Ok(key), Ok(sig)) = (
                p256::ecdsa::VerifyingKey::from_sec1_bytes(&point),
                p256::ecdsa::Signature::from_der(signature),
            ) else {
                return false;
            };
            key.verify(message, &sig).is_ok()
        }
        Key::Rs256 { n, e } => {
            use rsa::signature::Verifier;
            let (Ok(n), Ok(e)) = (hex::decode(n), hex::decode(e)) else {
                return false;
            };
            let Ok(public) = rsa::RsaPublicKey::new(
                rsa::BigUint::from_bytes_be(&n),
                rsa::BigUint::from_bytes_be(&e),
            ) else {
                return false;
            };
            let Ok(sig) = rsa::pkcs1v15::Signature::try_from(signature) else {
                return false;
            };
            rsa::pkcs1v15::VerifyingKey::<Sha256>::new(public)
                .verify(message, &sig)
                .is_ok()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::signature::Signer;
    use p256::ecdsa::{Signature, SigningKey};

    fn authenticator_data(rp_id: &str, flags: u8, count: u32) -> Vec<u8> {
        let mut data = Sha256::digest(rp_id.as_bytes()).to_vec();
        data.push(flags);
        data.extend(count.to_be_bytes());
        data
    }

    #[test]
    fn es256_signatures_verify_and_tampering_fails() {
        let signing = SigningKey::random(&mut rand::rngs::OsRng);
        let point = signing.verifying_key().to_encoded_point(false);
        let key = Key::Es256 {
            x: hex::encode(point.x().unwrap()),
            y: hex::encode(point.y().unwrap()),
        };
        let mut message = authenticator_data("example.com", USER_PRESENT | USER_VERIFIED, 5);
        message.extend(Sha256::digest(b"{}"));
        let sig: Signature = signing.sign(&message);
        let der = sig.to_der();
        assert!(verify(&key, &message, der.as_bytes()));
        message[0] ^= 1;
        assert!(!verify(&key, &message, der.as_bytes()));
    }

    #[test]
    fn authenticator_data_must_match_the_site_and_the_owner() {
        let ok = authenticator_data("example.com", USER_PRESENT | USER_VERIFIED, 7);
        assert_eq!(auth_data(&ok, "example.com").unwrap().1, 7);
        assert!(auth_data(&ok, "other.com").is_err());
        let unverified = authenticator_data("example.com", USER_PRESENT, 7);
        assert!(auth_data(&unverified, "example.com").is_err());
    }

    #[test]
    fn reads_an_es256_cose_key() {
        let cose = Cbor::Map(vec![
            (Cbor::Integer(1.into()), Cbor::Integer(2.into())),
            (Cbor::Integer(3.into()), Cbor::Integer((-7).into())),
            (Cbor::Integer((-1).into()), Cbor::Integer(1.into())),
            (Cbor::Integer((-2).into()), Cbor::Bytes(vec![1; 32])),
            (Cbor::Integer((-3).into()), Cbor::Bytes(vec![2; 32])),
        ]);
        assert_eq!(
            cose_key(&cose),
            Some(Key::Es256 {
                x: hex::encode([1; 32]),
                y: hex::encode([2; 32]),
            })
        );
    }

    #[test]
    fn a_challenge_answers_once_and_only_from_its_site() {
        remember(
            "abc",
            Pending {
                purpose: Purpose::SignIn,
                rp_id: "example.com".into(),
                origin: "https://app.example.com".into(),
                expires: now() + 60,
            },
        );
        let wrong = br#"{"type":"webauthn.get","challenge":"abc","origin":"https://evil.com"}"#;
        assert!(answer(wrong, "webauthn.get").is_err());
        let right =
            br#"{"type":"webauthn.get","challenge":"abc","origin":"https://app.example.com"}"#;
        assert!(
            answer(right, "webauthn.get").is_err(),
            "a challenge works once"
        );
    }
}
