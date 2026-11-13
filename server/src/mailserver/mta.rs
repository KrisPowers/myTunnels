//! Where mail goes: received mail is checked and filed in its mailbox, sent
//! mail is signed and filed or queued, and failures bounce to the sender.

use std::net::IpAddr;

use super::message::{self, Field};
use super::store::{self, Item, Rcpt};
use super::{auth, Mail};
use crate::util::{now, random_hex};

/// An SMTP reply given for a refusal.
#[derive(Debug)]
pub struct Reply {
    pub code: u16,
    pub enhanced: &'static str,
    pub msg: String,
}

impl Reply {
    pub fn new(code: u16, enhanced: &'static str, msg: impl Into<String>) -> Self {
        Self {
            code,
            enhanced,
            msg: msg.into(),
        }
    }

    pub fn temp(msg: &str) -> Self {
        Self::new(451, "4.3.0", msg)
    }
}

fn split(addr: &str) -> (&str, String) {
    match addr.rsplit_once('@') {
        Some((l, d)) => (l, d.to_ascii_lowercase()),
        None => (addr, String::new()),
    }
}

/// Mail from the outside world.
pub struct Inbound {
    /// The server that sent it, when known.
    pub ip: Option<IpAddr>,
    pub helo: String,
    pub from: String,
    pub to: Vec<String>,
    pub data: Vec<u8>,
    /// Such as Cloudflare Email Routing.
    pub via: &'static str,
}

impl Mail {
    /// The account an address delivers to: plus-addressing, aliases and
    /// catch-alls followed, and postmaster and abuse to the first account.
    pub fn resolve(&self, addr: &str) -> Option<String> {
        let addr = addr.trim().to_ascii_lowercase();
        let (local, domain) = split(&addr);
        if !self.settings().is_local(&domain) {
            return None;
        }
        let mut tries = vec![addr.clone()];
        if let Some((base, _)) = local.split_once('+').filter(|(b, _)| !b.is_empty()) {
            tries.push(format!("{base}@{domain}"));
        }
        for t in &tries {
            if self.store.exists(t) {
                return Some(t.clone());
            }
            if let Some(to) = self.store.alias(t).filter(|to| self.store.exists(to)) {
                return Some(to);
            }
        }
        if let Some(to) = self
            .store
            .alias(&format!("@{domain}"))
            .filter(|to| self.store.exists(to))
        {
            return Some(to);
        }
        let base = local.split('+').next().unwrap_or("");
        if base == "postmaster" || base == "abuse" {
            return self
                .store
                .accounts()
                .ok()?
                .into_iter()
                .next()
                .map(|a| a.address);
        }
        None
    }

    pub fn check_inbound(&self, rcpt: &str) -> Result<(), Reply> {
        let (_, domain) = split(rcpt);
        if !self.settings().is_local(&domain) {
            return Err(Reply::new(554, "5.7.1", "relay access denied"));
        }
        if self.resolve(rcpt).is_none() {
            return Err(Reply::new(550, "5.1.1", "no such user"));
        }
        Ok(())
    }

