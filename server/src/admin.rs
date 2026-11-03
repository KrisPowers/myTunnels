//! The admin panel's API and static files.

use std::time::Duration;

use axum::extract::{Path, Request, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use tower_http::services::{ServeDir, ServeFile};

use crate::cloudflare::{Account, Cloudflare, Zone};
use crate::db::{Device, Route, SignIn, User};
use crate::netinfo;
use crate::state::AppState;
use crate::util::{cookie, lock, now, random_hex, valid_host, ApiError, ApiResult};
use crate::{gate, secret, tunnel};

const ADMIN_COOKIE: &str = "admin_session";
const ADMIN_TTL: i64 = 7 * 86_400;

pub fn router(state: AppState) -> Router {
    let protected = Router::new()
        .route("/settings", get(settings))
        .route("/settings/cloudflare", put(save_cloudflare))
        .route("/settings/network", put(save_network))
        .route("/cloudflare/accounts", post(cloudflare_accounts))
        .route("/zones", get(zones))
        .route("/status", get(status))
        .route("/routes", get(list_routes).post(create_route))
        .route("/routes/{id}", patch(update_route).delete(delete_route))
        .route("/routes/{id}/address", put(move_route))
        .route("/devices", get(list_devices))
        .route("/devices/{id}", patch(update_device).delete(delete_device))
        .route("/device", post(this_device))
        .route("/users", get(list_users).post(create_user))
        .route("/users/{id}", patch(update_user).delete(delete_user))
        .route("/users/{id}/signout", post(sign_out_user))
        .route("/users/{id}/activity", get(user_activity))
        .route("/devices/{id}/activity", get(device_activity))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_admin));
    let api = Router::new()
        .route("/auth", get(auth_state))
        .route("/auth/setup", post(setup))
        .route("/auth/login", post(login))
        .route("/auth/logout", post(logout))
        .merge(protected);
    let ui = &state.config.ui_dir;
    let spa = ServeDir::new(ui).fallback(ServeFile::new(ui.join("index.html")));
    Router::new()
        .nest("/api", api)
        .fallback_service(spa)
        .with_state(state)
}

// Auth

fn is_admin(state: &AppState, headers: &HeaderMap) -> bool {
    cookie(headers, ADMIN_COOKIE).is_some_and(|sid| {
        lock(&state.admin_sessions)
            .get(sid)
            .is_some_and(|exp| *exp > now())
    })
}

async fn require_admin(State(state): State<AppState>, req: Request, next: Next) -> Response {
    if is_admin(&state, req.headers()) {
        next.run(req).await
    } else {
        ApiError(StatusCode::UNAUTHORIZED, "Sign in required".into()).into_response()
    }
}

/// What first-run setup has saved so far, so the panel can resume where it was left.
/// Setup is done once there is a password and Cloudflare is connected.
async fn auth_state(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let db = &state.db;
    let password = db.setting("admin_password")?.is_some();
    Ok(Json(json!({
        "setup_required": !password,
        "authenticated": is_admin(&state, &headers),
        "setup": {
            "password": password,
            "token": db.setting("cf_token")?.is_some(),
            "cloudflare": state.cloudflare().is_ok(),
            "done": password && state.cloudflare().is_ok(),
        },
    })))
}

#[derive(Deserialize)]
struct PasswordBody {
    password: String,
}

async fn setup(
    State(state): State<AppState>,
    Json(body): Json<PasswordBody>,
) -> ApiResult<Response> {
    if state.db.setting("admin_password")?.is_some() {
        return Err(ApiError::conflict("A password is already set"));
    }
    if !secret::strong(&body.password) {
        return Err(ApiError::bad(secret::RULE));
    }
    state
        .db
        .set_setting("admin_password", &secret::hash(&body.password)?)?;
    Ok(start_session(&state))
}

async fn login(
    State(state): State<AppState>,
    Json(body): Json<PasswordBody>,
) -> ApiResult<Response> {
    let Some(hash) = state.db.setting("admin_password")? else {
        return Err(ApiError::bad("Set a password first"));
    };
    if state.locked_out("admin") {
        return Err(ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many wrong tries. Wait 15 minutes and try again.".into(),
        ));
    }
    if !secret::verify(&body.password, &hash) {
        state.record_failure("admin");
        tokio::time::sleep(Duration::from_millis(800)).await;
        return Err(ApiError(StatusCode::UNAUTHORIZED, "Wrong password".into()));
    }
    state.clear_failures("admin");
    Ok(start_session(&state))
}

