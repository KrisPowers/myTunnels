//! Containers built from a repository: a repository on this host's Git or at
//! any https address (GitHub and the like), one of its branches, and how it
//! updates. Each update builds the branch's latest commit into an image tagged
//! with the build's number, then makes the container again from it, its kept
//! folders and environment carried over. A build that will not start is undone
//! on the spot, and any earlier build whose image is still kept can be run
//! again.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use axum::extract::{Path as UrlPath, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use hyper::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::AsyncReadExt;
use tokio::sync::{Mutex as AsyncMutex, Notify};

use crate::code::{self, Level, Viewer};
use crate::docker::{self, Endpoint};
use crate::permissions::Caller;
use crate::state::AppState;
use crate::util::{now, random_hex, ApiError, ApiResult};

/// Images of the latest builds kept for going back to; older ones are deleted.
const KEEP_IMAGES: usize = 10;
/// The most of a build's log kept.
const MAX_LOG: usize = 2 * 1024 * 1024;
const ACTION_WAIT: Duration = Duration::from_secs(40);
/// How long a new container must keep running to count as started.
const SETTLE: Duration = Duration::from_secs(4);
/// The shortest wait between checks of a repository at another address.
const REMOTE_EVERY: i64 = 60;

#[derive(Clone, Serialize)]
pub struct Deploy {
    pub id: String,
    /// The container's name, and its images' name.
    pub name: String,
    /// A repository on this host's Git, or empty for one at `url`.
    pub repo: String,
    /// An https address to clone from, or empty for a repository here.
    pub url: String,
    pub branch: String,
    /// The Dockerfile's path in the repository; empty to find it.
    pub dockerfile: String,
    /// The port the app listens on; 0 for the one its image exposes.
    pub port: u16,
    /// Folders in the container kept from one build to the next, besides the
    /// ones its image declares.
    pub keep: Vec<String>,
    /// "push", "timer" or "manual".
    pub updates: String,
    /// For "timer", the seconds between checks.
    pub every: i64,
    /// The build the container runs.
    pub current: Option<i64>,
    pub checked_at: i64,
    pub created_at: i64,
}

#[derive(Clone, Serialize)]
pub struct Build {
    pub deploy_id: String,
    pub number: i64,
    /// Empty until the build looks the branch up.
    pub commit: String,
    pub message: String,
    /// "first", "push", "timer" or "manual".
    pub reason: String,
    /// "queued", "building", "ready" or "failed".
    pub status: String,
    pub image: Option<String>,
    pub error: Option<String>,
    pub queued_at: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
}

static WAKE: LazyLock<Arc<Notify>> = LazyLock::new(|| Arc::new(Notify::new()));
/// One container is made again at a time.
static ROLLOUT: LazyLock<AsyncMutex<()>> = LazyLock::new(|| AsyncMutex::new(()));

pub fn spawn(state: AppState) {
    tokio::spawn(worker(state.clone()));
    tokio::spawn(watch(state));
}

fn token_key(id: &str) -> String {
    format!("deploy_token:{id}")
}

fn env_key(id: &str) -> String {
    format!("deploy_env:{id}")
}

fn token_of(state: &AppState, id: &str) -> Option<String> {
    state.db.setting(&token_key(id)).ok().flatten()
}

fn env_of(state: &AppState, id: &str) -> Vec<String> {
    state
        .db
        .setting(&env_key(id))
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_default()
}

// ---- checks ----

/// A container's name as images take it too: lowercase letters, digits, `.`,
/// `_` and `-`, a letter or digit first.
fn valid_name(name: &str) -> bool {
    (1..=63).contains(&name.len())
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
}

/// An https address git can clone, nothing it could take for an option.
fn valid_url(url: &str) -> bool {
    url.starts_with("https://")
        && url.len() <= 500
        && url.len() > "https://".len()
        && !url
            .bytes()
            .any(|b| b.is_ascii_whitespace() || b.is_ascii_control())
}

/// A Dockerfile's path inside the repository.
fn valid_file(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 300
        && !path.starts_with(['/', '-', '.'])
        && !path.contains("..")
        && path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-/".contains(&b))
}

/// A folder inside the container.
fn valid_folder(path: &str) -> bool {
    path.starts_with('/')
        && path.len() > 1
        && path.len() <= 300
        && !path.contains("..")
        && !path.contains(':')
        && !path
            .bytes()
            .any(|b| b.is_ascii_whitespace() || b.is_ascii_control())
}

/// The volume that keeps `folder` for container `name`: `web_data` for `/data`.
fn volume_of(name: &str, folder: &str) -> String {
    let slug: String = folder
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    format!("{name}_{}", slug.trim_matches('_'))
}

// ---- git ----

/// Git's settings for an address that needs a token: it is sent as the
/// password, and git never stops to ask for one.
fn auth_env(token: Option<&str>) -> Vec<(String, String)> {
    let mut env = vec![("GIT_TERMINAL_PROMPT".to_owned(), "0".to_owned())];
    if let Some(token) = token.filter(|t| !t.is_empty()) {
        let basic = B64.encode(format!("x-access-token:{token}"));
        env.extend([
            ("GIT_CONFIG_COUNT".to_owned(), "2".to_owned()),
            ("GIT_CONFIG_KEY_1".to_owned(), "http.extraHeader".to_owned()),
            (
                "GIT_CONFIG_VALUE_1".to_owned(),
                format!("Authorization: Basic {basic}"),
            ),
        ]);
    }
    env
}

async fn git_auth(dir: &Path, args: &[&str], token: Option<&str>) -> ApiResult<Vec<u8>> {
    let env = auth_env(token);
    let env: Vec<(&str, &str)> = env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    code::git_with(dir, args, &env).await
}

