//! Locations: drives of their own, as a NAS keeps volumes. Each is a part of
//! another drive's free room set aside as a drive with its own letter, such
//! as A:, made and attached on this computer, and attached again at boot. Each
//! is browsed and changed on Storage, and opens in File Explorer, Finder and
//! any other WebDAV client at `/dav/<name>` on the dashboard's address, signed
//! in with a myTunnels account that may use Storage: reading with Storage's
//! view permission, changing with its edit permission.
//!
//! On Windows the drive is a virtual disk, `<drive>:\drives\<name>.vhdx`, its
//! whole size set aside when it is made, formatted NTFS. Making, attaching and
//! removing one needs administrator rights, so the "myTunnels Drives" task does
//! it as SYSTEM, put in place by the one admin step.

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
    /// Its name, in its address `/dav/<name>` and on its drive.
    pub name: String,
    /// The drive's root, such as `A:\`.
    pub path: String,
    /// The virtual disk the drive is, on the drive its room was taken from.
    #[serde(default)]
    pub image: String,
    /// Its size, in bytes.
    #[serde(default)]
    pub size: u64,
    /// How far along it is while it is being made; none once it is.
    #[serde(default)]
    pub making: Option<u8>,
    /// Why it could not be made.
    #[serde(default)]
    pub error: Option<String>,
}

const KEY: &str = "storage_locations";
const GB: u64 = 1 << 30;

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
    all(state)
        .into_iter()
        .find(|l| l.id == id && l.making.is_none() && l.error.is_none())
}

fn save(state: &AppState, list: &[Location]) -> ApiResult<()> {
    let text = serde_json::to_string(list).map_err(|e| ApiError::bad(e.to_string()))?;
    state.db.set_setting(KEY, &text)?;
    Ok(())
}

/// Changes the location `id`, when it is still there.
fn change(state: &AppState, id: &str, f: impl FnOnce(&mut Location)) {
    static SAVING: Mutex<()> = Mutex::new(());
    let _one = lock(&SAVING);
    let mut list = all(state);
    if let Some(l) = list.iter_mut().find(|l| l.id == id) {
        f(l);
        let _ = save(state, &list);
    }
}

