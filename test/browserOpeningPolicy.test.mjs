import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const repoFile = (path) => new URL(`../${path}`, import.meta.url);

test("canvas tools never auto-launch an external browser", async () => {
  const source = await readFile(repoFile("mcp/server.mjs"), "utf8");
  const ensureStart = source.indexOf("async function ensureCanvasVisible");
  const ensureEnd = source.indexOf("const projectRuntimeStops", ensureStart);
  const ensureBody = source.slice(ensureStart, ensureEnd);

  assert.ok(ensureStart >= 0 && ensureEnd > ensureStart);
  assert.doesNotMatch(ensureBody, /openCanvasWindow/);
  assert.match(source, /openExternalBrowser: \{ type: "boolean"/);
  assert.match(source, /args\.openExternalBrowser === true/);
  assert.match(source, /openCanvasWindow\(canvasUrl, \{ forceExternal: true \}\)/);
  assert.match(source, /If that Browser capability is unavailable, call this tool again with openExternalBrowser=true/);
});

test("distributed agent guidance requires in-app Browser before Chrome fallback", async () => {
  const paths = [
    "AGENTS.md",
    "CLAUDE.md",
    "README.md",
    "SETUP.md",
    "skills/excalidraw-open-canvas/SKILL.md",
    ".codex-plugin/plugin.json",
  ];

  for (const path of paths) {
    const source = await readFile(repoFile(path), "utf8");
    assert.match(source, /in-app (?:Browser|browser)/, path);
    assert.match(source, /(?:Chrome|external-browser)/, path);
    assert.match(source, /(?:unavailable|利用できない|利用不可)/, path);
  }
});
