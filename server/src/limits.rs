//! Each container's resources: how much CPU and memory it may use, its swap,
//! how many processes it may run and how it restarts. Set from its page, they
//! apply at once through the engine, and are kept here by the container's name
//! so a container made again, by Compose or by a new build, gets them back.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use hyper::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::docker::{self, Endpoint};
use crate::state::AppState;
use crate::util::{ApiError, ApiResult};

const WAIT: Duration = Duration::from_secs(15);
/// How often containers are checked for one made again without its resources.
const EVERY: Duration = Duration::from_secs(10);
/// The engine refuses less memory than this.
const MIN_MEMORY: u64 = 6 * 1024 * 1024;
const MAX_PIDS: u64 = 4_194_304;
const RESTARTS: [&str; 4] = ["no", "on-failure", "unless-stopped", "always"];
const PRIORITIES: [(&str, i64); 3] = [("low", 512), ("normal", 1024), ("high", 2048)];

/// Set when resources change, so the Dashboard reads them again at once.
pub static CHANGED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Limits {
    /// Processors it may use, in whole or part; 0 for no limit.
    pub cpus: f64,
    /// Its share of the processors when they are busy: low, normal or high.
    pub priority: String,
    /// Memory it may use, in bytes; 0 for no limit.
    pub memory: u64,
    /// Memory it is held to when the machine runs short, in bytes; 0 for none.
    pub reserve: u64,
    /// Swap it may use beyond its memory, in bytes; -1 for no limit.
    pub swap: i64,
    /// Processes it may run at once; 0 for no limit.
    pub pids: u64,
    /// When the engine starts it again: no, on-failure, unless-stopped or always.
    pub restart: String,
    /// Tries on failure before giving up; 0 for no end.
    pub retries: u32,
}

/// The engine's processors and memory: the most a container can be given.
struct Engine {
    cpus: f64,
    memory: u64,
}

async fn engine(endpoint: &Endpoint) -> anyhow::Result<Engine> {
    let info = docker::get(endpoint, "/info").await?;
    Ok(Engine {
        cpus: info["NCPU"].as_f64().unwrap_or(1.0),
        memory: info["MemTotal"].as_u64().unwrap_or(0),
    })
}

fn engine_error(err: anyhow::Error) -> ApiError {
    ApiError(StatusCode::BAD_GATEWAY, format!("{err:#}"))
}

/// A container named in a request, as Docker names them.
fn checked(id: &str) -> ApiResult<&str> {
    let ok = (1..=128).contains(&id.len())
        && id.as_bytes()[0].is_ascii_alphanumeric()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b));
    ok.then_some(id)
        .ok_or_else(|| ApiError::bad("No such container"))
}

/// The resources a container has now, read from what the engine holds. "No
/// limit" is set as the whole machine, so that reads back as no limit.
fn read(host: &Value, e: &Engine) -> Limits {
    let int = |key: &str| host[key].as_i64().unwrap_or(0);
    let shares = int("CpuShares");
    let memory = u64::try_from(int("Memory")).unwrap_or(0);
    let memory = if e.memory > 0 && memory >= e.memory {
        0
    } else {
        memory
    };
    let reserve = u64::try_from(int("MemoryReservation")).unwrap_or(0);
    let swap_total = int("MemorySwap");
    let restart = host["RestartPolicy"]["Name"]
        .as_str()
        .filter(|n| RESTARTS.contains(n))
        .unwrap_or("no");
    Limits {
        cpus: cpus_of(host, e.cpus),
        priority: match shares {
            0 | 1024 => "normal",
            s if s < 1024 => "low",
            _ => "high",
        }
        .into(),
        memory,
        reserve: if memory == 0 || reserve >= memory {
            0
        } else {
            reserve
        },
        swap: if memory == 0 || swap_total < 0 {
            -1
        } else {
            (swap_total - memory as i64).max(0)
        },
        pids: u64::try_from(int("PidsLimit")).unwrap_or(0),
        restart: restart.into(),
        retries: host["RestartPolicy"]["MaximumRetryCount"]
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .unwrap_or(0),
    }
}

