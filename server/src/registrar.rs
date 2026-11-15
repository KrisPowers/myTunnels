//! A domain's DNS records where they really are: its Cloudflare zone, or its
//! records at Porkbun, GoDaddy or Namecheap through their APIs. Each is read
//! and changed as one list of records, whatever the host.
//!
//! The registrars' keys are kept sealed in the settings, one entry each.

use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::cloudflare::Cloudflare;
use crate::state::AppState;

/// The registrars whose DNS can be read and changed here.
pub const HOSTS: [&str; 3] = ["porkbun", "godaddy", "namecheap"];

/// The record types that can be added or changed.
pub const KINDS: [&str; 5] = ["A", "AAAA", "CNAME", "MX", "TXT"];

/// One record, its name in full, such as `www.example.com`.
#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
pub struct Record {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub content: String,
    pub priority: Option<u16>,
    pub ttl: u32,
}

/// A registrar's keys. Namecheap's `user` is its account name.
#[derive(Clone, Serialize, Deserialize, Default)]
pub struct Keys {
    pub key: String,
    #[serde(default)]
    pub secret: String,
    #[serde(default)]
    pub user: String,
}

pub fn keys(state: &AppState, host: &str) -> Result<Keys> {
    let raw = state
        .db
        .setting(host)?
        .ok_or_else(|| anyhow!("Connect {} in Settings first", label(host)))?;
    Ok(serde_json::from_str(&raw)?)
}

pub fn connected(state: &AppState, host: &str) -> bool {
    state.db.setting(host).ok().flatten().is_some()
}

pub fn label(host: &str) -> &'static str {
    match host {
        "porkbun" => "Porkbun",
        "godaddy" => "GoDaddy",
        "namecheap" => "Namecheap",
        _ => "the registrar",
    }
}

/// Checks the keys work by asking the registrar for something small.
pub async fn check(state: &AppState, host: &str, k: &Keys) -> Result<()> {
    match host {
        "porkbun" => porkbun(state, k, "/ping", json!({})).await.map(|_| ()),
        "godaddy" => godaddy(state, k, Method::GET, "/domains?limit=1", None)
            .await
            .map(|_| ()),
        "namecheap" => namecheap(state, k, "namecheap.domains.getList", &[])
            .await
            .map(|_| ()),
        _ => bail!("Pick a registrar"),
    }
}

/// Where a record goes within the domain: `@` for the domain itself.
fn relative(name: &str, domain: &str) -> String {
    let name = name.trim_end_matches('.');
    if name.eq_ignore_ascii_case(domain) {
        return "@".into();
    }
    name.strip_suffix(&format!(".{domain}"))
        .unwrap_or(name)
        .to_owned()
}

fn full(name: &str, domain: &str) -> String {
    match name {
        "" | "@" => domain.to_owned(),
        n if n.ends_with(domain) => n.to_owned(),
        n => format!("{n}.{domain}"),
    }
}

// ---- reading and changing, whatever the host ----

