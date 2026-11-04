//! Storage: one folder of this host, browsed and changed from the dashboard, and
//! from its own address by the people given folders in it.
//!
//! Paths in the API are under the storage folder, `/`-separated, `""` for the
//! folder itself. Host paths are the same kind of list from the top of the host:
//! a drive letter first (`C:/Users`) where the host has drives, `""` for every
//! drive (or `/`) at once.

use std::path::{Path, PathBuf};

use axum::body::Body;
use axum::extract::{Query, Request};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use http_body_util::BodyExt;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tower_http::services::ServeFile;

use crate::config::Config;
use crate::db::{Route, Rule};
use crate::state::AppState;
use crate::util::{now, random_hex, ApiError, ApiResult};

/// The most one upload request may carry, under Cloudflare's 100 MB limit; the
/// page sends bigger files in pieces of this size or less.
const MAX_CHUNK: u64 = 64 * 1024 * 1024;
/// Pieces of an upload are kept beside its file under this ending until the
/// last one arrives; ones left a day are cleared away.
const PART: &str = ".mtpart";
const PART_TTL: i64 = 86_400;

// ---- the host's files ----

#[derive(Clone, Copy, PartialEq)]
enum Layout {
    /// Drive letters at the top, as on Windows.
    Drives,
    /// One tree from `/`.
    Unix,
}

/// Where host paths are found from this process.
struct Host {
    layout: Layout,
    base: Option<PathBuf>,
}

impl Host {
    fn of(config: &Config) -> Self {
        let base = config.host_root.clone();
        let layout = match &base {
            Some(b) if !letters(&b.join("drives")).is_empty() => Layout::Drives,
            Some(_) => Layout::Unix,
            None if cfg!(windows) => Layout::Drives,
            None => Layout::Unix,
        };
        Self { layout, base }
    }

    /// The drives at the top, as `C:`.
    fn drives(&self) -> Vec<String> {
        match &self.base {
            Some(b) => letters(&b.join("drives"))
                .into_iter()
                .map(|c| format!("{}:", c.to_ascii_uppercase()))
                .collect(),
            None => ('A'..='Z')
                .filter(|c| Path::new(&format!("{c}:\\")).is_dir())
                .map(|c| format!("{c}:"))
                .collect(),
        }
    }

    /// The real path of a host path; `None` for the top of a host with drives,
    /// which is a list of drives rather than a folder.
    fn real(&self, segs: &[String]) -> Option<PathBuf> {
        let mut path = match self.layout {
            Layout::Drives => {
                let letter = drive(segs.first()?)?;
                match &self.base {
                    Some(b) => b
                        .join("drives")
                        .join(letter.to_ascii_lowercase().to_string()),
                    None => PathBuf::from(format!("{letter}:\\")),
                }
            }
            Layout::Unix => match &self.base {
                Some(b) => b.join("root"),
                None => PathBuf::from("/"),
            },
        };
        let skip = usize::from(self.layout == Layout::Drives);
        for seg in &segs[skip..] {
            path.push(seg);
        }
        Some(path)
    }

    /// A host path as people write it: `C:\Users\Kris`, `/home/kris`.
    fn display(&self, segs: &[String]) -> String {
        match self.layout {
            Layout::Drives if segs.is_empty() => "All drives".into(),
            Layout::Drives if segs.len() == 1 => format!("{}\\", segs[0]),
            Layout::Drives => segs.join("\\"),
            Layout::Unix => format!("/{}", segs.join("/")),
        }
    }

    /// Refuses a host path this host cannot have: a drive letter first, where it
    /// has drives, and no characters Windows keeps for itself in a name.
    fn check(&self, segs: &[String]) -> ApiResult<()> {
        if self.layout == Layout::Unix {
            return Ok(());
        }
        for (i, seg) in segs.iter().enumerate() {
            let ok = if i == 0 {
                drive(seg).is_some()
            } else {
                !seg.contains([':', '<', '>', '"', '|', '?', '*']) && !seg.ends_with(['.', ' '])
            };
            if !ok {
                return Err(ApiError::bad(format!("\"{seg}\" is not a usable name")));
            }
        }
        Ok(())
    }

    /// What a path may not leave, symbolic links included: the drives' mount in a
    /// container, nothing natively.
    fn bound(&self) -> Option<PathBuf> {
        match (self.layout, &self.base) {
            (Layout::Drives, Some(b)) => Some(b.join("drives")),
            (Layout::Unix, Some(b)) => Some(b.join("root")),
            _ => None,
        }
    }
}

