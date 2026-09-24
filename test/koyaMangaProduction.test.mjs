import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { channelPackPresent, resolveChannelPackPath } from "../lib/channelPackResolver.mjs";

const require = createRequire(import.meta.url);
const requireResolver = () => ({ resolveChannelPackPath });
// 表示名は中立な仮名。実キャスト名を直書きすると、運営者の実名を消しても
// キャスト名からチャンネルが特定できる（公開リポジトリなので）。
// ここで見ているのは「同じ名前が照合されるか」なので、名前の中身は問わない。
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

import {
  approveKoyaCharacterCandidate,
  applyKoyaCharacterBibleSpeechDirectives,
  applyKoyaValidationCanaryVoiceProfiles,
  assertKoyaFullPreflight,
  createKoyaUpstreamPreflightBinding,
  dialogueShotRequiresAnchoredPullout,
  buildKoyaIdentityPackJobInput,
  generateKoyaIdentityPackAssets,
  groupPagesForPacing,
  koyaCameraModeForShot,
  koyaCameraModeForMissingFamily,
  koyaSpeechPronunciationsFromCharacterBible,
  planKoyaMangaProduction,
  prepareKoyaIdentityGenerationImport,
  recommendedKoyaRenderConcurrency,
  recoverKoyaApprovedAudioFromAlignments,
  reconcileKoyaRegisteredCharacterShowBibleStatus,
  registeredIdentityReviewBinding,
  reuseKoyaApprovedAudio,
  assertKoyaStylingSequence,
  runSourceFacePlacement,
  runKoyaMangaFullProduction,
  sourceAvoidRegionsInOverlaySpace,
  synchronizeKoyaValidationCanaryVoiceCasting,
  koyaImagePauseGuidance,
  koyaFullRunLockPauseResult,
  KOYA_FULL_RUN_LOCK_HELD_STATUS,
} from "../lib/koyaMangaProduction.mjs";
import {
  fingerprintKoyaChannelAuthority,
  readKoyaChannelAuthority,
} from "../lib/koyaChannelGovernance.mjs";
import {
  assertKoyaOuterJobBinding,
  createKoyaOuterJobBinding,
} from "../lib/koyaOuterJobBinding.mjs";
import {
  createVideoHarnessExecutionIdentityDigest,
  resolvedProductionContractSha256,
} from "../lib/videoHarnessExecutionIdentity.mjs";
import {
  buildApprovedIdentityPackJobs,
  buildCharacterCandidateJobs,
  effectiveCharacterIdentityCandidate,
  findWorkflowCandidate,
  getCharacterWorkflow,
  markCharacterCandidatesGenerating,
  prepareCharacterWorkflow,
  readCharacterWorkflowStore,
  recordCharacterCandidateResults,
} from "../lib/characterPipeline.mjs";
import { renderEditorialPlatePng } from "../lib/mangaScriptImagePipeline.mjs";
import { requireArtifacts, requireChannelPack } from "./helpers/requirePrerequisites.mjs";

function testRaster(seed = 1, width = 96, height = 72) {
  return Buffer.concat([renderEditorialPlatePng("white-solid", width, height), Buffer.from(`identity-seed-${seed}`)]);
}

// 一時プロジェクトへ Channel Pack を置く。
//
// 以前はプロジェクト側に正本を置かず、ランタイム（リポジトリ）側の pack を
// 暗黙に借りていた。それは開発機でしか成立しない上に、本番でやると
// 別チャンネルの番組ルールで走ることになるので、本番の入口が拒むようにした。
// テストも借りるのをやめ、使う pack を明示する。
// 私有 Channel Pack の有無を見る基準。installChannelPack と同じくリポジトリ直下。
const root = process.cwd();

async function installChannelPack(projectDir) {
  const { cp } = await import("node:fs/promises");
  const source = join(process.cwd(), "channel-packs");
  const { existsSync } = await import("node:fs");
  if (!existsSync(source)) return false;
  await cp(source, join(projectDir, "channel-packs"), { recursive: true });
  return true;
}

function measuredDoctorReport(projectDir, overrides = {}) {
  const ids = [
    "harness-production-route", "node", "ffmpeg", "ffprobe", "ffmpeg-capability",
    "voice-quality-python", "tts-key", "image-key", "channel-pack",
  ];
  const authorityFiles = ["show.json", "locations.json", "thumbnail.json"].map((path, index) => ({
    role: ["show", "locations", "thumbnail"][index],
    path,
    sha256: String(index + 1).repeat(64),
    bytes: 2,
  }));
  const authorityPayload = {
    version: "koya-channel-authority-fingerprint-v1",
    fileCount: authorityFiles.length,
    files: authorityFiles,
  };
  const authorityFingerprint = {
    ...authorityPayload,
    sha256: createHash("sha256").update(JSON.stringify(authorityPayload)).digest("hex"),
  };
  return {
    version: "harness-doctor-v1",
    projectDir,
    harnessId: "koya-manga-video",
    ready: true,
    blocking: [],
    checks: ids.map((id) => ({
      id,
      required: true,
      ok: true,
      ...(id === "tts-key" ? {
        kind: "voice.dialogue",
        provider: "elevenlabs",
        model: "eleven_v3",
        adapterVersion: "elevenlabs-dialogue-server-v1",
        status: "ready",
      } : {}),
      ...(id === "image-key" ? { host: "codex", model: "gpt-image-2-codex" } : {}),
      ...(id === "channel-pack" ? { authorityFingerprint } : {}),
    })),
    ...overrides,
  };
}

function mediaReceiptForFull(cutId, takeIndex) {
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  return {
    version: "paid-media-job-receipt-v1",
    jobId: `job-${cutId}-${takeIndex}`,
    requestKey: `koya:${cutId}:take:${takeIndex + 1}:${digest(`${cutId}:${takeIndex}`)}`,
    status: "completed",
    kind: "voice.dialogue",
    provider: "elevenlabs",
    adapterVersion: "elevenlabs-dialogue-server-v1",
    model: "eleven_v3",
    inputHash: digest(`input:${cutId}:${takeIndex}`),
    artifact: { sha256: digest(`artifact:${cutId}:${takeIndex}`), mimeType: "audio/wav", bytes: 128 },
  };
}

