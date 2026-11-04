//! The admin panel's API and static files.

use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use axum::extract::{ConnectInfo, Path, Request, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, patch, post, put};
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use tower_http::services::{ServeDir, ServeFile};

use crate::cloudflare::{Account, Cloudflare, Zone};
use crate::db::{Device, Event, Route, SignIn, User};
use crate::mail::{self, Smtp};
use crate::netinfo;
use crate::oauth::{self, Provider};
use crate::state::AppState;
use crate::util::{cookie, now, random_hex, valid_host, ApiError, ApiResult};
use crate::{codes, containers, gate, metrics, secret, storage, tunnel};

const ADMIN_COOKIE: &str = "admin_session";
const ADMIN_TTL: i64 = 7 * 86_400;

pub fn router(state: AppState) -> Router {
    let protected = Router::new()
        .route("/account", get(account).patch(edit_account))
        .route("/oauth", get(list_oauth))
        .route("/oauth/{id}", put(save_oauth).delete(delete_oauth))
        .route("/twofactor", get(two_factor).put(save_two_factor))
        .route("/twofactor/smtp", put(save_smtp))
        .route("/twofactor/test", post(test_mail))
        .route("/settings", get(settings))
        .route("/settings/cloudflare", put(save_cloudflare))
        .route("/settings/network", put(save_network))
        .route("/cloudflare/accounts", post(cloudflare_accounts))
        .route("/zones", get(zones))
        .route("/status", get(status))
        .route("/metrics", get(metrics))
        .route("/containers", get(list_containers))
        .route(
            "/containers/{id}",
            get(inspect_container).delete(remove_container),
        )
        .route("/containers/{id}/logs", get(container_logs))
        .route("/containers/{id}/{action}", post(container_action))
        .route("/routes", get(list_routes).post(create_route))
        .route("/routes/{id}", patch(update_route).delete(delete_route))
        .route("/routes/{id}/address", put(move_route))
        .route("/routes/{id}/activity", get(route_activity))
        .route("/devices", get(list_devices))
        .route("/devices/{id}", patch(update_device).delete(delete_device))
        .route("/device", post(this_device))
        .route("/device/plant", post(plant_device))
        .route("/users", get(list_users).post(create_user))
        .route("/users/{id}", patch(update_user).delete(delete_user))
        .route("/users/{id}/signout", post(sign_out_user))
        .route("/users/{id}/activity", get(user_activity))
        .route("/devices/{id}/activity", get(device_activity))
        .route("/storage", get(storage_overview).put(save_storage))
        .route("/storage/browse", get(browse_host))
        .route("/storage/rules", post(add_rule))
        .route("/storage/rules/{id}", patch(edit_rule).delete(delete_rule))
        .route("/storage/fs/{op}", any(storage_fs))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_admin));
    let api = Router::new()
        .route("/auth", get(auth_state))
        .route("/auth/setup", post(setup))
        .route("/auth/login", post(login))
        .route("/auth/code", post(login_code))
        .route("/auth/logout", post(logout))
        .merge(protected)
        .layer(middleware::from_fn_with_state(state.clone(), guard_api));
    let ui = &state.config.ui_dir;
    let spa = ServeDir::new(ui).fallback(ServeFile::new(ui.join("index.html")));
    Router::new()
        .nest("/api", api)
        .fallback_service(spa)
        .layer(middleware::from_fn(harden))
        .with_state(state)
}

/// Requests from one address each minute, and of those, sign-in and setup attempts.
const API_PER_MINUTE: u32 = 600;
const AUTH_PER_MINUTE: u32 = 10;

/// The address a request to the panel came from.
#[derive(Clone, Copy)]
struct Peer(IpAddr);

/// Rate limits every call, refuses changes a page on another site could send (it
/// cannot set the header the panel sends), and keeps answers out of caches.
async fn guard_api(State(state): State<AppState>, mut req: Request, next: Next) -> Response {
    let ip = req
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map_or(IpAddr::from([0, 0, 0, 0]), |c| c.0.ip());
    req.extensions_mut().insert(Peer(ip));
    let changes = !matches!(*req.method(), Method::GET | Method::HEAD);
    let auth = changes && req.uri().path().starts_with("/auth/");
    if !state.allow(&format!("api:{ip}"), API_PER_MINUTE, 60)
        || (auth && !state.allow(&format!("api-auth:{ip}"), AUTH_PER_MINUTE, 60))
    {
        return ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many requests. Wait a minute and try again.".into(),
        )
        .into_response();
    }
    if changes && !req.headers().contains_key("x-requested-with") {
        return ApiError(
            StatusCode::FORBIDDEN,
            "Refused: not sent by the panel".into(),
        )
        .into_response();
    }
    let mut response = next.run(req).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// Headers that keep the panel from being framed, sniffed or loading anything but
