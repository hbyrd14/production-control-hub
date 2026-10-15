/** Generates the original PWA icon set: a slate panel with an 8×4 key bank and tally lamps. */
import fs from 'node:fs';
import path from 'node:path';
import { encodePng } from '../packages/companion-adapter/src/png.js';

type RGBA = [number, number, number, number];
const hex = (h: string, a = 255): RGBA => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
};

function draw(size: number, safeInset: number, rounded: boolean): Buffer {
  const px = Buffer.alloc(size * size * 4);
  const set = (x: number, y: number, c: RGBA) => {
    const o = (y * size + x) * 4;
    const a = c[3] / 255;
    for (let i = 0; i < 3; i++) px[o + i] = Math.round(c[i]! * a + px[o + i]! * (1 - a));
    px[o + 3] = Math.max(px[o + 3]!, c[3]);
  };
  const rrect = (x0: number, y0: number, w: number, h: number, r: number, c: RGBA) => {
    for (let y = Math.floor(y0); y < Math.ceil(y0 + h); y++)
      for (let x = Math.floor(x0); x < Math.ceil(x0 + w); x++) {
        const dx = Math.max(x0 + r - x - 0.5, 0, x + 0.5 - (x0 + w - r));
        const dy = Math.max(y0 + r - y - 0.5, 0, y + 0.5 - (y0 + h - r));
        const d = Math.hypot(dx, dy) - r;
        const cov = Math.min(1, Math.max(0, 0.5 - d));
        if (cov > 0 && x >= 0 && y >= 0 && x < size && y < size) set(x, y, [c[0], c[1], c[2], Math.round(c[3] * cov)]);
      }
  };
  rrect(0, 0, size, size, rounded ? size * 0.2 : 0, hex('#1d2128'));
  const inner = size - safeInset * 2;
  const gap = inner * 0.035;
  const cols = 4;
  const rows = 4;
  const key = (inner - gap * (cols - 1)) / cols;
  const top = safeInset + (inner - (key * rows + gap * (rows - 1))) / 2;
  const colors: Record<string, string> = { '0,0': '#d62f2f', '1,1': '#1f9d55', '2,3': '#f2b134' };
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const x = safeInset + c * (key + gap);
      const y = top + r * (key + gap);
      rrect(x, y, key, key, key * 0.16, hex(colors[`${r},${c}`] ?? '#3a414d'));
    }
  return px;
}

const out = path.resolve('apps/web/public/icons');
fs.mkdirSync(out, { recursive: true });
const write = (name: string, size: number, inset: number, rounded: boolean) =>
  fs.writeFileSync(path.join(out, name), encodePng(draw(size, inset, rounded), size, size, 4));
write('icon-192.png', 192, 22, true);
write('icon-512.png', 512, 58, true);
write('icon-maskable-512.png', 512, 110, false);
write('apple-touch-icon.png', 180, 20, false);
console.log(`Icons written to ${out}`);
