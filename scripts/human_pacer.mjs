// scripts/human_pacer.mjs — Anti-flagging human reading and dwell pacing regulator

/**
 * Calculates estimated human reading time in milliseconds based on word count
 * and option choices.
 *
 * @param {string} questionText
 * @param {Array<string|Object>} [options=[]]
 * @param {Object} [optionsConfig={}]
 * @returns {number} reading duration in ms (clamped between minFloorMs and maxCapMs)
 */
export function calculateReadingTimeMs(questionText, options = [], optionsConfig = {}) {
  const {
    wpm = 220,
    msPerOption = 300,
    minFloorMs = 3500,
    maxCapMs = 15000,
  } = optionsConfig;

  const countWords = (str) => {
    if (!str || typeof str !== "string") return 0;
    const matches = str.trim().match(/\S+/g);
    return matches ? matches.length : 0;
  };

  const questionWords = countWords(questionText);
  let optionWords = 0;
  const opts = Array.isArray(options) ? options : [];
  for (const opt of opts) {
    const text = typeof opt === "string" ? opt : (opt?.label || opt?.text || opt?.value || "");
    optionWords += countWords(text);
  }

  const totalWords = questionWords + optionWords;
  const msPerWord = 60000 / wpm; // ~272.727ms per word at 220 WPM
  const rawReadingMs = Math.round(totalWords * msPerWord + opts.length * msPerOption);

  return Math.min(maxCapMs, Math.max(minFloorMs, rawReadingMs));
}

/**
 * Helper to generate an integer uniformly distributed in [min, max].
 */
function randomRange(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

/**
 * Generates an end-to-end pacing schedule with randomized human jitter
 * for interacting with a survey question and advancing.
 *
 * @param {string} questionText
 * @param {Array<string|Object>} [options=[]]
 * @param {Object} [config={}]
 * @returns {Object} pacing schedule breakdown and total dwell time
 */
export function getPacingSchedule(questionText, options = [], config = {}) {
  const {
    preClickMin = 1200,
    preClickMax = 2500,
    postClickMin = 800,
    postClickMax = 1800,
    preSubmitMin = 1500,
    preSubmitMax = 3000,
  } = config;

  const readingMs = calculateReadingTimeMs(questionText, options, config);
  const preClickDwellMs = randomRange(preClickMin, preClickMax);
  const postClickDwellMs = randomRange(postClickMin, postClickMax);
  const preSubmitDwellMs = randomRange(preSubmitMin, preSubmitMax);

  const totalDwellMs = readingMs + preClickDwellMs + postClickDwellMs + preSubmitDwellMs;

  return {
    readingMs,
    preClickDwellMs,
    postClickDwellMs,
    preSubmitDwellMs,
    totalDwellMs,
    // Aliases for interface flexibility
    hoverDwellMs: preClickDwellMs,
    selectionDwellMs: postClickDwellMs,
    preSubmitSettleMs: preSubmitDwellMs,
  };
}

/**
 * Promisified non-blocking delay.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Enforces that a page has met a minimum required dwell time since pageStartTime.
 * If elapsed >= minRequiredMs, returns immediately without sleeping.
 * If elapsed < minRequiredMs, awaits the remaining difference.
 *
 * @param {number} pageStartTime - Timestamp in ms (Date.now() or performance.now())
 * @param {number} minRequiredMs - Required duration in ms
 * @param {Function} [sleepFn=sleep] - Injectable sleep function for testing
 * @returns {Promise<{waited: boolean, elapsedMs: number, remainingMs: number}>}
 */
export async function enforcePageDwell(pageStartTime, minRequiredMs, sleepFn = sleep) {
  const elapsed = Date.now() - pageStartTime;
  if (elapsed >= minRequiredMs) {
    return {
      waited: false,
      elapsedMs: elapsed,
      remainingMs: 0,
    };
  }

  const remainingMs = minRequiredMs - elapsed;
  await sleepFn(remainingMs);
  return {
    waited: true,
    elapsedMs: elapsed + remainingMs,
    remainingMs,
  };
}