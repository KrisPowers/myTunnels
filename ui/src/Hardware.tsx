import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { ago, api, message, type Hardware, type Health, type HwPart, type HwSnapshot } from "./api";
import { Icon } from "./Icon";
import { useMe } from "./me";
import { Callout, MoreMenu, useNotify } from "./ui";

const failing = (h: Health) => h === "warn" || h === "bad";
const rank = (h: Health) => ({ bad: 3, warn: 2, ok: 1, empty: 0, unknown: 0 })[h];
const gb = (b: number) => `${Math.round((b / 2 ** 30) * 10) / 10} GB`;
const figure = (value: number, unit: string) =>
  `${Number.isInteger(value) ? value : value.toFixed(unit === "V" ? 2 : 1)}${unit ? (unit === "%" ? "%" : ` ${unit}`) : ""}`;
const reading = (p: HwPart | undefined, label: string) => p?.readings.find((r) => r.label === label);
// A part's name as it fits on the drawing.
const short = (name: string) =>
  name.replace(/\((R|TM)\)/g, "").replace(/\s+CPU\s+@.*$/, "").replace(/^(Intel|AMD|NVIDIA)\s+/, "").replace(/^GeForce\s+/, "").replace(/\s+/g, " ").trim();
// ChannelA-DIMM0 as A0, the way boards print it beside the slot.
const slotName = (place: string) => place.match(/Channel([A-Z])-DIMM(\d+)/)?.slice(1).join("") ?? place.slice(0, 4);

