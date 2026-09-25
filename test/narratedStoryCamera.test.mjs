#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveFfmpegToolchain } from "../lib/harnessRuntimeResolver.mjs";
import {
  CAMERA_ANALYSIS_WIDTH,
  CAMERA_SCALE_TOLERANCE,
  CAMERA_SHIFT_TOLERANCE_PX,
  cameraEase,
  cameraPerspectiveFilter,
  cameraRectAt,
  cameraShotChains,
  composeSimilarities,
  estimateSimilarity,
  groupNarratedCameraShots,
  measureNarratedCameraMotion,
  normalizeNarratedCameraConfig,
  planCameraMove,
  planNarratedCameraShots,
  predictedSimilarity,
} from "../lib/narratedStoryCamera.mjs";
import { ff, makeTexturedStill } from "./fixtures/narratedVisualFixture.mjs";

const toolchain = await resolveFfmpegToolchain();
const RENDER = { width: 640, height: 360, fps: 24 };

// 合成の Pack の宣言（どのチャンネルの値でもない。測れるように速めにしてある）。
const PACK_CAMERA = {
  moves: {
    "slow-push-in": { zoomPerSecond: 0.02, maxZoom: 1.12 },
    "slow-pull-out": { zoomPerSecond: 0.02, maxZoom: 1.12 },
    "pan-left": { panPerSecond: 0.03, zoom: 1.1 },
    "pan-right": { panPerSecond: 0.03, zoom: 1.1 },
    static: {},
  },
  sequence: ["slow-push-in", "pan-right", "slow-pull-out", "pan-left", "static"],
};

test("Pack の camera: 型・速さ・上限・順番を宣言し、ゆっくりの範囲を越える値と知らない欄は止める。無ければ Core の既定", () => {
  const ok = normalizeNarratedCameraConfig(PACK_CAMERA);
  assert.deepEqual(ok.blockers, []);
  assert.equal(ok.config.source, "channel-pack");
  assert.equal(ok.config.easing.kind, "linear");
  const fallback = normalizeNarratedCameraConfig(undefined);
  assert.equal(fallback.config.source, "core-default");
  assert.deepEqual(fallback.config.sequence, ["slow-push-in"]);
  // Core の既定で描く式に数でない値が入らない（焦点の既定が抜けると perspective が止まる）。
  const defaultShot = planNarratedCameraShots({ segments: [{ id: "a", imageKey: "a", startFrame: 0, frames: 18 }], camera: fallback.config, fps: 24 }).shots[0];
  assert.doesNotMatch(cameraPerspectiveFilter(defaultShot), /NaN|undefined/u);
  const { blockers } = normalizeNarratedCameraConfig({
    moves: { "slow-push-in": { zoomPerSecond: 0.2, maxZoom: 3, tilt: 1 }, "whip-pan": {} },
    sequence: ["slow-push-in", "pan-left"],
    easing: { kind: "ease-in-out", linearShare: 0.1 },
    shake: true,
  });
  for (const expected of [
    "camera.shake-unknown",
    "camera.moves.slow-push-in.zoomPerSecond",
    "camera.moves.slow-push-in.maxZoom",
    "camera.moves.slow-push-in.tilt-unknown",
    "camera.moves.whip-pan-unknown",
    "camera.sequence.pan-left-undeclared",
    "camera.easing.linearShare",
  ]) assert.ok(blockers.includes(expected), `${expected}: ${blockers.join(", ")}`);
});

test("ショット: 同じ画が続く文（話者ごとに分けた場面）は1つのショットにまとめ、動きを通しで続ける（向きを文ごとに交互にしない）", () => {
  const camera = normalizeNarratedCameraConfig(PACK_CAMERA).config;
  const segments = [
    { id: "p1", imageKey: "p1", startFrame: 0, frames: 20 },
    { id: "p2.t1", imageKey: "p2", startFrame: 20, frames: 10 },
    { id: "p2.t2", imageKey: "p2", startFrame: 30, frames: 14 },
    { id: "p2.t3", imageKey: "p2", startFrame: 44, frames: 12 },
    { id: "p3", imageKey: "p3", startFrame: 56, frames: 24, cameraMove: "static" },
  ];
  assert.equal(groupNarratedCameraShots(segments).length, 3);
  const plan = planNarratedCameraShots({ segments, camera, fps: 24 });
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(plan.shots.map((shot) => [shot.move, shot.frames, shot.segmentIds.length]), [["slow-push-in", 20, 1], ["pan-right", 36, 3], ["static", 24, 1]]);
  assert.deepEqual(plan.shots[1].cutFrames, [30, 44]);
  // 台本パッケージが指定した型を使い、Pack に無い型は止める。
  assert.equal(plan.shots[2].requested, true);
  const undeclared = planNarratedCameraShots({ segments: [{ id: "x", imageKey: "x", startFrame: 0, frames: 10, cameraMove: "pan-left" }], camera: normalizeNarratedCameraConfig({ moves: { static: {} }, sequence: ["static"] }).config, fps: 24 });
  assert.deepEqual(undeclared.problems, ["camera-move-undeclared:x"]);
  // 1つのショットの中では、見せる範囲が単調に動く（文の境目で戻らない）。
  const shot = plan.shots[1];
  const lefts = Array.from({ length: shot.frames }, (_, frame) => cameraRectAt(shot, frame).left);
  for (let index = 1; index < lefts.length; index += 1) assert.ok(lefts[index] > lefts[index - 1], `pan moves monotonically at frame ${index}`);
});

