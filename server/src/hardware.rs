//! The Hardware page: every part of this computer, what it reads and whether
//! it is healthy, kept current every few seconds, with an email to the host
//! and admins when a part starts failing and again when it recovers.
//!
//! What any account may read comes straight from the system. On Windows that
//! is `hardware/inventory.ps1` (the memory slots and sticks, drives,
//! processor, board and graphics cards, and the System log's crashes,
//! hardware errors and power losses) and `nvidia-smi`; on Linux it is `/sys`
//! (hwmon, EDAC and the block devices) and `nvidia-smi`.
//!
//! Temperatures, fan speeds, voltages and drive wear on Windows need
//! administrator rights. Turning the page on there runs `mytunnels hardware
//! on` through Windows' admin prompt: it installs the PawnIO driver and
//! LibreHardwareMonitor's library in Program Files and a task that runs
//! `hardware/sensors.ps1` as SYSTEM, which writes `sensors.json` for this
//! module to read. `mytunnels hardware off` removes the task and the files.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{PoisonError, RwLock};
use std::time::Duration;

use anyhow::Result;
use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::db::{Db, ADMIN};
use crate::mail;
use crate::state::AppState;
use crate::util::{self, ApiError, ApiResult};

/// How a part is doing. Empty is a memory slot with nothing in it; Unknown is
/// a part that reports nothing to judge it by.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Health {
    Ok,
    Warn,
    Bad,
    Empty,
    Unknown,
}

impl Health {
    fn rank(self) -> u8 {
        match self {
            Health::Bad => 3,
            Health::Warn => 2,
            Health::Ok => 1,
            Health::Empty | Health::Unknown => 0,
        }
    }
}

/// Ok below `warn`, Warn from it, Bad from `bad`.
fn above(value: f64, warn: f64, bad: f64) -> Health {
    if value >= bad {
        Health::Bad
    } else if value >= warn {
        Health::Warn
    } else {
        Health::Ok
    }
}

#[derive(Clone, Serialize)]
pub struct Reading {
    label: String,
    value: f64,
    unit: &'static str,
    health: Health,
}

#[derive(Clone, Serialize)]
pub struct Part {
    /// memory, cpu, gpu, drive, fan, power or board.
    kind: &'static str,
    /// Stays the same from one reading to the next, for alerts.
    id: String,
    name: String,
    /// The slot, bank or place it sits in.
    place: String,
    facts: Vec<[String; 2]>,
    readings: Vec<Reading>,
    health: Health,
    reason: String,
    /// The memory a stick adds, for the bar of how much each one gives.
    #[serde(skip_serializing_if = "Option::is_none")]
    bytes: Option<u64>,
}

impl Part {
    fn new(kind: &'static str, id: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            kind,
            id: id.into(),
            name: name.into(),
            place: String::new(),
            facts: Vec::new(),
            readings: Vec::new(),
            health: Health::Unknown,
            reason: String::new(),
            bytes: None,
        }
    }

    fn fact(&mut self, label: &str, value: impl Into<String>) {
        let value = value.into();
        if !value.trim().is_empty() {
            self.facts.push([label.to_owned(), value]);
        }
    }

    /// A reading, which makes the part as bad as the reading is.
    fn read(&mut self, label: &str, value: f64, unit: &'static str, health: Health, reason: &str) {
        self.readings.push(Reading {
            label: label.to_owned(),
            value,
            unit,
            health,
        });
        self.judge(health, reason);
    }

    /// The worst of what is known about the part stands.
    fn judge(&mut self, health: Health, reason: impl Into<String>) {
        if health.rank() > self.health.rank() {
            self.health = health;
            self.reason = reason.into();
        }
    }
}

#[derive(Clone, Serialize)]
pub struct Event {
    at: i64,
    /// The kind of part it concerns, as on [`Part::kind`].
    kind: &'static str,
    health: Health,
    text: String,
}

#[derive(Clone, Default, Serialize)]
pub struct Snapshot {
    at: i64,
    /// windows, linux or macos.
    platform: &'static str,
    /// Windows' sensor task: "none" where none is needed, else "missing",
    /// "waiting" (for the admin prompt), "installing" (setup under way),
    /// "starting" (set up, no reading yet), "running" or "stale" (stopped
    /// reading). Once set up, it is never set up again.
    helper: &'static str,
    helper_error: String,
    /// While setup runs: the step under way and how far along it is.
    helper_step: String,
    helper_percent: Option<u8>,
    /// Memory slots on the board, filled or not, where the system says.
    slots: usize,
    ecc: bool,
    parts: Vec<Part>,
    /// Something wrong with a whole kind of part, such as a memory crash,
    /// which no one part can be blamed for.
    notes: Vec<Part>,
    events: Vec<Event>,
}

static CURRENT: RwLock<Option<Snapshot>> = RwLock::new(None);

const PLATFORM: &str = if cfg!(windows) {
    "windows"
} else if cfg!(target_os = "linux") {
    "linux"
} else {
    "macos"
};

fn enabled(db: &Db) -> bool {
    db.setting("hardware").ok().flatten().as_deref() == Some("on")
}

// ---- the API ----

/// The page: whether it is on, and what was last read.
pub async fn view(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let snapshot = CURRENT
        .read()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    Ok(Json(json!({
        "enabled": enabled(&state.db),
        "platform": PLATFORM,
        "snapshot": snapshot,
    })))
}

/// Turns the page on. On Windows this asks for administrator rights on this
/// computer's screen, to put the sensor task in place.
pub async fn enable(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    if PLATFORM == "macos" {
        return Err(ApiError::bad(
            "Hardware monitoring covers Windows and Linux",
        ));
    }
    state.db.set_setting("hardware", "on")?;
    // Set up once: only when the task is not in place.
    #[cfg(windows)]
    if !windows::installed() {
        state
            .db
            .set_setting("hardware_setup_at", &util::now().to_string())?;
        windows::elevate("on")?;
    }
    view(State(state)).await
}

/// Turns the page off, removing the sensor task on Windows through the admin prompt.
pub async fn disable(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    state.db.set_setting("hardware", "off")?;
    *CURRENT.write().unwrap_or_else(PoisonError::into_inner) = None;
    #[cfg(windows)]
    if windows::installed() {
        windows::elevate("off")?;
    }
    view(State(state)).await
}

#[derive(Deserialize)]
pub struct Forget {
    slot: String,
}

/// Forgets a memory slot's stick, once it was taken out on purpose.
pub async fn forget(
    State(state): State<AppState>,
    Json(body): Json<Forget>,
) -> ApiResult<Json<Value>> {
    let mut known = remembered(&state.db);
    known.remove(&body.slot);
    remember(&state.db, &known)?;
    view(State(state)).await
}

// ---- reading, every few seconds ----

pub fn spawn(state: AppState) {
    tokio::spawn(run(state));
}

async fn run(state: AppState) {
    let mut sources = Sources::default();
    let mut alerts = Alerts::load(&state.db);
    let mut every = tokio::time::interval(Duration::from_secs(5));
    loop {
        every.tick().await;
        if !enabled(&state.db) {
            continue;
        }
        let snapshot = collect(&state.db, &mut sources).await;
        alerts.check(&state, &snapshot);
        *CURRENT.write().unwrap_or_else(PoisonError::into_inner) = Some(snapshot);
    }
}

/// What is slow to read, kept between readings.
#[derive(Default)]
struct Sources {
    /// Windows' inventory, read once a minute, and when.
    #[cfg_attr(not(windows), allow(dead_code))]
    inventory: Option<(std::time::Instant, Value)>,
}

