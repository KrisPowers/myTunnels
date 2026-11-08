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
    /// Device Controller's service, which reads and sets the host's fans.
    pub hardware_url: String,
}

impl Config {
    pub fn from_env() -> Self {
        let var = |key: &str, default: &str| {
            std::env::var(key)
                .ok()
                .filter(|v| !v.trim().is_empty())
                .unwrap_or_else(|| default.to_owned())
        };
        let gate_addr = var("GATE_ADDR", "127.0.0.1:7080");
        Self {
            admin_addr: var("ADMIN_ADDR", "127.0.0.1:7070"),
            gate_service: format!("http://{}", gate_addr.replace("0.0.0.0", "127.0.0.1")),
            gate_addr,
            data_dir: var("DATA_DIR", "data").into(),
            secret_key_file: var("SECRET_KEY_FILE", "keys/secret.key").into(),
            ui_dir: var("UI_DIR", "../ui/dist").into(),
            default_upstream_host: var("UPSTREAM_HOST", "127.0.0.1"),
            cloudflared_bin: var("CLOUDFLARED_BIN", "cloudflared"),
            hardware_url: var("HARDWARE_URL", "http://127.0.0.1:7090"),
        }
    }
}