pub enum Zone<'a> {
    Cloudflare(&'a str),
    Registrar(&'a str),
}

pub async fn list(state: &AppState, zone: Zone<'_>, domain: &str) -> Result<Vec<Record>> {
    let mut out = match zone {
        Zone::Cloudflare(id) => cf_list(state, id).await?,
        Zone::Registrar(host) => {
            let k = keys(state, host)?;
            match host {
                "porkbun" => pb_list(state, &k, domain).await?,
                "godaddy" => gd_list(state, &k, domain).await?,
                "namecheap" => nc_list(state, &k, domain).await?,
                _ => bail!("Pick a registrar"),
            }
        }
    };
    out.sort_by(|a, b| (a.name.len(), &a.name, &a.kind).cmp(&(b.name.len(), &b.name, &b.kind)));
    Ok(out)
}

/// Adds `r`, or with `old` set, puts `r` in its place.
pub async fn save(
    state: &AppState,
    zone: Zone<'_>,
    domain: &str,
    old: Option<&str>,
    r: &Record,
) -> Result<()> {
    match zone {
        Zone::Cloudflare(id) => cf_save(state, id, old, r).await,
        Zone::Registrar(host) => {
            let k = keys(state, host)?;
            match host {
                "porkbun" => pb_save(state, &k, domain, old, r).await,
                "godaddy" => gd_save(state, &k, domain, old, r).await,
                "namecheap" => nc_save(state, &k, domain, old, Some(r)).await,
                _ => bail!("Pick a registrar"),
            }
        }
    }
}

pub async fn remove(state: &AppState, zone: Zone<'_>, domain: &str, id: &str) -> Result<()> {
    match zone {
        Zone::Cloudflare(zone) => {
            let cf = cf(state)?;
            let _: Value = Cloudflare::new(&state.http, &cf)
                .request(
                    Method::DELETE,
                    &format!("/zones/{zone}/dns_records/{id}"),
                    None,
                )
                .await?;
            Ok(())
        }
        Zone::Registrar(host) => {
            let k = keys(state, host)?;
            match host {
                "porkbun" => porkbun(state, &k, &format!("/dns/delete/{domain}/{id}"), json!({}))
                    .await
                    .map(|_| ()),
                "godaddy" => gd_remove(state, &k, domain, id).await,
                "namecheap" => nc_save(state, &k, domain, Some(id), None).await,
                _ => bail!("Pick a registrar"),
            }
        }
    }
}

// ---- Cloudflare ----

fn cf(state: &AppState) -> Result<String> {
    state
        .db
        .setting("cf_token")?
        .ok_or_else(|| anyhow!("Connect Cloudflare in Settings first"))
}

async fn cf_list(state: &AppState, zone: &str) -> Result<Vec<Record>> {
    let token = cf(state)?;
    let list: Vec<Value> = Cloudflare::new(&state.http, &token)
        .all(&format!("/zones/{zone}/dns_records"))
        .await?;
    Ok(list
        .iter()
        .map(|r| Record {
            id: r["id"].as_str().unwrap_or_default().to_owned(),
            kind: r["type"].as_str().unwrap_or_default().to_owned(),
            name: r["name"].as_str().unwrap_or_default().to_owned(),
            content: r["content"].as_str().unwrap_or_default().to_owned(),
            priority: r["priority"].as_u64().map(|p| p as u16),
            ttl: r["ttl"].as_u64().unwrap_or(1) as u32,
        })
        .collect())
}

async fn cf_save(state: &AppState, zone: &str, old: Option<&str>, r: &Record) -> Result<()> {
    let token = cf(state)?;
    let mut body = json!({ "type": r.kind, "name": r.name, "content": r.content, "ttl": 1 });
    if let Some(p) = r.priority {
        body["priority"] = json!(p);
    }
    let (method, path) = match old {
        Some(id) => (Method::PUT, format!("/zones/{zone}/dns_records/{id}")),
        None => (Method::POST, format!("/zones/{zone}/dns_records")),
    };
    let _: Value = Cloudflare::new(&state.http, &token)
        .request(method, &path, Some(body))
        .await?;
    Ok(())
}

// ---- Porkbun ----

const PORKBUN: &str = "https://api.porkbun.com/api/json/v3";

async fn porkbun(state: &AppState, k: &Keys, path: &str, mut body: Value) -> Result<Value> {
    body["apikey"] = json!(k.key);
    body["secretapikey"] = json!(k.secret);
    let reply: Value = state
        .http
        .post(format!("{PORKBUN}{path}"))
        .json(&body)
        .send()
        .await
        .context("Porkbun is unreachable")?
        .json()
        .await
        .context("Unexpected reply from Porkbun")?;
    if reply["status"] != "SUCCESS" {
        bail!(
            "Porkbun: {}",
            reply["message"].as_str().unwrap_or("the request failed")
        );
    }
    Ok(reply)
}

async fn pb_list(state: &AppState, k: &Keys, domain: &str) -> Result<Vec<Record>> {
    let reply = porkbun(state, k, &format!("/dns/retrieve/{domain}"), json!({})).await?;
    Ok(reply["records"]
        .as_array()
        .map(|l| l.as_slice())
        .unwrap_or_default()
        .iter()
        .map(|r| Record {
            id: r["id"].as_str().unwrap_or_default().to_owned(),
            kind: r["type"].as_str().unwrap_or_default().to_owned(),
            name: r["name"].as_str().unwrap_or_default().to_owned(),
            content: r["content"].as_str().unwrap_or_default().to_owned(),
            priority: r["prio"]
                .as_str()
                .and_then(|p| p.parse().ok())
                .filter(|_| r["type"] == "MX"),
            ttl: r["ttl"]
                .as_str()
                .and_then(|t| t.parse().ok())
                .unwrap_or(600),
        })
        .collect())
}

async fn pb_save(
    state: &AppState,
    k: &Keys,
    domain: &str,
    old: Option<&str>,
    r: &Record,
) -> Result<()> {
    let name = match relative(&r.name, domain).as_str() {
        "@" => String::new(),
        n => n.to_owned(),
    };
    let mut body = json!({ "name": name, "type": r.kind, "content": r.content, "ttl": "600" });
    if let Some(p) = r.priority {
        body["prio"] = json!(p.to_string());
    }
    let path = match old {
        Some(id) => format!("/dns/edit/{domain}/{id}"),
        None => format!("/dns/create/{domain}"),
    };
    porkbun(state, k, &path, body).await.map(|_| ())
}

// ---- GoDaddy ----
//
// GoDaddy's records have no IDs: they are kept as sets by type and name. A
// record's ID here is its type, name and value together.

const GODADDY: &str = "https://api.godaddy.com/v1";

async fn godaddy(
    state: &AppState,
    k: &Keys,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value> {
    let mut req = state
        .http
        .request(method, format!("{GODADDY}{path}"))
        .header("Authorization", format!("sso-key {}:{}", k.key, k.secret));
    if let Some(b) = body {
        req = req.json(&b);
    }
    let resp = req.send().await.context("GoDaddy is unreachable")?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        let msg = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v["message"].as_str().map(str::to_owned))
            .unwrap_or_else(|| format!("the request failed ({status})"));
        bail!("GoDaddy: {msg}");
    }
    Ok(serde_json::from_str(&text).unwrap_or(Value::Null))
}

