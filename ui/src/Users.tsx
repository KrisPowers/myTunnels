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

// Grants are the tunnels an account may open: every one, or those picked.
function Grants({ all, ids, routes, onAll, onPick }: { all: boolean; ids: string[]; routes: Route[]; onAll: (v: boolean) => void; onPick: (id: string, on: boolean) => void }) {
  return (
    <Card title="Tunnels">
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

// ---- a new account ----

export function NewUser({ routes, onAdded }: { routes: Route[]; onAdded: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [all, setAll] = useState(false);
  const [ids, setIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const notify = useNotify();
  const ready = username.trim().length >= 2 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && strength(password).ok;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    try {
      const user = await api.addUser({ username, email, name, password, all_routes: all, route_ids: ids });
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
        <Grants all={all} ids={ids} routes={routes} onAll={setAll} onPick={(id, on) => setIds((had) => (on ? [...had, id] : had.filter((x) => x !== id)))} />
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
  const [password, setPassword] = useState("");
  const current = USER_PAGES.some(([k]) => k === page) ? page : "profile";
  const [tone, label] = state(user);

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
          <Switch label={user.enabled ? "Active, turn off" : "Turned off, turn on"} on={user.enabled} onChange={(v) => edit({ enabled: v }).catch(() => {})} />
          <ArmedButton icon="delete" label="Remove" armedLabel="Remove for good" onConfirm={remove} />
        </div>
      </div>
      <SubNav back="#/users" backLabel="Users" base={`#/users/${user.id}`} items={USER_PAGES} current={current} />

      <div className="page-body stack" key={current}>
        {user.note && (
          <div className="callout bad held">
            <Icon name="warning" />
            <span><b>Held for review.</b> {user.note}. Its sign-ins ended. Check Activity, then unlock it if it was them.</span>
            <button type="button" className="btn" onClick={() => edit({ enabled: true }).then(() => notify("Unlocked")).catch(() => {})}>Unlock</button>
          </div>
        )}

        {current === "profile" && (
          <>
            <Card title="Who they are">
              <Row title="Full name"><SaveField label="Full name" width={260} placeholder="None" value={user.name} onSave={(v) => edit({ name: v })} /></Row>
              <Row title="Username"><SaveField label="Username" width={260} value={user.username} onSave={(v) => edit({ username: v })} /></Row>
              <Row title="Email" sub="What they sign in with."><SaveField label="Email" width={260} value={user.email} onSave={(v) => edit({ email: v })} /></Row>
            </Card>
            <Card title="Password">
              <div className="setting nested">
                <PasswordField label="New password" value={password} onChange={setPassword} hint="Changing it signs them out everywhere." />
                <button type="button" className="btn primary" disabled={!strength(password).ok} onClick={() => edit({ password }).then(() => {
                  setPassword("");
                  notify("Password changed");
                }).catch(() => {})}>Change</button>
              </div>
            </Card>
            <Card title="Sessions">
              <Row title="Sign out everywhere" sub="Ends every sign-in of this account. The password stays.">
                <button type="button" className="btn" onClick={() => api.signOutUser(user.id).then(() => notify("Signed out everywhere")).catch((e) => notify(message(e), "bad"))}>
                  <Icon name="logout" size={18} />Sign out
                </button>
              </Row>
            </Card>
          </>
        )}

        {current === "access" && (
          <Grants all={user.all_routes} ids={user.route_ids} routes={routes} onAll={(v) => edit({ all_routes: v }).catch(() => {})}
            onPick={(id, on) => edit({ route_ids: on ? [...user.route_ids, id] : user.route_ids.filter((x) => x !== id) }).catch(() => {})} />
        )}

        {current === "activity" && <Activity user={user} />}
      </div>
    </>
  );
}

const OUTCOME: Record<SignIn["outcome"], [string, string]> = {
  ok: ["ok", "Signed in"],
  failed: ["warn", "Wrong password"],
  blocked: ["bad", "Blocked"],
};

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
      <Card title="Recent sign-ins">
        {list && list.length > 0 ? (
          <ul className="results">
            {list.slice(0, 50).map((s, i) => (
              <li key={i}>
                <div className="result signin-row">
                  <span className={"chip " + OUTCOME[s.outcome][0]}>{OUTCOME[s.outcome][1]}</span>
                  <span className="mono">{s.ip ?? "Unknown address"}</span>
                  <span className="result-service">{s.country ?? ""}</span>
                  <span className="mono muted">{s.device_id ? shortId(s.device_id) : "No device key"}</span>
                  <span className="result-meta">{ago(s.at)}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : <p className="card-note muted">Nothing yet.</p>}
      </Card>
    </>
  );
}
