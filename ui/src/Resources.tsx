import { useEffect, useState } from "react";
import { api, bytes, message, type Limits, type Resources as Res } from "./api";
import { Dropdown, type Option } from "./Dropdown";
import { Callout, Card, Row, useNotify } from "./ui";

const MB = 1024 ** 2;
const GB = 1024 ** 3;
const SIZES = [128 * MB, 256 * MB, 512 * MB, GB, 2 * GB, 4 * GB, 8 * GB, 16 * GB, 32 * GB, 64 * GB, 128 * GB];
const CPUS = [0.25, 0.5, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];
const PIDS = [64, 128, 256, 512, 1024, 2048, 4096, 16384];
const RETRIES = [0, 1, 3, 5, 10];

const cpus = (n: number) => `${n} CPU${n === 1 ? "" : "s"}`;

// The choices, with the value it has now added when it is none of them, such
// as one set outside myTunnels.
function and<T extends number>(options: Option<T>[], value: T, label: (v: T) => string): Option<T>[] {
  return options.some((o) => o.value === value) ? options : [...options, { value, label: label(value) }];
}

// Resources is how much of the machine a container may use and how it
// restarts. Each change applies at once and stays when the container is made
// again.
export function Resources({ id, editable }: { id: string; editable: boolean }) {
  const [r, setR] = useState<Res | null>(null);
  const [problem, setProblem] = useState("");
  const notify = useNotify();
  useEffect(() => {
    api.limits(id).then(setR).catch((e) => setProblem(message(e)));
  }, [id]);
  if (problem) return <Callout tone="bad" icon="error">{problem}</Callout>;
  if (!r) return <div className="repo-loading"><span className="spinner" /></div>;

  const l = r.limits;
  const save = async (patch: Partial<Limits>) => {
    try {
      setR(await api.setLimits(id, { ...l, ...patch }));
      notify("Saved");
    } catch (e) {
      notify(message(e), "bad");
    }
  };
  const pick = <T extends string | number>(label: string, value: T, options: Option<T>[], onChange: (v: T) => void) => (
    <Row title={label}>
      {editable
        ? <Dropdown label={label} value={value} options={options} onChange={onChange} />
        : <span>{(options.find((o) => o.value === value) ?? options[0]).label}</span>}
    </Row>
  );
  const sizes = (below: number) => SIZES.filter((s) => s < below).map((s) => ({ value: s, label: bytes(s) }));

  return (
    <>
      <Card title="CPU">
        {pick("Limit", l.cpus, and([{ value: 0, label: "No limit", hint: `All ${cpus(r.cpus)}` }, ...CPUS.filter((c) => c < r.cpus).map((c) => ({ value: c, label: cpus(c) }))], l.cpus, cpus),
          (v) => save({ cpus: v }))}
        {pick("Priority", l.priority, [
          { value: "low", label: "Low", hint: "Gives way when the processors are busy" },
          { value: "normal", label: "Normal" },
          { value: "high", label: "High", hint: "Goes first when the processors are busy" },
        ], (v) => save({ priority: v }))}
      </Card>
      <Card title="Memory">
        {pick("Limit", l.memory, and([{ value: 0, label: "No limit", hint: `All ${bytes(r.memory)}` }, ...sizes(r.memory)], l.memory, bytes),
          (v) => save({ memory: v, reserve: v && l.reserve > v ? 0 : l.reserve }))}
        {pick("Reserved", l.reserve, and([{ value: 0, label: "None", hint: "What it keeps when memory runs short" }, ...sizes(l.memory || r.memory)], l.reserve, bytes),
          (v) => save({ reserve: v }))}
        {l.memory > 0 && pick("Swap", l.swap, and([{ value: -1, label: "No limit" }, { value: 0, label: "None" }, ...sizes(r.memory)], l.swap, bytes),
          (v) => save({ swap: v }))}
      </Card>
      <Card title="Stability">
        {pick("Restart", l.restart, [
          { value: "no", label: "Never" },
          { value: "on-failure", label: "When it fails" },
          { value: "unless-stopped", label: "Unless stopped" },
          { value: "always", label: "Always" },
        ], (v) => save({ restart: v }))}
        {l.restart === "on-failure" && pick("Tries", l.retries, and(RETRIES.map((n) => ({ value: n, label: n ? String(n) : "No end" })), l.retries, String),
          (v) => save({ retries: v }))}
        {pick("Processes", l.pids, and([{ value: 0, label: "No limit" }, ...PIDS.map((n) => ({ value: n, label: String(n) }))], l.pids, String),
          (v) => save({ pids: v }))}
      </Card>
    </>
  );
}
