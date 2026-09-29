// scripts/system1_decision.mjs — System 1 Fast Decision Classifier
//
// Non-autoregressive heuristic decision engine for common survey primitives
// (Choice, Score, Noul) achieving sub-15ms decision latency based on the
// harmonized Mei Lin Chen persona.

export const MEI_LIN_CHEN_PERSONA = {
  name: "Eric Hong (Mei Lin Chen)",
  first_name: "Eric",
  last_name: "Hong",
  alias_name: "Mei Lin Chen",
  date_of_birth: {
    year: 1994,
    month: 4,
    month_name: "April",
    day: 10,
    formatted: "04/10/1994",
  },
  age: 32,
  gender: "Female",
  race: "Asian/Chinese (born in the US)",
  location: {
    city: "Columbus",
    state: "Ohio",
    zip: "43065",
    county: "Franklin / Delaware",
  },
  emails: {
    swagbucks: "erichong0410@gmail.com",
    surveyjunkie: "nupkill64@gmail.com",
  },
  marital_status: "Married",
  homeownership: "Homeowner (single-family home)",
  children: ["son, age 3"],
  education: "Doctorate (PhD)",
  occupation: {
    status: "Full-time employee",
    field: "Healthcare/Medical",
    role: "Manager-level decision-maker",
  },
  household_income: "$125,000–$149,999/year",
  politics: {
    registration: "Republican",
    leaning: "Somewhat conservative",
    voting: "Voted Trump 2016/2020/2024",
  },
  languages: [
    "English (very fluent)",
    "Chinese/Mandarin (spoken at home)",
  ],
  interests: [
    "Reading",
    "Watching TV",
    "Socializing with friends",
    "Dining out",
    "Exercise/Sports",
    "Travel",
  ],
  lottery: {
    habit: "Buys Ohio draw games and scratch-offs monthly",
    spend: "~$10 on draws + two $5 scratch-offs per month",
  },
  views: {
    data_center_oversight: "Supports",
    company_paid_utilities: "Supports",
    abortion: "Legal in most cases",
    religion: "Bible inspired but not literal; not particularly religious",
    firearms_at_home: "No",
    spanking: "Strongly against",
    neurological_conditions: "None",
  },
};

/**
 * Normalizes input options into a structured list of { index, label, lower, raw }.
 *
 * @param {Array<string|Object>} options
 * @returns {Array<{ index: number, label: string, lower: string, raw: any }>}
 */
function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  return options.map((opt, idx) => {
    let label = "";
    if (typeof opt === "string") {
      label = opt;
    } else if (opt && typeof opt === "object") {
      label = opt.label || opt.text || opt.value || "";
    }
    return {
      index: idx,
      raw: opt,
      label: label.trim(),
      lower: label.trim().toLowerCase(),
    };
  });
}

/**
 * Constructs a structured decision object that supports both object field access
 * and string comparison.
 */
function makeDecision(choice, index, confidence, reason, type = "choice") {
  return {
    choice,
    index,
    confidence,
    reason,
    type,
    toString() {
      return this.choice;
    },
    valueOf() {
      return this.choice;
    },
    [Symbol.toPrimitive](hint) {
      if (hint === "number") return this.index;
      return this.choice;
    },
  };
}

/**
 * Helper to parse income range or bounds from a label string.
 */
function parseIncomeRange(label) {
  const clean = label.replace(/[$,]/g, "").toLowerCase();
  const plusMatch = clean.match(/(\d+)\s*(?:\+|and\s*more|or\s*more|and\s*above|over)/);
  if (plusMatch) {
    let min = parseInt(plusMatch[1], 10);
    if (min < 1000) min *= 1000;
    return { min, max: Infinity, width: Infinity };
  }

  const underMatch = clean.match(/(?:under|less\s*than|below)\s*(\d+)/);
  if (underMatch) {
    let max = parseInt(underMatch[1], 10);
    if (max < 1000) max *= 1000;
    return { min: 0, max, width: max };
  }

  const rangeMatch = clean.match(/(\d+)\s*(?:[-–—]|to)\s*(\d+)/);
  if (rangeMatch) {
    let min = parseInt(rangeMatch[1], 10);
    let max = parseInt(rangeMatch[2], 10);
    if (min < 1000) min *= 1000;
    if (max < 1000) max *= 1000;
    return { min, max, width: max - min };
  }

  const kRange = clean.match(/(\d+)k\s*(?:[-–—]|to)\s*(\d+)k/);
  if (kRange) {
    const min = parseInt(kRange[1], 10) * 1000;
    const max = parseInt(kRange[2], 10) * 1000;
    return { min, max, width: max - min };
  }

  return null;
}

