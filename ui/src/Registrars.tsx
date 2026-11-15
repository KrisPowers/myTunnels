import { useState, type FormEvent } from "react";
import { api, message, type Registrar, type Settings } from "./api";
import { Icon } from "./Icon";
import { Callout, Card, Dialog, Row, TextField, useNotify } from "./ui";

// The registrars whose DNS is read and changed through their APIs: what each
// asks for, and where its keys are made.
export const REGISTRARS: { host: Registrar; label: string; keys: string; fields: ("user" | "key" | "secret")[] }[] = [
  { host: "porkbun", label: "Porkbun", keys: "https://porkbun.com/account/api", fields: ["key", "secret"] },
  { host: "godaddy", label: "GoDaddy", keys: "https://developer.godaddy.com/keys", fields: ["key", "secret"] },
  { host: "namecheap", label: "Namecheap", keys: "https://ap.www.namecheap.com/settings/tools/apiaccess/", fields: ["user", "key"] },
];

const FIELD = { user: "Username", key: "API key", secret: "Secret" };

// ConnectRegistrar takes a registrar's keys, checks them, and keeps them.
export function ConnectRegistrar({ host, onDone, onClose }: { host: Registrar; onDone: (s: Settings) => void; onClose: () => void }) {
  const r = REGISTRARS.find((x) => x.host === host) ?? REGISTRARS[0];
  const [values, setValues] = useState({ user: "", key: "", secret: "" });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const ready = r.fields.every((f) => values[f].trim());
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setProblem("");
    try {
      onDone(await api.saveRegistrar(host, values));
    } catch (err) {
      setProblem(message(err));
      setBusy(false);
    }
  };
  return (
    <Dialog title={`Connect ${r.label}`} onClose={onClose}>
      <form onSubmit={submit}>
        {r.fields.map((f, i) => (
          <TextField key={f} label={FIELD[f]} autoFocus={i === 0} mono={f !== "user"} autoComplete="off" data-1p-ignore
            type={f === "user" ? "text" : "password"} value={values[f]} onChange={(v) => setValues({ ...values, [f]: v })} />
        ))}
        {problem && <Callout tone="bad" icon="error">{problem}</Callout>}
        <div className="edit-actions">
          <a className="btn text edit-actions-start" href={r.keys} target="_blank" rel="noreferrer"><Icon name="open_in_new" size={18} />Get keys</a>
          <button type="button" className="btn text" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!ready || busy}>
            {busy ? <span className="spinner small on-accent" /> : <Icon name="link" size={18} />}Connect
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// Connections lists the registrars, each connected or not.
export function Connections({ saved, onSaved }: { saved: Settings; onSaved: (s: Settings) => void }) {
  const notify = useNotify();
  const [connecting, setConnecting] = useState<Registrar | null>(null);
  return (
    <Card title="Registrars">
      {REGISTRARS.map((r) => (
        <Row key={r.host} title={r.label} sub={saved.registrars?.[r.host] ? "Connected" : undefined}>
          {saved.registrars?.[r.host] ? (
            <button type="button" className="btn danger" onClick={async () => {
              try {
                onSaved(await api.removeRegistrar(r.host));
                notify(`${r.label} disconnected`);
              } catch (e) {
                notify(message(e), "bad");
              }
            }}><Icon name="link_off" size={18} />Disconnect</button>
          ) : (
            <button type="button" className="btn" onClick={() => setConnecting(r.host)}><Icon name="link" size={18} />Connect</button>
          )}
        </Row>
      ))}
      {connecting && <ConnectRegistrar host={connecting} onClose={() => setConnecting(null)} onDone={(s) => {
        onSaved(s);
        setConnecting(null);
        notify(`${REGISTRARS.find((x) => x.host === connecting)?.label} connected`);
      }} />}
    </Card>
  );
}