async function createUpstreamPreflightFixture(projectDir, nowMs = Date.parse("2026-09-01T00:00:00.000Z")) {
  const runDir = join(projectDir, "canvas", "harness-runs", "video-koya-manga-video-aaaaaaaaaaaaaaaa");
  const jobPath = join(runDir, "job.json");
  const entrypointPath = resolve(process.cwd(), "scripts/koya-manga-video.mjs");
  const entrypointSha256 = createHash("sha256").update(await readFile(entrypointPath)).digest("hex");
  await mkdir(runDir, { recursive: true });
  const configDir = join(projectDir, "config");
  await mkdir(configDir, { recursive: true });
  const authorityPaths = {
    show: join(configDir, "koya-show-bible.json"),
    locations: join(configDir, "koya-location-bible.json"),
    thumbnail: join(configDir, "koya-thumbnail-contract.json"),
  };
  await Promise.all(Object.entries(authorityPaths).map(([id, path]) => writeFile(path, `${JSON.stringify({ id })}\n`)));
  const authority = {
    source: "project",
    projectDir,
    root: projectDir,
    paths: authorityPaths,
    stylingSpecs: [],
  };
  const authorityFingerprint = await fingerprintKoyaChannelAuthority(authority);
  const doctorEvidence = measuredDoctorReport(projectDir);
  doctorEvidence.checks.find((check) => check.id === "channel-pack").authorityFingerprint = authorityFingerprint;
  // Channel Pack 復元後に一度だけ固定される「解決済み制作契約」。実行識別子は
  // これと Job identity から導かれるので、fixture 側でも同じ導出を通す。
  // ここを手打ちの定数にすると、契約が固定されていることの検証が空洞になる。
  const resolvedProductionContract = {
    version: "buzzassist-resolved-production-contract-v1",
    harnessId: "koya-manga-video",
    episodeId: "",
    contractVersion: "koya-manga-production-fixture-v1",
    contractDigest: "f".repeat(64),
    contractPath: join(configDir, "koya-manga-production-contract.json"),
    contractFileSha256: "9".repeat(64),
    contractSource: "fixture",
    episodeOverridePath: "",
    episodeOverrideFileSha256: "",
  };
  // 信頼鍵で検証済みの Channel Pack も実行識別子の入力。pack を差し替えて
  // 同じ Job を名乗る道を、契約固定と同じ層で塞ぐ。
  const channelPackVerification = {
    harnessId: "koya-manga-video",
    payloadKind: "koya-handoff",
    payloadSha256: "c".repeat(64),
    fileCount: 4,
    signerKeyId: "signer-key",
    trustedPublicKeyId: "trusted-key",
  };
  const job = {
    id: "video-koya-manga-video-aaaaaaaaaaaaaaaa",
    identityDigest: "a".repeat(64),
    executionIdentityDigest: createVideoHarnessExecutionIdentityDigest({
      jobId: "video-koya-manga-video-aaaaaaaaaaaaaaaa",
      identityDigest: "a".repeat(64),
      resolvedProductionContract,
      channelPackVerification,
    }),
    resolvedProductionContract,
    revision: 7,
    status: "running",
    runDir,
    executionProjectDir: projectDir,
    harness: { id: "koya-manga-video" },
    deployment: { entrypointPath, entrypointSha256 },
    canonicalIdentity: {
      deployment: { entrypointPath, entrypointSha256 },
      productionDependencies: {
        version: "buzzassist-production-dependency-tree-v1",
        runtime: {
          version: "buzzassist-production-dependency-tree-v1",
          scope: "runtime",
          digest: "d".repeat(64),
          fileCount: 1,
        },
        deployment: {
          version: "buzzassist-production-dependency-tree-v1",
          scope: "deployment",
          digest: "e".repeat(64),
          fileCount: 1,
        },
      },
    },
    channelPack: { sha256: "b".repeat(64), fileCount: 4 },
    channelPackVerification,
    stages: [{
      id: "doctor",
      status: "pass",
      finishedAt: new Date(nowMs - 1_000).toISOString(),
      evidence: doctorEvidence,
    }],
  };
  const write = async () => writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`);
  await write();
  const options = () => ({
    projectDir,
    upstreamJobPath: jobPath,
    upstreamJobId: job.id,
    upstreamJobRevision: job.revision,
    upstreamPreflightBinding: createKoyaUpstreamPreflightBinding(job),
  });
  const runtime = {
    readKoyaChannelAuthority: async () => authority,
    fingerprintKoyaChannelAuthority,
  };
  return { job, jobPath, nowMs, options, write, authority, authorityPaths, runtime };
}

test("Koya full stops before both paid runners when the canonical doctor blocks", async () => {
  let imageCalls = 0;
  let speechCalls = 0;
  await assert.rejects(
    runKoyaMangaFullProduction({
      projectDir: process.cwd(),
      episodeId: "preflight-blocked",
      scriptPath: "/fixture/script.txt",
    }, {
      allowDirectMeasuredDoctorForTests: true,
      runDoctor: async () => measuredDoctorReport(process.cwd(), {
        ready: false,
        blocking: ["ffmpeg-capability", "image-key"],
      }),
      generateImages: async () => { imageCalls += 1; },
      generateSpeech: async () => { speechCalls += 1; },
    }),
    /preflight failed.*ffmpeg-capability, image-key/iu,
  );
  assert.equal(imageCalls, 0, "image runner must not start after failed preflight");
  assert.equal(speechCalls, 0, "speech runner must not start after failed preflight");
});

test("doctor ready=true cannot bypass a missing exact TTS or image capability", async () => {
  for (const missingId of ["tts-key", "image-key", "ffmpeg-capability", "voice-quality-python"]) {
    let paidCalls = 0;
    const report = measuredDoctorReport(process.cwd());
    report.checks.find((check) => check.id === missingId).ok = false;
    await assert.rejects(
      runKoyaMangaFullProduction({
        projectDir: process.cwd(),
        episodeId: `preflight-exact-${missingId}`,
        scriptPath: "/fixture/script.txt",
      }, {
        allowDirectMeasuredDoctorForTests: true,
        runDoctor: async () => report,
        generateImages: async () => { paidCalls += 1; },
        generateSpeech: async () => { paidCalls += 1; },
      }),
      new RegExp(`passing required check: ${missingId}`, "u"),
    );
    assert.equal(paidCalls, 0, `${missingId}: no paid runner may start`);
  }
});

test("a legacy raw-key-style TTS pass cannot start Koya images without the exact Media Job identity", async () => {
  const report = measuredDoctorReport(process.cwd());
  const tts = report.checks.find((check) => check.id === "tts-key");
  Object.assign(tts, {
    kind: undefined,
    provider: undefined,
    model: undefined,
    adapterVersion: undefined,
    status: undefined,
    detail: "設定あり",
  });
  let paidCalls = 0;
  await assert.rejects(
    runKoyaMangaFullProduction({
      projectDir: process.cwd(),
      episodeId: "preflight-legacy-raw-key",
      scriptPath: "/fixture/script.txt",
    }, {
      allowDirectMeasuredDoctorForTests: true,
      runDoctor: async () => report,
      generateImages: async () => { paidCalls += 1; },
      generateSpeech: async () => { paidCalls += 1; },
    }),
    /not the exact paid adapter/iu,
  );
  assert.equal(paidCalls, 0);
});

test("production Koya full cannot fall back to a direct doctor or reach paid runners", async () => {
  let paidCalls = 0;
  await assert.rejects(
    runKoyaMangaFullProduction({
      projectDir: process.cwd(),
      episodeId: "preflight-direct-forbidden",
      scriptPath: "/fixture/script.txt",
    }, {
      runDoctor: async () => measuredDoctorReport(process.cwd()),
      generateImages: async () => { paidCalls += 1; },
      generateSpeech: async () => { paidCalls += 1; },
    }),
    (error) => error?.code === "KOYA_OUTER_JOB_REQUIRED",
  );
  assert.equal(paidCalls, 0);
});

test("explicit test-only direct Koya full uses the measured doctor exactly once before mocked images", async () => {
  const calls = [];
  const result = await runKoyaMangaFullProduction({
    projectDir: process.cwd(),
    episodeId: "preflight-direct",
    scriptPath: "/fixture/script.txt",
  }, {
    allowDirectMeasuredDoctorForTests: true,
    runDoctor: async (input) => {
      calls.push(["doctor", input]);
      return measuredDoctorReport(process.cwd());
    },
    generateImages: async () => {
      calls.push(["images"]);
      return {
        episodeId: "preflight-direct",
        waiting: true,
        failed: false,
        state: { status: "awaiting-character-approval", knownRemainingIssues: ["fixture"] },
        paths: { statePath: "/fixture/state.json" },
      };
    },
    generateSpeech: async () => { calls.push(["speech"]); },
  });
  assert.equal(result.preflight.mode, "direct-measured-doctor");
  assert.equal(result.exitCode, 3);
  assert.deepEqual(calls.map(([name]) => name), ["doctor", "images"]);
  assert.equal(calls[0][1].harnessId, "koya-manga-video");
});

test("Koya full returns every paid speech take and exact final signoff binding to the common adapter", async () => {
  const jobs = [mediaReceiptForFull("cut-01", 0), mediaReceiptForFull("cut-01", 1)];
  const result = await runKoyaMangaFullProduction({
    projectDir: process.cwd(),
    episodeId: "preflight-full-receipt",
    scriptPath: "/fixture/script.txt",
  }, {
    allowDirectMeasuredDoctorForTests: true,
    runDoctor: async () => measuredDoctorReport(process.cwd()),
    generateImages: async () => ({ episodeId: "preflight-full-receipt", waiting: false, failed: false }),
    prepareManifest: async () => ({ waiting: false }),
    generateSpeech: async () => ({ waiting: false, partial: false, report: { mediaJobs: jobs } }),
    renderVideo: async () => ({
      outputPath: "/fixture/final.mp4",
      paths: { manifestPath: "/fixture/manifest.json" },
    }),
    auditFinal: async () => ({
      report: { pass: true, failedAuditIds: [], knownRemainingIssues: [] },
      reportPath: "/fixture/audit.json",
      contactSheetPath: "/fixture/contact-sheet.jpg",
      signoffPath: "/fixture/signoff.json",
      signoffSha256: "f".repeat(64),
      runReceiptPath: "/fixture/genre-receipt.json",
    }),
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.payload.mediaJobs, jobs);
  assert.equal(result.payload.visualSignoffPath, "/fixture/signoff.json");
  assert.equal(result.payload.visualSignoffSha256, "f".repeat(64));
});

test("two direct Koya full coordinators for one episode cannot race shared paid work", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "koya-full-lock-"));
  let releaseImages;
  let enteredImages;
  const entered = new Promise((resolveEntered) => { enteredImages = resolveEntered; });
  const release = new Promise((resolveRelease) => { releaseImages = resolveRelease; });
  let imageCalls = 0;
  const runtime = {
    allowDirectMeasuredDoctorForTests: true,
    runDoctor: async () => measuredDoctorReport(projectDir),
    generateImages: async () => {
      imageCalls += 1;
      enteredImages();
      await release;
      return {
        episodeId: "single-coordinator",
        waiting: true,
        failed: false,
        state: { status: "images-paused", knownRemainingIssues: [] },
      };
    },
  };
  try {
    const options = { projectDir, episodeId: "single-coordinator", scriptPath: "/fixture/script.txt" };
    const first = runKoyaMangaFullProduction(options, runtime);
    await entered;
    // 2026-09-24: 錠が取れない2本目は、失敗（throw → 外側 Job が failed）ではなく
    // 人待ち（exit 3）で止まる。有料の画像工程には到達しないことは変わらない。
    const second = await runKoyaMangaFullProduction(options, runtime);
    assert.equal(second.exitCode, 3);
    assert.equal(second.payload.status, KOYA_FULL_RUN_LOCK_HELD_STATUS);
    assert.equal(second.payload.knownRemainingIssues[0].id, "full-run-lock");
    assert.equal(imageCalls, 1, "the paused coordinator must not reach paid image work");
    releaseImages();
    const result = await first;
    assert.equal(result.exitCode, 3);
  } finally {
    releaseImages?.();
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("partial upstream evidence fails closed before any paid runner", async () => {
  let paidCalls = 0;
  await assert.rejects(
    runKoyaMangaFullProduction({
      projectDir: process.cwd(),
      episodeId: "partial-upstream",
      scriptPath: "/fixture/script.txt",
      upstreamJobPath: "/fixture/job.json",
    }, {
      runDoctor: async () => { throw new Error("must not silently fall back"); },
      generateImages: async () => { paidCalls += 1; },
      generateSpeech: async () => { paidCalls += 1; },
    }),
    /Partial upstream preflight evidence/u,
  );
  assert.equal(paidCalls, 0);
});

test("fresh upstream doctor evidence skips the duplicate doctor only for the exact bound Job", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "koya-upstream-preflight-"));
  try {
    const fixture = await createUpstreamPreflightFixture(projectDir);
    let identityChecks = 0;
    const result = await assertKoyaFullPreflight(fixture.options(), {
      ...fixture.runtime,
      now: () => fixture.nowMs,
      verifyJobIdentity: async (job) => {
        identityChecks += 1;
        assert.equal(job.id, fixture.job.id);
      },
      runDoctor: async () => { throw new Error("duplicate doctor must be skipped"); },
    });
    assert.equal(result.mode, "verified-common-job");
    assert.equal(result.jobRevision, 7);
    assert.equal(result.channelPackPayloadSha256, "c".repeat(64));
    assert.equal(identityChecks, 1);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("a long paid stage does not make fresh upstream doctor evidence stale for the next stage in the same process", async () => {
  // 各有料工程が Date.now() で鮮度を測り直していたので、画像工程（実測 13〜16 時間）の
  // 直後の音声工程で必ず「doctor が古い」と落ちた。同じプロセス・同じ binding なら、
  // 最初に検証した時刻を基準にする。新しいプロセスや新しい binding は初回として測る。
  const projectDir = await mkdtemp(join(tmpdir(), "koya-upstream-anchor-"));
  try {
    const fixture = await createUpstreamPreflightFixture(projectDir);
    const sixteenHours = 16 * 60 * 60_000;
    const anchors = new Map();
    const runtime = (nowMs, extra = {}) => ({
      ...fixture.runtime,
      now: () => nowMs,
      verifyJobIdentity: async () => true,
      runDoctor: async () => { throw new Error("verified upstream must not rerun doctor"); },
      preflightAnchors: anchors,
      ...extra,
    });
    const first = await assertKoyaFullPreflight(fixture.options(), runtime(fixture.nowMs));
    assert.equal(first.mode, "verified-common-job");
    const afterImages = await assertKoyaFullPreflight(fixture.options(), runtime(fixture.nowMs + sixteenHours));
    assert.equal(afterImages.mode, "verified-common-job", "同じプロセスの次の工程を、時間が経っただけで止めないこと");
    assert.equal(afterImages.jobRevision, first.jobRevision);
    // 別のプロセス（最初の検証を知らない）では、16 時間前の doctor は古いまま。
    await assert.rejects(
      () => assertKoyaFullPreflight(fixture.options(), runtime(fixture.nowMs + sixteenHours, { preflightAnchors: new Map() })),
      /stale/iu,
    );
    // 外側の Job が doctor を走らせ直せば binding が変わり、新しい初回として通る。
    fixture.job.stages[0].finishedAt = new Date(fixture.nowMs + sixteenHours - 1_000).toISOString();
    await fixture.write();
    const refreshed = await assertKoyaFullPreflight(fixture.options(), runtime(fixture.nowMs + sixteenHours, { preflightAnchors: new Map() }));
    assert.equal(refreshed.mode, "verified-common-job");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("verified outer Job identity is propagated unchanged to every Koya full stage", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "koya-outer-job-propagation-"));
  try {
    const fixture = await createUpstreamPreflightFixture(projectDir);
    const observed = {};
    const result = await runKoyaMangaFullProduction({
      ...fixture.options(),
      episodeId: "outer-job-propagation",
      scriptPath: "/fixture/script.txt",
    }, {
      ...fixture.runtime,
      now: () => fixture.nowMs,
      verifyJobIdentity: async () => true,
      runDoctor: async () => { throw new Error("verified upstream must not rerun doctor"); },
      generateImages: async (options) => {
        observed.images = options.outerJobBinding;
        return { episodeId: options.episodeId, waiting: false, failed: false };
      },
      prepareManifest: async (options) => {
        observed.prepare = options.outerJobBinding;
        return { waiting: false };
      },
      generateSpeech: async (options) => {
        observed.speech = options.outerJobBinding;
        return { waiting: false, partial: false, report: { mediaJobs: [mediaReceiptForFull("cut-01", 0)] } };
      },
      renderVideo: async (options) => {
        observed.render = options.outerJobBinding;
        return { outputPath: "/fixture/final.mp4", paths: { manifestPath: "/fixture/manifest.json" } };
      },
      auditFinal: async (options) => {
        observed.audit = options.outerJobBinding;
        return {
          report: { pass: true, failedAuditIds: [], knownRemainingIssues: [] },
          reportPath: "/fixture/audit.json",
          contactSheetPath: "/fixture/contact-sheet.jpg",
          signoffPath: "/fixture/signoff.json",
          signoffSha256: "f".repeat(64),
          runReceiptPath: "/fixture/genre-receipt.json",
        };
      },
    });
    const expected = createKoyaOuterJobBinding({
      jobId: fixture.job.id,
      identityDigest: fixture.job.identityDigest,
      executionIdentityDigest: fixture.job.executionIdentityDigest,
      resolvedProductionContractSha256: resolvedProductionContractSha256(fixture.job.resolvedProductionContract),
    });
    assert.equal(result.exitCode, 0);
    for (const stage of ["images", "prepare", "speech", "render", "audit"]) {
      assert.deepEqual(assertKoyaOuterJobBinding(observed[stage], { required: true }), expected, stage);
    }
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("upstream evidence rejects TOCTOU tamper, stale doctor, another Job, and another Channel Pack before paid work", async () => {
  const cases = [
    {
      name: "tampered-after-launch",
      mutate: (fixture) => { fixture.job.stages[0].evidence.checks[0].ok = false; },
      keepOriginalBinding: true,
      expected: /changed after the parent launched/iu,
    },
    {
      name: "stale-doctor",
      mutate: (fixture) => { fixture.job.stages[0].finishedAt = new Date(fixture.nowMs - 16 * 60_000).toISOString(); },
      expected: /stale/iu,
    },
    {
      name: "another-job",
      mutate: (fixture) => { fixture.job.revision += 1; },
      keepOriginalOptions: true,
      expected: /stale or belongs to another Job/iu,
    },
    {
      // 検証済み pack は実行識別子の入力なので、pack だけ差し替えると識別子が合わない。
      name: "another-channel-pack",
      mutate: (fixture) => { fixture.job.channelPackVerification.payloadKind = "narrated-story-channel-pack"; },
      expected: /execution identity does not match/iu,
    },
    {
      name: "another-channel-pack-payload",
      mutate: (fixture) => { fixture.job.channelPackVerification.payloadSha256 = "9".repeat(64); },
      expected: /execution identity does not match/iu,
    },
    {
      // 所有者が Job ごと書き換えて識別子を辻褄合わせしても、Koya 用 pack の
      // 意味ゲートは別に立っている。hash は所有者への対抗手段ではない。
      name: "consistent-rewrite-to-another-harness-pack",
      mutate: (fixture) => {
        fixture.job.channelPackVerification.payloadKind = "narrated-story-channel-pack";
        fixture.job.executionIdentityDigest = createVideoHarnessExecutionIdentityDigest({
          jobId: fixture.job.id,
          identityDigest: fixture.job.identityDigest,
          resolvedProductionContract: fixture.job.resolvedProductionContract,
          channelPackVerification: fixture.job.channelPackVerification,
        });
      },
      expected: /trusted Koya Channel Pack/iu,
    },
    {
      name: "contract-override-changed-after-identity",
      mutate: (fixture) => { fixture.job.resolvedProductionContract.episodeOverrideFileSha256 = "1".repeat(64); },
      expected: /execution identity does not match/iu,
    },
    {
      name: "execution-identity-missing",
      mutate: (fixture) => { delete fixture.job.executionIdentityDigest; },
      expected: /execution identity is missing/iu,
    },
    {
      name: "execution-identity-upper-cased",
      mutate: (fixture) => { fixture.job.executionIdentityDigest = fixture.job.executionIdentityDigest.toUpperCase(); },
      expected: /not a canonical lowercase SHA-256/iu,
    },
    {
      name: "execution-identity-trailing-space",
      mutate: (fixture) => { fixture.job.executionIdentityDigest = `${fixture.job.executionIdentityDigest} `; },
      expected: /not a canonical lowercase SHA-256/iu,
    },
    {
      name: "deployment-bytes",
      mutate: (fixture) => { fixture.job.deployment.entrypointSha256 = "d".repeat(64); },
      expected: /deployment bytes changed/iu,
    },
  ];
  for (const item of cases) {
    const projectDir = await mkdtemp(join(tmpdir(), `koya-upstream-${item.name}-`));
    try {
      const fixture = await createUpstreamPreflightFixture(projectDir);
      const originalOptions = fixture.options();
      item.mutate(fixture);
      await fixture.write();
      const options = item.keepOriginalOptions
        ? originalOptions
        : {
          ...fixture.options(),
          ...(item.keepOriginalBinding ? { upstreamPreflightBinding: originalOptions.upstreamPreflightBinding } : {}),
        };
      let paidCalls = 0;
      await assert.rejects(
        runKoyaMangaFullProduction({
          ...options,
          episodeId: `preflight-${item.name}`,
          scriptPath: "/fixture/script.txt",
        }, {
          now: () => fixture.nowMs,
          ...fixture.runtime,
          verifyJobIdentity: async () => true,
          generateImages: async () => { paidCalls += 1; },
          generateSpeech: async () => { paidCalls += 1; },
        }),
        item.expected,
        item.name,
      );
      assert.equal(paidCalls, 0, `${item.name}: no paid runner may start`);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  }
});

test("upstream evidence rejects restored authority-byte tamper before any paid runner", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "koya-upstream-authority-tamper-"));
  try {
    const fixture = await createUpstreamPreflightFixture(projectDir);
    await writeFile(fixture.authorityPaths.show, `${JSON.stringify({ id: "show", changed: true })}\n`);
    let paidCalls = 0;
    await assert.rejects(
      runKoyaMangaFullProduction({
        ...fixture.options(),
        episodeId: "preflight-authority-tamper",
        scriptPath: "/fixture/script.txt",
      }, {
        ...fixture.runtime,
        now: () => fixture.nowMs,
        verifyJobIdentity: async () => true,
        generateImages: async () => { paidCalls += 1; },
        generateSpeech: async () => { paidCalls += 1; },
      }),
      /authority bytes changed after the common doctor/iu,
    );
    assert.equal(paidCalls, 0);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});


/**
 * pack の show bible から表示名を引く。テストへ実キャスト名を直書きしないため
 * ——直書きすると、運営者の実名を消してもキャスト名からチャンネルが特定できる。
 * JSON へ埋める値なので同期で読む。
 */
function showBibleNameFor(castId) {
  const { readFileSync, existsSync } = require("node:fs");
  const { resolveChannelPackPath } = requireResolver();
  const file = resolveChannelPackPath(process.cwd(), "config/koya-show-bible.json");
  if (!existsSync(file)) return castId;
  const bible = JSON.parse(readFileSync(file, "utf8"));
  const member = (bible.cast || []).find((entry) => entry.id === castId);
  return member?.hiddenName || member?.name || castId;
}

test("validation canary assigns provisional voices without mutating the fixed character registry", () => {
  const registry = {
    characters: [
      { id: "registry-reiji", name: "検証用キャストB", aliases: ["レイジ"], voiceId: "" },
      { id: "registry-ibuki", name: "検証用キャストA", aliases: ["イブキ"], voiceId: "" },
    ],
    voices: [
      { id: "voice-reiji", name: "Reiji preview", providerVoiceId: "provider-reiji", modelId: "eleven_v3", status: "approved" },
      { id: "voice-ibuki", name: "Ibuki preview", providerVoiceId: "provider-ibuki", modelId: "eleven_v3", status: "approved-native-japanese" },
    ],
  };
  const manifest = {
    utterances: [
      { id: "u1", speakerId: "registry-reiji", speakerName: "検証用キャストB", text: "僕が確認する" },
      { id: "u2", speakerId: "registry-ibuki", speakerName: "検証用キャストA", text: "答え合わせだ" },
      { id: "u3", speakerId: "narration", speakerName: "ナレーション", preset: "narration", text: "その時だった" },
    ],
  };
  const canary = {
    version: "koya-validation-canary-v1",
    active: true,
    pass: true,
    episodeId: "manga-approved-eight-canary-001",
    scope: "one-off-non-public-quality-preview",
    publicationEligible: false,
    reason: "one-off preview",
    provisionalVoiceProfileByCastId: { reiji: "voice-reiji", ibuki: "voice-ibuki" },
  };
  const showBible = { cast: [
    { id: "reiji", name: "検証用キャストB" },
    { id: "ibuki", name: "検証用キャストA" },
  ] };
  const output = applyKoyaValidationCanaryVoiceProfiles(manifest, canary, registry, showBible);
  assert.equal(output.utterances[0].voiceId, "provider-reiji");
  assert.equal(output.utterances[1].voiceId, "provider-ibuki");
  assert.equal(output.utterances[2].voiceId, undefined);
  assert.equal(output.production.validationCanary.publicationEligible, false);
  assert.equal(output.speech.voiceCasting.status, "validation-canary-provisional");
  assert.deepEqual(output.speech.voiceCasting.assignments.map((entry) => entry.voiceId), ["provider-reiji", "provider-ibuki"]);
  assert.equal(registry.characters[0].voiceId, "");

  assert.throws(() => applyKoyaValidationCanaryVoiceProfiles(manifest, {
    ...canary,
    provisionalVoiceProfileByCastId: { reiji: "voice-reiji", ibuki: "voice-reiji" },
  }, registry, showBible), /cannot reuse provider voice/iu);
});

test("validation canary casting ledger follows the protagonist voice used by narration", () => {
  const output = synchronizeKoyaValidationCanaryVoiceCasting({
    production: { validationCanary: { active: true } },
    speech: { voiceCasting: { status: "stale-auto-cast" } },
    utterances: [
      { speakerId: "hero", speakerName: "主人公", voiceProfileId: "hero-profile", voiceId: "hero-voice", voiceName: "Hero" },
      { speakerId: "narration", speakerName: "ナレーション", preset: "narration", voiceProfileId: "hero-profile", voiceId: "hero-voice", voiceName: "Hero", voiceSourceSpeakerId: "hero" },
    ],
  });
  assert.equal(output.speech.voiceCasting.status, "validation-canary-provisional");
  assert.equal(output.speech.voiceCasting.assignments.length, 2);
  assert.equal(output.speech.voiceCasting.assignments[1].characterId, "narration");
  assert.equal(output.speech.voiceCasting.assignments[1].voiceSourceSpeakerId, "hero");
});


test("identity-pack generation checkpoints each paid image and resumes without duplicate calls", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "koya-identity-checkpoint-"));
  try {
    const canvasDir = join(projectDir, "canvas");
    const identityPackDir = join(canvasDir, "assets/characters/episode/approved-identity-packs");
    const referencePath = join(canvasDir, "assets/base.png");
    await mkdir(join(canvasDir, "assets"), { recursive: true });
    await writeFile(referencePath, testRaster(1));
    const jobs = ["turnaround", "expression"].map((role) => ({
      prompt: `Generate ${role}`,
      model: "test-image-model",
      aspectRatio: "16:9",
      imageSize: "2K",
      quality: "high",
      referenceImagePaths: [referencePath],
      fileName: `${role}.png`,
      pipeline: { identityRole: role },
    }));
    let calls = 0;
    const common = {
      projectDir,
      canvasDir,
      identityPackDir,
      workflowId: "workflow-1",
      castId: "cast-1",
      candidateSha256: createHash("sha256").update(await readFile(referencePath)).digest("hex"),
      generatorHost: "codex",
      generatorId: "identity-generator",
      generatorContextId: "identity-generation-task",
      jobs,
    };
    const first = await generateKoyaIdentityPackAssets({
      ...common,
      generateImage: async () => ({ buffer: testRaster(++calls + 10) }),
    });
    assert.equal(calls, 2);
    assert.equal(first.generatedCount, 2);
    assert.equal(first.resumed, false);
    const second = await generateKoyaIdentityPackAssets({
      ...common,
      generateImage: async () => { throw new Error("must not regenerate checkpointed identity assets"); },
    });
    assert.equal(second.reusedCount, 2);
    assert.equal(second.resumed, true);
    const checkpoint = JSON.parse(await readFile(first.checkpointPath, "utf8"));
    checkpoint.entries = checkpoint.entries.map((entry) => entry.key === "expression:"
      ? { ...entry, status: "generating", outputSha256: "", completedAt: "" }
      : entry);
    await writeFile(first.checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
    const recovered = await generateKoyaIdentityPackAssets({
      ...common,
      generateImage: async () => { throw new Error("must recover atomic output after interruption"); },
    });
    assert.equal(recovered.recoveredCount, 1);
    const repairJob = {
      ...jobs[0],
      prompt: "Repair only the failed turnaround grid containment",
      fileName: "turnaround-repair-grid-v2.png",
    };
    const repair = await generateKoyaIdentityPackAssets({
      ...common,
      generationScopeId: "repair:grid-v2",
      jobs: [repairJob],
      generateImage: async () => ({ buffer: testRaster(++calls + 20) }),
    });
    assert.equal(repair.generatedCount, 1);
    assert.notEqual(repair.checkpointPath, first.checkpointPath);
    assert.notEqual(repair.results[0].assetFile, first.results[0].assetFile);
    const resumedRepair = await generateKoyaIdentityPackAssets({
      ...common,
      generationScopeId: "repair:grid-v2",
      jobs: [repairJob],
      generateImage: async () => { throw new Error("must not regenerate a checkpointed repair role"); },
    });
    assert.equal(resumedRepair.reusedCount, 1);
    await writeFile(first.results[0].assetFile, testRaster(99));
    await assert.rejects(() => generateKoyaIdentityPackAssets({
      ...common,
      generateImage: async () => ({ buffer: testRaster(100) }),
    }), /checkpoint digest mismatch/u);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("registered identity refresh reads finalized review evidence from the workflow top level and registry approval", () => {
  const reviewPath = "/project/canvas/character-reviews/workflow/cast/identity-pack/identity-pack-review.json";
  assert.deepEqual(registeredIdentityReviewBinding({
    status: "ready",
    identityReviewPath: reviewPath,
    approval: { approvedBy: "human" },
  }, {
    status: "approved",
    approval: { identityReviewPath: reviewPath, identityReviewSha256: "a".repeat(64) },
  }), { path: reviewPath, sha256: "a".repeat(64) });
  assert.equal(registeredIdentityReviewBinding({ identityReviewPath: reviewPath }, {
    approval: { identityReviewPath: `${reviewPath}.other`, identityReviewSha256: "a".repeat(64) },
  }), null);
});

test("registered character reconciliation promotes only a ready SHA-bound client-approved show member", async (t) => {
  if (!channelPackPresent(root)) {
    t.skip("channel pack が無い環境");
    return;
  }
  const projectDir = await mkdtemp(join(tmpdir(), "koya-registration-reconcile-"));
  try {
    assert.equal(await installChannelPack(projectDir), true);
    const canvasDir = join(projectDir, "canvas");
    const reviewPath = join(canvasDir, "character-reviews", "reiji-review.json");
    await mkdir(join(canvasDir, "character-reviews"), { recursive: true });
    await writeFile(reviewPath, "approved identity review\n");
    const reviewSha256 = createHash("sha256").update(await readFile(reviewPath)).digest("hex");
    await writeFile(join(canvasDir, "character-workflows.json"), `${JSON.stringify({
      version: 1,
      workflows: [{
        id: "workflow-reiji",
        episodeId: "appare-fixed-cast",
        cast: [{
          id: "appare-fixed-cast-character-4",
          // show bible と照合される箇所だけは pack から名前を引く。
          // 仮名を書くと「宣言されていない」で落ちる——実データとの対応を
          // 見ているテストなので、名前の中身が問われる。
          name: showBibleNameFor("reiji"),
          aliases: ["レイジ"],
          role: "fixed",
          status: "ready",
          identityReviewPath: reviewPath,
        }],
      }],
    }, null, 2)}\n`);
    await writeFile(join(canvasDir, "characters.json"), `${JSON.stringify({
      version: 1,
      characters: [{
        id: "appare-fixed-cast-character-4",
        name: "検証用キャストB",
        status: "approved",
        approval: { identityReviewPath: reviewPath, identityReviewSha256: reviewSha256 },
      }],
    }, null, 2)}\n`);
    const showBiblePath = join(projectDir, "channel-packs", "koya", "config", "koya-show-bible.json");
    const showBible = JSON.parse(await readFile(showBiblePath, "utf8"));
    showBible.cast = showBible.cast.map((member) => member.id === "reiji"
      ? { ...member, designStatus: "client-approved-awaiting-official-import" }
      : member);
    await writeFile(showBiblePath, `${JSON.stringify(showBible, null, 2)}\n`);

    const first = await reconcileKoyaRegisteredCharacterShowBibleStatus({
      projectDir,
      workflowId: "workflow-reiji",
      castId: "appare-fixed-cast-character-4",
    });
    assert.equal(first.updated, true);
    assert.equal(first.previousDesignStatus, "client-approved-awaiting-official-import");
    assert.equal(first.designStatus, "approved");
    const updatedShowBible = JSON.parse(await readFile(showBiblePath, "utf8"));
    assert.equal(updatedShowBible.cast.find((member) => member.id === "reiji").designStatus, "approved");

    const second = await reconcileKoyaRegisteredCharacterShowBibleStatus({
      projectDir,
      workflowId: "workflow-reiji",
      castId: "appare-fixed-cast-character-4",
    });
    assert.equal(second.updated, false);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("identity generation import binds exact official input and generated source bytes", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "koya-identity-import-"));
  try {
    const canvasDir = join(projectDir, "canvas");
    const referencePath = join(canvasDir, "assets/reference.png");
    const sourcePath = join(canvasDir, "assets/imported-turnaround.png");
    await mkdir(join(canvasDir, "assets"), { recursive: true });
    await writeFile(referencePath, testRaster(71));
    await writeFile(sourcePath, testRaster(72));
    const candidateSha256 = createHash("sha256").update(await readFile(referencePath)).digest("hex");
    const sourceSha256 = createHash("sha256").update(await readFile(sourcePath)).digest("hex");
    const generator = { host: "codex", id: "codex-imagegen-tool", contextId: "identity-import-test" };
    const job = {
      prompt: "Exact approved turnaround",
      model: "gpt-image-test",
      aspectRatio: "16:9",
      imageSize: "2K",
      quality: "high",
      referenceImagePaths: [referencePath],
      fileName: "turnaround.png",
      pipeline: { identityRole: "turnaround", storyStage: "" },
    };
    const binding = await buildKoyaIdentityPackJobInput({
      workflowId: "workflow-1",
      castId: "cast-1",
      candidateSha256,
      generator,
      job,
    });
    const importMapPath = join(canvasDir, "identity-import.json");
    await writeFile(importMapPath, JSON.stringify({
      version: "koya-identity-generation-import-v1",
      workflowId: "workflow-1",
      castId: "cast-1",
      candidateSha256,
      generator,
      generationScopeId: "refresh:test",
      entries: [{ key: "turnaround:", sourceFile: sourcePath, sourceSha256, inputSha256: binding.inputSha256 }],
    }));
    const imported = await prepareKoyaIdentityGenerationImport({
      canvasDir,
      importMapPath,
      workflowId: "workflow-1",
      castId: "cast-1",
      candidateSha256,
      generator,
      generationScopeId: "refresh:test",
      jobs: [job],
    });
    assert.deepEqual((await imported.generateImage(job)).buffer, await readFile(sourcePath));
    job.prompt = "Changed after generation";
    await assert.rejects(() => prepareKoyaIdentityGenerationImport({
      canvasDir,
      importMapPath,
      workflowId: "workflow-1",
      castId: "cast-1",
      candidateSha256,
      generator,
      generationScopeId: "refresh:test",
      jobs: [job],
    }), /input SHA-256 mismatch/u);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("edge dialogue speakers require an anchored pull-out camera", () => {
  assert.equal(dialogueShotRequiresAnchoredPullout({ x: 0.2, y: 0.15, width: 0.15, height: 0.28 }), true);
  assert.equal(dialogueShotRequiresAnchoredPullout({ x: 0.43, y: 0.3, width: 0.14, height: 0.25 }), false);
});

test("split-page source faces expand in the actual overlay raster space", () => {
  assert.deepEqual(sourceAvoidRegionsInOverlaySpace([
    { id: "face", kind: "face", x: 0.5, y: 0.25, width: 0.1, height: 0.2 },
  ], { width: 1672, height: 941 }, { width: 1920, height: 1080 }), [{
    id: "face",
    kind: "face",
    x: 836,
    y: 235.25,
    width: 167.20000000000002,
    height: 188.20000000000002,
  }]);
});

test("3x camera rendering uses a memory-aware concurrency cap", () => {
  assert.equal(recommendedKoyaRenderConcurrency({
    cameraOversample: 3,
    cpuCount: 8,
    totalMemoryBytes: 16 * 1024 ** 3,
  }), 2);
  assert.equal(recommendedKoyaRenderConcurrency({
    cameraOversample: 3,
    cpuCount: 16,
    totalMemoryBytes: 32 * 1024 ** 3,
  }), 4);
  assert.equal(recommendedKoyaRenderConcurrency({
    requested: 3,
    cameraOversample: 3,
    cpuCount: 8,
    totalMemoryBytes: 16 * 1024 ** 3,
  }), 3);
});

test("source-face placement never accepts a stale passing report after the detector fails", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "koya-stale-source-face-"));
  const scriptsDir = join(projectDir, "scripts");
  const dataDir = join(scriptsDir, "data");
  const episodeDir = join(projectDir, "episode");
  const reportPath = join(episodeDir, "source-face-placement.json");
  const planPath = join(projectDir, "plan.json");
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(episodeDir, { recursive: true }),
  ]);
  await writeFile(join(scriptsDir, "detect-koya-manga-source-faces.py"), "raise SystemExit(2)\n");
  await writeFile(join(dataDir, "lbpcascade_animeface.xml"), "unused\n");
  await writeFile(planPath, "{}\n");
  await writeFile(reportPath, JSON.stringify({ pass: true, rows: [] }));
  await assert.rejects(
    () => runSourceFacePlacement({ projectDir, sourceFaceReportPath: reportPath }, planPath),
    /failed before producing evidence/u,
  );
  await assert.rejects(() => readFile(reportPath), /ENOENT/u);
});

test("source-face placement preserves Windows launcher arguments from the resolved runtime", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "koya-windows-source-face-"));
  const scriptsDir = join(projectDir, "scripts");
  const dataDir = join(scriptsDir, "data");
  const episodeDir = join(projectDir, "episode");
  const reportPath = join(episodeDir, "source-face-placement.json");
  const planPath = join(projectDir, "plan.json");
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(episodeDir, { recursive: true }),
  ]);
  await writeFile(join(scriptsDir, "detect-koya-manga-source-faces.py"), "# fixture\n");
  await writeFile(join(dataDir, "lbpcascade_animeface.xml"), "fixture\n");
  await writeFile(planPath, "{}\n");
  let invocation;
  const result = await runSourceFacePlacement(
    { projectDir, sourceFaceReportPath: reportPath },
    planPath,
    "",
    {
      pythonRuntime: { ok: true, command: "py.exe", args: ["-3"], source: "test" },
      runCommand: async (command, args, options) => {
        invocation = { command, args, options };
        await writeFile(reportPath, `${JSON.stringify({ pass: true, rows: [] })}\n`);
        return { stdout: "", stderr: "" };
      },
    },
  );
  assert.equal(result.report.pass, true);
  assert.equal(invocation.command, "py.exe");
  // Windows ランチャーの "-3" と UTF-8 モードの指定を、スクリプトの前に保つ。
  assert.deepEqual(invocation.args.slice(0, 4), ["-3", "-X", "utf8", join(scriptsDir, "detect-koya-manga-source-faces.py")]);
  assert.equal(invocation.options.cwd, projectDir);
});

// 生成者の記録（provenance）は、指定が無ければホストのセッション変数から取る。
// テストが Claude Code / Codex の中で走るとは限らない（CI には無い）ので明示する。
// 手元では Claude Code が入れた変数で埋まり、CI でだけ落ちていた。
const PLAN_TEST_GENERATOR = Object.freeze({ generatorHost: "codex", generatorContextId: "plan-test-generator-context" });
const script = `# 契約テスト\n\n## CUT 1: 教室\nナレーション: 放課後の教室だった。\n悠斗: 絶対に諦めない！\n\n## CUT 2: 廊下\n美咲: 本当に大丈夫？\n悠斗: ありがとう。\n`;

test("character-bible readings become deterministic STT pronunciation aliases", () => {
  assert.deepEqual(koyaSpeechPronunciationsFromCharacterBible({
    pronunciations: [
      { from: "複合人物名", to: "ふくごう じんぶつめい" },
      { from: "屋号", to: "やごう" },
    ],
    cast: [
      { name: "荒野", pronunciation: "あらの", pronunciationMap: { 荒野: "あらの" } },
      {
        name: "上沢天音",
        pronunciation: "かんざわあまね",
        pronunciationMap: { 上沢: "かんざわ", 天音: "あまね" },
      },
    ],
  }), [
    { from: "複合人物名", to: "ふくごう じんぶつめい" },
    { from: "上沢天音", to: "かんざわあまね" },
    { from: "屋号", to: "やごう" },
    { from: "荒野", to: "あらの" },
    { from: "上沢", to: "かんざわ" },
    { from: "天音", to: "あまね" },
  ]);
});

test("character-bible speech directions can explicitly remove an over-strong provider tag", () => {
  const manifest = {
    utterances: [
      { id: "cut-04-u01", text: "確認などいらん！", performancePrompt: "[angry]" },
      { id: "cut-04-u02", text: "記録を確認します。" },
    ],
  };
  const directed = applyKoyaCharacterBibleSpeechDirectives(manifest, {
    cast: [],
    speechDirections: [{ utteranceId: "cut-04-u01", performancePrompt: "" }],
  });
  assert.equal(directed.utterances[0].performancePrompt, "");
  assert.equal(directed.utterances[1].performancePrompt, undefined);
  assert.equal(manifest.utterances[0].performancePrompt, "[angry]", "input manifest stays immutable");
  assert.throws(
    () => applyKoyaCharacterBibleSpeechDirectives(manifest, {
      cast: [],
      speechDirections: [{ utteranceId: "missing", performancePrompt: "" }],
    }),
    /Unknown character-bible speech direction/u,
  );
});

test("Koya styling rounds must follow every show-bible spec in order with immutable spec bytes", async (t) => {
  if (!requireChannelPack(t, "styling round の順序検証")) return;
  const authority = await readKoyaChannelAuthority({ projectDir: process.cwd() });
  const member = authority.showBible.cast.find((entry) => entry.id === "horo");
  const expected = member.stylingSpecPaths.map((relativePath) => join(authority.root, relativePath));
  await assert.rejects(
    () => assertKoyaStylingSequence(authority, member, { stylingVariationRounds: [] }, expected[1]),
    /next declared styling spec in order/u,
  );
  const selectedRounds = [];
  for (const [index, specPath] of expected.entries()) {
    selectedRounds.push({
      id: `round-${index + 1}`,
      status: "selected",
      specPath,
      specSha256: createHash("sha256").update(await readFile(specPath)).digest("hex"),
      specCharacterId: "horo",
    });
  }
  const complete = await assertKoyaStylingSequence(authority, member, { stylingVariationRounds: selectedRounds });
  assert.equal(complete.complete, true);
  assert.equal(complete.selectedRounds.length, expected.length);
});

test("wide Koya source views use a semantic pull-out instead of a fake direction", () => {
  for (let index = 0; index < 6; index += 1) {
    assert.equal(koyaCameraModeForShot("wide", index), "pullout-only");
  }
  assert.equal(koyaCameraModeForShot("left", 0), "left-only");
  assert.equal(koyaCameraModeForShot("right", 1), "right-then-pullout");
  assert.equal(koyaCameraModeForShot("top", 2), "pullout-only");
});

test("production fills missing camera families with a semantic wide scan before a split page", () => {
  const emitted = new Set(["pullout"]);
  const establishing = {
    sequenceIndex: 2,
    visibleAction: "人物から右側の記録棚まで空間関係を見せる",
    setup: { depth: "three-plane" },
  };
  const wideMode = koyaCameraModeForMissingFamily("wide", emitted, 1, establishing);
  assert.equal(wideMode, "right-then-pullout");
  emitted.add("combined");
  assert.equal(koyaCameraModeForMissingFamily("top", emitted, 2, {}), "top-only");
  assert.equal(koyaCameraModeForMissingFamily("wide", new Set(), 0, {}), "pullout-only");
});

test("pacing groups narration with a concrete dialogue page without assigning dialogue to a narration-only image", () => {
  const utterances = new Map([
    ["u1", { id: "u1", speakerId: "narration" }],
    ["u2", { id: "u2", speakerId: "hero" }],
    ["u3", { id: "u3", speakerId: "narration" }],
    ["u4", { id: "u4", speakerId: "hero" }],
  ]);
  const pages = [
    { cutId: "c1", utteranceId: "u1", outputPath: "/narration.png" },
    { cutId: "c1", utteranceId: "u2", outputPath: "/dialogue.png" },
    { cutId: "c1", utteranceId: "u3", outputPath: "/bridge.png" },
    { cutId: "c1", utteranceId: "u4", outputPath: "/reply.png" },
  ];
  const groups = groupPagesForPacing(pages, utterances);
  assert.deepEqual(groups.map((group) => group.utteranceIds), [["u1", "u2"], ["u3", "u4"]]);
  assert.equal(groups[0].representativePage.outputPath, "/dialogue.png");
  assert.equal(groups[0].speakerId, "hero");
  assert.equal(groups[1].representativePage.outputPath, "/reply.png");
});

test("episode pacing can hold a dialogue pair on the chosen evidence frame while preserving dedicated action inserts", () => {
  const utterances = new Map([
    ["u1", { id: "u1", speakerId: "accuser" }],
    ["u2", { id: "u2", speakerId: "hero" }],
    ["u3", { id: "u3", speakerId: "narration", text: "猫が偽パスを床へ落とした。" }],
    ["u4", { id: "u4", speakerId: "accuser" }],
  ]);
  const groups = groupPagesForPacing([
    { cutId: "c1", utteranceId: "u1", outputPath: "/attack.png", pacing: { holdGroup: "proof-pair" } },
    { cutId: "c1", utteranceId: "u2", outputPath: "/proof.png", pacing: { holdGroup: "proof-pair", preferAsRepresentative: true } },
    { cutId: "c2", utteranceId: "u3", outputPath: "/cat-action.png", pacing: { dedicatedVisual: true } },
    { cutId: "c2", utteranceId: "u4", outputPath: "/excuse.png" },
  ], utterances);
  assert.deepEqual(groups.map((group) => group.utteranceIds), [["u1", "u2"], ["u3"], ["u4"]]);
  assert.equal(groups[0].representativePage.outputPath, "/proof.png");
  assert.equal(groups[0].speakerId, "hero");
  assert.equal(groups[1].representativePage.outputPath, "/cat-action.png");
});

test("successive narration facts retain their own purpose-built semantic images", () => {
  const utterances = new Map([
    ["u1", { id: "u1", speakerId: "narration", text: "二人は結婚した。" }],
    ["u2", { id: "u2", speakerId: "narration", text: "子供も二人授かった。" }],
  ]);
  const groups = groupPagesForPacing([
    { cutId: "c1", utteranceId: "u1", outputPath: "/marriage.png" },
    { cutId: "c1", utteranceId: "u2", outputPath: "/children.png" },
  ], utterances);
  assert.deepEqual(groups.map((group) => group.utteranceIds), [["u1"], ["u2"]]);
  assert.deepEqual(groups.map((group) => group.representativePage.outputPath), ["/marriage.png", "/children.png"]);
});

test("successive explanatory narration may still share a stable semantic image", () => {
  const utterances = new Map([
    ["u1", { id: "u1", speakerId: "narration", text: "俺は毎日努力を続けた。" }],
    ["u2", { id: "u2", speakerId: "narration", text: "少しずつ自信もついてきた。" }],
  ]);
  const groups = groupPagesForPacing([
    { cutId: "c1", utteranceId: "u1", outputPath: "/study.png" },
    { cutId: "c1", utteranceId: "u2", outputPath: "/confidence.png" },
  ], utterances);
  assert.deepEqual(groups.map((group) => group.utteranceIds), [["u1", "u2"]]);
  assert.equal(groups[0].representativePage.outputPath, "/study.png");
});

test("purpose-reflection narration keeps its approved dedicated visual after dialogue", () => {
  const utterances = new Map([
    ["u1", { id: "u1", speakerId: "heroine", text: "あなたには失望したわ。" }],
    ["u2", { id: "u2", speakerId: "narration", text: "俺は自分の志望校を選んだ理由を思い返した。" }],
    ["u3", { id: "u3", speakerId: "hero", text: "そんなふうに思っていたなんて。" }],
  ]);
  const composition = new Map([
    ["u2", { utteranceId: "u2", intent: "purpose-reflection" }],
  ]);
  const groups = groupPagesForPacing([
    { cutId: "c1", utteranceId: "u1", outputPath: "/dialogue-closeup.png" },
    { cutId: "c1", utteranceId: "u2", outputPath: "/reflection-headphones.png" },
    { cutId: "c1", utteranceId: "u3", outputPath: "/reaction.png" },
  ], utterances, composition);
  assert.deepEqual(groups.map((group) => group.utteranceIds), [["u1"], ["u2"], ["u3"]]);
  assert.deepEqual(groups.map((group) => group.representativePage.outputPath), [
    "/dialogue-closeup.png",
    "/reflection-headphones.png",
    "/reaction.png",
  ]);
});

test("camera-only replanning reuses approved audio only for an exact bound input", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "koya-audio-reuse-"));
  const audioPath = join(projectDir, "approved.wav");
  await writeFile(audioPath, "approved-pcm-placeholder");
  const voiceSettings = { stability: 0.6, similarityBoost: 0.82, speed: 1, useSpeakerBoost: true };
  const previous = {
    utterances: [{
      id: "u1",
      cutId: "c1",
      speakerId: "speaker-1",
      text: "同じ表示本文。",
      speechText: "同じ音声本文。",
      voiceId: "voice-1",
      model: "eleven_v3",
      voiceSettings,
      audio: { filePath: audioPath, durationSeconds: 1.25 },
    }],
  };
  const exact = { utterances: [{ ...previous.utterances[0], audio: undefined }] };
  assert.deepEqual(await reuseKoyaApprovedAudio(exact, previous), ["u1"]);
  assert.equal(exact.utterances[0].audio.filePath, audioPath);

  const changedVoice = {
    utterances: [{ ...previous.utterances[0], voiceId: "voice-2", audio: undefined }],
  };
  assert.deepEqual(await reuseKoyaApprovedAudio(changedVoice, previous), []);
  assert.equal(changedVoice.utterances[0].audio, undefined);
});

