import { useEffect, useState, type FormEvent } from "react";
import { ago, api, LEVELS, list, message, shortId, strength, type Device, type Group, type Me, type Route, type SignIn, type User } from "./api";
import { Icon, type IconName } from "./Icon";
import { go } from "./route";
import { Dropdown } from "./Dropdown";
import { useCan } from "./me";
import { AddMenu, Avatar, Callout, Card, Dialog, LogTable, MoreMenu, Row, SubNav, Switch, TextField, useNotify, type LogEntry } from "./ui";

// The roles an account holds: Host, the account made at setup, and Admin.
function Roles({ u }: { u: User }) {
  const host = u.permissions.includes("host");
  const admin = u.permissions.includes("admin");
  if (!host && !admin) return null;
  return (
    <span className="roles">
      {host && <span className="chip plain small-chip">Host</span>}
      {admin && <span className="chip plain small-chip">Admin</span>}
    </span>
  );
}

function state(u: User): [string, string] {
  if (u.note) return ["bad", "Held for review"];
  return u.enabled ? ["ok", "Active"] : ["", "Suspended"];
}

// Users are the accounts people sign in with, by email, at tunnels that ask
// for one: the body of Security & Roles' Users tab.
export function Users({ users }: { users: User[] | null }) {
  const can = useCan();
  return (
    <>
      <div className="page-body stack">
        {users && users.length === 0 && (
          <div className="card welcome">
            <Icon name="group" size={40} />
            <h2>No accounts yet</h2>
            <p className="muted">Add an account, then pick its permissions and the tunnels it may open.</p>
            {can("users.manage") && <a className="btn primary" href="#/users/new"><Icon name="add" size={18} />New user</a>}
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
                        <span className="scan-target">{u.name || u.username}<Roles u={u} /></span>
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

// What a storage-only account holds: the dashboard, for Storage and nothing else.
const STORAGE_ONLY = ["dashboard", "media.view", "media.upload", "media.delete", "drive.view", "drive.edit", "drive.delete"];

export function NewUser({ devices, routes, onAdded }: { devices: Device[]; routes: Route[]; onAdded: () => Promise<void> }) {
  const [access, setAccess] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [device, setDevice] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const notify = useNotify();
  const ready = username.trim().length >= 2 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && strength(password).ok;
  // Devices seen most recently first.
  const choices = [...devices].sort((a, b) => b.last_seen - a.last_seen);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    try {
      const user = await api.addUser({ username, email, password, device_id: device });
      if (access === "storage") {
        await api.editUser(user.id, { permissions: STORAGE_ONLY, route_ids: routes.filter((r) => r.target_scheme === "dashboard").map((r) => r.id) });
      }
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
          <div className="page-sub">They sign in with their email and password, from one device. Add tunnels once the account exists.</div>
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
                <Dropdown label="Device" value={device} onChange={setDevice}
                  options={[{ value: "", label: "First to sign in" }, ...choices.map((d) => ({ value: d.id, label: deviceLabel(d), hint: `Seen ${ago(d.last_seen)}` }))]} />
                <span className="tf-label">Device</span>
              </div>
              <div className="tf-hint">The only device they can sign in from. More can be linked later.</div>
            </div>
            <div className="tf static span">
              <div className="tf-box">
                <Dropdown label="Access" value={access} onChange={setAccess}
                  options={[{ value: "", label: "Pick later" }, { value: "storage", label: "Storage only", hint: "Their own photos, videos and files" }]} />
                <span className="tf-label">Access</span>
              </div>
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
  ["permissions", "Permissions", "key"],
  ["activity", "Activity", "history"],
];

export function UserPage({ user, page, routes, devices, catalog, me, onChanged }: { user: User; page: string; routes: Route[]; devices: Device[]; catalog: Group[]; me: Me; onChanged: () => Promise<void> }) {
  const notify = useNotify();
  const can = useCan();
  const current = USER_PAGES.some(([k]) => k === page) ? page : "profile";
  const [tone, label] = state(user);

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
              <Roles u={user} />
            </div>
          </div>
        </div>
        <div className="page-actions">
          <div className="head-meta">
            {can("users.manage") && <MoreMenu label="Account actions" actions={user.permissions.includes("host") ? [
              { label: "Sign out everywhere", icon: "logout", onClick: () => api.signOutUser(user.id).then(() => notify("Signed out everywhere")).catch((e) => notify(message(e), "bad")) },
            ] : [
              user.enabled
                ? { label: "Suspend", icon: "block", onClick: () => quietly({ enabled: false }, "Suspended") }
                : { label: user.note ? "Unlock" : "Reinstate", icon: "check_circle", onClick: () => quietly({ enabled: true }, user.note ? "Unlocked" : "Reinstated") },
              { label: "Sign out everywhere", icon: "logout", onClick: () => api.signOutUser(user.id).then(() => notify("Signed out everywhere")).catch((e) => notify(message(e), "bad")) },
              ...(can("users.delete") ? [{ label: "Remove", icon: "delete" as IconName, danger: true, confirm: "Remove for good", onClick: remove }] : []),
            ]} />}
            <small>{user.last_login ? `Signed in ${ago(user.last_login)}` : "Never signed in"}</small>
          </div>
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

        {current === "profile" && <Profile user={user} routes={routes} devices={devices} edit={edit} onChange={quietly} />}

        {current === "permissions" && <Permissions user={user} catalog={catalog} me={me} onSet={(permissions) => quietly({ permissions })} />}

        {current === "activity" && <Activity user={user} />}
      </div>
    </>
  );
}

// Permissions are what an account may do on the dashboard, a card per
// feature. Admin holds them all, including making others admins. Anyone can give
// only what they hold themselves, and no one changes their own.
function Permissions({ user, catalog, me, onSet }: { user: User; catalog: Group[]; me: Me; onSet: (permissions: string[]) => void }) {
  const can = useCan();
  const self = me.id === user.id;
  const admin = user.permissions.includes("admin");
  const has = (key: string) => user.permissions.includes(key) || (admin && key !== "admin");
  const set = (key: string, on: boolean) => onSet(on ? [...user.permissions, key] : user.permissions.filter((k) => k !== key));
  return (
    <>
      {self ? (
        <Callout icon="info">These are your own permissions. Someone else who manages accounts changes them.</Callout>
      ) : !has("dashboard") && (
        <Callout icon="info">Until Sign in to the dashboard is on, these apply only to git, through its Git permissions.</Callout>
      )}
      {catalog.map((g) => (
        <Card key={g.label} title={g.label}>
          {g.permissions.map((p) => (
            <Row key={p.key} title={p.label} sub={p.hint || undefined}>
              <Switch label={p.label} on={has(p.key)} disabled={self || !can("users.manage") || !can(p.key) || (admin && p.key !== "admin")} onChange={(v) => set(p.key, v)} />
            </Row>
          ))}
        </Card>
      ))}
    </>
  );
}

type Patch = Parameters<typeof api.editUser>[1];

const GB = 1024 ** 3;

// The bytes a typed limit in GB comes to; blank or 0 is no limit.
function limitOf(typed: string) {
  const gb = typed.trim() ? parseFloat(typed) : 0;
  if (!(gb >= 0)) throw new Error("Type the limit in GB, or leave it blank for none");
  return Math.round(gb * GB);
}

// Profile is an account at a glance: its details and the
// tunnels it may open on the left, its security and the devices it signs in
// from on the right.
function Profile({ user, routes, devices, edit, onChange }: {
  user: User;
  routes: Route[];
  devices: Device[];
  edit: (patch: Patch) => Promise<void>;
  onChange: (patch: Patch) => unknown;
}) {
  const can = useCan();
  const manage = can("users.manage");
  const theirs = routes.filter((r) => user.route_ids.includes(r.id));
  const linked = devices.filter((d) => user.device_ids.includes(d.id));
  const [tone, label] = state(user);

  return (
    <>
      <div className="profile-grid">
        <div className="profile-col">
          <section>
            <h3 className="section-title">Details</h3>
            <KeyValue label="Username" value={user.username} onSave={(v) => edit({ username: v })} />
            <KeyValue label="Email" value={user.email} type="email" onSave={(v) => edit({ email: v })} />
            <KeyValue label="Name" value={user.name} onSave={(v) => edit({ name: v })} />
            {!user.permissions.includes("host") && (
              <KeyValue label="Storage limit" value={user.storage_limit ? `${+(user.storage_limit / GB).toFixed(2)} GB` : ""} onSave={(v) => edit({ storage_limit: limitOf(v) })} />
            )}
          </section>
          <section>
            <div className="section-head">
              <h3 className="section-title">Tunnels</h3>
              {manage && (
                <AddMenu label="Add a tunnel" placeholder="Find a tunnel" onPick={(id) => onChange({ route_ids: [...user.route_ids, id] })}
                  empty={<div className="menu-note">There are no tunnels yet</div>}
                  items={routes.map((r) => ({ id: r.id, label: r.hostname, sub: r.require_login ? undefined : "Sign-in is off here", disabled: user.route_ids.includes(r.id), note: "Already added" }))} />
              )}
            </div>
            {theirs.length ? (
              <ul className="tunnel-pills">
                {theirs.map((r) => (
                  <li key={r.id} className="tunnel-pill">
                    <span className={"dot " + (r.enabled ? "ok" : "")} />
                    <a href={`#/tunnels/${r.id}`} title={r.require_login ? "Asks for sign-in" : "Sign-in is off here"}>{r.hostname}</a>
                    {manage && (
                      <button type="button" className="tunnel-pill-x" aria-label={`Remove ${r.hostname}`} title="Remove access"
                        onClick={() => onChange({ route_ids: user.route_ids.filter((x) => x !== r.id) })}>
                        <Icon name="close" size={16} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            ) : <p className="empty-note">No tunnels yet</p>}
          </section>
        </div>
        <section>
          <h3 className="section-title">Security</h3>
          <PasswordValue onSave={(password) => edit({ password })} />
          <div className="kv"><span className="kv-label">Status</span><span className="kv-value"><span className={"chip " + tone}>{label}</span></span></div>
          <div className="kv"><span className="kv-label">Added</span><span className="kv-value">{new Date(user.created_at * 1000).toLocaleDateString()}</span></div>
          <div className="section-head sub">
            <h4 className="section-title">Devices</h4>
            {manage && (
              <AddMenu label="Link a device" placeholder="Find a device" onPick={(id) => onChange({ device_ids: [...user.device_ids, id] })}
                empty={<div className="menu-note">There are no devices yet</div>}
                items={[...devices].sort((a, b) => b.last_seen - a.last_seen).map((d) => ({ id: d.id, label: d.name || shortId(d.id), sub: [d.info?.platform, d.country, `seen ${ago(d.last_seen)}`].filter(Boolean).join(", "), disabled: user.device_ids.includes(d.id), note: "Already linked" }))} />
            )}
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
                  {manage && (
                    <button type="button" className="icon-btn small danger" aria-label={`Unlink ${d.name || shortId(d.id)}`} title="Unlink"
                      onClick={() => onChange({ device_ids: user.device_ids.filter((x) => x !== d.id) })}>
                      <Icon name="close" size={18} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : <p className="empty-note">None linked, so they cannot sign in yet</p>}
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

// PasswordValue shows that a password is set, and changes it in a dialog from
// an edit button.
function PasswordValue({ onSave }: { onSave: (password: string) => Promise<unknown> }) {
  const [editing, setEditing] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const notify = useNotify();
  return (
    <div className="kv">
      <span className="kv-label">Password</span>
      <span className="kv-value">Set</span>
      <button type="button" className="icon-btn small" aria-label="Change password" title="Change password" onClick={() => setEditing(true)}>
        <Icon name="edit" size={18} />
      </button>
      {editing && (
        <Dialog title="Change password" onClose={() => setEditing(false)}>
          <form onSubmit={async (e) => {
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
        </Dialog>
      )}
    </div>
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
        ) : <p className="empty-note">{list ? "No sign-ins yet" : "Loading"}</p>}
      </section>
    </>
  );
}
