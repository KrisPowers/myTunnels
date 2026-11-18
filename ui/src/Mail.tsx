import { useCallback, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { NeedsContext } from "./Apps";
import { useCloudflare, useCloudflareReady } from "./Cloudflare";
import {
  api, bytes, message,
  type MailAccount, type MailApps, type MailDomain, type MailLog, type MailReceive, type MailRecords, type MailSend, type MailState, type Zone,
} from "./api";
import { Dropdown, type Option } from "./Dropdown";
import { Icon, type IconName } from "./Icon";
import { useCan } from "./me";
import { AddMenu, ArmedButton, Avatar, Callout, Card, Copy, Dialog, MoreMenu, Row, Switch, TextField, useNotify, type MenuAction } from "./ui";

// Mail: mailboxes on your own domains, in place of a paid mail service.
// Four tabs, a table each: the mailboxes, the aliases, the Cloudflare
// account's domains with mail switched on or off, and what came in and went
// out. How mail moves sits behind the dial in the heading.

type Tab = "mailboxes" | "aliases" | "domains" | "activity";

const RECEIVE: Option<MailReceive>[] = [
  { value: "port", label: "Port forward", icon: "router", hint: "Port 25 on your router" },
  { value: "cloudflare", label: "Cloudflare", logo: "cloudflare", hint: "Email Routing, through the tunnel" },
];
const APPS: Option<MailApps>[] = [
  { value: "port", label: "Port forward", icon: "router", hint: "IMAP 993 and SMTP 465 on your router" },
  { value: "tailscale", label: "Tailscale", logo: "tailscale", hint: "IMAP 443 and SMTP 8443 through Funnel" },
];
const SEND: Option<MailSend>[] = [
  { value: "direct", label: "Direct", icon: "router", hint: "Straight to each recipient on port 25" },
  { value: "relay", label: "Relay", icon: "swap_horiz", hint: "Through another SMTP server" },
  { value: "cloudflare", label: "Cloudflare", logo: "cloudflare", hint: "Email Sending, Workers Paid plan" },
];
const SECURITY: Option<string>[] = [
  { value: "starttls", label: "STARTTLS", hint: "Usually port 587" },
  { value: "tls", label: "TLS", hint: "Usually port 465" },
  { value: "none", label: "None" },
];
const OUTCOME: Record<string, string> = { delivered: "ok", sent: "ok", junk: "warn", queued: "", rejected: "bad", failed: "bad", bounced: "bad" };

const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();

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

export function MailPage() {
  const can = useCan();
  const ready = useCloudflareReady();
  const cloudflare = useCloudflare();
  const manage = can("mail.manage");
  const [state, setState] = useState<MailState | null>(null);
  const [zones, setZones] = useState<Zone[] | null>(null);
  const [records, setRecords] = useState<MailRecords[]>([]);
  const [problem, setProblem] = useState("");
  const [tab, setTab] = useState<Tab | null>(null);
  const [dialog, setDialog] = useState<"mailbox" | "alias" | "settings" | null>(null);
  const [starting, setStarting] = useState<Zone | null>(null);
  const [password, setPassword] = useState<string | null>(null);
  const act = useAct(setState);

  const running = !!state?.job.running;
  useEffect(() => {
    let alive = true;
    const load = () => api.mail().then((s) => {
      if (!alive) return;
      setState(s);
      setProblem("");
    }, (e) => alive && setProblem(message(e)));
    load();
    const t = setInterval(load, running ? 1500 : 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [running]);
  useEffect(() => {
    if (ready && manage) api.mailZones().then(setZones).catch(() => setZones([]));
  }, [ready, manage]);
  const names = state?.settings.domains.map((d) => d.name).join(",") ?? "";
  useEffect(() => {
    if (names) api.mailRecords().then(setRecords).catch(() => {});
  }, [names, running]);

  if (!state) return problem ? <div className="page-body"><Callout tone="bad" icon="error">{problem}</Callout></div> : null;
  const s = state.settings;
  const runs = state.manages;
  const current: Tab = tab ?? (s.on ? "mailboxes" : "domains");
  const failed = state.job.running ? [] : state.job.steps.filter((x) => !x.ok);
  const percent = state.job.total ? Math.min(100, Math.round((state.job.done / state.job.total) * 100)) : 0;
  const [said, tone] = state.job.running ? [`Setting up · ${percent}%`, "warn"] : failed.length ? ["Needs attention", "bad"] : s.on ? ["Running", "ok"] : ["Off", ""];
  const onMail = new Set(s.domains.map((d) => d.name));
  const rows = [
    ...s.domains.map((d) => ({ name: d.name, domain: d as MailDomain | undefined, zone: zones?.find((z) => z.name.toLowerCase() === d.name) })),
    ...(zones ?? []).filter((z) => !onMail.has(z.name.toLowerCase())).map((z) => ({ name: z.name.toLowerCase(), domain: undefined, zone: z as Zone | undefined })),
  ];
  const turnOn = (z: Zone) => (s.on ? act(() => api.addMailDomain({ zone_id: z.id }), `Mail is on for ${z.name}`) : setStarting(z));
  const newMenu: MenuAction[] = s.on && runs.length > 0 ? [
    { label: "Mailbox", icon: "person", hint: "An address with its own password", onClick: () => setDialog("mailbox") },
    ...(state.accounts.length ? [{ label: "Alias", icon: "call_split" as IconName, hint: "Another address, delivered to a mailbox", onClick: () => setDialog("alias") }] : []),
  ] : [];
  const TABS: [Tab, string, number | null][] = [
    ["mailboxes", "Mailboxes", state.accounts.length],
    ["aliases", "Aliases", state.aliases.length],
    ["domains", "Domains", s.domains.length],
    ["activity", "Activity", null],
  ];

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Mail</h1>
          <div className="page-sub">
            <span className="mail-state"><span className={"dot " + tone} />{said}</span>
            {state.queued > 0 && <span><b>{state.queued}</b> waiting to send</span>}
          </div>
        </div>
        <div className="page-actions">
          {s.on && manage && <button type="button" className="icon-btn" aria-label="Mail settings" title="Mail settings" onClick={() => setDialog("settings")}><Icon name="tune" /></button>}
          {newMenu.length > 0 && <MoreMenu label="New" icon="add" actions={newMenu} />}
        </div>
      </div>

      <div className="page-body stack">
        {state.job.running && <div className="mail-bar" aria-hidden><span style={{ width: `${percent}%` }} /></div>}
        {failed.length > 0 && (
          <Callout tone="bad" icon="error">
            {failed.map((x) => x.name + (x.detail ? `: ${x.detail}` : "")).join(". ")}
            {manage && <> <button type="button" className="link-btn" onClick={() => act(api.rerunMail, "Setting up again")}>Run again</button></>}
          </Callout>
        )}

        <nav className="seg-tabs" aria-label="Mail">
          {TABS.map(([key, label, count]) => (
            <button key={key} type="button" className={current === key ? "on" : undefined} aria-pressed={current === key} onClick={() => setTab(key)}>
              {label}{count !== null && <span className="count">{count}</span>}
            </button>
          ))}
        </nav>

        {current === "mailboxes" && (!s.on ? (
          <Empty icon="mail" action={manage ? <button type="button" className="btn primary" onClick={() => setTab("domains")}>Turn on mail</button> : null} />
        ) : state.accounts.length === 0 ? (
          <Empty icon="person" action={runs.length > 0 ? <button type="button" className="btn primary" onClick={() => setDialog("mailbox")}><Icon name="add" size={18} />New mailbox</button> : null} />
        ) : (
          <Table head={["Mailbox", "Messages", "Storage", "Mail apps", ""]}>
            {state.accounts.map((a) => <MailboxRow key={a.address} account={a} runs={runs.includes(domainOf(a.address))} onState={setState} onPassword={() => setPassword(a.address)} />)}
          </Table>
        ))}

        {current === "aliases" && (state.aliases.length === 0 ? (
          <Empty icon="call_split" action={s.on && runs.length > 0 && state.accounts.length > 0 ? <button type="button" className="btn primary" onClick={() => setDialog("alias")}><Icon name="add" size={18} />New alias</button> : null} />
        ) : (
          <Table head={["Alias", "Delivered to", ""]}>
            {state.aliases.map((x) => <AliasRow key={x.alias} alias={x.alias} target={x.target} runs={runs.includes(domainOf(x.alias))} onState={setState} />)}
          </Table>
        ))}

        {current === "domains" && (!ready ? (
          <Empty icon="cloud" action={<button type="button" className="btn primary" onClick={() => cloudflare()}>Connect Cloudflare</button>} />
        ) : !manage ? (
          <Table head={["Domain", ""]}>
            {s.domains.map((d) => <tr key={d.name}><td><Name icon="public" tone="ok" title={d.name} /></td><td /></tr>)}
          </Table>
        ) : zones === null ? <div className="repo-loading"><span className="spinner" /></div> : (
          <Table head={["Domain", "Mail", "Mailboxes", "DNS", ""]}>
            {rows.map((r) => (
              <DomainRow key={r.name} name={r.name} zone={r.zone} domain={r.domain} primary={s.domains[0]?.name === r.name}
                count={state.accounts.filter((a) => domainOf(a.address) === r.name).length}
                missing={records.find((x) => x.domain === r.name)?.records.filter((x) => !x.found).length ?? null}
                last={s.domains.length === 1} state={state} onState={setState} onTurnOn={turnOn} />
            ))}
          </Table>
        ))}

        {current === "activity" && <Activity />}
      </div>

      {starting && <SetupDialog state={state} zone={starting} onClose={() => setStarting(null)} onDone={(next) => {
        setState(next);
        setStarting(null);
        setTab("mailboxes");
      }} />}
      {dialog === "settings" && <SettingsDialog state={state} onState={setState} onClose={() => setDialog(null)} />}
      {dialog === "mailbox" && <NewMailbox domains={runs} onClose={() => setDialog(null)}
        onSave={(address, name, pass) => act(() => api.addMailAccount({ address, name, password: pass }), `Added ${address}`)} />}
      {dialog === "alias" && <NewAlias domains={runs} accounts={state.accounts.filter((a) => runs.includes(domainOf(a.address))).map((a) => a.address)}
        onClose={() => setDialog(null)} onSave={(from, to) => act(() => api.setMailAlias(from, to), `${from} goes to ${to}`)} />}
      {password && <NewPassword address={password} onClose={() => setPassword(null)}
        onSave={(address, pass) => act(() => api.editMailAccount(address, { password: pass }), "Password changed")} />}
    </>
  );
}

// ---- the parts every tab is made of ----

function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="card svc-card">
      <div className="table-wrap">
        <table className="table svc">
          <thead><tr>{head.map((h, i) => <th key={i} className={i === 0 ? "grow" : h === "Messages" || h === "Storage" || h === "Mailboxes" ? "svc-num" : undefined}>{h}</th>)}</tr></thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </div>
  );
}