/// The one-letter folders in a directory, which Docker Desktop makes per drive.
fn letters(dir: &Path) -> Vec<char> {
    let mut found: Vec<char> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|e| e.path().is_dir())
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().into_owned();
                    let mut chars = name.chars();
                    match (chars.next(), chars.next()) {
                        (Some(c), None) if c.is_ascii_alphabetic() => Some(c),
                        _ => None,
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    found.sort_unstable();
    found
}

/// The letter of a drive segment such as `C:`.
fn drive(seg: &str) -> Option<char> {
    let mut chars = seg.chars();
    match (chars.next(), chars.next(), chars.next()) {
        (Some(c), Some(':'), None) if c.is_ascii_alphabetic() => Some(c.to_ascii_uppercase()),
        _ => None,
    }
}

/// Splits a path into its names, refusing any that could reach outside it.
fn segments(path: &str) -> ApiResult<Vec<String>> {
    path.split('/')
        .filter(|s| !s.is_empty())
        .map(|s| {
            if s == "."
                || s == ".."
                || s.len() > 255
                || s.contains(['\\', '\0'])
                || s.chars().any(char::is_control)
            {
                Err(ApiError::bad(format!("\"{s}\" is not a usable name")))
            } else {
                Ok(s.to_owned())
            }
        })
        .collect()
}

fn joined(segs: &[String]) -> String {
    segs.join("/")
}

// ---- the storage folder ----

/// The storage folder, with the host it is on.
struct Store {
    host: Host,
    root: Vec<String>,
}

impl Store {
    fn open(state: &AppState) -> ApiResult<Self> {
        let path = state.db.setting("storage_path")?.ok_or_else(|| {
            ApiError(
                StatusCode::PRECONDITION_FAILED,
                "Choose the storage folder first".into(),
            )
        })?;
        Ok(Self {
            host: Host::of(&state.config),
            root: segments(&path)?,
        })
    }

    fn full(&self, rel: &[String]) -> ApiResult<Vec<String>> {
        let full: Vec<String> = self.root.iter().chain(rel).cloned().collect();
        self.host.check(&full)?;
        Ok(full)
    }

    /// The real path of a path in storage, refused if it leads outside the storage
    /// folder; `None` for a list of drives.
    fn real(&self, rel: &[String]) -> ApiResult<Option<PathBuf>> {
        let Some(path) = self.host.real(&self.full(rel)?) else {
            return Ok(None);
        };
        let limit = self.host.real(&self.root).or_else(|| self.host.bound());
        if let Some(limit) = limit {
            let limit = std::fs::canonicalize(&limit).unwrap_or(limit);
            // A path that is not there yet is judged by the folder it would go in.
            let mut probe = path.as_path();
            let found = loop {
                match std::fs::canonicalize(probe) {
                    Ok(found) => break Some(found),
                    Err(_) => match probe.parent() {
                        Some(parent) => probe = parent,
                        None => break None,
                    },
                }
            };
            if !found.is_some_and(|f| f.starts_with(&limit)) {
                return Err(ApiError(
                    StatusCode::FORBIDDEN,
                    "That leads outside the storage folder".into(),
                ));
            }
        }
        Ok(Some(path))
    }

    /// The real path of something that can be moved, renamed or removed: not the
    /// storage folder itself, nor a drive.
    fn item(&self, rel: &[String]) -> ApiResult<PathBuf> {
        if rel.is_empty() {
            return Err(ApiError::bad("That is the storage folder itself"));
        }
        if self.real(&rel[..rel.len() - 1])?.is_none() {
            return Err(ApiError::bad("A drive cannot be changed here"));
        }
        self.real(rel)?.ok_or_else(ApiError::not_found)
    }
}

// ---- who may do what ----

/// Who is asking: the admin on the dashboard, or a visitor at the storage
/// address, signed in or not.
pub enum Who {
    Admin,
    Visitor(Option<String>),
}

#[derive(Clone, Copy, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "lowercase")]
enum Level {
    None,
    /// Only on the way to a folder given further in.
    Browse,
    Read,
    Write,
}

struct Grants {
    full: bool,
    rules: Vec<(Vec<String>, Level)>,
}

