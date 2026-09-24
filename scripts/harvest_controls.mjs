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
    if (parentLabel) return (parentLabel.innerText || parentLabel.textContent || "").trim();
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
      if (type === "radio") return "radio";
      if (type === "checkbox") return "checkbox";
      if (type === "submit" || type === "button" || type === "reset") return "button";
      return "textbox";
    }
    return tag;
  }

  for (const el of elements) {
    let isVisible = false;
    if (typeof el.checkVisibility === "function") {
      isVisible = el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    } else {
      const style = window.getComputedStyle(el);
      isVisible = style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
    }
    if (!isVisible) continue;

    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;

    const role = getRole(el);
    const label = getLabel(el);
    const tag = el.tagName.toLowerCase();
    const type = (el.type || "").toLowerCase();
    const checked = !!el.checked;
    const value = el.value || "";
    const disabled = el.disabled || el.getAttribute("aria-disabled") === "true";

    if (disabled) continue;

    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);

    const isSubmitOrNext = /next|continue|submit|proceed|forward|done/i.test(label) || type === "submit";

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
      selector: el.id ? \`#\${el.id}\` : (el.name ? \`\${tag}[name="\${el.name}"]\` : ""),
      isSubmitOrNext,
    });
  }

  return visibleControls;
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
    throw new Error(
      `harvestControls evaluation failed: ${res.exceptionDetails.text || JSON.stringify(res.exceptionDetails)}`
    );
  }

  const controls = res?.result?.value || [];
  const nextButton = controls.find((c) => c.isSubmitOrNext) || null;
  const radios = controls.filter((c) => c.role === "radio");
  const checkboxes = controls.filter((c) => c.role === "checkbox");
  const inputs = controls.filter((c) => c.role === "textbox");
  const table = formatControlsTable(controls);

  return {
    controls,
    nextButton,
    radios,
    checkboxes,
    inputs,
    totalCount: controls.length,
    table,
  };
}
