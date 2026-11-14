//! The certificate mail apps and other servers see on this server's own
//! ports: from Let's Encrypt, proved through a TXT record when the primary
//! domain is on Cloudflare, so no port has to be opened for it, or over HTTP
//! on port 80 when its records are kept by hand. Renewed after 60 days.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use axum::extract::Path;
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
use crate::db::Forward;
use crate::util::{lock, now, random_hex};

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

/// The loopback port Let's Encrypt's HTTP check is answered on, reached from
/// port 80 only while a certificate is being made.
const HTTP_PORT: u16 = 2080;

async fn order(mail: &Mail, host: &str, zone: &str) -> Result<(String, String)> {
    if zone.is_empty() {
        return order_http(mail, host).await;
    }
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

/// For a domain whose records are kept by hand, Let's Encrypt fetches a
/// token over HTTP from the server's name instead: port 80 is forwarded
/// here for the check and closed again after.
async fn order_http(mail: &Mail, host: &str) -> Result<(String, String)> {
    let account = account(mail).await?;
    let ids = [Identifier::Dns(host.to_owned())];
    let mut order = account.new_order(&NewOrder::new(&ids)).await?;
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", HTTP_PORT))
        .await
        .context("the certificate check's port is in use")?;
    let answers: Arc<std::sync::Mutex<HashMap<String, String>>> = Arc::default();
    let served = answers.clone();
    let app = axum::Router::new().route(
        "/.well-known/acme-challenge/{token}",
        axum::routing::get(move |Path(token): Path<String>| {
            let served = served.clone();
            async move {
                lock(&served)
                    .get(&token)
                    .cloned()
                    .ok_or(axum::http::StatusCode::NOT_FOUND)
            }
        }),
    );
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let forward = Forward {
        id: random_hex(8),
        method: "port".into(),
        name: "Mail: certificate check".into(),
        target_host: None,
        target_port: HTTP_PORT,
        protocol: "tcp".into(),
        public_port: 80,
        public: false,
        // Closes on its own if this is cut short.
        expires_at: now() + 900,
        enabled: true,
        created_at: now(),
    };
    let forward = match crate::forward::add(&mail.state, forward).await {
        Ok(f) => f,
        Err(e) => {
            server.abort();
            bail!("port 80 could not be opened for the check: {}", e.1);
        }
    };
    let done = async {
        let mut auths = order.authorizations();
        while let Some(auth) = auths.next().await {
            let mut auth = auth?;
            match auth.status {
                AuthorizationStatus::Valid => continue,
                AuthorizationStatus::Pending => {}
                other => bail!("Let's Encrypt says the name is {other:?}"),
            }
            let mut challenge = auth
                .challenge(ChallengeType::Http01)
                .ok_or_else(|| anyhow!("Let's Encrypt offered no HTTP check"))?;
            lock(&answers).insert(
                challenge.token.clone(),
                challenge.key_authorization().as_str().to_owned(),
            );
            challenge.set_ready().await?;
        }
        let status = order.poll_ready(&RetryPolicy::default()).await?;
        if status != OrderStatus::Ready {
            bail!(
                "Let's Encrypt could not reach {host} on port 80 ({status:?}); check its A record"
            );
        }
        let key = order.finalize().await?;
        let chain = order.poll_certificate(&RetryPolicy::default()).await?;
        Ok((chain, key))
    }
    .await;
    let _ = crate::forward::take_down(&mail.state, &forward).await;
    server.abort();
    done
}
