//! Code: git repositories kept in the data folder. They are browsed on the
//! dashboard, and cloned, pulled and pushed with git over HTTPS at Code's own
//! address (for git alone) or over the LAN at the panel's `/git/`, signing in
//! with a token. Git's own `http-backend` serves git; reading for the pages uses
//! git as well.

use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use axum::body::Body;
use axum::extract::{Query, Request};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::Engine;
use http_body_util::BodyExt;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio_util::io::ReaderStream;

use crate::db::{Route, Token};
use crate::permissions::Caller;
use crate::state::AppState;
use crate::storage::{encode, segments};
use crate::util::{now, random_alnum, random_hex, sha256_hex, ApiError, ApiResult};

/// The most of a file or a commit's changes the pages show.
const MAX_SHOWN: usize = 1024 * 1024;
const PAGE: usize = 50;

pub fn root(state: &AppState) -> PathBuf {
    state.config.data_dir.join("repos")
}

/// The Code address: the one route whose target is Code.
pub fn route(state: &AppState) -> Option<Route> {
    state
        .snapshot()
        .routes
        .values()
        .find(|r| r.target_scheme == "code")
        .cloned()
}

/// A repository's name: letters, digits, `.`, `-` and `_`, a letter or digit
/// first, and not ending in `.git`, which its folder adds.
fn valid_name(name: &str) -> bool {
    (1..=100).contains(&name.len())
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        && !name.to_ascii_lowercase().ends_with(".git")
}

fn dir_of(state: &AppState, name: &str) -> ApiResult<PathBuf> {
    if !valid_name(name) {
        return Err(ApiError::not_found());
    }
    let dir = root(state).join(format!("{name}.git"));
    if dir.is_dir() {
        Ok(dir)
    } else {
        Err(ApiError::not_found())
    }
}

/// A branch, tag or commit named in a request, nothing git could take for an
/// option or a range.
pub(crate) fn checked_ref(r: &str) -> ApiResult<&str> {
    let ok = (1..=200).contains(&r.len())
        && !r.starts_with(['-', '/', '.'])
        && !r.contains("..")
        && !r.contains("//")
        && r.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._/-".contains(&b));
    if ok {
        Ok(r)
    } else {
        Err(ApiError::bad("No such branch or commit"))
    }
}

/// Runs git on a repository and gives back what it printed; a failure comes
/// back with git's reason.
pub(crate) async fn git(dir: &Path, args: &[&str]) -> ApiResult<Vec<u8>> {
    git_with(dir, args, &[]).await
}

/// Runs git with more of the environment set, such as who a commit is by.
async fn git_with(dir: &Path, args: &[&str], env: &[(&str, &str)]) -> ApiResult<Vec<u8>> {
    let out = run(dir, args, env).await?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        let why = String::from_utf8_lossy(&out.stderr).trim().to_owned();
        Err(ApiError::bad(if why.is_empty() {
            "git refused".into()
        } else {
            why
        }))
    }
}

/// Runs git and hands back how it ended, for commands whose failure says
/// something, such as a merge with conflicts.
async fn run(dir: &Path, args: &[&str], env: &[(&str, &str)]) -> ApiResult<std::process::Output> {
    tokio::process::Command::new("git")
        .arg("--git-dir")
        .arg(dir)
        .args(args)
        .envs(safe_env())
        .envs(env.iter().copied())
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| {
            ApiError(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("git is not installed: {e}"),
            )
        })
}

/// Repositories belong to this process whoever made the folders, so git's
/// check on who owns them is waived.
fn safe_env() -> [(&'static str, &'static str); 3] {
    [
        ("GIT_CONFIG_COUNT", "1"),
        ("GIT_CONFIG_KEY_0", "safe.directory"),
        ("GIT_CONFIG_VALUE_0", "*"),
    ]
}

pub(crate) fn text(bytes: Vec<u8>) -> String {
    String::from_utf8_lossy(&bytes).into_owned()
}

// ---- who may open what ----

/// Who is asking: the admin, or an account (or no one signed in, at an address
/// without sign-in).
#[derive(Clone)]
pub enum Viewer {
    Admin,
    Person(Option<String>),
}

#[derive(Clone, Copy, PartialEq, PartialOrd)]
pub enum Level {
    None,
    Read,
    Write,
}

impl Viewer {
    pub fn of(caller: &Caller) -> Self {
        match caller {
            Caller::Host => Viewer::Admin,
            Caller::Account(user) => Viewer::Person(Some(user.id.clone())),
        }
    }
}

/// What `viewer` may do with repositories: an account's Code permissions say,
/// while it is on.
fn level(state: &AppState, viewer: &Viewer) -> Level {
    let id = match viewer {
        Viewer::Admin => return Level::Write,
        Viewer::Person(None) => return Level::None,
        Viewer::Person(Some(id)) => id,
    };
    let snap = state.snapshot();
    let Some(user) = snap.users.get(id).filter(|u| u.enabled) else {
        return Level::None;
    };
    let has = |key: &str| user.holds(key);
    if has("code.push") {
        Level::Write
    } else if has("code.view") {
        Level::Read
    } else {
        Level::None
    }
}

