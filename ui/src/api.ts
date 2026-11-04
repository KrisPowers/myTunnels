export type PolicyMode = "all" | "any";

export interface Route {
  id: string;
  subdomain: string;
  zone_id: string;
  zone_name: string;
  hostname: string;
  target_host: string | null;
  target_port: number;
  // "storage" is the Storage page's address, served by myTunnels itself.
  target_scheme: "http" | "https" | "storage";
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

export type RouteEdit = Pick<Route, "target_host" | "target_scheme" | "enabled" | "preserve_host"> & Access & { port: number };

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

// Storage: one folder of the host, opened on the dashboard and at its own
// address. Paths are `/`-separated under that folder, "" for the folder itself;
// host paths start at the top of the host, with a drive (`C:/Users`) where it
// has drives.
export interface StorageRule {
  id: string;
  // An account, or "*" for everyone who gets through.
  user_id: string;
  path: string;
  mode: "read" | "write";
  created_at: number;
}

export interface StorageState {
  enabled: boolean;
  path: string | null;
  display: string | null;
  drives: boolean;
  route: Route | null;
  rules: StorageRule[];
}

export interface HostFolder { path: string; display: string; parent: string | null; folders: string[] }

export interface FileEntry { name: string; dir: boolean; size: number; modified: number }

export interface Listing {
  path: string;
  // "browse" is a folder only passed through on the way to one given.
  access: "browse" | "read" | "write";
  entries: FileEntry[];
  space: { free: number; total: number } | null;
  // At the storage address, the account signed in.
  user: string | null;
}

export const fileUrl = (path: string, inline = false) =>
  `/api/storage/fs/file?path=${encodeURIComponent(path)}${inline ? "&inline=true" : ""}`;

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

export interface TwoFactor { smtp: Smtp | null; dashboard: boolean; admin_email: string | null }

// A sign-in that went through, or one waiting on an emailed code.
export interface SignedIn { ok?: boolean; code_required?: boolean; ticket?: string; sent_to?: string }

export interface AdminAccount { username: string | null; email: string | null }

export interface Auth {
  authenticated: boolean;
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
  login: (login: string, password: string) => call<SignedIn>("/auth/login", "POST", { login, password }),
  loginCode: (ticket: string, code: string) => call("/auth/code", "POST", { ticket, code }),
  logout: () => call("/auth/logout", "POST"),

  account: () => call<AdminAccount>("/account"),
  editAccount: (patch: Partial<{ username: string; email: string }>) => call<AdminAccount>("/account", "PATCH", patch),

  oauth: () => call<OAuthState>("/oauth"),
  saveOAuth: (id: string, body: Partial<{ client_id: string; client_secret: string; name: string; issuer: string }>) =>
    call<OAuthState>(`/oauth/${id}`, "PUT", body),
  removeOAuth: (id: string) => call<OAuthState>(`/oauth/${id}`, "DELETE"),

  twoFactor: () => call<TwoFactor>("/twofactor"),
  saveSmtp: (body: Omit<Smtp, "password_set"> & { password?: string }) => call<TwoFactor>("/twofactor/smtp", "PUT", body),
  testMail: () => call<{ ok: boolean; to: string }>("/twofactor/test", "POST"),
  saveTwoFactor: (dashboard: boolean) => call<TwoFactor>("/twofactor", "PUT", { dashboard }),

  settings: () => call<Settings>("/settings"),
  status: () => call<Status>("/status"),
  metrics: () => call<Metrics>("/metrics"),
  accounts: (token: string | null) => call<Account[]>("/cloudflare/accounts", "POST", { api_token: token }),
  connect: (token: string | null, accountId: string, tunnelName: string) =>
    call("/settings/cloudflare", "PUT", { api_token: token, account_id: accountId, tunnel_name: tunnelName }),
  saveNetwork: (upstreamHost: string, trustedNetworks: string) =>
    call("/settings/network", "PUT", { upstream_host: upstreamHost, trusted_networks: trustedNetworks }),
  zones: () => call<Zone[]>("/zones"),

  routes: () => call<Route[]>("/routes"),
  publish: (body: { subdomain: string; zone_id: string; port: number; target_host: string | null; target_scheme: string; preserve_host: boolean } & Access) =>
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
  editUser: (id: string, patch: Partial<Pick<User, "username" | "email" | "name" | "enabled" | "route_ids" | "device_ids">> & { password?: string }) =>
    call<User>(`/users/${id}`, "PATCH", patch),
  removeUser: (id: string) => call(`/users/${id}`, "DELETE"),
  signOutUser: (id: string) => call(`/users/${id}/signout`, "POST"),
  userActivity: (id: string) => call<SignIn[]>(`/users/${id}/activity`),
  deviceActivity: (id: string) => call<SignIn[]>(`/devices/${id}/activity`),

  storage: () => call<StorageState>("/storage"),
  saveStorage: (body: { enabled?: boolean; path?: string }) => call<StorageState>("/storage", "PUT", body),
  browseHost: (path: string) => call<HostFolder>(`/storage/browse?path=${encodeURIComponent(path)}`),
  addRule: (body: { user_id: string; path: string; mode: StorageRule["mode"] }) => call<StorageState>("/storage/rules", "POST", body),
  editRule: (id: string, patch: Partial<Pick<StorageRule, "path" | "mode">>) => call<StorageState>(`/storage/rules/${id}`, "PATCH", patch),
  removeRule: (id: string) => call<StorageState>(`/storage/rules/${id}`, "DELETE"),
};

// The files in Storage, the same calls on the dashboard and at the storage address.
export const files = {
  list: (path: string) => call<Listing>(`/storage/fs/list?path=${encodeURIComponent(path)}`),
  folder: (path: string) => call<{ path: string }>("/storage/fs/folder", "POST", { path }),
  rename: (path: string, name: string) => call<{ path: string }>("/storage/fs/rename", "POST", { path, name }),
  move: (paths: string[], to: string, copy: boolean) => call<{ done: number }>("/storage/fs/move", "POST", { paths, to, copy }),
  remove: (paths: string[]) => call<{ done: number }>("/storage/fs/delete", "POST", { paths }),
};

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

// upload sends a file to `path` piece by piece, picking up where the server
// says it got to if a piece is lost. `onProgress` gets the bytes sent so far.
export async function upload(file: File, path: string, replace: boolean, onProgress: (sent: number) => void, cancelled: () => boolean) {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
  let offset = 0;
  do {
    if (cancelled()) throw new Error("Cancelled");
    const end = Math.min(offset + PIECE, file.size);
    const url = `/api/storage/fs/upload?path=${encodeURIComponent(path)}&id=${id}&offset=${offset}&total=${file.size}&replace=${replace}`;
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