fn start_session(state: &AppState) -> Response {
    let sid = random_hex(32);
    let now = now();
    let mut sessions = lock(&state.admin_sessions);
    sessions.retain(|_, exp| *exp > now);
    sessions.insert(sid.clone(), now + ADMIN_TTL);
    drop(sessions);
    (
        [(
            header::SET_COOKIE,
            format!("{ADMIN_COOKIE}={sid}; Path=/; Max-Age={ADMIN_TTL}; HttpOnly; SameSite=Strict"),
        )],
        Json(json!({ "ok": true })),
    )
        .into_response()
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Some(sid) = cookie(&headers, ADMIN_COOKIE) {
        lock(&state.admin_sessions).remove(sid);
    }
    (
        [(
            header::SET_COOKIE,
            format!("{ADMIN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict"),
        )],
        Json(json!({ "ok": true })),
    )
        .into_response()
}

// Settings

async fn settings(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let db = &state.db;
    Ok(Json(json!({
        "cloudflare": {
            "configured": state.cloudflare().is_ok(),
            "token_set": db.setting("cf_token")?.is_some(),
            "account_id": db.setting("cf_account_id")?,
            "account_name": db.setting("cf_account_name")?,
            "tunnel_id": db.setting("cf_tunnel_id")?,
            "tunnel_name": db.setting("cf_tunnel_name")?,
        },
        "upstream_host": state.snapshot().upstream_host,
        "default_upstream_host": state.config.default_upstream_host,
        "trusted_networks": db.setting("trusted_networks")?.unwrap_or_default(),
    })))
}

#[derive(Deserialize)]
struct TokenBody {
    api_token: Option<String>,
}

fn token_or_saved(state: &AppState, token: Option<String>) -> ApiResult<String> {
    match token.map(|t| t.trim().to_owned()).filter(|t| !t.is_empty()) {
        Some(token) => Ok(token),
        None => state
            .db
            .setting("cf_token")?
            .ok_or_else(|| ApiError::bad("Enter a Cloudflare API token")),
    }
}

async fn cloudflare_accounts(
    State(state): State<AppState>,
    Json(body): Json<TokenBody>,
) -> ApiResult<Json<Vec<Account>>> {
    let token = token_or_saved(&state, body.api_token)?;
    let accounts = Cloudflare::new(&state.http, &token).accounts().await?;
    // Until Cloudflare is connected, a token that works is kept as soon as it is checked,
    // so setup can be left and resumed. Once connected, only saving the connection replaces it.
    if state.cloudflare().is_err() && !accounts.is_empty() {
        state.db.set_setting("cf_token", &token)?;
    }
    Ok(Json(accounts))
}

#[derive(Deserialize)]
struct CloudflareBody {
    api_token: Option<String>,
    account_id: String,
    tunnel_name: String,
}

async fn save_cloudflare(
    State(state): State<AppState>,
    Json(body): Json<CloudflareBody>,
) -> ApiResult<Json<Value>> {
    let token = token_or_saved(&state, body.api_token)?;
    let name = body.tunnel_name.trim();
    if name.is_empty()
        || name.len() > 64
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(ApiError::bad(
            "Tunnel name: letters, digits, '-' and '_' only",
        ));
    }
    let same_target = state.db.setting("cf_account_id")?.as_deref()
        == Some(body.account_id.as_str())
        && state.db.setting("cf_tunnel_name")?.as_deref() == Some(name);
    if !same_target && !state.db.routes()?.is_empty() {
        return Err(ApiError::conflict(
            "Remove all tunnels before switching to another account or tunnel",
        ));
    }

    let cf = Cloudflare::new(&state.http, &token);
    let account = cf
        .accounts()
        .await?
        .into_iter()
        .find(|a| a.id == body.account_id)
        .ok_or_else(|| ApiError::bad("This token cannot access that account"))?;
    let tunnel = match cf.find_tunnel(&account.id, name).await? {
        Some(tunnel) => tunnel,
        None => cf.create_tunnel(&account.id, name).await?,
    };
    let tunnel_token = cf.tunnel_token(&account.id, &tunnel.id).await?;

    for (key, value) in [
        ("cf_token", token.as_str()),
        ("cf_account_id", account.id.as_str()),
        ("cf_account_name", account.name.as_str()),
        ("cf_tunnel_id", tunnel.id.as_str()),
        ("cf_tunnel_name", name),
        ("cf_tunnel_token", tunnel_token.as_str()),
    ] {
        state.db.set_setting(key, value)?;
    }
    state.tunnel.set_token(Some(tunnel_token));
    tunnel::sync_ingress(&state).await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct NetworkBody {
    upstream_host: String,
    trusted_networks: String,
}

