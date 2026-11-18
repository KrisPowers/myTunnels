import { useEffect, useState, type FormEvent } from "react";
import { ago, api, message, type Route, type RouteEdit, type RouteKey } from "./api";
import { Dropdown, type Option } from "./Dropdown";
import { Icon } from "./Icon";
import { useCan } from "./me";
import { Card, Copy, Dialog, Row, Switch, TextField, useNotify } from "./ui";

// RouteRules is how a route takes traffic beyond who may open it: reads only
// or reads and writes, an API key for clients that are programs, and a rate
// limit for each visitor. Every key decision lands in the route's activity.

export const RATES: Option<number>[] = [
  { value: 0, label: "Gateway default" },
  { value: 30, label: "30 a minute" },
  { value: 60, label: "60 a minute" },
  { value: 120, label: "120 a minute" },
  { value: 600, label: "600 a minute" },
  { value: 3000, label: "3,000 a minute" },
];

export function RouteRules({ route, edit, quietly }: { route: Route; edit: RouteEdit; quietly: (change: Partial<RouteEdit>) => void }) {
  const can = useCan()("tunnels.edit");
  const notify = useNotify();
  const [keys, setKeys] = useState<RouteKey[] | null>(null);
  const [naming, setNaming] = useState(false);
  const [made, setMade] = useState<{ name: string; token: string } | null>(null);
  useEffect(() => {
    api.routeKeys(route.id).then(setKeys).catch(() => setKeys([]));
  }, [route.id]);
  const revoke = async (k: RouteKey) => {
    try {
      setKeys(await api.removeRouteKey(route.id, k.id));
      notify(`Revoked ${k.name}`);
    } catch (e) {
      notify(message(e), "bad");
    }
  };
  return (
    <Card title="Traffic and API">
      <Row title="Read only" sub="Reads go through; anything that writes is refused">
        <Switch label="Read only" on={edit.read_only} disabled={!can} onChange={(v) => quietly({ read_only: v })} />
      </Row>
      <Row title="API key" sub="Clients send one as Authorization: Bearer, X-API-Key, or api_key in the body">
        <Switch label="Require an API key" on={edit.require_key} disabled={!can} onChange={(v) => quietly({ require_key: v })} />
      </Row>
      <Row title="Rate limit" sub="Requests each visitor may make">
        <Dropdown label="Rate limit" value={edit.rate_limit} options={RATES.some((r) => r.value === edit.rate_limit) ? RATES : [...RATES, { value: edit.rate_limit, label: `${edit.rate_limit} a minute` }]}
          onChange={(v) => can && quietly({ rate_limit: v })} />
      </Row>
      {(edit.require_key || (keys?.length ?? 0) > 0) && (
        <div className="keys">
          <div className="keys-head">
            <b>Keys</b>
            {can && <button type="button" className="btn small" onClick={() => setNaming(true)}><Icon name="add" size={16} />New key</button>}
          </div>
          {keys?.length === 0 && <p className="keys-none">No keys yet, so nothing gets in by key.</p>}
          {keys?.map((k) => (
            <div key={k.id} className="key">
              <Icon name="key" size={18} />
              <span className="key-text"><b>{k.name}</b><small>{k.last_used ? `Used ${ago(k.last_used)}` : "Never used"}</small></span>
              {can && <button type="button" className="icon-btn small" aria-label={`Revoke ${k.name}`} title="Revoke" onClick={() => revoke(k)}><Icon name="close" size={18} /></button>}
            </div>
          ))}
        </div>
      )}
      {naming && <NewKey route={route} onClose={() => setNaming(false)} onMade={(k, token) => {
        setKeys((list) => [...(list ?? []), k]);
        setNaming(false);
        setMade({ name: k.name, token });
      }} />}
      {made && (
        <Dialog title={`Key ${made.name}`} onClose={() => setMade(null)}>
          <p className="muted">Copy it now. Only its fingerprint is kept, so it is never shown again.</p>
          <div className="key-token"><Copy text={made.token} /></div>
          <div className="edit-actions"><button type="button" className="btn primary" onClick={() => setMade(null)}>Done</button></div>
        </Dialog>
      )}
    </Card>
  );
}

function NewKey({ route, onClose, onMade }: { route: Route; onClose: () => void; onMade: (k: RouteKey, token: string) => void }) {
  const notify = useNotify();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { key, token } = await api.addRouteKey(route.id, name.trim());
      onMade(key, token);
    } catch (err) {
      notify(message(err), "bad");
      setBusy(false);
    }
  };
  return (
    <Dialog title="New key" onClose={onClose}>
      <form onSubmit={submit}>
        <TextField label="Name" autoFocus autoComplete="off" value={name} onChange={(v) => setName(v.slice(0, 60))} hint="Who or what uses it, such as the app's name" />
        <div className="edit-actions">
          <button type="button" className="btn text" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!name.trim() || busy}>{busy && <span className="spinner small on-accent" />}Make key</button>
        </div>
      </form>
    </Dialog>
  );
}
