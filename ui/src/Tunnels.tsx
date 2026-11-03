import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, errorText, type Route, type Zone } from './api'
import { AccessBadges, AccessFields, type AccessValue } from './Access'

const NO_ACCESS_RULES: AccessValue = { require_lan: false, require_device: false, policy_mode: 'all' }

export default function Tunnels({ configured }: { configured: boolean | undefined }) {
  const [routes, setRoutes] = useState<Route[] | null>(null)
  const [zones, setZones] = useState<Zone[]>([])
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<string | null>(null)

  const load = useCallback(() => {
    api<Route[]>('/routes')
      .then(setRoutes)
      .catch((e) => setError(errorText(e)))
  }, [])

  useEffect(load, [load])
  useEffect(() => {
    if (configured) api<Zone[]>('/zones').then(setZones).catch((e) => setError(errorText(e)))
  }, [configured])

  const remove = async (route: Route) => {
    if (!confirm(`Remove ${route.hostname}? Its DNS record is deleted from Cloudflare.`)) return
    try {
      await api(`/routes/${route.id}`, 'DELETE')
      load()
    } catch (e) {
      setError(errorText(e))
    }
  }

  return (
    <>
      <header className="page-head">
        <h1>Tunnels</h1>
        <p>Publish a local port on one of your domains, without opening a port on the router.</p>
      </header>

      {configured === false && (
        <div className="notice">
          Connect your Cloudflare account in <a href="#/settings">Settings</a> before adding tunnels.
        </div>
      )}
      {configured && <AddTunnel zones={zones} onAdded={load} />}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}

      <section className="panel">
        <div className="panel-head">
          <h2>Published</h2>
          <span className="muted">{routes ? `${routes.length} total` : ''}</span>
        </div>
        {routes && routes.length === 0 && <p className="empty">Nothing is published yet.</p>}
        {routes && routes.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Address</th>
                  <th>Local target</th>
                  <th>Access</th>
                  <th>State</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {routes.map((route) =>
                  editing === route.id ? (
                    <EditRow
                      key={route.id}
                      route={route}
                      onDone={() => {
                        setEditing(null)
                        load()
                      }}
                    />
                  ) : (
                    <tr key={route.id}>
                      <td>
                        <a className="mono" href={`https://${route.hostname}`} target="_blank" rel="noreferrer">
                          {route.hostname}
                        </a>
                      </td>
                      <td className="mono muted">
                        {route.target_scheme === 'https' ? 'https://' : ''}
                        {route.target_host ?? 'host'}:{route.target_port}
                      </td>
                      <td>
                        <AccessBadges value={route} />
                      </td>
                      <td>
                        <span className={`badge ${route.enabled ? 'ok' : ''}`}>{route.enabled ? 'Live' : 'Off'}</span>
                      </td>
                      <td className="actions">
                        <button className="ghost" onClick={() => setEditing(route.id)}>
                          Edit
                        </button>
                        <button className="ghost danger" onClick={() => remove(route)}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  )
}

function AddTunnel({ zones, onAdded }: { zones: Zone[]; onAdded: () => void }) {
  const [subdomain, setSubdomain] = useState('')
  const [zoneId, setZoneId] = useState('')
  const [port, setPort] = useState('')
  const [access, setAccess] = useState<AccessValue>(NO_ACCESS_RULES)
  const [advanced, setAdvanced] = useState(false)
  const [targetHost, setTargetHost] = useState('')
  const [scheme, setScheme] = useState<'http' | 'https'>('http')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!zoneId && zones.length > 0) setZoneId(zones[0].id)
  }, [zones, zoneId])

  const zone = zones.find((z) => z.id === zoneId)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api('/routes', 'POST', {
        subdomain,
        zone_id: zoneId,
        port: Number(port),
        target_host: targetHost || null,
        target_scheme: scheme,
        ...access,
      })
      setSubdomain('')
      setPort('')
      setAccess(NO_ACCESS_RULES)
      setTargetHost('')
      setScheme('http')
      onAdded()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="panel add" onSubmit={submit}>
      <div className="panel-head">
        <h2>New tunnel</h2>
      </div>
      <div className="address-row">
        <label className="field grow">
          <span>Subdomain</span>
          <input
            placeholder="app1"
            value={subdomain}
            onChange={(e) => setSubdomain(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
            required
          />
        </label>
        <span className="dot-sep">.</span>
        <label className="field grow">
          <span>Domain</span>
          <select value={zoneId} onChange={(e) => setZoneId(e.target.value)} required>
            {zones.length === 0 && <option value="">Loading domains</option>}
            {zones.map((z) => (
              <option key={z.id} value={z.id}>
                {z.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field port">
          <span>Local port</span>
          <input
            inputMode="numeric"
            placeholder="8080"
            value={port}
            onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))}
            required
          />
        </label>
      </div>
      {subdomain && zone && (
        <p className="preview mono">
          https://{subdomain}.{zone.name} <span className="muted">to</span> {scheme}://
          {targetHost || 'host'}:{port || '?'}
        </p>
      )}

      <AccessFields value={access} onChange={setAccess} />

      <button type="button" className="link" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>
        {advanced ? 'Hide' : 'Show'} target options
      </button>
      {advanced && <TargetFields host={targetHost} scheme={scheme} onHost={setTargetHost} onScheme={setScheme} />}

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <div className="form-actions">
        <button className="primary" disabled={busy || !subdomain || !port || !zoneId}>
          {busy ? 'Publishing' : 'Publish'}
        </button>
      </div>
    </form>
  )
}

function TargetFields(props: {
  host: string
  scheme: 'http' | 'https'
  onHost: (v: string) => void
  onScheme: (v: 'http' | 'https') => void
}) {
  return (
    <div className="target-row">
      <label className="field">
        <span>Protocol</span>
        <select value={props.scheme} onChange={(e) => props.onScheme(e.target.value as 'http' | 'https')}>
          <option value="http">http</option>
          <option value="https">https (self-signed allowed)</option>
        </select>
      </label>
      <label className="field grow">
        <span>Target host</span>
        <input
          placeholder="Default host from Settings"
          value={props.host}
          onChange={(e) => props.onHost(e.target.value.trim())}
        />
      </label>
    </div>
  )
}

function EditRow({ route, onDone }: { route: Route; onDone: () => void }) {
  const [port, setPort] = useState(String(route.target_port))
  const [access, setAccess] = useState<AccessValue>(route)
  const [targetHost, setTargetHost] = useState(route.target_host ?? '')
  const [scheme, setScheme] = useState(route.target_scheme)
  const [enabled, setEnabled] = useState(route.enabled)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      await api(`/routes/${route.id}`, 'PATCH', {
        port: Number(port),
        target_host: targetHost || null,
        target_scheme: scheme,
        enabled,
        require_lan: access.require_lan,
        require_device: access.require_device,
        policy_mode: access.policy_mode,
      })
      onDone()
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  return (
    <tr className="editing">
      <td colSpan={5}>
        <div className="edit-head">
          <span className="mono">{route.hostname}</span>
          <label className="check inline">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span>Live</span>
          </label>
        </div>
        <div className="target-row">
          <label className="field port">
            <span>Local port</span>
            <input
              inputMode="numeric"
              value={port}
              onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))}
            />
          </label>
        </div>
        <TargetFields host={targetHost} scheme={scheme} onHost={setTargetHost} onScheme={setScheme} />
        <AccessFields value={access} onChange={setAccess} />
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <div className="form-actions">
          <button className="ghost" onClick={onDone} disabled={busy}>
            Cancel
          </button>
          <button className="primary" onClick={save} disabled={busy || !port}>
            Save
          </button>
        </div>
      </td>
    </tr>
  )
}