/// The processors a container may use, from its engine settings; 0 for no
/// limit, which includes being given all `machine` has.
pub fn cpus_of(host: &Value, machine: f64) -> f64 {
    let int = |key: &str| host[key].as_i64().unwrap_or(0);
    let period = match int("CpuPeriod") {
        0 => 100_000,
        p => p,
    };
    let cpus = match (int("NanoCpus"), int("CpuQuota")) {
        (nano, _) if nano > 0 => nano as f64 / 1e9,
        (_, quota) if quota > 0 => quota as f64 / period as f64,
        _ => 0.0,
    };
    if cpus >= machine {
        0.0
    } else {
        (cpus * 100.0).round() / 100.0
    }
}

/// Whether `l` is something the engine can be given here.
fn check(l: &Limits, e: &Engine) -> Result<(), String> {
    if !(l.cpus == 0.0 || (0.01..=e.cpus).contains(&l.cpus)) {
        return Err(format!("CPUs: from 0.01 to {}", e.cpus));
    }
    if !PRIORITIES.iter().any(|(p, _)| *p == l.priority) {
        return Err("Priority must be low, normal or high".into());
    }
    if l.memory != 0 && (l.memory < MIN_MEMORY || (e.memory > 0 && l.memory > e.memory)) {
        return Err("Memory: at least 6 MB, and no more than the machine has".into());
    }
    if l.reserve != 0 && (l.reserve < MIN_MEMORY || (l.memory != 0 && l.reserve > l.memory)) {
        return Err("Reserved memory: at least 6 MB, and no more than its limit".into());
    }
    if l.swap < -1 {
        return Err("Swap must be a size, or no limit".into());
    }
    if l.pids > MAX_PIDS {
        return Err("Too many processes".into());
    }
    if !RESTARTS.contains(&l.restart.as_str()) {
        return Err("Restart must be no, on-failure, unless-stopped or always".into());
    }
    if l.retries > 1000 {
        return Err("Retries: up to 1000".into());
    }
    Ok(())
}

/// What the engine is sent: every setting stated, since it takes a zero as
/// "leave it", so no limit is the whole machine.
fn body(l: &Limits, e: &Engine) -> Value {
    let cpus = if l.cpus > 0.0 { l.cpus } else { e.cpus };
    let memory = if l.memory > 0 { l.memory } else { e.memory };
    let shares = PRIORITIES
        .iter()
        .find(|(p, _)| *p == l.priority)
        .map_or(1024, |(_, s)| *s);
    let mut body = json!({
        "NanoCpus": (cpus * 1e9).round() as i64,
        "CpuShares": shares,
        "PidsLimit": if l.pids > 0 { l.pids as i64 } else { -1 },
        "RestartPolicy": {
            "Name": l.restart,
            "MaximumRetryCount": if l.restart == "on-failure" { l.retries } else { 0 },
        },
    });
    if memory > 0 {
        body["Memory"] = json!(memory);
        body["MemorySwap"] = json!(if l.swap < 0 {
            -1
        } else {
            memory as i64 + l.swap
        });
        body["MemoryReservation"] = json!(if l.reserve > 0 { l.reserve } else { memory });
    }
    body
}

async fn apply(endpoint: &Endpoint, id: &str, l: &Limits, e: &Engine) -> anyhow::Result<()> {
    docker::call_with(
        endpoint,
        Method::POST,
        &format!("/containers/{id}/update"),
        Some(&body(l, e)),
        WAIT,
    )
    .await?;
    CHANGED.store(true, Ordering::Relaxed);
    Ok(())
}

/// One container's resources, with the most the machine can give.
async fn current(endpoint: &Endpoint, id: &str) -> ApiResult<Value> {
    let e = engine(endpoint).await.map_err(engine_error)?;
    let c = docker::get(endpoint, &format!("/containers/{}/json", checked(id)?))
        .await
        .map_err(engine_error)?;
    Ok(json!({
        "limits": read(&c["HostConfig"], &e),
        "cpus": e.cpus,
        "memory": e.memory,
    }))
}

