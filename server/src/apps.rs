//! Apps: the software a homelab or engineering machine usually needs, in one
//! catalog, each installed with one click on the machine myTunnels runs on,
//! through its package manager (winget, Homebrew or apt). When myTunnels runs
//! inside Docker, that machine is reached through `server host`, which pairs with the first myTunnels to ask
//! and from then on installs only for it.
//!
//! Some features need an app where myTunnels runs: Containers need Docker,
//! tunnels need cloudflared and Git needs git. They keep working without
//! them, and say which app to install.

use std::collections::HashMap;
use std::path::{Path as FsPath, PathBuf};
use std::process::Stdio;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::process::Command;

use crate::docker::{self, Endpoint};
use crate::state::AppState;
use crate::util::{lock, random_hex, sha256_hex, ApiError, ApiResult};

/// One app in the catalog. A package name is left out where its manager
/// does not carry it.
#[derive(Serialize)]
pub struct App {
    pub id: &'static str,
    pub name: &'static str,
    pub group: &'static str,
    pub about: &'static str,
    /// Its mark in the panel.
    pub logo: &'static str,
    /// Where its makers offer it, named when its package manager does not.
    #[serde(skip)]
    pub url: &'static str,
    /// Another app it is installed with, such as Node.js for npm packages.
    pub needs: Option<&'static str>,
    /// A feature of myTunnels needs it where myTunnels runs.
    pub used: bool,
    #[serde(skip)]
    bins: &'static [&'static str],
    #[serde(skip)]
    version: &'static [&'static str],
    #[serde(skip)]
    winget: Option<&'static str>,
    /// A formula, or `--cask name` for an app.
    #[serde(skip)]
    brew: Option<&'static str>,
    #[serde(skip)]
    apt: Option<&'static str>,
    #[serde(skip)]
    npm: Option<&'static str>,
}

const V: &[&str] = &["--version"];

const fn app(
    id: &'static str,
    name: &'static str,
    group: &'static str,
    about: &'static str,
    logo: &'static str,
    url: &'static str,
    bins: &'static [&'static str],
) -> App {
    App {
        id,
        name,
        group,
        about,
        logo,
        url,
        needs: None,
        used: false,
        bins,
        version: V,
        winget: None,
        brew: None,
        apt: None,
        npm: None,
    }
}

impl App {
    const fn winget(mut self, id: &'static str) -> Self {
        self.winget = Some(id);
        self
    }
    const fn brew(mut self, name: &'static str) -> Self {
        self.brew = Some(name);
        self
    }
    const fn apt(mut self, name: &'static str) -> Self {
        self.apt = Some(name);
        self
    }
    const fn npm(mut self, name: &'static str) -> Self {
        self.npm = Some(name);
        self.needs = Some("nodejs");
        self
    }
    const fn used(mut self) -> Self {
        self.used = true;
        self
    }
    const fn version(mut self, args: &'static [&'static str]) -> Self {
        self.version = args;
        self
    }
}

