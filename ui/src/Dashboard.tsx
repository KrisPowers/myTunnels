import { useEffect, useState, type ReactNode } from "react";
import { ago, api, bytes, message, shortId, type ContainerStats, type Device, type Flag, type Hardware, type Health, type HwPart, type HwSnapshot, type Metrics, type User } from "./api";
import { Chart, Meter, Spark } from "./charts";
import { Icon } from "./Icon";
import { useCan, useMe } from "./me";
import { go } from "./route";
import { MoreMenu, useNotify } from "./ui";

// Chart colours, in a fixed order: blue, violet, orange.
const BLUE = "var(--s1)";
const VIOLET = "var(--s2)";
const ORANGE = "var(--s3)";

const failing = (h?: Health) => h === "warn" || h === "bad";
const worst = (list: { health: Health }[]): Health =>
  list.some((p) => p.health === "bad") ? "bad" : list.some((p) => p.health === "warn") ? "warn" : list.some((p) => p.health === "ok") ? "ok" : "unknown";
const reading = (p: HwPart | undefined, label: string) => p?.readings.find((r) => r.label === label);
const fact = (p: HwPart | undefined, key: string) => p?.facts.find(([k]) => k === key)?.[1] ?? "";
const share = (n: number) => Math.min(Math.max(n, 0), 1);

