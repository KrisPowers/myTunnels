import { useEffect, useState } from "react";
import { ago, api, message, type Hardware, type HwPart, type HwSnapshot } from "./api";
import { Icon, type IconName } from "./Icon";
import { useMe } from "./me";
import { Callout, MoreMenu, useNotify } from "./ui";

// The kinds of part, in the order the page shows them.
const KINDS: [string, string, IconName][] = [
  ["cpu", "Processor", "memory"],
  ["gpu", "Graphics", "monitor"],
  ["drive", "Drives", "hard_drive"],
  ["fan", "Fans", "mode_fan"],
  ["power", "Power", "bolt"],
  ["board", "Board", "developer_board"],
];

// HardwarePage is every part of this computer, green when healthy and red when
// failing, read again every few seconds. Off until the host or an admin turns
// it on, which on Windows asks for administrator rights once.
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
  const snap = hw.snapshot;
  const problems = snap ? [...snap.parts, ...snap.notes].filter((p) => p.health === "warn" || p.health === "bad").length : 0;

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Hardware</h1>
          {hw.enabled && snap && (
            <div className="page-sub">
              <span><span className={"dot " + (problems ? "bad" : "ok")} /> {problems ? `${problems} need${problems === 1 ? "s" : ""} attention` : "All healthy"}</span>
              <span>Read {ago(snap.at)}</span>
            </div>
          )}
        </div>
        {hw.enabled && admin && (
          <div className="page-actions">
            <MoreMenu label="More" actions={[{
              label: "Turn off", icon: "power_settings_new", danger: true,
              confirm: hw.platform === "windows" ? "Turn off and remove the sensor task" : "Turn off",
              onClick: () => act(api.disableHardware),
            }]} />
          </div>
        )}
      </div>
      {!hw.enabled ? <TurnOn hw={hw} admin={admin} busy={busy} onTurnOn={() => act(api.enableHardware)} /> : !snap ? (
        <div className="empty"><span className="spinner small" /></div>
      ) : (
        <div className="page-body stack">
          <Helper snap={snap} admin={admin} busy={busy} onRetry={() => act(api.enableHardware)} />
          {snap.notes.map((n) => (
            <Callout key={n.id} tone={n.health === "bad" ? "bad" : "warn"} icon={n.health === "bad" ? "error" : "warning"}>{n.name}</Callout>
          ))}
          <Memory snap={snap} admin={admin} onForget={(slot) => act(() => api.forgetSlot(slot))} />
          {KINDS.map(([kind, title, icon]) => {
            const parts = snap.parts.filter((p) => p.kind === kind);
            return parts.length > 0 && (
              <section key={kind} className="card">
                <div className="card-head"><div className="card-titles"><h2><Icon name={icon} size={20} />{title}</h2></div></div>
                <ul className="hw-list">{parts.map((p) => <Row key={p.id} part={p} />)}</ul>
              </section>
            );
          })}
          {snap.events.length > 0 && (
            <section className="card">
              <div className="card-head"><div className="card-titles"><h2><Icon name="history" size={20} />Last 30 days</h2></div></div>
              <ul className="hw-list">
                {snap.events.map((e, i) => (
                  <li key={i} className="hw-row">
                    <span className={"dot " + e.health} />
                    <span className="hw-name"><span>{e.text}</span></span>
                    <span className="hw-when">{new Date(e.at * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </>
  );
}

// TurnOn says what turning the page on does, before anything is asked for.
function TurnOn({ hw, admin, busy, onTurnOn }: { hw: Hardware; admin: boolean; busy: boolean; onTurnOn: () => void }) {
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
          <p>Temperatures, fan speeds, voltages and drive wear need administrator rights. Turning this on asks Windows once, on this computer's screen, and then:</p>
          <ul className="bullets">
            <li>installs the <b>PawnIO</b> driver, which reads the board's sensor chips</li>
            <li>puts <b>LibreHardwareMonitor</b>'s sensor library in <code>Program Files\myTunnels\hardware</code></li>
            <li>adds a task that reads the sensors every few seconds as SYSTEM, from startup</li>
          </ul>
          <p>Turning it off removes the task and those files. PawnIO stays installed, under Installed apps.</p>
        </>
      )}
      <p>When a part starts failing or recovers, the host and admins get an email once SMTP is set up under Security, Two-Factor Auth.</p>
      {admin ? (
        <button type="button" className="btn primary" disabled={busy} onClick={onTurnOn}>
          {busy ? <span className="spinner on-accent" /> : <Icon name="power_settings_new" size={18} />}Turn on
        </button>
      ) : <p className="muted">The host or an admin can turn this on.</p>}
    </div>
  );
}

// Helper is how Windows' sensor task is doing, when it is not simply running.
function Helper({ snap, admin, busy, onRetry }: { snap: HwSnapshot; admin: boolean; busy: boolean; onRetry: () => void }) {
  const retry = admin && <button type="button" className="btn small" disabled={busy} onClick={onRetry}>Set it up</button>;
  if (snap.helper === "waiting") {
    return <Callout icon="lock">Approve the Windows prompt on this computer's screen to finish setting up the sensor task.</Callout>;
  }
  if (snap.helper === "missing") {
    return (
      <div className="callout warn held">
        <Icon name="warning" />
        <span>Temperatures, fans, voltages and drive wear need the sensor task.{snap.helper_error && ` Last try: ${snap.helper_error}`}</span>
        {retry}
      </div>
    );
  }
  if (snap.helper === "stale") {
    return (
      <div className="callout bad held">
        <Icon name="error" />
        <span>The sensor task stopped sending readings.{snap.helper_error && ` ${snap.helper_error}`}</span>
        {retry}
      </div>
    );
  }
  return null;
}

// Memory is the board's slots: each stick, its size and share of the total,
// and its health; a slot that lost its stick in red; empty slots dashed.
function Memory({ snap, admin, onForget }: { snap: HwSnapshot; admin: boolean; onForget: (slot: string) => void }) {
  const slots = snap.parts.filter((p) => p.kind === "memory");
  if (!slots.length) return null;
  const sticks = slots.filter((p) => p.bytes);
  const total = sticks.reduce((n, p) => n + (p.bytes ?? 0), 0);
  const gb = (b: number) => `${Math.round((b / 2 ** 30) * 10) / 10} GB`;
  const sub = [
    snap.slots ? `${sticks.length} of ${snap.slots} slots in use` : "",
    total ? `${gb(total)} in all` : "",
    snap.ecc ? "ECC" : snap.platform === "windows" ? "Non-ECC: a stick that drops out or slows down turns red" : "",
  ].filter(Boolean).join(" · ");
  return (
    <section className="card">
      <div className="card-head"><div className="card-titles"><h2><Icon name="memory" size={20} />Memory</h2>{sub && <p>{sub}</p>}</div></div>
      <div className="hw-slots">
        {slots.map((p) => (
          <div key={p.id} className={"hw-slot " + p.health} title={p.facts.map(([k, v]) => `${k}: ${v}`).join("\n") || undefined}>
            <span className="hw-slot-place">{p.place || "Slot"}</span>
            {p.health === "empty" ? <b className="hw-slot-empty">Empty</b> : (
              <>
                <b>{p.bytes ? gb(p.bytes) : "Missing"}</b>
                <small>{p.bytes ? p.name.replace(/^[\d.]+ [GM]B ?/, "") : p.name}</small>
                {p.bytes && total > 0 && <small>{Math.round((p.bytes / total) * 100)}% of memory</small>}
                <span className="hw-slot-state"><span className={"dot " + p.health} />{p.reason}</span>
                {p.readings.map((r) => <small key={r.label} className={r.health}>{r.label}: {r.value}</small>)}
                {!p.bytes && admin && <button type="button" className="btn small" onClick={() => onForget(p.place)}>Taken out on purpose</button>}
              </>
            )}
          </div>
        ))}
      </div>
      {sticks.length > 1 && (
        <div className="hw-share" aria-hidden>
          {sticks.map((p) => <span key={p.id} className={p.health} style={{ flex: p.bytes }} title={`${p.place}: ${gb(p.bytes ?? 0)}`} />)}
        </div>
      )}
    </section>
  );
}

function Row({ part }: { part: HwPart }) {
  const facts = part.facts.map(([k, v]) => `${k} ${v}`).join(" · ");
  return (
    <li className="hw-row">
      <span className={"dot " + (part.health === "unknown" ? "" : part.health)} />
      <span className="hw-name">
        <b>{part.name}{part.place && <span className="hw-place">{part.place}</span>}</b>
        {part.reason && <small className={part.health}>{part.reason}</small>}
        {facts && <small>{facts}</small>}
      </span>
      <span className="hw-readings">
        {part.readings.map((r) => (
          <span key={r.label} className={"hw-reading " + r.health}>{r.label}<b>{Number.isInteger(r.value) ? r.value : r.value.toFixed(r.unit === "V" ? 2 : 1)}{r.unit && ` ${r.unit}`}</b></span>
        ))}
      </span>
    </li>
  );
}
