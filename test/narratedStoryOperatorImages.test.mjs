#!/usr/bin/env node
// 運営者が用意した本編の画（image.source: operator-file）を、来歴つきで公式経路へ取り込む。
// 合成の Pack・台本・画（試験内で作る小さな PNG）だけを使い、有料 API もネットワークも使わない。

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveCanvasFile } from "../lib/canvasScene.mjs";
import { resolveCanvasRunStateFile } from "../lib/canvasRunState.mjs";
import {
  CHANNEL_PACK_RUNTIME_VERSION,
  extractNarratedChannelPackRuntime,
  validateChannelPackRuntime,
} from "../lib/harnessChannelPackRuntime.mjs";
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
import { NARRATED_STORY_AUDIT_IDS } from "../lib/narratedStoryOutcome.mjs";
import {
  NARRATED_SCENE_IMAGE_PROVENANCE_AUDIT_ID,
  inspectNarratedStoryPlan,
  loadNarratedStoryChannelConfig,
  narratedStoryRunPaths,
  writeNarratedReviewSignoff,
} from "../lib/narratedStoryPipeline.mjs";
import {
  OPERATOR_IMAGE_MANIFEST_UNBOUND_CODE,
  assertOperatorImageManifestBoundToJob,
  runNarratedStoryVideo,
} from "../lib/narratedStoryVideo.mjs";
import { OPERATOR_IMAGE_COST_BASIS, OPERATOR_IMAGE_POLICY_FIELDS } from "../lib/operatorImageImport.mjs";
import { _testing as adapterTesting, executeVideoHarnessAdapter } from "../lib/videoHarnessAdapters.mjs";
import { projectVideoHarnessJob } from "../lib/videoHarnessCanvasAdapter.mjs";
import { createVideoHarnessJob, runVideoHarnessJob } from "../lib/videoHarnessJob.mjs";
import {
  bookendFixtureAdapters,
  createBookendFixtureMedia,
  passingVoiceQualityGate,
} from "./fixtures/narratedBookendFixture.mjs";
import {
  FIXTURE_REFERENCE_SHA256,
  FIXTURE_REFERENCE_SHEET,
  fixtureConversationUrl,
  replaceImage,
  writeManifest,
  writeOperatorImageFolder,
} from "./fixtures/operatorImageFixture.mjs";
import {
  passOperatorImageLoops,
  passPendingNarratedAssetLoops,
  recordAssetLoopRound,
  runPastAssetLoops,
} from "./fixtures/narratedAssetLoopFixture.mjs";
import { acceptScriptForTests } from "./helpers/scriptQualityAcceptance.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const toolchain = await resolveFfmpegToolchain();
const TRUST_ENV_NAMES = [REVIEWER_TRUST_PATH_ENV, REVIEWER_TRUST_JSON_ENV, KOYA_REVIEWER_TRUST_PATH_ENV, KOYA_REVIEWER_TRUST_JSON_ENV];
const SCRIPT = "最初の物語です。次の場面です。";
const IDENTITY = "c".repeat(64);
const PERCEPTUAL = new Set([
  "perceptualReviewChecks",
  "perceptualReviewBoundToOutput",
  "perceptualEvidenceHashes",
  "contactSheetOriginalDetailReviewed",
  "qualityLoopPassed",
  "characterIdentityReviewed",
]);

function cleanTrustEnv(overrides = {}) {
  const env = { ...process.env };
  for (const name of TRUST_ENV_NAMES) delete env[name];
  return { ...env, ...overrides };
}

function packConfig({ image = {}, operatorFile = {}, source = "operator-file" } = {}) {
  return {
    version: "fixture-operator-image-pack-v1",
    runtime: { imageModel: "fixture-image-v1", ttsProvider: "fixture-voice" },
    image: {
      provider: "fixture-image",
      model: "fixture-image-v1",
      adapterVersion: "fixture-image-adapter-v1",
      ...(source === "operator-file"
        ? {
          source,
          operatorFile: {
            manifest: { location: "job-option" },
            tolerancePx: 2,
            approvedReferences: { sha256: [FIXTURE_REFERENCE_SHA256] },
            ...operatorFile,
          },
        }
        : { stylePrompt: "flat fixture illustration with no embedded text" }),
      ...image,
    },
    voice: { provider: "fixture-voice", model: "fixture-voice-v1", adapterVersion: "fixture-voice-adapter-v1", voiceId: "fixture-ja", speed: 1 },
    music: { provider: "fixture-music", model: "fixture-music-v1", adapterVersion: "fixture-music-adapter-v1", prompt: "quiet fixture ambient bed", gain: 0.01 },
    render: { width: 320, height: 180, fps: 12 },
    concurrency: 2,
    bookends: { enabled: false },
  };
}

async function writePack(dir, config) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "narrated-story.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/**
 * 取り込みの記録（1本目は 1px 広い画、2本目は決まった寸法の画）と、台本と Pack を並べる。
 * loops: 運営者のフォルダで、本編の画と参照の設定画の品質ループを本物の実装で合格させ、記録に assetLoop を書く。
 */
