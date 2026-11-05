import { useEffect, useState } from "react";
import { api, message, TOKEN_URL, type Account, type AdminAccount, type Route, type Settings as Saved, type Status } from "./api";
import { Dropdown, type Option } from "./Dropdown";
import { Icon, type IconName } from "./Icon";
import { loadLook, saveLook, type Look } from "./prefs";
import { Card, Row, SaveField, useNotify, ValueRow } from "./ui";

// The sections, in the order the sidebar lists them.
export const SETTINGS: [string, string, IconName][] = [
  ["cloudflare", "Cloudflare", "cloud"],
  ["network", "Network", "router"],
  ["connector", "Connector", "dns"],
  ["appearance", "Appearance", "brightness_auto"],
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
        {key === "appearance" && <Appearance />}
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
// username works, with the admin password.
function AdminAccountCard() {
  const [account, setAccount] = useState<AdminAccount | null>(null);
  useEffect(() => {
    api.account().then(setAccount).catch(() => {});
  }, []);
  if (!account) return null;
  if (!account.admin) {
    return (
      <Card title="Your account" sub="Sign in with either the email or the username. Your details are changed under Admin, Users.">
        <Row title="Email" sub={account.email || "None"} />
        <Row title="Username" sub={account.username || "None"} />
      </Card>
    );
  }
  return (
    <Card title="Admin account" sub="Sign in with either the email or the username.">
      <ValueRow title="Email" type="email" value={account.email ?? ""} onSave={(email) => api.editAccount({ email }).then(setAccount)} />
      <ValueRow title="Username" value={account.username ?? ""} onSave={(username) => api.editAccount({ username }).then(setAccount)} />
    </Card>
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

function Connector({ status }: { status: Status | null }) {
  const links = status?.connections ?? 0;
  return (
    <>
      <div className="tally three">
        <div className={"tally-item " + (links > 0 ? "ok" : "bad")}><b>{links}</b><span>Links to Cloudflare</span></div>
        <div className={"tally-item " + (status?.running ? "ok" : "bad")}><b>{status?.running ? "Running" : "Stopped"}</b><span>cloudflared</span></div>
        <div className="tally-item plain"><b>{status?.restarts ?? 0}</b><span>Restarts</span></div>
      </div>
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

function Appearance() {
  const [look, setLook] = useState(() => ({ theme: loadLook("theme"), motion: loadLook("motion"), density: loadLook("density") }));
  const set = (key: Look) => (value: string) => {
    saveLook(key, value);
    setLook((l) => ({ ...l, [key]: value }));
  };
  return (
    <Card title="Look and feel" sub="Kept in this browser.">
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
  );
}

function About() {
  return (
    <Card title="myTunnels" sub="Publish homelab apps through Cloudflare Tunnel, with an access gateway in front.">
      <Row title="Admin panel" sub="Keep it on your own network."><span className="mono">{location.host}</span></Row>
      <Row title="Source"><a className="btn" href="https://github.com/KrisPowers/myTunnels" target="_blank" rel="noreferrer">GitHub</a></Row>
      <Row title="License"><span>Apache 2.0</span></Row>
    </Card>
  );
}
