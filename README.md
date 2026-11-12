# myTunnels

A self-hosted gateway for publishing homelab apps through Cloudflare Tunnel. Pick a local
port, type a subdomain, choose one of your domains, and the app is reachable at
`https://<subdomain>.<domain>` without opening a single port on your router. Every request
passes through an access gateway that can require the visitor to be on your home network,
to know the tunnel's password, to sign in with an account, or any mix of those.

## How it works

```text
browser ──https──> Cloudflare edge ──tunnel──> cloudflared ──> gateway ──> 127.0.0.1:8080
                                                   (run by myTunnels)          (your app)
```

- One program runs the admin panel, the gateway, and a supervised `cloudflared` connector.
- The tunnel is created and configured through the Cloudflare API. Adding a tunnel in the
  panel creates the proxied DNS record and the ingress rule. Removing it deletes both.
- `cloudflared` sends every published hostname to the gateway. The gateway looks up the
  tunnel by hostname, applies its access rules, then forwards the request (WebSockets
  included) to the local port.
- The gateway only listens on the loopback interface, so nothing reaches it except through
  Cloudflare.

## Quick start

Install it, with nothing else needed first. cloudflared comes with it. The repository is
private, so each way signs in with [GitHub CLI](https://cli.github.com/) (`gh auth login`, and
`gh auth setup-git` for Homebrew's tap) as an account that can see it.

Windows, in PowerShell:

```powershell
irm https://api.github.com/repos/KrisPowers/myTunnels/contents/scripts/install.ps1 -Headers @{ Authorization = "Bearer $(gh auth token)"; Accept = 'application/vnd.github.raw' } | iex
```

macOS or Linux:

```sh
curl -fsSL -H "Authorization: Bearer $(gh auth token)" -H "Accept: application/vnd.github.raw" https://api.github.com/repos/KrisPowers/myTunnels/contents/scripts/install.sh | sh
```

Homebrew:

```sh
brew tap krispowers/mytunnels https://github.com/KrisPowers/myTunnels
brew install mytunnels
```

Releases are built by `pwsh scripts/build.ps1 -Publish`, which builds what the computer it
runs on can (Windows on Windows, macOS on a Mac, and with zig installed Linux and macOS from
anywhere, against Apple's SDK fetched once into `builds/.sdk`), releases it and points the
formula in `Formula/` at it. Without `-Publish` it only builds, into `builds/`.

Then start it, once:

```sh
mytunnels start
```

From then on it starts with the computer and comes back on its own whenever it stops. Running
an install again updates it, and starts the new version when the old one was running. When a
newer release is out, **Update Available** shows at the foot of the sidebar for the host and
admins; it runs the same install, signed in to GitHub with `gh`, and reloads the panel on the
new version.

| Command | Does |
| --- | --- |
| `mytunnels start` | Runs it now and every time the computer starts |
| `mytunnels stop` | Stops it, and it no longer starts with the computer |
| `mytunnels status` | Says whether it is running, and where |

On Linux it is a systemd user service that runs from boot; on macOS a launchd agent and on
Windows a program run at sign-in, each started again within seconds if it stops. Its data
is in `%LOCALAPPDATA%\myTunnels` on Windows and `~/.local/share/myTunnels` elsewhere. To run
it in Docker instead, see [Running in Docker](#running-in-docker).

On the computer running it, open `http://localhost:7070`. The panel answers there alone:
every other device, at home or away, reaches myTunnels through a tunnel, so no port is opened
on your network. Setup asks only for the host account: an email, a username and a password
for the panel. Either the email or the username signs in, and both can be changed under
**Settings, Account**.

Cloudflare is connected the first time something needs it: picking **Tunnel** in
**New route**, or **Connect** under **Settings, Cloudflare**. It asks again each time until it
is connected. **Open Cloudflare** goes to the token page with the permissions already picked
(Account, Cloudflare Tunnel, Edit; Zone, DNS, Edit; Zone, Zone, Read). Create the token, paste
it back, and the tunnel is created and the connector started. A token that sees more than one
account asks which one.

Then, on **Containers**, open a container, and on its **Routes** page press the plus: keep
**Tunnel** at the top, type the subdomain, pick the domain, choose who can open it and
press **Publish**. The plus on **Routes** opens any other port the same way.

To manage myTunnels from anywhere, publish the dashboard itself: under **Local app**, set
**Runs on** to **This dashboard**, with no port. It takes the same access rules as any
tunnel, and the dashboard's own sign-in (and emailed code, when on) still applies behind them.

## Dashboard

**Dashboard** is the host at a glance, read every two seconds, with the last five minutes
drawn as charts: its facts in a column on the left, under each memory slot, drive and
graphics card by a dot lit by its health, and the chart and tables on the right. It
shows what any account can read from the system:

- The machine: its name, platform, kernel, processor, cores, memory, board and uptime, as
  the system itself reports them, never Docker's virtual machine.
- **CPU** over time and per thread, **memory** over time with the sticks in the board's
  slots, and **network** traffic in and out. A stick that stops being detected stays listed
  in red until it is marked as taken out; one running below its rated speed turns yellow.
- **Graphics**: NVIDIA cards' temperature, load, fan, power and video memory through
  `nvidia-smi`, other cards by their state.
- On a Mac, the parts come from `system_profiler`: the memory (built into the chip on Apple
  silicon), the drives with their SMART status, the graphics, and the battery's health.
- **Volumes**, how full each one is, and the **drives** with their health.

**Advanced**, the button beside the computer's name that the host or an admin confirms once, adds the sensors: the processor's temperature over time and per core, every
temperature read, the **fans** (a fan that spun before and reads 0 has stopped), the power
supply's 12, 5 and 3.3 V rails (within 5% is healthy, past 10% is failing), and each drive's
temperature, life left, errors and hours. On Linux these come from `/sys` and need nothing
more; drive wear and errors there need root and are not shown. On a Mac they are every
temperature the system reports, which needs nothing more; its fans and rails are not
shown. On Windows they need
administrator rights, so turning it on asks Windows once, then installs the
[PawnIO](https://pawnio.eu) driver, puts
[LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor)'s
library in `Program Files\myTunnels\hardware` (both downloads pinned by checksum) and adds a
`myTunnels Hardware` task that reads the sensors as SYSTEM from startup. Turning
**Advanced** off removes the task and those files; PawnIO stays installed.

When a part has been failing, or healthy again, for 15 seconds, the host and every admin
get an email, once SMTP is set up under **Security**, **Two-Factor Auth**.

Installed, every figure is the computer's own. The rest of this paragraph is about running in Docker. On a Linux host,
processors, memory and temperatures are the host's own. Docker Desktop
runs containers in a virtual machine, so from inside one they are that machine's. To show
the computer's own, run `server host` on it (from `server/`, `cargo run --release -- host`):
it answers on `127.0.0.1:7094` alone, and the Dashboard reads it through `HOST_URL` in
`compose.yaml`, falling back to its own figures while it is not running. Network traffic is
what passes through myTunnels, or the computer's while `server host` runs.
Temperatures need sensors the host exposes under `/sys/class/hwmon`, which a Linux host
does and Docker Desktop does not.

## Routes

**Routes** is every opening in one list: Cloudflare tunnels, router port forwards and
Tailscale, a row each with its address, where it goes, who reaches it and whether it is open.
The plus opens **New route**, whose switch at the top picks the way:

- **Tunnel**: an address on your domain through Cloudflare Tunnel, with no port opened on the
  router, behind the tunnel's Access Control (home network, a tunnel password, sign-in).
- **Port forward**: opens the port on this PC (a Windows Firewall rule, which asks for
  administrator rights, and a relay when the app is on another port or machine), then asks the
  router by UPnP to send the same port here. Most routers keep UPnP off; the row then says
  **Router not forwarded**, and the router's own settings can forward it. Neither has a sign-in
  or password.
- **Tailscale**: `tailscale serve` puts the app on your tailnet at this machine's tailnet name;
  **Open to the internet** uses Funnel instead, on port 443, 8443 or 10000.

Router and Tailscale forwards can **Close after** an hour, a day or a week, and stay in the list
switched off. A way whose app is missing (cloudflared, Tailscale) is listed but cannot be picked
until it is installed from **Apps**.

## Containers

**Containers** is the catalog of containers. It says how many run and their CPU and memory
together, then a row each: what it is (a container Docker runs, one built from Git, or one run
from an image) in a tile tinted by its state, its name over where it comes from, its address,
and its CPU and memory while it runs. Each row has one menu: logs, its forwards, start or
stop, restart, kill and delete. Compose projects with more than one container fold under their
name, with start, stop and restart for all of them. Search, or pick **All** or **Running**; the
catalog refreshes on its own.

The plus at the top, here and in the header, adds a **Container from Git**, **from GitHub** or
**from an image**, or a **Route**. The menu beside it deletes every
image no container uses.

A container and its forwards are one page. Its heading holds its state, image and address,
**Open**, the one button its state calls for (start, stop or resume), and a menu for restart,
pause, kill and delete. Under it:

- **Overview**: its CPU over time, memory, network and disk while it runs, then what it runs,
  its state and restarts, its ports, networks and mounts.
- **Routes**: every way it is reached, a tunnel, a router port or Tailscale, each with its
  state, where it goes and who reaches it, and the picked tunnel's activity under them. That
  tunnel's controls sit at the side: Open, its live switch, a menu to change the address or
  remove it, and its access control. The plus forwards a port as Routes does; the
  port is the container's own, asked only when it has more than one.
- **Images**: the image it runs and the others of the same name, such as earlier versions, with
  their size and age. Open one for its entrypoint, command, working folder, user, exposed ports,
  environment, labels and layers. One no container uses can be deleted.
- **Logs**: followed as it runs, searchable, with or without times.
- **Resources**: its CPU limit and priority, its memory limit, reserved memory and swap, how
  many processes it may run, and its **Auto-start**: off, when it fails, unless stopped by
  hand, or always. The last two bring it back after a crash or a restart of the machine,
  as soon as Docker is running again. Each change applies at once, without a
  restart, and is kept by the container's name, so it is given back when the container is
  made again by Compose or a new build.

### From a repository or an image

**Container from GitHub**, under the plus, makes a container from code: give any https address
(GitHub and the like, with a token for a private one), then its branch, its name and how it
updates:

- **When the branch changes**: each new commit is built as it arrives; the address is looked
  at every minute.
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

## Storage

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
each, narrowed by a search and by kind and status (installed, not installed, used by myTunnels):
Docker, Podman, kubectl, minikube, kind, k9s, Helm and Argo CD; cloudflared, Cloudflare
WARP and Wrangler; the Google Cloud, DigitalOcean, Vercel and Netlify CLIs; Tailscale, ngrok,
WireGuard, Caddy and nginx; Git, Git LFS and the GitHub and GitLab CLIs; Rust, Go, Python,
Java, .NET, PHP, Ruby, Zig and CMake; Node.js, fnm, Bun, Deno, pnpm, Yarn, uv and Ollama;
Terraform, OpenTofu, Pulumi, Ansible, Packer and Vagrant; Vault and the Bitwarden and
1Password CLIs; rclone, Syncthing and FFmpeg; Neovim and VSCodium.

**Install** installs one in one click on the machine myTunnels runs on, through its package
manager: winget on Windows, Homebrew on macOS, apt on Linux (with `sudo` that needs no
password). It takes the **Install apps** permission, and Windows may ask to allow some
installers. An app already there says **Installed**, and its menu updates or uninstalls it.
The arrow beside the button lists the app's versions, newest first, a page at a time as the
list scrolls: pick one to install it, or to change to it from the one there. winget and npm
offer every version, apt what its sources carry, and Homebrew only its latest.

When myTunnels runs inside Docker, installs reach that machine through `server host` on it (see
the Dashboard). It pairs with the first myTunnels to ask and installs only for that one; to
pair again, remove the `paired` file in its data folder (`%LOCALAPPDATA%\myTunnels` on
Windows, `~/.local/share/myTunnels` elsewhere).

Features that need an app where myTunnels runs keep working without it and say which to
install: Containers need Docker, tunnels need cloudflared (which an install brings),
containers from a repository need Git, and an install's Convert needs FFmpeg, ImageMagick,
libheif, Ghostscript and unar, which the Docker image carries.

## Accounts and permissions

**Users**, a tab of **Security** in the sidebar beside **Devices**, **Two-Factor Auth**
and **Third-Party OAuth**, holds the accounts people sign in with,
yours among them: the account made at setup, with its email, username and password, holds the
**Host** and **Admin** roles. Only the host changes the host account, under **Settings,
Account**, and it cannot be suspended or removed. Open any other to set it up:

- **Permissions**, a card per feature: **Sign in to the dashboard**, then what it may do there,
  such as viewing containers or starting and stopping them, publishing, changing or removing
  tunnels, naming devices, managing accounts, installing apps, uploading and
  deleting in Storage, and the settings pages.
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

**Security, Devices** lists them: **Linked**, the devices accounts sign in from, with
what each browser reported when it signed in (platform, GPU, CPU threads, memory, screen,
time zone, languages, user agent) and where it connected from; and **Other**, the rest.

## Third-party sign-in

Tunnels with sign-in on can also offer **Continue with** Google, Microsoft, Facebook,
GitHub, Discord, LinkedIn, Slack or GitLab; a self-hosted Authentik or Keycloak; or any
other OpenID Connect provider. Set each up
once under **Security, Third-Party OAuth** the way Cloudflare was set up: **Open GitHub** (or
the provider's console), register an app, then paste its client ID and secret back. Each
tunnel then switches on the providers it offers, under **Access Control**.

The provider vouches for an email, and the account under **Users** with that email signs
in, held to the same rules as a password sign-in: it must be on, allowed on the tunnel,
and on a linked device. Only an email the provider marks as verified counts. A provider sends the visitor back to the tunnel they signed in at,
`https://<tunnel>/__gate/oauth-callback`, which the tunnel shows once the provider is on
there. GitHub's one callback URL covers a whole domain, so `https://example.com` covers
every tunnel on it.

## Two-factor sign-in

Under **Security, Two-Factor Auth**, enter SMTP credentials from any provider, Gmail (with an app
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

Settings made in the panel are stored in `gateway.db` in the data folder. myTunnels reads
these environment variables, none of which an install needs:

| Variable | Installed | In the Docker image | Meaning |
| --- | --- | --- | --- |
| `ADMIN_ADDR` | `127.0.0.1:7070` | `0.0.0.0:7070` | Admin panel address; `compose.yaml` publishes it on `127.0.0.1` only |
| `GATE_ADDR` | `127.0.0.1:7080` | `127.0.0.1:7080` | Gateway address, reached only by cloudflared |
| `UPSTREAM_HOST` | `127.0.0.1` | `host.docker.internal` | Default host for tunnel ports, changeable in Settings |
| `DATA_DIR` | `data` in its folder | `/data` | Database location |
| `SECRET_KEY_FILE` | `keys/secret.key` in its folder | `/keys/secret.key` | Key that seals secrets in the database, made on first start |
| `SECRET_KEY` | none | none | The same key as 64 hex digits, in place of the file |
| `DOCKER_HOST` | Docker's own socket | `tcp://docker:2375` in `compose.yaml` | Docker API the Containers page reads containers from (`unix://`, `npipe://` or `tcp://`) |
| `RUST_LOG` | `info` | `info` | Log level |

Its folder is `%LOCALAPPDATA%\myTunnels` on Windows and `~/.local/share/myTunnels` elsewhere,
which also holds `log.txt` where launchd or Windows runs it; on Linux the log is
`journalctl --user -u mytunnels`.

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

After `mytunnels start`, myTunnels comes back on its own: within seconds of a crash, and with
the computer, from boot on Linux and at sign-in on macOS and Windows. The tunnel reconnects
with it. In Docker, its services restart with Docker.

Containers come back once Docker is running: every container with **Auto-start** set to unless
stopped by hand or always starts again, and each container's resources are given back.
Containers made from a repository or an image start that way by default. On Windows and
macOS, Docker Desktop runs only once someone signs in, so switch on **Start Docker Desktop
when you sign in** in its settings; `server host`, for the Dashboard's figures in Docker, needs
the same, from the Startup folder or a scheduled task.

## Running in Docker

```sh
docker compose up -d --build
```

The image carries every tool Convert uses. Its data stays in the `data` and `keys` volumes,
apart from an install's.

## Notes

- The admin panel answers only on the computer running it, at `http://localhost:7070`. Every
  other device opens it through a tunnel; publish it only with access rules in front of it,
  such as sign-in.
- The same network check compares public addresses. Behind carrier grade NAT, other
  customers of your ISP can share your public IPv4 address, so prefer sign-in there.
- The Cloudflare and tunnel tokens, SMTP and OAuth credentials and the session signing key
  are sealed in the database with a key kept apart from it, in the `keys` folder (or volume),
  so a copy of the data alone does not give them away. Keep both; without the key, those
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

Dev data lives in `server/data`, apart from an install's and the container's. Stop either
first (`mytunnels stop`), since they all use port 7070.

## License

Apache 2.0, see [LICENSE](LICENSE).