test("legacy replanning recovers approved audio only from an exact bound alignment", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "koya-alignment-recovery-"));
  const audioDir = join(projectDir, "assets/audio");
  const alignmentDir = join(projectDir, "audio-alignments");
  await Promise.all([
    mkdir(audioDir, { recursive: true }),
    mkdir(alignmentDir, { recursive: true }),
  ]);
  const fileName = "episode-1-u1-koya-v44.wav";
  const filePath = join(audioDir, fileName);
  const alignmentPath = join(alignmentDir, `${fileName}.json`);
  await writeFile(filePath, "approved-pcm-placeholder");
  await writeFile(alignmentPath, JSON.stringify({
    pipeline: "koya-dialogue-v44",
    utteranceId: "u1",
    displayText: "表示本文",
    speechText: "音声本文",
    voiceId: "voice-1",
    model: "eleven_v3",
    fileName,
    filePath,
    alignmentPath,
  }));
  const manifest = {
    id: "episode-1",
    utterances: [{
      id: "u1",
      text: "表示本文",
      speechText: "音声本文",
      voiceId: "voice-1",
      model: "eleven_v3",
    }],
  };
  assert.deepEqual(await recoverKoyaApprovedAudioFromAlignments(manifest, projectDir), ["u1"]);
  assert.equal(manifest.utterances[0].audio.filePath, filePath);

  const mismatched = structuredClone(manifest);
  delete mismatched.utterances[0].audio;
  mismatched.utterances[0].speechText = "変更された音声本文";
  assert.deepEqual(await recoverKoyaApprovedAudioFromAlignments(mismatched, projectDir), []);
});