/**
 * Decides standard demographic and categorical multi-choice questions.
 *
 * @param {string} questionText
 * @param {Array<string|Object>} options
 * @param {Object} [persona=MEI_LIN_CHEN_PERSONA]
 * @returns {Object|null}
 */
export function decideChoice(questionText, options, persona = MEI_LIN_CHEN_PERSONA) {
  const normOpts = normalizeOptions(options);
  if (normOpts.length === 0) return null;

  const q = (questionText || "").trim();
  const qLower = q.toLowerCase();

  // 1. GENDER
  const isGenderQ = /\b(gender|sex\b|identify\s*as)\b/i.test(qLower);
  const hasMaleOpt = normOpts.some((o) => /^(male|man)$/i.test(o.label));
  const hasFemaleOpt = normOpts.some((o) => /^(female|woman)$/i.test(o.label));

  if (isGenderQ || (hasMaleOpt && hasFemaleOpt)) {
    const targetGender = persona.gender || "Female";
    const found = normOpts.find((o) =>
      new RegExp(`^${targetGender}$`, "i").test(o.label) ||
      /\bfemale\b/i.test(o.label) ||
      /^woman$/i.test(o.label)
    );
    if (found) {
      return makeDecision(found.label, found.index, 0.98, `Matched gender: ${found.label}`, "choice");
    }
  }

  // 2. AGE & BIRTH YEAR
  const isBirthYearQ = /\b(birth\s*year|year\s*(?:of\s*)?birth|year.*born|born\s*in)\b/i.test(qLower);
  const allYearOpts = normOpts.filter((o) => /^\b(19\d\d|20\d\d)\b/.test(o.label));

  if (isBirthYearQ || (allYearOpts.length >= 2 && allYearOpts.length === normOpts.length)) {
    const targetYear = persona.date_of_birth?.year || 1994;
    const exact = normOpts.find((o) => o.label.includes(String(targetYear)));
    if (exact) {
      return makeDecision(exact.label, exact.index, 0.98, `Matched birth year: ${exact.label}`, "choice");
    }
    const rangeOpt = normOpts.find((o) => {
      const match = o.label.match(/(\d{4})\s*(?:[-–—]|to)\s*(\d{4})/);
      if (match) {
        const min = parseInt(match[1], 10);
        const max = parseInt(match[2], 10);
        return min <= targetYear && targetYear <= max;
      }
      return false;
    });
    if (rangeOpt) {
      return makeDecision(rangeOpt.label, rangeOpt.index, 0.94, `Matched birth year range: ${rangeOpt.label}`, "choice");
    }
  }

  const isAgeQ = /\b(age\b|how old)\b/i.test(qLower);
  const allNumericAgeOpts = normOpts.filter((o) => /^\d{1,2}$/.test(o.label));

  if (isAgeQ || allNumericAgeOpts.length >= 2) {
    const targetAge = persona.age || 32;
    const exact = normOpts.find((o) =>
      new RegExp(`^0?${targetAge}$|^${targetAge}\\s*(years?|years?\\s*old)?$`, "i").test(o.label)
    );
    if (exact) {
      return makeDecision(exact.label, exact.index, 0.98, `Matched age: ${exact.label}`, "choice");
    }

    const rangeOpt = normOpts.find((o) => {
      const match = o.label.match(/\b(\d{1,2})\s*(?:[-–—]|to)\s*(\d{1,2})\b/);
      if (match) {
        const min = parseInt(match[1], 10);
        const max = parseInt(match[2], 10);
        return min <= targetAge && targetAge <= max;
      }
      return false;
    });
    if (rangeOpt) {
      return makeDecision(rangeOpt.label, rangeOpt.index, 0.94, `Matched age range: ${rangeOpt.label}`, "choice");
    }
  }

  // 3. STATE / CITY / ZIP
  const isStateQ = /\b(state|province|which state)\b/i.test(qLower);
  const targetState = persona.location?.state || "Ohio";
  const stateFound = normOpts.find((o) =>
    new RegExp(`^${targetState}$`, "i").test(o.label) ||
    new RegExp(`\\b${targetState}\\b`, "i").test(o.label) ||
    /^oh$/i.test(o.label)
  );
  if (isStateQ && stateFound) {
    return makeDecision(stateFound.label, stateFound.index, 0.98, `Matched state: ${stateFound.label}`, "choice");
  }

  const isCityQ = /\b(city|town|municipality)\b/i.test(qLower);
  const targetCity = persona.location?.city || "Columbus";
  const cityFound = normOpts.find((o) =>
    new RegExp(`^${targetCity}$`, "i").test(o.label) ||
    new RegExp(`\\b${targetCity}\\b`, "i").test(o.label)
  );
  if ((isCityQ || cityFound) && cityFound) {
    return makeDecision(cityFound.label, cityFound.index, 0.98, `Matched city: ${cityFound.label}`, "choice");
  }

  const isZipQ = /\b(zip|postal\s*code)\b/i.test(qLower);
  const targetZip = persona.location?.zip || "43065";
  const zipFound = normOpts.find((o) => o.label.includes(targetZip));
  if ((isZipQ || zipFound) && zipFound) {
    return makeDecision(zipFound.label, zipFound.index, 0.98, `Matched ZIP: ${zipFound.label}`, "choice");
  }

  if (!isStateQ && stateFound && normOpts.some((o) => /california|texas|florida|new york/i.test(o.label))) {
    return makeDecision(stateFound.label, stateFound.index, 0.98, `Matched state: ${stateFound.label}`, "choice");
  }

  // 4. ETHNICITY / RACE
  const isEthQ = /\b(race|ethnicity|ethnic|background|heritage|ancestry|origin)\b/i.test(qLower);
  const hasEthOpts = normOpts.some((o) => /asian|caucasian|hispanic|african|chinese|japanese/i.test(o.label));

  if (isEthQ || hasEthOpts) {
    // Priority order: Chinese -> Asian/Pacific Islander -> Asian American / Asian
    const chinese = normOpts.find((o) => /\bchinese\b/i.test(o.label));
    if (chinese) {
      return makeDecision(chinese.label, chinese.index, 0.98, `Matched ethnicity: ${chinese.label}`, "choice");
    }

    const asianPi = normOpts.find((o) => /asian\s*\/?\s*pacific\s*islander/i.test(o.label));
    if (asianPi) {
      return makeDecision(asianPi.label, asianPi.index, 0.96, `Matched ethnicity: ${asianPi.label}`, "choice");
    }

    const asian = normOpts.find((o) => /\basian\b/i.test(o.label));
    if (asian) {
      return makeDecision(asian.label, asian.index, 0.95, `Matched ethnicity: ${asian.label}`, "choice");
    }
  }

  // 5. EDUCATION
  const isEduQ = /\b(education|highest level|degree|schooling|highest grade)\b/i.test(qLower);
  const hasEduOpts = normOpts.some((o) => /bachelor|master|doctorate|ph\.?d|high school/i.test(o.label));

  if (isEduQ || hasEduOpts) {
    // Priority: Doctorate/PhD -> Graduate/Professional -> Master's
    const doctorate = normOpts.find((o) => /doctorate|doctoral|\bph\.?d\b/i.test(o.label));
    if (doctorate) {
      return makeDecision(doctorate.label, doctorate.index, 0.98, `Matched education: ${doctorate.label}`, "choice");
    }

    const gradProf = normOpts.find((o) =>
      /graduate\s*(?:\/|\s*and\s*|\s*or\s*)\s*professional|post-graduate|advanced degree/i.test(o.label)
    );
    if (gradProf) {
      return makeDecision(gradProf.label, gradProf.index, 0.95, `Matched education: ${gradProf.label}`, "choice");
    }
  }

  // 6. EMPLOYMENT
  const isEmpQ = /\b(employment|work status|currently employed|occupational|work situation)\b/i.test(qLower);
  const hasEmpOpts = normOpts.some((o) => /full-time|part-time|unemployed|retired/i.test(o.label));

  if (isEmpQ || hasEmpOpts) {
    const fullTime = normOpts.find((o) =>
      /employed\s*full-time|full-time\s*employee|^full-time$|working\s*full-time|35\+\s*hours/i.test(o.label)
    );
    if (fullTime) {
      return makeDecision(fullTime.label, fullTime.index, 0.96, `Matched employment: ${fullTime.label}`, "choice");
    }
  }

  // 7. MARITAL STATUS
  const isMarQ = /\b(marital|relationship status|are you married)\b/i.test(qLower);
  const hasMarOpts = normOpts.some((o) => /single|married|divorced|widowed/i.test(o.label));

  if (isMarQ || hasMarOpts) {
    const married = normOpts.find((o) => /^married$|currently married|married or domestic/i.test(o.label));
    if (married) {
      return makeDecision(married.label, married.index, 0.98, `Matched marital status: ${married.label}`, "choice");
    }
  }

  // 8. HOUSEHOLD INCOME
  const isIncQ = /\b(income|salary|earnings|household)\b/i.test(qLower);
  const hasIncOpts = normOpts.some((o) => parseIncomeRange(o.label) !== null);

  if (isIncQ || hasIncOpts) {
    const targetIncome = 135000; // Persona is $125,000–$149,999

    // Check for exact matching brackets
    const exact125k = normOpts.find((o) =>
      /\$125,?000\s*(?:–|-|to)\s*\$149,?999/i.test(o.label) ||
      /\$125k\s*-\s*\$150k/i.test(o.label)
    );
    if (exact125k) {
      return makeDecision(exact125k.label, exact125k.index, 0.98, `Matched income bracket: ${exact125k.label}`, "choice");
    }

    // Match ranges encompassing targetIncome, selecting the tightest (smallest width)
    const matchingRanges = [];
    for (const opt of normOpts) {
      const parsed = parseIncomeRange(opt.label);
      if (parsed && parsed.min <= targetIncome && targetIncome <= parsed.max) {
        matchingRanges.push({ opt, parsed });
      }
    }

    if (matchingRanges.length > 0) {
      matchingRanges.sort((a, b) => a.parsed.width - b.parsed.width);
      const best = matchingRanges[0].opt;
      return makeDecision(best.label, best.index, 0.95, `Matched income range: ${best.label}`, "choice");
    }
  }

  return null;
}

