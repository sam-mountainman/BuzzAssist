import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("utility frames use the same generating background as image and video frames", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(source, /isGenerating \? <div className=\{`lovart-frame-generating-bg/);
  assert.doesNotMatch(source, /isGenerating\s*&&\s*!isUtilityFrame/);
});
