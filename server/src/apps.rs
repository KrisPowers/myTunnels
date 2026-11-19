//! Apps: the software a homelab or engineering machine usually needs, in one
//! catalog, each installed with one click on the machine myTunnels runs on,
//! through its package manager (winget, Homebrew or apt). When myTunnels runs
//! inside Docker, that machine is reached through `server host`, which pairs with the first myTunnels to ask
//! and from then on installs only for it.
//!
//! Some features need an app where myTunnels runs: Containers need Docker,
//! tunnels need cloudflared and Git needs git. They keep working without
//! them, and say which app to install.

use std::collections::HashMap;
use std::path::{Path as FsPath, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::process::Command;

use crate::docker::{self, Endpoint};
use crate::state::AppState;
use crate::util::{lock, random_hex, sha256_hex, ApiError, ApiResult};

/// One app in the catalog. A package name is left out where its manager
/// does not carry it.
#[derive(Serialize)]
pub struct App {
    pub id: &'static str,
    pub name: &'static str,
    pub group: &'static str,
    pub about: &'static str,
    /// Its mark in the panel.
    pub logo: &'static str,
    /// Where its makers offer it, named when its package manager does not.
    #[serde(skip)]
    pub url: &'static str,
    /// Another app it is installed with, such as Node.js for npm packages.
    pub needs: Option<&'static str>,
    /// A feature of myTunnels needs it where myTunnels runs.
    pub used: bool,
    #[serde(skip)]
    bins: &'static [&'static str],
    #[serde(skip)]
    version: &'static [&'static str],
    #[serde(skip)]
    winget: Option<&'static str>,
    /// A formula, or `--cask name` for an app.
    #[serde(skip)]
    brew: Option<&'static str>,
    #[serde(skip)]
    apt: Option<&'static str>,
    #[serde(skip)]
    npm: Option<&'static str>,
}

const V: &[&str] = &["--version"];

const fn app(
    id: &'static str,
    name: &'static str,
    group: &'static str,
    about: &'static str,
    logo: &'static str,
    url: &'static str,
    bins: &'static [&'static str],
) -> App {
    App {
        id,
        name,
        group,
        about,
        logo,
        url,
        needs: None,
        used: false,
        bins,
        version: V,
        winget: None,
        brew: None,
        apt: None,
        npm: None,
    }
}

impl App {
    const fn winget(mut self, id: &'static str) -> Self {
        self.winget = Some(id);
        self
    }
    const fn brew(mut self, name: &'static str) -> Self {
        self.brew = Some(name);
        self
    }
    const fn apt(mut self, name: &'static str) -> Self {
        self.apt = Some(name);
        self
    }
    const fn npm(mut self, name: &'static str) -> Self {
        self.npm = Some(name);
        self.needs = Some("nodejs");
        self
    }
    const fn used(mut self) -> Self {
        self.used = true;
        self
    }
    const fn version(mut self, args: &'static [&'static str]) -> Self {
        self.version = args;
        self
    }
}

