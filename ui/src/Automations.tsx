import { useCallback, useEffect, useState } from "react";
import { ago, api, message, type Build, type Deploy, type FlowStep, type Updates } from "./api";
import { AddContainer, BuildLog, Builds, buildLabel, buildTone, DeploySettings, EVERY, sourceOf, updatesFor } from "./Builds";
import { Dropdown } from "./Dropdown";
import { Icon, type IconName } from "./Icon";
import { useCan } from "./me";
import { go } from "./route";
import { Callout, MoreMenu, SubNav, TextField, useNotify } from "./ui";

// Automations: each container built from a GitHub repository, or run from an
// image, and what keeps it current. A flow reads left to right as it runs:
// what starts it (a push, a release, a timer or Update), the build, the
// steps it must pass (tests run in the new image, reviews that wait for an
// approval), then going live. Builds waiting for review are approved or
// turned down at the top of the list.

const TRIGGER: Record<Updates, string> = { push: "On push", release: "On release", timer: "On a timer", manual: "By hand" };
const base = (id: string) => `#/automations/${encodeURIComponent(id)}`;

export function AutomationsPage({ id, tab, more }: { id: string; tab: string; more: string[] }) {
  if (id) return <Automation id={id} tab={tab} more={more} />;
  return <AutomationList />;
}

// What a flow does, in a few words: "Build, 2 tests, review, go live".
function summary(d: Deploy, steps: FlowStep[] | undefined) {
  const tests = (steps ?? []).filter((s) => s.kind === "test").length;
  const reviews = (steps ?? []).filter((s) => s.kind === "review").length;
  return [d.image ? "Pull" : "Build", tests && `${tests} ${tests === 1 ? "test" : "tests"}`, reviews && "review", "go live"].filter(Boolean).join(", ");
}

// ---- the list ----

