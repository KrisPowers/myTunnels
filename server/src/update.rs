//! Updating an installed myTunnels from the panel.
//!
//! The install scripts leave the release they installed in a `release` file
//! beside the program; a newer latest release on GitHub is an update.
//! Installing it runs the same install script the README gives, on its own,
//! so it outlives this program while it stops it, swaps the files and starts
//! the new one. A copy run any other way, such as in Docker or by Homebrew,
//! has no `release` file and is never offered one.

use std::process::Stdio;
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};
use tokio::process::Command;

use crate::config;
use crate::state::AppState;
use crate::util::{ApiError, ApiResult};

const REPO: &str = "KrisPowers/myTunnels";

/// How long the latest release found is trusted before asking GitHub again.
const FRESH: Duration = Duration::from_secs(60);

/// The latest release found, and when.
static FOUND: Mutex<Option<(Instant, String)>> = Mutex::new(None);

/// The release this program was installed from, when an install script put it here.
fn installed() -> Option<String> {
    let dir = config::program()?.parent()?.to_path_buf();
    let tag = std::fs::read_to_string(dir.join("release")).ok()?;
    Some(tag.trim().to_owned()).filter(|t| !t.is_empty())
}

/// A GitHub sign-in that can read the private repository: GH_TOKEN,
/// GITHUB_TOKEN, or GitHub CLI's.
async fn token() -> Option<String> {
    let env = |key: &str| std::env::var(key).ok().filter(|v| !v.trim().is_empty());
    if let Some(token) = env("GH_TOKEN").or_else(|| env("GITHUB_TOKEN")) {
        return Some(token);
    }
    let out = Command::new("gh")
        .args(["auth", "token"])
        .stdin(Stdio::null())
        .output()
        .await
        .ok()?;
    let token = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    (out.status.success() && !token.is_empty()).then_some(token)
}

/// The latest release's tag, asked of GitHub at most every [`FRESH`].
async fn latest(state: &AppState, token: &str) -> Result<String> {
    let known = FOUND.lock().unwrap_or_else(PoisonError::into_inner).clone();
    if let Some((_, tag)) = known.filter(|(at, _)| at.elapsed() < FRESH) {
        return Ok(tag);
    }
    let body: Value = state
        .http
        .get(format!(
            "https://api.github.com/repos/{REPO}/releases/latest"
        ))
        .header("User-Agent", "mytunnels")
        .header("Accept", "application/vnd.github+json")
        .bearer_auth(token)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let tag = body["tag_name"]
        .as_str()
        .context("GitHub named no latest release")?
        .to_owned();
    *FOUND.lock().unwrap_or_else(PoisonError::into_inner) = Some((Instant::now(), tag.clone()));
    Ok(tag)
}

/// Whether a newer release than the one installed is out.
pub async fn check(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let Some(current) = installed() else {
        return Ok(Json(json!({ "available": false })));
    };
    let Some(token) = token().await else {
        return Ok(Json(json!({ "available": false, "current": current })));
    };
    let latest = latest(&state, &token).await?;
    Ok(Json(json!({
        "available": latest != current,
        "current": current,
        "latest": latest,
    })))
}

/// Starts installing the latest release. The panel stops answering while the
/// files are swapped, and answers again on the new release.
pub async fn install() -> ApiResult<StatusCode> {
    if installed().is_none() {
        return Err(ApiError::bad(
            "This copy of myTunnels was not put here by its install script, so it cannot update itself",
        ));
    }
    let token = token().await.ok_or_else(|| {
        ApiError::bad("Sign in to GitHub CLI on this computer (gh auth login) so myTunnels can fetch its update")
    })?;
    run_installer(&token)?;
    *FOUND.lock().unwrap_or_else(PoisonError::into_inner) = None;
    Ok(StatusCode::ACCEPTED)
}

/// Runs install.ps1 in a PowerShell started by another that ends at once,
/// so the new one is no longer under this program when `stop` ends this
/// program and everything it started.
#[cfg(windows)]
fn run_installer(token: &str) -> Result<()> {
    use base64::Engine;
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let log = config::home().join("update.txt");
    let script = format!(
        "irm https://api.github.com/repos/{REPO}/contents/scripts/install.ps1 -Headers @{{ Authorization = \"Bearer $env:GH_TOKEN\"; Accept = 'application/vnd.github.raw' }} | iex *> '{}'",
        log.display().to_string().replace('\'', "''"),
    );
    let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let encoded = base64::engine::general_purpose::STANDARD.encode(utf16);
    std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            &format!("Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','{encoded}'"),
        ])
        .env("GH_TOKEN", token)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .context("cannot start the installer")?;
    Ok(())
}

/// Runs install.sh outside this program's service, so stopping the service
/// leaves it running: as a unit of its own where systemd runs the service,
/// otherwise in a process group of its own.
#[cfg(unix)]
fn run_installer(token: &str) -> Result<()> {
    use std::fs::OpenOptions;
    use std::os::unix::process::CommandExt;

    let script = format!(
        "curl -fsSL -H \"Authorization: Bearer $GH_TOKEN\" -H 'Accept: application/vnd.github.raw' https://api.github.com/repos/{REPO}/contents/scripts/install.sh | sh"
    );
    let systemd = cfg!(target_os = "linux")
        && std::process::Command::new("systemctl")
            .args(["--user", "is-active", "--quiet", "mytunnels"])
            .status()
            .is_ok_and(|s| s.success());
    if systemd {
        std::process::Command::new("systemd-run")
            // Both taken from here, so the token never shows in a command line.
            .args([
                "--user",
                "--collect",
                "--quiet",
                "--setenv=GH_TOKEN",
                "--setenv=PATH",
            ])
            .args(["sh", "-c", &script])
            .env("GH_TOKEN", token)
            .stdin(Stdio::null())
            .status()
            .context("cannot start the installer")?;
        return Ok(());
    }
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(config::home().join("update.txt"))?;
    std::process::Command::new("sh")
        .args(["-c", &script])
        .env("GH_TOKEN", token)
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        .process_group(0)
        .spawn()
        .context("cannot start the installer")?;
    Ok(())
}