impl Grants {
    fn of(state: &AppState, who: &Who) -> ApiResult<Self> {
        let user = match who {
            Who::Admin => {
                return Ok(Self {
                    full: true,
                    rules: Vec::new(),
                })
            }
            Who::Visitor(user) => user.as_deref(),
        };
        let rules = state
            .db
            .rules()?
            .into_iter()
            .filter(|r| r.user_id == "*" || Some(r.user_id.as_str()) == user)
            .filter_map(|r| {
                let level = if r.mode == "write" {
                    Level::Write
                } else {
                    Level::Read
                };
                Some((segments(&r.path).ok()?, level))
            })
            .collect();
        Ok(Self { full: false, rules })
    }

    fn level(&self, path: &[String]) -> Level {
        if self.full {
            return Level::Write;
        }
        let mut best = Level::None;
        for (rule, level) in &self.rules {
            let here = if path.starts_with(rule) {
                *level
            } else if rule.starts_with(path) {
                Level::Browse
            } else {
                Level::None
            };
            if here > best {
                best = here;
            }
        }
        best
    }

    /// In a folder only browsed through, the names that lead to a folder given.
    fn ways(&self, path: &[String]) -> Vec<String> {
        self.rules
            .iter()
            .filter(|(rule, _)| rule.len() > path.len() && rule.starts_with(path))
            .map(|(rule, _)| rule[path.len()].clone())
            .collect()
    }

    fn need(&self, path: &[String], level: Level) -> ApiResult<()> {
        if self.level(path) >= level {
            Ok(())
        } else {
            Err(ApiError(
                StatusCode::FORBIDDEN,
                match level {
                    Level::Write => "You can't change things here",
                    _ => "You don't have access to this folder",
                }
                .into(),
            ))
        }
    }
}

fn parent(path: &[String]) -> &[String] {
    &path[..path.len().saturating_sub(1)]
}

// ---- the files API, the same on the dashboard and at the storage address ----

pub fn enabled(state: &AppState) -> bool {
    state
        .db
        .setting("storage_enabled")
        .ok()
        .flatten()
        .as_deref()
        == Some("1")
}

/// One file operation, `op`, for `who`.
pub async fn fs(state: &AppState, who: Who, op: &str, req: Request) -> Response {
    if !enabled(state) {
        return ApiError(StatusCode::NOT_FOUND, "Storage is off".into()).into_response();
    }
    let result = async {
        let store = Store::open(state)?;
        let grants = Grants::of(state, &who)?;
        // The account signed in at the storage address, by the name it shows.
        let user = match &who {
            Who::Visitor(Some(id)) => state.snapshot().users.get(id).map(|u| {
                if u.name.is_empty() {
                    u.username.clone()
                } else {
                    u.name.clone()
                }
            }),
            _ => None,
        };
        let method = req.method().clone();
        match (method, op) {
            (Method::GET, "list") => list(&store, &grants, user, query(&req)?).await,
            (Method::GET | Method::HEAD, "file") => download(&store, &grants, req).await,
            (Method::POST, "folder") => folder(&store, &grants, body(req).await?).await,
            (Method::POST, "rename") => rename(&store, &grants, body(req).await?).await,
            (Method::POST, "move") => relocate(&store, &grants, body(req).await?).await,
            (Method::POST, "delete") => delete(&store, &grants, body(req).await?).await,
            (Method::PUT, "upload") => upload(&store, &grants, req).await,
            _ => Err(ApiError::not_found()),
        }
    }
    .await;
    result.unwrap_or_else(IntoResponse::into_response)
}

fn query<T: DeserializeOwned>(req: &Request) -> ApiResult<T> {
    Query::<T>::try_from_uri(req.uri())
        .map(|q| q.0)
        .map_err(|e| ApiError::bad(e.body_text()))
}

async fn body<T: DeserializeOwned>(req: Request) -> ApiResult<T> {
    let bytes = axum::body::to_bytes(req.into_body(), 1024 * 1024)
        .await
        .map_err(|_| ApiError(StatusCode::PAYLOAD_TOO_LARGE, "Too much at once".into()))?;
    serde_json::from_slice(&bytes).map_err(|e| ApiError::bad(e.to_string()))
}

#[derive(Deserialize)]
struct At {
    #[serde(default)]
    path: String,
}

#[derive(Serialize)]
struct Entry {
    name: String,
    dir: bool,
    size: u64,
    /// Unix seconds; 0 when unknown, as for a drive.
    modified: i64,
}

