import { useState } from "react";
import { ago, api, message, shortId, type Device, type DeviceStatus, type Route } from "./api";
import { Icon } from "./Icon";
import { go } from "./route";
import { ArmedButton, Callout, Card, Copy, Row, SaveField, Switch, useNotify } from "./ui";

// Two lists: devices let in, and every other device met, waiting to be decided.
type Tab = "approved" | "requests";
const TABS: [Tab, string][] = [
  ["approved", "Approved"],
  ["requests", "Requests"],
];
const inTab = (tab: Tab, d: Device) => (tab === "approved") === (d.status === "approved");

const TONE: Record<DeviceStatus, string> = { seen: "", pending: "warn", approved: "ok", denied: "bad" };
const LABEL: Record<DeviceStatus, string> = { seen: "Request", pending: "Request", approved: "Approved", denied: "Denied" };

function summary(d: Device) {
  const i = d.info ?? {};
  return [i.platform, i.webglRenderer, d.country].filter(Boolean).join(", ") || "Unknown hardware";
}

// useApprove approves a device. One that has no tunnels yet is given the one
// it asked for, so approving is all it takes.
function useApprove(routes: Route[], onChanged: () => Promise<void>) {
  const notify = useNotify();
  return async (d: Device) => {
    const asked = routes.find((r) => r.hostname === d.first_host);
    const route_ids = !d.all_routes && d.route_ids.length === 0 && asked ? [asked.id] : undefined;
    try {
      await api.editDevice(d.id, { status: "approved", route_ids });
      await onChanged();
      notify(`Approved ${d.name || shortId(d.id)}${asked && route_ids ? ` for ${asked.hostname}` : ""}`);
    } catch (e) {
      notify(message(e), "bad");
    }
  };
}

