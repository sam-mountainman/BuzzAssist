import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("R5 editor exposes a reliable badge and browser-native controls", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(source, /className="speech-bubble-edit-badge"/);
  assert.match(source, /className="speech-bubble-editor-panel"/);
  for (const preset of ["dialogue", "shout", "thought", "narration"]) {
    assert.match(source, new RegExp(`\\['${preset}',`));
  }
  assert.match(source, /tailAngleOffset/);
  assert.match(source, /tailLengthScale/);
  assert.match(source, /SPEECH_BUBBLE_ENDPOINT = '\/api\/speech-bubbles'/);
});

test("R5 rerender API overwrites SVG without native image dependencies", async () => {
  const viteSource = await readFile(new URL("../vite.config.js", import.meta.url), "utf8");
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(viteSource, /server\.middlewares\.use\('\/api\/speech-bubbles'/);
  assert.match(viteSource, /renderSpeechBubbleSvg\(/);
  assert.match(viteSource, /writeFile\(assetFile, rendered\.svg, 'utf8'\)/);
  assert.doesNotMatch(JSON.stringify(packageJson.dependencies), /sharp|fontkit/i);
});
