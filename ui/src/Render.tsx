import type { KeyboardEvent, ReactNode } from "react";
import type { Health, HwPart, HwSnapshot } from "./api";

// Render draws this computer's board from above, every part to the same
// scale in millimetres, from what the server read: the board at the size its
// name gives (ATX 244 by 305, micro-ATX 244 by 244, mini-ITX 170 by 170) with
// the cooler holes 75 mm apart around the socket and the expansion slots
// 20.32 mm apart; the processor in its socket engraved with its name; each
// memory stick edge-on in its slot; the graphics card's top edge over its
// slot at its model's length and thickness; an NVMe drive in the M.2 slot.
// What is cabled to the board shows where it plugs in: each fan at its
// header with its speed, each SATA drive at its port, the power supply at the
// 24-pin and CPU power connectors. Each part glows in its health.

type Form = { w: number; h: number; kind: "atx" | "matx" | "itx" };

const short = (name: string) =>
  name.replace(/\((R|TM)\)/g, "").replace(/\s+CPU\s+@.*$/, "").replace(/^(Intel|AMD|NVIDIA)\s+/, "").replace(/^GeForce\s+/, "").replace(/\s+/g, " ").trim();
const temp = (p: HwPart | undefined) => p?.readings.find((r) => r.unit === "°C");
const fact = (p: HwPart, key: string) => p.facts.find(([k]) => k === key)?.[1] ?? "";
const gbShort = (b: number) => `${Math.round(b / 2 ** 30)} GB`;
const worst = (parts: HwPart[]): Health => (parts.some((p) => p.health === "bad") ? "bad" : parts.some((p) => p.health === "warn") ? "warn" : "ok");

// The board's size from its name: "B360M", "mATX" or "Micro" for micro-ATX,
// "ITX" or "-I" for mini-ITX, ATX otherwise.
function form(name: string): Form {
  if (/itx|\b[A-Z]?\d{3}[A-Z]?-I\b|\bmini\b/i.test(name)) return { w: 170, h: 170, kind: "itx" };
  if (/\b[A-Z]\d{3}M\b|matx|micro|-M\b/i.test(name)) return { w: 244, h: 244, kind: "matx" };
  return { w: 244, h: 305, kind: "atx" };
}

// A graphics card's length and thickness, and its power plugs, from its model.
function card(name: string): { length: number; thick: number; plugs: number } {
  if (/[45]0[89]0|titan/i.test(name)) return { length: 310, thick: 60, plugs: 1 };
  if (/[2-5]0[78]0|7[89]00|6[89]00/i.test(name)) return { length: 280, thick: 40, plugs: 2 };
  if (/[1-4]0[56]0|1[56][56]0|6[45]00|7[56]00/i.test(name)) return { length: 200, thick: 38, plugs: 1 };
  return { length: 240, thick: 40, plugs: 1 };
}

function Pick({ part, picked, onPick, children }: { part: HwPart | undefined; picked: string; onPick: (id: string) => void; children: ReactNode }) {
  if (!part) return <g>{children}</g>;
  const pick = () => onPick(part.id);
  return (
    <g className={`hr-part ${part.health}` + (picked === part.id ? " picked" : "")} role="button" tabIndex={0}
      aria-label={`${part.name}: ${part.reason || part.health}`}
      onClick={pick}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        pick();
      }}>
      {children}
    </g>
  );
}

// The ring a part's health shows in, just outside its outline.
function Ring({ x, y, w, h, r = 1.5, health }: { x: number; y: number; w: number; h: number; r?: number; health: Health | undefined }) {
  if (!health || health === "unknown" || health === "empty") return null;
  return <rect className={"hr-ring " + health} x={x - 0.9} y={y - 0.9} width={w + 1.8} height={h + 1.8} rx={r + 0.9} />;
}

// A small label: a dot in the part's health and its figure.
function Tag({ x, y, text, health, anchor = "middle" }: { x: number; y: number; text: string; health: Health | undefined; anchor?: "start" | "middle" | "end" }) {
  const w = text.length * 1.72 + 7.5;
  const left = anchor === "middle" ? x - w / 2 : anchor === "end" ? x - w : x;
  return (
    <g className="hr-tag">
      <rect x={left} y={y - 3.6} width={w} height={7.2} rx={3.6} />
      <circle className={"hr-tag-dot " + (health ?? "")} cx={left + 3.7} cy={y} r={1.2} />
      <text x={left + 6.2} y={y + 1.15}>{text}</text>
    </g>
  );
}

