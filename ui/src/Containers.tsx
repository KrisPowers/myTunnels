import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, bytes, message, type Container, type ContainerAction, type ContainerDetail, type ContainerStats, type Metrics, type Port } from "./api";
import { Chart, Meter } from "./Dashboard";
import { Dropdown } from "./Dropdown";
import { Icon, type IconName } from "./Icon";
import { useCan } from "./me";
import { ArmedButton, Callout, Copy, MoreMenu, Switch, useNotify, type MenuAction } from "./ui";

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

// The containers as last listed, so one opens at once with what the list knew
// while its full details load.
const listed = new Map<string, Container>();

type Show = "all" | "running";

// ContainerList is a row per container: its state, name and image, published
// ports, CPU, memory and how long it has run, everything else behind its
// menu. Compose projects of two or more fold under their name.
function ContainerList() {
  const [list, setList] = useState<Container[] | null>(null);
  const [problem, setProblem] = useState("");
  const [q, setQ] = useState("");
  const [show, setShow] = useState<Show>("all");
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const m = useMetrics();

  const load = useCallback(async () => {
    try {
      const next = await api.containers();
      listed.clear();
      for (const c of next) listed.set(c.id, c);
      setList(next);
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

  // Usage is sampled under each container's short ID.
  const stats = useMemo(() => Object.fromEntries((m?.docker.containers ?? []).map((s) => [shortId(s.id), s])), [m]);
  const needle = q.trim().toLowerCase();
  const shown = (list ?? []).filter((c) => (show === "all" || live(c)) && (!needle || [c.name, c.image, c.id, c.project ?? ""].some((v) => v.toLowerCase().includes(needle))));
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

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Containers</h1>
          {list && (
            <div className="page-sub">
              <span><b>{running.length}</b> of {list.length} running</span>
              {m && <span>CPU <b>{pct(cpu)}</b> of {m.host.threads * 100}%</span>}
              {m && <span>Memory <b>{bytes(memory)}</b> of {bytes(m.memory_total)}</span>}
            </div>
          )}
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
        </div>
      </div>
      {problem && <Callout tone="bad" icon="error">Docker is not reachable: {problem}</Callout>}

      {list && (list.length === 0 ? (
        <div className="card welcome">
          <Icon name="deployed_code" size={40} />
          <h2>No containers</h2>
          <p className="muted">Containers on this host show here once Docker runs some.</p>
        </div>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table className="table ct-table">
              <thead>
                <tr><th className="grow">Container</th><th>Ports</th><th>CPU</th><th>Memory</th><th>Status</th><th aria-label="Actions" /></tr>
              </thead>
              <tbody>
                {rows.map((r) => "group" in r ? (
                  <Group key={"g-" + r.group} name={r.group} items={r.items} stats={stats} busy={busy} run={run}
                    open={!folded.has(r.group)}
                    onFold={() => setFolded((f) => {
                      const next = new Set(f);
                      if (next.has(r.group)) next.delete(r.group);
                      else next.add(r.group);
                      return next;
                    })} />
                ) : (
                  <Row key={r.id} c={r} s={stats[shortId(r.id)]} busy={busy.has(r.id)} run={run} />
                ))}
                {shown.length === 0 && <tr><td colSpan={6} className="empty-note ct-none">No containers match.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </>
  );
}

// The actions a container's menu holds, by what it may do now.
function rowActions(c: Container | ContainerDetail, run: (targets: { id: string; name: string }[], action: Act) => void, can: (key: string) => boolean): MenuAction[] {
  const on = live(c);
  const manage = can("containers.manage");
  return [
    { label: "Logs", icon: "terminal" as IconName, onClick: () => (location.hash = `#/containers/${c.id}/logs`) },
    ...(manage && !c.own && on ? [{ label: "Stop", icon: "stop" as IconName, onClick: () => run([c], "stop") }] : []),
    ...(manage && !c.own && c.state === "paused" ? [{ label: "Resume", icon: "play_arrow" as IconName, onClick: () => run([c], "unpause") }] : []),
    ...(manage && !on && c.state !== "paused" ? [{ label: "Start", icon: "play_arrow" as IconName, onClick: () => run([c], "start") }] : []),
    ...(manage && on ? [{ label: "Restart", icon: "restart_alt" as IconName, onClick: () => run([c], "restart"), confirm: c.own ? "Restart myTunnels" : undefined }] : []),
    ...(can("containers.remove") && !c.own && !on && c.state !== "paused"
      ? [{ label: "Delete", icon: "delete" as IconName, danger: true, onClick: () => run([c], "remove"), confirm: "Delete for good" }] : []),
  ];
}

function Row({ c, s, busy, run, grouped }: {
  c: Container;
  s?: ContainerStats;
  busy: boolean;
  run: (targets: { id: string; name: string }[], action: Act) => void;
  grouped?: boolean;
}) {
  const can = useCan();
  const on = live(c);
  return (
    <tr className={(on ? "" : "stopped") + (grouped ? " in-group" : "")}>
      <td>
        <a className="ct-name" href={`#/containers/${c.id}`}>
          <span className={"dot " + tone(c.state)} title={c.state} />
          <span className="ct-name-text">
            <b>{c.name}{c.own && <span className="chip plain small-chip">myTunnels</span>}</b>
            <small className="mono" title={c.image}>{c.image}</small>
          </span>
        </a>
      </td>
      <td><PortLinks ports={c.ports} max={2} /></td>
      <td className="num">{on && s ? pct(s.cpu) : "–"}</td>
      <td className="num">{on && s ? bytes(s.memory) : "–"}</td>
      <td className="muted ct-status">{c.status}</td>
      <td className="ct-menu">{busy ? <span className="spinner small" /> : <MoreMenu label={`Actions for ${c.name}`} actions={rowActions(c, run, can)} />}</td>
    </tr>
  );
}

function Group({ name, items, stats, busy, run, open, onFold }: {
  name: string;
  items: Container[];
  stats: Record<string, ContainerStats>;
  busy: Set<string>;
  run: (targets: { id: string; name: string }[], action: Act) => void;
  open: boolean;
  onFold: () => void;
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
      {open && items.map((c) => <Row key={c.id} c={c} s={stats[shortId(c.id)]} busy={busy.has(c.id)} run={run} grouped />)}
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

  // What the list knew draws the page at once; the full details fill it in.
  const head = c ?? listed.get(id);
  if (!head) {
    return problem ? <Callout tone="bad" icon="error">{problem}</Callout> : (
      <>
        <div className="page-head"><div className="page-head-main"><h1 className="d-crumbs"><span className="ex-crumb-wrap"><a className="d-crumb" href="#/containers">Containers</a></span></h1></div></div>
        <div className="repo-loading"><span className="spinner" /></div>
      </>
    );
  }
  const on = live(head);
  const working = busy.size > 0;
  const act = (action: Act) => run([head], action).then(() => {
    if (action === "remove") location.hash = "#/containers";
  });

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1 className="d-crumbs">
            <span className="ex-crumb-wrap"><a className="d-crumb" href="#/containers">Containers</a></span>
            <span className="ex-crumb-wrap"><Icon name="chevron_right" size={24} className="ex-crumb-sep" /><span className="d-crumb on">{head.name}</span></span>
          </h1>
          <div className="page-sub">
            <span className={"chip " + tone(head.state)}>{head.state}</span>
            {c?.health && <span className={"chip " + (c.health === "healthy" ? "ok" : c.health === "unhealthy" ? "bad" : "warn")}>{c.health}</span>}
            <span className="mono">{head.image}</span>
            <span className="ct-id"><span className="mono">{shortId(head.id)}</span><Copy text="" copyText={head.id} plain /></span>
            <PortLinks ports={head.ports} max={6} />
          </div>
        </div>
        <div className="page-actions">
          {working && <span className="spinner small" />}
          {can("containers.manage") && (head.own ? (
            <ArmedButton icon="restart_alt" label="Restart" armedLabel="Restart myTunnels" onConfirm={() => act("restart")} />
          ) : (
            <>
              {on ? <button type="button" className="btn" disabled={working} onClick={() => act("stop")}><Icon name="stop" size={18} />Stop</button>
                : head.state === "paused" ? <button type="button" className="btn primary" disabled={working} onClick={() => act("unpause")}><Icon name="play_arrow" size={18} />Resume</button>
                : <button type="button" className="btn primary" disabled={working} onClick={() => act("start")}><Icon name="play_arrow" size={18} />Start</button>}
              {on && <button type="button" className="btn" disabled={working} onClick={() => act("restart")}><Icon name="restart_alt" size={18} />Restart</button>}
              {on && <button type="button" className="btn" disabled={working} onClick={() => act("pause")}><Icon name="pause" size={18} />Pause</button>}
            </>
          ))}
          {can("containers.remove") && !head.own && !on && head.state !== "paused" && (
            <ArmedButton icon="delete" label="Delete" armedLabel="Delete for good" onConfirm={() => act("remove")} />
          )}
        </div>
      </div>
      <nav className="sub-nav" aria-label="Container">
        {TABS.map(([key, label, icon]) => (
          <a key={key} className={"sub-nav-item" + (current === key ? " on" : "")} href={`#/containers/${head.id}/${key}`} aria-current={current === key ? "page" : undefined}>
            <Icon name={icon} size={18} />
            <span>{label}</span>
          </a>
        ))}
      </nav>
      <div className="page-body stack" key={current}>
        {problem && <Callout tone="bad" icon="error">{problem}</Callout>}
        {current === "logs" && <Logs id={head.id} />}
        {current === "inspect" && (c ? <Inspect c={c} /> : <div className="repo-loading"><span className="spinner" /></div>)}
        {current === "mounts" && (c ? <Mounts c={c} /> : <div className="repo-loading"><span className="spinner" /></div>)}
        {current === "stats" && <Stats id={head.id} running={on} />}
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
