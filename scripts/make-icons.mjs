// Generates the PNG icons from code, so every pixel in the repo is reproducible.
//   node scripts/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
const SIZES = [16, 32, 48, 128];
const SS = 4; // supersampling factor

const BG = [20, 20, 19];
const BARS = [
  { x0: 0.195, x1: 0.355, top: 0.215, color: [26, 155, 34] },   // work & education
  { x0: 0.420, x1: 0.580, top: 0.350, color: [247, 183, 49] },  // menu
  { x0: 0.645, x1: 0.805, top: 0.470, color: [200, 58, 52] },   // entertainment
];
const BASE = 0.795;
const RADIUS = 0.19;

function roundedRectHit(u, v, r) {
  const dx = Math.max(r - u, 0, u - (1 - r));
  const dy = Math.max(r - v, 0, v - (1 - r));
  if (dx === 0 || dy === 0) return u >= 0 && u <= 1 && v >= 0 && v <= 1;
  return dx * dx + dy * dy <= r * r;
}

function barHit(u, v, bar) {
  const halfW = (bar.x1 - bar.x0) / 2;
  const cx = (bar.x0 + bar.x1) / 2;
  if (u < bar.x0 || u > bar.x1) return false;
  if (v > BASE) return false;
  const capY = bar.top + halfW;
  if (v >= capY) return true;
  const dx = u - cx;
  const dy = v - capY;
  return dx * dx + dy * dy <= halfW * halfW;
}

function sample(u, v) {
  if (!roundedRectHit(u, v, RADIUS)) return null;
  for (const bar of BARS) if (barHit(u, v, bar)) return bar.color;
  return BG;
}

function render(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = sample((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
          if (px) { r += px[0]; g += px[1]; b += px[2]; a += 255; }
        }
      }
      const n = SS * SS;
      const i = rowStart + 1 + x * 4;
      const cover = a / (255 * n);
      raw[i] = cover ? Math.round(r / (n * cover)) : 0;
      raw[i + 1] = cover ? Math.round(g / (n * cover)) : 0;
      raw[i + 2] = cover ? Math.round(b / (n * cover)) : 0;
      raw[i + 3] = Math.round(a / n);
    }
  }
  return raw;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(render(size), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const size of SIZES) {
  const file = join(OUT, `icon${size}.png`);
  writeFileSync(file, png(size));
  console.log(`wrote ${file}`);
}
