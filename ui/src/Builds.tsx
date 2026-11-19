import { useEffect, useRef, useState, type FormEvent } from "react";
import { NeedsApp } from "./Apps";
import { ago, api, message, type Build, type Deploy, type DeployEdit, type Updates } from "./api";
import { Dropdown, type Option } from "./Dropdown";
import { Icon, type IconName } from "./Icon";
import { imageId } from "./Images";
import { useCan } from "./me";
import { go } from "./route";
import { Callout, Card, Dialog, MoreMenu, Row, TextField, useNotify, ValueRow } from "./ui";

export const UPDATES: Option<Updates>[] = [
  { value: "push", label: "When the branch changes", hint: "Builds each new commit as it arrives" },
  { value: "release", label: "When a release is published", hint: "Builds each new GitHub release" },
  { value: "timer", label: "On a timer", hint: "Builds the latest commit, when there is one, every so often" },
  { value: "manual", label: "Only when I press Update" },
];

export const EVERY: Option<number>[] = [
  { value: 3_600, label: "Every hour" },
  { value: 6 * 3_600, label: "Every 6 hours" },
  { value: 12 * 3_600, label: "Every 12 hours" },
  { value: 86_400, label: "Every day" },
  { value: 7 * 86_400, label: "Every week" },
];

const REASONS: Record<Build["reason"], string> = { first: "First build", push: "New commit", release: "New release", timer: "Timer", manual: "Update" };

