import { useEffect, useState, type FormEvent } from "react";
import { api, message, type OAuthProvider, type OAuthState } from "./api";
import { Icon } from "./Icon";
import { ArmedButton, Callout, Card, Copy, Row, Switch, TextField, useNotify } from "./ui";

// Where each provider registers an app, and what to do there.
const GUIDE: Record<string, { link?: (callback: string) => string; how: string }> = {
  github: {
    link: (callback) => "https://github.com/settings/applications/new?" + new URLSearchParams({
      "oauth_application[name]": "myTunnels",
      "oauth_application[url]": new URL(callback).origin,
      "oauth_application[callback_url]": callback,
    }),
    how: "Opens GitHub's new OAuth app form with the callback filled in. Register it, then press Generate a new client secret.",
  },
  google: {
    link: () => "https://console.cloud.google.com/apis/credentials/oauthclient",
    how: "Create an OAuth client ID of type Web application, and add the redirect URL under Authorized redirect URIs.",
  },
  gitlab: {
    link: () => "https://gitlab.com/-/user_settings/applications",
    how: "Add a new application with the redirect URL, keep it Confidential, and tick the openid and email scopes.",
  },
  oidc: {
    how: "In Authentik, Authelia, Keycloak, Pocket ID or any OpenID Connect provider, make a confidential client with the redirect URL and the openid and email scopes.",
  },
};

// OAuth is where tunnels that ask for sign-in get other ways in: GitHub,
// Google, GitLab, or an OpenID Connect provider of your own. Each is set up
// like Cloudflare was: register an app there, paste its keys here.
export function OAuth() {
  const [state, setState] = useState<OAuthState | null>(null);
  const notify = useNotify();
  useEffect(() => {
    api.oauth().then(setState).catch((e) => notify(message(e), "bad"));
  }, [notify]);
  const on = state?.providers.filter((p) => p.enabled).length ?? 0;

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Third-Party OAuth</h1>
          <div className="page-sub">
            <span><b>{on}</b> on</span>
            <span>Sign in at tunnels with an account people already have</span>
          </div>
        </div>
      </div>
      <div className="page-body stack">
        {state && !state.callback && (
          <Callout tone="warn" icon="warning">Publish a tunnel first. Providers send people back through one of your tunnel addresses.</Callout>
        )}
        {state?.callback && (
          <Card title="Redirect URL" sub="Give this to each provider. Sign-ins come back through it, then on to the tunnel they started from.">
            <Row title="Redirect URL"><Copy text={state.callback} /></Row>
          </Card>
        )}
        {state?.providers.map((p) => <ProviderCard key={p.id} p={p} callback={state.callback} onSaved={setState} />)}
        <Callout icon="info">The provider vouches for an email. The account in <a href="#/users">Users</a> with that email signs in, from a device linked to it, at the tunnels it may open.</Callout>
      </div>
    </>
  );
}

function ProviderCard({ p, callback, onSaved }: { p: OAuthProvider; callback: string | null; onSaved: (s: OAuthState) => void }) {
  const [open, setOpen] = useState(false);
  const notify = useNotify();
  const toggle = (enabled: boolean) =>
    api.saveOAuth(p.id, { enabled }).then(onSaved).catch((e) => notify(message(e), "bad"));

  return (
    <Card title={p.label} sub={!p.configured ? "Not set up" : p.enabled ? "On at every tunnel that asks for sign-in" : "Off"}
      action={
        <span className="card-actions">
          {p.configured && <Switch label={`Sign in with ${p.label}`} on={p.enabled} onChange={toggle} />}
          {p.configured ? (
            <button type="button" className="icon-btn" aria-label={`Change ${p.label}`} title="Change" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              <Icon name="edit" size={20} />
            </button>
          ) : !open && (
            <button type="button" className="btn" onClick={() => setOpen(true)}>Set up</button>
          )}
        </span>
      }>
      {open && <ProviderForm p={p} callback={callback} onSaved={onSaved} onDone={() => setOpen(false)} />}
    </Card>
  );
}

// ProviderForm sets a provider up in two steps, as setup did for Cloudflare.
function ProviderForm({ p, callback, onSaved, onDone }: { p: OAuthProvider; callback: string | null; onSaved: (s: OAuthState) => void; onDone: () => void }) {
  const oidc = p.id === "oidc";
  const guide = GUIDE[p.id];
  const [name, setName] = useState(p.name);
  const [issuer, setIssuer] = useState(p.issuer);
  const [clientId, setClientId] = useState(p.client_id);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const notify = useNotify();
  const ready = clientId.trim() !== "" && (secret.trim() !== "" || p.secret_set) && (!oidc || issuer.trim() !== "");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    try {
      onSaved(await api.saveOAuth(p.id, {
        client_id: clientId.trim(),
        client_secret: secret.trim() || undefined,
        ...(oidc ? { name: name.trim(), issuer: issuer.trim() } : {}),
      }));
      notify(`${oidc && name.trim() ? name.trim() : p.label} saved`);
      onDone();
    } catch (err) {
      notify(message(err), "bad");
      setBusy(false);
    }
  };

  const remove = async () => {
    try {
      onSaved(await api.removeOAuth(p.id));
      notify(`${p.label} removed`);
      onDone();
    } catch (err) {
      notify(message(err), "bad");
    }
  };

  return (
    <form className="card-steps" onSubmit={submit}>
      <ol className="how">
        <li>
          <span className="how-num">1</span>
          <div className="how-body">
            <b>Register myTunnels with {oidc ? "your provider" : p.label}</b>
            <span className="muted">{guide.how}</span>
            {callback && <span className="redirect-line"><span className="muted">Redirect URL</span><Copy text={callback} /></span>}
            {guide.link && callback && (
              <a className="btn how-link" href={guide.link(callback)} target="_blank" rel="noreferrer"><Icon name="open_in_new" size={18} />Open {p.label}</a>
            )}
          </div>
        </li>
        <li>
          <span className="how-num">2</span>
          <div className="how-body">
            <b>Paste its keys here</b>
            {oidc && <TextField label="Name on the button" placeholder="Authentik" autoComplete="off" value={name} onChange={setName} />}
            {oidc && <TextField label="Issuer URL" mono placeholder="https://auth.example.com/application/o/mytunnels/" autoComplete="off" value={issuer} onChange={setIssuer} />}
            <TextField label="Client ID" mono autoComplete="off" data-1p-ignore data-lpignore="true" value={clientId} onChange={setClientId} />
            <TextField label="Client secret" type="password" mono autoComplete="off" data-1p-ignore data-lpignore="true"
              placeholder={p.secret_set ? "Saved. Paste a new one to replace it." : undefined} value={secret} onChange={setSecret} />
          </div>
        </li>
      </ol>
      <div className="edit-actions">
        {p.configured && <span className="edit-actions-start"><ArmedButton icon="delete" label="Remove" armedLabel="Remove for good" onConfirm={remove} /></span>}
        <button type="button" className="btn text" onClick={onDone}>Cancel</button>
        <button className="btn primary" disabled={busy || !ready}>{busy && <span className="spinner small on-accent" />}Save</button>
      </div>
    </form>
  );
}
