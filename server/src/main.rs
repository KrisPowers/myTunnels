mod admin;
mod cloudflare;
mod code;
mod codes;
mod config;
mod containers;
mod convert;
mod db;
mod docker;
mod gate;
mod guard;
mod mail;
mod metrics;
mod netinfo;
mod oauth;
mod permissions;
mod proxy;
mod secret;
mod state;
mod storage;
mod threads;
mod tls;
mod token;
mod tunnel;
mod util;
mod vault;

use std::net::SocketAddr;

use anyhow::{Context, Result};
use axum::middleware;
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

use crate::config::Config;
use crate::db::Db;
use crate::state::AppState;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

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
    let https = match &state.config.admin_tls_addr {
        Some(addr) => {
            let listener = TcpListener::bind(addr)
                .await
                .with_context(|| format!("cannot listen on {addr}"))?;
            let acceptor = tls::acceptor(&state.config.data_dir.join("tls"))?;
            tracing::info!("admin panel on https://{addr}");
            Some((listener, acceptor))
        }
        None => None,
    };
    tracing::info!("admin panel on http://{}", state.config.admin_addr);
    tracing::info!("gateway on {}", state.config.gate_service);

    admin::prepare_setup_code(&state)?;
    tunnel::spawn(state.clone());
    tokio::spawn(admin::rename_code_address(state.clone()));
    netinfo::spawn(state.clone());
    metrics::spawn();
    convert::spawn(state.clone());
    tokio::spawn(prune_events(state.clone()));

    // With HTTPS on, browsers on other machines are sent there from plain HTTP.
    let mut plain = admin::router(state.clone());
    if let Some(port) = https
        .as_ref()
        .and_then(|(l, _)| l.local_addr().ok())
        .map(|a| a.port())
    {
        plain = plain.layer(middleware::from_fn_with_state(port, tls::send_to_https));
    }
    let admin = axum::serve(
        admin_listener,
        plain.into_make_service_with_connect_info::<SocketAddr>(),
    );
    let secure = async {
        match https {
            Some((listener, acceptor)) => {
                tls::serve(listener, acceptor, admin::router(state.clone())).await
            }
            None => std::future::pending().await,
        }
    };
    // The gateway serves the panel itself to tunnels aimed at the dashboard.
    let gate = axum::serve(
        gate_listener,
        gate::router(state.clone(), admin::router(state.clone())),
    );
    tokio::select! {
        result = admin => result?,
        result = gate => result?,
        result = secure => result?,
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
