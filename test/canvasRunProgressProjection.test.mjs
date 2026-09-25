// Harness Run の途中の成果物の投影（ジャンル共通の層）。snapshot は手で書いた合成の値。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  _testing,
  buildCanvasRunProgressProjection,
  CANVAS_RUN_PROGRESS_SNAPSHOT_VERSION,
  canvasRunProgressFingerprint,
  normalizeCanvasRunProgressSnapshot,
  projectCanvasRunProgress,
  resolveCanvasRunProgressStateFile,
} from "../lib/canvasRunProgressProjection.mjs";
import { makeGradientPng, sha256 } from "./fixtures/operatorImageFixture.mjs";

const RUN_ID = "video-fixture-harness-00000000000000aa";

function snapshot(overrides = {}) {
  return {
    version: CANVAS_RUN_PROGRESS_SNAPSHOT_VERSION,
    runId: RUN_ID,
    jobRevision: 2,
    updatedAt: "2026-09-25T00:00:00.000Z",
    harnessId: "fixture-harness",
    title: "合成の途中",
    status: "running",
    summaryLines: ["合成の見出し"],
    dag: {
      nodes: [
        { id: "first", title: "一つ目", status: "pass", needs: [] },
        { id: "second", title: "二つ目", status: "running", needs: ["first"] },
      ],
    },
    sections: [{ id: "frames", title: "合成の格子", tileMedia: "image", items: [{ key: "k1", title: "一枚目", lines: ["合成のラベル"], status: "complete" }] }],
    ...overrides,
  };
}

test("snapshot の形の崩れ（版・状態・依存・循環・重複キー・SHA）は例外にする", () => {
  assert.throws(() => normalizeCanvasRunProgressSnapshot(snapshot({ version: "v0" })), /版が違う/u);
  assert.throws(() => normalizeCanvasRunProgressSnapshot(snapshot({ runId: "../escape" })), /runId/u);
  assert.throws(() => normalizeCanvasRunProgressSnapshot(snapshot({ dag: { nodes: [{ id: "a", status: "done", needs: [] }] } })), /未対応/u);
  assert.throws(() => normalizeCanvasRunProgressSnapshot(snapshot({ dag: { nodes: [{ id: "a", status: "pass", needs: ["missing"] }] } })), /無い工程/u);
  assert.throws(() => normalizeCanvasRunProgressSnapshot(snapshot({
    dag: { nodes: [{ id: "a", status: "pass", needs: ["b"] }, { id: "b", status: "pass", needs: ["a"] }] },
  })), /循環/u);
  assert.throws(() => normalizeCanvasRunProgressSnapshot(snapshot({
    sections: [{ id: "frames", items: [{ key: "k", status: "complete" }, { key: "k", status: "complete" }] }],
  })), /重複/u);
  assert.throws(() => normalizeCanvasRunProgressSnapshot(snapshot({
    sections: [{ id: "frames", items: [{ key: "k", status: "complete", media: { kind: "image", sha256: "abc", path: "/x.png" } }] }],
  })), /SHA-256/u);
});

test("指紋は原本の置き場（path）に依らず、同じ snapshot からは同じ要素になる", () => {
  const media = { kind: "image", sha256: "a".repeat(64), path: join("host-a", "frame.png"), pixelWidth: 1920, pixelHeight: 1080 };
  const withMedia = (path) => snapshot({ sections: [{ id: "frames", items: [{ key: "k1", title: "一枚目", status: "complete", media: { ...media, path } }] }] });
  assert.equal(canvasRunProgressFingerprint(withMedia(join("host-a", "frame.png"))), canvasRunProgressFingerprint(withMedia(join("host-b", "elsewhere", "frame.png"))));
  const first = buildCanvasRunProgressProjection(snapshot());
  assert.deepEqual(buildCanvasRunProgressProjection(structuredClone(snapshot())), first);
  // 媒体の準備ができていない成果物は、画を出さずにカードへ「原本を読めない」と書く。
  const unprepared = buildCanvasRunProgressProjection(withMedia(join("host-a", "frame.png")));
  const label = unprepared.elements.find((element) => element.type === "text" && element.text.startsWith("一枚目"));
  assert.match(label.text, /原本を読めない/u);
  assert.equal(unprepared.elements.some((element) => element.type === "image"), false);
});

