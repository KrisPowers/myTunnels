//! myTunnels as a service on this computer, with no container around it.
//!
//! `start` makes it start with the computer and come back whenever it stops,
//! and runs it now; `stop` undoes both; `status` says whether the panel
//! answers. Linux hands it to systemd as a user service kept running from
//! boot, macOS to launchd as an agent of the signed-in user, and Windows starts
//! it at sign-in from the Run key. Where launchd or Windows run it, `run` keeps
//! it going, starting it again each time it exits, and writes its log.

use std::fs::{self, File, OpenOptions};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};

use crate::config::{self, Config};

/// Runs `start`, `stop`, `status` or `run`.
pub fn command(name: &str) -> Result<()> {
    match name {
        "start" => start(),
        "stop" => stop(),
        "status" => status(),
        _ => supervise(),
    }
}

fn start() -> Result<()> {
    let exe = lasting_path()?;
    fs::create_dir_all(config::home())?;
    halt_supervisor();
    register(&exe)?;
    let began = Instant::now();
    while !answering() {
        if began.elapsed() > Duration::from_secs(30) {
            bail!("myTunnels started but does not answer yet; {}", log_hint());
        }
        sleep(Duration::from_millis(250));
    }
    println!(
        "myTunnels is running at {}, and starts with this computer",
        url()
    );
    Ok(())
}

fn stop() -> Result<()> {
    unregister();
    halt_supervisor();
    let began = Instant::now();
    while answering() && began.elapsed() < Duration::from_secs(10) {
        sleep(Duration::from_millis(250));
    }
    println!("myTunnels is stopped, and no longer starts with this computer");
    Ok(())
}

fn status() -> Result<()> {
    if answering() {
        println!("myTunnels is running at {}", url());
        return Ok(());
    }
    println!("myTunnels is not running");
    std::process::exit(1);
}

/// The panel's address on this computer.
fn panel() -> SocketAddr {
    let addr = Config::from_env()
        .admin_addr
        .replace("0.0.0.0", "127.0.0.1");
    addr.parse()
        .unwrap_or_else(|_| SocketAddr::from(([127, 0, 0, 1], 7070)))
}

fn answering() -> bool {
    TcpStream::connect_timeout(&panel(), Duration::from_millis(500)).is_ok()
}

fn url() -> String {
    format!("http://localhost:{}", panel().port())
}

fn log_file() -> PathBuf {
    config::home().join("log.txt")
}

fn pid_file() -> PathBuf {
    config::home().join("pid")
}

/// This program by a path that outlives an upgrade: Homebrew's link in bin
/// rather than the versioned folder it points into.
fn lasting_path() -> Result<PathBuf> {
    let exe = config::program().context("cannot find this program")?;
    if let Some((prefix, _)) = exe.to_str().and_then(|s| s.split_once("/Cellar/")) {
        let link = Path::new(prefix).join("bin/mytunnels");
        if link.exists() {
            return Ok(link);
        }
    }
    Ok(exe)
}

/// Runs a program to the end, its failure as what it said.
fn quiet(cmd: &mut Command) -> Result<()> {
    let name = cmd.get_program().to_string_lossy().into_owned();
    let out = cmd
        .stdin(Stdio::null())
        .output()
        .with_context(|| format!("cannot run {name}"))?;
    if out.status.success() {
        return Ok(());
    }
    bail!(
        "{name} failed: {}",
        String::from_utf8_lossy(&out.stderr).trim()
    )
}

// ---- `run`: keeps the server going ----

/// Runs the server and starts it again whenever it exits, sooner when it had
/// been up a while, so one that fails at once is not retried in a tight loop.
fn supervise() -> Result<()> {
    #[cfg(windows)]
    hide_console();
    let exe = std::env::current_exe().context("cannot find this program")?;
    fs::create_dir_all(config::home())?;
    fs::write(pid_file(), std::process::id().to_string())?;
    let mut wait = Duration::from_secs(1);
    loop {
        let began = Instant::now();
        let log = open_log()?;
        let mut cmd = Command::new(&exe);
        cmd.stdin(Stdio::null())
            .stdout(log.try_clone()?)
            .stderr(log);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // A console of its own that no one sees, which the programs it
            // runs, such as cloudflared, share rather than each opening one.
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        if let Err(err) = cmd.status() {
            tracing::error!("cannot start the server: {err}");
        }
        wait = if began.elapsed() > Duration::from_secs(60) {
            Duration::from_secs(1)
        } else {
            (wait * 2).min(Duration::from_secs(30))
        };
        sleep(wait);
    }
}

