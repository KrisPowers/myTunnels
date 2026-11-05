import { useCallback, useEffect, useState } from "react";
import { ago, api, bytes, message, rawUrl, repos, type BlobView, type Branch, type CommitLine, type CommitView, type Refs, type TreeView } from "./api";
import { Dropdown, type Option } from "./Dropdown";
import { Threads } from "./GitThreads";
import { Icon, type IconName } from "./Icon";
import { useCan } from "./me";
import { ArmedButton, Callout, Card, Copy, Dialog, Row, Switch, TextField, useNotify } from "./ui";

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
export const short = (id: string) => id.slice(0, 7);
const README = ["readme.md", "readme", "readme.txt", "readme.markdown"];

export const repoHref = (name: string, ...parts: (string | number)[]) =>
  [`#/git/r/${encodeURIComponent(name)}`, ...parts.map((p) => encodeURIComponent(String(p)))].join("/");

// RepoPage is one repository: its code, pull requests, issues and settings,
// a tab each, with the branch picked kept across them.
export function RepoPage({ name, tab, sub, cloneUrls }: { name: string; tab: string; sub: string[]; cloneUrls: { label: string; url: string }[] }) {
  const [refs, setRefs] = useState<Refs | null>(null);
  const [ref, setRef] = useState("");
  const [cloning, setCloning] = useState(false);
  const [problem, setProblem] = useState("");
  const can = useCan();

  const loadRefs = useCallback(async () => {
    try {
      const r = await repos.refs(name);
      setRefs(r);
      setRef((cur) => (cur && [...r.branches, ...r.tags].some((b) => b.name === cur) ? cur : r.branches.some((b) => b.name === r.default) ? r.default : r.branches[0]?.name ?? ""));
      setProblem("");
    } catch (e) {
      setProblem(message(e));
    }
  }, [name]);
  useEffect(() => {
    loadRefs();
  }, [loadRefs]);

  const tabs: [string, string, IconName][] = [
    ["code", "Code", "code"],
    ["pulls", "Pull Requests", "call_split"],
    ["issues", "Issues", "adjust"],
    ...(can("code.create") || can("code.delete") ? [["settings", "Settings", "settings"]] as [string, string, IconName][] : []),
  ];
  const current = tabs.some(([k]) => k === tab) ? tab : "code";

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1 className="d-crumbs">
            <span className="ex-crumb-wrap"><a className="d-crumb" href="#/git">Git</a></span>
            <span className="ex-crumb-wrap"><Icon name="chevron_right" size={24} className="ex-crumb-sep" /><span className="d-crumb on">{name}</span></span>
          </h1>
          {refs?.home_only && <div className="page-sub"><span className="chip">Home network only</span></div>}
        </div>
        <div className="page-actions">
          <button type="button" className="btn primary" onClick={() => setCloning(true)}><Icon name="content_copy" size={18} />Clone</button>
        </div>
      </div>
      <nav className="sub-nav" aria-label="Repository">
        {tabs.map(([key, label, icon]) => (
          <a key={key} className={"sub-nav-item" + (current === key ? " on" : "")} href={repoHref(name, key)} aria-current={current === key ? "page" : undefined}>
            <Icon name={icon} size={18} />
            <span>{label}</span>
          </a>
        ))}
      </nav>
      <div className="page-body stack plain" key={current + sub.join("/")}>
        {problem && <Callout tone="bad" icon="error">{problem}</Callout>}
        {refs && current === "code" && <CodeTab name={name} refs={refs} gitRef={ref} onRef={setRef} sub={sub} urls={cloneUrls} onRefs={loadRefs} />}
        {refs && current === "pulls" && <Threads repo={name} kind="pull" sub={sub} refs={refs} />}
        {refs && current === "issues" && <Threads repo={name} kind="issue" sub={sub} refs={refs} />}
        {refs && current === "settings" && <Settings name={name} refs={refs} onRefs={setRefs} />}
      </div>

      {cloning && (
        <Dialog title={`Clone ${name}`} onClose={() => setCloning(false)}>
          <div className="clone-list">
            {cloneUrls.map((c) => (
              <div key={c.label} className="clone-row">
                <small>{c.label}</small>
                <Copy text={c.url} />
              </div>
            ))}
          </div>
          <p className="muted">When git asks, any username, and a token from Git, Tokens as the password.</p>
        </Dialog>
      )}
    </>
  );
}

