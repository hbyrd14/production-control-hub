import { useCallback, useEffect, useState } from 'react';
import type { CompanionSettings, CompanionStatus, GatewaySettings, Profile, Role } from '@pch/shared';
import { api, errorMessage } from '../lib/api';
import { gatewaySocket } from '../lib/socket';
import { isAdmin, useApp } from '../lib/store';
import { setPrefs, usePrefs } from '../lib/prefs';
import { StatusLamp } from '../components/StatusLamp';

const DEFAULT_COMPANION: CompanionSettings = {
  host: '',
  port: 16622,
  transport: 'tcp',
  connectTimeoutMs: 5000,
  reconnect: { initialDelayMs: 1000, maxDelayMs: 30000, factor: 2 },
  bitmapSize: 144,
  httpFallbackPort: null,
  enabled: true,
};

type Section = 'companion' | 'diagnostics' | 'gateway' | 'backup' | 'device' | 'account' | 'users' | 'audit';

export function Settings() {
  const user = useApp((s) => s.user);
  const setRoute = useApp((s) => s.setRoute);
  const admin = isAdmin(user);
  const [section, setSection] = useState<Section>('companion');
  const sections: [Section, string, boolean][] = [
    ['companion', 'Companion connection', true],
    ['diagnostics', 'Diagnostics', true],
    ['gateway', 'Gateway', admin],
    ['backup', 'Profile backups', true],
    ['device', 'This device', true],
    ['account', 'Account', true],
    ['users', 'Operators', admin],
    ['audit', 'Activity log', admin],
  ];

  return (
    <div className="page">
      <header className="bar">
        <div className="bar-title">
          <button type="button" className="btn-ghost" onClick={() => setRoute('operate')} data-testid="back-to-surface">
            ← Surface
          </button>
          <h1 className="page-heading">Settings</h1>
        </div>
        <StatusLamp />
      </header>
      <div className="settings">
        <nav className="settings-nav" aria-label="Settings sections">
          {sections
            .filter(([, , show]) => show)
            .map(([id, label]) => (
              <button key={id} type="button" className={section === id ? 'active' : ''} onClick={() => setSection(id)}>
                {label}
              </button>
            ))}
        </nav>
        <section className="settings-body">
          {section === 'companion' && <CompanionSection admin={admin} />}
          {section === 'diagnostics' && <Diagnostics admin={admin} />}
          {section === 'gateway' && admin && <GatewaySection />}
          {section === 'backup' && <BackupSection admin={admin} />}
          {section === 'device' && <DeviceSection />}
          {section === 'account' && <AccountSection />}
          {section === 'users' && admin && <UsersSection />}
          {section === 'audit' && admin && <AuditSection />}
        </section>
      </div>
    </div>
  );
}

