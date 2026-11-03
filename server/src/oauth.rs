//! Signing in at tunnels through another service: GitHub, Google, GitLab, or any
//! OpenID Connect provider (Authentik, Authelia, Keycloak, Pocket ID and others).
//! The provider vouches for an email, and the account in Users with that email
//! signs in, held to the same rules as signing in with its password.

use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::db::Db;
use crate::state::Snapshot;

/// Every provider that can be set up, in the order they are shown.
pub const PROVIDERS: [&str; 4] = ["github", "google", "gitlab", "oidc"];

/// Where the provider sends the browser back, on the callback tunnel.
pub const CALLBACK_PATH: &str = "/__gate/oauth-callback";

/// One provider as saved. The secret never leaves the server.
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Provider {
    #[serde(skip)]
    pub id: String,
    /// The name on the sign-in button; only an OpenID Connect provider sets its own.
    #[serde(default)]
    pub name: String,
    /// The OpenID Connect issuer, such as https://auth.example.com/application/o/apps/.
    #[serde(default)]
    pub issuer: String,
    pub client_id: String,
    pub client_secret: String,
    #[serde(default)]
    pub enabled: bool,
}

impl Provider {
    /// The name visitors see: the provider's own, or the one given to a custom one.
    pub fn label(&self) -> String {
        match self.id.as_str() {
            "github" => "GitHub".into(),
            "google" => "Google".into(),
            "gitlab" => "GitLab".into(),
            _ if !self.name.trim().is_empty() => self.name.trim().to_owned(),
            _ => "OpenID Connect".into(),
        }
    }

    /// The issuer to discover endpoints from; GitHub has none, as it is not OpenID.
    fn issuer(&self) -> Option<&str> {
        match self.id.as_str() {
            "google" => Some("https://accounts.google.com"),
            "gitlab" => Some("https://gitlab.com"),
            "oidc" => Some(self.issuer.trim()),
            _ => None,
        }
    }
}

fn key(id: &str) -> String {
    format!("oauth_{id}")
}

pub fn load(db: &Db, id: &str) -> Result<Option<Provider>> {
    if !PROVIDERS.contains(&id) {
        return Ok(None);
    }
    Ok(db
        .setting(&key(id))?
        .and_then(|raw| serde_json::from_str::<Provider>(&raw).ok())
        .map(|mut p| {
            p.id = id.to_owned();
            p
        }))
}

pub fn all(db: &Db) -> Result<Vec<Provider>> {
    let mut list = Vec::new();
    for id in PROVIDERS {
        list.extend(load(db, id)?);
    }
    Ok(list)
}

pub fn save(db: &Db, p: &Provider) -> Result<()> {
    db.set_setting(&key(&p.id), &serde_json::to_string(p)?)
}

pub fn remove(db: &Db, id: &str) -> Result<()> {
    db.delete_setting(&key(id))
}

/// The tunnel address every provider returns to: the one pinned when the first
/// provider was saved, or the oldest tunnel's while that one is gone.
pub fn callback_host(db: &Db, snap: &Snapshot) -> Option<String> {
    db.setting("oauth_host")
        .ok()
        .flatten()
        .filter(|h| snap.routes.contains_key(h))
        .or_else(|| snap.hub.clone())
}

pub fn redirect_uri(host: &str) -> String {
    format!("https://{host}{CALLBACK_PATH}")
}

/// The PKCE challenge for a verifier.
pub fn challenge(verifier: &str) -> String {
    B64.encode(Sha256::digest(verifier.as_bytes()))
}

struct Endpoints {
    authorize: String,
    token: String,
    /// GitHub's email list, or the OpenID userinfo endpoint.
    emails: String,
}

