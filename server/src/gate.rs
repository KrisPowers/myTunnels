//! The access gateway. cloudflared sends every published hostname here; each request is
//! matched to its tunnel, checked against that tunnel's access rules, then forwarded.
//!
//! Every browser gets a device key the first time it opens any tunnel. Each tunnel
//! keeps the key in a cookie of its own host, never one for the whole domain, so
//! other servers on the domain never see it. Tunnels fetch the key from the hub (the
//! oldest tunnel's host) with a one-minute, one-use code, so one browser is one
//! device everywhere. An account keeps the devices it signs in from, and a sign-in
//! from one new to it is flagged on the dashboard.

use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use axum::body::Body;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use tower::ServiceExt;

use crate::db::{Device, Event, Route, RouteKey, SignIn, User};
use crate::state::{AppState, Hop, Outcome, Snapshot, DAY};
use crate::util::{cookie, now, random_alnum, random_hex, sha256_hex, ApiError, ApiResult};
use crate::{codes, guard, passkey, pow, secret, share, totp};
use crate::{oauth, proxy};

/// Host-only cookies: the `__Host-` prefix makes browsers refuse them with a domain.
pub const DEVICE_COOKIE: &str = "__Host-gate_device";
const PASS_COOKIE: &str = "__gate_pass";
pub const USER_COOKIE: &str = "__Host-gate_user";
/// The cookies earlier versions set for the whole domain. A device key found there
/// is kept as this host's own, and all of them are cleared.
const LEGACY_DEVICE_COOKIE: &str = "__gate_device";
const LEGACY_COOKIES: [&str; 3] = ["__gate_device", "__gate_session", "__gate_user"];
/// Set while a browser is away fetching its key, so one that keeps no cookies is not
/// sent round in circles.
const TRIED_COOKIE: &str = "__gate_tried";
const DEVICE_COOKIE_TTL: i64 = 400 * 86_400;
const PASS_TTL: i64 = 7 * 86_400;
/// The longest any sign-in lasts; each tunnel can ask for less.
const USER_TTL: i64 = 30 * 86_400;
const HOP_TTL: i64 = 60;
const TOKEN_LEN: usize = 256;
/// A device's ID: 256 letters and numbers, apart from its secret key, so the
/// dashboard can show and link it without the key ever leaving the browser.
pub const DEVICE_ID_LEN: usize = 256;
const MAX_SEEN: i64 = 500;
const TEMPLATE: &str = include_str!("gate.html");
/// Requests one visitor address may make through the gateway each minute, and how
/// many of those may be key, password and sign-in steps.
const REQUESTS_PER_MINUTE: u32 = 1200;
const ACTIONS_PER_MINUTE: u32 = 20;
/// New device IDs one address may be given each hour.
const NEW_DEVICES_PER_HOUR: u32 = 10;

/// The panel, served to tunnels aimed at the dashboard.
#[derive(Clone)]
struct Panel(Router);

pub fn router(state: AppState, panel: Router) -> Router {
    Router::new()
        .fallback(handle)
        .layer(Extension(Panel(panel)))
        .with_state(state)
}

async fn handle(
    State(state): State<AppState>,
    Extension(Panel(panel)): Extension<Panel>,
    mut req: Request,
) -> Response {
    let host = request_host(&req);
    if crate::mailserver::web::serves(&host) {
        return crate::mailserver::web::handle(&host, req).await;
    }
    let snap = state.snapshot();
    if let Some(r) = crate::redirect::find(&snap.redirects, &host, req.uri().path()) {
        return crate::redirect::answer(r, req.uri());
    }
    let Some(route) = snap.routes.get(&host).cloned() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let cleared = match move_legacy(&state, &snap, &route, &mut req) {
        Legacy::Moving(response) => return response,
        Legacy::Clear(cookies) => cookies,
    };
    let mut response = serve(&state, panel, &snap, route, host, req).await;
    for value in cleared {
        response.headers_mut().append(header::SET_COOKIE, value);
    }
    response
}

/// Set while a browser is carried from the domain-wide cookies to host-only ones,
/// so it is never sent round twice.
const MOVED_COOKIE: &str = "__gate_moved";

enum Legacy {
    /// Off to carry the old device key to every tunnel, then back here.
    Moving(Response),
    /// Carry on, setting these cookies.
    Clear(Vec<HeaderValue>),
}

/// Earlier versions kept the device key in a cookie for the whole domain. On a page
/// load, a browser holding one takes it to every tunnel as that host's own cookie
/// (the same trip the dashboard's key makes), and the domain-wide cookies are
/// cleared, so it stays one device with its approvals. Any other request uses the
/// old key for this request only.
fn move_legacy(state: &AppState, snap: &Snapshot, route: &Route, req: &mut Request) -> Legacy {
    let headers = req.headers();
    if !LEGACY_COOKIES.iter().any(|n| cookie(headers, n).is_some()) {
        return Legacy::Clear(Vec::new());
    }
    let key = cookie(headers, LEGACY_DEVICE_COOKIE)
        .filter(|t| valid_token(t) && cookie(headers, DEVICE_COOKIE).is_none())
        .map(str::to_owned);
    let page_load = req.method() == Method::GET
        && headers
            .get(header::ACCEPT)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.contains("text/html"))
        && matches!(
            headers.get("sec-fetch-mode").and_then(|v| v.to_str().ok()),
            None | Some("navigate")
        )
        && !req.uri().path().starts_with("/__gate/");
    if !page_load {
        if let Some(key) = key {
            if let Ok(value) = HeaderValue::from_str(&format!("{DEVICE_COOKIE}={key}")) {
                req.headers_mut().append(header::COOKIE, value);
            }
        }
        return Legacy::Clear(Vec::new());
    }
    let mut cookies: Vec<HeaderValue> = LEGACY_COOKIES
        .iter()
        .filter_map(|n| cookie_value(n, "", Some(&route.zone_name), 0))
        .collect();
    let known = key.filter(|k| {
        state
            .db
            .device_by_token(&sha256_hex(k))
            .ok()
            .flatten()
            .is_some()
    });
    let hosts = planting_hosts(snap);
    match (known, hosts.first().cloned()) {
        (Some(token), Some(first)) if cookie(headers, MOVED_COOKIE).is_none() => {
            let path = req.uri().path_and_query().map_or("/", |p| p.as_str());
            let code = random_hex(16);
            state.put_hop(
                code.clone(),
                Hop::Plant {
                    token,
                    hosts,
                    back: format!("https://{}{path}", route.hostname),
                    expires: now() + HOP_TTL,
                },
            );
            cookies.extend(cookie_value(MOVED_COOKIE, "1", None, 300));
            Legacy::Moving(redirect(
                &format!("https://{first}/__gate/plant?c={code}"),
                cookies,
            ))
        }
        _ => Legacy::Clear(cookies),
    }
}

