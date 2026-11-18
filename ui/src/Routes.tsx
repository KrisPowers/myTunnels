import { useState, type ReactNode } from "react";
import { api, message, type Forward, type OAuthProvider, type Route, type User } from "./api";
import { Icon, type IconName } from "./Icon";
import { useCan } from "./me";
import { NewRoute } from "./NewRoute";
import { go } from "./route";
import { AccessChips, target } from "./Tunnels";
import { MoreMenu, useNotify, type MenuAction } from "./ui";

// Routes are every way in, one table: Cloudflare tunnels at an address on
// your domains, ports the router forwards here, and Tailscale. Each row says
// where it is reached, where it goes, who gets in and whether it is up. Add
// route opens New route; `#/routes/new/<port>` opens it on that port.

interface Item {
  key: string;
  address: string;
  href?: string;
  to: string;
  way: string;
  icon: IconName;
  up: boolean;
  state: [string, string];
  access: ReactNode;
  open?: string;
  menu: MenuAction[];
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
      key: "r" + r.id, address: r.hostname, href: `https://${r.hostname}`, to: target(r), way: "Cloudflare Tunnel", icon: "public",
      up: r.enabled, state: r.enabled ? ["Live", "ok"] : ["Off", ""], access: <AccessChips route={r} />, open: `#/tunnels/${r.id}`,
      menu: [
        { label: "Open", icon: "open_in_new", onClick: () => window.open(`https://${r.hostname}`, "_blank", "noreferrer") },
        ...(can("tunnels.delete") ? [{ label: "Remove", icon: "delete" as IconName, danger: true, confirm: "Remove for good", onClick: () => act("r" + r.id, () => api.removeRoute(r.id), `Removed ${r.hostname}`) }] : []),
      ],
    })),
    ...(forwards ?? []).map((f): Item => {
      const tailscale = f.method === "tailscale";
      const up = f.enabled && !f.problem;
      return {
        key: "f" + f.id, address: f.address ?? `Port ${f.public_port}`, href: f.address?.startsWith("https://") ? f.address : undefined,
        to: `${f.name ? `${f.name}, ` : ""}${f.target_host ? `${f.target_host}:` : "port "}${f.target_port}`,
        way: tailscale ? "Tailscale" : "Port forward", icon: tailscale ? "lan" : "router", up,
        state: !f.enabled ? ["Closed", ""] : f.problem ? ["Failed", "bad"] : ["Open", "ok"],
        access: <span className="chip">{tailscale ? (f.public ? "Internet" : "Tailnet") : f.router ? "Internet" : "This network"}</span>,
        menu: [
          ...(can("tunnels.edit") ? [f.enabled
            ? { label: "Close", icon: "block" as IconName, onClick: () => act("f" + f.id, () => api.editForward(f.id, { enabled: false }), `Closed port ${f.public_port}`) }
            : { label: "Open again", icon: "play_arrow" as IconName, onClick: () => act("f" + f.id, () => api.editForward(f.id, { enabled: true }), `Opened port ${f.public_port}`) }] : []),
          ...(can("tunnels.delete") ? [{ label: "Remove", icon: "delete" as IconName, danger: true, confirm: "Remove for good", onClick: () => act("f" + f.id, () => api.removeForward(f.id), `Removed port ${f.public_port}`) }] : []),
        ],
      };
    }),
  ].sort((a, b) => a.address.localeCompare(b.address));

  const needle = q.trim().toLowerCase();
  const shown = needle ? items.filter((i) => [i.address, i.to, i.way].some((v) => v.toLowerCase().includes(needle))) : items;
  const up = items.filter((i) => i.up).length;

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Routes</h1>
          {routes && <div className="page-sub"><span><b>{up}</b> of {items.length} up</span></div>}
        </div>
        <div className="page-actions">
          {items.length > 0 && (
            <label className="ct-search">
              <Icon name="search" size={18} />
              <input type="search" placeholder="Search" aria-label="Search routes" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
            </label>
          )}
          {can("tunnels.create") && <button type="button" className="btn primary" onClick={() => go("#/routes/new")}><Icon name="add" size={18} />Add route</button>}
        </div>
      </div>

      <div className="page-body stack">
        {!routes ? <div className="repo-loading"><span className="spinner" /></div> : items.length === 0 ? (
          <div className="welcome"><Icon name="wifi_cog" size={48} /></div>
        ) : (
          <div className="card svc-card">
            <div className="table-wrap">
              <table className="table svc">
                <thead><tr><th className="grow">Address</th><th>Way</th><th>Who gets in</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {shown.map((i) => (
                    <tr key={i.key} className={(i.open ? "svc-link" : "") + (i.up ? "" : " svc-down")} onClick={() => i.open && go(i.open)}>
                      <td>
                        <span className="svc-name">
                          <span className={"svc-icon " + i.state[1]}><Icon name={i.icon} size={18} /></span>
                          <span className="svc-text">
                            <b>{i.href ? <a href={i.href} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{i.address}</a> : i.address}</b>
                            <small>to {i.to}</small>
                          </span>
                        </span>
                      </td>
                      <td><span className="svc-way">{i.way}</span></td>
                      <td><span className="access">{i.access}</span></td>
                      <td><span className={"chip " + i.state[1]}><span className={"dot " + i.state[1]} />{i.state[0]}</span></td>
                      <td className="svc-menu" onClick={(e) => e.stopPropagation()}>
                        {busy === i.key ? <span className="spinner small" /> : i.menu.length > 0 && <MoreMenu label={`Actions for ${i.address}`} actions={i.menu} />}
                      </td>
                    </tr>
                  ))}
                  {shown.length === 0 && <tr><td colSpan={5} className="svc-none">Nothing matches.</td></tr>}
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
