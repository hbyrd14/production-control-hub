import net from 'node:net';

/**
 * Production control endpoints must never be reachable from the public internet.
 * These helpers classify addresses so the gateway can refuse non-private clients.
 */

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

const V4_PRIVATE: [string, number][] = [
  ['127.0.0.0', 8], // loopback
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['169.254.0.0', 16], // link-local
  ['100.64.0.0', 10], // CGNAT / Tailscale-style overlays
];

export function isPrivateAddress(address: string | undefined | null): boolean {
  if (!address) return false;
  let ip = address;
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (net.isIPv4(ip)) {
    const n = ipv4ToInt(ip);
    return V4_PRIVATE.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (ipv4ToInt(base) & mask);
    });
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || /^fe[89ab]/.test(lower);
  }
  return false;
}

/** Warn-worthy bind addresses: wildcard or public. */
export function describeBind(host: string): { exposure: 'loopback' | 'private' | 'all-interfaces' | 'public'; message: string } {
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return { exposure: 'loopback', message: 'Listening on loopback only (this computer).' };
  if (host === '0.0.0.0' || host === '::') {
    return {
      exposure: 'all-interfaces',
      message: 'Listening on ALL interfaces. Non-private client addresses are still refused, but bind to the production LAN address where possible.',
    };
  }
  if (isPrivateAddress(host)) return { exposure: 'private', message: `Listening on private address ${host}.` };
  return { exposure: 'public', message: `Bind address ${host} is not a private address.` };
}
