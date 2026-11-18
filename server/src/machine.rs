//! This computer's half of a port forward: an inbound rule in its firewall,
//! and, when the app is on another port or another machine, a relay that
//! listens on the forwarded port and passes everything to the app. On
//! Windows the rule is made by the firewall helper granted at install, with
//! no prompt, or else through Windows' admin prompt.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use tokio::net::{TcpListener, TcpSocket, TcpStream, UdpSocket};
use tokio::task::JoinHandle;

use crate::db::Forward;
use crate::util::lock;

/// A task that ends when this is dropped.
struct Task(JoinHandle<()>);

impl Drop for Task {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// The relays running, by forward ID.
static RELAYS: LazyLock<Mutex<HashMap<String, Vec<Task>>>> = LazyLock::new(Mutex::default);

/// The protocols a forward carries, by name.
pub fn kinds(f: &Forward) -> &'static [&'static str] {
    match f.protocol.as_str() {
        "udp" => &["udp"],
        "both" => &["tcp", "udp"],
        _ => &["tcp"],
    }
}

/// Whether the forwarded port is not the app's own: the app runs on another
/// port, or on another machine.
pub fn relays(f: &Forward) -> bool {
    f.target_host.is_some() || f.public_port != f.target_port
}

/// Opens the port on this computer: the firewall first, so the relay that
/// may follow is let in at once.
pub async fn open(f: &Forward) -> Result<()> {
    firewall::open(f).await?;
    if relays(f) && !lock(&RELAYS).contains_key(&f.id) {
        if let Err(err) = start(f).await {
            let _ = firewall::close(f).await;
            return Err(err);
        }
    }
    Ok(())
}

/// Starts the relay again after a restart; the firewall keeps its rules.
pub async fn resume(f: &Forward) -> Result<()> {
    if relays(f) && !lock(&RELAYS).contains_key(&f.id) {
        start(f).await?;
    }
    Ok(())
}

pub async fn close(f: &Forward) -> Result<()> {
    lock(&RELAYS).remove(&f.id);
    firewall::close(f).await
}

async fn start(f: &Forward) -> Result<()> {
    let host = f.target_host.clone().unwrap_or_else(|| "127.0.0.1".into());
    let mut tasks = Vec::new();
    for kind in kinds(f) {
        let at = ("0.0.0.0", f.public_port);
        let task = if *kind == "udp" {
            let socket = UdpSocket::bind(at).await.with_context(|| {
                format!("port {} UDP is in use on this computer", f.public_port)
            })?;
            tokio::spawn(relay_udp(Arc::new(socket), host.clone(), f.target_port))
        } else {
            let listener = TcpListener::bind(at).await.with_context(|| {
                format!("port {} TCP is in use on this computer", f.public_port)
            })?;
            tokio::spawn(relay_tcp(listener, host.clone(), f.target_port))
        };
        tasks.push(Task(task));
    }
    lock(&RELAYS).insert(f.id.clone(), tasks);
    Ok(())
}

/// Who each relayed connection came from, by the port the relay connects
/// to the app from, so an app here, such as mail, can see past the relay.
static ORIGINS: LazyLock<Mutex<HashMap<u16, SocketAddr>>> = LazyLock::new(Mutex::default);

/// Who a connection from this computer's `port` was relayed for.
pub fn origin(port: u16) -> Option<SocketAddr> {
    lock(&ORIGINS).get(&port).copied()
}

/// Connects to the app from a port noted first, so the app can ask who
/// the connection is for as soon as it arrives.
async fn dial(host: &str, port: u16, peer: SocketAddr) -> std::io::Result<(TcpStream, u16)> {
    let addr = tokio::net::lookup_host((host, port))
        .await?
        .next()
        .ok_or_else(|| std::io::Error::other("the app's address does not resolve"))?;
    let socket = if addr.is_ipv4() {
        TcpSocket::new_v4()?
    } else {
        TcpSocket::new_v6()?
    };
    let any: SocketAddr = if addr.is_ipv4() {
        ([0, 0, 0, 0], 0).into()
    } else {
        (std::net::Ipv6Addr::UNSPECIFIED, 0).into()
    };
    socket.bind(any)?;
    let local = socket.local_addr()?.port();
    lock(&ORIGINS).insert(local, peer);
    match socket.connect(addr).await {
        Ok(stream) => Ok((stream, local)),
        Err(err) => {
            lock(&ORIGINS).remove(&local);
            Err(err)
        }
    }
}

