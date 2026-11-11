import type { ReactNode } from "react";
import type { IconName } from "./Icon";

// The sections, in the order the sidebar lists them.
export const DOCS: [string, string, IconName][] = [
  ["start", "Getting started", "info"],
  ["dashboard", "Dashboard", "dashboard"],
  ["containers", "Containers", "deployed_code"],
  ["storage", "Storage", "cloud"],
  ["forward", "Forward", "swap_horiz"],
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
  start: (
    <>
      <Doc title="What it does">
        <p>myTunnels puts apps running on this computer on the internet through Cloudflare Tunnel, without opening a port on your router. Each app gets an address such as <code>app1.example.com</code>, and every visit passes through myTunnels first, which can ask who the visitor is before the app loads.</p>
      </Doc>
      <Doc title="How a visit travels">
        <p>The browser reaches Cloudflare, which sends the visit down the tunnel to the connector running inside myTunnels. myTunnels checks the tunnel's access layers, then hands the request to the app on its local port. WebSockets work the same way.</p>
      </Doc>
      <Doc title="Connecting Cloudflare">
        <p>Setup asks only for the host account. Cloudflare is connected the first time a tunnel needs it: picking <b>Tunnel</b> under <b>Forward by</b>, or <b>Connect</b> under Settings, Cloudflare, opens <b>Connect Cloudflare</b>, and it opens again each time until it is connected. <b>Open Cloudflare</b> makes a token with the right permissions; paste it back and the tunnel and connector are set up.</p>
      </Doc>
      <Doc title="Changing the Cloudflare connection">
        <p>Settings, Cloudflare holds the account and tunnel. A new API token can replace the old one at any time. Switching to another account or tunnel needs every tunnel removed first, since their DNS records live in the old one.</p>
      </Doc>
    </>
  ),
  dashboard: (
    <>
      <Doc title="What it shows">
        <p><b>Dashboard</b> reads the host every two seconds and draws the last five minutes. It shows what any account can read: the host's facts, CPU per thread, memory with the sticks in each slot, network traffic, graphics cards, volumes and drives. <b>Advanced</b>, the button beside the computer's name that the host or an admin confirms once, adds the sensors: temperatures, fans, voltages and drive wear. On Windows these need administrator rights, which Windows asks for once; on Linux and macOS they need nothing more. Point at a chart to read any moment of it. Under Docker Desktop these are the figures of the machine Docker runs, unless <span className="mono">server host</span> runs on the computer itself.</p>
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
        <p><b>Containers</b> is the catalog of containers, a row each with what it is in a tile tinted by its state, its name over where it comes from, its address, and its CPU and memory while it runs. Compose projects with more than one container fold under their name. Search, or pick <b>All</b> or <b>Running</b>; it refreshes on its own. The plus, here and in the header, adds a <b>Container from GitHub</b> or <b>from an image</b>, or a <b>Forward</b>.</p>
      </Doc>
      <Doc title="One container">
        <p>A container and its forwards are one page. Its heading holds its state, image and address, <b>Open</b>, the one button its state calls for (start, stop or resume) and a menu for the rest. Under it: <b>Overview</b> (its CPU, memory, network and disk while it runs, then what it runs, its state, ports, networks and mounts), <b>Forward</b>, <b>Images</b>, <b>Logs</b> and <b>Resources</b>: its CPU limit and priority, memory limit, reserved memory and swap, how many processes it may run and its <b>Auto-start</b>. Set to unless stopped by hand or always, it comes back on its own after a crash or a restart of the machine, once Docker runs again. A change applies at once and is given back when the container is made again.</p>
      </Doc>
      <Doc title="Its forwards">
        <p><b>Forward</b> lists every way the container is reached, a tunnel, a router port or Tailscale, each with its state, where it goes and who reaches it. A tunnel's activity sits under the list and its controls at the side: Open, its live switch, a menu to change the address or remove it, and its access control. The plus forwards a port the same way the Forward page does; the port is the container's own, asked only when it has more than one. A router or Tailscale forward reaches only a port the container publishes on this computer.</p>
      </Doc>
      <Doc title="From a repository">
        <p><b>Container from GitHub</b> makes a container from code: give any https address (GitHub and the like, with a token for a private one), then its branch, its name and how it updates: <b>When the branch changes</b>, <b>On a timer</b> (every hour to every week), or <b>Only when I press Update</b>. <b>Update</b>, in its heading, builds the latest commit at any time.</p>
        <p>A build takes the repository's Dockerfile, builds it into an image named after the container and the build's number, and makes the container again from it. One that will not start is undone on the spot and the build before keeps running. Its <b>Images</b> page lists its builds and what each printed; <b>Run this build</b> goes back to any of the latest ten. Its <b>Settings</b> page holds the repository, branch and Dockerfile, how it updates, its port, its environment and the folders kept from one build to the next.</p>
        <p><b>Container from an image</b> runs a Docker image, such as <code>nginx:1.27</code>. Its updates pull the image again, on a timer or with <b>Update</b>, and run it when it changed; each pull is listed like a build, so going back works the same way.</p>
      </Doc>
      <Doc title="Its images">
        <p><b>Images</b> lists the image the container runs and the others of the same name, such as earlier versions, with their size and age. Open one for what it runs, its environment and labels, and its layers. One no container uses can be deleted; the menu at the top of Containers deletes every unused image at once.</p>
      </Doc>
      <Doc title="Managing them">
        <p>Each row's menu holds logs, its forwards, start or stop, restart, kill and delete; a project's menu starts, stops or restarts all of it. Deleting takes a stopped container away and leaves its volumes. The container myTunnels runs in is marked and is never stopped from here.</p>
      </Doc>
      <Doc title="What Docker allows">
        <p>myTunnels reaches Docker through the <code>docker</code> service in <code>compose.yaml</code>, which allows containers, building images from a container's repository, listing and removing images, and the engine's info, and nothing else, so volumes and networks cannot be changed from here.</p>
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
        <p>Containers need Docker, tunnels need cloudflared, Tailscale forwards need Tailscale, and containers from a repository need Git, where myTunnels runs. Without one, the feature stays and says which app to install; on Forward, a way whose app is missing is listed but cannot be picked.</p>
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
  forward: (
    <>
      <Doc title="Three ways">
        <p><b>Forward</b> is every opening in one list: tunnels, router ports and Tailscale, a row each with its address, where it goes, who reaches it and whether it is open. Search, or show one way at a time. The plus, here and in the header, forwards a port; its first field, <b>Forward by</b>, picks the way:</p>
        <ul>
          <li><b>Tunnel</b> gives the app an address on your domain through Cloudflare Tunnel, without opening a port on the router, with the full Access Control below.</li>
          <li><b>Port forward</b> opens the port on this PC first: a rule in Windows Firewall, which Windows asks administrator rights for, and a relay when the app is on another port or another machine. Then it asks the router, by UPnP, to send the same port of your public address here. Most routers keep UPnP off; the row then says <b>Router not forwarded</b>, the port still reaches this PC from your network, and the router's own settings can forward it. There is no sign-in or password on either.</li>
          <li><b>Tailscale</b> serves the app to the devices on your tailnet, at this machine's tailnet name. <b>Open to the internet</b> serves it to anyone through Funnel, on port 443, 8443 or 10000.</li>
        </ul>
        <p>A way whose app is not installed, cloudflared or Tailscale, stays in the list but cannot be picked until it is installed from <a href="#/apps">Apps</a>.</p>
      </Doc>
      <Doc title="A new tunnel">
        <p>Pick <b>Tunnel</b>, type a subdomain, pick one of your domains, and enter the port the app listens on. Choose who can open it, then press <b>Publish</b>. The DNS record and the route are made for you, and removed with the tunnel.</p>
      </Doc>
      <Doc title="A router or Tailscale forward">
        <p>Pick <b>Port forward</b> or <b>Tailscale</b>, give it a name, which the list shows it by, then the port it is reached on, the app's port and its protocol: TCP, UDP or TCP & UDP at the router; http, https or TCP on Tailscale, where TCP carries anything else, such as SSH. The app runs on this computer or another machine on your network, by its IP address. <b>Close after</b> closes it on its own after an hour, a day or a week; it stays in the list switched off, and its menu opens it again. The router is asked again every twenty minutes, so a router that restarts, or has UPnP turned on later, gets it.</p>
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
