import { Fragment, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { NeedsApp } from "./Apps";
import { api, editOf, LEVELS, list, message, redirectUrl, shortId, strength, type Access, type OAuthProvider, type PolicyMode, type Port, type Route, type RouteEdit, type TunnelEvent, type User, type Zone } from "./api";
import { Dropdown, MultiDropdown, type Option } from "./Dropdown";
import { Icon, type IconName } from "./Icon";
import { useCan } from "./me";
import { go } from "./route";
import { ProviderLogo } from "./ProviderLogo";
import { Card, Copy, Dialog, LogTable, MoreMenu, Row, SubNav, Switch, TextField, useNotify, type LogEntry, type MenuAction } from "./ui";

// Chips saying who may open a tunnel.
export function AccessChips({ route }: { route: Route }) {
  const parts = [
    route.require_lan && "Home network",
    route.require_password && "Password",
    route.require_login && "Sign-in",
  ].filter((p): p is string => Boolean(p));
  const joiner = route.policy_mode === "any" ? "or" : "and";
  return (
    <span className="access">
      {parts.length ? parts.map((p, i) => (
        <Fragment key={p}>
          {i > 0 && <span className="joiner">{joiner}</span>}
          <span className="chip">{p}</span>
        </Fragment>
      )) : <span className="chip">Open</span>}
    </span>
  );
}

export function target(route: Route) {
  if (route.target_scheme === "dashboard") return "This dashboard";
  const scheme = route.target_scheme === "https" ? "https://" : "";
  return route.target_host ? `${scheme}${route.target_host}:${route.target_port}` : String(route.target_port);
}

// ---- where requests go ----

type Place = "here" | "machine" | "container" | "dashboard";

const PLACES: Option<Place>[] = [
  { value: "here", label: "This computer", hint: "The app runs on the machine myTunnels runs on", icon: "devices" },
  { value: "machine", label: "Another machine", hint: "A computer or device on your network", icon: "router" },
  { value: "container", label: "A container", hint: "A container on the same Docker network", icon: "dns" },
  { value: "dashboard", label: "This dashboard", hint: "myTunnels itself, to manage it from anywhere", icon: "dashboard" },
];

type Target = Pick<RouteEdit, "target_host" | "target_scheme" | "preserve_host" | "verify_tls">;

const isDashboard = (t: Pick<Target, "target_scheme">) => t.target_scheme === "dashboard";

// LocalApp picks where the app runs, in one row like the address row: this
// computer, another machine on the network, a container, or this dashboard;
// then its protocol.
function LocalApp({ value, onChange }: { value: Target; onChange: (patch: Partial<Target>) => void }) {
  const [place, setPlace] = useState<Place>(isDashboard(value) ? "dashboard" : value.target_host ? "machine" : "here");
  const pick = (p: Place) => {
    setPlace(p);
    if (p === "dashboard") onChange({ target_host: null, target_scheme: "dashboard", preserve_host: false });
    else if (isDashboard(value)) onChange({ target_host: null, target_scheme: "http" });
    else if (p === "here") onChange({ target_host: null });
  };
  if (place === "dashboard") {
    return (
      <div className="edit-row">
        <div className="tf static place">
          <div className="tf-box">
            <Dropdown label="Runs on" value={place} options={PLACES} onChange={pick} />
            <span className="tf-label">Runs on</span>
          </div>
        </div>
      </div>
    );
  }
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
      {value.target_scheme === "https" && (
        <label className="edit-switch">
          <Switch label="Check the certificate" on={value.verify_tls} onChange={(v) => onChange({ verify_tls: v })} />
          <span>Check the app's certificate, for apps with a real one</span>
        </label>
      )}
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
// that layer is turned on with none set; `onPassword` stores one on its own, from
// a dialog, and `onPasswordCancel` drops a password layer that never got one.
export function AccessCard({ value, users, providers, hostname, onChange, onPassword, onPasswordCancel }: {
  value: AccessValue;
  users: User[];
  // Third-party providers that are set up, to offer here.
  providers: OAuthProvider[];
  // The tunnel's address, once known: providers send people back to it.
  hostname?: string;
  onChange: (patch: Partial<Access>) => void;
  onPassword?: (password: string) => Promise<unknown>;
  onPasswordCancel?: () => void;
}) {
  const layers = [value.require_lan, value.require_password, value.require_login].filter(Boolean).length;
  const accounts = users.filter((u) => u.enabled).length;
  return (
    <Card title="Access Control">
      <Row title="Same network as this host" sub="Only visitors coming from this host's internet connection, or a trusted network.">
        <Switch label="Same network as this host" on={value.require_lan} onChange={(v) => onChange({ require_lan: v })} />
      </Row>
      <Row title="Tunnel password" sub="One password for this tunnel alone, asked for before anything behind it loads.">
        <Switch label="Tunnel password" on={value.require_password} onChange={(v) => onChange({ require_password: v })} />
      </Row>
      {value.require_password && (onPassword ? (
        <PasswordSetting set={!!value.password_set} onSave={onPassword} onCancel={onPasswordCancel} />
      ) : (
        <PasswordRow value={value.password ?? ""} onChange={(password) => onChange({ password })} />
      ))}
      <Row title="Sign-in" sub={<>People sign in with an account from <a href="#/users">Users</a>; each account's tunnels are picked on its page there. {accounts ? `${accounts} account${accounts === 1 ? "" : "s"} so far.` : "There are none yet."}</>}>
        <Switch label="Sign-in" on={value.require_login} onChange={(v) => onChange({ require_login: v })} />
      </Row>
      {value.require_login && (
        <>
          {providers.map((p) => {
            const on = value.oauth.includes(p.id);
            return (
              <Row key={p.id} title={<span className="provider-name"><ProviderLogo id={p.id} size={20} />Continue with {p.label}</span>}
                sub={on && hostname ? <span className="redirect-copy">Redirect URL for {p.label}: <Copy text={redirectUrl(hostname)} /></span> : `Let people sign in with ${p.label} as well.`}>
                <Switch label={`Continue with ${p.label}`} on={on}
                  onChange={(v) => onChange({ oauth: v ? [...value.oauth, p.id] : value.oauth.filter((x) => x !== p.id) })} />
              </Row>
            );
          })}
          {providers.length === 0 && (
            <Row title="Third-party sign-in" sub={<>Set up GitHub, Google and others under <a href="#/security/oauth">Third-Party OAuth</a>, then switch them on here.</>} />
          )}
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

function PasswordHint({ value, empty }: { value: string; empty: string }) {
  if (!value) return <>{empty}</>;
  const rating = strength(value);
  return (
    <>
      <span className={"strength " + rating.level}>{LEVELS[rating.level]}</span>
      {rating.missing.length > 0 && <span>Needs {list(rating.missing)}.</span>}
    </>
  );
}

// PasswordRow is the tunnel password typed into the form when publishing.
function PasswordRow({ value, onChange }: { value: string; onChange: (password: string) => void }) {
  return (
    <div className="setting nested">
      <TextField className="grow" label="Tunnel password" type="password" autoComplete="new-password" value={value} onChange={onChange}
        hint={<PasswordHint value={value} empty="Visitors type this before the app loads." />} />
    </div>
  );
}

// PasswordSetting is the password of a tunnel that exists: set or not, with an
// edit button that opens a dialog. Turning the layer on without one opens it
// straight away.
function PasswordSetting({ set, onSave, onCancel }: { set: boolean; onSave: (password: string) => Promise<unknown>; onCancel?: () => void }) {
  const [open, setOpen] = useState(!set);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const notify = useNotify();
  const close = () => {
    setOpen(false);
    setDraft("");
    if (!set) onCancel?.();
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await onSave(draft);
      notify(set ? "Tunnel password changed" : "Tunnel password set");
      setDraft("");
      setOpen(false);
    } catch (err) {
      notify(message(err), "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Row title="Password" sub={set ? "Set. Changing it signs everyone out." : "Not set"}>
        <button type="button" className="icon-btn" aria-label="Change tunnel password" title="Change" onClick={() => setOpen(true)}><Icon name="edit" size={20} /></button>
      </Row>
      {open && (
        <Dialog title={set ? "Change the tunnel password" : "Set the tunnel password"} onClose={close}>
          <form onSubmit={save}>
            <TextField label={set ? "New tunnel password" : "Tunnel password"} type="password" autoFocus autoComplete="new-password" value={draft} onChange={setDraft}
              hint={<PasswordHint value={draft} empty="Visitors type this before the app loads." />} />
            <div className="edit-actions">
              <button type="button" className="btn text" onClick={close}>Cancel</button>
              <button className="btn primary" disabled={busy || !strength(draft).ok}>{busy && <span className="spinner small on-accent" />}Save</button>
            </div>
          </form>
        </Dialog>
      )}
    </>
  );
}

// ---- publishing ----

// A port a container's tunnel can go to: one it publishes on the host, or one
// it listens on, reached by its name on a shared network.
export interface Reach { port: number; host: string | null; label: string }

// The ways a tunnel can reach a container, published ports first.
export function reachOf(c: { name: string; ports: Port[] }): Reach[] {
  const out: Reach[] = [];
  for (const p of c.ports) {
    if (p.type !== "tcp") continue;
    const r = p.public !== null ? { port: p.public, host: null, label: `Port ${p.private}` } : { port: p.private, host: c.name, label: `Port ${p.private}` };
    if (!out.some((o) => o.port === r.port && o.host === r.host)) out.push(r);
  }
  return out.sort((a, b) => Number(a.host !== null) - Number(b.host !== null));
}

// The tunnels that reach a container: aimed at one of the ports it publishes on
// the host, or at it by name on a shared network.
export function tunnelsOf(c: { name: string; ports: Port[] }, routes: Route[]) {
  const published = c.ports.filter((p) => p.public !== null && p.type === "tcp");
  return routes.filter((r) => (r.target_scheme === "http" || r.target_scheme === "https") && (
    (!r.target_host && published.some((p) => p.public === r.target_port))
    || (r.target_host === c.name && c.ports.some((p) => p.private === r.target_port))
  ));
}

const NO_ACCESS: Access = {
  require_lan: false, require_password: false, require_login: false, require_code: false, oauth: [],
  login_max: 7 * 86_400, login_idle: 0, policy_mode: "all",
};

// TunnelComposer publishes an address: the address on top, then where the app
// runs, then who can open it. For a container, where it runs is the container,
// so only its port is asked, and only when it has more than one. `lead` opens
// the address row, such as the pick of how to forward.
export function TunnelComposer({ users, providers, onPublished, port: startPort, container, sub: startSub = "", lead }: {
  lead?: ReactNode;
  users: User[];
  providers: OAuthProvider[];
  onPublished: (route: Route) => Promise<void>;
  port?: string;
  container?: { name: string; reach: Reach[] };
  sub?: string;
}) {
  const [zones, setZones] = useState<Zone[] | null>(null);
  const [zone, setZone] = useState("");
  const [sub, setSub] = useState(startSub.toLowerCase().replace(/[^a-z0-9-]/g, "").replace(/^-+/, "").slice(0, 63));
  const [port, setPort] = useState(/^\d{1,5}$/.test(startPort ?? "") ? startPort! : "");
  const [pick, setPick] = useState(0);
  const [access, setAccess] = useState<Access>(NO_ACCESS);
  const [where, setWhere] = useState<Target>({ target_scheme: "http", target_host: null, preserve_host: false, verify_tls: false });
  const [busy, setBusy] = useState(false);
  const notify = useNotify();

  useEffect(() => {
    api.zones().then((z) => {
      setZones(z);
      setZone((current) => current || z[0]?.id || "");
    }).catch((e) => notify(message(e), "bad"));
  }, [notify]);

  const reach = container?.reach ?? [];
  const fixed = reach[Math.min(pick, reach.length - 1)];
  const dashboard = !container && isDashboard(where);
  const asksPort = !dashboard && !fixed;
  const passwordOk = !access.require_password || strength(access.password ?? "").ok;
  const ready = !!sub && (!asksPort || !!port) && !!zone && passwordOk;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    try {
      const to: Target = container
        ? { target_scheme: "http", target_host: fixed ? fixed.host : container.name, preserve_host: false, verify_tls: false }
        : where;
      const route = await api.publish({ subdomain: sub, zone_id: zone, port: fixed ? fixed.port : dashboard ? 0 : Number(port), ...to, ...access });
      notify(`Published ${route.hostname}`);
      await onPublished(route);
    } catch (err) {
      notify(message(err), "bad");
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={submit}>
      <div className="card composer">
        <div className="composer-row">
          {lead}
          <TextField className="grow" label="Subdomain" placeholder="app1" autoComplete="off" autoFocus={!startSub} value={sub}
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
          {reach.length > 1 && (
            <>
              <Icon name="arrow_forward" className="composer-arrow" />
              <div className="tf static port">
                <div className="tf-box">
                  <Dropdown label="Port" value={pick} options={reach.map((r, i) => ({ value: i, label: r.label }))} onChange={setPick} />
                  <span className="tf-label">Port</span>
                </div>
              </div>
            </>
          )}
          {asksPort && (
            <>
              <Icon name="arrow_forward" className="composer-arrow" />
              <TextField className="port" label={container ? "Port" : "Local port"} placeholder="8080" mono inputMode="numeric" value={port}
                onChange={(v) => setPort(v.replace(/\D/g, "").slice(0, 5))} />
            </>
          )}
          <button className="btn primary composer-go" disabled={busy || !ready}>
            {busy ? <span className="spinner small on-accent" /> : <Icon name="add" size={18} />}Publish
          </button>
        </div>
      </div>

      {!container && (
        <Card title="Local app">
          <div className="card-pad">
            <LocalApp value={where} onChange={(patch) => setWhere((w) => ({ ...w, ...patch }))} />
          </div>
        </Card>
      )}

      <AccessCard value={access} users={users} providers={providers} onChange={(patch) => setAccess((a) => ({ ...a, ...patch }))}
        hostname={sub && zones ? `${sub}.${zones.find((z) => z.id === zone)?.name ?? ""}` : undefined} />
    </form>
  );
}

// ---- one tunnel ----

// useTunnel holds a tunnel's settings as they are being changed, and saves them.
function useTunnel(route: Route, onChanged: () => Promise<void>) {
  const [edit, setEdit] = useState<RouteEdit>(() => editOf(route));
  const notify = useNotify();
  useEffect(() => setEdit(editOf(route)), [route]);

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
  return { edit, save, quietly };
}

// TunnelMenu holds changing a tunnel's address and where it goes, and removing it.
function TunnelMenu({ route, edit, save, onChanged, onRemoved }: {
  route: Route;
  edit: RouteEdit;
  save: (change: Partial<RouteEdit>) => Promise<void>;
  onChanged: () => Promise<void>;
  onRemoved: () => void;
}) {
  const can = useCan();
  const [editing, setEditing] = useState<"" | "address" | "target">("");
  const notify = useNotify();
  const remove = async () => {
    try {
      await api.removeRoute(route.id);
      notify(`Removed ${route.hostname}`);
      await onChanged();
      onRemoved();
    } catch (e) {
      notify(message(e), "bad");
    }
  };
  const actions: MenuAction[] = [
    ...(can("tunnels.edit") ? [
      { label: "Change address", icon: "edit" as IconName, onClick: () => setEditing("address") },
      { label: "Change where it goes", icon: "swap_horiz" as IconName, onClick: () => setEditing("target") },
    ] : []),
    ...(can("tunnels.delete") ? [{ label: "Remove", icon: "delete" as IconName, danger: true, onClick: remove, confirm: "Remove for good" }] : []),
  ];
  return (
    <>
      {actions.length > 0 && <MoreMenu label={`Actions for ${route.hostname}`} actions={actions} />}
      {editing === "address" && <AddressEditor route={route} onDone={() => setEditing("")} onChanged={onChanged} />}
      {editing === "target" && <TargetEditor edit={edit} onDone={() => setEditing("")} onSave={save} />}
    </>
  );
}

// TunnelAccess is a tunnel's Access Control card. Turning on the tunnel
// password waits for one to be set.
function TunnelAccess({ route, edit, save, quietly, users, providers }: {
  route: Route;
  edit: RouteEdit;
  save: (change: Partial<RouteEdit>) => Promise<void>;
  quietly: (change: Partial<RouteEdit>) => void;
  users: User[];
  providers: OAuthProvider[];
}) {
  const [asking, setAsking] = useState(false);
  const access = (patch: Partial<Access>) => {
    if (patch.require_password && !route.password_set) {
      setAsking(true);
      return;
    }
    if (patch.require_password === false) setAsking(false);
    quietly(patch);
  };
  return (
    <AccessCard value={{ ...edit, require_password: edit.require_password || asking, password_set: route.password_set }} users={users} providers={providers} hostname={route.hostname} onChange={access}
      onPassword={async (password) => {
        await save({ require_password: true, password });
        setAsking(false);
      }}
      onPasswordCancel={() => setAsking(false)} />
  );
}

// TunnelControls are one tunnel's controls, at the side of its page: its
// switch, Open and menu, and who may open it.
function TunnelControls({ route, users, providers, onChanged, onRemoved }: {
  route: Route;
  users: User[];
  providers: OAuthProvider[];
  onChanged: () => Promise<void>;
  onRemoved: () => void;
}) {
  const can = useCan();
  const { edit, save, quietly } = useTunnel(route, onChanged);
  return (
    <>
      <section className="card">
        <div className="card-head tn-controls">
          <div className="card-titles">
            <h2>{route.hostname}</h2>
            <p>{edit.enabled ? "Live" : "Off"}</p>
          </div>
          <a className="icon-btn" href={`https://${route.hostname}`} target="_blank" rel="noreferrer" aria-label="Open" title="Open"><Icon name="open_in_new" /></a>
          {can("tunnels.edit") && <Switch label={edit.enabled ? "Live, switch off" : "Off, switch live"} on={edit.enabled} onChange={(v) => quietly({ enabled: v })} />}
          <TunnelMenu route={route} edit={edit} save={save} onChanged={onChanged} onRemoved={onRemoved} />
        </div>
      </section>
      <TunnelAccess route={route} edit={edit} save={save} quietly={quietly} users={users} providers={providers} />
    </>
  );
}

// TunnelsView is the tunnels in the middle, a row each with its state, address,
// where it goes and who may open it, and the picked one's activity under them;
// that one's controls sit at the side. `base` links each row to pick it.
export function TunnelsView({ routes, pick, base, add, users, providers, onChanged, onRemoved }: {
  routes: Route[];
  pick: string;
  base?: string;
  // What adds another, beside the list's title.
  add?: ReactNode;
  users: User[];
  providers: OAuthProvider[];
  onChanged: () => Promise<void>;
  onRemoved: () => void;
}) {
  const route = routes.find((r) => r.id === pick) ?? routes[0];
  if (!route) return null;
  return (
    <TunnelDetail route={route} users={users} providers={providers} onChanged={onChanged} onRemoved={onRemoved} top={
      <section className="card">
        <div className="card-head">
          <div className="card-titles"><h2>{routes.length === 1 ? "Address" : "Addresses"}</h2></div>
          {add}
        </div>
        <ul className="results">
          {routes.map((r) => {
            const body = (
              <>
                <span className={"dot " + (r.enabled ? "ok" : "")} role="img" aria-label={r.enabled ? "Live" : "Off"} title={r.enabled ? "Live" : "Off"} />
                <span className="tn-name">
                  <b>{r.hostname}</b>
                  <small className="mono">to {target(r)}</small>
                </span>
                <AccessChips route={r} />
              </>
            );
            return (
              <li key={r.id}>
                {base ? (
                  <a className={"result tn-row" + (r.id === route.id ? " on" : "")} href={`${base}/${r.id}`} aria-current={r.id === route.id ? "true" : undefined}>{body}</a>
                ) : <div className="result tn-row">{body}</div>}
              </li>
            );
          })}
        </ul>
      </section>
    } />
  );
}

// TunnelDetail is one tunnel: what sits over it, such as the list it was
// picked from, then its activity in the middle and its controls at the side.
export function TunnelDetail({ route, top, users, providers, onChanged, onRemoved }: {
  route: Route;
  top?: ReactNode;
  users: User[];
  providers: OAuthProvider[];
  onChanged: () => Promise<void>;
  onRemoved: () => void;
}) {
  return (
    <div className="tn-layout">
      <div className="tn-main stack">
        <NeedsApp app="cloudflared" what="A tunnel" />
        {top}
        <section>
          <h2 className="section-title">Activity</h2>
          <TunnelLogs route={route} users={users} />
        </section>
      </div>
      <aside className="tn-side stack" key={route.id} aria-label={`Controls for ${route.hostname}`}>
        <TunnelControls route={route} users={users} providers={providers} onChanged={onChanged} onRemoved={onRemoved} />
      </aside>
    </div>
  );
}

// TunnelPage is a tunnel to anything but a container, laid out as a
// container's tunnels are. A tunnel that reaches a container opens on the
// container's page.
export function TunnelPage({ route, users, providers, onChanged }: { route: Route; users: User[]; providers: OAuthProvider[]; onChanged: () => Promise<void> }) {
  const can = useCan();
  const containers = can("containers.view");

  useEffect(() => {
    if (!containers) return;
    api.containers().then((list) => {
      const c = list.find((c) => tunnelsOf(c, [route]).length > 0);
      if (c) go(`#/containers/${encodeURIComponent(c.name)}/forward/${route.id}`);
    }).catch(() => {});
  }, [containers, route.id, route.target_host, route.target_port]);

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>{route.hostname}</h1>
          <div className="page-sub">
            <span className={"chip " + (route.enabled ? "ok" : "")}>{route.enabled ? "Live" : "Off"}</span>
            <span>to <span className="mono">{target(route)}</span></span>
          </div>
        </div>
      </div>
      <SubNav back="#/forward" backLabel="Forward" base={`#/tunnels/${route.id}`} items={[]} current="" />
      <div className="page-body">
        <TunnelsView routes={[route]} pick={route.id} users={users} providers={providers} onChanged={onChanged} onRemoved={() => go("#/forward")} />
      </div>
    </>
  );
}

// AddressEditor changes a tunnel's subdomain and domain, in a dialog.
export function AddressEditor({ route, onDone, onChanged }: { route: Route; onDone: () => void; onChanged: () => Promise<void> }) {
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
    <Dialog title="Change address" onClose={onDone}>
      <form onSubmit={save}>
        <div className="edit-row">
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
        </div>
        <div className="edit-actions">
          <button type="button" className="btn text" onClick={onDone}>Cancel</button>
          <button className="btn primary" disabled={busy || !sub || !zone}>{busy && <span className="spinner small on-accent" />}Save</button>
        </div>
      </form>
    </Dialog>
  );
}

// TargetEditor changes where a tunnel goes, its port and where the app runs,
// in a dialog.
function TargetEditor({ edit, onDone, onSave }: { edit: RouteEdit; onDone: () => void; onSave: (change: Partial<RouteEdit>) => Promise<void> }) {
  const [port, setPort] = useState(String(edit.port));
  const [where, setWhere] = useState<Target>({ target_host: edit.target_host, target_scheme: edit.target_scheme, preserve_host: edit.preserve_host, verify_tls: edit.verify_tls });
  const [busy, setBusy] = useState(false);
  const notify = useNotify();

  const dashboard = isDashboard(where);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await onSave({ port: dashboard ? 0 : Number(port), ...where });
      onDone();
    } catch (err) {
      notify(message(err), "bad");
      setBusy(false);
    }
  };

  return (
    <Dialog title="Change where it goes" onClose={onDone}>
      <form className="edit-block" onSubmit={save}>
        {!dashboard && (
          <div className="edit-row">
            <TextField className="port" label="Port" mono inputMode="numeric" autoFocus value={port === "0" ? "" : port} onChange={(v) => setPort(v.replace(/\D/g, "").slice(0, 5))} />
          </div>
        )}
        <LocalApp value={where} onChange={(patch) => setWhere((w) => ({ ...w, ...patch }))} />
        <div className="edit-actions">
          <button type="button" className="btn text" onClick={onDone}>Cancel</button>
          <button className="btn primary" disabled={busy || (!dashboard && (!port || port === "0"))}>{busy && <span className="spinner small on-accent" />}Save</button>
        </div>
      </form>
    </Dialog>
  );
}

const KINDS: Option<TunnelEvent["kind"]>[] = [
  { value: "sign-in", label: "Sign-ins" },
  { value: "password", label: "Passwords" },
  { value: "visit", label: "Visits" },
  { value: "device", label: "Devices" },
];

// line says what an event was, and whether it went well, badly or neither.
function line(e: TunnelEvent): [string, string] {
  if (e.kind === "visit") {
    const asked: Record<string, string> = {
      opened: "Opened",
      network: "Turned away, not on the home network",
      login: "Asked to sign in",
      password: "Asked for the tunnel password",
      device: "Asked for an approved device",
    };
    return [e.outcome === "network" ? "bad" : "", asked[e.outcome] ?? e.outcome];
  }
  if (e.kind === "device") return e.outcome === "blocked" ? ["bad", "Refused for a day, tried several accounts"] : ["", "Asked for device approval"];
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
    unlinked: ["bad", "Refused by the device lock"],
    "wrong-code": ["bad", "Wrong email code"],
  };
  return said[e.outcome] ?? ["", e.outcome];
}

// TunnelLogs is what happened at the tunnel's door, newest first and grouped by
// day: one line each, refreshed as it runs.
export function TunnelLogs({ route, users }: { route: Route; users: User[] }) {
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