async function setupRoot(root, { packOptions = {}, scenes = null, loops = false } = {}) {
  const payloadDir = join(root, "signed-channel-pack-payload");
  await writePack(payloadDir, packConfig(packOptions));
  const scriptPath = join(root, "raw-script.txt");
  await writeFile(scriptPath, `${SCRIPT}\n`, "utf8");
  // 台本の関門（監査契約 v8 から）はこの試験の対象外。台本を人がそのまま使うと認めた記録を置く。
  await acceptScriptForTests(scriptPath);
  const operatorDir = join(root, "operator-images");
  const folder = await writeOperatorImageFolder(operatorDir, scenes || [
    { sceneId: "s001", width: 321, height: 180 },
    { sceneId: "s002", width: 320, height: 180 },
  ]);
  const loopSetup = loops
    ? await passOperatorImageLoops({
      folder: operatorDir,
      manifestPath: folder.manifestPath,
      manifest: folder.manifest,
      referenceSheets: new Map([[FIXTURE_REFERENCE_SHA256, FIXTURE_REFERENCE_SHEET]]),
      writeManifest,
    })
    : null;
  return { payloadDir, scriptPath, operatorDir, ...folder, approvedReferencesPath: loopSetup?.approvedReferencesPath || "" };
}

/** 有料の画の Media Job が1件でも来たら落とす fixture adapter。 */
function operatorAdapters(fixture) {
  const base = bookendFixtureAdapters(fixture);
  const probedKinds = [];
  return {
    calls: base.calls,
    probedKinds,
    mediaJobProbe: async (adapter) => {
      probedKinds.push(adapter.kind);
      return base.mediaJobProbe(adapter);
    },
    mediaJobRunner: async (spec) => {
      if (spec.kind === "image.generation") throw new Error("operator-file jobs must not submit paid image Media Jobs");
      return base.mediaJobRunner(spec);
    },
  };
}

async function reviewerSetup(root) {
  const reviewer = generateReviewerKeyPair();
  const trustPath = join(root, "operator-reviewer-trust.json");
  await writeFile(trustPath, JSON.stringify({
    version: REVIEWER_TRUST_VERSION,
    reviewers: [createReviewerTrustEntry({ publicKeyPem: reviewer.publicKeyPem, label: "operator image e2e reviewer" })],
  }), "utf8");
  return { reviewer, trustPath, env: cleanTrustEnv({ [REVIEWER_TRUST_PATH_ENV]: trustPath }) };
}

function reviewScores(outcome) {
  return Object.fromEntries((outcome?.review?.quality?.rubric || []).map((criterion) => [criterion.id, 96]));
}

async function filesBelow(dir) {
  const out = [];
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await filesBelow(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

test("Pack の宣言: operator-file は画風の指示を要らず、durable Job の記録に画の出どころが残り、知らない欄は拒む", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "narrated-operator-pack-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pack = join(root, "pack");
  await writePack(pack, packConfig());
  const loaded = await loadNarratedStoryChannelConfig(pack);
  assert.equal(loaded.ok, true, loaded.blockers.join(", "));
  assert.equal(loaded.config.image.source, "operator-file");
  assert.equal(loaded.config.imageImport.manifestLocation, "job-option");
  const payloadSha256 = "d".repeat(64);
  const runtime = await extractNarratedChannelPackRuntime({ payloadDir: pack, evidence: { harnessId: "narrated-story-video", payloadSha256 } });
  assert.equal(runtime.imageSource, "operator-file");
  assert.equal(runtime.version, CHANNEL_PACK_RUNTIME_VERSION);
  assert.deepEqual(validateChannelPackRuntime(runtime, { harnessId: "narrated-story-video", payloadSha256 }), runtime);
  assert.throws(() => validateChannelPackRuntime({ ...runtime, imageSource: "broker" }, { harnessId: "narrated-story-video", payloadSha256 }), /imageSource/u);
  // Pack の形の検査（durable Job へ持ち込む前）は、取り込みの規則の欄を全部受ける（一覧が食い違わない）。
  const everyField = {
    manifest: { location: "job-option" },
    expectedSize: { width: 320, height: 180 },
    tolerancePx: 1,
    fit: "cover-center-crop",
    approvedReferences: { sha256: [FIXTURE_REFERENCE_SHA256], characterRegistry: false },
    requireAssetLoopPass: false,
  };
  assert.deepEqual(Object.keys(everyField).sort(), [...OPERATOR_IMAGE_POLICY_FIELDS].sort());
  await writePack(pack, packConfig({ operatorFile: everyField }));
  await extractNarratedChannelPackRuntime({ payloadDir: pack, evidence: { harnessId: "narrated-story-video", payloadSha256 } });
  assert.equal((await loadNarratedStoryChannelConfig(pack)).ok, true);
  await writePack(pack, packConfig({ operatorFile: { perSceneBroker: true } }));
  await assert.rejects(
    () => extractNarratedChannelPackRuntime({ payloadDir: pack, evidence: { harnessId: "narrated-story-video", payloadSha256 } }),
    /unsupported fields: perSceneBroker/u,
  );
  await writePack(pack, packConfig({ image: { source: "mixed" } }));
  await assert.rejects(
    () => extractNarratedChannelPackRuntime({ payloadDir: pack, evidence: { harnessId: "narrated-story-video", payloadSha256 } }),
    /image\.source must be broker or operator-file/u,
  );
  // broker の Pack は従来どおりの記録（imageSource を持たない）で、画風の指示が要る。
  await writePack(pack, packConfig({ source: "broker" }));
  const broker = await extractNarratedChannelPackRuntime({ payloadDir: pack, evidence: { harnessId: "narrated-story-video", payloadSha256 } });
  assert.equal("imageSource" in broker, false);
  await writePack(pack, packConfig({ source: "broker", image: { stylePrompt: undefined } }));
  assert.ok((await loadNarratedStoryChannelConfig(pack)).blockers.includes("image.stylePrompt"));
});

test("plan-only: 取り込みの記録を読むだけで検査し、manifest が無い・broker の Pack に渡した、を名指しで返す", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "narrated-operator-plan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { payloadDir, scriptPath, manifestPath, manifest, operatorDir } = await setupRoot(root);
  // 品質ループの記録（assetLoop）の無い取り込みは、有料の処理の前に場面 ID と理由コードで止まる。
  const unlooped = await inspectNarratedStoryPlan({ scriptPath, channelPackDir: payloadDir, operatorImageManifestPath: manifestPath, projectDir: root });
  assert.deepEqual(unlooped.blockers, [
    "scene-image-asset-loop-not-passed:s001:record-required",
    "scene-image-asset-loop-not-passed:s002:record-required",
  ]);
  await passOperatorImageLoops({ folder: operatorDir, manifestPath, manifest, referenceSheets: new Map([[FIXTURE_REFERENCE_SHA256, FIXTURE_REFERENCE_SHEET]]), writeManifest });
  const ready = await inspectNarratedStoryPlan({ scriptPath, channelPackDir: payloadDir, operatorImageManifestPath: manifestPath, projectDir: root });
  assert.equal(ready.ok, true, ready.blockers.join(", "));
  assert.equal(ready.imageSource, "operator-file");
  assert.equal(ready.operatorImages.scenes, 2);
  assert.equal(ready.paidCallsAttempted, false);
  const missing = await inspectNarratedStoryPlan({ scriptPath, channelPackDir: payloadDir });
  assert.deepEqual(missing.blockers, ["operator-image-manifest-required"]);
  const brokerPack = join(root, "broker-pack");
  await writePack(brokerPack, packConfig({ source: "broker" }));
  const unexpected = await inspectNarratedStoryPlan({ scriptPath, channelPackDir: brokerPack, operatorImageManifestPath: manifestPath });
  assert.deepEqual(unexpected.blockers, ["operator-image-manifest-unexpected"]);
  assert.equal(unexpected.imageSource, "broker");
});

