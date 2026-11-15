import { useCallback, useEffect, useState } from "react";
import { useCloudflare } from "./Cloudflare";
import { api, bytes, message, type MailAccount, type MailDomain, type MailRecords, type MailState } from "./api";
import { Dropdown, MultiDropdown } from "./Dropdown";
import { Icon, type IconName } from "./Icon";
import { cleanDomain, DOMAIN, domainOf, plural, useAct, useZones } from "./Mail";
import { useCan } from "./me";
import { go } from "./route";
import { AddMenu, Callout, Card, Copy, Dialog, MoreMenu, SubNav, TextField, type MenuAction } from "./ui";

// Where a domain's DNS is hosted: records added by hand anywhere, synced with
// Cloudflare, or added by hand at a registrar whose DNS page is linked.
type Host = "" | "cloudflare" | "squarespace" | "godaddy" | "namecheap" | "porkbun";
interface HostWay { value: Host; label: string; icon: IconName; hint: string; link?: (domain: string) => string }

const HOSTS: HostWay[] = [
  { value: "", label: "DNS records", icon: "dns", hint: "Added wherever its DNS is" },
  { value: "cloudflare", label: "Cloudflare", icon: "cloud", hint: "Synced for you" },
  { value: "squarespace", label: "Squarespace", icon: "public", hint: "Added in Squarespace",
    link: (d) => `https://account.squarespace.com/domains/managed/${d}/dns/dns-settings` },
  { value: "godaddy", label: "GoDaddy", icon: "public", hint: "Added in GoDaddy", link: () => "https://dcc.godaddy.com/control/portfolio" },
  { value: "namecheap", label: "Namecheap", icon: "public", hint: "Added in Namecheap",
    link: (d) => `https://ap.www.namecheap.com/Domains/DomainControlPanel/${d}/advancedns` },
  { value: "porkbun", label: "Porkbun", icon: "public", hint: "Added in Porkbun", link: () => "https://porkbun.com/account/domainsSpeedy" },
];

const hostOf = (d: MailDomain): HostWay => HOSTS.find((h) => h.value === (d.zone_id ? "cloudflare" : d.host || "")) ?? HOSTS[0];
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
  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);
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
  const { state, setState, problem, records, checking, check } = useDomains();
  const [adding, setAdding] = useState(false);
  const domain = id ? state?.settings.domains.find((d) => d.name === id.toLowerCase()) : undefined;
  useEffect(() => {
    if (id && state && !domain) go("#/domains");
  }, [id, state, domain]);

  if (!state) return problem ? <div className="page-body"><Callout tone="bad" icon="error">{problem}</Callout></div> : null;
  if (domain) {
    return <DomainPage domain={domain} tab={tab} state={state} onState={setState}
      list={records?.find((r) => r.domain === domain.name)} checking={checking} onCheck={check} />;
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
          <b>{domain.name}{primary && <span className="chip">Primary</span>}</b>
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
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const synced = host === "cloudflare";
  const zones = useZones(synced);
  const taken = state.settings.domains.map((d) => d.name);
  const free = (zones ?? []).filter((z) => !taken.includes(z.name.toLowerCase()));
  const domain = cleanDomain(name);
  // Mail through Cloudflare needs every domain synced there.
  const cfWays = state.settings.receive === "cloudflare" || state.settings.send === "cloudflare";
  const blocked = cfWays && !synced;
  const ok = !blocked && (synced ? picked.length > 0 : DOMAIN.test(domain) && !taken.includes(domain));

  const add = async () => {
    setBusy(true);
    let done = true;
    if (synced) {
      for (const id of picked) done = (await act(() => api.addMailDomain({ zone_id: id }))) && done;
    } else {
      done = await act(() => api.addMailDomain({ name: domain, host }), `Added ${domain}`);
    }
    if (done) onClose();
    else setBusy(false);
  };

  return (
    <Dialog title="Add domain" wide onClose={onClose}>
      <div className="stack">
        <div className="ways hosts" role="radiogroup" aria-label="Where its DNS is">
          {HOSTS.map((h) => (
            <button key={h.value} type="button" role="radio" aria-checked={host === h.value}
              className={"way" + (host === h.value ? " on" : "")}
              onClick={() => {
                if (h.value === "cloudflare" && !cloudflare(() => setHost("cloudflare"))) return;
                setHost(h.value);
              }}>
              <span className="way-head"><Icon name={h.icon} size={22} /><b>{h.label}</b></span>
              <span className="way-hint">{h.hint}</span>
            </button>
          ))}
        </div>
        {blocked && <Callout tone="warn" icon="cloud">Mail moves through Cloudflare, so domains need to sync with it.</Callout>}
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
  ["addresses", "Addresses", "mail"],
  ["dns", "DNS", "dns"],
];

function DomainPage({ domain, tab, state, onState, list, checking, onCheck }: {
  domain: MailDomain; tab: string; state: MailState; onState: (s: MailState) => void;
  list: MailRecords | undefined; checking: boolean; onCheck: () => void;
}) {
  const [managing, setManaging] = useState(false);
  const primary = state.settings.domains[0]?.name === domain.name;
  const actions = useActions(domain, primary, state, onState, () => setManaging(true));
  const current = TABS.some(([k]) => k === tab) ? tab : "addresses";
  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>{domain.name}</h1>
          <div className="page-sub">
            <span>{hostOf(domain).label}</span>
            {primary && <span>Primary</span>}
          </div>
        </div>
        {actions.length > 0 && <div className="page-actions"><MoreMenu label={`Actions for ${domain.name}`} actions={actions} /></div>}
      </div>
      <SubNav back="#/domains" backLabel="Domains" base={href(domain.name)} items={TABS} current={current} />
      <div className="page-body stack">
        {current === "addresses" && <Addresses domain={domain.name} state={state} onState={onState} />}
        {current === "dns" && <Dns domain={domain} list={list} checking={checking} onCheck={onCheck} />}
      </div>
      {managing && <ManagersDialog domain={domain} state={state} onState={onState} onClose={() => setManaging(false)} />}
    </>
  );
}

function Dns({ domain, list, checking, onCheck }: { domain: MailDomain; list: MailRecords | undefined; checking: boolean; onCheck: () => void }) {
  const host = hostOf(domain);
  return (
    <Card title="Records" sub={domain.zone_id ? "Kept in sync on Cloudflare" : `Add these ${host.link ? `in ${host.label}` : "where the domain's DNS is"}; each turns green once DNS answers with it`}
      action={
        <span className="mail-bar-row">
          {host.link && <a className="btn" href={host.link(domain.name)} target="_blank" rel="noreferrer"><Icon name="open_in_new" size={18} />{host.label}</a>}
          <button type="button" className="btn" disabled={checking} onClick={onCheck}>
            {checking ? <span className="spinner small" /> : <Icon name="refresh" size={18} />}Check
          </button>
        </span>
      }>
      {list ? <RecordsTable list={list} /> : <p className="empty-note mail-none"><span className="spinner small" /> Checking DNS</p>}
    </Card>
  );
}

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
