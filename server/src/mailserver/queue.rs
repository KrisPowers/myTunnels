//! Mail going out: kept until each recipient's server takes it, tried
//! again with growing waits for four days, then bounced.
//!
//! It leaves one of three ways, as set up: straight to the recipient's
//! server from this computer, through another SMTP server (a relay), or
//! through Cloudflare Email Sending.

use std::sync::Arc;
use std::time::Duration;

use lettre::address::Envelope;
use lettre::transport::smtp::client::{Tls, TlsParameters};
use lettre::transport::smtp::extension::ClientId;
use lettre::{AsyncSmtpTransport, AsyncTransport, Tokio1Executor};

use super::store::{Item, Rcpt};
use super::{dns, Mail, Send};
use crate::util::now;

const MAX_AGE: i64 = 4 * 86_400;
const BACKOFF: [i64; 7] = [300, 600, 1800, 3600, 7200, 14_400, 28_800];
/// The most Cloudflare Email Sending takes.
const CLOUDFLARE_MAX: usize = 5 << 20;

/// What became of one recipient.
struct Outcome {
    error: Option<String>,
    permanent: bool,
}

pub fn spawn(mail: Arc<Mail>) {
    tokio::spawn(async move {
        loop {
            run_due(&mail).await;
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(60)) => {}
                _ = mail.wake.notified() => {}
            }
        }
    });
}

async fn run_due(mail: &Mail) {
    let items = match mail.store.queued() {
        Ok(i) => i,
        Err(err) => {
            tracing::warn!("mail queue: {err:#}");
            return;
        }
    };
    for it in items.into_iter().filter(|i| i.next_try <= now()) {
        attempt(mail, it).await;
    }
}

async fn attempt(mail: &Mail, mut it: Item) {
    let Ok(data) = mail.store.queued_raw(&it.id) else {
        let _ = mail.store.drop_item(&it.id);
        return;
    };
    let mut domains: Vec<String> = Vec::new();
    for r in it.rcpts.iter().filter(|r| r.status == "pending") {
        let d = domain_of(&r.addr);
        if !domains.contains(&d) {
            domains.push(d);
        }
    }
    let mut failed: Vec<Rcpt> = Vec::new();
    for domain in domains {
        let rcpts: Vec<String> = it
            .rcpts
            .iter()
            .filter(|r| r.status == "pending" && domain_of(&r.addr) == domain)
            .map(|r| r.addr.clone())
            .collect();
        let outcome = deliver(mail, &domain, &it.from, &rcpts, &data).await;
        for r in it.rcpts.iter_mut().filter(|r| rcpts.contains(&r.addr)) {
            match &outcome.error {
                None => {
                    r.status = "sent".into();
                    r.error.clear();
                    mail.store
                        .log("out", &it.from, &r.addr, data.len(), "sent", "");
                }
                Some(e) if outcome.permanent => {
                    r.status = "failed".into();
                    r.error = e.clone();
                    failed.push(r.clone());
                    mail.store
                        .log("out", &it.from, &r.addr, data.len(), "bounced", e);
                }
                Some(e) => {
                    r.error = e.clone();
                    tracing::info!("mail to {} deferred: {e}", r.addr);
                }
            }
        }
    }
    it.attempts += 1;
    let old = now() - it.created > MAX_AGE;
    for r in it.rcpts.iter_mut().filter(|r| r.status == "pending") {
        if old {
            r.status = "failed".into();
            r.error = format!("gave up after 4 days: {}", r.error);
            failed.push(r.clone());
            mail.store
                .log("out", &it.from, &r.addr, data.len(), "bounced", &r.error);
        }
    }
    if !failed.is_empty() {
        mail.bounce(&it, &failed, &data);
    }
    if it.rcpts.iter().all(|r| r.status != "pending") {
        let _ = mail.store.drop_item(&it.id);
        return;
    }
    let wait = BACKOFF[(it.attempts as usize - 1).min(BACKOFF.len() - 1)];
    it.next_try = now() + wait;
    if let Err(err) = mail.store.save_item(&it) {
        tracing::warn!("mail queue: could not save {}: {err:#}", it.id);
    }
}

fn domain_of(addr: &str) -> String {
    addr.rsplit_once('@')
        .map_or("", |(_, d)| d)
        .to_ascii_lowercase()
}

fn envelope(from: &str, rcpts: &[String]) -> Result<Envelope, String> {
    let from = from.parse().map_err(|e| format!("sender: {e}"))?;
    let to = rcpts
        .iter()
        .map(|r| r.parse())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("recipient: {e}"))?;
    Envelope::new(Some(from), to).map_err(|e| e.to_string())
}

