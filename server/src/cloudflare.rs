use anyhow::{bail, Context, Result};
use base64::Engine;
use rand::RngCore;
use reqwest::Method;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const API: &str = "https://api.cloudflare.com/client/v4";

#[derive(Deserialize)]
struct Envelope<T> {
    #[serde(default)]
    success: bool,
    #[serde(default)]
    errors: Vec<ApiMessage>,
    result: Option<T>,
    result_info: Option<ResultInfo>,
}

#[derive(Deserialize)]
struct ApiMessage {
    #[serde(default)]
    code: i64,
    message: String,
}

#[derive(Deserialize)]
struct ResultInfo {
    total_pages: Option<u32>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Account {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Zone {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub status: String,
}

#[derive(Deserialize)]
pub struct TunnelInfo {
    pub id: String,
}

#[derive(Deserialize)]
pub struct DnsRecord {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub content: String,
}

pub struct Cloudflare<'a> {
    http: &'a reqwest::Client,
    token: &'a str,
}

impl<'a> Cloudflare<'a> {
    pub fn new(http: &'a reqwest::Client, token: &'a str) -> Self {
        Self { http, token }
    }

    async fn call<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<(T, Option<ResultInfo>)> {
        let mut req = self
            .http
            .request(method, format!("{API}{path}"))
            .bearer_auth(self.token);
        if let Some(body) = body {
            req = req.json(&body);
        }
        let resp = req.send().await.context("Cloudflare API is unreachable")?;
        let status = resp.status();
        let envelope: Envelope<T> = resp
            .json()
            .await
            .with_context(|| format!("Unexpected Cloudflare response ({status})"))?;
        if !envelope.success {
            let errors: Vec<String> = envelope
                .errors
                .iter()
                .map(|e| format!("{} (code {})", e.message, e.code))
                .collect();
            if errors.is_empty() {
                bail!("Cloudflare request failed ({status})");
            }
            bail!("Cloudflare: {}", errors.join("; "));
        }
        let result = envelope.result.context("Cloudflare returned no result")?;
        Ok((result, envelope.result_info))
    }

    async fn all<T: DeserializeOwned>(&self, path: &str) -> Result<Vec<T>> {
        let sep = if path.contains('?') { '&' } else { '?' };
        let mut out = Vec::new();
        for page in 1..=100 {
            let (items, info): (Vec<T>, _) = self
                .call(
                    Method::GET,
                    &format!("{path}{sep}page={page}&per_page=50"),
                    None,
                )
                .await?;
            out.extend(items);
            if page >= info.and_then(|i| i.total_pages).unwrap_or(1) {
                break;
            }
        }
        Ok(out)
    }

    pub async fn accounts(&self) -> Result<Vec<Account>> {
        self.all("/accounts").await
    }

    pub async fn zones(&self, account_id: &str) -> Result<Vec<Zone>> {
        self.all(&format!("/zones?account.id={account_id}")).await
    }

    pub async fn find_tunnel(&self, account_id: &str, name: &str) -> Result<Option<TunnelInfo>> {
        let (tunnels, _): (Vec<TunnelInfo>, _) = self
            .call(
                Method::GET,
                &format!("/accounts/{account_id}/cfd_tunnel?name={name}&is_deleted=false"),
                None,
            )
            .await?;
        Ok(tunnels.into_iter().next())
    }

    pub async fn create_tunnel(&self, account_id: &str, name: &str) -> Result<TunnelInfo> {
        let mut secret = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut secret);
        let body = json!({
            "name": name,
            "config_src": "cloudflare",
            "tunnel_secret": base64::engine::general_purpose::STANDARD.encode(secret),
        });
        let (tunnel, _) = self
            .call(
                Method::POST,
                &format!("/accounts/{account_id}/cfd_tunnel"),
                Some(body),
            )
            .await?;
        Ok(tunnel)
    }

    pub async fn tunnel_token(&self, account_id: &str, tunnel_id: &str) -> Result<String> {
        let (token, _) = self
            .call(
                Method::GET,
                &format!("/accounts/{account_id}/cfd_tunnel/{tunnel_id}/token"),
                None,
            )
            .await?;
        Ok(token)
    }

    pub async fn put_ingress(
        &self,
        account_id: &str,
        tunnel_id: &str,
        ingress: Vec<Value>,
    ) -> Result<()> {
        let _: (Value, _) = self
            .call(
                Method::PUT,
                &format!("/accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations"),
                Some(json!({ "config": { "ingress": ingress } })),
            )
            .await?;
        Ok(())
    }

    pub async fn find_dns(&self, zone_id: &str, hostname: &str) -> Result<Option<DnsRecord>> {
        let (records, _): (Vec<DnsRecord>, _) = self
            .call(
                Method::GET,
                &format!("/zones/{zone_id}/dns_records?name={hostname}"),
                None,
            )
            .await?;
        Ok(records.into_iter().next())
    }

    pub async fn create_cname(
        &self,
        zone_id: &str,
        hostname: &str,
        target: &str,
    ) -> Result<DnsRecord> {
        let body = json!({
            "type": "CNAME",
            "name": hostname,
            "content": target,
            "proxied": true,
            "ttl": 1,
            "comment": "Managed by the homelab gateway",
        });
        let (record, _) = self
            .call(
                Method::POST,
                &format!("/zones/{zone_id}/dns_records"),
                Some(body),
            )
            .await?;
        Ok(record)
    }

    pub async fn delete_dns(&self, zone_id: &str, record_id: &str) -> Result<()> {
        let _: (Value, _) = self
            .call(
                Method::DELETE,
                &format!("/zones/{zone_id}/dns_records/{record_id}"),
                None,
            )
            .await?;
        Ok(())
    }
}
