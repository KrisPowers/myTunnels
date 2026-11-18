import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useCloudflare } from "./Cloudflare";
import { api, message, type DnsRecord, type DnsZone, type MailDomain, type MailRecords, type MailState, type Redirect, type Redirects, type Registrar, type Route } from "./api";
import { Dropdown, MultiDropdown } from "./Dropdown";
import { Icon, type IconName } from "./Icon";
import { ForwardRows } from "./Forward";
import { cleanDomain, DOMAIN, domainOf, MailStatus, plural, useAct, useZones } from "./Mail";
import { useCan } from "./me";
import { go } from "./route";
import { ConnectRegistrar } from "./Registrars";
import { AddMenu, ArmedButton, Callout, Copy, Dialog, MoreMenu, Row, SubNav, Switch, TextField, useNotify, type MenuAction } from "./ui";

// Whether a hostname is the domain or under it.
const under = (host: string, domain: string) => host === domain || host.endsWith("." + domain);

// Where a domain's DNS is hosted: records added by hand anywhere, or its real
// zone, read and changed here, on Cloudflare or at a registrar.
type Host = "" | "cloudflare" | Registrar;
const HOSTS: { value: Host; label: string; icon: IconName; hint: string }[] = [
  { value: "", label: "DNS records", icon: "dns", hint: "Added by hand wherever its DNS is" },
  { value: "cloudflare", label: "Cloudflare", icon: "cloud", hint: "Read and changed here" },
  { value: "porkbun", label: "Porkbun", icon: "public", hint: "Read and changed here" },
  { value: "godaddy", label: "GoDaddy", icon: "public", hint: "Read and changed here" },
  { value: "namecheap", label: "Namecheap", icon: "public", hint: "Read and changed here" },
];
const isRegistrar = (h: Host): h is Registrar => h === "porkbun" || h === "godaddy" || h === "namecheap";

const hostOf = (d: MailDomain) => HOSTS.find((h) => h.value === (d.zone_id ? "cloudflare" : d.host || "")) ?? HOSTS[0];
const href = (name: string, tab?: string) => `#/domains/${encodeURIComponent(name)}${tab ? "/" + tab : ""}`;

// useDomains loads the domains, their addresses and whether DNS answers with each record.
function useDomains() {
  const [state, setState] = useState<MailState | null>(null);
  const [problem, setProblem] = useState("");
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
  const check = useCallback(async () => {
    setChecking(true);
    try {
      setRecords(await api.mailRecords());
    } catch {
      setRecords(null);
    }
    setChecking(false);
  }, []);
  // DNS is asked again whenever the domains or the ways mail moves change.
  const shape = state ? JSON.stringify([state.settings.domains.map((d) => [d.name, d.zone_id]), state.settings.receive, state.settings.send, state.settings.apps]) : "";
  const any = !!state?.settings.domains.length;
  useEffect(() => {
    if (any) check();
  }, [any, shape, check]);
  return { state, setState, problem, records, checking, check };
}

// ---- the list ----

// DomainsPage is the domains everything here is reached at: each with what
// uses it, its services and its mail addresses, and its DNS and redirects.
export function DomainsPage({ id, tab, routes, onChanged }: { id: string; tab: string; routes: Route[]; onChanged: () => Promise<void> }) {
  const can = useCan();
  const { state, setState, problem, records } = useDomains();
  const [adding, setAdding] = useState(false);
  const domain = id ? state?.settings.domains.find((d) => d.name === id.toLowerCase()) : undefined;
  useEffect(() => {
    if (id && state && !domain) go("#/domains");
  }, [id, state, domain]);

  if (!state) return problem ? <div className="page-body"><Callout tone="bad" icon="error">{problem}</Callout></div> : null;
  if (domain) {
    return <DomainPage domain={domain} tab={tab} state={state} onState={setState} routes={routes} onChanged={onChanged} />;
  }
  const domains = state.settings.domains;
  const manage = can("mail.manage");
  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Domains</h1>
          {domains.length > 0 && <div className="page-sub"><span><b>{domains.length}</b> {domains.length === 1 ? "domain" : "domains"}</span></div>}
        </div>
        {manage && (
          <div className="page-actions">
            <button type="button" className="btn primary" onClick={() => setAdding(true)}><Icon name="add" size={18} />Add domain</button>
          </div>
        )}
      </div>
      <div className="page-body stack">
        <div className="card">
          {domains.length === 0 ? <p className="empty-note mail-none">No domains yet.</p> : (
            <ul className="results ct-list">
              {domains.map((d, i) => (
                <DomainRow key={d.name} domain={d} primary={i === 0} list={records?.find((r) => r.domain === d.name)} state={state} onState={setState}
                  services={routes.filter((r) => under(r.hostname, d.name)).length} />
              ))}
            </ul>
          )}
        </div>
      </div>
      {adding && <AddDomain state={state} onState={setState} onClose={() => setAdding(false)} />}
    </>
  );
}

