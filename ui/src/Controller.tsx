import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { api, message, type Fan } from "./api";
import { Icon } from "./Icon";
import { Callout, Switch, useNotify } from "./ui";

// ControllerPage is Device Controller: the host's fans, each spinning as fast
// as it turns, with its speed set by hand from a slider or handed back to the
// firmware with Auto.
export function ControllerPage() {
  const [fans, setFans] = useState<Fan[] | null>(null);
  const [problem, setProblem] = useState("");
  // Speeds being dragged, kept over the readings until they are set.
  const [drafts, setDrafts] = useState<Record<string, number>>({});
  const timers = useRef<Record<string, number>>({});
  const notify = useNotify();

  const load = useCallback(async () => {
    try {
      setFans(await api.fans());
      setProblem("");
    } catch (e) {
      setProblem(message(e));
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [load]);

  const apply = async (fan: Fan, auto: boolean, speed: number) => {
    try {
      const next = await api.setFan(fan.id, auto, speed);
      setFans((all) => all?.map((f) => (f.id === next.id ? next : f)) ?? null);
    } catch (e) {
      notify(message(e), "bad");
    } finally {
      setDrafts((d) => Object.fromEntries(Object.entries(d).filter(([id]) => id !== fan.id)));
    }
  };
  // A drag sets the speed once it rests.
  const drag = (fan: Fan, speed: number) => {
    setDrafts((d) => ({ ...d, [fan.id]: speed }));
    clearTimeout(timers.current[fan.id]);
    timers.current[fan.id] = window.setTimeout(() => apply(fan, false, speed), 300);
  };

  const manual = fans?.filter((f) => f.mode === "manual" || f.mode === "full").length ?? 0;
  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Device Controller</h1>
          {fans && fans.length > 0 && (
            <div className="page-sub">
              <span><b>{fans.length}</b> fan{fans.length === 1 ? "" : "s"}</span>
              {manual > 0 && <span><b>{manual}</b> set by hand</span>}
            </div>
          )}
        </div>
      </div>
      <div className="page-body stack">
        {problem && <Callout tone="bad" icon="error">{problem}</Callout>}
        {fans && fans.length === 0 && (
          <div className="card welcome">
            <Icon name="mode_fan" size={40} />
            <h2>No fans found</h2>
            <p className="muted">The host's chips report no fans.</p>
          </div>
        )}
        {fans && fans.length > 0 && (
          <div className="card">
            <ul className="results">
              {fans.map((fan) => {
                const speed = drafts[fan.id] ?? fan.speed ?? 0;
                const spin = fan.rpm ? { "--spin": `${Math.max(0.2, 1800 / fan.rpm).toFixed(2)}s` } as CSSProperties : undefined;
                return (
                  <li key={fan.id} className="fan-row">
                    <span className={"fan-spin" + (fan.rpm ? " on" : "")} style={spin}><Icon name="mode_fan" size={26} /></span>
                    <span className="device-name">
                      <span className="scan-target">{fan.label}</span>
                      <small>{fan.chip}</small>
                    </span>
                    <span className="fan-rpm">{fan.rpm === null ? "No reading" : <><b>{fan.rpm}</b> RPM</>}</span>
                    {fan.mode === "none" ? <span className="fan-fixed muted">Read only</span> : (
                      <>
                        <label className="fan-speed">
                          <input type="range" min={0} max={100} step={1} value={speed} aria-label={`${fan.label} speed`}
                            onChange={(e) => drag(fan, Number(e.target.value))} />
                          <span className="mono">{speed}%</span>
                        </label>
                        <span className="fan-auto">
                          <span>Auto</span>
                          <Switch label={`${fan.label} on auto`} on={fan.mode === "auto"} onChange={(on) => apply(fan, on, speed)} />
                        </span>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </>
  );
}
