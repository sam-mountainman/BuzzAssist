#!/usr/bin/env node

// 場面ごとの焦点（台本パッケージの本編の場面の cameraFocus）: 計画・余白・食い違い・完成 MP4 の実測。
// 画は合成の模様（test/fixtures/narratedVisualFixture.mjs）。どのチャンネルの値でもない。

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveFfmpegToolchain } from "../lib/harnessRuntimeResolver.mjs";
import {
  CAMERA_FOCUS_SCALE_TOLERANCE,
  CAMERA_FOCUS_SHIFT_TOLERANCE_PX,
  cameraRectAt,
  cameraShotChains,
  groupNarratedCameraShots,
  judgeCameraFocusView,
  measureNarratedCameraFocus,
  measureNarratedCameraMotion,
  narratedCameraFocusConflicts,
  narratedCameraManifestEntry,
  normalizeNarratedCameraConfig,
  normalizeNarratedCameraFocus,
  planCameraMove,
  planNarratedCameraShots,
} from "../lib/narratedStoryCamera.mjs";
import { ff, makeTexturedStill } from "./fixtures/narratedVisualFixture.mjs";

const toolchain = await resolveFfmpegToolchain();
const RENDER = { width: 640, height: 360, fps: 24 };
const EPSILON = 1e-12;

// 合成の Pack の宣言（測れるように速めにしてある）。small は運営者の見本のような 1.010 倍の寄り。
const PACKS = {
  small: {
    moves: {
      "slow-push-in": { zoomPerSecond: 0.02, maxZoom: 1.01 },
      "slow-pull-out": { zoomPerSecond: 0.02, maxZoom: 1.01 },
      "pan-right": { panPerSecond: 0.005, zoom: 1.02 },
      "pan-left": { panPerSecond: 0.005, zoom: 1.02 },
      static: { zoom: 1.01 },
    },
    sequence: ["slow-push-in"],
  },
  large: {
    moves: {
      "slow-push-in": { zoomPerSecond: 0.03, maxZoom: 1.12 },
      "slow-pull-out": { zoomPerSecond: 0.03, maxZoom: 1.12 },
      "pan-right": { panPerSecond: 0.02, zoom: 1.1 },
      "pan-left": { panPerSecond: 0.02, zoom: 1.1 },
      static: { zoom: 1.06 },
    },
    sequence: ["slow-push-in"],
  },
};

test("焦点の欄: 0〜1 の数の x・y だけを受け、文字列・範囲外・知らない欄・欠けは止める。無ければ指定なし", () => {
  assert.deepEqual(normalizeNarratedCameraFocus(undefined), { focus: null, problem: "" });
  assert.deepEqual(normalizeNarratedCameraFocus({ x: 0, y: 1 }), { focus: { x: 0, y: 1 }, problem: "" });
  assert.deepEqual(normalizeNarratedCameraFocus({ x: 0.31, y: 0.42 }).focus, { x: 0.31, y: 0.42 });
  for (const [value, problem] of [
    [null, "cameraFocus"],
    [[0.3, 0.4], "cameraFocus"],
    ["0.3,0.4", "cameraFocus"],
    [{ x: "0.3", y: 0.4 }, "cameraFocus.x"],
    [{ x: 1.2, y: 0.4 }, "cameraFocus.x"],
    [{ x: 0.3, y: -0.1 }, "cameraFocus.y"],
    [{ x: 0.3 }, "cameraFocus.y"],
    [{ x: 0.3, y: Number.NaN }, "cameraFocus.y"],
    [{ x: 0.3, y: 0.4, zoom: 1.2 }, "cameraFocus.zoom-unknown"],
  ]) assert.equal(normalizeNarratedCameraFocus(value).problem, problem, JSON.stringify(value));
});

