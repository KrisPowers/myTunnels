use std::collections::HashMap;
use std::net::IpAddr;
use std::ops::Deref;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use anyhow::Result;
use axum::http::StatusCode;

use crate::config::Config;
use crate::db::{Db, Device, Route, User};
use crate::netinfo::{self, Cidr};
use crate::tunnel::Tunnel;
use crate::util::{lock, now, ApiError};

/// Everything the gateway needs per request, rebuilt from the database after every change.
pub struct Snapshot {
    pub routes: HashMap<String, Route>,
    pub devices: HashMap<String, Device>,
    pub users: HashMap<String, User>,
    /// The hostname that keeps every browser's device key, so tunnels on other domains
    /// can share it: the oldest tunnel's.
    pub hub: Option<String>,
    pub upstream_host: String,
    pub trusted: Vec<Cidr>,
}

/// A signed-in visitor: whose session it is (a device, tunnel or account id), and a
/// tag that stops it working once what it was granted on changes.
pub struct Session {
    pub subject: String,
    pub tag: String,
    pub expires: i64,
    /// When it was opened, and when it last let a request through.
    pub created: i64,
    pub seen: i64,
    /// The hash of the device key it was opened on, if it is bound to one.
    pub device: String,
}

/// One step of sharing a device key across domains, kept for a minute.
pub enum Hop {
    /// A tunnel sent the browser to the hub for its key and wants it back here.
    Return { url: String, expires: i64 },
    /// The hub hands a key to this host, which then goes on to `path`.
    Claim {
        host: String,
        path: String,
        token: String,
        expires: i64,
    },
}

impl Hop {
    fn expires(&self) -> i64 {
        match self {
            Hop::Return { expires, .. } | Hop::Claim { expires, .. } => *expires,
        }
    }
}

pub struct CfSettings {
    pub token: String,
    pub account_id: String,
    pub tunnel_id: String,
}

/// Failed password and sign-in attempts allowed per window before refusing.
const MAX_FAILURES: u32 = 5;
const FAILURE_WINDOW: i64 = 15 * 60;

pub struct Inner {
    pub config: Config,
    pub db: Db,
    /// For the Cloudflare API and other outbound calls.
    pub http: reqwest::Client,
    /// For forwarding requests to local apps.
    pub proxy: reqwest::Client,
    pub tunnel: Tunnel,
    pub public_ips: RwLock<Vec<IpAddr>>,
    /// Approved devices, by session cookie.
    pub device_sessions: Mutex<HashMap<String, Session>>,
    /// Tunnel passwords entered, by session cookie.
    pub pass_sessions: Mutex<HashMap<String, Session>>,
    /// Accounts signed in, by session cookie.
    pub user_sessions: Mutex<HashMap<String, Session>>,
    pub admin_sessions: Mutex<HashMap<String, i64>>,
    pub hops: Mutex<HashMap<String, Hop>>,
    failures: Mutex<HashMap<String, (u32, i64)>>,
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
            device_sessions: Mutex::new(HashMap::new()),
            pass_sessions: Mutex::new(HashMap::new()),
            user_sessions: Mutex::new(HashMap::new()),
            admin_sessions: Mutex::new(HashMap::new()),
            hops: Mutex::new(HashMap::new()),
            failures: Mutex::new(HashMap::new()),
            snapshot: RwLock::new(Arc::new(Snapshot {
                routes: HashMap::new(),
                devices: HashMap::new(),
                users: HashMap::new(),
                hub: None,
                upstream_host: String::new(),
                trusted: Vec::new(),
            })),
        }));
        state.reload()?;
        Ok(state)
    }

    pub fn reload(&self) -> Result<()> {
        let routes = self.db.routes()?;
        let hub = routes
            .iter()
            .min_by_key(|r| (r.created_at, r.id.clone()))
            .map(|r| r.hostname.clone());
        let routes = routes
            .into_iter()
            .map(|r| (r.hostname.clone(), r))
            .collect();
        let devices = self
            .db
            .devices()?
            .into_iter()
            .map(|d| (d.id.clone(), d))
            .collect();
        let users = self
            .db
            .users()?
            .into_iter()
            .map(|u| (u.id.clone(), u))
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
            users,
            hub,
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

    /// True once `key` has failed too often in the current window.
    pub fn locked_out(&self, key: &str) -> bool {
        let now = now();
        lock(&self.failures)
            .get(key)
            .is_some_and(|(count, since)| *count >= MAX_FAILURES && now - since < FAILURE_WINDOW)
    }

    pub fn record_failure(&self, key: &str) {
        let now = now();
        let mut failures = lock(&self.failures);
        failures.retain(|_, (_, since)| now - *since < FAILURE_WINDOW);
        let entry = failures.entry(key.to_owned()).or_insert((0, now));
        entry.0 += 1;
    }

    pub fn clear_failures(&self, key: &str) {
        lock(&self.failures).remove(key);
    }

    pub fn put_hop(&self, id: String, hop: Hop) {
        let now = now();
        let mut hops = lock(&self.hops);
        hops.retain(|_, h| h.expires() > now);
        hops.insert(id, hop);
    }

    /// Takes a hop once; an expired one is gone.
    pub fn take_hop(&self, id: &str) -> Option<Hop> {
        lock(&self.hops).remove(id).filter(|h| h.expires() > now())
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

/// Opens a session and returns its cookie value. Expired sessions are dropped on the way.
pub fn open_session(
    sessions: &Mutex<HashMap<String, Session>>,
    subject: &str,
    tag: &str,
    device: &str,
    ttl: i64,
) -> String {
    let sid = crate::util::random_hex(32);
    let now = now();
    let mut map = lock(sessions);
    map.retain(|_, s| s.expires > now);
    map.insert(
        sid.clone(),
        Session {
            subject: subject.to_owned(),
            tag: tag.to_owned(),
            expires: now + ttl,
        },
    );
    sid
}

/// The subject and tag of a live session.
pub fn session(sessions: &Mutex<HashMap<String, Session>>, sid: &str) -> Option<(String, String)> {
    let now = now();
    lock(sessions)
        .get(sid)
        .filter(|s| s.expires > now)
        .map(|s| (s.subject.clone(), s.tag.clone()))
}
