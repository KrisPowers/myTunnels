//! Share links: a link to a file, a folder or a set of photos in Storage that
//! anyone can open without an account, until it expires, optionally behind a
//! password. Links open at the dashboard's tunnel address, under `/share/`,
//! which the gateway lets through without the tunnel's own access rules.

use std::net::IpAddr;

use axum::body::Body;
use axum::extract::{Path, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::db::Route;
use crate::permissions::Caller;
use crate::secret;
use crate::state::AppState;
use crate::storage::{is_media, segments, send_file, Store};
use crate::util::{cookie, now, random_alnum, random_hex, sha256_hex, ApiError, ApiResult};

const TOKEN_LEN: usize = 32;
const COOKIE: &str = "__gate_share";
const UNLOCK_TTL: i64 = 7 * 86_400;
/// The longest a link may last, in days; 0 asks for one that never expires.
const MAX_DAYS: i64 = 365;

/// A share as kept: what it opens, until when, and whose it is.
#[derive(Clone, Serialize)]
pub struct Share {
    pub id: String,
    #[serde(skip)]
    pub token_hash: String,
    /// What it opens: one folder, or one or more files.
    pub paths: Vec<String>,
    #[serde(skip)]
    pub password_hash: Option<String>,
    pub protected: bool,
    /// Unix seconds; `None` never expires.
    pub expires: Option<i64>,
    pub created_by: String,
    pub created_at: i64,
    pub opened: i64,
}

/// The dashboard's tunnel address, where links open.
fn address(state: &AppState) -> Option<String> {
    let snap = state.snapshot();
    let mut routes: Vec<&Route> = snap
        .routes
        .values()
        .filter(|r| r.enabled && r.target_scheme == "dashboard")
        .collect();
    routes.sort_by_key(|r| r.created_at);
    routes.first().map(|r| r.hostname.clone())
}

// ---- the dashboard's API ----

/// The caller's links; everyone's for an admin.
pub async fn list(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
) -> ApiResult<Json<Value>> {
    let all = state.db.shares()?;
    let mine: Vec<Share> = all
        .into_iter()
        .filter(|s| caller.is_admin() || s.created_by == caller.id())
        .collect();
    Ok(Json(json!({ "shares": mine, "address": address(&state) })))
}

#[derive(Deserialize)]
pub struct NewShare {
    paths: Vec<String>,
    #[serde(default)]
    password: String,
    /// Days until it expires; 0 never.
    #[serde(default)]
    days: i64,
}

/// Makes a link and returns it, shown this once.
pub async fn create(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Json(body): Json<NewShare>,
) -> ApiResult<Json<Value>> {
    if !caller.can("drive.view") {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "You don't have permission for this".into(),
        ));
    }
    let Some(host) = address(&state) else {
        return Err(ApiError::bad(
            "Add a route to this dashboard on Routes first; links open at its address",
        ));
    };
    if body.paths.is_empty() || body.paths.len() > 500 {
        return Err(ApiError::bad("Share between 1 and 500 items"));
    }
    if !(0..=MAX_DAYS).contains(&body.days) {
        return Err(ApiError::bad("A link lasts up to a year"));
    }
    let store = Store::open(&state, caller.id())?;
    let mut paths = Vec::new();
    for path in &body.paths {
        let rel = segments(path)?;
        let real = store.real(&rel)?;
        if rel.is_empty() || !real.exists() {
            return Err(ApiError::bad(format!("{path} is not there")));
        }
        if real.is_dir() && body.paths.len() > 1 {
            return Err(ApiError::bad("Share one folder at a time"));
        }
        paths.push(rel.join("/"));
    }
    let token = random_alnum(TOKEN_LEN);
    let password = body.password.trim();
    let share = Share {
        id: random_hex(8),
        token_hash: sha256_hex(&token),
        paths,
        password_hash: if password.is_empty() {
            None
        } else {
            Some(secret::hash(password)?)
        },
        protected: !password.is_empty(),
        expires: (body.days > 0).then(|| now() + body.days * 86_400),
        created_by: caller.id().to_owned(),
        created_at: now(),
        opened: 0,
    };
    state.db.add_share(&share)?;
    Ok(Json(
        json!({ "share": share, "url": format!("https://{host}/share/{token}") }),
    ))
}

/// Ends a link: the caller's own, or anyone's for an admin.
pub async fn remove(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let share = state
        .db
        .shares()?
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(ApiError::not_found)?;
    if !caller.is_admin() && share.created_by != caller.id() {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Only its owner or an admin ends this link".into(),
        ));
    }
    state.db.delete_share(&id)?;
    Ok(Json(json!({ "ok": true })))
}