pub const CATALOG: &[App] = &[
    app(
        "docker",
        "Docker",
        "Containers",
        "Runs containers; Containers needs it",
        "docker",
        "https://www.docker.com/products/docker-desktop/",
        &["docker"],
    )
    .used()
    .winget("Docker.DockerDesktop")
    .brew("--cask docker")
    .apt("docker.io"),
    app(
        "kubectl",
        "kubectl",
        "Containers",
        "Kubernetes' command line",
        "kubernetes",
        "https://kubernetes.io/docs/tasks/tools/",
        &["kubectl"],
    )
    .winget("Kubernetes.kubectl")
    .brew("kubectl")
    .version(&["version", "--client"]),
    app(
        "minikube",
        "minikube",
        "Containers",
        "A Kubernetes cluster on this machine",
        "kubernetes",
        "https://minikube.sigs.k8s.io/docs/start/",
        &["minikube"],
    )
    .winget("Kubernetes.minikube")
    .brew("minikube")
    .version(&["version", "--short"]),
    app(
        "helm",
        "Helm",
        "Containers",
        "Kubernetes' package manager",
        "helm",
        "https://helm.sh/docs/intro/install/",
        &["helm"],
    )
    .winget("Helm.Helm")
    .brew("helm")
    .version(&["version", "--short"]),
    app(
        "cloudflared",
        "cloudflared",
        "Cloudflare",
        "Cloudflare Tunnel's connector; tunnels need it",
        "cloudflare",
        "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
        &["cloudflared"],
    )
    .used()
    .winget("Cloudflare.cloudflared")
    .brew("cloudflared"),
    app(
        "warp",
        "Cloudflare WARP",
        "Cloudflare",
        "Cloudflare's VPN client and Zero Trust agent",
        "cloudflare",
        "https://one.one.one.one/",
        &["warp-cli"],
    )
    .winget("Cloudflare.Warp")
    .brew("--cask cloudflare-warp"),
    app(
        "wrangler",
        "Wrangler",
        "Cloudflare",
        "The command line for Cloudflare Workers",
        "cloudflareworkers",
        "https://developers.cloudflare.com/workers/wrangler/install-and-update/",
        &["wrangler"],
    )
    .npm("wrangler"),
    app(
        "git",
        "Git",
        "Source control",
        "Version control; Git and repository builds need it",
        "git",
        "https://git-scm.com/downloads",
        &["git"],
    )
    .used()
    .winget("Git.Git")
    .brew("git")
    .apt("git"),
    app(
        "gh",
        "GitHub CLI",
        "Source control",
        "GitHub from the command line",
        "github",
        "https://cli.github.com/",
        &["gh"],
    )
    .winget("GitHub.cli")
    .brew("gh")
    .apt("gh"),
    app(
        "rust",
        "Rust",
        "Languages",
        "Rust and Cargo, through rustup",
        "rust",
        "https://rustup.rs/",
        &["rustup", "cargo"],
    )
    .winget("Rustlang.Rustup")
    .brew("rustup"),
    app(
        "go",
        "Go",
        "Languages",
        "The Go toolchain",
        "go",
        "https://go.dev/dl/",
        &["go"],
    )
    .winget("GoLang.Go")
    .brew("go")
    .apt("golang-go")
    .version(&["version"]),
    app(
        "python",
        "Python",
        "Languages",
        "Python 3 and pip",
        "python",
        "https://www.python.org/downloads/",
        &["python3", "python"],
    )
    .winget("Python.Python.3.13")
    .brew("python")
    .apt("python3"),
    app(
        "java",
        "Java",
        "Languages",
        "The OpenJDK, from Microsoft's build",
        "openjdk",
        "https://learn.microsoft.com/java/openjdk/download",
        &["java"],
    )
    .winget("Microsoft.OpenJDK.21")
    .brew("openjdk")
    .apt("default-jdk"),
    app(
        "dotnet",
        ".NET",
        "Languages",
        "The .NET SDK",
        "dotnet",
        "https://dotnet.microsoft.com/download",
        &["dotnet"],
    )
    .winget("Microsoft.DotNet.SDK.10")
    .brew("--cask dotnet-sdk"),
    app(
        "nodejs",
        "Node.js",
        "Runtimes",
        "JavaScript's runtime, with npm",
        "nodedotjs",
        "https://nodejs.org/en/download",
        &["node"],
    )
    .winget("OpenJS.NodeJS.LTS")
    .brew("node")
    .apt("nodejs"),
    app(
        "fnm",
        "fnm",
        "Runtimes",
        "Switches between Node.js versions",
        "nodedotjs",
        "https://github.com/Schniz/fnm",
        &["fnm"],
    )
    .winget("Schniz.fnm")
    .brew("fnm"),
    app(
        "bun",
        "Bun",
        "Runtimes",
        "A fast JavaScript runtime and package manager",
        "bun",
        "https://bun.sh/",
        &["bun"],
    )
    .winget("Oven-sh.Bun")
    .brew("oven-sh/bun/bun"),
    app(
        "deno",
        "Deno",
        "Runtimes",
        "A JavaScript and TypeScript runtime",
        "deno",
        "https://deno.com/",
        &["deno"],
    )
    .winget("DenoLand.Deno")
    .brew("deno"),
    app(
        "terraform",
        "Terraform",
        "Infrastructure",
        "Infrastructure as code",
        "terraform",
        "https://developer.hashicorp.com/terraform/install",
        &["terraform"],
    )
    .winget("Hashicorp.Terraform")
    .brew("hashicorp/tap/terraform")
    .version(&["version"]),
    app(
        "wireguard",
        "WireGuard",
        "Infrastructure",
        "A fast, simple VPN",
        "wireguard",
        "https://www.wireguard.com/install/",
        &["wg"],
    )
    .winget("WireGuard.WireGuard")
    .brew("wireguard-tools")
    .apt("wireguard"),
];

