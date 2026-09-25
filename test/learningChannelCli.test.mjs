// 品質ループの CLI（台本・途中の成果物・企画ブリーフ）の --channel <id> と --job <id> の試験。
//
// ループの作業フォルダが台帳のチャンネルの場所の外だと、学習はチャンネルの無い従来の台帳へ積まれていた。
// CLI から学習を積むチャンネルを明示できること（--channel は台帳の id、--job はその Job の metadata.channel）、
// 台帳に無いチャンネル・見つからない Job・チャンネルの無い Job は回を記録する前に止めること、明示と作業フォルダ
// （やブリーフの channel.id）・明示どうしが別のチャンネルを指せば積まないこと（回は記録する）を確かめる。
//
// 一時ディレクトリだけを使う（本物の配置表・台帳・~/.buzzassist には触れない）。捕捉は記録するだけの関数に
// 差し替える。チャンネル・Job・会話 id・フォルダの名前はすべて合成。path は node:path で組み立てる。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { captureAssetLearning } from "../lib/assetQualityLearning.mjs";
import { createAssetQualityContract } from "../lib/assetQualityLoop.mjs";
import {
  LEARNING_CHANNEL_AMBIGUOUS,
  LEARNING_CHANNEL_JOB_NOT_FOUND,
  LEARNING_CHANNEL_JOB_WITHOUT_CHANNEL,
  learningChannelCliHints,
} from "../lib/learningChannelResolver.mjs";
import { captureScriptRoundLearning } from "../lib/scriptQualityLearning.mjs";
import { createScriptQualityContract, scriptQualityStatus } from "../lib/scriptQualityLoop.mjs";
import { captureStrategyBriefLearning } from "../lib/strategyBriefLearning.mjs";
import { createStrategyBriefQualityContract } from "../lib/strategyBriefQualityLoop.mjs";
import { runAssetQualityCli } from "../scripts/asset-quality-loop.mjs";
import { runScriptQualityCli } from "../scripts/script-quality-loop.mjs";
import { runStrategyBriefCli } from "../scripts/strategy-brief.mjs";
import { MAKER, now, reviewFor, stageInputs, writeReview as writeAssetReview } from "./fixtures/assetQualityFixtures.mjs";
import { evidenceRow, jsonBytes, metricsOutput, sampleBrief, sha, writeJson } from "./helpers/strategyBriefFixture.mjs";

const ALPHA_JOB = "video-sample-0123456789abcdef";
const BETA_JOB = "video-sample-fedcba9876543210";
const UNSCOPED_JOB = "video-sample-1111111111111111";
const WRITER = "ctx-writer-cli";
const DRAFT = "「合成の冒頭の台詞」\n合成の地の文。\n「合成の台詞で、間を取る」\n";
const { contract: SCRIPT_CONTRACT } = createScriptQualityContract();
const STRATEGY_CONTRACT = createStrategyBriefQualityContract();
const silent = { write() {} };

function tempRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "learning-channel-cli-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  return file;
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

function writeJob(root, channelId, jobId, metadata) {
  write(path.join(root, "channels", channelId, "project", "canvas", "harness-runs", jobId, "job.json"), JSON.stringify({
    id: jobId, harness: { id: "narrated-story-video" }, options: {}, metadata,
  }));
}

/** 台帳（alpha・beta。どちらも同じハーネス）と、alpha・beta の制作の Job、alpha の場所にあるチャンネルの無い Job。 */
function setup(t) {
  const root = tempRoot(t);
  const registry = write(path.join(root, "registry.json"), JSON.stringify({
    channels: [syntheticChannel(root, "alpha"), syntheticChannel(root, "beta")],
  }));
  writeJob(root, "alpha", ALPHA_JOB, { channel: { id: "alpha", selectedBy: "explicit" } });
  writeJob(root, "beta", BETA_JOB, { channel: { id: "beta", selectedBy: "explicit" } });
  writeJob(root, "alpha", UNSCOPED_JOB, {});
  const env = { BUZZASSIST_CHANNEL_REGISTRY: registry, BUZZASSIST_LEARNING_DIR: path.join(root, "operator-learning-state") };
  return { root, env };
}

