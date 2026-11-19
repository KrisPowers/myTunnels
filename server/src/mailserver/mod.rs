//! Mail: a mail server for your own domains, set up from the Mail page.
//!
//! Each part is reached the way picked at setup:
//!
//! - **Receiving**: other servers reach port 25 through a port forward and
//!   the domain's MX record, or Cloudflare Email Routing hands mail to a
//!   Worker that posts it through the tunnel.
//! - **Mail apps**: IMAP on 993 and SMTP on 465 through port forwards, with
//!   a Let's Encrypt certificate, or through Tailscale Funnel on 443 and
//!   8443 with Tailscale's.
//! - **Sending**: straight to each recipient's server, through another
//!   SMTP server, or through Cloudflare Email Sending.
//!
//! Each domain's DNS records are either added by hand wherever its DNS is
//! hosted, with the page listing them and checking each one, or kept on
//! Cloudflare, which setup writes itself. The Cloudflare ways above need
//! every domain on Cloudflare. A domain can be given managers: dashboard
//! accounts that run its mail accounts and aliases.
//!
//! Every listener is on this computer's loopback; the port forwards and
//! Funnel are rows on the Routes page like any other.

pub mod auth;
mod cert;
mod cloud;
mod dns;
mod fetch;
mod imap;
pub mod message;
mod mta;
mod net;
mod queue;
mod smtp;
mod store;
pub mod web;
pub mod zone;

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::Duration;

use anyhow::{anyhow, Result};
use axum::extract::{Extension, Path, State};
use axum::http::StatusCode;
use axum::Json;
use rsa::pkcs8::{DecodePrivateKey, EncodePrivateKey, LineEnding};
use rsa::RsaPrivateKey;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::Notify;

use crate::cloudflare::Cloudflare;
use crate::db::Forward;
use crate::mail::Smtp;
use crate::permissions::Caller;
use crate::state::AppState;
use crate::util::{lock, now, random_hex, ApiError, ApiResult};
use store::Store;

/// The largest message taken, as Cloudflare Email Routing's limit.
pub const MAX_MESSAGE: usize = 25 << 20;
/// The DKIM selector: keys are published at `mail._domainkey.<domain>`.
pub const SELECTOR: &str = "mail";
const SETTING: &str = "mail";

#[derive(Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Receive {
    /// Port 25 forwarded here, the MX record pointing at this network.
    #[default]
    Port,
    /// Cloudflare Email Routing, through the tunnel.
    Cloudflare,
}

#[derive(Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Apps {
    /// 993 and 465 forwarded here.
    #[default]
    Port,
    /// Tailscale Funnel on 443 and 8443.
    Tailscale,
}

#[derive(Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Send {
    /// Straight to each recipient's server on port 25.
    #[default]
    Direct,
    /// Through another SMTP server.
    Relay,
    /// Through Cloudflare Email Sending.
    Cloudflare,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Domain {
    pub name: String,
    /// The Cloudflare zone its records are kept in, or empty when they are
    /// added by hand wherever its DNS is hosted.
    #[serde(default)]
    pub zone_id: String,
    /// Dashboard accounts, by ID, that run this domain's mail accounts and
    /// aliases without setting mail up.
    #[serde(default)]
    pub managers: Vec<String>,
    /// The registrar its records are at, read and changed through its API,
    /// such as `porkbun`; empty when they are added by hand anywhere.
    #[serde(default)]
    pub host: String,
}

impl Domain {
    pub fn on_cloudflare(&self) -> bool {
        !self.zone_id.is_empty()
    }
}

fn yes() -> bool {
    true
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Settings {
    /// The first is the primary: the server is `mail.<it>`.
    #[serde(default)]
    pub domains: Vec<Domain>,
    #[serde(default)]
    pub receive: Receive,
    #[serde(default)]
    pub apps: Apps,
    #[serde(default)]
    pub send: Send,
    #[serde(default)]
    pub relay: Option<Smtp>,
    /// What the Email Worker proves itself with.
    #[serde(default)]
    pub secret: String,
    /// The forwards on the Routes page that mail opened.
    #[serde(default)]
    pub forwards: Vec<String>,
    /// Refuse mail whose sender's DMARC policy says reject, rather than
    /// filing it in Junk.
    #[serde(default)]
    pub reject_dmarc: bool,
    #[serde(default = "yes")]
    pub save_sent: bool,
    /// Set up and running.
    #[serde(default)]
    pub on: bool,
    /// The public address the server's A record was last given.
    #[serde(default)]
    pub address: String,
}

impl Settings {
    pub fn ready(&self) -> bool {
        self.on && !self.domains.is_empty()
    }

    fn primary(&self) -> Option<&Domain> {
        self.domains.first()
    }

    pub fn hostname(&self) -> String {
        self.primary()
            .map_or_else(|| "localhost".into(), |d| format!("mail.{}", d.name))
    }

    pub fn inbound_host(&self) -> String {
        self.primary()
            .map_or_else(String::new, |d| format!("mail-in.{}", d.name))
    }

    pub fn is_local(&self, domain: &str) -> bool {
        self.domain(domain).is_some()
    }

    fn domain(&self, name: &str) -> Option<&Domain> {
        self.domains
            .iter()
            .find(|d| d.name.eq_ignore_ascii_case(name))
    }

    /// Whether anything picked needs the Cloudflare account.
    fn needs_cloudflare(&self) -> bool {
        self.receive == Receive::Cloudflare
            || self.send == Send::Cloudflare
            || self.domains.iter().any(Domain::on_cloudflare)
    }

    /// Whether `caller` runs the accounts and aliases at `address`'s
    /// domain: anyone who sets mail up, or one of the domain's managers.
    fn runs(&self, caller: &Caller, address: &str) -> bool {
        if caller.is_admin() || caller.can("mail.manage") {
            return true;
        }
        let domain = address.rsplit_once('@').map_or("", |(_, d)| d);
        self.domain(domain)
            .is_some_and(|d| d.managers.iter().any(|m| m == caller.id()))
    }

    /// Whether the server's name must point at this network: something
    /// reaches it, or leaves from it, through the router.
    fn needs_address(&self) -> bool {
        self.receive == Receive::Port || self.apps == Apps::Port || self.send == Send::Direct
    }

    /// Where mail apps find IMAP and SMTP.
    pub async fn app_servers(&self, _mail: &Mail) -> Option<(String, u16, String, u16)> {
        match self.apps {
            Apps::Port => {
                let h = self.hostname();
                Some((h.clone(), 993, h, 465))
            }
            Apps::Tailscale => {
                let n = crate::forward::tailnet_name().await?;
                Some((n.clone(), 443, n, 8443))
            }
        }
    }
}

/// One line of setup's checklist.
#[derive(Clone, Serialize)]
struct Step {
    name: String,
    ok: bool,
    detail: String,
}

/// Setup as it runs, for the page to follow.
#[derive(Clone, Default, Serialize)]
struct Job {
    running: bool,
    step: String,
    done: usize,
    total: usize,
    steps: Vec<Step>,
    at: i64,
}

pub struct Mail {
    pub state: AppState,
    pub store: Store,
    settings: RwLock<Settings>,
    /// Wakes the outgoing queue.
    pub wake: Notify,
    job: Mutex<Job>,
    keys: Mutex<HashMap<String, RsaPrivateKey>>,
}

static MAIL: OnceLock<Arc<Mail>> = OnceLock::new();

pub fn get() -> Option<Arc<Mail>> {
    MAIL.get().cloned()
}

/// Two secrets compared without giving away how much of one matched.
pub fn same(a: &[u8], b: &[u8]) -> bool {
    Sha256::digest(a) == Sha256::digest(b)
}

/// Opens the mail store and starts the listeners, the queue and upkeep.
pub fn spawn(state: AppState) -> Result<()> {
    let store = Store::open(&state.config.data_dir.join("mail.db"))?;
    let settings = state
        .db
        .setting(SETTING)?
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| Settings {
            save_sent: true,
            ..Settings::default()
        });
    let mail = Arc::new(Mail {
        state,
        store,
        settings: RwLock::new(settings),
        wake: Notify::new(),
        job: Mutex::new(Job::default()),
        keys: Mutex::new(HashMap::new()),
    });
    let _ = MAIL.set(mail.clone());
    cert::load(&mail);
    net::spawn(mail.clone());
    queue::spawn(mail.clone());
    tokio::spawn(upkeep(mail));
    Ok(())
}

