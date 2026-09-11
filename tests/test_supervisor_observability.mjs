import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import {
  initEventHub,
  publishSupervisorEvent,
} from "../scripts/fleet_supervisor.mjs";
import { createEventSubscriber } from "../scripts/observability_hub.mjs";

console.log("Testing supervisor observability...");

const tmpDir = path.join(process.cwd(), "logs", "_test_sup_" + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const sockPath = path.join(tmpDir, "supervisor.sock");
const journalPath = path.join(tmpDir, "fleet_events.jsonl");

process.env.FLEET_SOCK_PATH = sockPath;

try {
  // 1. Initialize EventHub via supervisor helper
  const hub = await initEventHub({ sockPath, journalPath });
  assert.ok(hub, "Hub should be created");
  assert.ok(fs.existsSync(sockPath), "Socket file should exist");

  // 2. Connect subscriber
  const received = [];
  const sub = await createEventSubscriber({
    sockPath,
    onEvent: (ev) => received.push(ev),
  });

  await new Promise((r) => setTimeout(r, 100));

  // 3. Publish supervisor event
  publishSupervisorEvent("tick_started", "supervisor tick started; 5 ports checked");
  publishSupervisorEvent("agent_redeploy", "port 3015 redeploying (not_alive)");

  await new Promise((r) => setTimeout(r, 200));

  assert.strictEqual(received.length, 2, "Subscriber should receive both supervisor events");
  assert.strictEqual(received[0].source, "supervisor");
  assert.strictEqual(received[0].event, "tick_started");
  assert.strictEqual(received[1].event, "agent_redeploy");

  // 4. Cleanup
  sub.close();
  await hub.stop();
  assert.ok(!fs.existsSync(sockPath), "Socket should be cleaned up on stop");

  console.log("PASS test_supervisor_observability");
} finally {
  delete process.env.FLEET_SOCK_PATH;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}