/** 捕捉（提案の書き込み）を記録するだけの関数にする。チャンネルの決め方は本物を通す。 */
function recorder() {
  const calls = [];
  const capture = (input, options) => {
    calls.push({ input, options: options || {} });
    return { appended: true, entry: { id: `p-${calls.length}` } };
  };
  return { calls, capture };
}

function scriptReview(context, rubricScores) {
  return {
    evaluatorId: "evaluator",
    evaluatorContextId: context,
    evaluatorHost: "codex",
    scriptSha256: sha(DRAFT),
    rubricScores,
    notes: `全行を読んだ合成の所見（${context}）`,
    findings: [],
  };
}

/** 台本のループを始め、不合格の採点を置く。返す値は record の引数。 */
async function failingScriptRound(workDir) {
  fs.mkdirSync(path.join(workDir, "drafts"), { recursive: true });
  fs.mkdirSync(path.join(workDir, "quality", "reviews"), { recursive: true });
  assert.equal((await runScriptQualityCli(["start", "--work-dir", workDir, "--generator-context", WRITER], { stdout: silent, now })).exitCode, 0);
  fs.writeFileSync(path.join(workDir, "drafts", "draft.md"), DRAFT);
  const scores = Object.fromEntries(SCRIPT_CONTRACT.rubric.map((row) => [row.id, row.id === "narration-voice" ? 10 : 100]));
  fs.writeFileSync(path.join(workDir, "quality", "reviews", "r1.json"), JSON.stringify(scriptReview("ctx-eval-cli", scores)));
  return ["record", "--work-dir", workDir, "--script", "drafts/draft.md", "--version", "v1", "--stage", "draft", "--review", "quality/reviews/r1.json", "--json"];
}

test("CLI の明示の手がかり: --channel は台帳の id、--job はその Job のチャンネル。台帳に無い・見つからない・チャンネルの無い Job は止める", async (t) => {
  const { env } = setup(t);
  assert.deepEqual(await learningChannelCliHints({ env }), { channelIds: [], captureInput: {} });
  assert.deepEqual(await learningChannelCliHints({ env, channelId: "alpha" }), { channelIds: ["alpha"], captureInput: { channelId: ["alpha"] } });
  assert.deepEqual(await learningChannelCliHints({ env, jobId: ALPHA_JOB }), { channelIds: ["alpha"], captureInput: { channelId: ["alpha"] } });
  // --channel と Job のチャンネルが違えば両方を渡す（決め方が食い違いとして積まない）。
  assert.deepEqual(await learningChannelCliHints({ env, channelId: "alpha", jobId: BETA_JOB }), { channelIds: ["alpha", "beta"], captureInput: { channelId: ["alpha", "beta"] } });
  await assert.rejects(learningChannelCliHints({ env, channelId: "ghost" }), (error) => error.code === "channel-unknown");
  await assert.rejects(learningChannelCliHints({ env, jobId: "video-sample-ffffffffffffffff" }), (error) => error.code === LEARNING_CHANNEL_JOB_NOT_FOUND);
  await assert.rejects(learningChannelCliHints({ env, jobId: `..${path.sep}escape` }), (error) => error.code === LEARNING_CHANNEL_JOB_NOT_FOUND);
  await assert.rejects(learningChannelCliHints({ env, jobId: UNSCOPED_JOB }), (error) => error.code === LEARNING_CHANNEL_JOB_WITHOUT_CHANNEL);
  await assert.rejects(
    learningChannelCliHints({ env: { BUZZASSIST_CHANNEL_REGISTRY: path.join(os.tmpdir(), "learning-channel-cli-missing", "registry.json") }, channelId: "alpha" }),
    (error) => error.code === "channel-registry-unreadable",
  );
});