/// Whether git may reach `repo` only from the home network.
fn home_only(state: &AppState, repo: &str) -> bool {
    state
        .db
        .setting(&format!("code_home_only:{repo}"))
        .ok()
        .flatten()
        .is_some()
}

/// True for a visitor on the home network: this host's own network, as for a
/// tunnel's Same network layer, or an address only a LAN has, as git on the
/// panel's `/git/` comes from.
fn at_home(state: &AppState, ip: Option<IpAddr>) -> bool {
    ip.map(|ip| ip.to_canonical()).is_some_and(|ip| {
        let lan = match ip {
            IpAddr::V4(v4) => v4.is_loopback() || v4.is_private() || v4.is_link_local(),
            IpAddr::V6(v6) => v6.is_loopback() || (v6.segments()[0] & 0xfe00) == 0xfc00,
        };
        lan || state.is_local(&state.snapshot(), ip)
    })
}

pub(crate) fn need(
    state: &AppState,
    viewer: &Viewer,
    repo: &str,
    want: Level,
) -> ApiResult<PathBuf> {
    if level(state, viewer) < want {
        // A repository someone may not open is one they cannot see.
        return Err(ApiError::not_found());
    }
    dir_of(state, repo)
}

// ---- the catalog ----

impl Viewer {
    /// Whose pins and settings these are: "admin" or an account.
    fn key(&self) -> &str {
        match self {
            Viewer::Admin => "admin",
            Viewer::Person(Some(id)) => id,
            Viewer::Person(None) => "",
        }
    }
}

