// 漫画の画と台詞の音声を重ねる（runKoyaOverlappedSpeech と、speech の collector の取り込み）の試験。
// 有料の cut は偽の runner が受ける。人名・台本・声は合成。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, rm } from "node:fs/promises";
import test from "node:test";

import { generateKoyaDialogueSpeech } from "../lib/koyaDialogueSpeech.mjs";
import {
  buildKoyaDialogueDefinition,
  createKoyaEpisodeManifest,
  koyaSpeechOverlapPaths,
  runKoyaMangaFullProduction,
  runKoyaOverlappedSpeech,
} from "../lib/koyaMangaProduction.mjs";
import { resolveKoyaDialogueAdapter, resolveKoyaMangaProductionContract } from "../lib/koyaMangaProductionContract.mjs";
import {
  EPISODE_ID,
  OUTER_JOB_BINDING,
  PROTAGONIST,
  fakeCutRunner,
  fixtureApprovedCheckpoint,
  humanSelectedRegistry,
  overlapPreflight,
  writeOverlapProject,
} from "./helpers/koyaSpeechOverlapFixture.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const OVERLAY_FIELDS = new Set(["overlayPath", "overlaySpecPath", "bubbleSegments"]);

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function prepare(project) {
  return createKoyaEpisodeManifest({
    projectDir: project.projectDir,
    episodeId: EPISODE_ID,
    protagonistSpeakerId: PROTAGONIST,
    outerJobBinding: OUTER_JOB_BINDING,
    pythonRuntime: project.pythonRuntime,
  });
}

