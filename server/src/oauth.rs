//! Signing in at tunnels through another service: GitHub, Google, GitLab,
//! Discord, Slack and Codeberg, self-hosted providers such as Authentik,
//! Authelia, Keycloak, Pocket ID, Gitea and Forgejo, hosted ones such as Auth0
//! and Okta, or any other OpenID Connect provider.
//! Credentials are saved once; each tunnel picks the providers it offers and is
//! its own redirect. The provider vouches for an email, and the account in Users
//! with that email signs in, held to the same rules as signing in with its password.

use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::db::Db;

/// How a provider is reached.
#[derive(Clone, Copy, PartialEq)]
enum Flow {
    /// GitHub's own OAuth, with its email list.
    GitHub,
    /// Discord's OAuth, with its user record.
    Discord,
    /// OpenID Connect at a fixed issuer.
    Oidc(&'static str),
    /// OpenID Connect at the issuer entered when setting it up.
    OwnIssuer,
}

/// A provider that can be set up.
pub struct Spec {
    pub id: &'static str,
    pub label: &'static str,
    flow: Flow,
}

impl Spec {
    /// True when setting it up asks for its issuer URL.
    pub fn needs_issuer(&self) -> bool {
        self.flow == Flow::OwnIssuer
    }
}

const fn own(id: &'static str, label: &'static str) -> Spec {
    Spec {
        id,
        label,
        flow: Flow::OwnIssuer,
    }
}

/// Every provider that can be set up, in the order they are shown.
pub const SPECS: [Spec; 17] = [
    Spec {
        id: "github",
        label: "GitHub",
        flow: Flow::GitHub,
    },
    Spec {
        id: "google",
        label: "Google",
        flow: Flow::Oidc("https://accounts.google.com"),
    },
    Spec {
        id: "gitlab",
        label: "GitLab",
        flow: Flow::Oidc("https://gitlab.com"),
    },
    Spec {
        id: "discord",
        label: "Discord",
        flow: Flow::Discord,
    },
    Spec {
        id: "slack",
        label: "Slack",
        flow: Flow::Oidc("https://slack.com"),
    },
    Spec {
        id: "codeberg",
        label: "Codeberg",
        flow: Flow::Oidc("https://codeberg.org"),
    },
    own("authentik", "Authentik"),
    own("authelia", "Authelia"),
    own("keycloak", "Keycloak"),
    own("pocketid", "Pocket ID"),
    own("zitadel", "Zitadel"),
    own("kanidm", "Kanidm"),
    own("gitea", "Gitea"),
    own("forgejo", "Forgejo"),
    own("auth0", "Auth0"),
    own("okta", "Okta"),
    own("oidc", "OpenID Connect"),
];

pub fn spec(id: &str) -> Option<&'static Spec> {
    SPECS.iter().find(|s| s.id == id)
}

/// Where the provider sends the browser back, on the tunnel it left from.
pub const CALLBACK_PATH: &str = "/__gate/oauth-callback";

/// One provider as saved. The secret never leaves the server.
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Provider {
    #[serde(skip)]
    pub id: String,
    /// The name on the sign-in button; only the custom OpenID Connect one sets its own.
    #[serde(default)]
    pub name: String,
    /// The OpenID Connect issuer, such as https://auth.example.com/application/o/apps/.
    #[serde(default)]
    pub issuer: String,
    pub client_id: String,
    pub client_secret: String,
}

impl Provider {
    /// The name visitors see: the provider's own, or the one given to a custom one.
    pub fn label(&self) -> String {
        if self.id == "oidc" && !self.name.trim().is_empty() {
            return self.name.trim().to_owned();
        }
        spec(&self.id).map_or("OpenID Connect", |s| s.label).into()
    }

    fn flow(&self) -> Flow {
        spec(&self.id).map_or(Flow::OwnIssuer, |s| s.flow)
    }

    /// The issuer to discover endpoints from, for OpenID Connect providers.
    fn issuer(&self) -> Option<&str> {
        match self.flow() {
            Flow::Oidc(issuer) => Some(issuer),
            Flow::OwnIssuer => Some(self.issuer.trim()),
            Flow::GitHub | Flow::Discord => None,
        }
    }
}

