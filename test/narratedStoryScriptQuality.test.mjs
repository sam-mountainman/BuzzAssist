// ナレーション物語の Job で、使う台本の台本の品質ループの合格を必須にする関門（監査契約 v8 から）。
//   - plan-only の preflight（inspectNarratedStoryPlan）と、有料の処理の前の pipeline が同じ理由コードを返す
//   - 人がそのまま使うと認めた台本・ループが合格した版は通り、未合格・合格後の変更・ループ未開始は止まる
//   - 古い監査契約（v7 以前）の Job には求めない
// 台本の文・人名・会話 id はすべて合成。有料 API もネットワークも使わない。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { resolveFfmpegToolchain } from "../lib/harnessRuntimeResolver.mjs";
import {
  REVIEWER_TRUST_PATH_ENV,
  REVIEWER_TRUST_VERSION,
  createReviewerTrustEntry,
  generateReviewerKeyPair,
} from "../lib/koyaReviewAttestation.mjs";
import { NARRATED_STORY_AUDIT_CONTRACT_VERSION, inspectNarratedStoryPlan } from "../lib/narratedStoryPipeline.mjs";
import {
  NARRATED_SCRIPT_QUALITY_AUDIT_ID,
  NARRATED_SCRIPT_QUALITY_SINCE,
  gateNarratedScriptQuality,
  narratedScriptQualityRequired,
} from "../lib/narratedStoryScriptQuality.mjs";
import { runNarratedStoryVideo } from "../lib/narratedStoryVideo.mjs";
import { createScriptQualityContract, recordScriptQualityRound, startScriptQualityLoop } from "../lib/scriptQualityLoop.mjs";
import { passingVoiceQualityGate } from "./fixtures/narratedBookendFixture.mjs";
import { acceptScriptForTests } from "./helpers/scriptQualityAcceptance.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const toolchain = await resolveFfmpegToolchain();
const SERIES = "buzzassist-narrated-story-audit";
const SCRIPT = "合成の最初の物語です。合成の次の場面です。\n";
const IDENTITY = "e".repeat(64);
let clock = Date.parse("2026-09-26T00:00:00.000Z");
const now = () => {
  clock += 60_000;
  return new Date(clock).toISOString();
};

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "narrated-script-quality-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const payloadDir = join(root, "signed-channel-pack-payload");
  await mkdir(payloadDir, { recursive: true });
  await writeFile(join(payloadDir, "narrated-story.json"), `${JSON.stringify({
    version: "fixture-script-quality-pack-v1",
    runtime: { imageModel: "fixture-image-v1", ttsProvider: "fixture-voice" },
    image: { provider: "fixture-image", model: "fixture-image-v1", adapterVersion: "fixture-image-adapter-v1", stylePrompt: "flat fixture illustration with no embedded text" },
    voice: { provider: "fixture-voice", model: "fixture-voice-v1", adapterVersion: "fixture-voice-adapter-v1", voiceId: "fixture-ja", speed: 1 },
    music: { provider: "fixture-music", model: "fixture-music-v1", adapterVersion: "fixture-music-adapter-v1", prompt: "quiet fixture ambient bed", gain: 0.01 },
    render: { width: 320, height: 180, fps: 12 },
    concurrency: 2,
    bookends: { enabled: false },
  }, null, 2)}\n`, "utf8");
  // 台本スキルが出すフォルダ（ループの状態は quality/ に置く）。
  const scriptDir = join(root, "scripts", "episode-a");
  await mkdir(scriptDir, { recursive: true });
  const scriptPath = join(scriptDir, "script.txt");
  await writeFile(scriptPath, SCRIPT, "utf8");
  const reviewer = generateReviewerKeyPair();
  const trustPath = join(root, "reviewer-trust.json");
  await writeFile(trustPath, JSON.stringify({
    version: REVIEWER_TRUST_VERSION,
    reviewers: [createReviewerTrustEntry({ publicKeyPem: reviewer.publicKeyPem, label: "script quality reviewer" })],
  }), "utf8");
  return { root, payloadDir, scriptDir, scriptPath, env: { [REVIEWER_TRUST_PATH_ENV]: trustPath } };
}