/// its own files.
async fn harden(req: Request, next: Next) -> Response {
    let mut response = next.run(req).await;
    let headers = response.headers_mut();
    for (name, value) in [
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        (header::X_FRAME_OPTIONS, "DENY"),
        (header::REFERRER_POLICY, "no-referrer"),
        (
            header::CONTENT_SECURITY_POLICY,
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
        ),
        (
            HeaderName::from_static("permissions-policy"),
            "camera=(), microphone=(), geolocation=(), payment=()",
        ),
    ] {
        headers.insert(name, HeaderValue::from_static(value));
    }
    response
}

// Auth

/// A session opened with the admin password as it is now.
fn is_admin(state: &AppState, headers: &HeaderMap) -> bool {
    let Some(session) =
        cookie(headers, ADMIN_COOKIE).and_then(|v| state.session(&state.admin_sessions, v))
    else {
        return false;
    };
    state
        .db
        .setting("admin_password")
        .ok()
        .flatten()
        .is_some_and(|hash| secret::tag(&hash) == session.tag)
}

async fn require_admin(State(state): State<AppState>, req: Request, next: Next) -> Response {
    if is_admin(&state, req.headers()) {
        next.run(req).await
    } else {
        ApiError(StatusCode::UNAUTHORIZED, "Sign in required".into()).into_response()
    }
}

/// What first-run setup has saved so far, so the panel can resume where it was left.
/// Setup is done once there is an admin account and Cloudflare is connected.
async fn auth_state(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let db = &state.db;
    let password = db.setting("admin_password")?.is_some();
    Ok(Json(json!({
        "setup_required": !password,
        "authenticated": is_admin(&state, &headers),
        "setup": {
            "password": password,
            "account": db.setting("admin_username")?.is_some(),
            "token": db.setting("cf_token")?.is_some(),
            "cloudflare": state.cloudflare().is_ok(),
            "done": password && state.cloudflare().is_ok(),
        },
    })))
}

#[derive(Deserialize)]
struct AccountBody {
    email: String,
    username: String,
    password: String,
}

/// Creates the admin account: an email, a username and a password.
async fn setup(
    State(state): State<AppState>,
    Json(body): Json<AccountBody>,
) -> ApiResult<Response> {
    if state.db.setting("admin_password")?.is_some() {
        return Err(ApiError::conflict("The admin account already exists"));
    }
    let username = admin_username(&body.username)?;
    let email = clean_email(&body.email)?;
    if !secret::strong(&body.password) {
        return Err(ApiError::bad(secret::RULE));
    }
    state.db.set_setting("admin_username", &username)?;
    state.db.set_setting("admin_email", &email)?;
    state
        .db
        .set_setting("admin_password", &secret::hash(&body.password)?)?;
    start_session(&state)
}

fn admin_username(name: &str) -> ApiResult<String> {
    let name = name.trim();
    if !valid_username(name) {
        return Err(ApiError::bad(
            "Username: 2 to 40 letters, digits, '.', '-' or '_'",
        ));
    }
    Ok(name.to_owned())
}

#[derive(Deserialize)]
struct LoginBody {
    /// The admin's email or username. Installs made before the admin account
    /// existed sign in with the password alone until one is set.
    #[serde(default)]
    login: String,
    password: String,
}

/// True when `login` names the admin account, or when there is no account to name.
fn names_admin(state: &AppState, login: &str) -> ApiResult<bool> {
    let login = login.trim();
    let username = state.db.setting("admin_username")?;
    let email = state.db.setting("admin_email")?;
    if username.is_none() && email.is_none() {
        return Ok(true);
    }
    Ok([username, email]
        .into_iter()
        .flatten()
        .any(|v| !login.is_empty() && v.eq_ignore_ascii_case(login)))
}

