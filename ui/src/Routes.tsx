import { useState } from "react";
import { api, message, type Forward, type OAuthProvider, type Route, type User } from "./api";
import { Icon, type IconName } from "./Icon";
import { useCan } from "./me";
import { NewRoute } from "./NewRoute";
import { go } from "./route";
import { MoreMenu, useNotify, type MenuAction } from "./ui";

// Routes are this computer's ports exposed: a row each, the port first, then
// how it is exposed and where it is reached, whether it takes writes, who
// gets in, and whether it is up. A tunnel's row opens its page, where its
// sign-in, API keys, rate limit and activity are.

interface Item {
  key: string;
  port: number;
  name: string;
  way: string;
  icon: IconName;
  at: string;
  href?: string;
  traffic: string;
  who: string[];
  state: [string, string];
  up: boolean;
  open?: string;
  menu: MenuAction[];
}

// Who a tunnel lets in, in a word or two each.
function whoOf(r: Route): string[] {
  const who = [
    r.require_login && "Sign-in",
    r.require_password && "Password",
    r.require_key && "API key",
    r.require_lan && "Home network",
  ].filter(Boolean) as string[];
  if (!who.length) return ["Anyone"];
  return r.policy_mode === "any" && who.length > 1 ? [who.join(" or ")] : who;
}

export function RoutesPage({ adding, port, routes, forwards, users, providers, onChanged }: {
  adding: boolean;
  port: string;
  routes: Route[] | null;
  forwards: Forward[] | null;
  users: User[];
  providers: OAuthProvider[];
  onChanged: () => Promise<void>;
}) {
  const can = useCan();
  const notify = useNotify();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState("");
  const act = async (key: string, work: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try {
      await work();
      notify(done);
    } catch (e) {
      notify(message(e), "bad");
    }
    setBusy("");
    await onChanged();
  };

  const items: Item[] = [
    ...(routes ?? []).map((r): Item => ({
      key: "r" + r.id, port: r.target_port, name: r.target_scheme === "dashboard" ? "This dashboard" : r.target_host ? `on ${r.target_host}` : "", way: "Cloudflare Tunnel", icon: "public",
      at: r.hostname, href: `https://${r.hostname}`, traffic: r.read_only ? "Read only" : "Read & write", who: whoOf(r),
      state: r.enabled ? ["Live", "ok"] : ["Off", ""], up: r.enabled, open: `#/tunnels/${r.id}`,
      menu: [
        { label: "Open", icon: "open_in_new", onClick: () => window.open(`https://${r.hostname}`, "_blank", "noreferrer") },
        ...(can("tunnels.delete") ? [{ label: "Remove", icon: "delete" as IconName, danger: true, confirm: "Remove for good", onClick: () => act("r" + r.id, () => api.removeRoute(r.id), `Removed ${r.hostname}`) }] : []),
      ],
    })),
    ...(forwards ?? []).map((f): Item => {
      const tailscale = f.method === "tailscale";
      return {
        key: "f" + f.id, port: f.target_port, name: f.name, way: tailscale ? "Tailscale" : `Port forward, ${f.protocol === "both" ? "TCP & UDP" : f.protocol.toUpperCase()}`,
        icon: tailscale ? "lan" : "router", at: f.address ?? `port ${f.public_port}`, href: f.address?.startsWith("https://") ? f.address : undefined,
        traffic: "Read & write", who: [tailscale ? (f.public ? "Anyone, by Funnel" : "Your tailnet") : f.router ? "Anyone" : "Your network"],
        state: !f.enabled ? ["Closed", ""] : f.problem ? ["Failed", "bad"] : ["Open", "ok"], up: f.enabled && !f.problem,
        menu: [
          ...(can("tunnels.edit") ? [f.enabled
            ? { label: "Close", icon: "block" as IconName, onClick: () => act("f" + f.id, () => api.editForward(f.id, { enabled: false }), `Closed port ${f.public_port}`) }
            : { label: "Open again", icon: "play_arrow" as IconName, onClick: () => act("f" + f.id, () => api.editForward(f.id, { enabled: true }), `Opened port ${f.public_port}`) }] : []),
          ...(can("tunnels.delete") ? [{ label: "Remove", icon: "delete" as IconName, danger: true, confirm: "Remove for good", onClick: () => act("f" + f.id, () => api.removeForward(f.id), `Removed port ${f.public_port}`) }] : []),
        ],
      };
    }),
  ].sort((a, b) => a.port - b.port || a.at.localeCompare(b.at));

  const needle = q.trim().toLowerCase();
  const shown = needle ? items.filter((i) => [String(i.port), i.name, i.at, i.way].some((v) => v.toLowerCase().includes(needle))) : items;

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Routes</h1>
          {routes && <div className="page-sub"><span><b>{items.filter((i) => i.up).length}</b> of {items.length} exposed</span></div>}
        </div>
        <div className="page-actions">
          {items.length > 0 && (
            <label className="ct-search">
              <Icon name="search" size={18} />
              <input type="search" placeholder="Search" aria-label="Search routes" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
            </label>
          )}
          {can("tunnels.create") && <button type="button" className="btn primary" onClick={() => go("#/routes/new")}><Icon name="add" size={18} />Expose a port</button>}
        </div>
      </div>

      <div className="page-body stack">
        {!routes ? <div className="repo-loading"><span className="spinner" /></div> : items.length === 0 ? (
          <div className="welcome"><Icon name="wifi_cog" size={48} /></div>
        ) : (
          <div className="card svc-card">
            <div className="table-wrap">
              <table className="table svc">
                <thead><tr><th>Port</th><th className="grow">Reached at</th><th>Traffic</th><th>Who gets in</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {shown.map((i) => (
                    <tr key={i.key} className={(i.open ? "svc-link" : "") + (i.up ? "" : " svc-down")} onClick={() => i.open && go(i.open)}>
                      <td><span className="rt-port mono">{i.port}</span></td>
                      <td>
                        <span className="svc-name">
                          <span className={"svc-icon " + i.state[1]}><Icon name={i.icon} size={18} /></span>
                          <span className="svc-text">
                            <b>{i.href ? <a href={i.href} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{i.at}</a> : i.at}</b>
                            <small className="plain">{[i.way, i.name].filter(Boolean).join(" · ")}</small>
                          </span>
                        </span>
                      </td>
                      <td><span className={"chip " + (i.traffic === "Read only" ? "plain" : "")}>{i.traffic}</span></td>
                      <td><span className="access">{i.who.map((w) => <span key={w} className="chip">{w}</span>)}</span></td>
                      <td><span className={"chip " + i.state[1]}><span className={"dot " + i.state[1]} />{i.state[0]}</span></td>
                      <td className="svc-menu" onClick={(e) => e.stopPropagation()}>
                        {busy === i.key ? <span className="spinner small" /> : i.menu.length > 0 && <MoreMenu label={`Actions for port ${i.port}`} actions={i.menu} />}
                      </td>
                    </tr>
                  ))}
                  {shown.length === 0 && <tr><td colSpan={6} className="svc-none">Nothing matches.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {adding && can("tunnels.create") && (
        <NewRoute users={users} providers={providers} port={port} onClose={() => go("#/routes")} onDone={async (r) => {
          await onChanged();
          go(r ? `#/tunnels/${r.id}` : "#/routes");
        }} />
      )}
    </>
  );
}
