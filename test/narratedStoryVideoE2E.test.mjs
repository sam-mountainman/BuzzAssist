#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { resolveCanvasFile } from "../lib/canvasScene.mjs";
import {
  REVIEWER_TRUST_JSON_ENV,
  REVIEWER_TRUST_PATH_ENV,
  REVIEWER_TRUST_VERSION,
  KOYA_REVIEWER_TRUST_JSON_ENV,
  KOYA_REVIEWER_TRUST_PATH_ENV,
} from "../lib/koyaReviewAttestation.mjs";
import { CANVAS_RUN_MEDIA_TAG } from "../lib/canvasRunMediaProjection.mjs";
import { resolveCanvasRunStateFile } from "../lib/canvasRunState.mjs";
import { extractNarratedChannelPackRuntime } from "../lib/harnessChannelPackRuntime.mjs";
import { paidMediaRequestIdentity } from "../lib/paidMediaJobBroker.mjs";
import { resolveFfmpegToolchain } from "../lib/harnessRuntimeResolver.mjs";
import { NARRATED_OUTER_JOB_REQUIRED_CODE, runNarratedStoryVideo } from "../lib/narratedStoryVideo.mjs";
import { generateReviewerKeyPair, createReviewerTrustEntry } from "../lib/koyaReviewAttestation.mjs";
import {
  NARRATED_STORY_AUDIT_IDS,
} from "../lib/narratedStoryOutcome.mjs";
import {
  inspectNarratedStoryRenderGraphs,
  narratedStoryRunPaths,
  narratedVoiceOutputProfile,
  NARRATED_STORY_AUDIT_CONTRACT_VERSION,
  NARRATED_STORY_SIGNOFF_VERSION,
  writeNarratedReviewSignoff,
} from "../lib/narratedStoryPipeline.mjs";
import { narratedQualityPaths } from "../lib/narratedStoryQualityLoop.mjs";
import {
  OPERATOR_REPLACEMENT_MARKER,
  measureNarratedBookendBoundaries,
  rehydrateBookendPlan,
} from "../lib/narratedStoryBookends.mjs";
import {
  BOOKEND_FIXTURE_SCRIPT,
  bookendFixtureAdapters,
  createBookendFixtureMedia,
  passingVoiceQualityGate,
  writeBookendPack,
} from "./fixtures/narratedBookendFixture.mjs";
import { _testing as adapterTesting } from "../lib/videoHarnessAdapters.mjs";
import { projectVideoHarnessJob } from "../lib/videoHarnessCanvasAdapter.mjs";
import { createVideoHarnessJob, runVideoHarnessJob } from "../lib/videoHarnessJob.mjs";

const execFile = promisify(execFileCallback);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const NARRATED_CLI = new URL("../scripts/narrated-story-video.mjs", import.meta.url);
const TRUST_ENV_NAMES = [REVIEWER_TRUST_PATH_ENV, REVIEWER_TRUST_JSON_ENV, KOYA_REVIEWER_TRUST_PATH_ENV, KOYA_REVIEWER_TRUST_JSON_ENV];

async function runNarratedCli(args, env = process.env) {
  const { stdout } = await execFile(process.execPath, [fileURLToPath(NARRATED_CLI), ...args], {
    timeout: 60_000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    env,
  });
  return JSON.parse(stdout);
}

async function runRuntime(spec, args) {
  return execFile(spec.command, [...(spec.args || []), ...args], {
    timeout: 60_000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function createFixtureMedia(root, toolchain) {
  const imagePath = join(root, "fixture.png");
  const voicePath = join(root, "fixture-voice.wav");
  const musicPath = join(root, "fixture-music.wav");
  await runRuntime(toolchain.ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=1:duration=0.1",
    "-frames:v", "1", "-threads", "1", imagePath,
  ]);
  await runRuntime(toolchain.ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=0.8:sample_rate=48000",
    "-af", "volume=0.2", "-ac", "1", "-c:a", "pcm_s16le", voicePath,
  ]);
  await runRuntime(toolchain.ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=196:duration=3:sample_rate=48000",
    "-af", "volume=0.2", "-ac", "2", "-c:a", "pcm_s16le", musicPath,
  ]);
  return {
    image: await readFile(imagePath),
    voice: await readFile(voicePath),
    music: await readFile(musicPath),
  };
}

const toolchain = await resolveFfmpegToolchain();

/** production が review.quality に書いた評価項目の全部を採点する（合成の点数）。 */
function reviewScores(outcome, overrides = {}) {
  const rubric = outcome?.review?.quality?.rubric || [];
  assert.ok(rubric.length > 0, "production must publish the quality rubric the reviewer scores against");
  return Object.fromEntries(rubric.map((criterion) => [criterion.id, overrides[criterion.id] ?? 96]));
}

test("narrated voice output requests Fish at its explicit native WAV rate before 48 kHz render resampling", () => {
  assert.deepEqual(narratedVoiceOutputProfile("fish-audio"), {
    format: "wav",
    sampleRate: 44_100,
    channels: 1,
  });
  assert.deepEqual(narratedVoiceOutputProfile("elevenlabs"), {
    format: "wav",
    sampleRate: 48_000,
    channels: 1,
  });
});

test("narrated render-graph audit fails closed on transition filters or missing evidence", () => {
  const base = {
    voiceStem: { filterGraph: "[0:a]concat=n=1:v=0:a=1[voice]", inputCount: 1, outputMap: "[voice]" },
    bgmStem: { filterGraph: "aresample=48000", inputCount: 1, outputMap: "audio:0" },
    masterAudio: {
      filterGraph: "[0:a]anull[voice];[1:a]anull[bed];[voice][bed]amix=inputs=2[master]",
      inputCount: 2,
      outputMap: "[master]",
    },
    preview: {
      filterGraph: "[0:v]format=yuv420p[v0];[v0]concat=n=1:v=1:a=0[video]",
      imageInputCount: 1,
      videoMap: "[video]",
      audioMap: "1:a:0",
    },
  };
  const clean = inspectNarratedStoryRenderGraphs(base, 1);
  assert.equal(clean.sceneTransitionOwnedByParent, true);
  assert.equal(clean.parentAudioMapped, true);
  assert.equal(clean.noWholeProgramAcrossfade, true);

  const videoTransition = inspectNarratedStoryRenderGraphs({
    ...base,
    preview: { ...base.preview, filterGraph: `${base.preview.filterGraph};xfade=duration=1` },
  }, 1);
  assert.equal(videoTransition.sceneTransitionOwnedByParent, false);

  const audioTransition = inspectNarratedStoryRenderGraphs({
    ...base,
    masterAudio: { ...base.masterAudio, filterGraph: `${base.masterAudio.filterGraph};acrossfade=d=1` },
  }, 1);
  assert.equal(audioTransition.noWholeProgramAcrossfade, false);
  assert.deepEqual(audioTransition.acrossfadeGraphs, ["masterAudio"]);

  const wrongAudioMap = inspectNarratedStoryRenderGraphs({
    ...base,
    preview: { ...base.preview, audioMap: "0:a:0" },
  }, 1);
  assert.equal(wrongAudioMap.parentAudioMapped, false);

  assert.equal(inspectNarratedStoryRenderGraphs({ preview: base.preview }, 1).noWholeProgramAcrossfade, false);
});