async fn save_network(
    State(state): State<AppState>,
    Json(body): Json<NetworkBody>,
) -> ApiResult<Json<Value>> {
    let host = body.upstream_host.trim();
    if !valid_host(host) {
        return Err(ApiError::bad("Enter a host name or IP address for apps"));
    }
    netinfo::parse_networks(&body.trusted_networks)
        .map_err(|entry| ApiError::bad(format!("Not a network: {entry}")))?;
    state.db.set_setting("upstream_host", host)?;
    state
        .db
        .set_setting("trusted_networks", body.trusted_networks.trim())?;
    state.reload()?;
    Ok(Json(json!({ "ok": true })))
}

async fn zones(State(state): State<AppState>) -> ApiResult<Json<Vec<Zone>>> {
    let cf = state.cloudflare()?;
    Ok(Json(
        Cloudflare::new(&state.http, &cf.token)
            .zones(&cf.account_id)
            .await?,
    ))
}

async fn status(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let connections = tunnel::ready_connections(&state).await;
    let view = state.tunnel.view();
    let public_ips: Vec<String> = state.public_ips().iter().map(|ip| ip.to_string()).collect();
    Ok(Json(json!({
        "configured": state.cloudflare().is_ok(),
        "running": view.running,
        "connections": connections,
        "restarts": view.restarts,
        "last_error": view.last_error,
        "logs": view.logs,
        "public_ips": public_ips,
    })))
}

// Tunnels

fn valid_label(label: &str) -> bool {
    (1..=63).contains(&label.len())
        && label
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !label.starts_with('-')
        && !label.ends_with('-')
}

fn check_target(host: Option<String>, scheme: &str, mode: &str) -> ApiResult<Option<String>> {
    if scheme != "http" && scheme != "https" {
        return Err(ApiError::bad("Scheme must be http or https"));
    }
    if mode != "all" && mode != "any" {
        return Err(ApiError::bad("Policy mode must be all or any"));
    }
    match host.map(|h| h.trim().to_owned()).filter(|h| !h.is_empty()) {
        Some(h) if !valid_host(&h) => Err(ApiError::bad("Target host is not a valid host name")),
        other => Ok(other),
    }
}

/// Refuses a tunnel aimed at one of myTunnels' own ports on this machine.
fn check_not_self(state: &AppState, host: Option<&str>, port: u16) -> ApiResult<()> {
    let snap = state.snapshot();
    let host = host.unwrap_or(&snap.upstream_host);
    let local = host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback() || ip.is_unspecified());
    let own = [&state.config.gate_addr, &state.config.admin_addr]
        .iter()
        .any(|addr| {
            addr.rsplit_once(':')
                .and_then(|(_, p)| p.parse::<u16>().ok())
                == Some(port)
        });
    if local && own {
        return Err(ApiError::bad(format!(
            "Port {port} is myTunnels' own. Use the port your app listens on."
        )));
    }
    Ok(())
}

async fn list_routes(State(state): State<AppState>) -> ApiResult<Json<Vec<Route>>> {
    Ok(Json(state.db.routes()?))
}

fn default_scheme() -> String {
    "http".into()
}

fn default_mode() -> String {
    "all".into()
}

fn default_login_max() -> i64 {
    7 * 86_400
}

/// Sign-in limits: from 0 (never) up to the longest a sign-in can last.
fn check_limits(max: i64, idle: i64) -> ApiResult<()> {
    let longest = 30 * 86_400;
    if !(0..=longest).contains(&max) || !(0..=longest).contains(&idle) {
        return Err(ApiError::bad("Sign-in limits run from never up to 30 days"));
    }
    Ok(())
}

