import { describe, expect, it } from 'vitest';
import { compareVersions, formatCommand, LineBuffer, parseLine, versionAtLeast } from './protocol.js';
import { bitmapToDataUrl, encodePng } from './png.js';

describe('Satellite line codec', () => {
  it('parses BEGIN with key=value args', () => {
    const m = parseLine('BEGIN CompanionVersion=4.1.0 ApiVersion=1.10.0\r');
    expect(m).toMatchObject({ command: 'BEGIN', args: { CompanionVersion: '4.1.0', ApiVersion: '1.10.0' } });
  });

  it('parses OK/ERROR positional tokens and quoted values', () => {
    const m = parseLine('ADD-DEVICE ERROR DEVICEID=abc MESSAGE="Device \\"x\\" exists"');
    expect(m?.positional).toEqual(['ERROR']);
    expect(m?.args).toEqual({ DEVICEID: 'abc', MESSAGE: 'Device "x" exists' });
  });

  it('keeps PING/PONG payloads verbatim', () => {
    expect(parseLine('PONG 12345 abc')?.positional).toEqual(['12345 abc']);
  });

  it('ignores blank lines', () => {
    expect(parseLine('   ')).toBeNull();
  });

  it('formats commands with quoting for spaces', () => {
    expect(formatCommand('ADD-DEVICE', { DEVICEID: 'pch-1', PRODUCT_NAME: 'Production Control Hub', KEYS_TOTAL: 32, TEXT: true })).toBe(
      'ADD-DEVICE DEVICEID=pch-1 PRODUCT_NAME="Production Control Hub" KEYS_TOTAL=32 TEXT=true\n',
    );
    expect(formatCommand('KEY-PRESS', { DEVICEID: 'd', KEY: 0, PRESSED: false })).toBe('KEY-PRESS DEVICEID=d KEY=0 PRESSED=false\n');
  });

  it('round-trips quoted values', () => {
    const line = formatCommand('X', { A: 'he said "hi" \\ bye' });
    expect(parseLine(line)?.args.A).toBe('he said "hi" \\ bye');
  });

  it('rejects injection through argument names or command names', () => {
    expect(() => formatCommand('KEY-PRESS\nQUIT', {})).toThrow();
    expect(() => formatCommand('X', { 'A B': 1 })).toThrow();
  });

  it('cannot inject a newline through a value', () => {
    expect(() => formatCommand('X', { A: 'a\nQUIT' })).toThrow(/line breaks/);
  });

  it('compares versions', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(versionAtLeast('1.5.1', '1.5.0')).toBe(true);
    expect(versionAtLeast(null, '1.0.0')).toBe(false);
  });

  it('splits streamed lines across chunks', () => {
    const lb = new LineBuffer();
    expect(lb.push('BEGIN A')).toEqual([]);
    expect(lb.push('=1\nPONG')).toEqual(['BEGIN A=1']);
    expect(lb.push(' x\n')).toEqual(['PONG x']);
  });
});

describe('PNG conversion', () => {
  it('converts a square raw RGB bitmap to a PNG data URL', () => {
    const rgb = Buffer.alloc(72 * 72 * 3, 0x80);
    const url = bitmapToDataUrl(rgb.toString('base64'));
    expect(url).toMatch(/^data:image\/png;base64,/);
    const png = Buffer.from(url!.split(',')[1]!, 'base64');
    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(72);
    expect(png.readUInt32BE(20)).toBe(72);
  });

  it('passes through PNG data URLs and rejects garbage', () => {
    expect(bitmapToDataUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(bitmapToDataUrl(Buffer.alloc(10).toString('base64'))).toBeNull();
  });

  it('validates pixel buffer size', () => {
    expect(() => encodePng(Buffer.alloc(5), 2, 2, 3)).toThrow();
  });
});