// ---- the link itself, at the dashboard's tunnel ----

#[derive(Deserialize, Default)]
struct Query {
    /// A file within the share, or a folder within a shared folder.
    #[serde(default)]
    p: String,
    #[serde(default)]
    inline: bool,
}

/// Answers `/share/<token>[/file|/thumb]`, with no account and no access rules.
pub async fn serve(state: &AppState, ip: Option<IpAddr>, req: Request) -> Response {
    let path = req.uri().path().to_owned();
    let mut parts = path.trim_start_matches("/share/").splitn(2, '/');
    let token = parts.next().unwrap_or_default().to_owned();
    let what = parts.next().unwrap_or_default().to_owned();
    let share = state
        .db
        .share_by_token(&sha256_hex(&token))
        .ok()
        .flatten()
        .filter(|s| s.expires.is_none_or(|e| e > now()));
    let Some(share) = share else {
        return page(
            StatusCode::NOT_FOUND,
            "Link not found",
            "<p>This link has expired or was ended by its owner.</p>",
        );
    };
    let from = ip.map(|ip| ip.to_string()).unwrap_or_default();
    if let Some(hash) = &share.password_hash {
        if req.method() == Method::POST {
            return unlock(state, &share, hash, &token, &from, req).await;
        }
        if !unlocked(state, &share, hash, req.headers()) {
            return password_page(&token, "");
        }
    }
    let query: Query = req
        .uri()
        .query()
        .and_then(|q| serde_urlencoded::from_str(q).ok())
        .unwrap_or_default();
    let result = match what.as_str() {
        "" => listing(state, &share, &token, &query.p),
        "file" => file(state, &share, &query.p, query.inline, req).await,
        "thumb" => thumb(state, &share, &query.p, req).await,
        _ => Err(ApiError::not_found()),
    };
    result.unwrap_or_else(|e| page(e.0, "Not here", &format!("<p>{}</p>", escape(&e.1))))
}

fn unlocked(state: &AppState, share: &Share, hash: &str, headers: &HeaderMap) -> bool {
    cookie(headers, COOKIE)
        .and_then(|v| state.session(&state.pass_sessions, v))
        .is_some_and(|s| s.subject == format!("share:{}", share.id) && s.tag == secret::tag(hash))
}

async fn unlock(
    state: &AppState,
    share: &Share,
    hash: &str,
    token: &str,
    from: &str,
    req: Request,
) -> Response {
    let key = format!("share:{}:{from}", share.id);
    if state.locked_out(&key) {
        return password_page(
            token,
            "Too many wrong tries. Wait 30 minutes and try again.",
        );
    }
    let bytes = axum::body::to_bytes(req.into_body(), 4096)
        .await
        .unwrap_or_default();
    let password = serde_urlencoded::from_bytes::<Vec<(String, String)>>(&bytes)
        .ok()
        .and_then(|pairs| pairs.into_iter().find(|(k, _)| k == "password"))
        .map(|(_, v)| v)
        .unwrap_or_default();
    if !secret::verify(&password, hash) {
        state.record_failure(&key);
        tokio::time::sleep(std::time::Duration::from_millis(700)).await;
        return password_page(token, "That password is not right.");
    }
    state.clear_failures(&key);
    let sid = state.open_session(
        &state.pass_sessions,
        &format!("share:{}", share.id),
        &secret::tag(hash),
        "",
        UNLOCK_TTL,
        false,
    );
    let mut response = (
        StatusCode::SEE_OTHER,
        [(header::LOCATION, format!("/share/{token}"))],
    )
        .into_response();
    if let Ok(value) = HeaderValue::from_str(&format!(
        "{COOKIE}={sid}; Path=/share/{token}; Max-Age={UNLOCK_TTL}; HttpOnly; Secure; SameSite=Lax"
    )) {
        response.headers_mut().insert(header::SET_COOKIE, value);
    }
    response
}

/// The shared path that `p` is, or is inside of, with `p` as its parts. A file
/// share opens only its own files; a folder share opens anything in the folder.
fn within(share: &Share, p: &str) -> ApiResult<Vec<String>> {
    let rel = segments(p)?;
    let ok = share.paths.iter().any(|shared| {
        let root = shared.split('/').map(str::to_owned).collect::<Vec<_>>();
        rel == root || (share.paths.len() == 1 && rel.starts_with(&root))
    });
    if ok {
        Ok(rel)
    } else {
        Err(ApiError::not_found())
    }
}

fn store(state: &AppState, share: &Share) -> ApiResult<Store> {
    Store::open(state, &share.created_by)
}

