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

test("canvas managed overlays stay visible when media and generator frames overlap", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const frameOverlayBuilder = sliceBetween(source, "function buildFrameOverlays", "function getCanvasMediaDisplayName");
  const imageOverlayBuilder = sliceBetween(source, "function buildSelectedImageOverlays", "function buildVideoPlaybackOverlays");
  const videoOverlayBuilder = sliceBetween(source, "function buildVideoPlaybackOverlays", "function buildSubtitlePreviewOverlays");
  const subtitleOverlayBuilder = sliceBetween(source, "function buildSubtitlePreviewOverlays", "// Fetched SRT text");
  const frameRenderer = sliceBetween(source, "{frameOverlays.map", "{subtitlePreviewOverlays.map");
  const imageHeaderRenderer = sliceBetween(source, "{selectedImageOverlays.map", "<div ref={hoverOverlayRef}");
  const subtitleRenderer = sliceBetween(source, "function SubtitleCanvasOverlay", "function VideoCanvasOverlay");

  assert.match(
    videoOverlayBuilder,
    /if \(!shouldBuildViewportOverlay\(placement, appState, selectedIds, element\.id\)\) continue/,
    "offscreen video overlays should still be discarded before DOM work",
  );
  assert.match(
    subtitleOverlayBuilder,
    /if \(!shouldBuildViewportOverlay\(placement, appState, selectedIds, element\.id\)\) continue/,
    "offscreen SRT overlays should still be discarded before DOM work",
  );
  assert.doesNotMatch(
    videoOverlayBuilder,
    /isElementVisuallyCoveredByLaterElement|if \(isCoveredByLaterElement\) continue/,
    "video playback previews should not disappear behind a later frame or media card",
  );
  assert.doesNotMatch(
    subtitleOverlayBuilder,
    /isElementVisuallyCoveredByLaterElement|if \(isCoveredByLaterElement\) continue/,
    "SRT previews should stay white and readable instead of exposing the purple canvas frame below",
  );
  assert.doesNotMatch(
    frameOverlayBuilder,
    /isCoveredByLaterElement:|isHeaderCoveredByLaterElement:/,
    "generator frame overlays and titles should not be hidden by overlap metadata",
  );
  assert.doesNotMatch(
    imageOverlayBuilder,
    /isHeaderCoveredByLaterElement:/,
    "media filenames should stay visible when image, video, SRT, or generator frames overlap",
  );
  assert.doesNotMatch(
    frameRenderer,
    /isCoveredByLaterElement|isHeaderCoveredByLaterElement/,
    "frame DOM outlines and titles should not be dropped during rendering due to canvas overlap",
  );
  assert.doesNotMatch(
    imageHeaderRenderer,
    /isHeaderCoveredByLaterElement/,
    "image and video file headers should render independently of overlap order",
  );
  assert.doesNotMatch(
    subtitleRenderer,
    /isHeaderCoveredByLaterElement/,
    "SRT file headers should render independently of overlap order",
  );
  assert.doesNotMatch(
    source,
    /isCoveredByLater(?:Asset|Element)\s*&&\s*!overlay\.isSelected/,
    "selected behind-frames must not bypass the scene stacking rule",
  );
  assert.doesNotMatch(
    source,
    /isHeaderCoveredByLaterAsset|isCoveredByLaterAsset/,
    "old asset-only stacking checks should not return",
  );
});

test("canvas overlay refresh stays bounded on large scenes", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");

  assert.match(
    source,
    /const OVERLAY_RENDER_MARGIN = 320/,
    "overlay work should be limited to selected or near-viewport elements",
  );
  assert.match(
    source,
    /return limitViewportOverlays\(overlays, appState, FRAME_OVERLAY_MAX_ITEMS\)/,
    "frame overlay DOM count should be capped",
  );
  assert.match(
    source,
    /return limitViewportOverlays\(overlays, appState, VIDEO_PLAYBACK_OVERLAY_MAX_ITEMS\)/,
    "video playback DOM count should be capped",
  );
  assert.match(
    source,
    /const scheduleOverlayRefresh = useCallback/,
    "onChange overlay state updates should be coalesced",
  );
  assert.match(
    source,
    /window\.requestAnimationFrame/,
    "drag and pan overlay work should run at most once per animation frame",
  );
  assert.match(
    source,
    /syncGeneratorUi\(scene, \{ deferOverlays: true \}\)/,
    "ordinary canvas changes should defer overlay refresh instead of doing it synchronously",
  );
});
