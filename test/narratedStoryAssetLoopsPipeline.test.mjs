// ナレーション物語の公式経路で、途中の成果物の品質ループの合格を「使う前」に必須にする（監査契約 v5）ことを、
// 実際の pipeline（fixture の Media Job・本物の ffmpeg・本物のループ）で確かめる。
//   - 描いた後でも、確定の前に、描いた画と採用したテイクが今も合格した版のままかを照合する（落ちたら signoff と
//     台本の品質ループの回を消費せずに止まる）
//   - 関門が無かった版（v4）の ready state は、当時の契約で従来どおり確定できる
// 台本・画・声・人名・会話 id はすべて合成。有料 API もネットワークも使わない。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startAssetQualityLoop } from "../lib/assetQualityLoop.mjs";
import { finalizeRunReceipt, openRunReceipt, recordGatesFromAuditChecks } from "../lib/harnessRunReceipt.mjs";
import { resolveFfmpegToolchain } from "../lib/harnessRuntimeResolver.mjs";
import {
  REVIEWER_TRUST_PATH_ENV,
  REVIEWER_TRUST_VERSION,
  createReviewerTrustEntry,
  generateReviewerKeyPair,
} from "../lib/koyaReviewAttestation.mjs";
import { NARRATED_ASSET_LOOP_AUDIT_IDS } from "../lib/narratedStoryAssetLoops.mjs";
import {
  NARRATED_STORY_AUDIT_CONTRACT_VERSION,
  NARRATED_SCENE_IMAGE_PROVENANCE_AUDIT_ID,
  narratedStoryRunPaths,
  writeNarratedReviewSignoff,
} from "../lib/narratedStoryPipeline.mjs";
import { narratedQualityPaths } from "../lib/narratedStoryQualityLoop.mjs";
import { runNarratedStoryVideo } from "../lib/narratedStoryVideo.mjs";
import { bookendFixtureAdapters, createBookendFixtureMedia, passingVoiceQualityGate } from "./fixtures/narratedBookendFixture.mjs";
import { recordAssetLoopRound, runPastAssetLoops } from "./fixtures/narratedAssetLoopFixture.mjs";
import { acceptScriptForTests } from "./helpers/scriptQualityAcceptance.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const toolchain = await resolveFfmpegToolchain();
const IDENTITY = "d".repeat(64);
const LEGACY_CONTRACT = "buzzassist-narrated-story-audit-v4";

