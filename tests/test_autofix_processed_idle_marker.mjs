import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAutoFixer } from "../scripts/auto_fixer.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "autofix-idle-marker-test-"));
const inboxDir = path.join(root, "reports", "inbox");
const processedDir = path.join(root, "reports", "processed", "2026-09-25_1120");
fs.mkdirSync(inboxDir, { recursive: true });
fs.mkdirSync(processedDir, { recursive: true });
fs.mkdirSync(path.join(root, "logs"), { recursive: true });

try {
  // The inbox watcher archives reports into timestamped processed subdirectories.
  fs.writeFileSync(
    path.join(processedDir, "3014_idle_today_20260925.json"),
    JSON.stringify({ port: 3014, type: "idle_today" }),
  );

  let deployCalls = 0;
  const fixer = createAutoFixer({
    fleet: [{ port: 3014, container: "mock-container-3014" }],
    root,
    inboxDir,
    logFile: path.join(root, "logs", "autofix.log"),
    probes: {
      isContainerRunning: async () => true,
      checkCdp: async () => ({ ok: true }),
      relaunchChromium: async () => ({ ok: true }),
      deployAgent: async () => {
        deployCalls++;
        return { ok: true };
      },
      isPortAlive: () => false,
    },
    sleep: async () => {},
  });

  const result = await fixer.tick([]);

  assert.equal(
    deployCalls,
    0,
    "auto-fixer must not redeploy a port whose idle-today marker is archived under processed/",
  );
  assert.deepEqual(result.healthy, [3014]);
  assert.deepEqual(result.repaired, []);
  console.log("PASS test_autofix_processed_idle_marker");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
