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

/// A zone's owner, which Cloudflare includes with every zone.
#[derive(Deserialize)]
struct ZoneOwner {
    account: Account,
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

    /// Any call, for the API's other parts such as mail's.
    pub async fn request<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<T> {
        Ok(self.call(method, path, body).await?.0)
    }

    /// A PUT of a multipart form, as a Worker's upload is.
    pub async fn put_form(&self, path: &str, boundary: &str, body: Vec<u8>) -> Result<()> {
        let resp = self
            .http
            .put(format!("{API}{path}"))
            .bearer_auth(self.token)
            .header(
                "content-type",
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(body)
            .send()
            .await
            .context("Cloudflare API is unreachable")?;
        let status = resp.status();
        let envelope: Envelope<Value> = resp
            .json()
            .await
            .with_context(|| format!("Unexpected Cloudflare response ({status})"))?;
        if !envelope.success {
            let errors: Vec<String> = envelope.errors.iter().map(|e| e.message.clone()).collect();
            bail!("Cloudflare: {}", errors.join("; "));
        }
        Ok(())
    }

    pub async fn all<T: DeserializeOwned>(&self, path: &str) -> Result<Vec<T>> {
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

    /// The accounts this token works on. Listing accounts needs Account Settings Read,
    /// which a token made just for tunnels does not have, so the owners of the zones
    /// it can see are counted too.
    pub async fn accounts(&self) -> Result<Vec<Account>> {
        let listed = self.all::<Account>("/accounts").await;
        let owners = self.all::<ZoneOwner>("/zones").await;
        match (listed, owners) {
            (Err(err), Err(_)) => Err(err),
            (listed, owners) => Ok(merge_accounts(
                listed.unwrap_or_default(),
                owners.unwrap_or_default().into_iter().map(|z| z.account),
            )),
        }
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

    /// The tunnel's remote configuration, `null` when it has none yet.
    pub async fn tunnel_config(&self, account_id: &str, tunnel_id: &str) -> Result<Value> {
        let (result, _): (Value, _) = self
            .call(
                Method::GET,
                &format!("/accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations"),
                None,
            )
            .await?;
        Ok(result.get("config").cloned().unwrap_or(Value::Null))
    }

    pub async fn put_config(&self, account_id: &str, tunnel_id: &str, config: Value) -> Result<()> {
        let _: (Value, _) = self
            .call(
                Method::PUT,
                &format!("/accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations"),
                Some(json!({ "config": config })),
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

    /// Points a record at `target` in place, keeping its ID.
    pub async fn repoint_dns(&self, zone_id: &str, record_id: &str, target: &str) -> Result<()> {
        let _: (Value, _) = self
            .call(
                Method::PATCH,
                &format!("/zones/{zone_id}/dns_records/{record_id}"),
                Some(json!({ "content": target })),
            )
            .await?;
        Ok(())
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

fn merge_accounts(
    mut accounts: Vec<Account>,
    more: impl IntoIterator<Item = Account>,
) -> Vec<Account> {
    for account in more {
        if !accounts.iter().any(|a| a.id == account.id) {
            accounts.push(account);
        }
    }
    accounts
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(id: &str) -> Account {
        Account {
            id: id.into(),
            name: format!("Account {id}"),
        }
    }

    #[test]
    fn zone_owners_fill_in_accounts_the_token_cannot_list() {
        let merged = merge_accounts(Vec::new(), [account("a"), account("a"), account("b")]);
        let ids: Vec<&str> = merged.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, ["a", "b"]);
    }

    #[test]
    fn listed_accounts_come_first_without_duplicates() {
        let merged = merge_accounts(vec![account("b")], [account("a"), account("b")]);
        let ids: Vec<&str> = merged.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, ["b", "a"]);
    }

    #[test]
    fn zone_owner_reads_from_a_zone() {
        let zone: ZoneOwner = serde_json::from_str(
            r#"{"id":"z","name":"example.com","account":{"id":"a1","name":"Home"}}"#,
        )
        .unwrap();
        assert_eq!(zone.account.id, "a1");
    }
}