fn pins(state: &AppState, viewer: &Viewer) -> Vec<String> {
    state
        .db
        .setting(&format!("git_pins:{}", viewer.key()))
        .ok()
        .flatten()
        .unwrap_or_default()
        .split(',')
        .filter(|p| !p.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Pins a repository to the top of `viewer`'s catalog, or unpins it.
pub async fn pin(
    state: &AppState,
    viewer: &Viewer,
    name: &str,
    pinned: bool,
) -> ApiResult<Json<Value>> {
    need(state, viewer, name, Level::Read)?;
    let mut list = pins(state, viewer);
    list.retain(|p| p != name);
    if pinned {
        list.push(name.to_owned());
    }
    state
        .db
        .set_setting(&format!("git_pins:{}", viewer.key()), &list.join(","))?;
    Ok(Json(json!({ "pinned": pinned })))
}

/// Weeks of commit history the catalog draws.
const WEEKS: usize = 26;

/// What the catalog shows of a repository besides its name, worked out once
/// per commit at its tip: the language most of its code is in, and how many
/// commits each of the last weeks had.
static STATS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, (String, Value)>>,
> = std::sync::LazyLock::new(Default::default);

async fn stats(dir: &Path, name: &str) -> Value {
    let Ok(tip) = git(dir, &["rev-parse", "--verify", "--quiet", "HEAD"]).await else {
        return json!({ "language": null, "activity": vec![0; WEEKS] });
    };
    let tip = text(tip).trim().to_owned();
    if let Some((seen, value)) = STATS.lock().unwrap_or_else(|e| e.into_inner()).get(name) {
        if *seen == tip {
            return value.clone();
        }
    }
    let mut bytes: std::collections::HashMap<&'static str, u64> = Default::default();
    if let Ok(listed) = git(dir, &["ls-tree", "-r", "-l", "-z", "HEAD"]).await {
        for entry in listed.split(|b| *b == 0) {
            let entry = String::from_utf8_lossy(entry);
            let Some((meta, path)) = entry.split_once('\t') else {
                continue;
            };
            let size = meta
                .split_whitespace()
                .nth(3)
                .and_then(|s| s.parse::<u64>().ok());
            if let (Some(size), Some(language)) = (size, language_of(path)) {
                *bytes.entry(language).or_default() += size;
            }
        }
    }
    let language = bytes.into_iter().max_by_key(|(_, n)| *n).map(|(l, _)| l);
    let mut activity = vec![0u32; WEEKS];
    let now = now();
    let since = format!("--since={}", now - (WEEKS as i64) * 7 * 86_400);
    if let Ok(times) = git(dir, &["log", "--format=%ct", &since, "HEAD"]).await {
        for at in text(times)
            .lines()
            .filter_map(|l| l.trim().parse::<i64>().ok())
        {
            let ago = ((now - at).max(0) / (7 * 86_400)) as usize;
            if ago < WEEKS {
                activity[WEEKS - 1 - ago] += 1;
            }
        }
    }
    let value = json!({ "language": language, "activity": activity });
    STATS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(name.to_owned(), (tip, value.clone()));
    value
}

/// The language a file is written in, by its ending; `None` for data, prose
/// and anything not code.
fn language_of(path: &str) -> Option<&'static str> {
    if path
        .split('/')
        .any(|p| matches!(p, "node_modules" | "vendor" | "dist" | "target"))
    {
        return None;
    }
    let ext = path.rsplit_once('.')?.1.to_ascii_lowercase();
    Some(match ext.as_str() {
        "rs" => "Rust",
        "ts" | "tsx" | "mts" | "cts" => "TypeScript",
        "js" | "jsx" | "mjs" | "cjs" => "JavaScript",
        "py" => "Python",
        "go" => "Go",
        "java" => "Java",
        "kt" | "kts" => "Kotlin",
        "swift" => "Swift",
        "c" | "h" => "C",
        "cpp" | "cc" | "cxx" | "hpp" | "hh" => "C++",
        "cs" => "C#",
        "rb" => "Ruby",
        "php" => "PHP",
        "html" | "htm" => "HTML",
        "css" => "CSS",
        "scss" | "sass" => "SCSS",
        "vue" => "Vue",
        "svelte" => "Svelte",
        "sh" | "bash" | "zsh" => "Shell",
        "ps1" | "psm1" => "PowerShell",
        "lua" => "Lua",
        "dart" => "Dart",
        "sql" => "SQL",
        "zig" => "Zig",
        "ex" | "exs" => "Elixir",
        "hs" => "Haskell",
        "scala" => "Scala",
        "r" => "R",
        "nix" => "Nix",
        _ => return None,
    })
}

/// The repositories `viewer` may open: pinned ones first, then the newest
/// change first.
pub async fn list(state: &AppState, viewer: &Viewer) -> ApiResult<Json<Value>> {
    let root = root(state);
    let pinned = pins(state, viewer);
    let mut repos = Vec::new();
    if let Ok(mut read) = tokio::fs::read_dir(&root).await {
        while let Ok(Some(entry)) = read.next_entry().await {
            let folder = entry.file_name().to_string_lossy().into_owned();
            let Some(name) = folder.strip_suffix(".git") else {
                continue;
            };
            if !valid_name(name) || !entry.path().is_dir() {
                continue;
            }
            let level = level(state, viewer);
            if level == Level::None {
                continue;
            }
            let dir = entry.path();
            let branch = git(&dir, &["symbolic-ref", "--short", "HEAD"])
                .await
                .map(|b| text(b).trim().to_owned())
                .unwrap_or_default();
            let updated = git(
                &dir,
                &[
                    "for-each-ref",
                    "--sort=-committerdate",
                    "--count=1",
                    "--format=%(committerdate:unix)",
                    "refs/heads",
                ],
            )
            .await
            .ok()
            .and_then(|b| text(b).trim().parse::<i64>().ok());
            let stats = stats(&dir, name).await;
            repos.push(json!({
                "name": name,
                "branch": branch,
                "updated": updated,
                "empty": updated.is_none(),
                "write": level == Level::Write,
                "home_only": home_only(state, name),
                "pinned": pinned.iter().any(|p| p == name),
                "language": stats["language"],
                "activity": stats["activity"],
            }));
        }
    }
    repos.sort_by_key(|r| {
        (
            !r["pinned"].as_bool().unwrap_or(false),
            std::cmp::Reverse(r["updated"].as_i64().unwrap_or(0)),
        )
    });
    let user = match viewer {
        Viewer::Person(Some(id)) => state.snapshot().users.get(id).map(|u| {
            if u.name.is_empty() {
                u.username.clone()
            } else {
                u.name.clone()
            }
        }),
        _ => None,
    };
    Ok(Json(json!({ "repos": repos, "user": user })))
}

// ---- reading, for the pages ----

#[derive(Deserialize)]
struct At {
    #[serde(rename = "ref")]
    reference: Option<String>,
    /// For comparing: the branch changes would go into.
    base: Option<String>,
    #[serde(default)]
    path: String,
    #[serde(default)]
    skip: usize,
    #[serde(default)]
    raw: bool,
}

fn query<T: DeserializeOwned>(req: &Request) -> ApiResult<T> {
    Query::<T>::try_from_uri(req.uri())
        .map(|q| q.0)
        .map_err(|e| ApiError::bad(e.body_text()))
}

/// One reading of a repository, `op`: its branches, a folder, a file, the
/// commits, or one commit.
pub async fn read(
    state: &AppState,
    viewer: &Viewer,
    name: &str,
    op: &str,
    req: Request,
) -> Response {
    let at: Result<At, ApiError> = query(&req);
    drop(req);
    let result = async {
        let dir = need(state, viewer, name, Level::Read)?;
        let at = at?;
        let path = segments(&at.path)?.join("/");
        let reference = match &at.reference {
            Some(r) => checked_ref(r)?.to_owned(),
            None => "HEAD".to_owned(),
        };
        match op {
            "refs" => refs(&dir, home_only(state, name)).await,
            "tree" => tree(&dir, &reference, &path).await,
            "blob" => blob(&dir, &reference, &path, at.raw).await,
            "log" => log(&dir, &reference, &path, at.skip).await,
            "commit" => commit(&dir, &reference).await,
            "branches" => branches(&dir).await,
            "compare" => {
                let base = checked_ref(at.base.as_deref().unwrap_or("HEAD"))?;
                compare(&dir, base, &reference)
                    .await
                    .map(|v| Json(v).into_response())
            }
            _ => Err(ApiError::not_found()),
        }
    }
    .await;
    result.unwrap_or_else(IntoResponse::into_response)
}

async fn refs(dir: &Path, home_only: bool) -> ApiResult<Response> {
    let head = git(dir, &["symbolic-ref", "--short", "HEAD"])
        .await
        .map(|b| text(b).trim().to_owned())
        .unwrap_or_default();
    let listed = text(
        git(
            dir,
            &[
                "for-each-ref",
                "--sort=-committerdate",
                "--format=%(refname)%1f%(committerdate:unix)",
                "refs/heads",
                "refs/tags",
            ],
        )
        .await?,
    );
    let mut branches = Vec::new();
    let mut tags = Vec::new();
    for line in listed.lines() {
        let mut parts = line.split('\x1f');
        let (Some(name), Some(at)) = (parts.next(), parts.next()) else {
            continue;
        };
        let at = at.parse::<i64>().unwrap_or(0);
        if let Some(b) = name.strip_prefix("refs/heads/") {
            branches.push(json!({ "name": b, "updated": at }));
        } else if let Some(t) = name.strip_prefix("refs/tags/") {
            tags.push(json!({ "name": t, "updated": at }));
        }
    }
    Ok(Json(json!({
        "default": head,
        "branches": branches,
        "tags": tags,
        "home_only": home_only,
    }))
    .into_response())
}

async fn tree(dir: &Path, reference: &str, path: &str) -> ApiResult<Response> {
    let spec = format!("{reference}:{path}");
    let listed = git(dir, &["ls-tree", "-z", "-l", &spec]).await?;
    let mut entries: Vec<Value> = listed
        .split(|b| *b == 0)
        .filter(|e| !e.is_empty())
        .filter_map(|e| {
            let e = String::from_utf8_lossy(e);
            let (meta, name) = e.split_once('\t')?;
            let mut meta = meta.split_whitespace();
            let (_mode, kind, _id, size) = (meta.next()?, meta.next()?, meta.next()?, meta.next()?);
            Some(json!({
                "name": name,
                "kind": match kind { "tree" => "dir", "commit" => "module", _ => "file" },
                "size": size.parse::<u64>().ok(),
            }))
        })
        .collect();
    entries.sort_by(|a, b| {
        (a["kind"] != "dir")
            .cmp(&(b["kind"] != "dir"))
            .then_with(|| {
                let (a, b) = (
                    a["name"].as_str().unwrap_or(""),
                    b["name"].as_str().unwrap_or(""),
                );
                a.to_lowercase().cmp(&b.to_lowercase())
            })
    });
    // The commit that last changed this folder, and how many there are.
    let mut args = vec![
        "log",
        "-1",
        "--format=%H%x1f%an%x1f%at%x1f%s",
        reference,
        "--",
    ];
    if !path.is_empty() {
        args.push(path);
    }
    let last = text(git(dir, &args).await.unwrap_or_default());
    let f: Vec<&str> = last.trim().splitn(4, '\x1f').collect();
    let last = (f.len() == 4).then(|| {
        json!({ "id": f[0], "author": f[1], "at": f[2].parse::<i64>().unwrap_or(0), "subject": f[3] })
    });
    let count = text(
        git(dir, &["rev-list", "--count", reference])
            .await
            .unwrap_or_default(),
    )
    .trim()
    .parse::<u64>()
    .unwrap_or(0);
    Ok(
        Json(json!({ "path": path, "entries": entries, "last": last, "count": count }))
            .into_response(),
    )
}

/// Every branch, the latest change first, with its last commit and how far it
/// is ahead of and behind the default branch.
async fn branches(dir: &Path) -> ApiResult<Response> {
    let head = git(dir, &["symbolic-ref", "--short", "HEAD"])
        .await
        .map(|b| text(b).trim().to_owned())
        .unwrap_or_default();
    let listed = text(
        git(
            dir,
            &[
                "for-each-ref",
                "--sort=-committerdate",
                "--format=%(refname:short)%1f%(objectname)%1f%(committerdate:unix)%1f%(authorname)%1f%(contents:subject)",
                "refs/heads",
            ],
        )
        .await?,
    );
    let mut out = Vec::new();
    for line in listed.lines() {
        let f: Vec<&str> = line.splitn(5, '\x1f').collect();
        if f.len() < 5 {
            continue;
        }
        let (ahead, behind) = if f[0] == head || head.is_empty() {
            (0, 0)
        } else {
            let range = format!("{head}...{}", f[0]);
            let counts = text(
                git(dir, &["rev-list", "--left-right", "--count", &range])
                    .await
                    .unwrap_or_default(),
            );
            let mut n = counts
                .split_whitespace()
                .map(|n| n.parse::<u64>().unwrap_or(0));
            let behind = n.next().unwrap_or(0);
            (n.next().unwrap_or(0), behind)
        };
        out.push(json!({
            "name": f[0],
            "id": f[1],
            "updated": f[2].parse::<i64>().unwrap_or(0),
            "author": f[3],
            "subject": f[4],
            "default": f[0] == head,
            "ahead": ahead,
            "behind": behind,
        }));
    }
    Ok(Json(json!({ "default": head, "branches": out })).into_response())
}

fn commit_lines(out: &str) -> Vec<Value> {
    out.split('\x1e')
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .filter_map(|c| {
            let f: Vec<&str> = c.split('\x1f').collect();
            Some(json!({
                "id": f.first()?,
                "author": f.get(1)?,
                "email": f.get(2)?,
                "at": f.get(3)?.parse::<i64>().unwrap_or(0),
                "subject": f.get(4)?,
            }))
        })
        .collect()
}

/// What `head` would bring into `base`: its commits, the changes since they
/// parted, and whether git can merge them without conflicts.
pub(crate) async fn compare(dir: &Path, base: &str, head: &str) -> ApiResult<Value> {
    let range = format!("{base}..{head}");
    let out = text(
        git(
            dir,
            &["log", "--format=%H%x1f%an%x1f%ae%x1f%at%x1f%s%x1e", &range],
        )
        .await?,
    );
    let commits = commit_lines(&out);
    let parted = format!("{base}...{head}");
    let patch = git(dir, &["diff", "--no-color", "-M", &parted]).await?;
    let truncated = patch.len() > MAX_SHOWN;
    let patch = text(patch[..patch.len().min(MAX_SHOWN)].to_vec());
    let mergeable = run(dir, &["merge-tree", "--write-tree", base, head], &[])
        .await
        .is_ok_and(|o| o.status.success());
    Ok(
        json!({ "commits": commits, "patch": patch, "truncated": truncated, "mergeable": mergeable }),
    )
}

/// Merges branch `head` into branch `base` with a merge commit by `who`, as git
/// would; refused when they conflict or there is nothing to merge. Returns the
/// new commit.
pub(crate) async fn merge(
    dir: &Path,
    base: &str,
    head: &str,
    message: &str,
    who: (&str, &str),
) -> ApiResult<String> {
    let id = |r: String| async move {
        git(dir, &["rev-parse", "--verify", &r])
            .await
            .map(|b| text(b).trim().to_owned())
    };
    let base_id = id(format!("refs/heads/{base}"))
        .await
        .map_err(|_| ApiError::bad(format!("There is no branch {base}")))?;
    let head_id = id(format!("refs/heads/{head}"))
        .await
        .map_err(|_| ApiError::bad(format!("There is no branch {head}")))?;
    if run(
        dir,
        &["merge-base", "--is-ancestor", &head_id, &base_id],
        &[],
    )
    .await?
    .status
    .success()
    {
        return Err(ApiError::bad(format!(
            "{base} already has everything in {head}"
        )));
    }
    let tree = run(
        dir,
        &["merge-tree", "--write-tree", &base_id, &head_id],
        &[],
    )
    .await?;
    if !tree.status.success() {
        return Err(ApiError::conflict(format!(
            "{head} and {base} have conflicts; resolve them in {head} and push again"
        )));
    }
    let tree = text(tree.stdout)
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .to_owned();
    let (name, email) = who;
    let env = [
        ("GIT_AUTHOR_NAME", name),
        ("GIT_AUTHOR_EMAIL", email),
        ("GIT_COMMITTER_NAME", name),
        ("GIT_COMMITTER_EMAIL", email),
    ];
    let commit = text(
        git_with(
            dir,
            &[
                "commit-tree",
                &tree,
                "-p",
                &base_id,
                "-p",
                &head_id,
                "-m",
                message,
            ],
            &env,
        )
        .await?,
    )
    .trim()
    .to_owned();
    git(
        dir,
        &[
            "update-ref",
            &format!("refs/heads/{base}"),
            &commit,
            &base_id,
        ],
    )
    .await?;
    Ok(commit)
}

async fn blob(dir: &Path, reference: &str, path: &str, raw: bool) -> ApiResult<Response> {
    if path.is_empty() {
        return Err(ApiError::bad("Name the file"));
    }
    let spec = format!("{reference}:{path}");
    let size: usize = text(git(dir, &["cat-file", "-s", &spec]).await?)
        .trim()
        .parse()
        .unwrap_or(0);
    if raw {
        let bytes = git(dir, &["cat-file", "blob", &spec]).await?;
        let name = path.rsplit('/').next().unwrap_or(path);
        let disposition = format!("attachment; filename*=UTF-8''{}", encode(name));
        let mut response = Body::from(bytes).into_response();
        let headers = response.headers_mut();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/octet-stream"),
        );
        headers.insert(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        );
        if let Ok(v) = HeaderValue::from_str(&disposition) {
            headers.insert(header::CONTENT_DISPOSITION, v);
        }
        return Ok(response);
    }
    if size > MAX_SHOWN {
        return Ok(
            Json(json!({ "size": size, "binary": false, "too_big": true, "text": null }))
                .into_response(),
        );
    }
    let bytes = git(dir, &["cat-file", "blob", &spec]).await?;
    let binary = bytes.iter().take(8000).any(|b| *b == 0);
    Ok(Json(json!({
        "size": size,
        "binary": binary,
        "too_big": false,
        "text": if binary { None } else { Some(text(bytes)) },
    }))
    .into_response())
}