// HardwarePage is this computer drawn as its board: the processor, memory,
// graphics card, chipset and power connector on it, the drives, fans and power
// supply wired to it, each outlined in its health. Picking a part shows its
// readings beside the drawing. Off until the host or an admin enables it.
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
  // The part shown beside the drawing: the one picked, else the worst, else the processor.
  const worst = [...parts].sort((a, b) => rank(b.health) - rank(a.health))[0];
  const shown = parts.find((p) => p.id === picked) ?? (worst && failing(worst.health) ? worst : parts.find((p) => p.kind === "cpu") ?? parts[0]);

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
          <div className="hw-layout">
            <div className="hw-stage"><Board snap={snap} picked={shown?.id ?? ""} onPick={setPicked} /></div>
            <aside className="hw-side">
              {shown && <Details part={shown} total={parts.reduce((n, p) => n + (p.kind === "memory" ? p.bytes ?? 0 : 0), 0)} admin={admin} onForget={(slot) => act(() => api.forgetSlot(slot))} />}
              <div className="hw-side-block">
                <h3>Parts</h3>
                <ul className="hw-parts">
                  {parts.filter((p) => p.health !== "empty").map((p) => {
                    const key = p.readings.find((r) => r.unit === "°C") ?? p.readings[0];
                    return (
                      <li key={p.id}>
                        <button type="button" className={p.id === shown?.id ? "on" : ""} onClick={() => setPicked(p.id)}>
                          <span className={"dot " + (p.health === "unknown" ? "" : p.health)} />
                          <span className="hw-parts-name">{p.kind === "memory" && p.place ? `${slotName(p.place)} · ` : ""}{short(p.name)}</span>
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
                    {snap.events.map((e, i) => (
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
        </div>
      )}
    </>
  );
}

// Hit is a part on the drawing that can be picked, by pointer or keyboard.
function Hit({ part, picked, onPick, children }: { part: HwPart | undefined; picked: string; onPick: (id: string) => void; children: ReactNode }) {
  if (!part) return <g className="hw-off">{children}</g>;
  const pick = () => onPick(part.id);
  return (
    <g className={"hw-hit " + part.health + (picked === part.id ? " picked" : "")} role="button" tabIndex={0} aria-label={`${part.name}: ${part.reason || part.health}`}
      onClick={pick} onKeyDown={(e: KeyboardEvent) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        pick();
      }}>
      {children}
    </g>
  );
}

// Board draws the board and what is on it and wired to it, on a 760 by 560 grid.
function Board({ snap, picked, onPick }: { snap: HwSnapshot; picked: string; onPick: (id: string) => void }) {
  const of = (kind: string) => snap.parts.filter((p) => p.kind === kind);
  const cpu = of("cpu")[0];
  const board = of("board")[0];
  const power = of("power")[0];
  const gpus = of("gpu");
  const card = gpus.find((g) => g.id.startsWith("gpu:nvidia")) ?? gpus.find((g) => !/intel/i.test(g.name));
  const slots = of("memory").filter((p) => p.place || p.health !== "empty").sort((a, b) => a.place.localeCompare(b.place));
  const drives = of("drive").slice(0, 4);
  const fans = of("fan").slice(0, 6);
  const temp = (p: HwPart | undefined) => reading(p, "Temperature");
  const boardTemp = board?.readings.reduce<number | null>((m, r) => (r.unit === "°C" ? Math.max(m ?? 0, r.value) : m), null);
  const rails = power?.readings.filter((r) => r.unit === "V") ?? [];

  return (
    <svg className="hw-board" viewBox="0 0 760 560" role="img" aria-label="This computer's board and parts">
      {/* The board itself, with its mounting holes and name. */}
      <rect className="hw-pcb" x="24" y="24" width="500" height="512" rx="14" />
      {[[48, 48], [500, 48], [48, 512], [500, 512], [48, 290], [500, 290]].map(([x, y]) => <circle key={`${x}-${y}`} className="hw-hole" cx={x} cy={y} r="6" />)}
      <text className="hw-silk" x="44" y="526">{short(board?.name ?? "")}</text>

      {/* The processor in its socket. */}
      <Hit part={cpu} picked={picked} onPick={onPick}>
        <rect className="hw-comp" x="110" y="84" width="160" height="160" rx="10" />
        <rect className="hw-die" x="145" y="119" width="90" height="90" rx="6" />
        <text className="hw-label" x="190" y="108" textAnchor="middle">CPU</text>
        <text className="hw-value" x="190" y="170" textAnchor="middle">{temp(cpu) ? figure(temp(cpu)!.value, "°C") : "—"}</text>
        <text className="hw-small" x="190" y="232" textAnchor="middle">{short(cpu?.name ?? "").slice(0, 22)}</text>
      </Hit>

      {/* The memory slots, each stick in its own, empty ones bare. */}
      {slots.map((p, i) => {
        const x = 318 + i * 36;
        const filled = !!p.bytes;
        return (
          <Hit key={p.id} part={p.health === "empty" ? undefined : p} picked={picked} onPick={onPick}>
            <rect className="hw-dimm-slot" x={x} y="64" width="22" height="268" rx="3" />
            {filled && (
              <>
                <rect className="hw-comp hw-stick" x={x + 2} y="72" width="18" height="252" rx="2" />
                {Array.from({ length: 8 }, (_, c) => <rect key={c} className="hw-chip" x={x + 6} y={84 + c * 29} width="10" height="20" rx="1.5" />)}
                <text className="hw-stick-size" transform={`rotate(-90 ${x + 11} 198)`} x={x + 11} y="202" textAnchor="middle">{gb(p.bytes!)}</text>
              </>
            )}
            {!filled && p.health === "bad" && <rect className="hw-comp" x={x + 2} y="72" width="18" height="252" rx="2" strokeDasharray="5 4" />}
            <text className="hw-small" x={x + 11} y="350" textAnchor="middle">{slotName(p.place)}</text>
          </Hit>
        );
      })}

      {/* The 24-pin power connector, wired to the power supply. */}
      <path className="hw-wire" d="M502 170 C 536 170, 532 470, 560 470" />
      <Hit part={power} picked={picked} onPick={onPick}>
        <rect className="hw-comp" x="474" y="110" width="28" height="122" rx="4" />
        {Array.from({ length: 24 }, (_, n) => <rect key={n} className="hw-pin" x={478 + (n % 2) * 11} y={115 + Math.floor(n / 2) * 9.6} width="8" height="6.5" rx="1" />)}
      </Hit>

      {/* The graphics card over its slot, or the bare slot without one. */}
      <rect className="hw-pcie" x="60" y="402" width="300" height="12" rx="3" />
      <Hit part={card} picked={picked} onPick={onPick}>
        {card ? (
          <>
            <rect className="hw-comp" x="44" y="362" width="380" height="96" rx="10" />
            {[150, 300].map((cx) => (
              <g key={cx}>
                <circle className="hw-fan-ring" cx={cx} cy="410" r="34" />
                <circle className="hw-fan-hub" cx={cx} cy="410" r="9" />
              </g>
            ))}
            <text className="hw-label" x="62" y="382">GPU</text>
            <text className="hw-value" x="225" y="418" textAnchor="middle">{temp(card) ? figure(temp(card)!.value, "°C") : ""}</text>
            <text className="hw-small" x="408" y="446" textAnchor="end">{short(card.name).slice(0, 26)}</text>
          </>
        ) : <text className="hw-small" x="64" y="396">No graphics card</text>}
      </Hit>

      {/* The chipset, which carries the board's own temperature. */}
      <Hit part={board} picked={picked} onPick={onPick}>
        <rect className="hw-comp" x="430" y="436" width="64" height="64" rx="8" />
        <text className="hw-small" x="462" y="460" textAnchor="middle">Board</text>
        <text className="hw-value small" x="462" y="484" textAnchor="middle">{boardTemp !== null && boardTemp !== undefined ? figure(boardTemp, "°C") : "—"}</text>
      </Hit>

      {/* SATA ports along the board's edge, each wired to its drive. */}
      {drives.map((d, i) => {
        const y = 272 + i * 18;
        const top = 40 + i * 66;
        return (
          <g key={d.id}>
            <rect className="hw-port" x="504" y={y} width="16" height="11" rx="2" />
            <path className="hw-wire" d={`M520 ${y + 5} C 540 ${y + 5}, 540 ${top + 27}, 560 ${top + 27}`} />
            <Hit part={d} picked={picked} onPick={onPick}>
              <rect className="hw-comp" x="560" y={top} width="180" height="54" rx="8" />
              <text className="hw-label" x="574" y={top + 22}>{d.name.slice(0, 20)}</text>
              <text className="hw-small" x="574" y={top + 41}>{[d.facts.find(([k]) => k === "Size")?.[1], temp(d) && figure(temp(d)!.value, "°C")].filter(Boolean).join(" · ")}</text>
            </Hit>
          </g>
        );
      })}

      {/* The fans, each with its speed. */}
      {fans.map((f, i) => {
        const cx = 580 + (i % 3) * 60;
        const cy = 316 + Math.floor(i / 3) * 70;
        const rpm = f.readings[0]?.value ?? 0;
        return (
          <Hit key={f.id} part={f} picked={picked} onPick={onPick}>
            <circle className="hw-comp" cx={cx} cy={cy} r="22" />
            <circle className="hw-fan-hub" cx={cx} cy={cy} r="6" />
            <text className="hw-small" x={cx} y={cy + 38} textAnchor="middle">{Math.round(rpm)} RPM</text>
          </Hit>
        );
      })}

      {/* The power supply, with its rails. */}
      <Hit part={power} picked={picked} onPick={onPick}>
        <rect className="hw-comp" x="560" y="444" width="180" height="92" rx="10" />
        <text className="hw-label" x="574" y="468">Power supply</text>
        <text className="hw-small" x="574" y="490">{rails.length ? rails.slice(0, 3).map((r) => `${r.label} ${figure(r.value, "V")}`).join("  ") : "No rails reported"}</text>
      </Hit>
    </svg>
  );
}

// Details is the picked part: its state, its readings, and what it is.
function Details({ part, total, admin, onForget }: { part: HwPart; total: number; admin: boolean; onForget: (slot: string) => void }) {
  return (
    <div className="hw-side-block hw-details">
      <div className="hw-details-head">
        <span className={"dot " + (part.health === "unknown" ? "" : part.health)} />
        <div>
          <b>{part.health === "empty" ? "Empty slot" : part.name}</b>
          {part.place && <small>{part.place}</small>}
        </div>
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
  const button = (label: string) => admin && <button type="button" className="btn small" disabled={busy} onClick={onSetUp}>{label}</button>;
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
      return <div className="callout warn held"><Icon name="warning" /><span>Temperatures, fans, voltages and drive wear need the sensor task.{why}</span>{button("Set it up")}</div>;
    case "stale":
      return <div className="callout bad held"><Icon name="error" /><span>The sensor task stopped sending readings; Windows starts it again within a minute.{why}</span></div>;
    default:
      return null;
  }
}