// BranchPicker picks a branch or tag.
export function BranchPicker({ refs, value, onChange, label = "Branch" }: { refs: Refs; value: string; onChange: (v: string) => void; label?: string }) {
  const options: Option<string>[] = [
    ...refs.branches.map((b) => ({ value: b.name, label: b.name, icon: "call_split" as IconName, hint: b.name === refs.default ? "Default branch" : undefined })),
    ...refs.tags.map((t) => ({ value: t.name, label: t.name, icon: "sell" as IconName, hint: "Tag" })),
  ];
  return <div className="ex-pick branch-pick"><Dropdown label={label} value={value} options={options} onChange={onChange} /></div>;
}

// ---- Code ----

function CodeTab({ name, refs, gitRef, onRef, sub, urls, onRefs }: {
  name: string;
  refs: Refs;
  gitRef: string;
  onRef: (r: string) => void;
  sub: string[];
  urls: { label: string; url: string }[];
  onRefs: () => Promise<void>;
}) {
  if (!refs.branches.length) return <EmptyRepo urls={urls} />;
  if (sub[0] === "commit" && sub[1]) return <Commit name={name} id={sub[1]} />;
  if (sub[0] === "commits") return <History name={name} refs={refs} gitRef={gitRef} onRef={onRef} />;
  if (sub[0] === "branches") return <Branches name={name} refs={refs} onRefs={onRefs} />;
  return <Files name={name} refs={refs} gitRef={gitRef} onRef={onRef} />;
}

function EmptyRepo({ urls }: { urls: { label: string; url: string }[] }) {
  const url = urls[0]?.url ?? "";
  const steps: [string, string][] = [
    ["Push a project you have", `git remote add origin ${url}\ngit push -u origin main`],
    ["Or start one here", `git clone ${url}`],
  ];
  return (
    <>
      <div className="card welcome">
        <Icon name="code" size={40} />
        <h2>Nothing pushed yet</h2>
        <p className="muted">Sign in with any username and a token from Git, Tokens as the password.</p>
      </div>
      {steps.map(([title, cmd]) => (
        <section key={title} className="repo-start">
          <h2>{title}</h2>
          <pre className="code-block">{cmd}</pre>
          <Copy text="Copy" copyText={cmd} plain />
        </section>
      ))}
    </>
  );
}

