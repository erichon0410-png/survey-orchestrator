import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

// Task: earnings_derive — withdrawal categorization
import { categorizeWithdrawal } from "../scripts/earnings_derive.mjs";

console.log("=== categorizeWithdrawal ($20-$25 -> subscription, else leisure) ===");

{
  // In-bounds band -> subscription (ChatGPT Plus).
  assert.equal(categorizeWithdrawal(20), "subscription", "20.00 is the lower bound -> subscription");
  assert.equal(categorizeWithdrawal(24.99), "subscription", "24.99 inside band -> subscription");
  assert.equal(categorizeWithdrawal(25), "subscription", "25.00 is the upper bound -> subscription");
  // Out-of-band -> leisure.
  assert.equal(categorizeWithdrawal(19.99), "leisure", "19.99 just below band -> leisure");
  assert.equal(categorizeWithdrawal(25.01), "leisure", "25.01 just above band -> leisure");
  assert.equal(categorizeWithdrawal(5), "leisure", "small amount -> leisure");
  assert.equal(categorizeWithdrawal(50), "leisure", "large amount -> leisure");
  assert.equal(categorizeWithdrawal(0), "leisure", "zero -> leisure (not a real redemption)");
}

console.log("PASS categorizeWithdrawal");

// ---------------------------------------------------------------------------
// deriveEvents: per-account walk of consecutive balance snapshots.
//   delta > 0 -> earn event (usd = +delta)
//   delta < 0 -> withdraw event (usd = -delta, auto-categorized)
//   delta == 0 -> nothing
import { deriveEvents } from "../scripts/earnings_derive.mjs";

console.log("=== deriveEvents (consecutive-delta earn/withdraw extraction) ===");
const T = (s) => `2026-09-0${s}T00:00:00.000Z`; // stable ISO timestamps, one per index

{
  // Positive delta -> one earn event of the right size, stamped at the newer row.
  const ev = deriveEvents([
    { ts: T(1), account: "p:a@x", balance_usd: 10 },
    { ts: T(2), account: "p:a@x", balance_usd: 16 },
  ]);
  assert.equal(ev.length, 1, "one earn event");
  assert.deepEqual(ev[0], { ts: T(2), account: "p:a@x", kind: "earn", usd: 6 });
}
{
  // Negative delta in the $20-$25 band -> withdraw, category "subscription".
  const ev = deriveEvents([
    { ts: T(1), account: "p:a@x", balance_usd: 50 },
    { ts: T(2), account: "p:a@x", balance_usd: 30 }, // -20 -> subscription
  ]);
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0], { ts: T(2), account: "p:a@x", kind: "withdraw", usd: 20, category: "subscription" });
}
{
  // Negative delta outside the band -> withdraw, category "leisure".
  const ev = deriveEvents([
    { ts: T(1), account: "p:a@x", balance_usd: 50 },
    { ts: T(2), account: "p:a@x", balance_usd: 10 }, // -40 -> leisure
  ]);
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0], { ts: T(2), account: "p:a@x", kind: "withdraw", usd: 40, category: "leisure" });
}
{
  // Mixed sequence: earn then withdraw, each from its own consecutive pair.
  const ev = deriveEvents([
    { ts: T(1), account: "p:a@x", balance_usd: 10 },
    { ts: T(2), account: "p:a@x", balance_usd: 18 }, // +8 earn
    { ts: T(3), account: "p:a@x", balance_usd: 13 }, // -5 withdraw (leisure)
  ]);
  assert.equal(ev.length, 2);
  assert.deepEqual(ev[0], { ts: T(2), account: "p:a@x", kind: "earn", usd: 8 });
  assert.deepEqual(ev[1], { ts: T(3), account: "p:a@x", kind: "withdraw", usd: 5, category: "leisure" });
}
{
  // Multiple accounts interleaved: deltas are per-account only (no cross-talk).
  const ev = deriveEvents([
    { ts: T(1), account: "A", balance_usd: 10 },
    { ts: T(1), account: "B", balance_usd: 100 },
    { ts: T(2), account: "A", balance_usd: 14 }, // A +4 earn
    { ts: T(2), account: "B", balance_usd: 90 },  // B -10 withdraw (leisure)
  ]);
  const byAcc = {};
  for (const e of ev) (byAcc[e.account] ||= []).push(e);
  assert.deepEqual(byAcc["A"], [{ ts: T(2), account: "A", kind: "earn", usd: 4 }]);
  assert.deepEqual(byAcc["B"], [{ ts: T(2), account: "B", kind: "withdraw", usd: 10, category: "leisure" }]);
}
{
  // Single snapshot per account -> baseline, no events. Flat balance -> no events.
  assert.equal(deriveEvents([{ ts: T(1), account: "A", balance_usd: 10 }]).length, 0);
  assert.equal(deriveEvents([
    { ts: T(1), account: "A", balance_usd: 10 },
    { ts: T(2), account: "A", balance_usd: 10 },
  ]).length, 0);
}

