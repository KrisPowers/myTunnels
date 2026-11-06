# myTunnels

A self-hosted gateway for publishing homelab apps through Cloudflare Tunnel. Pick a local
port, type a subdomain, choose one of your domains, and the app is reachable at
`https://<subdomain>.<domain>` without opening a single port on your router. Every request
passes through an access gateway that can require the visitor to be on your home network,
to use an approved device, or both.

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

Open `http://<host>:7070`. Until everything is in place the panel is a short setup, one
step at a time, each saved as soon as it is done, so it can be left and resumed:

1. **Admin account.** The setup code, printed in the container's log
   (`docker compose logs gateway`) and saved in `/data/setup-code`, so no one else on the
   network can claim the panel first. Then an email, a username and a password for the panel. Either the email
   or the username signs in, and both can be changed under **Settings, Account**.
2. **Cloudflare.** **Open Cloudflare** goes to the token page with the permissions already
   picked (Account, Cloudflare Tunnel, Edit; Zone, DNS, Edit; Zone, Zone, Read). Create the
   token, paste it back, and the tunnel is created and the connector started. A token that
   sees more than one account asks which one.
3. **Network.** Where your apps run and what counts as the home network. The defaults suit
   most setups.
4. **Ready.** A summary, the connector coming online, and the theme.

Then, on **Tunnels**, type the subdomain, pick the domain, enter the port and press
**Publish**. Open the tunnel to choose who can open it.

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

Inside the container, processors, memory and temperatures are the host's own. Network
traffic is what passes through myTunnels. Containers come from the Docker API through the
`docker` service in `compose.yaml`, which allows containers and nothing else.
Temperatures need sensors the host exposes under `/sys/class/hwmon`, which a Linux host
does and Docker Desktop does not.

## Containers

**Containers** says how many run and their CPU and memory together, then a row per container:
its state, name over its image, published ports (each a link to open), CPU, memory and how
long it has run. Its menu holds logs, start or stop, restart and delete. Compose projects with
more than one container fold under their name, with start, stop and restart for all of them.
Search by name, image or ID, or show only running ones.

Open a container for its **Logs** (followed as it runs, searchable, with or without times),
**Inspect** (what it runs, its state, ports and networks), **Mounts** and **Stats** (CPU over
time, memory, network and disk). The container myTunnels runs in is marked, cannot be stopped
or deleted from here, and asks once more before a restart.

The `docker` service in `compose.yaml` allows only the calls the panel makes, by method and
path: listing, inspecting, logs and stats, start, stop, restart, pause, resume and kill, and
removing a container. Creating containers, exec, images, volumes and networks are refused, and
only the gateway may connect to it.

## Storage & Media

The sidebar keeps these pages together under **Storage & Media**; the heading folds them away.

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

Git signs in with a token. Under **Tokens**, each person makes their own, and the admin (or an
account allowed to manage everyone's tokens) makes them for others; a token is shown once, and
only its hash is kept. When git asks, give any username and the token as the password:

```sh
git clone https://git.example.com/myapp.git       # through the tunnel
git clone http://<host>:7070/git/myapp.git        # on the LAN
```

On the LAN, the panel takes git at `/git/` straight away. For anywhere else, **Publish an
address** gives Git a subdomain, `git` to start with. That address is for git alone: a browser
opening it finds nothing, and repositories are browsed here on the dashboard. Git signs in with
its token, held to the account's Git permissions (**View repositories** to clone, **Push and merge** to
push). A repository's **Home network only** switch, on its page, lets git reach it only from
this host's network or a trusted one.

Cloudflare refuses a single request over 100 MB, so the first push of a very large repository
goes over the LAN, or in parts. Git needs `git`, which the image includes.

### Media

**Media** is a home cloud for photos and videos, not tied to any folder you pick: everything
uploaded is kept by myTunnels in `/data/media`. It is laid out like a photo library: newest
first, grouped by month, with **All**, **Photos** and **Videos** to narrow it. Open one to see
it full size, step through with the arrow keys, download or delete it. Tick several to
download or delete them together. **Upload**, or drag photos and videos onto the page; each
keeps the date it was last changed on the device it came from, and the browser makes a small
preview of it as it goes up.

### Drive

