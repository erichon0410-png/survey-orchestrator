#!/usr/bin/env node
// scripts/earnings_sync.mjs — wire fleet earnings into append-only ledger + daily graph refresh.
// Node >= 18, stdlib only.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

// Daily earnings tracking state
const DAILY_EARNINGS_STATE_PATH = path.join(ROOT, "reports", "processed", ".daily_earnings_state.json");
const DAILY_EARNINGS_LOG_PATH = path.join(ROOT, "reports", "daily_earnings.jsonl");

const RATES_CONFIG_PATH = path.join(ROOT, "config", "earnings_rates.yaml");

/**
 * Parse earnings_rates.yaml content using Node stdlib.
 * @param {string} yamlContent
 * @returns {{ accounts: Record<string, any>, portMap: Record<number, string> }}
 */
export function parseEarningsRates(yamlContent) {
  const accounts = {};
  const portMap = {};
  let currentSection = null;
  let currentAccount = null;

  const lines = yamlContent.split("\n");
  for (const rawLine of lines) {
    const lineWithoutComment = rawLine.split("#")[0].trimEnd();
    if (!lineWithoutComment.trim()) continue;

    const indent = lineWithoutComment.search(/\S/);
    const trimmed = lineWithoutComment.trim();

    if (indent === 0) {
      if (trimmed === "accounts:") {
        currentSection = "accounts";
        currentAccount = null;
      } else if (trimmed === "port_map:") {
        currentSection = "port_map";
        currentAccount = null;
      } else {
        currentSection = null;
      }
      continue;
    }

    if (currentSection === "port_map") {
      const match = trimmed.match(/^(\d+):\s*(.+)$/);
      if (match) {
        portMap[Number(match[1])] = match[2].trim();
      }
    } else if (currentSection === "accounts") {
      if (indent === 2 && trimmed.endsWith(":")) {
        currentAccount = trimmed.slice(0, -1).trim();
        accounts[currentAccount] = {};
      } else if (indent >= 4 && currentAccount) {
        const colonIdx = trimmed.indexOf(":");
        if (colonIdx !== -1) {
          const key = trimmed.slice(0, colonIdx).trim();
          let val = trimmed.slice(colonIdx + 1).trim();
          if (val.startsWith('"') && val.endsWith('"')) {
            val = val.slice(1, -1);
          } else if (val.startsWith("[") && val.endsWith("]")) {
            val = val
              .slice(1, -1)
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
              .map((s) => (isNaN(Number(s)) ? s : Number(s)));
          } else if (!isNaN(Number(val)) && val !== "") {
            val = Number(val);
          }
          accounts[currentAccount][key] = val;
        }
      }
    }
  }

  return { accounts, portMap };
}

/**
 * Load and parse earnings rates from a YAML file path.
 * @param {string} [yamlPath]
 * @returns {{ accounts: Record<string, any>, portMap: Record<number, string> }}
 */
export function loadEarningsRates(yamlPath = RATES_CONFIG_PATH) {
  if (!fs.existsSync(yamlPath)) {
    throw new Error(`Earnings rates file not found at: ${yamlPath}`);
  }
  const text = fs.readFileSync(yamlPath, "utf-8");
  return parseEarningsRates(text);
}

/**
 * Load the persistent seen-set JSON file.
 * @param {string} filePath
 * @returns {{ version: number, last_daily_sync_ts: number|null, seen: Record<string, any> }}
 */
export function loadSeenSet(filePath) {
  if (!fs.existsSync(filePath)) {
    return { version: 1, last_daily_sync_ts: null, seen: {} };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (raw && typeof raw === "object") {
      if (raw.seen && typeof raw.seen === "object" && !Array.isArray(raw.seen)) {
        return {
          version: raw.version || 1,
          last_daily_sync_ts: raw.last_daily_sync_ts ?? null,
          seen: raw.seen,
        };
      }
      // If legacy format where root is the seen map
      return { version: 1, last_daily_sync_ts: null, seen: raw };
    }
  } catch {
    // Corrupt file fallback
  }
  return { version: 1, last_daily_sync_ts: null, seen: {} };
}

/**
 * Save the persistent seen-set JSON file.
 * @param {string} filePath
 * @param {{ version?: number, last_daily_sync_ts?: number|null, seen: Record<string, any> }} seenData
 */
export function saveSeenSet(filePath, seenData) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const dataToSave = {
    version: seenData.version || 1,
    last_daily_sync_ts: seenData.last_daily_sync_ts ?? null,
    seen: seenData.seen || {},
  };
  fs.writeFileSync(filePath, JSON.stringify(dataToSave, null, 2) + "\n", "utf-8");
}