test("adapter: Job の options.operatorImageManifestPath を子へ渡し、子は Job の宣言と違う manifest を拒む", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "narrated-operator-adapter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"), { recursive: true });
  await writeFile(join(root, "scripts", "narrated-story-video.mjs"), "// fixture entrypoint\n");
  const manifestPath = join(root, "operator", "operator-images.json");
  const job = {
    id: "video-narrated-story-video-00000000000000ae",
    harness: { id: "narrated-story-video" },
    projectDir: root,
    runDir: join(root, "run"),
    revision: 2,
    script: { path: join(root, "script.json") },
    options: { operatorImageManifestPath: manifestPath },
    deployment: { root, entrypoint: "node scripts/narrated-story-video.mjs" },
    stages: [{ id: "doctor", status: "pass", evidence: { ready: true } }],
  };
  const seen = [];
  await executeVideoHarnessAdapter({
    job,
    prepareResult: { payloadDir: join(root, "pack") },
    runChild: async (command, args) => { seen.push(args); return { code: 3, signal: null, stdout: "{}", stderr: "" }; },
  });
  const at = seen[0].indexOf("--operator-image-manifest");
  assert.ok(at > 0, "Job の宣言を子へ渡す");
  assert.equal(seen[0][at + 1], manifestPath);
  seen.length = 0;
  await executeVideoHarnessAdapter({ job: { ...job, options: {} }, prepareResult: { payloadDir: join(root, "pack") }, runChild: async (command, args) => { seen.push(args); return { code: 3, signal: null, stdout: "{}", stderr: "" }; } });
  assert.equal(seen[0].includes("--operator-image-manifest"), false);
  assert.equal(typeof adapterTesting.collectNarratedArtifacts, "function");

  // 子の照合（上位 Job の job.json の options と、子へ渡った path）。
  const jobPath = join(root, "job.json");
  await writeFile(jobPath, JSON.stringify({ options: { operatorImageManifestPath: manifestPath } }));
  await assertOperatorImageManifestBoundToJob({ upstreamJobPath: jobPath, operatorImageManifestPath: manifestPath });
  for (const passed of ["", join(root, "other", "operator-images.json")]) {
    await assert.rejects(
      assertOperatorImageManifestBoundToJob({ upstreamJobPath: jobPath, operatorImageManifestPath: passed }),
      (error) => error?.code === OPERATOR_IMAGE_MANIFEST_UNBOUND_CODE,
    );
  }
  await writeFile(jobPath, JSON.stringify({ options: {} }));
  await assertOperatorImageManifestBoundToJob({ upstreamJobPath: jobPath, operatorImageManifestPath: "" });
  await assert.rejects(
    assertOperatorImageManifestBoundToJob({ upstreamJobPath: jobPath, operatorImageManifestPath: manifestPath }),
    (error) => error?.code === OPERATOR_IMAGE_MANIFEST_UNBOUND_CODE,
    "Job が宣言していない manifest を子だけに渡す道を残さない",
  );
});

