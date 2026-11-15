//! A domain's DNS records, to see and change: its real zone on Cloudflare,
//! Porkbun, GoDaddy or Namecheap. Mail's own records are listed beside them
//! when DNS does not have them yet. A domain whose DNS is elsewhere lists the
//! records mail needs there, each checked against DNS.

use std::net::{Ipv4Addr, Ipv6Addr};

use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use super::{mail, wanted, Domain};
use crate::registrar::{self, Record, Zone, KINDS};
use crate::state::AppState;
use crate::util::{ApiError, ApiResult};

fn domain(name: &str) -> ApiResult<Domain> {
    mail()?
        .settings()
        .domains
        .into_iter()
        .find(|d| d.name.eq_ignore_ascii_case(name))
        .ok_or_else(ApiError::not_found)
}

/// Where the domain's records really are, when they can be changed here.
fn zone(d: &Domain) -> Option<Zone<'_>> {
    if d.on_cloudflare() {
        Some(Zone::Cloudflare(&d.zone_id))
    } else if registrar::HOSTS.contains(&d.host.as_str()) {
        Some(Zone::Registrar(&d.host))
    } else {
        None
    }
}

fn row(r: &Record, missing: bool) -> Value {
    json!({
        "id": r.id, "kind": r.kind, "name": r.name, "content": r.content,
        "priority": r.priority, "ttl": r.ttl, "missing": missing,
    })
}

pub async fn list(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> ApiResult<Json<Value>> {
    let d = domain(&name)?;
    let mail = mail()?;
    let s = mail.settings();
    let needed = if s.on {
        wanted(&mail, &s, &d).await?
    } else {
        Vec::new()
    };
    let need = |w: &super::Want| Record {
        id: String::new(),
        kind: w.kind.to_owned(),
        name: w.name.clone(),
        content: w.value.clone(),
        priority: w.priority,
        ttl: 0,
    };
    let Some(z) = zone(&d) else {
        let rows: Vec<Value> = needed.iter().map(|w| row(&need(w), !w.found)).collect();
        return Ok(Json(json!({ "editable": false, "records": rows })));
    };
    let mut rows: Vec<Value> = registrar::list(&state, z, &d.name)
        .await?
        .iter()
        .map(|r| row(r, false))
        .collect();
    rows.extend(
        needed
            .iter()
            .filter(|w| !w.found)
            .map(|w| row(&need(w), true)),
    );
    Ok(Json(json!({ "editable": true, "records": rows })))
}

#[derive(Deserialize)]
pub struct RecordIn {
    kind: String,
    name: String,
    content: String,
    priority: Option<u16>,
}

/// The record as it is written: its type known, its name in full within the
/// domain, and its value right for its type.
fn checked(d: &Domain, r: RecordIn) -> ApiResult<Record> {
    let kind = r.kind.trim().to_ascii_uppercase();
    if !KINDS.contains(&kind.as_str()) {
        return Err(ApiError::bad("Pick a record type"));
    }
    let name = r.name.trim().trim_end_matches('.').to_ascii_lowercase();
    let name = match name.as_str() {
        "" | "@" => d.name.clone(),
        n if n == d.name || n.ends_with(&format!(".{}", d.name)) => n.to_owned(),
        n => format!("{n}.{}", d.name),
    };
    let label_ok = |l: &str| {
        !l.is_empty()
            && l.len() <= 63
            && l.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'*')
    };
    if name.len() > 253 || !name.split('.').all(label_ok) {
        return Err(ApiError::bad("That name cannot be used in DNS"));
    }
    let content = r.content.trim().to_owned();
    let ok = match kind.as_str() {
        "A" => content.parse::<Ipv4Addr>().is_ok(),
        "AAAA" => content.parse::<Ipv6Addr>().is_ok(),
        "TXT" => !content.is_empty() && content.len() <= 2048,
        _ => !content.is_empty() && !content.contains(' '),
    };
    if !ok {
        return Err(ApiError::bad(match kind.as_str() {
            "A" => "Enter an IPv4 address",
            "AAAA" => "Enter an IPv6 address",
            _ => "Enter a value",
        }));
    }
    let content = if matches!(kind.as_str(), "CNAME" | "MX") {
        content.trim_end_matches('.').to_ascii_lowercase()
    } else {
        content
    };
    let priority = (kind == "MX").then(|| r.priority.unwrap_or(10));
    Ok(Record {
        id: String::new(),
        kind,
        name,
        content,
        priority,
        ttl: 1,
    })
}

async fn change(
    state: &AppState,
    name: &str,
    old: Option<&str>,
    body: Option<RecordIn>,
) -> ApiResult<()> {
    let d = domain(name)?;
    let z = zone(&d).ok_or_else(|| ApiError::bad("This domain's DNS is not changed here"))?;
    match body {
        Some(b) => registrar::save(state, z, &d.name, old, &checked(&d, b)?).await?,
        None => registrar::remove(state, z, &d.name, old.unwrap_or_default()).await?,
    }
    Ok(())
}

pub async fn create(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(body): Json<RecordIn>,
) -> ApiResult<Json<Value>> {
    change(&state, &name, None, Some(body)).await?;
    list(State(state), Path(name)).await
}

pub async fn update(
    State(state): State<AppState>,
    Path((name, id)): Path<(String, String)>,
    Json(body): Json<RecordIn>,
) -> ApiResult<Json<Value>> {
    change(&state, &name, Some(&id), Some(body)).await?;
    list(State(state), Path(name)).await
}

pub async fn remove(
    State(state): State<AppState>,
    Path((name, id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    change(&state, &name, Some(&id), None).await?;
    list(State(state), Path(name)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d() -> Domain {
        Domain {
            name: "example.com".into(),
            zone_id: "z".into(),
            managers: Vec::new(),
            host: String::new(),
        }
    }

    fn rec(kind: &str, name: &str, content: &str) -> RecordIn {
        RecordIn {
            kind: kind.into(),
            name: name.into(),
            content: content.into(),
            priority: None,
        }
    }

    #[test]
    fn records_are_checked() {
        let r = checked(&d(), rec("a", "@", "1.2.3.4")).unwrap();
        assert_eq!((r.kind.as_str(), r.name.as_str()), ("A", "example.com"));
        assert_eq!(
            checked(&d(), rec("CNAME", "www", "Host.Example.net."))
                .unwrap()
                .content,
            "host.example.net"
        );
        assert_eq!(
            checked(&d(), rec("MX", "", "mail.example.com"))
                .unwrap()
                .priority,
            Some(10)
        );
        assert_eq!(
            checked(&d(), rec("TXT", "_dmarc.example.com", "v=DMARC1"))
                .unwrap()
                .name,
            "_dmarc.example.com"
        );
        assert!(checked(&d(), rec("A", "@", "nope")).is_err());
        assert!(checked(&d(), rec("SRV", "@", "x")).is_err());
        assert!(checked(&d(), rec("A", "bad name", "1.2.3.4")).is_err());
    }
}