function useAsync<T>(fn: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    fn()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(errorMessage(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(reload, [reload]);
  return { data, error, reload, setData };
}

function CompanionSection({ admin }: { admin: boolean }) {
  const toast = useApp((s) => s.toast);
  const status = useApp((s) => s.companion);
  const [form, setForm] = useState<CompanionSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<{ settings: CompanionSettings | null }>('GET', '/api/settings/companion')
      .then((r) => setForm(r.settings ?? DEFAULT_COMPANION))
      .catch((e) => setErr(errorMessage(e)));
  }, []);

  if (!form) return <p className="muted">{err ?? 'Loading…'}</p>;
  const set = <K extends keyof CompanionSettings>(k: K, v: CompanionSettings[K]) => setForm({ ...form, [k]: v });

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api('PUT', '/api/settings/companion', form);
      toast('info', 'Companion connection saved');
    } catch (e2) {
      setErr(errorMessage(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form" onSubmit={save}>
      <h2>Companion connection</h2>
      <p className="muted">
        The gateway connects to Companion's Satellite listener. Browsers only ever talk to this gateway. Companion can run on this computer or another one on the
        production network.
      </p>
      <fieldset disabled={!admin}>
        <div className="row">
          <label className="grow">
            Companion address
            <input value={form.host} onChange={(e) => set('host', e.target.value.trim())} placeholder="192.168.1.20" required data-testid="companion-host" />
          </label>
          <label>
            Transport
            <select
              value={form.transport}
              onChange={(e) => {
                const t = e.target.value as 'tcp' | 'websocket';
                setForm({ ...form, transport: t, port: t === 'tcp' && form.port === 16623 ? 16622 : t === 'websocket' && form.port === 16622 ? 16623 : form.port });
              }}
            >
              <option value="tcp">Satellite TCP</option>
              <option value="websocket">Satellite WebSocket</option>
            </select>
          </label>
          <label>
            Port
            <input type="number" min={1} max={65535} value={form.port} onChange={(e) => set('port', Number(e.target.value))} required data-testid="companion-port" />
          </label>
        </div>
        <div className="row">
          <label>
            Connect timeout (ms)
            <input type="number" min={500} max={60000} value={form.connectTimeoutMs} onChange={(e) => set('connectTimeoutMs', Number(e.target.value))} />
          </label>
          <label>
            First retry after (ms)
            <input type="number" min={100} max={60000} value={form.reconnect.initialDelayMs} onChange={(e) => set('reconnect', { ...form.reconnect, initialDelayMs: Number(e.target.value) })} />
          </label>
          <label>
            Longest retry gap (ms)
            <input type="number" min={500} max={300000} value={form.reconnect.maxDelayMs} onChange={(e) => set('reconnect', { ...form.reconnect, maxDelayMs: Number(e.target.value) })} />
          </label>
          <label>
            Backoff factor
            <input type="number" step={0.1} min={1.1} max={5} value={form.reconnect.factor} onChange={(e) => set('reconnect', { ...form.reconnect, factor: Number(e.target.value) })} />
          </label>
        </div>
        <div className="row">
          <label>
            Key image size (px)
            <input type="number" min={72} max={288} step={8} value={form.bitmapSize} onChange={(e) => set('bitmapSize', Number(e.target.value))} />
          </label>
          <label>
            HTTP fallback port
            <input
              type="number"
              min={1}
              max={65535}
              placeholder="off"
              value={form.httpFallbackPort ?? ''}
              onChange={(e) => set('httpFallbackPort', e.target.value ? Number(e.target.value) : null)}
            />
          </label>
          <label className="check">
            <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} />
            Connect to Companion
          </label>
        </div>
        <p className="hint">
          HTTP fallback is only used for mapped keys when Companion's Satellite API is older than 1.10. It can press keys but cannot show their images. Leave it off
          unless you need it.
        </p>
      </fieldset>
      {err && <p className="form-error">{err}</p>}
      <div className="actions">
        {admin && (
          <button type="submit" className="btn-primary" disabled={busy} data-testid="companion-save">
            Save and connect
          </button>
        )}
        <button type="button" className="btn" onClick={() => api('POST', '/api/companion/reconnect').catch((e) => toast('error', errorMessage(e)))}>
          Reconnect now
        </button>
      </div>
      {status && <StatusTable status={status} />}
    </form>
  );
}

function apiAtLeast110(v: string | null): boolean {
  if (!v) return false;
  const [maj = 0, min = 0] = v.split('.').map(Number);
  return maj > 1 || (maj === 1 && min >= 10);
}