// DashboardPage is the host at a glance, in panels of figures and charts.
// Overview is what any account can read from the system; Advanced adds the
// sensors: temperatures, fans, voltages and drive wear, which on Windows need
// administrator rights once.
export function DashboardPage({ tab, flags, users, devices, onChanged }: { tab: string; flags: Flag[]; users: User[]; devices: Device[]; onChanged: () => Promise<void> }) {
  const advanced = tab === "advanced";
  const me = useMe();
  const admin = me.admin || me.host;
  const notify = useNotify();
  const [m, setM] = useState<Metrics | null>(null);
  const [problem, setProblem] = useState("");
  const [hw, setHw] = useState<Hardware | null>(null);
  const [busy, setBusy] = useState(false);

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

  useEffect(() => {
    let alive = true;
    const load = () => api.hardware().then((h) => alive && setHw(h)).catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const act = async (call: () => Promise<Hardware>) => {
    setBusy(true);
    try {
      setHw(await call());
    } catch (e) {
      notify(message(e), "bad");
    } finally {
      setBusy(false);
    }
  };

  const snap = hw?.snapshot ?? null;
  const parts = snap?.parts ?? [];
  const of = (kind: string) => parts.filter((p) => p.kind === kind);
  const attention = [...parts, ...(snap?.notes ?? [])].filter((p) => failing(p.health));
  const chart = m && { times: m.history.map((s) => s.at), keep: m.keep, every: m.every };

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Dashboard</h1>
          {snap && (
            <div className="page-sub">
              <span className="health-line">
                <span className={"dot " + (attention.length ? worst(attention) : "ok")} />
                {attention.length ? `${attention.length} need${attention.length === 1 ? "s" : ""} attention` : "All healthy"}
              </span>
            </div>
          )}
        </div>
        <div className="page-actions">
          <div className="seg-tabs" role="tablist" aria-label="View">
            <button type="button" role="tab" aria-selected={!advanced} className={advanced ? "" : "on"} onClick={() => go("#/dashboard")}>Overview</button>
            <button type="button" role="tab" aria-selected={advanced} className={advanced ? "on" : ""} onClick={() => go("#/dashboard/advanced")}>Advanced</button>
          </div>
          {advanced && admin && hw?.platform === "windows" && hw.enabled && (
            <MoreMenu label="More" actions={[{ label: "Turn off sensors", icon: "block", danger: true, confirm: "Remove the sensor task", onClick: () => act(api.disableHardware) }]} />
          )}
        </div>
      </div>
      {problem && <div className="callout bad"><Icon name="error" /><span>{problem}</span></div>}
      {advanced && hw && <Setup hw={hw} admin={admin} busy={busy} onEnable={() => act(api.enableHardware)} />}
      {m && chart && m.history.length > 0 && (
        <div className="page-body dash">
          {flags.length > 0 && <NewDevices flags={flags} users={users} devices={devices} onChanged={onChanged} />}
          <Host m={m} board={of("board")[0]} />
          <Cpu m={m} cpu={of("cpu")[0]} advanced={advanced} chart={chart} />
          <Memory m={m} snap={snap} chart={chart} admin={admin} onForget={(slot) => act(() => api.forgetSlot(slot))} />
          <Network m={m} chart={chart} />
          {advanced && <Temperatures m={m} parts={parts} chart={chart} />}
          {advanced && <Fans fans={of("fan")} />}
          {advanced && <Voltages power={of("power")[0]} />}
          <Graphics gpus={of("gpu")} />
          <Log snap={snap} />
          <Volumes m={m} />
          <Drives drives={of("drive")} advanced={advanced} />
          <Containers m={m} />
        </div>
      )}
    </>
  );
}

// ---- panels ----

interface Frame {
  times: number[];
  keep: number;
  every: number;
}

// Panel is one tile of the grid: a title with how it is doing, the figure
// that matters now on the right, and its body.
function Panel({ title, span, health, sub, now, flush, children }: {
  title: ReactNode;
  span: 4 | 6 | 12;
  health?: Health;
  sub?: ReactNode;
  now?: ReactNode;
  flush?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={`panel span-${span}`}>
      <header className="panel-head">
        {failing(health) || health === "ok" ? <span className={"dot " + health} /> : null}
        <h2>{title}</h2>
        {sub && <span className="panel-sub">{sub}</span>}
        {now && <span className="panel-now">{now}</span>}
      </header>
      <div className={"panel-body" + (flush ? " flush" : "")}>{children}</div>
    </section>
  );
}

type Fig = [string, ReactNode, Health?] | false | null | undefined;

// Figures is a row of label-over-value pairs, those without a value left out.
function Figures({ items, wide }: { items: Fig[]; wide?: boolean }) {
  const shown = items.filter((f): f is [string, ReactNode, Health?] => !!f && f[1] !== null && f[1] !== undefined && f[1] !== "" && f[1] !== false);
  if (!shown.length) return null;
  return (
    <dl className={"figures" + (wide ? " wide" : "")}>
      {shown.map(([label, value, health]) => (
        <div key={label} data-health={health}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

interface Row {
  key: string;
  label: string;
  value: string;
  // Where the bar under the value stands, from nothing to full.
  fill?: number;
  note?: string;
  health?: Health;
  title?: string;
}

// Rows is a list of readings: the name, a bar where it has one, the value.
function Rows({ rows }: { rows: Row[] }) {
  return (
    <ul className="rows">
      {rows.map((r) => (
        <li key={r.key} data-health={r.health} title={r.title}>
          <span className="rows-label">{r.label}</span>
          {r.fill !== undefined ? <span className="rows-bar"><span style={{ width: share(r.fill) * 100 + "%" }} /></span> : <span />}
          <small>{r.note}</small>
          <b>{r.value}</b>
        </li>
      ))}
    </ul>
  );
}

// Strip is a thin bar for each thread or core, on a scale to `max`.
function Strip({ label, values, max, unit, heat }: { label: string; values: number[]; max: number; unit: string; heat?: boolean }) {
  if (!values.length) return null;
  return (
    <div className="strip">
      <span className="strip-label">{label}</span>
      <div className={"strip-bars" + (heat ? " heat" : "")}>
        {values.map((v, i) => (
          <span key={i} data-health={heat && v >= 85 ? (v >= 95 ? "bad" : "warn") : undefined}
            style={{ height: `${Math.max(share(v / max), 0.03) * 100}%` }} title={`${i + 1}: ${Math.round(v)}${unit}`} />
        ))}
      </div>
    </div>
  );
}

function Reason({ part }: { part: HwPart }) {
  return failing(part.health) ? <p className="reason" data-health={part.health}>{part.reason}</p> : null;
}

// The host: its name and every fact about it in one strip.
function Host({ m, board }: { m: Metrics; board: HwPart | undefined }) {
  return (
    <Panel span={12} title={m.host.name ?? "This host"} now={<span className="chip ok">Online</span>}>
      <Figures wide items={[
        ["Platform", m.host.os],
        ["Kernel", m.host.kernel],
        ["Processor", m.host.cpu],
        ["Cores", cores(m)],
        ["Memory", bytes(m.memory_total)],
        ["Board", board?.name],
        ["Architecture", m.host.arch],
        ["Docker", m.host.docker],
        ["Uptime", duration(m.uptime)],
        m.load && ["Load", m.load.map((n) => n.toFixed(2)).join("  ")],
      ]} />
    </Panel>
  );
}

function Cpu({ m, cpu, advanced, chart }: { m: Metrics; cpu: HwPart | undefined; advanced: boolean; chart: Frame }) {
  const h = m.history;
  const last = h[h.length - 1];
  const temp = reading(cpu, "Temperature");
  const power = reading(cpu, "Power");
  const sensed = cpu?.readings.filter((r) => /^Core \d+$/.test(r.label)).map((r) => r.value) ?? [];
  const temps = sensed.length ? sensed : m.cores.map((c) => c.temp).filter((t): t is number => t !== null);
  const mhz = m.cores.length ? m.cores.reduce((n, c) => n + c.mhz, 0) / m.cores.length : 0;
  return (
    <Panel span={4} title="CPU" health={advanced ? cpu?.health : undefined} now={pct(last.cpu)}>
      <Chart {...chart} max={100} format={pct} lines={[{ label: "CPU", color: BLUE, values: h.map((s) => s.cpu) }]} />
      <Strip label="Each thread" values={m.cores.map((c) => c.usage)} max={100} unit="%" />
      {advanced && <Strip heat label="Each core, °C" values={temps} max={100} unit="°C" />}
      <Figures items={[
        ["Cores", cores(m)],
        mhz > 0 && ["Clock", `${(mhz / 1000).toFixed(2)} GHz`],
        m.load && ["Load", m.load[0].toFixed(2)],
        advanced && temp && ["Package", degrees(temp.value), temp.health],
        advanced && power && ["Power", `${Math.round(power.value)} W`],
      ]} />
      {advanced && cpu && <Reason part={cpu} />}
    </Panel>
  );
}

// Memory: its use over time, and the sticks in the board's slots.
function Memory({ m, snap, chart, admin, onForget }: { m: Metrics; snap: HwSnapshot | null; chart: Frame; admin: boolean; onForget: (slot: string) => void }) {
  const h = m.history;
  const total = m.memory_total || 1;
  const last = h[h.length - 1];
  const slots = snap?.parts.filter((p) => p.kind === "memory") ?? [];
  const sticks = slots.filter((p) => p.bytes);
  const missing = slots.filter((p) => p.health === "bad" && !p.bytes);
  const slow = sticks.find((p) => failing(p.health));
  const count = Math.max(snap?.slots ?? 0, slots.length);
  return (
    <Panel span={4} title="Memory" health={slots.length ? worst(slots) : undefined} now={pct((last.memory / total) * 100)}>
      <Chart {...chart} max={100} format={pct} lines={[{ label: "In use", color: VIOLET, values: h.map((s) => (s.memory / total) * 100) }]} />
      <Figures items={[
        ["In use", bytes(last.memory)],
        ["Free", bytes(Math.max(0, m.memory_total - last.memory))],
        m.swap_total > 0 && ["Swap", `${bytes(last.swap)} of ${bytes(m.swap_total)}`],
        count > 0 && ["Slots", `${sticks.length} of ${count}`],
        ["Speed", fact(sticks[0], "Running at") || fact(sticks[0], "Rated speed")],
        snap?.ecc && ["ECC", "On"],
      ]} />
      {missing.map((p) => (
        <p key={p.id} className="reason" data-health="bad">
          {p.name} in {p.place} is not detected.
          {admin && <button type="button" className="link-btn" onClick={() => onForget(p.place)}>Taken out</button>}
        </p>
      ))}
      {slow && <p className="reason" data-health={slow.health}>{slow.reason}</p>}
    </Panel>
  );
}

function Network({ m, chart }: { m: Metrics; chart: Frame }) {
  const h = m.history;
  const last = h[h.length - 1];
  const peakIn = Math.max(...h.map((s) => s.rx));
  const peakOut = Math.max(...h.map((s) => s.tx));
  return (
    <Panel span={4} title="Network" now={<Legend items={[["In", BLUE], ["Out", ORANGE]]} />}>
      <Chart {...chart} max={nice(Math.max(peakIn, peakOut))} format={rate}
        lines={[{ label: "In", color: BLUE, values: h.map((s) => s.rx) }, { label: "Out", color: ORANGE, values: h.map((s) => s.tx) }]} />
      <Figures items={[["In", rate(last.rx)], ["Out", rate(last.tx)], ["Peak in", rate(peakIn)], ["Peak out", rate(peakOut)]]} />
    </Panel>
  );
}

// Every temperature read: the processor over time, then each part's.
function Temperatures({ m, parts, chart }: { m: Metrics; parts: HwPart[]; chart: Frame }) {
  const h = m.history;
  const last = h[h.length - 1];
  const rows: (Row & { c: number })[] = [];
  for (const p of parts) {
    for (const r of p.readings) {
      if (r.unit !== "°C" || /^Core \d+$/.test(r.label)) continue;
      const label = p.kind === "board" ? r.label : p.kind === "cpu" ? "Processor" : p.name;
      rows.push({ key: `${p.id}:${r.label}`, label, value: degrees(r.value), fill: r.value / 100, health: r.health, c: r.value });
    }
  }
  if (!rows.length) {
    for (const s of m.sensors) {
      const health: Health = s.temp >= (s.critical ?? 95) ? "bad" : s.temp >= (s.max ?? 85) ? "warn" : "ok";
      rows.push({ key: s.label, label: s.label, value: degrees(s.temp), fill: s.temp / 100, health, c: s.temp });
    }
  }
  const history = h.some((s) => s.temp !== null);
  if (!rows.length && !history) return null;
  const top = Math.max(100, nice(Math.max(...h.map((s) => s.temp ?? 0), ...rows.map((r) => r.c))));
  return (
    <Panel span={4} title="Temperature" health={rows.length ? worst(rows.map((r) => ({ health: r.health ?? "unknown" }))) : undefined}
      now={last.temp !== null ? degrees(last.temp) : undefined}>
      {history && <Chart {...chart} max={top} format={degrees} lines={[{ label: "Processor", color: ORANGE, values: h.map((s) => s.temp) }]} />}
      <Rows rows={rows} />
    </Panel>
  );
}

// The fans that are connected, each against the fastest.
function Fans({ fans }: { fans: HwPart[] }) {
  const on = fans.filter((f) => f.health !== "empty");
  if (!on.length) return null;
  const speed = (f: HwPart) => f.readings[0]?.value ?? 0;
  const top = Math.max(...on.map(speed), 1);
  return (
    <Panel span={4} title="Fans" health={worst(on)} sub={`${on.length} of ${fans.length} headers`}>
      <Rows rows={on.map((f) => ({
        key: f.id, label: f.name, value: `${Math.round(speed(f)).toLocaleString()} RPM`, fill: speed(f) / top,
        health: f.health, title: failing(f.health) ? f.reason : undefined,
      }))} />
    </Panel>
  );
}

// The supply's rails, each with how far it is off its nominal voltage.
function Voltages({ power }: { power: HwPart | undefined }) {
  const rails = power?.readings.filter((r) => r.unit === "V") ?? [];
  if (!power || !rails.length) return null;
  const nominal = (label: string) => (/12/.test(label) ? 12 : /3\.?3|3vcc/i.test(label) ? 3.3 : 5);
  const watts = power.readings.filter((r) => r.unit === "W");
  return (
    <Panel span={4} title="Voltages" health={power.health}>
      <Rows rows={[
        ...rails.map((r) => {
          const off = ((r.value - nominal(r.label)) / nominal(r.label)) * 100;
          return { key: r.label, label: r.label, value: `${r.value.toFixed(2)} V`, note: `${off >= 0 ? "+" : ""}${off.toFixed(1)}%`, health: r.health };
        }),
        ...watts.map((r) => ({ key: r.label, label: r.label, value: `${Math.round(r.value)} W` })),
      ]} />
      <Reason part={power} />
    </Panel>
  );
}

// Graphics: each card nvidia-smi reads with its figures, the rest by their state.
function Graphics({ gpus }: { gpus: HwPart[] }) {
  if (!gpus.length) return null;
  const read = gpus.filter((g) => g.readings.some((r) => r.unit !== "°C") || fact(g, "Memory"));
  const rest = gpus.filter((g) => !read.includes(g));
  return (
    <Panel span={6} title="Graphics" health={worst(gpus)}>
      {read.map((g) => {
        const t = reading(g, "Temperature");
        const load = reading(g, "Load");
        const fan = reading(g, "Fan");
        const power = reading(g, "Power");
        const limit = Number.parseFloat(fact(g, "Power limit"));
        const mem = fact(g, "Memory").match(/([\d.]+) of ([\d.]+)/);
        return (
          <div key={g.id} className="gpu">
            <b className="gpu-name">{g.name}</b>
            <Figures items={[
              t && ["Temperature", degrees(t.value), t.health],
              load && ["Load", pct(load.value)],
              fan && ["Fan", `${Math.round(fan.value)}%`],
              power && ["Power", limit ? `${Math.round(power.value)} of ${Math.round(limit)} W` : `${Math.round(power.value)} W`],
            ]} />
            {mem && <Rows rows={[{ key: "vram", label: "Video memory", value: `${bytes(Number(mem[1]) * 2 ** 20)} of ${bytes(Number(mem[2]) * 2 ** 20)}`, fill: Number(mem[1]) / Number(mem[2]) }]} />}
            <Reason part={g} />
          </div>
        );
      })}
      {rest.length > 0 && <Rows rows={rest.map((g) => ({ key: g.id, label: g.name, value: g.reason || "Unknown", health: g.health }))} />}
    </Panel>
  );
}

// The System log's crashes, hardware errors and power losses.
function Log({ snap }: { snap: HwSnapshot | null }) {
  if (!snap || (snap.platform !== "windows" && !snap.events.length)) return null;
  return (
    <Panel span={6} title="System log" health={snap.notes.length ? worst(snap.notes) : "ok"} sub="Last 30 days">
      {snap.events.length ? (
        <ul className="events">
          {snap.events.slice(0, 6).map((e, i) => (
            <li key={i}>
              <span className={"dot " + e.health} />
              <span className="events-text" title={e.text}>{e.text}</span>
              <time>{new Date(e.at * 1000).toLocaleDateString([], { month: "short", day: "numeric" })}</time>
            </li>
          ))}
        </ul>
      ) : <p className="empty-note">No crashes, hardware errors or power losses.</p>}
    </Panel>
  );
}

function Volumes({ m }: { m: Metrics }) {
  return (
    <Panel span={6} title="Volumes" flush>
      {m.disks.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th className="grow">Volume</th><th>Used</th><th>Free</th><th>Size</th></tr></thead>
            <tbody>
              {m.disks.map((d) => {
                const used = d.total - d.available;
                return (
                  <tr key={d.name + d.mount}>
                    <td className="name-cell"><span className="mono">{d.mount}</span><small>{[d.name, d.fs].filter(Boolean).join(" · ")}</small></td>
                    <td><Meter value={used} max={d.total} label={pct((used / d.total) * 100)} /></td>
                    <td className="num">{bytes(d.available)}</td>
                    <td className="num">{bytes(d.total)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : <p className="empty-note card-pad">No volumes found.</p>}
    </Panel>
  );
}

// The physical drives: their health, and with Advanced their temperature,
// life, errors and hours, each column only where some drive reports it.
function Drives({ drives, advanced }: { drives: HwPart[]; advanced: boolean }) {
  if (!drives.length) return null;
  const life = (d: HwPart) => {
    const left = reading(d, "Life left");
    const worn = reading(d, "Worn");
    return left ? { value: left.value, health: left.health } : worn ? { value: 100 - worn.value, health: worn.health } : null;
  };
  const show = {
    temp: advanced && drives.some((d) => reading(d, "Temperature")),
    life: advanced && drives.some((d) => life(d)),
    errors: advanced && drives.some((d) => reading(d, "Uncorrected errors")),
    hours: advanced && drives.some((d) => fact(d, "Powered on")),
  };
  return (
    <Panel span={6} title="Drives" health={worst(drives)} flush>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="grow">Drive</th><th>Health</th>
              {show.temp && <th>Temperature</th>}{show.life && <th>Life left</th>}{show.errors && <th>Errors</th>}{show.hours && <th>Powered on</th>}
            </tr>
          </thead>
          <tbody>
            {drives.map((d) => {
              const t = reading(d, "Temperature");
              const l = life(d);
              const e = reading(d, "Uncorrected errors");
              return (
                <tr key={d.id}>
                  <td className="name-cell">{d.name}<small>{[fact(d, "Kind"), fact(d, "Size")].filter(Boolean).join(" · ")}</small></td>
                  <td>
                    <span className="health-line" title={d.reason || undefined}>
                      <span className={"dot " + (d.health === "unknown" ? "" : d.health)} />
                      {d.health === "ok" ? "Healthy" : failing(d.health) ? d.reason : "Unknown"}
                    </span>
                  </td>
                  {show.temp && <td className="num" data-health={t?.health}>{t ? degrees(t.value) : ""}</td>}
                  {show.life && <td className="num" data-health={l?.health}>{l ? `${Math.round(l.value)}%` : ""}</td>}
                  {show.errors && <td className="num" data-health={e?.health}>{e ? e.value.toLocaleString() : ""}</td>}
                  {show.hours && <td className="num">{fact(d, "Powered on")}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function Containers({ m }: { m: Metrics }) {
  const list = m.docker.containers;
  const running = list.filter((c) => c.state === "running").length;
  return (
    <Panel span={12} title="Containers" sub={m.docker.reachable ? `${running} running of ${list.length}` : undefined} flush
      now={<a className="btn small" href="#/containers">Manage</a>}>
      {!m.docker.reachable ? <p className="empty-note card-pad">Docker is not reachable: {m.docker.error}</p>
        : !list.length ? <p className="empty-note card-pad">No containers.</p>
        : (
          <div className="table-wrap">
            <table className="table containers">
              <thead><tr><th className="grow">Container</th><th>CPU</th><th>Memory</th><th>Network</th><th>Disk</th><th>Status</th></tr></thead>
              <tbody>{list.map((c) => <ContainerRow key={c.id} c={c} keep={m.keep} hostMemory={m.memory_total} />)}</tbody>
            </table>
          </div>
        )}
    </Panel>
  );
}

function ContainerRow({ c, keep, hostMemory }: { c: ContainerStats; keep: number; hostMemory: number }) {
  const on = c.state === "running";
  const limit = c.memory_limit && c.memory_limit < hostMemory * 4 ? c.memory_limit : hostMemory;
  return (
    <tr className={on ? "" : "stopped"}>
      <td className="name-cell"><span className="name-line"><span className={"dot " + (on ? "ok" : "")} />{c.name}</span><small>{c.image}</small></td>
      <td>{on && (
        <span className="cpu-cell">
          <Spark values={c.history} max={Math.max(c.cpu_limit ? c.cpu_limit * 100 : 100, ...c.history)} keep={keep} times={[]} every={0} color={BLUE} />
          <span className="num">{pct(c.cpu)}{c.cpu_limit > 0 && <small> of {pct(c.cpu_limit * 100)}</small>}</span>
        </span>
      )}</td>
      <td>{on && <Meter value={c.memory} max={limit} label={bytes(c.memory)} />}</td>
      <td className="num">{on && <>↓ {rate(c.rx)}<br />↑ {rate(c.tx)}</>}</td>
      <td className="num">{on && <>R {rate(c.read)}<br />W {rate(c.write)}</>}</td>
      <td className="muted">{c.status}</td>
    </tr>
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
    <Panel span={12} title="New devices" health="warn" sub={`${flags.length} sign-in${flags.length === 1 ? "" : "s"}`} flush>
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
    </Panel>
  );
}

// Setup is how Advanced's sensors are doing where they need something: the
// one Windows prompt to turn them on, its step and percent while it runs, and
// why the sensor task stopped when it has.
function Setup({ hw, admin, busy, onEnable }: { hw: Hardware; admin: boolean; busy: boolean; onEnable: () => void }) {
  if (hw.platform === "macos") {
    return <div className="callout"><Icon name="info" /><span>Sensor readings cover Windows and Linux.</span></div>;
  }
  const snap = hw.snapshot;
  if (!snap) return null;
  const why = snap.helper_error && <> {snap.helper_error}</>;
  switch (snap.helper) {
    case "off":
      return (
        <div className="callout held">
          <Icon name="shield" />
          <span>Temperatures, fans, voltages and drive wear need administrator rights once, to install the <b>PawnIO</b> driver and a sensor task that runs as SYSTEM.</span>
          {admin ? (
            <button type="button" className="btn primary small" disabled={busy} onClick={onEnable}>
              {busy ? <span className="spinner on-accent" /> : <Icon name="shield" size={16} />}Enable
            </button>
          ) : <span className="muted">The host or an admin can enable this.</span>}
        </div>
      );
    case "waiting":
      return <div className="callout held"><span className="spinner small" /><span>Waiting for the Windows prompt on this computer's screen to be approved.</span></div>;
    case "installing":
      return (
        <div className="callout held setup-progress">
          <span className="spinner small" />
          <span>{snap.helper_step || "Setting up the sensor task"} · {snap.helper_percent ?? 0}%</span>
          <span className="setup-bar" style={{ width: `${snap.helper_percent ?? 0}%` }} aria-hidden />
        </div>
      );
    case "starting":
      return <div className="callout held"><span className="spinner small" /><span>Starting the sensor task. Its first readings arrive within a minute.{why}</span></div>;
    case "missing":
      return (
        <div className="callout warn held">
          <Icon name="warning" /><span>The sensor task is not installed.{why}</span>
          {admin && <button type="button" className="btn small" disabled={busy} onClick={onEnable}>Set it up</button>}
        </div>
      );
    case "stale":
      return <div className="callout bad held"><Icon name="error" /><span>The sensor task stopped sending readings; Windows starts it again within a minute.{why}</span></div>;
    default:
      return null;
  }
}

function Legend({ items }: { items: [string, string][] }) {
  return (
    <span className="legend">
      {items.map(([label, color]) => <span key={label}><i style={{ background: color }} />{label}</span>)}
    </span>
  );
}

// ---- words and numbers ----

function cores(m: Metrics) {
  return m.host.cores && m.host.cores !== m.host.threads ? `${m.host.cores} cores, ${m.host.threads} threads` : `${m.host.threads} threads`;
}

const pct = (n: number) => `${n < 10 ? n.toFixed(1) : Math.round(n)}%`;
const degrees = (n: number) => `${Math.round(n)}°C`;
const rate = (n: number) => `${bytes(n)}/s`;

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
