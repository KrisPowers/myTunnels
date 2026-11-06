//! Convert: a new copy of a photo, video or PDF kept in Media or Drive, in
//! another format or smaller, saved beside the original. Jobs wait in a queue
//! and run one at a time, at low priority, so a long video never starves the
//! gateway.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use axum::extract::{Path as UrlPath, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Notify;
use tokio::task::AbortHandle;

use crate::permissions::Caller;
use crate::state::AppState;
use crate::storage::{io_error, segments, Space, Store};
use crate::util::{lock, now, random_hex, ApiError, ApiResult};

/// Finished jobs kept for the page, oldest dropped first.
const KEEP: usize = 200;

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Photo,
    Video,
    Pdf,
}

const PHOTOS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "avif", "heic", "heif", "tif", "tiff",
];
const VIDEOS: &[&str] = &[
    "mp4", "mov", "m4v", "webm", "mkv", "avi", "3gp", "mts", "m2ts", "wmv",
];
/// Read by libheif rather than ImageMagick.
const HEIF: &[&str] = &["heic", "heif", "avif"];

/// Removing a photo's background: its subject on a transparent PNG, or on
/// white as a JPEG. Offered beside a photo's formats, and made with rembg.
const CUTOUTS: [&str; 2] = ["cutout", "cutout-white"];

/// The longest each kind of job may run before it is stopped.
const PHOTO_LIMIT: Duration = Duration::from_secs(5 * 60);
const CUTOUT_LIMIT: Duration = Duration::from_secs(15 * 60);
const PDF_LIMIT: Duration = Duration::from_secs(15 * 60);
const VIDEO_LIMIT: Duration = Duration::from_secs(12 * 3600);

/// ImageMagick's decoder for a photo's ending. Naming it stops ImageMagick
/// guessing from the bytes, so a file named `.jpg` is only ever read as a JPEG.
fn coder(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "jpg" | "jpeg" => "jpeg",
        "png" => "png",
        "gif" => "gif",
        "webp" => "webp",
        "bmp" => "bmp",
        "tif" | "tiff" => "tiff",
        _ => return None,
    })
}

fn ext_of(name: &str) -> String {
    name.rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default()
}

fn kind_of(name: &str) -> Option<Kind> {
    let ext = ext_of(name);
    if PHOTOS.contains(&ext.as_str()) {
        Some(Kind::Photo)
    } else if VIDEOS.contains(&ext.as_str()) {
        Some(Kind::Video)
    } else if ext == "pdf" {
        Some(Kind::Pdf)
    } else {
        None
    }
}

impl Kind {
    /// The formats it can become.
    fn formats(self) -> &'static [&'static str] {
        match self {
            Kind::Photo => &["jpg", "webp"],
            Kind::Video => &["mp4"],
            Kind::Pdf => &["pdf"],
        }
    }

    /// The sizes it can be made, 0 for as it is: a photo's longest side, a
    /// video's shortest, in pixels.
    fn sizes(self) -> &'static [u32] {
        match self {
            Kind::Photo => &[0, 3840, 2560, 1920, 1280],
            Kind::Video => &[0, 2160, 1080, 720, 480],
            Kind::Pdf => &[0],
        }
    }
}

#[derive(Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Quality {
    High,
    Medium,
    Small,
}

#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Phase {
    Waiting,
    Running,
    Done,
    Failed,
}

/// What one job makes.
#[derive(Clone)]
struct Work {
    id: String,
    space: Space,
    source: String,
    kind: Kind,
    to: &'static str,
    size: u32,
    quality: Quality,
}

struct Job {
    work: Work,
    owner: String,
    phase: Phase,
    /// How far along, 0 to 1, for videos.
    progress: f32,
    created: i64,
    source_size: u64,
    output: Option<String>,
    output_size: u64,
    error: Option<String>,
    abort: Option<AbortHandle>,
}

