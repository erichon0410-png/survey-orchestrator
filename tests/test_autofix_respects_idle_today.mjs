#!/usr/bin/env node
// tests/test_autofix_respects_idle_today.mjs
// Verifies that the autofixer skips ports with idle-today markers.

import { execSync } from "node:child_process";
import fs from "fs";
import path from "path";
import os from "os";

const ROOT = process.env.SURVEY_ROOT || "/home/erich/workspace/survey-orchestrator";

async function main() {
  console.log("# Testing autofixer respects idle-today markers...");

  // Create temp inbox dir for test
  const tmpInbox = fs.mkdtempSync(path.join(os.tmpdir(), "autofix_test_inbox_"));
  try {
    // Write an idle-today marker for port 3013
    const markerPath = path.join(tmpInbox, "3013_idle_today_2026-09-11.json");
    fs.writeFileSync(markerPath, JSON.stringify({ reason: "no_surveys" }));

    // Import the autofixer module and check hasIdleTodayMarker function
    const { createAutoFixer } = await import(`${ROOT}/scripts/auto_fixer.mjs`);

    // Create a minimal autofixer instance with test fixtures
    let idleCheckCalled = false;
    let deployCalled = false;

    const fixer = createAutoFixer({
      fleet: [
        { port: 3013, container: "test-container", platform: "opinion_outpost" }
      ],
      root: ROOT,
      inboxDir: tmpInbox,
      logFile: path.join(os.tmpdir(), "autofix_test.log"),
      probes: {
        isContainerRunning: () => true,
        checkCdp: () => true,
        relaunchChromium: async () => {},
        deployAgent: async (item) => {
          deployCalled = true;
          return { ok: true };
        },
        isPortAlive: () => false
      }
    });

    // Run tick with empty ps lines (no drivers running)
    const result = await fixer.tick([]);

    console.log(`#   autofix result: ${JSON.stringify(result)}`);
    console.log(`#   deployCalled: ${deployCalled}`);

    if (deployCalled) {
      console.log("#   ✗ FAIL: autofixer deployed despite idle-today marker");
      process.exit(1);
    } else {
      console.log("#   ✓ PASS: autofixer skipped deployment due to idle-today marker");
    }

  } finally {
    // Cleanup temp dir
    fs.rmSync(tmpInbox, { recursive: true, force: true });
  }

  console.log("# All autofix idle-today tests passed!");
}

main();