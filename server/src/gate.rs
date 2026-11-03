//! The access gateway. cloudflared sends every published hostname here; each request is
//! matched to its tunnel, checked against that tunnel's access rules, then forwarded.
//!
//! Every browser gets a device key the first time it opens any tunnel. The key lives
//! in a cookie on the tunnel's domain; tunnels on other domains fetch the same key
//! from the hub (the oldest tunnel's host) with a one-minute, one-use code, so one
//! browser is one device everywhere.

use std::net::IpAddr;
use std::time::Duration;

use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::db::{Device, Route, SignIn};
use crate::proxy;
use crate::state::{open_session, session, touch_session, AppState, Hop, Snapshot};
use crate::util::{cookie, now, random_alnum, random_hex, sha256_hex, ApiError, ApiResult};
use crate::{guard, secret};

pub const DEVICE_COOKIE: &str = "__gate_device";
const SESSION_COOKIE: &str = "__gate_session";
const PASS_COOKIE: &str = "__gate_pass";
const USER_COOKIE: &str = "__gate_user";
/// Set while a browser is away fetching its key, so one that keeps no cookies is not
/// sent round in circles.
const TRIED_COOKIE: &str = "__gate_tried";
const DEVICE_COOKIE_TTL: i64 = 400 * 86_400;
const DEVICE_SESSION_TTL: i64 = 30 * 86_400;
const PASS_TTL: i64 = 7 * 86_400;
/// The longest any sign-in lasts; each tunnel can ask for less.
const USER_TTL: i64 = 30 * 86_400;
const HOP_TTL: i64 = 60;
const TOKEN_LEN: usize = 256;
/// A device's ID: 256 letters and numbers, apart from its secret key, so the
/// dashboard can show and link it without the key ever leaving the browser.
pub const DEVICE_ID_LEN: usize = 256;
const MAX_PENDING: i64 = 100;
const MAX_SEEN: i64 = 500;
const TEMPLATE: &str = include_str!("gate.html");

/// Browser properties that should not change for the life of a device.
const FINGERPRINT_KEYS: [&str; 5] = [
    "platform",
    "mobile",
    "maxTouchPoints",
    "webglVendor",
    "webglRenderer",
];

pub fn router(state: AppState) -> Router {
    Router::new().fallback(handle).with_state(state)
}

async fn handle(State(state): State<AppState>, req: Request) -> Response {
    let host = request_host(&req);
    let snap = state.snapshot();
    let Some(route) = snap.routes.get(&host).cloned() else {
        return page(
            StatusCode::NOT_FOUND,
            "message",
            &host,
            "Nothing here",
            "No app is published at this address.",
        );
    };
    // A tunnel aimed at the gateway itself would forward to itself forever.
    if req.headers().contains_key(proxy::HOP_HEADER) {
        return page(
            StatusCode::LOOP_DETECTED,
            "message",
            &host,
            "Points back at myTunnels",
            "This tunnel's port is myTunnels' own. Point it at the app's port instead.",
        );
    }
    let ip = client_ip(req.headers());
    if let Some(action) = req.uri().path().strip_prefix("/__gate/").map(str::to_owned) {
        return action_response(&state, &route, ip, &action, req).await;
    }
    if !route.enabled {
        return page(
            StatusCode::SERVICE_UNAVAILABLE,
            "message",
            &host,
            "Switched off",
            "This app is switched off right now.",
        );
    }

    let mut new_cookie = None;
    if req.method() == Method::GET && wants_identity(req.headers()) {
        match identify(&state, &snap, &route, ip, &req) {
            Identity::Here(value) => new_cookie = Some(value),
            Identity::Away(response) => return response,
            Identity::Keep => {}
        }
    }

    let verdict = check(&state, &snap, &route, ip, req.headers());
    let mut response = if verdict.allowed() {
        proxy::forward(&state, &snap, &route, ip, req).await
    } else {
        refuse(&host, &verdict, &req)
    };
    if let Some(value) = new_cookie {
        response.headers_mut().append(header::SET_COOKIE, value);
    }
    response
}

// ---- access checks ----

/// Each check a tunnel asks for, and whether this request passes it.
struct Verdict {
    any: bool,
    lan: Option<bool>,
    device: Option<bool>,
    password: Option<bool>,
    login: Option<bool>,
}

