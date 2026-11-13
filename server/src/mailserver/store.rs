//! Mailboxes, messages, mail accounts, the outgoing queue and the mail log,
//! in `mail.db` beside the gateway's database.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use anyhow::{anyhow, bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tokio::sync::watch;

use crate::util::{lock, now};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS accounts (
    address TEXT PRIMARY KEY COLLATE NOCASE,
    name TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    apps INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS aliases (
    alias TEXT PRIMARY KEY COLLATE NOCASE,
    target TEXT NOT NULL COLLATE NOCASE
);
CREATE TABLE IF NOT EXISTS mailboxes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account TEXT NOT NULL COLLATE NOCASE,
    name TEXT NOT NULL,
    special TEXT NOT NULL DEFAULT '',
    subscribed INTEGER NOT NULL DEFAULT 1,
    uid_validity INTEGER NOT NULL,
    uid_next INTEGER NOT NULL,
    UNIQUE (account, name)
);
CREATE TABLE IF NOT EXISTS messages (
    mailbox INTEGER NOT NULL,
    uid INTEGER NOT NULL,
    flags TEXT NOT NULL,
    date INTEGER NOT NULL,
    size INTEGER NOT NULL,
    raw BLOB NOT NULL,
    PRIMARY KEY (mailbox, uid)
);
CREATE TABLE IF NOT EXISTS queue (
    id TEXT PRIMARY KEY,
    sender TEXT NOT NULL,
    rcpts TEXT NOT NULL,
    created INTEGER NOT NULL,
    next_try INTEGER NOT NULL,
    attempts INTEGER NOT NULL,
    raw BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    dir TEXT NOT NULL,
    sender TEXT NOT NULL,
    rcpt TEXT NOT NULL,
    size INTEGER NOT NULL,
    status TEXT NOT NULL,
    detail TEXT NOT NULL
);
";

pub const SEEN: &str = "\\Seen";
pub const ANSWERED: &str = "\\Answered";
pub const FLAGGED: &str = "\\Flagged";
pub const DELETED: &str = "\\Deleted";
pub const DRAFT: &str = "\\Draft";
/// Set on delivery: an attachment that can run code, and bulk mail.
pub const RISKY: &str = "$Risky";
pub const MARKETING: &str = "$Marketing";

/// Made for every account, with the RFC 6154 attributes mail apps map to
/// their own folders.
const DEFAULT_BOXES: [(&str, &str); 6] = [
    ("INBOX", ""),
    ("Sent", "\\Sent"),
    ("Drafts", "\\Drafts"),
    ("Trash", "\\Trash"),
    ("Junk", "\\Junk"),
    ("Archive", "\\Archive"),
];

pub const NO_MAILBOX: &str = "no such mailbox";

#[derive(Clone, Debug)]
pub struct Info {
    pub uid: u32,
    pub flags: Vec<String>,
    pub date: i64,
    pub size: i64,
}

impl Info {
    pub fn has(&self, flag: &str) -> bool {
        self.flags.iter().any(|f| f.eq_ignore_ascii_case(flag))
    }
}

pub struct Snapshot {
    pub name: String,
    pub uid_validity: u32,
    pub uid_next: u32,
    pub messages: Vec<Info>,
}

pub struct BoxInfo {
    pub name: String,
    pub special: String,
    pub subscribed: bool,
}

#[derive(Default)]
pub struct Status {
    pub messages: usize,
    pub unseen: usize,
    pub uid_next: u32,
    pub uid_validity: u32,
    pub size: i64,
}

