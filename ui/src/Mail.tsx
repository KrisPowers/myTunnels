import { useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { NeedsContext } from "./Apps";
import { useCloudflare, useCloudflareReady } from "./Cloudflare";
import {
  api, bytes, message,
  type MailAccount, type MailApps, type MailDomain, type MailLog, type MailReceive, type MailRecords, type MailSend, type MailState, type Zone,
} from "./api";
import { Dropdown, type Option } from "./Dropdown";
import { Icon, type IconName } from "./Icon";
import { useCan } from "./me";
import { AddMenu, Callout, Card, Copy, Dialog, MoreMenu, Row, Switch, TextField, useNotify, type MenuAction } from "./ui";

type Dns = "hand" | "cloudflare";

const DNS: Option<Dns>[] = [
  { value: "hand", label: "Any DNS host", icon: "dns", hint: "You add the records where the domain's DNS is; each one is listed and checked for you" },
  { value: "cloudflare", label: "Cloudflare", icon: "cloud", hint: "The records are written to Cloudflare for you" },
];
const RECEIVE: Option<MailReceive>[] = [
  { value: "port", label: "Port forward", icon: "router", hint: "Other servers reach port 25 on your router" },
  { value: "cloudflare", label: "Cloudflare", icon: "cloud", hint: "Email Routing takes the mail and hands it over through the tunnel" },
];
const APPS: Option<MailApps>[] = [
  { value: "port", label: "Port forward", icon: "router", hint: "IMAP on 993 and SMTP on 465 through your router, with a Let's Encrypt certificate" },
  { value: "tailscale", label: "Tailscale", icon: "lan", hint: "IMAP on 443 and SMTP on 8443 through Funnel; no router ports" },
];
const SEND: Option<MailSend>[] = [
  { value: "direct", label: "Direct", icon: "router", hint: "From this computer to each recipient's server on port 25" },
  { value: "relay", label: "Relay", icon: "swap_horiz", hint: "Through another SMTP server, such as your internet provider's" },
  { value: "cloudflare", label: "Cloudflare", icon: "cloud", hint: "Through Email Sending, on the Workers Paid plan" },
];
const SECURITY: Option<string>[] = [
  { value: "tls", label: "TLS", hint: "Usually port 465" },
  { value: "starttls", label: "STARTTLS", hint: "Usually port 587" },
  { value: "none", label: "None" },
];

const labelOf = <T,>(options: Option<T>[], v: T) => options.find((o) => o.value === v)?.label ?? String(v);
const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const cleanDomain = (v: string) => v.trim().toLowerCase().replace(/^@/, "").replace(/\.$/, "");

// Act runs a change and shows its outcome, giving the new state to the page.
function useAct(onState: (s: MailState) => void) {
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

// ---- choosing, a step at a time ----

function StepHead({ title, sub }: { title: string; sub?: ReactNode }) {
  return (
    <div className="step-head">
      <h2>{title}</h2>
      {sub && <p className="muted">{sub}</p>}
    </div>
  );
}

// Choices are the ways to pick from, a tile each.
function Choices<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Option<T>[]; onChange: (v: T) => void }) {
  return (
    <div className="provider-grid" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} disabled={o.disabled}
          className={"provider-tile choice" + (o.value === value ? " on" : "")} onClick={() => onChange(o.value)}>
          {o.icon && <Icon name={o.icon} size={26} />}
          <b>{o.label}</b>
          {o.hint && <span className="muted">{o.hint}</span>}
        </button>
      ))}
    </div>
  );
}

// Steps is the row of numbered steps over a flow; the ones done can be gone back to.
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

// Zones loads the Cloudflare account's domains once Cloudflare is wanted and connected.
function useZones(wanted: boolean) {
  const ready = useCloudflareReady();
  const notify = useNotify();
  const [zones, setZones] = useState<Zone[] | null>(null);
  useEffect(() => {
    if (!wanted || !ready || zones) return;
    api.mailZones().then(setZones).catch((e) => notify(message(e), "bad"));
  }, [wanted, ready, zones, notify]);
  return zones;
}

