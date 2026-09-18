// Generates build/icon.png — the app icon — with no image dependency.
//
// A PNG is a signature, three chunks and a CRC each; zlib is in Node. Pulling
// in a graphics library to draw five rectangles would be a bigger liability
// than the twenty lines of encoder below.
//
//   node make-icon.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIZE = 512;

// Masora's ground, and the three identity hues the lanes use.
const PAPER = [0x0d, 0x0a, 0x0a];
const BARS = [
  [0xe0, 0x7a, 0x62], // --who-0, the house rust
  [0xd9, 0xa4, 0x30], // --who-1
  [0xc2, 0x70, 0x8f], // --who-2
];

const px = Buffer.alloc(SIZE * SIZE * 3);
for (let i = 0; i < SIZE * SIZE; i++) {
  px[i * 3] = PAPER[0];
  px[i * 3 + 1] = PAPER[1];
  px[i * 3 + 2] = PAPER[2];
}

/** A bar with rounded ends, drawn by hand because a rectangle reads as a slab. */
function bar(top, left, width, height, rgb) {
  const r = Math.floor(height / 2);
  for (let y = top; y < top + height; y++) {
    for (let x = left; x < left + width; x++) {
      const dxL = left + r - x;
      const dyC = y - (top + r);
      if (dxL > 0 && dxL * dxL + dyC * dyC > r * r) continue;
      const dxR = x - (left + width - 1 - r);
      if (dxR > 0 && dxR * dxR + dyC * dyC > r * r) continue;
      const i = (y * SIZE + x) * 3;
      px[i] = rgb[0];
      px[i + 1] = rgb[1];
      px[i + 2] = rgb[2];
    }
  }
}

// Three lanes of different lengths — the board, at icon scale.
const h = 54;
const left = 96;
const widths = [320, 216, 268];
const tops = [150, 229, 308];
for (let i = 0; i < 3; i++) bar(tops[i], left, widths[i], h, BARS[i]);

// ---- PNG encoding ----------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // colour type: truecolour
// 10..12 stay zero: deflate, adaptive filtering, no interlace.

// Each scanline is prefixed with its filter type; 0 means "none".
const raw = Buffer.alloc(SIZE * (SIZE * 3 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 3 + 1)] = 0;
  px.copy(raw, y * (SIZE * 3 + 1) + 1, y * SIZE * 3, (y + 1) * SIZE * 3);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = path.join(HERE, "build");
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, "icon.png"), png);
console.log(`wrote ${path.join(out, "icon.png")} — ${SIZE}x${SIZE}, ${png.length} bytes`);
