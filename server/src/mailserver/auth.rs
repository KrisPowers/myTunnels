//! SPF (RFC 7208), DKIM (RFC 6376) and DMARC (RFC 7489) for mail that comes
//! in, and DKIM signatures for mail that goes out.

use std::future::Future;
use std::net::IpAddr;
use std::pin::Pin;

use anyhow::Result;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use rsa::pkcs1v15::Pkcs1v15Sign;
use rsa::pkcs8::{DecodePublicKey, EncodePublicKey};
use rsa::traits::PublicKeyParts;
use rsa::{RsaPrivateKey, RsaPublicKey};
use sha2::{Digest, Sha256};

use super::dns::{self, Miss};
use super::message::{self, Field};
use crate::util::now;

// ---- SPF ----

fn valid_domain(d: &str) -> bool {
    !d.is_empty()
        && d.len() <= 253
        && d.contains('.')
        && d.split('.').all(|l| !l.is_empty() && l.len() <= 63)
}

struct Spf {
    ip: IpAddr,
    sender: String,
    helo: String,
    lookups: u32,
    voids: u32,
}

/// The SPF result for mail from `ip` with MAIL FROM `sender`, and the
/// domain checked.
pub async fn spf(ip: IpAddr, sender: &str, helo: &str) -> (&'static str, String) {
    let sender = if sender.contains('@') {
        sender.to_owned()
    } else {
        format!("postmaster@{helo}")
    };
    let domain = sender
        .rsplit_once('@')
        .map_or("", |(_, d)| d)
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let mut c = Spf {
        ip,
        sender,
        helo: helo.to_owned(),
        lookups: 0,
        voids: 0,
    };
    (c.check(domain.clone(), 0).await, domain)
}

type Boxed<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

impl Spf {
    fn count(&mut self) -> bool {
        self.lookups += 1;
        self.lookups <= 10
    }

    /// False once too many lookups found nothing.
    fn void(&mut self, found: usize) -> bool {
        if found == 0 {
            self.voids += 1;
        }
        self.voids <= 2
    }

    fn check(&mut self, domain: String, depth: u32) -> Boxed<'_, &'static str> {
        Box::pin(async move {
            if depth > 10 {
                return "permerror";
            }
            if !valid_domain(&domain) {
                return "none";
            }
            let txts = match dns::txt(&domain).await {
                Ok(t) => t,
                Err(Miss::None) => return "none",
                Err(Miss::Failed) => return "temperror",
            };
            let records: Vec<&String> = txts
                .iter()
                .filter(|t| {
                    let l = t.to_ascii_lowercase();
                    l == "v=spf1" || l.starts_with("v=spf1 ")
                })
                .collect();
            let record = match records.as_slice() {
                [] => return "none",
                [one] => (*one).clone(),
                _ => return "permerror",
            };
            let mut redirect = None;
            for term in record.split_whitespace().skip(1) {
                if let Some(eq) = term.find('=') {
                    if !term[..eq].contains([':', '/']) {
                        if term[..eq].eq_ignore_ascii_case("redirect") {
                            redirect = Some(term[eq + 1..].to_owned());
                        }
                        continue;
                    }
                }
                let (qual, term) = match term.as_bytes()[0] {
                    b'+' => ("pass", &term[1..]),
                    b'-' => ("fail", &term[1..]),
                    b'~' => ("softfail", &term[1..]),
                    b'?' => ("neutral", &term[1..]),
                    _ => ("pass", term),
                };
                match self.mechanism(&domain, term, depth).await {
                    Err(result) => return result,
                    Ok(true) => return qual,
                    Ok(false) => {}
                }
            }
            if let Some(target) = redirect {
                if !self.count() {
                    return "permerror";
                }
                let Some(target) = self.expand(&target, &domain) else {
                    return "permerror";
                };
                return match self.check(target, depth + 1).await {
                    "none" => "permerror",
                    r => r,
                };
            }
            "neutral"
        })
    }

