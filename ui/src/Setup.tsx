import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api, message, TOKEN_URL, type Account, type Auth, type Settings, type Status } from "./api";
import { Dropdown } from "./Dropdown";
import { Icon, type IconName } from "./Icon";
import { loadLook, saveLook } from "./prefs";
import { Callout, SaveMark } from "./ui";

const STEPS: { label: string; icon: IconName }[] = [
  { label: "Admin password", icon: "lock" },
  { label: "Cloudflare", icon: "cloud" },
  { label: "Network", icon: "router" },
  { label: "Ready", icon: "check_circle" },
];

const TUNNEL_NAME = "homelab";

// Setup is where the dashboard opens until it is fully set up: one step at a
// time, each saved on the server as soon as it is done, so leaving and coming
// back resumes at the first step still open. After setup it is the sign-in page.
export function Setup({ auth, onChange }: { auth: Auth; onChange: () => Promise<void> }) {
  const { setup } = auth;
  const done = [setup.password && auth.authenticated, setup.cloudflare, setup.network, false];
  const open = done.indexOf(false);
  const [at, setAt] = useState(open);
  const step = Math.min(at, open);
  const next = async () => {
    await onChange();
    setAt((a) => a + 1);
  };

  // Signing in is a gate in front of setup, not one of its steps.
  if (setup.password && !auth.authenticated) {
    return (
      <Frame>
        <div className="setup-card card">
          <AdminStep auth={auth} onDone={onChange} />
        </div>
      </Frame>
    );
  }

  return (
    <Frame>
      <ol className="steps" aria-label="Setup steps">
        {STEPS.map((s, i) => {
          const state = i === step ? "now" : done[i] ? "done" : "later";
          return (
            <li key={s.label} className={"step " + state}>
              <button type="button" disabled={i > open} onClick={() => setAt(i)} aria-current={i === step ? "step" : undefined}>
                <span className="step-mark">{state === "done" ? <Icon name="check" size={16} /> : i + 1}</span>
                <span className="step-label">{s.label}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <div className="setup-card card" key={step}>
        {step === 0 && <AdminStep auth={auth} onDone={next} />}
        {step === 1 && <CloudflareStep auth={auth} onBack={() => setAt(0)} onDone={next} />}
        {step === 2 && <NetworkStep onBack={() => setAt(1)} onDone={next} />}
        {step === 3 && <ReadyStep onBack={() => setAt(2)} onDone={async () => {
          await api.finishSetup();
          await onChange();
        }} />}
      </div>
      {auth.authenticated && (
        <p className="setup-note"><Icon name="cloud" size={16} />Each step saves as you go. Close this page any time and pick up where you left off.</p>
      )}
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

function StepHead({ icon, title, sub }: { icon: IconName; title: string; sub: ReactNode }) {
  return (
    <div className="step-head">
      <span className="badge big"><Icon name={icon} size={28} /></span>
      <div>
        <h1>{title}</h1>
        <p className="muted">{sub}</p>
      </div>
    </div>
  );
}

function Foot({ onBack, children, note }: { onBack?: () => void; children: ReactNode; note?: ReactNode }) {
  return (
    <div className="setup-foot">
      {onBack && <button type="button" className="btn text" onClick={onBack}><Icon name="arrow_back" size={18} />Back</button>}
      <span className="setup-foot-note">{note}</span>
      {children}
    </div>
  );
}

// ---- 1. Admin password: create it, or sign in to carry on ----

function AdminStep({ auth, onDone }: { auth: Auth; onDone: () => Promise<void> }) {
  const create = !auth.setup.password;
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const short = create && password.length < 10;

  if (auth.setup.password && auth.authenticated) {
    return (
      <>
        <StepHead icon="lock" title="Admin password is set" sub="It protects this dashboard." />
        <Foot><button type="button" className="btn primary" onClick={onDone}>Continue<Icon name="arrow_forward" size={18} /></button></Foot>
      </>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (short || !password) return;
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
      <StepHead icon="lock" title={create ? "Create the admin password" : "Sign in"}
        sub={create ? "The one password for this dashboard. At least 10 characters." : auth.setup.done ? "Enter the admin password." : "Enter the admin password to carry on with setup."} />
      <div className="field">
        <label className="field-label" htmlFor="password">Password</label>
        <div className="input-wrap">
          <input id="password" className="input big" type={show ? "text" : "password"} autoFocus
            autoComplete={create ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} />
          <button type="button" className="input-action" onClick={() => setShow((s) => !s)}>{show ? "Hide" : "Show"}</button>
        </div>
        {create && <div className={"field-hint" + (password && short ? " warn" : "")}>{password.length} of 10 characters{!short && <Icon name="check" size={16} />}</div>}
      </div>
      {problem && <Callout tone="bad" icon="error">{problem}</Callout>}
      <Foot>
        <button className="btn primary" disabled={busy || short || !password}>
          {busy && <span className="spinner small on-accent" />}{create ? "Create password" : "Sign in"}<Icon name="arrow_forward" size={18} />
        </button>
      </Foot>
    </form>
  );
}

// ---- 2. Cloudflare: one link to make the token, paste it, done ----

type Phase = "idle" | "checking" | "pick" | "connecting" | "connected";

function CloudflareStep({ auth, onBack, onDone }: { auth: Auth; onBack: () => void; onDone: () => Promise<void> }) {
  const [token, setToken] = useState("");
  const [phase, setPhase] = useState<Phase>(auth.setup.cloudflare ? "connected" : "idle");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [problem, setProblem] = useState("");
  const [settings, setSettings] = useState<Settings | null>(null);
  const finish = useRef(onDone);
  finish.current = onDone;

  const connect = async (account: Account, withToken: string | null) => {
    setPhase("connecting");
    setProblem("");
    try {
      await api.connect(withToken, account.id, TUNNEL_NAME);
      setSettings(await api.settings());
      setPhase("connected");
    } catch (e) {
      setProblem(message(e));
      setPhase("pick");
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
        setProblem("This token can't see any Cloudflare account. Make it again with the link above.");
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

  useEffect(() => {
    if (auth.setup.cloudflare) api.settings().then(setSettings).catch(() => {});
    else if (auth.setup.token) check(null);
    // Once, on arrival.
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
      <StepHead icon="cloud" title="Connect Cloudflare"
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
              <div className="input-wrap">
                <input className="input big mono" type="password" aria-label="Cloudflare API token" placeholder={auth.setup.token ? "Saved. Paste a new one to replace it." : "Paste the token"}
                  autoComplete="off" spellCheck={false} data-1p-ignore data-lpignore="true" value={token} onChange={(e) => setToken(e.target.value)} />
                {busy && <span className="spinner small input-spin" aria-label="Checking" />}
              </div>
              {phase === "checking" && <span className="field-hint">Checking the token</span>}
              {phase === "connecting" && <span className="field-hint">Creating the tunnel</span>}
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

      <Foot onBack={onBack} note={phase === "connected" ? <SaveMark state="saved" /> : null}>
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
      <StepHead icon="router" title="Your network" sub="The defaults suit most setups. Check them and carry on." />
      <div className="field">
        <label className="field-label" htmlFor="apps-host">Where your apps run</label>
        <input id="apps-host" className="input big mono" value={host ?? ""} placeholder={fallback} onChange={(e) => setHost(e.target.value)} spellCheck={false} />
        <span className="field-hint">The host each tunnel's port is on, as this container sees it. <code>host.docker.internal</code> is the computer running Docker.</span>
      </div>
      <div className="field">
        <span className="field-label">Home network</span>
        <div className="ip-line">
          {status?.public_ips.length ? status.public_ips.map((ip) => <span key={ip} className="port-chip">{ip}</span>) : <span className="muted">Looking up this network's public address</span>}
        </div>
        <span className="field-hint">Visitors arriving from these addresses count as on the same network as this host.</span>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="trusted">Also count as home <span className="muted">(optional)</span></label>
        <textarea id="trusted" className="input mono" rows={2} value={trusted} placeholder="One network per line, such as a VPN range" onChange={(e) => setTrusted(e.target.value)} spellCheck={false} />
      </div>
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
      <StepHead icon="check_circle" title="All set" sub="Everything below is saved. Pick a look and open the dashboard." />
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