// Devices is every browser met so far: those approved, and requests.
export function Devices({ devices, routes, onChanged }: { devices: Device[] | null; routes: Route[]; onChanged: () => Promise<void> }) {
  const all = devices ?? [];
  const count = (tab: Tab) => all.filter((d) => inTab(tab, d)).length;
  const [tab, setTab] = useState<Tab>(all.some((d) => d.status === "pending") ? "requests" : "approved");
  const approve = useApprove(routes, onChanged);
  const shown = all.filter((d) => inTab(tab, d));

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Devices</h1>
          <div className="page-sub">
            <span><b>{count("approved")}</b> approved</span>
            <span><b>{count("requests")}</b> requests</span>
          </div>
        </div>
      </div>
      <div className="page-body">
        <div className="filters" role="tablist">
          {TABS.map(([key, label]) => (
            <button key={key} type="button" role="tab" className="filter" aria-selected={tab === key} onClick={() => setTab(key)}>
              {label}<span>{count(key)}</span>
            </button>
          ))}
        </div>
        {devices && shown.length === 0 && (
          <div className="card welcome">
            <Icon name="devices" size={40} />
            <h2>{tab === "requests" ? "No requests" : "No approved devices"}</h2>
            {tab === "requests" && <p className="muted">A device shows up here the first time it opens one of your tunnels.</p>}
          </div>
        )}
        {shown.length > 0 && (
          <div className="card">
            <ul className="results">
              {shown.map((d) => (
                <li key={d.id}>
                  <a className="result device-row" href={`#/devices/${d.id}`}>
                    <span className={"dot " + TONE[d.status]} role="img" aria-label={LABEL[d.status]} title={LABEL[d.status]} />
                    <span className="device-name">
                      <span className="scan-target mono">{shortId(d.id)}</span>
                      {d.name && <small>{d.name}</small>}
                    </span>
                    <span className="result-service">{summary(d)}</span>
                    <span className="result-meta">{ago(d.last_seen)}</span>
                    {d.status === "pending" || d.status === "seen" ? (
                      <button type="button" className="btn primary small" onClick={(e) => {
                        e.preventDefault();
                        approve(d);
                      }}>Approve</button>
                    ) : <Icon name="chevron_right" className="result-go" />}
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

// DevicePage is one device: what it reported, where from, and which tunnels
// it may open.
export function DevicePage({ device, routes, onChanged }: { device: Device; routes: Route[]; onChanged: () => Promise<void> }) {
  const notify = useNotify();
  const approve = useApprove(routes, onChanged);
  const i = device.info ?? {};
  const gated = routes.filter((r) => r.require_device);

  const edit = async (patch: Parameters<typeof api.editDevice>[1]) => {
    try {
      await api.editDevice(device.id, patch);
      await onChanged();
    } catch (e) {
      notify(message(e), "bad");
    }
  };

  const forget = async () => {
    try {
      await api.forgetDevice(device.id);
      notify(`Forgot ${device.name || shortId(device.id)}`);
      await onChanged();
      go("#/devices");
    } catch (e) {
      notify(message(e), "bad");
    }
  };

  const hardware: [string, string | undefined][] = [
    ["Platform", [i.platform, i.mobile ? "mobile" : null].filter(Boolean).join(", ")],
    ["Graphics", i.webglRenderer || i.webglVendor],
    ["CPU threads", i.hardwareConcurrency?.toString()],
    ["Memory", i.deviceMemory ? `${i.deviceMemory} GB or more` : undefined],
    ["Screen", i.screen ? `${i.screen.width} x ${i.screen.height}, ${i.screen.pixelRatio}x` : undefined],
    ["Touch points", i.maxTouchPoints !== undefined ? String(i.maxTouchPoints) : undefined],
    ["Time zone", i.timezone],
    ["Languages", i.languages?.join(", ")],
    ["Browser", i.userAgent],
  ];
  const network: [string, string | undefined][] = [
    ["Last address", device.last_ip ? `${device.last_ip}${device.country ? ` (${device.country})` : ""}` : undefined],
    ["First address", device.first_ip ?? undefined],
    ["First asked for", device.first_host ?? undefined],
    ["First seen", new Date(device.created_at * 1000).toLocaleString()],
    ["Last seen", ago(device.last_seen)],
  ];

  return (
    <>
      <div className="page-head">
        <a className="icon-btn" href="#/devices" aria-label="All devices" title="All devices"><Icon name="arrow_back" /></a>
        <div className="page-head-main">
          <h1 className="mono"><Copy text={shortId(device.id)} copyText={device.id} plain /></h1>
          <div className="page-sub">
            <span className={"chip " + TONE[device.status]}>{LABEL[device.status]}</span>
            {device.name && <b>{device.name}</b>}
            <span>Seen {ago(device.last_seen)}</span>
          </div>
        </div>
        <div className="page-actions">
          {device.status !== "approved" && <button type="button" className="btn primary" onClick={() => approve(device)}><Icon name="check" size={18} />Approve</button>}
          {device.status !== "denied" && (
            <button type="button" className="btn" onClick={() => edit({ status: "denied" })}><Icon name="block" size={18} />{device.status === "approved" ? "Revoke" : "Deny"}</button>
          )}
          <ArmedButton icon="delete" label="Forget" armedLabel="Forget for good" onConfirm={forget} />
        </div>
      </div>
      <div className="page-body stack">
        {device.note && <Callout tone="warn" icon="warning">{device.note}. Compare the hardware below with what you expect before approving it again.</Callout>}

        <Card title="Device">
          <Row title="Name" sub="Something you'll recognise, such as Living room tablet.">
            <SaveField label="Name" width={240} placeholder="Unnamed" value={device.name} onSave={(name) => api.editDevice(device.id, { name }).then(onChanged)} />
          </Row>
        </Card>

        <Card title="Can open" sub={device.status === "approved" ? "Tunnels that need an approved device." : "Takes effect once the device is approved."}>
          <Row title="Every tunnel" sub="Including tunnels added later.">
            <Switch label="Every tunnel" on={device.all_routes} onChange={(v) => edit({ all_routes: v })} />
          </Row>
          {!device.all_routes && gated.map((r) => (
            <Row key={r.id} title={<span className="mono">{r.hostname}</span>}>
              <Switch label={`Allow ${r.hostname}`} on={device.route_ids.includes(r.id)}
                onChange={(v) => edit({ route_ids: v ? [...device.route_ids, r.id] : device.route_ids.filter((x) => x !== r.id) })} />
            </Row>
          ))}
          {!device.all_routes && gated.length === 0 && <p className="card-note muted">No tunnel needs an approved device yet.</p>}
        </Card>

        <Card title="Hardware" sub="What the browser reported. A change in platform, touch or graphics sends an approved device back to waiting.">
          <Facts rows={hardware} />
        </Card>
        <Card title="Network">
          <Facts rows={network} />
        </Card>
      </div>
    </>
  );
}

function Facts({ rows }: { rows: [string, string | undefined][] }) {
  return (
    <dl className="facts-list">
      {rows.filter(([, v]) => v).map(([k, v]) => (
        <div key={k} className="fact">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
