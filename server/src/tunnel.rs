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
    /// What `cloudflared --version` said, such as `2026.10.7`.
    version: Option<String>,
}

#[derive(Serialize)]
pub struct TunnelView {
    pub running: bool,
    pub restarts: u32,
    pub last_error: Option<String>,
    pub logs: Vec<String>,
    pub version: Option<String>,
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
            version: s.version.clone(),
        }
    }

    fn update(&self, f: impl FnOnce(&mut TunnelState)) {
        f(&mut lock(&self.state));
    }
}

/// Keeps cloudflared running for as long as a tunnel token is configured.
pub fn spawn(state: AppState) {
    tokio::spawn(read_version(state.clone()));
    tokio::spawn(supervise(state));
}

/// Notes which cloudflared this is, so the panel can say when it is getting old.
async fn read_version(state: AppState) {
    let out = Command::new(&state.config.cloudflared_bin)
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .await;
    let version = out
        .ok()
        .and_then(|out| version_of(&String::from_utf8_lossy(&out.stdout)));
    state.tunnel.update(|s| s.version = version);
}

/// `2026.10.7` from `cloudflared version 2026.10.7 (built ...)`.
fn version_of(said: &str) -> Option<String> {
    said.split_whitespace()
        .skip_while(|w| *w != "version")
        .nth(1)
        .map(str::to_owned)
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

/// Pushes the tunnel's ingress rules to Cloudflare: every published hostname goes to
/// the gateway. Rules this tunnel already had that myTunnels did not make (another
/// machine's hostnames, say) are kept, as is the rest of its configuration.
pub async fn sync_ingress(state: &AppState) -> Result<()> {
    let cf = state.cloudflare().map_err(|e| anyhow!(e.1))?;
    let api = Cloudflare::new(&state.http, &cf.token);
    let current = api.tunnel_config(&cf.account_id, &cf.tunnel_id).await?;
    let mut ours: Vec<String> = state
        .db
        .routes()?
        .into_iter()
        // A tunnel switched off leaves the tunnel's routing, as if it did not exist.
        .filter(|r| r.enabled)
        .map(|r| r.hostname)
        .collect();
    // Mail's own addresses, which the gateway answers itself.
    ours.extend(crate::mailserver::web::hosts());
    // Redirects, which the gateway answers itself.
    for host in crate::redirect::hosts(&crate::redirect::load(&state.db)) {
        if !ours.contains(&host) {
            ours.push(host);
        }
    }
    let config = merge_ingress(current, &ours, &state.config.gate_service);
    api.put_config(&cf.account_id, &cf.tunnel_id, config).await
}

/// `current` with its ingress made of `ours` (to the gateway), then every rule for a
/// hostname that is not the gateway's and not one of `ours`, then a 404 for the rest.
fn merge_ingress(current: Value, ours: &[String], gate: &str) -> Value {
    let mut config = match current {
        Value::Object(map) => map,
        _ => serde_json::Map::new(),
    };
    let theirs: Vec<Value> = config
        .get("ingress")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|rule| {
            let host = rule.get("hostname").and_then(Value::as_str);
            let service = rule.get("service").and_then(Value::as_str);
            host.is_some_and(|h| !ours.iter().any(|o| o == h)) && service != Some(gate)
        })
        .cloned()
        .collect();
    let mut ingress: Vec<Value> = ours
        .iter()
        .map(|h| json!({ "hostname": h, "service": gate }))
        .collect();
    ingress.extend(theirs);
    ingress.push(json!({ "service": "http_status:404" }));
    config.insert("ingress".into(), Value::Array(ingress));
    Value::Object(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn other_rules_and_settings_are_kept() {
        let current = json!({
            "ingress": [
                { "hostname": "old.example.com", "service": "http://127.0.0.1:7080" },
                { "hostname": "nas.example.com", "service": "http://10.0.0.5:5000" },
                { "hostname": "app.example.com", "service": "http://10.0.0.6:80" },
                { "service": "http_status:404" }
            ],
            "warp-routing": { "enabled": true }
        });
        let ours = ["app.example.com".to_owned()];
        let merged = merge_ingress(current, &ours, "http://127.0.0.1:7080");
        assert_eq!(
            merged["ingress"],
            json!([
                { "hostname": "app.example.com", "service": "http://127.0.0.1:7080" },
                { "hostname": "nas.example.com", "service": "http://10.0.0.5:5000" },
                { "service": "http_status:404" }
            ])
        );
        assert_eq!(merged["warp-routing"]["enabled"], true);
    }

    #[test]
    fn reads_the_version() {
        assert_eq!(
            version_of(
                "cloudflared version 2026.10.7 (built 2026-10-30-1200 UTC)
"
            )
            .as_deref(),
            Some("2026.10.7")
        );
        assert_eq!(version_of(""), None);
    }

    #[test]
    fn a_new_tunnel_gets_only_ours() {
        let merged = merge_ingress(Value::Null, &["a.example.com".to_owned()], "g");
        assert_eq!(merged["ingress"].as_array().map(Vec::len), Some(2));
    }
}