fn find(id: &str) -> Option<&'static App> {
    CATALOG.iter().find(|a| a.id == id)
}

// ---- the machine itself ----

/// How this machine installs apps.
#[derive(Clone, Copy, PartialEq)]
enum Manager {
    Winget,
    Brew,
    Apt,
}

fn os() -> &'static str {
    match std::env::consts::OS {
        "windows" => "windows",
        "macos" => "macos",
        _ => "linux",
    }
}

fn manager(dirs: &[PathBuf]) -> Option<Manager> {
    let (m, bin) = match os() {
        "windows" => (Manager::Winget, "winget"),
        "macos" => (Manager::Brew, "brew"),
        _ => (Manager::Apt, "apt-get"),
    };
    which(bin, dirs).map(|_| m)
}

fn manager_name(m: Option<Manager>) -> Option<&'static str> {
    m.map(|m| match m {
        Manager::Winget => "winget",
        Manager::Brew => "Homebrew",
        Manager::Apt => "apt",
    })
}

/// The program and arguments that install `a` here, if this machine can.
fn install_command(
    a: &App,
    m: Option<Manager>,
    dirs: &[PathBuf],
    action: Action,
) -> Option<(PathBuf, Vec<String>)> {
    let words = |s: &str| s.split_whitespace().map(str::to_owned).collect::<Vec<_>>();
    if let Some(pkg) = a.npm {
        let npm = which("npm", dirs)?;
        let verb = match action {
            Action::Install => "install",
            Action::Update => "update",
            Action::Uninstall => "uninstall",
        };
        return Some((npm, vec![verb.into(), "-g".into(), pkg.into()]));
    }
    match m? {
        Manager::Winget => {
            let mut args = words(match action {
                Action::Install => "install --exact --silent --disable-interactivity --accept-package-agreements --accept-source-agreements --id",
                Action::Update => "upgrade --exact --silent --disable-interactivity --accept-package-agreements --accept-source-agreements --id",
                Action::Uninstall => "uninstall --exact --silent --disable-interactivity --accept-source-agreements --id",
            });
            args.push(a.winget?.into());
            Some((which("winget", dirs)?, args))
        }
        Manager::Brew => {
            let verb = match action {
                Action::Install => "install",
                Action::Update => "upgrade",
                Action::Uninstall => "uninstall",
            };
            let mut args = vec![verb.to_owned()];
            args.extend(words(a.brew?));
            Some((which("brew", dirs)?, args))
        }
        Manager::Apt => {
            // Without a password: sudo set up for it, or running as root.
            let mut args = words(match action {
                Action::Install => "-n apt-get install -y",
                Action::Update => "-n apt-get install --only-upgrade -y",
                Action::Uninstall => "-n apt-get remove -y",
            });
            args.push(a.apt?.into());
            Some((which("sudo", dirs)?, args))
        }
    }
}

/// What is done to an app on the host.
#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Install,
    Update,
    Uninstall,
}

impl Action {
    fn parse(word: &str) -> Option<Self> {
        match word {
            "install" => Some(Self::Install),
            "update" => Some(Self::Update),
            "uninstall" => Some(Self::Uninstall),
            _ => None,
        }
    }

    fn doing(self) -> &'static str {
        match self {
            Self::Install => "installed",
            Self::Update => "updated",
            Self::Uninstall => "removed",
        }
    }
}

