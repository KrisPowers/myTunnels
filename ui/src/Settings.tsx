import { useEffect, useState, type FormEvent } from "react";
import { ago, api, message, TOKEN_URL, type Account, type AdminAccount, type PasskeyInfo, type Route, type Settings as Saved, type Status, type TotpSetup } from "./api";
import { createPasskey, deviceName, dismissed, passkeysWork } from "./passkey";
import { Dropdown, type Option } from "./Dropdown";
import { Icon, type IconName } from "./Icon";
import { loadLook, saveLook, type Look } from "./prefs";
import { Callout, Card, Dialog, Row, SaveField, TextField, useNotify, ValueRow } from "./ui";

// The sections, in the order the sidebar lists them.
export const SETTINGS: [string, string, IconName][] = [
  ["cloudflare", "Cloudflare", "cloud"],
  ["network", "Network", "router"],
  ["connector", "Connector", "dns"],
  ["account", "Account", "person"],
  ["about", "About", "info"],
];

export function Settings({ sections, section, status, routes, onChanged, onSignOut }: { sections: [string, string, IconName][]; section: string; status: Status | null; routes: Route[]; onChanged: () => Promise<void>; onSignOut: () => void }) {
  const [key, title] = sections.find(([k]) => k === section) ?? sections[0];
  const [saved, setSaved] = useState<Saved | null>(null);
  const reload = () => api.settings().then(setSaved).catch(() => {});
  useEffect(() => {
    reload();
  }, []);

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Settings</h1>
          <div className="page-sub">Saved as you change them</div>
        </div>
      </div>
      <div className="page-body stack flow" key={key}>
        <h2 className="doc-title">{title}</h2>
        {key === "cloudflare" && saved && <Cloudflare saved={saved} routes={routes} onSaved={async () => {
          await reload();
          await onChanged();
        }} />}
        {key === "network" && saved && <Network saved={saved} status={status} onSaved={reload} />}
        {key === "connector" && <Connector status={status} />}
        {key === "account" && <AdminAccountCard />}
        {key === "account" && (
          <Card title="Session">
            <Row title="Sign out" sub="Ends this browser's session on the dashboard. Tunnels keep running.">
              <button type="button" className="btn" onClick={onSignOut}><Icon name="logout" size={18} />Sign out</button>
            </Row>
          </Card>
        )}
        {key === "about" && <About />}
      </div>
    </>
  );
}

// AdminAccountCard is who signs in to this dashboard: either the email or the
// username works, with the host account's password.
function AdminAccountCard() {
  const [account, setAccount] = useState<AdminAccount | null>(null);
  useEffect(() => {
    api.account().then(setAccount).catch(() => {});
  }, []);
  if (!account) return null;
  if (!account.host) {
    return (
      <Card title="Your account" sub="Sign in with either the email or the username. Your details are changed under Security & Roles, Users.">
        <Row title="Email" sub={account.email || "None"} />
        <Row title="Username" sub={account.username || "None"} />
        <Authenticator on={account.totp} onChange={(totp) => setAccount({ ...account, totp })} />
        <Passkeys />
      </Card>
    );
  }
  return (
    <Card title="Host account" sub="Sign in with either the email or the username.">
      <ValueRow title="Email" type="email" value={account.email ?? ""} onSave={(email) => api.editAccount({ email }).then(setAccount)} />
      <ValueRow title="Username" value={account.username ?? ""} onSave={(username) => api.editAccount({ username }).then(setAccount)} />
      <Authenticator on={account.totp} onChange={(totp) => setAccount({ ...account, totp })} />
      <Passkeys />
    </Card>
  );
}

