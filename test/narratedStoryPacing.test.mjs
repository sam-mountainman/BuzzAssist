#!/usr/bin/env node

// 本編の間（Channel Pack の pacing。lib/narratedStoryPacing.mjs）: 文と文・場面と場面の間に、語りの声も字幕も無く
// BGM だけが流れる時間を置く。宣言の読み方・間の計画（二重にしない・最初の前と最後の後ろと感想パートには置かない）・
// 時間割（声・字幕・カメラ・場面の切り替え）を純粋関数で確かめ、合成の Pack（間 0.94 秒・crossfade 0.5 秒・焼き込み
// 字幕・OP と感想パート）と合成の声（前後の無音がほぼ無い）と合成の画で公式経路を最後まで通し、全部の自動監査が
// 通ること、壊した版（間を足していない stem・場面の間を二重にした stem・BGM が途切れた MP4・間に語りの大きさの音が
// ある MP4・間の間も字幕を残した MP4）を監査が落とすことを確かめる。有料 API もネットワークも使わない。

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
import { planNarratedBookendProgram, segmentTimelinePlan } from "../lib/narratedStoryBookends.mjs";
import { normalizeNarratedCameraConfig, planNarratedCameraShots } from "../lib/narratedStoryCamera.mjs";
import {
  PAUSE_LENGTH_TOLERANCE_FRAMES,
  PAUSE_MP4_EDGE_EXCLUDE_SECONDS,
  measureNarratedPacing,
  normalizeNarratedPacingConfig,
  planNarratedStoryPauses,
} from "../lib/narratedStoryPacing.mjs";
import { inspectNarratedStoryPlan, loadNarratedStoryChannelConfig } from "../lib/narratedStoryPipeline.mjs";
import { normalizeNarratedSceneTransitionConfig, planNarratedSceneJoins } from "../lib/narratedStorySceneTransitions.mjs";
import { NARRATED_SCRIPT_PACKAGE_FORMAT } from "../lib/narratedStoryScriptPackage.mjs";
import { runNarratedStoryVideo } from "../lib/narratedStoryVideo.mjs";
import { narratedProgramFrames, planNarratedVisualCamera } from "../lib/narratedStoryVisuals.mjs";
import { runPastAssetLoops } from "./fixtures/narratedAssetLoopFixture.mjs";
import {
  bookendFixtureAdapters,
  bookendFixtureChannelConfig,
  createBookendFixtureMedia,
  fixtureSha256,
  passingVoiceQualityGate,
  writeBookendPackAssets,
} from "./fixtures/narratedBookendFixture.mjs";
import { bandSubtitleConfig, ff, findJapaneseFontFile, makeTexturedStill, writeSubtitlePackFont } from "./fixtures/narratedVisualFixture.mjs";
import { acceptScriptForTests } from "./helpers/scriptQualityAcceptance.mjs";

const toolchain = await resolveFfmpegToolchain();
const fontPath = await findJapaneseFontFile();
const FPS = 24;
const GAP = 0.94;
const AUTOMATIC_EXEMPT = new Set(["perceptualReviewChecks", "perceptualReviewBoundToOutput", "perceptualEvidenceHashes", "contactSheetOriginalDetailReviewed", "qualityLoopPassed", "characterIdentityReviewed"]);
// 合成のカメラ（どのチャンネルの値でもない）。
const CAMERA_PACK = {
  moves: { "slow-push-in": { zoomPerSecond: 0.03, maxZoom: 1.15 }, "pan-left": { panPerSecond: 0.04, zoom: 1.12 } },
  sequence: ["slow-push-in", "pan-left"],
};