// Actions is what can be done to a domain, in its row's menu and on its page.
function useActions(domain: MailDomain, primary: boolean, state: MailState, onState: (s: MailState) => void, onManagers: () => void): MenuAction[] {
  const can = useCan();
  const act = useAct(onState);
  const cloudflare = useCloudflare();
  if (!can("mail.manage")) return [];
  const synced = !!domain.zone_id;
  return [
    ...(!primary ? [{ label: "Make primary", icon: "star" as IconName, hint: "The mail server is named after it",
      onClick: () => act(() => api.editMailDomain(domain.name, { primary: true }), `${domain.name} is the primary domain`) }] : []),
    { label: "Managers", icon: "group", onClick: onManagers },
    synced
      ? { label: "Stop syncing with Cloudflare", icon: "cloud", onClick: () => act(() => api.editMailDomain(domain.name, { cloudflare: false }), `${domain.name} keeps its records by hand`) }
      : { label: "Sync with Cloudflare", icon: "cloud", onClick: () => {
          const run = () => act(() => api.editMailDomain(domain.name, { cloudflare: true }), `${domain.name} syncs with Cloudflare`);
          if (cloudflare(run)) run();
        } },
    ...(!primary || state.settings.domains.length === 1 ? [{
      label: "Remove", icon: "delete" as IconName, danger: true, confirm: "Remove for good",
      onClick: async () => {
        if (await act(() => api.removeMailDomain(domain.name), `Removed ${domain.name}`)) go("#/domains");
      },
    }] : []),
  ];
}

function DomainRow({ domain, primary, list, state, onState, services }: {
  domain: MailDomain; primary: boolean; list: MailRecords | undefined; state: MailState; onState: (s: MailState) => void; services: number;
}) {
  const [managing, setManaging] = useState(false);
  const actions = useActions(domain, primary, state, onState, () => setManaging(true));
  const missing = list ? list.records.filter((r) => !r.found).length : null;
  const addresses = state.accounts.filter((a) => domainOf(a.address) === domain.name).length;
  const tone = missing === null ? "" : missing ? "warn" : "ok";
  return (
    <li className="ct-row mail-row">
      <a className="ct-row-main" href={href(domain.name)}>
        <span className={"ct-kind " + tone} title={missing === null ? "Checking DNS" : missing ? `${plural(missing, "record")} not in DNS yet` : "Every record is in DNS"}>
          <Icon name="public" />
        </span>
        <span className="ct-name-text">
          <b>{domain.name}</b>
          <small>{[hostOf(domain).label, missing === null ? "Checking DNS" : missing ? `${plural(missing, "record")} to add` : "DNS ready", plural(services, "service"), plural(addresses, "address", "addresses")].join(" · ")}</small>
        </span>
      </a>
      {actions.length > 0 && <span className="ct-menu"><MoreMenu label={`Actions for ${domain.name}`} actions={actions} /></span>}
      {managing && <ManagersDialog domain={domain} state={state} onState={onState} onClose={() => setManaging(false)} />}
    </li>
  );
}

