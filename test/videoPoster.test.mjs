import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("local video thumbnails avoid the first black frame", async () => {
  const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const sceneSource = await readFile(new URL("../lib/canvasScene.mjs", import.meta.url), "utf8");

  assert.match(appSource, /function videoPosterCandidateTimes\(duration\)/);
  assert.match(appSource, /function videoFrameScore\(video\)/);
  assert.match(appSource, /VIDEO_POSTER_GOOD_SCORE/);
  assert.match(appSource, /for \(const time of videoPosterCandidateTimes\(duration\)\)/);
  assert.doesNotMatch(
    appSource,
    /addEventListener\('loadeddata',\s*capture/,
    "loadeddata must not capture the zero-second frame before seeking",
  );

  assert.match(sceneSource, /function videoPosterSeekTimes\(\)/);
  assert.match(sceneSource, /for \(const \[index, time\] of videoPosterSeekTimes\(\)\.entries\(\)\)/);
  assert.match(sceneSource, /if \(posterData\.length > \(bestPosterData\?\.length \|\| 0\)\) bestPosterData = posterData/);
});

test("video reference cards render poster images instead of video URLs", async () => {
  const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const normalizeAssetList = appSource.match(/function normalizeAssetList\(value\) \{\r?\n([\s\S]*?)\r?\n\}/);
  assert.ok(normalizeAssetList, "Missing normalizeAssetList");

  assert.match(
    normalizeAssetList[1],
    /rawThumbnail\.startsWith\('data:image\/'\)\s*\?\s*rawThumbnail/,
    "data image thumbnails should not be replaced with the video asset URL",
  );
  assert.match(appSource, /function buildVideoPosterByAssetUrl\(scene = \{\}\) \{/);
  assert.match(appSource, /function videoPosterForAsset\(asset, posterByAssetUrl\) \{/);
  assert.match(appSource, /function assetPreviewImageSrc\(asset, posterByAssetUrl = null\) \{/);
  assert.match(appSource, /!isVideoFileReference\(thumbnail\)/);
  assert.match(appSource, /const videoPosterByAssetUrl = buildVideoPosterByAssetUrl\(latestSceneRef\.current\)/);
  assert.match(appSource, /const previewImageSrcForAsset = \(asset\) => assetPreviewImageSrc\(asset, videoPosterByAssetUrl\)/);
  assert.match(appSource, /<img className="lovart-slot-thumb" src=\{previewImageSrcForAsset\(slotAsset\)\}/);
  assert.match(appSource, /<img src=\{previewImageSrcForAsset\(asset\)\} alt=\{asset\.name \|\| 'reference'\}/);
});
