import { useEffect, useState } from "react";
import { Alerts, type Alert } from "./Alerts";
import { api, bytes, type Container, type Metrics } from "./api";
import { Chart } from "./charts";
import { Icon } from "./Icon";
import { useCan } from "./me";

// ConsolePage is this computer on the rack's monitor: one still frame that
// fills the screen exactly and never scrolls. A slim bar with its name, the
// time, the alerts and the way back; then six panels: CPU, memory and network
// over the last five minutes, the drives, the containers and what needs
// attention. Each list shows what fits and says how many more there are.

const pct = (n: number) => `${n < 10 ? n.toFixed(1) : Math.round(n)}%`;
const rate = (n: number) => `${bytes(n)}/s`;

// The rows a panel holds: its share of the screen's height, at 30px a row.
function useRows() {
  const fit = () => Math.max(3, Math.floor((innerHeight - 48 - 36) / 2 / 30) - 2);
  const [rows, setRows] = useState(fit);
  useEffect(() => {
    const on = () => setRows(fit());
    addEventListener("resize", on);
    return () => removeEventListener("resize", on);
  }, []);
  return rows;
}

function uptime(s: number) {
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  return d ? `up ${d}d ${h}h` : `up ${h}h ${Math.floor((s % 3600) / 60)}m`;
}

export function ConsolePage({ alerts }: { alerts: Alert[] }) {
  const can = useCan();
  const seeContainers = can("containers.view");
  const rows = useRows();
  const [m, setM] = useState<Metrics | null>(null);
  const [list, setList] = useState<Container[] | null>(null);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let alive = true;
    let timer = 0;
    const load = () => api.metrics().then((next) => {
      if (!alive) return;
      setM(next);
      timer = window.setTimeout(load, next.every * 1000);
    }, () => {
      timer = window.setTimeout(load, 5000);
    });
    load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    if (!seeContainers) return;
    const load = () => api.containers().then(setList).catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [seeContainers]);
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(t);
  }, []);

  const h = m?.history ?? [];
  const last = h[h.length - 1];
  const total = m?.memory_total || 1;
  const span = { times: h.map((s) => s.at), keep: m?.keep ?? 150, every: m?.every ?? 2 };
  const peak = Math.max(1, ...h.map((s) => Math.max(s.rx, s.tx)));
  const disks = [...(m?.disks ?? [])].sort((a, b) => b.total - a.total);
  // Stopped containers first, since they are the ones to see.
  const containers = [...(list ?? [])].filter((c) => !c.own).sort((a, b) => Number(a.state === "running") - Number(b.state === "running") || a.name.localeCompare(b.name));
  const running = containers.filter((c) => c.state === "running").length;
  const urgent = alerts.filter((a) => a.tone !== "info");

  return (
    <div className="console">
      <header className="console-bar">
        <span className="brand-mark"><Icon name="public" size={16} /></span>
        <b>{m?.host.name ?? "myTunnels"}</b>
        {m && <span className="console-quiet">{[m.host.os, uptime(m.uptime)].filter(Boolean).join(" · ")}</span>}
        <span className="console-gap" />
        <span className="console-time">{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        <span className="console-quiet">{now.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}</span>
        <Alerts alerts={alerts} />
        <a className="icon-btn" href="#/dashboard" aria-label="Close the console" title="Close the console"><Icon name="close" /></a>
      </header>

      <div className="console-grid">
        <section className="console-cell">
          <div className="console-head"><h2>CPU</h2><span>{last ? pct(last.cpu) : ""}{last?.temp != null ? ` · ${Math.round(last.temp)}°C` : ""}</span></div>
          {h.length > 1 && <Chart {...span} max={100} format={pct} lines={[{ label: "CPU", color: "var(--s1)", values: h.map((s) => s.cpu) }]} />}
        </section>

        <section className="console-cell">
          <div className="console-head"><h2>Memory</h2><span>{last ? `${bytes(last.memory)} of ${bytes(total)}` : ""}</span></div>
          {h.length > 1 && <Chart {...span} max={100} format={pct} lines={[{ label: "In use", color: "var(--s2)", values: h.map((s) => (s.memory / total) * 100) }]} />}
        </section>

        <section className="console-cell">
          <div className="console-head"><h2>Network</h2><span>{last ? `↓ ${rate(last.rx)}  ↑ ${rate(last.tx)}` : ""}</span></div>
          {h.length > 1 && <Chart {...span} max={peak} format={rate} lines={[
            { label: "In", color: "var(--s1)", values: h.map((s) => s.rx) },
            { label: "Out", color: "var(--s3)", values: h.map((s) => s.tx) },
          ]} />}
        </section>

        <section className="console-cell">
          <div className="console-head"><h2>Drives</h2><span>{disks.length ? `${bytes(disks.reduce((n, d) => n + d.available, 0))} free` : ""}</span></div>
          <ul className="console-list">
            {disks.slice(0, rows).map((d) => {
              const share = d.total ? (d.total - d.available) / d.total : 0;
              return (
                <li key={d.mount}>
                  <span className="console-name mono">{d.mount}</span>
                  <small>{bytes(d.total - d.available)} of {bytes(d.total)}</small>
                  <span className={"meter " + (share >= 0.9 ? "bad" : share >= 0.75 ? "warn" : "")}><span style={{ width: share * 100 + "%" }} /></span>
                </li>
              );
            })}
            {disks.length > rows && <li><small>and {disks.length - rows} more</small></li>}
          </ul>
        </section>

        <section className="console-cell">
          <div className="console-head"><h2>Containers</h2><span>{list ? `${running} of ${containers.length} running` : ""}</span></div>
          <ul className="console-list">
            {containers.slice(0, rows).map((c) => {
              const tone = c.state === "running" ? "ok" : c.state === "dead" ? "bad" : c.state === "exited" ? "" : "warn";
              return (
                <li key={c.id}>
                  <span className={"dot " + tone} />
                  <span className="console-name">{c.name}</span>
                  <small>{c.state === "exited" ? "stopped" : c.state}</small>
                </li>
              );
            })}
            {containers.length > rows && <li><small>and {containers.length - rows} more</small></li>}
          </ul>
        </section>

        <section className="console-cell">
          <div className="console-head"><h2>Needs attention</h2><span>{urgent.length || ""}</span></div>
          <ul className="console-list">
            {alerts.length === 0 && <li><Icon name="check_circle" size={18} className="ok-icon" /><span className="console-name">Nothing</span></li>}
            {alerts.slice(0, rows).map((a) => (
              <li key={a.key} className={a.tone}>
                <Icon name={a.icon} size={18} />
                <span className="console-name">{a.title}</span>
              </li>
            ))}
            {alerts.length > rows && <li><small>and {alerts.length - rows} more</small></li>}
          </ul>
        </section>
      </div>
    </div>
  );
}
