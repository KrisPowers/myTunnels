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
CREATE TABLE IF NOT EXISTS user_routes (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    route_id TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, route_id)
);
";

/// Columns added to `routes` after its first release, with how to add each.
const ROUTE_MIGRATIONS: [(&str, &str); 4] = [
    ("preserve_host", "preserve_host INTEGER NOT NULL DEFAULT 0"),
    (
        "require_password",
        "require_password INTEGER NOT NULL DEFAULT 0",
    ),
    ("password_hash", "password_hash TEXT"),
    ("require_login", "require_login INTEGER NOT NULL DEFAULT 0"),
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
    /// "all": every enabled check must pass. "any": one passing check is enough.
    pub policy_mode: String,
    pub enabled: bool,
    pub dns_record_id: Option<String>,
    pub created_at: i64,
}

/// A browser that has asked for access through the gateway.
#[derive(Clone, Serialize)]
pub struct Device {
    pub id: String,
    pub name: String,
    /// "pending", "approved" or "denied".
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
     target_scheme, require_lan, require_device, policy_mode, enabled, dns_record_id, created_at";

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
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        conn.execute_batch(SCHEMA)?;
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
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)"
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
            ],
        )?;
        Ok(())
    }

    pub fn update_route(&self, r: &Route) -> Result<()> {
        self.conn().execute(
            "UPDATE routes SET target_host = ?2, target_port = ?3, target_scheme = ?4,
                 require_lan = ?5, require_device = ?6, policy_mode = ?7, enabled = ?8
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

    pub fn pending_count(&self) -> Result<i64> {
        let count = self.conn().query_row(
            "SELECT COUNT(*) FROM devices WHERE status = 'pending'",
            [],
            |r| r.get(0),
        )?;
        Ok(count)
    }
}
