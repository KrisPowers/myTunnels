//! Locations: folders on this computer, a whole drive or any folder on one,
//! kept as network storage, as a NAS keeps shares. Each is browsed and changed
//! on Storage, and opens in File Explorer, Finder and any other WebDAV client
//! at `/dav/<name>` on the dashboard's address, signed in with a myTunnels
//! account that may use Storage: reading with Storage's view permission,
//! changing with its edit permission.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{ConnectInfo, Path as UrlPath, Request, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::Engine;
use dav_server::localfs::LocalFs;
use dav_server::memls::MemLs;
use dav_server::{DavConfig, DavHandler, DavMethodSet};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::db::User;
use crate::state::AppState;
use crate::util::{lock, random_hex, sha256_hex, ApiError, ApiResult};

#[derive(Clone, Serialize, Deserialize)]
pub struct Location {
    pub id: String,
    /// Its name in its address, `/dav/<name>`.
    pub name: String,
    /// The folder on this computer.
    pub path: String,
}

const KEY: &str = "storage_locations";

pub fn all(state: &AppState) -> Vec<Location> {
    state
        .db
        .setting(KEY)
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_default()
}

pub fn find(state: &AppState, id: &str) -> Option<Location> {
    all(state).into_iter().find(|l| l.id == id)
}

fn save(state: &AppState, list: &[Location]) -> ApiResult<()> {
    let text = serde_json::to_string(list).map_err(|e| ApiError::bad(e.to_string()))?;
    state.db.set_setting(KEY, &text)?;
    Ok(())
}

/// A location's name, as its address takes it: lowercase letters, digits,
/// `-` and `_`.
fn valid_name(name: &str) -> bool {
    (1..=40).contains(&name.len())
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"-_".contains(&b))
}

/// Where other computers reach the locations: this dashboard's address through
/// a tunnel, when it has one.
fn address(state: &AppState) -> Option<String> {
    state
        .snapshot()
        .routes
        .values()
        .filter(|r| r.enabled && r.target_scheme == "dashboard")
        .map(|r| r.hostname.clone())
        .min()
}

// ---- the API ----

pub async fn list(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let host = address(&state);
    let locations: Vec<Value> = all(&state)
        .into_iter()
        .map(|l| {
            let path = Path::new(&l.path);
            let space = path
                .is_dir()
                .then(|| crate::storage::disk(path))
                .flatten()
                .map(|(free, total)| json!({ "free": free, "total": total }));
            let url = host.as_ref().map(|h| format!("https://{h}/dav/{}", l.name));
            json!({ "id": l.id, "name": l.name, "path": l.path, "here": path.is_dir(), "space": space, "url": url })
        })
        .collect();
    Ok(Json(json!({ "locations": locations, "address": host })))
}

#[derive(Deserialize)]
pub struct NewLocation {
    name: String,
    path: String,
}

pub async fn add(
    State(state): State<AppState>,
    Json(body): Json<NewLocation>,
) -> ApiResult<Json<Value>> {
    let name = body.name.trim().to_owned();
    if !valid_name(&name) {
        return Err(ApiError::bad(
            "Name: lowercase letters, digits, '-' and '_', starting with a letter or digit",
        ));
    }
    let path = body.path.trim().to_owned();
    // A drive's root keeps its slash; any other folder loses a trailing one.
    let path = if path.len() > 3 {
        path.trim_end_matches(['/', '\\']).to_owned()
    } else {
        path
    };
    let dir = PathBuf::from(&path);
    if !dir.is_absolute() || !dir.is_dir() {
        return Err(ApiError::bad(format!(
            "{path} is not a folder on this computer"
        )));
    }
    let mut list = all(&state);
    if list.iter().any(|l| l.name == name) {
        return Err(ApiError::conflict(format!(
            "There is already a location called {name}"
        )));
    }
    list.push(Location {
        id: random_hex(8),
        name,
        path,
    });
    save(&state, &list)?;
    list_value(&state).await
}

