import type { CreateOptions, GetOptions } from "./passkey";
import type { Challenge, Proof } from "./pow";
export type PolicyMode = "all" | "any";

export interface Route {
  id: string;
  subdomain: string;
  zone_id: string;
  zone_name: string;
  hostname: string;
  target_host: string | null;
  target_port: number;
  // "code" is Code's address and "dashboard" this dashboard, both served by
  // myTunnels itself.
  target_scheme: "http" | "https" | "code" | "dashboard";
  require_lan: boolean;
  require_device: boolean;
  require_password: boolean;
  require_login: boolean;
  require_code: boolean;
  // Third-party providers offered beside the password sign-in.
  oauth: string[];
  login_max: number;
  login_idle: number;
  password_set: boolean;
  policy_mode: PolicyMode;
  enabled: boolean;
  preserve_host: boolean;
  // Check an https app's certificate instead of taking any.
  verify_tls: boolean;
  created_at: number;
}

// Who may open a tunnel, as sent when publishing or editing one. `password` is a
// new tunnel password; left out, the one set stays.
export interface Access {
  require_lan: boolean;
  require_device: boolean;
  require_password: boolean;
  require_login: boolean;
  // After signing in, a code emailed to the account.
  require_code: boolean;
  oauth: string[];
  login_max: number;
  login_idle: number;
  policy_mode: PolicyMode;
  password?: string;
}

export type RouteEdit = Pick<Route, "target_host" | "target_scheme" | "enabled" | "preserve_host" | "verify_tls"> & Access & { port: number };

export interface User {
  id: string;
  username: string;
  email: string;
  name: string;
  enabled: boolean;
  route_ids: string[];
  device_ids: string[];
  created_at: number;
  last_login: number | null;
  // Why the account is held, while it is.
  note: string | null;
  // What it may do on the dashboard; "dashboard" lets it sign in there.
  permissions: string[];
}

export interface TunnelEvent {
  route_id: string;
  kind: "sign-in" | "password" | "visit" | "device";
  outcome: string;
  user_id: string | null;
  device_id: string | null;
  ip: string | null;
  country: string | null;
  at: number;
}

export interface SignIn {
  user_id: string;
  device_id: string | null;
  ip: string | null;
  country: string | null;
  at: number;
  outcome: "ok" | "failed" | "blocked" | "unlinked";
}

export type DeviceStatus = "seen" | "pending" | "approved" | "denied";

export interface DeviceInfo {
  userAgent?: string;
  platform?: string;
  mobile?: boolean | null;
  languages?: string[];
  hardwareConcurrency?: number | null;
  deviceMemory?: number | null;
  maxTouchPoints?: number;
  screen?: { width: number; height: number; colorDepth: number; pixelRatio: number };
  timezone?: string;
  webglVendor?: string;
  webglRenderer?: string;
}

export interface Device {
  id: string;
  name: string;
  status: DeviceStatus;
  all_routes: boolean;
  route_ids: string[];
  info: DeviceInfo | null;
  note: string | null;
  first_ip: string | null;
  last_ip: string | null;
  country: string | null;
  first_host: string | null;
  created_at: number;
  last_seen: number;
}

export interface Zone { id: string; name: string; status: string }
export interface Account { id: string; name: string }

export interface Settings {
  cloudflare: {
    configured: boolean;
    token_set: boolean;
    account_id: string | null;
    account_name: string | null;
    tunnel_id: string | null;
    tunnel_name: string | null;
  };
  upstream_host: string;
  default_upstream_host: string;
  trusted_networks: string;
}

export interface Status {
  configured: boolean;
  running: boolean;
  connections: number | null;
  restarts: number;
  last_error: string | null;
  logs: string[];
  public_ips: string[];
  // The running cloudflared, such as "2026.10.7".
  version: string | null;
}

// What the Dashboard shows, sampled on the server every `every` seconds, the
// last `keep` samples kept. Sizes are bytes, rates bytes a second.
export interface Sample {
  at: number;
  cpu: number;
  cores: number[];
  memory: number;
  swap: number;
  rx: number;
  tx: number;
  temp: number | null;
}

export interface ContainerStats {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  cpu: number;
  memory: number;
  memory_limit: number;
  rx: number;
  tx: number;
  read: number;
  write: number;
  history: number[];
}

