//! An ESMTP server (RFC 5321): mail from other servers on the MX port, and
//! mail apps sending (RFC 6409) once signed in.

use std::io;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use tokio::io::{AsyncWriteExt, BufReader, ReadHalf, WriteHalf};

use super::mta::{Inbound, Reply};
use super::net::{self, printable, Conn};
use super::{Mail, MAX_MESSAGE};

#[derive(Clone, Copy, PartialEq)]
pub enum Mode {
    Mx,
    Submission,
}

const MAX_RECIPIENTS: usize = 100;
const MAX_ERRORS: u32 = 10;
const COMMAND_WAIT: Duration = Duration::from_secs(300);
const DATA_WAIT: Duration = Duration::from_secs(600);

struct Session {
    mail: Arc<Mail>,
    mode: Mode,
    ip: IpAddr,
    tls: bool,
    w: WriteHalf<Conn>,
    errors: u32,
    helo: String,
    user: String,
    from: Option<String>,
    to: Vec<String>,
}

type Reader = BufReader<ReadHalf<Conn>>;

pub async fn serve(
    mail: Arc<Mail>,
    conn: Conn,
    ip: IpAddr,
    mode: Mode,
    tls: bool,
) -> io::Result<()> {
    let (r, w) = tokio::io::split(conn);
    let mut r = BufReader::new(r);
    let mut s = Session {
        mail,
        mode,
        ip,
        tls,
        w,
        errors: 0,
        helo: String::new(),
        user: String::new(),
        from: None,
        to: Vec::new(),
    };
    let host = s.mail.settings().hostname();
    s.reply(220, "", &format!("{host} ESMTP ready")).await?;
    loop {
        let line = match tokio::time::timeout(COMMAND_WAIT, net::read_line(&mut r, 4096)).await {
            Err(_) => return s.reply(421, "4.4.2", "timed out").await,
            Ok(Err(e)) if e.kind() == io::ErrorKind::InvalidData => {
                return s.reply(500, "5.5.2", "line too long").await
            }
            Ok(Err(e)) => return Err(e),
            Ok(Ok(None)) => return Ok(()),
            Ok(Ok(Some(l))) => String::from_utf8_lossy(&l).into_owned(),
        };
        let (verb, arg) = line.split_once(' ').unwrap_or((&line, ""));
        let verb = verb.to_ascii_uppercase();
        let arg = arg.trim().to_owned();
        match verb.as_str() {
            "STARTTLS" => {
                let Some(acceptor) = net::acceptor().filter(|_| !s.tls) else {
                    s.reply(502, "5.5.1", "TLS not available").await?;
                    continue;
                };
                if !r.buffer().is_empty() {
                    return s
                        .reply(501, "5.5.4", "pipelining after STARTTLS not allowed")
                        .await;
                }
                s.reply(220, "2.0.0", "ready to start TLS").await?;
                let conn = r.into_inner().unsplit(s.w);
                let tls = tokio::time::timeout(Duration::from_secs(30), acceptor.accept(conn))
                    .await
                    .map_err(|_| io::Error::other("TLS handshake timed out"))??;
                let conn: Conn = Box::new(tls);
                let (nr, nw) = tokio::io::split(conn);
                r = BufReader::new(nr);
                s.w = nw;
                s.tls = true;
                s.helo.clear();
                s.from = None;
                s.to.clear();
            }
            "AUTH" => s.auth(&mut r, &arg).await?,
            "DATA" => s.data(&mut r).await?,
            "QUIT" => return s.reply(221, "2.0.0", "bye").await,
            _ => s.command(&verb, &arg).await?,
        }
        if s.errors >= MAX_ERRORS {
            return s.reply(421, "4.7.0", "too many errors").await;
        }
    }
}

impl Session {
    async fn reply(&mut self, code: u16, enhanced: &str, msg: &str) -> io::Result<()> {
        let lines: Vec<&str> = msg.split('\n').collect();
        let mut out = String::new();
        for (i, l) in lines.iter().enumerate() {
            let sep = if i + 1 == lines.len() { ' ' } else { '-' };
            if enhanced.is_empty() {
                out.push_str(&format!("{code}{sep}{l}\r\n"));
            } else {
                out.push_str(&format!("{code}{sep}{enhanced} {l}\r\n"));
            }
        }
        if code >= 500 {
            self.errors += 1;
        }
        self.w.write_all(out.as_bytes()).await?;
        self.w.flush().await
    }

    async fn refuse(&mut self, r: Reply) -> io::Result<()> {
        self.reply(r.code, r.enhanced, &r.msg).await
    }

    fn can_auth(&self) -> bool {
        self.mode == Mode::Submission && self.tls
    }

