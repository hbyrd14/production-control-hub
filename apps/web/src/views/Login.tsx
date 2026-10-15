import { useState } from 'react';
import type { SessionUser } from '@pch/shared';
import { api, errorMessage } from '../lib/api';
import { useApp } from '../lib/store';

export function Login() {
  const setupRequired = useApp((s) => s.setupRequired);
  const setAuth = useApp((s) => s.setAuth);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (setupRequired && password !== confirm) return setError('The passwords do not match.');
    setBusy(true);
    try {
      const res = setupRequired
        ? await api<{ user: SessionUser }>('POST', '/api/auth/setup', { username, password, setupCode: code.trim() })
        : await api<{ user: SessionUser }>('POST', '/api/auth/login', { username, password });
      setAuth(res.user, false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="login-mark" aria-hidden>
          {Array.from({ length: 8 }, (_, i) => (
            <i key={i} className={i === 0 ? 'red' : i === 5 ? 'green' : ''} />
          ))}
        </div>
        <h1>Production Control Hub</h1>
        <p className="muted">{setupRequired ? 'Create the administrator account. The setup code is printed in the gateway console.' : 'Sign in to operate the control surface.'}</p>
        {setupRequired && (
          <label>
            Setup code
            <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" required data-testid="setup-code" />
          </label>
        )}
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" autoCorrect="off" required data-testid="username" />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={setupRequired ? 'new-password' : 'current-password'} required data-testid="password" />
        </label>
        {setupRequired && (
          <label>
            Confirm password
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required minLength={10} />
          </label>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn-primary" disabled={busy} data-testid="sign-in">
          {setupRequired ? 'Create admin account' : busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