/// What `git ls-remote` says of `url`, run outside any repository.
async fn ls_remote(
    state: &AppState,
    url: &str,
    token: Option<&str>,
    refs: &[&str],
) -> ApiResult<String> {
    let out = tokio::time::timeout(
        Duration::from_secs(30),
        tokio::process::Command::new("git")
            .arg("ls-remote")
            .arg("--symref")
            .arg(url)
            .args(refs)
            .current_dir(&state.config.data_dir)
            .envs(code::safe_env())
            .envs(auth_env(token))
            .stdin(Stdio::null())
            .output(),
    )
    .await
    .map_err(|_| ApiError::bad(format!("{url} did not answer")))?
    .map_err(|e| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("git is not installed: {e}"),
        )
    })?;
    if !out.status.success() {
        let why = code::text(out.stderr);
        let why = why
            .trim()
            .lines()
            .last()
            .unwrap_or("git refused")
            .to_owned();
        return Err(ApiError::bad(format!("Cannot reach the repository: {why}")));
    }
    Ok(code::text(out.stdout))
}

/// A repository's branches and its default, from `ls-remote --symref` output.
fn branches_of_remote(listing: &str) -> (Vec<String>, String) {
    let mut branches = Vec::new();
    let mut default = String::new();
    for line in listing.lines() {
        if let Some(rest) = line.strip_prefix("ref: refs/heads/") {
            if let Some((branch, "HEAD")) = rest.split_once('\t') {
                default = branch.to_owned();
            }
        } else if let Some((_, name)) = line.split_once('\t') {
            if let Some(branch) = name.strip_prefix("refs/heads/") {
                branches.push(branch.to_owned());
            }
        }
    }
    branches.sort();
    (branches, default)
}

async fn branches_of_local(dir: &Path) -> ApiResult<(Vec<String>, String)> {
    let listing = code::text(
        code::git(
            dir,
            &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
        )
        .await?,
    );
    let default = code::git(dir, &["symbolic-ref", "--short", "HEAD"])
        .await
        .map(code::text)
        .unwrap_or_default();
    let mut branches: Vec<String> = listing.lines().map(str::to_owned).collect();
    branches.sort();
    Ok((branches, default.trim().to_owned()))
}

fn local_dir(state: &AppState, repo: &str) -> PathBuf {
    code::root(state).join(format!("{repo}.git"))
}

fn mirror_dir(state: &AppState, id: &str) -> PathBuf {
    state
        .config
        .data_dir
        .join("builds")
        .join(format!("{id}.git"))
}

/// The commit a deploy's branch is at now.
async fn head_of(state: &AppState, d: &Deploy) -> ApiResult<String> {
    let branch = code::checked_ref(&d.branch)?;
    let full = format!("refs/heads/{branch}");
    if d.url.is_empty() {
        let out = code::git(
            &local_dir(state, &d.repo),
            &["rev-parse", "--verify", &full],
        )
        .await?;
        return Ok(code::text(out).trim().to_owned());
    }
    let token = token_of(state, &d.id);
    let listing = ls_remote(state, &d.url, token.as_deref(), &[&full]).await?;
    listing
        .lines()
        .find_map(|l| {
            l.split_once('\t')
                .filter(|(_, r)| *r == full)
                .map(|(s, _)| s.to_owned())
        })
        .ok_or_else(|| ApiError::bad(format!("There is no branch {branch}")))
}

/// The repository to build from: Git's own folder, or a copy of the one at
/// the address, brought up to date with the branch.
async fn source(state: &AppState, d: &Deploy) -> Result<PathBuf, String> {
    let branch = code::checked_ref(&d.branch).map_err(|e| e.1)?;
    if d.url.is_empty() {
        let dir = local_dir(state, &d.repo);
        return if dir.is_dir() {
            Ok(dir)
        } else {
            Err(format!("The repository {} is gone", d.repo))
        };
    }
    let dir = mirror_dir(state, &d.id);
    if !dir.is_dir() {
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|e| e.to_string())?;
        code::git(&dir, &["init", "--bare", "--quiet"])
            .await
            .map_err(|e| e.1)?;
    }
    let spec = format!("+refs/heads/{branch}:refs/heads/{branch}");
    let token = token_of(state, &d.id);
    git_auth(
        &dir,
        &["fetch", "--quiet", "--force", "--no-tags", &d.url, &spec],
        token.as_deref(),
    )
    .await
    .map_err(|e| format!("Cannot fetch {}: {}", d.url, e.1))?;
    Ok(dir)
}

/// Where the Dockerfile is: the one asked for, or the one nearest the top.
async fn dockerfile_in(dir: &Path, commit: &str, wanted: &str) -> Result<String, String> {
    let listing = code::git(dir, &["ls-tree", "-r", "--name-only", commit])
        .await
        .map_err(|e| e.1)?;
    let files = code::text(listing);
    if !wanted.is_empty() {
        return if files.lines().any(|f| f == wanted) {
            Ok(wanted.to_owned())
        } else {
            Err(format!("There is no {wanted} in this commit"))
        };
    }
    files
        .lines()
        .filter(|f| {
            f.rsplit('/')
                .next()
                .is_some_and(|n| n.eq_ignore_ascii_case("dockerfile"))
        })
        .min_by_key(|f| (f.matches('/').count(), f.len()))
        .map(str::to_owned)
        .ok_or_else(|| "There is no Dockerfile in this commit".to_owned())
}

// ---- building ----

/// What a build has printed, and what came of it, read from the engine's
/// answer: plain lines from the classic builder, and BuildKit's progress,
/// which comes encoded.
#[derive(Default)]
struct Progress {
    log: String,
    steps: HashMap<String, usize>,
    done: HashSet<String>,
    image: Option<String>,
    error: Option<String>,
}

impl Progress {
    fn push(&mut self, text: &str) {
        self.log.push_str(text);
        if self.log.len() > MAX_LOG {
            let mut cut = self.log.len() - MAX_LOG * 3 / 4;
            while !self.log.is_char_boundary(cut) {
                cut += 1;
            }
            self.log.drain(..cut);
        }
    }

