import { useCallback, useContext, useEffect, useState } from "react";
import { NeedsContext } from "./Apps";
import { useCloudflareReady } from "./Cloudflare";
import {
  api, bytes, message,
  type MailAccount, type MailApps, type MailLog, type MailReceive, type MailSend, type MailState, type Zone,
} from "./api";
import { Dropdown, type Option } from "./Dropdown";
import { Icon, type IconName } from "./Icon";
import { useCan } from "./me";
import { ArmedButton, Callout, Card, Copy, Dialog, MoreMenu, Row, Switch, TextField, useNotify, type MenuAction } from "./ui";

// A way mail is received, reached by mail apps or sent, with what it means at
// a glance: each fact is a drawback, ticked when the way has it.
interface Way<T> { value: T; label: string; icon: IconName; hint: string; facts: [string, boolean][]; disabled?: boolean }

const RECEIVE: Way<MailReceive>[] = [
  { value: "port", label: "Port forward", icon: "router", hint: "Port 25 on your router",
    facts: [["Port exposed", true], ["Third-party dependency", false], ["Usage limited", false], ["Often blocked at home", true]] },
  { value: "cloudflare", label: "Cloudflare", icon: "cloud", hint: "Email Routing, through the tunnel",
    facts: [["Port exposed", false], ["Third-party dependency", true], ["Usage limited", true], ["Often blocked at home", false]] },
];
const APPS: Way<MailApps>[] = [
  { value: "port", label: "Port forward", icon: "router", hint: "IMAP 993 and SMTP 465 on your router",
    facts: [["Port exposed", true], ["Third-party dependency", false], ["Usage limited", false]] },
  { value: "tailscale", label: "Tailscale", icon: "lan", hint: "IMAP 443 and SMTP 8443 through Funnel",
    facts: [["Port exposed", false], ["Third-party dependency", true], ["Usage limited", true]] },
];
const SEND: Way<MailSend>[] = [
  { value: "direct", label: "Direct", icon: "router", hint: "Straight to each recipient on port 25",
    facts: [["Third-party dependency", false], ["Usage limited", false], ["Often blocked at home", true], ["Paid plan", false]] },
  { value: "relay", label: "Relay", icon: "swap_horiz", hint: "Through another SMTP server",
    facts: [["Third-party dependency", true], ["Usage limited", true], ["Often blocked at home", false], ["Paid plan", false]] },
  { value: "cloudflare", label: "Cloudflare", icon: "cloud", hint: "Email Sending",
    facts: [["Third-party dependency", true], ["Usage limited", true], ["Often blocked at home", false], ["Paid plan", true]] },
];
const SECURITY: Option<string>[] = [
  { value: "tls", label: "TLS", hint: "Usually port 465" },
  { value: "starttls", label: "STARTTLS", hint: "Usually port 587" },
  { value: "none", label: "None" },
];

const labelOf = <T,>(ways: Way<T>[], v: T) => ways.find((o) => o.value === v)?.label ?? String(v);
export const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();
export const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
export const cleanDomain = (v: string) => v.trim().toLowerCase().replace(/^@/, "").replace(/\.$/, "");
export const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

// Act runs a change and shows its outcome, giving the new state to the page.
export function useAct(onState: (s: MailState) => void) {
  const notify = useNotify();
  return useCallback(async (work: () => Promise<MailState>, done?: string) => {
    try {
      onState(await work());
      if (done) notify(done);
      return true;
    } catch (e) {
      notify(message(e), "bad");
      return false;
    }
  }, [onState, notify]);
}

// Zones loads the Cloudflare account's domains once they are wanted and Cloudflare is connected.
export function useZones(wanted: boolean) {
  const ready = useCloudflareReady();
  const notify = useNotify();
  const [zones, setZones] = useState<Zone[] | null>(null);
  useEffect(() => {
    if (!wanted || !ready || zones) return;
    api.mailZones().then(setZones).catch((e) => notify(message(e), "bad"));
  }, [wanted, ready, zones, notify]);
  return zones;
}

