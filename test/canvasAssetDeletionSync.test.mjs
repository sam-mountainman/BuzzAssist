import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncDeletedCanvasAssets } from "../lib/canvasScene.mjs";

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
