// scripts/chart_png.mjs — dependency-free PNG encoder + pixel primitives + a tiny
// 5x7 bitmap font, and renderEarningsChart() which draws the cumulative-earnings
// vs $/mo-cost line with break-even. Pure module: stdlib only (node:zlib), no I/O
// at import time. The chart_png output is what the 7:45 AM report attaches via
// MEDIA:<path>.
//
// Node >= 18. Importable, or run standalone for a quick self-check:
//   node scripts/chart_png.mjs

import zlib from "node:zlib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// --- CRC32 (PNG spec / zlib polynomial) ------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

/** CRC-32 over a Buffer/Uint8Array, returns an unsigned 32-bit number. */
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ 0xffffffff) >>> 0;
}

// --- PNG encoding ----------------------------------------------------------
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

/**
 * Encode an RGBA buffer (w*h*4 bytes, row-major) as a PNG.
 * 8-bit-per-channel, color type 6 (RGBA). IDAT is zlib-deflated raw scanlines,
 * each prefixed with filter byte 0 (None). Returns a Buffer.
 */
export function pngEncode(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0;  // compression (zlib)
  ihdr[11] = 0;  // filter method
  ihdr[12] = 0;  // interlace none
  const rowBytes = w * 4;
  const raw = Buffer.alloc(h * (1 + rowBytes));
  for (let y = 0; y < h; y++) {
    const o = y * (1 + rowBytes);
    raw[o] = 0; // filter type None
    rgba.copy(raw, o + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// --- canvas + pixel primitives --------------------------------------------
function createCanvas(w, h, bg = [245, 247, 250, 255]) {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = bg[0]; data[i * 4 + 1] = bg[1]; data[i * 4 + 2] = bg[2]; data[i * 4 + 3] = bg[3] == null ? 255 : bg[3];
  }
  return { w, h, data };
}
export { createCanvas };

function setPixel(c, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h) return;
  const i = (y * c.w + x) * 4;
  c.data[i] = r; c.data[i + 1] = g; c.data[i + 2] = b; c.data[i + 3] = a == null ? 255 : a;
}
export { setPixel };

function hline(c, x0, x1, y, color) {
  const lo = Math.max(0, Math.min(x0, x1)), hi = Math.min(c.w - 1, Math.max(x0, x1));
  for (let x = lo; x <= hi; x++) setPixel(c, x, y, color[0], color[1], color[2], color[3]);
}
export { hline };

function vline(c, x, y0, y1, color) {
  const lo = Math.max(0, Math.min(y0, y1)), hi = Math.min(c.h - 1, Math.max(y0, y1));
  for (let y = lo; y <= hi; y++) setPixel(c, x, y, color[0], color[1], color[2], color[3]);
}
export { vline };

// Bresenham, inclusive of both endpoints.
function line(c, x0, y0, x1, y1, color) {
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    setPixel(c, x0, y0, color[0], color[1], color[2], color[3]);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}
export { line };

// Filled disk.
function circle(c, cx, cy, r, color) {
  const rr = Math.floor(r);
  for (let dy = -rr; dy <= rr; dy++) {
    for (let dx = -rr; dx <= rr; dx++) {
      if (dx * dx + dy * dy <= rr * rr) setPixel(c, cx + dx, cy + dy, color[0], color[1], color[2], color[3]);
    }
  }
}
export { circle };

// --- 5x7 bitmap font ------------------------------------------------------
// Each glyph: 7 rows, each a 5-bit value (bit4 = leftmost pixel). Only the
// glyphs this chart actually renders are defined.
const G = {
  A: [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  B: [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
  C: [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
  D: [0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110],
  E: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  G: [0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01110],
  I: [0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  K: [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
  M: [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
  N: [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
  O: [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  R: [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
  S: [0b01110, 0b10001, 0b10000, 0b01110, 0b00001, 0b10001, 0b01110],
  T: [0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  U: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  V: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
  Y: [0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100],
  "0": [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  "1": [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  "2": [0b01110, 0b10001, 0b00001, 0b00110, 0b01000, 0b10000, 0b11111],
  "3": [0b11110, 0b10001, 0b00001, 0b01110, 0b00001, 0b10001, 0b11110],
  "4": [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  "5": [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  "6": [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  "7": [0b11111, 0b00010, 0b00100, 0b01000, 0b10000, 0b10000, 0b10000],
  "8": [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  "9": [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
  "$": [0b01110, 0b11111, 0b10110, 0b01110, 0b01110, 0b11001, 0b01111],
  "/": [0b00001, 0b00010, 0b00010, 0b00100, 0b01000, 0b10000, 0b10000],
  "-": [0b00000, 0b00000, 0b00000, 0b11111, 0b00000, 0b00000, 0b00000],
  ".": [0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b01100, 0b01100],
  "@": [0b01110, 0b10001, 0b10111, 0b10101, 0b10110, 0b10000, 0b01110],
};
export const FONT = G;

function drawText(c, x, y, str, color, scale = 1) {
  let cx = x;
  for (const ch of String(str)) {
    if (ch === " ") { cx += 5 * scale; continue; }
    const rows = FONT[ch];
    if (!rows) { cx += 5 * scale; continue; }
    for (let r = 0; r < 7; r++) {
      const bits = rows[r];
      for (let col = 0; col < 5; col++) {
        if (!(bits & (1 << (4 - col)))) continue;
        const px = cx + col * scale, py = y + r * scale;
        for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) setPixel(c, px + sx, py + sy, color[0], color[1], color[2], color[3]);
      }
    }
    cx += 6 * scale; // 5px glyph + 1px gap
  }
}
export { drawText };

// --- break-even ----------------------------------------------------------
function daysBetween(t0Date, date) {
  const t0 = Date.parse(t0Date); const t = Date.parse(date);
  if (Number.isNaN(t0) || Number.isNaN(t)) return NaN;
  return (t - t0) / 86400000;
}

/**
 * First series index i where cumulative_usd >= cost(i) AND cumulative_usd > 0.
 * cost(i) = costPerDayUsd * daysBetween(t0Date, date_i). Returns
 * {index, date, cumulative_usd, cost} or null if it never crosses.
 */
export function findBreakEven(series, costPerDayUsd, t0Date) {
  if (!Array.isArray(series)) return null;
  for (let i = 0; i < series.length; i++) {
    const cum = Number(series[i].cumulative_usd);
    const d = daysBetween(t0Date, series[i].date);
    const cost = costPerDayUsd * d;
    if (Number.isFinite(cum) && cum > 0 && cum >= cost) {
      return { index: i, date: series[i].date, cumulative_usd: cum, cost };
    }
  }
  return null;
}

// --- chart ----------------------------------------------------------------
const W = 900, H = 480;
const PAD = { l: 64, r: 24, t: 44, b: 52 };
const COL = {
  bg: [247, 248, 251, 255], grid: [214, 220, 230, 255], axis: [96, 104, 120, 255],
  text: [70, 78, 92, 255], earn: [38, 166, 91, 255], cost: [214, 69, 69, 255], be: [214, 158, 46, 255],
};

function niceStep(rough) {
  if (!(rough > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  for (const m of [1, 2, 5, 10]) if (m * mag >= rough) return m * mag;
  return 10 * mag;
}

function plotDate(date) {
  const p = String(date).split("-"); // YYYY-MM-DD
  return `${Number(p[1])}/${Number(p[2])}`;
}

/**
 * Draw the cumulative-gross-earnings line vs a straight costPerDayUsd-per-day
 * cost line (from t0Date), with a break-even marker. Returns a PNG Buffer.
 * `series` must be ascending by date, each {date:"YYYY-MM-DD", cumulative_usd}.
 */
export function renderEarningsChart({ series = [], costPerDayUsd = 20 / 30, t0Date = null } = {}) {
  const c = createCanvas(W, H, COL.bg);
  // frame
  hline(c, PAD.l, W - PAD.r, PAD.t, COL.axis);
  vline(c, PAD.l, PAD.t, H - PAD.b, COL.axis);
  hline(c, PAD.l, W - PAD.r, H - PAD.b, COL.axis);

  const pts = (Array.isArray(series) ? series : []).filter((s) => s && s.date != null && Number.isFinite(Number(s.cumulative_usd)));
  let yMax = 1;
  if (pts.length > 0) {
    for (const p of pts) {
      const d = daysBetween(t0Date || pts[0].date, p.date);
      const cost = costPerDayUsd * d;
      yMax = Math.max(yMax, Number(p.cumulative_usd), cost);
    }
  }
  yMax *= 1.12; // headroom
  const step = niceStep(yMax / 5);
  const gridTop = Math.ceil(yMax / step) * step;

  const plotX = (i, n) => PAD.l + (n <= 1 ? 0 : Math.round((W - PAD.l - PAD.r) * i / (n - 1)));
  const yFor = (v) => H - PAD.b - Math.round(((H - PAD.t - PAD.b) * v) / gridTop);

  // horizontal $ gridlines + labels
  for (let g = 0; g <= gridTop + 1e-9; g += step) {
    const y = yFor(g);
    hline(c, PAD.l, W - PAD.r, y, COL.grid);
    drawText(c, 6, y - 4, `$${Math.round(g * 100) / 100}`, COL.text, 1);
  }

  if (pts.length > 0) {
    const n = pts.length;
    const t0 = t0Date || pts[0].date;
    const xs = [], ys = [];
    for (let i = 0; i < n; i++) {
      xs[i] = plotX(i, n);
      ys[i] = yFor(Number(pts[i].cumulative_usd));
    }
    // x date labels (first, last, and a couple in between)
    const labelIdx = new Set([0, Math.floor((n - 1) / 2), n - 1]);
    for (let i = 0; i < n; i++) if (labelIdx.has(i)) {
      const s = plotDate(pts[i].date);
      drawText(c, xs[i] - 8, H - PAD.b + 6, s, COL.text, 1);
    }

    // cost line: straight, $/day from t0 (drawn per-point; it is linear in time)
    const cx2 = [], cy2 = [];
    for (let i = 0; i < n; i++) {
      cx2[i] = xs[i];
      cy2[i] = yFor(costPerDayUsd * daysBetween(t0, pts[i].date));
    }
    for (let i = 1; i < n; i++) line(c, cx2[i - 1], cy2[i - 1], cx2[i], cy2[i], COL.cost);

    // earnings line
    for (let i = 1; i < n; i++) line(c, xs[i - 1], ys[i - 1], xs[i], ys[i], COL.earn);
    for (let i = 0; i < n; i++) circle(c, xs[i], ys[i], 2, COL.earn);

    // break-even marker
    const be = findBreakEven(pts, costPerDayUsd, t0);
    if (be) {
      const bx = xs[be.index], by = yFor(be.cumulative_usd);
      circle(c, bx, by, 5, COL.be);
      circle(c, bx, by, 2, [255, 255, 255, 255]);
      drawText(c, Math.min(W - PAD.r - 150, bx + 8), by - 14, `BREAK-EVEN @ $${Math.round(be.cumulative_usd * 100) / 100}`, COL.be, 1);
    }
  }

  // title + legend
  drawText(c, PAD.l, 12, "SURVEY EARNINGS VS $20/MO COST", COL.text, 1);
  circle(c, PAD.l + 2, 34, 3, COL.earn); drawText(c, PAD.l + 12, 30, "EARNINGS", COL.text, 1);
  line(c, W - PAD.r - 96, 34, W - PAD.r - 84, 34, COL.cost); drawText(c, W - PAD.r - 78, 30, "COST $20/MO", COL.text, 1);

  return pngEncode(W, H, c.data);
}

// --- standalone self-check -----------------------------------------------
const isCLI = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isCLI) {
  const demo = [
    { date: "2026-09-01", cumulative_usd: 0 },
    { date: "2026-09-08", cumulative_usd: 4.2 },
    { date: "2026-09-15", cumulative_usd: 9.75 },
    { date: "2026-09-22", cumulative_usd: 16.4 },
    { date: "2026-09-30", cumulative_usd: 24.9 },
  ];
  const png = renderEarningsChart({ series: demo, costPerDayUsd: 20 / 30, t0Date: "2026-09-01" });
  const out = path.join(os.tmpdir(), "chart_png_selfcheck.png");
  fs.writeFileSync(out, png);
  console.log(`chart_png self-check OK: ${png.length} bytes -> ${out}`);
}
