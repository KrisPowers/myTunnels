//! Reads the Docker Engine API, over the socket, a named pipe or TCP, as
//! `DOCKER_HOST` says. Only GET requests are ever sent.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use http_body_util::{BodyExt, Empty};
use hyper::body::Bytes;
use hyper::Request;
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
    tokio::time::timeout(TIMEOUT, fetch(endpoint, path))
        .await
        .context("Docker did not answer in time")?
}

async fn fetch(endpoint: &Endpoint, path: &str) -> Result<Value> {
    match endpoint {
        Endpoint::Tcp(addr) => send(tokio::net::TcpStream::connect(addr).await?, path).await,
        #[cfg(unix)]
        Endpoint::Unix(socket) => send(tokio::net::UnixStream::connect(socket).await?, path).await,
        #[cfg(windows)]
        Endpoint::Pipe(pipe) => {
            let client = tokio::net::windows::named_pipe::ClientOptions::new().open(pipe)?;
            send(client, path).await
        }
        #[allow(unreachable_patterns)]
        _ => bail!("this kind of DOCKER_HOST does not work on this system"),
    }
}

async fn send<S>(stream: S, path: &str) -> Result<Value>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(stream)).await?;
    tokio::spawn(async move {
        let _ = conn.await;
    });
    let request = Request::get(path)
        .header(hyper::header::HOST, "docker")
        .body(Empty::<Bytes>::new())?;
    let response = sender.send_request(request).await?;
    let status = response.status();
    let body = response.into_body().collect().await?.to_bytes();
    if !status.is_success() {
        bail!("Docker answered {status}");
    }
    Ok(serde_json::from_slice(&body)?)
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