/** 有料の処理を1つも呼ばない runner。probe が呼ばれたら「関門を通った」印として記録する。 */
function paidGuard() {
  const calls = [];
  return {
    calls,
    mediaJobRunner: async () => { calls.push("submit"); throw new Error("paid media must not be submitted in this test"); },
    mediaJobProbe: async (adapter) => { calls.push(`probe:${adapter.kind}`); return { ok: false, status: "unavailable", detail: "fixture stops before paid work" }; },
  };
}

function run(context, guard, jobId, extra = {}) {
  return runNarratedStoryVideo({
    command: "full",
    scriptPath: context.scriptPath,
    channelPackDir: context.payloadDir,
    jobId,
    jobIdentityDigest: IDENTITY,
    deploymentRoot: context.root,
    mediaJobRunner: guard.mediaJobRunner,
    mediaJobProbe: guard.mediaJobProbe,
    ffmpegToolchain: toolchain,
    voiceQualityGate: passingVoiceQualityGate,
    env: context.env,
    ...extra,
  }, { allowDirectUnboundJobForTests: true });
}

async function passLoop(workDir, text) {
  await startScriptQualityLoop({ workDir, genre: "narrated-story", generatorContextId: "ctx-writer", generatorHost: "claude-code", now });
  const { contract } = createScriptQualityContract({ genre: "narrated-story" });
  await mkdir(join(workDir, "quality", "reviews"), { recursive: true });
  await writeFile(join(workDir, "quality", "reviews", "r1.json"), JSON.stringify({
    evaluatorId: "evaluator", evaluatorContextId: "ctx-eval-1", evaluatorHost: "codex", scriptSha256: sha256(text),
    rubricScores: Object.fromEntries(contract.rubric.map((row) => [row.id, row.minimumScore === 100 ? 100 : 96])),
    notes: "合成の所見: 全行を読んだ", findings: [],
  }));
  return recordScriptQualityRound({ workDir, scriptPath: "script.txt", versionLabel: "v1", stage: "draft", reviewPath: "quality/reviews/r1.json", now });
}

test("効力: 台本の関門は監査契約 v8 から（v7 以前の Job には求めない。読めない版は要る側に倒す）", async () => {
  assert.equal(NARRATED_SCRIPT_QUALITY_SINCE, `${SERIES}-v8`);
  assert.equal(narratedScriptQualityRequired(NARRATED_STORY_AUDIT_CONTRACT_VERSION), true);
  assert.equal(narratedScriptQualityRequired(`${SERIES}-v7`), false);
  assert.equal(narratedScriptQualityRequired("unreadable"), true);
  const legacy = await gateNarratedScriptQuality({ contractVersion: `${SERIES}-v7`, scriptPath: "/unused", workDir: "/unused" });
  assert.deepEqual([legacy.required, legacy.pass, legacy.check.applicable], [false, true, false]);
});

