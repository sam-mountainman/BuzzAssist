import test from "node:test";
import assert from "node:assert/strict";
import { mergeLocalCanvasScenes } from "../lib/localCanvasSceneMerge.mjs";

const el = (id, version, extra = {}) => ({ id, version, versionNonce: version, isDeleted: false, ...extra });

test("a stale tab cannot restore a placeholder after generation completed", () => {
  const current = {
    elements: [
      el("frame", 6, { isDeleted: true, customData: { codexGenerating: true } }),
      el("result", 1, {
        type: "image",
        fileId: "file-result",
        customData: {
          codexGeneratedImage: true,
          codexMediaKind: "image",
          codexAnchorElementId: "frame",
        },
      }),
    ],
    appState: { selectedElementIds: { result: true } },
    files: { "file-result": { id: "file-result", dataURL: "/excalidraw-assets/Image1.png" } },
  };
  const incoming = {
    elements: [el("frame", 10, { customData: { codexGenerating: true } })],
    appState: { selectedElementIds: { frame: true } },
    files: {},
  };

  const merged = mergeLocalCanvasScenes(current, incoming);

  assert.equal(merged.elements.find((element) => element.id === "frame").isDeleted, true);
  assert.equal(merged.elements.find((element) => element.id === "result").isDeleted, false);
  assert.equal(merged.appState.selectedElementIds.frame, undefined);
  assert.equal(merged.appState.selectedElementIds.result, true);
  assert.ok(merged.files["file-result"]);
});

test("newer ordinary browser edits still win", () => {
  const current = { elements: [el("shape", 2, { x: 10 })], appState: {}, files: {} };
  const incoming = { elements: [el("shape", 3, { x: 50 })], appState: {}, files: {} };
  const merged = mergeLocalCanvasScenes(current, incoming);
  assert.equal(merged.elements.find((element) => element.id === "shape").x, 50);
});

test("deleting a generated result allows an undo to restore its placeholder", () => {
  const current = {
    elements: [
      el("frame", 6, { isDeleted: true }),
      el("result", 1, {
        type: "image",
        customData: { codexGeneratedImage: true, codexAnchorElementId: "frame" },
      }),
    ],
    appState: {},
    files: {},
  };
  const incoming = {
    elements: [el("frame", 7), el("result", 2, { type: "image", isDeleted: true })],
    appState: {},
    files: {},
  };

  const merged = mergeLocalCanvasScenes(current, incoming);
  assert.equal(merged.elements.find((element) => element.id === "frame").isDeleted, false);
  assert.equal(merged.elements.find((element) => element.id === "result").isDeleted, true);
});

