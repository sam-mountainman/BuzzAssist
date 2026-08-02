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
  assert.equal((source.match(/reference-video-locked-v3/g) || []).length, 2);
  assert.doesNotMatch(source, /reference-video-locked-v2/);
  assert.match(source, /SPEECH_BUBBLE_ENDPOINT = '\/api\/speech-bubbles'/);
});

test("R5 rerender API overwrites SVG without native image dependencies", async () => {
  const viteSource = await readFile(new URL("../vite.config.js", import.meta.url), "utf8");
  const mcpSource = await readFile(new URL("../mcp/server.mjs", import.meta.url), "utf8");
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(viteSource, /server\.middlewares\.use\('\/api\/speech-bubbles'/);
  assert.match(viteSource, /renderSpeechBubbleSvg\(/);
  assert.match(viteSource, /writeFile\(assetFile, rendered\.svg, 'utf8'\)/);
  assert.match(mcpSource, /maxColumns: \{ type: "number", minimum: 1, maximum: 3/);
  assert.doesNotMatch(JSON.stringify(packageJson.dependencies), /sharp|fontkit/i);
});
