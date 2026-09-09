// tests/test_chart_png.mjs — pure, stdlib-only PNG encoder + pixel primitives.
// Run: node tests/test_chart_png.mjs   (exit 0 = pass)
//
// These are the load-bearing correctness checks for a hand-rolled PNG writer:
// the file must be spec-valid (signature, IHDR dims, per-chunk CRC32) and its
// IDAT must inflate back to exactly the raw scanlines we fed it.

import assert from "node:assert/strict";
import zlib from "node:zlib";
import {
  pngEncode, crc32, createCanvas, setPixel, hline, vline, line, circle,
  drawText, FONT, findBreakEven, renderEarningsChart,
} from "../scripts/chart_png.mjs";

// --- test-local PNG chunk walker (independent of the module under test) ------
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function walkPng(buf) {
  assert.ok(Buffer.isBuffer(buf), "pngEncode returns a Buffer");
  assert.equal(buf.subarray(0, 8).toString("hex"), SIG.toString("hex"), "PNG signature");
  const chunks = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); off += 4;
    const type = buf.subarray(off, off + 4).toString("ascii"); off += 4;
    const data = Buffer.from(buf.subarray(off, off + len)); off += len;
    const crcStored = buf.readUInt32BE(off); off += 4;
    chunks.push({ type, len, data, crcStored });
  }
  return chunks;
}

// --- 1. pngEncode: structure, IHDR fields, IDAT round-trip, CRCs -----------
{
  const w = 3, h = 2;
  const rgba = Buffer.alloc(w * h * 4); // zeroed (transparent black) by default
  const put = (x, y, r, g, b, a) => { const i = (y * w + x) * 4; rgba[i] = r; rgba[i+1] = g; rgba[i+2] = b; rgba[i+3] = a; };
  put(0, 0, 255, 0, 0, 255);   // red, opaque
  put(2, 1, 0, 255, 0, 128);   // green, half alpha

  const png = pngEncode(w, h, rgba);
  const chunks = walkPng(png);
  assert.deepEqual(chunks.map((c) => c.type), ["IHDR", "IDAT", "IEND"], "chunk order");

  const ihdr = chunks[0].data;
  assert.equal(ihdr.readUInt32BE(0), w, "IHDR width");
  assert.equal(ihdr.readUInt32BE(4), h, "IHDR height");
  assert.equal(ihdr.readUInt8(8), 8, "bit depth 8");
  assert.equal(ihdr.readUInt8(9), 6, "color type 6 (RGBA)");

  // IDAT must inflate to the exact raw scanlines: per row a filter byte (0) then RGBA.
  const idat = zlib.inflateSync(chunks[1].data);
  const rowBytes = w * 4;
  const exp = Buffer.alloc(h * (1 + rowBytes));
  for (let y = 0; y < h; y++) {
    const o = y * (1 + rowBytes);
    exp[o] = 0; // PNG filter type 0 (None)
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      exp[o + 1 + x * 4 + 0] = rgba[p + 0];
      exp[o + 1 + x * 4 + 1] = rgba[p + 1];
      exp[o + 1 + x * 4 + 2] = rgba[p + 2];
      exp[o + 1 + x * 4 + 3] = rgba[p + 3];
    }
  }
  assert.ok(idat.equals(exp), "IDAT inflates to the exact raw scanlines");

  // Every chunk's stored CRC must match a recomputed CRC32 over (type + data).
  for (const c of chunks) {
    const payload = Buffer.concat([Buffer.from(c.type, "ascii"), c.data]);
    assert.equal(c.crcStored, crc32(payload), `CRC valid for ${c.type}`);
  }
}

