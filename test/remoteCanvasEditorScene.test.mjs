import test from "node:test";
import assert from "node:assert/strict";
import { toEditorScene } from "../lib/remoteCanvasRelayClient.mjs";

const bigDataURL = `data:image/png;base64,${"A".repeat(300 * 1024)}`;

function sampleScene() {
  return {
    elements: [
      {
        id: "r1",
        type: "rectangle",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        strokeColor: "#000",
        customData: {
          "buzzassist.imageGenerator.frame": true,
          generatorPrompt: "cat",
          generatorReferenceImages: [
            {
              name: "ref.png",
              url: "/excalidraw-assets/ref.png",
              dataURL: bigDataURL,
              thumbnail: bigDataURL,
            },
          ],
        },
      },
      { id: "img1", type: "image", x: 5, y: 5, width: 100, height: 80, fileId: "file_asset" },
      { id: "img2", type: "image", x: 9, y: 9, width: 50, height: 50, fileId: "file_inline" },
      { id: "imgbig", type: "image", x: 1, y: 1, width: 20, height: 20, fileId: "file_big_inline" },
      { id: "gone", type: "rectangle", x: 0, y: 0, width: 1, height: 1, isDeleted: true },
    ],
    appState: {
      scrollX: 120,
      scrollY: -40,
      zoom: { value: 1.5 },
      viewBackgroundColor: "#faf8ff",
      selectedElementIds: { r1: true },
      collaborators: { peer: {} },
    },
    files: {
      file_asset: { id: "file_asset", mimeType: "image/png", dataURL: "/excalidraw-assets/cat%201.png", codexAssetBacked: true, codexAssetUrl: "/excalidraw-assets/cat%201.png" },
      file_inline: { id: "file_inline", mimeType: "image/jpeg", dataURL: "data:image/jpeg;base64,SMALL" },
      file_big_inline: { id: "file_big_inline", mimeType: "image/png", dataURL: bigDataURL },
      file_unreferenced: { id: "file_unreferenced", mimeType: "image/png", dataURL: "data:image/png;base64,ZZ" },
    },
  };
}

test("editor scene keeps live render props, drops deleted elements, and compacts generator metadata", () => {
  const { scene } = toEditorScene(sampleScene());
  const ids = scene.elements.map((e) => e.id);
  assert.deepEqual(ids, ["r1", "img1", "img2", "imgbig"]);
  const rect = scene.elements.find((e) => e.id === "r1");
  assert.equal(rect.strokeColor, "#000", "full element props survive (not the stripped skeleton)");
  assert.equal(rect.customData["buzzassist.imageGenerator.frame"], true, "generator frame tag is sent to mobile");
  assert.equal(rect.customData.generatorPrompt, "cat", "generator prompt is sent to mobile");
  assert.equal(rect.customData.generatorReferenceImages[0].url, "/excalidraw-assets/ref.png");
  assert.equal(rect.customData.generatorReferenceImages[0].dataURL, undefined, "large inline dataURL is not sent");
  assert.equal(rect.customData.generatorReferenceImages[0].thumbnail, undefined, "large inline thumbnail is not sent");
});

test("viewer appState carries viewport but never selection or collaborators", () => {
  const { scene } = toEditorScene(sampleScene());
  assert.equal(scene.appState.scrollX, 120);
  assert.equal(scene.appState.scrollY, -40);
  assert.deepEqual(scene.appState.zoom, { value: 1.5 });
  assert.equal(scene.appState.viewBackgroundColor, "#faf8ff");
  assert.equal("selectedElementIds" in scene.appState, false);
  assert.equal("collaborators" in scene.appState, false);
});

test("asset-backed files become asset references; the viewer needs their names", () => {
  const { files, assetNames } = toEditorScene(sampleScene());
  assert.equal(files.file_asset.assetName, "cat 1.png", "URL-encoded asset name is decoded");
  assert.equal(files.file_asset.dataURL, undefined, "heavy bitmaps are NOT inlined");
  assert.deepEqual(assetNames, ["cat 1.png"]);
});

test("small inline files ride along; oversized inline files are referenced only", () => {
  const { files } = toEditorScene(sampleScene());
  assert.equal(files.file_inline.dataURL, "data:image/jpeg;base64,SMALL", "small base64 inlined");
  assert.equal(files.file_big_inline.dataURL, undefined, "oversized base64 dropped to a placeholder ref");
  assert.equal(files.file_big_inline.mimeType, "image/png");
});

test("unreferenced files are excluded from the snapshot", () => {
  const { files } = toEditorScene(sampleScene());
  assert.equal("file_unreferenced" in files, false);
});

test("empty scene is safe", () => {
  const { scene, files, assetNames } = toEditorScene({});
  assert.deepEqual(scene.elements, []);
  assert.deepEqual(files, {});
  assert.deepEqual(assetNames, []);
});