test("動きの量: 長いショットは上限に届くよう速さを落とし（止めない）、緩急を付けても等速の分を残す", () => {
  const push = planCameraMove("slow-push-in", { zoomPerSecond: 0.02, maxZoom: 1.12, focusX: 0.5, focusY: 0.5 }, 2);
  assert.ok(Math.abs(push.to.zoom - 1.02 ** 2) < 1e-9);
  const longPush = planCameraMove("slow-push-in", { zoomPerSecond: 0.02, maxZoom: 1.12, focusX: 0.5, focusY: 0.5 }, 60);
  assert.equal(longPush.to.zoom, 1.12);
  const pan = planCameraMove("pan-left", { panPerSecond: 0.03, zoom: 1.1, focusY: 0.5 }, 100);
  assert.ok(Math.abs((pan.from.centerX - pan.to.centerX) - (1 - 1 / 1.1)) < 1e-9, "pan travel is capped by the margin");
  assert.ok(pan.to.centerX < pan.from.centerX, "pan-left moves the view to the left");
  const ease = { kind: "ease-in-out", linearShare: 0.5 };
  assert.equal(cameraEase(0, ease), 0);
  assert.equal(cameraEase(1, ease), 1);
  // 始まりの傾きは等速の分（0.5）で、0 にならない。
  assert.ok(cameraEase(0.01, ease) / 0.01 >= 0.49);
  assert.match(cameraPerspectiveFilter({ frames: 10, from: push.from, to: push.to, easing: { kind: "linear", linearShare: 1 } }), /^perspective=x0='.*eval=frame$/u);
});

test("相似変換の推定: 合成の拡大と移動を画素から取り戻し、区間をつなぐと全体になる", () => {
  const width = 96;
  const height = 54;
  const pattern = (x, y) => 128 + 60 * Math.sin(x / 6.1) * Math.cos(y / 5.3) + 40 * Math.sin((x + 2 * y) / 11.3);
  const a = new Float32Array(width * height);
  const b = new Float32Array(width * height);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const scale = 0.985;
  const tx = 1.7;
  const ty = -0.9;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      a[y * width + x] = pattern(x, y);
      b[y * width + x] = pattern(scale * (x - cx) + cx + tx, scale * (y - cy) + cy + ty);
    }
  }
  const estimated = estimateSimilarity(a, b, width, height);
  assert.ok(Math.abs(estimated.scale - scale) < 0.002, `scale ${estimated.scale}`);
  assert.ok(Math.abs(estimated.dx - (tx + cx - scale * cx)) < 0.1, `dx ${estimated.dx}`);
  assert.ok(Math.abs(estimated.dy - (ty + cy - scale * cy)) < 0.1, `dy ${estimated.dy}`);
  const composed = composeSimilarities([{ scale: 0.99, dx: 1, dy: 0 }, { scale: 0.98, dx: 2, dy: 1 }]);
  assert.ok(Math.abs(composed.scale - 0.99 * 0.98) < 1e-12);
  assert.ok(Math.abs(composed.dx - (1 + 0.99 * 2)) < 1e-12);
  const shot = { frames: 25, from: { zoom: 1, centerX: 0.5, centerY: 0.5 }, to: { zoom: 1.1, centerX: 0.5, centerY: 0.5 }, easing: { kind: "linear", linearShare: 1 } };
  const whole = predictedSimilarity(shot, 0, 24, 192, 108);
  const halves = composeSimilarities([predictedSimilarity(shot, 0, 12, 192, 108), predictedSimilarity(shot, 12, 24, 192, 108)]);
  assert.ok(Math.abs(whole.scale - halves.scale) < 1e-12 && Math.abs(whole.dx - halves.dx) < 1e-9, "planned sections compose to the whole");
});