async fn list(store: &Store, grants: &Grants, user: Option<String>, at: At) -> ApiResult<Response> {
    let rel = segments(&at.path)?;
    let level = grants.level(&rel);
    if level == Level::None {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "You don't have access to this folder".into(),
        ));
    }
    let ways = grants.ways(&rel);
    let shown = |name: &str| level != Level::Browse || ways.iter().any(|w| w == name);
    let real = store.real(&rel)?;
    let mut entries = Vec::new();
    match &real {
        None => {
            for name in store.host.drives() {
                if shown(&name) {
                    entries.push(Entry {
                        name,
                        dir: true,
                        size: 0,
                        modified: 0,
                    });
                }
            }
        }
        Some(dir) => {
            let mut read = tokio::fs::read_dir(dir).await.map_err(io_error)?;
            let now = now();
            while let Some(entry) = read.next_entry().await.map_err(io_error)? {
                let name = entry.file_name().to_string_lossy().into_owned();
                // Symbolic links are shown as what they point at.
                let meta = match tokio::fs::metadata(entry.path()).await {
                    Ok(meta) => meta,
                    Err(_) => match entry.metadata().await {
                        Ok(meta) => meta,
                        Err(_) => continue,
                    },
                };
                let modified = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map_or(0, |d| d.as_secs() as i64);
                if name.ends_with(PART) {
                    if now - modified > PART_TTL {
                        let _ = tokio::fs::remove_file(entry.path()).await;
                    }
                    continue;
                }
                if !shown(&name) {
                    continue;
                }
                entries.push(Entry {
                    dir: meta.is_dir(),
                    size: if meta.is_dir() { 0 } else { meta.len() },
                    modified,
                    name,
                });
            }
        }
    }
    let space = real.as_deref().and_then(space);
    Ok(Json(json!({
        "path": joined(&rel),
        "access": level,
        "entries": entries,
        "space": space,
        "user": user,
    }))
    .into_response())
}

/// The free and total bytes of the disk a folder is on.
fn space(dir: &Path) -> Option<Value> {
    let dir = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_owned());
    let disks = sysinfo::Disks::new_with_refreshed_list();
    disks
        .list()
        .iter()
        .filter(|d| {
            let mount = d.mount_point();
            dir.starts_with(mount) || std::fs::canonicalize(mount).is_ok_and(|m| dir.starts_with(m))
        })
        .max_by_key(|d| d.mount_point().as_os_str().len())
        .map(|d| json!({ "free": d.available_space(), "total": d.total_space() }))
}

#[derive(Deserialize)]
struct FileAt {
    path: String,
    /// Shown in the browser rather than saved, for the kinds that are safe to show.
    #[serde(default)]
    inline: bool,
}

async fn download(store: &Store, grants: &Grants, req: Request) -> ApiResult<Response> {
    let at: FileAt = query(&req)?;
    let rel = segments(&at.path)?;
    grants.need(&rel, Level::Read)?;
    let real = store.real(&rel)?.ok_or_else(ApiError::not_found)?;
    if !real.is_file() {
        return Err(ApiError::bad("Only files can be downloaded"));
    }
    let name = rel.last().cloned().unwrap_or_default();
    let response = ServeFile::new(&real)
        .try_call(req)
        .await
        .map_err(io_error)?;
    let mut response = response.map(Body::new);
    let headers = response.headers_mut();
    let kind = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    // Anything that could run script on this address is only ever saved.
    let textual = (kind.starts_with("text/") && !kind.contains("html") && !kind.contains("xml"))
        || kind.starts_with("application/json");
    let viewable = (kind.starts_with("image/") && !kind.contains("svg"))
        || kind.starts_with("video/")
        || kind.starts_with("audio/")
        || kind.starts_with("application/pdf")
        || textual;
    let inline = at.inline && viewable;
    if inline && textual {
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/plain; charset=utf-8"),
        );
    }
    let disposition = format!(
        "{}; filename=\"{}\"; filename*=UTF-8''{}",
        if inline { "inline" } else { "attachment" },
        name.replace(
            |c: char| !c.is_ascii_graphic() || c == '"' || c == '\\',
            "_"
        ),
        encode(&name)
    );
    if let Ok(value) = HeaderValue::from_str(&disposition) {
        headers.insert(header::CONTENT_DISPOSITION, value);
    }
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("sandbox; default-src 'none'; img-src 'self'; media-src 'self'"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-cache"),
    );
    Ok(response)
}

