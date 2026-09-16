const ports = [3013, 3015];

for (const port of ports) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/cdp/json`);
    const targets = await res.json();
    const page = targets.find((t) => t.type === "page");
    if (!page) {
      console.log(`Port ${port}: no page target`);
      continue;
    }
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ id: 1, method: "Page.navigate", params: { url: "https://app.surveyjunkie.com/" } }));
      };
      ws.onmessage = (msg) => {
        const d = JSON.parse(msg.data);
        if (d.id === 1) {
          console.log(`Port ${port} navigated:`, d.result);
          ws.close();
          resolve();
        }
      };
      setTimeout(resolve, 4000);
    });
  } catch (e) {
    console.log(`Port ${port} error:`, e.message);
  }
}
