use std::collections::HashMap;
use std::net::IpAddr;
use std::ops::Deref;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use anyhow::Result;
use axum::http::StatusCode;

use crate::codes::Codes;
use crate::config::Config;
use crate::db::{Db, Device, Route, User};
use crate::netinfo::{self, Cidr};
use crate::token::{self, Claims};
use crate::tunnel::Tunnel;
use crate::util::{lock, now, random_hex, ApiError};

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

/// One kind of session. Each is a signed token (see `token`); the store keeps only
/// when each was last used, for idle limits.
pub struct Sessions {
    kind: &'static str,
    seen: Mutex<HashMap<String, (i64, i64)>>,
}

impl Sessions {
    fn new(kind: &'static str) -> Self {
        Self {
            kind,
            seen: Mutex::new(HashMap::new()),
        }
    }
}

/// The longest any session lasts, so a subject's sign-out can be forgotten after it.
const LONGEST_SESSION: i64 = 31 * 86_400;

/// One step of a trip away and back: sharing a device key across domains, or
/// signing in through another service. Each is used once and kept only briefly.
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
    /// The dashboard's device key, going to each of `hosts` in turn (one per domain)
    /// so this browser is one device there too, then back to `back`.
    Plant {
        token: String,
        hosts: Vec<String>,
        back: String,
        expires: i64,
    },
    /// A visitor at tunnel `host` went to sign in with `provider`, from this device.
    OAuth {
        provider: String,
        host: String,
        path: String,
        device_hash: String,
        device_id: Option<String>,
        verifier: String,
        expires: i64,
    },
}

/// Where a sign-in through another service ended up.
pub enum Outcome {
    /// Signed in: the session token.
    Session(String),
    /// A code was emailed: its ticket, and where it went.
    Code { ticket: String, sent_to: String },
    /// Refused, and why.
    Refused(String),
}

