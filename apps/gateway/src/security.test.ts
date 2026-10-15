import { describe, expect, it } from 'vitest';
import { hashPassword, RateLimiter, validatePassword, verifyPassword } from './auth.js';
import { describeBind, isPrivateAddress } from './netguard.js';
import { loadConfig } from './config.js';

describe('network guard', () => {
  it.each([
    ['127.0.0.1', true],
    ['::1', true],
    ['::ffff:192.168.1.40', true],
    ['10.20.30.40', true],
    ['172.16.5.5', true],
    ['172.32.0.1', false],
    ['169.254.10.1', true],
    ['100.100.1.1', true],
    ['fd12::1', true],
    ['fe80::1', true],
    ['8.8.8.8', false],
    ['2001:4860::8888', false],
    [undefined, false],
  ])('%s private=%s', (addr, expected) => {
    expect(isPrivateAddress(addr)).toBe(expected);
  });

  it('classifies bind addresses', () => {
    expect(describeBind('127.0.0.1').exposure).toBe('loopback');
    expect(describeBind('0.0.0.0').exposure).toBe('all-interfaces');
    expect(describeBind('192.168.10.5').exposure).toBe('private');
    expect(describeBind('203.0.113.9').exposure).toBe('public');
  });
});

describe('passwords', () => {
  it('hashes with scrypt and verifies', () => {
    const h = hashPassword('a-long-password');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(verifyPassword('a-long-password', h)).toBe(true);
    expect(verifyPassword('wrong-password', h)).toBe(false);
    expect(verifyPassword('x', 'garbage')).toBe(false);
  });

  it('enforces a minimum length', () => {
    expect(validatePassword('short')).toMatch(/at least/);
    expect(validatePassword('long-enough-1')).toBeNull();
  });
});

describe('rate limiter', () => {
  it('allows up to the limit per window', () => {
    let t = 0;
    const rl = new RateLimiter(2, 1000, () => t);
    expect(rl.take('a')).toBe(true);
    expect(rl.take('a')).toBe(true);
    expect(rl.take('a')).toBe(false);
    expect(rl.allowed('b')).toBe(true);
    t = 1001;
    expect(rl.take('a')).toBe(true);
  });
});

describe('configuration', () => {
  it('defaults to loopback binding and refuses short bootstrap passwords', () => {
    expect(loadConfig({}).host).toBe('127.0.0.1');
    expect(() => loadConfig({ PCH_ADMIN_USERNAME: 'a', PCH_ADMIN_PASSWORD: 'short' })).toThrow(/at least 10/);
    expect(() => loadConfig({ PCH_TLS_CERT: 'x.pem' })).toThrow(/Both PCH_TLS_CERT and PCH_TLS_KEY/);
  });
});
