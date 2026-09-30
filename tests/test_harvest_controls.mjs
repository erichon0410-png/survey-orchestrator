// tests/test_harvest_controls.mjs — Fast Control Harvester Unit Tests
import assert from "node:assert/strict";
import { getHarvestScript, harvestControls, formatControlsTable } from "../scripts/harvest_controls.mjs";

console.log("[test] 1. getHarvestScript returns valid in-page extraction snippet");
{
  const script = getHarvestScript();
  assert.equal(typeof script, "string", "script must be a string");
  assert.ok(script.length > 300, "script must contain comprehensive harvester logic");
  assert.ok(script.includes("querySelectorAll"), "must query DOM controls");
  assert.ok(script.includes("checkVisibility"), "must check control visibility");
  assert.ok(script.includes("aria-label"), "must check accessibility labels");
  assert.ok(script.includes("getBoundingClientRect"), "must compute coordinates");
}

console.log("[test] 2. harvestControls processes CDP evaluate result into structured controls");
{
  const mockElements = [
    {
      role: "radio",
      label: "Female",
      tag: "input",
      type: "radio",
      x: 200,
      y: 350,
      w: 24,
      h: 24,
      checked: false,
      value: "female",
      selector: 'input[name="gender"]',
      isSubmitOrNext: false,
    },
    {
      role: "radio",
      label: "Male",
      tag: "input",
      type: "radio",
      x: 200,
      y: 390,
      w: 24,
      h: 24,
      checked: false,
      value: "male",
      selector: 'input[name="gender"]',
      isSubmitOrNext: false,
    },
    {
      role: "textbox",
      label: "ZIP Code",
      tag: "input",
      type: "text",
      x: 250,
      y: 440,
      w: 120,
      h: 36,
      checked: false,
      value: "",
      selector: "#zip-input",
      isSubmitOrNext: false,
    },
    {
      role: "button",
      label: "Next",
      tag: "button",
      type: "submit",
      x: 350,
      y: 520,
      w: 100,
      h: 40,
      checked: false,
      value: "Next",
      selector: 'button[type="submit"]',
      isSubmitOrNext: true,
    },
  ];

  let evaluatedExpression = null;
  const mockSend = async (method, params) => {
    if (method === "Runtime.evaluate") {
      evaluatedExpression = params.expression;
      return {
        result: {
          value: mockElements,
        },
      };
    }
    return {};
  };

  const res = await harvestControls(mockSend);

  assert.ok(evaluatedExpression.includes("checkVisibility"), "must send harvest script");
  assert.equal(res.totalCount, 4, "must count 4 controls");
  assert.equal(res.controls.length, 4, "must include 4 controls in array");
  assert.equal(res.radios.length, 2, "must identify 2 radios");
  assert.equal(res.radios[0].label, "Female");
  assert.equal(res.inputs.length, 1, "must identify 1 textbox input");
  assert.equal(res.inputs[0].label, "ZIP Code");
  assert.ok(res.nextButton, "must identify next button");
  assert.equal(res.nextButton.label, "Next");
  assert.equal(res.nextButton.x, 350);
  assert.equal(res.nextButton.y, 520);
  assert.ok(typeof res.table === "string" && res.table.includes("Female"), "table must include Female option");
  assert.ok(res.table.includes("[NEXT/SUBMIT]"), "table must flag Next button");
}

console.log("[test] 3. formatControlsTable formats compact summary table");
{
  const controls = [
    { role: "radio", label: "Agree", x: 120, y: 220, w: 20, h: 20, checked: true, isSubmitOrNext: false },
    { role: "button", label: "Continue", x: 300, y: 400, w: 90, h: 35, checked: false, isSubmitOrNext: true },
  ];
  const table = formatControlsTable(controls);
  assert.ok(table.includes('role=radio label="Agree" pos=(120,220)'), "table must format radio row");
  assert.ok(table.includes("checked"), "table must show checked status");
  assert.ok(table.includes("[NEXT/SUBMIT]"), "table must flag Continue button");
}

console.log("[test] 4. harvestControls error handling on CDP evaluation failure");
{
  const failingSend = async () => ({
    exceptionDetails: { text: "Evaluation failed: ReferenceError: window is not defined" },
  });

  await assert.rejects(async () => {
    await harvestControls(failingSend);
  }, /harvestControls evaluation failed/);
}

console.log("PASS: test_harvest_controls");
