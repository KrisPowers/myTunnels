import type { KeyboardEvent, ReactNode } from "react";
import type { Health, HwPart, HwSnapshot } from "./api";

// Render draws this computer from above, to scale in millimetres, from what
// the server read: a board of the form its name gives (ATX, micro-ATX or
// mini-ITX), as many memory slots as it has with each stick where it sits,
// the processor in its socket engraved with its name, the graphics card's
// top edge over its slot sized by its model, an NVMe drive in the M.2 slot,
// and beside the board the other drives, the power supply and the fans, the
// fans turning at their measured speed. Each part glows in its health and can
// be picked. Nothing in it is a photo, so it fits any computer.

const short = (name: string) =>
  name.replace(/\((R|TM)\)/g, "").replace(/\s+CPU\s+@.*$/, "").replace(/^(Intel|AMD|NVIDIA)\s+/, "").replace(/^GeForce\s+/, "").replace(/\s+/g, " ").trim();
const gb = (b: number) => `${Math.round((b / 2 ** 30) * 10) / 10} GB`;
const temp = (p: HwPart | undefined) => p?.readings.find((r) => r.unit === "°C");
const fact = (p: HwPart, key: string) => p.facts.find(([k]) => k === key)?.[1] ?? "";

// The board's size from its name: "B360M", "mATX" or "Micro" for micro-ATX,
// "ITX" or "-I" for mini-ITX, ATX otherwise.
function form(name: string): { w: number; h: number; rows: number; kind: "atx" | "matx" | "itx" } {
  if (/itx|\b[A-Z]?\d{3}[A-Z]?-I\b|\bmini\b/i.test(name)) return { w: 170, h: 170, rows: 1, kind: "itx" };
  if (/\b[A-Z]\d{3}M\b|matx|micro|\bM-(PLUS|PRO|A|K)\b|-M\b/i.test(name)) return { w: 244, h: 244, rows: 4, kind: "matx" };
  return { w: 244, h: 305, rows: 7, kind: "atx" };
}