async fn serve(
    state: &AppState,
    panel: Router,
    snap: &Snapshot,
    route: Route,
    host: String,
    mut req: Request,
) -> Response {
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
    let from = ip.map(|ip| ip.to_string()).unwrap_or_default();
    // Limits count per address and, once a browser has one, per device ID, so
    // neither changing networks nor sharing one escapes them.
    let device = device_key(req.headers());
    // Someone signed in is never rate limited.
    let exempt = crate::admin::signed_in(state, req.headers())
        || user_session(state, snap, req.headers(), &route).is_some();
    let within = |name: &str, max: u32| {
        exempt
            || (state.allow(&format!("{name}:{from}"), max, 60)
                && device
                    .as_ref()
                    .is_none_or(|d| state.allow(&format!("{name}-device:{d}"), max, 60)))
    };
    if !within("gate", REQUESTS_PER_MINUTE) {
        return too_many();
    }
    if let Some(action) = req.uri().path().strip_prefix("/__gate/").map(str::to_owned) {
        if !within("gate-action", ACTIONS_PER_MINUTE) {
            return too_many();
        }
        let mut response = action_response(state, &route, ip, &action, req).await;
        harden(&mut response);
        return response;
    }
    if !route.enabled {
        // A tunnel switched off answers as if it did not exist.
        return StatusCode::NOT_FOUND.into_response();
    }
    // Git's old address finds nothing until it is removed.
    if route.target_scheme == "code" {
        return StatusCode::NOT_FOUND.into_response();
    }
    // Share links open at the dashboard's address for anyone holding one, past
    // the tunnel's access rules; each link is its own key.
    // Storage's locations open in File Explorer and Finder, which sign in with
    // an account's own name and password at each request, past the tunnel's page.
    if route.target_scheme == "dashboard" && crate::locations::is_dav(req.uri().path()) {
        return dashboard(panel, ip, req).await;
    }
    if route.target_scheme == "dashboard" && req.uri().path().starts_with("/share/") {
        let mut response = share::serve(state, ip, req).await;
        response.headers_mut().insert(
            header::STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static("max-age=31536000"),
        );
        return response;
    }

    // The route's own limit, beneath the gateway's.
    if route.rate_limit > 0 && !within(&format!("route-{}", route.id), route.rate_limit) {
        if state.allow(&format!("limit-log:{}:{from}", route.id), 1, 60) {
            log(state, &route, "limit", "refused", None, ip, req.headers());
        }
        return too_many();
    }
    // A read-only route takes reads and nothing else.
    if route.read_only && !matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS) {
        log(state, &route, "write", "refused", None, ip, req.headers());
        return json_error(
            StatusCode::METHOD_NOT_ALLOWED,
            "This address takes reads only",
        );
    }
    // An API key, from a header or the body, for a route that asks for one.
    let key: Option<Option<RouteKey>> = if route.require_key {
        let (given, back) = api_key(req).await;
        req = back;
        Some(given.and_then(|k| {
            state
                .db
                .use_route_key(&route.id, &sha256_hex(k.trim()))
                .ok()
                .flatten()
        }))
    } else {
        None
    };
    match &key {
        Some(Some(k)) if state.allow(&format!("key-log:{}", k.id), 1, 60) => {
            log(
                state,
                &route,
                "api",
                &format!("key {}", k.name),
                None,
                ip,
                req.headers(),
            );
        }
        Some(None) if state.allow(&format!("key-fail:{}:{from}", route.id), 1, 10) => {
            log(state, &route, "api", "refused", None, ip, req.headers());
        }
        _ => {}
    }

    let mut new_cookies = Vec::new();
    let known = |token: &str| {
        state
            .db
            .device_by_token(&sha256_hex(token))
            .ok()
            .flatten()
            .is_some()
    };
    if req.method() == Method::GET && wants_identity(req.headers(), known) {
        match identify(state, snap, &route, ip, &req) {
            Identity::Here(value) => new_cookies.push(value),
            Identity::Away(response) => return response,
            Identity::Keep => {}
        }
    }

    let verdict = check(
        state,
        snap,
        &route,
        ip,
        req.headers(),
        key.as_ref().map(Option::is_some),
    );
    // An API client turned away for its key is answered in JSON, not a page.
    if !verdict.allowed() && verdict.key == Some(false) && !page_load(&req) {
        return json_error(StatusCode::UNAUTHORIZED, "A valid API key is needed");
    }
    // Each page a visitor lets through is logged; the files it asks for are not.
    if verdict.allowed() && page_load(&req) {
        log(state, &route, "visit", "opened", None, ip, req.headers());
    }
    let mut response = if verdict.allowed() && route.target_scheme == "dashboard" {
        // Signed in here, so signed in to the dashboard: one sign-in, not two.
        let minted = route
            .require_login
            .then(|| user_session(state, snap, req.headers(), &route))
            .flatten()
            .and_then(|subject| crate::admin::gate_session(state, req.headers(), &subject));
        if let Some((now, keep)) = minted {
            // First, so it is read before any ended session this browser still sends.
            let headers = req.headers_mut();
            let sent: Vec<HeaderValue> = headers.get_all(header::COOKIE).iter().cloned().collect();
            headers.remove(header::COOKIE);
            headers.append(header::COOKIE, now);
            for value in sent {
                headers.append(header::COOKIE, value);
            }
            new_cookies.push(keep);
        }
        dashboard(panel, ip, req).await
    } else if verdict.allowed() {
        let mut response = proxy::forward(state, snap, &route, ip, req).await;
        // Tunnels are only ever reached over HTTPS.
        response
            .headers_mut()
            .entry(header::STRICT_TRANSPORT_SECURITY)
            .or_insert(HeaderValue::from_static("max-age=31536000"));
        response
    } else {
        let mut response = refuse(state, &route, ip, &host, &verdict, &req);
        harden(&mut response);
        response
    };
    for value in new_cookies {
        response.headers_mut().append(header::SET_COOKIE, value);
    }
    response
}

/// The API key a request carries: `Authorization: Bearer`, `X-API-Key`, or
/// `api_key` in a JSON or form body of up to 1 MB, which goes on to the app
/// as it came.
async fn api_key(req: Request) -> (Option<String>, Request) {
    let headers = req.headers();
    let text = |name: header::HeaderName| headers.get(name).and_then(|v| v.to_str().ok());
    let given = text(header::AUTHORIZATION)
        .and_then(|v| v.strip_prefix("Bearer "))
        .or_else(|| text(header::HeaderName::from_static("x-api-key")))
        .map(str::to_owned);
    if given.is_some() {
        return (given, req);
    }
    let kind = text(header::CONTENT_TYPE)
        .unwrap_or("")
        .to_ascii_lowercase();
    let json = kind.starts_with("application/json");
    let form = kind.starts_with("application/x-www-form-urlencoded");
    let small = text(header::CONTENT_LENGTH)
        .and_then(|v| v.parse::<usize>().ok())
        .is_some_and(|n| n <= 1 << 20);
    if !(json || form) || !small {
        return (None, req);
    }
    let (parts, body) = req.into_parts();
    let Ok(bytes) = axum::body::to_bytes(body, 1 << 20).await else {
        return (None, Request::from_parts(parts, Body::empty()));
    };
    let found = if json {
        serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|v| v.get("api_key").and_then(Value::as_str).map(str::to_owned))
    } else {
        serde_urlencoded::from_bytes::<Vec<(String, String)>>(&bytes)
            .ok()
            .and_then(|pairs| {
                pairs
                    .into_iter()
                    .find(|(k, _)| k == "api_key")
                    .map(|(_, v)| v)
            })
    };
    (found, Request::from_parts(parts, Body::from(bytes)))
}

