export type PolicyMode = "all" | "any";

export interface Route {
  id: string;
  subdomain: string;
  zone_id: string;
  zone_name: string;
  hostname: string;
  target_host: string | null;
  target_port: number;
  target_scheme: "http" | "https";
  require_lan: boolean;
  require_device: boolean;
  policy_mode: PolicyMode;
  enabled: boolean;
  created_at: number;
}

export type RouteEdit = Pick<Route, "target_host" | "target_scheme" | "require_lan" | "require_device" | "policy_mode" | "enabled"> & { port: number };

export type DeviceStatus = "pending" | "approved" | "denied";

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

export interface Auth {
  authenticated: boolean;
  setup: { password: boolean; token: boolean; cloudflare: boolean; done: boolean };
}

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch("/api" + path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith("/auth")) dispatchEvent(new Event("signed-out"));
  if (!res.ok) throw new Error(data.error ?? `The server answered ${res.status}`);
  return data as T;
}

export const api = {
  auth: () => call<Auth>("/auth"),
  createPassword: (password: string) => call("/auth/setup", "POST", { password }),
  login: (password: string) => call("/auth/login", "POST", { password }),
  logout: () => call("/auth/logout", "POST"),

  settings: () => call<Settings>("/settings"),
  status: () => call<Status>("/status"),
  accounts: (token: string | null) => call<Account[]>("/cloudflare/accounts", "POST", { api_token: token }),
  connect: (token: string | null, accountId: string, tunnelName: string) =>
    call("/settings/cloudflare", "PUT", { api_token: token, account_id: accountId, tunnel_name: tunnelName }),
  saveNetwork: (upstreamHost: string, trustedNetworks: string) =>
    call("/settings/network", "PUT", { upstream_host: upstreamHost, trusted_networks: trustedNetworks }),
  zones: () => call<Zone[]>("/zones"),

  routes: () => call<Route[]>("/routes"),
  publish: (body: { subdomain: string; zone_id: string; port: number }) => call<Route>("/routes", "POST", body),
  editRoute: (id: string, edit: RouteEdit) => call<Route>(`/routes/${id}`, "PATCH", edit),
  removeRoute: (id: string) => call(`/routes/${id}`, "DELETE"),

  devices: () => call<Device[]>("/devices"),
  editDevice: (id: string, patch: Partial<Pick<Device, "name" | "status" | "all_routes" | "route_ids">>) =>
    call<Device>(`/devices/${id}`, "PATCH", patch),
  forgetDevice: (id: string) => call(`/devices/${id}`, "DELETE"),
};

export function editOf(r: Route): RouteEdit {
  return {
    port: r.target_port,
    target_host: r.target_host,
    target_scheme: r.target_scheme,
    require_lan: r.require_lan,
    require_device: r.require_device,
    policy_mode: r.policy_mode,
    enabled: r.enabled,
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

export function message(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
