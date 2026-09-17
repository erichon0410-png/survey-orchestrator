import assert from "node:assert/strict";
import { isCorrectUrl, PLATFORM_DASHBOARD_URLS, navigatePortToPlatform } from "../scripts/ensure_fleet_navigation.mjs";

console.log("=== Testing ensure_fleet_navigation.mjs ===");

// 1. Check PLATFORM_DASHBOARD_URLS
assert.equal(PLATFORM_DASHBOARD_URLS.surveyjunkie, "https://app.surveyjunkie.com/");
assert.equal(PLATFORM_DASHBOARD_URLS.swagbucks, "https://www.swagbucks.com/surveys");

// 2. Test isCorrectUrl for surveyjunkie
assert.equal(isCorrectUrl("https://app.surveyjunkie.com/", "surveyjunkie"), true);
assert.equal(isCorrectUrl("https://app.surveyjunkie.com/surveys", "surveyjunkie"), true);
assert.equal(isCorrectUrl("https://app.surveyjunkie.com/404", "surveyjunkie"), false, "Must reject 404");
assert.equal(isCorrectUrl("https://app.surveyjunkie.com/rewards", "surveyjunkie"), false, "Must reject rewards tab");
assert.equal(isCorrectUrl("https://www.swagbucks.com/surveys", "surveyjunkie"), false, "Must reject swagbucks on surveyjunkie port");

// 3. Test isCorrectUrl for swagbucks
assert.equal(isCorrectUrl("https://www.swagbucks.com/surveys", "swagbucks"), true);
assert.equal(isCorrectUrl("https://app.surveyjunkie.com/", "swagbucks"), false);

// 4. Test live navigation against port 3013
const res = await navigatePortToPlatform(3013);
assert.equal(res.ok, true, "Navigation check on 3013 should succeed");
assert.equal(res.platform, "surveyjunkie");

console.log("✓ All ensure_fleet_navigation tests passed successfully!");
