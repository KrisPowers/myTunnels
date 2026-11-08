# myTunnels

A self-hosted gateway for publishing homelab apps through Cloudflare Tunnel. Pick a local
port, type a subdomain, choose one of your domains, and the app is reachable at
`https://<subdomain>.<domain>` without opening a single port on your router. Every request
passes through an access gateway that can require the visitor to be on your home network,
to know the tunnel's password, to sign in with an account, or any mix of those.

## How it works

```text
browser ──https──> Cloudflare edge ──tunnel──> cloudflared ──> gateway ──> 127.0.0.1:8080
                                                 (inside this container)     (your app)
```

- One container runs the admin panel, the gateway, and a supervised `cloudflared` connector.
- The tunnel is created and configured through the Cloudflare API. Adding a tunnel in the
  panel creates the proxied DNS record and the ingress rule. Removing it deletes both.
- `cloudflared` sends every published hostname to the gateway. The gateway looks up the
  tunnel by hostname, applies its access rules, then forwards the request (WebSockets
  included) to the local port.
- The gateway only listens on the container's loopback interface, so nothing reaches it
  except through Cloudflare.

## Quick start

```sh
docker compose up -d --build
```

On the computer running it, open `http://localhost:7070`. The panel answers there alone:
every other device, at home or away, reaches myTunnels through a tunnel, so no port is opened
on your network. Until everything is in place the panel is a short setup, one
step at a time, each saved as soon as it is done, so it can be left and resumed:

1. **Admin account.** An email, a username and a password for the panel. Either the email
   or the username signs in, and both can be changed under **Settings, Account**.
2. **Cloudflare.** **Open Cloudflare** goes to the token page with the permissions already
   picked (Account, Cloudflare Tunnel, Edit; Zone, DNS, Edit; Zone, Zone, Read). Create the
   token, paste it back, and the tunnel is created and the connector started. A token that
   sees more than one account asks which one.
3. **Network.** Where your apps run and what counts as the home network. The defaults suit
   most setups.
4. **Ready.** A summary, the connector coming online, and the theme.

Then, on **Containers**, open a container, and on its **Tunnel** page press the plus: type the
subdomain, pick the domain, choose who can open it and press **Publish**. The plus at the top of
Containers publishes any other port the same way.

To manage myTunnels from anywhere, publish the dashboard itself: under **Local app**, set
**Runs on** to **This dashboard**, with no port. It takes the same access rules as any
tunnel, and the dashboard's own sign-in (and emailed code, when on) still applies behind them.

## Dashboard

**Dashboard** reads out the host and its containers, every two seconds, with the last five
minutes drawn as charts:

- **CPU**, overall and per logical processor, with each core's clock and temperature.
- **Memory**, **network** traffic and the processor's **temperature** over time.
- **Disks**, how full each one is, and every **temperature sensor** the host exposes.
- **Containers**, each one's CPU, memory, network and disk traffic, and its state.

On a Linux host, processors, memory and temperatures are the host's own. Docker Desktop
runs containers in a virtual machine, so from inside one they are that machine's. To show
the computer's own, run `server host` on it (from `server/`, `cargo run --release -- host`):
it answers on `127.0.0.1:7092` alone, and the Dashboard reads it through `HOST_URL` in
`compose.yaml`, falling back to its own figures while it is not running. Network traffic is
what passes through myTunnels, or the computer's while `server host` runs. Containers come from the Docker API through the
`docker` service in `compose.yaml`, which allows containers and nothing else.
Temperatures need sensors the host exposes under `/sys/class/hwmon`, which a Linux host
does and Docker Desktop does not.

## Containers

**Containers** is one catalog of everything published here: every container, and every tunnel to
a port elsewhere, such as another machine or the dashboard, which is a container of another
kind. It says how many containers run, their CPU and memory together, and how many tunnels are
live, then a row each: what it is (a container Docker runs, one built from Git, one run from an
image, or a tunnel) in a tile tinted by its state, its name over where it comes from, its
address, and its CPU and memory while it runs. Each row has one menu: logs, its tunnel, start or
stop, restart, kill and delete. Compose projects with more than one container fold under their
name, with start, stop and restart for all of them. Search, or pick **All** or **Running**; the
catalog refreshes on its own.

