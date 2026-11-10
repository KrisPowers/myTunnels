import { createContext, useCallback, useContext, useEffect, useRef, useState, type UIEvent } from "react";
import { createPortal } from "react-dom";
import { api, message, type AppAction, type AppItem, type AppJob, type Apps, type HostApp, type InstallStage, type Needs } from "./api";
import { AppLogo } from "./AppLogo";
import { Dropdown, MultiDropdown, type Option } from "./Dropdown";
import { Icon, type IconName } from "./Icon";
import { useCan } from "./me";
import { Callout, MoreMenu, useNotify, usePopover, type MenuAction } from "./ui";

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
const DID: Record<AppAction, string> = { install: "Installed", update: "Updated", uninstall: "Removed" };

// Said when an install starts, with the app's id, so the pill looks at once.
const JOB_STARTED = "app-job-started";

// The steps an install goes through, in order; removing one skips the download.
const STAGES: InstallStage[] = ["preparing", "downloading", "installing", "checking"];
const STAGE: Record<InstallStage, string> = { preparing: "Preparing", downloading: "Downloading", installing: "Installing", checking: "Checking" };

type Running = { id: string; name: string; job: AppJob };

// What the pill says of a job: the step it is on, or how it ended.
function said(job: AppJob) {
  if (!job.running) return job.failed ? `${DONE[job.action]} failed` : DID[job.action];
  if (!job.stage) return DOING[job.action];
  const step = job.stage === "installing" && job.action === "uninstall" ? "Removing" : STAGE[job.stage];
  return job.percent != null ? `${step} ${job.percent}%` : step;
}