// --- Daily earnings state management ---

/**
 * Load the daily earnings state (previous day's totals per port).
 * @param {string} filePath
 * @returns {{ version: number, last_sync_date: string|null, previous_totals: Record<string, {total_usd: number, ts: string}> }}
 */
export function loadDailyEarningsState(filePath = DAILY_EARNINGS_STATE_PATH) {
  if (!fs.existsSync(filePath)) {
    return { version: 1, last_sync_date: null, previous_totals: {} };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (raw && typeof raw === "object") {
      return {
        version: raw.version || 1,
        last_sync_date: raw.last_sync_date || null,
        previous_totals: raw.previous_totals || {},
      };
    }
  } catch (e) {
    console.warn(`earnings_sync: failed to parse daily earnings state ${filePath}: ${e.message}`);
  }
  return { version: 1, last_sync_date: null, previous_totals: {} };
}

/**
 * Save the daily earnings state.
 * @param {string} filePath
 * @param {{ version: number, last_sync_date: string|null, previous_totals: Record<string, any> }} state
 */
export function saveDailyEarningsState(filePath = DAILY_EARNINGS_STATE_PATH, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const dataToSave = {
    version: state.version || 1,
    last_sync_date: state.last_sync_date ?? null,
    previous_totals: state.previous_totals || {},
  };
  fs.writeFileSync(filePath, JSON.stringify(dataToSave, null, 2) + "\n", "utf-8");
}

/**
 * Compute and record daily earnings for all active accounts.
 * Called during daily heartbeat sync to track day-over-day deltas.
 * @param {Object} options
 * @param {string} [options.stateFilePath]
 * @param {string} [options.logFilePath]
 * @returns {{ recordsWritten: number, dailyRecords: Array<Object> }}
 */
export function computeDailyEarnings({
  stateFilePath = DAILY_EARNINGS_STATE_PATH,
  logFilePath = DAILY_EARNINGS_LOG_PATH,
} = {}) {
  const state = loadDailyEarningsState(stateFilePath);
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  
  // Load current balances from the latest snapshots
  const currentBalances = latestPlatformBalances();
  
  const dailyRecords = [];
  
  for (const [platform, entry] of currentBalances) {
    if (String(platform).startsWith("_test")) continue;
    
    // Use platform name as key since multiple platforms can share a port
    const stateKey = `platform_${platform}`;
    const prevTotal = state.previous_totals[stateKey]?.total_usd ?? null;
    
    let dailyEarnings = null;
    if (prevTotal !== null) {
      dailyEarnings = Math.round((entry.balance_usd - prevTotal) * 100) / 100;
    }
    
    const record = {
      ts: new Date().toISOString(),
      date: today,
      port: entry.port,
      platform,
      current_total_usd: Math.round(entry.balance_usd * 100) / 100,
      previous_day_total_usd: prevTotal !== null ? Math.round(prevTotal * 100) / 100 : null,
      daily_earnings_usd: dailyEarnings,
      surveys_completed: null, // Not tracked per-day in current architecture
    };
    
    dailyRecords.push(record);
    
    // Update state with today's totals for tomorrow's comparison
    state.previous_totals[stateKey] = {
      total_usd: entry.balance_usd,
      ts: new Date().toISOString(),
    };
  }
  
  // Write records to append-only log
  if (dailyRecords.length > 0) {
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    const logLines = dailyRecords.map(r => JSON.stringify(r)).join("\n") + "\n";
    fs.appendFileSync(logFilePath, logLines, "utf-8");
  }
  
  // Save updated state
  state.last_sync_date = today;
  saveDailyEarningsState(stateFilePath, state);
  
  return { recordsWritten: dailyRecords.length, dailyRecords };
}

/**
 * Query daily earnings for a specific date range.
 * @param {Object} options
 * @param {string} [options.startDate] - YYYY-MM-DD
 * @param {string} [options.endDate] - YYYY-MM-DD
 * @param {number} [options.port] - Filter by port
 * @returns {Array<Object>}
 */
export function queryDailyEarnings({ startDate, endDate, port } = {}) {
  if (!fs.existsSync(DAILY_EARNINGS_LOG_PATH)) {
    return [];
  }
  
  const lines = fs.readFileSync(DAILY_EARNINGS_LOG_PATH, "utf-8").trim().split("\n");
  const results = [];
  
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      
      if (startDate && record.date < startDate) continue;
      if (endDate && record.date > endDate) continue;
      if (port !== undefined && record.port !== port) continue;
      
      results.push(record);
    } catch (e) {
      // Skip malformed lines
    }
  }
  
  return results;
}