// DomainPick asks where a domain's DNS is kept, then which domain.
function DomainPick({ dns, onDns, name, onName, zone, onZone, zones, taken }: {
  dns: Dns; onDns: (d: Dns) => void;
  name: string; onName: (v: string) => void;
  zone: string; onZone: (v: string) => void;
  zones: Zone[] | null; taken: string[];
}) {
  const cloudflare = useCloudflare();
  const free = (zones ?? []).filter((z) => !taken.includes(z.name.toLowerCase()));
  useEffect(() => {
    if (dns === "cloudflare" && !free.some((z) => z.id === zone) && free.length) onZone(free[0].id);
  }, [dns, free, zone, onZone]);
  return (
    <>
      <Choices label="Where its DNS is kept" value={dns} options={DNS}
        onChange={(v) => {
          if (v === "cloudflare" && !cloudflare(() => onDns("cloudflare"))) return;
          onDns(v);
        }} />
      {dns === "hand" ? (
        <TextField label="Domain" autoFocus mono autoComplete="off" placeholder="example.com" value={name} onChange={onName}
          hint={DOMAIN.test(cleanDomain(name)) ? `Addresses like you@${cleanDomain(name)}` : "Such as example.com"} />
      ) : zones === null ? (
        <div className="muted"><span className="spinner small" /> Loading your Cloudflare domains</div>
      ) : free.length === 0 ? (
        <Callout tone="warn" icon="cloud">Every domain on this Cloudflare account is already here.</Callout>
      ) : (
        <div className="tf static mail-pick">
          <div className="tf-box">
            <Dropdown label="Domain" value={zone} onChange={onZone} options={free.map((z) => ({ value: z.id, label: z.name }))} />
            <span className="tf-label">Domain</span>
          </div>
        </div>
      )}
    </>
  );
}

// Wizard sets mail up, or changes how it is reached: the domain (the first
// time), how mail arrives, how mail apps connect and how mail leaves, then
// a last look before it runs.
function Wizard({ state, onDone, onCancel }: { state: MailState; onDone: (s: MailState) => void; onCancel?: () => void }) {
  const needs = useContext(NeedsContext);
  const notify = useNotify();
  const s = state.settings;
  const first = s.domains.length === 0;
  const [dns, setDns] = useState<Dns>("hand");
  const [name, setName] = useState("");
  const [zone, setZone] = useState("");
  const zones = useZones(first && dns === "cloudflare");
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

  // The Cloudflare ways need every domain's records on Cloudflare.
  const onCloudflare = (first ? dns === "cloudflare" : true) && s.domains.every((d) => !!d.zone_id);
  useEffect(() => {
    if (onCloudflare) return;
    setReceive((r) => (r === "cloudflare" ? "port" : r));
    setSend((v) => (v === "cloudflare" ? "direct" : v));
  }, [onCloudflare]);
  const cfOnly = <T extends string>(o: Option<T>) => (o.value === "cloudflare" && !onCloudflare ? { ...o, disabled: true, hint: "Needs every domain's records on Cloudflare" } : o);
  const appOptions = APPS.map((o) => (o.value === "tailscale" && needs && !needs.tailscale ? { ...o, disabled: true, hint: "Install Tailscale from Apps first" } : o));

  const domain = dns === "hand" ? cleanDomain(name) : zones?.find((z) => z.id === zone)?.name ?? "";
  const steps = [...(first ? ["Domain"] : []), "Receiving", "Mail apps", "Sending", "Review"];
  const step = steps[at];
  const relayOk = send !== "relay" || (!!host.trim() && Number(port) > 0 && (!!password || !!s.relay?.password_set || !username.trim()));
  const ok = step === "Domain" ? (dns === "hand" ? DOMAIN.test(domain) : !!zone) : step === "Sending" ? relayOk : true;

  const submit = async () => {
    setBusy(true);
    try {
      onDone(await api.setupMail({
        zone_id: first && dns === "cloudflare" ? zone : null,
        domain: first && dns === "hand" ? domain : null,
        receive, apps, send,
        relay: send === "relay" ? { host: host.trim(), port: Number(port), security, username: username.trim(), password: password || null } : null,
      }));
    } catch (err) {
      notify(message(err), "bad");
      setBusy(false);
    }
  };
  const byHand = first ? dns === "hand" : s.domains.some((d) => !d.zone_id);

  return (
    <div className="card wizard">
      <Steps steps={steps} at={at} onPick={setAt} />
      <div className="wizard-body">
        {step === "Domain" && (
          <>
            <StepHead title="Which domain is mail for?" sub="Pick where its DNS is kept, then the domain. More domains can be added after." />
            <DomainPick dns={dns} onDns={setDns} name={name} onName={setName} zone={zone} onZone={setZone} zones={zones} taken={[]} />
          </>
        )}
        {step === "Receiving" && (
          <>
            <StepHead title="How does mail reach this server?" sub="The way other mail servers deliver to your addresses." />
            <Choices label="Receiving" value={receive} options={RECEIVE.map(cfOnly)} onChange={setReceive} />
          </>
        )}
        {step === "Mail apps" && (
          <>
            <StepHead title="How do mail apps connect?" sub="Phones and mail programs read and send through these ports." />
            <Choices label="Mail apps" value={apps} options={appOptions} onChange={setApps} />
          </>
        )}
        {step === "Sending" && (
          <>
            <StepHead title="How does mail leave?" sub="Many home connections block port 25 out; a relay gets around that." />
            <Choices label="Sending" value={send} options={SEND.map(cfOnly)} onChange={setSend} />
            {send === "relay" && (
              <div className="wizard-fields">
                <div className="edit-row">
                  <TextField className="grow" label="Relay server" mono autoComplete="off" placeholder="smtp.example.com" value={host} onChange={setHost} />
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
            )}
          </>
        )}
        {step === "Review" && (
          <>
            <StepHead title={first ? "Ready to set up" : "Ready to apply"}
              sub={byHand ? "Next, the Domains page lists the records to add at your DNS host and ticks each one off as it appears." : "Setup writes the records and opens the ports, step by step."} />
            <div className="card wizard-review">
              {first && <Row title="Domain" sub={dns === "hand" ? "Records added by hand" : "Records on Cloudflare"}><span className="chip mono">{domain}</span></Row>}
              <Row title="Receiving"><span className="chip">{labelOf(RECEIVE, receive)}</span></Row>
              <Row title="Mail apps"><span className="chip">{labelOf(APPS, apps)}</span></Row>
              <Row title="Sending" sub={send === "relay" ? `${host.trim()}:${port}` : undefined}><span className="chip">{labelOf(SEND, send)}</span></Row>
            </div>
          </>
        )}
      </div>
      <div className="setup-foot wizard-foot">
        {at === 0
          ? onCancel && <button type="button" className="btn text" onClick={onCancel}>Cancel</button>
          : <button type="button" className="btn text" onClick={() => setAt(at - 1)}><Icon name="arrow_back" size={18} />Back</button>}
        {step === "Review" ? (
          <button type="button" className="btn primary" disabled={busy} onClick={submit}>
            {busy ? <span className="spinner small on-accent" /> : <Icon name="check" size={18} />}{first ? "Set up" : "Apply"}
          </button>
        ) : (
          <button type="button" className="btn primary" disabled={!ok} onClick={() => setAt(at + 1)}>Continue<Icon name="arrow_forward" size={18} /></button>
        )}
      </div>
    </div>
  );
}

