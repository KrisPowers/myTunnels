import { useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { NeedsApp, NeedsContext } from "./Apps";
import { api, bytes, message, type Container, type ContainerAction, type ContainerStats, type Deploy, type Image, type Metrics } from "./api";
import { AddButton, sourceOf } from "./Builds";
import { Dropdown, type Option } from "./Dropdown";
import { Icon, type IconName } from "./Icon";
import { useImageRemoval } from "./Images";
import { useCan } from "./me";
import { go } from "./route";
import { Callout, MoreMenu, useNotify, type MenuAction } from "./ui";

// ContainerList is the containers Docker runs here, one table: each with
// where it comes from, its status, and its CPU and memory. A Compose project
// folds under a row of its own. A row opens the container. Add container is
// the one way in; exposing one's port is a route's job.

type Show = "all" | "running" | "stopped";
const SHOW: Option<Show>[] = [
  { value: "all", label: "All containers" },
  { value: "running", label: "Running" },
  { value: "stopped", label: "Stopped" },
];

const STATE: Record<string, [string, string]> = {
  running: ["Running", "ok"], paused: ["Paused", "warn"], restarting: ["Restarting", "warn"], building: ["Building", "warn"],
  created: ["Created", ""], exited: ["Stopped", ""], dead: ["Dead", "bad"], failed: ["Build failed", "bad"],
};
const stateOf = (s: string): [string, string] => STATE[s] ?? [s.charAt(0).toUpperCase() + s.slice(1), ""];
const pct = (n: number) => `${n < 10 ? n.toFixed(1) : Math.round(n)}%`;
const short = (id: string) => id.slice(0, 12);

// The containers as last listed, by name, so one opens at once.
export const listed = new Map<string, Container>();

export function ContainerList({ onChanged }: { onChanged: () => Promise<void> }) {
  const can = useCan();
  const notify = useNotify();
  const needs = useContext(NeedsContext);
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
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    let alive = true;
    const run = () => api.metrics().then((m) => alive && setMetrics(m)).catch(() => {});
    run();
    const t = setInterval(run, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  const cleanup = useImageRemoval(load);

  const act = async (name: string, work: () => Promise<unknown>, done: string) => {
    setBusy(name);
    try {
      await work();
      notify(done);
    } catch (e) {
      notify(message(e), "bad");
    }
    setBusy("");
    await Promise.all([load(), onChanged()]);
  };

  const stats = useMemo(() => new Map((metrics?.docker.containers ?? []).map((s) => [short(s.id), s])), [metrics]);
  const byDeploy = new Map(deploys.map((d) => [d.id, d]));
  const made = new Set((list ?? []).map((c) => c.name));
  const all: Container[] = [
    ...(list ?? []),
    // A container from a repository whose first build has not made it yet.
    ...deploys.filter((d) => !made.has(d.name)).map((d): Container => ({
      id: "", name: d.name, image: sourceOf(d), state: d.latest?.status === "failed" ? "failed" : "building", status: "",
      created: d.created_at, ports: [], project: null, service: null, deploy: d.id, own: false,
    })),
  ];
  const needle = q.trim().toLowerCase();
  const shown = all
    .filter((c) => show === "all" || (show === "running") === (c.state === "running"))
    .filter((c) => !needle || [c.name, c.image, c.project ?? ""].some((v) => v.toLowerCase().includes(needle)))
    .sort((a, b) => (a.project ?? a.name).localeCompare(b.project ?? b.name) || a.name.localeCompare(b.name));
  const counts = new Map<string, number>();
  for (const c of shown) if (c.project) counts.set(c.project, (counts.get(c.project) ?? 0) + 1);

  const running = all.filter((c) => c.state === "running");
  const cpu = running.reduce((n, c) => n + (stats.get(short(c.id))?.cpu ?? 0), 0);
  const memory = running.reduce((n, c) => n + (stats.get(short(c.id))?.memory ?? 0), 0);
  const unused = images.filter((i) => !i.containers.length);
  const noDocker = !!needs && !needs.docker;

  const menuOf = (c: Container): MenuAction[] => {
    const d = c.deploy ? byDeploy.get(c.deploy) : undefined;
    const on = c.state === "running";
    const manage = can("containers.manage") && !c.own && !!c.id;
    const doing = (action: ContainerAction, done: string) => () => act(c.name, () => api.containerAction(c.id, action), `${done} ${c.name}`);
    return [
      ...(manage && !on ? [{ label: "Start", icon: "play_arrow" as IconName, onClick: doing("start", "Started") }] : []),
      ...(manage && on ? [{ label: "Restart", icon: "restart_alt" as IconName, onClick: doing("restart", "Restarted") }] : []),
      ...(manage && on ? [{ label: "Stop", icon: "stop" as IconName, onClick: doing("stop", "Stopped") }] : []),
      ...(c.id ? [{ label: "Logs", icon: "terminal" as IconName, onClick: () => go(`#/containers/${encodeURIComponent(c.name)}/logs`) }] : []),
      ...(can("containers.remove") && !c.own && !on ? [{
        label: "Delete", icon: "delete" as IconName, danger: true, confirm: "Delete for good",
        onClick: () => act(c.name, () => (d ? api.removeDeploy(d.id) : api.removeContainer(c.id)), `Deleted ${c.name}`),
      }] : []),
    ];
  };

  const body: ReactNode[] = [];
  let group = "";
  for (const c of shown) {
    const grouped = !!c.project && (counts.get(c.project) ?? 0) > 1;
    if (grouped && c.project !== group) {
      const members = shown.filter((x) => x.project === c.project);
      const open = !folded.has(c.project!);
      body.push(
        <tr key={"g" + c.project} className="svc-group" onClick={() => setFolded((f) => {
          const next = new Set(f);
          if (next.has(c.project!)) next.delete(c.project!);
          else next.add(c.project!);
          return next;
        })}>
          <td colSpan={6}>
            <span className="svc-group-name">
              <Icon name="chevron_right" size={18} className={open ? "open" : ""} />
              <b>{c.project}</b>
              <small>{members.filter((x) => x.state === "running").length} of {members.length} running</small>
            </span>
          </td>
        </tr>,
      );
    }
    group = grouped ? c.project! : "";
    if (grouped && folded.has(c.project!)) continue;
    const d = c.deploy ? byDeploy.get(c.deploy) : undefined;
    body.push(
      <Row key={c.id || c.name} c={c} inGroup={grouped} busy={busy === c.name}
        icon={d ? (d.image ? "layers" : "git") : "deployed_code"}
        source={d ? `${sourceOf(d)}${d.branch ? `, ${d.branch}` : ""}` : c.image}
        ports={c.ports.filter((p) => p.public !== null).map((p) => p.public!)} stats={c.id ? stats.get(short(c.id)) : undefined} menu={menuOf(c)} />,
    );
  }

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Containers</h1>
          {list && (
            <div className="page-sub">
              <span><b>{running.length}</b> of {all.length} running</span>
              {metrics && running.length > 0 && <span>CPU <b>{pct(cpu)}</b></span>}
              {metrics && running.length > 0 && <span>Memory <b>{bytes(memory)}</b></span>}
            </div>
          )}
        </div>
        <div className="page-actions">
          {all.length > 0 && (
            <>
              <label className="ct-search">
                <Icon name="search" size={18} />
                <input type="search" placeholder="Search" aria-label="Search containers" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
              </label>
              <div className="ex-pick"><Dropdown label="Show" value={show} options={SHOW} onChange={setShow} /></div>
            </>
          )}
          {can("containers.remove") && unused.length > 0 && (cleanup.busy ? <span className="spinner small" /> : (
            <MoreMenu label="More" actions={[{ label: `Delete unused images, ${bytes(unused.reduce((n, i) => n + i.size, 0))}`, icon: "layers", danger: true, confirm: `Delete ${unused.length} for good`, onClick: () => cleanup.remove(unused) }]} />
          ))}
          <AddButton />
        </div>
      </div>

      <div className="page-body stack">
        <NeedsApp app="docker" what="Containers" />
        {problem && !noDocker && <Callout tone="bad" icon="error">Docker is not reachable: {problem}</Callout>}
        {!list ? (!problem && <div className="repo-loading"><span className="spinner" /></div>) : all.length === 0 ? (
          <div className="welcome"><Icon name="deployed_code" size={48} /></div>
        ) : (
          <div className="card svc-card">
            <div className="table-wrap">
              <table className="table svc">
                <thead>
                  <tr><th className="grow">Container</th><th>Status</th><th>Ports</th><th className="svc-num">CPU</th><th className="svc-num">Memory</th><th /></tr>
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
    </>
  );
}

function Row({ c, inGroup, busy, icon, source, ports, stats, menu }: {
  c: Container; inGroup: boolean; busy: boolean; icon: IconName; source: string;
  ports: number[]; stats?: ContainerStats; menu: MenuAction[];
}) {
  const [label, tone] = stateOf(c.state);
  const on = c.state === "running";
  const href = `#/containers/${encodeURIComponent(c.name)}`;
  return (
    <tr className={"svc-link" + (on ? "" : " svc-down")} onClick={() => go(href)}>
      <td>
        <span className={"svc-name" + (inGroup ? " in-group" : "")}>
          <span className={"svc-icon " + tone}><Icon name={icon} size={18} /></span>
          <span className="svc-text"><b>{c.name}{c.own && <span className="chip plain small-chip">myTunnels</span>}</b><small>{source}</small></span>
        </span>
      </td>
      <td><span className={"chip " + tone}><span className={"dot " + tone} />{label}</span></td>
      <td><span className="svc-address mono">{[...new Set(ports)].sort((a, b) => a - b).join(", ")}</span></td>
      <td className="svc-num">{on && stats ? pct(stats.cpu) : ""}</td>
      <td className="svc-num">{on && stats ? bytes(stats.memory) : ""}</td>
      <td className="svc-menu" onClick={(e) => e.stopPropagation()}>
        {busy ? <span className="spinner small" /> : menu.length > 0 && <MoreMenu label={`Actions for ${c.name}`} actions={menu} />}
      </td>
    </tr>
  );
}
