//! What the Dashboard page shows: the host's processors, memory, temperatures,
//! disks and network, and each container's usage, sampled every two seconds
//! with the last five minutes kept.
//!
//! Docker Desktop runs containers in a virtual machine, so from inside one the
//! host's figures are the machine's that Docker was given. `server host` runs
//! on the computer itself and serves its own; when `HOST_URL` reaches it, the
//! Dashboard shows those, with the containers as the engine sees them.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::Ordering;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use anyhow::Context;
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;
use serde_json::{json, Value};
use sysinfo::{Components, Disks, Networks, System};
use tokio::task::JoinSet;

use crate::docker::{self, Endpoint};
use crate::util::now;

const EVERY: Duration = Duration::from_secs(2);
/// Samples kept: five minutes at one every two seconds.
const KEEP: usize = 150;
/// Where `server host` answers by default: this computer alone.
const HOST_ADDR: &str = "127.0.0.1:7094";
/// The machine's figures older than this are not shown.
const FRESH: Duration = Duration::from_secs(10);

#[derive(Clone, Serialize)]
struct Sample {
    at: i64,
    cpu: f32,
    cores: Vec<f32>,
    memory: u64,
    swap: u64,
    rx: u64,
    tx: u64,
    temp: Option<f32>,
}

#[derive(Clone, Serialize)]
struct Core {
    usage: f32,
    mhz: u64,
    temp: Option<f32>,
}

#[derive(Clone, Serialize)]
struct Sensor {
    label: String,
    temp: f32,
    max: Option<f32>,
    critical: Option<f32>,
}

#[derive(Clone, Serialize)]
struct Disk {
    name: String,
    mount: String,
    fs: String,
    total: u64,
    available: u64,
}

#[derive(Clone, Serialize)]
struct Container {
    id: String,
    name: String,
    image: String,
    state: String,
    status: String,
    cpu: f32,
    memory: u64,
    memory_limit: u64,
    /// Processors it may use; 0 for no limit.
    cpu_limit: f64,
    rx: u64,
    tx: u64,
    read: u64,
    write: u64,
    history: Vec<f32>,
}

/// A running container's counters at the last sample, to turn into rates.
struct Counters {
    at: Instant,
    cpu: u64,
    system: u64,
    rx: u64,
    tx: u64,
    read: u64,
    write: u64,
}

#[derive(Default)]
struct Board {
    host: Value,
    memory_total: u64,
    swap_total: u64,
    history: VecDeque<Sample>,
    cores: Vec<Core>,
    sensors: Vec<Sensor>,
    disks: Vec<Disk>,
    docker_error: Option<String>,
    containers: Vec<Container>,
    /// The machine's own figures from `server host`, and when they came.
    machine: Option<(Instant, Value)>,
}

static BOARD: LazyLock<Mutex<Board>> = LazyLock::new(Mutex::default);

/// Everything sampled so far, for `/api/metrics`.
pub fn view() -> Value {
    let board = BOARD.lock().unwrap();
    let docker = json!({
        "reachable": board.docker_error.is_none(),
        "error": board.docker_error,
        "containers": board.containers,
    });
    if let Some((at, machine)) = &board.machine {
        if at.elapsed() < FRESH {
            let mut view = machine.clone();
            view["host"]["docker"] = board.host["docker"].clone();
            view["docker"] = docker;
            return view;
        }
    }
    json!({
        "every": EVERY.as_secs(),
        "keep": KEEP,
        "host": board.host,
        "uptime": System::uptime(),
        "load": load(),
        "memory_total": board.memory_total,
        "swap_total": board.swap_total,
        "history": board.history,
        "cores": board.cores,
        "sensors": board.sensors,
        "disks": board.disks,
        "docker": docker,
    })
}

fn load() -> Option<[f64; 3]> {
    if cfg!(windows) {
        return None;
    }
    let avg = System::load_average();
    Some([avg.one, avg.five, avg.fifteen])
}

pub fn spawn() {
    tokio::spawn(run(true));
}

/// `server host`: samples this computer, without containers, and serves it at
/// `HOST_ADDR` (127.0.0.1:7094 unless set) for the Dashboard to read.
pub async fn serve_host() -> anyhow::Result<()> {
    let addr = std::env::var("HOST_ADDR").unwrap_or_else(|_| HOST_ADDR.into());
    tokio::spawn(run(false));
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .with_context(|| format!("cannot listen on {addr}"))?;
    tracing::info!("this computer's figures on http://{addr}/metrics");
    let app = Router::new()
        .route("/metrics", get(|| async { Json(view()) }))
        .merge(crate::apps::host_routes());
    axum::serve(listener, app).await?;
    Ok(())
}