async fn log(dir: &Path, reference: &str, path: &str, skip: usize) -> ApiResult<Response> {
    let count = format!("-n{}", PAGE + 1);
    let skip = format!("--skip={skip}");
    let mut args = vec![
        "log",
        "--format=%H%x1f%an%x1f%ae%x1f%at%x1f%s%x1e",
        &count,
        &skip,
        reference,
        "--",
    ];
    if !path.is_empty() {
        args.push(path);
    }
    let out = text(git(dir, &args).await?);
    let mut commits: Vec<Value> = out
        .split('\x1e')
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .filter_map(|c| {
            let f: Vec<&str> = c.split('\x1f').collect();
            Some(json!({
                "id": f.first()?,
                "author": f.get(1)?,
                "email": f.get(2)?,
                "at": f.get(3)?.parse::<i64>().unwrap_or(0),
                "subject": f.get(4)?,
            }))
        })
        .collect();
    let more = commits.len() > PAGE;
    commits.truncate(PAGE);
    Ok(Json(json!({ "commits": commits, "more": more })).into_response())
}

async fn commit(dir: &Path, reference: &str) -> ApiResult<Response> {
    let meta = text(
        git(
            dir,
            &[
                "show",
                "-s",
                "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%B",
                reference,
            ],
        )
        .await?,
    );
    let f: Vec<&str> = meta.splitn(6, '\x1f').collect();
    if f.len() < 6 {
        return Err(ApiError::not_found());
    }
    let patch = git(
        dir,
        &[
            "show",
            "--format=",
            "--no-color",
            "-M",
            "--diff-merges=first-parent",
            "--patch",
            reference,
        ],
    )
    .await?;
    let truncated = patch.len() > MAX_SHOWN;
    let patch = text(patch[..patch.len().min(MAX_SHOWN)].to_vec());
    Ok(Json(json!({
        "id": f[0],
        "parents": f[1].split_whitespace().collect::<Vec<_>>(),
        "author": f[2],
        "email": f[3],
        "at": f[4].parse::<i64>().unwrap_or(0),
        "message": f[5].trim_end(),
        "patch": patch,
        "truncated": truncated,
    }))
    .into_response())
}

