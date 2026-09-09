#!/usr/bin/env node
// scripts/earnings_derive.mjs — pure derivation over the append-only earnings ledger.
// Node >= 18, stdlib only (node:fs, node:path, node:url). No I/O at import time.
//
// The ledger (reports/earnings_ledger.jsonl) records a TRUE reported balance per
// account each sync; a redemption shows up as the balance going DOWN between two
// consecutive snapshots. This module turns those raw balance series into events:
//   - earn events      (positive delta)  -> gross earnings, feed the daily CSV + graph
//   - withdraw events  (negative delta)  -> redemptions, auto-categorized
//
// API:
//   categorizeWithdrawal(usd) -> "subscription" | "leisure"
//     $20-$25 (inclusive) is a ChatGPT Plus subscription redemption; anything else
//     is leisure. Non-finite input fails safe to "leisure".

// A redemption in the $20-$25 band is the monthly ChatGPT Plus subscription
// withdrawal. Every other amount is treated as leisure spending.
export function categorizeWithdrawal(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n)) return "leisure";
  if (n >= 20 && n <= 25) return "subscription";
  return "leisure";
}

// --- earn / withdraw event extraction ----------------------------------------

// Sub-cent float wobble from subtracting two money values is treated as "no
// change" so we never emit a spurious $0.00x event. Half a cent is the floor.
const DELTA_EPS = 0.005;

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Derive earn/withdraw events from raw balance snapshots.
 *
 * @param {Array<{ts:string, account:string, balance_usd:number}>} entries
 *   Raw ledger rows (any extra fields ignored). `account` groups the series;
 *   each account is walked chronologically by `ts` independently, so deltas
 *   never cross from one account to another.
 * @returns {Array<{ts:string, account:string, kind:"earn"|"withdraw",
 *          usd:number, category?:string}>}
 *   One event per non-zero consecutive delta: positive -> earn; negative ->
 *   withdraw (auto-categorized). Deterministically sorted by ts then account.
 */
export function deriveEvents(entries) {
  if (!Array.isArray(entries)) return [];

  const groups = new Map();
  for (const e of entries) {
    if (!e || e.account == null) continue;
    const bal = Number(e.balance_usd);
    if (!Number.isFinite(bal)) continue;
    let g = groups.get(e.account);
    if (!g) { g = []; groups.set(e.account, g); }
    g.push({ ts: e.ts, balance_usd: bal });
  }

  const events = [];
  for (const [account, rows] of groups) {
    // ISO-8601 UTC timestamps sort lexicographically == chronologically.
    rows.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    for (let i = 1; i < rows.length; i++) {
      const delta = round2(rows[i].balance_usd - rows[i - 1].balance_usd);
      if (delta > DELTA_EPS) {
        events.push({ ts: rows[i].ts, account, kind: "earn", usd: round2(delta) });
      } else if (delta < -DELTA_EPS) {
        const amt = round2(-delta);
        events.push({ ts: rows[i].ts, account, kind: "withdraw", usd: amt, category: categorizeWithdrawal(amt) });
      }
    }
  }

  events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.account < b.account ? -1 : a.account > b.account ? 1 : 0));
  return events;
}

// --- daily aggregation + cumulative series -----------------------------------

function utcDate(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10); // "YYYY-MM-DD" in UTC
}

/**
 * Sum EARN events per UTC calendar day. Withdrawals are redemptions (they lower
 * the balance) and never count as earnings. Returns one row per active day,
 * ascending: [{date:"YYYY-MM-DD", amount_earned_usd:<n>}]. Days with no earn
 * activity are omitted (the graph carries forward across gaps).
 */
export function dailyEarnings(events) {
  if (!Array.isArray(events)) return [];
  const byDate = new Map();
  for (const e of events) {
    if (!e || e.kind !== "earn") continue;
    const usd = Number(e.usd);
    if (!Number.isFinite(usd) || usd <= 0) continue;
    const date = utcDate(e.ts);
    if (!date) continue;
    byDate.set(date, round2((byDate.get(date) || 0) + usd));
  }
  return [...byDate.keys()].sort().map((date) => ({ date, amount_earned_usd: byDate.get(date) }));
}

/**
 * Running total over (already sorted) daily earnings rows -> the cumulative
 * gross-earnings line for the graph. Adds {cumulative_usd} to each row.
 */
export function cumulativeSeries(dailyRows) {
  if (!Array.isArray(dailyRows)) return [];
  let run = 0;
  const out = [];
  for (const r of dailyRows) {
    const amt = Number(r.amount_earned_usd);
    run = round2(run + (Number.isFinite(amt) ? amt : 0));
    out.push({ date: r.date, amount_earned_usd: r.amount_earned_usd, cumulative_usd: run });
  }
  return out;
}
