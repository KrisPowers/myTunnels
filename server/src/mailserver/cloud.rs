//! Cloudflare for mail: the DNS records every way needs, and for the
//! Cloudflare ways, Email Routing with its Worker and Email Sending.

use anyhow::{anyhow, Result};
use reqwest::Method;
use serde_json::{json, Value};

use super::Mail;
use crate::cloudflare::Cloudflare;
use crate::state::CfSettings;

/// The comment on every record mail makes, so it can find its own again.
pub const MARK: &str = "myTunnels mail";
/// Cloudflare's SPF, for Email Routing and Email Sending.
pub const CLOUDFLARE_SPF: &str = "include:_spf.mx.cloudflare.net";
/// The Email Worker deployed to the account.
const WORKER: &str = "email-inbound";
const WORKER_JS: &str = include_str!("worker.js");

pub fn settings(mail: &Mail) -> Result<CfSettings> {
    mail.state.cloudflare().map_err(|e| anyhow!(e.1))
}

pub struct Record {
    pub id: String,
    pub kind: String,
    pub content: String,
    pub comment: String,
}

fn unquote(s: &str) -> String {
    let s = s.trim();
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        s[1..s.len() - 1].replace("\" \"", "")
    } else {
        s.to_owned()
    }
}

pub async fn records(
    cf: &Cloudflare<'_>,
    zone: &str,
    kind: &str,
    name: &str,
) -> Result<Vec<Record>> {
    let list: Vec<Value> = cf
        .all(&format!(
            "/zones/{zone}/dns_records?type={kind}&name={name}"
        ))
        .await?;
    Ok(list
        .into_iter()
        .map(|r| Record {
            id: r["id"].as_str().unwrap_or("").to_owned(),
            kind: r["type"].as_str().unwrap_or("").to_owned(),
            content: unquote(r["content"].as_str().unwrap_or("")),
            comment: r["comment"].as_str().unwrap_or("").to_owned(),
        })
        .collect())
}

/// Puts `content` in place as the one record of its kind and name that
/// `ours` picks, made new when none is.
pub async fn upsert(
    cf: &Cloudflare<'_>,
    zone: &str,
    mut body: Value,
    ours: impl Fn(&Record) -> bool,
) -> Result<()> {
    let kind = body["type"].as_str().unwrap_or("").to_owned();
    let name = body["name"].as_str().unwrap_or("").to_owned();
    let content = body["content"].as_str().unwrap_or("").to_owned();
    body["ttl"] = json!(1);
    if body.get("comment").is_none() {
        body["comment"] = json!(MARK);
    }
    let existing = records(cf, zone, &kind, &name).await?;
    if let Some(old) = existing.iter().find(|r| ours(r)) {
        if old.content.eq_ignore_ascii_case(&content) && old.comment == MARK {
            return Ok(());
        }
        let _: Value = cf
            .request(
                Method::PUT,
                &format!("/zones/{zone}/dns_records/{}", old.id),
                Some(body),
            )
            .await?;
        return Ok(());
    }
    let _: Value = cf
        .request(
            Method::POST,
            &format!("/zones/{zone}/dns_records"),
            Some(body),
        )
        .await?;
    Ok(())
}

pub async fn remove(
    cf: &Cloudflare<'_>,
    zone: &str,
    kind: &str,
    name: &str,
    ours: impl Fn(&Record) -> bool,
) -> Result<()> {
    for r in records(cf, zone, kind, name).await? {
        if ours(&r) {
            let _: Value = cf
                .request(
                    Method::DELETE,
                    &format!("/zones/{zone}/dns_records/{}", r.id),
                    None,
                )
                .await?;
        }
    }
    Ok(())
}

/// The domain's SPF with what this setup needs in it and what it no longer
/// needs taken out; anything else in it is kept.
pub fn merge_spf(existing: &str, want: &[String], drop: &[String]) -> String {
    let terms: Vec<&str> = existing.split_whitespace().collect();
    let terms: &[&str] = if terms
        .first()
        .is_some_and(|t| t.eq_ignore_ascii_case("v=spf1"))
    {
        &terms[1..]
    } else {
        &[]
    };
    let mut out = vec!["v=spf1".to_owned()];
    let mut all = "~all".to_owned();
    let mut redirect = None;
    for t in terms {
        let lt = t.to_ascii_lowercase();
        if drop.contains(&lt) {
            continue;
        }
        if lt.ends_with("all") && lt.len() <= 4 {
            all = (*t).to_owned();
        } else if lt.starts_with("redirect=") {
            redirect = Some((*t).to_owned());
        } else if !out.iter().any(|o| o.eq_ignore_ascii_case(t)) {
            out.push((*t).to_owned());
        }
    }
    for w in want {
        if !out.iter().any(|o| o.eq_ignore_ascii_case(w)) {
            out.push(w.clone());
        }
    }
    out.push(redirect.unwrap_or(all));
    out.join(" ")
}

