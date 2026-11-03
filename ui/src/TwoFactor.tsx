import { useEffect, useState, type FormEvent } from "react";
import { api, editOf, message, type Route, type Smtp, type TwoFactor } from "./api";
import { Dropdown, type Option } from "./Dropdown";
import { Icon } from "./Icon";
import { Card, Row, Switch, TextField, useNotify } from "./ui";

const SECURITY: Option<Smtp["security"]>[] = [
  { value: "starttls", label: "STARTTLS", hint: "Usually port 587" },
  { value: "tls", label: "TLS", hint: "Usually port 465" },
  { value: "none", label: "None", hint: "Only for a server on your own network" },
];
const PORTS: Record<Smtp["security"], number> = { starttls: 587, tls: 465, none: 25 };

// TwoFactorPage sets up emailed sign-in codes: the SMTP credentials they are
// sent with (Gmail, Outlook, any provider), then where they are asked for, the
// dashboard and each tunnel with sign-in on.
export function TwoFactorPage({ routes, onChanged }: { routes: Route[]; onChanged: () => Promise<void> }) {
  const [tf, setTf] = useState<TwoFactor | null>(null);
  const [busy, setBusy] = useState(false);
  const notify = useNotify();
  useEffect(() => {
    api.twoFactor().then(setTf).catch((e) => notify(message(e), "bad"));
  }, [notify]);

  const signIn = routes.filter((r) => r.require_login);
  const asking = signIn.filter((r) => r.require_code).length;

  const dashboard = async (on: boolean) => {
    setBusy(true);
    try {
      setTf(await api.saveTwoFactor(on));
      notify(on ? "Codes are on for the dashboard" : "Codes are off for the dashboard");
    } catch (e) {
      notify(message(e), "bad");
    } finally {
      setBusy(false);
    }
  };
  const tunnel = (r: Route, on: boolean) =>
    api.editRoute(r.id, { ...editOf(r), require_code: on }).then(onChanged).catch((e) => notify(message(e), "bad"));

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Two-Factor Auth</h1>
          <div className="page-sub">
            <span>{tf?.dashboard ? "On for the dashboard" : "Off for the dashboard"}</span>
            <span><b>{asking}</b> tunnel{asking === 1 ? "" : "s"} ask for a code</span>
          </div>
        </div>
      </div>
      {tf && (
        <div className="page-body stack">
          <MailCard tf={tf} onSaved={setTf} />
          <Card title="Where codes are asked" sub="After the password, a code is emailed and must be entered to finish signing in.">
            <Row title="Dashboard sign-in" sub={
              !tf.smtp ? "Enter your SMTP credentials first."
                : !tf.admin_email ? <>Set the admin email under <a href="#/settings/account">Settings, Account</a> first.</>
                : <>Every sign-in to this dashboard, with a code sent to <b>{tf.admin_email}</b>. Turning it on sends a test email first.</>
            }>
              <Switch label="Codes for the dashboard" on={tf.dashboard} disabled={busy || (!tf.dashboard && (!tf.smtp || !tf.admin_email))} onChange={dashboard} />
            </Row>
            {signIn.map((r) => (
              <Row key={r.id} title={<a href={`#/tunnels/${r.id}`}>{r.hostname}</a>} sub={r.require_code ? "A code to the account's email after signing in" : "Sign-in only"}>
                <Switch label={`Email code on ${r.hostname}`} on={r.require_code} onChange={(v) => tunnel(r, v)} />
              </Row>
            ))}
            {signIn.length === 0 && <Row title="Tunnels" sub="No tunnel asks for sign-in yet. Any that does can ask for a code as well." />}
          </Card>
        </div>
      )}
    </>
  );
}

// MailCard is the SMTP credentials codes are sent with: shown once saved,
// with an edit button and a test, or a Set up button.
function MailCard({ tf, onSaved }: { tf: TwoFactor; onSaved: (tf: TwoFactor) => void }) {
  const [open, setOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const notify = useNotify();
  const smtp = tf.smtp;

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

  return (
    <Card title="SMTP" sub={smtp ? "Codes are sent with these credentials." : "Not set up."}
      action={smtp ? (
        <button type="button" className="icon-btn" aria-label="Change SMTP credentials" title="Change" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <Icon name="edit" size={20} />
        </button>
      ) : !open && <button type="button" className="btn" onClick={() => setOpen(true)}>Set up</button>}>
      {open ? (
        <MailForm smtp={smtp} onSaved={(next) => {
          onSaved(next);
          setOpen(false);
        }} onCancel={() => setOpen(false)} />
      ) : smtp && (
        <>
          <Row title="Host"><span className="mono">{smtp.host}:{smtp.port}</span></Row>
          <Row title="Security"><span>{SECURITY.find((s) => s.value === smtp.security)?.label}</span></Row>
          <Row title="Username"><span>{smtp.username || "None"}</span></Row>
          <Row title="From"><span>{smtp.from}</span></Row>
          <div className="card-foot">
            <button type="button" className="btn" disabled={testing || !tf.admin_email} onClick={test}>
              {testing && <span className="spinner small" />}Send a test
            </button>
          </div>
        </>
      )}
    </Card>
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
    <form className="card-steps" onSubmit={submit}>
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
