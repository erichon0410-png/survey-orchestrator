let WebSocket;
try {
  WebSocket = (await import("ws")).default;
} catch {
  WebSocket = (await import("/home/erich/.dsh/profiles/web/node_modules/ws/index.js")).default;
}

const port = process.argv[2] || "3016";

async function probe() {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/cdp/json`);
    const list = await res.json();
    const target = list.find((t) => t.type === "page") || list[0];
    if (!target) {
      console.log(`Port ${port}: No page target found. Raw:`, list);
      return;
    }
    console.log(`Port ${port}: target title="${target.title}" url="${target.url}"`);
    const wsUrl = target.webSocketDebuggerUrl.replace(/ws:\/\/[^/]+/, `ws://127.0.0.1:${port}/cdp`);
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = Math.floor(Math.random() * 1e6);
        const timeout = setTimeout(() => reject(new Error("CDP timeout")), 5000);
        const handler = (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.id === id) {
            clearTimeout(timeout);
            ws.off("message", handler);
            resolve(msg.result);
          }
        };
        ws.on("message", handler);
        ws.send(JSON.stringify({ id, method, params }));
      });

    const evalResult = await send("Runtime.evaluate", {
      expression: "({ title: document.title, url: window.location.href, textSnippet: (document.body ? document.body.innerText.substring(0, 300) : '') })",
      returnByValue: true,
    });
    console.log("Evaluation:", JSON.stringify(evalResult?.result?.value, null, 2));
    ws.close();
  } catch (err) {
    console.error(`Port ${port} error:`, err.message);
  }
}

probe();
