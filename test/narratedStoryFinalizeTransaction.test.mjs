// ナレーション物語の確定（完成 MP4・監査の報告・Receipt・状態ファイル）を1つの transaction にしたことを、
// 実際の pipeline（fixture の Media Job・本物の ffmpeg・本物の品質ループ）で確かめる。
// 確定の途中で落ちても、次の実行が状態を読む前にやり切るか捨て、描き直し（有料の処理）へ戻らない。
// 台本・画・声・人名・会話 id はすべて合成。有料 API もネットワークも使わない。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FILE_TRANSACTION_DIR, FILE_TRANSACTION_TEST_FAULT_ENV } from "../lib/fileTransaction.mjs";
import { resolveFfmpegToolchain } from "../lib/harnessRuntimeResolver.mjs";
import {
  REVIEWER_TRUST_PATH_ENV,
  REVIEWER_TRUST_VERSION,
  createReviewerTrustEntry,
  generateReviewerKeyPair,
} from "../lib/koyaReviewAttestation.mjs";
import { narratedStoryRunPaths, writeNarratedReviewSignoff } from "../lib/narratedStoryPipeline.mjs";
import { runNarratedStoryVideo } from "../lib/narratedStoryVideo.mjs";
import { bookendFixtureAdapters, createBookendFixtureMedia, passingVoiceQualityGate } from "./fixtures/narratedBookendFixture.mjs";
import { runPastAssetLoops } from "./fixtures/narratedAssetLoopFixture.mjs";
import { acceptScriptForTests } from "./helpers/scriptQualityAcceptance.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const toolchain = await resolveFfmpegToolchain();
const IDENTITY = "e".repeat(64);

async function setup(root) {
  const payloadDir = join(root, "signed-channel-pack-payload");
  await mkdir(payloadDir, { recursive: true });
  await writeFile(join(payloadDir, "narrated-story.json"), `${JSON.stringify({
    version: "fixture-finalize-txn-pack-v1",
    runtime: { imageModel: "fixture-image-v1", ttsProvider: "fixture-voice" },
    image: { provider: "fixture-image", model: "fixture-image-v1", adapterVersion: "fixture-image-adapter-v1", stylePrompt: "flat fixture illustration with no embedded text" },
    voice: { provider: "fixture-voice", model: "fixture-voice-v1", adapterVersion: "fixture-voice-adapter-v1", voiceId: "fixture-ja", speed: 1 },
    music: { provider: "fixture-music", model: "fixture-music-v1", adapterVersion: "fixture-music-adapter-v1", prompt: "quiet fixture ambient bed", gain: 0.01 },
    render: { width: 320, height: 180, fps: 12 },
    concurrency: 2,
    bookends: { enabled: false },
  }, null, 2)}\n`, "utf8");
  const scriptPath = join(root, "raw-script.txt");
  await writeFile(scriptPath, "最初の物語です。次の場面です。\n", "utf8");
  // 台本の関門（監査契約 v8 から）はこの試験の対象外。台本を人がそのまま使うと認めた記録を置く。
  await acceptScriptForTests(scriptPath);
  const reviewer = generateReviewerKeyPair();
  const trustPath = join(root, "reviewer-trust.json");
  await writeFile(trustPath, JSON.stringify({
    version: REVIEWER_TRUST_VERSION,
    reviewers: [createReviewerTrustEntry({ publicKeyPem: reviewer.publicKeyPem, label: "finalize transaction reviewer" })],
  }), "utf8");
  const fixture = await createBookendFixtureMedia(join(root, "fixture-media"), toolchain);
  return { payloadDir, scriptPath, reviewer, env: { [REVIEWER_TRUST_PATH_ENV]: trustPath }, fixture };
}

function run(root, context, jobId, { paid = true } = {}) {
  const adapters = bookendFixtureAdapters(context.fixture);
  return runNarratedStoryVideo({
    command: "full",
    scriptPath: context.scriptPath,
    channelPackDir: context.payloadDir,
    jobId,
    jobIdentityDigest: IDENTITY,
    deploymentRoot: root,
    mediaJobRunner: paid ? adapters.mediaJobRunner : async () => { throw new Error("finalize must not submit paid media"); },
    mediaJobProbe: paid ? adapters.mediaJobProbe : async () => { throw new Error("finalize must not reprobe"); },
    ffmpegToolchain: toolchain,
    voiceQualityGate: passingVoiceQualityGate,
    env: context.env,
  }, { allowDirectUnboundJobForTests: true });
}

function sign(root, context, jobId, outcome, reviewerContextId) {
  return writeNarratedReviewSignoff({
    deploymentRoot: root,
    jobId,
    identityDigest: IDENTITY,
    reviewerHost: "codex",
    reviewerContextId,
    reviewerPrivateKeyPem: context.reviewer.privateKeyPem,
    env: context.env,
    force: true,
    review: {
      rubricScores: Object.fromEntries(outcome.review.quality.rubric.map((criterion) => [criterion.id, 96])),
      notes: `全尺を通して見て、画と語りと字幕を確かめた（${reviewerContextId}）`,
      findings: [],
    },
    pass: true,
  });
}

