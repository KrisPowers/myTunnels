import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { ago, api, editOf, LEVELS, list, message, shortId, strength, type Access, type Device, type PolicyMode, type Route, type RouteEdit, type Status, type TunnelEvent, type User, type Zone } from "./api";
import { useDismiss } from "./dismiss";
import { Dropdown, MultiDropdown, type Option } from "./Dropdown";
import { Icon, type IconName } from "./Icon";
import { go } from "./route";
import { ArmedButton, Avatar, Card, LogTable, Row, SubNav, Switch, TextField, useNotify, type LogEntry } from "./ui";

// Chips saying who may open a tunnel.
export function AccessChips({ route }: { route: Route }) {
  const parts = [
    route.require_lan && "Home network",
    route.require_device && "Approved device",
    route.require_password && "Password",
    route.require_login && "Sign-in",
  ].filter((p): p is string => Boolean(p));
  if (!parts.length) return <span className="chip">Open</span>;
  const joiner = route.policy_mode === "any" ? "or" : "and";
  return (
    <span className="chips">
      {parts.map((p, i) => (
        <span key={p} className="chips">
          {i > 0 && <span className="joiner">{joiner}</span>}
          <span className="chip plain">{p}</span>
        </span>
      ))}
    </span>
  );
}

function target(route: Route) {
  const scheme = route.target_scheme === "https" ? "https://" : "";
  return route.target_host ? `${scheme}${route.target_host}:${route.target_port}` : `${scheme}port ${route.target_port}`;
}

