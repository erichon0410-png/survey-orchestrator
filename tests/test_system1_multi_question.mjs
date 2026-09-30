// tests/test_system1_multi_question.mjs — Multi-Question Form Fast-Path Unit Tests
import assert from "node:assert/strict";
import { tryExecuteFastPath } from "../scripts/system1_runner.mjs";

console.log("[test] 1. tryExecuteFastPath handles multiple question groups sequentially and submits");
{
  const clicks = [];
  const mockSend = async (method, params) => {
    if (method === "Runtime.evaluate") {
      if (params.expression.includes("checkVisibility") || params.expression.includes("extractQuestion")) {
        // Return harvested object with multiple question groups
        return {
          result: {
            value: {
              question: "Multiple Questions Survey Page",
              controls: [
                { role: "radio", label: "Republican", selector: "#q1-rep", x: 100, y: 150, w: 20, h: 20, isSubmitOrNext: false },
                { role: "radio", label: "Democrat", selector: "#q1-dem", x: 100, y: 180, w: 20, h: 20, isSubmitOrNext: false },
                { role: "radio", label: "Green", selector: "#q2-green", x: 100, y: 250, w: 20, h: 20, isSubmitOrNext: false },
                { role: "radio", label: "Watermelon", selector: "#q2-mel", x: 100, y: 280, w: 20, h: 20, isSubmitOrNext: false },
                { role: "checkbox", label: "I consent to the terms and privacy policy", selector: "#consent-cb", x: 100, y: 350, w: 15, h: 15, checked: false, isSubmitOrNext: false },
                { role: "button", label: "Next", selector: "#btn-next", x: 200, y: 450, w: 80, h: 40, isSubmitOrNext: true },
              ],
              questionGroups: [
                {
                  title: "3. Generally speaking, do you usually think of yourself as a Republican, a Democrat, an Independent, or something else?",
                  isVisible: true,
                  hasChecked: false,
                  options: [
                    { role: "radio", type: "radio", label: "Republican", selector: "#q1-rep", x: 100, y: 150, w: 20, h: 20, checked: false },
                    { role: "radio", type: "radio", label: "Democrat", selector: "#q1-dem", x: 100, y: 180, w: 20, h: 20, checked: false },
                  ],
                },
                {
                  title: "4. Please select the color below to show that you are paying attention.",
                  isVisible: true,
                  hasChecked: false,
                  options: [
                    { role: "radio", type: "radio", label: "Watermelon", selector: "#q2-mel", x: 100, y: 280, w: 20, h: 20, checked: false },
                    { role: "radio", type: "radio", label: "Green", selector: "#q2-green", x: 100, y: 250, w: 20, h: 20, checked: false },
                  ],
                },
              ],
              consentCheckboxes: [
                { role: "checkbox", type: "checkbox", label: "I consent to terms", selector: "#consent-cb", x: 100, y: 350, w: 15, h: 15, checked: false },
              ],
              nextButton: { role: "button", label: "Next", selector: "#btn-next", x: 200, y: 450, w: 80, h: 40, isSubmitOrNext: true },
            },
          },
        };
      }
      return { result: { value: { x: 100, y: 100, w: 20, h: 20 } } };
    }
    if (method === "Input.dispatchMouseEvent") {
      if (params.type === "mousePressed") {
        clicks.push({ x: params.x, y: params.y });
      }
      return {};
    }
    return {};
  };

  const mockSleep = async () => {};
  const mockFetchFn = async (state, questions) => {
    const criteria = questions.survey_question?.criteria || {};
    const choice = criteria["Republican"] ? "Republican" : (criteria["Green"] ? "Green" : Object.keys(criteria)[0]);
    return {
      model: "mock-model",
      answers: {
        survey_question: {
          type: "choice",
          choice,
          confidence: 0.95,
        },
      },
    };
  };

  const res = await tryExecuteFastPath(3014, {
    send: mockSend,
    sleepFn: mockSleep,
    fetchFn: mockFetchFn,
    useNeuralLaya: true,
  });

  assert.equal(res.handled, true, "must handle multi-question form");
  assert.equal(res.action, "multi_question_completed", "action must be multi_question_completed");
  assert.equal(res.questionsAnswered, 2, "must answer both question groups");
  assert.equal(res.nextClicked, true, "must click next button");
  assert.ok(clicks.length >= 4, "must execute mouse clicks for options, consent, and next button");
}

console.log("[test] 2. tryExecuteFastPath falls back to System 2 when unanswered questions cannot be answered");
{
  const mockSend = async (method, params) => {
    if (method === "Runtime.evaluate") {
      return {
        result: {
          value: {
            question: "Complex Survey Page",
            controls: [
              { role: "textbox", tag: "textarea", label: "Tell us in 500 words why...", selector: "#essay", x: 100, y: 150, w: 200, h: 100, isSubmitOrNext: false },
            ],
            questionGroups: [
              {
                title: "Tell us in 500 words why...",
                isVisible: true,
                hasChecked: false,
                options: [
                  { role: "textbox", tag: "textarea", label: "Essay response", selector: "#essay", x: 100, y: 150, w: 200, h: 100 },
                ],
              },
            ],
            nextButton: { role: "button", label: "Next", selector: "#btn-next", x: 200, y: 450, w: 80, h: 40, isSubmitOrNext: true },
          },
        },
      };
    }
    return {};
  };

  const res = await tryExecuteFastPath(3014, {
    send: mockSend,
    sleepFn: async () => {},
    useNeuralLaya: false,
  });

  assert.equal(res.handled, false, "must not handle unanswerable form");
  assert.equal(res.reason, "needs_system2", "must signal needs_system2");
}

console.log("PASS: test_system1_multi_question");