test("後方互換: 焦点の無い場面は、今までどおり Pack の型ごとの焦点で動く（計画も生成記録の形も変わらない）", () => {
  const camera = normalizeNarratedCameraConfig({
    moves: {
      "slow-push-in": { zoomPerSecond: 0.02, maxZoom: 1.08, focusX: 0.4, focusY: 0.35 },
      "pan-right": { panPerSecond: 0.01, zoom: 1.08, focusY: 0.45 },
      static: { zoom: 1.05 },
    },
    sequence: ["slow-push-in", "pan-right", "static"],
  }).config;
  const push = planCameraMove("slow-push-in", camera.moves["slow-push-in"], 3);
  assert.deepEqual(push.to, { zoom: 1.02 ** 3, centerX: 0.4, centerY: 0.35 });
  assert.deepEqual(push.from, { zoom: 1, centerX: 0.5, centerY: 0.5 });
  const pan = planCameraMove("pan-right", camera.moves["pan-right"], 2);
  assert.ok(Math.abs(pan.from.centerX + pan.to.centerX - 1) < EPSILON, "the pan is centered on the middle of the image");
  assert.equal(pan.from.centerY, 0.45);
  assert.deepEqual(planCameraMove("static", camera.moves.static, 2).from, { zoom: 1.05, centerX: 0.5, centerY: 0.5 });
  const segments = [
    { id: "a", imageKey: "a", startFrame: 0, frames: 24 },
    { id: "b", imageKey: "b", startFrame: 24, frames: 24 },
    { id: "c", imageKey: "c", startFrame: 48, frames: 24 },
  ];
  const plan = planNarratedCameraShots({ segments, camera, fps: 24 });
  assert.deepEqual(plan.problems, []);
  for (const shot of plan.shots) {
    assert.equal("focus" in shot, false);
    assert.equal("requestedFocus" in shot, false);
  }
  for (const entry of narratedCameraManifestEntry(plan, camera).shots) assert.equal("focus" in entry, false);
});

test("焦点の効き方: 寄り・引きは寄った端の中心、パンは縦の中心と道のりの中ほど、static は中心。生成記録に焦点が残る", () => {
  const camera = normalizeNarratedCameraConfig(PACKS.large).config;
  const focus = { x: 0.3, y: 0.62 };
  const push = planCameraMove("slow-push-in", camera.moves["slow-push-in"], 2, focus);
  assert.deepEqual([push.to.centerX, push.to.centerY], [0.3, 0.62]);
  assert.deepEqual([push.from.centerX, push.from.centerY], [0.5, 0.5]);
  const pull = planCameraMove("slow-pull-out", camera.moves["slow-pull-out"], 2, focus);
  assert.deepEqual([pull.from.centerX, pull.from.centerY], [0.3, 0.62]);
  // パン: 道のり 0.02/1.1*1 = 0.0182、余白 1-1/1.1 = 0.0909。中ほどは 0.5 ± (0.0909-0.0182)/2 の中へ寄せる。
  const pan = planCameraMove("pan-right", camera.moves["pan-right"], 1, focus);
  const middle = (pan.from.centerX + pan.to.centerX) / 2;
  const slack = (1 - 1 / 1.1 - 0.02 / 1.1) / 2;
  assert.ok(Math.abs(middle - (0.5 - slack)) < 1e-9, `pan middle ${middle}`);
  assert.equal(pan.from.centerY, 0.62);
  assert.ok(Math.abs(pan.to.centerX - pan.from.centerX - 0.02 / 1.1) < 1e-9, "the pan travel does not change with the focus");
  const inside = planCameraMove("pan-left", camera.moves["pan-left"], 1, { x: 0.52, y: 0.5 });
  assert.ok(Math.abs((inside.from.centerX + inside.to.centerX) / 2 - 0.52) < 1e-9, "a focus inside the slack is used as is");
  const still = planCameraMove("static", camera.moves.static, 1, focus);
  assert.deepEqual([still.from.centerX, still.from.centerY, still.from.zoom], [0.3, 0.62, 1.06]);
  const plan = planNarratedCameraShots({
    segments: [{ id: "s1", imageKey: "s1", startFrame: 0, frames: 24, cameraMove: "pan-right", cameraFocus: focus }],
    camera,
    fps: 24,
  });
  assert.deepEqual(plan.shots[0].focus, { x: 0.3, y: 0.62, source: "script-package" });
  assert.deepEqual(narratedCameraManifestEntry(plan, camera).shots[0].focus, { x: 0.3, y: 0.62, source: "script-package" });
});

