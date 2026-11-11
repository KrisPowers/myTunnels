import { useEffect, useState, type ReactNode } from "react";
import { ago, api, bytes, message, shortId, type Device, type Flag, type Hardware, type Health, type HwPart, type HwSnapshot, type Metrics, type User } from "./api";
import { Chart, Meter } from "./charts";
import { Icon } from "./Icon";
import { useCan, useMe } from "./me";
import { Dialog, useNotify } from "./ui";

// Chart colours, in a fixed order: blue, violet, orange.
const BLUE = "var(--s1)";
const VIOLET = "var(--s2)";
const ORANGE = "var(--s3)";
const SERIES = [BLUE, VIOLET, ORANGE];

const failing = (h?: Health) => h === "warn" || h === "bad";
const reading = (p: HwPart | undefined, label: string) => p?.readings.find((r) => r.label === label);
const fact = (p: HwPart | undefined, key: string) => p?.facts.find(([k]) => k === key)?.[1] ?? "";
const dot = (h?: Health) => "dot" + (h === "ok" || failing(h) ? " " + h : "");

// DashboardPage is the host the way UniFi shows a console: a column of its
// facts on the left, under each part by its health, and on the right a chart
// of the last five minutes over its storage. Advanced adds
// the sensors (temperatures, fans, voltages, drive wear), turned on once by
// the host or an admin, since on Windows they need administrator rights.
export function DashboardPage({ flags, users, devices, onChanged }: { flags: Flag[]; users: User[]; devices: Device[]; onChanged: () => Promise<void> }) {
  const me = useMe();
  const admin = me.admin || me.host;
  const notify = useNotify();
  const [m, setM] = useState<Metrics | null>(null);
  const [problem, setProblem] = useState("");
  const [hw, setHw] = useState<Hardware | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);

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

  const advanced = !!hw?.enabled;
  const toggle = async () => {
    setAsking(false);
    setBusy(true);
    try {
      setHw(await (advanced ? api.disableHardware() : api.enableHardware()));
    } catch (e) {
      notify(message(e), "bad");
    } finally {
      setBusy(false);
    }
  };
  const forget = async (slot: string) => {
    try {
      setHw(await api.forgetSlot(slot));
    } catch (e) {
      notify(message(e), "bad");
    }
  };

  const snap = hw?.snapshot ?? null;
  const windows = hw?.platform === "windows";
  return (
    <>
      {asking && (
        <Dialog title={advanced ? "Turn off Advanced?" : "Turn on Advanced?"} onClose={() => setAsking(false)}>
          <p className="muted">
            {advanced
              ? windows ? "The sensor task and its files are removed, so temperatures, fans, voltages and drive wear stop being read. PawnIO stays installed." : "Temperatures are hidden again."
              : windows ? "Temperatures, fans, voltages and drive wear need administrator rights. Windows asks once on this computer's screen, then installs the PawnIO driver and a sensor task that runs as SYSTEM from startup." : hw?.platform === "macos" ? "Adds every temperature this Mac reports." : "Adds every temperature, fan and voltage this computer reports."}
          </p>
          <div className="edit-actions">
            <button type="button" className="btn text" onClick={() => setAsking(false)}>Cancel</button>
            <button type="button" className="btn primary danger-fill" autoFocus onClick={toggle}>{advanced ? "Turn off" : "Turn on"}</button>
          </div>
        </Dialog>
      )}
      {problem && <div className="callout bad"><Icon name="error" /><span>{problem}</span></div>}
      {advanced && snap && <Setup snap={snap} />}
      {m && m.history.length > 0 && (
        <div className="dash">
          <Side m={m} snap={snap} advanced={advanced} admin={admin} onForget={forget} toggle={admin && hw && (
            <button type="button" className={"icon-btn" + (advanced ? " lit" : "")} aria-label="Advanced" title="Advanced" aria-pressed={advanced} disabled={busy} onClick={() => setAsking(true)}>
              {busy ? <span className="spinner small" /> : <Icon name={windows ? "shield" : "tune"} size={20} />}
            </button>
          )} />
          <div className="dash-main">
            {flags.length > 0 && <NewDevices flags={flags} users={users} devices={devices} onChanged={onChanged} />}
            <Trend m={m} cpu={snap?.parts.find((p) => p.kind === "cpu")} advanced={advanced} />
            <Storage m={m} drives={snap?.parts.filter((p) => p.kind === "drive") ?? []} advanced={advanced} />
          </div>
        </div>
      )}
    </>
  );
}

// ---- the column of facts ----

