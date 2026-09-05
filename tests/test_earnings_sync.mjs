import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

// Task 1: import parseEarningsRates and loadEarningsRates
import { parseEarningsRates, loadEarningsRates } from "../scripts/earnings_sync.mjs";

console.log("=== Task 1 Tests: parseEarningsRates & loadEarningsRates ===");

{
  // Test 1: load real config/earnings_rates.yaml
  const ratesPath = path.join(ROOT, "config", "earnings_rates.yaml");
  const config = loadEarningsRates(ratesPath);

  assert.ok(config.accounts, "config.accounts must exist");
  assert.ok(config.portMap, "config.portMap must exist");

  // Port map tests
  assert.equal(config.portMap[3013], "opinionoutpost:nupkill64@gmail.com");
  assert.equal(config.portMap[3014], "swagbucks:erichong0410@gmail.com");
  assert.equal(config.portMap[3015], "primeopinion:nupkill104@gmail.com");
  assert.equal(config.portMap[3016], "surveyjunkie:nupkill94@gmail.com");
  assert.equal(config.portMap[3017], "swagbucks:erichong0410@gmail.com");

  // Accounts tests
  const sb = config.accounts["swagbucks:erichong0410@gmail.com"];
  assert.ok(sb, "Swagbucks account config must exist");
  assert.equal(sb.platform, "swagbucks");
  assert.equal(sb.conversion, "points_to_usd");
  assert.equal(sb.rate, 0.01);
  assert.deepEqual(sb.ports, [3014, 3017]);

  const oo = config.accounts["opinionoutpost:nupkill64@gmail.com"];
  assert.ok(oo, "OpinionOutpost account config must exist");
  assert.equal(oo.conversion, "platform_displayed_usd");

  const sj = config.accounts["surveyjunkie:nupkill94@gmail.com"];
  assert.ok(sj, "SurveyJunkie account config must exist");
  assert.equal(sj.conversion, "points_to_usd");
  assert.equal(sj.rate, 0.01);

  const po = config.accounts["primeopinion:nupkill104@gmail.com"];
  assert.ok(po, "PrimeOpinion account config must exist");
  assert.equal(po.conversion, "platform_displayed_usd");

  console.log("✓ Task 1 Passed: parseEarningsRates & loadEarningsRates");
}

// Task 2: import seen set helpers and computeMarkerEarnings
import {
  loadSeenSet,
  saveSeenSet,
  computeMarkerEarnings,
  scanMarkerFiles,
} from "../scripts/earnings_sync.mjs";

console.log("\n=== Task 2 Tests: Seen-Set & computeMarkerEarnings ===");