test("余白: 焦点が画の端・角でも、どの型のどのフレームも見せる範囲は画の中。パンは端に当たって止まらず毎フレーム進む", () => {
  const corners = [0, 0.02, 0.5, 0.98, 1];
  for (const maxZoom of [1.01, 1.08, 1.3]) {
    const camera = normalizeNarratedCameraConfig({
      moves: {
        "slow-push-in": { zoomPerSecond: 0.03, maxZoom },
        "slow-pull-out": { zoomPerSecond: 0.03, maxZoom },
        "pan-left": { panPerSecond: 0.02, zoom: Math.max(1.02, maxZoom) },
        "pan-right": { panPerSecond: 0.02, zoom: Math.max(1.02, maxZoom) },
        static: { zoom: maxZoom },
      },
      sequence: ["slow-push-in"],
      easing: { kind: "ease-in-out", linearShare: 0.5 },
    }).config;
    for (const move of Object.keys(camera.moves)) {
      for (const x of corners) {
        for (const y of corners) {
          for (const frames of [12, 48, 240]) {
            const shot = planNarratedCameraShots({ segments: [{ id: "s", imageKey: "s", startFrame: 0, frames, cameraMove: move, cameraFocus: { x, y } }], camera, fps: 24 }).shots[0];
            const lefts = [];
            for (let frame = 0; frame < frames; frame += 1) {
              const rect = cameraRectAt(shot, frame);
              const label = `${maxZoom} ${move} (${x},${y}) ${frames}f frame ${frame}`;
              assert.ok(rect.left >= -EPSILON && rect.left + rect.size <= 1 + EPSILON, `x inside: ${label}`);
              assert.ok(rect.top >= -EPSILON && rect.top + rect.size <= 1 + EPSILON, `y inside: ${label}`);
              lefts.push(rect.left);
            }
            if (move === "pan-left" || move === "pan-right") {
              // パンの道のりの両端が画の中に収まるので、見せる範囲は端に当たって止まらない（毎フレーム同じ向きへ進む）。
              assert.ok(shot.from.centerX - 0.5 / shot.from.zoom >= -EPSILON && shot.to.centerX + 0.5 / shot.to.zoom <= 1 + EPSILON || shot.from.centerX + 0.5 / shot.from.zoom <= 1 + EPSILON && shot.to.centerX - 0.5 / shot.to.zoom >= -EPSILON);
              for (let frame = 1; frame < lefts.length; frame += 1) {
                const step = lefts[frame] - lefts[frame - 1];
                assert.ok(move === "pan-right" ? step > 0 : step < 0, `pan keeps moving: ${maxZoom} (${x},${y}) ${frames}f frame ${frame}`);
              }
            }
          }
        }
      }
    }
  }
});

test("1.010 倍の寄りで焦点が端に近い: 見せる範囲は一番近い端（角）を動かさない寄りになり、顔は画面の中央の側へ 0.5% 以内で寄る", () => {
  const camera = normalizeNarratedCameraConfig(PACKS.small).config;
  const frames = 48;
  const plan = (focus) => planNarratedCameraShots({ segments: [{ id: "s", imageKey: "s", startFrame: 0, frames, cameraMove: "slow-push-in", cameraFocus: focus }], camera, fps: 24 }).shots[0];
  // 顔が左上寄り（0.22, 0.3）: 左上の角を動かさない寄り。
  const topLeft = plan({ x: 0.22, y: 0.3 });
  for (let frame = 0; frame < frames; frame += 1) {
    const rect = cameraRectAt(topLeft, frame);
    assert.ok(Math.abs(rect.left) < EPSILON && Math.abs(rect.top) < EPSILON, `anchored at the top-left corner at frame ${frame}`);
  }
  // 顔が右下寄り（0.9, 0.8）: 右下の角を動かさない寄り。
  const bottomRight = plan({ x: 0.9, y: 0.8 });
  const end = cameraRectAt(bottomRight, frames - 1);
  assert.ok(Math.abs(end.left + end.size - 1) < 1e-9 && Math.abs(end.top + end.size - 1) < 1e-9);
  // 画の中の顔の位置が画面のどこに映るか（寄った端）。中央の側へ寄り、寄る量は 0.5% 以内。
  const onScreen = (rect, point) => ({ x: (point.x - rect.left) / rect.size, y: (point.y - rect.top) / rect.size });
  for (const [shot, face] of [[topLeft, { x: 0.22, y: 0.3 }], [bottomRight, { x: 0.9, y: 0.8 }]]) {
    const at = onScreen(cameraRectAt(shot, frames - 1), face);
    for (const axis of ["x", "y"]) {
      const moved = at[axis] - face[axis];
      assert.ok(Math.sign(moved) === Math.sign(0.5 - face[axis]), `${axis} moves toward the center`);
      assert.ok(Math.abs(moved) <= 0.005 + 1e-9, `${axis} moves ${moved}`);
    }
  }
  // 中心から ±0.495% の中の焦点は、そのまま見せる範囲の中心になる（端へは寄らない）。
  const near = cameraRectAt(plan({ x: 0.502, y: 0.499 }), frames - 1);
  assert.ok(Math.abs(near.left + near.size / 2 - 0.502) < 1e-9 && Math.abs(near.top + near.size / 2 - 0.499) < 1e-9);
});