test("Koya production planning writes a contract snapshot and resumable state without paid calls", async (t) => {
  if (!channelPackPresent(root)) {
    t.skip("channel pack が無い環境");
    return;
  }
  const projectDir = await mkdtemp(join(tmpdir(), "koya-plan-"));
  await mkdir(join(projectDir, "config"), { recursive: true });
  await writeFile(join(projectDir, "script.txt"), script);
  await writeFile(join(projectDir, "config/koya-manga-quality-incidents.json"), JSON.stringify({
    version: 3,
    incidents: [{
      signature: "seed-hard-gate",
      rule: "seed-rule",
      failure: "seed failure",
      promotion: "hard-gate",
      occurrences: 2,
    }],
  }));
  await writeFile(join(projectDir, "character-bible.json"), JSON.stringify({
    version: "koya-character-bible-v1",
    episodeId: "koya-plan-test",
    cast: [{ name: "悠斗", description: "高校生から社会人まで同じ顔を保つ主人公。" }],
  }));
  const result = await planKoyaMangaProduction({
    // このプロジェクトには Channel Pack が無く、ランタイム側のものを借りている。
    // 本番はこれを拒む（別チャンネルの番組ルールで走ることになるため）。
    // ここはジャンル共通ハーネスの経路——プラン生成の仕組みと再開状態を見る
    // のが目的で、番組ルールは対象外——なので明示的に許す。
    allowBorrowedChannelData: true,
    ...PLAN_TEST_GENERATOR,
    projectDir,
    scriptPath: join(projectDir, "script.txt"),
    episodeId: "koya-plan-test",
    protagonistSpeakerId: "悠斗",
    characterBiblePath: join(projectDir, "character-bible.json"),
    contractPath: join(process.cwd(), "config/koya-manga-production-contract.json"),
  });
  assert.equal(result.episodeId, "koya-plan-test");
  assert.equal(result.state.status, "planned");
  assert.ok(result.plan.jobs.length > 0);
  const snapshot = JSON.parse(await readFile(result.paths.contractSnapshotPath, "utf8"));
  assert.equal(snapshot.contract.version, "koya-manga-production-v53");
  const state = JSON.parse(await readFile(result.paths.statePath, "utf8"));
  assert.equal(state.currentStage, "images");
  assert.equal(state.protagonistSpeakerId, result.plan.production.protagonistSpeakerId);
  assert.equal(result.plan.production.protagonistSpeakerName, "悠斗");
  assert.equal(result.plan.production.characterBibleVersion, "koya-character-bible-v1");
  assert.equal(state.characterBiblePath, join(projectDir, "character-bible.json"));
  assert.deepEqual(state.knownRemainingIssues, []);
  assert.ok(state.generatorProvenance.contextId);
  assert.deepEqual(result.plan.production.channelDirectives.knownIncidents, ["hard-gate:seed-rule:seed failure"]);
  assert.equal(result.plan.production.incidentLedger.promotedIncidentCount, 1);
});