// Passkeys are the account's passkeys: added here for the address the panel is
// open at (a tunnel's domain, or the name it has on the LAN), each removable.
function Passkeys() {
  const [list, setList] = useState<PasskeyInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const notify = useNotify();
  useEffect(() => {
    api.passkeys().then(setList).catch(() => {});
  }, []);

  const add = async () => {
    setBusy(true);
    try {
      setList(await api.addPasskey(await createPasskey(await api.beginPasskey()), deviceName()));
      notify("Passkey added");
    } catch (err) {
      if (!dismissed(err)) notify(message(err), "bad");
    }
    setBusy(false);
  };
  const remove = async (id: string) => {
    try {
      setList(await api.removePasskey(id));
      notify("Passkey removed");
    } catch (err) {
      notify(message(err), "bad");
    }
  };

  return (
    <>
      <Row title="Passkeys" sub={list.length ? `${list.length} added. Sign in with one instead of a password and code.` : "Sign in with your fingerprint, face or a security key instead of a password and code."}>
        {passkeysWork() && <button type="button" className="btn text" disabled={busy} onClick={add}>Add a passkey</button>}
      </Row>
      {list.map((p) => (
        <Row key={p.id} title={p.name || "Passkey"} sub={`For ${p.rp_id}, ${p.last_used ? `used ${ago(p.last_used)}` : "not used yet"}`}>
          <button type="button" className="icon-btn small danger" aria-label={`Remove ${p.name || "passkey"}`} title="Remove" onClick={() => remove(p.id)}>
            <Icon name="close" size={18} />
          </button>
        </Row>
      ))}
    </>
  );
}

