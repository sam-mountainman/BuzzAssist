#!/usr/bin/env node

// 本編の場面の切り替え（Pack の sceneTransition。lib/narratedStorySceneTransitions.mjs）: 宣言したときだけ
// crossfade を入れ、尺を変えず、完成 MP4 のフレームで混ざり方を測る。宣言していなければ全部の切り替えが
// 混ざらない cut であることを測る。合成の画（模様の違う3枚）と FFmpeg だけで作る。有料 API は使わない。

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { extractNarratedChannelPackRuntime } from "../lib/harnessChannelPackRuntime.mjs";
import { resolveFfmpegToolchain } from "../lib/harnessRuntimeResolver.mjs";
import {
  REVIEWER_TRUST_PATH_ENV,
  REVIEWER_TRUST_VERSION,
  createReviewerTrustEntry,
  generateReviewerKeyPair,
} from "../lib/koyaReviewAttestation.mjs";
import { measureNarratedCameraMotion, normalizeNarratedCameraConfig, planNarratedCameraShots } from "../lib/narratedStoryCamera.mjs";
import { inspectNarratedStoryPlan } from "../lib/narratedStoryPipeline.mjs";
import {
  SCENE_CROSSFADE_RESIDUAL_MAX,
  SCENE_CROSSFADE_WEIGHT_TOLERANCE,
  SCENE_CUT_WEIGHT_MAX,
  inspectNarratedSceneVideoGraph,
  judgeSceneJoin,
  measureNarratedSceneTransitions,
  normalizeNarratedSceneTransitionConfig,
  planNarratedSceneJoins,
  renderNarratedSceneVideo,
  shotsOutsideSceneJoins,
} from "../lib/narratedStorySceneTransitions.mjs";
import { runNarratedStoryVideo } from "../lib/narratedStoryVideo.mjs";
import { runPastAssetLoops } from "./fixtures/narratedAssetLoopFixture.mjs";
import {
  bookendFixtureAdapters,
  bookendFixtureChannelConfig,
  createBookendFixtureMedia,
  passingVoiceQualityGate,
  writeBookendPackAssets,
} from "./fixtures/narratedBookendFixture.mjs";
import { ff, makeTexturedStill } from "./fixtures/narratedVisualFixture.mjs";
import { acceptScriptForTests } from "./helpers/scriptQualityAcceptance.mjs";

const execFile = promisify(execFileCallback);
const toolchain = await resolveFfmpegToolchain();
const RENDER = { width: 320, height: 180, fps: 24 };
const PART_ENCODE = ["-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-pix_fmt", "yuv420p"];
// 合成のカメラ（どのチャンネルの値でもない）。
const CAMERA_PACK = {
  moves: { "slow-push-in": { zoomPerSecond: 0.03, maxZoom: 1.15 }, "pan-left": { panPerSecond: 0.04, zoom: 1.12 } },
  sequence: ["slow-push-in", "pan-left"],
};
const CAMERA = normalizeNarratedCameraConfig(CAMERA_PACK).config;

test("Pack の宣言: 無ければ cut、crossfade は 0.1〜2 秒で fps で2フレーム以上、知らない欄は止める", () => {
  assert.deepEqual(normalizeNarratedSceneTransitionConfig(undefined, { fps: 24 }).config, { type: "cut", durationSeconds: 0, frames: 0, source: "core-default" });
  assert.deepEqual(normalizeNarratedSceneTransitionConfig({ type: "crossfade", durationSeconds: 0.5 }, { fps: 24 }).config, { type: "crossfade", durationSeconds: 0.5, frames: 12, source: "channel-pack" });
  assert.deepEqual(normalizeNarratedSceneTransitionConfig({ type: "cut" }, { fps: 24 }).blockers, []);
  for (const [source, expected] of [
    [{ type: "dissolve", durationSeconds: 0.5 }, "sceneTransition.type"],
    [{ type: "crossfade", durationSeconds: 5 }, "sceneTransition.durationSeconds"],
    [{ type: "crossfade" }, "sceneTransition.durationSeconds"],
    [{ type: "crossfade", durationSeconds: 0.1 }, "sceneTransition.durationSeconds-too-short-for-fps"],
    [{ type: "crossfade", durationSeconds: 0.5, curve: "ease" }, "sceneTransition.curve-unknown"],
    [{ type: "cut", durationSeconds: 1 }, "sceneTransition.durationSeconds"],
  ]) {
    const fps = expected.endsWith("too-short-for-fps") ? 12 : 24;
    assert.ok(normalizeNarratedSceneTransitionConfig(source, { fps }).blockers.includes(expected), `${JSON.stringify(source)} → ${expected}`);
  }
});