    fn line(&mut self, raw: &[u8]) {
        let Ok(v) = serde_json::from_slice::<Value>(raw) else {
            return;
        };
        if let Some(e) = v["error"].as_str() {
            self.error = Some(e.trim().to_owned());
            self.push(&format!("ERROR: {}\n", e.trim()));
        } else if v["id"] == "moby.buildkit.trace" {
            if let Some(bytes) = v["aux"].as_str().and_then(|a| B64.decode(a).ok()) {
                self.trace(&bytes);
            }
        } else if let Some(id) = v["aux"]["ID"].as_str() {
            self.image = Some(id.to_owned());
        } else if let Some(text) = v["stream"].as_str() {
            self.push(text);
        } else if let Some(status) = v["status"].as_str() {
            // Each layer's download is left out; what it comes to is kept.
            if v.get("id").is_none() {
                self.push(&format!("{status}\n"));
            }
        }
    }

    /// One BuildKit status: steps starting and ending, and what they print.
    fn trace(&mut self, bytes: &[u8]) {
        for (field, value) in fields(bytes) {
            match (field, value) {
                (1, Field::Bytes(vertex)) => self.vertex(vertex),
                (3, Field::Bytes(log)) => {
                    let mut vertex = "";
                    let mut msg: &[u8] = &[];
                    for (f, v) in fields(log) {
                        match (f, v) {
                            (1, Field::Bytes(b)) => vertex = std::str::from_utf8(b).unwrap_or(""),
                            (4, Field::Bytes(b)) => msg = b,
                            _ => {}
                        }
                    }
                    let n = self.step(vertex);
                    let text = String::from_utf8_lossy(msg).into_owned();
                    for line in text.lines() {
                        self.push(&format!("#{n} {line}\n"));
                    }
                }
                _ => {}
            }
        }
    }

    fn step(&mut self, digest: &str) -> usize {
        let next = self.steps.len() + 1;
        *self.steps.entry(digest.to_owned()).or_insert(next)
    }

    fn vertex(&mut self, bytes: &[u8]) {
        let (mut digest, mut name, mut error) = ("", "", "");
        let (mut cached, mut started, mut completed) = (false, false, false);
        for (f, v) in fields(bytes) {
            match (f, v) {
                (1, Field::Bytes(b)) => digest = std::str::from_utf8(b).unwrap_or(""),
                (3, Field::Bytes(b)) => name = std::str::from_utf8(b).unwrap_or(""),
                (4, Field::Int(v)) => cached = v != 0,
                (5, Field::Bytes(_)) => started = true,
                (6, Field::Bytes(_)) => completed = true,
                (7, Field::Bytes(b)) => error = std::str::from_utf8(b).unwrap_or(""),
                _ => {}
            }
        }
        if digest.is_empty() || name.is_empty() {
            return;
        }
        let known = self.steps.contains_key(digest);
        let n = self.step(digest);
        if !known && (started || completed) {
            self.push(&format!("#{n} {name}\n"));
        }
        if completed && self.done.insert(digest.to_owned()) {
            if !error.is_empty() {
                self.push(&format!("#{n} ERROR: {error}\n"));
            } else if cached {
                self.push(&format!("#{n} CACHED\n"));
            } else {
                self.push(&format!("#{n} DONE\n"));
            }
        }
    }
}

enum Field<'a> {
    Int(u64),
    Bytes(&'a [u8]),
}

fn varint(b: &[u8], i: &mut usize) -> Option<u64> {
    let mut value = 0u64;
    let mut shift = 0;
    while let Some(&byte) = b.get(*i) {
        *i += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Some(value);
        }
        shift += 7;
        if shift > 63 {
            return None;
        }
    }
    None
}

/// The fields of one protobuf message, numbers and lengths only; fixed-size
/// fields are passed over.
fn fields(b: &[u8]) -> Vec<(u64, Field<'_>)> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let Some(key) = varint(b, &mut i) else { break };
        match key & 7 {
            0 => match varint(b, &mut i) {
                Some(v) => out.push((key >> 3, Field::Int(v))),
                None => break,
            },
            1 => i += 8,
            2 => {
                let Some(len) = varint(b, &mut i) else { break };
                let Some(end) = i.checked_add(len as usize).filter(|e| *e <= b.len()) else {
                    break;
                };
                out.push((key >> 3, Field::Bytes(&b[i..end])));
                i = end;
            }
            5 => i += 4,
            _ => break,
        }
    }
    out
}

