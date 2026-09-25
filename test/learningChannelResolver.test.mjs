// 品質ループ（台本・途中の成果物・企画ブリーフ）の学習を、台帳のチャンネルの保存先へ積む試験。
//
// 同じハーネスのチャンネルが2つあると、品質ループの不合格の回から自動で拾う学習もハーネス単位の台帳に
// 混ざっていた。ここでは、ループの作業フォルダ・制作の Job・ブリーフの channel.id からチャンネルを決め、
// そのチャンネルの保存先へ積むこと、決められないときは推測で寄せずに積まないこと、チャンネルが無ければ
// 従来どおりであることを確かめる。
//
// 一時ディレクトリだけを使う（本物の配置表・台帳・~/.buzzassist には触れない）。チャンネル・フォルダの名前は
// すべて合成。path は node:path で組み立てる。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { captureAssetLearning } from "../lib/assetQualityLearning.mjs";
import { createAssetQualityContract } from "../lib/assetQualityLoop.mjs";
import {
  LEARNING_CHANNEL_AMBIGUOUS,
  LEARNING_CHANNEL_REGISTRY_UNREADABLE,
  LEARNING_CHANNEL_STORE_UNRESOLVED,
  resolveLearningChannel,
} from "../lib/learningChannelResolver.mjs";
import { captureScriptRoundLearning } from "../lib/scriptQualityLearning.mjs";
import { createScriptQualityContract } from "../lib/scriptQualityLoop.mjs";
import { captureStrategyBriefLearning } from "../lib/strategyBriefLearning.mjs";

const NOW = "2026-09-26T00:00:00.000Z";
const JOB_ID = "video-sample-0123456789abcdef";
const { contract: SCRIPT_CONTRACT } = createScriptQualityContract();
const { contract: ASSET_CONTRACT } = createAssetQualityContract({ harnessId: "narrated-story-video", stage: "scene-image" });

function tempRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "learning-channel-resolver-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  return file;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function syntheticChannel(root, id) {
  return {
    id,
    projectDir: path.join(root, "channels", id, "project"),
    channelPack: path.join(root, "channels", id, "pack"),
    production: { kind: "harness", harnessId: "narrated-story-video" },
    strategy: { workDir: path.join(root, "channels", id, "strategy"), requireBrief: false },
    scriptQuality: { genre: "narrated-story" },
  };
}

/** 台帳（alpha・beta。どちらも同じハーネス）と、alpha の制作の Job（台本の作業フォルダはチャンネルの場所の外）。 */
function setup(t) {
  const root = tempRoot(t);
  const registry = write(path.join(root, "registry.json"), JSON.stringify({
    channels: [syntheticChannel(root, "alpha"), syntheticChannel(root, "beta")],
  }));
  const scriptWorkDir = path.join(root, "scripts", "episode-1");
  write(path.join(root, "channels", "alpha", "project", "canvas", "harness-runs", JOB_ID, "job.json"), JSON.stringify({
    id: JOB_ID,
    harness: { id: "narrated-story-video" },
    options: { scriptQualityWorkDir: scriptWorkDir },
    metadata: { channel: { id: "alpha", selectedBy: "explicit" } },
  }));
  const learningDir = path.join(root, "operator-learning-state");
  const env = { BUZZASSIST_CHANNEL_REGISTRY: registry, BUZZASSIST_LEARNING_DIR: learningDir };
  return { root, env, learningDir, scriptWorkDir };
}

const quiet = { signals: { terms: [], castIds: [] }, privateVocabulary: null, homeRoot: "" };

function recorder() {
  const calls = [];
  const capture = (input, options) => {
    calls.push({ input, options: options || {} });
    return { appended: true, entry: { id: `p-${calls.length}` } };
  };
  return { calls, capture };
}

function scriptRound() {
  return {
    state: { status: "active", stopReason: "", contractDigest: SCRIPT_CONTRACT.digest, startedAt: NOW, script: { genre: "narrated-story" } },
    round: { index: 2, score: 80, floorFailures: ["meaning-preservation"], failedGateIds: [], failureFingerprint: `quality-failure:${"a".repeat(24)}` },
    version: { label: "v2", stage: "revision", scriptSha256: "b".repeat(64) },
    contract: SCRIPT_CONTRACT,
  };
}

function assetRound() {
  return {
    state: {
      status: "active",
      stopReason: "",
      contractDigest: ASSET_CONTRACT.digest,
      startedAt: NOW,
      asset: { harnessId: "narrated-story-video", stage: "scene-image", subjectId: "synthetic-cut-1", versions: [] },
    },
    round: { index: 1, score: 70, floorFailures: [], failedGateIds: [], failureFingerprint: `quality-failure:${"c".repeat(24)}` },
    version: { label: "v1", assetPath: "cuts/v1.png", assetSha256: "d".repeat(64) },
    contract: ASSET_CONTRACT,
  };
}

function briefRound() {
  return {
    state: { status: "active", contractDigest: "e".repeat(64), startedAt: NOW },
    round: { index: 1, failureFingerprint: `quality-failure:${"f".repeat(24)}`, floorFailures: ["promise-payoff"], failedGateIds: [] },
    version: { label: "r1", briefSha256: "0".repeat(64), harnessId: "narrated-story-video" },
  };
}

