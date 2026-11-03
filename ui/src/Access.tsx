import type { PolicyMode } from './api'

export type AccessValue = { require_lan: boolean; require_device: boolean; policy_mode: PolicyMode }

export function AccessFields({ value, onChange }: { value: AccessValue; onChange: (v: AccessValue) => void }) {
  const set = (patch: Partial<AccessValue>) => onChange({ ...value, ...patch })
  return (
    <fieldset className="access">
      <legend>Who can open it</legend>
      <label className="check">
        <input type="checkbox" checked={value.require_lan} onChange={(e) => set({ require_lan: e.target.checked })} />
        <span>
          Same network as this host
          <small>Only visitors coming from this host's internet connection or a trusted network.</small>
        </span>
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={value.require_device}
          onChange={(e) => set({ require_device: e.target.checked })}
        />
        <span>
          Approved devices
          <small>New devices get an ID and wait for approval under Devices.</small>
        </span>
      </label>
      {value.require_lan && value.require_device && (
        <div className="segmented" role="radiogroup" aria-label="How the checks combine">
          <button
            type="button"
            role="radio"
            aria-checked={value.policy_mode === 'all'}
            onClick={() => set({ policy_mode: 'all' })}
          >
            Require both
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={value.policy_mode === 'any'}
            onClick={() => set({ policy_mode: 'any' })}
          >
            Either is enough
          </button>
        </div>
      )}
      {!value.require_lan && !value.require_device && (
        <p className="hint">Anyone with the link can reach it. The app's own login still applies.</p>
      )}
    </fieldset>
  )
}

export function AccessBadges({ value }: { value: AccessValue }) {
  if (!value.require_lan && !value.require_device) return <span className="badge">Open</span>
  const joiner = value.policy_mode === 'any' ? 'or' : 'and'
  return (
    <span className="badges">
      {value.require_lan && <span className="badge info">Home network</span>}
      {value.require_lan && value.require_device && <span className="joiner">{joiner}</span>}
      {value.require_device && <span className="badge info">Approved device</span>}
    </span>
  )
}