// InstallPill sits in the bottom right on every page while apps install,
// update or are removed, with the step each is on, then says for a moment
// how each ended.
export function InstallPill() {
  const [shown, setShown] = useState<Running[]>([]);
  const [busy, setBusy] = useState(false);
  // The apps last seen running, so their ending is shown.
  const watching = useRef(new Set<string>());
  const busyNow = useRef(false);
  const look = useCallback(async () => {
    let apps: Apps;
    try {
      apps = await api.apps();
    } catch {
      return;
    }
    const names = new Map(apps.catalog.map((a) => [a.id, a.name] as const));
    const now: Running[] = [];
    const ended: Running[] = [];
    for (const [id, state] of Object.entries(apps.host?.apps ?? {})) {
      if (!state.job) continue;
      const item = { id, name: names.get(id) ?? id, job: state.job };
      if (state.job.running) now.push(item);
      else if (watching.current.has(id)) ended.push(item);
    }
    watching.current = new Set(now.map((r) => r.id));
    busyNow.current = now.length > 0;
    setBusy(busyNow.current);
    const fresh = new Set([...now, ...ended].map((r) => r.id));
    setShown((was) => [...now, ...was.filter((r) => !r.job.running && !fresh.has(r.id)), ...ended]);
    for (const r of ended) setTimeout(() => setShown((s) => s.filter((x) => x !== r)), 5000);
  }, []);
  useEffect(() => {
    const started = (e: Event) => {
      const id = (e as CustomEvent<string | undefined>).detail;
      if (id) watching.current.add(id);
      // While busy, the next look is a second away anyway.
      if (id || !busyNow.current) look();
    };
    addEventListener(JOB_STARTED, started);
    return () => removeEventListener(JOB_STARTED, started);
  }, [look]);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(look, 1000);
    return () => clearInterval(t);
  }, [busy, look]);

  if (!shown.length) return null;
  return (
    <div className="install-pills" role="status" aria-live="polite">
      {shown.map(({ id, name, job }) => {
        const stages = STAGES.filter((s) => job.action !== "uninstall" || s !== "downloading");
        const at = job.stage ? stages.indexOf(job.stage) : -1;
        return (
          <div key={id} className={"install-pill" + (job.running ? "" : job.failed ? " bad" : " ok")} title={job.log || undefined}>
            {job.running ? <span className="spinner" /> : <Icon name={job.failed ? "error" : "check_circle"} size={16} />}
            <b>{name}</b>
            <span>{said(job)}</span>
            {job.running && at >= 0 && (
              <span className="install-steps" aria-label={`Step ${at + 1} of ${stages.length}`}>
                {stages.map((s, i) => <i key={s} className={i < at ? "done" : i === at ? "on" : undefined} />)}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

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
      const got = await api.apps();
      setApps(got);
      setProblem("");
      // An install found running, from before this page opened, gets its pill.
      if (Object.values(got.host?.apps ?? {}).some((a) => a.job?.running)) dispatchEvent(new CustomEvent(JOB_STARTED));
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

  const act = async (app: AppItem, action: AppAction, version?: string) => {
    try {
      await api.appAction(app.id, action, version);
      dispatchEvent(new CustomEvent(JOB_STARTED, { detail: app.id }));
      notify(`${DOING[action]} ${app.name}${version ? ` ${version}` : ""}`);
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
            {shown.map((a) => <Tile key={a.id} app={a} state={host?.apps[a.id]} onAct={(action, version) => act(a, action, version)} />)}
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
function Tile({ app, state, onAct }: { app: AppItem; state?: HostApp; onAct: (action: AppAction, version?: string) => void }) {
  const can = useCan();
  const job = state?.job;
  const why = blocked(app, state, can("apps.install"));
  const stopped = !!why || !!job?.running;
  // Install is the tile's main action only while it can be pressed.
  const main = !state?.installed && !stopped;
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
      <div className={"split" + (main ? " primary" : "")}>
        {state?.installed
          ? <button type="button" className="btn" disabled title={state.version ?? undefined}><Icon name="check" size={18} />Installed</button>
          : (
            <button type="button" className={"btn" + (main ? " primary" : "")} disabled={stopped} title={why || undefined} onClick={() => onAct("install")}>
              <Icon name="download" size={18} />Install
            </button>
          )}
        <Versions app={app} installed={state?.installed ? state.version : null} primary={main}
          disabled={stopped} onPick={(v) => onAct("install", v)} />
      </div>
    </div>
  );
}

// How many versions the list draws at first, and adds as it nears its end.
const PAGE = 20;

// True when `line`, what the app said of its version, is version `v`.
function says(line: string, v: string) {
  const at = line.indexOf(v);
  const edge = (c: string | undefined) => !c || !/[0-9.]/.test(c);
  return at >= 0 && edge(line[at - 1]) && edge(line[at + v.length]);
}

// Versions is the arrow beside Install: its list offers the latest at once,
// then the app's versions, newest first, drawn a page at a time as it scrolls.
// Picking one installs that version, in place of the one there.
function Versions({ app, installed, primary, disabled, onPick }: {
  app: AppItem;
  // What the installed app says of its version, when it is installed.
  installed: string | null | undefined;
  primary: boolean;
  disabled: boolean;
  onPick: (version?: string) => void;
}) {
  const pop = usePopover(220);
  const [list, setList] = useState<string[] | null>(null);
  const [problem, setProblem] = useState("");
  const [shown, setShown] = useState(PAGE);
  useEffect(() => {
    if (!pop.open || list) return;
    api.appVersions(app.id).then(setList, (e) => setProblem(message(e)));
  }, [pop.open, list, app.id]);
  const more = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 48) setShown((n) => n + PAGE);
  };
  const pick = (v?: string) => {
    pop.close();
    onPick(v);
  };
  return (
    <div className="menu-wrap" ref={pop.anchor}>
      <button type="button" className={"btn split-more" + (primary ? " primary" : "")} aria-label={`${app.name} versions`} title="Versions"
        aria-expanded={pop.open} disabled={disabled} onClick={() => pop.setOpen((o) => !o)}>
        <Icon name="expand_more" size={18} />
      </button>
      {pop.open && createPortal(
        <div ref={pop.panel} className="menu pop-menu versions" style={pop.style} role="menu" onScroll={more}>
          {!installed && <button type="button" role="menuitem" className="menu-item" onClick={() => pick()}>Latest</button>}
          {!list && !problem && <div className="menu-note"><span className="spinner small" /></div>}
          {problem && <div className="menu-note">{problem}</div>}
          {list && !list.length && <div className="menu-note">Only the latest is offered here</div>}
          {list?.slice(0, shown).map((v) => {
            const here = !!installed && says(installed, v);
            return (
              <button key={v} type="button" role="menuitem" className="menu-item" disabled={here} onClick={() => pick(v)}>
                <span className="mono">{v}</span>{here && <small>Installed</small>}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