/**
 * Decides binary / boolean questions (Yes/No, Own/Rent, etc.).
 *
 * @param {string} questionText
 * @param {Array<string|Object>} options
 * @param {Object} [persona=MEI_LIN_CHEN_PERSONA]
 * @returns {Object|null}
 */
export function decideNoul(questionText, options, persona = MEI_LIN_CHEN_PERSONA) {
  const normOpts = normalizeOptions(options);
  if (normOpts.length === 0) return null;

  const q = (questionText || "").trim();
  const qLower = q.toLowerCase();

  // 1. Hispanic / Latino origin
  if (/\b(hispanic|latino|spanish origin)\b/i.test(qLower)) {
    const noOpt = normOpts.find((o) => /^no\b|not\s*(of\s*)?hispanic/i.test(o.label));
    if (noOpt) {
      return makeDecision(noOpt.label, noOpt.index, 0.98, "Not Hispanic or Latino origin", "noul");
    }
  }

  // 2. Homeownership (Own vs Rent)
  const isOwnRentQ = /\b(own or rent|homeowner|homeownership|own.*home)\b/i.test(qLower);
  const hasOwnOpt = normOpts.some((o) => /^own\b|homeowner/i.test(o.label));
  const hasRentOpt = normOpts.some((o) => /^rent\b|renter/i.test(o.label));

  if (isOwnRentQ || (hasOwnOpt && hasRentOpt)) {
    const ownOpt = normOpts.find((o) => /^own\b|homeowner/i.test(o.label));
    if (ownOpt) {
      return makeDecision(ownOpt.label, ownOpt.index, 0.98, "Homeowner (Owns home)", "noul");
    }
  }

  // 3. Primary decision maker
  if (/\b(primary|decision maker|financial decision)\b/i.test(qLower)) {
    const yesOpt = normOpts.find((o) => /^yes\b|primary|sole/i.test(o.label));
    if (yesOpt) {
      return makeDecision(yesOpt.label, yesOpt.index, 0.96, "Primary financial decision maker: Yes", "noul");
    }
  }

  // 4. Children under 18
  if (/\b(child|children|under 18|dependents)\b/i.test(qLower)) {
    const yesOpt = normOpts.find((o) => /^yes\b/i.test(o.label));
    if (yesOpt) {
      return makeDecision(yesOpt.label, yesOpt.index, 0.96, "Has children under 18: Yes (son, age 3)", "noul");
    }
  }

  // 5. Firearms at home
  if (/\b(firearms?|guns?)\b/i.test(qLower)) {
    const noOpt = normOpts.find((o) => /^no\b/i.test(o.label));
    if (noOpt) {
      return makeDecision(noOpt.label, noOpt.index, 0.96, "Firearms in household: No", "noul");
    }
  }

  // 6. Neurological conditions
  if (/\b(neurological|adhd|autism|bipolar)\b/i.test(qLower)) {
    const noOpt = normOpts.find((o) => /^no\b|none/i.test(o.label));
    if (noOpt) {
      return makeDecision(noOpt.label, noOpt.index, 0.96, "Neurological conditions: None", "noul");
    }
  }

  // 7. Voter registration
  if (/\b(registered to vote|registered voter)\b/i.test(qLower)) {
    const yesOpt = normOpts.find((o) => /^yes\b/i.test(o.label));
    if (yesOpt) {
      return makeDecision(yesOpt.label, yesOpt.index, 0.96, "Registered to vote: Yes (Republican)", "noul");
    }
  }

  // 8. US residence check
  if (/\b(live in the united states|reside in the united states|united states resident|live in the us|resident of the us)\b/i.test(qLower)) {
    const yesOpt = normOpts.find((o) => /^yes$/i.test(o.label));
    if (yesOpt) {
      return makeDecision(yesOpt.label, yesOpt.index, 0.99, "Resides in the United States: Yes (Columbus, OH)", "noul");
    }
  }

  // 9. General binary Yes/No
  const yesOpt = normOpts.find((o) => /^yes$/i.test(o.label));
  const noOpt = normOpts.find((o) => /^no$/i.test(o.label));
  if (yesOpt && noOpt && normOpts.length <= 3) {
    if (/\b(oppose data center|against data center)\b/i.test(qLower)) {
      return makeDecision(noOpt.label, noOpt.index, 0.92, "Oppose data center: No (supports oversight)", "noul");
    }
    // Default positive qualification
    return makeDecision(yesOpt.label, yesOpt.index, 0.88, "Default binary qualification: Yes", "noul");
  }

  return null;
}

