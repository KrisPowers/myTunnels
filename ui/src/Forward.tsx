import { useContext, useState, type FormEvent, type ReactNode } from "react";
import { NeedsContext } from "./Apps";
import { useCloudflare, useCloudflareReady } from "./Cloudflare";
import { api, message, type Forward, type Needs, type OAuthProvider, type Port, type Route, type Status, type User } from "./api";
import { Dropdown, type Option } from "./Dropdown";
import { Icon, type IconName } from "./Icon";
import { useCan } from "./me";
import { go } from "./route";
import { AccessChips, target, TunnelComposer, type Reach } from "./Tunnels";
import { Card, Dialog, MoreMenu, Row, Switch, TextField, useNotify, type MenuAction } from "./ui";

// The three ways a port is opened: a Cloudflare tunnel, the router, or Tailscale.
export type Method = "tunnel" | "port" | "tailscale";

const ICON: Record<Method, IconName> = { tunnel: "public", port: "router", tailscale: "lan" };
const LABEL: Record<Method, string> = { tunnel: "Tunnel", port: "Port forward", tailscale: "Tailscale" };

// Each way, with the ones whose app is not installed shown but not pickable.
// A tunnel picked before Cloudflare is connected asks to connect it.
function methods(needs: Needs | null, cloudflare: boolean): Option<Method>[] {
  const missing = (app: keyof Needs) => !!needs && !needs[app];
  return [
    { value: "tunnel", label: LABEL.tunnel, icon: ICON.tunnel, disabled: missing("cloudflared"),
      hint: missing("cloudflared") ? "Install cloudflared from Apps"
        : cloudflare ? "An address on your domain, with sign-in and passwords" : "Connect Cloudflare first" },
    { value: "port", label: LABEL.port, icon: ICON.port, hint: "Opens the port on this PC, and on the router when it lets it" },
    { value: "tailscale", label: LABEL.tailscale, icon: ICON.tailscale, disabled: missing("tailscale"),
      hint: missing("tailscale") ? "Install Tailscale from Apps" : "Your tailnet, or the internet through Funnel" },
  ];
}

const CLOSE_AFTER: Option<number>[] = [
  { value: 0, label: "Never" },
  { value: 3_600, label: "1 hour" },
  { value: 86_400, label: "1 day" },
  { value: 7 * 86_400, label: "7 days" },
];

// The ports Funnel opens to the internet, and so the ones a web app on
// Tailscale is offered.
const FUNNEL_PORTS = [443, 8443, 10000];

// A container, as a forward to it needs it.
export interface Target { name: string; reach: Reach[] }

// ForwardComposer opens a port by whichever way is picked in its first field:
// a tunnel, the router or Tailscale. For a container, the port is its own.
export function ForwardComposer({ users, providers, container, port, sub, onDone }: {
  users: User[];
  providers: OAuthProvider[];
  container?: Target;
  port?: string;
  sub?: string;
  // Given the new tunnel, or nothing for a router or Tailscale forward.
  onDone: (tunnel: Route | null) => Promise<void>;
}) {
  const needs = useContext(NeedsContext);
  const ready = useCloudflareReady();
  const cloudflare = useCloudflare();
  const options = methods(needs, ready);
  // A tunnel is the first choice only once Cloudflare is connected.
  const [method, setMethod] = useState<Method>(() => options.find((o) => !o.disabled && (ready || o.value !== "tunnel"))?.value ?? "port");
  const pick = (m: Method) => {
    if (m === "tunnel" && !cloudflare(() => setMethod("tunnel"))) return;
    setMethod(m);
  };
  const lead = (
    <div className="tf static method">
      <div className="tf-box">
        <Dropdown label="Forward by" value={method} options={options} onChange={pick} />
        <span className="tf-label">Forward by</span>
      </div>
    </div>
  );
  if (method === "tunnel") {
    return <TunnelComposer lead={lead} users={users} providers={providers} container={container} port={port} sub={sub} onPublished={(r) => onDone(r)} />;
  }
  return <OpenComposer key={method} method={method} lead={lead} container={container} port={port} onAdded={() => onDone(null)} />;
}

