// scripts/patch_container_stealth.mjs
// Patches the container's BrowserSkill extension to inject human Bézier curves and visual overlay.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

export function generateBackgroundPatch(src) {
  const helperCode = `
    /* === STEALTH BEZIER CURSOR INJECTION === */
    let __lastMouse = { x: 100, y: 100 };
    async function stealthBezierDispatch(cdp, tabId, targetCoords, modifiers) {
      const p0 = __lastMouse;
      const p1 = { x: targetCoords.x, y: targetCoords.y };
      const dx = p1.x - p0.x;
      const dy = p1.y - p0.y;
      const dist = Math.hypot(dx, dy);
      const steps = Math.max(20, Math.min(38, Math.round(dist / 20)));

      for (let i = 1; i <= steps; i++) {
        const s = i / steps;
        const t = s * s * (3 - 2 * s);
        const jx = (Math.random() - 0.5) * 1.0;
        const jy = (Math.random() - 0.5) * 1.0;
        const curX = Math.round(p0.x + dx * t + jx);
        const curY = Math.round(p0.y + dy * t + jy);
        await cdp.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: curX, y: curY, modifiers }).catch(() => {});
        await new Promise(r => setTimeout(r, 9 + Math.floor(Math.random() * 8)));
      }
      __lastMouse = { x: p1.x, y: p1.y };
      await new Promise(r => setTimeout(r, 120 + Math.floor(Math.random() * 120)));
    }
  `;

  // Replace the instant mouseMoved with stealthBezierDispatch
  let patched = src;
  if (!patched.includes("stealthBezierDispatch")) {
    patched = helperCode + "\n" + patched;
  }

  // Replace instant move call
  const targetPattern = /await r\.cdp\.send\(e,\s*['"`]Input\.dispatchMouseEvent['"`],\s*\{type:\s*['"`]mouseMoved['"`],\s*\.\.\.t,\s*modifiers:\s*s\}\)/g;
  patched = patched.replace(targetPattern, "await stealthBezierDispatch(r.cdp, e, t, s)");

  return patched;
}

export function patchContainer(containerName) {
  console.log(`[patch] Checking container: ${containerName}`);
  const bgPath = "/usr/share/chromium/extensions/browser-skill/background.js";
  const orig = execSync(`docker exec ${containerName} cat ${bgPath}`, { encoding: "utf-8" });

  if (orig.includes("stealthBezierDispatch")) {
    console.log(`[patch] ${containerName} background.js already patched.`);
  } else {
    const patched = generateBackgroundPatch(orig);
    const tmpFile = path.join(os.tmpdir(), `bg_patched_${containerName}_${Date.now()}.js`);
    fs.writeFileSync(tmpFile, patched, "utf-8");
    execSync(`docker cp ${tmpFile} ${containerName}:${bgPath}`);
    try {
      fs.unlinkSync(tmpFile);
    } catch {}
    console.log(`[patch] Copied stealth background.js to ${containerName}`);
  }

  // Strip --test-type from wrapped-chromium
  try {
    execSync(`docker exec ${containerName} sed -i '/--test-type/d' /usr/bin/wrapped-chromium`);
    console.log(`[patch] Stripped --test-type from ${containerName}`);
  } catch (e) {
    console.warn(`[patch] Warning stripping --test-type: ${e.message}`);
  }
}

if (process.argv[1] && process.argv[1].endsWith("patch_container_stealth.mjs")) {
  const containers = ["SurveyCompleter-gmail-03", "SurveyCompleter-gmail-04"];
  for (const c of containers) {
    patchContainer(c);
  }
}