test("食い違い: 同じ画が続く文の焦点が違えば（片方だけ指定も）1つの動きで通せないので計画の問題にし、有料生成の前の検査も同じ場面を返す", () => {
  const camera = normalizeNarratedCameraConfig(PACKS.large).config;
  const focus = { x: 0.3, y: 0.4 };
  const same = [
    { id: "p1.t1", sourceSegmentId: "p1", imageKey: "p1", startFrame: 0, frames: 10, cameraFocus: focus },
    { id: "p1.t2", sourceSegmentId: "p1", imageKey: "p1", startFrame: 10, frames: 10, cameraFocus: { ...focus } },
  ];
  assert.equal(groupNarratedCameraShots(same).length, 1);
  assert.deepEqual(planNarratedCameraShots({ segments: same, camera, fps: 24 }).problems, []);
  assert.deepEqual(narratedCameraFocusConflicts(same), []);
  for (const other of [{ x: 0.7, y: 0.4 }, undefined]) {
    const mixed = [same[0], { ...same[1], cameraFocus: other }];
    const plan = planNarratedCameraShots({ segments: mixed, camera, fps: 24 });
    assert.deepEqual(plan.problems, ["camera-focus-conflict:p1.t1"]);
    assert.deepEqual(plan.shots[0].focusConflicts, ["p1.t2"]);
    assert.deepEqual(narratedCameraFocusConflicts(mixed.map(({ startFrame, frames, ...rest }) => rest)), ["p1"]);
  }
  // 別の画（別の場面）なら焦点が違ってよい。部が違えば同じ鍵でも別のショット。
  const separate = [
    { id: "p1", imageKey: "p1", part: "story", cameraFocus: focus },
    { id: "p2", imageKey: "p2", part: "story", cameraFocus: { x: 0.8, y: 0.2 } },
    { id: "p2", imageKey: "p2", part: "review" },
  ];
  assert.deepEqual(narratedCameraFocusConflicts(separate), []);
});

test("判定（純粋関数）: 計画の見せ方と位置・拡大が許容の中なら通り、越えれば焦点の違い・大きさの違い、推定できなければ測れない", () => {
  assert.deepEqual(judgeCameraFocusView({ scale: 1.0001, dx: 0.1, dy: -0.1, residual: 1 }).problems, []);
  assert.deepEqual(judgeCameraFocusView({ scale: 1, dx: CAMERA_FOCUS_SHIFT_TOLERANCE_PX, dy: 0.3, residual: 1 }).problems, ["focus-differs-from-plan"]);
  assert.deepEqual(judgeCameraFocusView({ scale: 1 + 2 * CAMERA_FOCUS_SCALE_TOLERANCE, dx: 0, dy: 0, residual: 1 }).problems, ["focus-view-zoom-differs-from-plan"]);
  assert.deepEqual(judgeCameraFocusView({ scale: 1, dx: 0, dy: 0, residual: Number.POSITIVE_INFINITY }).problems, ["focus-view-unmeasurable"]);
});

