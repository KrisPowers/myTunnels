import { useEffect, useState, type FormEvent } from "react";
import { api, editOf, LEVELS, list, message, shortId, strength, type Access, type Device, type PolicyMode, type Route, type RouteEdit, type Status, type User, type Zone } from "./api";
import { Dropdown } from "./Dropdown";
import { Icon } from "./Icon";
import { go } from "./route";
import { ArmedButton, Card, Row, SaveField, Switch, TextField, useNotify } from "./ui";

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

// ---- who may open it ----

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
      <Row title="Sign-in" sub={<>People sign in with an account from <a href="#/users">Users</a>. {accounts ? `${accounts} account${accounts === 1 ? "" : "s"} so far.` : "There are none yet."}</>}>
        <Switch label="Sign-in" on={value.require_login} onChange={(v) => onChange({ require_login: v })} />
      </Row>
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

// TargetRows are where requests go: port, protocol, host, and the host name the app sees.
function TargetRows({ value, onChange, onSave }: {
  value: Pick<RouteEdit, "port" | "target_scheme" | "target_host" | "preserve_host">;
  onChange: (patch: Partial<RouteEdit>) => void;
  onSave?: (patch: Partial<RouteEdit>) => Promise<unknown>;
}) {
  const write = (patch: Partial<RouteEdit>) => (onSave ? onSave(patch) : Promise.resolve(onChange(patch)));
  return (
    <>
      {onSave && (
        <Row title="Port">
          <SaveField label="Port" numeric mono width={110} value={String(value.port)} onSave={(v) => write({ port: Number(v) })} />
        </Row>
      )}
      <Row title="Protocol" sub="Choose https when the app serves it itself. Self-signed certificates are fine.">
        <Dropdown label="Protocol" value={value.target_scheme} options={[{ value: "http", label: "http" }, { value: "https", label: "https" }]}
          onChange={(v) => write({ target_scheme: v as RouteEdit["target_scheme"] })} />
      </Row>
      <Row title="Host" sub="Leave empty for this computer. Or a container name, or another machine on the network.">
        <SaveField label="Host" mono width={220} placeholder="This computer" value={value.target_host ?? ""} onSave={(v) => write({ target_host: v.trim() || null })} />
      </Row>
      <Row title="Pass the public address" sub="Off, the app sees itself opened on this computer, which apps that only answer to localhost need. On, it sees the public address, for apps set up with it.">
        <Switch label="Pass the public address" on={value.preserve_host} onChange={(v) => write({ preserve_host: v })} />
      </Row>
    </>
  );
}

// ---- publishing ----

// NewTunnel publishes a port: the address on top, then who can open it and,
// folded away, where requests go.
export function NewTunnel({ users, onPublished }: { users: User[]; onPublished: () => Promise<void> }) {
  const [zones, setZones] = useState<Zone[] | null>(null);
  const [zone, setZone] = useState("");
  const [sub, setSub] = useState("");
  const [port, setPort] = useState("");
  const [access, setAccess] = useState<Access>({ require_lan: false, require_device: false, require_password: false, require_login: false, policy_mode: "all" });
  const [targetOpts, setTargetOpts] = useState({ target_scheme: "http" as RouteEdit["target_scheme"], target_host: null as string | null, preserve_host: false });
  const [more, setMore] = useState(false);
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
      const route = await api.publish({ subdomain: sub, zone_id: zone, port: Number(port), ...targetOpts, ...access });
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

        <AccessCard value={access} users={users} onChange={(patch) => setAccess((a) => ({ ...a, ...patch }))} />

        <Card title="Local app" sub="Where requests go. The defaults suit an app on this computer."
          action={<button type="button" className="icon-btn" aria-expanded={more} aria-label={more ? "Hide" : "Show"} onClick={() => setMore((m) => !m)}><Icon name="chevron_right" className={"fold-caret" + (more ? " open" : "")} /></button>}>
          {more && <TargetRows value={{ port: Number(port) || 0, ...targetOpts }} onChange={(patch) => setTargetOpts((t) => ({ ...t, ...patch }))} />}
        </Card>
      </div>
    </form>
  );
}

// ---- one tunnel ----

// TunnelPage is one tunnel: what it points at and who may open it, each change
// saved as it is made.
export function TunnelPage({ route, devices, users, onChanged }: { route: Route; devices: Device[]; users: User[]; onChanged: () => Promise<void> }) {
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

  const [editing, setEditing] = useState<"" | "address" | "target">("");

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
        <a className="icon-btn" href="#/" aria-label="All tunnels" title="All tunnels"><Icon name="arrow_back" /></a>
        <div className="page-head-main">
          <h1><Copy text={route.hostname} copyText={`https://${route.hostname}`} plain /></h1>
          <div className="page-sub">
            <span>to <span className="mono">{target(route)}</span></span>
          </div>
        </div>
        <div className="page-actions">
          <Switch label={edit.enabled ? "Live, switch off" : "Off, switch live"} on={edit.enabled} onChange={(v) => quietly({ enabled: v })} />
          <a className="btn" href={`https://${route.hostname}`} target="_blank" rel="noreferrer"><Icon name="open_in_new" size={18} />Open</a>
          <ArmedButton icon="delete" label="Remove" armedLabel="Remove for good" onConfirm={remove} />
        </div>
      </div>
      <div className="page-body stack">
        <AccessCard value={{ ...edit, require_password: edit.require_password || asking, password_set: route.password_set }} users={users} onChange={access}
          onPassword={async (password) => {
            await save({ require_password: true, password });
            setAsking(false);
          }} />

        {edit.require_login && (
          <Card title="Accounts allowed" sub={users.length ? "Accounts that may sign in here." : <>No accounts yet. Add one under <a href="#/users">Users</a>.</>}>
            {users.map((u) => (
              <Row key={u.id} title={<a href={`#/users/${u.id}`}>{u.name || u.username}</a>} sub={u.all_routes ? "Allowed on every tunnel" : u.email ?? u.username}>
                <Switch label={`Allow ${u.username}`} on={u.all_routes || u.route_ids.includes(route.id)} disabled={u.all_routes} onChange={(v) => grantUser(u, v)} />
              </Row>
            ))}
          </Card>
        )}

        {edit.require_device && (
          <Card title="Devices allowed" sub={approved.length ? "Approved devices that may open this tunnel." : "No device is approved yet. Open the address on a device and approve it under Devices."}>
            {approved.map((d) => (
              <Row key={d.id} title={<a href={`#/devices/${d.id}`}>{d.name || shortId(d.id)}</a>} sub={d.all_routes ? "Allowed on every tunnel" : d.info?.platform}>
                <Switch label={`Allow ${d.name || shortId(d.id)}`} on={d.all_routes || d.route_ids.includes(route.id)} disabled={d.all_routes} onChange={(v) => grantDevice(d, v)} />
              </Row>
            ))}
          </Card>
        )}

        <Card title="Local app" sub="Where requests to this address go.">
          <TargetRows value={edit} onChange={() => {}} onSave={save} />
        </Card>
      </div>
    </>
  );
}
