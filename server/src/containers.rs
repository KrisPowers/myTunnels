//! The Containers page: every container the engine has, one container's
//! details and logs, and starting, stopping and removing them.

use std::time::Duration;

use axum::http::StatusCode;
use axum::Json;
use hyper::Method;
use serde_json::{json, Value};

use crate::docker::{self, Endpoint};
use crate::util::{ApiError, ApiResult};

/// Stopping waits for the container to end on its own, ten seconds by default.
const ACTION_WAIT: Duration = Duration::from_secs(40);
const READ_WAIT: Duration = Duration::from_secs(8);
const MAX_LOG_LINES: u32 = 5000;

fn engine_error(err: anyhow::Error) -> ApiError {
    ApiError(StatusCode::BAD_GATEWAY, format!("{err:#}"))
}

/// A container named in a request: its ID or name, nothing that leaves the path.
fn checked(id: &str) -> ApiResult<&str> {
    // As Docker names them: a letter or digit first.
    let ok = (1..=128).contains(&id.len())
        && id.as_bytes()[0].is_ascii_alphanumeric()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b));
    if ok {
        Ok(id)
    } else {
        Err(ApiError::bad("No such container"))
    }
}

/// True for the container this process runs in, whose ID starts with the host
/// name Docker gives it.
fn is_own(id: &str) -> bool {
    std::env::var("HOSTNAME").is_ok_and(|h| {
        h.len() >= 12 && h.bytes().all(|b| b.is_ascii_hexdigit()) && id.starts_with(&h)
    })
}

fn name_of(names: &Value) -> String {
    names[0]
        .as_str()
        .unwrap_or_default()
        .trim_start_matches('/')
        .to_owned()
}

/// Ports as published: the host's port when there is one, the container's.
fn ports(list: &Value) -> Vec<Value> {
    let mut seen = Vec::new();
    let mut out = Vec::new();
    for p in list.as_array().into_iter().flatten() {
        let private = p["PrivatePort"].as_u64().unwrap_or(0);
        let public = p["PublicPort"].as_u64();
        let kind = p["Type"].as_str().unwrap_or("tcp");
        // IPv4 and IPv6 bindings of one port are the same port.
        let key = (private, public, kind.to_owned());
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        out.push(json!({ "private": private, "public": public, "type": kind }));
    }
    out
}

pub async fn list() -> ApiResult<Json<Value>> {
    let endpoint = Endpoint::from_env();
    let listed = docker::get(&endpoint, "/containers/json?all=1")
        .await
        .map_err(engine_error)?;
    let containers: Vec<Value> = listed
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| {
            let id = c["Id"].as_str().unwrap_or_default();
            let labels = &c["Labels"];
            json!({
                "id": id,
                "name": name_of(&c["Names"]),
                "image": c["Image"],
                "state": c["State"],
                "status": c["Status"],
                "created": c["Created"],
                "ports": ports(&c["Ports"]),
                "project": labels["com.docker.compose.project"],
                "service": labels["com.docker.compose.service"],
                "own": is_own(id),
            })
        })
        .collect();
    Ok(Json(json!(containers)))
}

/// One container in full: what runs, where its files and ports go, and how it
/// restarts.
pub async fn inspect(id: &str) -> ApiResult<Json<Value>> {
    let endpoint = Endpoint::from_env();
    let c = docker::get(&endpoint, &format!("/containers/{}/json", checked(id)?))
        .await
        .map_err(engine_error)?;
    let config = &c["Config"];
    let host = &c["HostConfig"];
    let state = &c["State"];
    let command: Vec<String> = [&config["Entrypoint"], &config["Cmd"]]
        .into_iter()
        .flat_map(|v| v.as_array().cloned().unwrap_or_default())
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect();
    let mounts: Vec<Value> = c["Mounts"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|m| {
            json!({
                "kind": m["Type"],
                "source": m["Name"].as_str().or(m["Source"].as_str()),
                "destination": m["Destination"],
                "writable": m["RW"],
            })
        })
        .collect();
    let networks: Vec<Value> = c["NetworkSettings"]["Networks"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(name, n)| json!({ "name": name, "ip": n["IPAddress"] }))
        .collect();
    let mut published = Vec::new();
    for (port, bindings) in c["NetworkSettings"]["Ports"]
        .as_object()
        .into_iter()
        .flatten()
    {
        let (number, kind) = port.split_once('/').unwrap_or((port, "tcp"));
        let private = number.parse::<u64>().unwrap_or(0);
        let mut publics: Vec<u64> = bindings
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|b| b["HostPort"].as_str()?.parse().ok())
            .collect();
        publics.dedup();
        if publics.is_empty() {
            published.push(json!({ "private": private, "public": null, "type": kind }));
        }
        for public in publics {
            published.push(json!({ "private": private, "public": public, "type": kind }));
        }
    }
    let id = c["Id"].as_str().unwrap_or_default();
    Ok(Json(json!({
        "id": id,
        "name": c["Name"].as_str().unwrap_or_default().trim_start_matches('/'),
        "image": config["Image"],
        "created": c["Created"],
        "state": state["Status"],
        "started": state["StartedAt"],
        "finished": state["FinishedAt"],
        "exit_code": state["ExitCode"],
        "health": state["Health"]["Status"],
        "restarts": c["RestartCount"],
        "restart_policy": host["RestartPolicy"]["Name"],
        "command": command.join(" "),
        "workdir": config["WorkingDir"],
        "ports": published,
        "mounts": mounts,
        "networks": networks,
        "project": config["Labels"]["com.docker.compose.project"],
        "service": config["Labels"]["com.docker.compose.service"],
        "own": is_own(id),
    })))
}