/// Every folder programs are found in, as a new sign-in would see them: on
/// Windows the saved PATH as well, so an app installed a moment ago is found.
fn search_dirs() -> Vec<PathBuf> {
    let mut list: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    if cfg!(windows) {
        for key in [
            r"HKCU\Environment",
            r"HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
        ] {
            let out = std::process::Command::new("reg")
                .args(["query", key, "/v", "Path"])
                .output();
            let Ok(out) = out else { continue };
            let text = String::from_utf8_lossy(&out.stdout);
            if let Some(value) = text
                .lines()
                .find_map(|l| {
                    l.trim()
                        .strip_prefix("Path")
                        .or_else(|| l.trim().strip_prefix("PATH"))
                })
                .and_then(|rest| {
                    rest.trim()
                        .split_once("    ")
                        .map(|(_, v)| v.trim().to_owned())
                })
            {
                let var = |name: &str| std::env::var(name).ok();
                list.extend(
                    value
                        .split(';')
                        .filter(|p| !p.is_empty())
                        .map(|p| PathBuf::from(expand(p, var))),
                );
            }
        }
    } else if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        list.extend([
            home.join(".cargo/bin"),
            home.join(".local/bin"),
            home.join(".bun/bin"),
            home.join(".deno/bin"),
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/local/go/bin"),
        ]);
    }
    let mut seen = Vec::new();
    list.retain(|p| {
        let new = !seen.contains(p);
        seen.push(p.clone());
        new
    });
    list
}

/// `%USERPROFILE%\bin` with the variable filled in by `var`.
fn expand(path: &str, var: impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::new();
    let mut rest = path;
    while let Some(start) = rest.find('%') {
        let Some(len) = rest[start + 1..].find('%') else {
            break;
        };
        let name = &rest[start + 1..start + 1 + len];
        out.push_str(&rest[..start]);
        out.push_str(&var(name).unwrap_or_default());
        rest = &rest[start + len + 2..];
    }
    out.push_str(rest);
    out
}

fn which(bin: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    let names: Vec<String> = if cfg!(windows) {
        ["exe", "cmd", "bat"]
            .iter()
            .map(|e| format!("{bin}.{e}"))
            .collect()
    } else {
        vec![bin.to_owned()]
    };
    dirs.iter()
        .flat_map(|d| names.iter().map(move |n| d.join(n)))
        .find(|p| p.is_file())
}

/// The first line a program says about its version, if it runs at all: a
/// stand-in such as Windows' Python shortcut does not count.
async fn version_of(bin: &FsPath, args: &[&str]) -> Option<String> {
    let run = Command::new(bin)
        .args(args)
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output();
    let out = tokio::time::timeout(Duration::from_secs(5), run)
        .await
        .ok()?
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = if out.stdout.is_empty() {
        out.stderr
    } else {
        out.stdout
    };
    let line = String::from_utf8_lossy(&text)
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .chars()
        .take(80)
        .collect::<String>();
    Some(line)
}

/// An install running or done here.
#[derive(Clone, Serialize)]
struct Job {
    action: Action,
    running: bool,
    failed: bool,
    /// The last of what the installer said.
    log: String,
}

static JOBS: LazyLock<Mutex<HashMap<String, Job>>> = LazyLock::new(Mutex::default);
/// What was found installed, kept briefly, since looking runs every app.
static FOUND: LazyLock<Mutex<Option<(Instant, Value)>>> = LazyLock::new(Mutex::default);
const FOUND_FOR: Duration = Duration::from_secs(30);

/// This machine: which apps it has, and which it is installing.
pub async fn local_status() -> Value {
    let cached = lock(&FOUND)
        .as_ref()
        .filter(|(at, _)| at.elapsed() < FOUND_FOR)
        .map(|(_, v)| v.clone());
    let mut status = match cached {
        Some(v) => v,
        None => {
            let dirs = search_dirs();
            let m = manager(&dirs);
            let mut apps = serde_json::Map::new();
            for a in CATALOG {
                let mut version = None;
                for bin in a.bins {
                    if let Some(path) = which(bin, &dirs) {
                        version = version_of(&path, a.version).await;
                        if version.is_some() {
                            break;
                        }
                    }
                }
                apps.insert(
                    a.id.into(),
                    json!({
                        "installed": version.is_some(),
                        "version": version,
                        "can": install_command(a, m, &dirs, Action::Install).is_some(),
                    }),
                );
            }
            let v = json!({ "os": os(), "manager": manager_name(m), "apps": apps });
            *lock(&FOUND) = Some((Instant::now(), v.clone()));
            v
        }
    };
    for (id, job) in lock(&JOBS).iter() {
        status["apps"][id]["job"] = json!(job);
    }
    status
}

