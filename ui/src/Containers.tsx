import { useCallback, useEffect, useRef, useState } from "react";
import { api, bytes, message, type Container, type ContainerAction, type ContainerDetail, type ContainerStats, type Port } from "./api";
import { Dropdown } from "./Dropdown";
import { Icon, type IconName } from "./Icon";
import { Callout, Card, MoreMenu, Row, SubNav, Switch, useNotify, type MenuAction } from "./ui";

const PAGES: [string, string, IconName][] = [
  ["overview", "Overview", "info"],
  ["logs", "Logs", "terminal"],
];

const DONE: Record<ContainerAction | "remove", string> = {
  start: "Started", stop: "Stopped", restart: "Restarted", pause: "Paused", unpause: "Resumed", kill: "Killed", remove: "Removed",
};

// useContainerAction runs an action on a container, says how it went, then
// reloads.
function useContainerAction(reload: () => Promise<void>) {
  const notify = useNotify();
  const [busy, setBusy] = useState("");
  const run = async (c: { id: string; name: string }, action: ContainerAction | "remove") => {
    setBusy(c.id);
    try {
      if (action === "remove") await api.removeContainer(c.id);
      else await api.containerAction(c.id, action);
      notify(`${DONE[action]} ${c.name}`);
    } catch (e) {
      notify(message(e), "bad");
    } finally {
      setBusy("");
      await reload();
    }
  };
  return { busy, run };
}

// The less frequent actions, under the three dots. Anything that would stop
// myTunnels itself asks once more.
function moreActions(c: { id: string; name: string; state: string; own: boolean }, run: (action: ContainerAction | "remove") => void, logs?: string): MenuAction[] {
  const running = c.state === "running";
  const self = c.own ? "This stops the dashboard" : undefined;
  return [
    ...(logs ? [{ label: "Logs", icon: "terminal" as IconName, onClick: () => (location.hash = logs) }] : []),
    ...(running ? [{ label: "Restart", icon: "restart_alt" as IconName, onClick: () => run("restart"), confirm: c.own ? "Restart myTunnels" : undefined }] : []),
    ...(running ? [{ label: "Pause", icon: "pause" as IconName, onClick: () => run("pause"), confirm: self }] : []),
    ...(c.state === "paused" ? [{ label: "Resume", icon: "play_arrow" as IconName, onClick: () => run("unpause") }] : []),
    ...(running ? [{ label: "Kill", icon: "block" as IconName, danger: true, onClick: () => run("kill"), confirm: self ?? "Kill it now" }] : []),
    ...(!running && c.state !== "paused" ? [{ label: "Remove", icon: "delete" as IconName, danger: true, onClick: () => run("remove"), confirm: "Remove for good" }] : []),
  ];
}

function tone(state: string) {
  return state === "running" ? "ok" : state === "paused" || state === "restarting" ? "warn" : state === "dead" ? "bad" : "";
}

function PortList({ ports }: { ports: Port[] }) {
  const shown = ports.filter((p) => p.public !== null);
  if (!shown.length) return null;
  return (
    <span className="chips">
      {shown.map((p) => (
        <span key={`${p.public}-${p.private}-${p.type}`} className="chip mono" title={`Host port ${p.public} to container port ${p.private}/${p.type}`}>
          {p.public}:{p.private}{p.type === "udp" ? "/udp" : ""}
        </span>
      ))}
    </span>
  );
}

// ContainersPage is every container the engine has, grouped by Compose
// project, each with its usage and a way to start, stop or remove it; or one
// container, when `id` is given.
export function ContainersPage({ id, page }: { id: string; page: string }) {
  if (id) return <ContainerPage id={id} page={page} />;
  return <ContainerList />;
}

