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

The key is never stored on the server, only its SHA-256 hash. One approval covers every
tunnel on the same domain. If an approved key later shows up with different hardware
(platform, touch support, or GPU), the device goes back to waiting and is flagged for
review, which stops a copied key from working on another machine.

## Third-party sign-in

Tunnels with sign-in on can also offer **Continue with GitHub**, Google, GitLab, or any
OpenID Connect provider (Authentik, Authelia, Keycloak, Pocket ID and others). Set each up
once on the **Third-Party OAuth** page the way Cloudflare was set up: **Open GitHub** (or
the provider's console), register an app, then paste its client ID and secret back. Each
tunnel then switches on the providers it offers, under **Access Control**.

The provider vouches for an email, and the account under **Users** with that email signs
in, held to the same rules as a password sign-in: it must be on, allowed on the tunnel,
and on a linked device. A provider sends the visitor back to the tunnel they signed in at,
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

- Keep the admin panel on your LAN. It is not published through a tunnel.
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
- A change under `ui/` shows straight away through hot reload.
- cloudflared runs under the server as it does in the container, so tunnels work too. It is
  used from `PATH`, or fetched once.

Dev data lives in `server/data`, apart from the container's volume. Stop the container
first, since both use port 7070.

## License

Apache 2.0, see [LICENSE](LICENSE).
