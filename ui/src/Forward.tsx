import { useState } from "react";
import { api, message, type Forward, type Port, type Route } from "./api";
import { Icon, type IconName } from "./Icon";
import { useCan } from "./me";
import { AccessChips, target } from "./Tunnels";
import { MoreMenu, useNotify, type MenuAction } from "./ui";

// The three ways a service is reached: a Cloudflare tunnel, the router, or
// Tailscale. Each is a row on Services, alone for a port on this computer, or
// on its container's Routes.
export type Method = "tunnel" | "port" | "tailscale";

const ICON: Record<Method, IconName> = { tunnel: "public", port: "router", tailscale: "lan" };
const LABEL: Record<Method, string> = { tunnel: "Tunnel", port: "Port forward", tailscale: "Tailscale" };

// ---- the list ----

// One opening: a tunnel, or a port opened by the router or Tailscale.
export type Opening = { r: Route } | { f: Forward };

const where = (f: Forward) => (f.target_host ? `${f.target_host}:${f.target_port}` : String(f.target_port));

// A forward goes by its name, or its port when it has none.
function titleOf(f: Forward) {
  return f.name || `Port ${f.public_port}`;
}

export const labelOf = (o: Opening) => ("r" in o ? o.r.hostname : titleOf(o.f));
export const liveOf = (o: Opening) => ("r" in o ? o.r.enabled : o.f.enabled && !o.f.problem);
// What it goes to, for search.
export const toOf = (o: Opening) => ("r" in o ? target(o.r) : `${o.f.address ?? ""} ${where(o.f)}`);

// How long until it closes on its own, in a word or two.
function closesIn(at: number) {
  const left = at - Date.now() / 1000;
  if (left < 3600) return `${Math.max(1, Math.ceil(left / 60))} min`;
  if (left < 86_400) return `${Math.round(left / 3600)} h`;
  return `${Math.round(left / 86_400)} d`;
}

// The ports a container publishes here that a router or Tailscale forward
// goes to.
export function forwardsOf(c: { ports: Port[] }, forwards: Forward[]) {
  return forwards.filter((f) => !f.target_host && c.ports.some((p) => p.public === f.target_port && (f.method === "tailscale" || f.protocol === "both" || p.type === f.protocol)));
}

// ForwardRows is a row per opening: what it is in a tile tinted by its state,
// its address over where it goes, who reaches it, and one menu. A tunnel's row
// opens it at `hrefOf`.
export function ForwardRows({ items, hrefOf, picked, onChanged }: {
  items: Opening[];
  hrefOf: (r: Route) => string;
  picked?: string;
  onChanged: () => Promise<void>;
}) {
  const sorted = [...items].sort((a, b) => labelOf(a).localeCompare(labelOf(b)));
  return (
    <ul className="results ct-list">
      {sorted.map((o) => <OpeningRow key={"r" in o ? o.r.id : o.f.id} o={o} href={"r" in o ? hrefOf(o.r) : ""} on={"r" in o && o.r.id === picked} onChanged={onChanged} />)}
    </ul>
  );
}

// OpeningRow is one way in as a row; a tunnel's opens at `href`.
export function OpeningRow({ o, href, on, onChanged }: { o: Opening; href: string; on?: boolean; onChanged: () => Promise<void> }) {
  return "r" in o ? <TunnelRow r={o.r} href={href} on={!!on} onChanged={onChanged} /> : <ForwardRow f={o.f} onChanged={onChanged} />;
}

