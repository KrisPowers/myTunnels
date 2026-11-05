//! Media and Drive: collections myTunnels keeps in its data folder, for photos
//! and videos, and for documents, browsed and changed from the dashboard.
//!
//! Paths in the API are under the collection's folder, `/`-separated, `""` for
//! the folder itself.

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

use crate::state::AppState;
use crate::util::{now, ApiError, ApiResult};

/// The most one upload request may carry, under Cloudflare's 100 MB limit; the
/// page sends bigger files in pieces of this size or less.
const MAX_CHUNK: u64 = 64 * 1024 * 1024;
/// Pieces of an upload are kept beside its file under this ending until the
/// last one arrives; ones left a day are cleared away.
const PART: &str = ".mtpart";
const PART_TTL: i64 = 86_400;

/// Splits a path into its names, refusing any that could reach outside it.
pub fn segments(path: &str) -> ApiResult<Vec<String>> {
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

fn parent(path: &[String]) -> &[String] {
    &path[..path.len().saturating_sub(1)]
}

// ---- the collections ----

/// Which collection a request is about.
#[derive(Clone, Copy, PartialEq)]
pub enum Space {
    Media,
    Drive,
}

const MEDIA_KINDS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "avif", "heic", "heif", "tif", "tiff", "mp4",
    "mov", "m4v", "webm", "mkv", "avi", "3gp", "mts", "m2ts", "wmv",
];
const DRIVE_KINDS: &[&str] = &[
    "doc", "docx", "docm", "dot", "dotx", "odt", "rtf", "txt", "md", "pdf", "xls", "xlsx", "xlsm",
    "xlt", "xltx", "ods", "csv", "tsv", "ppt", "pptx", "pptm", "pps", "ppsx", "odp", "key",
    "pages", "numbers", "epub",
];

impl Space {
    /// Where a collection is kept, under the data folder.
    fn folder(self) -> &'static str {
        match self {
            Space::Media => "media",
            Space::Drive => "drive",
        }
    }

    /// Refuses a file a collection does not keep, by its ending.
    pub fn takes(self, name: &str) -> ApiResult<()> {
        let ext = name
            .rsplit_once('.')
            .map(|(_, e)| e.to_ascii_lowercase())
            .unwrap_or_default();
        let (kinds, what) = match self {
            Space::Media => (MEDIA_KINDS, "Media keeps photos and videos"),
            Space::Drive => (
                DRIVE_KINDS,
                "Drive keeps documents, spreadsheets, presentations and PDFs",
            ),
        };
        if kinds.contains(&ext.as_str()) {
            Ok(())
        } else {
            Err(ApiError::bad(format!("{what}, not {name}")))
        }
    }
}

/// A collection's folder.
pub struct Store {
    pub space: Space,
    base: PathBuf,
}

impl Store {
    pub fn open(state: &AppState, space: Space) -> ApiResult<Self> {
        let base = state.config.data_dir.join(space.folder());
        std::fs::create_dir_all(&base).map_err(io_error)?;
        Ok(Self { space, base })
    }

    /// Where a photo's or video's preview is kept, beside the collection.
    pub fn thumb(&self, rel: &[String]) -> Option<PathBuf> {
        if self.space != Space::Media {
            return None;
        }
        let mut path = self.base.join(".thumbs");
        for seg in rel {
            path.push(seg);
        }
        path.as_mut_os_string().push(".jpg");
        Some(path)
    }

    /// The real path of a path in the collection, refused if it leads outside it,
    /// symbolic links included.
    pub fn real(&self, rel: &[String]) -> ApiResult<PathBuf> {
        let path = rel
            .iter()
            .fold(self.base.clone(), |path, seg| path.join(seg));
        let limit = std::fs::canonicalize(&self.base).unwrap_or_else(|_| self.base.clone());
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
                "That leads outside this folder".into(),
            ));
        }
        Ok(path)
    }

    /// The real path of something that can be moved, renamed or removed: not the
    /// collection's folder itself.
    fn item(&self, rel: &[String]) -> ApiResult<PathBuf> {
        if rel.is_empty() {
            return Err(ApiError::bad("That is the folder itself"));
        }
        self.real(rel)
    }
}

// ---- the files API ----

