import { useCallback, useContext, useEffect, useState, type FormEvent } from "react";
import { NeedsContext } from "./Apps";
import { useCloudflare, useCloudflareReady } from "./Cloudflare";
import {
  api, bytes, message,
  type MailAccount, type MailApps, type MailLog, type MailReceive, type MailSend, type MailState, type Zone,
} from "./api";
import { Dropdown, type Option } from "./Dropdown";
import { Icon } from "./Icon";
import { useCan } from "./me";
import { ArmedButton, Avatar, Callout, Card, Copy, Dialog, MoreMenu, Row, Switch, TextField, useNotify, type MenuAction } from "./ui";

// Mail is your addresses, all of them in one list: mailboxes, which have a
// password and keep mail here, and aliases, other addresses for a mailbox. A new address is typed in full, on any domain the Cloudflare
// account holds; mail turns itself on for that domain. How mail moves, and
// what came in and went out, open from the heading.

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

// One row: a mailbox, or an alias.
type Entry = { address: string; mailbox?: MailAccount; to?: string };

export function MailPage() {
  const can = useCan();
  const manage = can("mail.manage");
  const ready = useCloudflareReady();
  const cloudflare = useCloudflare();
  const [state, setState] = useState<MailState | null>(null);
  const [zones, setZones] = useState<Zone[]>([]);
  const [problem, setProblem] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<"new" | "settings" | "activity" | null>(null);
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
    if (ready && manage) api.mailZones().then(setZones).catch(() => {});
  }, [ready, manage]);

  if (!state) return problem ? <div className="page-body"><Callout tone="bad" icon="error">{problem}</Callout></div> : null;
  const s = state.settings;
  // Domains an address can go on: every Cloudflare domain for mail's
  // admins; for a domain's managers, the domains they run.
  const domains = manage ? zones.map((z) => z.name.toLowerCase()) : state.manages;
  const runs = (address: string) => manage || state.manages.includes(domainOf(address));

  const entries: Entry[] = [
    ...state.accounts.map((a) => ({ address: a.address, mailbox: a })),
    ...state.aliases.map((x) => ({ address: x.alias, to: x.target })),
  ].sort((a, b) => a.address.localeCompare(b.address));
  const needle = q.trim().toLowerCase();
  const shown = needle ? entries.filter((e) => [e.address, e.mailbox?.name ?? "", e.to ?? ""].some((v) => v.toLowerCase().includes(needle))) : entries;
  const failed = state.job.running ? [] : state.job.steps.filter((x) => !x.ok);
  const percent = state.job.total ? Math.min(100, Math.round((state.job.done / state.job.total) * 100)) : 0;
  const used = state.accounts.reduce((n, a) => n + a.size, 0);

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Mail</h1>
          {s.on && (
            <div className="page-sub">
              <span><b>{state.accounts.length}</b> {state.accounts.length === 1 ? "mailbox" : "mailboxes"}</span>
              <span><b>{state.aliases.length}</b> {state.aliases.length === 1 ? "alias" : "aliases"}</span>
              <span><b>{bytes(used)}</b> stored</span>
              {state.queued > 0 && <span><b>{state.queued}</b> waiting to send</span>}
            </div>
          )}
        </div>
        <div className="page-actions">
          {entries.length > 0 && (
            <label className="ct-search">
              <Icon name="search" size={18} />
              <input type="search" placeholder="Search" aria-label="Search addresses" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
            </label>
          )}
          {s.on && <button type="button" className="icon-btn" aria-label="Activity" title="Activity" onClick={() => setOpen("activity")}><Icon name="history" /></button>}
          {s.on && manage && <button type="button" className="icon-btn" aria-label="Mail settings" title="Mail settings" onClick={() => setOpen("settings")}><Icon name="tune" /></button>}
          {ready && domains.length > 0 && <button type="button" className="btn primary" onClick={() => setOpen("new")}><Icon name="add" size={18} />New address</button>}
        </div>
      </div>

      <div className="page-body stack">
        {state.job.running && <div className="mail-bar" aria-hidden><span style={{ width: `${percent}%` }} /></div>}
        {failed.length > 0 && (
          <Callout tone="bad" icon="error">
            {failed.map((x) => x.name + (x.detail ? `: ${x.detail}` : "")).join(". ")}
            {manage && <button type="button" className="link-btn" onClick={() => act(api.rerunMail, "Setting up again")}>Run again</button>}
          </Callout>
        )}

        {!ready ? (
          <div className="welcome">
            <Icon name="mail" size={48} />
            <div className="welcome-actions"><button type="button" className="btn primary" onClick={() => cloudflare()}>Connect Cloudflare</button></div>
          </div>
        ) : entries.length === 0 ? (
          <div className="welcome">
            <Icon name="mail" size={48} />
            {domains.length > 0 && <div className="welcome-actions"><button type="button" className="btn primary" onClick={() => setOpen("new")}><Icon name="add" size={18} />New address</button></div>}
          </div>
        ) : (
          <div className="card">
            <ul className="mail-list">
              {shown.map((e) => e.mailbox
                ? <MailboxRow key={e.address} account={e.mailbox} runs={runs(e.address)} onState={setState} onPassword={() => setPassword(e.address)} />
                : <AliasRow key={e.address} address={e.address} to={e.to!} runs={runs(e.address)} onState={setState} />)}
              {shown.length === 0 && <li className="mail-none">Nothing matches.</li>}
            </ul>
          </div>
        )}
      </div>

      {open === "new" && <NewAddress state={state} zones={zones} domains={domains} onState={setState} onClose={() => setOpen(null)} />}
      {open === "settings" && <SettingsDialog state={state} onState={setState} onClose={() => setOpen(null)} />}
      {open === "activity" && <ActivityDialog onClose={() => setOpen(null)} />}
      {password && <PasswordDialog address={password} onState={setState} onClose={() => setPassword(null)} />}
    </>
  );
}

