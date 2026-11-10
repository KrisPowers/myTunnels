import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { HwPart, HwSnapshot } from "./api";

// Gallery is every part of this computer as a tile of its own render, packed
// the way photo galleries pack pictures: each tile keeps its part's shape,
// each row is stretched to fill the width exactly, and the row height is the
// largest at which every row fits the space it has, so nothing scrolls and
// no wide gaps open up. Each tile is ringed in its part's health.

const short = (name: string) =>
  name.replace(/\((R|TM)\)/g, "").replace(/\s+CPU\s+@.*$/, "").replace(/^(Intel|AMD|NVIDIA)\s+/, "").replace(/^GeForce\s+/, "").replace(/\s+/g, " ").trim();
const fact = (p: HwPart, key: string) => p.facts.find(([k]) => k === key)?.[1] ?? "";
const temp = (p: HwPart) => p.readings.find((r) => r.unit === "°C");
const gb = (b: number) => `${Math.round(b / 2 ** 30)} GB`;

// A graphics card's length in millimetres, from its model; its face is 112 mm tall.
const cardLength = (name: string) =>
  /[45]0[89]0|titan/i.test(name) ? 320 : /[2-5]0[78]0|7[89]00|6[89]00/i.test(name) ? 280 : /[1-4]0[56]0|1[56][56]0|6[45]00|7[56]00/i.test(name) ? 200 : 240;

type Item = { part: HwPart; aspect: number; draw: ReactNode };

// Each part's render and its shape (width over height), in millimetres.
function items(snap: HwSnapshot): Item[] {
  const out: Item[] = [];
  for (const p of snap.parts) {
    if (p.health === "empty") continue;
    if (p.kind === "cpu") out.push({ part: p, aspect: 1, draw: <Cpu part={p} /> });
    else if (p.kind === "memory" && p.bytes) out.push({ part: p, aspect: 133.35 / 31.25, draw: <Stick part={p} /> });
    else if (p.kind === "memory") out.push({ part: p, aspect: 133.35 / 31.25, draw: <Stick part={p} missing /> });
    else if (p.kind === "gpu" && (p.id.startsWith("gpu:nvidia") || !/intel|uhd|iris|radeon\(tm\) graphics|vega \d graphics/i.test(p.name))) {
      out.push({ part: p, aspect: cardLength(p.name) / 112, draw: <Card part={p} /> });
    } else if (p.kind === "drive") {
      const kind = fact(p, "Kind");
      if (/nvme/i.test(kind)) out.push({ part: p, aspect: 80 / 22, draw: <Nvme part={p} /> });
      else if (/hdd/i.test(kind)) out.push({ part: p, aspect: 147 / 101.6, draw: <Hdd part={p} /> });
      else out.push({ part: p, aspect: 100 / 69.85, draw: <Ssd part={p} /> });
    } else if (p.kind === "power") out.push({ part: p, aspect: 150 / 86, draw: <Psu part={p} /> });
    else if (p.kind === "fan") out.push({ part: p, aspect: 1, draw: <Fan part={p} /> });
  }
  return out;
}

// Rows of items for a row height: each row filled until it reaches the
// width, then scaled to fill it exactly; the last row too when it is most of
// the way there.
function justify(aspects: number[], width: number, target: number, gap: number) {
  const rows: { items: number[]; height: number }[] = [];
  let row: number[] = [];
  let sum = 0;
  aspects.forEach((a, i) => {
    row.push(i);
    sum += a;
    if (sum * target + gap * (row.length - 1) >= width) {
      rows.push({ items: row, height: (width - gap * (row.length - 1)) / sum });
      row = [];
      sum = 0;
    }
  });
  if (row.length) {
    const exact = (width - gap * (row.length - 1)) / sum;
    rows.push({ items: row, height: sum * target >= width * 0.6 ? Math.min(exact, target * 1.6) : target });
  }
  return { rows, height: rows.reduce((h, r) => h + r.height, 0) + gap * Math.max(0, rows.length - 1) };
}

