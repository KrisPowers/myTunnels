mod admin;
mod apps;
mod archive;
mod cloudflare;
mod codes;
mod config;
mod containers;
mod convert;
mod db;
mod deploy;
mod docker;
mod dupes;
mod forward;
mod gate;
mod grant;
mod guard;
mod hardware;
mod images;
mod limits;
mod locations;
mod machine;
mod mail;
mod mailserver;
mod metrics;
mod netinfo;
mod oauth;
mod passkey;
mod permissions;
mod pow;
mod proxy;
mod redirect;
mod release;
mod registrar;
mod secret;
mod service;
mod share;
mod state;
mod storage;
mod tls;
mod token;
mod totp;
mod tunnel;
mod update;
mod util;
mod vault;

use std::io::IsTerminal;
use std::net::SocketAddr;

use anyhow::{Context, Result};
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

use crate::config::Config;
use crate::db::Db;
use crate::state::AppState;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with_ansi(std::io::stdout().is_terminal())
        .init();

    match std::env::args().nth(1).as_deref() {
        // This computer's own figures, for a Dashboard that runs inside Docker Desktop.
        Some("host") => return metrics::serve_host().await,
        Some(name @ ("start" | "stop" | "status" | "run")) => return service::command(name),
        // The Hardware page's sensor task, put in place or taken away with administrator rights.
        Some("hardware") => return hardware::command(std::env::args().nth(2).as_deref()).await,
        // What setup grants once with administrator rights, so nothing asks later.
        Some("grant") => {
            return grant::command(&std::env::args().skip(2).collect::<Vec<_>>()).await
        }
        _ => {}
    }

    let mut config = Config::from_env();
    config.default_upstream_host = netinfo::detect_upstream(&config.default_upstream_host).await;
    std::fs::create_dir_all(&config.data_dir)
        .with_context(|| format!("cannot create {}", config.data_dir.display()))?;
    let key = vault::load_key(&config.secret_key_file)?;
    let db = Db::open(&config.data_dir.join("gateway.db"), vault::Vault::new(&key))?;
    let state = AppState::new(config, db)?;

    let admin_listener = TcpListener::bind(&state.config.admin_addr)
        .await
        .with_context(|| format!("cannot listen on {}", state.config.admin_addr))?;
    let gate_listener = TcpListener::bind(&state.config.gate_addr)
        .await
        .with_context(|| format!("cannot listen on {}", state.config.gate_addr))?;
    tracing::info!("admin panel on http://{}", state.config.admin_addr);
    tracing::info!("gateway on {}", state.config.gate_service);

    tunnel::spawn(state.clone());
    #[cfg(windows)]
    locations::refresh_helper();
    tokio::spawn(admin::remove_git_address(state.clone()));
    netinfo::spawn(state.clone());
    forward::spawn(state.clone());
    metrics::spawn();
    hardware::spawn(state.clone());
    convert::spawn(state.clone());
    deploy::spawn(state.clone());
    limits::spawn(state.clone());
    if let Err(err) = mailserver::spawn(state.clone()) {
        tracing::error!("mail did not start: {err:#}");
    }
    tokio::spawn(prune_events(state.clone()));

    let admin = axum::serve(
        admin_listener,
        admin::router(state.clone()).into_make_service_with_connect_info::<SocketAddr>(),
    );
    // The gateway serves the panel itself to tunnels aimed at the dashboard.
    let gate = axum::serve(
        gate_listener,
        gate::router(state.clone(), admin::router(state.clone())),
    );
    tokio::select! {
        result = admin => result?,
        result = gate => result?,
        _ = shutdown_signal() => tracing::info!("shutting down"),
    }
    Ok(())
}

/// Keeps 90 days of tunnel events, pruned hourly rather than on every insert.
async fn prune_events(state: AppState) {
    let mut every = tokio::time::interval(std::time::Duration::from_secs(3600));
    loop {
        every.tick().await;
        if let Err(err) = state.db.prune_events(util::now() - 90 * 86_400) {
            tracing::warn!("could not prune events: {err:#}");
        }
    }
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        match signal(SignalKind::terminate()) {
            Ok(mut term) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = term.recv() => {}
                }
            }
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