async fn login(
    State(state): State<AppState>,
    Extension(Peer(ip)): Extension<Peer>,
    Json(body): Json<LoginBody>,
) -> ApiResult<Response> {
    let Some(hash) = state.db.setting("admin_password")? else {
        return Err(ApiError::bad("Create the admin account first"));
    };
    let key = format!("admin:{ip}");
    if state.locked_out(&key) {
        return Err(ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many wrong tries. Wait 15 minutes and try again.".into(),
        ));
    }
    // The password is checked either way, so a wrong name takes as long to refuse.
    let password_ok = secret::verify(&body.password, &hash);
    if !(password_ok && names_admin(&state, &body.login)?) {
        state.record_failure(&key);
        tokio::time::sleep(Duration::from_millis(800)).await;
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "Those details are not right".into(),
        ));
    }
    state.clear_failures(&key);
    if !dashboard_codes(&state)? {
        return start_session(&state);
    }
    let email = state.db.setting("admin_email")?.unwrap_or_default();
    let (ticket, sent_to) =
        codes::send(&state, "admin", &email, "", "", "the myTunnels dashboard").await?;
    Ok(
        Json(json!({ "code_required": true, "ticket": ticket, "sent_to": sent_to }))
            .into_response(),
    )
}

/// Whether every sign-in to the dashboard also asks for an emailed code.
fn dashboard_codes(state: &AppState) -> ApiResult<bool> {
    Ok(state.db.setting("twofactor_dashboard")?.as_deref() == Some("1"))
}

#[derive(Deserialize)]
struct CodeBody {
    ticket: String,
    code: String,
}

/// The emailed code that finishes signing in to the dashboard.
async fn login_code(
    State(state): State<AppState>,
    Json(body): Json<CodeBody>,
) -> ApiResult<Response> {
    match state.codes.redeem(&body.ticket, &body.code) {
        Ok(p) if p.subject == "admin" && p.route_id.is_empty() => start_session(&state),
        Ok(_) => Err(ApiError(StatusCode::UNAUTHORIZED, "Sign in again".into())),
        Err(why) => Err(ApiError(StatusCode::UNAUTHORIZED, why.into())),
    }
}

