import { useEffect, useState } from "react";
import { api, bytes, type Container, type Flag, type Forward, type Hardware, type Health, type Metrics, type Route, type Status, type User } from "./api";
import { Spark } from "./charts";
import { Icon } from "./Icon";
import { useCan } from "./me";

// ConsolePage is this computer at a glance, for a monitor on the rack: one
// still frame that fills the screen and never scrolls, read from across the
// room. The figures that matter now, what this computer hosts and how it is
// reached, its storage, and anything that needs attention. It refreshes on
// its own; the desktop app opens on it.

const pct = (n: number) => `${Math.round(n)}%`;
const rate = (n: number) => `${bytes(n)}/s`;
const failing = (h?: Health) => h === "warn" || h === "bad";

// Polls `load` every `every` seconds, keeping the last answer.
function usePoll<T>(load: () => Promise<T>, every: number, on = true) {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    if (!on) return;
    let alive = true;
    const run = () => load().then((v) => alive && setValue(v)).catch(() => {});
    run();
    const t = setInterval(run, every * 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [load, every, on]);
  return value;
}

const metrics = () => api.metrics();
const hardware = () => api.hardware();
const containers = () => api.containers();

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function ConsolePage({ routes, forwards, status, flags, users }: {
  routes: Route[] | null;
  forwards: Forward[] | null;
  status: Status | null;
  flags: Flag[];
  users: User[];
}) {
  const can = useCan();
  const m = usePoll<Metrics>(metrics, 2);
  const hw = usePoll<Hardware>(hardware, 5);
  const list = usePoll<Container[]>(containers, 5, can("containers.view"));
  const now = useClock();

  const snap = hw?.snapshot ?? null;
  const h = m?.history ?? [];
  const last = h[h.length - 1];
  const span = { times: h.map((s) => s.at), keep: m?.keep ?? 150, every: m?.every ?? 2 };

  // What needs attention: failing parts, the system log's notes, new devices.
  const parts = [...(snap?.parts ?? []), ...(snap?.notes ?? [])].filter((p) => failing(p.health));
  const nameOf = (id: string) => users.find((u) => u.id === id)?.username ?? "an account";
  const down = (list ?? []).filter((c) => !c.own && c.state !== "running");
  const broken = (forwards ?? []).filter((f) => f.enabled && f.problem);
  const tunnels = (routes ?? []).filter((r) => r.enabled);
  const offline = tunnels.length > 0 && status !== null && !status.connections;
  const attention: { key: string; health: Health; text: string }[] = [
    ...(offline ? [{ key: "connector", health: "bad" as Health, text: "Cloudflare connector offline" }] : []),
    ...parts.map((p) => ({ key: p.id, health: p.health, text: p.id.startsWith("note:") ? p.name : p.reason || p.name })),
    ...down.map((c) => ({ key: "c" + c.id, health: (c.state === "dead" ? "bad" : "warn") as Health, text: `${c.name} is ${c.state}` })),
    ...broken.map((f) => ({ key: "f" + f.id, health: "bad" as Health, text: `${f.name || `Port ${f.public_port}`}: ${f.problem}` })),
    ...flags.map((f) => ({ key: "n" + f.id, health: "warn" as Health, text: `New device for ${nameOf(f.user_id)}${f.country ? `, ${f.country}` : ""}` })),
  ];
  const state: Health = attention.some((a) => a.health === "bad") ? "bad" : attention.length ? "warn" : "ok";

  const running = (list ?? []).filter((c) => c.state === "running").length;
  const total = list?.length ?? 0;
  const disks = [...(m?.disks ?? [])].sort((a, b) => b.total - a.total).slice(0, 4);
  const events = [...(snap?.events ?? [])].sort((a, b) => b.at - a.at).slice(0, 5);
  const tempNow = last?.temp ?? null;

  return (
    <div className="glance">
      <header className="glance-top">
        <span className="brand-mark"><Icon name="public" size={18} /></span>
        <h1>{m?.host.name ?? "myTunnels"}</h1>
        <span className={"glance-state " + state}>
          <span className={"dot " + state} />
          {state === "ok" ? "All good" : `${attention.length} need${attention.length === 1 ? "s" : ""} attention`}
        </span>
        <span className="glance-clock">
          <b>{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</b>
          {now.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}
        </span>
        <a className="icon-btn" href="#/" aria-label="Open the dashboard" title="Open the dashboard"><Icon name="dashboard" /></a>
      </header>

      <section className="glance-figures">
        <Figure label="CPU" value={last ? pct(last.cpu) : ""} color="var(--s1)" values={h.map((s) => s.cpu)} max={100} span={span} />
        <Figure label="Memory" value={last && m ? pct((last.memory / (m.memory_total || 1)) * 100) : ""} sub={m ? `of ${bytes(m.memory_total)}` : ""}
          color="var(--s2)" values={h.map((s) => s.memory)} max={m?.memory_total ?? 1} span={span} />
        <Figure label="Network" value={last ? rate(last.rx) : ""} sub={last ? `out ${rate(last.tx)}` : ""} color="var(--s1)"
          values={h.map((s) => s.rx)} max={Math.max(1, ...h.map((s) => Math.max(s.rx, s.tx)))} span={span} />
        {tempNow !== null
          ? <Figure label="Temperature" value={`${Math.round(tempNow)}°C`} color="var(--s3)" values={h.map((s) => s.temp)} max={100} span={span} />
          : <Figure label="Uptime" value={m ? uptime(m.uptime) : ""} sub={m?.load ? `load ${m.load[0].toFixed(2)}` : ""} />}
      </section>

      <section className="glance-panels">
        <div className="glance-panel">
          <h2>Services</h2>
          <p className="glance-big"><b>{running}</b><span>of {total} running</span></p>
          <ul className="glance-list">
            {down.slice(0, 5).map((c) => <li key={c.id}><span className="dot warn" />{c.name}<small>{c.state}</small></li>)}
            {down.length === 0 && total > 0 && <li><span className="dot ok" />Every container is up</li>}
          </ul>
        </div>
        <div className="glance-panel">
          <h2>Reached from outside</h2>
          <ul className="glance-list">
            <li><span className={"dot " + (offline ? "bad" : status?.connections ? "ok" : "")} />Cloudflare<small>{status?.configured ? status.connections ? `${status.connections} connections` : "offline" : "not connected"}</small></li>
            <li><span className="dot plain" />Tunnels<small>{tunnels.length} live</small></li>
            <li><span className={"dot " + (broken.length ? "bad" : "plain")} />Ports and Tailscale<small>{(forwards ?? []).filter((f) => f.enabled && !f.problem).length} open</small></li>
          </ul>
        </div>
        <div className="glance-panel">
          <h2>Storage</h2>
          <ul className="glance-list">
            {disks.map((d) => {
              const used = d.total - d.available;
              const share = d.total ? used / d.total : 0;
              return (
                <li key={d.mount} className="glance-disk">
                  <span className="glance-disk-name">{d.mount}<small>{bytes(d.available)} free</small></span>
                  <span className={"meter" + (share >= 0.9 ? " bad" : share >= 0.75 ? " warn" : "")}><span style={{ width: share * 100 + "%" }} /></span>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      <section className="glance-panels two">
        <div className="glance-panel">
          <h2>Needs attention</h2>
          <ul className="glance-list">
            {attention.slice(0, 6).map((a) => <li key={a.key}><span className={"dot " + a.health} />{a.text}</li>)}
            {attention.length === 0 && <li><span className="dot ok" />Nothing</li>}
            {attention.length > 6 && <li className="muted">and {attention.length - 6} more</li>}
          </ul>
        </div>
        <div className="glance-panel">
          <h2>Recent events</h2>
          <ul className="glance-list">
            {events.map((e, i) => (
              <li key={i}><span className={"dot " + (failing(e.health) ? e.health : "ok")} />{e.text}<small>{when(e.at)}</small></li>
            ))}
            {events.length === 0 && <li><span className="dot ok" />None lately</li>}
          </ul>
        </div>
      </section>
    </div>
  );
}

// Figure is one big number with its last five minutes under it.
function Figure({ label, value, sub, color, values, max, span }: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
  values?: (number | null)[];
  max?: number;
  span?: { times: number[]; keep: number; every: number };
}) {
  return (
    <div className="glance-panel glance-figure">
      <h2>{label}</h2>
      <p className="glance-big"><b>{value}</b>{sub && <span>{sub}</span>}</p>
      {values && span && color && <Spark values={values} max={max ?? 100} color={color} {...span} />}
    </div>
  );
}

function uptime(s: number) {
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  return d ? `${d}d ${h}h` : `${h}h ${Math.floor((s % 3600) / 60)}m`;
}

function when(at: number) {
  const t = new Date(at * 1000);
  const today = new Date().toDateString() === t.toDateString();
  return today ? t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : t.toLocaleDateString([], { month: "short", day: "numeric" });
}
