import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { localFolderOpenCommand, openLocalFile, openLocalFolder } from "../lib/openLocalFolder.mjs";

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

test("a file opens with the same native command and is never created when missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "buzzassist-open-file-"));
  const page = join(dir, "review page.png");
  const calls = [];
  const spawnImpl = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
  try {
    await assert.rejects(openLocalFile(page, { platform: "darwin", spawnImpl }), /ENOENT/u);
    await assert.rejects(stat(page), /ENOENT/u);
    await assert.rejects(openLocalFile(dir, { platform: "darwin", spawnImpl }), /開くファイルではない/u);
    await writeFile(page, "synthetic");
    for (const platform of ["darwin", "win32", "linux"]) await openLocalFile(page, { platform, spawnImpl });
    assert.deepEqual(calls.map((call) => call.command), ["open", "explorer.exe", "xdg-open"]);
    assert.ok(calls.every((call) => call.args[0] === resolve(page)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