pub const CATALOG: &[App] = &[
    app(
        "docker",
        "Docker",
        "Containers",
        "Runs containers; Containers needs it",
        "docker",
        "https://www.docker.com/products/docker-desktop/",
        &["docker"],
    )
    .used()
    .winget("Docker.DockerDesktop")
    .brew("--cask docker")
    .apt("docker.io"),
    app(
        "podman",
        "Podman",
        "Containers",
        "Runs containers without a daemon",
        "podman",
        "https://podman.io/docs/installation",
        &["podman"],
    )
    .winget("RedHat.Podman")
    .brew("podman")
    .apt("podman"),
    app(
        "kubectl",
        "kubectl",
        "Containers",
        "Kubernetes' command line",
        "kubernetes",
        "https://kubernetes.io/docs/tasks/tools/",
        &["kubectl"],
    )
    .winget("Kubernetes.kubectl")
    .brew("kubectl")
    .version(&["version", "--client"]),
    app(
        "minikube",
        "minikube",
        "Containers",
        "A Kubernetes cluster on this machine",
        "kubernetes",
        "https://minikube.sigs.k8s.io/docs/start/",
        &["minikube"],
    )
    .winget("Kubernetes.minikube")
    .brew("minikube")
    .version(&["version", "--short"]),
    app(
        "kind",
        "kind",
        "Containers",
        "Kubernetes clusters in Docker containers",
        "kubernetes",
        "https://kind.sigs.k8s.io/docs/user/quick-start/",
        &["kind"],
    )
    .winget("Kubernetes.kind")
    .brew("kind")
    .version(&["version"]),
    app(
        "k9s",
        "k9s",
        "Containers",
        "A terminal view of a Kubernetes cluster",
        "kubernetes",
        "https://k9scli.io/topics/install/",
        &["k9s"],
    )
    .winget("Derailed.k9s")
    .brew("k9s")
    .version(&["version", "--short"]),
    app(
        "helm",
        "Helm",
        "Containers",
        "Kubernetes' package manager",
        "helm",
        "https://helm.sh/docs/intro/install/",
        &["helm"],
    )
    .winget("Helm.Helm")
    .brew("helm")
    .version(&["version", "--short"]),
    app(
        "argocd",
        "Argo CD",
        "Containers",
        "GitOps deploys to Kubernetes, from the command line",
        "argo",
        "https://argo-cd.readthedocs.io/en/stable/cli_installation/",
        &["argocd"],
    )
    .winget("argoproj.argocd")
    .brew("argocd")
    .version(&["version", "--client", "--short"]),
    app(
        "cloudflared",
        "cloudflared",
        "Cloudflare",
        "Cloudflare Tunnel's connector; tunnels need it",
        "cloudflare",
        "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
        &["cloudflared"],
    )
    .used()
    .winget("Cloudflare.cloudflared")
    .brew("cloudflared"),
    app(
        "warp",
        "Cloudflare WARP",
        "Cloudflare",
        "Cloudflare's VPN client and Zero Trust agent",
        "cloudflare",
        "https://one.one.one.one/",
        &["warp-cli"],
    )
    .winget("Cloudflare.Warp")
    .brew("--cask cloudflare-warp"),
    app(
        "wrangler",
        "Wrangler",
        "Cloudflare",
        "The command line for Cloudflare Workers",
        "cloudflareworkers",
        "https://developers.cloudflare.com/workers/wrangler/install-and-update/",
        &["wrangler"],
    )
    .npm("wrangler"),
    app(
        "gcloud",
        "Google Cloud CLI",
        "Cloud",
        "Google Cloud from the command line",
        "googlecloud",
        "https://cloud.google.com/sdk/docs/install",
        &["gcloud"],
    )
    .winget("Google.CloudSDK")
    .brew("--cask google-cloud-sdk"),
    app(
        "doctl",
        "doctl",
        "Cloud",
        "DigitalOcean from the command line",
        "digitalocean",
        "https://docs.digitalocean.com/reference/doctl/how-to/install/",
        &["doctl"],
    )
    .winget("DigitalOcean.Doctl")
    .brew("doctl")
    .version(&["version"]),
    app(
        "vercel",
        "Vercel CLI",
        "Cloud",
        "Deploys sites and apps to Vercel",
        "vercel",
        "https://vercel.com/docs/cli",
        &["vercel"],
    )
    .npm("vercel"),
    app(
        "netlify",
        "Netlify CLI",
        "Cloud",
        "Deploys sites to Netlify",
        "netlify",
        "https://docs.netlify.com/cli/get-started/",
        &["netlify"],
    )
    .npm("netlify-cli"),
    app(
        "tailscale",
        "Tailscale",
        "Networking",
        "A private network between your devices, on WireGuard",
        "tailscale",
        "https://tailscale.com/download",
        &["tailscale"],
    )
    .winget("Tailscale.Tailscale")
    .brew("tailscale")
    .version(&["version"]),
    app(
        "ngrok",
        "ngrok",
        "Networking",
        "Puts a local port on a public address",
        "ngrok",
        "https://ngrok.com/download",
        &["ngrok"],
    )
    .winget("Ngrok.Ngrok")
    .brew("--cask ngrok"),
    app(
        "wireguard",
        "WireGuard",
        "Networking",
        "A fast, simple VPN",
        "wireguard",
        "https://www.wireguard.com/install/",
        &["wg"],
    )
    .winget("WireGuard.WireGuard")
    .brew("wireguard-tools")
    .apt("wireguard"),
    app(
        "caddy",
        "Caddy",
        "Networking",
        "A web server that sets up HTTPS on its own",
        "caddy",
        "https://caddyserver.com/docs/install",
        &["caddy"],
    )
    .winget("CaddyServer.Caddy")
    .brew("caddy")
    .apt("caddy")
    .version(&["version"]),
    app(
        "nginx",
        "nginx",
        "Networking",
        "A web server and reverse proxy",
        "nginx",
        "https://nginx.org/en/download.html",
        &["nginx"],
    )
    .brew("nginx")
    .apt("nginx")
    .version(&["-v"]),
    app(
        "git",
        "Git",
        "Source control",
        "Version control; Git and repository builds need it",
        "git",
        "https://git-scm.com/downloads",
        &["git"],
    )
    .used()
    .winget("Git.Git")
    .brew("git")
    .apt("git"),
    app(
        "gitlfs",
        "Git LFS",
        "Source control",
        "Large files in Git repositories",
        "gitlfs",
        "https://git-lfs.com/",
        &["git-lfs"],
    )
    .winget("GitHub.GitLFS")
    .brew("git-lfs")
    .apt("git-lfs"),
    app(
        "gh",
        "GitHub CLI",
        "Source control",
        "GitHub from the command line",
        "github",
        "https://cli.github.com/",
        &["gh"],
    )
    .winget("GitHub.cli")
    .brew("gh")
    .apt("gh"),
    app(
        "glab",
        "GitLab CLI",
        "Source control",
        "GitLab from the command line",
        "gitlab",
        "https://gitlab.com/gitlab-org/cli",
        &["glab"],
    )
    .winget("GLab.GLab")
    .brew("glab"),
    app(
        "rust",
        "Rust",
        "Languages",
        "Rust and Cargo, through rustup",
        "rust",
        "https://rustup.rs/",
        &["rustup", "cargo"],
    )
    .winget("Rustlang.Rustup")
    .brew("rustup"),
    app(
        "go",
        "Go",
        "Languages",
        "The Go toolchain",
        "go",
        "https://go.dev/dl/",
        &["go"],
    )
    .winget("GoLang.Go")
    .brew("go")
    .apt("golang-go")
    .version(&["version"]),
    app(
        "python",
        "Python",
        "Languages",
        "Python 3 and pip",
        "python",
        "https://www.python.org/downloads/",
        &["python3", "python"],
    )
    .winget("Python.Python.3.13")
    .brew("python")
    .apt("python3"),
    app(
        "java",
        "Java",
        "Languages",
        "The OpenJDK, from Microsoft's build",
        "openjdk",
        "https://learn.microsoft.com/java/openjdk/download",
        &["java"],
    )
    .winget("Microsoft.OpenJDK.21")
    .brew("openjdk")
    .apt("default-jdk"),
    app(
        "dotnet",
        ".NET",
        "Languages",
        "The .NET SDK",
        "dotnet",
        "https://dotnet.microsoft.com/download",
        &["dotnet"],
    )
    .winget("Microsoft.DotNet.SDK.10")
    .brew("--cask dotnet-sdk"),
    app(
        "php",
        "PHP",
        "Languages",
        "PHP's command line",
        "php",
        "https://www.php.net/downloads",
        &["php"],
    )
    .winget("PHP.PHP.8.4")
    .brew("php")
    .apt("php-cli"),
    app(
        "ruby",
        "Ruby",
        "Languages",
        "Ruby and its gems",
        "ruby",
        "https://www.ruby-lang.org/en/downloads/",
        &["ruby"],
    )
    .winget("RubyInstallerTeam.Ruby.3.4")
    .brew("ruby")
    .apt("ruby"),
    app(
        "zig",
        "Zig",
        "Languages",
        "The Zig toolchain, a C compiler as well",
        "zig",
        "https://ziglang.org/download/",
        &["zig"],
    )
    .winget("zig.zig")
    .brew("zig")
    .version(&["version"]),
    app(
        "cmake",
        "CMake",
        "Languages",
        "Builds C and C++ projects",
        "cmake",
        "https://cmake.org/download/",
        &["cmake"],
    )
    .winget("Kitware.CMake")
    .brew("cmake")
    .apt("cmake"),
    app(
        "nodejs",
        "Node.js",
        "Runtimes",
        "JavaScript's runtime, with npm",
        "nodedotjs",
        "https://nodejs.org/en/download",
        &["node"],
    )
    .winget("OpenJS.NodeJS.LTS")
    .brew("node")
    .apt("nodejs"),
    app(
        "fnm",
        "fnm",
        "Runtimes",
        "Switches between Node.js versions",
        "nodedotjs",
        "https://github.com/Schniz/fnm",
        &["fnm"],
    )
    .winget("Schniz.fnm")
    .brew("fnm"),
    app(
        "bun",
        "Bun",
        "Runtimes",
        "A fast JavaScript runtime and package manager",
        "bun",
        "https://bun.sh/",
        &["bun"],
    )
    .winget("Oven-sh.Bun")
    .brew("oven-sh/bun/bun"),
    app(
        "deno",
        "Deno",
        "Runtimes",
        "A JavaScript and TypeScript runtime",
        "deno",
        "https://deno.com/",
        &["deno"],
    )
    .winget("DenoLand.Deno")
    .brew("deno"),
    app(
        "pnpm",
        "pnpm",
        "Runtimes",
        "A fast npm that saves disk space",
        "pnpm",
        "https://pnpm.io/installation",
        &["pnpm"],
    )
    .winget("pnpm.pnpm")
    .brew("pnpm"),
    app(
        "yarn",
        "Yarn",
        "Runtimes",
        "A package manager for JavaScript",
        "yarn",
        "https://yarnpkg.com/getting-started/install",
        &["yarn"],
    )
    .npm("yarn"),
    app(
        "uv",
        "uv",
        "Runtimes",
        "Python's packages and projects, fast",
        "uv",
        "https://docs.astral.sh/uv/getting-started/installation/",
        &["uv"],
    )
    .winget("astral-sh.uv")
    .brew("uv"),
    app(
        "ollama",
        "Ollama",
        "Runtimes",
        "Runs AI models on this machine",
        "ollama",
        "https://ollama.com/download",
        &["ollama"],
    )
    .winget("Ollama.Ollama")
    .brew("ollama"),
    app(
        "terraform",
        "Terraform",
        "Infrastructure",
        "Infrastructure as code",
        "terraform",
        "https://developer.hashicorp.com/terraform/install",
        &["terraform"],
    )
    .winget("Hashicorp.Terraform")
    .brew("hashicorp/tap/terraform")
    .version(&["version"]),
    app(
        "opentofu",
        "OpenTofu",
        "Infrastructure",
        "Open-source infrastructure as code",
        "opentofu",
        "https://opentofu.org/docs/intro/install/",
        &["tofu"],
    )
    .winget("OpenTofu.Tofu")
    .brew("opentofu")
    .version(&["version"]),
    app(
        "pulumi",
        "Pulumi",
        "Infrastructure",
        "Infrastructure as code in everyday languages",
        "pulumi",
        "https://www.pulumi.com/docs/iac/download-install/",
        &["pulumi"],
    )
    .winget("Pulumi.Pulumi")
    .brew("pulumi/tap/pulumi")
    .version(&["version"]),
    app(
        "ansible",
        "Ansible",
        "Infrastructure",
        "Sets up machines over SSH",
        "ansible",
        "https://docs.ansible.com/ansible/latest/installation_guide/",
        &["ansible"],
    )
    .brew("ansible")
    .apt("ansible"),
    app(
        "packer",
        "Packer",
        "Infrastructure",
        "Builds machine images",
        "packer",
        "https://developer.hashicorp.com/packer/install",
        &["packer"],
    )
    .winget("Hashicorp.Packer")
    .brew("hashicorp/tap/packer"),
    app(
        "vagrant",
        "Vagrant",
        "Infrastructure",
        "Virtual machines for development",
        "vagrant",
        "https://developer.hashicorp.com/vagrant/install",
        &["vagrant"],
    )
    .winget("Hashicorp.Vagrant")
    .brew("--cask hashicorp/tap/hashicorp-vagrant"),
    app(
        "vault",
        "Vault",
        "Security",
        "Keeps secrets and keys",
        "vault",
        "https://developer.hashicorp.com/vault/install",
        &["vault"],
    )
    .winget("Hashicorp.Vault")
    .brew("hashicorp/tap/vault"),
    app(
        "bitwarden",
        "Bitwarden CLI",
        "Security",
        "Your Bitwarden vault from the command line",
        "bitwarden",
        "https://bitwarden.com/help/cli/",
        &["bw"],
    )
    .winget("Bitwarden.CLI")
    .brew("bitwarden-cli"),
    app(
        "1password",
        "1Password CLI",
        "Security",
        "1Password from the command line",
        "1password",
        "https://developer.1password.com/docs/cli/get-started/",
        &["op"],
    )
    .winget("AgileBits.1Password.CLI")
    .brew("--cask 1password-cli"),
    app(
        "rclone",
        "rclone",
        "Files and media",
        "Syncs files with cloud storage",
        "rclone",
        "https://rclone.org/downloads/",
        &["rclone"],
    )
    .winget("Rclone.Rclone")
    .brew("rclone")
    .apt("rclone"),
    app(
        "syncthing",
        "Syncthing",
        "Files and media",
        "Keeps folders in sync between devices",
        "syncthing",
        "https://syncthing.net/downloads/",
        &["syncthing"],
    )
    .winget("Syncthing.Syncthing")
    .brew("syncthing")
    .apt("syncthing"),
    app(
        "ffmpeg",
        "FFmpeg",
        "Files and media",
        "Converts and records audio and video",
        "ffmpeg",
        "https://ffmpeg.org/download.html",
        &["ffmpeg"],
    )
    .winget("Gyan.FFmpeg")
    .brew("ffmpeg")
    .apt("ffmpeg")
    .version(&["-version"]),
    app(
        "neovim",
        "Neovim",
        "Editors",
        "A modal text editor",
        "neovim",
        "https://neovim.io/",
        &["nvim"],
    )
    .winget("Neovim.Neovim")
    .brew("neovim")
    .apt("neovim"),
    app(
        "vscodium",
        "VSCodium",
        "Editors",
        "VS Code without Microsoft's telemetry",
        "vscodium",
        "https://vscodium.com/",
        &["codium"],
    )
    .winget("VSCodium.VSCodium")
    .brew("--cask vscodium"),
];

