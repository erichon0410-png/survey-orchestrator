// Unit tests for scripts/cdp_readonly.mjs — the READ-ONLY CDP capture helper used by
// the survey-fleet-supervisor to "manually look" at each live container.
//
// Only the pure target-selection logic is tested here (no live container needed), so it
// runs fast and deterministically like the rest of tests/*.mjs. The read-only CDP round
// trip itself is verified by a live run against the fleet (see supervisor handoff).
//
// Run: node tests/test_cdp_readonly.mjs   (uses node:assert/strict, like the suite)

import assert from "node:assert/strict";
import { selectPageTarget } from "../scripts/cdp_readonly.mjs";

let passed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
    passed += 1;
  } catch (e) {
    console.error(`FAIL ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

// Fixtures mirror the REAL /cdp/json shapes observed on the live fleet:
const P = (url) => ({ type: "page", url, webSocketDebuggerUrl: `ws://127.0.0.1/x/${encodeURIComponent(url)}` });
const UI = { type: "browser_ui", url: "chrome://omnibox-popup.top-chrome/" };
const WK = { type: "worker", url: "" };
const IF = (url) => ({ type: "iframe", url, webSocketDebuggerUrl: `ws://x/${encodeURIComponent(url)}` });

// 1. Prefer the platform's own domain when it is among several real pages (port-3016 shape),
//    AND within that domain prefer the balance/account page over transient survey/callback pages.
check("prefers platform-domain balance page over screener/transient pages", () => {
  const targets = [
    P("https://screener.purespectrum.com/?survey_id=52142453"),
    P("https://dkr1.ssisurveys.com/projects/rex?access_key=A9C"),
    P("https://app.surveyjunkie.com/callback/survey?survey-status=15&survey-points=0"),
    P("https://app.surveyjunkie.com/"),
    P("https://survey.alchemer.com/s3/8917235/control"),
    UI, WK,
  ];
  const sel = selectPageTarget(targets, { preferredHosts: ["surveyjunkie.com"] });
  assert.ok(sel, "expected a target");
  // The logged-in home (root) is where the balance shows — not the /callback survey page.
  assert.equal(sel.url, "https://app.surveyjunkie.com/", `got ${sel.url}`);
});

// 2. When no platform-domain page exists, fall back to the first real https page (port-3014 shape).
check("falls back to first real https page when preferred host absent", () => {
  const targets = [P("https://www.swagbucks.com/surveys"), UI, WK];
  const sel = selectPageTarget(targets, { preferredHosts: ["swagbucks.com"] });
  assert.ok(sel);
  assert.equal(sel.url, "https://www.swagbucks.com/surveys");
});

// 3. When the only real page is NOT the platform domain (port-3017 shape), still return it
//    (the supervisor will then treat the read as low-confidence / memory-backed).
check("returns non-platform real page when no preferred host present", () => {
  const targets = [P("https://itrafficcenter.com/s/167760/3/3202864633"), IF("https://www.recaptcha.net/x"), UI, WK];
  const sel = selectPageTarget(targets, { preferredHosts: ["swagbucks.com"] });
  assert.ok(sel);
  assert.equal(sel.url, "https://itrafficcenter.com/s/167760/3/3202864633");
});

// 4. No real page at all (only blank/devtools/browser_ui/worker) -> null.
check("returns null when no real http(s) page exists", () => {
  const targets = [
    { type: "page", url: "about:blank" },
    { type: "page", url: "devtools://devtools/bundled/inspector.html" },
    UI, WK,
  ];
  assert.equal(selectPageTarget(targets, { preferredHosts: ["swagbucks.com"] }), null);
});

// 5. Iframes with http urls are NOT page targets (type must be "page").
check("ignores iframe/worker/browser_ui even when they carry http urls", () => {
  const targets = [IF("https://www.swagbucks.com/surveys"), UI, WK];
  assert.equal(selectPageTarget(targets, { preferredHosts: ["swagbucks.com"] }), null);
});

// 6. Empty input -> null (no throw).
check("empty target list returns null", () => {
  assert.equal(selectPageTarget([], { preferredHosts: ["x.com"] }), null);
  assert.equal(selectPageTarget(undefined, { preferredHosts: [] }), null);
});

console.log(`\n${passed} targeted check(s) ran (exit ${process.exitCode || 0}).`);