test("台本のループの CLI: --channel は台帳に無ければ回を記録する前に止め、あればそのチャンネルへ積む。作業フォルダが別のチャンネルなら積まない", async (t) => {
  const { root, env } = setup(t);
  const rec = recorder();
  const captureLearning = (input) => captureScriptRoundLearning({ ...input, env, capture: rec.capture });

  // 作業フォルダはチャンネルの場所の外（ほかの手がかりはどのチャンネルも指さない）。
  const outside = path.join(root, "scripts", "episode-1");
  const recordArgs = await failingScriptRound(outside);
  await assert.rejects(runScriptQualityCli([...recordArgs, "--channel", "ghost"], { stdout: silent, now, env, captureLearning }), /channel-unknown/u);
  assert.equal((await scriptQualityStatus({ workDir: outside })).rounds.length, 0, "止めたときは回を記録しない");
  await assert.rejects(runScriptQualityCli(["status", "--work-dir", outside, "--channel", "alpha"], { stdout: silent, env }), /record でだけ/u);
  const recorded = await runScriptQualityCli([...recordArgs, "--channel", "alpha"], { stdout: silent, now, env, captureLearning });
  assert.equal(recorded.exitCode, 0);
  assert.equal(recorded.result.learning.channelId, "alpha");
  assert.equal(recorded.result.learning.channelSelectedBy, "explicit");
  assert.ok(rec.calls.length > 0 && rec.calls.every((call) => call.options.channelId === "alpha"));

  // 作業フォルダが beta の場所の中なのに --channel alpha: 回は記録し、学習は積まない。
  rec.calls.length = 0;
  const insideBeta = path.join(root, "channels", "beta", "project", "scripts", "episode-2");
  const conflict = await runScriptQualityCli([...await failingScriptRound(insideBeta), "--channel", "alpha"], { stdout: silent, now, env, captureLearning });
  assert.equal(conflict.exitCode, 0);
  assert.equal(conflict.result.recorded, true);
  assert.equal(conflict.result.learning.skippedReason, LEARNING_CHANNEL_AMBIGUOUS);
  assert.equal(rec.calls.length, 0, "どちらのチャンネルにも積まない");
});

test("途中の成果物のループの CLI: --job の Job のチャンネルへ積み、--channel と食い違えば積まない。record と verify 以外では使えない", async (t) => {
  const { root, env } = setup(t);
  const workDir = path.join(root, "assets-work");
  for (const dir of ["assets", "reviews", "refs", "measure"]) fs.mkdirSync(path.join(workDir, dir), { recursive: true });
  const rec = recorder();
  const captureLearning = (input) => captureAssetLearning({ ...input, env, capture: rec.capture });
  const contract = createAssetQualityContract({ harnessId: "narrated-story-video", stage: "scene-image" }).contract;
  const fx = await stageInputs(workDir, "scene-image");
  const failingRound = async (subject) => {
    const base = ["--work-dir", workDir, "--stage", "scene-image", "--subject", subject];
    assert.equal((await runAssetQualityCli(["start", ...base, "--harness", "narrated-story-video", "--generator-context", MAKER], { stdout: silent, now })).exitCode, 0);
    const version = await fx.asset(subject.length);
    const review = await writeAssetReview(workDir, `fail-${subject}`, reviewFor({
      stage: "scene-image", context: "ctx-eval-cli", assetSha: version.sha, refs: fx.refs, contract, overrides: { [contract.rubric.find((row) => row.minimumScore < 100).id]: 10 },
    }));
    return [
      "record", ...base, "--asset", version.rel, "--version", "v1", "--review", review, "--producer-context", MAKER, "--producer-host", "claude-code",
      "--route", "chatgpt-web", "--reference", fx.refs[0], "--approved-references", path.join(workDir, "refs", "approved.json"), "--json",
    ];
  };

  const byJob = await runAssetQualityCli([...await failingRound("synthetic-cut-1"), "--job", ALPHA_JOB], { stdout: silent, now, env, captureLearning });
  assert.equal(byJob.exitCode, 0);
  assert.equal(byJob.result.learning.channelId, "alpha");
  assert.ok(rec.calls.length > 0 && rec.calls.every((call) => call.options.channelId === "alpha"));

  rec.calls.length = 0;
  const conflict = await runAssetQualityCli([...await failingRound("synthetic-cut-22"), "--job", ALPHA_JOB, "--channel", "beta"], { stdout: silent, now, env, captureLearning });
  assert.equal(conflict.exitCode, 0);
  assert.equal(conflict.result.learning.skippedReason, LEARNING_CHANNEL_AMBIGUOUS);
  assert.equal(rec.calls.length, 0);

  await assert.rejects(runAssetQualityCli([...await failingRound("synthetic-cut-333"), "--job", UNSCOPED_JOB], { stdout: silent, now, env, captureLearning }), /learning-channel-job-without-channel/u);
  await assert.rejects(runAssetQualityCli(["status", "--work-dir", workDir, "--job", ALPHA_JOB], { stdout: silent, env }), /record と verify でだけ/u);
});

