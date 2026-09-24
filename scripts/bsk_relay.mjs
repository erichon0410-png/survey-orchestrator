import net from "node:net";
import os from "node:os";

function getWslIp() {
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (name === "eth0") {
      const v4 = addrs.find(a => a.family === "IPv4" && !a.internal);
      if (v4) return v4.address;
    }
  }
  for (const addrs of Object.values(ifaces)) {
    const v4 = addrs.find(a => a.family === "IPv4" && !a.internal && a.address.startsWith("172."));
    if (v4) return v4.address;
  }
  return "127.0.0.1";
}

const wslIp = getWslIp();
const server = net.createServer(client => {
  const target = net.connect(52800, "127.0.0.1");
  client.pipe(target).pipe(client);
  client.on("error", () => {});
  target.on("error", () => {});
});

server.listen(52800, wslIp, () => {
  console.log(`[bsk_relay] Listening on ${wslIp}:52800 -> 127.0.0.1:52800`);
});

server.on("error", (e) => {
  console.error(`[bsk_relay] Error:`, e.message);
});