function Name({ icon, tone, title, sub, avatar }: { icon?: IconName; tone?: string; title: string; sub?: string; avatar?: string }) {
  return (
    <span className="svc-name">
      {avatar !== undefined ? <Avatar name={avatar} /> : <span className={"svc-icon " + (tone ?? "")}><Icon name={icon ?? "mail"} size={18} /></span>}
      <span className="svc-text"><b>{title}</b>{sub && <small className="plain">{sub}</small>}</span>
    </span>
  );
}

function Empty({ icon, action }: { icon: IconName; action: ReactNode }) {
  return (
    <div className="welcome">
      <Icon name={icon} size={48} />
      {action && <div className="welcome-actions">{action}</div>}
    </div>
  );
}

// ---- rows ----

function MailboxRow({ account: a, runs, onState, onPassword }: { account: MailAccount; runs: boolean; onState: (s: MailState) => void; onPassword: () => void }) {
  const act = useAct(onState);
  const menu: MenuAction[] = [
    { label: "Change password", icon: "password", onClick: onPassword },
    a.apps
      ? { label: "Turn mail apps off", icon: "block", hint: "IMAP and SMTP refuse it; mail still arrives", onClick: () => act(() => api.editMailAccount(a.address, { apps: false }), "Mail apps are off for it") }
      : { label: "Turn mail apps on", icon: "check_circle", hint: "It can sign in to IMAP and SMTP again", onClick: () => act(() => api.editMailAccount(a.address, { apps: true }), "Mail apps are on for it") },
    { label: "Remove", icon: "delete", danger: true, confirm: "Remove with its mail", onClick: () => act(() => api.removeMailAccount(a.address), `Removed ${a.address}`) },
  ];
  return (
    <tr>
      <td><Name avatar={a.name || a.address} title={a.address} sub={a.name || undefined} /></td>
      <td className="svc-num">{a.messages.toLocaleString()}</td>
      <td className="svc-num">{bytes(a.size)}</td>
      <td><span className={"chip " + (a.apps ? "ok" : "")}><span className={"dot " + (a.apps ? "ok" : "")} />{a.apps ? "On" : "Off"}</span></td>
      <td className="svc-menu">{runs && <MoreMenu label={`Actions for ${a.address}`} actions={menu} />}</td>
    </tr>
  );
}

