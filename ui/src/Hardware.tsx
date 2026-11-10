import { useEffect, useState, type CSSProperties } from "react";
import { ago, api, message, type Hardware, type Health, type HwPart, type HwSnapshot } from "./api";
import { Icon } from "./Icon";
import { useMe } from "./me";
import { Callout, Dialog, MoreMenu, useNotify } from "./ui";

const failing = (h: Health) => h === "warn" || h === "bad";
const rank = (h: Health) => ({ bad: 3, warn: 2, ok: 1, empty: 0, unknown: 0 })[h];
const gb = (b: number) => `${Math.round((b / 2 ** 30) * 10) / 10} GB`;
const figure = (value: number, unit: string) =>
  `${Number.isInteger(value) ? value : value.toFixed(unit === "V" ? 2 : 1)}${unit ? (unit === "%" ? "%" : ` ${unit}`) : ""}`;
const temp = (p: HwPart | undefined) => p?.readings.find((r) => r.unit === "°C");
// A part's name without the maker's marks and clock speed.
const short = (name: string) =>
  name.replace(/\((R|TM)\)/g, "").replace(/\s+CPU\s+@.*$/, "").replace(/^(Intel|AMD|NVIDIA)\s+/, "").replace(/^GeForce\s+/, "").replace(/\s+/g, " ").trim();
// ChannelA-DIMM0 as A0, the way boards print it beside the slot.
const slotName = (place: string) => place.match(/Channel([A-Z])-DIMM(\d+)/)?.slice(1).join("") ?? place;

// Photos of each kind of part, from Wikimedia Commons, credited below.
const PHOTO: Record<string, string> = {
  board: "/hardware/board.jpg",
  cpu: "/hardware/cpu.jpg",
  gpu: "/hardware/gpu.webp",
  memory: "/hardware/ram.webp",
  drive: "/hardware/ssd.webp",
  power: "/hardware/psu.webp",
  fan: "/hardware/fan.jpg",
};
const CREDITS: [string, string, string, string][] = [
  ["Board: ASUS ROG Strix Z390-F Gaming", "PantheraLeo1359531", "CC BY 4.0", "https://commons.wikimedia.org/wiki/File:Asus-ROG-Strix-Z390-F-Gaming-Motherboard_20201120_DSC6025.jpg"],
  ["Processor: Intel Core i7-8700", "Jacek Halicki", "CC BY-SA 4.0", "https://commons.wikimedia.org/wiki/File:2023_Intel_Core_i7_8700_%281%29.jpg"],
  ["Graphics: ASUS GeForce RTX 2070 ROG Strix", "Michael Wolf", "CC BY-SA 3.0", "https://commons.wikimedia.org/wiki/File:ASUS_GeForce_RTX_2070_ROG_STRIX_Advanced_-_8GB_GDDR6_1632.jpg"],
  ["Memory: 16 GiB DDR4", "PantheraLeo1359531", "CC BY 4.0", "https://commons.wikimedia.org/wiki/File:16_GiB-DDR4-RAM-Riegel_RAM019FIX_Small_Crop_90_PCNT.png"],
  ["Drive: Samsung 870 QVO", "PantheraLeo1359531", "CC BY 4.0", "https://commons.wikimedia.org/wiki/File:Samsung_870_QVO_8TB_SATA_2%2C5_Zoll_Internes_Solid_State_Drive_%28SSD%29_%28MZ-77Q8T0BW%29_20211008_SSD023_corr.png"],
  ["Power supply: be quiet! Straight Power 12", "PantheraLeo1359531", "CC BY 4.0", "https://commons.wikimedia.org/wiki/File:Be_quiet%21_Straight_Power_12_1200W_20240405_HOF1650-HDR_RAW-Export_000105.png"],
  ["Fan: Corsair 120 mm", "Eric Chan", "CC BY 2.0", "https://commons.wikimedia.org/wiki/File:Corsair_Logo_120mm_desktop_computer_case_fan_%2852504601012%29.jpg"],
];

