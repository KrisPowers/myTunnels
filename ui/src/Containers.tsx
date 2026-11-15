import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { NeedsApp } from "./Apps";
import { api, bytes, message, type Container, type ContainerAction, type ContainerDetail, type ContainerStats, type Deploy, type Forward, type Image, type Metrics, type OAuthProvider, type Route, type User } from "./api";
import { BuildLog, Builds, DeploySettings, NewMenu, sourceOf, waiting } from "./Builds";
import { Chart, Meter } from "./charts";
import { Dropdown, type Option } from "./Dropdown";
import { ForwardComposer, ForwardRows, forwardsOf } from "./Forward";
import { Icon, type IconName } from "./Icon";
import { ContainerImages, ImageView, useImageRemoval } from "./Images";
import { useCan } from "./me";
import { Resources } from "./Resources";
import { go } from "./route";
import { reachOf, TunnelDetail, tunnelsOf } from "./Tunnels";
import { Callout, Copy, Dialog, MoreMenu, SubNav, Switch, useNotify, type MenuAction } from "./ui";

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

// A container from a repository that is not made yet: its first build is
// waiting, running or failed.
function pending(d: Deploy): Container {
  const failed = d.latest?.status === "failed";
  return {
    id: "", name: d.name, image: sourceOf(d), state: failed ? "failed" : "building", status: failed ? "Build failed" : "Building",
    created: d.created_at, ports: [], project: null, service: null, deploy: d.id, own: false,
  };
}

// What a container's page and its forwards need from the dashboard.
export interface Shared {
  routes: Route[] | null;
  forwards: Forward[];
  users: User[];
  providers: OAuthProvider[];
  onChanged: () => Promise<void>;
}

export function ContainersPage({ id, page, more, ...shared }: { id: string; page: string; more: string[] } & Shared) {
  if (id) return <ContainerPage name={id} tab={page} more={more} {...shared} />;
  return <ContainerList routes={shared.routes} forwards={shared.forwards} />;
}

// ---- the list ----

// The containers as last listed, by name, so one opens at once with what the
// list knew while its full details load.
const listed = new Map<string, Container>();

type Show = "all" | "running";

const SHOW: Option<Show>[] = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
];

// One container in the catalog.
type Item = { key: string; name: string; project: string | null; on: boolean; c: Container };