fn gd_id(kind: &str, name: &str, data: &str) -> String {
    B64.encode(format!("{kind}\n{name}\n{data}"))
}

fn gd_parts(id: &str) -> Result<(String, String, String)> {
    let raw = String::from_utf8(B64.decode(id).map_err(|_| anyhow!("No such record"))?)?;
    let mut it = raw.splitn(3, '\n').map(str::to_owned);
    match (it.next(), it.next(), it.next()) {
        (Some(k), Some(n), Some(d)) => Ok((k, n, d)),
        _ => bail!("No such record"),
    }
}

async fn gd_list(state: &AppState, k: &Keys, domain: &str) -> Result<Vec<Record>> {
    let list = godaddy(
        state,
        k,
        Method::GET,
        &format!("/domains/{domain}/records"),
        None,
    )
    .await?;
    Ok(list
        .as_array()
        .map(|l| l.as_slice())
        .unwrap_or_default()
        .iter()
        .map(|r| {
            let kind = r["type"].as_str().unwrap_or_default();
            let name = r["name"].as_str().unwrap_or_default();
            let data = r["data"].as_str().unwrap_or_default();
            Record {
                id: gd_id(kind, name, data),
                kind: kind.to_owned(),
                name: full(name, domain),
                content: data.to_owned(),
                priority: r["priority"]
                    .as_u64()
                    .map(|p| p as u16)
                    .filter(|_| kind == "MX"),
                ttl: r["ttl"].as_u64().unwrap_or(600) as u32,
            }
        })
        .collect())
}