/// Every ten minutes: the server's address follows the network's, and the
/// certificate is renewed when due.
async fn upkeep(mail: Arc<Mail>) {
    let mut every = tokio::time::interval(Duration::from_secs(600));
    loop {
        every.tick().await;
        let s = mail.settings();
        if !s.ready() || lock(&mail.job).running {
            continue;
        }
        let ip = crate::forward::public_ip(&mail.state).map(|i| i.to_string());
        if s.needs_address() && ip.as_ref().is_some_and(|ip| *ip != s.address) {
            if let Err(err) = address_record(&mail, &s).await {
                tracing::warn!(
                    "could not move {} to the new address: {err:#}",
                    s.hostname()
                );
            }
        }
        if s.apps == Apps::Port || s.receive == Receive::Port {
            if let Some(d) = s.primary() {
                if let Err(err) = cert::ensure(&mail, &s.hostname(), &d.zone_id, false).await {
                    tracing::warn!("could not renew the mail certificate: {err:#}");
                }
            }
        }
    }
}

impl Mail {
    pub fn settings(&self) -> Settings {
        self.settings
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn save(&self, s: Settings) -> Result<()> {
        self.state
            .db
            .set_setting(SETTING, &serde_json::to_string(&s)?)?;
        *self.settings.write().unwrap_or_else(|e| e.into_inner()) = s;
        Ok(())
    }

    fn update(&self, f: impl FnOnce(&mut Settings)) -> Result<()> {
        let mut s = self.settings();
        f(&mut s);
        self.save(s)
    }

    /// The domain's DKIM key, when it has one.
    pub fn dkim_key(&self, domain: &str) -> Option<RsaPrivateKey> {
        let domain = domain.to_ascii_lowercase();
        if let Some(k) = lock(&self.keys).get(&domain) {
            return Some(k.clone());
        }
        let pem = self
            .state
            .db
            .setting(&format!("mail_dkim:{domain}"))
            .ok()??;
        let key = RsaPrivateKey::from_pkcs8_pem(&pem).ok()?;
        lock(&self.keys).insert(domain, key.clone());
        Some(key)
    }

    async fn make_dkim_key(&self, domain: &str) -> Result<RsaPrivateKey> {
        if let Some(k) = self.dkim_key(domain) {
            return Ok(k);
        }
        let key = tokio::task::spawn_blocking(|| RsaPrivateKey::new(&mut rand::rngs::OsRng, 2048))
            .await??;
        let pem = key.to_pkcs8_pem(LineEnding::LF)?;
        self.state
            .db
            .set_setting(&format!("mail_dkim:{}", domain.to_ascii_lowercase()), &pem)?;
        Ok(key)
    }

    /// The account a mail app signs in to, or why not: `Some` when it is
    /// held back for now, `None` for wrong details.
    pub async fn sign_in(
        &self,
        user: &str,
        pass: &str,
        ip: IpAddr,
    ) -> Result<String, Option<&'static str>> {
        let user = user.trim().to_ascii_lowercase();
        // Five wrong tries in 15 minutes hold back the address they came from,
        // never the account: a mail app retrying an old password, or someone
        // else guessing, never locks its owner out of the right one.
        let by_ip = format!("mail-ip:{ip}");
        if self.state.failed_too_often(&by_ip, 5, 15 * 60) {
            return Err(Some("too many failed sign-ins; try again later"));
        }
        let account = self.store.account(&user).ok().flatten().filter(|a| a.apps);
        let hash = account.as_ref().map(|a| a.password_hash.clone());
        let pass = pass.to_owned();
        let good = tokio::task::spawn_blocking(move || {
            crate::secret::verify_or_waste(&pass, hash.as_deref())
        })
        .await
        .unwrap_or(false);
        match account {
            Some(a) if good => {
                self.state.clear_failures(&by_ip);
                Ok(a.address)
            }
            Some(_) => {
                self.state.record_failure(&by_ip);
                tracing::info!("a mail app failed to sign in to {user} from {ip}");
                Err(None)
            }
            None => {
                self.state.record_failure(&by_ip);
                Err(None)
            }
        }
    }

    fn begin(&self, total: usize) -> bool {
        let mut job = lock(&self.job);
        if job.running {
            return false;
        }
        *job = Job {
            running: true,
            total,
            at: now(),
            ..Job::default()
        };
        true
    }

    fn step(&self, name: &str) {
        lock(&self.job).step = name.to_owned();
    }

    fn record(&self, name: &str, done: Result<String>) -> bool {
        let mut job = lock(&self.job);
        job.done += 1;
        let ok = done.is_ok();
        job.steps.push(Step {
            name: name.to_owned(),
            ok,
            detail: match done {
                Ok(d) => d,
                Err(e) => format!("{e:#}"),
            },
        });
        ok
    }

    fn end(&self) {
        let mut job = lock(&self.job);
        job.running = false;
        job.step.clear();
    }
}

// ---- setup ----

