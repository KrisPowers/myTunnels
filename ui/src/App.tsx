import { useCallback, useEffect, useRef, useState, type KeyboardEvent as KeyEvent } from "react";
import { AppsPage, InstallPill, NeedsContext } from "./Apps";
import { api, deviceInfo, message, shortId, type Auth, type Device, type Flag, type Group, type Needs, type Me, type OAuthProvider, type Route, type Status, type User } from "./api";
import { NewMenu } from "./Builds";
import { ContainersPage } from "./Containers";

import { DashboardPage } from "./Dashboard";
import { DevicePage } from "./Devices";

import { Icon, type IconName } from "./Icon";

import { MeContext, useCan } from "./me";
import { go, readHash } from "./route";
import { SETTINGS, Settings } from "./Settings";
import { Setup } from "./Setup";
import { DOCS, Docs } from "./Docs";
import { StoragePage } from "./Storage";
import { NewTunnel, target, TunnelPage } from "./Tunnels";
import { NewUser, UserPage } from "./Users";
import { SecurityPage } from "./Security";
import { Callout, Notices, Tooltips, useNotify } from "./ui";

export function App() {
  return (
    <Notices>
      <Root />
      <Tooltips />
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
  if (!auth.authenticated || !auth.setup.done || !auth.me) return <Setup auth={auth} onChange={load} />;
  return (
    <MeContext.Provider value={auth.me}>
      <Dashboard me={auth.me} catalog={auth.catalog} onSignOut={async () => {
        await api.logout().catch(() => {});
        await load();
      }} />
    </MeContext.Provider>
  );
}

// Dashboard is the frame every page sits in, after Google's apps: a header with
// the name, the search bar, help and a settings menu; a sidebar with the pages; and
// the page.
function Dashboard({ me, catalog, onSignOut }: { me: Me; catalog: Group[]; onSignOut: () => void }) {
  const [place, setPlace] = useState(readHash);
  const can = useCan();
  const [routes, setRoutes] = useState<Route[] | null>(null);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [users, setUsers] = useState<User[] | null>(null);
  const [flags, setFlags] = useState<Flag[]>([]);
  const [needs, setNeeds] = useState<Needs | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [providers, setProviders] = useState<OAuthProvider[]>([]);
  // On narrow windows the menu slides the sidebar over the page; on wide ones
  // it folds the sidebar to its icons, remembered here.
  const [drawer, setDrawer] = useState(false);
  const [rail, setRail] = useState(() => {
    try {
      return localStorage.getItem("nav.rail") === "1";
    } catch {
      return false;
    }
  });
  const menu = () => {
    if (matchMedia("(max-width: 900px)").matches) return setDrawer(!drawer);
    setRail(!rail);
    try {
      localStorage.setItem("nav.rail", rail ? "0" : "1");
    } catch {
      // Kept until the page closes.
    }
  };

  const load = useCallback(async () => {
    const [r, d, u, s, o, f, n] = await Promise.allSettled([api.routes(), api.devices(), api.users(), api.status(), api.oauth(), api.flags(), api.needs()]);
    if (r.status === "fulfilled") setRoutes(r.value);
    if (d.status === "fulfilled") setDevices(d.value);
    if (u.status === "fulfilled") setUsers(u.value);
    if (s.status === "fulfilled") setStatus(s.value);
    if (o.status === "fulfilled") setProviders(o.value.providers.filter((p) => p.configured));
    if (f.status === "fulfilled") setFlags(f.value);
    if (n.status === "fulfilled") setNeeds(n.value);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  // The browser the admin uses gets its device key here, the first time. The
  // same key then goes to every tunnel and comes back, once per set of tunnels,
  // so this browser is one device on the dashboard and every tunnel.
  useEffect(() => {
    let token: string | null = null;
    try {
      token = localStorage.getItem("gate.device");
    } catch {
      // Kept for this visit only.
    }
    api.thisDevice(token, deviceInfo()).then(async (d) => {
      const planted = `${d.id}|${d.hosts.join(",")}`;
      const done = () => {
        try {
          return localStorage.getItem("gate.device.planted") === planted;
        } catch {
          return true;
        }
      };
      try {
        localStorage.setItem("gate.device", d.token);
      } catch {
        return;
      }
      if (!d.hosts.length || done()) return;
      // Only while the tunnels answer, so the trip never ends on an error page.
      const s = await api.status();
      if (!s.connections) return;
      const { url } = await api.plantDevice(d.token, location.href);
      try {
        localStorage.setItem("gate.device.planted", planted);
      } catch {
        return;
      }
      // Only once that is kept, or every visit would go round again.
      if (done()) location.assign(url);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const onHash = () => {
      setPlace(readHash());
      setDrawer(false);
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  const { view, id, page } = place;
  const apps = routes?.filter((r) => r.target_scheme !== "code") ?? null;
  const route = view === "tunnels" && id ? apps?.find((r) => r.id === id) : undefined;
  const device = view === "devices" && id ? devices?.find((d) => d.id === id) : undefined;
  const user = view === "users" && id && id !== "new" ? users?.find((u) => u.id === id) : undefined;

  // A tunnel, device or account that is gone goes back to its list.
  useEffect(() => {
    if (view === "tunnels" && id && routes && !route) go("#/");
    if (view === "devices" && id && devices && !device) go("#/devices");
    if (view === "users" && id && id !== "new" && users && !user) go("#/users");
  }, [view, id, routes, devices, users, route, device, user]);

  // Each page shows for those who may use it; the first of them is home.
  const pages: [string, string, IconName, string, boolean][] = [
    ["dashboard", "Dashboard", "dashboard", "#/dashboard", can("metrics.view")],
    ["containers", "Containers", "deployed_code", "#/", can("containers.view") || can("tunnels.view")],
    ["storage", "Storage", "cloud", "#/storage", can("media.view") || can("drive.view")],
    ["apps", "Apps", "apps", "#/apps", true],
    ["security", "Security", "shield", "#/security", ["users.view", "devices.view", "oauth.manage", "twofactor.manage"].some(can)],
  ];
  const home = pages.find((p) => p[4])?.[3] ?? "#/settings/preferences";
  useEffect(() => {
    if (view === "containers" && !id && !can("containers.view") && !can("tunnels.view") && home !== "#/") go(home);
  });
  const settings = SETTINGS.filter(([k]) => can("settings.manage") || !["cloudflare", "network", "connector"].includes(k));
  const sections = view === "settings" ? settings : view === "docs" ? DOCS : null;
  const item = ([key, label, icon, to, shown]: [string, string, IconName, string, boolean]) => shown && (
    <NavItem key={key} to={to} icon={icon} label={label}
      on={view === key || (key === "containers" && (view === "new" || view === "tunnels")) || (key === "security" && (view === "users" || view === "devices"))}
      count={key === "dashboard" ? flags.length || undefined : undefined} rail={rail} />
  );

  return (
    <NeedsContext.Provider value={needs}>
    <div className={"app" + (rail ? " rail" : "")}>
      <header className="header">
        <div className="header-start">
          <button type="button" className="icon-btn menu-btn" aria-label="Menu" aria-expanded={drawer || !rail} onClick={menu}>
            <Icon name="menu" />
          </button>
          <a className="brand" href={home}><span className="brand-mark"><Icon name="public" size={18} /></span><span className="brand-name">myTunnels</span></a>
        </div>
        <Search routes={apps} devices={devices} />
        <div className="header-actions">
          <NewMenu />
        </div>
      </header>

      <div className="shell">
        <nav className={"sidebar" + (drawer ? " open" : "")} aria-label="Pages">
          {sections ? (
            <>
              <a className="nav-back" href={home} title={rail ? "Back" : undefined}><Icon name="arrow_back" /><span className="nav-label">Back</span></a>
              {sections.map(([key, label, icon], i) => (
                <NavItem key={key} to={`#/${view}/${key}`} icon={icon} label={label} on={id === key || (!id && i === 0)} quiet rail={rail} />
              ))}
            </>
          ) : (
            pages.map(item)
          )}
          <span className="nav-gap" />
          {(me.admin || me.host) && <UpdateButton rail={rail} />}
          <NavItem to="#/docs" icon="help" label="Help" on={view === "docs"} rail={rail} />
          <NavItem to="#/settings" icon="settings" label="Settings" on={view === "settings"} rail={rail} />
        </nav>
        {drawer && <div className="scrim" onClick={() => setDrawer(false)} />}

        <main className="page" key={view + id}>
          {view === "dashboard" && <DashboardPage flags={flags} users={users ?? []} devices={devices ?? []} onChanged={load} />}
          {view === "apps" && <AppsPage />}
          {view === "storage" && <StoragePage tab={id} />}
          {view === "containers" && <ContainersPage id={id} page={page} more={place.more} routes={apps} status={status}
            users={users ?? []} providers={providers} onChanged={load} />}
          {view === "new" && <NewTunnel users={users ?? []} providers={providers} onPublished={load} port={id} />}
          {route && <TunnelPage route={route} users={users ?? []} providers={providers} onChanged={load} />}
          {device && <DevicePage device={device} users={users ?? []} onChanged={load} />}
          {view === "users" && id === "new" && <NewUser routes={apps ?? []} onAdded={load} />}
          {user && <UserPage user={user} page={page} routes={apps ?? []} devices={devices ?? []} catalog={catalog} me={me} onChanged={load} />}
          {view === "security" && <SecurityPage tab={id} users={users} devices={devices} />}
          {view === "settings" && <Settings sections={settings} section={id} status={status} routes={routes ?? []} onChanged={load} onSignOut={onSignOut} />}
          {view === "docs" && <Docs section={id} />}
        </main>
      </div>
      <InstallPill />
    </div>
    </NeedsContext.Provider>
  );
}

// NavItem is a page, or a section of settings or help, in the sidebar; folded
// to its icon, its name shows on hover.
function NavItem({ to, icon, label, on, quiet, count, rail }: { to: string; icon: IconName; label: string; on: boolean; quiet?: boolean; count?: number; rail?: boolean }) {
  return (
    <a className={"nav-item" + (quiet ? " quiet" : "") + (on ? " on" : "")} href={to} aria-current={on ? "page" : undefined} title={rail ? label : undefined}>
      <Icon name={icon} />
      <span className="nav-label">{label}</span>
      {count !== undefined && <span className="nav-count">{count}</span>}
    </a>
  );
}

// UpdateButton shows when a newer release than the one installed is out, and
// installs it. The panel stops answering while the files are swapped; once it
// answers on the new release, the page reloads.
function UpdateButton({ rail }: { rail: boolean }) {
  const [latest, setLatest] = useState("");
  const [busy, setBusy] = useState(false);
  const notify = useNotify();

  useEffect(() => {
    const check = () => api.update().then((u) => setLatest(u.available ? u.latest ?? "" : "")).catch(() => {});
    check();
    const t = setInterval(check, 30 * 60_000);
    return () => clearInterval(t);
  }, []);

  if (!latest) return null;
  const install = async () => {
    setBusy(true);
    try {
      await api.installUpdate();
    } catch (e) {
      setBusy(false);
      return notify(message(e), "bad");
    }
    const began = Date.now();
    const wait = setInterval(async () => {
      if (Date.now() - began > 5 * 60_000) {
        clearInterval(wait);
        setBusy(false);
        return notify("The update did not finish. Its log is update.txt in the myTunnels folder.", "bad");
      }
      try {
        if ((await api.update()).current === latest) {
          clearInterval(wait);
          location.reload();
        }
      } catch {
        // Not answering while the new release is put in place.
      }
    }, 2000);
  };
  const label = busy ? "Updating" : "Update Available";
  return (
    <button type="button" className="nav-item update" onClick={install} disabled={busy} title={rail ? label : undefined}>
      {busy ? <span className="spinner" /> : <Icon name="download" />}
      <span className="nav-label">{label}</span>
    </button>
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
      .filter((r) => r.hostname.includes(needle) || target(r).toLowerCase().includes(needle))
      .map((r) => ({ key: "r" + r.id, icon: "public" as IconName, label: r.hostname, sub: r.target_scheme === "dashboard" ? target(r) : `port ${r.target_port}`, to: `#/tunnels/${r.id}` })),
    ...(devices ?? [])
      .filter((d) => d.id.toLowerCase().includes(needle) || d.name.toLowerCase().includes(needle))
      .map((d) => ({ key: "d" + d.id, icon: "devices" as IconName, label: d.name || shortId(d.id), sub: d.name ? shortId(d.id) : d.info?.platform ?? "", to: `#/devices/${d.id}` })),
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
