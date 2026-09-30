// tests/test_system1_decision.mjs — System 1 Fast Decision Classifier Unit Tests
import assert from "node:assert/strict";
import {
  MEI_LIN_CHEN_PERSONA,
  decideChoice,
  decideNoul,
  decideScore,
  evaluateControls,
} from "../scripts/system1_decision.mjs";

console.log("[test] 1. MEI_LIN_CHEN_PERSONA dictionary matches personas/mei_lin_chen.yaml");
{
  assert.equal(MEI_LIN_CHEN_PERSONA.gender, "Female");
  assert.equal(MEI_LIN_CHEN_PERSONA.age, 32);
  assert.equal(MEI_LIN_CHEN_PERSONA.date_of_birth.year, 1994);
  assert.equal(MEI_LIN_CHEN_PERSONA.location.state, "Ohio");
  assert.equal(MEI_LIN_CHEN_PERSONA.location.city, "Columbus");
  assert.equal(MEI_LIN_CHEN_PERSONA.location.zip, "43065");
  assert.ok(MEI_LIN_CHEN_PERSONA.education.includes("Doctorate"));
  assert.ok(MEI_LIN_CHEN_PERSONA.occupation.status.includes("Full-time"));
  assert.equal(MEI_LIN_CHEN_PERSONA.marital_status, "Married");
  assert.ok(MEI_LIN_CHEN_PERSONA.household_income.includes("125,000"));
}

console.log("[test] 2. decideChoice selects correct demographic options");
{
  // Gender
  const genderRes = decideChoice("What is your gender?", ["Male", "Female", "Prefer not to say"]);
  assert.equal(genderRes?.choice, "Female");
  assert.equal(genderRes?.index, 1);
  assert.ok(genderRes?.confidence >= 0.85);

  // Age (explicit age)
  const ageRes = decideChoice("What is your current age?", ["30", "31", "32", "33", "34"]);
  assert.equal(ageRes?.choice, "32");
  assert.equal(ageRes?.index, 2);

  // Age (birth year)
  const birthYearRes = decideChoice("What year were you born?", ["1992", "1993", "1994", "1995"]);
  assert.equal(birthYearRes?.choice, "1994");
  assert.equal(birthYearRes?.index, 2);

  // State
  const stateRes = decideChoice("Which state do you reside in?", ["California", "New York", "Ohio", "Texas"]);
  assert.equal(stateRes?.choice, "Ohio");
  assert.equal(stateRes?.index, 2);

  // City
  const cityRes = decideChoice("What city do you live in?", ["Cleveland", "Cincinnati", "Columbus"]);
  assert.equal(cityRes?.choice, "Columbus");
  assert.equal(cityRes?.index, 2);

  // Zip
  const zipRes = decideChoice("Please select your ZIP code", ["43016", "43065", "43210"]);
  assert.equal(zipRes?.choice, "43065");
  assert.equal(zipRes?.index, 1);

  // Ethnicity (Asian / Asian Pacific Islander / Chinese)
  const ethRes1 = decideChoice("What is your race or ethnicity?", ["White", "Black", "Asian", "Other"]);
  assert.equal(ethRes1?.choice, "Asian");

  const ethRes2 = decideChoice("Select your ethnic background", [
    "Caucasian",
    "Hispanic / Latino",
    "Asian / Pacific Islander",
    "African American",
  ]);
  assert.equal(ethRes2?.choice, "Asian / Pacific Islander");

  const ethRes3 = decideChoice("What is your ancestry?", ["Japanese", "Korean", "Chinese", "Vietnamese"]);
  assert.equal(ethRes3?.choice, "Chinese");

  // Education (Doctorate / PhD / Graduate/Professional)
  const eduRes1 = decideChoice("What is the highest level of education you have completed?", [
    "High school diploma",
    "Bachelor's degree",
    "Master's degree",
    "Doctorate (PhD)",
  ]);
  assert.equal(eduRes1?.choice, "Doctorate (PhD)");

  const eduRes2 = decideChoice("Highest degree attained:", ["Bachelor's", "Master's", "PhD", "Associate"]);
  assert.equal(eduRes2?.choice, "PhD");

  const eduRes3 = decideChoice("Education level", [
    "High School",
    "College Graduate",
    "Graduate / Professional Degree",
  ]);
  assert.equal(eduRes3?.choice, "Graduate / Professional Degree");

  // Employment (Full-time / Employed full-time)
  const empRes1 = decideChoice("What is your current employment status?", [
    "Employed full-time",
    "Employed part-time",
    "Self-employed",
    "Unemployed",
  ]);
  assert.equal(empRes1?.choice, "Employed full-time");

  const empRes2 = decideChoice("Employment:", ["Part-time", "Full-time", "Retired", "Student"]);
  assert.equal(empRes2?.choice, "Full-time");

  // Marital Status (Married)
  const marRes = decideChoice("What is your marital status?", ["Single", "Married", "Divorced", "Widowed"]);
  assert.equal(marRes?.choice, "Married");

  // Household Income ($125,000–$149,999 or $100,000+)
  const incRes1 = decideChoice("What is your total annual household income?", [
    "Under $50,000",
    "$50,000–$74,999",
    "$75,000–$99,999",
    "$100,000–$124,999",
    "$125,000–$149,999",
    "$150,000+",
  ]);
  assert.equal(incRes1?.choice, "$125,000–$149,999");

  const incRes2 = decideChoice("Household income range:", [
    "Less than $50,000",
    "$50,000 to $99,999",
    "$100,000+",
  ]);
  assert.equal(incRes2?.choice, "$100,000+");

  // Politics (Party, Trump favorability, candidate)
  const polRes = decideChoice("Which political party do you trust more with the economy?", [
    "Democratic Party",
    "Republican Party",
    "Neither",
  ]);
  assert.equal(polRes?.choice, "Republican Party");

  const trumpRes = decideChoice("Do you have a favorable or unfavorable opinion of President Trump?", [
    "Very favorable",
    "Somewhat favorable",
    "Somewhat unfavorable",
    "Very unfavorable",
  ]);
  assert.equal(trumpRes?.choice, "Somewhat favorable");

  const govRes = decideChoice("Who would you support for Ohio governor?", [
    "Democrat Amy Acton",
    "Democrat Allison Russo",
    "Republican Vivek Ramaswamy",
    "Undecided",
  ]);
  assert.equal(govRes?.choice, "Republican Vivek Ramaswamy");
}

