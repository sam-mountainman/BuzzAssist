import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
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

test("static canvas watcher reports files deleted from a watched assets directory", async () => {
  const canvasDir = await mkdtemp(join(tmpdir(), "buzzassist-static-assets-watch-"));
  const assetsDir = join(canvasDir, "assets");
  const assetFile = join(assetsDir, "Image1.png");
  const watcher = createCanvasFileWatcher();

  try {
    await mkdir(assetsDir, { recursive: true });
    await writeFile(assetFile, "image");
    const unlinked = new Promise((resolveUnlinked, rejectUnlinked) => {
      const timer = setTimeout(() => rejectUnlinked(new Error("asset unlink watcher timed out")), 10000);
      watcher.on("unlink", (changedPath) => {
        if (resolve(changedPath) !== resolve(assetFile)) return;
        clearTimeout(timer);
        resolveUnlinked(changedPath);
      });
      watcher.on("error", rejectUnlinked);
    });

    watcher.add(assetsDir);
    await rm(assetFile);

    assert.equal(resolve(await unlinked), resolve(assetFile));
  } finally {
    watcher.close();
    await rm(canvasDir, { recursive: true, force: true });
  }
});
