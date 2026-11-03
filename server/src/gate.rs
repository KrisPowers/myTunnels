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

use crate::db::{Device, Route};
use crate::proxy;
use crate::state::{AppState, GateSession, Snapshot};
use crate::util::{cookie, lock, now, random_alnum, random_hex, sha256_hex, ApiError, ApiResult};

pub const DEVICE_COOKIE: &str = "__gate_device";
pub const SESSION_COOKIE: &str = "__gate_session";
const DEVICE_COOKIE_TTL: i64 = 400 * 86_400;
const SESSION_TTL: i64 = 30 * 86_400;
const TOKEN_LEN: usize = 256;
const MAX_PENDING: i64 = 100;
const ENROLL_PATH: &str = "/__gate/enroll";
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
    if !route.enabled {
        return page(
            StatusCode::SERVICE_UNAVAILABLE,
            "message",
            &host,
            "Switched off",
            "This app is switched off right now.",
        );
    }
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

    if route.require_device && req.method() == Method::POST && req.uri().path() == ENROLL_PATH {
        return enroll(&state, &route, ip, req).await;
    }

    let lan = route
        .require_lan
        .then(|| ip.is_some_and(|ip| state.is_local(&snap, ip)));
    let device = route
        .require_device
        .then(|| has_session(&state, &snap, req.headers(), &route));
    let allowed = match (lan, device) {
        (Some(l), Some(d)) if route.policy_mode == "any" => l || d,
        (l, d) => l.unwrap_or(true) && d.unwrap_or(true),
    };
    if allowed {
        return proxy::forward(&state, &snap, &route, ip, req).await;
    }

    let wants_html = req.method() == Method::GET
        && req
            .headers()
            .get(header::ACCEPT)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.contains("text/html"));
    let network_blocked = lan == Some(false) && (device.is_none() || route.policy_mode == "all");
    match (network_blocked, wants_html) {
        (true, true) => page(
            StatusCode::FORBIDDEN,
            "message",
            &host,
            "Home network only",
            "This app can only be opened from the network it is hosted on.",
        ),
        (true, false) => (StatusCode::FORBIDDEN, "Not on an allowed network").into_response(),
        (false, true) => page(
            StatusCode::UNAUTHORIZED,
            "device",
            &host,
            "Device approval required",
            "This app only opens on approved devices. Give the ID below to the administrator.",
        ),
        (false, false) => (StatusCode::UNAUTHORIZED, "Device approval required").into_response(),
    }
}