/// The ports mail opens on the Routes page: method, protocol, public port,
/// this computer's port, through Funnel, and its name there.
fn wanted_forwards(
    s: &Settings,
) -> Vec<(&'static str, &'static str, u16, u16, bool, &'static str)> {
    let mut out = Vec::new();
    if s.receive == Receive::Port {
        out.push(("port", "tcp", 25, net::MX_PORT, false, "Mail: incoming"));
    }
    match s.apps {
        Apps::Port => {
            out.push(("port", "tcp", 993, net::IMAP_TLS_PORT, false, "Mail: IMAP"));
            out.push((
                "port",
                "tcp",
                465,
                net::SUBMISSION_TLS_PORT,
                false,
                "Mail: SMTP",
            ));
        }
        Apps::Tailscale => {
            out.push((
                "tailscale",
                "tls",
                443,
                net::IMAP_FUNNEL_PORT,
                true,
                "Mail: IMAP",
            ));
            out.push((
                "tailscale",
                "tls",
                8443,
                net::SUBMISSION_FUNNEL_PORT,
                true,
                "Mail: SMTP",
            ));
        }
    }
    out
}

/// Opens the ports this setup needs and closes the ones it no longer does.
async fn forwards(mail: &Mail, s: &Settings) -> Result<String> {
    let want = wanted_forwards(s);
    let all = mail.state.db.forwards()?;
    let mut keep = Vec::new();
    for f in all.iter().filter(|f| s.forwards.contains(&f.id)) {
        let wanted = want.iter().any(|w| {
            f.method == w.0 && f.protocol == w.1 && f.public_port == w.2 && f.target_port == w.3
        });
        if wanted {
            keep.push(f.clone());
        } else {
            crate::forward::take_down(&mail.state, f)
                .await
                .map_err(|e| anyhow!(e.1))?;
        }
    }
    let mut opened = Vec::new();
    let mut problem = None;
    for w in &want {
        if let Some(f) = keep
            .iter()
            .find(|f| f.method == w.0 && f.public_port == w.2)
        {
            opened.push(f.id.clone());
            continue;
        }
        let f = Forward {
            id: random_hex(8),
            method: w.0.into(),
            name: w.5.into(),
            target_host: None,
            target_port: w.3,
            protocol: w.1.into(),
            public_port: w.2,
            public: w.4,
            expires_at: 0,
            enabled: true,
            created_at: now(),
        };
        match crate::forward::add(&mail.state, f).await {
            Ok(f) => opened.push(f.id),
            Err(e) => {
                problem.get_or_insert(format!("port {}: {}", w.2, e.1));
            }
        }
    }
    mail.update(|m| m.forwards = opened)?;
    if let Some(p) = problem {
        return Err(anyhow!(p));
    }
    let ports: Vec<String> = want.iter().map(|w| w.2.to_string()).collect();
    let by = if s.apps == Apps::Tailscale {
        "the router and Funnel"
    } else {
        "the router"
    };
    Ok(if ports.is_empty() {
        "none".into()
    } else {
        format!("{} through {by}", ports.join(", "))
    })
}

async fn address_record(mail: &Mail, s: &Settings) -> Result<String> {
    let d = s.primary().ok_or_else(|| anyhow!("no domain"))?;
    let host = s.hostname();
    if !d.on_cloudflare() {
        // Kept by hand: the address is noted, and the name checked.
        if !s.needs_address() {
            return Ok("not needed".into());
        }
        let ip = crate::forward::public_ip(&mail.state)
            .ok_or_else(|| anyhow!("this network's public address is not known yet"))?;
        mail.update(|m| m.address = ip.to_string())?;
        return match dns::ips(&host).await {
            Ok(found) if found.contains(&ip) => Ok(format!("{host} → {ip}")),
            _ => Err(anyhow!("add an A record at your DNS host: {host} → {ip}")),
        };
    }
    let cfs = cloud::settings(mail)?;
    let cf = Cloudflare::new(&mail.state.http, &cfs.token);
    if !s.needs_address() {
        cloud::remove(&cf, &d.zone_id, "A", &host, |r| r.comment == cloud::MARK).await?;
        return Ok("not needed".into());
    }
    let ip = crate::forward::public_ip(&mail.state)
        .ok_or_else(|| anyhow!("this network's public address is not known yet"))?
        .to_string();
    cloud::upsert(
        &cf,
        &d.zone_id,
        json!({ "type": "A", "name": host, "content": ip, "proxied": false }),
        |r| r.kind == "A",
    )
    .await?;
    mail.update(|m| m.address = ip.clone())?;
    Ok(format!("{host} → {ip}"))
}

// ---- records kept by hand ----

/// One DNS record mail needs, and whether DNS already answers with it.
#[derive(Serialize)]
pub struct Want {
    kind: &'static str,
    name: String,
    value: String,
    priority: Option<u16>,
    found: bool,
}

/// A TXT value without the spaces and quotes DNS hosts add or drop.
fn squash(v: &str) -> String {
    v.chars()
        .filter(|c| !c.is_whitespace() && *c != '"')
        .collect()
}

async fn txt(name: &str) -> Vec<String> {
    dns::txt(name).await.unwrap_or_default()
}

/// Every record the domain needs for this setup, checked against what DNS
/// answers now.
async fn wanted(mail: &Mail, s: &Settings, d: &Domain) -> Result<Vec<Want>> {
    let host = s.hostname();
    let mut out = Vec::new();
    if s.receive == Receive::Port {
        let found = dns::mx(&d.name)
            .await
            .is_ok_and(|l| l.iter().any(|(_, h)| h.eq_ignore_ascii_case(&host)));
        out.push(Want {
            kind: "MX",
            name: d.name.clone(),
            value: host.clone(),
            priority: Some(10),
            found,
        });
    }
    if s.primary().is_some_and(|p| p.name == d.name) && s.needs_address() {
        if let Some(ip) = crate::forward::public_ip(&mail.state) {
            let found = dns::ips(&host).await.is_ok_and(|l| l.contains(&ip));
            out.push(Want {
                kind: "A",
                name: host.clone(),
                value: ip.to_string(),
                priority: None,
                found,
            });
        }
    }
    let key = mail.make_dkim_key(&d.name).await?;
    let dkim = auth::record(&key);
    let name = format!("{SELECTOR}._domainkey.{}", d.name);
    let found = txt(&name).await.iter().any(|t| squash(t) == squash(&dkim));
    out.push(Want {
        kind: "TXT",
        name,
        value: dkim,
        priority: None,
        found,
    });
    let mut spf = Vec::new();
    if s.send == Send::Direct {
        spf.push(format!("a:{host}"));
    }
    if s.send == Send::Cloudflare || s.receive == Receive::Cloudflare {
        spf.push(cloud::CLOUDFLARE_SPF.to_owned());
    }
    if !spf.is_empty() {
        let existing = txt(&d.name)
            .await
            .into_iter()
            .find(|t| t.to_ascii_lowercase().starts_with("v=spf1"));
        let found = existing.as_ref().is_some_and(|e| {
            let e = e.to_ascii_lowercase();
            spf.iter().all(|w| e.split_whitespace().any(|t| t == w))
        });
        out.push(Want {
            kind: "TXT",
            name: d.name.clone(),
            value: cloud::merge_spf(existing.as_deref().unwrap_or(""), &spf, &[]),
            priority: None,
            found,
        });
    }
    let name = format!("_dmarc.{}", d.name);
    let existing = txt(&name)
        .await
        .into_iter()
        .find(|t| t.starts_with("v=DMARC1"));
    out.push(Want {
        kind: "TXT",
        name,
        found: existing.is_some(),
        value: existing.unwrap_or_else(|| cloud::DMARC.into()),
        priority: None,
    });
    Ok(out)
}