console.log("[test] 3. decideNoul handles binary/boolean questions accurately");
{
  // Hispanic origin -> No
  const hispRes = decideNoul("Are you Hispanic, Latino, or of Spanish origin?", ["Yes", "No"]);
  assert.equal(hispRes?.choice, "No");
  assert.equal(hispRes?.index, 1);
  assert.ok(hispRes?.confidence >= 0.85);

  // Own or rent -> Own
  const homeRes = decideNoul("Do you own or rent your home?", ["Rent", "Own", "Other"]);
  assert.equal(homeRes?.choice, "Own");
  assert.equal(homeRes?.index, 1);

  // Primary decision maker -> Yes
  const dmRes = decideNoul("Are you the primary financial decision maker in your household?", [
    "Yes",
    "No",
    "Share equally",
  ]);
  assert.equal(dmRes?.choice, "Yes");
  assert.equal(dmRes?.index, 0);

  // Children in household -> Yes
  const childRes = decideNoul("Do you have any children under the age of 18 living in your household?", ["Yes", "No"]);
  assert.equal(childRes?.choice, "Yes");

  // Firearms at home -> No
  const gunRes = decideNoul("Do you have any firearms stored in your home?", ["Yes", "No"]);
  assert.equal(gunRes?.choice, "No");
}