/// One file operation, `op`, in `space`.
pub async fn fs(state: &AppState, space: Space, op: &str, req: Request) -> Response {
    let result = async {
        let store = Store::open(state, space)?;
        let method = req.method().clone();
        match (method, op) {
            (Method::GET, "list") => list(&store, query(&req)?).await,
            (Method::GET | Method::HEAD, "file") => download(&store, req).await,
            (Method::POST, "folder") => folder(&store, body(req).await?).await,
            (Method::POST, "rename") => rename(&store, body(req).await?).await,
            (Method::POST, "move") => relocate(&store, body(req).await?).await,
            (Method::POST, "delete") => delete(&store, body(req).await?).await,
            (Method::PUT, "upload") => upload(&store, req).await,
            (Method::GET | Method::HEAD, "thumb") => thumb(&store, req).await,
            (Method::PUT, "thumb") => save_thumb(&store, req).await,
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
    /// Unix seconds; 0 when unknown.
    modified: i64,
}

async fn list(store: &Store, at: At) -> ApiResult<Response> {
    let rel = segments(&at.path)?;
    let dir = store.real(&rel)?;
    let mut entries = Vec::new();
    let mut read = tokio::fs::read_dir(&dir).await.map_err(io_error)?;
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
        // The collection's own workings, such as its previews, stay out of sight.
        if name.starts_with('.') {
            continue;
        }
        entries.push(Entry {
            dir: meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len() },
            modified,
            name,
        });
    }
    Ok(Json(json!({
        "path": joined(&rel),
        "access": "write",
        "entries": entries,
        "space": space(&dir),
        "user": null,
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

async fn download(store: &Store, req: Request) -> ApiResult<Response> {
    let at: FileAt = query(&req)?;
    let rel = segments(&at.path)?;
    let real = store.real(&rel)?;
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
pub fn encode(name: &str) -> String {
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

async fn folder(store: &Store, at: At) -> ApiResult<Response> {
    let rel = segments(&at.path)?;
    if rel.is_empty() {
        return Err(ApiError::bad("Name the new folder"));
    }
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

async fn rename(store: &Store, body: Rename) -> ApiResult<Response> {
    let rel = segments(&body.path)?;
    let name = body.name.trim();
    let new = segments(name)?;
    if new.len() != 1 {
        return Err(ApiError::bad("A name cannot hold a slash"));
    }
    let from = store.item(&rel)?;
    let mut target = parent(&rel).to_vec();
    target.push(new[0].clone());
    let to = store.item(&target)?;
    if !from.is_dir() {
        store.space.takes(name)?;
    }
    // Only the case changing is the same file on Windows and macOS.
    let same = rel.last().is_some_and(|old| old.eq_ignore_ascii_case(name));
    if !same && tokio::fs::symlink_metadata(&to).await.is_ok() {
        return Err(ApiError::conflict(format!("{name} already exists")));
    }
    tokio::fs::rename(&from, &to).await.map_err(io_error)?;
    if let (Some(old), Some(new)) = (store.thumb(&rel), store.thumb(&target)) {
        if let Some(dir) = new.parent() {
            let _ = tokio::fs::create_dir_all(dir).await;
        }
        let _ = tokio::fs::rename(old, new).await;
    }
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
async fn relocate(store: &Store, body: Relocate) -> ApiResult<Response> {
    let to = segments(&body.to)?;
    let dest = store.real(&to)?;
    if !dest.is_dir() {
        return Err(ApiError::bad("Pick a folder to put them in"));
    }
    let mut done = 0;
    for path in &body.paths {
        let rel = segments(path)?;
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

async fn delete(store: &Store, body: Paths) -> ApiResult<Response> {
    let mut targets = Vec::new();
    let mut thumbs = Vec::new();
    for path in &body.paths {
        let rel = segments(path)?;
        targets.push(store.item(&rel)?);
        thumbs.extend(store.thumb(&rel));
    }
    for thumb in thumbs {
        let _ = tokio::fs::remove_file(thumb).await;
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
    /// The file to make, under the collection's folder; folders on the way are made.
    path: String,
    /// The page's name for this upload, the same for each of its pieces.
    id: String,
    offset: u64,
    total: u64,
    /// Replace a file of the same name.
    #[serde(default)]
    replace: bool,
    /// When the file was last changed where it came from, in Unix seconds, so a
    /// photo keeps its date.
    modified: Option<u64>,
}

/// One piece of a file being uploaded, at `offset`. The file appears, under its
/// name, once the last piece is in.
async fn upload(store: &Store, req: Request) -> ApiResult<Response> {
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
    store.space.takes(&rel[rel.len() - 1])?;
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
    if let Some(at) = piece.modified {
        let at = std::time::UNIX_EPOCH + std::time::Duration::from_secs(at);
        if let Ok(file) = std::fs::File::options().write(true).open(&target) {
            let _ = file.set_modified(at);
        }
    }
    Ok(Json(json!({ "received": received, "done": true, "path": joined(&rel) })).into_response())
}

/// The most a preview may weigh; the page makes them a few dozen KB.
const MAX_THUMB: usize = 2 * 1024 * 1024;

/// A photo's or video's preview, made by the page that uploaded it.
async fn thumb(store: &Store, req: Request) -> ApiResult<Response> {
    let at: At = query(&req)?;
    let path = store
        .thumb(&segments(&at.path)?)
        .ok_or_else(ApiError::not_found)?;
    let mut response = ServeFile::new(&path)
        .try_call(req)
        .await
        .map_err(io_error)?
        .map(Body::new);
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-cache"),
    );
    Ok(response)
}

async fn save_thumb(store: &Store, req: Request) -> ApiResult<Response> {
    let at: At = query(&req)?;
    let rel = segments(&at.path)?;
    if !store.real(&rel)?.is_file() {
        return Err(ApiError::not_found());
    }
    let path = store.thumb(&rel).ok_or_else(ApiError::not_found)?;
    let bytes = axum::body::to_bytes(req.into_body(), MAX_THUMB)
        .await
        .map_err(|_| ApiError(StatusCode::PAYLOAD_TOO_LARGE, "Too much at once".into()))?;
    if !bytes.starts_with(&[0xFF, 0xD8]) {
        return Err(ApiError::bad("A preview is a JPEG"));
    }
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir).await.map_err(io_error)?;
    }
    tokio::fs::write(&path, &bytes).await.map_err(io_error)?;
    Ok(Json(json!({ "ok": true })).into_response())
}

pub fn io_error(err: std::io::Error) -> ApiError {
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
    fn collections_keep_their_own_kinds() {
        assert!(Space::Media.takes("IMG_0001.HEIC").is_ok());
        assert!(Space::Media.takes("clip.mp4").is_ok());
        assert!(Space::Media.takes("notes.docx").is_err());
        assert!(Space::Drive.takes("Budget.xlsx").is_ok());
        assert!(Space::Drive.takes("deck.pptx").is_ok());
        assert!(Space::Drive.takes("setup.exe").is_err());
        assert!(Space::Drive.takes("README").is_err());
    }
}
