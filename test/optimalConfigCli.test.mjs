import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = (...args) => spawnSync(process.execPath, ["scripts/optimal-config.mjs", ...args], { cwd: root, encoding: "utf8" });

test("select --traits は候補を JSON で出す", () => {
  const output = JSON.parse(execFileSync(process.execPath, ["scripts/optimal-config.mjs", "select", "--traits", "examples/optimal-config/traits/fixed-cast-manga.json"], { cwd: root, encoding: "utf8" }));
  assert.equal(output.ok, true);
  assert.equal(output.channelId, "fixed-cast-manga");
  assert.equal(output.videoConfigs.base, "R04");
  assert.equal(output.candidates[0].models.imagePrimary.modelId, "gpt-image");
});

test("gate --model は実行場所ごとの判定を出し、オトシゴのサーバーでは止める", () => {
  const output = JSON.parse(run("gate", "--model", "anima").stdout);
  assert.equal(output.ok, true);
  assert.equal(output.allowedAnywhere, true);
  const hosted = output.verdicts.find((verdict) => verdict.route === "otoshigo-hosted");
  assert.equal(hosted.allowed, false);
  assert.ok(hosted.blocks.some((item) => item.code === "HOSTING_AS_SERVICE_FORBIDDEN"));
  const blocked = JSON.parse(run("gate", "--model", "qwen-image-2-1", "--route", "operator-cuda").stdout);
  assert.equal(blocked.allowedAnywhere, false);
  assert.equal(blocked.verdicts[0].blocks[0].code, "RESEARCH_LICENSE");
});

test("trial-plan は10カットの段取りを出す", () => {
  const output = JSON.parse(run("trial-plan", "--traits", "examples/optimal-config/traits/iq-comparison.json").stdout);
  assert.equal(output.trial.cuts.length, 10);
  assert.ok(output.trial.candidates.length >= 2);
});

test("足りない引数・知らないモデルは JSON の理由と終了コード 1 で止める", () => {
  const missing = run("select");
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stdout).ok, false);
  const unknown = run("gate", "--model", "no-such-model");
  assert.equal(unknown.status, 1);
  assert.equal(JSON.parse(unknown.stdout).code, "OPTIMAL_CONFIG_UNKNOWN_MODEL");
});