// OpenComposer opens a port at the router or on Tailscale: the port it is
// reached on, the app's port and how it speaks, where the app runs, then who
// reaches it and for how long.
function OpenComposer({ method, lead, container, port: startPort, onAdded }: {
  method: "port" | "tailscale";
  lead: ReactNode;
  container?: Target;
  port?: string;
  onAdded: () => Promise<void>;
}) {
  // Only a port the container publishes here can be reached from outside it.
  const published = (container?.reach ?? []).filter((r) => r.host === null);
  const [pick, setPick] = useState(0);
  const [port, setPort] = useState(/^\d{1,5}$/.test(startPort ?? "") ? startPort! : "");
  const [outside, setOutside] = useState("");
  const [webPort, setWebPort] = useState(443);
  const [protocol, setProtocol] = useState<Forward["protocol"]>(method === "port" ? "tcp" : "http");
  const [elsewhere, setElsewhere] = useState(false);
  const [host, setHost] = useState("");
  const [open, setOpen] = useState(false);
  const [closeIn, setCloseIn] = useState(0);
  const [name, setName] = useState(container?.name ?? "");
  const [busy, setBusy] = useState(false);
  const notify = useNotify();

  const fixed = container ? published[Math.min(pick, published.length - 1)] : undefined;
  const appPort = fixed ? fixed.port : Number(port);
  const web = method === "tailscale" && protocol !== "tcp";
  const publicPort = web ? webPort : Number(outside || appPort);
  const funnelOk = !open || web || FUNNEL_PORTS.includes(publicPort);
  const ready = appPort > 0 && publicPort > 0 && publicPort < 65536 && (!elsewhere || !!host.trim()) && (!container || !!fixed) && funnelOk;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    try {
      const f = await api.addForward({
        method, name: name.trim(), target_host: elsewhere ? host.trim() : null, target_port: appPort,
        protocol, public_port: publicPort, public: method === "tailscale" && open, expires_in: closeIn,
      });
      notify(`Forwarded port ${f.public_port}`);
      await onAdded();
    } catch (err) {
      notify(message(err), "bad");
      setBusy(false);
    }
  };

  const protocols: Option<Forward["protocol"]>[] = method === "port"
    ? [{ value: "tcp", label: "TCP" }, { value: "udp", label: "UDP" }, { value: "both", label: "TCP & UDP" }]
    : [{ value: "http", label: "http" }, { value: "https", label: "https", hint: "Self-signed certificates are fine" }, { value: "tcp", label: "TCP", hint: "Any other app, such as SSH or a game" }];

  return (
    <form className="stack" onSubmit={submit}>
      <div className="card composer">
        <div className="composer-row composer-lead">
          {lead}
          <TextField className="grow" label="Name" placeholder="Minecraft" autoComplete="off" value={name} onChange={(v) => setName(v.slice(0, 100))} />
        </div>
        <div className="composer-row">
          {web ? (
            <div className="tf static port">
              <div className="tf-box">
                <Dropdown label="Port" value={webPort} options={FUNNEL_PORTS.map((p) => ({ value: p, label: String(p) }))} onChange={setWebPort} />
                <span className="tf-label">Port</span>
              </div>
            </div>
          ) : (
            <TextField className="port" label="Port" placeholder={appPort ? String(appPort) : "25565"} mono inputMode="numeric"
              value={outside} onChange={(v) => setOutside(v.replace(/\D/g, "").slice(0, 5))} />
          )}
          <Icon name="arrow_forward" className="composer-arrow" />
          {container ? (
            published.length > 1 ? (
              <div className="tf static port">
                <div className="tf-box">
                  <Dropdown label="App port" value={pick} options={published.map((r, i) => ({ value: i, label: r.label }))} onChange={setPick} />
                  <span className="tf-label">App port</span>
                </div>
              </div>
            ) : fixed ? <span className="composer-fixed mono">{fixed.label}</span> : null
          ) : (
            <TextField className="port" label="App port" placeholder="8080" mono inputMode="numeric" value={port} onChange={(v) => setPort(v.replace(/\D/g, "").slice(0, 5))} />
          )}
          <div className="tf static protocol">
            <div className="tf-box">
              <Dropdown label="Protocol" value={protocol} options={protocols} onChange={setProtocol} />
              <span className="tf-label">Protocol</span>
            </div>
          </div>
          <button className="btn primary composer-go" disabled={busy || !ready}>
            {busy ? <span className="spinner small on-accent" /> : <Icon name="add" size={18} />}Forward
          </button>
        </div>
        {container && !published.length && <p className="empty-note">This container publishes no port on this computer, so nothing outside it can reach it.</p>}
      </div>

      {!container && (
        <Card title="Local app">
          <div className="card-pad">
            <div className="edit-row">
              <div className="tf static place">
                <div className="tf-box">
                  <Dropdown label="Runs on" value={elsewhere ? "machine" : "here"} onChange={(v) => setElsewhere(v === "machine")} options={[
                    { value: "here", label: "This computer", hint: "The app runs on the machine myTunnels runs on", icon: "devices" },
                    { value: "machine", label: "Another machine", hint: "A computer or device on your network", icon: "router" },
                  ]} />
                  <span className="tf-label">Runs on</span>
                </div>
              </div>
              {elsewhere && <TextField className="grow" mono autoComplete="off" label="IP address" placeholder="192.168.1.20" value={host} onChange={setHost} />}
            </div>
          </div>
        </Card>
      )}

      <Card title="Access Control">
        {method === "tailscale" ? (
          <Row title="Open to the internet" sub="Through Funnel. Off, only devices on your tailnet reach it.">
            <Switch label="Open to the internet" on={open} onChange={setOpen} />
          </Row>
        ) : (
          <Row title="Who reaches it" sub="Devices on your network, and anyone on the internet once the router forwards it too. Neither asks for a sign-in or password." />
        )}
        {!funnelOk && <p className="empty-note card-pad">Funnel opens only ports 443, 8443 and 10000.</p>}
        <Row title="Close after" sub="Closes on its own, and stays in the list switched off.">
          <Dropdown label="Close after" value={closeIn} options={CLOSE_AFTER} onChange={setCloseIn} />
        </Row>
      </Card>
    </form>
  );
}

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
  { value: "tunnel", label: "Tunnels" },
  { value: "port", label: "Port forwards" },
  { value: "tailscale", label: "Tailscale" },
];