// Files is the repository's folders on a branch: the bar with the branch, its
// branches and tags, the commit that last changed the folder and how many
// commits there are; then the folder, or a file, and the README.
function Files({ name, refs, gitRef, onRef }: { name: string; refs: Refs; gitRef: string; onRef: (r: string) => void }) {
  const [path, setPath] = useState("");
  const [file, setFile] = useState("");
  const [view, setView] = useState<TreeView | null>(null);
  const [readme, setReadme] = useState<{ name: string; text: string } | null>(null);
  const [problem, setProblem] = useState("");

  useEffect(() => {
    let alive = true;
    setView(null);
    setReadme(null);
    repos.tree(name, gitRef, path).then((t) => {
      if (!alive) return;
      setView(t);
      setProblem("");
      const found = t.entries.find((e) => e.kind === "file" && README.includes(e.name.toLowerCase()));
      if (found) {
        repos.blob(name, gitRef, join(path, found.name)).then((b) => {
          if (alive && b.text !== null) setReadme({ name: found.name, text: b.text });
        }).catch(() => {});
      }
    }).catch((e) => alive && setProblem(message(e)));
    return () => {
      alive = false;
    };
  }, [name, gitRef, path]);

  const crumbs = path ? path.split("/") : [];
  const go = (p: string) => {
    setFile("");
    setPath(p);
  };

  return (
    <>
      <div className="repo-bar">
        <BranchPicker refs={refs} value={gitRef} onChange={(r) => {
          onRef(r);
          setFile("");
        }} />
        <a className="repo-count" href={repoHref(name, "code", "branches")}><Icon name="call_split" size={18} /><b>{refs.branches.length}</b> branch{refs.branches.length === 1 ? "" : "es"}</a>
        <span className="repo-count"><Icon name="sell" size={18} /><b>{refs.tags.length}</b> tag{refs.tags.length === 1 ? "" : "s"}</span>
      </div>

      {view?.last && (
        <div className="last-commit">
          <span className="last-who">{view.last.author}</span>
          <a className="last-subject" href={repoHref(name, "code", "commit", view.last.id)}>{view.last.subject}</a>
          <a className="chip mono" href={repoHref(name, "code", "commit", view.last.id)}>{short(view.last.id)}</a>
          <span className="last-when">{ago(view.last.at)}</span>
          <a className="repo-count" href={repoHref(name, "code", "commits")}><Icon name="history" size={18} /><b>{view.count}</b> commit{view.count === 1 ? "" : "s"}</a>
        </div>
      )}

      <nav className="repo-path" aria-label="Folder">
        {[name, ...crumbs].map((part, i) => (
          <span key={i} className="ex-crumb-wrap">
            {i > 0 && <Icon name="chevron_right" size={16} className="ex-crumb-sep" />}
            <button type="button" className="repo-crumb" onClick={() => go(crumbs.slice(0, i).join("/"))}>{part}</button>
          </span>
        ))}
        {file && <span className="ex-crumb-wrap"><Icon name="chevron_right" size={16} className="ex-crumb-sep" /><span className="repo-crumb on">{file.split("/").pop()}</span></span>}
      </nav>

      {problem ? <Callout tone="bad" icon="error">{problem}</Callout> : file ? (
        <FileView name={name} gitRef={gitRef} path={file} />
      ) : !view ? <div className="repo-loading"><span className="spinner" /></div> : (
        <>
          <div className="card">
            <ul className="repo-tree">
              {path && (
                <li><button type="button" className="repo-entry" onClick={() => go(path.split("/").slice(0, -1).join("/"))}><Icon name="arrow_upward" size={18} /><span>..</span><small /></button></li>
              )}
              {view.entries.map((e) => (
                <li key={e.name}>
                  <button type="button" className="repo-entry" disabled={e.kind === "module"} onClick={() => (e.kind === "dir" ? go(join(path, e.name)) : setFile(join(path, e.name)))}>
                    <Icon name={e.kind === "dir" ? "folder" : e.kind === "module" ? "code" : "draft"} size={18} className={e.kind === "dir" ? "kind folder" : "kind"} />
                    <span>{e.name}</span>
                    <small>{e.kind === "file" && e.size !== null ? bytes(e.size) : e.kind === "module" ? "Submodule" : ""}</small>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          {readme && (
            <section className="card readme">
              <div className="readme-head"><Icon name="description" size={18} />{readme.name}</div>
              <pre>{readme.text}</pre>
            </section>
          )}
        </>
      )}
    </>
  );
}

function FileView({ name, gitRef, path }: { name: string; gitRef: string; path: string }) {
  const [blob, setBlob] = useState<BlobView | null>(null);
  const [problem, setProblem] = useState("");
  useEffect(() => {
    setBlob(null);
    repos.blob(name, gitRef, path).then(setBlob).catch((e) => setProblem(message(e)));
  }, [name, gitRef, path]);

  if (problem) return <Callout tone="bad" icon="error">{problem}</Callout>;
  if (!blob) return <div className="repo-loading"><span className="spinner" /></div>;
  const lines = blob.text?.replace(/\n$/, "").split("\n") ?? [];
  return (
    <div className="card">
      <div className="file-head">
        <span>{blob.text !== null ? `${lines.length} line${lines.length === 1 ? "" : "s"}, ` : ""}{bytes(blob.size)}</span>
        <a className="btn small" href={rawUrl(name, gitRef, path)}><Icon name="download" size={18} />Download</a>
      </div>
      {blob.text !== null ? (
        <div className="file-lines">
          <pre className="file-nums" aria-hidden>{lines.map((_, i) => i + 1).join("\n")}</pre>
          <pre className="file-text">{lines.join("\n")}</pre>
        </div>
      ) : (
        <p className="card-pad muted">{blob.too_big ? "Too big to show here." : "A binary file, not shown here."} Download it to open it.</p>
      )}
    </div>
  );
}

// History is a branch's commits, newest first and grouped by day, each with
// its number, a short form of its ID.
function History({ name, refs, gitRef, onRef }: { name: string; refs: Refs; gitRef: string; onRef: (r: string) => void }) {
  const [list, setList] = useState<CommitLine[] | null>(null);
  const [more, setMore] = useState(false);
  const [problem, setProblem] = useState("");
  const load = useCallback(async (skip: number) => {
    try {
      const page = await repos.log(name, gitRef, skip);
      setList((cur) => (skip ? [...(cur ?? []), ...page.commits] : page.commits));
      setMore(page.more);
      setProblem("");
    } catch (e) {
      setProblem(message(e));
    }
  }, [name, gitRef]);
  useEffect(() => {
    setList(null);
    load(0);
  }, [load]);

  const days: [string, CommitLine[]][] = [];
  for (const c of list ?? []) {
    const day = new Date(c.at * 1000).toLocaleDateString([], { dateStyle: "medium" });
    const last = days[days.length - 1];
    if (last && last[0] === day) last[1].push(c);
    else days.push([day, [c]]);
  }

  return (
    <>
      <div className="repo-bar">
        <a className="btn text" href={repoHref(name, "code")}><Icon name="arrow_back" size={18} />Files</a>
        <BranchPicker refs={refs} value={gitRef} onChange={onRef} />
      </div>
      {problem && <Callout tone="bad" icon="error">{problem}</Callout>}
      {!list ? <div className="repo-loading"><span className="spinner" /></div> : days.map(([day, commits]) => (
        <section key={day} className="history-day">
          <h3><Icon name="commit" size={18} />Commits on {day}</h3>
          <div className="card">
            <ul className="results">
              {commits.map((c) => (
                <li key={c.id}>
                  <div className="result commit-row">
                    <span className="commit-main">
                      <a className="scan-target" href={repoHref(name, "code", "commit", c.id)}>{c.subject}</a>
                      <small>{c.author}, {ago(c.at)}</small>
                    </span>
                    <span className="commit-id">
                      <a className="chip mono" href={repoHref(name, "code", "commit", c.id)}>{short(c.id)}</a>
                      <Copy text="" copyText={c.id} plain />
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>
      ))}
      {more && list && <div className="card-foot"><button type="button" className="btn" onClick={() => load(list.length)}>Show older</button></div>}
    </>
  );
}

function Commit({ name, id }: { name: string; id: string }) {
  const [c, setC] = useState<CommitView | null>(null);
  const [problem, setProblem] = useState("");
  useEffect(() => {
    repos.commit(name, id).then(setC).catch((e) => setProblem(message(e)));
  }, [name, id]);

  if (problem) return <Callout tone="bad" icon="error">{problem}</Callout>;
  if (!c) return <div className="repo-loading"><span className="spinner" /></div>;
  const [subject, ...body] = c.message.split("\n");
  return (
    <>
      <div className="card commit-card">
        <a className="btn text commit-back" href={repoHref(name, "code", "commits")}><Icon name="arrow_back" size={18} />History</a>
        <h2>{subject}</h2>
        {body.join("\n").trim() && <pre className="commit-body">{body.join("\n").trim()}</pre>}
        <div className="page-sub">
          <span><b>{c.author}</b> {new Date(c.at * 1000).toLocaleString()}</span>
          <span className="chip mono">{short(c.id)}</span>
          {c.parents.length > 0 && <span>Parent {c.parents.map((p) => <a key={p} className="mono" href={repoHref(name, "code", "commit", p)}>{short(p)} </a>)}</span>}
        </div>
      </div>
      <Diff patch={c.patch} truncated={c.truncated} />
    </>
  );
}

interface FileDiff { name: string; lines: string[]; added: number; removed: number }

function files(patch: string): FileDiff[] {
  const out: FileDiff[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = line.match(/ b\/(.*)$/);
      out.push({ name: m ? m[1] : line.slice(11), lines: [], added: 0, removed: 0 });
    } else if (out.length && !/^(index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename from|rename to|old mode|new mode)/.test(line)) {
      const f = out[out.length - 1];
      f.lines.push(line);
      if (line.startsWith("+")) f.added++;
      else if (line.startsWith("-")) f.removed++;
    }
  }
  return out;
}

// Diff is changes file by file, each line marked added, removed, context or a
// new part of the file.
export function Diff({ patch, truncated }: { patch: string; truncated: boolean }) {
  const diffs = files(patch);
  if (!diffs.length) return <p className="muted">No changes.</p>;
  return (
    <>
      <p className="diff-summary">{diffs.length} file{diffs.length === 1 ? "" : "s"} changed</p>
      {diffs.map((d) => (
        <section key={d.name} className="card diff">
          <div className="diff-head"><span className="mono">{d.name}</span><span className="diff-stat"><b className="add">+{d.added}</b> <b className="del">-{d.removed}</b></span></div>
          <pre className="diff-lines">
            {d.lines.map((l, i) => (
              <div key={i} className={l.startsWith("@@") ? "hunk" : l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : ""}>{l || " "}</div>
            ))}
          </pre>
        </section>
      ))}
      {truncated && <Callout tone="warn" icon="warning">Only the first part of these changes is shown.</Callout>}
    </>
  );
}

// Branches lists every branch with its last commit and how far it is ahead of
// and behind the default branch; new ones start from any branch.
function Branches({ name, refs, onRefs }: { name: string; refs: Refs; onRefs: () => Promise<void> }) {
  const [list, setList] = useState<Branch[] | null>(null);
  const [making, setMaking] = useState(false);
  const [newName, setNewName] = useState("");
  const [from, setFrom] = useState(refs.default);
  const notify = useNotify();
  const can = useCan();
  useEffect(() => {
    repos.branches(name).then((b) => setList(b.branches)).catch((e) => notify(message(e), "bad"));
  }, [name, notify]);

  const act = async (body: { action: "create" | "delete"; name: string; from?: string }) => {
    try {
      const b = await api.branch(name, body);
      setList(b.branches);
      notify(body.action === "create" ? `Made ${body.name}` : `Deleted ${body.name}`);
      await onRefs();
      return true;
    } catch (e) {
      notify(message(e), "bad");
      return false;
    }
  };

  return (
    <>
      <div className="repo-bar">
        <a className="btn text" href={repoHref(name, "code")}><Icon name="arrow_back" size={18} />Files</a>
        <span className="ex-grow" />
        {can("code.push") && <button type="button" className="btn" onClick={() => setMaking(true)}><Icon name="add" size={18} />New branch</button>}
      </div>
      {!list ? <div className="repo-loading"><span className="spinner" /></div> : (
        <div className="card">
          <ul className="results">
            {list.map((b) => (
              <li key={b.name}>
                <div className="result branch-row">
                  <Icon name="call_split" className="repo-icon" />
                  <span className="commit-main">
                    <span className="branch-name"><span className="mono">{b.name}</span>{b.default && <span className="chip plain">Default</span>}</span>
                    <small>{b.subject}, {b.author}, {ago(b.updated)}</small>
                  </span>
                  <span className="branch-ahead">{b.default ? "" : `${b.behind} behind, ${b.ahead} ahead`}</span>
                  <span className="row-actions">
                    {!b.default && b.ahead > 0 && can("code.discuss") && (
                      <a className="btn small" href={repoHref(name, "pulls", "new", b.name)}>Pull request</a>
                    )}
                    {!b.default && can("code.push") && (
                      <button type="button" className="icon-btn danger" aria-label={`Delete ${b.name}`} title="Delete" onClick={() => act({ action: "delete", name: b.name })}><Icon name="delete" /></button>
                    )}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {making && (
        <Dialog title="New branch" onClose={() => setMaking(false)}>
          <form className="edit-block" onSubmit={async (e) => {
            e.preventDefault();
            if (await act({ action: "create", name: newName.trim(), from })) {
              setMaking(false);
              setNewName("");
            }
          }}>
            <TextField label="Name" autoFocus autoComplete="off" mono value={newName} onChange={setNewName} />
            <div className="tf static">
              <div className="tf-box">
                <BranchPicker refs={refs} value={from} onChange={setFrom} label="From" />
                <span className="tf-label">From</span>
              </div>
            </div>
            <div className="edit-actions">
              <button type="button" className="btn text" onClick={() => setMaking(false)}>Cancel</button>
              <button className="btn primary" disabled={!newName.trim()}>Make branch</button>
            </div>
          </form>
        </Dialog>
      )}
    </>
  );
}

// ---- Settings ----

function Settings({ name, refs, onRefs }: { name: string; refs: Refs; onRefs: (r: Refs) => void }) {
  const can = useCan();
  const notify = useNotify();
  const change = async (patch: { home_only?: boolean; default_branch?: string }, done: string) => {
    try {
      await api.editRepo(name, patch);
      onRefs({ ...refs, home_only: patch.home_only ?? refs.home_only, default: patch.default_branch ?? refs.default });
      notify(done);
    } catch (e) {
      notify(message(e), "bad");
    }
  };
  return (
    <>
      <Card title="General">
        <Row title="Default branch" sub="What the repository opens on, and what clones check out.">
          {refs.branches.length ? (
            <div className="ex-pick">
              <Dropdown label="Default branch" value={refs.default} options={refs.branches.map((b) => ({ value: b.name, label: b.name }))}
                onChange={(b) => can("code.create") && change({ default_branch: b }, `${b} is the default branch`)} />
            </div>
          ) : <span className="muted">Push a branch first</span>}
        </Row>
        <Row title="Home network only" sub="Git reaches this repository only from this host's network or a trusted one.">
          <Switch label="Home network only" on={refs.home_only} disabled={!can("code.create")}
            onChange={(on) => change({ home_only: on }, on ? "Git reaches it only from the home network" : "Git reaches it from anywhere")} />
        </Row>
      </Card>
      {can("code.delete") && (
        <Card title="Danger zone">
          <Row title="Delete this repository" sub="Its history, branches, issues and pull requests go for good.">
            <ArmedButton icon="delete" label="Delete" armedLabel="Delete for good" onConfirm={async () => {
              try {
                await api.removeRepo(name);
                notify(`Deleted ${name}`);
                location.hash = "#/git";
              } catch (e) {
                notify(message(e), "bad");
              }
            }} />
          </Row>
        </Card>
      )}
    </>
  );
}