impl Hop {
    fn expires(&self) -> i64 {
        match self {
            Hop::Return { expires, .. }
            | Hop::Claim { expires, .. }
            | Hop::Plant { expires, .. }
            | Hop::OAuth { expires, .. } => *expires,
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
    /// The same, for apps whose HTTPS certificate is checked.
    pub proxy_verified: reqwest::Client,
    pub tunnel: Tunnel,
    pub public_ips: RwLock<Vec<IpAddr>>,
    /// Approved devices.
    pub device_sessions: Sessions,
    /// Tunnel passwords entered.
    pub pass_sessions: Sessions,
    /// Accounts signed in.
    pub user_sessions: Sessions,
    pub admin_sessions: Sessions,
    /// Signs every session token; made on first start.
    token_key: Vec<u8>,
    /// Signed-out tokens (`jti:<id>`) and subjects (`<kind>:<id>`), with when.
    revoked: Mutex<HashMap<String, i64>>,
    /// When this process started: a session's last use is never taken as earlier.
    started: i64,
    pub hops: Mutex<HashMap<String, Hop>>,
    /// Sign-ins waiting for an emailed code.
    pub codes: Codes,
    failures: Mutex<HashMap<String, (u32, i64)>>,
    /// Requests counted per key and window, for rate limits.
    hits: Mutex<HashMap<String, (u32, i64)>>,
    /// Keys refused until a time, such as a device that tried several accounts.
    blocked: Mutex<HashMap<String, i64>>,
    /// Distinct values seen per key, with when, such as the emails a device tried.
    distinct: Mutex<HashMap<String, Vec<(String, i64)>>>,
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
        let proxy_client = || {
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .no_proxy()
                .http1_only()
                .connect_timeout(Duration::from_secs(10))
        };
        // Local apps commonly serve self-signed certificates; a tunnel can ask
        // for its app's certificate to be checked instead.
        let proxy = proxy_client().danger_accept_invalid_certs(true).build()?;
        let proxy_verified = proxy_client().build()?;
        let tunnel = Tunnel::new(db.setting("cf_tunnel_token")?);
        let token_key = match db.setting("token_key")? {
            Some(key) => hex::decode(key)?,
            None => {
                let key = random_hex(32);
                db.set_setting("token_key", &key)?;
                hex::decode(key)?
            }
        };
        let revoked = db
            .revocations(now())?
            .into_iter()
            .map(|(key, at, _)| (key, at))
            .collect();
        let state = Self(Arc::new(Inner {
            config,
            db,
            http,
            proxy,
            proxy_verified,
            tunnel,
            public_ips: RwLock::new(Vec::new()),
            device_sessions: Sessions::new("device"),
            pass_sessions: Sessions::new("pass"),
            user_sessions: Sessions::new("user"),
            admin_sessions: Sessions::new("admin"),
            token_key,
            revoked: Mutex::new(revoked),
            started: now(),
            hops: Mutex::new(HashMap::new()),
            codes: Codes::default(),
            failures: Mutex::new(HashMap::new()),
            hits: Mutex::new(HashMap::new()),
            blocked: Mutex::new(HashMap::new()),
            distinct: Mutex::new(HashMap::new()),
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
            .filter(|r| r.enabled)
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

    /// Counts a request under `key`; false once more than `max` came in `window` seconds.
    pub fn allow(&self, key: &str, max: u32, window: i64) -> bool {
        let now = now();
        let mut hits = lock(&self.hits);
        if hits.len() > 50_000 {
            hits.retain(|_, (_, since)| now - *since < 3600);
        }
        let entry = hits.entry(key.to_owned()).or_insert((0, now));
        if now - entry.1 >= window {
            *entry = (0, now);
        }
        entry.0 += 1;
        entry.0 <= max
    }

    /// Refuses `key` for `seconds`.
    pub fn block(&self, key: &str, seconds: i64) {
        let now = now();
        let mut blocked = lock(&self.blocked);
        blocked.retain(|_, until| *until > now);
        blocked.insert(key.to_owned(), now + seconds);
    }

    pub fn is_blocked(&self, key: &str) -> bool {
        lock(&self.blocked)
            .get(key)
            .is_some_and(|until| *until > now())
    }

    /// Notes `value` under `key` and returns how many different values it has had
    /// in the last `window` seconds.
    pub fn distinct(&self, key: &str, value: &str, window: i64) -> usize {
        let now = now();
        let mut all = lock(&self.distinct);
        if all.len() > 50_000 {
            all.retain(|_, seen| seen.iter().any(|(_, at)| now - at < window));
        }
        let seen = all.entry(key.to_owned()).or_default();
        seen.retain(|(_, at)| now - at < window);
        if !seen.iter().any(|(v, _)| v == value) {
            seen.push((value.to_owned(), now));
        }
        seen.len()
    }

    pub fn clear_failures(&self, key: &str) {
        lock(&self.failures).remove(key);
    }

    /// Opens a session and returns its token, the cookie value. `mfa` marks one
    /// opened with an emailed code as well.
    pub fn open_session(
        &self,
        store: &Sessions,
        subject: &str,
        tag: &str,
        device: &str,
        ttl: i64,
        mfa: bool,
    ) -> String {
        let now = now();
        let claims = Claims {
            jti: random_hex(16),
            kind: store.kind.to_owned(),
            sub: subject.to_owned(),
            tag: tag.to_owned(),
            dev: device.to_owned(),
            mfa,
            iat: now,
            exp: now + ttl,
        };
        let mut seen = lock(&store.seen);
        seen.retain(|_, (_, expires)| *expires > now);
        seen.insert(claims.jti.clone(), (now, claims.exp));
        token::sign(&self.token_key, &claims)
    }

    /// The session a token holds, if it is genuine, of this kind, unexpired and not
    /// signed out.
    pub fn session(&self, store: &Sessions, value: &str) -> Option<SessionInfo> {
        let c = token::verify(&self.token_key, value, now())?;
        if c.kind != store.kind {
            return None;
        }
        {
            let revoked = lock(&self.revoked);
            if revoked.contains_key(&format!("jti:{}", c.jti))
                || revoked
                    .get(&format!("{}:{}", c.kind, c.sub))
                    .is_some_and(|at| c.iat <= *at)
            {
                return None;
            }
        }
        let seen = lock(&store.seen)
            .get(&c.jti)
            .map_or(c.iat.max(self.started), |(seen, _)| *seen);
        Some(SessionInfo {
            jti: c.jti,
            subject: c.sub,
            tag: c.tag,
            created: c.iat,
            seen,
            device: c.dev,
            mfa: c.mfa,
            expires: c.exp,
        })
    }

    /// Marks a session as used just now.
    pub fn touch_session(&self, store: &Sessions, session: &SessionInfo) {
        lock(&store.seen).insert(session.jti.clone(), (now(), session.expires));
    }

    /// Signs out one session for good.
    pub fn end_session(&self, store: &Sessions, session: &SessionInfo) {
        lock(&store.seen).remove(&session.jti);
        self.revoke(format!("jti:{}", session.jti), now(), session.expires);
    }

    /// Signs out every session of a device, tunnel or account opened until now.
    pub fn end_sessions_of(&self, store: &Sessions, subject: &str) {
        let now = now();
        self.revoke(
            format!("{}:{subject}", store.kind),
            now,
            now + LONGEST_SESSION,
        );
    }

    fn revoke(&self, key: String, at: i64, expires: i64) {
        if let Err(err) = self.db.revoke(&key, at, expires) {
            tracing::warn!("cannot save a sign-out: {err:#}");
        }
        lock(&self.revoked).insert(key, at);
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

/// What a live session holds.
pub struct SessionInfo {
    pub jti: String,
    pub subject: String,
    pub tag: String,
    pub created: i64,
    pub seen: i64,
    pub device: String,
    pub mfa: bool,
    pub expires: i64,
}
