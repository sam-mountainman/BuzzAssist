#!/usr/bin/env node

// 運営者の画の取り込みの記録の場面ごとの焦点（cameraFocus）を、ナレーション物語の公式経路で使う。
// 焦点は「取り込みの記録 → 台本パッケージ → Pack の型ごとの焦点」の順に決まり、完成 MP4 で計画の焦点を測る。
// 焦点は画の後で決まる値なので、台本パッケージのバイト列（台本の品質ループの合格が結び付く）を変えずに渡せることも
// 確かめる。合成の Pack・台本パッケージ・画（lavfi の模様）・声だけを使い、有料 API もネットワークも使わない。

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveFfmpegToolchain } from "../lib/harnessRuntimeResolver.mjs";
import {
  KOYA_REVIEWER_TRUST_JSON_ENV,
  KOYA_REVIEWER_TRUST_PATH_ENV,
  REVIEWER_TRUST_JSON_ENV,
  REVIEWER_TRUST_PATH_ENV,
  REVIEWER_TRUST_VERSION,
  createReviewerTrustEntry,
  generateReviewerKeyPair,
} from "../lib/koyaReviewAttestation.mjs";
import { inspectNarratedStoryPlan, narratedStoryRunPaths } from "../lib/narratedStoryPipeline.mjs";
import { runNarratedStoryVideo } from "../lib/narratedStoryVideo.mjs";
import { operatorImportDigests, videoHarnessInputIdentity } from "../lib/videoHarnessUpdateFinalize.mjs";
import { createVideoHarnessJob } from "../lib/videoHarnessJob.mjs";
import { passOperatorImageLoops, runPastAssetLoops } from "./fixtures/narratedAssetLoopFixture.mjs";
import { bookendFixtureAdapters, createBookendFixtureMedia, passingVoiceQualityGate } from "./fixtures/narratedBookendFixture.mjs";
import { makeTexturedStill } from "./fixtures/narratedVisualFixture.mjs";
import {
  FIXTURE_REFERENCE_SHA256,
  FIXTURE_REFERENCE_SHEET,
  writeManifest,
  writeOperatorImageFolder,
} from "./fixtures/operatorImageFixture.mjs";
import { acceptScriptForTests } from "./helpers/scriptQualityAcceptance.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const toolchain = await resolveFfmpegToolchain();
const TRUST_ENV_NAMES = [REVIEWER_TRUST_PATH_ENV, REVIEWER_TRUST_JSON_ENV, KOYA_REVIEWER_TRUST_PATH_ENV, KOYA_REVIEWER_TRUST_JSON_ENV];
const IDENTITY = "c".repeat(64);
const RENDER = { width: 640, height: 360, fps: 24 };
// 運営者の見本のような、ごく小さな寄り（1.010 倍）とパン（test/narratedStoryVisualsPipeline.test.mjs と同じ）。
const FOCUS_CAMERA_PACK = {
  moves: { "slow-push-in": { zoomPerSecond: 0.03, maxZoom: 1.01 }, "pan-left": { panPerSecond: 0.005, zoom: 1.02 } },
  sequence: ["slow-push-in"],
};
// 本編の4つの場面。p1 は取り込みの記録だけ（2つの文に分かれる）、p2 は台本パッケージだけ、p3 は両方に同じ値、
// p4 はどちらにも無い（Pack の型ごとの焦点）。
const STORY = [
  { id: "p1", text: "最初の物語です。次の場面です。" },
  { id: "p2", text: "最初の物語です。", camera: "pan-left", cameraFocus: { x: 0.7, y: 0.75 } },
  { id: "p3", text: "次の場面です。", cameraFocus: { x: 0.25, y: 0.6 } },
  { id: "p4", text: "終わりの場面です。" },
];
const IMAGE_FOCUS = { p1: { x: 0.2, y: 0.3 }, p3: { x: 0.25, y: 0.6 } };

function cleanTrustEnv(overrides = {}) {
  const env = { ...process.env };
  for (const name of TRUST_ENV_NAMES) delete env[name];
  return { ...env, ...overrides };
}