test("Pack の宣言: 無ければ間を足さない。場面の間は無ければ文の間と同じ、0 なら場面の境目に置かない。範囲外・型違い・知らない欄・間より長い crossfade は止める", async (t) => {
  assert.deepEqual(normalizeNarratedPacingConfig(undefined), {
    config: { enabled: false, sentenceGapSeconds: 0, sceneGapSeconds: 0, sceneGapDeclared: false, source: "core-default" },
    blockers: [],
  });
  assert.deepEqual(normalizeNarratedPacingConfig({ sentenceGapSeconds: 0.94, sceneGapSeconds: 0.94 }).config, {
    enabled: true, sentenceGapSeconds: 0.94, sceneGapSeconds: 0.94, sceneGapDeclared: true, source: "channel-pack",
  });
  assert.equal(normalizeNarratedPacingConfig({ sentenceGapSeconds: 0.5 }).config.sceneGapSeconds, 0.5, "場面の間は無ければ文の間");
  const noScene = normalizeNarratedPacingConfig({ sentenceGapSeconds: 0.5, sceneGapSeconds: 0 }).config;
  assert.equal(noScene.sceneGapSeconds, 0);
  assert.equal(noScene.enabled, true);
  assert.equal(normalizeNarratedPacingConfig({ sentenceGapSeconds: 0, sceneGapSeconds: 0 }).config.enabled, false);
  for (const [source, expected] of [
    ["0.94", "pacing"],
    [{ sentenceGapSeconds: "0.94" }, "pacing.sentenceGapSeconds"],
    [{ sentenceGapSeconds: 0.05 }, "pacing.sentenceGapSeconds"],
    [{ sentenceGapSeconds: 3.5 }, "pacing.sentenceGapSeconds"],
    [{ sentenceGapSeconds: 0.5, sceneGapSeconds: -1 }, "pacing.sceneGapSeconds"],
    [{ sentenceGapSeconds: 0.5, reviewGapSeconds: 0.5 }, "pacing.reviewGapSeconds-unknown"],
  ]) {
    assert.ok(normalizeNarratedPacingConfig(source).blockers.includes(expected), `${JSON.stringify(source)} → ${expected}`);
  }
  // 場面の切り替えの crossfade は場面の間の中に収める。収まらない宣言は有料生成の前に止める。
  const crossfade = normalizeNarratedSceneTransitionConfig({ type: "crossfade", durationSeconds: 1 }, { fps: FPS }).config;
  assert.deepEqual(normalizeNarratedPacingConfig({ sentenceGapSeconds: 0.94 }, { sceneTransition: crossfade }).blockers, ["pacing.sceneGapSeconds-shorter-than-sceneTransition"]);
  assert.deepEqual(normalizeNarratedPacingConfig({ sentenceGapSeconds: 0.94, sceneGapSeconds: 1 }, { sceneTransition: crossfade }).blockers, []);
  assert.deepEqual(normalizeNarratedPacingConfig({ sentenceGapSeconds: 0.94, sceneGapSeconds: 0 }, { sceneTransition: crossfade }).blockers, [], "場面の間を置かないなら今までどおり語りに重ねてよい");
  // durable Job へ持ち込む形の検査も、知らない欄を止める。
  const root = await mkdtemp(join(os.tmpdir(), "narrated-pacing-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "narrated-story.json"), JSON.stringify({ ...bookendFixtureChannelConfig(), pacing: { sentenceGapSeconds: 0.94, lineGapSeconds: 1 } }), "utf8");
  await assert.rejects(extractNarratedChannelPackRuntime({ payloadDir: root, evidence: { harnessId: "narrated-story-video", payloadSha256: "e".repeat(64) } }), /pacing contains unsupported fields: lineGapSeconds/u);
});

const storyPlanSegments = [
  { id: "p1.t1", imageKey: "p1", part: "story", durationSeconds: 1.2 },
  { id: "p1.t2", imageKey: "p1", part: "story", durationSeconds: 0.8 },
  { id: "p2", imageKey: "p2", part: "story", durationSeconds: 1.0 },
  { id: "p3", imageKey: "p3", part: "story", durationSeconds: 0.9 },
];

test("間の計画: 同じ画の中は文の間、画が変わる所は場面の間（足し合わせない）。最初の前と最後の後ろには置かず、間は標本の整数で前後の文の枠に半分ずつ割る", () => {
  const pacing = normalizeNarratedPacingConfig({ sentenceGapSeconds: 0.5, sceneGapSeconds: 0.94 }).config;
  const planned = planNarratedStoryPauses(storyPlanSegments, pacing);
  assert.deepEqual(planned.pauses.map(({ afterSegmentId, beforeSegmentId, kind, seconds, samples }) => [afterSegmentId, beforeSegmentId, kind, seconds, samples]), [
    ["p1.t1", "p1.t2", "sentence", 0.5, 24_000],
    ["p1.t2", "p2", "scene", 0.94, 45_120],
    ["p2", "p3", "scene", 0.94, 45_120],
  ]);
  assert.equal(planned.addedSeconds, 0.5 + 0.94 + 0.94);
  assert.deepEqual(planned.bySegment.get("p1.t1"), { pauseBeforeSamples: 0, pauseAfterSamples: 12_000, pauseBeforeSeconds: 0, pauseAfterSeconds: 0.25 });
  assert.deepEqual(planned.bySegment.get("p2"), { pauseBeforeSamples: 22_560, pauseAfterSamples: 22_560, pauseBeforeSeconds: 0.47, pauseAfterSeconds: 0.47 });
  assert.equal(planned.bySegment.get("p3").pauseAfterSamples, 0, "本編の最後の文の後ろには置かない");
  // 場面の境目に置かない宣言（sceneGapSeconds: 0）では、場面の境目は今までどおり隙間なく並ぶ。
  const sentenceOnly = planNarratedStoryPauses(storyPlanSegments, normalizeNarratedPacingConfig({ sentenceGapSeconds: 0.5, sceneGapSeconds: 0 }).config);
  assert.deepEqual(sentenceOnly.pauses.map((pause) => pause.kind), ["sentence"]);
  // 宣言が無ければ何も置かない。
  assert.deepEqual(planNarratedStoryPauses(storyPlanSegments, normalizeNarratedPacingConfig(undefined).config).pauses, []);
});

test("時間割: 文の枠（画とカメラ）は間を含み、声と字幕はテイクの区間。場面の画の切り替えは間の真ん中にあり、crossfade の重なりは間の中に収まる。間の無い番組は今までと同じ", () => {
  const pacing = normalizeNarratedPacingConfig({ sentenceGapSeconds: GAP, sceneGapSeconds: GAP }).config;
  const planned = planNarratedStoryPauses(storyPlanSegments, pacing);
  const story = storyPlanSegments.map((segment) => ({ ...segment, ...(planned.bySegment.get(segment.id) || {}) }));
  const transitions = { storyToReview: { type: "hard-cut", durationSeconds: 0, leadInSeconds: 0.25 } };
  const review = [{ id: "r1", part: "review", durationSeconds: 1 }, { id: "r2", part: "review", durationSeconds: 1 }];
  const plan = planNarratedBookendProgram({ fps: FPS, story, review, transitions });
  const byId = new Map(plan.segments.map((segment) => [segment.id, segment]));
  // 声の時刻: 前のテイクの終わりから次のテイクの始まりまでが宣言の間。
  assert.ok(Math.abs(byId.get("p1.t2").startSeconds - byId.get("p1.t1").endSeconds - GAP) < 1e-9);
  assert.ok(Math.abs(byId.get("p2").startSeconds - byId.get("p1.t2").endSeconds - GAP) < 1e-9);
  assert.equal(byId.get("p1.t1").startSeconds, 0, "本編の最初の文の前には置かない");
  // 尺: 本編の部は声の実尺と間の合計をフレームへ切り上げた長さ。感想パートの文の間には置かない。
  const storyPart = plan.parts.find((part) => part.id === "story");
  assert.equal(storyPart.frames, Math.ceil((1.2 + 0.8 + 1.0 + 0.9 + 3 * GAP) * FPS - 1e-6));
  assert.ok(storyPart.endSeconds - byId.get("p3").endSeconds < 1 / FPS, "本編の最後の文の後ろには置かない");
  assert.equal(byId.get("r2").startSeconds, byId.get("r1").endSeconds);
  // 字幕の頁は声の区間に置く（間のフレームには置かない）。
  for (const [previous, next] of [["p1.t1", "p1.t2"], ["p1.t2", "p2"], ["p2", "p3"]]) {
    const captionEnd = byId.get(previous).captionPartStartFrame + byId.get(previous).captionFrames;
    const captionStart = byId.get(next).captionPartStartFrame;
    assert.ok(Math.abs(captionStart - captionEnd - GAP * FPS) <= 1, `${previous}>${next}: 字幕の無いフレーム ${captionStart - captionEnd}`);
    assert.equal(byId.get(previous).pauseTailFrames + byId.get(next).pauseHeadFrames, captionStart - captionEnd);
  }
  // 画: 同じ画の文は1つのショット（間を含めて1つの動き）。場面の切り替えは間の真ん中で、crossfade は間の中。
  const frames = narratedProgramFrames({ bookendPlan: plan, fps: FPS });
  const camera = normalizeNarratedCameraConfig(CAMERA_PACK).config;
  const cameraPlan = planNarratedVisualCamera({ config: { camera, render: { fps: FPS } }, programFrames: frames });
  const storyShots = cameraPlan.shots.filter((shot) => shot.part === "story");
  assert.deepEqual(storyShots.map((shot) => shot.segmentIds), [["p1.t1", "p1.t2"], ["p2"], ["p3"]]);
  assert.equal(storyShots[0].frames, byId.get("p1.t1").frames + byId.get("p1.t2").frames, "同じ画のショットは文の間も含めて1つ");
  const crossfade = normalizeNarratedSceneTransitionConfig({ type: "crossfade", durationSeconds: 0.5 }, { fps: FPS }).config;
  const joins = planNarratedSceneJoins({ shots: storyShots, transition: crossfade });
  const programSegment = new Map(frames.segments.map((segment) => [segment.id, segment]));
  for (const [join, [previous, next]] of joins.map((entry, index) => [entry, [["p1.t2", "p2"], ["p2", "p3"]][index]])) {
    const pauseStart = programSegment.get(previous).captionStartFrame + programSegment.get(previous).captionFrames;
    const pauseEnd = programSegment.get(next).captionStartFrame;
    assert.equal(join.type, "crossfade");
    assert.equal(join.frames, 12);
    assert.ok(join.cutFrame - join.before >= pauseStart && join.cutFrame + join.after <= pauseEnd, `${previous}>${next}: [${join.cutFrame - join.before}, ${join.cutFrame + join.after}) ⊄ [${pauseStart}, ${pauseEnd})`);
    assert.ok(Math.abs((join.cutFrame - pauseStart) - (pauseEnd - join.cutFrame)) <= 1, "切り替えは間の真ん中");
  }
  // 間より長い重なり（フレームの丸めで溢れた場合）は縮め、計画に残す。
  const long = planNarratedSceneJoins({ shots: storyShots, transition: { type: "crossfade", frames: 30 } });
  assert.ok(long.every((join) => join.reduced === "scene-pause" && join.frames < 30), JSON.stringify(long));
  // 間の無い番組は、字幕のフレームが文の枠と同じで、ショットに間の印が付かない（今までと同じ時間割）。
  const plain = segmentTimelinePlan(storyPlanSegments, FPS);
  for (const entry of plain) {
    assert.equal(entry.captionStartFrame, entry.startFrame);
    assert.equal(entry.captionFrames, entry.frames);
    assert.equal(entry.pauseHeadFrames, undefined);
    assert.equal(entry.pauseTailFrames, undefined);
  }
  const plainShots = planNarratedCameraShots({ segments: plain.map((entry, index) => ({ ...storyPlanSegments[index], ...entry })), camera, fps: FPS }).shots;
  assert.ok(plainShots.every((shot) => shot.pauseHeadFrames === undefined && shot.pauseTailFrames === undefined));
});

// ---- 公式経路 -------------------------------------------------------------------

const PACKAGE = {
  format: NARRATED_SCRIPT_PACKAGE_FORMAT,
  story: [
    { id: "p1", text: "最初の物語です。次の文です。" },
    { id: "p2", text: "二つ目の場面です。" },
    { id: "p3", text: "三つ目の場面です。最後の文です。" },
  ],
  reviewMarker: "---感想---",
  review: [
    { id: "r1", text: "感想の一文目です。" },
    { id: "r2", text: "感想の二文目です。" },
  ],
};

/** 前後の無音がほぼ無い合成の声（先頭 5ms で立ち上がり、最後の 0.2 秒で 0 まで下がる。末尾の無音は無い）。 */
async function edgeTightVoice(dir) {
  const path = join(dir, "tight-voice.wav");
  await ff(toolchain, [
    "-f", "lavfi", "-i", "sine=frequency=440:duration=0.6:sample_rate=48000",
    "-af", "volume=0.2,afade=t=in:d=0.005,afade=t=out:st=0.4:d=0.2",
    "-ac", "1", "-c:a", "pcm_s16le", path,
  ]);
  return path;
}

async function writePacingPack(payloadDir, { pacing = { sentenceGapSeconds: GAP, sceneGapSeconds: GAP } } = {}) {
  await mkdir(payloadDir, { recursive: true });
  await writeBookendPackAssets(payloadDir, toolchain);
  const fontFile = await writeSubtitlePackFont(payloadDir, fontPath);
  const config = {
    ...bookendFixtureChannelConfig(),
    render: { width: 640, height: 360, fps: FPS },
    subtitles: bandSubtitleConfig(fontFile),
    camera: CAMERA_PACK,
    sceneTransition: { type: "crossfade", durationSeconds: 0.5 },
    ...(pacing ? { pacing } : {}),
  };
  await writeFile(join(payloadDir, "narrated-story.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return config;
}

/** 場面ごとに模様の違う画と、前後の無音がほぼ無い声を返す adapter。BGM の依頼の長さも記録する。 */
async function pacingAdapters(temp) {
  const fixture = await createBookendFixtureMedia(join(temp, "fixture-media"), toolchain);
  fixture.voice = await readFile(await edgeTightVoice(temp));
  const images = [];
  for (let index = 0; index < 3; index += 1) {
    const still = join(temp, `distinct-${index}.png`);
    await makeTexturedStill(toolchain, still, { width: 640, height: 360, phase: index * 23 });
    images.push(await readFile(still));
  }
  const base = bookendFixtureAdapters(fixture);
  const musicRequests = [];
  return {
    ...base,
    musicRequests,
    mediaJobRunner: async (spec) => {
      if (spec.kind === "music.generation") musicRequests.push(spec.input?.durationSeconds);
      const result = await base.mediaJobRunner(spec);
      if (spec.kind !== "image.generation") return result;
      const bytes = images[Number(String(spec.input?.segmentId || "").replace(/\D/gu, "") || 0) % images.length];
      return { ...result, bytes, receipt: { ...result.receipt, artifact: { ...result.receipt.artifact, sha256: fixtureSha256(bytes), bytes: bytes.length } } };
    },
  };
}

async function runPacingFixture(temp, { jobId = "video-narrated-story-video-9ace0000000000001" } = {}) {
  const reviewer = generateReviewerKeyPair();
  const trustPath = join(temp, "trust.json");
  await writeFile(trustPath, JSON.stringify({ version: REVIEWER_TRUST_VERSION, reviewers: [createReviewerTrustEntry({ publicKeyPem: reviewer.publicKeyPem, label: "pacing fixture" })] }));
  const adapters = await pacingAdapters(temp);
  const payloadDir = join(temp, "pack");
  const config = await writePacingPack(payloadDir);
  const scriptPath = join(temp, "script-package.json");
  await writeFile(scriptPath, JSON.stringify(PACKAGE), "utf8");
  // 台本の関門（監査契約 v8 から）はこの試験の対象外。台本を人がそのまま使うと認めた記録を置く。
  await acceptScriptForTests(scriptPath);
  const outcome = await runPastAssetLoops(() => runNarratedStoryVideo({
    command: "full",
    scriptPath,
    channelPackDir: payloadDir,
    jobId,
    jobIdentityDigest: "9".repeat(64),
    deploymentRoot: join(temp, "run"),
    mediaJobRunner: adapters.mediaJobRunner,
    mediaJobProbe: adapters.mediaJobProbe,
    ffmpegToolchain: toolchain,
    voiceQualityGate: passingVoiceQualityGate,
    env: { ...process.env, [REVIEWER_TRUST_PATH_ENV]: trustPath },
  }, { allowDirectUnboundJobForTests: true }));
  return { outcome, adapters, payloadDir, scriptPath, config };
}

/** 声のテイクを番組の時刻に置いた voice stem（壊した版を作る）。entries は { path, at }（秒）。 */
async function buildStem(temp, name, entries, totalSeconds) {
  const output = join(temp, `${name}.wav`);
  const args = [];
  const filters = [];
  entries.forEach((entry, index) => {
    args.push("-i", entry.path);
    filters.push(`[${index}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono,adelay=delays=${Math.round(entry.at * 48_000)}S:all=1[v${index}]`);
  });
  filters.push(`${entries.map((_, index) => `[v${index}]`).join("")}amix=inputs=${entries.length}:duration=longest:normalize=0,apad=whole_len=${Math.round(totalSeconds * 48_000)},atrim=end_sample=${Math.round(totalSeconds * 48_000)}[out]`);
  await ff(toolchain, [...args, "-filter_complex", filters.join(";"), "-map", "[out]", "-c:a", "pcm_s16le", output]);
  return output;
}

test("公式経路（本編の間 0.94 秒）: 間を含めた時間割で声・字幕・BGM・カメラ・場面の切り替え・境目が揃い、全部の自動監査が通る。壊した版は間の監査が落とす", {
  skip: toolchain.ok ? false : "ffmpeg/ffprobe is unavailable",
}, async (t) => {
  assert.ok(fontPath, "日本語の書体が見つからない（Linux は fonts-noto-cjk、Windows は日本語の補助フォント）");
  const temp = await mkdtemp(join(os.tmpdir(), "narrated-pacing-"));
  try {
    const { outcome, adapters, payloadDir, scriptPath } = await runPacingFixture(temp);
    assert.equal(outcome.status, "awaiting-human-review", JSON.stringify(outcome.knownRemainingIssues));
    for (const [auditId, value] of Object.entries(outcome.auditChecks)) {
      if (AUTOMATIC_EXEMPT.has(auditId)) continue;
      assert.equal(value.pass, true, `${auditId}: ${value.detail}`);
    }
    const manifest = JSON.parse(await readFile(outcome.artifacts.generationManifest.path, "utf8"));
    const story = manifest.segments.filter((segment) => segment.part === "story");
    assert.deepEqual(story.map((segment) => segment.id), ["p1.t1", "p1.t2", "p2", "p3.t1", "p3.t2"]);
    // 生成記録: 間の宣言と、4つの間（文の間 2・場面の間 2）。感想パートの文には間が無い。
    assert.equal(manifest.pacing.enabled, true);
    assert.deepEqual(manifest.pacing.pauses.map((pause) => [pause.afterSegmentId, pause.kind, pause.seconds]), [
      ["p1.t1", "sentence", GAP], ["p1.t2", "scene", GAP], ["p2", "scene", GAP], ["p3.t1", "sentence", GAP],
    ]);
    assert.ok(Math.abs(manifest.pacing.addedSeconds - 4 * GAP) < 1e-9);
    for (const segment of manifest.segments.filter((row) => row.part === "review")) {
      assert.equal(segment.pauseBeforeSeconds, undefined);
      assert.equal(segment.pauseAfterSeconds, undefined);
    }
    for (const [index, segment] of story.entries()) {
      if (index > 0) assert.ok(Math.abs(segment.startSeconds - story[index - 1].endSeconds - GAP) < 1e-6, `${segment.id} の前の間`);
      // voice stem へつないだ間の無音つきの写しと、テイクそのものの両方を記録する。
      assert.match(segment.pacedVoiceSha256, /^[a-f0-9]{64}$/u);
      assert.notEqual(segment.pacedVoiceSha256, segment.voiceSha256);
    }
    // 尺: 本編の部の長さに間が入り、BGM の依頼の長さも間を含めた番組の尺、MP4 の尺も計画どおり。
    const storyPart = manifest.bookends.parts.find((part) => part.id === "story");
    const voiceSeconds = story.reduce((sum, segment) => sum + segment.durationSeconds, 0);
    assert.equal(storyPart.frames, Math.ceil((voiceSeconds + 4 * GAP) * FPS - 1e-6));
    assert.deepEqual(adapters.musicRequests, [manifest.bookends.totalSeconds], "BGM の依頼は間を含めた番組の尺");
    assert.equal(outcome.auditChecks.duration.pass, true);
    assert.ok(Math.abs(outcome.auditChecks.duration.expectedSeconds - manifest.bookends.totalSeconds) < 1e-9);
    // 間の監査: 4つの間の全部で、語りが無く、BGM が流れ、足した無音が 1 フレーム以内、字幕と場面の切り替えが決まりどおり。
    const pacing = outcome.auditChecks.narrationPacingMeasured.measurement;
    t.diagnostic(`基準版: ${JSON.stringify(pacing.pauses.map((row) => ({ kind: row.kind, ...row.metrics })))}`);
    assert.equal(pacing.pauseCount, 4);
    assert.equal(pacing.sentencePauses, 2);
    assert.equal(pacing.scenePauses, 2);
    for (const row of pacing.pauses) {
      assert.ok(row.metrics.lengthErrorSeconds <= 0.002, `${row.afterSegmentId}: 足した無音の誤差 ${row.metrics.lengthErrorSeconds}`);
      assert.ok(row.metrics.takeTailSilenceSeconds < 0.02 && row.metrics.takeLeadSilenceSeconds < 0.02, `前後の無音がほぼ無い声: ${JSON.stringify(row.metrics)}`);
      assert.ok(row.metrics.stemMaxDb <= -100, `${row.afterSegmentId}: stem の間 ${row.metrics.stemMaxDb}`);
      assert.equal(row.metrics.bedLongestSilenceSeconds, 0);
    }
    assert.deepEqual(pacing.pauses.filter((row) => row.kind === "scene").map((row) => row.metrics.sceneChange.type), ["crossfade", "crossfade"]);
    // 字幕: 焼き込みの頁は語りの終わりで消え、間には無い（焼き込み字幕の監査は各頁の終わりの次のフレームで消えたことを測る）。
    const cues = outcome.auditChecks.burnedSubtitlesMeasured.measurement.cues;
    for (const row of pacing.pauses) {
      assert.ok(!cues.some((cue) => cue.startFrame < row.metrics.pauseFrames.end && cue.endFrame > row.metrics.pauseFrames.start), `${row.afterSegmentId} の間に字幕の頁`);
      const last = cues.filter((cue) => cue.segmentId === row.afterSegmentId).at(-1);
      assert.equal(last.endFrame, row.metrics.pauseFrames.start);
      assert.ok(last.metrics.afterEndFillMatch !== null, "間の最初のフレームで字幕が消えたことを測っている");
    }
    // 場面の切り替えの crossfade は完成 MP4 で計画どおりに混ざり、どれも間の中にある。
    const transitions = outcome.auditChecks.sceneTransitionMeasured.measurement;
    assert.equal(transitions.crossfadeCount, 2);
    assert.deepEqual(manifest.sceneTransitions.joins.map((join) => [join.type, join.frames, join.reduced || ""]), [["crossfade", 12, ""], ["crossfade", 12, ""]]);
    // カメラ: 同じ画の文（p1・p3）は間を含めて1つのショット。
    assert.deepEqual(manifest.camera.shots.filter((shot) => shot.id.startsWith("story:")).map((shot) => shot.segmentIds), [["p1.t1", "p1.t2"], ["p2"], ["p3.t1", "p3.t2"]]);
    // 境目: 本編の最初の文の前・最後の文の後ろに間を足していないので、lead-in の決まりはそのまま通る。
    const boundaries = outcome.auditChecks.audioBoundaryBreathV16.measurement.boundaries;
    assert.deepEqual(boundaries.map((entry) => [entry.id, entry.pass]), [["openingToStory", true], ["storyToReview", true]]);

    // plan-only の preflight は間の件数と伸びる秒を返す。間より長い crossfade の宣言は有料生成の前に止まる。
    const plan = await inspectNarratedStoryPlan({ scriptPath, channelPackDir: payloadDir });
    assert.deepEqual(plan.pacing, { sentenceGapSeconds: GAP, sceneGapSeconds: GAP, sentencePauses: 2, scenePauses: 2, addedSeconds: 3.76 });

    // ---- 壊した版（閾値の較正と、監査が実際に落とすこと） ----
    const segments = manifest.segments.map((segment) => ({ ...segment }));
    const takeFor = (id) => join(temp, "run", ".media", "narrated-story-video", "video-narrated-story-video-9ace0000000000001", "media", "voice", `${id}.wav`);
    for (const segment of segments) if (segment.part === "story") segment.takePath = takeFor(segment.id);
    const pacingConfig = normalizeNarratedPacingConfig({ sentenceGapSeconds: GAP, sceneGapSeconds: GAP }).config;
    const measure = (options = {}) => measureNarratedPacing({
      ffmpeg: toolchain.ffmpeg,
      videoPath: outcome.artifacts.previewVideo.path,
      voiceStemPath: outcome.artifacts.voiceStem.path,
      pacing: pacingConfig,
      segments,
      storyPart: { startSeconds: storyPart.startFrame / FPS, endSeconds: (storyPart.startFrame + storyPart.frames) / FPS },
      fps: FPS,
      ...options,
    });
    const again = await measure();
    assert.equal(again.pass, true, JSON.stringify(again.problems));
    // 較正: MP4 の間の端を外さずに測ると、AAC の窓で前後の語りが間の中へにじむ（端を 0.05 秒外す根拠）。
    const edges = await measure({ mp4EdgeExcludeSeconds: 0 });
    t.diagnostic(`端を外さない版: ${JSON.stringify(edges.pauses.map((row) => ({ bedDeltaDb: row.metrics.bedDeltaDb, bedMaxDb: row.metrics.bedMaxDb })))}; 端を ${PAUSE_MP4_EDGE_EXCLUDE_SECONDS} 秒外した版: ${JSON.stringify(again.pauses.map((row) => row.metrics.bedDeltaDb))}`);
    const totalSeconds = manifest.bookends.totalSeconds;
    // 較正: 前後の無音が全く無く、語りの大きさのまま始まって終わるテイク（AAC の窓のにじみが最も大きい型）を同じ時刻に
    // 置いた MP4 で、間の端を外さずに測った値と外して測った値を比べる。
    const abruptTake = join(temp, "abrupt-voice.wav");
    await ff(toolchain, ["-f", "lavfi", "-i", "sine=frequency=440:duration=0.6:sample_rate=48000", "-af", "volume=0.2", "-ac", "1", "-c:a", "pcm_s16le", abruptTake]);
    const abruptSegments = segments.map((segment) => (segment.part === "story" ? { ...segment, takePath: abruptTake } : segment));
    const abruptStem = await buildStem(temp, "stem-abrupt", abruptSegments.filter((segment) => segment.part === "story").map((segment) => ({ path: abruptTake, at: segment.startSeconds })), totalSeconds);
    // 番組の master と同じ大きさにそろえる（語りの基準音量を基準版に合わせる。master の 2 pass 線形 loudnorm と同じく
    // 全体に1つの利得を掛けるだけ）。
    const abruptMix = async (name, gainDb) => {
      const output = join(temp, `${name}.mp4`);
      await ff(toolchain, [
        "-i", outcome.artifacts.previewVideo.path, "-i", abruptStem, "-i", outcome.artifacts.bgmStem.path,
        "-filter_complex", `[1:a]pan=stereo|c0=c0|c1=c0[v];[v][2:a]amix=inputs=2:duration=first:normalize=0,volume=${gainDb.toFixed(3)}dB[a]`,
        "-map", "0:v", "-map", "[a]", "-map", "0:s", "-c:v", "copy", "-c:s", "copy", "-c:a", "aac", "-b:a", "192k", output,
      ]);
      return output;
    };
    const abruptOptions = { voiceStemPath: abruptStem, segments: abruptSegments };
    const unscaled = await measure({ ...abruptOptions, videoPath: await abruptMix("abrupt-unscaled", 0) });
    // 声のテイクを番組の master の大きさにする利得（下の壊した版 4 でも使う）。
    const masterGainDb = again.narrationReferenceDb - unscaled.narrationReferenceDb;
    const abruptMp4 = await abruptMix("abrupt", masterGainDb);
    const abruptWhole = await measure({ ...abruptOptions, videoPath: abruptMp4, mp4EdgeExcludeSeconds: 0 });
    const abruptTrimmed = await measure({ ...abruptOptions, videoPath: abruptMp4 });
    t.diagnostic(`端の無音の無いテイク: 端を外さない ${JSON.stringify(abruptWhole.pauses.map((row) => row.metrics.bedDeltaDb))}、端を ${PAUSE_MP4_EDGE_EXCLUDE_SECONDS} 秒外す ${JSON.stringify(abruptTrimmed.pauses.map((row) => row.metrics.bedDeltaDb))}、stem の挿入 ${JSON.stringify(abruptTrimmed.pauses.map((row) => row.metrics.insertedPauseSeconds))}、BGM の最長の無音 ${JSON.stringify(abruptTrimmed.pauses.map((row) => row.metrics.bedLongestSilenceSeconds))}`);
    assert.equal(abruptTrimmed.pass, true, JSON.stringify(abruptTrimmed.problems));
    // 壊した版 1: 間を足していない stem（テイクを隙間なく並べた。宣言を無視して描いた型）。
    const storyStart = storyPart.startFrame / FPS;
    let cursor = storyStart;
    const backToBack = [];
    for (const segment of segments) {
      if (segment.part !== "story") continue;
      backToBack.push({ path: segment.takePath, at: cursor });
      cursor += segment.durationSeconds;
    }
    const noPauseStem = await buildStem(temp, "stem-no-pause", backToBack, totalSeconds);
    const noPause = await measure({ voiceStemPath: noPauseStem });
    t.diagnostic(`間を足していない版: ${JSON.stringify(noPause.pauses.map((row) => ({ inserted: row.metrics.insertedPauseSeconds, stemMaxDb: row.metrics.stemMaxDb })))}`);
    assert.equal(noPause.pass, false);
    assert.ok(noPause.problems.includes("narration-inside-declared-pause"), noPause.problems.join(", "));
    assert.ok(noPause.problems.includes("pause-length-differs-from-declaration"), noPause.problems.join(", "));
    // 壊した版 2: 場面の境目で文の間と場面の間を足し合わせた stem（間が二重）。
    cursor = storyStart;
    const doubled = [];
    let previous = null;
    for (const segment of segments) {
      if (segment.part !== "story") continue;
      if (previous) cursor += previous.imageKey === segment.imageKey ? GAP : 2 * GAP;
      doubled.push({ path: segment.takePath, at: cursor });
      cursor += segment.durationSeconds;
      previous = segment;
    }
    const doubledStem = await buildStem(temp, "stem-doubled", doubled, totalSeconds + 2 * GAP);
    const twice = await measure({ voiceStemPath: doubledStem });
    t.diagnostic(`場面の間を二重にした版: ${JSON.stringify(twice.pauses.map((row) => ({ kind: row.kind, inserted: row.metrics.insertedPauseSeconds, problems: row.problems })))}`);
    assert.equal(twice.pass, false);
    assert.ok(twice.pauses[0].pass, "最初の文の間（場面の間より前）は宣言どおり");
    const firstScene = twice.pauses.find((row) => row.kind === "scene");
    assert.ok(firstScene.problems.includes("pause-length-differs-from-declaration"), firstScene.problems.join(", "));
    assert.ok(Math.abs(firstScene.metrics.insertedPauseSeconds - 2 * GAP) <= PAUSE_LENGTH_TOLERANCE_FRAMES / FPS, JSON.stringify(firstScene.metrics));
    assert.ok(twice.pauses.slice(1).every((row) => !row.pass), "二重にした所から後ろは全部ずれる");
    // 壊した版 3: 間の途中で BGM が途切れた MP4（間を BGM ごと無音にした型）。
    const hole = pacing.pauses[1];
    const deadAir = join(temp, "pause-dead-air.mp4");
    await ff(toolchain, [
      "-i", outcome.artifacts.previewVideo.path, "-map", "0",
      "-af", `volume=enable='between(t,${(hole.pauseStartSeconds + 0.2).toFixed(3)},${(hole.pauseStartSeconds + 0.6).toFixed(3)})':volume=0`,
      "-c:v", "copy", "-c:s", "copy", "-c:a", "aac", "-b:a", "192k", deadAir,
    ]);
    const silent = await measure({ videoPath: deadAir });
    t.diagnostic(`BGM が途切れた版: ${JSON.stringify(silent.pauses.map((row) => row.metrics.bedLongestSilenceSeconds))}`);
    assert.ok(silent.problems.includes("dead-air-inside-declared-pause"), silent.problems.join(", "));
    // 壊した版 4: 間の中に語りの大きさの音がある MP4（stem の外で声が混ざった型。テイクを master の語りと同じ大きさで足す）。
    const leak = join(temp, "pause-speech-leak.mp4");
    await ff(toolchain, [
      "-i", outcome.artifacts.previewVideo.path, "-i", takeFor("p1.t1"),
      "-filter_complex", `[1:a]aresample=48000,volume=${masterGainDb.toFixed(3)}dB,adelay=${Math.round((hole.pauseStartSeconds + 0.2) * 1000)}:all=1[v];[0:a][v]amix=inputs=2:duration=first:normalize=0[a]`,
      "-map", "0:v", "-map", "[a]", "-map", "0:s", "-c:v", "copy", "-c:s", "copy", "-c:a", "aac", "-b:a", "192k", leak,
    ]);
    const leaked = await measure({ videoPath: leak });
    t.diagnostic(`間に語りの大きさの音がある版: ${JSON.stringify(leaked.pauses.map((row) => row.metrics.bedDeltaDb))}`);
    assert.ok(leaked.problems.includes("speech-level-audio-inside-declared-pause"), leaked.problems.join(", "));
    // 壊した版 5: 間の間も前の字幕を残した MP4（字幕の終わりを次の語りの始まりまで伸ばした）。
    const srt = (await readFile(outcome.artifacts.subtitles.path, "utf8")).split("\n");
    const extended = [];
    for (let index = 0; index < srt.length; index += 1) {
      const line = srt[index];
      if (/-->/u.test(line) && index < srt.length - 5) {
        const nextTime = srt.slice(index + 1).find((entry) => /-->/u.test(entry));
        extended.push(nextTime ? `${line.split(" --> ")[0]} --> ${nextTime.split(" --> ")[0]}` : line);
      } else extended.push(line);
    }
    const heldSrt = join(temp, "held.srt");
    await writeFile(heldSrt, extended.join("\n"), "utf8");
    const held = join(temp, "pause-caption-held.mp4");
    await ff(toolchain, ["-i", outcome.artifacts.previewVideo.path, "-i", heldSrt, "-map", "0:v", "-map", "0:a", "-map", "1:s", "-c:v", "copy", "-c:a", "copy", "-c:s", "mov_text", held]);
    const captions = await measure({ videoPath: held });
    assert.ok(captions.problems.includes("caption-inside-declared-pause"), captions.problems.join(", "));
    assert.ok(captions.problems.includes("caption-not-cleared-at-utterance-end"), captions.problems.join(", "));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("plan-only: 間より長い crossfade・範囲外の間は、Pack の不備として有料生成の前に止まる", {
  skip: toolchain.ok ? false : "ffmpeg/ffprobe is unavailable",
}, async () => {
  assert.ok(fontPath, "日本語の書体が見つからない");
  const temp = await mkdtemp(join(os.tmpdir(), "narrated-pacing-plan-"));
  try {
    const payloadDir = join(temp, "pack");
    const scriptPath = join(temp, "script-package.json");
    await writeFile(scriptPath, JSON.stringify(PACKAGE), "utf8");
    await acceptScriptForTests(scriptPath);
    await writePacingPack(payloadDir, { pacing: { sentenceGapSeconds: 0.3 } });
    const loaded = await loadNarratedStoryChannelConfig(payloadDir);
    assert.ok(loaded.blockers.includes("pacing.sceneGapSeconds-shorter-than-sceneTransition"), loaded.blockers.join(", "));
    const plan = await inspectNarratedStoryPlan({ scriptPath, channelPackDir: payloadDir });
    assert.ok(plan.blockers.includes("channel-pack-config-required:pacing.sceneGapSeconds-shorter-than-sceneTransition"), plan.blockers.join(", "));
    assert.equal(plan.paidCallsAttempted, false);
    await writePacingPack(payloadDir, { pacing: { sentenceGapSeconds: 4 } });
    const range = await inspectNarratedStoryPlan({ scriptPath, channelPackDir: payloadDir });
    assert.ok(range.blockers.includes("channel-pack-config-required:pacing.sentenceGapSeconds"), range.blockers.join(", "));
    // 宣言が無ければ間の要約は出ない（今までどおり）。
    await writePacingPack(payloadDir, { pacing: null });
    const none = await inspectNarratedStoryPlan({ scriptPath, channelPackDir: payloadDir });
    assert.equal(none.pacing, undefined);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
