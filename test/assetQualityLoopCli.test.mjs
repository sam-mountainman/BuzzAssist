import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createAssetQualityContract } from "../lib/assetQualityLoop.mjs";
import { runAssetQualityCli } from "../scripts/asset-quality-loop.mjs";
import { MAKER, now, reviewFor, stageInputs, workspace, writeReview } from "./fixtures/assetQualityFixtures.mjs";

// 人物・会話 id・対象 id・所見はすべて合成の値（test/fixtures/assetQualityFixtures.mjs）。

test("CLI は人待ちを 3、未合格の --require-pass を 4、機械の人確認の申告を 3 で返し、--help では何も書かない", async (t) => {
  const root = await workspace(t);
  const out = [];
  const stdout = { write: (text) => out.push(text) };
  const env = { BUZZASSIST_LEARNING_AUTO_CAPTURE: "0" };
  const base = ["--work-dir", root, "--stage", "character", "--subject", "synthetic-cast-5"];
  assert.equal((await runAssetQualityCli(["start", "--help"], { stdout })).exitCode, 0);
  await assert.rejects(stat(join(root, "quality")), /ENOENT/u, "--help で状態を書かない");
  assert.equal((await runAssetQualityCli(["start", ...base, "--harness", "koya-manga-video", "--generator-context", MAKER], { stdout, now })).exitCode, 0);
  const fx = await stageInputs(root, "character");
  const v1 = await fx.asset(1);
  const contract = createAssetQualityContract({ harnessId: "koya-manga-video", stage: "character" }).contract;
  const recordArgs = (review) => [
    "record", ...base, "--asset", v1.rel, "--version", "v1", "--review", review, "--producer-context", MAKER, "--producer-host", "claude-code",
    "--route", "chatgpt-web", "--reference", fx.refs[0], "--approved-references", join(root, "refs", "approved.json"),
  ];
  const waitingRun = await runAssetQualityCli(recordArgs(await writeReview(root, "self", reviewFor({ stage: "character", context: MAKER, assetSha: v1.sha, refs: fx.refs, contract }))), { stdout, now, env });
  assert.equal(waitingRun.exitCode, 3);
  const failing = await writeReview(root, "fail", reviewFor({ stage: "character", context: "ctx-eval-1", assetSha: v1.sha, refs: fx.refs, contract, overrides: { "identity-match": 50 } }));
  const recorded = await runAssetQualityCli([...recordArgs(failing), "--json"], { stdout, now, env });
  assert.equal(recorded.exitCode, 0);
  assert.equal(recorded.result.learning.skippedReason, "disabled");
  assert.equal((await runAssetQualityCli(["status", ...base, "--require-pass"], { stdout })).exitCode, 4);
  assert.equal((await runAssetQualityCli(["status", "--work-dir", root, "--require-pass"], { stdout })).exitCode, 4);
  const verifyArgs = ["verify", ...base, "--asset", v1.rel, "--check", "identity", "--pass", "--reviewer", "synthetic-reviewer", "--note", "並べて見た"];
  await assert.rejects(runAssetQualityCli([...verifyArgs, "--human-verified"], { stdout, now, isInteractive: false }), /対話端末/u);
  assert.equal((await runAssetQualityCli([...verifyArgs, "--agent-attested"], { stdout, now, isInteractive: false })).exitCode, 3);
  assert.equal((await runAssetQualityCli([...verifyArgs, "--human-verified"], { stdout, now, isInteractive: true, env })).exitCode, 0);
  out.length = 0;
  assert.equal((await runAssetQualityCli(["contract", "--harness", "narrated-story-video", "--stage", "voice-take"], { stdout })).exitCode, 0);
  assert.equal(JSON.parse(out.join("")).rubric.length, 2);
  await assert.rejects(runAssetQualityCli(["record", "--nope"], { stdout }), /不明なオプション/u);
  await assert.rejects(runAssetQualityCli(["start", "--work-dir", root, "--harness", "narrated-story-video", "--stage", "location", "--subject", "x", "--generator-context", MAKER], { stdout, now }), /manga ジャンル固有/u);
});

test("CLI の stop は対話端末と --human-verified がある人だけ止められ（機械の申告は 3）、止まったループは止め直さない", async (t) => {
  const root = await workspace(t);
  const stdout = { write() {} };
  const base = ["--work-dir", root, "--stage", "character", "--subject", "synthetic-cast-6"];
  assert.equal((await runAssetQualityCli(["start", ...base, "--harness", "koya-manga-video", "--generator-context", MAKER], { stdout, now })).exitCode, 0);
  const stop = ["stop", ...base, "--reviewer", "synthetic-reviewer", "--reason", "評価項目の改定を決めた"];
  await assert.rejects(runAssetQualityCli([...stop, "--human-verified"], { stdout, now, isInteractive: false }), /対話端末/u);
  assert.equal((await runAssetQualityCli([...stop, "--agent-attested"], { stdout, now, isInteractive: false })).exitCode, 3);
  const human = await runAssetQualityCli([...stop, "--human-verified", "--json"], { stdout, now, isInteractive: true });
  assert.equal(human.exitCode, 0);
  assert.equal(human.result.state.stopReason, "human-stopped");
  assert.equal((await runAssetQualityCli([...stop, "--human-verified"], { stdout, now, isInteractive: true })).exitCode, 3);
});