async function trustEnv(dir) {
  const reviewer = generateReviewerKeyPair();
  const trustPath = join(dir, "operator-reviewer-trust.json");
  await writeFile(trustPath, JSON.stringify({
    version: REVIEWER_TRUST_VERSION,
    reviewers: [createReviewerTrustEntry({ publicKeyPem: reviewer.publicKeyPem, label: "operator image focus reviewer" })],
  }), "utf8");
  return cleanTrustEnv({ [REVIEWER_TRUST_PATH_ENV]: trustPath });
}

function packConfig() {
  return {
    version: "fixture-operator-image-focus-pack-v1",
    runtime: { imageModel: "fixture-image-v1", ttsProvider: "fixture-voice" },
    image: {
      provider: "fixture-image",
      model: "fixture-image-v1",
      adapterVersion: "fixture-image-adapter-v1",
      source: "operator-file",
      operatorFile: { manifest: { location: "job-option" }, tolerancePx: 2, approvedReferences: { sha256: [FIXTURE_REFERENCE_SHA256] } },
    },
    voice: { provider: "fixture-voice", model: "fixture-voice-v1", adapterVersion: "fixture-voice-adapter-v1", voiceId: "fixture-ja", speed: 1 },
    music: { provider: "fixture-music", model: "fixture-music-v1", adapterVersion: "fixture-music-adapter-v1", prompt: "quiet fixture ambient bed", gain: 0.01 },
    render: RENDER,
    concurrency: 2,
    bookends: { enabled: false },
    camera: FOCUS_CAMERA_PACK,
  };
}

function scriptPackage(story) {
  return `${JSON.stringify({ format: "buzzassist-narrated-script-package-v1", story }, null, 2)}\n`;
}

/**
 * Pack・台本パッケージ（人がそのまま使うと認めた版）・運営者の画のフォルダ（模様の画・取り込みの記録・品質ループの合格）
 * を並べる。imageFocus: 場面 id → 取り込みの記録に書く焦点。
 */
async function setup(root, { imageFocus = IMAGE_FOCUS, story = STORY } = {}) {
  const payloadDir = join(root, "signed-channel-pack-payload");
  await mkdir(payloadDir, { recursive: true });
  await writeFile(join(payloadDir, "narrated-story.json"), `${JSON.stringify(packConfig(), null, 2)}\n`, "utf8");
  const scriptPath = join(root, "script", "script-package.json");
  await mkdir(join(root, "script"), { recursive: true });
  await writeFile(scriptPath, scriptPackage(story), "utf8");
  // 台本は人がそのまま使うと認めた版（台本の関門は、このバイト列に結び付く）。
  await acceptScriptForTests(scriptPath);
  const operatorDir = join(root, "operator-images");
  const scenes = [];
  for (const [index, entry] of story.entries()) {
    const stillPath = join(root, "stills", `${entry.id}.png`);
    await mkdir(join(root, "stills"), { recursive: true });
    await makeTexturedStill(toolchain, stillPath, { ...RENDER, phase: index * 37 });
    scenes.push({
      sceneId: entry.id,
      width: RENDER.width,
      height: RENDER.height,
      bytes: await readFile(stillPath),
      ...(imageFocus[entry.id] ? { cameraFocus: imageFocus[entry.id] } : {}),
    });
  }
  const folder = await writeOperatorImageFolder(operatorDir, scenes);
  await passOperatorImageLoops({
    folder: operatorDir,
    manifestPath: folder.manifestPath,
    manifest: folder.manifest,
    referenceSheets: new Map([[FIXTURE_REFERENCE_SHA256, FIXTURE_REFERENCE_SHEET]]),
    writeManifest,
  });
  return { payloadDir, scriptPath, operatorDir, ...folder };
}

/** 有料の画の Media Job が1件でも来たら落とす fixture adapter。 */
function operatorAdapters(fixture) {
  const base = bookendFixtureAdapters(fixture);
  return {
    calls: base.calls,
    mediaJobProbe: base.mediaJobProbe,
    mediaJobRunner: async (spec) => {
      if (spec.kind === "image.generation") throw new Error("operator-file jobs must not submit paid image Media Jobs");
      return base.mediaJobRunner(spec);
    },
  };
}

