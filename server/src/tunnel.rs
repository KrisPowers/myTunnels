use std::collections::VecDeque;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{anyhow, Result};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::Command;
use tokio::sync::watch;
use tokio::time::sleep;

use crate::cloudflare::Cloudflare;
use crate::state::AppState;
use crate::util::lock;

const LOG_LINES: usize = 200;

#[derive(Default)]
struct TunnelState {
    running: bool,
    /// Where the running cloudflared serves its metrics.
    metrics: Option<String>,
    restarts: u32,
    last_error: Option<String>,
    logs: VecDeque<String>,
}

#[derive(Serialize)]
pub struct TunnelView {
    pub running: bool,
    pub restarts: u32,
    pub last_error: Option<String>,
    pub logs: Vec<String>,
}

/// Owns the cloudflared connector: which token it runs with, and what it has said.
pub struct Tunnel {
    token: watch::Sender<Option<String>>,
    state: Mutex<TunnelState>,
}

impl Tunnel {
    pub fn new(token: Option<String>) -> Self {
        Self {
            token: watch::Sender::new(token),
            state: Mutex::new(TunnelState::default()),
        }
    }

    /// Restarts the connector with a new token, or stops it with `None`.
    pub fn set_token(&self, token: Option<String>) {
        self.token.send_replace(token);
    }

    pub fn view(&self) -> TunnelView {
        let s = lock(&self.state);
        TunnelView {
            running: s.running,
            restarts: s.restarts,
            last_error: s.last_error.clone(),
            logs: s.logs.iter().cloned().collect(),
        }
    }

    fn update(&self, f: impl FnOnce(&mut TunnelState)) {
        f(&mut lock(&self.state));
    }
}

/// Keeps cloudflared running for as long as a tunnel token is configured.
pub fn spawn(state: AppState) {
    tokio::spawn(supervise(state));
}

async fn supervise(state: AppState) {
    let mut rx = state.tunnel.token.subscribe();
    loop {
        let token = rx.borrow_and_update().clone();
        let Some(token) = token else {
            state.tunnel.update(|s| s.running = false);
            if rx.changed().await.is_err() {
                return;
            }
            continue;
        };

        // A free port each start, so another cloudflared on this machine
        // never makes this one fail to start.
        let metrics = free_local_addr().unwrap_or_else(|| "127.0.0.1:20241".to_owned());
        let spawned = Command::new(&state.config.cloudflared_bin)
            .args(["tunnel", "--no-autoupdate", "--metrics"])
            .arg(&metrics)
            .arg("run")
            .env("TUNNEL_TOKEN", &token)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn();
        let mut child = match spawned {
            Ok(child) => child,
            Err(err) => {
                let msg = format!("Could not start cloudflared: {err}");
                tracing::error!("{msg}");
                state.tunnel.update(|s| {
                    s.running = false;
                    s.last_error = Some(msg);
                });
                tokio::select! {
                    changed = rx.changed() => if changed.is_err() { return },
                    _ = sleep(Duration::from_secs(30)) => {}
                }
                continue;
            }
        };
        if let Some(out) = child.stdout.take() {
            tokio::spawn(collect_logs(state.clone(), out));
        }
        if let Some(err) = child.stderr.take() {
            tokio::spawn(collect_logs(state.clone(), err));
        }
        tracing::info!("cloudflared started");
        state.tunnel.update(|s| {
            s.running = true;
            s.metrics = Some(metrics);
            s.last_error = None;
        });

        tokio::select! {
            exit = child.wait() => {
                let msg = match exit {
                    Ok(status) => format!("cloudflared exited ({status})"),
                    Err(err) => format!("cloudflared failed: {err}"),
                };
                tracing::warn!("{msg}");
                state.tunnel.update(|s| {
                    s.running = false;
                    s.restarts += 1;
                    s.last_error = Some(msg);
                });
                tokio::select! {
                    changed = rx.changed() => if changed.is_err() { return },
                    _ = sleep(Duration::from_secs(5)) => {}
                }
            }
            changed = rx.changed() => {
                let _ = child.kill().await;
                state.tunnel.update(|s| s.running = false);
                if changed.is_err() {
                    return;
                }
            }
        }
    }
}

async fn collect_logs(state: AppState, stream: impl AsyncRead + Unpin) {
    let mut lines = BufReader::new(stream).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        tracing::info!(target: "cloudflared", "{line}");
        state.tunnel.update(|s| {
            s.logs.push_back(line);
            while s.logs.len() > LOG_LINES {
                s.logs.pop_front();
            }
        });
    }
}

/// Number of live connections cloudflared holds to the Cloudflare edge.
pub async fn ready_connections(state: &AppState) -> Option<u64> {
    let addr = lock(&state.tunnel.state).metrics.clone()?;
    let url = format!("http://{addr}/ready");
    let ready: Value = state
        .http
        .get(url)
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    ready.get("readyConnections")?.as_u64()
}

fn free_local_addr() -> Option<String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").ok()?;
    Some(listener.local_addr().ok()?.to_string())
}

/// Pushes the tunnel's ingress rules to Cloudflare: every published hostname goes to the gateway.
pub async fn sync_ingress(state: &AppState) -> Result<()> {
    let cf = state.cloudflare().map_err(|e| anyhow!(e.1))?;
    let mut ingress: Vec<Value> = state
        .db
        .routes()?
        .iter()
        // A tunnel switched off leaves the tunnel's routing, as if it did not exist.
        .filter(|r| r.enabled)
        .map(|r| json!({ "hostname": r.hostname, "service": state.config.gate_service }))
        .collect();
    ingress.push(json!({ "service": "http_status:404" }));
    Cloudflare::new(&state.http, &cf.token)
        .put_ingress(&cf.account_id, &cf.tunnel_id, ingress)
        .await
}