// ContainerList is the catalog of containers, a row each with what it is, its
// state, its address and its use, and one menu. Compose projects of two or
// more fold under their name. It refreshes on its own; tunnels and other
// forwards to ports elsewhere are on Routes.
function ContainerList({ routes, forwards }: { routes: Route[] | null; forwards: Forward[] }) {
  const can = useCan();
  const seeContainers = can("containers.view");
  const seeTunnels = can("tunnels.view");
  const [list, setList] = useState<Container[] | null>(null);
  const [images, setImages] = useState<Image[] | null>(null);
  const [deploys, setDeploys] = useState<Deploy[]>([]);
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
  const allForwards = seeTunnels ? forwards : [];
  const made = new Set((list ?? []).map((c) => c.name));
  const containers = [...(list ?? []), ...deploys.filter((d) => !made.has(d.name)).map(pending)];
  const items: Item[] = containers.map((c) => ({ key: c.id || c.name, name: c.name, project: c.project, on: live(c), c }));
  const byDeploy = new Map(deploys.map((d) => [d.id, d]));
  const stats = useMemo(() => Object.fromEntries((m?.docker.containers ?? []).map((s) => [shortId(s.id), s])), [m]);

  const needle = q.trim().toLowerCase();
  const shown = items
    .filter((i) => show === "all" || i.on)
    .filter((i) => !needle || [i.name, i.project ?? "", i.c.image].some((v) => v.toLowerCase().includes(needle)))
    .sort((a, b) => (a.project ?? a.name).localeCompare(b.project ?? b.name) || a.name.localeCompare(b.name));
  const counts = new Map<string, number>();
  for (const i of shown) if (i.project) counts.set(i.project, (counts.get(i.project) ?? 0) + 1);

  const running = (list ?? []).filter(live);
  const cpu = running.reduce((n, c) => n + (stats[shortId(c.id)]?.cpu ?? 0), 0);
  const memory = running.reduce((n, c) => n + (stats[shortId(c.id)]?.memory ?? 0), 0);
  const unused = (images ?? []).filter((i) => !i.containers.length);
  const spare = unused.reduce((n, i) => n + i.size, 0);
  const pageMenu: MenuAction[] = can("containers.remove") && unused.length > 0
    ? [{ label: `Delete unused images, ${bytes(spare)}`, icon: "layers", danger: true, onClick: () => cleanup.remove(unused), confirm: `Delete ${unused.length} for good` }]
    : [];

  const fold = (project: string) => setFolded((f) => {
    const next = new Set(f);
    if (next.has(project)) next.delete(project);
    else next.add(project);
    return next;
  });

  const rows: ReactNode[] = [];
  let group = "";
  for (const i of shown) {
    const grouped = !!i.project && (counts.get(i.project) ?? 0) > 1;
    if (grouped && i.project !== group) {
      const members = shown.filter((x) => x.project === i.project).map((x) => x.c);
      rows.push(<GroupHead key={"g-" + i.project} name={i.project!} items={members} open={!folded.has(i.project!)} onFold={() => fold(i.project!)} run={run} />);
    }
    group = grouped ? i.project! : "";
    if (grouped && folded.has(i.project!)) continue;
    rows.push(<ContainerRow key={i.key} c={i.c} d={i.c.deploy ? byDeploy.get(i.c.deploy) : undefined} s={stats[shortId(i.c.id)]}
      routes={tunnelsOf(i.c, allRoutes)} forwards={forwardsOf(i.c, allForwards)} busy={busy.has(i.c.id)} run={run} grouped={grouped} />);
  }

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Containers</h1>
          <div className="page-sub">
            {list && <span><b>{running.length}</b> of {list.length} running</span>}
            {list && m && <span>CPU <b>{pct(cpu)}</b></span>}
            {list && m && <span>Memory <b>{bytes(memory)}</b></span>}
          </div>
        </div>
        <div className="page-actions">
          <label className="ct-search">
            <Icon name="search" size={18} />
            <input type="search" placeholder="Search" aria-label="Search containers" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
          </label>
          <div className="ex-pick"><Dropdown label="Show" value={show} options={SHOW} onChange={setShow} /></div>
          <NewMenu />
          {cleanup.busy ? <span className="spinner small" /> : pageMenu.length > 0 && <MoreMenu label="More" actions={pageMenu} />}
        </div>
      </div>
      <div className="page-body stack">
        <NeedsApp app="docker" what="Containers" />
        {problem && <Callout tone="bad" icon="error">Docker is not reachable: {problem}</Callout>}
        {(list || !seeContainers) && (items.length === 0 ? (
          <div className="card welcome">
            <Icon name="deployed_code" size={40} />
            <h2>Nothing here yet</h2>
            <p className="muted">Add a container with the plus. Containers Docker runs here show up on their own.</p>
          </div>
        ) : (
          <div className="card">
            <ul className="results ct-list">
              {rows}
              {shown.length === 0 && <li className="empty-note ct-none">Nothing matches.</li>}
            </ul>
          </div>
        ))}
      </div>
    </>
  );
}

// The icon for what a container is: built from Git, run from an image, or one
// Docker runs that was made elsewhere.
function kindOf(d?: Deploy): IconName {
  if (d) return d.image ? "layers" : "git";
  return "deployed_code";
}

// Usage, for a container that runs.
function Use({ s }: { s?: ContainerStats }) {
  if (!s) return <span className="ct-use" />;
  return <span className="ct-use">{pct(s.cpu)}<span>{bytes(s.memory)}</span></span>;
}

function ContainerRow({ c, d, s, routes, forwards, busy, run, grouped }: {
  c: Container;
  d?: Deploy;
  s?: ContainerStats;
  routes: Route[];
  forwards: Forward[];
  busy: boolean;
  run: (targets: Target[], action: Act) => void;
  grouped: boolean;
}) {
  const can = useCan();
  // Its first address: a tunnel's, or a router or Tailscale forward's.
  const addresses = [
    ...routes.map((r) => ({ at: r.hostname, on: r.enabled })),
    ...forwards.filter((f) => f.address).map((f) => ({ at: f.address!, on: f.enabled && !f.problem })),
  ];
  const first = addresses[0];
  return (
    <li className={"ct-row" + (grouped ? " in-group" : "")}>
      <a className="ct-row-main" href={pageOf(c.name)}>
        <span className={"ct-kind " + tone(c.state)} title={c.status || c.state}><Icon name={kindOf(d)} /></span>
        <span className="ct-name-text">
          <b>{c.name}{c.own && <span className="chip plain small-chip">myTunnels</span>}</b>
          <small className="mono">{d ? `${sourceOf(d)}${d.branch ? `, ${d.branch}` : ""}` : c.image}</small>
        </span>
        <span className="ct-reach">
          {first && <><span className={"dot " + (first.on ? "ok" : "")} />{first.at}{addresses.length > 1 && <span className="muted">+{addresses.length - 1}</span>}</>}
        </span>
        {live(c) ? <Use s={s} /> : <span className="ct-use muted">{c.status}</span>}
      </a>
      <span className="ct-menu">{busy ? <span className="spinner small" /> : <MoreMenu label={`Actions for ${c.name}`} actions={actionsOf(c, run, can)} />}</span>
    </li>
  );
}