export interface Metrics {
  every: number;
  keep: number;
  host: { name: string | null; os: string | null; kernel: string | null; arch: string; cpu: string | null; threads: number; cores: number | null; docker: string | null };
  uptime: number;
  load: [number, number, number] | null;
  memory_total: number;
  swap_total: number;
  history: Sample[];
  cores: { usage: number; mhz: number; temp: number | null }[];
  sensors: { label: string; temp: number; max: number | null; critical: number | null }[];
  disks: { name: string; mount: string; fs: string; total: number; available: number }[];
  docker: { reachable: boolean; error: string | null; containers: ContainerStats[] };
}

// A container as the Containers page lists it. `own` is the one myTunnels runs in.
export interface Port { private: number; public: number | null; type: string }

export interface Container {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  created: number;
  ports: Port[];
  project: string | null;
  service: string | null;
  own: boolean;
}

export interface ImageUser {
  id: string;
  name: string;
  state: string;
}

export interface Image {
  id: string;
  tags: string[];
  created: number;
  size: number;
  containers: ImageUser[];
}

export interface ImageDetail {
  id: string;
  tags: string[];
  digests: string[];
  created: string;
  size: number;
  platform: string;
  entrypoint: string[];
  command: string[];
  workdir: string;
  user: string;
  ports: string[];
  env: string[];
  labels: Record<string, string> | null;
  layers: { created: number; command: string; size: number }[];
  containers: ImageUser[];
}

export interface ContainerDetail {
  id: string;
  name: string;
  image: string;
  created: string;
  state: string;
  started: string;
  finished: string;
  exit_code: number;
  health: string | null;
  restarts: number;
  restart_policy: string;
  command: string;
  workdir: string;
  ports: Port[];
  mounts: { kind: string; source: string; destination: string; writable: boolean }[];
  networks: { name: string; ip: string }[];
  project: string | null;
  service: string | null;
  own: boolean;
}

export type ContainerAction = "start" | "stop" | "restart" | "pause" | "unpause" | "kill";

// Git: repositories kept on this host, browsed here and used with git over
// HTTPS signing in with a token.
export interface Repo {
  name: string;
  branch: string;
  updated: number | null;
  empty: boolean;
  write: boolean;
  // Git reaches it only from the home network.
  home_only: boolean;
  // Pinned to the top of the catalog, for the person signed in.
  pinned: boolean;
  // The language most of its code is in.
  language: string | null;
  // Commits in each of the last weeks, the oldest first.
  activity: number[];
}

export interface GitToken { id: string; name: string; owner: string; created_at: number; last_used: number | null }

export interface CodeState { route: Route | null; tokens: GitToken[] }

export interface Refs { default: string; branches: { name: string; updated: number }[]; tags: { name: string; updated: number }[]; home_only: boolean }

export interface TreeEntry { name: string; kind: "dir" | "file" | "module"; size: number | null }

export interface LastCommit { id: string; author: string; at: number; subject: string }

export interface TreeView { path: string; entries: TreeEntry[]; last: LastCommit | null; count: number }

export interface BlobView { size: number; binary: boolean; too_big: boolean; text: string | null }

export interface CommitLine { id: string; author: string; email: string; at: number; subject: string }

export interface CommitView { id: string; parents: string[]; author: string; email: string; at: number; message: string; patch: string; truncated: boolean }

export interface Branch { name: string; id: string; updated: number; author: string; subject: string; default: boolean; ahead: number; behind: number }

// What one branch would bring into another.
export interface Compare { commits: CommitLine[]; patch: string; truncated: boolean; mergeable: boolean; error?: string }

// An issue or a pull request, numbered together per repository.
export interface Thread {
  number: number;
  kind: "issue" | "pull";
  title: string;
  body: string;
  state: "open" | "closed" | "merged";
  author: string;
  base: string | null;
  head: string | null;
  merged_commit: string | null;
  created_at: number;
  updated_at: number;
  comments: number;
}

export interface ThreadView extends Thread {
  thread: { id: string; author: string; body: string; created_at: number }[];
  changes?: Compare;
}

export interface FileEntry { name: string; dir: boolean; size: number; modified: number }

