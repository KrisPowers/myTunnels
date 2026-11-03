use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use serde_json::Value;

use crate::util::{lock, random_alnum};

const SCHEMA: &str = "
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
CREATE TABLE IF NOT EXISTS device_routes (
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    route_id TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
    PRIMARY KEY (device_id, route_id)
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
CREATE TABLE IF NOT EXISTS user_routes (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    route_id TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, route_id)
);
";

/// Columns added to `routes` after its first release, with how to add each.
const ROUTE_MIGRATIONS: [(&str, &str); 6] = [
    ("preserve_host", "preserve_host INTEGER NOT NULL DEFAULT 0"),
    (
        "require_password",
        "require_password INTEGER NOT NULL DEFAULT 0",
    ),
    ("password_hash", "password_hash TEXT"),
    ("require_login", "require_login INTEGER NOT NULL DEFAULT 0"),
    ("login_max", "login_max INTEGER NOT NULL DEFAULT 604800"),
    ("login_idle", "login_idle INTEGER NOT NULL DEFAULT 0"),
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
    pub require_device: bool,
    /// A password shared for this tunnel alone.
    pub require_password: bool,
    /// Sign-in with an account from Users.
    pub require_login: bool,
    /// Seconds after signing in that a visitor must sign in again; 0 is never.
    pub login_max: i64,
    /// Seconds of inactivity that end a sign-in; 0 is never.
    pub login_idle: i64,
    /// "all": every enabled check must pass. "any": one passing check is enough.
    pub policy_mode: String,
    pub enabled: bool,
    /// Send the app the public name as Host instead of its own address.
    pub preserve_host: bool,
    #[serde(skip)]
    pub password_hash: Option<String>,
    pub password_set: bool,
    pub dns_record_id: Option<String>,
    pub created_at: i64,
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
    pub all_routes: bool,
    pub route_ids: Vec<String>,
    pub created_at: i64,
    pub last_login: Option<i64>,
    /// Why the account was locked, while it is.
    pub note: Option<String>,
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

/// A browser that has asked for access through the gateway.
#[derive(Clone, Serialize)]
pub struct Device {
    pub id: String,
    pub name: String,
    /// "seen" (identified, never asked), "pending", "approved" or "denied".
    pub status: String,
    pub all_routes: bool,
    pub route_ids: Vec<String>,
    #[serde(skip)]
    pub fingerprint: String,
    pub info: Value,
    pub note: Option<String>,
    pub first_ip: Option<String>,
    pub last_ip: Option<String>,
    pub country: Option<String>,
    pub first_host: Option<String>,
    pub created_at: i64,
    pub last_seen: i64,
}

const ROUTE_COLS: &str = "id, subdomain, zone_id, zone_name, hostname, target_host, target_port, \
     target_scheme, require_lan, require_device, policy_mode, enabled, dns_record_id, created_at, \
     preserve_host, require_password, password_hash, require_login, login_max, login_idle";

const USER_COLS: &str =
    "id, username, email, name, password_hash, enabled, all_routes, created_at, last_login, note";

const DEVICE_COLS: &str = "id, name, status, all_routes, fingerprint, info, note, first_ip, \
     last_ip, country, first_host, created_at, last_seen";

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
        require_device: r.get(9)?,
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
        created_at: r.get(7)?,
        last_login: r.get(8)?,
        note: r.get(9)?,
    })
}

fn device_row(r: &Row) -> rusqlite::Result<Device> {
    let info: String = r.get(5)?;
    Ok(Device {
        id: r.get(0)?,
        name: r.get(1)?,
        status: r.get(2)?,
        all_routes: r.get(3)?,
        route_ids: Vec::new(),
        fingerprint: r.get(4)?,
        info: serde_json::from_str(&info).unwrap_or(Value::Null),
        note: r.get(6)?,
        first_ip: r.get(7)?,
        last_ip: r.get(8)?,
        country: r.get(9)?,
        first_host: r.get(10)?,
        created_at: r.get(11)?,
        last_seen: r.get(12)?,
    })
}