test("Koya planning refuses to overwrite an episode id owned by another script", async (t) => {
  if (!channelPackPresent(root)) {
    t.skip("channel pack が無い環境");
    return;
  }
  const projectDir = await mkdtemp(join(tmpdir(), "koya-plan-collision-"));
  const scriptPath = join(projectDir, "script.txt");
  const options = {
    // このプロジェクトには Channel Pack が無く、ランタイム側のものを借りている。
    // 本番はこれを拒む（別チャンネルの番組ルールで走ることになるため）。
    // ここはジャンル共通ハーネスの経路——プラン生成の仕組みと再開状態を見る
    // のが目的で、番組ルールは対象外——なので明示的に許す。
    allowBorrowedChannelData: true,
    ...PLAN_TEST_GENERATOR,
    projectDir,
    scriptPath,
    episodeId: "koya-collision-test",
    protagonistSpeakerId: "悠斗",
    contractPath: join(process.cwd(), "config/koya-manga-production-contract.json"),
  };
  await writeFile(scriptPath, script);
  await planKoyaMangaProduction(options);
  await writeFile(scriptPath, `${script}\n悠斗: 別の台本です。\n`);
  await assert.rejects(() => planKoyaMangaProduction(options), /different script/u);
});

test("Koya planning stops before paid generation when a narrated multi-character story has no protagonist", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "koya-plan-protagonist-"));
  const scriptPath = join(projectDir, "script.txt");
  await writeFile(scriptPath, script);
  await assert.rejects(() => planKoyaMangaProduction({
    // このプロジェクトには Channel Pack が無く、ランタイム側のものを借りている。
    // 本番はこれを拒む（別チャンネルの番組ルールで走ることになるため）。
    // ここはジャンル共通ハーネスの経路——プラン生成の仕組みと再開状態を見る
    // のが目的で、番組ルールは対象外——なので明示的に許す。
    allowBorrowedChannelData: true,
    ...PLAN_TEST_GENERATOR,
    projectDir,
    scriptPath,
    episodeId: "koya-protagonist-required",
    contractPath: join(process.cwd(), "config/koya-manga-production-contract.json"),
  }), /protagonist is ambiguous/u);
});