test("チャンネルの決め方: 明示・Job・Job の台本の作業フォルダ・戦略の作業フォルダ・projectDir・ブリーフの順で、食い違えば決めない", async (t) => {
  const { root, env, scriptWorkDir } = setup(t);
  const resolve = (where) => resolveLearningChannel({ env, ...where });
  assert.deepEqual(await resolve({ channelId: "beta", workDir: scriptWorkDir }), { channelId: "beta", selectedBy: "explicit" });
  assert.deepEqual(await resolve({ job: { metadata: { channel: { id: "beta" } } }, workDir: scriptWorkDir }), { channelId: "beta", selectedBy: "job" });
  // 制作の Job の台本の作業フォルダ（とその中）は、その Job のチャンネル。
  assert.deepEqual(await resolve({ workDir: scriptWorkDir }), { channelId: "alpha", selectedBy: "job-work-dir" });
  assert.deepEqual(await resolve({ workDir: path.join(scriptWorkDir, "drafts") }), { channelId: "alpha", selectedBy: "job-work-dir" });
  assert.deepEqual(await resolve({ workDir: path.join(root, "channels", "beta", "strategy") }), { channelId: "beta", selectedBy: "strategy-work-dir" });
  assert.deepEqual(await resolve({ workDir: path.join(root, "channels", "beta", "project", "canvas") }), { channelId: "beta", selectedBy: "project-dir" });
  assert.deepEqual(await resolve({ briefChannelId: "beta", workDir: path.join(root, "elsewhere") }), { channelId: "beta", selectedBy: "brief" });
  // ブリーフの channel.id と作業フォルダが別のチャンネルを指す。
  const conflict = await resolve({ briefChannelId: "beta", workDir: path.join(root, "channels", "alpha", "strategy") });
  assert.equal(conflict.skippedReason, LEARNING_CHANNEL_AMBIGUOUS);
  assert.deepEqual(conflict.candidates, ["alpha", "beta"]);
  // 台帳に無い channel.id・どこにも当たらない作業フォルダは、チャンネルの無い従来の捕捉。
  assert.deepEqual(await resolve({ briefChannelId: "unregistered", workDir: path.join(root, "elsewhere") }), { channelId: "", selectedBy: null });
  assert.deepEqual(await resolve({}), { channelId: "", selectedBy: null });
  // 台帳が無ければ（例の配置表だけ）従来どおり。読めない台帳では決めない。
  assert.deepEqual(await resolveLearningChannel({ workDir: scriptWorkDir, env: {}, registry: { channels: [] } }), { channelId: "", selectedBy: null });
  const unreadable = await resolveLearningChannel({ workDir: scriptWorkDir, env: { BUZZASSIST_CHANNEL_REGISTRY: path.join(root, "missing.json") } });
  assert.equal(unreadable.skippedReason, LEARNING_CHANNEL_REGISTRY_UNREADABLE);
});

test("チャンネルの決め方: 別々のチャンネルの制作の Job が同じ台本の作業フォルダを使っていれば決めない", async (t) => {
  const { root, env, scriptWorkDir } = setup(t);
  write(path.join(root, "channels", "beta", "project", "canvas", "harness-runs", "video-sample-fedcba9876543210", "job.json"), JSON.stringify({
    id: "video-sample-fedcba9876543210",
    options: { scriptQualityWorkDir: scriptWorkDir },
    metadata: { channel: { id: "beta" } },
  }));
  const result = await resolveLearningChannel({ env, workDir: scriptWorkDir });
  assert.equal(result.skippedReason, LEARNING_CHANNEL_AMBIGUOUS);
  assert.deepEqual(result.candidates, ["alpha", "beta"]);
  // Job のチャンネルは、作業フォルダが別のチャンネルの projectDir の中でも優先する（Job を作ったチャンネルの学習）。
  const insideBeta = path.join(root, "channels", "beta", "project", "scripts");
  write(path.join(root, "channels", "alpha", "project", "canvas", "harness-runs", JOB_ID, "job.json"), JSON.stringify({
    id: JOB_ID, options: { scriptQualityWorkDir: insideBeta }, metadata: { channel: { id: "alpha" } },
  }));
  assert.deepEqual(await resolveLearningChannel({ env, workDir: insideBeta }), { channelId: "alpha", selectedBy: "job-work-dir" });
});

