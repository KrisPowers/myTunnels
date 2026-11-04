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

1. **Admin account.** An email, a username and a password for the panel. Either the email
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

**Containers** lists every container on the host, grouped by Compose project, with its
published ports, CPU, memory and status. Start and stop are on each row; restart, pause, kill
and remove are under the three dots. Open a container for its image, command, ports, volumes,
networks and logs. The container myTunnels runs in is marked, and anything that would stop it
asks once more.

The `docker` service in `compose.yaml` allows containers and the engine's info, nothing else,
so images, volumes and networks cannot be changed from the panel.

## Storage

**Storage** turns a folder of this host into a drive in the browser. It starts off. Press
**Enable storage**, then:

1. **Folder.** Pick the folder Storage shows: any folder, a whole drive such as `C:`, or the
   top of the host (every drive, or everything from `/`), which is not recommended.
2. **Address.** A subdomain on one of your domains, `storage` to start with.

After that, **Files** is a file explorer laid out like Windows': back, forward and up, the
address bar, search, folders down the left, details or large icons, sorting and a filter by
kind, a status bar with the free space. New folder, upload files or whole folders (also by
dragging them in), download, rename, cut, copy, paste, delete and dragging items onto a
folder all work, with the usual keys (Ctrl+A, Ctrl+X/C/V, Del, F2, Enter, Backspace).
Uploads go in pieces of 48 MB, under Cloudflare's 100 MB limit on a request, so files of any
size go up from anywhere.

**Access Control** has the same layers as any tunnel, then **People with access**: each
person, or **Everyone** who gets through, with the folders they may open, each **Read only**
or **Read and write**. A folder given covers everything in it; the folders on the way to it
show only the way there. At the storage address people see the same explorer, limited to
their folders. **Activity** is the address's log, as for a tunnel.

In the container, `compose.yaml` mounts the host's filesystem at `/host/root` and Docker
Desktop's drives at `/host/drives`. On Docker Desktop the drives are what Storage lists; on
Linux it is the filesystem from `/`, writable where user 10001 may write.

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
   letter and number key, kept in its local storage and in a cookie for the domain.
3. The device appears under **Devices** with what the browser reported (platform, GPU, CPU
   threads, memory, screen, time zone, languages, user agent) and where it connected from
   (IP address and country).
4. Approve it for every tunnel or for selected ones. The waiting page opens the app on its
   own within a few seconds.

The key is never stored on the server, only its SHA-256 hash. A browser is one device
everywhere: the cookie for the domain decides which device it is on every tunnel there,
tunnels on other domains fetch the same key from the oldest tunnel, and the dashboard's
own browser carries its key to one tunnel on each domain once. A key a page kept of its
own, or one no device has any more, is folded into or replaced by that one device. One
approval covers every tunnel on the same domain. If an approved key later shows up with different hardware
(platform, touch support, or GPU), the device goes back to waiting and is flagged for
review, which stops a copied key from working on another machine.

## Third-party sign-in

Tunnels with sign-in on can also offer **Continue with** GitHub, Google, GitLab, Discord,
Slack or Codeberg; a self-hosted Authentik, Authelia, Keycloak, Pocket ID, Zitadel, Kanidm,
Gitea or Forgejo; Auth0 or Okta; or any other OpenID Connect provider. Set each up
once on the **Third-Party OAuth** page the way Cloudflare was set up: **Open GitHub** (or
the provider's console), register an app, then paste its client ID and secret back. Each
tunnel then switches on the providers it offers, under **Access Control**.

The provider vouches for an email, and the account under **Users** with that email signs
in, held to the same rules as a password sign-in: it must be on, allowed on the tunnel,
and on a linked device. Only an email the provider marks as verified counts. A provider sends the visitor back to the tunnel they signed in at,
`https://<tunnel>/__gate/oauth-callback`, which the tunnel shows once the provider is on
there. GitHub's one callback URL covers a whole domain, so `https://example.com` covers
every tunnel on it.

## Two-factor sign-in

On **Two-Factor Auth**, enter SMTP credentials from any provider, Gmail (with an app
password), Outlook or your own: host, port, STARTTLS or TLS, username, password and from
address. Saving checks them, and **Send a test** emails the admin. Then a six digit code,
good once for ten minutes, can be asked for after the password:

- **Dashboard sign-in.** Every sign-in to the panel, sent to the admin email. Turning it on
  sends a test email first.
- **Tunnels.** Any tunnel with sign-in on can turn on **Email code**, sent to the account's
  email. It also applies to sign-ins through a third-party provider.

## Configuration

Settings made in the panel are stored in `/data/gateway.db`. The container reads these
environment variables:

| Variable | Default in the image | Meaning |
| --- | --- | --- |
| `ADMIN_ADDR` | `0.0.0.0:7070` | Admin panel address |
| `GATE_ADDR` | `127.0.0.1:7080` | Gateway address, reached only by cloudflared |
| `UPSTREAM_HOST` | `host.docker.internal` | Default host for tunnel ports, changeable in Settings |
| `DATA_DIR` | `/data` | Database location |
| `DOCKER_HOST` | `tcp://docker:2375` in `compose.yaml` | Docker API the Dashboard reads containers from (`unix://`, `npipe://` or `tcp://`) |
| `HOST_ROOT` | `/host` in `compose.yaml` | Where the host's files are mounted for Storage; unset, Storage uses the files this process sees |
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
  that address and, for accounts, that email out for 15 minutes. A device that fails
  on three different accounts in a day is refused for a day.
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
- The Cloudflare API token is stored in the database volume. Treat the volume as secret.

## Development

```sh
node scripts/dev.mjs
```

The whole app on `http://localhost:7070`, live as you save, with no image build:

- A change under `server/` is rebuilt incrementally and swapped in while the old build keeps
  serving, then every open page reloads. Only the first run compiles the dependencies.
- A change under `ui/` shows straight away through hot reload. The storage tunnel serves a
  built copy that is rebuilt as you save, so there a change shows on the next reload.
- cloudflared runs under the server as it does in the container, so tunnels work too. It is
  used from `PATH`, or fetched once.

Dev data lives in `server/data`, apart from the container's volume. Stop the container
first, since both use port 7070.

## License

Apache 2.0, see [LICENSE](LICENSE).
