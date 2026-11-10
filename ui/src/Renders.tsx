import type { HwPart } from "./api";

// Renders draws each kind of part as it looks, from what the server read of
// it: a processor's heat spreader engraved with its name, a memory stick
// standing in its slot, a graphics card face on with its fans, a drive, a
// power supply, a fan. Fans turn at a speed that follows their own.

const short = (name: string) =>
  name.replace(/\((R|TM)\)/g, "").replace(/\s+CPU\s+@.*$/, "").replace(/^(Intel|AMD|NVIDIA)\s+/, "").replace(/^GeForce\s+/, "").replace(/\s+/g, " ").trim();
const fact = (p: HwPart, key: string) => p.facts.find(([k]) => k === key)?.[1] ?? "";

// A graphics card's length in millimetres, from its model; its face is 112 mm tall.
export const cardLength = (name: string) =>
  /[45]0[89]0|titan/i.test(name) ? 320 : /[2-5]0[78]0|7[89]00|6[89]00/i.test(name) ? 280 : /[1-4]0[56]0|1[56][56]0|6[45]00|7[56]00/i.test(name) ? 200 : 240;

// The gradients and textures every render shares, defined once on the page.
export function RenderDefs() {
  return (
    <svg className="rd-defs" aria-hidden width="0" height="0">
      <defs>
        <linearGradient id="rd-metal" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#eef0f2" />
          <stop offset=".42" stopColor="#bcc2c9" />
          <stop offset=".58" stopColor="#d7dbe0" />
          <stop offset="1" stopColor="#99a0a8" />
        </linearGradient>
        <linearGradient id="rd-steel" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#c9ced4" />
          <stop offset=".5" stopColor="#8a9198" />
          <stop offset="1" stopColor="#b4bac1" />
        </linearGradient>
        <linearGradient id="rd-pcb" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#24734a" />
          <stop offset="1" stopColor="#174f33" />
        </linearGradient>
        <linearGradient id="rd-pcb-dark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#24272b" />
          <stop offset="1" stopColor="#141618" />
        </linearGradient>
        <linearGradient id="rd-shroud" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3a3e44" />
          <stop offset=".15" stopColor="#24272b" />
          <stop offset=".85" stopColor="#1a1c1f" />
          <stop offset="1" stopColor="#2e3136" />
        </linearGradient>
        <linearGradient id="rd-gold" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#f3d27a" />
          <stop offset="1" stopColor="#a8822c" />
        </linearGradient>
        <linearGradient id="rd-chip" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2a2d31" />
          <stop offset="1" stopColor="#111214" />
        </linearGradient>
        <radialGradient id="rd-hub" cx=".35" cy=".35" r=".7">
          <stop offset="0" stopColor="#4a4f56" />
          <stop offset="1" stopColor="#1c1e21" />
        </radialGradient>
        <pattern id="rd-fingers-v" width="4" height="1" patternUnits="userSpaceOnUse">
          <rect width="4" height="1" fill="#3a2f12" />
          <rect width="4" height=".72" fill="url(#rd-gold)" />
        </pattern>
        <pattern id="rd-fingers-h" width="1" height="4" patternUnits="userSpaceOnUse">
          <rect width="1" height="4" fill="#3a2f12" />
          <rect width=".72" height="4" fill="url(#rd-gold)" />
        </pattern>
        <pattern id="rd-grill" width="3" height="3" patternUnits="userSpaceOnUse">
          <rect width="3" height="3" fill="#1b1d20" />
          <circle cx="1.5" cy="1.5" r=".95" fill="#060607" />
        </pattern>
        <filter id="rd-brushed" x="0" y="0" width="1" height="1">
          <feTurbulence type="fractalNoise" baseFrequency="1.1 0.03" numOctaves="2" seed="3" result="n" />
          <feColorMatrix in="n" type="saturate" values="0" result="g" />
          <feComponentTransfer in="g" result="a"><feFuncA type="linear" slope=".16" /></feComponentTransfer>
          <feComposite in="a" in2="SourceGraphic" operator="in" result="t" />
          <feMerge><feMergeNode in="SourceGraphic" /><feMergeNode in="t" /></feMerge>
        </filter>
      </defs>
    </svg>
  );
}

function Blades({ cx, cy, r, period, blades = 7 }: { cx: number; cy: number; r: number; period: number; blades?: number }) {
  const style = period > 0 ? { animationDuration: `${period}s`, transformOrigin: `${cx}px ${cy}px` } : { transformOrigin: `${cx}px ${cy}px`, animation: "none" };
  return (
    <g className="rd-blades" style={style}>
      {Array.from({ length: blades }, (_, b) => (
        <path key={b} transform={`rotate(${(b * 360) / blades} ${cx} ${cy})`} fill="#3b4047"
          d={`M${cx} ${cy - r * 0.26} C ${cx + r * 0.42} ${cy - r * 0.46}, ${cx + r * 0.6} ${cy - r * 0.8}, ${cx + r * 0.2} ${cy - r * 0.97} C ${cx - r * 0.05} ${cy - r * 0.76}, ${cx - r * 0.1} ${cy - r * 0.46}, ${cx} ${cy - r * 0.26} Z`} />
      ))}
    </g>
  );
}

