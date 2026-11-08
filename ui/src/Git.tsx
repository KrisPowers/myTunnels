import { useCallback, useContext, useEffect, useState, type FormEvent } from "react";
import { ago, api, message, repos, type CodeState, type Repo, type User, type Zone } from "./api";
import { Dropdown, type Option } from "./Dropdown";
import { NameDialog } from "./Files";
import { RepoPage } from "./GitRepo";
import { Icon, type IconName } from "./Icon";
import { MeContext, useCan } from "./me";
import { AddressEditor } from "./Tunnels";
import { Callout, Card, Copy, Dialog, Row, TextField, useNotify } from "./ui";

// The colours languages are known by, as code hosts show them.
const LANGUAGE_COLORS: Record<string, string> = {
  Rust: "#dea584", TypeScript: "#3178c6", JavaScript: "#f1e05a", Python: "#3572a5", Go: "#00add8",
  Java: "#b07219", Kotlin: "#a97bff", Swift: "#f05138", C: "#555555", "C++": "#f34b7d", "C#": "#178600",
  Ruby: "#701516", PHP: "#4f5d95", HTML: "#e34c26", CSS: "#563d7c", SCSS: "#c6538c", Vue: "#41b883",
  Svelte: "#ff3e00", Shell: "#89e051", PowerShell: "#012456", Lua: "#000080", Dart: "#00b4ab",
  SQL: "#e38c00", Zig: "#ec915c", Elixir: "#6e4a7e", Haskell: "#5e5086", Scala: "#c22d40", R: "#198ce7", Nix: "#7e7eff",
};

export function Language({ name }: { name: string }) {
  return (
    <span className="lang-pill">
      <i style={{ background: LANGUAGE_COLORS[name] ?? "var(--text-3)" }} />
      {name}
    </span>
  );
}

// Activity is a repository's commits over the last weeks, a bar a week.
function Activity({ weeks }: { weeks: number[] }) {
  const top = Math.max(1, ...weeks);
  const total = weeks.reduce((n, w) => n + w, 0);
  return (
    <svg className="activity" viewBox={`0 0 ${weeks.length * 4} 24`} preserveAspectRatio="none" role="img"
      aria-label={`${total} commit${total === 1 ? "" : "s"} in the last ${weeks.length} weeks`}>
      <title>{`${total} commit${total === 1 ? "" : "s"} in the last ${weeks.length} weeks`}</title>
      {weeks.map((w, i) => {
        const h = w ? Math.max(2, (w / top) * 24) : 1;
        return <rect key={i} x={i * 4} y={24 - h} width={3} height={h} rx={0.8} className={w ? "on" : ""} />;
      })}
    </svg>
  );
}

