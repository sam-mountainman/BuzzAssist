import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("limit dialogs use real links for every provider upgrade destination", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");

  for (const urlPattern of [
    /https:\/\/www\.lovart\.ai\/ja\/pricing/,
    /https:\/\/buzzassist\.ai\/dashboard/,
    /https:\/\/chatgpt\.com\/ja-JP\/pricing\/\?openaicom_referred=true/,
    /https:\/\/grok\.com\/plans/,
    /https:\/\/x\.com\/i\/premium_sign_up/,
  ]) {
    assert.match(source, urlPattern);
  }

  assert.match(source, /href=\{generationErrorAction\.url\}/);
  assert.match(source, /href=\{generationErrorAction\.secondaryUrl\}/);
  assert.match(source, /target="_blank"/);
  assert.match(source, /rel="noopener noreferrer"/);
  assert.doesNotMatch(source, /openGenerationErrorAction/);
});
