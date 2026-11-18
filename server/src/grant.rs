//! `mytunnels grant <account> [hardware] [firewall]`, which setup runs once
//! with administrator rights, so what would ask for them later is in place
//! from the start: `hardware` the sensor task behind the Dashboard's
//! Advanced view, `firewall` the helper that opens router ports on this
//! computer with no prompt. `<account>` is the SID of the account myTunnels
//! runs as, the one the helper takes asks from.
//!
//! What fails is written to `grant.txt` in myTunnels' Program Files folder,
//! for setup to show.

use anyhow::{bail, Result};

const USE: &str = "use: mytunnels grant <account SID> [hardware] [firewall]";

pub async fn command(args: &[String]) -> Result<()> {
    let result = grant(args).await;
    #[cfg(windows)]
    {
        let dir = std::env::var_os("ProgramFiles")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| r"C:\Program Files".into())
            .join("myTunnels");
        let said = match &result {
            Ok(()) => "done\n".to_owned(),
            Err(err) => format!("failed: {err:#}\n"),
        };
        if std::fs::create_dir_all(&dir).is_ok() {
            let _ = std::fs::write(dir.join("grant.txt"), said);
        }
    }
    result
}

async fn grant(args: &[String]) -> Result<()> {
    let Some((sid, wants)) = args.split_first() else {
        bail!(USE)
    };
    let digits = sid.strip_prefix("S-1-").unwrap_or_default();
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit() || c == '-') {
        bail!(USE);
    }
    for want in wants {
        match want.as_str() {
            "hardware" => crate::hardware::command(Some("on")).await?,
            #[cfg(windows)]
            "firewall" => crate::machine::grant_firewall(sid)?,
            #[cfg(not(windows))]
            "firewall" => bail!("only Windows needs this step"),
            other => bail!("cannot grant {other}; {USE}"),
        }
    }
    Ok(())
}