function AliasRow({ alias, target, runs, onState }: { alias: string; target: string; runs: boolean; onState: (s: MailState) => void }) {
  const act = useAct(onState);
  return (
    <tr>
      <td><Name icon="call_split" title={alias.startsWith("@") ? `Everything at ${alias.slice(1)}` : alias} /></td>
      <td><span className="svc-address"><span className="mono">{target}</span></span></td>
      <td className="svc-menu">{runs && <MoreMenu label={`Actions for ${alias}`} actions={[{ label: "Remove", icon: "delete", danger: true, onClick: () => act(() => api.removeMailAlias(alias), `Removed ${alias}`) }]} />}</td>
    </tr>
  );
}

function DomainRow({ name, zone, domain, primary, count, missing, last, state, onState, onTurnOn }: {
  name: string; zone?: Zone; domain?: MailDomain; primary: boolean; count: number; missing: number | null; last: boolean;
  state: MailState; onState: (s: MailState) => void; onTurnOn: (z: Zone) => void;
}) {
  const act = useAct(onState);
  const [managing, setManaging] = useState(false);
  const on = !!domain;
  const dns: [string, string] = !on ? ["", ""] : missing === null ? ["Checking", ""] : missing ? [`${missing} missing`, "warn"] : ["Ready", "ok"];
  const menu: MenuAction[] = domain ? [
    ...(!primary ? [{ label: "Make primary", icon: "star" as IconName, hint: "The mail server is named after it", onClick: () => act(() => api.editMailDomain(domain.name, { primary: true }), `${domain.name} is the primary domain`) }] : []),
    { label: "Managers", icon: "group", onClick: () => setManaging(true) },
  ] : [];
  return (
    <tr className={on ? undefined : "svc-down"}>
      <td><Name icon="public" tone={on ? "ok" : ""} title={name} sub={primary ? "Primary" : undefined} /></td>
      <td>
        <Switch label={`Mail on ${name}`} on={on} disabled={(on && primary && !last) || (!on && !zone)}
          onChange={(v) => (v ? zone && onTurnOn(zone) : domain && act(() => api.removeMailDomain(domain.name), `Mail is off for ${domain.name}`))} />
      </td>
      <td className="svc-num">{on ? count : ""}</td>
      <td>{dns[0] && <span className={"chip " + dns[1]}><span className={"dot " + dns[1]} />{dns[0]}</span>}</td>
      <td className="svc-menu">
        {menu.length > 0 && <MoreMenu label={`Actions for ${name}`} actions={menu} />}
        {managing && domain && <ManagersDialog domain={domain} state={state} onState={onState} onClose={() => setManaging(false)} />}
      </td>
    </tr>
  );
}

