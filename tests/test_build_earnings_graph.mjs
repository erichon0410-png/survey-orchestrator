// tests/test_build_earnings_graph.mjs — artifact builders for the earnings feature.
// Run: node tests/test_build_earnings_graph.mjs   (exit 0 = pass)
//
// Focused on the NEW behaviors added to scripts/build_earnings_graph.mjs:
//   - buildCsv(dailyRows)        -> "day,amount_earned" CSV text
//   - buildSpendLedger(events)   -> JSONL of auto-categorized redemption (withdraw) events
//   - computeArtifacts(entries)  -> { csv, spendLedger, pngBuffer, html, t0Date, breakEven }
// The PNG itself is already covered by test_chart_png.mjs; here we only assert the
// builder wires deriveEvents -> dailyEarnings -> cumulativeSeries -> renderEarningsChart
// correctly and emits valid, well-formed artifacts.

import assert from "node:assert/strict";
import {
  buildCsv, buildSpendLedger, buildSeries, computeArtifacts,
} from "../scripts/build_earnings_graph.mjs";

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Deterministic fixture: two accounts.
//   A: 0 -> 5 (earn +5) -> -15 (withdraw 20 => "subscription" band $20-$25)
//   B: 0 -> 3 (earn +3) -> 1  (withdraw 2  => "leisure")
// Earliest ts across all rows is 2026-09-01, so the fresh-start t0Date = 2026-09-01.
const ENTRIES = [
  { ts: "2026-09-01T00:00:00.000Z", account: "p:a@x", platform: "p", balance_usd: 0 },
  { ts: "2026-09-01T00:00:00.000Z", account: "q:b@x", platform: "q", balance_usd: 0 },
  { ts: "2026-09-02T00:00:00.000Z", account: "p:a@x", platform: "p", balance_usd: 5 },
  { ts: "2026-09-02T00:00:00.000Z", account: "q:b@x", platform: "q", balance_usd: 3 },
  { ts: "2026-09-05T00:00:00.000Z", account: "p:a@x", platform: "p", balance_usd: -15 },
  { ts: "2026-09-06T00:00:00.000Z", account: "q:b@x", platform: "q", balance_usd: 1 },
];

// --- 1. buildCsv -----------------------------------------------------------
{
  const dailyRows = [{ date: "2026-09-02", amount_earned_usd: 8 }];
  const csv = buildCsv(dailyRows);
  assert.equal(csv, "day,amount_earned\n2026-09-02,8.00\n", "buildCsv header + one row");

  // Empty -> header line only.
  assert.equal(buildCsv([]), "day,amount_earned\n", "buildCsv empty is header-only");
}

// --- 2. buildSpendLedger (auto-categorized redemptions) --------------------
{
  const events = [
    { ts: "2026-09-03T00:00:00.000Z", account: "p:a@x", kind: "earn", usd: 5 },
    { ts: "2026-09-05T00:00:00.000Z", account: "p:a@x", kind: "withdraw", usd: 20, category: "subscription" },
    { ts: "2026-09-06T00:00:00.000Z", account: "q:b@x", kind: "withdraw", usd: 2, category: "leisure" },
  ];
  const text = buildSpendLedger(events);
  const lines = text.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
  assert.equal(lines.length, 2, "only withdraw events are tracked");
  assert.deepEqual(
    lines.map((r) => r.category),
    ["subscription", "leisure"],
    "categories preserved in order"
  );
  assert.equal(lines[0].usd, 20);
  assert.equal(lines[1].usd, 2);
  // earn events must NOT appear.
  assert.ok(!text.includes('"kind":"earn"'), "no earn rows in spend ledger");
}

// --- 3. computeArtifacts wires the full pipeline ---------------------------
{
  const art = computeArtifacts(ENTRIES);

  // t0Date = earliest active date across accounts (fresh-start baseline).
  assert.equal(art.t0Date, "2026-09-01", "t0Date is the earliest ledger date");

  // CSV reflects gross earnings (both accounts' +5 and +3 on 09-02 = $8.00).
  assert.equal(art.csv, "day,amount_earned\n2026-09-02,8.00\n", "csv from derive pipeline");

  // Spend ledger carries the two auto-categorized redemptions.
  const spendLines = art.spendLedger.split("\n").filter((l) => l.length > 0);
  assert.equal(spendLines.length, 2, "two redemption rows");
  const parsed = spendLines.map((l) => JSON.parse(l));
  assert.deepEqual(
    parsed.map((r) => r.category).sort(),
    ["leisure", "subscription"],
    "redemptions auto-categorized"
  );

  // PNG is a valid, correctly-dimensioned image (900x480 per chart_png).
  assert.ok(Buffer.isBuffer(art.pngBuffer), "pngBuffer is a Buffer");
  assert.equal(art.pngBuffer.subarray(0, 8).toString("hex"), PNG_SIG.toString("hex"), "PNG signature");
  assert.equal(art.pngBuffer.readUInt32BE(16), 900, "IHDR width");
  assert.equal(art.pngBuffer.readUInt32BE(20), 480, "IHDR height");
  assert.ok(art.pngBuffer.length > 1000, "PNG is non-trivial size");

  // Break-even: cumulative $8 on 09-02 already exceeds the ~$0.67 cost accrued by then.
  assert.ok(art.breakEven != null, "break-even found for the fixture");
  assert.equal(art.breakEven.date, "2026-09-02", "break-even on first earning day");

  // HTML carries the $20/mo cost line + break-even status.
  assert.ok(typeof art.html === "string" && art.html.length > 0, "html is a string");
  assert.ok(art.html.includes("$20/mo"), "html references the $20/mo cost line");
  assert.ok(art.html.includes("BREAK-EVEN"), "html marks break-even");
}

// --- 4. computeArtifacts on an empty ledger (fresh, pre-first-sync) -------
{
  const art = computeArtifacts([]);
  assert.equal(art.csv, "day,amount_earned\n", "empty csv is header-only");
  assert.equal(art.spendLedger, "", "no redemptions -> empty spend ledger");
  assert.ok(Buffer.isBuffer(art.pngBuffer) && art.pngBuffer.subarray(0, 8).toString("hex") === PNG_SIG.toString("hex"), "empty still yields a valid PNG");
  assert.equal(art.breakEven, null, "no break-even with no data");
  assert.ok(art.html.includes("not yet"), "html reports break-even not yet reached");
}

// --- 5. buildSeries dedupes by platform (the double-count fix) -------------
{
  // Two account keys sharing ONE platform must collapse to a single series key,
  // and the TOTAL line must reflect that platform's balance once, not twice.
  const DUP = [
    { ts: "2026-09-01T00:00:00.000Z", account: "swagbucks:a@x", platform: "swagbucks", balance_usd: 0 },
    { ts: "2026-09-01T00:00:00.000Z", account: "swagbucks:b@x", platform: "swagbucks", balance_usd: 0 },
    { ts: "2026-09-02T00:00:00.000Z", account: "swagbucks:a@x", platform: "swagbucks", balance_usd: 10 },
    { ts: "2026-09-02T00:00:00.000Z", account: "swagbucks:b@x", platform: "swagbucks", balance_usd: 10 },
  ];
  const bs = buildSeries(DUP);
  assert.equal(bs.accounts.length, 1, "two accounts on one platform collapse to a single series key");
  assert.equal(bs.accounts[0], "swagbucks", "the single key is the platform name");
  const totalLast = bs.series["TOTAL"][bs.series["TOTAL"].length - 1].balance_usd;
  assert.equal(totalLast, 10, "TOTAL reflects the platform balance once, not twice (10, not 20)");
}

console.log("test_build_earnings_graph: OK");
