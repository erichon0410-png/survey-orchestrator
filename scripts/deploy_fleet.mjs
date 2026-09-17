#!/usr/bin/env node
// scripts/deploy_fleet.mjs — Deploy individual or all fleet survey agents.
//
// Usage:
//   node scripts/deploy_fleet.mjs                    # Deploy all 5 agents
//   node scripts/deploy_fleet.mjs 3013 3014          # Deploy ports 3013 & 3014 only
//   node scripts/deploy_fleet.mjs --provider llama-cpp --model Ornith-1.5-9B-Q4_K_M
//   node scripts/deploy_fleet.mjs --provider openrouter --model stealth/union-alpha

import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ORCH_PATH = process.env.DSH_ORCHESTRATOR || path.join(os.homedir(), ".dsh", "plugins", "dsh-survey-orchestrator", "lib", "orchestrator.js");
const { FLEET, deployAgent } = await import(ORCH_PATH);

const argv = process.argv.slice(2);
const targetPorts = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (!arg.startsWith("-") && Number.isFinite(Number(arg))) {
    targetPorts.push(Number(arg));
  }
}

const portsToDeploy = targetPorts.length > 0 ? targetPorts : FLEET.map(f => f.port);

console.log(`🚀 Deploying ${portsToDeploy.length} survey agent(s): [${portsToDeploy.join(", ")}]...`);

for (const port of portsToDeploy) {
  const item = FLEET.find(f => f.port === port);
  if (!item) {
    console.warn(`⚠️  Port ${port} not found in fleet configuration. Skipping.`);
    continue;
  }
  try {
    const res = await deployAgent(item, ROOT);
    if (res.ok) {
      console.log(`✅ [Port ${port}] Deployed ${item.platform} (${item.container}) -> Driver PID: ${res.pid}`);
    } else {
      console.error(`❌ [Port ${port}] Deployment failed:`, res.error);
    }
  } catch (e) {
    console.error(`❌ [Port ${port}] Deployment error:`, e.message);
  }
}

console.log("\nFleet deployment completed.");