/// The machine's own figures, from `server host` at `HOST_URL`.
async fn machine(client: &reqwest::Client, url: &str) -> Option<Value> {
    let response = client
        .get(format!("{}/metrics", url.trim_end_matches('/')))
        .send()
        .await
        .ok()?;
    response.error_for_status().ok()?.json().await.ok()
}

async fn run(engine: bool) {
    let mut system = System::new();
    system.refresh_cpu_all();
    let mut components = Components::new_with_refreshed_list();
    let mut networks = Networks::new_with_refreshed_list();
    let mut disks = Disks::new_with_refreshed_list();
    let core_ids: Vec<Option<u32>> = (0..system.cpus().len()).map(core_id).collect();
    let docker = Arc::new(Endpoint::from_env());
    let mut docker_info: Option<Value> = None;
    let mut counters: HashMap<String, Counters> = HashMap::new();
    let mut histories: HashMap<String, VecDeque<f32>> = HashMap::new();
    let mut cpu_limits: HashMap<String, f64> = HashMap::new();
    let host_url = std::env::var("HOST_URL").ok().filter(|u| !u.is_empty());
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(1500))
        .build()
        .unwrap_or_default();
    let mut last;
    let mut tick = 0u32;

    let mut interval = tokio::time::interval(EVERY);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    // The first tick is at once; rates need a full interval behind them.
    interval.tick().await;
    last = Instant::now();
    loop {
        interval.tick().await;
        tick += 1;
        let elapsed = last.elapsed().as_secs_f64().max(0.001);
        last = Instant::now();

        system.refresh_cpu_all();
        system.refresh_memory();
        components.refresh(true);
        networks.refresh(true);
        // Disks come and go rarely; their space is read every ten seconds.
        if tick % 5 == 1 {
            disks.refresh(true);
        }

        let sensors = sensors(&components);
        let cores: Vec<Core> = system
            .cpus()
            .iter()
            .zip(&core_ids)
            .map(|(cpu, id)| Core {
                usage: round(cpu.cpu_usage()),
                mhz: cpu.frequency(),
                temp: id.and_then(|id| core_temp(&sensors, id)),
            })
            .collect();
        let (rx, tx) = networks
            .iter()
            .filter(|(name, _)| counted(name))
            .fold((0, 0), |(rx, tx), (_, data)| {
                (rx + data.received(), tx + data.transmitted())
            });
        let sample = Sample {
            at: now(),
            cpu: round(system.global_cpu_usage()),
            cores: cores.iter().map(|c| c.usage).collect(),
            memory: system.used_memory(),
            swap: system.used_swap(),
            rx: (rx as f64 / elapsed) as u64,
            tx: (tx as f64 / elapsed) as u64,
            temp: cpu_temp(&sensors, &cores).or_else(crate::hardware::cpu_temp),
        };

        let containers = if engine {
            // Limits are read again every half minute, and at once after a change.
            if crate::limits::CHANGED.swap(false, Ordering::Relaxed) || tick.is_multiple_of(15) {
                cpu_limits.clear();
            }
            let machine_cpus = docker_info
                .as_ref()
                .and_then(|i| i["NCPU"].as_f64())
                .unwrap_or(f64::MAX);
            let found = containers(&docker, &mut counters, &mut histories).await;
            match found {
                Ok(mut list) => {
                    for c in list.iter_mut().filter(|c| c.state == "running") {
                        if !cpu_limits.contains_key(&c.id) {
                            let limit = docker::get(&docker, &format!("/containers/{}/json", c.id))
                                .await
                                .map_or(0.0, |v| {
                                    crate::limits::cpus_of(&v["HostConfig"], machine_cpus)
                                });
                            cpu_limits.insert(c.id.clone(), limit);
                        }
                        c.cpu_limit = cpu_limits[&c.id];
                    }
                    Ok(list)
                }
                Err(e) => Err(e),
            }
        } else {
            Ok(Vec::new())
        };
        if engine && containers.is_ok() && (docker_info.is_none() || tick.is_multiple_of(150)) {
            docker_info = docker::get(&docker, "/info").await.ok();
        }
        let machine = match &host_url {
            Some(url) => machine(&client, url).await,
            None => None,
        };

        let mut board = BOARD.lock().unwrap();
        if let Some(machine) = machine {
            board.machine = Some((Instant::now(), machine));
        }
        board.host = host(&system, docker_info.as_ref());
        board.memory_total = system.total_memory();
        board.swap_total = system.total_swap();
        board.history.push_back(sample);
        while board.history.len() > KEEP {
            board.history.pop_front();
        }
        board.cores = cores;
        board.sensors = sensors;
        board.disks = disk_list(&disks);
        match containers {
            Ok(list) => {
                board.containers = list;
                board.docker_error = None;
            }
            Err(e) => {
                board.containers.clear();
                board.docker_error = Some(e.to_string());
            }
        }
    }
}

