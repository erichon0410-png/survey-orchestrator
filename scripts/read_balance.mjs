import { withCDPSession } from "./system1_runner.mjs";

export async function readSwagbucksBalance(port = 3014) {
  return await withCDPSession(port, { match: "swagbucks" }, async (send) => {
    const res = await send("Runtime.evaluate", {
      expression: `(() => {
        const selList = [
          ".toggler_balanceNumber__2bB8k",
          ".toggler_balanceNumber__Wb1N_",
          "[class*='toggler_balanceNumber']",
          "#sbBalance",
          ".sbBalance",
          "[data-testid='balance-amount']"
        ];
        for (const sel of selList) {
          const el = document.querySelector(sel);
          if (el && el.innerText.trim()) {
            const raw = el.innerText.replace(/[^0-9]/g, "");
            if (raw) return { raw: parseInt(raw, 10), text: el.innerText.trim(), selector: sel };
          }
        }
        // Fallback: search for numbers near 'SB'
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const txt = node.nodeValue.trim();
          if (/^([0-9,]{3,7})\s*SB$/i.test(txt)) {
            const m = txt.match(/^([0-9,]{3,7})\s*SB$/i);
            return { raw: parseInt(m[1].replace(/,/g, ""), 10), text: txt, fallback: true };
          }
        }
        return null;
      })()`,
      returnByValue: true,
    });
    return res?.result?.value || null;
  });
}

if (process.argv[1] && process.argv[1].includes("read_balance.mjs")) {
  const port = parseInt(process.argv[2] || "3014", 10);
  readSwagbucksBalance(port).then(b => {
    console.log("Balance:", JSON.stringify(b, null, 2));
    process.exit(0);
  }).catch(e => {
    console.error("Error reading balance:", e);
    process.exit(1);
  });
}
