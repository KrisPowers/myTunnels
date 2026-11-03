import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, errorText, type Account, type Settings as SettingsData, type Status } from './api'

export default function Settings({ status, onChange }: { status: Status | null; onChange: () => void }) {
  const [settings, setSettings] = useState<SettingsData | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    api<SettingsData>('/settings')
      .then(setSettings)
      .catch((e) => setError(errorText(e)))
  }, [])
  useEffect(load, [load])

  const saved = () => {
    load()
    onChange()
  }

  return (
    <>
      <header className="page-head">
        <h1>Settings</h1>
        <p>Cloudflare connection and how the gateway reaches your apps.</p>
      </header>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {settings && <CloudflarePanel settings={settings} onSaved={saved} />}
      {settings && <NetworkPanel settings={settings} status={status} onSaved={saved} />}
      {status && status.logs.length > 0 && (
        <section className="panel">
          <div className="panel-head">
            <h2>Connector log</h2>
            <span className="muted">{status.restarts} restarts</span>
          </div>
          <pre className="log">{status.logs.slice(-60).join('\n')}</pre>
        </section>
      )}
    </>
  )
}

function CloudflarePanel({ settings, onSaved }: { settings: SettingsData; onSaved: () => void }) {
  const cf = settings.cloudflare
  const [token, setToken] = useState('')
  const [accounts, setAccounts] = useState<Account[]>([])
  const [accountId, setAccountId] = useState(cf.account_id ?? '')
  const [tunnelName, setTunnelName] = useState(cf.tunnel_name ?? 'homelab')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState('')

  const findAccounts = async () => {
    setBusy(true)
    setError('')
    try {
      const list = await api<Account[]>('/cloudflare/accounts', 'POST', { api_token: token || null })
      setAccounts(list)
      if (list.length === 0) setError('This token cannot see any account.')
      else if (!list.some((a) => a.id === accountId)) setAccountId(list[0].id)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    setDone('')
    try {
      await api('/settings/cloudflare', 'PUT', {
        api_token: token || null,
        account_id: accountId,
        tunnel_name: tunnelName,
      })
      setToken('')
      setDone('Connected. The connector is starting.')
      onSaved()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const accountOptions = accounts.length
    ? accounts
    : cf.account_id
      ? [{ id: cf.account_id, name: cf.account_name ?? cf.account_id }]
      : []

  return (
    <form className="panel" onSubmit={save}>
      <div className="panel-head">
        <h2>Cloudflare</h2>
        {cf.configured && <span className="badge ok">Connected</span>}
      </div>
      {cf.configured && (
        <dl className="facts compact">
          <div>
            <dt>Account</dt>
            <dd>{cf.account_name}</dd>
          </div>
          <div>
            <dt>Tunnel</dt>
            <dd>
              {cf.tunnel_name} <span className="mono muted">{cf.tunnel_id}</span>
            </dd>
          </div>
        </dl>
      )}
      <details className="help" open={!cf.configured}>
        <summary>Creating the API token</summary>
        <p>
          In the Cloudflare dashboard open My Profile, API Tokens, Create Token, Custom token, and grant:
        </p>
        <ul>
          <li>Account, Cloudflare Tunnel, Edit</li>
          <li>Zone, DNS, Edit</li>
          <li>Zone, Zone, Read</li>
        </ul>
        <p>Limit zone resources to the domains you want to publish on.</p>
      </details>
      <label className="field">
        <span>API token</span>
        <input
          type="password"
          autoComplete="off"
          placeholder={cf.token_set ? 'Saved. Leave empty to keep it.' : 'Paste the token'}
          value={token}
          onChange={(e) => setToken(e.target.value.trim())}
        />
      </label>
      <div className="target-row">
        <label className="field grow">
          <span>Account</span>
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {accountOptions.length === 0 && <option value="">Find accounts first</option>}
            {accountOptions.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="ghost align-end"
          onClick={findAccounts}
          disabled={busy || (!token && !cf.token_set)}
        >
          Find accounts
        </button>
      </div>
      <label className="field">
        <span>Tunnel name</span>
        <input value={tunnelName} onChange={(e) => setTunnelName(e.target.value)} />
        <small>Created in your account if it does not exist yet.</small>
      </label>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {done && <div className="notice ok">{done}</div>}
      <div className="form-actions">
        <button className="primary" disabled={busy || !accountId || !tunnelName}>
          {cf.configured ? 'Save' : 'Connect'}
        </button>
      </div>
    </form>
  )
}

function NetworkPanel(props: { settings: SettingsData; status: Status | null; onSaved: () => void }) {
  const { settings, status } = props
  const [host, setHost] = useState(settings.upstream_host)
  const [trusted, setTrusted] = useState(settings.trusted_networks)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    setDone(false)
    try {
      await api('/settings/network', 'PUT', { upstream_host: host, trusted_networks: trusted })
      setDone(true)
      props.onSaved()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="panel" onSubmit={save}>
      <div className="panel-head">
        <h2>Network</h2>
      </div>
      <label className="field">
        <span>Apps host</span>
        <input value={host} onChange={(e) => setHost(e.target.value.trim())} />
        <small>
          Where local ports live, as seen from the gateway container. Default:{' '}
          <span className="mono">{settings.default_upstream_host}</span>
        </small>
      </label>
      <div className="field">
        <span>This host's public addresses</span>
        <div className="mono ips">
          {status?.public_ips.length ? status.public_ips.join(', ') : 'Not detected yet'}
        </div>
        <small>Visitors arriving from these count as the same network.</small>
      </div>
      <label className="field">
        <span>Also trusted as home network</span>
        <textarea
          rows={3}
          placeholder={'One network per line, for example\n100.64.0.0/10'}
          value={trusted}
          onChange={(e) => setTrusted(e.target.value)}
        />
        <small>Public ranges such as a VPN exit or a second connection.</small>
      </label>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {done && <div className="notice ok">Saved.</div>}
      <div className="form-actions">
        <button className="primary" disabled={busy || !host}>
          Save
        </button>
      </div>
    </form>
  )
}
