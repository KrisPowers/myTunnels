use std::collections::HashMap;
use std::net::IpAddr;
use std::ops::Deref;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use anyhow::Result;
use axum::http::StatusCode;

use crate::config::Config;
use crate::db::{Db, Device, Route};
use crate::netinfo::{self, Cidr};
use crate::tunnel::Tunnel;
use crate::util::ApiError;

/// Everything the gateway needs per request, rebuilt from the database after every change.
pub struct Snapshot {
    pub routes: HashMap<String, Route>,
    pub devices: HashMap<String, Device>,
    pub upstream_host: String,
    pub trusted: Vec<Cidr>,
}

pub struct GateSession {
    pub device_id: String,
    pub expires: i64,
}

pub struct CfSettings {
    pub token: String,
    pub account_id: String,
    pub tunnel_id: String,
}

pub struct Inner {
    pub config: Config,
    pub db: Db,
    /// For the Cloudflare API and other outbound calls.
    pub http: reqwest::Client,
    /// For forwarding requests to local apps.
    pub proxy: reqwest::Client,
    pub tunnel: Tunnel,
    pub public_ips: RwLock<Vec<IpAddr>>,
    pub gate_sessions: Mutex<HashMap<String, GateSession>>,
    pub admin_sessions: Mutex<HashMap<String, i64>>,
    snapshot: RwLock<Arc<Snapshot>>,
}

#[derive(Clone)]
pub struct AppState(Arc<Inner>);

impl Deref for AppState {
    type Target = Inner;

    fn deref(&self) -> &Inner {
        &self.0
    }
}

impl AppState {
    pub fn new(config: Config, db: Db) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()?;
        let proxy = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .http1_only()
            // Local apps commonly serve self-signed certificates.
            .danger_accept_invalid_certs(true)
            .connect_timeout(Duration::from_secs(10))
            .build()?;
        let tunnel = Tunnel::new(db.setting("cf_tunnel_token")?);
        let state = Self(Arc::new(Inner {
            config,
            db,
            http,
            proxy,
            tunnel,
            public_ips: RwLock::new(Vec::new()),
            gate_sessions: Mutex::new(HashMap::new()),
            admin_sessions: Mutex::new(HashMap::new()),
            snapshot: RwLock::new(Arc::new(Snapshot {
                routes: HashMap::new(),
                devices: HashMap::new(),
                upstream_host: String::new(),
                trusted: Vec::new(),
            })),
        }));
        state.reload()?;
        Ok(state)
    }

    pub fn reload(&self) -> Result<()> {
        let routes = self
            .db
            .routes()?
            .into_iter()
            .map(|r| (r.hostname.clone(), r))
            .collect();
        let devices = self
            .db
            .devices()?
            .into_iter()
            .map(|d| (d.id.clone(), d))
            .collect();
        let upstream_host = self
            .db
            .setting("upstream_host")?
            .unwrap_or_else(|| self.config.default_upstream_host.clone());
        let trusted =
            netinfo::parse_networks(&self.db.setting("trusted_networks")?.unwrap_or_default())
                .unwrap_or_default();
        let snapshot = Arc::new(Snapshot {
            routes,
            devices,
            upstream_host,
            trusted,
        });
        *self.snapshot.write().unwrap_or_else(|e| e.into_inner()) = snapshot;
        Ok(())
    }

    pub fn snapshot(&self) -> Arc<Snapshot> {
        self.snapshot
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn public_ips(&self) -> Vec<IpAddr> {
        self.public_ips
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// True when the client is on the same network as this host, or on a trusted network.
    pub fn is_local(&self, snap: &Snapshot, ip: IpAddr) -> bool {
        snap.trusted.iter().any(|net| net.contains(ip))
            || netinfo::same_network(&self.public_ips(), ip)
    }

    pub fn cloudflare(&self) -> Result<CfSettings, ApiError> {
        let get = |key| self.db.setting(key).map_err(ApiError::from);
        match (
            get("cf_token")?,
            get("cf_account_id")?,
            get("cf_tunnel_id")?,
        ) {
            (Some(token), Some(account_id), Some(tunnel_id)) => Ok(CfSettings {
                token,
                account_id,
                tunnel_id,
            }),
            _ => Err(ApiError(
                StatusCode::PRECONDITION_FAILED,
                "Connect Cloudflare in Settings first".into(),
            )),
        }
    }
}
