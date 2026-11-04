import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, editOf, files, message, type Access, type HostFolder, type OAuthProvider, type Route, type RouteEdit, type StorageRule, type StorageState, type User, type Zone } from "./api";
import { Dropdown, type Option } from "./Dropdown";
import { Explorer } from "./Explorer";
import { Icon, type IconName } from "./Icon";
import { AccessCard, AddressEditor, TunnelLogs } from "./Tunnels";
import { AddMenu, Avatar, Callout, Card, Dialog, Switch, TextField, useNotify } from "./ui";

const PAGES: [string, string, IconName][] = [
  ["files", "Files", "folder"],
  ["access", "Access Control", "shield"],
  ["activity", "Activity", "history"],
];

const STEPS = ["Folder", "Address"];

const MODES: Option<StorageRule["mode"]>[] = [
  { value: "read", label: "Read only", hint: "Open and download" },
  { value: "write", label: "Read and write", hint: "Upload, rename, move and delete as well" },
];

// StoragePage turns a folder of this host into storage. It starts off; once
// enabled, setup asks for the folder and then the address, and after that the
// page is the folder itself, who may open which part of it, and what happened.
export function StoragePage({ page, users, providers, onChanged }: { page: string; users: User[]; providers: OAuthProvider[]; onChanged: () => Promise<void> }) {
  const [state, setState] = useState<StorageState | null>(null);
  const [problem, setProblem] = useState("");
  const [editing, setEditing] = useState<"" | "folder" | "address">("");
  const notify = useNotify();

  const load = useCallback(async () => {
    try {
      setState(await api.storage());
      setProblem("");
    } catch (e) {
      setProblem(message(e));
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const save = async (body: { enabled?: boolean; path?: string }) => {
    try {
      setState(await api.saveStorage(body));
      return true;
    } catch (e) {
      notify(message(e), "bad");
      return false;
    }
  };

  if (!state) return problem ? <Callout tone="bad" icon="error">{problem}</Callout> : null;

  const head = (
    <div className="page-head">
      <div className="page-head-main">
        <h1>Storage</h1>
        {state.enabled && state.path !== null && state.route && (
          <div className="page-sub">
            <span className="inline-edit">
              <span className="mono">{state.display}</span>
              <button type="button" className="icon-btn small" aria-label="Change folder" title="Change folder" onClick={() => setEditing("folder")}><Icon name="edit" size={18} /></button>
            </span>
            <span className="inline-edit">
              <span>{state.route.hostname}</span>
              <button type="button" className="icon-btn small" aria-label="Change address" title="Change address" onClick={() => setEditing("address")}><Icon name="edit" size={18} /></button>
            </span>
          </div>
        )}
      </div>
      {state.enabled && (
        <div className="page-actions">
          <Switch label="Storage on, switch off" on onChange={() => save({ enabled: false })} />
          {state.route && <a className="btn" href={`https://${state.route.hostname}`} target="_blank" rel="noreferrer"><Icon name="open_in_new" size={18} />Open</a>}
        </div>
      )}
    </div>
  );

  if (!state.enabled) {
    return (
      <>
        {head}
        <div className="page-body">
          <div className="card welcome">
            <Icon name="hard_drive" size={40} />
            <h2>Storage is off</h2>
            <p className="muted">Open a folder of this host from here and from its own address, with the folders each person may use.</p>
            <button type="button" className="btn primary" onClick={() => save({ enabled: true })}>Enable storage</button>
          </div>
        </div>
      </>
    );
  }

  if (state.path === null || !state.route) {
    const step = state.path === null ? 0 : 1;
    return (
      <>
        {head}
        <div className="page-body storage-setup">
          <ol className="steps" aria-label="Storage setup">
            {STEPS.map((label, i) => (
              <li key={label} className={"step " + (i === step ? "now" : i < step ? "done" : "later")} aria-current={i === step ? "step" : undefined}>
                <span className="step-mark">{i < step ? <Icon name="check" size={16} /> : i + 1}</span>
                <span className="step-label">{label}</span>
              </li>
            ))}
          </ol>
          <div className="setup-card card" key={step}>
            {step === 0 ? (
              <>
                <div className="step-head">
                  <h1>Choose the folder</h1>
                  <p className="muted">What Storage shows and changes. A drive works too.</p>
                </div>
                <FolderPicker drives={state.drives} action="Use this folder" onPick={(path) => save({ path })} />
              </>
            ) : (
              <AddressStep onDone={async () => {
                await onChanged();
                await load();
              }} />
            )}
          </div>
        </div>
      </>
    );
  }

  const route = state.route;
  const current = PAGES.some(([k]) => k === page) ? page : "files";
  return (
    <>
      {head}
      <nav className="sub-nav" aria-label="Sub-pages">
        {PAGES.map(([key, label, icon]) => (
          <a key={key} className={"sub-nav-item" + (current === key ? " on" : "")} href={`#/storage/${key}`} aria-current={current === key ? "page" : undefined}>
            <Icon name={icon} size={18} />
            <span>{label}</span>
          </a>
        ))}
      </nav>
      <div className="page-body stack plain" key={current}>
        {current === "files" && <Explorer title={state.display ?? "Storage"} />}
        {current === "access" && (
          <StorageAccess route={route} rules={state.rules} users={users} providers={providers}
            onChanged={async () => {
              await onChanged();
              await load();
            }}
            onRules={setState} />
        )}
        {current === "activity" && <TunnelLogs route={route} users={users} />}
      </div>

      {editing === "folder" && (
        <Dialog title="Change folder" onClose={() => setEditing("")}>
          <FolderPicker drives={state.drives} start={state.path} action="Use this folder"
            onPick={async (path) => {
              if (await save({ path })) setEditing("");
            }} />
        </Dialog>
      )}
      {editing === "address" && (
        <AddressEditor route={route} onDone={() => setEditing("")} onChanged={async () => {
          await onChanged();
          await load();
        }} />
      )}
    </>
  );
}

// FolderPicker walks this host's folders: the top of the host, its drives,
// then folder by folder. Any of them can be picked, the top as well, which is
// everything on the host.
function FolderPicker({ drives, start = "", action, onPick }: { drives: boolean; start?: string; action: string; onPick: (path: string) => Promise<unknown> }) {
  const [at, setAt] = useState(start);
  const [folder, setFolder] = useState<HostFolder | null>(null);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setFolder(null);
    api.browseHost(at).then((f) => {
      setFolder(f);
      setProblem("");
    }).catch((e) => setProblem(message(e)));
  }, [at]);

  const parts = at ? at.split("/") : [];
  const top = drives ? "All drives" : "/";
  return (
    <div className="folder-picker">
      <div className="ex-address picker-path">
        <Icon name="hard_drive" size={18} />
        {[top, ...parts].map((name, i) => (
          <span key={i} className="ex-crumb-wrap">
            {i > 0 && <Icon name="chevron_right" size={16} className="ex-crumb-sep" />}
            <button type="button" className="ex-crumb" onClick={() => setAt(parts.slice(0, i).join("/"))}>{name}</button>
          </span>
        ))}
      </div>
      {at === "" && (
        <Callout tone="warn" icon="warning">
          Not recommended: {drives ? "every drive" : "everything on this host"} would be in Storage.
        </Callout>
      )}
      <ul className="picker-list">
        {problem && <li className="picker-note">{problem}</li>}
        {!problem && !folder && <li className="picker-note"><span className="spinner small" /></li>}
        {folder && folder.parent !== null && (
          <li><button type="button" className="picker-item" onClick={() => setAt(folder.parent ?? "")}><Icon name="arrow_upward" size={20} /><span>Up</span></button></li>
        )}
        {folder?.folders.map((name) => (
          <li key={name}>
            <button type="button" className="picker-item" onClick={() => setAt(at ? `${at}/${name}` : name)}>
              <Icon name={drives && !at ? "hard_drive" : "folder"} size={20} className={drives && !at ? undefined : "kind folder"} />
              <span>{drives && !at ? `${name}\\` : name}</span>
              <Icon name="chevron_right" size={18} className="picker-go" />
            </button>
          </li>
        ))}
        {folder && folder.folders.length === 0 && <li className="picker-note">No folders in here</li>}
      </ul>
      <div className="setup-foot picker-foot">
        <span className="picker-chosen mono">{folder?.display ?? ""}</span>
        <button type="button" className="btn primary" disabled={busy || !folder} onClick={async () => {
          setBusy(true);
          await onPick(at);
          setBusy(false);
        }}>{busy && <span className="spinner small on-accent" />}{action}<Icon name="arrow_forward" size={18} /></button>
      </div>
    </div>
  );
}

// AddressStep publishes Storage at a subdomain of one of the domains.
function AddressStep({ onDone }: { onDone: () => Promise<void> }) {
  const [zones, setZones] = useState<Zone[] | null>(null);
  const [zone, setZone] = useState("");
  const [sub, setSub] = useState("storage");
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
        subdomain: sub, zone_id: zone, port: 0, target_host: null, target_scheme: "storage", preserve_host: false,
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
    <form onSubmit={submit}>
      <div className="step-head">
        <h1>Choose the address</h1>
        <p className="muted">Where Storage opens from anywhere.</p>
      </div>
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
      <div className="setup-foot">
        <button className="btn primary" disabled={busy || !sub || !zone}>
          {busy ? <span className="spinner small on-accent" /> : <Icon name="add" size={18} />}Publish
        </button>
      </div>
    </form>
  );
}

