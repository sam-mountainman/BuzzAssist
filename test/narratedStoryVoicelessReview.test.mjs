#!/usr/bin/env node

// 声なしの感想パート（Channel Pack の bookends.review.voice: "none"）。感想の文は全部字幕だけで、声の Media Job を
// 1つも作らない。合成の Pack（挨拶は plain、中身は TV 枠と空の人物の枠）・台本パッケージ・画・声・曲で公式経路を
// 最後まで通し、境目・音量と明瞭さ・焼き込み字幕・感想の配置の監査が声の無い感想パートで正しく測ること、
// 壊した版（感想の区間に声が入った stem・BGM が途切れた MP4）を落とすこと、宣言と台本の食い違いを有料生成の前に
// 止めることを確かめる。有料 API もネットワークも使わない。

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { extractNarratedChannelPackRuntime } from "../lib/harnessChannelPackRuntime.mjs";
import { resolveFfmpegToolchain } from "../lib/harnessRuntimeResolver.mjs";
import {
  REVIEWER_TRUST_PATH_ENV,
  REVIEWER_TRUST_VERSION,
  createReviewerTrustEntry,
  generateReviewerKeyPair,
} from "../lib/koyaReviewAttestation.mjs";
import {
  measureNarratedBookendBoundaries,
  normalizeNarratedBookendsConfig,
  planNarratedBookendProgram,
  rehydrateBookendPlan,
} from "../lib/narratedStoryBookends.mjs";
import { inspectNarratedStoryPlan, planNarratedStoryScript } from "../lib/narratedStoryPipeline.mjs";
import {
  NARRATED_SCRIPT_PACKAGE_FORMAT,
  narratedVoicelessCaptionSeconds,
  planNarratedStoryInput,
} from "../lib/narratedStoryScriptPackage.mjs";
import { runNarratedStoryVideo } from "../lib/narratedStoryVideo.mjs";
import { checkNarratedVisualPlan } from "../lib/narratedStoryVisuals.mjs";
import { runPastAssetLoops } from "./fixtures/narratedAssetLoopFixture.mjs";
import {
  bookendFixtureAdapters,
  bookendFixtureChannelConfig,
  createBookendFixtureMedia,
  passingVoiceQualityGate,
  writeBookendPackAssets,
} from "./fixtures/narratedBookendFixture.mjs";
import { bandSubtitleConfig, ff, findJapaneseFontFile, writeSubtitlePackFont } from "./fixtures/narratedVisualFixture.mjs";
import { acceptScriptForTests } from "./helpers/scriptQualityAcceptance.mjs";

const toolchain = await resolveFfmpegToolchain();
const fontPath = await findJapaneseFontFile();
const MARKER = "---感想---";
const AUTOMATIC_EXEMPT = new Set(["perceptualReviewChecks", "perceptualReviewBoundToOutput", "perceptualEvidenceHashes", "contactSheetOriginalDetailReviewed", "qualityLoopPassed", "characterIdentityReviewed"]);

// 合成の配置（どのチャンネルの値でもない）。人物の映像は渡さない（人物の枠は空のまま）。
const LAYOUT = {
  default: "tv-left-presenter-right",
  backgroundColor: "#203040",
  tv: { x: 0.04, y: 0.08, width: 0.56, height: 0.5, borderColor: "#000000", borderRatio: 0.01 },
  presenterFrame: { x: 0.66, y: 0.08, width: 0.3, height: 0.5, borderColor: "#ffffff", borderRatio: 0.01, emptyColor: "#606060" },
};

const reviewConfig = (voice) => ({
  bookends: { enabled: true, review: { scriptMarker: MARKER, presenter: null, ...(voice ? { voice } : {}) } },
  scriptIntake: { markdown: null },
});

const packageScript = (review, extra = {}) => ({
  format: NARRATED_SCRIPT_PACKAGE_FORMAT,
  story: [
    { id: "p1", text: "最初の物語です。" },
    { id: "p2", text: "次の場面です。" },
    { id: "p3", text: "終わりの場面です。" },
  ],
  reviewMarker: MARKER,
  review,
  ...extra,
});