/** 作業場ごとに違う根の path と、作った時刻（prepare の adoptedAt など）を揃えて比べる。 */
function comparable(value, root) {
  return JSON.parse(JSON.stringify(value).split(root).join("<root>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/gu, "<time>"));
}

async function audioDigests(manifest) {
  const rows = {};
  for (const utterance of manifest.utterances) rows[utterance.id] = sha256(await readFile(utterance.audio.filePath));
  return rows;
}

test("the dialogue definition built before any image matches the speech input of the manifest prepare builds from the images", async (t) => {
  const project = await writeOverlapProject(await humanSelectedRegistry(), "koya-overlap-parity");
  t.after(() => rm(project.projectDir, { recursive: true, force: true }));
  const resolved = await resolveKoyaMangaProductionContract({ projectDir: project.projectDir, episodeId: EPISODE_ID });
  const definition = await buildKoyaDialogueDefinition({
    projectDir: project.projectDir,
    episodeId: EPISODE_ID,
    scriptPath: project.scriptPath,
    plan: project.plan,
    resolved,
    protagonistSpeakerId: PROTAGONIST,
    outerJobBinding: OUTER_JOB_BINDING,
  });
  assert.equal(await exists(project.paths.manifestPath), false, "対話の定義は正本の manifest を書かない");
  assert.equal(await exists(project.paths.statePath), false, "対話の定義は状態ファイルを書かない");
  const prepared = await prepare(project);
  const withoutOverlay = prepared.manifest.utterances.map((utterance) => Object.fromEntries(
    Object.entries(utterance).filter(([key]) => !OVERLAY_FIELDS.has(key)),
  ));
  assert.deepEqual(definition.utterances, withoutOverlay, "発話の音声の欄（本文・読み・声・モデル）が画から作った manifest と同じ");
  assert.deepEqual(
    definition.cuts.map((cut) => ({ id: cut.id, utteranceIds: cut.utteranceIds })),
    prepared.manifest.cuts.map((cut) => ({ id: cut.id, utteranceIds: cut.utteranceIds })),
  );
  assert.deepEqual(definition.speech.pronunciations, prepared.manifest.speech.pronunciations);
});

async function runSerial(registry) {
  const project = await writeOverlapProject(registry, "koya-overlap-serial");
  const prepared = await prepare(project);
  const fake = fakeCutRunner();
  const result = await generateKoyaDialogueSpeech({
    projectDir: project.projectDir,
    canvasDir: project.canvasDir,
    manifestPath: project.paths.manifestPath,
    contract: prepared.resolved,
    takeCount: 2,
    voiceQualityGate: false,
    cutRunner: fake.runner,
    approvedCheckpointImpl: fixtureApprovedCheckpoint,
  });
  return { project, result, calls: fake.calls };
}

async function runOverlapped(registry, { failCutIds = new Set() } = {}) {
  const project = await writeOverlapProject(registry, "koya-overlap-ahead");
  const resolved = await resolveKoyaMangaProductionContract({ projectDir: project.projectDir, episodeId: EPISODE_ID });
  const early = fakeCutRunner({ failCutIds });
  // 画の前（正本の manifest がまだ無い）に音声を作る。
  const overlap = await runKoyaOverlappedSpeech({
    projectDir: project.projectDir,
    episodeId: EPISODE_ID,
    scriptPath: project.scriptPath,
    protagonistSpeakerId: PROTAGONIST,
    takeCount: 2,
    voiceQualityGate: false,
  }, {
    preflight: overlapPreflight(resolveKoyaDialogueAdapter(resolved)),
    plan: project.plan,
    runtime: {
      generateDialogueSpeech: (args) => generateKoyaDialogueSpeech({ ...args, cutRunner: early.runner, approvedCheckpointImpl: fixtureApprovedCheckpoint }),
    },
  });
  const sharedStateAfterOverlap = {
    manifest: await exists(project.paths.manifestPath),
    state: await exists(project.paths.statePath),
  };
  const prepared = await prepare(project);
  const late = fakeCutRunner();
  const result = await generateKoyaDialogueSpeech({
    projectDir: project.projectDir,
    canvasDir: project.canvasDir,
    manifestPath: project.paths.manifestPath,
    contract: prepared.resolved,
    takeCount: 2,
    voiceQualityGate: false,
    cutRunner: late.runner,
    approvedCheckpointImpl: fixtureApprovedCheckpoint,
    adoptFrom: { manifestPath: overlap.definitionPath, reportPath: overlap.reportPath },
  });
  return { project, overlap, result, earlyCalls: early.calls, lateCalls: late.calls, sharedStateAfterOverlap };
}

test("speech made alongside the images is adopted into the canonical manifest and equals the serial result", async (t) => {
  const registry = await humanSelectedRegistry();
  const serial = await runSerial(registry);
  const overlapped = await runOverlapped(registry);
  t.after(async () => {
    await rm(serial.project.projectDir, { recursive: true, force: true });
    await rm(overlapped.project.projectDir, { recursive: true, force: true });
  });
  assert.equal(overlapped.overlap.status, "complete", overlapped.overlap.reason);
  assert.deepEqual(overlapped.sharedStateAfterOverlap, { manifest: false, state: false }, "重ねた音声は正本の manifest と状態ファイルに触らない");
  assert.deepEqual(overlapped.earlyCalls, ["cut-01", "cut-02"]);
  assert.deepEqual(overlapped.lateCalls, [], "取り込んだ cut は作り直さない（有料の呼び出し0）");
  assert.deepEqual(overlapped.result.overlapAdoption.adoptedCutIds, ["cut-01", "cut-02"]);
  assert.deepEqual(serial.calls, ["cut-01", "cut-02"]);

  const serialManifest = comparable(serial.result.manifest, serial.project.projectDir);
  const overlapManifest = comparable(overlapped.result.manifest, overlapped.project.projectDir);
  assert.deepEqual(overlapManifest.utterances, serialManifest.utterances, "発話（音・読み・声）が直列と同じ");
  assert.deepEqual(overlapManifest.cuts, serialManifest.cuts);
  assert.deepEqual(await audioDigests(overlapped.result.manifest), await audioDigests(serial.result.manifest), "音の sha256 が直列と同じ");
  const rows = (report, root) => comparable(report.cuts, root);
  assert.deepEqual(rows(overlapped.result.report, overlapped.project.projectDir), rows(serial.result.report, serial.project.projectDir), "報告の cut の行が直列と同じ");
  assert.equal(overlapped.result.report.status, serial.result.report.status);
  assert.deepEqual(overlapped.result.report.completedCutIds, serial.result.report.completedCutIds);
});

test("a cut that failed while overlapped is left out of the canonical manifest and made again by the normal speech step", async (t) => {
  const registry = await humanSelectedRegistry();
  const serial = await runSerial(registry);
  const overlapped = await runOverlapped(registry, { failCutIds: new Set(["cut-02"]) });
  t.after(async () => {
    await rm(serial.project.projectDir, { recursive: true, force: true });
    await rm(overlapped.project.projectDir, { recursive: true, force: true });
  });
  assert.equal(overlapped.overlap.status, "failed");
  assert.match(overlapped.overlap.reason, /fixture provider failed cut-02/u);
  assert.deepEqual(overlapped.sharedStateAfterOverlap, { manifest: false, state: false }, "失敗しても正本には何も残さない");
  assert.deepEqual(overlapped.result.overlapAdoption.adoptedCutIds, ["cut-01"], "完成した cut だけを取り込む");
  assert.deepEqual(overlapped.lateCalls, ["cut-02"], "失敗した cut だけを通常の工程で作る");
  assert.deepEqual(
    comparable(overlapped.result.manifest, overlapped.project.projectDir).utterances,
    comparable(serial.result.manifest, serial.project.projectDir).utterances,
  );
  assert.deepEqual(await audioDigests(overlapped.result.manifest), await audioDigests(serial.result.manifest));
});

test("an overlap that cannot resolve every voice stops before any paid cut and leaves no state behind", async (t) => {
  const registry = await humanSelectedRegistry();
  registry.characters = registry.characters.map((character) => (character.id === "fixture-hanako" ? { ...character, voiceId: "" } : character));
  const project = await writeOverlapProject(registry, "koya-overlap-unvoiced");
  t.after(() => rm(project.projectDir, { recursive: true, force: true }));
  const resolved = await resolveKoyaMangaProductionContract({ projectDir: project.projectDir, episodeId: EPISODE_ID });
  const fake = fakeCutRunner();
  const overlap = await runKoyaOverlappedSpeech({
    projectDir: project.projectDir,
    episodeId: EPISODE_ID,
    scriptPath: project.scriptPath,
    protagonistSpeakerId: PROTAGONIST,
    voiceQualityGate: false,
  }, {
    preflight: overlapPreflight(resolveKoyaDialogueAdapter(resolved)),
    plan: project.plan,
    runtime: { generateDialogueSpeech: (args) => generateKoyaDialogueSpeech({ ...args, cutRunner: fake.runner }) },
  });
  assert.equal(overlap.status, "skipped");
  assert.deepEqual(fake.calls, []);
  assert.equal(await exists(project.paths.statePath), false, "止め方の記録は正本の prepare に任せる");
  assert.equal(await exists(koyaSpeechOverlapPaths(project.paths).definitionPath), false);
});

// ---------------------------------------------------------------------------
// full: 画と音声を同時に進め、両方が揃ってから prepare → speech → render

function measuredDoctorReport(projectDir) {
  const ids = ["harness-production-route", "node", "ffmpeg", "ffprobe", "ffmpeg-capability", "voice-quality-python", "tts-key", "image-key", "channel-pack"];
  const files = ["show.json", "locations.json", "thumbnail.json"].map((path, index) => ({
    role: ["show", "locations", "thumbnail"][index], path, sha256: String(index + 1).repeat(64), bytes: 2,
  }));
  const payload = { version: "koya-channel-authority-fingerprint-v1", fileCount: files.length, files };
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
      ...(id === "tts-key" ? { kind: "voice.dialogue", provider: "elevenlabs", model: "eleven_v3", adapterVersion: "elevenlabs-dialogue-server-v1", status: "ready" } : {}),
      ...(id === "image-key" ? { host: "codex", model: "gpt-image-2-codex" } : {}),
      ...(id === "channel-pack" ? { authorityFingerprint: { ...payload, sha256: sha256(JSON.stringify(payload)) } } : {}),
    })),
  };
}