// Tunnels is the home page: every tunnel published.
export function Tunnels({ routes, status }: { routes: Route[] | null; status: Status | null }) {
  const live = routes?.filter((r) => r.enabled).length ?? 0;
  const links = status?.connections ?? 0;
  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Tunnels</h1>
          <div className="page-sub">
            <span><b>{live}</b> live</span>
            <span>{links > 0 ? `Connector online, ${links} links` : status?.running ? "Connector starting" : "Connector offline"}</span>
          </div>
        </div>
      </div>
      <div className="page-body stack">
        {routes && routes.length === 0 && (
          <div className="card welcome">
            <Icon name="public" size={40} />
            <h2>Nothing published yet</h2>
            <p className="muted">Publish a port on one of your domains, and choose who can open it.</p>
            <a className="btn primary" href="#/new"><Icon name="add" size={18} />New tunnel</a>
          </div>
        )}
        {routes && routes.length > 0 && (
          <div className="card">
            <ul className="results">
              {routes.map((r) => (
                <li key={r.id}>
                  <a className="result tunnel-row" href={`#/tunnels/${r.id}`}>
                    <span className={"dot " + (r.enabled ? "ok" : "")} role="img" aria-label={r.enabled ? "Live" : "Off"} title={r.enabled ? "Live" : "Off"} />
                    <span className="scan-target">{r.hostname}</span>
                    <span className="result-service mono">{target(r)}</span>
                    <span className="result-what"><AccessChips route={r} /></span>
                    <Icon name="chevron_right" className="result-go" />
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </>
  );
}

// ---- where requests go ----

type Place = "here" | "machine" | "container";

const PLACES: Option<Place>[] = [
  { value: "here", label: "This computer", hint: "The app runs on the machine myTunnels runs on", icon: "devices" },
  { value: "machine", label: "Another machine", hint: "A computer or device on your network", icon: "router" },
  { value: "container", label: "A container", hint: "A container on the same Docker network", icon: "dns" },
];

type Target = Pick<RouteEdit, "target_host" | "target_scheme" | "preserve_host">;

// LocalApp picks where the app runs, in one row like the address row: this
// computer, another machine on the network, or a container; then its protocol.
function LocalApp({ value, onChange }: { value: Target; onChange: (patch: Partial<Target>) => void }) {
  const [place, setPlace] = useState<Place>(value.target_host ? "machine" : "here");
  const pick = (p: Place) => {
    setPlace(p);
    if (p === "here") onChange({ target_host: null });
  };
  return (
    <>
      <div className="edit-row">
        <div className="tf static place">
          <div className="tf-box">
            <Dropdown label="Runs on" value={place} options={PLACES} onChange={pick} />
            <span className="tf-label">Runs on</span>
          </div>
        </div>
        {place !== "here" && (
          <TextField className="grow" mono autoComplete="off" value={value.target_host ?? ""}
            label={place === "container" ? "Container name" : "IP address or host name"}
            placeholder={place === "container" ? "jellyfin" : "192.168.1.20"}
            onChange={(v) => onChange({ target_host: v.trim() || null })} />
        )}
        <div className="tf static protocol">
          <div className="tf-box">
            <Dropdown label="Protocol" value={value.target_scheme} onChange={(v) => onChange({ target_scheme: v as RouteEdit["target_scheme"] })}
              options={[{ value: "http", label: "http" }, { value: "https", label: "https", hint: "Self-signed certificates are fine" }]} />
            <span className="tf-label">Protocol</span>
          </div>
        </div>
      </div>
      <label className="edit-switch">
        <Switch label="Pass the public address" on={value.preserve_host} onChange={(v) => onChange({ preserve_host: v })} />
        <span>Pass the public address to the app, for apps set up with it</span>
      </label>
    </>
  );
}

// ---- who may open it ----

const SIGN_IN_FOR: Option<number>[] = [
  { value: 3_600, label: "1 hour" },
  { value: 4 * 3_600, label: "4 hours" },
  { value: 12 * 3_600, label: "12 hours" },
  { value: 86_400, label: "1 day" },
  { value: 7 * 86_400, label: "7 days" },
  { value: 30 * 86_400, label: "30 days" },
];

const IDLE_FOR: Option<number>[] = [
  { value: 0, label: "Never" },
  { value: 15 * 60, label: "15 minutes" },
  { value: 3_600, label: "1 hour" },
  { value: 4 * 3_600, label: "4 hours" },
  { value: 86_400, label: "1 day" },
];

type AccessValue = Access & { password_set?: boolean };

// AccessCard holds a tunnel's access layers. A tunnel password is asked for when
// that layer is turned on with none set; `onPassword` stores one on its own.
function AccessCard({ value, users, onChange, onPassword }: {
  value: AccessValue;
  users: User[];
  onChange: (patch: Partial<Access>) => void;
  onPassword?: (password: string) => Promise<unknown>;
}) {
  const layers = [value.require_lan, value.require_device, value.require_password, value.require_login].filter(Boolean).length;
  const accounts = users.filter((u) => u.enabled).length;
  return (
    <Card title="Access Control">
      <Row title="Same network as this host" sub="Only visitors coming from this host's internet connection, or a trusted network.">
        <Switch label="Same network as this host" on={value.require_lan} onChange={(v) => onChange({ require_lan: v })} />
      </Row>
      <Row title="Approved devices" sub="A new device gets an ID and waits under Devices until you approve it.">
        <Switch label="Approved devices" on={value.require_device} onChange={(v) => onChange({ require_device: v })} />
      </Row>
      <Row title="Tunnel password" sub="One password for this tunnel alone, asked for before anything behind it loads.">
        <Switch label="Tunnel password" on={value.require_password} onChange={(v) => onChange({ require_password: v })} />
      </Row>
      {value.require_password && (
        <PasswordRow set={!!value.password_set} value={value.password ?? ""} onChange={onPassword ? undefined : (password) => onChange({ password })} onSave={onPassword} />
      )}
      <Row title="Sign-in" sub={<>People sign in with their email and an account from <a href="#/users">Users</a>. {accounts ? `${accounts} account${accounts === 1 ? "" : "s"} so far.` : "There are none yet."}</>}>
        <Switch label="Sign-in" on={value.require_login} onChange={(v) => onChange({ require_login: v })} />
      </Row>
      {value.require_login && (
        <>
          <Row title="Sign in again after" sub="How long a sign-in lasts before it is asked for again.">
            <Dropdown label="Sign in again after" value={value.login_max} options={SIGN_IN_FOR} onChange={(v) => onChange({ login_max: v })} />
          </Row>
          <Row title="Sign out when idle for" sub="A sign-in left unused this long ends early.">
            <Dropdown label="Sign out when idle for" value={value.login_idle} options={IDLE_FOR} onChange={(v) => onChange({ login_idle: v })} />
          </Row>
        </>
      )}
      {layers > 1 && (
        <Row title="Combine" sub="Whether a visitor needs every layer above, or any one of them.">
          <Dropdown label="Combine" value={value.policy_mode} onChange={(v) => onChange({ policy_mode: v as PolicyMode })} options={[
            { value: "all", label: "Require all", hint: "Every layer that is on" },
            { value: "any", label: "Any one is enough", hint: "Visitors pick the one they have" },
          ]} />
        </Row>
      )}
    </Card>
  );
}

// PasswordRow sets the tunnel password: typed into the form when publishing, or
// saved on its own for a tunnel that exists.
function PasswordRow({ set, value, onChange, onSave }: {
  set: boolean;
  value: string;
  onChange?: (password: string) => void;
  onSave?: (password: string) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const rating = strength(draft);
  const notify = useNotify();
  const update = (p: string) => {
    setDraft(p);
    onChange?.(p);
  };
  return (
    <div className="setting nested">
      <TextField className="grow" label={set ? "New tunnel password" : "Tunnel password"} type="password" autoComplete="new-password"
        value={draft} onChange={update}
        hint={draft ? (
          <>
            <span className={"strength " + rating.level}>{LEVELS[rating.level]}</span>
            {rating.missing.length > 0 && <span>Needs {list(rating.missing)}.</span>}
          </>
        ) : set ? "A password is set. Type a new one to replace it." : "Visitors type this before the app loads."} />
      {onSave && (
        <button type="button" className="btn primary" disabled={busy || !rating.ok} onClick={async () => {
          setBusy(true);
          try {
            await onSave(draft);
            setDraft("");
            notify(set ? "Tunnel password changed" : "Tunnel password set");
          } catch (e) {
            notify(message(e), "bad");
          } finally {
            setBusy(false);
          }
        }}>{set ? "Change" : "Set password"}</button>
      )}
    </div>
  );
}

// ---- publishing ----

// NewTunnel publishes a port: the address on top, then where the app runs, then
// who can open it.
export function NewTunnel({ users, onPublished }: { users: User[]; onPublished: () => Promise<void> }) {
  const [zones, setZones] = useState<Zone[] | null>(null);
  const [zone, setZone] = useState("");
  const [sub, setSub] = useState("");
  const [port, setPort] = useState("");
  const [access, setAccess] = useState<Access>({
    require_lan: false, require_device: false, require_password: false, require_login: false,
    login_max: 7 * 86_400, login_idle: 0, policy_mode: "all",
  });
  const [where, setWhere] = useState<Target>({ target_scheme: "http", target_host: null, preserve_host: false });
  const [busy, setBusy] = useState(false);
  const notify = useNotify();

  useEffect(() => {
    api.zones().then((z) => {
      setZones(z);
      setZone((current) => current || z[0]?.id || "");
    }).catch((e) => notify(message(e), "bad"));
  }, [notify]);

  const passwordOk = !access.require_password || strength(access.password ?? "").ok;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!sub || !port || !zone || !passwordOk) return;
    setBusy(true);
    try {
      const route = await api.publish({ subdomain: sub, zone_id: zone, port: Number(port), ...where, ...access });
      await onPublished();
      notify(`Published ${route.hostname}`);
      go(`#/tunnels/${route.id}`);
    } catch (err) {
      notify(message(err), "bad");
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <div className="page-head">
        <a className="icon-btn" href="#/" aria-label="All tunnels" title="All tunnels"><Icon name="arrow_back" /></a>
        <div className="page-head-main">
          <h1>New tunnel</h1>
          <div className="page-sub">Publish a port on one of your domains.</div>
        </div>
      </div>
      <div className="page-body stack">
        <div className="card composer">
          <div className="composer-row">
            <TextField className="grow" label="Subdomain" placeholder="app1" autoComplete="off" autoFocus value={sub}
              onChange={(v) => setSub(v.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 63))} />
            <span className="composer-dot">.</span>
            <div className="tf static grow">
              <div className="tf-box">
                {zones && zones.length > 0 ? (
                  <Dropdown label="Domain" value={zone} options={zones.map((z) => ({ value: z.id, label: z.name }))} onChange={setZone} />
                ) : (
                  <span className="dropdown placeholder">{zones ? "No domains on this account" : "Loading domains"}</span>
                )}
                <span className="tf-label">Domain</span>
              </div>
            </div>
            <Icon name="arrow_forward" className="composer-arrow" />
            <TextField className="port" label="Local port" placeholder="8080" mono inputMode="numeric" value={port}
              onChange={(v) => setPort(v.replace(/\D/g, "").slice(0, 5))} />
            <button className="btn primary composer-go" disabled={busy || !sub || !port || !zone || !passwordOk}>
              {busy ? <span className="spinner small on-accent" /> : <Icon name="add" size={18} />}Publish
            </button>
          </div>
        </div>

        <Card title="Local app">
          <div className="card-pad">
            <LocalApp value={where} onChange={(patch) => setWhere((w) => ({ ...w, ...patch }))} />
          </div>
        </Card>

        <AccessCard value={access} users={users} onChange={(patch) => setAccess((a) => ({ ...a, ...patch }))} />
      </div>
    </form>
  );
}

// ---- one tunnel ----

const TUNNEL_PAGES: [string, string, IconName][] = [
  ["access", "Access Control", "shield"],
  ["devices", "Devices", "devices"],
  ["activity", "Activity", "history"],
];

// TunnelPage is one tunnel: its address and target in the heading, each with an
// edit button, then its sub-pages under a bar.
export function TunnelPage({ route, page, devices, users, onChanged }: { route: Route; page: string; devices: Device[]; users: User[]; onChanged: () => Promise<void> }) {
  const [edit, setEdit] = useState<RouteEdit>(() => editOf(route));
  const [editing, setEditing] = useState<"" | "address" | "target">("");
  const notify = useNotify();
  useEffect(() => setEdit(editOf(route)), [route]);
  const current = TUNNEL_PAGES.some(([k]) => k === page) ? page : "access";

  const save = async (change: Partial<RouteEdit>) => {
    const next = { ...edit, ...change };
    // A new tunnel password goes once; sent again, it would sign everyone out.
    setEdit({ ...next, password: undefined });
    try {
      await api.editRoute(route.id, next);
      await onChanged();
    } catch (e) {
      setEdit(editOf(route));
      throw e;
    }
  };
  const quietly = (change: Partial<RouteEdit>) => save(change).catch((e) => notify(message(e), "bad"));

  // Turning on the tunnel password waits for one to be set.
  const [asking, setAsking] = useState(false);
  const access = (patch: Partial<Access>) => {
    if (patch.require_password && !route.password_set) {
      setAsking(true);
      return;
    }
    if (patch.require_password === false) setAsking(false);
    quietly(patch);
  };

  const remove = async () => {
    try {
      await api.removeRoute(route.id);
      notify(`Removed ${route.hostname}`);
      await onChanged();
      go("#/");
    } catch (e) {
      notify(message(e), "bad");
    }
  };

  const approved = devices.filter((d) => d.status === "approved");
  const grantDevice = async (device: Device, on: boolean) => {
    const ids = on ? [...device.route_ids, route.id] : device.route_ids.filter((r) => r !== route.id);
    try {
      await api.editDevice(device.id, { route_ids: ids });
      await onChanged();
    } catch (e) {
      notify(message(e), "bad");
    }
  };
  const grantUser = async (user: User, on: boolean) => {
    const ids = on ? [...user.route_ids, route.id] : user.route_ids.filter((r) => r !== route.id);
    try {
      await api.editUser(user.id, { route_ids: ids });
      await onChanged();
    } catch (e) {
      notify(message(e), "bad");
    }
  };

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          {editing === "address" ? (
            <AddressEditor route={route} onDone={() => setEditing("")} onChanged={onChanged} />
          ) : (
            <div className="inline-edit">
              <h1>{route.hostname}</h1>
              <button type="button" className="icon-btn" aria-label="Change address" title="Change address" onClick={() => setEditing("address")}><Icon name="edit" size={20} /></button>
            </div>
          )}
          {editing === "target" ? (
            <TargetEditor edit={edit} onDone={() => setEditing("")} onSave={save} />
          ) : (
            <div className="page-sub inline-edit">
              <span>to <span className="mono">{target(route)}</span></span>
              <button type="button" className="icon-btn small" aria-label="Change where it goes" title="Change where it goes" onClick={() => setEditing("target")}><Icon name="edit" size={18} /></button>
            </div>
          )}
        </div>
        <div className="page-actions">
          <Switch label={edit.enabled ? "Live, switch off" : "Off, switch live"} on={edit.enabled} onChange={(v) => quietly({ enabled: v })} />
          <a className="btn" href={`https://${route.hostname}`} target="_blank" rel="noreferrer"><Icon name="open_in_new" size={18} />Open</a>
          <ArmedButton icon="delete" label="Remove" armedLabel="Remove for good" onConfirm={remove} />
        </div>
      </div>
      <SubNav back="#/" backLabel="Tunnels" base={`#/tunnels/${route.id}`} items={TUNNEL_PAGES} current={current} />

      <div className="page-body stack plain" key={current}>
        {current === "access" && (
          <AccessCard value={{ ...edit, require_password: edit.require_password || asking, password_set: route.password_set }} users={users} onChange={access}
            onPassword={async (password) => {
              await save({ require_password: true, password });
              setAsking(false);
            }} />
        )}

        {current === "access" && <People route={route} users={users} onGrant={grantUser} />}

        {current === "activity" && <TunnelLogs route={route} users={users} />}

        {current === "devices" && (!edit.require_device ? (
          <div className="card welcome">
            <Icon name="devices" size={40} />
            <h2>Device approval is off</h2>
            <p className="muted">Turn it on to let in only devices you approve.</p>
            <button type="button" className="btn primary" onClick={() => quietly({ require_device: true })}>Turn on device approval</button>
          </div>
        ) : (
          <Card title="Devices allowed" sub={approved.length ? undefined : "No device is approved yet. Open the address on a device and approve it under Devices."}>
            {approved.map((d) => (
              <Row key={d.id} title={<a href={`#/devices/${d.id}`}>{d.name || shortId(d.id)}</a>} sub={d.all_routes ? "Allowed on every tunnel" : d.info?.platform}>
                <Switch label={`Allow ${d.name || shortId(d.id)}`} on={d.all_routes || d.route_ids.includes(route.id)} disabled={d.all_routes} onChange={(v) => grantDevice(d, v)} />
              </Row>
            ))}
          </Card>
        ))}
      </div>
    </>
  );
}

// AddressEditor changes a tunnel's subdomain and domain in place of its title.
function AddressEditor({ route, onDone, onChanged }: { route: Route; onDone: () => void; onChanged: () => Promise<void> }) {
  const [zones, setZones] = useState<Zone[] | null>(null);
  const [zone, setZone] = useState(route.zone_id);
  const [sub, setSub] = useState(route.subdomain);
  const [busy, setBusy] = useState(false);
  const notify = useNotify();

  useEffect(() => {
    api.zones().then(setZones).catch((e) => notify(message(e), "bad"));
  }, [notify]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const moved = await api.moveRoute(route.id, sub, zone);
      await onChanged();
      notify(`Moved to ${moved.hostname}`);
      onDone();
    } catch (err) {
      notify(message(err), "bad");
      setBusy(false);
    }
  };

  return (
    <form className="edit-row" onSubmit={save}>
      <TextField className="grow" label="Subdomain" autoFocus autoComplete="off" value={sub}
        onChange={(v) => setSub(v.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 63))} />
      <span className="composer-dot">.</span>
      <div className="tf static grow">
        <div className="tf-box">
          {zones ? (
            <Dropdown label="Domain" value={zone} options={zones.map((z) => ({ value: z.id, label: z.name }))} onChange={setZone} />
          ) : (
            <span className="dropdown placeholder">Loading domains</span>
          )}
          <span className="tf-label">Domain</span>
        </div>
      </div>
      <button type="button" className="btn text" onClick={onDone}>Cancel</button>
      <button className="btn primary" disabled={busy || !sub || !zone}>{busy && <span className="spinner small on-accent" />}Save</button>
    </form>
  );
}