function AutomationList() {
  const can = useCan();
  const notify = useNotify();
  const [list, setList] = useState<Deploy[] | null>(null);
  const [steps, setSteps] = useState<Record<string, FlowStep[]>>({});
  const [held, setHeld] = useState<{ d: Deploy; b: Build }[]>([]);
  const [problem, setProblem] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const all = await api.deploys();
      setList(all);
      setProblem("");
      const flows = await Promise.all(all.map((d) => api.flow(d.id).then((f) => [d.id, f.steps] as const).catch(() => [d.id, []] as const)));
      setSteps(Object.fromEntries(flows));
      const reviewing = all.filter((d) => d.latest?.status === "review");
      setHeld(reviewing.map((d) => ({ d, b: d.latest! })));
    } catch (e) {
      setProblem(message(e));
    }
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const decide = async (d: Deploy, b: Build, approve: boolean) => {
    try {
      await (approve ? api.approveBuild(d.id, b.number) : api.rejectBuild(d.id, b.number));
      notify(approve ? `Approved build ${b.number} of ${d.name}` : `Turned down build ${b.number} of ${d.name}`);
      await load();
    } catch (e) {
      notify(message(e), "bad");
    }
  };
  const runNow = async (d: Deploy) => {
    try {
      await api.buildNow(d.id);
      notify(`Running ${d.name}'s flow`);
      await load();
    } catch (e) {
      notify(message(e), "bad");
    }
  };

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Automations</h1>
          {list && <div className="page-sub"><span><b>{list.length}</b> {list.length === 1 ? "automation" : "automations"}</span>{held.length > 0 && <span><b>{held.length}</b> waiting for review</span>}</div>}
        </div>
        <div className="page-actions">
          {can("containers.deploy") && <button type="button" className="btn primary" onClick={() => setAdding(true)}><Icon name="add" size={18} />New automation</button>}
        </div>
      </div>
      <div className="page-body stack">
        {problem && <Callout tone="bad" icon="error">{problem}</Callout>}
        {held.length > 0 && (
          <section className="card review">
            <div className="card-head"><div className="card-titles"><h2>Waiting for review</h2></div></div>
            {held.map(({ d, b }) => (
              <div key={d.id + b.number} className="review-row">
                <a className="review-text" href={`${base(d.id)}/runs/build/${b.number}`}>
                  <b>{d.name}, build {b.number}</b>
                  <small>{b.message || b.commit.slice(0, 7)}</small>
                </a>
                {can("containers.deploy") && (
                  <>
                    <button type="button" className="btn small" onClick={() => decide(d, b, false)}>Turn down</button>
                    <button type="button" className="btn small primary" onClick={() => decide(d, b, true)}>Approve</button>
                  </>
                )}
              </div>
            ))}
          </section>
        )}
        {!list ? (!problem && <div className="repo-loading"><span className="spinner" /></div>) : list.length === 0 ? (
          <div className="card welcome">
            <Icon name="workflow" size={48} />
            <h2>Nothing is automated yet</h2>
            <p>Add a container from GitHub or an image, and every new release, push or timer runs it through its flow.</p>
            {can("containers.deploy") && <button type="button" className="btn primary" onClick={() => setAdding(true)}><Icon name="add" size={18} />New automation</button>}
          </div>
        ) : (
          <div className="card svc-card">
            <div className="table-wrap">
              <table className="table svc">
                <thead><tr><th className="grow">Container</th><th>Starts</th><th>Flow</th><th>Last run</th><th /></tr></thead>
                <tbody>
                  {list.map((d) => {
                    const last = d.latest;
                    return (
                      <tr key={d.id} className="svc-link" onClick={() => go(base(d.id))}>
                        <td>
                          <span className="svc-name">
                            <span className="svc-text"><b>{d.name}</b><small>{sourceOf(d)}{d.branch ? `, ${d.branch}` : ""}</small></span>
                          </span>
                        </td>
                        <td><span className="svc-way">{TRIGGER[d.updates]}</span></td>
                        <td><span className="svc-way">{summary(d, steps[d.id])}</span></td>
                        <td>{last ? <span className={"chip " + buildTone(last, d.current)}><span className={"dot " + buildTone(last, d.current)} />{buildLabel(last, d.current)}{last.finished_at ? ` · ${ago(last.finished_at)}` : ""}</span> : <span className="svc-way">Never</span>}</td>
                        <td className="svc-menu" onClick={(e) => e.stopPropagation()}>
                          <MoreMenu label={`Actions for ${d.name}`} actions={[
                            ...(can("containers.deploy") ? [{ label: "Run now", icon: "play_arrow" as IconName, onClick: () => runNow(d) }] : []),
                            { label: "Open the container", icon: "deployed_code", onClick: () => go(`#/containers/${encodeURIComponent(d.name)}`) },
                          ]} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
      {adding && <AddContainer onClose={() => setAdding(false)} onAdded={async (d) => {
        setAdding(false);
        go(base(d.id));
      }} />}
    </>
  );
}

// ---- one automation ----

const TABS: [string, string, IconName][] = [
  ["flow", "Flow", "workflow"],
  ["runs", "Runs", "history"],
  ["settings", "Settings", "settings"],
];

function Automation({ id, tab, more }: { id: string; tab: string; more: string[] }) {
  const can = useCan();
  const notify = useNotify();
  const [d, setD] = useState<Deploy | null>(null);
  const [problem, setProblem] = useState("");
  const load = useCallback(async () => {
    try {
      setD(await api.deploy(id));
      setProblem("");
    } catch (e) {
      setProblem(message(e));
    }
  }, [id]);
  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);
  if (!d) return problem ? <div className="page-body"><Callout tone="bad" icon="error">{problem}</Callout></div> : <div className="repo-loading"><span className="spinner" /></div>;
  const current = TABS.some(([k]) => k === tab) ? tab : "flow";
  const at = base(d.id);
  const review = (d.builds ?? []).find((b) => b.status === "review");
  const decide = async (approve: boolean) => {
    if (!review) return;
    try {
      setD(await (approve ? api.approveBuild(d.id, review.number) : api.rejectBuild(d.id, review.number)));
      notify(approve ? `Approved build ${review.number}` : `Turned down build ${review.number}`);
    } catch (e) {
      notify(message(e), "bad");
    }
  };
  const runNow = async () => {
    try {
      setD(await api.buildNow(d.id));
      notify("Running the flow");
    } catch (e) {
      notify(message(e), "bad");
    }
  };
  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>{d.name}</h1>
          <div className="page-sub">
            <span className="mono">{sourceOf(d)}{d.branch ? `, ${d.branch}` : ""}</span>
            <span>{TRIGGER[d.updates]}</span>
          </div>
        </div>
        <div className="page-actions">
          <a className="btn" href={`#/containers/${encodeURIComponent(d.name)}`}><Icon name="deployed_code" size={18} />Container</a>
          {can("containers.deploy") && <button type="button" className="btn primary" onClick={runNow}><Icon name="play_arrow" size={18} />Run now</button>}
        </div>
      </div>
      <SubNav back="#/automations" backLabel="Automations" base={at} items={TABS} current={current} />
      <div className="page-body stack" key={current}>
        {review && can("containers.deploy") && (
          <div className="review-row card">
            <a className="review-text" href={`${at}/runs/build/${review.number}`}><b>Build {review.number} is waiting for review</b><small>{review.message || review.commit.slice(0, 7)}</small></a>
            <button type="button" className="btn small" onClick={() => decide(false)}>Turn down</button>
            <button type="button" className="btn small primary" onClick={() => decide(true)}>Approve</button>
          </div>
        )}
        {current === "flow" && <FlowEditor d={d} onChanged={load} />}
        {current === "runs" && (more[0] === "build" ? <BuildLog d={d} number={Number(more[1])} back={`${at}/runs`} /> : <Builds d={d} base={`${at}/runs`} onChanged={load} />)}
        {current === "settings" && <DeploySettings d={d} onChanged={load} />}
      </div>
    </>
  );
}

// FlowEditor is the flow as it runs, a node each: what starts it, the build,
// each step, then going live. Steps are added, moved and removed here, and
// saved together.
function FlowEditor({ d, onChanged }: { d: Deploy; onChanged: () => Promise<void> }) {
  const can = useCan()("containers.deploy");
  const notify = useNotify();
  const [steps, setSteps] = useState<FlowStep[] | null>(null);
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.flow(d.id).then((f) => {
      setSteps(f.steps);
      setSaved(JSON.stringify(f.steps));
    }).catch((e) => notify(message(e), "bad"));
  }, [d.id, notify]);
  if (!steps) return <div className="repo-loading"><span className="spinner" /></div>;
  const changed = JSON.stringify(steps) !== saved;
  const put = (i: number, s: FlowStep) => setSteps(steps.map((x, j) => (j === i ? s : x)));
  const move = (i: number, by: number) => {
    const next = [...steps];
    const [s] = next.splice(i, 1);
    next.splice(i + by, 0, s);
    setSteps(next);
  };
  const save = async () => {
    setBusy(true);
    try {
      const f = await api.setFlow(d.id, steps);
      setSteps(f.steps);
      setSaved(JSON.stringify(f.steps));
      notify("Flow saved");
    } catch (e) {
      notify(message(e), "bad");
    }
    setBusy(false);
  };
  const trigger = async (updates: Updates, every?: number) => {
    try {
      await api.editDeploy(d.id, { updates, every: every ?? d.every });
      await onChanged();
    } catch (e) {
      notify(message(e), "bad");
    }
  };
  const triggers = updatesFor(!!d.image);

  return (
    <div className="flow">
      <div className="flow-node">
        <span className="flow-dot"><Icon name="bolt" size={18} /></span>
        <div className="flow-body">
          <b>Starts</b>
          <div className="flow-fields">
            <Dropdown label="Starts" value={d.updates} options={triggers} onChange={(v) => can && trigger(v)} />
            {d.updates === "timer" && <Dropdown label="Every" value={d.every} options={EVERY} onChange={(v) => can && trigger("timer", v)} />}
          </div>
        </div>
      </div>
      <div className="flow-node">
        <span className="flow-dot"><Icon name={d.image ? "download" : "code"} size={18} /></span>
        <div className="flow-body"><b>{d.image ? "Pull the image" : "Build"}</b><small>{d.image ? d.image : `The commit, from the Dockerfile${d.dockerfile ? ` at ${d.dockerfile}` : ""}`}</small></div>
      </div>
      {steps.map((s, i) => (
        <div key={i} className="flow-node">
          <span className={"flow-dot " + s.kind}><Icon name={s.kind === "test" ? "terminal" : "visibility"} size={18} /></span>
          <div className="flow-body">
            {s.kind === "test" ? (
              <>
                <b>Test</b>
                <div className="flow-fields">
                  <TextField label="Name" autoComplete="off" value={s.name} onChange={(v) => put(i, { ...s, name: v.slice(0, 60) })} />
                  <TextField className="flow-command" label="Command, run in the new image" mono autoComplete="off" placeholder="npm test" value={s.command} onChange={(v) => put(i, { ...s, command: v })} />
                </div>
              </>
            ) : <><b>Review</b><small>Waits here until someone approves it on Automations</small></>}
          </div>
          {can && (
            <span className="flow-tools">
              <button type="button" className="icon-btn small" aria-label="Move up" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}><Icon name="arrow_upward" size={18} /></button>
              <button type="button" className="icon-btn small" aria-label="Remove" title="Remove" onClick={() => setSteps(steps.filter((_, j) => j !== i))}><Icon name="close" size={18} /></button>
            </span>
          )}
        </div>
      ))}
      {can && (
        <div className="flow-add">
          <button type="button" className="btn small" onClick={() => setSteps([...steps, { kind: "test", name: "", command: "" }])}><Icon name="terminal" size={16} />Add test</button>
          <button type="button" className="btn small" onClick={() => setSteps([...steps, { kind: "review" }])}><Icon name="visibility" size={16} />Add review</button>
        </div>
      )}
      <div className="flow-node">
        <span className="flow-dot live"><Icon name="rocket_launch" size={18} /></span>
        <div className="flow-body"><b>Go live</b><small>Runs it in place of the container; if it will not start, the one before comes back</small></div>
      </div>
      {can && changed && (
        <div className="flow-save">
          <button type="button" className="btn text" onClick={() => setSteps(JSON.parse(saved))}>Undo</button>
          <button type="button" className="btn primary" disabled={busy} onClick={save}>{busy && <span className="spinner small on-accent" />}Save flow</button>
        </div>
      )}
    </div>
  );
}
