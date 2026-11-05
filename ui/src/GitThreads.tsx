import { useCallback, useEffect, useState } from "react";
import { ago, api, message, repos, type Compare, type Refs, type Thread, type ThreadView } from "./api";
import { Dropdown } from "./Dropdown";
import { Diff, repoHref, short } from "./GitRepo";
import { Icon, type IconName } from "./Icon";
import { useCan } from "./me";
import { go } from "./route";
import { Callout, TextField, useNotify } from "./ui";

type Kind = "issue" | "pull";

const WORD: Record<Kind, [string, string, string]> = {
  issue: ["issue", "issues", "issues"],
  pull: ["pull request", "pull requests", "pulls"],
};

// The mark beside an issue or pull request, by what it is and where it stands.
function Mark({ t }: { t: Pick<Thread, "kind" | "state"> }) {
  const [icon, tone]: [IconName, string] =
    t.kind === "issue" ? (t.state === "open" ? ["adjust", "open"] : ["check_circle", "done"])
      : t.state === "merged" ? ["merge", "done"] : t.state === "open" ? ["call_split", "open"] : ["call_split", "shut"];
  return <Icon name={icon} size={20} className={"mark " + tone} />;
}

function stateLabel(t: Pick<Thread, "state">) {
  return t.state === "merged" ? "Merged" : t.state === "open" ? "Open" : "Closed";
}

// Threads is a repository's issues or pull requests: the list, a new one, or
// one of them by number.
export function Threads({ repo, kind, sub, refs }: { repo: string; kind: Kind; sub: string[]; refs: Refs }) {
  if (sub[0] === "new") return <NewThread repo={repo} kind={kind} refs={refs} head={sub[1]} />;
  const number = Number(sub[0]);
  if (sub[0] && number > 0) return <Detail repo={repo} kind={kind} number={number} />;
  return <List repo={repo} kind={kind} />;
}