The plus at the top, here and in the header, adds anything: a **Tunnel** to any port, or a
**Container from Git**, **from GitHub** or **from an image**. The menu beside it deletes every
image no container uses.

A container and its tunnel are one page. Its heading holds its state, image and address,
**Open**, the one button its state calls for (start, stop or resume), and a menu for restart,
pause, kill and delete. Under it:

- **Overview**: its CPU over time, memory, network and disk while it runs, then what it runs,
  its state and restarts, its ports, networks and mounts.
- **Tunnel**: its addresses in the middle, each with its state, where it goes and who can open
  it, and the picked one's activity under them. Its controls sit at the side: Open, its live
  switch, a menu to change the address or remove it, and its access control.
  The plus publishes an address: type the subdomain, pick the domain, choose who can open it
  and press **Publish**; the port is the container's own, asked only when it has more than one.
- **Images**: the image it runs and the others of the same name, such as earlier versions, with
  their size and age. Open one for its entrypoint, command, working folder, user, exposed ports,
  environment, labels and layers. One no container uses can be deleted.
- **Logs**: followed as it runs, searchable, with or without times.
- **Resources**: its CPU limit and priority, its memory limit, reserved memory and swap, how
  many processes it may run, and its **Auto-start**: off, when it fails, unless stopped by
  hand, or always. The last two bring it back after a crash or a restart of the machine,
  as soon as Docker is running again. Each change applies at once, without a
  restart, and is kept by the container's name, so it is given back when the container is
  made again by Compose or a new build. The Dashboard shows each container against its limits.

### From a repository or an image

**Container from Git** and **Container from GitHub**, under the plus, make a container from
code: pick a repository on this host's **Git**, or give any https address (GitHub and the like,
with a token for a private one), then its branch, its name and how it updates:

- **When the branch changes**: each new commit is built as it arrives. A repository here is
  looked at every 30 seconds, one at another address every minute.
- **On a timer**: every hour to every week, the latest commit is built when there is one.
- **Only when I press Update**.

**Update**, in its heading, builds the branch's latest commit at any time. A build takes the
repository's Dockerfile (the one nearest the top, or the one named under **Settings**), builds
it into an image named after the container and the build's number (`web:12`), then makes the
container again from it. A build that will not start, or stops straight away, is undone on the
spot and the build before keeps running. Builds run one at a time.

Its **Images** page lists its builds: each one's commit, why it ran, when and how long it took,
and how it went, the one running marked. Open one for everything the build printed, followed as
it runs. **Run this build** goes back to any earlier build whose image is kept; the latest ten
are.

Its **Settings** page holds the repository and branch, the Dockerfile, how it updates, and how
it runs: its port (the one its image exposes, unless given), its environment, and the folders
kept from one build to the next. The folders its image declares are always kept, each in a
volume named after the container and the folder (`web_data` for `/data`). Changing how it runs
makes the running build again with it. Tokens and the environment are sealed in the database.

**Container from an image** runs a Docker image, such as `nginx:1.27`. Its updates pull the image
again, **On a timer** or when **Update** is pressed, and run it when it changed; each pull is a
build of its own, so going back works the same way.

A container made here joins myTunnels' own network and publishes no port, so only its tunnel
reaches it. Deleting it takes away its container, its images and its copy of the repository;
its volumes stay.

A tunnel reaches a container when it points at a port the container publishes on the host, or at
the container by name on a shared network, and opens on that container's page. The container
myTunnels runs in is marked, cannot be stopped or deleted from here, and asks once more before a
restart.

The `docker` service in `compose.yaml` allows only the calls the panel makes, by method and
path: listing, inspecting, logs and stats, start, stop, restart, pause, resume and kill, making
and removing a container; building an image from a container's repository; and listing,
inspecting and removing an image by its ID. Exec, pulling images on their own, volumes and
networks are refused, and only the gateway may connect to it.

Podman works too, through its Docker-compatible API: mount Podman's socket in place of
`/var/run/docker.sock` in the `docker` service.

## Git and Storage

**Storage** and **Git** are pages of their own in the sidebar.

### Git