/// The log, with one earlier log kept beside it so it never grows without end.
fn open_log() -> Result<File> {
    let path = log_file();
    if fs::metadata(&path).is_ok_and(|m| m.len() > 10 << 20) {
        let _ = fs::rename(&path, path.with_extension("old.txt"));
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .with_context(|| format!("cannot open {}", path.display()))
}

/// Closes the console window opened for this program alone, as at sign-in,
/// and leaves a terminal it was started from alone.
#[cfg(windows)]
fn hide_console() {
    use windows_sys::Win32::System::Console::{FreeConsole, GetConsoleProcessList};
    let mut ids = [0u32; 2];
    // SAFETY: the buffer holds the two IDs it is said to.
    unsafe {
        if GetConsoleProcessList(ids.as_mut_ptr(), 2) == 1 {
            FreeConsole();
        }
    }
}

/// Starts `run` on its own, outliving the terminal it was started from.
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn spawn_supervisor(exe: &Path) -> Result<()> {
    let mut cmd = Command::new(exe);
    cmd.arg("run")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x8;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        // Out of the terminal's job where it allows, so closing it leaves this running.
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB);
        if cmd.spawn().is_ok() {
            return Ok(());
        }
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd.spawn().context("cannot start myTunnels")?;
    Ok(())
}

/// Ends the `run` this computer has going, and the server under it, while
/// its ID is still this program's and not another's that took it since.
fn halt_supervisor() {
    let Some(pid) = fs::read_to_string(pid_file())
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
    else {
        return;
    };
    let _ = fs::remove_file(pid_file());
    #[cfg(windows)]
    {
        let name = std::env::current_exe()
            .ok()
            .and_then(|e| Some(e.file_name()?.to_string_lossy().to_lowercase()))
            .unwrap_or_default();
        let listed = Command::new("tasklist")
            .args(["/fi", &format!("PID eq {pid}"), "/fo", "csv", "/nh"])
            .output();
        let ours = listed.is_ok_and(|out| {
            String::from_utf8_lossy(&out.stdout)
                .to_lowercase()
                .starts_with(&format!("\"{name}\""))
        });
        if ours {
            let pid = pid.to_string();
            let _ = quiet(Command::new("taskkill").args(["/pid", &pid, "/t", "/f"]));
        }
    }
    #[cfg(unix)]
    {
        // Its command line: this program's name, then `run`.
        let cmdline = fs::read(format!("/proc/{pid}/cmdline")).unwrap_or_default();
        let mut args = cmdline.split(|b| *b == 0);
        let program = args.next().unwrap_or_default();
        let ours = program.ends_with(b"mytunnels") && args.next() == Some(b"run".as_slice());
        if let (true, Ok(pid)) = (ours, i32::try_from(pid)) {
            // SAFETY: a plain signal to the group `run` leads, it and the server.
            unsafe {
                libc::kill(-pid, libc::SIGTERM);
            }
        }
    }
}

// ---- Linux: a systemd user service ----

#[cfg(target_os = "linux")]
fn log_hint() -> String {
    "its log: journalctl --user -u mytunnels".to_owned()
}

#[cfg(target_os = "linux")]
fn unit_file() -> PathBuf {
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .unwrap_or_else(std::env::temp_dir);
    config.join("systemd/user/mytunnels.service")
}

#[cfg(target_os = "linux")]
fn systemctl(args: &[&str]) -> Result<()> {
    quiet(Command::new("systemctl").arg("--user").args(args))
}