pub async fn remove(
    State(state): State<AppState>,
    UrlPath(id): UrlPath<String>,
) -> ApiResult<Json<Value>> {
    let mut list = all(&state);
    let before = list.len();
    list.retain(|l| l.id != id);
    if list.len() == before {
        return Err(ApiError::not_found());
    }
    save(&state, &list)?;
    // Only myTunnels' previews go; the folder and its files stay as they are.
    let _ = std::fs::remove_dir_all(state.config.data_dir.join("thumbs").join(&id));
    lock(&HANDLERS).retain(|key, _| !key.starts_with(&format!("{id}:")));
    list_value(&state).await
}

async fn list_value(state: &AppState) -> ApiResult<Json<Value>> {
    list(State(state.clone())).await
}

/// The drives and usual places a location can be made from, with their room.
pub async fn drives() -> ApiResult<Json<Value>> {
    let mut found: Vec<PathBuf> = Vec::new();
    if cfg!(windows) {
        for letter in b'A'..=b'Z' {
            let root = PathBuf::from(format!("{}:\\", letter as char));
            if root.is_dir() {
                found.push(root);
            }
        }
    } else {
        found.push(PathBuf::from("/"));
        if let Some(home) = std::env::var_os("HOME") {
            found.push(PathBuf::from(home));
        }
        // Drives mounted where Linux and macOS put them; /media and
        // /run/media keep a folder per account, with the drives inside.
        let folders = |dir: &Path| -> Vec<PathBuf> {
            std::fs::read_dir(dir)
                .map(|r| {
                    r.flatten()
                        .map(|e| e.path())
                        .filter(|p| p.is_dir())
                        .collect()
                })
                .unwrap_or_default()
        };
        for parent in ["/mnt", "/Volumes"] {
            found.extend(folders(Path::new(parent)));
        }
        for parent in ["/media", "/run/media"] {
            for account in folders(Path::new(parent)) {
                found.extend(folders(&account));
            }
        }
    }
    let list: Vec<Value> = found
        .into_iter()
        .map(|p| {
            let space = crate::storage::disk(&p)
                .map(|(free, total)| json!({ "free": free, "total": total }));
            json!({ "path": p.display().to_string(), "space": space })
        })
        .collect();
    Ok(Json(json!(list)))
}

// ---- WebDAV ----

/// One handler per location, kept so its locks last from one request to the next.
static HANDLERS: LazyLock<Mutex<HashMap<String, DavHandler>>> = LazyLock::new(Mutex::default);

/// Accounts signed in lately, by the hash of what they sent, so the password
/// is not checked again on each of the many requests a file explorer makes.
static SIGNED: LazyLock<Mutex<HashMap<String, (Instant, String)>>> = LazyLock::new(Mutex::default);
const SIGNED_FOR: Duration = Duration::from_secs(300);

/// Wrong sign-ins an address may make in a minute.
const TRIES_PER_MINUTE: u32 = 10;

fn handler(l: &Location) -> DavHandler {
    let key = format!("{}:{}", l.id, l.path);
    lock(&HANDLERS)
        .entry(key)
        .or_insert_with(|| {
            DavHandler::builder()
                .filesystem(LocalFs::new(
                    &l.path,
                    false,
                    cfg!(windows),
                    cfg!(target_os = "macos"),
                ))
                .locksystem(MemLs::new())
                .strip_prefix(format!("/dav/{}", l.name))
                .build_handler()
        })
        .clone()
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [(
            header::WWW_AUTHENTICATE,
            "Basic realm=\"myTunnels\", charset=\"UTF-8\"",
        )],
        "Sign in with your myTunnels account",
    )
        .into_response()
}

