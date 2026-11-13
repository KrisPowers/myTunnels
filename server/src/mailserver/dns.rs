//! DNS lookups for mail: MX for delivery, TXT for SPF, DKIM and DMARC.

use std::net::IpAddr;
use std::sync::LazyLock;

use hickory_resolver::config::{ResolverConfig, CLOUDFLARE};
use hickory_resolver::net::runtime::TokioRuntimeProvider;
use hickory_resolver::proto::rr::RData;
use hickory_resolver::{Resolver, TokioResolver};

/// Why a lookup gave nothing.
#[derive(Debug, PartialEq)]
pub enum Miss {
    /// The name or the record does not exist.
    None,
    /// The lookup failed; it may work later.
    Failed,
}

static RESOLVER: LazyLock<Option<TokioResolver>> = LazyLock::new(|| {
    // The system's own servers, or Cloudflare's when they cannot be read.
    TokioResolver::builder_tokio()
        .ok()
        .and_then(|b| b.build().ok())
        .or_else(|| {
            Resolver::builder_with_config(
                ResolverConfig::udp_and_tcp(&CLOUDFLARE),
                TokioRuntimeProvider::default(),
            )
            .build()
            .ok()
        })
});

fn fqdn(name: &str) -> String {
    format!("{}.", name.trim_end_matches('.'))
}

fn miss(err: &hickory_resolver::net::NetError) -> Miss {
    if err.is_no_records_found() || err.is_nx_domain() {
        Miss::None
    } else {
        Miss::Failed
    }
}

pub async fn txt(name: &str) -> Result<Vec<String>, Miss> {
    let r = RESOLVER.as_ref().ok_or(Miss::Failed)?;
    let found = r.txt_lookup(fqdn(name)).await.map_err(|e| miss(&e))?;
    Ok(found
        .answers()
        .iter()
        .filter_map(|rec| match &rec.data {
            RData::TXT(t) => Some(
                t.txt_data
                    .iter()
                    .map(|s| String::from_utf8_lossy(s).into_owned())
                    .collect::<String>(),
            ),
            _ => None,
        })
        .collect())
}

/// MX hosts by preference, without the trailing dot.
pub async fn mx(name: &str) -> Result<Vec<(u16, String)>, Miss> {
    let r = RESOLVER.as_ref().ok_or(Miss::Failed)?;
    let found = r.mx_lookup(fqdn(name)).await.map_err(|e| miss(&e))?;
    let mut hosts: Vec<(u16, String)> = found
        .answers()
        .iter()
        .filter_map(|rec| match &rec.data {
            RData::MX(m) => Some((
                m.preference,
                m.exchange.to_ascii().trim_end_matches('.').to_owned(),
            )),
            _ => None,
        })
        .collect();
    hosts.sort_by_key(|h| h.0);
    Ok(hosts)
}

pub async fn ips(name: &str) -> Result<Vec<IpAddr>, Miss> {
    let r = RESOLVER.as_ref().ok_or(Miss::Failed)?;
    let found = r.lookup_ip(fqdn(name)).await.map_err(|e| miss(&e))?;
    Ok(found.iter().collect())
}
