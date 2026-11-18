import { useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { NeedsApp, NeedsContext } from "./Apps";
import { api, bytes, message, type Container, type ContainerAction, type ContainerStats, type Deploy, type Forward, type Image, type Metrics, type OAuthProvider, type Route, type User } from "./api";
import { NewMenu, sourceOf } from "./Builds";
import { Dropdown, type Option } from "./Dropdown";
import { forwardsOf } from "./Forward";
import { Icon, type IconName } from "./Icon";
import { useImageRemoval } from "./Images";
import { useCan } from "./me";
import { NewRoute } from "./NewRoute";
import { go } from "./route";
import { target, tunnelsOf } from "./Tunnels";
import { Callout, MoreMenu, useNotify, type MenuAction } from "./ui";

// Services is everything this computer hosts, as one table: each container,
// with its status, where it is reached, and its CPU and memory; each app
// reached here outside a container, by its route. A Compose project folds
// under a row of its own. A row opens its page.

type Show = "all" | "running" | "stopped" | "containers" | "routes";
const SHOW: Option<Show>[] = [
  { value: "all", label: "All services" },
  { value: "running", label: "Running" },
  { value: "stopped", label: "Stopped" },
  { value: "containers", label: "Containers" },
  { value: "routes", label: "Routes" },
];

// Status, as a word and a tone, one place for every row.
const STATE: Record<string, [string, string]> = {
  running: ["Running", "ok"], live: ["Live", "ok"], open: ["Open", "ok"],
  paused: ["Paused", "warn"], restarting: ["Restarting", "warn"], building: ["Building", "warn"], created: ["Created", ""],
  exited: ["Stopped", ""], off: ["Off", ""], closed: ["Closed", ""],
  dead: ["Dead", "bad"], failed: ["Failed", "bad"],
};
const stateOf = (s: string): [string, string] => STATE[s] ?? [s.charAt(0).toUpperCase() + s.slice(1), ""];

const pct = (n: number) => `${n < 10 ? n.toFixed(1) : Math.round(n)}%`;
const short = (id: string) => id.slice(0, 12);

// The containers as last listed, by name, so one opens at once.
export const listed = new Map<string, Container>();

// One row of the table, whatever it is.
interface Row {
  key: string;
  name: string;
  group: string | null;
  icon: IconName;
  sub: string;
  state: string;
  up: boolean;
  addresses: { at: string; href?: string; on: boolean }[];
  href: string | null;
  stats?: ContainerStats;
  kind: "container" | "route";
  menu: MenuAction[];
}

export function Services({ adding, port, routes, forwards, users, providers, onChanged }: {
  adding: boolean;
  port: string;
  routes: Route[] | null;
  forwards: Forward[];
  users: User[];
  providers: OAuthProvider[];
  onChanged: () => Promise<void>;
}) {
  const can = useCan();
  const notify = useNotify();
  const needs = useContext(NeedsContext);
  const seeContainers = can("containers.view");
  const seeRoutes = can("tunnels.view");
  const [list, setList] = useState<Container[] | null>(null);
  const [deploys, setDeploys] = useState<Deploy[]>([]);
  const [images, setImages] = useState<Image[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [problem, setProblem] = useState("");
  const [q, setQ] = useState("");
  const [show, setShow] = useState<Show>("all");
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    if (!seeContainers) return;
    try {
      const [c, d, i] = await Promise.all([api.containers(), api.deploys(), api.images()]);
      listed.clear();
      for (const x of c) listed.set(x.name, x);
      setList(c);
      setDeploys(d);
      setImages(i);
      setProblem("");
    } catch (e) {
      setProblem(message(e));
    }
  }, [seeContainers]);
  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    if (!seeContainers) return;
    let alive = true;
    const run = () => api.metrics().then((m) => alive && setMetrics(m)).catch(() => {});
    run();
    const t = setInterval(run, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [seeContainers]);
  const cleanup = useImageRemoval(load);

  const act = async (key: string, work: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try {
      await work();
      notify(done);
    } catch (e) {
      notify(message(e), "bad");
    }
    setBusy("");
    await Promise.all([load(), onChanged()]);
  };

  const allRoutes = seeRoutes ? routes ?? [] : [];
  const allForwards = seeRoutes ? forwards : [];
  const stats = useMemo(() => new Map((metrics?.docker.containers ?? []).map((s) => [short(s.id), s])), [metrics]);
  const byDeploy = new Map(deploys.map((d) => [d.id, d]));
  const made = new Set((list ?? []).map((c) => c.name));
  // A container from a repository whose first build has not made it yet.
  const waiting: Container[] = deploys.filter((d) => !made.has(d.name)).map((d) => ({
    id: "", name: d.name, image: sourceOf(d), state: d.latest?.status === "failed" ? "failed" : "building", status: "",
    created: d.created_at, ports: [], project: null, service: null, deploy: d.id, own: false,
  }));

  const containerRow = (c: Container): Row => {
    const d = c.deploy ? byDeploy.get(c.deploy) : undefined;
    const tunnels = tunnelsOf(c, allRoutes);
    const opened = forwardsOf(c, allForwards);
    const on = c.state === "running";
    const manage = can("containers.manage") && !c.own && !!c.id;
    const doing = (action: ContainerAction, done: string) => () => act(c.name, () => api.containerAction(c.id, action), `${done} ${c.name}`);
    return {
      key: "c" + (c.id || c.name), name: c.name, group: c.project, kind: "container",
      icon: d ? (d.image ? "layers" : "git") : "deployed_code",
      sub: d ? `${sourceOf(d)}${d.branch ? `, ${d.branch}` : ""}` : c.image,
      state: c.state, up: on,
      addresses: [
        ...tunnels.map((r) => ({ at: r.hostname, href: `https://${r.hostname}`, on: r.enabled })),
        ...opened.filter((f) => f.address).map((f) => ({ at: f.address!, href: f.address!.startsWith("https://") ? f.address! : undefined, on: f.enabled && !f.problem })),
      ],
      href: `#/containers/${encodeURIComponent(c.name)}`,
      stats: c.id ? stats.get(short(c.id)) : undefined,
      menu: [
        ...(manage && !on ? [{ label: "Start", icon: "play_arrow" as IconName, onClick: doing("start", "Started") }] : []),
        ...(manage && on ? [{ label: "Restart", icon: "restart_alt" as IconName, onClick: doing("restart", "Restarted") }] : []),
        ...(manage && on ? [{ label: "Stop", icon: "stop" as IconName, onClick: doing("stop", "Stopped") }] : []),
        ...(c.id ? [{ label: "Logs", icon: "terminal" as IconName, onClick: () => go(`#/containers/${encodeURIComponent(c.name)}/logs`) }] : []),
        ...(can("containers.remove") && !c.own && !on ? [{
          label: "Delete", icon: "delete" as IconName, danger: true, confirm: "Delete for good",
          onClick: () => act(c.name, () => (d ? api.removeDeploy(d.id) : api.removeContainer(c.id)), `Deleted ${c.name}`),
        }] : []),
      ],
    };
  };

  // Routes to a container are on its row; the rest are services of their own.
  const theirs = new Set((list ?? []).flatMap((c) => [...tunnelsOf(c, allRoutes).map((r) => r.id), ...forwardsOf(c, allForwards).map((f) => f.id)]));
  const routeRows: Row[] = [
    ...allRoutes.filter((r) => !theirs.has(r.id)).map((r): Row => ({
      key: "r" + r.id, name: r.hostname, group: null, kind: "route", icon: "public", sub: `to ${target(r)}`,
      state: r.enabled ? "live" : "off", up: r.enabled,
      addresses: [{ at: r.hostname, href: `https://${r.hostname}`, on: r.enabled }],
      href: `#/tunnels/${r.id}`,
      menu: [
        { label: "Open", icon: "open_in_new", onClick: () => window.open(`https://${r.hostname}`, "_blank", "noreferrer") },
        ...(can("tunnels.delete") ? [{ label: "Remove", icon: "delete" as IconName, danger: true, confirm: "Remove for good", onClick: () => act("r" + r.id, () => api.removeRoute(r.id), `Removed ${r.hostname}`) }] : []),
      ],
    })),
    ...allForwards.filter((f) => !theirs.has(f.id)).map((f): Row => ({
      key: "f" + f.id, name: f.name || `Port ${f.public_port}`, group: null, kind: "route",
      icon: f.method === "tailscale" ? "lan" : "router",
      sub: `${f.method === "tailscale" ? "Tailscale" : "Router"} port ${f.public_port} to ${f.target_host ? `${f.target_host}:` : ""}${f.target_port}`,
      state: !f.enabled ? "closed" : f.problem ? "failed" : "open", up: f.enabled && !f.problem,
      addresses: f.address ? [{ at: f.address, href: f.address.startsWith("https://") ? f.address : undefined, on: f.enabled && !f.problem }] : [],
      href: null,
      menu: [
        ...(can("tunnels.edit") ? [f.enabled
          ? { label: "Close", icon: "block" as IconName, onClick: () => act("f" + f.id, () => api.editForward(f.id, { enabled: false }), `Closed port ${f.public_port}`) }
          : { label: "Open again", icon: "play_arrow" as IconName, onClick: () => act("f" + f.id, () => api.editForward(f.id, { enabled: true }), `Opened port ${f.public_port}`) }] : []),
        ...(can("tunnels.delete") ? [{ label: "Remove", icon: "delete" as IconName, danger: true, confirm: "Remove for good", onClick: () => act("f" + f.id, () => api.removeForward(f.id), `Removed port ${f.public_port}`) }] : []),
      ],
    })),
  ];
  const all: Row[] = [...[...(list ?? []), ...waiting].map(containerRow), ...routeRows];

  const needle = q.trim().toLowerCase();
  const shown = all
    .filter((r) => show === "all" || (show === "running" ? r.up : show === "stopped" ? !r.up : show === "containers" ? r.kind === "container" : r.kind === "route"))
    .filter((r) => !needle || [r.name, r.sub, r.group ?? "", ...r.addresses.map((a) => a.at)].some((v) => v.toLowerCase().includes(needle)))
    .sort((a, b) => (a.group ?? a.name).localeCompare(b.group ?? b.name) || a.name.localeCompare(b.name));
  const counts = new Map<string, number>();
  for (const r of shown) if (r.group) counts.set(r.group, (counts.get(r.group) ?? 0) + 1);

  const up = all.filter((r) => r.up).length;
  const running = (list ?? []).filter((c) => c.state === "running");
  const cpu = running.reduce((n, c) => n + (stats.get(short(c.id))?.cpu ?? 0), 0);
  const memory = running.reduce((n, c) => n + (stats.get(short(c.id))?.memory ?? 0), 0);
  const unused = images.filter((i) => !i.containers.length);
  const ready = !!list || !seeContainers || !!problem;
  const noDocker = !!needs && !needs.docker;

  const body: ReactNode[] = [];
  let group = "";
  for (const r of shown) {
    const grouped = !!r.group && (counts.get(r.group) ?? 0) > 1;
    if (grouped && r.group !== group) {
      const members = shown.filter((x) => x.group === r.group);
      const open = !folded.has(r.group!);
      body.push(
        <tr key={"g" + r.group} className="svc-group" onClick={() => setFolded((f) => {
          const next = new Set(f);
          if (next.has(r.group!)) next.delete(r.group!);
          else next.add(r.group!);
          return next;
        })}>
          <td colSpan={6}>
            <span className="svc-group-name">
              <Icon name="chevron_right" size={18} className={open ? "open" : ""} />
              <b>{r.group}</b>
              <small>{members.filter((x) => x.up).length} of {members.length} running</small>
            </span>
          </td>
        </tr>,
      );
    }
    group = grouped ? r.group! : "";
    if (grouped && folded.has(r.group!)) continue;
    body.push(<ServiceRow key={r.key} row={r} inGroup={grouped} busy={busy === r.name || busy === r.key} />);
  }

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Services</h1>
          {ready && (
            <div className="page-sub">
              <span><b>{up}</b> of {all.length} running</span>
              {running.length > 0 && metrics && <span>CPU <b>{pct(cpu)}</b></span>}
              {running.length > 0 && metrics && <span>Memory <b>{bytes(memory)}</b></span>}
            </div>
          )}
        </div>
        <div className="page-actions">
          <label className="ct-search">
            <Icon name="search" size={18} />
            <input type="search" placeholder="Search" aria-label="Search services" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
          </label>
          <div className="ex-pick"><Dropdown label="Show" value={show} options={SHOW} onChange={setShow} /></div>
          <NewMenu />
          {can("containers.remove") && unused.length > 0 && (cleanup.busy ? <span className="spinner small" /> : (
            <MoreMenu label="More" actions={[{ label: `Delete unused images, ${bytes(unused.reduce((n, i) => n + i.size, 0))}`, icon: "layers", danger: true, confirm: `Delete ${unused.length} for good`, onClick: () => cleanup.remove(unused) }]} />
          ))}
        </div>
      </div>

      <div className="page-body stack">
        {seeContainers && <NeedsApp app="docker" what="Running containers" />}
        {problem && !noDocker && <Callout tone="bad" icon="error">Docker is not reachable: {problem}</Callout>}
        {!ready ? <div className="repo-loading"><span className="spinner" /></div> : all.length === 0 ? (
          <div className="welcome">
            <Icon name="deployed_code" size={48} />
            <div className="welcome-actions"><NewMenu /></div>
          </div>
        ) : (
          <div className="card svc-card">
            <div className="table-wrap">
              <table className="table svc">
                <thead>
                  <tr><th className="grow">Name</th><th>Status</th><th>Address</th><th className="svc-num">CPU</th><th className="svc-num">Memory</th><th /></tr>
                </thead>
                <tbody>
                  {body}
                  {body.length === 0 && <tr><td colSpan={6} className="svc-none">Nothing matches.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {adding && can("tunnels.create") && (
        <NewRoute users={users} providers={providers} port={port} onClose={() => go("#/services")} onDone={async (r) => {
          await onChanged();
          go(r ? `#/tunnels/${r.id}` : "#/services");
        }} />
      )}
    </>
  );
}

function ServiceRow({ row: r, inGroup, busy }: { row: Row; inGroup: boolean; busy: boolean }) {
  const [label, tone] = stateOf(r.state);
  const first = r.addresses[0];
  const s = r.up ? r.stats : undefined;
  return (
    <tr className={(r.href ? "svc-link" : "") + (r.up ? "" : " svc-down")} onClick={() => r.href && go(r.href)}>
      <td>
        <span className={"svc-name" + (inGroup ? " in-group" : "")}>
          <span className={"svc-icon " + tone}><Icon name={r.icon} size={18} /></span>
          <span className="svc-text"><b>{r.name}</b><small>{r.sub}</small></span>
        </span>
      </td>
      <td><span className={"chip " + tone}><span className={"dot " + tone} />{label}</span></td>
      <td>
        {first && (
          <span className="svc-address">
            {first.href
              ? <a href={first.href} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{first.at}</a>
              : <span className="mono">{first.at}</span>}
            {r.addresses.length > 1 && <small>+{r.addresses.length - 1}</small>}
          </span>
        )}
      </td>
      <td className="svc-num">{s ? pct(s.cpu) : ""}</td>
      <td className="svc-num">{s ? bytes(s.memory) : ""}</td>
      <td className="svc-menu" onClick={(e) => e.stopPropagation()}>
        {busy ? <span className="spinner small" /> : r.menu.length > 0 && <MoreMenu label={`Actions for ${r.name}`} actions={r.menu} />}
      </td>
    </tr>
  );
}