export function CpuArt({ part }: { part: HwPart }) {
  const model = part.name.match(/(i[3579]-\d{4,5}[A-Z]*|Ryzen \d \d{4}[A-Z0-9]*|Core Ultra \d \d{3}[A-Z]*|Xeon[^@]*|Pentium[^@]*|Celeron[^@]*)/i)?.[0]?.trim() ?? short(part.name);
  const clock = part.name.match(/@\s*([\d.]+\s*GHz)/i)?.[1]?.replace(/\s/g, "").toUpperCase() ?? "";
  const amd = /amd|ryzen|epyc|threadripper/i.test(part.name);
  const family = amd ? "AMD RYZEN™" : /^i[3579]-/i.test(model) ? `INTEL® CORE™ ${model.slice(0, 2).toUpperCase()}` : "INTEL®";
  return (
    <svg className="rd" viewBox="0 0 40 40" role="img" aria-label={part.name}>
      <rect x="1.25" y="1.25" width="37.5" height="37.5" rx="1" fill="url(#rd-pcb)" />
      {[[3, 3], [35.4, 3], [3, 35.4], [35.4, 35.4]].map(([x, y]) => <rect key={`${x}${y}`} x={x} y={y} width="1.6" height="1.6" fill="url(#rd-gold)" />)}
      <path d="M5.2 3.6 h29.6 l1.4 1.4 v30 l-1.4 1.4 h-29.6 l-1.4 -1.4 v-30 z" fill="url(#rd-metal)" filter="url(#rd-brushed)" />
      <text className="rd-etch" x="7.8" y="13">{family}</text>
      <text className="rd-etch strong" x="7.8" y="18.4">{model.toUpperCase()}</text>
      {clock && <text className="rd-etch" x="7.8" y="23.4">{clock}</text>}
    </svg>
  );
}

// A memory stick standing in its slot, gold edge down into it; or the empty
// slot; or, for a stick no longer detected, its outline in red.
export function StickArt({ part, gb }: { part: HwPart | undefined; gb: string }) {
  const filled = !!part?.bytes;
  const missing = part?.health === "bad" && !filled;
  return (
    <svg className="rd" viewBox="0 0 40 140" role="img" aria-label={filled ? `${gb} stick` : missing ? "Missing stick" : "Empty slot"}>
      <rect x="2" y="0" width="36" height="140" rx="4" className="rd-slot" />
      <rect x="0" y="0" width="40" height="8" rx="2" className="rd-latch" />
      <rect x="0" y="132" width="40" height="8" rx="2" className="rd-latch" />
      {filled ? (
        <g>
          <rect x="6" y="8" width="28" height="124" rx="1.2" fill="url(#rd-pcb)" />
          <rect x="6" y="10" width="4" height="58" fill="url(#rd-fingers-v)" />
          <rect x="6" y="72" width="4" height="58" fill="url(#rd-fingers-v)" />
          {Array.from({ length: 8 }, (_, c) => <rect key={c} x="14" y={14 + c * 14 + (c > 3 ? 4 : 0)} width="13" height="10" rx=".6" fill="url(#rd-chip)" />)}
          <rect x="29" y="38" width="4" height="64" rx=".6" fill="#f2f3f5" />
          <text className="rd-stick" transform="rotate(-90 31 70)" x="31" y="71.4">{gb}</text>
        </g>
      ) : (
        <text className={"rd-empty" + (missing ? " bad" : "")} transform="rotate(-90 20 70)" x="20" y="72">{missing ? "Missing" : "Empty"}</text>
      )}
    </svg>
  );
}

