import { execSync } from "node:child_process";

const ports = [3013, 3014, 3015, 3016, 3017];

for (const port of ports) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/cdp/json`);
    const targets = await res.json();
    const pages = targets.filter((t) => t.type === "page");
    console.log(`Port ${port}: ${pages.length} page tabs open`);
    for (const p of pages.slice(0, 4)) {
      console.log(`  [${p.id}] ${p.title.slice(0, 40)} -> ${p.url.slice(0, 60)}`);
    }
    if (pages.length > 4) {
      console.log(`  ... and ${pages.length - 4} more tabs`);
    }
  } catch (e) {
    console.log(`Port ${port}: Error connecting: ${e.message}`);
  }
}