pub async fn spf(
    cf: &Cloudflare<'_>,
    zone: &str,
    domain: &str,
    want: &[String],
    drop: &[String],
) -> Result<String> {
    let found: Vec<Record> = records(cf, zone, "TXT", domain)
        .await?
        .into_iter()
        .filter(|r| r.content.starts_with("v=spf1"))
        .collect();
    // Two SPF records fail every check, as Email Routing can leave beside
    // one already there; they are made one.
    let joined = found
        .iter()
        .map(|r| r.content.as_str())
        .collect::<Vec<_>>()
        .join(" ")
        .replace(" v=spf1", "");
    let merged = merge_spf(&joined, want, drop);
    for extra in found.iter().skip(1) {
        let _: Value = cf
            .request(
                Method::DELETE,
                &format!("/zones/{zone}/dns_records/{}", extra.id),
                None,
            )
            .await?;
    }
    if found.len() == 1 && found[0].content == merged {
        return Ok(merged);
    }
    upsert(
        cf,
        zone,
        json!({ "type": "TXT", "name": domain, "content": merged }),
        |r| r.content.starts_with("v=spf1"),
    )
    .await?;
    Ok(merged)
}

/// A DMARC policy, when the domain has none of its own.
pub async fn dmarc(cf: &Cloudflare<'_>, zone: &str, domain: &str) -> Result<String> {
    let name = format!("_dmarc.{domain}");
    if let Some(r) = records(cf, zone, "TXT", &name)
        .await?
        .into_iter()
        .find(|r| r.content.starts_with("v=DMARC1"))
    {
        return Ok(r.content);
    }
    let policy = "v=DMARC1; p=quarantine; adkim=r; aspf=r";
    upsert(
        cf,
        zone,
        json!({ "type": "TXT", "name": name, "content": policy }),
        |_| false,
    )
    .await?;
    Ok(policy.into())
}

// ---- Email Routing ----

pub async fn routing_on(cf: &Cloudflare<'_>, zone: &str) -> Result<bool> {
    let r: Value = cf
        .request(Method::GET, &format!("/zones/{zone}/email/routing"), None)
        .await?;
    Ok(r["enabled"].as_bool().unwrap_or(false))
}

/// Email Routing on, which publishes Cloudflare's MX and SPF records.
pub async fn enable_routing(cf: &Cloudflare<'_>, zone: &str, domain: &str) -> Result<()> {
    if routing_on(cf, zone).await.unwrap_or(false) {
        return Ok(());
    }
    let first: Result<Value> = cf
        .request(
            Method::POST,
            &format!("/zones/{zone}/email/routing/dns"),
            Some(json!({ "name": domain })),
        )
        .await;
    if let Err(err) = first {
        let older: Result<Value> = cf
            .request(
                Method::POST,
                &format!("/zones/{zone}/email/routing/enable"),
                Some(json!({})),
            )
            .await;
        older.map_err(|_| err)?;
    }
    Ok(())
}

/// Email Routing off, taking Cloudflare's MX records with it.
pub async fn disable_routing(cf: &Cloudflare<'_>, zone: &str) -> Result<()> {
    if !routing_on(cf, zone).await.unwrap_or(false) {
        return Ok(());
    }
    let first: Result<Value> = cf
        .request(
            Method::DELETE,
            &format!("/zones/{zone}/email/routing/dns"),
            None,
        )
        .await;
    if let Err(err) = first {
        let older: Result<Value> = cf
            .request(
                Method::POST,
                &format!("/zones/{zone}/email/routing/disable"),
                Some(json!({})),
            )
            .await;
        older.map_err(|_| err)?;
    }
    Ok(())
}

pub async fn catch_all(cf: &Cloudflare<'_>, zone: &str, on: bool) -> Result<()> {
    let body = if on {
        json!({
            "name": "mail",
            "enabled": true,
            "matchers": [{ "type": "all" }],
            "actions": [{ "type": "worker", "value": [WORKER] }],
        })
    } else {
        json!({
            "enabled": false,
            "matchers": [{ "type": "all" }],
            "actions": [{ "type": "drop" }],
        })
    };
    let _: Value = cf
        .request(
            Method::PUT,
            &format!("/zones/{zone}/email/routing/rules/catch_all"),
            Some(body),
        )
        .await?;
    Ok(())
}