// GitPage is Git: the repositories on this host and the tokens git signs in
// with; `#/git/r/<name>/...` is one repository. Git's address, once
// published, is for git alone. What each person may do is their Git
// permissions.
export function GitPage({ id, page, more, users, onChanged }: { id: string; page: string; more: string[]; users: User[]; onChanged: () => Promise<void> }) {
  const [state, setState] = useState<CodeState | null>(null);
  const [list, setList] = useState<Repo[] | null>(null);
  const [problem, setProblem] = useState("");
  const [asking, setAsking] = useState<"" | "repo" | "address" | "move">("");
  const notify = useNotify();
  const can = useCan();

  const load = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([api.code(), repos.list()]);
      setState(s);
      setList(r.repos);
      setProblem("");
    } catch (e) {
      setProblem(message(e));
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const route = state?.route ?? null;
  if (id === "r" && page) {
    const urls = [
      ...(route ? [{ label: "From anywhere", url: `https://${route.hostname}/${page}.git` }] : []),
      ...(["localhost", "127.0.0.1"].includes(location.hostname) ? [{ label: "On this computer", url: `${location.origin}/git/${page}.git` }] : []),
    ];
    return <RepoPage name={page} tab={more[0] ?? "code"} sub={more.slice(1)} cloneUrls={urls} />;
  }
  if (!state) return problem ? <Callout tone="bad" icon="error">{problem}</Callout> : null;

  const pages: [string, string, IconName][] = [["", "Repositories", "code"], ["tokens", "Tokens", "key"]];
  const current = id === "tokens" ? "tokens" : "";

  const pin = async (r: Repo) => {
    try {
      await api.pinRepo(r.name, !r.pinned);
      await load();
    } catch (e) {
      notify(message(e), "bad");
    }
  };

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Git</h1>
          <div className="page-sub">
            {route ? (
              <span className="inline-edit">
                <span className="mono">{route.hostname}</span>
                {can("tunnels.edit") && <button type="button" className="icon-btn small" aria-label="Change address" title="Change address" onClick={() => setAsking("move")}><Icon name="edit" size={18} /></button>}
              </span>
            ) : <span>On this network only</span>}
            {list && <span><b>{list.length}</b> repositor{list.length === 1 ? "y" : "ies"}</span>}
          </div>
        </div>
        <div className="page-actions">
          {!route && can("tunnels.create") && <button type="button" className="btn" onClick={() => setAsking("address")}><Icon name="public" size={18} />Publish an address</button>}
          {can("code.create") && <button type="button" className="btn primary" onClick={() => setAsking("repo")}><Icon name="add" size={18} />New repository</button>}
        </div>
      </div>
      <nav className="sub-nav" aria-label="Sub-pages">
        {pages.map(([key, label, icon]) => (
          <a key={key} className={"sub-nav-item" + (current === key ? " on" : "")} href={key ? `#/git/${key}` : "#/git"} aria-current={current === key ? "page" : undefined}>
            <Icon name={icon} size={18} />
            <span>{label}</span>
          </a>
        ))}
      </nav>
      <div className="page-body stack plain" key={current}>
        {problem && <Callout tone="bad" icon="error">{problem}</Callout>}
        {current === "" && list && (list.length === 0 ? (
          <div className="card welcome">
            <Icon name="code" size={40} />
            <h2>No repositories yet</h2>
            <p className="muted">Make one, then push to it with git from anywhere you work.</p>
            {can("code.create") && <button type="button" className="btn primary" onClick={() => setAsking("repo")}><Icon name="add" size={18} />New repository</button>}
          </div>
        ) : (
          <ul className="catalog">
            {list.map((r) => (
              <li key={r.name} className="catalog-row">
                <div className="catalog-main">
                  <a className="catalog-name" href={`#/git/r/${encodeURIComponent(r.name)}`}>{r.name}</a>
                  <div className="catalog-meta">
                    {r.language && <Language name={r.language} />}
                    <span>{r.updated ? `Updated ${ago(r.updated)}` : "Nothing pushed yet"}</span>
                  </div>
                </div>
                <Activity weeks={r.activity} />
                <button type="button" className={"pin-btn" + (r.pinned ? " on" : "")} aria-pressed={r.pinned}
                  aria-label={r.pinned ? `Unpin ${r.name}` : `Pin ${r.name}`} title={r.pinned ? "Unpin" : "Pin"} onClick={() => pin(r)}>
                  <Icon name="push_pin" size={18} />
                  <span>{r.pinned ? "Pinned" : "Pin"}</span>
                </button>
              </li>
            ))}
          </ul>
        ))}
        {current === "tokens" && <Tokens state={state} users={users} onState={setState} />}
      </div>

      {asking === "repo" && (
        <NameDialog title="New repository" label="Name" initial="" action="Create" onClose={() => setAsking("")}
          onSave={async (name) => {
            await api.createRepo(name);
            setAsking("");
            notify(`Created ${name}`);
            location.hash = `#/git/r/${encodeURIComponent(name)}`;
          }} />
      )}
      {asking === "address" && (
        <Publish onClose={() => setAsking("")} onDone={async () => {
          setAsking("");
          await onChanged();
          await load();
        }} />
      )}
      {asking === "move" && route && (
        <AddressEditor route={route} onDone={() => setAsking("")} onChanged={async () => {
          await onChanged();
          await load();
        }} />
      )}
    </>
  );
}