impl Job {
    fn view(&self) -> Value {
        json!({
            "id": self.work.id,
            "space": space_name(self.work.space),
            "source": self.work.source,
            "kind": self.work.kind,
            "to": self.work.to,
            "size": self.work.size,
            "quality": self.work.quality,
            "state": self.phase,
            "progress": self.progress,
            "created": self.created,
            "source_size": self.source_size,
            "output": self.output,
            "output_size": self.output_size,
            "error": self.error,
        })
    }
}

static JOBS: LazyLock<Mutex<Vec<Job>>> = LazyLock::new(|| Mutex::new(Vec::new()));
static WAKE: LazyLock<Arc<Notify>> = LazyLock::new(|| Arc::new(Notify::new()));

fn space_name(space: Space) -> &'static str {
    match space {
        Space::Media => "media",
        Space::Drive => "drive",
    }
}

/// Whether the caller may read a collection and add to it.
fn may(caller: &Caller, space: Space) -> bool {
    match space {
        Space::Media => caller.can("media.view") && caller.can("media.upload"),
        Space::Drive => caller.can("drive.view") && caller.can("drive.edit"),
    }
}

// ---- the API ----

/// The caller's jobs, newest first, and what each kind can become.
pub async fn list(Extension(caller): Extension<Caller>) -> Json<Value> {
    let jobs: Vec<Value> = lock(&JOBS)
        .iter()
        .rev()
        .filter(|j| j.owner == caller.id())
        .map(Job::view)
        .collect();
    let kinds: Vec<Value> = [Kind::Photo, Kind::Video, Kind::Pdf]
        .iter()
        .map(|k| {
            let cutouts: &[&str] = if *k == Kind::Photo { &CUTOUTS } else { &[] };
            json!({ "kind": k, "formats": k.formats(), "sizes": k.sizes(), "cutouts": cutouts })
        })
        .collect();
    Json(json!({ "jobs": jobs, "kinds": kinds }))
}

#[derive(Deserialize)]
pub struct Order {
    space: String,
    paths: Vec<String>,
    to: String,
    #[serde(default)]
    size: u32,
    quality: Quality,
}

/// Queues a job for each file.
pub async fn start(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Json(order): Json<Order>,
) -> ApiResult<Json<Value>> {
    let space = match order.space.as_str() {
        "media" => Space::Media,
        "drive" => Space::Drive,
        _ => return Err(ApiError::bad("Pick Media or Drive")),
    };
    if !may(&caller, space) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Your account cannot add to that".into(),
        ));
    }
    if order.paths.is_empty() || order.paths.len() > 500 {
        return Err(ApiError::bad("Pick between 1 and 500 files"));
    }
    let store = Store::open(&state, space)?;
    let mut queued = Vec::new();
    for path in &order.paths {
        let rel = segments(path)?;
        let name = rel.last().ok_or_else(|| ApiError::bad("Pick a file"))?;
        let kind =
            kind_of(name).ok_or_else(|| ApiError::bad(format!("{name} cannot be converted")))?;
        let cutouts: &[&'static str] = if kind == Kind::Photo { &CUTOUTS } else { &[] };
        let to = kind
            .formats()
            .iter()
            .chain(cutouts)
            .copied()
            .find(|f| *f == order.to)
            .ok_or_else(|| ApiError::bad(format!("{name} cannot become {}", order.to)))?;
        if !kind.sizes().contains(&order.size) {
            return Err(ApiError::bad("That size is not offered"));
        }
        let real = store.real(&rel)?;
        let meta = std::fs::metadata(&real).map_err(io_error)?;
        if !meta.is_file() {
            return Err(ApiError::bad(format!("{name} is not a file")));
        }
        queued.push(Job {
            work: Work {
                id: random_hex(8),
                space,
                source: rel.join("/"),
                kind,
                to,
                size: order.size,
                quality: order.quality,
            },
            owner: caller.id().to_owned(),
            phase: Phase::Waiting,
            progress: 0.0,
            created: now(),
            source_size: meta.len(),
            output: None,
            output_size: 0,
            error: None,
            abort: None,
        });
    }
    let count = queued.len();
    lock(&JOBS).extend(queued);
    WAKE.notify_one();
    Ok(Json(json!({ "queued": count })))
}

