import { useEffect, useState } from "react";
import { ago, api, message, shortId, type Device, type SignIn, type User } from "./api";
import { Icon } from "./Icon";
import { go } from "./route";
import { ArmedButton, Card, Copy, Row, SaveField, useNotify } from "./ui";

// Two lists: devices an account signs in from, and every other device met.
type Tab = "linked" | "other";
const TABS: [Tab, string][] = [
  ["linked", "Linked"],
  ["other", "Other"],
];

function summary(d: Device) {
  const i = d.info ?? {};
  return [i.platform, i.webglRenderer, d.country].filter(Boolean).join(", ") || "Unknown hardware";
}

// Devices is every browser met so far: the body of Security's Devices tab.
export function Devices({ devices, users }: { devices: Device[] | null; users: User[] | null }) {
  const all = devices ?? [];
  const linked = new Set((users ?? []).flatMap((u) => u.device_ids));
  const inTab = (tab: Tab, d: Device) => (tab === "linked") === linked.has(d.id);
  const count = (tab: Tab) => all.filter((d) => inTab(tab, d)).length;
  const [tab, setTab] = useState<Tab>("linked");
  const shown = all.filter((d) => inTab(tab, d));

  return (
    <>
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
            <h2>{tab === "linked" ? "No linked devices" : "No other devices"}</h2>
            {tab === "linked" && <p className="muted">A device shows up here once an account signs in from it.</p>}
          </div>
        )}
        {shown.length > 0 && (
          <div className="card">
            <ul className="results">
              {shown.map((d) => (
                <li key={d.id}>
                  <a className="result device-row" href={`#/devices/${d.id}`}>
                    <span className="device-name">
                      <span className="scan-target mono">{shortId(d.id)}</span>
                      {d.name && <small>{d.name}</small>}
                    </span>
                    <span className="result-service">{summary(d)}</span>
                    <span className="result-meta">{ago(d.last_seen)}</span>
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

// DevicePage is one device: what it reported, where from, and who signed in
// from it.
export function DevicePage({ device, users, onChanged }: { device: Device; users: User[]; onChanged: () => Promise<void> }) {
  const notify = useNotify();
  const i = device.info ?? {};

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
    ["First opened", device.first_host ?? undefined],
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
            {device.name && <b>{device.name}</b>}
            <span>Seen {ago(device.last_seen)}</span>
          </div>
        </div>
        <div className="page-actions">
          <ArmedButton icon="delete" label="Forget" armedLabel="Forget for good" onConfirm={forget} />
        </div>
      </div>
      <div className="page-body stack">
        <Card title="Device">
          <Row title="Name" sub="Something you'll recognise, such as Living room tablet.">
            <SaveField label="Name" width={240} placeholder="Unnamed" value={device.name} onSave={(name) => api.editDevice(device.id, { name }).then(onChanged)} />
          </Row>
        </Card>

        <Accounts device={device} users={users} />

        <Card title="Hardware" sub="What the browser reported when it last signed in.">
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

// Accounts are the people who signed in from this device lately.
function Accounts({ device, users }: { device: Device; users: User[] }) {
  const [list, setList] = useState<SignIn[] | null>(null);
  useEffect(() => {
    api.deviceActivity(device.id).then(setList).catch(() => setList([]));
  }, [device.id, device.last_seen]);
  const last = new Map<string, SignIn>();
  for (const s of list ?? []) if (s.outcome === "ok" && !last.has(s.user_id)) last.set(s.user_id, s);
  return (
    <Card title="Accounts" sub={last.size ? undefined : "No one has signed in from this device."}>
      {[...last].map(([id, s]) => {
        const u = users.find((x) => x.id === id);
        return (
          <Row key={id} title={<a href={`#/users/${id}`}>{u ? u.name || u.username : "Removed account"}</a>}
            sub={`${u?.email ?? ""}${u ? ", " : ""}last signed in ${ago(s.at)}${s.ip ? ` from ${s.ip}` : ""}`} />
        );
      })}
    </Card>
  );
}