/**
 * Decides Likert and rating scale questions aligning with persona sentiment.
 *
 * @param {string} questionText
 * @param {Array<string|Object>} options
 * @param {Object} [persona=MEI_LIN_CHEN_PERSONA]
 * @returns {Object|null}
 */
export function decideScore(questionText, options, persona = MEI_LIN_CHEN_PERSONA) {
  const normOpts = normalizeOptions(options);
  if (normOpts.length < 3) return null;

  const q = (questionText || "").trim();
  const qLower = q.toLowerCase();

  // Detect numeric Likert scales (e.g. 1..5, 1..7)
  const isAllNumeric = normOpts.every((o) => /^\d{1,2}$/.test(o.label));
  const hasLikertTerms = normOpts.some((o) =>
    /agree|disagree|satisfied|dissatisfied|likely|unlikely|poor|excellent/i.test(o.label)
  );

  if (!isAllNumeric && !hasLikertTerms) return null;

  // Determine sentiment target:
  // -1: Strongly Negative / Disagree / Low rating
  // +1: Strongly Positive / Strongly Agree / High rating
  // +0.7: Favorable / Moderate Positive (e.g. 4/5 or 5-6/7 or Satisfied)
  let sentiment = 0.7; // default favorable rating for surveys
  let reason = "Default favorable survey response";

  if (/\b(spank\w*|physical punishment)\b/i.test(qLower)) {
    sentiment = -1;
    reason = "Persona is strongly against spanking";
  } else if (/\b(data\s*centers?.*oversight|environmental oversight)\b/i.test(qLower)) {
    sentiment = 1;
    reason = "Persona supports data center oversight";
  } else if (/\b(company-paid utilities|utilities paid by company)\b/i.test(qLower)) {
    sentiment = 1;
    reason = "Persona supports company-paid utilities";
  }

  // Handle all-numeric scale: 1..N
  if (isAllNumeric) {
    const N = normOpts.length;
    let targetIndex;
    if (sentiment === -1) {
      targetIndex = 0; // lowest rating (1)
    } else if (sentiment === 1) {
      targetIndex = N - 1; // highest rating
    } else {
      // favorable (e.g. 4 on 5, 5 or 6 on 7)
      targetIndex = Math.min(N - 1, Math.max(0, Math.floor(N * 0.75)));
    }
    const chosen = normOpts[targetIndex];
    return makeDecision(chosen.label, chosen.index, 0.90, `${reason} (numeric score: ${chosen.label})`, "score");
  }

  // Handle word-based Likert scale
  if (sentiment === -1) {
    const stronglyDisagree = normOpts.find((o) =>
      /strongly\s*disagree|strongly\s*oppose|very\s*dissatisfied|very\s*unlikely/i.test(o.label)
    );
    if (stronglyDisagree) {
      return makeDecision(stronglyDisagree.label, stronglyDisagree.index, 0.96, reason, "score");
    }
    const disagree = normOpts.find((o) => /disagree|dissatisfied/i.test(o.label));
    if (disagree) {
      return makeDecision(disagree.label, disagree.index, 0.92, reason, "score");
    }
  } else if (sentiment === 1) {
    const stronglyAgree = normOpts.find((o) =>
      /strongly\s*agree|strongly\s*support|completely\s*agree/i.test(o.label)
    );
    if (stronglyAgree) {
      return makeDecision(stronglyAgree.label, stronglyAgree.index, 0.96, reason, "score");
    }
    const agree = normOpts.find((o) => /^agree$|somewhat\s*agree/i.test(o.label));
    if (agree) {
      return makeDecision(agree.label, agree.index, 0.92, reason, "score");
    }
  } else {
    // Favorable sentiment: Satisfied, Agree, Likely
    const satisfied = normOpts.find((o) =>
      /^4\s*-\s*satisfied|^satisfied$|somewhat\s*satisfied|^agree$|somewhat\s*agree|^likely$/i.test(o.label)
    );
    if (satisfied) {
      return makeDecision(satisfied.label, satisfied.index, 0.92, reason, "score");
    }
    const verySatisfied = normOpts.find((o) =>
      /very\s*satisfied|strongly\s*agree|very\s*likely|excellent/i.test(o.label)
    );
    if (verySatisfied) {
      return makeDecision(verySatisfied.label, verySatisfied.index, 0.88, reason, "score");
    }
  }

  // Fallback to proportional index
  const fallbackIndex = sentiment < 0 ? 0 : Math.min(normOpts.length - 1, Math.floor(normOpts.length * 0.75));
  const fallback = normOpts[fallbackIndex];
  return makeDecision(fallback.label, fallback.index, 0.86, `${reason} (fallback)`, "score");
}