/// The machine, as Docker sees it when it can be asked: from inside a
/// container its own name is only the container's.
fn host(system: &System, info: Option<&Value>) -> Value {
    let from = |key: &str| {
        info.and_then(|i| i[key].as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    json!({
        "name": from("Name").or_else(System::host_name),
        "os": from("OperatingSystem").or_else(System::long_os_version),
        "kernel": from("KernelVersion").or_else(System::kernel_version),
        "arch": System::cpu_arch(),
        "cpu": system.cpus().first().map(|c| c.brand().trim().to_owned()),
        "threads": system.cpus().len(),
        "cores": System::physical_core_count(),
        "docker": from("ServerVersion"),
    })
}

/// Interfaces whose traffic counts: not loopback, and not the bridges and
/// virtual pairs containers hang off, which would count the same bytes twice.
fn counted(name: &str) -> bool {
    !(name == "lo"
        || name.starts_with("veth")
        || name.starts_with("docker")
        || name.starts_with("br-")
        || name.starts_with("virbr")
        || name.starts_with("Loopback"))
}

/// The physical core a logical processor belongs to, which is how Linux
/// labels per-core temperatures.
fn core_id(cpu: usize) -> Option<u32> {
    std::fs::read_to_string(format!("/sys/devices/system/cpu/cpu{cpu}/topology/core_id"))
        .ok()?
        .trim()
        .parse()
        .ok()
}

fn sensors(components: &Components) -> Vec<Sensor> {
    let mut list: Vec<Sensor> = components
        .iter()
        .filter_map(|c| {
            let temp = c.temperature().filter(|t| t.is_finite() && *t > 0.0)?;
            Some(Sensor {
                label: c.label().to_owned(),
                temp: round(temp),
                max: c.max().filter(|t| t.is_finite() && *t > 0.0).map(round),
                critical: c
                    .critical()
                    .filter(|t| t.is_finite() && *t > 0.0)
                    .map(round),
            })
        })
        .collect();
    list.sort_by_key(|s| natural(&s.label));
    list
}

/// Sorts `Core 10` after `Core 9`.
fn natural(label: &str) -> (String, u64) {
    let digits = label.len() - label.trim_end_matches(|c: char| c.is_ascii_digit()).len();
    let (text, number) = label.split_at(label.len() - digits);
    (text.to_owned(), number.parse().unwrap_or(0))
}

fn core_temp(sensors: &[Sensor], id: u32) -> Option<f32> {
    let suffix = format!("Core {id}");
    sensors
        .iter()
        .find(|s| s.label.ends_with(&suffix))
        .map(|s| s.temp)
}

/// The processor's temperature: its package sensor where there is one,
/// otherwise the hottest core.
fn cpu_temp(sensors: &[Sensor], cores: &[Core]) -> Option<f32> {
    const PACKAGE: [&str; 5] = ["Package id 0", "Tdie", "Tctl", "cpu_thermal", "CPU"];
    PACKAGE
        .iter()
        .find_map(|name| sensors.iter().find(|s| s.label.contains(name)))
        .map(|s| s.temp)
        .or_else(|| cores.iter().filter_map(|c| c.temp).reduce(f32::max))
}

fn disk_list(disks: &Disks) -> Vec<Disk> {
    let mut seen = Vec::new();
    let mut list = Vec::new();
    for disk in disks.iter() {
        let name = disk.name().to_string_lossy().into_owned();
        let mount = disk.mount_point().to_string_lossy().into_owned();
        let skip = disk.total_space() == 0
            || ["/etc/", "/proc", "/sys", "/dev", "/run"]
                .iter()
                .any(|p| mount.starts_with(p));
        if skip || seen.contains(&(name.clone(), disk.total_space())) {
            continue;
        }
        seen.push((name.clone(), disk.total_space()));
        list.push(Disk {
            name,
            mount,
            fs: disk.file_system().to_string_lossy().into_owned(),
            total: disk.total_space(),
            available: disk.available_space(),
        });
    }
    list
}

async fn containers(
    docker: &Arc<Endpoint>,
    counters: &mut HashMap<String, Counters>,
    histories: &mut HashMap<String, VecDeque<f32>>,
) -> anyhow::Result<Vec<Container>> {
    let listed = docker::get(docker, "/containers/json?all=1").await?;
    let listed = listed.as_array().cloned().unwrap_or_default();

    let mut stats = JoinSet::new();
    for c in &listed {
        if c["State"] != "running" {
            continue;
        }
        let id = c["Id"].as_str().unwrap_or_default().to_owned();
        let endpoint = docker.clone();
        stats.spawn(async move {
            let path = format!("/containers/{id}/stats?stream=false&one-shot=true");
            (id, docker::get(&endpoint, &path).await.ok())
        });
    }
    let mut found: HashMap<String, Value> = HashMap::new();
    while let Some(Ok((id, value))) = stats.join_next().await {
        if let Some(value) = value {
            found.insert(id, value);
        }
    }

    let mut list = Vec::new();
    for c in &listed {
        let id = c["Id"].as_str().unwrap_or_default().to_owned();
        let name = c["Names"][0]
            .as_str()
            .unwrap_or_default()
            .trim_start_matches('/')
            .to_owned();
        let mut item = Container {
            id: id.chars().take(12).collect(),
            name,
            image: c["Image"].as_str().unwrap_or_default().to_owned(),
            state: c["State"].as_str().unwrap_or_default().to_owned(),
            status: c["Status"].as_str().unwrap_or_default().to_owned(),
            cpu: 0.0,
            memory: 0,
            memory_limit: 0,
            cpu_limit: 0.0,
            rx: 0,
            tx: 0,
            read: 0,
            write: 0,
            history: Vec::new(),
        };
        if let Some(stats) = found.get(&id) {
            let next = read_counters(stats);
            if let Some(before) = counters.get(&id) {
                let secs = next.at.duration_since(before.at).as_secs_f64().max(0.001);
                let rate = |a: u64, b: u64| (a.saturating_sub(b) as f64 / secs) as u64;
                let cpu = next.cpu.saturating_sub(before.cpu) as f64;
                let system = next.system.saturating_sub(before.system) as f64;
                let online = stats["cpu_stats"]["online_cpus"].as_f64().unwrap_or(1.0);
                if system > 0.0 {
                    item.cpu = round((cpu / system * online * 100.0) as f32);
                }
                item.rx = rate(next.rx, before.rx);
                item.tx = rate(next.tx, before.tx);
                item.read = rate(next.read, before.read);
                item.write = rate(next.write, before.write);
            }
            item.memory = memory_used(&stats["memory_stats"]);
            item.memory_limit = stats["memory_stats"]["limit"].as_u64().unwrap_or(0);
            counters.insert(id.clone(), next);
            let history = histories.entry(id.clone()).or_default();
            history.push_back(item.cpu);
            while history.len() > KEEP {
                history.pop_front();
            }
            item.history = history.iter().copied().collect();
        }
        list.push(item);
    }
    counters.retain(|id, _| found.contains_key(id));
    histories.retain(|id, _| found.contains_key(id));
    list.sort_by(|a, b| {
        (a.state != "running", a.name.to_lowercase())
            .cmp(&(b.state != "running", b.name.to_lowercase()))
    });
    Ok(list)
}

fn read_counters(stats: &Value) -> Counters {
    let networks = stats["networks"].as_object();
    let net = |key: &str| networks.map_or(0, |n| n.values().filter_map(|v| v[key].as_u64()).sum());
    let io = |op: &str| {
        stats["blkio_stats"]["io_service_bytes_recursive"]
            .as_array()
            .map_or(0, |list| {
                list.iter()
                    .filter(|e| e["op"].as_str().is_some_and(|o| o.eq_ignore_ascii_case(op)))
                    .filter_map(|e| e["value"].as_u64())
                    .sum()
            })
    };
    Counters {
        at: Instant::now(),
        cpu: stats["cpu_stats"]["cpu_usage"]["total_usage"]
            .as_u64()
            .unwrap_or(0),
        system: stats["cpu_stats"]["system_cpu_usage"].as_u64().unwrap_or(0),
        rx: net("rx_bytes"),
        tx: net("tx_bytes"),
        read: io("read"),
        write: io("write"),
    }
}

/// Memory in use as `docker stats` counts it: without the page cache the
/// kernel can drop at will.
fn memory_used(memory: &Value) -> u64 {
    let usage = memory["usage"].as_u64().unwrap_or(0);
    let stats = &memory["stats"];
    let cache = stats["inactive_file"]
        .as_u64()
        .or_else(|| stats["total_inactive_file"].as_u64())
        .unwrap_or(0);
    usage.saturating_sub(cache)
}

fn round(value: f32) -> f32 {
    (value * 10.0).round() / 10.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sorts_numbers_naturally() {
        let mut labels = vec!["coretemp Core 10", "coretemp Core 2", "acpitz temp1"];
        labels.sort_by_key(|l| natural(l));
        assert_eq!(
            labels,
            ["acpitz temp1", "coretemp Core 2", "coretemp Core 10"]
        );
    }

    #[test]
    fn memory_leaves_out_cache() {
        let v2 = json!({ "usage": 1000, "stats": { "inactive_file": 300 } });
        let v1 = json!({ "usage": 1000, "stats": { "total_inactive_file": 100 } });
        assert_eq!(memory_used(&v2), 700);
        assert_eq!(memory_used(&v1), 900);
    }

    #[test]
    fn skips_virtual_interfaces() {
        assert!(counted("eth0"));
        assert!(!counted("lo"));
        assert!(!counted("veth12ab"));
        assert!(!counted("br-1f2e"));
    }
}