fn find(id: &str) -> Option<&'static App> {
    CATALOG.iter().find(|a| a.id == id)
}

// ---- the machine itself ----

/// How this machine installs apps.
#[derive(Clone, Copy, PartialEq)]
enum Manager {
    Winget,
    Brew,
    Apt,
}

fn os() -> &'static str {
    match std::env::consts::OS {
        "windows" => "windows",
        "macos" => "macos",
        _ => "linux",
    }
}

fn manager(dirs: &[PathBuf]) -> Option<Manager> {
    let (m, bin) = match os() {
        "windows" => (Manager::Winget, "winget"),
        "macos" => (Manager::Brew, "brew"),
        _ => (Manager::Apt, "apt-get"),
    };
    which(bin, dirs).map(|_| m)
}

fn manager_name(m: Option<Manager>) -> Option<&'static str> {
    m.map(|m| match m {
        Manager::Winget => "winget",
        Manager::Brew => "Homebrew",
        Manager::Apt => "apt",
    })
}

/// The program and arguments that install `a` here, if this machine can.
fn install_command(
    a: &App,
    m: Option<Manager>,
    dirs: &[PathBuf],
    action: Action,
    version: Option<&str>,
) -> Option<(PathBuf, Vec<String>)> {
    let words = |s: &str| s.split_whitespace().map(str::to_owned).collect::<Vec<_>>();
    // A version is only ever installed, never updated to or removed by number.
    let version = version.filter(|_| action == Action::Install);
    if let Some(pkg) = a.npm {
        let npm = which("npm", dirs)?;
        let verb = match action {
            Action::Install => "install",
            Action::Update => "update",
            Action::Uninstall => "uninstall",
        };
        let pkg = match version {
            Some(v) => format!("{pkg}@{v}"),
            None => pkg.to_owned(),
        };
        return Some((npm, vec![verb.into(), "-g".into(), pkg]));
    }
    match m? {
        Manager::Winget => {
            let mut args = words(match action {
                // Every catalog ID is in winget's own source; the Store's is
                // left out, which fails on machines without the Store set up.
                Action::Install => "install --source winget --exact --silent --disable-interactivity --accept-package-agreements --accept-source-agreements --id",
                Action::Update => "upgrade --source winget --exact --silent --disable-interactivity --accept-package-agreements --accept-source-agreements --id",
                Action::Uninstall => "uninstall --exact --silent --disable-interactivity --accept-source-agreements --id",
            });
            args.push(a.winget?.into());
            if let Some(v) = version {
                // `--force` lets it replace whichever version is there.
                args.extend(["--version".into(), v.into(), "--force".into()]);
            }
            Some((which("winget", dirs)?, args))
        }
        Manager::Brew => {
            let verb = match action {
                Action::Install => "install",
                Action::Update => "upgrade",
                Action::Uninstall => "uninstall",
            };
            let mut args = vec![verb.to_owned()];
            args.extend(words(a.brew?));
            Some((which("brew", dirs)?, args))
        }
        Manager::Apt => {
            // Without a password: sudo set up for it, or running as root.
            let mut args = words(match action {
                Action::Install => "-n apt-get install -y",
                Action::Update => "-n apt-get install --only-upgrade -y",
                Action::Uninstall => "-n apt-get remove -y",
            });
            let pkg = a.apt?;
            args.push(match version {
                Some(v) => format!("{pkg}={v}"),
                None => pkg.into(),
            });
            Some((which("sudo", dirs)?, args))
        }
    }
}