// ---- the Code page ----

/// Everything the Code page shows besides the repositories: the address, and
/// the tokens `caller` may see, its own or everyone's.
pub async fn overview(state: &AppState, caller: &Caller) -> ApiResult<Json<Value>> {
    let all = caller.can("code.tokens");
    let tokens: Vec<Token> = state
        .db
        .tokens()?
        .into_iter()
        .filter(|t| all || t.owner == caller.id())
        .collect();
    Ok(Json(json!({ "route": route(state), "tokens": tokens })))
}

#[derive(Deserialize)]
pub struct NewRepo {
    name: String,
}

/// A new, empty repository, its first branch `main`.
pub async fn create(state: &AppState, viewer: &Viewer, body: NewRepo) -> ApiResult<Json<Value>> {
    let name = body.name.trim();
    if !valid_name(name) {
        return Err(ApiError::bad(
            "Name: letters, digits, '.', '-' and '_', starting with a letter or digit",
        ));
    }
    let root = root(state);
    tokio::fs::create_dir_all(&root)
        .await
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let dir = root.join(format!("{name}.git"));
    if tokio::fs::symlink_metadata(&dir).await.is_ok() {
        return Err(ApiError::conflict(format!("{name} already exists")));
    }
    let out = tokio::process::Command::new("git")
        .args(["init", "--bare", "--quiet", "--initial-branch=main"])
        .arg(&dir)
        .envs(safe_env())
        .output()
        .await
        .map_err(|e| {
            ApiError(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("git is not installed: {e}"),
            )
        })?;
    if !out.status.success() {
        return Err(ApiError::bad(text(out.stderr).trim().to_owned()));
    }
    list(state, viewer).await
}