function List({ repo, kind }: { repo: string; kind: Kind }) {
  const [list, setList] = useState<Thread[] | null>(null);
  const [showing, setShowing] = useState<"open" | "closed">("open");
  const [problem, setProblem] = useState("");
  const can = useCan();
  const [one, many, path] = WORD[kind];
  useEffect(() => {
    repos.threads(repo, path as "issues" | "pulls").then((r) => setList(r.threads)).catch((e) => setProblem(message(e)));
  }, [repo, path]);

  const open = (list ?? []).filter((t) => t.state === "open");
  const closed = (list ?? []).filter((t) => t.state !== "open");
  const shown = showing === "open" ? open : closed;

  return (
    <>
      <div className="repo-bar">
        <div className="seg-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={showing === "open"} className={showing === "open" ? "on" : ""} onClick={() => setShowing("open")}>
            <Mark t={{ kind, state: "open" }} /><b>{open.length}</b> Open
          </button>
          <button type="button" role="tab" aria-selected={showing === "closed"} className={showing === "closed" ? "on" : ""} onClick={() => setShowing("closed")}>
            <Icon name="check" size={18} /><b>{closed.length}</b> Closed
          </button>
        </div>
        <span className="ex-grow" />
        {can("code.discuss") && <a className="btn primary" href={repoHref(repo, path, "new")}><Icon name="add" size={18} />New {one}</a>}
      </div>
      {problem && <Callout tone="bad" icon="error">{problem}</Callout>}
      {!list ? <div className="repo-loading"><span className="spinner" /></div> : shown.length === 0 ? (
        <div className="card welcome">
          <Icon name={kind === "issue" ? "adjust" : "call_split"} size={40} />
          <h2>No {showing} {many}</h2>
          <p className="muted">{kind === "issue" ? "Issues track bugs and work to do." : "Pull requests ask to merge one branch into another."}</p>
        </div>
      ) : (
        <div className="card">
          <ul className="results">
            {shown.map((t) => (
              <li key={t.number}>
                <a className="result thread-row" href={repoHref(repo, path, t.number)}>
                  <Mark t={t} />
                  <span className="commit-main">
                    <span className="scan-target">{t.title}</span>
                    <small>
                      #{t.number} {t.state === "open" ? `opened ${ago(t.created_at)}` : `${stateLabel(t).toLowerCase()} ${ago(t.updated_at)}`} by {t.author}
                      {t.kind === "pull" && <> · <span className="mono">{t.base}</span> ← <span className="mono">{t.head}</span></>}
                    </small>
                  </span>
                  {t.comments > 0 && <span className="thread-comments"><Icon name="chat_bubble" size={16} />{t.comments}</span>}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function BranchOnly({ refs, value, onChange, label }: { refs: Refs; value: string; onChange: (v: string) => void; label: string }) {
  return (
    <div className="tf static branch-field">
      <div className="tf-box">
        <Dropdown label={label} value={value} options={refs.branches.map((b) => ({ value: b.name, label: b.name, icon: "call_split" as IconName }))} onChange={onChange} />
        <span className="tf-label">{label}</span>
      </div>
    </div>
  );
}

// NewThread opens an issue, or a pull request from one branch into another,
// with what it would merge shown first.
function NewThread({ repo, kind, refs, head: preset }: { repo: string; kind: Kind; refs: Refs; head?: string }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [base, setBase] = useState(refs.default);
  const [head, setHead] = useState(preset && refs.branches.some((b) => b.name === preset) ? preset : refs.branches.find((b) => b.name !== refs.default)?.name ?? refs.default);
  const [compare, setCompare] = useState<Compare | null>(null);
  const [busy, setBusy] = useState(false);
  const notify = useNotify();
  const [one, , path] = WORD[kind];

  useEffect(() => {
    if (kind !== "pull" || base === head) {
      setCompare(null);
      return;
    }
    let alive = true;
    repos.compare(repo, base, head).then((c) => {
      if (!alive) return;
      setCompare(c);
      setTitle((t) => t || (c.commits.length === 1 ? c.commits[0].subject : head));
    }).catch((e) => alive && notify(message(e), "bad"));
    return () => {
      alive = false;
    };
  }, [repo, kind, base, head, notify]);

  const ready = title.trim() && (kind === "issue" || (base !== head && (compare?.commits.length ?? 0) > 0));

  return (
    <form className="stack" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      try {
        const made = await api.openThread(repo, { kind, title: title.trim(), body, ...(kind === "pull" ? { base, head } : {}) });
        go(repoHref(repo, path, made.number));
      } catch (err) {
        notify(message(err), "bad");
        setBusy(false);
      }
    }}>
      <h2 className="thread-new-title">New {one}</h2>
      {kind === "pull" && (
        <div className="compare-bar">
          <BranchOnly refs={refs} value={base} onChange={setBase} label="Into" />
          <Icon name="arrow_back" size={20} />
          <BranchOnly refs={refs} value={head} onChange={setHead} label="From" />
          {base === head ? <span className="muted">Pick two different branches</span>
            : compare && (compare.commits.length === 0 ? <span className="muted">{base} already has everything in {head}</span>
              : <span className={"merge-hint " + (compare.mergeable ? "ok" : "bad")}><Icon name={compare.mergeable ? "check" : "warning"} size={18} />{compare.mergeable ? "Able to merge" : "Has conflicts"}</span>)}
        </div>
      )}
      <div className="card thread-form">
        <TextField label="Title" autoFocus autoComplete="off" value={title} onChange={setTitle} />
        <textarea className="text-area" placeholder="Describe it" aria-label="Description" value={body} onChange={(e) => setBody(e.target.value)} rows={8} />
        <div className="edit-actions">
          <a className="btn text" href={repoHref(repo, path)}>Cancel</a>
          <button className="btn primary" disabled={busy || !ready}>{busy && <span className="spinner small on-accent" />}Open {one}</button>
        </div>
      </div>
      {kind === "pull" && compare && compare.commits.length > 0 && (
        <>
          <h3 className="section-title">{compare.commits.length} commit{compare.commits.length === 1 ? "" : "s"}</h3>
          <Commits repo={repo} compare={compare} />
          <Diff patch={compare.patch} truncated={compare.truncated} />
        </>
      )}
    </form>
  );
}

function Commits({ repo, compare }: { repo: string; compare: Compare }) {
  return (
    <div className="card">
      <ul className="results">
        {compare.commits.map((c) => (
          <li key={c.id}>
            <div className="result commit-row">
              <span className="commit-main">
                <a className="scan-target" href={repoHref(repo, "code", "commit", c.id)}>{c.subject}</a>
                <small>{c.author}, {ago(c.at)}</small>
              </span>
              <a className="chip mono" href={repoHref(repo, "code", "commit", c.id)}>{short(c.id)}</a>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Detail is one issue or pull request: what it says and the comments on it;
// a pull request also its commits, its changes and the way to merge it.
function Detail({ repo, kind, number }: { repo: string; kind: Kind; number: number }) {
  const [t, setT] = useState<ThreadView | null>(null);
  const [part, setPart] = useState<"talk" | "commits" | "files">("talk");
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState("");
  const [problem, setProblem] = useState("");
  const notify = useNotify();
  const can = useCan();
  const [one, , path] = WORD[kind];

  const load = useCallback(async () => {
    try {
      setT(await repos.thread(repo, number));
      setProblem("");
    } catch (e) {
      setProblem(message(e));
    }
  }, [repo, number]);
  useEffect(() => {
    load();
  }, [load]);

  const act = async (what: string, work: () => Promise<ThreadView>, done?: string) => {
    setBusy(what);
    try {
      setT(await work());
      if (done) notify(done);
      return true;
    } catch (e) {
      notify(message(e), "bad");
      return false;
    } finally {
      setBusy("");
    }
  };

  if (problem) return <Callout tone="bad" icon="error">{problem}</Callout>;
  if (!t) return <div className="repo-loading"><span className="spinner" /></div>;
  const changes = t.changes;
  const parts: ["talk" | "commits" | "files", string, IconName, number | undefined][] = [
    ["talk", "Conversation", "chat_bubble", t.comments],
    ["commits", "Commits", "commit", changes?.commits.length],
    ["files", "Files changed", "description", undefined],
  ];

  return (
    <>
      <div className="thread-head">
        <a className="btn text" href={repoHref(repo, path)}><Icon name="arrow_back" size={18} />All {WORD[kind][1]}</a>
        <h2>{t.title} <span className="thread-number">#{t.number}</span></h2>
        <div className="page-sub">
          <span className={"state-chip " + (t.state === "open" ? "open" : t.state === "merged" ? "done" : "shut")}><Mark t={t} />{stateLabel(t)}</span>
          {kind === "pull" ? (
            <span><b>{t.author}</b> {t.state === "merged" ? "merged" : "wants to merge"} {changes?.commits.length ?? 0} commit{changes?.commits.length === 1 ? "" : "s"} into <span className="mono">{t.base}</span> from <span className="mono">{t.head}</span></span>
          ) : (
            <span><b>{t.author}</b> opened this {one} {ago(t.created_at)}</span>
          )}
        </div>
      </div>

      {kind === "pull" && (
        <div className="seg-tabs thread-parts" role="tablist">
          {parts.map(([key, label, icon, count]) => (
            <button key={key} type="button" role="tab" aria-selected={part === key} className={part === key ? "on" : ""} onClick={() => setPart(key)}>
              <Icon name={icon} size={18} />{label}{count !== undefined && <span className="count">{count}</span>}
            </button>
          ))}
        </div>
      )}

      {kind === "pull" && part === "commits" && changes && <Commits repo={repo} compare={changes} />}
      {kind === "pull" && part === "files" && changes && <Diff patch={changes.patch} truncated={changes.truncated} />}
      {changes?.error && part !== "talk" && <Callout tone="warn" icon="warning">{changes.error}</Callout>}

      {(kind === "issue" || part === "talk") && (
        <div className="timeline">
          <article className="card note">
            <header><b>{t.author}</b><span>{ago(t.created_at)}</span></header>
            <div className="note-body">{t.body.trim() || <span className="muted">No description.</span>}</div>
          </article>
          {t.thread.map((c) => (
            <article key={c.id} className="card note">
              <header><b>{c.author}</b><span>{ago(c.created_at)}</span></header>
              <div className="note-body">{c.body}</div>
            </article>
          ))}

          {kind === "pull" && t.state === "merged" && (
            <div className="merge-box done"><Icon name="merge" size={22} /><span>Merged into <span className="mono">{t.base}</span>{t.merged_commit && <> as <a className="mono" href={repoHref(repo, "code", "commit", t.merged_commit)}>{short(t.merged_commit)}</a></>}</span></div>
          )}
          {kind === "pull" && t.state === "open" && changes && !changes.error && (
            <div className={"merge-box " + (changes.mergeable ? "ok" : "bad")}>
              <Icon name={changes.mergeable ? "check_circle" : "warning"} size={22} />
              <span>{changes.commits.length === 0 ? `${t.base} already has everything in ${t.head}` : changes.mergeable ? "No conflicts with the base branch" : `Conflicts with ${t.base}; resolve them in ${t.head} and push again`}</span>
              <span className="ex-grow" />
              {can("code.push") && (
                <button type="button" className="btn primary" disabled={!changes.mergeable || changes.commits.length === 0 || !!busy}
                  onClick={() => act("merge", () => api.merge(repo, number), "Merged")}>
                  {busy === "merge" && <span className="spinner small on-accent" />}<Icon name="merge" size={18} />Merge
                </button>
              )}
            </div>
          )}

          {can("code.discuss") && (
            <form className="card note reply" onSubmit={async (e) => {
              e.preventDefault();
              if (await act("comment", () => api.comment(repo, number, reply))) setReply("");
            }}>
              <textarea className="text-area" placeholder="Leave a comment" aria-label="Comment" value={reply} onChange={(e) => setReply(e.target.value)} rows={4} />
              <div className="edit-actions">
                {t.state !== "merged" && (
                  <button type="button" className="btn" disabled={!!busy}
                    onClick={() => act("state", () => api.editThread(repo, number, { state: t.state === "open" ? "closed" : "open" }), t.state === "open" ? `Closed #${number}` : `Reopened #${number}`)}>
                    {t.state === "open" ? `Close ${one}` : `Reopen ${one}`}
                  </button>
                )}
                <button className="btn primary" disabled={!!busy || !reply.trim()}>{busy === "comment" && <span className="spinner small on-accent" />}Comment</button>
              </div>
            </form>
          )}
        </div>
      )}
    </>
  );
}