function cleanTrustEnv(overrides = {}) {
  const env = { ...process.env };
  for (const name of TRUST_ENV_NAMES) delete env[name];
  return { ...env, ...overrides };
}

const UNBOUND_JOB_ID = "video-narrated-story-video-0123456789abcdef";
const UNBOUND_IDENTITY = "a".repeat(64);

test("R5-REV-01: narrated full refuses to run without the complete outer Job binding, before touching disk or paid media", async () => {
  const temp = await mkdtemp(join(os.tmpdir(), "narrated-unbound-"));
  try {
    let paid = 0;
    const base = {
      command: "full",
      scriptPath: join(temp, "missing-script.md"),
      channelPackDir: join(temp, "missing-pack"),
      jobId: UNBOUND_JOB_ID,
      deploymentRoot: temp,
      mediaJobRunner: async () => { paid += 1; throw new Error("must not reach paid media"); },
      mediaJobProbe: async () => { paid += 1; throw new Error("must not probe"); },
    };
    // 0 件: Koya の KOYA_OUTER_JOB_REQUIRED と対になるコードで止まる（script の ENOENT より前）。
    await assert.rejects(
      runNarratedStoryVideo(base),
      (error) => error?.code === NARRATED_OUTER_JOB_REQUIRED_CODE && /run-video-harness\.mjs/u.test(error.message),
    );
    // 部分指定も禁止。
    await assert.rejects(
      runNarratedStoryVideo({ ...base, upstreamJobId: UNBOUND_JOB_ID }),
      /Partial upstream execution evidence is forbidden/u,
    );
    // テスト専用 escape でも identityDigest が無ければ通さない。
    await assert.rejects(
      runNarratedStoryVideo(base, { allowDirectUnboundJobForTests: true }),
      /requires --job-identity-digest/u,
    );
    // escape + digest でも、信頼アンカー未設定なら pipeline（run dir 作成・Media Job）へ進まない。
    await assert.rejects(
      runNarratedStoryVideo({ ...base, jobIdentityDigest: UNBOUND_IDENTITY, env: cleanTrustEnv() }, { allowDirectUnboundJobForTests: true }),
      (error) => error?.code === "reviewer-trust-unconfigured",
    );
    assert.equal(paid, 0);
    await assert.rejects(() => stat(join(temp, ".media")), (error) => error?.code === "ENOENT", "no run dir before preflight passes");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("R5-REV-01: narrated full cross-checks an explicit trust path against the operator env and requires an active key", async () => {
  const temp = await mkdtemp(join(os.tmpdir(), "narrated-trust-preflight-"));
  try {
    const operatorEntry = createReviewerTrustEntry({ publicKeyPem: generateReviewerKeyPair().publicKeyPem, label: "operator" });
    const strangerEntry = createReviewerTrustEntry({ publicKeyPem: generateReviewerKeyPair().publicKeyPem, label: "stranger" });
    const operatorPath = join(temp, "operator-trust.json");
    const strangerPath = join(temp, "stranger-trust.json");
    const revokedPath = join(temp, "revoked-trust.json");
    await writeFile(operatorPath, JSON.stringify({ version: REVIEWER_TRUST_VERSION, reviewers: [operatorEntry] }), "utf8");
    await writeFile(strangerPath, JSON.stringify({ version: REVIEWER_TRUST_VERSION, reviewers: [strangerEntry] }), "utf8");
    await writeFile(revokedPath, JSON.stringify({
      version: REVIEWER_TRUST_VERSION,
      reviewers: [{ ...operatorEntry, status: "revoked", revokedAt: "2026-09-01T00:00:00.000Z", reason: "fixture" }],
    }), "utf8");
    let paid = 0;
    const base = {
      command: "full",
      scriptPath: join(temp, "missing-script.md"),
      channelPackDir: join(temp, "missing-pack"),
      jobId: UNBOUND_JOB_ID,
      jobIdentityDigest: UNBOUND_IDENTITY,
      deploymentRoot: temp,
      mediaJobRunner: async () => { paid += 1; throw new Error("must not reach paid media"); },
      mediaJobProbe: async () => { paid += 1; throw new Error("must not probe"); },
    };
    const runtime = { allowDirectUnboundJobForTests: true };
    // 明示 path が env と別内容 → conflict（自作リストで通せない）。
    const conflict = await runNarratedStoryVideo({ ...base, reviewerTrustPath: strangerPath, env: cleanTrustEnv({ [REVIEWER_TRUST_PATH_ENV]: operatorPath }) }, runtime).catch((error) => error);
    assert.equal(conflict?.code, "reviewer-trust-conflict");
    assert.equal(conflict.message.includes(strangerPath), false, "failure text must not carry the path");
    // 新旧 env が別内容 → env-ambiguous。
    const ambiguous = await runNarratedStoryVideo({ ...base, env: cleanTrustEnv({ [REVIEWER_TRUST_PATH_ENV]: operatorPath, [KOYA_REVIEWER_TRUST_PATH_ENV]: strangerPath }) }, runtime).catch((error) => error);
    assert.match(String(conflict.code), /^reviewer-trust-/u);
    assert.match(String(ambiguous?.code), /^reviewer-trust-invalid:env-ambiguous/u);
    // 全件 revoked → signoff を 1 件も受理できないので生成前に止まる。
    const revoked = await runNarratedStoryVideo({ ...base, env: cleanTrustEnv({ [REVIEWER_TRUST_PATH_ENV]: revokedPath }) }, runtime).catch((error) => error);
    assert.equal(revoked?.code, "reviewer-trust-invalid:no-active-reviewers");
    // env が正しく、明示 path が一致すれば信頼アンカー検査は通過し、次の検査（入力 inspect）で ENOENT に至る
    // = preflight が有料前の唯一の門ではなく、通過後は従来どおり pipeline へ進むことの実測。
    const passed = await runNarratedStoryVideo({ ...base, reviewerTrustPath: operatorPath, env: cleanTrustEnv({ [REVIEWER_TRUST_PATH_ENV]: operatorPath }) }, runtime).catch((error) => error);
    assert.doesNotMatch(String(passed?.code || passed?.message), /reviewer-trust/u, `trust preflight must pass with a matching list: ${passed?.message}`);
    assert.equal(paid, 0);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("R5-REV-01: the real narrated CLI full without the outer Job binding exits 1 with NARRATED_OUTER_JOB_REQUIRED", async () => {
  const temp = await mkdtemp(join(os.tmpdir(), "narrated-cli-unbound-"));
  try {
    const error = await runNarratedCli([
      "full", "--script-path", join(temp, "missing.md"), "--channel-pack-dir", join(temp, "pack"), "--job-id", UNBOUND_JOB_ID, "--project-dir", temp,
    ], cleanTrustEnv()).then(() => null, (thrown) => thrown);
    assert.ok(error, "CLI must fail");
    assert.equal(error.code, 1);
    assert.match(String(error.stderr), /run-video-harness\.mjs start\/resume/u);
    assert.doesNotMatch(String(error.stderr), /ENOENT/u, "must stop before reading the script");
    await assert.rejects(() => stat(join(temp, ".media")), (thrown) => thrown?.code === "ENOENT");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Core narrated-story fixture renders, audits, resumes, and emits a receipt without network access", {
  skip: toolchain.ok ? false : "ffmpeg/ffprobe is unavailable",
}, async () => {
  const temp = await mkdtemp(join(os.tmpdir(), "narrated-story-video-e2e-"));
  // reviewer 鍵と信頼リストは project（temp）の外に置く。reviewer-key-create は
  // project／リポジトリ配下への書き込みを拒否する。
  const reviewerHome = await mkdtemp(join(os.tmpdir(), "narrated-story-video-e2e-reviewer-"));
  const originalFetch = globalThis.fetch;
  const originalTrustEnv = Object.fromEntries(TRUST_ENV_NAMES.map((name) => [name, process.env[name]]));
  // 信頼リストは監査・Receipt 側へ環境変数（path）で別経路注入する。signoff 内の鍵は信頼しない。
  for (const name of TRUST_ENV_NAMES) delete process.env[name];
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error("fixture E2E forbids external network access");
  };
  try {
  const scriptPath = join(temp, "raw-script.txt");
  const payloadDir = join(temp, "signed-channel-pack-payload");
  await mkdir(payloadDir);
  const rawScript = "最初の物語です。次の場面です。";
  const imageStylePrompt = "flat fixture illustration with no embedded text";
  const musicPrompt = "quiet fixture ambient bed";
  await writeFile(scriptPath, `${rawScript}\n`, "utf8");
  await writeFile(join(payloadDir, "narrated-story.json"), `${JSON.stringify({
    version: "fixture-channel-pack-v1",
    runtime: { imageModel: "fixture-image-v1", ttsProvider: "fixture-voice" },
    image: {
      provider: "fixture-image",
      model: "fixture-image-v1",
      adapterVersion: "fixture-image-adapter-v1",
      stylePrompt: imageStylePrompt,
    },
    voice: {
      provider: "fixture-voice",
      model: "fixture-voice-v1",
      adapterVersion: "fixture-voice-adapter-v1",
      voiceId: "fixture-ja",
      speed: 1,
    },
    music: {
      provider: "fixture-music",
      model: "fixture-music-v1",
      adapterVersion: "fixture-music-adapter-v1",
      prompt: musicPrompt,
      gain: 0.01,
    },
    render: { width: 320, height: 180, fps: 12 },
    concurrency: 2,
    bookends: { enabled: false },
  }, null, 2)}\n`, "utf8");

  const fixture = await createFixtureMedia(temp, toolchain);
  let generationCalls = 0;
  let probeCalls = 0;
  const mediaJobProbe = async (adapter) => {
    probeCalls += 1;
    return {
      ok: true,
      status: "ready",
      ...adapter,
      httpStatus: 200,
      serverVersion: "fixture-media-server-v1",
      detail: "in-process fixture adapter is ready; no network request was made",
    };
  };
  const mediaJobRunner = async (spec) => {
    generationCalls += 1;
    const identity = paidMediaRequestIdentity(spec);
    const bytes = spec.kind === "image.generation"
      ? fixture.image
      : (spec.kind === "voice.synthesis" ? fixture.voice : fixture.music);
    const ordinal = generationCalls;
    return {
      bytes,
      receipt: {
        version: "fixture-paid-media-receipt-v1",
        jobId: `fixture-job-${identity.identityHash.slice(0, 20)}`,
        requestKey: identity.requestKey,
        status: "completed",
        kind: spec.kind,
        provider: spec.provider,
        adapterVersion: spec.adapterVersion,
        providerJobId: `fixture-provider-job-${ordinal}`,
        model: spec.model,
        voiceId: spec.voiceId || "",
        inputHash: identity.inputHash,
        identityHash: identity.identityHash,
        reservation: {
          reservationId: `fixture-reservation-${ordinal}`,
          status: "captured",
          requestedAt: "2026-09-01T00:00:00.000Z",
          unit: spec.reservation?.unit || "",
          estimatedSeconds: spec.reservation?.estimatedSeconds ?? null,
          estimatedUnits: spec.reservation?.estimatedUnits ?? null,
          estimatedCost: 0,
          currency: "USD",
        },
        usage: {
          seconds: spec.kind === "image.generation" ? null : 0.8,
          units: spec.reservation?.estimatedUnits ?? 1,
          cost: 0,
          currency: "USD",
          freeRegeneration: false,
        },
        artifact: { sha256: sha256(bytes), mimeType: spec.output?.format, bytes: bytes.length },
        attempts: { total: 1, retries: [] },
      },
    };
  };

  const validateProductionProfile = async () => ({
    profileId: "operator-production",
    fixture: "narrated-story-outer-job-e2e",
  });
  const planned = await createVideoHarnessJob({
    projectDir: temp,
    scriptPath,
    channelPackPath: payloadDir,
    harnessId: "narrated-story-video",
    validateProductionProfile,
  });
  const payloadSha256 = sha256(await readFile(join(payloadDir, "narrated-story.json")));
  const packEvidence = {
    envelopeVersion: "buzzassist-channel-pack-envelope-v1",
    id: "fixture-narrated-pack",
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
  assert.match(planned.job.identityDigest, /^[a-f0-9]{64}$/u);
  const options = {
    command: "full",
    scriptPath,
    channelPackDir: payloadDir,
    jobId: planned.job.id,
    // in-process の outer adapter は upstream binding を渡さないので、reviewer attestation の
    // 期待 subject に要る Job identityDigest を明示する（子プロセス経路では upstream から取る）。
    jobIdentityDigest: planned.job.identityDigest,
    deploymentRoot: temp,
    mediaJobRunner,
    mediaJobProbe,
    ffmpegToolchain: toolchain,
    voiceQualityGate: passingVoiceQualityGate,
  };
  let coreOutcome = null;
  let outerAdapterCalls = 0;
  let forbidPaidResume = false;
  const outerAdapter = async () => {
    outerAdapterCalls += 1;
    // in-process adapter は upstream binding を持たないので、テスト専用の escape で外側 Job 必須検査を
    // 通す（production の子プロセス経路は videoHarnessAdapters が binding を必ず渡す）。
    coreOutcome = await runNarratedStoryVideo({
      ...options,
      ...(forbidPaidResume ? {
        mediaJobRunner: async () => { throw new Error("resume must not regenerate a paid artifact"); },
        mediaJobProbe: async () => { throw new Error("resume must not reprobe a completed immutable state"); },
      } : {}),
    }, { allowDirectUnboundJobForTests: true });
    const artifacts = await adapterTesting.collectNarratedArtifacts(coreOutcome, temp);
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
  const prepare = async () => ({
    ok: true,
    evidence: packEvidence,
    payloadDir,
    executionProjectDir: temp,
    channelPackRuntime,
  });
  const doctor = async () => ({ ready: true, blocking: [], checks: [{ id: "fixture", ok: true }] });
  let failAfterCompletedCanvasProjection = false;
  const projectCanvas = async (current) => {
    const projected = await projectVideoHarnessJob(current, {
      feedbackCollector: async () => ({
        version: "buzzassist-canvas-feedback-collection-v1",
        ok: true,
        operation: "collect-feedback",
        jobId: current.id,
        captured: 0,
      }),
    });
    if (current.status === "completed" && failAfterCompletedCanvasProjection) {
      failAfterCompletedCanvasProjection = false;
      throw new Error("injected crash after completed Canvas bytes were projected");
    }
    return projected;
  };
  // 独立 reviewer の鍵と信頼リストを実 CLI で作る（本物の署名経路を通す）。運営者の信頼アンカー
  // （env）は有料生成の前に配られていなければならない——R5-REV-01 で narrated の full も
  // pipeline に入る前に reviewer-trust preflight を行うようになったので、ここで先に設定する。
  const reviewerKeyPath = join(reviewerHome, "keys", "reviewer-ed25519.pem");
  const createdKey = await runNarratedCli([
    "reviewer-key-create", "--reviewer-key-path", reviewerKeyPath, "--reviewer-label", "e2e independent reviewer", "--project-dir", temp,
  ]);
  assert.equal(createdKey.trustEntry.keyId, createdKey.keyId);
  await assert.rejects(
    runNarratedCli(["reviewer-key-create", "--reviewer-key-path", join(temp, "reviewer.pem"), "--project-dir", temp]),
    (error) => /reviewer-key-path-inside-repository/u.test(String(error?.stderr)),
    "reviewer keys must not be written into the project dir",
  );
  const trustPath = join(reviewerHome, "reviewer-trust.json");
  await writeFile(trustPath, `${JSON.stringify({ version: REVIEWER_TRUST_VERSION, reviewers: [createdKey.trustEntry] }, null, 2)}\n`, "utf8");

  // R5-REV-01 否定テスト: 信頼アンカー未設定の host では、outer Job・doctor・署名済み pack が揃っていても
  // narrated の paid production は pipeline に入る前に止まり、Media Job も run dir も作られない。
  {
    const beforeCalls = generationCalls;
    const beforeProbes = probeCalls;
    await assert.rejects(
      runNarratedStoryVideo(options, { allowDirectUnboundJobForTests: true }),
      (error) => error?.code === "reviewer-trust-unconfigured" && /before paid generation/u.test(error.message),
      "env 未設定なら有料生成前に reviewer-trust-unconfigured で止まる",
    );
    assert.equal(generationCalls, beforeCalls, "preflight failure must not submit a Media Job");
    assert.equal(probeCalls, beforeProbes, "preflight failure must not probe an adapter");
    await assert.rejects(
      () => stat(narratedStoryRunPaths({ deploymentRoot: temp, jobId: planned.job.id }).runDir),
      (error) => error?.code === "ENOENT",
      "preflight failure must not create the pipeline run dir",
    );
  }
  process.env[REVIEWER_TRUST_PATH_ENV] = trustPath;

  const firstOuter = await runVideoHarnessJob({
    projectDir: temp,
    jobId: planned.job.id,
    prepare,
    doctor,
    adapter: outerAdapter,
    projectCanvas,
    validateProductionProfile,
  });
  const first = coreOutcome;
  assert.equal(firstOuter.status, "awaiting-human-review");
  assert.equal(first.status, "awaiting-human-review");
  assert.equal(first.execution.paidGenerationAttempted, true);
  assert.equal(first.execution.legacyAssetFallbackUsed, false);
  assert.equal(generationCalls, 5, "two images, two voices and one BGM must use typed media jobs");
  assert.equal(probeCalls, 3, "every selected adapter must be probed before generation");
  assert.equal(first.mediaJobs.length, 5);
  assert.equal(first.adapterProbes.length, 3);
  assert.deepEqual(first.runtimeMetadata, {
    imageModel: "fixture-image-v1",
    ttsProvider: "fixture-voice",
    imageProvider: "fixture-image",
    imageAdapterVersion: "fixture-image-adapter-v1",
    ttsModel: "fixture-voice-v1",
    ttsAdapterVersion: "fixture-voice-adapter-v1",
    musicProvider: "fixture-music",
    musicModel: "fixture-music-v1",
    musicAdapterVersion: "fixture-music-adapter-v1",
  });
  assert.equal((await stat(first.artifacts.previewVideo.path)).size > 0, true);
  assert.equal((await stat(first.artifacts.contactSheet.path)).size > 0, true);
  await assert.rejects(
    () => stat(first.review.signoffPath),
    (error) => error?.code === "ENOENT",
    "production must never create its own visual signoff",
  );
  const perceptual = new Set([
    "perceptualReviewChecks",
    "perceptualReviewBoundToOutput",
    "perceptualEvidenceHashes",
    "contactSheetOriginalDetailReviewed",
  ]);
  // 独立 signoff と品質ループは自動監査の後で判定する。
  assert.equal(first.auditChecks.qualityLoopPassed.pass, false);
  assert.equal(first.review.quality.contractDigest.length, 64);
  // 評価者に渡すシートに合格点・下限・重みを載せない（採点が合格点に寄らないように。合否はループ側だけ）。
  assert.equal(first.review.quality.targetScore, undefined);
  assert.ok(first.review.quality.rubric.every((criterion) => criterion.minimumScore === undefined && criterion.weight === undefined));
  assert.ok(first.knownRemainingIssues.includes("audit-qualityLoopPassed-pending-or-failed"));
  for (const auditId of NARRATED_STORY_AUDIT_IDS) {
    // 品質ループと人物の同一性（署名済み独立レビューの採点）も独立 signoff の後で判定する。
    if (!perceptual.has(auditId) && auditId !== "qualityLoopPassed" && auditId !== "characterIdentityReviewed") {
      assert.equal(
        first.auditChecks[auditId].pass,
        true,
        `${auditId} automatic audit must pass: ${first.auditChecks[auditId].detail}`,
      );
    }
  }

  // 署名の無い自作 signoff（鍵を持たない端末が書いたもの）は、本文が全て正しくても
  // ジャンル側 finalizer が拒否し、理由を audit report に残す。production は signoff を書かない。
  await mkdir(dirname(first.review.signoffPath), { recursive: true });
  await writeFile(first.review.signoffPath, `${JSON.stringify({
    version: NARRATED_STORY_SIGNOFF_VERSION,
    reviewer: "fixture-independent-reviewer",
    reviewerContextId: "fixture-independent-context-02",
    approved: true,
    originalDetailReviewed: true,
    videoSha256: first.review.videoSha256,
    contactSheetSha256: first.review.contactSheetSha256,
    findings: [],
    knownRemainingIssues: [],
  }, null, 2)}\n`, "utf8");
  forbidPaidResume = true;
  const unsignedOuter = await runVideoHarnessJob({
    projectDir: temp,
    jobId: planned.job.id,
    prepare,
    doctor,
    adapter: outerAdapter,
    projectCanvas,
    validateProductionProfile,
  });
  const unsigned = coreOutcome;
  assert.equal(unsignedOuter.status, "awaiting-human-review", "an unsigned signoff must not complete the Job");
  assert.equal(unsigned.status, "awaiting-human-review");
  for (const auditId of perceptual) {
    assert.equal(unsigned.auditChecks[auditId].pass, false);
    assert.match(unsigned.auditChecks[auditId].detail, /reviewer-attestation-missing/u, `${auditId} must name the attestation failure`);
    assert.ok(unsigned.knownRemainingIssues.includes(`audit-${auditId}-pending-or-failed`));
  }
  const rejectedReport = JSON.parse(await readFile(unsigned.artifacts.auditReport.path, "utf8"));
  assert.notEqual(rejectedReport.status, "pass");
  assert.equal(rejectedReport.independentSignoff.status, "rejected");
  assert.ok(rejectedReport.independentSignoff.problems.includes("reviewer-attestation-missing"), "audit report must record why the signoff was rejected");
  assert.equal(unsigned.artifacts.auditReport.sha256, sha256(await readFile(unsigned.artifacts.auditReport.path)), "audit report artifact record must follow the rewritten report");

  // 本物の reviewer 経路: 実 CLI が durable Job の identityDigest を読み、disk の MP4 /
  // contact sheet を hash し、信頼リスト上の鍵で署名する。--force で未署名 fixture を置き換える。
  // 採点ファイルは production が示した評価項目の全部を採点する（品質ループの1回になる）。
  const reviewPath = join(reviewerHome, "review-scores.json");
  await writeFile(reviewPath, JSON.stringify({ rubricScores: reviewScores(first), notes: "全尺を通して見て、画と語りと字幕を確かめた", findings: [] }));
  const signed = await runNarratedCli([
    "signoff",
    "--job-id", planned.job.id,
    "--project-dir", temp,
    "--reviewer", "codex",
    "--reviewer-context-id", "fixture-independent-context-02",
    "--reviewer-key-path", reviewerKeyPath,
    "--review-path", reviewPath,
    "--force",
    "--pass",
  ]);
  assert.equal(signed.outputPath, first.review.signoffPath);
  assert.equal(signed.reviewerKeyId, createdKey.keyId);
  assert.equal(signed.videoSha256, first.review.videoSha256);
  assert.equal(signed.contactSheetSha256, first.review.contactSheetSha256);
  const signedSignoff = JSON.parse(await readFile(first.review.signoffPath, "utf8"));
  assert.equal(signedSignoff.reviewerAttestation.subject.jobId, planned.job.id);
  assert.equal(signedSignoff.reviewerAttestation.subject.identityDigest, planned.job.identityDigest);

  failAfterCompletedCanvasProjection = true;
  const stalledOuter = await runVideoHarnessJob({
    projectDir: temp,
    jobId: planned.job.id,
    prepare,
    doctor,
    adapter: outerAdapter,
    projectCanvas,
    validateProductionProfile,
  });
  const second = coreOutcome;
  assert.equal(
    stalledOuter.status,
    "running",
    `Canvas失敗中はdurable Jobをcompleted/failedへ進めない: ${stalledOuter.error || ""} ${JSON.stringify(stalledOuter.knownRemainingIssues || [])}`,
  );
  assert.equal(stalledOuter.stages.find((stage) => stage.id === "canvas-projection")?.status, "failed");
  const adapterCallsBeforeCanvasRepair = outerAdapterCalls;
  const completedOuter = await runVideoHarnessJob({
    projectDir: temp,
    jobId: planned.job.id,
    doctor: async () => { throw new Error("Canvas-only repair must skip doctor"); },
    adapter: async () => { throw new Error("Canvas-only repair must skip paid adapter"); },
    projectCanvas,
    validateProductionProfile,
  });
  assert.equal(completedOuter.status, "completed");
  assert.equal(outerAdapterCalls, adapterCallsBeforeCanvasRepair, "Canvas repair must not re-enter production");
  assert.equal(second.status, "final-audited");
  assert.deepEqual(second.knownRemainingIssues, []);
  assert.ok(Object.values(second.auditChecks).every((item) => item.pass === true));
  assert.equal(second.mediaJobs.length, 5);
  assert.equal(generationCalls, 5);
  assert.equal(probeCalls, 3);
  assert.equal(networkCalls, 0, "fixture adapters and probes must not touch the network");
  assert.equal((await stat(second.artifacts.finalVideo.path)).size > 0, true);
  assert.equal((await stat(second.runReceiptPath)).size > 0, true);

  await runRuntime(toolchain.ffmpeg, [
    "-hide_banner", "-v", "error", "-xerror", "-i", second.artifacts.finalVideo.path, "-f", "null", "-",
  ]);
  const receiptText = await readFile(second.runReceiptPath, "utf8");
  const receipt = JSON.parse(receiptText);
  assert.equal(receipt.version, "buzzassist-narrated-story-run-receipt-v1");
  assert.equal(receipt.reviewerAttestation.signerKeyId, createdKey.keyId, "genre RunReceipt must record the verified reviewer key");
  const passedReport = JSON.parse(await readFile(second.artifacts.auditReport.path, "utf8"));
  assert.equal(passedReport.status, "pass");
  assert.equal(passedReport.contractVersion, NARRATED_STORY_AUDIT_CONTRACT_VERSION);
  assert.equal(passedReport.qualityLoop.status, "passed");
  assert.equal(passedReport.qualityLoop.rounds, 1);
  assert.equal(passedReport.auditChecks.qualityLoopPassed.signoffSha256, sha256(await readFile(first.review.signoffPath)), "合格した回は今の signoff に結合される");
  assert.equal(receipt.qualityLoop.status, "passed");
  assert.equal(passedReport.independentSignoff.reviewerAttestation.signerKeyId, createdKey.keyId);
  assert.equal(passedReport.independentSignoff.reviewerAttestation.reviewerLabel, "e2e independent reviewer");
  assert.equal(receipt.mediaJobs.length, 5);
  assert.equal(receipt.providerVersions.length, 3);
  for (const mediaJob of receipt.mediaJobs) {
    assert.ok(mediaJob.provider);
    assert.ok(mediaJob.adapterVersion);
    assert.ok(mediaJob.providerJobId);
    assert.match(mediaJob.requestKey, /^media:/u);
    assert.match(mediaJob.inputHash, /^[a-f0-9]{64}$/u);
    assert.match(mediaJob.identityHash, /^[a-f0-9]{64}$/u);
    assert.ok(mediaJob.reservation.reservationId);
    assert.equal(typeof mediaJob.usage.cost, "number");
    assert.equal(typeof mediaJob.usage.units, "number");
    if (mediaJob.kind === "voice.synthesis") {
      assert.equal(mediaJob.voiceId, "fixture-ja");
      assert.equal(typeof mediaJob.usage.seconds, "number");
    }
  }
  const commonReceiptArtifact = completedOuter.artifacts.find((artifact) => artifact.kind === "run-receipt");
  assert.ok(commonReceiptArtifact, "outer Job must persist the common RunReceipt");
  const commonReceiptText = await readFile(commonReceiptArtifact.path, "utf8");
  const commonReceipt = JSON.parse(commonReceiptText);
  const signoffSha256 = sha256(await readFile(first.review.signoffPath));
  assert.equal(commonReceipt.outcome, "pass");
  assert.equal(commonReceipt.approvals.length, 1);
  assert.equal(commonReceipt.approvals[0].evidenceDigest, signoffSha256, "RunReceipt must retain the actual signoff SHA");
  assert.equal(commonReceipt.inputDigests.reviewerAttestationSubject, sha256("narrated-story-video"));
  assert.ok(commonReceipt.inputDigests.reviewerTrustSha256, "common RunReceipt must bind the trust list it verified against");
  assert.equal(
    commonReceipt.artifacts.find((artifact) => artifact.kind === "final-video")?.sha256,
    second.artifacts.finalVideo.sha256,
  );
  assert.equal(
    commonReceipt.artifacts.find((artifact) => artifact.kind === "contact-sheet")?.sha256,
    second.artifacts.contactSheet.sha256,
  );

  const canvasState = JSON.parse(await readFile(resolveCanvasRunStateFile({ projectDir: temp }, completedOuter.id), "utf8"));
  assert.equal(canvasState.status, "complete");
  assert.equal(
    canvasState.artifacts.find((artifact) => artifact.kind === "final-mp4")?.sha256,
    `sha256:${second.artifacts.finalVideo.sha256}`,
  );
  assert.equal(
    canvasState.artifacts.find((artifact) => artifact.kind === "contact-sheet")?.sha256,
    `sha256:${second.artifacts.contactSheet.sha256}`,
  );
  assert.equal(canvasState.signoffs.length, 1);
  assert.equal(canvasState.signoffs[0].evidenceSha256, `sha256:${signoffSha256}`);
  const canvasScene = JSON.parse(await readFile(resolveCanvasFile({ projectDir: temp }), "utf8"));
  const actualMedia = canvasScene.elements.filter((element) => (
    element.customData?.[CANVAS_RUN_MEDIA_TAG] === true && element.isDeleted !== true
  ));
  assert.equal(
    actualMedia.some((element) => element.customData?.buzzassistArtifactKind === "final-mp4"
      && element.customData?.buzzassistArtifactSha256 === `sha256:${second.artifacts.finalVideo.sha256}`),
    true,
    "Canvas must contain the actual final MP4 media element",
  );
  assert.equal(
    actualMedia.some((element) => element.customData?.buzzassistArtifactKind === "contact-sheet"
      && element.customData?.buzzassistArtifactSha256 === `sha256:${second.artifacts.contactSheet.sha256}`),
    true,
    "Canvas must contain the actual contact-sheet image element",
  );
  const outcomeText = JSON.stringify(second);
  for (const forbidden of [rawScript, "最初の物語", "次の場面", imageStylePrompt, musicPrompt, "provider-secret"]) {
    assert.equal(receiptText.includes(forbidden), false, `RunReceipt leaked: ${forbidden}`);
    assert.equal(commonReceiptText.includes(forbidden), false, `common RunReceipt leaked: ${forbidden}`);
    assert.equal(outcomeText.includes(forbidden), false, `outcome leaked: ${forbidden}`);
  }
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of TRUST_ENV_NAMES) {
      if (originalTrustEnv[name] === undefined) delete process.env[name];
      else process.env[name] = originalTrustEnv[name];
    }
    await rm(temp, { recursive: true, force: true });
    await rm(reviewerHome, { recursive: true, force: true });
  }
});

// ---- bookends（OP → 本編 → 感想）--------------------------------------------------

const BOOKEND_JOB_ID = "video-narrated-story-video-b00ce0de00000001";
const BOOKEND_IDENTITY = "b".repeat(64);

async function runBookendFixture({ root, env, fixture, script = BOOKEND_FIXTURE_SCRIPT, packOptions = {}, adapterOptions = {}, jobId = BOOKEND_JOB_ID }) {
  const payloadDir = join(root, "signed-channel-pack-payload");
  await writeBookendPack(payloadDir, toolchain, packOptions);
  const scriptPath = join(root, "raw-script.txt");
  await writeFile(scriptPath, `${script}\n`, "utf8");
  const adapters = bookendFixtureAdapters(fixture, adapterOptions);
  const options = {
    command: "full",
    scriptPath,
    channelPackDir: payloadDir,
    jobId,
    jobIdentityDigest: BOOKEND_IDENTITY,
    deploymentRoot: root,
    mediaJobRunner: adapters.mediaJobRunner,
    mediaJobProbe: adapters.mediaJobProbe,
    ffmpegToolchain: toolchain,
    voiceQualityGate: passingVoiceQualityGate,
    env,
  };
  const outcome = await runNarratedStoryVideo(options, { allowDirectUnboundJobForTests: true });
  return { outcome, adapters, options };
}

test("bookends: OP → story → review is rendered as a real MP4, its boundaries pass the measured audit, and a cut narration tail or a removed transition fails", {
  skip: toolchain.ok ? false : "ffmpeg/ffprobe is unavailable",
}, async (t) => {
  const temp = await mkdtemp(join(os.tmpdir(), "narrated-bookends-e2e-"));
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error("bookend fixture E2E forbids external network access");
  };
  try {
    const reviewer = generateReviewerKeyPair();
    const trustPath = join(temp, "operator-reviewer-trust.json");
    await writeFile(trustPath, JSON.stringify({
      version: REVIEWER_TRUST_VERSION,
      reviewers: [createReviewerTrustEntry({ publicKeyPem: reviewer.publicKeyPem, label: "bookend e2e reviewer" })],
    }), "utf8");
    const env = cleanTrustEnv({ [REVIEWER_TRUST_PATH_ENV]: trustPath });
    const fixture = await createBookendFixtureMedia(join(temp, "fixture-media"), toolchain);
    const perceptual = new Set(["perceptualReviewChecks", "perceptualReviewBoundToOutput", "perceptualEvidenceHashes", "contactSheetOriginalDetailReviewed", "qualityLoopPassed", "characterIdentityReviewed"]);
    let passing = null;

    await t.test("the reference render passes every automatic audit, then finalizes only with a signed independent review", async () => {
      const root = join(temp, "pass");
      const { outcome, adapters, options } = await runBookendFixture({ root, env, fixture });
      assert.equal(outcome.status, "awaiting-human-review", JSON.stringify(outcome.knownRemainingIssues));
      // 本編 3 枚の画像、声 5 本（本編 3 + 感想 2）、BGM 1 本。人物素材の感想パートは画像を生成しない。
      assert.equal(adapters.calls.generation, 9);
      assert.equal(adapters.calls.kinds.filter((kind) => kind === "image.generation").length, 3);
      assert.equal(adapters.calls.probe, 3);
      for (const auditId of NARRATED_STORY_AUDIT_IDS) {
        if (perceptual.has(auditId)) continue;
        assert.equal(outcome.auditChecks[auditId].pass, true, `${auditId}: ${outcome.auditChecks[auditId].detail}`);
      }
      const boundaryAudio = outcome.auditChecks.audioBoundaryBreathV16.measurement;
      assert.deepEqual(boundaryAudio.boundaries.map((entry) => entry.id), ["openingToStory", "storyToReview"]);
      assert.equal(boundaryAudio.end.captionCount, 5);
      assert.deepEqual(
        outcome.auditChecks.bookendTransitionMeasured.measurement.boundaries.map((entry) => [entry.id, entry.type, entry.pass]),
        [["openingToStory", "film-burn", true], ["storyToReview", "film-burn", true]],
      );
      await runRuntime(toolchain.ffmpeg, ["-hide_banner", "-v", "error", "-xerror", "-i", outcome.artifacts.previewVideo.path, "-f", "null", "-"]);
      const manifestText = await readFile(outcome.artifacts.generationManifest.path, "utf8");
      const manifest = JSON.parse(manifestText);
      assert.deepEqual(manifest.bookends.parts.map((part) => part.id), ["opening", "story", "review"]);
      assert.equal(manifest.bookends.parts[2].visual, "presenter-video");
      for (const forbidden of ["最初の物語", "感想の一文目", "---感想---", "#ff8c2a"]) {
        assert.equal(manifestText.includes(forbidden), false, `generation manifest leaked ${forbidden}`);
        assert.equal(JSON.stringify(outcome).includes(forbidden), false, `outcome leaked ${forbidden}`);
      }
      passing = { outcome, manifest, root };

      // 自動監査が通っても、独立 reviewer の署名と品質ループの合格が無ければ final にしない。
      // OP・感想を使う Pack なので、境目の評価項目も採点対象に入っている。
      assert.ok(outcome.review.quality.rubric.some((criterion) => criterion.id === "bookend-boundaries"));
      const sign = (reviewerContextId, verdict, overrides = {}, findings = []) => writeNarratedReviewSignoff({
        deploymentRoot: root,
        jobId: BOOKEND_JOB_ID,
        identityDigest: BOOKEND_IDENTITY,
        reviewerHost: "codex",
        reviewerContextId,
        reviewerPrivateKeyPem: reviewer.privateKeyPem,
        env,
        force: true,
        review: { rubricScores: reviewScores(outcome, overrides), notes: "全尺を通して見て、境目と語りを確かめた", findings },
        ...(verdict === "pass" ? { pass: true } : { fail: true }),
      });
      const resume = () => runNarratedStoryVideo({
        ...options,
        mediaJobRunner: async () => { throw new Error("finalize must not regenerate paid media"); },
        mediaJobProbe: async () => { throw new Error("finalize must not reprobe"); },
      }, { allowDirectUnboundJobForTests: true });
      const { statePath: loopStatePath, revisionDeltaPath } = narratedQualityPaths(narratedStoryRunPaths({ deploymentRoot: root, jobId: BOOKEND_JOB_ID }).runDir);
      const rounds = async () => JSON.parse(await readFile(loopStatePath, "utf8")).rounds;

      // 1回目: reviewer が「声が違う」で差し戻す。回として記録され、例外ではなく人待ちになる。
      await sign("bookend-independent-review-01", "fail", { "narration-voice": 50 }, ["感想パートの声が本編の語りと別人に聞こえる"]);
      const rejected = await resume();
      assert.equal(rejected.status, "awaiting-human-review");
      assert.equal(rejected.auditChecks.qualityLoopPassed.pass, false);
      assert.equal(rejected.auditChecks.perceptualReviewChecks.pass, false, "差し戻しは目視の監査を pass にしない");
      assert.ok(rejected.knownRemainingIssues.includes("quality-loop-floor-failed:narration-voice"), JSON.stringify(rejected.knownRemainingIssues));
      assert.ok(rejected.knownRemainingIssues.includes("quality-loop-hard-gate-failed:perceptualReviewChecks"));
      const fingerprint = rejected.auditChecks.qualityLoopPassed.failureFingerprint;
      assert.match(fingerprint, /^quality-failure:/u);
      assert.equal((await rounds()).length, 1);
      const rejectedReport = JSON.parse(await readFile(rejected.artifacts.auditReport.path, "utf8"));
      assert.notEqual(rejectedReport.status, "pass");
      assert.equal(rejectedReport.qualityLoop.rounds, 1, "audit report にもループの状態を残す");
      // 次の回の評価者に渡すシートには、前の回の点数も合格点も載せない。
      assert.equal(JSON.stringify(rejected.review.quality).includes(`"score"`), false);
      assert.equal(rejected.review.quality.targetScore, undefined);

      // 再開しても同じ signoff は二重に記録しない（状態はディスクから引き継ぐ）。
      const resumed = await resume();
      assert.equal(resumed.status, "awaiting-human-review");
      assert.equal(resumed.auditChecks.qualityLoopPassed.failureFingerprint, fingerprint);
      assert.equal((await rounds()).length, 1);

      // 同じ評価文脈で採点し直した signoff での再確定は人待ち。
      await sign("bookend-independent-review-01", "pass");
      const sameContext = await resume();
      assert.equal(sameContext.status, "awaiting-human-review");
      assert.ok(sameContext.knownRemainingIssues.includes("quality-loop-fresh-review-required"));
      assert.equal((await rounds()).length, 1);

      // 新しい文脈でも、修正内容が無ければ人待ち（前回の失敗指紋を示す）。
      await sign("bookend-independent-review-02", "pass");
      const noDelta = await resume();
      assert.equal(noDelta.status, "awaiting-human-review");
      assert.ok(noDelta.knownRemainingIssues.includes(`quality-loop-revision-delta-required:${fingerprint}`));
      assert.equal((await rounds()).length, 1);

      // 修正内容を書いて再開すると2回目が記録され、合格して final-audited になる。
      await writeFile(revisionDeltaPath, JSON.stringify({ previousFailureFingerprint: fingerprint, revisionDelta: "感想パートの声を本編と同じ承認済みの声で聞き直し、別人ではないと確かめた" }));
      const finalized = await resume();
      assert.equal(finalized.status, "final-audited", JSON.stringify(finalized.knownRemainingIssues));
      assert.deepEqual(finalized.knownRemainingIssues, []);
      assert.ok(Object.values(finalized.auditChecks).every((entry) => entry.pass === true));
      const loop = await rounds();
      assert.equal(loop.length, 2);
      assert.equal(loop[1].previousFailureFingerprint, fingerprint);
      const report = JSON.parse(await readFile(finalized.artifacts.auditReport.path, "utf8"));
      assert.equal(report.contractVersion, NARRATED_STORY_AUDIT_CONTRACT_VERSION);
      assert.equal(report.qualityLoop.status, "passed");
      assert.equal(report.qualityLoop.rounds, 2);
    });

    await t.test("a narration take cut mid-word before the story → review boundary fails the measured boundary audio", async () => {
      const root = join(temp, "tail-cut");
      const { outcome } = await runBookendFixture({
        root,
        env,
        fixture,
        adapterOptions: { truncatedLastStoryVoice: true, lastStoryTextHash: sha256("終わりの場面です。") },
      });
      assert.equal(outcome.status, "awaiting-human-review");
      const check = outcome.auditChecks.audioBoundaryBreathV16;
      assert.equal(check.pass, false);
      assert.match(check.detail, /storyToReview:outgoing-narration-tail-cut/u);
      const storyToReview = check.measurement.boundaries.find((entry) => entry.id === "storyToReview");
      assert.ok(storyToReview.metrics.tailDeltaDb > -12, `tail must sit at speech level: ${storyToReview.metrics.tailDeltaDb}`);
      assert.equal(outcome.auditChecks.bookendTransitionMeasured.pass, true, "the picture transition itself is intact");
      assert.ok(outcome.knownRemainingIssues.includes("audit-audioBoundaryBreathV16-pending-or-failed"));
      const report = JSON.parse(await readFile(outcome.artifacts.auditReport.path, "utf8"));
      assert.equal(report.status, "failed");
    });

    await t.test("the same MP4 with its transitions frozen fails the measured transition audit while its audio still passes", async () => {
      assert.ok(passing, "reference render is required");
      const { outcome, manifest, root } = passing;
      const plan = rehydrateBookendPlan({ bookends: manifest.bookends, segments: manifest.segments });
      const [first, second] = plan.boundaries;
      const frozenPath = join(root, "transitions-frozen.mp4");
      const graph = "[0:v]split=3[s][r1][r2];"
        + `[s][r1]freezeframes=first=${first.effectStartFrame}:last=${first.effectEndFrame - 1}:replace=${first.effectStartFrame - 1}[f1];`
        + `[f1][r2]freezeframes=first=${second.effectStartFrame}:last=${second.effectEndFrame - 1}:replace=${second.effectStartFrame - 1}[v]`;
      await runRuntime(toolchain.ffmpeg, [
        "-hide_banner", "-loglevel", "error", "-y", "-i", outcome.artifacts.previewVideo.path,
        "-filter_complex", graph, "-map", "[v]", "-map", "0:a", "-map", "0:s",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "copy", "-c:s", "copy", frozenPath,
      ]);
      const measured = await measureNarratedBookendBoundaries({
        ffmpeg: toolchain.ffmpeg,
        ffprobe: toolchain.ffprobe,
        videoPath: frozenPath,
        voiceStemPath: outcome.artifacts.voiceStem.path,
        plan,
      });
      assert.equal(measured.visual.pass, false);
      for (const boundary of measured.visual.boundaries) {
        assert.ok(boundary.problems.includes("transition-effect-not-observed"), `${boundary.id}: ${boundary.problems.join(", ")}`);
        assert.ok(boundary.problems.includes("film-burn-white-gate-not-observed"), `${boundary.id}: ${boundary.problems.join(", ")}`);
      }
      assert.equal(measured.audio.pass, true, "only the picture was changed");
      // 同じ記録から元の MP4 を測り直せば通る（記録だけで再監査できる）。
      const remeasured = await measureNarratedBookendBoundaries({
        ffmpeg: toolchain.ffmpeg,
        ffprobe: toolchain.ffprobe,
        videoPath: outcome.artifacts.previewVideo.path,
        voiceStemPath: outcome.artifacts.voiceStem.path,
        plan,
      });
      assert.equal(remeasured.visual.pass, true);
      assert.equal(remeasured.audio.pass, true);
    });

    await t.test("an operator-replacement marker stops the Job before any paid call", async () => {
      const root = join(temp, "operator-marker");
      const script = BOOKEND_FIXTURE_SCRIPT.replace("感想の二文目です。", `${OPERATOR_REPLACEMENT_MARKER}実は私も同じ経験をしました。`);
      const { outcome, adapters } = await runBookendFixture({ root, env, fixture, script, jobId: "video-narrated-story-video-b00ce0de00000002" });
      assert.equal(outcome.status, "awaiting-operator-input");
      assert.deepEqual(outcome.knownRemainingIssues, ["operator-replacement-required:r002"]);
      assert.equal(adapters.calls.generation, 0);
      assert.equal(adapters.calls.probe, 0);
      assert.equal(outcome.auditChecks.operatorReplacementCleared.pass, false);
    });

    await t.test("a required presenter the Pack does not supply, or a Pack-declared blocker, stops before paid generation", async () => {
      const missingPresenter = await runBookendFixture({
        root: join(temp, "no-presenter"),
        env,
        fixture,
        packOptions: { presenter: null },
        jobId: "video-narrated-story-video-b00ce0de00000003",
      });
      assert.equal(missingPresenter.outcome.status, "awaiting-media");
      assert.ok(missingPresenter.outcome.knownRemainingIssues.includes("channel-pack-config-required:bookends.review.presenter-media-required"));
      assert.equal(missingPresenter.adapters.calls.generation, 0);
      const declared = await runBookendFixture({
        root: join(temp, "declared-blocker"),
        env,
        fixture,
        packOptions: { blockers: [{ id: "review-bed-not-received", what: "the review song has not been delivered" }] },
        jobId: "video-narrated-story-video-b00ce0de00000004",
      });
      assert.equal(declared.outcome.status, "awaiting-operator-input");
      assert.deepEqual(declared.outcome.knownRemainingIssues, ["channel-pack-declared-blocker:review-bed-not-received"]);
      assert.equal(declared.adapters.calls.generation, 0);
      assert.equal(declared.adapters.calls.probe, 0);
    });

    assert.equal(networkCalls, 0, "bookend fixture adapters must not touch the network");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(temp, { recursive: true, force: true });
  }
});
