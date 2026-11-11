use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use serde_json::Value;

use crate::deploy::{Build, Deploy};
use crate::share::Share;
use crate::util::{lock, random_alnum};
use crate::vault::{self, Vault};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS revoked (
    key TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS routes (
    id TEXT PRIMARY KEY,
    subdomain TEXT NOT NULL,
    zone_id TEXT NOT NULL,
    zone_name TEXT NOT NULL,
    hostname TEXT NOT NULL UNIQUE,
    target_host TEXT,
    target_port INTEGER NOT NULL,
    target_scheme TEXT NOT NULL,
    require_lan INTEGER NOT NULL,
    require_device INTEGER NOT NULL,
    policy_mode TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    dns_record_id TEXT,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    all_routes INTEGER NOT NULL,
    fingerprint TEXT NOT NULL,
    info TEXT NOT NULL,
    note TEXT,
    first_ip TEXT,
    last_ip TEXT,
    country TEXT,
    first_host TEXT,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email TEXT COLLATE NOCASE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    all_routes INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_login INTEGER
);
CREATE TABLE IF NOT EXISTS sign_ins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT,
    ip TEXT,
    country TEXT,
    at INTEGER NOT NULL,
    outcome TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sign_ins_user ON sign_ins (user_id, at);
CREATE INDEX IF NOT EXISTS sign_ins_device ON sign_ins (device_id, at);
CREATE TABLE IF NOT EXISTS flags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
    ip TEXT,
    country TEXT,
    at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    route_id TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    outcome TEXT NOT NULL,
    user_id TEXT,
    device_id TEXT,
    ip TEXT,
    country TEXT,
    at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_route ON events (route_id, at);
CREATE INDEX IF NOT EXISTS events_at ON events (at);
CREATE TABLE IF NOT EXISTS user_devices (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, device_id)
);
CREATE TABLE IF NOT EXISTS user_routes (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    route_id TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, route_id)
);
CREATE TABLE IF NOT EXISTS shares (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    space TEXT NOT NULL,
    paths TEXT NOT NULL,
    password_hash TEXT,
    expires INTEGER,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    opened INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS passkeys (
    id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    rp_id TEXT NOT NULL,
    public_key TEXT NOT NULL,
    sign_count INTEGER NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used INTEGER
);
CREATE INDEX IF NOT EXISTS passkeys_subject ON passkeys (subject);
CREATE TABLE IF NOT EXISTS device_sign_ins (
    device_hash TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS deploys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    repo TEXT NOT NULL,
    url TEXT NOT NULL,
    branch TEXT NOT NULL,
    image TEXT NOT NULL DEFAULT '',
    dockerfile TEXT NOT NULL,
    port INTEGER NOT NULL,
    keep TEXT NOT NULL,
    updates TEXT NOT NULL,
    every INTEGER NOT NULL,
    current INTEGER,
    checked_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS builds (
    deploy_id TEXT NOT NULL REFERENCES deploys(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    commit_id TEXT NOT NULL,
    message TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL,
    image TEXT,
    error TEXT,
    log TEXT NOT NULL DEFAULT '',
    queued_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    PRIMARY KEY (deploy_id, number)
);
CREATE TABLE IF NOT EXISTS limits (
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS forwards (
    id TEXT PRIMARY KEY,
    method TEXT NOT NULL,
    name TEXT NOT NULL,
    target_host TEXT,
    target_port INTEGER NOT NULL,
    protocol TEXT NOT NULL,
    public_port INTEGER NOT NULL,
    public INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    enabled INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
";

/// Columns added to `routes` after its first release, with how to add each.
const ROUTE_MIGRATIONS: [(&str, &str); 9] = [
    ("preserve_host", "preserve_host INTEGER NOT NULL DEFAULT 0"),
    (
        "require_password",
        "require_password INTEGER NOT NULL DEFAULT 0",
    ),
    ("password_hash", "password_hash TEXT"),
    ("require_login", "require_login INTEGER NOT NULL DEFAULT 0"),
    ("login_max", "login_max INTEGER NOT NULL DEFAULT 604800"),
    ("login_idle", "login_idle INTEGER NOT NULL DEFAULT 0"),
    ("require_code", "require_code INTEGER NOT NULL DEFAULT 0"),
    ("oauth", "oauth TEXT NOT NULL DEFAULT ''"),
    ("verify_tls", "verify_tls INTEGER NOT NULL DEFAULT 0"),
];

/// A published tunnel: one hostname on a Cloudflare zone pointing at one local port.
#[derive(Clone, Serialize)]
pub struct Route {
    pub id: String,
    pub subdomain: String,
    pub zone_id: String,
    pub zone_name: String,
    pub hostname: String,
    pub target_host: Option<String>,
    pub target_port: u16,
    pub target_scheme: String,
    pub require_lan: bool,
    /// A password shared for this tunnel alone.
    pub require_password: bool,
    /// Sign-in with an account from Users.
    pub require_login: bool,
    /// After signing in, a code emailed to the account.
    pub require_code: bool,
    /// Third-party providers offered beside the password sign-in.
    pub oauth: Vec<String>,
    /// Seconds after signing in that a visitor must sign in again; 0 is never.
    pub login_max: i64,
    /// Seconds of inactivity that end a sign-in; 0 is never.
    pub login_idle: i64,
    /// "all": every enabled check must pass. "any": one passing check is enough.
    pub policy_mode: String,
    pub enabled: bool,
    /// Send the app the public name as Host instead of its own address.
    pub preserve_host: bool,
    /// Check an HTTPS app's certificate instead of taking any, self-signed included.
    pub verify_tls: bool,
    #[serde(skip)]
    pub password_hash: Option<String>,
    pub password_set: bool,
    pub dns_record_id: Option<String>,
    pub created_at: i64,
}

/// A port opened by the router or by Tailscale, beside the tunnels: `method` is
/// `port` or `tailscale`.
#[derive(Clone, Serialize)]
pub struct Forward {
    pub id: String,
    pub method: String,
    /// What it opens, such as a container's name; empty for a bare port.
    pub name: String,
    pub target_host: Option<String>,
    pub target_port: u16,
    /// `tcp` or `udp` for the router; `http`, `https` or `tcp` for Tailscale.
    pub protocol: String,
    /// The port it is reached on: the router's, or the tailnet machine's.
    pub public_port: u16,
    /// Tailscale only: open to the internet through Funnel, not just the tailnet.
    pub public: bool,
    /// When it closes on its own; 0 is never.
    pub expires_at: i64,
    pub enabled: bool,
    pub created_at: i64,
}

const FORWARD_COLS: &str = "id, method, name, target_host, target_port, protocol, public_port,      public, expires_at, enabled, created_at";

fn forward_row(r: &Row) -> rusqlite::Result<Forward> {
    Ok(Forward {
        id: r.get(0)?,
        method: r.get(1)?,
        name: r.get(2)?,
        target_host: r.get(3)?,
        target_port: r.get(4)?,
        protocol: r.get(5)?,
        public_port: r.get(6)?,
        public: r.get(7)?,
        expires_at: r.get(8)?,
        enabled: r.get(9)?,
        created_at: r.get(10)?,
    })
}

/// Someone who can sign in at tunnels that ask for an account.
#[derive(Clone, Serialize)]
pub struct User {
    pub id: String,
    pub username: String,
    /// What they sign in with, with the password.
    pub email: String,
    pub name: String,
    #[serde(skip)]
    pub password_hash: String,
    pub enabled: bool,
    /// Kept for the column; accounts are added to each tunnel, so it stays false.
    #[serde(skip)]
    pub all_routes: bool,
    pub route_ids: Vec<String>,
    /// The devices this account has signed in from.
    pub device_ids: Vec<String>,
    /// Signs in only from `device_ids`, or from the first device while it has none.
    pub device_lock: bool,
    pub created_at: i64,
    pub last_login: Option<i64>,
    /// Why the account was locked, while it is.
    pub note: Option<String>,
    /// What it may do on the dashboard (see `permissions`).
    pub permissions: Vec<String>,
    /// The most its photos and files may take up, in bytes; 0 for no limit.
    pub storage_limit: u64,
}

impl User {
    /// True when the account holds `key`, or the Admin role, which holds them all.
    pub fn holds(&self, key: &str) -> bool {
        self.permissions.iter().any(|p| p == key || p == ADMIN)
    }
}

/// The Admin role: every permission, including making others admins.
pub const ADMIN: &str = "admin";

/// The Host role: the account made at setup. It holds Admin too, and only it
/// changes itself.
pub const HOST: &str = "host";

/// The host account's ID, under which its app codes, passkeys, tokens and pins
/// have always been kept.
pub const HOST_ID: &str = "admin";

/// Something that happened at a tunnel's door: a page opened, a sign-in or
/// password attempt, a visitor turned away, a device asking for approval.
#[derive(Clone, Serialize)]
pub struct Event {
    pub route_id: String,
    /// "sign-in", "password", "visit" or "device".
    pub kind: String,
    pub outcome: String,
    pub user_id: Option<String>,
    pub device_id: Option<String>,
    pub ip: Option<String>,
    pub country: Option<String>,
    pub at: i64,
}

/// A sign-in from a device new to the account, until someone looks at it.
#[derive(Clone, Serialize)]
pub struct Flag {
    pub id: i64,
    pub user_id: String,
    pub device_id: Option<String>,
    pub ip: Option<String>,
    pub country: Option<String>,
    pub at: i64,
}

/// One attempt to sign in to an account: where from, and how it went
/// ("ok", "failed" or "blocked").
#[derive(Clone, Serialize)]
pub struct SignIn {
    pub user_id: String,
    pub device_id: Option<String>,
    pub ip: Option<String>,
    pub country: Option<String>,
    pub at: i64,
    pub outcome: String,
}

/// A browser met at a tunnel, known by the key it holds.
#[derive(Clone, Serialize)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub info: Value,
    pub first_ip: Option<String>,
    pub last_ip: Option<String>,
    pub country: Option<String>,
    pub first_host: Option<String>,
    pub created_at: i64,
    pub last_seen: i64,
}

const ROUTE_COLS: &str = "id, subdomain, zone_id, zone_name, hostname, target_host, target_port, \
     target_scheme, require_lan, require_device, policy_mode, enabled, dns_record_id, created_at, \
     preserve_host, require_password, password_hash, require_login, login_max, login_idle,      require_code, oauth, verify_tls";

/// A passkey: its credential ID, whose it is, the site it signs in to, and its
/// public key.
#[derive(Clone, Serialize)]
pub struct Passkey {
    pub id: String,
    #[serde(skip)]
    pub subject: String,
    pub rp_id: String,
    #[serde(skip)]
    pub public_key: String,
    #[serde(skip)]
    pub sign_count: u32,
    pub name: String,
    pub created_at: i64,
    pub last_used: Option<i64>,
}

const SHARE_COLS: &str =
    "id, token_hash, space, paths, password_hash, expires, created_by, created_at, opened";

fn share_row(r: &Row) -> rusqlite::Result<Share> {
    let password_hash: Option<String> = r.get(4)?;
    Ok(Share {
        id: r.get(0)?,
        token_hash: r.get(1)?,
        space: r.get(2)?,
        paths: serde_json::from_str(&r.get::<_, String>(3)?).unwrap_or_default(),
        protected: password_hash.is_some(),
        password_hash,
        expires: r.get(5)?,
        created_by: r.get(6)?,
        created_at: r.get(7)?,
        opened: r.get(8)?,
    })
}

const PASSKEY_COLS: &str =
    "id, subject, rp_id, public_key, sign_count, name, created_at, last_used";

fn passkey_row(r: &Row) -> rusqlite::Result<Passkey> {
    Ok(Passkey {
        id: r.get(0)?,
        subject: r.get(1)?,
        rp_id: r.get(2)?,
        public_key: r.get(3)?,
        sign_count: r.get(4)?,
        name: r.get(5)?,
        created_at: r.get(6)?,
        last_used: r.get(7)?,
    })
}

const USER_COLS: &str =
    "id, username, email, name, password_hash, enabled, all_routes, created_at, last_login, note, \
     permissions, storage_limit, device_lock";

const DEVICE_COLS: &str =
    "id, name, info, first_ip, last_ip, country, first_host, created_at, last_seen";

fn route_row(r: &Row) -> rusqlite::Result<Route> {
    Ok(Route {
        id: r.get(0)?,
        subdomain: r.get(1)?,
        zone_id: r.get(2)?,
        zone_name: r.get(3)?,
        hostname: r.get(4)?,
        target_host: r.get(5)?,
        target_port: r.get(6)?,
        target_scheme: r.get(7)?,
        require_lan: r.get(8)?,
        policy_mode: r.get(10)?,
        enabled: r.get(11)?,
        dns_record_id: r.get(12)?,
        created_at: r.get(13)?,
        preserve_host: r.get(14)?,
        require_password: r.get(15)?,
        password_set: r.get::<_, Option<String>>(16)?.is_some(),
        password_hash: r.get(16)?,
        require_login: r.get(17)?,
        login_max: r.get(18)?,
        login_idle: r.get(19)?,
        require_code: r.get(20)?,
        oauth: r
            .get::<_, String>(21)?
            .split(',')
            .filter(|p| !p.is_empty())
            .map(str::to_owned)
            .collect(),
        verify_tls: r.get(22)?,
    })
}

fn user_row(r: &Row) -> rusqlite::Result<User> {
    Ok(User {
        id: r.get(0)?,
        username: r.get(1)?,
        email: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
        name: r.get(3)?,
        password_hash: r.get(4)?,
        enabled: r.get(5)?,
        all_routes: r.get(6)?,
        route_ids: Vec::new(),
        device_ids: Vec::new(),
        created_at: r.get(7)?,
        last_login: r.get(8)?,
        note: r.get(9)?,
        permissions: r
            .get::<_, String>(10)?
            .split(',')
            .filter(|p| !p.is_empty())
            .map(str::to_owned)
            .collect(),
        storage_limit: r.get::<_, i64>(11)?.max(0) as u64,
        device_lock: r.get(12)?,
    })
}

fn device_row(r: &Row) -> rusqlite::Result<Device> {
    let info: String = r.get(2)?;
    Ok(Device {
        id: r.get(0)?,
        name: r.get(1)?,
        info: serde_json::from_str(&info).unwrap_or(Value::Null),
        first_ip: r.get(3)?,
        last_ip: r.get(4)?,
        country: r.get(5)?,
        first_host: r.get(6)?,
        created_at: r.get(7)?,
        last_seen: r.get(8)?,
    })
}

pub struct Db {
    conn: Mutex<Connection>,
    /// Seals the settings that hold secrets.
    vault: Vault,
}

impl Db {
    pub fn open(path: &Path, vault: Vault) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(()))?;
        conn.execute_batch(SCHEMA)?;
        // File System became Code: its address carries on as the repositories',
        // and the folders it gave out, which no repository matches, go.
        conn.execute_batch(
            "UPDATE routes SET target_scheme = 'code' WHERE target_scheme = 'storage';
             DROP TABLE IF EXISTS storage_rules;
             DROP TABLE IF EXISTS repo_access;
             DELETE FROM settings WHERE key IN ('storage_path', 'storage_enabled');",
        )?;
        let user_columns: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('users')")?
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        if !user_columns.iter().any(|c| c == "note") {
            conn.execute_batch("ALTER TABLE users ADD COLUMN note TEXT;")?;
        }
        if !user_columns.iter().any(|c| c == "permissions") {
            conn.execute_batch(
                "ALTER TABLE users ADD COLUMN permissions TEXT NOT NULL DEFAULT '';",
            )?;
        }
        if !user_columns.iter().any(|c| c == "device_lock") {
            conn.execute_batch(
                "ALTER TABLE users ADD COLUMN device_lock INTEGER NOT NULL DEFAULT 0;",
            )?;
        }
        if !user_columns.iter().any(|c| c == "storage_limit") {
            conn.execute_batch(
                "ALTER TABLE users ADD COLUMN storage_limit INTEGER NOT NULL DEFAULT 0;",
            )?;
        }
        let have: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('routes')")?
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        for (column, ddl) in ROUTE_MIGRATIONS {
            if !have.iter().any(|c| c == column) {
                conn.execute_batch(&format!("ALTER TABLE routes ADD COLUMN {ddl};"))?;
            }
        }
        // Tunnels no longer approve devices. One that relied on that alone asks for
        // a sign-in instead, so it never opens to everyone.
        conn.execute_batch(
            "UPDATE routes SET require_login = 1
                 WHERE require_device = 1 AND require_lan = 0 AND require_password = 0;
             UPDATE routes SET require_device = 0 WHERE require_device = 1;
             DROP TABLE IF EXISTS device_routes;",
        )?;
        // Device IDs became 256 characters; earlier short ones are replaced before
        // foreign keys are enforced.
        let short: Vec<String> = conn
            .prepare("SELECT id FROM devices WHERE length(id) != 256")?
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        for old in short {
            let new = random_alnum(256);
            conn.execute(
                "UPDATE devices SET id = ?2 WHERE id = ?1",
                params![old, new],
            )?;
        }
        // Accounts are added to each tunnel; any that could open every tunnel keep
        // exactly the tunnels there are now.
        conn.execute_batch(
            "INSERT OR IGNORE INTO user_routes (user_id, route_id)
                 SELECT u.id, r.id FROM users u, routes r WHERE u.all_routes = 1;
             UPDATE users SET all_routes = 0 WHERE all_routes = 1;",
        )?;
        // Containers can run an image as well as build a repository.
        let deploy_columns: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('deploys')")?
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        if !deploy_columns.iter().any(|c| c == "image") {
            conn.execute_batch("ALTER TABLE deploys ADD COLUMN image TEXT NOT NULL DEFAULT '';")?;
        }
        // The host account was kept in settings before it was an account like
        // any other; it moves into users, as the account it is.
        let host_rows: i64 =
            conn.query_row("SELECT COUNT(*) FROM users WHERE id = ?1", [HOST_ID], |r| {
                r.get(0)
            })?;
        let old = |key: &str| -> rusqlite::Result<Option<String>> {
            conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
                r.get(0)
            })
            .optional()
        };
        if let (0, Some(hash)) = (host_rows, old("admin_password")?) {
            let mut username = old("admin_username")?.unwrap_or_else(|| "host".into());
            let taken: i64 = conn.query_row(
                "SELECT COUNT(*) FROM users WHERE username = ?1 COLLATE NOCASE",
                [&username],
                |r| r.get(0),
            )?;
            if taken > 0 {
                username.push_str("-host");
            }
            conn.execute(
                "INSERT INTO users (id, username, email, name, password_hash, enabled, all_routes,
                     created_at, last_login, note, permissions)
                 VALUES (?1, ?2, ?3, '', ?4, 1, 0, ?5, NULL, NULL, ?6)",
                params![
                    HOST_ID,
                    username,
                    old("admin_email")?.unwrap_or_default(),
                    hash,
                    crate::util::now(),
                    format!("{HOST},{ADMIN}")
                ],
            )?;
        }
        conn.execute_batch(
            "DELETE FROM settings WHERE key IN ('admin_username', 'admin_email', 'admin_password')
                 AND EXISTS (SELECT 1 FROM users WHERE id = 'admin');",
        )?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        // Accounts made before devices were linked take the devices they already
        // signed in from. This runs once, so a device unlinked later stays unlinked.
        let linked_before: Option<String> = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'devices_linked_from_history'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if linked_before.is_none() {
            conn.execute_batch(
                "INSERT OR IGNORE INTO user_devices (user_id, device_id)
                     SELECT s.user_id, s.device_id FROM sign_ins s
                     JOIN users u ON u.id = s.user_id
                     JOIN devices d ON d.id = s.device_id
                     WHERE s.outcome = 'ok';
                 INSERT INTO settings (key, value) VALUES ('devices_linked_from_history', '1');",
            )?;
        }
        let db = Self {
            conn: Mutex::new(conn),
            vault,
        };
        db.seal_secrets()?;
        Ok(db)
    }

    fn conn(&self) -> MutexGuard<'_, Connection> {
        lock(&self.conn)
    }

    /// Seals secrets stored before they were sealed, and says so loudly when some
    /// were sealed with another key, which then count as never entered.
    fn seal_secrets(&self) -> Result<()> {
        let rows: Vec<(String, String)> = self
            .conn()
            .prepare("SELECT key, value FROM settings")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        for (key, value) in rows.into_iter().filter(|(k, _)| vault::is_secret(k)) {
            if !vault::is_sealed(&value) {
                self.set_setting(&key, &value)?;
            } else if self.vault.open(&key, &value).is_none() {
                tracing::error!(
                    "the stored {key} was sealed with another secrets key; enter it again"
                );
            }
        }
        Ok(())
    }

    pub fn setting(&self, key: &str) -> Result<Option<String>> {
        let value: Option<String> = self
            .conn()
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
                r.get(0)
            })
            .optional()?;
        Ok(value.and_then(|v| {
            if vault::is_sealed(&v) {
                self.vault.open(key, &v)
            } else {
                Some(v)
            }
        }))
    }

    /// Signed-out tokens and subjects, `(key, at, expires)`. Ones past use are dropped.
    pub fn revocations(&self, now: i64) -> Result<Vec<(String, i64, i64)>> {
        let conn = self.conn();
        conn.execute("DELETE FROM revoked WHERE expires <= ?1", [now])?;
        let mut stmt = conn.prepare("SELECT key, at, expires FROM revoked")?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    pub fn revoke(&self, key: &str, at: i64, expires: i64) -> Result<()> {
        self.conn().execute(
            "INSERT INTO revoked (key, at, expires) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET at = excluded.at, expires = excluded.expires",
            params![key, at, expires],
        )?;
        Ok(())
    }

    /// Each container's kept resources, by its name, as JSON.
    pub fn limits(&self) -> Result<Vec<(String, String)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT name, value FROM limits")?;
        let list = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(list)
    }

    pub fn set_limits(&self, name: &str, value: &str) -> Result<()> {
        self.conn().execute(
            "INSERT INTO limits (name, value) VALUES (?1, ?2)
             ON CONFLICT(name) DO UPDATE SET value = excluded.value",
            params![name, value],
        )?;
        Ok(())
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        let sealed;
        let value = if vault::is_secret(key) {
            sealed = self.vault.seal(key, value)?;
            sealed.as_str()
        } else {
            value
        };
        self.conn().execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn delete_setting(&self, key: &str) -> Result<()> {
        self.conn()
            .execute("DELETE FROM settings WHERE key = ?1", [key])?;
        Ok(())
    }

    pub fn routes(&self) -> Result<Vec<Route>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {ROUTE_COLS} FROM routes ORDER BY hostname"
        ))?;
        let routes = stmt
            .query_map([], route_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(routes)
    }

    pub fn route(&self, id: &str) -> Result<Option<Route>> {
        let route = self
            .conn()
            .query_row(
                &format!("SELECT {ROUTE_COLS} FROM routes WHERE id = ?1"),
                [id],
                route_row,
            )
            .optional()?;
        Ok(route)
    }

    pub fn insert_route(&self, r: &Route) -> Result<()> {
        self.conn().execute(
            &format!(
                "INSERT INTO routes ({ROUTE_COLS})
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)"
            ),
            params![
                r.id,
                r.subdomain,
                r.zone_id,
                r.zone_name,
                r.hostname,
                r.target_host,
                r.target_port,
                r.target_scheme,
                r.require_lan,
                false,
                r.policy_mode,
                r.enabled,
                r.dns_record_id,
                r.created_at,
                r.preserve_host,
                r.require_password,
                r.password_hash,
                r.require_login,
                r.login_max,
                r.login_idle,
                r.require_code,
                r.oauth.join(","),
                r.verify_tls,
            ],
        )?;
        Ok(())
    }

    pub fn update_route(&self, r: &Route) -> Result<()> {
        self.conn().execute(
            "UPDATE routes SET target_host = ?2, target_port = ?3, target_scheme = ?4,
                 require_lan = ?5, policy_mode = ?6, enabled = ?7,
                 preserve_host = ?8, require_password = ?9, password_hash = ?10,
                 require_login = ?11, login_max = ?12, login_idle = ?13, require_code = ?14,
                 oauth = ?15, verify_tls = ?16
             WHERE id = ?1",
            params![
                r.id,
                r.target_host,
                r.target_port,
                r.target_scheme,
                r.require_lan,
                r.policy_mode,
                r.enabled,
                r.preserve_host,
                r.require_password,
                r.password_hash,
                r.require_login,
                r.login_max,
                r.login_idle,
                r.require_code,
                r.oauth.join(","),
                r.verify_tls,
            ],
        )?;
        Ok(())
    }

    /// Moves a tunnel to another address.
    pub fn move_route(&self, r: &Route) -> Result<()> {
        self.conn().execute(
            "UPDATE routes SET subdomain = ?2, zone_id = ?3, zone_name = ?4, hostname = ?5,
                 dns_record_id = ?6
             WHERE id = ?1",
            params![
                r.id,
                r.subdomain,
                r.zone_id,
                r.zone_name,
                r.hostname,
                r.dns_record_id,
            ],
        )?;
        Ok(())
    }

    pub fn delete_route(&self, id: &str) -> Result<()> {
        self.conn()
            .execute("DELETE FROM routes WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn forwards(&self) -> Result<Vec<Forward>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {FORWARD_COLS} FROM forwards ORDER BY created_at"
        ))?;
        let list = stmt
            .query_map([], forward_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(list)
    }

    pub fn forward(&self, id: &str) -> Result<Option<Forward>> {
        let found = self
            .conn()
            .query_row(
                &format!("SELECT {FORWARD_COLS} FROM forwards WHERE id = ?1"),
                [id],
                forward_row,
            )
            .optional()?;
        Ok(found)
    }

    pub fn insert_forward(&self, f: &Forward) -> Result<()> {
        self.conn().execute(
            &format!(
                "INSERT INTO forwards ({FORWARD_COLS})
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)"
            ),
            params![
                f.id,
                f.method,
                f.name,
                f.target_host,
                f.target_port,
                f.protocol,
                f.public_port,
                f.public,
                f.expires_at,
                f.enabled,
                f.created_at,
            ],
        )?;
        Ok(())
    }

    /// Saves what can change once it is open: on or off, who reaches it, and
    /// when it closes.
    pub fn update_forward(&self, f: &Forward) -> Result<()> {
        self.conn().execute(
            "UPDATE forwards SET public = ?2, expires_at = ?3, enabled = ?4 WHERE id = ?1",
            params![f.id, f.public, f.expires_at, f.enabled],
        )?;
        Ok(())
    }

    pub fn delete_forward(&self, id: &str) -> Result<()> {
        self.conn()
            .execute("DELETE FROM forwards WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn devices(&self) -> Result<Vec<Device>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {DEVICE_COLS} FROM devices ORDER BY last_seen DESC"
        ))?;
        let devices = stmt
            .query_map([], device_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(devices)
    }

    fn device_where(&self, column: &str, value: &str) -> Result<Option<Device>> {
        let device = self
            .conn()
            .query_row(
                &format!("SELECT {DEVICE_COLS} FROM devices WHERE {column} = ?1"),
                [value],
                device_row,
            )
            .optional()?;
        Ok(device)
    }

    pub fn device(&self, id: &str) -> Result<Option<Device>> {
        self.device_where("id", id)
    }

    pub fn device_by_token(&self, token_hash: &str) -> Result<Option<Device>> {
        self.device_where("token_hash", token_hash)
    }

    pub fn insert_device(&self, d: &Device, token_hash: &str) -> Result<()> {
        self.conn().execute(
            "INSERT INTO devices (id, token_hash, name, status, all_routes, fingerprint, info,
                 first_ip, last_ip, country, first_host, created_at, last_seen)
             VALUES (?1, ?2, ?3, 'seen', 0, '', ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                d.id,
                token_hash,
                d.name,
                d.info.to_string(),
                d.first_ip,
                d.last_ip,
                d.country,
                d.first_host,
                d.created_at,
                d.last_seen,
            ],
        )?;
        Ok(())
    }

    pub fn save_device(&self, d: &Device) -> Result<()> {
        self.conn().execute(
            "UPDATE devices SET name = ?2, info = ?3, last_ip = ?4, country = ?5, last_seen = ?6
             WHERE id = ?1",
            params![
                d.id,
                d.name,
                d.info.to_string(),
                d.last_ip,
                d.country,
                d.last_seen,
            ],
        )?;
        Ok(())
    }

    /// Makes `from` and `into` one device, `into`: its accounts and history move
    /// over, and `from` is gone.
    pub fn merge_device(&self, from: &str, into: &str) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT OR IGNORE INTO user_devices (user_id, device_id)
                 SELECT user_id, ?2 FROM user_devices WHERE device_id = ?1",
            params![from, into],
        )?;
        tx.execute(
            "UPDATE sign_ins SET device_id = ?2 WHERE device_id = ?1",
            params![from, into],
        )?;
        tx.execute(
            "UPDATE events SET device_id = ?2 WHERE device_id = ?1",
            params![from, into],
        )?;
        tx.execute(
            "UPDATE flags SET device_id = ?2 WHERE device_id = ?1",
            params![from, into],
        )?;
        tx.execute("DELETE FROM devices WHERE id = ?1", [from])?;
        tx.commit()?;
        Ok(())
    }

    pub fn delete_device(&self, id: &str) -> Result<()> {
        self.conn()
            .execute("DELETE FROM devices WHERE id = ?1", [id])?;
        Ok(())
    }

    /// Keeps at most `keep` devices that no account signed in from and no one
    /// named, dropping the longest unseen, so passing visitors cannot fill the
    /// database.
    pub fn prune_seen(&self, keep: i64) -> Result<()> {
        self.conn().execute(
            "DELETE FROM devices WHERE id IN (
                 SELECT id FROM devices WHERE name = ''
                     AND id NOT IN (SELECT device_id FROM user_devices)
                 ORDER BY last_seen DESC LIMIT -1 OFFSET ?1)",
            [keep],
        )?;
        Ok(())
    }

    pub fn users(&self) -> Result<Vec<User>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!("SELECT {USER_COLS} FROM users ORDER BY username"))?;
        let mut users = stmt
            .query_map([], user_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut stmt = conn.prepare("SELECT user_id, route_id FROM user_routes")?;
        let pairs = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut stmt = conn.prepare("SELECT user_id, device_id FROM user_devices")?;
        let linked = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for user in &mut users {
            user.device_ids = linked
                .iter()
                .filter(|(owner, _)| *owner == user.id)
                .map(|(_, device)| device.clone())
                .collect();
            user.route_ids = pairs
                .iter()
                .filter(|(owner, _)| *owner == user.id)
                .map(|(_, route)| route.clone())
                .collect();
        }
        Ok(users)
    }

    pub fn user(&self, id: &str) -> Result<Option<User>> {
        Ok(self.users()?.into_iter().find(|u| u.id == id))
    }

    /// The account that signs in with this email.
    /// The host account, once setup has made it.
    pub fn host(&self) -> Result<Option<User>> {
        self.user(HOST_ID)
    }

    pub fn user_by_email(&self, email: &str) -> Result<Option<User>> {
        let email = email.trim();
        Ok(self
            .users()?
            .into_iter()
            .find(|u| !u.email.is_empty() && u.email.eq_ignore_ascii_case(email)))
    }

    pub fn save_user(&self, u: &User) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute(
            &format!(
                "INSERT INTO users ({USER_COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
                 ON CONFLICT(id) DO UPDATE SET username = excluded.username,
                     email = excluded.email, name = excluded.name,
                     password_hash = excluded.password_hash, enabled = excluded.enabled,
                     all_routes = excluded.all_routes, last_login = excluded.last_login,
                     note = excluded.note, permissions = excluded.permissions,
                     storage_limit = excluded.storage_limit, device_lock = excluded.device_lock"
            ),
            params![
                u.id,
                u.username,
                u.email,
                u.name,
                u.password_hash,
                u.enabled,
                u.all_routes,
                u.created_at,
                u.last_login,
                u.note,
                u.permissions.join(","),
                i64::try_from(u.storage_limit).unwrap_or(i64::MAX),
                u.device_lock,
            ],
        )?;
        tx.execute("DELETE FROM user_devices WHERE user_id = ?1", [&u.id])?;
        for device_id in &u.device_ids {
            tx.execute(
                "INSERT OR IGNORE INTO user_devices (user_id, device_id) VALUES (?1, ?2)",
                params![u.id, device_id],
            )?;
        }
        tx.execute("DELETE FROM user_routes WHERE user_id = ?1", [&u.id])?;
        for route_id in &u.route_ids {
            tx.execute(
                "INSERT OR IGNORE INTO user_routes (user_id, route_id) VALUES (?1, ?2)",
                params![u.id, route_id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Records a sign-in attempt, keeping 90 days of them.
    pub fn add_sign_in(&self, s: &SignIn) -> Result<()> {
        let conn = self.conn();
        conn.execute(
            "INSERT INTO sign_ins (user_id, device_id, ip, country, at, outcome)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![s.user_id, s.device_id, s.ip, s.country, s.at, s.outcome],
        )?;
        conn.execute("DELETE FROM sign_ins WHERE at < ?1", [s.at - 90 * 86_400])?;
        Ok(())
    }

    /// Notes a sign-in from a device new to the account.
    pub fn add_flag(&self, s: &SignIn) -> Result<()> {
        self.conn().execute(
            "INSERT INTO flags (user_id, device_id, ip, country, at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![s.user_id, s.device_id, s.ip, s.country, s.at],
        )?;
        Ok(())
    }

    /// Sign-ins from new devices no one has looked at yet, newest first.
    pub fn flags(&self) -> Result<Vec<Flag>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, user_id, device_id, ip, country, at FROM flags ORDER BY at DESC LIMIT 200",
        )?;
        let list = stmt
            .query_map([], |r| {
                Ok(Flag {
                    id: r.get(0)?,
                    user_id: r.get(1)?,
                    device_id: r.get(2)?,
                    ip: r.get(3)?,
                    country: r.get(4)?,
                    at: r.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(list)
    }

    pub fn delete_flag(&self, id: i64) -> Result<()> {
        self.conn()
            .execute("DELETE FROM flags WHERE id = ?1", [id])?;
        Ok(())
    }

    /// The latest sign-in attempts of an account, or from a device, newest first.
    pub fn sign_ins(&self, column: &str, value: &str, limit: i64) -> Result<Vec<SignIn>> {
        let column = if column == "device_id" {
            "device_id"
        } else {
            "user_id"
        };
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT user_id, device_id, ip, country, at, outcome FROM sign_ins
             WHERE {column} = ?1 ORDER BY at DESC LIMIT ?2"
        ))?;
        let list = stmt
            .query_map(params![value, limit], |r| {
                Ok(SignIn {
                    user_id: r.get(0)?,
                    device_id: r.get(1)?,
                    ip: r.get(2)?,
                    country: r.get(3)?,
                    at: r.get(4)?,
                    outcome: r.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(list)
    }

    /// Records what happened at a tunnel. `prune_events` keeps it to 90 days.
    pub fn add_event(&self, e: &Event) -> Result<()> {
        let conn = self.conn();
        conn.execute(
            "INSERT INTO events (route_id, kind, outcome, user_id, device_id, ip, country, at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                e.route_id,
                e.kind,
                e.outcome,
                e.user_id,
                e.device_id,
                e.ip,
                e.country,
                e.at
            ],
        )?;
        Ok(())
    }

    pub fn add_share(&self, s: &Share) -> Result<()> {
        self.conn().execute(
            "INSERT INTO shares (id, token_hash, space, paths, password_hash, expires, created_by, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                s.id,
                s.token_hash,
                s.space,
                serde_json::to_string(&s.paths)?,
                s.password_hash,
                s.expires,
                s.created_by,
                s.created_at
            ],
        )?;
        Ok(())
    }

    /// Every share link, newest first; expired ones are forgotten.
    pub fn shares(&self) -> Result<Vec<Share>> {
        let conn = self.conn();
        conn.execute(
            "DELETE FROM shares WHERE expires IS NOT NULL AND expires < ?1",
            [crate::util::now()],
        )?;
        let mut stmt = conn.prepare(&format!(
            "SELECT {SHARE_COLS} FROM shares ORDER BY created_at DESC"
        ))?;
        let rows = stmt
            .query_map([], share_row)?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    pub fn share_by_token(&self, token_hash: &str) -> Result<Option<Share>> {
        Ok(self
            .conn()
            .query_row(
                &format!("SELECT {SHARE_COLS} FROM shares WHERE token_hash = ?1"),
                [token_hash],
                share_row,
            )
            .optional()?)
    }

    pub fn count_share_open(&self, id: &str) -> Result<()> {
        self.conn()
            .execute("UPDATE shares SET opened = opened + 1 WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn delete_share(&self, id: &str) -> Result<()> {
        self.conn()
            .execute("DELETE FROM shares WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn add_passkey(&self, p: &Passkey) -> Result<()> {
        self.conn().execute(
            "INSERT INTO passkeys (id, subject, rp_id, public_key, sign_count, name, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                p.id,
                p.subject,
                p.rp_id,
                p.public_key,
                p.sign_count,
                p.name,
                p.created_at
            ],
        )?;
        Ok(())
    }

    pub fn passkey(&self, id: &str) -> Result<Option<Passkey>> {
        Ok(self
            .conn()
            .query_row(
                &format!("SELECT {PASSKEY_COLS} FROM passkeys WHERE id = ?1"),
                [id],
                passkey_row,
            )
            .optional()?)
    }

    /// The passkeys of `subject`, the admin or an account, newest first.
    pub fn passkeys_of(&self, subject: &str) -> Result<Vec<Passkey>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {PASSKEY_COLS} FROM passkeys WHERE subject = ?1 ORDER BY created_at DESC"
        ))?;
        let rows = stmt
            .query_map([subject], passkey_row)?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    pub fn touch_passkey(&self, id: &str, sign_count: u32, at: i64) -> Result<()> {
        self.conn().execute(
            "UPDATE passkeys SET sign_count = ?2, last_used = ?3 WHERE id = ?1",
            params![id, sign_count, at],
        )?;
        Ok(())
    }

    /// Removes one of `subject`'s passkeys; false when it has no such passkey.
    pub fn delete_passkey(&self, subject: &str, id: &str) -> Result<bool> {
        Ok(self.conn().execute(
            "DELETE FROM passkeys WHERE subject = ?1 AND id = ?2",
            [subject, id],
        )? > 0)
    }

    pub fn delete_passkeys_of(&self, subject: &str) -> Result<()> {
        self.conn()
            .execute("DELETE FROM passkeys WHERE subject = ?1", [subject])?;
        Ok(())
    }

    /// Remembers the sign-in a device made, so every tunnel finds it.
    pub fn set_device_sign_in(&self, device_hash: &str, token: &str, expires: i64) -> Result<()> {
        let conn = self.conn();
        conn.execute(
            "INSERT INTO device_sign_ins (device_hash, token, expires) VALUES (?1, ?2, ?3)
             ON CONFLICT(device_hash) DO UPDATE SET token = ?2, expires = ?3",
            params![device_hash, token, expires],
        )?;
        conn.execute(
            "DELETE FROM device_sign_ins WHERE expires < ?1",
            [crate::util::now()],
        )?;
        Ok(())
    }

    /// The sign-in a device made, if it has not expired.
    pub fn device_sign_in(&self, device_hash: &str, now: i64) -> Result<Option<String>> {
        Ok(self
            .conn()
            .query_row(
                "SELECT token FROM device_sign_ins WHERE device_hash = ?1 AND expires > ?2",
                params![device_hash, now],
                |r| r.get(0),
            )
            .optional()?)
    }

    pub fn forget_device_sign_in(&self, device_hash: &str) -> Result<()> {
        self.conn().execute(
            "DELETE FROM device_sign_ins WHERE device_hash = ?1",
            [device_hash],
        )?;
        Ok(())
    }

    /// Forgets tunnel events older than `before`.
    pub fn prune_events(&self, before: i64) -> Result<()> {
        self.conn()
            .execute("DELETE FROM events WHERE at < ?1", [before])?;
        Ok(())
    }

    /// A tunnel's latest events, newest first.
    pub fn events(&self, route_id: &str, limit: i64) -> Result<Vec<Event>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT route_id, kind, outcome, user_id, device_id, ip, country, at FROM events
             WHERE route_id = ?1 ORDER BY at DESC, id DESC LIMIT ?2",
        )?;
        let list = stmt
            .query_map(params![route_id, limit], |r| {
                Ok(Event {
                    route_id: r.get(0)?,
                    kind: r.get(1)?,
                    outcome: r.get(2)?,
                    user_id: r.get(3)?,
                    device_id: r.get(4)?,
                    ip: r.get(5)?,
                    country: r.get(6)?,
                    at: r.get(7)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(list)
    }

    pub fn delete_user(&self, id: &str) -> Result<()> {
        let conn = self.conn();
        conn.execute("DELETE FROM users WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn deploys(&self) -> Result<Vec<Deploy>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!("SELECT {DEPLOY_COLS} FROM deploys ORDER BY name"))?;
        let rows = stmt
            .query_map([], deploy_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn deploy(&self, id: &str) -> Result<Option<Deploy>> {
        let d = self
            .conn()
            .query_row(
                &format!("SELECT {DEPLOY_COLS} FROM deploys WHERE id = ?1"),
                [id],
                deploy_row,
            )
            .optional()?;
        Ok(d)
    }

    pub fn insert_deploy(&self, d: &Deploy) -> Result<()> {
        self.conn().execute(
            "INSERT INTO deploys (id, name, repo, url, branch, dockerfile, port, keep, updates,
                 every, current, checked_at, created_at, image)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                d.id,
                d.name,
                d.repo,
                d.url,
                d.branch,
                d.dockerfile,
                d.port,
                d.keep.join("\n"),
                d.updates,
                d.every,
                d.current,
                d.checked_at,
                d.created_at,
                d.image
            ],
        )?;
        Ok(())
    }

    /// Saves what can be changed: the source, how it is built and run, and
    /// how it updates.
    pub fn save_deploy(&self, d: &Deploy) -> Result<()> {
        self.conn().execute(
            "UPDATE deploys SET repo = ?2, url = ?3, branch = ?4, dockerfile = ?5, port = ?6,
                 keep = ?7, updates = ?8, every = ?9, image = ?10 WHERE id = ?1",
            params![
                d.id,
                d.repo,
                d.url,
                d.branch,
                d.dockerfile,
                d.port,
                d.keep.join("\n"),
                d.updates,
                d.every,
                d.image
            ],
        )?;
        Ok(())
    }

    pub fn set_current(&self, id: &str, number: i64) -> Result<()> {
        self.conn().execute(
            "UPDATE deploys SET current = ?2 WHERE id = ?1",
            params![id, number],
        )?;
        Ok(())
    }

    pub fn set_checked(&self, id: &str, at: i64) -> Result<()> {
        self.conn().execute(
            "UPDATE deploys SET checked_at = ?2 WHERE id = ?1",
            params![id, at],
        )?;
        Ok(())
    }

    pub fn delete_deploy(&self, id: &str) -> Result<()> {
        let conn = self.conn();
        conn.execute("DELETE FROM builds WHERE deploy_id = ?1", [id])?;
        conn.execute("DELETE FROM deploys WHERE id = ?1", [id])?;
        Ok(())
    }

    /// A container's builds, newest first, without their logs.
    pub fn builds(&self, deploy_id: &str, limit: i64) -> Result<Vec<Build>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {BUILD_COLS} FROM builds WHERE deploy_id = ?1 ORDER BY number DESC LIMIT ?2"
        ))?;
        let rows = stmt
            .query_map(params![deploy_id, limit], build_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// One build with its log.
    pub fn build(&self, deploy_id: &str, number: i64) -> Result<Option<(Build, String)>> {
        let found = self
            .conn()
            .query_row(
                &format!(
                    "SELECT {BUILD_COLS}, log FROM builds WHERE deploy_id = ?1 AND number = ?2"
                ),
                params![deploy_id, number],
                |r| Ok((build_row(r)?, r.get(11)?)),
            )
            .optional()?;
        Ok(found)
    }

    /// Adds a build to the queue and gives back its number.
    pub fn queue_build(&self, deploy_id: &str, commit: &str, reason: &str, at: i64) -> Result<i64> {
        let conn = self.conn();
        let number: i64 = conn.query_row(
            "SELECT COALESCE(MAX(number), 0) + 1 FROM builds WHERE deploy_id = ?1",
            [deploy_id],
            |r| r.get(0),
        )?;
        conn.execute(
            "INSERT INTO builds (deploy_id, number, commit_id, message, reason, status, queued_at)
             VALUES (?1, ?2, ?3, '', ?4, 'queued', ?5)",
            params![deploy_id, number, commit, reason, at],
        )?;
        Ok(number)
    }

    /// The build waiting longest.
    pub fn next_build(&self) -> Result<Option<Build>> {
        let b = self
            .conn()
            .query_row(
                &format!(
                    "SELECT {BUILD_COLS} FROM builds WHERE status = 'queued'
                     ORDER BY queued_at, number LIMIT 1"
                ),
                [],
                build_row,
            )
            .optional()?;
        Ok(b)
    }

    pub fn has_waiting_build(&self, deploy_id: &str) -> Result<bool> {
        let n: i64 = self.conn().query_row(
            "SELECT COUNT(*) FROM builds WHERE deploy_id = ?1 AND status IN ('queued', 'building')",
            [deploy_id],
            |r| r.get(0),
        )?;
        Ok(n > 0)
    }

    pub fn save_build(&self, b: &Build) -> Result<()> {
        self.conn().execute(
            "UPDATE builds SET commit_id = ?3, message = ?4, status = ?5, image = ?6, error = ?7,
                 started_at = ?8, finished_at = ?9
             WHERE deploy_id = ?1 AND number = ?2",
            params![
                b.deploy_id,
                b.number,
                b.commit,
                b.message,
                b.status,
                b.image,
                b.error,
                b.started_at,
                b.finished_at
            ],
        )?;
        Ok(())
    }

    pub fn set_build_log(&self, deploy_id: &str, number: i64, log: &str) -> Result<()> {
        self.conn().execute(
            "UPDATE builds SET log = ?3 WHERE deploy_id = ?1 AND number = ?2",
            params![deploy_id, number, log],
        )?;
        Ok(())
    }

    pub fn delete_build(&self, deploy_id: &str, number: i64) -> Result<()> {
        self.conn().execute(
            "DELETE FROM builds WHERE deploy_id = ?1 AND number = ?2",
            params![deploy_id, number],
        )?;
        Ok(())
    }

    /// Builds that were running when myTunnels stopped end as failed.
    pub fn end_interrupted_builds(&self, at: i64) -> Result<()> {
        self.conn().execute(
            "UPDATE builds SET status = 'failed', error = 'Stopped when myTunnels restarted',
                 finished_at = ?1 WHERE status = 'building'",
            [at],
        )?;
        Ok(())
    }
}

const DEPLOY_COLS: &str = "id, name, repo, url, branch, dockerfile, port, keep, updates, every, \
     current, checked_at, created_at, image";

fn deploy_row(r: &Row) -> rusqlite::Result<Deploy> {
    let keep: String = r.get(7)?;
    Ok(Deploy {
        id: r.get(0)?,
        name: r.get(1)?,
        repo: r.get(2)?,
        url: r.get(3)?,
        branch: r.get(4)?,
        dockerfile: r.get(5)?,
        port: r.get(6)?,
        keep: keep
            .lines()
            .filter(|l| !l.is_empty())
            .map(str::to_owned)
            .collect(),
        updates: r.get(8)?,
        every: r.get(9)?,
        current: r.get(10)?,
        checked_at: r.get(11)?,
        created_at: r.get(12)?,
        image: r.get(13)?,
    })
}

const BUILD_COLS: &str = "deploy_id, number, commit_id, message, reason, status, image, error, \
     queued_at, started_at, finished_at";

fn build_row(r: &Row) -> rusqlite::Result<Build> {
    Ok(Build {
        deploy_id: r.get(0)?,
        number: r.get(1)?,
        commit: r.get(2)?,
        message: r.get(3)?,
        reason: r.get(4)?,
        status: r.get(5)?,
        image: r.get(6)?,
        error: r.get(7)?,
        queued_at: r.get(8)?,
        started_at: r.get(9)?,
        finished_at: r.get(10)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_host_kept_in_settings_becomes_an_account() {
        let path = std::env::temp_dir().join(format!("host-{}.db", random_alnum(12)));
        let db = Db::open(&path, Vault::new(&[3; 32])).unwrap();
        db.set_setting("admin_username", "sam").unwrap();
        db.set_setting("admin_email", "sam@example.com").unwrap();
        db.set_setting("admin_password", "hash").unwrap();
        drop(db);
        let db = Db::open(&path, Vault::new(&[3; 32])).unwrap();
        let host = db.host().unwrap().unwrap();
        assert_eq!(
            (host.username.as_str(), host.email.as_str()),
            ("sam", "sam@example.com")
        );
        assert_eq!(host.password_hash, "hash");
        assert!(host.holds(HOST) && host.holds(ADMIN));
        assert!(db.setting("admin_password").unwrap().is_none());
        assert_eq!(db.users().unwrap().len(), 1);
    }

    #[test]
    fn secrets_are_sealed_at_rest_and_read_back_plain() {
        let path = std::env::temp_dir().join(format!("vault-{}.db", random_alnum(12)));
        let db = Db::open(&path, Vault::new(&[3; 32])).unwrap();
        db.set_setting("cf_token", "token-value").unwrap();
        db.set_setting("upstream_host", "nas").unwrap();
        let raw = |key: &str| -> String {
            db.conn()
                .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
                    r.get(0)
                })
                .unwrap()
        };
        assert!(vault::is_sealed(&raw("cf_token")));
        assert_eq!(raw("upstream_host"), "nas");
        assert_eq!(
            db.setting("cf_token").unwrap().as_deref(),
            Some("token-value")
        );
        drop(db);
        let other = Db::open(&path, Vault::new(&[4; 32])).unwrap();
        assert_eq!(other.setting("cf_token").unwrap(), None);
        drop(other);
        for end in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{end}", path.display()));
        }
    }
}