/// Starts, stops, restarts, pauses, resumes or kills a container.
pub async fn act(id: &str, action: &str) -> ApiResult<Json<Value>> {
    if !matches!(
        action,
        "start" | "stop" | "restart" | "pause" | "unpause" | "kill"
    ) {
        return Err(ApiError::not_found());
    }
    let endpoint = Endpoint::from_env();
    let path = format!("/containers/{}/{action}", checked(id)?);
    docker::call(&endpoint, Method::POST, &path, ACTION_WAIT)
        .await
        .map_err(engine_error)?;
    Ok(Json(json!({ "ok": true })))
}

/// Removes a stopped container. Its volumes stay.
pub async fn remove(id: &str) -> ApiResult<Json<Value>> {
    let endpoint = Endpoint::from_env();
    let path = format!("/containers/{}", checked(id)?);
    docker::call(&endpoint, Method::DELETE, &path, ACTION_WAIT)
        .await
        .map_err(engine_error)?;
    Ok(Json(json!({ "ok": true })))
}

/// The last `tail` lines a container wrote, each with its time.
pub async fn logs(id: &str, tail: u32) -> ApiResult<Json<Value>> {
    let endpoint = Endpoint::from_env();
    let path = format!(
        "/containers/{}/logs?stdout=1&stderr=1&timestamps=1&tail={}",
        checked(id)?,
        tail.clamp(1, MAX_LOG_LINES)
    );
    let raw = docker::call(&endpoint, Method::GET, &path, READ_WAIT)
        .await
        .map_err(engine_error)?;
    let text = String::from_utf8_lossy(&demux(&raw)).into_owned();
    let lines: Vec<&str> = text.lines().collect();
    Ok(Json(json!({ "lines": lines })))
}

/// A container without a terminal sends its output in frames, each an
/// eight-byte header (stream, then the length) and the bytes; one with a
/// terminal sends them as they are.
fn demux(raw: &[u8]) -> Vec<u8> {
    let framed = raw.len() >= 8 && raw[0] <= 2 && raw[1..4] == [0, 0, 0];
    if !framed {
        return raw.to_vec();
    }
    let mut out = Vec::with_capacity(raw.len());
    let mut rest = raw;
    while rest.len() >= 8 {
        let size = u32::from_be_bytes([rest[4], rest[5], rest[6], rest[7]]) as usize;
        let end = (8 + size).min(rest.len());
        out.extend_from_slice(&rest[8..end]);
        rest = &rest[end..];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_are_joined() {
        let mut raw = vec![1, 0, 0, 0, 0, 0, 0, 3];
        raw.extend_from_slice(b"ab\n");
        raw.extend_from_slice(&[2, 0, 0, 0, 0, 0, 0, 2]);
        raw.extend_from_slice(b"c\n");
        assert_eq!(demux(&raw), b"ab\nc\n");
        assert_eq!(demux(b"plain text\n"), b"plain text\n");
    }

    #[test]
    fn names_stay_in_the_path() {
        assert!(checked("abc123").is_ok());
        assert!(checked("my_app.1-web").is_ok());
        assert!(checked("../images").is_err());
        assert!(checked("..").is_err());
        assert!(checked("a/b").is_err());
        assert!(checked("").is_err());
    }
}