/// Setup's step for a domain whose records are added by hand: which are
/// still missing. The server's own address has its own step.
async fn check_by_hand(mail: &Mail, s: &Settings, d: &Domain) -> Result<String> {
    let missing: Vec<String> = wanted(mail, s, d)
        .await?
        .into_iter()
        .filter(|w| !w.found && w.kind != "A")
        .map(|w| format!("{} {}", w.kind, w.name))
        .collect();
    if missing.is_empty() {
        Ok("every record is in place".into())
    } else {
        Err(anyhow!("add at your DNS host: {}", missing.join(", ")))
    }
}

/// Points `host` at the tunnel, for what reaches mail through it.
async fn tunnel_cname(cf: &Cloudflare<'_>, tunnel_id: &str, zone: &str, host: &str) -> Result<()> {
    cloud::upsert(
        cf,
        zone,
        json!({ "type": "CNAME", "name": host, "content": format!("{tunnel_id}.cfargotunnel.com"), "proxied": true }),
        |r| r.kind == "CNAME",
    )
    .await
}

/// Puts everything the settings ask for in place, step by step.
async fn apply(mail: Arc<Mail>) {
    let s = mail.settings();
    let n = s.domains.len();
    let on_cf = s.domains.iter().filter(|d| d.on_cloudflare()).count();
    let total = (n + on_cf)
        + 1
        + match s.receive {
            Receive::Port => on_cf,
            Receive::Cloudflare => 2 + n,
        }
        + usize::from(s.apps == Apps::Port || s.receive == Receive::Port)
        + 1
        + on_cf * 2
        + if s.send == Send::Cloudflare { n } else { 0 }
        + usize::from(s.needs_cloudflare());
    if !mail.begin(total) {
        return;
    }
    run(&mail, &s).await;
    mail.end();
}

async fn run(mail: &Mail, s: &Settings) {
    macro_rules! step {
        ($name:expr, $body:expr) => {{
            let name: String = $name;
            mail.step(&name);
            let done: Result<String> = async { $body }.await;
            mail.record(&name, done)
        }};
    }
    // Cloudflare only when a domain is kept there or a Cloudflare way is picked.
    let parts = if s.needs_cloudflare() {
        match cloud::settings(mail) {
            Ok(c) => Some(c),
            Err(e) => {
                mail.record("Cloudflare", Err(e));
                return;
            }
        }
    } else {
        None
    };
    let cf = parts
        .as_ref()
        .map(|c| (Cloudflare::new(&mail.state.http, &c.token), c));
    let host = s.hostname();

    for d in &s.domains {
        let Some((cf, _)) = cf.as_ref().filter(|_| d.on_cloudflare()) else {
            step!(
                format!("Records for {}", d.name),
                check_by_hand(mail, s, d).await
            );
            continue;
        };
        step!(format!("DKIM for {}", d.name), {
            let key = mail.make_dkim_key(&d.name).await?;
            let name = format!("{SELECTOR}._domainkey.{}", d.name);
            cloud::upsert(
                cf,
                &d.zone_id,
                json!({ "type": "TXT", "name": name, "content": auth::record(&key) }),
                |_| true,
            )
            .await?;
            Ok(name)
        });
        step!(
            format!("DMARC for {}", d.name),
            cloud::dmarc(cf, &d.zone_id, &d.name).await
        );
    }
    step!(format!("Address of {host}"), address_record(mail, s).await);

    match s.receive {
        Receive::Port => {
            for d in &s.domains {
                let Some((cf, _)) = cf.as_ref().filter(|_| d.on_cloudflare()) else {
                    continue;
                };
                step!(format!("Receiving for {}", d.name), {
                    let _ = cloud::catch_all(cf, &d.zone_id, false).await;
                    cloud::disable_routing(cf, &d.zone_id).await?;
                    cloud::remove(cf, &d.zone_id, "MX", &d.name, |r| {
                        !r.content.eq_ignore_ascii_case(&host)
                    })
                    .await?;
                    cloud::upsert(
                        cf,
                        &d.zone_id,
                        json!({ "type": "MX", "name": d.name, "content": host, "priority": 10 }),
                        |_| true,
                    )
                    .await?;
                    Ok(format!("MX → {host}, port 25"))
                });
            }
            if let (Some((cf, _)), Some(p)) = (&cf, s.primary().filter(|p| p.on_cloudflare())) {
                let _ = cloud::remove(cf, &p.zone_id, "CNAME", &s.inbound_host(), |r| {
                    r.comment == cloud::MARK
                })
                .await;
            }
        }
        Receive::Cloudflare => {
            // Setup only takes this way with every domain on Cloudflare.
            let Some((cf, cfs)) = &cf else {
                return;
            };
            let inbound = s.inbound_host();
            step!("Email Worker".into(), {
                cloud::deploy_worker(
                    cf,
                    &cfs.account_id,
                    &format!("https://{inbound}/inbound"),
                    &s.secret,
                )
                .await?;
                Ok("posts mail to this server through the tunnel".into())
            });
            step!(format!("Tunnel address {inbound}"), {
                let p = s.primary().ok_or_else(|| anyhow!("no domain"))?;
                tunnel_cname(cf, &cfs.tunnel_id, &p.zone_id, &inbound).await?;
                Ok(inbound.clone())
            });
            for d in &s.domains {
                step!(format!("Email Routing for {}", d.name), {
                    cloud::remove(cf, &d.zone_id, "MX", &d.name, |r| r.comment == cloud::MARK)
                        .await?;
                    cloud::enable_routing(cf, &d.zone_id, &d.name)
                        .await
                        .map_err(|e| {
                            lacks(e, "Zone Settings edit").unwrap_or_else(|e| {
                                anyhow!(
                                    "{e:#} (remove MX records another mail provider left first)"
                                )
                            })
                        })?;
                    cloud::catch_all(cf, &d.zone_id, true)
                        .await
                        .map_err(|e| lacks(e, "Email Routing Rules edit").unwrap_or_else(|e| e))?;
                    Ok(format!("all mail for @{} → this server", d.name))
                });
            }
        }
    }

    if s.apps == Apps::Port || s.receive == Receive::Port {
        step!("Certificate".into(), {
            let p = s.primary().ok_or_else(|| anyhow!("no domain"))?;
            cert::ensure(mail, &host, &p.zone_id, true).await
        });
    }
    step!("Ports".into(), forwards(mail, s).await);

    let Some((cf, cfs)) = &cf else {
        return;
    };
    let a = format!("a:{host}");
    let cloudflare_spf = cloud::CLOUDFLARE_SPF.to_owned();
    for d in s.domains.iter().filter(|d| d.on_cloudflare()) {
        step!(format!("Mail app settings for {}", d.name), {
            for h in [
                format!("autodiscover.{}", d.name),
                format!("autoconfig.{}", d.name),
            ] {
                tunnel_cname(cf, &cfs.tunnel_id, &d.zone_id, &h).await?;
            }
            Ok("found from the address alone".into())
        });
        let mut want = Vec::new();
        let mut drop = Vec::new();
        if s.send == Send::Direct {
            want.push(a.clone());
        } else {
            drop.push(a.clone());
        }
        if s.send == Send::Cloudflare || s.receive == Receive::Cloudflare {
            want.push(cloudflare_spf.clone());
        } else {
            drop.push(cloudflare_spf.clone());
        }
        step!(
            format!("SPF for {}", d.name),
            cloud::spf(cf, &d.zone_id, &d.name, &want, &drop).await
        );
    }
    if s.send == Send::Cloudflare {
        for d in &s.domains {
            step!(format!("Email Sending for {}", d.name), {
                cloud::enable_sending(cf, &d.zone_id, &d.name)
                    .await
                    .map_err(|e| {
                        if refused(&e) {
                            anyhow!(
                                "Cloudflare would not open Email Sending to this token. It lists no \
                                 token permission for it yet, so send Direct or through a relay"
                            )
                        } else {
                            e
                        }
                    })?;
                Ok("mail leaves through Cloudflare".into())
            });
        }
    }
    step!("Tunnel routes".into(), {
        crate::tunnel::sync_ingress(&mail.state).await?;
        Ok("sent to Cloudflare".into())
    });
}