// --- 2. canvas pixel primitives --------------------------------------------
{
  const BG = [10, 20, 30, 255];
  const c = createCanvas(5, 3, BG);
  // default fill: every pixel is BG
  { const i = (0 * 5 + 0) * 4; assert.equal(c.data[i], 10); assert.equal(c.data[i+3], 255); }

  setPixel(c, 1, 1, 255, 0, 0, 255);
  { const i = (1 * 5 + 1) * 4; assert.equal(c.data[i], 255); assert.equal(c.data[i+1], 0); }

  hline(c, 0, 4, 2, [0, 255, 0, 255]); // entire bottom row green
  for (let x = 0; x < 5; x++) { const i = (2 * 5 + x) * 4; assert.equal(c.data[i+1], 255); }

  vline(c, 3, 0, 2, [255, 255, 0, 255]); // entire column x=3 yellow
  for (let y = 0; y < 3; y++) { const i = (y * 5 + 3) * 4; assert.equal(c.data[i], 255); assert.equal(c.data[i+1], 255); }

  line(c, 0, 0, 4, 2, [255, 0, 255, 255]); // inclusive endpoints
  { const a = (0 * 5 + 0) * 4; assert.equal(c.data[a+2], 255); }   // start (0,0)
  { const b = (2 * 5 + 4) * 4; assert.equal(c.data[b+2], 255); }   // end (4,2)

  circle(c, 2, 1, 1, [0, 0, 255, 255]); // filled disk r=1 centered (2,1): center lit
  { const i = (1 * 5 + 2) * 4; assert.equal(c.data[i+2], 255); }
}

// --- 3. drawText / FONT: distinct glyphs render lit pixels on bg ----------
{
  const BG = [0, 0, 0, 255];
  const countLit = (c) => { let n = 0; for (let i = 0; i < c.data.length; i += 4) if (c.data[i] || c.data[i+1] || c.data[i+2]) n++; return n; };
  const mk = () => createCanvas(40, 12, BG);
  const a = mk(); drawText(a, 2, 2, "A", [255, 255, 255, 255], 1);
  const g = mk(); drawText(g, 2, 2, "G", [255, 255, 255, 255], 1);
  assert.ok(countLit(a) > 0, "glyph A lights pixels");
  assert.ok(countLit(g) > 0, "glyph G lights pixels");
  // distinct glyphs must not be pixel-identical
  const sig = (c) => c.data.toString("hex");
  assert.notEqual(sig(a), sig(g), "A and G render differently");
  // a glyph covers only its own box: corner (0,0) stays background
  { const i = (0 * 40 + 0) * 4; assert.equal(a.data[i], 0); }
  // required glyphs are all defined
  for (const ch of ["S","U","R","V","E","Y","A","N","I","G","M","O","C","T","B","K","D",
                    "0","1","2","3","4","5","6","7","8","9", "$", "/", "-", ".", "@"]) {
    assert.ok(Array.isArray(FONT[ch]) && FONT[ch].length === 7, `FONT has glyph "${ch}"`);
  }
}

// --- 4. findBreakEven -----------------------------------------------------
{
  // $1/day cost from t0; break-even = first i with cumulative_usd >= cost(i) and > 0.
  const series = [
    { date: "2026-01-01", cumulative_usd: 0 },
    { date: "2026-01-02", cumulative_usd: 1 }, // cost(1 day)=$1 -> 1>=1 => break-even here
    { date: "2026-01-03", cumulative_usd: 2 },
  ];
  const be = findBreakEven(series, 1, "2026-01-01");
  assert.ok(be, "finds a break-even");
  assert.equal(be.index, 1);
  assert.equal(be.date, "2026-01-02");

  // No crossing yet -> null.
  const never = [
    { date: "2026-01-01", cumulative_usd: 0 },
    { date: "2026-01-02", cumulative_usd: 0.5 }, // cost $1 > 0.5
    { date: "2026-01-03", cumulative_usd: 0.9 },
  ];
  assert.equal(findBreakEven(never, 1, "2026-01-01"), null, "no crossing -> null");
}

// --- 5. renderEarningsChart smoke ----------------------------------------
{
  const series = [
    { date: "2026-01-01", cumulative_usd: 0 },
    { date: "2026-01-02", cumulative_usd: 5 },
    { date: "2026-01-03", cumulative_usd: 9 },
  ];
  const png = renderEarningsChart({ series, costPerDayUsd: 20 / 30, t0Date: "2026-01-01" });
  const chunks = walkPng(png);
  assert.equal(chunks[0].type, "IHDR");
  const w = chunks[0].data.readUInt32BE(0), h = chunks[0].data.readUInt32BE(4);
  assert.ok(w >= 800 && h >= 400, `chart canvas is a real size (${w}x${h})`);

  // Degenerate: empty series must still produce a valid PNG (no crash).
  const png2 = renderEarningsChart({ series: [], costPerDayUsd: 20 / 30, t0Date: "2026-01-01" });
  assert.equal(walkPng(png2)[0].type, "IHDR");
}

console.log("PASS test_chart_png");
