import type { ReactNode } from "react";
import type { IconName } from "./Icon";

// The sections, in the order the sidebar lists them.
export const DOCS: [string, string, IconName][] = [
  ["start", "Getting started", "info"],
  ["publish", "Publishing", "public"],
  ["access", "Access Control", "shield"],
  ["devices", "Devices", "devices"],
  ["users", "Users", "group"],
  ["oauth", "Third-Party OAuth", "key"],
  ["twofactor", "Two-Factor Auth", "lock"],
  ["trouble", "When something is off", "help"],
];

export function Docs({ section }: { section: string }) {
  const [key, title] = DOCS.find(([k]) => k === section) ?? DOCS[0];
  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Help</h1>
          <div className="page-sub">How myTunnels works and how to use it</div>
        </div>
      </div>
      <div className="page-body stack flow" key={key}>
        <h2 className="doc-title">{title}</h2>
        {CONTENT[key]}
      </div>
    </>
  );
}

function Doc({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="doc">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

const CONTENT: Record<string, ReactNode> = {
  start: (
    <>
      <Doc title="What it does">
        <p>myTunnels puts apps running on this computer on the internet through Cloudflare Tunnel, without opening a port on your router. Each app gets an address such as <code>app1.example.com</code>, and every visit passes through myTunnels first, which can ask who the visitor is before the app loads.</p>
      </Doc>
      <Doc title="How a visit travels">
        <p>The browser reaches Cloudflare, which sends the visit down the tunnel to the connector running inside myTunnels. myTunnels checks the tunnel's access layers, then hands the request to the app on its local port. WebSockets work the same way.</p>
      </Doc>
      <Doc title="Changing the Cloudflare connection">
        <p>Settings, Cloudflare holds the account and tunnel. A new API token can replace the old one at any time. Switching to another account or tunnel needs every tunnel removed first, since their DNS records live in the old one.</p>
      </Doc>
    </>
  ),
  publish: (
    <>
      <Doc title="A new tunnel">
        <p>Press <b>New tunnel</b>, type a subdomain, pick one of your domains, and enter the port the app listens on. Choose who can open it, then press <b>Publish</b>. The DNS record and the route are made for you, and removed with the tunnel.</p>
      </Doc>
      <Doc title="Where requests go">
        <p>By default a tunnel sends requests to the port on this computer. Under <b>Local app</b> it can point at a container name or another machine instead, and use https when the app serves it itself. Self-signed certificates are accepted.</p>
      </Doc>
      <Doc title="How the app sees a visit">
        <p>Many apps only answer requests addressed to <code>localhost</code>. So myTunnels presents each visit to the app as if it were opened on this computer, and turns the app's redirects back into the public address. Apps set up with their public address should have <b>Pass the public address</b> turned on instead.</p>
      </Doc>
    </>
  ),
  access: (
    <>
      <Doc title="Layers">
        <p>Every layer is optional. With none on, anyone with the link reaches the app, and its own login still applies.</p>
        <ul className="bullets">
          <li><b>Same network as this host</b> lets in visitors coming from this computer's internet connection, or a network listed in Settings, Network.</li>
          <li><b>Approved devices</b> lets in browsers you have approved under Devices.</li>
          <li><b>Tunnel password</b> asks for one password that belongs to this tunnel alone.</li>
          <li><b>Sign-in</b> asks for an account from Users that may open this tunnel.</li>
        </ul>
      </Doc>
      <Doc title="Combining layers">
        <p>With more than one layer on, choose <b>Require all</b> to need every one, or <b>Any one is enough</b> to let visitors use whichever they have. With any one, the page a visitor sees offers the other ways in.</p>
      </Doc>
      <Doc title="Keeping it safe">
        <p>Passwords are stored as Argon2 hashes, never as text. After five wrong tries from one place, or against one account, further tries are refused for 15 minutes. Changing a tunnel password or an account's password signs out everyone using the old one.</p>
      </Doc>
    </>
  ),
  devices: (
    <>
      <Doc title="Device keys">
        <p>The first time a browser opens this dashboard or any tunnel, it is given a 256 character device key, kept in a cookie and in the browser's local storage. Tunnels on other domains fetch the same key from the oldest tunnel's address, so one browser is one device everywhere. Only a hash of the key is stored here.</p>
      </Doc>
      <Doc title="Approving">
        <p>Devices lists every browser met so far. <b>Seen</b> ones have only visited; <b>Waiting</b> ones asked to open a tunnel that needs an approved device. Approve one for every tunnel or for chosen ones. The browser you use for this dashboard is approved on its own.</p>
      </Doc>
      <Doc title="Hardware checks">
        <p>An approved device reports its platform, touch support and graphics. If the same key later turns up with different hardware, the device goes back to waiting, which stops a copied key from working on another machine.</p>
      </Doc>
    </>
  ),
  users: (
    <>
      <Doc title="Accounts">
        <p>Users holds the accounts people sign in with at tunnels that have Sign-in on. Each has a username, an optional email (either signs in), and a password held to the same rule as every password here.</p>
      </Doc>
      <Doc title="What an account opens">
        <p>An account opens every tunnel, or only those picked. One sign-in covers every tunnel on the same domain that the account may open. Turning an account off, or removing it, ends its sessions at once.</p>
      </Doc>
    </>
  ),
  oauth: (
    <>
      <Doc title="Other ways to sign in">
        <p>Tunnels with Sign-in on can also offer <b>Continue with GitHub</b>, Google, GitLab, or an OpenID Connect provider of your own such as Authentik, Authelia, Keycloak or Pocket ID. Each is set up once on the <b>Third-Party OAuth</b> page: register an app with the provider and paste its client ID and secret back. Then each tunnel switches on the ones it offers, under Access Control.</p>
      </Doc>
      <Doc title="Who it lets in">
        <p>The provider vouches for an email. The account in Users with that email signs in, held to the same rules as signing in with its password: it must be on, may open the tunnel, and be on a device linked to it.</p>
      </Doc>
      <Doc title="The redirect URL">
        <p>A provider sends people back to the tunnel they signed in at, at <code>/__gate/oauth-callback</code>. Switching a provider on at a tunnel shows that URL to add to the provider's app. GitHub takes one callback URL that covers a whole domain, so registering <code>https://example.com</code> covers every tunnel on it.</p>
      </Doc>
    </>
  ),
  twofactor: (
    <>
      <Doc title="Emailed codes">
        <p>With Two-Factor Auth, signing in takes a code sent by email as well as the password. The code is six digits, works once, and lasts ten minutes; five wrong tries and it is gone, and signing in starts again.</p>
      </Doc>
      <Doc title="The mail server">
        <p>Codes go out through an SMTP server of your choice, such as your email provider's or a relay like Brevo or Postmark. Set it up on the <b>Two-Factor Auth</b> page; saving signs in to the server to check it, and <b>Send a test</b> emails the admin.</p>
      </Doc>
      <Doc title="Where codes are asked">
        <p><b>Dashboard sign-in</b> sends every sign-in to this dashboard a code at the admin email. Turning it on sends a test email first, so a server that does not deliver cannot lock you out. Each tunnel with Sign-in on can ask for a code too, sent to the account's email, from its Access Control or from the Two-Factor Auth page. This covers sign-ins through a third-party provider as well.</p>
      </Doc>
    </>
  ),
  trouble: (
    <>
      <Doc title="Error 1033 from Cloudflare">
        <p>The connector is not running. Settings, Connector shows its log. It starts on its own once Cloudflare is connected.</p>
      </Doc>
      <Doc title="App not responding">
        <p>Nothing answered on the tunnel's port. Check the app is running and the port is right, and for an app in a container, that its port is published on this computer.</p>
      </Doc>
      <Doc title="Points back at myTunnels">
        <p>The tunnel's port is one of myTunnels' own. Point it at the app's port instead.</p>
      </Doc>
      <Doc title="The app refuses the address">
        <p>Some apps check the name they are opened with. Keep <b>Pass the public address</b> off so they see <code>localhost</code>, or add the public address to the app's own list of allowed names.</p>
      </Doc>
    </>
  ),
};
