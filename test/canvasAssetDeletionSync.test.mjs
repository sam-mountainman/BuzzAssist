import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncDeletedCanvasAssets, syncMissingCanvasAssets } from "../lib/canvasScene.mjs";

async function isFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function assetElement(id, fileName, { deleted = false, references = [] } = {}) {
  return {
    id,
    type: "image",
    fileId: `file-${id}`,
    isDeleted: deleted,
    customData: {
      codexAssetUrl: `/excalidraw-assets/${encodeURIComponent(fileName)}`,
      generatorReferenceImages: references.map((name) => ({ url: `/excalidraw-assets/${encodeURIComponent(name)}` })),
    },
  };
}

test("deleted canvas results move to assets-trash and undo restores them", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "buzzassist-delete-sync-"));
  const canvasDir = join(projectDir, "canvas");
  const assetsDir = join(canvasDir, "assets");
  const trashDir = join(canvasDir, "assets-trash");
  await mkdir(assetsDir, { recursive: true });
  await writeFile(join(assetsDir, "result.png"), "result");

  const deletedScene = {
    elements: [assetElement("result", "result.png", { deleted: true })],
    files: {},
  };

  try {
    const deleted = await syncDeletedCanvasAssets({ canvasDir }, deletedScene);
    assert.equal(deleted.trashed, 1);
    assert.equal(await isFile(join(assetsDir, "result.png")), false);
    assert.equal(await readFile(join(trashDir, "result.png"), "utf8"), "result");

    const restored = await syncDeletedCanvasAssets({ canvasDir }, {
      ...deletedScene,
      elements: [assetElement("result", "result.png")],
    });
    assert.equal(restored.restored, 1);
    assert.equal(await readFile(join(assetsDir, "result.png"), "utf8"), "result");
    assert.equal(await isFile(join(trashDir, "result.png")), false);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("an asset referenced by another live frame is not trashed", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "buzzassist-shared-sync-"));
  const canvasDir = join(projectDir, "canvas");
  const assetsDir = join(canvasDir, "assets");
  await mkdir(assetsDir, { recursive: true });
  await writeFile(join(assetsDir, "shared.png"), "shared");

  try {
    const result = await syncDeletedCanvasAssets({ canvasDir }, {
      elements: [
        assetElement("source", "shared.png", { deleted: true }),
        {
          id: "generator",
          type: "rectangle",
          isDeleted: false,
          customData: {
            generatorReferenceImages: [{ url: "/excalidraw-assets/shared.png" }],
          },
        },
      ],
      files: {},
    });
    assert.equal(result.trashed, 0);
    assert.equal(await readFile(join(assetsDir, "shared.png"), "utf8"), "shared");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("deleting a generated asset locally deletes its live canvas element", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "buzzassist-local-delete-sync-"));
  const canvasDir = join(projectDir, "canvas");
  const assetsDir = join(canvasDir, "assets");
  await mkdir(assetsDir, { recursive: true });
  const scene = {
    type: "excalidraw",
    version: 2,
    elements: [assetElement("result", "Image1.png")],
    appState: { selectedElementIds: { result: true } },
    files: {},
  };
  await writeFile(join(canvasDir, "excalidraw-canvas.json"), JSON.stringify(scene));

  try {
    const result = await syncMissingCanvasAssets({ canvasDir, assetFileName: "Image1.png", restoreFromTrash: false });
    const saved = JSON.parse(await readFile(join(canvasDir, "excalidraw-canvas.json"), "utf8"));

    assert.equal(result.deleted, 1);
    assert.equal(saved.elements.find((element) => element.id === "result").isDeleted, true);
    assert.deepEqual(saved.appState.selectedElementIds, {});
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("startup reconciliation restores a live asset from assets-trash before deleting its element", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "buzzassist-offline-undo-sync-"));
  const canvasDir = join(projectDir, "canvas");
  const trashDir = join(canvasDir, "assets-trash");
  await mkdir(trashDir, { recursive: true });
  await writeFile(join(trashDir, "Image1.png"), "image");
  await writeFile(join(canvasDir, "excalidraw-canvas.json"), JSON.stringify({
    type: "excalidraw",
    version: 2,
    elements: [assetElement("result", "Image1.png")],
    appState: {},
    files: {},
  }));

  try {
    const result = await syncMissingCanvasAssets({ canvasDir });
    const saved = JSON.parse(await readFile(join(canvasDir, "excalidraw-canvas.json"), "utf8"));

    assert.equal(result.deleted, 0);
    assert.equal(result.restored, 1);
    assert.equal(saved.elements.find((element) => element.id === "result").isDeleted, false);
    assert.equal(await readFile(join(canvasDir, "assets", "Image1.png"), "utf8"), "image");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("missing-asset reconciliation re-deletes a result resurrected by a stale client", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "buzzassist-stale-resurrection-sync-"));
  const canvasDir = join(projectDir, "canvas");
  await mkdir(join(canvasDir, "assets"), { recursive: true });
  const scenePath = join(canvasDir, "excalidraw-canvas.json");
  await writeFile(scenePath, JSON.stringify({
    type: "excalidraw",
    version: 2,
    elements: [assetElement("result", "missing.png")],
    appState: {},
    files: {},
  }));

  try {
    const first = await syncMissingCanvasAssets({ canvasDir, restoreFromTrash: false });
    const deletedScene = JSON.parse(await readFile(scenePath, "utf8"));
    const staleLiveElement = {
      ...deletedScene.elements[0],
      isDeleted: false,
      version: deletedScene.elements[0].version + 10,
    };
    await writeFile(scenePath, JSON.stringify({ ...deletedScene, elements: [staleLiveElement] }));

    const second = await syncMissingCanvasAssets({ canvasDir, restoreFromTrash: false });
    const saved = JSON.parse(await readFile(scenePath, "utf8"));

    assert.equal(first.deleted, 1);
    assert.equal(second.deleted, 1);
    assert.equal(saved.elements[0].isDeleted, true);
    assert.equal(saved.elements[0].version, staleLiveElement.version + 1);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
