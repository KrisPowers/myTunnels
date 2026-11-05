import { useCallback, useEffect, useState } from "react";
import { ago, api, bytes, message, rawUrl, repos, type BlobView, type CommitLine, type CommitView, type Refs, type Repo, type TreeEntry } from "./api";
import { Dropdown, type Option } from "./Dropdown";
import { Icon } from "./Icon";
import { useCan } from "./me";
import { ArmedButton, Callout, Copy, Dialog, Switch, useNotify } from "./ui";

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const short = (id: string) => id.slice(0, 7);
const README = ["readme.md", "readme", "readme.txt", "readme.markdown"];

// RepoList is the repositories, the latest change first.
export function RepoList({ list, href, onNew }: { list: Repo[]; href: (name: string) => string; onNew?: () => void }) {
  if (!list.length) {
    return (
      <div className="card welcome">
        <Icon name="code" size={40} />
        <h2>No repositories yet</h2>
        <p className="muted">Make one, then push to it with git from anywhere you work.</p>
        {onNew && <button type="button" className="btn primary" onClick={onNew}><Icon name="add" size={18} />New repository</button>}
      </div>
    );
  }
  return (
    <div className="card">
      <ul className="results">
        {list.map((r) => (
          <li key={r.name}>
            <a className="result repo-row" href={href(r.name)}>
              <Icon name="code" className="repo-icon" />
              <span className="scan-target">{r.name}</span>
              <span className="result-meta">{r.empty ? <span className="chip">Empty</span> : <><span className="chip mono">{r.branch}</span>{r.updated && <span>Updated {ago(r.updated)}</span>}</>}</span>
              <Icon name="chevron_right" className="result-go" />
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

type Open = { kind: "tree" } | { kind: "file"; path: string } | { kind: "commit"; id: string };

// RepoView is one repository: its files on a branch, its commits, one file or
// one commit's changes, and how to clone it.
export function RepoView({ name, back, cloneUrls, admin, onRemoved }: {
  name: string;
  back: string;
  cloneUrls: { label: string; url: string }[];
  admin?: boolean;
  onRemoved?: () => void;
}) {
  const [refs, setRefs] = useState<Refs | null>(null);
  const [ref, setRef] = useState("");
  const [tab, setTab] = useState<"files" | "commits">("files");
  const [path, setPath] = useState("");
  const [open, setOpen] = useState<Open>({ kind: "tree" });
  const [cloning, setCloning] = useState(false);
  const [problem, setProblem] = useState("");
  const notify = useNotify();
  const can = useCan();

  useEffect(() => {
    repos.refs(name).then((r) => {
      setRefs(r);
      setRef((cur) => cur || (r.branches.some((b) => b.name === r.default) ? r.default : r.branches[0]?.name ?? ""));
      setProblem("");
    }).catch((e) => setProblem(message(e)));
  }, [name]);

  const empty = refs !== null && refs.branches.length === 0;
  const refOptions: Option<string>[] = [
    ...(refs?.branches ?? []).map((b) => ({ value: b.name, label: b.name, hint: b.name === refs?.default ? "Default branch" : undefined })),
    ...(refs?.tags ?? []).map((t) => ({ value: t.name, label: t.name, hint: "Tag" })),
  ];
  const crumbs = path ? path.split("/") : [];

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1 className="d-crumbs">
            <span className="ex-crumb-wrap"><a className="d-crumb" href={back}>Code</a></span>
            <span className="ex-crumb-wrap"><Icon name="chevron_right" size={24} className="ex-crumb-sep" /><span className="d-crumb on">{name}</span></span>
          </h1>
          {refs && !empty && <div className="page-sub"><span><b>{refs.branches.length}</b> branch{refs.branches.length === 1 ? "" : "es"}</span><span><b>{refs.tags.length}</b> tag{refs.tags.length === 1 ? "" : "s"}</span></div>}
        </div>
        <div className="page-actions">
          {refs && (
            <label className="edit-switch" title="Git reaches this repository only from this host's network or a trusted one">
              <Switch label="Home network only" on={refs.home_only} disabled={!can("code.create")} onChange={async (on) => {
                try {
                  await api.editRepo(name, { home_only: on });
                  setRefs({ ...refs, home_only: on });
                  notify(on ? "Git reaches it only from the home network" : "Git reaches it from anywhere");
                } catch (e) {
                  notify(message(e), "bad");
                }
              }} />
              <span>Home network only</span>
            </label>
          )}
          <button type="button" className="btn primary" onClick={() => setCloning(true)}><Icon name="content_copy" size={18} />Clone</button>
          {admin && (
            <ArmedButton icon="delete" label="Delete" armedLabel="Delete for good" onConfirm={async () => {
              try {
                await api.removeRepo(name);
                notify(`Deleted ${name}`);
                onRemoved?.();
              } catch (e) {
                notify(message(e), "bad");
              }
            }} />
          )}
        </div>
      </div>
      {problem && <Callout tone="bad" icon="error">{problem}</Callout>}

      {empty ? (
        <EmptyRepo urls={cloneUrls} />
      ) : refs && ref && (
        <div className="page-body">
          <div className="repo-bar">
            <div className="ex-pick repo-ref">
              <Dropdown label="Branch" value={ref} options={refOptions} onChange={(r) => {
                setRef(r);
                setOpen({ kind: "tree" });
              }} />
            </div>
            <div className="repo-tabs" role="tablist">
              {(["files", "commits"] as const).map((t) => (
                <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => {
                  setTab(t);
                  setOpen({ kind: "tree" });
                }}>
                  <Icon name={t === "files" ? "folder" : "commit"} size={18} />{t === "files" ? "Files" : "Commits"}
                </button>
              ))}
            </div>
          </div>

          {open.kind === "commit" ? (
            <Commit name={name} id={open.id} onBack={() => setOpen({ kind: "tree" })} />
          ) : tab === "commits" ? (
            <Commits name={name} ref_={ref} onOpen={(id) => setOpen({ kind: "commit", id })} />
          ) : (
            <>
              <nav className="repo-path" aria-label="Folder">
                {[name, ...crumbs].map((part, i) => (
                  <span key={i} className="ex-crumb-wrap">
                    {i > 0 && <Icon name="chevron_right" size={16} className="ex-crumb-sep" />}
                    <button type="button" className="repo-crumb" onClick={() => {
                      setPath(crumbs.slice(0, i).join("/"));
                      setOpen({ kind: "tree" });
                    }}>{part}</button>
                  </span>
                ))}
                {open.kind === "file" && (
                  <span className="ex-crumb-wrap"><Icon name="chevron_right" size={16} className="ex-crumb-sep" /><span className="repo-crumb on">{open.path.split("/").pop()}</span></span>
                )}
              </nav>
              {open.kind === "file" ? (
                <FileView name={name} ref_={ref} path={open.path} />
              ) : (
                <Tree name={name} ref_={ref} path={path} onDir={(p) => setPath(p)} onFile={(p) => setOpen({ kind: "file", path: p })} />
              )}
            </>
          )}
        </div>
      )}

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
          <p className="muted">When git asks, any username, and a token from Code, Tokens as the password.</p>
        </Dialog>
      )}
    </>
  );
}

// EmptyRepo is how to fill a repository that has nothing in it yet.
function EmptyRepo({ urls }: { urls: { label: string; url: string }[] }) {
  const url = urls[0]?.url ?? "";
  const steps = [
    ["Push a project you have", `git remote add origin ${url}\ngit push -u origin main`],
    ["Or start one here", `git clone ${url}`],
  ];
  return (
    <div className="page-body stack">
      <div className="card welcome">
        <Icon name="code" size={40} />
        <h2>Nothing pushed yet</h2>
        <p className="muted">Sign in with any username and a token from Code, Tokens as the password.</p>
      </div>
      {steps.map(([title, cmd]) => (
        <section key={title} className="repo-start">
          <h2>{title}</h2>
          <pre className="code-block">{cmd}</pre>
          <Copy text="Copy" copyText={cmd} plain />
        </section>
      ))}
    </div>
  );
}

function Tree({ name, ref_, path, onDir, onFile }: { name: string; ref_: string; path: string; onDir: (p: string) => void; onFile: (p: string) => void }) {
  const [entries, setEntries] = useState<TreeEntry[] | null>(null);
  const [readme, setReadme] = useState<{ name: string; text: string } | null>(null);
  const [problem, setProblem] = useState("");

  useEffect(() => {
    let alive = true;
    setEntries(null);
    setReadme(null);
    repos.tree(name, ref_, path).then((t) => {
      if (!alive) return;
      setEntries(t.entries);
      setProblem("");
      const found = t.entries.find((e) => e.kind === "file" && README.includes(e.name.toLowerCase()));
      if (found) {
        repos.blob(name, ref_, join(path, found.name)).then((b) => {
          if (alive && b.text !== null) setReadme({ name: found.name, text: b.text });
        }).catch(() => {});
      }
    }).catch((e) => alive && setProblem(message(e)));
    return () => {
      alive = false;
    };
  }, [name, ref_, path]);

  if (problem) return <Callout tone="bad" icon="error">{problem}</Callout>;
  if (!entries) return <div className="repo-loading"><span className="spinner" /></div>;
  return (
    <div className="stack">
      <div className="card">
        <ul className="repo-tree">
          {path && (
            <li><button type="button" className="repo-entry" onClick={() => onDir(path.split("/").slice(0, -1).join("/"))}><Icon name="arrow_upward" size={18} /><span>..</span></button></li>
          )}
          {entries.map((e) => (
            <li key={e.name}>
              <button type="button" className="repo-entry" disabled={e.kind === "module"} onClick={() => (e.kind === "dir" ? onDir(join(path, e.name)) : onFile(join(path, e.name)))}>
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
    </div>
  );
}

function FileView({ name, ref_, path }: { name: string; ref_: string; path: string }) {
  const [blob, setBlob] = useState<BlobView | null>(null);
  const [problem, setProblem] = useState("");
  useEffect(() => {
    setBlob(null);
    repos.blob(name, ref_, path).then(setBlob).catch((e) => setProblem(message(e)));
  }, [name, ref_, path]);

  if (problem) return <Callout tone="bad" icon="error">{problem}</Callout>;
  if (!blob) return <div className="repo-loading"><span className="spinner" /></div>;
  const lines = blob.text?.replace(/\n$/, "").split("\n") ?? [];
  return (
    <div className="card file-view">
      <div className="file-head">
        <span>{blob.text !== null ? `${lines.length} line${lines.length === 1 ? "" : "s"}, ` : ""}{bytes(blob.size)}</span>
        <a className="btn small" href={rawUrl(name, ref_, path)}><Icon name="download" size={18} />Download</a>
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

function Commits({ name, ref_, onOpen }: { name: string; ref_: string; onOpen: (id: string) => void }) {
  const [list, setList] = useState<CommitLine[] | null>(null);
  const [more, setMore] = useState(false);
  const [problem, setProblem] = useState("");
  const load = useCallback(async (skip: number) => {
    try {
      const page = await repos.log(name, ref_, skip);
      setList((cur) => (skip ? [...(cur ?? []), ...page.commits] : page.commits));
      setMore(page.more);
      setProblem("");
    } catch (e) {
      setProblem(message(e));
    }
  }, [name, ref_]);
  useEffect(() => {
    setList(null);
    load(0);
  }, [load]);

  if (problem) return <Callout tone="bad" icon="error">{problem}</Callout>;
  if (!list) return <div className="repo-loading"><span className="spinner" /></div>;
  return (
    <div className="card">
      <ul className="results">
        {list.map((c) => (
          <li key={c.id}>
            <button type="button" className="result commit-row" onClick={() => onOpen(c.id)}>
              <Icon name="commit" className="repo-icon" />
              <span className="commit-main"><span className="scan-target">{c.subject}</span><small>{c.author}, {ago(c.at)}</small></span>
              <span className="chip mono">{short(c.id)}</span>
            </button>
          </li>
        ))}
      </ul>
      {more && <div className="card-foot"><button type="button" className="btn" onClick={() => load(list.length)}>Show older</button></div>}
    </div>
  );
}

interface FileDiff { name: string; lines: string[] }

// The changes of a commit, file by file, each line marked added, removed,
// context or a new part of the file.
function files(patch: string): FileDiff[] {
  const out: FileDiff[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = line.match(/ b\/(.*)$/);
      out.push({ name: m ? m[1] : line.slice(11), lines: [] });
    } else if (out.length && !/^(index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename from|rename to|old mode|new mode)/.test(line)) {
      out[out.length - 1].lines.push(line);
    }
  }
  return out;
}

function Commit({ name, id, onBack }: { name: string; id: string; onBack: () => void }) {
  const [c, setC] = useState<CommitView | null>(null);
  const [problem, setProblem] = useState("");
  useEffect(() => {
    repos.commit(name, id).then(setC).catch((e) => setProblem(message(e)));
  }, [name, id]);

  if (problem) return <Callout tone="bad" icon="error">{problem}</Callout>;
  if (!c) return <div className="repo-loading"><span className="spinner" /></div>;
  const [subject, ...body] = c.message.split("\n");
  const diffs = files(c.patch);
  return (
    <div className="stack">
      <div className="card commit-card">
        <button type="button" className="btn text commit-back" onClick={onBack}><Icon name="arrow_back" size={18} />Commits</button>
        <h2>{subject}</h2>
        {body.join("\n").trim() && <pre className="commit-body">{body.join("\n").trim()}</pre>}
        <div className="page-sub">
          <span><b>{c.author}</b> {new Date(c.at * 1000).toLocaleString()}</span>
          <span className="chip mono">{short(c.id)}</span>
          {c.parents.length > 0 && <span>Parent {c.parents.map(short).join(", ")}</span>}
          <span>{diffs.length} file{diffs.length === 1 ? "" : "s"} changed</span>
        </div>
      </div>
      {diffs.map((d) => (
        <section key={d.name} className="card diff">
          <div className="diff-head mono">{d.name}</div>
          <pre className="diff-lines">
            {d.lines.map((l, i) => (
              <div key={i} className={l.startsWith("@@") ? "hunk" : l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : ""}>{l || " "}</div>
            ))}
          </pre>
        </section>
      ))}
      {c.truncated && <Callout tone="warn" icon="warning">Only the first part of these changes is shown.</Callout>}
    </div>
  );
}