/// Builds one commit of `dir` into an image named `tag`, with BuildKit, or
/// the classic builder where the engine has no BuildKit.
async fn build_image(
    state: &AppState,
    b: &Build,
    dir: &Path,
    dockerfile: &str,
    tag: &str,
) -> Result<String, String> {
    let (folder, file) = match dockerfile.rsplit_once('/') {
        Some((folder, file)) => (folder, file),
        None => ("", dockerfile),
    };
    let tree = if folder.is_empty() {
        b.commit.clone()
    } else {
        format!("{}:{folder}", b.commit)
    };
    let labels = json!({ "deploy.id": b.deploy_id, "deploy.build": b.number.to_string(), "deploy.commit": b.commit });
    let mut last = String::new();
    for version in ["2", "1"] {
        let query = serde_urlencoded::to_string([
            ("t", tag),
            ("dockerfile", file),
            ("version", version),
            ("rm", "1"),
            ("forcerm", "1"),
            ("labels", &labels.to_string()),
        ])
        .map_err(|e| e.to_string())?;
        let mut child = tokio::process::Command::new("git")
            .arg("--git-dir")
            .arg(dir)
            .args(["archive", "--format=tar", &tree])
            .envs(code::safe_env())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("git is not installed: {e}"))?;
        let stdout = child.stdout.take().ok_or("git did not start")?;
        let mut stderr = child.stderr.take().ok_or("git did not start")?;
        let mut progress = Progress::default();
        progress.push(&format!(
            "Building {} at {}\n",
            dockerfile,
            &b.commit[..b.commit.len().min(12)]
        ));
        let mut flushed = Instant::now();
        let result = docker::stream(
            &Endpoint::from_env(),
            &format!("/build?{query}"),
            "application/x-tar",
            docker::read_body(stdout),
            |line| {
                progress.line(line);
                if flushed.elapsed() > Duration::from_secs(1) {
                    flushed = Instant::now();
                    let _ = state
                        .db
                        .set_build_log(&b.deploy_id, b.number, &progress.log);
                }
            },
        )
        .await;
        let mut why = String::new();
        let _ = stderr.read_to_string(&mut why).await;
        let archived = child.wait().await.is_ok_and(|s| s.success());
        let _ = state
            .db
            .set_build_log(&b.deploy_id, b.number, &progress.log);
        match result {
            Err(e) if version == "2" && format!("{e:#}").to_lowercase().contains("buildkit") => {
                last = format!("{e:#}");
                continue;
            }
            Err(e) => return Err(format!("{e:#}")),
            Ok(()) => {}
        }
        if !archived {
            return Err(format!("git could not read the commit: {}", why.trim()));
        }
        if let Some(error) = progress.error {
            return Err(error);
        }
        return progress
            .image
            .ok_or_else(|| "The build ended without an image".to_owned());
    }
    Err(last)
}

async fn worker(state: AppState) {
    if let Err(err) = state.db.end_interrupted_builds(now()) {
        tracing::warn!("could not mark stopped builds: {err:#}");
    }
    loop {
        match state.db.next_build() {
            Ok(Some(b)) => run(&state, b).await,
            Ok(None) => WAKE.notified().await,
            Err(err) => {
                tracing::warn!("could not read builds: {err:#}");
                tokio::time::sleep(Duration::from_secs(30)).await;
            }
        }
    }
}

/// Builds one waiting build, then runs it.
async fn run(state: &AppState, mut b: Build) {
    b.status = "building".into();
    b.started_at = Some(now());
    let _ = state.db.save_build(&b);
    let outcome = match state.db.deploy(&b.deploy_id) {
        Ok(Some(d)) => build_and_run(state, &d, &mut b).await,
        _ => Err("The container is gone".into()),
    };
    b.finished_at = Some(now());
    match outcome {
        Ok(()) => b.status = "ready".into(),
        Err(why) => {
            b.status = "failed".into();
            b.error = Some(why);
        }
    }
    if let Err(err) = state.db.save_build(&b) {
        tracing::warn!("could not save build {}: {err:#}", b.number);
    }
}

async fn build_and_run(state: &AppState, d: &Deploy, b: &mut Build) -> Result<(), String> {
    let dir = source(state, d).await?;
    let wanted = (!b.commit.is_empty())
        .then(|| format!("{}^{{commit}}", b.commit))
        .filter(|_| b.commit.bytes().all(|c| c.is_ascii_hexdigit()));
    let found = match wanted {
        Some(spec) => code::git(&dir, &["rev-parse", "--verify", &spec])
            .await
            .ok(),
        None => None,
    };
    let commit = match found {
        Some(sha) => code::text(sha),
        None => {
            let full = format!("refs/heads/{}^{{commit}}", d.branch);
            code::text(
                code::git(&dir, &["rev-parse", "--verify", &full])
                    .await
                    .map_err(|_| format!("There is no branch {}", d.branch))?,
            )
        }
    };
    b.commit = commit.trim().to_owned();
    b.message = code::git(&dir, &["log", "-1", "--format=%s", &b.commit])
        .await
        .map(|m| code::text(m).trim().to_owned())
        .unwrap_or_default();
    let _ = state.db.save_build(b);
    let dockerfile = dockerfile_in(&dir, &b.commit, &d.dockerfile).await?;
    let image = build_image(
        state,
        b,
        &dir,
        &dockerfile,
        &format!("{}:{}", d.name, b.number),
    )
    .await?;
    b.image = Some(image.clone());
    let _ = state.db.save_build(b);
    roll_out(state, d, &image, b.number)
        .await
        .map_err(|why| format!("Built, but it did not start: {why}"))?;
    prune(state, &d.id).await;
    Ok(())
}

// ---- running ----

/// The network myTunnels' own container is on, so a container made here is
/// reached by its name and needs no port on the host.
async fn own_network(endpoint: &Endpoint) -> Option<String> {
    let host = std::env::var("HOSTNAME").ok()?;
    if host.len() < 12 || !host.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let me = docker::get(endpoint, &format!("/containers/{host}/json"))
        .await
        .ok()?;
    me["NetworkSettings"]["Networks"]
        .as_object()?
        .keys()
        .find(|n| !matches!(n.as_str(), "host" | "none"))
        .cloned()
}

/// How to make the container from `image`: its environment, its kept
/// folders as volumes, and its port, on myTunnels' network or, where
/// myTunnels runs outside a container, on this computer alone.
fn spec_of(
    d: &Deploy,
    env: &[String],
    image: &str,
    config: &Value,
    number: i64,
    network: Option<&str>,
) -> Value {
    let port = if d.port > 0 {
        Some(d.port.to_string())
    } else {
        config["ExposedPorts"]
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(p, _)| p.strip_suffix("/tcp"))
            .filter_map(|p| p.parse::<u16>().ok())
            .min()
            .map(|p| p.to_string())
    };
    let mut folders: Vec<String> = config["Volumes"]
        .as_object()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    for f in &d.keep {
        if !folders.contains(f) {
            folders.push(f.clone());
        }
    }
    let binds: Vec<String> = folders
        .iter()
        .filter(|f| valid_folder(f))
        .map(|f| format!("{}:{f}", volume_of(&d.name, f)))
        .collect();
    let mut host = json!({
        "RestartPolicy": { "Name": "unless-stopped" },
        "Binds": binds,
    });
    let mut spec = json!({
        "Image": image,
        "Env": env,
        "Labels": { "deploy.id": d.id, "deploy.build": number.to_string() },
    });
    if let Some(port) = port {
        let key = format!("{port}/tcp");
        spec["ExposedPorts"] = json!({ &key: {} });
        if network.is_none() {
            host["PortBindings"] = json!({ &key: [{ "HostIp": "127.0.0.1", "HostPort": port }] });
        }
    }
    if let Some(network) = network {
        host["NetworkMode"] = json!(network);
        spec["NetworkingConfig"] = json!({ "EndpointsConfig": { network: {} } });
    }
    spec["HostConfig"] = host;
    spec
}

