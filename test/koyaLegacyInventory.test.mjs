import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("historical version scripts remain inventoried and isolated from the official CLI", () => {
  const result = spawnSync("node", ["scripts/audit-koya-legacy-entrypoints.mjs", root], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.pass, true);
  assert.equal(report.matched.length, 67);
});

test("ordinary package commands do not expose legacy production or voice entrypoints", async () => {
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["manga-video:legacy"], undefined);
  assert.equal(packageJson.scripts["manga-video:voice-audition"], undefined);
  assert.equal(packageJson.scripts["manga-video:voice-approve"], undefined);
  assert.equal(packageJson.scripts["manga-video"], "node scripts/koya-manga-video.mjs");
});