console.log("[test] 4. decideScore handles Likert scales matching persona sentiment");
{
  // 5-point scale: general satisfaction defaults to positive (e.g. 4 or 5)
  const scale5Res = decideScore("How satisfied are you with your primary grocery store?", [
    "1 - Very Dissatisfied",
    "2 - Dissatisfied",
    "3 - Neutral",
    "4 - Satisfied",
    "5 - Very Satisfied",
  ]);
  assert.ok(scale5Res?.index >= 3, "Satisfied or Very Satisfied should be selected");
  assert.ok(scale5Res?.confidence >= 0.85);

  // 7-point numeric scale [1..7]
  const scale7Res = decideScore("Rate your experience on a scale from 1 to 7:", [
    "1", "2", "3", "4", "5", "6", "7"
  ]);
  assert.ok(scale7Res?.index >= 4, "Positive rating should be chosen on 1-7 scale");
  assert.ok(["5", "6", "7"].includes(scale7Res?.choice));

  // Explicit persona view: strongly against spanking
  const spankRes = decideScore("Spanking is an effective and appropriate disciplinary technique for children.", [
    "Strongly Disagree",
    "Disagree",
    "Neutral",
    "Agree",
    "Strongly Agree",
  ]);
  assert.equal(spankRes?.choice, "Strongly Disagree");
  assert.equal(spankRes?.index, 0);

  // Explicit persona view: supports data center oversight
  const dcRes = decideScore("Local governments should enact environmental oversight on large data centers.", [
    "Strongly Disagree",
    "Disagree",
    "Neither agree nor disagree",
    "Agree",
    "Strongly Agree",
  ]);
  assert.ok(["Agree", "Strongly Agree"].includes(dcRes?.choice));
}