#[derive(Clone, Serialize)]
pub struct Account {
    pub address: String,
    pub name: String,
    #[serde(skip)]
    pub password_hash: String,
    /// Mail apps may sign in over IMAP and SMTP.
    pub apps: bool,
    pub created_at: i64,
    /// Messages and bytes kept.
    pub messages: i64,
    pub size: i64,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Rcpt {
    pub addr: String,
    /// pending, sent or failed.
    pub status: String,
    #[serde(default)]
    pub error: String,
}

pub struct Item {
    pub id: String,
    pub from: String,
    pub rcpts: Vec<Rcpt>,
    pub created: i64,
    pub next_try: i64,
    pub attempts: i64,
}

#[derive(Serialize)]
pub struct LogEntry {
    pub at: i64,
    /// in or out.
    pub dir: String,
    pub from: String,
    pub to: String,
    pub size: i64,
    /// delivered, junk, rejected, failed, sent, bounced or queued.
    pub status: String,
    pub detail: String,
}

pub enum FlagOp {
    Replace,
    Add,
    Remove,
}

pub struct Store {
    conn: Mutex<Connection>,
    /// Bumped on every change to an account's mail, for IDLE.
    watches: Mutex<HashMap<String, watch::Sender<u64>>>,
}

fn canon(name: &str) -> String {
    if name.eq_ignore_ascii_case("INBOX") {
        "INBOX".into()
    } else {
        name.to_owned()
    }
}

fn split_flags(s: &str) -> Vec<String> {
    s.split(' ')
        .filter(|f| !f.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Flags without \Recent or repeats, system flags spelled as RFC 3501 does.
pub fn normalize(flags: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for f in flags {
        if f.is_empty() || f.eq_ignore_ascii_case("\\Recent") {
            continue;
        }
        let f = [SEEN, ANSWERED, FLAGGED, DELETED, DRAFT]
            .into_iter()
            .find(|s| s.eq_ignore_ascii_case(f))
            .map_or_else(|| f.clone(), str::to_owned);
        if !out.iter().any(|g| g.eq_ignore_ascii_case(&f)) {
            out.push(f);
        }
    }
    out
}

pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && !name.starts_with('/')
        && !name.ends_with('/')
        && !name.contains("//")
        && !name.contains(['*', '%'])
        && !name.chars().any(|c| c.is_control())
}

/// A UIDVALIDITY: the time, never the same twice.
fn uid_validity() -> u32 {
    static LAST: Mutex<u32> = Mutex::new(0);
    let mut last = lock(&LAST);
    let v = (now() as u32).max(*last + 1);
    *last = v;
    v
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;")?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self {
            conn: Mutex::new(conn),
            watches: Mutex::new(HashMap::new()),
        })
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        lock(&self.conn)
    }

    /// A receiver that changes whenever the account's mail does.
    pub fn watch(&self, account: &str) -> watch::Receiver<u64> {
        lock(&self.watches)
            .entry(account.to_ascii_lowercase())
            .or_insert_with(|| watch::channel(0).0)
            .subscribe()
    }

    fn notify(&self, account: &str) {
        if let Some(tx) = lock(&self.watches).get(&account.to_ascii_lowercase()) {
            tx.send_modify(|v| *v += 1);
        }
    }

    // ---- accounts ----

    pub fn accounts(&self) -> Result<Vec<Account>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT a.address, a.name, a.password_hash, a.apps, a.created_at,
                    COUNT(m.uid), COALESCE(SUM(m.size), 0)
             FROM accounts a
             LEFT JOIN mailboxes b ON b.account = a.address
             LEFT JOIN messages m ON m.mailbox = b.id
             GROUP BY a.address ORDER BY a.address",
        )?;
        let list = stmt
            .query_map([], |r| {
                Ok(Account {
                    address: r.get(0)?,
                    name: r.get(1)?,
                    password_hash: r.get(2)?,
                    apps: r.get(3)?,
                    created_at: r.get(4)?,
                    messages: r.get(5)?,
                    size: r.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(list)
    }

    pub fn account(&self, address: &str) -> Result<Option<Account>> {
        Ok(self
            .accounts()?
            .into_iter()
            .find(|a| a.address.eq_ignore_ascii_case(address)))
    }

    pub fn exists(&self, address: &str) -> bool {
        self.conn()
            .query_row(
                "SELECT 1 FROM accounts WHERE address = ?1",
                [address],
                |_| Ok(()),
            )
            .optional()
            .ok()
            .flatten()
            .is_some()
    }

    pub fn add_account(&self, address: &str, name: &str, password_hash: &str) -> Result<()> {
        let added = self.conn().execute(
            "INSERT OR IGNORE INTO accounts (address, name, password_hash, apps, created_at)
             VALUES (?1, ?2, ?3, 1, ?4)",
            params![address.to_ascii_lowercase(), name, password_hash, now()],
        )?;
        if added == 0 {
            bail!("{address} already exists");
        }
        self.ensure_boxes(address)
    }

    pub fn edit_account(
        &self,
        address: &str,
        name: Option<&str>,
        password_hash: Option<&str>,
        apps: Option<bool>,
    ) -> Result<()> {
        let conn = self.conn();
        if let Some(name) = name {
            conn.execute(
                "UPDATE accounts SET name = ?2 WHERE address = ?1",
                params![address, name],
            )?;
        }
        if let Some(hash) = password_hash {
            conn.execute(
                "UPDATE accounts SET password_hash = ?2 WHERE address = ?1",
                params![address, hash],
            )?;
        }
        if let Some(apps) = apps {
            conn.execute(
                "UPDATE accounts SET apps = ?2 WHERE address = ?1",
                params![address, apps],
            )?;
        }
        Ok(())
    }

    /// Removes the account with all of its mail, and aliases to it.
    pub fn delete_account(&self, address: &str) -> Result<()> {
        let conn = self.conn();
        conn.execute(
            "DELETE FROM messages WHERE mailbox IN (SELECT id FROM mailboxes WHERE account = ?1)",
            [address],
        )?;
        conn.execute("DELETE FROM mailboxes WHERE account = ?1", [address])?;
        conn.execute("DELETE FROM aliases WHERE target = ?1", [address])?;
        conn.execute("DELETE FROM accounts WHERE address = ?1", [address])?;
        Ok(())
    }

    pub fn aliases(&self) -> Result<Vec<(String, String)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT alias, target FROM aliases ORDER BY alias")?;
        let list = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(list)
    }

    pub fn alias(&self, alias: &str) -> Option<String> {
        self.conn()
            .query_row(
                "SELECT target FROM aliases WHERE alias = ?1",
                [alias],
                |r| r.get(0),
            )
            .optional()
            .ok()
            .flatten()
    }

    pub fn set_alias(&self, alias: &str, target: &str) -> Result<()> {
        self.conn().execute(
            "INSERT INTO aliases (alias, target) VALUES (?1, ?2)
             ON CONFLICT(alias) DO UPDATE SET target = excluded.target",
            params![alias.to_ascii_lowercase(), target.to_ascii_lowercase()],
        )?;
        Ok(())
    }

    pub fn delete_alias(&self, alias: &str) -> Result<()> {
        self.conn()
            .execute("DELETE FROM aliases WHERE alias = ?1", [alias])?;
        Ok(())
    }

    // ---- mailboxes ----

    fn ensure_boxes(&self, account: &str) -> Result<()> {
        let conn = self.conn();
        for (name, special) in DEFAULT_BOXES {
            conn.execute(
                "INSERT OR IGNORE INTO mailboxes (account, name, special, subscribed, uid_validity, uid_next)
                 VALUES (?1, ?2, ?3, 1, ?4, 1)",
                params![account, name, special, uid_validity()],
            )?;
        }
        Ok(())
    }

    fn box_id(conn: &Connection, account: &str, name: &str) -> Result<(i64, String, u32, u32)> {
        conn.query_row(
            "SELECT id, name, uid_validity, uid_next FROM mailboxes WHERE account = ?1 AND name = ?2",
            params![account, canon(name)],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?
        .ok_or_else(|| anyhow!(NO_MAILBOX))
    }

    pub fn list(&self, account: &str) -> Result<Vec<BoxInfo>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT name, special, subscribed FROM mailboxes WHERE account = ?1
             ORDER BY name <> 'INBOX', name",
        )?;
        let list = stmt
            .query_map([account], |r| {
                Ok(BoxInfo {
                    name: r.get(0)?,
                    special: r.get(1)?,
                    subscribed: r.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(list)
    }

    /// The mailbox with an attribute such as `\Sent`.
    pub fn special(&self, account: &str, attr: &str) -> Option<String> {
        self.conn()
            .query_row(
                "SELECT name FROM mailboxes WHERE account = ?1 AND special = ?2",
                params![account, attr],
                |r| r.get(0),
            )
            .optional()
            .ok()
            .flatten()
    }

    pub fn create(&self, account: &str, name: &str) -> Result<()> {
        if !valid_name(name) {
            bail!("invalid mailbox name");
        }
        let added = self.conn().execute(
            "INSERT OR IGNORE INTO mailboxes (account, name, special, subscribed, uid_validity, uid_next)
             VALUES (?1, ?2, '', 1, ?3, 1)",
            params![account, canon(name), uid_validity()],
        )?;
        if added == 0 {
            bail!("mailbox already exists");
        }
        self.notify(account);
        Ok(())
    }

    pub fn delete(&self, account: &str, name: &str) -> Result<()> {
        let conn = self.conn();
        let (id, name, ..) = Self::box_id(&conn, account, name)?;
        if name == "INBOX" {
            bail!("cannot delete INBOX");
        }
        let children: i64 = conn.query_row(
            "SELECT COUNT(*) FROM mailboxes WHERE account = ?1 AND name LIKE ?2 ESCAPE '\\'",
            params![
                account,
                format!("{}/%", name.replace('%', "\\%").replace('_', "\\_"))
            ],
            |r| r.get(0),
        )?;
        if children > 0 {
            bail!("mailbox has children; delete them first");
        }
        conn.execute("DELETE FROM messages WHERE mailbox = ?1", [id])?;
        conn.execute("DELETE FROM mailboxes WHERE id = ?1", [id])?;
        drop(conn);
        self.notify(account);
        Ok(())
    }

    pub fn rename(&self, account: &str, from: &str, to: &str) -> Result<()> {
        if !valid_name(to) {
            bail!("invalid mailbox name");
        }
        let conn = self.conn();
        let (_, old, ..) = Self::box_id(&conn, account, from)?;
        if old == "INBOX" {
            bail!("renaming INBOX is not supported");
        }
        if Self::box_id(&conn, account, to).is_ok() {
            bail!("mailbox already exists");
        }
        let mut stmt = conn.prepare("SELECT id, name FROM mailboxes WHERE account = ?1")?;
        let boxes: Vec<(i64, String)> = stmt
            .query_map([account], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        drop(stmt);
        let prefix = format!("{old}/");
        for (id, name) in boxes {
            if name == old || name.starts_with(&prefix) {
                let renamed = format!("{to}{}", &name[old.len()..]);
                conn.execute(
                    "UPDATE mailboxes SET name = ?2 WHERE id = ?1",
                    params![id, renamed],
                )?;
            }
        }
        drop(conn);
        self.notify(account);
        Ok(())
    }

    pub fn subscribe(&self, account: &str, name: &str, on: bool) -> Result<()> {
        let conn = self.conn();
        let (id, ..) = Self::box_id(&conn, account, name)?;
        conn.execute(
            "UPDATE mailboxes SET subscribed = ?2 WHERE id = ?1",
            params![id, on],
        )?;
        Ok(())
    }

    pub fn status(&self, account: &str, name: &str) -> Result<Status> {
        let conn = self.conn();
        let (id, _, uid_validity, uid_next) = Self::box_id(&conn, account, name)?;
        let (messages, unseen, size): (i64, i64, i64) = conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(instr(flags, '\\Seen') = 0), 0), COALESCE(SUM(size), 0)
             FROM messages WHERE mailbox = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        Ok(Status {
            messages: messages as usize,
            unseen: unseen as usize,
            uid_next,
            uid_validity,
            size,
        })
    }

    pub fn snapshot(&self, account: &str, name: &str) -> Result<Snapshot> {
        let conn = self.conn();
        let (id, name, uid_validity, uid_next) = Self::box_id(&conn, account, name)?;
        let mut stmt = conn.prepare(
            "SELECT uid, flags, date, size FROM messages WHERE mailbox = ?1 ORDER BY uid",
        )?;
        let messages = stmt
            .query_map([id], |r| {
                Ok(Info {
                    uid: r.get(0)?,
                    flags: split_flags(&r.get::<_, String>(1)?),
                    date: r.get(2)?,
                    size: r.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(Snapshot {
            name,
            uid_validity,
            uid_next,
            messages,
        })
    }

    /// Stores a message; its UID and the mailbox's UIDVALIDITY.
    pub fn append(
        &self,
        account: &str,
        name: &str,
        raw: &[u8],
        flags: &[String],
        date: i64,
    ) -> Result<(u32, u32)> {
        let conn = self.conn();
        let (id, _, uid_validity, uid) = Self::box_id(&conn, account, name)?;
        let date = if date == 0 { now() } else { date };
        conn.execute(
            "INSERT INTO messages (mailbox, uid, flags, date, size, raw) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, uid, normalize(flags).join(" "), date, raw.len() as i64, raw],
        )?;
        conn.execute(
            "UPDATE mailboxes SET uid_next = ?2 WHERE id = ?1",
            params![id, uid + 1],
        )?;
        drop(conn);
        self.notify(account);
        Ok((uid, uid_validity))
    }

    pub fn read(&self, account: &str, name: &str, uid: u32) -> Result<Vec<u8>> {
        let conn = self.conn();
        let (id, ..) = Self::box_id(&conn, account, name)?;
        conn.query_row(
            "SELECT raw FROM messages WHERE mailbox = ?1 AND uid = ?2",
            params![id, uid],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| anyhow!("no such message"))
    }

    pub fn set_flags(
        &self,
        account: &str,
        name: &str,
        uids: &[u32],
        op: FlagOp,
        flags: &[String],
    ) -> Result<Vec<Info>> {
        let conn = self.conn();
        let (id, ..) = Self::box_id(&conn, account, name)?;
        let flags = normalize(flags);
        let mut out = Vec::new();
        for &uid in uids {
            let Some((have, date, size)) = conn
                .query_row(
                    "SELECT flags, date, size FROM messages WHERE mailbox = ?1 AND uid = ?2",
                    params![id, uid],
                    |r| Ok((r.get::<_, String>(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?
            else {
                continue;
            };
            let have = split_flags(&have);
            let new = match op {
                FlagOp::Replace => flags.clone(),
                FlagOp::Add => normalize(&[have, flags.clone()].concat()),
                FlagOp::Remove => have
                    .into_iter()
                    .filter(|f| !flags.iter().any(|g| g.eq_ignore_ascii_case(f)))
                    .collect(),
            };
            conn.execute(
                "UPDATE messages SET flags = ?3 WHERE mailbox = ?1 AND uid = ?2",
                params![id, uid, new.join(" ")],
            )?;
            out.push(Info {
                uid,
                flags: new,
                date,
                size,
            });
        }
        drop(conn);
        self.notify(account);
        Ok(out)
    }

    /// Removes messages flagged \Deleted, of `only` when given.
    pub fn expunge(&self, account: &str, name: &str, only: Option<&[u32]>) -> Result<Vec<u32>> {
        let snap = self.snapshot(account, name)?;
        let gone: Vec<u32> = snap
            .messages
            .iter()
            .filter(|m| m.has(DELETED) && only.is_none_or(|o| o.contains(&m.uid)))
            .map(|m| m.uid)
            .collect();
        self.remove(account, name, &gone)?;
        Ok(gone)
    }

    pub fn remove(&self, account: &str, name: &str, uids: &[u32]) -> Result<()> {
        if uids.is_empty() {
            return Ok(());
        }
        let conn = self.conn();
        let (id, ..) = Self::box_id(&conn, account, name)?;
        for uid in uids {
            conn.execute(
                "DELETE FROM messages WHERE mailbox = ?1 AND uid = ?2",
                params![id, uid],
            )?;
        }
        drop(conn);
        self.notify(account);
        Ok(())
    }

    /// Copies messages; the source UIDs that existed, their new UIDs, and
    /// the destination's UIDVALIDITY.
    pub fn copy(
        &self,
        account: &str,
        from: &str,
        to: &str,
        uids: &[u32],
    ) -> Result<(Vec<u32>, Vec<u32>, u32)> {
        let conn = self.conn();
        let (src, ..) = Self::box_id(&conn, account, from)?;
        let (dst, _, uid_validity, mut next) = Self::box_id(&conn, account, to)?;
        let (mut old, mut new) = (Vec::new(), Vec::new());
        for &uid in uids {
            let copied = conn.execute(
                "INSERT INTO messages (mailbox, uid, flags, date, size, raw)
                 SELECT ?3, ?4, flags, date, size, raw FROM messages WHERE mailbox = ?1 AND uid = ?2",
                params![src, uid, dst, next],
            )?;
            if copied > 0 {
                old.push(uid);
                new.push(next);
                next += 1;
            }
        }
        conn.execute(
            "UPDATE mailboxes SET uid_next = ?2 WHERE id = ?1",
            params![dst, next],
        )?;
        drop(conn);
        self.notify(account);
        Ok((old, new, uid_validity))
    }

    pub fn move_to(
        &self,
        account: &str,
        from: &str,
        to: &str,
        uids: &[u32],
    ) -> Result<(Vec<u32>, Vec<u32>, u32)> {
        let moved = self.copy(account, from, to, uids)?;
        self.remove(account, from, &moved.0)?;
        Ok(moved)
    }

    // ---- the outgoing queue ----

    pub fn enqueue(&self, from: &str, rcpts: &[String], raw: &[u8]) -> Result<()> {
        let rcpts: Vec<Rcpt> = rcpts
            .iter()
            .map(|r| Rcpt {
                addr: r.clone(),
                status: "pending".into(),
                error: String::new(),
            })
            .collect();
        self.conn().execute(
            "INSERT INTO queue (id, sender, rcpts, created, next_try, attempts, raw)
             VALUES (?1, ?2, ?3, ?4, ?4, 0, ?5)",
            params![
                crate::util::random_hex(8),
                from,
                serde_json::to_string(&rcpts)?,
                now(),
                raw
            ],
        )?;
        Ok(())
    }

    pub fn queued(&self) -> Result<Vec<Item>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, sender, rcpts, created, next_try, attempts FROM queue ORDER BY created",
        )?;
        let items = stmt
            .query_map([], |r| {
                Ok(Item {
                    id: r.get(0)?,
                    from: r.get(1)?,
                    rcpts: serde_json::from_str(&r.get::<_, String>(2)?).unwrap_or_default(),
                    created: r.get(3)?,
                    next_try: r.get(4)?,
                    attempts: r.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(items)
    }

    pub fn queued_raw(&self, id: &str) -> Result<Vec<u8>> {
        Ok(self
            .conn()
            .query_row("SELECT raw FROM queue WHERE id = ?1", [id], |r| r.get(0))?)
    }

    pub fn save_item(&self, it: &Item) -> Result<()> {
        self.conn().execute(
            "UPDATE queue SET rcpts = ?2, next_try = ?3, attempts = ?4 WHERE id = ?1",
            params![
                it.id,
                serde_json::to_string(&it.rcpts)?,
                it.next_try,
                it.attempts
            ],
        )?;
        Ok(())
    }

    pub fn drop_item(&self, id: &str) -> Result<()> {
        self.conn()
            .execute("DELETE FROM queue WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn retry_all(&self) -> Result<()> {
        self.conn()
            .execute("UPDATE queue SET next_try = ?1", [now()])?;
        Ok(())
    }

    // ---- the log ----

    pub fn log(&self, dir: &str, from: &str, to: &str, size: usize, status: &str, detail: &str) {
        let conn = self.conn();
        let added = conn.execute(
            "INSERT INTO log (at, dir, sender, rcpt, size, status, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![now(), dir, from, to, size as i64, status, detail],
        );
        if let Err(err) = added {
            tracing::warn!("could not log mail: {err}");
        }
        // Keeps the last 2000.
        let _ = conn.execute(
            "DELETE FROM log WHERE id <= (SELECT MAX(id) - 2000 FROM log)",
            [],
        );
    }

    pub fn logs(&self, limit: i64) -> Result<Vec<LogEntry>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT at, dir, sender, rcpt, size, status, detail FROM log ORDER BY id DESC LIMIT ?1",
        )?;
        let list = stmt
            .query_map([limit], |r| {
                Ok(LogEntry {
                    at: r.get(0)?,
                    dir: r.get(1)?,
                    from: r.get(2)?,
                    to: r.get(3)?,
                    size: r.get(4)?,
                    status: r.get(5)?,
                    detail: r.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(list)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        let path =
            std::env::temp_dir().join(format!("mail-test-{}.db", crate::util::random_hex(6)));
        let s = Store::open(&path).unwrap();
        s.add_account("sam@example.com", "Sam", "hash").unwrap();
        s
    }

    #[test]
    fn messages_move_between_mailboxes() {
        let s = store();
        let a = "sam@example.com";
        let (uid, _) = s
            .append(a, "inbox", b"Subject: one\r\n\r\nx", &[], 0)
            .unwrap();
        s.append(a, "INBOX", b"Subject: two\r\n\r\ny", &["\\seen".into()], 0)
            .unwrap();
        assert_eq!(uid, 1);
        let st = s.status(a, "INBOX").unwrap();
        assert_eq!((st.messages, st.unseen, st.uid_next), (2, 1, 3));
        let (old, new, _) = s.move_to(a, "INBOX", "Archive", &[1]).unwrap();
        assert_eq!((old, new), (vec![1], vec![1]));
        assert_eq!(s.snapshot(a, "INBOX").unwrap().messages.len(), 1);
        assert_eq!(s.read(a, "Archive", 1).unwrap(), b"Subject: one\r\n\r\nx");
        s.set_flags(a, "INBOX", &[2], FlagOp::Add, &["\\Deleted".into()])
            .unwrap();
        assert_eq!(s.expunge(a, "INBOX", None).unwrap(), vec![2]);
        assert_eq!(s.status(a, "INBOX").unwrap().messages, 0);
    }

    #[test]
    fn mailboxes_rename_with_their_children() {
        let s = store();
        let a = "sam@example.com";
        s.create(a, "Work").unwrap();
        s.create(a, "Work/2024").unwrap();
        assert!(s.delete(a, "Work").is_err());
        s.rename(a, "Work", "Jobs").unwrap();
        let names: Vec<String> = s.list(a).unwrap().into_iter().map(|b| b.name).collect();
        assert!(names.contains(&"Jobs/2024".to_owned()) && !names.contains(&"Work".to_owned()));
        assert_eq!(names[0], "INBOX");
        assert_eq!(s.special(a, "\\Sent").as_deref(), Some("Sent"));
    }

    #[test]
    fn flags_are_tidied() {
        let f = normalize(&[
            "\\SEEN".into(),
            "\\Recent".into(),
            "$Risky".into(),
            "\\seen".into(),
        ]);
        assert_eq!(f, ["\\Seen", "$Risky"]);
    }
}