/// A value quoted for a unit file, `%` included, which systemd would expand.
#[cfg(target_os = "linux")]
fn unit_quote(s: &str) -> String {
    let s = s
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('%', "%%");
    format!("\"{s}\"")
}

#[cfg(target_os = "linux")]
fn register(exe: &Path) -> Result<()> {
    // Started at boot and kept running after sign-out, not only while signed in.
    if let Some(user) = std::env::var_os("USER") {
        let _ = quiet(Command::new("loginctl").arg("enable-linger").arg(user));
    }
    let path = std::env::var("PATH").unwrap_or_default();
    let unit = format!(
        "[Unit]\nDescription=myTunnels\n\n[Service]\nExecStart={}\nEnvironment={}\nRestart=always\nRestartSec=2\n\n[Install]\nWantedBy=default.target\n",
        unit_quote(&exe.to_string_lossy()),
        unit_quote(&format!("PATH={path}")),
    );
    let file = unit_file();
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(&file, unit)?;
    if systemctl(&["daemon-reload"]).is_err() {
        // No systemd for this user, such as in WSL without it: run it now all the same.
        let _ = fs::remove_file(&file);
        spawn_supervisor(exe)?;
        eprintln!("systemd is not running here, so myTunnels runs now but will not start with this computer");
        return Ok(());
    }
    systemctl(&["enable", "mytunnels"])?;
    systemctl(&["restart", "mytunnels"])
}

#[cfg(target_os = "linux")]
fn unregister() {
    let _ = systemctl(&["disable", "--now", "mytunnels"]);
    if fs::remove_file(unit_file()).is_ok() {
        let _ = systemctl(&["daemon-reload"]);
    }
}

// ---- macOS: a launchd agent ----

#[cfg(target_os = "macos")]
const LABEL: &str = "mytunnels";

#[cfg(not(target_os = "linux"))]
fn log_hint() -> String {
    format!("its log: {}", log_file().display())
}

#[cfg(target_os = "macos")]
fn agent_file() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    home.join(format!("Library/LaunchAgents/{LABEL}.plist"))
}

/// The signed-in user's launchd domain.
#[cfg(target_os = "macos")]
fn domain() -> String {
    // SAFETY: getuid cannot fail.
    format!("gui/{}", unsafe { libc::getuid() })
}

#[cfg(target_os = "macos")]
fn xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(target_os = "macos")]
fn register(exe: &Path) -> Result<()> {
    let path = std::env::var("PATH").unwrap_or_default();
    // launchd starts it at sign-in and again whenever `run` itself ends.
    let agent = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key><array><string>{}</string><string>run</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>{}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
"#,
        xml(&exe.to_string_lossy()),
        xml(&path),
    );
    let file = agent_file();
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
    }
    let _ = quiet(Command::new("launchctl").args(["bootout", &format!("{}/{LABEL}", domain())]));
    fs::write(&file, agent)?;
    // The agent just booted out can take a moment to be gone.
    let mut tries = 0;
    loop {
        match quiet(
            Command::new("launchctl")
                .arg("bootstrap")
                .arg(domain())
                .arg(&file),
        ) {
            Err(_) if tries < 10 => {
                tries += 1;
                sleep(Duration::from_millis(500));
            }
            done => return done,
        }
    }
}

#[cfg(target_os = "macos")]
fn unregister() {
    let _ = quiet(Command::new("launchctl").args(["bootout", &format!("{}/{LABEL}", domain())]));
    let _ = fs::remove_file(agent_file());
}

// ---- Windows: the Run key ----

#[cfg(windows)]
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

#[cfg(windows)]
fn register(exe: &Path) -> Result<()> {
    let line = format!("\"{}\" run", exe.display());
    quiet(Command::new("reg").args([
        "add",
        RUN_KEY,
        "/v",
        "myTunnels",
        "/t",
        "REG_SZ",
        "/d",
        &line,
        "/f",
    ]))?;
    spawn_supervisor(exe)
}

#[cfg(windows)]
fn unregister() {
    let _ = quiet(Command::new("reg").args(["delete", RUN_KEY, "/v", "myTunnels", "/f"]));
}
