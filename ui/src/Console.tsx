import { useEffect, useState } from "react";
import { api, bytes, type Container, type Flag, type Forward, type Hardware, type Health, type Metrics, type Route, type Status, type User } from "./api";
import { Chart } from "./charts";
import { Icon } from "./Icon";
import { useCan } from "./me";

// ConsolePage is the screen on the rack: this computer in one still frame,
// read at a glance from across the room, like a KVM's monitor. A band that
// says whether all is well, four gauges, the last five minutes, every service
// as a tile lit by its state, and what needs attention. It fills the screen,
// never scrolls and refreshes on its own.

const failing = (h?: Health) => h === "warn" || h === "bad";
const level = (share: number, warn = 0.75, bad = 0.9) => (share >= bad ? "bad" : share >= warn ? "warn" : "ok");
const rate = (n: number) => `${bytes(n)}/s`;

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

function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
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
  const now = useNow();

  const h = m?.history ?? [];
  const last = h[h.length - 1];
  const total = m?.memory_total || 1;
  const disk = (m?.disks ?? []).reduce((a, d) => ({ total: a.total + d.total, free: a.free + d.available }), { total: 0, free: 0 });
  const snap = hw?.snapshot ?? null;

  // Every service as a tile: the containers, then the routes to ports here.
  const tunnels = routes ?? [];
  const offline = tunnels.some((r) => r.enabled) && status !== null && !status.connections;
  const tiles: { key: string; name: string; sub: string; tone: string }[] = [
    ...(list ?? []).filter((c) => !c.own).map((c) => ({
      key: c.id, name: c.name, sub: c.state,
      tone: c.state === "running" ? "ok" : c.state === "dead" || c.state === "exited" ? "bad" : "warn",
    })),
    ...tunnels.filter((r) => r.target_scheme !== "dashboard").map((r) => ({
      key: r.id, name: r.hostname, sub: r.enabled ? (offline ? "offline" : "live") : "off", tone: !r.enabled ? "" : offline ? "bad" : "ok",
    })),
    ...(forwards ?? []).map((f) => ({
      key: f.id, name: f.name || `Port ${f.public_port}`, sub: f.enabled ? (f.problem ? "failed" : "open") : "closed", tone: !f.enabled ? "" : f.problem ? "bad" : "ok",
    })),
  ];

  const nameOf = (id: string) => users.find((u) => u.id === id)?.username ?? "an account";
  const alerts: { key: string; tone: Health; text: string }[] = [
    ...(offline ? [{ key: "connector", tone: "bad" as Health, text: "Cloudflare connector offline" }] : []),
    ...[...(snap?.parts ?? []), ...(snap?.notes ?? [])].filter((p) => failing(p.health))
      .map((p) => ({ key: p.id, tone: p.health, text: p.id.startsWith("note:") ? p.name : p.reason || p.name })),
    ...tiles.filter((t) => t.tone === "bad" || t.tone === "warn").map((t) => ({ key: "t" + t.key, tone: t.tone as Health, text: `${t.name} ${t.sub}` })),
    ...flags.map((f) => ({ key: "f" + f.id, tone: "warn" as Health, text: `New device for ${nameOf(f.user_id)}` })),
  ];
  const state = alerts.some((a) => a.tone === "bad") ? "bad" : alerts.length ? "warn" : "ok";
  const temp = last?.temp ?? null;
  const span = { times: h.map((x) => x.at), keep: m?.keep ?? 150, every: m?.every ?? 2, ticks: true };

  return (
    <div className={"kvm " + state}>
      <header className="kvm-band">
        <span className="kvm-host"><span className={"dot " + state} />{m?.host.name ?? "myTunnels"}</span>
        <b className="kvm-state">{state === "ok" ? "All systems normal" : `${alerts.length} ${alerts.length === 1 ? "needs" : "need"} attention`}</b>
        <span className="kvm-clock">
          {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          <small>{now.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}</small>
        </span>
        <a className="kvm-out" href="#/dashboard" aria-label="Open the dashboard" title="Open the dashboard"><Icon name="dashboard" size={18} /></a>
      </header>

      <section className="kvm-gauges">
        <Ring label="CPU" share={last ? last.cpu / 100 : 0} value={last ? `${Math.round(last.cpu)}%` : "–"} />
        <Ring label="Memory" share={last ? last.memory / total : 0} value={last ? `${Math.round((last.memory / total) * 100)}%` : "–"} sub={m ? bytes(m.memory_total) : ""} />
        {temp !== null
          ? <Ring label="Temperature" share={temp / 100} warn={0.75} bad={0.88} value={`${Math.round(temp)}°`} />
          : <Ring label="Load" share={m?.load && m.host.threads ? m.load[0] / m.host.threads : 0} value={m?.load ? m.load[0].toFixed(1) : "–"} />}
        <Ring label="Storage" share={disk.total ? 1 - disk.free / disk.total : 0} value={disk.total ? `${Math.round((1 - disk.free / disk.total) * 100)}%` : "–"} sub={disk.total ? `${bytes(disk.free)} free` : ""} />
        <div className="kvm-net">
          <span><Icon name="download" size={22} />{last ? rate(last.rx) : "–"}</span>
          <span><Icon name="upload" size={22} />{last ? rate(last.tx) : "–"}</span>
          <small>Network</small>
        </div>
      </section>

      <section className="kvm-chart">
        {h.length > 1 && <Chart {...span} max={100} format={(n) => `${Math.round(n)}%`} lines={[
          { label: "CPU", color: "var(--s1)", values: h.map((x) => x.cpu) },
          { label: "Memory", color: "var(--s2)", values: h.map((x) => (x.memory / total) * 100) },
        ]} />}
      </section>

      <section className="kvm-bottom">
        <div className="kvm-tiles">
          {tiles.map((t) => (
            <div key={t.key} className={"kvm-tile " + t.tone}>
              <b>{t.name}</b>
              <small>{t.sub}</small>
            </div>
          ))}
        </div>
        <ul className="kvm-alerts">
          {alerts.length === 0 && <li className="ok"><Icon name="check_circle" size={22} />Nothing needs attention</li>}
          {alerts.slice(0, 7).map((a) => <li key={a.key} className={a.tone}><Icon name={a.tone === "bad" ? "error" : "warning"} size={22} />{a.text}</li>)}
          {alerts.length > 7 && <li>and {alerts.length - 7} more</li>}
        </ul>
      </section>
    </div>
  );
}

// Ring is one gauge: a dial filled to `share`, coloured by how full it is,
// its figure in the middle and its name under it.
function Ring({ label, share, value, sub, warn = 0.75, bad = 0.9 }: { label: string; share: number; value: string; sub?: string; warn?: number; bad?: number }) {
  const r = 52;
  const round = 2 * Math.PI * r;
  const fill = Math.min(Math.max(share, 0), 1);
  return (
    <div className={"kvm-ring " + level(fill, warn, bad)}>
      <svg viewBox="0 0 120 120" aria-hidden>
        <circle className="kvm-track" cx="60" cy="60" r={r} />
        <circle className="kvm-arc" cx="60" cy="60" r={r} strokeDasharray={`${fill * round} ${round}`} transform="rotate(-90 60 60)" />
      </svg>
      <b>{value}</b>
      <span>{label}{sub && <small>{sub}</small>}</span>
    </div>
  );
}