pub async fn remove(state: &AppState, viewer: &Viewer, name: &str) -> ApiResult<Json<Value>> {
    let dir = dir_of(state, name)?;
    tokio::fs::remove_dir_all(&dir)
        .await
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    state.db.delete_setting(&format!("code_home_only:{name}"))?;
    state.db.delete_repo_threads(name)?;
    list(state, viewer).await
}

#[derive(Deserialize)]
pub struct RepoEdit {
    home_only: Option<bool>,
    default_branch: Option<String>,
}

/// Changes a repository's settings: whether git reaches it only from the home
/// network, and its default branch.
pub async fn edit(
    state: &AppState,
    viewer: &Viewer,
    name: &str,
    body: RepoEdit,
) -> ApiResult<Json<Value>> {
    let dir = dir_of(state, name)?;
    let key = format!("code_home_only:{name}");
    match body.home_only {
        Some(true) => state.db.set_setting(&key, "1")?,
        Some(false) => state.db.delete_setting(&key)?,
        None => {}
    }
    if let Some(branch) = body.default_branch {
        let branch = checked_ref(&branch)?;
        let full = format!("refs/heads/{branch}");
        git(&dir, &["rev-parse", "--verify", &full])
            .await
            .map_err(|_| ApiError::bad(format!("There is no branch {branch}")))?;
        git(&dir, &["symbolic-ref", "HEAD", &full]).await?;
    }
    list(state, viewer).await
}

#[derive(Deserialize)]
pub struct BranchAction {
    /// "create" or "delete".
    action: String,
    name: String,
    /// Where a new branch starts: a branch, tag or commit.
    from: Option<String>,
}