console.log("PASS deriveEvents");

// ---------------------------------------------------------------------------
// dailyEarnings: sum EARN events per UTC calendar day (withdrawals excluded).
// cumulativeSeries: running total over the sorted daily rows (graph line).
import { dailyEarnings, cumulativeSeries } from "../scripts/earnings_derive.mjs";

console.log("=== dailyEarnings + cumulativeSeries ===");
{
  // Two earn events on the same UTC day collapse into one summed row.
  const rows = dailyEarnings([
    { ts: "2026-09-05T03:00:00.000Z", account: "A", kind: "earn", usd: 4 },
    { ts: "2026-09-05T18:00:00.000Z", account: "B", kind: "earn", usd: 6 },
  ]);
  assert.deepEqual(rows, [{ date: "2026-09-05", amount_earned_usd: 10 }]);
}
{
  // Withdrawals are redemptions, not earnings — they never add to a day total.
  const rows = dailyEarnings([
    { ts: "2026-09-04T02:00:00.000Z", account: "A", kind: "earn", usd: 5 },
    { ts: "2026-09-04T09:00:00.000Z", account: "A", kind: "withdraw", usd: 20, category: "subscription" },
  ]);
  assert.deepEqual(rows, [{ date: "2026-09-04", amount_earned_usd: 5 }]);
}
{
  // Multiple days -> one row per active day, ascending; inactive days omitted.
  const rows = dailyEarnings([
    { ts: "2026-09-06T10:00:00.000Z", account: "A", kind: "earn", usd: 7 },
    { ts: "2026-09-04T10:00:00.000Z", account: "A", kind: "earn", usd: 3 },
  ]);
  assert.deepEqual(rows, [
    { date: "2026-09-04", amount_earned_usd: 3 },
    { date: "2026-09-06", amount_earned_usd: 7 },
  ]);
}
{
  // No earn events (or none at all) -> empty.
  assert.deepEqual(dailyEarnings([]), []);
  assert.deepEqual(dailyEarnings([
    { ts: "2026-09-04T10:00:00.000Z", account: "A", kind: "withdraw", usd: 22, category: "subscription" },
  ]), []);
}
{
  // cumulativeSeries -> running total over the (already sorted) daily rows.
  const cum = cumulativeSeries([
    { date: "2026-09-04", amount_earned_usd: 3 },
    { date: "2026-09-06", amount_earned_usd: 7 },
  ]);
  assert.deepEqual(cum, [
    { date: "2026-09-04", amount_earned_usd: 3, cumulative_usd: 3 },
    { date: "2026-09-06", amount_earned_usd: 7, cumulative_usd: 10 },
  ]);
  assert.deepEqual(cumulativeSeries([]), []);
}

console.log("PASS dailyEarnings + cumulativeSeries");