test("切り替えの計画: 重なりは場面の半分まで（混ざらないフレームを2つ残す）、短い場面の隣では縮め、2フレームに満たなければ cut のまま", () => {
  const shots = [
    { startFrame: 0, frames: 40 },
    { startFrame: 40, frames: 40 },
    { startFrame: 80, frames: 8 },
    { startFrame: 88, frames: 3 },
    { startFrame: 91, frames: 30 },
    { startFrame: 121, frames: 3 },
    { startFrame: 124, frames: 2 },
  ];
  const joins = planNarratedSceneJoins({ shots, transition: { type: "crossfade", frames: 12 } });
  assert.deepEqual(joins.map(({ cutFrame, type, frames, before, after, reduced }) => [cutFrame, type, frames, before, after, reduced || ""]), [
    [40, "crossfade", 12, 6, 6, ""],
    [80, "crossfade", 12, 9, 3, ""],
    [88, "crossfade", 3, 3, 0, "shots-too-short"],
    [91, "crossfade", 12, 0, 12, ""],
    [121, "crossfade", 12, 12, 0, ""],
    [124, "cut", 0, 0, 0, "shots-too-short"],
  ]);
  // どの場面にも、どちらの切り替えにも混ざらないフレームが2つ以上残る。
  for (const [index, shot] of shots.entries()) {
    const head = joins[index - 1]?.type === "crossfade" ? joins[index - 1].after : 0;
    const tail = joins[index]?.type === "crossfade" ? joins[index].before : 0;
    assert.ok(shot.frames - head - tail >= 2, `shot ${index}`);
  }
  assert.ok(planNarratedSceneJoins({ shots, transition: { type: "cut", frames: 0 } }).every((join) => join.type === "cut"));
  // 計画に無い xfade・宣言より長い xfade は graph の検査で落ちる。
  const planned = planNarratedSceneJoins({ shots: shots.slice(0, 2), transition: { type: "crossfade", frames: 12 } });
  const graph = (duration) => ({ chunks: [{ filterGraph: `[u0][u1]xfade=transition=fade:duration=${duration}:offset=1.416667[video]`, unitIds: ["a", "b"] }] });
  assert.equal(inspectNarratedSceneVideoGraph(graph("0.500000"), { shotCount: 2, joins: planned, fps: 24 }).ok, true);
  assert.deepEqual(inspectNarratedSceneVideoGraph(graph("1.000000"), { shotCount: 2, joins: planned, fps: 24 }).problems, ["crossfades-differ-from-plan"]);
  assert.deepEqual(inspectNarratedSceneVideoGraph(graph("0.500000"), { shotCount: 2, joins: [], fps: 24 }).problems, ["crossfades-differ-from-plan"]);
});

test("混ざり具合の判定（純粋関数）: 計画どおりに混ざった重なりは通り、混ざらない切り替え・混ざった cut は落ちる", () => {
  const size = 96 * 54;
  const a = Uint8Array.from({ length: size }, (_, index) => 40 + (index % 7) * 20);
  const b = Uint8Array.from({ length: size }, (_, index) => 200 - (index % 5) * 25);
  const mix = (w) => Uint8Array.from(a, (value, index) => Math.round((1 - w) * value + w * b[index]));
  const join = { type: "crossfade", cutFrame: 10, frames: 4, before: 2, after: 2 };
  // frames[0] = 7（重なりの前の A）… frames[5] = 12（重なりの後の B）
  const good = [a, mix(0), mix(0.25), mix(0.5), mix(0.75), b];
  assert.equal(judgeSceneJoin(join, good, 7).pass, true);
  const hard = [a, a, a, b, b, b];
  assert.ok(judgeSceneJoin(join, hard, 7).problems.includes("crossfade-weight-differs-from-plan"));
  const cut = { type: "cut", cutFrame: 10, frames: 0, before: 0, after: 0 };
  assert.equal(judgeSceneJoin(cut, [a, a, b, b], 8).pass, true);
  assert.ok(judgeSceneJoin(cut, [a, mix(0.4), mix(0.6), b], 8).problems.includes("cut-shows-blended-frames"));
  assert.equal(judgeSceneJoin(cut, [a, a, a, a], 8).indistinguishable, true);
});

