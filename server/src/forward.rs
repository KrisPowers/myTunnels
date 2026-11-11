//! Forwards: a port opened by the router or by Tailscale, beside the Cloudflare
//! tunnels. Each opens when it is added or switched on, and closes when it is
//! switched off, removed or its time is up. The router's are asked for again
//! every twenty minutes, so a router that restarts gets them back.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use axum::extract::{Path, State};
use axum::Json;
use igd_next::aio::tokio::{search_gateway, Tokio};
use igd_next::aio::Gateway;
use igd_next::{AddPortError, PortMappingProtocol, SearchOptions};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::process::Command;

use crate::db::Forward;
use crate::state::AppState;
use crate::util::{lock, now, random_hex, valid_host, ApiError, ApiResult};

/// How long the router keeps a forward unless it is asked again.
const LEASE: u32 = 3600;
const RENEW: Duration = Duration::from_secs(20 * 60);
/// The only ports Funnel opens to the internet.
const FUNNEL_PORTS: [u16; 3] = [443, 8443, 10000];
/// The longest a forward can be set to stay open before it closes on its own.
const LONGEST: i64 = 30 * 86_400;

/// What went wrong the last time each forward was opened, by its ID.
static PROBLEMS: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(Mutex::default);
/// The router's public address, as it last said.
static PUBLIC_IP: LazyLock<Mutex<Option<IpAddr>>> = LazyLock::new(Mutex::default);
/// This machine's name on the tailnet, if it is on one, and when that was asked.
type Asked = Option<(Instant, Option<String>)>;
static TAILNET: LazyLock<Mutex<Asked>> = LazyLock::new(Mutex::default);

// ---- the router ----

async fn router() -> Result<Gateway<Tokio>> {
    let mut options = SearchOptions::default();
    options.timeout = Some(Duration::from_secs(4));
    options.single_search_timeout = Some(Duration::from_secs(2));
    search_gateway(options).await.map_err(|_| {
        anyhow!("No router answered. Turn on UPnP on the router to forward ports from it.")
    })
}

/// This machine's address on the router's network.
fn own_ip(router: SocketAddr) -> Result<IpAddr> {
    let socket = UdpSocket::bind(("0.0.0.0", 0))?;
    socket.connect(router)?;
    Ok(socket.local_addr()?.ip())
}

/// What the router is asked to carry: TCP, UDP, or both for `both`.
fn protocols(f: &Forward) -> &'static [PortMappingProtocol] {
    match f.protocol.as_str() {
        "udp" => &[PortMappingProtocol::UDP],
        "both" => &[PortMappingProtocol::TCP, PortMappingProtocol::UDP],
        _ => &[PortMappingProtocol::TCP],
    }
}

/// Whether two router forwards of one port carry the same protocol.
fn overlap(a: &str, b: &str) -> bool {
    a == b || a == "both" || b == "both"
}

/// How long to ask the router for: a lease, or less when it closes sooner.
fn lease(f: &Forward) -> u32 {
    if f.expires_at == 0 {
        return LEASE;
    }
    (f.expires_at - now()).clamp(60, i64::from(LEASE)) as u32
}

fn refused(err: AddPortError, f: &Forward) -> String {
    match err {
        AddPortError::PortInUse => format!(
            "The router already forwards port {} to another machine",
            f.public_port
        ),
        AddPortError::ActionNotAuthorized => {
            "The router refused. Some only forward to the machine that asks, or keep UPnP off"
                .into()
        }
        AddPortError::SamePortValuesRequired => {
            "This router needs the outside port to match the app's port".into()
        }
        other => format!("The router refused: {other}"),
    }
}

async fn open_port(f: &Forward) -> Result<()> {
    let gw = router().await?;
    let ip = match f.target_host.as_deref() {
        None | Some("localhost" | "127.0.0.1") => own_ip(gw.addr)?,
        Some(host) => host.parse().map_err(|_| {
            anyhow!("The router forwards to an IP address on its network, such as 192.168.1.20")
        })?,
    };
    let to = SocketAddr::new(ip, f.target_port);
    let about = format!("myTunnels {}", f.public_port);
    for &kind in protocols(f) {
        let added = match gw.add_port(kind, f.public_port, to, lease(f), &about).await {
            // Such a router keeps it until it is removed, which closing does.
            Err(AddPortError::OnlyPermanentLeasesSupported) => {
                gw.add_port(kind, f.public_port, to, 0, &about).await
            }
            other => other,
        };
        added.map_err(|e| anyhow!(refused(e, f)))?;
    }
    if let Ok(ip) = gw.get_external_ip().await {
        *lock(&PUBLIC_IP) = Some(ip);
    }
    Ok(())
}