#[derive(Deserialize)]
struct NewRoute {
    subdomain: String,
    zone_id: String,
    port: u16,
    target_host: Option<String>,
    #[serde(default = "default_scheme")]
    target_scheme: String,
    #[serde(default)]
    require_lan: bool,
    #[serde(default)]
    require_device: bool,
    #[serde(default = "default_mode")]
    policy_mode: String,
    #[serde(default)]
    require_password: bool,
    password: Option<String>,
    #[serde(default)]
    require_login: bool,
    #[serde(default = "default_login_max")]
    login_max: i64,
    #[serde(default)]
    login_idle: i64,
    #[serde(default)]
    preserve_host: bool,
}

/// A tunnel password to store: a new one when given, which must be strong, else the
/// one already set. Asking for a password with none set is refused.
fn tunnel_password(
    required: bool,
    given: Option<String>,
    current: Option<String>,
) -> ApiResult<Option<String>> {
    let hash = match given.filter(|p| !p.is_empty()) {
        Some(p) if !secret::strong(&p) => return Err(ApiError::bad(secret::RULE)),
        Some(p) => Some(secret::hash(&p)?),
        None => current,
    };
    if required && hash.is_none() {
        return Err(ApiError::bad("Set the tunnel password"));
    }
    Ok(hash)
}

async fn create_route(
    State(state): State<AppState>,
    Json(body): Json<NewRoute>,
) -> ApiResult<Json<Route>> {
    let cf_settings = state.cloudflare()?;
    let subdomain = body.subdomain.trim().to_ascii_lowercase();
    if !valid_label(&subdomain) {
        return Err(ApiError::bad(
            "Subdomain: lowercase letters, digits and '-', up to 63 characters",
        ));
    }
    if body.port == 0 {
        return Err(ApiError::bad("Port must be between 1 and 65535"));
    }
    let target_host = check_target(body.target_host, &body.target_scheme, &body.policy_mode)?;
    check_not_self(&state, target_host.as_deref(), body.port)?;
    let password_hash = tunnel_password(body.require_password, body.password, None)?;
    check_limits(body.login_max, body.login_idle)?;

    let cf = Cloudflare::new(&state.http, &cf_settings.token);
    let zone = cf
        .zones(&cf_settings.account_id)
        .await?
        .into_iter()
        .find(|z| z.id == body.zone_id)
        .ok_or_else(|| ApiError::bad("That domain is not on this Cloudflare account"))?;
    let hostname = format!("{subdomain}.{}", zone.name);
    if state.snapshot().routes.contains_key(&hostname) {
        return Err(ApiError::conflict(format!(
            "{hostname} is already published"
        )));
    }

    let target = format!("{}.cfargotunnel.com", cf_settings.tunnel_id);
    let (record_id, created) = match cf.find_dns(&zone.id, &hostname).await? {
        Some(record) if record.content == target => (record.id, false),
        Some(record) => {
            return Err(ApiError::conflict(format!(
                "{hostname} already has a {} record in Cloudflare. Remove it first.",
                record.kind
            )))
        }
        None => (
            cf.create_cname(&zone.id, &hostname, &target).await?.id,
            true,
        ),
    };

    let route = Route {
        id: random_hex(8),
        subdomain,
        zone_id: zone.id.clone(),
        zone_name: zone.name,
        hostname,
        target_host,
        target_port: body.port,
        target_scheme: body.target_scheme,
        require_lan: body.require_lan,
        require_device: body.require_device,
        policy_mode: body.policy_mode,
        enabled: true,
        require_password: body.require_password,
        password_set: password_hash.is_some(),
        password_hash,
        require_login: body.require_login,
        login_max: body.login_max,
        login_idle: body.login_idle,
        preserve_host: body.preserve_host,
        dns_record_id: Some(record_id.clone()),
        created_at: now(),
    };
    state.db.insert_route(&route)?;
    if let Err(err) = tunnel::sync_ingress(&state).await {
        state.db.delete_route(&route.id)?;
        if created {
            if let Err(e) = cf.delete_dns(&zone.id, &record_id).await {
                tracing::warn!("could not roll back DNS for {}: {e:#}", route.hostname);
            }
        }
        return Err(err.into());
    }
    state.reload()?;
    tracing::info!("published {} -> port {}", route.hostname, route.target_port);
    Ok(Json(route))
}

