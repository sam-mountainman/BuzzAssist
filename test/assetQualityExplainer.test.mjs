// 途中の成果物の品質ループを、外部の制作の仕組みの解説動画（harness id explainer-video）から使う口の試験。
// 工程ごとの一巡（不合格 → 直し → 合格）は test/assetQualityLoop.test.mjs がハーネスと工程の組ごとに回す。
// ここは、使える工程と、共有の宣言をそのまま使うこと（解説動画だけの採点制度を作らない）と、学習の宛先が
// 解説動画のチャンネルの非公開台帳であることを見る。対象 id・会話 id はすべて合成の値。
import assert from "node:assert/strict";
import test from "node:test";

import { captureAssetLearning } from "../lib/assetQualityLearning.mjs";
import { HARNESS_LEARNING_ROUTES } from "../lib/harnessLearningTargets.mjs";
import {
  ASSET_QUALITY_CHANNEL_CONFIG_VERSION,
  ASSET_QUALITY_HARNESSES,
  assetQualityStage,
  createAssetQualityContract,
  normalizeAssetChannelConfig,
} from "../lib/assetQualityLoop.mjs";

const HARNESS = "explainer-video";

test("explainer-video は本編の画・声のテイク・サムネだけを使え、評価項目と機械ゲートは共有の宣言と同じ", () => {
  assert.deepEqual(ASSET_QUALITY_HARNESSES[HARNESS], { id: HARNESS, genre: "explainer", stages: ["scene-image", "voice-take", "thumbnail"] });
  for (const stage of ["character", "location", "video-clip"]) {
    assert.throws(() => assetQualityStage(stage, HARNESS), /explainer-video では使えない/u, stage);
  }
  for (const stage of ASSET_QUALITY_HARNESSES[HARNESS].stages) {
    const mine = createAssetQualityContract({ harnessId: HARNESS, stage }).contract;
    const shared = createAssetQualityContract({ harnessId: "narrated-story-video", stage }).contract;
    assert.deepEqual(mine.rubric, shared.rubric, stage);
    assert.deepEqual(mine.machineGates, shared.machineGates, stage);
    assert.deepEqual(mine.limits, shared.limits, stage);
    assert.equal(mine.harnessId, HARNESS);
    // 契約の digest はハーネスごとに分かれる（別のハーネスのループの記録と取り違えない）。
    assert.notEqual(mine.digest, shared.digest, stage);
  }
});

test("explainer-video のチャンネル設定: 使えない工程は blocker、下限は上げることだけできる", () => {
  const blockers = (stages) => normalizeAssetChannelConfig({ version: ASSET_QUALITY_CHANNEL_CONFIG_VERSION, stages }, { harnessId: HARNESS }).blockers;
  assert.deepEqual(blockers({ location: {} }), ["asset-quality.stages.location-not-in-harness"]);
  assert.deepEqual(blockers({ "video-clip": {} }), ["asset-quality.stages.video-clip-not-in-harness"]);
  assert.deepEqual(blockers({ thumbnail: { floors: { "readable-at-decided-size": 85 } } }), []);
  assert.deepEqual(blockers({ thumbnail: { floors: { "hand-safety": 90 } } }), ["asset-quality.stages.thumbnail.floors.hand-safety-cannot-lower"]);
});

test("explainer-video の不合格の回は、解説動画のチャンネルの非公開台帳（channel-pack:explainer）へ積む", async () => {
  const calls = [];
  const result = await captureAssetLearning({
    state: { status: "active", asset: { harnessId: HARNESS, stage: "thumbnail", subjectId: "synthetic-thumb-1" } },
    round: { index: 1, failureFingerprint: `quality-failure:${"a".repeat(24)}`, floorFailures: ["readable-at-decided-size"], failedGateIds: [] },
    contract: { harnessId: HARNESS, stage: "thumbnail", version: "synthetic" },
    env: {},
    capture: (proposal) => {
      calls.push(proposal);
      return { appended: true, entry: { id: "synthetic-proposal-1" } };
    },
  });
  assert.equal(result.skippedReason, undefined, JSON.stringify(result));
  assert.equal(result.target, HARNESS_LEARNING_ROUTES[HARNESS].channel);
  assert.equal(result.target, "channel-pack:explainer");
  assert.ok(calls.length >= 1);
  assert.ok(calls.every((proposal) => proposal.target === "channel-pack:explainer"), "共有層（genre: / platform:）へは積まない");
  assert.equal(JSON.stringify(calls).includes("synthetic-thumb-1"), false, "対象 id を本文へ運ばない");
});