    async fn mechanism(
        &mut self,
        domain: &str,
        term: &str,
        depth: u32,
    ) -> Result<bool, &'static str> {
        let (name, arg) = match term.find([':', '/']) {
            Some(i) => (&term[..i], &term[i..]),
            None => (term, ""),
        };
        match name.to_ascii_lowercase().as_str() {
            "all" => Ok(true),
            "include" => {
                if !self.count() {
                    return Err("permerror");
                }
                let target = self
                    .expand(arg.trim_start_matches(':'), domain)
                    .filter(|t| !t.is_empty())
                    .ok_or("permerror")?;
                match self.check(target, depth + 1).await {
                    "pass" => Ok(true),
                    "temperror" => Err("temperror"),
                    "permerror" | "none" => Err("permerror"),
                    _ => Ok(false),
                }
            }
            kind @ ("a" | "mx") => {
                if !self.count() {
                    return Err("permerror");
                }
                let (target, c4, c6) = self.domain_cidr(arg, domain).ok_or("permerror")?;
                let hosts = if kind == "mx" {
                    let mxs = match dns::mx(&target).await {
                        Ok(m) => m,
                        Err(Miss::None) => Vec::new(),
                        Err(Miss::Failed) => return Err("temperror"),
                    };
                    if !self.void(mxs.len()) || mxs.len() > 10 {
                        return Err("permerror");
                    }
                    mxs.into_iter().map(|m| m.1).collect()
                } else {
                    vec![target]
                };
                for h in hosts {
                    let ips = match dns::ips(&h).await {
                        Ok(i) => i,
                        Err(Miss::None) => Vec::new(),
                        Err(Miss::Failed) => return Err("temperror"),
                    };
                    if kind == "a" && !self.void(ips.len()) {
                        return Err("permerror");
                    }
                    if ips.iter().any(|a| matches(self.ip, *a, c4, c6)) {
                        return Ok(true);
                    }
                }
                Ok(false)
            }
            // Deprecated and costly; treated as never matching.
            "ptr" => {
                if !self.count() {
                    return Err("permerror");
                }
                Ok(false)
            }
            kind @ ("ip4" | "ip6") => {
                let spec = arg.trim_start_matches(':');
                let (addr, bits) = spec.split_once('/').unwrap_or((spec, ""));
                let addr: IpAddr = addr.parse().map_err(|_| "permerror")?;
                if (kind == "ip4") != addr.is_ipv4() {
                    return Err("permerror");
                }
                let max = if addr.is_ipv4() { 32 } else { 128 };
                let bits: u32 = if bits.is_empty() {
                    max
                } else {
                    bits.parse().map_err(|_| "permerror")?
                };
                if bits > max {
                    return Err("permerror");
                }
                Ok(matches(self.ip, addr, bits, bits))
            }
            "exists" => {
                if !self.count() {
                    return Err("permerror");
                }
                let target = self
                    .expand(arg.trim_start_matches(':'), domain)
                    .ok_or("permerror")?;
                match dns::ips(&target).await {
                    Ok(ips) => Ok(ips.iter().any(IpAddr::is_ipv4)),
                    Err(Miss::None) => {
                        if self.void(0) {
                            Ok(false)
                        } else {
                            Err("permerror")
                        }
                    }
                    Err(Miss::Failed) => Err("temperror"),
                }
            }
            _ => Err("permerror"),
        }
    }

    /// `[:domain][/cidr4][//cidr6]`
    fn domain_cidr(&self, arg: &str, domain: &str) -> Option<(String, u32, u32)> {
        let (mut arg, mut c4, mut c6) = (arg, 32, 128);
        if let Some(i) = arg.find("//") {
            c6 = arg[i + 2..].parse().ok().filter(|n| *n <= 128)?;
            arg = &arg[..i];
        }
        if let Some(i) = arg.rfind('/') {
            c4 = arg[i + 1..].parse().ok().filter(|n| *n <= 32)?;
            arg = &arg[..i];
        }
        let target = match arg.strip_prefix(':') {
            Some(t) => self.expand(t, domain)?,
            None if arg.is_empty() => domain.to_owned(),
            None => return None,
        };
        Some((target, c4, c6))
    }

    /// Macro expansion (RFC 7208 section 7).
    fn expand(&self, s: &str, domain: &str) -> Option<String> {
        if !s.contains('%') {
            return Some(s.trim_end_matches('.').to_ascii_lowercase());
        }
        let mut out = String::new();
        let mut chars = s.chars().peekable();
        while let Some(c) = chars.next() {
            if c != '%' {
                out.push(c);
                continue;
            }
            match chars.next()? {
                '%' => out.push('%'),
                '_' => out.push(' '),
                '-' => out.push_str("%20"),
                '{' => {
                    let spec: String = chars.by_ref().take_while(|&c| c != '}').collect();
                    let mut sc = spec.chars();
                    let letter = sc.next()?;
                    let rest: String = sc.collect();
                    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
                    let rest = &rest[digits.len()..];
                    let reverse = rest.starts_with(['r', 'R']);
                    let delims = if reverse { &rest[1..] } else { rest };
                    let delims = if delims.is_empty() { "." } else { delims };
                    let (local, sender_domain) =
                        self.sender.rsplit_once('@').unwrap_or(("", &self.sender));
                    let value = match letter.to_ascii_lowercase() {
                        's' => self.sender.clone(),
                        'l' => local.to_owned(),
                        'o' => sender_domain.to_owned(),
                        'd' => domain.to_owned(),
                        'h' => self.helo.clone(),
                        'v' => if self.ip.is_ipv4() { "in-addr" } else { "ip6" }.to_owned(),
                        'p' => "unknown".to_owned(),
                        'i' => match self.ip {
                            IpAddr::V4(v4) => v4.to_string(),
                            IpAddr::V6(v6) => v6
                                .octets()
                                .iter()
                                .flat_map(|b| [b >> 4, b & 15])
                                .map(|n| format!("{n:x}"))
                                .collect::<Vec<_>>()
                                .join("."),
                        },
                        _ => return None,
                    };
                    let mut parts: Vec<&str> = value
                        .split(|c| delims.contains(c))
                        .filter(|p| !p.is_empty())
                        .collect();
                    if reverse {
                        parts.reverse();
                    }
                    let n: usize = digits.parse().unwrap_or(0);
                    if n > 0 && n < parts.len() {
                        parts = parts[parts.len() - n..].to_vec();
                    }
                    out.push_str(&parts.join("."));
                }
                _ => return None,
            }
        }
        let mut res = out.trim_end_matches('.').to_ascii_lowercase();
        while res.len() > 253 {
            res = res.split_once('.')?.1.to_owned();
        }
        Some(res)
    }
}

