import { useCallback, useEffect, useMemo } from 'react';
import { KEY_COUNT, type KeyView } from '@pch/shared';
import { Key } from '../components/Key';
import { KeyGrid } from '../components/KeyGrid';
import { StatusLamp } from '../components/StatusLamp';
import { gatewaySocket } from '../lib/socket';
import { api, errorMessage } from '../lib/api';
import { canPress, isAdmin, useApp } from '../lib/store';
import { getPrefs, usePrefs, useWakeLock } from '../lib/prefs';

const PLACEHOLDER: KeyView[] = Array.from({ length: KEY_COUNT }, (_, index) => ({
  index,
  source: 'empty',
  image: null,
  text: null,
  textColor: null,
  background: null,
  fontSize: null,
  pressed: false,
  stale: false,
  style: null,
  kind: 'empty',
  mode: null,
  holdMs: null,
  navAction: null,
  companionType: null,
  disabledReason: 'Connecting…',
  location: null,
}));

export function Operator() {
  const user = useApp((s) => s.user);
  const view = useApp((s) => s.view);
  const keys = useApp((s) => s.keys);
  const feedback = useApp((s) => s.feedback);
  const socket = useApp((s) => s.socket);
  const companion = useApp((s) => s.companion);
  const setRoute = useApp((s) => s.setRoute);
  const toast = useApp((s) => s.toast);
  const prefs = usePrefs();
  useWakeLock(prefs.keepAwake);

  const online = socket === 'open';
  const companionLive = online && companion?.state === 'connected';
  const operable = online && canPress(user);
  const shown = keys.length === KEY_COUNT ? keys : PLACEHOLDER;
  const keysRef = useMemo(() => ({ current: shown }), [shown]);

  const onAction = useCallback(
    (index: number, action: 'down' | 'up' | 'cancel') => {
      const k = keysRef.current[index];
      if (action === 'down') {
        if (!online) return toast('error', 'Not connected to the gateway — command not sent');
        if (!canPress(user) && k?.kind !== 'nav') return toast('warn', 'This account is read-only');
        if (k?.disabledReason) return toast('warn', k.disabledReason);
        if (getPrefs().haptics && 'vibrate' in navigator) navigator.vibrate?.(8);
      }
      gatewaySocket.send({ type: 'key', action, index });
    },
    [keysRef, online, user, toast],
  );

  // Release everything if the app is backgrounded or loses focus mid-press.
  useEffect(() => {
    const release = () => gatewaySocket.send({ type: 'releaseAll' });
    const onVis = () => document.visibilityState === 'hidden' && release();
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', release);
    window.addEventListener('blur', release);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', release);
      window.removeEventListener('blur', release);
    };
  }, []);

  const layout = view?.profile?.layout ?? { gapPx: 10, radiusPx: 10, showLabels: true, pinnedNav: true };
  const isSurface = view?.profile?.kind === 'surface';
  const nav = (action: 'next' | 'prev' | 'back' | 'companion-next' | 'companion-prev' | 'profile', target?: string) =>
    gatewaySocket.send({ type: 'nav', action, ...(target ? { target } : {}) });

  const pageTitle = isSurface ? (view?.companionPage ? `Companion page ${view.companionPage}` : 'Companion surface') : (view?.page?.name ?? '—');
  const crumbs = !isSurface && view?.nav?.folderStack.length ? view.nav.folderStack.map((id) => view.pages.find((p) => p.id === id)?.name ?? id) : [];

  return (
    <div className={`operator ${companionLive ? '' : 'is-offline'}`}>
      <header className="bar">
        <div className="bar-title">
          <label className="profile-select">
            <span className="sr-only">Profile</span>
            <select
              value={view?.profile?.id ?? ''}
              onChange={(e) => nav('profile', e.target.value)}
              disabled={!online || (view?.navigationMode === 'shared' && !canPress(user))}
              data-testid="profile-select"
            >
              {view?.profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <span className="page-name" data-testid="page-name">
            {crumbs.map((c) => (
              <span key={c} className="crumb">
                {c} /{' '}
              </span>
            ))}
            {pageTitle}
          </span>
          {!canPress(user) && <span className="pill">Read-only</span>}
        </div>
        <StatusLamp />
        <div className="bar-actions">
          {isAdmin(user) && (
            <button type="button" className="btn-ghost" onClick={() => setRoute('edit')} data-testid="edit-button">
              Edit
            </button>
          )}
          <button type="button" className="btn-ghost" onClick={() => setRoute('settings')} data-testid="settings-button">
            Settings
          </button>
          <FullscreenButton />
        </div>
      </header>

      {!companionLive && (
        <div className="offline-banner" role="alert" data-testid="offline-banner">
          {!online
            ? 'No connection to the gateway. Keys are disabled until it reconnects.'
            : companion?.state === 'disabled'
              ? 'Companion is not configured. Set the connection in Settings.'
              : `Companion is offline${companion?.lastError ? ` (${companion.lastError})` : ''}. Keys are disabled; nothing will be sent until it reconnects.`}
          {online && companion?.state === 'backoff' && canPress(user) && (
            <button
              type="button"
              className="btn-small banner-action"
              data-testid="retry-companion"
              onClick={() => api('POST', '/api/companion/reconnect').catch((e) => toast('error', errorMessage(e)))}
            >
              Retry now
            </button>
          )}
        </div>
      )}

      <main className="surface">
        <KeyGrid gap={layout.gapPx} radius={layout.radiusPx} testId="key-grid">
          {shown.map((k) => (
            <Key
              key={k.index}
              view={k}
              feedback={feedback[k.index]}
              interactive={online && (operable || k.kind === 'nav')}
              showLabels={layout.showLabels}
              showLocation={prefs.showLocations}
              onAction={onAction}
            />
          ))}
        </KeyGrid>
      </main>

      {layout.pinnedNav && (
        <nav className="pinned-nav" aria-label="Page navigation">
          {isSurface ? (
            <>
              <button type="button" onClick={() => nav('companion-prev')} disabled={!companion?.supportsPageChange || !operable}>
                Previous page
              </button>
              <span className="pinned-label">{pageTitle}</span>
              <button type="button" onClick={() => nav('companion-next')} disabled={!companion?.supportsPageChange || !operable}>
                Next page
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => nav('back')} disabled={!online || !crumbs.length} data-testid="nav-back">
                Back
              </button>
              <button type="button" onClick={() => nav('prev')} disabled={!online} data-testid="nav-prev">
                Previous page
              </button>
              <span className="pinned-label">
                {view?.pages.filter((p) => !p.isFolder).map((p) => (
                  <i key={p.id} className={p.id === (view.nav?.folderStack[0] ?? view.page?.id) ? 'dot on' : 'dot'} />
                ))}
              </span>
              <button type="button" onClick={() => nav('next')} disabled={!online} data-testid="nav-next">
                Next page
              </button>
            </>
          )}
        </nav>
      )}
    </div>
  );
}

function FullscreenButton() {
  const supported = typeof document !== 'undefined' && !!document.documentElement.requestFullscreen;
  if (!supported) return null; // iPad Safari: use "Add to Home Screen" for full screen
  return (
    <button
      type="button"
      className="btn-ghost"
      onClick={() => (document.fullscreenElement ? void document.exitFullscreen() : void document.documentElement.requestFullscreen().catch(() => {}))}
    >
      Full screen
    </button>
  );
}