/// What is done to an app on the host.
#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Install,
    Update,
    Uninstall,
}

impl Action {
    fn parse(word: &str) -> Option<Self> {
        match word {
            "install" => Some(Self::Install),
            "update" => Some(Self::Update),
            "uninstall" => Some(Self::Uninstall),
            _ => None,
        }
    }

    fn doing(self) -> &'static str {
        match self {
            Self::Install => "installed",
            Self::Update => "updated",
            Self::Uninstall => "removed",
        }
    }
}

/// Every folder programs are found in, as a new sign-in would see them: on
/// Windows the saved PATH as well, so an app installed a moment ago is found.
fn search_dirs() -> Vec<PathBuf> {
    let mut list: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    if cfg!(windows) {
        for key in [
            r"HKCU\Environment",
            r"HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
        ] {
            let out = std::process::Command::new("reg")
                .args(["query", key, "/v", "Path"])
                .output();
            let Ok(out) = out else { continue };
            let text = String::from_utf8_lossy(&out.stdout);
            if let Some(value) = text
                .lines()
                .find_map(|l| {
                    l.trim()
                        .strip_prefix("Path")
                        .or_else(|| l.trim().strip_prefix("PATH"))
                })
                .and_then(|rest| {
                    rest.trim()
                        .split_once("    ")
                        .map(|(_, v)| v.trim().to_owned())
                })
            {
                let var = |name: &str| std::env::var(name).ok();
                list.extend(
                    value
                        .split(';')
                        .filter(|p| !p.is_empty())
                        .map(|p| PathBuf::from(expand(p, var))),
                );
            }
        }
    } else if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        list.extend([
            home.join(".cargo/bin"),
            home.join(".local/bin"),
            home.join(".bun/bin"),
            home.join(".deno/bin"),
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/local/go/bin"),
        ]);
    }
    let mut seen = Vec::new();
    list.retain(|p| {
        let new = !seen.contains(p);
        seen.push(p.clone());
        new
    });
    list
}

/// `%USERPROFILE%\bin` with the variable filled in by `var`.
fn expand(path: &str, var: impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::new();
    let mut rest = path;
    while let Some(start) = rest.find('%') {
        let Some(len) = rest[start + 1..].find('%') else {
            break;
        };
        let name = &rest[start + 1..start + 1 + len];
        out.push_str(&rest[..start]);
        out.push_str(&var(name).unwrap_or_default());
        rest = &rest[start + len + 2..];
    }
    out.push_str(rest);
    out
}

/// Where a program is, as a new sign-in would find it, or in the folder its
/// installer puts it in when that is not on the PATH.
pub fn locate(bin: &str) -> Option<PathBuf> {
    let mut dirs = search_dirs();
    if let Some(programs) = std::env::var_os("ProgramFiles") {
        dirs.push(PathBuf::from(programs).join("Tailscale"));
    }
    which(bin, &dirs).or_else(|| {
        // The Mac app keeps its command inside itself, named for the app.
        let mac = PathBuf::from("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
        (bin == "tailscale" && mac.is_file()).then_some(mac)
    })
}

fn which(bin: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    let names: Vec<String> = if cfg!(windows) {
        ["exe", "cmd", "bat"]
            .iter()
            .map(|e| format!("{bin}.{e}"))
            .collect()
    } else {
        vec![bin.to_owned()]
    };
    dirs.iter()
        .flat_map(|d| names.iter().map(move |n| d.join(n)))
        .find(|p| p.is_file())
}

/// The first line a program says about its version, if it runs at all: a
/// stand-in such as Windows' Python shortcut does not count.
async fn version_of(bin: &FsPath, args: &[&str]) -> Option<String> {
    let run = Command::new(bin)
        .args(args)
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output();
    let out = tokio::time::timeout(Duration::from_secs(5), run)
        .await
        .ok()?
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = if out.stdout.is_empty() {
        out.stderr
    } else {
        out.stdout
    };
    let line = String::from_utf8_lossy(&text)
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .chars()
        .take(80)
        .collect::<String>();
    Some(line)
}

/// How far along an install is. It only ever moves forward.
#[derive(Clone, Copy, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "lowercase")]
enum Stage {
    Preparing,
    Downloading,
    Installing,
    /// The installer is done and the app is being looked at again.
    Checking,
}

/// An install running or done here.
#[derive(Clone, Serialize)]
struct Job {
    action: Action,
    running: bool,
    failed: bool,
    /// While running, the installer's latest line; after, the last of what it said.
    log: String,
    stage: Stage,
    /// How much of the download is done, while downloading and the installer says.
    percent: Option<u8>,
}

impl Job {
    /// Moves the job along by a line the installer printed.
    fn feed(&mut self, line: &str) {
        let low = line.to_lowercase();
        let has = |words: &[&str]| words.iter().any(|w| low.contains(w));
        let stage = if has(&[
            "starting package",
            "pouring",
            "unpacking",
            "setting up",
            "installing",
            "uninstalling",
            "removing",
            "linking",
        ]) {
            Some(Stage::Installing)
        } else if has(&["download", "fetching"]) || low.starts_with("get:") {
            Some(Stage::Downloading)
        } else {
            None
        };
        let percent = progress(line);
        let stage = stage.or(percent.map(|_| Stage::Downloading));
        if let Some(s) = stage.filter(|s| *s > self.stage) {
            self.stage = s;
            self.percent = None;
        }
        if self.stage == Stage::Downloading {
            self.percent = percent.or(self.percent);
        }
        if line.chars().filter(|c| c.is_alphabetic()).count() > 2 {
            self.log = line.chars().take(160).collect();
        }
    }
}

/// The share done a progress line shows: `45%`, or `10.0 MB / 20.5 MB`.
fn progress(line: &str) -> Option<u8> {
    if let Some(at) = line.find('%') {
        let digits: String = line[..at]
            .chars()
            .rev()
            .take_while(|c| c.is_ascii_digit() || *c == '.')
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        if let Ok(p) = digits.parse::<f32>() {
            return Some(p.clamp(0.0, 100.0) as u8);
        }
    }
    let size = |n: &str, unit: &str| -> Option<f64> {
        let n: f64 = n.parse().ok()?;
        let scale = match unit.to_ascii_uppercase().as_str() {
            "B" => 1.0,
            "KB" | "KIB" => 1e3,
            "MB" | "MIB" => 1e6,
            "GB" | "GIB" => 1e9,
            _ => return None,
        };
        Some(n * scale)
    };
    let (before, after) = line.split_once(" / ")?;
    let mut before = before.split_whitespace().rev();
    let unit = before.next()?;
    let done = size(before.next()?, unit)?;
    let mut after = after.split_whitespace();
    let total = size(after.next()?, after.next()?)?;
    (total > 0.0).then(|| (done / total * 100.0).clamp(0.0, 100.0) as u8)
}

/// Sends what a pipe says to `tx`, a line at a time; a carriage return ends a
/// line too, so each step of a progress bar arrives as it is drawn.
fn lines_of(
    mut pipe: impl tokio::io::AsyncRead + Unpin + Send + 'static,
    tx: tokio::sync::mpsc::UnboundedSender<String>,
) {
    use tokio::io::AsyncReadExt;
    tokio::spawn(async move {
        let mut buf = [0u8; 4096];
        let mut line = Vec::new();
        let send = |line: &mut Vec<u8>| {
            if !line.is_empty() {
                let _ = tx.send(String::from_utf8_lossy(line).trim().to_owned());
                line.clear();
            }
        };
        while let Ok(n @ 1..) = pipe.read(&mut buf).await {
            for &b in &buf[..n] {
                if b == b'\n' || b == b'\r' {
                    send(&mut line);
                } else {
                    line.push(b);
                }
            }
        }
        send(&mut line);
    });
}

/// Runs the installer, moving `id`'s job along as it prints. Ends with whether
/// it worked and the last of what it said.
async fn run_installer(id: &str, program: &FsPath, args: &[String]) -> (bool, String) {
    let _one = MANAGER.lock().await;
    // winget through the helper granted at install, so no installer asks for
    // administrator rights on a screen no one may be at.
    #[cfg(windows)]
    if program
        .file_stem()
        .is_some_and(|s| s.eq_ignore_ascii_case("winget"))
    {
        if let Some(done) = helper::run(id, args).await {
            return done;
        }
    }
    let child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(err) => return (false, format!("Could not start the installer: {err}")),
    };
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    if let Some(out) = child.stdout.take() {
        lines_of(out, tx.clone());
    }
    if let Some(err) = child.stderr.take() {
        lines_of(err, tx);
    }
    let mut tail: Vec<String> = Vec::new();
    let read = async {
        while let Some(line) = rx.recv().await {
            heard(id, &line, &mut tail);
        }
        child.wait().await
    };
    let ended = tokio::time::timeout(Duration::from_secs(30 * 60), read).await;
    match ended {
        Ok(Ok(status)) => (status.success(), tail.join("\n")),
        Ok(Err(err)) => (false, format!("The installer stopped: {err}")),
        Err(_) => (false, "The installer took over half an hour".into()),
    }
}

