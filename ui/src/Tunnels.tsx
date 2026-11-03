import { useEffect, useState, type FormEvent } from "react";
import { api, editOf, LEVELS, list, message, shortId, strength, type Access, type Device, type PolicyMode, type Route, type RouteEdit, type Status, type User, type Zone } from "./api";
import { Dropdown } from "./Dropdown";
import { Icon } from "./Icon";
import { go } from "./route";
import { ArmedButton, Card, Copy, Row, SaveField, Switch, TextField, useNotify } from "./ui";

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
                    <span className="result-what"><Access route={r} /></span>
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

// Publish is the one line that puts a port on a domain: subdomain, domain, port.
function Publish({ onPublished }: { onPublished: () => Promise<void> }) {
  const [zones, setZones] = useState<Zone[] | null>(null);
  const [zone, setZone] = useState("");
  const [sub, setSub] = useState("");
  const [port, setPort] = useState("");
  const [busy, setBusy] = useState(false);
  const notify = useNotify();

  useEffect(() => {
    api.zones().then((z) => {
      setZones(z);
      setZone((current) => current || z[0]?.id || "");
    }).catch((e) => notify(message(e), "bad"));
  }, [notify]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!sub || !port || !zone) return;
    setBusy(true);
    try {
      const route = await api.publish({ subdomain: sub, zone_id: zone, port: Number(port) });
      setSub("");
      setPort("");
      await onPublished();
      notify(`Published ${route.hostname}`);
    } catch (err) {
      notify(message(err), "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card composer" onSubmit={submit}>
      <div className="composer-row">
        <TextField className="grow" label="Subdomain" placeholder="app1" autoComplete="off" value={sub}
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
        <button className="btn primary composer-go" disabled={busy || !sub || !port || !zone}>
          {busy ? <span className="spinner small on-accent" /> : <Icon name="add" size={18} />}Publish
        </button>
      </div>
    </form>
  );
}

// TunnelPage is one tunnel: what it points at and who may open it, each
// change saved as it is made.
export function TunnelPage({ route, devices, onChanged }: { route: Route; devices: Device[]; onChanged: () => Promise<void> }) {
  const [edit, setEdit] = useState<RouteEdit>(() => editOf(route));
  const notify = useNotify();
  useEffect(() => setEdit(editOf(route)), [route]);

  const save = async (change: Partial<RouteEdit>) => {
    const next = { ...edit, ...change };
    setEdit(next);
    try {
      await api.editRoute(route.id, next);
      await onChanged();
    } catch (e) {
      setEdit(editOf(route));
      throw e;
    }
  };
  const quietly = (change: Partial<RouteEdit>) => save(change).catch((e) => notify(message(e), "bad"));

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
  const grant = async (device: Device, on: boolean) => {
    const ids = on ? [...device.route_ids, route.id] : device.route_ids.filter((r) => r !== route.id);
    try {
      await api.editDevice(device.id, { route_ids: ids });
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
        <Card title="Local app" sub="Where requests to this address go.">
          <Row title="Port">
            <SaveField label="Port" numeric mono width={110} value={String(edit.port)} onSave={(v) => save({ port: Number(v) })} />
          </Row>
          <Row title="Protocol" sub="Choose https when the app serves it itself. Self-signed certificates are fine.">
            <Dropdown label="Protocol" value={edit.target_scheme} options={[{ value: "http", label: "http" }, { value: "https", label: "https" }]}
              onChange={(v) => quietly({ target_scheme: v as RouteEdit["target_scheme"] })} />
          </Row>
          <Row title="Host" sub="Leave empty for the apps host from Settings. Or a container name, or another machine on the network.">
            <SaveField label="Host" mono width={220} placeholder="Apps host" value={edit.target_host ?? ""} onSave={(v) => save({ target_host: v.trim() || null })} />
          </Row>
        </Card>

        <Card title="Who can open it" sub="On top of the app's own login, if it has one.">
          <Row title="Same network as this host" sub="Only visitors coming from this host's internet connection, or a trusted network.">
            <Switch label="Same network as this host" on={edit.require_lan} onChange={(v) => quietly({ require_lan: v })} />
          </Row>
          <Row title="Approved devices" sub="A new device gets an ID and waits under Devices until you approve it.">
            <Switch label="Approved devices" on={edit.require_device} onChange={(v) => quietly({ require_device: v })} />
          </Row>
          {edit.require_lan && edit.require_device && (
            <Row title="Combine" sub="Whether a visitor needs both, or either one.">
              <Dropdown label="Combine" value={edit.policy_mode} onChange={(v) => quietly({ policy_mode: v as RouteEdit["policy_mode"] })} options={[
                { value: "all", label: "Require both", hint: "Approved device on the home network" },
                { value: "any", label: "Either is enough", hint: "Home network, or an approved device anywhere" },
              ]} />
            </Row>
          )}
        </Card>

        {edit.require_device && (
          <Card title="Devices allowed" sub={approved.length ? "Approved devices that may open this tunnel." : "No device is approved yet. Open the address on a device and approve it under Devices."}>
            {approved.map((d) => (
              <Row key={d.id} title={<a href={`#/devices/${d.id}`}>{d.name || d.id}</a>} sub={d.all_routes ? "Allowed on every tunnel" : d.info?.platform}>
                <Switch label={`Allow ${d.name || d.id}`} on={d.all_routes || d.route_ids.includes(route.id)} disabled={d.all_routes} onChange={(v) => grant(d, v)} />
              </Row>
            ))}
          </Card>
        )}
      </div>
    </>
  );
}
