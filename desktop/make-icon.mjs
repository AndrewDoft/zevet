// Generates build/icon.png — the app icon — with no image dependency.
//
// A PNG is a signature, three chunks and a CRC each; zlib is in Node. Pulling
// in a graphics library to draw a tile and three dots would be a bigger
// liability than the encoder below.
//
//   node make-icon.mjs
//
// ⚠️ THIS IS THE MASORA LOGO, NOT A DESIGN OF ITS OWN (Andrew, 2026-09-18:
// "change the favicon or desktop icon of Zevet so that it matches this new
// Masora logo"). Zevet is sold as a Masora product and its icon is the Masora
// mark — the mathematical `therefore` symbol, three dots, on the eggshell tile.
//
// ⚠️ THE GEOMETRY BELOW WAS MEASURED, NOT EYEBALLED. Every number came off the
// live favicon, masora-landing/src/app/icon.png, decoded scanline by scanline
// on 2026-09-18: a 256×256 RGBA tile, ground #eae7e2 to the very edge with no
// border ring, three #2c2f44 discs of radius 21 centred at (128,81), (74,175)
// and (182,175), and a corner radius of 48 (recovered from where the top row
// first goes opaque, x=41, which solves to r=48 and then checks out at y=20).
// Doubled here for a 512 icon. They do NOT match masora-landing's BrandMark.tsx
// SVG, which has smaller dots and tighter padding — the PNG was retuned for
// small sizes in commit f89904e ("Reduce tab icon symbol with balanced
// padding"), and the PNG is the thing this icon has to sit beside.
//
// Before this it was three lanes — cerulean, ink and muted bars, the board at
// icon scale. Good drawing, wrong mark: it read as a product with its own
// identity rather than one of Masora's.
//
// RGBA rather than truecolour, because the tile has rounded corners and a
// square icon with four opaque eggshell corners looks like a rendering bug on
// a dark taskbar.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIZE = 512;

// Two colours, both read out of the favicon's own pixels rather than off a
// stylesheet, so this file cannot drift from the image it is copying.
const PAPER = [0xea, 0xe7, 0xe2]; // --paper, the ground
const INK = [0x2c, 0x2f, 0x44]; // --ink, the three dots

// RGBA, transparent until something is drawn.
const px = Buffer.alloc(SIZE * SIZE * 4);

/**
 * Signed distance to a rounded rectangle, used for both the tile and the bars.
 *
 * Distance rather than a pixel test so the edges can be antialiased: at 16px in
 * a taskbar, a hard-edged rounded corner reads as a chewed one.
 */
function roundRectDist(x, y, left, top, w, h, r) {
  const cx = Math.abs(x - (left + w / 2)) - (w / 2 - r);
  const cy = Math.abs(y - (top + h / 2)) - (h / 2 - r);
  const dx = Math.max(cx, 0);
  const dy = Math.max(cy, 0);
  return Math.min(Math.max(cx, cy), 0) + Math.sqrt(dx * dx + dy * dy) - r;
}

/** Paint a rounded rect, blending over whatever is already there. */
function roundRect(left, top, w, h, r, rgb) {
  for (let y = Math.floor(top) - 2; y < top + h + 2; y++) {
    for (let x = Math.floor(left) - 2; x < left + w + 2; x++) {
      // +0.5 samples the pixel centre; without it the shape sits half a pixel
      // up and left of where the numbers say it is.
      const d = roundRectDist(x + 0.5, y + 0.5, left, top, w, h, r);
      const cov = Math.min(Math.max(0.5 - d, 0), 1);
      if (cov <= 0) continue;
      const i = (y * SIZE + x) * 4;
      if (i < 0 || i + 3 >= px.length) continue;
      const a = px[i + 3] / 255;
      // Source-over onto the existing pixel, so a bar lands on the tile rather
      // than punching a hole through it.
      const outA = cov + a * (1 - cov);
      for (let c = 0; c < 3; c++) {
        px[i + c] = Math.round((rgb[c] * cov + px[i + c] * a * (1 - cov)) / (outA || 1));
      }
      px[i + 3] = Math.round(outA * 255);
    }
  }
}

/** A disc. A rounded rect whose corner radius is half its side is a circle, so
 *  this gets the same antialiased coverage as everything else for free. */
function disc(cx, cy, r, rgb) {
  roundRect(cx - r, cy - r, r * 2, r * 2, r, rgb);
}

// The tile: eggshell, generously rounded, and paper right out to the edge. The
// old icon had a --line hairline around it; the favicon has none, and matching
// it is the whole point.
roundRect(0, 0, SIZE, SIZE, 96, PAPER);

// ∴ — one dot up, two down, the Masora mark. The favicon's 256-space numbers,
// doubled: r 21→42, (128,81)→(256,162), (74,175)→(148,350), (182,175)→(364,350).
const DOT_R = 42;
const DOTS = [
  [256, 162], // apex
  [148, 350], // lower left
  [364, 350], // lower right
];
for (const [cx, cy] of DOTS) disc(cx, cy, DOT_R, INK);

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
ihdr[9] = 6; // colour type: truecolour WITH ALPHA
// 10..12 stay zero: deflate, adaptive filtering, no interlace.

// Each scanline is prefixed with its filter type; 0 means "none".
const STRIDE = SIZE * 4;
const raw = Buffer.alloc(SIZE * (STRIDE + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (STRIDE + 1)] = 0;
  px.copy(raw, y * (STRIDE + 1) + 1, y * STRIDE, (y + 1) * STRIDE);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = path.join(HERE, "build", "icon.png");
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out} (${SIZE}x${SIZE} RGBA, ${png.length} bytes)`);