test("台本のループ: 作業フォルダから決めたチャンネルの保存先へ積み、無ければ従来どおり", async (t) => {
  const { root, env, learningDir, scriptWorkDir } = setup(t);
  const { state, round, version, contract } = scriptRound();
  // 本物の捕捉で、alpha の保存先（一時ディレクトリ）へ積む。
  const result = await captureScriptRoundLearning({ state, round, version, contract, env, now: () => NOW, captureOptions: quiet, workDir: scriptWorkDir });
  assert.equal(result.channelId, "alpha");
  assert.equal(result.channelSelectedBy, "job-work-dir");
  assert.ok(result.captured > 0, JSON.stringify(result));
  const rows = readJsonl(path.join(learningDir, "channels", "alpha", "docs", "learning", "proposals.jsonl"));
  assert.equal(rows.length, result.captured);
  assert.ok(rows.every((row) => row.channel === "alpha" && row.target === "channel-pack:narrated-story-script" && row.createdBy === "auto-script-quality"));
  assert.equal(fs.existsSync(path.join(learningDir, "channels", "beta")), false, "別のチャンネルの保存先に積まない");

  // チャンネルの無い作業フォルダは従来どおり（捕捉にチャンネルを渡さない）。
  const legacy = recorder();
  const unscoped = await captureScriptRoundLearning({
    state, round, version, contract, env, now: () => NOW, capture: legacy.capture, workDir: path.join(root, "elsewhere"),
  });
  assert.equal(unscoped.channelId, undefined);
  assert.ok(legacy.calls.length > 0 && legacy.calls.every((call) => !("channelId" in call.options)));

  // チャンネルは決まったが、その保存先を決められない（台帳に無い）ときは積まない。
  const ghost = await captureScriptRoundLearning({ state, round, version, contract, env, now: () => NOW, captureOptions: quiet, channelId: "ghost" });
  assert.equal(ghost.captured, 0);
  assert.equal(ghost.skippedReason, LEARNING_CHANNEL_STORE_UNRESOLVED);
});

test("途中の成果物のループ: 作業フォルダが台帳のチャンネルの projectDir の中ならそのチャンネル、制作の Job のチャンネルを優先する", async (t) => {
  const { root, env } = setup(t);
  const { state, round, version, contract } = assetRound();
  const canvas = path.join(root, "channels", "beta", "project", "canvas");
  const byWorkDir = recorder();
  const result = await captureAssetLearning({ event: "round", state, round, version, contract, env, now: () => NOW, capture: byWorkDir.capture, workDir: canvas });
  assert.equal(result.channelId, "beta");
  assert.equal(result.channelSelectedBy, "project-dir");
  assert.ok(byWorkDir.calls.length > 0 && byWorkDir.calls.every((call) => call.options.channelId === "beta" && call.options.env === env));
  const byJob = recorder();
  const fromJob = await captureAssetLearning({
    event: "round", state, round, version, contract, env, now: () => NOW, capture: byJob.capture, workDir: canvas,
    job: { metadata: { channel: { id: "alpha" } } },
  });
  assert.equal(fromJob.channelId, "alpha");
  assert.ok(byJob.calls.every((call) => call.options.channelId === "alpha"));
  // 台帳を読めなければ推測で決めずに積まない。
  const unreadable = recorder();
  const blocked = await captureAssetLearning({
    event: "round", state, round, version, contract, now: () => NOW, capture: unreadable.capture, workDir: canvas,
    env: { BUZZASSIST_CHANNEL_REGISTRY: path.join(root, "missing.json") },
  });
  assert.equal(blocked.skippedReason, LEARNING_CHANNEL_REGISTRY_UNREADABLE);
  assert.equal(unreadable.calls.length, 0);
});

test("企画ブリーフのループ: channel.id か戦略の作業フォルダで台帳のチャンネルを引き、食い違えば積まない", async (t) => {
  const { root, env } = setup(t);
  const { state, round, version } = briefRound();
  const byBrief = recorder();
  const result = await captureStrategyBriefLearning({
    state, round, version, env, now: () => NOW, capture: byBrief.capture, briefChannelId: "beta", workDir: path.join(root, "drafts"),
  });
  assert.equal(result.channelId, "beta");
  assert.equal(result.channelSelectedBy, "brief");
  assert.ok(byBrief.calls.length > 0 && byBrief.calls.every((call) => call.options.channelId === "beta"));
  const byWorkDir = recorder();
  const fromWorkDir = await captureStrategyBriefLearning({
    state, round, version, env, now: () => NOW, capture: byWorkDir.capture, workDir: path.join(root, "channels", "alpha", "strategy"),
  });
  assert.equal(fromWorkDir.channelId, "alpha");
  assert.equal(fromWorkDir.channelSelectedBy, "strategy-work-dir");
  const conflicting = recorder();
  const conflict = await captureStrategyBriefLearning({
    state, round, version, env, now: () => NOW, capture: conflicting.capture, briefChannelId: "beta", workDir: path.join(root, "channels", "alpha", "strategy"),
  });
  assert.equal(conflict.skippedReason, LEARNING_CHANNEL_AMBIGUOUS);
  assert.equal(conflicting.calls.length, 0, "どちらのチャンネルにも積まない");
  // チャンネルの無いブリーフ（台帳に無い channel.id・当たらない作業フォルダ）は従来どおり。
  const legacy = recorder();
  const unscoped = await captureStrategyBriefLearning({
    state, round, version, env, now: () => NOW, capture: legacy.capture, briefChannelId: "unregistered", workDir: path.join(root, "drafts"),
  });
  assert.equal(unscoped.channelId, undefined);
  assert.ok(legacy.calls.length > 0 && legacy.calls.every((call) => !("channelId" in call.options)));
});