// GroupHead is a Compose project's name over its containers, folding them away.
function GroupHead({ name, items, open, onFold, run }: {
  name: string;
  items: Container[];
  open: boolean;
  onFold: () => void;
  run: (targets: Target[], action: Act) => void;
}) {
  const can = useCan();
  const up = items.filter(live);
  const others = items.filter((c) => !c.own);
  return (
    <li className="ct-group-head">
      <button type="button" className="ct-fold" aria-expanded={open} onClick={onFold}>
        <Icon name="chevron_right" size={18} className={open ? "open" : ""} />
        <b>{name}</b>
        <small>{up.length} of {items.length} running</small>
      </button>
      {can("containers.manage") && others.length > 0 && (
        <MoreMenu label={`Actions for ${name}`} actions={[
          ...(others.some((c) => !live(c)) ? [{ label: "Start all", icon: "play_arrow" as IconName, onClick: () => run(others.filter((c) => !live(c)), "start") }] : []),
          ...(others.some(live) ? [{ label: "Stop all", icon: "stop" as IconName, onClick: () => run(others.filter(live), "stop") }] : []),
          ...(others.some(live) ? [{ label: "Restart all", icon: "restart_alt" as IconName, onClick: () => run(others.filter(live), "restart") }] : []),
        ]} />
      )}
    </li>
  );
}

