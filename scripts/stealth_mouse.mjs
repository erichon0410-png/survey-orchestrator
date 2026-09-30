// scripts/stealth_mouse.mjs — Visual Stealth Mouse & Kinematics Engine
//
// Implements human-like cubic Bézier mouse movement, micro-tremor jitter,
// and in-page visual cursor overlay rendering (like Codex Desktop app).

/**
 * Calculates a point along a cubic Bézier curve at parameter t [0, 1].
 */
function cubicBezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const tt = t * t;
  const uu = u * u;
  const uuu = uu * u;
  const ttt = tt * t;

  return {
    x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
    y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y,
  };
}

/**
 * Calculates a target coordinate dispersed inside the inner bounding box.
 */
export function calculateJitter(box, jitterFactor = 0.4) {
  const cx = box.isCenter ? box.x : (box.x + box.w / 2);
  const cy = box.isCenter ? box.y : (box.y + box.h / 2);
  const maxOffsetX = (box.w * jitterFactor) / 2;
  const maxOffsetY = (box.h * jitterFactor) / 2;

  // Box-Muller normal distribution approximation clamped to ±1
  const u1 = Math.max(1e-6, Math.random());
  const u2 = Math.random();
  const randStdNormal = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  const clampedNormal = Math.max(-1, Math.min(1, randStdNormal / 2.5));

  const offsetX = clampedNormal * maxOffsetX;
  const offsetY = (Math.random() * 2 - 1) * maxOffsetY;

  return {
    x: Math.round(cx + offsetX),
    y: Math.round(cy + offsetY),
  };
}

/**
 * Generates an array of trajectory waypoints from p0 to p1.
 */
export function generateBezierTrajectory(p0, p1, options = {}) {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const distance = Math.hypot(dx, dy);

  const minSteps = options.minSteps ?? 8;
  const maxSteps = options.maxSteps ?? 14;
  const totalSteps = Math.max(minSteps, Math.min(maxSteps, Math.round(distance / 45)));

  // Generate randomized control points orthogonal to the direct line
  const normalAngle = Math.atan2(dy, dx) + (Math.random() > 0.5 ? 1 : -1) * (Math.PI / 2);
  const arcMagnitude = (Math.random() * 0.2 + 0.1) * distance;

  const cp1 = {
    x: p0.x + dx * 0.33 + Math.cos(normalAngle) * arcMagnitude * (Math.random() * 0.6 + 0.7),
    y: p0.y + dy * 0.33 + Math.sin(normalAngle) * arcMagnitude * (Math.random() * 0.6 + 0.7),
  };

  const cp2 = {
    x: p0.x + dx * 0.66 + Math.cos(normalAngle) * arcMagnitude * (Math.random() * 0.5 + 0.5),
    y: p0.y + dy * 0.66 + Math.sin(normalAngle) * arcMagnitude * (Math.random() * 0.5 + 0.5),
  };

  const points = [];
  points.push({ x: Math.round(p0.x), y: Math.round(p0.y), delayMs: 0 });

  const numIntermediate = totalSteps - 2;
  for (let i = 1; i <= numIntermediate; i++) {
    const s = i / (totalSteps - 1);
    // Smoothstep time easing: slow start, rapid mid-transit, deceleration at target
    const t = s * s * (3 - 2 * s);

    const pt = cubicBezier(p0, cp1, cp2, p1, t);

    // Micro-jitter: human neuromuscular tremor (±0.6px)
    const jitterX = (Math.random() - 0.5) * 1.2;
    const jitterY = (Math.random() - 0.5) * 1.2;

    const delayMs = Math.round(6 + Math.random() * 4);

    points.push({
      x: Math.round(pt.x + jitterX),
      y: Math.round(pt.y + jitterY),
      delayMs,
    });
  }

  // Final exact point
  points.push({
    x: Math.round(p1.x),
    y: Math.round(p1.y),
    delayMs: Math.round(6 + Math.random() * 4),
  });

  return points;
}

/**
 * Returns a standalone JavaScript snippet that injects the #codex-virtual-cursor overlay.
 */