pub async fn get(Path(id): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(current(&Endpoint::from_env(), &id).await?))
}

/// Sets a container's resources now and keeps them for when it is made again.
pub async fn set(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(limits): Json<Limits>,
) -> ApiResult<Json<Value>> {
    let endpoint = Endpoint::from_env();
    let e = engine(&endpoint).await.map_err(engine_error)?;
    check(&limits, &e).map_err(ApiError::bad)?;
    let c = docker::get(&endpoint, &format!("/containers/{}/json", checked(&id)?))
        .await
        .map_err(engine_error)?;
    let name = c["Name"]
        .as_str()
        .unwrap_or_default()
        .trim_start_matches('/');
    let full = c["Id"].as_str().unwrap_or_default();
    apply(&endpoint, full, &limits, &e)
        .await
        .map_err(|err| ApiError::bad(format!("{err:#}")))?;
    state
        .db
        .set_limits(name, &serde_json::to_string(&limits).unwrap_or_default())?;
    Ok(Json(current(&endpoint, full).await?))
}

pub fn spawn(state: AppState) {
    tokio::spawn(keep(state));
}

/// Gives a container made again the resources kept for its name, once per
/// container: the first look after a start covers every one.
async fn keep(state: AppState) {
    let endpoint = Endpoint::from_env();
    let mut done: HashMap<String, String> = HashMap::new();
    let mut every = tokio::time::interval(EVERY);
    loop {
        every.tick().await;
        let kept = state.db.limits().unwrap_or_default();
        if kept.is_empty() {
            continue;
        }
        let Ok(listed) = docker::get(&endpoint, "/containers/json?all=1").await else {
            continue;
        };
        let Ok(e) = engine(&endpoint).await else {
            continue;
        };
        for c in listed.as_array().into_iter().flatten() {
            let id = c["Id"].as_str().unwrap_or_default();
            let name = c["Names"][0]
                .as_str()
                .unwrap_or_default()
                .trim_start_matches('/');
            let Some(limits) = kept
                .iter()
                .find(|(n, _)| n == name)
                .and_then(|(_, v)| serde_json::from_str::<Limits>(v).ok())
            else {
                continue;
            };
            if done.get(name).is_some_and(|d| d == id) {
                continue;
            }
            if let Err(err) = apply(&endpoint, id, &limits, &e).await {
                tracing::warn!("could not give {name} its resources: {err:#}");
            }
            done.insert(name.to_owned(), id.to_owned());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GB: u64 = 1 << 30;

    fn engine() -> Engine {
        Engine {
            cpus: 4.0,
            memory: 8 * GB,
        }
    }

    fn limits() -> Limits {
        Limits {
            cpus: 1.5,
            priority: "high".into(),
            memory: GB,
            reserve: GB / 2,
            swap: 0,
            pids: 200,
            restart: "on-failure".into(),
            retries: 5,
        }
    }

    #[test]
    fn what_is_sent_reads_back_the_same() {
        let e = engine();
        for l in [
            limits(),
            Limits {
                cpus: 0.0,
                priority: "normal".into(),
                memory: 0,
                reserve: 0,
                swap: -1,
                pids: 0,
                restart: "unless-stopped".into(),
                retries: 0,
            },
        ] {
            assert_eq!(read(&body(&l, &e), &e), l);
        }
    }

    #[test]
    fn no_limit_is_the_whole_machine() {
        let mut l = limits();
        l.cpus = 0.0;
        l.memory = 0;
        let b = body(&l, &engine());
        assert_eq!(b["NanoCpus"], 4_000_000_000_i64);
        assert_eq!(b["Memory"], 8 * GB);
    }

    #[test]
    fn refuses_what_the_machine_cannot_give() {
        let e = engine();
        let mut l = limits();
        l.cpus = 8.0;
        assert!(check(&l, &e).is_err());
        let mut l = limits();
        l.reserve = 2 * GB;
        assert!(check(&l, &e).is_err());
        assert!(check(&limits(), &e).is_ok());
    }
}
