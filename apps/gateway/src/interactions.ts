import type { InteractionMode } from '@pch/shared';

/**
 * PCH-managed gesture logic. Companion owns latching/steps/durations; PCH only adds
 * operator-safety gestures on top. Exactly one engine decides when Companion sees
 * a down/up, so nothing is ever triggered twice.
 */

export type Target =
  | { kind: 'surface'; deviceId: string; index: number }
  | { kind: 'sub'; subId: string; location: string }
  | { kind: 'http'; location: string };

export function targetKey(t: Target): string {
  return t.kind === 'surface' ? `surface:${t.deviceId}:${t.index}` : t.kind === 'sub' ? `sub:${t.subId}` : `http:${t.location}`;
}

export interface KeyConfig {
  mode: InteractionMode;
  holdMs: number;
  windowMs: number;
  primary: Target;
  secondary: Target | null;
}

export type Effect =
  | { type: 'down'; target: Target }
  | { type: 'up'; target: Target }
  | { type: 'feedback'; state: 'armed' | 'idle' | 'fired' };

/** How long a confirm-mode key stays armed waiting for the second tap. */
export const CONFIRM_ARM_MS = 3000;

interface KeyState {
  cfg: KeyConfig;
  pressed: Target | null;
  armed: boolean;
  armTimer: ReturnType<typeof setTimeout> | null;
  holdTimer: ReturnType<typeof setTimeout> | null;
  firstDown: boolean;
  pendingTimer: ReturnType<typeof setTimeout> | null;
}

export interface Timers {
  set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clear: (t: ReturnType<typeof setTimeout>) => void;
}

const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t) };

export class InteractionEngine {
  private keys = new Map<string, KeyState>();

  constructor(
    private readonly emit: (key: string, effect: Effect) => void,
    private readonly timers: Timers = realTimers,
  ) {}

  private state(key: string, cfg: KeyConfig): KeyState {
    let s = this.keys.get(key);
    if (!s) {
      s = { cfg, pressed: null, armed: false, armTimer: null, holdTimer: null, firstDown: false, pendingTimer: null };
      this.keys.set(key, s);
    }
    return s;
  }

  isActive(key: string): boolean {
    const s = this.keys.get(key);
    return !!s && (s.pressed !== null || s.armed || s.holdTimer !== null || s.firstDown || s.pendingTimer !== null);
  }

  down(key: string, cfg: KeyConfig): void {
    const existing = this.keys.get(key);
    // If the key's mapping changed (e.g. page switched) while idle, start fresh.
    if (existing && !this.isActive(key)) this.keys.delete(key);
    const s = this.state(key, cfg);
    if (s.pressed || s.holdTimer || s.firstDown) return; // already in a gesture; ignore repeats
    switch (s.cfg.mode) {
      case 'passthrough':
        this.press(key, s, s.cfg.primary);
        return;
      case 'confirm':
        if (s.armed) {
          this.disarm(s);
          this.press(key, s, s.cfg.primary);
          this.emit(key, { type: 'feedback', state: 'fired' });
        } else {
          s.armed = true;
          this.emit(key, { type: 'feedback', state: 'armed' });
          s.armTimer = this.timers.set(() => {
            s.armTimer = null;
            s.armed = false;
            this.emit(key, { type: 'feedback', state: 'idle' });
          }, CONFIRM_ARM_MS);
        }
        return;
      case 'hold':
        this.emit(key, { type: 'feedback', state: 'armed' });
        s.holdTimer = this.timers.set(() => {
          s.holdTimer = null;
          this.press(key, s, s.cfg.primary);
          this.emit(key, { type: 'feedback', state: 'fired' });
        }, s.cfg.holdMs);
        return;
      case 'double':
        if (s.pendingTimer) {
          this.timers.clear(s.pendingTimer);
          s.pendingTimer = null;
          this.press(key, s, s.cfg.secondary ?? s.cfg.primary);
          this.emit(key, { type: 'feedback', state: 'fired' });
        } else {
          s.firstDown = true;
        }
        return;
    }
  }

  up(key: string): void {
    const s = this.keys.get(key);
    if (!s) return;
    if (s.holdTimer) {
      // Released before the hold completed: nothing is sent.
      this.timers.clear(s.holdTimer);
      s.holdTimer = null;
      this.emit(key, { type: 'feedback', state: 'idle' });
    }
    if (s.pressed) {
      this.release(key, s);
      return;
    }
    if (s.cfg.mode === 'double' && s.firstDown) {
      s.firstDown = false;
      s.pendingTimer = this.timers.set(() => {
        s.pendingTimer = null;
        this.emit(key, { type: 'down', target: s.cfg.primary });
        this.emit(key, { type: 'up', target: s.cfg.primary });
        this.emit(key, { type: 'feedback', state: 'fired' });
      }, s.cfg.windowMs);
    }
  }

  /** Pointer cancelled (scroll, OS gesture, lost capture). Releases a held press; aborts anything not yet fired. */
  cancel(key: string): void {
    const s = this.keys.get(key);
    if (!s) return;
    if (s.holdTimer) {
      this.timers.clear(s.holdTimer);
      s.holdTimer = null;
      this.emit(key, { type: 'feedback', state: 'idle' });
    }
    if (s.pendingTimer) {
      this.timers.clear(s.pendingTimer);
      s.pendingTimer = null;
    }
    s.firstDown = false;
    if (s.pressed) this.release(key, s);
  }

  /** Cancel every gesture whose key starts with prefix (e.g. a disconnecting client). Held presses ARE released. */
  cancelPrefix(prefix: string): void {
    for (const key of [...this.keys.keys()]) {
      if (!key.startsWith(prefix)) continue;
      const s = this.keys.get(key)!;
      this.cancel(key);
      this.disarm(s);
      this.keys.delete(key);
    }
  }

  /** Forget everything without emitting downs/ups (used when Companion's session is gone). */
  resetAll(): void {
    for (const [key, s] of this.keys) {
      if (s.holdTimer) this.timers.clear(s.holdTimer);
      if (s.pendingTimer) this.timers.clear(s.pendingTimer);
      if (s.armTimer) this.timers.clear(s.armTimer);
      if (s.armed || s.holdTimer) this.emit(key, { type: 'feedback', state: 'idle' });
    }
    this.keys.clear();
  }

  private press(key: string, s: KeyState, target: Target): void {
    s.pressed = target;
    this.emit(key, { type: 'down', target });
  }

  private release(key: string, s: KeyState): void {
    const t = s.pressed!;
    s.pressed = null;
    this.emit(key, { type: 'up', target: t });
  }

  private disarm(s: KeyState): void {
    if (s.armTimer) this.timers.clear(s.armTimer);
    s.armTimer = null;
    s.armed = false;
  }
}