pub fn page(status: StatusCode, mode: &str, host: &str, title: &str, text: &str) -> Response {
    let html = TEMPLATE
        .replace("{{MODE}}", mode)
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

fn has_session(state: &AppState, snap: &Snapshot, headers: &HeaderMap, route: &Route) -> bool {
    let Some(sid) = cookie(headers, SESSION_COOKIE) else {
        return false;
    };
    let device_id = match lock(&state.gate_sessions).get(sid) {
        Some(s) if s.expires > now() => s.device_id.clone(),
        _ => return false,
    };
    snap.devices
        .get(&device_id)
        .is_some_and(|d| may_open(d, route))
}

fn may_open(device: &Device, route: &Route) -> bool {
    device.status == "approved" && (device.all_routes || device.route_ids.contains(&route.id))
}

pub fn fingerprint(info: &Value) -> String {
    let parts: Vec<String> = FINGERPRINT_KEYS
        .iter()
        .map(|key| info.get(key).map(Value::to_string).unwrap_or_default())
        .collect();
    sha256_hex(&parts.join("|"))
}

fn valid_token(token: &str) -> bool {
    token.len() == TOKEN_LEN && token.bytes().all(|b| b.is_ascii_alphanumeric())
}

#[derive(Deserialize)]
struct EnrollRequest {
    token: Option<String>,
    #[serde(default)]
    info: Value,
}

async fn enroll(state: &AppState, route: &Route, ip: Option<IpAddr>, req: Request) -> Response {
    let headers = req.headers().clone();
    let Ok(bytes) = axum::body::to_bytes(req.into_body(), 16 * 1024).await else {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    };
    let Ok(body) = serde_json::from_slice::<EnrollRequest>(&bytes) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    match register(state, route, ip, &headers, body) {
        Ok(response) => response,
        Err(err) => err.into_response(),
    }
}

/// Identifies the calling browser by its device key, creating a pending device for a new one,
/// and opens a session when the device is approved for this tunnel.
fn register(
    state: &AppState,
    route: &Route,
    ip: Option<IpAddr>,
    headers: &HeaderMap,
    body: EnrollRequest,
) -> ApiResult<Response> {
    let token = body
        .token
        .filter(|t| valid_token(t))
        .or_else(|| {
            cookie(headers, DEVICE_COOKIE)
                .filter(|t| valid_token(t))
                .map(str::to_owned)
        })
        .unwrap_or_else(|| random_alnum(TOKEN_LEN));
    let token_hash = sha256_hex(&token);
    let print = fingerprint(&body.info);
    let now = now();
    let ip = ip.map(|ip| ip.to_string());
    let country = headers
        .get("cf-ipcountry")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);

    let device = match state.db.device_by_token(&token_hash)? {
        Some(mut device) => {
            let was = device.status.clone();
            if device.status == "approved" && device.fingerprint != print {
                tracing::warn!(
                    "device {} presented different hardware, holding for review",
                    device.id
                );
                device.status = "pending".into();
                device.note = Some("Hardware changed since approval".into());
            }
            device.info = body.info;
            device.last_ip = ip.or(device.last_ip);
            device.country = country.or(device.country);
            device.last_seen = now;
            state.db.save_device(&device)?;
            if device.status != was {
                state.reload()?;
            }
            device
        }
        None => {
            if state.db.pending_count()? >= MAX_PENDING {
                return Err(ApiError(
                    StatusCode::TOO_MANY_REQUESTS,
                    "Too many devices are waiting for approval".into(),
                ));
            }
            let code = random_hex(4).to_uppercase();
            let device = Device {
                id: format!("{}-{}", &code[..4], &code[4..]),
                name: String::new(),
                status: "pending".into(),
                all_routes: false,
                route_ids: Vec::new(),
                fingerprint: print,
                info: body.info,
                note: None,
                first_ip: ip.clone(),
                last_ip: ip,
                country,
                first_host: Some(route.hostname.clone()),
                created_at: now,
                last_seen: now,
            };
            state.db.insert_device(&device, &token_hash)?;
            state.reload()?;
            tracing::info!(
                "device {} asked for access to {}",
                device.id,
                route.hostname
            );
            device
        }
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
    set_cookie(
        out,
        DEVICE_COOKIE,
        &token,
        &route.zone_name,
        DEVICE_COOKIE_TTL,
    );
    if allowed {
        let sid = random_hex(32);
        let mut sessions = lock(&state.gate_sessions);
        sessions.retain(|_, s| s.expires > now);
        sessions.insert(
            sid.clone(),
            GateSession {
                device_id: device.id.clone(),
                expires: now + SESSION_TTL,
            },
        );
        drop(sessions);
        set_cookie(out, SESSION_COOKIE, &sid, &route.zone_name, SESSION_TTL);
    }
    Ok(response)
}

/// Cookies are scoped to the whole domain so one approval covers every tunnel on it.
fn set_cookie(headers: &mut HeaderMap, name: &str, value: &str, domain: &str, max_age: i64) {
    let cookie = format!(
        "{name}={value}; Domain={domain}; Path=/; Max-Age={max_age}; HttpOnly; Secure; SameSite=Lax"
    );
    if let Ok(value) = HeaderValue::from_str(&cookie) {
        headers.append(header::SET_COOKIE, value);
    }
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
}
