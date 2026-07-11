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