/// Whether `ip` is in the network of `net` with `c4` or `c6` bits.
fn matches(ip: IpAddr, net: IpAddr, c4: u32, c6: u32) -> bool {
    match (ip, net) {
        (IpAddr::V4(a), IpAddr::V4(b)) => {
            let mask = u32::MAX.checked_shl(32 - c4).unwrap_or(0);
            u32::from(a) & mask == u32::from(b) & mask
        }
        (IpAddr::V6(a), IpAddr::V6(b)) => {
            let mask = u128::MAX.checked_shl(128 - c6).unwrap_or(0);
            u128::from(a) & mask == u128::from(b) & mask
        }
        _ => false,
    }
}

// ---- DKIM ----

pub struct Dkim {
    /// pass, fail, neutral, temperror or permerror.
    pub status: &'static str,
    pub domain: String,
    pub selector: String,
}

fn tags(s: &str) -> Option<Vec<(String, String)>> {
    let mut out: Vec<(String, String)> = Vec::new();
    for part in s.split(';') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let (k, v) = part.split_once('=')?;
        let k = k.trim().to_owned();
        if out.iter().any(|(o, _)| *o == k) {
            return None;
        }
        out.push((k, v.trim().to_owned()));
    }
    Some(out)
}

fn tag<'a>(t: &'a [(String, String)], k: &str) -> &'a str {
    t.iter()
        .find(|(n, _)| n == k)
        .map_or("", |(_, v)| v.as_str())
}

