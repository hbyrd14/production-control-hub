import { useEffect, useState } from 'react';

/** Per-device display preferences (stored in this browser only). */
export interface DevicePrefs {
  haptics: boolean;
  keepAwake: boolean;
  showLocations: boolean;
}

const KEY = 'pch.prefs';
const DEFAULTS: DevicePrefs = { haptics: true, keepAwake: true, showLocations: false };

function read(): DevicePrefs {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<DevicePrefs>) };
  } catch {
    return DEFAULTS;
  }
}

const listeners = new Set<(p: DevicePrefs) => void>();
let current = read();

export function getPrefs() {
  return current;
}

export function setPrefs(patch: Partial<DevicePrefs>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l(current));
}

export function usePrefs(): DevicePrefs {
  const [p, setP] = useState(current);
  useEffect(() => {
    listeners.add(setP);
    return () => void listeners.delete(setP);
  }, []);
  return p;
}

/** Hold a screen wake lock while operating (requires HTTPS; silently unavailable otherwise). */
export function useWakeLock(enabled: boolean) {
  useEffect(() => {
    if (!enabled || !('wakeLock' in navigator)) return;
    let lock: { release(): Promise<void> } | null = null;
    let cancelled = false;
    const acquire = async () => {
      try {
        lock = await (navigator as unknown as { wakeLock: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock.request('screen');
        if (cancelled) void lock.release();
      } catch {
        /* not permitted */
      }
    };
    void acquire();
    const onVis = () => document.visibilityState === 'visible' && void acquire();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVis);
      void lock?.release().catch(() => {});
    };
  }, [enabled]);
}