**Git** keeps git repositories on this host, in `/data/repos`, for your codebases. The catalog
lists them pinned first, then by their latest change, each with its top language, a chart of
its commits over the last six months, when it last changed, and **Pin** to keep it at the top
for you. **New repository** makes an empty one, its first branch `main`.

A repository has four tabs:

- **Code**: its files on any branch or tag, picked from the branch menu, with the commit that
  last changed the folder, how many commits there are, and its README. **History** lists the
  commits by day with their IDs; open one for its changes. **Branches** shows how far each is
  ahead of and behind the default branch, and makes, deletes and opens pull requests for them.
- **Pull Requests**: ask to merge one branch into another, with its commits and changes shown
  first, then talk it over and **Merge**, which makes a merge commit when the branches do not
  conflict.
- **Issues**: bugs and work to do, with comments, closed and reopened as they go.
- **Settings**: the default branch, **Home network only**, and deleting the repository.

Git signs in with a token. Under **Tokens**, each person makes their own, and the host and admins (or an
account allowed to manage everyone's tokens) make them for others; a token is shown once, and
only its hash is kept. When git asks, give any username and the token as the password:

```sh
git clone https://git.example.com/myapp.git       # through the tunnel
git clone http://localhost:7070/git/myapp.git     # on this computer
```

On this computer, the panel takes git at `/git/` straight away. For any other device, **Publish an
address** gives Git a subdomain, `git` to start with. That address is for git alone: a browser
opening it finds nothing, and repositories are browsed here on the dashboard. Git signs in with
its token, held to the account's Git permissions (**View repositories** to clone, **Push and merge** to
push). A repository's **Home network only** switch, on its page, lets git reach it only from
this host's network or a trusted one.

Cloudflare refuses a single request over 100 MB, so the first push of a very large repository
goes from this computer, or in parts. Git needs `git`, which the image includes.

### Storage

**Storage** is a home cloud for your files, not tied to any folder you pick: everything uploaded is
kept by myTunnels under `/data`. It has two tabs.

- **Photos and videos** (`/data/media`) is laid out like a photo library: newest first, grouped by
  month, narrowed to photos or videos. Open one to see it full size, step through with the arrow
  keys, download or delete it. Tick several to download, convert or delete them together.
  **Upload**, or drag photos and videos onto the page; each keeps the date it was last changed on
  the device it came from, and the browser makes a small preview of it as it goes up.
- **Files** (`/data/drive`) keeps documents: Word and other text documents, spreadsheets,
  presentations and PDFs, in folders of your own. Each kind has its colour and a chip to show only
  that kind; files show as cards or as a list, by name or by when they last changed. PDFs and text
  files open in a new tab, the rest download. **New** makes a folder or uploads files, which can
  also be dragged onto the page; right-click an item to open, download, convert, rename or delete
  it. ZIP, 7z and RAR archives are kept too: **Extract here** opens one into a folder beside it
  (leaving out links and kinds Files does not keep, and refusing one that opens to over 100 GB),
  and **Compress to ZIP** packs a file or folder into a ZIP beside it. Archives are read with
  `unar`, which the image includes.

**Convert**, in an item's menu or for the photos and videos you tick, makes a copy in another
format or smaller:

- **Photos** become JPEG or WebP, at their own size or with the longest side 3840, 2560, 1920
  or 1280 pixels. HEIC and AVIF photos from phones are read with libheif, the rest with
  ImageMagick.
- **Videos** become MP4 (H.264 with AAC sound), which every browser plays, at their own size or
  4K, 1080p, 720p or 480p. They are made with ffmpeg.
- **PDFs** are compressed with Ghostscript.

**Remove background**, in a photo's menu, cuts the subject out on this server with rembg and its
`isnet-general-use` model, which the image fetches when it is built, so nothing is sent anywhere.
The result goes on a transparent PNG or on white as a JPEG, saved beside the photo as
`<name> (no background).png` or `<name> (white background).jpg`, in the same queue as conversions.

Each has **Best quality**, **Balanced** or **Smallest file**. The copy is saved beside the
original, named after it (`clip.mov` becomes `clip.mp4`, or `clip (2).mp4` when that is taken),
keeping its date and, for photos and videos, its preview; the original is never changed.
Conversions wait in a queue and run one at a time at low priority, so a long video does not slow
the gateway; a panel at the bottom right follows them, opens what is done and cancels what is not.