/// The page a link opens: its photos as a grid, its files as a list, a shared
/// folder's own folders to step into.
fn listing(state: &AppState, share: &Share, token: &str, p: &str) -> ApiResult<Response> {
    let store = store(state, share)?;
    let single_dir = share.paths.len() == 1
        && store
            .real(&segments(&share.paths[0])?)
            .is_ok_and(|r| r.is_dir());
    // What is shown: a folder's entries, or the shared files themselves.
    let (title, folders, files) = if single_dir {
        let rel = if p.is_empty() {
            segments(&share.paths[0])?
        } else {
            within(share, p)?
        };
        let dir = store.real(&rel)?;
        let mut folders = Vec::new();
        let mut files = Vec::new();
        for entry in std::fs::read_dir(&dir).map_err(crate::storage::io_error)? {
            let Ok(entry) = entry else { continue };
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name.ends_with(".mtpart") {
                continue;
            }
            let path = format!("{}/{name}", rel.join("/"));
            if entry.path().is_dir() {
                folders.push((name, path));
            } else {
                files.push((name, path, entry.metadata().map_or(0, |m| m.len())));
            }
        }
        folders.sort();
        files.sort();
        (rel.last().cloned().unwrap_or_default(), folders, files)
    } else {
        let files = share
            .paths
            .iter()
            .filter_map(|path| {
                let rel = segments(path).ok()?;
                let size = store.real(&rel).ok()?.metadata().ok()?.len();
                Some((rel.last()?.clone(), path.clone(), size))
            })
            .collect::<Vec<_>>();
        let title = if files.len() == 1 {
            files[0].0.clone()
        } else {
            format!("{} items", files.len())
        };
        (title, Vec::new(), files)
    };
    if p.is_empty() {
        let _ = state.db.count_share_open(&share.id);
    }
    let base = format!("/share/{token}");
    let link = |what: &str, path: &str, inline: bool| {
        format!(
            "{base}/{what}?p={}{}",
            crate::storage::encode(path),
            if inline { "&inline=true" } else { "" }
        )
    };
    let mut body = String::new();
    if !folders.is_empty() {
        body.push_str("<ul class=\"rows\">");
        for (name, path) in &folders {
            body.push_str(&format!(
                "<li><a href=\"{base}?p={}\"><span class=\"mark\">&#128193;</span>{}</a></li>",
                crate::storage::encode(path),
                escape(name)
            ));
        }
        body.push_str("</ul>");
    }
    let (pictures, others): (Vec<_>, Vec<_>) = files.iter().partition(|(name, ..)| is_media(name));
    if !pictures.is_empty() {
        body.push_str("<ul class=\"grid\">");
        for (name, path, _) in &pictures {
            body.push_str(&format!(
                "<li><a href=\"{}\" title=\"{}\"><img src=\"{}\" alt=\"\" loading=\"lazy\"></a></li>",
                link("file", path, true),
                escape(name),
                link("thumb", path, false)
            ));
        }
        body.push_str("</ul>");
    }
    if !others.is_empty() {
        body.push_str("<ul class=\"rows\">");
        for (name, path, size) in &others {
            body.push_str(&format!(
                "<li><a href=\"{}\"><span class=\"mark\">&#128196;</span>{}<small>{}</small></a></li>",
                link("file", path, false),
                escape(name),
                human(*size)
            ));
        }
        body.push_str("</ul>");
    }
    if folders.is_empty() && files.is_empty() {
        body.push_str("<p>Nothing here.</p>");
    }
    let until = match share.expires {
        Some(at) => format!(
            "<p class=\"note\">This link works for {} more.</p>",
            left(at - now())
        ),
        None => String::new(),
    };
    Ok(page(StatusCode::OK, &title, &format!("{until}{body}")))
}

async fn file(
    state: &AppState,
    share: &Share,
    p: &str,
    inline: bool,
    req: Request,
) -> ApiResult<Response> {
    let rel = within(share, p)?;
    let real = store(state, share)?.real(&rel)?;
    if !real.is_file() {
        return Err(ApiError::not_found());
    }
    let name = rel.last().cloned().unwrap_or_default();
    send_file(&real, &name, inline, req).await
}

async fn thumb(state: &AppState, share: &Share, p: &str, req: Request) -> ApiResult<Response> {
    let rel = within(share, p)?;
    let store = store(state, share)?;
    let thumb = store.thumb(&rel);
    let path = if thumb.is_file() {
        thumb
    } else {
        store.real(&rel)?
    };
    let name = rel.last().cloned().unwrap_or_default();
    send_file(&path, &name, true, req).await
}

fn human(size: u64) -> String {
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut value = size as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < units.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{size} B")
    } else {
        format!("{value:.1} {}", units[unit])
    }
}