    /// Files mail into each recipient's mailbox, Junk when it fails its
    /// checks. True when it went to Junk.
    pub async fn receive(
        &self,
        msg: Inbound,
        spf_given: Option<&'static str>,
    ) -> Result<bool, Reply> {
        let settings = self.settings();
        for r in &msg.to {
            self.check_inbound(r)?;
        }
        let (head, _) = message::split_header(&msg.data);
        let header = message::parse_header(head);
        let mut spf_domain = split(&msg.from).1;
        let spf = match msg.ip {
            Some(ip) => {
                let (r, d) = auth::spf(ip, &msg.from, &msg.helo).await;
                spf_domain = d;
                r
            }
            None => spf_given.unwrap_or("none"),
        };
        let dkims = auth::verify(&msg.data).await;
        let froms = message::addresses(message::get(&header, "From"));
        let from_domain = match froms.as_slice() {
            [one] => split(&one.email).1,
            _ => String::new(),
        };
        let dmarc = auth::dmarc(&from_domain, spf, &spf_domain, &dkims).await;

        let mut reasons = Vec::new();
        if from_domain.is_empty() {
            reasons.push("missing or invalid From".to_owned());
        } else if dmarc.result == "fail" && dmarc.policy == "reject" && settings.reject_dmarc {
            tracing::info!("mail from {} refused by its DMARC policy", msg.from);
            return Err(Reply::new(
                550,
                "5.7.1",
                "rejected by sender's DMARC policy",
            ));
        } else if dmarc.result == "fail" && dmarc.policy != "none" {
            reasons.push(format!("DMARC {}", dmarc.policy));
        } else if spf == "fail" && dmarc.result != "pass" {
            reasons.push("SPF fail".into());
        }
        if settings.is_local(&from_domain) && dmarc.result != "pass" {
            reasons.push("unauthenticated use of a local domain".into());
        }
        let junk = !reasons.is_empty();

        let host = settings.hostname();
        let mut trace =
            format!("Authentication-Results: {host};\r\n\tspf={spf} smtp.mailfrom={spf_domain}");
        if dkims.is_empty() {
            trace.push_str(";\r\n\tdkim=none");
        }
        for d in &dkims {
            trace.push_str(&format!(
                ";\r\n\tdkim={} header.d={} header.s={}",
                d.status, d.domain, d.selector
            ));
        }
        trace.push_str(&format!(
            ";\r\n\tdmarc={} (p={}) header.from={from_domain}\r\n",
            dmarc.result, dmarc.policy
        ));
        if junk {
            trace.push_str(&format!("X-Junk: yes ({})\r\n", reasons.join(", ")));
        }
        let ip = msg.ip.map_or("unknown".to_owned(), |ip| ip.to_string());
        trace.push_str(&format!(
            "Received: from {} ([{ip}])\r\n\tby {host} via {};\r\n\t{}\r\n",
            clean(&msg.helo),
            msg.via,
            message::rfc_date(now())
        ));
        let mut data = trace.into_bytes();
        data.extend(strip_own_results(&msg.data, &host));

        let mut done: Vec<String> = Vec::new();
        for r in &msg.to {
            let Some(user) = self.resolve(r) else {
                continue;
            };
            if done.contains(&user) {
                continue;
            }
            if let Err(err) = self.deliver_local(&user, junk, &data) {
                tracing::warn!("could not file mail for {user}: {err:#}");
                return Err(Reply::temp("local delivery failed"));
            }
            done.push(user);
        }
        tracing::info!(
            "mail in from {} to {:?}: spf {spf}, dmarc {}, junk {junk}",
            msg.from,
            msg.to,
            dmarc.result
        );
        Ok(junk)
    }

    pub fn deliver_local(&self, user: &str, junk: bool, data: &[u8]) -> anyhow::Result<()> {
        let mut flags = Vec::new();
        if !message::risky_files(data).is_empty() {
            flags.push(store::RISKY.to_owned());
        }
        let (head, _) = message::split_header(data);
        if message::bulk(&message::parse_header(head)) {
            flags.push(store::MARKETING.to_owned());
        }
        let folder = if junk {
            self.store
                .special(user, "\\Junk")
                .unwrap_or_else(|| "INBOX".into())
        } else {
            "INBOX".into()
        };
        self.store.append(user, &folder, data, &flags, now())?;
        Ok(())
    }

    // ---- sending, from a mail app ----

    /// Whether `user` may send as `addr`.
    pub fn may_use(&self, user: &str, addr: &str) -> bool {
        self.resolve(addr)
            .is_some_and(|u| u.eq_ignore_ascii_case(user))
    }

    pub fn check_sender(&self, user: &str, from: &str) -> Result<(), Reply> {
        if from.is_empty() || !self.may_use(user, from) {
            return Err(Reply::new(
                553,
                "5.7.1",
                format!("sender address not owned by {user}"),
            ));
        }
        Ok(())
    }