// The rear connectors down the left edge: where each starts, how tall it is,
// and what it is (u USB, v video, h HDMI, l LAN, a audio).
const REAR: [number, number, string][] = [[10, 14, "u"], [28, 30, "v"], [62, 14, "h"], [80, 18, "l"], [102, 14, "u"], [120, 14, "u"], [140, 26, "a"]];
const REAR_ITX: [number, number, string][] = [[10, 14, "u"], [28, 14, "u"], [46, 16, "v"], [66, 14, "l"], [84, 26, "a"]];

export function Render({ snap, picked, onPick }: { snap: HwSnapshot; picked: string; onPick: (id: string) => void }) {
  const of = (kind: string) => snap.parts.filter((p) => p.kind === kind);
  const board = of("board")[0];
  const cpu = of("cpu")[0];
  const power = of("power")[0];
  const gpu = of("gpu").find((g) => g.id.startsWith("gpu:nvidia")) ?? of("gpu").find((g) => !/intel|uhd|iris|radeon\(tm\) graphics|vega \d graphics/i.test(g.name));
  const memory = of("memory").sort((a, b) => a.place.localeCompare(b.place));
  const drives = of("drive");
  const nvme = drives.find((d) => /nvme/i.test(fact(d, "Kind")));
  const sata = drives.filter((d) => d !== nvme);
  const fans = of("fan");
  const sticks = memory.filter((p) => p.bytes);
  const total = sticks.reduce((n, p) => n + (p.bytes ?? 0), 0);

  const f = form(board?.name ?? "");
  const { w: W, h: H } = f;
  const itx = f.kind === "itx";

  // The socket, with the cooler's four holes 75 mm apart around it.
  const cx = itx ? 72 : 100;
  const cy = itx ? 66 : 78;
  // The memory: up to four slots to the right of the socket, channels apart.
  const count = Math.min(itx ? 2 : 4, Math.max(snap.slots || memory.length, memory.length, 2));
  const slotX = (i: number) => (itx ? 128 : 150) + i * 8.5 + Math.floor(i / 2) * 1.5;
  const dimmTop = itx ? 8 : 12;
  const dimmLen = 144;
  // The expansion slots, 20.32 mm apart from the first below the memory.
  const firstRow = itx ? 159 : 166.5;
  const rows = itx ? [firstRow] : Array.from({ length: f.kind === "atx" ? 7 : 4 }, (_, i) => firstRow + i * 20.32);
  const longRow = (i: number) => i === 0 || (f.kind === "atx" ? i === 2 || i === 4 : i === 2);
  const gpuSize = card(gpu?.name ?? "");
  // The 24-pin power connector by the right edge, and where the SATA ports sit.
  const atx24 = { x: W - 13, y: itx ? 54 : 90 };
  const sataTop = itx ? 120 : H - 38;
  // Fan headers: the processor's above the socket, the rest around the board's edges.
  const headers: [number, number][] = itx
    ? [[cx + 26, 16], [150, 128], [12, 150]]
    : [[cx + 26, 16], [28, 112], [W - 40, H - 5], [200, 5], [W - 70, H - 5], [110, H - 5]];
  const cpuFanFirst = [...fans].sort((a, b) => Number(/cpu/i.test(b.name)) - Number(/cpu/i.test(a.name)));

  const viewW = Math.max(W, gpu ? gpuSize.length - 4 : 0) + 8;
  const viewH = H + (itx && gpu ? 30 : 0) + 8;
  const cpuTemp = temp(cpu);
  const gpuTemp = temp(gpu);
  const model = (cpu?.name ?? "").match(/(i[3579]-\d{4,5}[A-Z]*|Ryzen \d \d{4}[A-Z0-9]*|Core Ultra \d \d{3}[A-Z]*|Xeon[^@]*|Pentium[^@]*|Celeron[^@]*)/i)?.[0]?.trim() ?? short(cpu?.name ?? "");
  const clock = (cpu?.name ?? "").match(/@\s*([\d.]+\s*GHz)/i)?.[1]?.replace(/\s/g, "").toUpperCase() ?? "";
  const amd = /amd|ryzen|epyc|threadripper/i.test(cpu?.name ?? "");
  const family = amd ? "AMD RYZEN™" : /^i[3579]-/i.test(model) ? `INTEL® CORE™ ${model.slice(0, 2).toUpperCase()}` : "INTEL®";

  return (
    <svg className="hr" viewBox={`-4 -4 ${viewW} ${viewH}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="This computer's board and parts, from above">
      <defs>
        <linearGradient id="hr-pcb" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#24272b" />
          <stop offset="1" stopColor="#17191c" />
        </linearGradient>
        <linearGradient id="hr-metal" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#eef0f2" />
          <stop offset=".42" stopColor="#bcc2c9" />
          <stop offset=".58" stopColor="#d7dbe0" />
          <stop offset="1" stopColor="#99a0a8" />
        </linearGradient>
        <linearGradient id="hr-steel" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#c9ced4" />
          <stop offset=".5" stopColor="#8a9198" />
          <stop offset="1" stopColor="#b4bac1" />
        </linearGradient>
        <linearGradient id="hr-slot" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#0a0b0c" />
          <stop offset=".5" stopColor="#1e2023" />
          <stop offset="1" stopColor="#0a0b0c" />
        </linearGradient>
        <linearGradient id="hr-row" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0a0b0c" />
          <stop offset=".5" stopColor="#1e2023" />
          <stop offset="1" stopColor="#0a0b0c" />
        </linearGradient>
        <linearGradient id="hr-shroud" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2c2f34" />
          <stop offset=".12" stopColor="#1b1d20" />
          <stop offset=".88" stopColor="#16181a" />
          <stop offset="1" stopColor="#2a2d31" />
        </linearGradient>
        <linearGradient id="hr-gold" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f1cf73" />
          <stop offset="1" stopColor="#a17b27" />
        </linearGradient>
        <linearGradient id="hr-choke" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5b6067" />
          <stop offset="1" stopColor="#2f3236" />
        </linearGradient>
        <pattern id="hr-fins" width="1.3" height="10" patternUnits="userSpaceOnUse">
          <rect width="1.3" height="10" fill="#202327" />
          <rect width=".45" height="10" fill="#9aa1a9" />
        </pattern>
        <filter id="hr-brushed" x="0" y="0" width="1" height="1">
          <feTurbulence type="fractalNoise" baseFrequency="1.1 0.03" numOctaves="2" seed="3" result="n" />
          <feColorMatrix in="n" type="saturate" values="0" result="g" />
          <feComponentTransfer in="g" result="a"><feFuncA type="linear" slope=".16" /></feComponentTransfer>
          <feComposite in="a" in2="SourceGraphic" operator="in" result="t" />
          <feMerge><feMergeNode in="SourceGraphic" /><feMergeNode in="t" /></feMerge>
        </filter>
        <filter id="hr-grain" x="0" y="0" width="1" height="1">
          <feTurbulence type="fractalNoise" baseFrequency="2.2" numOctaves="2" seed="9" result="n" />
          <feColorMatrix in="n" type="saturate" values="0" result="g" />
          <feComponentTransfer in="g" result="a"><feFuncA type="linear" slope=".07" /></feComponentTransfer>
          <feComposite in="a" in2="SourceGraphic" operator="in" result="t" />
          <feMerge><feMergeNode in="SourceGraphic" /><feMergeNode in="t" /></feMerge>
        </filter>
        <filter id="hr-shadow" x="-10%" y="-10%" width="130%" height="140%">
          <feDropShadow dx=".7" dy="1" stdDeviation=".8" floodColor="#000" floodOpacity=".6" />
        </filter>
        <filter id="hr-lift" x="-10%" y="-20%" width="130%" height="160%">
          <feDropShadow dx="1.6" dy="2.6" stdDeviation="2.2" floodColor="#000" floodOpacity=".55" />
        </filter>
      </defs>

      {/* The board, its grain and a few runs of traces. */}
      <Pick part={board} picked={picked} onPick={onPick}>
        <rect x="0" y="0" width={W} height={H} rx="2.5" fill="url(#hr-pcb)" filter="url(#hr-grain)" className="hr-board" />
        <g className="hr-traces">
          {Array.from({ length: 16 }, (_, i) => (
            <path key={i} d={`M${cx + 24} ${cy - 22 + i * 2.6} L${cx + 36} ${cy - 22 + i * 2.6} L${slotX(0) - 4} ${dimmTop + 30 + i * 4.4}`} />
          ))}
          {Array.from({ length: 10 }, (_, i) => (
            <path key={`p${i}`} d={`M${cx - 10 + i * 2.4} ${cy + 30} L${cx - 10 + i * 2.4} ${firstRow - 8}`} />
          ))}
        </g>
        <Ring x={0} y={0} w={W} h={H} r={2.5} health={board && board.health !== "ok" ? board.health : undefined} />
      </Pick>
      <text className="hr-silk" x={itx ? 40 : 52} y={rows[rows.length - 1] + (itx ? -8 : 13)}>{short(board?.name ?? "").toUpperCase().replace(/\s*\(.*\)$/, "").slice(0, 30)}</text>

      {/* Mounting holes. */}
      {(itx ? [[6.4, 10.2], [163.8, 10.2], [6.4, 165], [163.8, 165]] : f.kind === "matx"
        ? [[6.4, 10.2], [163.8, 10.2], [237.6, 10.2], [6.4, 165.1], [163.8, 165.1], [237.6, 165.1], [6.4, 237.6], [163.8, 237.6], [237.6, 237.6]]
        : [[6.4, 10.2], [163.8, 10.2], [237.6, 10.2], [6.4, 165.1], [163.8, 165.1], [237.6, 165.1], [6.4, 298.6], [163.8, 298.6], [237.6, 298.6]]
      ).map(([hx, hy]) => (
        <g key={`${hx}-${hy}`}>
          <circle cx={hx} cy={hy} r="3.3" fill="url(#hr-gold)" opacity=".8" />
          <circle cx={hx} cy={hy} r="1.7" fill="#08090a" />
        </g>
      ))}

      {/* The rear connectors along the left edge. */}
      <g filter="url(#hr-shadow)">
        {(itx ? REAR_ITX : REAR).map(([py, ph, k]) => (
          <g key={py}>
            <rect x="-1.5" y={py} width={k === "a" ? 13 : 19} height={ph} rx="1" fill={k === "a" ? "#1a1b1e" : "url(#hr-steel)"} />
            {k === "a" && [0, 1, 2].map((j) => <circle key={j} cx="5" cy={py + 4.5 + j * 8.5} r="3.2" fill={["#7ac142", "#3aa0d8", "#e86fa5"][j]} opacity=".85" />)}
            {k === "l" && <rect x="3" y={py + 3} width="10" height={ph - 6} rx=".6" fill="#2a2d31" />}
          </g>
        ))}
      </g>

      {/* The CPU power connector at the top edge. */}
      <Pick part={power} picked={picked} onPick={onPick}>
        <rect x={itx ? 24 : 30} y="2.5" width="18" height="8.6" rx="1" fill="#0e0f11" stroke="#2c2f34" strokeWidth=".35" />
        {Array.from({ length: 8 }, (_, n) => <rect key={n} x={(itx ? 25 : 31) + (n % 4) * 4.2} y={3.4 + Math.floor(n / 4) * 3.9} width="3.4" height="3" rx=".4" fill="#25282c" />)}
        <Ring x={itx ? 24 : 30} y={2.5} w={18} h={8.6} r={1} health={power?.health} />
      </Pick>

      {/* The power stage's chokes around the socket. */}
      {!itx && Array.from({ length: 6 }, (_, i) => (
        <g key={i} filter="url(#hr-shadow)">
          <rect x={cx - 30 + i * 10.5} y="28" width="8" height="8" rx=".8" fill="url(#hr-choke)" />
          <text className="hr-choke" x={cx - 26 + i * 10.5} y="33">R22</text>
        </g>
      ))}
      {!itx && Array.from({ length: 4 }, (_, i) => (
        <g key={`l${i}`} filter="url(#hr-shadow)">
          <rect x="50" y={cy - 22 + i * 11} width="8" height="8" rx=".8" fill="url(#hr-choke)" />
          <text className="hr-choke" x="54" y={cy - 17 + i * 11}>R22</text>
        </g>
      ))}

      {/* The cooler's mounting holes, 75 mm apart. */}
      {[[-37.5, -37.5], [37.5, -37.5], [-37.5, 37.5], [37.5, 37.5]].map(([dx, dy]) => (
        <g key={`${dx}${dy}`}>
          <circle cx={cx + dx} cy={cy + dy} r="2.6" fill="none" stroke="url(#hr-gold)" strokeWidth=".9" />
          <circle cx={cx + dx} cy={cy + dy} r="1.9" fill="#08090a" />
        </g>
      ))}

      {/* The socket's load plate and lever, and the processor in it. */}
      <Pick part={cpu} picked={picked} onPick={onPick}>
        <g filter="url(#hr-shadow)">
          <path d={`M${cx - 23} ${cy - 27} h46 v54 h-46 z M${cx - 17} ${cy - 18} v36 h34 v-36 z`} fill="url(#hr-steel)" fillRule="evenodd" opacity=".72" />
          <circle cx={cx - 20} cy={cy - 24} r="1.3" fill="#6d747c" />
          <circle cx={cx + 20} cy={cy + 24} r="1.3" fill="#6d747c" />
          <path d={`M${cx + 27} ${cy - 28} V${cy + 25} q0 3 -3 3 h-4`} fill="none" stroke="url(#hr-steel)" strokeWidth="1.5" strokeLinecap="round" />
          <rect x={cx - 18.75} y={cy - 18.75} width="37.5" height="37.5" rx="1" fill="#1d4a31" />
          {cpu && (
            <>
              <path d={`M${cx - 15} ${cy - 16.2} h30 l1.4 1.4 v29.6 l-1.4 1.4 h-30 l-1.4 -1.4 v-29.6 z`} fill="url(#hr-metal)" filter="url(#hr-brushed)" />
              <text className="hr-etch" x={cx - 12} y={cy - 8.6}>{family}</text>
              <text className="hr-etch strong" x={cx - 12} y={cy - 3.6}>{model.toUpperCase()}</text>
              {clock && <text className="hr-etch" x={cx - 12} y={cy + 1.6}>{clock}</text>}
            </>
          )}
        </g>
        <Ring x={cx - 18.75} y={cy - 18.75} w={37.5} h={37.5} r={1} health={cpu?.health} />
      </Pick>
      {cpu && <Tag x={cx} y={cy + 33} text={`${model}${cpuTemp ? ` · ${Math.round(cpuTemp.value)}°C` : ""}`} health={cpu.health} />}

      {/* The memory slots; each stick stands edge-on, its chips either side. */}
      {Array.from({ length: count }, (_, i) => {
        const p = memory[i];
        const x = slotX(i);
        const filled = !!p?.bytes;
        return (
          <Pick key={i} part={p && p.health !== "empty" ? p : undefined} picked={picked} onPick={onPick}>
            <rect x={x} y={dimmTop} width="6.6" height={dimmLen} rx=".8" fill="url(#hr-slot)" />
            <rect x={x - .3} y={dimmTop - 1.2} width="7.2" height="5" rx=".8" fill={filled ? "#3a3e44" : "#2b2e33"} />
            <rect x={x - .3} y={dimmTop + dimmLen - 3.8} width="7.2" height="5" rx=".8" fill={filled ? "#3a3e44" : "#2b2e33"} />
            {filled && (
              <g filter="url(#hr-shadow)">
                <rect x={x + 2.6} y={dimmTop + 3.6} width="1.4" height={dimmLen - 7.2} fill="#1f6b3c" />
                {Array.from({ length: 8 }, (_, c) => (
                  <g key={c}>
                    <rect x={x + 1.4} y={dimmTop + 10 + c * 15.6 + (c > 3 ? 8 : 0)} width="1.2" height="10.5" fill="#17191b" />
                    <rect x={x + 4} y={dimmTop + 10 + c * 15.6 + (c > 3 ? 8 : 0)} width="1.2" height="10.5" fill="#17191b" />
                  </g>
                ))}
              </g>
            )}
            <Ring x={x} y={dimmTop} w={6.6} h={dimmLen} r={.8} health={p?.health === "empty" ? undefined : p?.health} />
          </Pick>
        );
      })}

      {/* One label over the memory: how many sticks of what size, and the total. */}
      {sticks.length > 0 && (
        <Tag x={(slotX(0) + slotX(count - 1) + 6.6) / 2} y={dimmTop - 6.2} health={worst(sticks)}
          text={sticks.every((p) => p.bytes === sticks[0].bytes) && sticks.length > 1 ? `${sticks.length} × ${gbShort(sticks[0].bytes ?? 0)} · ${gbShort(total)}` : gbShort(total)} />
      )}

      {/* The 24-pin power connector. */}
      <Pick part={power} picked={picked} onPick={onPick}>
        <rect x={atx24.x} y={atx24.y} width="9.4" height="53" rx="1" fill="#0e0f11" stroke="#2c2f34" strokeWidth=".35" />
        {Array.from({ length: 24 }, (_, n) => (
          <rect key={n} x={atx24.x + .8 + (n % 2) * 4.2} y={atx24.y + 1 + Math.floor(n / 2) * 4.2} width="3.4" height="3.3" rx=".4" fill="#25282c" />
        ))}
        <Ring x={atx24.x} y={atx24.y} w={9.4} h={53} r={1} health={power?.health} />
      </Pick>

      {/* The M.2 slot, with its drive when it holds one. */}
      {!itx && (
        <g>
          <rect x="52" y={cy + 50} width="5" height="22" rx=".6" fill="#0d0e10" />
          <circle cx="135" cy={cy + 61} r="1.5" fill="url(#hr-gold)" />
        </g>
      )}
      {nvme && !itx && (
        <Pick part={nvme} picked={picked} onPick={onPick}>
          <g filter="url(#hr-shadow)">
            <rect x="55" y={cy + 50} width="80" height="22" rx=".8" fill="#0f2418" />
            <rect x="60" y={cy + 53} width="17" height="16" rx=".5" fill="#121315" />
            <rect x="82" y={cy + 53} width="14" height="16" rx=".5" fill="#121315" />
            <rect x="100" y={cy + 52} width="30" height="18" rx=".5" fill="#eceef0" />
            <text className="hr-sticker" x="115" y={cy + 62}>NVMe {fact(nvme, "Size")}</text>
          </g>
          <Ring x={55} y={cy + 50} w={80} h={22} r={.8} health={nvme.health} />
        </Pick>
      )}

      {/* The expansion slots; the long ones in steel. */}
      {rows.map((ry, i) => (
        <g key={i}>
          <rect x="38" y={ry - 3.4} width={longRow(i) ? 89 : 25} height="6.8" rx=".7" fill="url(#hr-row)" stroke={longRow(i) ? "url(#hr-steel)" : "none"} strokeWidth=".9" />
          <rect x={longRow(i) ? 128 : 64} y={ry - 2.8} width="3.6" height="5.6" rx=".5" fill="#2f3237" />
        </g>
      ))}

      {/* The chipset under its heatsink, the clock battery, the audio codec. */}
      {!itx && (
        <g filter="url(#hr-shadow)">
          <rect x={W - 74} y={H - 68} width="30" height="30" rx="1.5" fill="url(#hr-steel)" filter="url(#hr-brushed)" />
        </g>
      )}
      <circle cx={itx ? 120 : 146} cy={itx ? 150 : H - 30} r="10" fill="url(#hr-metal)" filter="url(#hr-brushed)" />
      <rect x="14" y={H - (itx ? 28 : 46)} width="8" height="8" rx=".6" fill="#121315" stroke="#2c2f34" strokeWidth=".3" />
      {Array.from({ length: 4 }, (_, i) => <circle key={i} cx={13 + (i % 2) * 5} cy={H - (itx ? 16 : 32) + Math.floor(i / 2) * 5} r="1.8" fill="url(#hr-gold)" />)}

      {/* SATA ports, each lit by the drive on it. */}
      {Array.from({ length: itx ? 2 : 6 }, (_, i) => {
        const px = W - 15;
        const py = sataTop + i * 5.6;
        const d = sata[i];
        return (
          <Pick key={i} part={d} picked={picked} onPick={onPick}>
            <rect x={px} y={py} width="12" height="4.6" rx=".6" fill="#111214" stroke="#30343a" strokeWidth=".3" />
            <rect x={px + 1} y={py + 1.2} width="7" height="2.2" rx=".3" fill={d ? "#2f6fdb" : "#26292d"} />
            {d && <Ring x={px} y={py} w={12} h={4.6} r={.6} health={d.health} />}
          </Pick>
        );
      })}
      {sata.slice(0, itx ? 2 : 6).map((d, i) => {
        const t = temp(d);
        return <Tag key={d.id} x={W - 18} y={sataTop + i * 5.6 + 2.3} anchor="end" text={`${short(d.name).slice(0, 16)}${t ? ` · ${Math.round(t.value)}°C` : ""}`} health={d.health} />;
      })}

      {/* Fan headers, each lit by its fan, its speed beside it. */}
      {headers.map(([hx, hy], i) => {
        const fan = cpuFanFirst[i];
        const rpm = fan?.readings[0]?.value;
        const left = hx > W - 30;
        const below = hy < 30;
        return (
          <Pick key={i} part={fan} picked={picked} onPick={onPick}>
            <rect x={hx} y={hy - 1.4} width="10.4" height="2.8" rx=".4" fill="#f2f3f5" />
            {Array.from({ length: 4 }, (_, n) => <rect key={n} x={hx + 1 + n * 2.54} y={hy - .5} width=".9" height=".9" fill="#c5a14a" />)}
            {fan && <Ring x={hx} y={hy - 1.4} w={10.4} h={2.8} r={.4} health={fan.health} />}
            {fan && rpm !== undefined && (
              <Tag x={left ? hx - 2 : hx + 5.2} y={below ? hy + 7 : hy - 6} anchor={left ? "end" : "middle"} text={`${/cpu/i.test(fan.name) ? "CPU fan" : fan.name.replace(/^System /, "")} ${Math.round(rpm)} rpm`} health={fan.health} />
            )}
          </Pick>
        );
      })}

      {/* The graphics card, standing in its slot: its backplate and board edge,
          its power plugs, the cooler's fins, and its name. */}
      {gpu && (
        <Pick part={gpu} picked={picked} onPick={onPick}>
          <g filter="url(#hr-lift)">
            <rect x="-3" y={rows[0] - 4} width="2.4" height={gpuSize.thick + 3} fill="url(#hr-steel)" />
            <rect x="-.6" y={rows[0] - 2.6} width={gpuSize.length} height={gpuSize.thick} rx="2.5" fill="url(#hr-shroud)" />
            <rect x="-.6" y={rows[0] - 2.6} width={gpuSize.length} height="1.6" fill="#7f868e" />
            <rect x="-.6" y={rows[0] - 1} width={gpuSize.length} height="1.4" fill="#1b5c36" />
            {Array.from({ length: gpuSize.plugs }, (_, k) => (
              <rect key={k} x={gpuSize.length - 32 + k * 13} y={rows[0] - 2.4} width="11" height="4.4" rx=".6" fill="#0e0f11" stroke="#3a3e44" strokeWidth=".3" />
            ))}
            <rect x="8" y={rows[0] + gpuSize.thick * 0.36} width={gpuSize.length - 18} height={gpuSize.thick * 0.42} rx="1.2" fill="url(#hr-fins)" />
            <text className="hr-gpu" x={gpuSize.length * 0.5} y={rows[0] + gpuSize.thick * 0.24}>{/radeon|rx\s?\d/i.test(gpu.name) ? "RADEON" : "GEFORCE"} {short(gpu.name).replace(/^GeForce\s+/i, "").toUpperCase()}</text>
          </g>
          <Ring x={-.6} y={rows[0] - 2.6} w={gpuSize.length} h={gpuSize.thick} r={2.5} health={gpu.health} />
          {gpuTemp && <Tag x={gpuSize.length - 6} y={rows[0] + gpuSize.thick - 6.5} anchor="end" text={`${Math.round(gpuTemp.value)}°C`} health={gpu.health} />}
        </Pick>
      )}
    </svg>
  );
}