const planPackage = (pkg, config) => planNarratedStoryInput({
  script: JSON.stringify(pkg),
  scriptPath: "/work/input/script.json",
  config,
  planRawScript: planNarratedStoryScript,
});

test("字幕の秒数の既定: 1秒4文字で切り上げ、短い文も 1.5 秒、上限（30 秒）を越える文は null（黙って縮めない）", () => {
  assert.equal(narratedVoicelessCaptionSeconds("ありがとう。"), 1.5);
  assert.equal(narratedVoicelessCaptionSeconds("あ".repeat(20)), 5);
  assert.equal(narratedVoicelessCaptionSeconds("あ".repeat(21)), 5.3);
  assert.equal(narratedVoicelessCaptionSeconds(`${"あ".repeat(10)} ${"い".repeat(10)}`), 5, "空白は数えない");
  assert.equal(narratedVoicelessCaptionSeconds("あ".repeat(120)), 30);
  assert.equal(narratedVoicelessCaptionSeconds("あ".repeat(121)), null);
});

test("Pack: bookends.review.voice は voiced（既定）か none。知らない値は推測せず止め、durable Job の形の検査も受ける", async (t) => {
  const base = structuredClone(bookendFixtureChannelConfig().bookends);
  assert.equal(normalizeNarratedBookendsConfig(base).config.review.voice, "voiced");
  assert.equal(normalizeNarratedBookendsConfig({ ...base, review: { ...base.review, voice: "none" } }).config.review.voice, "none");
  const wrong = normalizeNarratedBookendsConfig({ ...base, review: { ...base.review, voice: "silent" } });
  assert.ok(wrong.blockers.includes("bookends.review.voice"), wrong.blockers.join(", "));
  const root = await mkdtemp(join(os.tmpdir(), "narrated-voiceless-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = bookendFixtureChannelConfig();
  config.bookends.review.voice = "none";
  await writeFile(join(root, "narrated-story.json"), JSON.stringify(config), "utf8");
  const runtime = await extractNarratedChannelPackRuntime({ payloadDir: root, evidence: { harnessId: "narrated-story-video", payloadSha256: "e".repeat(64) } });
  assert.equal(runtime.ttsProvider, "fixture-voice");
});

test("台本パッケージ（声なし）: 感想の文は文ごとに字幕だけになり、秒数は台本の captionOnlySeconds か読む速さの既定", () => {
  const result = planPackage(packageScript([
    { id: "r1", text: "こんにちは、感想です。", layout: "plain" },
    { id: "r2", text: "感想の一文目です。二文目です。" },
    { id: "r3", text: "字幕だけの一文です。", captionOnlySeconds: 2 },
  ]), reviewConfig("none"));
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.storySegments.map((segment) => Boolean(segment.captionOnly)), [false, false, false], "本編は声のまま");
  assert.deepEqual(result.reviewSegments.map((segment) => [segment.id, segment.captionOnlySeconds, segment.captionSecondsBasis || "declared"]), [
    ["r1", 2.8, "reading-speed"],
    ["r2.t1", 2.3, "reading-speed"],
    ["r2.t2", 1.5, "reading-speed"],
    ["r3", 2, "declared"],
  ]);
  for (const segment of result.reviewSegments) {
    assert.equal(segment.captionOnly, true);
    assert.equal(segment.delivery, "caption-only");
    assert.equal(segment.speakerId, undefined, "声なしの感想の文には話者を残さない");
    assert.equal(segment.voice, undefined);
  }
  assert.equal(result.reviewSegments[0].reviewLayout, "plain");
  // 声ありの Pack（既定）では今までどおり声にし、字幕だけの文で感想パートを始められない。
  const voiced = planPackage(packageScript([{ id: "r1", text: "感想です。" }, { id: "r2", text: "字幕だけ。", captionOnlySeconds: 1.5 }]), reviewConfig());
  assert.deepEqual(voiced.reviewSegments.map((segment) => Boolean(segment.captionOnly)), [false, true]);
});

test("台本パッケージ（声なし）: 感想の文の話者・読みの指定や、読み切れない長さの文は、理由コードつきで有料生成の前に止まる", () => {
  const speakers = planPackage(packageScript(
    [{ id: "r1", text: "感想です。", speaker: "guide" }, { id: "r2", text: "二文目です。", speaker: "narrator" }, { id: "r3", text: "三文目です。" }],
    { speakers: [{ id: "guide", castRole: "guide" }] },
  ), reviewConfig("none"));
  assert.equal(speakers.stage, "review-voice");
  assert.deepEqual(speakers.issues, ["review-voice-none-mismatch:speaker:r1", "review-voice-none-mismatch:speaker:r2"]);
  const readings = planPackage(packageScript([{ id: "r1", text: "開けずに待った。" }], {
    readings: [{ segmentId: "r1", display: "開けずに", spoken: "ひらけずに" }, { segmentId: "p1", display: "最初", spoken: "さいしょ" }],
  }), reviewConfig("none"));
  assert.deepEqual(readings.issues, ["review-voice-none-mismatch:reading:r1"]);
  const long = planPackage(packageScript([{ id: "r1", text: `${"あ".repeat(130)}。` }]), reviewConfig("none"));
  assert.deepEqual(long.issues, ["caption-only-seconds-exceed-limit:r1"]);
});

test("生テキスト（声なし）: 区切り行の後ろの文は字幕だけになり、本編は変わらない", () => {
  const raw = ["最初の物語です。", "次の場面です。", MARKER, "感想の一文目です。", "感想の二文目です。"].join("\n");
  const voiceless = planNarratedStoryInput({ script: raw, scriptPath: "script.txt", config: reviewConfig("none"), planRawScript: planNarratedStoryScript });
  const voiced = planNarratedStoryInput({ script: raw, scriptPath: "script.txt", config: reviewConfig(), planRawScript: planNarratedStoryScript });
  assert.deepEqual(voiceless.issues, []);
  assert.deepEqual(voiceless.storySegments, voiced.storySegments);
  assert.deepEqual(voiceless.reviewSegments.map((segment) => [segment.id, segment.captionOnly, segment.captionOnlySeconds]), [
    ["r001", true, 2.3],
    ["r002", true, 2.3],
  ]);
  assert.deepEqual(voiced.reviewSegments.map((segment) => Boolean(segment.captionOnly)), [false, false]);
});

test("見た目の計画: 声なしの感想パートは字幕だけの文で始めてよく、声のある文が混ざれば止める", async () => {
  const config = reviewConfig("none");
  const opened = await checkNarratedVisualPlan({ config, segments: [{ id: "p1", part: "story" }, { id: "r1", part: "review", captionOnly: true }] });
  assert.deepEqual(opened.issues, []);
  const mixed = await checkNarratedVisualPlan({ config, segments: [{ id: "r1", part: "review", captionOnly: true }, { id: "r2", part: "review" }] });
  assert.deepEqual(mixed.issues, ["review-voice-none-segment-voiced:r2"]);
  const voiced = await checkNarratedVisualPlan({ config: reviewConfig(), segments: [{ id: "r1", part: "review", captionOnly: true }] });
  assert.deepEqual(voiced.issues, ["caption-only-cannot-open-review:r1"]);
});

test("時間割: 声なしの感想の部に voice: none が付き、声ありの部には付かない", () => {
  const transitions = { storyToReview: { type: "hard-cut", durationSeconds: 0, leadInSeconds: 0.25 } };
  const story = [{ id: "p1", durationSeconds: 1 }];
  const review = [{ id: "r1", durationSeconds: 1.5 }];
  const voiceless = planNarratedBookendProgram({ fps: 24, story, review, reviewVoice: "none", transitions });
  assert.equal(voiceless.parts.find((part) => part.id === "review").voice, "none");
  const voiced = planNarratedBookendProgram({ fps: 24, story, review, transitions });
  assert.equal(voiced.parts.find((part) => part.id === "review").voice, undefined);
});

async function writeVoicelessPack(payloadDir) {
  await mkdir(payloadDir, { recursive: true });
  await writeBookendPackAssets(payloadDir, toolchain);
  const fontFile = await writeSubtitlePackFont(payloadDir, fontPath);
  const config = { ...bookendFixtureChannelConfig(), render: { width: 640, height: 360, fps: 24 }, subtitles: bandSubtitleConfig(fontFile) };
  config.bookends.review.presenter = { required: false };
  config.bookends.review.layout = LAYOUT;
  config.bookends.review.voice = "none";
  await writeFile(join(payloadDir, "narrated-story.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function runVoicelessFixture(root, review, { jobId = "video-narrated-story-video-v01ce1e550000001", extra = {} } = {}) {
  await mkdir(root, { recursive: true });
  const reviewer = generateReviewerKeyPair();
  const trustPath = join(root, "trust.json");
  await writeFile(trustPath, JSON.stringify({ version: REVIEWER_TRUST_VERSION, reviewers: [createReviewerTrustEntry({ publicKeyPem: reviewer.publicKeyPem, label: "voiceless fixture" })] }));
  const fixture = await createBookendFixtureMedia(join(root, "fixture-media"), toolchain);
  const payloadDir = join(root, "pack");
  await writeVoicelessPack(payloadDir);
  const scriptPath = join(root, "script-package.json");
  await writeFile(scriptPath, JSON.stringify(packageScript(review, extra)), "utf8");
  // 台本の関門（監査契約 v8 から）はこの試験の対象外。台本を人がそのまま使うと認めた記録を置く。
  await acceptScriptForTests(scriptPath);
  const adapters = bookendFixtureAdapters(fixture);
  const options = {
    command: "full",
    scriptPath,
    channelPackDir: payloadDir,
    jobId,
    jobIdentityDigest: "7".repeat(64),
    deploymentRoot: join(root, "run"),
    mediaJobRunner: adapters.mediaJobRunner,
    mediaJobProbe: adapters.mediaJobProbe,
    ffmpegToolchain: toolchain,
    voiceQualityGate: passingVoiceQualityGate,
    env: { ...process.env, [REVIEWER_TRUST_PATH_ENV]: trustPath },
  };
  const outcome = await runPastAssetLoops(() => runNarratedStoryVideo(options, { allowDirectUnboundJobForTests: true }));
  return { outcome, adapters, fixture, payloadDir, scriptPath };
}

const VOICELESS_REVIEW = [
  { id: "r1", text: "こんにちは、感想です。", layout: "plain" },
  { id: "r2", text: "感想の一文目です。二文目です。", tvScene: "p2" },
  { id: "r3", text: "字幕だけの一文です。", captionOnlySeconds: 2 },
];

test("公式経路（声なしの感想パート）: 声を作らず最後まで通り、境目・音量・字幕・配置の監査が声の無い感想パートで通る。壊した版は落ちる", {
  skip: toolchain.ok ? false : "ffmpeg/ffprobe is unavailable",
}, async () => {
  assert.ok(fontPath, "日本語の書体が見つからない（Linux は fonts-noto-cjk、Windows は日本語の補助フォント）");
  const temp = await mkdtemp(join(os.tmpdir(), "narrated-voiceless-review-"));
  try {
    const { outcome, adapters } = await runVoicelessFixture(temp, VOICELESS_REVIEW);
    assert.equal(outcome.status, "awaiting-human-review", JSON.stringify(outcome.knownRemainingIssues));
    for (const [auditId, value] of Object.entries(outcome.auditChecks)) {
      if (AUTOMATIC_EXEMPT.has(auditId)) continue;
      assert.equal(value.pass, true, `${auditId}: ${value.detail}`);
    }
    // 声の Media Job は本編の 3 文だけ（有料の TTS を感想パートで呼ばない）。画は本編 3 場面と plain の挨拶の 1 枚。
    assert.equal(adapters.calls.kinds.filter((kind) => kind === "voice.synthesis").length, 3);
    assert.equal(adapters.calls.kinds.filter((kind) => kind === "image.generation").length, 4);
    const manifest = JSON.parse(await readFile(outcome.artifacts.generationManifest.path, "utf8"));
    const reviewRows = manifest.segments.filter((segment) => segment.part === "review");
    assert.deepEqual(reviewRows.map((row) => row.id), ["r1", "r2.t1", "r2.t2", "r3"]);
    for (const row of reviewRows) {
      assert.equal(row.captionOnly, true);
      assert.equal(row.voiceSha256, null);
      assert.match(row.silenceSha256, /^[a-f0-9]{64}$/u);
    }
    assert.deepEqual(reviewRows.map((row) => row.captionSecondsBasis || "declared"), ["reading-speed", "reading-speed", "reading-speed", "declared"]);
    assert.equal(manifest.bookends.parts.find((part) => part.id === "review").voice, "none");
    // 境目: 語りの代わりに、最初の字幕が lead の終わりで始まり、感想の区間の voice stem が無音で、BGM が途切れない。
    const boundary = outcome.auditChecks.audioBoundaryBreathV16.measurement.boundaries.find((entry) => entry.id === "storyToReview");
    assert.equal(boundary.metrics.incomingVoice, "none");
    assert.equal(boundary.metrics.stemOnsetSeconds, null);
    assert.ok(Math.abs(boundary.metrics.firstIncomingCueSeconds - boundary.metrics.incomingStartSeconds) <= 0.5 / 24 + 0.002);
    assert.ok(boundary.metrics.voicelessIncoming.stemMaxDb <= -60, JSON.stringify(boundary.metrics.voicelessIncoming));
    assert.ok(boundary.metrics.voicelessIncoming.longestSilenceSeconds <= 0.08, JSON.stringify(boundary.metrics.voicelessIncoming));
    assert.match(outcome.auditChecks.audioBoundaryBreathV16.detail, /voiceless review \(storyToReview\)/u);
    // 語りの明瞭さは声のある文だけで測り、字幕だけの区間は数として残す。
    assert.deepEqual(outcome.auditChecks.narrationBedSeparation.intervals.map((entry) => entry.id), ["p1", "p2", "p3"]);
    assert.deepEqual(outcome.auditChecks.narrationBedSeparation.captionOnlySegmentIds, ["r1", "r2.t1", "r2.t2", "r3"]);
    // 字幕は全部の文に焼き込まれ（本編 3 + 感想 4）、配置は plain の挨拶と TV の区間で測れる。
    assert.equal(outcome.auditChecks.burnedSubtitlesMeasured.measurement.cueCount, 7);
    // 区間: plain の挨拶・r2 の2文（TV の中は p2）・r3（TV の中は本編の場面を順に p1）。人物の枠は空のまま。
    assert.deepEqual(outcome.auditChecks.reviewLayoutMeasured.measurement.sections.map((section) => [section.layout, section.tvScene]), [
      ["plain", null],
      ["tv-left-presenter-right", "p2"],
      ["tv-left-presenter-right", "p1"],
    ]);
    assert.equal(outcome.auditChecks.audioBoundaryBreathV16.measurement.end.captionCount, 7);

    // 記録から組み直した時間割で、元の MP4 を測り直せば通る。
    const plan = rehydrateBookendPlan({ bookends: manifest.bookends, segments: manifest.segments });
    const measure = (videoPath, voiceStemPath, measuredPlan = plan) => measureNarratedBookendBoundaries({
      ffmpeg: toolchain.ffmpeg,
      ffprobe: toolchain.ffprobe,
      videoPath,
      voiceStemPath,
      plan: measuredPlan,
    });
    const again = await measure(outcome.artifacts.previewVideo.path, outcome.artifacts.voiceStem.path);
    assert.equal(again.audio.pass, true, JSON.stringify(again.audio.boundaries.map((entry) => entry.problems)));
    const reviewPart = plan.parts.find((part) => part.id === "review");

    // 壊した版 1: 感想の区間に声が入った voice stem（声なしと宣言したのに語りがある）。
    const voicedStem = join(temp, "voice-stem-with-review-narration.wav");
    await ff(toolchain, [
      // 合成の声（fixture の声のテイクと同じ形の正弦波）を感想の区間の頭から 0.5 秒の位置に足す。
      "-i", outcome.artifacts.voiceStem.path, "-i", join(temp, "fixture-media", "fixture-voice.wav"),
      "-filter_complex", `[1:a]adelay=${Math.round((reviewPart.startSeconds + 0.5) * 1000)}:all=1[v];[0:a][v]amix=inputs=2:duration=first:normalize=0[out]`,
      "-map", "[out]", "-c:a", "pcm_s16le", voicedStem,
    ]);
    const withNarration = await measure(outcome.artifacts.previewVideo.path, voicedStem);
    const narrated = withNarration.audio.boundaries.find((entry) => entry.id === "storyToReview");
    assert.ok(narrated.problems.includes("narration-in-voiceless-part"), narrated.problems.join(", "));
    assert.ok(narrated.metrics.voicelessIncoming.stemMaxDb > -60);

    // 壊した版 2: 感想の区間の途中で BGM が途切れた MP4（声の代わりに鳴るはずの音が無い）。
    const holeFrom = reviewPart.startSeconds + 0.6;
    const deadAir = join(temp, "review-dead-air.mp4");
    await ff(toolchain, [
      "-i", outcome.artifacts.previewVideo.path, "-map", "0",
      "-af", `volume=enable='between(t,${holeFrom.toFixed(3)},${(holeFrom + 0.4).toFixed(3)})':volume=0`,
      "-c:v", "copy", "-c:s", "copy", "-c:a", "aac", "-b:a", "192k", deadAir,
    ]);
    const silent = await measure(deadAir, outcome.artifacts.voiceStem.path);
    const hole = silent.audio.boundaries.find((entry) => entry.id === "storyToReview");
    assert.ok(hole.problems.includes("dead-air-in-voiceless-part"), hole.problems.join(", "));
    assert.ok(hole.metrics.voicelessIncoming.longestSilenceSeconds >= 0.3);

    // 声ありの決まり（次の語りの発話が lead の終わりで始まる）では、声なしの感想パートは測れない（だから宣言で分ける）。
    const voicedRule = { ...plan, parts: plan.parts.map(({ voice, ...part }) => part) };
    const unmeasured = (await measure(outcome.artifacts.previewVideo.path, outcome.artifacts.voiceStem.path, voicedRule)).audio.boundaries.find((entry) => entry.id === "storyToReview");
    assert.ok(unmeasured.problems.includes("incoming-narration-onset-unmeasured"), unmeasured.problems.join(", "));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("公式経路（声なしの感想パート）: 感想の文に話者を書いた台本は、probe も有料生成もせずに止まり、plan-only でも同じ理由が出る", {
  skip: toolchain.ok ? false : "ffmpeg/ffprobe is unavailable",
}, async () => {
  assert.ok(fontPath, "日本語の書体が見つからない");
  const temp = await mkdtemp(join(os.tmpdir(), "narrated-voiceless-mismatch-"));
  try {
    const { outcome, adapters, payloadDir, scriptPath } = await runVoicelessFixture(temp, [
      { id: "r1", text: "こんにちは、感想です。", speaker: "guide" },
      { id: "r2", text: "感想の一文目です。" },
    ], { jobId: "video-narrated-story-video-v01ce1e550000002", extra: { speakers: [{ id: "guide", castRole: "guide" }] } });
    assert.equal(outcome.status, "awaiting-operator-input");
    assert.deepEqual(outcome.knownRemainingIssues, ["review-voice-none-mismatch:speaker:r1"]);
    assert.equal(adapters.calls.generation, 0);
    assert.equal(adapters.calls.probe, 0);
    const plan = await inspectNarratedStoryPlan({ scriptPath, channelPackDir: payloadDir });
    assert.deepEqual(plan.blockers, ["review-voice-none-mismatch:speaker:r1"]);
    assert.equal(plan.paidCallsAttempted, false);
    assert.equal(plan.reviewVoice, "none", "plan-only でも感想パートの声を作らないことが見える");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
