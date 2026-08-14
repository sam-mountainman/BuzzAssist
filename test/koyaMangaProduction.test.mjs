import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  dialogueShotRequiresAnchoredPullout,
  groupPagesForPacing,
  koyaCameraModeForShot,
  koyaCameraModeForMissingFamily,
  koyaSpeechPronunciationsFromCharacterBible,
  planKoyaMangaProduction,
  recommendedKoyaRenderConcurrency,
  recoverKoyaApprovedAudioFromAlignments,
  reuseKoyaApprovedAudio,
  runSourceFacePlacement,
  sourceAvoidRegionsInOverlaySpace,
} from "../lib/koyaMangaProduction.mjs";

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

const script = `# 契約テスト\n\n## CUT 1: 教室\nナレーション: 放課後の教室だった。\n悠斗: 絶対に諦めない！\n\n## CUT 2: 廊下\n美咲: 本当に大丈夫？\n悠斗: ありがとう。\n`;

test("character-bible readings become deterministic STT pronunciation aliases", () => {
  assert.deepEqual(koyaSpeechPronunciationsFromCharacterBible({
    cast: [
      { name: "荒野", pronunciation: "あらの", pronunciationMap: { 荒野: "あらの" } },
      {
        name: "上沢天音",
        pronunciation: "かんざわあまね",
        pronunciationMap: { 上沢: "かんざわ", 天音: "あまね" },
      },
    ],
  }), [
    { from: "上沢天音", to: "かんざわあまね" },
    { from: "荒野", to: "あらの" },
    { from: "上沢", to: "かんざわ" },
    { from: "天音", to: "あまね" },
  ]);
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

test("Koya production planning writes a contract snapshot and resumable state without paid calls", async () => {
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
  assert.equal(snapshot.contract.version, "koya-manga-production-v50");
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

test("Koya planning refuses to overwrite an episode id owned by another script", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "koya-plan-collision-"));
  const scriptPath = join(projectDir, "script.txt");
  const options = {
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
    projectDir,
    scriptPath,
    episodeId: "koya-protagonist-required",
    contractPath: join(process.cwd(), "config/koya-manga-production-contract.json"),
  }), /protagonist is ambiguous/u);
});
