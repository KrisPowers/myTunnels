import { useEffect, useRef, useState, type PointerEvent } from "react";
import { api, message, type ContainerStats, type Metrics } from "./api";
import { Callout, Card } from "./ui";

// Chart colours, in a fixed order: the first three categorical slots.
const BLUE = "var(--s1)";
const ORANGE = "var(--s2)";
const AQUA = "var(--s3)";

// DashboardPage reads out the host and its containers, refreshed as often as
// the server samples them.
export function DashboardPage() {
  const [m, setM] = useState<Metrics | null>(null);
  const [problem, setProblem] = useState("");

  useEffect(() => {
    let alive = true;
    let timer = 0;
    const load = async () => {
      try {
        const next = await api.metrics();
        if (!alive) return;
        setM(next);
        setProblem("");
        timer = window.setTimeout(load, next.every * 1000);
      } catch (e) {
        if (!alive) return;
        setProblem(message(e));
        timer = window.setTimeout(load, 5000);
      }
    };
    load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  const last = m?.history[m.history.length - 1];
  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Dashboard</h1>
          {m && (
            <div className="page-sub">
              {m.host.name && <b>{m.host.name}</b>}
              {m.host.os && <span>{m.host.os}</span>}
              <span>Up {duration(m.uptime)}</span>
              {m.load && <span>Load {m.load.map((n) => n.toFixed(2)).join("  ")}</span>}
            </div>
          )}
        </div>
      </div>
      {problem && <Callout tone="bad" icon="error">{problem}</Callout>}
      {m && last && <Board m={m} />}
    </>
  );
}

function Board({ m }: { m: Metrics }) {
  const h = m.history;
  const last = h[h.length - 1];
  const times = h.map((s) => s.at);
  const hasTemp = h.some((s) => s.temp !== null);
  const chart = { times, keep: m.keep, every: m.every };
  const memPct = m.memory_total ? (last.memory / m.memory_total) * 100 : 0;
  const netTop = nice(Math.max(...h.map((s) => Math.max(s.rx, s.tx))));

  return (
    <div className="page-body stack">
      <div className="tally four stat-tiles">
        <Stat label="CPU" value={pct(last.cpu)} sub={cpuSub(m)} values={h.map((s) => s.cpu)} max={100} {...chart} color={BLUE} />
        <Stat label="Memory" value={pct(memPct)} sub={`${bytes(last.memory)} of ${bytes(m.memory_total)}`}
          values={h.map((s) => s.memory)} max={m.memory_total} {...chart} color={ORANGE} />
        <Stat label="Temperature" value={last.temp === null ? "None" : degrees(last.temp)}
          sub={hasTemp ? "Processor" : "No sensor visible"} values={h.map((s) => s.temp ?? 0)} max={100} {...chart} color={AQUA} />
        <Stat label="Network" value={`↓ ${rate(last.rx)}`} sub={`↑ ${rate(last.tx)}`}
          values={h.map((s) => s.rx + s.tx)} max={nice(Math.max(...h.map((s) => s.rx + s.tx)))} {...chart} color={BLUE} />
      </div>

      <div className="dash-grid">
        <Card title="CPU usage" action={<span className="chart-now">{pct(last.cpu)}</span>}>
          <Chart {...chart} max={100} format={pct} lines={[{ label: "CPU", color: BLUE, values: h.map((s) => s.cpu) }]} />
        </Card>
        <Card title="Memory" action={<span className="chart-now">{bytes(last.memory)}</span>}>
          <Chart {...chart} max={m.memory_total || 1} format={bytes}
            lines={[{ label: "Memory", color: ORANGE, values: h.map((s) => s.memory) }]} />
        </Card>
        <Card title="Network" action={<Legend items={[["Download", BLUE], ["Upload", ORANGE]]} />}>
          <Chart {...chart} max={netTop} format={rate}
            lines={[{ label: "Download", color: BLUE, values: h.map((s) => s.rx) }, { label: "Upload", color: ORANGE, values: h.map((s) => s.tx) }]} />
        </Card>
        <Card title="Temperature" action={last.temp !== null && <span className="chart-now">{degrees(last.temp)}</span>}>
          {hasTemp ? (
            <Chart {...chart} max={Math.max(100, nice(Math.max(...h.map((s) => s.temp ?? 0))))} format={degrees}
              lines={[{ label: "Processor", color: AQUA, values: h.map((s) => s.temp) }]} />
          ) : (
            <p className="card-pad empty-note">No temperature sensors are visible to myTunnels on this host.</p>
          )}
        </Card>
      </div>

      <Card title="Cores" sub={m.host.cpu ?? undefined}>
        <div className="cores">
          {m.cores.map((c, i) => (
            <div className="core" key={i}>
              <div className="core-top">
                <span>CPU {i}</span>
                {c.temp !== null && <span className={"chip " + heat(c.temp)}>{degrees(c.temp)}</span>}
              </div>
              <b>{pct(c.usage)}</b>
              <Spark values={h.map((s) => s.cores[i] ?? 0)} max={100} {...chart} color={BLUE} />
              <small>{c.mhz ? `${(c.mhz / 1000).toFixed(2)} GHz` : " "}</small>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Containers" sub={m.docker.reachable ? count(m.docker.containers) : undefined}>
        {m.docker.reachable
          ? <Containers list={m.docker.containers} keep={m.keep} hostMemory={m.memory_total} />
          : <p className="card-pad empty-note">Docker is not reachable: {m.docker.error}</p>}
      </Card>

      <div className="dash-grid">
        <Card title="Disks">
          {m.disks.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th className="grow">Mount</th><th>Used</th><th>Free</th><th>Size</th></tr></thead>
                <tbody>
                  {m.disks.map((d) => {
                    const used = d.total - d.available;
                    return (
                      <tr key={d.name + d.mount}>
                        <td className="name-cell"><span className="mono">{d.mount}</span><small>{d.name} · {d.fs}</small></td>
                        <td><Meter value={used} max={d.total} label={pct((used / d.total) * 100)} /></td>
                        <td className="num">{bytes(d.available)}</td>
                        <td className="num">{bytes(d.total)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : <p className="card-pad empty-note">No disks found.</p>}
        </Card>
        <Card title="Sensors">
          {m.sensors.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th className="grow">Sensor</th><th>Reading</th><th>Critical</th></tr></thead>
                <tbody>
                  {m.sensors.map((s) => (
                    <tr key={s.label}>
                      <td>{s.label}</td>
                      <td><Meter value={s.temp} max={s.critical ?? s.max ?? 100} label={degrees(s.temp)} tone={heat(s.temp)} /></td>
                      <td className="num muted">{s.critical ? degrees(s.critical) : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="card-pad empty-note">No sensors are visible to myTunnels on this host.</p>}
        </Card>
      </div>
    </div>
  );
}

function Containers({ list, keep, hostMemory }: { list: ContainerStats[]; keep: number; hostMemory: number }) {
  if (!list.length) return <p className="card-pad empty-note">No containers.</p>;
  return (
    <div className="table-wrap">
      <table className="table containers">
        <thead>
          <tr><th className="grow">Container</th><th>CPU</th><th>Memory</th><th>Network</th><th>Disk</th><th>Status</th></tr>
        </thead>
        <tbody>
          {list.map((c) => {
            const running = c.state === "running";
            const limit = c.memory_limit && c.memory_limit < hostMemory * 4 ? c.memory_limit : hostMemory;
            return (
              <tr key={c.id} className={running ? "" : "stopped"}>
                <td className="name-cell">
                  <span className="name-line"><span className={"dot " + (running ? "ok" : "")} />{c.name}</span>
                  <small>{c.image}</small>
                </td>
                <td>{running && (
                  <span className="cpu-cell">
                    <Spark values={c.history} max={Math.max(100, ...c.history)} keep={keep} times={[]} every={0} color={BLUE} />
                    <span className="num">{pct(c.cpu)}</span>
                  </span>
                )}</td>
                <td>{running && <Meter value={c.memory} max={limit} label={bytes(c.memory)} />}</td>
                <td className="num">{running && <>↓ {rate(c.rx)}<br />↑ {rate(c.tx)}</>}</td>
                <td className="num">{running && <>R {rate(c.read)}<br />W {rate(c.write)}</>}</td>
                <td className="muted">{c.status}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---- pieces ----

interface Span {
  times: number[];
  keep: number;
  every: number;
}

function Stat({ label, value, sub, values, max, color, ...w }: Span & { label: string; value: string; sub: string; values: number[]; max: number; color: string }) {
  return (
    <div className="tally-item stat">
      <span>{label}</span>
      <b>{value}</b>
      <small>{sub}</small>
      <Spark values={values} max={max} color={color} {...w} />
    </div>
  );
}

// Points sit in fixed slots, the newest at the right edge, so a short history
// grows in from the right. Each new sample slides the line one slot left over
// the sampling interval, so it moves steadily instead of jumping.
function geometry(keep: number, values: (number | null)[], max: number) {
  const offset = keep - values.length;
  const y = (v: number) => 100 - Math.min(Math.max(v / (max || 1), 0), 1) * 94;
  let line = "";
  let start = -1;
  let end = -1;
  values.forEach((v, i) => {
    if (v === null) return;
    const x = offset + i;
    line += (start < 0 || values[i - 1] === null ? "M" : "L") + x + "," + y(v).toFixed(2);
    if (start < 0) start = x;
    end = x;
  });
  const area = start < 0 ? "" : `${line}L${end},100L${start},100Z`;
  return { line, area, y, offset };
}

function Spark({ values, max, color, keep, times, every }: Span & { values: number[]; max: number; color: string }) {
  const { line, area } = geometry(keep, values, max);
  return (
    <svg className="spark" viewBox={`1 0 ${keep - 2} 100`} preserveAspectRatio="none" style={{ color }} aria-hidden="true">
      <g key={times[times.length - 1]} className={every ? "slide" : undefined} style={{ animationDuration: every + "s" }}>
        <path className="spark-area" d={area} />
        <path className="spark-line" d={line} />
      </g>
    </svg>
  );
}

interface Line {
  label: string;
  color: string;
  values: (number | null)[];
}

// Chart is a line chart over the kept window, with gridlines at the top and
// middle, and a crosshair with every line's value under the pointer.
function Chart({ lines, max, format, times, keep, every }: Span & { lines: Line[]; max: number; format: (n: number) => string }) {
  const plot = useRef<HTMLDivElement>(null);
  const [slot, setSlot] = useState<number | null>(null);
  const shapes = lines.map((l) => geometry(keep, l.values, max));
  const { y, offset } = shapes[0];
  const left = (s: number) => `${((s - 1) / (keep - 2)) * 100}%`;

  const move = (e: PointerEvent) => {
    const box = plot.current?.getBoundingClientRect();
    if (!box) return;
    const s = Math.round(1 + ((e.clientX - box.left) / box.width) * (keep - 2));
    setSlot(s >= offset ? Math.min(s, keep - 1) : null);
  };
  const i = slot === null ? -1 : slot - offset;

  return (
    <div className="chart">
      <div className="chart-plot" ref={plot} onPointerMove={move} onPointerLeave={() => setSlot(null)}>
        {[1, 0.5].map((f) => (
          <div key={f} className="chart-grid" style={{ top: y(max * f) + "%" }}><span>{format(max * f)}</span></div>
        ))}
        <div className="chart-grid base" />
        <svg viewBox={`1 0 ${keep - 2} 100`} preserveAspectRatio="none" aria-hidden="true">
          <g key={times[times.length - 1]} className="slide" style={{ animationDuration: every + "s" }}>
            {lines.map((l, n) => (
              <g key={l.label} style={{ color: l.color }}>
                {lines.length === 1 && <path className="chart-area" d={shapes[n].area} />}
                <path className="chart-line" d={shapes[n].line} />
              </g>
            ))}
          </g>
        </svg>
        {slot !== null && i >= 0 && (
          <>
            <div className="chart-cross" style={{ left: left(slot) }} />
            {lines.map((l) => {
              const v = l.values[i];
              return v === null || v === undefined ? null : (
                <span key={l.label} className="chart-dot" style={{ left: left(slot), top: y(v) + "%", background: l.color }} />
              );
            })}
            <div className={"chart-tip" + (slot > keep * 0.6 ? " flip" : "")} style={{ left: left(slot) }}>
              <div className="chart-tip-time">{clock(times[i])}</div>
              {lines.map((l) => {
                const v = l.values[i];
                return (
                  <div key={l.label} className="chart-tip-row">
                    <i style={{ background: l.color }} />
                    <span>{l.label}</span>
                    <b>{v === null || v === undefined ? "None" : format(v)}</b>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
      <div className="chart-axis">
        <span>{Math.round((keep * every) / 60)} min ago</span>
        <span>Now</span>
      </div>
    </div>
  );
}

function Legend({ items }: { items: [string, string][] }) {
  return (
    <span className="legend">
      {items.map(([label, color]) => (
        <span key={label}><i style={{ background: color }} />{label}</span>
      ))}
    </span>
  );
}

function Meter({ value, max, label, tone }: { value: number; max: number; label: string; tone?: string }) {
  const share = max > 0 ? Math.min(value / max, 1) : 0;
  const level = tone ?? (share >= 0.9 ? "bad" : share >= 0.75 ? "warn" : "");
  return (
    <span className="meter-cell">
      <span className={"meter " + level}><span style={{ width: share * 100 + "%" }} /></span>
      <span className="num">{label}</span>
    </span>
  );
}

// ---- words and numbers ----

function cpuSub(m: Metrics) {
  const cores = m.host.cores && m.host.cores !== m.host.threads ? `${m.host.cores} cores, ` : "";
  return `${cores}${m.host.threads} threads`;
}

function count(list: ContainerStats[]) {
  const running = list.filter((c) => c.state === "running").length;
  return `${running} running of ${list.length}`;
}

function heat(c: number) {
  return c >= 85 ? "bad" : c >= 70 ? "warn" : "";
}

const pct = (n: number) => `${n < 10 ? n.toFixed(1) : Math.round(n)}%`;
const degrees = (n: number) => `${Math.round(n)}°C`;
const rate = (n: number) => `${bytes(n)}/s`;

function bytes(n: number) {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i && n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

// A round number at or above `n`, for the top of a chart.
function nice(n: number) {
  if (!(n > 0)) return 1024;
  const step = 10 ** Math.floor(Math.log10(n));
  return ([1, 2, 2.5, 5, 10].find((f) => f * step >= n) ?? 10) * step;
}

function duration(s: number) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const min = Math.floor((s % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${min} min` : `${min} min`;
}

function clock(at: number) {
  return new Date(at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