// AddDomain adds domains by where their DNS is hosted: records added by hand,
// domains synced from Cloudflare, or a registrar whose DNS page is linked.
function AddDomain({ state, onState, onClose }: { state: MailState; onState: (s: MailState) => void; onClose: () => void }) {
  const act = useAct(onState);
  const cloudflare = useCloudflare();
  const [host, setHost] = useState<Host>("");
  const [connecting, setConnecting] = useState<Registrar | null>(null);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const synced = host === "cloudflare";
  const zones = useZones(synced);
  const taken = state.settings.domains.map((d) => d.name);
  const free = (zones ?? []).filter((z) => !taken.includes(z.name.toLowerCase()));
  const domain = cleanDomain(name);
  const ok = synced ? picked.length > 0 : DOMAIN.test(domain) && !taken.includes(domain);

  const add = async () => {
    setBusy(true);
    let done = true;
    if (synced) {
      for (const id of picked) done = (await act(() => api.addMailDomain({ zone_id: id }))) && done;
    } else {
      done = await act(() => api.addMailDomain({ name: domain, host: host || undefined }), `Added ${domain}`);
    }
    if (done) onClose();
    else setBusy(false);
  };

  return (
    <Dialog title="Add domain" onClose={onClose}>
      <div className="stack">
        <div className="tf static">
          <div className="tf-box">
            <Dropdown label="DNS host" value={host} options={HOSTS.map((h) => ({ value: h.value, label: h.label, icon: h.icon, hint: h.hint }))}
              onChange={async (v) => {
                if (v === "cloudflare" && !cloudflare(() => setHost("cloudflare"))) return;
                if (isRegistrar(v)) {
                  const saved = await api.settings().catch(() => null);
                  if (saved && !saved.registrars?.[v]) return setConnecting(v);
                }
                setHost(v);
              }} />
            <span className="tf-label">DNS host</span>
          </div>
        </div>
        {synced ? (
          zones === null ? <div className="muted"><span className="spinner small" /> Loading your Cloudflare domains</div>
          : free.length === 0 ? <Callout icon="cloud">Every domain on this Cloudflare account is already here.</Callout>
          : (
            <div className="tf static">
              <div className="tf-box">
                <MultiDropdown label="Domains" values={picked} allLabel="Pick domains" onChange={setPicked}
                  options={free.map((z) => ({ value: z.id, label: z.name }))} />
                <span className="tf-label">Domains</span>
              </div>
            </div>
          )
        ) : (
          <TextField label="Domain" autoFocus mono autoComplete="off" placeholder="example.com" value={name} onChange={setName}
            hint={taken.includes(domain) ? "Already added" : undefined} />
        )}
        <div className="edit-actions">
          <button type="button" className="btn text" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={!ok || busy} onClick={add}>
            {busy ? <span className="spinner small on-accent" /> : <Icon name="add" size={18} />}Add{synced && picked.length > 1 ? ` ${picked.length}` : ""}
          </button>
        </div>
      </div>
      {connecting && <ConnectRegistrar host={connecting} onClose={() => setConnecting(null)} onDone={() => {
        setHost(connecting);
        setConnecting(null);
      }} />}
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
        <p className="muted">Dashboard accounts with View mail that run this domain's addresses.</p>
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

// ---- one domain ----

const TABS: [string, string, IconName][] = [
  ["services", "Services", "deployed_code"],
  ["dns", "DNS", "dns"],
  ["redirects", "Redirects", "corner_up_right"],
];

function DomainPage({ domain, tab, state, onState, routes, onChanged }: {
  domain: MailDomain; tab: string; state: MailState; onState: (s: MailState) => void; routes: Route[]; onChanged: () => Promise<void>;
}) {
  const [managing, setManaging] = useState(false);
  const [bar, setBar] = useState<HTMLElement | null>(null);
  const primary = state.settings.domains[0]?.name === domain.name;
  const actions = useActions(domain, primary, state, onState, () => setManaging(true));
  // Redirects are answered through the tunnel, so need the domain on Cloudflare.
  const tabs = TABS.filter(([k]) => k !== "redirects" || !!domain.zone_id);
  const current = tabs.some(([k]) => k === tab) ? tab : "services";
  const mine = routes.filter((r) => under(r.hostname, domain.name));
  const addresses = state.accounts.filter((a) => domainOf(a.address) === domain.name).length;
  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>{domain.name}</h1>
          <div className="page-sub">
            <span>{hostOf(domain).label}</span>
            <span><b>{mine.length}</b> {mine.length === 1 ? "service" : "services"}</span>
            <a href="#/mail"><b>{addresses}</b> {addresses === 1 ? "address" : "addresses"}</a>
          </div>
        </div>
        {actions.length > 0 && <div className="page-actions"><MoreMenu label={`Actions for ${domain.name}`} actions={actions} /></div>}
      </div>
      <div className="sub-nav-row">
        <SubNav back="#/domains" backLabel="Domains" base={href(domain.name)} items={tabs} current={current} />
        <div className="sub-nav-actions" ref={setBar} />
      </div>
      <div className="page-body stack">
        {current === "services" && (mine.length ? (
          <div className="card">
            <ForwardRows items={mine.map((r) => ({ r }))} hrefOf={(r) => `#/tunnels/${r.id}`} onChanged={onChanged} />
          </div>
        ) : (
          <div className="welcome">
            <Icon name="deployed_code" size={48} />
            <div className="welcome-actions"><a className="btn primary" href="#/routes/new"><Icon name="add" size={18} />New route</a></div>
          </div>
        ))}
        {current === "dns" && (
          <>
            {state.settings.on && <MailStatus state={state} onState={onState} domain={domain.name} />}
            <Dns domain={domain.name} bar={bar} />
          </>
        )}
        {current === "redirects" && <RedirectList domain={domain.name} bar={bar} />}
      </div>
      {managing && <ManagersDialog domain={domain} state={state} onState={onState} onClose={() => setManaging(false)} />}
    </>
  );
}

// ---- DNS ----

const KINDS = ["A", "AAAA", "CNAME", "MX", "TXT"];
// A record's name within its domain: @ for the domain itself.
const within = (name: string, domain: string) => (name === domain ? "@" : name.endsWith("." + domain) ? name.slice(0, -domain.length - 1) : name);

// Dns is the domain's records, by type: its real zone, to add to, change and
// remove from, with any mail needs that DNS lacks; or, for DNS kept
// elsewhere, what mail needs there. Its buttons sit beside the tabs, in `bar`.
function Dns({ domain, bar }: { domain: string; bar: HTMLElement | null }) {
  const can = useCan();
  const notify = useNotify();
  const [zone, setZone] = useState<DnsZone | null>(null);
  const [problem, setProblem] = useState("");
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<DnsRecord | "new" | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setZone(await api.dns(domain));
      setProblem("");
    } catch (e) {
      setProblem(message(e));
    }
    setLoading(false);
  }, [domain]);
  useEffect(() => {
    load();
  }, [load]);
  const edit = !!zone?.editable && can("mail.manage");
  const addMissing = async (r: DnsRecord) => {
    try {
      setZone(await api.addDns(domain, { kind: r.kind, name: r.name, content: r.content, priority: r.priority }));
      notify(`Added ${r.kind} ${within(r.name, domain)}`);
    } catch (e) {
      notify(message(e), "bad");
    }
  };
  // Records by type, in the order types are usually read: addresses, aliases, mail, text.
  const order = (k: string) => (KINDS.indexOf(k) < 0 ? 99 : KINDS.indexOf(k));
  const kinds = [...new Set((zone?.records ?? []).map((r) => r.kind))].sort((a, b) => order(a) - order(b));
  const buttons = (
    <>
      <button type="button" className="icon-btn" aria-label="Refresh" title="Refresh" disabled={loading} onClick={load}>
        {loading ? <span className="spinner small" /> : <Icon name="refresh" />}
      </button>
      {edit && <button type="button" className="btn primary" onClick={() => setOpen("new")}><Icon name="add" size={18} />Add record</button>}
    </>
  );
  return (
    <>
      {bar && createPortal(buttons, bar)}
      {problem && <Callout tone="bad" icon="error">{problem}</Callout>}
      {zone && (
        <div className="card">
          {zone.records.length === 0 ? <p className="empty-note mail-none">No records.</p> : (
            <ul className="dns-list">
              {kinds.map((k) => [
                <li key={k} className="dns-group">{k}<span>{zone.records.filter((r) => r.kind === k).length}</span></li>,
                ...zone.records.filter((r) => r.kind === k).map((r, i) => (
                  <li key={r.id || `${k}-need-${i}`} className={"dns-row" + (r.missing ? " missing" : "")}>
                    <button type="button" className="dns-main" onClick={() => setOpen(r)}>
                      <span className="dns-name" title={r.name}>{within(r.name, domain)}</span>
                      <span className="dns-value" title={r.content}>{r.priority !== null && <span className="dns-prio">{r.priority}</span>}{r.content}</span>
                    </button>
                    <span className="dns-act">
                      {r.missing && edit ? <button type="button" className="btn small" onClick={() => addMissing(r)}><Icon name="add" size={16} />Add</button>
                        : r.missing ? <span className="dot warn" title="Not in DNS yet" />
                        : !zone.editable ? <span className="dot ok" title="In DNS" />
                        : edit ? <button type="button" className="icon-btn small" aria-label={`Edit ${within(r.name, domain)}`} title="Edit" onClick={() => setOpen(r)}><Icon name="edit" size={18} /></button>
                        : null}
                    </span>
                  </li>
                )),
              ])}
            </ul>
          )}
        </div>
      )}
      {open && <RecordDialog domain={domain} record={open === "new" ? null : open} editable={edit && (open === "new" || !open.missing)}
        onClose={() => setOpen(null)} onSaved={(z) => {
          setZone(z);
          setOpen(null);
        }} />}
    </>
  );
}