/// Percent-encodes a file name for `filename*`.
fn encode(name: &str) -> String {
    name.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

#[derive(Deserialize)]
struct Paths {
    paths: Vec<String>,
}

async fn folder(store: &Store, grants: &Grants, at: At) -> ApiResult<Response> {
    let rel = segments(&at.path)?;
    if rel.is_empty() {
        return Err(ApiError::bad("Name the new folder"));
    }
    grants.need(parent(&rel), Level::Write)?;
    let real = store.item(&rel)?;
    if tokio::fs::symlink_metadata(&real).await.is_ok() {
        return Err(ApiError::conflict(format!(
            "{} already exists",
            rel[rel.len() - 1]
        )));
    }
    tokio::fs::create_dir(&real).await.map_err(io_error)?;
    Ok(Json(json!({ "path": joined(&rel) })).into_response())
}

#[derive(Deserialize)]
struct Rename {
    path: String,
    name: String,
}

async fn rename(store: &Store, grants: &Grants, body: Rename) -> ApiResult<Response> {
    let rel = segments(&body.path)?;
    let name = body.name.trim();
    let new = segments(name)?;
    if new.len() != 1 {
        return Err(ApiError::bad("A name cannot hold a slash"));
    }
    grants.need(parent(&rel), Level::Write)?;
    let from = store.item(&rel)?;
    let mut target = parent(&rel).to_vec();
    target.push(new[0].clone());
    let to = store.item(&target)?;
    // Only the case changing is the same file on Windows and macOS.
    let same = rel.last().is_some_and(|old| old.eq_ignore_ascii_case(name));
    if !same && tokio::fs::symlink_metadata(&to).await.is_ok() {
        return Err(ApiError::conflict(format!("{name} already exists")));
    }
    tokio::fs::rename(&from, &to).await.map_err(io_error)?;
    Ok(Json(json!({ "path": joined(&target) })).into_response())
}

#[derive(Deserialize)]
struct Relocate {
    paths: Vec<String>,
    to: String,
    #[serde(default)]
    copy: bool,
}

/// Moves or copies items into a folder. Nothing already there is replaced.
async fn relocate(store: &Store, grants: &Grants, body: Relocate) -> ApiResult<Response> {
    let to = segments(&body.to)?;
    grants.need(&to, Level::Write)?;
    let dest = store
        .real(&to)?
        .ok_or_else(|| ApiError::bad("Pick a folder on a drive"))?;
    if !dest.is_dir() {
        return Err(ApiError::bad("Pick a folder to put them in"));
    }
    let mut done = 0;
    for path in &body.paths {
        let rel = segments(path)?;
        grants.need(
            if body.copy { &rel[..] } else { parent(&rel) },
            if body.copy { Level::Read } else { Level::Write },
        )?;
        let from = store.item(&rel)?;
        let name = rel[rel.len() - 1].clone();
        if to.starts_with(&rel) {
            return Err(ApiError::bad(format!("{name} cannot go inside itself")));
        }
        if !body.copy && parent(&rel) == to.as_slice() {
            continue;
        }
        let mut target = to.clone();
        target.push(name.clone());
        let into = store.item(&target)?;
        if tokio::fs::symlink_metadata(&into).await.is_ok() {
            return Err(ApiError::conflict(format!("{name} already exists there")));
        }
        let (from, into, copy) = (from.clone(), into.clone(), body.copy);
        tokio::task::spawn_blocking(move || {
            if copy {
                copy_all(&from, &into)
            } else {
                // Across disks a rename cannot work, so it is a copy then a delete.
                std::fs::rename(&from, &into).or_else(|_| {
                    copy_all(&from, &into)?;
                    remove(&from)
                })
            }
        })
        .await
        .map_err(|e| ApiError::from(anyhow::anyhow!(e)))?
        .map_err(io_error)?;
        done += 1;
    }
    Ok(Json(json!({ "done": done })).into_response())
}

fn copy_all(from: &Path, to: &Path) -> std::io::Result<()> {
    if std::fs::metadata(from)?.is_dir() {
        std::fs::create_dir(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            copy_all(&entry.path(), &to.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(from, to).map(|_| ())
    }
}

/// Removes a file, a link, or a folder and everything in it.
fn remove(path: &Path) -> std::io::Result<()> {
    let meta = std::fs::symlink_metadata(path)?;
    if meta.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path).or_else(|e| {
            // A link to a folder, on Windows.
            if meta.file_type().is_symlink() {
                std::fs::remove_dir(path)
            } else {
                Err(e)
            }
        })
    }
}

async fn delete(store: &Store, grants: &Grants, body: Paths) -> ApiResult<Response> {
    let mut targets = Vec::new();
    for path in &body.paths {
        let rel = segments(path)?;
        grants.need(parent(&rel), Level::Write)?;
        targets.push(store.item(&rel)?);
    }
    let count = targets.len();
    tokio::task::spawn_blocking(move || targets.iter().try_for_each(|t| remove(t)))
        .await
        .map_err(|e| ApiError::from(anyhow::anyhow!(e)))?
        .map_err(io_error)?;
    Ok(Json(json!({ "done": count })).into_response())
}

#[derive(Deserialize)]
struct Piece {
    /// The file to make, under the storage folder; folders on the way are made.
    path: String,
    /// The page's name for this upload, the same for each of its pieces.
    id: String,
    offset: u64,
    total: u64,
    /// Replace a file of the same name.
    #[serde(default)]
    replace: bool,
}

/// One piece of a file being uploaded, at `offset`. The file appears, under its
/// name, once the last piece is in.
async fn upload(store: &Store, grants: &Grants, req: Request) -> ApiResult<Response> {
    let piece: Piece = query(&req)?;
    if piece.id.is_empty()
        || piece.id.len() > 64
        || !piece.id.bytes().all(|b| b.is_ascii_alphanumeric())
    {
        return Err(ApiError::bad("Bad upload ID"));
    }
    let rel = segments(&piece.path)?;
    if rel.is_empty() {
        return Err(ApiError::bad("Name the file"));
    }
    grants.need(parent(&rel), Level::Write)?;
    let target = store.item(&rel)?;
    let dir = target.parent().ok_or_else(ApiError::not_found)?.to_owned();
    let temp = dir.join(format!(".{}{PART}", piece.id));

    if piece.offset == 0 {
        if !piece.replace && tokio::fs::symlink_metadata(&target).await.is_ok() {
            return Err(ApiError::conflict(format!(
                "{} already exists",
                rel[rel.len() - 1]
            )));
        }
        tokio::fs::create_dir_all(&dir).await.map_err(io_error)?;
        // The folders just made are checked as well.
        store.real(parent(&rel))?;
    }
    let mut file = if piece.offset == 0 {
        tokio::fs::File::create(&temp).await.map_err(io_error)?
    } else {
        let have = tokio::fs::metadata(&temp)
            .await
            .map(|m| m.len())
            .unwrap_or(0);
        if have != piece.offset {
            return Ok((
                StatusCode::CONFLICT,
                Json(json!({ "error": "The upload lost its place", "received": have })),
            )
                .into_response());
        }
        tokio::fs::OpenOptions::new()
            .append(true)
            .open(&temp)
            .await
            .map_err(io_error)?
    };

    let mut incoming = req.into_body();
    let mut written: u64 = 0;
    while let Some(frame) = incoming.frame().await {
        let frame = frame.map_err(|e| ApiError::bad(e.to_string()))?;
        let Ok(chunk) = frame.into_data() else {
            continue;
        };
        written += chunk.len() as u64;
        if written > MAX_CHUNK || piece.offset + written > piece.total {
            drop(file);
            let _ = tokio::fs::remove_file(&temp).await;
            return Err(ApiError(
                StatusCode::PAYLOAD_TOO_LARGE,
                "Too much at once".into(),
            ));
        }
        file.write_all(&chunk).await.map_err(io_error)?;
    }
    file.flush().await.map_err(io_error)?;
    drop(file);

    let received = piece.offset + written;
    if received < piece.total {
        return Ok(Json(json!({ "received": received, "done": false })).into_response());
    }
    if piece.replace && tokio::fs::symlink_metadata(&target).await.is_ok() {
        // Windows will not rename over a file that exists.
        tokio::fs::remove_file(&target).await.map_err(io_error)?;
    }
    tokio::fs::rename(&temp, &target).await.map_err(io_error)?;
    Ok(Json(json!({ "received": received, "done": true, "path": joined(&rel) })).into_response())
}

fn io_error(err: std::io::Error) -> ApiError {
    use std::io::ErrorKind;
    let status = match err.kind() {
        ErrorKind::NotFound => StatusCode::NOT_FOUND,
        ErrorKind::PermissionDenied => StatusCode::FORBIDDEN,
        ErrorKind::AlreadyExists => StatusCode::CONFLICT,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    let text = match err.kind() {
        ErrorKind::NotFound => "It is not there any more".to_owned(),
        ErrorKind::PermissionDenied => format!("This host does not allow that here: {err}"),
        _ => err.to_string(),
    };
    ApiError(status, text)
}

// ---- the Storage page ----

/// The storage tunnel: the one route whose target is Storage.
pub fn route(state: &AppState) -> Option<Route> {
    state
        .snapshot()
        .routes
        .values()
        .find(|r| r.target_scheme == "storage")
        .cloned()
}

/// Everything the Storage page shows: on or off, the folder, the address and the
/// folders each person may open.
pub async fn overview(state: &AppState) -> ApiResult<Json<Value>> {
    let host = Host::of(&state.config);
    let path = state.db.setting("storage_path")?;
    let display = match &path {
        Some(p) => Some(host.display(&segments(p)?)),
        None => None,
    };
    Ok(Json(json!({
        "enabled": enabled(state),
        "path": path,
        "display": display,
        "drives": host.layout == Layout::Drives,
        "route": route(state),
        "rules": state.db.rules()?,
    })))
}

#[derive(Deserialize)]
pub struct Settings {
    enabled: Option<bool>,
    path: Option<String>,
}

pub async fn save(state: &AppState, body: Settings) -> ApiResult<Json<Value>> {
    if let Some(path) = body.path {
        let host = Host::of(&state.config);
        let segs = segments(&path)?;
        host.check(&segs)?;
        if let Some(real) = host.real(&segs) {
            if !real.is_dir() {
                return Err(ApiError::bad(format!(
                    "{} is not a folder on this host",
                    host.display(&segs)
                )));
            }
        }
        state.db.set_setting("storage_path", &joined(&segs))?;
    }
    match body.enabled {
        Some(true) => state.db.set_setting("storage_enabled", "1")?,
        Some(false) => state.db.delete_setting("storage_enabled")?,
        None => {}
    }
    overview(state).await
}

/// The folders in a host folder, for choosing the storage folder.
pub async fn browse(state: &AppState, path: &str) -> ApiResult<Json<Value>> {
    let host = Host::of(&state.config);
    let segs = segments(path)?;
    host.check(&segs)?;
    let mut folders: Vec<String> = match host.real(&segs) {
        None => host.drives(),
        Some(dir) => {
            let mut read = tokio::fs::read_dir(&dir).await.map_err(io_error)?;
            let mut names = Vec::new();
            while let Some(entry) = read.next_entry().await.map_err(io_error)? {
                if tokio::fs::metadata(entry.path())
                    .await
                    .is_ok_and(|m| m.is_dir())
                {
                    names.push(entry.file_name().to_string_lossy().into_owned());
                }
            }
            names.sort_by_key(|n| n.to_lowercase());
            names
        }
    };
    folders.retain(|n| segments(n).is_ok_and(|s| s.len() == 1));
    Ok(Json(json!({
        "path": joined(&segs),
        "display": host.display(&segs),
        "parent": (!segs.is_empty()).then(|| joined(parent(&segs))),
        "folders": folders,
    })))
}

#[derive(Deserialize)]
pub struct RuleBody {
    user_id: Option<String>,
    path: Option<String>,
    mode: Option<String>,
}

/// Gives someone a folder, or changes one given.
pub async fn save_rule(
    state: &AppState,
    id: Option<String>,
    body: RuleBody,
) -> ApiResult<Json<Value>> {
    let mut rule = match &id {
        Some(id) => state
            .db
            .rules()?
            .into_iter()
            .find(|r| &r.id == id)
            .ok_or_else(ApiError::not_found)?,
        None => {
            let user_id = body.user_id.clone().unwrap_or_default();
            if user_id != "*" && state.db.user(&user_id)?.is_none() {
                return Err(ApiError::bad("No such user"));
            }
            Rule {
                id: random_hex(8),
                user_id,
                path: String::new(),
                mode: "read".into(),
                created_at: now(),
            }
        }
    };
    if let Some(path) = body.path {
        rule.path = joined(&segments(&path)?);
    }
    if let Some(mode) = body.mode {
        if mode != "read" && mode != "write" {
            return Err(ApiError::bad("Access is read or write"));
        }
        rule.mode = mode;
    }
    state.db.save_rule(&rule)?;
    overview(state).await
}

pub async fn delete_rule(state: &AppState, id: &str) -> ApiResult<Json<Value>> {
    state.db.delete_rule(id)?;
    overview(state).await
}

// ---- the storage address ----

/// A request at the storage address that passed its access checks: the files API,
/// or the explorer page.
pub async fn visit(
    state: &AppState,
    user: Option<String>,
    ui_dir: &Path,
    req: Request,
) -> Response {
    if !enabled(state) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let path = req.uri().path().to_owned();
    let mut response = if let Some(op) = path.strip_prefix("/api/storage/fs/") {
        let op = op.to_owned();
        let changes = !matches!(*req.method(), Method::GET | Method::HEAD);
        if changes && !req.headers().contains_key("x-requested-with") {
            ApiError(
                StatusCode::FORBIDDEN,
                "Refused: not sent by the page".into(),
            )
            .into_response()
        } else {
            let mut response = fs(state, Who::Visitor(user), &op, req).await;
            response
                .headers_mut()
                .entry(header::CACHE_CONTROL)
                .or_insert(HeaderValue::from_static("no-store"));
            response
        }
    } else if !matches!(*req.method(), Method::GET | Method::HEAD) {
        StatusCode::METHOD_NOT_ALLOWED.into_response()
    } else if path.starts_with("/assets/")
        || path.starts_with("/fonts/")
        || path.ends_with(".js")
        || path.ends_with(".ico")
    {
        match tower_http::services::ServeDir::new(ui_dir)
            .try_call(req)
            .await
        {
            Ok(response) => response.map(Body::new),
            Err(_) => StatusCode::NOT_FOUND.into_response(),
        }
    } else {
        explorer_page(ui_dir).await
    };
    let headers = response.headers_mut();
    for (name, value) in [
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        (header::X_FRAME_OPTIONS, "DENY"),
        (header::REFERRER_POLICY, "no-referrer"),
        (header::STRICT_TRANSPORT_SECURITY, "max-age=31536000"),
    ] {
        headers.insert(name, HeaderValue::from_static(value));
    }
    headers.entry(header::CONTENT_SECURITY_POLICY).or_insert(HeaderValue::from_static(
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    ));
    response
}

/// The dashboard's page, marked so it opens as the explorer alone.
async fn explorer_page(ui_dir: &Path) -> Response {
    match tokio::fs::read_to_string(ui_dir.join("index.html")).await {
        Ok(html) => (
            [
                (header::CONTENT_TYPE, "text/html; charset=utf-8"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            html.replacen("<head>", "<head><meta name=\"storage\" content=\"1\">", 1),
        )
            .into_response(),
        Err(_) => (StatusCode::SERVICE_UNAVAILABLE, "The page is not built").into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segs(p: &str) -> Vec<String> {
        segments(p).unwrap()
    }

    #[test]
    fn names_cannot_climb_out() {
        assert!(segments("a/../b").is_err());
        assert!(segments("a/./b").is_err());
        assert!(segments("a\\b").is_err());
        assert_eq!(segs("/a//b/"), vec!["a", "b"]);
        assert!(segs("").is_empty());
    }

    #[test]
    fn drives_take_a_letter_first() {
        let host = Host {
            layout: Layout::Drives,
            base: None,
        };
        assert!(host.check(&segs("C:/Users")).is_ok());
        assert!(host.check(&segs("Users")).is_err());
        assert!(host.check(&segs("C:/a:b")).is_err());
        assert_eq!(host.display(&segs("C:/Users/Kris")), "C:\\Users\\Kris");
        assert_eq!(host.display(&segs("D:")), "D:\\");
        assert!(host.real(&[]).is_none());
    }

    #[test]
    fn rules_give_folders_and_the_way_to_them() {
        let grants = Grants {
            full: false,
            rules: vec![
                (segs("Photos/2024"), Level::Write),
                (segs("Docs"), Level::Read),
            ],
        };
        assert!(grants.level(&[]) == Level::Browse);
        assert!(grants.level(&segs("Photos")) == Level::Browse);
        assert!(grants.level(&segs("Photos/2024/June")) == Level::Write);
        assert!(grants.level(&segs("Docs/a.txt")) == Level::Read);
        assert!(grants.level(&segs("Music")) == Level::None);
        let mut ways = grants.ways(&[]);
        ways.sort();
        assert_eq!(ways, vec!["Docs", "Photos"]);
    }
}