// TargetEditor changes where a tunnel goes: its port, and where the app runs.
function TargetEditor({ edit, onDone, onSave }: { edit: RouteEdit; onDone: () => void; onSave: (change: Partial<RouteEdit>) => Promise<void> }) {
  const [port, setPort] = useState(String(edit.port));
  const [where, setWhere] = useState<Target>({ target_host: edit.target_host, target_scheme: edit.target_scheme, preserve_host: edit.preserve_host });
  const [busy, setBusy] = useState(false);
  const notify = useNotify();

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await onSave({ port: Number(port), ...where });
      onDone();
    } catch (err) {
      notify(message(err), "bad");
      setBusy(false);
    }
  };

  return (
    <form className="edit-block" onSubmit={save}>
      <div className="edit-row">
        <TextField className="port" label="Port" mono inputMode="numeric" autoFocus value={port} onChange={(v) => setPort(v.replace(/\D/g, "").slice(0, 5))} />
      </div>
      <LocalApp value={where} onChange={(patch) => setWhere((w) => ({ ...w, ...patch }))} />
      <div className="edit-actions">
        <button type="button" className="btn text" onClick={onDone}>Cancel</button>
        <button className="btn primary" disabled={busy || !port}>{busy && <span className="spinner small on-accent" />}Save</button>
      </div>
    </form>
  );
}