async fn collect(db: &Db, sources: &mut Sources) -> Snapshot {
    let mut snap = Snapshot {
        at: util::now(),
        platform: PLATFORM,
        helper: "none",
        ..Default::default()
    };
    let gpus = nvidia().await;
    #[cfg(windows)]
    windows::collect(db, sources, &mut snap, &gpus).await;
    #[cfg(target_os = "linux")]
    linux::collect(db, &mut snap, &gpus);
    #[cfg(not(any(windows, target_os = "linux")))]
    let _ = (db, sources, gpus);
    #[cfg(target_os = "linux")]
    let _ = sources;
    snap.parts.sort_by_key(|p| order(p.kind));
    snap
}

fn order(kind: &str) -> usize {
    ["memory", "cpu", "gpu", "drive", "fan", "power", "board"]
        .iter()
        .position(|k| *k == kind)
        .unwrap_or(9)
}

// ---- memory, remembered so a stick that drops out shows as missing ----

#[derive(Clone, Serialize, Deserialize, PartialEq)]
struct Known {
    bytes: u64,
    name: String,
    serial: String,
}

fn remembered(db: &Db) -> BTreeMap<String, Known> {
    db.setting("hardware_memory")
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn remember(db: &Db, known: &BTreeMap<String, Known>) -> Result<()> {
    db.set_setting("hardware_memory", &serde_json::to_string(known)?)
}

/// A stick in a slot, as the system reports it.
struct Stick {
    slot: String,
    bank: String,
    bytes: u64,
    /// Its rated speed and the speed it runs at, in MT/s.
    speed: u64,
    configured: u64,
    maker: String,
    part: String,
    serial: String,
    /// Corrected and uncorrected errors, where the memory counts them (ECC).
    errors: Option<(u64, u64)>,
}

/// The memory slots: a part for each stick, for each stick remembered in a
/// slot that no longer reports one, and for each empty slot.
fn memory(db: &Db, snap: &mut Snapshot, sticks: Vec<Stick>, slots: usize) {
    let mut known = remembered(db);
    let before = known.clone();
    let mut taken = BTreeSet::new();
    for s in &sticks {
        let name = [size(s.bytes), s.maker.clone(), s.part.clone()]
            .into_iter()
            .filter(|v| !v.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        let mut p = Part::new("memory", format!("memory:{}", s.slot), name.clone());
        p.place = s.slot.clone();
        p.bytes = Some(s.bytes);
        p.fact("Bank", s.bank.clone());
        if s.speed > 0 {
            p.fact("Rated speed", format!("{} MT/s", s.speed));
        }
        if s.configured > 0 {
            p.fact("Running at", format!("{} MT/s", s.configured));
        }
        p.fact("Maker", s.maker.clone());
        p.fact("Part number", s.part.clone());
        p.fact("Serial", s.serial.clone());
        p.judge(Health::Ok, "Detected");
        if s.configured > 0 && s.speed > 0 && s.configured < s.speed {
            p.judge(
                Health::Warn,
                format!("Running at {} of its rated {} MT/s", s.configured, s.speed),
            );
        }
        if let Some((corrected, uncorrected)) = s.errors {
            p.read(
                "Corrected errors",
                corrected as f64,
                "",
                if corrected > 0 {
                    Health::Warn
                } else {
                    Health::Ok
                },
                "Has corrected memory errors; it may be starting to fail",
            );
            p.read(
                "Uncorrected errors",
                uncorrected as f64,
                "",
                if uncorrected > 0 {
                    Health::Bad
                } else {
                    Health::Ok
                },
                "Has uncorrected memory errors",
            );
        }
        if let Some(k) = known.get(&s.slot) {
            if !k.serial.is_empty() && !s.serial.is_empty() && k.serial != s.serial {
                p.fact("Replaced", format!("{} (serial {})", k.name, k.serial));
            }
        }
        known.insert(
            s.slot.clone(),
            Known {
                bytes: s.bytes,
                name,
                serial: s.serial.clone(),
            },
        );
        taken.insert(s.slot.clone());
        snap.parts.push(p);
    }
    let mut missing = 0;
    for (slot, k) in &known {
        if taken.contains(slot) {
            continue;
        }
        missing += 1;
        let mut p = Part::new("memory", format!("memory:{slot}"), k.name.clone());
        p.place = slot.clone();
        p.fact("Serial", k.serial.clone());
        p.judge(Health::Bad, "Not detected. This slot held this stick before; it has failed, come loose, or been taken out");
        snap.parts.push(p);
    }
    let present: Vec<&str> = sticks.iter().map(|s| s.slot.as_str()).collect();
    let empty = slots.saturating_sub(sticks.len() + missing);
    let named = empty_slots(&present, &known, slots);
    for i in 0..empty {
        let place = named.get(i).cloned().unwrap_or_default();
        let mut p = Part::new("memory", format!("memory:empty:{i}"), "Empty slot");
        p.place = place;
        p.health = Health::Empty;
        snap.parts.push(p);
    }
    snap.slots = slots.max(sticks.len() + missing);
    if known != before {
        let _ = remember(db, &known);
    }
}

/// The names of the empty slots, where the filled ones follow the
/// `ChannelA-DIMM1` pattern: two or more channels of equal slots, counted from 0.
fn empty_slots(present: &[&str], known: &BTreeMap<String, Known>, slots: usize) -> Vec<String> {
    let parse = |s: &str| {
        let rest = s.strip_prefix("Channel")?;
        let (letter, n) = rest.split_once("-DIMM")?;
        let letter = letter.chars().next().filter(|c| c.is_ascii_uppercase())?;
        Some((letter, n.parse::<usize>().ok()?))
    };
    let all: Vec<&str> = present
        .iter()
        .copied()
        .chain(known.keys().map(String::as_str))
        .collect();
    let Some(parsed) = all.iter().map(|s| parse(s)).collect::<Option<Vec<_>>>() else {
        return Vec::new();
    };
    let highest = parsed
        .iter()
        .map(|(c, _)| (*c as u8 - b'A') as usize + 1)
        .max()
        .unwrap_or(1);
    let channels = highest.max(if slots >= 2 { 2 } else { 1 });
    if slots == 0 || !slots.is_multiple_of(channels) {
        return Vec::new();
    }
    let per = slots / channels;
    (0..channels)
        .flat_map(|c| (0..per).map(move |n| format!("Channel{}-DIMM{n}", (b'A' + c as u8) as char)))
        .filter(|name| !all.contains(&name.as_str()))
        .collect()
}

fn size(bytes: u64) -> String {
    let gb = bytes as f64 / (1u64 << 30) as f64;
    if gb >= 1.0 {
        format!("{} GB", (gb * 10.0).round() / 10.0)
    } else {
        format!("{} MB", bytes >> 20)
    }
}

// ---- graphics cards, from nvidia-smi on either system ----

struct Gpu {
    index: String,
    name: String,
    temp: Option<f64>,
    fan: Option<f64>,
    power: Option<f64>,
    limit: Option<f64>,
    load: Option<f64>,
    used: Option<f64>,
    total: Option<f64>,
    slowdown: bool,
    hot: bool,
}

async fn nvidia() -> Vec<Gpu> {
    let fields = "index,name,temperature.gpu,fan.speed,power.draw,power.limit,utilization.gpu,memory.used,memory.total,clocks_event_reasons.hw_slowdown,clocks_event_reasons.hw_thermal_slowdown,clocks_event_reasons.sw_thermal_slowdown";
    let mut cmd = tokio::process::Command::new("nvidia-smi");
    cmd.arg(format!("--query-gpu={fields}"))
        .arg("--format=csv,noheader,nounits")
        .stdin(std::process::Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(windows::NO_WINDOW);
    let Ok(out) = cmd.output().await else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split(',').map(str::trim).collect();
            if f.len() < 12 {
                return None;
            }
            let n = |i: usize| f[i].parse::<f64>().ok();
            let on = |i: usize| f[i].eq_ignore_ascii_case("Active");
            Some(Gpu {
                index: f[0].to_owned(),
                name: f[1].to_owned(),
                temp: n(2),
                fan: n(3),
                power: n(4),
                limit: n(5),
                load: n(6),
                used: n(7),
                total: n(8),
                slowdown: on(9),
                hot: on(10) || on(11),
            })
        })
        .collect()
}

fn gpu_parts(snap: &mut Snapshot, gpus: &[Gpu]) {
    for g in gpus {
        let mut p = Part::new("gpu", format!("gpu:nvidia:{}", g.index), g.name.clone());
        p.judge(Health::Ok, "Working");
        if let Some(t) = g.temp {
            p.read("Temperature", t, "°C", above(t, 83.0, 90.0), "Running hot");
        }
        if let Some(v) = g.fan {
            p.read("Fan", v, "%", Health::Ok, "");
        }
        if let Some(v) = g.load {
            p.read("Load", v, "%", Health::Ok, "");
        }
        if let Some(v) = g.power {
            p.read("Power", v, "W", Health::Ok, "");
        }
        if let Some(v) = g.limit {
            p.fact("Power limit", format!("{v:.0} W"));
        }
        if let (Some(used), Some(total)) = (g.used, g.total) {
            p.fact("Memory", format!("{used:.0} of {total:.0} MiB in use"));
        }
        if g.hot {
            p.judge(Health::Warn, "Slowing itself down to stay cool");
        }
        if g.slowdown {
            p.judge(
                Health::Warn,
                "Slowing itself down for a hardware reason, such as power or heat",
            );
        }
        snap.parts.push(p);
    }
}

// ---- events, notes and the parts they concern ----

/// Notes from recent events: each kind's worst in its window.
fn notes_from_events(snap: &mut Snapshot) {
    let now = util::now();
    let mut worst: HashMap<&'static str, (Health, String)> = HashMap::new();
    for e in &snap.events {
        // A power loss counts for a week; crashes and hardware errors for a month.
        let window = if e.kind == "power" { 7 } else { 30 } * 86_400;
        if now - e.at > window {
            continue;
        }
        let entry = worst.entry(e.kind).or_insert((Health::Ok, String::new()));
        if e.health.rank() > entry.0.rank() {
            *entry = (e.health, e.text.clone());
        }
    }
    for (kind, (health, text)) in worst {
        let mut p = Part::new(kind, format!("note:{kind}"), text);
        p.health = health;
        snap.notes.push(p);
    }
}

// ---- rails: a supply voltage is healthy within 5% of its nominal value ----

/// The nominal voltage a sensor's name stands for: the 12, 5 and 3.3 volt rails.
fn rail(name: &str) -> Option<f64> {
    let n = name.to_ascii_lowercase().replace(' ', "");
    if n.contains("12v") {
        Some(12.0)
    } else if n.contains("3.3v") || n.contains("3vcc") || n.contains("3v3") {
        Some(3.3)
    } else if n.contains("5v") && !n.contains("vsb") {
        Some(5.0)
    } else {
        None
    }
}

fn rail_health(volts: f64, nominal: f64) -> Health {
    let off = (volts - nominal).abs() / nominal;
    if off > 0.10 {
        Health::Bad
    } else if off > 0.05 {
        Health::Warn
    } else {
        Health::Ok
    }
}

// ---- fans: a fan that has spun before and now reads 0 has stopped ----

fn spun(db: &Db) -> BTreeSet<String> {
    db.setting("hardware_fans")
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// A part for each fan that spins or has spun.
fn fans(db: &Db, snap: &mut Snapshot, readings: Vec<(String, String, f64)>) {
    let mut seen = spun(db);
    let before = seen.len();
    for (id, name, rpm) in readings {
        if rpm > 0.0 {
            seen.insert(id.clone());
        }
        if !seen.contains(&id) {
            continue;
        }
        let mut p = Part::new("fan", id, name);
        let health = if rpm > 0.0 { Health::Ok } else { Health::Bad };
        p.read(
            "Speed",
            rpm,
            "RPM",
            health,
            "Stopped. It was spinning before; it may have failed or come unplugged",
        );
        snap.parts.push(p);
    }
    if seen.len() != before {
        let _ = db.set_setting(
            "hardware_fans",
            &serde_json::to_string(&seen).unwrap_or_default(),
        );
    }
}

// ---- alerts: an email when a part has been failing, or well again, for 15 seconds ----

struct Alerts {
    /// The health last told of, by part.
    told: HashMap<String, Health>,
    /// A change seen, and how many readings in a row it has held.
    pending: HashMap<String, (Health, u8)>,
}

impl Alerts {
    fn load(db: &Db) -> Self {
        let told = db
            .setting("hardware_told")
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        Self {
            told,
            pending: HashMap::new(),
        }
    }

    fn check(&mut self, state: &AppState, snap: &Snapshot) {
        let mut news = Vec::new();
        for p in snap.parts.iter().chain(&snap.notes) {
            let health = match p.health {
                Health::Warn | Health::Bad => p.health,
                Health::Ok => Health::Ok,
                Health::Empty | Health::Unknown => continue,
            };
            let told = self.told.get(&p.id).copied().unwrap_or(Health::Ok);
            if health == told {
                self.pending.remove(&p.id);
                continue;
            }
            let entry = self.pending.entry(p.id.clone()).or_insert((health, 0));
            if entry.0 != health {
                *entry = (health, 0);
            }
            entry.1 += 1;
            if entry.1 >= 3 {
                self.pending.remove(&p.id);
                self.told.insert(p.id.clone(), health);
                news.push((p.clone(), health));
            }
        }
        if news.is_empty() {
            return;
        }
        let _ = state.db.set_setting(
            "hardware_told",
            &serde_json::to_string(&self.told).unwrap_or_default(),
        );
        let state = state.clone();
        tokio::spawn(async move {
            if let Err(err) = tell(&state.db, &news).await {
                tracing::warn!("could not email a hardware change: {err:#}");
            }
        });
    }
}

fn title(p: &Part) -> String {
    if p.id.starts_with("note:") {
        return match p.kind {
            "memory" => "Memory".into(),
            "cpu" => "Processor".into(),
            "power" => "Power".into(),
            _ => "Hardware".into(),
        };
    }
    if p.place.is_empty() {
        p.name.clone()
    } else {
        format!("{} in {}", p.name, p.place)
    }
}

/// Emails the host and every admin, when SMTP is set up.
async fn tell(db: &Db, news: &[(Part, Health)]) -> Result<()> {
    let Some(smtp) = mail::load(db)? else {
        return Ok(());
    };
    let mut to: Vec<String> = db
        .users()?
        .into_iter()
        .filter(|u| {
            u.enabled
                && (u.id == crate::db::HOST_ID || u.holds(ADMIN))
                && !u.email.trim().is_empty()
        })
        .map(|u| u.email.trim().to_lowercase())
        .collect();
    to.sort();
    to.dedup();
    let failing = news.iter().filter(|(_, h)| *h != Health::Ok).count();
    let subject = match (news.len(), failing) {
        (1, 0) => format!("myTunnels: {} is healthy again", title(&news[0].0)),
        (1, _) => format!(
            "myTunnels: {} {}",
            title(&news[0].0),
            if news[0].1 == Health::Bad {
                "is failing"
            } else {
                "needs attention"
            }
        ),
        (n, 0) => format!("myTunnels: {n} parts are healthy again"),
        (n, _) => format!("myTunnels: {n} hardware changes"),
    };
    let body = news
        .iter()
        .map(|(p, h)| {
            let state = match h {
                Health::Bad => "Failing",
                Health::Warn => "Needs attention",
                _ => "Healthy again",
            };
            let why = if *h == Health::Ok || p.id.starts_with("note:") {
                p.name.clone()
            } else {
                p.reason.clone()
            };
            format!("{state}: {}\n{why}", title(p))
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    for address in to {
        mail::send(
            &smtp,
            &address,
            &subject,
            &format!("{body}\n\nSee Hardware in myTunnels for more."),
        )
        .await?;
    }
    Ok(())
}

// ---- Windows ----

#[cfg(windows)]
mod windows {
    use std::path::{Path, PathBuf};
    use std::process::Stdio;
    use std::time::{Instant, SystemTime};

    use anyhow::{bail, Context, Result};
    use serde_json::Value;
    use sha2::{Digest, Sha256};

    use super::*;

    pub const NO_WINDOW: u32 = 0x0800_0000;

    const INVENTORY: &str = include_str!("hardware/inventory.ps1");
    const SENSORS: &str = include_str!("hardware/sensors.ps1");
    const TASK: &str = "myTunnels Hardware";

    // The two downloads, pinned to what was checked.
    const PAWNIO: (&str, &str) = (
        "https://github.com/namazso/PawnIO.Setup/releases/download/2.2.0/PawnIO_setup.exe",
        "1f519a22e47187f70a1379a48ca604981c4fcf694f4e65b734aaa74a9fba3032",
    );
    const LHM: (&str, &str) = (
        "https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases/download/v0.9.6/LibreHardwareMonitor.zip",
        "086d9f1b5a99e643edc2cfaaac16051685b551e4c5ac0b32a57c58c0e529c001",
    );

    /// Where the sensor task lives: Program Files, which only administrators may change.
    fn dir() -> PathBuf {
        let base = std::env::var_os("ProgramFiles")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
        base.join("myTunnels").join("hardware")
    }

    pub fn installed() -> bool {
        dir()
            .join("lib")
            .join("LibreHardwareMonitorLib.dll")
            .exists()
    }

    /// The age of the task's last reading, if it has made one.
    fn reading_age() -> Option<Duration> {
        let modified = std::fs::metadata(dir().join("sensors.json"))
            .and_then(|m| m.modified())
            .ok()?;
        SystemTime::now().duration_since(modified).ok()
    }

    /// Runs `mytunnels hardware <arg>` with administrator rights, which
    /// Windows asks for on this computer's screen.
    pub fn elevate(arg: &str) -> Result<()> {
        use std::os::windows::process::CommandExt;
        let exe = crate::config::program().context("cannot find this program")?;
        let script = format!(
            "Start-Process -FilePath '{}' -ArgumentList 'hardware','{arg}' -Verb RunAs -WindowStyle Hidden",
            exe.display().to_string().replace('\'', "''"),
        );
        std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                &crate::util::powershell_encoded(&script),
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(NO_WINDOW)
            .spawn()
            .context("cannot ask for administrator rights")?;
        Ok(())
    }

    async fn powershell_json(script: &str) -> Result<Value> {
        let out = tokio::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-EncodedCommand",
                &crate::util::powershell_encoded(script),
            ])
            .stdin(Stdio::null())
            .creation_flags(NO_WINDOW)
            .output()
            .await?;
        let text = String::from_utf8_lossy(&out.stdout);
        Ok(serde_json::from_str(
            text.trim().trim_start_matches('\u{feff}'),
        )?)
    }

    pub async fn collect(db: &Db, sources: &mut Sources, snap: &mut Snapshot, gpus: &[Gpu]) {
        let stale = sources
            .inventory
            .as_ref()
            .is_none_or(|(at, _)| at.elapsed() > Duration::from_secs(60));
        if stale {
            match powershell_json(INVENTORY).await {
                Ok(v) => sources.inventory = Some((Instant::now(), v)),
                Err(err) => tracing::warn!("could not read this computer's parts: {err:#}"),
            }
        }
        let inv = sources
            .inventory
            .as_ref()
            .map(|(_, v)| v.clone())
            .unwrap_or(Value::Null);
        let sensors = read_sensors(db, snap);
        let hw: Vec<&Value> = sensors
            .as_ref()
            .and_then(|s| s["hardware"].as_array())
            .map(|a| a.iter().collect())
            .unwrap_or_default();
        let of = |types: &[&str]| -> Vec<&Value> {
            hw.iter()
                .copied()
                .filter(|h| types.contains(&h["type"].as_str().unwrap_or("")))
                .collect()
        };
        let sensors_of = |h: &Value, kind: &str| -> Vec<(String, f64)> {
            h["sensors"]
                .as_array()
                .map(|list| {
                    list.iter()
                        .filter(|s| s["type"] == kind)
                        .filter_map(|s| {
                            Some((s["name"].as_str()?.to_owned(), s["value"].as_f64()?))
                        })
                        .collect()
                })
                .unwrap_or_default()
        };
        let task = snap.helper == "running";

        // Memory.
        snap.ecc = inv["ecc"].as_bool().unwrap_or(false);
        let sticks = inv["sticks"]
            .as_array()
            .map(|list| {
                list.iter()
                    .map(|s| Stick {
                        slot: text(&s["slot"]),
                        bank: text(&s["bank"]),
                        bytes: s["bytes"].as_u64().unwrap_or(0),
                        speed: s["speed"].as_u64().unwrap_or(0),
                        configured: s["configured"].as_u64().unwrap_or(0),
                        maker: text(&s["maker"]),
                        part: text(&s["part"]),
                        serial: text(&s["serial"]),
                        errors: None,
                    })
                    .collect()
            })
            .unwrap_or_default();
        if !inv.is_null() {
            memory(
                db,
                snap,
                sticks,
                inv["slots"].as_u64().unwrap_or(0) as usize,
            );
        }

        // The processor.
        for (i, c) in inv["cpus"].as_array().into_iter().flatten().enumerate() {
            let mut p = Part::new("cpu", format!("cpu:{i}"), text(&c["name"]));
            p.fact(
                "Cores",
                format!("{} cores, {} threads", c["cores"], c["threads"]),
            );
            p.fact("Base clock", format!("{} MHz", c["mhz"]));
            if let Some(h) = of(&["Cpu"]).get(i) {
                let temps = sensors_of(h, "Temperature");
                let package = temps.iter().find(|(n, _)| {
                    n.contains("Package") || n.contains("Tctl") || n.contains("Tdie")
                });
                let hottest = temps.iter().map(|(_, v)| *v).fold(f64::NAN, f64::max);
                if let Some(t) = package
                    .map(|(_, v)| *v)
                    .or((!hottest.is_nan()).then_some(hottest))
                {
                    p.read("Temperature", t, "°C", above(t, 85.0, 95.0), "Running hot");
                }
                if let Some((_, v)) = sensors_of(h, "Load")
                    .into_iter()
                    .find(|(n, _)| n.contains("Total"))
                {
                    p.read("Load", v, "%", Health::Ok, "");
                }
                if let Some((_, v)) = sensors_of(h, "Power")
                    .into_iter()
                    .find(|(n, _)| n.contains("Package"))
                {
                    p.read("Power", v, "W", Health::Ok, "");
                }
            }
            if p.readings.is_empty() {
                p.reason = if task {
                    "This processor reports no temperature".into()
                } else {
                    "Temperatures need the sensor task".into()
                };
            } else {
                p.judge(Health::Ok, "Normal temperature");
            }
            snap.parts.push(p);
        }

        // Graphics: NVIDIA cards through nvidia-smi, the rest by what Windows says of them.
        gpu_parts(snap, gpus);
        for (i, g) in inv["gpus"].as_array().into_iter().flatten().enumerate() {
            let name = text(&g["name"]);
            if gpus
                .iter()
                .any(|n| name.contains(&n.name) || n.name.contains(&name))
            {
                continue;
            }
            let mut p = Part::new("gpu", format!("gpu:{i}"), name.clone());
            p.fact("Driver", text(&g["driver"]));
            match g["error"].as_i64().unwrap_or(0) {
                0 => p.judge(Health::Ok, "Working"),
                code => p.judge(
                    Health::Bad,
                    format!("Windows reports a problem with this device (code {code})"),
                ),
            }
            if let Some(h) = of(&["GpuAmd", "GpuIntel"]).into_iter().find(|h| {
                h["name"]
                    .as_str()
                    .is_some_and(|n| name.contains(n) || n.contains(&name))
            }) {
                if let Some((_, t)) = sensors_of(h, "Temperature").into_iter().next() {
                    p.read("Temperature", t, "°C", above(t, 83.0, 90.0), "Running hot");
                }
            }
            snap.parts.push(p);
        }

        // Drives.
        let reliability: Vec<&Value> = sensors
            .as_ref()
            .and_then(|s| s["drives"].as_array())
            .map(|a| a.iter().collect())
            .unwrap_or_default();
        for d in inv["drives"].as_array().into_iter().flatten() {
            let id = text(&d["id"]);
            let name = text(&d["name"]);
            let media = text(&d["media"]);
            let mut p = Part::new(
                "drive",
                format!(
                    "drive:{}",
                    if text(&d["serial"]).is_empty() {
                        id.clone()
                    } else {
                        text(&d["serial"])
                    }
                ),
                name.clone(),
            );
            p.place = format!("Disk {id}");
            p.fact(
                "Kind",
                [media.as_str(), text(&d["bus"]).as_str()]
                    .join(" ")
                    .trim()
                    .to_owned(),
            );
            p.fact("Size", size(d["bytes"].as_u64().unwrap_or(0)));
            p.fact("Serial", text(&d["serial"]));
            match text(&d["health"]).as_str() {
                "Healthy" => p.judge(Health::Ok, "Windows reports it healthy"),
                "Warning" => p.judge(Health::Warn, "Windows reports a warning for this drive"),
                "Unhealthy" => p.judge(Health::Bad, "Windows reports this drive unhealthy"),
                _ => {}
            }
            let state = text(&d["state"]);
            if !state.is_empty() && state != "OK" {
                p.judge(Health::Warn, format!("Windows reports it: {state}"));
            }
            let hot = if media == "HDD" {
                (50.0, 60.0)
            } else {
                (65.0, 75.0)
            };
            let lhm = of(&["Storage"]).into_iter().find(|h| {
                h["name"]
                    .as_str()
                    .is_some_and(|n| !n.is_empty() && (name.contains(n) || n.contains(&name)))
            });
            let mut temp = None;
            if let Some(h) = lhm {
                temp = sensors_of(h, "Temperature")
                    .into_iter()
                    .next()
                    .map(|(_, t)| t);
                if let Some((_, life)) = sensors_of(h, "Level")
                    .into_iter()
                    .find(|(n, _)| n.contains("Life") || n.contains("Spare"))
                {
                    let health = if life <= 10.0 {
                        Health::Bad
                    } else if life <= 30.0 {
                        Health::Warn
                    } else {
                        Health::Ok
                    };
                    p.read(
                        "Life left",
                        life,
                        "%",
                        health,
                        "Close to the end of its rated life",
                    );
                }
            }
            if let Some(r) = reliability.iter().find(|r| text(&r["id"]) == id) {
                temp = temp.or_else(|| r["temperature"].as_f64().filter(|t| *t > 0.0));
                if let Some(wear) = r["wear"].as_f64() {
                    p.read(
                        "Worn",
                        wear,
                        "%",
                        above(wear, 70.0, 90.0),
                        "Close to the end of its rated life",
                    );
                }
                let errors = r["read_errors"].as_u64().unwrap_or(0)
                    + r["write_errors"].as_u64().unwrap_or(0);
                if r["read_errors"].is_number() || r["write_errors"].is_number() {
                    p.read(
                        "Uncorrected errors",
                        errors as f64,
                        "",
                        if errors > 0 { Health::Bad } else { Health::Ok },
                        "Has lost data it could not correct",
                    );
                }
                if let Some(hours) = r["hours"].as_u64() {
                    p.fact("Powered on", format!("{hours} hours"));
                }
            }
            if let Some(t) = temp {
                p.read(
                    "Temperature",
                    t,
                    "°C",
                    above(t, hot.0, hot.1),
                    "Running hot",
                );
            }
            snap.parts.push(p);
        }

        // Fans, voltages and the board, from the board's sensor chip.
        let board = of(&[
            "Motherboard",
            "SuperIO",
            "EmbeddedController",
            "Cooler",
            "FanController",
        ]);
        let mut found = Vec::new();
        for h in &board {
            for (name, rpm) in sensors_of(h, "Fan") {
                found.push((
                    format!("fan:{}:{name}", h["id"].as_str().unwrap_or("")),
                    name,
                    rpm,
                ));
            }
        }
        fans(db, snap, found);

        let mut power = Part::new("power", "power", "Power supply");
        for h in board.iter().chain(of(&["Psu"]).iter()) {
            for (name, volts) in sensors_of(h, "Voltage") {
                if let Some(nominal) = rail(&name) {
                    power.read(
                        &name,
                        volts,
                        "V",
                        rail_health(volts, nominal),
                        &format!("The {nominal} V rail reads {volts:.2} V"),
                    );
                }
            }
            if h["type"] == "Psu" {
                for (name, watts) in sensors_of(h, "Power") {
                    power.read(&name, watts, "W", Health::Ok, "");
                }
            }
        }
        if power.readings.is_empty() {
            power.reason = if task {
                "This board reports no supply voltages".into()
            } else {
                "Voltages need the sensor task".into()
            };
        } else {
            power.judge(Health::Ok, "Voltages within 5%");
        }
        snap.parts.push(power);

        let mut b = Part::new("board", "board", text(&inv["board"]));
        for h in &board {
            for (name, t) in sensors_of(h, "Temperature") {
                b.read(&name, t, "°C", above(t, 85.0, 100.0), "Running hot");
            }
        }
        if !b.name.is_empty() {
            b.judge(Health::Ok, "Normal");
            snap.parts.push(b);
        }

        // The System log.
        for e in inv["events"].as_array().into_iter().flatten() {
            if let Some(event) = event(e) {
                snap.events.push(event);
            }
        }
        snap.events.sort_by_key(|e| -e.at);
        notes_from_events(snap);
    }

    fn text(v: &Value) -> String {
        match v {
            Value::String(s) => s.trim().to_owned(),
            Value::Null => String::new(),
            other => other.to_string(),
        }
    }

    /// Bugcheck codes that point at memory.
    const MEMORY_CODES: [&str; 4] = ["0x0000001a", "0x0000004e", "0x00000050", "0x0000012b"];

    fn event(e: &Value) -> Option<Event> {
        let at = e["at"].as_i64()?;
        let text = text(&e["text"]);
        let lower = text.to_lowercase();
        let provider = e["provider"].as_str().unwrap_or("");
        let (kind, health, said) = if provider.ends_with("Kernel-Power") {
            (
                "power",
                Health::Warn,
                "Restarted without shutting down: a power loss, a crash, or a forced restart"
                    .to_owned(),
            )
        } else if provider.ends_with("WHEA-Logger") {
            let kind = if lower.contains("memory") {
                "memory"
            } else if lower.contains("processor") || lower.contains("cache") {
                "cpu"
            } else {
                "board"
            };
            let health = if e["level"].as_i64() == Some(2) || e["level"].as_i64() == Some(1) {
                Health::Bad
            } else {
                Health::Warn
            };
            (kind, health, format!("Hardware error reported: {text}"))
        } else {
            let code = MEMORY_CODES.iter().find(|c| lower.contains(*c));
            match code {
                Some(c) => (
                    "memory",
                    Health::Warn,
                    format!("Windows stopped with a memory error ({c})"),
                ),
                None if lower.contains("0x00000124") => (
                    "cpu",
                    Health::Bad,
                    "Windows stopped on an uncorrectable hardware error (0x00000124)".to_owned(),
                ),
                None => (
                    "board",
                    Health::Warn,
                    format!("Windows stopped unexpectedly: {text}"),
                ),
            }
        };
        Some(Event {
            at,
            kind,
            health,
            text: said,
        })
    }

    /// The sensor task's last reading, and how the task is doing.
    fn read_sensors(db: &Db, snap: &mut Snapshot) -> Option<Value> {
        let dir = dir();
        let now = util::now();
        let asked = db
            .setting("hardware_setup_at")
            .ok()
            .flatten()
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(0);
        // Setup's record: "installing <percent> <step>", "done" or "failed: <why>".
        let record = dir.join("setup.txt");
        let setup = std::fs::read_to_string(&record).unwrap_or_default();
        let setup_at = std::fs::metadata(&record)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_secs() as i64);
        let began = setup_at >= asked && setup_at > 0;
        let setup = setup.trim();
        if let Some(why) = setup.strip_prefix("failed:") {
            snap.helper_error = why.trim().to_owned();
        }
        // What stopped the task itself, written by sensors.ps1.
        if let Ok(error) = std::fs::read_to_string(dir.join("sensors.error.txt")) {
            if let Some((_, why)) = error.trim().split_once(' ') {
                snap.helper_error = why.trim().to_owned();
            }
        }
        let installing = setup
            .strip_prefix("installing ")
            .filter(|_| now - setup_at < 300);
        let reading = reading_age().is_some_and(|a| a < Duration::from_secs(30));
        snap.helper = if !began && now - asked < 120 {
            "waiting"
        } else if let Some(rest) = installing {
            let (percent, step) = rest.split_once(' ').unwrap_or((rest, ""));
            snap.helper_percent = percent.parse().ok();
            snap.helper_step = step.to_owned();
            "installing"
        } else if installed() && reading {
            "running"
        } else if setup == "done" && now - setup_at < 180 {
            "starting"
        } else if !installed() {
            if !began && now - asked < 900 && snap.helper_error.is_empty() {
                snap.helper_error =
                    "The Windows prompt was declined or closed before setup began.".into();
            }
            "missing"
        } else {
            "stale"
        };
        let raw = std::fs::read_to_string(dir.join("sensors.json")).ok()?;
        serde_json::from_str(raw.trim_start_matches('\u{feff}')).ok()
    }

    // ---- `mytunnels hardware on|off`, run with administrator rights ----

    pub async fn command(arg: Option<&str>) -> Result<()> {
        let dir = dir();
        let log = dir.join("setup.txt");
        let result = match arg {
            Some("on") => turn_on(&dir).await,
            Some("off") => turn_off(&dir),
            _ => bail!("use: mytunnels hardware on|off"),
        };
        if let Err(err) = &result {
            if dir.exists() {
                let _ = std::fs::write(&log, format!("failed: {err:#}\n"));
            }
        }
        result
    }

    fn run(program: &str, args: &[&str]) -> Result<()> {
        use std::os::windows::process::CommandExt;
        let out = std::process::Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .creation_flags(NO_WINDOW)
            .output()
            .with_context(|| format!("cannot run {program}"))?;
        if !out.status.success() {
            bail!(
                "{program} failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
        Ok(())
    }

    /// Whether Windows lists PawnIO as installed, where its own setup records it.
    fn pawnio_installed() -> bool {
        std::process::Command::new("reg")
            .args([
                "query",
                r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\PawnIO",
                "/v",
                "DisplayVersion",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    }

    /// Records the step under way, and how far along setup is, for the page.
    fn step(dir: &Path, percent: u8, text: &str) {
        let _ = std::fs::write(
            dir.join("setup.txt"),
            format!("installing {percent} {text}\n"),
        );
    }

    /// Downloads a pinned file, moving the record from `from` to `to` percent
    /// as it comes in, and checks it is the file that was checked.
    async fn fetch(
        client: &reqwest::Client,
        (url, sha): (&str, &str),
        dir: &Path,
        (from, to): (u8, u8),
        text: &str,
    ) -> Result<Vec<u8>> {
        step(dir, from, text);
        let mut answer = client.get(url).send().await?.error_for_status()?;
        let total = answer.content_length().unwrap_or(0);
        let mut body = Vec::with_capacity(total as usize);
        let mut shown = from;
        while let Some(chunk) = answer.chunk().await? {
            body.extend_from_slice(&chunk);
            if let Some(share) = (u64::from(to - from) * body.len() as u64).checked_div(total) {
                let percent = from + share.min(u64::from(to - from)) as u8;
                if percent != shown {
                    step(dir, percent, text);
                    shown = percent;
                }
            }
        }
        let got = hex::encode(Sha256::digest(&body));
        if got != sha {
            bail!("{url} is not the file that was checked (sha256 {got})");
        }
        Ok(body)
    }

    async fn turn_on(dir: &Path) -> Result<()> {
        std::fs::create_dir_all(dir)?;
        let path = dir.to_string_lossy().into_owned();
        // Only SYSTEM and administrators may change what SYSTEM runs from
        // here; everyone may read it. The folder holds the rules and what is
        // in it inherits them, which also puts right files from an earlier setup.
        run(
            "icacls",
            &[&path, "/setowner", "*S-1-5-32-544", "/T", "/C", "/Q"],
        )?;
        run(
            "icacls",
            &[
                &path,
                "/inheritance:r",
                "/grant:r",
                "*S-1-5-18:(OI)(CI)F",
                "*S-1-5-32-544:(OI)(CI)F",
                "*S-1-5-32-545:(OI)(CI)RX",
                "/C",
                "/Q",
            ],
        )?;
        let inside = dir.join("*").to_string_lossy().into_owned();
        let _ = run("icacls", &[&inside, "/reset", "/T", "/C", "/Q"]);
        // An earlier task holds the library open, and its error is old news.
        let _ = run("schtasks", &["/End", "/TN", TASK]);
        let _ = std::fs::remove_file(dir.join("sensors.error.txt"));
        let client = reqwest::Client::builder()
            .user_agent("mytunnels")
            .timeout(Duration::from_secs(300))
            .build()?;

        // The PawnIO driver, which the library reads the sensor chips
        // through: installed once, and left alone when Windows lists it.
        if !pawnio_installed() {
            let setup = dir.join("PawnIO_setup.exe");
            std::fs::write(
                &setup,
                fetch(
                    &client,
                    PAWNIO,
                    dir,
                    (2, 20),
                    "Downloading the PawnIO driver",
                )
                .await?,
            )?;
            step(dir, 20, "Installing the PawnIO driver");
            let installed = std::process::Command::new(&setup).arg("-install").status();
            let _ = std::fs::remove_file(&setup);
            installed.context("cannot run the PawnIO setup")?;
        }

        // The library and what it needs: the archive's top-level DLLs.
        let archive = fetch(
            &client,
            LHM,
            dir,
            (30, 80),
            "Downloading LibreHardwareMonitor",
        )
        .await?;
        step(dir, 80, "Unpacking the sensor library");
        let lib = dir.join("lib");
        for _ in 0..20 {
            if !lib.exists() || std::fs::remove_dir_all(&lib).is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        std::fs::create_dir_all(&lib)?;
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(archive))?;
        for i in 0..zip.len() {
            let mut file = zip.by_index(i)?;
            let name = file.name().to_owned();
            if name.contains('/') || !name.to_ascii_lowercase().ends_with(".dll") {
                continue;
            }
            let mut out = std::fs::File::create(lib.join(&name))?;
            std::io::copy(&mut file, &mut out)?;
        }

        step(dir, 90, "Adding the sensor task");
        let script = dir.join("sensors.ps1");
        std::fs::write(&script, SENSORS)?;
        let xml = task_xml(&script);
        let task = dir.join("task.xml");
        // schtasks reads the task as UTF-16.
        let mut bytes = vec![0xFF, 0xFE];
        bytes.extend(xml.encode_utf16().flat_map(u16::to_le_bytes));
        std::fs::write(&task, bytes)?;
        run(
            "schtasks",
            &[
                "/Create",
                "/TN",
                TASK,
                "/XML",
                &task.to_string_lossy(),
                "/F",
            ],
        )?;
        let _ = std::fs::remove_file(&task);
        step(dir, 97, "Starting the sensor task");
        run("schtasks", &["/Run", "/TN", TASK])?;
        std::fs::write(dir.join("setup.txt"), "done\n")?;
        Ok(())
    }

    fn task_xml(script: &Path) -> String {
        let script = script
            .display()
            .to_string()
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;");
        format!(
            r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Reads this computer's hardware sensors for the Hardware page in myTunnels.</Description></RegistrationInfo>
  <Triggers><BootTrigger><Enabled>true</Enabled></BootTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author"><Exec><Command>powershell.exe</Command><Arguments>-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{script}"</Arguments></Exec></Actions>
</Task>
"#
        )
    }

    fn turn_off(dir: &Path) -> Result<()> {
        let _ = run("schtasks", &["/End", "/TN", TASK]);
        let _ = run("schtasks", &["/Delete", "/TN", TASK, "/F"]);
        // The task's PowerShell can take a moment to let go of the library.
        for _ in 0..20 {
            if !dir.exists() || std::fs::remove_dir_all(dir).is_ok() {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        std::fs::remove_dir_all(dir).with_context(|| format!("cannot remove {}", dir.display()))
    }
}

/// `mytunnels hardware on|off`, which the page runs with administrator rights.
pub async fn command(arg: Option<&str>) -> Result<()> {
    #[cfg(windows)]
    return windows::command(arg).await;
    #[cfg(not(windows))]
    {
        let _ = arg;
        anyhow::bail!("only Windows needs this step")
    }
}

// ---- Linux ----

#[cfg(target_os = "linux")]
mod linux {
    use std::fs;
    use std::path::Path;

    use super::*;

    fn read(path: impl AsRef<Path>) -> Option<String> {
        fs::read_to_string(path)
            .ok()
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty())
    }

    fn number(path: impl AsRef<Path>) -> Option<f64> {
        read(path)?.parse().ok()
    }

    /// Each hwmon chip: its name, its folder, and its fans, temperatures and voltages.
    struct Chip {
        name: String,
        dir: std::path::PathBuf,
        fans: Vec<(String, String, f64)>,
        temps: Vec<(String, f64)>,
        volts: Vec<(String, f64)>,
    }

    fn chips() -> Vec<Chip> {
        let Ok(entries) = fs::read_dir("/sys/class/hwmon") else {
            return Vec::new();
        };
        let mut chips = Vec::new();
        for entry in entries.flatten() {
            let dir = entry.path();
            let name = read(dir.join("name")).unwrap_or_default();
            let mut chip = Chip {
                name: name.clone(),
                dir: dir.clone(),
                fans: Vec::new(),
                temps: Vec::new(),
                volts: Vec::new(),
            };
            for n in 0..=16 {
                if let Some(rpm) = number(dir.join(format!("fan{n}_input"))) {
                    let label = read(dir.join(format!("fan{n}_label")))
                        .unwrap_or_else(|| format!("Fan {n}"));
                    chip.fans.push((format!("fan:{name}:{n}"), label, rpm));
                }
                if let Some(m) = number(dir.join(format!("temp{n}_input"))) {
                    let label = read(dir.join(format!("temp{n}_label")))
                        .unwrap_or_else(|| format!("Temperature {n}"));
                    chip.temps.push((label, m / 1000.0));
                }
                if let Some(mv) = number(dir.join(format!("in{n}_input"))) {
                    let label =
                        read(dir.join(format!("in{n}_label"))).unwrap_or_else(|| format!("in{n}"));
                    chip.volts.push((label, mv / 1000.0));
                }
            }
            chips.push(chip);
        }
        chips
    }

    pub fn collect(db: &Db, snap: &mut Snapshot, gpus: &[Gpu]) {
        let chips = chips();

        // Memory: per stick through EDAC, where the memory counts its errors.
        let mut sticks = Vec::new();
        let mut slots = 0;
        if let Ok(mcs) = fs::read_dir("/sys/devices/system/edac/mc") {
            for mc in mcs.flatten() {
                let Ok(dimms) = fs::read_dir(mc.path()) else {
                    continue;
                };
                for dimm in dimms.flatten() {
                    let d = dimm.path();
                    let name = dimm.file_name().to_string_lossy().into_owned();
                    if !(name.starts_with("dimm") || name.starts_with("rank")) {
                        continue;
                    }
                    slots += 1;
                    let mb = number(d.join("size")).unwrap_or(0.0) as u64;
                    if mb == 0 {
                        continue;
                    }
                    sticks.push(Stick {
                        slot: read(d.join("dimm_label")).unwrap_or(name),
                        bank: read(d.join("dimm_location")).unwrap_or_default(),
                        bytes: mb << 20,
                        speed: 0,
                        configured: 0,
                        maker: String::new(),
                        part: read(d.join("dimm_mem_type")).unwrap_or_default(),
                        serial: String::new(),
                        errors: Some((
                            number(d.join("dimm_ce_count")).unwrap_or(0.0) as u64,
                            number(d.join("dimm_ue_count")).unwrap_or(0.0) as u64,
                        )),
                    });
                }
            }
        }
        if sticks.is_empty() {
            let total = read("/proc/meminfo")
                .and_then(|m| {
                    m.lines()
                        .find(|l| l.starts_with("MemTotal:"))
                        .and_then(|l| l.split_whitespace().nth(1)?.parse::<u64>().ok())
                })
                .unwrap_or(0);
            let mut p = Part::new("memory", "memory", format!("{} in all", size(total << 10)));
            p.bytes = Some(total << 10);
            p.reason =
                "Each stick shows here where the memory reports itself (EDAC, with ECC memory)"
                    .into();
            snap.parts.push(p);
        } else {
            snap.ecc = true;
            memory(db, snap, sticks, slots);
        }

        // The processor.
        let cpuinfo = read("/proc/cpuinfo").unwrap_or_default();
        let model = cpuinfo
            .lines()
            .find(|l| l.starts_with("model name"))
            .and_then(|l| l.split_once(':'))
            .map(|(_, v)| v.trim().to_owned())
            .unwrap_or_else(|| "Processor".into());
        let mut cpu = Part::new("cpu", "cpu:0", model);
        cpu.fact(
            "Threads",
            cpuinfo
                .lines()
                .filter(|l| l.starts_with("processor"))
                .count()
                .to_string(),
        );
        if let Some(chip) = chips
            .iter()
            .find(|c| ["coretemp", "k10temp", "zenpower", "cpu_thermal"].contains(&c.name.as_str()))
        {
            let package = chip
                .temps
                .iter()
                .find(|(l, _)| l.contains("Package") || l.contains("Tctl") || l.contains("Tdie"));
            let hottest = chip.temps.iter().map(|(_, t)| *t).fold(f64::NAN, f64::max);
            if let Some(t) = package
                .map(|(_, t)| *t)
                .or((!hottest.is_nan()).then_some(hottest))
            {
                cpu.read("Temperature", t, "°C", above(t, 85.0, 95.0), "Running hot");
                cpu.judge(Health::Ok, "Normal temperature");
            }
        }
        if cpu.readings.is_empty() {
            cpu.reason = "This processor reports no temperature".into();
        }
        snap.parts.push(cpu);

        // Graphics.
        gpu_parts(snap, gpus);
        for chip in chips.iter().filter(|c| c.name == "amdgpu") {
            let mut p = Part::new("gpu", format!("gpu:{}", chip.dir.display()), "AMD graphics");
            if let Some((_, t)) = chip.temps.first() {
                p.read(
                    "Temperature",
                    *t,
                    "°C",
                    above(*t, 90.0, 100.0),
                    "Running hot",
                );
            }
            if let Some(w) = number(chip.dir.join("power1_average")) {
                p.read("Power", w / 1_000_000.0, "W", Health::Ok, "");
            }
            p.judge(Health::Ok, "Working");
            snap.parts.push(p);
        }

        // Drives: each disk, with its temperature where its chip reports one.
        let drive_temps: Vec<(String, f64)> = chips
            .iter()
            .filter(|c| c.name == "nvme" || c.name == "drivetemp")
            .filter_map(|c| {
                Some((
                    read(c.dir.join("device/model"))
                        .or_else(|| read(c.dir.join("device/device/model")))?,
                    c.temps.first()?.1,
                ))
            })
            .collect();
        if let Ok(blocks) = fs::read_dir("/sys/block") {
            for b in blocks.flatten() {
                let name = b.file_name().to_string_lossy().into_owned();
                if ["loop", "ram", "zram", "dm-", "md", "sr", "fd"]
                    .iter()
                    .any(|p| name.starts_with(p))
                {
                    continue;
                }
                let dir = b.path();
                let model = read(dir.join("device/model")).unwrap_or_else(|| name.clone());
                let sectors = number(dir.join("size")).unwrap_or(0.0) as u64;
                let rotational = read(dir.join("queue/rotational")).as_deref() == Some("1");
                let mut p = Part::new("drive", format!("drive:{name}"), model.clone());
                p.place = format!("/dev/{name}");
                p.fact("Kind", if rotational { "HDD" } else { "SSD" });
                p.fact("Size", size(sectors * 512));
                p.fact(
                    "Serial",
                    read(dir.join("device/serial")).unwrap_or_default(),
                );
                if let Some((_, t)) = drive_temps.iter().find(|(m, _)| {
                    !m.is_empty() && (model.contains(m.as_str()) || m.contains(&model))
                }) {
                    let hot = if rotational {
                        (50.0, 60.0)
                    } else {
                        (65.0, 75.0)
                    };
                    p.read(
                        "Temperature",
                        *t,
                        "°C",
                        above(*t, hot.0, hot.1),
                        "Running hot",
                    );
                    p.judge(Health::Ok, "Normal temperature");
                }
                if p.readings.is_empty() {
                    p.reason = "Wear and errors need SMART access, which takes root".into();
                }
                snap.parts.push(p);
            }
        }

        // Fans, voltages and the board's own sensors.
        let boards: Vec<&Chip> = chips
            .iter()
            .filter(|c| {
                ![
                    "coretemp",
                    "k10temp",
                    "zenpower",
                    "cpu_thermal",
                    "amdgpu",
                    "nvme",
                    "drivetemp",
                    "acpitz",
                ]
                .contains(&c.name.as_str())
            })
            .collect();
        fans(
            db,
            snap,
            boards.iter().flat_map(|c| c.fans.clone()).collect(),
        );
        let mut power = Part::new("power", "power", "Power supply");
        for c in &boards {
            for (label, volts) in &c.volts {
                if let Some(nominal) = rail(label) {
                    power.read(
                        label,
                        *volts,
                        "V",
                        rail_health(*volts, nominal),
                        &format!("The {nominal} V rail reads {volts:.2} V"),
                    );
                }
            }
        }
        if power.readings.is_empty() {
            power.reason = "This board reports no supply voltages".into();
        } else {
            power.judge(Health::Ok, "Voltages within 5%");
        }
        snap.parts.push(power);
        let vendor = read("/sys/class/dmi/id/board_vendor").unwrap_or_default();
        let board = read("/sys/class/dmi/id/board_name").unwrap_or_default();
        if !board.is_empty() {
            let mut p = Part::new(
                "board",
                "board",
                format!("{vendor} {board}").trim().to_owned(),
            );
            for c in &boards {
                for (label, t) in &c.temps {
                    p.read(label, *t, "°C", above(*t, 85.0, 100.0), "Running hot");
                }
            }
            p.judge(Health::Ok, "Normal");
            snap.parts.push(p);
        }
        notes_from_events(snap);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_empty_slots_from_the_filled_ones() {
        let none = BTreeMap::new();
        assert_eq!(
            empty_slots(&["ChannelA-DIMM1", "ChannelB-DIMM1"], &none, 4),
            ["ChannelA-DIMM0", "ChannelB-DIMM0"]
        );
        // One stick still means two channels on a four-slot board.
        assert_eq!(
            empty_slots(&["ChannelA-DIMM1"], &none, 4),
            ["ChannelA-DIMM0", "ChannelB-DIMM0", "ChannelB-DIMM1"]
        );
        // Names it cannot read leave the empty slots unnamed.
        assert!(empty_slots(&["DIMM 1"], &none, 4).is_empty());
    }

    #[test]
    fn judges_supply_rails() {
        assert_eq!(rail("+12V"), Some(12.0));
        assert_eq!(rail("3VCC"), Some(3.3));
        assert_eq!(rail("+5V"), Some(5.0));
        assert_eq!(rail("5VSB"), None);
        assert_eq!(rail("Vcore"), None);
        assert_eq!(rail_health(12.1, 12.0), Health::Ok);
        assert_eq!(rail_health(11.3, 12.0), Health::Warn);
        assert_eq!(rail_health(10.5, 12.0), Health::Bad);
    }

    #[test]
    fn the_worst_reading_stands() {
        let mut p = Part::new("cpu", "cpu:0", "CPU");
        p.read(
            "Temperature",
            90.0,
            "°C",
            above(90.0, 85.0, 95.0),
            "Running hot",
        );
        p.judge(Health::Ok, "Normal temperature");
        assert_eq!((p.health, p.reason.as_str()), (Health::Warn, "Running hot"));
    }
}