/// Cancels a job that has not finished, or clears one that has.
pub async fn remove(
    Extension(caller): Extension<Caller>,
    UrlPath(id): UrlPath<String>,
) -> ApiResult<Json<Value>> {
    let mut jobs = lock(&JOBS);
    let at = jobs
        .iter()
        .position(|j| j.work.id == id && j.owner == caller.id())
        .ok_or_else(ApiError::not_found)?;
    let job = jobs.remove(at);
    if let Some(abort) = job.abort {
        abort.abort();
    }
    Ok(Json(json!({ "ok": true })))
}

// ---- the queue ----

/// Runs queued jobs, one at a time, for as long as the server runs.
pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        loop {
            let next = {
                let mut jobs = lock(&JOBS);
                jobs.iter_mut()
                    .find(|j| j.phase == Phase::Waiting)
                    .map(|j| {
                        j.phase = Phase::Running;
                        j.work.clone()
                    })
            };
            let Some(work) = next else {
                WAKE.notified().await;
                continue;
            };
            let task = tokio::spawn(run(state.clone(), work.clone()));
            set(&work.id, |j| j.abort = Some(task.abort_handle()));
            let result = task.await;
            if !matches!(result, Ok(Ok(_))) {
                clean(&state, &work).await;
            }
            set(&work.id, |j| {
                j.abort = None;
                match result {
                    Ok(Ok((output, size))) => {
                        j.phase = Phase::Done;
                        j.progress = 1.0;
                        j.output = Some(output);
                        j.output_size = size;
                    }
                    Ok(Err(e)) => {
                        j.phase = Phase::Failed;
                        j.error = Some(e.1);
                    }
                    Err(_) => {
                        j.phase = Phase::Failed;
                        j.error = Some("Stopped".into());
                    }
                }
            });
            trim();
        }
    });
}

/// Changes a job, if it is still listed.
fn set(id: &str, change: impl FnOnce(&mut Job)) {
    if let Some(job) = lock(&JOBS).iter_mut().find(|j| j.work.id == id) {
        change(job);
    }
}

fn trim() {
    let mut jobs = lock(&JOBS);
    let finished = jobs
        .iter()
        .filter(|j| matches!(j.phase, Phase::Done | Phase::Failed))
        .count();
    let mut extra = finished.saturating_sub(KEEP);
    jobs.retain(|j| {
        if extra > 0 && matches!(j.phase, Phase::Done | Phase::Failed) {
            extra -= 1;
            false
        } else {
            true
        }
    });
}

/// Where a job writes as it works: hidden, beside the original.
fn temp(dir: &Path, work: &Work) -> PathBuf {
    dir.join(format!(".{}.convert.{}", work.id, work.to))
}

fn heif_temp(dir: &Path, work: &Work) -> PathBuf {
    dir.join(format!(".{}.convert.png", work.id))
}

fn cutout_temp(dir: &Path, work: &Work) -> PathBuf {
    dir.join(format!(".{}.cutout.png", work.id))
}

/// The ending a job's copy gets, and what is added to its name.
fn naming(to: &str) -> (&str, &str) {
    match to {
        "cutout" => ("png", " (no background)"),
        "cutout-white" => ("jpg", " (white background)"),
        other => (other, ""),
    }
}

/// Removes what a job that did not finish left behind.
async fn clean(state: &AppState, work: &Work) {
    let Ok(store) = Store::open(state, work.space) else {
        return;
    };
    let Ok(rel) = segments(&work.source) else {
        return;
    };
    if let Some(dir) = store
        .real(&rel)
        .ok()
        .and_then(|p| p.parent().map(Path::to_owned))
    {
        let _ = tokio::fs::remove_file(temp(&dir, work)).await;
        let _ = tokio::fs::remove_file(heif_temp(&dir, work)).await;
    }
}

