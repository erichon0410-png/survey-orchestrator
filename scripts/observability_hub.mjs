// scripts/observability_hub.mjs — Unix domain socket EventHub and resilient transport.
// Node 18+ ESM, stdlib only (node:net, node:fs, node:path).

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { createEventEnvelope } from "./fleet_events.mjs";

/**
 * EventHub: central ingestion point and fanout hub.
 * Listens on a Unix domain socket, ingests events from drivers and supervisor,
 * persists to a unified journal file, and broadcasts to connected subscriber clients.
 */
export function createEventHub({ sockPath, journalPath = null }) {
  let server = null;
  const clients = new Set();
  let stopping = false;

  function writeJournal(event) {
    if (!journalPath) return;
    try {
      const dir = path.dirname(journalPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(journalPath, JSON.stringify(event) + "\n", "utf-8");
    } catch (e) {
      // Fire-and-forget: do not let disk errors break the hub
    }
  }

  function broadcast(event, originSocket = null) {
    writeJournal(event);
    const line = JSON.stringify(event) + "\n";
    for (const client of clients) {
      if (client !== originSocket && !client.destroyed && client.writable) {
        try {
          client.write(line);
        } catch {
          clients.delete(client);
        }
      }
    }
  }

  return {
    start() {
      return new Promise((resolve, reject) => {
        stopping = false;
        try {
          if (fs.existsSync(sockPath)) {
            fs.unlinkSync(sockPath);
          }
        } catch (e) {
          // Ignore
        }

        const dir = path.dirname(sockPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        server = net.createServer((socket) => {
          clients.add(socket);
          let buffer = "";

          socket.on("data", (chunk) => {
            buffer += chunk.toString("utf-8");
            let idx;
            while ((idx = buffer.indexOf("\n")) !== -1) {
              const line = buffer.slice(0, idx).trim();
              buffer = buffer.slice(idx + 1);
              if (line) {
                try {
                  const ev = JSON.parse(line);
                  broadcast(ev, socket);
                } catch {
                  // Ignore malformed JSON lines
                }
              }
            }
          });

          socket.on("error", () => {
            clients.delete(socket);
          });

          socket.on("close", () => {
            clients.delete(socket);
          });
        });

        server.on("error", (err) => {
          if (!stopping) reject(err);
        });

        server.listen(sockPath, () => {
          resolve();
        });
      });
    },

    publish(event) {
      const enveloped = createEventEnvelope(event);
      broadcast(enveloped, null);
    },

    getSubscriberCount() {
      return clients.size;
    },

    stop() {
      return new Promise((resolve) => {
        stopping = true;
        for (const client of clients) {
          try { client.destroy(); } catch {}
        }
        clients.clear();

        if (server) {
          server.close(() => {
            try {
              if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath);
            } catch {}
            resolve();
          });
        } else {
          try {
            if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath);
          } catch {}
          resolve();
        }
      });
    },
  };
}

/**
 * EventPublisher: driver-side resilient, reconnectable socket client.
 * Bounded drop-oldest buffer guarantees zero crash risk and zero memory leaks.
 */
export function createEventPublisher({
  sockPath,
  port = null,
  maxBuffer = 100,
  retryIntervalMs = 2000,
}) {
  let socket = null;
  let connected = false;
  let closed = false;
  let reconnectTimer = null;
  const queue = [];

  function flush() {
    if (!connected || !socket || !socket.writable) return;
    while (queue.length > 0) {
      const item = queue.shift();
      try {
        socket.write(JSON.stringify(item) + "\n");
      } catch {
        queue.unshift(item);
        break;
      }
    }
  }

  function connect() {
    if (closed) return;
    try {
      socket = net.createConnection(sockPath);

      socket.on("connect", () => {
        connected = true;
        flush();
      });

      socket.on("error", () => {
        connected = false;
      });

      socket.on("close", () => {
        connected = false;
        scheduleReconnect();
      });
    } catch {
      connected = false;
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!closed && !connected) connect();
    }, retryIntervalMs);
    if (reconnectTimer.unref) reconnectTimer.unref();
  }

  connect();

  return {
    publish(eventData) {
      if (closed) return;
      const ev = createEventEnvelope({ port, ...eventData });
      if (connected && socket && socket.writable) {
        try {
          socket.write(JSON.stringify(ev) + "\n");
          return;
        } catch {
          connected = false;
        }
      }

      // Buffer when offline (drop oldest if exceeded)
      if (queue.length >= maxBuffer) {
        queue.shift();
      }
      queue.push(ev);
    },

    close() {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (socket) {
        try { socket.destroy(); } catch {}
        socket = null;
      }
    },
  };
}

/**
 * EventSubscriber: watcher client that connects to the EventHub socket
 * and yields parsed events as they arrive.
 */
export function createEventSubscriber({ sockPath, onEvent, onError = null }) {
  return new Promise((resolve) => {
    let closed = false;
    let buffer = "";

    const socket = net.createConnection(sockPath);

    socket.on("connect", () => {
      resolve({
        close() {
          closed = true;
          try { socket.destroy(); } catch {}
        },
      });
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) {
          try {
            const ev = JSON.parse(line);
            if (onEvent) onEvent(ev);
          } catch {
            // Ignore parse errors
          }
        }
      }
    });

    socket.on("error", (err) => {
      if (onError && !closed) onError(err);
    });

    socket.on("close", () => {
      // closed
    });
  });
}