// Publish gives Git an address on one of the domains, for git away from home.
function Publish({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const [zones, setZones] = useState<Zone[] | null>(null);
  const [zone, setZone] = useState("");
  const [sub, setSub] = useState("git");
  const [busy, setBusy] = useState(false);
  const notify = useNotify();

  useEffect(() => {
    api.zones().then((z) => {
      setZones(z);
      setZone((current) => current || z[0]?.id || "");
    }).catch((e) => notify(message(e), "bad"));
  }, [notify]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const route = await api.publish({
        subdomain: sub, zone_id: zone, port: 0, target_host: null, target_scheme: "code", preserve_host: false,
        require_lan: false, require_password: false, require_login: false, require_code: false, oauth: [],
        login_max: 7 * 86_400, login_idle: 0, policy_mode: "all",
      });
      notify(`Published ${route.hostname}`);
      await onDone();
    } catch (err) {
      notify(message(err), "bad");
      setBusy(false);
    }
  };

  return (
    <Dialog title="Publish an address" onClose={onClose}>
      <form onSubmit={submit}>
        <p className="muted">Where git reaches these repositories from anywhere.</p>
        <div className="edit-row">
          <TextField className="grow" label="Subdomain" autoFocus autoComplete="off" value={sub}
            onChange={(v) => setSub(v.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 63))} />
          <span className="composer-dot">.</span>
          <div className="tf static grow">
            <div className="tf-box">
              {zones && zones.length > 0 ? (
                <Dropdown label="Domain" value={zone} options={zones.map((z) => ({ value: z.id, label: z.name }))} onChange={setZone} />
              ) : (
                <span className="dropdown placeholder">{zones ? "No domains on this account" : "Loading domains"}</span>
              )}
              <span className="tf-label">Domain</span>
            </div>
          </div>
        </div>
        <div className="edit-actions">
          <button type="button" className="btn text" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !sub || !zone}>{busy && <span className="spinner small on-accent" />}Publish</button>
        </div>
      </form>
    </Dialog>
  );
}

// Tokens are what git signs in with, as the password: each person's own, or
// anyone's for those who manage them, shown once when made.
function Tokens({ state, users, onState }: { state: CodeState; users: User[]; onState: (s: CodeState) => void }) {
  const can = useCan();
  const me = useContext(MeContext);
  const self = me?.id ?? "admin";
  const [making, setMaking] = useState(false);
  const [name, setName] = useState("");
  const [owner, setOwner] = useState(self);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const notify = useNotify();
  const nameOf = (id: string) => {
    if (id === "admin") return "Host";
    const u = users.find((x) => x.id === id);
    return u ? u.name || u.username : "Removed account";
  };
  const owners: Option<string>[] = [
    { value: "admin", label: "Host", hint: "Every repository" },
    ...users.map((u) => ({ value: u.id, label: u.name || u.username, hint: u.email })),
  ];
  const close = () => {
    setMaking(false);
    setSecret("");
    setName("");
    setOwner(self);
  };

  return (
    <>
      <Card title="Tokens" sub={state.tokens.length ? "Git asks for a username and password: any username, and a token as the password." : "None yet. Make one to clone and push with git."}
        action={<button type="button" className="btn" onClick={() => setMaking(true)}><Icon name="add" size={18} />New token</button>}>
        {state.tokens.map((t) => (
          <Row key={t.id} title={t.name} sub={`${nameOf(t.owner)}, made ${ago(t.created_at)}, ${t.last_used ? `used ${ago(t.last_used)}` : "never used"}`}>
            <button type="button" className="icon-btn danger" aria-label={`Remove ${t.name}`} title="Remove"
              onClick={async () => {
                try {
                  onState(await api.removeToken(t.id));
                  notify(`Removed ${t.name}`);
                } catch (e) {
                  notify(message(e), "bad");
                }
              }}>
              <Icon name="delete" />
            </button>
          </Row>
        ))}
      </Card>
      {making && (
        <Dialog title={secret ? "Your new token" : "New token"} onClose={close}>
          {secret ? (
            <>
              <p className="muted">Copy it now; it is not shown again. Use it as the password when git asks.</p>
              <div className="token-secret"><Copy text={secret} /></div>
              <div className="edit-actions"><button type="button" className="btn primary" onClick={close}>Done</button></div>
            </>
          ) : (
            <form onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                const made = await api.addToken(name.trim(), owner);
                onState(made);
                setSecret(made.secret);
              } catch (err) {
                notify(message(err), "bad");
              } finally {
                setBusy(false);
              }
            }}>
              <TextField label="Name" autoFocus autoComplete="off" placeholder="Laptop" value={name} onChange={setName} />
              {can("code.tokens") && (
                <div className="tf static">
                  <div className="tf-box">
                    <Dropdown label="For" value={owner} options={owners} onChange={setOwner} />
                    <span className="tf-label">For</span>
                  </div>
                </div>
              )}
              <div className="edit-actions">
                <button type="button" className="btn text" onClick={close}>Cancel</button>
                <button className="btn primary" disabled={busy || !name.trim()}>{busy && <span className="spinner small on-accent" />}Make token</button>
              </div>
            </form>
          )}
        </Dialog>
      )}
    </>
  );
}
