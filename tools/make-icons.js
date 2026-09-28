/*
 * Generates the extension icons. No image libraries needed — shapes are drawn
 * with signed distance fields and encoded straight to PNG.
 *
 *   node tools/make-icons.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ------------------------------------------------------------------- shapes */

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

function sdRoundBox(px, py, hx, hy, r) {
  const qx = Math.abs(px) - hx + r;
  const qy = Math.abs(py) - hy + r;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r;
}

function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = clamp01((pax * bax + pay * bay) / (bax * bax + bay * bay));
  return Math.hypot(pax - bax * h, pay - bay * h);
}

/** Antialiased coverage for a distance field, `aa` in the same units as d. */
function cover(d, aa) {
  return clamp01(0.5 - d / aa);
}

function over(dst, src, alpha) {
  const a = alpha + dst[3] * (1 - alpha);
  if (a <= 0) return [0, 0, 0, 0];
  return [
    (src[0] * alpha + dst[0] * dst[3] * (1 - alpha)) / a,
    (src[1] * alpha + dst[1] * dst[3] * (1 - alpha)) / a,
    (src[2] * alpha + dst[2] * dst[3] * (1 - alpha)) / a,
    a
  ];
}

const BG_A = [0x18, 0x8f, 0xe0]; // top-left blue
const BG_B = [0x06, 0x35, 0x6d]; // bottom-right navy
const WHITE = [0xff, 0xff, 0xff];
const ACCENT = [0x86, 0xdc, 0xff];

// Indented "tree" motif: dot + bar per row, each row nested one level deeper.
const ROWS = [
  { y: 0.28, dotX: 0.25, barFrom: 0.37, barTo: 0.79, color: WHITE },
  { y: 0.5, dotX: 0.37, barFrom: 0.49, barTo: 0.79, color: WHITE },
  { y: 0.72, dotX: 0.49, barFrom: 0.61, barTo: 0.73, color: ACCENT }
];

const DOT_R = 0.068;
const BAR_R = 0.058;
const CORNER = 0.215;

function renderIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const aa = 1 / size; // one device pixel, in normalized units

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;

      let rgba = [0, 0, 0, 0];

      // background plate
      const dBox = sdRoundBox(u - 0.5, v - 0.5, 0.5, 0.5, CORNER);
      const bgA = cover(dBox, aa);
      if (bgA > 0) {
        const t = clamp01((u + v) / 2);
        const bg = [
          BG_A[0] + (BG_B[0] - BG_A[0]) * t,
          BG_A[1] + (BG_B[1] - BG_A[1]) * t,
          BG_A[2] + (BG_B[2] - BG_A[2]) * t
        ];
        rgba = over(rgba, bg, bgA);
      }

      // tree rows
      for (const row of ROWS) {
        const dDot = Math.hypot(u - row.dotX, v - row.y) - DOT_R;
        const dBar = sdSegment(u, v, row.barFrom, row.y, row.barTo, row.y) - BAR_R;
        const a = Math.max(cover(dDot, aa), cover(dBar, aa));
        if (a > 0) rgba = over(rgba, row.color, a);
      }

      const i = (y * size + x) * 4;
      px[i] = Math.round(rgba[0]);
      px[i + 1] = Math.round(rgba[1]);
      px[i + 2] = Math.round(rgba[2]);
      px[i + 3] = Math.round(rgba[3] * 255);
    }
  }
  return px;
}

/* -------------------------------------------------------------- png encoding */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = size * 4;
  const rawLen = (stride + 1) * size;
  const raw = Buffer.alloc(rawLen);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* --------------------------------------------------------------------- main */

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  const file = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(file, encodePng(size, renderIcon(size)));
  console.log(`wrote ${path.relative(process.cwd(), file)} (${size}x${size})`);
}
