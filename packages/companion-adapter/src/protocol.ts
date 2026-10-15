/**
 * Line codec for the Bitfocus Companion Satellite API.
 *
 * Reference: https://companion.free/for-developers/Satellite-API
 *  - One message per line, terminated by \n (\r\n tolerated).
 *  - `COMMAND ARG=VALUE ARG2="value with spaces"`; bare tokens (e.g. OK / ERROR / ping payload) are positional.
 *  - Booleans accepted as true/false or 0/1; servers send 0/1.
 */

export interface SatelliteMessage {
  command: string;
  /** Bare (non key=value) tokens after the command, in order. */
  positional: string[];
  args: Record<string, string>;
  raw: string;
}

export function parseLine(rawLine: string): SatelliteMessage | null {
  const line = rawLine.replace(/\r$/, '').trim();
  if (!line) return null;
  const firstSpace = line.indexOf(' ');
  const command = firstSpace === -1 ? line : line.slice(0, firstSpace);
  const rest = firstSpace === -1 ? '' : line.slice(firstSpace + 1);
  const positional: string[] = [];
  const args: Record<string, string> = {};
  // PING/PONG payloads are opaque: keep them verbatim.
  if (command === 'PING' || command === 'PONG') {
    if (rest) positional.push(rest);
    return { command, positional, args, raw: line };
  }
  for (const tok of tokenizeKeyValues(rest)) {
    if (tok.key === null) positional.push(tok.value);
    else args[tok.key] = tok.value;
  }
  return { command, positional, args, raw: line };
}

/** Like tokenize, but recognises KEY=VALUE / KEY="quoted value" pairs. */
function tokenizeKeyValues(rest: string): { key: string | null; value: string }[] {
  const out: { key: string | null; value: string }[] = [];
  for (const tok of splitPreservingQuotes(rest)) {
    const eq = tok.indexOf('=');
    if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(tok.slice(0, eq))) {
      out.push({ key: tok.slice(0, eq), value: unquote(tok.slice(eq + 1)) });
    } else {
      out.push({ key: null, value: unquote(tok) });
    }
  }
  return out;
}

function splitPreservingQuotes(s: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inQuotes && ch === '\\' && i + 1 < s.length) {
      cur += ch + s[i + 1];
      i++;
      continue;
    }
    if (ch === '"') inQuotes = !inQuotes;
    if (!inQuotes && (ch === ' ' || ch === '\t')) {
      if (cur) parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  return v;
}

export type ArgValue = string | number | boolean;

export function formatValue(v: ArgValue): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const s = String(v);
  if (/[\r\n]/.test(s)) throw new Error('Satellite values must not contain line breaks');
  if (s === '' || /[\s"\\]/.test(s)) return `"${s.replace(/(["\\])/g, '\\$1')}"`;
  return s;
}

export function formatCommand(command: string, args: Record<string, ArgValue | undefined> = {}, positional: string[] = []): string {
  if (!/^[A-Z][A-Z0-9-]*$/.test(command)) throw new Error(`Invalid command name: ${command}`);
  const parts = [command, ...positional.map((p) => formatValue(p))];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`Invalid argument name: ${k}`);
    parts.push(`${k}=${formatValue(v)}`);
  }
  return parts.join(' ') + '\n';
}

export function parseBool(v: string | undefined): boolean {
  return v === '1' || v === 'true';
}

/** Compare semver-ish strings (major.minor.patch). Returns negative / 0 / positive. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function versionAtLeast(version: string | null, min: string): boolean {
  return version !== null && compareVersions(version, min) >= 0;
}

/** Split a streaming text buffer into complete lines. */
export class LineBuffer {
  private buf = '';
  push(chunk: string): string[] {
    this.buf += chunk;
    if (this.buf.length > 8 * 1024 * 1024) {
      // Protect against a peer that never sends a newline.
      this.buf = '';
      throw new Error('Satellite line exceeded 8 MiB without terminator');
    }
    const lines = this.buf.split('\n');
    this.buf = lines.pop() ?? '';
    return lines;
  }
  reset(): void {
    this.buf = '';
  }
}
