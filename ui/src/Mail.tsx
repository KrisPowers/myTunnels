import { useCallback, useContext, useEffect, useState, type FormEvent } from "react";
import { NeedsContext } from "./Apps";
import { useCloudflare, useCloudflareReady } from "./Cloudflare";
import { api, bytes, message, type MailApps, type MailLog, type MailReceive, type MailSend, type MailState, type Zone } from "./api";
import { Dropdown, type Option } from "./Dropdown";
import { Icon, type IconName } from "./Icon";
import { useCan } from "./me";
import { Callout, Card, Copy, Dialog, MoreMenu, Row, Switch, TextField, useNotify, type MenuAction } from "./ui";

// Each part's ways, as the switches at setup show them.
const RECEIVE: Option<MailReceive>[] = [
  { value: "port", label: "Port forward", icon: "router", hint: "Other servers reach port 25 on your router; the MX record points at this network" },
  { value: "cloudflare", label: "Cloudflare", icon: "cloud", hint: "Cloudflare Email Routing takes the mail and hands it over through the tunnel" },
];
const APPS: Option<MailApps>[] = [
  { value: "port", label: "Port forward", icon: "router", hint: "IMAP on 993 and SMTP on 465 through your router, with a Let's Encrypt certificate" },
  { value: "tailscale", label: "Tailscale", icon: "lan", hint: "IMAP on 443 and SMTP on 8443 through Tailscale Funnel; no router ports" },
];
const SEND: Option<MailSend>[] = [
  { value: "direct", label: "Direct", icon: "router", hint: "From this computer to each recipient's server on port 25" },
  { value: "relay", label: "Relay", icon: "swap_horiz", hint: "Through another SMTP server, such as your internet provider's" },
  { value: "cloudflare", label: "Cloudflare", icon: "cloud", hint: "Through Cloudflare Email Sending, on the Workers Paid plan" },
];
const SECURITY: Option<string>[] = [
  { value: "tls", label: "TLS", hint: "Usually port 465" },
  { value: "starttls", label: "STARTTLS", hint: "Usually port 587" },
  { value: "none", label: "None" },
];

const labelOf = <T,>(options: Option<T>[], v: T) => options.find((o) => o.value === v)?.label ?? String(v);

function Seg<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Option<T>[]; onChange: (v: T) => void }) {
  return (
    <div className="seg-tabs method-tabs" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={o.value === value} className={o.value === value ? "on" : undefined}
          disabled={o.disabled} title={o.hint} onClick={() => onChange(o.value)}>
          {o.icon && <Icon name={o.icon} size={18} />}{o.label}
        </button>
      ))}
    </div>
  );
}