fn strip_ws(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

fn collapse_ws(s: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len());
    let mut space = false;
    for &b in s {
        if b == b' ' || b == b'\t' {
            space = true;
        } else {
            if space {
                out.push(b' ');
                space = false;
            }
            out.push(b);
        }
    }
    if space {
        out.push(b' ');
    }
    out
}

fn canon_header(raw: &[u8], relaxed: bool) -> Vec<u8> {
    if !relaxed {
        return raw.to_vec();
    }
    let colon = raw.iter().position(|&b| b == b':').unwrap_or(raw.len());
    let name = String::from_utf8_lossy(&raw[..colon])
        .trim_end()
        .to_ascii_lowercase();
    let value: Vec<u8> = raw[(colon + 1).min(raw.len())..]
        .iter()
        .copied()
        .filter(|&b| b != b'\r' && b != b'\n')
        .collect();
    let value = collapse_ws(&value);
    let value = String::from_utf8_lossy(&value).trim().to_owned();
    format!("{name}:{value}\r\n").into_bytes()
}

fn canon_body(body: &[u8], relaxed: bool) -> Vec<u8> {
    let mut b = if relaxed {
        body.split(|&c| c == b'\n')
            .map(|l| {
                let l = l.strip_suffix(b"\r").unwrap_or(l);
                let mut l = collapse_ws(l);
                while l.last() == Some(&b' ') {
                    l.pop();
                }
                l
            })
            .collect::<Vec<_>>()
            .join(&b"\r\n"[..])
    } else {
        body.to_vec()
    };
    while b.ends_with(b"\r\n") {
        b.truncate(b.len() - 2);
    }
    if b.is_empty() {
        return if relaxed { b } else { b"\r\n".to_vec() };
    }
    b.extend_from_slice(b"\r\n");
    b
}

/// The signature header with its b= value emptied.
fn without_b(raw: &[u8]) -> Vec<u8> {
    let text = String::from_utf8_lossy(raw);
    let (name, value) = text.split_once(':').unwrap_or((&text, ""));
    let mut out = format!("{name}:");
    let mut first = true;
    for part in value.split(';') {
        if !first {
            out.push(';');
        }
        first = false;
        let trimmed = part.trim_start();
        if let Some(rest) = trimmed.strip_prefix('b') {
            if rest.trim_start().starts_with('=') {
                let eq = part.find('=').unwrap_or(0);
                out.push_str(&part[..=eq]);
                continue;
            }
        }
        out.push_str(part);
    }
    out.into_bytes()
}

/// The signed headers' hash input: each named header bottom-up, then the
/// signature header itself without its CRLF.
fn header_hash(header: &[Field], names: &[&str], sig: &[u8], relaxed: bool) -> Vec<u8> {
    let mut h = Sha256::new();
    let mut used = vec![false; header.len()];
    for name in names {
        if let Some(i) = (0..header.len())
            .rev()
            .find(|&i| !used[i] && header[i].name.eq_ignore_ascii_case(name))
        {
            used[i] = true;
            h.update(canon_header(&header[i].raw, relaxed));
        }
    }
    let c = canon_header(sig, relaxed);
    h.update(c.strip_suffix(b"\r\n").unwrap_or(&c));
    h.finalize().to_vec()
}

/// Every DKIM-Signature on the message, up to five, checked.
pub async fn verify(raw: &[u8]) -> Vec<Dkim> {
    let (head, body) = message::split_header(raw);
    let header = message::parse_header(head);
    let mut out = Vec::new();
    for f in header
        .iter()
        .filter(|f| f.name.eq_ignore_ascii_case("DKIM-Signature"))
        .take(5)
    {
        out.push(verify_one(&header, f, body).await);
    }
    out
}

