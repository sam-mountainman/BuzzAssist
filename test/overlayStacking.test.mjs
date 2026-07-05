import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("canvas media overlays follow scene stacking instead of piercing front elements", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");

  assert.match(
    source,
    /function isCanvasStackingCoverElement\(element\)\s*\{\s*return isCanvasAttachableElement\(element\) \|\| isGeneratorFrame\(element\)\s*\}/,
    "media and generator frames must both participate in cover checks",
  );
  assert.match(
    source,
    /function getLaterCanvasStackingElements\(reference, elements\)/,
    "cover checks should use the shared later-element helper",
  );
  assert.match(
    source,
    /rectsOverlap\(referenceBounds, getElementGeometry\(element\), 0\)/,
    "DOM media previews should hide on any later overlap, not only center coverage",
  );
  assert.match(
    source,
    /isHeaderCoveredByLaterElement: isHeaderCoveredByLaterElement\(element, scene\.elements, appState, placement, headerMetrics\)/,
    "media filenames should hide when a later image, video, SRT, or frame covers the header",
  );
  assert.match(
    source,
    /\.filter\(\(overlay\) => overlay && !overlay\.isCoveredByLaterElement && \(overlay\.isSelected \|\| isViewportPlacementNearViewport\(overlay, appState\)\)\)/,
    "video and SRT DOM overlays should be removed when later canvas elements overlap them",
  );
  assert.match(
    source,
    /if \(overlay\.isCoveredByLaterElement\) return null/,
    "generator frame DOM outlines should not stay above later media just because the frame is selected or generating",
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
