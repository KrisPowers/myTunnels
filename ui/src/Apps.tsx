import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, message, type AppAction, type AppItem, type Apps, type HostApp, type Needs, type Os } from "./api";
import { AppLogo } from "./AppLogo";
import { Dropdown, MultiDropdown, type Option } from "./Dropdown";
import { Icon, type IconName } from "./Icon";
import { useCan } from "./me";
import { go } from "./route";
import { Callout, Copy, Dialog, MoreMenu, useNotify, type MenuAction } from "./ui";

// What features need where myTunnels runs, from the shell.
export const NeedsContext = createContext<Needs | null>(null);

const NEEDED: Record<keyof Needs, string> = { docker: "Docker", git: "Git", cloudflared: "cloudflared" };

// NeedsApp says a feature cannot work until an app is installed, with the way
// to install it. Nothing shows while the app is there.
export function NeedsApp({ app, what }: { app: keyof Needs; what: string }) {
  const needs = useContext(NeedsContext);
  if (!needs || needs[app]) return null;
  return (
    <Callout tone="warn" icon="warning">
      {what} needs {NEEDED[app]}, which is not installed where myTunnels runs. <a href={`#/apps/${app}`}>Install {NEEDED[app]}</a>
    </Callout>
  );
}

const OS_NAME: Record<Os, string> = { windows: "Windows", macos: "macOS", linux: "Linux" };

// The visitor's own machine, as the browser tells it.
function deviceOs(): Os {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const p = (nav.userAgentData?.platform || navigator.platform || navigator.userAgent).toLowerCase();
  if (p.includes("win")) return "windows";
  if (p.includes("mac") || p.includes("iphone") || p.includes("ipad")) return "macos";
  return "linux";
}

// Which apps show by what the host has: all of them, those it has, those it
// lacks, or those myTunnels itself uses.
type Status = "all" | "installed" | "missing" | "used";
const STATUS: Option<Status>[] = [
  { value: "all", label: "Any status" },
  { value: "installed", label: "Installed" },
  { value: "missing", label: "Not installed" },
  { value: "used", label: "Used by myTunnels" },
];

const DOING: Record<AppAction, string> = { install: "Installing", update: "Updating", uninstall: "Removing" };
const DONE: Record<AppAction, string> = { install: "Install", update: "Update", uninstall: "Uninstall" };

// AppsPage is the catalog of apps a homelab or engineering machine usually
// needs, a tile each, each installed on the host or on this device.
export function AppsPage({ open }: { open: string }) {
  const [apps, setApps] = useState<Apps | null>(null);
  const [problem, setProblem] = useState("");
  const [q, setQ] = useState("");
  const [kinds, setKinds] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>("all");
  const notify = useNotify();
  const load = useCallback(async () => {
    try {
      setApps(await api.apps());
      setProblem("");
    } catch (e) {
      setProblem(message(e));
    }
  }, []);
  const running = Object.values(apps?.host?.apps ?? {}).some((a) => a.job?.running);
  useEffect(() => {
    load();
    const t = setInterval(load, running ? 3000 : 15000);
    return () => clearInterval(t);
  }, [load, running]);

  const act = async (app: AppItem, action: AppAction) => {
    try {
      await api.appAction(app.id, action);
      notify(`${DOING[action]} ${app.name} on the host`);
      await load();
    } catch (e) {
      notify(message(e), "bad");
    }
  };

  const host = apps?.host;
  const catalog = apps?.catalog ?? [];
  const has = (a: AppItem) => !!host?.apps[a.id]?.installed;
  const groups = [...new Set(catalog.map((a) => a.group))];
  const needle = q.trim().toLowerCase();
  const shown = catalog.filter((a) =>
    (!needle || [a.name, a.about, a.group].some((t) => t.toLowerCase().includes(needle)))
    && (!kinds.length || kinds.includes(a.group))
    && (status === "all" || (status === "installed" ? has(a) : status === "missing" ? !has(a) : a.used)));
  const picked = catalog.find((a) => a.id === open);

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Apps</h1>
          {apps && host && <div className="page-sub"><span><b>{catalog.filter(has).length}</b> of {catalog.length} on the host</span></div>}
        </div>
        <div className="page-actions">
          <label className="ct-search">
            <Icon name="search" size={18} />
            <input type="search" placeholder="Search" aria-label="Search apps" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
          </label>
          <div className="ex-pick"><MultiDropdown label="Kind" values={kinds} options={groups.map((g) => ({ value: g, label: g }))} allLabel="Every kind" onChange={setKinds} /></div>
          <div className="ex-pick"><Dropdown label="Status" value={status} options={STATUS} onChange={setStatus} /></div>
        </div>
      </div>
      <div className="page-body stack">
        {problem && <Callout tone="bad" icon="error">{problem}</Callout>}
        {apps && !host && (apps.outdated ? (
          <Callout tone="warn" icon="warning"><span className="mono">server host</span> on the host is an older version, which cannot tell what is installed. Start the new one in its place.</Callout>
        ) : (
          <Callout tone="warn" icon="warning">The host is not answering, so apps cannot be installed there. Run <span className="mono">server host</span> on it.</Callout>
        ))}
        {!apps && !problem && <div className="repo-loading"><span className="spinner" /></div>}
        {apps && (shown.length ? (
          <div className="provider-grid">
            {shown.map((a) => <Tile key={a.id} app={a} state={host?.apps[a.id]} onAct={(action) => act(a, action)} />)}
          </div>
        ) : <p className="empty-note">No apps match.</p>)}
      </div>
      {apps && picked && (
        <InstallDialog app={picked} apps={apps} onInstalled={load} onClose={() => go("#/apps")} />
      )}
    </>
  );
}