export const sourceOf = (d: Pick<Deploy, "repo" | "url" | "image" | "path">) => d.image || d.path || (d.url ? d.url.replace(/^https:\/\//, "").replace(/\.git$/, "") : d.repo);

// Whether a build is still to finish.
export const waiting = (b: Build | null | undefined) => !!b && (b.status === "queued" || b.status === "building" || b.status === "testing");

export function buildTone(b: Build, current: number | null) {
  if (b.number === current) return "ok";
  return b.status === "failed" ? "bad" : waiting(b) || b.status === "review" ? "warn" : "";
}

export function buildLabel(b: Build, current: number | null) {
  if (b.number === current) return "Running";
  return { queued: "Waiting", building: "Building", testing: "Testing", review: "Waiting for review", ready: "Ready", rejected: "Turned down", failed: "Failed" }[b.status];
}

function took(b: Build) {
  if (!b.started_at) return "";
  const s = (b.finished_at ?? Date.now() / 1000) - b.started_at;
  return s < 60 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

interface Source { url: string; token: string; branch: string }

// SourceFields picks where a container's code comes from: an https address
// with an optional token, then one of its branches, looked up as the address
// changes.
function SourceFields({ value, onChange, deploy, tokenSet, autoFocus }: { value: Source; onChange: (patch: Partial<Source>) => void; deploy?: string; tokenSet?: boolean; autoFocus?: boolean }) {
  const [branches, setBranches] = useState<string[] | null>(null);
  const [problem, setProblem] = useState("");
  const { url, token } = value;
  useEffect(() => {
    setBranches(null);
    setProblem("");
    if (!/^https:\/\/\S+\/\S+/.test(url)) return;
    let alive = true;
    const t = setTimeout(() => {
      api.probeSource({ url, token, deploy }).then((p) => {
        if (!alive) return;
        setBranches(p.branches);
        if (!p.branches.includes(value.branch)) onChange({ branch: p.default || p.branches[0] || "" });
      }, (e) => alive && setProblem(message(e)));
    }, 600);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // The branch is picked from what this finds, not the other way round.
  }, [url, token, deploy]);

  return (
    <>
      <TextField label="Address" mono autoFocus={autoFocus} autoComplete="off" placeholder="https://github.com/you/app.git" value={url} onChange={(v) => onChange({ url: v.trim() })} />
      <TextField label="Token" type="password" autoComplete="new-password" value={token} onChange={(v) => onChange({ token: v.trim() })}
        hint={tokenSet && !token ? "Set. Leave empty to keep it." : "For a private repository."} />
      <div className="tf static">
        <div className="tf-box">
          {branches && branches.length > 0 ? (
            <Dropdown label="Branch" value={value.branch} options={branches.map((b) => ({ value: b, label: b }))} onChange={(branch) => onChange({ branch })} />
          ) : (
            <span className="dropdown placeholder">{problem ? "No branches" : branches ? "No branches yet" : url ? "Looking up branches" : "Give the address"}</span>
          )}
          <span className="tf-label">Branch</span>
        </div>
        {problem && <div className="tf-hint">{problem}</div>}
      </div>
    </>
  );
}

// Where a new container comes from: a Docker image, a folder on this computer
// with a Dockerfile, built here, or a repository at an https address such as GitHub.
export type Kind = "url" | "image" | "path";

// Where a new container comes from, picked at the top of its dialog.
const KINDS: [Kind, string][] = [["image", "Image"], ["path", "Folder"], ["url", "GitHub"]];

// The ways an image updates: pulled again on a timer, or by hand.
export const updatesFor = (image: boolean): Option<Updates>[] => image
  ? [
    { value: "timer", label: "On a timer", hint: "Pulls the image again every so often, and runs it when it changed" },
    { value: "manual", label: "Only when I press Update" },
  ]
  : UPDATES;

// AddContainer makes a container: where it comes from, an image, a folder or
// a repository, its name and how it updates. Its first build, or pull, starts at once.
export function AddContainer({ onClose, onAdded }: { onClose: () => void; onAdded: (d: Deploy) => Promise<void> }) {
  const [kind, setKind] = useState<Kind>("image");
  const [name, setName] = useState("");
  const [named, setNamed] = useState(false);
  const [source, setSource] = useState<Source>({ url: "", token: "", branch: "" });
  const [image, setImage] = useState("");
  const [path, setPath] = useState("");
  // An image or a folder has no pushes to follow.
  const fixed = kind !== "url";
  const [updates, setUpdates] = useState<Updates>("manual");
  const [every, setEvery] = useState(86_400);
  const [busy, setBusy] = useState(false);
  const notify = useNotify();

  const guess = (from: string) => {
    if (named) return;
    const last = from.replace(/\.git$/, "").replace(/[:@].*$/, "").split(/[/\\]/).filter(Boolean).pop() || "";
    setName(last.toLowerCase().replace(/[^a-z0-9_.-]/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 63));
  };
  const change = (patch: Partial<Source>) => {
    const next = { ...source, ...patch };
    setSource(next);
    guess(next.url);
  };
  const ready = !!name && (kind === "image" ? !!image : kind === "path" ? !!path : !!source.branch && !!source.url);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    try {
      const d = await api.addDeploy({
        name, updates, every,
        ...(kind === "image" ? { image } : kind === "path" ? { path } : { url: source.url, branch: source.branch, token: source.token || undefined }),
      });
      notify(`Added ${d.name}`);
      await onAdded(d);
    } catch (err) {
      notify(message(err), "bad");
      setBusy(false);
    }
  };

  return (
    <Dialog title="Add container" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="seg-tabs add-kind" role="radiogroup" aria-label="From">
          {KINDS.map(([k, label]) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? "on" : undefined} onClick={() => {
              setKind(k);
              setUpdates(k === "url" ? "push" : "manual");
            }}>{label}</button>
          ))}
        </div>
        {kind === "url" && <NeedsApp app="git" what="A container from a repository" />}
        {kind === "image" ? (
          <TextField label="Image" mono autoFocus autoComplete="off" placeholder="nginx:1.27" value={image}
            onChange={(v) => {
              setImage(v.trim());
              guess(v.trim());
            }} />
        ) : kind === "path" ? (
          <TextField label="Folder" mono autoFocus autoComplete="off" placeholder="C:\apps\web" value={path}
            hint="A folder on this computer with a Dockerfile; it is built into an image here and run"
            onChange={(v) => {
              setPath(v.trim());
              guess(v.trim());
            }} />
        ) : <SourceFields autoFocus value={source} onChange={change} />}
        <TextField label="Name" autoComplete="off" value={name}
          onChange={(v) => {
            setNamed(true);
            setName(v.toLowerCase().replace(/[^a-z0-9_.-]/g, "").slice(0, 63));
          }} />
        <div className="tf static">
          <div className="tf-box">
            <Dropdown label="Update" value={updates} options={updatesFor(fixed)} onChange={setUpdates} />
            <span className="tf-label">Update</span>
          </div>
        </div>
        {updates === "timer" && (
          <div className="tf static">
            <div className="tf-box">
              <Dropdown label="Every" value={every} options={EVERY} onChange={setEvery} />
              <span className="tf-label">Every</span>
            </div>
          </div>
        )}
        <div className="edit-actions">
          <button type="button" className="btn text" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !ready}>{busy && <span className="spinner small on-accent" />}Add container</button>
        </div>
      </form>
    </Dialog>
  );
}