/// A location's name, as its address takes it: lowercase letters, digits,
/// `-` and `_`.
fn valid_name(name: &str) -> bool {
    (1..=32).contains(&name.len())
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

/// A drive's root by its letter, such as `G:\`.
fn root(letter: char) -> PathBuf {
    PathBuf::from(format!("{letter}:\\"))
}

/// The letters no drive has yet, A first.
fn free_letters(list: &[Location]) -> Vec<char> {
    ('A'..='Z')
        .filter(|&c| !root(c).exists() && !list.iter().any(|l| l.path.starts_with(c)))
        .collect()
}

// ---- the API ----

pub async fn list(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let host = address(&state);
    let locations: Vec<Value> = all(&state)
        .into_iter()
        .map(|l| {
            let path = Path::new(&l.path);
            let here = l.making.is_none() && l.error.is_none() && path.is_dir();
            let space = here
                .then(|| crate::storage::disk(path))
                .flatten()
                .map(|(free, total)| json!({ "free": free, "total": total }));
            let url = host.as_ref().map(|h| format!("https://{h}/dav/{}", l.name));
            json!({
                "id": l.id, "name": l.name, "path": l.path, "size": l.size, "here": here,
                "space": space, "url": url, "making": l.making, "error": l.error,
            })
        })
        .collect();
    Ok(Json(json!({ "locations": locations, "address": host })))
}

#[derive(Deserialize)]
pub struct NewLocation {
    name: String,
    /// The drive whose free room it is made from, such as `G:\`.
    from: String,
    /// Its size, in gigabytes.
    size_gb: u64,
    /// Its letter, such as `A`.
    letter: String,
}

pub async fn add(
    State(state): State<AppState>,
    Json(body): Json<NewLocation>,
) -> ApiResult<Json<Value>> {
    if !cfg!(windows) {
        return Err(ApiError::bad("Making a drive works on Windows for now"));
    }
    let name = body.name.trim().to_owned();
    if !valid_name(&name) {
        return Err(ApiError::bad(
            "Name: lowercase letters, digits, '-' and '_', starting with a letter or digit, up to 32",
        ));
    }
    let mut list = all(&state);
    if list.iter().any(|l| l.name == name) {
        return Err(ApiError::conflict(format!(
            "There is already a location called {name}"
        )));
    }
    let from = body
        .from
        .trim()
        .chars()
        .next()
        .map(|c| c.to_ascii_uppercase());
    let Some(from) = from.filter(|c| c.is_ascii_uppercase() && root(*c).is_dir()) else {
        return Err(ApiError::bad(
            "Pick a drive on this computer to take the room from",
        ));
    };
    let letter = body
        .letter
        .trim()
        .chars()
        .next()
        .map(|c| c.to_ascii_uppercase());
    let Some(letter) = letter.filter(|c| free_letters(&list).contains(c)) else {
        return Err(ApiError::bad("That letter is taken; pick a free one"));
    };
    if body.size_gb == 0 {
        return Err(ApiError::bad("Give it at least 1 GB"));
    }
    let size = body.size_gb.saturating_mul(GB);
    let free = crate::storage::disk(&root(from)).map_or(0, |(free, _)| free);
    // Room left over on the drive it comes from, so that drive never fills.
    if size.saturating_add(GB) > free {
        return Err(ApiError::bad(format!(
            "{from}: has room for {} GB at most",
            free.saturating_sub(GB) / GB
        )));
    }
    let image = format!("{from}:\\drives\\{name}.vhdx");
    if Path::new(&image).exists() {
        return Err(ApiError::conflict(format!("{image} is there already")));
    }
    let id = random_hex(8);
    list.push(Location {
        id: id.clone(),
        name: name.clone(),
        path: root(letter).display().to_string(),
        image: image.clone(),
        size,
        making: Some(0),
        error: None,
    });
    save(&state, &list)?;
    let ask = json!({
        "action": "make", "image": image, "size_mb": size / (1 << 20),
        "letter": letter.to_string(), "label": name,
    });
    let worker = state.clone();
    tokio::spawn(async move {
        let progress = |p: u8| change(&worker, &id, |l| l.making = Some(p));
        // The drives helper put in place first if this computer lacks it.
        let done = match crate::grant::ensure().await {
            Ok(()) => helper::ask(&ask, Duration::from_secs(4 * 3600), progress).await,
            Err(err) => Err(format!("{err:#}")),
        };
        change(&worker, &id, |l| {
            l.making = None;
            l.error = done.err();
        });
    });
    list_value(&state).await
}

pub async fn remove(
    State(state): State<AppState>,
    UrlPath(id): UrlPath<String>,
) -> ApiResult<Json<Value>> {
    let place = all(&state)
        .into_iter()
        .find(|l| l.id == id)
        .ok_or_else(ApiError::not_found)?;
    if place.making.is_some() {
        return Err(ApiError::conflict("It is still being made"));
    }
    // The drive goes with what is on it.
    if !place.image.is_empty() && Path::new(&place.image).exists() {
        let ask = json!({ "action": "remove", "image": place.image });
        crate::grant::ensure()
            .await
            .map_err(|e| ApiError::bad(format!("{e:#}")))?;
        helper::ask(&ask, Duration::from_secs(120), |_| {})
            .await
            .map_err(ApiError::bad)?;
    }
    let mut list = all(&state);
    list.retain(|l| l.id != id);
    save(&state, &list)?;
    let _ = std::fs::remove_dir_all(state.config.data_dir.join("thumbs").join(&id));
    lock(&HANDLERS).retain(|key, _| !key.starts_with(&format!("{id}:")));
    list_value(&state).await
}

async fn list_value(state: &AppState) -> ApiResult<Json<Value>> {
    list(State(state.clone())).await
}

/// The drives a drive's room can come from, with their room, and the letters free.
pub async fn drives(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let list = all(&state);
    let drives: Vec<Value> = ('A'..='Z')
        .map(root)
        .filter(|p| cfg!(windows) && p.is_dir())
        // Not one of its own drives.
        .filter(|p| !list.iter().any(|l| Path::new(&l.path) == p.as_path()))
        .filter_map(|p| {
            let (free, total) = crate::storage::disk(&p)?;
            Some(json!({ "path": p.display().to_string(), "space": { "free": free, "total": total } }))
        })
        .collect();
    let letters: Vec<String> = free_letters(&list).iter().map(char::to_string).collect();
    Ok(Json(json!({ "drives": drives, "letters": letters })))
}

/// Puts the drives helper in place: see `helper::grant`.
#[cfg(windows)]
pub use helper::grant as grant_helper;

/// The "myTunnels Drives" task, which makes, attaches and removes drives as
/// SYSTEM, and the asks myTunnels leaves it.
mod helper {
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    use serde_json::Value;

    #[cfg(windows)]
    const SCRIPT: &str = include_str!("drives.ps1");
    #[cfg(windows)]
    const TASK: &str = "myTunnels Drives";

    fn under(var: &str, fallback: &str) -> PathBuf {
        std::env::var_os(var)
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(fallback))
            .join("myTunnels")
            .join("drives")
    }

    /// Where myTunnels asks it, which only the account it runs as may write to.
    fn asks() -> PathBuf {
        under("ProgramData", r"C:\ProgramData")
    }

    /// Puts the helper in place for the account `sid`, and starts it. Run
    /// with administrator rights.
    #[cfg(windows)]
    pub fn grant(sid: &str) -> anyhow::Result<()> {
        use crate::hardware::{add_task, lock_down};
        let dir = under("ProgramFiles", r"C:\Program Files");
        lock_down(&dir, None)?;
        let script = dir.join("drives.ps1");
        std::fs::write(&script, SCRIPT)?;
        lock_down(&asks(), Some(sid))?;
        add_task(
            TASK,
            &script,
            "Makes and attaches the drives Storage keeps, and attaches them again at boot.",
        )
    }

    /// Leaves `ask` for the helper and waits up to `wait` for it, telling
    /// `progress` how far along it says it is.
    pub async fn ask(ask: &Value, wait: Duration, progress: impl Fn(u8)) -> Result<(), String> {
        let dir = asks();
        let job = crate::util::random_hex(8);
        let file = dir.join(format!("{job}.json"));
        let (done, failed, along) = (
            file.with_extension("done"),
            file.with_extension("error"),
            file.with_extension("progress"),
        );
        let clean = || {
            for f in [&file, &done, &failed, &along] {
                let _ = std::fs::remove_file(f);
            }
        };
        // Written whole, then named, so the helper never reads half of it.
        let part = file.with_extension("part");
        if std::fs::write(&part, ask.to_string())
            .and_then(|()| std::fs::rename(&part, &file))
            .is_err()
        {
            let _ = std::fs::remove_file(&part);
            return Err("The drives helper is not set up on this computer".into());
        }
        let began = Instant::now();
        loop {
            if done.exists() {
                clean();
                return Ok(());
            }
            if let Ok(why) = std::fs::read_to_string(&failed) {
                clean();
                return Err(why.trim().to_owned());
            }
            if let Some(p) = std::fs::read_to_string(&along)
                .ok()
                .and_then(|t| t.trim().parse::<u8>().ok())
            {
                progress(p.min(99));
            }
            if file.exists() && began.elapsed() > Duration::from_secs(60) {
                clean();
                return Err("The drives helper did not take it; is it running?".into());
            }
            if began.elapsed() > wait {
                clean();
                return Err("The drive took too long".into());
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }
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
            image: String::new(),
            size: 0,
            making: None,
            error: None,
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
        let body = http_body_util::BodyExt::collect(answer.into_body())
            .await
            .unwrap()
            .to_bytes();
        assert!(String::from_utf8_lossy(&body).contains("hello.txt"));

        let put = axum::http::Request::builder()
            .method("PUT")
            .uri("/dav/test/new.txt")
            .body(Body::from("made over WebDAV"))
            .unwrap();
        let answer = dav.handle(put).await;
        assert!(answer.status().is_success(), "{}", answer.status());
        assert_eq!(
            std::fs::read_to_string(dir.join("new.txt")).unwrap(),
            "made over WebDAV"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
