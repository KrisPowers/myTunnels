import { useEffect, useState, type FormEvent } from "react";
import { api, message, type OAuthProvider } from "./api";
import { Icon } from "./Icon";
import { ProviderLogo } from "./ProviderLogo";
import { ArmedButton, Dialog, TextField, useNotify } from "./ui";

// Where each provider registers an app, and what to do there. Redirect URLs
// belong to tunnels: each one that offers a provider shows its own. `issuer` is
// what a self-hosted or tenant provider's issuer URL looks like.
const OWN = "make a confidential OpenID Connect client with the openid and email scopes and each tunnel's redirect URL, then enter its issuer URL.";
const GUIDE: Record<string, { link?: (domain: string) => string; how: string; issuer?: string }> = {
  github: {
    link: (domain) => "https://github.com/settings/applications/new?" + new URLSearchParams({
      "oauth_application[name]": "myTunnels",
      "oauth_application[url]": `https://${domain}`,
      "oauth_application[callback_url]": `https://${domain}`,
    }),
    how: "Opens GitHub's new OAuth app form, filled in. GitHub takes one callback URL and it covers the whole domain, so every tunnel on it works. Register it, then press Generate a new client secret.",
  },
  google: {
    link: () => "https://console.cloud.google.com/apis/credentials/oauthclient",
    how: "Create an OAuth client ID of type Web application. Add each tunnel's redirect URL under Authorized redirect URIs as you switch Google on there.",
  },
  gitlab: {
    link: () => "https://gitlab.com/-/user_settings/applications",
    how: "Add a new application, keep it Confidential, tick the openid and email scopes, and list each tunnel's redirect URL.",
  },
  discord: {
    link: () => "https://discord.com/developers/applications",
    how: "Make a new application, open OAuth2, copy the client ID, reset the secret, and add each tunnel's redirect URL under Redirects.",
  },
  slack: {
    link: () => "https://api.slack.com/apps",
    how: "Create an app, add the openid and email user scopes and each tunnel's redirect URL under OAuth & Permissions, then copy the keys from Basic Information.",
  },
  codeberg: {
    link: () => "https://codeberg.org/user/settings/applications",
    how: "Add an OAuth2 application with each tunnel's redirect URL and keep it confidential.",
  },
  authentik: { how: "In Authentik, make an OAuth2/OpenID provider and application; " + OWN, issuer: "https://auth.example.com/application/o/mytunnels/" },
  authelia: { how: "In Authelia's configuration, add an OpenID Connect client; " + OWN, issuer: "https://auth.example.com" },
  keycloak: { how: "In your Keycloak realm, " + OWN, issuer: "https://keycloak.example.com/realms/home" },
  pocketid: { how: "In Pocket ID, add an OIDC client; " + OWN, issuer: "https://id.example.com" },
  zitadel: { how: "In a Zitadel project, add a web application; " + OWN, issuer: "https://example.zitadel.cloud" },
  kanidm: { how: "In Kanidm, make an OAuth2 resource server; " + OWN, issuer: "https://idm.example.com/oauth2/openid/mytunnels" },
  gitea: { how: "Under Settings, Applications in Gitea, add an OAuth2 application with each tunnel's redirect URL, then enter your Gitea address.", issuer: "https://gitea.example.com" },
  forgejo: { how: "Under Settings, Applications in Forgejo, add an OAuth2 application with each tunnel's redirect URL, then enter your Forgejo address.", issuer: "https://git.example.com" },
  auth0: { how: "In Auth0, create a Regular Web Application with each tunnel's redirect URL as an allowed callback, then enter your tenant's address.", issuer: "https://example.us.auth0.com/" },
  okta: { how: "In Okta, create an OIDC Web Application with each tunnel's redirect URL as a sign-in redirect, then enter its authorization server.", issuer: "https://example.okta.com/oauth2/default" },
  oidc: { how: "In any OpenID Connect provider, " + OWN, issuer: "https://auth.example.com" },
};

