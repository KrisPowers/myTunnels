import { useEffect, useRef, useState, type FormEvent } from "react";
import { ago, api, message, repos, type Build, type Deploy, type DeployEdit, type Updates } from "./api";
import { Dropdown, type Option } from "./Dropdown";
import { Icon, type IconName } from "./Icon";
import { imageId } from "./Images";
import { useCan } from "./me";
import { go } from "./route";
import { Callout, Card, Dialog, MoreMenu, Row, TextField, useNotify, ValueRow, type MenuAction } from "./ui";

// A repository on another server is picked with this in place of a name.
const ADDRESS = " address";

export const UPDATES: Option<Updates>[] = [
  { value: "push", label: "When the branch changes", hint: "Builds each new commit as it arrives" },
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

const REASONS: Record<Build["reason"], string> = { first: "First build", push: "New commit", timer: "Timer", manual: "Update" };

export const sourceOf = (d: Pick<Deploy, "repo" | "url" | "image">) => d.image || (d.url ? d.url.replace(/^https:\/\//, "").replace(/\.git$/, "") : d.repo);

// Whether a build is still to finish.
export const waiting = (b: Build | null | undefined) => !!b && (b.status === "queued" || b.status === "building");

export function buildTone(b: Build, current: number | null) {
  if (b.number === current) return "ok";
  return b.status === "failed" ? "bad" : waiting(b) ? "warn" : "";
}

export function buildLabel(b: Build, current: number | null) {
  if (b.number === current) return "Running";
  return { queued: "Waiting", building: "Building", ready: "Ready", failed: "Failed" }[b.status];
}

function took(b: Build) {
  if (!b.started_at) return "";
  const s = (b.finished_at ?? Date.now() / 1000) - b.started_at;
  return s < 60 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

interface Source { repo: string; url: string; token: string; branch: string }

// SourceFields picks where a container's code comes from: a repository on
// this host's Git or an https address with an optional token, then one of its
// branches, looked up as the source changes. `kind` keeps it to one of them.
function SourceFields({ value, onChange, deploy, tokenSet, kind }: { value: Source; onChange: (patch: Partial<Source>) => void; deploy?: string; tokenSet?: boolean; kind?: "git" | "url" }) {
  const can = useCan();
  const [local, setLocal] = useState<string[] | null>(null);
  const [branches, setBranches] = useState<string[] | null>(null);
  const [problem, setProblem] = useState("");
  const remote = kind === "url" || (kind !== "git" && value.repo === "");

  useEffect(() => {
    if (!can("code.view")) return setLocal([]);
    repos.list().then((r) => {
      const names = r.repos.filter((x) => !x.empty).map((x) => x.name);
      setLocal(names);
      if (!value.repo && !value.url && names.length && kind !== "url") onChange({ repo: names[0] });
    }).catch(() => setLocal([]));
    // Once, for the repositories there are.
  }, []);

  const { repo, url, token } = value;
  useEffect(() => {
    setBranches(null);
    setProblem("");
    if (remote && !/^https:\/\/\S+\/\S+/.test(url)) return;
    if (!remote && !repo) return;
    let alive = true;
    const t = setTimeout(() => {
      api.probeSource(remote ? { url, token, deploy } : { repo }).then((p) => {
        if (!alive) return;
        setBranches(p.branches);
        if (!p.branches.includes(value.branch)) onChange({ branch: p.default || p.branches[0] || "" });
      }, (e) => alive && setProblem(message(e)));
    }, remote ? 600 : 0);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // The branch is picked from what this finds, not the other way round.
  }, [remote, repo, url, token, deploy]);

  const sources: Option<string>[] = [
    ...(local ?? []).map((name) => ({ value: name, label: name, icon: "git" as IconName })),
    ...(kind === "git" ? [] : [{ value: ADDRESS, label: "Another address", hint: "GitHub or any https address", icon: "public" as IconName }]),
  ];
  return (
    <>
      {kind !== "url" && (
        <div className="tf static">
          <div className="tf-box">
            {kind === "git" && local && !local.length ? (
              <span className="dropdown placeholder">No repositories with commits on this host yet</span>
            ) : (
              <Dropdown label="Repository" value={remote ? ADDRESS : repo} options={sources}
                onChange={(v) => onChange(v === ADDRESS ? { repo: "" } : { repo: v, url: "", token: "" })} />
            )}
            <span className="tf-label">Repository</span>
          </div>
        </div>
      )}
      {remote && (
        <>
          <TextField label="Address" mono autoFocus={kind === "url"} autoComplete="off" placeholder="https://github.com/you/app.git" value={url} onChange={(v) => onChange({ url: v.trim() })} />
          <TextField label="Token" type="password" autoComplete="new-password" value={token} onChange={(v) => onChange({ token: v.trim() })}
            hint={tokenSet && !token ? "Set. Leave empty to keep it." : "For a private repository."} />
        </>
      )}
      <div className="tf static">
        <div className="tf-box">
          {branches && branches.length > 0 ? (
            <Dropdown label="Branch" value={value.branch} options={branches.map((b) => ({ value: b, label: b }))} onChange={(branch) => onChange({ branch })} />
          ) : (
            <span className="dropdown placeholder">{problem ? "No branches" : branches ? "No branches yet" : (remote ? url : repo) ? "Looking up branches" : "Pick a repository"}</span>
          )}
          <span className="tf-label">Branch</span>
        </div>
        {problem && <div className="tf-hint">{problem}</div>}
      </div>
    </>
  );
}

// Where a new container comes from: a repository on this host's Git, one at
// an https address such as GitHub, or a Docker image.
export type Kind = "git" | "url" | "image";

const TITLES: Record<Kind, string> = {
  git: "Container from Git",
  url: "Container from GitHub",
  image: "Container from an image",
};

// The ways an image updates: pulled again on a timer, or by hand.
export const updatesFor = (image: boolean): Option<Updates>[] => image
  ? [
    { value: "timer", label: "On a timer", hint: "Pulls the image again every so often, and runs it when it changed" },
    { value: "manual", label: "Only when I press Update" },
  ]
  : UPDATES;

// AddContainer makes a container: its name, where it comes from and how it
// updates. Its first build, or pull, starts at once.
export function AddContainer({ kind, onClose, onAdded }: { kind: Kind; onClose: () => void; onAdded: (d: Deploy) => Promise<void> }) {
  const [name, setName] = useState("");
  const [named, setNamed] = useState(false);
  const [source, setSource] = useState<Source>({ repo: "", url: "", token: "", branch: "" });
  const [image, setImage] = useState("");
  const [updates, setUpdates] = useState<Updates>(kind === "image" ? "manual" : "push");
  const [every, setEvery] = useState(86_400);
  const [busy, setBusy] = useState(false);
  const notify = useNotify();

  const guess = (from: string) => {
    if (named) return;
    const last = from.replace(/\.git$/, "").replace(/[:@].*$/, "").split("/").pop() || "";
    setName(last.toLowerCase().replace(/[^a-z0-9_.-]/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 63));
  };
  const change = (patch: Partial<Source>) => {
    const next = { ...source, ...patch };
    setSource(next);
    guess(next.repo || next.url);
  };
  const ready = !!name && (kind === "image" ? !!image : !!source.branch && (!!source.repo || !!source.url));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    try {
      const d = await api.addDeploy({
        name, updates, every,
        ...(kind === "image" ? { image } : kind === "git" ? { repo: source.repo, branch: source.branch } : { url: source.url, branch: source.branch, token: source.token || undefined }),
      });
      notify(`Added ${d.name}`);
      await onAdded(d);
    } catch (err) {
      notify(message(err), "bad");
      setBusy(false);
    }
  };

  return (
    <Dialog title={TITLES[kind]} onClose={onClose}>
      <form onSubmit={submit}>
        {kind === "image" ? (
          <TextField label="Image" mono autoFocus autoComplete="off" placeholder="nginx:1.27" value={image}
            onChange={(v) => {
              setImage(v.trim());
              guess(v.trim());
            }} />
        ) : <SourceFields kind={kind} value={source} onChange={change} />}
        <TextField label="Name" autoComplete="off" value={name}
          onChange={(v) => {
            setNamed(true);
            setName(v.toLowerCase().replace(/[^a-z0-9_.-]/g, "").slice(0, 63));
          }} />
        <div className="tf static">
          <div className="tf-box">
            <Dropdown label="Update" value={updates} options={updatesFor(kind === "image")} onChange={setUpdates} />
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
          <button className="btn primary" disabled={busy || !ready}>{busy && <span className="spinner small on-accent" />}Add</button>
        </div>
      </form>
    </Dialog>
  );
}

// NewMenu is the plus that adds anything to Containers: a tunnel to any port,
// or a container from Git, from GitHub or from an image.
export function NewMenu() {
  const can = useCan();
  const [adding, setAdding] = useState<Kind | "">("");
  const actions: MenuAction[] = [
    ...(can("tunnels.create") ? [{ label: "Tunnel", hint: "A port on this computer or another", icon: "public" as IconName, onClick: () => go("#/new") }] : []),
    ...(can("containers.deploy") ? [
      { label: "Container from Git", hint: "Built from a repository on this host", icon: "git" as IconName, onClick: () => setAdding("git") },
      { label: "Container from GitHub", hint: "Built from any https repository", icon: "code" as IconName, onClick: () => setAdding("url") },
      { label: "Container from an image", hint: "Runs a Docker image, such as nginx", icon: "layers" as IconName, onClick: () => setAdding("image") },
    ] : []),
  ];
  if (!actions.length) return null;
  return (
    <>
      <MoreMenu label="New" icon="add" actions={actions} />
      {adding && <AddContainer kind={adding} onClose={() => setAdding("")} onAdded={async (d) => {
        setAdding("");
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
  const [source, setSource] = useState<Source>({ repo: d.repo, url: d.url, token: "", branch: d.branch });
  const [busy, setBusy] = useState(false);
  const notify = useNotify();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await onSave(source.repo ? { repo: source.repo, branch: source.branch } : { url: source.url, branch: source.branch, ...(source.token ? { token: source.token } : {}) });
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
          <Dropdown label="Update" value={d.updates} options={updatesFor(!!d.image)} onChange={(updates) => quietly({ updates })} />
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
