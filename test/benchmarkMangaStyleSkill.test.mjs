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

  // 2026-09-24 に本文を日本語化した。固定している規則は英語版と同じで、文言だけ日本語へ移した。
  // prompt-contracts のコードブロックは画像モデルへ渡す英語のプロンプト本文なので英語のまま照合する。
  assert.match(skill, /新キャラと作り直すキャラには、既定で1人につき3案の候補を生成する/);
  assert.match(skill, /顔の STYLE-ONLY 参照をちょうど2枚/);
  assert.match(skill, /linework-male-v2\.png.*1枚目/);
  assert.match(skill, /服・肌・靴・布地・素材の接写を要求しない/);
  assert.match(skill, /承認済みのキャラクター identity シート[\s\S]*ベンチマークの STYLE-ONLY 参照/);
  assert.match(skill, /依頼したアセットの\s*ファイル名とキャンバスの JSON を確かめ/);

  assert.match(contracts, /Lightweight candidate-card contract/);
  assert.match(contracts, /one front-facing full-body view plus exactly three head studies/);
  assert.match(contracts, /Approved turnaround contract/);
  assert.match(contracts, /失敗した旧シートは画像入力から外し/);
  assert.match(rubric, /合格には 45\/50 以上が必要/);
  assert.match(rubric, /致命的：ベンチマークの人物の identity が再現されている/);
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
