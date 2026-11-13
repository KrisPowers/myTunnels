//! The mail listeners: SMTP and IMAP on this computer's loopback, reached
//! from outside through a port forward's relay or Tailscale Funnel.

use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, LazyLock, RwLock};
use std::time::Duration;

use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;

use super::{imap, smtp, Mail};

pub trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}
pub type Conn = Box<dyn Stream>;

/// The certificate mail apps and senders see on this server's own ports.
static TLS: LazyLock<RwLock<Option<TlsAcceptor>>> = LazyLock::new(RwLock::default);

pub fn acceptor() -> Option<TlsAcceptor> {
    TLS.read().unwrap_or_else(|e| e.into_inner()).clone()
}

pub fn set_acceptor(a: Option<TlsAcceptor>) {
    *TLS.write().unwrap_or_else(|e| e.into_inner()) = a;
}

/// Each loopback port, what it serves and how it is reached.
#[derive(Clone, Copy)]
pub enum Kind {
    /// Mail from other servers, relayed from port 25.
    Mx,
    /// Mail apps sending, TLS from the first byte, relayed from 465.
    SubmissionTls,
    /// Mail apps reading, TLS from the first byte, relayed from 993.
    ImapTls,
    /// Mail apps sending through Funnel, which ends TLS and says who
    /// connected in a PROXY header.
    SubmissionFunnel,
    ImapFunnel,
}

pub const MX_PORT: u16 = 2525;
pub const SUBMISSION_TLS_PORT: u16 = 2465;
pub const IMAP_TLS_PORT: u16 = 2993;
pub const SUBMISSION_FUNNEL_PORT: u16 = 2587;
pub const IMAP_FUNNEL_PORT: u16 = 2143;

pub fn spawn(mail: Arc<Mail>) {
    for (port, kind) in [
        (MX_PORT, Kind::Mx),
        (SUBMISSION_TLS_PORT, Kind::SubmissionTls),
        (IMAP_TLS_PORT, Kind::ImapTls),
        (SUBMISSION_FUNNEL_PORT, Kind::SubmissionFunnel),
        (IMAP_FUNNEL_PORT, Kind::ImapFunnel),
    ] {
        let mail = mail.clone();
        tokio::spawn(async move {
            let listener = match TcpListener::bind(("127.0.0.1", port)).await {
                Ok(l) => l,
                Err(err) => {
                    tracing::warn!("mail cannot listen on 127.0.0.1:{port}: {err}");
                    return;
                }
            };
            loop {
                let Ok((tcp, peer)) = listener.accept().await else {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                };
                let mail = mail.clone();
                tokio::spawn(async move {
                    let _ = tcp.set_nodelay(true);
                    if let Err(err) = accept(mail, Box::new(tcp), peer, kind).await {
                        tracing::debug!("mail connection on {port} ended: {err}");
                    }
                });
            }
        });
    }
}

async fn accept(mail: Arc<Mail>, conn: Conn, peer: SocketAddr, kind: Kind) -> io::Result<()> {
    // A relayed connection comes from this computer; the relay knows who
    // made it.
    let relayed = || crate::machine::origin(peer.port()).map_or(peer.ip(), |o| o.ip());
    match kind {
        Kind::Mx => smtp::serve(mail, conn, relayed(), smtp::Mode::Mx, false).await,
        Kind::SubmissionTls => {
            let ip = relayed();
            let conn = handshake(conn).await?;
            smtp::serve(mail, conn, ip, smtp::Mode::Submission, true).await
        }
        Kind::ImapTls => {
            let ip = relayed();
            let conn = handshake(conn).await?;
            imap::serve(mail, conn, ip).await
        }
        Kind::SubmissionFunnel => {
            let (conn, ip) = proxy_header(conn).await?;
            smtp::serve(mail, conn, ip, smtp::Mode::Submission, true).await
        }
        Kind::ImapFunnel => {
            let (conn, ip) = proxy_header(conn).await?;
            imap::serve(mail, conn, ip).await
        }
    }
}

async fn handshake(conn: Conn) -> io::Result<Conn> {
    let tls = acceptor().ok_or_else(|| io::Error::other("no certificate yet"))?;
    let tls = tokio::time::timeout(Duration::from_secs(30), tls.accept(conn))
        .await
        .map_err(|_| io::Error::other("TLS handshake timed out"))??;
    Ok(Box::new(tls))
}

/// Reads a PROXY protocol header (version 1 or 2) and returns the client's
/// address. Funnel sends version 2.
async fn proxy_header(mut conn: Conn) -> io::Result<(Conn, IpAddr)> {
    const SIG: [u8; 12] = *b"\r\n\r\n\0\r\nQUIT\n";
    let read = async {
        let mut start = [0u8; 16];
        conn.read_exact(&mut start[..12]).await?;
        if start[..12] == SIG {
            conn.read_exact(&mut start[12..16]).await?;
            let len = u16::from_be_bytes([start[14], start[15]]) as usize;
            let mut rest = vec![0u8; len];
            conn.read_exact(&mut rest).await?;
            let ip = match start[13] >> 4 {
                1 if rest.len() >= 4 => IpAddr::from([rest[0], rest[1], rest[2], rest[3]]),
                2 if rest.len() >= 16 => {
                    let mut b = [0u8; 16];
                    b.copy_from_slice(&rest[..16]);
                    IpAddr::from(b)
                }
                _ => IpAddr::from([127, 0, 0, 1]),
            };
            return Ok(ip);
        }
        if start.starts_with(b"PROXY ") {
            // Version 1: a text line, read on to its end.
            let mut line = start[..12].to_vec();
            let mut b = [0u8; 1];
            while !line.ends_with(b"\r\n") && line.len() < 108 {
                conn.read_exact(&mut b).await?;
                line.push(b[0]);
            }
            let text = String::from_utf8_lossy(&line);
            return text
                .split(' ')
                .nth(2)
                .and_then(|s| s.parse().ok())
                .ok_or_else(|| io::Error::other("bad PROXY header"));
        }
        Err(io::Error::other("no PROXY header"))
    };
    let ip = tokio::time::timeout(Duration::from_secs(5), read)
        .await
        .map_err(|_| io::Error::other("PROXY header timed out"))??;
    Ok((conn, ip))
}

/// One line without its line ending; an error once it passes `max`
/// bytes, and `None` at the end of the stream.
pub async fn read_line<R: AsyncBufRead + Unpin>(
    r: &mut R,
    max: usize,
) -> io::Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    loop {
        let buf = r.fill_buf().await?;
        if buf.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Ok(Some(line))
            };
        }
        let (take, done) = match buf.iter().position(|&b| b == b'\n') {
            Some(i) => (i + 1, true),
            None => (buf.len(), false),
        };
        line.extend_from_slice(&buf[..take]);
        r.consume(take);
        if max > 0 && line.len() > max {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "line too long"));
        }
        if done {
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return Ok(Some(line));
        }
    }
}

/// Keeps a client-supplied string printable and short.
pub fn printable(v: &str, n: usize) -> String {
    v.chars().filter(|c| !c.is_control()).take(n).collect()
}