/// Makes the copy and gives it its name beside the original: its path in the
/// collection and its size.
async fn run(state: AppState, work: Work) -> ApiResult<(String, u64)> {
    let store = Store::open(&state, work.space)?;
    let rel = segments(&work.source)?;
    let source = std::fs::canonicalize(store.real(&rel)?).map_err(io_error)?;
    let dir = source.parent().ok_or_else(ApiError::not_found)?.to_owned();
    let out = temp(&dir, &work);
    match work.kind {
        Kind::Photo => photo(&source, &out, &dir, &work).await?,
        Kind::Video => video(&source, &out, &work).await?,
        Kind::Pdf => pdf(&source, &out, &work).await?,
    }

    // "clip.mov" becomes "clip.mp4", or "clip (2).mp4" when that is taken.
    let name = &rel[rel.len() - 1];
    let (ext, added) = naming(work.to);
    let stem = format!(
        "{}{added}",
        name.rsplit_once('.').map_or(name.as_str(), |(s, _)| s)
    );
    let mut n = 1;
    let (target, path) = loop {
        let file = if n == 1 {
            format!("{stem}.{ext}")
        } else {
            format!("{stem} ({n}).{ext}")
        };
        let mut path = rel[..rel.len() - 1].to_vec();
        path.push(file.clone());
        let target = dir.join(&file);
        if tokio::fs::symlink_metadata(&target).await.is_err() {
            break (target, path);
        }
        n += 1;
    };
    store.space.takes(&path[path.len() - 1])?;
    tokio::fs::rename(&out, &target).await.map_err(io_error)?;

    // The copy keeps the original's date, and in Media its preview.
    let meta = std::fs::metadata(&source).map_err(io_error)?;
    if let Ok(modified) = meta.modified() {
        if let Ok(file) = std::fs::File::options().write(true).open(&target) {
            let _ = file.set_modified(modified);
        }
    }
    // A cut-out shows itself; the original's preview still has its background.
    let thumbs = if CUTOUTS.contains(&work.to) {
        None
    } else {
        store.thumb(&rel).zip(store.thumb(&path))
    };
    if let Some((from, to)) = thumbs {
        if let Some(parent) = to.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        let _ = tokio::fs::copy(from, to).await;
    }
    let size = std::fs::metadata(&target).map_or(0, |m| m.len());
    Ok((path.join("/"), size))
}

/// A program at low priority, killed if the job is stopped.
fn program(name: &str) -> Command {
    #[cfg(unix)]
    let mut cmd = {
        let mut cmd = Command::new("nice");
        cmd.args(["-n", "15", name]);
        cmd
    };
    #[cfg(not(unix))]
    let mut cmd = Command::new(name);
    cmd.kill_on_drop(true).stdin(Stdio::null());
    cmd
}

/// Runs a program to the end, turning a failure into what it said. One that
/// runs past `limit` is killed.
async fn exec(name: &str, mut cmd: Command, limit: Duration) -> ApiResult<()> {
    let run = cmd.stdout(Stdio::null()).stderr(Stdio::piped()).output();
    let out = tokio::time::timeout(limit, run)
        .await
        .map_err(|_| too_long(name))?
        .map_err(|e| missing(name, e))?;
    if out.status.success() {
        return Ok(());
    }
    if out.status.code() == Some(127) {
        return Err(not_installed(name));
    }
    Err(failed(name, &String::from_utf8_lossy(&out.stderr)))
}

fn missing(name: &str, err: std::io::Error) -> ApiError {
    if err.kind() == std::io::ErrorKind::NotFound {
        not_installed(name)
    } else {
        ApiError::from(err)
    }
}

fn too_long(name: &str) -> ApiError {
    ApiError(
        StatusCode::INTERNAL_SERVER_ERROR,
        format!("{name} took too long and was stopped"),
    )
}

fn not_installed(name: &str) -> ApiError {
    ApiError(
        StatusCode::SERVICE_UNAVAILABLE,
        format!("{name} is not installed on this host"),
    )
}