const sleep = (ms) => new Promise((done) => { setTimeout(done, ms); });

async function fullRun(projectDir, { speechOverlap, imageMs = 120, speechMs = 100, imageOutcome = {} }) {
  const order = [];
  let adoption = null;
  const speechJob = { requestKey: "fixture:cut-01:take:1", status: "completed" };
  const startedAt = Date.now();
  const result = await runKoyaMangaFullProduction({
    projectDir,
    episodeId: EPISODE_ID,
    scriptPath: "/fixture/script.txt",
    ...(speechOverlap === false ? { speechOverlap: false } : {}),
  }, {
    allowDirectMeasuredDoctorForTests: true,
    runDoctor: async () => measuredDoctorReport(projectDir),
    generateImages: async (options, imageRuntime = {}) => {
      order.push("images:start");
      // 本物の画の工程と同じく、計画ができた所（有料の本編の画の前）で知らせる。
      imageRuntime.onScenePlanReady?.({ plan: { production: {} }, planPath: "/fixture/plan.json" });
      await sleep(imageMs);
      order.push("images:end");
      return { episodeId: options.episodeId, waiting: false, failed: false, imageSummary: { total: 2 }, ...imageOutcome };
    },
    runSpeechOverlap: async () => {
      const began = new Date().toISOString();
      order.push("overlap:start");
      await sleep(speechMs);
      order.push("overlap:end");
      return {
        version: "koya-speech-overlap-v1",
        status: "complete",
        startedAt: began,
        finishedAt: new Date().toISOString(),
        definitionPath: "/fixture/definition.json",
        reportPath: "/fixture/overlap-report.json",
        mediaJobStateDir: "/fixture/paid-media-jobs",
        mediaJobs: [speechJob],
        completedCutIds: ["cut-01"],
        pendingCutIds: [],
      };
    },
    prepareManifest: async () => { order.push("prepare"); return { waiting: false }; },
    generateSpeech: async (options) => {
      order.push("speech");
      adoption = options.adoptOverlappedSpeech || null;
      // 取り込みが無い（直列の）ときは、ここで音声を作るのと同じ時間がかかる。
      if (!adoption) await sleep(speechMs);
      return { waiting: false, partial: false, report: { mediaJobs: [speechJob] }, overlapAdoption: adoption ? { adoptedCutIds: ["cut-01"] } : undefined };
    },
    substituteVideos: async () => ({}),
    renderVideo: async () => { order.push("render"); return { outputPath: "/fixture/final.mp4", paths: { manifestPath: "/fixture/manifest.json" } }; },
    auditFinal: async () => ({ report: { pass: true, failedAuditIds: [], knownRemainingIssues: [] } }),
  });
  return { result, order, adoption, elapsedMs: Date.now() - startedAt };
}