Converting needs, for a tab, the permissions to view it and to add to it (**Upload photos and
videos**, or **Upload and change documents**).

**Share link**, in an item's menu or for the photos and videos you tick, makes a link anyone can
open without an account: to a file, a folder, or a set of photos. It lasts a day, a week, a month
or until ended, and can ask for a password. Links open at the dashboard's tunnel address, under
`/share/`, past that tunnel's own access rules; each link is its own key, and its page shows only
what it shares. The link button at the top of Storage lists your links, how often each was opened,
and ends them. The dashboard must be published through a tunnel for links to work.

**Find duplicates**, at the top of Storage, lists every file kept more than once across both tabs,
by content, so a renamed copy counts too, with the space each copy frees. The oldest copy in each
set is kept unless you pick another, and the others can be deleted one set at a time or all at once.

Each tab takes only its own kinds of file. Storage is in the dashboard alone, so publish the
dashboard through a tunnel to reach it from anywhere.

## Apps

**Apps** is a catalog of the software a homelab or engineering machine usually needs, a tile
each by kind: Docker, kubectl, minikube and Helm; cloudflared, Cloudflare WARP and Wrangler;
Git and the GitHub CLI; Rust, Go, Python, Java and .NET; Node.js, fnm, Bun and Deno;
Terraform and WireGuard. **Install** offers two places:

- **On the host**, in one click, through its package manager: winget on Windows, Homebrew on
  macOS, apt on Linux (with `sudo` that needs no password). It takes the **Install apps on the
  host** permission, and Windows may ask to allow some installers.
- **On this device**, the command for the visitor's own machine and a link to the makers'
  download.

When myTunnels runs inside Docker, installs reach the host through `server host` on it (see
the Dashboard). It pairs with the first myTunnels to ask and installs only for that one; to
pair again, remove the `paired` file in its data folder (`%LOCALAPPDATA%\myTunnels` on
Windows, `~/.local/share/myTunnels` elsewhere).

Features that need an app where myTunnels runs keep working without it and say which to
install: Containers need Docker, tunnels need cloudflared, and Git and containers from a
repository need Git.

### Device Controller

**Device Controller** lists every fan the host's chips report, each spinning as fast as it
turns, with its speed in RPM. Drag a fan's slider to set its speed by hand, or switch **Auto**
on to hand it back to the firmware. Fans are the kernel's hwmon files under
`/sys/class/hwmon`; setting them takes root, so the `hardware` service in `compose.yaml` does
it: the same program as `server hardware`, with the host's `/sys` mounted, every capability
dropped, answering the gateway alone. Docker Desktop runs containers in a virtual machine,
which has no fans to show.

## Accounts and permissions

**Users**, a tab of **Security & Roles** in the sidebar beside **Devices**, **Two-Factor Auth**
and **Third-Party OAuth**, holds the accounts people sign in with,
yours among them: the account made at setup, with its email, username and password, holds the
**Host** and **Admin** roles. Only the host changes the host account, under **Settings,
Account**, and it cannot be suspended or removed. Open any other to set it up:

- **Permissions**, a card per feature: **Sign in to the dashboard**, then what it may do there,
  such as viewing containers or starting and stopping them, publishing, changing or removing
  tunnels, naming devices, managing accounts, viewing, pushing to, creating and deleting
  repositories in Git, opening issues and pull requests, uploading and deleting in Storage, and the settings pages.
- **Profile**: its details; **Security**, with its password, status, **Device lock** and the
  devices it signs in from; and **Tunnels**, the tunnels it may open, added with **+** and
  removed with each one's **x**. **Suspend** in the menu stops it signing in anywhere until
  reinstated.

Every device an account signs in from is added to it. A sign-in from a device new to an
account that already has others shows under **New devices** on the Dashboard until it is
dismissed. With **Device lock** on, the account signs in only from its own devices; one with
none yet takes the first device that signs in.

An account with **Sign in to the dashboard** signs in there with its email or username and its
own password (and an emailed code, when the dashboard asks for one), and sees only the pages
and actions its permissions allow; the server checks every call the same way. **Admin** is a role
any account can be given: it holds every permission, including making others admins. **Host**
is the role of the account made at setup, which holds Admin too. Anyone who manages accounts can give or take only permissions they hold
themselves, cannot change their own, and cannot change an account that can do more than they
can.