fn start_session(state: &AppState) -> ApiResult<Response> {
    let hash = state.db.setting("admin_password")?.unwrap_or_default();
    let sid = state.open_session(
        &state.admin_sessions,
        "admin",
        &secret::tag(&hash),
        "",
        ADMIN_TTL,
        false,
    );
    Ok((
        [(
            header::SET_COOKIE,
            format!("{ADMIN_COOKIE}={sid}; Path=/; Max-Age={ADMIN_TTL}; HttpOnly; SameSite=Strict"),
        )],
        Json(json!({ "ok": true })),
    )
        .into_response())
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Some(session) =
        cookie(&headers, ADMIN_COOKIE).and_then(|v| state.session(&state.admin_sessions, v))
    {
        state.end_session(&state.admin_sessions, &session);
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

// The admin account

async fn account(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    Ok(Json(json!({
        "username": state.db.setting("admin_username")?,
        "email": state.db.setting("admin_email")?,
    })))
}

#[derive(Deserialize)]
struct AccountEdit {
    username: Option<String>,
    email: Option<String>,
}

async fn edit_account(
    State(state): State<AppState>,
    Json(body): Json<AccountEdit>,
) -> ApiResult<Json<Value>> {
    if let Some(username) = body.username {
        state
            .db
            .set_setting("admin_username", &admin_username(&username)?)?;
    }
    if let Some(email) = body.email {
        state.db.set_setting("admin_email", &clean_email(&email)?)?;
    }
    account(State(state)).await
}

// Third-party sign-in

/// Every provider, set up or not. Tunnels pick from the ones set up.
async fn list_oauth(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let mut providers = Vec::new();
    for spec in &oauth::SPECS {
        let id = spec.id;
        let saved = oauth::load(&state.db, id)?;
        let p = saved.clone().unwrap_or_else(|| Provider {
            id: id.to_owned(),
            ..Provider::default()
        });
        providers.push(json!({
            "id": id,
            "label": p.label(),
            "name": p.name,
            "issuer": p.issuer,
            "client_id": p.client_id,
            "secret_set": !p.client_secret.is_empty(),
            "needs_issuer": spec.needs_issuer(),
            "configured": saved.is_some(),
        }));
    }
    Ok(Json(json!({ "providers": providers })))
}

#[derive(Deserialize)]
struct ProviderBody {
    client_id: Option<String>,
    /// A new secret; left out, the saved one stays.
    client_secret: Option<String>,
    name: Option<String>,
    issuer: Option<String>,
}

async fn save_oauth(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<ProviderBody>,
) -> ApiResult<Json<Value>> {
    let Some(spec) = oauth::spec(&id) else {
        return Err(ApiError::not_found());
    };
    let mut p = oauth::load(&state.db, &id)?.unwrap_or_else(|| Provider {
        id: id.clone(),
        ..Provider::default()
    });
    let changed = body.client_id.is_some() || body.issuer.is_some();
    if let Some(v) = body.client_id {
        p.client_id = v.trim().to_owned();
    }
    if let Some(v) = body
        .client_secret
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
    {
        p.client_secret = v;
    }
    if let Some(v) = body.name {
        p.name = v.trim().chars().take(40).collect();
    }
    if let Some(v) = body.issuer {
        p.issuer = v.trim().trim_end_matches('/').to_owned();
    }
    if p.client_id.is_empty() || p.client_secret.is_empty() {
        return Err(ApiError::bad("Enter the client ID and the client secret"));
    }
    if spec.needs_issuer() && !(p.issuer.starts_with("https://") || p.issuer.starts_with("http://"))
    {
        return Err(ApiError::bad(
            "Enter the issuer URL, starting with https://",
        ));
    }
    if changed {
        oauth::check(&state.http, &p)
            .await
            .map_err(|e| ApiError::bad(format!("{e:#}")))?;
    }
    oauth::save(&state.db, &p)?;
    list_oauth(State(state)).await
}

async fn delete_oauth(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    oauth::remove(&state.db, &id)?;
    list_oauth(State(state)).await
}

// Two-factor: the SMTP credentials, and where emailed codes are asked for

async fn two_factor(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let smtp = mail::load(&state.db)?.map(|m| {
        json!({
            "host": m.host,
            "port": m.port,
            "security": m.security,
            "username": m.username,
            "password_set": !m.password.is_empty(),
            "from": m.from,
        })
    });
    Ok(Json(json!({
        "smtp": smtp,
        "dashboard": dashboard_codes(&state)?,
        "admin_email": state.db.setting("admin_email")?,
    })))
}

#[derive(Deserialize)]
struct SmtpBody {
    host: String,
    port: u16,
    security: String,
    #[serde(default)]
    username: String,
    /// A new password; left out, the saved one stays.
    password: Option<String>,
    from: String,
}

/// Saves SMTP credentials once the server accepts them.
async fn save_smtp(
    State(state): State<AppState>,
    Json(body): Json<SmtpBody>,
) -> ApiResult<Json<Value>> {
    let host = body.host.trim();
    if !valid_host(host) {
        return Err(ApiError::bad("Enter the SMTP host, such as smtp.gmail.com"));
    }
    if body.port == 0 {
        return Err(ApiError::bad("Port must be between 1 and 65535"));
    }
    if !matches!(body.security.as_str(), "starttls" | "tls" | "none") {
        return Err(ApiError::bad("Security must be STARTTLS, TLS or none"));
    }
    let from = body.from.trim();
    if from.parse::<lettre::message::Mailbox>().is_err() {
        return Err(ApiError::bad(
            "Enter the from address, such as you@gmail.com",
        ));
    }
    let saved = mail::load(&state.db)?.unwrap_or_default();
    let smtp = Smtp {
        host: host.to_owned(),
        port: body.port,
        security: body.security,
        username: body.username.trim().to_owned(),
        password: body
            .password
            .filter(|p| !p.is_empty())
            .unwrap_or(saved.password),
        from: from.to_owned(),
    };
    mail::check(&smtp)
        .await
        .map_err(|e| ApiError::bad(format!("{e:#}")))?;
    mail::save(&state.db, &smtp)?;
    two_factor(State(state)).await
}

/// Sends a test email to the admin.
async fn test_mail(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let smtp =
        mail::load(&state.db)?.ok_or_else(|| ApiError::bad("Enter your SMTP credentials first"))?;
    let to = state
        .db
        .setting("admin_email")?
        .ok_or_else(|| ApiError::bad("Set the admin email under Settings, Account first"))?;
    mail::send(
        &smtp,
        &to,
        "myTunnels test email",
        "Email from myTunnels works. Sign-in codes will arrive like this.",
    )
    .await
    .map_err(|e| ApiError::bad(format!("{e:#}")))?;
    Ok(Json(json!({ "ok": true, "to": to })))
}

#[derive(Deserialize)]
struct TwoFactorBody {
    dashboard: bool,
}

/// Turns codes for the dashboard on or off. Turning them on sends a test email
/// first, so credentials that do not deliver cannot lock the admin out.
async fn save_two_factor(
    State(state): State<AppState>,
    Json(body): Json<TwoFactorBody>,
) -> ApiResult<Json<Value>> {
    if body.dashboard {
        let _sent = test_mail(State(state.clone())).await?;
        state.db.set_setting("twofactor_dashboard", "1")?;
    } else {
        state.db.delete_setting("twofactor_dashboard")?;
    }
    two_factor(State(state)).await
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

async fn metrics() -> Json<Value> {
    Json(metrics::view())
}

// Containers

async fn list_containers() -> ApiResult<Json<Value>> {
    containers::list().await
}

async fn inspect_container(Path(id): Path<String>) -> ApiResult<Json<Value>> {
    containers::inspect(&id).await
}

async fn remove_container(Path(id): Path<String>) -> ApiResult<Json<Value>> {
    containers::remove(&id).await
}

async fn container_action(Path((id, action)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    containers::act(&id, &action).await
}

#[derive(Deserialize)]
struct LogQuery {
    #[serde(default = "default_tail")]
    tail: u32,
}

fn default_tail() -> u32 {
    500
}

async fn container_logs(
    Path(id): Path<String>,
    axum::extract::Query(q): axum::extract::Query<LogQuery>,
) -> ApiResult<Json<Value>> {
    containers::logs(&id, q.tail).await
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
    if !matches!(scheme, "http" | "https" | "storage" | "dashboard") {
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

/// Targets myTunnels serves itself, with no port: Storage and the dashboard.
fn served_here(scheme: &str) -> bool {
    matches!(scheme, "storage" | "dashboard")
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
    require_code: bool,
    #[serde(default)]
    oauth: Vec<String>,
    #[serde(default)]
    preserve_host: bool,
}

/// Provider IDs that exist, once each.
fn known_providers(ids: Vec<String>) -> Vec<String> {
    let mut known: Vec<String> = Vec::new();
    for id in ids {
        if oauth::spec(&id).is_some() && !known.contains(&id) {
            known.push(id);
        }
    }
    known
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
    // Storage is served by the gateway itself, at one address; the dashboard
    // by the gateway too, with no port.
    let storage = body.target_scheme == "storage";
    if body.port == 0 && !served_here(&body.target_scheme) {
        return Err(ApiError::bad("Port must be between 1 and 65535"));
    }
    if storage && storage::route(&state).is_some() {
        return Err(ApiError::conflict("File System already has an address"));
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
        require_code: body.require_code,
        oauth: known_providers(body.oauth),
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
    require_code: bool,
    #[serde(default)]
    oauth: Vec<String>,
    #[serde(default)]
    preserve_host: bool,
}

async fn update_route(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<RouteEdit>,
) -> ApiResult<Json<Route>> {
    let mut route = state.db.route(&id)?.ok_or_else(ApiError::not_found)?;
    // A tunnel stays an app or Storage; only where an app runs can change.
    if (route.target_scheme == "storage") != (body.target_scheme == "storage") {
        return Err(ApiError::bad(
            "File System and apps are published separately",
        ));
    }
    if body.port == 0 && !served_here(&body.target_scheme) {
        return Err(ApiError::bad("Port must be between 1 and 65535"));
    }
    route.target_host = check_target(body.target_host, &body.target_scheme, &body.policy_mode)?;
    check_not_self(&state, route.target_host.as_deref(), body.port)?;
    route.target_port = body.port;
    route.target_scheme = body.target_scheme;
    route.require_lan = body.require_lan;
    route.require_device = body.require_device;
    route.policy_mode = body.policy_mode;
    let switched = route.enabled != body.enabled;
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
    route.require_code = body.require_code;
    route.oauth = known_providers(body.oauth);
    route.preserve_host = body.preserve_host;
    state.db.update_route(&route)?;
    if switched && state.cloudflare().is_ok() {
        tunnel::sync_ingress(&state).await?;
    }
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

// Storage

async fn storage_overview(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    storage::overview(&state).await
}

async fn save_storage(
    State(state): State<AppState>,
    Json(body): Json<storage::Settings>,
) -> ApiResult<Json<Value>> {
    storage::save(&state, body).await
}

#[derive(Deserialize)]
struct BrowseQuery {
    #[serde(default)]
    path: String,
}

async fn browse_host(
    State(state): State<AppState>,
    axum::extract::Query(q): axum::extract::Query<BrowseQuery>,
) -> ApiResult<Json<Value>> {
    storage::browse(&state, &q.path).await
}

async fn add_rule(
    State(state): State<AppState>,
    Json(body): Json<storage::RuleBody>,
) -> ApiResult<Json<Value>> {
    storage::save_rule(&state, None, body).await
}

async fn edit_rule(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<storage::RuleBody>,
) -> ApiResult<Json<Value>> {
    storage::save_rule(&state, Some(id), body).await
}

async fn delete_rule(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    storage::delete_rule(&state, &id).await
}

async fn storage_fs(
    State(state): State<AppState>,
    Path(op): Path<String>,
    req: Request,
) -> Response {
    storage::fs(&state, storage::Who::Admin, &op, req).await
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
    state.end_sessions_of(&state.device_sessions, &id);
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
    Ok(Json(json!({
        "id": device.id,
        "token": token,
        "hosts": gate::planting_hosts(&state.snapshot()),
    })))
}

#[derive(Deserialize)]
struct PlantBody {
    token: String,
    /// The dashboard page to come back to.
    back: String,
}

/// Starts carrying this browser's dashboard key to one tunnel on each domain, so it
/// is the same device on the dashboard and on every tunnel.
async fn plant_device(
    State(state): State<AppState>,
    Json(body): Json<PlantBody>,
) -> ApiResult<Json<Value>> {
    if !(body.back.starts_with("http://") || body.back.starts_with("https://")) {
        return Err(ApiError::bad("Bad return address"));
    }
    if state
        .db
        .device_by_token(&crate::util::sha256_hex(&body.token))?
        .is_none()
    {
        return Err(ApiError::bad("Unknown device"));
    }
    let hosts = gate::planting_hosts(&state.snapshot());
    let Some(first) = hosts.first().cloned() else {
        return Err(ApiError::bad("No tunnel is live"));
    };
    let code = random_hex(16);
    state.put_hop(
        code.clone(),
        crate::state::Hop::Plant {
            token: body.token,
            hosts,
            back: body.back,
            expires: now() + 60,
        },
    );
    Ok(Json(
        json!({ "url": format!("https://{first}/__gate/plant?c={code}") }),
    ))
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
    password: String,
    /// The device the account signs in from; more can be linked later.
    device_id: String,
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
    let device_id = known_devices(&state, vec![body.device_id])
        .pop()
        .ok_or_else(|| ApiError::bad("Pick the device this account signs in from"))?;
    let user = User {
        id: random_hex(8),
        username,
        email,
        name: String::new(),
        password_hash: secret::hash(&body.password)?,
        enabled: true,
        all_routes: false,
        route_ids: Vec::new(),
        device_ids: vec![device_id],
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
    route_ids: Option<Vec<String>>,
    device_ids: Option<Vec<String>>,
}

/// Device IDs that exist, in the order given.
fn known_devices(state: &AppState, ids: Vec<String>) -> Vec<String> {
    let snap = state.snapshot();
    ids.into_iter()
        .filter(|id| snap.devices.contains_key(id))
        .collect()
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
    if let Some(ids) = body.route_ids {
        user.route_ids = known_routes(&state, ids);
    }
    if let Some(ids) = body.device_ids {
        user.device_ids = known_devices(&state, ids);
    }
    state.db.save_user(&user)?;
    state.reload()?;
    Ok(Json(user))
}

/// What happened at a tunnel lately: sign-ins, passwords, visitors turned away.
async fn route_activity(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<Event>>> {
    Ok(Json(state.db.events(&id, 300)?))
}

/// An account's latest sign-ins, and the devices it has used.
async fn user_activity(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<SignIn>>> {
    Ok(Json(state.db.sign_ins("user_id", &id, 100)?))
}

/// The accounts signed in from a device lately.
async fn device_activity(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<SignIn>>> {
    Ok(Json(state.db.sign_ins("device_id", &id, 100)?))
}

/// Ends every sign-in of this account.
async fn sign_out_user(State(state): State<AppState>, Path(id): Path<String>) -> Json<Value> {
    state.end_sessions_of(&state.user_sessions, &id);
    Json(json!({ "ok": true }))
}

async fn delete_user(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    state.db.delete_user(&id)?;
    state.end_sessions_of(&state.user_sessions, &id);
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