async fn close_port(f: &Forward) -> Result<()> {
    let gw = router().await?;
    for &kind in protocols(f) {
        gw.remove_port(kind, f.public_port)
            .await
            .map_err(|e| anyhow!("The router would not close port {}: {e}", f.public_port))?;
    }
    Ok(())
}

// ---- Tailscale ----

fn tailscale() -> Result<PathBuf> {
    crate::apps::locate("tailscale")
        .ok_or_else(|| anyhow!("Tailscale is not installed. Install it from Apps."))
}

async fn run_tailscale(args: &[String]) -> Result<String> {
    let mut cmd = Command::new(tailscale()?);
    cmd.args(args).stdin(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let out = tokio::time::timeout(Duration::from_secs(20), cmd.output())
        .await
        .map_err(|_| anyhow!("Tailscale did not answer within 20 seconds"))??;
    let said = if out.stderr.is_empty() {
        &out.stdout
    } else {
        &out.stderr
    };
    if !out.status.success() {
        let text = String::from_utf8_lossy(said).trim().to_owned();
        bail!(if text.is_empty() {
            "Tailscale refused".to_owned()
        } else {
            text
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// What `tailscale serve` or `tailscale funnel` is told to open or close it.
fn serve_args(f: &Forward, on: bool) -> Vec<String> {
    let mut args = vec![if f.public { "funnel" } else { "serve" }.to_owned()];
    let port = if f.protocol == "tcp" {
        format!("--tcp={}", f.public_port)
    } else {
        format!("--https={}", f.public_port)
    };
    if on {
        let host = f.target_host.as_deref().unwrap_or("127.0.0.1");
        // Apps on https usually carry a certificate of their own making.
        let scheme = match f.protocol.as_str() {
            "https" => "https+insecure",
            other => other,
        };
        args.extend([
            "--bg".to_owned(),
            port,
            format!("{scheme}://{host}:{}", f.target_port),
        ]);
    } else {
        args.extend([port, "off".to_owned()]);
    }
    args
}

/// This machine's name on the tailnet while Tailscale is connected.
async fn tailnet_name() -> Option<String> {
    if let Some((at, name)) = lock(&TAILNET).clone() {
        if at.elapsed() < Duration::from_secs(30) {
            return name;
        }
    }
    let name = async {
        let out = run_tailscale(&["status".into(), "--json".into()])
            .await
            .ok()?;
        let v: Value = serde_json::from_str(&out).ok()?;
        if v["BackendState"] != "Running" {
            return None;
        }
        v["Self"]["DNSName"]
            .as_str()
            .map(|n| n.trim_end_matches('.').to_owned())
            .filter(|n| !n.is_empty())
    }
    .await;
    *lock(&TAILNET) = Some((Instant::now(), name.clone()));
    name
}

// ---- either ----

async fn open(f: &Forward) -> Result<()> {
    let done = if f.method == "port" {
        open_port(f).await
    } else {
        run_tailscale(&serve_args(f, true)).await.map(drop)
    };
    let mut problems = lock(&PROBLEMS);
    match &done {
        Ok(()) => problems.remove(&f.id),
        Err(err) => problems.insert(f.id.clone(), format!("{err:#}")),
    };
    done
}

async fn close(f: &Forward) -> Result<()> {
    lock(&PROBLEMS).remove(&f.id);
    if f.method == "port" {
        close_port(f).await
    } else {
        run_tailscale(&serve_args(f, false)).await.map(drop)
    }
}

/// Where it is reached from, once that is known.
fn address(f: &Forward, tailnet: Option<&str>, ip: Option<IpAddr>) -> Option<String> {
    let port = f.public_port;
    match (f.method.as_str(), f.protocol.as_str()) {
        ("port", _) => ip.map(|ip| format!("{ip}:{port}")),
        (_, "tcp") => tailnet.map(|n| format!("{n}:{port}")),
        _ if port == 443 => tailnet.map(|n| format!("https://{n}")),
        _ => tailnet.map(|n| format!("https://{n}:{port}")),
    }
}

/// Closes forwards whose time is up and renews the router's.
pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        let mut every = tokio::time::interval(Duration::from_secs(60));
        let mut renewed: Option<Instant> = None;
        loop {
            every.tick().await;
            let Ok(list) = state.db.forwards() else {
                continue;
            };
            let renew = renewed.is_none_or(|at| at.elapsed() >= RENEW);
            for f in list.iter().filter(|f| f.enabled) {
                if f.expires_at > 0 && f.expires_at <= now() {
                    if let Err(err) = close(f).await {
                        tracing::warn!("could not close port {}: {err:#}", f.public_port);
                    }
                    let off = Forward {
                        enabled: false,
                        ..f.clone()
                    };
                    if let Err(err) = state.db.update_forward(&off) {
                        tracing::warn!("could not save forward {}: {err:#}", f.id);
                    }
                    tracing::info!("closed port {}, its time was up", f.public_port);
                } else if renew && f.method == "port" {
                    if let Err(err) = open(f).await {
                        tracing::warn!("could not renew port {}: {err:#}", f.public_port);
                    }
                }
            }
            if renew {
                renewed = Some(Instant::now());
            }
        }
    });
}

// ---- the API ----

pub async fn list(State(state): State<AppState>) -> ApiResult<Json<Vec<Value>>> {
    let forwards = state.db.forwards()?;
    let tailnet = if forwards.iter().any(|f| f.method == "tailscale") {
        tailnet_name().await
    } else {
        None
    };
    let ip = *lock(&PUBLIC_IP);
    let problems = lock(&PROBLEMS).clone();
    Ok(Json(
        forwards
            .iter()
            .map(|f| {
                let mut v = json!(f);
                v["address"] = json!(address(f, tailnet.as_deref(), ip));
                v["problem"] = json!(problems.get(&f.id));
                v
            })
            .collect(),
    ))
}

#[derive(Deserialize)]
pub struct NewForward {
    method: String,
    #[serde(default)]
    name: String,
    target_host: Option<String>,
    target_port: u16,
    protocol: String,
    public_port: u16,
    #[serde(default)]
    public: bool,
    /// Seconds until it closes on its own; 0 is never.
    #[serde(default)]
    expires_in: i64,
}

fn closes_at(seconds: i64) -> ApiResult<i64> {
    if !(0..=LONGEST).contains(&seconds) {
        return Err(ApiError::bad(
            "A forward closes on its own within 30 days, or never",
        ));
    }
    Ok(if seconds > 0 { now() + seconds } else { 0 })
}

fn check_funnel(f: &Forward) -> ApiResult<()> {
    if f.method == "tailscale" && f.public && !FUNNEL_PORTS.contains(&f.public_port) {
        return Err(ApiError::bad(
            "Funnel opens only ports 443, 8443 and 10000 to the internet",
        ));
    }
    Ok(())
}

pub async fn create(
    State(state): State<AppState>,
    Json(body): Json<NewForward>,
) -> ApiResult<Json<Forward>> {
    let kinds: &[&str] = match body.method.as_str() {
        "port" => &["tcp", "udp", "both"],
        "tailscale" => &["http", "https", "tcp"],
        _ => return Err(ApiError::bad("Forward through the router or Tailscale")),
    };
    if !kinds.contains(&body.protocol.as_str()) {
        return Err(ApiError::bad("Pick how the app is reached"));
    }
    if body.target_port == 0 || body.public_port == 0 {
        return Err(ApiError::bad("Ports run from 1 to 65535"));
    }
    let target_host = body
        .target_host
        .map(|h| h.trim().to_owned())
        .filter(|h| !h.is_empty());
    if target_host.as_deref().is_some_and(|h| !valid_host(h)) {
        return Err(ApiError::bad("That is not a host name or IP address"));
    }
    let tailnet = body.method == "tailscale";
    let f = Forward {
        id: random_hex(8),
        method: body.method,
        name: body.name.trim().chars().take(100).collect(),
        target_host,
        target_port: body.target_port,
        protocol: body.protocol,
        public_port: body.public_port,
        public: body.public && tailnet,
        expires_at: closes_at(body.expires_in)?,
        enabled: true,
        created_at: now(),
    };
    check_funnel(&f)?;
    // The router keeps TCP and UDP apart, and both takes each; Tailscale has
    // one of each port.
    let taken = state.db.forwards()?.into_iter().any(|o| {
        o.method == f.method
            && o.public_port == f.public_port
            && (f.method == "tailscale" || overlap(&o.protocol, &f.protocol))
    });
    if taken {
        return Err(ApiError::conflict(format!(
            "Port {} is forwarded already",
            f.public_port
        )));
    }
    open(&f)
        .await
        .map_err(|e| ApiError::bad(format!("{e:#}")))?;
    state.db.insert_forward(&f)?;
    tracing::info!("opened port {} by {}", f.public_port, f.method);
    Ok(Json(f))
}

#[derive(Deserialize)]
pub struct ForwardEdit {
    enabled: Option<bool>,
    public: Option<bool>,
    expires_in: Option<i64>,
}

pub async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<ForwardEdit>,
) -> ApiResult<Json<Forward>> {
    let old = state.db.forward(&id)?.ok_or_else(ApiError::not_found)?;
    let mut f = old.clone();
    if let Some(on) = body.enabled {
        f.enabled = on;
    }
    if let Some(public) = body.public {
        f.public = public && f.method == "tailscale";
    }
    if let Some(seconds) = body.expires_in {
        f.expires_at = closes_at(seconds)?;
    }
    // Switched on again after its time ran out, it stays open.
    if f.enabled && !old.enabled && f.expires_at > 0 && f.expires_at <= now() {
        f.expires_at = 0;
    }
    check_funnel(&f)?;
    let moved = f.public != old.public;
    if old.enabled && (!f.enabled || moved) {
        close(&old)
            .await
            .map_err(|e| ApiError::bad(format!("{e:#}")))?;
    }
    // The router is asked again for a new lease when its time changes.
    if f.enabled && (!old.enabled || moved || f.method == "port") {
        if let Err(err) = open(&f).await {
            if old.enabled && moved {
                let _ = open(&old).await;
            }
            return Err(ApiError::bad(format!("{err:#}")));
        }
    }
    state.db.update_forward(&f)?;
    Ok(Json(f))
}

pub async fn remove(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let f = state.db.forward(&id)?.ok_or_else(ApiError::not_found)?;
    if f.enabled {
        if let Err(err) = close(&f).await {
            tracing::warn!("could not close port {}: {err:#}", f.public_port);
        }
    }
    state.db.delete_forward(&id)?;
    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(method: &str, protocol: &str, port: u16) -> Forward {
        Forward {
            id: "f1".into(),
            method: method.into(),
            name: String::new(),
            target_host: None,
            target_port: 8080,
            protocol: protocol.into(),
            public_port: port,
            public: false,
            expires_at: 0,
            enabled: true,
            created_at: 0,
        }
    }

    #[test]
    fn serve_opens_and_closes_the_same_port() {
        let web = sample("tailscale", "http", 443);
        assert_eq!(
            serve_args(&web, true),
            ["serve", "--bg", "--https=443", "http://127.0.0.1:8080"]
        );
        assert_eq!(serve_args(&web, false), ["serve", "--https=443", "off"]);
        let raw = Forward {
            public: true,
            ..sample("tailscale", "tcp", 10000)
        };
        assert_eq!(
            serve_args(&raw, true),
            ["funnel", "--bg", "--tcp=10000", "tcp://127.0.0.1:8080"]
        );
    }

    #[test]
    fn addresses_follow_the_method() {
        let ip = Some(IpAddr::from([203, 0, 113, 7]));
        assert_eq!(
            address(&sample("port", "tcp", 25565), None, ip).as_deref(),
            Some("203.0.113.7:25565")
        );
        let name = Some("box.example.ts.net");
        assert_eq!(
            address(&sample("tailscale", "http", 443), name, None).as_deref(),
            Some("https://box.example.ts.net")
        );
        assert_eq!(
            address(&sample("tailscale", "https", 8443), name, None).as_deref(),
            Some("https://box.example.ts.net:8443")
        );
        assert_eq!(address(&sample("tailscale", "tcp", 22), None, None), None);
    }

    #[test]
    fn funnel_keeps_to_its_ports() {
        let mut f = sample("tailscale", "http", 8080);
        assert!(check_funnel(&f).is_ok());
        f.public = true;
        assert!(check_funnel(&f).is_err());
        f.public_port = 8443;
        assert!(check_funnel(&f).is_ok());
    }

    #[test]
    fn both_carries_tcp_and_udp() {
        assert_eq!(
            protocols(&sample("port", "both", 27015)),
            [PortMappingProtocol::TCP, PortMappingProtocol::UDP]
        );
        assert_eq!(
            protocols(&sample("port", "udp", 27015)),
            [PortMappingProtocol::UDP]
        );
        assert!(overlap("both", "udp") && overlap("tcp", "both") && overlap("tcp", "tcp"));
        assert!(!overlap("tcp", "udp"));
    }
}
