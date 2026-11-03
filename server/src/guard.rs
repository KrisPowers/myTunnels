//! Signs that an account is in someone else's hands. One person shows up from a
//! couple of devices and a couple of networks, and may travel; a stolen account
//! shows up from several places at once.

use std::collections::HashSet;

use crate::db::SignIn;

const DAY: i64 = 86_400;
/// Two countries closer together than this, on different devices, is no trip.
const TRAVEL: i64 = 2 * 3_600;
/// Countries in a day before an account is held.
const MAX_COUNTRIES: usize = 3;
/// Devices new to the account in a day before it is held; one more for an account
/// with no history yet, which may well start on a phone, a laptop and a tablet.
const MAX_NEW_DEVICES: usize = 3;

/// A sign-in about to happen.
pub struct Attempt<'a> {
    pub device: Option<&'a str>,
    pub country: Option<&'a str>,
    pub at: i64,
}

/// Why this sign-in, with the account's earlier ones, looks like a breach, if it does.
pub fn assess(history: &[SignIn], attempt: &Attempt) -> Option<String> {
    let ok = |s: &&SignIn| s.outcome == "ok";
    let recent: Vec<&SignIn> = history
        .iter()
        .filter(ok)
        .filter(|s| attempt.at - s.at < DAY)
        .collect();
    let earlier: HashSet<&str> = history
        .iter()
        .filter(ok)
        .filter(|s| attempt.at - s.at >= DAY)
        .filter_map(|s| s.device_id.as_deref())
        .collect();

    let countries: HashSet<&str> = recent
        .iter()
        .filter_map(|s| s.country.as_deref())
        .chain(attempt.country)
        .collect();
    if countries.len() >= MAX_COUNTRIES {
        let mut list: Vec<&str> = countries.into_iter().collect();
        list.sort_unstable();
        return Some(format!(
            "Signed in from {} countries within a day ({})",
            list.len(),
            list.join(", ")
        ));
    }

    let new_devices: HashSet<&str> = recent
        .iter()
        .filter_map(|s| s.device_id.as_deref())
        .chain(attempt.device)
        .filter(|d| !earlier.contains(d))
        .collect();
    let limit = if earlier.is_empty() {
        MAX_NEW_DEVICES + 1
    } else {
        MAX_NEW_DEVICES
    };
    if new_devices.len() >= limit {
        return Some(format!(
            "Signed in from {} new devices within a day",
            new_devices.len()
        ));
    }

    if let Some(here) = attempt.country {
        let elsewhere = recent.iter().find(|s| {
            attempt.at - s.at < TRAVEL
                && s.country.as_deref().is_some_and(|c| c != here)
                && s.device_id.as_deref() != attempt.device
        });
        if let Some(s) = elsewhere {
            return Some(format!(
                "Signed in from {} and {} within two hours, on different devices",
                s.country.as_deref().unwrap_or_default(),
                here
            ));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sign_in(device: &str, country: &str, ago: i64) -> SignIn {
        SignIn {
            user_id: "u".into(),
            device_id: Some(device.into()),
            ip: None,
            country: Some(country.into()),
            at: 1_000_000 - ago,
            outcome: "ok".into(),
        }
    }

    fn attempt<'a>(device: &'a str, country: &'a str) -> Attempt<'a> {
        Attempt {
            device: Some(device),
            country: Some(country),
            at: 1_000_000,
        }
    }

    #[test]
    fn two_devices_and_two_networks_are_fine() {
        let history = [
            sign_in("phone", "US", 5 * DAY),
            sign_in("laptop", "US", 4 * DAY),
            sign_in("phone", "CA", 3 * 3_600),
        ];
        assert_eq!(assess(&history, &attempt("laptop", "CA")), None);
    }

    #[test]
    fn three_countries_in_a_day_hold_the_account() {
        let history = [
            sign_in("a", "US", 10 * 3_600),
            sign_in("a", "DE", 5 * 3_600),
        ];
        assert!(assess(&history, &attempt("a", "BR")).is_some());
    }

    #[test]
    fn a_trip_needs_time() {
        let history = [sign_in("phone", "US", 3_600)];
        assert!(assess(&history, &attempt("other", "JP")).is_some());
        assert_eq!(assess(&history, &attempt("phone", "JP")), None);
    }

    #[test]
    fn new_devices_pile_up() {
        let history = [
            sign_in("old", "US", 9 * DAY),
            sign_in("b", "US", 3_600 * 5),
            sign_in("c", "US", 3_600 * 4),
        ];
        assert!(assess(&history, &attempt("d", "US")).is_some());
        let fresh = [sign_in("b", "US", 3_600 * 5), sign_in("c", "US", 3_600 * 4)];
        assert_eq!(assess(&fresh, &attempt("d", "US")), None);
    }
}
