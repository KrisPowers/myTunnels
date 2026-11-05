import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ago, api, editOf, message, repos, type Access, type CodeState, type OAuthProvider, type Repo, type RepoRule, type Route, type RouteEdit, type User, type Zone } from "./api";
import { Dropdown, type Option } from "./Dropdown";
import { NameDialog } from "./Files";
import { Icon, type IconName } from "./Icon";
import { RepoList, RepoView } from "./Repo";
import { AccessCard, AddressEditor, TunnelLogs } from "./Tunnels";
import { AddMenu, Avatar, Callout, Card, Copy, Dialog, Row, Switch, TextField, useNotify } from "./ui";

const MODES: Option<RepoRule["mode"]>[] = [
  { value: "read", label: "Read only", hint: "Browse and clone" },
  { value: "write", label: "Read and write", hint: "Push as well" },
];

// CodePage is Code: git repositories kept on this host, the tokens git signs
// in with, and, once it has an address, who may open which repository there.
// `#/code/repos/<name>` is one repository.
export function CodePage({ id, page, users, providers, onChanged }: { id: string; page: string; users: User[]; providers: OAuthProvider[]; onChanged: () => Promise<void> }) {
  const [state, setState] = useState<CodeState | null>(null);
  const [list, setList] = useState<Repo[] | null>(null);
  const [problem, setProblem] = useState("");
  const [asking, setAsking] = useState<"" | "repo" | "address" | "move">("");
  const notify = useNotify();

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
  const cloneUrls = (name: string) => [
    ...(route ? [{ label: "From anywhere", url: `https://${route.hostname}/${name}.git` }] : []),
    { label: "On this network", url: `${location.origin}/git/${name}.git` },
  ];

  if (id === "repos" && page) {
    return <RepoView name={page} back="#/code" cloneUrls={cloneUrls(page)} admin onRemoved={() => (location.hash = "#/code")} />;
  }
  if (!state) return problem ? <Callout tone="bad" icon="error">{problem}</Callout> : null;

  const pages: [string, string, IconName][] = [
    ["repos", "Repositories", "code"],
    ["tokens", "Tokens", "key"],
    ...(route ? [["access", "Access Control", "shield"], ["activity", "Activity", "history"]] as [string, string, IconName][] : []),
  ];
  const current = pages.some(([k]) => k === id) ? id : "repos";

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Code</h1>
          <div className="page-sub">
            {route ? (
              <span className="inline-edit">
                <span>{route.hostname}</span>
                <button type="button" className="icon-btn small" aria-label="Change address" title="Change address" onClick={() => setAsking("move")}><Icon name="edit" size={18} /></button>
              </span>
            ) : <span>On this network only</span>}
            {list && <span><b>{list.length}</b> repositor{list.length === 1 ? "y" : "ies"}</span>}
          </div>
        </div>
        <div className="page-actions">
          {route ? (
            <a className="btn" href={`https://${route.hostname}`} target="_blank" rel="noreferrer"><Icon name="open_in_new" size={18} />Open</a>
          ) : (
            <button type="button" className="btn" onClick={() => setAsking("address")}><Icon name="public" size={18} />Publish an address</button>
          )}
          <button type="button" className="btn primary" onClick={() => setAsking("repo")}><Icon name="add" size={18} />New repository</button>
        </div>
      </div>
      <nav className="sub-nav" aria-label="Sub-pages">
        {pages.map(([key, label, icon]) => (
          <a key={key} className={"sub-nav-item" + (current === key ? " on" : "")} href={`#/code/${key}`} aria-current={current === key ? "page" : undefined}>
            <Icon name={icon} size={18} />
            <span>{label}</span>
          </a>
        ))}
      </nav>
      <div className="page-body stack plain" key={current}>
        {problem && <Callout tone="bad" icon="error">{problem}</Callout>}
        {current === "repos" && list && <RepoList list={list} href={(name) => `#/code/repos/${name}`} onNew={() => setAsking("repo")} />}
        {current === "tokens" && <Tokens state={state} users={users} onState={setState} />}
        {current === "access" && route && (
          <CodeAccess route={route} rules={state.rules} repos={list ?? []} users={users} providers={providers}
            onChanged={async () => {
              await onChanged();
              await load();
            }}
            onRules={setState} />
        )}
        {current === "activity" && route && <TunnelLogs route={route} users={users} />}
      </div>

      {asking === "repo" && (
        <NameDialog title="New repository" label="Name" initial="" action="Create" onClose={() => setAsking("")}
          onSave={async (name) => {
            const made = await api.createRepo(name);
            setList(made.repos);
            setAsking("");
            notify(`Created ${name}`);
            location.hash = `#/code/repos/${encodeURIComponent(name)}`;
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

// Publish gives Code an address on one of the domains, for git and browsers
// away from home.
function Publish({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const [zones, setZones] = useState<Zone[] | null>(null);
  const [zone, setZone] = useState("");
  const [sub, setSub] = useState("code");
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
        require_lan: false, require_device: false, require_password: false, require_login: false, require_code: false, oauth: [],
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
        <p className="muted">Where git and browsers reach Code from anywhere.</p>
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

// Tokens are what git signs in with, as the password: each for the admin or
// for one account, shown once when made.
function Tokens({ state, users, onState }: { state: CodeState; users: User[]; onState: (s: CodeState) => void }) {
  const [making, setMaking] = useState(false);
  const [name, setName] = useState("");
  const [owner, setOwner] = useState("admin");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const notify = useNotify();
  const nameOf = (id: string) => {
    if (id === "admin") return "Admin";
    const u = users.find((x) => x.id === id);
    return u ? u.name || u.username : "Removed account";
  };
  const owners: Option<string>[] = [
    { value: "admin", label: "Admin", hint: "Every repository" },
    ...users.map((u) => ({ value: u.id, label: u.name || u.username, hint: u.email })),
  ];
  const close = () => {
    setMaking(false);
    setSecret("");
    setName("");
    setOwner("admin");
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
              <div className="tf static">
                <div className="tf-box">
                  <Dropdown label="For" value={owner} options={owners} onChange={setOwner} />
                  <span className="tf-label">For</span>
                </div>
              </div>
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

// CodeAccess is who may open Code's address, as for any tunnel, then the
// repositories each person may open there, and whether they may push.
function CodeAccess({ route, rules, repos: all, users, providers, onChanged, onRules }: {
  route: Route;
  rules: RepoRule[];
  repos: Repo[];
  users: User[];
  providers: OAuthProvider[];
  onChanged: () => Promise<void>;
  onRules: (state: CodeState) => void;
}) {
  const [edit, setEdit] = useState<RouteEdit>(() => editOf(route));
  const [asking, setAsking] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const notify = useNotify();
  useEffect(() => setEdit(editOf(route)), [route]);

  const save = async (change: Partial<RouteEdit>) => {
    const next = { ...edit, ...change };
    setEdit({ ...next, password: undefined });
    try {
      await api.editRoute(route.id, next);
      await onChanged();
    } catch (e) {
      setEdit(editOf(route));
      throw e;
    }
  };
  const quietly = (change: Partial<RouteEdit>) => save(change).catch((e) => notify(message(e), "bad"));
  const access = (patch: Partial<Access>) => {
    if (patch.require_password && !route.password_set) {
      setAsking(true);
      return;
    }
    if (patch.require_password === false) setAsking(false);
    quietly(patch);
  };
  const rulesDo = async (work: () => Promise<CodeState>) => {
    try {
      onRules(await work());
    } catch (e) {
      notify(message(e), "bad");
    }
  };
  const grant = async (user: User, on: boolean) => {
    try {
      await api.editUser(user.id, { route_ids: on ? [...user.route_ids, route.id] : user.route_ids.filter((r) => r !== route.id) });
      if (!on) for (const r of rules.filter((x) => x.user_id === user.id)) onRules(await api.removeRule(r.id));
      await onChanged();
    } catch (e) {
      notify(message(e), "bad");
    }
  };

  const members = users.filter((u) => u.route_ids.includes(route.id));
  const everyone = rules.some((r) => r.user_id === "*");
  const people: { id: string; name: string; sub: string; user?: User }[] = [
    ...(everyone ? [{ id: "*", name: "Everyone", sub: "Anyone who gets through the access above" }] : []),
    ...members.map((u) => ({ id: u.id, name: u.name || u.username, sub: u.email, user: u })),
  ];
  const ranked = [...users].sort((a, b) => (b.last_login ?? 0) - (a.last_login ?? 0));
  const who = adding === "*" ? "Everyone" : users.find((u) => u.id === adding)?.username ?? "";

  return (
    <>
      <Callout icon="info">Git signs in with a token from Tokens instead of these layers; only Same network still applies to it.</Callout>
      <AccessCard signInElsewhere value={{ ...edit, require_password: edit.require_password || asking, password_set: route.password_set }} users={users} providers={providers} hostname={route.hostname} onChange={access}
        onPassword={async (password) => {
          await save({ require_password: true, password });
          setAsking(false);
        }}
        onPasswordCancel={() => setAsking(false)} />

      <Card title={<>People with access<span className="title-toggle">Require sign-in<Switch label="Require sign-in" on={edit.require_login} onChange={(v) => access({ require_login: v })} /></span></>}
        sub={people.length ? undefined : "No one yet. Add people, or Everyone, and the repositories they may open."}
        action={
          <AddMenu label="Add people" placeholder="Name or email"
            empty={<a className="menu-item" href="#/users/new"><Icon name="add" size={18} />New user</a>}
            onPick={async (pick) => {
              const u = users.find((x) => x.id === pick);
              if (u && !u.route_ids.includes(route.id)) await grant(u, true);
              setAdding(pick);
            }}
            items={[
              { id: "*", label: "Everyone", sub: "Anyone who gets through", disabled: everyone, note: "Listed" },
              ...ranked.map((u) => ({ id: u.id, label: u.name || u.username, sub: u.email, avatar: u.name || u.username, disabled: u.route_ids.includes(route.id), note: "Has access" })),
            ]} />
        }>
        {people.length > 0 && (
          <ul className="people">
            {people.map((p) => {
              const theirs = rules.filter((r) => r.user_id === p.id);
              return (
                <li key={p.id} className="person-block">
                  <div className="person-row">
                    {p.user ? <Avatar name={p.name} /> : <span className="avatar everyone" aria-hidden><Icon name="group" size={18} /></span>}
                    {p.user ? (
                      <a className="person" href={`#/users/${p.id}`}><span className="scan-target">{p.name}</span><small>{p.sub}</small></a>
                    ) : (
                      <span className="person"><span className="scan-target">{p.name}</span><small>{p.sub}</small></span>
                    )}
                    <button type="button" className="icon-btn" aria-label={`Add a repository for ${p.name}`} title="Add a repository" onClick={() => setAdding(p.id)}>
                      <Icon name="add" />
                    </button>
                    <button type="button" className="icon-btn danger" aria-label={`Remove ${p.name}`} title="Remove"
                      onClick={async () => {
                        if (p.user) return grant(p.user, false);
                        for (const r of theirs) await rulesDo(() => api.removeRule(r.id));
                      }}>
                      <Icon name="close" />
                    </button>
                  </div>
                  <ul className="rules">
                    {theirs.length === 0 && <li className="rule-row muted">No repositories yet, so nothing shows.</li>}
                    {theirs.map((r) => (
                      <li key={r.id} className="rule-row">
                        <Icon name="code" size={18} />
                        <span className="rule-path mono">{r.repo || "Every repository"}</span>
                        <div className="rule-mode">
                          <Dropdown label={`Access to ${r.repo || "every repository"}`} value={r.mode} options={MODES} onChange={(mode) => rulesDo(() => api.editRule(r.id, { mode }))} />
                        </div>
                        <button type="button" className="icon-btn small danger" aria-label={`Remove ${r.repo || "every repository"}`} title="Remove" onClick={() => rulesDo(() => api.removeRule(r.id))}>
                          <Icon name="close" size={18} />
                        </button>
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {adding !== null && (
        <RuleDialog who={who} repos={all} onClose={() => setAdding(null)}
          onSave={async (repo, mode) => {
            await rulesDo(() => api.addRule({ user_id: adding, repo, mode }));
            setAdding(null);
          }} />
      )}
    </>
  );
}

// RuleDialog picks a repository, or every one, and how much someone may do.
function RuleDialog({ who, repos: all, onSave, onClose }: { who: string; repos: Repo[]; onSave: (repo: string, mode: RepoRule["mode"]) => Promise<void>; onClose: () => void }) {
  const [repo, setRepo] = useState("");
  const [mode, setMode] = useState<RepoRule["mode"]>("read");
  const [busy, setBusy] = useState(false);
  const options: Option<string>[] = [
    { value: "", label: "Every repository", hint: "Those made later as well" },
    ...all.map((r) => ({ value: r.name, label: r.name })),
  ];
  return (
    <Dialog title={`A repository for ${who}`} onClose={onClose}>
      <div className="edit-block">
        <div className="tf static">
          <div className="tf-box">
            <Dropdown label="Repository" value={repo} options={options} onChange={setRepo} />
            <span className="tf-label">Repository</span>
          </div>
        </div>
        <div className="tf static">
          <div className="tf-box">
            <Dropdown label="Access" value={mode} options={MODES} onChange={setMode} />
            <span className="tf-label">Access</span>
          </div>
        </div>
        <div className="edit-actions">
          <button type="button" className="btn text" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy} onClick={async () => {
            setBusy(true);
            await onSave(repo, mode);
            setBusy(false);
          }}>{busy && <span className="spinner small on-accent" />}Give access</button>
        </div>
      </div>
    </Dialog>
  );
}
