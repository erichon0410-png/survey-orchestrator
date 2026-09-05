#!/usr/bin/env node
// scripts/build_earnings_graph.mjs — generate cumulative earnings graph HTML.
// Reads reports/earnings_ledger.jsonl, writes reports/earnings_graph.html.
// Node >= 18, stdlib only.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const LEDGER_PATH = path.join(ROOT, "reports", "earnings_ledger.jsonl");
const OUTPUT_PATH = path.join(ROOT, "reports", "earnings_graph.html");

// --- read ledger ---
function readLedger() {
  if (!fs.existsSync(LEDGER_PATH)) {
    console.error(`ERROR: Ledger not found at ${LEDGER_PATH}`);
    process.exit(1);
  }
  const text = fs.readFileSync(LEDGER_PATH, "utf-8").trim();
  if (!text) {
    console.error("ERROR: Ledger is empty");
    process.exit(1);
  }
  return text.split("\n").map((line) => {
    try { return JSON.parse(line); }
    catch { return null; }
  }).filter(Boolean);
}

// --- build per-account series + total ---
function buildSeries(entries) {
  // Group by account
  const byAccount = new Map();
  for (const e of entries) {
    if (!byAccount.has(e.account)) byAccount.set(e.account, []);
    byAccount.get(e.account).push({ ts: e.ts, balance_usd: e.balance_usd });
  }

  // Collect all unique timestamps, sorted
  const allTimestamps = [...new Set(entries.map((e) => e.ts))].sort();

  // Build per-account cumulative series (carry forward last known balance)
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

  // Build TOTAL series
  series["TOTAL"] = allTimestamps.map((ts, i) => {
    let sum = 0;
    for (const acct of accounts) {
      sum += series[acct][i].balance_usd;
    }
    return { ts, balance_usd: Math.round(sum * 100) / 100 };
  });

  return { series, accounts, allTimestamps };
}

// --- generate HTML ---
function generateHTML(entries, seriesData) {
  const { series, accounts, allTimestamps } = seriesData;
  const now = new Date().toISOString();

  // Latest balances
  const latest = {};
  let grandTotal = 0;
  for (const acct of accounts) {
    const acctSeries = series[acct];
    const lastBal = acctSeries[acctSeries.length - 1].balance_usd;
    latest[acct] = lastBal;
    grandTotal += lastBal;
  }
  grandTotal = Math.round(grandTotal * 100) / 100;

  // Display name: just the platform part of "platform:email"
  const displayName = (acct) => acct.split(":")[0];

  const COLORS = {
    "opinionoutpost:nupkill64@gmail.com": "#4CAF50",
    "swagbucks:erichong0410@gmail.com": "#2196F3",
    "surveyjunkie:nupkill94@gmail.com": "#FF9800",
    "primeopinion:nupkill104@gmail.com": "#9C27B0",
    "TOTAL": "#F44336",
  };

  // Embed data for the chart
  const chartData = JSON.stringify({ series, accounts, allTimestamps, latest, grandTotal });

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
  .summary-row.total { font-weight: bold; font-size: 1.1em; color: #F44336; border-top: 2px solid #333; margin-top: 4px; padding-top: 10px; }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 8px; vertical-align: middle; }
  .legend { display: flex; flex-wrap: wrap; justify-content: center; gap: 16px; margin-top: 12px; font-size: 0.85em; }
  .legend-item { display: flex; align-items: center; }
</style>
</head>
<body>
<h1>Survey Fleet Cumulative Earnings</h1>
<p class="subtitle">Last updated: ${now}</p>

<div class="chart-container">
  <canvas id="chart" width="900" height="400"></canvas>
  <div class="legend" id="legend"></div>
</div>

<div class="summary">
  <h2>Current Balances</h2>
  ${accounts.map((acct) => `
  <div class="summary-row">
    <span><span class="dot" style="background:${COLORS[acct] || '#888'}"></span>${displayName(acct)}</span>
    <span>$${latest[acct].toFixed(2)}</span>
  </div>`).join("")}
  <div class="summary-row total">
    <span><span class="dot" style="background:${COLORS.TOTAL}"></span>TOTAL</span>
    <span>$${grandTotal.toFixed(2)}</span>
  </div>
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

  // Find Y range
  let yMax = 0;
  const allKeys = [...DATA.accounts, "TOTAL"];
  for (const key of allKeys) {
    for (const pt of DATA.series[key]) {
      if (pt.balance_usd > yMax) yMax = pt.balance_usd;
    }
  }
  yMax = Math.ceil(yMax / 5) * 5; // round up to nearest 5
  if (yMax === 0) yMax = 5;

  // X range (timestamps)
  const timestamps = DATA.allTimestamps;
  const tMin = new Date(timestamps[0]).getTime();
  const tMax = timestamps.length > 1 ? new Date(timestamps[timestamps.length - 1]).getTime() : tMin + 86400000;
  const tRange = tMax - tMin || 1;

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
    // Y label
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
    ctx.setLineDash(isTotal ? [] : []);
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const x = xPos(pts[i].ts);
      const y = yPos(pts[i].balance_usd);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Draw dots at data points
    ctx.fillStyle = color;
    for (const pt of pts) {
      const x = xPos(pt.ts);
      const y = yPos(pt.balance_usd);
      ctx.beginPath(); ctx.arc(x, y, isTotal ? 4 : 3, 0, Math.PI * 2); ctx.fill();
    }
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

// --- main ---
const entries = readLedger();
const seriesData = buildSeries(entries);
const html = generateHTML(entries, seriesData);

fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
fs.writeFileSync(OUTPUT_PATH, html, "utf-8");

const stat = fs.statSync(OUTPUT_PATH);
console.log(`✓ Generated ${OUTPUT_PATH}`);
console.log(`  Size: ${stat.size} bytes`);
console.log(`  Accounts: ${seriesData.accounts.join(", ")}`);
console.log(`  Total series: TOTAL`);
console.log(`  Data points: ${seriesData.allTimestamps.length} timestamps`);

// Print current balances
console.log("\nCurrent balances:");
let grandTotal = 0;
for (const acct of seriesData.accounts) {
  const last = seriesData.series[acct][seriesData.series[acct].length - 1];
  console.log(`  ${acct}: $${last.balance_usd.toFixed(2)}`);
  grandTotal += last.balance_usd;
}
console.log(`  TOTAL: $${(Math.round(grandTotal * 100) / 100).toFixed(2)}`);