async fn verify_one(header: &[Field], sig: &Field, body: &[u8]) -> Dkim {
    let mut res = Dkim {
        status: "permerror",
        domain: String::new(),
        selector: String::new(),
    };
    let Some(t) = tags(&sig.value) else {
        return res;
    };
    res.domain = tag(&t, "d").to_ascii_lowercase();
    res.selector = tag(&t, "s").to_owned();
    if ["v", "a", "b", "bh", "d", "h", "s"]
        .iter()
        .any(|k| tag(&t, k).is_empty())
        || tag(&t, "v") != "1"
        || !tag(&t, "a").eq_ignore_ascii_case("rsa-sha256")
    {
        return res;
    }
    let c = tag(&t, "c").to_ascii_lowercase();
    let (hc, bc) = c.split_once('/').unwrap_or((&c, "simple"));
    let hc = if hc.is_empty() { "simple" } else { hc };
    if !matches!(hc, "simple" | "relaxed") || !matches!(bc, "simple" | "relaxed") {
        return res;
    }
    let signed = strip_ws(tag(&t, "h"));
    let names: Vec<&str> = signed.split(':').collect();
    if !names.iter().any(|n| n.eq_ignore_ascii_case("from")) {
        return res;
    }
    let auid = tag(&t, "i");
    if !auid.is_empty() {
        let d = auid
            .rsplit_once('@')
            .map_or("", |(_, d)| d)
            .to_ascii_lowercase();
        if d != res.domain && !d.ends_with(&format!(".{}", res.domain)) {
            return res;
        }
    }
    if let Ok(x) = tag(&t, "x").parse::<i64>() {
        if now() > x {
            return res;
        }
    }
    let (Ok(b), Ok(bh)) = (
        B64.decode(strip_ws(tag(&t, "b"))),
        B64.decode(strip_ws(tag(&t, "bh"))),
    ) else {
        return res;
    };
    let mut cbody = canon_body(body, bc == "relaxed");
    if let Ok(l) = tag(&t, "l").parse::<usize>() {
        if l > cbody.len() {
            return res;
        }
        cbody.truncate(l);
    }
    if Sha256::digest(&cbody).as_slice() != bh.as_slice() {
        res.status = "fail";
        return res;
    }
    let key = match key(&res.selector, &res.domain).await {
        Ok(k) => k,
        Err(status) => {
            res.status = status;
            return res;
        }
    };
    if key.n().bits() < 1024 {
        return res;
    }
    let digest = header_hash(header, &names, &without_b(&sig.raw), hc == "relaxed");
    res.status = if key
        .verify(Pkcs1v15Sign::new::<rsa::sha2::Sha256>(), &digest, &b)
        .is_ok()
    {
        "pass"
    } else {
        "fail"
    };
    res
}

async fn key(selector: &str, domain: &str) -> Result<RsaPublicKey, &'static str> {
    let txts = match dns::txt(&format!("{selector}._domainkey.{domain}")).await {
        Ok(t) if !t.is_empty() => t,
        Ok(_) | Err(Miss::None) => return Err("permerror"),
        Err(Miss::Failed) => return Err("temperror"),
    };
    let t = tags(&txts.concat())
        .or_else(|| tags(&txts[0]))
        .ok_or("permerror")?;
    let v = tag(&t, "v");
    if !v.is_empty() && v != "DKIM1" {
        return Err("permerror");
    }
    let k = tag(&t, "k");
    if !k.is_empty() && !k.eq_ignore_ascii_case("rsa") {
        return Err("permerror");
    }
    let der = B64
        .decode(strip_ws(tag(&t, "p")))
        .map_err(|_| "permerror")?;
    if der.is_empty() {
        return Err("permerror");
    }
    RsaPublicKey::from_public_key_der(&der)
        .or_else(|_| {
            use rsa::pkcs1::DecodeRsaPublicKey;
            RsaPublicKey::from_pkcs1_der(&der)
        })
        .map_err(|_| "permerror")
}

