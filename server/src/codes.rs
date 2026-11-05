//! Sign-in codes sent by email: six digits, good once, for ten minutes and five
//! tries. Once switched on, the dashboard and every tunnel with sign-in ask for
//! one after the password.

use std::collections::HashMap;
use std::sync::Mutex;

use axum::http::StatusCode;
use rand::Rng;

use crate::mail;
use crate::state::AppState;
use crate::util::{lock, now, random_hex, sha256_hex, ApiError};

const TTL: i64 = 10 * 60;
const TRIES: u32 = 5;
/// Codes one account may be sent in a quarter of an hour.
const SENDS: u32 = 5;

/// A sign-in waiting for its code.
pub struct Pending {
    /// "admin", or the account signing in.
    pub subject: String,
    /// The tunnel signed in at; empty for the dashboard.
    pub route_id: String,
    /// The device the code was asked from, which must enter it.
    pub device_hash: String,
    hash: String,
    expires: i64,
    tries: u32,
}

#[derive(Default)]
pub struct Codes(Mutex<HashMap<String, Pending>>);

impl Codes {
    /// Holds a sign-in for a new code; returns its ticket and the code.
    fn issue(&self, subject: &str, route_id: &str, device_hash: &str) -> (String, String) {
        let ticket = random_hex(16);
        let code = format!("{:06}", rand::rngs::OsRng.gen_range(0..1_000_000));
        let now = now();
        let mut all = lock(&self.0);
        all.retain(|_, p| p.expires > now);
        all.insert(
            ticket.clone(),
            Pending {
                subject: subject.to_owned(),
                route_id: route_id.to_owned(),
                device_hash: device_hash.to_owned(),
                hash: sha256_hex(&format!("{ticket}:{code}")),
                expires: now + TTL,
                tries: 0,
            },
        );
        (ticket, code)
    }

    /// The sign-in a right code finishes. A wrong one counts against the ticket,
    /// which is dropped after five.
    pub fn redeem(&self, ticket: &str, code: &str) -> Result<Pending, &'static str> {
        let mut all = lock(&self.0);
        let Some(pending) = all.get_mut(ticket).filter(|p| p.expires > now()) else {
            all.remove(ticket);
            return Err("This code has expired. Sign in again.");
        };
        if pending.hash == sha256_hex(&format!("{ticket}:{}", code.trim())) {
            return all
                .remove(ticket)
                .ok_or("This code has expired. Sign in again.");
        }
        pending.tries += 1;
        if pending.tries >= TRIES {
            all.remove(ticket);
            return Err("Too many wrong codes. Sign in again.");
        }
        Err("That code is not right.")
    }
}

/// Whether sign-ins ask for an emailed code after the password: switched on
/// once, for the dashboard and every tunnel with sign-in together, and only
/// while SMTP is set up to send them.
pub fn on(state: &AppState) -> bool {
    state
        .db
        .setting("twofactor_dashboard")
        .ok()
        .flatten()
        .as_deref()
        == Some("1")
        && mail::load(&state.db).ok().flatten().is_some()
}

/// `k***@example.com`, to say where a code went without showing the address.
pub fn mask(email: &str) -> String {
    match email.split_once('@') {
        Some((local, domain)) => {
            let first: String = local.chars().take(1).collect();
            format!("{first}***@{domain}")
        }
        None => "your email".into(),
    }
}

/// Emails a new code for a sign-in to `place`; returns its ticket and where it went.
pub async fn send(
    state: &AppState,
    subject: &str,
    email: &str,
    route_id: &str,
    device_hash: &str,
    place: &str,
) -> Result<(String, String), ApiError> {
    let Some(smtp) = mail::load(&state.db)? else {
        return Err(ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "Email codes are not set up. Ask the administrator.".into(),
        ));
    };
    if email.is_empty() {
        return Err(ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "This account has no email to send a code to.".into(),
        ));
    }
    if !state.allow(&format!("code-send:{subject}"), SENDS, 15 * 60) {
        return Err(ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many codes sent. Wait a few minutes and try again.".into(),
        ));
    }
    let (ticket, code) = state.codes.issue(subject, route_id, device_hash);
    let body = format!(
        "Your code to sign in to {place} is {code}\n\n\
         It works once, for 10 minutes. If you did not just sign in, someone \
         else knows the password: change it."
    );
    if let Err(err) = mail::send(&smtp, email, &format!("{code} is your sign-in code"), &body).await
    {
        tracing::warn!("cannot send a sign-in code: {err:#}");
        return Err(ApiError(
            StatusCode::BAD_GATEWAY,
            "The code could not be sent. Try again in a moment.".into(),
        ));
    }
    Ok((ticket, mask(email)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_work_once_and_wear_out() {
        let codes = Codes::default();
        let (ticket, code) = codes.issue("u1", "r1", "d1");
        assert_eq!(code.len(), 6);
        let wrong = if code == "000000" { "000001" } else { "000000" };
        assert!(codes.redeem(&ticket, wrong).is_err());
        assert_eq!(codes.redeem(&ticket, &code).unwrap().subject, "u1");
        assert!(codes.redeem(&ticket, &code).is_err());

        let (ticket, code) = codes.issue("u1", "r1", "d1");
        for _ in 0..TRIES {
            let _ = codes.redeem(&ticket, wrong);
        }
        assert!(codes.redeem(&ticket, &code).is_err());
    }

    #[test]
    fn masks_emails() {
        assert_eq!(mask("kris@example.com"), "k***@example.com");
    }
}