**Drive** keeps documents: Word and other text documents, spreadsheets, presentations and
PDFs, in folders of your own, in `/data/drive`. Each kind has its colour and a chip to show
only that kind; files show as cards or as a list, by name or by when they last changed. PDFs
and text files open in a new tab, the rest download. **New** makes a folder or uploads files,
which can also be dragged onto the page; right-click an item to open, download, rename or
delete it.

### Convert

**Convert** makes a copy of a photo, video or PDF kept in Media or Drive, in another format or
smaller. **Convert** opens a picker over Media (photos or videos) and Drive (its folders and
PDFs), with the choices for what is picked:

- **Photos** become JPEG or WebP, at their own size or with the longest side 3840, 2560, 1920
  or 1280 pixels. HEIC and AVIF photos from phones are read with libheif, the rest with
  ImageMagick.
- **Videos** become MP4 (H.264 with AAC sound), which every browser plays, at their own size or
  4K, 1080p, 720p or 480p. They are made with ffmpeg.
- **PDFs** are compressed with Ghostscript.

Each has **Best quality**, **Balanced** or **Smallest file**. The copy is saved beside the
original, named after it (`clip.mov` becomes `clip.mp4`, or `clip (2).mp4` when that is taken),
keeping its date and, in Media, its preview; the original is never changed. Jobs wait in a queue
and run one at a time at low priority, so a long video does not slow the gateway; the page lists
them with their progress, and each one's menu opens, downloads, cancels or clears it. **Convert**
in a file's menu in Media or Drive opens the picker with that file picked.

Convert needs, for a collection, the permissions to view it and to add to it (**Upload photos and
videos** for Media, **Upload and change documents** for Drive).

Media and Drive take only their own kinds of file, and both are in the dashboard alone, so
publish the dashboard through a tunnel to reach them from anywhere.

## Accounts and permissions

**Users**, under **Security & Roles** in the sidebar, holds the accounts people sign in with. Open one to
set it up:

- **Permissions**, a card per feature: **Sign in to the dashboard**, then what it may do there,
  such as viewing containers or starting and stopping them, publishing, changing or removing
  tunnels, approving devices, managing accounts, viewing, pushing to, creating and deleting
  repositories in Git, opening issues and pull requests, uploading and deleting in Media and Drive, and the settings pages.
- **Profile**: its details; **Security**, with its password, status and the devices it signs in
  from; and **Tunnels**, the tunnels it may open, added with **+** and removed with each one's
  **x**. **Suspend** in the menu stops it signing in anywhere until reinstated.

An account with **Sign in to the dashboard** signs in there with its email or username and its
own password (and an emailed code, when the dashboard asks for one), and sees only the pages
and actions its permissions allow; the server checks every call the same way. The admin holds
every permission. Anyone who manages accounts can give or take only permissions they hold
themselves, cannot change their own, and cannot change an account that can do more than they
can.

## Access rules

Each tunnel can require nothing, or any combination of:

| Rule | Passes when |
| --- | --- |
| Same network as this host | The visitor's public address (as reported by Cloudflare) is this host's public IPv4 address, inside this host's IPv6 /64, or inside a network listed under **Settings, Network** |
| Approved device | The browser holds a session for a device that is approved for this tunnel |

With both rules on, choose **Require both** or **Either is enough**. Either way the app's
own login still applies; the gateway is an extra layer in front of it.

### Device approval

1. A browser opens a tunnel that requires approved devices.
2. The gateway shows a page with a short device ID. The browser is assigned a 256 character
   letter and number key, kept only in a cookie that page scripts cannot read, so the app
   behind the tunnel never sees it.
3. The device appears under **Devices** with what the browser reported (platform, GPU, CPU
   threads, memory, screen, time zone, languages, user agent) and where it connected from
   (IP address and country).
4. Approve it for every tunnel or for selected ones. The waiting page opens the app on its
   own within a few seconds.

The key is never stored on the server, only its SHA-256 hash. Each tunnel keeps it in a
cookie for its own address alone, never one for the whole domain, so other servers on the
domain never receive it. A browser is still one device everywhere: a tunnel it has not
opened yet fetches its key from the oldest tunnel with a one-use code, and the dashboard's
own browser carries its key to every tunnel once. A key no device has any more is replaced
by that one device. One approval, and one sign-in, covers every tunnel the device and the
account may open. If an approved key later shows up with different hardware
(platform, touch support, or GPU), the device goes back to waiting and is flagged for
review, which stops a copied key from working on another machine.