test("full runs the images and the speech at the same time, renders only after both, and records each stage", async (t) => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const projectDir = await mkdtemp(join(tmpdir(), "koya-overlap-full-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  const serial = await fullRun(projectDir, { speechOverlap: false });
  const overlapped = await fullRun(projectDir, {});
  for (const run of [serial, overlapped]) {
    assert.equal(run.result.exitCode, 0);
    assert.equal(run.result.payload.status, "final-koya-audited");
    assert.deepEqual(run.result.payload.mediaJobs.map((row) => row.requestKey), ["fixture:cut-01:take:1"], "有料の記録は1件（二重に数えない）");
  }
  assert.equal(serial.adoption, null);
  assert.equal(serial.result.payload.speechOverlap, undefined);
  assert.deepEqual(serial.order, ["images:start", "images:end", "prepare", "speech", "render"]);
  assert.deepEqual(overlapped.adoption, { manifestPath: "/fixture/definition.json", reportPath: "/fixture/overlap-report.json" });
  assert.ok(overlapped.order.indexOf("overlap:start") < overlapped.order.indexOf("images:end"), "音声は画の途中で始まる");
  assert.ok(overlapped.order.indexOf("render") > overlapped.order.indexOf("overlap:end"), "描くのは両方が揃ってから");
  assert.ok(overlapped.order.indexOf("prepare") > overlapped.order.indexOf("images:end"));
  assert.equal(overlapped.result.payload.speechOverlap.status, "complete");
  assert.deepEqual(overlapped.result.payload.speechOverlap.adoptedCutIds, ["cut-01"]);
  const stages = overlapped.result.payload.stageTimings.stages;
  assert.deepEqual(stages.map((row) => row.id).sort(), ["audit", "images", "prepare", "render", "speech", "speech-overlap", "video-substitution"].sort());
  const images = stages.find((row) => row.id === "images");
  const speechOverlap = stages.find((row) => row.id === "speech-overlap");
  assert.ok(Date.parse(speechOverlap.startedAt) < Date.parse(images.finishedAt), "記録の上でも音声と画が重なっている");
  assert.equal(speechOverlap.overlapsWith, "images");
  assert.ok(overlapped.elapsedMs < serial.elapsedMs, `重ねた方が短い（serial=${serial.elapsedMs}ms overlapped=${overlapped.elapsedMs}ms）`);
});

test("when the images stop, full still waits for the overlapped speech and reports what it paid for", async (t) => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const projectDir = await mkdtemp(join(tmpdir(), "koya-overlap-image-pause-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  const run = await fullRun(projectDir, {
    imageMs: 20,
    speechMs: 80,
    imageOutcome: { failed: true, state: { status: "failed", knownRemainingIssues: [{ id: "image-generation" }] } },
  });
  assert.equal(run.result.exitCode, 3);
  assert.equal(run.result.payload.status, "failed");
  assert.deepEqual(run.order, ["images:start", "overlap:start", "images:end", "overlap:end"], "画が止まっても音声の決着を待ってから返る（prepare・render へ進まない）");
  assert.deepEqual(run.result.payload.mediaJobs.map((row) => row.requestKey), ["fixture:cut-01:take:1"], "払った音声の Media Job を Job へ返す");
  assert.equal(run.result.payload.mediaJobStateDir, "/fixture/paid-media-jobs");
});
