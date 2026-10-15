/** Tiny software renderer so the mock Companion can produce real key bitmaps with legible text. */

const FONT: Record<string, string> = {
  A: '01110100011000111111100011000110001', B: '11110100011000111110100011000111110',
  C: '01110100011000010000100001000101110', D: '11110100011000110001100011000111110',
  E: '11111100001000011110100001000011111', F: '11111100001000011110100001000010000',
  G: '01110100011000010111100011000101111', H: '10001100011000111111100011000110001',
  I: '01110001000010000100001000010001110', J: '00111000100001000010000101001001100',
  K: '10001100101010011000101001001010001', L: '10000100001000010000100001000011111',
  M: '10001110111010110101100011000110001', N: '10001100011100110101100111000110001',
  O: '01110100011000110001100011000101110', P: '11110100011000111110100001000010000',
  Q: '01110100011000110001101011001001101', R: '11110100011000111110101001001010001',
  S: '01111100001000001110000010000111110', T: '11111001000010000100001000010000100',
  U: '10001100011000110001100011000101110', V: '10001100011000110001100010101000100',
  W: '10001100011000110101101011010101010', X: '10001100010101000100010101000110001',
  Y: '10001100010101000100001000010000100', Z: '11111000010001000100010001000011111',
  '0': '01110100011001110101110011000101110', '1': '00100011000010000100001000010001110',
  '2': '01110100010000100010001000100011111', '3': '11111000100010000010000011000101110',
  '4': '00010001100101010010111110001000010', '5': '11111100001111000001000011000101110',
  '6': '00110010001000011110100011000101110', '7': '11111000010001000100010000100001000',
  '8': '01110100011000101110100011000101110', '9': '01110100011000101111000010001001100',
  ' ': '00000000000000000000000000000000000', '-': '00000000000000011111000000000000000',
  '/': '00001000100001000100010000100010000', '+': '00000001000010011111001000010000000',
  '.': '00000000000000000000000000110001100', ':': '00000011000110000000011000110000000',
  '!': '00100001000010000100001000000000100', '?': '01110100010000100010001000000000100',
  '>': '01000001000001000001000100010001000', '<': '00010001000100010000010000010000010',
};

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function wrap(text: string, maxChars: number): string[] {
  const out: string[] = [];
  for (const para of text.toUpperCase().split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      if (!line) line = word;
      else if ((line + ' ' + word).length <= maxChars) line += ' ' + word;
      else {
        out.push(line);
        line = word;
      }
      while (line.length > maxChars) {
        out.push(line.slice(0, maxChars));
        line = line.slice(maxChars);
      }
    }
    out.push(line);
  }
  return out;
}

export interface RenderSpec {
  size: number;
  text: string;
  background: string;
  textColor: string;
  pressed?: boolean;
  /** Draw a coloured bar along the bottom edge (tally) */
  tally?: string | null;
}

/** Render to raw RGB (size × size × 3). */
export function renderKey(spec: RenderSpec): Buffer {
  const { size } = spec;
  const buf = Buffer.alloc(size * size * 3);
  const [br, bg, bb] = hexToRgb(spec.background);
  for (let i = 0; i < size * size; i++) {
    buf[i * 3] = br;
    buf[i * 3 + 1] = bg;
    buf[i * 3 + 2] = bb;
  }
  const set = (x: number, y: number, c: [number, number, number]) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const o = (y * size + x) * 3;
    buf[o] = c[0];
    buf[o + 1] = c[1];
    buf[o + 2] = c[2];
  };
  if (spec.tally) {
    const c = hexToRgb(spec.tally);
    const h = Math.max(3, Math.round(size / 12));
    for (let y = size - h; y < size; y++) for (let x = 0; x < size; x++) set(x, y, c);
  }
  if (spec.pressed) {
    const w = Math.max(2, Math.round(size / 24));
    const c: [number, number, number] = [255, 255, 255];
    for (let i = 0; i < size; i++)
      for (let t = 0; t < w; t++) {
        set(i, t, c);
        set(i, size - 1 - t, c);
        set(t, i, c);
        set(size - 1 - t, i, c);
      }
  }
  const tc = hexToRgb(spec.textColor);
  for (let scale = Math.max(1, Math.floor(size / 36)); scale >= 1; scale--) {
    const maxChars = Math.max(1, Math.floor((size - 8) / (6 * scale)));
    const lines = wrap(spec.text, maxChars);
    const lineH = 9 * scale;
    if (lines.length * lineH > size - 8 && scale > 1) continue;
    const top = Math.round((size - lines.length * lineH) / 2) + scale;
    lines.forEach((line, li) => {
      const left = Math.round((size - (line.length * 6 - 1) * scale) / 2);
      [...line].forEach((ch, ci) => {
        const glyph = FONT[ch] ?? FONT['?']!;
        for (let gy = 0; gy < 7; gy++)
          for (let gx = 0; gx < 5; gx++)
            if (glyph[gy * 5 + gx] === '1')
              for (let sy = 0; sy < scale; sy++)
                for (let sx = 0; sx < scale; sx++) set(left + (ci * 6 + gx) * scale + sx, top + li * lineH + gy * scale + sy, tc);
      });
    });
    break;
  }
  return buf;
}
