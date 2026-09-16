// scripts/hermes_digest.mjs — Transforms raw fleet events into Discord Markdown digests.

export const PORT_TO_CHANNEL = {
  3013: "discord:#agent-3013",
  3014: "discord:#agent-3014",
  3015: "discord:#agent-3015",
  3016: "discord:#agent-3016",
  3017: "discord:#agent-3017",
};

export const PORT_TO_PLATFORM = {
  3013: "SurveyJunkie",
  3014: "Swagbucks",
  3015: "SurveyJunkie",
  3016: "SurveyJunkie",
  3017: "Swagbucks (2)",
};

export function generateFleetDigests(events, options = {}) {
  const windowMinutes = options.windowMinutes || 5;
  const perPort = new Map();

  // Initialize all known ports
  for (const port of [3013, 3014, 3015, 3016, 3017]) {
    perPort.set(port, {
      port,
      channel: PORT_TO_CHANNEL[port],
      platform: PORT_TO_PLATFORM[port],
      actions: [],
      completions: [],
      screenouts: [],
      errors: [],
      earningsUsd: 0,
      hasActivity: false,
    });
  }

  // Aggregate events
  for (const ev of events) {
    const port = Number(ev.port);
    if (!perPort.has(port)) continue;
    const entry = perPort.get(port);
    entry.hasActivity = true;

    if (ev.event === "acting" || ev.event === "item_started") {
      const actTitle = ev.detail?.title || ev.message?.replace(/^acting:\s*/i, "") || "action";
      entry.actions.push(actTitle);
    } else if (ev.event === "survey_done" || ev.message?.includes("survey completed")) {
      const payout = Number(ev.detail?.payout_usd) || 0;
      entry.earningsUsd += payout;
      entry.completions.push({
        title: ev.detail?.title || "Survey",
        payoutUsd: payout,
        payoutRaw: ev.detail?.payout_raw,
      });
    } else if (ev.event === "screened_out" || ev.event === "disqualified") {
      entry.screenouts.push(ev.detail?.title || "Screener");
    } else if (ev.event === "tech_issue_reported" || ev.event === "error") {
      entry.errors.push(ev.detail?.symptom || ev.message || "Technical issue");
    }
  }

  let totalFleetEarnings = 0;
  let totalCompletions = 0;
  let activeContainers = 0;

  // Format per-port Markdown
  for (const [port, data] of perPort.entries()) {
    totalFleetEarnings += data.earningsUsd;
    totalCompletions += data.completions.length;
    if (data.hasActivity) activeContainers += 1;

    let md = `### 🤖 Agent ${port} (${data.platform}) — Past ${windowMinutes}m Activity\n`;
    if (!data.hasActivity) {
      md += `*Status: Idle / Polling for surveys*\n`;
    } else {
      if (data.completions.length > 0) {
        md += `**🎉 Surveys Completed:**\n`;
        for (const c of data.completions) {
          md += `- **${c.title}** (+$${c.payoutUsd.toFixed(2)}${c.payoutRaw ? ` / ${c.payoutRaw}` : ""})\n`;
        }
      }
      if (data.earningsUsd > 0) {
        md += `**💰 5m Earnings:** +$${data.earningsUsd.toFixed(2)} USD\n`;
      }
      if (data.screenouts.length > 0) {
        md += `*Screenouts / Disqualifications:* ${data.screenouts.length}\n`;
      }
      if (data.errors.length > 0) {
        md += `**⚠️ Blockers / Tech Issues:** ${data.errors.slice(-2).join("; ")}\n`;
      }
      if (data.actions.length > 0) {
        const recentActions = [...new Set(data.actions)].slice(-4);
        md += `**Recent Actions:**\n`;
        for (const a of recentActions) {
          md += `- ${a}\n`;
        }
      }
    }
    data.markdown = md.trim();
  }

  // Format fleet rollup Markdown
  const rollupMd = `## 📊 Survey Fleet Summary (Past ${windowMinutes}m)
- **Active Containers:** ${activeContainers} / 5
- **5m Fleet Earnings:** +$${totalFleetEarnings.toFixed(2)} USD
- **Surveys Completed:** ${totalCompletions}
- **Timestamp:** ${new Date().toLocaleTimeString()}

| Port | Platform | 5m Earnings | Status |
| :--- | :--- | :--- | :--- |
${[3013, 3014, 3015, 3016, 3017]
  .map((p) => {
    const d = perPort.get(p);
    const status = d.errors.length > 0 ? "⚠️ Blocker" : d.completions.length > 0 ? "🎉 Completed" : d.hasActivity ? "🟢 Working" : "⚪ Idle";
    return `| ${p} | ${d.platform} | +$${d.earningsUsd.toFixed(2)} | ${status} |`;
  })
  .join("\n")}
`;

  return {
    perPort,
    rollup: {
      channel: "discord:#survey-reports",
      markdown: rollupMd.trim(),
    },
  };
}
