import { useCallback, useContext, useEffect, useState } from "react";
import { NeedsContext } from "./Apps";
import { useCloudflareReady } from "./Cloudflare";
import {
  api, message,
  type MailApps, type MailLog, type MailReceive, type MailSend, type MailState, type Zone,
} from "./api";
import { Dropdown, type Option } from "./Dropdown";
import { Icon, type IconName } from "./Icon";
import { useCan } from "./me";
import { ArmedButton, Callout, Card, Copy, Dialog, Row, Switch, TextField, useNotify } from "./ui";

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

export function MailActivity({ domain }: { domain: string }) {
  const [log, setLog] = useState<MailLog[] | null>(null);
  useEffect(() => {
    const load = () => api.mailLog().then(setLog).catch(() => {});
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);
  if (!log) return null;
  const mine = log.filter((e) => domainOf(e.from) === domain || domainOf(e.to) === domain);
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