/// Starts installing `id` here; it carries on after the call returns.
pub fn local_install(id: &str, action: Action) -> Result<(), String> {
    let a = find(id).ok_or("No such app")?;
    if let Some(j) = lock(&JOBS).get(id).filter(|j| j.running) {
        return Err(format!("{} is being {} already", a.name, j.action.doing()));
    }
    let dirs = search_dirs();
    let (program, args) =
        install_command(a, manager(&dirs), &dirs, action).ok_or_else(|| match a.npm {
            Some(_) => "Install Node.js first, for npm".to_owned(),
            None => format!("{} cannot be installed here; get it from {}", a.name, a.url),
        })?;
    let job = move |running, failed, log: String| Job {
        action,
        running,
        failed,
        log,
    };
    lock(&JOBS).insert(id.into(), job(true, false, String::new()));
    let id = id.to_owned();
    tokio::spawn(async move {
        tracing::info!("installing {id}: {} {}", program.display(), args.join(" "));
        let run = Command::new(&program)
            .args(&args)
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output();
        let done = match tokio::time::timeout(Duration::from_secs(30 * 60), run).await {
            Ok(Ok(out)) => {
                let text = format!(
                    "{}{}",
                    String::from_utf8_lossy(&out.stdout),
                    String::from_utf8_lossy(&out.stderr)
                );
                let tail: String = text
                    .lines()
                    .map(str::trim)
                    .filter(|l| !l.is_empty())
                    .rev()
                    .take(6)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<Vec<_>>()
                    .join("\n");
                job(false, !out.status.success(), tail)
            }
            Ok(Err(err)) => job(false, true, format!("Could not start the installer: {err}")),
            Err(_) => job(false, true, "The installer took over half an hour".into()),
        };
        if done.failed {
            tracing::warn!("installing {id} failed: {}", done.log);
        }
        lock(&JOBS).insert(id, done);
        *lock(&FOUND) = None;
    });
    Ok(())
}

// ---- `server host`: the machine, for a myTunnels inside Docker ----

/// Where `server host` keeps the hash of the key it was paired with.
fn paired_file() -> PathBuf {
    let base = if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
    } else {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share"))
    };
    base.unwrap_or_else(std::env::temp_dir)
        .join("myTunnels")
        .join("paired")
}

/// The calls `server host` answers besides its figures.
pub fn host_routes() -> Router {
    Router::new()
        .route("/apps", get(|| async { Json(local_status().await) }))
        .route("/pair", post(pair))
        .route("/apps/{id}/{action}", post(host_install))
}

/// Gives the first myTunnels to ask the key installs need; later asks are
/// refused until the pairing file is removed.
async fn pair() -> Result<Json<Value>, (StatusCode, String)> {
    let file = paired_file();
    if file.exists() {
        return Err((
            StatusCode::CONFLICT,
            format!(
                "Paired already. Remove {} on the host to pair again.",
                file.display()
            ),
        ));
    }
    let key = random_hex(32);
    let saved = file
        .parent()
        .map(std::fs::create_dir_all)
        .unwrap_or(Ok(()))
        .and_then(|()| std::fs::write(&file, sha256_hex(&key)));
    saved.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Could not keep the pairing: {e}"),
        )
    })?;
    tracing::info!("paired with myTunnels");
    Ok(Json(json!({ "key": key })))
}

