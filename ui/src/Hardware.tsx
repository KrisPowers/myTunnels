import { useEffect, useState } from "react";
import { ago, api, message, type Hardware, type Health, type HwPart, type HwSnapshot } from "./api";
import { Icon, type IconName } from "./Icon";
import { useMe } from "./me";
import { Callout, MoreMenu, useNotify } from "./ui";

// The kinds of part after memory, in the order the page shows them.
const KINDS: [string, string, IconName][] = [
  ["cpu", "Processor", "memory"],
  ["gpu", "Graphics", "monitor"],
  ["power", "Power", "bolt"],
  ["board", "Board", "developer_board"],
  ["drive", "Drives", "hard_drive"],
  ["fan", "Fans", "mode_fan"],
];

const failing = (h: Health) => h === "warn" || h === "bad";
const gb = (b: number) => `${Math.round((b / 2 ** 30) * 10) / 10} GB`;
const figure = (value: number, unit: string) => `${Number.isInteger(value) ? value : value.toFixed(unit === "V" ? 2 : 1)}${unit ? (unit === "%" ? "%" : ` ${unit}`) : ""}`;

// HardwarePage is every part of this computer, green when healthy and red when
// failing, read again every few seconds. Off until the host or an admin
// enables it, which on Windows asks for administrator rights once.
export function HardwarePage() {
  const me = useMe();
  const admin = me.admin || me.host;
  const notify = useNotify();
  const [hw, setHw] = useState<Hardware | null>(null);
  const [busy, setBusy] = useState(false);

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

  if (!hw) return null;
  // Until it is enabled, the Enable panel carries the page's name.
  if (!hw.enabled) return <Enable hw={hw} admin={admin} busy={busy} onEnable={() => act(api.enableHardware)} />;
  const snap = hw.snapshot;
  const problems = snap ? [...snap.parts, ...snap.notes].filter((p) => failing(p.health)).length : 0;

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
        <div className="page-body stack">
          <Helper snap={snap} admin={admin} busy={busy} onSetUp={() => act(api.enableHardware)} />
          {snap.notes.map((n) => (
            <Callout key={n.id} tone={n.health === "bad" ? "bad" : "warn"} icon={n.health === "bad" ? "error" : "warning"}>{n.name}</Callout>
          ))}
          <div className="hw-grid">
            <Memory snap={snap} admin={admin} onForget={(slot) => act(() => api.forgetSlot(slot))} />
            {KINDS.map(([kind, title, icon]) => {
              const parts = snap.parts.filter((p) => p.kind === kind);
              if (!parts.length) return null;
              return (
                <section key={kind} className="card">
                  <Head icon={icon} title={title} parts={parts} />
                  {kind === "fan" ? (
                    <div className="hw-part"><div className="hw-metrics">{parts.map((p) => <Metric key={p.id} label={p.name} value={p.readings[0]?.value ?? 0} unit="RPM" health={p.health} />)}</div></div>
                  ) : parts.map((p) => <Part key={p.id} part={p} />)}
                </section>
              );
            })}
            {snap.events.length > 0 && (
              <section className="card hw-full">
                <div className="hw-head"><Icon name="history" size={18} /><h2>Last 30 days</h2></div>
                <ul className="hw-events">
                  {snap.events.map((e, i) => (
                    <li key={i}>
                      <span className={"dot " + e.health} />
                      <span className="hw-event-text">{e.text}</span>
                      <time>{new Date(e.at * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// Head is a card's title, with how many of its parts need attention.
function Head({ icon, title, parts, sub }: { icon: IconName; title: string; parts: HwPart[]; sub?: string }) {
  const bad = parts.filter((p) => p.health === "bad").length;
  const warn = parts.filter((p) => p.health === "warn").length;
  return (
    <div className="hw-head">
      <Icon name={icon} size={18} />
      <h2>{title}</h2>
      {sub && <span className="hw-head-sub">{sub}</span>}
      {bad > 0 ? <span className="chip bad">{bad} failing</span> : warn > 0 ? <span className="chip warn">{warn} to check</span> : parts.some((p) => p.health === "ok") && <span className="chip ok">Healthy</span>}
    </div>
  );
}

function Metric({ label, value, unit, health }: { label: string; value: number; unit: string; health: Health }) {
  return (
    <div className={"hw-metric " + health}>
      <b>{figure(value, unit)}</b>
      <span>{label}</span>
    </div>
  );
}

// Part is one part in its card: its name and state, its readings as tiles,
// and what it is in one line.
function Part({ part }: { part: HwPart }) {
  return (
    <div className="hw-part">
      <div className="hw-part-top">
        <span className={"dot " + (part.health === "unknown" ? "" : part.health)} />
        <b>{part.name}</b>
        {part.place && <span className="hw-place">{part.place}</span>}
      </div>
      {part.reason && failing(part.health) && <div className={"hw-reason " + part.health}>{part.reason}</div>}
      {part.readings.length > 0 && (
        <div className="hw-metrics">{part.readings.map((r) => <Metric key={r.label} label={r.label} value={r.value} unit={r.unit} health={r.health} />)}</div>
      )}
      {part.readings.length === 0 && part.reason && !failing(part.health) && <div className="hw-reason">{part.reason}</div>}
      {part.facts.length > 0 && (
        <div className="hw-facts">{part.facts.map(([k, v]) => <span key={k}>{k} <b>{v}</b></span>)}</div>
      )}
    </div>
  );
}

// Memory is the board's slots: each stick, its size and share of the total,
// and its health; a slot that lost its stick in red; empty slots dashed.
function Memory({ snap, admin, onForget }: { snap: HwSnapshot; admin: boolean; onForget: (slot: string) => void }) {
  const slots = snap.parts.filter((p) => p.kind === "memory");
  if (!slots.length) return null;
  const sticks = slots.filter((p) => p.bytes);
  const total = sticks.reduce((n, p) => n + (p.bytes ?? 0), 0);
  const sub = [snap.slots ? `${sticks.length} of ${snap.slots} slots` : "", total ? gb(total) : "", snap.ecc ? "ECC" : "Non-ECC"].filter(Boolean).join(" · ");
  return (
    <section className="card hw-wide">
      <Head icon="memory" title="Memory" parts={slots} sub={sub} />
      <div className="hw-slots">
        {slots.map((p) => {
          const fact = (k: string) => p.facts.find(([key]) => key === k)?.[1] ?? "";
          return (
            <div key={p.id} className={"hw-slot " + p.health} title={p.facts.map(([k, v]) => `${k}: ${v}`).join("\n") || undefined}>
              <span className="hw-slot-place">{p.place || "Slot"}</span>
              {p.health === "empty" ? <span className="hw-slot-empty">Empty</span> : p.bytes ? (
                <>
                  <b>{gb(p.bytes)}<small>{total > 0 && ` ${Math.round((p.bytes / total) * 100)}%`}</small></b>
                  <span className="hw-slot-line">{p.name.replace(/^[\d.]+ [GM]B ?/, "")}</span>
                  <span className="hw-slot-line">{fact("Running at") || fact("Rated speed")}</span>
                  {failing(p.health) && <span className={"hw-reason " + p.health}>{p.reason}</span>}
                </>
              ) : (
                <>
                  <b className="bad">Missing</b>
                  <span className="hw-slot-line">{p.name}</span>
                  {admin && <button type="button" className="btn small" onClick={() => onForget(p.place)}>Taken out on purpose</button>}
                </>
              )}
            </div>
          );
        })}
      </div>
      {sticks.length > 1 && (
        <div className="hw-share" aria-hidden>
          {sticks.map((p) => <span key={p.id} className={p.health} style={{ flex: p.bytes }} title={`${p.place}: ${gb(p.bytes ?? 0)}`} />)}
        </div>
      )}
    </section>
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

// Helper is how Windows' sensor task is doing, when it is not simply running.
function Helper({ snap, admin, busy, onSetUp }: { snap: HwSnapshot; admin: boolean; busy: boolean; onSetUp: () => void }) {
  const button = (label: string) => admin && <button type="button" className="btn small" disabled={busy} onClick={onSetUp}>{label}</button>;
  const why = snap.helper_error && <> {snap.helper_error}</>;
  switch (snap.helper) {
    case "waiting":
      return <div className="callout held"><span className="spinner small" /><span>Approve the Windows prompt on this computer's screen to set up the sensor task.</span></div>;
    case "starting":
      return <div className="callout held"><span className="spinner small" /><span>Starting the sensor task. Its first readings arrive within a minute.{why}</span></div>;
    case "outdated":
      return <div className="callout warn held"><Icon name="warning" /><span>The sensor task is from an earlier release.</span>{button("Update it")}</div>;
    case "missing":
      return <div className="callout warn held"><Icon name="warning" /><span>Temperatures, fans, voltages and drive wear need the sensor task.{why}</span>{button("Set it up")}</div>;
    case "stale":
      return <div className="callout bad held"><Icon name="error" /><span>The sensor task stopped sending readings.{why}</span>{button("Set it up again")}</div>;
    default:
      return null;
  }
}