export interface Listing {
  path: string;
  // "browse" is a folder only passed through on the way to one given.
  access: "browse" | "read" | "write";
  entries: FileEntry[];
  space: { free: number; total: number } | null;
  user: string | null;
}

// Where files are: the Media and Drive collections.
export type Space = "media" | "drive";

export const fileUrl = (path: string, inline: boolean, space: Space) =>
  `/api/${space}/fs/file?path=${encodeURIComponent(path)}${inline ? "&inline=true" : ""}`;

// A copy of a file in Media or Drive being made in another format or smaller,
// saved beside the original. `size` is a photo's longest side or a video's
// shortest, in pixels, 0 for as it is.
export type ConvertKind = "photo" | "video" | "pdf";
export type Quality = "high" | "medium" | "small";
export interface ConvertJob {
  id: string;
  space: Space;
  source: string;
  kind: ConvertKind;
  to: string;
  size: number;
  quality: Quality;
  state: "waiting" | "running" | "done" | "failed";
  progress: number;
  created: number;
  source_size: number;
  output: string | null;
  output_size: number;
  error: string | null;
}
export interface ConvertState {
  jobs: ConvertJob[];
  kinds: { kind: ConvertKind; formats: string[]; sizes: number[] }[];
}

// A photo's or video's preview in Media.
export const thumbUrl = (path: string) => `/api/media/fs/thumb?path=${encodeURIComponent(path)}`;

// A way to sign in at tunnels through another service, set up once and offered
// by the tunnels that switch it on. The secret stays on the server;
// `secret_set` says one is saved.
export interface OAuthProvider {
  id: string;
  label: string;
  name: string;
  issuer: string;
  client_id: string;
  secret_set: boolean;
  // Self-hosted and tenant providers are found at an issuer URL of your own.
  needs_issuer: boolean;
  configured: boolean;
}

export interface OAuthState { providers: OAuthProvider[] }

// Where a provider sends people back: the tunnel they signed in at.
export const redirectUrl = (hostname: string) => `https://${hostname}/__gate/oauth-callback`;

// The SMTP credentials codes are sent with. The password stays on the server.
export interface Smtp {
  host: string;
  port: number;
  security: "starttls" | "tls" | "none";
  username: string;
  password_set: boolean;
  from: string;
}

// `enabled`: every sign-in, the dashboard's and each tunnel's, asks for an emailed code.
export interface TwoFactor { smtp: Smtp | null; enabled: boolean; admin_email: string | null }

// A sign-in that went through, or one waiting on an emailed code.
// `app`: the code comes from the account's authenticator app, not an email.
export interface SignedIn { ok?: boolean; code_required?: boolean; ticket?: string; sent_to?: string; app?: boolean }

// The account signed in: the host account made at setup, or another account's own.
export interface AdminAccount { username: string | null; email: string | null; host: boolean; totp: boolean }

// A share link: what it opens, until when, and how often it was opened.
export interface Share {
  id: string;
  space: Space;
  paths: string[];
  protected: boolean;
  expires: number | null;
  created_by: string;
  created_at: number;
  opened: number;
}

// One copy of a file kept more than once, in Storage.
export interface DuplicateCopy { space: Space; path: string; size: number; modified: number }

// A passkey of the account signed in: the site it signs in to, and when it was last used.
export interface PasskeyInfo { id: string; rp_id: string; name: string; created_at: number; last_used: number | null }

// An authenticator app being set up: its secret, the link, and the link as a QR code (SVG).
export interface TotpSetup { secret: string; uri: string; qr: string }

// What an account may do on the dashboard, by feature. The host and admins may do all.
export interface Permission { key: string; label: string; hint: string }
export interface Group { label: string; permissions: Permission[] }
// `host`: the account made at setup. `admin`: the host, or an account with the Admin role.
export interface Me { id: string; host: boolean; admin: boolean; name: string; permissions: string[] }