// Authenticator is the account's authenticator app: set up with a QR code and a
// first code, which shows the recovery codes once; turned off with a code.
function Authenticator({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const notify = useNotify();

  const begin = async () => {
    setProblem("");
    setCode("");
    setRecovery(null);
    setSetup(null);
    setOpen(true);
    if (on) return;
    try {
      setSetup(await api.startTotp());
    } catch (err) {
      setProblem(message(err));
    }
  };
  const close = () => {
    setOpen(false);
    if (recovery) onChange(true);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setProblem("");
    try {
      if (on) {
        await api.removeTotp(code);
        onChange(false);
        setOpen(false);
        notify("Authenticator app turned off");
      } else {
        setRecovery((await api.confirmTotp(code)).recovery);
      }
    } catch (err) {
      setProblem(message(err));
    }
    setBusy(false);
  };

  return (
    <>
      <Row title="Authenticator app" sub={on ? "On. Every sign-in asks for a code from the app." : "Off. Ask for a code from an app such as Aegis, 2FAS or Google Authenticator at every sign-in."}>
        <button type="button" className="btn text" onClick={begin}>{on ? "Turn off" : "Set up"}</button>
      </Row>
      {open && (
        <Dialog title={on ? "Turn off the authenticator app" : recovery ? "Recovery codes" : "Set up an authenticator app"} onClose={close}>
          {recovery ? (
            <div className="edit-block">
              <p className="empty-note">Each works once, in place of a code from the app. Keep them somewhere safe; they are not shown again.</p>
              <ul className="recovery-codes mono">{recovery.map((c) => <li key={c}>{c}</li>)}</ul>
              <div className="edit-actions">
                <button type="button" className="btn primary" onClick={close}>Done</button>
              </div>
            </div>
          ) : (
            <form className="edit-block" onSubmit={submit}>
              {!on && setup && (
                <>
                  <img className="totp-qr" src={`data:image/svg+xml;utf8,${encodeURIComponent(setup.qr)}`} alt="QR code for the authenticator app" width={200} height={200} />
                  <p className="empty-note">Scan it with the app, or enter this key: <span className="mono">{setup.secret}</span></p>
                </>
              )}
              <TextField label={on ? "Code from the app, or a recovery code" : "Code from the app"} mono autoFocus inputMode="numeric" autoComplete="one-time-code"
                value={code} onChange={(v) => setCode(v.replace(/\D/g, "").slice(0, on ? 10 : 6))} />
              {problem && <Callout tone="bad" icon="error">{problem}</Callout>}
              <div className="edit-actions">
                <button type="button" className="btn text" onClick={close}>Cancel</button>
                <button className="btn primary" disabled={busy || (!on && !setup) || !(code.length === 6 || (on && code.length === 10))}>
                  {busy && <span className="spinner small on-accent" />}{on ? "Turn off" : "Turn on"}
                </button>
              </div>
            </form>
          )}
        </Dialog>
      )}
    </>
  );
}

function Cloudflare({ saved, routes, onSaved }: { saved: Saved; routes: Route[]; onSaved: () => Promise<void> }) {
  const cf = saved.cloudflare;
  const [token, setToken] = useState("");
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [account, setAccount] = useState(cf.account_id ?? "");
  const [name, setName] = useState(cf.tunnel_name ?? "homelab");
  const [busy, setBusy] = useState(false);
  const notify = useNotify();
  const locked = routes.length > 0;

  const check = async () => {
    setBusy(true);
    try {
      const list = await api.accounts(token.trim() || null);
      setAccounts(list);
      if (!list.some((a) => a.id === account) && list[0]) setAccount(list[0].id);
    } catch (e) {
      notify(message(e), "bad");
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      await api.connect(token.trim() || null, account, name.trim());
      setToken("");
      setAccounts(null);
      await onSaved();
      notify("Cloudflare connection saved");
    } catch (e) {
      notify(message(e), "bad");
    } finally {
      setBusy(false);
    }
  };

  const options: Option<string>[] = (accounts ?? [{ id: cf.account_id ?? "", name: cf.account_name ?? "" }]).map((a) => ({ value: a.id, label: a.name }));

  return (
    <>
      <Card title="Connection" sub="The account and tunnel every published address runs through.">
        <Row title="Account"><span>{cf.account_name}</span></Row>
        <Row title="Tunnel" sub={<span className="mono">{cf.tunnel_id}</span>}><span>{cf.tunnel_name}</span></Row>
      </Card>
      <Card title="API token" sub="Replace it when it expires or is rolled. The new one needs the same permissions.">
        <Row title="Make a new token" sub="Opens Cloudflare with Tunnel, DNS and Zone permissions already picked.">
          <a className="btn" href={TOKEN_URL} target="_blank" rel="noreferrer"><Icon name="open_in_new" size={18} />Open Cloudflare</a>
        </Row>
        <Row title="New token">
          <span className="save-field">
            <input className="input mono" type="password" aria-label="New API token" placeholder="Paste a token" value={token} style={{ width: 240 }}
              autoComplete="off" data-1p-ignore data-lpignore="true" onChange={(e) => setToken(e.target.value)} />
            <button type="button" className="btn" disabled={busy || !token.trim()} onClick={check}>Check</button>
          </span>
        </Row>
        <Row title="Account" sub={locked ? "Remove every tunnel before switching account." : undefined}>
          {locked ? <span>{cf.account_name}</span> : <Dropdown label="Account" value={account} options={options} onChange={setAccount} />}
        </Row>
        <Row title="Tunnel name" sub={locked ? "Remove every tunnel before switching tunnel." : "Created in the account if it doesn't exist yet."}>
          {locked ? <span>{cf.tunnel_name}</span> : <input className="input" aria-label="Tunnel name" value={name} style={{ width: 200 }} onChange={(e) => setName(e.target.value)} />}
        </Row>
        <div className="card-foot">
          <button type="button" className="btn primary" disabled={busy || !account || !name.trim() || (!token.trim() && account === cf.account_id && name.trim() === cf.tunnel_name)} onClick={save}>
            {busy && <span className="spinner small on-accent" />}Save connection
          </button>
        </div>
      </Card>
    </>
  );
}

function Network({ saved, status, onSaved }: { saved: Saved; status: Status | null; onSaved: () => Promise<unknown> }) {
  const save = (host: string, trusted: string) => api.saveNetwork(host, trusted).then(onSaved);
  return (
    <>
      <Card title="Apps" sub="Where tunnels send requests unless a tunnel names its own host.">
        <Row title="Apps host" sub={<>As this container sees it. Default <span className="mono">{saved.default_upstream_host}</span>.</>}>
          <SaveField label="Apps host" mono width={240} value={saved.upstream_host} onSave={(v) => save(v.trim() || saved.default_upstream_host, saved.trusted_networks)} />
        </Row>
      </Card>
      <Card title="Home network" sub="What the Same network rule lets through.">
        <Row title="This host's public addresses" sub="Found automatically, every few minutes.">
          <span className="chips">{status?.public_ips.length ? status.public_ips.map((ip) => <span key={ip} className="port-chip">{ip}</span>) : <span className="muted">Not found yet</span>}</span>
        </Row>
        <Row title="Also count as home" sub="Networks such as a VPN range, separated by commas.">
          <SaveField label="Trusted networks" mono width={240} placeholder="None" value={saved.trusted_networks.split(/\s+/).filter(Boolean).join(", ")}
            onSave={(v) => save(saved.upstream_host, v.split(/[\s,]+/).filter(Boolean).join("\n"))} />
        </Row>
      </Card>
    </>
  );
}

// True when a cloudflared version, named year.month.patch, is a year old or more.
function outdated(version: string) {
  const [year, month] = version.split(".").map(Number);
  if (!year || !month) return false;
  const now = new Date();
  return (now.getFullYear() * 12 + now.getMonth() + 1) - (year * 12 + month) >= 12;
}

function Connector({ status }: { status: Status | null }) {
  const links = status?.connections ?? 0;
  return (
    <>
      <div className="tally three">
        <div className={"tally-item " + (links > 0 ? "ok" : "bad")}><b>{links}</b><span>Links to Cloudflare</span></div>
        <div className={"tally-item " + (status?.running ? "ok" : "bad")}><b>{status?.running ? "Running" : "Stopped"}</b><span>cloudflared</span></div>
        <div className="tally-item plain"><b>{status?.restarts ?? 0}</b><span>Restarts</span></div>
      </div>
      {status?.version && (
        <Card title={`cloudflared ${status.version}`}
          sub={outdated(status.version) ? "Over a year old. Cloudflare supports each release for about a year, so rebuild with a newer image." : "Supported"} />
      )}
      {status?.last_error && <Card title="Last problem" sub={status.last_error} />}
      <Card title="Log" sub="The connector's most recent lines.">
        <pre className="log">{status?.logs.length ? status.logs.slice(-120).join("\n") : "Nothing yet."}</pre>
      </Card>
    </>
  );
}

const THEMES: Option<string>[] = [
  { value: "system", label: "System", hint: "Follow this computer", icon: "brightness_auto" },
  { value: "light", label: "Light", icon: "light_mode" },
  { value: "dark", label: "Dark", icon: "dark_mode" },
];
const MOTION: Option<string>[] = [
  { value: "system", label: "System", hint: "Follow this computer's setting" },
  { value: "reduce", label: "Reduced", hint: "No sliding or fading" },
];
const DENSITY: Option<string>[] = [
  { value: "system", label: "Comfortable", hint: "Roomy rows" },
  { value: "compact", label: "Compact", hint: "More rows on screen" },
];

// Preferences is how the dashboard looks in this browser, a page of its own
// apart from Settings.
export function Preferences() {
  const [look, setLook] = useState(() => ({ theme: loadLook("theme"), motion: loadLook("motion"), density: loadLook("density") }));
  const set = (key: Look) => (value: string) => {
    saveLook(key, value);
    setLook((l) => ({ ...l, [key]: value }));
  };
  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Preferences</h1>
          <div className="page-sub">Kept in this browser</div>
        </div>
      </div>
      <div className="page-body stack flow">
        <Card title="Look and feel">
          <Row title="Theme" sub="Light, dark, or whatever this computer is set to">
            <Dropdown label="Theme" value={look.theme} options={THEMES} onChange={set("theme")} />
          </Row>
          <Row title="Motion" sub="Animations as pages change">
            <Dropdown label="Motion" value={look.motion} options={MOTION} onChange={set("motion")} />
          </Row>
          <Row title="Density" sub="How tightly lists are packed">
            <Dropdown label="Density" value={look.density} options={DENSITY} onChange={set("density")} />
          </Row>
        </Card>
      </div>
    </>
  );
}

function About() {
  return (
    <Card title="myTunnels" sub="Publish homelab apps through Cloudflare Tunnel, with an access gateway in front.">
      <Row title="Admin panel" sub="Opens here on this computer only; every other device uses a tunnel."><span className="mono">{location.host}</span></Row>
      <Row title="Source"><a className="btn" href="https://github.com/KrisPowers/myTunnels" target="_blank" rel="noreferrer">GitHub</a></Row>
      <Row title="License"><span>Apache 2.0</span></Row>
    </Card>
  );
}
