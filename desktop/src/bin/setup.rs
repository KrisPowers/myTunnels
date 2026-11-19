//! Installs myTunnels on Windows from the build it carries inside it, with no
//! internet and no GitHub sign-in, such as from a USB drive.
//!
//! It asks first which of what needs administrator rights to allow now, so
//! nothing asks later: the hardware sensors, and the firewall for router
//! ports. Then it runs the same install script as the one-line install,
//! against the build it carries, grants what was chosen through one admin
//! prompt, starts myTunnels and offers to open it.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use desktop::{hidden, home, BACKGROUND, FONT, STYLE};
use serde_json::{json, Value};
use tao::dpi::LogicalSize;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::window::WindowBuilder;
use wry::WebViewBuilder;

const PAYLOAD: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/payload.zip"));
/// The release it carries, when it was built for one.
const RELEASE: Option<&str> = option_env!("SETUP_RELEASE");
const INSTALL: &str = include_str!("../../../scripts/install.ps1");
const PAGE: &str = include_str!("setup.html");

enum Said {
    /// For the page.
    Show(Value),
    Open,
    Close,
}

static STARTED: AtomicBool = AtomicBool::new(false);

fn main() {
    let event_loop = EventLoopBuilder::<Said>::with_user_event().build();
    let window = WindowBuilder::new()
        .with_title("myTunnels setup")
        .with_inner_size(LogicalSize::new(560.0, 760.0))
        .with_resizable(false)
        .with_background_color(BACKGROUND)
        .build(&event_loop)
        .expect("cannot open a window");

    let proxy = event_loop.create_proxy();
    let installed: Vec<&str> = ["docker", "tailscale"]
        .into_iter()
        .filter(|app| here(app))
        .collect();
    let facts = json!({ "release": RELEASE.unwrap_or(""), "empty": PAYLOAD.is_empty(), "installed": installed });
    let page = PAGE.replace("/*FONT*/", FONT).replace("/*STYLE*/", STYLE);
    // Its web data with the temporary files, not beside it on the drive.
    let mut context = wry::WebContext::new(Some(std::env::temp_dir().join("myTunnels setup")));
    let webview = WebViewBuilder::new_with_web_context(&mut context)
        .with_background_color(BACKGROUND)
        .with_hotkeys_zoom(false)
        .with_initialization_script(format!("window.setup = {facts};"))
        .with_html(page)
        .with_ipc_handler(move |ask| {
            let mut words = ask.body().split_whitespace();
            match words.next() {
                Some("install") if !STARTED.swap(true, Ordering::SeqCst) => {
                    let wants: Vec<String> = words.map(str::to_owned).collect();
                    let proxy = proxy.clone();
                    std::thread::spawn(move || install(&wants, &proxy));
                }
                Some("open") => {
                    let _ = proxy.send_event(Said::Open);
                }
                Some("close") => {
                    let _ = proxy.send_event(Said::Close);
                }
                _ => {}
            }
        })
        .build(&window)
        .expect("cannot open setup");

    event_loop.run(move |event, _, flow| {
        *flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(Said::Show(said)) => {
                let _ = webview.evaluate_script(&format!("show({said})"));
            }
            Event::UserEvent(Said::Open) => {
                let _ = Command::new(home().join("bin").join("desktop.exe")).spawn();
                *flow = ControlFlow::Exit;
            }
            Event::UserEvent(Said::Close) => *flow = ControlFlow::Exit,
            // Not while it installs, which would leave it half done.
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } if !STARTED.load(Ordering::SeqCst) || done() => *flow = ControlFlow::Exit,
            _ => {}
        }
    });
}

static DONE: AtomicBool = AtomicBool::new(false);

fn done() -> bool {
    DONE.load(Ordering::SeqCst)
}

fn install(wants: &[String], proxy: &EventLoopProxy<Said>) {
    let step = |text: &str, percent: u8| {
        let _ = proxy.send_event(Said::Show(json!({ "step": text, "percent": percent })));
    };
    let said = match steps(wants, &step) {
        Ok(notes) => json!({ "notes": notes }),
        Err(why) => json!({ "failed": why }),
    };
    DONE.store(true, Ordering::SeqCst);
    let _ = proxy.send_event(Said::Show(said));
}