function patternedPng(seedNumber, width = 400, height = 300) {
  const seed = createHash("sha256").update(`pattern-${seedNumber}`).digest();
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (bytes) => {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data = Buffer.alloc(0)) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 3;
      raw[offset] = (seed[0] + x * (seed[3] % 11 + 1) + y * 3) % 256;
      raw[offset + 1] = (seed[1] + y * (seed[4] % 13 + 1) + x * 2) % 256;
      raw[offset + 2] = (seed[2] + (x + y) * (seed[5] % 17 + 1)) % 256;
    }
  }
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND")]);
}

async function passAnonymousCandidateReview(pathname) {
  const review = JSON.parse(await readFile(pathname, "utf8"));
  review.generatorContextId = "candidate-generator-session";
  review.reviewer = { host: "codex", id: "candidate-reviewer", contextId: "candidate-review-session", reviewedAt: new Date().toISOString() };
  review.originalScaleInspected = true;
  for (const candidate of review.candidates) {
    candidate.faceRegionReviewed = true;
    candidate.manualFaceRegion = [0, 0, candidate.width, candidate.height];
  }
  for (const pair of review.pairChecks) {
    Object.assign(pair.visualAxes, { faceShapeDistinct: true, hairSilhouetteDistinct: true });
    Object.assign(pair, { pass: true, note: "原寸で顔型と髪シルエットの差を確認" });
  }
  Object.assign(review, { pass: true, notes: "候補は別設計として識別できる" });
  await writeFile(pathname, `${JSON.stringify(review, null, 2)}\n`);
}

