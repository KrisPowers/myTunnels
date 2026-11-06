//! Slows password guessing: before a password is checked, the browser finds a
//! number that, hashed with a one-time challenge, starts with enough zero bits.
//! About a second of work for a person, done while they type; a bot trying
//! thousands of passwords pays it on every try, and more after each wrong one.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::util::{lock, now, random_hex};

/// Zero bits asked for with no wrong tries, and the most asked for after many.
const BASE_BITS: u32 = 16;
const MAX_BITS: u32 = 22;
/// How long a challenge stays good, and how many may wait at once.
const TTL: i64 = 10 * 60;
const MAX_WAITING: usize = 100_000;

/// Challenges handed out, with the bits each asks for and when it expires.
static WAITING: LazyLock<Mutex<HashMap<String, (u32, i64)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// What a browser sends back: the challenge, and the number it found.
#[derive(Deserialize)]
pub struct Proof {
    pub seed: String,
    pub nonce: String,
}

/// A new challenge, harder by one bit for each recent wrong try from where it is asked.
pub fn issue(failures: u32) -> Value {
    let bits = (BASE_BITS + failures).min(MAX_BITS);
    let seed = random_hex(16);
    let now = now();
    let mut waiting = lock(&WAITING);
    if waiting.len() >= MAX_WAITING {
        waiting.retain(|_, (_, expires)| *expires > now);
    }
    if waiting.len() < MAX_WAITING {
        waiting.insert(seed.clone(), (bits, now + TTL));
    }
    json!({ "seed": seed, "bits": bits })
}

/// True when `proof` answers a challenge handed out here, once.
pub fn check(proof: Option<&Proof>) -> bool {
    let Some(proof) = proof.filter(|p| p.nonce.len() <= 20) else {
        return false;
    };
    let Some((bits, expires)) = lock(&WAITING).remove(&proof.seed) else {
        return false;
    };
    expires > now() && zero_bits(&Sha256::digest(format!("{}:{}", proof.seed, proof.nonce))) >= bits
}

fn zero_bits(hash: &[u8]) -> u32 {
    let mut bits = 0;
    for byte in hash {
        if *byte == 0 {
            bits += 8;
        } else {
            return bits + byte.leading_zeros();
        }
    }
    bits
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solve(seed: &str, bits: u32) -> String {
        (0u64..)
            .find(|n| zero_bits(&Sha256::digest(format!("{seed}:{n}"))) >= bits)
            .unwrap()
            .to_string()
    }

    #[test]
    fn a_solved_challenge_works_once() {
        let challenge = issue(0);
        let seed = challenge["seed"].as_str().unwrap().to_owned();
        let nonce = solve(&seed, BASE_BITS);
        let proof = Proof { seed, nonce };
        assert!(check(Some(&proof)));
        assert!(!check(Some(&proof)));
        assert!(!check(None));
    }

    #[test]
    fn wrong_tries_make_it_harder_up_to_a_limit() {
        assert_eq!(issue(3)["bits"], BASE_BITS + 3);
        assert_eq!(issue(100)["bits"], MAX_BITS);
    }

    #[test]
    fn counts_leading_zero_bits() {
        assert_eq!(zero_bits(&[0, 0, 0b0001_0000, 1]), 19);
        assert_eq!(zero_bits(&[0xff]), 0);
    }
}