// Where each part sits on the board photo, as shares of its width and height
// (the photo is 1032 by 1272): the socket, the four memory slots from the
// socket outwards, the first graphics slot and the 24-pin connector.
const pct = (left: number, top: number, width: number, height: number): CSSProperties =>
  ({ left: `${(left / 1032) * 100}%`, top: `${(top / 1272) * 100}%`, width: `${(width / 1032) * 100}%`, height: `${(height / 1272) * 100}%` });
const SOCKET = pct(460, 283, 176, 181);
const SLOTS = [778, 820, 862, 903].map((x) => pct(x, 36, 30, 618));
const CARD = pct(0, 700, 1010, 492);
const POWER = pct(966, 320, 56, 224);

// HardwarePage is this computer as a photo of its board with its own parts in
// place: the processor in its socket, each stick in its slot, the graphics
// card over its slot, each lit in its health; the drives, power supply and
// fans beside it. Picking a part shows its readings. Off until enabled.
export function HardwarePage() {
  const me = useMe();
  const admin = me.admin || me.host;
  const notify = useNotify();
  const [hw, setHw] = useState<Hardware | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState("");
  const [credits, setCredits] = useState(false);

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
        <div className="page-body stack">
          <Helper snap={snap} admin={admin} busy={busy} onSetUp={() => act(api.enableHardware)} />
          {snap.notes.map((n) => (
            <Callout key={n.id} tone={n.health === "bad" ? "bad" : "warn"} icon={n.health === "bad" ? "error" : "warning"}>{n.name}</Callout>
          ))}
          <div className="hw-layout">
            <div className="hw-stage">
              <Rig snap={snap} picked={shown?.id ?? ""} onPick={setPicked} />
              <Attached parts={parts} picked={shown?.id ?? ""} onPick={setPicked} />
            </div>
            <aside className="hw-side">
              {shown && <Details part={shown} total={memory} admin={admin} onForget={(slot) => act(() => api.forgetSlot(slot))} />}
              <div className="hw-side-block">
                <h3>Parts</h3>
                <ul className="hw-parts">
                  {parts.filter((p) => p.health !== "empty").map((p) => {
                    const key = temp(p) ?? p.readings[0];
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
              <button type="button" className="hw-credits-link" onClick={() => setCredits(true)}>Photo credits</button>
            </aside>
          </div>
        </div>
      )}
      {credits && (
        <Dialog title="Photo credits" onClose={() => setCredits(false)}>
          <ul className="hw-credits">
            {CREDITS.map(([what, who, license, link]) => (
              <li key={link}><a href={link} target="_blank" rel="noreferrer">{what}</a><span>{who}, {license}, cropped and cut out</span></li>
            ))}
          </ul>
        </Dialog>
      )}
    </>
  );
}

// Spot is a part on the photo: its own picture where it has one, lit in its
// health, and a label over it.
function Spot({ part, style, photo, tag, picked, onPick, className = "" }: {
  part: HwPart | undefined;
  style: CSSProperties;
  photo?: string;
  tag?: string;
  picked: string;
  onPick: (id: string) => void;
  className?: string;
}) {
  const health = part?.health ?? "empty";
  return (
    <button type="button" className={`hw-spot ${health} ${className}` + (part && picked === part.id ? " picked" : "")} style={style}
      disabled={!part || health === "empty"} aria-label={part ? `${part.name}: ${part.reason || health}` : "Empty"}
      onClick={() => part && onPick(part.id)}>
      {photo && <img src={photo} alt="" draggable={false} />}
      {tag && <span className="hw-tag"><span className={"dot " + (health === "unknown" ? "" : health)} />{tag}</span>}
    </button>
  );
}

