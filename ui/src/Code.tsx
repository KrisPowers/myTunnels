import { useCallback, useContext, useEffect, useState, type FormEvent } from "react";
import { ago, api, editOf, message, repos, type Access, type CodeState, type OAuthProvider, type Repo, type Route, type RouteEdit, type User, type Zone } from "./api";
import { Dropdown, type Option } from "./Dropdown";
import { NameDialog } from "./Files";
import { Icon, type IconName } from "./Icon";
import { RepoList, RepoView } from "./Repo";
import { AccessCard, AddressEditor, TunnelLogs } from "./Tunnels";
import { MeContext, useCan } from "./me";
import { Callout, Card, Copy, Dialog, Row, TextField, useNotify } from "./ui";

// CodePage is Code: git repositories kept on this host, the tokens git signs
// in with, and, once it has an address, the layers in front of it there. Who
// may view, push, create or delete is each account's Code permissions.
// `#/code/repos/<name>` is one repository.
export function CodePage({ id, page, users, providers, onChanged }: { id: string; page: string; users: User[]; providers: OAuthProvider[]; onChanged: () => Promise<void> }) {
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
  const cloneUrls = (name: string) => [
    ...(route ? [{ label: "From anywhere", url: `https://${route.hostname}/${name}.git` }] : []),
    { label: "On this network", url: `${location.origin}/git/${name}.git` },
  ];

  if (id === "repos" && page) {
    return <RepoView name={page} back="#/code" cloneUrls={cloneUrls(page)} admin={can("code.delete")} onRemoved={() => (location.hash = "#/code")} />;
  }
  if (!state) return problem ? <Callout tone="bad" icon="error">{problem}</Callout> : null;

  const pages: [string, string, IconName][] = [
    ["repos", "Repositories", "code"],
    ["tokens", "Tokens", "key"],
    ...(route && can("tunnels.view") ? [["access", "Access Control", "shield"], ["activity", "Activity", "history"]] as [string, string, IconName][] : []),
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
                {can("tunnels.edit") && <button type="button" className="icon-btn small" aria-label="Change address" title="Change address" onClick={() => setAsking("move")}><Icon name="edit" size={18} /></button>}
              </span>
            ) : <span>On this network only</span>}
            {list && <span><b>{list.length}</b> repositor{list.length === 1 ? "y" : "ies"}</span>}
          </div>
        </div>
        <div className="page-actions">
          {route ? (
            <a className="btn" href={`https://${route.hostname}`} target="_blank" rel="noreferrer"><Icon name="open_in_new" size={18} />Open</a>
          ) : can("tunnels.create") && (
            <button type="button" className="btn" onClick={() => setAsking("address")}><Icon name="public" size={18} />Publish an address</button>
          )}
          {can("code.create") && <button type="button" className="btn primary" onClick={() => setAsking("repo")}><Icon name="add" size={18} />New repository</button>}
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
        {current === "repos" && list && <RepoList list={list} href={(name) => `#/code/repos/${name}`} onNew={can("code.create") ? () => setAsking("repo") : undefined} />}
        {current === "tokens" && <Tokens state={state} users={users} onState={setState} />}
        {current === "access" && route && (
          <CodeAccess route={route} users={users} providers={providers} onChanged={async () => {
            await onChanged();
            await load();
          }} />
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

// CodeAccess is the layers in front of Code's address, as for any tunnel.
// Which accounts may open it is picked on each account; what they may do with
// repositories is their Code permissions.
function CodeAccess({ route, users, providers, onChanged }: {
  route: Route;
  users: User[];
  providers: OAuthProvider[];
  onChanged: () => Promise<void>;
}) {
  const [edit, setEdit] = useState<RouteEdit>(() => editOf(route));
  const [asking, setAsking] = useState(false);
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
  const access = (patch: Partial<Access>) => {
    if (patch.require_password && !route.password_set) {
      setAsking(true);
      return;
    }
    if (patch.require_password === false) setAsking(false);
    save(patch).catch((e) => notify(message(e), "bad"));
  };

  return (
    <>
      <Callout icon="info">Git signs in with a token from Tokens instead of these layers; only Same network still applies to it.</Callout>
      <AccessCard value={{ ...edit, require_password: edit.require_password || asking, password_set: route.password_set }} users={users} providers={providers} hostname={route.hostname} onChange={access}
        onPassword={async (password) => {
          await save({ require_password: true, password });
          setAsking(false);
        }}
        onPasswordCancel={() => setAsking(false)} />
    </>
  );
}