test("character-approve with a full-role import map stages every declared eye-open variant", async () => {
  // The project authority must be the one written below, never a pack the
  // developer machine exposes through the environment.
  const savedPack = process.env.BUZZASSIST_CHANNEL_PACK;
  delete process.env.BUZZASSIST_CHANNEL_PACK;
  const projectDir = await mkdtemp(join(tmpdir(), "koya-eye-open-approve-"));
  try {
    const canvasDir = join(projectDir, "canvas");
    await cp(fileURLToPath(new URL("./fixtures/channel-pack/config", import.meta.url)), join(projectDir, "config"), { recursive: true });
    const showPath = join(projectDir, "config/koya-show-bible.json");
    const showBible = JSON.parse(await readFile(showPath, "utf8"));
    // Pick the member by rule so no cast name enters the public test.
    const member = showBible.cast.find((entry) => entry.requiredEveryEpisode !== true && entry.requiredReferenceRoles?.includes("eye-open"));
    assert.ok(member, "fixture needs an occasional member with a required eye-open sheet");
    delete member.stylingSpecPath;
    delete member.stylingSpecPaths;
    const memberName = member.hiddenName || member.name;
    const authorityPath = join(canvasDir, "approved/open-angry-front.png");
    await mkdir(join(canvasDir, "approved"), { recursive: true });
    await writeFile(authorityPath, patternedPng(90, 128, 128));
    const authoritySha256 = createHash("sha256").update(await readFile(authorityPath)).digest("hex");
    member.eyeOpenVariants = [
      { id: "open-calm", label: "穏やか", description: "gently open eyes with soft lines", cues: ["ありがとう"] },
      {
        id: "open-angry",
        label: "怒り",
        description: "wide open eyes with a hard glare",
        cues: ["逃げ"],
        referenceAssets: [{ path: "canvas/approved/open-angry-front.png", sha256: authoritySha256 }],
      },
    ];
    await writeFile(showPath, `${JSON.stringify(showBible, null, 2)}\n`);

    const episodeId = "manga-eye-open-approve";
    const workflow = await prepareCharacterWorkflow({
      projectDir,
      scriptText: `${memberName}：見本33の試。`,
      episodeId,
      candidateCount: 3,
      cast: [{ id: member.id, name: memberName, role: "fixed", description: "普段は糸目の老人。", invariants: ["白髪"] }],
    });
    const candidateJobs = await buildCharacterCandidateJobs(workflow);
    await markCharacterCandidatesGenerating({ projectDir }, workflow.id, candidateJobs);
    const candidateResults = [];
    for (const [index] of candidateJobs.entries()) {
      const assetFile = join(canvasDir, "assets", `candidate-${index + 1}.png`);
      await mkdir(join(canvasDir, "assets"), { recursive: true });
      await writeFile(assetFile, patternedPng(index + 1, 96, 72));
      candidateResults.push({ elementId: `candidate-${index + 1}`, assetFile });
    }
    const awaiting = await recordCharacterCandidateResults({ projectDir, generatorContextId: "candidate-generator-session" }, workflow.id, candidateJobs, candidateResults);
    const reviewCast = awaiting.cast[0];
    await passAnonymousCandidateReview(reviewCast.candidateReviewDraftPath);
    const selected = reviewCast.candidates[1];
    assert.ok(selected.blindLabel && selected.blindPublicPacketPath, "the official candidate route writes the anonymous packet");
    const candidateSha256 = createHash("sha256").update(await readFile(selected.assetFile)).digest("hex");
    const generator = { host: "claude", id: "identity-import-tool", contextId: "identity-import-session" };
    const importMapPath = join(canvasDir, "identity-import/eye-open-variants.json");
    await mkdir(join(canvasDir, "identity-import"), { recursive: true });
    const writeImportMap = (entries) => writeFile(importMapPath, `${JSON.stringify({
      version: "koya-identity-generation-import-v1",
      workflowId: workflow.id,
      castId: reviewCast.id,
      candidateSha256,
      generator,
      generationScopeId: `approval:${generator.contextId}`,
      entries,
    }, null, 2)}\n`);
    const approve = () => approveKoyaCharacterCandidate({
      projectDir,
      episodeId,
      workflowId: workflow.id,
      castId: reviewCast.id,
      candidateLabel: selected.blindLabel,
      approvalReason: "承認済み候補ラベルのまま開眼差分を追加する",
      approvedBy: "test-human",
      candidateReviewPath: reviewCast.candidateReviewDraftPath,
      generatorHost: generator.host,
      generatorId: generator.id,
      generatorContextId: generator.contextId,
      identityGenerationImportMapPath: importMapPath,
    });

    // An incomplete map stops before any image call, after the show-bible
    // declaration has been copied onto the workflow cast.
    await writeImportMap([]);
    await assert.rejects(approve, /map every official job exactly once/u);
    const store = await readCharacterWorkflowStore({ projectDir });
    const storedWorkflow = getCharacterWorkflow(store, workflow.id);
    const storedCast = storedWorkflow.cast[0];
    assert.deepEqual(storedCast.eyeOpenVariants.map((variant) => variant.id), ["open-calm", "open-angry"]);
    assert.deepEqual(storedCast.eyeOpenVariants[1].referenceAssets, [{ path: authorityPath, sha256: authoritySha256 }]);

    const identityCandidate = effectiveCharacterIdentityCandidate(storedCast, findWorkflowCandidate(storedCast, selected.id));
    const jobs = buildApprovedIdentityPackJobs(storedWorkflow, storedCast, identityCandidate, { fileNameSuffix: generator.contextId });
    const keys = jobs.map((job) => `${job.pipeline.identityRole}:${job.pipeline.storyStage || ""}`);
    assert.deepEqual(keys, ["turnaround:", "expression:", "eye-open:open-calm", "eye-open:open-angry"]);
    const entries = [];
    for (const [index, job] of jobs.entries()) {
      const sourceFile = join(canvasDir, "identity-import", `source-${index + 1}.png`);
      await writeFile(sourceFile, patternedPng(40 + index, 400, index === 0 ? 200 : 300));
      const { inputSha256 } = await buildKoyaIdentityPackJobInput({ workflowId: workflow.id, castId: reviewCast.id, candidateSha256, generator, job });
      entries.push({
        key: keys[index],
        sourceFile,
        sourceSha256: createHash("sha256").update(await readFile(sourceFile)).digest("hex"),
        inputSha256,
      });
    }
    await writeImportMap(entries);

    await writeFile(authorityPath, patternedPng(91, 128, 128));
    await assert.rejects(approve, /eye-open authority open-angry path\/SHA-256 changed/u);
    await writeFile(authorityPath, patternedPng(90, 128, 128));

    const approved = await approve();
    const pack = approved.staged.cast.identityPack;
    assert.equal(approved.staged.cast.status, "awaiting-identity-qa");
    assert.deepEqual(pack.eyeOpenSheets.map((sheet) => sheet.storyStage), ["open-calm", "open-angry"]);
    assert.deepEqual(
      pack.eyeOpenSheets.map((sheet) => sheet.sha256),
      [entries[2].sourceSha256, entries[3].sourceSha256],
      "each variant stages exactly the imported bytes for its key",
    );
    const draft = JSON.parse(await readFile(approved.staged.identityReviewDraftPath, "utf8"));
    assert.deepEqual(draft.extraSheets.map((sheet) => sheet.storyStage), ["open-calm", "open-angry"]);
  } finally {
    if (savedPack === undefined) delete process.env.BUZZASSIST_CHANNEL_PACK;
    else process.env.BUZZASSIST_CHANNEL_PACK = savedPack;
    await rm(projectDir, { recursive: true, force: true });
  }
});