// ---- setup, a step at a time ----

// Ways are the choices for a step, a tile each, with its facts ticked or crossed.
function Ways<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Way<T>[]; onChange: (v: T) => void }) {
  return (
    <div className="ways" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} disabled={o.disabled}
          className={"way" + (o.value === value ? " on" : "")} onClick={() => onChange(o.value)}>
          <span className="way-head"><Icon name={o.icon} size={22} /><b>{o.label}</b></span>
          <span className="way-hint">{o.hint}</span>
          <ul className="way-facts">
            {o.facts.map(([fact, has]) => (
              <li key={fact} className={has ? "has" : undefined}>
                <Icon name={has ? "check" : "close"} size={16} />
                <span>{fact}</span>
              </li>
            ))}
          </ul>
        </button>
      ))}
    </div>
  );
}

function Steps({ steps, at, onPick }: { steps: string[]; at: number; onPick: (i: number) => void }) {
  return (
    <ol className="wizard-steps">
      {steps.map((s, i) => (
        <li key={s} className={i === at ? "on" : i < at ? "done" : undefined}>
          <button type="button" disabled={i >= at} aria-current={i === at ? "step" : undefined} onClick={() => onPick(i)}>
            <span className="how-num">{i < at ? <Icon name="check" size={16} /> : i + 1}</span>
            {s}
          </button>
        </li>
      ))}
    </ol>
  );
}

// Wizard sets mail up for the domains on the Domains page, or changes how it
// moves: how mail arrives, how mail apps connect and how mail leaves.
function Wizard({ state, onDone, onCancel }: { state: MailState; onDone: (s: MailState) => void; onCancel?: () => void }) {
  const needs = useContext(NeedsContext);
  const notify = useNotify();
  const s = state.settings;
  const first = !s.on;
  const [receive, setReceive] = useState<MailReceive>(s.receive);
  const [apps, setApps] = useState<MailApps>(s.apps);
  const [send, setSend] = useState<MailSend>(s.send);
  const [host, setHost] = useState(s.relay?.host ?? "");
  const [port, setPort] = useState(String(s.relay?.port ?? 587));
  const [security, setSecurity] = useState(s.relay?.security ?? "starttls");
  const [username, setUsername] = useState(s.relay?.username ?? "");
  const [password, setPassword] = useState("");
  const [at, setAt] = useState(0);
  const [busy, setBusy] = useState(false);

  // The Cloudflare ways need every domain synced with Cloudflare.
  const onCloudflare = s.domains.every((d) => !!d.zone_id);
  useEffect(() => {
    if (onCloudflare) return;
    setReceive((r) => (r === "cloudflare" ? "port" : r));
    setSend((v) => (v === "cloudflare" ? "direct" : v));
  }, [onCloudflare]);
  const cfOnly = <T extends string>(o: Way<T>): Way<T> => (o.value === "cloudflare" && !onCloudflare ? { ...o, disabled: true, hint: "Needs every domain synced with Cloudflare" } : o);
  const appWays = APPS.map((o) => (o.value === "tailscale" && needs && !needs.tailscale ? { ...o, disabled: true, hint: "Install Tailscale from Apps first" } : o));

  const steps = ["Receiving", "Mail apps", "Sending"];
  const step = steps[at];
  const last = at === steps.length - 1;
  const relayOk = send !== "relay" || (!!host.trim() && Number(port) > 0 && (!!password || !!s.relay?.password_set || !username.trim()));
  const ok = step === "Sending" ? relayOk : true;

  const submit = async () => {
    setBusy(true);
    try {
      onDone(await api.setupMail({
        zone_id: null,
        domain: null,
        receive, apps, send,
        relay: send === "relay" ? { host: host.trim(), port: Number(port), security, username: username.trim(), password: password || null } : null,
      }));
    } catch (err) {
      notify(message(err), "bad");
      setBusy(false);
    }
  };

  return (
    <div className="card wizard">
      <Steps steps={steps} at={at} onPick={setAt} />
      <div className="wizard-body">
        {step === "Receiving" && (
          <>
            <h2 className="wizard-q">How does mail arrive?</h2>
            <Ways label="Receiving" value={receive} options={RECEIVE.map(cfOnly)} onChange={setReceive} />
          </>
        )}
        {step === "Mail apps" && (
          <>
            <h2 className="wizard-q">How do mail apps connect?</h2>
            <Ways label="Mail apps" value={apps} options={appWays} onChange={setApps} />
          </>
        )}
        {step === "Sending" && (
          <>
            <h2 className="wizard-q">How does mail leave?</h2>
            <Ways label="Sending" value={send} options={SEND.map(cfOnly)} onChange={setSend} />
            {send === "relay" && (
              <div className="wizard-fields">
                <TextField className="span" label="Relay server" mono autoComplete="off" placeholder="smtp.example.com" value={host} onChange={setHost} />
                <TextField label="Port" mono inputMode="numeric" value={port} onChange={(v) => setPort(v.replace(/\D/g, "").slice(0, 5))} />
                <div className="tf static">
                  <div className="tf-box">
                    <Dropdown label="Security" value={security} options={SECURITY} onChange={setSecurity} />
                    <span className="tf-label">Security</span>
                  </div>
                </div>
                <TextField label="Username" autoComplete="off" value={username} onChange={setUsername} />
                <TextField label="Password" type="password" autoComplete="new-password" data-1p-ignore
                  placeholder={s.relay?.password_set ? "Kept as saved" : undefined} value={password} onChange={setPassword} />
              </div>
            )}
          </>
        )}
      </div>
      <div className="setup-foot wizard-foot">
        {at === 0
          ? onCancel && <button type="button" className="btn text" onClick={onCancel}>Cancel</button>
          : <button type="button" className="btn text" onClick={() => setAt(at - 1)}><Icon name="arrow_back" size={18} />Back</button>}
        {last ? (
          <button type="button" className="btn primary" disabled={!ok || busy} onClick={submit}>
            {busy ? <span className="spinner small on-accent" /> : <Icon name="check" size={18} />}{first ? "Set up" : "Apply"}
          </button>
        ) : (
          <button type="button" className="btn primary" disabled={!ok} onClick={() => setAt(at + 1)}>Continue<Icon name="arrow_forward" size={18} /></button>
        )}
      </div>
    </div>
  );
}