/// The records of one type and name, as GoDaddy wants them back.
async fn gd_set(
    state: &AppState,
    k: &Keys,
    domain: &str,
    kind: &str,
    name: &str,
) -> Result<Vec<Value>> {
    let list = godaddy(
        state,
        k,
        Method::GET,
        &format!("/domains/{domain}/records/{kind}/{name}"),
        None,
    )
    .await?;
    Ok(list.as_array().cloned().unwrap_or_default())
}

async fn gd_put(
    state: &AppState,
    k: &Keys,
    domain: &str,
    kind: &str,
    name: &str,
    set: Vec<Value>,
) -> Result<()> {
    let path = format!("/domains/{domain}/records/{kind}/{name}");
    if set.is_empty() {
        godaddy(state, k, Method::DELETE, &path, None).await?;
    } else {
        godaddy(state, k, Method::PUT, &path, Some(json!(set))).await?;
    }
    Ok(())
}

async fn gd_remove(state: &AppState, k: &Keys, domain: &str, id: &str) -> Result<()> {
    let (kind, name, data) = gd_parts(id)?;
    let mut set = gd_set(state, k, domain, &kind, &name).await?;
    set.retain(|r| r["data"].as_str() != Some(data.as_str()));
    gd_put(state, k, domain, &kind, &name, set).await
}

async fn gd_save(
    state: &AppState,
    k: &Keys,
    domain: &str,
    old: Option<&str>,
    r: &Record,
) -> Result<()> {
    if let Some(id) = old {
        gd_remove(state, k, domain, id).await?;
    }
    let name = relative(&r.name, domain);
    let mut rec = json!({ "data": r.content, "ttl": 600 });
    if let Some(p) = r.priority {
        rec["priority"] = json!(p);
    }
    let mut set: Vec<Value> = gd_set(state, k, domain, &r.kind, &name)
        .await?
        .into_iter()
        .map(|o| {
            let mut keep = json!({ "data": o["data"], "ttl": o["ttl"] });
            if !o["priority"].is_null() {
                keep["priority"] = o["priority"].clone();
            }
            keep
        })
        .collect();
    set.push(rec);
    gd_put(state, k, domain, &r.kind, &name, set).await
}

// ---- Namecheap ----
//
// Namecheap answers in XML, and setting records replaces all of them, so a
// change reads the whole list, changes it and writes it all back. Its API
// only answers this network's public address once it is allowed under the
// account's API access.

const NAMECHEAP: &str = "https://api.namecheap.com/xml.response";

async fn namecheap(
    state: &AppState,
    k: &Keys,
    command: &str,
    extra: &[(String, String)],
) -> Result<String> {
    let ip = crate::forward::public_ip(state)
        .ok_or_else(|| anyhow!("This network's public address is not known yet"))?;
    let mut form = vec![
        ("ApiUser".to_owned(), k.user.clone()),
        ("ApiKey".to_owned(), k.key.clone()),
        ("UserName".to_owned(), k.user.clone()),
        ("ClientIp".to_owned(), ip.to_string()),
        ("Command".to_owned(), command.to_owned()),
    ];
    form.extend_from_slice(extra);
    let text = state
        .http
        .post(NAMECHEAP)
        .form(&form)
        .send()
        .await
        .context("Namecheap is unreachable")?
        .text()
        .await?;
    if text.contains("Status=\"ERROR\"") {
        let msg = text
            .split("<Error ")
            .nth(1)
            .and_then(|e| e.split_once('>'))
            .and_then(|(_, rest)| rest.split_once("</Error>"))
            .map(|(m, _)| unescape(m))
            .unwrap_or_else(|| "the request failed".into());
        bail!("Namecheap: {msg}");
    }
    Ok(text)
}

