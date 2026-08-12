import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("official Koya CLI exposes a validated read-only contract command", () => {
  const result = spawnSync("node", ["scripts/koya-manga-video.mjs", "contract", "--project-dir", root], {
    cwd: root, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.version, "koya-manga-production-v47");
  assert.equal(parsed.validation.pass, true);
});

test("official Koya CLI advertises the bounded onset-repair action", () => {
  const result = spawnSync("node", ["scripts/koya-manga-video.mjs", "help"], {
    cwd: root, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /repair-onset/u);
  assert.match(result.stdout, /repair-tail/u);
  assert.match(result.stdout, /adjust-gap/u);
  assert.match(result.stdout, /standard-cut/u);
  assert.match(result.stdout, /plan-path JSON/u);
  assert.match(result.stdout, /target-audible-gap-seconds N/u);
  assert.match(result.stdout, /sync-contract/u);
  assert.match(result.stdout, /fade-milliseconds 6\.\.8/u);
  assert.match(result.stdout, /protagonist-speaker-id/u);
  assert.match(result.stdout, /character-bible-path/u);
  assert.match(result.stdout, /character-approve/u);
  assert.match(result.stdout, /image-concurrency N\|auto/u);
  assert.match(result.stdout, /qa-concurrency N/u);
  assert.match(result.stdout, /image-fallback-model MODEL/u);
  assert.match(result.stdout, /qa-fallback-provider grok/u);
});