// ---- status ----

// MailStatus shows setup while it runs, then only the steps that failed for
// `domain` or for the server as a whole, and mail waiting to send.
export function MailStatus({ state, onState, domain }: { state: MailState; onState: (s: MailState) => void; domain: string }) {
  const can = useCan();
  const act = useAct(onState);
  const manage = can("mail.manage");
  const { job } = state;
  const others = state.settings.domains.map((d) => d.name).filter((n) => n !== domain);
  const mine = (name: string) => name.includes(domain) || !others.some((o) => name.includes(o));
  const failed = job.running ? [] : job.steps.filter((s) => !s.ok && mine(s.name));
  const percent = job.total ? Math.min(100, Math.round((job.done / job.total) * 100)) : 0;
  return (
    <>
      {job.running && (
        <Card title={`${job.step || "Starting"} · ${percent}%`}>
          <div className="mail-bar" aria-hidden><span style={{ width: `${percent}%` }} /></div>
        </Card>
      )}
      {failed.length > 0 && (
        <Card title={`${plural(failed.length, "setup step")} failed`}
          action={manage ? <button type="button" className="btn" onClick={() => act(api.rerunMail, "Setting up again")}><Icon name="refresh" size={18} />Run again</button> : undefined}>
          {failed.map((s, i) => (
            <Row key={i} title={<span className="mail-state"><span className="dot bad" />{s.name}</span>} sub={s.detail || undefined} />
          ))}
        </Card>
      )}
      {state.queued > 0 && (
        <div className="mail-todo">
          <Icon name="upload" size={20} />
          <span>{state.queued} waiting to send</span>
          {manage && <button type="button" className="btn small" onClick={() => act(api.retryMail, "Trying now")}><Icon name="refresh" size={16} />Try now</button>}
        </div>
      )}
    </>
  );
}