impl Verdict {
    fn results(&self) -> impl Iterator<Item = bool> + '_ {
        [self.lan, self.device, self.password, self.login]
            .into_iter()
            .flatten()
    }

    fn allowed(&self) -> bool {
        let mut results = self.results().peekable();
        if results.peek().is_none() {
            return true;
        }
        if self.any {
            self.results().any(|r| r)
        } else {
            self.results().all(|r| r)
        }
    }

    /// The checks a visitor can still pass on a page here, in the order offered.
    fn open(&self) -> Vec<&'static str> {
        [
            ("login", self.login),
            ("password", self.password),
            ("device", self.device),
        ]
        .into_iter()
        .filter(|(_, r)| *r == Some(false))
        .map(|(kind, _)| kind)
        .collect()
    }
}

fn check(
    state: &AppState,
    snap: &Snapshot,
    route: &Route,
    ip: Option<IpAddr>,
    headers: &HeaderMap,
) -> Verdict {
    Verdict {
        any: route.policy_mode == "any",
        lan: route
            .require_lan
            .then(|| ip.is_some_and(|ip| state.is_local(snap, ip))),
        device: route
            .require_device
            .then(|| device_session(state, snap, headers, route)),
        password: route
            .require_password
            .then(|| password_session(state, headers, route)),
        login: route
            .require_login
            .then(|| user_session(state, snap, headers, route)),
    }
}

fn device_session(state: &AppState, snap: &Snapshot, headers: &HeaderMap, route: &Route) -> bool {
    cookie(headers, SESSION_COOKIE)
        .and_then(|sid| session(&state.device_sessions, sid))
        .and_then(|s| snap.devices.get(&s.subject))
        .is_some_and(|d| may_open(d, route))
}

fn password_session(state: &AppState, headers: &HeaderMap, route: &Route) -> bool {
    let Some(hash) = &route.password_hash else {
        return false;
    };
    cookie(headers, PASS_COOKIE)
        .and_then(|sid| session(&state.pass_sessions, sid))
        .is_some_and(|s| s.subject == route.id && s.tag == secret::tag(hash))
}

/// A signed-in account that may open this tunnel, within the tunnel's limits on how
/// long ago it signed in and how long it has been idle.
fn user_session(state: &AppState, snap: &Snapshot, headers: &HeaderMap, route: &Route) -> bool {
    let Some(sid) = cookie(headers, USER_COOKIE) else {
        return false;
    };
    let Some(s) = session(&state.user_sessions, sid) else {
        return false;
    };
    let here = cookie(headers, DEVICE_COOKIE)
        .map(sha256_hex)
        .unwrap_or_default();
    if !s.device.is_empty() && s.device != here {
        return false;
    }
    let now = now();
    if (route.login_max > 0 && now - s.created > route.login_max)
        || (route.login_idle > 0 && now - s.seen > route.login_idle)
    {
        return false;
    }
    let ok = snap
        .users
        .get(&s.subject)
        .filter(|u| secret::tag(&u.password_hash) == s.tag)
        .is_some_and(|u| u.enabled && (u.all_routes || u.route_ids.contains(&route.id)));
    if ok {
        touch_session(&state.user_sessions, sid);
    }
    ok
}

fn may_open(device: &Device, route: &Route) -> bool {
    device.status == "approved" && (device.all_routes || device.route_ids.contains(&route.id))
}

/// What a visitor who did not pass sees: the network notice, or the page for one of
/// the checks they can pass here. `?__gate=password` picks another of those.
fn refuse(host: &str, verdict: &Verdict, req: &Request) -> Response {
    let html = req.method() == Method::GET
        && req
            .headers()
            .get(header::ACCEPT)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.contains("text/html"));
    let open = verdict.open();
    let network_only = verdict.lan == Some(false) && (!verdict.any || open.is_empty());
    if network_only {
        return if html {
            page(
                StatusCode::FORBIDDEN,
                "message",
                host,
                "Home network only",
                "This app can only be opened from the network it is hosted on.",
            )
        } else {
            (StatusCode::FORBIDDEN, "Not on an allowed network").into_response()
        };
    }
    if !html {
        return (StatusCode::UNAUTHORIZED, "Sign-in required").into_response();
    }
    let wanted = query(req.uri().query(), "__gate");
    let kind = open
        .iter()
        .copied()
        .find(|k| Some(*k) == wanted.as_deref())
        .unwrap_or(open[0]);
    let others: Vec<&str> = if verdict.any {
        open.iter().copied().filter(|k| *k != kind).collect()
    } else {
        Vec::new()
    };
    let (title, text) = match kind {
        "login" => (
            "Sign in",
            "Sign in with the account you were given for this app.",
        ),
        "password" => ("Password required", "Enter the password for this app."),
        _ => (
            "Device approval required",
            "This app only opens on approved devices. Give the ID below to the administrator.",
        ),
    };
    gate_page(StatusCode::UNAUTHORIZED, kind, host, title, text, &others)
}

