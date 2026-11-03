import { useCallback, useEffect, useState } from 'react'
import { ago, api, errorText, type Device, type DeviceStatus, type Route } from './api'

const FILTERS: { id: DeviceStatus; label: string }[] = [
  { id: 'pending', label: 'Waiting' },
  { id: 'approved', label: 'Approved' },
  { id: 'denied', label: 'Denied' },
]

export default function Devices({ onChange }: { onChange: () => void }) {
  const [devices, setDevices] = useState<Device[] | null>(null)
  const [routes, setRoutes] = useState<Route[]>([])
  const [filter, setFilter] = useState<DeviceStatus>('pending')
  const [error, setError] = useState('')

  const load = useCallback(() => {
    api<Device[]>('/devices')
      .then(setDevices)
      .catch((e) => setError(errorText(e)))
    onChange()
  }, [onChange])

  useEffect(() => {
    load()
    api<Route[]>('/routes').then(setRoutes).catch(() => {})
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
  }, [load])

  const update = async (id: string, patch: Record<string, unknown>) => {
    setError('')
    try {
      await api(`/devices/${id}`, 'PATCH', patch)
      load()
    } catch (e) {
      setError(errorText(e))
    }
  }

  const remove = async (device: Device) => {
    if (!confirm(`Forget device ${device.id}? It will have to ask again.`)) return
    try {
      await api(`/devices/${device.id}`, 'DELETE')
      load()
    } catch (e) {
      setError(errorText(e))
    }
  }

  const shown = (devices ?? []).filter((d) => d.status === filter)
  const count = (s: DeviceStatus) => (devices ?? []).filter((d) => d.status === s).length

  return (
    <>
      <header className="page-head">
        <h1>Devices</h1>
        <p>Browsers that asked to open a tunnel that requires an approved device.</p>
      </header>

      <div className="tabs" role="tablist">
        {FILTERS.map((f) => (
          <button key={f.id} role="tab" aria-selected={filter === f.id} onClick={() => setFilter(f.id)}>
            {f.label}
            <span className="tab-count">{count(f.id)}</span>
          </button>
        ))}
      </div>

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {devices && shown.length === 0 && (
        <div className="panel">
          <p className="empty">
            {filter === 'pending'
              ? 'No device is waiting. Open a tunnel that requires approved devices from the device you want to add.'
              : 'None.'}
          </p>
        </div>
      )}
      <div className="device-list">
        {shown.map((device) => (
          <DeviceCard
            key={device.id}
            device={device}
            routes={routes}
            onUpdate={(patch) => update(device.id, patch)}
            onRemove={() => remove(device)}
          />
        ))}
      </div>
    </>
  )
}

function DeviceCard(props: {
  device: Device
  routes: Route[]
  onUpdate: (patch: Record<string, unknown>) => void
  onRemove: () => void
}) {
  const { device, routes, onUpdate } = props
  const info = device.info ?? {}
  const [name, setName] = useState(device.name)
  const gated = routes.filter((r) => r.require_device)

  useEffect(() => setName(device.name), [device.name])

  const toggleRoute = (id: string, on: boolean) => {
    const ids = on ? [...device.route_ids, id] : device.route_ids.filter((r) => r !== id)
    onUpdate({ route_ids: ids })
  }

  const facts: [string, string | undefined][] = [
    ['Platform', [info.platform, info.mobile ? 'mobile' : null].filter(Boolean).join(', ')],
    ['GPU', info.webglRenderer || info.webglVendor],
    ['CPU threads', info.hardwareConcurrency?.toString()],
    ['Memory', info.deviceMemory ? `${info.deviceMemory} GB or more` : undefined],
    [
      'Screen',
      info.screen ? `${info.screen.width} x ${info.screen.height} at ${info.screen.pixelRatio}x` : undefined,
    ],
    ['Time zone', info.timezone],
    ['Languages', info.languages?.join(', ')],
    ['Browser', info.userAgent],
  ]

  return (
    <article className={`panel device ${device.note ? 'flagged' : ''}`}>
      <div className="device-head">
        <div>
          <div className="device-id mono">{device.id}</div>
          <input
            className="name-input"
            placeholder="Name this device"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name !== device.name && onUpdate({ name })}
            aria-label="Device name"
          />
        </div>
        <div className="device-actions">
          {device.status !== 'approved' && (
            <button className="primary" onClick={() => onUpdate({ status: 'approved' })}>
              Approve
            </button>
          )}
          {device.status !== 'denied' && (
            <button className="ghost" onClick={() => onUpdate({ status: 'denied' })}>
              {device.status === 'approved' ? 'Revoke' : 'Deny'}
            </button>
          )}
          <button className="ghost danger" onClick={props.onRemove}>
            Forget
          </button>
        </div>
      </div>

      {device.note && <div className="notice warn">{device.note}. Check the details below before approving again.</div>}

      <div className="device-meta">
        <span>
          Seen <strong>{ago(device.last_seen)}</strong>
        </span>
        <span>
          From <strong className="mono">{device.last_ip ?? 'unknown'}</strong>
          {device.country && ` (${device.country})`}
        </span>
        {device.first_host && (
          <span>
            First asked for <strong className="mono">{device.first_host}</strong>
          </span>
        )}
      </div>

      <dl className="facts">
        {facts
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
      </dl>

      <div className="grants">
        <div className="grants-head">Can open</div>
        <label className="check inline">
          <input
            type="checkbox"
            checked={device.all_routes}
            onChange={(e) => onUpdate({ all_routes: e.target.checked })}
          />
          <span>Every tunnel</span>
        </label>
        {!device.all_routes &&
          (gated.length === 0 ? (
            <p className="hint">No tunnel requires approved devices yet.</p>
          ) : (
            gated.map((r) => (
              <label key={r.id} className="check inline">
                <input
                  type="checkbox"
                  checked={device.route_ids.includes(r.id)}
                  onChange={(e) => toggleRoute(r.id, e.target.checked)}
                />
                <span className="mono">{r.hostname}</span>
              </label>
            ))
          ))}
      </div>
    </article>
  )
}