fn grants(conn: &Connection, device_id: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT route_id FROM device_routes WHERE device_id = ?1")?;
    let ids = stmt
        .query_map([device_id], |r| r.get(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    Ok(ids)
}

pub struct Db(Mutex<Connection>);

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(()))?;
        conn.execute_batch(SCHEMA)?;
        let user_columns: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('users')")?
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        if !user_columns.iter().any(|c| c == "note") {
            conn.execute_batch("ALTER TABLE users ADD COLUMN note TEXT;")?;
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
        // Device IDs became 256 characters; earlier short ones are replaced, with
        // their grants, before foreign keys are enforced.
        let short: Vec<String> = conn
            .prepare("SELECT id FROM devices WHERE length(id) != 256")?
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        for old in short {
            let new = random_alnum(256);
            conn.execute(
                "UPDATE device_routes SET device_id = ?2 WHERE device_id = ?1",
                params![old, new],
            )?;
            conn.execute(
                "UPDATE devices SET id = ?2 WHERE id = ?1",
                params![old, new],
            )?;
        }
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        Ok(Self(Mutex::new(conn)))
    }

    fn conn(&self) -> MutexGuard<'_, Connection> {
        lock(&self.0)
    }

    pub fn setting(&self, key: &str) -> Result<Option<String>> {
        let value = self
            .conn()
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
                r.get(0)
            })
            .optional()?;
        Ok(value)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.conn().execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
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
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)"
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
                r.require_device,
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
            ],
        )?;
        Ok(())
    }

    pub fn update_route(&self, r: &Route) -> Result<()> {
        self.conn().execute(
            "UPDATE routes SET target_host = ?2, target_port = ?3, target_scheme = ?4,
                 require_lan = ?5, require_device = ?6, policy_mode = ?7, enabled = ?8,
                 preserve_host = ?9, require_password = ?10, password_hash = ?11,
                 require_login = ?12
             WHERE id = ?1",
            params![
                r.id,
                r.target_host,
                r.target_port,
                r.target_scheme,
                r.require_lan,
                r.require_device,
                r.policy_mode,
                r.enabled,
                r.preserve_host,
                r.require_password,
                r.password_hash,
                r.require_login,
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

    pub fn devices(&self) -> Result<Vec<Device>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {DEVICE_COLS} FROM devices ORDER BY last_seen DESC"
        ))?;
        let mut devices = stmt
            .query_map([], device_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut stmt = conn.prepare("SELECT device_id, route_id FROM device_routes")?;
        let pairs = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for device in &mut devices {
            device.route_ids = pairs
                .iter()
                .filter(|(owner, _)| *owner == device.id)
                .map(|(_, route)| route.clone())
                .collect();
        }
        Ok(devices)
    }

    fn device_where(&self, column: &str, value: &str) -> Result<Option<Device>> {
        let conn = self.conn();
        let device = conn
            .query_row(
                &format!("SELECT {DEVICE_COLS} FROM devices WHERE {column} = ?1"),
                [value],
                device_row,
            )
            .optional()?;
        match device {
            Some(mut device) => {
                device.route_ids = grants(&conn, &device.id)?;
                Ok(Some(device))
            }
            None => Ok(None),
        }
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
                 note, first_ip, last_ip, country, first_host, created_at, last_seen)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                d.id,
                token_hash,
                d.name,
                d.status,
                d.all_routes,
                d.fingerprint,
                d.info.to_string(),
                d.note,
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

    /// Saves everything about a device except its route grants.
    pub fn save_device(&self, d: &Device) -> Result<()> {
        self.conn().execute(
            "UPDATE devices SET name = ?2, status = ?3, all_routes = ?4, fingerprint = ?5,
                 info = ?6, note = ?7, last_ip = ?8, country = ?9, last_seen = ?10
             WHERE id = ?1",
            params![
                d.id,
                d.name,
                d.status,
                d.all_routes,
                d.fingerprint,
                d.info.to_string(),
                d.note,
                d.last_ip,
                d.country,
                d.last_seen,
            ],
        )?;
        Ok(())
    }

    pub fn set_grants(&self, device_id: &str, route_ids: &[String]) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM device_routes WHERE device_id = ?1",
            [device_id],
        )?;
        for route_id in route_ids {
            tx.execute(
                "INSERT OR IGNORE INTO device_routes (device_id, route_id) VALUES (?1, ?2)",
                params![device_id, route_id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn delete_device(&self, id: &str) -> Result<()> {
        self.conn()
            .execute("DELETE FROM devices WHERE id = ?1", [id])?;
        Ok(())
    }

    /// Keeps at most `keep` devices that were only ever seen, dropping the longest
    /// unseen, so passing visitors cannot fill the database.
    pub fn prune_seen(&self, keep: i64) -> Result<()> {
        self.conn().execute(
            "DELETE FROM devices WHERE id IN (
                 SELECT id FROM devices WHERE status = 'seen'
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
        for user in &mut users {
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

    /// The account a sign-in names, by username or email.
    pub fn user_by_login(&self, login: &str) -> Result<Option<User>> {
        let login = login.trim();
        Ok(self.users()?.into_iter().find(|u| {
            u.username.eq_ignore_ascii_case(login)
                || u.email
                    .as_deref()
                    .is_some_and(|e| e.eq_ignore_ascii_case(login))
        }))
    }

    pub fn save_user(&self, u: &User) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute(
            &format!(
                "INSERT INTO users ({USER_COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(id) DO UPDATE SET username = excluded.username,
                     email = excluded.email, name = excluded.name,
                     password_hash = excluded.password_hash, enabled = excluded.enabled,
                     all_routes = excluded.all_routes, last_login = excluded.last_login"
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
            ],
        )?;
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

    pub fn delete_user(&self, id: &str) -> Result<()> {
        self.conn()
            .execute("DELETE FROM users WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn pending_count(&self) -> Result<i64> {
        let count = self.conn().query_row(
            "SELECT COUNT(*) FROM devices WHERE status = 'pending'",
            [],
            |r| r.get(0),
        )?;
        Ok(count)
    }
}