/**
 * Recursively find files matching a regex pattern.
 * @param {string} dir
 * @param {RegExp} pattern
 * @returns {string[]}
 */
function findFilesRecursive(dir, pattern) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return results;
  }
  for (const name of entries) {
    const p = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      results.push(...findFilesRecursive(p, pattern));
    } else if (pattern.test(name)) {
      results.push(p);
    }
  }
  return results;
}

/**
 * Scan both inbox and processed directories for target_reached markers.
 * @param {string} inboxDir
 * @param {string} processedDir
 * @returns {string[]} absolute file paths
 */
export function scanMarkerFiles(inboxDir, processedDir) {
  const pattern = /_target_reached_.*\.json$/;
  const inboxFiles = findFilesRecursive(inboxDir, pattern);
  const processedFiles = findFilesRecursive(processedDir, pattern);
  return [...inboxFiles, ...processedFiles];
}

/**
 * Compute earnings in USD from a target_reached marker using rates configuration.
 * @param {Object} marker
 * @param {{ accounts: Record<string, any>, portMap: Record<number, string> }} ratesConfig
 * @returns {{ account: string, port: number, platform: string, usd_earned: number, points_raw: number|null }}
 */
export function computeMarkerEarnings(marker, ratesConfig) {
  const port = Number(marker.port);
  const account = ratesConfig.portMap[port] || marker.account;
  if (!account) {
    throw new Error(`Cannot resolve account for port ${marker.port} and no marker.account`);
  }

  const accountConfig = ratesConfig.accounts[account];
  const platform =
    accountConfig?.platform || marker.platform || account.split(":")[0];
  const conversion =
    accountConfig?.conversion || marker.conversion || "platform_displayed_usd";

  let usd_earned = 0;
  if (conversion === "points_to_usd") {
    const rate = accountConfig?.rate != null ? Number(accountConfig.rate) : 0.01;
    const total_raw = Number(marker.total_raw) || 0;
    usd_earned = total_raw * rate;
  } else {
    // platform_displayed_usd
    usd_earned = Number(marker.total_usd) || 0;
  }

  usd_earned = Math.round(usd_earned * 100) / 100;
  const points_raw = marker.total_raw != null ? Number(marker.total_raw) : null;

  return {
    account,
    port,
    platform,
    usd_earned,
    points_raw,
  };
}

import { execFileSync } from "node:child_process";
import { appendSnapshot, latestBalances, latestPlatformBalances } from "./earnings_ledger.mjs";

const DEFAULT_INBOX = path.join(ROOT, "reports", "inbox");
const DEFAULT_PROCESSED = path.join(ROOT, "reports", "processed");
const DEFAULT_SEEN_FILE = path.join(ROOT, "reports", ".earnings_sync_seen.json");
const DEFAULT_GRAPH_BUILDER = path.join(ROOT, "scripts", "build_earnings_graph.mjs");

/**
 * Extract chronological timestamp for sorting markers.
 * @param {Object} marker
 * @param {string} filePath
 * @returns {number}
 */
function getMarkerTimestamp(marker, filePath) {
  if (marker && marker.ts) {
    const t = new Date(marker.ts).getTime();
    if (!isNaN(t)) return t;
  }
  const base = path.basename(filePath);
  const match = base.match(/_(\d{8})_(\d{6})/);
  if (match) {
    const dStr = match[1];
    const tStr = match[2];
    const iso = `${dStr.slice(0, 4)}-${dStr.slice(4, 6)}-${dStr.slice(6, 8)}T${tStr.slice(0, 2)}:${tStr.slice(2, 4)}:${tStr.slice(4, 6)}Z`;
    const t = new Date(iso).getTime();
    if (!isNaN(t)) return t;
  }
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return Date.now();
  }
}

/**
 * Synchronize earnings markers into the ledger and update graph.
 * @param {Object} [options]
 * @param {string} [options.inboxDir]
 * @param {string} [options.processedDir]
 * @param {string} [options.ratesConfigPath]
 * @param {string} [options.seenFilePath]
 * @param {string} [options.graphBuilderPath]
 * @param {boolean} [options.dailyHeartbeat]
 * @param {boolean} [options.forceGraph]
 * @param {boolean} [options.silent]
 * @returns {{ markersProcessed: number, snapshotsAppended: Array<Object>, heartbeatsAppended: Array<Object>, graphRebuilt: boolean, latestBalances: Map<string, Object> }}
 */
