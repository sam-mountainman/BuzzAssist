import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { localFolderOpenCommand, openLocalFolder } from "../lib/openLocalFolder.mjs";

test("assets folders open with the native file manager on each desktop OS", () => {
  const folder = resolve("/tmp/project with spaces/canvas/assets");
  assert.deepEqual(localFolderOpenCommand(folder, "darwin"), { command: "open", args: [folder] });
  assert.deepEqual(localFolderOpenCommand(folder, "win32"), { command: "explorer.exe", args: [folder] });
  assert.deepEqual(localFolderOpenCommand(folder, "linux"), { command: "xdg-open", args: [folder] });
});

test("opening an empty project's assets folder creates it first", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "buzzassist-empty-project-"));
  const assetsDir = join(projectDir, "canvas", "assets");
  const calls = [];
  try {
    const result = await openLocalFolder(assetsDir, {
      platform: "darwin",
      spawnImpl(command, args, options) {
        calls.push({ command, args, options });
        const child = new EventEmitter();
        child.unref = () => {};
        queueMicrotask(() => child.emit("spawn"));
        return child;
      },
    });
    assert.equal((await stat(assetsDir)).isDirectory(), true);
    assert.equal(result.path, resolve(assetsDir));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, [resolve(assetsDir)]);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