function TunnelRow({ r, href, on, onChanged }: { r: Route; href: string; on: boolean; onChanged: () => Promise<void> }) {
  const can = useCan();
  const notify = useNotify();
  const remove = async () => {
    try {
      await api.removeRoute(r.id);
      notify(`Removed ${r.hostname}`);
      await onChanged();
    } catch (e) {
      notify(message(e), "bad");
    }
  };
  return (
    <li className={"ct-row" + (on ? " on" : "")}>
      <a className="ct-row-main" href={href} aria-current={on ? "true" : undefined}>
        <span className={"ct-kind " + (r.enabled ? "ok" : "")} title={LABEL.tunnel}><Icon name={ICON.tunnel} /></span>
        <span className="ct-name-text">
          <b>{r.hostname}</b>
          <small className="mono">to {target(r)}</small>
        </span>
        <span className="ct-reach"><AccessChips route={r} /></span>
        <span className="ct-use muted">{r.enabled ? "Live" : "Off"}</span>
      </a>
      <span className="ct-menu">
        <MoreMenu label={`Actions for ${r.hostname}`} actions={[
          { label: "Open", icon: "open_in_new", onClick: () => window.open(`https://${r.hostname}`, "_blank", "noreferrer") },
          ...(can("tunnels.delete") ? [{ label: "Remove", icon: "delete" as IconName, danger: true, onClick: remove, confirm: "Remove for good" }] : []),
        ]} />
      </span>
    </li>
  );
}

function ForwardRow({ f, onChanged }: { f: Forward; onChanged: () => Promise<void> }) {
  const can = useCan();
  const notify = useNotify();
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await work();
      notify(done);
      await onChanged();
    } catch (e) {
      notify(message(e), "bad");
    } finally {
      setBusy(false);
    }
  };
  const title = titleOf(f);
  const edit = can("tunnels.edit");
  const actions: MenuAction[] = [
    ...(f.address?.startsWith("https://") && f.enabled ? [{ label: "Open", icon: "open_in_new" as IconName, onClick: () => window.open(f.address!, "_blank", "noreferrer") }] : []),
    ...(edit ? [f.enabled
      ? { label: "Close", icon: "block" as IconName, onClick: () => run(() => api.editForward(f.id, { enabled: false }), `Closed port ${f.public_port}`) }
      : { label: "Open again", icon: "play_arrow" as IconName, onClick: () => run(() => api.editForward(f.id, { enabled: true }), `Opened port ${f.public_port}`) }] : []),
    ...(edit && f.method === "tailscale" ? [f.public
      ? { label: "Tailnet only", icon: "lan" as IconName, onClick: () => run(() => api.editForward(f.id, { public: false }), "Only the tailnet reaches it now") }
      : { label: "Open to the internet", icon: "public" as IconName, onClick: () => run(() => api.editForward(f.id, { public: true }), "Open to the internet through Funnel") }] : []),
    ...(can("tunnels.delete") ? [{ label: "Remove", icon: "delete" as IconName, danger: true, confirm: "Remove for good",
      onClick: () => run(() => api.removeForward(f.id), `Removed port ${f.public_port}`) }] : []),
  ];
  const tone = !f.enabled ? "" : f.problem ? "bad" : "ok";
  // TCP is said only where it is not the plain choice.
  const speaks = f.protocol === "both" ? ", TCP & UDP" : f.protocol === "udp" || (f.method === "tailscale" && f.protocol === "tcp") ? `, ${f.protocol.toUpperCase()}` : "";
  return (
    <li className="ct-row">
      <div className="ct-row-main">
        <span className={"ct-kind " + tone} title={LABEL[f.method]}><Icon name={ICON[f.method]} /></span>
        <span className="ct-name-text">
          <b>{title}</b>
          {f.problem && f.enabled
            ? <small className="fw-problem" title={f.problem}>{f.problem}</small>
            : <small className="mono">{f.address ? `${f.address} ` : ""}to {where(f)}{speaks}</small>}
        </span>
        <span className="ct-reach">
          <span className="access">
            <span className="chip">{f.method === "tailscale" ? (f.public ? "Internet" : "Tailnet") : f.router ? "Internet" : "This network"}</span>
            {f.enabled && f.method === "port" && !f.router && f.router_problem && <span className="chip warn" title={f.router_problem}>Router not forwarded</span>}
            {f.enabled && f.expires_at > 0 && <span className="chip warn">Closes in {closesIn(f.expires_at)}</span>}
          </span>
        </span>
        <span className="ct-use muted">{!f.enabled ? "Off" : f.problem ? "Failed" : "Live"}</span>
      </div>
      <span className="ct-menu">{busy ? <span className="spinner small" /> : actions.length > 0 && <MoreMenu label={`Actions for ${title}`} actions={actions} />}</span>
    </li>
  );
}
