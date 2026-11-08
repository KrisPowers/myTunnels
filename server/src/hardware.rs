//! Device Controller: the host's fans, read and set through the kernel's hwmon
//! files. Setting them takes root, so the reading and setting run as a small
//! service of their own (`server hardware`) beside the gateway, with the host's
//! `/sys` mounted, answering the gateway alone. The gateway forwards Device
//! Controller's calls to it.

use std::collections::{BTreeSet, HashMap};
use std::net::SocketAddr;
use std::path::{Path as FsPath, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use axum::extract::{ConnectInfo, Path, Request, State};
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::net::TcpListener;

use crate::state::AppState;
use crate::util::{lock, ApiError, ApiResult};

#[derive(Serialize)]
pub struct Fan {
    /// `hwmon<chip>-<fan>`.
    id: String,
    /// The chip's driver, such as `nct6798` or `amdgpu`.
    chip: String,
    label: String,
    rpm: Option<u32>,
    /// Its duty, in percent, where the speed can be set.
    speed: Option<u8>,
    /// `auto` (the firmware decides), `manual`, `full`, or `none` when it can only be read.
    mode: &'static str,
}

#[derive(Deserialize, Serialize)]
pub struct Setting {
    /// Hands the fan back to the firmware.
    auto: bool,
    /// Its duty in percent, when set by hand.
    #[serde(default)]
    speed: u8,
}

/// What each fan's `pwm<n>_enable` held before it was set by hand, to give back on Auto.
static BEFORE: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(Default::default);

/// Every fan the host's chips report, in chip order.
fn fans(root: &FsPath) -> Vec<Fan> {
    let Ok(dirs) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut chips: Vec<(u32, PathBuf)> = dirs
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            Some((name.strip_prefix("hwmon")?.parse().ok()?, e.path()))
        })
        .collect();
    chips.sort();
    let mut out = Vec::new();
    for (n, dir) in chips {
        let chip = read(&dir.join("name")).unwrap_or_default();
        let indices: BTreeSet<u32> = std::fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| index(&e.file_name().to_string_lossy()))
            .collect();
        out.extend(indices.into_iter().map(|i| fan(&dir, n, &chip, i)));
    }
    out
}

/// The fan a hwmon file belongs to: `fan<n>_input` or `pwm<n>`.
fn index(file: &str) -> Option<u32> {
    file.strip_prefix("fan")
        .and_then(|r| r.strip_suffix("_input"))
        .or_else(|| file.strip_prefix("pwm"))
        .filter(|r| !r.is_empty() && r.bytes().all(|b| b.is_ascii_digit()))?
        .parse()
        .ok()
}

fn fan(dir: &FsPath, n: u32, chip: &str, i: u32) -> Fan {
    let num = |file: String| read(&dir.join(file)).and_then(|v| v.parse::<u32>().ok());
    let pwm = num(format!("pwm{i}"));
    Fan {
        id: format!("hwmon{n}-{i}"),
        chip: chip.to_owned(),
        label: read(&dir.join(format!("fan{i}_label")))
            .filter(|l| !l.is_empty())
            .unwrap_or_else(|| format!("Fan {i}")),
        rpm: num(format!("fan{i}_input")),
        speed: pwm.map(|p| ((p.min(255) * 100 + 127) / 255) as u8),
        mode: match (pwm, num(format!("pwm{i}_enable"))) {
            (None, _) => "none",
            (_, None | Some(1)) => "manual",
            (_, Some(0)) => "full",
            _ => "auto",
        },
    }
}

fn read(path: &FsPath) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .map(|v| v.trim().to_owned())
}

fn write(path: &FsPath, value: &str) -> Result<()> {
    std::fs::write(path, value).map_err(|e| match e.kind() {
        std::io::ErrorKind::PermissionDenied => {
            anyhow::anyhow!("The host doesn't let myTunnels set this fan")
        }
        _ => anyhow::anyhow!("Couldn't set this fan: {e}"),
    })
}

/// `hwmon<chip>-<fan>` as its two numbers.
fn parse_id(id: &str) -> Option<(u32, u32)> {
    let (n, i) = id.strip_prefix("hwmon")?.split_once('-')?;
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !digits(n) || !digits(i) {
        return None;
    }
    Some((n.parse().ok()?, i.parse().ok()?))
}

