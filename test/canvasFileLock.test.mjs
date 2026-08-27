import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { withCanvasFileLock } from "../lib/canvasFileLock.mjs";

test("a stale-looking lock is never stolen while its owner process is alive", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "buzzassist-live-lock-"));
  const target = path.join(root, "state.json");
  const lock = `${target}.lock`;
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(lock, `${JSON.stringify({ pid: process.pid, createdAt: new Date(0).toISOString() })}\n`);
    await utimes(lock, new Date(0), new Date(0));
    let entered = false;
    await assert.rejects(
      () => withCanvasFileLock(target, async () => { entered = true; }, { timeoutMs: 40, staleMs: 1 }),
      /Timed out waiting/u,
    );
    assert.equal(entered, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a stale lock whose owner is gone is reclaimed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "buzzassist-dead-lock-"));
  const target = path.join(root, "state.json");
  const lock = `${target}.lock`;
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(lock, `${JSON.stringify({ pid: 2_147_483_647, createdAt: new Date(0).toISOString() })}\n`);
    await utimes(lock, new Date(0), new Date(0));
    const result = await withCanvasFileLock(target, async () => "reclaimed", { timeoutMs: 200, staleMs: 1 });
    assert.equal(result, "reclaimed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
