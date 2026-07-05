import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("uploaded canvas media does not open the generator prompt panel", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const match = source.match(/function isPanelMediaTargetElement\(element\) \{\n([\s\S]*?)\n\}/);
  assert.ok(match, "Missing isPanelMediaTargetElement");
  assert.match(match[1], /isGeneratedResult\(element\)/);
  assert.doesNotMatch(match[1], /isCanvasImageElement\(element\)/);
  assert.doesNotMatch(match[1], /isCanvasVideoElement\(element\)/);
});