/// Makes the container and starts it, and says why when it will not run.
async fn start(endpoint: &Endpoint, name: &str, spec: &Value) -> Result<(), String> {
    let err = |e: anyhow::Error| format!("{e:#}");
    docker::call_with(
        endpoint,
        Method::POST,
        &format!("/containers/create?name={name}"),
        Some(spec),
        ACTION_WAIT,
    )
    .await
    .map_err(err)?;
    docker::call(
        endpoint,
        Method::POST,
        &format!("/containers/{name}/start"),
        ACTION_WAIT,
    )
    .await
    .map_err(err)?;
    tokio::time::sleep(SETTLE).await;
    let c = docker::get(endpoint, &format!("/containers/{name}/json"))
        .await
        .map_err(err)?;
    let state = &c["State"];
    if state["Running"] == true && state["Restarting"] != true {
        Ok(())
    } else {
        Err(format!(
            "it stopped straight away, exit code {}",
            state["ExitCode"]
        ))
    }
}

async fn take_down(endpoint: &Endpoint, name: &str) {
    let _ = docker::call(
        endpoint,
        Method::POST,
        &format!("/containers/{name}/stop?t=10"),
        ACTION_WAIT,
    )
    .await;
    let _ = docker::call(
        endpoint,
        Method::DELETE,
        &format!("/containers/{name}?force=true"),
        ACTION_WAIT,
    )
    .await;
}

/// Makes the container again from `image`, build `number`. When it will not
/// run, the one it replaced is made again as it was.
async fn roll_out(state: &AppState, d: &Deploy, image: &str, number: i64) -> Result<(), String> {
    let _one = ROLLOUT.lock().await;
    let endpoint = Endpoint::from_env();
    let err = |e: anyhow::Error| format!("{e:#}");
    let env = env_of(state, &d.id);
    let network = own_network(&endpoint).await;
    let config = docker::get(&endpoint, &format!("/images/{image}/json"))
        .await
        .map_err(err)?;
    let spec = spec_of(
        d,
        &env,
        image,
        &config["Config"],
        number,
        network.as_deref(),
    );
    let old = docker::get(&endpoint, &format!("/containers/{}/json", d.name))
        .await
        .ok();
    if let Some(old) = &old {
        if old["Config"]["Labels"]["deploy.id"] != json!(d.id) {
            return Err(format!("another container is called {}", d.name));
        }
    }
    take_down(&endpoint, &d.name).await;
    match start(&endpoint, &d.name, &spec).await {
        Ok(()) => state
            .db
            .set_current(&d.id, number)
            .map_err(|e| format!("{e:#}")),
        Err(why) => {
            take_down(&endpoint, &d.name).await;
            if let Some(old) = old {
                let image = old["Image"].as_str().unwrap_or_default();
                let before = d.current.unwrap_or(number);
                let back = docker::get(&endpoint, &format!("/images/{image}/json")).await;
                if let Ok(config) = back {
                    let spec = spec_of(
                        d,
                        &env,
                        image,
                        &config["Config"],
                        before,
                        network.as_deref(),
                    );
                    if let Err(again) = start(&endpoint, &d.name, &spec).await {
                        tracing::warn!("could not bring back {}: {again}", d.name);
                    }
                }
            }
            Err(why)
        }
    }
}

/// Deletes the images of all but the latest builds and the one running.
async fn prune(state: &AppState, id: &str) {
    let Ok(Some(d)) = state.db.deploy(id) else {
        return;
    };
    let Ok(builds) = state.db.builds(id, 1000) else {
        return;
    };
    let endpoint = Endpoint::from_env();
    let kept: Vec<&Build> = builds.iter().filter(|b| b.image.is_some()).collect();
    for b in kept.into_iter().skip(KEEP_IMAGES) {
        if Some(b.number) == d.current {
            continue;
        }
        let Some(image) = &b.image else { continue };
        let gone = docker::call(
            &endpoint,
            Method::DELETE,
            &format!("/images/{image}"),
            ACTION_WAIT,
        )
        .await;
        if gone.is_ok() {
            let mut b = b.clone();
            b.image = None;
            let _ = state.db.save_build(&b);
        }
    }
}

// ---- updating on their own ----

fn queue(state: &AppState, id: &str, commit: &str, reason: &str) -> ApiResult<i64> {
    let number = state.db.queue_build(id, commit, reason, now())?;
    WAKE.notify_one();
    Ok(number)
}

/// Looks at each repository that updates on its own, and builds a branch
/// that has moved since its last build.
async fn watch(state: AppState) {
    let mut every = tokio::time::interval(Duration::from_secs(30));
    loop {
        every.tick().await;
        let Ok(deploys) = state.db.deploys() else {
            continue;
        };
        for d in deploys {
            let since = now() - d.checked_at;
            let due = match d.updates.as_str() {
                "push" => d.url.is_empty() || since >= REMOTE_EVERY,
                "timer" => since >= d.every.max(3600),
                _ => false,
            };
            if !due || state.db.has_waiting_build(&d.id).unwrap_or(true) {
                continue;
            }
            let head = head_of(&state, &d).await;
            let _ = state.db.set_checked(&d.id, now());
            let Ok(head) = head else { continue };
            let last = state
                .db
                .builds(&d.id, 1)
                .ok()
                .and_then(|b| b.into_iter().next());
            if last.is_none_or(|b| b.commit != head) {
                let reason = if d.updates == "timer" {
                    "timer"
                } else {
                    "push"
                };
                if let Err(e) = queue(&state, &d.id, &head, reason) {
                    tracing::warn!("could not queue a build of {}: {}", d.name, e.1);
                }
            }
        }
    }
}

