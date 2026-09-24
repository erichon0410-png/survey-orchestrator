// scripts/patch_container_stealth.mjs
// Patches the container's BrowserSkill extension to inject human Bézier curves and visual overlay.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { getVirtualCursorScript } from "./stealth_mouse.mjs";

export function generateBackgroundPatch(src) {
  const cursorScript = getVirtualCursorScript();
  const helperCode = `
    /* === STEALTH BEZIER CURSOR INJECTION === */
    const __virtualCursorSnippet = ${JSON.stringify(cursorScript)};
    const __injectedTabs = new Set();
    let __lastMouse = { x: 100, y: 100 };

    async function stealthEnsureCursor(cdp, tabId) {
      try {
        if (!__injectedTabs.has(tabId)) {
          __injectedTabs.add(tabId);
          await cdp.send(tabId, 'Page.addScriptToEvaluateOnNewDocument', { source: __virtualCursorSnippet }).catch(() => {});
        }
        await cdp.send(tabId, 'Runtime.evaluate', { expression: __virtualCursorSnippet }).catch(() => {});
      } catch (_) {}
    }

    async function stealthBezierDispatch(cdp, tabId, targetCoords, modifiers) {
      await stealthEnsureCursor(cdp, tabId);
      const p0 = __lastMouse;
      const p1 = { x: targetCoords.x, y: targetCoords.y };
      const dx = p1.x - p0.x;
      const dy = p1.y - p0.y;
      const dist = Math.hypot(dx, dy);
      const steps = Math.max(8, Math.min(14, Math.round(dist / 45)));

      for (let i = 1; i <= steps; i++) {
        const s = i / steps;
        const t = s * s * (3 - 2 * s);
        const jx = (Math.random() - 0.5) * 1.0;
        const jy = (Math.random() - 0.5) * 1.0;
        const curX = Math.round(p0.x + dx * t + jx);
        const curY = Math.round(p0.y + dy * t + jy);
        await cdp.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: curX, y: curY, modifiers }).catch(() => {});
        await new Promise(r => setTimeout(r, 6 + Math.floor(Math.random() * 4)));
      }
      __lastMouse = { x: p1.x, y: p1.y };
      await new Promise(r => setTimeout(r, 35 + Math.floor(Math.random() * 25)));
    }
  `;

  let patched = src;
  // If previously patched with an older version, strip old header
  const oldHeaderRegex = /\/\* === STEALTH BEZIER CURSOR INJECTION === \*\/[\s\S]*?async function stealthBezierDispatch\([^)]*\)\s*\{[\s\S]*?\n\s*\}\n/;
  if (oldHeaderRegex.test(patched)) {
    patched = patched.replace(oldHeaderRegex, "");
  }

  patched = helperCode + "\n" + patched;

  // Replace instant move call in wg (click)
  const targetPattern = /await r\.cdp\.send\(e,\s*['"`]Input\.dispatchMouseEvent['"`],\s*\{type:\s*['"`]mouseMoved['"`],\s*\.\.\.t,\s*modifiers:\s*s\}\)/g;
  patched = patched.replace(targetPattern, "await stealthBezierDispatch(r.cdp, e, t, s)");

  // Patch Mc descendant bounds to auto-scroll target into view and resolve input labels
  const origDescendantSnippet = `const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;`;
  const enhancedDescendantSnippet = `let target = this;
        if (target instanceof Element) {
          if (target.tagName === 'INPUT' && (target.type === 'checkbox' || target.type === 'radio')) {
            const lbl = target.closest('label') || (target.id ? document.querySelector('label[for="' + target.id + '"]') : null);
            if (lbl) target = lbl;
          }
          try { target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (_) {}
        }
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;`;

  if (patched.includes(origDescendantSnippet) && !patched.includes("target.scrollIntoView")) {
    patched = patched.replace(origDescendantSnippet, enhancedDescendantSnippet);
    patched = patched.replace("if (this instanceof Element) pushElement(this);", "if (target instanceof Element) pushElement(target);");
    patched = patched.replace("for (const el of this.querySelectorAll('*')) pushElement(el);", "for (const el of target.querySelectorAll('*')) pushElement(el);");
    patched = patched.replace("if (rects.length === 0) return null;", `if (rects.length === 0) {
          if (target instanceof Element) {
            const b = target.getBoundingClientRect();
            if (b && b.width > 0 && b.height > 0) return { x: b.left, y: b.top, width: b.width, height: b.height };
          }
          return null;
        }`);
  }

  return patched;
}

export function patchContainer(containerName) {
  console.log(`[patch] Checking container: ${containerName}`);
  const bgPath = "/usr/share/chromium/extensions/browser-skill/background.js";
  const orig = execSync(`docker exec ${containerName} cat ${bgPath}`, { encoding: "utf-8" });

  const patched = generateBackgroundPatch(orig);
  if (orig === patched) {
    console.log(`[patch] ${containerName} background.js is already up-to-date.`);
  } else {
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