/// Whether Cloudflare turned the token away: code 10000, its answer to a
/// token without the permission a call needs.
fn refused(e: &anyhow::Error) -> bool {
    format!("{e:#}").contains("(code 10000)")
}

/// Which permission the token lacks, for an error Cloudflare turned it away
/// with; any other error comes back as it was.
fn lacks(e: anyhow::Error, permission: &str) -> Result<anyhow::Error, anyhow::Error> {
    if refused(&e) {
        Ok(anyhow!(
            "The Cloudflare token lacks {permission}. Make it again with Make a token on \
             Cloudflare in Settings, Connections"
        ))
    } else {
        Err(e)
    }
}

// ---- the API ----

fn mail() -> ApiResult<Arc<Mail>> {
    get().ok_or_else(|| ApiError::bad("Mail did not start"))
}

fn forbidden(what: &str) -> ApiError {
    ApiError(
        StatusCode::FORBIDDEN,
        format!("Only mail's admins and the managers of {what} can change it"),
    )
}

pub async fn view(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
) -> ApiResult<Json<Value>> {
    let mail = mail()?;
    let s = mail.settings();
    let servers = s.app_servers(&mail).await;
    let mut settings = json!(s);
    settings["secret"] = Value::Null;
    if let Some(r) = settings.get_mut("relay").filter(|r| r.is_object()) {
        r["password_set"] = json!(r["password"].as_str().is_some_and(|p| !p.is_empty()));
        r["password"] = Value::Null;
    }
    let host = s.hostname();
    // The domains this caller runs, and for those who set mail up, who
    // could be made a domain's manager.
    let manages: Vec<&str> = s
        .domains
        .iter()
        .filter(|d| s.runs(&caller, &format!("@{}", d.name)))
        .map(|d| d.name.as_str())
        .collect();
    let people: Vec<Value> = if caller.is_admin() || caller.can("mail.manage") {
        state
            .db
            .users()?
            .into_iter()
            .map(|u| {
                let name = if u.name.is_empty() {
                    u.username
                } else {
                    u.name
                };
                json!({ "id": u.id, "name": name })
            })
            .collect()
    } else {
        Vec::new()
    };
    Ok(Json(json!({
        "settings": settings,
        "hostname": host,
        "job": lock(&mail.job).clone(),
        "accounts": mail.store.accounts()?,
        "aliases": mail.store.aliases()?.into_iter().map(|(a, t)| json!({ "alias": a, "target": t })).collect::<Vec<_>>(),
        "queued": mail.store.queued()?.len(),
        "certificate": cert::issued(&mail, &host),
        "servers": servers.map(|(ih, ip, sh, sp)| json!({ "imap_host": ih, "imap_port": ip, "smtp_host": sh, "smtp_port": sp })),
        "manages": manages,
        "people": people,
    })))
}

/// The records every domain needs, checked against DNS now.
pub async fn records(State(_): State<AppState>) -> ApiResult<Json<Value>> {
    let mail = mail()?;
    let s = mail.settings();
    let mut out = Vec::new();
    for d in &s.domains {
        out.push(json!({
            "domain": d.name,
            "cloudflare": d.on_cloudflare(),
            "records": wanted(&mail, &s, d).await?,
        }));
    }
    Ok(Json(json!(out)))
}

pub async fn zones(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let cf = state.cloudflare()?;
    let list = Cloudflare::new(&state.http, &cf.token)
        .zones(&cf.account_id)
        .await?;
    Ok(Json(json!(list)))
}

#[derive(Deserialize)]
pub struct RelayIn {
    host: String,
    port: u16,
    security: String,
    #[serde(default)]
    username: String,
    password: Option<String>,
}

#[derive(Deserialize)]
pub struct SetupIn {
    /// The domain to set up first, when none is yet: a Cloudflare zone, or
    /// a name whose records are added by hand.
    zone_id: Option<String>,
    domain: Option<String>,
    receive: Receive,
    apps: Apps,
    send: Send,
    relay: Option<RelayIn>,
}

async fn zone_named(state: &AppState, zone_id: &str) -> ApiResult<Domain> {
    let cf = state.cloudflare()?;
    let zone = Cloudflare::new(&state.http, &cf.token)
        .zones(&cf.account_id)
        .await?
        .into_iter()
        .find(|z| z.id == zone_id)
        .ok_or_else(|| ApiError::bad("That domain is not on this Cloudflare account"))?;
    Ok(Domain {
        name: zone.name.to_ascii_lowercase(),
        zone_id: zone.id,
        managers: Vec::new(),
        host: String::new(),
    })
}

/// A domain whose records are added by hand, or kept at the registrar `host`.
fn by_hand(name: &str, host: &str) -> ApiResult<Domain> {
    if !host.is_empty() && !crate::registrar::HOSTS.contains(&host) {
        return Err(ApiError::bad("Pick where the domain's DNS is hosted"));
    }
    let name = name
        .trim()
        .trim_start_matches('@')
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let ok = name.len() <= 253
        && name.contains('.')
        && name.split('.').all(|l| {
            !l.is_empty()
                && l.len() <= 63
                && !l.starts_with('-')
                && !l.ends_with('-')
                && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        });
    if !ok {
        return Err(ApiError::bad("Enter a domain, such as example.com"));
    }
    Ok(Domain {
        name,
        zone_id: String::new(),
        managers: Vec::new(),
        host: host.to_owned(),
    })
}