console.log("[test] 5. evaluateControls processes harvested controls and yields fast-path decision or clean fallback");
{
  // Successful demographic radio match
  const genderControls = [
    { role: "radio", label: "Male", x: 100, y: 200, w: 20, h: 20, isSubmitOrNext: false },
    { role: "radio", label: "Female", x: 100, y: 240, w: 20, h: 20, isSubmitOrNext: false },
    { role: "radio", label: "Prefer not to say", x: 100, y: 280, w: 20, h: 20, isSubmitOrNext: false },
    { role: "button", label: "Next", x: 200, y: 350, w: 80, h: 36, isSubmitOrNext: true },
  ];
  const evalChoice = evaluateControls(genderControls);
  assert.equal(evalChoice.canHandle, true);
  assert.equal(evalChoice.type, "choice");
  assert.equal(evalChoice.targetControl.label, "Female");
  assert.ok(evalChoice.confidence >= 0.85);
  assert.ok(typeof evalChoice.reason === "string");

  // Successful harvested object from harvestControls()
  const harvestedObj = {
    controls: [
      { role: "radio", label: "Own", x: 150, y: 220, isSubmitOrNext: false },
      { role: "radio", label: "Rent", x: 150, y: 260, isSubmitOrNext: false },
      { role: "button", label: "Continue", x: 300, y: 400, isSubmitOrNext: true },
    ],
    question: "Do you own or rent your home?",
    nextButton: { role: "button", label: "Continue", isSubmitOrNext: true },
  };
  const evalNoul = evaluateControls(harvestedObj);
  assert.equal(evalNoul.canHandle, true);
  assert.equal(evalNoul.type, "noul");
  assert.equal(evalNoul.targetControl.label, "Own");
  assert.ok(evalNoul.confidence >= 0.85);

  // Fallback: contains unhandled textarea (open-ended question needs System 2)
  const openEndedControls = [
    { role: "radio", label: "Yes", x: 100, y: 200, isSubmitOrNext: false },
    { role: "radio", label: "No", x: 100, y: 240, isSubmitOrNext: false },
    { role: "textbox", tag: "textarea", label: "Please explain your reasoning in detail", isSubmitOrNext: false },
    { role: "button", label: "Next", x: 200, y: 350, isSubmitOrNext: true },
  ];
  const evalTextArea = evaluateControls(openEndedControls);
  assert.equal(evalTextArea.canHandle, false);
  assert.equal(evalTextArea.reason, "needs_system2");

  // Fallback: low confidence / unknown ambiguous question
  const ambiguousControls = [
    { role: "radio", label: "Option Alpha", x: 100, y: 200, isSubmitOrNext: false },
    { role: "radio", label: "Option Beta", x: 100, y: 240, isSubmitOrNext: false },
  ];
  const evalAmbiguous = evaluateControls({ controls: ambiguousControls, question: "Select the cosmic quadrant" });
  assert.equal(evalAmbiguous.canHandle, false);
  assert.equal(evalAmbiguous.reason, "needs_system2");

  // Arithmetic attention checks (e.g. "What is 3 + 4?")
  const mathControls = [
    { role: "link", label: "What is 3 + 4?", tag: "a", isSubmitOrNext: false },
    { role: "textbox", tag: "input", type: "text", label: "", selector: "#math-input", isSubmitOrNext: false },
    { role: "button", label: "Continue", tag: "button", isSubmitOrNext: true },
  ];
  const evalMath = evaluateControls({ controls: mathControls, question: "Please correct the errors below" });
  assert.equal(evalMath.canHandle, true);
  assert.equal(evalMath.type, "text");
  assert.equal(evalMath.textValue, "7");
  assert.equal(evalMath.confidence, 0.99);

  // TV / Media question
  const tvControls = [
    { role: "checkbox", label: "NCIS", isSubmitOrNext: false },
    { role: "checkbox", label: "FBI", isSubmitOrNext: false },
    { role: "checkbox", label: "None of the above", isSubmitOrNext: false },
    { role: "button", label: "Continue", isSubmitOrNext: true },
  ];
  const evalTv = evaluateControls({ controls: tvControls, question: "Which of the following shows have you watched an episode of in the last week?" });
  assert.equal(evalTv.canHandle, true);
  assert.equal(evalTv.type, "choice");
  assert.equal(evalTv.targetControl.label, "NCIS");

  // Streaming service question
  const streamControls = [
    { role: "radio", label: "Netflix", isSubmitOrNext: false },
    { role: "radio", label: "None", isSubmitOrNext: false },
  ];
  const evalStream = evaluateControls({ controls: streamControls, question: "Which video streaming service do you use?" });
  assert.equal(evalStream.canHandle, true);
  assert.equal(evalStream.targetControl.label, "Netflix");

  // Rhyming attention checks (e.g. "Which of the following two words rhyme with 'cry'?")
  const rhymeControls = [
    { role: "checkbox", label: "Bake", isSubmitOrNext: false },
    { role: "checkbox", label: "Buy", isSubmitOrNext: false },
    { role: "checkbox", label: "Shy", isSubmitOrNext: false },
    { role: "checkbox", label: "Make", isSubmitOrNext: false },
    { role: "checkbox", label: "Fake", isSubmitOrNext: false },
    { role: "button", label: "Next page", isSubmitOrNext: true },
  ];
  const evalRhyme = evaluateControls({
    controls: rhymeControls,
    question: "Which of the following two words rhyme with \"cry\"? Please select the two words that apply.",
  });
  assert.equal(evalRhyme.canHandle, true);
  assert.equal(evalRhyme.type, "multi_choice");
  assert.equal(evalRhyme.targetControls.length, 2);
  assert.deepEqual(evalRhyme.targetControls.map((c) => c.label), ["Buy", "Shy"]);

  // Explicit instruction attention checks (e.g. "Please select 'Somewhat agree' to verify attention")
  const instructControls = [
    { role: "radio", label: "Strongly agree", isSubmitOrNext: false },
    { role: "radio", label: "Somewhat agree", isSubmitOrNext: false },
    { role: "radio", label: "Disagree", isSubmitOrNext: false },
  ];
  const evalInstruct = evaluateControls({
    controls: instructControls,
    question: "To verify you are paying attention, please choose 'Somewhat agree'.",
  });
  assert.equal(evalInstruct.canHandle, true);
  assert.equal(evalInstruct.targetControl.label, "Somewhat agree");

  // Empty controls or no actionable options
  assert.equal(evaluateControls([]).canHandle, false);
  assert.equal(evaluateControls({ controls: [] }).canHandle, false);
  assert.equal(evaluateControls(null).canHandle, false);
}

console.log("PASS: test_system1_decision");


