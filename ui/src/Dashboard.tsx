import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { ago, api, message, shortId, type ContainerStats, type Device, type Flag, type Metrics, type User } from "./api";
import { Icon } from "./Icon";
import { useCan } from "./me";
import { Callout, useNotify } from "./ui";

// Chart colours, in a fixed order: blue, magenta, orange.
const BLUE = "var(--s1)";
const MAGENTA = "var(--s2)";
const ORANGE = "var(--s3)";

// DashboardPage reads out the host and its containers as widgets, refreshed as
// often as the server samples them, under any sign-ins from new devices.
export function DashboardPage({ flags, users, devices, onChanged }: { flags: Flag[]; users: User[]; devices: Device[]; onChanged: () => Promise<void> }) {
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
              <span>Up {duration(m.uptime)}</span>
              {m.load && <span>Load {m.load.map((n) => n.toFixed(2)).join("  ")}</span>}
            </div>
          )}
        </div>
      </div>
      {problem && <Callout tone="bad" icon="error">{problem}</Callout>}
      {m && last && <Board m={m} lead={flags.length > 0 && <NewDevices flags={flags} users={users} devices={devices} onChanged={onChanged} />} />}
    </>
  );
}

function Widget({ title, note, action, wide, full, flush, children }: {
  title: string;
  note?: ReactNode;
  action?: ReactNode;
  wide?: boolean;
  full?: boolean;
  flush?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={"widget" + (wide ? " wide" : "") + (full ? " full" : "")}>
      <div className="widget-head">
        <h2>{title}</h2>
        {note && <small>{note}</small>}
        {action}
      </div>
      <div className={"widget-body" + (flush ? " flush" : "")}>{children}</div>
    </section>
  );
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="kv">
      <span className="kv-label">{label}</span>
      <span className="kv-value">{value || <span className="muted">Unknown</span>}</span>
    </div>
  );
}