const SIGNED: [&str; 12] = [
    "From",
    "Reply-To",
    "Subject",
    "Date",
    "To",
    "Cc",
    "Message-ID",
    "In-Reply-To",
    "References",
    "MIME-Version",
    "Content-Type",
    "Content-Transfer-Encoding",
];

/// A whole `DKIM-Signature: ...\r\n` header to put before `raw`.
pub fn sign(key: &RsaPrivateKey, domain: &str, selector: &str, raw: &[u8]) -> Result<Vec<u8>> {
    let (head, body) = message::split_header(raw);
    let header = message::parse_header(head);
    let mut names: Vec<&str> = SIGNED
        .iter()
        .copied()
        .filter(|n| message::has(&header, n))
        .collect();
    // From once more, so a second From cannot be added after.
    names.push("From");
    let bh = B64.encode(Sha256::digest(canon_body(body, true)));
    let sig = format!(
        "DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d={domain}; s={selector};\r\n\tt={}; h={};\r\n\tbh={bh};\r\n\tb=",
        now(),
        names.join(":")
    );
    let digest = header_hash(&header, &names, sig.as_bytes(), true);
    let signature = key.sign(Pkcs1v15Sign::new::<rsa::sha2::Sha256>(), &digest)?;
    let b = B64.encode(signature);
    let mut out = sig;
    let mut rest = b.as_str();
    while rest.len() > 72 {
        out.push_str(&rest[..72]);
        out.push_str("\r\n\t");
        rest = &rest[72..];
    }
    out.push_str(rest);
    out.push_str("\r\n");
    Ok(out.into_bytes())
}

/// The TXT value that publishes the key.
pub fn record(key: &RsaPrivateKey) -> String {
    let der = RsaPublicKey::from(key)
        .to_public_key_der()
        .map(|d| d.as_bytes().to_vec())
        .unwrap_or_default();
    format!("v=DKIM1; k=rsa; p={}", B64.encode(der))
}

// ---- DMARC ----

pub struct Dmarc {
    /// pass, fail, none, temperror or permerror.
    pub result: &'static str,
    /// none, quarantine or reject.
    pub policy: String,
}

const TWO_LABEL: [&str; 36] = [
    "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk", "com.au", "net.au",
    "org.au", "edu.au", "gov.au", "co.nz", "org.nz", "net.nz", "co.jp", "ne.jp", "or.jp", "ac.jp",
    "com.br", "net.br", "org.br", "com.mx", "com.ar", "com.cn", "com.hk", "com.sg", "com.tw",
    "co.in", "net.in", "org.in", "co.za", "co.kr", "co.il", "com.tr", "com.ua",
];

/// The registrable domain, near enough.
pub fn org_domain(d: &str) -> String {
    let d = d.trim_end_matches('.').to_ascii_lowercase();
    let labels: Vec<&str> = d.split('.').collect();
    if labels.len() <= 2 {
        return d;
    }
    let last2 = labels[labels.len() - 2..].join(".");
    let keep = if TWO_LABEL.contains(&last2.as_str()) {
        3
    } else {
        2
    };
    labels[labels.len() - keep..].join(".")
}

async fn dmarc_record(domain: &str) -> Result<Option<Vec<(String, String)>>, ()> {
    match dns::txt(&format!("_dmarc.{domain}")).await {
        Ok(txts) => {
            let found: Vec<&String> = txts
                .iter()
                .filter(|t| t.trim_start().starts_with("v=DMARC1"))
                .collect();
            Ok(match found.as_slice() {
                [one] => tags(one),
                _ => None,
            })
        }
        Err(Miss::None) => Ok(None),
        Err(Miss::Failed) => Err(()),
    }
}

