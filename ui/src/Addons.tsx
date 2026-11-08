import { useState } from "react";
import { api, message } from "./api";
import { Icon, type IconName } from "./Icon";
import { MoreMenu, useNotify } from "./ui";

// Add-ons are apps beside myTunnels' own pages, installed by the host or an
// admin from Apps. Each installed one has a page of its own under Add-ons in
// the sidebar, shown to those with its permission.
export const ADDONS: { id: string; name: string; icon: IconName; view: string; can: string; about: string }[] = [
  { id: "git", name: "Git", icon: "git", view: "git", can: "code.view", about: "Repositories on this host, with issues and pull requests" },
  { id: "controller", name: "Device Controller", icon: "mode_fan", view: "controller", can: "hardware.control", about: "The host's fan speeds, set by hand" },
];

// AppsPage is the catalog of add-ons: a tile each, to install, open or remove.
// What a removed one kept stays.
export function AppsPage({ installed, onChange }: { installed: string[]; onChange: (addons: string[]) => void }) {
  const [busy, setBusy] = useState("");
  const notify = useNotify();
  const turn = async (id: string, on: boolean) => {
    setBusy(id);
    try {
      onChange((await api.setAddon(id, on)).addons);
    } catch (e) {
      notify(message(e), "bad");
    } finally {
      setBusy("");
    }
  };
  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Apps</h1>
          <div className="page-sub"><span><b>{installed.length}</b> of {ADDONS.length} installed</span></div>
        </div>
      </div>
      <div className="page-body">
        <div className="provider-grid">
          {ADDONS.map((a) => {
            const on = installed.includes(a.id);
            return (
              <div key={a.id} className="provider-tile app-tile">
                {on && (
                  <MoreMenu label={`${a.name} options`} actions={[
                    { label: "Remove", icon: "delete", danger: true, confirm: `Remove ${a.name}`, onClick: () => turn(a.id, false) },
                  ]} />
                )}
                <Icon name={a.icon} size={48} className="provider-logo" />
                <b>{a.name}</b>
                <span className="muted">{a.about}</span>
                {on
                  ? <a className="btn" href={`#/${a.view}`}>Open</a>
                  : <button type="button" className="btn primary" disabled={busy === a.id} onClick={() => turn(a.id, true)}><Icon name="download" size={18} />Install</button>}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
