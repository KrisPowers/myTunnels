import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, message, TOKEN_URL, type Account } from "./api";
import { Dropdown } from "./Dropdown";
import { Icon } from "./Icon";
import { Callout, Dialog, TextField } from "./ui";

const TUNNEL_NAME = "homelab";

// Whether Cloudflare is connected, and the way to ask for it: `ask` opens the
// connect dialog and runs `then` once it is connected.
const CloudflareContext = createContext<{ ready: boolean; ask: (then?: () => void) => void }>({ ready: true, ask: () => {} });

// useCloudflare is the check in front of anything that uses Cloudflare: true
// when it is connected; otherwise false, and the connect dialog opens. It
// opens again every time until Cloudflare is connected.
export function useCloudflare() {
  const { ready, ask } = useContext(CloudflareContext);
  return useCallback((then?: () => void) => {
    if (ready) return true;
    ask(then);
    return false;
  }, [ready, ask]);
}

export function useCloudflareReady() {
  return useContext(CloudflareContext).ready;
}

// CloudflareProvider holds the connect dialog for the whole dashboard.
// `ready` is false only once the server says Cloudflare is not connected.
export function CloudflareProvider({ ready, onConnected, children }: { ready: boolean; onConnected: () => Promise<void>; children: ReactNode }) {
  const [asking, setAsking] = useState<{ then?: () => void } | null>(null);
  const ask = useCallback((then?: () => void) => setAsking({ then }), []);
  return (
    <CloudflareContext.Provider value={{ ready, ask }}>
      {children}
      {asking && (
        <Dialog title="Connect Cloudflare" onClose={() => setAsking(null)}>
          <CloudflareSetup onDone={async () => {
            await onConnected();
            const then = asking.then;
            setAsking(null);
            then?.();
          }} />
        </Dialog>
      )}
    </CloudflareContext.Provider>
  );
}

type Phase = "idle" | "checking" | "pick" | "connecting" | "connected";

// CloudflareSetup connects Cloudflare: one link to make the token, paste it,
// done. myTunnels then creates the tunnel and its DNS records itself.
function CloudflareSetup({ onDone }: { onDone: () => Promise<void> }) {
  const [token, setToken] = useState("");
  const [saved, setSaved] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [connected, setConnected] = useState<Account | null>(null);
  const [problem, setProblem] = useState("");

  const connect = async (account: Account, withToken: string | null, many: boolean) => {
    setPhase("connecting");
    setProblem("");
    try {
      await api.connect(withToken, account.id, TUNNEL_NAME);
      setConnected(account);
      setPhase("connected");
      setTimeout(onDone, 1200);
    } catch (e) {
      setProblem(message(e));
      setPhase(many ? "pick" : "idle");
    }
  };

  // Checks a token, or the one saved earlier with null, and connects straight
  // away when it sees a single account.
  const check = async (withToken: string | null, quiet = false) => {
    setPhase("checking");
    setProblem("");
    try {
      const list = await api.accounts(withToken);
      setAccounts(list);
      if (withToken === null) setSaved(true);
      if (list.length === 0) {
        setProblem("Cloudflare accepted the token, but it reaches no account or domain. Make it again with the link above and keep All zones selected.");
        setPhase("idle");
      } else if (list.length === 1) {
        await connect(list[0], withToken, false);
      } else {
        setPhase("pick");
      }
    } catch (e) {
      if (!quiet) setProblem(message(e).replace(/^Cloudflare: /, "Cloudflare says: "));
      setPhase("idle");
    }
  };

  // A token kept from an earlier try is picked up again; with none, nothing is said.
  useEffect(() => {
    check(null, true);
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
      <Callout tone="ok" icon="check_circle">
        Connected to <b>{connected?.name}</b>. Tunnel <b>{TUNNEL_NAME}</b> is ready.
      </Callout>
    );
  }

  return (
    <>
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
              placeholder={saved ? "Saved. Paste a new one to replace it." : undefined}
              value={token} onChange={setToken}
              trailing={busy ? <span className="spinner small" aria-label="Checking" /> : undefined}
              hint={phase === "checking" ? "Checking the token" : phase === "connecting" ? "Creating the tunnel" : undefined} />
            {phase === "pick" && (
              <div className="pick">
                <span className="muted">This token sees more than one account. Pick the one with your domains.</span>
                <Dropdown label="Cloudflare account" value="" options={[{ value: "", label: "Pick an account" }, ...accounts.map((a) => ({ value: a.id, label: a.name }))]}
                  onChange={(id) => {
                    const account = accounts.find((a) => a.id === id);
                    if (account) connect(account, token.trim() || null, true);
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