pub async fn dmarc(from_domain: &str, spf: &str, spf_domain: &str, dkim: &[Dkim]) -> Dmarc {
    let from = from_domain.trim_end_matches('.').to_ascii_lowercase();
    let mut res = Dmarc {
        result: "none",
        policy: "none".into(),
    };
    if !valid_domain(&from) {
        return res;
    }
    let org = org_domain(&from);
    let mut at_org = false;
    let mut found = dmarc_record(&from).await;
    if matches!(found, Ok(None)) && org != from {
        found = dmarc_record(&org).await;
        at_org = true;
    }
    let t = match found {
        Err(()) => {
            res.result = "temperror";
            return res;
        }
        Ok(None) => return res,
        Ok(Some(t)) => t,
    };
    let mut p = tag(&t, "p").to_ascii_lowercase();
    if !matches!(p.as_str(), "none" | "quarantine" | "reject") {
        if tag(&t, "rua").is_empty() {
            res.result = "permerror";
            return res;
        }
        p = "none".into();
    }
    let sp = tag(&t, "sp").to_ascii_lowercase();
    if at_org && !sp.is_empty() {
        p = sp;
    }
    res.policy = p;
    let aligned = |d: &str, mode: &str| {
        let d = d.to_ascii_lowercase();
        if mode.eq_ignore_ascii_case("s") {
            d == from
        } else {
            org_domain(&d) == org
        }
    };
    res.result = if (spf == "pass" && aligned(spf_domain, tag(&t, "aspf")))
        || dkim
            .iter()
            .any(|d| d.status == "pass" && aligned(&d.domain, tag(&t, "adkim")))
    {
        "pass"
    } else {
        "fail"
    };
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_signature_covers_the_body_and_its_headers() {
        let key = RsaPrivateKey::new(&mut rand::rngs::OsRng, 1024).unwrap();
        let raw = b"From: sam@example.com\r\nTo: lee@example.com\r\nSubject: hi\r\n\r\nhello  there \r\n\r\n";
        let mut signed = sign(&key, "example.com", "mail", raw).unwrap();
        signed.extend_from_slice(raw);
        let (head, body) = message::split_header(&signed);
        let header = message::parse_header(head);
        let field = &header[0];
        let t = tags(&field.value).unwrap();
        let bh = B64.decode(strip_ws(tag(&t, "bh"))).unwrap();
        assert_eq!(
            Sha256::digest(canon_body(body, true)).as_slice(),
            bh.as_slice()
        );
        let signed_names = strip_ws(tag(&t, "h"));
        let names: Vec<&str> = signed_names.split(':').collect();
        let digest = header_hash(&header, &names, &without_b(&field.raw), true);
        let b = B64.decode(strip_ws(tag(&t, "b"))).unwrap();
        assert!(RsaPublicKey::from(&key)
            .verify(Pkcs1v15Sign::new::<rsa::sha2::Sha256>(), &digest, &b)
            .is_ok());
        assert!(record(&key).starts_with("v=DKIM1; k=rsa; p="));
    }

    #[test]
    fn relaxed_canonical_forms() {
        assert_eq!(
            canon_header(b"Subject :  a \r\n\t b\r\n", true),
            b"subject:a b\r\n"
        );
        assert_eq!(canon_body(b"a  b \r\n\r\n\r\n", true), b"a b\r\n");
        assert_eq!(canon_body(b"", false), b"\r\n");
    }

    #[test]
    fn domains_and_networks() {
        assert_eq!(org_domain("mail.example.co.uk"), "example.co.uk");
        assert_eq!(org_domain("a.b.example.com"), "example.com");
        let ip: IpAddr = "203.0.113.9".parse().unwrap();
        assert!(matches(ip, "203.0.113.0".parse().unwrap(), 24, 128));
        assert!(!matches(ip, "203.0.114.0".parse().unwrap(), 24, 128));
    }
}
