import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, bytes, message, type Container, type ContainerAction, type ContainerDetail, type ContainerStats, type Deploy, type Device, type Image, type Metrics, type OAuthProvider, type Port, type Route, type Status, type User } from "./api";
import { AddContainer, BuildLog, Builds, DeploySettings, sourceOf, waiting } from "./Builds";
import { Chart, Meter } from "./Dashboard";
import { Dropdown } from "./Dropdown";
import { Icon, type IconName } from "./Icon";
import { ContainerImages, ImageView, useImageRemoval } from "./Images";
import { useCan } from "./me";
import { go } from "./route";
import { AccessChips, reachOf, target, TunnelComposer, TunnelPanel, tunnelsOf } from "./Tunnels";
import { Callout, Copy, MoreMenu, SubNav, Switch, useNotify, type MenuAction } from "./ui";

type Act = ContainerAction | "remove";

// What an action runs on: a container, or one built from a repository, whose
// removal takes its builds too.
type Target = { id: string; name: string; deploy?: string | null };

const DONE: Record<Act, string> = {
  start: "Started", stop: "Stopped", restart: "Restarted", pause: "Paused", unpause: "Resumed", kill: "Killed", remove: "Deleted",
};

const shortId = (id: string) => id.slice(0, 12);
const pct = (n: number) => `${n < 10 ? n.toFixed(2) : n.toFixed(1)}%`;
const rate = (n: number) => `${bytes(n)}/s`;
const live = (c: { state: string }) => c.state === "running";
// A container's page goes by its name, which stays when it is made again.
const pageOf = (name: string) => `#/containers/${encodeURIComponent(name)}`;

function tone(state: string) {
  return state === "running" ? "ok" : state === "paused" || state === "restarting" || state === "building" ? "warn" : state === "dead" || state === "failed" ? "bad" : "";
}