{
  // Test 2.1: computeMarkerEarnings with points_to_usd (e.g. swagbucks)
  const rates = loadEarningsRates();
  const sbMarker = {
    port: 3014,
    ts: "2026-09-04T12:00:00Z",
    type: "target_reached",
    total_raw: 500,
    total_usd: 99.99, // stale / bogus total_usd to test that rate * total_raw is used!
  };
  const sbRes = computeMarkerEarnings(sbMarker, rates);
  assert.equal(sbRes.account, "swagbucks:erichong0410@gmail.com");
  assert.equal(sbRes.platform, "swagbucks");
  assert.equal(sbRes.usd_earned, 5.00, "Must calculate 500 * 0.01 = 5.00, ignoring stale total_usd");
  assert.equal(sbRes.points_raw, 500);

  // Test 2.2: computeMarkerEarnings with shared port 3017 (swagbucks)
  const sbMarker2 = {
    port: 3017,
    ts: "2026-09-04T12:30:00Z",
    type: "target_reached",
    total_raw: 250,
  };
  const sbRes2 = computeMarkerEarnings(sbMarker2, rates);
  assert.equal(sbRes2.account, "swagbucks:erichong0410@gmail.com", "Port 3017 must map to same Swagbucks account");
  assert.equal(sbRes2.usd_earned, 2.50);

  // Test 2.3: computeMarkerEarnings with platform_displayed_usd (opinionoutpost)
  const ooMarker = {
    port: 3013,
    ts: "2026-09-04T13:00:00Z",
    type: "target_reached",
    total_usd: 5.25,
    total_raw: null,
  };
  const ooRes = computeMarkerEarnings(ooMarker, rates);
  assert.equal(ooRes.account, "opinionoutpost:nupkill64@gmail.com");
  assert.equal(ooRes.platform, "opinionoutpost");
  assert.equal(ooRes.usd_earned, 5.25);

  // Test 2.4: computeMarkerEarnings with surveyjunkie (points_to_usd)
  const sjMarker = {
    port: 3016,
    ts: "2026-09-04T14:00:00Z",
    type: "target_reached",
    total_raw: 350,
    total_usd: 0,
  };
  const sjRes = computeMarkerEarnings(sjMarker, rates);
  assert.equal(sjRes.account, "surveyjunkie:nupkill94@gmail.com");
  assert.equal(sjRes.usd_earned, 3.50);

  // Test 2.5: Seen-set save & load roundtrip
  const tmpSeenPath = path.join(ROOT, "reports", ".test_seen.json");
  try {
    if (fs.existsSync(tmpSeenPath)) fs.unlinkSync(tmpSeenPath);
    const seenData = loadSeenSet(tmpSeenPath);
    assert.deepEqual(seenData.seen, {});

    seenData.seen["3014_target_reached_20260904_120000.json"] = {
      processed_at: "2026-09-04T12:00:05Z",
      account: "swagbucks:erichong0410@gmail.com",
      usd_earned: 5.0,
    };
    saveSeenSet(tmpSeenPath, seenData);

    const reloaded = loadSeenSet(tmpSeenPath);
    assert.ok(reloaded.seen["3014_target_reached_20260904_120000.json"]);
    assert.equal(reloaded.seen["3014_target_reached_20260904_120000.json"].usd_earned, 5.0);
  } finally {
    if (fs.existsSync(tmpSeenPath)) fs.unlinkSync(tmpSeenPath);
  }

  // Test 2.6: scanMarkerFiles finds target_reached markers across inbox and processed
  const testInbox = path.join(ROOT, "reports", "inbox");
  const testProcessed = path.join(ROOT, "reports", "processed");
  const tmpMarkerName = "3099_target_reached_20260904_999998.json";
  const tmpMarkerPath = path.join(testInbox, tmpMarkerName);
  try {
    fs.writeFileSync(tmpMarkerPath, JSON.stringify({ port: 3099, type: "target_reached" }));
    const found = scanMarkerFiles(testInbox, testProcessed);
    assert.ok(found.some((p) => p.endsWith(tmpMarkerName)), "scanMarkerFiles must find inbox marker");
  } finally {
    if (fs.existsSync(tmpMarkerPath)) fs.unlinkSync(tmpMarkerPath);
  }

  console.log("✓ Task 2 Passed: Seen-Set & computeMarkerEarnings");
}

// Task 3: import syncEarnings
import { syncEarnings } from "../scripts/earnings_sync.mjs";
import { readAll, latestBalances, appendSnapshot } from "../scripts/earnings_ledger.mjs";

console.log("\n=== Task 3 Tests: syncEarnings Engine & Idempotency ===");