fn left(seconds: i64) -> String {
    let days = seconds / 86_400;
    if days >= 1 {
        format!("{days} day{}", if days == 1 { "" } else { "s" })
    } else {
        let hours = (seconds / 3600).max(1);
        format!("{hours} hour{}", if hours == 1 { "" } else { "s" })
    }
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn password_page(token: &str, error: &str) -> Response {
    let error = if error.is_empty() {
        String::new()
    } else {
        format!("<p class=\"error\">{}</p>", escape(error))
    };
    page(
        StatusCode::UNAUTHORIZED,
        "Password required",
        &format!(
            "<p>Enter the password you were given with this link.</p>\
             <form method=\"post\" action=\"/share/{}\"><input type=\"password\" name=\"password\" \
             autocomplete=\"current-password\" autofocus required aria-label=\"Password\">\
             <button type=\"submit\">Open</button></form>{error}",
            escape(token)
        ),
    )
}

/// A whole page in the gate's look.
fn page(status: StatusCode, title: &str, body: &str) -> Response {
    let html = format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><meta name=\"robots\" content=\"noindex\">\
<title>{title}</title><style>{STYLE}</style></head><body><main><h1>{title}</h1>{body}</main></body></html>",
        title = escape(title),
    );
    let mut response = (status, Body::from(html)).into_response();
    let headers = response.headers_mut();
    for (name, value) in [
        (header::CONTENT_TYPE, "text/html; charset=utf-8"),
        (header::CACHE_CONTROL, "no-store"),
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        (header::X_FRAME_OPTIONS, "DENY"),
        (header::REFERRER_POLICY, "no-referrer"),
        (
            header::CONTENT_SECURITY_POLICY,
            "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        ),
    ] {
        headers.insert(name, HeaderValue::from_static(value));
    }
    response
}

const STYLE: &str = ":root{color-scheme:light dark;--bg:light-dark(#f0f4f9,#131314);--card:light-dark(#fff,#1e1f20);\
--text:light-dark(#1f1f1f,#e3e3e3);--muted:light-dark(#444746,#c4c7c5);--line:light-dark(#c4c7c5,#5e5e5e);\
--accent:light-dark(#0b57d0,#a8c7fa);--on-accent:light-dark(#fff,#062e6f);--bad:light-dark(#d93025,#f28b82)}\
*{box-sizing:border-box}body{margin:0;padding:24px 16px;background:var(--bg);color:var(--text);\
font:14px/1.5 Roboto,\"Segoe UI\",system-ui,sans-serif}main{max-width:960px;margin:0 auto;padding:28px;\
background:var(--card);border-radius:24px}h1{margin:0 0 12px;font-size:22px;font-weight:400;word-break:break-word}\
p{color:var(--muted)}.note{font-size:13px}.error{color:var(--bad)}a{color:inherit;text-decoration:none}\
.grid{list-style:none;margin:16px 0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:4px}\
.grid img{display:block;width:100%;aspect-ratio:1;object-fit:cover;border-radius:6px;background:var(--line)}\
.rows{list-style:none;margin:12px 0;padding:0}.rows a{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:8px}\
.rows a:hover{background:color-mix(in srgb,var(--accent) 8%,transparent)}.rows small{margin-left:auto;color:var(--muted)}\
form{display:flex;gap:8px;margin-top:16px}input{flex:1;height:44px;padding:0 14px;border:1px solid var(--line);\
border-radius:6px;background:transparent;color:var(--text);font:inherit}button{height:44px;padding:0 22px;border:0;\
border-radius:999px;background:var(--accent);color:var(--on-accent);font:500 14px Roboto,system-ui,sans-serif;cursor:pointer}";

#[cfg(test)]
mod tests {
    use super::*;

    fn share(paths: &[&str]) -> Share {
        Share {
            id: "s".into(),
            token_hash: String::new(),
            paths: paths.iter().map(|p| (*p).to_owned()).collect(),
            password_hash: None,
            protected: false,
            expires: None,
            created_by: "admin".into(),
            created_at: 0,
            opened: 0,
        }
    }

    #[test]
    fn a_folder_share_opens_only_what_is_inside_it() {
        let s = share(&["trips/2026"]);
        assert!(within(&s, "trips/2026/a.pdf").is_ok());
        assert!(within(&s, "trips/2025/a.pdf").is_err());
        assert!(within(&s, "trips/2026/../2025/a.pdf").is_err());
    }

    #[test]
    fn a_file_share_opens_only_its_own_files() {
        let s = share(&["a.jpg", "b.jpg"]);
        assert!(within(&s, "a.jpg").is_ok());
        assert!(within(&s, "c.jpg").is_err());
        assert!(within(&s, "a.jpg/x").is_err());
    }
}