test("公式経路: 取り込みの検査に落ちたら、有料の probe も Media Job も1件も出さずに理由コードで止まる", {
  skip: toolchain.ok ? false : "ffmpeg/ffprobe is unavailable",
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "narrated-operator-stop-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const { env } = await reviewerSetup(temp);
  const fixture = await createBookendFixtureMedia(join(temp, "fixture-media"), toolchain);
  const cases = [
    { id: "manifest-required", expect: ["operator-image-manifest-required"], manifest: () => "" },
    { id: "scene-missing", expect: ["operator-image-scene-missing:s002"], scenes: [{ sceneId: "s001", width: 320, height: 180 }] },
    {
      id: "reference-unapproved",
      expect: [`operator-image-reference-unapproved:s002:${"a".repeat(12)}`],
      scenes: [{ sceneId: "s001", width: 320, height: 180 }, { sceneId: "s002", width: 320, height: 180, referenceSha256s: ["a".repeat(64)] }],
    },
    {
      id: "reused-without-reason",
      expect: ["operator-image-reused-without-reason:s002:s001"],
      scenes: [{ sceneId: "s001", width: 320, height: 180 }, { sceneId: "s002", width: 320, height: 180, reuseOf: "s001" }],
    },
    {
      id: "size",
      expect: ["operator-image-size-out-of-tolerance:s002:320x160"],
      scenes: [{ sceneId: "s001", width: 320, height: 180 }, { sceneId: "s002", width: 320, height: 160 }],
    },
    {
      id: "sha-mismatch",
      expect: ["operator-image-sha256-mismatch:s002"],
      mutate: async ({ operatorDir }) => { await replaceImage(operatorDir, "s002", 320, 180, 88); },
    },
    { id: "unexpected", expect: ["operator-image-manifest-unexpected"], packOptions: { source: "broker" } },
  ];
  for (const [index, entry] of cases.entries()) {
    const root = join(temp, entry.id);
    const setup = await setupRoot(root, { packOptions: entry.packOptions || {}, scenes: entry.scenes || null });
    if (entry.mutate) await entry.mutate(setup);
    const adapters = operatorAdapters(fixture);
    const outcome = await runNarratedStoryVideo({
      command: "full",
      scriptPath: setup.scriptPath,
      channelPackDir: setup.payloadDir,
      jobId: `video-narrated-story-video-0peratorst0p${String(index).padStart(4, "0")}`,
      jobIdentityDigest: IDENTITY,
      deploymentRoot: root,
      mediaJobRunner: adapters.mediaJobRunner,
      mediaJobProbe: adapters.mediaJobProbe,
      ffmpegToolchain: toolchain,
      voiceQualityGate: passingVoiceQualityGate,
      operatorImageManifestPath: entry.manifest ? entry.manifest() : setup.manifestPath,
      env,
    }, { allowDirectUnboundJobForTests: true });
    assert.equal(outcome.status, "awaiting-operator-input", `${entry.id}: ${outcome.status}`);
    assert.deepEqual(outcome.knownRemainingIssues, entry.expect, entry.id);
    assert.equal(adapters.calls.generation, 0, `${entry.id}: no paid Media Job`);
    assert.equal(adapters.probedKinds.length, 0, `${entry.id}: no adapter probe`);
    assert.equal(outcome.execution.paidGenerationAttempted, false);
  }
});