/// Moves `id`'s job along by a line the installer printed, keeping the last
/// few that say something in `tail`.
fn heard(id: &str, line: &str, tail: &mut Vec<String>) {
    let line = line.trim();
    if line.is_empty() {
        return;
    }
    if let Some(job) = lock(&JOBS).get_mut(id) {
        job.feed(line);
    }
    if line.chars().any(char::is_alphanumeric) && progress(line).is_none() {
        tail.push(line.to_owned());
        if tail.len() > 6 {
            tail.remove(0);
        }
    }
}

/// Grants the helper below: see `helper::grant`.
#[cfg(windows)]
pub use helper::grant as grant_helper;

/// On Windows, winget run by the "myTunnels Apps" task: as the signed-in
/// account with its administrator rights, so installers never stop for the
/// admin prompt. `mytunnels grant` puts it in place once, at install.
#[cfg(windows)]
mod helper {
    use std::os::windows::process::CommandExt;
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    use anyhow::{bail, Context, Result};
    use tokio::process::Command;

    const SCRIPT: &str = include_str!("apps.ps1");
    const TASK: &str = "myTunnels Apps";
    const NO_WINDOW: u32 = 0x0800_0000;

    fn under(var: &str, fallback: &str) -> PathBuf {
        std::env::var_os(var)
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(fallback))
            .join("myTunnels")
            .join("apps")
    }

    /// Where the helper lives: Program Files, which only administrators may change.
    fn helper_dir() -> PathBuf {
        under("ProgramFiles", r"C:\Program Files")
    }

    /// Where myTunnels asks it, which only the account it runs as may write to.
    fn asks() -> PathBuf {
        under("ProgramData", r"C:\ProgramData")
    }

    /// Puts the helper in place for the account `sid`, which alone may start
    /// it. Run with administrator rights.
    pub fn grant(sid: &str) -> Result<()> {
        use crate::hardware::lock_down;
        let dir = helper_dir();
        lock_down(&dir, None)?;
        let script = dir.join("apps.ps1");
        std::fs::write(&script, SCRIPT)?;
        lock_down(&asks(), Some(sid))?;
        let file = script.with_extension("xml");
        // schtasks reads the task as UTF-16.
        let mut bytes = vec![0xFF, 0xFE];
        bytes.extend(
            task_xml(&script, sid)
                .encode_utf16()
                .flat_map(u16::to_le_bytes),
        );
        std::fs::write(&file, bytes)?;
        let made = std::process::Command::new("schtasks")
            .args([
                "/Create",
                "/TN",
                TASK,
                "/XML",
                &file.to_string_lossy(),
                "/F",
            ])
            .creation_flags(NO_WINDOW)
            .output();
        let _ = std::fs::remove_file(&file);
        let out = made.context("cannot run schtasks")?;
        if !out.status.success() {
            bail!(
                "the apps helper was not added: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
        Ok(())
    }

    /// Started on asking alone, as `sid` with its highest rights, which `sid`
    /// may start and nothing else may change.
    fn task_xml(script: &std::path::Path, sid: &str) -> String {
        let script = script
            .display()
            .to_string()
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;");
        format!(
            r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Installs the apps chosen in myTunnels, with no admin prompt.</Description>
    <SecurityDescriptor>D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;{sid})</SecurityDescriptor>
  </RegistrationInfo>
  <Principals><Principal id="Author"><UserId>{sid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>Queue</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT2H</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author"><Exec><Command>powershell.exe</Command><Arguments>-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{script}"</Arguments></Exec></Actions>
</Task>
"#
        )
    }

    /// Runs winget with `args` through the helper, moving `id`'s job along
    /// as it says each line. None when there is no helper here, so winget
    /// runs on its own.
    pub async fn run(id: &str, args: &[String]) -> Option<(bool, String)> {
        let dir = asks();
        if !helper_dir().join("apps.ps1").exists() || !dir.exists() {
            return None;
        }
        let job = crate::util::random_hex(8);
        let ask = dir.join(format!("{job}.json"));
        let log = dir.join(format!("{job}.log"));
        let exit = dir.join(format!("{job}.exit"));
        let clean = || {
            for f in [&ask, &log, &exit] {
                let _ = std::fs::remove_file(f);
            }
        };
        // Written whole, then named, so the helper never reads half of it.
        let part = ask.with_extension("part");
        let body = serde_json::to_string(args).ok()?;
        if std::fs::write(&part, body)
            .and_then(|()| std::fs::rename(&part, &ask))
            .is_err()
        {
            let _ = std::fs::remove_file(&part);
            return None;
        }
        let started = Command::new("schtasks")
            .args(["/Run", "/TN", TASK])
            .creation_flags(NO_WINDOW)
            .output()
            .await;
        if !started.is_ok_and(|o| o.status.success()) {
            clean();
            return Some((false, "The apps helper did not start".into()));
        }
        let began = Instant::now();
        let mut read = 0;
        let mut tail = Vec::new();
        let mut follow = |tail: &mut Vec<String>| {
            let Ok(bytes) = std::fs::read(&log) else {
                return;
            };
            // Whole lines only; the rest is read once it ends.
            let Some(end) = bytes.iter().rposition(|b| *b == b'\n').map(|e| e + 1) else {
                return;
            };
            if end > read {
                for line in String::from_utf8_lossy(&bytes[read..end]).split(['\n', '\r']) {
                    super::heard(id, line, tail);
                }
                read = end;
            }
        };
        while !exit.exists() {
            follow(&mut tail);
            if ask.exists() && began.elapsed() > Duration::from_secs(60) {
                clean();
                return Some((false, "The apps helper did not take the install".into()));
            }
            if began.elapsed() > Duration::from_secs(30 * 60) {
                clean();
                return Some((false, "The installer took over half an hour".into()));
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        follow(&mut tail);
        let code = std::fs::read_to_string(&exit).unwrap_or_default();
        clean();
        Some((code.trim() == "0", tail.join("\n")))
    }
}

/// Held while the package manager runs, so only one call runs at a time: on
/// a machine where winget has never run, calls at once each try to set up its
/// sources, and all of them fail.
static MANAGER: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static JOBS: LazyLock<Mutex<HashMap<String, Job>>> = LazyLock::new(Mutex::default);
/// What was last found installed, and when. It is answered with at once and
/// looked at again in the background once it is older than `FOUND_FOR`.
static FOUND: LazyLock<Mutex<Option<(Instant, Value)>>> = LazyLock::new(Mutex::default);
const FOUND_FOR: Duration = Duration::from_secs(30);
/// Set while a background look is running, so only one runs.
static LOOKING: AtomicBool = AtomicBool::new(false);

/// Asks every app its version, all at once, and keeps what it finds.
async fn detect() -> Value {
    let dirs = search_dirs();
    let m = manager(&dirs);
    let mut asking = tokio::task::JoinSet::new();
    for (i, a) in CATALOG.iter().enumerate() {
        let paths: Vec<PathBuf> = a.bins.iter().filter_map(|b| which(b, &dirs)).collect();
        asking.spawn(async move {
            for path in paths {
                if let Some(v) = version_of(&path, a.version).await {
                    return (i, Some(v));
                }
            }
            (i, None)
        });
    }
    let state = |a: &App, version: &Option<String>| {
        json!({
            "installed": version.is_some(),
            "version": version,
            "can": install_command(a, m, &dirs, Action::Install, None).is_some(),
        })
    };
    let mut found = vec![None; CATALOG.len()];
    while let Some(Ok((i, v))) = asking.join_next().await {
        // On the first look, each app shows as soon as it answers.
        if let Some((_, kept)) = lock(&FOUND).as_mut().filter(|f| f.1["checking"] == true) {
            kept["apps"][CATALOG[i].id] = state(&CATALOG[i], &v);
        }
        found[i] = v;
    }
    let mut apps = serde_json::Map::new();
    for (a, version) in CATALOG.iter().zip(found) {
        apps.insert(a.id.into(), state(a, &version));
    }
    let v = json!({ "os": os(), "manager": manager_name(m), "apps": apps });
    *lock(&FOUND) = Some((Instant::now(), v.clone()));
    v
}

/// This machine: which apps it has, and which it is installing. What was last
/// found is answered with straight away. The very first look answers with
/// nothing found yet and `checking` set; apps fill in as each answers.
pub async fn local_status() -> Value {
    let mut status = {
        let mut kept = lock(&FOUND);
        if kept
            .as_ref()
            .is_none_or(|(at, _)| at.elapsed() >= FOUND_FOR)
            && !LOOKING.swap(true, Ordering::Relaxed)
        {
            tokio::spawn(async {
                detect().await;
                LOOKING.store(false, Ordering::Relaxed);
            });
        }
        kept.get_or_insert_with(|| {
            let m = manager(&search_dirs());
            let v = json!({ "os": os(), "manager": manager_name(m), "apps": {}, "checking": true });
            (Instant::now(), v)
        })
        .1
        .clone()
    };
    for (id, job) in lock(&JOBS).iter() {
        status["apps"][id]["job"] = json!(job);
    }
    warm_versions();
    status
}

/// Installs `id` here and waits for it, for setup's one admin step: left
/// alone when it is here already.
pub fn install_now(id: &str) -> anyhow::Result<()> {
    use anyhow::{bail, Context};
    let a = find(id).context("no such app")?;
    let dirs = search_dirs();
    if a.bins.iter().any(|b| which(b, &dirs).is_some()) {
        return Ok(());
    }
    let (program, args) = install_command(a, manager(&dirs), &dirs, Action::Install, None)
        .with_context(|| format!("{} cannot be installed here; get it from {}", a.name, a.url))?;
    let out = std::process::Command::new(&program)
        .args(&args)
        .stdin(Stdio::null())
        .output()
        .with_context(|| format!("cannot run {}", program.display()))?;
    if !out.status.success() {
        let said = String::from_utf8_lossy(&out.stdout);
        let last = said
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("");
        bail!("{} did not install: {}", a.name, last.trim());
    }
    Ok(())
}

/// Starts installing `id` here; it carries on after the call returns.
pub fn local_install(id: &str, action: Action, version: Option<&str>) -> Result<(), String> {
    let a = find(id).ok_or("No such app")?;
    if version.is_some_and(|v| !valid_version(v)) {
        return Err("That is not a version".into());
    }
    if let Some(j) = lock(&JOBS).get(id).filter(|j| j.running) {
        return Err(format!("{} is being {} already", a.name, j.action.doing()));
    }
    let dirs = search_dirs();
    let (program, args) =
        install_command(a, manager(&dirs), &dirs, action, version).ok_or_else(|| match a.npm {
            Some(_) => "Install Node.js first, for npm".to_owned(),
            None => format!("{} cannot be installed here; get it from {}", a.name, a.url),
        })?;
    lock(&JOBS).insert(
        id.into(),
        Job {
            action,
            running: true,
            failed: false,
            log: String::new(),
            stage: Stage::Preparing,
            percent: None,
        },
    );
    let id = id.to_owned();
    tokio::spawn(async move {
        tracing::info!("installing {id}: {} {}", program.display(), args.join(" "));
        let (worked, log) = run_installer(&id, &program, &args).await;
        if !worked {
            tracing::warn!("installing {id} failed: {log}");
        }
        if let Some(job) = lock(&JOBS).get_mut(&id) {
            job.stage = Stage::Checking;
            job.percent = None;
        }
        detect().await;
        if let Some(job) = lock(&JOBS).get_mut(&id) {
            job.running = false;
            job.failed = !worked;
            job.log = log;
        }
    });
    Ok(())
}

/// A version as package managers write them: `2.52.0`, `1:2.39.5-0+deb12u2`.
fn valid_version(v: &str) -> bool {
    (1..=64).contains(&v.len())
        && v.as_bytes()[0].is_ascii_alphanumeric()
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-+_~:".contains(&b))
}

/// Each app's versions, the newest first, kept for an hour: new ones come out
/// rarely, and asking takes most of a second.
type Kept = HashMap<String, (Instant, Vec<String>)>;
static VERSIONS: LazyLock<Mutex<Kept>> = LazyLock::new(Mutex::default);
const VERSIONS_FOR: Duration = Duration::from_secs(3600);
/// When the versions of every app were last looked up ahead of being asked.
static WARMED: LazyLock<Mutex<Option<Instant>>> = LazyLock::new(Mutex::default);

/// What a program printed, if it ran and ended well.
async fn output(program: &FsPath, args: &[&str]) -> Option<String> {
    let run = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output();
    let out = tokio::time::timeout(Duration::from_secs(60), run)
        .await
        .ok()?
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The versions this machine's package manager offers for `a`, the newest
/// first. Homebrew offers only its latest.
async fn lookup_versions(a: &App, m: Option<Manager>, dirs: &[PathBuf]) -> Vec<String> {
    let found = if let Some(pkg) = a.npm {
        let Some(npm) = which("npm", dirs) else {
            return Vec::new();
        };
        let text = output(&npm, &["view", pkg, "versions", "--json"]).await;
        let mut list: Vec<String> = text
            .and_then(|t| serde_json::from_str::<Vec<String>>(&t).ok())
            .unwrap_or_default();
        list.reverse();
        list
    } else {
        match (m, a.winget, a.apt) {
            (Some(Manager::Winget), Some(id), _) => {
                let Some(winget) = which("winget", dirs) else {
                    return Vec::new();
                };
                let args = [
                    "show",
                    "--source",
                    "winget",
                    "--id",
                    id,
                    "--exact",
                    "--versions",
                    "--accept-source-agreements",
                    "--disable-interactivity",
                ];
                let _one = MANAGER.lock().await;
                output(&winget, &args)
                    .await
                    .map(|t| winget_versions(&t))
                    .unwrap_or_default()
            }
            (Some(Manager::Apt), _, Some(pkg)) => {
                let Some(cache) = which("apt-cache", dirs) else {
                    return Vec::new();
                };
                output(&cache, &["madison", pkg])
                    .await
                    .map(|t| {
                        t.lines()
                            .filter_map(|l| l.split('|').nth(1))
                            .map(|v| v.trim().to_owned())
                            .collect()
                    })
                    .unwrap_or_default()
            }
            _ => Vec::new(),
        }
    };
    found.into_iter().filter(|v| valid_version(v)).collect()
}

/// The versions in `winget show --versions`: one a line, under the dashes.
fn winget_versions(text: &str) -> Vec<String> {
    text.lines()
        .skip_while(|l| !l.trim_start().starts_with("---"))
        .skip(1)
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect()
}

/// `id`'s versions, from what was kept or asked for now.
pub async fn local_versions(id: &str) -> Result<Vec<String>, String> {
    let a = find(id).ok_or("No such app")?;
    let kept = lock(&VERSIONS)
        .get(id)
        .filter(|(at, _)| at.elapsed() < VERSIONS_FOR)
        .map(|(_, v)| v.clone());
    if let Some(list) = kept {
        return Ok(list);
    }
    let dirs = search_dirs();
    let list = lookup_versions(a, manager(&dirs), &dirs).await;
    lock(&VERSIONS).insert(id.into(), (Instant::now(), list.clone()));
    Ok(list)
}

/// Looks up every app's versions in the background, a few at a time, once an
/// hour at most, so a version list is there before it is opened.
fn warm_versions() {
    {
        let mut warmed = lock(&WARMED);
        if warmed.is_some_and(|at| at.elapsed() < VERSIONS_FOR) {
            return;
        }
        *warmed = Some(Instant::now());
    }
    tokio::spawn(async {
        for chunk in CATALOG.chunks(4) {
            let mut set = tokio::task::JoinSet::new();
            for a in chunk {
                set.spawn(async move { local_versions(a.id).await });
            }
            while set.join_next().await.is_some() {}
        }
    });
}

// ---- `server host`: the machine, for a myTunnels inside Docker ----

/// Where `server host` keeps the hash of the key it was paired with.
fn paired_file() -> PathBuf {
    crate::config::home().join("paired")
}

/// The calls `server host` answers besides its figures.
pub fn host_routes() -> Router {
    Router::new()
        .route("/apps", get(|| async { Json(local_status().await) }))
        .route("/pair", post(pair))
        .route(
            "/apps/{id}/versions",
            get(|Path(id): Path<String>| async move {
                local_versions(&id)
                    .await
                    .map(Json)
                    .map_err(|e| (StatusCode::NOT_FOUND, e))
            }),
        )
        .route("/apps/{id}/{action}", post(host_install))
}

/// Gives the first myTunnels to ask the key installs need; later asks are
/// refused until the pairing file is removed.
async fn pair() -> Result<Json<Value>, (StatusCode, String)> {
    let file = paired_file();
    if file.exists() {
        return Err((
            StatusCode::CONFLICT,
            format!(
                "Paired already. Remove {} on the host to pair again.",
                file.display()
            ),
        ));
    }
    let key = random_hex(32);
    let saved = file
        .parent()
        .map(std::fs::create_dir_all)
        .unwrap_or(Ok(()))
        .and_then(|()| std::fs::write(&file, sha256_hex(&key)));
    saved.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Could not keep the pairing: {e}"),
        )
    })?;
    tracing::info!("paired with myTunnels");
    Ok(Json(json!({ "key": key })))
}

/// What an install may ask for: a version, in place of the latest.
#[derive(Default, Deserialize, Serialize)]
pub struct ActionBody {
    #[serde(default)]
    version: Option<String>,
}

impl ActionBody {
    fn of(body: &[u8]) -> Self {
        serde_json::from_slice(body).unwrap_or_default()
    }
}

async fn host_install(
    Path((id, action)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>, (StatusCode, String)> {
    let action = Action::parse(&action).ok_or((StatusCode::NOT_FOUND, "No such action".into()))?;
    let held = std::fs::read_to_string(paired_file()).unwrap_or_default();
    let given = headers
        .get(KEY_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(sha256_hex)
        .unwrap_or_default();
    if held.trim().is_empty() || held.trim() != given {
        return Err((StatusCode::UNAUTHORIZED, "Not paired with this host".into()));
    }
    let body = ActionBody::of(&body);
    local_install(&id, action, body.version.as_deref())
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    Ok(Json(json!({ "ok": true })))
}

const KEY_HEADER: &str = "x-host-key";
const KEY_SETTING: &str = "host_key";

// ---- the panel's calls ----

/// The host's `server host`, when myTunnels runs inside Docker.
fn host_url() -> Option<String> {
    std::env::var("HOST_URL")
        .ok()
        .filter(|u| !u.is_empty())
        .map(|u| u.trim_end_matches('/').to_owned())
}

/// The catalog, with what the host has and can install.
pub async fn list(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    // An older `server host` answers, with its figures, but has no apps.
    let mut outdated = false;
    let host = match host_url() {
        Some(url) => {
            let got = state
                .http
                .get(format!("{url}/apps"))
                .timeout(Duration::from_secs(60))
                .send()
                .await;
            match got {
                Ok(r) if r.status().is_success() => r.json::<Value>().await.ok(),
                Ok(r) => {
                    outdated = r.status() == StatusCode::NOT_FOUND;
                    None
                }
                Err(_) => None,
            }
        }
        None => Some(local_status().await),
    };
    Ok(Json(json!({
        "catalog": CATALOG,
        "host": host,
        "remote": host_url().is_some(),
        "outdated": outdated,
    })))
}

/// An app's versions, the newest first.
pub async fn versions(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<String>>> {
    let app = find(&id).ok_or_else(ApiError::not_found)?;
    let Some(url) = host_url() else {
        return local_versions(app.id)
            .await
            .map(Json)
            .map_err(ApiError::bad);
    };
    let r = state
        .http
        .get(format!("{url}/apps/{}/versions", app.id))
        .timeout(Duration::from_secs(90))
        .send()
        .await
        .map_err(|_| {
            ApiError(
                StatusCode::BAD_GATEWAY,
                "server host is not answering".into(),
            )
        })?;
    if r.status() == StatusCode::NOT_FOUND
        && r.headers().get("content-length").is_some_and(|l| l == "0")
    {
        return Err(ApiError::bad(
            "The running server host is an older version, which cannot list versions",
        ));
    }
    if !r.status().is_success() {
        return Err(ApiError::bad(r.text().await.unwrap_or_default()));
    }
    Ok(Json(r.json().await.unwrap_or_default()))
}

/// Installs, updates or uninstalls an app on the host; an install may name a
/// version.
pub async fn install(
    State(state): State<AppState>,
    Path((id, word)): Path<(String, String)>,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    let app = find(&id).ok_or_else(ApiError::not_found)?;
    let action = Action::parse(&word).ok_or_else(ApiError::not_found)?;
    let body = ActionBody::of(&body);
    let Some(url) = host_url() else {
        local_install(app.id, action, body.version.as_deref()).map_err(ApiError::bad)?;
        return Ok(Json(json!({ "ok": true })));
    };
    let unreachable = |_| {
        ApiError(
            StatusCode::BAD_GATEWAY,
            "The host is not answering. Start `server host` on it.".into(),
        )
    };
    let key = match state.db.setting(KEY_SETTING)? {
        Some(key) => key,
        None => {
            let r = state
                .http
                .post(format!("{url}/pair"))
                .send()
                .await
                .map_err(unreachable)?;
            if !r.status().is_success() {
                return Err(ApiError::bad(r.text().await.unwrap_or_default()));
            }
            let key = r.json::<Value>().await.map_err(unreachable)?["key"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            state.db.set_setting(KEY_SETTING, &key)?;
            key
        }
    };
    let r = state
        .http
        .post(format!("{url}/apps/{}/{word}", app.id))
        .header(KEY_HEADER, key)
        .json(&body)
        .send()
        .await
        .map_err(unreachable)?;
    if !r.status().is_success() {
        return Err(ApiError::bad(r.text().await.unwrap_or_default()));
    }
    Ok(Json(json!({ "ok": true })))
}

/// What features need where myTunnels runs, and whether it is there.
static NEEDS: LazyLock<Mutex<Option<(Instant, Value)>>> = LazyLock::new(Mutex::default);

pub async fn needs(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let cached = lock(&NEEDS)
        .as_ref()
        .filter(|(at, _)| at.elapsed() < FOUND_FOR)
        .map(|(_, v)| v.clone());
    if let Some(v) = cached {
        return Ok(Json(v));
    }
    let runs = |bin: String, args: &'static [&'static str]| async move {
        let run = Command::new(bin)
            .args(args)
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output();
        matches!(
            tokio::time::timeout(Duration::from_secs(5), run).await,
            Ok(Ok(out)) if out.status.success()
        )
    };
    let docker = docker::call(
        &Endpoint::from_env(),
        hyper::Method::GET,
        "/_ping",
        Duration::from_secs(3),
    )
    .await
    .is_ok();
    let v = json!({
        "docker": docker,
        // Installed, though its engine may not be running yet.
        "docker_installed": docker || locate("docker").is_some(),
        "git": runs("git".into(), V).await,
        "cloudflared": runs(state.config.cloudflared_bin.clone(), V).await,
        "tailscale": match locate("tailscale") {
            Some(bin) => runs(bin.to_string_lossy().into_owned(), &["version"]).await,
            None => false,
        },
    });
    *lock(&NEEDS) = Some((Instant::now(), v.clone()));
    Ok(Json(v))
}

/// Starts Docker's engine on this computer, for one installed but not running:
/// Docker Desktop on Windows and macOS, the system service elsewhere.
pub async fn start_docker() -> ApiResult<Json<Value>> {
    let started = if cfg!(windows) {
        let app = std::env::var_os("ProgramFiles")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Program Files"))
            .join(r"Docker\Docker\Docker Desktop.exe");
        if !app.is_file() {
            return Err(ApiError::bad("Docker Desktop is not in Program Files"));
        }
        // Through Explorer, so it is not under myTunnels and outlives its restarts.
        Command::new("explorer.exe")
            .arg(app)
            .status()
            .await
            .map(drop)
    } else if cfg!(target_os = "macos") {
        Command::new("open")
            .args(["-a", "Docker"])
            .status()
            .await
            .map(drop)
    } else {
        Command::new("systemctl")
            .args(["start", "docker"])
            .status()
            .await
            .map(drop)
    };
    started.map_err(|e| ApiError::bad(format!("Docker did not start: {e}")))?;
    // Asked again on the next look, as the engine takes a moment.
    *lock(&NEEDS) = None;
    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_app_can_be_had_somehow() {
        for a in CATALOG {
            assert!(
                a.npm.is_some() || a.winget.is_some() || a.brew.is_some() || a.apt.is_some(),
                "{}",
                a.id
            );
            assert!(a.url.starts_with("https://"), "{}", a.id);
            assert!(!a.bins.is_empty(), "{}", a.id);
        }
        let ids: Vec<&str> = CATALOG.iter().map(|a| a.id).collect();
        let mut unique = ids.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(ids.len(), unique.len());
    }

    #[test]
    fn versions_are_read_from_winget() {
        let text = "Found Git [Git.Git]\nVersion\n-------\n2.52.0\n2.51.2\n\n";
        assert_eq!(winget_versions(text), ["2.52.0", "2.51.2"]);
        assert!(valid_version("1:2.39.5-0+deb12u2"));
        assert!(!valid_version("--force"));
        assert!(!valid_version("1.0 && x"));
    }

    #[test]
    fn an_install_moves_forward_by_what_it_prints() {
        let mut job = Job {
            action: Action::Update,
            running: true,
            failed: false,
            log: String::new(),
            stage: Stage::Preparing,
            percent: None,
        };
        job.feed("Found cloudflared [Cloudflare.cloudflared] Version 2025.11.1");
        assert!(job.stage == Stage::Preparing);
        job.feed("Downloading https://example.test/cloudflared.msi");
        assert!(job.stage == Stage::Downloading);
        job.feed("  ██████████▒▒▒▒▒▒▒▒▒▒  10.0 MB / 20.0 MB");
        assert_eq!(job.percent, Some(50));
        job.feed("  ████████████████▒▒▒▒  80%");
        assert_eq!(job.percent, Some(80));
        job.feed("Starting package install...");
        assert!(job.stage == Stage::Installing);
        assert_eq!(job.percent, None);
        job.feed("==> Downloading https://example.test/again");
        assert!(job.stage == Stage::Installing);
        assert_eq!(job.log, "==> Downloading https://example.test/again");
        assert_eq!(progress("Successfully installed"), None);
    }

    #[test]
    fn variables_in_saved_paths_are_filled_in() {
        let var = |n: &str| (n == "HOME").then(|| "/home/kim".to_owned());
        assert_eq!(expand("%HOME%/bin", var), "/home/kim/bin");
        assert_eq!(expand("%NONE%x", var), "x");
        assert_eq!(expand("plain", var), "plain");
    }
}
