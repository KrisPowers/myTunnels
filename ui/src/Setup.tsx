import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, message, TOKEN_URL, type Account, type Auth } from "./api";
import { Dropdown } from "./Dropdown";
import { Icon } from "./Icon";
import { Callout, TextField } from "./ui";

const STEPS = ["Admin password", "Cloudflare"];

const TUNNEL_NAME = "homelab";

// Setup holds the dashboard until it can work: an admin password, then
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

// ---- 1. Admin password: create it, or sign in ----

const LEVELS = { poor: "Poor", decent: "Decent", good: "Good", strong: "Strong" } as const;

// strength rates a new password. It is accepted once nothing is missing:
// 10 or more characters with upper and lower case, a number and a symbol.
function strength(p: string) {
  const missing = [
    p.length < 10 && "10 or more characters",
    !/[A-Z]/.test(p) && "an uppercase letter",
    !/[a-z]/.test(p) && "a lowercase letter",
    !/[0-9]/.test(p) && "a number",
    !/[^A-Za-z0-9]/.test(p) && "a symbol such as ! or $",
  ].filter((m): m is string => Boolean(m));
  const level: keyof typeof LEVELS = missing.length > 2 ? "poor" : missing.length > 0 ? "decent" : p.length >= 14 ? "strong" : "good";
  return { ok: missing.length === 0, level, missing };
}

function list(items: string[]) {
  return items.length < 2 ? items.join("") : items.slice(0, -1).join(", ") + " and " + items[items.length - 1];
}

