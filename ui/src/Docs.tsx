import type { ReactNode } from "react";
import type { IconName } from "./Icon";

// The sections, in the order the sidebar lists them.
export const DOCS: [string, string, IconName][] = [
  ["start", "Getting started", "info"],
  ["dashboard", "Dashboard", "dashboard"],
  ["containers", "Containers", "deployed_code"],
  ["automations", "Automations", "workflow"],
  ["forward", "Routes", "wifi_cog"],
  ["storage", "Storage", "cloud"],
  ["mail", "Mail", "mail"],
  ["access", "Access Control", "shield"],
  ["devices", "Devices", "devices"],
  ["users", "Users", "group"],
  ["oauth", "Third-Party OAuth", "key"],
  ["twofactor", "Two-Factor Auth", "lock"],
  ["apps", "Apps", "apps"],
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
  mail: (
    <>
      <Doc title="Your addresses">
        <p><b>Mail</b> is every address in one list: <b>mailboxes</b>, which have a password and keep their mail here, and <b>forwards</b>, which send an address's mail to a mailbox. Each row says how much a mailbox holds; its menu changes its password, turns mail apps off for it while its mail still arrives, or removes it with its mail.</p>
      </Doc>
      <Doc title="A new address">
        <p><b>New address</b> takes the address in full, on any domain the Cloudflare account holds, and whether it is a mailbox or an alias of one. The first address also asks how mail arrives, how mail apps connect and how mail leaves; after that, mail turns itself on for each new domain the first time an address is made there, and its records are written to its DNS. Leave the part before the @ empty on an alias to catch everything at the domain.</p>
      </Doc>
      <Doc title="How mail moves">
        <p>The dial opens <b>Mail settings</b>: how mail arrives (port 25 forwarded here, or Cloudflare Email Routing through the tunnel), how mail apps connect (IMAP 993 and SMTP 465 on your router, or Tailscale Funnel), how mail leaves (straight to each recipient, through a relay, or Cloudflare Email Sending), where mail apps sign in, and the switches for incoming mail. The clock opens <b>Activity</b>, what came in and went out.</p>
      </Doc>
    </>
  ),
  start: (
    <>
      <Doc title="What it does">
        <p>myTunnels is your own cloud, on this computer. <b>Services</b> runs your apps, in containers or as they are, and puts them on the internet through Cloudflare Tunnel without opening a port on your router, or on your tailnet, or through a router port. Each gets an address such as <code>app1.example.com</code>, and every visit passes through myTunnels first, which can ask who the visitor is before the app loads. <b>Storage</b> keeps your files and <b>Mail</b> runs mail on your own domains, both reached from anywhere the same way.</p>
      </Doc>
      <Doc title="How a visit travels">
        <p>The browser reaches Cloudflare, which sends the visit down the tunnel to the connector running inside myTunnels. myTunnels checks the tunnel's access layers, then hands the request to the app on its local port. WebSockets work the same way.</p>
      </Doc>
      <Doc title="Setting it up">
        <p>On Windows, <b>setup.exe</b> installs everything from one file, with no internet needed for myTunnels itself, and asks once for administrator rights for what you choose: the hardware sensors, the firewall for router ports, Docker and Tailscale. Then the dashboard asks for two things: the host account, and <b>Connect Cloudflare</b>. <b>Open Cloudflare</b> makes a token with the right permissions; paste it back and the tunnel and connector are set up. <b>Skip for now</b> leaves it for later; anything that needs Cloudflare asks again, as does <b>Connect</b> under Settings, Connections. Once it is connected, every domain on the account is yours to use: for services' addresses and for mail, with nothing to add.</p>
      </Doc>
      <Doc title="On the rack and on your phone">
        <p>The monitor button in the header opens the <b>console</b>: one still frame that fills the screen and never scrolls, for a monitor beside this computer: CPU, memory and network over the last five minutes, the drives, the containers and what needs attention, under a slim bar with the time and the alerts; its close button goes back. On Windows the desktop app opens on it, and <b>F11</b> fills the screen. The bell beside it holds every alert in one list: failing parts and the system log's notes, the sensor task's setup, new devices signing in, and the Cloudflare connector going offline, each with its action where it has one. On a phone, add the dashboard's address to the home screen (on an iPhone, Safari's Share, then <b>Add to Home Screen</b>) and it opens full screen like an app.</p>
      </Doc>
      <Doc title="Changing the Cloudflare connection">
        <p>Settings, Connections holds the account and tunnel, and the connector's version and log. A new API token can replace the old one at any time. Switching to another account or tunnel needs every tunnel removed first, since their DNS records live in the old one.</p>
      </Doc>
    </>
  ),
  dashboard: (
    <>
      <Doc title="What it shows">
        <p><b>Dashboard</b> reads the host every two seconds and draws the last five minutes. It shows what any account can read: the host's facts, CPU per thread, memory with the sticks in each slot, network traffic, graphics cards, volumes and drives. <b>Advanced</b>, the button beside the computer's name that the host or an admin confirms once, adds the sensors: temperatures, fans, voltages and drive wear. On Windows these need administrator rights, which Windows asks for once; on Linux and macOS they need nothing more. A note from the system log, such as a restart without shutting down, has <b>Dismiss</b> beside it for the host or an admin, and comes back only if it happens again. Point at a chart to read any moment of it. Under Docker Desktop these are the figures of the machine Docker runs, unless <span className="mono">server host</span> runs on the computer itself.</p>
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
      <Doc title="The list">
        <p><b>Containers</b> is every container Docker runs here, one table: what it is and where it comes from, its status, the ports it publishes, and its CPU and memory while it runs. Compose projects with more than one container fold under a row of their own. Search, or show all, running or stopped. A row's menu starts, restarts, stops, opens its logs or deletes it; the menu at the top deletes every image no container uses.</p>
      </Doc>
      <Doc title="Adding one">
        <p><b>Add container</b> is one dialog: pick <b>Image</b> to run one such as <code>nginx:1.27</code>, <b>Folder</b> to build a folder on this computer with a Dockerfile into an image here and run it, as Docker Desktop does, or <b>GitHub</b> to build one from a repository and branch (a token for a private one). Name it and say how it updates; its first pull or build starts at once. How it keeps updating, and what each new build must pass, is its automation, on <b>Automations</b>.</p>
      </Doc>
      <Doc title="One container">
        <p>Its heading holds its state, health and source, the one button its state calls for (start, stop or resume) and a menu for the rest. Under it: <b>Overview</b> (its CPU, memory, network and disk while it runs, then what it runs, its state, ports, networks and mounts), <b>Images</b> (its builds or images, each one's log, and going back to one), <b>Logs</b>, <b>Resources</b> (CPU and memory limits, processes and <b>Auto-start</b>) and, when built from a repository, <b>Settings</b>. Exposing a container's port is a route, on <b>Routes</b>.</p>
      </Doc>
    </>
  ),
  automations: (
    <>
      <Doc title="What an automation is">
        <p>Each container added from GitHub or an image has one: what starts a new build, the build, the steps it must pass, then going live. <b>Automations</b> lists them, with how each starts, what its flow does and how its last run went; builds waiting for review sit at the top, with <b>Approve</b> and <b>Turn down</b>.</p>
      </Doc>
      <Doc title="What starts it">
        <p><b>On push</b> builds each new commit on the branch. <b>On release</b> builds each new GitHub release, at the commit its tag points to, looked for every five minutes. <b>On a timer</b> builds the latest commit, or pulls the image again, every so often. <b>By hand</b> waits for <b>Run now</b>.</p>
      </Doc>
      <Doc title="The flow">
        <p>An automation's <b>Flow</b> tab draws it as it runs. Between the build and going live, add as many steps as you like, in any order: a <b>Test</b> is a command run in the new image with the container's environment, such as <code>npm test</code>, which must exit 0, its output kept in the run's log; a <b>Review</b> holds the build until someone approves it. A build that fails a test, or is turned down, never runs, and the container stays as it was. Going live makes the container again from the new image; one that will not start is undone and the one before comes back.</p>
        <p><b>Runs</b> is every build with its reason, commit, status and log, and going back to an earlier one; <b>Settings</b> is the repository, branch, Dockerfile, port, environment and kept folders.</p>
      </Doc>
    </>
  ),
  apps: (
    <>
      <Doc title="The catalog">
        <p><b>Apps</b> is the software a homelab or engineering machine usually needs, in one place: Docker, Podman and Kubernetes' tools, cloudflared and Cloudflare's other tools, cloud CLIs, Tailscale, ngrok, WireGuard and web servers, Git and the GitHub and GitLab CLIs, languages such as Rust, Go, Python and PHP, runtimes such as Node.js, Bun and Ollama, infrastructure as code, password manager CLIs, file sync and FFmpeg, and editors. A tile each; search, and pick kinds and a status (installed, not installed, used by myTunnels), to narrow it.</p>
      </Doc>
      <Doc title="Installing">
        <p><b>Install</b> installs one in one click on the machine myTunnels runs on, through winget, Homebrew or apt, for accounts allowed to install apps; Windows may ask to allow some. An app already there says <b>Installed</b>; its menu updates or uninstalls it. The arrow beside the button lists its versions, newest first; pick one to install it, or to change to it.</p>
        <p>When myTunnels runs in Docker, that machine is reached through <span className="mono">server host</span> running on it. It pairs with the first myTunnels to ask and installs only for that one; to pair again, remove the <span className="mono">paired</span> file it names.</p>
      </Doc>
      <Doc title="What features need">
        <p>Containers need Docker, Tailscale routes need Tailscale, and containers from a repository need Git, where myTunnels runs; cloudflared comes with myTunnels. Without one, the feature stays and says which app to install; in New route, a way whose app is missing is listed but cannot be picked.</p>
      </Doc>
    </>
  ),
  storage: (
    <>
      <Doc title="One place">
        <p><b>Storage</b> keeps your files on this host, in myTunnels' own data folder rather than one you pick: documents, spreadsheets, presentations, PDFs, archives, photos and videos together, in folders of your own, each folder's files grouped by month, newest first. <b>Show</b> picks which kinds appear. Photos and videos are square pictures, like a photo library: open one to see it full size and step through with the arrow keys, or tick several to download, share, convert or delete them together. Shift and right-click any item to add it to the selection, again to take it out, and drag items onto a folder, or a folder in the path above, to move them there. PDFs and text files open in a new tab; the rest download, to open in the app that made them. Uploads keep the date each was last changed on the device they came from.</p>
      </Doc>
      <Doc title="Convert">
        <p><b>Convert</b>, in a file's menu, makes a copy in another format or smaller: photos as JPEG or WebP, videos as MP4 that every browser plays, PDFs compressed. The copy is saved beside the original with its date, and the original is never changed. Conversions run one at a time; a panel at the bottom right follows them.</p>
      </Doc>
      <Doc title="From anywhere">
        <p>Storage is part of this dashboard. Point a tunnel at <b>This dashboard</b>, under <b>Change where it goes</b> in its menu, to reach it away from home.</p>
      </Doc>
    </>
  ),
  forward: (
    <>
      <Doc title="A route exposes a port">
        <p>A route is one port on this computer, exposed. <b>Expose a port</b> asks, in order: the port; <b>Read &amp; write</b> or <b>Read only</b>; how it is exposed; and who gets in. <b>Routes</b> lists them by port, with where each is reached, whether it takes writes, who gets in and whether it is up.</p>
      </Doc>
      <Doc title="How it is exposed">
        <ul>
          <li><b>Port forward</b>: TCP, UDP or both. The port is opened on this computer, and the router is asked by UPnP to send the same port, or the one you give, here. It can close on its own after an hour, a day or a week.</li>
          <li><b>Tailscale</b>: on your tailnet at this computer's tailnet name, as http, https or TCP, or to anyone through Funnel on 443, 8443 or 10000.</li>
          <li><b>Cloudflare Tunnel</b>: an address on one of your domains, with no port opened on the router. Every request passes through myTunnels' gateway first.</li>
        </ul>
      </Doc>
      <Doc title="Who gets in">
        <p>Through a Cloudflare tunnel, all of it is in one place: a sign-in page for accounts from Users (with third-party providers and emailed codes), a password for the route, the home network, and <b>API keys</b> for programs. A client sends its key as <code>Authorization: Bearer</code>, as <code>X-API-Key</code>, or as <code>api_key</code> in a JSON or form body; the body goes on to the app as it came. A route's page makes and revokes keys; each key's text is shown once, when made. Turn on several and choose whether all are needed or any one is enough.</p>
        <p><b>Read only</b> lets reads through (GET, HEAD and OPTIONS) and refuses every write. A <b>rate limit</b> caps the requests each visitor makes a minute. Every key used or refused, every write refused and every visitor slowed down is in the route's activity, beside sign-ins and visits.</p>
        <p>A port forward and Tailscale reach the port directly, so anyone who reaches it gets in; sign-ins, keys, read-only and rate limits need a Cloudflare tunnel.</p>
      </Doc>
    </>
  ),
  access: (
    <>
      <Doc title="Layers">
        <p>Every layer is optional. With none on, anyone with the link reaches the app, and its own login still applies.</p>
        <ul className="bullets">
          <li><b>Same network as this host</b> lets in visitors coming from this computer's internet connection, or a network listed in Settings, Network.</li>
          <li><b>Tunnel password</b> asks for one password that belongs to this tunnel alone.</li>
          <li><b>Sign-in</b> asks for an account from Users that may open this tunnel.</li>
        </ul>
      </Doc>
      <Doc title="Combining layers">
        <p>With more than one layer on, choose <b>Require all</b> to need every one, or <b>Any one is enough</b> to let visitors use whichever they have. With any one, the page a visitor sees offers the other ways in.</p>
      </Doc>
      <Doc title="Keeping it safe">
        <p>Passwords are stored as Argon2 hashes, never as text. After three wrong tries from one place, or against one account, further tries are refused for 30 minutes; an account's own devices can still sign in. Ten wrong tries on an account in a day hold it to its own devices for a day, and a place that fails on three accounts in a day is refused for a day. Changing a tunnel password or an account's password signs out everyone using the old one.</p>
      </Doc>
    </>
  ),
  devices: (
    <>
      <Doc title="Device keys">
        <p>The first time a browser opens this dashboard or any tunnel, it is given a 256 character device key, kept in a cookie and in the browser's local storage. Tunnels on other domains fetch the same key from the oldest tunnel's address, so one browser is one device everywhere. Only a hash of the key is stored here.</p>
      </Doc>
      <Doc title="Linked and other">
        <p>Devices lists every browser met so far. <b>Linked</b> ones are those an account has signed in from, with what the browser reported when it signed in; <b>Other</b> ones have only visited. Name one to know it again, or forget it.</p>
      </Doc>
    </>
  ),
  users: (
    <>
      <Doc title="Accounts">
        <p>Users, under Security, holds the accounts people sign in with, yours among them: the account made at setup holds the <b>Host</b> and <b>Admin</b> roles, and only it changes itself, under Settings, Account. Each has a username, an email (either signs in), and a password held to the same rule as every password here.</p>
      </Doc>
      <Doc title="What an account opens">
        <p>On an account's <b>Profile</b>, <b>Tunnels</b> holds the tunnels it may open, and <b>Security</b> the devices it signs in from. Every device an account signs in from is added there, and a sign-in from one new to an account that already has others shows under <b>New devices</b> on the Dashboard until it is dismissed. With <b>Device lock</b> on, the account signs in only from those devices; with none yet, the first one to sign in becomes its own. One sign-in covers every tunnel on the same domain that the account may open. Suspending an account, or removing it, ends its sessions at once.</p>
      </Doc>
      <Doc title="Permissions">
        <p>On an account's <b>Permissions</b>, a card per feature says what it may do. <b>Sign in to the dashboard</b> lets it in here with its own password; then it sees only the pages and actions the rest allow, such as viewing containers, naming devices, or installing apps. <b>Admin</b> holds them all, including making others admins; the host account made at setup always does. Anyone who manages accounts can give only permissions they hold, and cannot change their own.</p>
      </Doc>
    </>
  ),
  oauth: (
    <>
      <Doc title="Other ways to sign in">
        <p>Tunnels with Sign-in on can also offer <b>Continue with</b> Google, Microsoft, Facebook, GitHub, Discord, LinkedIn, Slack or GitLab; a self-hosted Authentik or Keycloak; or any other OpenID Connect provider. Self-hosted providers also take their issuer URL. Each is set up once under <b>Security, Third-Party OAuth</b>: register an app with the provider and paste its client ID and secret back. Then each tunnel switches on the ones it offers, under Access Control.</p>
      </Doc>
      <Doc title="Who it lets in">
        <p>The provider vouches for an email. The account in Users with that email signs in, held to the same rules as signing in with its password: it must be on, may open the tunnel, and, with Device lock on, be on one of its own devices.</p>
      </Doc>
      <Doc title="The redirect URL">
        <p>A provider sends people back to the tunnel they signed in at, at <code>/__gate/oauth-callback</code>. Switching a provider on at a tunnel shows that URL to add to the provider's app. GitHub takes one callback URL that covers a whole domain, so registering <code>https://example.com</code> covers every tunnel on it.</p>
      </Doc>
    </>
  ),
  twofactor: (
    <>
      <Doc title="Emailed codes">
        <p>With Two-Factor Auth, signing in takes a code sent by email as well as the password. The code is six digits, works once, and lasts ten minutes; three wrong tries and it is gone, and signing in starts again.</p>
      </Doc>
      <Doc title="SMTP">
        <p>Codes are sent with SMTP credentials you enter under <b>Security, Two-Factor Auth</b>: host, port, security, username, password and from address, from Gmail (with an app password), Outlook or any other provider. Saving signs in with them to check them, and <b>Send a test</b> emails the host account.</p>
      </Doc>
      <Doc title="Where codes are asked">
        <p><b>Email codes</b> is one switch for every sign-in: the dashboard's and every tunnel with Sign-in on, each code sent to the account's email (the host account's for the host). Turning it on sends a test email first, so credentials that do not deliver cannot lock you out, and codes stop on their own if SMTP is removed. This covers sign-ins through a third-party provider as well.</p>
      </Doc>
    </>
  ),
  trouble: (
    <>
      <Doc title="Error 1033 from Cloudflare">
        <p>The connector is not running. Settings, Connections shows its log. It starts on its own once Cloudflare is connected.</p>
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