/// Makes a branch from another, or deletes one that is not the default.
pub async fn branch(
    state: &AppState,
    viewer: &Viewer,
    repo: &str,
    body: BranchAction,
) -> ApiResult<Response> {
    let dir = need(state, viewer, repo, Level::Write)?;
    let name = checked_ref(body.name.trim())?;
    match body.action.as_str() {
        "create" => {
            git(&dir, &["check-ref-format", "--branch", name])
                .await
                .map_err(|_| ApiError::bad(format!("{name} is not a usable branch name")))?;
            let from = checked_ref(body.from.as_deref().unwrap_or("HEAD"))?;
            git(&dir, &["branch", name, from]).await?;
        }
        "delete" => {
            let head = text(git(&dir, &["symbolic-ref", "--short", "HEAD"]).await?);
            if head.trim() == name {
                return Err(ApiError::bad("The default branch cannot be deleted"));
            }
            git(&dir, &["branch", "-D", name]).await?;
        }
        _ => return Err(ApiError::bad("Create or delete a branch")),
    }
    branches(&dir).await
}

#[derive(Deserialize)]
pub struct NewToken {
    name: String,
    /// "admin", or an account's ID.
    owner: String,
}

/// A new token, shown once: only its hash is kept. An account makes its own;
/// one for someone else needs `code.tokens`.
pub async fn add_token(
    state: &AppState,
    caller: &Caller,
    body: NewToken,
) -> ApiResult<Json<Value>> {
    let name = body.name.trim();
    if name.is_empty() || name.len() > 80 {
        return Err(ApiError::bad("Name the token, up to 80 characters"));
    }
    if body.owner != caller.id() && !caller.can("code.tokens") {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "You can make tokens for yourself only".into(),
        ));
    }
    if body.owner != "admin" && state.db.user(&body.owner)?.is_none() {
        return Err(ApiError::bad("No such user"));
    }
    let secret = format!("mtk_{}", random_alnum(40));
    state.db.insert_token(&Token {
        id: random_hex(8),
        name: name.to_owned(),
        owner: body.owner,
        hash: sha256_hex(&secret),
        created_at: now(),
        last_used: None,
    })?;
    let mut view = overview(state, caller).await?.0;
    view["secret"] = json!(secret);
    Ok(Json(view))
}

pub async fn delete_token(state: &AppState, caller: &Caller, id: &str) -> ApiResult<Json<Value>> {
    let token = state
        .db
        .tokens()?
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(ApiError::not_found)?;
    if token.owner != caller.id() && !caller.can("code.tokens") {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "You can remove your own tokens only".into(),
        ));
    }
    state.db.delete_token(id)?;
    overview(state, caller).await
}

// ---- git over HTTPS ----

/// True for a request from git itself: its first look at a repository's
/// branches, or a fetch or push.
pub fn is_git(req: &Request) -> bool {
    let path = req.uri().path();
    let query = req.uri().query().unwrap_or("");
    (path.ends_with("/info/refs") && query.contains("service=git-"))
        || path.ends_with("/git-upload-pack")
        || path.ends_with("/git-receive-pack")
}

fn ask_to_sign_in(why: &str) -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [(header::WWW_AUTHENTICATE, "Basic realm=\"myTunnels\"")],
        format!("{why}\n"),
    )
        .into_response()
}

fn refuse(status: StatusCode, why: &str) -> Response {
    (status, format!("{why}\n")).into_response()
}

/// The token in a request's Basic sign-in, as the password.
fn token_of(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let encoded = value.strip_prefix("Basic ")?;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .ok()?;
    let decoded = String::from_utf8(decoded).ok()?;
    let (_, password) = decoded.split_once(':')?;
    Some(password.to_owned()).filter(|p| !p.is_empty())
}

/// A request from git at `path` (`/<name>.git/...`): signed in with a token,
/// held to the account's access, then handed to git's `http-backend`. At the
/// Code address, `route` is it, and accounts must be among its people.
pub async fn serve(state: &AppState, ip: Option<IpAddr>, path: &str, req: Request) -> Response {
    let from = ip.map(|ip| ip.to_string()).unwrap_or_default();
    let key = format!("git:{from}");
    if state.locked_out(&key) {
        return refuse(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many wrong tokens. Wait 15 minutes and try again.",
        );
    }
    let Some(name) = path
        .trim_start_matches('/')
        .split('/')
        .next()
        .and_then(|s| s.strip_suffix(".git"))
        .map(str::to_owned)
    else {
        return refuse(StatusCode::NOT_FOUND, "No such repository");
    };
    let Some(secret) = token_of(req.headers()) else {
        return ask_to_sign_in("Sign in with a token from Git, Tokens, as the password");
    };
    let token = match state.db.token_by_hash(&sha256_hex(&secret)) {
        Ok(Some(token)) => token,
        Ok(None) => {
            state.record_failure(&key);
            return ask_to_sign_in("That token is not right");
        }
        Err(_) => return refuse(StatusCode::INTERNAL_SERVER_ERROR, "Cannot read tokens"),
    };
    state.clear_failures(&key);
    let (viewer, who) = if token.owner == "admin" {
        (Viewer::Admin, "admin".to_owned())
    } else {
        let snap = state.snapshot();
        let Some(user) = snap.users.get(&token.owner) else {
            return ask_to_sign_in("That token's account is gone");
        };
        if !user.enabled {
            return refuse(StatusCode::FORBIDDEN, "This account is suspended");
        }
        (Viewer::Person(Some(user.id.clone())), user.username.clone())
    };
    let push = path.ends_with("/git-receive-pack")
        || req
            .uri()
            .query()
            .unwrap_or("")
            .contains("service=git-receive-pack");
    let want = if push { Level::Write } else { Level::Read };
    match need(state, &viewer, &name, want) {
        Ok(_) => {}
        Err(_) if push && level(state, &viewer) == Level::Read => {
            return refuse(
                StatusCode::FORBIDDEN,
                "This token may read this repository, not push to it",
            );
        }
        Err(_) => return refuse(StatusCode::NOT_FOUND, "No such repository"),
    }
    if home_only(state, &name) && !at_home(state, ip) {
        return refuse(
            StatusCode::FORBIDDEN,
            "This repository takes git only from the home network",
        );
    }
    let _ = state.db.touch_token(&token.id, now());
    backend(state, path, &who, &from, req).await
}