function runOptions({ root, env, setupResult, jobId }) {
  return {
    command: "full",
    scriptPath: setupResult.scriptPath,
    channelPackDir: setupResult.payloadDir,
    jobId,
    jobIdentityDigest: IDENTITY,
    deploymentRoot: root,
    ffmpegToolchain: toolchain,
    voiceQualityGate: passingVoiceQualityGate,
    operatorImageManifestPath: setupResult.manifestPath,
    env,
  };
}

const AUTOMATIC_EXEMPT = new Set(["perceptualReviewChecks", "perceptualReviewBoundToOutput", "perceptualEvidenceHashes", "contactSheetOriginalDetailReviewed", "qualityLoopPassed", "characterIdentityReviewed"]);

function assertAutomaticAuditsPass(outcome) {
  for (const [auditId, value] of Object.entries(outcome.auditChecks || {})) {
    if (AUTOMATIC_EXEMPT.has(auditId)) continue;
    const failedRows = [...(value.measurement?.cues || []), ...(value.measurement?.shots || [])].filter((row) => row.pass === false);
    assert.equal(value.pass, true, `${auditId}: ${value.detail} ${JSON.stringify(failedRows.map((row) => [row.id, row.problems]))}`);
  }
}

test("plan-only: 取り込みの記録と台本パッケージの焦点が食い違えば有料生成の前に止まり、記録の焦点を直しても Job ID は同じで入力の同一性だけが変わる。台本パッケージへ書き足すと台本の合格が外れる", {
  skip: toolchain.ok ? false : "ffmpeg/ffprobe is unavailable",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "narrated-operator-focus-plan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = await setup(root);
  const inspect = () => inspectNarratedStoryPlan({ scriptPath: project.scriptPath, channelPackDir: project.payloadDir, operatorImageManifestPath: project.manifestPath, projectDir: root });
  // 取り込みの記録だけ・台本パッケージだけ・両方に同じ値・どちらにも無い、は全部通る（台本の関門も通る）。
  const ready = await inspect();
  assert.equal(ready.ok, true, ready.blockers.join(", "));
  assert.equal(ready.scriptQuality.acceptedBy, "human");

  // 記録の焦点を直しても、Job の識別子の材料（options の記録のパス）は変わらないので同じ Job に付く。
  // 記録の本文の SHA は入力の同一性（Job と RunReceipt に残る）と pipeline の入力の指紋に入り、同じ Job の resume で描き直す。
  const validateProductionProfile = async () => ({ profileId: "operator-production", fixture: "narrated-operator-image-focus" });
  const options = { operatorImageManifestPath: project.manifestPath };
  const planned = await createVideoHarnessJob({ projectDir: root, scriptPath: project.scriptPath, channelPackPath: project.payloadDir, harnessId: "narrated-story-video", options, validateProductionProfile });
  const identityOf = async () => videoHarnessInputIdentity({ harnessId: "narrated-story-video", scriptSha256: sha256(await readFile(project.scriptPath)), options, operatorImports: await operatorImportDigests(options) });
  const before = await identityOf();
  project.manifest.scenes[0].cameraFocus = { x: 0.8, y: 0.7 };
  await writeManifest(project.manifestPath, project.manifest);
  const again = await createVideoHarnessJob({ projectDir: root, scriptPath: project.scriptPath, channelPackPath: project.payloadDir, harnessId: "narrated-story-video", options, validateProductionProfile });
  assert.equal(again.attached, true);
  assert.equal(again.job.id, planned.job.id, "Job ID の材料は記録のパス（中身ではない）");
  const after = await identityOf();
  assert.notEqual(after.digest, before.digest, "記録の焦点を直すと入力の同一性が変わる");
  assert.equal(after.scriptSha256, before.scriptSha256, "台本のバイト列は同じ");
  assert.equal((await inspect()).ok, true, "直した焦点でも台本の関門を通る");

  // 取り込みの記録と台本パッケージの両方に書いて、値が違う: 有料生成の前に場面 id と理由コードで止まる。
  project.manifest.scenes[2].cameraFocus = { x: 0.3, y: 0.6 };
  await writeManifest(project.manifestPath, project.manifest);
  const conflict = await inspect();
  assert.equal(conflict.ok, false);
  assert.deepEqual(conflict.blockers, ["camera-focus-conflict:p3:image-vs-package"]);
  // 記録の焦点の形の誤りは、取り込みの検査が台本パッケージと同じ欄の名前で止める。
  project.manifest.scenes[2].cameraFocus = { x: 0.25, y: 1.6 };
  await writeManifest(project.manifestPath, project.manifest);
  assert.ok((await inspect()).blockers.includes("operator-image-manifest-invalid:scenes[2].cameraFocus.y"));
  project.manifest.scenes[2].cameraFocus = IMAGE_FOCUS.p3;
  await writeManifest(project.manifestPath, project.manifest);
  assert.equal((await inspect()).ok, true);

  // 同じ焦点を、画の後で台本パッケージへ書き足すと、台本のバイト列が変わり台本の合格が外れる（だから記録に書く）。
  await writeFile(project.scriptPath, scriptPackage(STORY.map((entry) => (entry.id === "p1" ? { ...entry, cameraFocus: { x: 0.8, y: 0.7 } } : entry))), "utf8");
  const edited = await inspect();
  assert.equal(edited.ok, false);
  assert.ok(edited.blockers.some((blocker) => blocker.startsWith("script-quality-required:")), edited.blockers.join(", "));
});