// Field is one part of a record: its value as text with a small edit icon,
// and a click anywhere on it turns it into the field to change it.
function Field({ label, value, editing, onEdit, children }: { label: string; value: string; editing: boolean; onEdit?: () => void; children: ReactNode }) {
  if (editing) return <>{children}</>;
  // Where it cannot be changed, the value is there to copy, to add at the DNS host.
  if (!onEdit) {
    return (
      <div className="field-view">
        <span className="field-view-text"><small>{label}</small><Copy text={value || "@"} /></span>
      </div>
    );
  }
  return (
    <button type="button" className="field-view" onClick={onEdit}>
      <span className="field-view-text">
        <small>{label}</small>
        <span className="mono">{value || "@"}</span>
      </span>
      <Icon name="edit" size={18} />
    </button>
  );
}

// RecordDialog shows a record, each part changed by clicking it, and removes
// it; a new record starts as fields.
function RecordDialog({ domain, record, editable, onClose, onSaved }: {
  domain: string; record: DnsRecord | null; editable: boolean; onClose: () => void; onSaved: (z: DnsZone) => void;
}) {
  const notify = useNotify();
  const [kind, setKind] = useState(record && KINDS.includes(record.kind) ? record.kind : "A");
  const [name, setName] = useState(record ? within(record.name, domain) : "");
  const [content, setContent] = useState(record?.content ?? "");
  const [priority, setPriority] = useState(String(record?.priority ?? 10));
  const [editing, setEditing] = useState<string[]>(record ? [] : ["kind", "name", "content", "priority"]);
  const [busy, setBusy] = useState(false);
  const can = editable && (!record || KINDS.includes(record.kind));
  const open = (part: string) => (can ? () => setEditing((e) => [...e, part]) : undefined);
  const run = async (work: () => Promise<DnsZone>, done: string) => {
    setBusy(true);
    try {
      onSaved(await work());
      notify(done);
    } catch (e) {
      notify(message(e), "bad");
      setBusy(false);
    }
  };
  const body = () => ({ kind, name: name.trim() || "@", content: content.trim(), priority: kind === "MX" ? Number(priority) || 10 : null });
  return (
    <Dialog title={record ? `${record.kind} ${within(record.name, domain)}` : "Add record"} onClose={onClose}>
      <form className="record-form" onSubmit={(e) => {
        e.preventDefault();
        run(() => (record ? api.editDns(domain, record.id, body()) : api.addDns(domain, body())), record ? "Record saved" : "Record added");
      }}>
        <Field label="Type" value={kind} editing={editing.includes("kind")} onEdit={open("kind")}>
          <div className="tf static">
            <div className="tf-box">
              <Dropdown label="Type" value={kind} options={KINDS.map((k) => ({ value: k, label: k }))} onChange={setKind} />
              <span className="tf-label">Type</span>
            </div>
          </div>
        </Field>
        <Field label="Name" value={name} editing={editing.includes("name")} onEdit={open("name")}>
          <TextField label="Name" mono autoFocus={!!record} autoComplete="off" value={name} onChange={setName} placeholder="@" trailing={<span className="muted">.{domain}</span>} />
        </Field>
        <Field label="Value" value={content} editing={editing.includes("content")} onEdit={open("content")}>
          <TextField label="Value" mono autoFocus={!!record} autoComplete="off" value={content} onChange={setContent} />
        </Field>
        {kind === "MX" && (
          <Field label="Priority" value={priority} editing={editing.includes("priority")} onEdit={open("priority")}>
            <TextField label="Priority" mono autoFocus={!!record} inputMode="numeric" value={priority} onChange={(v) => setPriority(v.replace(/[^0-9]/g, "").slice(0, 5))} />
          </Field>
        )}
        {can && (
          <div className="edit-actions">
            {record && <span className="edit-actions-start"><ArmedButton icon="delete" label="Remove" armedLabel="Remove for good"
              onConfirm={() => run(() => api.removeDns(domain, record.id), "Record removed")} /></span>}
            {editing.length > 0 && (
              <>
                <button type="button" className="btn text" onClick={onClose}>Cancel</button>
                <button className="btn primary" disabled={busy || !content.trim()}>{busy ? <span className="spinner small on-accent" /> : <Icon name="check" size={18} />}Save</button>
              </>
            )}
          </div>
        )}
      </form>
    </Dialog>
  );
}

