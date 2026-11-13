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

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::Duration;

use anyhow::{anyhow, Result};
use axum::extract::{Path, State};
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
    pub zone_id: String,
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
        self.domains
            .iter()
            .any(|d| d.name.eq_ignore_ascii_case(domain))
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
        let (by_ip, by_user) = (format!("mail-ip:{ip}"), format!("mail-user:{user}"));
        if self.state.locked_out(&by_ip) || self.state.locked_out(&by_user) {
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
                self.state.clear_failures(&by_user);
                Ok(a.address)
            }
            Some(_) => {
                self.state.record_failure(&by_ip);
                self.state.record_failure(&by_user);
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
    let cfs = cloud::settings(mail)?;
    let cf = Cloudflare::new(&mail.state.http, &cfs.token);
    let host = s.hostname();
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

/// Puts everything the settings ask for in place, step by step.
async fn apply(mail: Arc<Mail>) {
    let s = mail.settings();
    let n = s.domains.len();
    let total = 4
        + n * 3
        + match s.receive {
            Receive::Port => n,
            Receive::Cloudflare => 2 + n,
        }
        + usize::from(s.apps == Apps::Port || s.receive == Receive::Port)
        + if s.send == Send::Cloudflare { n } else { 0 };
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
    let cfs = match cloud::settings(mail) {
        Ok(c) => c,
        Err(e) => {
            mail.record("Cloudflare", Err(e));
            return;
        }
    };
    let cf = Cloudflare::new(&mail.state.http, &cfs.token);
    let tunnel = format!("{}.cfargotunnel.com", cfs.tunnel_id);
    let cname = |host: String, zone: String| {
        let cf = &cf;
        let tunnel = tunnel.clone();
        async move {
            cloud::upsert(
                cf,
                &zone,
                json!({ "type": "CNAME", "name": host, "content": tunnel, "proxied": true }),
                |r| r.kind == "CNAME",
            )
            .await
        }
    };
    let host = s.hostname();

    for d in &s.domains {
        step!(format!("DKIM for {}", d.name), {
            let key = mail.make_dkim_key(&d.name).await?;
            let name = format!("{SELECTOR}._domainkey.{}", d.name);
            cloud::upsert(
                &cf,
                &d.zone_id,
                json!({ "type": "TXT", "name": name, "content": auth::record(&key) }),
                |_| true,
            )
            .await?;
            Ok(name)
        });
        step!(
            format!("DMARC for {}", d.name),
            cloud::dmarc(&cf, &d.zone_id, &d.name).await
        );
    }
    step!(format!("Address of {host}"), address_record(mail, s).await);

    match s.receive {
        Receive::Port => {
            for d in &s.domains {
                step!(format!("Receiving for {}", d.name), {
                    let _ = cloud::catch_all(&cf, &d.zone_id, false).await;
                    cloud::disable_routing(&cf, &d.zone_id).await?;
                    cloud::remove(&cf, &d.zone_id, "MX", &d.name, |r| {
                        !r.content.eq_ignore_ascii_case(&host)
                    })
                    .await?;
                    cloud::upsert(
                        &cf,
                        &d.zone_id,
                        json!({ "type": "MX", "name": d.name, "content": host, "priority": 10 }),
                        |_| true,
                    )
                    .await?;
                    Ok(format!("MX → {host}, port 25"))
                });
            }
            if let Some(p) = s.primary() {
                let _ = cloud::remove(&cf, &p.zone_id, "CNAME", &s.inbound_host(), |r| {
                    r.comment == cloud::MARK
                })
                .await;
            }
        }
        Receive::Cloudflare => {
            let inbound = s.inbound_host();
            step!("Email Worker".into(), {
                cloud::deploy_worker(
                    &cf,
                    &cfs.account_id,
                    &format!("https://{inbound}/inbound"),
                    &s.secret,
                )
                .await?;
                Ok("posts mail to this server through the tunnel".into())
            });
            step!(format!("Tunnel address {inbound}"), {
                let p = s.primary().ok_or_else(|| anyhow!("no domain"))?;
                cname(inbound.clone(), p.zone_id.clone()).await?;
                Ok(inbound.clone())
            });
            for d in &s.domains {
                step!(format!("Email Routing for {}", d.name), {
                    cloud::remove(&cf, &d.zone_id, "MX", &d.name, |r| r.comment == cloud::MARK)
                        .await?;
                    cloud::enable_routing(&cf, &d.zone_id, &d.name)
                        .await
                        .map_err(|e| {
                            anyhow!("{e:#} (remove MX records another mail provider left first)")
                        })?;
                    cloud::catch_all(&cf, &d.zone_id, true).await?;
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
    for d in &s.domains {
        step!(format!("Mail app settings for {}", d.name), {
            for h in [
                format!("autodiscover.{}", d.name),
                format!("autoconfig.{}", d.name),
            ] {
                cname(h, d.zone_id.clone()).await?;
            }
            Ok("found from the address alone".into())
        });
    }

    let a = format!("a:{host}");
    let cloudflare_spf = cloud::CLOUDFLARE_SPF.to_owned();
    for d in &s.domains {
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
            cloud::spf(&cf, &d.zone_id, &d.name, &want, &drop).await
        );
        if s.send == Send::Cloudflare {
            step!(format!("Email Sending for {}", d.name), {
                cloud::enable_sending(&cf, &d.zone_id, &d.name)
                    .await
                    .map_err(|e| anyhow!("{e:#} (Email Sending needs the Workers Paid plan)"))?;
                Ok("mail leaves through Cloudflare".into())
            });
        }
    }
    step!("Tunnel routes".into(), {
        crate::tunnel::sync_ingress(&mail.state).await?;
        Ok("sent to Cloudflare".into())
    });
}

// ---- the API ----

fn mail() -> ApiResult<Arc<Mail>> {
    get().ok_or_else(|| ApiError::bad("Mail did not start"))
}

pub async fn view(State(_): State<AppState>) -> ApiResult<Json<Value>> {
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
    Ok(Json(json!({
        "settings": settings,
        "hostname": host,
        "job": lock(&mail.job).clone(),
        "accounts": mail.store.accounts()?,
        "aliases": mail.store.aliases()?.into_iter().map(|(a, t)| json!({ "alias": a, "target": t })).collect::<Vec<_>>(),
        "queued": mail.store.queued()?.len(),
        "certificate": cert::issued(&mail, &host),
        "servers": servers.map(|(ih, ip, sh, sp)| json!({ "imap_host": ih, "imap_port": ip, "smtp_host": sh, "smtp_port": sp })),
    })))
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
    /// The domain to set up first, when none is yet.
    zone_id: Option<String>,
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
    })
}

fn start(mail: &Arc<Mail>) {
    tokio::spawn(apply(mail.clone()));
}

pub async fn setup(
    State(state): State<AppState>,
    Json(body): Json<SetupIn>,
) -> ApiResult<Json<Value>> {
    let mail = mail()?;
    if lock(&mail.job).running {
        return Err(ApiError::conflict("Setup is already running"));
    }
    let mut s = mail.settings();
    if let Some(z) = body.zone_id.filter(|z| !z.is_empty()) {
        let d = zone_named(&state, &z).await?;
        s.domains.retain(|o| o.zone_id != d.zone_id);
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
    if s.secret.is_empty() {
        s.secret = random_hex(32);
    }
    s.on = true;
    mail.save(s)?;
    start(&mail);
    view(State(state)).await
}

pub async fn rerun(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let mail = mail()?;
    if !mail.settings().ready() {
        return Err(ApiError::bad("Set mail up first"));
    }
    start(&mail);
    view(State(state)).await
}

/// Stops mail: its ports close and Cloudflare stops handing it mail. DNS
/// records, accounts and mail are kept.
pub async fn off(State(state): State<AppState>) -> ApiResult<Json<Value>> {
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
            for d in &s.domains {
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
    let _ = crate::tunnel::sync_ingress(&state).await;
    view(State(state)).await
}

#[derive(Deserialize)]
pub struct DomainIn {
    zone_id: String,
}

pub async fn add_domain(
    State(state): State<AppState>,
    Json(body): Json<DomainIn>,
) -> ApiResult<Json<Value>> {
    let mail = mail()?;
    let d = zone_named(&state, &body.zone_id).await?;
    if mail.settings().is_local(&d.name) {
        return Err(ApiError::conflict(format!("{} is already here", d.name)));
    }
    mail.update(|m| m.domains.push(d))?;
    if mail.settings().ready() {
        start(&mail);
    }
    view(State(state)).await
}

pub async fn remove_domain(
    State(state): State<AppState>,
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
    if s.receive == Receive::Cloudflare {
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
    view(State(state)).await
}

#[derive(Deserialize)]
pub struct OptionsIn {
    reject_dmarc: Option<bool>,
    save_sent: Option<bool>,
}

pub async fn options(
    State(state): State<AppState>,
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
    view(State(state)).await
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
    if !mail.settings().is_local(domain) {
        return Err(ApiError::bad("Use one of this server's domains"));
    }
    let h = hash(&body.password)?;
    mail.store
        .add_account(&address, body.name.trim(), &h)
        .map_err(|e| ApiError::conflict(e.to_string()))?;
    view(State(state)).await
}

#[derive(Deserialize)]
pub struct AccountEdit {
    name: Option<String>,
    password: Option<String>,
    apps: Option<bool>,
}

pub async fn edit_account(
    State(state): State<AppState>,
    Path(address): Path<String>,
    Json(body): Json<AccountEdit>,
) -> ApiResult<Json<Value>> {
    let mail = mail()?;
    if !mail.store.exists(&address) {
        return Err(ApiError::not_found());
    }
    let h = body.password.as_deref().map(hash).transpose()?;
    mail.store.edit_account(
        &address,
        body.name.as_deref().map(str::trim),
        h.as_deref(),
        body.apps,
    )?;
    view(State(state)).await
}

pub async fn delete_account(
    State(state): State<AppState>,
    Path(address): Path<String>,
) -> ApiResult<Json<Value>> {
    mail()?.store.delete_account(&address)?;
    view(State(state)).await
}

#[derive(Deserialize)]
pub struct AliasIn {
    /// An address, or `@domain` for everything else at it.
    alias: String,
    target: String,
}

pub async fn set_alias(
    State(state): State<AppState>,
    Json(body): Json<AliasIn>,
) -> ApiResult<Json<Value>> {
    let mail = mail()?;
    let alias = body.alias.trim().to_ascii_lowercase();
    let domain = alias.rsplit_once('@').map_or("", |(_, d)| d);
    if !mail.settings().is_local(domain) {
        return Err(ApiError::bad("Use one of this server's domains"));
    }
    if !mail.store.exists(body.target.trim()) {
        return Err(ApiError::bad("Send it to one of the accounts"));
    }
    mail.store.set_alias(&alias, body.target.trim())?;
    view(State(state)).await
}

pub async fn delete_alias(
    State(state): State<AppState>,
    Path(alias): Path<String>,
) -> ApiResult<Json<Value>> {
    mail()?.store.delete_alias(&alias)?;
    view(State(state)).await
}

pub async fn log(State(_): State<AppState>) -> ApiResult<Json<Value>> {
    Ok(Json(json!(mail()?.store.logs(200)?)))
}

pub async fn retry(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let mail = mail()?;
    mail.store.retry_all()?;
    mail.wake.notify_one();
    view(State(state)).await
}

