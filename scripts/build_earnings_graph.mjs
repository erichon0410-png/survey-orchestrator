#!/usr/bin/env node
// scripts/build_earnings_graph.mjs — generate the earnings artifacts from the append-only ledger.
// Reads reports/earnings_ledger.jsonl (via earnings_ledger.readAll) and writes, under reports/:
//   earnings_daily.csv    daily gross-earnings CSV (columns: day, amount_earned)
//   spend_ledger.jsonl    auto-categorized redemption (withdraw) tracker
//   earnings_graph.png    cumulative gross-earnings line vs a $20/mo cost line (break-even marked)
//   earnings_graph.html   self-contained per-account balance chart + $20/mo cost line + break-even
// Node >= 18, stdlib only. No I/O at import time; the CLI block runs on `node build_earnings_graph.mjs`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readAll } from "./earnings_ledger.mjs";
import { deriveEvents, dailyEarnings, cumulativeSeries } from "./earnings_derive.mjs";
import { renderEarningsChart, findBreakEven } from "./chart_png.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const REPORTS_DIR = path.join(ROOT, "reports");
const LEDGER_PATH = path.join(REPORTS_DIR, "earnings_ledger.jsonl");
const CSV_PATH = path.join(REPORTS_DIR, "earnings_daily.csv");
const SPEND_LEDGER_PATH = path.join(REPORTS_DIR, "spend_ledger.jsonl");
const PNG_PATH = path.join(REPORTS_DIR, "earnings_graph.png");
const OUTPUT_PATH = path.join(REPORTS_DIR, "earnings_graph.html");

// $20/month subscription cost (ChatGPT Plus), amortized per day.
const COST_PER_DAY_USD = 20 / 30;

// --- per-account cumulative-balance series for the HTML chart ---------------
function buildSeries(entries) {
  const byAccount = new Map();
  for (const e of entries) {
    if (!byAccount.has(e.account)) byAccount.set(e.account, []);
    byAccount.get(e.account).push({ ts: e.ts, balance_usd: e.balance_usd });
  }

  const allTimestamps = [...new Set(entries.map((e) => e.ts))].sort();
  const accounts = [...byAccount.keys()].sort();
  const series = {};
  for (const acct of accounts) {
    const dataPoints = byAccount.get(acct);
    const tsMap = new Map(dataPoints.map((d) => [d.ts, d.balance_usd]));
    let lastVal = 0;
    series[acct] = allTimestamps.map((ts) => {
      if (tsMap.has(ts)) lastVal = tsMap.get(ts);
      return { ts, balance_usd: lastVal };
    });
  }

  series["TOTAL"] = allTimestamps.map((ts, i) => {
    let sum = 0;
    for (const acct of accounts) {
      sum += series[acct][i].balance_usd;
    }
    return { ts, balance_usd: Math.round(sum * 100) / 100 };
  });

  return { series, accounts, allTimestamps };
}

// --- new artifact builders (pure) ------------------------------------------

// dailyRows: [{date:"YYYY-MM-DD", amount_earned_usd:<n>}] (from earnings_derive.dailyEarnings).
export function buildCsv(dailyRows) {
  const rows = Array.isArray(dailyRows) ? dailyRows : [];
  let out = "day,amount_earned\n";
  for (const r of rows) {
    const amt = Number(r && r.amount_earned_usd);
    out += `${r.date},${(Number.isFinite(amt) ? amt : 0).toFixed(2)}\n`;
  }
  return out;
}

// events: deriveEvents() output. Only withdraw (redemption) events are tracked, each with its
// auto-assigned category ("subscription" for the $20-$25 band, else "leisure").
export function buildSpendLedger(events) {
  const rows = (Array.isArray(events) ? events : []).filter((e) => e && e.kind === "withdraw");
  if (rows.length === 0) return "";
  return rows.map((e) => JSON.stringify({ ts: e.ts, account: e.account, kind: e.kind, usd: e.usd, category: e.category })).join("\n") + "\n";
}