// The actions a container's menu holds, by what it may do now. `page` leaves
// out what the page itself shows, its logs and forwards.
function actionsOf(c: (Container | ContainerDetail) & { deploy?: string | null }, run: (targets: Target[], action: Act) => void, can: (key: string) => boolean, page = false): MenuAction[] {
  const on = live(c);
  const manage = can("containers.manage");
  const remove = can("containers.remove") && !c.own && !on && c.state !== "paused"
    ? [{ label: "Delete", icon: "delete" as IconName, danger: true, onClick: () => run([c], "remove"), confirm: "Delete for good" }] : [];
  if (!c.id) return remove;
  return [
    ...(page ? [] : [
      { label: "Logs", icon: "terminal" as IconName, onClick: () => go(`${pageOf(c.name)}/logs`) },
      ...(can("tunnels.view") ? [{ label: "Routes", icon: "wifi_cog" as IconName, onClick: () => go(`${pageOf(c.name)}/routes`) }] : []),
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

// ---- one container ----

const TABS: [string, string, IconName][] = [
  ["overview", "Overview", "info"],
  ["routes", "Routes", "wifi_cog"],
  ["images", "Images", "layers"],
  ["logs", "Logs", "terminal"],
  ["resources", "Resources", "tune"],
  ["settings", "Settings", "settings"],
];

const AUTO_START: Record<string, string> = { "on-failure": "When it fails", "unless-stopped": "Unless stopped by hand", always: "Always" };

// ContainerPage is one container and its forwards together: its name, state
// and address in the heading, with Open, the one button its state calls for,
// and a menu for the rest; then its sub-pages.
function ContainerPage({ name, tab: asked, more, routes, forwards, users, providers, onChanged }: { name: string; tab: string; more: string[] } & Shared) {
  // Its Tunnel page became Forward, then Routes.
  const tab = asked === "tunnel" || asked === "forward" ? "routes" : asked;
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
  const tabs = TABS.filter(([k]) => (k !== "routes" || can("tunnels.view"))
    && (made || !["overview", "logs", "resources"].includes(k))
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
              <a key={r.id} className="ct-address" href={`${base}/routes/${r.id}`}><span className={"dot " + (r.enabled ? "ok" : "")} />{r.hostname}</a>
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
          {manage && made && (on ? <button type="button" className="btn primary danger-fill" disabled={working} onClick={() => act("stop")}><Icon name="stop" size={18} />Stop</button>
            : head.state === "paused" ? <button type="button" className="btn primary" disabled={working} onClick={() => act("unpause")}><Icon name="play_arrow" size={18} />Resume</button>
            : <button type="button" className="btn primary" disabled={working} onClick={() => act("start")}><Icon name="play_arrow" size={18} />Start</button>)}
          {menu.length > 0 && <MoreMenu label={`Actions for ${head.name}`} actions={menu} />}
        </div>
      </div>
      <SubNav back="#/" backLabel="Containers" base={base} items={tabs} current={current} />
      <div className="page-body stack" key={current}>
        {problem && made && !c && <Callout tone="bad" icon="error">{problem}</Callout>}
        {current === "overview" && (c ? <Overview c={c} /> : <div className="repo-loading"><span className="spinner" /></div>)}
        {current === "routes" && !routes && <div className="repo-loading"><span className="spinner" /></div>}
        {current === "routes" && routes && (
          <ContainerForward c={head} pick={more[0] ?? ""} base={`${base}/routes`} routes={reaching} forwards={forwardsOf(head, forwards)}
            users={users} providers={providers} onChanged={onChanged} />
        )}
        {current === "images" && (more[0] === "build" && d ? <BuildLog d={d} number={Number(more[1])} back={`${base}/images`} />
          : more[0] ? <ImageView id={more[0]} back={`${base}/images`} />
          : d ? <Builds d={d} base={`${base}/images`} onChanged={load} />
          : d === null ? <ContainerImages c={head} base={`${base}/images`} /> : <div className="repo-loading"><span className="spinner" /></div>)}
        {current === "settings" && d && <DeploySettings d={d} onChanged={load} />}
        {current === "logs" && <Logs id={head.id} />}
        {current === "resources" && <Resources id={head.id} editable={manage} />}
      </div>
    </>
  );
}

// ContainerForward is every way the container is reached, a tunnel, the
// router or Tailscale, a row each; the picked tunnel's activity and controls
// sit under and beside them. The plus adds one from a dialog.
function ContainerForward({ c, pick, base, routes, forwards, users, providers, onChanged }: {
  c: Container | ContainerDetail;
  pick: string;
  base: string;
  routes: Route[];
  forwards: Forward[];
  users: User[];
  providers: OAuthProvider[];
  onChanged: () => Promise<void>;
}) {
  const can = useCan();
  const [adding, setAdding] = useState(false);
  const picked = routes.find((r) => r.id === pick) ?? routes[0];
  const list = (
    <section className="card">
      <div className="card-head">
        <div className="card-titles"><h2>Routes</h2></div>
        {can("tunnels.create") && <button type="button" className="icon-btn" aria-label="New route" title="New route" onClick={() => setAdding(true)}><Icon name="add" /></button>}
      </div>
      {routes.length || forwards.length ? (
        <ForwardRows items={[...routes.map((r) => ({ r })), ...forwards.map((f) => ({ f }))]} hrefOf={(r) => `${base}/${r.id}`} picked={picked?.id} onChanged={onChanged} />
      ) : <p className="empty-note card-pad">Nothing reaches this container from outside yet.</p>}
    </section>
  );
  return (
    <>
      {picked ? <TunnelDetail route={picked} top={list} users={users} providers={providers} onChanged={onChanged} onRemoved={() => go(base)} /> : list}
      {adding && (
        <Dialog title="New route" wide onClose={() => setAdding(false)}>
          <ForwardComposer users={users} providers={providers} sub={routes.length ? "" : c.name} container={{ name: c.name, reach: reachOf(c) }}
            onDone={async (r) => {
              await onChanged();
              setAdding(false);
              if (r) go(`${base}/${r.id}`);
            }} />
        </Dialog>
      )}
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

// Overview is the container on one page: its usage while it runs, then how it
// is set up, what it runs and how it restarts, its ports and networks, and
// what it has mounted.
function Overview({ c }: { c: ContainerDetail }) {
  return (
    <>
      {live(c) && <Stats id={c.id} />}
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
          <Fact label="Auto-start">{AUTO_START[c.restart_policy] ?? "Off"}</Fact>
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
function Stats({ id }: { id: string }) {
  const m = useMetrics();
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