/// Sets a fan by hand, or hands it back to the firmware.
fn set(root: &FsPath, id: &str, setting: &Setting) -> Result<Fan> {
    let Some((n, i)) = parse_id(id) else {
        bail!("No such fan");
    };
    let dir = root.join(format!("hwmon{n}"));
    let pwm = dir.join(format!("pwm{i}"));
    if !pwm.exists() {
        bail!("This fan's speed can't be set");
    }
    let enable = dir.join(format!("pwm{i}_enable"));
    let has_enable = enable.exists();
    if setting.auto {
        if has_enable {
            let back = lock(&BEFORE).remove(id).unwrap_or_else(|| "2".into());
            write(&enable, &back)?;
        }
    } else {
        if has_enable {
            let now = read(&enable).unwrap_or_default();
            if now != "1" {
                // Full speed is not the firmware's control; Auto then means its usual one.
                let back = if now == "0" || now.is_empty() {
                    "2".into()
                } else {
                    now
                };
                lock(&BEFORE).entry(id.to_owned()).or_insert(back);
            }
            write(&enable, "1")?;
        }
        let duty = (u32::from(setting.speed.min(100)) * 255 + 50) / 100;
        write(&pwm, &duty.to_string())?;
    }
    let chip = read(&dir.join("name")).unwrap_or_default();
    Ok(fan(&dir, n, &chip, i))
}

// ---- the service ----

struct Service {
    root: PathBuf,
    /// The host name of the one client let in.
    allow: String,
}

/// Runs the service: `HARDWARE_ADDR` to listen on, `HWMON_DIR` for the host's
/// hwmon files, and `HARDWARE_ALLOW` the only client answered.
pub async fn serve() -> Result<()> {
    let var = |key: &str, default: &str| std::env::var(key).unwrap_or_else(|_| default.into());
    let addr = var("HARDWARE_ADDR", "127.0.0.1:7090");
    let service = Arc::new(Service {
        root: var("HWMON_DIR", "/sys/class/hwmon").into(),
        allow: var("HARDWARE_ALLOW", "localhost"),
    });
    let app = Router::new()
        .route("/fans", get(list))
        .route("/fans/{id}", put(change))
        .layer(middleware::from_fn_with_state(
            service.clone(),
            only_allowed,
        ))
        .with_state(service);
    let listener = TcpListener::bind(&addr)
        .await
        .with_context(|| format!("cannot listen on {addr}"))?;
    tracing::info!("hardware on {addr}");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}

async fn only_allowed(
    State(service): State<Arc<Service>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request,
    next: Next,
) -> Response {
    let allowed = tokio::net::lookup_host((service.allow.as_str(), 0))
        .await
        .map(|mut found| found.any(|a| a.ip() == peer.ip()))
        .unwrap_or(false);
    if !allowed {
        return StatusCode::FORBIDDEN.into_response();
    }
    next.run(req).await
}

async fn list(State(service): State<Arc<Service>>) -> Json<Vec<Fan>> {
    Json(fans(&service.root))
}

async fn change(
    State(service): State<Arc<Service>>,
    Path(id): Path<String>,
    Json(setting): Json<Setting>,
) -> ApiResult<Json<Fan>> {
    set(&service.root, &id, &setting)
        .map(Json)
        .map_err(|e| ApiError::bad(format!("{e:#}")))
}

// ---- the gateway's side ----

pub async fn list_fans(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    forward(state.http.get(url(&state, "/fans"))).await
}

pub async fn set_fan(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(setting): Json<Setting>,
) -> ApiResult<Json<Value>> {
    if parse_id(&id).is_none() {
        return Err(ApiError::not_found());
    }
    let req = state
        .http
        .put(url(&state, &format!("/fans/{id}")))
        .json(&setting);
    forward(req).await
}

fn url(state: &AppState, path: &str) -> String {
    format!("{}{path}", state.config.hardware_url.trim_end_matches('/'))
}

async fn forward(req: reqwest::RequestBuilder) -> ApiResult<Json<Value>> {
    let res = req
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|_| {
            ApiError(
                StatusCode::BAD_GATEWAY,
                "Can't reach the host's hardware".into(),
            )
        })?;
    let status = StatusCode::from_u16(res.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let body: Value = res.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let error = body["error"]
            .as_str()
            .unwrap_or("The host's hardware refused");
        return Err(ApiError(status, error.to_owned()));
    }
    Ok(Json(body))
}
