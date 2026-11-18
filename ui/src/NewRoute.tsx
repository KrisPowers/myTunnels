import { useContext, useEffect, useState, type FormEvent } from "react";
import { NeedsContext } from "./Apps";
import { useCloudflare, useCloudflareReady } from "./Cloudflare";
import { api, message, strength, type Access, type Forward, type OAuthProvider, type Route, type User, type Zone } from "./api";
import { Dropdown, type Option } from "./Dropdown";
import { Icon } from "./Icon";
import { AccessCard, type Reach } from "./Tunnels";
import { Card, Dialog, Row, Switch, TextField, useNotify } from "./ui";

// The ways a route is opened: a Cloudflare tunnel, which opens no port, then
// Tailscale and the router.
export type Method = "port" | "tailscale" | "tunnel";

const WAYS: Option<Method>[] = [
  { value: "tunnel", label: "Cloudflare Tunnel", logo: "cloudflare" },
  { value: "tailscale", label: "Tailscale", logo: "tailscale" },
  { value: "port", label: "Port forward", icon: "router" },
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
export function NewRoute({ users, providers, container, port: startPort, sub: startSub = "", onClose, onDone }: {
  users: User[];
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
  const connected = useCloudflareReady();
  const notify = useNotify();
  const missing = (way: Method) => !!needs && (way === "tunnel" ? !needs.cloudflared : way === "tailscale" ? !needs.tailscale : false);

  // A tunnel once Cloudflare is connected; until then, the way that needs nothing.
  const [way, setWay] = useState<Method>(connected ? "tunnel" : "port");
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
        <div className="tf static nr-way">
          <div className="tf-box">
            <Dropdown label="Route by" value={way} onChange={choose}
              options={WAYS.map((w) => ({ ...w, disabled: missing(w.value), hint: missing(w.value) ? `Install ${w.value === "tunnel" ? "cloudflared" : "Tailscale"} from Apps` : undefined }))} />
            <span className="tf-label">Route by</span>
          </div>
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

        {way === "tunnel" ? (
          <AccessCard value={access} users={users} providers={providers} onChange={set}
            hostname={sub && zones ? `${sub}.${zones.find((z) => z.id === zone)?.name ?? ""}` : undefined} />
        ) : (
          <Card title="Access Control">
            {way === "tailscale" ? (
              <Row title="Open to the internet" sub="Through Funnel. Off, only devices on your tailnet reach it.">
                <Switch label="Open to the internet" on={internet} onChange={setInternet} />
              </Row>
            ) : (
              <Row title="Who reaches it" sub="Devices on your network, and anyone on the internet once the router forwards it too." />
            )}
            {!funnelOk && <p className="empty-note card-pad">Funnel opens only ports 443, 8443 and 10000.</p>}
            <Row title="Close after" sub="Closes on its own, and stays in the list switched off.">
              <Dropdown label="Close after" value={closeIn} options={CLOSE_AFTER} onChange={setCloseIn} />
            </Row>
          </Card>
        )}

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
