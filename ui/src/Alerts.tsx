import { createPortal } from "react-dom";
import { ago, api, message, shortId, type Device, type Flag, type Hardware, type Health, type Route, type Status, type User } from "./api";
import { Icon, type IconName } from "./Icon";
import { useCan, useMe } from "./me";
import { useNotify, usePopover } from "./ui";

// Alerts is the bell in the header: everything that needs attention, in one
// dropdown, the count on the bell. Failing parts and the system log's notes,
// the sensor task's setup, new devices signing in, and the connector when
// tunnels cannot be reached. Pages carry no status messages of their own.

export interface Alert {
  key: string;
  tone: Health | "info";
  icon: IconName;
  title: string;
  sub?: string;
  href?: string;
  action?: { label: string; run: () => Promise<unknown> };
}

const failing = (h?: Health) => h === "warn" || h === "bad";

// What the sensor task's setup says while it is not simply running.
function sensorAlert(hw: Hardware | null): Alert | null {
  const s = hw?.snapshot;
  if (!s) return null;
  const why = s.helper_error ? ` ${s.helper_error}` : "";
  switch (s.helper) {
    case "waiting": return { key: "sensors", tone: "info", icon: "shield", title: "Waiting for the Windows prompt", sub: "Approve it on this computer's screen to read the sensors." };
    case "installing": return { key: "sensors", tone: "info", icon: "shield", title: `${s.helper_step || "Setting up the sensors"} · ${s.helper_percent ?? 0}%` };
    case "starting": return { key: "sensors", tone: "info", icon: "shield", title: "Starting the sensor task", sub: `First readings within a minute.${why}` };
    case "missing": return { key: "sensors", tone: "warn", icon: "warning", title: "The sensor task is not installed", sub: `Turn Advanced off and on again on Dashboard.${why}` };
    case "stale": return { key: "sensors", tone: "bad", icon: "error", title: "The sensors stopped reporting", sub: `Windows starts the task again within a minute.${why}` };
    default: return null;
  }
}

export function useAlerts({ hw, flags, users, devices, status, routes, onChanged, onHardware }: {
  hw: Hardware | null;
  flags: Flag[];
  users: User[];
  devices: Device[];
  status: Status | null;
  routes: Route[] | null;
  onChanged: () => Promise<void>;
  onHardware: (h: Hardware) => void;
}): Alert[] {
  const can = useCan();
  const me = useMe();
  const admin = me.admin || me.host;
  const snap = hw?.snapshot;
  const sensors = sensorAlert(hw);
  const offline = !!status?.configured && (routes ?? []).some((r) => r.enabled) && !status.connections;
  return [
    ...(offline ? [{ key: "connector", tone: "bad" as Health, icon: "cloud" as IconName, title: "Cloudflare connector offline", sub: "Published addresses cannot be reached.", href: "#/settings/connections" }] : []),
    ...[...(snap?.parts ?? []), ...(snap?.notes ?? [])].filter((p) => failing(p.health)).map((p): Alert => {
      const note = p.id.startsWith("note:");
      const taken = p.kind === "memory" && p.health === "bad" && !p.bytes && !!p.place;
      return {
        key: p.id, tone: p.health, icon: p.health === "bad" ? "error" : "warning",
        title: note ? p.name : p.reason || p.name, sub: note ? undefined : p.name, href: "#/dashboard",
        action: admin && note ? { label: "Dismiss", run: () => api.dismissNote(p.id).then(onHardware) }
          : admin && taken ? { label: "Taken out", run: () => api.forgetSlot(p.place).then(onHardware) } : undefined,
      };
    }),
    ...(sensors ? [sensors] : []),
    ...flags.map((f): Alert => {
      const u = users.find((x) => x.id === f.user_id);
      const d = devices.find((x) => x.id === f.device_id);
      return {
        key: "flag" + f.id, tone: "warn", icon: "devices",
        title: `New device for ${u ? u.name || u.username : "a removed account"}`,
        sub: [d?.name || (f.device_id ? shortId(f.device_id) : ""), [f.ip, f.country].filter(Boolean).join(", "), ago(f.at)].filter(Boolean).join(" · "),
        href: f.device_id ? `#/devices/${f.device_id}` : `#/users/${f.user_id}`,
        action: can("users.manage") ? { label: "Dismiss", run: () => api.clearFlag(f.id).then(onChanged) } : undefined,
      };
    }),
  ];
}

export function Alerts({ alerts }: { alerts: Alert[] }) {
  const pop = usePopover(360);
  const notify = useNotify();
  const urgent = alerts.filter((a) => a.tone !== "info").length;
  const tone = alerts.some((a) => a.tone === "bad") ? "bad" : urgent ? "warn" : "";
  const run = async (a: Alert) => {
    try {
      await a.action!.run();
    } catch (e) {
      notify(message(e), "bad");
    }
  };
  return (
    <div className="menu-wrap" ref={pop.anchor}>
      <button type="button" className="icon-btn alerts-btn" aria-label={urgent ? `${urgent} alerts` : "Alerts"} title="Alerts" aria-expanded={pop.open}
        onClick={() => pop.setOpen((o) => !o)}>
        <Icon name="bell" />
        {urgent > 0 && <span className={"alerts-count " + tone}>{urgent}</span>}
      </button>
      {pop.open && createPortal(
        <div ref={pop.panel} className="menu pop-menu alerts" style={pop.style} role="dialog" aria-label="Alerts">
          <div className="alerts-head">Alerts{urgent > 0 && <span>{urgent}</span>}</div>
          {alerts.length === 0 ? (
            <div className="alerts-none"><Icon name="check_circle" size={20} />Nothing needs attention</div>
          ) : (
            <ul className="alerts-list">
              {alerts.map((a) => (
                <li key={a.key} className={"alert " + a.tone}>
                  <span className="alert-icon"><Icon name={a.icon} size={18} /></span>
                  {a.href
                    ? <a className="alert-text" href={a.href} onClick={pop.close}><b>{a.title}</b>{a.sub && <small>{a.sub}</small>}</a>
                    : <span className="alert-text"><b>{a.title}</b>{a.sub && <small>{a.sub}</small>}</span>}
                  {a.action && <button type="button" className="btn small" onClick={() => run(a)}>{a.action.label}</button>}
                </li>
              ))}
            </ul>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