test("公式経路: 運営者の画の品質ループが合格していなければ、有料の probe も Media Job も出さずに人待ちで止まり、場面 ID と理由コードを返す", {
  skip: toolchain.ok ? false : "ffmpeg/ffprobe is unavailable",
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "narrated-operator-loop-stop-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const { env } = await reviewerSetup(temp);
  const fixture = await createBookendFixtureMedia(join(temp, "fixture-media"), toolchain);
  const run = async (setup, jobId) => {
    const adapters = operatorAdapters(fixture);
    const outcome = await runNarratedStoryVideo({
      command: "full",
      scriptPath: setup.scriptPath,
      channelPackDir: setup.payloadDir,
      jobId,
      jobIdentityDigest: IDENTITY,
      deploymentRoot: setup.root,
      mediaJobRunner: adapters.mediaJobRunner,
      mediaJobProbe: adapters.mediaJobProbe,
      ffmpegToolchain: toolchain,
      voiceQualityGate: passingVoiceQualityGate,
      operatorImageManifestPath: setup.manifestPath,
      env,
    }, { allowDirectUnboundJobForTests: true });
    assert.equal(adapters.calls.generation, 0, "no paid Media Job");
    assert.equal(adapters.probedKinds.length, 0, "no adapter probe");
    return outcome;
  };

  // 取り込みの記録に品質ループの記録（assetLoop）が無い。
  const bareRoot = join(temp, "bare");
  const bare = { root: bareRoot, ...await setupRoot(bareRoot) };
  const unlooped = await run(bare, "video-narrated-story-video-0per100p5t0p0001");
  assert.equal(unlooped.status, "awaiting-human-review");
  assert.deepEqual(unlooped.knownRemainingIssues, [
    "scene-image-asset-loop-not-passed:s001:record-required",
    "scene-image-asset-loop-not-passed:s002:record-required",
  ]);
  assert.equal(unlooped.execution.paidGenerationAttempted, false);
  assert.equal(unlooped.auditChecks.sceneImageAssetLoopPassed.pass, false);
  assert.deepEqual(unlooped.assetQualityLoop.pending.map((row) => [row.stage, row.sceneId, row.reason]), [
    ["scene-image", "s001", "record-required"],
    ["scene-image", "s002", "record-required"],
  ]);

  // ループは合格していたが、人が本編の画の人物の同一性を否とした（合格の後の人の確認は、その版の合格を取り消す）。
  const rejectedRoot = join(temp, "rejected");
  const looped = { root: rejectedRoot, ...await setupRoot(rejectedRoot, { loops: true }) };
  const { verifyAssetLoop } = await import("./fixtures/narratedAssetLoopFixture.mjs");
  await verifyAssetLoop({ workDir: looped.operatorDir, stage: "scene-image", subjectId: "s001", assetPath: join(looped.operatorDir, "images", "s001.png"), checks: ["identity"], verdict: "reject" });
  const rejected = await run(looped, "video-narrated-story-video-0per100p5t0p0002");
  assert.equal(rejected.status, "awaiting-human-review");
  assert.deepEqual(rejected.knownRemainingIssues, ["scene-image-asset-loop-not-passed:s001:human-rejected:identity"]);
  assert.equal(rejected.artifacts.previewVideo, undefined);
});

