import { useCallback, useEffect, useState } from "react";
import { useCloudflare } from "./Cloudflare";
import { api, bytes, message, type DnsRecord, type DnsZone, type MailAccount, type MailDomain, type MailRecords, type MailState, type Registrar } from "./api";
import { Dropdown, MultiDropdown } from "./Dropdown";
import { Icon, type IconName } from "./Icon";
import { cleanDomain, DOMAIN, domainOf, MailActivity, MailSettings, MailStatus, plural, useAct, useZones } from "./Mail";
import { useCan } from "./me";
import { go } from "./route";
import { ConnectRegistrar } from "./Registrars";
import { AddMenu, ArmedButton, Callout, Copy, Dialog, MoreMenu, SubNav, TextField, useNotify, type MenuAction } from "./ui";

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

export function DomainsPage({ id, tab }: { id: string; tab: string }) {
  const can = useCan();
  const { state, setState, problem, records } = useDomains();
  const [adding, setAdding] = useState(false);
  const domain = id ? state?.settings.domains.find((d) => d.name === id.toLowerCase()) : undefined;
  useEffect(() => {
    if (id && state && !domain) go("#/domains");
  }, [id, state, domain]);

  if (!state) return problem ? <div className="page-body"><Callout tone="bad" icon="error">{problem}</Callout></div> : null;
  if (domain) {
    return <DomainPage domain={domain} tab={tab} state={state} onState={setState} />;
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
                <DomainRow key={d.name} domain={d} primary={i === 0} list={records?.find((r) => r.domain === d.name)} state={state} onState={setState} />
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

function DomainRow({ domain, primary, list, state, onState }: {
  domain: MailDomain; primary: boolean; list: MailRecords | undefined; state: MailState; onState: (s: MailState) => void;
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
          <small>{[hostOf(domain).label, missing === null ? "Checking DNS" : missing ? `${plural(missing, "record")} to add` : "DNS ready", plural(addresses, "address", "addresses")].join(" · ")}</small>
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
  ["dns", "DNS", "dns"],
  ["mail", "Mail", "mail"],
  ["activity", "Activity", "history"],
  ["settings", "Settings", "settings"],
];

function DomainPage({ domain, tab, state, onState }: { domain: MailDomain; tab: string; state: MailState; onState: (s: MailState) => void }) {
  const [managing, setManaging] = useState(false);
  const primary = state.settings.domains[0]?.name === domain.name;
  const actions = useActions(domain, primary, state, onState, () => setManaging(true));
  const current = TABS.some(([k]) => k === tab) ? tab : "dns";
  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>{domain.name}</h1>
          <div className="page-sub"><span>{hostOf(domain).label}</span></div>
        </div>
        {actions.length > 0 && <div className="page-actions"><MoreMenu label={`Actions for ${domain.name}`} actions={actions} /></div>}
      </div>
      <SubNav back="#/domains" backLabel="Domains" base={href(domain.name)} items={TABS} current={current} />
      <div className="page-body stack">
        {current === "dns" && <Dns domain={domain.name} />}
        {current === "mail" && <Addresses domain={domain.name} state={state} onState={onState} />}
        {current === "activity" && <MailActivity domain={domain.name} />}
        {current === "settings" && (
          <>
            <MailStatus state={state} onState={onState} domain={domain.name} />
            <MailSettings state={state} onState={onState} />
          </>
        )}
      </div>
      {managing && <ManagersDialog domain={domain} state={state} onState={onState} onClose={() => setManaging(false)} />}
    </>
  );
}

// ---- DNS ----

const KINDS = ["A", "AAAA", "CNAME", "MX", "TXT"];
// A record's name within its domain: @ for the domain itself.
const within = (name: string, domain: string) => (name === domain ? "@" : name.endsWith("." + domain) ? name.slice(0, -domain.length - 1) : name);

// Dns is the domain's records: its real zone, to add to, change and remove
// from, with any mail needs that DNS lacks; or, for DNS kept elsewhere, what
// mail needs there.
function Dns({ domain }: { domain: string }) {
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
  return (
    <>
      <div className="mail-bar-row">
        <button type="button" className="icon-btn" aria-label="Refresh" title="Refresh" disabled={loading} onClick={load}>
          {loading ? <span className="spinner small" /> : <Icon name="refresh" />}
        </button>
        {edit && <button type="button" className="btn primary" onClick={() => setOpen("new")}><Icon name="add" size={18} />Add record</button>}
      </div>
      {problem && <Callout tone="bad" icon="error">{problem}</Callout>}
      {zone && (
        <div className="card">
          {zone.records.length === 0 ? <p className="empty-note mail-none">No records.</p> : (
            <div className="table-wrap">
              <table className="table dns-table">
                <thead>
                  <tr><th>Type</th><th>Name</th><th className="grow">Value</th><th /></tr>
                </thead>
                <tbody>
                  {zone.records.map((r, i) => (
                    <tr key={r.id || `need-${i}`} className={r.missing ? "missing" : undefined} onClick={() => setOpen(r)}>
                      <td><span className="chip mono">{r.kind}</span></td>
                      <td className="mono dns-name" title={r.name}>{within(r.name, domain)}</td>
                      <td className="mono dns-value" title={r.content}>{r.priority !== null && <span className="muted">{r.priority} </span>}{r.content}</td>
                      <td className="dns-act" onClick={(e) => e.stopPropagation()}>
                        {r.missing && edit ? <button type="button" className="btn small" onClick={() => addMissing(r)}><Icon name="add" size={16} />Add</button>
                          : r.missing ? <span className="dot warn" title="Not in DNS yet" />
                          : !zone.editable ? <span className="dot ok" title="In DNS" /> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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

// RecordDialog shows a record in full, and changes or removes it where the zone is editable.
function RecordDialog({ domain, record, editable, onClose, onSaved }: {
  domain: string; record: DnsRecord | null; editable: boolean; onClose: () => void; onSaved: (z: DnsZone) => void;
}) {
  const notify = useNotify();
  const [kind, setKind] = useState(record && KINDS.includes(record.kind) ? record.kind : "A");
  const [name, setName] = useState(record ? within(record.name, domain) : "");
  const [content, setContent] = useState(record?.content ?? "");
  const [priority, setPriority] = useState(String(record?.priority ?? 10));
  const [busy, setBusy] = useState(false);
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
  if (record && (!editable || !KINDS.includes(record.kind))) {
    return (
      <Dialog title={`${record.kind} ${within(record.name, domain)}`} onClose={onClose}>
        <div className="stack dns-full">
          <Copy text={record.content} />
          {record.priority !== null && <span className="muted">Priority {record.priority}</span>}
        </div>
      </Dialog>
    );
  }
  return (
    <Dialog title={record ? "Edit record" : "Add record"} onClose={onClose}>
      <form onSubmit={(e) => {
        e.preventDefault();
        run(() => (record ? api.editDns(domain, record.id, body()) : api.addDns(domain, body())), record ? "Record saved" : "Record added");
      }}>
        <div className="tf static">
          <div className="tf-box">
            <Dropdown label="Type" value={kind} options={KINDS.map((k) => ({ value: k, label: k }))} onChange={setKind} />
            <span className="tf-label">Type</span>
          </div>
        </div>
        <TextField label="Name" mono autoComplete="off" value={name} onChange={setName} placeholder="@" trailing={<span className="muted">.{domain}</span>} />
        <TextField label="Value" mono autoComplete="off" value={content} onChange={setContent} />
        {kind === "MX" && <TextField label="Priority" mono inputMode="numeric" value={priority} onChange={(v) => setPriority(v.replace(/[^0-9]/g, "").slice(0, 5))} />}
        <div className="edit-actions">
          {record && <span className="edit-actions-start"><ArmedButton icon="delete" label="Remove" armedLabel="Remove for good"
            onConfirm={() => run(() => api.removeDns(domain, record.id), "Record removed")} /></span>}
          <button type="button" className="btn text" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !content.trim()}>{busy ? <span className="spinner small on-accent" /> : <Icon name="check" size={18} />}Save</button>
        </div>
      </form>
    </Dialog>
  );
}

// ---- addresses ----

function Addresses({ domain, state, onState }: { domain: string; state: MailState; onState: (s: MailState) => void }) {
  const act = useAct(onState);
  const [adding, setAdding] = useState(false);
  const [alias, setAlias] = useState(false);
  const [password, setPassword] = useState<string | null>(null);
  const runs = state.manages.includes(domain);
  const accounts = state.accounts.filter((a) => domainOf(a.address) === domain);
  const aliases = state.aliases.filter((x) => domainOf(x.alias) === domain);
  const targets = state.accounts.filter((a) => state.manages.includes(domainOf(a.address))).map((a) => a.address);
  return (
    <>
      {runs && (
        <div className="mail-bar-row">
          {targets.length > 0 && <button type="button" className="btn" onClick={() => setAlias(true)}><Icon name="call_split" size={18} />New alias</button>}
          <button type="button" className="btn primary" onClick={() => setAdding(true)}><Icon name="add" size={18} />New address</button>
        </div>
      )}
      <div className="card">
        {accounts.length === 0 && aliases.length === 0 ? <p className="empty-note mail-none">No addresses yet.</p> : (
          <ul className="results ct-list">
            {accounts.map((a) => <AccountRow key={a.address} account={a} runs={runs} onState={onState} onPassword={() => setPassword(a.address)} />)}
            {aliases.map((x) => <AliasRow key={x.alias} alias={x.alias} target={x.target} runs={runs} onState={onState} />)}
          </ul>
        )}
      </div>
      {adding && <NewAddress domain={domain} onClose={() => setAdding(false)}
        onSave={(address, name, pass) => act(() => api.addMailAccount({ address, name, password: pass }), `Added ${address}`)} />}
      {alias && <NewAlias accounts={targets} domain={domain} onClose={() => setAlias(false)}
        onSave={(from, to) => act(() => api.setMailAlias(from, to), `${from} goes to ${to}`)} />}
      {password && <NewPassword address={password} onClose={() => setPassword(null)}
        onSave={(address, pass) => act(() => api.editMailAccount(address, { password: pass }), "Password changed")} />}
    </>
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

function NewAddress({ domain, onClose, onSave }: { domain: string; onClose: () => void; onSave: (address: string, name: string, password: string) => Promise<boolean> }) {
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

function NewAlias({ accounts, domain, onClose, onSave }: { accounts: string[]; domain: string; onClose: () => void; onSave: (alias: string, target: string) => Promise<boolean> }) {
  const [local, setLocal] = useState("");
  const [target, setTarget] = useState(accounts.find((a) => domainOf(a) === domain) ?? accounts[0] ?? "");
  const full = `${local.trim().replace(/@.*$/, "")}@${domain}`;
  return (
    <Dialog title="New alias" onClose={onClose}>
      <form onSubmit={async (e) => {
        e.preventDefault();
        if (await onSave(full, target)) onClose();
      }}>
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