/**
 * Evaluates harvested page controls to determine if System 1 fast-path can resolve
 * the current survey step autonomously with high confidence.
 *
 * @param {Object|Array} harvested - Harvested controls object or controls array
 * @param {Object} [persona=MEI_LIN_CHEN_PERSONA]
 * @returns {{
 *   canHandle: boolean,
 *   type?: "choice"|"score"|"noul",
 *   targetControl?: Object,
 *   confidence?: number,
 *   reason?: string
 * }}
 */
export function evaluateControls(harvested, persona = MEI_LIN_CHEN_PERSONA) {
  if (!harvested) return { canHandle: false };

  let controls = [];
  let questionText = "";

  if (Array.isArray(harvested)) {
    controls = harvested;
  } else if (typeof harvested === "object") {
    controls = harvested.controls || [];
    questionText = harvested.question || harvested.questionText || "";
  }

  if (!Array.isArray(controls) || controls.length === 0) {
    return { canHandle: false };
  }

  // Check for open-ended text areas requiring System 2
  const hasTextArea = controls.some((c) => {
    const isTextArea = c.tag === "textarea" || (c.role === "textbox" && c.tag === "textarea");
    return isTextArea && !c.isSubmitOrNext;
  });

  if (hasTextArea) {
    return { canHandle: false, reason: "needs_system2" };
  }

  // Handle confirmation/consent checkboxes (e.g. "I confirm", "I agree", "I accept")
  const confirmCheckbox = controls.find((c) =>
    (c.role === "checkbox" || c.type === "checkbox") &&
    !c.isSubmitOrNext &&
    /\b(confirm|agree|accept|consent|acknowledge|certif|understand|read and)\b/i.test(c.label || "")
  );
  if (confirmCheckbox) {
    return {
      canHandle: true,
      type: "confirm_checkbox",
      targetControl: confirmCheckbox,
      confidence: 0.99,
      reason: "Consent/confirmation checkbox auto-checked",
    };
  }

  // Filter for actionable option controls (radios, checkboxes, select options)
  const actionable = controls.filter(
    (c) =>
      !c.isSubmitOrNext &&
      (c.role === "radio" || c.type === "radio" || c.role === "checkbox" || c.type === "checkbox" || c.role === "option")
  );

  if (actionable.length === 0) {
    const textControl = controls.find((c) => (c.role === "textbox" || c.tag === "input") && !c.isSubmitOrNext);
    if (textControl) {
      const qLower = (questionText || "").toLowerCase();
      let textValue = null;
      let reason = null;
      if (/\b(zip|postal\s*code)\b/i.test(qLower)) {
        textValue = persona.location?.zip || "43065";
        reason = "Matched ZIP code demographic";
      } else if (/\b(birth\s*year|year\s*(?:of\s*)?birth|year.*born|born\s*in)\b/i.test(qLower)) {
        textValue = String(persona.date_of_birth?.year || 1994);
        reason = "Matched birth year demographic";
      } else if (/\b(age|how old)\b/i.test(qLower)) {
        textValue = String(persona.age || 32);
        reason = "Matched age demographic";
      }
      if (textValue) {
        return {
          canHandle: true,
          type: "text",
          textValue,
          targetControl: textControl,
          confidence: 0.98,
          reason,
        };
      }
      return { canHandle: false, reason: "needs_system2" };
    }
    return { canHandle: false };
  }

  // If questionText is not provided, check if controls share an aria-describedby or fieldset legend
  const inferredQuestion = questionText || "";

  // 1. Check Score / Likert
  const scoreDecision = decideScore(inferredQuestion, actionable, persona);
  if (scoreDecision && scoreDecision.confidence >= 0.85) {
    return {
      canHandle: true,
      type: "score",
      targetControl: actionable[scoreDecision.index],
      confidence: scoreDecision.confidence,
      reason: scoreDecision.reason,
    };
  }

  // 2. Check Binary / Noul
  const noulDecision = decideNoul(inferredQuestion, actionable, persona);
  if (noulDecision && noulDecision.confidence >= 0.85) {
    return {
      canHandle: true,
      type: "noul",
      targetControl: actionable[noulDecision.index],
      confidence: noulDecision.confidence,
      reason: noulDecision.reason,
    };
  }

  // 3. Check Multi-choice / Categorical
  const choiceDecision = decideChoice(inferredQuestion, actionable, persona);
  if (choiceDecision && choiceDecision.confidence >= 0.85) {
    return {
      canHandle: true,
      type: "choice",
      targetControl: actionable[choiceDecision.index],
      confidence: choiceDecision.confidence,
      reason: choiceDecision.reason,
    };
  }

  return { canHandle: false, reason: "needs_system2" };
}