// ---- pages ----

pub fn page(status: StatusCode, mode: &str, host: &str, title: &str, text: &str) -> Response {
    gate_page(status, mode, host, title, text, &[])
}

fn gate_page(
    status: StatusCode,
    mode: &str,
    host: &str,
    title: &str,
    text: &str,
    others: &[&str],
) -> Response {
    let html = TEMPLATE
        .replace("{{MODE}}", mode)
        .replace("{{OTHERS}}", &others.join(" "))
        .replace("{{HOST}}", &escape(host))
        .replace("{{TITLE}}", &escape(title))
        .replace("{{TEXT}}", &escape(text));
    (
        status,
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        html,
    )
        .into_response()
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn request_host(req: &Request) -> String {
    let raw = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .or_else(|| req.uri().host())
        .unwrap_or("");
    let host = raw
        .rsplit_once(':')
        .filter(|(_, port)| port.bytes().all(|b| b.is_ascii_digit()))
        .map_or(raw, |(host, _)| host);
    host.trim_end_matches('.').to_ascii_lowercase()
}

/// The visitor's address as seen by Cloudflare. The gateway only listens for cloudflared,
/// so this header can be trusted.
fn client_ip(headers: &HeaderMap) -> Option<IpAddr> {
    headers
        .get("cf-connecting-ip")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse().ok())
}

fn query(query: Option<&str>, name: &str) -> Option<String> {
    query?
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value.to_owned())
}

/// Cookies scoped to `domain` cover every tunnel on it; without one they stay on this host.
fn cookie_value(
    name: &str,
    value: &str,
    domain: Option<&str>,
    max_age: i64,
) -> Option<HeaderValue> {
    let scope = domain.map(|d| format!("; Domain={d}")).unwrap_or_default();
    HeaderValue::from_str(&format!(
        "{name}={value}{scope}; Path=/; Max-Age={max_age}; HttpOnly; Secure; SameSite=Lax"
    ))
    .ok()
}

fn redirect(to: &str, cookies: Vec<HeaderValue>) -> Response {
    let mut response = (StatusCode::FOUND, [(header::CACHE_CONTROL, "no-store")]).into_response();
    if let Ok(location) = HeaderValue::from_str(to) {
        response.headers_mut().insert(header::LOCATION, location);
    }
    for value in cookies {
        response.headers_mut().append(header::SET_COOKIE, value);
    }
    response
}

fn json_error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

// ---- device keys ----

fn valid_token(token: &str) -> bool {
    token.len() == TOKEN_LEN && token.bytes().all(|b| b.is_ascii_alphanumeric())
}

pub fn fingerprint(info: &Value) -> String {
    let parts: Vec<String> = FINGERPRINT_KEYS
        .iter()
        .map(|key| info.get(key).map(Value::to_string).unwrap_or_default())
        .collect();
    sha256_hex(&parts.join("|"))
}

/// True when `info` holds what the browser reports about its hardware, not just what
/// the server saw.
fn has_hardware(info: &Value) -> bool {
    info.get("platform").is_some()
}

/// A page load that should leave with a device key: a browser opening a page without one.
fn wants_identity(headers: &HeaderMap) -> bool {
    let text = |name| {
        headers
            .get(name)
            .and_then(|v: &HeaderValue| v.to_str().ok())
            .unwrap_or("")
    };
    cookie(headers, DEVICE_COOKIE).is_none_or(|t| !valid_token(t))
        && cookie(headers, TRIED_COOKIE).is_none()
        && text("accept").contains("text/html")
        && text("user-agent").starts_with("Mozilla/")
        && matches!(text("sec-fetch-mode"), "" | "navigate")
}

enum Identity {
    /// The key was made here; this cookie carries it.
    Here(HeaderValue),
    /// The browser goes to the hub for its key first.
    Away(Response),
    Keep,
}