fn smtp_error(err: lettre::transport::smtp::Error) -> Outcome {
    Outcome {
        permanent: err.is_permanent(),
        error: Some(err.to_string()),
    }
}

async fn deliver(mail: &Mail, domain: &str, from: &str, rcpts: &[String], data: &[u8]) -> Outcome {
    let settings = mail.settings();
    let env = match envelope(from, rcpts) {
        Ok(e) => e,
        Err(e) => {
            return Outcome {
                error: Some(e),
                permanent: true,
            }
        }
    };
    match settings.send {
        Send::Cloudflare => cloudflare(mail, from, rcpts, data).await,
        Send::Relay => {
            let Some(relay) = settings.relay.clone() else {
                return Outcome {
                    error: Some("no relay is set".into()),
                    permanent: false,
                };
            };
            match crate::mail::transport(&relay) {
                Ok(t) => match t.send_raw(&env, data).await {
                    Ok(_) => Outcome {
                        error: None,
                        permanent: false,
                    },
                    Err(e) => smtp_error(e),
                },
                Err(e) => Outcome {
                    error: Some(format!("{e:#}")),
                    permanent: false,
                },
            }
        }
        Send::Direct => direct(&settings.hostname(), domain, &env, data).await,
    }
}

/// Straight to the domain's own mail server on port 25, encrypted when it
/// offers TLS.
async fn direct(hello: &str, domain: &str, env: &Envelope, data: &[u8]) -> Outcome {
    let hosts = match dns::mx(domain).await {
        Ok(m) if m.len() == 1 && (m[0].1.is_empty() || m[0].1 == ".") => {
            return Outcome {
                error: Some(format!("{domain} does not accept mail")),
                permanent: true,
            }
        }
        Ok(m) if !m.is_empty() => m.into_iter().map(|h| h.1).collect(),
        Ok(_) | Err(dns::Miss::None) => match dns::ips(domain).await {
            Ok(_) => vec![domain.to_owned()],
            Err(_) => {
                return Outcome {
                    error: Some(format!("{domain} has no mail server")),
                    permanent: true,
                }
            }
        },
        Err(dns::Miss::Failed) => {
            return Outcome {
                error: Some(format!("could not look up {domain}'s mail server")),
                permanent: false,
            }
        }
    };
    let mut last = format!("no mail server of {domain} answered");
    for host in hosts {
        // Most servers carry a valid certificate; for one that does not,
        // encrypted without checking still beats plain text.
        for checked in [true, false] {
            let Ok(params) = TlsParameters::builder(host.clone())
                .dangerous_accept_invalid_certs(!checked)
                .dangerous_accept_invalid_hostnames(!checked)
                .build()
            else {
                continue;
            };
            let transport = AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(host.as_str())
                .port(25)
                .tls(Tls::Opportunistic(params))
                .hello_name(ClientId::Domain(hello.to_owned()))
                .timeout(Some(Duration::from_secs(60)))
                .build();
            match transport.send_raw(env, data).await {
                Ok(_) => {
                    return Outcome {
                        error: None,
                        permanent: false,
                    }
                }
                Err(e) if e.is_permanent() => return smtp_error(e),
                Err(e) => {
                    let tls = e.is_tls();
                    last = format!("{host}: {e}");
                    if !tls {
                        break;
                    }
                }
            }
        }
    }
    if last.contains("Connection refused")
        || last.contains("timed out")
        || last.contains("os error")
    {
        last.push_str(
            ". Many internet providers block mail leaving on port 25; send through a relay instead",
        );
    }
    Outcome {
        error: Some(last),
        permanent: false,
    }
}

async fn cloudflare(mail: &Mail, from: &str, rcpts: &[String], data: &[u8]) -> Outcome {
    let fail = |e: String, permanent| Outcome {
        error: Some(e),
        permanent,
    };
    if data.len() > CLOUDFLARE_MAX {
        return fail(
            format!(
                "message is {} KB; Cloudflare Email Sending takes up to {} KB",
                data.len() >> 10,
                CLOUDFLARE_MAX >> 10
            ),
            true,
        );
    }
    let Ok(text) = std::str::from_utf8(data) else {
        return fail(
            "message is not UTF-8, which Cloudflare Email Sending needs".into(),
            true,
        );
    };
    match super::cloud::send_raw(mail, from, rcpts, text).await {
        Ok(bounced)
            if bounced
                .iter()
                .any(|b| rcpts.iter().any(|r| r.eq_ignore_ascii_case(b))) =>
        {
            fail(
                "refused by the recipient's server (through Cloudflare Email Sending)".into(),
                true,
            )
        }
        Ok(_) => Outcome {
            error: None,
            permanent: false,
        },
        Err(e) => fail(format!("Cloudflare Email Sending: {e:#}"), false),
    }
}