/// Deploys the Worker Email Routing hands mail to, which posts it to
/// `url` with `secret`.
pub async fn deploy_worker(
    cf: &Cloudflare<'_>,
    account: &str,
    url: &str,
    secret: &str,
) -> Result<()> {
    let meta = json!({
        "main_module": "inbound.js",
        "compatibility_date": "2025-06-01",
        "bindings": [
            { "type": "plain_text", "name": "INBOUND_URL", "text": url },
            { "type": "secret_text", "name": "INBOUND_SECRET", "text": secret },
        ],
    });
    let boundary = format!("mail{}", crate::util::random_hex(12));
    let mut body = Vec::new();
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"metadata\"\r\nContent-Type: application/json\r\n\r\n{meta}\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"inbound.js\"; filename=\"inbound.js\"\r\nContent-Type: application/javascript+module\r\n\r\n{WORKER_JS}\r\n--{boundary}--\r\n"
        )
        .as_bytes(),
    );
    cf.put_form(
        &format!("/accounts/{account}/workers/scripts/{WORKER}"),
        &boundary,
        body,
    )
    .await
}

// ---- Email Sending ----

/// Email Sending on for the domain, and the records it asks for published.
pub async fn enable_sending(cf: &Cloudflare<'_>, zone: &str, domain: &str) -> Result<()> {
    let list: Vec<Value> = cf
        .request(
            Method::GET,
            &format!("/zones/{zone}/email/sending/subdomains"),
            None,
        )
        .await?;
    let found = list.into_iter().find(|d| {
        d["name"]
            .as_str()
            .is_some_and(|n| n.eq_ignore_ascii_case(domain))
    });
    let entry = match found {
        Some(d) => d,
        None => {
            cf.request(
                Method::POST,
                &format!("/zones/{zone}/email/sending/subdomains"),
                Some(json!({ "name": domain })),
            )
            .await?
        }
    };
    let tag = entry["tag"].as_str().unwrap_or("").to_owned();
    let wanted: Vec<Value> = cf
        .request(
            Method::GET,
            &format!("/zones/{zone}/email/sending/subdomains/{tag}/dns"),
            None,
        )
        .await?;
    for r in wanted {
        let kind = r["type"].as_str().unwrap_or("").to_owned();
        let mut name = r["name"].as_str().unwrap_or("").to_owned();
        if name.is_empty() || name == "@" {
            name = domain.to_owned();
        } else if name != domain && !name.ends_with(&format!(".{domain}")) {
            name = format!("{name}.{domain}");
        }
        let content = unquote(r["content"].as_str().unwrap_or(""));
        // The domain's own SPF and DMARC are kept by the setup itself.
        let lower = content.to_ascii_lowercase();
        if kind == "TXT"
            && ((lower.starts_with("v=spf1") && name == domain) || lower.starts_with("v=dmarc1"))
        {
            continue;
        }
        let have = records(cf, zone, &kind, &name).await?;
        if have
            .iter()
            .any(|h| h.content.eq_ignore_ascii_case(&content))
        {
            continue;
        }
        let mut body =
            json!({ "type": kind, "name": name, "content": content, "ttl": 1, "comment": MARK });
        if let Some(p) = r["priority"].as_u64() {
            body["priority"] = json!(p);
        }
        let _: Value = cf
            .request(
                Method::POST,
                &format!("/zones/{zone}/dns_records"),
                Some(body),
            )
            .await?;
    }
    Ok(())
}

/// Sends a whole message; the recipients Cloudflare says bounced.
pub async fn send_raw(
    mail: &Mail,
    from: &str,
    rcpts: &[String],
    text: &str,
) -> Result<Vec<String>> {
    let s = settings(mail)?;
    let cf = Cloudflare::new(&mail.state.http, &s.token);
    let out: Value = cf
        .request(
            Method::POST,
            &format!("/accounts/{}/email/sending/send_raw", s.account_id),
            Some(json!({ "from": from, "recipients": rcpts, "mime_message": text })),
        )
        .await?;
    Ok(out["permanent_bounces"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spf_keeps_what_others_put_in_it() {
        let want = vec!["a:mail.example.com".to_owned()];
        let drop = vec![CLOUDFLARE_SPF.to_owned()];
        assert_eq!(
            merge_spf(
                "v=spf1 include:_spf.mx.cloudflare.net include:other.example.net -all",
                &want,
                &drop
            ),
            "v=spf1 include:other.example.net a:mail.example.com -all"
        );
        assert_eq!(merge_spf("", &want, &[]), "v=spf1 a:mail.example.com ~all");
        assert_eq!(
            merge_spf(
                "v=spf1 a:mail.example.com redirect=_spf.example.net",
                &want,
                &[]
            ),
            "v=spf1 a:mail.example.com redirect=_spf.example.net"
        );
    }
}