async fn endpoints(http: &reqwest::Client, p: &Provider) -> Result<Endpoints> {
    let Some(issuer) = p.issuer() else {
        return Ok(Endpoints {
            authorize: "https://github.com/login/oauth/authorize".into(),
            token: "https://github.com/login/oauth/access_token".into(),
            emails: "https://api.github.com/user/emails".into(),
        });
    };
    let url = format!(
        "{}/.well-known/openid-configuration",
        issuer.trim_end_matches('/')
    );
    let doc: Value = http
        .get(&url)
        .send()
        .await
        .with_context(|| format!("cannot reach {url}"))?
        .error_for_status()
        .with_context(|| format!("no OpenID configuration at {url}"))?
        .json()
        .await
        .with_context(|| format!("no OpenID configuration at {url}"))?;
    let field = |name: &str| {
        doc.get(name)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| anyhow!("the OpenID configuration has no {name}"))
    };
    Ok(Endpoints {
        authorize: field("authorization_endpoint")?,
        token: field("token_endpoint")?,
        emails: field("userinfo_endpoint")?,
    })
}

/// Checks a provider can be used: an OpenID one must publish its configuration.
pub async fn check(http: &reqwest::Client, p: &Provider) -> Result<()> {
    endpoints(http, p).await.map(|_| ())
}

/// Where to send the browser to sign in at the provider.
pub async fn authorize_url(
    http: &reqwest::Client,
    p: &Provider,
    redirect: &str,
    state: &str,
    verifier: &str,
) -> Result<String> {
    let ends = endpoints(http, p).await?;
    let challenge = challenge(verifier);
    let scope = if p.issuer().is_some() {
        "openid email"
    } else {
        "read:user user:email"
    };
    let mut params = vec![
        ("client_id", p.client_id.as_str()),
        ("redirect_uri", redirect),
        ("scope", scope),
        ("state", state),
        ("code_challenge", challenge.as_str()),
        ("code_challenge_method", "S256"),
    ];
    if p.issuer().is_some() {
        params.push(("response_type", "code"));
    } else {
        params.push(("allow_signup", "false"));
    }
    Ok(Url::parse_with_params(&ends.authorize, &params)?.to_string())
}

/// Trades the code the provider sent back for the emails it has verified.
pub async fn verified_emails(
    http: &reqwest::Client,
    p: &Provider,
    redirect: &str,
    code: &str,
    verifier: &str,
) -> Result<Vec<String>> {
    let ends = endpoints(http, p).await?;
    let token: Value = http
        .post(&ends.token)
        .header(reqwest::header::ACCEPT, "application/json")
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect),
            ("client_id", p.client_id.as_str()),
            ("client_secret", p.client_secret.as_str()),
            ("code_verifier", verifier),
        ])
        .send()
        .await?
        .json()
        .await
        .context("the provider's answer was not understood")?;
    let Some(access) = token.get("access_token").and_then(Value::as_str) else {
        let why = token
            .get("error_description")
            .or_else(|| token.get("error"))
            .and_then(Value::as_str)
            .unwrap_or("no access token");
        bail!("{} refused the sign-in: {why}", p.label());
    };
    let info: Value = http
        .get(&ends.emails)
        .bearer_auth(access)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::USER_AGENT, "myTunnels")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(emails_from(&info))
}

/// The verified emails in GitHub's email list or in OpenID userinfo.
fn emails_from(info: &Value) -> Vec<String> {
    let verified = |v: Option<&Value>| {
        matches!(v, Some(Value::Bool(true))) || v.and_then(Value::as_str) == Some("true")
    };
    let entries: Vec<&Value> = match info {
        Value::Array(list) => list.iter().collect(),
        other => vec![other],
    };
    entries
        .into_iter()
        .filter(|e| verified(e.get("verified").or_else(|| e.get("email_verified"))))
        .filter_map(|e| e.get("email").and_then(Value::as_str))
        .map(str::to_owned)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_verified_emails_count() {
        let github = json!([
            { "email": "a@x.io", "verified": true, "primary": true },
            { "email": "b@x.io", "verified": false }
        ]);
        assert_eq!(emails_from(&github), ["a@x.io"]);
        let oidc = json!({ "email": "c@x.io", "email_verified": "true" });
        assert_eq!(emails_from(&oidc), ["c@x.io"]);
        assert!(emails_from(&json!({ "email": "d@x.io" })).is_empty());
    }

    #[test]
    fn challenge_matches_rfc_7636() {
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }
}