async fn relay_tcp(listener: TcpListener, host: String, port: u16) {
    loop {
        let Ok((mut inbound, peer)) = listener.accept().await else {
            continue;
        };
        let host = host.clone();
        tokio::spawn(async move {
            if let Ok((mut app, local)) = dial(&host, port, peer).await {
                let _ = tokio::io::copy_bidirectional(&mut inbound, &mut app).await;
                lock(&ORIGINS).remove(&local);
            }
        });
    }
}

/// How long a UDP sender stays paired with its socket to the app once quiet.
const UDP_IDLE: Duration = Duration::from_secs(180);

/// Each sender gets a socket of its own to the app, so replies find their
/// way back to it.
async fn relay_udp(socket: Arc<UdpSocket>, host: String, port: u16) {
    let mut peers: HashMap<SocketAddr, (Arc<UdpSocket>, Instant, Task)> = HashMap::new();
    let mut buf = vec![0u8; 65_535];
    loop {
        let Ok((n, peer)) = socket.recv_from(&mut buf).await else {
            continue;
        };
        peers.retain(|_, (_, seen, _)| seen.elapsed() < UDP_IDLE);
        let app = match peers.get_mut(&peer) {
            Some((app, seen, _)) => {
                *seen = Instant::now();
                app.clone()
            }
            None => {
                let Ok(app) = UdpSocket::bind(("0.0.0.0", 0)).await else {
                    continue;
                };
                if app.connect((host.as_str(), port)).await.is_err() {
                    continue;
                }
                let app = Arc::new(app);
                let (back, front) = (app.clone(), socket.clone());
                let replies = tokio::spawn(async move {
                    let mut buf = vec![0u8; 65_535];
                    while let Ok(n) = back.recv(&mut buf).await {
                        if front.send_to(&buf[..n], peer).await.is_err() {
                            break;
                        }
                    }
                });
                peers.insert(peer, (app.clone(), Instant::now(), Task(replies)));
                app
            }
        };
        let _ = app.send(&buf[..n]).await;
    }
}

#[cfg(windows)]
pub use firewall::grant as grant_firewall;

#[cfg(windows)]
mod firewall {
    use std::path::PathBuf;
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    use anyhow::{anyhow, bail, Context, Result};
    use serde_json::json;

    use super::{kinds, relays};
    use crate::db::Forward;

    const NO_WINDOW: u32 = 0x0800_0000;

    /// The helper that opens and closes these rules with no admin prompt: a
    /// task run as SYSTEM, put in place once by `mytunnels grant`.
    const HELPER: &str = include_str!("firewall.ps1");
    const TASK: &str = "myTunnels Firewall";

