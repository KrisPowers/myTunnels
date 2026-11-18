import { useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { NeedsContext } from "./Apps";
import { useCloudflare } from "./Cloudflare";
import { api, message, strength, type Access, type Forward, type OAuthProvider, type Route, type User, type Zone } from "./api";
import { Dropdown, type Option } from "./Dropdown";
import { RATES } from "./Keys";
import { AccessCard } from "./Tunnels";
import { Card, Dialog, Row, Switch, TextField, useNotify } from "./ui";

// NewRoute exposes a port on this computer, in the order it is decided: the
// port, whether it takes writes or reads only, how it is exposed (the router,
// Tailscale or a Cloudflare tunnel), then who gets in. Credentials, read-only
// and rate limits are checked by myTunnels' gateway, which a Cloudflare tunnel
// passes through; the router and Tailscale reach the port directly.

export type Method = "port" | "tailscale" | "tunnel";

const WAYS: [Method, string][] = [["port", "Port forward"], ["tailscale", "Tailscale"], ["tunnel", "Cloudflare Tunnel"]];
const PROTOCOLS: [Forward["protocol"], string][] = [["tcp", "TCP"], ["udp", "UDP"], ["both", "TCP & UDP"]];
const WEB: [Forward["protocol"], string][] = [["http", "http"], ["https", "https"], ["tcp", "TCP"]];
const FUNNEL_PORTS = [443, 8443, 10000];
const CLOSE_AFTER: Option<number>[] = [
  { value: 0, label: "Never" },
  { value: 3_600, label: "1 hour" },
  { value: 86_400, label: "1 day" },
  { value: 7 * 86_400, label: "7 days" },
];
const NO_ACCESS: Access = {
  require_lan: false, require_password: false, require_login: false, require_code: false, oauth: [],
  login_max: 7 * 86_400, login_idle: 0, policy_mode: "all",
};
const digits = (v: string) => v.replace(/\D/g, "").slice(0, 5);

// Seg is a choice of a few, as segmented tabs.
function Seg<T extends string>({ label, value, options, onChange, disabled }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void; disabled?: (v: T) => boolean }) {
  return (
    <div className="seg-tabs nr2-seg" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} className={value === v ? "on" : undefined}
          disabled={disabled?.(v)} onClick={() => onChange(v)}>{text}</button>
      ))}
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="nr2-step">
      <div className="nr2-step-head"><span className="how-num">{n}</span><h3>{title}</h3></div>
      <div className="nr2-step-body">{children}</div>
    </section>
  );
}

