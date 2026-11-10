import { useEffect, useState, type ReactNode } from "react";
import { ago, api, message, type Hardware, type Health, type HwPart, type HwSnapshot, type Metrics } from "./api";
import { Bars, bytes, Donut, Gauge } from "./Dashboard";
import { Icon, type IconName } from "./Icon";
import { useMe } from "./me";
import { CardArt, CpuArt, DriveArt, FanArt, PsuArt, RenderDefs, StickArt } from "./Renders";
import { Callout, MoreMenu, useNotify } from "./ui";

const failing = (h: Health) => h === "warn" || h === "bad";
const worst = (parts: HwPart[]): Health =>
  parts.some((p) => p.health === "bad") ? "bad" : parts.some((p) => p.health === "warn") ? "warn" : parts.some((p) => p.health === "ok") ? "ok" : "unknown";
const reading = (p: HwPart | undefined, label: string) => p?.readings.find((r) => r.label === label);
const fact = (p: HwPart | undefined, key: string) => p?.facts.find(([k]) => k === key)?.[1] ?? "";
const gbOf = (b: number) => `${Math.round(b / 2 ** 30)} GB`;
const VERDICT: Record<Health, string> = { ok: "Healthy", warn: "Check", bad: "Failing", empty: "", unknown: "No readings" };

// HardwarePage is a section for each kind of part, each laid out for what it
// is: memory as its share in use beside every slot the board has, filled or
// empty; the processor beside its load and each core; the graphics card with
// its temperature, load, fan, power and memory; every fan header; the power
// supply's rails; the drives; the board and its log. Off until enabled.
export function HardwarePage() {
  const me = useMe();
  const admin = me.admin || me.host;
  const notify = useNotify();
  const [hw, setHw] = useState<Hardware | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => {
      api.hardware().then((h) => alive && setHw(h)).catch(() => {});
      api.metrics().then((m) => alive && setMetrics(m)).catch(() => {});
    };
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

  if (!hw) return null;
  // Until it is enabled, the Enable panel carries the page's name.
  if (!hw.enabled) return <Enable hw={hw} admin={admin} busy={busy} onEnable={() => act(api.enableHardware)} />;
  const snap = hw.snapshot;
  const problems = snap ? [...snap.parts, ...snap.notes].filter((p) => failing(p.health)).length : 0;
  const of = (kind: string) => snap?.parts.filter((p) => p.kind === kind) ?? [];

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Hardware</h1>
          {snap && (
            <div className="page-sub">
              <span className="hw-summary"><span className={"dot " + (problems ? "bad" : "ok")} />{problems ? `${problems} need${problems === 1 ? "s" : ""} attention` : "All healthy"}</span>
              <span>Read {ago(snap.at)}</span>
            </div>
          )}
        </div>
        {admin && (
          <div className="page-actions">
            <MoreMenu label="More" actions={[{
              label: "Disable", icon: "block", danger: true,
              confirm: hw.platform === "windows" ? "Disable and remove the sensor task" : "Disable",
              onClick: () => act(api.disableHardware),
            }]} />
          </div>
        )}
      </div>
      {!snap ? <div className="empty"><span className="spinner small" /></div> : (
        <div className="page-body">
          <RenderDefs />
          <Helper snap={snap} admin={admin} busy={busy} onSetUp={() => act(api.enableHardware)} />
          {snap.notes.map((n) => (
            <Callout key={n.id} tone={n.health === "bad" ? "bad" : "warn"} icon={n.health === "bad" ? "error" : "warning"}>{n.name}</Callout>
          ))}
          <div className="hw-grid">
            <Memory snap={snap} metrics={metrics} admin={admin} onForget={(slot) => act(() => api.forgetSlot(slot))} />
            <Processor cpu={of("cpu")[0]} metrics={metrics} />
            <Graphics gpus={of("gpu")} />
            <Fans fans={of("fan")} />
            <Power power={of("power")[0]} />
            <Drives drives={of("drive")} />
            <Board board={of("board")[0]} snap={snap} />
          </div>
        </div>
      )}
    </>
  );
}

