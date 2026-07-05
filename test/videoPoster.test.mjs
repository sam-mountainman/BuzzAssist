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