/// Runs `git http-backend` for one request, the body piped in and its answer
/// streamed back.
async fn backend(state: &AppState, path: &str, user: &str, from: &str, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let header_of = |name: header::HeaderName| {
        parts
            .headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
    };
    let mut cmd = tokio::process::Command::new("git");
    cmd.arg("http-backend")
        .envs(safe_env())
        .env("GIT_PROJECT_ROOT", root(state))
        .env("GIT_HTTP_EXPORT_ALL", "1")
        .env("PATH_INFO", path)
        .env("REQUEST_METHOD", parts.method.as_str())
        .env("QUERY_STRING", parts.uri.query().unwrap_or(""))
        .env("REMOTE_USER", user)
        .env("REMOTE_ADDR", from)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(v) = header_of(header::CONTENT_TYPE) {
        cmd.env("CONTENT_TYPE", v);
    }
    if let Some(v) = header_of(header::CONTENT_LENGTH) {
        cmd.env("CONTENT_LENGTH", v);
    }
    if let Some(v) = header_of(header::CONTENT_ENCODING) {
        cmd.env("HTTP_CONTENT_ENCODING", v);
    }
    if let Some(v) = parts
        .headers
        .get("git-protocol")
        .and_then(|v| v.to_str().ok())
    {
        cmd.env("GIT_PROTOCOL", v);
    }
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            return refuse(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("git is not installed: {e}"),
            )
        }
    };
    let (Some(mut stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        return refuse(StatusCode::INTERNAL_SERVER_ERROR, "git did not start");
    };
    tokio::spawn(async move {
        let mut body = body;
        while let Some(Ok(frame)) = body.frame().await {
            if let Ok(chunk) = frame.into_data() {
                if stdin.write_all(&chunk).await.is_err() {
                    break;
                }
            }
        }
        let _ = stdin.shutdown().await;
    });
    tokio::spawn(async move {
        let _ = child.wait().await;
    });

    // The answer's headers, as a CGI program writes them, then its body.
    let mut out = BufReader::new(stdout);
    let mut response = Response::builder();
    let mut status = StatusCode::OK;
    loop {
        let mut line = String::new();
        match out.read_line(&mut line).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        if name.eq_ignore_ascii_case("status") {
            if let Some(code) = value
                .split_whitespace()
                .next()
                .and_then(|c| c.parse::<u16>().ok())
            {
                status = StatusCode::from_u16(code).unwrap_or(StatusCode::OK);
            }
        } else {
            response = response.header(name, value);
        }
    }
    response
        .status(status)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from_stream(ReaderStream::new(out)))
        .unwrap_or_else(|_| refuse(StatusCode::BAD_GATEWAY, "git answered oddly"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn languages_come_from_endings() {
        assert_eq!(language_of("src/main.rs"), Some("Rust"));
        assert_eq!(language_of("ui/src/App.tsx"), Some("TypeScript"));
        assert_eq!(language_of("README.md"), None);
        assert_eq!(language_of("ui/node_modules/react/index.js"), None);
        assert_eq!(language_of("Makefile"), None);
    }

    #[test]
    fn names_are_plain() {
        assert!(valid_name("myTunnels"));
        assert!(valid_name("site.v2_beta-1"));
        assert!(!valid_name(".hidden"));
        assert!(!valid_name("-flag"));
        assert!(!valid_name("a/b"));
        assert!(!valid_name("app.git"));
        assert!(!valid_name(""));
    }

    #[test]
    fn refs_cannot_be_options_or_ranges() {
        assert!(checked_ref("main").is_ok());
        assert!(checked_ref("feature/login-2").is_ok());
        assert!(checked_ref("v1.2.0").is_ok());
        assert!(checked_ref("--output=x").is_err());
        assert!(checked_ref("main..dev").is_err());
        assert!(checked_ref("a b").is_err());
        assert!(checked_ref("main:secret").is_err());
    }

    #[test]
    fn tokens_come_from_basic_sign_in() {
        let mut headers = HeaderMap::new();
        let encoded = base64::engine::general_purpose::STANDARD.encode("kris:mtk_abc");
        headers.insert(
            header::AUTHORIZATION,
            format!("Basic {encoded}").parse().unwrap(),
        );
        assert_eq!(token_of(&headers).as_deref(), Some("mtk_abc"));
        assert!(token_of(&HeaderMap::new()).is_none());
    }
}
