import { useState } from "react";
import { api, message, type Forward, type OAuthProvider, type Port, type Route, type Status, type User } from "./api";
import { Dropdown, type Option } from "./Dropdown";
import { Icon, type IconName } from "./Icon";
import { useCan } from "./me";
import { go } from "./route";
import { NewRoute } from "./NewRoute";
import { AccessChips, target } from "./Tunnels";
import { MoreMenu, useNotify, type MenuAction } from "./ui";

// The three ways a port is opened: a Cloudflare tunnel, the router, or Tailscale.
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

const labelOf = (o: Opening) => ("r" in o ? o.r.hostname : titleOf(o.f));
const liveOf = (o: Opening) => ("r" in o ? o.r.enabled : o.f.enabled && !o.f.problem);

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
      {sorted.map((o) => "r" in o
        ? <TunnelRow key={o.r.id} r={o.r} href={hrefOf(o.r)} on={o.r.id === picked} onChanged={onChanged} />
        : <ForwardRow key={o.f.id} f={o.f} onChanged={onChanged} />)}
    </ul>
  );
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

// ---- the page ----

type Show = "all" | Method;

const SHOW: Option<Show>[] = [
  { value: "all", label: "All" },
  { value: "port", label: "Port forwards" },
  { value: "tailscale", label: "Tailscale" },
  { value: "tunnel", label: "Tunnels" },
];

// ForwardPage is every opening in one list: tunnels, router ports and
// Tailscale, with the plus to add one. `#/routes/new` opens it adding,
// `#/routes/new/<port>` to that port.
export function ForwardPage({ id, port, routes, forwards, status, providers, onChanged }: {
  id: string;
  port: string;
  routes: Route[] | null;
  forwards: Forward[] | null;
  status: Status | null;
  users: User[];
  providers: OAuthProvider[];
  onChanged: () => Promise<void>;
}) {
  const can = useCan();
  const [q, setQ] = useState("");
  const [show, setShow] = useState<Show>("all");
  const adding = id === "new" && can("tunnels.create");
  const close = () => go("#/routes");

  const items: Opening[] = [
    ...(routes ?? []).map((r) => ({ r })),
    ...(forwards ?? []).map((f) => ({ f })),
  ];
  const needle = q.trim().toLowerCase();
  const shown = items
    .filter((o) => show === "all" || ("r" in o ? show === "tunnel" : o.f.method === show))
    .filter((o) => !needle || [labelOf(o), "r" in o ? target(o.r) : `${o.f.address ?? ""} ${where(o.f)}`].some((v) => v.toLowerCase().includes(needle)));
  const live = items.filter(liveOf).length;
  const tunnels = (routes ?? []).length > 0;

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Routes</h1>
          {routes && <div className="page-sub"><span><b>{live}</b> of {items.length} open{tunnels && status && !status.connections ? ", connector offline" : ""}</span></div>}
        </div>
        <div className="page-actions">
          <label className="ct-search">
            <Icon name="search" size={18} />
            <input type="search" placeholder="Search" aria-label="Search forwards" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
          </label>
          <div className="ex-pick"><Dropdown label="Show" value={show} options={SHOW} onChange={setShow} /></div>
          {can("tunnels.create") && <button type="button" className="icon-btn" aria-label="New route" title="New route" onClick={() => go("#/routes/new")}><Icon name="add" /></button>}
        </div>
      </div>
      <div className="page-body stack">
        {routes && (items.length === 0 ? (
          <div className="card welcome">
            <Icon name="swap_horiz" size={40} />
            <h2>Nothing forwarded yet</h2>
            <p className="muted">Open a port with the plus, through a tunnel, the router or Tailscale.</p>
          </div>
        ) : (
          <div className="card">
            <ForwardRows items={shown} hrefOf={(r) => `#/tunnels/${r.id}`} onChanged={onChanged} />
            {shown.length === 0 && <p className="empty-note ct-none">Nothing matches.</p>}
          </div>
        ))}
      </div>
      {adding && (
        <NewRoute providers={providers} port={port} onClose={close} onDone={async (r) => {
          await onChanged();
          go(r ? `#/tunnels/${r.id}` : "#/routes");
        }} />
      )}
    </>
  );
}