export function NewRoute({ users, providers, port: startPort, onClose, onDone }: {
  users: User[];
  providers: OAuthProvider[];
  port?: string;
  onClose: () => void;
  // Given the new tunnel, or nothing for a router or Tailscale route.
  onDone: (tunnel: Route | null) => Promise<void>;
}) {
  const needs = useContext(NeedsContext);
  const cloudflare = useCloudflare();
  const notify = useNotify();
  const [port, setPort] = useState(/^\d{1,5}$/.test(startPort ?? "") ? startPort! : "");
  const [readOnly, setReadOnly] = useState(false);
  const [way, setWay] = useState<Method>("port");
  const [protocol, setProtocol] = useState<Forward["protocol"]>("tcp");
  const [outside, setOutside] = useState("");
  const [name, setName] = useState("");
  const [closeIn, setCloseIn] = useState(0);
  const [internet, setInternet] = useState(false);
  const [webPort, setWebPort] = useState(443);
  const [zones, setZones] = useState<Zone[] | null>(null);
  const [zone, setZone] = useState("");
  const [sub, setSub] = useState("");
  const [access, setAccess] = useState<Access>(NO_ACCESS);
  const [key, setKey] = useState(false);
  const [rate, setRate] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (way !== "tunnel" || zones) return;
    api.zones().then((z) => {
      setZones(z);
      setZone((current) => current || z[0]?.id || "");
    }).catch((e) => notify(message(e), "bad"));
  }, [way, zones, notify]);

  const pick = (w: Method) => {
    if (w === "tunnel" && !cloudflare(() => setWay("tunnel"))) return;
    setWay(w);
    setProtocol(w === "port" ? "tcp" : "http");
  };
  const tunnel = way === "tunnel";
  const appPort = Number(port);
  const web = way === "tailscale" && protocol !== "tcp";
  const publicPort = web ? webPort : Number(outside || appPort);
  const funnelOk = way !== "tailscale" || !internet || web || FUNNEL_PORTS.includes(publicPort);
  const passwordOk = !access.require_password || strength(access.password ?? "").ok;
  const ok = appPort > 0 && appPort < 65536 && (tunnel ? !!sub && !!zone && passwordOk : publicPort > 0 && publicPort < 65536 && funnelOk);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok || busy) return;
    setBusy(true);
    try {
      if (tunnel) {
        const route = await api.publish({
          subdomain: sub, zone_id: zone, port: appPort, target_scheme: "http", preserve_host: false, verify_tls: false, target_host: null,
          read_only: readOnly, require_key: key, rate_limit: rate, ...access,
        });
        notify(`Exposed port ${appPort} at ${route.hostname}`);
        await onDone(route);
      } else {
        const f = await api.addForward({
          method: way, name: name.trim(), target_host: null, target_port: appPort, protocol,
          public_port: publicPort, public: way === "tailscale" && internet, expires_in: closeIn,
        });
        notify(`Exposed port ${appPort} on ${f.public_port}`);
        await onDone(null);
      }
    } catch (err) {
      notify(message(err), "bad");
      setBusy(false);
    }
  };

  return (
    <Dialog title="Expose a port" wide onClose={onClose}>
      <form className="nr2" onSubmit={submit}>
        <Step n={1} title="Port">
          <TextField label="Port on this computer" autoFocus mono inputMode="numeric" placeholder="8080" value={port} onChange={(v) => setPort(digits(v))} />
        </Step>

        <Step n={2} title="Traffic">
          <Seg label="Traffic" value={readOnly ? "read" : "write"} options={[["write", "Read & write"], ["read", "Read only"]]}
            onChange={(v) => setReadOnly(v === "read")} disabled={(v) => v === "read" && !tunnel} />
          {!tunnel && <p className="nr2-note">Read only is checked by the gateway, which only a Cloudflare tunnel passes through.</p>}
        </Step>

        <Step n={3} title="Exposed by">
          <Seg label="Exposed by" value={way} options={WAYS} onChange={pick}
            disabled={(v) => !!needs && v === "tailscale" && !needs.tailscale} />
          {way === "port" && (
            <div className="nr2-fields">
              <Seg label="Protocol" value={protocol} options={PROTOCOLS} onChange={setProtocol} />
              <TextField label="Router port" mono inputMode="numeric" placeholder={port || "Same as the app"} value={outside} onChange={(v) => setOutside(digits(v))} />
              <TextField label="Name" autoComplete="off" placeholder="Minecraft" value={name} onChange={(v) => setName(v.slice(0, 100))} />
            </div>
          )}
          {way === "tailscale" && (
            <div className="nr2-fields">
              <Seg label="Protocol" value={protocol} options={WEB} onChange={setProtocol} />
              {web
                ? <div className="tf static"><div className="tf-box"><Dropdown label="Port" value={webPort} options={FUNNEL_PORTS.map((p) => ({ value: p, label: String(p) }))} onChange={setWebPort} /><span className="tf-label">Tailnet port</span></div></div>
                : <TextField label="Tailnet port" mono inputMode="numeric" placeholder={port || "Same as the app"} value={outside} onChange={(v) => setOutside(digits(v))} />}
              <TextField label="Name" autoComplete="off" value={name} onChange={(v) => setName(v.slice(0, 100))} />
              <Row title="Open to the internet" sub="Through Funnel. Off, only your tailnet reaches it."><Switch label="Open to the internet" on={internet} onChange={setInternet} /></Row>
              {!funnelOk && <p className="nr2-note">Funnel opens only ports 443, 8443 and 10000.</p>}
            </div>
          )}
          {tunnel && (
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
          )}
          {!tunnel && (
            <div className="tf static nr2-close"><div className="tf-box"><Dropdown label="Close after" value={closeIn} options={CLOSE_AFTER} onChange={setCloseIn} /><span className="tf-label">Close after</span></div></div>
          )}
        </Step>

        <Step n={4} title="Who gets in">
          {tunnel ? (
            <>
              <AccessCard value={access} users={users} providers={providers} onChange={(patch) => setAccess((a) => ({ ...a, ...patch }))}
                hostname={sub && zones ? `${sub}.${zones.find((z) => z.id === zone)?.name ?? ""}` : undefined} />
              <Card title="API clients">
                <Row title="API key" sub="Clients send one as Authorization: Bearer, X-API-Key, or api_key in the body. Make keys on the route's page.">
                  <Switch label="Require an API key" on={key} onChange={setKey} />
                </Row>
                <Row title="Rate limit" sub="Requests each visitor may make">
                  <Dropdown label="Rate limit" value={rate} options={RATES} onChange={setRate} />
                </Row>
              </Card>
            </>
          ) : (
            <p className="nr2-note">{way === "port"
              ? "Anyone who reaches the port gets in: on your network, and on the internet once the router forwards it. Sign-in pages, API keys and rate limits need a Cloudflare tunnel."
              : "Your tailnet's devices, or anyone with Funnel on. Sign-in pages, API keys and rate limits need a Cloudflare tunnel."}</p>
          )}
        </Step>

        <div className="nr-foot">
          <button type="button" className="btn text" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !ok}>{busy && <span className="spinner small on-accent" />}Expose port</button>
        </div>
      </form>
    </Dialog>
  );
}
