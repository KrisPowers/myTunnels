import { useState } from "react";
import { api, message } from "./api";
import { Icon, type IconName } from "./Icon";
import { Dialog, Row, Switch, useNotify } from "./ui";

// Add-ons are apps beside myTunnels' own pages, installed by the host or an
// admin. Each has a page of its own under Add-ons in the sidebar, shown to
// those with its permission.
export const ADDONS: { id: string; name: string; icon: IconName; view: string; can: string; about: string }[] = [
  { id: "git", name: "Git", icon: "git", view: "git", can: "code.view", about: "Repositories on this host, with issues and pull requests" },
  { id: "controller", name: "Device Controller", icon: "mode_fan", view: "controller", can: "hardware.control", about: "The host's fan speeds, set by hand" },
];

// AddonsDialog installs and removes add-ons. What a removed one kept stays.
export function AddonsDialog({ installed, onChange, onClose }: { installed: string[]; onChange: (addons: string[]) => void; onClose: () => void }) {
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
    <Dialog title="Add-ons" onClose={onClose}>
      {ADDONS.map((a) => (
        <Row key={a.id} title={<span className="addon-name"><Icon name={a.icon} />{a.name}</span>} sub={a.about}>
          <Switch label={`Install ${a.name}`} on={installed.includes(a.id)} disabled={busy === a.id} onChange={(on) => turn(a.id, on)} />
        </Row>
      ))}
    </Dialog>
  );
}