/// The last thing a program said, as the reason it failed.
fn failed(name: &str, said: &str) -> ApiError {
    let last = said
        .lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty())
        .unwrap_or("it stopped without saying why");
    ApiError(
        StatusCode::INTERNAL_SERVER_ERROR,
        format!("{name} could not convert it: {last}"),
    )
}

async fn photo(source: &Path, out: &Path, dir: &Path, work: &Work) -> ApiResult<()> {
    let quality = match work.quality {
        Quality::High => "92",
        Quality::Medium => "82",
        Quality::Small => "68",
    };
    let mut input = source.to_owned();
    if HEIF.contains(&ext_of(&source.to_string_lossy()).as_str()) {
        // libheif writes a JPEG itself, keeping the photo's details, when
        // nothing else changes.
        if work.to == "jpg" && work.size == 0 {
            let mut cmd = program("heif-convert");
            cmd.arg("-q").arg(quality).arg(source).arg(out);
            return exec("heif-convert", cmd, PHOTO_LIMIT).await;
        }
        let png = heif_temp(dir, work);
        let mut cmd = program("heif-convert");
        cmd.arg(source).arg(&png);
        exec("heif-convert", cmd, PHOTO_LIMIT).await?;
        input = png;
    }
    if CUTOUTS.contains(&work.to) {
        let result = cutout(&input, out, dir, work, quality).await;
        if input != source {
            let _ = tokio::fs::remove_file(&input).await;
        }
        return result;
    }
    let (Some(from), Some(to)) = (coder(&ext_of(&input.to_string_lossy())), coder(work.to)) else {
        return Err(ApiError::bad("This kind of photo cannot be converted"));
    };
    let mut cmd = program("convert");
    // Read with the decoder its ending names, and only the first frame of an
    // animation or a multi-page TIFF.
    let mut first = std::ffi::OsString::from(format!("{from}:"));
    first.push(&input);
    first.push("[0]");
    cmd.arg(first).arg("-auto-orient");
    if work.size > 0 {
        cmd.arg("-resize").arg(format!("{0}x{0}>", work.size));
    }
    let mut target = std::ffi::OsString::from(format!("{to}:"));
    target.push(out);
    cmd.arg("-quality").arg(quality).arg(target);
    let result = exec("ImageMagick", cmd, PHOTO_LIMIT).await;
    if input != source {
        let _ = tokio::fs::remove_file(&input).await;
    }
    result
}

/// Cuts the subject out of a photo with rembg, then sizes it and puts it on a
/// transparent PNG, or on white as a JPEG.
async fn cutout(input: &Path, out: &Path, dir: &Path, work: &Work, quality: &str) -> ApiResult<()> {
    let cut = cutout_temp(dir, work);
    let mut cmd = program("cutout");
    cmd.arg(input).arg(&cut);
    let made = exec("Remove background", cmd, CUTOUT_LIMIT).await;
    if made.is_err() {
        let _ = tokio::fs::remove_file(&cut).await;
        return made;
    }
    let mut source = std::ffi::OsString::from("png:");
    source.push(&cut);
    let mut cmd = program("convert");
    cmd.arg(source);
    if work.size > 0 {
        cmd.arg("-resize").arg(format!("{0}x{0}>", work.size));
    }
    let mut target = if work.to == "cutout-white" {
        cmd.args(["-background", "white", "-alpha", "remove", "-alpha", "off"]);
        cmd.arg("-quality").arg(quality);
        std::ffi::OsString::from("jpeg:")
    } else {
        std::ffi::OsString::from("png:")
    };
    target.push(out);
    cmd.arg(target);
    let result = exec("ImageMagick", cmd, PHOTO_LIMIT).await;
    let _ = tokio::fs::remove_file(&cut).await;
    result
}

