import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIRM_ARM_MS, InteractionEngine, type Effect, type KeyConfig, type Target } from './interactions.js';

const A: Target = { kind: 'sub', subId: 'a', location: '1/0/0' };
const B: Target = { kind: 'sub', subId: 'b', location: '1/0/1' };

function cfg(mode: KeyConfig['mode'], extra: Partial<KeyConfig> = {}): KeyConfig {
  return { mode, holdMs: 800, windowMs: 300, primary: A, secondary: B, ...extra };
}

let log: string[];
let engine: InteractionEngine;

function fmt(e: Effect): string {
  return e.type === 'feedback' ? `fb:${e.state}` : `${e.type}:${e.target.kind === 'sub' ? e.target.subId : '?'}`;
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useFakeTimers();
  log = [];
  engine = new InteractionEngine((_k, e) => log.push(fmt(e)));
});

describe('passthrough', () => {
  it('forwards down and up 1:1', () => {
    engine.down('k', cfg('passthrough'));
    engine.down('k', cfg('passthrough')); // repeat ignored
    engine.up('k');
    engine.up('k'); // extra up ignored
    expect(log).toEqual(['down:a', 'up:a']);
  });

  it('releases on pointer cancel', () => {
    engine.down('k', cfg('passthrough'));
    engine.cancel('k');
    expect(log).toEqual(['down:a', 'up:a']);
  });
});

describe('confirm', () => {
  it('first tap arms without sending; second tap fires', () => {
    engine.down('k', cfg('confirm'));
    engine.up('k');
    expect(log).toEqual(['fb:armed']);
    engine.down('k', cfg('confirm'));
    engine.up('k');
    expect(log).toEqual(['fb:armed', 'down:a', 'fb:fired', 'up:a']);
  });

  it('disarms after the confirm window', () => {
    engine.down('k', cfg('confirm'));
    engine.up('k');
    vi.advanceTimersByTime(CONFIRM_ARM_MS + 1);
    engine.down('k', cfg('confirm'));
    expect(log).toEqual(['fb:armed', 'fb:idle', 'fb:armed']);
  });
});

describe('hold', () => {
  it('does nothing if released early', () => {
    engine.down('k', cfg('hold'));
    vi.advanceTimersByTime(500);
    engine.up('k');
    vi.advanceTimersByTime(2000);
    expect(log).toEqual(['fb:armed', 'fb:idle']);
  });

  it('fires after holdMs and releases on up', () => {
    engine.down('k', cfg('hold'));
    vi.advanceTimersByTime(800);
    expect(log).toEqual(['fb:armed', 'down:a', 'fb:fired']);
    engine.up('k');
    expect(log.at(-1)).toBe('up:a');
  });

  it('pointer cancel before firing aborts', () => {
    engine.down('k', cfg('hold'));
    engine.cancel('k');
    vi.advanceTimersByTime(2000);
    expect(log).toEqual(['fb:armed', 'fb:idle']);
  });
});

describe('double', () => {
  it('single tap fires primary after the window', () => {
    engine.down('k', cfg('double'));
    engine.up('k');
    expect(log).toEqual([]);
    vi.advanceTimersByTime(300);
    expect(log).toEqual(['down:a', 'up:a', 'fb:fired']);
  });

  it('double tap fires secondary only', () => {
    engine.down('k', cfg('double'));
    engine.up('k');
    vi.advanceTimersByTime(100);
    engine.down('k', cfg('double'));
    engine.up('k');
    vi.advanceTimersByTime(1000);
    expect(log).toEqual(['down:b', 'fb:fired', 'up:b']);
  });
});

describe('client cleanup', () => {
  it('cancelPrefix releases held presses for that client only', () => {
    engine.down('c1:0', cfg('passthrough'));
    engine.down('c2:0', cfg('passthrough', { primary: B }));
    engine.cancelPrefix('c1:');
    expect(log).toEqual(['down:a', 'down:b', 'up:a']);
  });

  it('resetAll forgets presses without sending releases (Companion session gone)', () => {
    engine.down('k', cfg('passthrough'));
    engine.resetAll();
    engine.up('k');
    expect(log).toEqual(['down:a']);
  });
});