// MailSetup picks the domain, then the way each part of mail is reached:
// receiving, mail apps and sending.
function MailSetup({ state, onDone }: { state: MailState; onDone: (s: MailState) => void }) {
  const needs = useContext(NeedsContext);
  const ready = useCloudflareReady();
  const cloudflare = useCloudflare();
  const s = state.settings;
  const first = s.domains.length === 0;
  const [zones, setZones] = useState<Zone[] | null>(null);
  const [zone, setZone] = useState("");
  const [receive, setReceive] = useState<MailReceive>(s.receive);
  const [apps, setApps] = useState<MailApps>(s.apps);
  const [send, setSend] = useState<MailSend>(s.send);
  const [host, setHost] = useState(s.relay?.host ?? "");
  const [port, setPort] = useState(String(s.relay?.port ?? 587));
  const [security, setSecurity] = useState(s.relay?.security ?? "starttls");
  const [username, setUsername] = useState(s.relay?.username ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const notify = useNotify();

  useEffect(() => {
    if (!first || !ready) return;
    api.mailZones().then((z) => {
      setZones(z);
      if (z.length) setZone(z[0].id);
    }).catch((e) => notify(message(e), "bad"));
  }, [first, ready, notify]);

  const appOptions = APPS.map((o) => o.value === "tailscale" && needs && !needs.tailscale ? { ...o, disabled: true, hint: "Install Tailscale from Apps" } : o);
  const relayReady = send !== "relay" || (!!host.trim() && Number(port) > 0 && (!!password || !!s.relay?.password_set || !username.trim()));
  const go = !busy && (!first || !!zone) && relayReady;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!cloudflare() || !go) return;
    setBusy(true);
    try {
      const next = await api.setupMail({
        zone_id: first ? zone : null, receive, apps, send,
        relay: send === "relay" ? { host: host.trim(), port: Number(port), security, username: username.trim(), password: password || null } : null,
      });
      onDone(next);
    } catch (err) {
      notify(message(err), "bad");
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={submit}>
      {!ready && (
        <Callout tone="warn" icon="cloud">
          Mail keeps its DNS records on Cloudflare. <button type="button" className="btn text" onClick={() => cloudflare()}>Connect Cloudflare</button>
        </Callout>
      )}
      <Card title="Mail">
        {first && (
          <Row title="Domain" sub="Addresses are @ this domain; the server is mail. on it">
            <div className="mail-pick">
              <Dropdown label="Domain" value={zone} onChange={setZone}
                options={(zones ?? []).map((z) => ({ value: z.id, label: z.name }))} />
            </div>
          </Row>
        )}
        <Row title="Receiving" sub={RECEIVE.find((o) => o.value === receive)?.hint}>
          <Seg label="Receiving" value={receive} options={RECEIVE} onChange={setReceive} />
        </Row>
        <Row title="Mail apps" sub={appOptions.find((o) => o.value === apps)?.hint}>
          <Seg label="Mail apps" value={apps} options={appOptions} onChange={setApps} />
        </Row>
        <Row title="Sending" sub={SEND.find((o) => o.value === send)?.hint}>
          <Seg label="Sending" value={send} options={SEND} onChange={setSend} />
        </Row>
      </Card>
      {send === "relay" && (
        <Card title="Relay">
          <div className="card-pad">
            <div className="edit-row">
              <TextField className="grow" label="Server" mono autoComplete="off" placeholder="smtp.example.com" value={host} onChange={setHost} />
              <TextField className="port" label="Port" mono inputMode="numeric" value={port} onChange={(v) => setPort(v.replace(/\D/g, "").slice(0, 5))} />
              <div className="tf static protocol">
                <div className="tf-box">
                  <Dropdown label="Security" value={security} options={SECURITY} onChange={setSecurity} />
                  <span className="tf-label">Security</span>
                </div>
              </div>
            </div>
            <div className="edit-row">
              <TextField className="grow" label="Username" autoComplete="off" value={username} onChange={setUsername} />
              <TextField className="grow" label="Password" type="password" autoComplete="new-password" data-1p-ignore
                placeholder={s.relay?.password_set ? "Kept as saved" : undefined} value={password} onChange={setPassword} />
            </div>
          </div>
        </Card>
      )}
      <div className="edit-actions">
        <button className="btn primary" disabled={!go}>
          {busy ? <span className="spinner small on-accent" /> : <Icon name="check" size={18} />}{first ? "Set up" : "Save and set up"}
        </button>
      </div>
    </form>
  );
}

