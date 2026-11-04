//! The Docker Engine API, over the socket, a named pipe or TCP, as
//! `DOCKER_HOST` says: read by the Dashboard, and containers started, stopped
//! and removed from the Containers page.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use http_body_util::{BodyExt, Empty};
use hyper::body::Bytes;
use hyper::{Method, Request};
use hyper_util::rt::TokioIo;
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncWrite};

const TIMEOUT: Duration = Duration::from_secs(4);

pub enum Endpoint {
    #[cfg_attr(not(unix), allow(dead_code))]
    Unix(PathBuf),
    #[cfg_attr(not(windows), allow(dead_code))]
    Pipe(String),
    Tcp(String),
}

impl Endpoint {
    /// `DOCKER_HOST` when it is set, otherwise the engine's usual socket.
    pub fn from_env() -> Self {
        match std::env::var("DOCKER_HOST") {
            Ok(host) if !host.trim().is_empty() => Self::parse(host.trim()),
            _ if cfg!(windows) => Self::Pipe(r"\\.\pipe\docker_engine".into()),
            _ => Self::Unix("/var/run/docker.sock".into()),
        }
    }

    fn parse(host: &str) -> Self {
        if let Some(path) = host.strip_prefix("unix://") {
            Self::Unix(path.into())
        } else if let Some(path) = host.strip_prefix("npipe://") {
            Self::Pipe(path.replace('/', "\\"))
        } else {
            let addr = host
                .trim_start_matches("tcp://")
                .trim_start_matches("http://")
                .trim_end_matches('/');
            Self::Tcp(addr.to_owned())
        }
    }
}

/// The JSON the engine answers `path` with.
pub async fn get(endpoint: &Endpoint, path: &str) -> Result<Value> {
    let body = call(endpoint, Method::GET, path, TIMEOUT).await?;
    Ok(serde_json::from_slice(&body)?)
}

/// Sends `method` to `path` and returns the body of a successful answer,
/// waiting at most `wait`; an engine's refusal comes back with its reason.
pub async fn call(
    endpoint: &Endpoint,
    method: Method,
    path: &str,
    wait: Duration,
) -> Result<Bytes> {
    tokio::time::timeout(wait, fetch(endpoint, method, path))
        .await
        .context("Docker did not answer in time")?
}

async fn fetch(endpoint: &Endpoint, method: Method, path: &str) -> Result<Bytes> {
    match endpoint {
        Endpoint::Tcp(addr) => {
            send(tokio::net::TcpStream::connect(addr).await?, method, path).await
        }
        #[cfg(unix)]
        Endpoint::Unix(socket) => {
            send(tokio::net::UnixStream::connect(socket).await?, method, path).await
        }
        #[cfg(windows)]
        Endpoint::Pipe(pipe) => {
            let client = tokio::net::windows::named_pipe::ClientOptions::new().open(pipe)?;
            send(client, method, path).await
        }
        #[allow(unreachable_patterns)]
        _ => bail!("this kind of DOCKER_HOST does not work on this system"),
    }
}

async fn send<S>(stream: S, method: Method, path: &str) -> Result<Bytes>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(stream)).await?;
    tokio::spawn(async move {
        let _ = conn.await;
    });
    let request = Request::builder()
        .method(method)
        .uri(path)
        .header(hyper::header::HOST, "docker")
        .body(Empty::<Bytes>::new())?;
    let response = sender.send_request(request).await?;
    let status = response.status();
    let body = response.into_body().collect().await?.to_bytes();
    if !status.is_success() {
        let reason = serde_json::from_slice::<Value>(&body)
            .ok()
            .and_then(|v| v["message"].as_str().map(str::to_owned));
        match reason {
            Some(reason) => bail!("{reason}"),
            None => bail!("Docker answered {status}"),
        }
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hosts() {
        assert!(
            matches!(Endpoint::parse("tcp://docker:2375"), Endpoint::Tcp(a) if a == "docker:2375")
        );
        assert!(
            matches!(Endpoint::parse("http://docker:2375/"), Endpoint::Tcp(a) if a == "docker:2375")
        );
        assert!(
            matches!(Endpoint::parse("unix:///var/run/docker.sock"), Endpoint::Unix(p) if p.as_os_str() == "/var/run/docker.sock")
        );
        assert!(
            matches!(Endpoint::parse("npipe:////./pipe/docker_engine"), Endpoint::Pipe(p) if p == r"\\.\pipe\docker_engine")
        );
    }
}