// ---- the API ----

fn view(state: &AppState, d: &Deploy, caller: Option<&Caller>) -> ApiResult<Value> {
    let builds = state.db.builds(&d.id, 50)?;
    let running = d
        .current
        .and_then(|n| builds.iter().find(|b| b.number == n))
        .cloned();
    let mut v = json!(d);
    v["token_set"] = json!(token_of(state, &d.id).is_some());
    v["latest"] = json!(builds.first());
    v["running"] = json!(running);
    if let Some(caller) = caller {
        v["builds"] = json!(builds);
        v["env"] = json!(if caller.can("containers.deploy") {
            env_of(state, &d.id)
        } else {
            Vec::new()
        });
    }
    Ok(v)
}

fn find(state: &AppState, id: &str) -> ApiResult<Deploy> {
    state.db.deploy(id)?.ok_or_else(ApiError::not_found)
}

pub async fn list(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let views: Vec<Value> = state
        .db
        .deploys()?
        .iter()
        .map(|d| view(&state, d, None))
        .collect::<ApiResult<_>>()?;
    Ok(Json(json!(views)))
}

pub async fn get(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    UrlPath(id): UrlPath<String>,
) -> ApiResult<Json<Value>> {
    let d = find(&state, &id)?;
    Ok(Json(view(&state, &d, Some(&caller))?))
}

#[derive(Deserialize)]
pub struct SourceBody {
    #[serde(default)]
    repo: String,
    #[serde(default)]
    url: String,
    token: Option<String>,
    /// A container already linked, whose token is used when none is given.
    deploy: Option<String>,
}

/// The branches of a repository here or at an address, and its default.
async fn branches(
    state: &AppState,
    caller: &Caller,
    repo: &str,
    url: &str,
    token: Option<&str>,
) -> ApiResult<(Vec<String>, String)> {
    if !url.is_empty() {
        if !valid_url(url) {
            return Err(ApiError::bad("The address must start with https://"));
        }
        let listing = ls_remote(state, url, token, &["HEAD", "refs/heads/*"]).await?;
        return Ok(branches_of_remote(&listing));
    }
    let dir = code::need(state, &Viewer::of(caller), repo, Level::Read)?;
    branches_of_local(&dir).await
}

pub async fn probe(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Json(body): Json<SourceBody>,
) -> ApiResult<Json<Value>> {
    let token = match body.token.filter(|t| !t.is_empty()) {
        Some(t) => Some(t),
        None => body.deploy.as_deref().and_then(|id| token_of(&state, id)),
    };
    let (list, default) = branches(
        &state,
        &caller,
        body.repo.trim(),
        body.url.trim(),
        token.as_deref(),
    )
    .await?;
    Ok(Json(json!({ "branches": list, "default": default })))
}

#[derive(Deserialize)]
pub struct NewDeploy {
    name: String,
    #[serde(default)]
    repo: String,
    #[serde(default)]
    url: String,
    token: Option<String>,
    branch: Option<String>,
    updates: Option<String>,
    every: Option<i64>,
}

fn check_updates(updates: &str, every: i64) -> ApiResult<()> {
    if !matches!(updates, "push" | "timer" | "manual") {
        return Err(ApiError::bad("Update on push, on a timer, or by hand"));
    }
    if updates == "timer" && !(3600..=30 * 86_400).contains(&every) {
        return Err(ApiError::bad(
            "The timer runs from every hour to every 30 days",
        ));
    }
    Ok(())
}

pub async fn create(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Json(body): Json<NewDeploy>,
) -> ApiResult<Json<Value>> {
    let name = body.name.trim().to_owned();
    if !valid_name(&name) {
        return Err(ApiError::bad(
            "Name: lowercase letters, digits, '.', '-' and '_', starting with a letter or digit",
        ));
    }
    if state.db.deploys()?.iter().any(|d| d.name == name)
        || docker::get(&Endpoint::from_env(), &format!("/containers/{name}/json"))
            .await
            .is_ok()
    {
        return Err(ApiError::conflict(format!(
            "There is already a container called {name}"
        )));
    }
    let (repo, url) = (
        body.repo.trim().to_owned(),
        body.url.trim().trim_end_matches('/').to_owned(),
    );
    if repo.is_empty() == url.is_empty() {
        return Err(ApiError::bad(
            "Pick a repository on this host or give an address",
        ));
    }
    let token = body.token.filter(|t| !t.trim().is_empty());
    let (list, default) = branches(&state, &caller, &repo, &url, token.as_deref()).await?;
    let branch = body.branch.filter(|b| !b.is_empty()).unwrap_or(default);
    if !list.contains(&branch) {
        return Err(ApiError::bad(if list.is_empty() {
            "The repository has no branches yet; push to it first".to_owned()
        } else {
            format!("There is no branch {branch}")
        }));
    }
    let updates = body.updates.unwrap_or_else(|| "push".into());
    let every = body.every.unwrap_or(86_400);
    check_updates(&updates, every)?;
    let d = Deploy {
        id: random_hex(8),
        name,
        repo: if url.is_empty() { repo } else { String::new() },
        url,
        branch,
        dockerfile: String::new(),
        port: 0,
        keep: Vec::new(),
        updates,
        every,
        current: None,
        checked_at: now(),
        created_at: now(),
    };
    state.db.insert_deploy(&d)?;
    if let Some(token) = token {
        state.db.set_setting(&token_key(&d.id), token.trim())?;
    }
    queue(&state, &d.id, "", "first")?;
    Ok(Json(view(&state, &d, Some(&caller))?))
}