// Earliest ledger date across all accounts = the fresh-start cutover baseline (both lines start ~$0 here).
function earliestActiveDate(entries) {
  let m = null;
  for (const e of entries) {
    if (e && e.ts && (m === null || String(e.ts) < m)) m = String(e.ts);
  }
  if (!m) return null;
  const d = new Date(m);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Build every earnings artifact from raw ledger entries. Pure (PNG encoding is deterministic).
 * @param {Array<{ts:string, account:string, balance_usd:number}>} entries  readAll() rows
 * @param {{costPerDayUsd?:number, t0Date?:string}} [opts]
 * @returns {{csv:string, spendLedger:string, pngBuffer:Buffer, html:string,
 *            series:Array, events:Array, dailyRows:Array, t0Date:string, breakEven:(object|null)}}
 */
export function computeArtifacts(entries, { costPerDayUsd = COST_PER_DAY_USD, t0Date = null } = {}) {
  const all = Array.isArray(entries) ? entries : [];
  const events = deriveEvents(all);
  const dailyRows = dailyEarnings(events);
  const series = cumulativeSeries(dailyRows);
  const t0 = t0Date || earliestActiveDate(all) || new Date().toISOString().slice(0, 10);
  const breakEven = findBreakEven(series, costPerDayUsd, t0);
  const csv = buildCsv(dailyRows);
  const spendLedger = buildSpendLedger(events);
  const pngBuffer = renderEarningsChart({ series, costPerDayUsd, t0Date: t0 });
  const html = generateHTML(all, buildSeries(all), { costPerDayUsd, t0Date: t0, breakEven });
  return { csv, spendLedger, pngBuffer, html, series, events, dailyRows, t0Date: t0, breakEven };
}

// --- generate HTML (per-account balance chart + $20/mo cost line + break-even) ---
function generateHTML(entries, seriesData, chart = {}) {
  const { series, accounts } = seriesData;
  const now = new Date().toISOString();
  const t0Date = chart.t0Date || null;
  const costPerDayUsd = chart.costPerDayUsd != null ? chart.costPerDayUsd : COST_PER_DAY_USD;
  const breakEven = chart.breakEven || null;

  // Latest balances (for the summary panel).
  const latest = {};
  let grandTotal = 0;
  for (const acct of accounts) {
    const acctSeries = series[acct];
    const lastBal = acctSeries[acctSeries.length - 1].balance_usd;
    latest[acct] = lastBal;
    grandTotal += lastBal;
  }
  grandTotal = Math.round(grandTotal * 100) / 100;

  const displayName = (acct) => acct.split(":")[0];

  const COLORS = {
    "opinionoutpost:user01@example.com": "#4CAF50",
    "swagbucks:user02@example.com": "#2196F3",
    "surveyjunkie:user04@example.com": "#FF9800",
    "primeopinion:user03@example.com": "#9C27B0",
    "TOTAL": "#F44336",
  };

  const chartData = JSON.stringify({ series, accounts, allTimestamps: seriesData.allTimestamps, latest, grandTotal, t0Date, costPerDayUsd, breakEven: breakEven ? { date: breakEven.date, cumulative_usd: breakEven.cumulative_usd } : null });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Survey Fleet Cumulative Earnings</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace; background: #1a1a2e; color: #e0e0e0; padding: 24px; }
  h1 { text-align: center; margin-bottom: 8px; font-size: 1.5em; color: #fff; }
  .subtitle { text-align: center; color: #888; font-size: 0.85em; margin-bottom: 20px; }
  .chart-container { background: #16213e; border-radius: 8px; padding: 20px; margin-bottom: 20px; }
  canvas { width: 100%; height: 400px; display: block; }
  .summary { background: #16213e; border-radius: 8px; padding: 16px; }
  .summary h2 { font-size: 1.1em; margin-bottom: 12px; color: #fff; }
  .summary-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #1a1a2e; font-size: 0.95em; }
  .summary-row:last-child { border-bottom: none; }
  .legend { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 12px; font-size: 0.85em; }
  .legend-item { display: flex; align-items: center; gap: 6px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
</style>
</head>
<body>
<h1>Survey Fleet Cumulative Earnings</h1>
<p class="subtitle">Generated ${now} &middot; per-account balance vs $20/mo cost line</p>

<div class="chart-container">
  <canvas id="chart"></canvas>
  <div id="legend" class="legend"></div>
</div>

<div class="summary">
  <h2>Current Balances</h2>
${accounts.map((acct) => `    <div class="summary-row"><span>${displayName(acct)}</span><span>$${latest[acct].toFixed(2)}</span></div>`).join("\n")}
    <div class="summary-row" style="font-weight:bold;"><span>TOTAL</span><span>$${grandTotal.toFixed(2)}</span></div>
    <div class="summary-row"><span>Break-even ($20/mo)</span><span>${breakEven ? breakEven.date : "not yet"}</span></div>
</div>

<script>
const DATA = ${chartData};
const COLORS = ${JSON.stringify(COLORS)};
function displayName(acct) { return acct.split(":")[0]; }

function drawChart() {
  const canvas = document.getElementById("chart");
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const W = rect.width;
  const H = rect.height;

  const pad = { top: 20, right: 20, bottom: 50, left: 60 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  // Find Y range (balances + $20/mo cost line over the visible span)
  let yMax = 0;
  const allKeys = [...DATA.accounts, "TOTAL"];
  for (const key of allKeys) {
    for (const pt of DATA.series[key]) {
      if (pt.balance_usd > yMax) yMax = pt.balance_usd;
    }
  }

  // X range (timestamps)
  const timestamps = DATA.allTimestamps;
  const tMin = new Date(timestamps[0]).getTime();
  const tMax = timestamps.length > 1 ? new Date(timestamps[timestamps.length - 1]).getTime() : tMin + 86400000;
  const tRange = tMax - tMin || 1;

  // $20/mo cost line is linear in time from t0.
  const t0Time = DATA.t0Date ? new Date(DATA.t0Date + "T00:00:00Z").getTime() : tMin;
  function costAt(ts) {
    const days = (new Date(ts).getTime() - t0Time) / 86400000;
    return Math.max(0, DATA.costPerDayUsd * days);
  }
  const firstTs = timestamps[0];
  const lastTs = timestamps[timestamps.length - 1];

  // Fold the cost line into Y range so it is always visible.
  if (costAt(lastTs) > yMax) yMax = costAt(lastTs);
  yMax = Math.ceil(yMax / 5) * 5;
  if (yMax === 0) yMax = 5;

  function xPos(ts) { return pad.left + ((new Date(ts).getTime() - tMin) / tRange) * plotW; }
  function yPos(val) { return pad.top + plotH - (val / yMax) * plotH; }

  // Background
  ctx.fillStyle = "#16213e";
  ctx.fillRect(0, 0, W, H);

  // Grid lines
  ctx.strokeStyle = "#2a2a4a";
  ctx.lineWidth = 1;
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const val = (yMax / yTicks) * i;
    const y = yPos(val);
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
    ctx.fillStyle = "#888";
    ctx.font = "12px monospace";
    ctx.textAlign = "right";
    ctx.fillText("$" + val.toFixed(0), pad.left - 8, y + 4);
  }

  // X axis labels
  ctx.fillStyle = "#888";
  ctx.font = "11px monospace";
  ctx.textAlign = "center";
  const xLabelCount = Math.min(timestamps.length, 8);
  for (let i = 0; i < xLabelCount; i++) {
    const idx = Math.floor((i / (xLabelCount - 1 || 1)) * (timestamps.length - 1));
    const ts = timestamps[idx];
    const d = new Date(ts);
    const label = (d.getMonth()+1) + "/" + d.getDate() + " " + d.getHours() + ":" + String(d.getMinutes()).padStart(2,"0");
    ctx.fillText(label, xPos(ts), H - pad.bottom + 20);
  }

  // Axis labels
  ctx.fillStyle = "#aaa";
  ctx.font = "13px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("Date / Time", pad.left + plotW / 2, H - 5);
  ctx.save();
  ctx.translate(14, pad.top + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText("Cumulative USD ($)", 0, 0);
  ctx.restore();

  // Draw lines — accounts first, then TOTAL on top
  const drawOrder = [...DATA.accounts, "TOTAL"];
  for (const key of drawOrder) {
    const pts = DATA.series[key];
    const color = COLORS[key] || "#888";
    const isTotal = key === "TOTAL";
    ctx.strokeStyle = color;
    ctx.lineWidth = isTotal ? 3 : 1.5;
    ctx.setLineDash([]);
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const x = xPos(pts[i].ts);
      const y = yPos(pts[i].balance_usd);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.fillStyle = color;
    for (const pt of pts) {
      const x = xPos(pt.ts);
      const y = yPos(pt.balance_usd);
      ctx.beginPath(); ctx.arc(x, y, isTotal ? 4 : 3, 0, Math.PI * 2); ctx.fill();
    }
  }

  // $20/mo cost line (straight, linear in time from t0) — red dashed.
  ctx.strokeStyle = "#D64543";
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(xPos(firstTs), yPos(costAt(firstTs)));
  ctx.lineTo(xPos(lastTs), yPos(costAt(lastTs)));
  ctx.stroke();
  ctx.setLineDash([]);

  // Break-even marker (where cumulative earnings first cover the $20/mo cost).
  if (DATA.breakEven) {
    const beTs = DATA.breakEven.date + "T00:00:00Z";
    const bx = xPos(beTs);
    const by = yPos(costAt(beTs));
    ctx.fillStyle = "#F6C453";
    ctx.beginPath(); ctx.arc(bx, by, 7, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#1a1a2e";
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("BREAK-EVEN", bx, by - 12);
  }

  // Legend
  const legendEl = document.getElementById("legend");
  legendEl.innerHTML = "";
  for (const key of drawOrder) {
    const color = COLORS[key] || "#888";
    const name = key === "TOTAL" ? "TOTAL" : displayName(key);
    const item = document.createElement("span");
    item.className = "legend-item";
    item.innerHTML = '<span class="dot" style="background:' + color + '"></span>' + name;
    legendEl.appendChild(item);
  }
}

window.addEventListener("load", drawChart);
window.addEventListener("resize", drawChart);
</script>
</body>
</html>`;
}

// --- CLI main -------------------------------------------------------------
const isCLI = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isCLI) {
  let entries;
  if (!fs.existsSync(LEDGER_PATH)) {
    console.error(`ERROR: Ledger not found at ${LEDGER_PATH}`);
    process.exit(1);
  }
  entries = readAll();

  const art = computeArtifacts(entries);

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.writeFileSync(CSV_PATH, art.csv, "utf-8");
  fs.writeFileSync(SPEND_LEDGER_PATH, art.spendLedger, "utf-8");
  fs.writeFileSync(PNG_PATH, art.pngBuffer);
  fs.writeFileSync(OUTPUT_PATH, art.html, "utf-8");

  console.log("Earnings artifacts written:");
  console.log(`  ${CSV_PATH} (${fs.statSync(CSV_PATH).size} bytes)`);
  console.log(`  ${SPEND_LEDGER_PATH} (${fs.statSync(SPEND_LEDGER_PATH).size} bytes, ${art.spendLedger ? art.spendLedger.trim().split("\n").length : 0} redemptions)`);
  console.log(`  ${PNG_PATH} (${fs.statSync(PNG_PATH).size} bytes)`);
  console.log(`  ${OUTPUT_PATH} (${fs.statSync(OUTPUT_PATH).size} bytes)`);
  console.log(`  t0Date (fresh-start baseline): ${art.t0Date}`);
  console.log(`  break-even: ${art.breakEven ? art.breakEven.date : "not yet"}`);

  // Current balances (unchanged operator-facing summary).
  const seriesData = buildSeries(entries);
  let grandTotal = 0;
  for (const acct of seriesData.accounts) {
    const last = seriesData.series[acct][seriesData.series[acct].length - 1];
    console.log(`  ${acct}: $${last.balance_usd.toFixed(2)}`);
    grandTotal += last.balance_usd;
  }
  console.log(`  TOTAL: $${(Math.round(grandTotal * 100) / 100).toFixed(2)}`);
}