    async fn command(&mut self, verb: &str, arg: &str) -> io::Result<()> {
        match verb {
            "EHLO" | "HELO" => {
                if arg.is_empty() {
                    return self.reply(501, "5.5.4", "domain required").await;
                }
                self.helo = printable(arg, 255);
                self.from = None;
                self.to.clear();
                let host = self.mail.settings().hostname();
                if verb == "HELO" {
                    return self.reply(250, "", &host).await;
                }
                let mut ext = vec![
                    host,
                    "PIPELINING".into(),
                    "8BITMIME".into(),
                    "ENHANCEDSTATUSCODES".into(),
                    "SMTPUTF8".into(),
                    format!("SIZE {MAX_MESSAGE}"),
                ];
                if !self.tls && net::acceptor().is_some() {
                    ext.push("STARTTLS".into());
                }
                if self.can_auth() {
                    ext.push("AUTH PLAIN LOGIN".into());
                }
                self.reply(250, "", &ext.join("\n")).await
            }
            "MAIL" => self.mail_from(arg).await,
            "RCPT" => self.rcpt(arg).await,
            "RSET" => {
                self.from = None;
                self.to.clear();
                self.reply(250, "2.0.0", "reset").await
            }
            "NOOP" => self.reply(250, "2.0.0", "ok").await,
            "VRFY" => {
                self.reply(252, "2.5.0", "cannot verify, but will attempt delivery")
                    .await
            }
            "HELP" => self.reply(214, "2.0.0", "see RFC 5321").await,
            _ => self.reply(500, "5.5.1", "command not recognized").await,
        }
    }

    async fn auth(&mut self, r: &mut Reader, arg: &str) -> io::Result<()> {
        if !self.can_auth() {
            return self.reply(503, "5.5.1", "AUTH not available").await;
        }
        if !self.user.is_empty() {
            return self.reply(503, "5.5.1", "already authenticated").await;
        }
        if self.from.is_some() {
            return self
                .reply(503, "5.5.1", "AUTH not permitted during a transaction")
                .await;
        }
        let (mech, initial) = arg.split_once(' ').unwrap_or((arg, ""));
        let decode = |v: &str| -> Option<String> {
            if v == "=" {
                return Some(String::new());
            }
            B64.decode(v.trim())
                .ok()
                .map(|b| String::from_utf8_lossy(&b).into_owned())
        };
        let (user, pass) = match mech.to_ascii_uppercase().as_str() {
            "PLAIN" => {
                let resp = if initial.is_empty() {
                    match self.prompt(r, "").await? {
                        Some(v) => v,
                        None => return self.reply(501, "5.0.0", "authentication cancelled").await,
                    }
                } else {
                    initial.to_owned()
                };
                let parts: Vec<String> = decode(&resp)
                    .map(|d| d.split('\0').map(str::to_owned).collect())
                    .unwrap_or_default();
                if parts.len() != 3
                    || (!parts[0].is_empty() && !parts[0].eq_ignore_ascii_case(&parts[1]))
                {
                    return self.reply(501, "5.5.2", "malformed credentials").await;
                }
                (parts[1].clone(), parts[2].clone())
            }
            "LOGIN" => {
                let u = if initial.is_empty() {
                    match self.prompt(r, "VXNlcm5hbWU6").await? {
                        Some(v) => v,
                        None => return self.reply(501, "5.0.0", "authentication cancelled").await,
                    }
                } else {
                    initial.to_owned()
                };
                let Some(p) = self.prompt(r, "UGFzc3dvcmQ6").await? else {
                    return self.reply(501, "5.0.0", "authentication cancelled").await;
                };
                match (decode(&u), decode(&p)) {
                    (Some(u), Some(p)) => (u, p),
                    _ => return self.reply(501, "5.5.2", "malformed credentials").await,
                }
            }
            _ => return self.reply(504, "5.5.4", "unsupported mechanism").await,
        };
        match self.mail.sign_in(&user, &pass, self.ip).await {
            Ok(address) => {
                self.user = address;
                self.reply(235, "2.7.0", "authenticated").await
            }
            Err(Some(wait)) => self.reply(454, "4.7.0", wait).await,
            Err(None) => self.reply(535, "5.7.8", "authentication failed").await,
        }
    }

    async fn prompt(&mut self, r: &mut Reader, ask: &str) -> io::Result<Option<String>> {
        self.w
            .write_all(format!("334 {ask}\r\n").as_bytes())
            .await?;
        self.w.flush().await?;
        Ok(net::read_line(r, 4096)
            .await?
            .map(|l| String::from_utf8_lossy(&l).into_owned())
            .filter(|l| l != "*"))
    }