fn unescape(s: &str) -> String {
    s.replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

/// The attributes of each `<tag .../>` in `xml`.
fn tags(xml: &str, tag: &str) -> Vec<Vec<(String, String)>> {
    xml.split(&format!("<{tag} "))
        .skip(1)
        .filter_map(|rest| rest.split_once("/>").or_else(|| rest.split_once('>')))
        .map(|(attrs, _)| {
            let mut out = Vec::new();
            let mut rest = attrs;
            while let Some((key, after)) = rest.split_once("=\"") {
                let Some((value, next)) = after.split_once('"') else {
                    break;
                };
                out.push((key.trim().to_owned(), unescape(value)));
                rest = next;
            }
            out
        })
        .collect()
}

fn sld_tld(domain: &str) -> (String, String) {
    match domain.split_once('.') {
        Some((s, t)) => (s.to_owned(), t.to_owned()),
        None => (domain.to_owned(), String::new()),
    }
}

async fn nc_list(state: &AppState, k: &Keys, domain: &str) -> Result<Vec<Record>> {
    let (sld, tld) = sld_tld(domain);
    let xml = namecheap(
        state,
        k,
        "namecheap.domains.dns.getHosts",
        &[("SLD".into(), sld), ("TLD".into(), tld)],
    )
    .await?;
    Ok(tags(&xml, "host")
        .into_iter()
        .map(|a| {
            let get = |k: &str| {
                a.iter()
                    .find(|(n, _)| n == k)
                    .map(|(_, v)| v.clone())
                    .unwrap_or_default()
            };
            let kind = get("Type");
            Record {
                id: get("HostId"),
                name: full(&get("Name"), domain),
                content: get("Address"),
                priority: get("MXPref").parse().ok().filter(|_| kind == "MX"),
                ttl: get("TTL").parse().unwrap_or(1800),
                kind,
            }
        })
        .collect())
}

/// Writes every record back, without `old` and with `new`.
async fn nc_save(
    state: &AppState,
    k: &Keys,
    domain: &str,
    old: Option<&str>,
    new: Option<&Record>,
) -> Result<()> {
    let mut list = nc_list(state, k, domain).await?;
    if let Some(id) = old {
        list.retain(|r| r.id != id);
    }
    list.extend(new.cloned());
    let (sld, tld) = sld_tld(domain);
    let mut form = vec![("SLD".to_owned(), sld), ("TLD".to_owned(), tld)];
    for (i, r) in list.iter().enumerate() {
        let n = i + 1;
        form.push((format!("HostName{n}"), relative(&r.name, domain)));
        form.push((format!("RecordType{n}"), r.kind.clone()));
        form.push((format!("Address{n}"), r.content.clone()));
        form.push((format!("TTL{n}"), r.ttl.to_string()));
        if let Some(p) = r.priority {
            form.push((format!("MXPref{n}"), p.to_string()));
        }
    }
    namecheap(state, k, "namecheap.domains.dns.setHosts", &form)
        .await
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_relative_and_full() {
        assert_eq!(relative("example.com", "example.com"), "@");
        assert_eq!(relative("www.example.com.", "example.com"), "www");
        assert_eq!(full("@", "example.com"), "example.com");
        assert_eq!(full("mail", "example.com"), "mail.example.com");
        assert_eq!(full("mail.example.com", "example.com"), "mail.example.com");
    }

    #[test]
    fn godaddy_ids_round_trip() {
        let id = gd_id("TXT", "@", "v=spf1 -all");
        assert_eq!(
            gd_parts(&id).unwrap(),
            ("TXT".into(), "@".into(), "v=spf1 -all".into())
        );
        assert!(gd_parts("!!").is_err());
    }

    #[test]
    fn namecheap_hosts_are_read() {
        let xml = r#"<DomainDNSGetHostsResult Domain="example.com"><host HostId="12" Name="@" Type="MX" Address="mail.example.com." MXPref="10" TTL="1800" /><host HostId="13" Name="www" Type="TXT" Address="a &amp; b" MXPref="10" TTL="60" /></DomainDNSGetHostsResult>"#;
        let hosts = tags(xml, "host");
        assert_eq!(hosts.len(), 2);
        assert!(hosts[1].contains(&("Address".into(), "a & b".into())));
        assert_eq!(sld_tld("example.co.uk"), ("example".into(), "co.uk".into()));
    }
}