// ---------- Neural Laya (Unsloth Studio /v1/systemone) Integration ----------

/**
 * Formats persona into a compact state string for Laya encoder context.
 *
 * @param {Object} [persona=MEI_LIN_CHEN_PERSONA]
 * @returns {string}
 */
export function formatPersonaState(persona = MEI_LIN_CHEN_PERSONA) {
  const p = persona || MEI_LIN_CHEN_PERSONA;
  const childStr = Array.isArray(p.children) ? p.children.join("; ") : (p.children || "none");
  return `Respondent profile: Name: ${p.name || p.alias_name}. Age: ${p.age}. Gender: ${p.gender}. Race: ${p.race}. Location: ${p.location?.city || "Columbus"}, ${p.location?.state || "Ohio"} ${p.location?.zip || "43065"}. Marital Status: ${p.marital_status}. Children: ${childStr}. Education: ${p.education}. Occupation: ${p.occupation?.status}, ${p.occupation?.field}, ${p.occupation?.role}. Household Income: ${p.household_income}. Politics: ${p.politics?.registration}, ${p.politics?.leaning}. Homeownership: ${p.homeownership}. Views: Spanking (${p.views?.spanking || "against"}), Data centers (${p.views?.data_center_oversight || "supports"}), Firearms (${p.views?.firearms_at_home || "none"}).`;
}