    async fn mail_from(&mut self, arg: &str) -> io::Result<()> {
        if self.helo.is_empty() {
            return self.reply(503, "5.5.1", "send EHLO first").await;
        }
        if self.from.is_some() {
            return self.reply(503, "5.5.1", "nested MAIL command").await;
        }
        if self.mode == Mode::Submission && self.user.is_empty() {
            return self.reply(530, "5.7.0", "authentication required").await;
        }
        let Some((addr, params)) = path(arg, "FROM:") else {
            return self.reply(501, "5.1.7", "invalid sender address").await;
        };
        if let Some(size) = params
            .iter()
            .find(|(k, _)| k == "SIZE")
            .and_then(|(_, v)| v.parse::<usize>().ok())
        {
            if size > MAX_MESSAGE {
                return self.reply(552, "5.3.4", "message too large").await;
            }
        }
        if self.mode == Mode::Submission {
            if let Err(r) = self.mail.check_sender(&self.user, &addr) {
                return self.refuse(r).await;
            }
        }
        self.from = Some(addr);
        self.reply(250, "2.1.0", "sender ok").await
    }

    async fn rcpt(&mut self, arg: &str) -> io::Result<()> {
        if self.from.is_none() {
            return self.reply(503, "5.5.1", "send MAIL first").await;
        }
        if self.to.len() >= MAX_RECIPIENTS {
            return self.reply(452, "4.5.3", "too many recipients").await;
        }
        let Some((addr, _)) = path(arg, "TO:").filter(|(a, _)| !a.is_empty()) else {
            return self.reply(501, "5.1.3", "invalid recipient address").await;
        };
        let checked = match self.mode {
            Mode::Mx => self.mail.check_inbound(&addr),
            Mode::Submission => self.mail.check_outbound(&addr),
        };
        if let Err(r) = checked {
            return self.refuse(r).await;
        }
        self.to.push(addr);
        self.reply(250, "2.1.5", "recipient ok").await
    }

    async fn data(&mut self, r: &mut Reader) -> io::Result<()> {
        if self.from.is_none() || self.to.is_empty() {
            return self.reply(503, "5.5.1", "need RCPT first").await;
        }
        self.reply(354, "", "end data with <CR><LF>.<CR><LF>")
            .await?;
        let mut buf = Vec::new();
        let mut too_big = false;
        loop {
            let line = tokio::time::timeout(DATA_WAIT, net::read_line(r, 0))
                .await
                .map_err(|_| io::Error::other("data timed out"))??
                .ok_or_else(|| io::Error::other("closed during DATA"))?;
            if line == b"." {
                break;
            }
            let line = line.strip_prefix(b".").unwrap_or(&line);
            if buf.len() + line.len() + 2 > MAX_MESSAGE {
                too_big = true;
                continue;
            }
            buf.extend_from_slice(line);
            buf.extend_from_slice(b"\r\n");
        }
        let from = self.from.take().unwrap_or_default();
        let to = std::mem::take(&mut self.to);
        if too_big {
            return self.reply(552, "5.3.4", "message too large").await;
        }
        let size = buf.len();
        let done = match self.mode {
            Mode::Submission => self.mail.submit(&self.user, &from, &to, &buf),
            Mode::Mx => {
                let msg = Inbound {
                    ip: Some(self.ip),
                    helo: self.helo.clone(),
                    from: from.clone(),
                    to: to.clone(),
                    data: buf,
                    via: "ESMTP",
                };
                let got = self.mail.receive(msg, None).await;
                for rcpt in &to {
                    let (status, detail) = match &got {
                        Ok(false) => ("delivered", String::new()),
                        Ok(true) => ("junk", String::new()),
                        Err(r) if r.code >= 500 => ("rejected", r.msg.clone()),
                        Err(r) => ("failed", r.msg.clone()),
                    };
                    self.mail
                        .store
                        .log("in", &from, rcpt, size, status, &detail);
                }
                got.map(drop)
            }
        };
        match done {
            Ok(()) => self.reply(250, "2.0.0", "message accepted").await,
            Err(r) => self.refuse(r).await,
        }
    }
}

/// `FROM:<addr> PARAMS`: the address and the parameters.
fn path(arg: &str, prefix: &str) -> Option<(String, Vec<(String, String)>)> {
    let head = arg.get(..prefix.len())?;
    if !head.eq_ignore_ascii_case(prefix) {
        return None;
    }
    let rest = arg[prefix.len()..].trim();
    let rest = rest.strip_prefix('<')?;
    let end = rest.find('>')?;
    let mut addr = &rest[..end];
    if addr.starts_with('@') {
        addr = addr.split_once(':').map_or(addr, |(_, a)| a);
    }
    if !addr.is_empty() && (!addr.contains('@') || addr.contains([' ', '\t', '<', '>'])) {
        return None;
    }
    let params = rest[end + 1..]
        .split_whitespace()
        .map(|p| {
            let (k, v) = p.split_once('=').unwrap_or((p, ""));
            (k.to_ascii_uppercase(), v.to_owned())
        })
        .collect();
    Some((addr.to_owned(), params))
}