function PasswordStep({ auth, onDone }: { auth: Auth; onDone: () => Promise<void> }) {
  const create = !auth.setup.password;
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const rating = strength(password);
  const ready = password !== "" && (!create || rating.ok);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setProblem("");
    try {
      await (create ? api.createPassword(password) : api.login(password));
      await onDone();
    } catch (err) {
      setProblem(message(err));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <StepHead title={create ? "Create the admin password" : "Sign in"}
        sub={create ? "The one password for this dashboard." : auth.setup.cloudflare ? "Enter the admin password." : "Enter the admin password to carry on with setup."} />
      <TextField label="Password" type={show ? "text" : "password"} autoFocus autoComplete={create ? "new-password" : "current-password"}
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
          {busy && <span className="spinner small on-accent" />}{create ? "Create password" : "Sign in"}<Icon name="arrow_forward" size={18} />
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

  // Connected during this visit: carry on by itself after a moment.
  useEffect(() => {
    if (phase !== "connected" || auth.setup.cloudflare) return;
    const t = setTimeout(() => finish.current(), 1200);
    return () => clearTimeout(t);
  }, [phase, auth.setup.cloudflare]);

  const busy = phase === "checking" || phase === "connecting";

  return (
    <>
      <StepHead title="Connect Cloudflare"
        sub="myTunnels creates the tunnel and the DNS records for you. It needs an API token to do that." />

      {phase === "connected" ? (
        <Callout tone="ok" icon="check_circle">
          Connected to <b>{settings?.cloudflare.account_name ?? "your account"}</b>. Tunnel <b>{settings?.cloudflare.tunnel_name ?? TUNNEL_NAME}</b> is ready.
        </Callout>
      ) : (
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
      )}

      {problem && <Callout tone="bad" icon="error">{problem}</Callout>}

      <Foot note={phase === "connected" ? <SaveMark state="saved" /> : null}>
        <button type="button" className="btn primary" disabled={phase !== "connected"} onClick={onDone}>Continue<Icon name="arrow_forward" size={18} /></button>
      </Foot>
    </>
  );
}

// ---- 3. Network: where the apps are, and what counts as home ----

function NetworkStep({ onBack, onDone }: { onBack: () => void; onDone: () => Promise<void> }) {
  const [host, setHost] = useState<string | null>(null);
  const [trusted, setTrusted] = useState("");
  const [fallback, setFallback] = useState("");
  const [status, setStatus] = useState<Status | null>(null);
  const [saved, setSaved] = useState<"" | "saving" | "saved">("");
  const [problem, setProblem] = useState("");
  const first = useRef(true);

  useEffect(() => {
    api.settings().then((s) => {
      setHost(s.upstream_host);
      setTrusted(s.trusted_networks);
      setFallback(s.default_upstream_host);
    }).catch((e) => setProblem(message(e)));
    api.status().then(setStatus).catch(() => {});
  }, []);

  const save = async () => {
    if (host === null) return false;
    setSaved("saving");
    try {
      await api.saveNetwork(host.trim() || fallback, trusted);
      setSaved("saved");
      setProblem("");
      return true;
    } catch (e) {
      setSaved("");
      setProblem(message(e));
      return false;
    }
  };

  // Saved a moment after each change.
  useEffect(() => {
    if (host === null) return;
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(save, 700);
    return () => clearTimeout(t);
  }, [host, trusted]);

  return (
    <>
      <StepHead title="Your network" sub="The defaults suit most setups. Check them and carry on." />
      <TextField label="Where your apps run" mono value={host ?? ""} placeholder={fallback} onChange={setHost}
        hint={<span>The host each tunnel's port is on, as this container sees it. <code>host.docker.internal</code> is the computer running Docker.</span>} />
      <div className="field">
        <span className="field-label">Home network</span>
        <div className="ip-line">
          {status?.public_ips.length ? status.public_ips.map((ip) => <span key={ip} className="port-chip">{ip}</span>) : <span className="muted">Looking up this network's public address</span>}
        </div>
        <span className="field-hint">Visitors arriving from these addresses count as on the same network as this host.</span>
      </div>
      <TextField label="Also count as home (optional)" mono rows={2} value={trusted} onChange={setTrusted}
        hint="One network per line, such as a VPN range." />
      {problem && <Callout tone="bad" icon="error">{problem}</Callout>}
      <Foot onBack={onBack} note={<SaveMark state={saved} />}>
        <button type="button" className="btn primary" disabled={host === null} onClick={async () => (await save()) && onDone()}>Continue<Icon name="arrow_forward" size={18} /></button>
      </Foot>
    </>
  );
}

// ---- 4. Ready: what was set up, how it should look, then in ----

const THEMES: { value: string; label: string; icon: IconName }[] = [
  { value: "system", label: "System", icon: "brightness_auto" },
  { value: "light", label: "Light", icon: "light_mode" },
  { value: "dark", label: "Dark", icon: "dark_mode" },
];

function ReadyStep({ onBack, onDone }: { onBack: () => void; onDone: () => Promise<void> }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [theme, setTheme] = useState(loadLook("theme"));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  useEffect(() => {
    api.settings().then(setSettings).catch(() => {});
    const poll = () => api.status().then(setStatus).catch(() => {});
    poll();
    const t = setInterval(poll, 2000);
    return () => clearInterval(t);
  }, []);

  const links = status?.connections ?? 0;
  const cf = settings?.cloudflare;

  return (
    <>
      <StepHead title="All set" sub="Everything below is saved. Pick a look and open the dashboard." />
      <ul className="checklist">
        <li><Icon name="check_circle" className="ok" /><span><b>Admin password</b><span className="muted">Set</span></span></li>
        <li><Icon name="check_circle" className="ok" /><span><b>Cloudflare</b><span className="muted">{cf ? `${cf.account_name}, tunnel ${cf.tunnel_name}` : "Connected"}</span></span></li>
        <li>
          {links > 0 ? <Icon name="check_circle" className="ok" /> : <span className="spinner small" />}
          <span><b>Connector</b><span className="muted">{links > 0 ? `Online, ${links} links to Cloudflare` : status?.last_error ?? "Connecting to Cloudflare"}</span></span>
        </li>
        <li><Icon name="check_circle" className="ok" /><span><b>Network</b><span className="muted">Apps on <span className="mono">{settings?.upstream_host ?? ""}</span></span></span></li>
      </ul>
      <div className="field">
        <span className="field-label">Look</span>
        <div className="theme-tiles" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => (
            <button key={t.value} type="button" role="radio" aria-checked={theme === t.value} className="theme-tile"
              onClick={() => {
                saveLook("theme", t.value);
                setTheme(t.value);
              }}>
              <Icon name={t.icon} size={24} />
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      </div>
      {problem && <Callout tone="bad" icon="error">{problem}</Callout>}
      <Foot onBack={onBack}>
        <button type="button" className="btn primary" disabled={busy} onClick={async () => {
          setBusy(true);
          try {
            await onDone();
          } catch (e) {
            setProblem(message(e));
            setBusy(false);
          }
        }}>Open dashboard<Icon name="arrow_forward" size={18} /></button>
      </Foot>
    </>
  );
}