#[derive(Deserialize)]
struct RouteEdit {
    port: u16,
    target_host: Option<String>,
    target_scheme: String,
    require_lan: bool,
    require_device: bool,
    policy_mode: String,
    enabled: bool,
    #[serde(default)]
    require_password: bool,
    password: Option<String>,
    #[serde(default)]
    require_login: bool,
    #[serde(default = "default_login_max")]
    login_max: i64,
    #[serde(default)]
    login_idle: i64,
    #[serde(default)]
    preserve_host: bool,
}

async fn update_route(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<RouteEdit>,
) -> ApiResult<Json<Route>> {
    let mut route = state.db.route(&id)?.ok_or_else(ApiError::not_found)?;
    if body.port == 0 {
        return Err(ApiError::bad("Port must be between 1 and 65535"));
    }
    route.target_host = check_target(body.target_host, &body.target_scheme, &body.policy_mode)?;
    check_not_self(&state, route.target_host.as_deref(), body.port)?;
    route.target_port = body.port;
    route.target_scheme = body.target_scheme;
    route.require_lan = body.require_lan;
    route.require_device = body.require_device;
    route.policy_mode = body.policy_mode;
    route.enabled = body.enabled;
    route.password_hash = tunnel_password(
        body.require_password,
        body.password,
        route.password_hash.take(),
    )?;
    route.password_set = route.password_hash.is_some();
    route.require_password = body.require_password;
    check_limits(body.login_max, body.login_idle)?;
    route.require_login = body.require_login;
    route.login_max = body.login_max;
    route.login_idle = body.login_idle;
    route.preserve_host = body.preserve_host;
    state.db.update_route(&route)?;
    state.reload()?;
    Ok(Json(route))
}

#[derive(Deserialize)]
struct AddressEdit {
    subdomain: String,
    zone_id: String,
}

/// Moves a tunnel to another subdomain or domain: the new DNS record first, then the
/// route, then the old record goes. Anything that fails puts things back.
async fn move_route(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<AddressEdit>,
) -> ApiResult<Json<Route>> {
    let cf_settings = state.cloudflare()?;
    let mut route = state.db.route(&id)?.ok_or_else(ApiError::not_found)?;
    let subdomain = body.subdomain.trim().to_ascii_lowercase();
    if !valid_label(&subdomain) {
        return Err(ApiError::bad(
            "Subdomain: lowercase letters, digits and '-', up to 63 characters",
        ));
    }
    let cf = Cloudflare::new(&state.http, &cf_settings.token);
    let zone = cf
        .zones(&cf_settings.account_id)
        .await?
        .into_iter()
        .find(|z| z.id == body.zone_id)
        .ok_or_else(|| ApiError::bad("That domain is not on this Cloudflare account"))?;
    let hostname = format!("{subdomain}.{}", zone.name);
    if hostname == route.hostname {
        return Ok(Json(route));
    }
    if state.snapshot().routes.contains_key(&hostname) {
        return Err(ApiError::conflict(format!(
            "{hostname} is already published"
        )));
    }

    let target = format!("{}.cfargotunnel.com", cf_settings.tunnel_id);
    let (record_id, created) = match cf.find_dns(&zone.id, &hostname).await? {
        Some(record) if record.content == target => (record.id, false),
        Some(record) => {
            return Err(ApiError::conflict(format!(
                "{hostname} already has a {} record in Cloudflare. Remove it first.",
                record.kind
            )))
        }
        None => (
            cf.create_cname(&zone.id, &hostname, &target).await?.id,
            true,
        ),
    };

    let before = route.clone();
    route.subdomain = subdomain;
    route.zone_id = zone.id.clone();
    route.zone_name = zone.name;
    route.hostname = hostname;
    route.dns_record_id = Some(record_id.clone());
    state.db.move_route(&route)?;
    if let Err(err) = tunnel::sync_ingress(&state).await {
        state.db.move_route(&before)?;
        if created {
            if let Err(e) = cf.delete_dns(&zone.id, &record_id).await {
                tracing::warn!("could not roll back DNS for {}: {e:#}", route.hostname);
            }
        }
        return Err(err.into());
    }
    if let Some(old) = &before.dns_record_id {
        if let Err(e) = cf.delete_dns(&before.zone_id, old).await {
            tracing::warn!("could not delete DNS for {}: {e:#}", before.hostname);
        }
    }
    state.reload()?;
    tracing::info!("moved {} to {}", before.hostname, route.hostname);
    Ok(Json(route))
}

