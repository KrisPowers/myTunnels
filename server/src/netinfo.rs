use std::net::IpAddr;
use std::time::Duration;

use anyhow::{Context, Result};

use crate::state::AppState;

const TRACE_URLS: [&str; 2] = [
    "https://1.1.1.1/cdn-cgi/trace",
    "https://[2606:4700:4700::1111]/cdn-cgi/trace",
];

/// An IP network such as `192.168.1.0/24`, or a single address.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Cidr {
    addr: IpAddr,
    prefix: u32,
}

impl Cidr {
    pub fn parse(text: &str) -> Option<Self> {
        let (addr, prefix) = text.trim().split_once('/').unwrap_or((text.trim(), ""));
        let addr: IpAddr = addr.parse().ok()?;
        let max = if addr.is_ipv4() { 32 } else { 128 };
        let prefix = if prefix.is_empty() {
            max
        } else {
            prefix.parse().ok()?
        };
        (prefix <= max).then_some(Self { addr, prefix })
    }

    pub fn contains(&self, ip: IpAddr) -> bool {
        match (self.addr, ip.to_canonical()) {
            (IpAddr::V4(net), IpAddr::V4(ip)) => {
                same_prefix(u32::from(net).into(), u32::from(ip).into(), 32, self.prefix)
            }
            (IpAddr::V6(net), IpAddr::V6(ip)) => {
                same_prefix(u128::from(net), u128::from(ip), 128, self.prefix)
            }
            _ => false,
        }
    }
}

fn same_prefix(a: u128, b: u128, bits: u32, prefix: u32) -> bool {
    let shift = bits - prefix;
    shift >= bits || (a >> shift) == (b >> shift)
}

/// Parses a comma, space or newline separated list of networks.
pub fn parse_networks(text: &str) -> Result<Vec<Cidr>, String> {
    text.split(|c: char| c == ',' || c.is_whitespace())
        .filter(|entry| !entry.is_empty())
        .map(|entry| Cidr::parse(entry).ok_or_else(|| entry.to_owned()))
        .collect()
}

/// True when `ip` leaves the internet from the same place this host does:
/// the same public IPv4 address or the same IPv6 /64.
pub fn same_network(public: &[IpAddr], ip: IpAddr) -> bool {
    let ip = ip.to_canonical();
    public.iter().any(|own| match (own, ip) {
        (IpAddr::V4(own), IpAddr::V4(ip)) => *own == ip,
        (IpAddr::V6(own), IpAddr::V6(ip)) => (u128::from(*own) >> 64) == (u128::from(ip) >> 64),
        _ => false,
    })
}

/// Finds where local ports live, as seen from here. The configured host is kept
/// when it resolves, as host.docker.internal does under Docker Desktop and with
/// compose's host-gateway mapping. Otherwise, inside a container, the default
/// gateway is the Docker host; and outside one, ports are on this machine.
pub async fn detect_upstream(configured: &str) -> String {
    if configured.parse::<IpAddr>().is_ok()
        || tokio::net::lookup_host((configured, 80)).await.is_ok()
    {
        return configured.to_owned();
    }
    let gateway = std::fs::read_to_string("/proc/net/route")
        .ok()
        .and_then(|table| default_gateway(&table));
    let found = gateway.map_or_else(|| "127.0.0.1".to_owned(), |ip| ip.to_string());
    tracing::info!("{configured} does not resolve, sending tunnels to {found}");
    found
}

/// The default route's gateway from a Linux routing table (/proc/net/route).
fn default_gateway(table: &str) -> Option<std::net::Ipv4Addr> {
    table.lines().skip(1).find_map(|line| {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.get(1) != Some(&"00000000") {
            return None;
        }
        let raw = u32::from_str_radix(cols.get(2)?, 16).ok()?;
        Some(std::net::Ipv4Addr::from(raw.to_le_bytes()))
    })
}

/// Keeps the host's public addresses current so "same network" checks stay correct.
pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        loop {
            let mut found = Vec::new();
            for url in TRACE_URLS {
                match trace(&state.http, url).await {
                    Ok(ip) => found.push(ip),
                    Err(err) => tracing::debug!("public address lookup via {url} failed: {err:#}"),
                }
            }
            if !found.is_empty() {
                *state.public_ips.write().unwrap_or_else(|e| e.into_inner()) = found;
            }
            tokio::time::sleep(Duration::from_secs(300)).await;
        }
    });
}

async fn trace(http: &reqwest::Client, url: &str) -> Result<IpAddr> {
    let body = http
        .get(url)
        .timeout(Duration::from_secs(5))
        .send()
        .await?
        .text()
        .await?;
    body.lines()
        .find_map(|line| line.strip_prefix("ip="))
        .and_then(|ip| ip.trim().parse().ok())
        .context("no address in trace response")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn cidr_matches_inside_and_rejects_outside() {
        let net = Cidr::parse("192.168.1.0/24").unwrap();
        assert!(net.contains(ip("192.168.1.42")));
        assert!(!net.contains(ip("192.168.2.1")));
        assert!(!net.contains(ip("fd00::1")));
    }

    #[test]
    fn cidr_handles_edges() {
        assert!(Cidr::parse("0.0.0.0/0").unwrap().contains(ip("8.8.8.8")));
        assert!(Cidr::parse("10.0.0.5").unwrap().contains(ip("10.0.0.5")));
        assert!(!Cidr::parse("10.0.0.5").unwrap().contains(ip("10.0.0.6")));
        assert!(Cidr::parse("fd00::/8").unwrap().contains(ip("fd12::1")));
        assert!(Cidr::parse("10.0.0.0/33").is_none());
        assert!(Cidr::parse("nope").is_none());
    }

    #[test]
    fn mapped_ipv4_is_treated_as_ipv4() {
        let net = Cidr::parse("203.0.113.0/24").unwrap();
        assert!(net.contains(ip("::ffff:203.0.113.9")));
    }

    #[test]
    fn same_network_uses_v4_address_and_v6_prefix() {
        let public = [ip("203.0.113.7"), ip("2001:db8:1:2::10")];
        assert!(same_network(&public, ip("203.0.113.7")));
        assert!(!same_network(&public, ip("203.0.113.8")));
        assert!(same_network(&public, ip("2001:db8:1:2:abcd::1")));
        assert!(!same_network(&public, ip("2001:db8:1:3::1")));
    }

    #[test]
    fn parse_networks_reports_bad_entries() {
        assert_eq!(
            parse_networks("10.0.0.0/8, 192.168.0.0/16\n")
                .unwrap()
                .len(),
            2
        );
        assert_eq!(parse_networks("10.0.0.0/8 junk"), Err("junk".to_owned()));
    }
}