// ---- redirects ----

// RedirectList is the domain's redirects, as many as are wanted, each answered
// by the gateway; its button sits beside the tabs.
function RedirectList({ domain, bar }: { domain: string; bar: HTMLElement | null }) {
  const can = useCan()("mail.manage");
  const [list, setList] = useState<Redirect[] | null>(null);
  const [problem, setProblem] = useState("");
  const [open, setOpen] = useState<Redirect | "new" | null>(null);
  useEffect(() => {
    api.redirects(domain).then((r) => setList(r.redirects), (e) => setProblem(message(e)));
  }, [domain]);
  const from = (r: Redirect) => within(r.host, domain) + (r.path || "");
  const add = can && <button type="button" className="btn primary" onClick={() => setOpen("new")}><Icon name="add" size={18} />Add redirect</button>;
  return (
    <>
      {problem && <Callout tone="bad" icon="error">{problem}</Callout>}
      {list && (list.length === 0 ? (
        <div className="welcome">
          <Icon name="corner_up_right" size={48} />
          {add && <div className="welcome-actions">{add}</div>}
        </div>
      ) : (
        <>
          {bar && add && createPortal(add, bar)}
          <div className="card">
            <ul className="dns-list">
              {list.map((r) => (
                <li key={r.id} className="dns-row">
                  <button type="button" className="dns-main" onClick={() => setOpen(r)}>
                    <span className="dns-name" title={r.host + r.path}>{from(r)}</span>
                    <span className="dns-value" title={r.to}><Icon name="arrow_forward" size={14} className="redirect-arrow" />{r.to}</span>
                  </button>
                  <span className="dns-act">
                    {can && <button type="button" className="icon-btn small" aria-label={`Edit ${from(r)}`} title="Edit" onClick={() => setOpen(r)}><Icon name="edit" size={18} /></button>}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </>
      ))}
      {open && <RedirectDialog domain={domain} redirect={open === "new" ? null : open} editable={can}
        onClose={() => setOpen(null)} onSaved={(r) => {
          setList(r.redirects);
          setOpen(null);
        }} />}
    </>
  );
}

// RedirectDialog shows a redirect, each part changed by clicking it, and
// removes it; a new one starts as fields.
function RedirectDialog({ domain, redirect, editable, onClose, onSaved }: {
  domain: string; redirect: Redirect | null; editable: boolean; onClose: () => void; onSaved: (r: Redirects) => void;
}) {
  const notify = useNotify();
  const [host, setHost] = useState(redirect ? within(redirect.host, domain) : "");
  const [path, setPath] = useState(redirect?.path ?? "");
  const [to, setTo] = useState(redirect?.to ?? "");
  const [permanent, setPermanent] = useState(redirect?.permanent ?? true);
  const [keep, setKeep] = useState(redirect?.keep_path ?? false);
  const [editing, setEditing] = useState<string[]>(redirect ? [] : ["host", "path", "to"]);
  const [busy, setBusy] = useState(false);
  const open = (part: string) => (editable ? () => setEditing((e) => [...e, part]) : undefined);
  const changed = editing.length > 0 || permanent !== redirect?.permanent || keep !== redirect?.keep_path;
  const run = async (work: () => Promise<Redirects>, done: string) => {
    setBusy(true);
    try {
      onSaved(await work());
      notify(done);
    } catch (e) {
      notify(message(e), "bad");
      setBusy(false);
    }
  };
  const body = () => ({ host: host.trim() || "@", path: path.trim(), to: to.trim(), permanent, keep_path: keep });
  return (
    <Dialog title={redirect ? within(redirect.host, domain) + redirect.path : "Add redirect"} onClose={onClose}>
      <form className="record-form" onSubmit={(e) => {
        e.preventDefault();
        run(() => (redirect ? api.editRedirect(domain, redirect.id, body()) : api.addRedirect(domain, body())), redirect ? "Redirect saved" : "Redirect added");
      }}>
        <Field label="From" value={host} editing={editing.includes("host")} onEdit={open("host")}>
          <TextField label="From" mono autoFocus autoComplete="off" value={host} onChange={setHost} placeholder="@" trailing={<span className="muted">.{domain}</span>} />
        </Field>
        <Field label="Path" value={path || "Every path"} editing={editing.includes("path")} onEdit={open("path")}>
          <TextField label="Path" mono autoFocus={!!redirect} autoComplete="off" value={path} onChange={setPath} placeholder="Every path" hint="/old for that page, /old/* for it and below" />
        </Field>
        <Field label="To" value={to} editing={editing.includes("to")} onEdit={open("to")}>
          <TextField label="To" mono autoFocus={!!redirect} autoComplete="off" value={to} onChange={setTo} placeholder="https://" />
        </Field>
        <Row title="Permanent"><Switch label="Permanent" on={permanent} disabled={!editable} onChange={setPermanent} /></Row>
        <Row title="Keep the path" sub="The rest of the path and query go along"><Switch label="Keep the path" on={keep} disabled={!editable} onChange={setKeep} /></Row>
        {editable && (
          <div className="edit-actions">
            {redirect && <span className="edit-actions-start"><ArmedButton icon="delete" label="Remove" armedLabel="Remove for good"
              onConfirm={() => run(() => api.removeRedirect(domain, redirect.id), "Redirect removed")} /></span>}
            {changed && (
              <>
                <button type="button" className="btn text" onClick={onClose}>Cancel</button>
                <button className="btn primary" disabled={busy || !to.trim()}>{busy ? <span className="spinner small on-accent" /> : <Icon name="check" size={18} />}Save</button>
              </>
            )}
          </div>
        )}
      </form>
    </Dialog>
  );
}