export function syncEarnings({
  inboxDir = DEFAULT_INBOX,
  processedDir = DEFAULT_PROCESSED,
  ratesConfigPath = RATES_CONFIG_PATH,
  seenFilePath = DEFAULT_SEEN_FILE,
  graphBuilderPath = DEFAULT_GRAPH_BUILDER,
  dailyHeartbeat = false,
  forceGraph = false,
  silent = false,
} = {}) {
  const ratesConfig = loadEarningsRates(ratesConfigPath);
  const seenData = loadSeenSet(seenFilePath);
  const markerFiles = scanMarkerFiles(inboxDir, processedDir);

  // Filter for unseen markers
  const unseen = [];
  for (const filePath of markerFiles) {
    const filename = path.basename(filePath);
    if (seenData.seen && seenData.seen[filename]) {
      continue;
    }
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch (e) {
      if (!silent) console.warn(`earnings_sync: failed to parse ${filePath}: ${e.message}`);
      continue;
    }
    if (!data || data.type !== "target_reached") {
      continue;
    }
    unseen.push({ filePath, filename, data });
  }

  // Sort chronologically
  unseen.sort((a, b) => getMarkerTimestamp(a.data, a.filePath) - getMarkerTimestamp(b.data, b.filePath));

  const snapshotsAppended = [];
  let markersProcessed = 0;

  for (const item of unseen) {
    const { filename, data } = item;
    let earnedInfo;
    try {
      earnedInfo = computeMarkerEarnings(data, ratesConfig);
    } catch (e) {
      if (!silent) console.warn(`earnings_sync: skipping marker ${filename}: ${e.message}`);
      continue;
    }

    const { account, port, platform, usd_earned, points_raw } = earnedInfo;
    const currentBalances = latestBalances();
    const lastKnownEntry = currentBalances.get(account);
    const last_known_balance = lastKnownEntry?.balance_usd != null ? Number(lastKnownEntry.balance_usd) : 0;

    // Platform markers report the CURRENT cumulative balance. Record it verbatim
    // so a redemption (balance going DOWN) shows up as a negative delta in the
    // ledger — do NOT clamp back up to the previous high-water mark.
    const new_balance = Math.round(usd_earned * 100) / 100;

    if (new_balance !== last_known_balance) {
      appendSnapshot({
        account,
        port,
        platform,
        balance_usd: new_balance,
        points_raw: points_raw != null ? Number(points_raw) : null,
        note: `target_reached ${filename}`,
      });
      snapshotsAppended.push({
        account,
        port,
        platform,
        balance_usd: new_balance,
        points_raw,
        marker: filename,
      });
    }

    seenData.seen[filename] = {
      processed_at: new Date().toISOString(),
      account,
      port,
      usd_earned,
      balance_usd: new_balance,
    };
    markersProcessed++;
  }

  // Persist seen-set after processing markers
  if (markersProcessed > 0) {
    saveSeenSet(seenFilePath, seenData);
  }

  // Handle daily heartbeat if requested and no markers were processed
  const heartbeatsAppended = [];
  if (dailyHeartbeat && markersProcessed === 0) {
    const heartbeatTs = new Date().toISOString();
    const currentBalances = latestBalances();
    const activeAccounts = Object.keys(ratesConfig.accounts).filter(
      (acct) => !acct.startsWith("_test:")
    );

    for (const acct of activeAccounts) {
      const entry = currentBalances.get(acct);
      const last_known_balance = entry?.balance_usd != null ? Number(entry.balance_usd) : 0;
      const points_raw = entry?.points_raw != null ? Number(entry.points_raw) : null;
      const port = ratesConfig.accounts[acct]?.ports?.[0] ?? (entry?.port ?? 0);
      const platform = ratesConfig.accounts[acct]?.platform ?? entry?.platform ?? acct.split(":")[0];

      appendSnapshot({
        ts: heartbeatTs,
        account: acct,
        port,
        platform,
        balance_usd: last_known_balance,
        points_raw,
        note: "daily_sync",
      });

      heartbeatsAppended.push({
        ts: heartbeatTs,
        account: acct,
        port,
        platform,
        balance_usd: last_known_balance,
        points_raw,
      });
    }

    seenData.last_daily_sync_ts = Date.now();
    saveSeenSet(seenFilePath, seenData);
    
    // Compute and record daily earnings deltas
    const dailyResult = computeDailyEarnings();
    if (dailyResult.recordsWritten > 0 && !silent) {
      console.log(`Daily earnings recorded: ${dailyResult.recordsWritten} agents`);
      for (const rec of dailyResult.dailyRecords) {
        const dailyStr = rec.daily_earnings_usd !== null 
          ? `$${rec.daily_earnings_usd.toFixed(2)}` 
          : "first day";
        console.log(`  ${rec.platform} (port ${rec.port}): total=$${rec.current_total_usd.toFixed(2)}, today=${dailyStr}`);
      }
    }
  }

  // Rebuild graph if any snapshots or heartbeats were appended, or if forceGraph requested
  let graphRebuilt = false;
  if (snapshotsAppended.length > 0 || heartbeatsAppended.length > 0 || forceGraph) {
    if (fs.existsSync(graphBuilderPath)) {
      try {
        execFileSync(process.execPath, [graphBuilderPath], {
          stdio: silent ? "ignore" : "pipe",
          encoding: "utf-8",
        });
        graphRebuilt = true;
      } catch (e) {
        if (!silent) console.error(`earnings_sync: graph builder error: ${e.message}`);
      }
    }
  }

  return {
    markersProcessed,
    snapshotsAppended,
    heartbeatsAppended,
    graphRebuilt,
    latestBalances: latestBalances(),
  };
}

