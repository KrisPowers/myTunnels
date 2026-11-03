import { useEffect, useState, type FormEvent } from "react";
import { ago, api, LEVELS, list, message, shortId, strength, type Route, type SignIn, type User } from "./api";
import { Icon, type IconName } from "./Icon";
import { go } from "./route";
import { AddMenu, Avatar, Card, LogTable, MoreMenu, Row, SubNav, Switch, TextField, useNotify, ValueRow, type LogEntry } from "./ui";

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
                      <span className="result-what">{`${u.route_ids.length} tunnel${u.route_ids.length === 1 ? "" : "s"}`}</span>
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

// ---- pieces ----

function Rating({ value }: { value: string }) {
  if (!value) return null;
  const rating = strength(value);
  return (
    <>
      <span className={"strength " + rating.level}>{LEVELS[rating.level]}</span>
      {rating.missing.length > 0 && <span>Needs {list(rating.missing)}.</span>}
    </>
  );
}

// A strong password from the browser's own random source.
function generate() {
  const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!$%&*+-=?@#"];
  const all = sets.join("");
  const pick = (chars: string) => chars[crypto.getRandomValues(new Uint32Array(1))[0] % chars.length];
  const chars = [...sets.map(pick), ...Array.from({ length: 14 }, () => pick(all))];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

// PasswordField is a password with its rating and a button that makes a strong one.
function PasswordField({ label, value, onChange, hint }: { label: string; value: string; onChange: (v: string) => void; hint?: string }) {
  const [shown, setShown] = useState(false);
  return (
    <TextField className="grow two-actions" label={label} type={shown ? "text" : "password"} autoComplete="new-password" mono={shown}
      value={value} onChange={onChange}
      trailing={
        <>
          <button type="button" className="tf-action" onClick={() => setShown((s) => !s)}>{shown ? "Hide" : "Show"}</button>
          <button type="button" className="tf-action" onClick={() => {
            onChange(generate());
            setShown(true);
          }}>Generate</button>
        </>
      }
      hint={value ? <Rating value={value} /> : hint} />
  );
}

// Grants are the tunnels an account may open, each added on its own.
function Grants({ ids, routes, onPick }: { ids: string[]; routes: Route[]; onPick: (id: string, on: boolean) => void }) {
  return (
    <Card title="Tunnels" sub={routes.length ? undefined : "There are no tunnels yet."}>
      {routes.map((r) => (
        <Row key={r.id} title={<span className="mono">{r.hostname}</span>} sub={r.require_login ? undefined : "Does not ask for sign-in"}>
          <Switch label={`Allow ${r.hostname}`} on={ids.includes(r.id)} onChange={(v) => onPick(r.id, v)} />
        </Row>
      ))}
    </Card>
  );
}

// ---- a new account ----

export function NewUser({ routes, onAdded }: { routes: Route[]; onAdded: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [ids, setIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const notify = useNotify();
  const ready = username.trim().length >= 2 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && strength(password).ok;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    try {
      const user = await api.addUser({ username, email, name, password, route_ids: ids });
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
          <div className="page-sub">They sign in with their email and this password.</div>
        </div>
      </div>
      <div className="page-body stack">
        <Card title="Who they are">
          <div className="card-pad form-grid">
            <TextField label="Full name" autoFocus autoComplete="off" value={name} onChange={setName} />
            <TextField label="Username" autoComplete="off" value={username} onChange={(v) => setUsername(v.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40))}
              hint="Letters, digits, dots, dashes and underscores" />
            <TextField className="span" label="Email" type="email" autoComplete="off" value={email} onChange={setEmail} hint="What they sign in with" />
          </div>
        </Card>
        <Card title="Password">
          <div className="card-pad">
            <PasswordField label="Password" value={password} onChange={setPassword} hint="Generate one, or type at least 10 characters with upper and lower case, a number and a symbol." />
          </div>
        </Card>
        <Grants ids={ids} routes={routes} onPick={(id, on) => setIds((had) => (on ? [...had, id] : had.filter((x) => x !== id)))} />
        <div className="form-foot">
          <a className="btn text" href="#/users">Cancel</a>
          <button className="btn primary" disabled={busy || !ready}>{busy && <span className="spinner small on-accent" />}Add user</button>
        </div>
      </div>
    </form>
  );
}

// ---- one account ----

const USER_PAGES: [string, string, IconName][] = [
  ["profile", "Profile", "person"],
  ["access", "Access", "shield"],
  ["activity", "Activity", "history"],
];

export function UserPage({ user, page, routes, onChanged }: { user: User; page: string; routes: Route[]; onChanged: () => Promise<void> }) {
  const notify = useNotify();
  const current = USER_PAGES.some(([k]) => k === page) ? page : "profile";
  const [tone, label] = state(user);
  const theirs = routes.filter((r) => user.route_ids.includes(r.id));

  const edit = async (patch: Parameters<typeof api.editUser>[1]) => {
    await api.editUser(user.id, patch);
    await onChanged();
  };
  const quietly = (patch: Parameters<typeof api.editUser>[1], done?: string) =>
    edit(patch).then(() => done && notify(done)).catch((e) => notify(message(e), "bad"));

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
        <div className="page-head-main person-head">
          <Avatar name={user.name || user.username} big />
          <div>
            <h1>{user.name || user.username}</h1>
            <div className="page-sub">
              <span>{user.email}</span>
              <span className={"chip " + tone}>{label}</span>
            </div>
          </div>
        </div>
        <div className="page-actions">
          <MoreMenu label="Account actions" actions={[
            user.enabled
              ? { label: "Turn off", icon: "block", onClick: () => quietly({ enabled: false }, "Turned off") }
              : { label: user.note ? "Unlock" : "Turn on", icon: "check_circle", onClick: () => quietly({ enabled: true }, user.note ? "Unlocked" : "Turned on") },
            { label: "Sign out everywhere", icon: "logout", onClick: () => api.signOutUser(user.id).then(() => notify("Signed out everywhere")).catch((e) => notify(message(e), "bad")) },
            { label: "Remove", icon: "delete", danger: true, confirm: "Remove for good", onClick: remove },
          ]} />
        </div>
      </div>
      <SubNav back="#/users" backLabel="Users" base={`#/users/${user.id}`} items={USER_PAGES} current={current} />

      <div className="page-body stack plain" key={current}>
        {user.note && (
          <div className="callout bad held">
            <Icon name="warning" />
            <span><b>Held for review.</b> {user.note}. Its sign-ins ended. Check Activity, then unlock it from the menu if it was them.</span>
          </div>
        )}

        {current === "profile" && (
          <>
            <Card title="Details">
              <ValueRow title="Full name" value={user.name} onSave={(v) => edit({ name: v })} />
              <ValueRow title="Username" value={user.username} onSave={(v) => edit({ username: v })} />
              <ValueRow title="Email" value={user.email} type="email" hint="What they sign in with" onSave={(v) => edit({ email: v })} />
            </Card>
            <Card title="Security">
              <PasswordValue onSave={(password) => edit({ password })} />
              <Row title="Last signed in" sub={user.last_login ? ago(user.last_login) : "Never"} />
            </Card>
          </>
        )}

        {current === "access" && (
          <Card title="Tunnels" sub={theirs.length ? undefined : "None yet. Add the tunnels this account may sign in at."}
            action={
              <AddMenu label="Add a tunnel" placeholder="Find a tunnel" onPick={(id) => quietly({ route_ids: [...user.route_ids, id] })}
                empty={<div className="menu-note">There are no tunnels yet</div>}
                items={routes.map((r) => ({ id: r.id, label: r.hostname, sub: r.require_login ? undefined : "Sign-in is off here", disabled: user.route_ids.includes(r.id), note: "Already added" }))} />
            }>
            {theirs.length > 0 && (
              <ul className="people">
                {theirs.map((r) => (
                  <li key={r.id} className="person-row">
                    <span className={"dot " + (r.enabled ? "ok" : "")} />
                    <a className="person" href={`#/tunnels/${r.id}`}>
                      <span className="scan-target">{r.hostname}</span>
                      <small>{r.require_login ? "Asks for sign-in" : "Sign-in is off"}</small>
                    </a>
                    <button type="button" className="icon-btn danger" aria-label={`Remove ${r.hostname}`} title="Remove"
                      onClick={() => quietly({ route_ids: user.route_ids.filter((x) => x !== r.id) })}>
                      <Icon name="close" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        {current === "activity" && <Activity user={user} />}
      </div>
    </>
  );
}

// PasswordValue shows that a password is set, and changes it from an edit button.
function PasswordValue({ onSave }: { onSave: (password: string) => Promise<unknown> }) {
  const [editing, setEditing] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const notify = useNotify();
  if (!editing) {
    return (
      <Row title="Password" sub="Set">
        <button type="button" className="icon-btn" aria-label="Change password" title="Change password" onClick={() => setEditing(true)}>
          <Icon name="edit" size={20} />
        </button>
      </Row>
    );
  }
  return (
    <form className="setting nested" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      try {
        await onSave(password);
        notify("Password changed. They were signed out everywhere.");
        setPassword("");
        setEditing(false);
      } catch (err) {
        notify(message(err), "bad");
      } finally {
        setBusy(false);
      }
    }}>
      <PasswordField label="New password" value={password} onChange={setPassword} hint="Changing it signs them out everywhere." />
      <button type="button" className="btn text" onClick={() => setEditing(false)}>Cancel</button>
      <button className="btn primary" disabled={busy || !strength(password).ok}>Save</button>
    </form>
  );
}

// Activity is where an account has been used from: its devices, and its sign-ins.
function Activity({ user }: { user: User }) {
  const [list, setList] = useState<SignIn[] | null>(null);
  useEffect(() => {
    api.userActivity(user.id).then(setList).catch(() => setList([]));
  }, [user.id, user.last_login, user.note]);

  const devices = new Map<string, { count: number; last: SignIn }>();
  for (const s of list ?? []) {
    if (s.outcome !== "ok" || !s.device_id) continue;
    const seen = devices.get(s.device_id);
    devices.set(s.device_id, { count: (seen?.count ?? 0) + 1, last: seen?.last ?? s });
  }

  return (
    <>
      <Card title="Devices" sub={devices.size ? undefined : "No sign-ins yet."}>
        {[...devices].map(([id, { count, last }]) => (
          <Row key={id} title={<a className="mono" href={`#/devices/${id}`}>{shortId(id)}</a>}
            sub={`${count} sign-in${count === 1 ? "" : "s"}, last ${ago(last.at)}${last.ip ? ` from ${last.ip}` : ""}${last.country ? ` (${last.country})` : ""}`} />
        ))}
      </Card>
      <Card title="Sign-ins">
        {list && list.length > 0 ? (
          <LogTable who="Device" entries={list.slice(0, 100).map((s): LogEntry => ({
            at: s.at,
            tone: s.outcome === "ok" ? "ok" : "bad",
            event: s.outcome === "ok" ? "Signed in" : s.outcome === "failed" ? "Wrong password" : "Blocked and held for review",
            who: s.device_id ? <a className="mono" href={`#/devices/${s.device_id}`}>{shortId(s.device_id)}</a> : undefined,
            ip: s.ip,
            country: s.country,
          }))} />
        ) : <p className="card-note muted">Nothing yet.</p>}
      </Card>
    </>
  );
}
