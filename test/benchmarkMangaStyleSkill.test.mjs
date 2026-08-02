import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function read(relativePath) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

test("benchmark manga style skill keeps candidate identity separate from style references", async () => {
  const skill = await read("skills/excalidraw-benchmark-manga-style/SKILL.md");
  const contracts = await read("skills/excalidraw-benchmark-manga-style/references/prompt-contracts.md");
  const rubric = await read("skills/excalidraw-benchmark-manga-style/references/style-rubric.md");

  assert.match(skill, /Generate three candidates per new or redesigned character/);
  assert.match(skill, /exactly two facial STYLE-ONLY references/);
  assert.match(skill, /linework-male-v2\.png.*first/);
  assert.match(skill, /Do not request garment, skin, shoe, fabric, or material close-ups/);
  assert.match(skill, /approved character identity sheet;[\s\S]*benchmark STYLE-ONLY references/);
  assert.match(skill, /check the requested asset filenames and the canvas JSON/);

  assert.match(contracts, /Lightweight candidate-card contract/);
  assert.match(contracts, /one front-facing full-body view plus exactly three head studies/);
  assert.match(contracts, /Approved turnaround contract/);
  assert.match(contracts, /Exclude the failed old sheet from image inputs/);
  assert.match(rubric, /Pass requires at least 45\/50/);
  assert.match(rubric, /Fatal: a benchmark person's identity is reproduced/);
});

test("distributed visual profile uses the flat benchmark grammar and current style pack", async () => {
  const profileFile = JSON.parse(await read("examples/manga-character-pipeline/channel-visual-profiles.example.json"));
  const profile = profileFile.profiles[0];

  assert.equal(profile.maxStyleReferences, 2);
  assert.match(profile.stylePrompt, /simple flat Japanese YouTube web-manga/);
  assert.match(profile.stylePrompt, /at most one restrained cel-shadow shape/);
  assert.match(profile.continuityPrompt, /Every benchmark image is STYLE-ONLY/);
  assert.match(profile.negativePrompt, /yakuza-game rendering/);
  assert.deepEqual(profile.referenceImages.slice(0, 2).map((entry) => entry.id), [
    "linework-male",
    "linework-female",
  ]);
  assert.ok(profile.referenceImages.every((entry) => entry.path.includes("-v2.png")));
  assert.ok(profile.referenceImages.every((entry) => entry.notes.startsWith("STYLE-ONLY.")));
});
