import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, message, type AppAction, type AppItem, type Apps, type HostApp, type Needs } from "./api";
import { AppLogo } from "./AppLogo";
import { Dropdown, MultiDropdown, type Option } from "./Dropdown";
import { Icon, type IconName } from "./Icon";
import { useCan } from "./me";
import { Callout, MoreMenu, useNotify, type MenuAction } from "./ui";

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
      {what} needs {NEEDED[app]}, which is not installed. <a href="#/apps">Install {NEEDED[app]}</a>
    </Callout>
  );
}

// Which apps show: all of them, those installed, those not, or those
// myTunnels itself uses.
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
// needs, a tile each, each installed with one click.
export function AppsPage() {
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
      notify(`${DOING[action]} ${app.name}`);
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

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Apps</h1>
          {apps && host && <div className="page-sub"><span><b>{catalog.filter(has).length}</b> of {catalog.length} installed</span></div>}
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
          <Callout tone="warn" icon="warning">The running <span className="mono">server host</span> is an older version, which cannot tell what is installed. Start the new one in its place.</Callout>
        ) : (
          <Callout tone="warn" icon="warning"><span className="mono">server host</span> is not answering, so apps cannot be checked or installed. Start it.</Callout>
        ))}
        {!apps && !problem && <div className="repo-loading"><span className="spinner" /></div>}
        {apps && (shown.length ? (
          <div className="provider-grid">
            {shown.map((a) => <Tile key={a.id} app={a} state={host?.apps[a.id]} onAct={(action) => act(a, action)} />)}
          </div>
        ) : <p className="empty-note">No apps match.</p>)}
      </div>
    </>
  );
}

// Why an app cannot be installed now, if it cannot.
function blocked(app: AppItem, state: HostApp | undefined, allowed: boolean): string {
  if (!state) return "server host is not answering";
  if (!allowed) return "You don't have permission to install apps";
  if (!state.can) return app.needs ? "Install what it needs first" : "Its package manager does not carry it here";
  return "";
}

// Tile is one app: its mark, name and what it is, and Install, or Installed
// with its menu for the rest.
function Tile({ app, state, onAct }: { app: AppItem; state?: HostApp; onAct: (action: AppAction) => void }) {
  const can = useCan();
  const job = state?.job;
  const why = blocked(app, state, can("apps.install"));
  const menu: MenuAction[] = [
    { label: "Update", icon: "refresh" as IconName, onClick: () => onAct("update") },
    { label: "Uninstall", icon: "delete" as IconName, danger: true, confirm: `Uninstall ${app.name}`, onClick: () => onAct("uninstall") },
  ];
  return (
    <div className="provider-tile app-tile">
      {state?.installed && !why && !job?.running && <MoreMenu label={`${app.name} options`} actions={menu} />}
      <AppLogo id={app.logo} />
      <b>{app.name}</b>
      <span className="muted">{app.about}</span>
      {job?.running ? <span className="chip warn"><span className="spinner small" />{DOING[job.action]}</span>
        : job?.failed ? <span className="chip bad" title={job.log}>{DONE[job.action]} failed</span>
        : null}
      {state?.installed
        ? <button type="button" className="btn" disabled title={state.version ?? undefined}><Icon name="check" size={18} />Installed</button>
        : (
          <button type="button" className="btn primary" disabled={!!why || job?.running} title={why || undefined} onClick={() => onAct("install")}>
            <Icon name="download" size={18} />Install
          </button>
        )}
    </div>
  );
}