test("公式経路: 運営者の画を取り込み、画の有料 Media Job は0件で後段の監査・署名・品質ループ・Receipt・Canvas まで通り、会話の URL は私有の Job フォルダにしか残らない", {
  skip: toolchain.ok ? false : "ffmpeg/ffprobe is unavailable",
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "narrated-operator-e2e-"));
  const originalFetch = globalThis.fetch;
  const originalTrustEnv = Object.fromEntries(TRUST_ENV_NAMES.map((name) => [name, process.env[name]]));
  t.after(async () => {
    globalThis.fetch = originalFetch;
    for (const name of TRUST_ENV_NAMES) {
      if (originalTrustEnv[name] === undefined) delete process.env[name];
      else process.env[name] = originalTrustEnv[name];
    }
    await rm(temp, { recursive: true, force: true });
  });
  let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls += 1; throw new Error("operator image E2E forbids network access"); };
  const reviewerHome = join(temp, "reviewer-home");
  await mkdir(reviewerHome, { recursive: true });
  const { reviewer, trustPath } = await reviewerSetup(reviewerHome);
  for (const name of TRUST_ENV_NAMES) delete process.env[name];
  process.env[REVIEWER_TRUST_PATH_ENV] = trustPath;
  const project = join(temp, "project");
  await mkdir(project, { recursive: true });
  // 運営者は取り込む前に、自分のフォルダで本編の画と参照の設定画の品質ループを合格させてある。
  const { payloadDir, scriptPath, manifestPath, manifest } = await setupRoot(project, { loops: true });
  const fixture = await createBookendFixtureMedia(join(temp, "fixture-media"), toolchain);
  const adapters = operatorAdapters(fixture);
  const validateProductionProfile = async () => ({ profileId: "operator-production", fixture: "narrated-operator-image-e2e" });
  const planned = await createVideoHarnessJob({
    projectDir: project,
    scriptPath,
    channelPackPath: payloadDir,
    harnessId: "narrated-story-video",
    options: { operatorImageManifestPath: manifestPath },
    validateProductionProfile,
  });
  assert.equal(planned.job.options.operatorImageManifestPath, manifestPath, "manifest の置き場は Job の identity に入る");
  const payloadSha256 = sha256(await readFile(join(payloadDir, "narrated-story.json")));
  const packEvidence = {
    envelopeVersion: "buzzassist-channel-pack-envelope-v1",
    id: "fixture-operator-image-pack",
    version: "1.0.0",
    harnessId: "narrated-story-video",
    payloadKind: "narrated-story-channel-pack",
    coreCompatibility: "*",
    coreVersion: "fixture",
    payloadSha256,
    fileCount: 1,
    signerKeyId: "fixture-signer",
    trustedPublicKeyId: "fixture-trust-root",
  };
  const channelPackRuntime = await extractNarratedChannelPackRuntime({ payloadDir, evidence: packEvidence });
  let coreOutcome = null;
  let forbidPaid = false;
  const outerAdapter = async ({ job }) => {
    coreOutcome = await runNarratedStoryVideo({
      command: "full",
      scriptPath,
      channelPackDir: payloadDir,
      jobId: job.id,
      jobIdentityDigest: job.identityDigest,
      deploymentRoot: project,
      mediaJobRunner: forbidPaid ? async () => { throw new Error("finalize must not submit paid media"); } : adapters.mediaJobRunner,
      mediaJobProbe: forbidPaid ? async () => { throw new Error("finalize must not reprobe"); } : adapters.mediaJobProbe,
      ffmpegToolchain: toolchain,
      voiceQualityGate: passingVoiceQualityGate,
      operatorImageManifestPath: job.options.operatorImageManifestPath,
    }, { allowDirectUnboundJobForTests: true });
    const artifacts = await adapterTesting.collectNarratedArtifacts(coreOutcome, project);
    const complete = coreOutcome.status === "final-audited";
    return {
      status: complete ? "completed" : "awaiting-human-review",
      blockers: complete ? [] : coreOutcome.knownRemainingIssues,
      knownRemainingIssues: coreOutcome.knownRemainingIssues,
      artifacts,
      mediaJobs: coreOutcome.mediaJobs,
      auditChecks: coreOutcome.auditChecks,
      runtimeMetadata: coreOutcome.runtimeMetadata,
      adapterProbes: coreOutcome.adapterProbes,
      runReceiptPath: coreOutcome.runReceiptPath,
      result: coreOutcome,
    };
  };
  const prepare = async () => ({ ok: true, evidence: packEvidence, payloadDir, executionProjectDir: project, channelPackRuntime });
  const doctor = async () => ({ ready: true, blocking: [], checks: [{ id: "fixture", ok: true }] });
  const projectCanvas = (current) => projectVideoHarnessJob(current, {
    feedbackCollector: async () => ({ version: "buzzassist-canvas-feedback-collection-v1", ok: true, operation: "collect-feedback", jobId: current.id, captured: 0 }),
  });
  const runOuter = () => runVideoHarnessJob({ projectDir: project, jobId: planned.job.id, prepare, doctor, adapter: outerAdapter, projectCanvas, validateProductionProfile });

  // 1回目: 画と設定画のループは合格している。声を作った後、声のテイクのループの合格を待って、描かずに止まる。
  const loopStopOuter = await runOuter();
  const loopStop = coreOutcome;
  assert.equal(loopStopOuter.status, "awaiting-human-review", JSON.stringify(loopStop.knownRemainingIssues));
  assert.deepEqual(loopStop.knownRemainingIssues, [
    "voice-take-asset-loop-not-passed:s001:loop-not-started",
    "voice-take-asset-loop-not-passed:s002:loop-not-started",
  ]);
  assert.equal(loopStop.auditChecks.sceneImageAssetLoopPassed.pass, true, loopStop.auditChecks.sceneImageAssetLoopPassed.detail);
  assert.equal(loopStop.auditChecks.characterAssetLoopPassed.pass, true, loopStop.auditChecks.characterAssetLoopPassed.detail);
  assert.equal(loopStop.artifacts.previewVideo, undefined, "合格の前に描かない");
  assert.deepEqual(adapters.calls.kinds.filter((kind) => kind === "music.generation"), [], "合格の前に BGM を依頼しない");
  await passPendingNarratedAssetLoops(loopStop);

  const firstOuter = await runOuter();
  const first = coreOutcome;
  assert.equal(firstOuter.status, "awaiting-human-review", JSON.stringify(first.knownRemainingIssues));
  assert.equal(first.status, "awaiting-human-review", JSON.stringify(first.knownRemainingIssues));
  // 画の Media Job は0件。声2本と BGM 1本だけが有料の経路を通る（再開は声を払い直さない）。画の adapter は probe しない。
  assert.deepEqual(adapters.calls.kinds.filter((kind) => kind === "image.generation"), []);
  assert.equal(adapters.calls.generation, 3);
  assert.deepEqual([...new Set(adapters.probedKinds)].sort(), ["music.generation", "voice.synthesis"]);
  assert.equal(first.mediaJobs.length, 3);
  assert.equal(first.mediaJobs.some((row) => row.kind === "image.generation"), false);
  assert.deepEqual(first.imageSource, {
    kind: "operator-file",
    manifestSha256: sha256(await readFile(manifestPath)),
    digest: first.imageSource.digest,
    sceneCount: 2,
    routes: { "chatgpt-web": 2 },
    paidMediaJobs: 0,
    costBasis: OPERATOR_IMAGE_COST_BASIS,
  });
  // 後段の自動監査（カメラ・字幕・音声・境目・声の品質）は broker と同じに通り、画の出どころの監査も通る。
  for (const auditId of NARRATED_STORY_AUDIT_IDS) {
    if (PERCEPTUAL.has(auditId)) continue;
    assert.equal(first.auditChecks[auditId].pass, true, `${auditId}: ${first.auditChecks[auditId].detail}`);
  }
  const provenance = first.auditChecks[NARRATED_SCENE_IMAGE_PROVENANCE_AUDIT_ID];
  assert.equal(provenance.pass, true, provenance.detail);
  assert.equal(provenance.source, "operator-file");
  assert.equal(provenance.paidImageMediaJobs, 0);
  const generation = JSON.parse(await readFile(first.artifacts.generationManifest.path, "utf8"));
  assert.equal(generation.channelConfig.image.source, "operator-file");
  assert.equal(generation.operatorImages.scenes[0].fit.method, "cover-center-crop", "1px 広い画は切り取りで合わせ、方法を記録する");
  assert.equal(generation.operatorImages.scenes[0].conversationUrlSha256, sha256(fixtureConversationUrl("s001")));
  assert.equal(generation.operatorImages.scenes[1].source.sha256, manifest.scenes[1].image.sha256);
  assert.equal(generation.segments[0].imageSha256, generation.operatorImages.scenes[0].normalized.sha256);

  // 署名済みの独立レビューで、人物の同一性の保証と目視の保証と品質ループが同じに通る。
  await writeNarratedReviewSignoff({
    deploymentRoot: project,
    jobId: planned.job.id,
    identityDigest: planned.job.identityDigest,
    reviewerHost: "codex",
    reviewerContextId: "operator-image-independent-review-01",
    reviewerPrivateKeyPem: reviewer.privateKeyPem,
    review: { rubricScores: reviewScores(first), notes: "全尺を通して見て、取り込んだ画と語りと字幕を確かめた", findings: [] },
    pass: true,
  });
  forbidPaid = true;
  const completedOuter = await runOuter();
  const second = coreOutcome;
  assert.equal(second.status, "final-audited", JSON.stringify(second.knownRemainingIssues));
  assert.equal(completedOuter.status, "completed", `${completedOuter.error || ""} ${JSON.stringify(completedOuter.knownRemainingIssues)}`);
  assert.ok(Object.values(second.auditChecks).every((entry) => entry.pass === true));
  assert.equal(second.auditChecks.characterIdentityReviewed.pass, true);
  assert.equal(second.auditChecks.perceptualReviewBoundToOutput.pass, true);
  assert.equal(networkCalls, 0);

  const genreReceiptText = await readFile(second.runReceiptPath, "utf8");
  const genreReceipt = JSON.parse(genreReceiptText);
  assert.equal(genreReceipt.imageSource.kind, "operator-file");
  assert.equal(genreReceipt.imageSource.paidMediaJobs, 0);
  assert.equal(genreReceipt.imageSource.costBasis, OPERATOR_IMAGE_COST_BASIS);
  assert.equal(genreReceipt.mediaJobs.some((row) => row.kind === "image.generation"), false);
  const commonReceiptArtifact = completedOuter.artifacts.find((artifact) => artifact.kind === "run-receipt");
  assert.ok(commonReceiptArtifact);
  const commonReceiptText = await readFile(commonReceiptArtifact.path, "utf8");
  assert.equal(JSON.parse(commonReceiptText).outcome, "pass");
  const auditText = await readFile(second.artifacts.auditReport.path, "utf8");
  assert.equal(JSON.parse(auditText).imageSource.kind, "operator-file");

  // 会話の URL は、RunReceipt・監査・生成記録・Job・Canvas・outcome のどこにも出ない（sha256 だけ）。
  const canvasStateText = await readFile(resolveCanvasRunStateFile({ projectDir: project }, completedOuter.id), "utf8");
  const canvasSceneText = await readFile(resolveCanvasFile({ projectDir: project }), "utf8");
  const canvasFiles = await filesBelow(join(project, "canvas"));
  const publicTexts = {
    genreReceipt: genreReceiptText,
    commonReceipt: commonReceiptText,
    audit: auditText,
    generationManifest: await readFile(second.artifacts.generationManifest.path, "utf8"),
    canvasState: canvasStateText,
    canvasScene: canvasSceneText,
    outcome: JSON.stringify(second),
    outerJob: JSON.stringify(completedOuter),
  };
  for (const file of canvasFiles) {
    const info = await stat(file);
    if (info.size < 4 * 1024 * 1024) publicTexts[`canvas:${file.slice(project.length)}`] = await readFile(file, "latin1");
  }
  for (const sceneId of ["s001", "s002"]) {
    const url = fixtureConversationUrl(sceneId);
    for (const [label, text] of Object.entries(publicTexts)) {
      assert.equal(text.includes(url), false, `${label} leaked the conversation URL of ${sceneId}`);
      assert.equal(text.includes("chat.example.invalid"), false, `${label} leaked the conversation host`);
    }
  }
  const privateRecord = await readFile(join(narratedStoryRunPaths({ deploymentRoot: project, jobId: planned.job.id }).runDir, "operator-images", "import-record.json"), "utf8");
  assert.ok(privateRecord.includes(fixtureConversationUrl("s001")), "会話の URL は私有の Job フォルダの記録にだけ残る");
});