// AddButton is the one way to add a container: the button, and its dialog.
export function AddButton() {
  const can = useCan();
  const [adding, setAdding] = useState(false);
  if (!can("containers.deploy")) return null;
  return (
    <>
      <button type="button" className="btn primary" onClick={() => setAdding(true)}><Icon name="add" size={18} />Add container</button>
      {adding && <AddContainer onClose={() => setAdding(false)} onAdded={async (d) => {
        setAdding(false);
        go(`#/containers/${encodeURIComponent(d.name)}/images`);
      }} />}
    </>
  );
}

// Builds is a row per build of a container, newest first: its number and the
// commit it built, why and when, and how it went, the one running marked.
// Each opens its log; a ready one whose image is kept can be run again.
export function Builds({ d, base, onChanged }: { d: Deploy; base: string; onChanged: () => Promise<void> }) {
  const can = useCan();
  const notify = useNotify();
  const [busy, setBusy] = useState(0);
  const builds = d.builds ?? [];
  const use = async (b: Build) => {
    setBusy(b.number);
    try {
      await api.useBuild(d.id, b.number);
      notify(`${d.name} runs build ${b.number}`);
      await onChanged();
    } catch (e) {
      notify(message(e), "bad");
    } finally {
      setBusy(0);
    }
  };
  if (!builds.length) {
    return <div className="card welcome"><Icon name="layers" size={40} /><h2>No builds yet</h2><p className="muted">Press Update to build the branch's latest commit.</p></div>;
  }
  return (
    <div className="card">
      <div className="table-wrap">
        <table className="table img-table">
          <thead>
            <tr><th className="grow">Build</th><th>Why</th><th>When</th><th>Took</th><th aria-label="Actions" /></tr>
          </thead>
          <tbody>
            {builds.map((b) => {
              const open = `${base}/build/${b.number}`;
              const actions = [
                { label: "Log", icon: "terminal" as IconName, onClick: () => go(open) },
                ...(b.image ? [{ label: "Image", icon: "layers" as IconName, onClick: () => go(`${base}/${imageId(b.image!)}`) }] : []),
                ...(can("containers.deploy") && b.status === "ready" && b.image && b.number !== d.current
                  ? [{ label: "Run this build", icon: "history" as IconName, onClick: () => use(b), confirm: `Run build ${b.number}` }] : []),
              ];
              return (
                <tr key={b.number} className={b.status === "failed" ? "stopped" : ""}>
                  <td>
                    <a className="ct-name" href={open}>
                      <span className={"dot " + buildTone(b, d.current)} />
                      <span className="ct-name-text">
                        <b>Build {b.number}<span className={"chip small-chip " + buildTone(b, d.current)}>{buildLabel(b, d.current)}</span></b>
                        <small>{b.commit ? <><span className="mono">{b.commit.slice(0, 7)}</span> {b.message}</> : "Latest commit"}</small>
                      </span>
                    </a>
                  </td>
                  <td className="muted">{REASONS[b.reason]}</td>
                  <td className="muted">{ago(b.queued_at)}</td>
                  <td className="muted">{took(b)}</td>
                  <td className="ct-menu">{busy === b.number ? <span className="spinner small" /> : <MoreMenu label={`Actions for build ${b.number}`} actions={actions} />}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// BuildLog is one build: what it built and how it went, then everything the
// build printed, followed while it runs.
export function BuildLog({ d, number, back }: { d: Deploy; number: number; back: string }) {
  const [b, setB] = useState<(Build & { log: string }) | null>(null);
  const [problem, setProblem] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);

  useEffect(() => {
    let alive = true;
    let timer = 0;
    const load = async () => {
      try {
        const next = await api.buildLog(d.id, number);
        if (!alive) return;
        setB(next);
        setProblem("");
        if (waiting(next)) timer = window.setTimeout(load, 2000);
      } catch (e) {
        if (alive) setProblem(message(e));
      }
    };
    load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [d.id, number]);

  useEffect(() => {
    if (box.current && atEnd.current) box.current.scrollTop = box.current.scrollHeight;
  }, [b?.log]);

  if (!b) return problem ? <Callout tone="bad" icon="error">{problem}</Callout> : <div className="repo-loading"><span className="spinner" /></div>;
  return (
    <>
      <div className="img-head">
        <a className="icon-btn" href={back} aria-label="Images" title="Images"><Icon name="arrow_back" /></a>
        <h2>Build {b.number}</h2>
        <span className={"chip " + buildTone(b, d.current)}>{buildLabel(b, d.current)}</span>
        {b.commit && <span><span className="mono">{b.commit.slice(0, 7)}</span> {b.message}</span>}
        <span className="muted">{REASONS[b.reason]}, {ago(b.queued_at)}{took(b) && `, took ${took(b)}`}</span>
        {waiting(b) && <span className="spinner small" />}
      </div>
      {b.error && <Callout tone="bad" icon="error">{b.error}</Callout>}
      <div className="card ct-logs">
        <div className="ct-log-lines" ref={box} onScroll={(e) => {
          const el = e.currentTarget;
          atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}>
          {b.log || <span className="muted">{b.status === "queued" ? "Waiting for the build before it." : "Nothing printed yet."}</span>}
        </div>
      </div>
    </>
  );
}

// ListDialog edits a list of lines, such as the environment, in a dialog.
function ListDialog({ title, label, placeholder, value, onSave, onClose }: {
  title: string;
  label: string;
  placeholder: string;
  value: string[];
  onSave: (lines: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const [text, setText] = useState(value.join("\n"));
  const [busy, setBusy] = useState(false);
  const notify = useNotify();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await onSave(text.split("\n").map((l) => l.trim()).filter(Boolean));
      onClose();
    } catch (err) {
      notify(message(err), "bad");
      setBusy(false);
    }
  };
  return (
    <Dialog title={title} onClose={onClose}>
      <form onSubmit={save}>
        <textarea className="text-area mono list-area" aria-label={label} placeholder={placeholder} rows={8} spellCheck={false} autoFocus value={text} onChange={(e) => setText(e.target.value)} />
        <div className="edit-actions">
          <button type="button" className="btn text" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy && <span className="spinner small on-accent" />}Save</button>
        </div>
      </form>
    </Dialog>
  );
}

// SourceDialog changes where a container's code comes from and its branch.
function SourceDialog({ d, onSave, onClose }: { d: Deploy; onSave: (edit: DeployEdit) => Promise<void>; onClose: () => void }) {
  const [source, setSource] = useState<Source>({ url: d.url, token: "", branch: d.branch });
  const [busy, setBusy] = useState(false);
  const notify = useNotify();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await onSave({ url: source.url, branch: source.branch, ...(source.token ? { token: source.token } : {}) });
      onClose();
    } catch (err) {
      notify(message(err), "bad");
      setBusy(false);
    }
  };
  return (
    <Dialog title="Change the repository" onClose={onClose}>
      <form onSubmit={save}>
        <SourceFields value={source} onChange={(patch) => setSource((s) => ({ ...s, ...patch }))} deploy={d.id} tokenSet={d.token_set} />
        <div className="edit-actions">
          <button type="button" className="btn text" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !source.branch}>{busy && <span className="spinner small on-accent" />}Save</button>
        </div>
      </form>
    </Dialog>
  );
}

// DeploySettings is how a container is built, run and updated. A change to
// how it runs makes the running build again with it.
export function DeploySettings({ d, onChanged }: { d: Deploy; onChanged: () => Promise<void> }) {
  const [editing, setEditing] = useState<"" | "source" | "env" | "keep">("");
  const notify = useNotify();
  const save = async (edit: DeployEdit, said = "Saved") => {
    await api.editDeploy(d.id, edit);
    await onChanged();
    notify(said);
  };
  const quietly = (edit: DeployEdit) => save(edit).catch((e) => notify(message(e), "bad"));
  const remade = d.current ? "Saved; the container is made again with it" : "Saved";
  const env = d.env ?? [];
  return (
    <>
      <Card title="Source">
        {d.image ? (
          <ValueRow title="Image" value={d.image} onSave={(v) => save({ image: v })} />
        ) : d.path ? (
          <>
            <Row title="Folder" sub={<span className="mono">{d.path}</span>} />
            <ValueRow title="Dockerfile" value={d.dockerfile} empty="Dockerfile at its top" onSave={(v) => save({ dockerfile: v })} />
          </>
        ) : (
          <>
            <Row title="Repository" sub={<><span className="mono">{sourceOf(d)}</span>, branch <span className="mono">{d.branch}</span></>}>
              <button type="button" className="icon-btn" aria-label="Change the repository" title="Change the repository" onClick={() => setEditing("source")}><Icon name="edit" size={20} /></button>
            </Row>
            <ValueRow title="Dockerfile" value={d.dockerfile} empty="Found on its own" onSave={(v) => save({ dockerfile: v })} />
          </>
        )}
      </Card>
      <Card title="Updates">
        <Row title="Update" sub={d.updates === "manual" ? undefined : `Last looked ${ago(d.checked_at)}`}>
          <Dropdown label="Update" value={d.updates} options={updatesFor(!!d.image || !!d.path)} onChange={(updates) => quietly({ updates })} />
        </Row>
        {d.updates === "timer" && (
          <Row title="Every">
            <Dropdown label="Every" value={d.every} options={EVERY} onChange={(every) => quietly({ every })} />
          </Row>
        )}
      </Card>
      <Card title="Container">
        <ValueRow title="Port" value={d.port ? String(d.port) : ""} empty="The one its image exposes"
          onSave={(v) => {
            const port = v ? Number(v) : 0;
            if (!Number.isInteger(port) || port < 0 || port > 65535) return Promise.reject(new Error("A port is a number up to 65535"));
            return save({ port }, remade);
          }} />
        <Row title="Environment" sub={env.length ? env.map((e) => e.split("=")[0]).join(", ") : "None set"}>
          <button type="button" className="icon-btn" aria-label="Change the environment" title="Change the environment" onClick={() => setEditing("env")}><Icon name="edit" size={20} /></button>
        </Row>
        <Row title="Kept folders" sub={d.keep.length ? d.keep.join(", ") : "Only the ones its image keeps"}>
          <button type="button" className="icon-btn" aria-label="Change the kept folders" title="Change the kept folders" onClick={() => setEditing("keep")}><Icon name="edit" size={20} /></button>
        </Row>
      </Card>
      {editing === "source" && <SourceDialog d={d} onSave={(edit) => save(edit)} onClose={() => setEditing("")} />}
      {editing === "env" && (
        <ListDialog title="Environment" label="Environment" placeholder={"NAME=value\nOTHER=value"} value={env}
          onSave={(lines) => save({ env: lines }, remade)} onClose={() => setEditing("")} />
      )}
      {editing === "keep" && (
        <ListDialog title="Kept folders" label="Kept folders" placeholder={"/data\n/uploads"} value={d.keep}
          onSave={(lines) => save({ keep: lines }, remade)} onClose={() => setEditing("")} />
      )}
    </>
  );
}
