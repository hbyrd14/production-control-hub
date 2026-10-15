import { useEffect } from 'react';
import type { SessionUser } from '@pch/shared';
import { api } from './lib/api';
import { gatewaySocket } from './lib/socket';
import { isAdmin, useApp } from './lib/store';
import { Login } from './views/Login';
import { Operator } from './views/Operator';
import { Settings } from './views/Settings';
import { Editor } from './views/Editor';

export function App() {
  const user = useApp((s) => s.user);
  const authChecked = useApp((s) => s.authChecked);
  const route = useApp((s) => s.route);
  const setAuth = useApp((s) => s.setAuth);

  useEffect(() => {
    let cancelled = false;
    const check = () =>
      api<{ user: SessionUser | null; setupRequired: boolean; version: string }>('GET', '/api/auth/state')
        .then((s) => !cancelled && setAuth(s.user, s.setupRequired, s.version))
        .catch(() => {
          if (cancelled) return;
          useApp.setState({ authChecked: true });
          setTimeout(check, 3000);
        });
    void check();
    return () => {
      cancelled = true;
    };
  }, [setAuth]);

  useEffect(() => {
    if (user) gatewaySocket.start();
    else gatewaySocket.stop();
  }, [user]);

  if (!authChecked) return <div className="boot">Connecting to gateway…</div>;
  if (!user) return (
    <>
      <Login />
      <Toasts />
    </>
  );

  return (
    <>
      {route === 'settings' ? <Settings /> : route === 'edit' && isAdmin(user) ? <Editor /> : <Operator />}
      <Toasts />
    </>
  );
}

function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismiss);
  return (
    <div className="toasts" aria-live="assertive">
      {toasts.map((t) => (
        <button key={t.id} type="button" className={`toast toast-${t.level}`} onClick={() => dismiss(t.id)} data-testid="toast">
          {t.message}
        </button>
      ))}
    </div>
  );
}
