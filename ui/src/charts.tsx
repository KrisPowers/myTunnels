import { useRef, useState, type PointerEvent } from "react";

// Charts the Dashboard and a container's page share: a line chart over the
// kept window, a small one for table rows, and a bar for a share of something.

interface Span {
  times: number[];
  keep: number;
  every: number;
}

// Points sit in fixed slots, the newest at the right edge, so a short history
// grows in from the right. Each new sample slides the line one slot left over
// the sampling interval, so it moves steadily instead of jumping.
function geometry(keep: number, values: (number | null)[], max: number) {
  const offset = keep - values.length;
  const y = (v: number) => 100 - Math.min(Math.max(v / (max || 1), 0), 1) * 94;
  let line = "";
  let start = -1;
  let end = -1;
  values.forEach((v, i) => {
    if (v === null) return;
    const x = offset + i;
    line += (start < 0 || values[i - 1] === null ? "M" : "L") + x + "," + y(v).toFixed(2);
    if (start < 0) start = x;
    end = x;
  });
  const area = start < 0 ? "" : `${line}L${end},100L${start},100Z`;
  return { line, area, y, offset };
}

export function Spark({ values, max, color, keep, times, every }: Span & { values: (number | null)[]; max: number; color: string }) {
  const { line, area } = geometry(keep, values, max);
  return (
    <svg className="spark" viewBox={`1 0 ${keep - 2} 100`} preserveAspectRatio="none" style={{ color }} aria-hidden="true">
      <g key={times[times.length - 1]} className={every ? "slide" : undefined} style={{ animationDuration: every + "s" }}>
        <path className="spark-area" d={area} />
        <path className="spark-line" d={line} />
      </g>
    </svg>
  );
}

export interface Line {
  label: string;
  color: string;
  values: (number | null)[];
}

// Chart is a line chart over the kept window, with gridlines at the top and
// middle, and a crosshair with every line's value under the pointer. With
// `ticks`, each minute gets an upright line and its time under the chart.
export function Chart({ lines, max, format, times, keep, every, ticks }: Span & { lines: Line[]; max: number; format: (n: number) => string; ticks?: boolean }) {
  const plot = useRef<HTMLDivElement>(null);
  const [slot, setSlot] = useState<number | null>(null);
  const shapes = lines.map((l) => geometry(keep, l.values, max));
  const { y, offset } = shapes[0];
  const left = (s: number) => `${((s - 1) / (keep - 2)) * 100}%`;

  const move = (e: PointerEvent) => {
    const box = plot.current?.getBoundingClientRect();
    if (!box) return;
    const s = Math.round(1 + ((e.clientX - box.left) / box.width) * (keep - 2));
    setSlot(s >= offset ? Math.min(s, keep - 1) : null);
  };
  const i = slot === null ? -1 : slot - offset;
  const end = times[times.length - 1] ?? 0;
  const marks: number[] = [];
  if (ticks && every && end) {
    for (let t = Math.ceil((end - (keep - 2) * every) / 60) * 60; t <= end; t += 60) marks.push(t);
  }
  const slotOf = (t: number) => keep - 1 - (end - t) / every;
  const at = (t: number) => left(slotOf(t));
  // A mark within a tenth of an edge leans inward, so its time is not cut off.
  const lean = (t: number) => {
    const f = (slotOf(t) - 1) / (keep - 2);
    return f < 0.1 ? "start" : f > 0.9 ? "end" : undefined;
  };

  return (
    <div className="chart">
      <div className="chart-plot" ref={plot} onPointerMove={move} onPointerLeave={() => setSlot(null)}>
        {[1, 0.5].map((f) => (
          <div key={f} className="chart-grid" style={{ top: y(max * f) + "%" }}><span>{format(max * f)}</span></div>
        ))}
        <div className="chart-grid base" />
        {marks.map((t) => <div key={t} className="chart-vgrid" style={{ left: at(t) }} />)}
        <svg viewBox={`1 0 ${keep - 2} 100`} preserveAspectRatio="none" aria-hidden="true">
          <g key={times[times.length - 1]} className="slide" style={{ animationDuration: every + "s" }}>
            {lines.map((l, n) => (
              <g key={l.label} style={{ color: l.color }}>
                {lines.length === 1 && <path className="chart-area" d={shapes[n].area} />}
                <path className="chart-line" d={shapes[n].line} />
              </g>
            ))}
          </g>
        </svg>
        {slot !== null && i >= 0 && (
          <>
            <div className="chart-cross" style={{ left: left(slot) }} />
            {lines.map((l) => {
              const v = l.values[i];
              return v === null || v === undefined ? null : (
                <span key={l.label} className="chart-dot" style={{ left: left(slot), top: y(v) + "%", background: l.color }} />
              );
            })}
            <div className={"chart-tip" + (slot > keep * 0.6 ? " flip" : "")} style={{ left: left(slot) }}>
              <div className="chart-tip-time">{clock(times[i])}</div>
              {lines.map((l) => {
                const v = l.values[i];
                return (
                  <div key={l.label} className="chart-tip-row">
                    <i style={{ background: l.color }} />
                    <span>{l.label}</span>
                    <b>{v === null || v === undefined ? "None" : format(v)}</b>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
      {ticks ? (
        <div className="chart-axis ticks">
          {marks.map((t) => <span key={t} className={lean(t)} style={{ left: at(t) }}>{clock(t, true)}</span>)}
        </div>
      ) : (
        <div className="chart-axis">
          <span>{Math.round((keep * every) / 60)} min ago</span>
          <span>Now</span>
        </div>
      )}
    </div>
  );
}

export function Meter({ value, max, label, tone }: { value: number; max: number; label: string; tone?: string }) {
  const share = max > 0 ? Math.min(value / max, 1) : 0;
  const level = tone ?? (share >= 0.9 ? "bad" : share >= 0.75 ? "warn" : "");
  return (
    <span className="meter-cell">
      <span className={"meter " + level}><span style={{ width: share * 100 + "%" }} /></span>
      <span className="num">{label}</span>
    </span>
  );
}

function clock(at: number, short?: boolean) {
  return new Date(at * 1000).toLocaleTimeString([], short ? { hour: "numeric", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