async fn host_install(
    Path((id, action)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    let action = Action::parse(&action).ok_or((StatusCode::NOT_FOUND, "No such action".into()))?;
    let held = std::fs::read_to_string(paired_file()).unwrap_or_default();
    let given = headers
        .get(KEY_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(sha256_hex)
        .unwrap_or_default();
    if held.trim().is_empty() || held.trim() != given {
        return Err((StatusCode::UNAUTHORIZED, "Not paired with this host".into()));
    }
    local_install(&id, action).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    Ok(Json(json!({ "ok": true })))
}

const KEY_HEADER: &str = "x-host-key";
const KEY_SETTING: &str = "host_key";

// ---- the panel's calls ----

/// The host's `server host`, when myTunnels runs inside Docker.
fn host_url() -> Option<String> {
    std::env::var("HOST_URL")
        .ok()
        .filter(|u| !u.is_empty())
        .map(|u| u.trim_end_matches('/').to_owned())
}

/// The catalog, with what the host has and can install.
pub async fn list(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    // An older `server host` answers, with its figures, but has no apps.
    let mut outdated = false;
    let host = match host_url() {
        Some(url) => {
            let got = state
                .http
                .get(format!("{url}/apps"))
                .timeout(Duration::from_secs(60))
                .send()
                .await;
            match got {
                Ok(r) if r.status().is_success() => r.json::<Value>().await.ok(),
                Ok(r) => {
                    outdated = r.status() == StatusCode::NOT_FOUND;
                    None
                }
                Err(_) => None,
            }
        }
        None => Some(local_status().await),
    };
    Ok(Json(json!({
        "catalog": CATALOG,
        "host": host,
        "remote": host_url().is_some(),
        "outdated": outdated,
    })))
}

/// Installs, updates or uninstalls an app on the host.
pub async fn install(
    State(state): State<AppState>,
    Path((id, word)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let app = find(&id).ok_or_else(ApiError::not_found)?;
    let action = Action::parse(&word).ok_or_else(ApiError::not_found)?;
    let Some(url) = host_url() else {
        local_install(app.id, action).map_err(ApiError::bad)?;
        return Ok(Json(json!({ "ok": true })));
    };
    let unreachable = |_| {
        ApiError(
            StatusCode::BAD_GATEWAY,
            "The host is not answering. Start `server host` on it.".into(),
        )
    };
    let key = match state.db.setting(KEY_SETTING)? {
        Some(key) => key,
        None => {
            let r = state
                .http
                .post(format!("{url}/pair"))
                .send()
                .await
                .map_err(unreachable)?;
            if !r.status().is_success() {
                return Err(ApiError::bad(r.text().await.unwrap_or_default()));
            }
            let key = r.json::<Value>().await.map_err(unreachable)?["key"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            state.db.set_setting(KEY_SETTING, &key)?;
            key
        }
    };
    let r = state
        .http
        .post(format!("{url}/apps/{}/{word}", app.id))
        .header(KEY_HEADER, key)
        .send()
        .await
        .map_err(unreachable)?;
    if !r.status().is_success() {
        return Err(ApiError::bad(r.text().await.unwrap_or_default()));
    }
    Ok(Json(json!({ "ok": true })))
}

/// What features need where myTunnels runs, and whether it is there.
static NEEDS: LazyLock<Mutex<Option<(Instant, Value)>>> = LazyLock::new(Mutex::default);

pub async fn needs(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let cached = lock(&NEEDS)
        .as_ref()
        .filter(|(at, _)| at.elapsed() < FOUND_FOR)
        .map(|(_, v)| v.clone());
    if let Some(v) = cached {
        return Ok(Json(v));
    }
    let runs = |bin: String, args: &'static [&'static str]| async move {
        let run = Command::new(bin)
            .args(args)
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output();
        matches!(
            tokio::time::timeout(Duration::from_secs(5), run).await,
            Ok(Ok(out)) if out.status.success()
        )
    };
    let docker = docker::call(
        &Endpoint::from_env(),
        hyper::Method::GET,
        "/_ping",
        Duration::from_secs(3),
    )
    .await
    .is_ok();
    let v = json!({
        "docker": docker,
        "git": runs("git".into(), V).await,
        "cloudflared": runs(state.config.cloudflared_bin.clone(), V).await,
    });
    *lock(&NEEDS) = Some((Instant::now(), v.clone()));
    Ok(Json(v))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_app_can_be_had_somehow() {
        for a in CATALOG {
            assert!(
                a.npm.is_some() || a.winget.is_some() || a.brew.is_some() || a.apt.is_some(),
                "{}",
                a.id
            );
            assert!(a.url.starts_with("https://"), "{}", a.id);
            assert!(!a.bins.is_empty(), "{}", a.id);
        }
        let ids: Vec<&str> = CATALOG.iter().map(|a| a.id).collect();
        let mut unique = ids.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(ids.len(), unique.len());
    }

    #[test]
    fn variables_in_saved_paths_are_filled_in() {
        let var = |n: &str| (n == "HOME").then(|| "/home/kim".to_owned());
        assert_eq!(expand("%HOME%/bin", var), "/home/kim/bin");
        assert_eq!(expand("%NONE%x", var), "x");
        assert_eq!(expand("plain", var), "plain");
    }
}