/// The panel, as at its own address, for a visitor that passed the tunnel's
/// checks. Its sign-in and limits still apply, counted by the visitor's address.
async fn dashboard(panel: Router, ip: Option<IpAddr>, mut req: Request) -> Response {
    let peer = SocketAddr::new(ip.unwrap_or(IpAddr::from([0, 0, 0, 0])), 0);
    req.extensions_mut().insert(ConnectInfo(peer));
    // Tunnels are only ever reached over HTTPS.
    req.extensions_mut().insert(crate::tls::Https);
    let mut response = match panel.oneshot(req).await {
        Ok(response) => response,
        Err(never) => match never {},
    };
    response.headers_mut().insert(
        header::STRICT_TRANSPORT_SECURITY,
        HeaderValue::from_static("max-age=31536000"),
    );
    response
}

// ---- access checks ----

/// Each check a tunnel asks for, and whether this request passes it.
struct Verdict {
    any: bool,
    lan: Option<bool>,
    password: Option<bool>,
    login: Option<bool>,
    key: Option<bool>,
}

impl Verdict {
    fn results(&self) -> impl Iterator<Item = bool> + '_ {
        [self.lan, self.password, self.login, self.key]
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
        [("login", self.login), ("password", self.password)]
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
    key: Option<bool>,
) -> Verdict {
    Verdict {
        any: route.policy_mode == "any",
        key,
        lan: route
            .require_lan
            .then(|| ip.is_some_and(|ip| state.is_local(snap, ip))),
        password: route
            .require_password
            .then(|| password_session(state, headers, route)),
        login: route
            .require_login
            .then(|| user_session(state, snap, headers, route).is_some()),
    }
}

fn password_session(state: &AppState, headers: &HeaderMap, route: &Route) -> bool {
    let Some(hash) = &route.password_hash else {
        return false;
    };
    cookie(headers, PASS_COOKIE)
        .and_then(|sid| state.session(&state.pass_sessions, sid))
        .is_some_and(|s| s.subject == route.id && s.tag == secret::tag(hash))
}

/// The signed-in account, if it may open this tunnel, within the tunnel's limits on
/// how long ago it signed in and how long it has been idle.
fn user_session(
    state: &AppState,
    snap: &Snapshot,
    headers: &HeaderMap,
    route: &Route,
) -> Option<String> {
    let here = cookie(headers, DEVICE_COOKIE)
        .map(sha256_hex)
        .unwrap_or_default();
    // This host's own sign-in, or the one this device made at another tunnel.
    let token = match cookie(headers, USER_COOKIE) {
        Some(token) => token.to_owned(),
        None if !here.is_empty() => state.db.device_sign_in(&here, now()).ok().flatten()?,
        None => return None,
    };
    let s = state.session(&state.user_sessions, &token)?;
    if !s.device.is_empty() && s.device != here {
        return None;
    }
    if (codes::on(state) || totp::enrolled(&state.db, &s.subject)) && !s.mfa {
        return None;
    }
    let now = now();
    if (route.login_max > 0 && now - s.created > route.login_max)
        || (route.login_idle > 0 && now - s.seen > route.login_idle)
    {
        return None;
    }
    let ok = snap
        .users
        .get(&s.subject)
        .filter(|u| secret::tag(&u.password_hash) == s.tag)
        .is_some_and(|u| u.enabled && may_open(u, route));
    if !ok {
        return None;
    }
    state.touch_session(&state.user_sessions, &s);
    Some(s.subject)
}

/// Whether a request loads a page, rather than a file the page asks for.
fn page_load(req: &Request) -> bool {
    req.method() == Method::GET
        && req
            .headers()
            .get(header::ACCEPT)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.contains("text/html"))
}

/// What a visitor who did not pass sees: the network notice, or the page for one of
/// the checks they can pass here. `?__gate=password` picks another of those.
fn refuse(
    state: &AppState,
    route: &Route,
    ip: Option<IpAddr>,
    host: &str,
    verdict: &Verdict,
    req: &Request,
) -> Response {
    let html = page_load(req);
    let open = verdict.open();
    let network_only = verdict.lan == Some(false) && (!verdict.any || open.is_empty());
    // Page loads turned away are logged; the files a page asks for are not.
    if html {
        let asked = if network_only {
            "network"
        } else {
            open.first().copied().unwrap_or("network")
        };
        log(state, route, "visit", asked, None, ip, req.headers());
    }
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
    let (title, text, data) = if kind == "login" {
        (
            "Sign in",
            "Sign in with the account you were given for this app.",
            json!({
                "providers": sign_in_buttons(state, route),
                "pow": pow::issue(slow_down(state, ip)),
            }),
        )
    } else {
        (
            "Password required",
            "Enter the password for this app.",
            json!({ "pow": pow::issue(slow_down(state, ip)) }),
        )
    };
    gate_page(
        StatusCode::UNAUTHORIZED,
        kind,
        host,
        title,
        text,
        &others,
        &data,
    )
}

/// The providers this tunnel offers that are set up, as `[{"id", "name"}]`.
fn sign_in_buttons(state: &AppState, route: &Route) -> Vec<Value> {
    oauth::all(&state.db)
        .unwrap_or_default()
        .into_iter()
        .filter(|p| route.oauth.contains(&p.id))
        .map(|p| json!({ "id": p.id, "name": p.label() }))
        .collect()
}

// ---- pages ----

pub fn page(status: StatusCode, mode: &str, host: &str, title: &str, text: &str) -> Response {
    gate_page(status, mode, host, title, text, &[], &json!({}))
}