#[derive(Deserialize)]
pub struct DeployEdit {
    repo: Option<String>,
    url: Option<String>,
    token: Option<String>,
    branch: Option<String>,
    dockerfile: Option<String>,
    port: Option<u16>,
    env: Option<Vec<String>>,
    keep: Option<Vec<String>>,
    updates: Option<String>,
    every: Option<i64>,
}

pub async fn edit(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    UrlPath(id): UrlPath<String>,
    Json(body): Json<DeployEdit>,
) -> ApiResult<Json<Value>> {
    let mut d = find(&state, &id)?;
    let mut rerun = false;
    if body.repo.is_some() || body.url.is_some() || body.token.is_some() || body.branch.is_some() {
        let repo = body.repo.map(|r| r.trim().to_owned());
        let url = body.url.map(|u| u.trim().trim_end_matches('/').to_owned());
        let (repo, url) = match (repo, url) {
            (Some(r), _) if !r.is_empty() => (r, String::new()),
            (_, Some(u)) if !u.is_empty() => (String::new(), u),
            _ => (d.repo.clone(), d.url.clone()),
        };
        let token = match body.token.as_deref().map(str::trim) {
            Some("") => None,
            Some(t) => Some(t.to_owned()),
            None => token_of(&state, &d.id).filter(|_| !url.is_empty()),
        };
        let (list, default) = branches(&state, &caller, &repo, &url, token.as_deref()).await?;
        let branch = body.branch.unwrap_or_else(|| {
            if list.contains(&d.branch) {
                d.branch.clone()
            } else {
                default
            }
        });
        if !list.contains(&branch) {
            return Err(ApiError::bad(format!("There is no branch {branch}")));
        }
        if url != d.url {
            let _ = tokio::fs::remove_dir_all(mirror_dir(&state, &d.id)).await;
        }
        match &token {
            Some(t) if !url.is_empty() => state.db.set_setting(&token_key(&d.id), t)?,
            _ => state.db.delete_setting(&token_key(&d.id))?,
        }
        (d.repo, d.url, d.branch) = (repo, url, branch);
    }
    if let Some(file) = body.dockerfile {
        let file = file.trim().trim_start_matches("./").to_owned();
        if !file.is_empty() && !valid_file(&file) {
            return Err(ApiError::bad("That is not a path in the repository"));
        }
        d.dockerfile = file;
    }
    if let Some(port) = body.port {
        rerun |= port != d.port;
        d.port = port;
    }
    if let Some(keep) = body.keep {
        let keep: Vec<String> = keep
            .iter()
            .map(|k| k.trim().trim_end_matches('/').to_owned())
            .filter(|k| !k.is_empty())
            .collect();
        if let Some(bad) = keep.iter().find(|k| !valid_folder(k)) {
            return Err(ApiError::bad(format!(
                "{bad} is not a folder path, such as /data"
            )));
        }
        rerun |= keep != d.keep;
        d.keep = keep;
    }
    if let Some(env) = body.env {
        let env: Vec<String> = env
            .iter()
            .map(|e| e.trim().to_owned())
            .filter(|e| !e.is_empty())
            .collect();
        if let Some(bad) = env.iter().find(|e| {
            !e.split_once('=')
                .is_some_and(|(k, _)| !k.is_empty() && !k.contains(char::is_whitespace))
        }) {
            return Err(ApiError::bad(format!("{bad} is not NAME=value")));
        }
        rerun |= env != env_of(&state, &d.id);
        state
            .db
            .set_setting(&env_key(&d.id), &json!(env).to_string())?;
    }
    if body.updates.is_some() || body.every.is_some() {
        let updates = body.updates.unwrap_or_else(|| d.updates.clone());
        let every = body.every.unwrap_or(d.every);
        check_updates(&updates, every)?;
        (d.updates, d.every) = (updates, every);
    }
    state.db.save_deploy(&d)?;
    // What the container is made with changed: the running build is made again.
    if rerun {
        let running = d
            .current
            .and_then(|n| state.db.build(&d.id, n).ok().flatten());
        if let Some((
            Build {
                image: Some(image),
                number,
                ..
            },
            _,
        )) = running
        {
            let (state, d) = (state.clone(), d.clone());
            tokio::spawn(async move {
                if let Err(why) = roll_out(&state, &d, &image, number).await {
                    tracing::warn!("could not make {} again: {why}", d.name);
                }
            });
        }
    }
    Ok(Json(view(&state, &d, Some(&caller))?))
}

/// Takes the container away with its images and its copy of the repository.
/// Its volumes stay.
pub async fn remove(
    State(state): State<AppState>,
    UrlPath(id): UrlPath<String>,
) -> ApiResult<Json<Value>> {
    let d = find(&state, &id)?;
    let endpoint = Endpoint::from_env();
    take_down(&endpoint, &d.name).await;
    for b in state.db.builds(&d.id, 1000)? {
        if let Some(image) = b.image {
            let _ = docker::call(
                &endpoint,
                Method::DELETE,
                &format!("/images/{image}"),
                ACTION_WAIT,
            )
            .await;
        }
    }
    let _ = tokio::fs::remove_dir_all(mirror_dir(&state, &d.id)).await;
    state.db.delete_deploy(&d.id)?;
    state.db.delete_setting(&token_key(&d.id))?;
    state.db.delete_setting(&env_key(&d.id))?;
    Ok(Json(json!({ "ok": true })))
}

/// Builds the branch's latest commit now, whatever was built before.
pub async fn build_now(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    UrlPath(id): UrlPath<String>,
) -> ApiResult<Json<Value>> {
    let d = find(&state, &id)?;
    if state.db.has_waiting_build(&d.id)? {
        return Err(ApiError::conflict("An update is already on its way"));
    }
    queue(&state, &d.id, "", "manual")?;
    Ok(Json(view(&state, &d, Some(&caller))?))
}