function StatusTable({ status }: { status: CompanionStatus }) {
  const rows: [string, string][] = [
    ['State', status.state],
    ['Address', status.host ? `${status.transport} ${status.host}:${status.port}` : '—'],
    ['Companion version', status.companionVersion ?? '—'],
    ['Satellite API', status.apiVersion ?? '—'],
    [
      'Mapped keys (subscriptions)',
      status.supportsSubscriptions
        ? 'Available'
        : status.state === 'connected' && apiAtLeast110(status.apiVersion)
          ? "Off in Companion — enable button subscriptions in Companion's Settings → Satellite"
          : 'Not available (needs Satellite API 1.10+)',
    ],
    ['Page change from PCH', status.supportsPageChange ? 'Supported (enable it on the surface in Companion)' : 'Not available'],
    ['Capabilities', status.capabilities.join(', ') || '—'],
    ['Last error', status.lastError ?? '—'],
  ];
  return (
    <table className="kv" data-testid="companion-status">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <th>{k}</th>
            <td>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface Diag {
  version: string;
  node: string;
  uptimeSec: number;
  clients: number;
  tls: boolean;
  bind?: { host: string; port: number; exposure: string; message: string };
  database?: { path: string; schemaVersion: number };
  clientList?: { id: string; user: string; role: string; ip: string | null; profileId: string | null; pageId: string | null }[];
  protocolLog?: { t: number; dir: string; text: string }[];
  companion: CompanionStatus;
}

function Diagnostics({ admin }: { admin: boolean }) {
  const { data, error, reload } = useAsync(() => api<Diag>('GET', '/api/diagnostics'));
  const socket = useApp((s) => s.socket);
  const [rtt, setRtt] = useState<number | null>(null);
  useEffect(() => {
    const t = setInterval(reload, 3000);
    return () => clearInterval(t);
  }, [reload]);
  useEffect(() => {
    const t0 = performance.now();
    fetch('/api/health', { cache: 'no-store' })
      .then(() => setRtt(Math.round(performance.now() - t0)))
      .catch(() => setRtt(null));
  }, [data]);
  if (!data) return <p className="muted">{error ?? 'Loading…'}</p>;
  return (
    <div className="form">
      <h2>Diagnostics</h2>
      <table className="kv">
        <tbody>
          <tr>
            <th>Gateway version</th>
            <td>{data.version}</td>
          </tr>
          <tr>
            <th>Browser link</th>
            <td>
              {socket} {rtt !== null && `· ${rtt} ms round trip`}
            </td>
          </tr>
          <tr>
            <th>Connected browsers</th>
            <td>{data.clients}</td>
          </tr>
          <tr>
            <th>HTTPS</th>
            <td>{data.tls ? 'Enabled' : 'Off (iPad wake lock and offline shell need HTTPS)'}</td>
          </tr>
          <tr>
            <th>Uptime</th>
            <td>{Math.floor(data.uptimeSec / 60)} min</td>
          </tr>
          <tr>
            <th>Node.js</th>
            <td>{data.node}</td>
          </tr>
          {data.bind && (
            <tr>
              <th>Network binding</th>
              <td>
                {data.bind.host}:{data.bind.port} — {data.bind.message}
              </td>
            </tr>
          )}
          {data.database && (
            <tr>
              <th>Database</th>
              <td>
                {data.database.path} (schema v{data.database.schemaVersion})
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <StatusTable status={data.companion} />
      {admin && data.clientList && (
        <>
          <h3>Browsers</h3>
          <table className="list">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Address</th>
                <th>Page</th>
              </tr>
            </thead>
            <tbody>
              {data.clientList.map((c) => (
                <tr key={c.id}>
                  <td>{c.user}</td>
                  <td>{c.role}</td>
                  <td>{c.ip}</td>
                  <td>{c.pageId ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {admin && data.protocolLog && (
        <>
          <h3>Satellite protocol log</h3>
          <pre className="log" data-testid="protocol-log">
            {data.protocolLog
              .slice(-80)
              .map((l) => `${new Date(l.t).toLocaleTimeString()} ${l.dir === 'in' ? '←' : l.dir === 'out' ? '→' : '•'} ${l.text}`)
              .join('\n')}
          </pre>
        </>
      )}
    </div>
  );
}

function GatewaySection() {
  const toast = useApp((s) => s.toast);
  const { data, setData } = useAsync(() => api<GatewaySettings>('GET', '/api/settings/gateway'));
  const profiles = useAsync(() => api<Profile[]>('GET', '/api/profiles'));
  if (!data) return <p className="muted">Loading…</p>;
  const save = async (next: GatewaySettings) => {
    try {
      setData(await api<GatewaySettings>('PUT', '/api/settings/gateway', next));
      toast('info', 'Gateway settings saved');
    } catch (e) {
      toast('error', errorMessage(e));
    }
  };
  return (
    <div className="form">
      <h2>Gateway</h2>
      <label>
        Page navigation across browsers
        <select value={data.navigationMode} onChange={(e) => void save({ ...data, navigationMode: e.target.value as GatewaySettings['navigationMode'] })}>
          <option value="per-client">Each browser navigates on its own</option>
          <option value="shared">All browsers follow the same page</option>
        </select>
      </label>
      <label>
        Profile shown to new browsers
        <select value={data.defaultProfileId ?? ''} onChange={(e) => void save({ ...data, defaultProfileId: e.target.value || null })}>
          <option value="">First profile</option>
          {profiles.data?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function BackupSection({ admin }: { admin: boolean }) {
  const { data } = useAsync(() => api<Profile[]>('GET', '/api/profiles'));
  const version = useApp((s) => s.version);
  return (
    <div className="form">
      <h2>Profile backups</h2>
      <p className="muted">
        Each profile exports as a file that can be imported on any Production Control Hub{admin ? ' (Edit → Profile → Import from file)' : ''}. The whole database
        lives in the gateway's data folder; copy that folder while the gateway is stopped for a full backup.
      </p>
      <table className="list">
        <thead>
          <tr>
            <th>Profile</th>
            <th>Type</th>
            <th>Revision</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data?.map((p) => (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td>{p.kind === 'surface' ? 'Companion surface' : 'Mapped'}</td>
              <td>{p.revision}</td>
              <td>
                <a href={`/api/profiles/${p.id}/export`} download>
                  Export
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">Production Control Hub {version}</p>
    </div>
  );
}

function DeviceSection() {
  const prefs = usePrefs();
  return (
    <div className="form">
      <h2>This device</h2>
      <p className="muted">These preferences are stored in this browser only.</p>
      <label className="check">
        <input type="checkbox" checked={prefs.haptics} onChange={(e) => setPrefs({ haptics: e.target.checked })} />
        Vibrate on key press (Android)
      </label>
      <label className="check">
        <input type="checkbox" checked={prefs.keepAwake} onChange={(e) => setPrefs({ keepAwake: e.target.checked })} />
        Keep the screen awake while operating (needs HTTPS)
      </label>
      <label className="check">
        <input type="checkbox" checked={prefs.showLocations} onChange={(e) => setPrefs({ showLocations: e.target.checked })} />
        Show Companion page/row/column on keys
      </label>
    </div>
  );
}

function AccountSection() {
  const user = useApp((s) => s.user);
  const setAuth = useApp((s) => s.setAuth);
  const toast = useApp((s) => s.toast);
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const signOut = async () => {
    gatewaySocket.stop();
    await api('POST', '/api/auth/logout').catch(() => {});
    setAuth(null, false);
  };
  return (
    <div className="form">
      <h2>Account</h2>
      <p>
        Signed in as <strong>{user?.username}</strong> ({user?.role}).
      </p>
      <form
        className="row"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api('POST', '/api/me/password', { currentPassword: cur, newPassword: next });
            toast('info', 'Password changed');
            setCur('');
            setNext('');
          } catch (err) {
            toast('error', errorMessage(err));
          }
        }}
      >
        <label>
          Current password
          <input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" required />
        </label>
        <label>
          New password
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={10} required />
        </label>
        <button type="submit" className="btn">
          Change password
        </button>
      </form>
      <div className="actions">
        <button type="button" className="btn" onClick={() => void signOut()} data-testid="sign-out">
          Sign out
        </button>
      </div>
    </div>
  );
}

interface PublicUser {
  id: string;
  username: string;
  role: Role;
  disabled: boolean;
  createdAt: string;
}

function UsersSection() {
  const toast = useApp((s) => s.toast);
  const me = useApp((s) => s.user);
  const { data, reload } = useAsync(() => api<PublicUser[]>('GET', '/api/users'));
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [role, setRole] = useState<Role>('operator');
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast('info', ok);
      reload();
    } catch (e) {
      toast('error', errorMessage(e));
    }
  };
  return (
    <div className="form">
      <h2>Operators</h2>
      <p className="muted">Operators can press keys. Viewers see the surface read-only. Admins can also edit profiles and settings.</p>
      <table className="list">
        <thead>
          <tr>
            <th>Username</th>
            <th>Role</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data?.map((u) => (
            <tr key={u.id}>
              <td>{u.username}</td>
              <td>
                <select value={u.role} disabled={u.id === me?.id} onChange={(e) => void act(() => api('PATCH', `/api/users/${u.id}`, { role: e.target.value }), 'Role updated')}>
                  <option value="admin">Admin</option>
                  <option value="operator">Operator</option>
                  <option value="viewer">Viewer</option>
                </select>
              </td>
              <td>{u.disabled ? 'Disabled' : 'Active'}</td>
              <td className="cell-actions">
                {u.id !== me?.id && (
                  <>
                    <button type="button" className="btn-small" onClick={() => void act(() => api('PATCH', `/api/users/${u.id}`, { disabled: !u.disabled }), u.disabled ? 'Account enabled' : 'Account disabled')}>
                      {u.disabled ? 'Enable' : 'Disable'}
                    </button>
                    <button
                      type="button"
                      className="btn-small"
                      onClick={() => {
                        const p = prompt(`New password for ${u.username} (10+ characters)`);
                        if (p) void act(() => api('PATCH', `/api/users/${u.id}`, { password: p }), 'Password reset');
                      }}
                    >
                      Reset password
                    </button>
                    <button
                      type="button"
                      className="btn-small danger"
                      onClick={() => confirm(`Delete ${u.username}?`) && void act(() => api('DELETE', `/api/users/${u.id}`), 'Account deleted')}
                    >
                      Delete
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void act(() => api('POST', '/api/users', { username: name, password: pw, role }), `Added ${name}`).then(() => {
            setName('');
            setPw('');
          });
        }}
      >
        <label>
          Username
          <input value={name} onChange={(e) => setName(e.target.value)} autoCapitalize="none" required />
        </label>
        <label>
          Password
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} minLength={10} autoComplete="new-password" required />
        </label>
        <label>
          Role
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="operator">Operator</option>
            <option value="viewer">Viewer</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <button type="submit" className="btn">
          Add account
        </button>
      </form>
    </div>
  );
}

function AuditSection() {
  const { data, reload } = useAsync(() => api<{ id: number; ts: string; username: string | null; action: string; detail: unknown; ip: string | null }[]>('GET', '/api/audit?limit=200'));
  return (
    <div className="form">
      <h2>Activity log</h2>
      <div className="actions">
        <button type="button" className="btn" onClick={reload}>
          Refresh
        </button>
      </div>
      <table className="list">
        <thead>
          <tr>
            <th>Time</th>
            <th>User</th>
            <th>Action</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {data?.map((a) => (
            <tr key={a.id}>
              <td>{new Date(a.ts).toLocaleString()}</td>
              <td>{a.username ?? '—'}</td>
              <td>{a.action}</td>
              <td className="detail">{a.detail ? JSON.stringify(a.detail) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