test("画像で止まったときの案内は、次に打つ resume コマンドの全文と、失敗分だけ作り直す引数を出す", () => {
  // 今までは短い一行しか出ず、深夜に1人では次の一手が打てなかった。
  const failed = koyaImagePauseGuidance({
    failed: true,
    imageSummary: { failed: 2, complete: 10 },
    state: { imageLedgerPath: "/p/canvas/assets/ep/image-generation-ledger.json" },
  }, { jobId: "video-koya-manga-video-0123456789abcdef", jobProjectDir: "/Users/x/My Project" });
  assert.match(failed[0], /2 image job\(s\) failed/u);
  assert.match(failed[0], /completed images \(10\) are reused/u);
  assert.equal(
    failed[2].trim(),
    "node scripts/run-video-harness.mjs resume --job-id video-koya-manga-video-0123456789abcdef --project-dir '/Users/x/My Project' --confirmed --retry-failed-images",
    "空白を含む path は引用し、失敗分だけ作り直す引数を最後に付ける",
  );
  assert.match(failed[3], /image-generation-ledger\.json/u);

  const waiting = koyaImagePauseGuidance({ waiting: true, imageSummary: {} }, { jobId: "video-koya-manga-video-0123456789abcdef", jobProjectDir: "/p" });
  assert.match(waiting[0], /waiting for a human decision/u);
  assert.equal(waiting[1].includes("--retry-failed-images"), false, "人待ちのときは作り直しの引数を付けない");

  assert.deepEqual(koyaImagePauseGuidance({}, {}), [], "止まっていなければ何も出さない");
  const anonymous = koyaImagePauseGuidance({ failed: true, imageSummary: {} }, {});
  assert.match(anonymous[2], /--job-id <job id> --project-dir <project that holds the Job>/u, "Job の情報が無ければ穴埋めで示す");
});


test("フルラン錠が取れないときは failed でなく人待ち（exit 3）で止め、次に打つ resume を案内する", async () => {
  // 錠は待ち時間ゼロで、2分以上古く持ち主が死んでいるときしか外れない。親だけ落ちて子が
  // 生きている状態で resume すると即 throw → 外側の Job が failed になり、払い終えた画像の
  // 行が Job に残らない（Koya の throw 経路は Media Job の行を返さない）。
  const lockError = new Error("Timed out waiting for canvas write lock: /p/canvas/manga-videos/.full-run-locks/abc");
  const paused = await runKoyaMangaFullProduction(
    { episodeId: "ep-lock", projectDir: "/p", upstreamJobId: "video-koya-manga-video-0123456789abcdef", upstreamJobPath: "/Users/x/proj/canvas/harness-runs/video-koya-manga-video-0123456789abcdef/job.json" },
    { withFullRunLock: async () => { throw lockError; } },
  );
  assert.equal(paused.exitCode, 3);
  assert.equal(paused.payload.status, KOYA_FULL_RUN_LOCK_HELD_STATUS);
  assert.equal(paused.payload.waiting, true);
  assert.equal(paused.payload.knownRemainingIssues[0].id, "full-run-lock");
  // 錠のパスは OS の区切りで作られる（Windows は \）。区切りを決め打ちしない。
  assert.match(paused.payload.lockPath, /\.full-run-locks[\\/]/u);
  // Job の project dir は job.json の場所から resolve で導く。Windows では
  // ドライブ文字と \ が付くので、期待値も同じ関数で作る。
  const expectedJobProjectDir = resolve(dirname(resolve("/Users/x/proj/canvas/harness-runs/video-koya-manga-video-0123456789abcdef/job.json")), "..", "..", "..");
  // 案内はシェル用に引用符を付けることがある（Windows のドライブ文字と \ など）。
  // 引用符を外して、path の中身だけを比べる。
  assert.equal(
    paused.payload.next.at(-1).trim().replace(/['"]/gu, ""),
    `node scripts/run-video-harness.mjs resume --job-id video-koya-manga-video-0123456789abcdef --project-dir ${expectedJobProjectDir} --confirmed`,
    "job.json の場所から Job の project dir を導いて、次に打つコマンドを全文で出す",
  );

  // 錠以外の失敗は今までどおり投げる（黙って人待ちにしない）。
  await assert.rejects(
    () => runKoyaMangaFullProduction({ episodeId: "ep-lock", projectDir: "/p" }, { withFullRunLock: async () => { throw new Error("disk full"); } }),
    /disk full/u,
  );
  assert.equal(koyaFullRunLockPauseResult(new Error("other"), { lockTarget: "/l", episodeId: "e" }), null);
});
