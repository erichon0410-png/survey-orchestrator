import assert from "node:assert/strict";
import { isDashboardPage, findDashboardAction } from "../scripts/dashboard_launcher.mjs";

console.log("Testing dashboard launcher module...");

// 1. isDashboardPage tests
assert.equal(isDashboardPage({ url: "https://www.swagbucks.com/surveys" }), true);
assert.equal(isDashboardPage({ url: "https://www.swagbucks.com/surveys?p=1" }), true);
assert.equal(isDashboardPage({ url: "https://www.surveyjunkie.com/surveys" }), true);
assert.equal(isDashboardPage({ url: "https://www.surveyjunkie.com/dashboard" }), true);
assert.equal(isDashboardPage({ url: "https://www.swagbucks.com/surveys/prescreener-v2" }), false);
assert.equal(isDashboardPage({ url: "https://entertainmentlab.github.io/surveys/123" }), false);
assert.equal(isDashboardPage(null), false);

// 1b. findDashboardAction modal dismissal priority
{
  const mockControls = [
    { role: "button", label: "Close", className: "feedback-modal_cta", w: 50, h: 20, isVisible: true },
    { role: "button", label: "Start Survey", x: 960, y: 490, isVisible: true },
    { role: "link", label: "12 SB - 3 min", className: "card_card", x: 300, y: 400, isVisible: true },
  ];
  const action = findDashboardAction(mockControls);
  assert.ok(action, "Must find action when modal close button present");
  assert.equal(action.type, "dismiss_modal");
  assert.equal(action.target.label, "Close");
}

// 2. findDashboardAction modal priority
{
  const mockControls = [
    { role: "button", label: "Start Survey", x: 960, y: 490, isVisible: true },
    { role: "button", label: "Best Match", x: 100, y: 100, isVisible: true },
  ];
  const action = findDashboardAction(mockControls);
  assert.ok(action, "Must find action when Start Survey button present");
  assert.equal(action.type, "modal_start");
  assert.equal(action.target.label, "Start Survey");
}

// 3. findDashboardAction refresh CTA
{
  const mockControls = [
    { role: "button", label: "Check for New Surveys", x: 500, y: 300, isVisible: true },
    { role: "button", label: "Short Surveys", x: 100, y: 100, isVisible: true },
  ];
  const action = findDashboardAction(mockControls);
  assert.ok(action, "Must find refresh CTA");
  assert.equal(action.type, "refresh_cta");
}

// 4. findDashboardAction survey cards fallback
{
  const mockControls = [
    { role: "link", label: "12 SB - 3 min", className: "card_card", x: 300, y: 400, isVisible: true },
    { role: "link", label: "45 SB - 7 min", className: "card_card", x: 600, y: 400, isVisible: true },
  ];
  const action = findDashboardAction(mockControls);
  assert.ok(action, "Must select a survey card");
  assert.equal(action.type, "survey_card");
}

console.log("PASS test_dashboard_launcher");