/// Installs, grants and starts it, with what to say once it is done.
fn steps(wants: &[String], step: &dyn Fn(&str, u8)) -> Result<Vec<String>, String> {
    let temp = std::env::temp_dir().join(format!("myTunnels setup {}", std::process::id()));
    let result = put_in_place(&temp, step);
    let _ = std::fs::remove_dir_all(&temp);
    result?;

    let program = home().join("bin").join("mytunnels.exe");
    let mut notes = Vec::new();
    if !wants.is_empty() {
        step("Waiting for Windows to allow it", 72);
        match grant(&program, wants, step) {
            Ok(()) => {}
            Err(why) => notes.push(why),
        }
    }

    step("Starting myTunnels", 92);
    let out = hidden(Command::new(&program).arg("start"))
        .stdin(Stdio::null())
        .output()
        .map_err(|err| format!("cannot start myTunnels: {err}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_owned());
    }
    step("Starting myTunnels", 100);
    Ok(notes)
}

/// Runs the install script against the build carried here, following its steps.
fn put_in_place(temp: &Path, step: &dyn Fn(&str, u8)) -> Result<(), String> {
    step("Unpacking", 5);
    let failed = |err: std::io::Error| format!("cannot unpack: {err}");
    std::fs::create_dir_all(temp).map_err(failed)?;
    let archive = temp.join("windows-x64.zip");
    std::fs::write(&archive, PAYLOAD).map_err(failed)?;
    let script = temp.join("install.ps1");
    std::fs::write(&script, INSTALL).map_err(failed)?;
    let progress = temp.join("progress.json");

    let mut run = hidden(&mut Command::new("powershell"))
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(&script)
        .env("MYTUNNELS_ARCHIVE", &archive)
        .env("MYTUNNELS_RELEASE", RELEASE.unwrap_or(""))
        .env("MYTUNNELS_PROGRESS", &progress)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("cannot run the install: {err}"))?;
    let status = loop {
        if let Some(status) = run.try_wait().map_err(|err| err.to_string())? {
            break status;
        }
        let now = std::fs::read_to_string(&progress)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok());
        match now.as_ref().and_then(|n| n["step"].as_str()) {
            Some("restart") => step("Putting it in place", 50),
            Some("unpack") => step("Unpacking", 25),
            _ => {}
        }
        std::thread::sleep(Duration::from_millis(200));
    };
    if !status.success() {
        let mut why = String::new();
        if let Some(mut err) = run.stderr.take() {
            let _ = std::io::Read::read_to_string(&mut err, &mut why);
        }
        let why = why.trim();
        return Err(if why.is_empty() {
            "The install script stopped.".into()
        } else {
            why.into()
        });
    }
    step("Putting it in place", 70);
    Ok(())
}

/// Runs `mytunnels grant` with administrator rights, which Windows asks for
/// once: why it did not, when it did not.
fn grant(program: &Path, wants: &[String], step: &dyn Fn(&str, u8)) -> Result<(), String> {
    let sid = account().ok_or("Could not tell which account this is, so nothing was allowed.")?;
    let args = format!("grant {sid} {}", wants.join(" "));
    // What it is up to, from what it writes as it goes.
    let follow = || {
        let said = std::fs::read_to_string(program_files().join("grant.txt")).unwrap_or_default();
        let words: Vec<&str> = said.split_whitespace().collect();
        if let ["doing", n, of, what] = words[..] {
            let (n, of) = (
                n.parse::<u8>().unwrap_or(1),
                of.parse::<u8>().unwrap_or(1).max(1),
            );
            let text = match what {
                "hardware" => "Setting up the hardware sensors",
                "firewall" => "Setting up the firewall",
                "apps" => "Setting up app installs",
                "docker" => "Installing Docker",
                "tailscale" => "Installing Tailscale",
                _ => "Setting up",
            };
            step(text, 72 + 18 * (n - 1) / of);
        }
    };
    match elevate(program, &args, &follow) {
        Ok(0) => Ok(()),
        Ok(_) => {
            let said =
                std::fs::read_to_string(program_files().join("grant.txt")).unwrap_or_default();
            let why = said.trim().trim_start_matches("failed: ");
            Err(format!("Allowing it did not finish: {why}"))
        }
        // ERROR_CANCELLED: the prompt was answered no.
        Err(err) if err.raw_os_error() == Some(1223) => {
            Err("Windows was told no, so myTunnels asks again when it needs to.".into())
        }
        Err(err) => Err(format!("Windows did not ask: {err}")),
    }
}

fn program_files() -> PathBuf {
    std::env::var_os("ProgramFiles")
        .map(PathBuf::from)
        .unwrap_or_else(|| r"C:\Program Files".into())
        .join("myTunnels")
}

/// This account's SID, which the firewall helper takes asks from.
fn account() -> Option<String> {
    let out = hidden(Command::new("whoami").args(["/user", "/fo", "csv", "/nh"]))
        .stdin(Stdio::null())
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let sid = text.trim().rsplit(',').next()?.trim_matches('"');
    sid.starts_with("S-1-").then(|| sid.to_owned())
}

/// Whether `app` is on this computer: on PATH, or where its installer puts it.
fn here(app: &str) -> bool {
    let found = hidden(Command::new("where.exe").arg(app))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success());
    let place: &[&str] = match app {
        "docker" => &["Docker", "Docker", "resources", "bin", "docker.exe"],
        _ => &["Tailscale", "tailscale.exe"],
    };
    let base = std::env::var_os("ProgramFiles").map(PathBuf::from);
    found || base.is_some_and(|b| place.iter().fold(b, |p, part| p.join(part)).exists())
}

/// Runs `program` with administrator rights and waits for its exit code,
/// calling `meanwhile` every moment until it ends.
#[cfg(windows)]
fn elevate(program: &Path, args: &str, meanwhile: &dyn Fn()) -> std::io::Result<u32> {
    use desktop::wide;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::Foundation::WAIT_TIMEOUT;
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
    use windows_sys::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

    let verb = wide("runas");
    let file = wide(&program.to_string_lossy());
    let params = wide(args);
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        lpVerb: verb.as_ptr(),
        lpFile: file.as_ptr(),
        lpParameters: params.as_ptr(),
        nShow: SW_HIDE,
        ..Default::default()
    };
    unsafe {
        if ShellExecuteExW(&mut info) == 0 {
            return Err(std::io::Error::last_os_error());
        }
        while WaitForSingleObject(info.hProcess, 300) == WAIT_TIMEOUT {
            meanwhile();
        }
        let mut code = 0;
        GetExitCodeProcess(info.hProcess, &mut code);
        CloseHandle(info.hProcess);
        Ok(code)
    }
}

#[cfg(not(windows))]
fn elevate(_: &Path, _: &str, _: &dyn Fn()) -> std::io::Result<u32> {
    Err(std::io::Error::other("only Windows is set up this way"))
}