## Third-party sign-in

Tunnels with sign-in on can also offer **Continue with** GitHub, Google, GitLab, Discord,
Slack or Codeberg; a self-hosted Authentik, Authelia, Keycloak, Pocket ID, Zitadel, Kanidm,
Gitea or Forgejo; Auth0 or Okta; or any other OpenID Connect provider. Set each up
once under **Advanced, Third-Party OAuth** the way Cloudflare was set up: **Open GitHub** (or
the provider's console), register an app, then paste its client ID and secret back. Each
tunnel then switches on the providers it offers, under **Access Control**.

The provider vouches for an email, and the account under **Users** with that email signs
in, held to the same rules as a password sign-in: it must be on, allowed on the tunnel,
and on a linked device. Only an email the provider marks as verified counts. A provider sends the visitor back to the tunnel they signed in at,
`https://<tunnel>/__gate/oauth-callback`, which the tunnel shows once the provider is on
there. GitHub's one callback URL covers a whole domain, so `https://example.com` covers
every tunnel on it.

## Two-factor sign-in

Under **Advanced, Two-Factor Auth**, enter SMTP credentials from any provider, Gmail (with an app
password), Outlook or your own: host, port, STARTTLS or TLS, username, password and from
address. Saving checks them, and **Send a test** emails the admin. Then a six digit code,
good once for ten minutes, is asked for after the password once **Email codes** is on. One
switch covers every sign-in: the dashboard's (sent to the admin email, or the account's own)
and every tunnel with sign-in, including sign-ins through a third-party provider. Turning it on
sends a test email first, and codes stop on their own if SMTP is removed.

## Configuration

Settings made in the panel are stored in `/data/gateway.db`. The container reads these
environment variables:

| Variable | Default in the image | Meaning |
| --- | --- | --- |
| `ADMIN_ADDR` | `0.0.0.0:7070` | Admin panel address |
| `GATE_ADDR` | `127.0.0.1:7080` | Gateway address, reached only by cloudflared |
| `UPSTREAM_HOST` | `host.docker.internal` | Default host for tunnel ports, changeable in Settings |
| `DATA_DIR` | `/data` | Database location |
| `SECRET_KEY_FILE` | `/keys/secret.key` | Key that seals secrets in the database, made on first start |
| `SECRET_KEY` | none | The same key as 64 hex digits, in place of the file |
| `DOCKER_HOST` | `tcp://docker:2375` in `compose.yaml` | Docker API the Dashboard reads containers from (`unix://`, `npipe://` or `tcp://`) |
| `RUST_LOG` | `info` | Log level |

`compose.yaml` maps `host.docker.internal` to the Docker host, so a port published by any
container (or any program) on the host works as a target. A tunnel can also point at
another host, such as a container name on a shared network or another machine on the LAN,
under **Show target options**.

## Security

Nothing here needs setting up; all of it is on from the first start.

- Sessions (admin, device, tunnel password, account) are signed tokens (JWT, HS256).
  The signing key is made on first start and kept in the database, so sessions
  survive restarts. Signing out, signing an account out everywhere, removing a device
  or account, and changing a password all end the sessions they cover for good.
- Every browser gets a device ID on its first visit, and the gateway's limits count
  per device ID as well as per address: 1200 requests and 30 key, password or
  sign-in steps a minute. One address gets at most 20 new device IDs an hour.
- Password and sign-in attempts need a device ID. Five wrong tries lock that device,
  that address and, for accounts, that email out for 15 minutes, except on the devices
  linked to the account, so its owner is never locked out by someone else's tries. A
  device that fails on three different accounts in a day is refused for a day.
- The panel allows 600 calls and 10 sign-in attempts per address each minute.
- The panel refuses changes that do not carry the header it sends, so another site
  cannot act through a signed-in browser. It sends a strict Content Security Policy
  and refuses to be framed.
- Tunnels get HSTS, and the gateway's own cookies never reach the apps behind it.

## Notes

- The admin panel is on your LAN at port 7070. Publish it through a tunnel only with access
  rules in front of it, such as approved devices.
- The same network check compares public addresses. Behind carrier grade NAT, other
  customers of your ISP can share your public IPv4 address, so prefer device approval there.
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