{
  const testInbox = path.join(ROOT, "reports", "inbox");
  const testProcessed = path.join(ROOT, "reports", "processed");
  const testSeenFile = path.join(ROOT, "reports", ".test_sync_seen.json");
  const testMarkerName = "9999_target_reached_20260904_111111.json";
  const testMarkerPath = path.join(testInbox, testMarkerName);

  try {
    if (fs.existsSync(testSeenFile)) fs.unlinkSync(testSeenFile);

    // Write synthetic marker with explicit test account
    fs.writeFileSync(
      testMarkerPath,
      JSON.stringify({
        port: 9999,
        ts: "2026-09-04T15:00:00Z",
        type: "target_reached",
        total_usd: 2.50,
        total_raw: null,
        account: "_test:sync_test@example.com",
        platform: "_test",
      }),
      "utf-8"
    );

    const initialEntries = readAll();

    // First sync run: should process the marker and append 1 snapshot
    const res1 = syncEarnings({
      inboxDir: testInbox,
      processedDir: testProcessed,
      seenFilePath: testSeenFile,
      silent: true,
    });

    assert.equal(res1.markersProcessed, 1, "Must process 1 marker");
    assert.equal(res1.snapshotsAppended.length, 1, "Must append 1 snapshot");
    assert.equal(res1.snapshotsAppended[0].account, "_test:sync_test@example.com");
    assert.equal(res1.snapshotsAppended[0].balance_usd, 2.50);

    const entriesAfter1 = readAll();
    assert.equal(entriesAfter1.length, initialEntries.length + 1, "Ledger must grow by exactly 1 line");

    // Second sync run with same marker in inbox: must be idempotent (0 markers processed, 0 snapshots)
    const res2 = syncEarnings({
      inboxDir: testInbox,
      processedDir: testProcessed,
      seenFilePath: testSeenFile,
      silent: true,
    });

    assert.equal(res2.markersProcessed, 0, "Idempotency: must process 0 markers on second run");
    assert.equal(res2.snapshotsAppended.length, 0, "Idempotency: must append 0 snapshots on second run");

    const entriesAfter2 = readAll();
    assert.equal(entriesAfter2.length, entriesAfter1.length, "Ledger count must remain identical");

    // Move marker to processed directory: must STILL be idempotent
    const processedMarkerPath = path.join(testProcessed, testMarkerName);
    fs.renameSync(testMarkerPath, processedMarkerPath);

    const res3 = syncEarnings({
      inboxDir: testInbox,
      processedDir: testProcessed,
      seenFilePath: testSeenFile,
      silent: true,
    });

    assert.equal(res3.markersProcessed, 0, "Moving to processed must not re-trigger sync");
    assert.equal(res3.snapshotsAppended.length, 0);

    // Clean up processed marker
    if (fs.existsSync(processedMarkerPath)) fs.unlinkSync(processedMarkerPath);

  } finally {
    if (fs.existsSync(testMarkerPath)) fs.unlinkSync(testMarkerPath);
    if (fs.existsSync(testSeenFile)) fs.unlinkSync(testSeenFile);

    // Clean up test entries from earnings_ledger.jsonl
    const ledgerPath = path.join(ROOT, "reports", "earnings_ledger.jsonl");
    if (fs.existsSync(ledgerPath)) {
      const allLines = fs.readFileSync(ledgerPath, "utf-8").trim().split("\n");
      const cleaned = allLines.filter((line) => {
        try {
          return !JSON.parse(line).account.startsWith("_test:");
        } catch {
          return true;
        }
      });
      fs.writeFileSync(ledgerPath, cleaned.join("\n") + "\n", "utf-8");
    }
  }

  // Test 3.2: Shared account rule (Swagbucks on 3014 and 3017)
  {
    const sb14Marker = {
      port: 3014,
      ts: "2026-09-04T16:00:00Z",
      type: "target_reached",
      total_raw: 500, // 500 SB = $5.00
      total_usd: 5.0,
    };
    const sb17Marker = {
      port: 3017,
      ts: "2026-09-04T16:10:00Z",
      type: "target_reached",
      total_raw: 500, // 500 SB = $5.00
      total_usd: 5.0,
    };
    const rates = loadEarningsRates();
    const res14 = computeMarkerEarnings(sb14Marker, rates);
    const res17 = computeMarkerEarnings(sb17Marker, rates);
    assert.equal(res14.account, "swagbucks:erichong0410@gmail.com");
    assert.equal(res17.account, "swagbucks:erichong0410@gmail.com");
    assert.equal(res14.usd_earned, 5.0);
    assert.equal(res17.usd_earned, 5.0);
  }

  // Test 3.3: Daily Heartbeat test
  {
    const testSeenFile = path.join(ROOT, "reports", ".test_heartbeat_seen.json");
    try {
      if (fs.existsSync(testSeenFile)) fs.unlinkSync(testSeenFile);

      const beforeBalances = latestBalances();
      let beforeTotal = 0;
      for (const [acct, entry] of beforeBalances) {
        if (!acct.startsWith("_test:")) beforeTotal += entry.balance_usd;
      }
      beforeTotal = Math.round(beforeTotal * 100) / 100;

      // Run daily heartbeat with empty inbox
      const hbRes = syncEarnings({
        inboxDir: path.join(ROOT, "reports", "nonexistent_inbox"),
        processedDir: path.join(ROOT, "reports", "nonexistent_processed"),
        seenFilePath: testSeenFile,
        dailyHeartbeat: true,
        forceGraph: false,
        silent: true,
      });

      assert.equal(hbRes.markersProcessed, 0);
      assert.equal(hbRes.heartbeatsAppended.length, 4, "Must append heartbeat for 4 active accounts");
      for (const hb of hbRes.heartbeatsAppended) {
        const prevBal = beforeBalances.get(hb.account)?.balance_usd ?? 0;
        assert.equal(hb.balance_usd, prevBal, `Heartbeat balance for ${hb.account} must match previous balance`);
      }

      const afterBalances = latestBalances();
      let afterTotal = 0;
      for (const [acct, entry] of afterBalances) {
        if (!acct.startsWith("_test:")) afterTotal += entry.balance_usd;
      }
      afterTotal = Math.round(afterTotal * 100) / 100;

      assert.equal(afterTotal, beforeTotal, "Daily heartbeat must not alter total earnings");

      // Verify that running heartbeat again with dailyHeartbeat:false does NOT add heartbeats
      const noHbRes = syncEarnings({
        inboxDir: path.join(ROOT, "reports", "nonexistent_inbox"),
        processedDir: path.join(ROOT, "reports", "nonexistent_processed"),
        seenFilePath: testSeenFile,
        dailyHeartbeat: false,
        silent: true,
      });
      assert.equal(noHbRes.heartbeatsAppended.length, 0);

    } finally {
      if (fs.existsSync(testSeenFile)) fs.unlinkSync(testSeenFile);
      // Clean up heartbeat entries so ledger remains at baseline
      const ledgerPath = path.join(ROOT, "reports", "earnings_ledger.jsonl");
      if (fs.existsSync(ledgerPath)) {
        const allLines = fs.readFileSync(ledgerPath, "utf-8").trim().split("\n");
        const cleaned = allLines.filter((line) => {
          try {
            const parsed = JSON.parse(line);
            return parsed.note !== "daily_sync" && !parsed.account.startsWith("_test:");
          } catch {
            return true;
          }
        });
        fs.writeFileSync(ledgerPath, cleaned.join("\n") + "\n", "utf-8");
      }
    }
  }

  // Test 3.4: Prevent balance double-counting on cumulative markers
  {
    const testInbox = path.join(ROOT, "reports", "inbox");
    const testProcessed = path.join(ROOT, "reports", "processed");
    const testSeenFile = path.join(ROOT, "reports", ".test_double_count_seen.json");
    const marker1 = path.join(testInbox, "9998_target_reached_20260904_111111.json");
    const marker2 = path.join(testInbox, "9998_target_reached_20260904_222222.json");

    try {
      if (fs.existsSync(testSeenFile)) fs.unlinkSync(testSeenFile);
      fs.writeFileSync(marker1, JSON.stringify({
        port: 9998,
        ts: "2026-09-04T16:00:00Z",
        type: "target_reached",
        total_usd: 5.00,
        account: "_test:double_count@example.com",
        platform: "_test",
      }));

      syncEarnings({ inboxDir: testInbox, processedDir: testProcessed, seenFilePath: testSeenFile, silent: true });

      fs.writeFileSync(marker2, JSON.stringify({
        port: 9998,
        ts: "2026-09-04T17:00:00Z",
        type: "target_reached",
        total_usd: 5.50,
        account: "_test:double_count@example.com",
        platform: "_test",
      }));

      syncEarnings({ inboxDir: testInbox, processedDir: testProcessed, seenFilePath: testSeenFile, silent: true });

      const balances = latestBalances();
      const entry = balances.get("_test:double_count@example.com");
      assert.equal(entry.balance_usd, 5.50, "Second marker of $5.50 cumulative should set balance to $5.50, NOT 5.00 + 5.50 = 10.50");
    } finally {
      if (fs.existsSync(marker1)) fs.unlinkSync(marker1);
      if (fs.existsSync(marker2)) fs.unlinkSync(marker2);
      if (fs.existsSync(testSeenFile)) fs.unlinkSync(testSeenFile);
      const ledgerPath = path.join(ROOT, "reports", "earnings_ledger.jsonl");
      if (fs.existsSync(ledgerPath)) {
        const allLines = fs.readFileSync(ledgerPath, "utf-8").trim().split("\n");
        const cleaned = allLines.filter((line) => {
          try {
            return !JSON.parse(line).account.startsWith("_test:");
          } catch {
            return true;
          }
        });
        fs.writeFileSync(ledgerPath, cleaned.join("\n") + "\n", "utf-8");
      }
    }
  }

  console.log("✓ Task 3 Passed: syncEarnings Engine & Idempotency");
}

console.log("\n=== Task 4 Tests: Supervisor Integration ===");

{
  // Verify scripts/fleet_supervisor.mjs exists and imports syncEarnings
  const supPath = path.join(ROOT, "scripts", "fleet_supervisor.mjs");
  assert.ok(fs.existsSync(supPath), "fleet_supervisor.mjs must exist");
  const supCode = fs.readFileSync(supPath, "utf-8");
  assert.ok(
    supCode.includes("syncEarnings"),
    "fleet_supervisor.mjs must reference syncEarnings"
  );
  assert.ok(
    supCode.includes("daily_sync"),
    "fleet_supervisor.mjs must log daily_sync action"
  );

  console.log("✓ Task 4 Passed: Supervisor Integration");
}