// A graphics card's length and thickness in millimetres, from its model.
function card(name: string): { length: number; thick: number } {
  if (/[45]0[89]0|titan/i.test(name)) return { length: 320, thick: 56 };
  if (/[2-5]0[78]0|7[89]00|6[89]00|69[05]0/i.test(name)) return { length: 270, thick: 42 };
  if (/[1-4]0[56]0|1[56][56]0|6[45]00|7[56]00/i.test(name)) return { length: 200, thick: 38 };
  return { length: 240, thick: 40 };
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

// The ring a part's health shows in, drawn over its outline.
function Ring({ x, y, w, h, r = 2, health }: { x: number; y: number; w: number; h: number; r?: number; health: Health | undefined }) {
  if (!health || health === "unknown" || health === "empty") return null;
  return <rect className={"hr-ring " + health} x={x - 1.2} y={y - 1.2} width={w + 2.4} height={h + 2.4} rx={r + 1} />;
}

// A label pinned to a part: what it is and its key figure.
function Tag({ x, y, text, health, anchor = "middle" }: { x: number; y: number; text: string; health: Health | undefined; anchor?: "start" | "middle" | "end" }) {
  const w = text.length * 2.05 + 9;
  const left = anchor === "middle" ? x - w / 2 : anchor === "end" ? x - w : x;
  return (
    <g className="hr-tag">
      <rect x={left} y={y - 4.6} width={w} height={9.2} rx={4.6} />
      <circle className={"hr-tag-dot " + (health ?? "")} cx={left + 4.6} cy={y} r={1.5} />
      <text x={left + 7.6} y={y + 1.4}>{text}</text>
    </g>
  );
}

export function Render({ snap, picked, onPick }: { snap: HwSnapshot; picked: string; onPick: (id: string) => void }) {
  const of = (kind: string) => snap.parts.filter((p) => p.kind === kind);
  const board = of("board")[0];
  const cpu = of("cpu")[0];
  const power = of("power")[0];
  const gpu = of("gpu").find((g) => g.id.startsWith("gpu:nvidia")) ?? of("gpu").find((g) => !/intel|uhd|iris|radeon\(tm\) graphics|vega \d graphics/i.test(g.name));
  const memory = of("memory").sort((a, b) => a.place.localeCompare(b.place));
  const drives = of("drive");
  const nvme = drives.find((d) => /nvme/i.test(fact(d, "Kind")));
  const loose = drives.filter((d) => d !== nvme).slice(0, 3);
  const fans = of("fan").slice(0, 6);

  const f = form(board?.name ?? "");
  const W = f.w;
  const H = f.h;
  // Memory slots: as many as the board reports, at least those with sticks.
  const count = Math.min(8, Math.max(snap.slots || memory.length, memory.length, 2));
  const slots = Array.from({ length: count }, (_, i) => memory[i]);
  // The socket, and the parts placed around it.
  const cx = f.kind === "itx" ? 70 : W * 0.43;
  const cy = f.kind === "itx" ? 62 : 74;
  const dimmX = f.kind === "itx" ? 128 : cx + 52;
  // The memory slots run down from near the top edge; the expansion slots
  // start below where they end, as on real boards.
  const dimmTop = f.kind === "itx" ? 8 : 12;
  const dimmLen = 133.4;
  const rowsTop = f.kind === "itx" ? 156 : f.kind === "matx" ? 160 : 162;
  const rows = Array.from({ length: f.rows }, (_, i) => rowsTop + i * 20.32);
  const gpuSize = card(gpu?.name ?? "");

  // The column beside the board: drives, the power supply, the fans.
  // It starts past the graphics card, which can reach beyond the board.
  const side = Math.max(W, gpu ? gpuSize.length + 1 : 0) + 26;
  let y = 6;
  const placed: { part: HwPart; y: number; kind: "ssd" | "hdd" | "psu" }[] = [];
  for (const d of loose) {
    const hdd = /hdd/i.test(fact(d, "Kind"));
    placed.push({ part: d, y, kind: hdd ? "hdd" : "ssd" });
    y += (hdd ? 69 : 70) + 18;
  }
  const psuY = y;
  if (power) y += 58 + 18;
  const fansY = y;
  y += Math.ceil(fans.length / 2) * 60;
  const height = Math.max(H + 24, y + 10);
  const width = side + 108;

  const cpuTemp = temp(cpu);
  const gpuTemp = temp(gpu);
  const brand = /amd|ryzen|epyc|threadripper/i.test(cpu?.name ?? "") ? "AMD" : "INTEL";
  const cpuModel = (cpu?.name ?? "").match(/(i[3579]-\d{4,5}[A-Z]*|Ryzen \d \d{4}[A-Z0-9]*|Xeon[^@]*|Pentium[^@]*|Celeron[^@]*|Core Ultra \d \d{3}[A-Z]*)/i)?.[0] ?? short(cpu?.name ?? "");
  const cpuClock = (cpu?.name ?? "").match(/@\s*([\d.]+\s*GHz)/i)?.[1]?.replace(/\s/g, "").toUpperCase() ?? "";
  const cpuFamily = brand === "AMD" ? "AMD RYZEN™" : /i[3579]-/.test(cpuModel) ? `INTEL® CORE™ ${cpuModel.slice(0, 2).toUpperCase()}` : "INTEL®";

  return (
    <svg className="hr" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="This computer, drawn from above">
      <defs>
        <linearGradient id="hr-pcb" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2a2d31" />
          <stop offset="1" stopColor="#1a1c1f" />
        </linearGradient>
        <linearGradient id="hr-metal" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#e9ecef" />
          <stop offset=".45" stopColor="#b9bfc6" />
          <stop offset=".55" stopColor="#d4d8dd" />
          <stop offset="1" stopColor="#9aa1a9" />
        </linearGradient>
        <linearGradient id="hr-sink" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#3b3f45" />
          <stop offset=".5" stopColor="#575c63" />
          <stop offset="1" stopColor="#33373c" />
        </linearGradient>
        <linearGradient id="hr-slot" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#0d0e10" />
          <stop offset=".5" stopColor="#24262a" />
          <stop offset="1" stopColor="#0d0e10" />
        </linearGradient>
        <linearGradient id="hr-stick" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#15171a" />
          <stop offset=".35" stopColor="#4a4f56" />
          <stop offset=".65" stopColor="#3a3e44" />
          <stop offset="1" stopColor="#121316" />
        </linearGradient>
        <linearGradient id="hr-shroud" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3d4148" />
          <stop offset=".18" stopColor="#202226" />
          <stop offset=".82" stopColor="#1a1c20" />
          <stop offset="1" stopColor="#34383e" />
        </linearGradient>
        <linearGradient id="hr-gold" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f3d27a" />
          <stop offset="1" stopColor="#a8822c" />
        </linearGradient>
        <radialGradient id="hr-cap" cx=".35" cy=".35" r=".7">
          <stop offset="0" stopColor="#9aa0a8" />
          <stop offset="1" stopColor="#2b2e33" />
        </radialGradient>
        <pattern id="hr-fins" width="1.6" height="4" patternUnits="userSpaceOnUse">
          <rect width="1.6" height="4" fill="#2c2f34" />
          <rect width=".7" height="4" fill="#8a9098" />
        </pattern>
        <pattern id="hr-grill" width="4" height="4" patternUnits="userSpaceOnUse">
          <rect width="4" height="4" fill="#16181b" />
          <circle cx="2" cy="2" r="1.2" fill="#050506" />
        </pattern>
        <filter id="hr-brushed" x="0" y="0" width="1" height="1">
          <feTurbulence type="fractalNoise" baseFrequency="0.9 0.02" numOctaves="2" seed="3" result="n" />
          <feColorMatrix in="n" type="saturate" values="0" result="g" />
          <feComponentTransfer in="g" result="a"><feFuncA type="linear" slope=".18" /></feComponentTransfer>
          <feComposite in="a" in2="SourceGraphic" operator="in" result="t" />
          <feMerge><feMergeNode in="SourceGraphic" /><feMergeNode in="t" /></feMerge>
        </filter>
        <filter id="hr-grain" x="0" y="0" width="1" height="1">
          <feTurbulence type="fractalNoise" baseFrequency="1.6" numOctaves="2" seed="7" result="n" />
          <feColorMatrix in="n" type="saturate" values="0" result="g" />
          <feComponentTransfer in="g" result="a"><feFuncA type="linear" slope=".08" /></feComponentTransfer>
          <feComposite in="a" in2="SourceGraphic" operator="in" result="t" />
          <feMerge><feMergeNode in="SourceGraphic" /><feMergeNode in="t" /></feMerge>
        </filter>
        <filter id="hr-shadow" x="-10%" y="-10%" width="130%" height="130%">
          <feDropShadow dx="1.2" dy="1.6" stdDeviation="1.4" floodColor="#000" floodOpacity=".55" />
        </filter>
        <filter id="hr-glow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="1.8" />
        </filter>
      </defs>

      {/* The board. */}
      <g transform="translate(10 10)">
        <Pick part={board} picked={picked} onPick={onPick}>
          <rect x="0" y="0" width={W} height={H} rx="3" fill="url(#hr-pcb)" filter="url(#hr-grain)" className="hr-board" />
          {/* Traces fanning out from the socket to the memory. */}
          {Array.from({ length: 14 }, (_, i) => (
            <path key={i} className="hr-trace" d={`M${cx + 22} ${cy - 18 + i * 2.6} C ${cx + 34} ${cy - 18 + i * 2.6}, ${dimmX - 12} ${dimmTop + 40 + i * 5}, ${dimmX - 2} ${dimmTop + 40 + i * 5}`} />
          ))}
          {/* The board itself is ringed only when something is wrong with it. */}
          <Ring x={0} y={0} w={W} h={H} r={3} health={board && board.health !== "ok" ? board.health : undefined} />
        </Pick>
        {/* Mounting holes. */}
        {[[6, 6], [W - 6, 6], [6, H - 6], [W - 6, H - 6], [W * 0.66, 6], [6, H * 0.55], [W - 6, H * 0.55], [W * 0.66, H - 6]]
          .filter(([hx, hy]) => f.kind !== "itx" || (hx < 10 || hx > W - 10) && (hy < 10 || hy > H - 10))
          .map(([hx, hy]) => (
            <g key={`${hx}-${hy}`}>
              <circle cx={hx} cy={hy} r="3.6" fill="url(#hr-gold)" opacity=".85" />
              <circle cx={hx} cy={hy} r="1.9" fill="#0a0b0c" />
            </g>
          ))}
        {/* The rear connectors under their cover. */}
        <g filter="url(#hr-shadow)">
          <rect x="3" y="5" width="27" height={f.kind === "itx" ? 110 : rowsTop - 12} rx="2" fill="url(#hr-sink)" />
          <rect x="3" y="5" width="27" height={f.kind === "itx" ? 110 : rowsTop - 12} rx="2" fill="#000" opacity=".25" filter="url(#hr-brushed)" />
          <path d={`M8 ${(f.kind === "itx" ? 110 : rowsTop - 12) * 0.35} L26 ${(f.kind === "itx" ? 110 : rowsTop - 12) * 0.25}`} stroke="#7d848c" strokeWidth=".6" opacity=".6" />
        </g>
        {/* Power stages around the socket, under their heatsinks. */}
        {f.kind !== "itx" && (
          <g filter="url(#hr-shadow)">
            <rect x={cx - 52} y="8" width="86" height="15" rx="1.6" fill="url(#hr-sink)" />
            <rect x="34" y={cy - 42} width="15" height="80" rx="1.6" fill="url(#hr-sink)" />
            {Array.from({ length: 9 }, (_, i) => <rect key={i} x={cx - 49 + i * 9.4} y="9.5" width="1.2" height="12" fill="#2b2e33" />)}
            {Array.from({ length: 7 }, (_, i) => <rect key={i} x="35.5" y={cy - 39 + i * 11} width="12" height="1.2" fill="#2b2e33" />)}
          </g>
        )}
        {/* Capacitors near the socket. */}
        {Array.from({ length: 6 }, (_, i) => <circle key={i} cx={cx - 34 + i * 5.2} cy={cy + 36} r="2.2" fill="url(#hr-cap)" />)}
        {/* The CPU power connector. */}
        <rect x={f.kind === "itx" ? 30 : cx - 70} y="2.5" width="16" height="8.4" rx="1" fill="#101113" stroke="#2c2f34" strokeWidth=".4" />

        {/* The processor in its socket, under the load plate. */}
        <Pick part={cpu} picked={picked} onPick={onPick}>
          <g filter="url(#hr-shadow)">
            <rect x={cx - 25} y={cy - 27} width="50" height="54" rx="2" fill="none" stroke="#8d949c" strokeWidth="2.4" />
            <rect x={cx - 25} y={cy - 27} width="50" height="54" rx="2" fill="none" stroke="#c9ced4" strokeWidth=".5" opacity=".7" />
            <path d={`M${cx + 29} ${cy - 29} L${cx + 29} ${cy + 25} L${cx + 25} ${cy + 29}`} fill="none" stroke="#b5bbc2" strokeWidth="1.4" strokeLinecap="round" />
            <rect x={cx - 18.75} y={cy - 18.75} width="37.5" height="37.5" rx="1.2" fill="#1e4a32" />
            {cpu && (
              <>
                <path d={`M${cx - 15} ${cy - 16.5} h30 l1.5 1.5 v30 l-1.5 1.5 h-30 l-1.5 -1.5 v-30 z`} fill="url(#hr-metal)" filter="url(#hr-brushed)" />
                <text className="hr-etch" x={cx - 12} y={cy - 9}>{cpuFamily}</text>
                <text className="hr-etch strong" x={cx - 12} y={cy - 3.5}>{cpuModel.toUpperCase()}</text>
                {cpuClock && <text className="hr-etch" x={cx - 12} y={cy + 2}>{cpuClock}</text>}
              </>
            )}
          </g>
          <Ring x={cx - 18.75} y={cy - 18.75} w={37.5} h={37.5} health={cpu?.health} />
        </Pick>
        {cpu && <Tag x={cx} y={cy - 36} text={`${cpuModel}${cpuTemp ? ` · ${Math.round(cpuTemp.value)}°C` : ""}`} health={cpu.health} />}

        {/* The memory slots, each stick seen along its top edge. */}
        {slots.map((p, i) => {
          const x = dimmX + i * 9.6 + Math.floor(i / 2) * 2.2;
          const filled = !!p?.bytes;
          return (
            <Pick key={i} part={p && p.health !== "empty" ? p : undefined} picked={picked} onPick={onPick}>
              <rect x={x - 1} y={dimmTop - 4} width="8.6" height={dimmLen + 8} rx="1" fill="#0c0d0f" />
              <rect x={x} y={dimmTop} width="6.6" height={dimmLen} rx=".8" fill="url(#hr-slot)" />
              <rect x={x - .6} y={dimmTop - 4} width="7.8" height="3.4" rx=".8" fill="#2f3237" />
              <rect x={x - .6} y={dimmTop + dimmLen + .6} width="7.8" height="3.4" rx=".8" fill="#2f3237" />
              {filled && (
                <g filter="url(#hr-shadow)">
                  <rect x={x + .4} y={dimmTop + .8} width="5.8" height={dimmLen - 1.6} rx="1" fill="url(#hr-stick)" />
                  <rect x={x + 2.6} y={dimmTop + 6} width="1.4" height={dimmLen - 12} rx=".7" className="hr-stick-line" />
                  <text className="hr-stick-text" transform={`rotate(-90 ${x + 3.3} ${dimmTop + dimmLen / 2})`} x={x + 3.3} y={dimmTop + dimmLen / 2 + 1}>{gb(p.bytes ?? 0)}</text>
                </g>
              )}
              <Ring x={x} y={dimmTop} w={6.6} h={dimmLen} r={1} health={p?.health === "empty" ? undefined : p?.health} />
            </Pick>
          );
        })}

        {/* The 24-pin power connector. */}
        <Pick part={power} picked={picked} onPick={onPick}>
          <rect x={W - 13} y={f.kind === "itx" ? 40 : 92} width="9.6" height="52" rx="1" fill="#101113" stroke="#2c2f34" strokeWidth=".4" />
          {Array.from({ length: 24 }, (_, n) => (
            <rect key={n} x={W - 12 + (n % 2) * 4.2} y={(f.kind === "itx" ? 41.5 : 93.5) + Math.floor(n / 2) * 4.15} width="3.4" height="3.2" rx=".5" fill="#2a2d31" />
          ))}
          <Ring x={W - 13} y={f.kind === "itx" ? 40 : 92} w={9.6} h={52} r={1} health={power?.health} />
        </Pick>

        {/* The M.2 slot, with its drive when it holds one. */}
        <g>
          <rect x={cx - 42} y={cy + 47} width="7" height="24" rx=".8" fill="#0d0e10" />
          <circle cx={cx + 40} cy={cy + 59} r="1.6" fill="url(#hr-gold)" />
        </g>
        {nvme && (
          <Pick part={nvme} picked={picked} onPick={onPick}>
            <g filter="url(#hr-shadow)">
              <rect x={cx - 38} y={cy + 48} width="80" height="22" rx="1" fill="#0f1a12" />
              {[0, 1, 2].map((c) => <rect key={c} x={cx - 30 + c * 22} y={cy + 52} width="15" height="14" rx=".6" fill="#16181b" />)}
              <rect x={cx - 34} y={cy + 50.5} width="20" height="17" rx=".6" className="hr-label" />
              <text className="hr-label-text" x={cx - 24} y={cy + 60}>NVMe</text>
            </g>
            <Ring x={cx - 38} y={cy + 48} w={80} h={22} r={1} health={nvme.health} />
          </Pick>
        )}

        {/* Expansion slots. */}
        {rows.map((ry, i) => {
          const long = i % 2 === 0;
          return (
            <g key={i}>
              <rect x="36" y={ry - 3.6} width={long ? 89 : 25} height="7.2" rx=".8" fill="url(#hr-slot)" stroke={long ? "#8d949c" : "none"} strokeWidth=".5" />
              <rect x={long ? 127 : 63} y={ry - 3.1} width="4" height="6.2" rx=".6" fill="#2f3237" />
            </g>
          );
        })}

        {/* The chipset's heatsink, and the SATA ports by the edge. */}
        {f.kind !== "itx" && (
          <g filter="url(#hr-shadow)">
            <rect x={W - 76} y={rowsTop + 16} width="40" height="34" rx="2" fill="url(#hr-sink)" />
            <rect x={W - 76} y={rowsTop + 16} width="40" height="34" rx="2" fill="#000" opacity=".2" filter="url(#hr-brushed)" />
          </g>
        )}
        {Array.from({ length: f.kind === "itx" ? 2 : 4 }, (_, i) => (
          <rect key={i} x={W - 14} y={(f.kind === "itx" ? 110 : rowsTop + 40) + i * 9.5} width="11" height="7.6" rx="1" fill="#101113" stroke="#2c2f34" strokeWidth=".4" />
        ))}
        {/* The clock battery and the audio chip. */}
        <circle cx={f.kind === "itx" ? 140 : 150} cy={f.kind === "itx" ? 150 : rowsTop + 52} r="10" fill="url(#hr-metal)" filter="url(#hr-brushed)" />
        <rect x="14" y={H - 46} width="13" height="13" rx="1" fill="#141518" stroke="#2c2f34" strokeWidth=".4" />
        {Array.from({ length: 6 }, (_, i) => <circle key={i} cx={14 + (i % 3) * 5.2} cy={H - 26 + Math.floor(i / 3) * 5.2} r="2" fill="url(#hr-gold)" />)}
        {/* Headers along the bottom edge. */}
        {Array.from({ length: f.kind === "itx" ? 2 : 6 }, (_, i) => (
          <rect key={i} x={46 + i * 30} y={H - 8} width="18" height="5" rx=".6" fill="#101113" stroke="#2c2f34" strokeWidth=".4" />
        ))}
        <text className="hr-silk" x={f.kind === "itx" ? 40 : 46} y={H - 14}>{short(board?.name ?? "").toUpperCase().slice(0, 34)}</text>

        {/* The graphics card, standing in its slot: its top edge, fins and name. */}
        {gpu && (
          <Pick part={gpu} picked={picked} onPick={onPick}>
            <g filter="url(#hr-shadow)">
              <rect x="-2" y={rows[0] - 4} width="3" height={gpuSize.thick + 2} fill="url(#hr-metal)" />
              <rect x="1" y={rows[0] - 3} width={gpuSize.length} height={gpuSize.thick} rx="3" fill="url(#hr-shroud)" />
              <rect x="10" y={rows[0] + gpuSize.thick * 0.32} width={gpuSize.length - 20} height={gpuSize.thick * 0.36} fill="url(#hr-fins)" opacity=".9" />
              <rect x="1" y={rows[0] - 3} width={gpuSize.length} height="2.2" rx="1" fill="#5a6068" />
              <text className="hr-gpu-name" x={gpuSize.length * 0.5} y={rows[0] + gpuSize.thick * 0.2}>{/nvidia|geforce|rtx|gtx/i.test(gpu.name) ? "GEFORCE" : "RADEON"} {short(gpu.name).toUpperCase()}</text>
            </g>
            <Ring x={1} y={rows[0] - 3} w={gpuSize.length} h={gpuSize.thick} r={3} health={gpu.health} />
          </Pick>
        )}
        {gpu && <Tag x={14} y={rows[0] - 10} anchor="start" text={`${short(gpu.name)}${gpuTemp ? ` · ${Math.round(gpuTemp.value)}°C` : ""}`} health={gpu.health} />}
      </g>

      {/* Beside the board: drives, the power supply and the fans. */}
      <g transform={`translate(${side} 10)`}>
        {placed.map(({ part, y: top, kind }) => {
          const t = temp(part);
          return (
            <Pick key={part.id} part={part} picked={picked} onPick={onPick}>
              {kind === "ssd" ? (
                <g filter="url(#hr-shadow)">
                  <rect x="0" y={top} width="100" height="70" rx="3" fill="url(#hr-metal)" filter="url(#hr-brushed)" />
                  <rect x="12" y={top + 14} width="76" height="42" rx="2" className="hr-label" />
                  <text className="hr-label-text big" x="50" y={top + 33}>{short(part.name).slice(0, 18)}</text>
                  <text className="hr-label-text" x="50" y={top + 44}>{fact(part, "Size")} SSD</text>
                </g>
              ) : (
                <g filter="url(#hr-shadow)">
                  <rect x="0" y={top} width="100" height="69" rx="3" fill="url(#hr-metal)" filter="url(#hr-brushed)" />
                  <circle cx="60" cy={top + 34.5} r="28" fill="none" stroke="#8c939b" strokeWidth="1" />
                  <circle cx="60" cy={top + 34.5} r="6" fill="#9aa1a9" />
                  <rect x="6" y={top + 10} width="34" height="49" rx="1.5" className="hr-label" />
                  <text className="hr-label-text" x="23" y={top + 34}>{fact(part, "Size")}</text>
                </g>
              )}
              <Ring x={0} y={top} w={100} h={kind === "ssd" ? 70 : 69} r={3} health={part.health} />
              <Tag x={50} y={top + (kind === "ssd" ? 70 : 69) + 8} text={`${short(part.name).slice(0, 16)}${t ? ` · ${Math.round(t.value)}°C` : ""}`} health={part.health} />
            </Pick>
          );
        })}
        {power && (
          <Pick part={power} picked={picked} onPick={onPick}>
            <g filter="url(#hr-shadow)">
              <rect x="0" y={psuY} width="100" height="58" rx="3" fill="#1b1d20" />
              <circle cx="58" cy={psuY + 29} r="25" fill="url(#hr-grill)" />
              <circle cx="58" cy={psuY + 29} r="25" fill="none" stroke="#3a3e44" strokeWidth="1.2" />
              <circle cx="58" cy={psuY + 29} r="6" fill="#2a2d31" />
              <rect x="6" y={psuY + 8} width="18" height="42" rx="1" fill="#141518" />
            </g>
            <Ring x={0} y={psuY} w={100} h={58} r={3} health={power.health} />
            <Tag x={50} y={psuY + 66} text="Power supply" health={power.health} />
          </Pick>
        )}
        {fans.map((p, i) => {
          const fx = 25 + (i % 2) * 50;
          const fy = fansY + 22 + Math.floor(i / 2) * 60;
          const rpm = p.readings[0]?.value ?? 0;
          // Seen turning: faster fans turn faster, all slowed enough to see.
          const period = rpm > 0 ? Math.min(4, Math.max(0.35, 600 / rpm)) : 0;
          return (
            <Pick key={p.id} part={p} picked={picked} onPick={onPick}>
              <g filter="url(#hr-shadow)">
                <rect x={fx - 22} y={fy - 22} width="44" height="44" rx="4" fill="#17191c" />
                <circle cx={fx} cy={fy} r="20.5" fill="#0b0c0e" />
                <g className="hr-blades" style={period ? { animationDuration: `${period}s`, transformOrigin: `${fx}px ${fy}px` } : { transformOrigin: `${fx}px ${fy}px`, animation: "none" }}>
                  {Array.from({ length: 7 }, (_, b) => (
                    <path key={b} transform={`rotate(${(b * 360) / 7} ${fx} ${fy})`} d={`M${fx} ${fy - 5} C ${fx + 8} ${fy - 9}, ${fx + 12} ${fy - 16}, ${fx + 4} ${fy - 19.5} C ${fx - 1} ${fy - 15}, ${fx - 2} ${fy - 9}, ${fx} ${fy - 5} Z`} fill="#3a3e45" />
                  ))}
                </g>
                <circle cx={fx} cy={fy} r="6" fill="#26292d" stroke="#3f444a" strokeWidth=".6" />
              </g>
              <Ring x={fx - 22} y={fy - 22} w={44} h={44} r={4} health={p.health} />
              <text className="hr-fan-rpm" x={fx} y={fy + 29}>{Math.round(rpm)} RPM</text>
            </Pick>
          );
        })}
      </g>
    </svg>
  );
}
