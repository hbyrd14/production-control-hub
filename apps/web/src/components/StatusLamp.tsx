import { useEffect, useState } from 'react';
import { useApp } from '../lib/store';

/**
 * Two lamps: the browser's link to the gateway, and the gateway's link to Companion.
 * Control is live only when both are green.
 */
export function StatusLamp({ compact = false }: { compact?: boolean }) {
  const socket = useApp((s) => s.socket);
  const companion = useApp((s) => s.companion);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const gw = socket === 'open' ? 'ok' : socket === 'connecting' ? 'pending' : 'down';
  let co: 'ok' | 'pending' | 'down' | 'off' = 'down';
  let coText = 'Companion offline';
  if (socket !== 'open') {
    co = 'down';
    coText = 'Companion status unknown';
  } else if (!companion || companion.state === 'disabled') {
    co = 'off';
    coText = 'Companion not configured';
  } else if (companion.state === 'connected') {
    co = 'ok';
    coText = `Companion ${companion.companionVersion ?? ''}`.trim();
  } else if (companion.state === 'connecting') {
    co = 'pending';
    coText = 'Connecting to Companion…';
  } else if (companion.state === 'backoff' && companion.nextRetryAt) {
    const s = Math.max(0, Math.ceil((companion.nextRetryAt - Date.now()) / 1000));
    coText = `Companion offline · retry in ${s}s`;
  }
  const gwText = gw === 'ok' ? 'Gateway' : gw === 'pending' ? 'Connecting to gateway…' : 'Gateway unreachable';

  return (
    <div className={`lamps ${compact ? 'lamps-compact' : ''}`} role="status" aria-live="polite" data-testid="status-lamps">
      <span className={`lamp lamp-${gw}`} title={gwText}>
        <i />
        {!compact && <span>{gwText}</span>}
      </span>
      <span className={`lamp lamp-${co}`} title={coText} data-testid="companion-lamp" data-state={co}>
        <i />
        {!compact && <span>{coText}</span>}
      </span>
    </div>
  );
}