    pub fn check_outbound(&self, rcpt: &str) -> Result<(), Reply> {
        let (_, domain) = split(rcpt);
        if domain.is_empty() {
            return Err(Reply::new(501, "5.1.3", "invalid recipient"));
        }
        if self.settings().is_local(&domain) && self.resolve(rcpt).is_none() {
            return Err(Reply::new(550, "5.1.1", "no such user"));
        }
        Ok(())
    }

    /// Signs mail a signed-in account sent, files it for local recipients,
    /// queues it for the rest and keeps a copy in Sent.
    pub fn submit(&self, user: &str, from: &str, to: &[String], data: &[u8]) -> Result<(), Reply> {
        let settings = self.settings();
        let (head, _) = message::split_header(data);
        let header = message::parse_header(head);
        let froms = message::addresses(message::get(&header, "From"));
        if froms.is_empty() {
            return Err(Reply::new(550, "5.6.0", "missing or invalid From header"));
        }
        if let Some(f) = froms.iter().find(|f| !self.may_use(user, &f.email)) {
            return Err(Reply::new(
                550,
                "5.7.1",
                format!("From {} not owned by {user}", f.email),
            ));
        }
        let from_domain = split(&froms[0].email).1;
        let host = settings.hostname();
        let mut extra = format!(
            "Received: by {host} with ESMTPSA;\r\n\t{}\r\n",
            message::rfc_date(now())
        );
        if !message::has(&header, "Date") {
            extra.push_str(&format!("Date: {}\r\n", message::rfc_date(now())));
        }
        if !message::has(&header, "Message-ID") {
            extra.push_str(&format!("Message-ID: <{}@{host}>\r\n", random_hex(12)));
        }
        let mut signed = extra.into_bytes();
        signed.extend_from_slice(data);
        let data = self.sign(&from_domain, signed);

        let mut remote = Vec::new();
        let mut done: Vec<String> = Vec::new();
        for r in to {
            match self.resolve(r) {
                Some(u) => {
                    if !done.contains(&u) {
                        self.deliver_local(&u, false, &data)
                            .map_err(|_| Reply::temp("local delivery failed"))?;
                        self.store
                            .log("out", from, r, data.len(), "delivered", "to this server");
                        done.push(u);
                    }
                }
                None => remote.push(r.clone()),
            }
        }
        if !remote.is_empty() {
            self.store
                .enqueue(from, &remote, &data)
                .map_err(|_| Reply::temp("could not queue message"))?;
            self.wake.notify_one();
        }
        if settings.save_sent {
            if let Some(sent) = self.store.special(user, "\\Sent") {
                let _ = self
                    .store
                    .append(user, &sent, &data, &[store::SEEN.to_owned()], now());
            }
        }
        tracing::info!(
            "mail out from {user}: {} here, {} queued",
            done.len(),
            remote.len()
        );
        Ok(())
    }

    /// The message with this server's DKIM signature on top, when the
    /// domain has a key.
    pub fn sign(&self, domain: &str, data: Vec<u8>) -> Vec<u8> {
        let Some(key) = self.dkim_key(domain) else {
            return data;
        };
        match auth::sign(&key, domain, super::SELECTOR, &data) {
            Ok(mut sig) => {
                sig.extend(data);
                sig
            }
            Err(err) => {
                tracing::warn!("could not sign mail for {domain}: {err:#}");
                data
            }
        }
    }

