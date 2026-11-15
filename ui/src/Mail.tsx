import { useCallback, useContext, useEffect, useState } from "react";
import { NeedsContext } from "./Apps";
import { useCloudflare, useCloudflareReady } from "./Cloudflare";
import {
  api, bytes, message,
  type MailAccount, type MailApps, type MailDomain, type MailLog, type MailReceive, type MailRecords, type MailSend, type MailState, type Zone,
} from "./api";
import { Dropdown, MultiDropdown, type Option } from "./Dropdown";
import { Icon, type IconName } from "./Icon";
import { useCan } from "./me";
import { AddMenu, Callout, Card, Copy, Dialog, MoreMenu, Row, Switch, TextField, useNotify, type MenuAction } from "./ui";

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
const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const cleanDomain = (v: string) => v.trim().toLowerCase().replace(/^@/, "").replace(/\.$/, "");
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

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

// Zones loads the Cloudflare account's domains once they are wanted and Cloudflare is connected.
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

// Wizard sets mail up, or changes how it moves: the domain (the first time),
// then how mail arrives, how mail apps connect and how mail leaves.
function Wizard({ state, onDone, onCancel }: { state: MailState; onDone: (s: MailState) => void; onCancel?: () => void }) {
  const needs = useContext(NeedsContext);
  const notify = useNotify();
  const cloudflare = useCloudflare();
  const s = state.settings;
  const first = s.domains.length === 0;
  const [name, setName] = useState("");
  const [imported, setImported] = useState(false);
  const [zone, setZone] = useState("");
  const zones = useZones(first && imported);
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

  useEffect(() => {
    if (imported && zones?.length && !zones.some((z) => z.id === zone)) setZone(zones[0].id);
  }, [imported, zones, zone]);

  // The Cloudflare ways need every domain's records on Cloudflare.
  const onCloudflare = (first ? imported : true) && s.domains.every((d) => !!d.zone_id);
  useEffect(() => {
    if (onCloudflare) return;
    setReceive((r) => (r === "cloudflare" ? "port" : r));
    setSend((v) => (v === "cloudflare" ? "direct" : v));
  }, [onCloudflare]);
  const cfOnly = <T extends string>(o: Way<T>): Way<T> => (o.value === "cloudflare" && !onCloudflare ? { ...o, disabled: true, hint: "Needs domains imported from Cloudflare" } : o);
  const appWays = APPS.map((o) => (o.value === "tailscale" && needs && !needs.tailscale ? { ...o, disabled: true, hint: "Install Tailscale from Apps first" } : o));

  const domain = imported ? zones?.find((z) => z.id === zone)?.name ?? "" : cleanDomain(name);
  const steps = [...(first ? ["Domain"] : []), "Receiving", "Mail apps", "Sending"];
  const step = steps[at];
  const last = at === steps.length - 1;
  const relayOk = send !== "relay" || (!!host.trim() && Number(port) > 0 && (!!password || !!s.relay?.password_set || !username.trim()));
  const ok = step === "Domain" ? (imported ? !!zone : DOMAIN.test(domain)) : step === "Sending" ? relayOk : true;

  const submit = async () => {
    setBusy(true);
    try {
      onDone(await api.setupMail({
        zone_id: first && imported ? zone : null,
        domain: first && !imported ? domain : null,
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
        {step === "Domain" && (
          <>
            <h2 className="wizard-q">Which domain is mail for?</h2>
            {!imported ? (
              <TextField label="Domain" autoFocus mono autoComplete="off" placeholder="example.com" value={name} onChange={setName}
                hint={DOMAIN.test(domain) ? `Addresses like you@${domain}` : undefined} />
            ) : zones === null ? (
              <div className="muted"><span className="spinner small" /> Loading your Cloudflare domains</div>
            ) : zones.length === 0 ? (
              <Callout tone="warn" icon="cloud">This Cloudflare account has no domains.</Callout>
            ) : (
              <div className="tf static">
                <div className="tf-box">
                  <Dropdown label="Domain" value={zone} onChange={setZone} options={zones.map((z) => ({ value: z.id, label: z.name }))} />
                  <span className="tf-label">Domain</span>
                </div>
              </div>
            )}
            <button type="button" className="btn text wizard-alt"
              onClick={() => {
                if (imported) return setImported(false);
                if (cloudflare(() => setImported(true))) setImported(true);
              }}>
              <Icon name={imported ? "edit" : "cloud"} size={18} />{imported ? "Type it instead" : "Import from Cloudflare"}
            </button>
          </>
        )}
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

// ---- overview ----

// Setup shows its step while it runs, and afterwards only the steps that failed.
function Setup({ state, onState }: { state: MailState; onState: (s: MailState) => void }) {
  const can = useCan();
  const act = useAct(onState);
  const { job } = state;
  const failed = job.steps.filter((s) => !s.ok);
  if (job.running) {
    const percent = job.total ? Math.min(100, Math.round((job.done / job.total) * 100)) : 0;
    return (
      <Card title={`${job.step || "Starting"} · ${percent}%`}>
        <div className="mail-bar" aria-hidden><span style={{ width: `${percent}%` }} /></div>
      </Card>
    );
  }
  if (!failed.length) return null;
  return (
    <Card title={`${plural(failed.length, "setup step")} failed`}
      action={can("mail.manage") ? <button type="button" className="btn" onClick={() => act(api.rerunMail, "Setting up again")}><Icon name="refresh" size={18} />Run again</button> : undefined}>
      {failed.map((s, i) => (
        <Row key={i} title={<span className="mail-state"><span className="dot bad" />{s.name}</span>} sub={s.detail || undefined} />
      ))}
    </Card>
  );
}

function Overview({ state, records, onState, onChange }: { state: MailState; records: MailRecords[] | null; onState: (s: MailState) => void; onChange: () => void }) {
  const can = useCan();
  const act = useAct(onState);
  const s = state.settings;
  const manage = can("mail.manage");
  const missing = (records ?? []).reduce((n, d) => n + d.records.filter((r) => !r.found).length, 0);
  return (
    <div className="page-body stack">
      <Setup state={state} onState={onState} />
      {missing > 0 && (
        <a className="mail-todo" href="#/mail/domains">
          <Icon name="dns" size={20} />
          <span>{plural(missing, "DNS record")} to add</span>
          <Icon name="arrow_forward" size={18} />
        </a>
      )}
      {state.accounts.length === 0 && (
        <a className="mail-todo" href="#/mail/accounts">
          <Icon name="person" size={20} />
          <span>No accounts yet</span>
          <Icon name="arrow_forward" size={18} />
        </a>
      )}
      <Card title="How mail moves" action={manage ? <button type="button" className="btn" onClick={onChange}><Icon name="tune" size={18} />Change</button> : undefined}>
        <Row title="Receiving"><span className="chip">{labelOf(RECEIVE, s.receive)}</span></Row>
        <Row title="Mail apps"><span className="chip">{labelOf(APPS, s.apps)}</span></Row>
        <Row title="Sending" sub={s.send === "relay" && s.relay ? `${s.relay.host}:${s.relay.port}` : undefined}><span className="chip">{labelOf(SEND, s.send)}</span></Row>
        {state.queued > 0 && (
          <Row title={`${state.queued} waiting to send`}>
            {manage && <button type="button" className="btn" onClick={() => act(api.retryMail, "Trying now")}><Icon name="refresh" size={18} />Try now</button>}
          </Row>
        )}
      </Card>
      <Card title="Signing in" sub="In Outlook, Gmail or any app with IMAP, with the full address and its password">
        {state.servers ? (
          <>
            <Row title="IMAP"><Copy text={`${state.servers.imap_host}:${state.servers.imap_port}`} /></Row>
            <Row title="SMTP"><Copy text={`${state.servers.smtp_host}:${state.servers.smtp_port}`} /></Row>
          </>
        ) : <Row title="Waiting for Tailscale" sub="Mail apps reach this server once Tailscale is connected" />}
      </Card>
      {manage && (
        <Card title="Options">
          <Row title="Refuse spoofed mail" sub="Turn away what its sender's DMARC rejects, rather than file it in Junk">
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

function RecordsDialog({ list, checking, onCheck, onClose }: { list: MailRecords; checking: boolean; onCheck: () => void; onClose: () => void }) {
  return (
    <Dialog title={`DNS records for ${list.domain}`} wide onClose={onClose}>
      <div className="stack">
        <p className="muted">{list.cloudflare ? "Kept in sync on Cloudflare." : "Add these where the domain's DNS is hosted. Each turns green once DNS answers with it."}</p>
        <RecordsTable list={list} />
        <div className="edit-actions">
          <button type="button" className="btn" disabled={checking} onClick={onCheck}>
            {checking ? <span className="spinner small" /> : <Icon name="refresh" size={18} />}Check again
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function ManagersDialog({ domain, state, onState, onClose }: { domain: MailDomain; state: MailState; onState: (s: MailState) => void; onClose: () => void }) {
  const act = useAct(onState);
  const nameOf = (id: string) => state.people.find((p) => p.id === id)?.name ?? "Someone";
  const set = (ids: string[], done: string) => act(() => api.editMailDomain(domain.name, { managers: ids }), done);
  return (
    <Dialog title={`Managers of ${domain.name}`} onClose={onClose}>
      <div className="stack">
        <p className="muted">Dashboard accounts with View mail that run this domain's accounts and aliases.</p>
        <span className="access">
          {domain.managers.length === 0 && <span className="muted">Only mail's admins</span>}
          {domain.managers.map((id) => (
            <span key={id} className="chip plain">
              {nameOf(id)}
              <button type="button" className="chip-x" aria-label={`Remove ${nameOf(id)}`} title="Remove"
                onClick={() => set(domain.managers.filter((m) => m !== id), `${nameOf(id)} no longer manages ${domain.name}`)}>
                <Icon name="close" size={14} />
              </button>
            </span>
          ))}
          <AddMenu label="Add a manager" placeholder="Find an account" empty={<div className="menu-note">No other dashboard accounts yet</div>}
            items={state.people.map((p) => ({ id: p.id, label: p.name, avatar: p.name, disabled: domain.managers.includes(p.id), note: "Already manages it" }))}
            onPick={(id) => set([...domain.managers, id], `${nameOf(id)} manages ${domain.name}`)} />
        </span>
      </div>
    </Dialog>
  );
}

function DomainRow({ domain, primary, list, state, onState, onRecords, onManagers }: {
  domain: MailDomain; primary: boolean; list: MailRecords | undefined; state: MailState;
  onState: (s: MailState) => void; onRecords: () => void; onManagers: () => void;
}) {
  const can = useCan();
  const act = useAct(onState);
  const cloudflare = useCloudflare();
  const manage = can("mail.manage");
  const synced = !!domain.zone_id;
  const missing = list ? list.records.filter((r) => !r.found).length : null;
  const accounts = state.accounts.filter((a) => domainOf(a.address) === domain.name).length;
  const actions: MenuAction[] = [
    { label: "DNS records", icon: "dns", onClick: onRecords },
    ...(manage ? [
      { label: "Managers", icon: "group" as IconName, onClick: onManagers },
      synced
        ? { label: "Stop syncing with Cloudflare", icon: "cloud" as IconName, onClick: () => act(() => api.editMailDomain(domain.name, { cloudflare: false }), `${domain.name} keeps its records by hand`) }
        : { label: "Sync with Cloudflare", icon: "cloud" as IconName, onClick: () => {
            const go = () => act(() => api.editMailDomain(domain.name, { cloudflare: true }), `${domain.name} syncs with Cloudflare`);
            if (cloudflare(go)) go();
          } },
      ...(!primary || state.settings.domains.length === 1 ? [{
        label: "Remove", icon: "delete" as IconName, danger: true, confirm: "Remove for good",
        onClick: () => act(() => api.removeMailDomain(domain.name), `Removed ${domain.name}`),
      }] : []),
    ] : []),
  ];
  const tone = missing === null ? "" : missing ? "warn" : "ok";
  return (
    <li className="ct-row mail-row">
      <button type="button" className="ct-row-main" onClick={onRecords}>
        <span className={"ct-kind " + tone} title={missing === null ? "Checking DNS" : missing ? `${plural(missing, "record")} not in DNS yet` : "Every record is in DNS"}>
          <Icon name="public" />
        </span>
        <span className="ct-name-text">
          <b>{domain.name}{primary && <span className="chip">Primary</span>}{synced && <span className="chip"><Icon name="cloud" size={14} />Cloudflare</span>}</b>
          <small>{[missing === null ? "Checking DNS" : missing ? `${plural(missing, "record")} to add` : "DNS ready", plural(accounts, "account")].join(" · ")}</small>
        </span>
      </button>
      <span className="ct-menu"><MoreMenu label={`Actions for ${domain.name}`} actions={actions} /></span>
    </li>
  );
}

function AddDomain({ state, onState, onClose }: { state: MailState; onState: (s: MailState) => void; onClose: () => void }) {
  const act = useAct(onState);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const taken = state.settings.domains.map((d) => d.name);
  const domain = cleanDomain(name);
  // Mail through Cloudflare needs every domain's records there, so those come from Import.
  const cfWays = state.settings.receive === "cloudflare" || state.settings.send === "cloudflare";
  const ok = DOMAIN.test(domain) && !taken.includes(domain) && !cfWays;
  return (
    <Dialog title="Add a domain" onClose={onClose}>
      {cfWays && <Callout tone="warn" icon="cloud">Mail moves through Cloudflare, so domains come from Import.</Callout>}
      <form onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        if (await act(() => api.addMailDomain({ name: domain }), `Added ${domain}`)) onClose();
        else setBusy(false);
      }}>
        <TextField label="Domain" autoFocus mono autoComplete="off" placeholder="example.com" value={name} onChange={setName}
          hint={taken.includes(domain) ? "Already added" : ok ? `Addresses like you@${domain}` : undefined} />
        <div className="edit-actions">
          <button type="button" className="btn text" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!ok || busy}>
            {busy ? <span className="spinner small on-accent" /> : <Icon name="add" size={18} />}Add
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// ImportDomains brings in domains from Cloudflare; their records stay in sync there.
function ImportDomains({ state, onState, onClose }: { state: MailState; onState: (s: MailState) => void; onClose: () => void }) {
  const act = useAct(onState);
  const zones = useZones(true);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const taken = state.settings.domains.map((d) => d.name);
  const free = (zones ?? []).filter((z) => !taken.includes(z.name.toLowerCase()));
  return (
    <Dialog title="Import from Cloudflare" onClose={onClose}>
      <div className="stack">
        {zones === null ? (
          <div className="muted"><span className="spinner small" /> Loading your Cloudflare domains</div>
        ) : free.length === 0 ? (
          <Callout icon="cloud">Every domain on this Cloudflare account is already here.</Callout>
        ) : (
          <div className="tf static">
            <div className="tf-box">
              <MultiDropdown label="Domains" values={picked} allLabel="Pick domains" onChange={setPicked}
                options={free.map((z) => ({ value: z.id, label: z.name }))} />
              <span className="tf-label">Domains</span>
            </div>
          </div>
        )}
        <div className="edit-actions">
          <button type="button" className="btn text" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={!picked.length || busy}
            onClick={async () => {
              setBusy(true);
              let ok = true;
              for (const id of picked) ok = (await act(() => api.addMailDomain({ zone_id: id }))) && ok;
              if (ok) {
                onClose();
                return;
              }
              setBusy(false);
            }}>
            {busy ? <span className="spinner small on-accent" /> : <Icon name="download" size={18} />}Import{picked.length > 1 ? ` ${picked.length}` : ""}
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
  const cloudflare = useCloudflare();
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const [managing, setManaging] = useState<string | null>(null);
  const manage = can("mail.manage");
  const list = (name: string) => records?.find((r) => r.domain === name);
  const shownList = shown ? list(shown) : undefined;
  const managed = state.settings.domains.find((d) => d.name === managing);
  return (
    <div className="page-body stack">
      {manage && (
        <div className="mail-bar-row">
          <MoreMenu label="Import" text="Import" icon="download" actions={[
            { label: "Cloudflare", icon: "cloud", hint: "Pick from your Cloudflare domains; their records stay in sync",
              onClick: () => { if (cloudflare(() => setImporting(true))) setImporting(true); } },
          ]} />
          <button type="button" className="btn primary" onClick={() => setAdding(true)}><Icon name="add" size={18} />Add domain</button>
        </div>
      )}
      <div className="card">
        <ul className="results ct-list">
          {state.settings.domains.map((d, i) => (
            <DomainRow key={d.name} domain={d} primary={i === 0} list={list(d.name)} state={state} onState={onState}
              onRecords={() => setShown(d.name)} onManagers={() => setManaging(d.name)} />
          ))}
        </ul>
      </div>
      {shownList && <RecordsDialog list={shownList} checking={checking} onCheck={onCheck} onClose={() => setShown(null)} />}
      {managed && <ManagersDialog domain={managed} state={state} onState={onState} onClose={() => setManaging(null)} />}
      {adding && <AddDomain state={state} onState={onState} onClose={() => setAdding(false)} />}
      {importing && <ImportDomains state={state} onState={onState} onClose={() => setImporting(false)} />}
    </div>
  );
}

// ---- accounts ----

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

function Accounts({ state, onState }: { state: MailState; onState: (s: MailState) => void }) {
  const act = useAct(onState);
  const [adding, setAdding] = useState(false);
  const [alias, setAlias] = useState(false);
  const [password, setPassword] = useState<string | null>(null);
  const names = state.settings.domains.map((d) => d.name);
  const runs = names.filter((n) => state.manages.includes(n));
  const targets = state.accounts.filter((a) => runs.includes(domainOf(a.address))).map((a) => a.address);
  // Domains the caller runs come first; a heading per domain only when there are several.
  const ordered = [...runs, ...names.filter((n) => !runs.includes(n))];
  const grouped = ordered.length > 1;
  const empty = state.accounts.length === 0 && state.aliases.length === 0;
  return (
    <div className="page-body stack">
      {runs.length > 0 && (
        <div className="mail-bar-row">
          {targets.length > 0 && <button type="button" className="btn" onClick={() => setAlias(true)}><Icon name="call_split" size={18} />New alias</button>}
          <button type="button" className="btn primary" onClick={() => setAdding(true)}><Icon name="add" size={18} />New account</button>
        </div>
      )}
      <div className="card">
        {empty ? <p className="empty-note mail-none">No accounts yet.</p> : (
          <ul className="results ct-list">
            {ordered.map((d) => {
              const accounts = state.accounts.filter((a) => domainOf(a.address) === d);
              const aliases = state.aliases.filter((x) => domainOf(x.alias) === d);
              if (!accounts.length && !aliases.length) return null;
              const mine = runs.includes(d);
              return [
                grouped && <li key={d} className="ct-group-head"><b>@{d}</b></li>,
                ...accounts.map((a) => <AccountRow key={a.address} account={a} runs={mine} onState={onState} onPassword={() => setPassword(a.address)} />),
                ...aliases.map((x) => <AliasRow key={x.alias} alias={x.alias} target={x.target} runs={mine} onState={onState} />),
              ];
            })}
          </ul>
        )}
      </div>
      {adding && <NewAccount domains={runs} onClose={() => setAdding(false)}
        onSave={(address, name, pass) => act(() => api.addMailAccount({ address, name, password: pass }), `Added ${address}`)} />}
      {alias && <NewAlias accounts={targets} domains={runs} onClose={() => setAlias(false)}
        onSave={(from, to) => act(() => api.setMailAlias(from, to), `${from} goes to ${to}`)} />}
      {password && <NewPassword address={password} onClose={() => setPassword(null)}
        onSave={(address, pass) => act(() => api.editMailAccount(address, { password: pass }), "Password changed")} />}
    </div>
  );
}

// DomainField picks which domain a new address is at, shown only when there is more than one.
function DomainField({ domains, value, onChange }: { domains: string[]; value: string; onChange: (v: string) => void }) {
  if (domains.length < 2) return null;
  return (
    <div className="tf static">
      <div className="tf-box">
        <Dropdown label="Domain" value={value} onChange={onChange} options={domains.map((d) => ({ value: d, label: "@" + d }))} />
        <span className="tf-label">Domain</span>
      </div>
    </div>
  );
}

function NewAccount({ domains, onClose, onSave }: { domains: string[]; onClose: () => void; onSave: (address: string, name: string, password: string) => Promise<boolean> }) {
  const [domain, setDomain] = useState(domains[0] ?? "");
  const [local, setLocal] = useState("");
  const [name, setName] = useState("");
  const [pass, setPass] = useState("");
  const full = `${local.trim().replace(/@.*$/, "")}@${domain}`;
  return (
    <Dialog title="New account" onClose={onClose}>
      <form onSubmit={async (e) => {
        e.preventDefault();
        if (await onSave(full, name.trim(), pass)) onClose();
      }}>
        <DomainField domains={domains} value={domain} onChange={setDomain} />
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
        <DomainField domains={domains} value={domain} onChange={setDomain} />
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
                <tr><th>Time</th><th /><th>From</th><th>To</th><th className="grow">Outcome</th></tr>
              </thead>
              <tbody>
                {log.map((e, i) => (
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

// MailPage is the IMAP and SMTP server: set up a step at a time the first
// time, then how mail moves, its domains, the accounts at them, and activity.
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
            </div>
          )}
        </div>
        {live && manage && (
          <div className="page-actions">
            <MoreMenu label="Mail actions" actions={[
              { label: "Run setup again", icon: "refresh", onClick: () => act(api.rerunMail, "Setting up again") },
              { label: "Turn off", icon: "block", danger: true, confirm: "Close its ports", onClick: () => act(api.mailOff, "Mail is off") },
            ]} />
          </div>
        )}
      </div>
      {!live ? (
        <div className="page-body">
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
