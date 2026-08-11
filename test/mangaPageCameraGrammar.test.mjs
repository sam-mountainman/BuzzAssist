import test from "node:test";
import assert from "node:assert/strict";

import {
  MANGA_PAGE_CAMERA_GRAMMAR_VERSION,
  applyMangaCameraGrammarToPanelLayout,
  applyMangaCameraGrammarToShot,
  auditMangaPanelPageCameraGrammar,
  auditMangaShotCameraGrammar,
  normalizeMangaCameraTransform,
} from "../lib/mangaPageCameraGrammar.mjs";

test("v2 preserves the three distinct camera families", () => {
  assert.equal(MANGA_PAGE_CAMERA_GRAMMAR_VERSION, "manga-page-camera-v2");
  const pullout = applyMangaCameraGrammarToShot({ id: "p", cameraMode: "pullout-only" }, "wide");
  const directional = applyMangaCameraGrammarToShot({ id: "d", cameraMode: "left-only" }, "left");
  const combined = applyMangaCameraGrammarToShot({ id: "c", cameraMode: "right-then-pullout" }, "right");
  assert.equal(pullout.camera.focusXEnd, pullout.camera.focusX);
  assert.ok(pullout.camera.zoomStart > pullout.camera.zoomEnd);
  assert.equal(directional.camera.zoomStart, directional.camera.zoomEnd);
  assert.ok(directional.camera.focusX - directional.camera.focusXEnd >= 0.14);
  assert.equal(combined.camera.keyframes.length, 3);
  assert.equal(combined.camera.keyframes[0].zoom, combined.camera.keyframes[1].zoom);
  assert.equal(combined.camera.keyframes[1].focusX, combined.camera.keyframes[2].focusX);
  assert.equal(combined.camera.keyframes[1].focusY, combined.camera.keyframes[2].focusY);
  assert.ok(combined.camera.keyframes[2].zoom < combined.camera.keyframes[1].zoom);
  assert.deepEqual(auditMangaShotCameraGrammar(pullout), []);
  assert.deepEqual(auditMangaShotCameraGrammar(directional), []);
  assert.deepEqual(auditMangaShotCameraGrammar(combined), []);
});

test("left right and top travel strongly in only the requested direction", () => {
  const left = normalizeMangaCameraTransform({}, "left-only");
  const right = normalizeMangaCameraTransform({}, "right-only");
  const top = normalizeMangaCameraTransform({}, "top-only");
  assert.ok(left.focusXEnd < left.focusX - 0.2);
  assert.equal(left.focusYEnd, left.focusY);
  assert.ok(right.focusXEnd > right.focusX + 0.2);
  assert.equal(right.focusYEnd, right.focusY);
  assert.ok(top.focusYEnd < top.focusY - 0.18);
  assert.equal(top.focusXEnd, top.focusX);
});

test("combined motion cannot reset before its pullout", () => {
  const shot = applyMangaCameraGrammarToShot({ id: "bad", cameraMode: "left-then-pullout" }, "left");
  shot.camera.keyframes[2].focusX = shot.camera.keyframes[0].focusX;
  const violations = auditMangaShotCameraGrammar(shot);
  assert.ok(violations.some((entry) => entry.type === "combined-reset-before-pullout"));
});

test("split page freezes panels and moves the flattened page with the same grammar", () => {
  const layout = applyMangaCameraGrammarToPanelLayout({
    enabled: true,
    panels: [
      { imagePath: "/a.png", motion: "right-only", camera: { zoomStart: 1.5, focusX: 0.4 } },
      { imagePath: "/b.png", motion: "top-only", camera: { zoomStart: 1.5, focusY: 0.6 } },
    ],
    pageCameraMode: "top-then-pullout",
  }, "top");
  assert.equal(layout.pageCameraMode, "top-then-pullout");
  assert.equal(layout.pageMotion, "top-then-pullout");
  assert.equal(layout.pageCamera.keyframes.length, 3);
  assert.ok(layout.panels.every((panel) => panel.motion === "none"));
  assert.ok(layout.panels.every((panel) => panel.camera.zoomStart === panel.camera.zoomEnd));
  assert.deepEqual(auditMangaPanelPageCameraGrammar(layout, "split"), []);
});

test("auditor rejects push-in, down, weak travel, and crop collisions", () => {
  const shot = applyMangaCameraGrammarToShot({ id: "broken", cameraMode: "top-only" }, "top");
  shot.camera = {
    ...shot.camera,
    zoomStart: 1.5,
    zoomEnd: 1.6,
    focusX: 0.01,
    focusXEnd: 0.01,
    focusY: 0.5,
    focusYEnd: 0.55,
    keyframes: [
      { at: 0, zoom: 1.5, focusX: 0.01, focusY: 0.5 },
      { at: 1, zoom: 1.6, focusX: 0.01, focusY: 0.55 },
    ],
  };
  const types = auditMangaShotCameraGrammar(shot).map((entry) => entry.type);
  assert.ok(types.includes("push-in-zoom"));
  assert.ok(types.includes("downward-focus-travel"));
  assert.ok(types.includes("directional-travel-too-weak-or-wrong"));
  assert.ok(types.includes("crop-boundary-collision"));
});
