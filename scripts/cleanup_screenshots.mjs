#!/usr/bin/env node
// scripts/cleanup_screenshots.mjs — Purge temporary and end-of-day verification screenshots.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const LOGS_DIR = path.join(ROOT, "logs");
const TMP_DIR = os.tmpdir();

export function cleanupScreenshots({ olderThanMs = 0 } = {}) {
  const now = Date.now();
  let filesRemoved = 0;
  let bytesFreed = 0;

  function processDir(dir, pattern) {
    if (!fs.existsSync(dir)) return;
    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (!pattern.test(file)) continue;
        const fullPath = path.join(dir, file);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isFile() && (olderThanMs === 0 || now - stat.mtimeMs >= olderThanMs)) {
            bytesFreed += stat.size;
            fs.unlinkSync(fullPath);
            filesRemoved++;
          }
        } catch {}
      }
    } catch {}
  }

  // 1. Clean hermes_shot_* and shot_* in /tmp
  processDir(TMP_DIR, /^(hermes_shot_|shot_|test_shot_).*\.png$/);

  // 2. Clean *.png in logs directory
  processDir(LOGS_DIR, /.*\.png$/);

  // 3. Clean root test screenshot artifacts
  processDir(ROOT, /^(vision_test|screenshot_.*)\.png$/);

  return { filesRemoved, bytesFreed };
}

const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[\\/]/, ""));
if (isDirectRun || process.argv[1]?.includes("cleanup_screenshots.mjs")) {
  const { filesRemoved, bytesFreed } = cleanupScreenshots();
  const mb = (bytesFreed / (1024 * 1024)).toFixed(2);
  console.log(`🧹 Screenshot cleanup complete: removed ${filesRemoved} file(s), freed ${mb} MB.`);
  process.exit(0);
}