// ---- the list ----

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
    <li className="mail-entry">
      <Avatar name={a.name || a.address} />
      <span className="mail-who">
        <b>{a.address}</b>
        <small>{[a.name, `${a.messages.toLocaleString()} ${a.messages === 1 ? "message" : "messages"}`].filter(Boolean).join(" · ")}</small>
      </span>
      {!a.apps && <span className="chip warn">Mail apps off</span>}
      <span className="mail-size">{bytes(a.size)}</span>
      <span className="mail-menu">{runs && <MoreMenu label={`Actions for ${a.address}`} actions={menu} />}</span>
    </li>
  );
}

function AliasRow({ address, to, runs, onState }: { address: string; to: string; runs: boolean; onState: (s: MailState) => void }) {
  const act = useAct(onState);
  const all = address.startsWith("@");
  return (
    <li className="mail-entry">
      <span className="mail-who">
        <b>{all ? `Anything @${address.slice(1)}` : address}</b>
        <small>Alias of {to}</small>
      </span>
      <span className="mail-size" />
      <span className="mail-menu">{runs && <MoreMenu label={`Actions for ${address}`} actions={[{ label: "Remove", icon: "delete", danger: true, onClick: () => act(() => api.removeMailAlias(address), `Removed ${address}`) }]} />}</span>
    </li>
  );
}

// ---- a new address ----