// Progress shows setup's step and how far along it is, then each step's outcome.
function Progress({ state }: { state: MailState }) {
  const { job } = state;
  if (!job.running && !job.steps.length) return null;
  const percent = job.total ? Math.min(100, Math.round((job.done / job.total) * 100)) : 0;
  return (
    <Card title={job.running ? `${job.step || "Starting"} · ${percent}%` : "Setup"}
      sub={job.running ? undefined : job.steps.every((s) => s.ok) ? "Everything is in place" : "Some steps need attention"}>
      {job.running && <div className="mail-bar" aria-hidden><span style={{ width: `${percent}%` }} /></div>}
      <ul className="results">
        {job.steps.map((s, i) => (
          <li key={i} className="setting">
            <span className={"dot " + (s.ok ? "ok" : "bad")} />
            <div className="setting-text">
              <div className="setting-title">{s.name}</div>
              {s.detail && <div className="setting-sub">{s.detail}</div>}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Overview({ state, zones, onState }: { state: MailState; zones: Zone[]; onState: (s: MailState) => void }) {
  const can = useCan();
  const notify = useNotify();
  const s = state.settings;
  const run = async (work: () => Promise<MailState>, done?: string) => {
    try {
      onState(await work());
      if (done) notify(done);
    } catch (e) {
      notify(message(e), "bad");
    }
  };
  const free = zones.filter((z) => !s.domains.some((d) => d.zone_id === z.id));
  return (
    <div className="page-body stack">
      <Progress state={state} />
      <Card title="Mail apps" sub="Sign in with the full address and its password">
        {state.servers ? (
          <>
            <Row title="IMAP" sub="SSL/TLS"><Copy text={`${state.servers.imap_host}:${state.servers.imap_port}`} /></Row>
            <Row title="SMTP" sub="SSL/TLS"><Copy text={`${state.servers.smtp_host}:${state.servers.smtp_port}`} /></Row>
          </>
        ) : <Row title="Tailscale is not connected" sub="Mail apps reach this server once it is" />}
      </Card>
      <Card title="Ways in and out">
        <Row title="Receiving"><span className="chip">{labelOf(RECEIVE, s.receive)}</span></Row>
        <Row title="Mail apps"><span className="chip">{labelOf(APPS, s.apps)}</span></Row>
        <Row title="Sending" sub={s.send === "relay" && s.relay ? `${s.relay.host}:${s.relay.port}` : undefined}><span className="chip">{labelOf(SEND, s.send)}</span></Row>
        {state.queued > 0 && (
          <Row title={`${state.queued} waiting to send`} sub="Tried again with growing waits, for four days">
            {can("mail.manage") && <button type="button" className="btn" onClick={() => run(api.retryMail, "Trying now")}><Icon name="refresh" size={18} />Try now</button>}
          </Row>
        )}
      </Card>
      <Card title="Domains" action={can("mail.manage") && free.length > 0 ? (
        <MoreMenu label="Add a domain" icon="add" actions={free.map((z) => ({ label: z.name, icon: "public" as IconName, onClick: () => run(() => api.addMailDomain(z.id), `Adding ${z.name}`) }))} />
      ) : undefined}>
        {s.domains.map((d, i) => (
          <Row key={d.zone_id} title={d.name} sub={i === 0 ? state.hostname : undefined}>
            {can("mail.manage") && (i > 0 || s.domains.length === 1) && (
              <MoreMenu label={`Actions for ${d.name}`} actions={[{ label: "Remove", icon: "delete", danger: true, confirm: "Remove for good",
                onClick: () => run(() => api.removeMailDomain(d.name), `Removed ${d.name}`) }]} />
            )}
          </Row>
        ))}
      </Card>
      {can("mail.manage") && (
        <Card title="Options">
          <Row title="Keep sent mail" sub="A copy in Sent of what mail apps send">
            <Switch label="Keep sent mail" on={s.save_sent} onChange={(v) => run(() => api.mailOptions({ save_sent: v }))} />
          </Row>
          <Row title="Refuse spoofed mail" sub="Turn away mail its sender's DMARC policy rejects, rather than file it in Junk">
            <Switch label="Refuse spoofed mail" on={s.reject_dmarc} onChange={(v) => run(() => api.mailOptions({ reject_dmarc: v }))} />
          </Row>
        </Card>
      )}
    </div>
  );
}

function Accounts({ state, onState }: { state: MailState; onState: (s: MailState) => void }) {
  const can = useCan();
  const notify = useNotify();
  const [adding, setAdding] = useState(false);
  const [alias, setAlias] = useState(false);
  const [password, setPassword] = useState<string | null>(null);
  const run = async (work: () => Promise<MailState>, done: string) => {
    try {
      onState(await work());
      notify(done);
      return true;
    } catch (e) {
      notify(message(e), "bad");
      return false;
    }
  };
  const manage = can("mail.manage");
  return (
    <div className="page-body stack">
      <Card title="Accounts" action={manage ? <button type="button" className="icon-btn" aria-label="New account" title="New account" onClick={() => setAdding(true)}><Icon name="add" /></button> : undefined}>
        {state.accounts.length === 0 && <p className="empty-note mail-none">No accounts yet. Add one with the plus.</p>}
        <ul className="results ct-list">
          {state.accounts.map((a) => {
            const actions: MenuAction[] = manage ? [
              { label: "Change password", icon: "password", onClick: () => setPassword(a.address) },
              a.apps
                ? { label: "Turn mail apps off", icon: "block", onClick: () => run(() => api.editMailAccount(a.address, { apps: false }), "Mail apps are off for it") }
                : { label: "Turn mail apps on", icon: "check_circle", onClick: () => run(() => api.editMailAccount(a.address, { apps: true }), "Mail apps are on for it") },
              { label: "Remove", icon: "delete", danger: true, confirm: "Remove with its mail", onClick: () => run(() => api.removeMailAccount(a.address), `Removed ${a.address}`) },
            ] : [];
            return (
              <li key={a.address} className="ct-row">
                <div className="ct-row-main">
                  <span className={"ct-kind " + (a.apps ? "ok" : "")} title={a.apps ? "Mail apps on" : "Mail apps off"}><Icon name="person" /></span>
                  <span className="ct-name-text">
                    <b>{a.address}</b>
                    <small>{[a.name, `${a.messages} messages`, bytes(a.size)].filter(Boolean).join(" · ")}</small>
                  </span>
                  <span className="ct-use muted">{a.apps ? "Mail apps" : "Mail apps off"}</span>
                </div>
                {actions.length > 0 && <span className="ct-menu"><MoreMenu label={`Actions for ${a.address}`} actions={actions} /></span>}
              </li>
            );
          })}
        </ul>
      </Card>
      <Card title="Aliases" sub="Other addresses, and @domain for everything else at it"
        action={manage && state.accounts.length > 0 ? <button type="button" className="icon-btn" aria-label="New alias" title="New alias" onClick={() => setAlias(true)}><Icon name="add" /></button> : undefined}>
        {state.aliases.map((x) => (
          <Row key={x.alias} title={x.alias} sub={`to ${x.target}`}>
            {manage && <MoreMenu label={`Actions for ${x.alias}`} actions={[{ label: "Remove", icon: "delete", danger: true, onClick: () => run(() => api.removeMailAlias(x.alias), `Removed ${x.alias}`) }]} />}
          </Row>
        ))}
      </Card>
      {adding && <NewAccount domain={state.settings.domains[0]?.name ?? ""} onClose={() => setAdding(false)}
        onSave={(address, name, pass) => run(() => api.addMailAccount({ address, name, password: pass }), `Added ${address}`)} />}
      {alias && <NewAlias accounts={state.accounts.map((a) => a.address)} domain={state.settings.domains[0]?.name ?? ""} onClose={() => setAlias(false)}
        onSave={(from, to) => run(() => api.setMailAlias(from, to), `${from} goes to ${to}`)} />}
      {password && <NewPassword address={password} onClose={() => setPassword(null)}
        onSave={(address, pass) => run(() => api.editMailAccount(address, { password: pass }), "Password changed")} />}
    </div>
  );
}

function NewAccount({ domain, onClose, onSave }: { domain: string; onClose: () => void; onSave: (address: string, name: string, password: string) => Promise<boolean> }) {
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [pass, setPass] = useState("");
  const full = address.includes("@") ? address.trim() : `${address.trim()}@${domain}`;
  return (
    <Dialog title="New account" onClose={onClose}>
      <form onSubmit={async (e) => {
        e.preventDefault();
        if (await onSave(full, name.trim(), pass)) onClose();
      }}>
        <TextField label="Address" autoFocus autoComplete="off" value={address} onChange={setAddress} hint={address.trim() ? full : `name@${domain}`} />
        <TextField label="Name" autoComplete="off" value={name} onChange={setName} />
        <TextField label="Password" type="password" autoComplete="new-password" data-1p-ignore value={pass} onChange={setPass} />
        <div className="edit-actions">
          <button type="button" className="btn text" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!address.trim() || !pass}>Add</button>
        </div>
      </form>
    </Dialog>
  );
}

function NewAlias({ accounts, domain, onClose, onSave }: { accounts: string[]; domain: string; onClose: () => void; onSave: (alias: string, target: string) => Promise<boolean> }) {
  const [alias, setAlias] = useState("");
  const [target, setTarget] = useState(accounts[0] ?? "");
  const full = alias.includes("@") ? alias.trim() : `${alias.trim()}@${domain}`;
  return (
    <Dialog title="New alias" onClose={onClose}>
      <form onSubmit={async (e) => {
        e.preventDefault();
        if (await onSave(full, target)) onClose();
      }}>
        <TextField label="Address" autoFocus autoComplete="off" value={alias} onChange={setAlias} hint={alias.trim() ? full : `sales@${domain}, or @${domain} for the rest`} />
        <div className="tf static">
          <div className="tf-box">
            <Dropdown label="Goes to" value={target} onChange={setTarget} options={accounts.map((a) => ({ value: a, label: a }))} />
            <span className="tf-label">Goes to</span>
          </div>
        </div>
        <div className="edit-actions">
          <button type="button" className="btn text" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!alias.trim() || !target}>Add</button>
        </div>
      </form>
    </Dialog>
  );
}

function NewPassword({ address, onClose, onSave }: { address: string; onClose: () => void; onSave: (address: string, password: string) => Promise<boolean> }) {
  const [pass, setPass] = useState("");
  return (
    <Dialog title={`Password for ${address}`} onClose={onClose}>
      <form onSubmit={async (e) => {
        e.preventDefault();
        if (await onSave(address, pass)) onClose();
      }}>
        <TextField label="New password" type="password" autoFocus autoComplete="new-password" data-1p-ignore value={pass} onChange={setPass} />
        <div className="edit-actions">
          <button type="button" className="btn text" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!pass}>Save</button>
        </div>
      </form>
    </Dialog>
  );
}

const TONE: Record<string, string> = { delivered: "ok", sent: "ok", junk: "warn", queued: "", rejected: "bad", failed: "bad", bounced: "bad" };

function Activity() {
  const [log, setLog] = useState<MailLog[] | null>(null);
  useEffect(() => {
    const load = () => api.mailLog().then(setLog).catch(() => {});
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);
  if (!log) return null;
  return (
    <div className="page-body stack">
      <div className="card">
        {log.length === 0 ? <p className="empty-note mail-none">Nothing has come in or gone out yet.</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Time</th><th /><th>From</th><th>To</th><th>Size</th><th className="grow">Outcome</th></tr>
              </thead>
              <tbody>
                {log.map((e, i) => (
                  <tr key={i}>
                    <td className="log-time">{new Date(e.at * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
                    <td title={e.dir === "in" ? "Received" : "Sent"}><Icon name={e.dir === "in" ? "download" : "upload"} size={18} /></td>
                    <td className="mono">{e.from || "<>"}</td>
                    <td className="mono">{e.to}</td>
                    <td className="muted">{bytes(e.size)}</td>
                    <td><span className="log-event"><span className={"dot " + (TONE[e.status] ?? "")} />{e.status}{e.detail ? `: ${e.detail}` : ""}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

const TABS: [string, string, IconName][] = [
  ["overview", "Overview", "dashboard"],
  ["accounts", "Accounts", "group"],
  ["activity", "Activity", "history"],
];

// MailPage is the mail server: set up the first time, then its overview,
// accounts and activity.
export function MailPage({ tab }: { tab: string }) {
  const can = useCan();
  const notify = useNotify();
  const [state, setState] = useState<MailState | null>(null);
  const [problem, setProblem] = useState("");
  const [zones, setZones] = useState<Zone[]>([]);
  const [changing, setChanging] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await api.mail());
      setProblem("");
    } catch (e) {
      setProblem(message(e));
    }
  }, []);
  const running = !!state?.job.running;
  useEffect(() => {
    load();
    const t = setInterval(load, running ? 1500 : 10_000);
    return () => clearInterval(t);
  }, [load, running]);
  const live = !!state && state.settings.on && state.settings.domains.length > 0;
  const manage = can("mail.manage");
  useEffect(() => {
    if (live && manage) api.mailZones().then(setZones).catch(() => {});
  }, [live, manage]);

  if (!state) return problem ? <div className="page-body"><Callout tone="bad" icon="error">{problem}</Callout></div> : null;
  const current = TABS.some(([k]) => k === tab) ? tab : "overview";
  const act = async (work: () => Promise<MailState>, done: string) => {
    try {
      setState(await work());
      notify(done);
    } catch (e) {
      notify(message(e), "bad");
    }
  };

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Mail</h1>
          {live && <div className="page-sub"><span><b>{state.accounts.length}</b> accounts on {state.hostname}</span></div>}
        </div>
        {live && can("mail.manage") && (
          <div className="page-actions">
            <MoreMenu label="Mail actions" actions={[
              { label: "Change setup", icon: "tune", onClick: () => setChanging(true) },
              { label: "Run setup again", icon: "refresh", onClick: () => act(api.rerunMail, "Setting up again") },
              { label: "Turn off", icon: "block", danger: true, confirm: "Close its ports", onClick: () => act(api.mailOff, "Mail is off") },
            ]} />
          </div>
        )}
      </div>
      {!live ? (
        <div className="page-body stack">
          {can("mail.manage")
            ? <MailSetup state={state} onDone={setState} />
            : <Callout icon="info">Mail is not set up yet.</Callout>}
        </div>
      ) : (
        <>
          <nav className="sub-nav" aria-label="Mail">
            {TABS.map(([key, label, icon]) => (
              <a key={key} className={"sub-nav-item" + (current === key ? " on" : "")} href={`#/mail/${key}`} aria-current={current === key ? "page" : undefined}>
                <Icon name={icon} size={18} />
                <span>{label}</span>
              </a>
            ))}
          </nav>
          {current === "overview" && <Overview state={state} zones={zones} onState={setState} />}
          {current === "accounts" && <Accounts state={state} onState={setState} />}
          {current === "activity" && <Activity />}
        </>
      )}
      {changing && (
        <Dialog title="Change setup" wide onClose={() => setChanging(false)}>
          <MailSetup state={state} onDone={(s) => {
            setState(s);
            setChanging(false);
          }} />
        </Dialog>
      )}
    </>
  );
}