// Section is one kind of part: its title, how it is doing, and its body.
function Section({ icon, title, health, sub, className = "", children }: { icon: IconName; title: string; health: Health; sub?: string; className?: string; children: ReactNode }) {
  return (
    <section className={"card hw-sec " + className}>
      <div className="hw-sec-head">
        <Icon name={icon} size={18} />
        <h2>{title}</h2>
        {sub && <span className="hw-sec-sub">{sub}</span>}
        {VERDICT[health] && <span className={"chip " + (health === "unknown" ? "" : health)}>{VERDICT[health]}</span>}
      </div>
      <div className="hw-sec-body">{children}</div>
    </section>
  );
}

// A figure with its name under it, coloured by its health.
function Stat({ value, label, health }: { value: string; label: string; health?: Health }) {
  return (
    <div className={"hw-stat " + (health ?? "")}>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

// A bar for a share of something, coloured by its health.
function Meter({ share, health }: { share: number; health?: Health }) {
  return <span className={"hw-meter " + (health ?? "")}><span style={{ width: `${Math.min(Math.max(share, 0), 1) * 100}%` }} /></span>;
}

// Memory: how much is in use, beside every slot the board has.
function Memory({ snap, metrics, admin, onForget }: { snap: HwSnapshot; metrics: Metrics | null; admin: boolean; onForget: (slot: string) => void }) {
  const slots = snap.parts.filter((p) => p.kind === "memory").sort((a, b) => a.place.localeCompare(b.place));
  const sticks = slots.filter((p) => p.bytes);
  const installed = sticks.reduce((n, p) => n + (p.bytes ?? 0), 0);
  const total = metrics?.memory_total ?? installed;
  const used = metrics?.history.at(-1)?.memory ?? 0;
  const count = Math.max(snap.slots, slots.length);
  const cells = Array.from({ length: count }, (_, i) => slots[i]);
  return (
    <Section icon="layers" title="Memory" health={worst(slots)} sub={`${sticks.length} of ${count} slots${snap.ecc ? " · ECC" : ""}`}>
      <div className="hw-memory">
        <div className="hw-donut">
          <Donut parts={[{ value: used, color: "var(--s1)" }, { value: Math.max(0, total - used), color: "var(--s2)" }]} />
          <div className="hw-donut-mid"><b>{bytes(total)}</b><span>{total ? `${Math.round((used / total) * 100)}% in use` : ""}</span></div>
        </div>
        <div className="hw-slots">
          {cells.map((p, i) => (
            <div key={p?.id ?? i} className={"hw-slot " + (p?.health ?? "empty")} title={p?.facts.map(([k, v]) => `${k}: ${v}`).join("\n") || undefined}>
              <StickArt part={p} gb={p?.bytes ? gbOf(p.bytes) : ""} />
              <span className="hw-slot-name">{p?.place.replace(/^Channel([A-Z])-DIMM(\d+)$/, (_, c: string, d: string) => `${c}${Number(d) + 1}`) || `Slot ${i + 1}`}</span>
              {p?.health === "bad" && !p.bytes && admin && <button type="button" className="hw-link" onClick={() => onForget(p.place)}>Taken out</button>}
            </div>
          ))}
        </div>
      </div>
      {sticks.some((p) => failing(p.health)) && <p className="hw-reason warn">{sticks.find((p) => failing(p.health))?.reason}</p>}
      <div className="hw-legend">
        <span><i style={{ background: "var(--s1)" }} />In use <b>{bytes(used)}</b></span>
        <span><i style={{ background: "var(--s2)" }} />Free <b>{bytes(Math.max(0, total - used))}</b></span>
        {sticks[0] && <span>{fact(sticks[0], "Running at") || fact(sticks[0], "Rated speed")}</span>}
      </div>
    </Section>
  );
}

// The processor: its chip, its temperature and load, and each core.
function Processor({ cpu, metrics }: { cpu: HwPart | undefined; metrics: Metrics | null }) {
  if (!cpu) return null;
  const t = reading(cpu, "Temperature");
  const power = reading(cpu, "Power");
  const load = metrics?.history.at(-1)?.cpu ?? reading(cpu, "Load")?.value ?? 0;
  const coreTemps = cpu.readings.filter((r) => /^Core \d+$/.test(r.label));
  const usage = metrics?.cores.map((c) => c.usage) ?? [];
  return (
    <Section icon="memory" title="Processor" health={cpu.health} sub={fact(cpu, "Cores")}>
      {/* The chip over its load on one side, its figures on the other. */}
      <div className="hw-cpu">
        <div className="hw-cpu-side">
          <div className="hw-cpu-art"><CpuArt part={cpu} /></div>
          <div className="hw-cpu-gauge"><Gauge value={load} label="Load" /></div>
        </div>
        <div className="hw-cpu-stats">
          <Stat value={t ? `${Math.round(t.value)}°C` : "—"} label="Package" health={t?.health} />
          {power && <Stat value={`${Math.round(power.value)} W`} label="Power" />}
          <Stat value={fact(cpu, "Base clock") || "—"} label="Base clock" />
        </div>
      </div>
      {coreTemps.length > 0 ? (
        <div className="hw-bars"><span className="hw-bars-title">Each core, °C</span><Bars heat values={coreTemps.map((r) => r.value)} max={100} format={(n) => `${Math.round(n)}`} /></div>
      ) : usage.length > 0 && (
        <div className="hw-bars"><span className="hw-bars-title">Each thread, % in use</span><Bars values={usage} max={100} format={(n) => `${Math.round(n)}`} /></div>
      )}
      {failing(cpu.health) && <p className={"hw-reason " + cpu.health}>{cpu.reason}</p>}
    </Section>
  );
}

// The graphics card: its face, and its temperature, load, fan, power and memory.
function Graphics({ gpus }: { gpus: HwPart[] }) {
  const card = gpus.find((g) => g.id.startsWith("gpu:nvidia")) ?? gpus.find((g) => !/intel|uhd|iris/i.test(g.name)) ?? gpus[0];
  if (!card) return null;
  const others = gpus.filter((g) => g !== card);
  const t = reading(card, "Temperature");
  const load = reading(card, "Load");
  const fan = reading(card, "Fan");
  const power = reading(card, "Power");
  const limit = Number.parseFloat(fact(card, "Power limit"));
  const mem = fact(card, "Memory").match(/([\d.]+) of ([\d.]+)/);
  return (
    <Section icon="monitor" title="Graphics" health={card.health} sub={card.name.replace(/^NVIDIA\s+/, "")}>
      {card.id.startsWith("gpu:nvidia") || !/intel|uhd|iris/i.test(card.name) ? <div className="hw-card-art"><CardArt part={card} /></div> : null}
      <div className="hw-stats">
        <Stat value={t ? `${Math.round(t.value)}°C` : "—"} label="Temperature" health={t?.health} />
        <Stat value={load ? `${Math.round(load.value)}%` : "—"} label="Load" />
        <Stat value={fan ? `${Math.round(fan.value)}%` : "—"} label="Fan" />
        <Stat value={power ? `${Math.round(power.value)} W` : "—"} label={limit ? `Power of ${Math.round(limit)} W` : "Power"} />
      </div>
      {mem && (
        <div className="hw-row"><span>Video memory</span><Meter share={Number(mem[1]) / Number(mem[2])} /><b>{bytes(Number(mem[1]) * 2 ** 20)} of {bytes(Number(mem[2]) * 2 ** 20)}</b></div>
      )}
      {others.map((g) => <div key={g.id} className="hw-row"><span className={"dot " + (g.health === "unknown" ? "" : g.health)} /><span>{g.name}</span><b>{g.reason}</b></div>)}
      {failing(card.health) && <p className={"hw-reason " + card.health}>{card.reason}</p>}
    </Section>
  );
}

// Every fan header: each fan turning at its speed, the empty ones dim.
function Fans({ fans }: { fans: HwPart[] }) {
  if (!fans.length) return null;
  const connected = fans.filter((f) => f.health !== "empty");
  return (
    <Section icon="mode_fan" title="Fans" health={worst(connected)} sub={`${connected.length} of ${fans.length} headers`}>
      <div className="hw-fans">
        {fans.map((f) => {
          const rpm = f.readings[0]?.value ?? 0;
          const on = f.health !== "empty";
          return (
            <div key={f.id} className={"hw-fan " + f.health} title={f.reason || undefined}>
              <FanArt rpm={rpm} connected={on} />
              <b>{on ? `${Math.round(rpm)} RPM` : "Empty"}</b>
              <span>{f.name}</span>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

// The power supply: each rail against its nominal voltage, 5% either way healthy.
function Power({ power }: { power: HwPart | undefined }) {
  if (!power) return null;
  const rails = power.readings.filter((r) => r.unit === "V");
  const nominal = (label: string) => (/12/.test(label) ? 12 : /3\.?3|3vcc/i.test(label) ? 3.3 : 5);
  return (
    <Section icon="bolt" title="Power" health={power.health}>
      <div className="hw-power">
        <div className="hw-psu-art"><PsuArt /></div>
        <div className="hw-rails">
          {rails.length ? rails.map((r) => {
            const n = nominal(r.label);
            // A scale from 10% under to 10% over the rail's voltage.
            const share = (r.value - n * 0.9) / (n * 0.2);
            return (
              <div key={r.label} className="hw-rail">
                <span>{r.label}</span>
                <span className={"hw-scale " + r.health}><i className="hw-band" /><i className="hw-mark" style={{ left: `${Math.min(Math.max(share, 0), 1) * 100}%` }} /></span>
                <b className={r.health}>{r.value.toFixed(2)} V</b>
              </div>
            );
          }) : <p className="hw-reason">{power.reason || "This board reports no supply voltages"}</p>}
        </div>
      </div>
      {failing(power.health) && rails.length > 0 && <p className={"hw-reason " + power.health}>{power.reason}</p>}
    </Section>
  );
}

// The drives: each one with its temperature, life and errors.
function Drives({ drives }: { drives: HwPart[] }) {
  if (!drives.length) return null;
  return (
    <Section icon="hard_drive" title="Drives" health={worst(drives)}>
      <div className="hw-drives">
        {drives.map((d) => {
          const t = reading(d, "Temperature");
          const life = reading(d, "Life left");
          const worn = reading(d, "Worn");
          const errors = reading(d, "Uncorrected errors");
          return (
            <div key={d.id} className={"hw-drive " + d.health}>
              <div className="hw-drive-art"><DriveArt part={d} /></div>
              <div className="hw-drive-text">
                <b>{d.name}</b>
                <span>{[fact(d, "Size"), fact(d, "Kind"), fact(d, "Powered on")].filter(Boolean).join(" · ")}</span>
                <div className="hw-chips">
                  {t && <span className={"chip " + t.health}>{Math.round(t.value)}°C</span>}
                  {life && <span className={"chip " + life.health}>{Math.round(life.value)}% life left</span>}
                  {!life && worn && <span className={"chip " + worn.health}>{Math.round(worn.value)}% worn</span>}
                  {errors && <span className={"chip " + errors.health}>{errors.value ? `${errors.value} errors` : "No errors"}</span>}
                  {!t && !life && !worn && !errors && <span className={"chip " + (d.health === "unknown" ? "" : d.health)}>{d.reason || VERDICT[d.health]}</span>}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

// The board: its temperatures, and the last month's crashes and power losses.
function Board({ board, snap }: { board: HwPart | undefined; snap: HwSnapshot }) {
  if (!board) return null;
  const temps = board.readings.filter((r) => r.unit === "°C");
  return (
    <Section icon="developer_board" title="Board" health={board.health} sub={board.name}>
      {/* Its temperatures side by side, across the whole width. */}
      {temps.length > 0 && (
        <div className="hw-temps">
          {temps.map((r) => <Stat key={r.label} value={`${Math.round(r.value)}°C`} label={r.label} health={r.health} />)}
        </div>
      )}
      {snap.events.length > 0 && (
        <ul className="hw-events">
          {snap.events.slice(0, 4).map((e, i) => (
            <li key={i}>
              <span className={"dot " + e.health} />
              <span className="hw-event-text" title={e.text}>{e.text}</span>
              <time>{new Date(e.at * 1000).toLocaleDateString([], { month: "short", day: "numeric" })}</time>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// Enable says what enabling the page does, before anything is asked for.
function Enable({ hw, admin, busy, onEnable }: { hw: Hardware; admin: boolean; busy: boolean; onEnable: () => void }) {
  if (hw.platform === "macos") {
    return <div className="card welcome"><Icon name="memory" size={40} /><h2>Hardware</h2><p>Hardware monitoring covers Windows and Linux.</p></div>;
  }
  return (
    <div className="card welcome hw-intro">
      <Icon name="memory" size={40} />
      <h2>Hardware</h2>
      <p>Every part of this computer, each memory stick by its slot, the processor, graphics, drives, fans and power, green while healthy and red when failing, read every few seconds.</p>
      {hw.platform === "windows" && (
        <>
          <p>Temperatures, fan speeds, voltages and drive wear need administrator rights. Enabling this asks Windows once, on this computer's screen, and then:</p>
          <ul className="bullets">
            <li>installs the <b>PawnIO</b> driver, which reads the board's sensor chips</li>
            <li>puts <b>LibreHardwareMonitor</b>'s sensor library in <code>Program Files\myTunnels\hardware</code></li>
            <li>adds a task that reads the sensors every few seconds as SYSTEM, from startup</li>
          </ul>
          <p>Disabling it removes the task and those files. PawnIO stays installed, under Installed apps.</p>
        </>
      )}
      <p>When a part starts failing or recovers, the host and admins get an email once SMTP is set up under Security, Two-Factor Auth.</p>
      {admin ? (
        <button type="button" className="btn primary" disabled={busy} onClick={onEnable}>
          {/* Windows marks a button that asks for administrator rights with its shield. */}
          {busy ? <span className="spinner on-accent" /> : hw.platform === "windows" && <Icon name="shield" size={18} />}Enable
        </button>
      ) : <p className="muted">The host or an admin can enable this.</p>}
    </div>
  );
}

// Helper is how Windows' sensor task is doing, when it is not simply running:
// setup's step and percent while it runs, and why it stopped when it has.
function Helper({ snap, admin, busy, onSetUp }: { snap: HwSnapshot; admin: boolean; busy: boolean; onSetUp: () => void }) {
  const why = snap.helper_error && <> {snap.helper_error}</>;
  switch (snap.helper) {
    case "waiting":
      return <div className="callout held"><span className="spinner small" /><span>Waiting for the Windows prompt on this computer's screen to be approved.</span></div>;
    case "installing":
      return (
        <div className="callout held hw-setup">
          <span className="spinner small" />
          <span>{snap.helper_step || "Setting up the sensor task"} · {snap.helper_percent ?? 0}%</span>
          <span className="hw-setup-bar" style={{ width: `${snap.helper_percent ?? 0}%` }} aria-hidden />
        </div>
      );
    case "starting":
      return <div className="callout held"><span className="spinner small" /><span>Starting the sensor task. Its first readings arrive within a minute.{why}</span></div>;
    case "missing":
      return (
        <div className="callout warn held">
          <Icon name="warning" /><span>Temperatures, fans, voltages and drive wear need the sensor task.{why}</span>
          {admin && <button type="button" className="btn small" disabled={busy} onClick={onSetUp}>Set it up</button>}
        </div>
      );
    case "stale":
      return <div className="callout bad held"><Icon name="error" /><span>The sensor task stopped sending readings; Windows starts it again within a minute.{why}</span></div>;
    default:
      return null;
  }
}