export function getVirtualCursorScript() {
  return `(() => {
    if (window.__codex_cursor_installed) return;
    window.__codex_cursor_installed = true;

    function initCursor() {
      if (!document.body) {
        requestAnimationFrame(initCursor);
        return;
      }
      if (document.getElementById('codex-virtual-cursor')) return;

      const host = document.createElement('div');
      host.id = 'codex-virtual-cursor-host';
      host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;pointer-events:none;z-index:2147483647;overflow:visible;';

      const cursor = document.createElement('div');
      cursor.id = 'codex-virtual-cursor';
      cursor.style.cssText = [
        'position: fixed',
        'top: 0',
        'left: 0',
        'width: 28px',
        'height: 28px',
        'pointer-events: none',
        'z-index: 2147483647',
        'transform: translate3d(-100px, -100px, 0)',
        'transition: transform 0.035s cubic-bezier(0, 0, 0.2, 1)',
        'filter: drop-shadow(0 2px 5px rgba(0,0,0,0.5))',
      ].join(';');

      cursor.innerHTML = \`
        <svg viewBox="0 0 24 24" width="24" height="24" style="position:absolute;top:0;left:0;fill:#ff3344;stroke:#ffffff;stroke-width:1.5;stroke-linejoin:round;">
          <path d="M4 2 L20 12 L12 14 L8 22 Z"/>
        </svg>
        <div id="codex-cursor-ripple" style="position:absolute;top:0;left:0;width:24px;height:24px;border:2px solid #ff3344;border-radius:50%;opacity:0;pointer-events:none;transform:scale(0.5);transition:transform 0.25s ease-out, opacity 0.25s ease-out;"></div>
      \`;

      host.appendChild(cursor);
      document.body.appendChild(host);

      window.addEventListener('mousemove', (e) => {
        cursor.style.transform = \`translate3d(\${e.clientX}px, \${e.clientY}px, 0)\`;
      }, { passive: true, capture: true });

      window.addEventListener('mousedown', () => {
        const ripple = document.getElementById('codex-cursor-ripple');
        if (ripple) {
          ripple.style.transform = 'scale(1.8)';
          ripple.style.opacity = '0.9';
          setTimeout(() => {
            ripple.style.transform = 'scale(0.5)';
            ripple.style.opacity = '0';
          }, 200);
        }
      }, { passive: true, capture: true });
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initCursor);
    } else {
      initCursor();
    }
  })();`;
}

export let currentCursorPos = { x: 100, y: 100 };

/**
 * Injects the #codex-virtual-cursor overlay and webdriver overrides into the page.
 */
export async function injectVirtualCursor(send) {
  const script = getVirtualCursorScript();
  const stealthOverride = `
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  `;
  const fullScript = `${stealthOverride}\n${script}`;

  try {
    await send("Page.addScriptToEvaluateOnNewDocument", { source: fullScript });
  } catch {}

  try {
    await send("Runtime.evaluate", { expression: fullScript, returnByValue: false });
  } catch {}
}

/**
 * Moves cursor smoothly along a Bézier trajectory to target {x, y}.
 */
export async function stealthMove(send, targetPos, options = {}) {
  const startPos = options.lastPos || currentCursorPos;
  const trajectory = generateBezierTrajectory(startPos, targetPos, options);

  for (let i = 0; i < trajectory.length; i++) {
    const pt = trajectory[i];
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: pt.x,
      y: pt.y,
    });
    const delay = options.stepDelayMs !== undefined ? options.stepDelayMs : pt.delayMs;
    if (delay > 0) {
      await new Promise(r => setTimeout(r, delay));
    }
  }

  currentCursorPos = { x: targetPos.x, y: targetPos.y };
  return currentCursorPos;
}

/**
 * Executes a full human-like click with Bézier trajectory, hover dwell, hold, and settle.
 */