/// The Cloudflare ways need every domain's records on Cloudflare.
fn cloudflare_ways(s: &Settings) -> ApiResult<()> {
    if s.receive != Receive::Cloudflare && s.send != Send::Cloudflare {
        return Ok(());
    }
    match s.domains.iter().find(|d| !d.on_cloudflare()) {
        Some(d) => Err(ApiError::bad(format!(
            "{} keeps its records by hand; receiving and sending through Cloudflare need every domain on Cloudflare",
            d.name
        ))),
        None => Ok(()),
    }
}

fn start(mail: &Arc<Mail>) {
    tokio::spawn(apply(mail.clone()));
}

pub async fn setup(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Json(body): Json<SetupIn>,
) -> ApiResult<Json<Value>> {
    let mail = mail()?;
    if lock(&mail.job).running {
        return Err(ApiError::conflict("Setup is already running"));
    }
    let mut s = mail.settings();
    let first = match (body.zone_id.filter(|z| !z.is_empty()), body.domain) {
        (Some(z), _) => Some(zone_named(&state, &z).await?),
        (None, Some(n)) if !n.trim().is_empty() => Some(by_hand(&n, "")?),
        _ => None,
    };
    if let Some(d) = first {
        s.domains.retain(|o| !o.name.eq_ignore_ascii_case(&d.name));
        s.domains.insert(0, d);
    }
    if s.domains.is_empty() {
        return Err(ApiError::bad("Pick a domain"));
    }
    if body.send == Send::Relay {
        let r = body
            .relay
            .ok_or_else(|| ApiError::bad("Enter the relay server"))?;
        if r.host.trim().is_empty() || r.port == 0 {
            return Err(ApiError::bad("Enter the relay's server and port"));
        }
        if !matches!(r.security.as_str(), "tls" | "starttls" | "none") {
            return Err(ApiError::bad("Pick how the relay is secured"));
        }
        let old = s.relay.take().map(|o| o.password).unwrap_or_default();
        s.relay = Some(Smtp {
            host: r.host.trim().to_owned(),
            port: r.port,
            security: r.security,
            username: r.username.trim().to_owned(),
            password: r.password.filter(|p| !p.is_empty()).unwrap_or(old),
            from: String::new(),
        });
    }
    s.receive = body.receive;
    s.apps = body.apps;
    s.send = body.send;
    cloudflare_ways(&s)?;
    if s.secret.is_empty() {
        s.secret = random_hex(32);
    }
    s.on = true;
    mail.save(s)?;
    start(&mail);
    view(State(state), Extension(caller)).await
}

pub async fn rerun(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
) -> ApiResult<Json<Value>> {
    let mail = mail()?;
    if !mail.settings().ready() {
        return Err(ApiError::bad("Set mail up first"));
    }
    start(&mail);
    view(State(state), Extension(caller)).await
}

/// Stops mail: its ports close and Cloudflare stops handing it mail. DNS
/// records, accounts and mail are kept.
pub async fn off(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
) -> ApiResult<Json<Value>> {
    let mail = mail()?;
    let s = mail.settings();
    for f in mail
        .state
        .db
        .forwards()?
        .iter()
        .filter(|f| s.forwards.contains(&f.id))
    {
        crate::forward::take_down(&state, f).await?;
    }
    if s.receive == Receive::Cloudflare {
        if let Ok(cfs) = cloud::settings(&mail) {
            let cf = Cloudflare::new(&state.http, &cfs.token);
            for d in s.domains.iter().filter(|d| d.on_cloudflare()) {
                if let Err(err) = cloud::catch_all(&cf, &d.zone_id, false).await {
                    tracing::warn!("Email Routing is still on for {}: {err:#}", d.name);
                }
            }
        }
    }
    mail.update(|m| {
        m.on = false;
        m.forwards.clear();
    })?;
    if s.needs_cloudflare() {
        let _ = crate::tunnel::sync_ingress(&state).await;
    }
    view(State(state), Extension(caller)).await
}

#[derive(Deserialize)]
pub struct DomainIn {
    /// A Cloudflare zone, or a name whose records are added by hand.
    zone_id: Option<String>,
    name: Option<String>,
    /// Where its DNS is hosted, for a domain kept by hand.
    #[serde(default)]
    host: String,
}

pub async fn add_domain(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Json(body): Json<DomainIn>,
) -> ApiResult<Json<Value>> {
    let mail = mail()?;
    let d = match (body.zone_id.filter(|z| !z.is_empty()), body.name) {
        (Some(z), _) => zone_named(&state, &z).await?,
        (None, Some(n)) => by_hand(&n, &body.host)?,
        (None, None) => return Err(ApiError::bad("Enter a domain")),
    };
    if !d.host.is_empty() {
        // The registrar must answer for it before it is added.
        crate::registrar::list(&state, crate::registrar::Zone::Registrar(&d.host), &d.name).await?;
    }
    let mut s = mail.settings();
    if s.is_local(&d.name) {
        return Err(ApiError::conflict(format!("{} is already here", d.name)));
    }
    s.domains.push(d);
    let ready = s.ready();
    mail.save(s)?;
    if ready {
        start(&mail);
    }
    view(State(state), Extension(caller)).await
}

#[derive(Deserialize)]
pub struct DomainEdit {
    /// Moves its records onto Cloudflare, to the zone of the same name, or
    /// back to being kept by hand.
    cloudflare: Option<bool>,
    /// Dashboard account IDs.
    managers: Option<Vec<String>>,
    /// Makes it the primary domain, which names the server.
    primary: Option<bool>,
}

pub async fn edit_domain(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path(name): Path<String>,
    Json(body): Json<DomainEdit>,
) -> ApiResult<Json<Value>> {
    let mail = mail()?;
    let mut s = mail.settings();
    let Some(i) = s
        .domains
        .iter()
        .position(|d| d.name.eq_ignore_ascii_case(&name))
    else {
        return Err(ApiError::not_found());
    };
    let mut moved = false;
    if let Some(on) = body.cloudflare {
        if on != s.domains[i].on_cloudflare() {
            s.domains[i].zone_id = if on {
                let cf = state.cloudflare()?;
                Cloudflare::new(&state.http, &cf.token)
                    .zones(&cf.account_id)
                    .await?
                    .into_iter()
                    .find(|z| z.name.eq_ignore_ascii_case(&name))
                    .map(|z| z.id)
                    .ok_or_else(|| {
                        ApiError::bad(format!("{name} is not on this Cloudflare account"))
                    })?
            } else {
                String::new()
            };
            moved = true;
        }
    }
    if let Some(ids) = body.managers {
        for id in &ids {
            if state.db.user(id)?.is_none() {
                return Err(ApiError::bad("One of those accounts no longer exists"));
            }
        }
        s.domains[i].managers = ids;
    }
    if body.primary == Some(true) && i > 0 {
        let d = s.domains.remove(i);
        s.domains.insert(0, d);
        moved = true;
    }
    cloudflare_ways(&s)?;
    let ready = s.ready();
    mail.save(s)?;
    if moved && ready {
        start(&mail);
    }
    view(State(state), Extension(caller)).await
}