    /// A folder under one of Windows' own, by the variable that names it.
    fn under(var: &str, fallback: &str) -> PathBuf {
        std::env::var_os(var)
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(fallback))
            .join("myTunnels")
            .join("firewall")
    }

    /// Where the helper lives: Program Files, which only administrators may change.
    fn helper_dir() -> PathBuf {
        under("ProgramFiles", r"C:\Program Files")
    }

    /// Where myTunnels asks it, which only the account it runs as may write to.
    fn asks() -> PathBuf {
        under("ProgramData", r"C:\ProgramData")
    }

    /// Puts the helper in place, letting the account `sid` ask it. Run with
    /// administrator rights.
    pub fn grant(sid: &str) -> Result<()> {
        use crate::hardware::{add_task, lock_down};
        let dir = helper_dir();
        lock_down(&dir, None)?;
        let program = crate::config::program().context("cannot find this program")?;
        std::fs::write(dir.join("program.txt"), program.display().to_string())?;
        let script = dir.join("firewall.ps1");
        std::fs::write(&script, HELPER)?;
        lock_down(&asks(), Some(sid))?;
        add_task(
            TASK,
            &script,
            "Opens and closes the firewall rules for myTunnels' router ports.",
        )
    }

    /// Has the helper open or close `f`'s rules and waits for it: None when
    /// there is no helper, or it did not answer.
    async fn ask(f: &Forward, open: bool) -> Option<Result<()>> {
        let dir = asks();
        if !helper_dir().join("program.txt").exists() || !dir.exists() {
            return None;
        }
        let rules: Vec<_> = names(f)
            .iter()
            .zip(kinds(f))
            .map(|(name, kind)| {
                json!({ "name": name, "port": f.public_port, "protocol": kind.to_uppercase() })
            })
            .collect();
        let body = json!({ "open": open, "relay": relays(f), "rules": rules }).to_string();
        let file = dir.join(format!("{}.json", f.id));
        let failed = file.with_extension("error");
        let _ = std::fs::remove_file(&failed);
        // Written whole, then named, so the helper never reads half of it.
        let part = file.with_extension("part");
        if std::fs::write(&part, body)
            .and_then(|()| std::fs::rename(&part, &file))
            .is_err()
        {
            let _ = std::fs::remove_file(&part);
            return None;
        }
        let began = Instant::now();
        while file.exists() {
            if began.elapsed() > Duration::from_secs(20) {
                let _ = std::fs::remove_file(&file);
                tracing::warn!("the firewall helper did not answer, so Windows asks instead");
                return None;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        Some(match std::fs::read_to_string(&failed) {
            Ok(why) => {
                let _ = std::fs::remove_file(&failed);
                Err(anyhow!("Windows Firewall refused: {}", why.trim()))
            }
            Err(_) => Ok(()),
        })
    }

    fn names(f: &Forward) -> Vec<String> {
        kinds(f)
            .iter()
            .map(|k| format!("myTunnels-{}-{k}", f.id))
            .collect()
    }

    async fn powershell(script: &str, wait: u64) -> Result<String> {
        let mut cmd = tokio::process::Command::new("powershell");
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            &crate::util::powershell_encoded(script),
        ])
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .creation_flags(NO_WINDOW);
        let out = tokio::time::timeout(Duration::from_secs(wait), cmd.output())
            .await
            .map_err(|_| anyhow!("Windows did not answer in time"))??;
        if !out.status.success() {
            let said = String::from_utf8_lossy(&out.stderr);
            if said.contains("canceled by the user") {
                bail!(
                    "Windows asked for administrator rights to open the firewall, and was told no"
                );
            }
            bail!("Windows Firewall refused: {}", said.trim());
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
    }

    /// How many of its rules are in place; reading them needs no rights.
    async fn present(f: &Forward) -> Result<usize> {
        let list = names(f)
            .iter()
            .map(|n| format!("'{n}'"))
            .collect::<Vec<_>>()
            .join(",");
        let out = powershell(
            &format!("@(Get-NetFirewallRule -Name {list} -ErrorAction SilentlyContinue).Count"),
            30,
        )
        .await?;
        Ok(out.parse().unwrap_or(0))
    }

    /// Runs `script` with administrator rights, which Windows asks for on this
    /// computer's screen, and waits for it.
    async fn elevated(script: &str) -> Result<()> {
        let inner = crate::util::powershell_encoded(&format!(
            "$ErrorActionPreference = 'Stop'\ntry {{ {script} }} catch {{ exit 1 }}"
        ));
        powershell(
            &format!(
                "$p = Start-Process powershell -Verb RunAs -WindowStyle Hidden -Wait -PassThru \
                 -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','{inner}'\n\
                 if ($p.ExitCode -ne 0) {{ [Console]::Error.WriteLine('the rule could not be changed'); exit 1 }}"
            ),
            180,
        )
        .await
        .map(drop)
    }

    pub async fn open(f: &Forward) -> Result<()> {
        if present(f).await? == kinds(f).len() {
            return Ok(());
        }
        if let Some(done) = ask(f, true).await {
            return done;
        }
        // A relay is myTunnels listening, so the rule names it as well.
        let program = if relays(f) {
            crate::config::program()
                .map(|p| {
                    format!(
                        " -Program '{}'",
                        p.display().to_string().replace('\'', "''")
                    )
                })
                .unwrap_or_default()
        } else {
            String::new()
        };
        let script = names(f)
            .iter()
            .zip(kinds(f))
            .map(|(name, kind)| {
                format!(
                    "Remove-NetFirewallRule -Name '{name}' -ErrorAction SilentlyContinue; \
                     New-NetFirewallRule -Name '{name}' -DisplayName 'myTunnels port {port} {proto}' \
                     -Direction Inbound -Action Allow -Protocol {proto} -LocalPort {port} -Profile Any{program} | Out-Null",
                    port = f.public_port,
                    proto = kind.to_uppercase(),
                )
            })
            .collect::<Vec<_>>()
            .join("; ");
        elevated(&script).await
    }

    pub async fn close(f: &Forward) -> Result<()> {
        if present(f).await? == 0 {
            return Ok(());
        }
        if let Some(done) = ask(f, false).await {
            return done;
        }
        let script = names(f)
            .iter()
            .map(|n| format!("Remove-NetFirewallRule -Name '{n}' -ErrorAction SilentlyContinue"))
            .collect::<Vec<_>>()
            .join("; ");
        elevated(&script).await
    }
}

/// Elsewhere there is no firewall rule to keep: macOS asks per app, and Linux
/// leaves its firewall, when one is on, to its owner.
#[cfg(not(windows))]
mod firewall {
    use anyhow::Result;

    use crate::db::Forward;

    pub async fn open(_: &Forward) -> Result<()> {
        Ok(())
    }

    pub async fn close(_: &Forward) -> Result<()> {
        Ok(())
    }
}