test("企画ブリーフの CLI: --channel でそのチャンネルへ積み、--job の Job のチャンネルと食い違えば積まない", async (t) => {
  const { root, env } = setup(t);
  const rec = recorder();
  const captureLearning = (input) => captureStrategyBriefLearning({ ...input, env, capture: rec.capture });
  const failingRound = async (name) => {
    const workDir = path.join(root, "briefs", name);
    fs.mkdirSync(workDir, { recursive: true });
    const metrics = await writeJson(workDir, "evidence/metrics.json", metricsOutput());
    // ブリーフの channel.id（sample-channel）は台帳に無いので、チャンネルの手がかりにならない。
    const brief = sampleBrief({
      evidence: [evidenceRow(metrics, { id: "e-metrics", kind: "metrics", premiseBound: false, premiseIndependenceReason: "合成: 公開済みの動画の実測" })],
      changes: { previous: null, keep: [{ point: "合成の残す点", evidenceIds: ["e-metrics"] }], change: [] },
    });
    const bytes = jsonBytes(brief);
    const briefPath = path.join(workDir, "brief-r1.json");
    fs.writeFileSync(briefPath, bytes);
    assert.equal((await runStrategyBriefCli(["start", "--work-dir", workDir, "--generator-context", "ctx-planner-cli"], { stdout: silent, now })).exitCode, 0);
    const scores = Object.fromEntries(STRATEGY_CONTRACT.rubric.map((row, index) => [row.id, index === 0 ? 10 : 95]));
    const review = await writeJson(workDir, "quality/reviews/r1.json", {
      evaluatorId: "evaluator", evaluatorContextId: "ctx-eval-cli", evaluatorHost: "codex", briefSha256: sha(bytes),
      rubricScores: scores, notes: "ブリーフと根拠のファイルを開いて照合した合成の所見", findings: [],
    });
    return ["record", "--brief", briefPath, "--review", review.full, "--json"];
  };

  const byChannel = await runStrategyBriefCli([...await failingRound("first"), "--channel", "beta"], { stdout: silent, now, env, captureLearning });
  assert.equal(byChannel.exitCode, 0);
  assert.equal(byChannel.result.learning.channelId, "beta");
  assert.ok(rec.calls.length > 0 && rec.calls.every((call) => call.options.channelId === "beta"));

  rec.calls.length = 0;
  const conflict = await runStrategyBriefCli([...await failingRound("second"), "--channel", "beta", "--job", ALPHA_JOB], { stdout: silent, now, env, captureLearning });
  assert.equal(conflict.exitCode, 0);
  assert.equal(conflict.result.learning.skippedReason, LEARNING_CHANNEL_AMBIGUOUS);
  assert.equal(rec.calls.length, 0);

  await assert.rejects(runStrategyBriefCli([...await failingRound("third"), "--job", "video-sample-ffffffffffffffff"], { stdout: silent, now, env, captureLearning }), /learning-channel-job-not-found/u);
  await assert.rejects(runStrategyBriefCli(["status", "--work-dir", path.join(root, "briefs", "first"), "--channel", "beta"], { stdout: silent, env }), /record（学習を積むチャンネル）と draft/u);
});