pub async fn build_log(
    State(state): State<AppState>,
    UrlPath((id, number)): UrlPath<(String, i64)>,
) -> ApiResult<Json<Value>> {
    let (b, log) = state
        .db
        .build(&id, number)?
        .ok_or_else(ApiError::not_found)?;
    let mut v = json!(b);
    v["log"] = json!(log);
    Ok(Json(v))
}

/// Runs an earlier build again, from its kept image.
pub async fn use_build(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    UrlPath((id, number)): UrlPath<(String, i64)>,
) -> ApiResult<Json<Value>> {
    let d = find(&state, &id)?;
    let (b, _) = state
        .db
        .build(&id, number)?
        .ok_or_else(ApiError::not_found)?;
    let Some(image) = b.image.filter(|_| b.status == "ready") else {
        return Err(ApiError::bad("That build's image is no longer kept"));
    };
    roll_out(&state, &d, &image, number).await.map_err(|why| {
        ApiError(
            StatusCode::BAD_GATEWAY,
            format!("Build {number} did not start: {why}"),
        )
    })?;
    let d = find(&state, &id)?;
    Ok(Json(view(&state, &d, Some(&caller))?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_suit_containers_and_images() {
        assert!(valid_name("web"));
        assert!(valid_name("my-app.2_b"));
        assert!(!valid_name("Web"));
        assert!(!valid_name("-web"));
        assert!(!valid_name("a/b"));
        assert!(!valid_name(""));
    }

    #[test]
    fn only_https_addresses_and_plain_paths() {
        assert!(valid_url("https://github.com/me/app.git"));
        assert!(!valid_url("http://github.com/me/app"));
        assert!(!valid_url("--upload-pack=x"));
        assert!(!valid_url("https://a b"));
        assert!(valid_file("Dockerfile"));
        assert!(valid_file("server/Dockerfile.prod"));
        assert!(!valid_file("../Dockerfile"));
        assert!(!valid_file("/etc/passwd"));
        assert!(valid_folder("/data"));
        assert!(!valid_folder("data"));
        assert!(!valid_folder("/data:/etc"));
        assert_eq!(volume_of("web", "/var/lib/app/"), "web_var_lib_app");
    }

    #[test]
    fn branches_come_from_ls_remote() {
        let listing =
            "ref: refs/heads/main\tHEAD\nabc\tHEAD\nabc\trefs/heads/main\ndef\trefs/heads/dev\n";
        let (branches, default) = branches_of_remote(listing);
        assert_eq!(branches, ["dev", "main"]);
        assert_eq!(default, "main");
    }

    #[test]
    fn classic_builds_print_their_lines_and_image() {
        let mut p = Progress::default();
        p.line(br#"{"stream":"Step 1/2 : FROM alpine\n"}"#);
        p.line(br#"{"status":"Downloading","id":"abc","progressDetail":{"current":1}}"#);
        p.line(br#"{"aux":{"ID":"sha256:feed"}}"#);
        assert_eq!(p.log, "Step 1/2 : FROM alpine\n");
        assert_eq!(p.image.as_deref(), Some("sha256:feed"));
        p.line(br#"{"error":"boom","errorDetail":{"message":"boom"}}"#);
        assert_eq!(p.error.as_deref(), Some("boom"));
    }

    fn message(fields: &[(u64, &[u8])]) -> Vec<u8> {
        let mut out = Vec::new();
        for (n, bytes) in fields {
            out.push(((n << 3) | 2) as u8);
            out.push(bytes.len() as u8);
            out.extend_from_slice(bytes);
        }
        out
    }

    #[test]
    fn buildkit_steps_and_logs_are_read() {
        let vertex = message(&[
            (1, b"sha256:1"),
            (3, b"[1/2] FROM alpine"),
            (5, b""),
            (6, b""),
        ]);
        let log = message(&[(1, b"sha256:1"), (4, b"hello\n")]);
        let status = message(&[(1, &vertex), (3, &log)]);
        let mut p = Progress::default();
        let line = json!({ "id": "moby.buildkit.trace", "aux": B64.encode(&status) }).to_string();
        p.line(line.as_bytes());
        assert_eq!(p.log, "#1 [1/2] FROM alpine\n#1 DONE\n#1 hello\n");
        let image = json!({ "id": "moby.image.id", "aux": { "ID": "sha256:beef" } }).to_string();
        p.line(image.as_bytes());
        assert_eq!(p.image.as_deref(), Some("sha256:beef"));
    }

    #[test]
    fn the_spec_keeps_folders_and_finds_the_port() {
        let d = Deploy {
            id: "d1".into(),
            name: "web".into(),
            repo: "web".into(),
            url: String::new(),
            branch: "main".into(),
            dockerfile: String::new(),
            port: 0,
            keep: vec!["/uploads".into()],
            updates: "push".into(),
            every: 86_400,
            current: None,
            checked_at: 0,
            created_at: 0,
        };
        let config = json!({ "ExposedPorts": { "8080/tcp": {} }, "Volumes": { "/data": {} } });
        let spec = spec_of(&d, &["A=1".into()], "sha256:x", &config, 3, None);
        assert_eq!(
            spec["HostConfig"]["Binds"],
            json!(["web_data:/data", "web_uploads:/uploads"])
        );
        assert_eq!(
            spec["HostConfig"]["PortBindings"]["8080/tcp"][0]["HostIp"],
            "127.0.0.1"
        );
        assert_eq!(spec["Labels"]["deploy.build"], "3");
        let spec = spec_of(&d, &[], "sha256:x", &config, 3, Some("home_default"));
        assert!(spec["HostConfig"]["PortBindings"].is_null());
        assert_eq!(spec["HostConfig"]["NetworkMode"], "home_default");
    }
}