export interface Auth {
  authenticated: boolean;
  me: Me | null;
  catalog: Group[];
  setup: { password: boolean; account: boolean; token: boolean; cloudflare: boolean; done: boolean };
}

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch("/api" + path, {
    method,
    credentials: "same-origin",
    // The server refuses changes without this header, which a page on another site cannot send.
    headers: { "X-Requested-With": "fetch", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith("/auth")) dispatchEvent(new Event("signed-out"));
  if (!res.ok) throw new Error(data.error ?? `The server answered ${res.status}`);
  return data as T;
}

export const api = {
  auth: () => call<Auth>("/auth"),
  createAccount: (email: string, username: string, password: string) => call("/auth/setup", "POST", { email, username, password }),
  challenge: () => call<Challenge>("/auth/challenge", "POST"),
  login: (login: string, password: string, pow?: Proof) => call<SignedIn>("/auth/login", "POST", { login, password, pow }),
  loginCode: (ticket: string, code: string) => call("/auth/code", "POST", { ticket, code }),
  logout: () => call("/auth/logout", "POST"),

  account: () => call<AdminAccount>("/account"),
  editAccount: (patch: Partial<{ username: string; email: string }>) => call<AdminAccount>("/account", "PATCH", patch),
  startTotp: () => call<TotpSetup>("/account/totp", "POST"),
  confirmTotp: (code: string) => call<{ recovery: string[] }>("/account/totp", "PUT", { code }),
  removeTotp: (code: string) => call("/account/totp", "DELETE", { code }),
  passkeys: () => call<PasskeyInfo[]>("/account/passkeys"),
  shares: () => call<{ shares: Share[]; address: string | null }>("/shares"),
  share: (body: { space: Space; paths: string[]; password: string; days: number }) => call<{ share: Share; url: string }>("/shares", "POST", body),
  endShare: (id: string) => call(`/shares/${encodeURIComponent(id)}`, "DELETE"),
  duplicates: () => call<{ groups: DuplicateCopy[][] }>("/duplicates"),
  beginPasskey: () => call<CreateOptions>("/account/passkeys/begin", "POST"),
  addPasskey: (credential: unknown, name: string) => call<PasskeyInfo[]>("/account/passkeys", "POST", { credential, name }),
  removePasskey: (id: string) => call<PasskeyInfo[]>(`/account/passkeys/${encodeURIComponent(id)}`, "DELETE"),
  beginPasskeySignIn: () => call<GetOptions>("/auth/passkey/begin", "POST"),
  passkeySignIn: (credential: unknown) => call("/auth/passkey", "POST", { credential }),

  oauth: () => call<OAuthState>("/oauth"),
  saveOAuth: (id: string, body: Partial<{ client_id: string; client_secret: string; name: string; issuer: string }>) =>
    call<OAuthState>(`/oauth/${id}`, "PUT", body),
  removeOAuth: (id: string) => call<OAuthState>(`/oauth/${id}`, "DELETE"),

  twoFactor: () => call<TwoFactor>("/twofactor"),
  saveSmtp: (body: Omit<Smtp, "password_set"> & { password?: string }) => call<TwoFactor>("/twofactor/smtp", "PUT", body),
  testMail: () => call<{ ok: boolean; to: string }>("/twofactor/test", "POST"),
  saveTwoFactor: (enabled: boolean) => call<TwoFactor>("/twofactor", "PUT", { enabled }),

  settings: () => call<Settings>("/settings"),
  status: () => call<Status>("/status"),
  metrics: () => call<Metrics>("/metrics"),
  containers: () => call<Container[]>("/containers"),
  container: (id: string) => call<ContainerDetail>(`/containers/${encodeURIComponent(id)}`),
  containerLogs: (id: string, tail: number) => call<{ lines: string[] }>(`/containers/${encodeURIComponent(id)}/logs?tail=${tail}`),
  containerAction: (id: string, action: ContainerAction) => call(`/containers/${encodeURIComponent(id)}/${action}`, "POST"),
  removeContainer: (id: string) => call(`/containers/${encodeURIComponent(id)}`, "DELETE"),
  images: () => call<Image[]>("/images"),
  image: (id: string) => call<ImageDetail>(`/images/${encodeURIComponent(id)}`),
  removeImage: (id: string) => call(`/images/${encodeURIComponent(id)}`, "DELETE"),
  accounts: (token: string | null) => call<Account[]>("/cloudflare/accounts", "POST", { api_token: token }),
  connect: (token: string | null, accountId: string, tunnelName: string) =>
    call("/settings/cloudflare", "PUT", { api_token: token, account_id: accountId, tunnel_name: tunnelName }),
  saveNetwork: (upstreamHost: string, trustedNetworks: string) =>
    call("/settings/network", "PUT", { upstream_host: upstreamHost, trusted_networks: trustedNetworks }),
  zones: () => call<Zone[]>("/zones"),

  routes: () => call<Route[]>("/routes"),
  publish: (body: { subdomain: string; zone_id: string; port: number; target_host: string | null; target_scheme: string; preserve_host: boolean; verify_tls?: boolean } & Access) =>
    call<Route>("/routes", "POST", body),
  editRoute: (id: string, edit: RouteEdit) => call<Route>(`/routes/${id}`, "PATCH", edit),
  removeRoute: (id: string) => call(`/routes/${id}`, "DELETE"),
  routeActivity: (id: string) => call<TunnelEvent[]>(`/routes/${id}/activity`),
  moveRoute: (id: string, subdomain: string, zone_id: string) => call<Route>(`/routes/${id}/address`, "PUT", { subdomain, zone_id }),

  devices: () => call<Device[]>("/devices"),
  editDevice: (id: string, patch: Partial<Pick<Device, "name" | "status" | "all_routes" | "route_ids">>) =>
    call<Device>(`/devices/${id}`, "PATCH", patch),
  forgetDevice: (id: string) => call(`/devices/${id}`, "DELETE"),
  // `hosts` is one tunnel per domain, where this browser's key has to be too.
  thisDevice: (token: string | null, info: unknown) => call<{ id: string; token: string; hosts: string[] }>("/device", "POST", { token, info }),
  plantDevice: (token: string, back: string) => call<{ url: string }>("/device/plant", "POST", { token, back }),

  users: () => call<User[]>("/users"),
  addUser: (body: { username: string; email: string; password: string; device_id: string }) =>
    call<User>("/users", "POST", body),
  editUser: (id: string, patch: Partial<Pick<User, "username" | "email" | "name" | "enabled" | "route_ids" | "device_ids" | "permissions">> & { password?: string }) =>
    call<User>(`/users/${id}`, "PATCH", patch),
  removeUser: (id: string) => call(`/users/${id}`, "DELETE"),
  signOutUser: (id: string) => call(`/users/${id}/signout`, "POST"),
  userActivity: (id: string) => call<SignIn[]>(`/users/${id}/activity`),
  deviceActivity: (id: string) => call<SignIn[]>(`/devices/${id}/activity`),

  code: () => call<CodeState>("/code"),
  createRepo: (name: string) => call<{ repos: Repo[] }>("/code/repos", "POST", { name }),
  removeRepo: (name: string) => call<{ repos: Repo[] }>(`/code/repos/${encodeURIComponent(name)}`, "DELETE"),
  editRepo: (name: string, patch: { home_only?: boolean; default_branch?: string }) => call<{ repos: Repo[] }>(`/code/repos/${encodeURIComponent(name)}`, "PATCH", patch),
  pinRepo: (name: string, pinned: boolean) => call<{ pinned: boolean }>(`/code/repos/${encodeURIComponent(name)}/pin`, "PUT", { pinned }),
  branch: (name: string, body: { action: "create" | "delete"; name: string; from?: string }) =>
    call<{ default: string; branches: Branch[] }>(`/code/repos/${encodeURIComponent(name)}/branch`, "POST", body),
  openThread: (name: string, body: { kind: "issue" | "pull"; title: string; body: string; base?: string; head?: string }) =>
    call<Thread>(`/code/repos/${encodeURIComponent(name)}/threads`, "POST", body),
  editThread: (name: string, number: number, patch: { title?: string; body?: string; state?: "open" | "closed" }) =>
    call<ThreadView>(`/code/repos/${encodeURIComponent(name)}/thread/${number}`, "PATCH", patch),
  comment: (name: string, number: number, body: string) => call<ThreadView>(`/code/repos/${encodeURIComponent(name)}/thread/${number}/comments`, "POST", { body }),
  merge: (name: string, number: number) => call<ThreadView>(`/code/repos/${encodeURIComponent(name)}/thread/${number}/merge`, "POST"),
  addToken: (name: string, owner: string) => call<CodeState & { secret: string }>("/code/tokens", "POST", { name, owner }),
  removeToken: (id: string) => call<CodeState>(`/code/tokens/${id}`, "DELETE"),

  convert: () => call<ConvertState>("/convert"),
  startConvert: (body: { space: Space; paths: string[]; to: string; size: number; quality: Quality }) => call<{ queued: number }>("/convert", "POST", body),
  removeConvert: (id: string) => call(`/convert/${id}`, "DELETE"),
};

// Reading repositories.
const repoPath = (name: string, op: string, q: Record<string, string | number | undefined>) => {
  const params = Object.entries(q).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
  return `/code/repos/${encodeURIComponent(name)}/${op}${params ? "?" + params : ""}`;
};

export const repos = {
  list: () => call<{ repos: Repo[]; user: string | null }>("/code/repos"),
  refs: (name: string) => call<Refs>(repoPath(name, "refs", {})),
  tree: (name: string, ref: string, path: string) => call<TreeView>(repoPath(name, "tree", { ref, path })),
  blob: (name: string, ref: string, path: string) => call<BlobView>(repoPath(name, "blob", { ref, path })),
  log: (name: string, ref: string, skip: number) => call<{ commits: CommitLine[]; more: boolean }>(repoPath(name, "log", { ref, skip })),
  commit: (name: string, id: string) => call<CommitView>(repoPath(name, "commit", { ref: id })),
  branches: (name: string) => call<{ default: string; branches: Branch[] }>(repoPath(name, "branches", {})),
  compare: (name: string, base: string, head: string) => call<Compare>(repoPath(name, "compare", { base, ref: head })),
  threads: (name: string, kind: "issues" | "pulls") => call<{ threads: Thread[] }>(repoPath(name, `threads/${kind}`, {})),
  thread: (name: string, number: number) => call<ThreadView>(repoPath(name, `thread/${number}`, {})),
};

export const rawUrl = (name: string, ref: string, path: string) => "/api" + repoPath(name, "blob", { ref, path, raw: "true" });

// The files in a collection.
export const filesIn = (space: Space) => ({
  list: (path: string) => call<Listing>(`/${space}/fs/list?path=${encodeURIComponent(path)}`),
  folder: (path: string) => call<{ path: string }>(`/${space}/fs/folder`, "POST", { path }),
  rename: (path: string, name: string) => call<{ path: string }>(`/${space}/fs/rename`, "POST", { path, name }),
  move: (paths: string[], to: string, copy: boolean) => call<{ done: number }>(`/${space}/fs/move`, "POST", { paths, to, copy }),
  remove: (paths: string[]) => call<{ done: number }>(`/${space}/fs/delete`, "POST", { paths }),
  extract: (path: string) => call<{ path: string; skipped: number }>(`/${space}/fs/extract`, "POST", { path }),
  compress: (paths: string[]) => call<{ path: string }>(`/${space}/fs/compress`, "POST", { paths }),
});

// Saves a preview made in the browser beside a photo or video in Media.
export async function saveThumb(path: string, jpeg: Blob) {
  await fetch(thumbUrl(path), { method: "PUT", credentials: "same-origin", headers: { "X-Requested-With": "fetch" }, body: jpeg });
}

// Uploads go in pieces well under Cloudflare's 100 MB limit on a request.
const PIECE = 48 * 1024 * 1024;

function put(url: string, body: Blob, onSent: (bytes: number) => void): Promise<{ status: number; data: { error?: string; received?: number } }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("X-Requested-With", "fetch");
    xhr.upload.onprogress = (e) => onSent(e.loaded);
    xhr.onload = () => {
      let data: { error?: string; received?: number } = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // Not JSON, such as the gateway asking to sign in again.
      }
      resolve({ status: xhr.status, data });
    };
    xhr.onerror = () => reject(new Error("The connection dropped"));
    xhr.onabort = () => reject(new Error("Cancelled"));
    xhr.send(body);
  });
}

