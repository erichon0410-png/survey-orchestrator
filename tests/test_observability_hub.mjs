import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import {
  createEventHub,
  createEventPublisher,
  createEventSubscriber,
} from "../scripts/observability_hub.mjs";

console.log("Testing observability_hub...");

const tmpDir = path.join(process.cwd(), "logs", "_test_hub_" + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const sockPath = path.join(tmpDir, "test.sock");
const journalPath = path.join(tmpDir, "events.jsonl");

try {
  // 1. Publisher with no server running should NOT throw, and buffer events safely
  const offlinePub = createEventPublisher({ sockPath, port: 3013, maxBuffer: 5 });
  for (let i = 0; i < 10; i++) {
    offlinePub.publish({ source: "driver", port: 3013, event: "test", message: `offline ${i}` });
  }
  offlinePub.close();

  // 2. Start hub
  const hub = createEventHub({ sockPath, journalPath });
  await hub.start();
  assert.ok(fs.existsSync(sockPath), "Socket file should exist");

  // 3. Connect subscriber
  const received = [];
  const sub = await createEventSubscriber({
    sockPath,
    onEvent: (ev) => received.push(ev),
  });

  // Wait for socket subscriber to connect
  await new Promise((r) => setTimeout(r, 100));

  // 4. Connect publisher
  const pub = createEventPublisher({ sockPath, port: 3015 });
  await new Promise((r) => setTimeout(r, 100));

  // 5. Publish event from publisher
  pub.publish({ source: "driver", port: 3015, event: "turn_started", message: "turn 1 starting" });

  // 6. Publish event directly through hub (supervisor side)
  hub.publish({ source: "supervisor", port: null, event: "tick", message: "tick complete" });

  // Wait for delivery
  await new Promise((r) => setTimeout(r, 200));

  assert.strictEqual(received.length, 2, "Subscriber should receive both events");
  const driverEv = received.find((r) => r.source === "driver");
  const supEv = received.find((r) => r.source === "supervisor");
  assert.ok(driverEv, "Driver event should be received");
  assert.strictEqual(driverEv.port, 3015);
  assert.strictEqual(driverEv.event, "turn_started");
  assert.ok(supEv, "Supervisor event should be received");
  assert.strictEqual(supEv.event, "tick");

  // 7. Check journal file persistence
  assert.ok(fs.existsSync(journalPath), "Journal file should exist");
  const journalLines = fs.readFileSync(journalPath, "utf-8").trim().split("\n");
  assert.strictEqual(journalLines.length, 2);
  const journalObjs = journalLines.map((l) => JSON.parse(l));
  assert.ok(journalObjs.some((j) => j.port === 3015));
  assert.ok(journalObjs.some((j) => j.source === "supervisor"));

  // 8. Cleanup
  sub.close();
  pub.close();
  await hub.stop();
  assert.ok(!fs.existsSync(sockPath), "Socket file should be unlinked on stop");

  console.log("PASS test_observability_hub");
} finally {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}
