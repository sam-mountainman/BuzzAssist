import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("utility frames use the same generating background as image and video frames", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(source, /isGenerating \? <div className=\{`lovart-frame-generating-bg/);
  assert.doesNotMatch(source, /isGenerating\s*&&\s*!isUtilityFrame/);
});

test("generating placeholders never show Excalidraw selection handles", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(source, /useLayoutEffect\(\(\) => \{[\s\S]*?generatingFrameIds\.size === 0[\s\S]*?!generatingFrameIds\.has\(id\)[\s\S]*?appState: \{ selectedElementIds \}/);
  assert.match(source, /!el\.isDeleted && !generatingFrameIdsRef\.current\.has\(el\.id\)/);
  assert.match(source, /requestedSelectedElementIds[\s\S]*?!generatingFrameIdsRef\.current\.has\(id\)[\s\S]*?selectedElementIds: nextSelectedElementIds/);
  assert.match(source, /setGeneratingFrameIds\(\(current\) => new Set\(current\)\.add\(optimisticGenerationId\)\)\s*\n\s*lastPointerDownCanvasRef\.current = null/);

  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(source, /isGenerating \? ' is-generating' : ''/);
  assert.match(styles, /\.lovart-frame-overlay\.is-generating \.lovart-frame-inner \{\s*inset: -2px;/);
  assert.doesNotMatch(styles, /has-generating-frame \.excalidraw__canvas\.interactive/);
});

test("remote generated images hydrate before replacing their Generating frame", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");

  assert.match(source, /const remoteGeneratingFrameIds = new Set/);
  assert.match(source, /element\.customData\?\.codexGenerating === true/);
  assert.match(source, /const resultAnchorIds = new Set\(\[\.\.\.generatingFrameIdsRef\.current, \.\.\.remoteGeneratingFrameIds\]\)/);
  assert.match(source, /const resultFileIds = generatedResultFileIds\(payload\.scene, resultAnchorIds\)/);
  assert.match(source, /await prehydrateResultFiles\(payload\.scene, resultFileIds\)/);
});

test("remote result hydration blocks stale placeholder saves before adding files", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const handlerIndex = source.indexOf("async function loadRemoteCanvas");
  const guardIndex = source.indexOf("applyingRemoteRef.current = true", handlerIndex);
  const hydrateIndex = source.indexOf("await prehydrateResultFiles", handlerIndex);

  assert.ok(handlerIndex >= 0);
  assert.ok(guardIndex > handlerIndex);
  assert.ok(hydrateIndex > guardIndex);
});

test("direct generation hydration blocks stale placeholder saves before adding files", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const responseIndex = source.indexOf("const canvasResponse = await canvasFetch(CANVAS_ENDPOINT)");
  const guardIndex = source.indexOf("applyingRemoteRef.current = true", responseIndex);
  const hydrateIndex = source.indexOf("await prehydrateResultFiles(nextScene, resultFileIds)", responseIndex);
  const applyIndex = source.indexOf("applyRemoteScene(nextScene, { force: true, applySelection: true })", responseIndex);

  assert.ok(responseIndex >= 0);
  assert.ok(guardIndex > responseIndex);
  assert.ok(hydrateIndex > guardIndex);
  assert.ok(applyIndex > hydrateIndex);
});

test("background hydration ignores files owned only by deleted canvas elements", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");

  assert.match(source, /function liveAssetBackedImageFileIds\(scene\)[\s\S]*?element\.isDeleted[\s\S]*?live\.add\(element\.fileId\)/);
  assert.match(source, /const liveFileIds = liveAssetBackedImageFileIds\(initialScene\)[\s\S]*?liveFileIds\.has\(file\.id\) && !visibleFileIds\.has\(file\.id\)/);
  assert.match(source, /hydrateAssetBackedFiles\(normalized\.files, addHydratedAssetFile, \{\s*onlyFileIds: liveAssetBackedImageFileIds\(nextScene\)\s*\}\)/);
  assert.doesNotMatch(source, /hydrateAssetBackedFiles\(normalized\.files, addHydratedAssetFile\)\s*\n/);
});