// upload sends a file to `path` in `space` piece by piece, picking up where the
// server says it got to if a piece is lost. `onProgress` gets the bytes sent so
// far. With `keepDate`, the file keeps the date it was last changed.
export async function upload(file: File, path: string, replace: boolean, onProgress: (sent: number) => void, cancelled: () => boolean, space: Space, keepDate = false) {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
  let offset = 0;
  do {
    if (cancelled()) throw new Error("Cancelled");
    const end = Math.min(offset + PIECE, file.size);
    const date = keepDate && file.lastModified ? `&modified=${Math.floor(file.lastModified / 1000)}` : "";
    const url = `/api/${space}/fs/upload?path=${encodeURIComponent(path)}&id=${id}&offset=${offset}&total=${file.size}&replace=${replace}${date}`;
    const start = offset;
    const res = await put(url, file.slice(start, end), (sent) => onProgress(start + sent));
    if (res.status === 409 && typeof res.data.received === "number") {
      offset = res.data.received;
      continue;
    }
    if (res.status === 401) dispatchEvent(new Event("signed-out"));
    if (res.status < 200 || res.status >= 300) throw new Error(res.data.error ?? `The server answered ${res.status}`);
    offset = end;
    onProgress(offset);
  } while (offset < file.size);
}

export function bytes(n: number) {
  if (n < 1024) return `${n} bytes`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function editOf(r: Route): RouteEdit {
  return {
    port: r.target_port,
    target_host: r.target_host,
    target_scheme: r.target_scheme,
    require_lan: r.require_lan,
    require_device: r.require_device,
    require_password: r.require_password,
    require_login: r.require_login,
    require_code: r.require_code,
    oauth: r.oauth,
    login_max: r.login_max,
    login_idle: r.login_idle,
    policy_mode: r.policy_mode,
    enabled: r.enabled,
    preserve_host: r.preserve_host,
    verify_tls: r.verify_tls,
  };
}

// The Cloudflare page that creates an API token with exactly the permissions
// this app needs, already filled in: Cloudflare Tunnel edit, DNS edit, Zone read.
export const TOKEN_URL =
  "https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=" +
  encodeURIComponent(JSON.stringify([
    { key: "argotunnel", type: "edit" },
    { key: "dns", type: "edit" },
    { key: "zone", type: "read" },
  ])) +
  "&accountId=*&zoneId=all&name=myTunnels";

export function ago(seconds: number) {
  const s = Math.round(Date.now() / 1000 - seconds);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(seconds * 1000).toLocaleDateString();
}

// A device ID is 256 characters; the dashboard shows its start.
export function shortId(id: string) {
  return id.length > 12 ? id.slice(0, 8) + "..." : id;
}

export function message(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

// What this browser reports about its hardware, as the gateway's device page sends it.
export function deviceInfo() {
  const n = navigator as Navigator & { userAgentData?: { platform?: string; mobile?: boolean }; deviceMemory?: number };
  let vendor = "";
  let renderer = "";
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    if (gl) {
      vendor = String(gl.getParameter(ext ? ext.UNMASKED_VENDOR_WEBGL : gl.VENDOR));
      renderer = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    }
  } catch {
    // No graphics information, then.
  }
  return {
    userAgent: n.userAgent,
    platform: n.userAgentData?.platform || n.platform || "",
    mobile: n.userAgentData ? !!n.userAgentData.mobile : null,
    languages: [...(n.languages ?? [n.language])],
    hardwareConcurrency: n.hardwareConcurrency || null,
    deviceMemory: n.deviceMemory || null,
    maxTouchPoints: n.maxTouchPoints || 0,
    screen: { width: screen.width, height: screen.height, colorDepth: screen.colorDepth, pixelRatio: devicePixelRatio },
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    webglVendor: vendor,
    webglRenderer: renderer,
  };
}

// The rating every password here is held to: 10 or more characters with upper
// and lower case, a number and a symbol.
export const LEVELS = { poor: "Poor", decent: "Decent", good: "Good", strong: "Strong" } as const;

export function strength(p: string) {
  const missing = [
    p.length < 10 && "10 or more characters",
    !/[A-Z]/.test(p) && "an uppercase letter",
    !/[a-z]/.test(p) && "a lowercase letter",
    !/[0-9]/.test(p) && "a number",
    !/[^A-Za-z0-9]/.test(p) && "a symbol such as ! or $",
  ].filter((m): m is string => Boolean(m));
  const level: keyof typeof LEVELS = missing.length > 2 ? "poor" : missing.length > 0 ? "decent" : p.length >= 14 ? "strong" : "good";
  return { ok: missing.length === 0, level, missing };
}

export function list(items: string[]) {
  return items.length < 2 ? items.join("") : items.slice(0, -1).join(", ") + " and " + items[items.length - 1];
}