export async function stealthClick(send, target, options = {}) {
  try { await send("Page.bringToFront"); } catch {}
  let targetBox;

  const targetSelector = typeof target === "string" ? target : (target?.selector || null);
  const targetLabel = typeof target === "object" ? (target?.label || target?.text || null) : null;
  const targetX = typeof target === "object" && typeof target?.x === "number" ? target.x : null;
  const targetY = typeof target === "object" && typeof target?.y === "number" ? target.y : null;

  if (targetSelector || targetLabel || (targetX !== null && targetY !== null && typeof target === "object")) {
    try {
      const res = await send("Runtime.evaluate", {
        expression: `(() => {
          let el = null;
          const sel = ${JSON.stringify(targetSelector)};
          const lbl = ${JSON.stringify(targetLabel)};
          const tgtX = ${JSON.stringify(targetX)};
          const tgtY = ${JSON.stringify(targetY)};

          if (sel) {
            try { el = document.querySelector(sel); } catch {}
          }
          if (!el && typeof tgtX === 'number' && typeof tgtY === 'number' && tgtX > 0 && tgtY > 0) {
            if (tgtY > window.innerHeight) {
              window.scrollBy(0, tgtY - window.innerHeight / 2);
            }
            el = document.elementFromPoint(tgtX, Math.min(window.innerHeight - 20, Math.max(20, tgtY)));
          }
          if (!el && lbl) {
            const cleanLbl = lbl.trim().toLowerCase();
            const candidates = Array.from(document.querySelectorAll('button, a, label, input, [role="button"], [role="radio"], [role="checkbox"], .clickableCell, .fir-choice'));
            el = candidates.find(c => {
              const t = (c.innerText || c.textContent || c.value || c.getAttribute('aria-label') || '').trim().toLowerCase();
              return t === cleanLbl || (cleanLbl.length > 3 && t.includes(cleanLbl));
            }) || null;
          }

          if (el) {
            let r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0 || r.left < 0 || r.top < 0) {
              const labelEl = (el.id ? document.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null) || el.labels?.[0];
              const parent = labelEl || el.closest('.clickableCell, .fir-choice, label') || el.parentElement;
              if (parent) {
                const pr = parent.getBoundingClientRect();
                if (pr.width > 0 && pr.height > 0) {
                  el = parent;
                  r = pr;
                }
              }
            }
            el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
            r = el.getBoundingClientRect();
            return {
              x: r.left,
              y: r.top,
              w: r.width,
              h: r.height,
              tag: el.tagName,
              text: el.innerText ? el.innerText.slice(0, 50) : "",
              isCenter: false,
            };
          }
          return null;
        })()`,
        returnByValue: true,
      });

      const info = res?.result?.value;
      if (info && typeof info.x === "number" && typeof info.y === "number") {
        if (info.w === 0 && info.h === 0) {
          throw new Error(`Element has 0 dimensions: ${targetSelector || targetLabel || "target"}`);
        }
        targetBox = info;
      }
    } catch (err) {
      if (typeof target === "string") throw err;
    }
  }

  if (!targetBox) {
    if (typeof target === "string") {
      throw new Error(`Element not found for selector: ${target}`);
    } else if (target && typeof target.x === "number" && typeof target.y === "number") {
      targetBox = {
        x: target.x,
        y: target.y,
        w: typeof target.w === "number" ? target.w : 0,
        h: typeof target.h === "number" ? target.h : 0,
        isCenter: target.isCenter ?? (target.w > 0 && target.h > 0 && target.role !== undefined),
      };
    } else {
      throw new Error("Invalid target: must be a selector string or {x, y} coordinate object");
    }
  }

  const destPt = calculateJitter(targetBox, options.jitterFactor ?? 0.4);

  // For OOPIF (iframe) targets, Chrome does not route Input.dispatchMouseEvent.
  // Perform in-page click with React synthetic event fallback.
  if (options.isIframe) {
    const sel = typeof target === "string" ? target : target?.selector;
    return await send("Runtime.evaluate", {
      expression: `(() => {
        let el = ${sel ? `document.querySelector(${JSON.stringify(sel)})` : `null`};
        if (!el && ${JSON.stringify(destPt.x)} > 0) {
          el = document.elementFromPoint(${destPt.x}, ${destPt.y});
        }
        if (el) {
          if (el.disabled) {
            el.disabled = false;
            el.removeAttribute('disabled');
          }
          const k = Object.keys(el).find(x => x.startsWith('__reactProps') || x.startsWith('__reactEventHandlers'));
          if (k && el[k] && typeof el[k].onClick === 'function') {
            try { el[k].onClick({ target: el, currentTarget: el, persist: () => {}, preventDefault: () => {}, stopPropagation: () => {} }); } catch {}
          }
          el.click();
          return { clicked: true, tag: el.tagName };
        }
        return { clicked: false };
      })()`,
      returnByValue: true,
    });
  }

  // 1. Move along Bézier trajectory
  await stealthMove(send, destPt, options);

  // 2. Pre-click hover dwell
  const dwellMs = options.dwellMs ?? (35 + Math.floor(Math.random() * 30));
  if (dwellMs > 0) {
    await new Promise(r => setTimeout(r, dwellMs));
  }

  // 3. Mouse press (down)
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: destPt.x,
    y: destPt.y,
    button: options.button || "left",
    clickCount: options.clickCount || 1,
  });

  // 4. Button hold duration (30-45ms)
  const holdMs = options.holdMs ?? (30 + Math.floor(Math.random() * 15));
  if (holdMs > 0) {
    await new Promise(r => setTimeout(r, holdMs));
  }

  // 5. Mouse release (up)
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: destPt.x,
    y: destPt.y,
    button: options.button || "left",
    clickCount: options.clickCount || 1,
  });

  // 6. Post-click settle (25-40ms)
  const settleMs = options.settleMs ?? (25 + Math.floor(Math.random() * 15));
  if (settleMs > 0) {
    await new Promise(r => setTimeout(r, settleMs));
  }

  return { ok: true, x: destPt.x, y: destPt.y };
}