// Metrics keeps each running container's usage; this polls it with the list.
function useMetrics() {
  const [m, setM] = useState<Metrics | null>(null);
  useEffect(() => {
    let alive = true;
    let timer = 0;
    const load = async () => {
      try {
        const next = await api.metrics();
        if (alive) setM(next);
        timer = window.setTimeout(load, (next.every || 2) * 1000);
      } catch {
        timer = window.setTimeout(load, 5000);
      }
    };
    load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);
  return m;
}

// Runs an action on one or more containers, says how it went, then reloads.
function useActions(reload: () => Promise<void>) {
  const notify = useNotify();
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const run = async (targets: Target[], action: Act) => {
    setBusy(new Set(targets.map((t) => t.id)));
    const failed: string[] = [];
    for (const t of targets) {
      try {
        if (action === "remove" && t.deploy) await api.removeDeploy(t.deploy);
        else if (action === "remove") await api.removeContainer(t.id);
        else await api.containerAction(t.id, action);
      } catch (e) {
        failed.push(`${t.name}: ${message(e)}`);
      }
    }
    setBusy(new Set());
    if (failed.length) notify(failed.join("; "), "bad");
    else notify(targets.length === 1 ? `${DONE[action]} ${targets[0].name}` : `${DONE[action]} ${targets.length} containers`);
    await reload();
  };
  return { busy, run };
}

// PortLinks are the ports published on the host, each opening in a new tab.
function PortLinks({ ports, max = 3 }: { ports: Port[]; max?: number }) {
  const shown = ports.filter((p) => p.public !== null);
  if (!shown.length) return <span className="muted">None</span>;
  return (
    <span className="port-links">
      {shown.slice(0, max).map((p) => (
        <a key={`${p.public}-${p.private}-${p.type}`} href={`http://${location.hostname}:${p.public}`} target="_blank" rel="noreferrer"
          title={`Host port ${p.public} to container port ${p.private}/${p.type}`} onClick={(e) => e.stopPropagation()}>
          {p.public}:{p.private}{p.type === "udp" ? "/udp" : ""}<Icon name="open_in_new" size={12} />
        </a>
      ))}
      {shown.length > max && <span className="muted">+{shown.length - max}</span>}
    </span>
  );
}

// A container from a repository that is not made yet: its first build is
// waiting, running or failed.
function pending(d: Deploy): Container {
  const failed = d.latest?.status === "failed";
  return {
    id: "", name: d.name, image: sourceOf(d), state: failed ? "failed" : "building", status: failed ? "Build failed" : "Building",
    created: d.created_at, ports: [], project: null, service: null, deploy: d.id, own: false,
  };
}

// What a container's page and its tunnel need from the dashboard.
export interface Shared {
  routes: Route[] | null;
  devices: Device[];
  users: User[];
  providers: OAuthProvider[];
  onChanged: () => Promise<void>;
}

export function ContainersPage({ id, page, more, status, ...shared }: { id: string; page: string; more: string[]; status: Status | null } & Shared) {
  if (id) return <ContainerPage name={id} tab={page} more={more} {...shared} />;
  return <ContainerList routes={shared.routes} status={status} />;
}

// ---- the list ----

// The containers as last listed, by name, so one opens at once with what the
// list knew while its full details load.
const listed = new Map<string, Container>();

type Show = "all" | "running";

// ContainerList is a row per container: its state, name and image, published
// ports, the tunnels reaching it, CPU, memory and how long it has run,
// everything else behind its menu. Compose projects of two or more fold under
// their name. Tunnels to anything else are listed beneath.
function ContainerList({ routes, status }: { routes: Route[] | null; status: Status | null }) {
  const can = useCan();
  const seeContainers = can("containers.view");
  const seeTunnels = can("tunnels.view");
  const [list, setList] = useState<Container[] | null>(null);
  const [images, setImages] = useState<Image[] | null>(null);
  const [deploys, setDeploys] = useState<Deploy[]>([]);
  const [adding, setAdding] = useState(false);
  const [problem, setProblem] = useState("");
  const [q, setQ] = useState("");
  const [show, setShow] = useState<Show>("all");
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const m = useMetrics();

  const load = useCallback(async () => {
    if (!seeContainers) return;
    try {
      const [next, imgs, deps] = await Promise.all([api.containers(), api.images(), api.deploys()]);
      listed.clear();
      for (const c of next) listed.set(c.name, c);
      setList(next);
      setImages(imgs);
      setDeploys(deps);
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
  const { busy, run } = useActions(load);
  const cleanup = useImageRemoval(load);
  const allRoutes = seeTunnels ? routes ?? [] : [];
  const reaching = (c: Container) => tunnelsOf(c, allRoutes);
  const matched = new Set((list ?? []).flatMap((c) => reaching(c).map((r) => r.id)));
  const others = allRoutes.filter((r) => !matched.has(r.id));
  const liveTunnels = allRoutes.filter((r) => r.enabled).length;
  const links = status?.connections ?? 0;
  const unused = (images ?? []).filter((i) => !i.containers.length);
  const spare = unused.reduce((n, i) => n + i.size, 0);

  // Usage is sampled under each container's short ID.
  const stats = useMemo(() => Object.fromEntries((m?.docker.containers ?? []).map((s) => [shortId(s.id), s])), [m]);
  const needle = q.trim().toLowerCase();
  const made = new Set((list ?? []).map((c) => c.name));
  const all = [...(list ?? []), ...deploys.filter((d) => !made.has(d.name)).map(pending)];
  const shown = all.filter((c) => (show === "all" || live(c)) && (!needle || [c.name, c.image, c.id, c.project ?? ""].some((v) => v.toLowerCase().includes(needle))));
  const sorted = [...shown].sort((a, b) => (a.project ?? a.name).localeCompare(b.project ?? b.name) || a.name.localeCompare(b.name));
  const counts = new Map<string, number>();
  for (const c of sorted) if (c.project) counts.set(c.project, (counts.get(c.project) ?? 0) + 1);
  const rows: ({ group: string; items: Container[] } | Container)[] = [];
  for (const c of sorted) {
    if (c.project && (counts.get(c.project) ?? 0) > 1) {
      const last = rows[rows.length - 1];
      if (last && "group" in last && last.group === c.project) last.items.push(c);
      else rows.push({ group: c.project, items: [c] });
    } else {
      rows.push(c);
    }
  }

  const running = (list ?? []).filter(live);
  const cpu = running.reduce((n, c) => n + (stats[shortId(c.id)]?.cpu ?? 0), 0);
  const memory = running.reduce((n, c) => n + (stats[shortId(c.id)]?.memory ?? 0), 0);
  const pageMenu: MenuAction[] = can("containers.remove") && unused.length > 0
    ? [{ label: `Delete unused images, ${bytes(spare)}`, icon: "layers", danger: true, onClick: () => cleanup.remove(unused), confirm: `Delete ${unused.length} for good` }]
    : [];

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Containers</h1>
          <div className="page-sub">
            {list && <span><b>{running.length}</b> of {list.length} running</span>}
            {list && m && <span>CPU <b>{pct(cpu)}</b> of {m.host.threads * 100}%</span>}
            {list && m && <span>Memory <b>{bytes(memory)}</b> of {bytes(m.memory_total)}</span>}
            {seeTunnels && <span><b>{liveTunnels}</b> tunnel{liveTunnels === 1 ? "" : "s"} live, {links > 0 ? "connector online" : status?.running ? "connector starting" : "connector offline"}</span>}
          </div>
        </div>
        <div className="page-actions">
          <label className="ct-search">
            <Icon name="search" size={18} />
            <input type="search" placeholder="Search" aria-label="Search containers" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
          </label>
          <div className="seg-tabs" role="tablist" aria-label="Show">
            {(["all", "running"] as Show[]).map((k) => (
              <button key={k} type="button" role="tab" aria-selected={show === k} className={show === k ? "on" : ""} onClick={() => setShow(k)}>{k === "all" ? "All" : "Running"}</button>
            ))}
          </div>
          <button type="button" className="icon-btn" aria-label="Refresh" title="Refresh" onClick={load}><Icon name="refresh" /></button>
          {can("tunnels.create") && <a className="btn" href="#/new"><Icon name="public" size={18} />New tunnel</a>}
          {can("containers.deploy") && <button type="button" className="btn primary" onClick={() => setAdding(true)}><Icon name="add" size={18} />Add container</button>}
          {cleanup.busy ? <span className="spinner small" /> : pageMenu.length > 0 && <MoreMenu label="More" actions={pageMenu} />}
        </div>
      </div>
      <div className="page-body stack">
      {problem && <Callout tone="bad" icon="error">Docker is not reachable: {problem}</Callout>}

      {adding && <AddContainer onClose={() => setAdding(false)} onAdded={async (d) => {
        await load();
        go(`${pageOf(d.name)}/images`);
      }} />}

      {seeContainers && list && (all.length === 0 ? (
        <div className="card welcome">
          <Icon name="deployed_code" size={40} />
          <h2>No containers</h2>
          <p className="muted">Add one from a repository, or containers Docker runs here show up on their own.</p>
          {can("containers.deploy") && <button type="button" className="btn primary" onClick={() => setAdding(true)}><Icon name="add" size={18} />Add container</button>}
        </div>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table className="table ct-table">
              <thead>
                <tr><th className="grow">Container</th><th>Ports</th>{seeTunnels && <th>Tunnels</th>}<th>CPU</th><th>Memory</th><th>Status</th><th aria-label="Actions" /></tr>
              </thead>
              <tbody>
                {rows.map((r) => "group" in r ? (
                  <Group key={"g-" + r.group} name={r.group} items={r.items} stats={stats} busy={busy} run={run} reaching={seeTunnels ? reaching : null}
                    open={!folded.has(r.group)}
                    onFold={() => setFolded((f) => {
                      const next = new Set(f);
                      if (next.has(r.group)) next.delete(r.group);
                      else next.add(r.group);
                      return next;
                    })} />
                ) : (
                  <Row key={r.id || r.name} c={r} s={stats[shortId(r.id)]} busy={busy.has(r.id)} run={run} reaching={seeTunnels ? reaching : null} />
                ))}
                {shown.length === 0 && <tr><td colSpan={seeTunnels ? 7 : 6} className="empty-note ct-none">No containers match.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {seeTunnels && routes && (others.length > 0 || allRoutes.length === 0) && (
        <section className="stack">
          <h2 className="section-title">{seeContainers ? "Other tunnels" : "Tunnels"}</h2>
          {allRoutes.length === 0 ? (
            <div className="card welcome">
              <Icon name="public" size={40} />
              <h2>Nothing published yet</h2>
              <p className="muted">Open a container to give it an address, or publish any port on one of your domains, and choose who can open it.</p>
              {can("tunnels.create") && <a className="btn primary" href="#/new"><Icon name="add" size={18} />New tunnel</a>}
            </div>
          ) : (
            <div className="card">
              <ul className="results">
                {others.map((r) => (
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
        </section>
      )}
      </div>
    </>
  );
}

// TunnelLinks are the addresses reaching a container, each opening its tunnel
// on the container's page.
function TunnelLinks({ c, routes }: { c: Container; routes: Route[] }) {
  if (!routes.length) return <span className="muted">None</span>;
  return (
    <span className="port-links">
      {routes.map((r) => (
        <a key={r.id} href={`${pageOf(c.name)}/tunnel/${r.id}`} title={r.enabled ? "Live" : "Off"}>
          <span className={"dot " + (r.enabled ? "ok" : "")} />{r.hostname}
        </a>
      ))}
    </span>
  );
}

// The actions a container's menu holds, by what it may do now. `page` leaves
// out what the page itself shows, its logs and tunnel.
function actionsOf(c: (Container | ContainerDetail) & { deploy?: string | null }, run: (targets: Target[], action: Act) => void, can: (key: string) => boolean, page = false): MenuAction[] {
  const on = live(c);
  const manage = can("containers.manage");
  const remove = can("containers.remove") && !c.own && !on && c.state !== "paused"
    ? [{ label: "Delete", icon: "delete" as IconName, danger: true, onClick: () => run([c], "remove"), confirm: "Delete for good" }] : [];
  if (!c.id) return remove;
  return [
    ...(page ? [] : [
      { label: "Logs", icon: "terminal" as IconName, onClick: () => go(`${pageOf(c.name)}/logs`) },
      ...(can("tunnels.create") ? [{ label: "Tunnel", icon: "public" as IconName, onClick: () => go(`${pageOf(c.name)}/tunnel`) }] : []),
    ]),
    ...(manage && !c.own && on && !page ? [{ label: "Stop", icon: "stop" as IconName, onClick: () => run([c], "stop") }] : []),
    ...(manage && !c.own && c.state === "paused" && !page ? [{ label: "Resume", icon: "play_arrow" as IconName, onClick: () => run([c], "unpause") }] : []),
    ...(manage && !on && c.state !== "paused" && !page ? [{ label: "Start", icon: "play_arrow" as IconName, onClick: () => run([c], "start") }] : []),
    ...(manage && on ? [{ label: "Restart", icon: "restart_alt" as IconName, onClick: () => run([c], "restart"), confirm: c.own ? "Restart myTunnels" : undefined }] : []),
    ...(manage && !c.own && on && page ? [{ label: "Pause", icon: "pause" as IconName, onClick: () => run([c], "pause") }] : []),
    ...(manage && !c.own && on ? [{ label: "Kill", icon: "block" as IconName, danger: true, onClick: () => run([c], "kill"), confirm: "Kill it now" }] : []),
    ...remove,
  ];
}

function Row({ c, s, busy, run, grouped, reaching }: {
  c: Container;
  s?: ContainerStats;
  busy: boolean;
  run: (targets: Target[], action: Act) => void;
  grouped?: boolean;
  reaching: ((c: Container) => Route[]) | null;
}) {
  const can = useCan();
  const on = live(c);
  return (
    <tr className={(on ? "" : "stopped") + (grouped ? " in-group" : "")}>
      <td>
        <a className="ct-name" href={pageOf(c.name)}>
          <span className={"dot " + tone(c.state)} title={c.state} />
          <span className="ct-name-text">
            <b>{c.name}{c.own && <span className="chip plain small-chip">myTunnels</span>}</b>
            <small className="mono" title={c.image}>{c.image}</small>
          </span>
        </a>
      </td>
      <td><PortLinks ports={c.ports} max={2} /></td>
      {reaching && <td><TunnelLinks c={c} routes={reaching(c)} /></td>}
      <td className="num">{on && s ? pct(s.cpu) : "–"}</td>
      <td className="num">{on && s ? bytes(s.memory) : "–"}</td>
      <td className="muted ct-status">{c.status}</td>
      <td className="ct-menu">{busy ? <span className="spinner small" /> : <MoreMenu label={`Actions for ${c.name}`} actions={actionsOf(c, run, can)} />}</td>
    </tr>
  );
}

function Group({ name, items, stats, busy, run, open, onFold, reaching }: {
  name: string;
  items: Container[];
  stats: Record<string, ContainerStats>;
  busy: Set<string>;
  run: (targets: Target[], action: Act) => void;
  open: boolean;
  onFold: () => void;
  reaching: ((c: Container) => Route[]) | null;
}) {
  const can = useCan();
  const up = items.filter(live);
  const cpu = up.reduce((n, c) => n + (stats[shortId(c.id)]?.cpu ?? 0), 0);
  const memory = up.reduce((n, c) => n + (stats[shortId(c.id)]?.memory ?? 0), 0);
  const others = items.filter((c) => !c.own);
  return (
    <>
      <tr className="ct-group">
        <td>
          <button type="button" className="ct-fold" aria-expanded={open} onClick={onFold}>
            <Icon name="chevron_right" size={18} className={open ? "open" : ""} />
            <Icon name="deployed_code" size={18} className="ct-stack-icon" />
            <b>{name}</b>
            <small>{up.length} of {items.length} running</small>
          </button>
        </td>
        <td />
        {reaching && <td />}
        <td className="num">{up.length ? pct(cpu) : "–"}</td>
        <td className="num">{up.length ? bytes(memory) : "–"}</td>
        <td />
        <td className="ct-menu">
          {can("containers.manage") && others.length > 0 && (
            <MoreMenu label={`Actions for ${name}`} actions={[
              ...(others.some((c) => !live(c)) ? [{ label: "Start all", icon: "play_arrow" as IconName, onClick: () => run(others.filter((c) => !live(c)), "start") }] : []),
              ...(others.some(live) ? [{ label: "Stop all", icon: "stop" as IconName, onClick: () => run(others.filter(live), "stop") }] : []),
              ...(others.some(live) ? [{ label: "Restart all", icon: "restart_alt" as IconName, onClick: () => run(others.filter(live), "restart") }] : []),
            ]} />
          )}
        </td>
      </tr>
      {open && items.map((c) => <Row key={c.id} c={c} s={stats[shortId(c.id)]} busy={busy.has(c.id)} run={run} grouped reaching={reaching} />)}
    </>
  );
}

// ---- one container ----

const TABS: [string, string, IconName][] = [
  ["overview", "Overview", "info"],
  ["tunnel", "Tunnel", "public"],
  ["images", "Images", "layers"],
  ["logs", "Logs", "terminal"],
  ["stats", "Stats", "dashboard"],
  ["settings", "Settings", "settings"],
];

// ContainerPage is one container and its tunnel together: its name, state and
// address in the heading, with Open, the one button its state calls for, and a
// menu for the rest; then its sub-pages.
function ContainerPage({ name, tab, more, routes, devices, users, providers, onChanged }: { name: string; tab: string; more: string[] } & Shared) {
  const [c, setC] = useState<ContainerDetail | null>(null);
  // The repository it is built from: undefined until known, null for none.
  const [d, setD] = useState<Deploy | null | undefined>(undefined);
  const [problem, setProblem] = useState("");
  const [updating, setUpdating] = useState(false);
  const can = useCan();
  const notify = useNotify();
  const base = pageOf(name);

  const load = useCallback(async () => {
    const [found, deploys] = await Promise.allSettled([api.container(name), api.deploys()]);
    const mine = deploys.status === "fulfilled" ? deploys.value.find((x) => x.name === name) : undefined;
    setD(mine ? await api.deploy(mine.id).catch(() => mine) : deploys.status === "fulfilled" ? null : undefined);
    if (found.status === "fulfilled") {
      setC(found.value);
      setProblem("");
    } else {
      setC(null);
      setProblem(message(found.reason));
    }
  }, [name]);
  const building = waiting(d?.latest);
  useEffect(() => {
    load();
    const t = setInterval(load, building ? 2500 : 5000);
    return () => clearInterval(t);
  }, [load, building]);
  const { busy, run } = useActions(load);

  // What the list knew draws the page at once; the full details fill it in. A
  // container from a repository that is not made yet shows its builds.
  const head = c ?? listed.get(name) ?? (d ? pending(d) : undefined);
  const made = !!head?.id;
  const tabs = TABS.filter(([k]) => (k !== "tunnel" || can("tunnels.view"))
    && (made || !["overview", "logs", "stats"].includes(k))
    && (k !== "settings" || (!!d && can("containers.deploy"))));
  const current = tabs.some(([k]) => k === tab) ? tab : tabs[0][0];
  if (!head) {
    return (
      <>
        <div className="page-head"><div className="page-head-main"><h1>{name}</h1></div></div>
        {problem ? <Callout tone="bad" icon="error">{problem}</Callout> : <div className="repo-loading"><span className="spinner" /></div>}
      </>
    );
  }
  const on = live(head);
  const working = busy.size > 0;
  const act = (action: Act) => run([{ ...head, deploy: d?.id ?? null }], action).then(() => {
    if (action === "remove") go("#/");
  });
  const update = async () => {
    if (!d) return;
    setUpdating(true);
    try {
      await api.buildNow(d.id);
      notify(`Updating ${d.name}`);
      await load();
      go(`${base}/images`);
    } catch (e) {
      notify(message(e), "bad");
    } finally {
      setUpdating(false);
    }
  };
  const reaching = tunnelsOf(head, routes ?? []);
  const opens = reaching.find((r) => r.enabled);
  const manage = can("containers.manage") && !head.own;
  const menu = actionsOf({ ...head, deploy: d?.id ?? null }, (_, action) => act(action), can, true);

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>{head.name}{head.own && <span className="chip plain small-chip">myTunnels</span>}</h1>
          <div className="page-sub">
            <span className={"chip " + tone(head.state)}>{head.state}</span>
            {c?.health && <span className={"chip " + (c.health === "healthy" ? "ok" : c.health === "unhealthy" ? "bad" : "warn")}>{c.health}</span>}
            {d ? (
              <span className="ct-source"><Icon name="git" size={16} /><span className="mono">{sourceOf(d)}</span>, {d.branch}{d.running && <>, build {d.running.number}</>}</span>
            ) : <span className="mono">{head.image}</span>}
            {reaching.map((r) => (
              <a key={r.id} className="ct-address" href={`${base}/tunnel/${r.id}`}><span className={"dot " + (r.enabled ? "ok" : "")} />{r.hostname}</a>
            ))}
          </div>
        </div>
        <div className="page-actions">
          {working && <span className="spinner small" />}
          {opens && <a className="btn" href={`https://${opens.hostname}`} target="_blank" rel="noreferrer"><Icon name="open_in_new" size={18} />Open</a>}
          {d && can("containers.deploy") && (
            <button type="button" className="btn" disabled={updating || building} onClick={update}>
              {updating || building ? <span className="spinner small" /> : <Icon name="autorenew" size={18} />}{building ? "Updating" : "Update"}
            </button>
          )}
          {manage && made && (on ? <button type="button" className="btn" disabled={working} onClick={() => act("stop")}><Icon name="stop" size={18} />Stop</button>
            : head.state === "paused" ? <button type="button" className="btn primary" disabled={working} onClick={() => act("unpause")}><Icon name="play_arrow" size={18} />Resume</button>
            : <button type="button" className="btn primary" disabled={working} onClick={() => act("start")}><Icon name="play_arrow" size={18} />Start</button>)}
          {menu.length > 0 && <MoreMenu label={`Actions for ${head.name}`} actions={menu} />}
        </div>
      </div>
      <SubNav back="#/" backLabel="Containers" base={base} items={tabs} current={current} />
      <div className="page-body stack" key={current + (more[0] ?? "")}>
        {problem && made && !c && <Callout tone="bad" icon="error">{problem}</Callout>}
        {current === "overview" && (c ? <Overview c={c} /> : <div className="repo-loading"><span className="spinner" /></div>)}
        {current === "tunnel" && !routes && <div className="repo-loading"><span className="spinner" /></div>}
        {current === "tunnel" && routes && (
          <ContainerTunnel c={head} pick={more[0] ?? ""} base={`${base}/tunnel`} routes={reaching} devices={devices} users={users} providers={providers} onChanged={onChanged} />
        )}
        {current === "images" && (more[0] === "build" && d ? <BuildLog d={d} number={Number(more[1])} back={`${base}/images`} />
          : more[0] ? <ImageView id={more[0]} back={`${base}/images`} />
          : d ? <Builds d={d} base={`${base}/images`} onChanged={load} />
          : d === null ? <ContainerImages c={head} base={`${base}/images`} /> : <div className="repo-loading"><span className="spinner" /></div>)}
        {current === "settings" && d && <DeploySettings d={d} onChanged={load} />}
        {current === "logs" && <Logs id={head.id} />}
        {current === "stats" && <Stats id={head.id} running={on} />}
      </div>
    </>
  );
}

// ContainerTunnel is the container's address: publishing one when it has none,
// otherwise the tunnel itself. With several, a row of them picks which.
function ContainerTunnel({ c, pick, base, routes, devices, users, providers, onChanged }: {
  c: Container | ContainerDetail;
  pick: string;
  base: string;
  routes: Route[];
  devices: Device[];
  users: User[];
  providers: OAuthProvider[];
  onChanged: () => Promise<void>;
}) {
  const can = useCan();
  const adding = pick === "new" || routes.length === 0;
  const route = adding ? undefined : routes.find((r) => r.id === pick) ?? routes[0];
  const picker = (routes.length > 1 || (routes.length > 0 && can("tunnels.create"))) && (
    <div className="ct-picker">
      <div className="seg-tabs" role="tablist" aria-label="Addresses">
        {routes.map((r) => (
          <button key={r.id} type="button" role="tab" aria-selected={route?.id === r.id} className={route?.id === r.id ? "on" : ""} onClick={() => go(`${base}/${r.id}`)}>{r.hostname}</button>
        ))}
        {can("tunnels.create") && (
          <button type="button" role="tab" aria-selected={adding} className={adding ? "on" : ""} aria-label="Another address" title="Another address" onClick={() => go(`${base}/new`)}><Icon name="add" size={18} /></button>
        )}
      </div>
    </div>
  );
  if (adding) {
    if (!can("tunnels.create")) {
      return <div className="card welcome"><Icon name="public" size={40} /><h2>No address</h2><p className="muted">Nothing reaches this container through a tunnel.</p></div>;
    }
    return (
      <>
        {picker}
        <TunnelComposer users={users} providers={providers} sub={routes.length ? "" : c.name} container={{ name: c.name, reach: reachOf(c) }}
          onPublished={async (r) => {
            await onChanged();
            go(`${base}/${r.id}`);
          }} />
      </>
    );
  }
  return (
    <>
      {picker}
      {route && <TunnelPanel key={route.id} route={route} devices={devices} users={users} providers={providers} onChanged={onChanged} onRemoved={() => go(base)} />}
    </>
  );
}

const TAILS = [200, 500, 2000, 5000].map((n) => ({ value: n, label: `Last ${n} lines` }));

// Logs is what the container wrote, the newest at the bottom, followed as it
// runs, searchable, with or without times.
function Logs({ id }: { id: string }) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [tail, setTail] = useState(500);
  const [follow, setFollow] = useState(true);
  const [stamps, setStamps] = useState(true);
  const [q, setQ] = useState("");
  const [problem, setProblem] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const notify = useNotify();

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const l = await api.containerLogs(id, tail);
        if (!alive) return;
        setLines(l.lines);
        setProblem("");
      } catch (e) {
        if (alive) setProblem(message(e));
      }
    };
    load();
    if (!follow) return () => {
      alive = false;
    };
    const t = setInterval(load, 2500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id, tail, follow]);

  useEffect(() => {
    if (box.current && atEnd.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines]);

  const parsed = (lines ?? []).map((line) => {
    const space = line.indexOf(" ");
    const at = space > 0 ? Date.parse(line.slice(0, space)) : NaN;
    return at > 0 ? { at, text: line.slice(space + 1) } : { at: 0, text: line };
  });
  const needle = q.trim().toLowerCase();
  const shown = needle ? parsed.filter((l) => l.text.toLowerCase().includes(needle)) : parsed;

  return (
    <div className="card ct-logs">
      <div className="ct-log-bar">
        <label className="ct-search">
          <Icon name="search" size={18} />
          <input type="search" placeholder="Search the logs" aria-label="Search the logs" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
        </label>
        {needle && <span className="muted">{shown.length} of {parsed.length}</span>}
        <span className="ex-grow" />
        <label className="edit-switch"><Switch label="Times" on={stamps} onChange={setStamps} /><span>Times</span></label>
        <label className="edit-switch"><Switch label="Follow" on={follow} onChange={setFollow} /><span>Follow</span></label>
        <div className="ex-pick"><Dropdown label="Lines" value={tail} options={TAILS} onChange={setTail} /></div>
        <button type="button" className="icon-btn" aria-label="Copy logs" title="Copy logs" onClick={() => {
          navigator.clipboard?.writeText(shown.map((l) => l.text).join("\n"));
          notify("Copied the logs");
        }}><Icon name="content_copy" /></button>
      </div>
      {problem && <Callout tone="bad" icon="error">{problem}</Callout>}
      <div className="ct-log-lines" ref={box} onScroll={(e) => {
        const el = e.currentTarget;
        atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}>
        {lines === null ? null : shown.length === 0 ? <span className="muted">{needle ? "No lines match." : "Nothing written yet."}</span> : shown.map((l, i) => (
          <div key={i}>
            {stamps && l.at > 0 && <span className="log-time">{new Date(l.at).toLocaleTimeString()}</span>}
            {needle ? highlight(l.text, needle) : l.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function highlight(text: string, needle: string) {
  const out = [];
  const lower = text.toLowerCase();
  let at = 0;
  for (let i = lower.indexOf(needle); i >= 0; i = lower.indexOf(needle, i + needle.length)) {
    out.push(text.slice(at, i), <mark key={i}>{text.slice(i, i + needle.length)}</mark>);
    at = i + needle.length;
  }
  out.push(text.slice(at));
  return out;
}

const when = (iso: string) => {
  const t = Date.parse(iso);
  return t > 0 ? new Date(t).toLocaleString() : "Never";
};

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div className="kv"><span className="kv-label">{label}</span><span className="kv-value">{children}</span></div>;
}

// Overview is how the container is set up: what it runs and how it restarts,
// its ports and networks, and what it has mounted.
function Overview({ c }: { c: ContainerDetail }) {
  return (
    <>
      <div className="ct-inspect">
        <section className="card ct-panel">
          <h2>Details</h2>
          <Fact label="ID"><span className="ct-id"><span className="mono">{shortId(c.id)}</span><Copy text="" copyText={c.id} plain /></span></Fact>
          <Fact label="Image"><span className="mono">{c.image}</span></Fact>
          <Fact label="Command"><span className="mono">{c.command || "None"}</span></Fact>
          <Fact label="Working folder"><span className="mono">{c.workdir || "/"}</span></Fact>
          {c.project && <Fact label="Compose">{c.project}, service {c.service ?? ""}</Fact>}
        </section>
        <section className="card ct-panel">
          <h2>State</h2>
          <Fact label="Created">{when(c.created)}</Fact>
          <Fact label={live(c) ? "Started" : "Ended"}>{live(c) ? when(c.started) : `${when(c.finished)}, exit code ${c.exit_code}`}</Fact>
          <Fact label="Restart policy">{c.restart_policy || "no"}</Fact>
          <Fact label="Restarts">{c.restarts}</Fact>
          {c.health && <Fact label="Health">{c.health}</Fact>}
        </section>
        <section className="card ct-panel">
          <h2>Ports</h2>
          {c.ports.length ? (
            <table className="table">
              <thead><tr><th className="grow">Container port</th><th>Host port</th></tr></thead>
              <tbody>
                {c.ports.map((p) => (
                  <tr key={`${p.private}-${p.public}-${p.type}`}>
                    <td className="mono">{p.private}/{p.type}</td>
                    <td>{p.public !== null ? <a href={`http://${location.hostname}:${p.public}`} target="_blank" rel="noreferrer" className="mono">{p.public}</a> : <span className="muted">Not published</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="empty-note">None exposed.</p>}
        </section>
        <section className="card ct-panel">
          <h2>Networks</h2>
          {c.networks.length ? (
            <table className="table">
              <thead><tr><th className="grow">Network</th><th>Address</th></tr></thead>
              <tbody>
                {c.networks.map((n) => <tr key={n.name}><td>{n.name}</td><td className="mono">{n.ip || "None"}</td></tr>)}
              </tbody>
            </table>
          ) : <p className="empty-note">Not on any network.</p>}
        </section>
      </div>
      <section className="card ct-panel">
        <h2>Mounts</h2>
        {c.mounts.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Type</th><th className="grow">Source</th><th>Destination</th><th>Mode</th></tr></thead>
              <tbody>
                {c.mounts.map((mnt) => (
                  <tr key={mnt.destination}>
                    <td><span className="chip">{mnt.kind === "volume" ? "Volume" : mnt.kind === "bind" ? "Bind" : mnt.kind}</span></td>
                    <td className="mono ct-image" title={mnt.source}>{mnt.source}</td>
                    <td className="mono">{mnt.destination}</td>
                    <td>{mnt.writable ? "Read and write" : <span className="chip warn">Read only</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="empty-note">Nothing mounted.</p>}
      </section>
    </>
  );
}

// Stats is the container's usage, sampled with the host's.
function Stats({ id, running }: { id: string; running: boolean }) {
  const m = useMetrics();
  if (!running) return <div className="card welcome"><Icon name="dashboard" size={40} /><h2>Not running</h2><p className="muted">Usage shows while the container runs.</p></div>;
  const s = m?.docker.containers.find((x) => shortId(x.id) === shortId(id));
  if (!m || !s) return <div className="repo-loading"><span className="spinner" /></div>;
  const every = m.every;
  const now = Date.now() / 1000;
  const times = s.history.map((_, i) => now - (s.history.length - 1 - i) * every);
  const limit = s.memory_limit && s.memory_limit < m.memory_total * 4 ? s.memory_limit : m.memory_total;
  return (
    <div className="widgets">
      <section className="widget wide">
        <div className="widget-head"><h2>CPU usage</h2><span className="chart-now">{pct(s.cpu)}</span></div>
        <div className="widget-body">
          <Chart times={times} keep={m.keep} every={every} max={Math.max(100, ...s.history)} format={pct} lines={[{ label: "CPU", color: "var(--s1)", values: s.history }]} />
        </div>
      </section>
      <section className="widget">
        <div className="widget-head"><h2>Memory</h2></div>
        <div className="widget-body">
          <div className="big-figure">{bytes(s.memory).split(" ")[0]}<small>{bytes(s.memory).split(" ")[1]}</small></div>
          <p className="donut-sub">of {bytes(limit)}</p>
          <Meter value={s.memory} max={limit} label={pct((s.memory / (limit || 1)) * 100)} />
        </div>
      </section>
      <section className="widget">
        <div className="widget-head"><h2>Network I/O</h2></div>
        <div className="widget-body">
          <Fact label="Received">{rate(s.rx)}</Fact>
          <Fact label="Sent">{rate(s.tx)}</Fact>
        </div>
      </section>
      <section className="widget">
        <div className="widget-head"><h2>Disk I/O</h2></div>
        <div className="widget-body">
          <Fact label="Read">{rate(s.read)}</Fact>
          <Fact label="Written">{rate(s.write)}</Fact>
        </div>
      </section>
    </div>
  );
}
