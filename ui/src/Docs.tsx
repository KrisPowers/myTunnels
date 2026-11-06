import type { ReactNode } from "react";
import type { IconName } from "./Icon";

// The sections, in the order the sidebar lists them.
export const DOCS: [string, string, IconName][] = [
  ["start", "Getting started", "info"],
  ["dashboard", "Dashboard", "dashboard"],
  ["containers", "Containers", "deployed_code"],
  ["images", "Images", "layers"],
  ["git", "Git", "code"],
  ["storage", "Storage", "cloud"],
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
  dashboard: (
    <>
      <Doc title="What it shows">
        <p><b>Dashboard</b> reads the host every two seconds and draws the last five minutes: CPU overall and per logical processor, memory, network traffic and the processor's temperature. Under them are each core's usage, clock and temperature, every container, every disk and every temperature sensor. Point at a chart to read any moment of it.</p>
      </Doc>
      <Doc title="Where the figures come from">
        <p>Processors, memory, disks and temperatures are the host's own, even from inside the container. Network traffic is what passes through myTunnels. Containers come from the Docker API, through the <code>docker</code> service in <code>compose.yaml</code>, which allows containers and nothing else.</p>
      </Doc>
      <Doc title="No temperatures">
        <p>Temperatures need sensors the host exposes under <code>/sys/class/hwmon</code>. A Linux host does; Docker Desktop runs containers in a virtual machine, which has none.</p>
      </Doc>
    </>
  ),
  containers: (
    <>
      <Doc title="What it shows">
        <p><b>Containers</b> says how many run, their CPU and memory together and how many tunnels are live, then a row per container with its name over its image, published ports (each opens in a new tab), the tunnels that reach it, CPU, memory and how long it has run. Compose projects with more than one container fold under their name. Open one for its Logs, Inspect, Mounts and Stats. Tunnels to anything else are listed beneath, as <b>Other tunnels</b>.</p>
      </Doc>
      <Doc title="Managing them">
        <p>Each row's menu holds logs, <b>Forward to a tunnel</b>, start or stop, restart, kill and delete; a project's menu starts, stops or restarts all of it. Search, or show only running ones, to find them. Deleting takes a stopped container away and leaves its volumes. The container myTunnels runs in is marked and is never stopped from here.</p>
      </Doc>
      <Doc title="What Docker allows">
        <p>myTunnels reaches Docker through the <code>docker</code> service in <code>compose.yaml</code>, which allows containers, listing and removing images, and the engine's info, and nothing else, so containers cannot be created and volumes and networks cannot be changed from here.</p>
      </Doc>
    </>
  ),
  images: (
    <>
      <Doc title="What it shows">
        <p><b>Images</b> lists every image Docker keeps, with its tags, the containers using it, its size and when it was built, and how much space unused images take. Search, or show only images in use or unused.</p>
      </Doc>
      <Doc title="One image">
        <p>Open an image for what it runs (entrypoint, command, working folder, user and exposed ports), its environment and labels, and the layers it was built from, each with the step that made it and its size.</p>
      </Doc>
      <Doc title="Deleting">
        <p>An image no container uses can be deleted from its menu or its page, or every unused one at once with <b>Delete unused</b>. Docker refuses to delete one a container still uses.</p>
      </Doc>
    </>
  ),
  git: (
    <>
      <Doc title="Repositories">
        <p><b>Git</b> keeps git repositories on this host for your codebases. The catalog shows each one's top language, its commits over the last six months and when it last changed; <b>Pin</b> keeps one at the top for you. A repository has <b>Code</b> (files on any branch, history, branches), <b>Pull Requests</b> (ask to merge one branch into another, talk it over, merge), <b>Issues</b> and <b>Settings</b>.</p>
      </Doc>
      <Doc title="Signing git in">
        <p>Git signs in with a token from <b>Tokens</b>, each person's own, shown once. When git asks, give any username and the token as the password. On this network git reaches Git at <code>/git/</code> on this dashboard's address; <b>Publish an address</b> to reach it from anywhere. That address is for git alone; a browser opening it finds nothing.</p>
      </Doc>
      <Doc title="Who may open what">
        <p>Who may view, push to, create or delete repositories is each account's Git permissions, under Security &amp; Roles, Users; git's token is held to them. A repository's <b>Home network only</b> switch, on its page, lets git reach it only from this host's network or a trusted one. A single push over 100 MB is refused by Cloudflare, so push a very large repository over this network the first time.</p>
      </Doc>
    </>
  ),
  storage: (
    <>
      <Doc title="Photos and videos">
        <p><b>Storage</b> keeps your files on this host, in myTunnels' own data folder rather than one you pick. Its <b>Photos and videos</b> tab shows them newest first, by month, like a photo library. Open one to see it full size and step through with the arrow keys; tick several to download, convert or delete them together. Uploads keep the date each was last changed on the device they came from.</p>
      </Doc>
      <Doc title="Files">
        <p>The <b>Files</b> tab keeps documents, spreadsheets, presentations and PDFs, in folders of your own. A chip for each kind shows only that kind. PDFs and text files open in a new tab; the rest download, to open in the app that made them.</p>
      </Doc>
      <Doc title="Convert">
        <p><b>Convert</b>, in a file's menu or for the photos and videos you tick, makes a copy in another format or smaller: photos as JPEG or WebP, videos as MP4 that every browser plays, PDFs compressed. The copy is saved beside the original with its date, and the original is never changed. Conversions run one at a time; a panel at the bottom right follows them.</p>
      </Doc>
      <Doc title="From anywhere">
        <p>Storage is part of this dashboard. Publish the dashboard through a tunnel, under <b>Runs on</b>, to reach it away from home.</p>
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
      <Doc title="This dashboard">
        <p>Pick <b>This dashboard</b> under <b>Runs on</b> to publish myTunnels itself, with no port, and manage it from anywhere. It takes the same access layers as any tunnel, and the dashboard's own sign-in, two-factor code included, still applies behind them.</p>
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
        <p>Users, under Security &amp; Roles, holds the accounts people sign in with. Each has a username, an optional email (either signs in), and a password held to the same rule as every password here.</p>
      </Doc>
      <Doc title="What an account opens">
        <p>On an account's <b>Profile</b>, <b>Tunnels</b> holds the tunnels it may open, and <b>Security</b> the devices it signs in from. One sign-in covers every tunnel on the same domain that the account may open. Suspending an account, or removing it, ends its sessions at once.</p>
      </Doc>
      <Doc title="Permissions">
        <p>On an account's <b>Permissions</b>, a card per feature says what it may do. <b>Sign in to the dashboard</b> lets it in here with its own password; then it sees only the pages and actions the rest allow, such as viewing containers, approving devices, or creating repositories. <b>Admin</b> holds them all, including making others admins; the host account made at setup always does. Anyone who manages accounts can give only permissions they hold, and cannot change their own.</p>
      </Doc>
    </>
  ),
  oauth: (
    <>
      <Doc title="Other ways to sign in">
        <p>Tunnels with Sign-in on can also offer <b>Continue with</b> GitHub, Google, GitLab, Discord, Slack or Codeberg; a self-hosted Authentik, Authelia, Keycloak, Pocket ID, Zitadel, Kanidm, Gitea or Forgejo; Auth0 or Okta; or any other OpenID Connect provider. Self-hosted and tenant providers also take their issuer URL. Each is set up once under <b>Advanced, Third-Party OAuth</b>: register an app with the provider and paste its client ID and secret back. Then each tunnel switches on the ones it offers, under Access Control.</p>
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
      <Doc title="SMTP">
        <p>Codes are sent with SMTP credentials you enter under <b>Advanced, Two-Factor Auth</b>: host, port, security, username, password and from address, from Gmail (with an app password), Outlook or any other provider. Saving signs in with them to check them, and <b>Send a test</b> emails the host account.</p>
      </Doc>
      <Doc title="Where codes are asked">
        <p><b>Email codes</b> is one switch for every sign-in: the dashboard's and every tunnel with Sign-in on, each code sent to the account's email (the host account's for the host). Turning it on sends a test email first, so credentials that do not deliver cannot lock you out, and codes stop on their own if SMTP is removed. This covers sign-ins through a third-party provider as well.</p>
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
