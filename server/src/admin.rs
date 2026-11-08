//! The admin panel's API and static files.

use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use axum::extract::{ConnectInfo, Path, Request, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, delete, get, patch, post, put};
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use tower_http::services::{ServeDir, ServeFile};

use crate::cloudflare::{Account, Cloudflare, Zone};
use crate::db::{Device, Event, Route, SignIn, User, ADMIN, HOST, HOST_ID};
use crate::mail::{self, Smtp};
use crate::netinfo;
use crate::oauth::{self, Provider};
use crate::permissions::{self, Caller};
use crate::state::AppState;
use crate::util::{cookie, now, random_hex, valid_host, ApiError, ApiResult};
use crate::{
    addons, code, codes, containers, convert, gate, hardware, metrics, passkey, pow, secret, share,
    storage, threads, totp, tunnel,
};

const ADMIN_COOKIE: &str = "admin_session";
const ADMIN_TTL: i64 = 7 * 86_400;

pub fn router(state: AppState) -> Router {
    let protected = Router::new()
        .route("/account", get(account).patch(edit_account))
        .route(
            "/account/totp",
            post(start_totp).put(confirm_totp).delete(remove_totp),
        )
        .route("/account/passkeys", get(list_passkeys).post(add_passkey))
        .route("/account/passkeys/begin", post(begin_passkey))
        .route("/account/passkeys/{id}", delete(remove_passkey))
        .route("/shares", get(share::list).post(share::create))
        .route("/duplicates", get(crate::dupes::find))
        .route("/shares/{id}", delete(share::remove))
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
        .route("/images", get(crate::images::list))
        .route(
            "/images/{id}",
            get(crate::images::inspect).delete(crate::images::remove),
        )
        .route(
            "/containers/{id}",
            get(inspect_container).delete(remove_container),
        )
        .route("/containers/{id}/logs", get(container_logs))
        .route("/containers/{id}/{action}", post(container_action))
        .route(
            "/deploys",
            get(crate::deploy::list).post(crate::deploy::create),
        )
        .route("/deploys/probe", post(crate::deploy::probe))
        .route(
            "/deploys/{id}",
            get(crate::deploy::get)
                .patch(crate::deploy::edit)
                .delete(crate::deploy::remove),
        )
        .route("/deploys/{id}/build", post(crate::deploy::build_now))
        .route(
            "/deploys/{id}/builds/{number}",
            get(crate::deploy::build_log),
        )
        .route(
            "/deploys/{id}/builds/{number}/use",
            post(crate::deploy::use_build),
        )
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
        .route("/code", get(code_overview))
        .route("/code/repos", get(list_repos).post(create_repo))
        .route("/code/repos/{name}", delete(remove_repo).patch(edit_repo))
        .route("/code/repos/{name}/{op}", get(read_repo))
        .route("/code/repos/{name}/pin", put(pin_repo))
        .route("/code/repos/{name}/branch", post(branch_repo))
        .route("/code/repos/{name}/threads", post(open_thread))
        .route("/code/repos/{name}/threads/{kind}", get(list_threads))
        .route(
            "/code/repos/{name}/thread/{number}",
            get(get_thread).patch(edit_thread),
        )
        .route(
            "/code/repos/{name}/thread/{number}/comments",
            post(comment_thread),
        )
        .route(
            "/code/repos/{name}/thread/{number}/merge",
            post(merge_thread),
        )
        .route("/code/tokens", post(add_token))
        .route("/code/tokens/{id}", delete(remove_token))
        .route("/media/fs/{op}", any(media_fs))
        .route("/drive/fs/{op}", any(drive_fs))
        .route("/convert", get(convert::list).post(convert::start))
        .route("/convert/{id}", delete(convert::remove))
        .route("/addons/{id}", put(set_addon))
        .route("/hardware/fans", get(hardware::list_fans))
        .route("/hardware/fans/{id}", put(hardware::set_fan))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_session,
        ));
    let api = Router::new()
        .route("/auth", get(auth_state))
        .route("/auth/setup", post(setup))
        .route("/auth/login", post(login))
        .route("/auth/challenge", post(sign_in_challenge))
        .route("/auth/code", post(login_code))
        .route("/auth/logout", post(logout))
        .route("/auth/passkey/begin", post(begin_passkey_sign_in))
        .route("/auth/passkey", post(passkey_sign_in))
        .merge(protected)
        .layer(middleware::from_fn_with_state(state.clone(), guard_api));
    let ui = &state.config.ui_dir;
    let spa = ServeDir::new(ui).fallback(ServeFile::new(ui.join("index.html")));
    Router::new()
        .nest("/api", api)
        // Git on the LAN, signing in with a token as at the Code address.
        .route("/git/{*path}", any(lan_git))
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
    let https = req.extensions().get::<crate::tls::Https>().is_some();
    let mut response = next.run(req).await;
    let headers = response.headers_mut();
    // Over HTTPS, the session cookie is never sent over plain HTTP.
    if https {
        let cookies: Vec<HeaderValue> = headers
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|v| match v.to_str() {
                Ok(text) if !text.contains("; Secure") => {
                    HeaderValue::from_str(&format!("{text}; Secure")).unwrap_or_else(|_| v.clone())
                }
                _ => v.clone(),
            })
            .collect();
        headers.remove(header::SET_COOKIE);
        for value in cookies {
            headers.append(header::SET_COOKIE, value);
        }
    }
    for (name, value) in [
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        (header::X_FRAME_OPTIONS, "DENY"),
        (header::REFERRER_POLICY, "no-referrer"),
        (
            header::CONTENT_SECURITY_POLICY,
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
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

/// Who a panel session belongs to: the host, with its password as it is now,
/// or an account that is on, may sign in to the dashboard, and has the
/// password it signed in with.
fn caller(state: &AppState, headers: &HeaderMap) -> Option<Caller> {
    let session =
        cookie(headers, ADMIN_COOKIE).and_then(|v| state.session(&state.admin_sessions, v))?;
    if session.subject == HOST_ID {
        let host = state.db.host().ok().flatten()?;
        return (secret::tag(&host.password_hash) == session.tag).then_some(Caller::Host);
    }
    let user = state.snapshot().users.get(&session.subject).cloned()?;
    let may =
        user.enabled && user.holds("dashboard") && secret::tag(&user.password_hash) == session.tag;
    may.then_some(Caller::Account(Box::new(user)))
}

/// Lets a call through for someone signed in whose permissions allow it.
async fn require_session(State(state): State<AppState>, mut req: Request, next: Next) -> Response {
    let Some(caller) = caller(&state, req.headers()) else {
        return ApiError(StatusCode::UNAUTHORIZED, "Sign in required".into()).into_response();
    };
    if !permissions::needed(req.method(), req.uri().path()).met(&caller) {
        return ApiError(
            StatusCode::FORBIDDEN,
            "You don't have permission for this".into(),
        )
        .into_response();
    }
    // A removed add-on's calls are refused.
    let segment = req.uri().path().trim_start_matches('/').split('/').next();
    let removed = segment.and_then(|s| {
        addons::installed(&state.db)
            .ok()
            .and_then(|list| addons::missing(&list, s))
    });
    if let Some(name) = removed {
        return ApiError(StatusCode::NOT_FOUND, format!("{name} is not installed")).into_response();
    }
    req.extensions_mut().insert(caller);
    next.run(req).await
}

#[derive(Deserialize)]
struct AddonBody {
    installed: bool,
}

/// Installs or removes an add-on, for the host and admins.
async fn set_addon(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<AddonBody>,
) -> ApiResult<Json<Value>> {
    if !addons::known(&id) {
        return Err(ApiError::not_found());
    }
    Ok(Json(
        json!({ "addons": addons::set(&state.db, &id, body.installed)? }),
    ))
}

/// What first-run setup has saved so far, so the panel can resume where it was left.
/// Setup is done once there is an admin account and Cloudflare is connected.
async fn auth_state(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let db = &state.db;
    let host = db.host()?;
    let password = host.is_some();
    let me = caller(&state, &headers).map(|c| {
        let name = match &c {
            Caller::Host => host
                .as_ref()
                .map(|h| {
                    if h.name.is_empty() {
                        h.username.clone()
                    } else {
                        h.name.clone()
                    }
                })
                .unwrap_or_default(),
            Caller::Account(u) if u.name.is_empty() => u.username.clone(),
            Caller::Account(u) => u.name.clone(),
        };
        json!({
            "id": c.id(),
            "host": matches!(c, Caller::Host),
            "admin": c.is_admin(),
            "name": name,
            "permissions": c.permissions(),
        })
    });
    Ok(Json(json!({
        "setup_required": !password,
        "authenticated": me.is_some(),
        "me": me,
        "catalog": permissions::GROUPS,
        "addons": addons::installed(db)?,
        "setup": {
            "password": password,
            "account": password,
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

/// Creates the host's account: an email, a username and a password. It is an
/// account like any other under Users, with the Host and Admin roles.
async fn setup(
    State(state): State<AppState>,
    Json(body): Json<AccountBody>,
) -> ApiResult<Response> {
    if state.db.host()?.is_some() {
        return Err(ApiError::conflict("The host account already exists"));
    }
    let username = admin_username(&body.username)?;
    let email = clean_email(&body.email)?;
    if !secret::strong(&body.password) {
        return Err(ApiError::bad(secret::RULE));
    }
    check_unique(&state, HOST_ID, &username, &email)?;
    state.db.save_user(&User {
        id: HOST_ID.into(),
        username,
        email,
        name: String::new(),
        password_hash: secret::hash(&body.password)?,
        enabled: true,
        all_routes: false,
        route_ids: Vec::new(),
        device_ids: Vec::new(),
        created_at: now(),
        last_login: None,
        note: None,
        permissions: vec![HOST.into(), ADMIN.into()],
        storage_limit: 0,
    })?;
    state.reload()?;
    start_admin_session(&state)
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
    pow: Option<pow::Proof>,
}

/// The work a browser does before a sign-in, harder after wrong tries from it.
async fn sign_in_challenge(
    State(state): State<AppState>,
    Extension(Peer(ip)): Extension<Peer>,
) -> Json<Value> {
    Json(pow::issue(state.failure_count(&format!("admin:{ip}"))))
}

/// True when `login` is the host account's username or email.
fn names_host(host: &User, login: &str) -> bool {
    let login = login.trim();
    !login.is_empty()
        && (host.username.eq_ignore_ascii_case(login)
            || (!host.email.is_empty() && host.email.eq_ignore_ascii_case(login)))
}

async fn login(
    State(state): State<AppState>,
    Extension(Peer(ip)): Extension<Peer>,
    Json(body): Json<LoginBody>,
) -> ApiResult<Response> {
    let Some(host) = state.db.host()? else {
        return Err(ApiError::bad("Create the host account first"));
    };
    let key = format!("admin:{ip}");
    if state.locked_out(&key) {
        return Err(ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many wrong tries. Wait 15 minutes and try again.".into(),
        ));
    }
    if !pow::check(body.pow.as_ref()) {
        return Err(ApiError::bad(
            "This page is out of date. Reload it and try again.",
        ));
    }
    // The password is checked either way, so a wrong name takes as long to refuse.
    let password_ok = secret::verify(&body.password, &host.password_hash);
    if !(password_ok && names_host(&host, &body.login)) {
        // Any other account that may sign in to the dashboard, by its email or
        // username.
        if let Some(user) = dashboard_account(&state, &body.login, &body.password)? {
            state.clear_failures(&key);
            if totp::enrolled(&state.db, &user.id) {
                return Ok(app_code(state.codes.hold(&user.id, DASHBOARD, "")));
            }
            if !dashboard_codes(&state)? {
                return start_session(&state, &user.id, &secret::tag(&user.password_hash));
            }
            let (ticket, sent_to) = codes::send(
                &state,
                &user.id,
                &user.email,
                DASHBOARD,
                "",
                "the myTunnels dashboard",
            )
            .await?;
            return Ok(Json(
                json!({ "code_required": true, "ticket": ticket, "sent_to": sent_to }),
            )
            .into_response());
        }
        state.record_failure(&key);
        tokio::time::sleep(Duration::from_millis(800)).await;
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "Those details are not right".into(),
        ));
    }
    state.clear_failures(&key);
    if totp::enrolled(&state.db, "admin") {
        return Ok(app_code(state.codes.hold("admin", "", "")));
    }
    if !dashboard_codes(&state)? {
        return start_admin_session(&state);
    }
    let (ticket, sent_to) = codes::send(
        &state,
        HOST_ID,
        &host.email,
        "",
        "",
        "the myTunnels dashboard",
    )
    .await?;
    Ok(
        Json(json!({ "code_required": true, "ticket": ticket, "sent_to": sent_to }))
            .into_response(),
    )
}

/// Marks an emailed code as one for an account signing in to the dashboard.
const DASHBOARD: &str = "dashboard";

/// Asks for a code from the authenticator app to finish signing in.
fn app_code(ticket: String) -> Response {
    Json(json!({ "code_required": true, "ticket": ticket, "sent_to": "", "app": true }))
        .into_response()
}

/// The account `login` names, if it is on, may sign in to the dashboard and
/// `password` is its own.
fn dashboard_account(state: &AppState, login: &str, password: &str) -> ApiResult<Option<User>> {
    let login = login.trim();
    if login.is_empty() {
        return Ok(None);
    }
    // The host signs in as the host, above.
    let found = state
        .db
        .users()?
        .into_iter()
        .filter(|u| u.id != HOST_ID)
        .find(|u| {
            u.username.eq_ignore_ascii_case(login)
                || (!u.email.is_empty() && u.email.eq_ignore_ascii_case(login))
        });
    Ok(found.filter(|u| {
        u.enabled && u.holds("dashboard") && secret::verify(password, &u.password_hash)
    }))
}

/// Whether every sign-in also asks for an emailed code.
fn dashboard_codes(state: &AppState) -> ApiResult<bool> {
    Ok(codes::on(state))
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
    let app = |subject: &str, code: &str| totp::verify(&state.db, subject, code);
    match state.codes.redeem(&body.ticket, &body.code, app) {
        Ok(p) if p.subject == "admin" && p.route_id.is_empty() => start_admin_session(&state),
        Ok(p) if p.route_id == DASHBOARD => match state.db.user(&p.subject)? {
            Some(u) if u.enabled && u.holds("dashboard") => {
                start_session(&state, &u.id, &secret::tag(&u.password_hash))
            }
            _ => Err(ApiError(StatusCode::UNAUTHORIZED, "Sign in again".into())),
        },
        Ok(_) => Err(ApiError(StatusCode::UNAUTHORIZED, "Sign in again".into())),
        Err(why) => Err(ApiError(StatusCode::UNAUTHORIZED, why.into())),
    }
}

fn start_admin_session(state: &AppState) -> ApiResult<Response> {
    let host = state
        .db
        .host()?
        .ok_or_else(|| ApiError::bad("Create the host account first"))?;
    start_session(state, HOST_ID, &secret::tag(&host.password_hash))
}

/// Opens a panel session for `subject`, the admin or an account, tied to the
/// password it signed in with.
fn start_session(state: &AppState, subject: &str, tag: &str) -> ApiResult<Response> {
    if let Some(mut user) = state.db.user(subject)? {
        user.last_login = Some(now());
        state.db.save_user(&user)?;
        state.reload()?;
    }
    let sid = state.open_session(&state.admin_sessions, subject, tag, "", ADMIN_TTL, false);
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

/// The account signed in: the admin's, or another account's own details.
async fn account(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
) -> ApiResult<Json<Value>> {
    Ok(Json(match caller {
        Caller::Host => {
            let host = state.db.host()?.ok_or_else(ApiError::not_found)?;
            json!({
                "username": host.username,
                "email": host.email,
                "host": true,
                "totp": totp::enrolled(&state.db, HOST_ID),
            })
        }
        Caller::Account(u) => json!({
            "username": u.username,
            "email": u.email,
            "host": false,
            "totp": totp::enrolled(&state.db, &u.id),
        }),
    }))
}

/// The site passkeys on this page belong to, and the page's origin: the tunnel
/// domain the panel was opened under, or the name it was opened by on the LAN.
fn panel_site(state: &AppState, headers: &HeaderMap, https: bool) -> ApiResult<(String, String)> {
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let name = match host.strip_prefix('[') {
        Some(rest) => rest.split(']').next().unwrap_or_default().to_owned(),
        None => host.split(':').next().unwrap_or_default().to_owned(),
    };
    if name.is_empty() || name.parse::<IpAddr>().is_ok() {
        return Err(ApiError::bad(
            "Open the panel by its name, not an IP address, to use passkeys",
        ));
    }
    if !https && name != "localhost" {
        return Err(ApiError::bad("Passkeys need the panel over HTTPS"));
    }
    let snap = state.snapshot();
    let zone = snap
        .routes
        .values()
        .map(|r| r.zone_name.clone())
        .find(|z| name == *z || name.ends_with(&format!(".{z}")));
    let origin = format!("{}://{host}", if https { "https" } else { "http" });
    Ok((zone.unwrap_or(name), origin))
}

/// What a passkey or an authenticator app calls the account: its email, or
/// its username.
fn caller_label(state: &AppState, caller: &Caller) -> ApiResult<String> {
    let user = match caller {
        Caller::Host => state.db.host()?.ok_or_else(ApiError::not_found)?,
        Caller::Account(u) => (**u).clone(),
    };
    Ok(if user.email.is_empty() {
        user.username
    } else {
        user.email
    })
}

async fn list_passkeys(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
) -> ApiResult<Json<Vec<crate::db::Passkey>>> {
    Ok(Json(state.db.passkeys_of(caller.id())?))
}

/// Starts adding a passkey for the account signed in.
async fn begin_passkey(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    https: Option<Extension<crate::tls::Https>>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    let (rp_id, origin) = panel_site(&state, &headers, https.is_some())?;
    let existing = state.db.passkeys_of(caller.id())?;
    Ok(Json(passkey::begin_register(
        caller.id(),
        &caller_label(&state, &caller)?,
        &rp_id,
        &origin,
        &existing,
    )))
}

#[derive(Deserialize)]
struct PasskeyBody {
    credential: passkey::Created,
    #[serde(default)]
    name: String,
}

/// Keeps a passkey made for the account signed in.
async fn add_passkey(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Json(body): Json<PasskeyBody>,
) -> ApiResult<Json<Vec<crate::db::Passkey>>> {
    passkey::finish_register(&state.db, &body.credential, &body.name, caller.id())
        .map_err(ApiError::bad)?;
    Ok(Json(state.db.passkeys_of(caller.id())?))
}

async fn remove_passkey(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<crate::db::Passkey>>> {
    if !state.db.delete_passkey(caller.id(), &id)? {
        return Err(ApiError::not_found());
    }
    Ok(Json(state.db.passkeys_of(caller.id())?))
}

/// Starts a passkey sign-in to the dashboard.
async fn begin_passkey_sign_in(
    State(state): State<AppState>,
    https: Option<Extension<crate::tls::Https>>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    let (rp_id, origin) = panel_site(&state, &headers, https.is_some())?;
    Ok(Json(passkey::begin_sign_in(&rp_id, &origin)))
}

#[derive(Deserialize)]
struct PasskeySignIn {
    credential: passkey::Asserted,
}

/// Signs in to the dashboard with a passkey. The device checked who is holding
/// it, so no emailed or app code follows.
async fn passkey_sign_in(
    State(state): State<AppState>,
    Json(body): Json<PasskeySignIn>,
) -> ApiResult<Response> {
    let subject = passkey::finish_sign_in(&state.db, &body.credential)
        .map_err(|why| ApiError(StatusCode::UNAUTHORIZED, why.into()))?;
    if subject == "admin" {
        return start_admin_session(&state);
    }
    match state.db.user(&subject)? {
        Some(u) if u.enabled && u.holds("dashboard") => {
            start_session(&state, &u.id, &secret::tag(&u.password_hash))
        }
        _ => Err(ApiError(
            StatusCode::FORBIDDEN,
            "This passkey's account cannot sign in to the dashboard".into(),
        )),
    }
}

/// Starts setting up an authenticator app for the account signed in: its secret,
/// the link to it, and that link as a QR code to scan.
async fn start_totp(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
) -> ApiResult<Json<Value>> {
    let label = caller_label(&state, &caller)?;
    let secret = totp::start(&state.db, caller.id())?;
    let uri = totp::uri(&secret, &label);
    let qr = qrcode::QrCode::new(uri.as_bytes())
        .map_err(|e| ApiError::from(anyhow::anyhow!("cannot draw the QR code: {e}")))?
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(200, 200)
        .quiet_zone(true)
        .build();
    Ok(Json(json!({ "secret": secret, "uri": uri, "qr": qr })))
}

#[derive(Deserialize)]
struct TotpCode {
    code: String,
}

/// Finishes setting up the app with a code from it; answers with the recovery
/// codes, shown this once.
async fn confirm_totp(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Json(body): Json<TotpCode>,
) -> ApiResult<Json<Value>> {
    match totp::confirm(&state.db, caller.id(), &body.code)? {
        Some(codes) => Ok(Json(json!({ "recovery": codes }))),
        None => Err(ApiError::bad(
            "That code is not right. Check the time on this device and try the next one.",
        )),
    }
}

/// Turns the app off, given a code from it or a recovery code.
async fn remove_totp(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Json(body): Json<TotpCode>,
) -> ApiResult<Json<Value>> {
    if !totp::verify(&state.db, caller.id(), &body.code) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "That code is not right.".into(),
        ));
    }
    totp::remove(&state.db, caller.id())?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct AccountEdit {
    username: Option<String>,
    email: Option<String>,
}

async fn edit_account(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Json(body): Json<AccountEdit>,
) -> ApiResult<Json<Value>> {
    if !matches!(caller, Caller::Host) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Only the host changes the host account".into(),
        ));
    }
    let mut host = state.db.host()?.ok_or_else(ApiError::not_found)?;
    if let Some(username) = body.username {
        host.username = admin_username(&username)?;
    }
    if let Some(email) = body.email {
        host.email = clean_email(&email)?;
    }
    check_unique(&state, HOST_ID, &host.username, &host.email)?;
    state.db.save_user(&host)?;
    state.reload()?;
    account(State(state), Extension(caller)).await
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
        "enabled": dashboard_codes(&state)?,
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
    enabled: bool,
}

/// Turns emailed codes on or off for every sign-in, the dashboard and each
/// tunnel with sign-in alike. Turning them on sends a test email first, so
/// credentials that do not deliver cannot lock the admin out.
async fn save_two_factor(
    State(state): State<AppState>,
    Json(body): Json<TwoFactorBody>,
) -> ApiResult<Json<Value>> {
    if body.enabled {
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
        "version": view.version,
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
    if !matches!(scheme, "http" | "https" | "code" | "dashboard") {
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

/// Targets myTunnels serves itself, with no port: Code and the dashboard.
fn served_here(scheme: &str) -> bool {
    matches!(scheme, "code" | "dashboard")
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
    #[serde(default)]
    verify_tls: bool,
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
    // Code is served by the gateway itself, at one address; the dashboard by
    // the gateway too, with no port.
    if body.port == 0 && !served_here(&body.target_scheme) {
        return Err(ApiError::bad("Port must be between 1 and 65535"));
    }
    if body.target_scheme == "code" && code::route(&state).is_some() {
        return Err(ApiError::conflict("Git already has an address"));
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
        verify_tls: body.verify_tls,
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
    #[serde(default)]
    verify_tls: bool,
}

async fn update_route(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<RouteEdit>,
) -> ApiResult<Json<Route>> {
    let mut route = state.db.route(&id)?.ok_or_else(ApiError::not_found)?;
    // A tunnel stays an app or Code; only where an app runs can change.
    if (route.target_scheme == "code") != (body.target_scheme == "code") {
        return Err(ApiError::bad("Git and apps are published separately"));
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
    route.verify_tls = body.verify_tls;
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
    move_address(&state, &id, &body.subdomain, &body.zone_id)
        .await
        .map(Json)
}

/// Code's address is `git.<domain>`: one that started as File System's
/// `storage.` or as `code.` moves there once, unless it is taken. Cloudflare
/// must answer first, so it is tried a few times while the server starts.
pub async fn rename_code_address(state: AppState) {
    const DONE: &str = "code_address_git";
    for _ in 0..10 {
        if state.db.setting(DONE).ok().flatten().is_some() {
            return;
        }
        let Some(route) =
            code::route(&state).filter(|r| r.subdomain == "storage" || r.subdomain == "code")
        else {
            let _ = state.db.set_setting(DONE, "1");
            return;
        };
        match move_address(&state, &route.id, "git", &route.zone_id).await {
            Ok(_) => {
                let _ = state.db.set_setting(DONE, "1");
                return;
            }
            Err(ApiError(StatusCode::CONFLICT, why)) => {
                tracing::info!("Git keeps {}: {why}", route.hostname);
                let _ = state.db.set_setting(DONE, "1");
                return;
            }
            Err(ApiError(_, why)) => tracing::warn!("cannot move Code's address yet: {why}"),
        }
        tokio::time::sleep(Duration::from_secs(30)).await;
    }
}

/// Moves a tunnel to another subdomain or domain, as `move_route` does.
async fn move_address(
    state: &AppState,
    id: &str,
    subdomain: &str,
    zone_id: &str,
) -> ApiResult<Route> {
    let body = AddressEdit {
        subdomain: subdomain.to_owned(),
        zone_id: zone_id.to_owned(),
    };
    let cf_settings = state.cloudflare()?;
    let mut route = state.db.route(id)?.ok_or_else(ApiError::not_found)?;
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
        return Ok(route);
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
    if let Err(err) = tunnel::sync_ingress(state).await {
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
    Ok(route)
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

// Code

async fn code_overview(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
) -> ApiResult<Json<Value>> {
    code::overview(&state, &caller).await
}

async fn list_repos(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
) -> ApiResult<Json<Value>> {
    code::list(&state, &code::Viewer::of(&caller)).await
}

async fn create_repo(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Json(body): Json<code::NewRepo>,
) -> ApiResult<Json<Value>> {
    code::create(&state, &code::Viewer::of(&caller), body).await
}

async fn remove_repo(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path(name): Path<String>,
) -> ApiResult<Json<Value>> {
    code::remove(&state, &code::Viewer::of(&caller), &name).await
}

async fn edit_repo(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path(name): Path<String>,
    Json(body): Json<code::RepoEdit>,
) -> ApiResult<Json<Value>> {
    code::edit(&state, &code::Viewer::of(&caller), &name, body).await
}

#[derive(Deserialize)]
struct PinBody {
    pinned: bool,
}

async fn pin_repo(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path(name): Path<String>,
    Json(body): Json<PinBody>,
) -> ApiResult<Json<Value>> {
    code::pin(&state, &code::Viewer::of(&caller), &name, body.pinned).await
}

async fn branch_repo(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path(name): Path<String>,
    Json(body): Json<code::BranchAction>,
) -> ApiResult<Response> {
    code::branch(&state, &code::Viewer::of(&caller), &name, body).await
}

async fn list_threads(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path((name, kind)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    threads::list(&state, &code::Viewer::of(&caller), &name, &kind).await
}

async fn open_thread(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path(name): Path<String>,
    Json(body): Json<threads::NewThread>,
) -> ApiResult<Json<Value>> {
    threads::open(&state, &caller, &name, body).await
}

async fn get_thread(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path((name, number)): Path<(String, i64)>,
) -> ApiResult<Json<Value>> {
    threads::get(&state, &code::Viewer::of(&caller), &name, number).await
}

async fn edit_thread(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path((name, number)): Path<(String, i64)>,
    Json(body): Json<threads::ThreadEdit>,
) -> ApiResult<Json<Value>> {
    threads::edit(&state, &caller, &name, number, body).await
}

async fn comment_thread(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path((name, number)): Path<(String, i64)>,
    Json(body): Json<threads::NewComment>,
) -> ApiResult<Json<Value>> {
    threads::comment(&state, &caller, &name, number, body).await
}

async fn merge_thread(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path((name, number)): Path<(String, i64)>,
) -> ApiResult<Json<Value>> {
    threads::merge(&state, &caller, &name, number).await
}

async fn read_repo(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path((name, op)): Path<(String, String)>,
    req: Request,
) -> Response {
    code::read(&state, &code::Viewer::of(&caller), &name, &op, req).await
}

async fn add_token(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Json(body): Json<code::NewToken>,
) -> ApiResult<Json<Value>> {
    code::add_token(&state, &caller, body).await
}

async fn remove_token(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    code::delete_token(&state, &caller, &id).await
}

async fn lan_git(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(path): Path<String>,
    req: Request,
) -> Response {
    if !code::is_git(&req) {
        return StatusCode::NOT_FOUND.into_response();
    }
    code::serve(&state, Some(peer.ip()), &format!("/{path}"), req).await
}

async fn media_fs(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path(op): Path<String>,
    req: Request,
) -> Response {
    storage::fs(&state, storage::Space::Media, caller.id(), &op, req).await
}

async fn drive_fs(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path(op): Path<String>,
    req: Request,
) -> Response {
    storage::fs(&state, storage::Space::Drive, caller.id(), &op, req).await
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

/// Starts carrying this browser's dashboard key to every tunnel, so it
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
        permissions: Vec::new(),
        storage_limit: 0,
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
    permissions: Option<Vec<String>>,
    /// In bytes; 0 for no limit.
    storage_limit: Option<u64>,
}

/// Whether `caller` may change `target`: the admin always; anyone else only an
/// account that can do no more than they can, and never their own powers.
fn may_manage(caller: &Caller, target: &User) -> ApiResult<()> {
    if target.id == HOST_ID && !matches!(caller, Caller::Host) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Only the host changes the host account".into(),
        ));
    }
    if target.permissions.iter().all(|p| caller.can(p)) {
        Ok(())
    } else {
        Err(ApiError(
            StatusCode::FORBIDDEN,
            "That account can do things you cannot, so only someone who can may change it".into(),
        ))
    }
}

/// The permissions to give `user`, checked: known ones, once each, and none
/// that `caller` does not hold itself.
fn new_permissions(caller: &Caller, user: &User, given: Vec<String>) -> ApiResult<Vec<String>> {
    if caller.id() == user.id {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "You cannot change your own permissions".into(),
        ));
    }
    let mut kept: Vec<String> = Vec::new();
    for key in given {
        if !permissions::known(&key) {
            return Err(ApiError::bad(format!("No such permission: {key}")));
        }
        if !kept.contains(&key) {
            kept.push(key);
        }
    }
    let changed = kept
        .iter()
        .filter(|k| !user.permissions.contains(k))
        .chain(user.permissions.iter().filter(|k| !kept.contains(k)));
    for key in changed {
        if !caller.can(key) {
            return Err(ApiError(
                StatusCode::FORBIDDEN,
                format!("You can give and take only permissions you hold yourself, not {key}"),
            ));
        }
    }
    Ok(kept)
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
    Extension(caller): Extension<Caller>,
    Path(id): Path<String>,
    Json(body): Json<UserEdit>,
) -> ApiResult<Json<User>> {
    let mut user = state.db.user(&id)?.ok_or_else(ApiError::not_found)?;
    may_manage(&caller, &user)?;
    if let Some(given) = body.permissions {
        user.permissions = new_permissions(&caller, &user, given)?;
    }
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
    if body.enabled == Some(false) && user.id == HOST_ID {
        return Err(ApiError::bad("The host account cannot be suspended"));
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
    if let Some(limit) = body.storage_limit {
        if user.id == HOST_ID {
            return Err(ApiError::bad("The host's storage has no limit"));
        }
        if caller.id() == user.id {
            return Err(ApiError(
                StatusCode::FORBIDDEN,
                "Someone else sets your storage limit".into(),
            ));
        }
        user.storage_limit = limit;
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

/// Ends every sign-in of this account, at tunnels and on the dashboard.
async fn sign_out_user(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let user = state.db.user(&id)?.ok_or_else(ApiError::not_found)?;
    may_manage(&caller, &user)?;
    state.end_sessions_of(&state.user_sessions, &id);
    state.end_sessions_of(&state.admin_sessions, &id);
    Ok(Json(json!({ "ok": true })))
}

async fn delete_user(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let user = state.db.user(&id)?.ok_or_else(ApiError::not_found)?;
    may_manage(&caller, &user)?;
    if caller.id() == id {
        return Err(ApiError::bad("You cannot remove your own account"));
    }
    state.db.delete_user(&id)?;
    state.db.delete_passkeys_of(&id)?;
    state.end_sessions_of(&state.user_sessions, &id);
    state.end_sessions_of(&state.admin_sessions, &id);
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