## Access rules

Each tunnel can require nothing, or any combination of:

| Rule | Passes when |
| --- | --- |
| Same network as this host | The visitor's public address (as reported by Cloudflare) is this host's public IPv4 address, inside this host's IPv6 /64, or inside a network listed under **Settings, Network** |
| Tunnel password | The visitor entered this tunnel's own password |
| Sign-in | The visitor signed in with an account from **Users** that may open this tunnel |

With more than one rule on, choose **Require all** or **Any one is enough**. Either way the
app's own login still applies; the gateway is an extra layer in front of it.

### Device keys

Every browser is given a 256 character letter and number key the first time it opens a
tunnel, kept only in a cookie that page scripts cannot read, so the app behind the tunnel
never sees it. The key is never stored on the server, only its SHA-256 hash. Each tunnel
keeps it in a cookie for its own address alone, never one for the whole domain, so other
servers on the domain never receive it. A browser is still one device everywhere: a tunnel
it has not opened yet fetches its key from the oldest tunnel with a one-use code, and the
dashboard's own browser carries its key to every tunnel once. A key no device has any more
is replaced. One sign-in covers every tunnel the account may open, on that device.

**Security & Roles, Devices** lists them: **Linked**, the devices accounts sign in from, with
what each browser reported when it signed in (platform, GPU, CPU threads, memory, screen,
time zone, languages, user agent) and where it connected from; and **Other**, the rest.

## Third-party sign-in

