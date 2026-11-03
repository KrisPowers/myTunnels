import { useState, type FormEvent } from 'react'
import { api, errorText } from './api'

export default function Login({ setup, onDone }: { setup: boolean; onDone: () => void }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (setup && password !== confirm) {
      setError('The passwords do not match')
      return
    }
    setBusy(true)
    setError('')
    try {
      await api(setup ? '/auth/setup' : '/auth/login', 'POST', { password })
      onDone()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <form className="panel login-card" onSubmit={submit}>
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          myTunnels
        </div>
        <h1>{setup ? 'Create the admin password' : 'Sign in'}</h1>
        {setup && <p className="muted">This password protects the admin panel. Use at least 10 characters.</p>}
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            autoFocus
            autoComplete={setup ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {setup && (
          <label className="field">
            <span>Confirm password</span>
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </label>
        )}
        {error && <div className="error">{error}</div>}
        <button className="primary" disabled={busy || !password}>
          {setup ? 'Create password' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