// Rig is the board photo with this computer's processor, memory and graphics
// card placed in their slots.
function Rig({ snap, picked, onPick }: { snap: HwSnapshot; picked: string; onPick: (id: string) => void }) {
  const of = (kind: string) => snap.parts.filter((p) => p.kind === kind);
  const cpu = of("cpu")[0];
  const board = of("board")[0];
  const power = of("power")[0];
  const card = of("gpu").find((g) => g.id.startsWith("gpu:nvidia")) ?? of("gpu").find((g) => !/intel/i.test(g.name));
  // This computer's slots in the board's order, from the socket outwards.
  const slots = of("memory").sort((a, b) => a.place.localeCompare(b.place)).slice(0, 4);
  const cpuTemp = temp(cpu);
  const cardTemp = temp(card);
  return (
    <div className={"hw-rig " + (board?.health ?? "")}>
      <img className="hw-rig-board" src={PHOTO.board} alt="" draggable={false} onClick={() => board && onPick(board.id)} />
      <Spot part={cpu} style={SOCKET} photo={PHOTO.cpu} picked={picked} onPick={onPick}
        tag={cpu ? `${short(cpu.name)}${cpuTemp ? ` · ${figure(cpuTemp.value, "°C")}` : ""}` : undefined} />
      {SLOTS.map((style, i) => {
        const p = slots[i];
        const filled = !!p?.bytes;
        return (
          <Spot key={i} part={p} style={style} photo={filled ? "/hardware/ram-slot.webp" : undefined} picked={picked} onPick={onPick}
            className={"hw-slot" + (filled ? "" : " bare")} tag={filled ? gb(p?.bytes ?? 0) : p?.health === "bad" ? "Missing" : undefined} />
        );
      })}
      <Spot part={power} style={POWER} picked={picked} onPick={onPick} className="hw-connector" />
      {card && (
        <Spot part={card} style={CARD} photo={PHOTO.gpu} picked={picked} onPick={onPick} className="hw-gpu"
          tag={`${short(card.name)}${cardTemp ? ` · ${figure(cardTemp.value, "°C")}` : ""}`} />
      )}
    </div>
  );
}

// Attached is what is wired to the board rather than on it: the drives, the
// power supply and the fans, each its own photo.
function Attached({ parts, picked, onPick }: { parts: HwPart[]; picked: string; onPick: (id: string) => void }) {
  const items = parts.filter((p) => p.kind === "drive" || p.kind === "power" || p.kind === "fan");
  if (!items.length) return null;
  return (
    <div className="hw-attached">
      {items.map((p) => {
        const value = temp(p) ?? p.readings[0];
        return (
          <button key={p.id} type="button" className={"hw-item " + p.health + (picked === p.id ? " picked" : "")} onClick={() => onPick(p.id)}>
            <span className="hw-item-photo"><img src={PHOTO[p.kind]} alt="" draggable={false} /></span>
            <span className="hw-item-text">
              <b>{p.kind === "power" ? "Power supply" : short(p.name)}</b>
              <small><span className={"dot " + (p.health === "unknown" ? "" : p.health)} />{value ? figure(value.value, value.unit) : p.health === "ok" ? "Healthy" : "No readings"}</small>
            </span>
          </button>
        );
      })}
    </div>
  );
}

// Details is the picked part: its photo, its state, its readings, and what it is.
function Details({ part, total, admin, onForget }: { part: HwPart; total: number; admin: boolean; onForget: (slot: string) => void }) {
  const photo = part.kind === "gpu" && !part.id.startsWith("gpu:nvidia") ? undefined : PHOTO[part.kind];
  return (
    <div className="hw-side-block hw-details">
      <div className="hw-details-head">
        {photo && <span className={"hw-details-photo " + part.health}><img src={photo} alt="" /></span>}
        <div>
          <b>{part.health === "empty" ? "Empty slot" : part.name}</b>
          <small><span className={"dot " + (part.health === "unknown" ? "" : part.health)} />{part.place || ({ ok: "Healthy", warn: "Needs attention", bad: "Failing", empty: "Empty", unknown: "No readings" })[part.health]}</small>
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