// --- CLI execution ---
const isCLI = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isCLI) {
  const isDaily = process.argv.includes("--daily");
  const isForce = process.argv.includes("--force-graph");
  const showDailyEarnings = process.argv.includes("--daily-earnings");
  
  // Handle --daily-earnings query mode
  if (showDailyEarnings) {
    const today = new Date().toISOString().slice(0, 10);
    console.log("=== Daily Earnings Report ===");
    
    // Show today's earnings
    let records = queryDailyEarnings({ startDate: today, endDate: today });
    if (records.length > 0) {
      console.log(`\nToday (${today}):`);
      let dayTotal = 0;
      for (const rec of records) {
        const dailyStr = rec.daily_earnings_usd !== null 
          ? `$${rec.daily_earnings_usd.toFixed(2)}` 
          : "first day";
        console.log(`  ${rec.platform} (port ${rec.port}): total=$${rec.current_total_usd.toFixed(2)}, today=${dailyStr}`);
        if (rec.daily_earnings_usd !== null) {
          dayTotal += rec.daily_earnings_usd;
        }
      }
      console.log(`  DAY TOTAL: $${dayTotal.toFixed(2)}`);
    } else {
      console.log("No daily earnings records for today yet.");
    }
    
    // Show last 7 days summary
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weekStart = weekAgo.toISOString().slice(0, 10);
    records = queryDailyEarnings({ startDate: weekStart, endDate: today });
    
    if (records.length > 0) {
      console.log("\nLast 7 days summary (by platform):");
      const byPlatform = {};
      for (const rec of records) {
        if (!byPlatform[rec.platform]) {
          byPlatform[rec.platform] = { port: rec.port, total: 0, count: 0 };
        }
        if (rec.daily_earnings_usd !== null) {
          byPlatform[rec.platform].total += rec.daily_earnings_usd;
          byPlatform[rec.platform].count++;
        }
      }
      for (const [platform, data] of Object.entries(byPlatform)) {
        console.log(`  ${platform} (port ${data.port}): $${data.total.toFixed(2)} over ${data.count} day(s)`);
      }
    }
    
    process.exit(0);
  }

  console.log("=== Survey Fleet Earnings Sync ===");
  const res = syncEarnings({
    dailyHeartbeat: isDaily,
    forceGraph: isForce,
    silent: false,
  });

  console.log(`Markers processed: ${res.markersProcessed}`);
  console.log(`Snapshots appended: ${res.snapshotsAppended.length}`);
  if (res.heartbeatsAppended.length > 0) {
    console.log(`Daily heartbeats appended: ${res.heartbeatsAppended.length}`);
  }
  if (res.graphRebuilt) {
    console.log("Earnings graph refreshed: reports/earnings_graph.html");
  }

  // Display by PLATFORM (deduped): the same platform can appear under two account
  // keys, so summing per-account latestBalances() would count it twice.
  console.log("\n--- Current Balances (by platform) ---");
  let grandTotal = 0;
  for (const [platform, entry] of latestPlatformBalances()) {
    if (String(platform).startsWith("_test")) continue;
    console.log(`  ${platform}: $${entry.balance_usd.toFixed(2)} (port ${entry.port}, ${entry.ts})`);
    grandTotal += entry.balance_usd;
  }
  grandTotal = Math.round(grandTotal * 100) / 100;
  console.log(`\n  TOTAL: $${grandTotal.toFixed(2)}`);
}


