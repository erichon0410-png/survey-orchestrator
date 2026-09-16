// scripts/mouse_helper.mjs — Trusted CDP mouse simulation helper
//
// Dispatches authentic physical-like mouse events (isTrusted: true) via Chrome
// DevTools Protocol Input.dispatchMouseEvent.

export async function dispatchMouseClick(send, target, options = {}) {
  const lastPos = options.lastPos || { x: 100, y: 100 };
  const holdMs = options.holdMs ?? (60 + Math.floor(Math.random() * 50));
  let x, y;

  if (typeof target === "string") {
    const res = await send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(target)});
        if (!el) return null;
        el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height, tag: el.tagName, text: el.innerText ? el.innerText.slice(0, 50) : "" };
      })()`,
      returnByValue: true
    });

    const info = res?.result?.value;
    if (!info) {
      throw new Error(`Element not found for selector: ${target}`);
    }
    if (info.w === 0 && info.h === 0) {
      throw new Error(`Element has 0 dimensions: ${target}`);
    }

    // Subtle jitter inside the central 60% of the element (±20% of width/height from center)
    const jitterFactor = options.jitterPercent ?? 0.4;
    const jitterX = (Math.random() - 0.5) * (info.w * jitterFactor);
    const jitterY = (Math.random() - 0.5) * (info.h * jitterFactor);
    x = Math.round(info.x + info.w / 2 + jitterX);
    y = Math.round(info.y + info.h / 2 + jitterY);
  } else if (target && typeof target.x === "number" && typeof target.y === "number") {
    x = Math.round(target.x);
    y = Math.round(target.y);
  } else {
    throw new Error("Invalid target: must be a selector string or {x, y} coordinate object");
  }

  // 1. Intermediate trajectory step (human-like motion)
  const midX = Math.round((lastPos.x + x) / 2 + (Math.random() * 6 - 3));
  const midY = Math.round((lastPos.y + y) / 2 + (Math.random() * 6 - 3));
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: midX, y: midY });
  await new Promise((r) => setTimeout(r, 15 + Math.floor(Math.random() * 15)));

  // 2. Target hover
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await new Promise((r) => setTimeout(r, 20 + Math.floor(Math.random() * 20)));

  // 3. Mouse press (down)
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });

  // 4. Human hold delay (default 60-110ms)
  await new Promise((r) => setTimeout(r, holdMs));

  // 5. Mouse release (up)
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });

  return { ok: true, x, y };
}
