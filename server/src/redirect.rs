//! A domain's redirects, as many as are wanted: each a hostname, and a path if
//! given, that the gateway answers with a redirect to another address. Each
//! hostname is pointed at the tunnel, so Cloudflare needs no redirect rules.

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, StatusCode, Uri};
use axum::response::Response;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::cloudflare::Cloudflare;
use crate::db::Db;
use crate::mailserver::Domain;
use crate::state::AppState;
use crate::tunnel;
use crate::util::{random_hex, ApiError, ApiResult};

#[derive(Clone, Serialize, Deserialize)]
pub struct Redirect {
    pub id: String,
    /// The full hostname it answers on.
    pub host: String,
    /// Empty for every path, `/old` for that path, `/old/*` for it and below.
    #[serde(default)]
    pub path: String,
    /// The address it goes to.
    pub to: String,
    #[serde(default)]
    pub permanent: bool,
    /// Carries the rest of the path and the query on to `to`.
    #[serde(default)]
    pub keep_path: bool,
    pub domain: String,
    /// The CNAME made for its hostname, removed with the last redirect on it.
    #[serde(default)]
    pub dns_record_id: Option<String>,
}

const KEY: &str = "redirects";

pub fn load(db: &Db) -> Vec<Redirect> {
    db.setting(KEY)
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_default()
}

fn save(state: &AppState, list: &[Redirect]) -> ApiResult<()> {
    state.db.set_setting(
        KEY,
        &serde_json::to_string(list).map_err(anyhow::Error::from)?,
    )?;
    state.reload()?;
    Ok(())
}

/// The hostnames redirects answer on, each once.
pub fn hosts(list: &[Redirect]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for r in list {
        if !out.contains(&r.host) {
            out.push(r.host.clone());
        }
    }
    out
}

/// How closely `r` matches `path`, if it does: a whole path over a path and
/// below, the longer the closer, and every path last.
fn closeness(r: &Redirect, path: &str) -> Option<usize> {
    if r.path.is_empty() {
        return Some(0);
    }
    if let Some(prefix) = r.path.strip_suffix('*') {
        let bare = prefix.trim_end_matches('/');
        return (path.starts_with(prefix) || path == bare).then_some(1 + prefix.len());
    }
    let trim = |p: &str| p.trim_end_matches('/').to_owned();
    (trim(path) == trim(&r.path)).then_some(usize::MAX)
}

/// The redirect a request to `host` and `path` gets, if any.
pub fn find<'a>(list: &'a [Redirect], host: &str, path: &str) -> Option<&'a Redirect> {
    list.iter()
        .filter(|r| r.host.eq_ignore_ascii_case(host))
        .filter_map(|r| closeness(r, path).map(|c| (c, r)))
        .max_by_key(|(c, _)| *c)
        .map(|(_, r)| r)
}

/// Where `r` sends a request for `path` and `query`.
fn location(r: &Redirect, path: &str, query: Option<&str>) -> String {
    let mut to = r.to.clone();
    if !r.keep_path {
        return to;
    }
    let rest = match r.path.strip_suffix('*') {
        Some(prefix) => path.strip_prefix(prefix).unwrap_or(""),
        None if r.path.is_empty() => path,
        None => "",
    };
    let rest = rest.trim_start_matches('/');
    if !rest.is_empty() {
        if !to.ends_with('/') {
            to.push('/');
        }
        to.push_str(rest);
    }
    if let Some(q) = query.filter(|q| !q.is_empty()) {
        to.push(if to.contains('?') { '&' } else { '?' });
        to.push_str(q);
    }
    to
}

pub fn answer(r: &Redirect, uri: &Uri) -> Response {
    let code = if r.permanent {
        StatusCode::MOVED_PERMANENTLY
    } else {
        StatusCode::FOUND
    };
    let to = location(r, uri.path(), uri.query());
    Response::builder()
        .status(code)
        .header(header::LOCATION, to)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::empty())
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

fn domain(name: &str) -> ApiResult<Domain> {
    crate::mailserver::get()
        .ok_or_else(ApiError::not_found)?
        .settings()
        .domains
        .into_iter()
        .find(|d| d.name.eq_ignore_ascii_case(name))
        .ok_or_else(ApiError::not_found)
}

