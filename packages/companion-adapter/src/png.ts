import zlib from 'node:zlib';

/**
 * Minimal PNG encoder for square RGB/RGBA buffers.
 * Companion sends raw RGB bitmaps (BITMAP_FORMAT=rgb) when PNG is not negotiated;
 * the gateway converts them so browsers can render a plain <img>.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function encodePng(pixels: Buffer, width: number, height: number, channels: 3 | 4): Buffer {
  if (pixels.length !== width * height * channels) {
    throw new Error(`Pixel buffer size ${pixels.length} does not match ${width}x${height}x${channels}`);
  }
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Convert a Satellite BITMAP value to a data URL usable by browsers. Returns null if unusable. */
export function bitmapToDataUrl(value: string): string | null {
  if (value.startsWith('data:image/')) return value;
  const buf = Buffer.from(value, 'base64');
  if (buf.length === 0 || buf.length % 3 !== 0) return null;
  const side = Math.round(Math.sqrt(buf.length / 3));
  if (side * side * 3 !== buf.length) return null; // non-square RGB without dimensions: cannot decode safely
  return `data:image/png;base64,${encodePng(buf, side, side, 3).toString('base64')}`;
}