// NewDevices is each sign-in from a device new to its account, until someone
// dismisses it.
function NewDevices({ flags, users, devices, onChanged }: { flags: Flag[]; users: User[]; devices: Device[]; onChanged: () => Promise<void> }) {
  const can = useCan();
  const notify = useNotify();
  const dismiss = async (id: number) => {
    try {
      await api.clearFlag(id);
      await onChanged();
    } catch (e) {
      notify(message(e), "bad");
    }
  };
  return (
    <Widget title="New devices" note={`${flags.length} sign-in${flags.length === 1 ? "" : "s"}`} full flush>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th className="grow">Account</th><th>Device</th><th>From</th><th>When</th>{can("users.manage") && <th />}</tr></thead>
          <tbody>
            {flags.map((f) => {
              const u = users.find((x) => x.id === f.user_id);
              const d = devices.find((x) => x.id === f.device_id);
              return (
                <tr key={f.id}>
                  <td className="name-cell"><a href={`#/users/${f.user_id}`}>{u ? u.name || u.username : "Removed account"}</a>{u && <small>{u.email}</small>}</td>
                  <td>{f.device_id ? <a className="mono" href={`#/devices/${f.device_id}`}>{d?.name || shortId(f.device_id)}</a> : "Unknown"}</td>
                  <td>{[f.ip, f.country].filter(Boolean).join(", ") || "Unknown"}</td>
                  <td>{ago(f.at)}</td>
                  {can("users.manage") && <td className="num"><button type="button" className="btn small" onClick={() => dismiss(f.id)}>Dismiss</button></td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Widget>
  );
}

function Board({ m, lead }: { m: Metrics; lead: ReactNode }) {
  const h = m.history;
  const last = h[h.length - 1];
  const times = h.map((s) => s.at);
  const hasTemp = h.some((s) => s.temp !== null);
  const coreTemps = m.cores.map((c) => c.temp);
  const hasCoreTemps = coreTemps.some((t) => t !== null);
  const chart = { times, keep: m.keep, every: m.every };
  const netTop = nice(Math.max(...h.map((s) => Math.max(s.rx, s.tx))));
  const free = Math.max(0, m.memory_total - last.memory);

  return (
    <div className="page-body widgets">
      {lead}
      <Widget title="System Information" wide flush>
        <div className="system">
          <div className="system-mark">
            <Icon name="dns" size={56} />
            <b>{m.host.name ?? "This host"}</b>
            <span className="chip ok">Online</span>
          </div>
          <div className="system-facts">
            <Fact label="Platform" value={m.host.os} />
            <Fact label="Kernel" value={m.host.kernel} />
            <Fact label="Processor" value={m.host.cpu} />
            <Fact label="Architecture" value={m.host.arch} />
            <Fact label="Docker" value={m.host.docker} />
            <Fact label="Uptime" value={duration(m.uptime)} />
          </div>
        </div>
      </Widget>

      <Widget title="CPU Usage">
        <Gauge value={last.cpu} label="Avg usage" />
        <p className="gauge-foot">{cpuSub(m)}</p>
      </Widget>

      <Widget title="Memory">
        <div className="donut">
          <div>
            <div className="donut-big">{bytes(m.memory_total).split(" ")[0]}<small>{bytes(m.memory_total).split(" ")[1]}</small></div>
            <p className="donut-sub">total available</p>
            <ul className="donut-legend">
              <li><i style={{ background: BLUE }} />In use: <b>{bytes(last.memory)}</b></li>
              <li><i style={{ background: MAGENTA }} />Free: <b>{bytes(free)}</b></li>
              {m.swap_total > 0 && <li><i style={{ background: ORANGE }} />Swap: <b>{bytes(last.swap)} of {bytes(m.swap_total)}</b></li>}
            </ul>
          </div>
          <Donut parts={[{ value: last.memory, color: BLUE }, { value: free, color: MAGENTA }]} />
        </div>
      </Widget>

      <Widget title="CPU Usage Per Core" note={`${m.cores.length} threads`} wide>
        <Bars values={m.cores.map((c) => c.usage)} max={100} format={(n) => `${Math.round(n)}`} />
      </Widget>

      {hasCoreTemps && (
        <Widget title="CPU Temperature Per Core" wide>
          <Bars heat values={coreTemps.map((t) => t ?? 0)} max={Math.max(100, nice(Math.max(...coreTemps.map((t) => t ?? 0))))} format={(n) => `${Math.round(n)}`} />
        </Widget>
      )}

      <Widget title="CPU Recent Usage" wide action={<span className="chart-now">{pct(last.cpu)}</span>}>
        <Chart {...chart} max={100} format={pct} lines={[{ label: "CPU", color: BLUE, values: h.map((s) => s.cpu) }]} />
      </Widget>

      <Widget title="Network" wide action={<Legend items={[[`In ${rate(last.rx)}`, BLUE], [`Out ${rate(last.tx)}`, ORANGE]]} />}>
        <Chart {...chart} max={netTop} format={rate}
          lines={[{ label: "In", color: BLUE, values: h.map((s) => s.rx) }, { label: "Out", color: ORANGE, values: h.map((s) => s.tx) }]} />
      </Widget>

      <Widget title="Temperature" action={last.temp !== null && <span className="chart-now">{degrees(last.temp)}</span>}>
        {hasTemp ? (
          <Chart {...chart} max={Math.max(100, nice(Math.max(...h.map((s) => s.temp ?? 0))))} format={degrees}
            lines={[{ label: "Processor", color: MAGENTA, values: h.map((s) => s.temp) }]} />
        ) : (
          <p className="empty-note">No temperature sensors are visible to myTunnels on this host.</p>
        )}
      </Widget>

      <Widget title="Disks" wide flush>
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
        ) : <p className="empty-note card-pad">No disks found.</p>}
      </Widget>

      <Widget title="Sensors" flush>
        {m.sensors.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th className="grow">Sensor</th><th>Reading</th></tr></thead>
              <tbody>
                {m.sensors.map((s) => (
                  <tr key={s.label}>
                    <td>{s.label}</td>
                    <td><Meter value={s.temp} max={s.critical ?? s.max ?? 100} label={degrees(s.temp)} tone={heat(s.temp)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="empty-note card-pad">No sensors are visible to myTunnels on this host.</p>}
      </Widget>

      <Widget title="Containers" note={m.docker.reachable ? count(m.docker.containers) : undefined} full flush
        action={<a className="btn small" href="#/containers">Manage</a>}>
        {m.docker.reachable
          ? <Containers list={m.docker.containers} keep={m.keep} hostMemory={m.memory_total} />
          : <p className="empty-note card-pad">Docker is not reachable: {m.docker.error}</p>}
      </Widget>
    </div>
  );
}

// Gauge is a ring filled to a share, the figure and what it is in its middle.
function Gauge({ value, label }: { value: number; label: string }) {
  const r = 62;
  const c = 2 * Math.PI * r;
  const share = Math.min(Math.max(value / 100, 0), 1);
  return (
    <div className="gauge">
      <svg viewBox="0 0 150 150" role="img" aria-label={`${pct(value)} ${label}`}>
        <circle className="gauge-track" cx="75" cy="75" r={r} />
        <circle className="gauge-fill" cx="75" cy="75" r={r} strokeDasharray={c} strokeDashoffset={c * (1 - share)} transform="rotate(-90 75 75)" />
        <text className="gauge-value" x="75" y="78" textAnchor="middle">{pct(value)}</text>
        <text className="gauge-label" x="75" y="98" textAnchor="middle">{label}</text>
      </svg>
    </div>
  );
}

// Donut is shares of a whole as arcs of a ring.
function Donut({ parts }: { parts: { value: number; color: string }[] }) {
  const r = 56;
  const c = 2 * Math.PI * r;
  const total = parts.reduce((n, p) => n + p.value, 0) || 1;
  let offset = 0;
  return (
    <svg viewBox="0 0 150 150" aria-hidden="true">
      {parts.map((p, i) => {
        const len = (p.value / total) * c;
        const arc = (
          <circle key={i} cx="75" cy="75" r={r} fill="none" stroke={p.color} strokeWidth="26"
            strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-offset} transform="rotate(-90 75 75)" />
        );
        offset += len;
        return arc;
      })}
    </svg>
  );
}

// Bars is a bar per value, on a scale from nothing to `max`.
function Bars({ values, max, format, heat }: { values: number[]; max: number; format: (n: number) => string; heat?: boolean }) {
  return (
    <>
      <div className={"bars" + (heat ? " heat" : "")}>
        <div className="bars-scale">{[1, 0.75, 0.5, 0.25, 0].map((f) => <span key={f}>{format(max * f)}</span>)}</div>
        <div className="bars-plot">
          {values.map((v, i) => (
            <span key={i} style={{ height: `${Math.min(Math.max(v / (max || 1), 0), 1) * 100}%` }} title={`${i}: ${format(v)}${heat ? "°C" : "%"}`} />
          ))}
        </div>
      </div>
      <div className="bars-axis"><span>0</span><span>{values.length - 1}</span></div>
    </>
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

export function Spark({ values, max, color, keep, times, every }: Span & { values: number[]; max: number; color: string }) {
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
export function Chart({ lines, max, format, times, keep, every }: Span & { lines: Line[]; max: number; format: (n: number) => string }) {
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

export function Meter({ value, max, label, tone }: { value: number; max: number; label: string; tone?: string }) {
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
