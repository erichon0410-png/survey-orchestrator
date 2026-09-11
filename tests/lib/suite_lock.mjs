// tests/lib/suite_lock.mjs — cross-process exclusive lock for test sections that share
// mutable state (reports/earnings_ledger.jsonl). `node --test` runs each test file in
// its own process, in parallel; a plain read-modify-write of the shared ledger from two
// processes loses updates. This is an O_EXCL spinlock with stale-holder recovery
// (dead holder pid or 120 s mtime timeout). Stdlib only.
import fs from "node:fs";

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

export function createSuiteLock(lockPath, { staleAfterMs = 120_000, timeoutMs = 300_000 } = {}) {
  let acquired = false;
  async function acquire() {
    const start = Date.now();
    for (;;) {
      try {
        fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
        acquired = true;
        return;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        let stale = false;
        try {
          const holderPid = Number(fs.readFileSync(lockPath, "utf-8"));
          stale =
            (!Number.isFinite(holderPid) || !pidAlive(holderPid)) ||
            fs.statSync(lockPath).mtimeMs < Date.now() - staleAfterMs;
        } catch {}
        if (stale) {
          try {
            fs.unlinkSync(lockPath);
          } catch {}
          continue;
        }
        if (Date.now() - start > timeoutMs) throw new Error(`suite lock ${lockPath} not acquired within ${timeoutMs}ms`);
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }
  function release() {
    if (!acquired) return;
    acquired = false;
    try {
      fs.unlinkSync(lockPath);
    } catch {}
  }
  return { acquire, release };
}