pub async fn remove_domain(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path(name): Path<String>,
) -> ApiResult<Json<Value>> {
    let mail = mail()?;
    let s = mail.settings();
    let Some(i) = s
        .domains
        .iter()
        .position(|d| d.name.eq_ignore_ascii_case(&name))
    else {
        return Err(ApiError::not_found());
    };
    if i == 0 && s.domains.len() > 1 {
        return Err(ApiError::bad(
            "The first domain names the server; remove the others first",
        ));
    }
    if s.receive == Receive::Cloudflare && s.domains[i].on_cloudflare() {
        if let Ok(cfs) = cloud::settings(&mail) {
            let _ = cloud::catch_all(
                &Cloudflare::new(&state.http, &cfs.token),
                &s.domains[i].zone_id,
                false,
            )
            .await;
        }
    }
    mail.update(|m| {
        m.domains.remove(i);
        if m.domains.is_empty() {
            m.on = false;
        }
    })?;
    view(State(state), Extension(caller)).await
}

#[derive(Deserialize)]
pub struct OptionsIn {
    reject_dmarc: Option<bool>,
    save_sent: Option<bool>,
}

pub async fn options(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Json(body): Json<OptionsIn>,
) -> ApiResult<Json<Value>> {
    mail()?.update(|m| {
        if let Some(v) = body.reject_dmarc {
            m.reject_dmarc = v;
        }
        if let Some(v) = body.save_sent {
            m.save_sent = v;
        }
    })?;
    view(State(state), Extension(caller)).await
}

#[derive(Deserialize)]
pub struct AccountIn {
    address: String,
    #[serde(default)]
    name: String,
    password: String,
}

fn hash(password: &str) -> ApiResult<String> {
    if !crate::secret::strong(password) {
        return Err(ApiError::bad(crate::secret::RULE));
    }
    Ok(crate::secret::hash(password)?)
}

pub async fn add_account(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Json(body): Json<AccountIn>,
) -> ApiResult<Json<Value>> {
    let mail = mail()?;
    let address = body.address.trim().to_ascii_lowercase();
    let (local, domain) = address.rsplit_once('@').unwrap_or(("", ""));
    let ok_local = !local.is_empty()
        && local.len() <= 64
        && local
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "!#$%&'*+=?^_{|}~.-".contains(c))
        && !local.starts_with('.')
        && !local.contains("..");
    if !ok_local {
        return Err(ApiError::bad("That is not an email address"));
    }
    let s = mail.settings();
    if !s.is_local(domain) {
        return Err(ApiError::bad("Use one of this server's domains"));
    }
    if !s.runs(&caller, &address) {
        return Err(forbidden(domain));
    }
    let h = hash(&body.password)?;
    mail.store
        .add_account(&address, body.name.trim(), &h)
        .map_err(|e| ApiError::conflict(e.to_string()))?;
    view(State(state), Extension(caller)).await
}

#[derive(Deserialize)]
pub struct AccountEdit {
    name: Option<String>,
    password: Option<String>,
    apps: Option<bool>,
}

pub async fn edit_account(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path(address): Path<String>,
    Json(body): Json<AccountEdit>,
) -> ApiResult<Json<Value>> {
    let mail = mail()?;
    if !mail.store.exists(&address) {
        return Err(ApiError::not_found());
    }
    if !mail.settings().runs(&caller, &address) {
        return Err(forbidden(&address));
    }
    let h = body.password.as_deref().map(hash).transpose()?;
    mail.store.edit_account(
        &address,
        body.name.as_deref().map(str::trim),
        h.as_deref(),
        body.apps,
    )?;
    view(State(state), Extension(caller)).await
}

pub async fn delete_account(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path(address): Path<String>,
) -> ApiResult<Json<Value>> {
    let mail = mail()?;
    if !mail.settings().runs(&caller, &address) {
        return Err(forbidden(&address));
    }
    mail.store.delete_account(&address)?;
    view(State(state), Extension(caller)).await
}

#[derive(Deserialize)]
pub struct AliasIn {
    /// An address, or `@domain` for everything else at it.
    alias: String,
    target: String,
}

pub async fn set_alias(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Json(body): Json<AliasIn>,
) -> ApiResult<Json<Value>> {
    let mail = mail()?;
    let alias = body.alias.trim().to_ascii_lowercase();
    let target = body.target.trim();
    let domain = alias.rsplit_once('@').map_or("", |(_, d)| d);
    let s = mail.settings();
    if !s.is_local(domain) {
        return Err(ApiError::bad("Use one of this server's domains"));
    }
    if !mail.store.exists(target) {
        return Err(ApiError::bad("Send it to one of the accounts"));
    }
    // Both ends must be the caller's to run.
    if !s.runs(&caller, &alias) || !s.runs(&caller, target) {
        return Err(forbidden(domain));
    }
    mail.store.set_alias(&alias, target)?;
    view(State(state), Extension(caller)).await
}

pub async fn delete_alias(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path(alias): Path<String>,
) -> ApiResult<Json<Value>> {
    let mail = mail()?;
    if !mail.settings().runs(&caller, &alias) {
        return Err(forbidden(&alias));
    }
    mail.store.delete_alias(&alias)?;
    view(State(state), Extension(caller)).await
}

pub async fn log(State(_): State<AppState>) -> ApiResult<Json<Value>> {
    Ok(Json(json!(mail()?.store.logs(200)?)))
}

