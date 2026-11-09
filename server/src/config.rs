use std::path::PathBuf;

pub struct Config {
    /// Where the admin panel and its API listen.
    pub admin_addr: String,
    /// Where the access gateway listens. cloudflared is its only client.
    pub gate_addr: String,
    /// The gateway address as cloudflared should reach it.
    pub gate_service: String,
    pub data_dir: PathBuf,
    /// The key that seals secrets in the database, kept apart from it.
    pub secret_key_file: PathBuf,
    pub ui_dir: PathBuf,
    /// Host that tunnel ports point at unless a tunnel names its own.
    pub default_upstream_host: String,
    pub cloudflared_bin: String,
}

impl Config {
    pub fn from_env() -> Self {
        let var = |key: &str, default: &str| {
            std::env::var(key)
                .ok()
                .filter(|v| !v.trim().is_empty())
                .unwrap_or_else(|| default.to_owned())
        };
        let path = |p: PathBuf| p.to_string_lossy().into_owned();
        let gate_addr = var("GATE_ADDR", "127.0.0.1:7080");
        // An install keeps the UI and cloudflared beside the program.
        let beside = |name: &str| {
            program()
                .and_then(|exe| Some(exe.parent()?.join(name)))
                .filter(|p| p.exists())
        };
        let ui_dir = beside("ui").unwrap_or_else(|| "../ui/dist".into());
        let cloudflared = beside(&format!("cloudflared{}", std::env::consts::EXE_SUFFIX))
            .map_or_else(|| "cloudflared".to_owned(), path);
        Self {
            admin_addr: var("ADMIN_ADDR", "127.0.0.1:7070"),
            gate_service: format!("http://{}", gate_addr.replace("0.0.0.0", "127.0.0.1")),
            gate_addr,
            data_dir: var("DATA_DIR", &path(home().join("data"))).into(),
            secret_key_file: var("SECRET_KEY_FILE", &path(home().join("keys/secret.key"))).into(),
            ui_dir: var("UI_DIR", &path(ui_dir)).into(),
            default_upstream_host: var("UPSTREAM_HOST", "127.0.0.1"),
            cloudflared_bin: var("CLOUDFLARED_BIN", &cloudflared),
        }
    }
}

/// This computer's folder for myTunnels: `%LOCALAPPDATA%\myTunnels` on
/// Windows, `~/.local/share/myTunnels` elsewhere.
pub fn home() -> PathBuf {
    let base = if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
    } else {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share"))
    };
    base.unwrap_or_else(std::env::temp_dir).join("myTunnels")
}

/// This program's own file, past any link to it, such as Homebrew's in bin.
pub fn program() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    #[cfg(unix)]
    let exe = std::fs::canonicalize(&exe).unwrap_or(exe);
    Some(exe)
}
