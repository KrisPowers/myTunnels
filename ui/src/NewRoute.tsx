import { useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { NeedsContext } from "./Apps";
import { useCloudflare, useCloudflareReady } from "./Cloudflare";
import { api, message, strength, type Access, type Forward, type OAuthProvider, type Route, type Zone } from "./api";
import { Dropdown, type Option } from "./Dropdown";
import { Icon, type IconName } from "./Icon";
import { ProviderLogo } from "./ProviderLogo";
import { IDLE_FOR, PasswordHint, SIGN_IN_FOR, type Reach } from "./Tunnels";
import { Dialog, TextField, useNotify } from "./ui";

// The ways a route is opened, the plain ones first: the router, Tailscale,
// then a Cloudflare tunnel.
export type Method = "port" | "tailscale" | "tunnel";

const WAYS: { value: Method; label: string; icon: IconName }[] = [
  { value: "port", label: "Port forward", icon: "router" },
  { value: "tailscale", label: "Tailscale", icon: "lan" },
  { value: "tunnel", label: "Tunnel", icon: "public" },
];

const CLOSE_AFTER: Option<number>[] = [
  { value: 0, label: "Never" },
  { value: 3_600, label: "1 hour" },
  { value: 86_400, label: "1 day" },
  { value: 7 * 86_400, label: "7 days" },
];

// The ports Funnel opens to the internet.
const FUNNEL_PORTS = [443, 8443, 10000];

const NO_ACCESS: Access = {
  require_lan: false, require_password: false, require_login: false, require_code: false, oauth: [],
  login_max: 7 * 86_400, login_idle: 0, policy_mode: "all",
};

const digits = (v: string) => v.replace(/\D/g, "").slice(0, 5);

// A container, as a route to it needs it.
export interface Target { name: string; reach: Reach[] }

// NewRoute is the dialog that opens a route: how, what it needs for that way,
// who reaches it, then the button.
export function NewRoute({ providers, container, port: startPort, sub: startSub = "", onClose, onDone }: {
  providers: OAuthProvider[];
  container?: Target;
  port?: string;
  sub?: string;
  onClose: () => void;
  // Given the new tunnel, or nothing for a router or Tailscale route.
  onDone: (tunnel: Route | null) => Promise<void>;
}) {
  const needs = useContext(NeedsContext);
  const cloudflare = useCloudflare();
  const ready = useCloudflareReady();
  const notify = useNotify();
  const missing = (way: Method) => !!needs && (way === "tunnel" ? !needs.cloudflared : way === "tailscale" ? !needs.tailscale : false);

  const [way, setWay] = useState<Method>("port");
  const [name, setName] = useState(container?.name ?? "");
  const [outside, setOutside] = useState("");
  const [port, setPort] = useState(/^\d{1,5}$/.test(startPort ?? "") ? startPort! : "");
  const [pick, setPick] = useState(0);
  const [protocol, setProtocol] = useState<Forward["protocol"]>("tcp");
  const [webPort, setWebPort] = useState(443);
  const [internet, setInternet] = useState(false);
  const [closeIn, setCloseIn] = useState(0);
  const [zones, setZones] = useState<Zone[] | null>(null);
  const [zone, setZone] = useState("");
  const [sub, setSub] = useState(startSub.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 63));
  const [access, setAccess] = useState<Access>(NO_ACCESS);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (way !== "tunnel" || zones) return;
    api.zones().then((z) => {
      setZones(z);
      setZone((current) => current || z[0]?.id || "");
    }).catch((e) => notify(message(e), "bad"));
  }, [way, zones, notify]);

  const choose = (w: Method) => {
    if (w === "tunnel" && !cloudflare(() => setWay("tunnel"))) return;
    setWay(w);
    setProtocol(w === "port" ? "tcp" : "http");
  };

  // A tunnel reaches a container by any port it has; the router and
  // Tailscale only by one it publishes on this computer.
  const reach = (container?.reach ?? []).filter((r) => way === "tunnel" || r.host === null);
  const fixed = container ? reach[Math.min(pick, reach.length - 1)] : undefined;
  const appPort = fixed ? fixed.port : Number(port);
  const web = way === "tailscale" && protocol !== "tcp";
  const publicPort = web ? webPort : Number(outside || appPort);
  const funnelOk = way !== "tailscale" || !internet || web || FUNNEL_PORTS.includes(publicPort);
  const passwordOk = !access.require_password || strength(access.password ?? "").ok;
  const ok = way === "tunnel"
    ? !!sub && !!zone && appPort > 0 && passwordOk
    : appPort > 0 && publicPort > 0 && publicPort < 65536 && funnelOk;
  const set = (patch: Partial<Access>) => setAccess((a) => ({ ...a, ...patch }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok || busy) return;
    setBusy(true);
    try {
      if (way === "tunnel") {
        const route = await api.publish({
          subdomain: sub, zone_id: zone, port: appPort, target_scheme: "http", preserve_host: false, verify_tls: false,
          target_host: container ? (fixed ? fixed.host : container.name) : null, ...access,
        });
        notify(`Published ${route.hostname}`);
        await onDone(route);
      } else {
        const f = await api.addForward({
          method: way, name: name.trim(), target_host: null, target_port: appPort, protocol,
          public_port: publicPort, public: way === "tailscale" && internet, expires_in: closeIn,
        });
        notify(`Opened port ${f.public_port}`);
        await onDone(null);
      }
    } catch (err) {
      notify(message(err), "bad");
      setBusy(false);
    }
  };

  const appField = container ? (
    reach.length > 1 ? (
      <Picker label="App port" value={pick} options={reach.map((r, i) => ({ value: i, label: r.label }))} onChange={setPick} />
    ) : fixed ? <span className="nr-fixed mono">{fixed.label}</span> : null
  ) : (
    <TextField className="nr-port" label="App port" placeholder="8080" mono inputMode="numeric" value={port} onChange={(v) => setPort(digits(v))} />
  );

  return (
    <Dialog title="New route" wide onClose={onClose}>
      <form className="nr" onSubmit={submit}>
        <div className="nr-ways" role="radiogroup" aria-label="Route by">
          {WAYS.map((w) => (
            <button key={w.value} type="button" role="radio" aria-checked={way === w.value} className={"nr-way" + (way === w.value ? " on" : "")}
              disabled={missing(w.value)} title={missing(w.value) ? `Install ${w.value === "tunnel" ? "cloudflared" : "Tailscale"} from Apps` : undefined}
              onClick={() => choose(w.value)}>
              <Icon name={w.icon} size={26} />
              <b>{w.label}</b>
              {w.value === "tunnel" && !ready && <small>Cloudflare</small>}
            </button>
          ))}
        </div>

        <div className="nr-fields">
          {way === "tunnel" ? (
            <>
              <div className="nr-address">
                <TextField className="nr-sub" label="Subdomain" placeholder="app" autoComplete="off" value={sub}
                  onChange={(v) => setSub(v.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 63))} />
                <div className="tf static nr-zone">
                  <div className="tf-box">
                    {zones && zones.length > 0
                      ? <Dropdown label="Domain" value={zone} options={zones.map((z) => ({ value: z.id, label: "." + z.name }))} onChange={setZone} />
                      : <span className="dropdown placeholder">{zones ? "No domains" : "Loading"}</span>}
                    <span className="tf-label">Domain</span>
                  </div>
                </div>
              </div>
              <span className="nr-to"><Icon name="arrow_forward" size={18} /></span>
              {appField}
            </>
          ) : (
            <>
              <TextField className="nr-name" label="Name" placeholder="Minecraft" autoComplete="off" value={name} onChange={(v) => setName(v.slice(0, 100))} />
              {web ? (
                <Picker label="Port" value={webPort} options={FUNNEL_PORTS.map((p) => ({ value: p, label: String(p) }))} onChange={setWebPort} />
              ) : (
                <TextField className="nr-port" label="Port" placeholder={appPort ? String(appPort) : "25565"} mono inputMode="numeric"
                  value={outside} onChange={(v) => setOutside(digits(v))} />
              )}
              <span className="nr-to"><Icon name="arrow_forward" size={18} /></span>
              {appField}
              <Picker label="Protocol" value={protocol} onChange={setProtocol} options={way === "port"
                ? [{ value: "tcp", label: "TCP" }, { value: "udp", label: "UDP" }, { value: "both", label: "TCP & UDP" }]
                : [{ value: "http", label: "http" }, { value: "https", label: "https" }, { value: "tcp", label: "TCP" }]} />
            </>
          )}
        </div>
        {container && reach.length === 0 && <p className="empty-note">This container publishes no port on this computer.</p>}

        <div className="nr-access">
          <span className="nr-label">Access</span>
          {way === "tunnel" ? (
            <>
              <div className="nr-toggles">
                <Toggle icon="lan" label="Same network" on={access.require_lan} onChange={(v) => set({ require_lan: v })} />
                <Toggle icon="password" label="Password" on={access.require_password} onChange={(v) => set({ require_password: v })} />
                <Toggle icon="person" label="Sign-in" on={access.require_login} onChange={(v) => set({ require_login: v })} />
              </div>
              {access.require_password && (
                <TextField label="Tunnel password" type="password" autoComplete="new-password" value={access.password ?? ""} onChange={(password) => set({ password })}
                  hint={<PasswordHint value={access.password ?? ""} empty="Asked for before anything behind it loads." />} />
              )}
              {access.require_login && (
                <div className="nr-signin">
                  {providers.length > 0 && (
                    <div className="nr-toggles">
                      {providers.map((p) => (
                        <Toggle key={p.id} logo={p.id} label={p.label} on={access.oauth.includes(p.id)}
                          onChange={(v) => set({ oauth: v ? [...access.oauth, p.id] : access.oauth.filter((x) => x !== p.id) })} />
                      ))}
                    </div>
                  )}
                  <div className="nr-row">
                    <Picker wide label="Sign in again after" value={access.login_max} options={SIGN_IN_FOR} onChange={(v) => set({ login_max: v })} />
                    <Picker wide label="Sign out when idle" value={access.login_idle} options={IDLE_FOR} onChange={(v) => set({ login_idle: v })} />
                  </div>
                </div>
              )}
              {[access.require_lan, access.require_password, access.require_login].filter(Boolean).length > 1 && (
                <div className="seg-tabs nr-seg">
                  <button type="button" className={access.policy_mode === "all" ? "on" : undefined} onClick={() => set({ policy_mode: "all" })}>Require all</button>
                  <button type="button" className={access.policy_mode === "any" ? "on" : undefined} onClick={() => set({ policy_mode: "any" })}>Any one</button>
                </div>
              )}
            </>
          ) : (
            <div className="nr-row">
              {way === "tailscale" ? (
                <div className="seg-tabs nr-seg">
                  <button type="button" className={internet ? undefined : "on"} onClick={() => setInternet(false)}><Icon name="lan" size={18} />Tailnet</button>
                  <button type="button" className={internet ? "on" : undefined} onClick={() => setInternet(true)}><Icon name="public" size={18} />Internet</button>
                </div>
              ) : (
                <span className="nr-reach"><Icon name="public" size={18} />Anyone who reaches the port</span>
              )}
              <Picker wide label="Close after" value={closeIn} options={CLOSE_AFTER} onChange={setCloseIn} />
            </div>
          )}
          {!funnelOk && <p className="empty-note">Funnel opens only ports 443, 8443 and 10000.</p>}
        </div>

        <div className="nr-foot">
          <button type="button" className="btn text" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !ok}>
            {busy && <span className="spinner small on-accent" />}{way === "tunnel" ? "Publish" : "Open"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// Picker is a dropdown in a field with its label on the outline.
function Picker<T extends string | number>({ label, value, options, onChange, wide }: {
  label: string;
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  wide?: boolean;
}) {
  return (
    <div className={"tf static " + (wide ? "nr-pick" : "nr-port")}>
      <div className="tf-box">
        <Dropdown label={label} value={value} options={options} onChange={onChange} />
        <span className="tf-label">{label}</span>
      </div>
    </div>
  );
}

// Toggle is a pill that is on or off, with an icon or a provider's logo.
function Toggle({ label, on, onChange, icon, logo }: { label: string; on: boolean; onChange: (on: boolean) => void; icon?: IconName; logo?: string }): ReactNode {
  return (
    <button type="button" className={"nr-toggle" + (on ? " on" : "")} aria-pressed={on} onClick={() => onChange(!on)}>
      {logo ? <ProviderLogo id={logo} size={18} /> : icon && <Icon name={icon} size={18} />}
      {label}
      {on && <Icon name="check" size={16} />}
    </button>
  );
}