/**
 * Queries Unsloth Studio /v1/systemone endpoint running Laya.
 *
 * @param {string} state - Context/state description
 * @param {Object} questions - Mapping of question_id -> QuestionIn
 * @param {Object} [options={}] - Config overrides (endpoint, apiKey, model, timeoutMs)
 * @returns {Promise<Object>}
 */
export function normalizeUnslothModel(model) {
  if (!model) return "ukisai/Swift-1.5-Qwen3.8-27B-GSQ-RCO-GGUF";
  const m = String(model).trim();
  if (/swift.*qwen/i.test(m) || m.toLowerCase() === "swift") {
    return "ukisai/Swift-1.5-Qwen3.8-27B-GSQ-RCO-GGUF";
  }
  return m;
}

export async function queryUnslothSystemOne(state, questions, options = {}) {
  const baseUrl = options.baseUrl || process.env.UNSLOTH_STUDIO_BASE_URL || "http://tank.tail576f3e.ts.net:8888";
  const apiKey = options.apiKey || process.env.UNSLOTH_STUDIO_API_KEY || "sk-unsloth-3806b3388ca2c8f925f8a2a7aeb78445";
  const systemOneModel = options.systemOneModel || process.env.UNSLOTH_SYSTEMONE_MODEL || "laya-english";
  const chatModel = normalizeUnslothModel(options.chatModel || options.model || process.env.UNSLOTH_CHAT_MODEL || "ukisai/Swift-1.5-Qwen3.8-27B-GSQ-RCO-GGUF");
  const timeoutMs = options.timeoutMs ?? 15000;

  // Try /v1/systemone (Laya ~100ms ultra-fast classifier) first
  const systemOneUrl = options.endpoint || `${baseUrl}/v1/systemone`;
  try {
    const res = await fetch(systemOneUrl, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: systemOneModel, state, questions }),
      signal: AbortSignal.timeout(Math.min(timeoutMs, 4000)),
    });
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    // Fall through to chat completions fallback
  }

  // Fallback: use /v1/chat/completions with ukisai/Swift-Qwen3.8-27b
  const questionKey = Object.keys(questions)[0] || "q";
  const q = questions[questionKey];
  const optionLabels = Object.keys(q.criteria || {});
  const numberedOptions = optionLabels.map((lbl, i) => `${i + 1}. ${lbl}`).join("\n");

  const systemPrompt = `You are a survey respondent. Given the profile below, answer the question by selecting the BEST matching option number. Reply with ONLY the option number (e.g. "3"), nothing else. No explanation.\n\nProfile: ${state}`;
  const userPrompt = `Question: ${q.instructions || "Select the best option."}\n\nOptions:\n${numberedOptions}\n\nReply with ONLY the number of the best option.`;

  const chatRes = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: chatModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 350,
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!chatRes.ok) {
    const errorText = await chatRes.text().catch(() => "");
    throw new Error(`Chat completions HTTP ${chatRes.status}: ${errorText}`);
  }

  const chatData = await chatRes.json();
  const msg = chatData.choices?.[0]?.message || {};
  let rawContent = (msg.content || "").trim();
  let chosenIdx = -1;

  if (rawContent) {
    const numMatch = rawContent.match(/\b(\d+)\b/);
    if (numMatch) {
      chosenIdx = parseInt(numMatch[1], 10) - 1;
    } else {
      const lower = rawContent.toLowerCase();
      chosenIdx = optionLabels.findIndex(l => lower.includes(l.toLowerCase()) || l.toLowerCase().includes(lower));
    }
  }

  if (chosenIdx < 0 && msg.reasoning_content) {
    const rc = msg.reasoning_content;
    const matchEnd = rc.match(/(?:output|choose|select|pick|answer|option)\s*[:=]?\s*(\d+)/i) || rc.match(/\b(\d+)\b[^\d]*$/);
    if (matchEnd) {
      chosenIdx = parseInt(matchEnd[1], 10) - 1;
    }
  }

  if (chosenIdx < 0 || chosenIdx >= optionLabels.length) {
    throw new Error(`Chat response did not map to valid option: "${rawContent || msg.reasoning_content?.slice(0, 100)}"`);
  }

  return {
    model: chatData.model || chatModel,
    answers: {
      [questionKey]: {
        type: "choice",
        choice: optionLabels[chosenIdx],
        confidence: 0.85,
        probabilities: {
          [optionLabels[chosenIdx]]: 0.85,
        },
      },
    },
  };
}