// owned names the page for the computer, "KrisComputer's Dashboard".
function owned(name?: string | null) {
  if (!name) return "Dashboard";
  return name + (name.endsWith("s") ? "' " : "'s ") + "Dashboard";
}

type Fact = [string, ReactNode, Health?] | false | null | undefined;

// Rows is a group of label and value pairs, those without a value left out.
function Rows({ items }: { items: Fact[] }) {
  const shown = items.filter((f): f is [string, ReactNode, Health?] => !!f && f[1] !== null && f[1] !== undefined && f[1] !== "" && f[1] !== false);
  if (!shown.length) return null;
  return (
    <dl className="side-rows">
      {shown.map(([label, value, health], i) => (
        <div key={label + i} data-health={health}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Side({ m, snap, advanced, admin, onForget, toggle }: { m: Metrics; snap: HwSnapshot | null; advanced: boolean; admin: boolean; onForget: (slot: string) => void; toggle: ReactNode }) {
  const parts = snap?.parts ?? [];
  const of = (kind: string) => parts.filter((p) => p.kind === kind);
  const cpu = of("cpu")[0];
  const board = of("board")[0];
  const power = of("power")[0];
  const fans = of("fan").filter((f) => f.health !== "empty");
  const gpus = of("gpu").filter((g) => g.readings.some((r) => r.unit !== "°C") || fact(g, "Memory"));
  const attention = [...parts, ...(snap?.notes ?? [])].filter((p) => failing(p.health));
  const status: Health = attention.some((p) => p.health === "bad") ? "bad" : attention.length ? "warn" : "ok";
  const temp = reading(cpu, "Temperature");
  return (
    <aside className="dash-side">
      <div className="side-head">
        <h1 className="side-name">{owned(m.host.name)}</h1>
        {toggle}
      </div>
      <Bays parts={parts} />
      {attention.length > 0 && (
        <div className="side-notes">
          {attention.map((p) => (
            <p key={p.id} data-health={p.health}>
              {p.id.startsWith("note:") ? p.name : p.reason}
              {admin && p.kind === "memory" && p.health === "bad" && !p.bytes && p.place && (
                <button type="button" className="link-btn" onClick={() => onForget(p.place)}>Taken out</button>
              )}
            </p>
          ))}
        </div>
      )}
      <Rows items={[
        ["Status", attention.length ? `${attention.length} need${attention.length === 1 ? "s" : ""} attention` : "Online", status],
        ["Platform", m.host.os],
        ["Processor", m.host.cpu],
        ["Cores", m.host.cores && m.host.cores !== m.host.threads ? `${m.host.cores} cores, ${m.host.threads} threads` : `${m.host.threads} threads`],
        ["Memory", bytes(m.memory_total)],
        ["Board", board?.name],
        advanced && temp && ["Temperature (CPU)", degrees(temp.value), failing(temp.health) ? temp.health : undefined],
        advanced && reading(cpu, "Power") && ["Power (CPU)", `${Math.round(reading(cpu, "Power")!.value)} W`],
        ["System Uptime", duration(m.uptime)],
        m.load && ["Load", m.load.map((n) => n.toFixed(2)).join("  ")],
      ]} />
      {gpus.map((g) => {
        const t = reading(g, "Temperature");
        const p = reading(g, "Power");
        const limit = Number.parseFloat(fact(g, "Power limit"));
        const mem = fact(g, "Memory").match(/([\d.]+) of ([\d.]+)/);
        return (
          <Rows key={g.id} items={[
            ["Graphics", g.name.replace(/^NVIDIA\s+/, "")],
            t && ["Temperature (GPU)", degrees(t.value), failing(t.health) ? t.health : undefined],
            reading(g, "Load") && ["Load (GPU)", pct(reading(g, "Load")!.value)],
            reading(g, "Fan") && ["Fan (GPU)", `${Math.round(reading(g, "Fan")!.value)}%`],
            p && ["Power (GPU)", limit ? `${Math.round(p.value)} of ${Math.round(limit)} W` : `${Math.round(p.value)} W`],
            mem && ["Video memory", `${bytes(Number(mem[1]) * 2 ** 20)} of ${bytes(Number(mem[2]) * 2 ** 20)}`],
          ]} />
        );
      })}
      {advanced && (
        <Rows items={[
          ...fans.map((f): Fact => ["Fan " + f.name.replace(/^Fan\s*/i, ""), `${Math.round(f.readings[0]?.value ?? 0).toLocaleString()} RPM`, failing(f.health) ? f.health : undefined]),
          ...(power?.readings ?? []).map((r): Fact => [r.label, r.unit === "V" ? `${r.value.toFixed(2)} V` : `${Math.round(r.value)} ${r.unit}`, failing(r.health) ? r.health : undefined]),
          ...(board?.readings ?? []).filter((r) => r.unit === "°C").map((r): Fact => [r.label, degrees(r.value), failing(r.health) ? r.health : undefined]),
        ]} />
      )}
    </aside>
  );
}

// Bays is each part by a dot lit by its health, as UniFi shows a
// console's drive bays: every memory slot, each drive and graphics card.
function Bays({ parts }: { parts: HwPart[] }) {
  const memory = parts.filter((p) => p.kind === "memory").sort((a, b) => a.place.localeCompare(b.place));
  const drives = parts.filter((p) => p.kind === "drive");
  const gpus = parts.filter((p) => p.kind === "gpu");
  if (!memory.length && !drives.length && !gpus.length) return null;
  const counted: Record<string, number> = {};
  const numbered = (kind: string, total: number) => {
    counted[kind] = (counted[kind] ?? 0) + 1;
    return total > 1 ? `${kind} ${counted[kind]}` : kind;
  };
  const kindOf = (d: HwPart) => {
    const k = fact(d, "Kind");
    return /nvme/i.test(k) ? "NVMe" : /ssd/i.test(k) ? "SSD" : /hdd/i.test(k) ? "HDD" : "Drive";
  };
  const chip = (p: HwPart, label: string) => {
    const vacant = p.health === "empty";
    return (
      <span key={p.id} className={"bay" + (vacant ? " vacant" : "")} title={vacant ? "Empty slot" : [p.name, p.reason].filter(Boolean).join("\n")}>
        <span className={vacant ? "dot" : dot(p.health)} />{label}
      </span>
    );
  };
  return (
    <div className="bays">
      {memory.map((p, i) => chip(p, !p.place && p.health !== "empty" ? "Memory" : "DIMM " + (p.place.replace(/^Channel([A-Z])-DIMM(\d+)$/, (_, c: string, d: string) => `${c}${Number(d) + 1}`) || i + 1)))}
      {drives.map((d) => chip(d, numbered(kindOf(d), drives.filter((x) => kindOf(x) === kindOf(d)).length)))}
      {gpus.map((g) => chip(g, numbered("GPU", gpus.length)))}
    </div>
  );
}

// ---- the main column ----

// Section is one block of the main column: a heading, links beside it, and
// the figure that matters now on the right.
function Section({ title, tabs, now, children }: { title: ReactNode; tabs?: ReactNode; now?: ReactNode; children: ReactNode }) {
  return (
    <section className="dash-sec">
      <div className="sec-head">
        <h2>{title}</h2>
        {tabs}
        {now && <span className="sec-now">{now}</span>}
      </div>
      {children}
    </section>
  );
}

type Tab = "CPU" | "Memory" | "Network" | "Temperature";

// Trend is the last five minutes of one figure, picked from the links.
function Trend({ m, cpu, advanced }: { m: Metrics; cpu: HwPart | undefined; advanced: boolean }) {
  const [tab, setTab] = useState<Tab>("CPU");
  const h = m.history;
  const last = h[h.length - 1];
  const hot = advanced && h.some((s) => s.temp !== null);
  const tabs: Tab[] = ["CPU", "Memory", "Network", ...(hot ? ["Temperature" as const] : [])];
  const open = tabs.includes(tab) ? tab : "CPU";
  const span = { times: h.map((s) => s.at), keep: m.keep, every: m.every, ticks: true };
  const total = m.memory_total || 1;
  const coreTemps = cpu?.readings.filter((r) => /^Core \d+$/.test(r.label)).map((r) => r.value) ?? [];
  const temps = coreTemps.length ? coreTemps : m.cores.map((c) => c.temp).filter((t): t is number => t !== null);
  const peak = Math.max(...h.map((s) => Math.max(s.rx, s.tx)));
  return (
    // The title stays put, so the links beside it never shift; the chart and
    // its figure fade in on each pick, and the threads' room is kept on every
    // tab, so nothing under the chart jumps.
    <Section title="Last 5 Minutes"
      tabs={<nav className="sub-nav sec-tabs">{tabs.map((t) => <button key={t} type="button" className={"sub-nav-item" + (t === open ? " on" : "")} aria-pressed={t === open} onClick={() => setTab(t)}>{t}</button>)}</nav>}
      now={<span key={open} className="trend-in">{open === "CPU" ? pct(last.cpu)
        : open === "Memory" ? `${bytes(last.memory)} of ${bytes(m.memory_total)}`
        : open === "Network" ? <Legend items={[[`In ${rate(last.rx)}`, BLUE], [`Out ${rate(last.tx)}`, ORANGE]]} />
        : last.temp !== null && degrees(last.temp)}</span>}>
      <div key={open} className="trend-in">
        {open === "CPU" && <Chart {...span} max={100} format={pct} lines={[{ label: "CPU", color: BLUE, values: h.map((s) => s.cpu) }]} />}
        {open === "Memory" && <Chart {...span} max={100} format={pct} lines={[{ label: "In use", color: VIOLET, values: h.map((s) => (s.memory / total) * 100) }]} />}
        {open === "Network" && <Chart {...span} max={nice(peak)} format={rate} lines={[{ label: "In", color: BLUE, values: h.map((s) => s.rx) }, { label: "Out", color: ORANGE, values: h.map((s) => s.tx) }]} />}
        {open === "Temperature" && <Chart {...span} max={Math.max(100, nice(Math.max(...h.map((s) => s.temp ?? 0))))} format={degrees} lines={[{ label: "Processor", color: ORANGE, values: h.map((s) => s.temp) }]} />}
      </div>
      <div className={"trend-extra" + (open === "CPU" ? "" : " off")} aria-hidden={open !== "CPU"}>
        <Strip label="Each thread" values={m.cores.map((c) => c.usage)} max={100} unit="%" />
        {advanced && <Strip heat label="Each core, °C" values={temps} max={100} unit="°C" />}
      </div>
    </Section>
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
            style={{ height: `${Math.max(Math.min(v / max, 1), 0.03) * 100}%` }} title={`${i + 1}: ${Math.round(v)}${unit}`} />
        ))}
      </div>
    </div>
  );
}

// Storage: every volume's share of the space in one bar, then the volumes
// and the drives they sit on.
function Storage({ m, drives, advanced }: { m: Metrics; drives: HwPart[]; advanced: boolean }) {
  const used = (d: Metrics["disks"][number]) => d.total - d.available;
  const free = m.disks.reduce((n, d) => n + d.available, 0);
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
  if (!m.disks.length && !drives.length) return null;
  return (
    <Section title="Storage">
      {m.disks.length > 0 && (
        <>
          <div className="usage-bar" aria-hidden>
            {m.disks.map((d, i) => <span key={d.name + d.mount} style={{ flexGrow: used(d), background: SERIES[i % 3] }} />)}
            <span className="usage-free" style={{ flexGrow: free }} />
          </div>
          <div className="legend usage-legend">
            {m.disks.map((d, i) => <span key={d.name + d.mount}><i style={{ background: SERIES[i % 3] }} />{d.mount} <b>{bytes(used(d))}</b></span>)}
            <span><i className="usage-free" />Free <b>{bytes(free)}</b></span>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th className="grow">Volume</th><th>Usage</th><th>Size</th></tr></thead>
              <tbody>
                {m.disks.map((d) => (
                  <tr key={d.name + d.mount}>
                    <td className="name-cell"><span className="mono">{d.mount}</span><small>{[d.name, d.fs].filter(Boolean).join(" · ")}</small></td>
                    <td><Meter value={used(d)} max={d.total} label={`${bytes(used(d))} / ${bytes(d.total)}`} /></td>
                    <td className="num">{bytes(d.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {drives.length > 0 && (
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
                    <td className="name-cell"><span className="name-line"><span className={dot(d.health)} />{d.name}</span><small>{[fact(d, "Kind"), fact(d, "Size")].filter(Boolean).join(" · ")}</small></td>
                    <td data-health={d.health} title={d.reason || undefined}>{d.health === "ok" ? "Healthy" : failing(d.health) ? d.reason : "Unknown"}</td>
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
      )}
    </Section>
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
    <Section title="New Devices" now={`${flags.length} sign-in${flags.length === 1 ? "" : "s"}`}>
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
    </Section>
  );
}

// Setup is the Windows sensor task while it is not simply running: waiting
// for the prompt, its step and percent, or why it stopped.
function Setup({ snap }: { snap: HwSnapshot }) {
  const why = snap.helper_error && <> {snap.helper_error}</>;
  switch (snap.helper) {
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
      return <div className="callout warn held"><Icon name="warning" /><span>The sensor task is not installed. Turn Advanced off and on again to set it up.{why}</span></div>;
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
  return d ? `${d}d ${h}h` : h ? `${h}h ${min}m` : `${min}m`;
}