async function setup(root) {
  const payloadDir = join(root, "signed-channel-pack-payload");
  await mkdir(payloadDir, { recursive: true });
  await writeFile(join(payloadDir, "narrated-story.json"), `${JSON.stringify({
    version: "fixture-asset-loop-pack-v1",
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
    reviewers: [createReviewerTrustEntry({ publicKeyPem: reviewer.publicKeyPem, label: "asset loop pipeline reviewer" })],
  }), "utf8");
  const fixture = await createBookendFixtureMedia(join(root, "fixture-media"), toolchain);
  return { payloadDir, scriptPath, reviewer, env: { [REVIEWER_TRUST_PATH_ENV]: trustPath }, fixture };
}

function runner(root, context, jobId, { paid = true } = {}) {
  const adapters = bookendFixtureAdapters(context.fixture);
  return {
    adapters,
    run: () => runNarratedStoryVideo({
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
    }, { allowDirectUnboundJobForTests: true }),
  };
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

async function loopRounds(runDir) {
  try {
    return JSON.parse(await readFile(narratedQualityPaths(runDir).statePath, "utf8")).rounds.length;
  } catch {
    return 0;
  }
}

test("確定の前にも照合する: 描いた後で画が差し替わった・声のループを始め直した Job は、signoff と品質ループの回を消費せずに止まる", {
  skip: toolchain.ok ? false : "ffmpeg/ffprobe is unavailable",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "narrated-asset-loop-reverify-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const context = await setup(root);
  const jobId = "video-narrated-story-video-a55e71009a0000f1";
  const { runDir } = narratedStoryRunPaths({ deploymentRoot: root, jobId });
  const rendered = await runPastAssetLoops(runner(root, context, jobId).run);
  assert.equal(rendered.status, "awaiting-human-review", JSON.stringify(rendered.knownRemainingIssues));
  assert.ok(rendered.artifacts.previewVideo);
  for (const id of [...NARRATED_ASSET_LOOP_AUDIT_IDS, NARRATED_SCENE_IMAGE_PROVENANCE_AUDIT_ID]) {
    assert.equal(rendered.auditChecks[id].pass, true, `${id}: ${rendered.auditChecks[id].detail}`);
  }
  const state = JSON.parse(await readFile(join(runDir, "pipeline-state.json"), "utf8"));
  assert.equal(state.auditContractVersion, NARRATED_STORY_AUDIT_CONTRACT_VERSION, "state は作った監査契約の版を残す");
  assert.deepEqual(state.assetQualityLoop.scenes.map((row) => row.sceneId), ["s001", "s002"]);
  assert.deepEqual(state.assetQualityLoop.voices.map((row) => row.segmentId), ["s001", "s002"]);
  const manifest = JSON.parse(await readFile(rendered.artifacts.generationManifest.path, "utf8"));
  assert.deepEqual(manifest.assetQualityLoop.counts, {
    sceneImages: { passed: 2, total: 2 },
    characterReferences: { passed: 0, total: 0 },
    voiceTakes: { passed: 2, total: 2 },
  });
  assert.equal(manifest.assetQualityLoop.voiceTakeMeasurements.files, 2);

  const finalize = runner(root, context, jobId, { paid: false }).run;
  await sign(root, context, jobId, rendered, "asset-loop-reverify-review-01");

  // 声のテイクのループを始め直した（採用したテイクは、もう合格した版ではない）。
  const restarted = await startAssetQualityLoop({
    workDir: runDir, harnessId: "narrated-story-video", stage: "voice-take", subjectId: "s001",
    generatorContextId: `production:${jobId}`, restart: true, restartReason: "語尾をもう一度聞き直す（合成）",
  });
  assert.equal(restarted.started, true, JSON.stringify(restarted.issues));
  const blocked = await finalize();
  assert.equal(blocked.status, "awaiting-human-review");
  assert.deepEqual(blocked.knownRemainingIssues, [
    "voice-take-asset-loop-not-passed:s001:review-required",
    "audit-voiceTakeAssetLoopPassed-pending-or-failed",
  ]);
  assert.equal(blocked.assetQualityLoop.pending[0].assetPath, "media/voice/s001.wav");
  assert.equal(await loopRounds(runDir), 0, "signoff を台本の品質ループの回として消費しない");

  // もう一度採点して合格させると、同じ signoff で確定できる。
  await recordAssetLoopRound({ workDir: runDir, stage: "voice-take", subjectId: "s001", assetPath: join(runDir, "media", "voice", "s001.wav"), generatorContextId: `production:${jobId}`, measurementPath: "quality/voice-take-measurements/s001.json" });

  // 描いた画のファイルが差し替わった → 描いた版は合格した版ではないので確定しない。
  const imagePath = join(runDir, "media", "images", "s002.png");
  const original = await readFile(imagePath);
  const tampered = Buffer.from(original);
  tampered[tampered.length - 13] ^= 0xff;
  await writeFile(imagePath, tampered);
  const swapped = await finalize();
  assert.equal(swapped.status, "awaiting-human-review");
  assert.ok(swapped.knownRemainingIssues.includes("scene-image-asset-loop-not-passed:s002:sha256-mismatch"), JSON.stringify(swapped.knownRemainingIssues));
  assert.equal(await loopRounds(runDir), 0);
  await writeFile(imagePath, original);

  const finalized = await finalize();
  assert.equal(finalized.status, "final-audited", JSON.stringify(finalized.knownRemainingIssues));
  assert.ok(Object.values(finalized.auditChecks).every((entry) => entry.pass === true));
  const report = JSON.parse(await readFile(finalized.artifacts.auditReport.path, "utf8"));
  assert.equal(report.contractVersion, NARRATED_STORY_AUDIT_CONTRACT_VERSION);
  for (const id of NARRATED_ASSET_LOOP_AUDIT_IDS) assert.equal(report.auditChecks[id].pass, true, id);
  const receipt = JSON.parse(await readFile(finalized.runReceiptPath, "utf8"));
  assert.equal(receipt.contractVersion, NARRATED_STORY_AUDIT_CONTRACT_VERSION);
  // 監査の証拠に端末のパスを残さない（対象は id と sha256 だけ）。
  assert.equal(JSON.stringify(report.auditChecks[NARRATED_ASSET_LOOP_AUDIT_IDS[0]]).includes(root), false);
});

test("古い契約: 関門が無かった版（v4）の ready state は、品質ループを求めずに当時の契約で従来どおり確定する", {
  skip: toolchain.ok ? false : "ffmpeg/ffprobe is unavailable",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "narrated-asset-loop-legacy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const context = await setup(root);
  const jobId = "video-narrated-story-video-a55e71009a0000f2";
  const { runDir, statePath } = narratedStoryRunPaths({ deploymentRoot: root, jobId });
  const rendered = await runPastAssetLoops(runner(root, context, jobId).run);
  assert.ok(rendered.artifacts.previewVideo);

  // v4 の production が書いた state と自動監査の報告の形にする（当時は関門も場面の画の出どころの保証も無く、
  // state に作った版の印も無い）。報告の SHA は state の成果物の記録に合わせる。
  // v5・v6（見た目の実測）・v7（運営者の動画の品質ループ）・v8（台本の品質ループの合格）・v9（本編の場面の切り替えと
  // 固定の重ね物）で足した監査は、v4 の state と報告には無い。
  const v5Only = new Set([
    ...NARRATED_ASSET_LOOP_AUDIT_IDS, NARRATED_SCENE_IMAGE_PROVENANCE_AUDIT_ID,
    "burnedSubtitlesMeasured", "cameraMotionMeasured", "reviewLayoutMeasured", "episodeOpeningProvenance",
    "operatorVideoAssetLoopPassed", "scriptQualityAccepted", "sceneTransitionMeasured", "fixedOverlaysMeasured",
  ]);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  delete state.auditContractVersion;
  delete state.assetQualityLoop;
  state.auditChecks = Object.fromEntries(Object.entries(state.auditChecks).filter(([id]) => !v5Only.has(id)));
  const reportPath = state.artifacts.auditReport.path;
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  report.contractVersion = LEGACY_CONTRACT;
  report.auditChecks = Object.fromEntries(Object.entries(report.auditChecks).filter(([id]) => !v5Only.has(id)));
  const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(reportPath, reportBytes);
  state.artifacts.auditReport = { path: reportPath, sha256: sha256(reportBytes), bytes: (await stat(reportPath)).size };
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  // 当時は無かったループを、今は合格していない状態にしても確定を止めない（後から求めない）。
  await startAssetQualityLoop({
    workDir: runDir, harnessId: "narrated-story-video", stage: "scene-image", subjectId: "s001",
    generatorContextId: `production:${jobId}`, restart: true, restartReason: "当時の契約で確定することを確かめる（合成）",
  });

  await sign(root, context, jobId, rendered, "asset-loop-legacy-review-01");
  const finalized = await runner(root, context, jobId, { paid: false }).run();
  assert.equal(finalized.status, "final-audited", JSON.stringify(finalized.knownRemainingIssues));
  const finalReport = JSON.parse(await readFile(finalized.artifacts.auditReport.path, "utf8"));
  assert.equal(finalReport.contractVersion, LEGACY_CONTRACT, "当時の契約の版で確定する");
  for (const id of v5Only) assert.equal(id in finalReport.auditChecks, false, `${id} は当時の契約に無い`);
  const receipt = JSON.parse(await readFile(finalized.runReceiptPath, "utf8"));
  assert.equal(receipt.contractVersion, LEGACY_CONTRACT);

  // 共通の RunReceipt の記録（当時の必須監査・当時の契約の版）も合格し、足した保証は「当時は無かった」になる。
  const declaration = JSON.parse(await readFile(join(repoRoot, "config", "harnesses", "narrated-story-video.harness.json"), "utf8"));
  const past = JSON.parse(await readFile(join(repoRoot, "test", "fixtures", "narrated-past-contract-audits.json"), "utf8"))
    .contracts.find((entry) => entry.version === LEGACY_CONTRACT);
  const common = openRunReceipt({ projectDir: repoRoot, harnessId: "narrated-story-video", entrypoint: "scripts/run-video-harness.mjs", action: "audit" });
  recordGatesFromAuditChecks(common, {
    declaration,
    checks: finalReport.auditChecks,
    requiredAuditIds: past.requiredAudits,
    contractVersion: finalReport.contractVersion,
  });
  const done = finalizeRunReceipt(common, { outcome: "pass", timestamp: "2026-09-25T00:00:00.000Z" });
  assert.equal(done.outcome, "pass", `不合格 ${done.summary.failedGates.join(", ")} / 未測定 ${done.summary.skippedGates.join(", ")}`);
  assert.deepEqual([...done.summary.notInForceGates].sort(), [
    "asset-quality-loop", "burned-subtitles-legible", "camera-motion-declared", "episode-opening-provenance", "fixed-overlays-declared",
    "operator-video-asset-loop", "review-layout", "scene-image-provenance", "scene-transition-declared", "script-quality-accepted",
  ]);
});