async function renderShots(dir, shots, name) {
  const { inputs, chains, labels } = cameraShotChains({ shots, render: RENDER });
  const output = join(dir, name);
  const frames = shots.reduce((sum, shot) => sum + shot.frames, 0);
  await ff(toolchain, [...inputs, "-filter_complex", `${chains.join(";")};${labels.join("")}concat=n=${labels.length}:v=1:a=0[v]`, "-map", "[v]", "-frames:v", String(frames), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", output]);
  return output;
}

for (const easing of [{ kind: "linear" }, { kind: "ease-in-out", linearShare: 0.5 }]) {
  test(`カメラの実測（${easing.kind}）: 完成 MP4 のフレームで、全部の型の動きが計画どおりに測れ、止めた・逆にした・文の境目で始め直した版は落ちる`, {
    skip: toolchain.ok ? false : "ffmpeg is unavailable",
  }, async () => {
    const dir = await mkdtemp(join(os.tmpdir(), "narrated-camera-"));
    try {
      const still = join(dir, "still.png");
      await makeTexturedStill(toolchain, still, RENDER);
      const camera = normalizeNarratedCameraConfig({ ...PACK_CAMERA, easing }).config;
      const segments = [
        { id: "a1", imageKey: "a", imagePath: still, startFrame: 0, frames: 30 },
        { id: "a2", imageKey: "a", imagePath: still, startFrame: 30, frames: 30 },
        { id: "b1", imageKey: "b", imagePath: still, startFrame: 60, frames: 60 },
        { id: "c1", imageKey: "c", imagePath: still, startFrame: 120, frames: 48 },
        { id: "d1", imageKey: "d", imagePath: still, startFrame: 168, frames: 48 },
        { id: "e1", imageKey: "e", imagePath: still, startFrame: 216, frames: 24 },
      ];
      const plan = planNarratedCameraShots({ segments, camera, fps: RENDER.fps });
      const measure = async (videoPath) => measureNarratedCameraMotion({ ffmpeg: toolchain.ffmpeg, videoPath, shots: plan.shots, camera, render: RENDER });

      const good = await measure(await renderShots(dir, plan.shots, "good.mp4"));
      assert.equal(good.pass, true, JSON.stringify(good.shots.map((shot) => [shot.id, shot.problems])));
      assert.equal(good.analysis.width, CAMERA_ANALYSIS_WIDTH);
      for (const shot of good.shots) {
        for (const interval of shot.intervals) {
          assert.ok(interval.scaleError <= CAMERA_SCALE_TOLERANCE && interval.shiftError <= CAMERA_SHIFT_TOLERANCE_PX, `${shot.id} ${interval.kind}`);
        }
      }
      const pan = good.shots.find((shot) => shot.move === "pan-right");
      assert.ok(pan.rates.panPerSecond > 0.02 && pan.rates.panPerSecond <= 0.03 * 1.1, `measured pan speed ${pan.rates.panPerSecond}`);

      // 壊した版 1: 動かさない。
      const frozen = await measure(await renderShots(dir, plan.shots.map((shot) => ({ ...shot, to: shot.from })), "frozen.mp4"));
      assert.equal(frozen.pass, false);
      assert.deepEqual(frozen.shots.filter((shot) => !shot.pass).map((shot) => shot.move).sort(), ["pan-left", "pan-right", "slow-pull-out", "slow-push-in"]);
      // 壊した版 2: 逆へ動かす。
      const reversed = await measure(await renderShots(dir, plan.shots.map((shot) => ({ ...shot, from: shot.to, to: shot.from })), "reversed.mp4"));
      assert.equal(reversed.pass, false);
      assert.ok(reversed.problems.some((problem) => problem.startsWith("whole:")));
      // 壊した版 3: 話者ごとに分けた場面で、文ごとに動きを始め直す（従来の不具合の型）。
      const restarted = planNarratedCameraShots({ segments: segments.map((segment) => ({ ...segment, imageKey: segment.id })), camera: { ...camera, sequence: ["slow-push-in", "slow-push-in", "pan-right", "slow-pull-out", "pan-left", "static"] }, fps: RENDER.fps });
      const restart = await measure(await renderShots(dir, restarted.shots, "restart.mp4"));
      assert.equal(restart.pass, false);
      assert.ok(restart.shots[0].problems.some((problem) => problem.startsWith("cut:")), restart.shots[0].problems.join(", "));
      // 壊した版 4: 宣言の倍の速さで寄る（計画にも合わず、宣言の速さも越える）。
      const fast = await measure(await renderShots(dir, plan.shots.map((shot) => (shot.move === "slow-push-in" ? { ...shot, to: { ...shot.to, zoom: shot.to.zoom ** 2 } } : shot)), "fast.mp4"));
      assert.equal(fast.pass, false);
      assert.ok(fast.shots[0].problems.includes("zoom-faster-than-declared"), fast.shots[0].problems.join(", "));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
