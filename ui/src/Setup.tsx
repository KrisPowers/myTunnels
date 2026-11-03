import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, LEVELS, list, message, strength, TOKEN_URL, type Account, type Auth } from "./api";
import { Dropdown } from "./Dropdown";
import { Icon } from "./Icon";
import { Callout, TextField } from "./ui";

const STEPS = ["Admin account", "Cloudflare"];

const TUNNEL_NAME = "homelab";

// Setup holds the dashboard until it can work: an admin account, then
// Cloudflare. Everything else is found by the server. Each step is saved the
// moment it is done, so leaving and coming back resumes where it was left.
// After setup this is the sign-in page.
export function Setup({ auth, onChange }: { auth: Auth; onChange: () => Promise<void> }) {
  const { setup } = auth;

  // Signing in is a gate in front of setup, not one of its steps.
  if (setup.password && !auth.authenticated) {
    return (
      <Frame>
        <div className="setup-card card">
          <PasswordStep auth={auth} onDone={onChange} />
        </div>
      </Frame>
    );
  }

  const step = setup.password ? 1 : 0;
  return (
    <Frame>
      <ol className="steps" aria-label="Setup steps">
        {STEPS.map((label, i) => (
          <li key={label} className={"step " + (i === step ? "now" : i < step ? "done" : "later")} aria-current={i === step ? "step" : undefined}>
            <span className="step-mark">{i < step ? <Icon name="check" size={16} /> : i + 1}</span>
            <span className="step-label">{label}</span>
          </li>
        ))}
      </ol>
      <div className="setup-card card" key={step}>
        {step === 0 ? <PasswordStep auth={auth} onDone={onChange} /> : <CloudflareStep auth={auth} onDone={onChange} />}
      </div>
      <p className="setup-note"><Icon name="cloud" size={16} />Each step saves as you go. Close this page any time and pick up where you left off.</p>
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

// ---- 1. Admin account: create it, or sign in ----

function PasswordStep({ auth, onDone }: { auth: Auth; onDone: () => Promise<void> }) {
  const create = !auth.setup.password;
  // Installs from before the admin account sign in with the password alone.
  const named = create || auth.setup.account;
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [waiting, setWaiting] = useState<{ ticket: string; sentTo: string } | null>(null);
  const rating = strength(password);
  const ready = create
    ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && username.trim().length >= 2 && rating.ok
    : password !== "" && (!named || login.trim() !== "");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setProblem("");
    try {
      if (create) {
        await api.createAccount(email.trim(), username.trim(), password);
      } else {
        const r = await api.login(login.trim(), password);
        if (r.code_required && r.ticket) {
          setWaiting({ ticket: r.ticket, sentTo: r.sent_to ?? "your email" });
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

  if (waiting) return <CodeStep ticket={waiting.ticket} sentTo={waiting.sentTo} onDone={onDone} onBack={() => setWaiting(null)} />;

  return (
    <form onSubmit={submit}>
      <StepHead title={create ? "Create the admin account" : "Sign in"}
        sub={create ? "The account that runs this dashboard." : auth.setup.cloudflare ? "Sign in with the admin account." : "Sign in with the admin account to carry on with setup."} />
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
        <button className="btn primary" disabled={busy || !ready}>
          {busy && <span className="spinner small on-accent" />}{create ? "Create account" : "Sign in"}<Icon name="arrow_forward" size={18} />
        </button>
      </div>
    </form>
  );
}

// The emailed code that finishes signing in, when Two-Factor Auth asks for one.
function CodeStep({ ticket, sentTo, onDone, onBack }: { ticket: string; sentTo: string; onDone: () => Promise<void>; onBack: () => void }) {
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
      <StepHead title="Check your email" sub={<>Enter the code sent to <b>{sentTo}</b>.</>} />
      <TextField label="6-digit code" mono autoFocus inputMode="numeric" autoComplete="one-time-code" value={code}
        onChange={(v) => setCode(v.replace(/\D/g, "").slice(0, 6))} />
      {problem && <Callout tone="bad" icon="error">{problem}</Callout>}
      <div className="setup-foot">
        <button type="button" className="btn text" onClick={onBack}>Back</button>
        <button className="btn primary" disabled={busy || code.length !== 6}>
          {busy && <span className="spinner small on-accent" />}Verify<Icon name="arrow_forward" size={18} />
        </button>
      </div>
    </form>
  );
}

// ---- 2. Cloudflare: one link to make the token, paste it, done ----

type Phase = "idle" | "checking" | "pick" | "connecting" | "connected";

function CloudflareStep({ auth, onDone }: { auth: Auth; onDone: () => Promise<void> }) {
  const [token, setToken] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [connected, setConnected] = useState<Account | null>(null);
  const [problem, setProblem] = useState("");

  // Connecting creates the tunnel and finishes setup; the dashboard opens
  // after a moment on the confirmation.
  const connect = async (account: Account, withToken: string | null) => {
    setPhase("connecting");
    setProblem("");
    try {
      await api.connect(withToken, account.id, TUNNEL_NAME);
      setConnected(account);
      setPhase("connected");
      setTimeout(onDone, 1200);
    } catch (e) {
      setProblem(message(e));
      setPhase(accounts.length > 1 ? "pick" : "idle");
    }
  };

  // Checks a token (or the one saved earlier, with null) and connects straight
  // away when it can see a single account.
  const check = async (withToken: string | null) => {
    setPhase("checking");
    setProblem("");
    try {
      const list = await api.accounts(withToken);
      setAccounts(list);
      if (list.length === 0) {
        setProblem("Cloudflare accepted the token, but it reaches no account or domain. Make it again with the link above and keep All zones selected.");
        setPhase("idle");
      } else if (list.length === 1) {
        await connect(list[0], withToken);
      } else {
        setPhase("pick");
      }
    } catch (e) {
      setProblem(message(e).replace(/^Cloudflare: /, "Cloudflare says: "));
      setPhase("idle");
    }
  };

  // A token saved on an earlier visit is picked up again on arrival.
  useEffect(() => {
    if (auth.setup.token) check(null);
  }, []);

  // A pasted token is checked once typing stops.
  useEffect(() => {
    const t = token.trim();
    if (t.length < 30) return;
    const timer = setTimeout(() => check(t), 500);
    return () => clearTimeout(timer);
  }, [token]);

  const busy = phase === "checking" || phase === "connecting";

  if (phase === "connected") {
    return (
      <>
        <StepHead title="Connected" sub="Opening the dashboard." />
        <Callout tone="ok" icon="check_circle">
          Connected to <b>{connected?.name}</b>. Tunnel <b>{TUNNEL_NAME}</b> is ready.
        </Callout>
      </>
    );
  }

  return (
    <>
      <StepHead title="Connect Cloudflare" sub="myTunnels creates the tunnel and the DNS records for you. It needs an API token to do that." />
      <ol className="how">
        <li>
          <span className="how-num">1</span>
          <div className="how-body">
            <b>Make a token on Cloudflare</b>
            <span className="muted">Opens with the right permissions already picked. Scroll down, press <b>Continue to summary</b>, then <b>Create Token</b>, and copy it.</span>
            <a className="btn primary how-link" href={TOKEN_URL} target="_blank" rel="noreferrer"><Icon name="open_in_new" size={18} />Open Cloudflare</a>
          </div>
        </li>
        <li>
          <span className="how-num">2</span>
          <div className="how-body">
            <b>Paste it here</b>
            <TextField label="API token" type="password" mono autoComplete="off" data-1p-ignore data-lpignore="true"
              placeholder={auth.setup.token ? "Saved. Paste a new one to replace it." : undefined}
              value={token} onChange={setToken}
              trailing={busy ? <span className="spinner small" aria-label="Checking" /> : undefined}
              hint={phase === "checking" ? "Checking the token" : phase === "connecting" ? "Creating the tunnel" : undefined} />
            {phase === "pick" && (
              <div className="pick">
                <span className="muted">This token sees more than one account. Pick the one with your domains.</span>
                <Dropdown label="Cloudflare account" value="" options={[{ value: "", label: "Pick an account" }, ...accounts.map((a) => ({ value: a.id, label: a.name }))]}
                  onChange={(id) => {
                    const account = accounts.find((a) => a.id === id);
                    if (account) connect(account, token.trim() || null);
                  }} />
              </div>
            )}
          </div>
        </li>
      </ol>
      {problem && <Callout tone="bad" icon="error">{problem}</Callout>}
    </>
  );
}
