#!/usr/bin/env node
// scripts/fleet_watch.mjs — real-time streaming terminal watcher for survey fleet.
// Node 18+ ESM, stdlib only (node:fs, node:net, node:path, node:readline).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEventSubscriber } from "./observability_hub.mjs";
import { formatTerminalLine } from "./fleet_events.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.SURVEY_ROOT || path.resolve(__dirname, "..");
const LOGS_DIR = path.join(ROOT, "logs");
const SOCK_PATH = process.env.FLEET_SOCK_PATH || path.join(LOGS_DIR, "fleet-observability.sock");
const JOURNAL_PATH = path.join(LOGS_DIR, "fleet_events.jsonl");

export function parseWatcherArgs(argv) {
  const opts = {
    port: null,
    errorsOnly: false,
    replay: 0,
    noColor: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port" && i + 1 < argv.length) {
      opts.port = parseInt(argv[++i], 10);
    } else if (a === "--errors-only") {
      opts.errorsOnly = true;
    } else if (a === "--replay") {
      const next = argv[i + 1];
      if (next && !next.startsWith("--") && /^\d+$/.test(next)) {
        opts.replay = parseInt(argv[++i], 10);
      } else {
        opts.replay = 20; // default 20 if --replay passed without count
      }
    } else if (a === "--no-color") {
      opts.noColor = true;
    } else if (a === "--help" || a === "-h") {
      opts.help = true;
    }
  }

  return opts;
}

export function formatWatcherLine(event, options = {}) {
  return formatTerminalLine(event, options);
}

function matchesFilter(event, options) {
  if (options.port && event.port !== options.port) return false;
  if (options.errorsOnly && event.event !== "error" && event.event !== "tech_issue") return false;
  return true;
}

export async function runWatcher(options = {}) {
  const { port = null, errorsOnly = false, replay = 0, noColor = false } = options;

  console.log("========================================================================");
  console.log("  SURVEY FLEET LIVE OBSERVABILITY MONITOR");
  console.log(`  Socket:  ${path.relative(ROOT, SOCK_PATH)}`);
  console.log(`  Filter:  ${port ? `port ${port}` : "all fleet ports"}${errorsOnly ? " (errors only)" : ""}`);
  console.log("  Status:  Connecting to live stream...");
  console.log("========================================================================");

  // 1. Replay past events from journal if requested
  const seenSeqs = new Set();
  if (replay > 0 && fs.existsSync(JOURNAL_PATH)) {
    try {
      const lines = fs.readFileSync(JOURNAL_PATH, "utf-8").trim().split("\n").filter(Boolean);
      const toShow = lines.slice(-replay);
      console.log(`--- Replaying last ${toShow.length} events from journal ---`);
      for (const line of toShow) {
        try {
          const ev = JSON.parse(line);
          const key = `${ev.ts}_${ev.source}_${ev.port}_${ev.event}`;
          seenSeqs.add(key);
          if (matchesFilter(ev, options)) {
            console.log(formatWatcherLine(ev, { noColor }));
          }
        } catch {}
      }
      console.log("--- Live stream active ---");
    } catch {}
  }

  let subscriber = null;
  let fallbackTimer = null;
  let lastJournalSize = fs.existsSync(JOURNAL_PATH) ? fs.statSync(JOURNAL_PATH).size : 0;

  function onEvent(ev) {
    const key = `${ev.ts}_${ev.source}_${ev.port}_${ev.event}`;
    if (seenSeqs.has(key)) return;
    seenSeqs.add(key);
    // Keep seen set bounded
    if (seenSeqs.size > 2000) {
      const iter = seenSeqs.values();
      for (let i = 0; i < 500; i++) seenSeqs.delete(iter.next().value);
    }

    if (matchesFilter(ev, options)) {
      console.log(formatWatcherLine(ev, { noColor }));
    }
  }

  async function tryConnectSocket() {
    try {
      if (fs.existsSync(SOCK_PATH)) {
        subscriber = await createEventSubscriber({
          sockPath: SOCK_PATH,
          onEvent,
          onError: () => {
            subscriber = null;
          },
        });
        if (fallbackTimer) {
          clearInterval(fallbackTimer);
          fallbackTimer = null;
        }
        return true;
      }
    } catch {
      subscriber = null;
    }
    return false;
  }

  // Fallback poller when socket is not active yet
  function startJournalFallback() {
    if (fallbackTimer) return;
    fallbackTimer = setInterval(() => {
      // Check if socket became available
      tryConnectSocket().then((connected) => {
        if (connected) return;
        // Tail journal file
        if (fs.existsSync(JOURNAL_PATH)) {
          try {
            const stat = fs.statSync(JOURNAL_PATH);
            if (stat.size > lastJournalSize) {
              const stream = fs.createReadStream(JOURNAL_PATH, {
                start: lastJournalSize,
                end: stat.size,
                encoding: "utf-8",
              });
              lastJournalSize = stat.size;
              let chunk = "";
              stream.on("data", (d) => (chunk += d));
              stream.on("end", () => {
                const lines = chunk.split("\n").filter(Boolean);
                for (const line of lines) {
                  try {
                    const ev = JSON.parse(line);
                    onEvent(ev);
                  } catch {}
                }
              });
            }
          } catch {}
        }
      });
    }, 1000);
  }

  const connected = await tryConnectSocket();
  if (!connected) {
    console.log("Note: Fleet supervisor socket not detected. Tailing journal log until supervisor starts...");
    startJournalFallback();
  }

  return {
    close() {
      if (subscriber) {
        subscriber.close();
        subscriber = null;
      }
      if (fallbackTimer) {
        clearInterval(fallbackTimer);
        fallbackTimer = null;
      }
    },
  };
}

const isCLI = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isCLI) {
  const opts = parseWatcherArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("Usage: node scripts/fleet_watch.mjs [options]");
    console.log("");
    console.log("Options:");
    console.log("  --port <N>       Filter events to a specific port (e.g. --port 3015)");
    console.log("  --errors-only    Show only errors and tech issues");
    console.log("  --replay [N]     Replay last N events from journal on start (default: 20)");
    console.log("  --no-color       Disable ANSI color codes");
    console.log("  --help, -h       Show this help message");
    process.exit(0);
  }

  let runningWatcher = null;
  runWatcher(opts).then((w) => {
    runningWatcher = w;
  });

  function cleanup() {
    console.log("\n[watcher] detached.");
    if (runningWatcher) runningWatcher.close();
    process.exit(0);
  }

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}