pub async fn retry(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
) -> ApiResult<Json<Value>> {
    let mail = mail()?;
    mail.store.retry_all()?;
    mail.wake.notify_one();
    view(State(state), Extension(caller)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    fn sample() -> Arc<Mail> {
        let dir = std::env::temp_dir().join(format!("mail-e2e-{}", random_hex(6)));
        std::fs::create_dir_all(&dir).unwrap();
        let mut config = crate::config::Config::from_env();
        config.data_dir = dir.clone();
        let db = crate::db::Db::open(&dir.join("gateway.db"), crate::vault::Vault::new(&[7; 32]))
            .unwrap();
        let state = AppState::new(config, db).unwrap();
        let settings = Settings {
            domains: vec![Domain {
                name: "example.com".into(),
                zone_id: "z1".into(),
                managers: Vec::new(),
                host: String::new(),
            }],
            on: true,
            save_sent: true,
            ..Settings::default()
        };
        let mail = Arc::new(Mail {
            store: Store::open(&dir.join("mail.db")).unwrap(),
            state,
            settings: RwLock::new(settings),
            wake: Notify::new(),
            job: Mutex::new(Job::default()),
            keys: Mutex::new(HashMap::new()),
        });
        let hash = crate::secret::hash("Sample-pass-1").unwrap();
        mail.store
            .add_account("sam@example.com", "Sam", &hash)
            .unwrap();
        mail
    }

    /// Sends `line` and reads until a line starting with `until`, returning
    /// everything read.
    async fn say<R: tokio::io::AsyncBufRead + Unpin, W: tokio::io::AsyncWrite + Unpin>(
        r: &mut R,
        w: &mut W,
        line: &str,
        until: &str,
    ) -> String {
        if !line.is_empty() {
            w.write_all(format!("{line}\r\n").as_bytes()).await.unwrap();
        }
        let mut all = String::new();
        loop {
            let mut l = String::new();
            if r.read_line(&mut l).await.unwrap() == 0 {
                return all;
            }
            all.push_str(&l);
            if l.starts_with(until) {
                return all;
            }
        }
    }

    #[test]
    fn domains_by_hand_are_checked() {
        let d = by_hand(" @Example.COM. ", "").unwrap();
        assert_eq!(d.name, "example.com");
        assert!(!d.on_cloudflare());
        for bad in ["example", "-a.com", "a..com", "a b.com", ""] {
            assert!(by_hand(bad, "").is_err(), "{bad}");
        }
        assert_eq!(by_hand("a.com", "porkbun").unwrap().host, "porkbun");
        assert!(by_hand("a.com", "nowhere").is_err());
    }

    #[test]
    fn cloudflare_ways_need_every_domain_there() {
        let mut s = Settings {
            domains: vec![by_hand("a.com", "").unwrap()],
            ..Settings::default()
        };
        assert!(cloudflare_ways(&s).is_ok() && !s.needs_cloudflare());
        s.receive = Receive::Cloudflare;
        assert!(cloudflare_ways(&s).is_err());
        s.domains[0].zone_id = "z1".into();
        assert!(cloudflare_ways(&s).is_ok());
    }

    #[tokio::test]
    async fn a_mail_app_reads_what_arrived() {
        let mail = sample();
        mail.deliver_local(
            "sam@example.com",
            false,
            b"From: Lee <lee@example.org>\r\nTo: sam@example.com\r\nSubject: hi\r\n\r\nhello there\r\n",
        )
        .unwrap();
        let (client, server) = tokio::io::duplex(1 << 16);
        tokio::spawn(imap::serve(
            mail.clone(),
            Box::new(server),
            IpAddr::from([127, 0, 0, 1]),
        ));
        let (r, mut w) = tokio::io::split(client);
        let mut r = BufReader::new(r);
        assert!(say(&mut r, &mut w, "", "* OK").await.contains("IMAP4rev1"));
        let bad = say(&mut r, &mut w, "a LOGIN sam@example.com wrong", "a ").await;
        assert!(bad.contains("a NO"));
        let ok = say(
            &mut r,
            &mut w,
            "b LOGIN sam@example.com Sample-pass-1",
            "b ",
        )
        .await;
        assert!(ok.contains("b OK"), "{ok}");
        let list = say(&mut r, &mut w, "c LIST \"\" \"*\"", "c ").await;
        assert!(
            list.contains("\\Sent") && list.contains("\"INBOX\""),
            "{list}"
        );
        let sel = say(&mut r, &mut w, "d SELECT INBOX", "d ").await;
        assert!(
            sel.contains("* 1 EXISTS") && sel.contains("d OK [READ-WRITE]"),
            "{sel}"
        );
        let env = say(&mut r, &mut w, "e UID FETCH 1:* (FLAGS ENVELOPE)", "e ").await;
        assert!(
            env.contains("UID 1")
                && env.contains("\"hi\"")
                && env.contains("\"lee\" \"example.org\""),
            "{env}"
        );
        let body = say(&mut r, &mut w, "f FETCH 1 BODY[TEXT]", "f ").await;
        assert!(
            body.contains("hello there") && body.contains("\\Seen"),
            "{body}"
        );
        let search = say(&mut r, &mut w, "g SEARCH UNSEEN", "g ").await;
        assert!(search.contains("* SEARCH\r\n"), "{search}");
        say(&mut r, &mut w, "h STORE 1 +FLAGS.SILENT (\\Deleted)", "h ").await;
        let gone = say(&mut r, &mut w, "i EXPUNGE", "i ").await;
        assert!(gone.contains("* 1 EXPUNGE"), "{gone}");
        say(&mut r, &mut w, "j LOGOUT", "j ").await;
    }

    #[tokio::test]
    async fn a_mail_app_sends_to_a_local_account() {
        let mail = sample();
        let (client, server) = tokio::io::duplex(1 << 16);
        tokio::spawn(smtp::serve(
            mail.clone(),
            Box::new(server),
            IpAddr::from([127, 0, 0, 1]),
            smtp::Mode::Submission,
            true,
        ));
        let (r, mut w) = tokio::io::split(client);
        let mut r = BufReader::new(r);
        say(&mut r, &mut w, "", "220 ").await;
        assert!(say(&mut r, &mut w, "EHLO client.example.com", "250 ")
            .await
            .contains("AUTH PLAIN"));
        assert!(say(&mut r, &mut w, "MAIL FROM:<sam@example.com>", "530")
            .await
            .starts_with("530"));
        use base64::Engine;
        let creds =
            base64::engine::general_purpose::STANDARD.encode("\0sam@example.com\0Sample-pass-1");
        assert!(say(&mut r, &mut w, &format!("AUTH PLAIN {creds}"), "2")
            .await
            .starts_with("235"));
        assert!(say(&mut r, &mut w, "MAIL FROM:<lee@example.org>", "5")
            .await
            .starts_with("553"));
        say(&mut r, &mut w, "MAIL FROM:<sam@example.com>", "250").await;
        assert!(say(&mut r, &mut w, "RCPT TO:<nobody@example.com>", "5")
            .await
            .starts_with("550"));
        say(&mut r, &mut w, "RCPT TO:<sam+notes@example.com>", "250").await;
        say(&mut r, &mut w, "DATA", "354").await;
        let done = say(
            &mut r,
            &mut w,
            "From: sam@example.com\r\nTo: sam+notes@example.com\r\nSubject: note\r\n\r\n..dotted\r\n.",
            "250",
        )
        .await;
        assert!(done.starts_with("250"), "{done}");
        say(&mut r, &mut w, "QUIT", "221").await;
        let inbox = mail.store.snapshot("sam@example.com", "INBOX").unwrap();
        assert_eq!(inbox.messages.len(), 1);
        let raw = mail
            .store
            .read("sam@example.com", "INBOX", inbox.messages[0].uid)
            .unwrap();
        let text = String::from_utf8_lossy(&raw);
        assert!(
            text.contains("Message-ID: <") && text.contains("\r\n.dotted\r\n"),
            "{text}"
        );
        assert_eq!(
            mail.store
                .snapshot("sam@example.com", "Sent")
                .unwrap()
                .messages
                .len(),
            1
        );
    }
}