// ---- settings ----

// MailSettings is the mail server for the domains: set up a step at a time
// the first time, then how mail moves, how mail apps sign in, and what it does.
export function MailSettings({ state, onState }: { state: MailState; onState: (s: MailState) => void }) {
  const can = useCan();
  const act = useAct(onState);
  const [changing, setChanging] = useState(false);
  const s = state.settings;
  const manage = can("mail.manage");
  if (!s.on) {
    if (!manage) return <Callout icon="info">Mail is not set up yet.</Callout>;
    if (!s.domains.length) return <Callout icon="public">Add a domain to set mail up.</Callout>;
    return <Wizard state={state} onDone={onState} />;
  }
  return (
    <>
      <Card title="How mail moves" action={manage ? <button type="button" className="btn" onClick={() => setChanging(true)}><Icon name="tune" size={18} />Change</button> : undefined}>
        <Row title="Receiving" sub={RECEIVE.find((o) => o.value === s.receive)?.hint}><span className="chip">{labelOf(RECEIVE, s.receive)}</span></Row>
        <Row title="Mail apps" sub={APPS.find((o) => o.value === s.apps)?.hint}><span className="chip">{labelOf(APPS, s.apps)}</span></Row>
        <Row title="Sending" sub={s.send === "relay" && s.relay ? `${s.relay.host}:${s.relay.port}` : SEND.find((o) => o.value === s.send)?.hint}>
          <span className="chip">{labelOf(SEND, s.send)}</span>
        </Row>
      </Card>
      <Card title="Signing in" sub="In Outlook, Gmail or any app with IMAP, with the full address and its password">
        {state.servers ? (
          <>
            <Row title="IMAP"><Copy text={`${state.servers.imap_host}:${state.servers.imap_port}`} /></Row>
            <Row title="SMTP"><Copy text={`${state.servers.smtp_host}:${state.servers.smtp_port}`} /></Row>
          </>
        ) : <Row title="Waiting for Tailscale" sub="Mail apps reach this server once Tailscale is connected" />}
      </Card>
      <Card title="Incoming mail">
        <Row title="Refuse spoofed mail" sub="Turn away what its sender's DMARC rejects, rather than file it in Junk">
          <Switch label="Refuse spoofed mail" disabled={!manage} on={s.reject_dmarc} onChange={(v) => act(() => api.mailOptions({ reject_dmarc: v }))} />
        </Row>
        <Row title="Keep sent mail" sub="A copy in Sent of what mail apps send">
          <Switch label="Keep sent mail" disabled={!manage} on={s.save_sent} onChange={(v) => act(() => api.mailOptions({ save_sent: v }))} />
        </Row>
      </Card>
      {manage && (
        <Card title="Server">
          <Row title="Run setup again" sub="Opens the ports and writes the records once more">
            <button type="button" className="btn" disabled={state.job.running} onClick={() => act(api.rerunMail, "Setting up again")}><Icon name="refresh" size={18} />Run</button>
          </Row>
          <Row title="Turn off" sub="Stops mail and closes its ports; accounts and mail are kept">
            <ArmedButton icon="block" label="Turn off" armedLabel="Close its ports" onConfirm={() => act(api.mailOff, "Mail is off")} />
          </Row>
        </Card>
      )}
      {changing && (
        <Dialog title="Change how mail moves" wide onClose={() => setChanging(false)}>
          <Wizard state={state} onCancel={() => setChanging(false)} onDone={(next) => {
            onState(next);
            setChanging(false);
          }} />
        </Dialog>
      )}
    </>
  );
}

// ---- activity ----

