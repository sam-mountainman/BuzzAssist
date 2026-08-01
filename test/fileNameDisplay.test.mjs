import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} should exist`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `${endMarker} should exist after ${startMarker}`);
  return source.slice(start, end);
}

test("canvas headers use stored file names instead of generation prompts", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const displayNameHelper = sliceBetween(source, "function getCanvasMediaDisplayName", "function getCanvasMediaPixelSize");
  const imageOverlayBuilder = sliceBetween(source, "function buildSelectedImageOverlays", "function buildVideoPlaybackOverlays");
  const subtitleOverlayBuilder = sliceBetween(source, "function buildSubtitlePreviewOverlays", "// Fetched SRT text");

  assert.match(
    displayNameHelper,
    /canvasLeafFileName\(customData\.codexFileName\)/,
    "BuzzAssist-style stored file names should be the primary display label",
  );
  assert.match(
    displayNameHelper,
    /canvasLeafFileNameFromAssetUrl\(customData\.codexAssetUrl\)/,
    "asset URLs should still recover the stored filename when metadata is older",
  );
  assert.doesNotMatch(
    displayNameHelper,
    /codexGenerationPrompt|generatorPrompt|videoPrompt/,
    "prompts should not be rendered as file names above canvas media",
  );
  assert.match(
    subtitleOverlayBuilder,
    /fileName: getCanvasMediaDisplayName\(element, scene\.files\)/,
    "SRT headers should use the same filename normalization as images and videos",
  );
  assert.match(
    imageOverlayBuilder,
    /isSpeechBubbleOverlay\(element\)/,
    "transparent R4/R5 overlays should not draw a duplicate media header over their source image",
  );
});
