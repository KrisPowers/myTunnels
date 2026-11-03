import { useEffect, useState, type FormEvent } from "react";
import { ago, api, LEVELS, list, message, shortId, strength, type Route, type SignIn, type User } from "./api";
import { Icon, type IconName } from "./Icon";
import { go } from "./route";
import { ArmedButton, Avatar, Card, Row, SaveField, SubNav, Switch, TextField, useNotify } from "./ui";

function state(u: User): [string, string] {
  if (u.note) return ["bad", "Held for review"];
  return u.enabled ? ["ok", "Active"] : ["", "Turned off"];
}

// Users are the accounts people sign in with, by email, at tunnels that ask for one.
export function Users({ users, routes }: { users: User[] | null; routes: Route[] }) {
  const asking = routes.filter((r) => r.require_login).length;
  const held = users?.filter((u) => u.note).length ?? 0;
  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Users</h1>
          <div className="page-sub">
            <span><b>{users?.length ?? 0}</b> accounts</span>
            {held > 0 && <span className="chip bad">{held} held for review</span>}
            <span>{asking ? `${asking} tunnel${asking === 1 ? "" : "s"} ask for sign-in` : "No tunnel asks for sign-in yet"}</span>
          </div>
        </div>
        <div className="page-actions">
          <a className="btn primary" href="#/users/new"><Icon name="add" size={18} />New user</a>
        </div>
      </div>
      <div className="page-body stack">
        {users && users.length === 0 && (
          <div className="card welcome">
            <Icon name="group" size={40} />
            <h2>No accounts yet</h2>
            <p className="muted">Add an account, then turn on Sign-in for the tunnels it should open.</p>
            <a className="btn primary" href="#/users/new"><Icon name="add" size={18} />New user</a>
          </div>
        )}
        {users && users.length > 0 && (
          <div className="card">
            <ul className="results">
              {users.map((u) => {
                const [tone, label] = state(u);
                return (
                  <li key={u.id}>
                    <a className="result user-row" href={`#/users/${u.id}`}>
                      <Avatar name={u.name || u.username} />
                      <span className="person">
                        <span className="scan-target">{u.name || u.username}</span>
                        <small>{u.email}</small>
                      </span>
                      <span className="result-service mono">{u.username}</span>
                      <span className="result-what">{u.all_routes ? "Every tunnel" : `${u.route_ids.length} tunnel${u.route_ids.length === 1 ? "" : "s"}`}</span>
                      <span className={"chip " + tone}>{label}</span>
                      <span className="result-meta">{u.last_login ? ago(u.last_login) : "Never"}</span>
                      <Icon name="chevron_right" className="result-go" />
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </>
  );
}

// Grants are the tunnels an account may open: every one, or those picked.
function Grants({ all, ids, routes, onAll, onPick }: { all: boolean; ids: string[]; routes: Route[]; onAll: (v: boolean) => void; onPick: (id: string, on: boolean) => void }) {
  return (
    <Card title="Can open" sub="Only tunnels with Sign-in turned on ask for an account.">
      <Row title="Every tunnel" sub="Including tunnels added later.">
        <Switch label="Every tunnel" on={all} onChange={onAll} />
      </Row>
      {!all && routes.map((r) => (
        <Row key={r.id} title={<span className="mono">{r.hostname}</span>} sub={r.require_login ? undefined : "Does not ask for sign-in"}>
          <Switch label={`Allow ${r.hostname}`} on={ids.includes(r.id)} onChange={(v) => onPick(r.id, v)} />
        </Row>
      ))}
    </Card>
  );
}

function PasswordHint({ value }: { value: string }) {
  if (!value) return null;
  const rating = strength(value);
  return (
    <>
      <span className={"strength " + rating.level}>{LEVELS[rating.level]}</span>
      {rating.missing.length > 0 && <span>Needs {list(rating.missing)}.</span>}
    </>
  );
}

export function NewUser({ routes, onAdded }: { routes: Route[]; onAdded: () => Promise<void> }) {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [all, setAll] = useState(false);
  const [ids, setIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const notify = useNotify();
  const ready = username.trim().length >= 2 && strength(password).ok;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    try {
      const user = await api.addUser({ username, email: email || null, name, password, all_routes: all, route_ids: ids });
      await onAdded();
      notify(`Added ${user.username}`);
      go(`#/users/${user.id}`);
    } catch (err) {
      notify(message(err), "bad");
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <div className="page-head">
        <a className="icon-btn" href="#/users" aria-label="All users" title="All users"><Icon name="arrow_back" /></a>
        <div className="page-head-main">
          <h1>New user</h1>
          <div className="page-sub">They sign in with the username or the email, and this password.</div>
        </div>
        <div className="page-actions">
          <button className="btn primary" disabled={busy || !ready}>{busy && <span className="spinner small on-accent" />}Add user</button>
        </div>
      </div>
      <div className="page-body stack">
        <div className="card form-card">
          <div className="form-grid">
            <TextField label="Username" autoFocus autoComplete="off" value={username} onChange={(v) => setUsername(v.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40))} />
            <TextField label="Email (optional)" type="email" autoComplete="off" value={email} onChange={setEmail} />
            <TextField label="Name (optional)" autoComplete="off" value={name} onChange={setName} />
            <TextField label="Password" type="password" autoComplete="new-password" value={password} onChange={setPassword} hint={<PasswordHint value={password} />} />
          </div>
        </div>
        <Grants all={all} ids={ids} routes={routes} onAll={setAll} onPick={(id, on) => setIds((list) => (on ? [...list, id] : list.filter((x) => x !== id)))} />
      </div>
    </form>
  );
}

export function UserPage({ user, routes, onChanged }: { user: User; routes: Route[]; onChanged: () => Promise<void> }) {
  const notify = useNotify();
  const [password, setPassword] = useState("");

  const edit = async (patch: Parameters<typeof api.editUser>[1]) => {
    try {
      await api.editUser(user.id, patch);
      await onChanged();
    } catch (e) {
      notify(message(e), "bad");
      throw e;
    }
  };

  const remove = async () => {
    try {
      await api.removeUser(user.id);
      notify(`Removed ${user.username}`);
      await onChanged();
      go("#/users");
    } catch (e) {
      notify(message(e), "bad");
    }
  };

  return (
    <>
      <div className="page-head">
        <a className="icon-btn" href="#/users" aria-label="All users" title="All users"><Icon name="arrow_back" /></a>
        <div className="page-head-main">
          <h1>{user.name || user.username}</h1>
          <div className="page-sub">
            <span>{user.last_login ? `Signed in ${ago(user.last_login)}` : "Never signed in"}</span>
          </div>
        </div>
        <div className="page-actions">
          <Switch label={user.enabled ? "Active, turn off" : "Turned off, turn on"} on={user.enabled} onChange={(v) => edit({ enabled: v }).catch(() => {})} />
          <ArmedButton icon="delete" label="Remove" armedLabel="Remove for good" onConfirm={remove} />
        </div>
      </div>
      <div className="page-body stack">
        <Card title="Account">
          <Row title="Username"><SaveField label="Username" width={240} value={user.username} onSave={(v) => edit({ username: v })} /></Row>
          <Row title="Email" sub="Signs in too."><SaveField label="Email" width={240} placeholder="None" value={user.email ?? ""} onSave={(v) => edit({ email: v })} /></Row>
          <Row title="Name"><SaveField label="Name" width={240} placeholder="None" value={user.name} onSave={(v) => edit({ name: v })} /></Row>
          <div className="setting nested">
            <TextField className="grow" label="New password" type="password" autoComplete="new-password" value={password} onChange={setPassword}
              hint={password ? <PasswordHint value={password} /> : "Changing it signs them out everywhere."} />
            <button type="button" className="btn primary" disabled={!strength(password).ok} onClick={() => edit({ password }).then(() => {
              setPassword("");
              notify("Password changed");
            }).catch(() => {})}>Change</button>
          </div>
        </Card>
        <Grants all={user.all_routes} ids={user.route_ids} routes={routes} onAll={(v) => edit({ all_routes: v }).catch(() => {})}
          onPick={(id, on) => edit({ route_ids: on ? [...user.route_ids, id] : user.route_ids.filter((x) => x !== id) }).catch(() => {})} />
      </div>
    </>
  );
}
