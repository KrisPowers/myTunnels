import { useCallback, useEffect, useState } from 'react'
import { api, type AuthState, type Device, type Status } from './api'
import Login from './Login'
import Tunnels from './Tunnels'
import Devices from './Devices'
import Settings from './Settings'

type Page = 'tunnels' | 'devices' | 'settings'

const PAGES: { id: Page; label: string }[] = [
  { id: 'tunnels', label: 'Tunnels' },
  { id: 'devices', label: 'Devices' },
  { id: 'settings', label: 'Settings' },
]

function pageFromHash(): Page {
  const id = location.hash.replace('#/', '')
  return PAGES.some((p) => p.id === id) ? (id as Page) : 'tunnels'
}

export default function App() {
  const [auth, setAuth] = useState<AuthState | null>(null)
  const [page, setPage] = useState<Page>(pageFromHash)
  const [status, setStatus] = useState<Status | null>(null)
  const [pending, setPending] = useState(0)

  const loadAuth = useCallback(() => {
    api<AuthState>('/auth')
      .then(setAuth)
      .catch(() => setAuth({ setup_required: false, authenticated: false }))
  }, [])

  useEffect(() => {
    loadAuth()
    const onUnauthorized = () => setAuth((a) => (a ? { ...a, authenticated: false } : a))
    const onHash = () => setPage(pageFromHash())
    window.addEventListener('unauthorized', onUnauthorized)
    window.addEventListener('hashchange', onHash)
    return () => {
      window.removeEventListener('unauthorized', onUnauthorized)
      window.removeEventListener('hashchange', onHash)
    }
  }, [loadAuth])

  const refresh = useCallback(() => {
    api<Status>('/status').then(setStatus).catch(() => {})
    api<Device[]>('/devices')
      .then((d) => setPending(d.filter((x) => x.status === 'pending').length))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!auth?.authenticated) return
    refresh()
    const timer = setInterval(refresh, 10_000)
    return () => clearInterval(timer)
  }, [auth?.authenticated, refresh])

  if (!auth) return null
  if (!auth.authenticated) return <Login setup={auth.setup_required} onDone={loadAuth} />

  const logout = () => api('/auth/logout', 'POST').finally(loadAuth)

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          myTunnels
        </div>
        <nav>
          {PAGES.map((p) => (
            <a key={p.id} href={`#/${p.id}`} aria-current={page === p.id ? 'page' : undefined}>
              {p.label}
              {p.id === 'devices' && pending > 0 && <span className="count">{pending}</span>}
            </a>
          ))}
        </nav>
        <TunnelHealth status={status} />
        <button className="ghost signout" onClick={logout}>
          Sign out
        </button>
      </aside>
      <main className="content">
        {page === 'tunnels' && <Tunnels configured={status?.configured} />}
        {page === 'devices' && <Devices onChange={refresh} />}
        {page === 'settings' && <Settings status={status} onChange={refresh} />}
      </main>
    </div>
  )
}

function TunnelHealth({ status }: { status: Status | null }) {
  let tone = 'muted'
  let label = 'Checking'
  if (status && !status.configured) {
    label = 'Not connected'
  } else if (status && (status.connections ?? 0) > 0) {
    tone = 'ok'
    label = `Online, ${status.connections} links`
  } else if (status?.running) {
    tone = 'warn'
    label = 'Connecting'
  } else if (status) {
    tone = 'bad'
    label = 'Offline'
  }
  return (
    <a className="health" href="#/settings" title={status?.last_error ?? undefined}>
      <span className={`dot ${tone}`} />
      <span>
        <span className="health-title">Cloudflare</span>
        <span className="health-label">{label}</span>
      </span>
    </a>
  )
}
