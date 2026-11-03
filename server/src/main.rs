mod admin;
mod cloudflare;
mod config;
mod db;
mod gate;
mod guard;
mod netinfo;
mod proxy;
mod secret;
mod state;
mod token;
mod tunnel;
mod util;

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
        .init();

    let mut config = Config::from_env();
    config.default_upstream_host = netinfo::detect_upstream(&config.default_upstream_host).await;
    std::fs::create_dir_all(&config.data_dir)
        .with_context(|| format!("cannot create {}", config.data_dir.display()))?;
    let db = Db::open(&config.data_dir.join("gateway.db"))?;
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
    netinfo::spawn(state.clone());

    let admin = axum::serve(admin_listener, admin::router(state.clone()));
    let gate = axum::serve(gate_listener, gate::router(state.clone()));
    tokio::select! {
        result = admin => result?,
        result = gate => result?,
        _ = shutdown_signal() => tracing::info!("shutting down"),
    }
    Ok(())
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
