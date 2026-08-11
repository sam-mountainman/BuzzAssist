import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");

test("canvas asset reference paths resolve to browser-visible thumbnail URLs", () => {
  const match = appSource.match(
    /function canvasAssetPreviewUrlFromPath\(referencePath\) \{[\s\S]*?\n\}/,
  );
  assert.ok(match, "Missing canvasAssetPreviewUrlFromPath");
  const canvasAssetPreviewUrlFromPath = new Function(`${match[0]}; return canvasAssetPreviewUrlFromPath;`)();

  assert.equal(
    canvasAssetPreviewUrlFromPath(
      "/Users/example/project/canvas/assets/style-references/reference frame.png",
    ),
    "/excalidraw-assets/style-references/reference%20frame.png",
  );
  assert.equal(
    canvasAssetPreviewUrlFromPath("assets/characters/hero.png"),
    "/excalidraw-assets/characters/hero.png",
  );
  assert.equal(canvasAssetPreviewUrlFromPath("/tmp/outside-canvas.png"), "");
});

test("generator reference thumbnails fall back from URL to the saved canvas asset path", () => {
  const normalizeAssetList = appSource.match(
    /function normalizeAssetList\(value\) \{[\s\S]*?\n\}/,
  );
  const assetPreviewImageSrc = appSource.match(
    /function assetPreviewImageSrc\(asset, posterByAssetUrl = null\) \{[\s\S]*?\n\}/,
  );
  assert.ok(normalizeAssetList, "Missing normalizeAssetList");
  assert.ok(assetPreviewImageSrc, "Missing assetPreviewImageSrc");
  assert.match(
    normalizeAssetList[0],
    /canvasAssetPreviewUrlFromPath\(path\)/,
  );
  assert.match(
    assetPreviewImageSrc[0],
    /canvasAssetPreviewUrlFromPath\(asset\?\.path\)/,
  );
});