test("plan-only: 受け入れていない台本は preflight に理由コードと次のコマンドを出し、受け入れた台本・別の作業フォルダの受け入れは通る", async (t) => {
  const context = await setup(t);
  const blocked = await inspectNarratedStoryPlan({ scriptPath: context.scriptPath, channelPackDir: context.payloadDir });
  assert.ok(blocked.blockers.includes("script-quality-required:script-quality-loop-not-started"), JSON.stringify(blocked.blockers));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.scriptQuality.workDir, dirname(context.scriptPath), "作業フォルダの既定は台本のあるフォルダ");
  const next = blocked.scriptQuality.next.join("\n");
  assert.match(next, /accept-human --work-dir .* --script script\.txt .*--human-verified/u);
  assert.match(next, /start --work-dir .* --genre narrated-story/u);

  // 明示の作業フォルダ（台本と別の場所）で受け入れた記録を見る。
  const elsewhere = join(context.root, "loop-folder");
  await mkdir(elsewhere, { recursive: true });
  await writeFile(join(elsewhere, "script.txt"), SCRIPT, "utf8");
  await acceptScriptForTests(join(elsewhere, "script.txt"));
  const explicit = await inspectNarratedStoryPlan({ scriptPath: context.scriptPath, channelPackDir: context.payloadDir, scriptQualityWorkDir: elsewhere });
  assert.equal(explicit.blockers.some((id) => id.startsWith("script-quality-required:")), false, JSON.stringify(explicit.blockers));
  assert.equal(explicit.scriptQuality.acceptedBy, "human");

  await acceptScriptForTests(context.scriptPath);
  const accepted = await inspectNarratedStoryPlan({ scriptPath: context.scriptPath, channelPackDir: context.payloadDir });
  assert.deepEqual(accepted.blockers, []);
  assert.equal(accepted.ok, true);
});

test("pipeline: 受け入れていない台本は有料の処理の前に人待ちで止まり、受け入れた台本は関門を通って有料の前検査へ進む", {
  skip: toolchain.ok ? false : "ffmpeg/ffprobe is unavailable",
}, async (t) => {
  const context = await setup(t);
  const guard = paidGuard();
  const jobId = "video-narrated-story-video-5c01a7e000000001";
  const blocked = await run(context, guard, jobId);
  assert.equal(blocked.status, "awaiting-human-review");
  assert.deepEqual(blocked.knownRemainingIssues, ["script-quality-required:script-quality-loop-not-started"]);
  assert.equal(blocked.execution.paidGenerationAttempted, false);
  assert.deepEqual(guard.calls, [], "有料の前検査にも進まない");
  assert.equal(blocked.auditChecks[NARRATED_SCRIPT_QUALITY_AUDIT_ID].pass, false);
  assert.match(blocked.next, /accept-human/u, "外側の Job に残る文字列の next");
  assert.ok(blocked.next.length <= 1000, "外側の Job は next を 1000 字で切る");
  assert.equal(blocked.scriptQuality.workDir, context.scriptDir);

  await acceptScriptForTests(context.scriptPath);
  const passed = await run(context, guard, jobId);
  assert.notEqual(passed.status, "awaiting-human-review");
  assert.equal(passed.knownRemainingIssues.some((id) => id.startsWith("script-quality-required:")), false, JSON.stringify(passed.knownRemainingIssues));
  assert.ok(guard.calls.some((call) => call.startsWith("probe:")), "関門を通った後で有料の前検査へ進む");
  assert.equal(guard.calls.includes("submit"), false);
});

test("pipeline: ループが合格した版の後で台本が変わったら script-changed-after-pass で止まる", {
  skip: toolchain.ok ? false : "ffmpeg/ffprobe is unavailable",
}, async (t) => {
  const context = await setup(t);
  const recorded = await passLoop(context.scriptDir, SCRIPT);
  assert.equal(recorded.state.status, "passed", JSON.stringify(recorded.issues));
  const guard = paidGuard();
  const jobId = "video-narrated-story-video-5c01a7e000000002";
  const passed = await run(context, guard, jobId);
  assert.equal(passed.knownRemainingIssues.some((id) => id.startsWith("script-quality-required:")), false, JSON.stringify(passed.knownRemainingIssues));

  // 合格した後に台本を直した（別の Job になる。同じ作業フォルダのループは前の版の合格のまま）。
  await writeFile(context.scriptPath, `${SCRIPT}合成の追加の場面です。\n`, "utf8");
  const changed = await run(context, paidGuard(), "video-narrated-story-video-5c01a7e000000003");
  assert.equal(changed.status, "awaiting-human-review");
  assert.deepEqual(changed.knownRemainingIssues, ["script-quality-required:script-changed-after-pass"]);
  assert.match(changed.next, /record --work-dir .* --stage revision/u);
});