    /// A delivery report to the local sender for recipients that failed.
    pub fn bounce(&self, it: &Item, failed: &[Rcpt], original: &[u8]) {
        let Some(user) = self.resolve(&it.from) else {
            return;
        };
        let host = self.settings().hostname();
        let b = random_hex(12);
        let (head, _) = message::split_header(original);
        let mut m = format!(
            "From: Mail Delivery System <MAILER-DAEMON@{host}>\r\nTo: <{}>\r\nSubject: Undelivered Mail Returned to Sender\r\nDate: {}\r\nMessage-ID: <{b}.bounce@{host}>\r\nAuto-Submitted: auto-replied\r\nMIME-Version: 1.0\r\nContent-Type: multipart/report; report-type=delivery-status; boundary=\"{b}\"\r\n\r\n",
            it.from,
            message::rfc_date(now())
        );
        m.push_str(&format!(
            "--{b}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nYour message could not be delivered to the following recipients:\r\n\r\n"
        ));
        for r in failed {
            m.push_str(&format!("  {}\r\n    {}\r\n\r\n", r.addr, r.error));
        }
        m.push_str(&format!(
            "--{b}\r\nContent-Type: message/delivery-status\r\n\r\nReporting-MTA: dns; {host}\r\nArrival-Date: {}\r\n",
            message::rfc_date(it.created)
        ));
        for r in failed {
            m.push_str(&format!(
                "\r\nFinal-Recipient: rfc822; {}\r\nAction: failed\r\nStatus: 5.0.0\r\nDiagnostic-Code: smtp; {}\r\n",
                r.addr,
                r.error.replace(['\r', '\n'], " ")
            ));
        }
        m.push_str(&format!(
            "\r\n--{b}\r\nContent-Type: text/rfc822-headers\r\n\r\n"
        ));
        let mut out = m.into_bytes();
        out.extend_from_slice(head);
        out.extend_from_slice(format!("--{b}--\r\n").as_bytes());
        if let Err(err) = self.deliver_local(&user, false, &out) {
            tracing::warn!("could not bounce to {user}: {err:#}");
        }
    }
}

/// What the relaying server recorded about the first sender: the top
/// Received-SPF and Received headers are its own.
pub fn relay_info(data: &[u8]) -> (Option<IpAddr>, String, Option<&'static str>) {
    let (head, _) = message::split_header(data);
    let (mut ip, mut helo, mut spf) = (None, String::new(), None);
    let (mut got_spf, mut got_recv) = (false, false);
    let after = |v: &str, key: &str| -> Option<String> {
        let lower = v.to_ascii_lowercase();
        let i = lower.find(key)? + key.len();
        Some(
            v[i..]
                .chars()
                .take_while(|c| !c.is_whitespace() && *c != ';')
                .collect(),
        )
    };
    for f in message::parse_header(head) {
        if !got_spf && f.name.eq_ignore_ascii_case("Received-SPF") {
            got_spf = true;
            let word = f
                .value
                .split_whitespace()
                .next()
                .unwrap_or("")
                .to_ascii_lowercase();
            spf = [
                "pass",
                "fail",
                "softfail",
                "neutral",
                "none",
                "temperror",
                "permerror",
            ]
            .into_iter()
            .find(|r| *r == word);
            ip = after(&f.value, "client-ip=").and_then(|s| s.parse().ok());
            if let Some(h) = after(&f.value, "helo=") {
                helo = h;
            }
        } else if !got_recv && f.name.eq_ignore_ascii_case("Received") {
            got_recv = true;
            if ip.is_none() {
                ip = f
                    .value
                    .split('[')
                    .nth(1)
                    .and_then(|s| s.split(']').next())
                    .and_then(|s| s.parse().ok());
            }
            if helo.is_empty() {
                if let Some(rest) = f.value.strip_prefix("from ") {
                    helo = rest.split(' ').next().unwrap_or("").to_owned();
                }
            }
        }
    }
    (ip, helo, spf)
}

fn clean(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_graphic() && *c != '(' && *c != ')')
        .collect()
}

/// Drops Authentication-Results claiming to be ours, which a sender could
/// forge, and any junk mark.
fn strip_own_results(data: &[u8], host: &str) -> Vec<u8> {
    let (head, body) = message::split_header(data);
    let fields: Vec<Field> = message::parse_header(head);
    let mut out = Vec::with_capacity(data.len());
    for f in &fields {
        let ours = f.name.eq_ignore_ascii_case("Authentication-Results")
            && f.value
                .split(';')
                .next()
                .is_some_and(|id| id.trim().eq_ignore_ascii_case(host));
        if ours || f.name.eq_ignore_ascii_case("X-Junk") {
            continue;
        }
        out.extend_from_slice(&f.raw);
    }
    if !body.is_empty() || head.ends_with(b"\r\n\r\n") || head == b"\r\n" {
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(body);
    out
}
