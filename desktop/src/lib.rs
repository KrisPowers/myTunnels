//! What the desktop app and its setup share: where myTunnels lives, the
//! panel's address, and the plain page either shows while it works.

use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

/// The panel's dark ground, so the window never flashes white.
pub const BACKGROUND: (u8, u8, u8, u8) = (0x14, 0x15, 0x17, 0xff);

/// The panel's address on this computer, as myTunnels itself reads it.
fn addr() -> SocketAddr {
    std::env::var("ADMIN_ADDR")
        .ok()
        .map(|a| a.replace("0.0.0.0", "127.0.0.1"))
        .and_then(|a| a.parse().ok())
        .unwrap_or_else(|| SocketAddr::from(([127, 0, 0, 1], 7070)))
}

pub fn panel() -> String {
    format!("http://localhost:{}/", addr().port())
}

pub fn answering() -> bool {
    TcpStream::connect_timeout(&addr(), Duration::from_millis(500)).is_ok()
}

/// This computer's folder for myTunnels, the same one it keeps its data in.
pub fn home() -> PathBuf {
    let base = if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
    } else {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share"))
    };
    base.unwrap_or_else(std::env::temp_dir).join("myTunnels")
}

/// A program installed beside this one.
pub fn beside(name: &str) -> PathBuf {
    let file = format!("{name}{}", std::env::consts::EXE_SUFFIX);
    std::env::current_exe()
        .ok()
        .and_then(|exe| Some(exe.parent()?.join(&file)))
        .unwrap_or_else(|| file.into())
}

/// Runs it without a console window flashing up.
pub fn hidden(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd
}

/// Opens a web address in the default browser. Nothing but web and mail
/// addresses, so a page cannot start a program.
pub fn open_outside(url: &str) {
    if !["https://", "http://", "mailto:"]
        .iter()
        .any(|s| url.starts_with(s))
    {
        return;
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        let verb = wide("open");
        let file = wide(url);
        unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                verb.as_ptr(),
                file.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            );
        }
    }
    #[cfg(target_os = "macos")]
    let _ = Command::new("open").arg(url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let _ = Command::new("xdg-open").arg(url).spawn();
}

#[cfg(windows)]
pub fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

/// Whether a window titled `title` is open already, which is then brought
/// to the front.
pub fn already_open(title: &str) -> bool {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
        use windows_sys::Win32::System::Threading::CreateMutexW;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            FindWindowW, SetForegroundWindow, ShowWindow, SW_RESTORE,
        };
        // Held until this program ends.
        let name = wide(&format!("Local\\{title} window"));
        CreateMutexW(std::ptr::null(), 0, name.as_ptr());
        if GetLastError() != ERROR_ALREADY_EXISTS {
            return false;
        }
        let window = FindWindowW(std::ptr::null(), wide(title).as_ptr());
        if !window.is_null() {
            ShowWindow(window, SW_RESTORE);
            SetForegroundWindow(window);
        }
        true
    }
    #[cfg(not(windows))]
    {
        let _ = title;
        false
    }
}

/// Text made safe to put in a page.
pub fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// The panel's font, carried inside the program.
pub const FONT: &str = include_str!(concat!(env!("OUT_DIR"), "/font.css"));

/// The panel's colours and type, for the pages shown before it answers.
pub const STYLE: &str = r#"
:root {
  color-scheme: light dark;
  --bg: light-dark(#f4f5f6, #141517);
  --card: light-dark(#ffffff, #1c1d20);
  --card-2: light-dark(#f2f3f5, #25262a);
  --line: light-dark(#e5e7ea, #2a2b2f);
  --line-strong: light-dark(#cdd1d6, #3b3c41);
  --text: light-dark(#1c1e21, #f4f5f6);
  --text-2: light-dark(#50565e, #b6b9c0);
  --text-3: light-dark(#80868f, #7f838b);
  --accent: light-dark(#006fff, #4797ff);
  --on-accent: #ffffff;
  --btn: light-dark(#eef0f2, #2a2b2f);
  --btn-hover: light-dark(#e3e6e9, #34353a);
  --warn: light-dark(#c26a00, #f5a524);
  --ok: light-dark(#1f9e4f, #38c66c);
  --bad: light-dark(#d93a3f, #f2555b);
  --font: "Roboto", "Segoe UI", system-ui, -apple-system, sans-serif;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); font: 14px/1.45 var(--font); user-select: none; cursor: default; }
.center { height: 100%; display: grid; place-items: center; padding: 32px; text-align: center; }
h1 { font-size: 20px; font-weight: 600; margin: 0 0 6px; }
p { margin: 0; color: var(--text-2); max-width: 520px; }
"#;

/// A page with a title and a line under it.
pub fn page(title: &str, detail: &str) -> String {
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><style>{FONT}{STYLE}</style></head>\
         <body><div class=\"center\"><div><h1>{}</h1><p>{}</p></div></div></body></html>",
        escape(title),
        escape(detail)
    )
}
