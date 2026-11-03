import { useEffect, useState, type FormEvent } from "react";
import { ago, api, LEVELS, list, message, shortId, strength, type Device, type Route, type SignIn, type User } from "./api";
import { Icon, type IconName } from "./Icon";
import { go } from "./route";
import { Dropdown } from "./Dropdown";
import { AddMenu, Avatar, LogTable, MoreMenu, SubNav, TextField, useNotify, type LogEntry } from "./ui";

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

// ---- a new account ----

function deviceLabel(d: Device) {
  const where = [d.info?.platform, d.country].filter(Boolean).join(", ");
  return `${d.name || shortId(d.id)}${where ? `, ${where}` : ""}`;
}

export function NewUser({ devices, onAdded }: { devices: Device[]; onAdded: () => Promise<void> }) {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [device, setDevice] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const notify = useNotify();
  const ready = username.trim().length >= 2 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && device !== "" && strength(password).ok;
  // Devices seen most recently first.
  const choices = [...devices].sort((a, b) => b.last_seen - a.last_seen);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    try {
      const user = await api.addUser({ username, email, password, device_id: device });
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
          <div className="page-sub">They sign in with their email and password, from the device picked here. Add tunnels once the account exists.</div>
        </div>
      </div>
      <div className="page-body stack">
        <div className="card form-card">
          <div className="form-grid">
            <TextField label="Username" autoFocus autoComplete="off" value={username} onChange={(v) => setUsername(v.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40))}
              hint="Letters, digits, dots, dashes and underscores" />
            <TextField label="Email" type="email" autoComplete="off" value={email} onChange={setEmail} hint="What they sign in with" />
            <div className="tf static span">
              <div className="tf-box">
                {choices.length ? (
                  <Dropdown label="Device" value={device} onChange={setDevice}
                    options={[{ value: "", label: "Pick their device" }, ...choices.map((d) => ({ value: d.id, label: deviceLabel(d), hint: `Seen ${ago(d.last_seen)}` }))]} />
                ) : (
                  <span className="dropdown placeholder">No devices yet. Open a tunnel on their device first.</span>
                )}
                <span className="tf-label">Device</span>
              </div>
              <div className="tf-hint">The only device they can sign in from. More can be linked later.</div>
            </div>
            <PasswordField label="Password" value={password} onChange={setPassword} hint="Generate one, or type at least 10 characters with upper and lower case, a number and a symbol." />
          </div>
        </div>
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

export function UserPage({ user, page, routes, devices, onChanged }: { user: User; page: string; routes: Route[]; devices: Device[]; onChanged: () => Promise<void> }) {
  const notify = useNotify();
  const current = USER_PAGES.some(([k]) => k === page) ? page : "profile";
  const [tone, label] = state(user);
  const theirs = routes.filter((r) => user.route_ids.includes(r.id));
  const linked = devices.filter((d) => user.device_ids.includes(d.id));

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

        {current === "profile" && <Profile user={user} edit={edit} />}

        {current === "access" && (
          <div className="profile-grid">
            <section>
              <div className="section-head">
                <h3 className="section-title">Tunnels</h3>
                <AddMenu label="Add a tunnel" placeholder="Find a tunnel" onPick={(id) => quietly({ route_ids: [...user.route_ids, id] })}
                  empty={<div className="menu-note">There are no tunnels yet</div>}
                  items={routes.map((r) => ({ id: r.id, label: r.hostname, sub: r.require_login ? undefined : "Sign-in is off here", disabled: user.route_ids.includes(r.id), note: "Already added" }))} />
              </div>
              {theirs.length ? (
                <ul className="item-list">
                  {theirs.map((r) => (
                    <li key={r.id} className="item-row">
                      <span className={"dot " + (r.enabled ? "ok" : "")} />
                      <a className="person" href={`#/tunnels/${r.id}`}>
                        <span className="scan-target">{r.hostname}</span>
                        <small>{r.require_login ? "Asks for sign-in" : "Sign-in is off"}</small>
                      </a>
                      <button type="button" className="icon-btn small danger" aria-label={`Remove ${r.hostname}`} title="Remove"
                        onClick={() => quietly({ route_ids: user.route_ids.filter((x) => x !== r.id) })}>
                        <Icon name="close" size={18} />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : <p className="empty-note">No tunnels yet</p>}
            </section>
            <section>
              <div className="section-head">
                <h3 className="section-title">Devices</h3>
                <AddMenu label="Link a device" placeholder="Find a device" onPick={(id) => quietly({ device_ids: [...user.device_ids, id] })}
                  empty={<div className="menu-note">There are no devices yet</div>}
                  items={[...devices].sort((a, b) => b.last_seen - a.last_seen).map((d) => ({ id: d.id, label: d.name || shortId(d.id), sub: [d.info?.platform, d.country, `seen ${ago(d.last_seen)}`].filter(Boolean).join(", "), disabled: user.device_ids.includes(d.id), note: "Already linked" }))} />
              </div>
              {linked.length ? (
                <ul className="item-list">
                  {linked.map((d) => (
                    <li key={d.id} className="item-row">
                      <Icon name="devices" size={18} className="item-icon" />
                      <a className="person" href={`#/devices/${d.id}`}>
                        <span className="scan-target">{d.name || shortId(d.id)}</span>
                        <small>{[d.info?.platform, d.country, `seen ${ago(d.last_seen)}`].filter(Boolean).join(", ")}</small>
                      </a>
                      <button type="button" className="icon-btn small danger" aria-label={`Unlink ${d.name || shortId(d.id)}`} title="Unlink"
                        onClick={() => quietly({ device_ids: user.device_ids.filter((x) => x !== d.id) })}>
                        <Icon name="close" size={18} />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : <p className="empty-note">None linked, so they cannot sign in yet</p>}
            </section>
          </div>
        )}

        {current === "activity" && <Activity user={user} />}
      </div>
    </>
  );
}

// Profile is an account at a glance: four figures, then its details and its
// security side by side, each value beside its label with an edit button.
function Profile({ user, edit }: { user: User; edit: (patch: Parameters<typeof api.editUser>[1]) => Promise<void> }) {
  const [list, setList] = useState<SignIn[] | null>(null);
  useEffect(() => {
    api.userActivity(user.id).then(setList).catch(() => setList([]));
  }, [user.id, user.last_login]);
  const month = Date.now() / 1000 - 30 * 86_400;
  const wrong = (list ?? []).filter((s) => s.at > month && s.outcome !== "ok").length;
  const [tone, label] = state(user);

  return (
    <>
      <div className="tally four">
        <div className="tally-item plain"><b>{user.route_ids.length}</b><span>Tunnels</span></div>
        <div className="tally-item plain"><b>{user.device_ids.length}</b><span>Devices</span></div>
        <div className="tally-item"><b>{user.last_login ? ago(user.last_login) : "Never"}</b><span>Last sign-in</span></div>
        <div className={"tally-item " + (wrong ? "bad" : "ok")}><b>{list ? wrong : "..."}</b><span>Refused, 30 days</span></div>
      </div>
      <div className="profile-grid">
        <section>
          <h3 className="section-title">Details</h3>
          <KeyValue label="Username" value={user.username} onSave={(v) => edit({ username: v })} />
          <KeyValue label="Email" value={user.email} type="email" onSave={(v) => edit({ email: v })} />
          <KeyValue label="Name" value={user.name} onSave={(v) => edit({ name: v })} />
        </section>
        <section>
          <h3 className="section-title">Security</h3>
          <PasswordValue onSave={(password) => edit({ password })} />
          <div className="kv"><span className="kv-label">Status</span><span className="kv-value"><span className={"chip " + tone}>{label}</span></span></div>
          <div className="kv"><span className="kv-label">Added</span><span className="kv-value">{new Date(user.created_at * 1000).toLocaleDateString()}</span></div>
        </section>
      </div>
    </>
  );
}

// KeyValue is a label, its value right beside it, and an edit button that turns
// the value into a field.
function KeyValue({ label, value, type, onSave }: { label: string; value: string; type?: string; onSave: (v: string) => Promise<unknown> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const notify = useNotify();
  if (editing) {
    return (
      <form className="kv" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await onSave(draft.trim());
          setEditing(false);
        } catch (err) {
          notify(message(err), "bad");
        } finally {
          setBusy(false);
        }
      }}>
        <span className="kv-label">{label}</span>
        <input className="input kv-input" type={type ?? "text"} autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={label} />
        <span className="kv-actions">
          <button type="button" className="icon-btn small" aria-label="Cancel" title="Cancel" onClick={() => setEditing(false)}><Icon name="close" size={18} /></button>
          <button className="icon-btn small" aria-label="Save" title="Save" disabled={busy}><Icon name="check" size={18} /></button>
        </span>
      </form>
    );
  }
  return (
    <div className="kv">
      <span className="kv-label">{label}</span>
      <span className={"kv-value" + (value ? "" : " muted")}>{value || "None"}</span>
      <button type="button" className="icon-btn small" aria-label={`Change ${label.toLowerCase()}`} title={`Change ${label.toLowerCase()}`}
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}>
        <Icon name="edit" size={18} />
      </button>
    </div>
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
      <div className="kv">
        <span className="kv-label">Password</span>
        <span className="kv-value">Set</span>
        <button type="button" className="icon-btn small" aria-label="Change password" title="Change password" onClick={() => setEditing(true)}>
          <Icon name="edit" size={18} />
        </button>
      </div>
    );
  }
  return (
    <form className="kv-block" onSubmit={async (e) => {
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
      <div className="edit-actions">
        <button type="button" className="btn text" onClick={() => setEditing(false)}>Cancel</button>
        <button className="btn primary" disabled={busy || !strength(password).ok}>Save</button>
      </div>
    </form>
  );
}

// Activity is how an account has been used: figures for the last 30 days, then
// every sign-in attempt as a table.
function Activity({ user }: { user: User }) {
  const [list, setList] = useState<SignIn[] | null>(null);
  useEffect(() => {
    api.userActivity(user.id).then(setList).catch(() => setList([]));
  }, [user.id, user.last_login, user.note]);
  const month = Date.now() / 1000 - 30 * 86_400;
  const recent = (list ?? []).filter((s) => s.at > month);
  const ok = recent.filter((s) => s.outcome === "ok");
  const count = (values: (string | null)[]) => new Set(values.filter(Boolean)).size;

  return (
    <>
      <div className="tally four">
        <div className="tally-item ok"><b>{list ? ok.length : "..."}</b><span>Sign-ins, 30 days</span></div>
        <div className={"tally-item " + (recent.length - ok.length ? "bad" : "")}><b>{list ? recent.length - ok.length : "..."}</b><span>Refused, 30 days</span></div>
        <div className="tally-item plain"><b>{list ? count(ok.map((s) => s.device_id)) : "..."}</b><span>Devices used</span></div>
        <div className="tally-item plain"><b>{list ? count(ok.map((s) => s.country)) : "..."}</b><span>Countries</span></div>
      </div>
      <section>
        <div className="section-head"><h3 className="section-title">Sign-ins</h3></div>
        {list && list.length > 0 ? (
          <LogTable who="Device" entries={list.slice(0, 100).map((s): LogEntry => ({
            at: s.at,
            tone: s.outcome === "ok" ? "ok" : "bad",
            event: s.outcome === "ok" ? "Signed in" : s.outcome === "failed" ? "Wrong password"
              : s.outcome === "unlinked" ? "Refused, not a linked device" : "Blocked and held for review",
            who: s.device_id ? <a className="mono" href={`#/devices/${s.device_id}`}>{shortId(s.device_id)}</a> : undefined,
            ip: s.ip,
            country: s.country,
          }))} />
        ) : <p className="card-note muted">Nothing yet.</p>}
      </Card>
    </>
  );
}
