import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, bytes, message, type Container, type ContainerAction, type ContainerDetail, type ContainerStats, type Metrics, type Port } from "./api";
import { Chart, Meter, Spark } from "./Dashboard";
import { Dropdown } from "./Dropdown";
import { Icon, type IconName } from "./Icon";
import { useCan } from "./me";
import { ArmedButton, Callout, Copy, Switch, useNotify } from "./ui";

type Act = ContainerAction | "remove";

const DONE: Record<Act, string> = {
  start: "Started", stop: "Stopped", restart: "Restarted", pause: "Paused", unpause: "Resumed", kill: "Killed", remove: "Deleted",
};

const shortId = (id: string) => id.slice(0, 12);
const pct = (n: number) => `${n < 10 ? n.toFixed(2) : n.toFixed(1)}%`;
const rate = (n: number) => `${bytes(n)}/s`;
const live = (c: { state: string }) => c.state === "running";

function tone(state: string) {
  return state === "running" ? "ok" : state === "paused" || state === "restarting" ? "warn" : state === "dead" ? "bad" : "";
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
  const run = async (targets: { id: string; name: string }[], action: Act) => {
    setBusy(new Set(targets.map((t) => t.id)));
    const failed: string[] = [];
    for (const t of targets) {
      try {
        if (action === "remove") await api.removeContainer(t.id);
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

export function ContainersPage({ id, page }: { id: string; page: string }) {
  if (id) return <ContainerPage id={id} tab={page} />;
  return <ContainerList />;
}

// ---- the list ----

function ContainerList() {
  const [list, setList] = useState<Container[] | null>(null);
  const [problem, setProblem] = useState("");
  const [q, setQ] = useState("");
  const [running, setRunning] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const m = useMetrics();
  const can = useCan();

  const load = useCallback(async () => {
    try {
      setList(await api.containers());
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
  const { busy, run } = useActions(load);

  const stats = useMemo(() => Object.fromEntries((m?.docker.containers ?? []).map((s) => [s.id, s])), [m]);
  const needle = q.trim().toLowerCase();
  const shown = (list ?? []).filter((c) => (!running || live(c)) && (!needle || [c.name, c.image, c.id, c.project ?? ""].some((v) => v.toLowerCase().includes(needle))));
  const groups = new Map<string, Container[]>();
  for (const c of [...shown].sort((a, b) => (a.project ?? "￿").localeCompare(b.project ?? "￿") || a.name.localeCompare(b.name))) {
    groups.set(c.project ?? "", [...(groups.get(c.project ?? "") ?? []), c]);
  }
  const selected = (list ?? []).filter((c) => picked.has(c.id));
  const toggle = (ids: string[], on: boolean) => {
    const next = new Set(picked);
    for (const i of ids) {
      if (on) next.add(i);
      else next.delete(i);
    }
    setPicked(next);
  };
  const bulk = async (action: Act, targets: Container[]) => {
    await run(targets.filter((c) => !c.own), action);
    setPicked(new Set());
  };

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Containers</h1>
          {list && <div className="page-sub"><span><b>{list.filter(live).length}</b> running</span><span><b>{list.length}</b> in all</span></div>}
        </div>
        <div className="page-actions">
          <button type="button" className="icon-btn" aria-label="Refresh" title="Refresh" onClick={load}><Icon name="refresh" /></button>
        </div>
      </div>
      {problem && <Callout tone="bad" icon="error">Docker is not reachable: {problem}</Callout>}
      {list && m && <Usage m={m} />}

      <div className="ct-toolbar">
        <label className="ct-search">
          <Icon name="search" size={18} />
          <input type="search" placeholder="Search name, image or ID" aria-label="Search containers" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
        </label>
        <label className="edit-switch">
          <Switch label="Only running" on={running} onChange={setRunning} />
          <span>Only show running containers</span>
        </label>
        <span className="ex-grow" />
        {selected.length > 0 && (
          <div className="ct-bulk">
            <span><b>{selected.length}</b> selected</span>
            {can("containers.manage") && (
              <>
                <button type="button" className="btn small" onClick={() => bulk("start", selected.filter((c) => !live(c)))}><Icon name="play_arrow" size={16} />Start</button>
                <button type="button" className="btn small" onClick={() => bulk("stop", selected.filter(live))}><Icon name="stop" size={16} />Stop</button>
                <button type="button" className="btn small" onClick={() => bulk("restart", selected.filter(live))}><Icon name="restart_alt" size={16} />Restart</button>
              </>
            )}
            {can("containers.remove") && (
              <button type="button" className="btn small danger" onClick={() => bulk("remove", selected.filter((c) => !live(c) && c.state !== "paused"))}><Icon name="delete" size={16} />Delete</button>
            )}
            <button type="button" className="icon-btn small" aria-label="Clear selection" title="Clear selection" onClick={() => setPicked(new Set())}><Icon name="close" size={18} /></button>
          </div>
        )}
      </div>

      {list && (list.length === 0 ? (
        <div className="card welcome">
          <Icon name="deployed_code" size={40} />
          <h2>No containers</h2>
          <p className="muted">Containers on this host show here once Docker runs some.</p>
        </div>
      ) : (
        <div className="card ct-card">
          <div className="table-wrap">
            <table className="table ct-table">
              <thead>
                <tr>
                  <th className="ct-check">
                    <input type="checkbox" className="check" aria-label="Select all"
                      checked={shown.length > 0 && shown.every((c) => picked.has(c.id))}
                      onChange={(e) => toggle(shown.map((c) => c.id), e.target.checked)} />
                  </th>
                  <th className="grow">Name</th>
                  <th>Container ID</th>
                  <th>Image</th>
                  <th>Port(s)</th>
                  <th>CPU (%)</th>
                  <th>Memory</th>
                  <th>Status</th>
                  <th className="ct-actions-head">Actions</th>
                </tr>
              </thead>
              <tbody>
                {[...groups].map(([project, items]) => {
                  const open = !folded.has(project);
                  const cpu = items.reduce((n, c) => n + (live(c) ? stats[c.id]?.cpu ?? 0 : 0), 0);
                  const up = items.filter(live).length;
                  return (
                    <GroupRows key={project || "-"} project={project} open={open} up={up} cpu={cpu} items={items}
                      picked={picked} busy={busy} stats={stats} onPick={toggle}
                      onFold={() => setFolded((f) => {
                        const next = new Set(f);
                        if (next.has(project)) next.delete(project);
                        else next.add(project);
                        return next;
                      })}
                      onRun={(targets, action) => run(targets, action)} />
                  );
                })}
                {shown.length === 0 && <tr><td colSpan={9} className="empty-note ct-none">No containers match.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </>
  );
}

// Usage is the containers' CPU and memory together, as Docker Desktop shows
// them over the list.
function Usage({ m }: { m: Metrics }) {
  const running = m.docker.containers.filter(live);
  const cpu = running.reduce((n, c) => n + c.cpu, 0);
  const memory = running.reduce((n, c) => n + c.memory, 0);
  const longest = Math.max(0, ...running.map((c) => c.history.length));
  const history = Array.from({ length: longest }, (_, i) =>
    running.reduce((n, c) => n + (c.history[c.history.length - longest + i] ?? 0), 0));
  const ceiling = m.host.threads * 100;
  return (
    <div className="ct-usage">
      <div className="ct-stat">
        <span>Container CPU usage</span>
        <b>{pct(cpu)}<small> / {ceiling}% ({m.host.threads} CPUs available)</small></b>
        <Spark values={history} max={Math.max(100, ...history)} keep={m.keep} times={[]} every={0} color="var(--s1)" />
      </div>
      <div className="ct-stat">
        <span>Container memory usage</span>
        <b>{bytes(memory)}<small> / {bytes(m.memory_total)}</small></b>
        <Meter value={memory} max={m.memory_total} label={pct((memory / (m.memory_total || 1)) * 100)} />
      </div>
    </div>
  );
}

function GroupRows({ project, open, up, cpu, items, picked, busy, stats, onPick, onFold, onRun }: {
  project: string;
  open: boolean;
  up: number;
  cpu: number;
  items: Container[];
  picked: Set<string>;
  busy: Set<string>;
  stats: Record<string, ContainerStats>;
  onPick: (ids: string[], on: boolean) => void;
  onFold: () => void;
  onRun: (targets: Container[], action: Act) => void;
}) {
  const can = useCan();
  const ids = items.map((c) => c.id);
  return (
    <>
      {project && (
        <tr className="ct-group">
          <td className="ct-check"><input type="checkbox" className="check" aria-label={`Select ${project}`} checked={ids.every((i) => picked.has(i))} onChange={(e) => onPick(ids, e.target.checked)} /></td>
          <td>
            <button type="button" className="ct-fold" aria-expanded={open} onClick={onFold}>
              <Icon name="chevron_right" size={18} className={open ? "open" : ""} />
              <Icon name="deployed_code" size={18} className="ct-stack-icon" />
              <b>{project}</b>
            </button>
          </td>
          <td colSpan={3} className="muted">{items.length} container{items.length === 1 ? "" : "s"}, {up} running</td>
          <td className="num">{up ? pct(cpu) : ""}</td>
          <td />
          <td><span className={"chip " + (up === items.length ? "ok" : up ? "warn" : "")}>{up === items.length ? "Running" : up ? "Partly running" : "Exited"}</span></td>
          <td>
            {can("containers.manage") && (
              <span className="row-actions">
                {up < items.length && <button type="button" className="icon-btn small" aria-label={`Start ${project}`} title="Start all" onClick={() => onRun(items.filter((c) => !live(c) && !c.own), "start")}><Icon name="play_arrow" size={18} /></button>}
                {up > 0 && <button type="button" className="icon-btn small" aria-label={`Stop ${project}`} title="Stop all" onClick={() => onRun(items.filter((c) => live(c) && !c.own), "stop")}><Icon name="stop" size={18} /></button>}
              </span>
            )}
          </td>
        </tr>
      )}
      {open && items.map((c) => {
        const s = stats[c.id];
        const on = live(c);
        return (
          <tr key={c.id} className={(on ? "" : "stopped") + (project ? " in-group" : "") + (picked.has(c.id) ? " picked" : "")}>
            <td className="ct-check"><input type="checkbox" className="check" aria-label={`Select ${c.name}`} checked={picked.has(c.id)} onChange={(e) => onPick([c.id], e.target.checked)} /></td>
            <td className="name-cell">
              <a className="name-line" href={`#/containers/${c.id}`}>
                <span className={"dot " + tone(c.state)} title={c.state} />{c.name}
                {c.own && <span className="chip plain small-chip">myTunnels</span>}
              </a>
            </td>
            <td><span className="ct-id"><span className="mono">{shortId(c.id)}</span><Copy text="" copyText={c.id} plain /></span></td>
            <td className="ct-image mono" title={c.image}>{c.image}</td>
            <td><PortLinks ports={c.ports} /></td>
            <td className="num">{on && s ? pct(s.cpu) : <span className="muted">N/A</span>}</td>
            <td className="num">{on && s ? bytes(s.memory) : ""}</td>
            <td className="muted">{c.status}</td>
            <td>
              <span className="row-actions">
                {busy.has(c.id) ? <span className="spinner small" /> : (
                  <>
                    {can("containers.manage") && !c.own && (on ? (
                      <button type="button" className="icon-btn small" aria-label={`Stop ${c.name}`} title="Stop" onClick={() => onRun([c], "stop")}><Icon name="stop" size={18} /></button>
                    ) : c.state === "paused" ? (
                      <button type="button" className="icon-btn small" aria-label={`Resume ${c.name}`} title="Resume" onClick={() => onRun([c], "unpause")}><Icon name="play_arrow" size={18} /></button>
                    ) : (
                      <button type="button" className="icon-btn small" aria-label={`Start ${c.name}`} title="Start" onClick={() => onRun([c], "start")}><Icon name="play_arrow" size={18} /></button>
                    ))}
                    {can("containers.manage") && !c.own && on && (
                      <button type="button" className="icon-btn small" aria-label={`Restart ${c.name}`} title="Restart" onClick={() => onRun([c], "restart")}><Icon name="restart_alt" size={18} /></button>
                    )}
                    <a className="icon-btn small" href={`#/containers/${c.id}/logs`} aria-label={`Logs of ${c.name}`} title="Logs"><Icon name="terminal" size={18} /></a>
                    {can("containers.remove") && !c.own && (
                      <button type="button" className="icon-btn small danger" aria-label={`Delete ${c.name}`} title={on ? "Stop it to delete it" : "Delete"}
                        disabled={on || c.state === "paused"} onClick={() => onRun([c], "remove")}><Icon name="delete" size={18} /></button>
                    )}
                  </>
                )}
              </span>
            </td>
          </tr>
        );
      })}
    </>
  );
}

// ---- one container ----

const TABS: [string, string, IconName][] = [
  ["logs", "Logs", "terminal"],
  ["inspect", "Inspect", "info"],
  ["mounts", "Mounts", "folder"],
  ["stats", "Stats", "dashboard"],
];

function ContainerPage({ id, tab }: { id: string; tab: string }) {
  const [c, setC] = useState<ContainerDetail | null>(null);
  const [problem, setProblem] = useState("");
  const current = TABS.some(([k]) => k === tab) ? tab : "logs";
  const can = useCan();

  const load = useCallback(async () => {
    try {
      setC(await api.container(id));
      setProblem("");
    } catch (e) {
      setProblem(message(e));
    }
  }, [id]);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);
  const { busy, run } = useActions(load);

  if (!c) return problem ? <Callout tone="bad" icon="error">{problem}</Callout> : null;
  const on = live(c);
  const working = busy.size > 0;
  const act = (action: Act) => run([c], action).then(() => {
    if (action === "remove") location.hash = "#/containers";
  });

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1 className="d-crumbs">
            <span className="ex-crumb-wrap"><a className="d-crumb" href="#/containers">Containers</a></span>
            <span className="ex-crumb-wrap"><Icon name="chevron_right" size={24} className="ex-crumb-sep" /><span className="d-crumb on">{c.name}</span></span>
          </h1>
          <div className="page-sub">
            <span className={"chip " + tone(c.state)}>{c.state}</span>
            {c.health && <span className={"chip " + (c.health === "healthy" ? "ok" : c.health === "unhealthy" ? "bad" : "warn")}>{c.health}</span>}
            <span className="mono">{c.image}</span>
            <span className="ct-id"><span className="mono">{shortId(c.id)}</span><Copy text="" copyText={c.id} plain /></span>
            <PortLinks ports={c.ports} max={6} />
          </div>
        </div>
        <div className="page-actions">
          {working && <span className="spinner small" />}
          {can("containers.manage") && (c.own ? (
            <ArmedButton icon="restart_alt" label="Restart" armedLabel="Restart myTunnels" onConfirm={() => act("restart")} />
          ) : (
            <>
              {on ? <button type="button" className="btn" disabled={working} onClick={() => act("stop")}><Icon name="stop" size={18} />Stop</button>
                : c.state === "paused" ? <button type="button" className="btn primary" disabled={working} onClick={() => act("unpause")}><Icon name="play_arrow" size={18} />Resume</button>
                : <button type="button" className="btn primary" disabled={working} onClick={() => act("start")}><Icon name="play_arrow" size={18} />Start</button>}
              {on && <button type="button" className="btn" disabled={working} onClick={() => act("restart")}><Icon name="restart_alt" size={18} />Restart</button>}
              {on && <button type="button" className="btn" disabled={working} onClick={() => act("pause")}><Icon name="pause" size={18} />Pause</button>}
            </>
          ))}
          {can("containers.remove") && !c.own && !on && c.state !== "paused" && (
            <ArmedButton icon="delete" label="Delete" armedLabel="Delete for good" onConfirm={() => act("remove")} />
          )}
        </div>
      </div>
      <nav className="sub-nav" aria-label="Container">
        {TABS.map(([key, label, icon]) => (
          <a key={key} className={"sub-nav-item" + (current === key ? " on" : "")} href={`#/containers/${c.id}/${key}`} aria-current={current === key ? "page" : undefined}>
            <Icon name={icon} size={18} />
            <span>{label}</span>
          </a>
        ))}
      </nav>
      <div className="page-body stack" key={current}>
        {problem && <Callout tone="bad" icon="error">{problem}</Callout>}
        {current === "logs" && <Logs id={c.id} />}
        {current === "inspect" && <Inspect c={c} />}
        {current === "mounts" && <Mounts c={c} />}
        {current === "stats" && <Stats id={c.id} running={on} />}
      </div>
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

// Inspect is how the container is set up: what it runs, how it restarts, its
// ports and networks.
function Inspect({ c }: { c: ContainerDetail }) {
  return (
    <div className="ct-inspect">
      <section className="card ct-panel">
        <h2>Overview</h2>
        <Fact label="Name">{c.name}</Fact>
        <Fact label="ID"><span className="ct-id"><span className="mono">{c.id}</span></span></Fact>
        <Fact label="Image"><span className="mono">{c.image}</span></Fact>
        <Fact label="Command"><span className="mono">{c.command || "None"}</span></Fact>
        <Fact label="Working folder"><span className="mono">{c.workdir || "/"}</span></Fact>
        {c.project && <Fact label="Compose">{c.project}, service {c.service ?? ""}</Fact>}
      </section>
      <section className="card ct-panel">
        <h2>State</h2>
        <Fact label="Status"><span className={"chip " + tone(c.state)}>{c.state}</span></Fact>
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
  );
}

// Mounts are the volumes and host folders the container sees, and where.
function Mounts({ c }: { c: ContainerDetail }) {
  if (!c.mounts.length) {
    return <div className="card welcome"><Icon name="folder" size={40} /><h2>Nothing mounted</h2><p className="muted">This container keeps no volumes or host folders.</p></div>;
  }
  return (
    <div className="card">
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
    </div>
  );
}

// Stats is the container's usage, sampled with the host's.
function Stats({ id, running }: { id: string; running: boolean }) {
  const m = useMetrics();
  if (!running) return <div className="card welcome"><Icon name="dashboard" size={40} /><h2>Not running</h2><p className="muted">Usage shows while the container runs.</p></div>;
  const s = m?.docker.containers.find((x) => x.id === id);
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