// StorageAccess is who may open the storage address, as for any tunnel, then
// the folders each of them may open and whether they can change them.
function StorageAccess({ route, rules, users, providers, onChanged, onRules }: {
  route: Route;
  rules: StorageRule[];
  users: User[];
  providers: OAuthProvider[];
  onChanged: () => Promise<void>;
  onRules: (state: StorageState) => void;
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

  const rulesDo = async (work: () => Promise<StorageState>) => {
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
      <AccessCard signInElsewhere value={{ ...edit, require_password: edit.require_password || asking, password_set: route.password_set }} users={users} providers={providers} hostname={route.hostname} onChange={access}
        onPassword={async (password) => {
          await save({ require_password: true, password });
          setAsking(false);
        }}
        onPasswordCancel={() => setAsking(false)} />

      <Card title={<>People with access<span className="title-toggle">Require sign-in<Switch label="Require sign-in" on={edit.require_login} onChange={(v) => access({ require_login: v })} /></span></>}
        sub={people.length ? undefined : "No one yet. Add people, or Everyone, and the folders they may open."}
        action={
          <AddMenu label="Add people" placeholder="Name or email"
            empty={<a className="menu-item" href="#/users/new"><Icon name="add" size={18} />New user</a>}
            onPick={async (id) => {
              const u = users.find((x) => x.id === id);
              if (u && !u.route_ids.includes(route.id)) await grant(u, true);
              setAdding(id);
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
                    <button type="button" className="icon-btn" aria-label={`Add a folder for ${p.name}`} title="Add a folder" onClick={() => setAdding(p.id)}>
                      <Icon name="create_new_folder" />
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
                    {theirs.length === 0 && <li className="rule-row muted">No folders yet, so nothing shows.</li>}
                    {theirs.map((r) => (
                      <li key={r.id} className="rule-row">
                        <Icon name="folder" size={18} className="kind folder" />
                        <span className="rule-path mono">{r.path || "Everything"}</span>
                        <div className="rule-mode">
                          <Dropdown label={`Access to ${r.path || "everything"}`} value={r.mode} options={MODES} onChange={(mode) => rulesDo(() => api.editRule(r.id, { mode }))} />
                        </div>
                        <button type="button" className="icon-btn small danger" aria-label={`Remove ${r.path || "everything"}`} title="Remove" onClick={() => rulesDo(() => api.removeRule(r.id))}>
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
        <RuleDialog who={who} onClose={() => setAdding(null)}
          onSave={async (path, mode) => {
            await rulesDo(() => api.addRule({ user_id: adding, path, mode }));
            setAdding(null);
          }} />
      )}
    </>
  );
}

// RuleDialog picks a folder inside Storage, and how much someone may do there.
function RuleDialog({ who, onSave, onClose }: { who: string; onSave: (path: string, mode: StorageRule["mode"]) => Promise<void>; onClose: () => void }) {
  const [at, setAt] = useState("");
  const [folders, setFolders] = useState<string[] | null>(null);
  const [mode, setMode] = useState<StorageRule["mode"]>("read");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  useEffect(() => {
    setFolders(null);
    files.list(at).then((l) => {
      setFolders(l.entries.filter((e) => e.dir).map((e) => e.name).sort((a, b) => a.localeCompare(b)));
      setProblem("");
    }).catch((e) => setProblem(message(e)));
  }, [at]);

  const parts = at ? at.split("/") : [];
  return (
    <Dialog title={`A folder for ${who}`} onClose={onClose}>
      <div className="folder-picker">
        <div className="ex-address picker-path">
          <Icon name="hard_drive" size={18} />
          {["Storage", ...parts].map((name, i) => (
            <span key={i} className="ex-crumb-wrap">
              {i > 0 && <Icon name="chevron_right" size={16} className="ex-crumb-sep" />}
              <button type="button" className="ex-crumb" onClick={() => setAt(parts.slice(0, i).join("/"))}>{name}</button>
            </span>
          ))}
        </div>
        <ul className="picker-list short">
          {problem && <li className="picker-note">{problem}</li>}
          {!problem && !folders && <li className="picker-note"><span className="spinner small" /></li>}
          {folders?.map((name) => (
            <li key={name}>
              <button type="button" className="picker-item" onClick={() => setAt(at ? `${at}/${name}` : name)}>
                <Icon name="folder" size={20} className="kind folder" />
                <span>{name}</span>
                <Icon name="chevron_right" size={18} className="picker-go" />
              </button>
            </li>
          ))}
          {folders && folders.length === 0 && <li className="picker-note">No folders in here</li>}
        </ul>
        <div className="edit-row rule-pick">
          <span className="picker-chosen mono">{at || "Everything"}</span>
          <div className="tf static protocol rule-mode-pick">
            <div className="tf-box">
              <Dropdown label="Access" value={mode} options={MODES} onChange={setMode} />
              <span className="tf-label">Access</span>
            </div>
          </div>
        </div>
        <div className="edit-actions">
          <button type="button" className="btn text" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy} onClick={async () => {
            setBusy(true);
            await onSave(at, mode);
            setBusy(false);
          }}>{busy && <span className="spinner small on-accent" />}Give access</button>
        </div>
      </div>
    </Dialog>
  );
}