export function Gallery({ snap, picked, onPick }: { snap: HwSnapshot; picked: string; onPick: (id: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  const list = items(snap);
  const gap = 12;
  // The tallest rows that still fit the height, between 80 and 420 pixels.
  let layout = justify(list.map((i) => i.aspect), size.w, 80, gap);
  for (let t = 420; t >= 80; t -= 2) {
    const tried = justify(list.map((i) => i.aspect), size.w, t, gap);
    if (tried.height <= size.h) {
      layout = tried;
      break;
    }
  }

  return (
    <div className="hg" ref={box}>
      <GalleryDefs />
      {size.w > 0 && layout.rows.map((row, r) => (
        <div key={r} className="hg-row" style={{ height: row.height }}>
          {row.items.map((i) => {
            const { part, aspect, draw } = list[i];
            const t = temp(part);
            const key = t ?? part.readings[0];
            return (
              <button key={part.id} type="button" className={`hg-tile ${part.health}` + (picked === part.id ? " picked" : "")}
                style={{ width: aspect * row.height }} onClick={() => onPick(part.id)} aria-label={`${part.name}: ${part.reason || part.health}`}>
                {draw}
                <span className="hg-caption">
                  <span className={"dot " + (part.health === "unknown" ? "" : part.health)} />
                  <span className="hg-name">{part.kind === "memory" && part.place ? `${part.place} · ` : ""}{part.kind === "power" ? "Power supply" : short(part.name)}</span>
                  {key && <b className={key.health}>{Math.round(key.value)}{key.unit === "°C" ? "°C" : key.unit === "%" ? "%" : ` ${key.unit}`}</b>}
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// The gradients and textures every render shares, defined once.
function GalleryDefs() {
  return (
    <svg className="hg-defs" aria-hidden width="0" height="0">
      <defs>
        <linearGradient id="hg-metal" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#eef0f2" />
          <stop offset=".42" stopColor="#bcc2c9" />
          <stop offset=".58" stopColor="#d7dbe0" />
          <stop offset="1" stopColor="#99a0a8" />
        </linearGradient>
        <linearGradient id="hg-steel" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#c9ced4" />
          <stop offset=".5" stopColor="#8a9198" />
          <stop offset="1" stopColor="#b4bac1" />
        </linearGradient>
        <linearGradient id="hg-pcb" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#24734a" />
          <stop offset="1" stopColor="#174f33" />
        </linearGradient>
        <linearGradient id="hg-pcb-dark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#1f2226" />
          <stop offset="1" stopColor="#121417" />
        </linearGradient>
        <linearGradient id="hg-shroud" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3a3e44" />
          <stop offset=".15" stopColor="#24272b" />
          <stop offset=".85" stopColor="#1a1c1f" />
          <stop offset="1" stopColor="#2e3136" />
        </linearGradient>
        <linearGradient id="hg-gold" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f3d27a" />
          <stop offset="1" stopColor="#a8822c" />
        </linearGradient>
        <linearGradient id="hg-chip" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2a2d31" />
          <stop offset="1" stopColor="#111214" />
        </linearGradient>
        <radialGradient id="hg-hub" cx=".35" cy=".35" r=".7">
          <stop offset="0" stopColor="#4a4f56" />
          <stop offset="1" stopColor="#1c1e21" />
        </radialGradient>
        <pattern id="hg-fingers" width="1" height="4" patternUnits="userSpaceOnUse">
          <rect width="1" height="4" fill="#3a2f12" />
          <rect width=".72" height="4" fill="url(#hg-gold)" />
        </pattern>
        <pattern id="hg-grill" width="3" height="3" patternUnits="userSpaceOnUse">
          <rect width="3" height="3" fill="#1b1d20" />
          <circle cx="1.5" cy="1.5" r=".95" fill="#060607" />
        </pattern>
        <filter id="hg-brushed" x="0" y="0" width="1" height="1">
          <feTurbulence type="fractalNoise" baseFrequency="1.1 0.03" numOctaves="2" seed="3" result="n" />
          <feColorMatrix in="n" type="saturate" values="0" result="g" />
          <feComponentTransfer in="g" result="a"><feFuncA type="linear" slope=".16" /></feComponentTransfer>
          <feComposite in="a" in2="SourceGraphic" operator="in" result="t" />
          <feMerge><feMergeNode in="SourceGraphic" /><feMergeNode in="t" /></feMerge>
        </filter>
        <filter id="hg-shadow" x="-10%" y="-10%" width="130%" height="140%">
          <feDropShadow dx=".6" dy=".9" stdDeviation=".7" floodColor="#000" floodOpacity=".55" />
        </filter>
      </defs>
    </svg>
  );
}

// The fan blades, turning at a speed that follows the fan's own, slowed to be seen.
function Blades({ cx, cy, r, turning, blades = 7 }: { cx: number; cy: number; r: number; turning: number; blades?: number }) {
  const style = turning > 0 ? { animationDuration: `${turning}s`, transformOrigin: `${cx}px ${cy}px` } : { transformOrigin: `${cx}px ${cy}px`, animation: "none" };
  return (
    <g className="hg-blades" style={style}>
      {Array.from({ length: blades }, (_, b) => (
        <path key={b} transform={`rotate(${(b * 360) / blades} ${cx} ${cy})`} fill="#3b4047"
          d={`M${cx} ${cy - r * 0.26} C ${cx + r * 0.42} ${cy - r * 0.46}, ${cx + r * 0.6} ${cy - r * 0.8}, ${cx + r * 0.2} ${cy - r * 0.97} C ${cx - r * 0.05} ${cy - r * 0.76}, ${cx - r * 0.1} ${cy - r * 0.46}, ${cx} ${cy - r * 0.26} Z`} />
      ))}
    </g>
  );
}

function Cpu({ part }: { part: HwPart }) {
  const model = part.name.match(/(i[3579]-\d{4,5}[A-Z]*|Ryzen \d \d{4}[A-Z0-9]*|Core Ultra \d \d{3}[A-Z]*|Xeon[^@]*|Pentium[^@]*|Celeron[^@]*)/i)?.[0]?.trim() ?? short(part.name);
  const clock = part.name.match(/@\s*([\d.]+\s*GHz)/i)?.[1]?.replace(/\s/g, "").toUpperCase() ?? "";
  const amd = /amd|ryzen|epyc|threadripper/i.test(part.name);
  const family = amd ? "AMD RYZEN™" : /^i[3579]-/i.test(model) ? `INTEL® CORE™ ${model.slice(0, 2).toUpperCase()}` : "INTEL®";
  return (
    <svg className="hg-art" viewBox="0 0 40 40" preserveAspectRatio="xMidYMid meet">
      <g filter="url(#hg-shadow)">
        <rect x="1.25" y="1.25" width="37.5" height="37.5" rx="1" fill="url(#hg-pcb)" />
        {[[3, 3], [35.4, 3], [3, 35.4], [35.4, 35.4]].map(([x, y]) => <rect key={`${x}${y}`} x={x} y={y} width="1.6" height="1.6" fill="url(#hg-gold)" />)}
        <path d="M5.2 3.6 h29.6 l1.4 1.4 v30 l-1.4 1.4 h-29.6 l-1.4 -1.4 v-30 z" fill="url(#hg-metal)" filter="url(#hg-brushed)" />
      </g>
      <text className="hg-etch" x="7.8" y="13">{family}</text>
      <text className="hg-etch strong" x="7.8" y="18.4">{model.toUpperCase()}</text>
      {clock && <text className="hg-etch" x="7.8" y="23.4">{clock}</text>}
    </svg>
  );
}

// A memory stick face on: its board, chips, label and gold edge.
function Stick({ part, missing }: { part: HwPart; missing?: boolean }) {
  const label = [fact(part, "Maker").replace(/^04EF$/, ""), fact(part, "Part number")].filter(Boolean).join(" ") || "DDR4";
  return (
    <svg className="hg-art" viewBox="0 0 133.35 31.25" preserveAspectRatio="xMidYMid meet">
      <g filter="url(#hg-shadow)" opacity={missing ? .35 : 1}>
        <path d="M0 1.2 Q0 0 1.2 0 H132.15 Q133.35 0 133.35 1.2 V27 H72.6 v1.6 h-2.4 V27 H0 Z" fill="url(#hg-pcb)" />
        <rect x="2" y="27" width="66" height="3.8" fill="url(#hg-fingers)" />
        <rect x="72.8" y="27" width="58.5" height="3.8" fill="url(#hg-fingers)" />
        {Array.from({ length: 8 }, (_, c) => (
          <rect key={c} x={8 + c * 14.6 + (c > 3 ? 4 : 0)} y="7" width="10.5" height="13" rx=".5" fill="url(#hg-chip)" />
        ))}
        <rect x="47" y="2.2" width="40" height="4" rx=".4" fill="#f2f3f5" />
        <text className="hg-sticker" x="67" y="5.05">{part.bytes ? `${gb(part.bytes)} · ${label}` : "Not detected"}</text>
      </g>
    </svg>
  );
}

// A graphics card face on: its shroud and fans, bracket, and gold edge.
function Card({ part }: { part: HwPart }) {
  const length = cardLength(part.name);
  const fans = length >= 300 ? 3 : 2;
  const fanSpeed = part.readings.find((r) => r.label === "Fan")?.value ?? 0;
  const turning = fanSpeed > 0 ? Math.min(4, Math.max(0.4, 40 / fanSpeed)) : 0;
  const pitch = (length - 30) / fans;
  return (
    <svg className="hg-art" viewBox={`0 0 ${length} 112`} preserveAspectRatio="xMidYMid meet">
      <g filter="url(#hg-shadow)">
        <rect x="0" y="0" width="4" height="112" fill="url(#hg-steel)" />
        {Array.from({ length: 6 }, (_, i) => <rect key={i} x="1" y={14 + i * 12} width="2" height="7" rx="1" fill="#5b6168" />)}
        <rect x="4" y="2" width={length - 4} height="100" rx="5" fill="url(#hg-shroud)" />
        <rect x="18" y="102" width="70" height="7" fill="url(#hg-fingers)" />
        {Array.from({ length: fans }, (_, i) => {
          const cx = 22 + pitch * (i + 0.5);
          return (
            <g key={i}>
              <circle cx={cx} cy="52" r="44" fill="#0b0c0e" />
              <circle cx={cx} cy="52" r="44" fill="none" stroke="#3f444b" strokeWidth="1.4" />
              <Blades cx={cx} cy={52} r={42} turning={turning} blades={9} />
              <circle cx={cx} cy="52" r="12" fill="url(#hg-hub)" />
            </g>
          );
        })}
      </g>
      <text className="hg-brand" x="12" y="12">{/radeon|rx\s?\d/i.test(part.name) ? "RADEON" : "GEFORCE"} {short(part.name).replace(/^GeForce\s+/i, "").toUpperCase()}</text>
    </svg>
  );
}

function Ssd({ part }: { part: HwPart }) {
  return (
    <svg className="hg-art" viewBox="0 0 100 69.85" preserveAspectRatio="xMidYMid meet">
      <g filter="url(#hg-shadow)">
        <rect x="0" y="0" width="100" height="69.85" rx="3" fill="url(#hg-metal)" filter="url(#hg-brushed)" />
        <rect x="11" y="13" width="78" height="44" rx="2" fill="#f2f3f5" />
      </g>
      <text className="hg-label big" x="50" y="34">{short(part.name).slice(0, 18)}</text>
      <text className="hg-label" x="50" y="44">{fact(part, "Size")} solid state drive</text>
    </svg>
  );
}

function Nvme({ part }: { part: HwPart }) {
  return (
    <svg className="hg-art" viewBox="0 0 80 22" preserveAspectRatio="xMidYMid meet">
      <g filter="url(#hg-shadow)">
        <path d="M0 0 H77.5 a2.5 2.5 0 0 1 0 5 v12 a2.5 2.5 0 0 1 0 5 H0 V13.5 h1.4 v-1.6 H0 Z" fill="url(#hg-pcb-dark)" />
        <rect x="0" y="1" width="3.6" height="20" fill="url(#hg-fingers)" />
        <rect x="8" y="3" width="15" height="16" rx=".5" fill="url(#hg-chip)" />
        <rect x="27" y="3" width="13" height="16" rx=".5" fill="url(#hg-chip)" />
        <rect x="44" y="2.5" width="28" height="17" rx=".5" fill="#f2f3f5" />
      </g>
      <text className="hg-label small" x="58" y="10">{short(part.name).slice(0, 16)}</text>
      <text className="hg-label small" x="58" y="15">{fact(part, "Size")} NVMe</text>
    </svg>
  );
}

function Hdd({ part }: { part: HwPart }) {
  return (
    <svg className="hg-art" viewBox="0 0 147 101.6" preserveAspectRatio="xMidYMid meet">
      <g filter="url(#hg-shadow)">
        <rect x="0" y="0" width="147" height="101.6" rx="4" fill="url(#hg-metal)" filter="url(#hg-brushed)" />
        <circle cx="92" cy="50.8" r="43" fill="none" stroke="#8b929a" strokeWidth="1.2" />
        <circle cx="92" cy="50.8" r="9" fill="#a3aab2" />
        <rect x="8" y="12" width="44" height="77" rx="2" fill="#f2f3f5" />
        {[[5, 5], [142, 5], [5, 96.6], [142, 96.6]].map(([x, y]) => <circle key={`${x}${y}`} cx={x} cy={y} r="2" fill="#6d747c" />)}
      </g>
      <text className="hg-label" x="30" y="46">{short(part.name).slice(0, 12)}</text>
      <text className="hg-label" x="30" y="56">{fact(part, "Size")}</text>
    </svg>
  );
}

function Psu({ part }: { part: HwPart }) {
  const rails = part.readings.filter((r) => r.unit === "V").slice(0, 3);
  return (
    <svg className="hg-art" viewBox="0 0 150 86" preserveAspectRatio="xMidYMid meet">
      <g filter="url(#hg-shadow)">
        <rect x="0" y="0" width="150" height="86" rx="4" fill="#1d1f22" />
        <circle cx="96" cy="43" r="38" fill="url(#hg-grill)" />
        <circle cx="96" cy="43" r="38" fill="none" stroke="#3a3e44" strokeWidth="1.6" />
        <circle cx="96" cy="43" r="10" fill="url(#hg-hub)" />
        <rect x="10" y="10" width="34" height="66" rx="2" fill="#141518" />
      </g>
      {rails.map((r, i) => <text key={r.label} className="hg-rail" x="27" y={26 + i * 14}>{r.label} {r.value.toFixed(2)}</text>)}
    </svg>
  );
}

function Fan({ part }: { part: HwPart }) {
  const rpm = part.readings[0]?.value ?? 0;
  const turning = rpm > 0 ? Math.min(4, Math.max(0.35, 600 / rpm)) : 0;
  return (
    <svg className="hg-art" viewBox="0 0 120 120" preserveAspectRatio="xMidYMid meet">
      <g filter="url(#hg-shadow)">
        <rect x="0" y="0" width="120" height="120" rx="10" fill="#17191c" />
        {[[8, 8], [112, 8], [8, 112], [112, 112]].map(([x, y]) => <circle key={`${x}${y}`} cx={x} cy={y} r="3" fill="#08090a" />)}
        <circle cx="60" cy="60" r="56" fill="#0b0c0e" />
        <Blades cx={60} cy={60} r={54} turning={turning} />
        <circle cx="60" cy="60" r="18" fill="url(#hg-hub)" />
      </g>
    </svg>
  );
}