// NewAddress takes the address in full, the domain picked from the
// Cloudflare account's, and whether it is a mailbox or an alias of one.
// Mail turns itself on for the domain first when it is not on yet; the very
// first address also says how mail moves.
function NewAddress({ state, zones, domains, onState, onClose }: {
  state: MailState; zones: Zone[]; domains: string[]; onState: (s: MailState) => void; onClose: () => void;
}) {
  const notify = useNotify();
  const needs = useContext(NeedsContext);
  const s = state.settings;
  const [kind, setKind] = useState<"mailbox" | "alias">("mailbox");
  // How mail moves, chosen here with the first address, nothing picked for you.
  const first = !s.on;
  const [receive, setReceive] = useState<MailReceive | null>(null);
  const [apps, setApps] = useState<MailApps | null>(null);
  const [send, setSend] = useState<MailSend | null>(null);
  const [local, setLocal] = useState("");
  const [domain, setDomain] = useState(s.domains[0]?.name && domains.includes(s.domains[0].name) ? s.domains[0].name : domains[0] ?? "");
  const [name, setName] = useState("");
  const [pass, setPass] = useState("");
  const mailboxes = state.accounts.map((a) => a.address);
  const [to, setTo] = useState(mailboxes[0] ?? "");
  const [busy, setBusy] = useState(false);
  const ok = !!domain && (kind === "mailbox" ? !!local.trim() && !!pass : !!to)
    && (!first || (!!receive && !!apps && !!send && send !== "relay"));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok) return;
    setBusy(true);
    try {
      // Mail on for this domain first, the ways chosen above for a first setup.
      if (!s.domains.some((d) => d.name === domain)) {
        const zone = zones.find((z) => z.name.toLowerCase() === domain);
        if (!zone) throw new Error(`${domain} is not on the Cloudflare account`);
        onState(s.on
          ? await api.addMailDomain({ zone_id: zone.id })
          : await api.setupMail({ zone_id: zone.id, domain: null, receive: receive!, apps: apps!, send: send!, relay: null }));
      }
      const address = `${local.trim()}@${domain}`;
      onState(kind === "mailbox"
        ? await api.addMailAccount({ address, name: name.trim(), password: pass })
        : await api.setMailAlias(address, to));
      notify(kind === "mailbox" ? `Added ${address}` : `${address} is an alias of ${to}`);
      onClose();
    } catch (err) {
      notify(message(err), "bad");
      setBusy(false);
    }
  };

  return (
    <Dialog title="New address" onClose={onClose}>
      <form onSubmit={submit}>
        {mailboxes.length > 0 && (
          <div className="seg-tabs mail-kind" role="radiogroup" aria-label="Kind">
            {(["mailbox", "alias"] as const).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? "on" : undefined} onClick={() => setKind(k)}>
                {k === "mailbox" ? "Mailbox" : "Alias"}
              </button>
            ))}
          </div>
        )}
        <div className="nr-address">
          <TextField className="nr-sub" label="Address" autoFocus autoComplete="off" value={local} onChange={(v) => setLocal(v.replace(/@.*$/, "").replace(/\s/g, ""))}
            hint={kind === "alias" && !local ? "Empty for anything at the domain" : undefined} />
          <div className="tf static nr-zone">
            <div className="tf-box">
              <Dropdown label="Domain" value={domain} options={domains.map((d) => ({ value: d, label: "@" + d }))} onChange={setDomain} />
              <span className="tf-label">Domain</span>
            </div>
          </div>
        </div>
        {kind === "mailbox" ? (
          <>
            <TextField label="Name" autoComplete="off" value={name} onChange={setName} hint="Shown as who mail is from" />
            <TextField label="Password" type="password" autoComplete="new-password" data-1p-ignore value={pass} onChange={setPass} hint="Mail apps sign in with the full address and this" />
          </>
        ) : (
          <div className="tf static">
            <div className="tf-box">
              <Dropdown label="Mailbox" value={to} onChange={setTo} options={mailboxes.map((a) => ({ value: a, label: a }))} />
              <span className="tf-label">Mailbox</span>
            </div>
          </div>
        )}
        {first && (
          <div className="mail-ways">
            <Ways label="Mail arrives" options={RECEIVE} value={receive} onChange={setReceive} />
            <Ways label="Mail apps connect" value={apps} onChange={setApps}
              options={APPS.map((o) => (o.value === "tailscale" && needs && !needs.tailscale ? { ...o, disabled: true } : o))} />
            {/* A relay's server is set in Mail settings, once mail is on. */}
            <Ways label="Mail leaves" options={SEND.filter((o) => o.value !== "relay")} value={send} onChange={setSend} />
          </div>
        )}
        <div className="edit-actions">
          <button type="button" className="btn text" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!ok || busy}>{busy && <span className="spinner small on-accent" />}Create</button>
        </div>
      </form>
    </Dialog>
  );
}

// Ways is one choice of how mail moves: a button per way, none picked until
// one is pressed, and what the picked one does beneath.
function Ways<T extends string>({ label, options, value, onChange }: { label: string; options: Option<T>[]; value: T | null; onChange: (v: T) => void }) {
  const picked = options.find((o) => o.value === value);
  return (
    <div className="mail-way">
      <span className="mail-way-label">{label}</span>
      <div className="seg-tabs mail-kind" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button key={o.value} type="button" role="radio" aria-checked={value === o.value} disabled={o.disabled}
            className={value === o.value ? "on" : undefined} onClick={() => onChange(o.value)}>{o.label}</button>
        ))}
      </div>
      {picked?.hint && <small className="muted">{picked.hint}</small>}
    </div>
  );
}

