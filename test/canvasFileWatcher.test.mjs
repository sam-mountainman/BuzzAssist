import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createCanvasFileWatcher } from "../lib/canvasFileWatcher.mjs";

test("static canvas watcher reports atomic MCP canvas writes", async () => {
  const canvasDir = await mkdtemp(join(tmpdir(), "buzzassist-static-watch-"));
  const canvasFile = join(canvasDir, "excalidraw-canvas.json");
  const tempFile = `${canvasFile}.tmp`;
  const watcher = createCanvasFileWatcher();

  try {
    const changed = new Promise((resolveChanged, rejectChanged) => {
      // The complete suite runs CPU-heavy subtitle/audio tests in parallel.
      // Leave enough headroom for macOS to deliver the fs.watch notification
      // when the event loop is briefly saturated.
      const timer = setTimeout(() => rejectChanged(new Error("canvas watcher timed out")), 10000);
      const onChanged = (changedPath) => {
        if (resolve(changedPath) !== resolve(canvasFile)) return;
        clearTimeout(timer);
        resolveChanged(changedPath);
      };
      watcher.on("add", onChanged);
      watcher.on("change", onChanged);
      watcher.on("error", rejectChanged);
    });

    watcher.add(canvasFile);
    await writeFile(tempFile, '{"type":"excalidraw","elements":[]}\n');
    await rename(tempFile, canvasFile);

    assert.equal(resolve(await changed), resolve(canvasFile));
  } finally {
    watcher.close();
    await rm(canvasDir, { recursive: true, force: true });
  }
});