fn gate_page(
    status: StatusCode,
    mode: &str,
    host: &str,
    title: &str,
    text: &str,
    others: &[&str],
    data: &Value,
) -> Response {
    let html = TEMPLATE
        .replace("{{MODE}}", mode)
        .replace("{{OTHERS}}", &others.join(" "))
        .replace("{{HOST}}", &escape(host))
        .replace("{{TITLE}}", &escape(title))
        .replace("{{TEXT}}", &escape(text))
        .replace("{{DATA}}", &escape(&data.to_string()));
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

/// The gateway's own pages: never framed, cached or sniffed, and HTTPS only.
fn harden(response: &mut Response) {
    let headers = response.headers_mut();
    for (name, value) in [
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        (header::X_FRAME_OPTIONS, "DENY"),
        (header::REFERRER_POLICY, "same-origin"),
        (
            header::CONTENT_SECURITY_POLICY,
            "frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'",
        ),
        (header::STRICT_TRANSPORT_SECURITY, "max-age=31536000"),
        (header::CACHE_CONTROL, "no-store"),
    ] {
        headers.insert(name, HeaderValue::from_static(value));
    }
}

/// The hash of this browser's device key, if it holds one.
fn device_key(headers: &HeaderMap) -> Option<String> {
    cookie(headers, DEVICE_COOKIE)
        .filter(|t| valid_token(t))
        .map(sha256_hex)
}

/// Every password and sign-in attempt comes from a device with an ID.
fn no_device() -> Response {
    json_error(
        StatusCode::FORBIDDEN,
        "This browser has no device ID yet. Reload the page and try again.",
    )
}

fn locked() -> Response {
    json_error(
        StatusCode::TOO_MANY_REQUESTS,
        "Too many wrong tries. Wait 30 minutes and try again.",
    )
}

fn locked_for_a_day() -> Response {
    json_error(
        StatusCode::TOO_MANY_REQUESTS,
        "Too many wrong tries. Try again tomorrow.",
    )
}

/// A device or address that fails on this many different accounts in a day is
/// refused for a day.
const ACCOUNTS_PER_DEVICE: usize = 3;
const ACCOUNTS_PER_ADDRESS: usize = 3;
/// Wrong sign-ins in a day before an account signs in only from its own devices
/// for a day, and before an address is refused for a day.
const FAILURES_PER_ACCOUNT: u32 = 10;
const FAILURES_PER_ADDRESS: u32 = 20;

fn too_many() -> Response {
    let mut response = (
        StatusCode::TOO_MANY_REQUESTS,
        [(header::RETRY_AFTER, "60")],
        "Too many requests. Wait a minute and try again.",
    )
        .into_response();
    harden(&mut response);
    response
}

fn json_error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

// ---- device keys ----

fn valid_token(token: &str) -> bool {
    token.len() == TOKEN_LEN && token.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// True when `info` holds what the browser reports about its hardware, not just what
/// the server saw.
fn has_hardware(info: &Value) -> bool {
    info.get("platform").is_some()
}

/// A page load that should leave with a device key: a browser opening a page without
/// one, or with one no device has any more, such as a device removed.
fn wants_identity(headers: &HeaderMap, known: impl FnOnce(&str) -> bool) -> bool {
    let text = |name| {
        headers
            .get(name)
            .and_then(|v: &HeaderValue| v.to_str().ok())
            .unwrap_or("")
    };
    cookie(headers, DEVICE_COOKIE)
        .filter(|t| valid_token(t))
        .is_none_or(|t| !known(t))
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
    // Only the hub makes keys; every other tunnel fetches this browser's from it.
    let at_hub = hub.is_none_or(|h| h.hostname == route.hostname);
    if at_hub {
        return match new_device(state, route, ip, req.headers()) {
            Ok((_, token)) => cookie_value(DEVICE_COOKIE, &token, None, DEVICE_COOKIE_TTL)
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
) -> ApiResult<(Device, String)> {
    // One address cannot mint device IDs without end to dodge per-device limits.
    let from = ip.map(|ip| ip.to_string()).unwrap_or_default();
    if !state.allow(&format!("new-device:{from}"), NEW_DEVICES_PER_HOUR, 3600) {
        return Err(ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many new devices from this address. Try again later.".into(),
        ));
    }
    let token = random_alnum(TOKEN_LEN);
    let now = now();
    let ip = ip.map(|ip| ip.to_string());
    let device = Device {
        id: random_alnum(DEVICE_ID_LEN),
        name: String::new(),
        info: json!({ "userAgent": headers.get(header::USER_AGENT).and_then(|v| v.to_str().ok()).unwrap_or("") }),
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
    state.db.prune_seen(MAX_SEEN)?;
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
        ("plant", false) => plant(state, route, &req),
        // A link only asks; signing out takes a POST from the page, so another
        // site cannot sign a visitor out with an image tag.
        ("logout", false) => page(
            StatusCode::OK,
            "logout",
            &route.hostname,
            "Sign out",
            "Sign out of this app on this device.",
        ),
        ("logout", true) => logout(state, req.headers()),
        ("account", false) => account_page(state, route, &req),
        // A fresh challenge for the next password try.
        ("pow", true) => Json(pow::issue(slow_down(state, ip))).into_response(),
        ("passkey-begin", true) if route.require_login => Json(passkey::begin_sign_in(
            &route.zone_name,
            &format!("https://{}", route.hostname),
        ))
        .into_response(),
        ("passkey", true) => match body::<passkey::Asserted>(req).await {
            Ok((headers, body)) => passkey_sign_in(state, route, ip, &headers, body).await,
            Err(status) => status.into_response(),
        },
        ("passkey-add-begin", true) => passkey_add_begin(state, route, req.headers()),
        ("passkey-add", true) => match body::<PasskeyAdd>(req).await {
            Ok((headers, body)) => passkey_add(state, route, &headers, body),
            Err(status) => status.into_response(),
        },
        ("password", true) => match body::<PasswordRequest>(req).await {
            Ok((headers, body)) => password(state, route, ip, &headers, body).await,
            Err(status) => status.into_response(),
        },
        ("login", true) => match body::<LoginRequest>(req).await {
            Ok((headers, body)) => login(state, route, ip, &headers, body).await,
            Err(status) => status.into_response(),
        },
        ("code", true) => match body::<CodeRequest>(req).await {
            Ok((headers, body)) => code(state, route, ip, &headers, body).await,
            Err(status) => status.into_response(),
        },
        ("oauth", false) => {
            let (parts, _) = req.into_parts();
            oauth_start(state, route, &parts.uri, &parts.headers).await
        }
        ("oauth-callback", false) => {
            let (parts, _) = req.into_parts();
            oauth_callback(state, route, ip, &parts.uri, &parts.headers).await
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

/// The account signed in at this tunnel: add a passkey here, or sign out.
/// `?r=` is where to go after, such as the page a sign-in came from.
fn account_page(state: &AppState, route: &Route, req: &Request) -> Response {
    let path = local_path(query_decoded(req.uri(), "r"));
    if user_session(state, &state.snapshot(), req.headers(), route).is_none() {
        return redirect(&path, Vec::new());
    }
    gate_page(
        StatusCode::OK,
        "account",
        &route.hostname,
        "Add a passkey",
        "Next time, sign in here with your fingerprint, face or security key instead of a password.",
        &[],
        &json!({ "path": path }),
    )
}

/// True when the account has no passkey for this tunnel's domain yet, so the page
/// offers to add one after a password sign-in.
fn offer_passkey(state: &AppState, route: &Route, user_id: &str) -> bool {
    state
        .db
        .passkeys_of(user_id)
        .is_ok_and(|keys| !keys.iter().any(|k| k.rp_id == route.zone_name))
}

/// Starts adding a passkey for the account signed in here, for this tunnel's domain.
fn passkey_add_begin(state: &AppState, route: &Route, headers: &HeaderMap) -> Response {
    let snap = state.snapshot();
    let Some(user) =
        user_session(state, &snap, headers, route).and_then(|id| snap.users.get(&id).cloned())
    else {
        return json_error(StatusCode::UNAUTHORIZED, "Sign in first.");
    };
    let label = if user.email.is_empty() {
        user.username.clone()
    } else {
        user.email.clone()
    };
    let existing = state.db.passkeys_of(&user.id).unwrap_or_default();
    Json(passkey::begin_register(
        &user.id,
        &label,
        &route.zone_name,
        &format!("https://{}", route.hostname),
        &existing,
    ))
    .into_response()
}

#[derive(Deserialize)]
struct PasskeyAdd {
    credential: passkey::Created,
    #[serde(default)]
    name: String,
}

/// Keeps a passkey made for the account signed in here.
fn passkey_add(state: &AppState, route: &Route, headers: &HeaderMap, body: PasskeyAdd) -> Response {
    let Some(user_id) = user_session(state, &state.snapshot(), headers, route) else {
        return json_error(StatusCode::UNAUTHORIZED, "Sign in first.");
    };
    match passkey::finish_register(&state.db, &body.credential, &body.name, &user_id) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(why) => json_error(StatusCode::BAD_REQUEST, why),
    }
}

/// Signs in with a passkey. The device checked who is holding it, so no emailed
/// or app code follows; the account is held to every other rule of a sign-in.
async fn passkey_sign_in(
    state: &AppState,
    route: &Route,
    ip: Option<IpAddr>,
    headers: &HeaderMap,
    body: passkey::Asserted,
) -> Response {
    if !route.require_login {
        return StatusCode::NOT_FOUND.into_response();
    }
    if device_key(headers).is_none() {
        return no_device();
    }
    let subject = match passkey::finish_sign_in(&state.db, &body) {
        Ok(subject) => subject,
        Err(why) => {
            log(state, route, "sign-in", "failed", None, ip, headers);
            return json_error(StatusCode::UNAUTHORIZED, why);
        }
    };
    let visitor = Visitor::of(state, ip, headers);
    let Some(account) = state.db.user(&subject).ok().flatten() else {
        return json_error(StatusCode::UNAUTHORIZED, "This passkey's account is gone.");
    };
    if !account.enabled {
        record(state, route, &visitor, &account.id, "blocked");
        return json_error(
            StatusCode::FORBIDDEN,
            "This account is suspended. Ask the administrator.",
        );
    }
    let outcome = vet(state, route, account, &visitor)
        .map(|account| Outcome::Session(open(state, route, account, &visitor, true)))
        .map_err(|(status, why)| ApiError(status, why.into()));
    signed_in(outcome, false)
}

/// Ends this browser's sign-in for good, not only its cookie.
fn logout(state: &AppState, headers: &HeaderMap) -> Response {
    let here = device_key(headers);
    let token = cookie(headers, USER_COOKIE).map(str::to_owned).or_else(|| {
        here.as_deref()
            .and_then(|h| state.db.device_sign_in(h, now()).ok().flatten())
    });
    if let Some(session) = token.and_then(|v| state.session(&state.user_sessions, &v)) {
        state.end_session(&state.user_sessions, &session);
    }
    if let Some(here) = here {
        let _ = state.db.forget_device_sign_in(&here);
    }
    let mut response = Json(json!({ "ok": true })).into_response();
    response
        .headers_mut()
        .extend(cookie_value(USER_COOKIE, "", None, 0).map(|v| (header::SET_COOKIE, v)));
    response
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
    let held = cookie(req.headers(), DEVICE_COOKIE)
        .filter(|t| valid_token(t))
        .filter(|t| {
            state
                .db
                .device_by_token(&sha256_hex(t))
                .ok()
                .flatten()
                .is_some()
        });
    let token = match held {
        Some(token) => token.to_owned(),
        None => match new_device(state, route, ip, req.headers()) {
            Ok((_, token)) => {
                cookies.extend(cookie_value(DEVICE_COOKIE, &token, None, DEVICE_COOKIE_TTL));
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
            cookie_value(DEVICE_COOKIE, &token, None, DEVICE_COOKIE_TTL)
                .into_iter()
                .collect(),
        ),
        _ => redirect("/", Vec::new()),
    }
}

/// On each tunnel in turn: the dashboard's device key becomes this
/// browser's key here. A different device this browser was known as here is folded
/// into the dashboard's, so its accounts carry over.
fn plant(state: &AppState, route: &Route, req: &Request) -> Response {
    let Some(Hop::Plant {
        token, hosts, back, ..
    }) = query(req.uri().query(), "c").and_then(|c| state.take_hop(&c))
    else {
        return redirect("/", Vec::new());
    };
    if hosts.first() != Some(&route.hostname) {
        return redirect("/", Vec::new());
    }
    let Some(planted) = state.db.device_by_token(&sha256_hex(&token)).ok().flatten() else {
        return redirect(&back, Vec::new());
    };
    let before = cookie(req.headers(), DEVICE_COOKIE)
        .filter(|t| valid_token(t))
        .and_then(|t| state.db.device_by_token(&sha256_hex(t)).ok().flatten());
    if let Some(old) = before.filter(|d| d.id != planted.id) {
        match state.db.merge_device(&old.id, &planted.id) {
            Ok(()) => {
                let _ = state.reload();
                tracing::info!("device {} is now {}", old.id, planted.id);
            }
            Err(err) => tracing::warn!("could not merge device {}: {err:#}", old.id),
        }
    }
    let cookies = cookie_value(DEVICE_COOKIE, &token, None, DEVICE_COOKIE_TTL)
        .into_iter()
        .collect();
    let rest = hosts[1..].to_vec();
    let next = match rest.first().cloned() {
        Some(host) => {
            let code = random_hex(16);
            state.put_hop(
                code.clone(),
                Hop::Plant {
                    token,
                    hosts: rest,
                    back,
                    expires: now() + HOP_TTL,
                },
            );
            format!("https://{host}/__gate/plant?c={code}")
        }
        None => back,
    };
    redirect(&next, cookies)
}

/// Every live tunnel, the hub's first: where the dashboard's device key goes, since
/// each host keeps its own cookie.
pub fn planting_hosts(snap: &Snapshot) -> Vec<String> {
    let mut routes: Vec<&Route> = snap.routes.values().filter(|r| r.enabled).collect();
    routes.sort_by_key(|r| {
        (
            snap.hub.as_deref() != Some(r.hostname.as_str()),
            r.created_at,
        )
    });
    routes.into_iter().map(|r| r.hostname.clone()).collect()
}

#[derive(Deserialize)]
struct PasswordRequest {
    password: String,
    pow: Option<pow::Proof>,
}

/// Wrong password tries from this address lately, which make each challenge harder.
fn slow_down(state: &AppState, ip: Option<IpAddr>) -> u32 {
    state.failure_count(&slow_key(ip))
}

fn slow_key(ip: Option<IpAddr>) -> String {
    format!("slow:{}", ip.map(|ip| ip.to_string()).unwrap_or_default())
}

/// A password try that came without its solved challenge.
fn unsolved() -> Response {
    json_error(
        StatusCode::BAD_REQUEST,
        "This page is out of date. Reload it and try again.",
    )
}

/// The tunnel's own password. Its session stays on this host alone.
async fn password(
    state: &AppState,
    route: &Route,
    ip: Option<IpAddr>,
    headers: &HeaderMap,
    body: PasswordRequest,
) -> Response {
    let Some(hash) = route
        .password_hash
        .as_deref()
        .filter(|_| route.require_password)
    else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(device) = device_key(headers) else {
        return no_device();
    };
    if !pow::check(body.pow.as_ref()) {
        return unsolved();
    }
    let key = format!(
        "password:{}:{}",
        route.id,
        ip.map(|ip| ip.to_string()).unwrap_or_default()
    );
    let by_device = format!("auth-device:{device}");
    if state.locked_out(&key) || state.locked_out(&by_device) || state.is_blocked(&by_device) {
        log(state, route, "password", "locked", None, ip, headers);
        return locked();
    }
    if !secret::verify(&body.password, hash) {
        log(state, route, "password", "failed", None, ip, headers);
        state.record_failure(&key);
        state.record_failure(&slow_key(ip));
        state.record_failure(&by_device);
        tokio::time::sleep(Duration::from_millis(700)).await;
        return json_error(StatusCode::UNAUTHORIZED, "That password is not right.");
    }
    log(state, route, "password", "ok", None, ip, headers);
    state.clear_failures(&key);
    state.clear_failures(&by_device);
    let sid = state.open_session(
        &state.pass_sessions,
        &route.id,
        &secret::tag(hash),
        "",
        PASS_TTL,
        false,
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
    pow: Option<pow::Proof>,
    /// What the browser reports about itself, kept with its device.
    #[serde(default)]
    info: Value,
}

/// Sign-in with an account. One sign-in covers every tunnel the account may open,
/// on this device.
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
    let Some(device) = device_key(headers) else {
        return no_device();
    };
    if !pow::check(body.pow.as_ref()) {
        return unsolved();
    }
    let email = body.email.trim().to_ascii_lowercase();
    let address = ip.map(|ip| ip.to_string()).unwrap_or_default();
    let by_address = format!("login:{address}");
    let by_account = format!("login-account:{email}");
    let by_device = format!("auth-device:{device}");
    if state.is_blocked(&by_device) || state.is_blocked(&by_address) {
        return locked_for_a_day();
    }
    let account = state.db.user_by_email(&body.email).ok().flatten();
    let visitor = Visitor::of(state, ip, headers);
    // Wrong tries against an account lock it only for devices it has signed in
    // from before, so a stranger who knows the email cannot lock its owner out.
    let linked = account.as_ref().is_some_and(|u| {
        visitor
            .device_id
            .as_ref()
            .is_some_and(|d| u.device_ids.contains(d))
    });
    if !linked && state.is_blocked(&by_account) {
        return locked_for_a_day();
    }
    if state.locked_out(&by_address)
        || (state.locked_out(&by_account) && !linked)
        || state.locked_out(&by_device)
    {
        return locked();
    }
    let valid = secret::verify_or_waste(
        &body.password,
        account.as_ref().map(|u| u.password_hash.as_str()),
    );

    let Some(account) = account.filter(|u| valid && u.enabled) else {
        if let Some(u) = state.db.user_by_email(&body.email).ok().flatten() {
            record(
                state,
                route,
                &visitor,
                &u.id,
                if valid { "blocked" } else { "failed" },
            );
        }
        state.record_failure(&by_address);
        state.record_failure(&by_account);
        state.record_failure(&by_device);
        state.record_failure(&slow_key(ip));
        if state.distinct(&format!("emails-device:{device}"), &email, DAY) >= ACCOUNTS_PER_DEVICE {
            tracing::warn!("refusing a device for a day: it failed on several accounts");
            log(state, route, "device", "blocked", None, ip, headers);
            state.block(&by_device, DAY);
        }
        // Device IDs cost nothing to make, so the address answers for them too.
        if state.distinct(&format!("emails-address:{address}"), &email, DAY) >= ACCOUNTS_PER_ADDRESS
            || !state.allow(
                &format!("fails-address:{address}"),
                FAILURES_PER_ADDRESS,
                DAY,
            )
        {
            tracing::warn!("refusing an address for a day: too many wrong sign-ins");
            state.block(&by_address, DAY);
        }
        if !state.allow(&format!("fails-account:{email}"), FAILURES_PER_ACCOUNT, DAY) {
            tracing::warn!(
                "holding an account to its own devices for a day: too many wrong sign-ins"
            );
            state.block(&by_account, DAY);
        }
        tokio::time::sleep(Duration::from_millis(700)).await;
        return json_error(StatusCode::UNAUTHORIZED, "Those details are not right.");
    };
    state.clear_failures(&by_address);
    state.clear_failures(&by_account);
    state.clear_failures(&by_device);
    describe(state, &visitor, body.info);
    let offer = offer_passkey(state, route, &account.id);
    signed_in(admit(state, route, account, &visitor).await, offer)
}

/// Who is signing in: the device key this browser holds, and where it is.
struct Visitor {
    device_id: Option<String>,
    device_hash: String,
    ip: Option<IpAddr>,
    country: Option<String>,
}

impl Visitor {
    fn of(state: &AppState, ip: Option<IpAddr>, headers: &HeaderMap) -> Self {
        let key = cookie(headers, DEVICE_COOKIE).filter(|t| valid_token(t));
        Self {
            device_id: key
                .and_then(|t| state.db.device_by_token(&sha256_hex(t)).ok().flatten())
                .map(|d| d.id),
            device_hash: key.map(sha256_hex).unwrap_or_default(),
            ip,
            country: country(headers),
        }
    }
}

/// Keeps what the browser signing in reports about itself with its device.
fn describe(state: &AppState, v: &Visitor, info: Value) {
    if !has_hardware(&info) {
        return;
    }
    let Some(mut device) = v
        .device_id
        .as_ref()
        .and_then(|id| state.db.device(id).ok().flatten())
    else {
        return;
    };
    device.info = info;
    device.last_seen = now();
    if state.db.save_device(&device).is_ok() {
        let _ = state.reload();
    }
}

fn country(headers: &HeaderMap) -> Option<String> {
    headers
        .get("cf-ipcountry")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
}

/// Notes a sign-in attempt on the account and at the tunnel.
fn record(state: &AppState, route: &Route, v: &Visitor, user_id: &str, outcome: &str) {
    log_event(
        state,
        Event {
            route_id: route.id.clone(),
            kind: "sign-in".into(),
            outcome: outcome.to_owned(),
            user_id: Some(user_id.to_owned()),
            device_id: v.device_id.clone(),
            ip: v.ip.map(|ip| ip.to_string()),
            country: v.country.clone(),
            at: now(),
        },
    );
    let _ = state.db.add_sign_in(&SignIn {
        user_id: user_id.to_owned(),
        device_id: v.device_id.clone(),
        ip: v.ip.map(|ip| ip.to_string()),
        country: v.country.clone(),
        at: now(),
        outcome: outcome.to_owned(),
    });
}

/// Lets in an account whose owner has proved who they are, by password or through
/// another service: if it may open this tunnel, from a device it may sign in from,
/// and the sign-in does not look like someone else holding it. Returns the session
/// token.
async fn admit(
    state: &AppState,
    route: &Route,
    account: User,
    v: &Visitor,
) -> Result<Outcome, ApiError> {
    let account =
        vet(state, route, account, v).map_err(|(status, why)| ApiError(status, why.into()))?;
    if totp::enrolled(&state.db, &account.id) {
        let ticket = state.codes.hold(&account.id, &route.id, &v.device_hash);
        return Ok(Outcome::Code {
            ticket,
            sent_to: String::new(),
            app: true,
        });
    }
    if !codes::on(state) {
        return Ok(Outcome::Session(open(state, route, account, v, false)));
    }
    let (ticket, sent_to) = codes::send(
        state,
        &account.id,
        &account.email,
        &route.id,
        &v.device_hash,
        &route.hostname,
    )
    .await?;
    Ok(Outcome::Code {
        ticket,
        sent_to,
        app: false,
    })
}

/// Whether `account` may open `route`: one it was added to; any, as the host
/// or an admin; and the dashboard's, when it may use the dashboard.
fn may_open(account: &User, route: &Route) -> bool {
    account.route_ids.contains(&route.id)
        || account.holds(crate::db::ADMIN)
        || (route.target_scheme == "dashboard" && account.holds("dashboard"))
}

/// The checks every sign-in passes, before any code: the account may open this
/// tunnel, from a device it may sign in from, and does not look like it is in other
/// hands.
fn vet(
    state: &AppState,
    route: &Route,
    mut account: User,
    v: &Visitor,
) -> Result<User, (StatusCode, &'static str)> {
    if !may_open(&account, route) {
        return Err((StatusCode::FORBIDDEN, "This account cannot open this app."));
    }

    let Some(device) = v.device_id.as_ref() else {
        return Err((
            StatusCode::FORBIDDEN,
            "This browser has no device ID yet. Reload the page and try again.",
        ));
    };
    // A locked account signs in only from its own devices; with none yet, the
    // first device to sign in becomes its own.
    if account.device_lock && !account.device_ids.is_empty() && !account.device_ids.contains(device)
    {
        record(state, route, v, &account.id, "unlinked");
        return Err((
            StatusCode::FORBIDDEN,
            "This account signs in only from its own devices. Ask the administrator to link this one.",
        ));
    }

    // A sign-in that looks like the account is in other hands holds it for review.
    let history = state
        .db
        .sign_ins("user_id", &account.id, 200)
        .unwrap_or_default();
    let attempt = guard::Attempt {
        device: v.device_id.as_deref(),
        country: v.country.as_deref(),
        at: now(),
    };
    if let Some(reason) = guard::assess(&history, &attempt) {
        tracing::warn!("holding account {} for review: {reason}", account.username);
        record(state, route, v, &account.id, "blocked");
        account.enabled = false;
        account.note = Some(reason);
        let _ = state.db.save_user(&account);
        state.end_sessions_of(&state.user_sessions, &account.id);
        let _ = state.reload();
        return Err((
            StatusCode::FORBIDDEN,
            "This account is held for review. Ask the administrator to check it.",
        ));
    }

    Ok(account)
}

/// Signs a vetted account in; returns the session token. The device becomes one
/// of the account's own, flagged on the dashboard when the account had others.
fn open(state: &AppState, route: &Route, mut account: User, v: &Visitor, mfa: bool) -> String {
    record(state, route, v, &account.id, "ok");
    if let Some(device) = v
        .device_id
        .as_ref()
        .filter(|d| !account.device_ids.contains(d))
    {
        if !account.device_ids.is_empty() {
            tracing::warn!("account {} signed in from a new device", account.username);
            let _ = state.db.add_flag(&SignIn {
                user_id: account.id.clone(),
                device_id: Some(device.clone()),
                ip: v.ip.map(|ip| ip.to_string()),
                country: v.country.clone(),
                at: now(),
                outcome: "ok".into(),
            });
        }
        account.device_ids.push(device.clone());
    }
    account.last_login = Some(now());
    let _ = state.db.save_user(&account);
    let _ = state.reload();
    let token = state.open_session(
        &state.user_sessions,
        &account.id,
        &secret::tag(&account.password_hash),
        &v.device_hash,
        USER_TTL,
        mfa,
    );
    // Other tunnels find the sign-in by this device, not by a domain-wide cookie.
    if !v.device_hash.is_empty() {
        if let Err(err) = state
            .db
            .set_device_sign_in(&v.device_hash, &token, now() + USER_TTL)
        {
            tracing::warn!("could not share a sign-in across tunnels: {err:#}");
        }
    }
    token
}

/// The answer to a sign-in: a session cookie, or the ticket for the code it waits on.
/// `offer` asks the page to offer adding a passkey once signed in.
fn signed_in(outcome: Result<Outcome, ApiError>, offer: bool) -> Response {
    match outcome {
        Ok(Outcome::Session(sid)) => {
            let mut response = Json(json!({ "ok": true, "offer_passkey": offer })).into_response();
            response.headers_mut().extend(
                cookie_value(USER_COOKIE, &sid, None, USER_TTL).map(|v| (header::SET_COOKIE, v)),
            );
            response
        }
        Ok(Outcome::Code {
            ticket,
            sent_to,
            app,
        }) => Json(json!({
            "code_required": true,
            "ticket": ticket,
            "sent_to": sent_to,
            "app": app,
        }))
        .into_response(),
        Ok(Outcome::Refused(why)) => json_error(StatusCode::FORBIDDEN, &why),
        Err(err) => err.into_response(),
    }
}

#[derive(Deserialize)]
struct CodeRequest {
    ticket: String,
    code: String,
}

/// The emailed code that finishes a sign-in, entered on the device that asked.
async fn code(
    state: &AppState,
    route: &Route,
    ip: Option<IpAddr>,
    headers: &HeaderMap,
    body: CodeRequest,
) -> Response {
    let visitor = Visitor::of(state, ip, headers);
    let app = |subject: &str, code: &str| totp::verify(&state.db, subject, code);
    let pending = match state.codes.redeem(&body.ticket, &body.code, app) {
        Ok(p) if p.route_id == route.id && p.device_hash == visitor.device_hash => p,
        Ok(_) => return json_error(StatusCode::FORBIDDEN, "Sign in again on this device."),
        Err(why) => {
            if why != "This code has expired. Sign in again." {
                log(state, route, "sign-in", "wrong-code", None, ip, headers);
            }
            return json_error(StatusCode::UNAUTHORIZED, why);
        }
    };
    let Some(account) = state
        .db
        .user(&pending.subject)
        .ok()
        .flatten()
        .filter(|u| u.enabled)
    else {
        return json_error(StatusCode::FORBIDDEN, "This account is suspended.");
    };
    let offer = offer_passkey(state, route, &account.id);
    let outcome = vet(state, route, account, &visitor)
        .map(|account| Outcome::Session(open(state, route, account, &visitor, true)))
        .map_err(|(status, why)| ApiError(status, why.into()));
    signed_in(outcome, offer)
}

// ---- signing in through another service ----

/// How long a visitor has to finish signing in at the provider.
const OAUTH_TTL: i64 = 10 * 60;

/// A refusal shown as the gateway's own page.
fn notice(host: &str, title: &str, text: &str) -> Response {
    let mut response = page(StatusCode::FORBIDDEN, "message", host, title, text);
    harden(&mut response);
    response
}

/// A path on this site to come back to, never another site.
fn local_path(path: Option<String>) -> String {
    path.filter(|p| p.starts_with('/') && !p.starts_with("//") && !p.contains('\\'))
        .unwrap_or_else(|| "/".into())
}

/// `/__gate/oauth?p=<provider>&r=<path>`: off to a provider this tunnel offers,
/// remembering where the visitor was and which device they are on. The provider
/// sends them back to this tunnel's own address.
async fn oauth_start(state: &AppState, route: &Route, uri: &Uri, headers: &HeaderMap) -> Response {
    let host = &route.hostname;
    let provider = query_decoded(uri, "p")
        .filter(|id| route.require_login && route.oauth.contains(id))
        .and_then(|id| oauth::load(&state.db, &id).ok().flatten());
    let Some(provider) = provider else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(device_hash) = device_key(headers) else {
        return notice(
            host,
            "No device ID yet",
            "This browser has no device ID yet. Reload the page and try again.",
        );
    };
    let verifier = random_alnum(64);
    let nonce = random_hex(16);
    let redirect_uri = oauth::redirect_uri(host);
    let url = match oauth::authorize_url(&state.http, &provider, &redirect_uri, &nonce, &verifier)
        .await
    {
        Ok(url) => url,
        Err(err) => {
            tracing::warn!("cannot start a {} sign-in: {err:#}", provider.label());
            return notice(
                host,
                "Sign-in unavailable",
                &format!("{} cannot be reached right now.", provider.label()),
            );
        }
    };
    let device_id = state
        .db
        .device_by_token(&device_hash)
        .ok()
        .flatten()
        .map(|d| d.id);
    state.put_hop(
        nonce,
        Hop::OAuth {
            provider: provider.id,
            host: host.clone(),
            path: local_path(query_decoded(uri, "r")),
            device_hash,
            device_id,
            verifier,
            expires: now() + OAUTH_TTL,
        },
    );
    redirect(&url, Vec::new())
}

/// Back from the provider with a code: trades it for the emails the provider
/// vouches for, and signs in the account with one of them, or asks for its
/// emailed code, or says why not.
async fn oauth_callback(
    state: &AppState,
    route: &Route,
    ip: Option<IpAddr>,
    uri: &Uri,
    headers: &HeaderMap,
) -> Response {
    let hop = query_decoded(uri, "state").and_then(|n| state.take_hop(&n));
    let Some(Hop::OAuth {
        provider,
        path,
        device_hash,
        device_id,
        verifier,
        ..
    }) = hop.filter(|h| matches!(h, Hop::OAuth { host, .. } if *host == route.hostname))
    else {
        return notice(
            &route.hostname,
            "Sign-in expired",
            "This sign-in link has expired or was used already. Go back to the app and try again.",
        );
    };
    // The browser finishing the sign-in must be the one that started it, so a
    // sign-in link sent to someone else cannot sign them in on the sender's device.
    if device_key(headers).as_deref() != Some(device_hash.as_str()) {
        return notice(
            &route.hostname,
            "Sign in on this device",
            "This sign-in was started on another device. Go back to the app and sign in here.",
        );
    }
    let visitor = Visitor {
        device_id,
        device_hash,
        ip,
        country: country(headers),
    };
    let code = query_decoded(uri, "code");
    let outcome = match provider_sign_in(state, route, &provider, &visitor, code, &verifier).await {
        Ok(outcome) => outcome,
        Err(why) => Outcome::Refused(why),
    };
    match outcome {
        Outcome::Session(sid) => redirect(
            &path,
            cookie_value(USER_COOKIE, &sid, None, USER_TTL)
                .into_iter()
                .collect(),
        ),
        Outcome::Code {
            ticket,
            sent_to,
            app,
        } => {
            let (title, text) = if app {
                (
                    "Authenticator code".to_owned(),
                    "Enter the code from your authenticator app, or a recovery code.".to_owned(),
                )
            } else {
                (
                    "Check your email".to_owned(),
                    format!("Enter the code sent to {sent_to}."),
                )
            };
            let mut response = gate_page(
                StatusCode::UNAUTHORIZED,
                "code",
                &route.hostname,
                &title,
                &text,
                &[],
                &json!({ "ticket": ticket, "path": path }),
            );
            harden(&mut response);
            response
        }
        Outcome::Refused(why) => notice(&route.hostname, "Could not sign in", &why),
    }
}

async fn provider_sign_in(
    state: &AppState,
    route: &Route,
    provider: &str,
    visitor: &Visitor,
    code: Option<String>,
    verifier: &str,
) -> Result<Outcome, String> {
    let Some(provider) = oauth::load(&state.db, provider).ok().flatten() else {
        return Err("That sign-in method was removed.".into());
    };
    let name = provider.label();
    let Some(code) = code else {
        return Err(format!("{name} did not sign you in."));
    };
    let redirect_uri = oauth::redirect_uri(&route.hostname);
    let emails =
        oauth::verified_emails(&state.http, &provider, &redirect_uri, &code, verifier).await;
    let emails = match emails {
        Ok(emails) => emails,
        Err(err) => {
            tracing::warn!("{name} sign-in failed: {err:#}");
            return Err(format!("{name} could not confirm who you are."));
        }
    };
    let Some(account) = emails
        .iter()
        .find_map(|e| state.db.user_by_email(e).ok().flatten())
    else {
        return Err(format!(
            "No account here uses the email your {name} account has verified."
        ));
    };
    if !account.enabled {
        record(state, route, visitor, &account.id, "blocked");
        return Err("This account is suspended. Ask the administrator.".into());
    }
    admit(state, route, account, visitor).await.map_err(|e| e.1)
}

/// A query parameter, percent-decoded.
fn query_decoded(uri: &Uri, name: &str) -> Option<String> {
    let url = reqwest::Url::parse(&format!("https://gate{uri}")).ok()?;
    url.query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

// ---- the tunnel's log ----

/// Notes an event at this tunnel, with whoever and wherever it came from.
fn log(
    state: &AppState,
    route: &Route,
    kind: &str,
    outcome: &str,
    user_id: Option<&str>,
    ip: Option<IpAddr>,
    headers: &HeaderMap,
) {
    let device_id = cookie(headers, DEVICE_COOKIE)
        .filter(|t| valid_token(t))
        .and_then(|t| state.db.device_by_token(&sha256_hex(t)).ok().flatten())
        .map(|d| d.id);
    log_event(
        state,
        Event {
            route_id: route.id.clone(),
            kind: kind.to_owned(),
            outcome: outcome.to_owned(),
            user_id: user_id.map(str::to_owned),
            device_id,
            ip: ip.map(|ip| ip.to_string()),
            country: country(headers),
            at: now(),
        },
    );
}

fn log_event(state: &AppState, event: Event) {
    if let Err(err) = state.db.add_event(&event) {
        tracing::warn!("could not log a {} event: {err:#}", event.kind);
    }
}

// ---- the dashboard's own device ----

/// Registers the browser the admin uses and returns its key.
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
        info,
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
        password: Option<bool>,
        login: Option<bool>,
    ) -> Verdict {
        Verdict {
            any,
            lan,
            password,
            login,
            key: None,
        }
    }

    #[test]
    fn a_missing_key_refuses_unless_any_other_check_passes() {
        let mut v = verdict(false, None, None, None);
        v.key = Some(false);
        assert!(!v.allowed());
        v.key = Some(true);
        assert!(v.allowed());
        let mut either = verdict(true, None, None, Some(true));
        either.key = Some(false);
        assert!(either.allowed());
    }

    #[test]
    fn checks_combine_by_mode() {
        assert!(verdict(false, None, None, None).allowed());
        assert!(!verdict(false, Some(true), Some(false), None).allowed());
        assert!(verdict(true, Some(false), Some(true), None).allowed());
        assert!(!verdict(true, Some(false), None, Some(false)).allowed());
        assert_eq!(
            verdict(true, None, Some(false), Some(false)).open(),
            ["login", "password"]
        );
    }

    #[test]
    fn only_page_loads_get_a_key() {
        let mut headers = HeaderMap::new();
        headers.insert(header::ACCEPT, HeaderValue::from_static("text/html"));
        headers.insert(header::USER_AGENT, HeaderValue::from_static("Mozilla/5.0"));
        assert!(wants_identity(&headers, |_| true));
        headers.insert("sec-fetch-mode", HeaderValue::from_static("cors"));
        assert!(!wants_identity(&headers, |_| true));
        headers.remove("sec-fetch-mode");
        headers.insert(header::USER_AGENT, HeaderValue::from_static("curl/8"));
        assert!(!wants_identity(&headers, |_| true));
    }

    #[test]
    fn a_key_no_device_has_is_replaced() {
        let mut headers = HeaderMap::new();
        headers.insert(header::ACCEPT, HeaderValue::from_static("text/html"));
        headers.insert(header::USER_AGENT, HeaderValue::from_static("Mozilla/5.0"));
        let key = "a".repeat(TOKEN_LEN);
        headers.insert(
            header::COOKIE,
            HeaderValue::from_str(&format!("{DEVICE_COOKIE}={key}")).unwrap(),
        );
        assert!(!wants_identity(&headers, |_| true));
        assert!(wants_identity(&headers, |_| false));
    }
}