// ---- activity ----

function Activity() {
  const [log, setLog] = useState<MailLog[] | null>(null);
  useEffect(() => {
    const load = () => api.mailLog().then(setLog).catch(() => setLog([]));
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);
  if (!log) return <div className="repo-loading"><span className="spinner" /></div>;
  if (log.length === 0) return <Empty icon="history" action={null} />;
  return (
    <Table head={["Message", "Outcome", "When"]}>
      {log.map((e, i) => (
        <tr key={i}>
          <td>
            <Name icon={e.dir === "in" ? "download" : "upload"} title={e.dir === "in" ? e.to : e.from || "<>"} sub={e.dir === "in" ? `from ${e.from || "<>"}` : `to ${e.to}`} />
          </td>
          <td title={e.detail || undefined}><span className={"chip " + (OUTCOME[e.status] ?? "")}><span className={"dot " + (OUTCOME[e.status] ?? "")} />{e.status}</span></td>
          <td className="svc-num">{new Date(e.at * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
        </tr>
      ))}
    </Table>
  );
}

// ---- dialogs ----

function ManagersDialog({ domain, state, onState, onClose }: { domain: MailDomain; state: MailState; onState: (s: MailState) => void; onClose: () => void }) {
  const act = useAct(onState);
  const nameOf = (id: string) => state.people.find((p) => p.id === id)?.name ?? "Someone";
  const set = (ids: string[], done: string) => act(() => api.editMailDomain(domain.name, { managers: ids }), done);
  return (
    <Dialog title={`Managers of ${domain.name}`} onClose={onClose}>
      <div className="stack">
        <p className="muted">Accounts that run this domain's mailboxes without setting mail up.</p>
        <span className="access">
          {domain.managers.map((id) => (
            <span key={id} className="chip plain">
              {nameOf(id)}
              <button type="button" className="chip-x" aria-label={`Remove ${nameOf(id)}`} title="Remove"
                onClick={() => set(domain.managers.filter((m) => m !== id), `${nameOf(id)} no longer manages ${domain.name}`)}>
                <Icon name="close" size={14} />
              </button>
            </span>
          ))}
          <AddMenu label="Add a manager" placeholder="Find an account" empty={<div className="menu-note">No other accounts yet</div>}
            items={state.people.map((p) => ({ id: p.id, label: p.name, avatar: p.name, disabled: domain.managers.includes(p.id), note: "Already manages it" }))}
            onPick={(id) => set([...domain.managers, id], `${nameOf(id)} manages ${domain.name}`)} />
        </span>
      </div>
    </Dialog>
  );
}

// How mail arrives, how mail apps reach it and how it leaves, a dropdown
// each, with the relay's server when mail leaves through one.
function useWays(state: MailState) {
  const s = state.settings;
  const needs = useContext(NeedsContext);
  const [receive, setReceive] = useState<MailReceive>(s.receive);
  const [apps, setApps] = useState<MailApps>(s.apps);
  const [send, setSend] = useState<MailSend>(s.send);
  const [host, setHost] = useState(s.relay?.host ?? "");
  const [port, setPort] = useState(String(s.relay?.port ?? 587));
  const [security, setSecurity] = useState(s.relay?.security ?? "starttls");
  const [username, setUsername] = useState(s.relay?.username ?? "");
  const [password, setPassword] = useState("");
  const ok = send !== "relay" || (!!host.trim() && Number(port) > 0 && (!!password || !!s.relay?.password_set || !username.trim()));
  const appWays = APPS.map((o) => (o.value === "tailscale" && needs && !needs.tailscale ? { ...o, disabled: true, hint: "Install Tailscale from Apps first" } : o));
  const fields = (
    <>
      <Row title="Mail arrives"><Dropdown label="Mail arrives" value={receive} options={RECEIVE} onChange={setReceive} /></Row>
      <Row title="Mail apps connect"><Dropdown label="Mail apps connect" value={apps} options={appWays} onChange={setApps} /></Row>
      <Row title="Mail leaves"><Dropdown label="Mail leaves" value={send} options={SEND} onChange={setSend} /></Row>
      {send === "relay" && (
        <div className="wizard-fields card-pad">
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
  );
  const body = (zone_id: string | null) => ({
    zone_id, domain: null, receive, apps, send,
    relay: send === "relay" ? { host: host.trim(), port: Number(port), security, username: username.trim(), password: password || null } : null,
  });
  return { fields, ok, body };
}

function SetupDialog({ state, zone, onClose, onDone }: { state: MailState; zone: Zone; onClose: () => void; onDone: (s: MailState) => void }) {
  const notify = useNotify();
  const ways = useWays(state);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      onDone(await api.setupMail(ways.body(zone.id)));
    } catch (e) {
      notify(message(e), "bad");
      setBusy(false);
    }
  };
  return (
    <Dialog title={`Mail on ${zone.name}`} wide onClose={onClose}>
      <Card title="How mail moves">{ways.fields}</Card>
      <div className="edit-actions">
        <button type="button" className="btn text" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={!ways.ok || busy} onClick={submit}>
          {busy && <span className="spinner small on-accent" />}Turn on mail
        </button>
      </div>
    </Dialog>
  );
}

function SettingsDialog({ state, onState, onClose }: { state: MailState; onState: (s: MailState) => void; onClose: () => void }) {
  const act = useAct(onState);
  const ways = useWays(state);
  const s = state.settings;
  return (
    <Dialog title="Mail settings" wide onClose={onClose}>
      <div className="stack">
        <Card title="How mail moves" action={<button type="button" className="btn" disabled={!ways.ok || state.job.running} onClick={() => act(() => api.setupMail(ways.body(null)), "Applying")}>Apply</button>}>
          {ways.fields}
        </Card>
        <Card title="Mail apps sign in" sub="With the full address and its password">
          {state.servers ? (
            <>
              <Row title="IMAP"><Copy text={`${state.servers.imap_host}:${state.servers.imap_port}`} /></Row>
              <Row title="SMTP"><Copy text={`${state.servers.smtp_host}:${state.servers.smtp_port}`} /></Row>
            </>
          ) : <Row title="Waiting for Tailscale" />}
        </Card>
        <Card title="Incoming mail">
          <Row title="Refuse spoofed mail" sub="Turn away what its sender's DMARC rejects, rather than file it in Junk">
            <Switch label="Refuse spoofed mail" on={s.reject_dmarc} onChange={(v) => act(() => api.mailOptions({ reject_dmarc: v }))} />
          </Row>
          <Row title="Keep sent mail" sub="A copy in Sent of what mail apps send">
            <Switch label="Keep sent mail" on={s.save_sent} onChange={(v) => act(() => api.mailOptions({ save_sent: v }))} />
          </Row>
        </Card>
        <Card title="Server">
          <Row title="Set up again" sub="Opens the ports and writes the records once more">
            <button type="button" className="btn" disabled={state.job.running} onClick={() => act(api.rerunMail, "Setting up again")}><Icon name="refresh" size={18} />Run</button>
          </Row>
          <Row title="Turn off" sub="Mailboxes and mail are kept">
            <ArmedButton icon="block" label="Turn off" armedLabel="Close its ports" onConfirm={async () => {
              if (await act(api.mailOff, "Mail is off")) onClose();
            }} />
          </Row>
        </Card>
      </div>
    </Dialog>
  );
}

// The part before the @ typed, the domain picked beside it.
function Address({ domains, local, domain, onLocal, onDomain, hint }: {
  domains: string[]; local: string; domain: string; onLocal: (v: string) => void; onDomain: (v: string) => void; hint?: string;
}) {
  return (
    <div className="nr-address">
      <TextField className="nr-sub" label="Address" autoFocus autoComplete="off" value={local} onChange={(v) => onLocal(v.replace(/@.*$/, ""))} hint={hint} />
      <div className="tf static nr-zone">
        <div className="tf-box">
          <Dropdown label="Domain" value={domain} options={domains.map((d) => ({ value: d, label: "@" + d }))} onChange={onDomain} />
          <span className="tf-label">Domain</span>
        </div>
      </div>
    </div>
  );
}

function NewMailbox({ domains, onClose, onSave }: { domains: string[]; onClose: () => void; onSave: (address: string, name: string, password: string) => Promise<boolean> }) {
  const [domain, setDomain] = useState(domains[0] ?? "");
  const [local, setLocal] = useState("");
  const [name, setName] = useState("");
  const [pass, setPass] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await onSave(`${local.trim()}@${domain}`, name.trim(), pass)) onClose();
  };
  return (
    <Dialog title="New mailbox" onClose={onClose}>
      <form onSubmit={submit}>
        <Address domains={domains} local={local} domain={domain} onLocal={setLocal} onDomain={setDomain} />
        <TextField label="Name" autoComplete="off" value={name} onChange={setName} hint="Shown as who mail is from" />
        <TextField label="Password" type="password" autoComplete="new-password" data-1p-ignore value={pass} onChange={setPass} />
        <div className="edit-actions">
          <button type="button" className="btn text" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!local.trim() || !domain || !pass}>Add mailbox</button>
        </div>
      </form>
    </Dialog>
  );
}

function NewAlias({ domains, accounts, onClose, onSave }: { domains: string[]; accounts: string[]; onClose: () => void; onSave: (alias: string, target: string) => Promise<boolean> }) {
  const [domain, setDomain] = useState(domains[0] ?? "");
  const [local, setLocal] = useState("");
  const [target, setTarget] = useState(accounts[0] ?? "");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await onSave(`${local.trim()}@${domain}`, target)) onClose();
  };
  return (
    <Dialog title="New alias" onClose={onClose}>
      <form onSubmit={submit}>
        <Address domains={domains} local={local} domain={domain} onLocal={setLocal} onDomain={setDomain}
          hint={local.trim() ? undefined : "Empty for everything at the domain"} />
        <div className="tf static">
          <div className="tf-box">
            <Dropdown label="Delivered to" value={target} onChange={setTarget} options={accounts.map((a) => ({ value: a, label: a }))} />
            <span className="tf-label">Delivered to</span>
          </div>
        </div>
        <div className="edit-actions">
          <button type="button" className="btn text" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!target || !domain}>Add alias</button>
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
