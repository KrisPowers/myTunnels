import { useCallback, useEffect, useRef, useState, type KeyboardEvent as KeyEvent } from "react";
import { api, message, type Auth, type Device, type Route, type Status } from "./api";
import { DevicePage, Devices } from "./Devices";
import { Icon, type IconName } from "./Icon";
import { go, readHash } from "./route";
import { SETTINGS, Settings } from "./Settings";
import { Setup } from "./Setup";
import { TunnelPage, Tunnels } from "./Tunnels";
import { Callout, Notices } from "./ui";

export function App() {
  return (
    <Notices>
      <Root />
    </Notices>
  );
}

// Root shows setup until every step is done, and the sign-in page whenever
// the session has ended; otherwise the dashboard.
function Root() {
  const [auth, setAuth] = useState<Auth | null>(null);
  const [problem, setProblem] = useState("");

  const load = useCallback(async () => {
    try {
      setAuth(await api.auth());
      setProblem("");
    } catch (e) {
      setProblem(message(e));
    }
  }, []);

  useEffect(() => {
    load();
    addEventListener("signed-out", load);
    return () => removeEventListener("signed-out", load);
  }, [load]);

  if (!auth) return problem ? <div className="page"><Callout tone="bad" icon="error">Can't reach myTunnels: {problem}</Callout></div> : null;
  if (!auth.authenticated || !auth.setup.done) return <Setup auth={auth} onChange={load} />;
  return <Dashboard onSignOut={async () => {
    await api.logout().catch(() => {});
    await load();
  }} />;
}

