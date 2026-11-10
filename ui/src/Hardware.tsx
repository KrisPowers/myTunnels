import { useEffect, useState } from "react";
import { ago, api, message, type Hardware, type Health, type HwPart, type HwSnapshot } from "./api";
import { Icon } from "./Icon";
import { useMe } from "./me";
import { Gallery } from "./Gallery";
import { Callout, MoreMenu, useNotify } from "./ui";

const failing = (h: Health) => h === "warn" || h === "bad";
const rank = (h: Health) => ({ bad: 3, warn: 2, ok: 1, empty: 0, unknown: 0 })[h];
const gb = (b: number) => `${Math.round((b / 2 ** 30) * 10) / 10} GB`;
const figure = (value: number, unit: string) =>
  `${Number.isInteger(value) ? value : value.toFixed(unit === "V" ? 2 : 1)}${unit ? (unit === "%" ? "%" : ` ${unit}`) : ""}`;
const STATE: Record<Health, string> = { ok: "Healthy", warn: "Needs attention", bad: "Failing", empty: "Empty", unknown: "No readings" };

// HardwarePage is every part of this computer as its own render, packed into
// rows that fill the space, each in its health; the picked part's readings
// beside them, with every part and the 30-day log. Off until the host or an admin enables it.
export function HardwarePage() {
  const me = useMe();
  const admin = me.admin || me.host;
  const notify = useNotify();
  const [hw, setHw] = useState<Hardware | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState("");

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
  const parts = snap?.parts ?? [];
  const problems = snap ? [...snap.parts, ...snap.notes].filter((p) => failing(p.health)).length : 0;
  const worst = [...parts].sort((a, b) => rank(b.health) - rank(a.health))[0];
  const shown = parts.find((p) => p.id === picked) ?? (worst && failing(worst.health) ? worst : parts.find((p) => p.kind === "cpu") ?? parts[0]);
  const memory = parts.reduce((n, p) => n + (p.kind === "memory" ? p.bytes ?? 0 : 0), 0);

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
        // The render and its panel fill the window, so nothing needs scrolling to.
        <div className="page-body hw-layout">
            <Gallery snap={snap} picked={shown?.id ?? ""} onPick={setPicked} />
            <aside className="hw-side">
              <Helper snap={snap} admin={admin} busy={busy} onSetUp={() => act(api.enableHardware)} />
              {snap.notes.map((n) => (
                <Callout key={n.id} tone={n.health === "bad" ? "bad" : "warn"} icon={n.health === "bad" ? "error" : "warning"}>{n.name}</Callout>
              ))}
              {shown && <Details part={shown} total={memory} admin={admin} onForget={(slot) => act(() => api.forgetSlot(slot))} />}
              <div className="hw-side-block">
                <h3>Parts</h3>
                <ul className="hw-parts">
                  {parts.filter((p) => p.health !== "empty").map((p) => {
                    const key = p.readings.find((r) => r.unit === "°C") ?? p.readings[0];
                    return (
                      <li key={p.id}>
                        <button type="button" className={p.id === shown?.id ? "on" : ""} onClick={() => setPicked(p.id)}>
                          <span className={"dot " + (p.health === "unknown" ? "" : p.health)} />
                          <span className="hw-parts-name">{p.kind === "memory" && p.place ? `${p.place} · ` : ""}{p.name}</span>
                          {key && <span className={"hw-parts-value " + key.health}>{figure(key.value, key.unit)}</span>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
              {snap.events.length > 0 && (
                <div className="hw-side-block">
                  <h3>Last 30 days</h3>
                  <ul className="hw-events">
                    {snap.events.slice(0, 4).map((e, i) => (
                      <li key={i}>
                        <span className={"dot " + e.health} />
                        <span className="hw-event-text" title={e.text}>{e.text}</span>
                        <time>{new Date(e.at * 1000).toLocaleDateString([], { month: "short", day: "numeric" })}</time>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </aside>
        </div>
      )}
    </>
  );
}

// Details is the picked part: its state, its readings, and what it is.
function Details({ part, total, admin, onForget }: { part: HwPart; total: number; admin: boolean; onForget: (slot: string) => void }) {
  return (
    <div className="hw-side-block hw-details">
      <div className="hw-details-head">
        <b>{part.health === "empty" ? "Empty slot" : part.name}</b>
        <small><span className={"dot " + (part.health === "unknown" ? "" : part.health)} />{part.place ? `${part.place} · ` : ""}{STATE[part.health]}</small>
      </div>
      {part.reason && <p className={"hw-reason " + part.health}>{part.reason}</p>}
      {part.readings.length > 0 && (
        <div className="hw-metrics">
          {part.readings.map((r) => (
            <div key={r.label} className={"hw-metric " + r.health}>
              <b>{figure(r.value, r.unit)}</b>
              <span>{r.label}</span>
            </div>
          ))}
        </div>
      )}
      {(part.facts.length > 0 || !!part.bytes) && (
        <dl className="hw-facts">
          {!!part.bytes && total > 0 && <div className="fact"><dt>Share</dt><dd>{gb(part.bytes)} of {gb(total)}, {Math.round((part.bytes / total) * 100)}%</dd></div>}
          {part.facts.map(([k, v]) => <div key={k} className="fact"><dt>{k}</dt><dd>{v}</dd></div>)}
        </dl>
      )}
      {part.kind === "memory" && !part.bytes && part.health === "bad" && admin && (
        <button type="button" className="btn small" onClick={() => onForget(part.place)}>Taken out on purpose</button>
      )}
    </div>
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
