import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, message, type AppItem, type Apps, type HostApp, type Needs, type Os } from "./api";
import { AppLogo } from "./AppLogo";
import { Icon } from "./Icon";
import { useCan } from "./me";
import { go } from "./route";
import { Callout, Copy, Dialog, useNotify } from "./ui";

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

// AppsPage is the catalog of apps a homelab or engineering machine usually
// needs, a tile each by kind, each installed on the host or on this device.
export function AppsPage({ open }: { open: string }) {
  const [apps, setApps] = useState<Apps | null>(null);
  const [problem, setProblem] = useState("");
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

  const host = apps?.host;
  const installed = Object.values(host?.apps ?? {}).filter((a) => a.installed).length;
  const groups = [...new Set(apps?.catalog.map((a) => a.group))];
  const picked = apps?.catalog.find((a) => a.id === open);

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Apps</h1>
          {apps && host && <div className="page-sub"><span><b>{installed}</b> of {apps.catalog.length} on the host</span></div>}
        </div>
      </div>
      <div className="page-body stack">
        {problem && <Callout tone="bad" icon="error">{problem}</Callout>}
        {apps && !host && (
          <Callout tone="warn" icon="warning">The host is not answering, so apps cannot be installed there. Run <span className="mono">server host</span> on it.</Callout>
        )}
        {!apps && !problem && <div className="repo-loading"><span className="spinner" /></div>}
        {groups.map((g) => (
          <section key={g}>
            <h2 className="section-title">{g}</h2>
            <div className="provider-grid">
              {apps!.catalog.filter((a) => a.group === g).map((a) => (
                <Tile key={a.id} app={a} state={host?.apps[a.id]} />
              ))}
            </div>
          </section>
        ))}
      </div>
      {apps && picked && (
        <InstallDialog app={picked} apps={apps} onInstalled={load} onClose={() => go("#/apps")} />
      )}
    </>
  );
}

function Tile({ app, state }: { app: AppItem; state?: HostApp }) {
  return (
    <div className="provider-tile app-tile">
      <AppLogo id={app.logo} />
      <b>{app.name}</b>
      <span className="muted">{app.about}</span>
      {state?.job?.running ? <span className="chip warn"><span className="spinner small" />Installing on the host</span>
        : state?.installed ? <span className="chip ok" title={state.version ?? undefined}>On the host</span>
        : state?.job?.failed ? <span className="chip bad">Install failed</span>
        : null}
      <a className={"btn" + (state?.installed ? "" : " primary")} href={`#/apps/${app.id}`}><Icon name="download" size={18} />Install</a>
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
      await api.installApp(app.id);
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
