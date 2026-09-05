#!/usr/bin/env node
// scripts/earnings_ledger.mjs — append-only earnings ledger (single source of truth).
// Node >= 18, stdlib only (node:fs, node:path, node:url).
//
// Ledger format: reports/earnings_ledger.jsonl
// Each line: {"ts":"<ISO8601 UTC>","account":"<platform>:<email>","port":<n>,"platform":"<name>","balance_usd":<n>,"points_raw":<n|null>,"note":"..."}
//
// API:
//   appendSnapshot({account, port, platform, balance_usd, points_raw, note}) -> appends one line
//   latestBalances() -> Map<account, {account, port, platform, balance_usd, points_raw, ts, note}>
//   seriesFor(account) -> [{ts, balance_usd, points_raw, note}, ...] chronological
//
// CLI (standalone): node scripts/earnings_ledger.mjs
//   Runs a self-test: appends a test snapshot, reads it back, prints latestBalances().

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const LEDGER_PATH = path.join(ROOT, "reports", "earnings_ledger.jsonl");

// --- API ---

/**
 * Append a single balance snapshot to the ledger.
 * @param {{account: string, port: number, platform: string, balance_usd: number, points_raw: number|null, note?: string}} entry
 */
export function appendSnapshot({ account, port, platform, balance_usd, points_raw = null, note = "", ts = null }) {
  if (!account || port == null || !platform || balance_usd == null) {
    throw new Error("appendSnapshot: account, port, platform, balance_usd are required");
  }
  const line = JSON.stringify({
    ts: ts || new Date().toISOString(),
    account,
    port,
    platform,
    balance_usd: Number(balance_usd),
    points_raw: points_raw != null ? Number(points_raw) : null,
    note: note || "",
  });
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  fs.appendFileSync(LEDGER_PATH, line + "\n", "utf-8");
}

/**
 * Read the entire ledger into an array of parsed entries.
 * @returns {Array<Object>}
 */
export function readAll() {
  if (!fs.existsSync(LEDGER_PATH)) return [];
  const text = fs.readFileSync(LEDGER_PATH, "utf-8").trim();
  if (!text) return [];
  return text.split("\n").map((line) => {
    try { return JSON.parse(line); }
    catch { return null; }
  }).filter(Boolean);
}

/**
 * Get the latest balance snapshot for each account.
 * @returns {Map<string, Object>} account -> latest entry
 */
export function latestBalances() {
  const entries = readAll();
  const latest = new Map();
  for (const e of entries) {
    latest.set(e.account, e); // last one wins (chronological append order)
  }
  return latest;
}

/**
 * Get the chronological time series for a specific account.
 * @param {string} account - e.g. "swagbucks:erichong0410@gmail.com"
 * @returns {Array<{ts: string, balance_usd: number, points_raw: number|null, note: string}>}
 */
export function seriesFor(account) {
  return readAll()
    .filter((e) => e.account === account)
    .map(({ ts, balance_usd, points_raw, note }) => ({ ts, balance_usd, points_raw, note }));
}

/**
 * Get the ledger file path (for external consumers).
 */
export function ledgerPath() {
  return LEDGER_PATH;
}

// --- CLI self-test ---
const isCLI = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isCLI) {
  console.log("=== earnings_ledger.mjs self-test ===");
  console.log(`Ledger path: ${LEDGER_PATH}`);

  // Round-trip test: append then read back
  const testEntry = {
    account: "_test:selftest@example.com",
    port: 9999,
    platform: "_test",
    balance_usd: 1.23,
    points_raw: 123,
    note: "self-test entry",
  };
  console.log("\nAppending test entry:", JSON.stringify(testEntry));
  appendSnapshot(testEntry);

  const series = seriesFor("_test:selftest@example.com");
  console.log(`\nRead back ${series.length} entry/entries for _test:selftest@example.com:`);
  console.log(JSON.stringify(series[series.length - 1], null, 2));

  console.log("\n--- Latest balances (all accounts) ---");
  const balances = latestBalances();
  let grandTotal = 0;
  for (const [acct, entry] of balances) {
    if (acct.startsWith("_test:")) continue; // skip test entries in totals
    console.log(`  ${acct}: $${entry.balance_usd.toFixed(2)} (port ${entry.port}, ${entry.ts})`);
    grandTotal += entry.balance_usd;
  }
  console.log(`\n  GRAND TOTAL: $${grandTotal.toFixed(2)}`);

  // Clean up test entry (remove last line if it's the test)
  const allLines = fs.readFileSync(LEDGER_PATH, "utf-8").trim().split("\n");
  const cleaned = allLines.filter((line) => {
    try { return JSON.parse(line).account !== "_test:selftest@example.com"; }
    catch { return true; }
  });
  fs.writeFileSync(LEDGER_PATH, cleaned.join("\n") + "\n", "utf-8");
  console.log("\nTest entry cleaned up. Self-test PASSED.");
}
