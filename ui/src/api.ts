export type PolicyMode = 'all' | 'any'

export type Route = {
  id: string
  subdomain: string
  zone_id: string
  zone_name: string
  hostname: string
  target_host: string | null
  target_port: number
  target_scheme: 'http' | 'https'
  require_lan: boolean
  require_device: boolean
  policy_mode: PolicyMode
  enabled: boolean
  created_at: number
}

export type DeviceStatus = 'pending' | 'approved' | 'denied'

export type DeviceInfo = {
  userAgent?: string
  platform?: string
  mobile?: boolean | null
  languages?: string[]
  hardwareConcurrency?: number | null
  deviceMemory?: number | null
  maxTouchPoints?: number
  screen?: { width: number; height: number; colorDepth: number; pixelRatio: number }
  timezone?: string
  webglVendor?: string
  webglRenderer?: string
}

export type Device = {
  id: string
  name: string
  status: DeviceStatus
  all_routes: boolean
  route_ids: string[]
  info: DeviceInfo | null
  note: string | null
  first_ip: string | null
  last_ip: string | null
  country: string | null
  first_host: string | null
  created_at: number
  last_seen: number
}

export type Zone = { id: string; name: string; status: string }
export type Account = { id: string; name: string }

export type Settings = {
  cloudflare: {
    configured: boolean
    token_set: boolean
    account_id: string | null
    account_name: string | null
    tunnel_id: string | null
    tunnel_name: string | null
  }
  upstream_host: string
  default_upstream_host: string
  trusted_networks: string
}

export type Status = {
  configured: boolean
  running: boolean
  connections: number | null
  restarts: number
  last_error: string | null
  logs: string[]
  public_ips: string[]
}

export type AuthState = { setup_required: boolean; authenticated: boolean }

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (res.status === 401 && !path.startsWith('/auth')) {
    window.dispatchEvent(new Event('unauthorized'))
  }
  if (!res.ok) throw new Error(data?.error ?? `${res.status} ${res.statusText}`)
  return data as T
}

export function ago(seconds: number): string {
  const diff = Math.max(0, Date.now() / 1000 - seconds)
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`
  return `${Math.floor(diff / 86400)} d ago`
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