Tunnels with sign-in on can also offer **Continue with** GitHub, Google, GitLab, Discord,
Slack or Codeberg; a self-hosted Authentik, Authelia, Keycloak, Pocket ID, Zitadel, Kanidm,
Gitea or Forgejo; Auth0 or Okta; or any other OpenID Connect provider. Set each up
once under **Security & Roles, Third-Party OAuth** the way Cloudflare was set up: **Open GitHub** (or
the provider's console), register an app, then paste its client ID and secret back. Each
tunnel then switches on the providers it offers, under **Access Control**.

The provider vouches for an email, and the account under **Users** with that email signs
in, held to the same rules as a password sign-in: it must be on, allowed on the tunnel,
and on a linked device. Only an email the provider marks as verified counts. A provider sends the visitor back to the tunnel they signed in at,
`https://<tunnel>/__gate/oauth-callback`, which the tunnel shows once the provider is on
there. GitHub's one callback URL covers a whole domain, so `https://example.com` covers
every tunnel on it.

## Two-factor sign-in

Under **Security & Roles, Two-Factor Auth**, enter SMTP credentials from any provider, Gmail (with an app
password), Outlook or your own: host, port, STARTTLS or TLS, username, password and from
address. Saving checks them, and **Send a test** emails the host account. Then a six digit code,
good once for ten minutes, is asked for after the password once **Email codes** is on. One
switch covers every sign-in: the dashboard's (sent to the host account's email, or the account's own)
and every tunnel with sign-in, including sign-ins through a third-party provider. Turning it on
sends a test email first, and codes stop on their own if SMTP is removed.

An authenticator app needs no email. Under **Settings, Account**, **Set up** shows a QR code for
an app such as Aegis, 2FAS or Google Authenticator; enter its first code and ten recovery codes
are shown once. From then on every sign-in to that account, on the dashboard and at tunnels,
asks for a code from the app (each works once) or a recovery code, in place of an emailed one.
**Turn off** takes a code too.

Passkeys sign in with a fingerprint, face or security key instead of a password and code.
Add one under **Settings, Account** for the address the panel is open at, or at an app: after a
password sign-in the app offers to add one (any time at `https://<app>/__gate/account`). A
passkey added at an app works on every app on the same domain. **Sign in with a passkey**
then appears on the sign-in pages, still held to the account's apps and linked devices.

## Configuration

Settings made in the panel are stored in `/data/gateway.db`. The container reads these
environment variables:

| Variable | Default in the image | Meaning |
| --- | --- | --- |
| `ADMIN_ADDR` | `0.0.0.0:7070` | Admin panel address in the container; `compose.yaml` publishes it on `127.0.0.1` only |
| `GATE_ADDR` | `127.0.0.1:7080` | Gateway address, reached only by cloudflared |
| `UPSTREAM_HOST` | `host.docker.internal` | Default host for tunnel ports, changeable in Settings |
| `DATA_DIR` | `/data` | Database location |
| `SECRET_KEY_FILE` | `/keys/secret.key` | Key that seals secrets in the database, made on first start |
| `SECRET_KEY` | none | The same key as 64 hex digits, in place of the file |
| `DOCKER_HOST` | `tcp://docker:2375` in `compose.yaml` | Docker API the Dashboard reads containers from (`unix://`, `npipe://` or `tcp://`) |
| `HARDWARE_URL` | `http://hardware:7090` in `compose.yaml` | Device Controller's `hardware` service |
| `RUST_LOG` | `info` | Log level |

`compose.yaml` maps `host.docker.internal` to the Docker host, so a port published by any
container (or any program) on the host works as a target. A tunnel can also point at
another host, such as a container name on a shared network or another machine on the LAN,
under **Show target options**.

## Security

Nothing here needs setting up; all of it is on from the first start.

- Sessions (admin, tunnel password, account) are signed tokens (JWT, HS256).
  The signing key is made on first start and kept in the database, so sessions
  survive restarts. Signing out, signing an account out everywhere, removing a device
  or account, and changing a password all end the sessions they cover for good.
- Every browser gets a device ID on its first visit, and the gateway's limits count
  per device ID as well as per address: 1200 requests and 20 key, password or
  sign-in steps a minute. One address gets at most 10 new device IDs an hour.
- Password and sign-in attempts need a device ID and a solved puzzle that grows harder
  after each wrong try. Three wrong tries lock that device, that address and, for
  accounts, that email out for 30 minutes, except on the account's own devices, so its
  owner is never locked out by someone else's tries. Ten wrong tries on an account in a
  day hold it to its own devices for a day. A device or address that fails on three
  different accounts in a day, or an address with twenty wrong tries in a day, is
  refused for a day. An emailed or app code allows three tries.
- The panel allows 600 calls and 10 sign-in attempts per address each minute.
- The panel refuses changes that do not carry the header it sends, so another site
  cannot act through a signed-in browser. It sends a strict Content Security Policy
  and refuses to be framed.
- Tunnels get HSTS, and the gateway's own cookies never reach the apps behind it.

## After a crash or a restart

Everything comes back on its own once Docker is running: myTunnels' own services restart
with Docker, the tunnel reconnects, every container with **Auto-start** set to unless
stopped by hand or always starts again, and each container's resources are given back.
Containers made from a repository or an image start that way by default. On Windows and
macOS, Docker Desktop runs only once someone signs in, so switch on **Start Docker Desktop
when you sign in** in its settings; `server host`, for the Dashboard's figures, needs the
same, from the Startup folder or a scheduled task.

## Notes

- The admin panel answers only on the computer running it, at `http://localhost:7070`. Every
  other device opens it through a tunnel; publish it only with access rules in front of it,
  such as sign-in.
- The same network check compares public addresses. Behind carrier grade NAT, other
  customers of your ISP can share your public IPv4 address, so prefer sign-in there.
- The Cloudflare and tunnel tokens, SMTP and OAuth credentials and the session signing key
  are sealed in the database with a key kept in the separate `keys` volume, so a copy of the
  data volume alone does not give them away. Keep both volumes; without the key, those
  secrets must be entered again.

## Development

```sh
node scripts/dev.mjs
```

The whole app on `http://localhost:7070`, live as you save, with no image build:

- A change under `server/` is rebuilt incrementally and swapped in while the old build keeps
  serving, then every open page reloads. Only the first run compiles the dependencies.
- A change under `ui/` shows straight away through hot reload. The dashboard through a tunnel serves a
  built copy that is rebuilt as you save, so there a change shows on the next reload.
- cloudflared runs under the server as it does in the container, so tunnels work too. It is
  used from `PATH`, or fetched once.

Dev data lives in `server/data`, apart from the container's volume. Stop the container
first, since both use port 7070.

## License

Apache 2.0, see [LICENSE](LICENSE).