fn identify(
    state: &AppState,
    snap: &Snapshot,
    route: &Route,
    ip: Option<IpAddr>,
    req: &Request,
) -> Identity {
    let hub = snap.hub.as_deref().and_then(|h| snap.routes.get(h));
    let same_domain = hub.is_none_or(|h| h.zone_name == route.zone_name);
    if same_domain {
        return match new_device(state, route, ip, req.headers(), "seen", Value::Null) {
            Ok((_, token)) => cookie_value(
                DEVICE_COOKIE,
                &token,
                Some(&route.zone_name),
                DEVICE_COOKIE_TTL,
            )
            .map_or(Identity::Keep, Identity::Here),
            Err(err) => {
                tracing::warn!("could not record a new device: {}", err.1);
                Identity::Keep
            }
        };
    }
    let path = req.uri().path_and_query().map_or("/", |p| p.as_str());
    let nonce = random_hex(16);
    state.put_hop(
        nonce.clone(),
        Hop::Return {
            url: format!("https://{}{path}", route.hostname),
            expires: now() + HOP_TTL,
        },
    );
    let hub = hub.map(|h| h.hostname.as_str()).unwrap_or_default();
    let tried = cookie_value(TRIED_COOKIE, "1", None, 300)
        .into_iter()
        .collect();
    Identity::Away(redirect(
        &format!("https://{hub}/__gate/id?n={nonce}"),
        tried,
    ))
}

/// Records a browser first met here and gives it a key.
fn new_device(
    state: &AppState,
    route: &Route,
    ip: Option<IpAddr>,
    headers: &HeaderMap,
    status: &str,
    info: Value,
) -> ApiResult<(Device, String)> {
    if status == "pending" && state.db.pending_count()? >= MAX_PENDING {
        return Err(ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many devices are waiting for approval".into(),
        ));
    }
    let token = random_alnum(TOKEN_LEN);
    let now = now();
    let ip = ip.map(|ip| ip.to_string());
    let info = if info.is_null() {
        json!({ "userAgent": headers.get(header::USER_AGENT).and_then(|v| v.to_str().ok()).unwrap_or("") })
    } else {
        info
    };
    let device = Device {
        id: random_alnum(DEVICE_ID_LEN),
        name: String::new(),
        status: status.into(),
        all_routes: false,
        route_ids: Vec::new(),
        fingerprint: if has_hardware(&info) {
            fingerprint(&info)
        } else {
            String::new()
        },
        info,
        note: None,
        first_ip: ip.clone(),
        last_ip: ip,
        country: headers
            .get("cf-ipcountry")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned),
        first_host: Some(route.hostname.clone()),
        created_at: now,
        last_seen: now,
    };
    state.db.insert_device(&device, &sha256_hex(&token))?;
    if status == "seen" {
        state.db.prune_seen(MAX_SEEN)?;
    }
    state.reload()?;
    tracing::info!("device {} first seen on {}", device.id, route.hostname);
    Ok((device, token))
}

// ---- /__gate/ actions ----