async function program(dir, name, shots, transition) {
  const part = join(dir, `${name}-part.mp4`);
  const rendered = await renderNarratedSceneVideo({ ffmpeg: toolchain.ffmpeg, shots, transition, render: RENDER, outputPath: part, encode: PART_ENCODE });
  // 番組の組み立てと同じく、もう1回符号化した MP4 を測る。
  const output = join(dir, `${name}.mp4`);
  await ff(toolchain, ["-i", part, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", output]);
  return { output, rendered };
}

async function frameCount(file) {
  const { stdout } = await execFile(toolchain.ffprobe.command, [...(toolchain.ffprobe.args || []), "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", file]);
  return Number(stdout.trim());
}

test("完成 MP4 で測る: 宣言した crossfade は計画のフレームで線形に混ざり尺は cut と同じ、描かない・半分の長さ・宣言せずに描いた版は落ちる", {
  skip: toolchain.ok ? false : "ffmpeg is unavailable",
}, async (t) => {
  const dir = await mkdtemp(join(os.tmpdir(), "narrated-scene-transitions-"));
  try {
    const stills = [];
    for (let index = 0; index < 3; index += 1) {
      const still = join(dir, `scene-${index}.png`);
      await makeTexturedStill(toolchain, still, { width: 640, height: 360, phase: index * 23 });
      stills.push(still);
    }
    const segments = [0, 1, 2, 0].map((image, index) => ({ id: `p${index + 1}`, imageKey: `p${index + 1}`, imagePath: stills[image], startFrame: index * 36, frames: 36 }));
    const shots = planNarratedCameraShots({ segments, camera: CAMERA, fps: RENDER.fps }).shots;
    const crossfade = normalizeNarratedSceneTransitionConfig({ type: "crossfade", durationSeconds: 0.5 }, { fps: RENDER.fps }).config;
    const joins = planNarratedSceneJoins({ shots, transition: crossfade });
    const cutJoins = planNarratedSceneJoins({ shots, transition: null });
    assert.deepEqual(joins.map((join) => [join.type, join.frames, join.before, join.after]), [["crossfade", 12, 6, 6], ["crossfade", 12, 6, 6], ["crossfade", 12, 6, 6]]);

    const faded = await program(dir, "faded", shots, crossfade);
    const plain = await program(dir, "plain", shots, null);
    assert.equal(faded.rendered.frames, 144);
    assert.equal(await frameCount(faded.output), 144, "crossfade を入れても尺は同じ");
    assert.equal(await frameCount(plain.output), 144);

    const good = await measureNarratedSceneTransitions({ ffmpeg: toolchain.ffmpeg, videoPath: faded.output, joins, render: RENDER });
    t.diagnostic(`基準版: ${JSON.stringify(good.joins.map((row) => ({ contrast: row.contrast, maxWeightError: row.maxWeightError, maxResidual: row.maxResidual })))}`);
    assert.equal(good.pass, true, JSON.stringify(good.joins));
    assert.equal(good.crossfadeCount, 3);
    for (const row of good.joins) {
      assert.ok(row.maxWeightError <= SCENE_CROSSFADE_WEIGHT_TOLERANCE / 2, `${row.cutFrame}: ${row.maxWeightError}`);
      assert.ok(row.maxResidual <= SCENE_CROSSFADE_RESIDUAL_MAX, `${row.cutFrame}: ${row.maxResidual}`);
    }
    const cuts = await measureNarratedSceneTransitions({ ffmpeg: toolchain.ffmpeg, videoPath: plain.output, joins: cutJoins, render: RENDER });
    t.diagnostic(`cut の基準版: ${JSON.stringify(cuts.joins.map((row) => row.samples))}`);
    assert.equal(cuts.pass, true, JSON.stringify(cuts.joins));
    assert.ok(cuts.joins.every((row) => row.samples.every((sample) => Math.abs(sample.weight - sample.expected) <= SCENE_CUT_WEIGHT_MAX / 2)));

    // 壊した版 1: crossfade を宣言したのに描いていない（cut の MP4 を crossfade の計画で測る）。
    const missing = await measureNarratedSceneTransitions({ ffmpeg: toolchain.ffmpeg, videoPath: plain.output, joins, render: RENDER });
    t.diagnostic(`描かない版: ${JSON.stringify(missing.joins.map((row) => ({ maxWeightError: row.maxWeightError, maxResidual: row.maxResidual })))}`);
    assert.equal(missing.pass, false);
    assert.ok(missing.problems.includes("crossfade-weight-differs-from-plan"));
    // 壊した版 2: 宣言の半分の長さで描いた。
    const half = await program(dir, "half", shots, { type: "crossfade", frames: 6 });
    const short = await measureNarratedSceneTransitions({ ffmpeg: toolchain.ffmpeg, videoPath: half.output, joins, render: RENDER });
    t.diagnostic(`半分の長さの版: ${JSON.stringify(short.joins.map((row) => ({ maxWeightError: row.maxWeightError, maxResidual: row.maxResidual })))}`);
    assert.equal(short.pass, false);
    // 壊した版 3: 宣言していないのに crossfade を描いた（cut の計画で測る）。
    const undeclared = await measureNarratedSceneTransitions({ ffmpeg: toolchain.ffmpeg, videoPath: faded.output, joins: cutJoins, render: RENDER });
    t.diagnostic(`宣言せずに描いた版: ${JSON.stringify(undeclared.joins.map((row) => row.samples))}`);
    assert.equal(undeclared.pass, false);
    assert.ok(undeclared.problems.includes("cut-shows-blended-frames"));

    // カメラの測定は重なりのフレームを外せば crossfade の版でも計画どおり。
    const camera = await measureNarratedCameraMotion({ ffmpeg: toolchain.ffmpeg, videoPath: faded.output, shots: shotsOutsideSceneJoins(shots, joins), camera: CAMERA, render: RENDER });
    assert.equal(camera.pass, true, JSON.stringify(camera.shots.map((shot) => [shot.id, shot.problems])));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** 場面ごとに模様の違う画を返す fixture の adapter（台本の場面 id の番号で3枚を回す）。 */
function distinctSceneAdapters(fixture, images) {
  const base = bookendFixtureAdapters(fixture);
  return {
    ...base,
    mediaJobRunner: async (spec) => {
      const result = await base.mediaJobRunner(spec);
      if (spec.kind !== "image.generation") return result;
      const bytes = images[Number(String(spec.input?.segmentId || "").replace(/\D/gu, "") || 0) % images.length];
      const { createHash } = await import("node:crypto");
      return { ...result, bytes, receipt: { ...result.receipt, artifact: { ...result.receipt.artifact, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length } } };
    },
  };
}

test("公式経路: Pack が crossfade を宣言した番組は、本編の切り替えが完成 MP4 で計画どおりに混ざり、尺・カメラ・境目の監査も通る（plan-only は不正な宣言で止まる）", {
  skip: toolchain.ok ? false : "ffmpeg/ffprobe is unavailable",
}, async () => {
  const temp = await mkdtemp(join(os.tmpdir(), "narrated-scene-transition-pipeline-"));
  try {
    const reviewer = generateReviewerKeyPair();
    const trustPath = join(temp, "trust.json");
    await writeFile(trustPath, JSON.stringify({ version: REVIEWER_TRUST_VERSION, reviewers: [createReviewerTrustEntry({ publicKeyPem: reviewer.publicKeyPem, label: "scene transition fixture" })] }));
    const fixture = await createBookendFixtureMedia(join(temp, "fixture-media"), toolchain);
    const images = [];
    for (let index = 0; index < 3; index += 1) {
      const still = join(temp, `distinct-${index}.png`);
      await makeTexturedStill(toolchain, still, { width: 320, height: 180, phase: index * 23 });
      images.push(await readFile(still));
    }
    const payloadDir = join(temp, "pack");
    await mkdir(payloadDir, { recursive: true });
    await writeBookendPackAssets(payloadDir, toolchain);
    const config = { ...bookendFixtureChannelConfig(), camera: CAMERA_PACK, sceneTransition: { type: "crossfade", durationSeconds: 0.25 } };
    await writeFile(join(payloadDir, "narrated-story.json"), JSON.stringify(config, null, 2), "utf8");
    const scriptPath = join(temp, "script.txt");
    await writeFile(scriptPath, `${["最初の物語です。", "次の場面です。", "三つ目の場面です。", "終わりの場面です。", "---感想---", "感想の一文目です。", "感想の二文目です。"].join("\n")}\n`, "utf8");
    await acceptScriptForTests(scriptPath);
    const adapters = distinctSceneAdapters(fixture, images);
    const outcome = await runPastAssetLoops(() => runNarratedStoryVideo({
      command: "full",
      scriptPath,
      channelPackDir: payloadDir,
      jobId: "video-narrated-story-video-5cenefade0000001",
      jobIdentityDigest: "f".repeat(64),
      deploymentRoot: join(temp, "run"),
      mediaJobRunner: adapters.mediaJobRunner,
      mediaJobProbe: adapters.mediaJobProbe,
      ffmpegToolchain: toolchain,
      voiceQualityGate: passingVoiceQualityGate,
      env: { ...process.env, [REVIEWER_TRUST_PATH_ENV]: trustPath },
    }, { allowDirectUnboundJobForTests: true }));
    assert.equal(outcome.status, "awaiting-human-review", JSON.stringify(outcome.knownRemainingIssues));
    const exempt = new Set(["perceptualReviewChecks", "perceptualReviewBoundToOutput", "perceptualEvidenceHashes", "contactSheetOriginalDetailReviewed", "qualityLoopPassed", "characterIdentityReviewed"]);
    for (const [auditId, value] of Object.entries(outcome.auditChecks)) {
      if (exempt.has(auditId)) continue;
      assert.equal(value.pass, true, `${auditId}: ${value.detail}`);
    }
    const measured = outcome.auditChecks.sceneTransitionMeasured.measurement;
    assert.equal(measured.crossfadeCount, 3, JSON.stringify(measured.joins));
    assert.equal(measured.indistinguishableCount, 0);
    const manifest = JSON.parse(await readFile(outcome.artifacts.generationManifest.path, "utf8"));
    assert.equal(manifest.sceneTransitions.type, "crossfade");
    assert.deepEqual(manifest.sceneTransitions.joins.map((join) => [join.type, join.frames]), [["crossfade", 6], ["crossfade", 6], ["crossfade", 6]]);
    assert.equal(await frameCount(outcome.artifacts.previewVideo.path), manifest.bookends.totalFrames, "crossfade を入れても番組のフレーム数は計画どおり");

    // 不正な宣言は有料生成の前（plan-only でも）に止まり、durable Job へ持ち込む形の検査も知らない欄を止める。
    await writeFile(join(payloadDir, "narrated-story.json"), JSON.stringify({ ...config, sceneTransition: { type: "crossfade", durationSeconds: 0.05 } }), "utf8");
    const plan = await inspectNarratedStoryPlan({ scriptPath, channelPackDir: payloadDir });
    assert.ok(plan.blockers.includes("channel-pack-config-required:sceneTransition.durationSeconds"), plan.blockers.join(", "));
    await writeFile(join(payloadDir, "narrated-story.json"), JSON.stringify({ ...config, sceneTransition: { type: "crossfade", durationSeconds: 0.5, glow: true } }), "utf8");
    await assert.rejects(extractNarratedChannelPackRuntime({ payloadDir, evidence: { harnessId: "narrated-story-video", payloadSha256: "d".repeat(64) } }), /sceneTransition contains unsupported fields: glow/u);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