// ForwardPage is every opening in one list: tunnels, router ports and
// Tailscale, with the plus to add one. `#/remote/new` opens it adding,
// `#/remote/new/<port>` to that port.
export function ForwardPage({ id, port, routes, forwards, status, users, providers, onChanged }: {
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
  const close = () => go("#/remote");

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
          <h1>Remote Access</h1>
          {routes && <div className="page-sub"><span><b>{live}</b> of {items.length} open{tunnels && status && !status.connections ? ", connector offline" : ""}</span></div>}
        </div>
        <div className="page-actions">
          <label className="ct-search">
            <Icon name="search" size={18} />
            <input type="search" placeholder="Search" aria-label="Search forwards" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
          </label>
          <div className="ex-pick"><Dropdown label="Show" value={show} options={SHOW} onChange={setShow} /></div>
          {can("tunnels.create") && <button type="button" className="icon-btn" aria-label="Forward a port" title="Forward a port" onClick={() => go("#/remote/new")}><Icon name="add" /></button>}
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
        <Dialog title="Forward a port" wide onClose={close}>
          <ForwardComposer users={users} providers={providers} port={port} onDone={async (r) => {
            await onChanged();
            go(r ? `#/tunnels/${r.id}` : "#/remote");
          }} />
        </Dialog>
      )}
    </>
  );
}
