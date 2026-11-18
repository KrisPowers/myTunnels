import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api, LEVELS, list, message, strength, type Auth } from "./api";
import { CloudflareSetup } from "./Cloudflare";
import { Icon } from "./Icon";
import { dismissed, passkeysWork, signWithPasskey } from "./passkey";
import { solve, type Proof } from "./pow";
import { Callout, TextField } from "./ui";

// Setup holds the dashboard until it has a host account; `onCreated` is
// told when it was just made, so Cloudflare is asked for next. After setup
// this is the sign-in page.
export function Setup({ auth, onChange, onCreated }: { auth: Auth; onChange: () => Promise<void>; onCreated: () => void }) {
  return (
    <Frame>
      <div className="setup-card card">
        <PasswordStep auth={auth} onCreated={onCreated} onDone={onChange} />
      </div>
    </Frame>
  );
}

// ConnectStep is setup's second step: Cloudflare, which services, domains
// and mail run through. It can wait; whatever needs it asks again.
export function ConnectStep({ onDone }: { onDone: () => void }) {
  const [asked, setAsked] = useState(false);
  // Connected already, as when the data came from an earlier install.
  useEffect(() => {
    api.status().then((s) => (s.configured ? onDone() : setAsked(true))).catch(() => setAsked(true));
  }, [onDone]);
  if (!asked) return null;
  return (
    <Frame>
      <div className="setup-card card">
        <StepHead title="Connect Cloudflare" sub="Your services reach the internet through it, at your own domains, with no port opened. myTunnels makes the tunnel and its DNS records itself." />
        <CloudflareSetup onDone={async () => onDone()} />
        <div className="setup-foot">
          <button type="button" className="btn text" onClick={onDone}>Skip for now</button>
        </div>
      </div>
    </Frame>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="setup">
      <div className="setup-brand"><span className="brand-mark"><Icon name="public" size={18} /></span>myTunnels</div>
      <main className="setup-main">{children}</main>
    </div>
  );
}

function StepHead({ title, sub }: { title: string; sub: ReactNode }) {
  return (
    <div className="step-head">
      <h1>{title}</h1>
      <p className="muted">{sub}</p>
    </div>
  );
}

// ---- the host account: create it, or sign in ----

function PasswordStep({ auth, onCreated, onDone }: { auth: Auth; onCreated: () => void; onDone: () => Promise<void> }) {
  const create = !auth.setup.password;
  // Installs from before the host account had a name sign in with the password alone.
  const named = create || auth.setup.account;
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [waiting, setWaiting] = useState<{ ticket: string; sentTo: string; app: boolean } | null>(null);
  // The puzzle a sign-in carries, solved in the background while the password is
  // typed, and again after each try.
  const proof = useRef<Promise<Proof> | null>(null);
  const puzzle = () => {
    proof.current = api.challenge().then(solve);
    proof.current.catch(() => {});
  };
  useEffect(() => {
    if (!create) puzzle();
  }, [create]);
  const rating = strength(password);
  const ready = create
    ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && username.trim().length >= 2 && rating.ok
    : password !== "" && (!named || login.trim() !== "");

  const passkey = async () => {
    setBusy(true);
    setProblem("");
    try {
      await api.passkeySignIn(await signWithPasskey(await api.beginPasskeySignIn()));
      await onDone();
    } catch (err) {
      if (!dismissed(err)) setProblem(message(err));
      setBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setProblem("");
    try {
      if (create) {
        await api.createAccount(email.trim(), username.trim(), password);
        onCreated();
      } else {
        const pow = await proof.current?.catch(() => undefined);
        puzzle();
        const r = await api.login(login.trim(), password, pow);
        if (r.code_required && r.ticket) {
          setWaiting({ ticket: r.ticket, sentTo: r.sent_to || "your email", app: !!r.app });
          setBusy(false);
          return;
        }
      }
      await onDone();
    } catch (err) {
      setProblem(message(err));
      setBusy(false);
    }
  };

  if (waiting) return <CodeStep ticket={waiting.ticket} sentTo={waiting.sentTo} app={waiting.app} onDone={onDone} onBack={() => setWaiting(null)} />;

  return (
    <form onSubmit={submit}>
      <StepHead title={create ? "Create the host account" : "Sign in"}
        sub={create ? "The account that owns this dashboard. Others, admins included, are added under Security." : "Sign in with your account."} />
      {create && (
        <>
          <TextField label="Email" type="email" autoFocus autoComplete="email" value={email} onChange={setEmail} />
          <TextField label="Username" autoComplete="username" value={username}
            onChange={(v) => setUsername(v.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40))}
            hint="Letters, digits, dots, dashes and underscores" />
        </>
      )}
      {!create && named && (
        <TextField label="Email or username" autoFocus autoComplete="username" value={login} onChange={setLogin} />
      )}
      <TextField label="Password" type={show ? "text" : "password"} autoFocus={!named} autoComplete={create ? "new-password" : "current-password"}
        value={password} onChange={setPassword}
        trailing={<button type="button" className="tf-action" onClick={() => setShow((v) => !v)}>{show ? "Hide" : "Show"}</button>}
        hint={create && password ? (
          <>
            <span className={"strength " + rating.level}>{LEVELS[rating.level]}</span>
            {rating.missing.length > 0 && <span>Needs {list(rating.missing)}.</span>}
          </>
        ) : undefined} />
      {problem && <Callout tone="bad" icon="error">{problem}</Callout>}
      <div className="setup-foot">
        {!create && passkeysWork() && (
          <button type="button" className="btn text" disabled={busy} onClick={passkey}>Use a passkey</button>
        )}
        <button className="btn primary" disabled={busy || !ready}>
          {busy && <span className="spinner small on-accent" />}{create ? "Create account" : "Sign in"}<Icon name="arrow_forward" size={18} />
        </button>
      </div>
    </form>
  );
}

// The code that finishes signing in: emailed, when Two-Factor Auth asks for one,
// or from the account's authenticator app, which also takes a recovery code.
function CodeStep({ ticket, sentTo, app, onDone, onBack }: { ticket: string; sentTo: string; app: boolean; onDone: () => Promise<void>; onBack: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setProblem("");
    try {
      await api.loginCode(ticket, code);
      await onDone();
    } catch (err) {
      setProblem(message(err));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      {app
        ? <StepHead title="Authenticator code" sub="Enter the code from your authenticator app, or a recovery code." />
        : <StepHead title="Check your email" sub={<>Enter the code sent to <b>{sentTo}</b>.</>} />}
      <TextField label={app ? "Code" : "6-digit code"} mono autoFocus inputMode="numeric" autoComplete="one-time-code" value={code}
        onChange={(v) => setCode(v.replace(/\D/g, "").slice(0, app ? 10 : 6))} />
      {problem && <Callout tone="bad" icon="error">{problem}</Callout>}
      <div className="setup-foot">
        <button type="button" className="btn text" onClick={onBack}>Back</button>
        <button className="btn primary" disabled={busy || !(code.length === 6 || (app && code.length === 10))}>
          {busy && <span className="spinner small on-accent" />}Verify<Icon name="arrow_forward" size={18} />
        </button>
      </div>
    </form>
  );
}
