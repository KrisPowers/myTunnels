//! The Docker Engine API, over the socket, a named pipe or TCP, as
//! `DOCKER_HOST` says: read by the Dashboard, containers started, stopped
//! and removed from the Containers page, and images built and run from a
//! container's repository.

use std::path::PathBuf;
use std::pin::Pin;
use std::task::{Context as TaskContext, Poll};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::{BodyExt, Empty, Full};
use hyper::body::{Bytes, Frame, Incoming};
use hyper::client::conn::http1::SendRequest;
use hyper::{Method, Request, Response};
use hyper_util::rt::TokioIo;
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

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

/// A request body: none, JSON, or bytes read as they come, such as a build's files.
pub type Body = UnsyncBoxBody<Bytes, std::io::Error>;

pub fn empty() -> Body {
    Empty::<Bytes>::new()
        .map_err(|never| match never {})
        .boxed_unsync()
}

pub fn json_body(value: &Value) -> Body {
    Full::new(Bytes::from(value.to_string()))
        .map_err(|never| match never {})
        .boxed_unsync()
}

/// A body read from `reader` as the engine takes it, never held whole.
pub fn read_body<R: AsyncRead + Unpin + Send + 'static>(reader: R) -> Body {
    ReadBody(reader, vec![0; 64 * 1024].into_boxed_slice()).boxed_unsync()
}

struct ReadBody<R>(R, Box<[u8]>);

impl<R: AsyncRead + Unpin> hyper::body::Body for ReadBody<R> {
    type Data = Bytes;
    type Error = std::io::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, std::io::Error>>> {
        let this = &mut *self;
        let mut buf = ReadBuf::new(&mut this.1);
        match Pin::new(&mut this.0).poll_read(cx, &mut buf) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Err(e)) => Poll::Ready(Some(Err(e))),
            Poll::Ready(Ok(())) if buf.filled().is_empty() => Poll::Ready(None),
            Poll::Ready(Ok(())) => {
                Poll::Ready(Some(Ok(Frame::data(Bytes::copy_from_slice(buf.filled())))))
            }
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
    call_with(endpoint, method, path, None, wait).await
}

/// As `call`, sending `json` as the request's body.
pub async fn call_with(
    endpoint: &Endpoint,
    method: Method,
    path: &str,
    json: Option<&Value>,
    wait: Duration,
) -> Result<Bytes> {
    tokio::time::timeout(wait, async {
        let (body, kind) = match json {
            Some(v) => (json_body(v), Some("application/json")),
            None => (empty(), None),
        };
        let response = open(endpoint, method, path, kind, body).await?;
        let status = response.status();
        let bytes = response.into_body().collect().await?.to_bytes();
        if !status.is_success() {
            bail!("{}", reason(status, &bytes));
        }
        Ok(bytes)
    })
    .await
    .context("Docker did not answer in time")?
}

/// Sends `body` to `path` and hands each line of the answer to `line` as it
/// arrives, for answers that go on for minutes, such as a build's progress.
pub async fn stream(
    endpoint: &Endpoint,
    path: &str,
    kind: &str,
    body: Body,
    mut line: impl FnMut(&[u8]),
) -> Result<()> {
    let response = tokio::time::timeout(
        TIMEOUT * 4,
        open(endpoint, Method::POST, path, Some(kind), body),
    )
    .await
    .context("Docker did not answer in time")??;
    let status = response.status();
    let mut body = response.into_body();
    if !status.is_success() {
        let bytes = body.collect().await?.to_bytes();
        bail!("{}", reason(status, &bytes));
    }
    let mut pending = Vec::new();
    while let Some(frame) = body.frame().await {
        let Ok(data) = frame?.into_data() else {
            continue;
        };
        pending.extend_from_slice(&data);
        while let Some(end) = pending.iter().position(|b| *b == b'\n') {
            line(&pending[..end]);
            pending.drain(..=end);
        }
    }
    if !pending.is_empty() {
        line(&pending);
    }
    Ok(())
}

/// Why the engine refused: its message, or its status.
fn reason(status: hyper::StatusCode, body: &[u8]) -> String {
    serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|v| v["message"].as_str().map(str::to_owned))
        .unwrap_or_else(|| format!("Docker answered {status}"))
}

async fn open(
    endpoint: &Endpoint,
    method: Method,
    path: &str,
    kind: Option<&str>,
    body: Body,
) -> Result<Response<Incoming>> {
    let mut sender = match endpoint {
        Endpoint::Tcp(addr) => handshake(tokio::net::TcpStream::connect(addr).await?).await?,
        #[cfg(unix)]
        Endpoint::Unix(socket) => handshake(tokio::net::UnixStream::connect(socket).await?).await?,
        #[cfg(windows)]
        Endpoint::Pipe(pipe) => handshake(open_pipe(pipe).await?).await?,
        #[allow(unreachable_patterns)]
        _ => bail!("this kind of DOCKER_HOST does not work on this system"),
    };
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header(hyper::header::HOST, "docker");
    if let Some(kind) = kind {
        request = request.header(hyper::header::CONTENT_TYPE, kind);
    }
    Ok(sender.send_request(request.body(body)?).await?)
}

/// Opens the engine's named pipe. While every instance of it is taken by
/// other callers, Windows says the pipe is busy; it is tried again shortly,
/// until the caller's own time runs out.
#[cfg(windows)]
async fn open_pipe(
    pipe: &str,
) -> std::io::Result<tokio::net::windows::named_pipe::NamedPipeClient> {
    const ERROR_PIPE_BUSY: i32 = 231;
    loop {
        match tokio::net::windows::named_pipe::ClientOptions::new().open(pipe) {
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) => {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            done => return done,
        }
    }
}

async fn handshake<S>(stream: S) -> Result<SendRequest<Body>>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(stream)).await?;
    tokio::spawn(async move {
        let _ = conn.await;
    });
    Ok(sender)
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
