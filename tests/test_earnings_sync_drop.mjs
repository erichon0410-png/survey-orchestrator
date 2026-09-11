import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createSuiteLock } from "./lib/suite_lock.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

// Private per-process inbox: `node --test` runs test files in parallel processes and
// the real reports/inbox/ is shared; a private temp dir eliminates marker-move races.
// Lives under reports/ (same filesystem) because syncEarnings rename()s markers into
// reports/processed/, which fails cross-device (EXDEV on WSL /tmp).
const tmpInboxRoot = fs.mkdtempSync(path.join(ROOT, "reports", ".test_inbox_drop-"));
const testInbox = path.join(tmpInboxRoot, "inbox");
fs.mkdirSync(testInbox, { recursive: true });

// Serialize this process's shared-ledger section against the other parallel suites.
const suiteLock = createSuiteLock(path.join(ROOT, "reports", ".suite_ledger.lock"));

// Regression: a balance DROP (a redemption happened) must be recorded as a new
// snapshot at the TRUE reported balance — not clamped back up to the previous
// high-water mark. Before the fix, `new_balance = Math.max(usd_earned, last)` +
// append-only-on-increase made redemptions invisible in the ledger.
import { syncEarnings } from "../scripts/earnings_sync.mjs";
import { appendSnapshot, readAll } from "../scripts/earnings_ledger.mjs";

console.log("=== earnings_sync: a redemption (balance drop) is recorded ===");

await suiteLock.acquire();
try {
{
  const testProcessed = path.join(ROOT, "reports", "processed");
  const testSeenFile = path.join(ROOT, "reports", ".test_drop_seen.json");
  const markerName = "9998_target_reached_20260905_120000.json";
  const markerPath = path.join(testInbox, markerName);
  const account = "_test:drop@example.com";

  try {
    if (fs.existsSync(testSeenFile)) fs.unlinkSync(testSeenFile);

    // Seed a prior HIGHER balance so the marker below is a genuine drop.
    appendSnapshot({ account, port: 9998, platform: "_test", balance_usd: 5.00, note: "seed" });
    const before = readAll().filter((e) => e.account === account).length;

    // Marker reports a LOWER current balance ($3.00): a $2 redemption happened.
    fs.writeFileSync(
      markerPath,
      JSON.stringify({
        port: 9998,
        ts: "2026-09-05T12:00:00Z",
        type: "target_reached",
        total_usd: 3.00,
        total_raw: null,
        account,
        platform: "_test",
      }),
      "utf-8"
    );

    const res = syncEarnings({ inboxDir: testInbox, processedDir: testProcessed, seenFilePath: testSeenFile, silent: true });

    // The drop MUST be recorded as a new snapshot at the TRUE reported balance.
    assert.equal(res.snapshotsAppended.length, 1, "a balance drop must append exactly one snapshot");
    const acc = res.snapshotsAppended.find((s) => s.account === account);
    assert.ok(acc, "the appended snapshot is for the test account");
    assert.equal(acc.balance_usd, 3.00, "drop recorded at true reported balance (not clamped to 5.00)");

    const after = readAll().filter((e) => e.account === account).length;
    assert.equal(after, before + 1, "ledger grew by exactly the one drop snapshot");
  } finally {
    if (fs.existsSync(markerPath)) fs.unlinkSync(markerPath);
    if (fs.existsSync(testSeenFile)) fs.unlinkSync(testSeenFile);
    fs.rmSync(tmpInboxRoot, { recursive: true, force: true });

    // Clean up _test: rows so the real ledger is left untouched.
    const ledgerPath = path.join(ROOT, "reports", "earnings_ledger.jsonl");
    if (fs.existsSync(ledgerPath)) {
      const lines = fs.readFileSync(ledgerPath, "utf-8").trim().split("\n");
      const cleaned = lines.filter((line) => {
        try { return !JSON.parse(line).account.startsWith("_test:"); } catch { return true; }
      });
      fs.writeFileSync(ledgerPath, cleaned.join("\n") + "\n", "utf-8");
    }
  }
}
} finally {
  suiteLock.release();
}

console.log("PASS earnings_sync drop recorded");
