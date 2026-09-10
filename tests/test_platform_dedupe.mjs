// tests/test_platform_dedupe.mjs — platform-deduped current-balance total.
// Run: node tests/test_platform_dedupe.mjs   (exit 0 = pass)
//
// Guards the "double-count" fix. The same real platform can appear under TWO
// account keys in the ledger (a historical real email + a config placeholder,
// e.g. swagbucks:erichong...@gmail.com and swagbucks:user02@example.com).
// latestBalances() is per-account-key (correct for sync lookups); but summing it
// counts each platform twice. latestPlatformBalances() collapses to ONE entry per
// platform so any displayed total is not double-counted.

import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  appendSnapshot, readAll, latestBalances, latestPlatformBalances, ledgerPath,
} from "../scripts/earnings_ledger.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const P1 = "_testplatA";   // platform shared by TWO account keys (the double-count case)
const P2 = "_testplatB";   // a single-key platform, for contrast
const A1 = "_test:aa@example.com";
const A2 = "_test:bb@example.com";
const B1 = "_test:cc@example.com";

function cleanup() {
  const p = ledgerPath();
  if (!fs.existsSync(p)) return;
  const lines = fs.readFileSync(p, "utf-8").trim().split("\n");
  const keep = lines.filter((line) => {
    try { const o = JSON.parse(line); return !o.account.startsWith("_test:"); } catch { return true; }
  });
  fs.writeFileSync(p, keep.length ? keep.join("\n") + "\n" : "", "utf-8");
}

try {
  // Deterministic snapshots. P1 appears under two account keys (A1 then A2); A2 is the
  // later append so it must win for platform P1. B1 is a distinct platform P2.
  appendSnapshot({ account: A1, port: 9001, platform: P1, balance_usd: 10.00, ts: "2026-09-01T00:00:00.000Z", note: "t" });
  appendSnapshot({ account: A2, port: 9002, platform: P1, balance_usd: 20.00, ts: "2026-09-02T00:00:00.000Z", note: "t" });
  appendSnapshot({ account: B1, port: 9003, platform: P2, balance_usd: 7.50, ts: "2026-09-02T00:00:00.000Z", note: "t" });

  // (1) latestBalances() stays per-account-key: BOTH A1 and A2 are present.
  const lb = latestBalances();
  assert.ok(lb.has(A1), "latestBalances keeps account key A1");
  assert.ok(lb.has(A2), "latestBalances keeps account key A2");
  assert.equal(lb.get(A1).balance_usd, 10.00);
  assert.equal(lb.get(A2).balance_usd, 20.00);

  // (2) latestPlatformBalances() collapses to ONE entry per platform; last-wins by append order.
  const lp = latestPlatformBalances();
  assert.ok(lp.has(P1), "platform P1 present");
  assert.ok(lp.has(P2), "platform P2 present");
  assert.equal(lp.get(P1).balance_usd, 20.00, "P1 collapses two account keys to the last-appended balance");
  assert.equal(lp.get(P1).account, A2, "P1 winner is the later account key (A2)");
  assert.equal(lp.get(P2).balance_usd, 7.50);

  // (3) Deduped total over our synthetic platforms = per-platform values (20 + 7.5),
  //     NOT the per-account sum (10 + 20 + 7.5 = 37.5).
  let deduped = 0;
  for (const p of [P1, P2]) deduped += lp.get(p).balance_usd;
  assert.equal(deduped, 27.50, "deduped total is per-platform, not per-account");

  // (4) On the real ledger: every distinct platform maps to its own last-appended balance.
  const all = readAll();
  const platformsInLedger = new Set(all.map((e) => e.platform).filter(Boolean));
  for (const p of platformsInLedger) {
    if (p.startsWith("_test")) continue; // ignore our synthetic rows
    const lastForPlatform = [...all].reverse().find((e) => e.platform === p);
    assert.ok(lp.has(p), `real platform ${p} present in latestPlatformBalances`);
    assert.equal(lp.get(p).balance_usd, lastForPlatform.balance_usd, `platform ${p} maps to its last-appended balance`);
  }

  console.log("test_platform_dedupe: OK");
} finally {
  cleanup();
}