async function withFault(value, action) {
  const previous = process.env[FILE_TRANSACTION_TEST_FAULT_ENV];
  process.env[FILE_TRANSACTION_TEST_FAULT_ENV] = value;
  try {
    return await action();
  } finally {
    if (previous === undefined) delete process.env[FILE_TRANSACTION_TEST_FAULT_ENV];
    else process.env[FILE_TRANSACTION_TEST_FAULT_ENV] = previous;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

/** 状態ファイルが持つ成果物の SHA が、どれも今のファイルと合っていること（組み合わせが崩れていない）。 */
async function assertConsistent(statePath) {
  const state = await readJson(statePath);
  for (const [kind, record] of Object.entries(state.artifacts || {})) {
    assert.equal(sha256(await readFile(record.path)), record.sha256, `${kind} の SHA が状態ファイルの記録と合う`);
  }
  return state;
}

async function renderedJob(root, context, jobId) {
  const rendered = await runPastAssetLoops(() => run(root, context, jobId));
  assert.equal(rendered.status, "awaiting-human-review", JSON.stringify(rendered.knownRemainingIssues));
  assert.ok(rendered.artifacts.previewVideo);
  await sign(root, context, jobId, rendered, `finalize-txn-review-${jobId.slice(-4)}`);
  return rendered;
}

test("a finalize that crashes after the audit report is committed is rolled forward on the next run without re-rendering", {
  skip: toolchain.ok ? false : "ffmpeg/ffprobe is unavailable",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "narrated-finalize-txn-forward-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const context = await setup(root);
  const jobId = "video-narrated-story-video-f17a1100000000a1";
  const { runDir, statePath } = narratedStoryRunPaths({ deploymentRoot: root, jobId });
  const rendered = await renderedJob(root, context, jobId);
  const previewSha = rendered.artifacts.previewVideo.sha256;

  // 完成 MP4 と監査の報告を入れ替えたところで落ちる（Receipt と状態ファイルはまだ）。
  await withFault("narrated-finalize:after-rename-2", async () => {
    await assert.rejects(run(root, context, jobId, { paid: false }), (error) => error?.code === "file-transaction-test-interrupt");
  });
  const crashedState = await readJson(statePath);
  const crashedReport = await readJson(crashedState.artifacts.auditReport.path);
  assert.equal(crashedState.phase, "awaiting-human-review", "落ちた瞬間、状態ファイルは古いまま");
  assert.equal(crashedReport.status, "pass", "落ちた瞬間、報告だけが新しい（これを次の実行が直す）");
  assert.ok((await readdir(join(runDir, FILE_TRANSACTION_DIR))).length === 1, "確定の journal が残っている");

  // 次の実行: 状態を読む前にやり切る。有料の処理（Media Job・probe）には戻らない。
  const resumed = await run(root, context, jobId, { paid: false });
  assert.equal(resumed.status, "final-audited", JSON.stringify(resumed.knownRemainingIssues));
  const state = await assertConsistent(statePath);
  assert.equal(state.phase, "final-audited");
  assert.equal(state.artifacts.finalVideo.sha256, previewSha, "完成 MP4 は描いた版そのもの");
  assert.equal(state.artifacts.previewVideo.sha256, previewSha, "描き直していない");
  const receipt = await readJson(state.runReceiptPath);
  assert.equal(receipt.status, "final-audited");
  assert.equal(receipt.artifacts.auditReport.sha256, state.artifacts.auditReport.sha256);
  assert.ok(Object.values(resumed.auditChecks).every((entry) => entry.pass === true));
  await assert.rejects(stat(join(runDir, FILE_TRANSACTION_DIR)), (error) => error?.code === "ENOENT", "置き場は残らない");
});

test("a finalize that fails before its commit point changes nothing, and the next run finalizes normally", {
  skip: toolchain.ok ? false : "ffmpeg/ffprobe is unavailable",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "narrated-finalize-txn-discard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const context = await setup(root);
  const jobId = "video-narrated-story-video-f17a1100000000a2";
  const { runDir, statePath } = narratedStoryRunPaths({ deploymentRoot: root, jobId });
  const rendered = await renderedJob(root, context, jobId);
  const before = await readJson(statePath);
  const reportBefore = await readFile(before.artifacts.auditReport.path);

  await withFault("narrated-finalize:before-journal", async () => {
    await assert.rejects(run(root, context, jobId, { paid: false }), (error) => error?.code === "file-transaction-test-interrupt");
  });
  const after = await assertConsistent(statePath);
  assert.equal(after.phase, "awaiting-human-review");
  assert.deepEqual(await readFile(before.artifacts.auditReport.path), reportBefore, "監査の報告は1バイトも変わらない");
  await assert.rejects(stat(join(runDir, "render", "final-audited.mp4")), (error) => error?.code === "ENOENT", "完成 MP4 は出ない");

  const finalized = await run(root, context, jobId, { paid: false });
  assert.equal(finalized.status, "final-audited", JSON.stringify(finalized.knownRemainingIssues));
  const state = await assertConsistent(statePath);
  assert.equal(state.artifacts.finalVideo.sha256, rendered.artifacts.previewVideo.sha256);
  await assert.rejects(stat(join(runDir, FILE_TRANSACTION_DIR)), (error) => error?.code === "ENOENT");
});