async fn video(source: &Path, out: &Path, work: &Work) -> ApiResult<()> {
    let duration = duration(source).await.unwrap_or(0.0);
    let crf = match work.quality {
        Quality::High => "20",
        Quality::Medium => "23",
        Quality::Small => "28",
    };
    // The short side no bigger than asked, both sides even as H.264 needs.
    let s = if work.size == 0 { 100_000 } else { work.size };
    let scale = format!(
        "scale='if(gte(iw,ih),-2,trunc(min({s},iw)/2)*2)':'if(gte(iw,ih),trunc(min({s},ih)/2)*2,-2)'"
    );
    let mut cmd = program("ffmpeg");
    cmd.args(["-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-i"])
        .arg(source)
        .args(["-map", "0:v:0", "-map", "0:a:0?", "-map_metadata", "0"])
        .args(["-vf", &scale])
        .args([
            "-c:v", "libx264", "-preset", "fast", "-crf", crf, "-pix_fmt", "yuv420p",
        ])
        .args(["-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart"])
        .args(["-progress", "pipe:1", "-nostats"])
        .arg(out)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| missing("ffmpeg", e))?;
    let mut stderr = child.stderr.take().ok_or_else(ApiError::not_found)?;
    let said = tokio::spawn(async move {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text).await;
        text
    });
    let stdout = child.stdout.take();
    let follow = async {
        if let Some(stdout) = stdout {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let at = line
                    .strip_prefix("out_time_us=")
                    .and_then(|v| v.parse::<f64>().ok());
                if let (Some(us), true) = (at, duration > 0.0) {
                    let done = (us / 1_000_000.0 / duration).clamp(0.0, 0.99) as f32;
                    set(&work.id, |j| j.progress = done);
                }
            }
        }
        child.wait().await
    };
    let status = match tokio::time::timeout(VIDEO_LIMIT, follow).await {
        Ok(status) => status.map_err(ApiError::from)?,
        Err(_) => {
            let _ = child.kill().await;
            return Err(too_long("ffmpeg"));
        }
    };
    let said = said.await.unwrap_or_default();
    if status.success() {
        Ok(())
    } else if status.code() == Some(127) {
        Err(not_installed("ffmpeg"))
    } else {
        Err(failed("ffmpeg", &said))
    }
}

/// A video's length in seconds.
async fn duration(source: &Path) -> Option<f64> {
    let out = program("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=nw=1:nk=1",
        ])
        .arg(source)
        .stderr(Stdio::null())
        .output()
        .await
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

async fn pdf(source: &Path, out: &Path, work: &Work) -> ApiResult<()> {
    let settings = match work.quality {
        Quality::High => "-dPDFSETTINGS=/printer",
        Quality::Medium => "-dPDFSETTINGS=/ebook",
        Quality::Small => "-dPDFSETTINGS=/screen",
    };
    let mut target = std::ffi::OsString::from("-sOutputFile=");
    target.push(out);
    let mut cmd = program("gs");
    cmd.args([
        "-q",
        "-dNOPAUSE",
        "-dBATCH",
        "-dSAFER",
        "-sDEVICE=pdfwrite",
        "-dCompatibilityLevel=1.5",
        settings,
    ])
    .arg(target)
    .arg(source);
    exec("Ghostscript", cmd, PDF_LIMIT).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_by_ending() {
        assert_eq!(kind_of("IMG_0001.HEIC"), Some(Kind::Photo));
        assert_eq!(kind_of("clip.MOV"), Some(Kind::Video));
        assert_eq!(kind_of("scan.pdf"), Some(Kind::Pdf));
        assert!(kind_of("notes.docx").is_none());
        assert!(kind_of("README").is_none());
    }

    #[test]
    fn each_kind_offers_as_it_is() {
        for kind in [Kind::Photo, Kind::Video, Kind::Pdf] {
            assert_eq!(kind.sizes()[0], 0);
            assert!(!kind.formats().is_empty());
        }
    }

    #[test]
    fn cut_outs_are_named_for_what_they_are() {
        assert_eq!(naming("cutout"), ("png", " (no background)"));
        assert_eq!(naming("cutout-white"), ("jpg", " (white background)"));
        assert_eq!(naming("webp"), ("webp", ""));
    }
}