test("公式経路: 焦点は取り込みの記録 → 台本パッケージ → Pack の型ごとの焦点の順に決まり、完成 MP4 で計画の焦点を測る。記録の焦点を直して resume すると、声と BGM を払い直さずに描き直し、台本の合格はそのまま", {
  skip: toolchain.ok ? false : "ffmpeg/ffprobe is unavailable",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "narrated-operator-focus-run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = await trustEnv(root);
  const fixture = await createBookendFixtureMedia(join(root, "fixture-media"), toolchain);
  const project = await setup(root);
  const scriptBytes = await readFile(project.scriptPath);
  const adapters = operatorAdapters(fixture);
  const jobId = "video-narrated-story-video-0f0cus0image00001";
  const base = runOptions({ root, env, setupResult: project, jobId });
  const first = await runPastAssetLoops(() => runNarratedStoryVideo({ ...base, mediaJobRunner: adapters.mediaJobRunner, mediaJobProbe: adapters.mediaJobProbe }, { allowDirectUnboundJobForTests: true }));
  assert.equal(first.status, "awaiting-human-review", JSON.stringify(first.knownRemainingIssues));
  assertAutomaticAuditsPass(first);
  assert.equal(first.auditChecks.scriptQualityAccepted.pass, true, "台本の関門を通る");
  assert.deepEqual(adapters.calls.kinds.filter((kind) => kind === "image.generation"), [], "画の有料 Media Job は0件");

  // 計画のショットに焦点の出どころが残る（取り込みの記録・台本パッケージ・両方に同じ値は記録・どちらにも無ければ pack）。
  const manifest = JSON.parse(await readFile(first.artifacts.generationManifest.path, "utf8"));
  assert.deepEqual(manifest.camera.shots.map((shot) => [shot.imageKey, shot.segmentIds.length, shot.focusSource, shot.focus || null]), [
    ["p1", 2, "image-manifest", { x: 0.2, y: 0.3, source: "image-manifest" }],
    ["p2", 1, "script-package", { x: 0.7, y: 0.75, source: "script-package" }],
    ["p3", 1, "image-manifest", { x: 0.25, y: 0.6, source: "image-manifest" }],
    ["p4", 1, "pack", null],
  ]);
  // 同じ場面の文（話者・文ごとに分けた文）は同じ焦点のまま。
  for (const segment of manifest.segments.filter((row) => row.sourceSegmentId === "p1")) assert.deepEqual(segment.cameraFocus, { x: 0.2, y: 0.3 });
  // 取り込みの記録の公開の行にも焦点が残る（数だけ）。
  assert.deepEqual(manifest.operatorImages.scenes.map((row) => row.cameraFocus || null), [{ x: 0.2, y: 0.3 }, null, { x: 0.25, y: 0.6 }, null]);

  // 監査は、どこから来た焦点でも計画の焦点で測る（焦点の無い p4 は測らない）。
  const focus = first.auditChecks.cameraFocusMeasured;
  assert.equal(focus.pass, true, focus.detail);
  assert.deepEqual(focus.measurement.shots.map((shot) => [shot.segmentIds[0].split(".")[0], shot.focus.source, shot.pass]), [
    ["p1", "image-manifest", true],
    ["p2", "script-package", true],
    ["p3", "image-manifest", true],
  ]);
  const p1 = focus.measurement.shots[0];
  assert.equal(p1.distinguishableFromPackFocus, true, "取り込みの記録の焦点が効いている（Pack の型ごとの焦点の見せ方と見分けられる）");

  // 画の後で記録の焦点を直して、同じ Job を resume する。台本のバイト列は変わらず台本の関門を通ったまま、
  // 声と BGM は同じ requestKey の完成品を使って払い直さず、取り込んだ画も作り直さずに、新しい焦点で描き直す。
  const paidAfterFirst = adapters.calls.generation;
  const imagesDir = join(narratedStoryRunPaths({ deploymentRoot: root, jobId }).runDir, "media", "images");
  const importedBefore = await stat(join(imagesDir, "p1.png"));
  project.manifest.scenes[0].cameraFocus = { x: 0.8, y: 0.7 };
  await writeManifest(project.manifestPath, project.manifest);
  const noPaid = {
    mediaJobRunner: async () => { throw new Error("resume must not re-bill voices or music"); },
    mediaJobProbe: adapters.mediaJobProbe,
  };
  const moved = await runNarratedStoryVideo({ ...base, ...noPaid }, { allowDirectUnboundJobForTests: true });
  assert.equal(moved.status, "awaiting-human-review", JSON.stringify(moved.knownRemainingIssues));
  assertAutomaticAuditsPass(moved);
  assert.equal(adapters.calls.generation, paidAfterFirst, "no new paid Media Job");
  assert.deepEqual(await readFile(project.scriptPath), scriptBytes, "台本パッケージのバイト列は変わらない");
  assert.equal(moved.auditChecks.scriptQualityAccepted.pass, true, "台本の合格はそのまま");
  assert.notEqual(moved.imageSource.manifestSha256, first.imageSource.manifestSha256);
  assert.notEqual(moved.imageSource.digest, first.imageSource.digest);
  assert.notEqual(moved.artifacts.previewVideo.sha256, first.artifacts.previewVideo.sha256, "新しい焦点で描き直す");
  assert.equal((await stat(join(imagesDir, "p1.png"))).mtimeMs, importedBefore.mtimeMs, "焦点だけを直したら画は取り込み直さない");
  const movedFocus = moved.auditChecks.cameraFocusMeasured;
  assert.equal(movedFocus.pass, true, movedFocus.detail);
  assert.deepEqual(movedFocus.measurement.shots[0].focus, { x: 0.8, y: 0.7, source: "image-manifest" });
  assert.deepEqual(moved.mediaJobs.map((row) => row.requestKey).sort(), first.mediaJobs.map((row) => row.requestKey).sort());
});