function ContainerList() {
  const [list, setList] = useState<Container[] | null>(null);
  const [stats, setStats] = useState<Record<string, ContainerStats>>({});
  const [problem, setProblem] = useState("");

  const load = useCallback(async () => {
    const [c, m] = await Promise.allSettled([api.containers(), api.metrics()]);
    if (c.status === "fulfilled") {
      setList(c.value);
      setProblem("");
    } else {
      setProblem(message(c.reason));
    }
    if (m.status === "fulfilled") setStats(Object.fromEntries(m.value.docker.containers.map((s) => [s.id, s])));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);
  const { busy, run } = useContainerAction(load);

  const running = list?.filter((c) => c.state === "running").length ?? 0;
  // Projects first, by name, then containers on their own.
  const groups = new Map<string, Container[]>();
  for (const c of [...(list ?? [])].sort((a, b) => (a.project ?? "￿").localeCompare(b.project ?? "￿") || a.name.localeCompare(b.name))) {
    const key = c.project ?? "";
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Containers</h1>
          {list && <div className="page-sub"><span><b>{running}</b> running of {list.length}</span></div>}
        </div>
        <div className="page-actions">
          <button type="button" className="icon-btn" aria-label="Refresh" title="Refresh" onClick={load}><Icon name="refresh" /></button>
        </div>
      </div>
      {problem && <Callout tone="bad" icon="error">Docker is not reachable: {problem}</Callout>}
      {list && (
        <div className="page-body">
          {list.length === 0 ? (
            <div className="card welcome">
              <Icon name="deployed_code" size={40} />
              <h2>No containers</h2>
              <p className="muted">Containers on this host show here once Docker runs some.</p>
            </div>
          ) : (
            <div className="card">
              <div className="table-wrap">
                <table className="table containers">
                  <thead>
                    <tr><th className="grow">Container</th><th>Ports</th><th>CPU</th><th>Memory</th><th>Status</th><th aria-label="Actions" /></tr>
                  </thead>
                  <tbody>
                    {[...groups].map(([project, items]) => (
                      <Group key={project || "-"} project={project} items={items} stats={stats} busy={busy} run={run} />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function Group({ project, items, stats, busy, run }: {
  project: string;
  items: Container[];
  stats: Record<string, ContainerStats>;
  busy: string;
  run: (c: Container, action: ContainerAction | "remove") => Promise<void>;
}) {
  return (
    <>
      {project && (
        <tr className="group-row">
          <td colSpan={6}><Icon name="deployed_code" size={18} /><span>{project}</span><small>{items.filter((c) => c.state === "running").length} of {items.length} running</small></td>
        </tr>
      )}
      {items.map((c) => {
        const live = c.state === "running";
        const s = stats[c.id];
        return (
          <tr key={c.id} className={live ? "" : "stopped"}>
            <td className="name-cell">
              <a className="name-line" href={`#/containers/${c.id}`}><span className={"dot " + tone(c.state)} />{c.name}{c.own && <span className="chip plain">myTunnels</span>}</a>
              <small>{c.image}</small>
            </td>
            <td><PortList ports={c.ports} /></td>
            <td className="num">{live && s ? `${s.cpu < 10 ? s.cpu.toFixed(1) : Math.round(s.cpu)}%` : ""}</td>
            <td className="num">{live && s ? bytes(s.memory) : ""}</td>
            <td className="muted">{c.status}</td>
            <td>
              <span className="row-actions">
                {busy === c.id ? <span className="spinner small" /> : !c.own && (
                  live ? (
                    <button type="button" className="icon-btn" aria-label={`Stop ${c.name}`} title="Stop" onClick={() => run(c, "stop")}><Icon name="stop" /></button>
                  ) : c.state !== "paused" && (
                    <button type="button" className="icon-btn" aria-label={`Start ${c.name}`} title="Start" onClick={() => run(c, "start")}><Icon name="play_arrow" /></button>
                  )
                )}
                <MoreMenu label={`More for ${c.name}`} actions={moreActions(c, (a) => run(c, a), `#/containers/${c.id}/logs`)} />
              </span>
            </td>
          </tr>
        );
      })}
    </>
  );
}

// ContainerPage is one container: what it runs and where its ports, files and
// networks go, or its logs.
function ContainerPage({ id, page }: { id: string; page: string }) {
  const [c, setC] = useState<ContainerDetail | null>(null);
  const [problem, setProblem] = useState("");
  const current = PAGES.some(([k]) => k === page) ? page : "overview";

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
  const { busy, run } = useContainerAction(load);

  if (!c) return problem ? <Callout tone="bad" icon="error">{problem}</Callout> : null;
  const live = c.state === "running";
  const act = (action: ContainerAction | "remove") => run(c, action).then(() => {
    if (action === "remove") location.hash = "#/containers";
  });

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>{c.name}</h1>
          <div className="page-sub">
            <span className={"chip " + tone(c.state)}>{c.state}</span>
            {c.health && <span>Health: {c.health}</span>}
            <span className="mono">{c.image}</span>
          </div>
        </div>
        <div className="page-actions">
          {busy && <span className="spinner small" />}
          {!c.own && (live ? (
            <button type="button" className="btn" disabled={!!busy} onClick={() => act("stop")}><Icon name="stop" size={18} />Stop</button>
          ) : c.state !== "paused" && (
            <button type="button" className="btn primary" disabled={!!busy} onClick={() => act("start")}><Icon name="play_arrow" size={18} />Start</button>
          ))}
          <MoreMenu label="More" actions={moreActions(c, act)} />
        </div>
      </div>
      <SubNav back="#/containers" backLabel="Containers" base={`#/containers/${c.id}`} items={PAGES} current={current} />
      <div className="page-body stack plain" key={current}>
        {problem && <Callout tone="bad" icon="error">{problem}</Callout>}
        {current === "overview" && <Overview c={c} />}
        {current === "logs" && <Logs id={c.id} />}
      </div>
    </>
  );
}

const when = (iso: string) => {
  const t = Date.parse(iso);
  return t > 0 ? new Date(t).toLocaleString() : "Never";
};

function Overview({ c }: { c: ContainerDetail }) {
  return (
    <>
      <Card title="Container">
        <Row title="Image" sub={<span className="mono">{c.image}</span>} />
        {c.command && <Row title="Command" sub={<span className="mono">{c.command}</span>} />}
        {c.project && <Row title="Compose" sub={`${c.project}, service ${c.service ?? ""}`} />}
        <Row title="Created" sub={when(c.created)} />
        <Row title={c.state === "running" ? "Started" : "Ended"} sub={c.state === "running" ? when(c.started) : `${when(c.finished)}, exit code ${c.exit_code}`} />
        <Row title="Restarts" sub={`${c.restart_policy || "no"} policy, restarted ${c.restarts} time${c.restarts === 1 ? "" : "s"}`} />
      </Card>
      <Card title="Ports" sub={c.ports.length ? undefined : "None exposed."}>
        {c.ports.map((p) => (
          <Row key={`${p.private}-${p.public}-${p.type}`} title={<span className="mono">{p.private}/{p.type}</span>}
            sub={p.public !== null ? `Published on the host at port ${p.public}` : "Not published on the host"} />
        ))}
      </Card>
      <Card title="Storage" sub={c.mounts.length ? undefined : "No volumes or folders mounted."}>
        {c.mounts.map((m) => (
          <Row key={m.destination} title={<span className="mono">{m.destination}</span>}
            sub={<>{m.kind === "volume" ? "Volume" : "Folder"} <span className="mono">{m.source}</span>{m.writable ? "" : ", read only"}</>} />
        ))}
      </Card>
      <Card title="Networks" sub={c.networks.length ? undefined : "Not on any network."}>
        {c.networks.map((n) => (
          <Row key={n.name} title={n.name} sub={n.ip ? <span className="mono">{n.ip}</span> : "No address"} />
        ))}
      </Card>
    </>
  );
}

const TAILS = [200, 500, 2000, 5000].map((n) => ({ value: n, label: `Last ${n} lines` }));

// Logs is what the container wrote, the newest at the bottom, followed as it
// runs unless paused.
function Logs({ id }: { id: string }) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [tail, setTail] = useState(500);
  const [follow, setFollow] = useState(true);
  const [problem, setProblem] = useState("");
  const box = useRef<HTMLPreElement>(null);
  const atEnd = useRef(true);

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
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id, tail, follow]);

  // Kept at the bottom while it was there, so reading back is not interrupted.
  useEffect(() => {
    if (box.current && atEnd.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines]);

  return (
    <>
      <div className="log-bar">
        <Dropdown label="Lines" value={tail} options={TAILS} onChange={setTail} />
        <label className="edit-switch">
          <Switch label="Follow" on={follow} onChange={setFollow} />
          <span>Follow</span>
        </label>
      </div>
      {problem && <Callout tone="bad" icon="error">{problem}</Callout>}
      <pre className="logs" ref={box} onScroll={(e) => {
        const el = e.currentTarget;
        atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}>
        {lines === null ? "" : lines.length === 0 ? <span className="muted">Nothing written yet.</span> : lines.map((line, i) => {
          const space = line.indexOf(" ");
          const t = space > 0 ? Date.parse(line.slice(0, space)) : NaN;
          return (
            <div key={i}>
              {t > 0 && <span className="log-time">{new Date(t).toLocaleTimeString()}</span>}
              {t > 0 ? line.slice(space + 1) : line}
            </div>
          );
        })}
      </pre>
    </>
  );
}