async fn delete_route(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let route = state.db.route(&id)?.ok_or_else(ApiError::not_found)?;
    if let (Ok(cf), Some(record_id)) = (state.cloudflare(), &route.dns_record_id) {
        if let Err(err) = Cloudflare::new(&state.http, &cf.token)
            .delete_dns(&route.zone_id, record_id)
            .await
        {
            tracing::warn!("could not delete DNS for {}: {err:#}", route.hostname);
        }
    }
    state.db.delete_route(&id)?;
    state.reload()?;
    if state.cloudflare().is_ok() {
        tunnel::sync_ingress(&state).await?;
    }
    tracing::info!("removed {}", route.hostname);
    Ok(Json(json!({ "ok": true })))
}

// Devices

async fn list_devices(State(state): State<AppState>) -> ApiResult<Json<Vec<Device>>> {
    Ok(Json(state.db.devices()?))
}

#[derive(Deserialize)]
struct DeviceEdit {
    name: Option<String>,
    status: Option<String>,
    all_routes: Option<bool>,
    route_ids: Option<Vec<String>>,
}

async fn update_device(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<DeviceEdit>,
) -> ApiResult<Json<Device>> {
    let mut device = state.db.device(&id)?.ok_or_else(ApiError::not_found)?;
    if let Some(name) = body.name {
        device.name = name.trim().chars().take(80).collect();
    }
    if let Some(status) = body.status {
        match status.as_str() {
            // Approval accepts the hardware the device reported most recently.
            "approved" => {
                device.fingerprint = gate::fingerprint(&device.info);
                device.note = None;
            }
            "seen" | "pending" | "denied" => {}
            _ => return Err(ApiError::bad("Status must be approved, pending or denied")),
        }
        device.status = status;
    }
    if let Some(all) = body.all_routes {
        device.all_routes = all;
    }
    state.db.save_device(&device)?;
    if let Some(route_ids) = body.route_ids {
        let snap = state.snapshot();
        let known: Vec<String> = route_ids
            .into_iter()
            .filter(|rid| snap.routes.values().any(|r| &r.id == rid))
            .collect();
        state.db.set_grants(&device.id, &known)?;
    }
    state.reload()?;
    Ok(Json(state.db.device(&id)?.ok_or_else(ApiError::not_found)?))
}