// OAuth holds the credentials for signing in through other services, one tile
// each. Tunnels switch on the ones they offer under Access Control.
export function OAuth() {
  const [providers, setProviders] = useState<OAuthProvider[] | null>(null);
  const [open, setOpen] = useState("");
  const [domain, setDomain] = useState("");
  const notify = useNotify();
  useEffect(() => {
    api.oauth().then((s) => setProviders(s.providers)).catch((e) => notify(message(e), "bad"));
    api.zones().then((z) => setDomain(z[0]?.name ?? "")).catch(() => {});
  }, [notify]);
  const chosen = providers?.find((p) => p.id === open);

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Third-Party OAuth</h1>
        </div>
      </div>
      <div className="page-body stack">
        <div className="provider-grid">
          {providers?.map((p) => (
            <button key={p.id} type="button" className={"provider-tile" + (open === p.id ? " on" : "")} aria-expanded={open === p.id}
              onClick={() => setOpen((o) => (o === p.id ? "" : p.id))}>
              <ProviderLogo id={p.id} size={48} />
              <b>{p.label}</b>
              <span className={"chip" + (p.configured ? " ok" : "")}>{p.configured ? "Ready" : "Not set up"}</span>
            </button>
          ))}
        </div>
        {chosen && (
          <ProviderForm key={chosen.id} p={chosen} domain={domain}
            onSaved={(list) => {
              setProviders(list);
              setOpen("");
            }}
            onCancel={() => setOpen("")} />
        )}
      </div>
    </>
  );
}

// ProviderForm sets a provider up in two steps, as setup did for Cloudflare,
// in a dialog over the page.
function ProviderForm({ p, domain, onSaved, onCancel }: { p: OAuthProvider; domain: string; onSaved: (list: OAuthProvider[]) => void; onCancel: () => void }) {
  const oidc = p.id === "oidc";
  const guide = GUIDE[p.id] ?? GUIDE.oidc;
  const [name, setName] = useState(p.name);
  const [issuer, setIssuer] = useState(p.issuer);
  const [clientId, setClientId] = useState(p.client_id);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const notify = useNotify();
  const ready = clientId.trim() !== "" && (secret.trim() !== "" || p.secret_set) && (!p.needs_issuer || issuer.trim() !== "");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    try {
      const saved = await api.saveOAuth(p.id, {
        client_id: clientId.trim(),
        client_secret: secret.trim() || undefined,
        ...(oidc ? { name: name.trim() } : {}),
        ...(p.needs_issuer ? { issuer: issuer.trim() } : {}),
      });
      notify(`${oidc && name.trim() ? name.trim() : p.label} saved`);
      onSaved(saved.providers);
    } catch (err) {
      notify(message(err), "bad");
      setBusy(false);
    }
  };

  const remove = async () => {
    try {
      const saved = await api.removeOAuth(p.id);
      notify(`${p.label} removed`);
      onSaved(saved.providers);
    } catch (err) {
      notify(message(err), "bad");
    }
  };

  return (
    <Dialog title={<><ProviderLogo id={p.id} size={28} />{p.label}</>} onClose={onCancel}>
      <form onSubmit={submit}>
        <ol className="how">
          <li>
            <span className="how-num">1</span>
            <div className="how-body">
              <b>Register myTunnels with {oidc ? "your provider" : p.label}</b>
              <span className="muted">{guide.how}</span>
              {guide.link && (
                <a className="btn how-link" href={guide.link(domain || "example.com")} target="_blank" rel="noreferrer"><Icon name="open_in_new" size={18} />Open {p.label}</a>
              )}
            </div>
          </li>
          <li>
            <span className="how-num">2</span>
            <div className="how-body">
              <b>Paste its keys here</b>
              {oidc && <TextField label="Name on the button" placeholder="Authentik" autoComplete="off" value={name} onChange={setName} />}
              {p.needs_issuer && <TextField label="Issuer URL" mono placeholder={guide.issuer} autoComplete="off" value={issuer} onChange={setIssuer} />}
              <TextField label="Client ID" mono autoComplete="off" data-1p-ignore data-lpignore="true" value={clientId} onChange={setClientId} />
              <TextField label="Client secret" type="password" mono autoComplete="off" data-1p-ignore data-lpignore="true"
                placeholder={p.secret_set ? "Saved. Paste a new one to replace it." : undefined} value={secret} onChange={setSecret} />
            </div>
          </li>
        </ol>
        <div className="edit-actions">
          {p.configured && <span className="edit-actions-start"><ArmedButton icon="delete" label="Remove" armedLabel="Remove for good" onConfirm={remove} /></span>}
          <button type="button" className="btn text" onClick={onCancel}>Cancel</button>
          <button className="btn primary" disabled={busy || !ready}>{busy && <span className="spinner small on-accent" />}Save</button>
        </div>
      </form>
    </Dialog>
  );
}