// Dashboard is the frame every page sits in: a header with the search bar,
// the connector's health and settings, a sidebar of pages, and the page.
function Dashboard({ onSignOut }: { onSignOut: () => void }) {
  const [place, setPlace] = useState(readHash);
  const [routes, setRoutes] = useState<Route[] | null>(null);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [drawer, setDrawer] = useState(false);

  const load = useCallback(async () => {
    const [r, d, s] = await Promise.allSettled([api.routes(), api.devices(), api.status()]);
    if (r.status === "fulfilled") setRoutes(r.value);
    if (d.status === "fulfilled") setDevices(d.value);
    if (s.status === "fulfilled") setStatus(s.value);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    const onHash = () => {
      setPlace(readHash());
      setDrawer(false);
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  const { view, id } = place;
  const pending = devices?.filter((d) => d.status === "pending").length ?? 0;
  const route = view === "tunnels" && id ? routes?.find((r) => r.id === id) : undefined;
  const device = view === "devices" && id ? devices?.find((d) => d.id === id) : undefined;

  // A tunnel or device that is gone goes back to its list.
  useEffect(() => {
    if (view === "tunnels" && id && routes && !route) go("#/");
    if (view === "devices" && id && devices && !device) go("#/devices");
  }, [view, id, routes, devices, route, device]);

  return (
    <div className="app">
      <header className="header">
        <div className="header-start">
          <button type="button" className="icon-btn menu-btn" aria-label="Menu" aria-expanded={drawer} onClick={() => setDrawer((d) => !d)}>
            <Icon name="menu" />
          </button>
          <a className="brand" href="#/"><span className="brand-mark"><Icon name="public" size={18} /></span><span className="brand-name">myTunnels</span></a>
        </div>
        <Search routes={routes} devices={devices} />
        <div className="header-actions">
          <a className={"icon-btn" + (view === "settings" ? " on" : "")} href="#/settings" aria-label="Settings" title="Settings"><Icon name="settings" /></a>
          <button type="button" className="icon-btn" aria-label="Sign out" title="Sign out" onClick={onSignOut}><Icon name="logout" /></button>
        </div>
      </header>

      <div className="shell">
        <nav className={"sidebar" + (drawer ? " open" : "")} aria-label="Pages">
          {view === "settings" ? (
            <>
              <a className="nav-back" href="#/"><Icon name="arrow_back" /><span>Dashboard</span></a>
              <hr className="nav-rule" />
              {SETTINGS.map(([key, label, icon], i) => (
                <NavItem key={key} to={`#/settings/${key}`} icon={icon} label={label} on={id === key || (!id && i === 0)} quiet />
              ))}
            </>
          ) : (
            <>
              <NavItem to="#/" icon="public" label="Tunnels" on={view === "tunnels"} />
              <NavItem to="#/devices" icon="devices" label="Devices" on={view === "devices"} count={pending || undefined} alert={pending > 0} />
            </>
          )}
        </nav>
        {drawer && <div className="scrim" onClick={() => setDrawer(false)} />}

        <main className="page" key={view + id}>
          {view === "tunnels" && !id && <Tunnels routes={routes} status={status} onChanged={load} />}
          {route && <TunnelPage route={route} devices={devices ?? []} onChanged={load} />}
          {view === "devices" && !id && <Devices devices={devices} routes={routes ?? []} onChanged={load} />}
          {device && <DevicePage device={device} routes={routes ?? []} onChanged={load} />}
          {view === "settings" && <Settings section={id} status={status} routes={routes ?? []} onChanged={load} />}
        </main>
      </div>
    </div>
  );
}

function NavItem({ to, icon, label, on, quiet, count, alert }: { to: string; icon: IconName; label: string; on: boolean; quiet?: boolean; count?: number; alert?: boolean }) {
  return (
    <a className={"nav-item" + (quiet ? " quiet" : "") + (on ? " on" : "")} href={to} aria-current={on ? "page" : undefined}>
      <Icon name={icon} />
      <span className="nav-label">{label}</span>
      {count !== undefined && <span className={"nav-count" + (alert ? " alert" : "")}>{count}</span>}
    </a>
  );
}

// Health is the connector's state, which opens its page in Settings.
function Health({ status }: { status: Status | null }) {
  const links = status?.connections ?? 0;
  const [tone, label] = !status ? ["", "Checking"] : links > 0 ? ["ok", "Online"] : status.running ? ["warn", "Connecting"] : ["bad", "Offline"];
  return (
    <a className="health" href="#/settings/connector" title={status?.last_error ?? (links ? `${links} links to Cloudflare` : undefined)}>
      <span className={"dot " + tone} />
      <span>{label}</span>
    </a>
  );
}

// Search finds a tunnel or a device by any part of its name and opens it.
// Ctrl+K focuses it.
function Search({ routes, devices }: { routes: Route[] | null; devices: Device[] | null }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        input.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const needle = q.trim().toLowerCase();
  const items: { key: string; icon: IconName; label: string; sub: string; to: string }[] = needle ? [
    ...(routes ?? [])
      .filter((r) => r.hostname.includes(needle) || String(r.target_port).includes(needle))
      .map((r) => ({ key: "r" + r.id, icon: "public" as IconName, label: r.hostname, sub: `port ${r.target_port}`, to: `#/tunnels/${r.id}` })),
    ...(devices ?? [])
      .filter((d) => d.id.toLowerCase().includes(needle) || d.name.toLowerCase().includes(needle))
      .map((d) => ({ key: "d" + d.id, icon: "devices" as IconName, label: d.name || d.id, sub: d.name ? d.id : d.status, to: `#/devices/${d.id}` })),
  ].slice(0, 8) : [];
  const listed = open && items.length > 0;

  const choose = (to: string) => {
    setQ("");
    setOpen(false);
    input.current?.blur();
    go(to);
  };

  const onKeyDown = (e: KeyEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => Math.max(0, Math.min(items.length - 1, a + step)));
    } else if (e.key === "Escape") {
      if (listed) setOpen(false);
      else input.current?.blur();
    }
  };

  return (
    <form className="search" role="search" autoComplete="off" onSubmit={(e) => {
      e.preventDefault();
      if (items[active]) choose(items[active].to);
    }}>
      <Icon name="search" className="search-icon" />
      <input ref={input} type="text" aria-label="Search tunnels and devices" placeholder="Search tunnels and devices"
        role="combobox" aria-expanded={listed} aria-controls="found" aria-autocomplete="list"
        aria-activedescendant={listed ? "found-" + active : undefined}
        autoComplete="off" spellCheck={false} data-1p-ignore data-lpignore="true"
        value={q} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onKeyDown={onKeyDown}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          setActive(0);
        }} />
      <kbd>Ctrl+K</kbd>
      {listed && (
        <div className="recent">
          <ul id="found" role="listbox" aria-label="Matches">
            {items.map((item, i) => (
              <li key={item.key} id={"found-" + i} role="option" aria-selected={i === active}
                className={"recent-item" + (i === active ? " active" : "")}
                onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setActive(i)} onClick={() => choose(item.to)}>
                <Icon name={item.icon} size={18} />
                <span className="recent-target">{item.label}</span>
                <span className="recent-when">{item.sub}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </form>
  );
}