fn key(id: &str) -> String {
    format!("oauth_{id}")
}

pub fn load(db: &Db, id: &str) -> Result<Option<Provider>> {
    if spec(id).is_none() {
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
    for s in &SPECS {
        list.extend(load(db, s.id)?);
    }
    Ok(list)
}

pub fn save(db: &Db, p: &Provider) -> Result<()> {
    db.set_setting(&key(&p.id), &serde_json::to_string(p)?)
}

pub fn remove(db: &Db, id: &str) -> Result<()> {
    db.delete_setting(&key(id))
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
    /// GitHub's email list, Discord's user record, or the OpenID userinfo endpoint.
    emails: String,
}

fn fixed(authorize: &str, token: &str, emails: &str) -> Endpoints {
    Endpoints {
        authorize: authorize.into(),
        token: token.into(),
        emails: emails.into(),
    }
}

async fn endpoints(http: &reqwest::Client, p: &Provider) -> Result<Endpoints> {
    let issuer = match p.flow() {
        Flow::GitHub => {
            return Ok(fixed(
                "https://github.com/login/oauth/authorize",
                "https://github.com/login/oauth/access_token",
                "https://api.github.com/user/emails",
            ))
        }
        Flow::Discord => {
            return Ok(fixed(
                "https://discord.com/oauth2/authorize",
                "https://discord.com/api/oauth2/token",
                "https://discord.com/api/users/@me",
            ))
        }
        Flow::Oidc(_) | Flow::OwnIssuer => p.issuer().unwrap_or_default(),
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
    let scope = match p.flow() {
        Flow::GitHub => "read:user user:email",
        Flow::Discord => "identify email",
        Flow::Oidc(_) | Flow::OwnIssuer => "openid email",
    };
    let mut params = vec![
        ("client_id", p.client_id.as_str()),
        ("redirect_uri", redirect),
        ("scope", scope),
        ("state", state),
        ("code_challenge", challenge.as_str()),
        ("code_challenge_method", "S256"),
        ("response_type", "code"),
    ];
    if p.flow() == Flow::GitHub {
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
    // An OpenID provider may say the email is verified in the ID token alone, as
    // Gitea and Forgejo do. The token came straight from the provider over TLS.
    let mut emails = id_token_emails(&token, &p.client_id);
    for email in emails_from(&info) {
        if !emails.contains(&email) {
            emails.push(email);
        }
    }
    Ok(emails)
}

/// The verified email in an ID token meant for this client, if there is one.
fn id_token_emails(token: &Value, client_id: &str) -> Vec<String> {
    let claims = token
        .get("id_token")
        .and_then(Value::as_str)
        .and_then(|jwt| jwt.split('.').nth(1))
        .and_then(|body| B64.decode(body.trim_end_matches('=')).ok())
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    let Some(claims) = claims else {
        return Vec::new();
    };
    let ours = match claims.get("aud") {
        Some(Value::String(aud)) => aud == client_id,
        Some(Value::Array(list)) => list.iter().any(|a| a.as_str() == Some(client_id)),
        _ => false,
    };
    if ours {
        emails_from(&claims)
    } else {
        Vec::new()
    }
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
    fn id_token_vouches_for_its_client_only() {
        let body = B64.encode(r#"{"aud":"app","email":"e@x.io","email_verified":true}"#);
        let token = json!({ "id_token": format!("h.{body}.s") });
        assert_eq!(id_token_emails(&token, "app"), ["e@x.io"]);
        assert!(id_token_emails(&token, "other").is_empty());
    }

    #[test]
    fn every_provider_is_found_by_its_id() {
        for s in &SPECS {
            assert_eq!(spec(s.id).map(|f| f.label), Some(s.label));
        }
        assert!(spec("oidc").is_some_and(Spec::needs_issuer));
        assert!(!spec("github").is_some_and(Spec::needs_issuer));
    }

    #[test]
    fn challenge_matches_rfc_7636() {
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }
}
