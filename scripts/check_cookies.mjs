const ports = [3013, 3014, 3015, 3016, 3017];

for (const port of ports) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/cdp/json`);
    const targets = await res.json();
    const page = targets.find((t) => t.type === "page");
    if (!page) {
      console.log(`Port ${port}: no page target`);
      continue;
    }
    // Connect via WS to check Network.getCookies
    const wsUrl = page.webSocketDebuggerUrl;
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ id: 1, method: "Network.getCookies", params: {} }));
      };
      ws.onmessage = (msg) => {
        const data = JSON.parse(msg.data);
        if (data.id === 1 && data.result) {
          const cookies = data.result.cookies || [];
          const domains = [...new Set(cookies.map((c) => c.domain))];
          const surveyJunkie = domains.some((d) => d.includes("surveyjunkie"));
          const swagbucks = domains.some((d) => d.includes("swagbucks"));
          const eureka = domains.some((d) => d.includes("eureka"));
          const opinionOutpost = domains.some((d) => d.includes("opinionoutpost"));
          console.log(`Port ${port}:`);
          console.log(`  SurveyJunkie cookies: ${surveyJunkie}`);
          console.log(`  Swagbucks cookies:    ${swagbucks}`);
          console.log(`  Eureka cookies:       ${eureka}`);
          console.log(`  OpinionOutpost cookies:${opinionOutpost}`);
          ws.close();
          resolve();
        }
      };
      ws.onerror = () => resolve();
      setTimeout(resolve, 3000);
    });
  } catch (e) {
    console.log(`Port ${port}: ${e.message}`);
  }
}