test("再開: 取り込んだ画が差し替わったら気づき、manifest の直し忘れは止め、直せば声と BGM を払い直さずに作り直す", {
  skip: toolchain.ok ? false : "ffmpeg/ffprobe is unavailable",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "narrated-operator-resume-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { env } = await reviewerSetup(root);
  const fixture = await createBookendFixtureMedia(join(root, "fixture-media"), toolchain);
  const { payloadDir, scriptPath, manifestPath, manifest, operatorDir, approvedReferencesPath } = await setupRoot(root, { loops: true });
  const adapters = operatorAdapters(fixture);
  const jobId = "video-narrated-story-video-0perat0rresume01";
  const base = {
    command: "full",
    scriptPath,
    channelPackDir: payloadDir,
    jobId,
    jobIdentityDigest: IDENTITY,
    deploymentRoot: root,
    ffmpegToolchain: toolchain,
    voiceQualityGate: passingVoiceQualityGate,
    operatorImageManifestPath: manifestPath,
    env,
  };
  const first = await runPastAssetLoops(() => runNarratedStoryVideo({ ...base, mediaJobRunner: adapters.mediaJobRunner, mediaJobProbe: adapters.mediaJobProbe }, { allowDirectUnboundJobForTests: true }));
  assert.equal(first.status, "awaiting-human-review", JSON.stringify(first.knownRemainingIssues));
  assert.ok(first.artifacts.previewVideo, "声のテイクのループが合格した後に描く");
  const paidAfterFirst = adapters.calls.generation;
  const noPaid = {
    mediaJobRunner: async () => { throw new Error("resume must not re-bill voices or music"); },
    mediaJobProbe: adapters.mediaJobProbe,
  };
  const imagesDir = join(narratedStoryRunPaths({ deploymentRoot: root, jobId }).runDir, "media", "images");
  const untouchedBefore = await stat(join(imagesDir, "s001.png"));

  // 同じ入力の再開は、作った状態をそのまま使う（作り直さない）。
  const same = await runNarratedStoryVideo({ ...base, ...noPaid }, { allowDirectUnboundJobForTests: true });
  assert.equal(same.artifacts.previewVideo.sha256, first.artifacts.previewVideo.sha256);

  // 画だけ差し替えて manifest を直し忘れた: 実測の sha256 が manifest と（品質ループで合格した版とも）違うので、
  // 有料の処理の前に止まる。
  const replaced = await replaceImage(operatorDir, "s002", 320, 180, 61);
  const forgot = await runNarratedStoryVideo({ ...base, ...noPaid }, { allowDirectUnboundJobForTests: true });
  assert.equal(forgot.status, "awaiting-operator-input");
  assert.deepEqual(forgot.knownRemainingIssues, ["operator-image-sha256-mismatch:s002", "operator-image-asset-loop-pass-mismatch:s002"]);

  // manifest の画の sha256 だけを直しても、合格した版ではない画は取り込まない。
  manifest.scenes[1].image.sha256 = sha256(replaced);
  await writeManifest(manifestPath, manifest);
  const unreviewed = await runNarratedStoryVideo({ ...base, ...noPaid }, { allowDirectUnboundJobForTests: true });
  assert.deepEqual(unreviewed.knownRemainingIssues, ["operator-image-asset-loop-pass-mismatch:s002"]);
  // 記録の合格の sha256 だけを書き換えても（ループで採点していない画）、本体のループが合格していないので描かない。
  manifest.scenes[1].assetLoop.passedSha256 = sha256(replaced);
  await writeManifest(manifestPath, manifest);
  const forged = await runNarratedStoryVideo({ ...base, ...noPaid }, { allowDirectUnboundJobForTests: true });
  assert.equal(forged.status, "awaiting-human-review");
  assert.deepEqual(forged.knownRemainingIssues, ["scene-image-asset-loop-not-passed:s002:sha256-mismatch"]);
  assert.equal(forged.execution.paidGenerationAttempted, false, "有料の処理の前に止まる");

  // 差し替えた画を品質ループで採点し直して合格させると、別の入力として作り直す。声と BGM は同じ requestKey の
  // 完成品を使い、払い直さない（声のテイクのループの合格もそのまま使える）。
  await recordAssetLoopRound({
    workDir: operatorDir, stage: "scene-image", subjectId: "s002", assetPath: join(operatorDir, "images", "s002.png"),
    generatorContextId: "fixture-operator-maker", route: "chatgpt-web",
    references: [FIXTURE_REFERENCE_SHA256], approvedReferencesPath, charactersVisible: true,
  });
  const rebuilt = await runNarratedStoryVideo({ ...base, ...noPaid }, { allowDirectUnboundJobForTests: true });
  assert.equal(rebuilt.status, "awaiting-human-review", JSON.stringify(rebuilt.knownRemainingIssues));
  assert.equal(adapters.calls.generation, paidAfterFirst, "no new paid Media Job");
  assert.notEqual(rebuilt.artifacts.previewVideo.sha256, first.artifacts.previewVideo.sha256, "差し替えた画で描き直す");
  assert.notEqual(rebuilt.imageSource.digest, first.imageSource.digest);
  const generation = JSON.parse(await readFile(rebuilt.artifacts.generationManifest.path, "utf8"));
  assert.equal(generation.operatorImages.scenes[1].source.sha256, sha256(replaced));
  assert.equal(generation.segments[1].imageSha256, sha256(replaced), "決まった寸法の PNG は画素に手を入れない");
  assert.deepEqual(rebuilt.mediaJobs.map((row) => row.requestKey).sort(), first.mediaJobs.map((row) => row.requestKey).sort());
  const untouchedAfter = await stat(join(imagesDir, "s001.png"));
  assert.equal(untouchedAfter.mtimeMs, untouchedBefore.mtimeMs, "差し替えていない場面の取り込みは作り直さない");
  assert.equal(rebuilt.auditChecks[NARRATED_SCENE_IMAGE_PROVENANCE_AUDIT_ID].pass, true);
});