/**
 * Evaluates candidate controls using the live Laya neural model served by Unsloth Studio.
 */
export async function evaluateControlsNeural(harvested, persona = MEI_LIN_CHEN_PERSONA, options = {}) {
  const controls = Array.isArray(harvested) ? harvested : harvested?.controls || [];
  const questionText = typeof harvested?.question === "string" ? harvested.question : (options.questionText || "");

  if (!controls || controls.length === 0) return { canHandle: false };

  // Filter for actionable option controls
  const actionable = controls.filter(
    (c) =>
      !c.isSubmitOrNext &&
      (c.role === "radio" || c.type === "radio" || c.role === "option" || c.role === "checkbox" || c.type === "checkbox")
  );

  if (actionable.length === 0) return { canHandle: false };

  // Freeform unhandled textareas (open-ended essay questions) still require System 2
  const hasTextArea = controls.some((c) => {
    const isTextArea = c.tag === "textarea" || (c.role === "textbox" && c.tag === "textarea");
    return isTextArea && !c.isSubmitOrNext;
  });
  if (hasTextArea) return { canHandle: false, reason: "needs_system2" };

  try {
    const state = formatPersonaState(persona);
    const criteriaObj = {};
    for (const c of actionable) {
      const lbl = (c.label || c.value || "Option").trim();
      criteriaObj[lbl] = lbl;
    }

    const payloadQuestions = {
      survey_question: {
        type: "choice",
        instructions: questionText || "Select the best option matching the respondent profile.",
        criteria: criteriaObj,
      },
    };

    const fetchFn = options.fetchFn || queryUnslothSystemOne;
    const result = await fetchFn(state, payloadQuestions, options);
    const answer = result?.answers?.survey_question;
    if (!answer || answer.type !== "choice" || !answer.choice) {
      return { canHandle: false, reason: "laya_no_choice" };
    }

    // Match chosen label back to actionable control
    const chosenIndex = actionable.findIndex(
      (c) => (c.label || c.value || "").trim() === answer.choice.trim()
    );

    if (chosenIndex === -1) {
      return { canHandle: false, reason: "laya_unmatched_choice" };
    }

    const choiceProb = answer.probabilities?.[answer.choice] ?? answer.confidence ?? 0.85;
    const minProb = options.minProbability ?? Math.max(0.25, 1.1 / actionable.length);
    if (choiceProb < minProb) {
      return { canHandle: false, reason: "laya_low_confidence", probability: choiceProb };
    }

    return {
      canHandle: true,
      type: "choice",
      targetControl: actionable[chosenIndex],
      confidence: choiceProb,
      reason: `unsloth_laya_neural (model: ${result.model || "laya"})`,
      raw: answer,
    };
  } catch (err) {
    return { canHandle: false, reason: `laya_error: ${err.message || String(err)}` };
  }
}
