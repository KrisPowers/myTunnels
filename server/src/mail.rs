//! Email, sent with the SMTP credentials entered on the Two-Factor Auth page:
//! Gmail, Outlook, or any other provider.

use std::time::Duration;

use anyhow::{bail, Context, Result};
use lettre::message::header::ContentType;
use lettre::message::Mailbox;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use serde::{Deserialize, Serialize};

use crate::db::Db;

/// The SMTP server as saved. The password never leaves the server.
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Smtp {
    pub host: String,
    pub port: u16,
    /// "starttls" (usually port 587), "tls" (usually 465) or "none".
    pub security: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    /// The from address, such as `you@gmail.com`.
    pub from: String,
}

pub fn load(db: &Db) -> Result<Option<Smtp>> {
    Ok(db
        .setting("smtp")?
        .and_then(|raw| serde_json::from_str(&raw).ok()))
}

pub fn save(db: &Db, smtp: &Smtp) -> Result<()> {
    db.set_setting("smtp", &serde_json::to_string(smtp)?)
}

fn transport(smtp: &Smtp) -> Result<AsyncSmtpTransport<Tokio1Executor>> {
    let host = smtp.host.trim();
    let builder = match smtp.security.as_str() {
        "tls" => AsyncSmtpTransport::<Tokio1Executor>::relay(host)?,
        "starttls" => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(host)?,
        "none" => AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(host),
        other => bail!("unknown security {other}"),
    };
    let builder = builder
        .port(smtp.port)
        .timeout(Some(Duration::from_secs(20)));
    Ok(if smtp.username.is_empty() {
        builder.build()
    } else {
        builder
            .credentials(Credentials::new(
                smtp.username.clone(),
                smtp.password.clone(),
            ))
            .build()
    })
}

/// Connects and signs in to the server without sending anything.
pub async fn check(smtp: &Smtp) -> Result<()> {
    let ok = transport(smtp)?
        .test_connection()
        .await
        .with_context(|| format!("cannot reach {}:{}", smtp.host, smtp.port))?;
    if !ok {
        bail!(
            "{}:{} did not answer as an SMTP server",
            smtp.host,
            smtp.port
        );
    }
    Ok(())
}

/// Sends a plain text email.
pub async fn send(smtp: &Smtp, to: &str, subject: &str, body: &str) -> Result<()> {
    let from: Mailbox = smtp.from.parse().context("the from address is not valid")?;
    let to: Mailbox = to.parse().context("the recipient address is not valid")?;
    let message = Message::builder()
        .from(from)
        .to(to)
        .subject(subject)
        .header(ContentType::TEXT_PLAIN)
        .body(body.to_owned())?;
    transport(smtp)?
        .send(message)
        .await
        .with_context(|| format!("{} refused the email", smtp.host))?;
    Ok(())
}