/// The account a request signs in as, by HTTP Basic: its username or email
/// and its password. None for no sign-in or a wrong one; an error once the
/// address has tried too often.
fn signed_in(state: &AppState, headers: &HeaderMap, ip: IpAddr) -> Result<Option<User>, ()> {
    let Some(given) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Basic "))
    else {
        return Ok(None);
    };
    let users = state.snapshot().users.clone();
    let key = sha256_hex(given);
    if let Some((_, id)) = lock(&SIGNED)
        .get(&key)
        .filter(|(at, _)| at.elapsed() < SIGNED_FOR)
    {
        return Ok(users.get(id).filter(|u| u.enabled).cloned());
    }
    let tried = format!("dav-auth:{ip}");
    if !state.allow(&tried, TRIES_PER_MINUTE, 60) {
        return Err(());
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(given.trim())
        .ok()
        .and_then(|b| String::from_utf8(b).ok());
    let Some((login, password)) = decoded.as_deref().and_then(|d| d.split_once(':')) else {
        return Ok(None);
    };
    let login = login.trim();
    let found = users.values().find(|u| {
        u.enabled
            && !login.is_empty()
            && (u.username.eq_ignore_ascii_case(login)
                || (!u.email.is_empty() && u.email.eq_ignore_ascii_case(login)))
    });
    let user = found
        .filter(|u| crate::secret::verify(password, &u.password_hash))
        .cloned();
    if let Some(u) = &user {
        let mut signed = lock(&SIGNED);
        signed.retain(|_, (at, _)| at.elapsed() < SIGNED_FOR);
        signed.insert(key, (Instant::now(), u.id.clone()));
    }
    Ok(user)
}

/// A location over WebDAV, at `/dav/<name>`, for an account that may use Storage.
pub async fn dav(State(state): State<AppState>, req: Request) -> Response {
    let ip = req
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map_or(IpAddr::from([0, 0, 0, 0]), |c| c.0.ip());
    let name = req
        .uri()
        .path()
        .strip_prefix("/dav/")
        .and_then(|rest| rest.split('/').next())
        .unwrap_or("")
        .to_owned();
    let user = match signed_in(&state, req.headers(), ip) {
        Ok(Some(user)) => user,
        Ok(None) => return unauthorized(),
        Err(()) => {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                "Too many sign-ins. Wait a minute.",
            )
                .into_response()
        }
    };
    if !user.holds("drive.view") {
        return (StatusCode::FORBIDDEN, "This account cannot use Storage").into_response();
    }
    let Some(place) = all(&state).into_iter().find(|l| l.name == name) else {
        return (StatusCode::NOT_FOUND, "No such location").into_response();
    };
    if !Path::new(&place.path).is_dir() {
        return (
            StatusCode::NOT_FOUND,
            "That location's folder is not on this computer now",
        )
            .into_response();
    }
    let methods = if user.holds("drive.edit") {
        DavMethodSet::all()
    } else {
        DavMethodSet::WEBDAV_RO
    };
    let config = DavConfig::new()
        .methods(methods)
        .principal(user.username.clone());
    let response = handler(&place).handle_with(config, req).await;
    response.map(Body::new)
}

/// Whether `path` is a location's address, which a tunnel lets through for
/// the location's own sign-in.
pub fn is_dav(path: &str) -> bool {
    path.starts_with("/dav/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_plain() {
        assert!(valid_name("media"));
        assert!(valid_name("backups_2"));
        assert!(!valid_name("Media"));
        assert!(!valid_name("-x"));
        assert!(!valid_name("a/b"));
        assert!(!valid_name(""));
    }

    #[tokio::test]
    async fn a_location_lists_and_takes_files_over_webdav() {
        let dir = std::env::temp_dir().join(format!("locations-test-{}", random_hex(6)));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("hello.txt"), "hi").unwrap();
        let place = Location {
            id: random_hex(8),
            name: "test".into(),
            path: dir.display().to_string(),
        };
        let dav = handler(&place);

        let list = axum::http::Request::builder()
            .method("PROPFIND")
            .uri("/dav/test/")
            .header("Depth", "1")
            .body(Body::empty())
            .unwrap();
        let answer = dav.handle(list).await;
        assert_eq!(answer.status().as_u16(), 207);
        let body = http_body_util::BodyExt::collect(answer.into_body()).await.unwrap().to_bytes();
        assert!(String::from_utf8_lossy(&body).contains("hello.txt"));

        let put = axum::http::Request::builder()
            .method("PUT")
            .uri("/dav/test/new.txt")
            .body(Body::from("made over WebDAV"))
            .unwrap();
        let answer = dav.handle(put).await;
        assert!(answer.status().is_success(), "{}", answer.status());
        assert_eq!(std::fs::read_to_string(dir.join("new.txt")).unwrap(), "made over WebDAV");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
