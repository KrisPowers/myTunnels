//! `mytunnels grant <account> [hardware] [firewall] [apps] [drives] [docker] [tailscale]`,
//! which setup runs once with administrator rights, so what would ask for
//! them later is in place from the start: `hardware` the sensor task behind
//! the Dashboard's Advanced view, `firewall` the helper that opens router
//! ports on this computer with no prompt, `apps` the helper that installs
//! Apps' catalog with no prompt, `drives` the helper that makes Storage's
//! drives with no prompt, and `docker` and `tailscale` those
//! apps, which Services and private routes run on. `<account>` is the SID of
//! the account myTunnels runs as, the one the firewall helper takes asks from.
//!
//! Each is done in turn; one that fails does not stop the rest.
//!
//! `grant.txt` in myTunnels' Program Files folder says, for setup to show,
//! what it is doing (`doing <n> <of> <what>`), then `done` or `failed: why`.

use anyhow::{bail, Result};

const USE: &str =
    "use: mytunnels grant <account SID> [hardware] [firewall] [apps] [drives] [docker] [tailscale]";

pub async fn command(args: &[String]) -> Result<()> {
    let result = grant(args).await;
    say(&match &result {
        Ok(()) => "done".to_owned(),
        Err(err) => format!("failed: {err:#}"),
    });
    result
}

/// Whether this computer still needs the one admin step for router ports,
/// app installs and drives: on Windows, until every helper is in place.
pub fn missing() -> bool {
    if !cfg!(windows) {
        return false;
    }
    let dir = std::env::var_os("ProgramFiles")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| r"C:\Program Files".into())
        .join("myTunnels");
    ![
        r"firewall\program.txt",
        r"apps\apps.ps1",
        r"drives\drives.ps1",
    ]
    .iter()
    .all(|f| dir.join(f).is_file())
}

/// Whether the helpers are in place. They are put there by the one yes
/// Windows gets when myTunnels is installed; nothing asks for it after.
pub async fn ensure() -> Result<()> {
    if missing() {
        bail!(
            "This computer was installed before myTunnels took its one yes at install. \
             Run the install command on it once"
        );
    }
    Ok(())
}

/// Writes where it is up to, for setup.
fn say(text: &str) {
    #[cfg(windows)]
    {
        let dir = std::env::var_os("ProgramFiles")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| r"C:\Program Files".into())
            .join("myTunnels");
        if std::fs::create_dir_all(&dir).is_ok() {
            let _ = std::fs::write(dir.join("grant.txt"), format!("{text}\n"));
        }
    }
    #[cfg(not(windows))]
    let _ = text;
}

async fn grant(args: &[String]) -> Result<()> {
    let Some((sid, wants)) = args.split_first() else {
        bail!(USE)
    };
    let digits = sid.strip_prefix("S-1-").unwrap_or_default();
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit() || c == '-') {
        bail!(USE);
    }
    let mut failed = Vec::new();
    for (i, want) in wants.iter().enumerate() {
        say(&format!("doing {} {} {want}", i + 1, wants.len()));
        let done = match want.as_str() {
            "hardware" => crate::hardware::command(Some("on")).await,
            #[cfg(windows)]
            "firewall" => crate::machine::grant_firewall(sid),
            #[cfg(not(windows))]
            "firewall" => Err(anyhow::anyhow!("only Windows needs this step")),
            #[cfg(windows)]
            "apps" => crate::apps::grant_helper(sid),
            #[cfg(windows)]
            "drives" => crate::locations::grant_helper(sid),
            #[cfg(not(windows))]
            "apps" | "drives" => Err(anyhow::anyhow!("only Windows needs this step")),
            "docker" | "tailscale" => {
                let id = want.clone();
                tokio::task::spawn_blocking(move || crate::apps::install_now(&id))
                    .await
                    .map_err(anyhow::Error::from)
                    .and_then(|done| done)
            }
            other => Err(anyhow::anyhow!("cannot grant {other}; {USE}")),
        };
        if let Err(err) = done {
            failed.push(format!("{err:#}"));
        }
    }
    if !failed.is_empty() {
        bail!("{}", failed.join("; "));
    }
    Ok(())
}