// ---- overview ----

// Progress shows setup's step and how far along it is, then each step's outcome.
function Progress({ state }: { state: MailState }) {
  const { job } = state;
  if (!job.running && !job.steps.length) return null;
  const percent = job.total ? Math.min(100, Math.round((job.done / job.total) * 100)) : 0;
  const bad = job.steps.filter((s) => !s.ok).length;
  return (
    <Card title={job.running ? `${job.step || "Starting"} · ${percent}%` : "Last setup run"}
      sub={job.running ? undefined : bad ? `${bad} ${bad === 1 ? "step needs" : "steps need"} attention` : "Everything is in place"}>
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

// Next is what is left to do, in order, each with the way to do it.
function Next({ state, records }: { state: MailState; records: MailRecords[] | null }) {
  const missing = (records ?? []).filter((d) => !d.cloudflare).flatMap((d) => d.records.filter((r) => !r.found));
  const items: { done: boolean; title: string; body: ReactNode }[] = [
    {
      done: records !== null && missing.length === 0,
      title: "DNS records",
      body: records === null ? "Checking DNS…" : missing.length === 0 ? "Every record answers." : (
        <>
          <span>{missing.length} {missing.length === 1 ? "record is" : "records are"} not in DNS yet.</span>
          <a className="btn small how-link" href="#/mail/domains"><Icon name="dns" size={16} />Show what to add</a>
        </>
      ),
    },
    {
      done: state.accounts.length > 0,
      title: "An account",
      body: state.accounts.length > 0 ? `${state.accounts.length} so far.` : (
        <>
          <span>Each address that receives mail needs one.</span>
          <a className="btn small how-link" href="#/mail/accounts"><Icon name="person" size={16} />Make one</a>
        </>
      ),
    },
    {
      done: !!state.servers,
      title: "A mail app",
      body: state.servers ? (
        <>
          <span>Sign in with the full address and its password.</span>
          <span className="mail-servers">
            <span className="muted">IMAP</span><Copy text={`${state.servers.imap_host}:${state.servers.imap_port}`} />
            <span className="muted">SMTP</span><Copy text={`${state.servers.smtp_host}:${state.servers.smtp_port}`} />
          </span>
        </>
      ) : "Tailscale is not connected; mail apps reach this server once it is.",
    },
  ];
  return (
    <Card title="Getting mail flowing">
      <ol className="how mail-next">
        {items.map((it, i) => (
          <li key={it.title}>
            <span className={"how-num" + (it.done ? " done" : "")}>{it.done ? <Icon name="check" size={16} /> : i + 1}</span>
            <div className="how-body"><b>{it.title}</b>{typeof it.body === "string" ? <span className="muted">{it.body}</span> : it.body}</div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function Overview({ state, records, onState, onChange }: { state: MailState; records: MailRecords[] | null; onState: (s: MailState) => void; onChange: () => void }) {
  const can = useCan();
  const act = useAct(onState);
  const s = state.settings;
  const manage = can("mail.manage");
  return (
    <div className="page-body stack">
      <Progress state={state} />
      <Next state={state} records={records} />
      <Card title="How mail moves" action={manage ? <button type="button" className="btn" onClick={onChange}><Icon name="tune" size={18} />Change</button> : undefined}>
        <Row title="Receiving" sub={RECEIVE.find((o) => o.value === s.receive)?.hint}><span className="chip">{labelOf(RECEIVE, s.receive)}</span></Row>
        <Row title="Mail apps" sub={APPS.find((o) => o.value === s.apps)?.hint}><span className="chip">{labelOf(APPS, s.apps)}</span></Row>
        <Row title="Sending" sub={s.send === "relay" && s.relay ? `${s.relay.host}:${s.relay.port}` : SEND.find((o) => o.value === s.send)?.hint}>
          <span className="chip">{labelOf(SEND, s.send)}</span>
        </Row>
        {state.queued > 0 && (
          <Row title={`${state.queued} waiting to send`} sub="Tried again with growing waits, for four days">
            {manage && <button type="button" className="btn" onClick={() => act(api.retryMail, "Trying now")}><Icon name="refresh" size={18} />Try now</button>}
          </Row>
        )}
      </Card>
      {manage && (
        <Card title="Security">
          <Row title="Refuse spoofed mail" sub="Turn away mail its sender's DMARC policy rejects, rather than file it in Junk">
            <Switch label="Refuse spoofed mail" on={s.reject_dmarc} onChange={(v) => act(() => api.mailOptions({ reject_dmarc: v }))} />
          </Row>
          <Row title="Keep sent mail" sub="A copy in Sent of what mail apps send">
            <Switch label="Keep sent mail" on={s.save_sent} onChange={(v) => act(() => api.mailOptions({ save_sent: v }))} />
          </Row>
        </Card>
      )}
    </div>
  );
}

// ---- domains ----

function RecordsTable({ list }: { list: MailRecords }) {
  return (
    <div className="table-wrap">
      <table className="table mail-records">
        <thead>
          <tr><th /><th>Type</th><th>Name</th><th className="grow">Value</th></tr>
        </thead>
        <tbody>
          {list.records.map((r) => (
            <tr key={r.kind + r.name}>
              <td title={r.found ? "In DNS" : "Not in DNS yet"}><span className={"dot " + (r.found ? "ok" : "warn")} /></td>
              <td><span className="chip mono">{r.kind}</span></td>
              <td><Copy text={r.name} /></td>
              <td className="mail-value">
                {r.priority !== null && <span className="muted">Priority {r.priority} · </span>}
                <Copy text={r.value} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Managers({ domain, state, onState }: { domain: MailDomain; state: MailState; onState: (s: MailState) => void }) {
  const can = useCan();
  const act = useAct(onState);
  const manage = can("mail.manage");
  const nameOf = (id: string) => state.people.find((p) => p.id === id)?.name ?? "Someone";
  const set = (ids: string[], done: string) => act(() => api.editMailDomain(domain.name, { managers: ids }), done);
  const n = domain.managers.length;
  if (!manage) {
    return <Row title="Managers" sub="Dashboard accounts that run this domain's accounts and aliases"><span className="muted">{n ? `${n} ${n === 1 ? "manager" : "managers"}` : "Only mail's admins"}</span></Row>;
  }
  return (
    <Row title="Managers" sub="Dashboard accounts with View mail that run this domain's accounts and aliases">
      <span className="access">
        {domain.managers.length === 0 && <span className="muted">Only mail's admins</span>}
        {domain.managers.map((id) => (
          <span key={id} className="chip plain">
            {nameOf(id)}
            {manage && (
              <button type="button" className="chip-x" aria-label={`Remove ${nameOf(id)}`} title="Remove"
                onClick={() => set(domain.managers.filter((m) => m !== id), `${nameOf(id)} no longer manages ${domain.name}`)}>
                <Icon name="close" size={14} />
              </button>
            )}
          </span>
        ))}
        {manage && (
          <AddMenu label="Add a manager" placeholder="Find an account" empty={<div className="menu-note">No other dashboard accounts yet</div>}
            items={state.people.map((p) => ({ id: p.id, label: p.name, avatar: p.name, disabled: domain.managers.includes(p.id), note: "Already manages it" }))}
            onPick={(id) => set([...domain.managers, id], `${nameOf(id)} manages ${domain.name}`)} />
        )}
      </span>
    </Row>
  );
}

function DomainCard({ domain, primary, list, state, onState }: {
  domain: MailDomain; primary: boolean; list: MailRecords | undefined; state: MailState; onState: (s: MailState) => void;
}) {
  const can = useCan();
  const act = useAct(onState);
  const cloudflare = useCloudflare();
  const manage = can("mail.manage");
  const onCf = !!domain.zone_id;
  const missing = list ? list.records.filter((r) => !r.found).length : null;
  const count = state.accounts.filter((a) => domainOf(a.address) === domain.name).length;
  const actions: MenuAction[] = [
    onCf
      ? { label: "Add records by hand", icon: "dns", hint: "Stop writing them to Cloudflare; you keep them at your DNS host",
          onClick: () => act(() => api.editMailDomain(domain.name, { cloudflare: false }), `${domain.name} keeps its records by hand`) }
      : { label: "Keep records on Cloudflare", icon: "cloud", hint: "Setup writes them to the zone of the same name",
          onClick: () => {
            const go = () => act(() => api.editMailDomain(domain.name, { cloudflare: true }), `${domain.name} is on Cloudflare`);
            if (cloudflare(go)) go();
          } },
    ...(!primary || state.settings.domains.length === 1 ? [{
      label: "Remove", icon: "delete" as IconName, danger: true, confirm: "Remove for good", hint: "Its accounts and their mail stay until removed",
      onClick: () => act(() => api.removeMailDomain(domain.name), `Removed ${domain.name}`),
    }] : []),
  ];
  return (
    <Card
      title={<>{domain.name}{primary && <span className="chip small-chip">Primary</span>}</>}
      sub={[onCf ? "Records on Cloudflare" : "Records added by hand",
        missing === null ? "checking DNS" : missing === 0 ? "all in DNS" : `${missing} not in DNS yet`,
        `${count} ${count === 1 ? "account" : "accounts"}`].join(" · ")}
      action={manage ? <MoreMenu label={`Actions for ${domain.name}`} actions={actions} /> : undefined}>
      {list && (
        <>
          <p className="card-note muted">
            {onCf
              ? "Setup writes these to Cloudflare. Each turns green once DNS answers with it."
              : "Add these at the domain's DNS host. Each turns green once DNS answers with it; that can take a few minutes."}
          </p>
          <RecordsTable list={list} />
        </>
      )}
      <Managers domain={domain} state={state} onState={onState} />
      <Row title="Accounts" sub={count ? `${count} at @${domain.name}` : "None yet"}>
        <a className="btn" href="#/mail/accounts"><Icon name="group" size={18} />Accounts</a>
      </Row>
    </Card>
  );
}

// AddDomain is a flow of two steps: where the domain's DNS is kept, then which domain.
function AddDomain({ state, onState, onClose }: { state: MailState; onState: (s: MailState) => void; onClose: () => void }) {
  const act = useAct(onState);
  const [dns, setDns] = useState<Dns>("hand");
  const [name, setName] = useState("");
  const [zone, setZone] = useState("");
  const [busy, setBusy] = useState(false);
  const zones = useZones(dns === "cloudflare");
  const taken = state.settings.domains.map((d) => d.name);
  const cfWays = state.settings.receive === "cloudflare" || state.settings.send === "cloudflare";
  const domain = cleanDomain(name);
  const ok = dns === "hand" ? DOMAIN.test(domain) && !taken.includes(domain) : !!zone;
  return (
    <Dialog title="Add a domain" wide onClose={onClose}>
      <div className="stack">
        {cfWays && dns === "hand" && (
          <Callout tone="warn" icon="cloud">Mail is received or sent through Cloudflare, which needs every domain's records there. Pick Cloudflare, or change how mail moves first.</Callout>
        )}
        <DomainPick dns={dns} onDns={setDns} name={name} onName={setName} zone={zone} onZone={setZone} zones={zones} taken={taken} />
        <div className="edit-actions">
          <button type="button" className="btn text" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={!ok || busy || (cfWays && dns === "hand")}
            onClick={async () => {
              setBusy(true);
              const label = dns === "hand" ? domain : zones?.find((z) => z.id === zone)?.name ?? "";
              if (await act(() => api.addMailDomain(dns === "hand" ? { name: domain } : { zone_id: zone }), `Added ${label}`)) onClose();
              else setBusy(false);
            }}>
            {busy ? <span className="spinner small on-accent" /> : <Icon name="add" size={18} />}Add
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function Domains({ state, records, checking, onCheck, onState }: {
  state: MailState; records: MailRecords[] | null; checking: boolean; onCheck: () => void; onState: (s: MailState) => void;
}) {
  const can = useCan();
  const [adding, setAdding] = useState(false);
  return (
    <div className="page-body stack">
      <div className="mail-bar-row">
        <button type="button" className="btn" disabled={checking} onClick={onCheck}>
          {checking ? <span className="spinner small" /> : <Icon name="refresh" size={18} />}Check DNS again
        </button>
        {can("mail.manage") && <button type="button" className="btn primary" onClick={() => setAdding(true)}><Icon name="add" size={18} />Add a domain</button>}
      </div>
      {state.settings.domains.map((d, i) => (
        <DomainCard key={d.name} domain={d} primary={i === 0} list={records?.find((r) => r.domain === d.name)} state={state} onState={onState} />
      ))}
      {adding && <AddDomain state={state} onState={onState} onClose={() => setAdding(false)} />}
    </div>
  );
}

// ---- accounts, by domain ----

function AccountRow({ account, runs, onState, onPassword }: { account: MailAccount; runs: boolean; onState: (s: MailState) => void; onPassword: () => void }) {
  const act = useAct(onState);
  const a = account;
  const actions: MenuAction[] = runs ? [
    { label: "Change password", icon: "password", onClick: onPassword },
    a.apps
      ? { label: "Turn mail apps off", icon: "block", hint: "IMAP and SMTP refuse it; mail still arrives", onClick: () => act(() => api.editMailAccount(a.address, { apps: false }), "Mail apps are off for it") }
      : { label: "Turn mail apps on", icon: "check_circle", hint: "It can sign in to IMAP and SMTP again", onClick: () => act(() => api.editMailAccount(a.address, { apps: true }), "Mail apps are on for it") },
    { label: "Remove", icon: "delete", danger: true, confirm: "Remove with its mail", onClick: () => act(() => api.removeMailAccount(a.address), `Removed ${a.address}`) },
  ] : [];
  return (
    <li className="ct-row">
      <div className="ct-row-main">
        <span className={"ct-kind " + (a.apps ? "ok" : "")} title={a.apps ? "Mail apps on" : "Mail apps off"}><Icon name="person" /></span>
        <span className="ct-name-text">
          <b>{a.address}</b>
          <small>{[a.name, `${a.messages} messages`, bytes(a.size)].filter(Boolean).join(" · ")}</small>
        </span>
        <span className={"chip " + (a.apps ? "ok" : "warn")} title={a.apps ? "Can sign in to IMAP and SMTP" : "IMAP and SMTP refuse it"}>
          <Icon name={a.apps ? "lock" : "block"} size={14} />{a.apps ? "Mail apps on" : "Mail apps off"}
        </span>
      </div>
      {actions.length > 0 && <span className="ct-menu"><MoreMenu label={`Actions for ${a.address}`} actions={actions} /></span>}
    </li>
  );
}

function DomainAccounts({ domain, state, onState }: { domain: string; state: MailState; onState: (s: MailState) => void }) {
  const act = useAct(onState);
  const runs = state.manages.includes(domain);
  const [adding, setAdding] = useState(false);
  const [alias, setAlias] = useState(false);
  const [password, setPassword] = useState<string | null>(null);
  const accounts = state.accounts.filter((a) => domainOf(a.address) === domain);
  const aliases = state.aliases.filter((x) => domainOf(x.alias) === domain);
  const targets = state.accounts.filter((a) => state.manages.includes(domainOf(a.address))).map((a) => a.address);
  return (
    <Card title={`@${domain}`} sub={`${accounts.length} ${accounts.length === 1 ? "account" : "accounts"}${aliases.length ? ` · ${aliases.length} ${aliases.length === 1 ? "alias" : "aliases"}` : ""}`}
      action={runs ? (
        <MoreMenu label={`Add at ${domain}`} icon="add" actions={[
          { label: "New account", icon: "person", hint: "An address with its own mailbox and password", onClick: () => setAdding(true) },
          ...(targets.length ? [{ label: "New alias", icon: "call_split" as IconName, hint: "Another address, or @ for the rest, delivered to an account", onClick: () => setAlias(true) }] : []),
        ]} />
      ) : undefined}>
      {accounts.length === 0 && <p className="empty-note mail-none">No accounts at @{domain} yet.{runs ? " Add one with the plus." : ""}</p>}
      <ul className="results ct-list">
        {accounts.map((a) => <AccountRow key={a.address} account={a} runs={runs} onState={onState} onPassword={() => setPassword(a.address)} />)}
      </ul>
      {aliases.map((x) => (
        <Row key={x.alias} title={x.alias.startsWith("@") ? `Everything else at ${x.alias}` : x.alias} sub={`Delivered to ${x.target}`}>
          {runs && <MoreMenu label={`Actions for ${x.alias}`} actions={[{ label: "Remove", icon: "delete", danger: true, onClick: () => act(() => api.removeMailAlias(x.alias), `Removed ${x.alias}`) }]} />}
        </Row>
      ))}
      {adding && <NewAccount domain={domain} onClose={() => setAdding(false)}
        onSave={(address, name, pass) => act(() => api.addMailAccount({ address, name, password: pass }), `Added ${address}`)} />}
      {alias && <NewAlias accounts={targets} domain={domain} onClose={() => setAlias(false)}
        onSave={(from, to) => act(() => api.setMailAlias(from, to), `${from} goes to ${to}`)} />}
      {password && <NewPassword address={password} onClose={() => setPassword(null)}
        onSave={(address, pass) => act(() => api.editMailAccount(address, { password: pass }), "Password changed")} />}
    </Card>
  );
}

function Accounts({ state, onState }: { state: MailState; onState: (s: MailState) => void }) {
  const names = state.settings.domains.map((d) => d.name);
  // Domains the caller runs come first.
  const ordered = [...names.filter((n) => state.manages.includes(n)), ...names.filter((n) => !state.manages.includes(n))];
  return (
    <div className="page-body stack">
      {ordered.map((d) => <DomainAccounts key={d} domain={d} state={state} onState={onState} />)}
    </div>
  );
}

function NewAccount({ domain, onClose, onSave }: { domain: string; onClose: () => void; onSave: (address: string, name: string, password: string) => Promise<boolean> }) {
  const [local, setLocal] = useState("");
  const [name, setName] = useState("");
  const [pass, setPass] = useState("");
  const full = `${local.trim().replace(/@.*$/, "")}@${domain}`;
  return (
    <Dialog title={`New account at @${domain}`} onClose={onClose}>
      <form onSubmit={async (e) => {
        e.preventDefault();
        if (await onSave(full, name.trim(), pass)) onClose();
      }}>
        <TextField label="Address" autoFocus autoComplete="off" value={local} onChange={setLocal} trailing={<span className="muted">@{domain}</span>}
          hint={local.trim() ? full : `Such as you@${domain}`} />
        <TextField label="Name" autoComplete="off" value={name} onChange={setName} hint="Shown as who mail is from" />
        <TextField label="Password" type="password" autoComplete="new-password" data-1p-ignore value={pass} onChange={setPass}
          hint="What mail apps sign in with, with the full address" />
        <div className="edit-actions">
          <button type="button" className="btn text" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!local.trim() || !pass}>Add</button>
        </div>
      </form>
    </Dialog>
  );
}

function NewAlias({ accounts, domain, onClose, onSave }: { accounts: string[]; domain: string; onClose: () => void; onSave: (alias: string, target: string) => Promise<boolean> }) {
  const [local, setLocal] = useState("");
  const [target, setTarget] = useState(accounts.find((a) => domainOf(a) === domain) ?? accounts[0] ?? "");
  const full = `${local.trim().replace(/@.*$/, "")}@${domain}`;
  return (
    <Dialog title={`New alias at @${domain}`} onClose={onClose}>
      <form onSubmit={async (e) => {
        e.preventDefault();
        if (await onSave(full, target)) onClose();
      }}>
        <TextField label="Address" autoFocus autoComplete="off" value={local} onChange={setLocal} trailing={<span className="muted">@{domain}</span>}
          hint={local.trim() ? full : `Such as sales; leave it empty for everything else at @${domain}`} />
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

// ---- activity ----

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

// ---- the page ----

const TABS: [string, string, IconName][] = [
  ["overview", "Overview", "dashboard"],
  ["domains", "Domains", "public"],
  ["accounts", "Accounts", "group"],
  ["activity", "Activity", "history"],
];

// MailPage is the mail server: set up a step at a time the first time,
// then what is left to do, its domains and their records and managers, the
// accounts at each domain, and activity.
export function MailPage({ tab }: { tab: string }) {
  const can = useCan();
  const [state, setState] = useState<MailState | null>(null);
  const act = useAct(setState);
  const [problem, setProblem] = useState("");
  const [changing, setChanging] = useState(false);
  const [records, setRecords] = useState<MailRecords[] | null>(null);
  const [checking, setChecking] = useState(false);

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
  // DNS is asked again when the domains or the ways change, and after setup runs.
  const shape = state ? JSON.stringify([state.settings.domains.map((d) => [d.name, d.zone_id]), state.settings.receive, state.settings.send, state.settings.apps]) : "";
  const check = useCallback(async () => {
    setChecking(true);
    try {
      setRecords(await api.mailRecords());
    } catch {
      setRecords(null);
    }
    setChecking(false);
  }, []);
  useEffect(() => {
    if (live && !running) check();
  }, [live, running, shape, check]);

  if (!state) return problem ? <div className="page-body"><Callout tone="bad" icon="error">{problem}</Callout></div> : null;
  const current = TABS.some(([k]) => k === tab) ? tab : "overview";
  const manage = can("mail.manage");

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Mail</h1>
          {live && (
            <div className="page-sub">
              <span><b>{state.settings.domains.length}</b> {state.settings.domains.length === 1 ? "domain" : "domains"}</span>
              <span><b>{state.accounts.length}</b> {state.accounts.length === 1 ? "account" : "accounts"}</span>
              <span>on {state.hostname}</span>
            </div>
          )}
        </div>
        {live && manage && (
          <div className="page-actions">
            <MoreMenu label="Mail actions" actions={[
              { label: "Change how mail moves", icon: "tune", onClick: () => setChanging(true) },
              { label: "Run setup again", icon: "refresh", onClick: () => act(api.rerunMail, "Setting up again") },
              { label: "Turn off", icon: "block", danger: true, confirm: "Close its ports", onClick: () => act(api.mailOff, "Mail is off") },
            ]} />
          </div>
        )}
      </div>
      {!live ? (
        <div className="page-body stack">
          {manage
            ? <Wizard state={state} onDone={setState} />
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
          {current === "overview" && <Overview state={state} records={records} onState={setState} onChange={() => setChanging(true)} />}
          {current === "domains" && <Domains state={state} records={records} checking={checking} onCheck={check} onState={setState} />}
          {current === "accounts" && <Accounts state={state} onState={setState} />}
          {current === "activity" && <Activity />}
        </>
      )}
      {changing && (
        <Dialog title="Change how mail moves" wide onClose={() => setChanging(false)}>
          <Wizard state={state} onCancel={() => setChanging(false)} onDone={(s) => {
            setState(s);
            setChanging(false);
          }} />
        </Dialog>
      )}
    </>
  );
}
