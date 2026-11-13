//! The certificate mail apps and other servers see on this server's own
//! ports: from Let's Encrypt, proved through a TXT record on Cloudflare,
//! so no port has to be opened for it. Renewed after 60 days.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use instant_acme::{
    Account, AccountCredentials, AuthorizationStatus, ChallengeType, Identifier, LetsEncrypt,
    NewAccount, NewOrder, OrderStatus, RetryPolicy,
};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio_rustls::TlsAcceptor;

use super::{cloud, net, Mail};
use crate::cloudflare::Cloudflare;
use crate::util::{lock, now};

const KEY: &str = "mail_cert";
const ACCOUNT: &str = "mail_acme";
const RENEW_AFTER: i64 = 60 * 86_400;

#[derive(Serialize, Deserialize)]
struct Saved {
    host: String,
    chain: String,
    key: String,
    issued: i64,
}

fn acceptor(chain: &str, key: &str) -> Result<TlsAcceptor> {
    let certs = CertificateDer::pem_slice_iter(chain.as_bytes())
        .collect::<Result<Vec<_>, _>>()
        .context("bad certificate")?;
    let key = PrivateKeyDer::from_pem_slice(key.as_bytes()).context("bad key")?;
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()?
    .with_no_client_auth()
    .with_single_cert(certs, key)?;
    Ok(TlsAcceptor::from(Arc::new(config)))
}

fn saved(mail: &Mail) -> Option<Saved> {
    mail.state
        .db
        .setting(KEY)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
}

/// Puts the saved certificate to use, at start.
pub fn load(mail: &Mail) {
    if let Some(s) = saved(mail) {
        match acceptor(&s.chain, &s.key) {
            Ok(a) => net::set_acceptor(Some(a)),
            Err(err) => tracing::warn!("the mail certificate cannot be used: {err:#}"),
        }
    }
}

/// When the certificate for `host` was made, if there is one.
pub fn issued(mail: &Mail, host: &str) -> Option<i64> {
    saved(mail).filter(|s| s.host == host).map(|s| s.issued)
}

/// A certificate for `host`, made or renewed when due.
/// When making a certificate last failed.
static FAILED: std::sync::Mutex<i64> = std::sync::Mutex::new(0);

pub async fn ensure(mail: &Mail, host: &str, zone: &str, forced: bool) -> Result<String> {
    if let Some(s) = saved(mail).filter(|s| s.host == host) {
        if now() - s.issued < RENEW_AFTER {
            if net::acceptor().is_none() {
                net::set_acceptor(Some(acceptor(&s.chain, &s.key)?));
            }
            return Ok(format!("{host}, from Let's Encrypt"));
        }
    }
    // Let's Encrypt allows a few failed checks an hour; upkeep waits after one.
    if !forced && now() - *lock(&FAILED) < 3600 {
        bail!("waiting an hour after the last failed try");
    }
    let (chain, key) = match order(mail, host, zone).await {
        Ok(made) => made,
        Err(err) => {
            *lock(&FAILED) = now();
            return Err(err);
        }
    };
    net::set_acceptor(Some(acceptor(&chain, &key)?));
    let s = Saved {
        host: host.to_owned(),
        chain,
        key,
        issued: now(),
    };
    mail.state
        .db
        .set_setting(KEY, &serde_json::to_string(&s)?)?;
    tracing::info!("made a certificate for {host}");
    Ok(format!("{host}, from Let's Encrypt"))
}

async fn account(mail: &Mail) -> Result<Account> {
    if let Some(creds) = mail
        .state
        .db
        .setting(ACCOUNT)?
        .and_then(|s| serde_json::from_str::<AccountCredentials>(&s).ok())
    {
        if let Ok(a) = Account::builder()?.from_credentials(creds).await {
            return Ok(a);
        }
    }
    let (account, creds) = Account::builder()?
        .create(
            &NewAccount {
                contact: &[],
                terms_of_service_agreed: true,
                only_return_existing: false,
            },
            LetsEncrypt::Production.url().to_owned(),
            None,
        )
        .await?;
    mail.state
        .db
        .set_setting(ACCOUNT, &serde_json::to_string(&creds)?)?;
    Ok(account)
}

async fn order(mail: &Mail, host: &str, zone: &str) -> Result<(String, String)> {
    let s = cloud::settings(mail)?;
    let cf = Cloudflare::new(&mail.state.http, &s.token);
    let account = account(mail).await?;
    let ids = [Identifier::Dns(host.to_owned())];
    let mut order = account.new_order(&NewOrder::new(&ids)).await?;
    let name = format!("_acme-challenge.{host}");
    let mut auths = order.authorizations();
    while let Some(auth) = auths.next().await {
        let mut auth = auth?;
        match auth.status {
            AuthorizationStatus::Valid => continue,
            AuthorizationStatus::Pending => {}
            other => bail!("Let's Encrypt says the name is {other:?}"),
        }
        let mut challenge = auth
            .challenge(ChallengeType::Dns01)
            .ok_or_else(|| anyhow!("Let's Encrypt offered no DNS check"))?;
        let value = challenge.key_authorization().dns_value();
        cloud::remove(&cf, zone, "TXT", &name, |r| r.comment == cloud::MARK).await?;
        cloud::upsert(
            &cf,
            zone,
            json!({ "type": "TXT", "name": name, "content": value }),
            |_| false,
        )
        .await?;
        // Cloudflare's own servers answer within seconds.
        tokio::time::sleep(Duration::from_secs(10)).await;
        challenge.set_ready().await?;
    }
    let status = order.poll_ready(&RetryPolicy::default()).await?;
    let _ = cloud::remove(&cf, zone, "TXT", &name, |r| r.comment == cloud::MARK).await;
    if status != OrderStatus::Ready {
        bail!("Let's Encrypt did not accept the DNS check ({status:?})");
    }
    let key = order.finalize().await?;
    let chain = order.poll_certificate(&RetryPolicy::default()).await?;
    Ok((chain, key))
}
