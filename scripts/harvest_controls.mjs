// scripts/harvest_controls.mjs — System 1 Fast Control Harvester
//
// In-page atomic control harvesting inspired by jev-ultrafast/snapshot.js.
// Extracts visible, actionable controls (<1,200 tokens) via a single CDP Runtime.evaluate
// call instead of serializing the full 25k-token accessibility tree.

/**
 * Returns a standalone JavaScript snippet that extracts actionable visible controls
 * directly in the browser context.
 */
export function getHarvestScript() {
  return `(() => {
  const elements = Array.from(document.querySelectorAll("a, button, input, select, textarea, [role]"));
  const visibleControls = [];

  function getLabel(el) {
    if (el.getAttribute("aria-label")) return el.getAttribute("aria-label").trim();
    if (el.getAttribute("aria-labelledby")) {
      const labelledBy = document.getElementById(el.getAttribute("aria-labelledby"));
      if (labelledBy) return (labelledBy.innerText || labelledBy.textContent || "").trim();
    }
    if (el.labels && el.labels.length > 0) {
      const texts = Array.from(el.labels).map(l => (l.innerText || l.textContent || "").trim()).filter(Boolean);
      if (texts.length > 0) return texts.join(" ");
    }
    const parentLabel = el.closest("label");
    if (parentLabel) {
      const txt = (parentLabel.innerText || parentLabel.textContent || "").trim();
      if (txt) return txt;
    }
    if (el.placeholder) return el.placeholder.trim();
    if (el.value && (el.type === "submit" || el.type === "button")) return el.value.trim();
    if (el.innerText && el.innerText.trim()) return el.innerText.trim().slice(0, 100);
    if (el.title) return el.title.trim();
    return "";
  }

  function getRole(el) {
    const roleAttr = el.getAttribute("role");
    if (roleAttr) return roleAttr.toLowerCase();
    const tag = el.tagName.toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a") return "link";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = (el.type || "text").toLowerCase();
      if (type === "hidden") return "hidden";
      if (type === "radio") return "radio";
      if (type === "checkbox") return "checkbox";
      if (type === "submit" || type === "button" || type === "reset") return "button";
      return "textbox";
    }
    return tag;
  }

  for (const el of elements) {
    const tag = el.tagName.toLowerCase();
    const type = (el.type || "").toLowerCase();
    if (type === "hidden") continue;

    const style = window.getComputedStyle(el);
    const cssVisible = style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
    let isVisible = cssVisible;
    if (typeof el.checkVisibility === "function") {
      isVisible = el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || cssVisible;
    }

    let rect = el.getBoundingClientRect();
    // Fallback for custom checkboxes / radio buttons styled off-screen (e.g. left: -9999px) or zero-sized
    if (!isVisible || rect.width <= 0 || rect.height <= 0 || rect.left < 0 || rect.top < 0) {
      const parent = el.closest(".clickableCell, .fir-choice, label") || (el.parentElement && (el.role === "radio" || type === "radio" || type === "checkbox") ? el.parentElement : null);
      if (parent) {
        const pRect = parent.getBoundingClientRect();
        if (pRect.width > 0 && pRect.height > 0 && pRect.left >= 0 && pRect.top >= 0) {
          rect = pRect;
          isVisible = true;
        }
      }
    }
    if (!isVisible) continue;
    if (rect.width <= 0 || rect.height <= 0 || rect.left < 0) continue;

    const role = getRole(el);
    if (role === "hidden") continue;

    const label = getLabel(el);
    const checked = !!el.checked;
    const value = el.value || "";
    const disabled = el.disabled || el.getAttribute("aria-disabled") === "true";
    const clsStr = typeof el.className === "string" ? el.className.trim() : (typeof el.className?.baseVal === "string" ? el.className.baseVal.trim() : "");
    const isBack = /back|prev(ious)?/i.test(label) || /back|prev/i.test(clsStr) || label === "<";
    const isSubmitOrNext = !isBack && (/next|continue|submit|proceed|forward|done/i.test(label) || /next|continue|arrow/i.test(clsStr) || type === "submit");

    if (disabled) {
      if (isSubmitOrNext) {
        visibleControls.push({
          role: "button",
          label: label || "Continue",
          tag,
          type,
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          checked,
          value,
          disabled: true,
          selector: el.id ? "#" + el.id : (el.name ? tag + '[name="' + el.name + '"]' : (clsStr ? "." + clsStr.trim().split(/\s+/).filter(Boolean).join(".") : "")),
          isSubmitOrNext: true,
        });
      }
      continue;
    }

    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);

    visibleControls.push({
      role,
      label,
      tag,
      type,
      x,
      y,
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      checked,
      value,
      selector: el.id ? "#" + el.id : (el.name ? tag + '[name="' + el.name + '"]' : ""),
      isSubmitOrNext,
    });
  }

  function extractQuestion() {
    const headings = Array.from(document.querySelectorAll("h1, h2, h3, [role='heading'], legend, .question-text, [class*='question'], [class*='prompt'], [class*='title']"));
    for (const h of headings) {
      const text = (h.innerText || h.textContent || "").trim();
      if (text && text.length > 5 && !/^(answer|play|shop|surveys|swagbucks|welcome)/i.test(text)) {
        return text;
      }
    }
    return "";
  }

  return {
    question: extractQuestion(),
    controls: visibleControls
  };
})()`;
}

/**
 * Formats an array of harvested controls into a compact, human/LLM-readable table.
 */
export function formatControlsTable(controls) {
  if (!controls || controls.length === 0) return "No actionable controls found.";
  return controls
    .map(
      (c, i) =>
        `[${i + 1}] role=${c.role} label="${c.label}" pos=(${c.x},${c.y}) size=${c.w}x${c.h}${
          c.checked ? " checked" : ""
        }${c.isSubmitOrNext ? " [NEXT/SUBMIT]" : ""}`
    )
    .join("\n");
}

/**
 * Harvests visible, actionable controls in the active browser page via CDP Runtime.evaluate.
 *
 * @param {Function} send - CDP send function (method, params)
 * @returns {Promise<{
 *   question: string,
 *   controls: Array,
 *   nextButton: Object|null,
 *   radios: Array,
 *   checkboxes: Array,
 *   inputs: Array,
 *   totalCount: number,
 *   table: string
 * }>}
 */
export async function harvestControls(send) {
  const script = getHarvestScript();
  const res = await send("Runtime.evaluate", {
    expression: script,
    returnByValue: true,
  });

  if (res?.exceptionDetails) {
    const detail = res.exceptionDetails.exception?.description || res.exceptionDetails.text || JSON.stringify(res.exceptionDetails);
    throw new Error(`harvestControls evaluation failed: ${detail}`);
  }

  const raw = res?.result?.value;
  const controls = Array.isArray(raw) ? raw : (raw?.controls || []);
  const question = typeof raw?.question === "string" ? raw.question : "";
  const nextButton = controls.find((c) => c.isSubmitOrNext) || null;
  const radios = controls.filter((c) => c.role === "radio");
  const checkboxes = controls.filter((c) => c.role === "checkbox");
  const inputs = controls.filter((c) => c.role === "textbox");
  const table = formatControlsTable(controls);

  return {
    question,
    controls,
    nextButton,
    radios,
    checkboxes,
    inputs,
    totalCount: controls.length,
    table,
  };
}
