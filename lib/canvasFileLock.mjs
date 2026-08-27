import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_STALE_MS = 120_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function lockOwnerIsAlive(lockPath) {
  let owner;
  try {
    owner = JSON.parse(await readFile(lockPath, "utf8"));
  } catch {
    return false;
  }
  const pid = Number(owner?.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means that the process exists but this user cannot signal it.
    return error?.code !== "ESRCH";
  }
}

// Canvas writes can originate from the browser server and several MCP
// processes at the same time. An in-memory promise queue only protects one
// process, so use a small cross-platform lock file around read/merge/write.
export async function withCanvasFileLock(filePath, callback, options = {}) {
  const lockPath = `${filePath}.lock`;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const staleMs = Number.isFinite(options.staleMs) ? options.staleMs : DEFAULT_STALE_MS;
  const startedAt = Date.now();
  await mkdir(dirname(filePath), { recursive: true });

  let handle = null;
  while (!handle) {
    try {
      handle = await open(lockPath, "wx");
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const lockStat = await stat(lockPath).catch(() => null);
      if (lockStat && Date.now() - lockStat.mtimeMs > staleMs && !(await lockOwnerIsAlive(lockPath))) {
        await rm(lockPath, { force: true }).catch(() => {});
        continue;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for canvas write lock: ${lockPath}`);
      }
      await sleep(20 + Math.floor(Math.random() * 40));
    }
  }

  try {
    return await callback();
  } finally {
    await handle.close().catch(() => {});
    await rm(lockPath, { force: true }).catch(() => {});
  }
}
