import { useEffect, useState, type FormEvent } from "react";
import { api, message, type Smtp, type TwoFactor } from "./api";
import { Dropdown, type Option } from "./Dropdown";
import { Icon } from "./Icon";
import { Dialog, Switch, TextField, useNotify } from "./ui";

const SECURITY: Option<Smtp["security"]>[] = [
  { value: "starttls", label: "STARTTLS", hint: "Usually port 587" },
  { value: "tls", label: "TLS", hint: "Usually port 465" },
  { value: "none", label: "None", hint: "Only for a server on your own network" },
];
const PORTS: Record<Smtp["security"], number> = { starttls: 587, tls: 465, none: 25 };

// TwoFactorSetup is emailed sign-in codes in one panel: until SMTP is set up,
// the button to set it up; then the switch that asks for a code at every
// sign-in, the dashboard's and every tunnel's, with where codes come from.
export function TwoFactorSetup() {
  const [tf, setTf] = useState<TwoFactor | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [testing, setTesting] = useState(false);
  const notify = useNotify();
  useEffect(() => {
    api.twoFactor().then(setTf).catch((e) => notify(message(e), "bad"));
  }, [notify]);

  const turn = async (on: boolean) => {
    setBusy(true);
    try {
      setTf(await api.saveTwoFactor(on));
      notify(on ? "Codes are on for every sign-in" : "Codes are off");
    } catch (e) {
      notify(message(e), "bad");
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setTesting(true);
    try {
      const r = await api.testMail();
      notify(`Test email sent to ${r.to}`);
    } catch (e) {
      notify(message(e), "bad");
    } finally {
      setTesting(false);
    }
  };

  if (!tf) return null;
  const smtp = tf.smtp;
  return (
    <div className="card welcome">
      <Icon name="lock" size={40} />
      <h2>Two-factor sign-in</h2>
      <p className="muted">After the password, a code is emailed and must be entered to finish signing in, on the dashboard and every tunnel with sign-in.</p>
      {!smtp ? (
        <button type="button" className="btn primary" onClick={() => setEditing(true)}><Icon name="settings" size={18} />Set up SMTP</button>
      ) : (
        <>
          <label className="mfa-toggle">
            <Switch label="Email codes" on={tf.enabled} disabled={busy || (!tf.enabled && !tf.admin_email)} onChange={turn} />
            <span>{tf.enabled ? "Email codes are on" : "Email codes are off"}</span>
          </label>
          {!tf.admin_email && <p className="muted">Set the host account's email under <a href="#/settings/account">Settings, Account</a> to turn them on.</p>}
          <p className="mfa-from">Sent from <b>{smtp.from}</b> through <span className="mono">{smtp.host}:{smtp.port}</span>, {SECURITY.find((x) => x.value === smtp.security)?.label}</p>
          <div className="mfa-actions">
            <button type="button" className="btn small" onClick={() => setEditing(true)}><Icon name="edit" size={16} />Change SMTP</button>
            <button type="button" className="btn small" disabled={testing || !tf.admin_email} onClick={test}>{testing && <span className="spinner small" />}Send a test</button>
          </div>
        </>
      )}
      {editing && (
        <Dialog title="SMTP" onClose={() => setEditing(false)}>
          <MailForm smtp={smtp} onSaved={(next) => {
            setTf(next);
            setEditing(false);
          }} onCancel={() => setEditing(false)} />
        </Dialog>
      )}
    </div>
  );
}

function MailForm({ smtp, onSaved, onCancel }: { smtp: Smtp | null; onSaved: (tf: TwoFactor) => void; onCancel: () => void }) {
  const [host, setHost] = useState(smtp?.host ?? "");
  const [port, setPort] = useState(String(smtp?.port ?? 587));
  const [security, setSecurity] = useState<Smtp["security"]>(smtp?.security ?? "starttls");
  const [username, setUsername] = useState(smtp?.username ?? "");
  const [password, setPassword] = useState("");
  const [from, setFrom] = useState(smtp?.from ?? "");
  const [busy, setBusy] = useState(false);
  const notify = useNotify();
  const ready = host.trim() !== "" && Number(port) > 0 && from.trim() !== "";

  // The usual port follows the security picked, unless another was typed.
  const pick = (next: Smtp["security"]) => {
    if (Number(port) === PORTS[security]) setPort(String(PORTS[next]));
    setSecurity(next);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    try {
      onSaved(await api.saveSmtp({ host: host.trim(), port: Number(port), security, username: username.trim(), password: password || undefined, from: from.trim() }));
      notify("SMTP saved");
    } catch (err) {
      notify(message(err), "bad");
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <div className="edit-row">
        <TextField className="grow" label="SMTP host" mono placeholder="smtp.gmail.com" autoFocus autoComplete="off" value={host} onChange={setHost} />
        <TextField className="port" label="Port" mono inputMode="numeric" value={port} onChange={(v) => setPort(v.replace(/\D/g, "").slice(0, 5))} />
        <div className="tf static protocol">
          <div className="tf-box">
            <Dropdown label="Security" value={security} options={SECURITY} onChange={pick} />
            <span className="tf-label">Security</span>
          </div>
        </div>
      </div>
      <div className="edit-row">
        <TextField className="grow" label="Username" placeholder="you@gmail.com" autoComplete="off" data-1p-ignore data-lpignore="true" value={username} onChange={setUsername} />
        <TextField className="grow" label="Password" type="password" autoComplete="off" data-1p-ignore data-lpignore="true"
          placeholder={smtp?.password_set ? "Saved. Type a new one to replace it." : undefined} value={password} onChange={setPassword}
          hint="For Gmail, an app password" />
      </div>
      <TextField label="From" placeholder="you@gmail.com" autoComplete="off" value={from} onChange={setFrom}
        hint="Saving signs in with these credentials to check them." />
      <div className="edit-actions">
        <button type="button" className="btn text" onClick={onCancel}>Cancel</button>
        <button className="btn primary" disabled={busy || !ready}>{busy && <span className="spinner small on-accent" />}Save</button>
      </div>
    </form>
  );
}
