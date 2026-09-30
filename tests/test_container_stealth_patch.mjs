import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { generateBackgroundPatch } from "../scripts/patch_container_stealth.mjs";

console.log("[test] 1. generateBackgroundPatch transforms instant click into smooth trajectory");
{
  const sampleBackground = `
    let o=n.button??'left',s=ug(n.modifiers),c=!1,l=!1,u=!1,d=n.click_count??1,f=()=>r.cdp.send(e,'Input.dispatchMouseEvent',{type:'mouseReleased',...t,button:o,clickCount:d,modifiers:s});
    if(u=!0,await r.cdp.send(e,'Input.dispatchMouseEvent',{type:'mouseMoved',...t,modifiers:s}),i){let e=await i();if(e)return p(e)}
    await r.cdp.send(e,'Input.dispatchMouseEvent',{type:'mousePressed',...t,button:o,clickCount:d,modifiers:s}),await f()
  `;

  const patched = generateBackgroundPatch(sampleBackground);
  assert.ok(patched.includes("stealthBezierDispatch"), "must insert stealthBezierDispatch helper");
  assert.ok(patched.includes("Math.round(dist / 45)"), "must use turbo step calculation");
  assert.ok(patched.includes("35 + Math.floor(Math.random() * 25)"), "must use turbo trailing pause");
  assert.ok(!patched.includes("await r.cdp.send(e,'Input.dispatchMouseEvent',{type:'mouseMoved',...t,modifiers:s})"), "must replace raw instant mouseMoved");
  assert.ok(patched.includes("await stealthBezierDispatch(r.cdp, e, t, s)"), "must call stealthBezierDispatch");
}

console.log("[test] 2. generateBackgroundPatch handles template literal backticks in background.js");
{
  const sampleWithBackticks = `
    let o=n.button??'left',s=ug(n.modifiers),c=!1,l=!1,u=!1,d=n.click_count??1,f=()=>r.cdp.send(e,\`Input.dispatchMouseEvent\`,{type:\`mouseReleased\`,...t,button:o,clickCount:d,modifiers:s});
    if(u=!0,await r.cdp.send(e,\`Input.dispatchMouseEvent\`,{type:\`mouseMoved\`,...t,modifiers:s}),i){let e=await i();if(e)return p(e)}
    await r.cdp.send(e,\`Input.dispatchMouseEvent\`,{type:\`mousePressed\`,...t,button:o,clickCount:d,modifiers:s}),await f()
  `;

  const patched = generateBackgroundPatch(sampleWithBackticks);
  assert.ok(patched.includes("stealthBezierDispatch"), "must insert stealthBezierDispatch helper");
  assert.ok(!patched.includes("await r.cdp.send(e,`Input.dispatchMouseEvent`,{type:`mouseMoved`,...t,modifiers:s})"), "must replace raw instant mouseMoved with backticks");
  assert.ok(patched.includes("await stealthBezierDispatch(r.cdp, e, t, s)"), "must call stealthBezierDispatch");
}

console.log("[test] 4. generateBackgroundPatch injects auto-scroll and label resolution");
{
  const sample = `
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    if (this instanceof Element) pushElement(this);
    for (const el of this.querySelectorAll('*')) pushElement(el);
    if (rects.length === 0) return null;
  `;
  const patched = generateBackgroundPatch(sample);
  assert.ok(patched.includes("target.scrollIntoView"), "must inject target.scrollIntoView");
  assert.ok(patched.includes("target.closest('label')"), "must resolve closest label for inputs");
  assert.ok(patched.includes("pushElement(target)"), "must push target instead of this");
  assert.ok(patched.includes("target.getBoundingClientRect()"), "must fall back to bounding client rect");
}

console.log("PASS: test_container_stealth_patch");