// People are the accounts that may sign in at this tunnel, added one by one: a
// plus beside the heading opens a menu to find someone, then a row per person.
function People({ route, users, onGrant }: { route: Route; users: User[]; onGrant: (user: User, on: boolean) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ top: 0, left: 0 });
  const close = useCallback(() => {
    setOpen(false);
    setQ("");
  }, []);
  useDismiss(open, close, wrap, panel);

  // The menu is drawn over the page, under the plus, so no card or scroll area
  // cuts it off; scrolling or resizing closes it.
  useLayoutEffect(() => {
    if (!open || !wrap.current) return;
    const r = wrap.current.getBoundingClientRect();
    setAt({ top: r.bottom + 4, left: Math.max(8, Math.min(r.right - 300, innerWidth - 308)) });
    // Scrolling the menu's own list keeps it open.
    const away = (e: Event) => {
      if (!panel.current?.contains(e.target as Node)) close();
    };
    addEventListener("scroll", away, true);
    addEventListener("resize", close);
    return () => {
      removeEventListener("scroll", away, true);
      removeEventListener("resize", close);
    };
  }, [open, close]);

  const members = users.filter((u) => u.route_ids.includes(route.id));
  const needle = q.trim().toLowerCase();
  // Everyone matching, those with access already shown but not pickable.
  const matches = users
    .filter((u) => !needle || [u.name, u.username, u.email].some((v) => v.toLowerCase().includes(needle)))
    // Most active first: latest sign-in, then never signed in.
    .sort((a, b) => (b.last_login ?? 0) - (a.last_login ?? 0))
    .slice(0, 8);

  const add = async (u: User) => {
    close();
    await onGrant(u, true);
  };

  const menu = (
    <div className="menu-wrap" ref={wrap}>
      <button type="button" className={"icon-btn" + (open ? " on" : "")} aria-label="Add people" title="Add people" aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}>
        <Icon name="add" />
      </button>
      {open && createPortal(
        <div ref={panel} className="menu people-menu" style={{ top: at.top, left: at.left }}>
          {users.length === 0 ? (
            <a className="menu-item" href="#/users/new"><Icon name="add" size={18} />New user</a>
          ) : (
            <>
              <input className="menu-search" type="text" placeholder="Name or email" aria-label="Find people" autoFocus autoComplete="off" spellCheck={false}
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setActive(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    setActive((i) => Math.max(0, Math.min(matches.length - 1, i + (e.key === "ArrowDown" ? 1 : -1))));
                  } else if (e.key === "Enter" && matches[active] && !matches[active].route_ids.includes(route.id)) {
                    e.preventDefault();
                    add(matches[active]);
                  }
                }} />
              {matches.length === 0 && <div className="menu-note">No one by that name</div>}
              {matches.map((u, i) => {
                const has = u.route_ids.includes(route.id);
                return (
                  <button key={u.id} type="button" className={"menu-item person-item" + (i === active ? " active" : "")} disabled={has}
                    onMouseEnter={() => setActive(i)} onClick={() => add(u)}>
                    <Avatar name={u.name || u.username} />
                    <span className="person">
                      <span>{u.name || u.username}</span>
                      <small>{has ? "Has access" : u.email}</small>
                    </span>
                  </button>
                );
              })}
            </>
          )}
        </div>,
        document.body,
      )}
    </div>
  );

  return (
    <Card title="People with access" action={menu}
      sub={!route.require_login ? "Sign-in is off, so no one is asked for an account yet." : members.length ? undefined : "No one yet."}>
      {members.length > 0 && (
        <ul className="people">
          {members.map((u) => (
            <li key={u.id} className="person-row">
              <Avatar name={u.name || u.username} />
              <a className="person" href={`#/users/${u.id}`}>
                <span className="scan-target">{u.name || u.username}</span>
                <small>{u.email}</small>
              </a>
              <span className="result-meta">{u.last_login ? `Signed in ${ago(u.last_login)}` : "Never signed in"}</span>
              <button type="button" className="icon-btn danger" aria-label={`Remove ${u.username}`} title="Remove" onClick={() => onGrant(u, false)}>
                <Icon name="close" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const KINDS: Option<TunnelEvent["kind"]>[] = [
  { value: "sign-in", label: "Sign-ins" },
  { value: "password", label: "Passwords" },
  { value: "visit", label: "Turned away" },
  { value: "device", label: "Devices" },
];

// line says what an event was, and whether it went well, badly or neither.
function line(e: TunnelEvent): [string, string] {
  if (e.kind === "visit") {
    const asked: Record<string, string> = {
      network: "Turned away, not on the home network",
      login: "Asked to sign in",
      password: "Asked for the tunnel password",
      device: "Asked for an approved device",
    };
    return [e.outcome === "network" ? "bad" : "", asked[e.outcome] ?? e.outcome];
  }
  if (e.kind === "device") return ["", "Asked for device approval"];
  if (e.kind === "password") {
    const said: Record<string, [string, string]> = {
      ok: ["ok", "Tunnel password entered"],
      failed: ["bad", "Wrong tunnel password"],
      locked: ["bad", "Locked out after too many tries"],
    };
    return said[e.outcome] ?? ["", e.outcome];
  }
  const said: Record<string, [string, string]> = {
    ok: ["ok", "Signed in"],
    failed: ["bad", "Wrong password"],
    locked: ["bad", "Locked out after too many tries"],
    blocked: ["bad", "Held for review"],
  };
  return said[e.outcome] ?? ["", e.outcome];
}

// TunnelLogs is what happened at the tunnel's door, newest first and grouped by
// day: one line each, refreshed as it runs.
function TunnelLogs({ route, users }: { route: Route; users: User[] }) {
  const [events, setEvents] = useState<TunnelEvent[] | null>(null);
  const [kinds, setKinds] = useState<TunnelEvent["kind"][]>([]);
  useEffect(() => {
    const load = () => api.routeActivity(route.id).then(setEvents).catch(() => setEvents((e) => e ?? []));
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [route.id]);
  const shown = (events ?? []).filter((e) => !kinds.length || kinds.includes(e.kind));
  const entries: LogEntry[] = shown.map((e) => {
    const user = e.user_id ? users.find((u) => u.id === e.user_id) : undefined;
    const [tone, event] = line(e);
    const who = user ? <a href={`#/users/${user.id}`}>{user.name || user.username}</a>
      : e.device_id ? <a className="mono" href={`#/devices/${e.device_id}`}>{shortId(e.device_id)}</a> : undefined;
    return { at: e.at, tone, event, who, ip: e.ip, country: e.country };
  });

  return (
    <>
      <div className="log-bar">
        <MultiDropdown label="Show" values={kinds} options={KINDS} allLabel="All events" onChange={setKinds} />
        <button type="button" className="btn text" onClick={() => setKinds([])}>
          <Icon name="refresh" size={18} />Reset
        </button>
      </div>
      {events && entries.length === 0 ? <p className="muted">Nothing yet.</p> : <LogTable entries={entries} />}
    </>
  );
}