// Tile is one app: its mark, name and what it is, and Install, or Installed
// with its menu for the rest.
function Tile({ app, state, onAct }: { app: AppItem; state?: HostApp; onAct: (action: AppAction) => void }) {
  const can = useCan();
  const job = state?.job;
  const manage = can("apps.install") && !!state?.can && !job?.running;
  const menu: MenuAction[] = [
    ...(manage ? [
      { label: "Update", icon: "refresh" as IconName, onClick: () => onAct("update") },
      { label: "Uninstall", icon: "delete" as IconName, danger: true, confirm: `Uninstall ${app.name}`, onClick: () => onAct("uninstall") },
    ] : []),
    { label: "On this device", icon: "devices", onClick: () => go(`#/apps/${app.id}`) },
    { label: "Download", icon: "open_in_new", onClick: () => window.open(app.url, "_blank", "noreferrer") },
  ];
  return (
    <div className="provider-tile app-tile">
      {state?.installed && <MoreMenu label={`${app.name} options`} actions={menu} />}
      <AppLogo id={app.logo} />
      <b>{app.name}</b>
      <span className="muted">{app.about}</span>
      {job?.running ? <span className="chip warn"><span className="spinner small" />{DOING[job.action]} on the host</span>
        : job?.failed ? <span className="chip bad" title={job.log}>{DONE[job.action]} failed</span>
        : null}
      {state?.installed
        ? <button type="button" className="btn" disabled title={state.version ?? undefined}><Icon name="check" size={18} />Installed</button>
        : <a className="btn primary" href={`#/apps/${app.id}`}><Icon name="download" size={18} />Install</a>}
    </div>
  );
}

// InstallDialog installs one app on the host, or says how to on this device.
function InstallDialog({ app, apps, onInstalled, onClose }: { app: AppItem; apps: Apps; onInstalled: () => Promise<void>; onClose: () => void }) {
  const can = useCan();
  const notify = useNotify();
  const [busy, setBusy] = useState(false);
  const host = apps.host;
  const state = host?.apps[app.id];
  const os = deviceOs();
  const command = app.commands[os];
  const needs = app.needs ? apps.catalog.find((a) => a.id === app.needs) : undefined;

  const install = async () => {
    setBusy(true);
    try {
      await api.appAction(app.id, "install");
      notify(`Installing ${app.name} on the host`);
      await onInstalled();
    } catch (e) {
      notify(message(e), "bad");
    } finally {
      setBusy(false);
    }
  };

  const hostLine = !host ? "The host is not answering."
    : state?.installed ? `Installed${state.version ? `: ${state.version}` : ""}`
    : state?.job?.running ? "Installing now."
    : !state?.can ? (needs && !host.apps[needs.id]?.installed ? `Install ${needs.name} on the host first.` : `${host.manager ?? "Its package manager"} does not carry it there.`)
    : !can("apps.install") ? "You don't have permission to install on the host."
    : `With ${app.needs ? "npm" : host.manager}${host.os === "windows" ? "; Windows may ask to allow it" : ""}.`;

  return (
    <Dialog title={<span className="provider-name"><AppLogo id={app.logo} size={24} />Install {app.name}</span>} onClose={onClose}>
      <div className="stack">
        <section>
          <h3 className="section-title">On the host</h3>
          <p className="muted">{hostLine}</p>
          {state?.job?.failed && state.job.log && <pre className="mono install-log">{state.job.log}</pre>}
          {host && state && !state.installed && state.can && can("apps.install") && (
            <button type="button" className="btn primary" disabled={busy || state.job?.running} onClick={install}>
              {busy || state.job?.running ? <span className="spinner small" /> : <Icon name="download" size={18} />}Install on the host
            </button>
          )}
        </section>
        <section>
          <h3 className="section-title">On this device</h3>
          {command ? (
            <p className="muted">In a terminal on {OS_NAME[os]}{needs ? `, with ${needs.name} installed` : ""}: <Copy text={command} /></p>
          ) : (
            <p className="muted">There is no {OS_NAME[os]} package for it; get it from its makers.</p>
          )}
          <a className="btn" href={app.url} target="_blank" rel="noreferrer"><Icon name="open_in_new" size={18} />Download</a>
        </section>
      </div>
    </Dialog>
  );
}