test("公式経路: 取り込みの記録と台本パッケージの焦点が違えば、有料の probe も Media Job も出さずに理由コードで止まる", {
  skip: toolchain.ok ? false : "ffmpeg/ffprobe is unavailable",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "narrated-operator-focus-conflict-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = await trustEnv(root);
  const fixture = await createBookendFixtureMedia(join(root, "fixture-media"), toolchain);
  const project = await setup(root, { imageFocus: { ...IMAGE_FOCUS, p2: { x: 0.3, y: 0.75 } } });
  const adapters = operatorAdapters(fixture);
  const outcome = await runNarratedStoryVideo({
    ...runOptions({ root, env, setupResult: project, jobId: "video-narrated-story-video-0f0cus0conflict01" }),
    mediaJobRunner: adapters.mediaJobRunner,
    mediaJobProbe: adapters.mediaJobProbe,
  }, { allowDirectUnboundJobForTests: true });
  assert.equal(outcome.status, "awaiting-operator-input");
  assert.deepEqual(outcome.knownRemainingIssues, ["camera-focus-conflict:p2:image-vs-package"]);
  assert.equal(outcome.execution.paidGenerationAttempted, false);
  assert.equal(adapters.calls.generation, 0, "有料生成へ進まない");
  assert.equal(adapters.calls.probe, 0, "adapter の probe もしない");
});