// A graphics card face on: its shroud and fans, bracket, and gold edge.
export function CardArt({ part }: { part: HwPart }) {
  const length = cardLength(part.name);
  const fans = length >= 300 ? 3 : 2;
  const speed = part.readings.find((r) => r.label === "Fan")?.value ?? 0;
  const period = speed > 0 ? Math.min(4, Math.max(0.4, 40 / speed)) : 0;
  const pitch = (length - 30) / fans;
  return (
    <svg className="rd" viewBox={`0 0 ${length} 112`} role="img" aria-label={part.name}>
      <rect x="0" y="0" width="4" height="112" fill="url(#rd-steel)" />
      {Array.from({ length: 6 }, (_, i) => <rect key={i} x="1" y={14 + i * 12} width="2" height="7" rx="1" fill="#5b6168" />)}
      <rect x="4" y="2" width={length - 4} height="100" rx="5" fill="url(#rd-shroud)" />
      <rect x="18" y="102" width="70" height="7" fill="url(#rd-fingers-h)" />
      {Array.from({ length: fans }, (_, i) => {
        const cx = 22 + pitch * (i + 0.5);
        return (
          <g key={i}>
            <circle cx={cx} cy="52" r="44" fill="#0b0c0e" />
            <circle cx={cx} cy="52" r="44" fill="none" stroke="#3f444b" strokeWidth="1.4" />
            <Blades cx={cx} cy={52} r={42} period={period} blades={9} />
            <circle cx={cx} cy="52" r="12" fill="url(#rd-hub)" />
          </g>
        );
      })}
      <text className="rd-brand" x="12" y="12">{/radeon|rx\s?\d/i.test(part.name) ? "RADEON" : "GEFORCE"} {short(part.name).replace(/^GeForce\s+/i, "").toUpperCase()}</text>
    </svg>
  );
}

export function DriveArt({ part }: { part: HwPart }) {
  const kind = fact(part, "Kind");
  if (/nvme/i.test(kind)) {
    return (
      <svg className="rd" viewBox="0 0 80 22" role="img" aria-label={part.name}>
        <path d="M0 0 H77.5 a2.5 2.5 0 0 1 0 5 v12 a2.5 2.5 0 0 1 0 5 H0 V13.5 h1.4 v-1.6 H0 Z" fill="url(#rd-pcb-dark)" />
        <rect x="0" y="1" width="3.6" height="20" fill="url(#rd-fingers-h)" />
        <rect x="8" y="3" width="15" height="16" rx=".5" fill="url(#rd-chip)" />
        <rect x="27" y="3" width="13" height="16" rx=".5" fill="url(#rd-chip)" />
        <rect x="44" y="2.5" width="28" height="17" rx=".5" fill="#f2f3f5" />
        <text className="rd-label small" x="58" y="12.4">NVMe</text>
      </svg>
    );
  }
  if (/hdd/i.test(kind)) {
    return (
      <svg className="rd" viewBox="0 0 147 101.6" role="img" aria-label={part.name}>
        <rect x="0" y="0" width="147" height="101.6" rx="4" fill="url(#rd-metal)" filter="url(#rd-brushed)" />
        <circle cx="92" cy="50.8" r="43" fill="none" stroke="#8b929a" strokeWidth="1.2" />
        <circle cx="92" cy="50.8" r="9" fill="#a3aab2" />
        <rect x="8" y="12" width="44" height="77" rx="2" fill="#f2f3f5" />
        <text className="rd-label" x="30" y="53">HDD</text>
      </svg>
    );
  }
  return (
    <svg className="rd" viewBox="0 0 100 69.85" role="img" aria-label={part.name}>
      <rect x="0" y="0" width="100" height="69.85" rx="3" fill="url(#rd-metal)" filter="url(#rd-brushed)" />
      <rect x="11" y="13" width="78" height="44" rx="2" fill="#f2f3f5" />
      <text className="rd-label big" x="50" y="34">{short(part.name).slice(0, 18)}</text>
      <text className="rd-label" x="50" y="44">{fact(part, "Size")}</text>
    </svg>
  );
}

export function PsuArt() {
  return (
    <svg className="rd" viewBox="0 0 150 86" role="img" aria-label="Power supply">
      <rect x="0" y="0" width="150" height="86" rx="4" fill="#1d1f22" />
      <circle cx="96" cy="43" r="38" fill="url(#rd-grill)" />
      <circle cx="96" cy="43" r="38" fill="none" stroke="#3a3e44" strokeWidth="1.6" />
      <circle cx="96" cy="43" r="10" fill="url(#rd-hub)" />
      <rect x="10" y="10" width="34" height="66" rx="2" fill="#141518" />
    </svg>
  );
}

// A fan, turning at its measured speed; one never connected stays still and dim.
export function FanArt({ rpm, connected }: { rpm: number; connected: boolean }) {
  const period = rpm > 0 ? Math.min(4, Math.max(0.35, 600 / rpm)) : 0;
  return (
    <svg className={"rd" + (connected ? "" : " rd-off")} viewBox="0 0 120 120" role="img" aria-label={connected ? `Fan at ${Math.round(rpm)} RPM` : "Nothing connected"}>
      <rect x="0" y="0" width="120" height="120" rx="12" fill="#17191c" />
      {[[9, 9], [111, 9], [9, 111], [111, 111]].map(([x, y]) => <circle key={`${x}${y}`} cx={x} cy={y} r="3.2" fill="#08090a" />)}
      <circle cx="60" cy="60" r="56" fill="#0b0c0e" />
      <Blades cx={60} cy={60} r={54} period={connected ? period : 0} />
      <circle cx="60" cy="60" r="18" fill="url(#rd-hub)" />
    </svg>
  );
}