async function renderShots(dir, shots, name) {
  const { inputs, chains, labels } = cameraShotChains({ shots, render: RENDER });
  const output = join(dir, name);
  const frames = shots.reduce((sum, shot) => sum + shot.frames, 0);
  await ff(toolchain, [...inputs, "-filter_complex", `${chains.join(";")};${labels.join("")}concat=n=${labels.length}:v=1:a=0[v]`, "-map", "[v]", "-frames:v", String(frames), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", output]);
  return output;
}

// 焦点を付けた6つのショットと、焦点の無い1つのショット（測らない）。f は画の角（画の外が見えないこと）。
const SCENES = [
  { id: "a", move: "slow-push-in", focus: { x: 0.22, y: 0.3 } },
  { id: "b", move: "slow-pull-out", focus: { x: 0.8, y: 0.75 } },
  { id: "c", move: "pan-right", focus: { x: 0.4, y: 0.3 } },
  { id: "d", move: "pan-left", focus: { x: 0.65, y: 0.7 } },
  { id: "e", move: "static", focus: { x: 0.7, y: 0.4 } },
  { id: "f", move: "slow-push-in", focus: { x: 1, y: 0 } },
  { id: "g", move: "slow-push-in", focus: null },
];

for (const packName of Object.keys(PACKS)) {
  test(`完成 MP4 で測る（拡大の上限 ${PACKS[packName].moves["slow-push-in"].maxZoom} 倍）: 計画の焦点で描いた版は通り、焦点を無視した・反転した・パンを横へずらした版は落ちる`, {
    skip: toolchain.ok ? false : "ffmpeg is unavailable",
  }, async () => {
    const dir = await mkdtemp(join(os.tmpdir(), "narrated-camera-focus-"));
    try {
      const still = join(dir, "still.png");
      await makeTexturedStill(toolchain, still, RENDER);
      const camera = normalizeNarratedCameraConfig(PACKS[packName]).config;
      const segmentsWith = (focusOf) => SCENES.map((scene, index) => {
        const focus = scene.focus ? focusOf(scene.focus) : null;
        return { id: scene.id, imageKey: scene.id, imagePath: still, startFrame: index * 48, frames: 48, cameraMove: scene.move, ...(focus ? { cameraFocus: focus } : {}) };
      });
      const planWith = (focusOf) => planNarratedCameraShots({ segments: segmentsWith(focusOf), camera, fps: RENDER.fps });
      const plan = planWith((focus) => focus);
      assert.deepEqual(plan.problems, []);
      const measure = async (videoPath) => measureNarratedCameraFocus({ ffmpeg: toolchain.ffmpeg, videoPath, shots: plan.shots, camera, render: RENDER });

      const baseVideo = await renderShots(dir, plan.shots, "base.mp4");
      const base = await measure(baseVideo);
      assert.equal(base.pass, true, JSON.stringify(base.shots.map((shot) => [shot.id, shot.problems, shot.views?.map((view) => view.shiftError)])));
      // 焦点の無いショット（g）は測らない。焦点を付けた6つは、この Pack で Pack の型ごとの焦点と見分けられる。
      assert.equal(base.shotCount, 6);
      assert.equal(base.distinguishableCount, 6);
      for (const shot of base.shots) {
        for (const view of shot.views) assert.ok(view.shiftError <= CAMERA_FOCUS_SHIFT_TOLERANCE_PX && view.scaleError <= CAMERA_FOCUS_SCALE_TOLERANCE, `${shot.id} frame ${view.frame}`);
      }
      // 同じ MP4 は、フレームどうしの動きの監査（cameraMotionMeasured）も計画どおりに通る。
      const motion = await measureNarratedCameraMotion({ ffmpeg: toolchain.ffmpeg, videoPath: baseVideo, shots: plan.shots, camera, render: RENDER });
      assert.equal(motion.pass, true, motion.problems.join(", "));

      // 壊した版 1: 焦点を無視して Pack の型ごとの焦点で描いた。焦点を付けた全部のショットが落ちる。
      const ignored = await measure(await renderShots(dir, planWith(() => null).shots, "ignored.mp4"));
      assert.equal(ignored.pass, false);
      assert.deepEqual(ignored.failedShotIds.sort(), ["story:a", "story:b", "story:c", "story:d", "story:e", "story:f"]);
      assert.ok(ignored.problems.includes("focus-differs-from-plan"));
      // 壊した版 2: 焦点を上下左右に反転して描いた。
      const mirrored = await measure(await renderShots(dir, planWith((focus) => ({ x: 1 - focus.x, y: 1 - focus.y })).shots, "mirrored.mp4"));
      assert.deepEqual(mirrored.failedShotIds.sort(), ["story:a", "story:b", "story:c", "story:d", "story:e", "story:f"]);
      // 壊した版 3: パンの焦点を横へ 0.1 ずらして描いた（c は余白の中で中ほどが動く。d は余白の端へ寄せた結果が同じ）。
      const nudged = await measure(await renderShots(dir, planWith((focus) => ({ x: Math.min(1, focus.x + 0.1), y: focus.y })).shots, "nudged.mp4"));
      assert.ok(nudged.failedShotIds.includes("story:c"), nudged.failedShotIds.join(", "));
      assert.ok(!nudged.failedShotIds.includes("story:d"), nudged.failedShotIds.join(", "));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