test("画の寸法は枠に収め、波形の無い音声は既存の音声アイコンにする", () => {
  assert.deepEqual(_testing.fitIntoBox({ pixelWidth: 1920, pixelHeight: 1080 }, 380, 214), { width: 380, height: 214, offsetX: 0, offsetY: 0 });
  assert.deepEqual(_testing.fitIntoBox({ pixelWidth: 1024, pixelHeight: 1024 }, 380, 214), { width: 214, height: 214, offsetX: 83, offsetY: 0 });
  assert.deepEqual(_testing.fitIntoBox({ pixelWidth: 0, pixelHeight: 0 }, 380, 214), { width: 380, height: 214, offsetX: 0, offsetY: 0 });
  const icon = _testing.audioPosterDataUrl({ waveform: [], sha256: "b".repeat(64), durationSeconds: 0 }, "合成");
  assert.match(Buffer.from(icon.split(",")[1], "base64").toString("utf8"), /AUDIO/u);
  const wave = _testing.audioPosterDataUrl({ waveform: [0.2, 1, 0.5], sha256: "b".repeat(64), durationSeconds: 61.25 }, "合成");
  assert.match(Buffer.from(wave.split(",")[1], "base64").toString("utf8"), /1:01\.3/u);
});

test("古い Job revision の投影は書かずに skip し、同じ revision で中身が変わった投影は差分で書く", async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), "canvas-progress-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await mkdir(join(projectDir, "canvas"), { recursive: true });
  const image = makeGradientPng(48, 27, 5);
  const imagePath = join(projectDir, "source-frame.png");
  await writeFile(imagePath, image);
  const withImage = (revision, status = "complete") => snapshot({
    jobRevision: revision,
    sections: [{ id: "frames", items: [{ key: "k1", title: "一枚目", status, media: { kind: "image", sha256: sha256(image), path: imagePath, pixelWidth: 48, pixelHeight: 27 } }] }],
  });
  const first = await projectCanvasRunProgress({ projectDir }, withImage(3));
  assert.equal(first.assetsCopied, 1);
  const sameRevisionChanged = await projectCanvasRunProgress({ projectDir }, withImage(3, "failed"));
  assert.equal(sameRevisionChanged.skipped, undefined);
  assert.ok(sameRevisionChanged.updated > 0);
  assert.equal(sameRevisionChanged.assetsReused, 1);
  const before = await readFile(join(projectDir, "canvas", "excalidraw-canvas.json"), "utf8");
  const stale = await projectCanvasRunProgress({ projectDir }, withImage(2));
  assert.equal(stale.skipped, true);
  assert.equal(stale.skippedReason, "stale-job-revision");
  assert.equal(await readFile(join(projectDir, "canvas", "excalidraw-canvas.json"), "utf8"), before, "古い投影は何も書かない");
  const state = JSON.parse(await readFile(resolveCanvasRunProgressStateFile({ projectDir }, RUN_ID), "utf8"));
  assert.equal(state.jobRevision, 3);
  // 作業場の外（sourceRoot の外）の原本は読まない。
  const outside = await projectCanvasRunProgress({ projectDir }, withImage(4), { sourceRoot: join(projectDir, "workspace") });
  assert.equal(outside.assetsCopied + outside.assetsReused, 0);
  const scene = JSON.parse(await readFile(join(projectDir, "canvas", "excalidraw-canvas.json"), "utf8"));
  assert.equal(scene.elements.filter((element) => element.type === "image" && !element.isDeleted).length, 0);
});