pub async fn list(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> ApiResult<Json<Value>> {
    let d = domain(&name)?;
    let list: Vec<Redirect> = load(&state.db)
        .into_iter()
        .filter(|r| r.domain == d.name)
        .collect();
    Ok(Json(json!({ "redirects": list })))
}

#[derive(Deserialize)]
pub struct RedirectIn {
    host: String,
    #[serde(default)]
    path: String,
    to: String,
    #[serde(default)]
    permanent: bool,
    #[serde(default)]
    keep_path: bool,
}

/// The redirect as it is kept: its hostname in full within the domain, its
/// path tidy and its address whole.
fn checked(d: &Domain, r: &RedirectIn) -> ApiResult<(String, String, String)> {
    let host = r.host.trim().trim_end_matches('.').to_ascii_lowercase();
    let host = match host.as_str() {
        "" | "@" => d.name.clone(),
        h if h == d.name || h.ends_with(&format!(".{}", d.name)) => h.to_owned(),
        h => format!("{h}.{}", d.name),
    };
    let label_ok = |l: &str| {
        !l.is_empty() && l.len() <= 63 && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    };
    if host.len() > 253 || !host.split('.').all(label_ok) {
        return Err(ApiError::bad("That name cannot be used"));
    }
    let path = r.path.trim();
    let path = match path {
        "" | "/*" | "*" => String::new(),
        p if p.starts_with('/') => p.to_owned(),
        p => format!("/{p}"),
    };
    if path.contains(char::is_whitespace) || path.strip_suffix('*').unwrap_or(&path).contains('*') {
        return Err(ApiError::bad("A path can end in * and has no spaces"));
    }
    let to = r.to.trim();
    let to = if to.contains("://") {
        to.to_owned()
    } else {
        format!("https://{to}")
    };
    let url = reqwest::Url::parse(&to).map_err(|_| ApiError::bad("Enter the address to go to"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(ApiError::bad("Enter the address to go to"));
    }
    if url.host_str() == Some(host.as_str()) && path.is_empty() {
        return Err(ApiError::bad("It would go round to itself"));
    }
    Ok((host, path, to))
}

/// Points `host` at the tunnel, unless it already is. The record's ID comes
/// back when it was made here.
async fn point(state: &AppState, d: &Domain, host: &str) -> ApiResult<Option<String>> {
    if !d.on_cloudflare() {
        return Err(ApiError::bad("Redirects need the domain on Cloudflare"));
    }
    let cf_settings = state.cloudflare()?;
    let cf = Cloudflare::new(&state.http, &cf_settings.token);
    let target = format!("{}.cfargotunnel.com", cf_settings.tunnel_id);
    match cf.find_dns(&d.zone_id, host).await? {
        Some(record) if record.content == target => Ok(None),
        Some(record) => Err(ApiError::conflict(format!(
            "{host} already has a {} record. Remove it in DNS first.",
            record.kind
        ))),
        None => Ok(Some(cf.create_cname(&d.zone_id, host, &target).await?.id)),
    }
}

/// Removes the record made for `r`'s hostname once nothing answers on it.
async fn unpoint(state: &AppState, d: &Domain, r: &Redirect, list: &[Redirect]) {
    let Some(id) = &r.dns_record_id else {
        return;
    };
    if state.snapshot().routes.contains_key(&r.host) {
        return;
    }
    // Another redirect on the hostname takes the record on.
    if let Some(other) = list.iter().find(|o| o.host == r.host && o.id != r.id) {
        let mut all = load(&state.db);
        if let Some(o) = all.iter_mut().find(|o| o.id == other.id) {
            o.dns_record_id = Some(id.clone());
        }
        let _ = save(state, &all);
        return;
    }
    if let Ok(cf) = state.cloudflare() {
        if let Err(e) = Cloudflare::new(&state.http, &cf.token)
            .delete_dns(&d.zone_id, id)
            .await
        {
            tracing::warn!("could not delete DNS for {}: {e:#}", r.host);
        }
    }
}

async fn publish(state: &AppState) -> ApiResult<()> {
    tunnel::sync_ingress(state).await?;
    Ok(())
}

pub async fn create(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(body): Json<RedirectIn>,
) -> ApiResult<Json<Value>> {
    let d = domain(&name)?;
    let (host, path, to) = checked(&d, &body)?;
    let mut list = load(&state.db);
    if list.iter().any(|r| r.host == host && r.path == path) {
        return Err(ApiError::conflict("That address already redirects"));
    }
    let dns_record_id = if list.iter().any(|r| r.host == host) {
        None
    } else {
        point(&state, &d, &host).await?
    };
    let r = Redirect {
        id: random_hex(8),
        host,
        path,
        to,
        permanent: body.permanent,
        keep_path: body.keep_path,
        domain: d.name.clone(),
        dns_record_id,
    };
    list.push(r.clone());
    save(&state, &list)?;
    if let Err(err) = publish(&state).await {
        list.retain(|x| x.id != r.id);
        save(&state, &list)?;
        unpoint(&state, &d, &r, &list).await;
        return Err(err);
    }
    tracing::info!("{}{} redirects to {}", r.host, r.path, r.to);
    list_of(&state, &d)
}

pub async fn update(
    State(state): State<AppState>,
    Path((name, id)): Path<(String, String)>,
    Json(body): Json<RedirectIn>,
) -> ApiResult<Json<Value>> {
    let d = domain(&name)?;
    let (host, path, to) = checked(&d, &body)?;
    let mut list = load(&state.db);
    let before = list
        .iter()
        .find(|r| r.id == id && r.domain == d.name)
        .cloned()
        .ok_or_else(ApiError::not_found)?;
    if list
        .iter()
        .any(|r| r.id != id && r.host == host && r.path == path)
    {
        return Err(ApiError::conflict("That address already redirects"));
    }
    let moved = host != before.host;
    let dns_record_id = if !moved {
        before.dns_record_id.clone()
    } else if list.iter().any(|r| r.host == host) {
        None
    } else {
        point(&state, &d, &host).await?
    };
    let after = Redirect {
        host,
        path,
        to,
        permanent: body.permanent,
        keep_path: body.keep_path,
        dns_record_id,
        ..before.clone()
    };
    if let Some(r) = list.iter_mut().find(|r| r.id == id) {
        *r = after.clone();
    }
    save(&state, &list)?;
    if moved {
        if let Err(err) = publish(&state).await {
            if let Some(r) = list.iter_mut().find(|r| r.id == id) {
                *r = before.clone();
            }
            save(&state, &list)?;
            unpoint(&state, &d, &after, &list).await;
            return Err(err);
        }
        let others: Vec<Redirect> = list.iter().filter(|r| r.id != id).cloned().collect();
        unpoint(&state, &d, &before, &others).await;
    }
    list_of(&state, &d)
}

pub async fn remove(
    State(state): State<AppState>,
    Path((name, id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let d = domain(&name)?;
    let mut list = load(&state.db);
    let r = list
        .iter()
        .find(|r| r.id == id && r.domain == d.name)
        .cloned()
        .ok_or_else(ApiError::not_found)?;
    list.retain(|x| x.id != id);
    save(&state, &list)?;
    unpoint(&state, &d, &r, &list).await;
    if state.cloudflare().is_ok() {
        publish(&state).await?;
    }
    tracing::info!("removed the redirect from {}{}", r.host, r.path);
    list_of(&state, &d)
}

fn list_of(state: &AppState, d: &Domain) -> ApiResult<Json<Value>> {
    let list: Vec<Redirect> = load(&state.db)
        .into_iter()
        .filter(|r| r.domain == d.name)
        .collect();
    Ok(Json(json!({ "redirects": list })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(path: &str, to: &str, keep: bool) -> Redirect {
        Redirect {
            id: path.into(),
            host: "a.example.com".into(),
            path: path.into(),
            to: to.into(),
            permanent: false,
            keep_path: keep,
            domain: "example.com".into(),
            dns_record_id: None,
        }
    }

    #[test]
    fn the_closest_path_wins() {
        let list = [
            r("", "https://x.com", false),
            r("/blog/*", "https://blog.x.com", true),
            r("/blog/old", "https://x.com/new", false),
        ];
        let to = |p: &str| find(&list, "a.example.com", p).map(|r| r.to.clone());
        assert_eq!(to("/"), Some("https://x.com".into()));
        assert_eq!(to("/blog/a"), Some("https://blog.x.com".into()));
        assert_eq!(to("/blog"), Some("https://blog.x.com".into()));
        assert_eq!(to("/blog/old/"), Some("https://x.com/new".into()));
        assert!(find(&list, "b.example.com", "/").is_none());
    }

    #[test]
    fn the_rest_of_the_path_carries_on() {
        let all = r("", "https://x.com", true);
        assert_eq!(location(&all, "/a/b", Some("q=1")), "https://x.com/a/b?q=1");
        let blog = r("/blog/*", "https://x.com/posts/", true);
        assert_eq!(location(&blog, "/blog/hi", None), "https://x.com/posts/hi");
        let plain = r("/blog/*", "https://x.com", false);
        assert_eq!(location(&plain, "/blog/hi", Some("q=1")), "https://x.com");
    }
}