const TONE: Record<string, string> = { delivered: "ok", sent: "ok", junk: "warn", queued: "", rejected: "bad", failed: "bad", bounced: "bad" };

// MailActivity is what came in and went out, for `domain` or every domain.
export function MailActivity({ domain }: { domain?: string }) {
  const [log, setLog] = useState<MailLog[] | null>(null);
  useEffect(() => {
    const load = () => api.mailLog().then(setLog).catch(() => {});
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);
  if (!log) return null;
  const mine = domain ? log.filter((e) => domainOf(e.from) === domain || domainOf(e.to) === domain) : log;
  return (
    <div className="card">
        {mine.length === 0 ? <p className="empty-note mail-none">Nothing has come in or gone out yet.</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Time</th><th /><th>From</th><th>To</th><th className="grow">Outcome</th></tr>
              </thead>
              <tbody>
                {mine.map((e, i) => (
                  <tr key={i}>
                    <td className="log-time">{new Date(e.at * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
                    <td title={e.dir === "in" ? "Received" : "Sent"}><Icon name={e.dir === "in" ? "download" : "upload"} size={18} /></td>
                    <td className="mono">{e.from || "<>"}</td>
                    <td className="mono">{e.to}</td>
                    <td><span className="log-event"><span className={"dot " + (TONE[e.status] ?? "")} />{e.status}{e.detail ? `: ${e.detail}` : ""}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}

// ---- the page ----

const TABS: [string, string, IconName][] = [
  ["addresses", "Addresses", "mail"],
  ["activity", "Activity", "history"],
  ["settings", "Settings", "settings"],
];

// useMail loads mail's state, quickly while setup runs.
function useMail() {
  const [state, setState] = useState<MailState | null>(null);
  const [problem, setProblem] = useState("");
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
  return { state, setState, problem };
}

// MailPage is mail for every domain on Domains: the addresses and aliases,
// what came in and went out, and how the mail server runs. Until it is set
// up, it opens on setting it up.
export function MailPage({ tab }: { tab: string }) {
  const { state, setState, problem } = useMail();
  const act = useAct(setState);
  const [adding, setAdding] = useState(false);
  const [alias, setAlias] = useState(false);
  const [password, setPassword] = useState<string | null>(null);
  if (!state) return problem ? <div className="page-body"><Callout tone="bad" icon="error">{problem}</Callout></div> : null;
  const s = state.settings;
  const current = TABS.some(([k]) => k === tab) ? tab : s.on ? "addresses" : "settings";
  const runs = state.manages;
  const targets = state.accounts.filter((a) => runs.includes(domainOf(a.address))).map((a) => a.address);
  const domains = s.domains.map((d) => d.name);
  const none = state.accounts.length === 0 && state.aliases.length === 0;
  const buttons = s.on && runs.length > 0 && (
    <>
      {targets.length > 0 && <button type="button" className="btn" onClick={() => setAlias(true)}><Icon name="call_split" size={18} />New alias</button>}
      <button type="button" className="btn primary" onClick={() => setAdding(true)}><Icon name="add" size={18} />New address</button>
    </>
  );
  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Mail</h1>
          <div className="page-sub">
            {s.on ? <span><b>{state.accounts.length}</b> {state.accounts.length === 1 ? "address" : "addresses"}</span> : <span>Not set up</span>}
            <a href="#/domains"><b>{domains.length}</b> {domains.length === 1 ? "domain" : "domains"}</a>
          </div>
        </div>
        {current === "addresses" && !none && buttons && <div className="page-actions">{buttons}</div>}
      </div>
      <nav className="sub-nav" aria-label="Mail">
        {TABS.map(([key, label, icon]) => (
          <a key={key} className={"sub-nav-item" + (current === key ? " on" : "")} href={`#/mail/${key}`} aria-current={current === key ? "page" : undefined}>
            <Icon name={icon} size={18} />
            <span>{label}</span>
          </a>
        ))}
      </nav>
      <div className="page-body stack" key={current}>
        {domains.length === 0 && <Callout icon="public">Mail runs on your own domains. <a href="#/domains">Add a domain</a> first.</Callout>}
        {current === "addresses" && (!s.on ? domains.length > 0 && <Callout icon="info">Mail is not set up yet. <a href="#/mail/settings">Set it up</a></Callout>
          : none ? (
            <div className="welcome">
              <Icon name="mail" size={48} />
              {buttons && <div className="welcome-actions">{buttons}</div>}
            </div>
          ) : <Addresses state={state} onState={setState} onPassword={setPassword} />)}
        {current === "activity" && <MailActivity />}
        {current === "settings" && (
          <>
            <MailStatus state={state} onState={setState} domain="" />
            <MailSettings state={state} onState={setState} />
          </>
        )}
      </div>
      {adding && <NewAddress domains={runs} onClose={() => setAdding(false)}
        onSave={(address, name, pass) => act(() => api.addMailAccount({ address, name, password: pass }), `Added ${address}`)} />}
      {alias && <NewAlias accounts={targets} domains={runs} onClose={() => setAlias(false)}
        onSave={(from, to) => act(() => api.setMailAlias(from, to), `${from} goes to ${to}`)} />}
      {password && <NewPassword address={password} onClose={() => setPassword(null)}
        onSave={(address, pass) => act(() => api.editMailAccount(address, { password: pass }), "Password changed")} />}
    </>
  );
}

// Addresses is every mailbox, then every alias, each by its full address.
function Addresses({ state, onState, onPassword }: { state: MailState; onState: (s: MailState) => void; onPassword: (address: string) => void }) {
  const runs = (address: string) => state.manages.includes(domainOf(address));
  return (
    <div className="card">
      <ul className="results ct-list">
        {state.accounts.map((a) => <AccountRow key={a.address} account={a} runs={runs(a.address)} onState={onState} onPassword={() => onPassword(a.address)} />)}
        {state.aliases.map((x) => <AliasRow key={x.alias} alias={x.alias} target={x.target} runs={runs(x.alias)} onState={onState} />)}
      </ul>
    </div>
  );
}

// DomainPick is the domain a new address or alias goes on, when there is a choice.
function DomainPick({ domains, value, onChange }: { domains: string[]; value: string; onChange: (d: string) => void }) {
  if (domains.length < 2) return null;
  return (
    <div className="tf static">
      <div className="tf-box">
        <Dropdown label="Domain" value={value} onChange={onChange} options={domains.map((d) => ({ value: d, label: d }))} />
        <span className="tf-label">Domain</span>
      </div>
    </div>
  );
}

function AccountRow({ account, runs, onState, onPassword }: { account: MailAccount; runs: boolean; onState: (s: MailState) => void; onPassword: () => void }) {
  const act = useAct(onState);
  const a = account;
  const actions: MenuAction[] = [
    { label: "Change password", icon: "password", onClick: onPassword },
    a.apps
      ? { label: "Turn mail apps off", icon: "block", hint: "IMAP and SMTP refuse it; mail still arrives", onClick: () => act(() => api.editMailAccount(a.address, { apps: false }), "Mail apps are off for it") }
      : { label: "Turn mail apps on", icon: "check_circle", hint: "It can sign in to IMAP and SMTP again", onClick: () => act(() => api.editMailAccount(a.address, { apps: true }), "Mail apps are on for it") },
    { label: "Remove", icon: "delete", danger: true, confirm: "Remove with its mail", onClick: () => act(() => api.removeMailAccount(a.address), `Removed ${a.address}`) },
  ];
  return (
    <li className="ct-row mail-row">
      <div className="ct-row-main">
        <span className={"ct-kind" + (a.apps ? " ok" : "")}><Icon name="person" /></span>
        <span className="ct-name-text">
          <b>{a.address}{!a.apps && <span className="chip warn">Mail apps off</span>}</b>
          <small>{[a.name, plural(a.messages, "message"), bytes(a.size)].filter(Boolean).join(" · ")}</small>
        </span>
      </div>
      {runs && <span className="ct-menu"><MoreMenu label={`Actions for ${a.address}`} actions={actions} /></span>}
    </li>
  );
}

function AliasRow({ alias, target, runs, onState }: { alias: string; target: string; runs: boolean; onState: (s: MailState) => void }) {
  const act = useAct(onState);
  return (
    <li className="ct-row mail-row">
      <div className="ct-row-main">
        <span className="ct-kind"><Icon name="call_split" /></span>
        <span className="ct-name-text">
          <b>{alias.startsWith("@") ? `Everything else at ${alias}` : alias}</b>
          <small>To {target}</small>
        </span>
      </div>
      {runs && <span className="ct-menu"><MoreMenu label={`Actions for ${alias}`} actions={[{ label: "Remove", icon: "delete", danger: true, onClick: () => act(() => api.removeMailAlias(alias), `Removed ${alias}`) }]} /></span>}
    </li>
  );
}

function NewAddress({ domains, onClose, onSave }: { domains: string[]; onClose: () => void; onSave: (address: string, name: string, password: string) => Promise<boolean> }) {
  const [domain, setDomain] = useState(domains[0] ?? "");
  const [local, setLocal] = useState("");
  const [name, setName] = useState("");
  const [pass, setPass] = useState("");
  const full = `${local.trim().replace(/@.*$/, "")}@${domain}`;
  return (
    <Dialog title="New address" onClose={onClose}>
      <form onSubmit={async (e) => {
        e.preventDefault();
        if (await onSave(full, name.trim(), pass)) onClose();
      }}>
        <DomainPick domains={domains} value={domain} onChange={setDomain} />
        <TextField label="Address" autoFocus autoComplete="off" value={local} onChange={setLocal} trailing={<span className="muted">@{domain}</span>} />
        <TextField label="Name" autoComplete="off" value={name} onChange={setName} hint="Shown as who mail is from" />
        <TextField label="Password" type="password" autoComplete="new-password" data-1p-ignore value={pass} onChange={setPass} />
        <div className="edit-actions">
          <button type="button" className="btn text" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!local.trim() || !pass}>Add</button>
        </div>
      </form>
    </Dialog>
  );
}

function NewAlias({ accounts, domains, onClose, onSave }: { accounts: string[]; domains: string[]; onClose: () => void; onSave: (alias: string, target: string) => Promise<boolean> }) {
  const [domain, setDomain] = useState(domains[0] ?? "");
  const [local, setLocal] = useState("");
  const [target, setTarget] = useState(accounts.find((a) => domainOf(a) === domain) ?? accounts[0] ?? "");
  const full = `${local.trim().replace(/@.*$/, "")}@${domain}`;
  return (
    <Dialog title="New alias" onClose={onClose}>
      <form onSubmit={async (e) => {
        e.preventDefault();
        if (await onSave(full, target)) onClose();
      }}>
        <DomainPick domains={domains} value={domain} onChange={setDomain} />
        <TextField label="Address" autoFocus autoComplete="off" value={local} onChange={setLocal} trailing={<span className="muted">@{domain}</span>}
          hint={local.trim() ? undefined : `Empty for everything else at @${domain}`} />
        <div className="tf static">
          <div className="tf-box">
            <Dropdown label="Delivered to" value={target} onChange={setTarget} options={accounts.map((a) => ({ value: a, label: a }))} />
            <span className="tf-label">Delivered to</span>
          </div>
        </div>
        <div className="edit-actions">
          <button type="button" className="btn text" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!target}>Add</button>
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
        <TextField label="New password" type="password" autoFocus autoComplete="new-password" data-1p-ignore value={pass} onChange={setPass}
          hint="Mail apps signed in with the old one are asked again" />
        <div className="edit-actions">
          <button type="button" className="btn text" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!pass}>Save</button>
        </div>
      </form>
    </Dialog>
  );
}