async fn delete_device(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    state.db.delete_device(&id)?;
    lock(&state.device_sessions).retain(|_, s| s.subject != id);
    state.reload()?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct ThisDevice {
    token: Option<String>,
    #[serde(default)]
    info: Value,
}

/// The browser the admin is using: given a device key the first time, approved for
/// every tunnel, so the host's own browser is never stopped at its own tunnels.
async fn this_device(
    State(state): State<AppState>,
    Json(body): Json<ThisDevice>,
) -> ApiResult<Json<Value>> {
    let (device, token) = gate::dashboard_device(&state, body.token, body.info)?;
    Ok(Json(json!({ "id": device.id, "token": token })))
}

// Users: accounts that sign in at tunnels asking for one

async fn list_users(State(state): State<AppState>) -> ApiResult<Json<Vec<User>>> {
    Ok(Json(state.db.users()?))
}

fn valid_username(name: &str) -> bool {
    (2..=40).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
}

/// An account's email: required, as it is what they sign in with.
fn clean_email(email: &str) -> ApiResult<String> {
    let email = email.trim();
    let (local, domain) = email.split_once('@').unwrap_or_default();
    if local.is_empty()
        || !domain.contains('.')
        || domain.starts_with('.')
        || domain.ends_with('.')
        || email.len() > 254
        || email.contains(char::is_whitespace)
    {
        return Err(ApiError::bad("Enter a valid email address"));
    }
    Ok(email.to_owned())
}

fn known_routes(state: &AppState, ids: Vec<String>) -> Vec<String> {
    let snap = state.snapshot();
    ids.into_iter()
        .filter(|id| snap.routes.values().any(|r| &r.id == id))
        .collect()
}

/// Each username and each email belongs to one account.
fn check_unique(state: &AppState, id: &str, username: &str, email: &str) -> ApiResult<()> {
    for other in state.db.users()?.iter().filter(|u| u.id != id) {
        if other.username.eq_ignore_ascii_case(username) {
            return Err(ApiError::conflict(
                "Another account already has that username",
            ));
        }
        if other.email.eq_ignore_ascii_case(email) {
            return Err(ApiError::conflict("Another account already has that email"));
        }
    }
    Ok(())
}

#[derive(Deserialize)]
struct NewUser {
    username: String,
    email: String,
    #[serde(default)]
    name: String,
    password: String,
    #[serde(default)]
    all_routes: bool,
    #[serde(default)]
    route_ids: Vec<String>,
}

async fn create_user(
    State(state): State<AppState>,
    Json(body): Json<NewUser>,
) -> ApiResult<Json<User>> {
    let username = body.username.trim().to_owned();
    if !valid_username(&username) {
        return Err(ApiError::bad(
            "Username: 2 to 40 letters, digits, '.', '-' or '_'",
        ));
    }
    let email = clean_email(&body.email)?;
    check_unique(&state, "", &username, &email)?;
    if !secret::strong(&body.password) {
        return Err(ApiError::bad(secret::RULE));
    }
    let user = User {
        id: random_hex(8),
        username,
        email,
        name: body.name.trim().chars().take(80).collect(),
        password_hash: secret::hash(&body.password)?,
        enabled: true,
        all_routes: body.all_routes,
        route_ids: known_routes(&state, body.route_ids),
        created_at: now(),
        last_login: None,
        note: None,
    };
    state.db.save_user(&user)?;
    state.reload()?;
    Ok(Json(user))
}

#[derive(Deserialize)]
struct UserEdit {
    username: Option<String>,
    email: Option<String>,
    name: Option<String>,
    password: Option<String>,
    enabled: Option<bool>,
    all_routes: Option<bool>,
    route_ids: Option<Vec<String>>,
}

async fn update_user(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<UserEdit>,
) -> ApiResult<Json<User>> {
    let mut user = state.db.user(&id)?.ok_or_else(ApiError::not_found)?;
    if let Some(username) = body.username.map(|u| u.trim().to_owned()) {
        if !valid_username(&username) {
            return Err(ApiError::bad(
                "Username: 2 to 40 letters, digits, '.', '-' or '_'",
            ));
        }
        user.username = username;
    }
    if let Some(email) = body.email {
        user.email = clean_email(&email)?;
    }
    check_unique(&state, &user.id, &user.username, &user.email)?;
    if let Some(name) = body.name {
        user.name = name.trim().chars().take(80).collect();
    }
    if let Some(password) = body.password.filter(|p| !p.is_empty()) {
        if !secret::strong(&password) {
            return Err(ApiError::bad(secret::RULE));
        }
        user.password_hash = secret::hash(&password)?;
    }
    if let Some(enabled) = body.enabled {
        user.enabled = enabled;
        // Turning an account back on clears what held it.
        if enabled {
            user.note = None;
        }
    }
    if let Some(all) = body.all_routes {
        user.all_routes = all;
    }
    if let Some(ids) = body.route_ids {
        user.route_ids = known_routes(&state, ids);
    }
    state.db.save_user(&user)?;
    state.reload()?;
    Ok(Json(user))
}

async fn delete_user(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    state.db.delete_user(&id)?;
    lock(&state.user_sessions).retain(|_, s| s.subject != id);
    state.reload()?;
    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::{valid_label, valid_username};

    #[test]
    fn usernames() {
        assert!(valid_username("kris.p"));
        assert!(!valid_username("k"));
        assert!(!valid_username("kris p"));
    }

    #[test]
    fn subdomain_labels() {
        assert!(valid_label("app1"));
        assert!(valid_label("my-app"));
        assert!(!valid_label("-app"));
        assert!(!valid_label("App"));
        assert!(!valid_label("a.b"));
        assert!(!valid_label(""));
    }
}