async fn action_response(
    state: &AppState,
    route: &Route,
    ip: Option<IpAddr>,
    action: &str,
    req: Request,
) -> Response {
    let post = req.method() == Method::POST;
    match (action, post) {
        ("id", false) => hub_hand_out(state, route, ip, &req),
        ("claim", false) => claim(state, route, &req),
        ("logout", false) => redirect(
            "/",
            cookie_value(USER_COOKIE, "", Some(&route.zone_name), 0)
                .into_iter()
                .collect(),
        ),
        ("enroll", true) => match body::<EnrollRequest>(req).await {
            Ok((headers, body)) => register(state, route, ip, &headers, body)
                .unwrap_or_else(IntoResponse::into_response),
            Err(status) => status.into_response(),
        },
        ("password", true) => match body::<PasswordRequest>(req).await {
            Ok((_, body)) => password(state, route, ip, body).await,
            Err(status) => status.into_response(),
        },
        ("login", true) => match body::<LoginRequest>(req).await {
            Ok((headers, body)) => login(state, route, ip, &headers, body).await,
            Err(status) => status.into_response(),
        },
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn body<T: serde::de::DeserializeOwned>(req: Request) -> Result<(HeaderMap, T), StatusCode> {
    let headers = req.headers().clone();
    let bytes = axum::body::to_bytes(req.into_body(), 16 * 1024)
        .await
        .map_err(|_| StatusCode::PAYLOAD_TOO_LARGE)?;
    let body = serde_json::from_slice(&bytes).map_err(|_| StatusCode::BAD_REQUEST)?;
    Ok((headers, body))
}

/// On the hub: hands this browser's key (made now if it has none) to the tunnel that
/// sent it, through a one-use code.
fn hub_hand_out(state: &AppState, route: &Route, ip: Option<IpAddr>, req: &Request) -> Response {
    let Some(Hop::Return { url, .. }) =
        query(req.uri().query(), "n").and_then(|n| state.take_hop(&n))
    else {
        return redirect("/", Vec::new());
    };
    let Some((host, path)) = url.strip_prefix("https://").map(|rest| {
        let (host, path) = rest
            .split_once('/')
            .map_or((rest, "/".to_owned()), |(h, p)| (h, format!("/{p}")));
        (host.to_owned(), path)
    }) else {
        return redirect("/", Vec::new());
    };
    let mut cookies = Vec::new();
    let token = match cookie(req.headers(), DEVICE_COOKIE).filter(|t| valid_token(t)) {
        Some(token) => token.to_owned(),
        None => match new_device(state, route, ip, req.headers(), "seen", Value::Null) {
            Ok((_, token)) => {
                cookies.extend(cookie_value(
                    DEVICE_COOKIE,
                    &token,
                    Some(&route.zone_name),
                    DEVICE_COOKIE_TTL,
                ));
                token
            }
            Err(_) => return redirect(&url, Vec::new()),
        },
    };
    let code = random_hex(16);
    state.put_hop(
        code.clone(),
        Hop::Claim {
            host: host.clone(),
            path,
            token,
            expires: now() + HOP_TTL,
        },
    );
    redirect(&format!("https://{host}/__gate/claim?c={code}"), cookies)
}

/// Back on the tunnel: keeps the key the hub handed over, then carries on.
fn claim(state: &AppState, route: &Route, req: &Request) -> Response {
    match query(req.uri().query(), "c").and_then(|c| state.take_hop(&c)) {
        Some(Hop::Claim {
            host, path, token, ..
        }) if host == route.hostname => redirect(
            &path,
            cookie_value(
                DEVICE_COOKIE,
                &token,
                Some(&route.zone_name),
                DEVICE_COOKIE_TTL,
            )
            .into_iter()
            .collect(),
        ),
        _ => redirect("/", Vec::new()),
    }
}

#[derive(Deserialize)]
struct EnrollRequest {
    token: Option<String>,
    #[serde(default)]
    info: Value,
}

/// Identifies the calling browser by its device key, asking for approval when it has not
/// yet, and opens a session when the device is approved for this tunnel.
fn register(
    state: &AppState,
    route: &Route,
    ip: Option<IpAddr>,
    headers: &HeaderMap,
    body: EnrollRequest,
) -> ApiResult<Response> {
    let known = body
        .token
        .filter(|t| valid_token(t))
        .or_else(|| {
            cookie(headers, DEVICE_COOKIE)
                .filter(|t| valid_token(t))
                .map(str::to_owned)
        })
        .and_then(|token| Some((state.db.device_by_token(&sha256_hex(&token)).ok()??, token)));
    let (device, token) = match known {
        Some((mut device, token)) => {
            let was = device.status.clone();
            let print = fingerprint(&body.info);
            if device.fingerprint.is_empty() && has_hardware(&body.info) {
                device.fingerprint = print;
            } else if device.status == "approved" && device.fingerprint != print {
                tracing::warn!(
                    "device {} presented different hardware, holding for review",
                    device.id
                );
                device.status = "pending".into();
                device.note = Some("Hardware changed since approval".into());
            }
            if device.status == "seen" {
                device.status = "pending".into();
            }
            device.info = body.info;
            device.last_ip = ip.map(|ip| ip.to_string()).or(device.last_ip);
            device.country = headers
                .get("cf-ipcountry")
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned)
                .or(device.country);
            device.last_seen = now();
            state.db.save_device(&device)?;
            if device.status != was {
                state.reload()?;
            }
            (device, token)
        }
        None => new_device(state, route, ip, headers, "pending", body.info)?,
    };

    let allowed = may_open(&device, route);
    let mut response = Json(json!({
        "id": device.id,
        "status": device.status,
        "note": device.note,
        "allowed": allowed,
        "token": token,
    }))
    .into_response();
    let out = response.headers_mut();
    out.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    out.extend(
        cookie_value(
            DEVICE_COOKIE,
            &token,
            Some(&route.zone_name),
            DEVICE_COOKIE_TTL,
        )
        .map(|v| (header::SET_COOKIE, v)),
    );
    if allowed {
        let sid = open_session(
            &state.device_sessions,
            &device.id,
            "",
            "",
            DEVICE_SESSION_TTL,
        );
        out.extend(
            cookie_value(
                SESSION_COOKIE,
                &sid,
                Some(&route.zone_name),
                DEVICE_SESSION_TTL,
            )
            .map(|v| (header::SET_COOKIE, v)),
        );
    }
    Ok(response)
}

#[derive(Deserialize)]
struct PasswordRequest {
    password: String,
}

/// The tunnel's own password. Its session stays on this host alone.
async fn password(
    state: &AppState,
    route: &Route,
    ip: Option<IpAddr>,
    body: PasswordRequest,
) -> Response {
    let Some(hash) = route
        .password_hash
        .as_deref()
        .filter(|_| route.require_password)
    else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let key = format!(
        "password:{}:{}",
        route.id,
        ip.map(|ip| ip.to_string()).unwrap_or_default()
    );
    if state.locked_out(&key) {
        return json_error(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many wrong tries. Wait 15 minutes and try again.",
        );
    }
    if !secret::verify(&body.password, hash) {
        state.record_failure(&key);
        tokio::time::sleep(Duration::from_millis(700)).await;
        return json_error(StatusCode::UNAUTHORIZED, "That password is not right.");
    }
    state.clear_failures(&key);
    let sid = open_session(
        &state.pass_sessions,
        &route.id,
        &secret::tag(hash),
        "",
        PASS_TTL,
    );
    let mut response = Json(json!({ "ok": true })).into_response();
    response
        .headers_mut()
        .extend(cookie_value(PASS_COOKIE, &sid, None, PASS_TTL).map(|v| (header::SET_COOKIE, v)));
    response
}

#[derive(Deserialize)]
struct LoginRequest {
    email: String,
    password: String,
}

/// Sign-in with an account. One sign-in covers every tunnel on the domain the
/// account may open.
async fn login(
    state: &AppState,
    route: &Route,
    ip: Option<IpAddr>,
    headers: &HeaderMap,
    body: LoginRequest,
) -> Response {
    if !route.require_login {
        return StatusCode::NOT_FOUND.into_response();
    }
    let by_address = format!("login:{}", ip.map(|ip| ip.to_string()).unwrap_or_default());
    let by_account = format!("login-account:{}", body.email.trim().to_ascii_lowercase());
    if state.locked_out(&by_address) || state.locked_out(&by_account) {
        return json_error(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many wrong tries. Wait 15 minutes and try again.",
        );
    }
    let account = state.db.user_by_email(&body.email).ok().flatten();
    let valid = secret::verify_or_waste(
        &body.password,
        account.as_ref().map(|u| u.password_hash.as_str()),
    );
    // Who is signing in: the device key this browser holds, and where it is.
    let key = cookie(headers, DEVICE_COOKIE).filter(|t| valid_token(t));
    let device_hash = key.map(sha256_hex).unwrap_or_default();
    let device_id = key
        .and_then(|t| state.db.device_by_token(&sha256_hex(t)).ok().flatten())
        .map(|d| d.id);
    let country = headers
        .get("cf-ipcountry")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let record = |user_id: &str, outcome: &str| {
        let _ = state.db.add_sign_in(&SignIn {
            user_id: user_id.to_owned(),
            device_id: device_id.clone(),
            ip: ip.map(|ip| ip.to_string()),
            country: country.clone(),
            at: now(),
            outcome: outcome.to_owned(),
        });
    };

    let Some(mut account) = account.filter(|u| valid && u.enabled) else {
        if let Some(u) = state.db.user_by_email(&body.email).ok().flatten() {
            record(&u.id, if valid { "blocked" } else { "failed" });
        }
        state.record_failure(&by_address);
        state.record_failure(&by_account);
        tokio::time::sleep(Duration::from_millis(700)).await;
        return json_error(StatusCode::UNAUTHORIZED, "Those details are not right.");
    };
    state.clear_failures(&by_address);
    state.clear_failures(&by_account);
    if !(account.all_routes || account.route_ids.contains(&route.id)) {
        return json_error(StatusCode::FORBIDDEN, "This account cannot open this app.");
    }
    account.last_login = Some(now());
    let _ = state.db.save_user(&account);
    let sid = open_session(
        &state.user_sessions,
        &account.id,
        &secret::tag(&account.password_hash),
        USER_TTL,
    );
    let mut response = Json(json!({ "ok": true })).into_response();
    response.headers_mut().extend(
        cookie_value(USER_COOKIE, &sid, Some(&route.zone_name), USER_TTL)
            .map(|v| (header::SET_COOKIE, v)),
    );
    response
}

// ---- the dashboard's own device ----

/// Registers the browser the admin uses, approved for every tunnel, and returns its key.
pub fn dashboard_device(
    state: &AppState,
    token: Option<String>,
    info: Value,
) -> ApiResult<(Device, String)> {
    if let Some(token) = token.filter(|t| valid_token(t)) {
        if let Some(mut device) = state.db.device_by_token(&sha256_hex(&token))? {
            device.info = info;
            device.last_seen = now();
            state.db.save_device(&device)?;
            return Ok((device, token));
        }
    }
    let token = random_alnum(TOKEN_LEN);
    let now = now();
    let device = Device {
        id: random_alnum(DEVICE_ID_LEN),
        name: "This computer".into(),
        status: "approved".into(),
        all_routes: true,
        route_ids: Vec::new(),
        fingerprint: fingerprint(&info),
        info,
        note: None,
        first_ip: None,
        last_ip: None,
        country: None,
        first_host: None,
        created_at: now,
        last_seen: now,
    };
    state.db.insert_device(&device, &sha256_hex(&token))?;
    state.reload()?;
    Ok((device, token))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_ignores_volatile_fields() {
        let a = json!({ "platform": "Win32", "webglRenderer": "GPU", "userAgent": "A/1" });
        let b = json!({ "platform": "Win32", "webglRenderer": "GPU", "userAgent": "A/2" });
        let c = json!({ "platform": "MacIntel", "webglRenderer": "GPU", "userAgent": "A/1" });
        assert_eq!(fingerprint(&a), fingerprint(&b));
        assert_ne!(fingerprint(&a), fingerprint(&c));
    }

    #[test]
    fn tokens_must_be_256_alphanumerics() {
        assert!(valid_token(&random_alnum(256)));
        assert!(!valid_token(&random_alnum(255)));
        assert!(!valid_token(&"-".repeat(256)));
    }

    #[test]
    fn host_drops_port_and_case() {
        let req = Request::builder()
            .header(header::HOST, "App1.Example.com:443")
            .body(axum::body::Body::empty())
            .unwrap();
        assert_eq!(request_host(&req), "app1.example.com");
    }

    fn verdict(
        any: bool,
        lan: Option<bool>,
        device: Option<bool>,
        password: Option<bool>,
        login: Option<bool>,
    ) -> Verdict {
        Verdict {
            any,
            lan,
            device,
            password,
            login,
        }
    }

    #[test]
    fn checks_combine_by_mode() {
        assert!(verdict(false, None, None, None, None).allowed());
        assert!(!verdict(false, Some(true), None, Some(false), None).allowed());
        assert!(verdict(true, Some(false), None, Some(true), None).allowed());
        assert!(!verdict(true, Some(false), Some(false), None, None).allowed());
        assert_eq!(
            verdict(true, None, Some(false), Some(false), Some(false)).open(),
            ["login", "password", "device"]
        );
    }

    #[test]
    fn only_page_loads_get_a_key() {
        let mut headers = HeaderMap::new();
        headers.insert(header::ACCEPT, HeaderValue::from_static("text/html"));
        headers.insert(header::USER_AGENT, HeaderValue::from_static("Mozilla/5.0"));
        assert!(wants_identity(&headers));
        headers.insert("sec-fetch-mode", HeaderValue::from_static("cors"));
        assert!(!wants_identity(&headers));
        headers.remove("sec-fetch-mode");
        headers.insert(header::USER_AGENT, HeaderValue::from_static("curl/8"));
        assert!(!wants_identity(&headers));
    }
}