function PasswordDialog({ address, onState, onClose }: { address: string; onState: (s: MailState) => void; onClose: () => void }) {
  const act = useAct(onState);
  const [pass, setPass] = useState("");
  return (
    <Dialog title={`Password for ${address}`} onClose={onClose}>
      <form onSubmit={async (e) => {
        e.preventDefault();
        if (await act(() => api.editMailAccount(address, { password: pass }), "Password changed")) onClose();
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

// ---- settings ----

function SettingsDialog({ state, onState, onClose }: { state: MailState; onState: (s: MailState) => void; onClose: () => void }) {
  const act = useAct(onState);
  const needs = useContext(NeedsContext);
  const s = state.settings;
  const [receive, setReceive] = useState<MailReceive>(s.receive);
  const [apps, setApps] = useState<MailApps>(s.apps);
  const [send, setSend] = useState<MailSend>(s.send);
  const [host, setHost] = useState(s.relay?.host ?? "");
  const [port, setPort] = useState(String(s.relay?.port ?? 587));
  const [security, setSecurity] = useState(s.relay?.security ?? "starttls");
  const [username, setUsername] = useState(s.relay?.username ?? "");
  const [password, setPassword] = useState("");
  const changed = receive !== s.receive || apps !== s.apps || send !== s.send || (send === "relay" && (host !== (s.relay?.host ?? "") || !!password));
  const ok = send !== "relay" || (!!host.trim() && Number(port) > 0 && (!!password || !!s.relay?.password_set || !username.trim()));
  const appWays = APPS.map((o) => (o.value === "tailscale" && needs && !needs.tailscale ? { ...o, disabled: true, hint: "Install Tailscale from Apps first" } : o));
  const apply = () => act(() => api.setupMail({
    zone_id: null, domain: null, receive, apps, send,
    relay: send === "relay" ? { host: host.trim(), port: Number(port), security, username: username.trim(), password: password || null } : null,
  }), "Applying");
  return (
    <Dialog title="Mail settings" wide onClose={onClose}>
      <div className="stack">
        <Card title="How mail moves" action={changed ? <button type="button" className="btn primary" disabled={!ok || state.job.running} onClick={apply}>Apply</button> : undefined}>
          <Row title="Mail arrives" sub={RECEIVE.find((o) => o.value === receive)?.hint}><Dropdown label="Mail arrives" value={receive} options={RECEIVE} onChange={setReceive} /></Row>
          <Row title="Mail apps connect" sub={APPS.find((o) => o.value === apps)?.hint}><Dropdown label="Mail apps connect" value={apps} options={appWays} onChange={setApps} /></Row>
          <Row title="Mail leaves" sub={SEND.find((o) => o.value === send)?.hint}><Dropdown label="Mail leaves" value={send} options={SEND} onChange={setSend} /></Row>
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
          <Row title="Turn off" sub="Addresses and mail are kept">
            <ArmedButton icon="block" label="Turn off" armedLabel="Close its ports" onConfirm={async () => {
              if (await act(api.mailOff, "Mail is off")) onClose();
            }} />
          </Row>
        </Card>
      </div>
    </Dialog>
  );
}

// ---- activity ----

function ActivityDialog({ onClose }: { onClose: () => void }) {
  const [log, setLog] = useState<MailLog[] | null>(null);
  useEffect(() => {
    const load = () => api.mailLog().then(setLog).catch(() => setLog([]));
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);
  return (
    <Dialog title="Activity" wide onClose={onClose}>
      {!log ? <div className="repo-loading"><span className="spinner" /></div> : log.length === 0 ? (
        <div className="welcome"><Icon name="history" size={48} /></div>
      ) : (
        <ul className="mail-list">
          {log.map((e, i) => (
            <li key={i} className="mail-entry">
              <span className="mail-forward"><Icon name={e.dir === "in" ? "download" : "upload"} size={18} /></span>
              <span className="mail-who">
                <b>{e.dir === "in" ? e.from || "<>" : e.to}</b>
                <small>{e.dir === "in" ? `to ${e.to}` : `from ${e.from}`}{e.detail ? ` · ${e.detail}` : ""}</small>
              </span>
              <span className={"chip " + (OUTCOME[e.status] ?? "")}>{e.status}</span>
              <span className="mail-size">{new Date(e.at * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
