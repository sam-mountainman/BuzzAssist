// 途中の成果物を使う前の品質ループの照合（ジャンル共通。lib/assetQualityUseGate.mjs）。
// 漫画の照合（lib/koyaAssetQualityGate.mjs）はここへ委ね、契約の版の効力だけを足す。対象 id・会話 id は合成の値。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ASSET_QUALITY_USE_REASONS,
  assetQualityUseFailureCode,
  assetQualityUseFailureLines,
  checkAssetQualityBeforeUse,
} from "../lib/assetQualityUseGate.mjs";
import { checkKoyaAssetQuality } from "../lib/koyaAssetQualityGate.mjs";
import { KOYA_ASSET_QUALITY_REASONS, koyaAssetQualityFailureCode } from "../lib/koyaAssetQualityGatePolicy.mjs";
import { renderEditorialPlatePng } from "../lib/mangaScriptImagePipeline.mjs";
import { legacyKoyaContract, currentKoyaContract } from "./helpers/koyaAssetQualityFixture.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

test("理由と理由コードの形は漫画の照合と同じ", () => {
  assert.deepEqual([...ASSET_QUALITY_USE_REASONS], [...KOYA_ASSET_QUALITY_REASONS]);
  for (const reason of ASSET_QUALITY_USE_REASONS) {
    assert.equal(assetQualityUseFailureCode("thumbnail", "synthetic-subject", reason), koyaAssetQualityFailureCode("thumbnail", "synthetic-subject", reason));
  }
});

test("作業フォルダの外・ループ未開始を理由コードで返し、案内にはハーネスを書く。漫画は同じ結果に版の効力を足すだけ", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "asset-use-gate-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workDir = path.join(base, "canvas");
  await mkdir(path.join(workDir, "thumbs"), { recursive: true });
  const inside = path.join(workDir, "thumbs", "a.png");
  const outside = path.join(base, "elsewhere.png");
  await writeFile(inside, renderEditorialPlatePng("white-solid", 1280, 720));
  await writeFile(outside, renderEditorialPlatePng("white-solid", 1280, 720));

  const away = await checkAssetQualityBeforeUse({ harnessId: "narrated-story-video", workDir, stage: "thumbnail", subjectId: "synthetic-a", assetPath: outside });
  assert.equal(away.pass, false);
  assert.equal(away.reason, "outside-work-dir");
  const notStarted = await checkAssetQualityBeforeUse({ harnessId: "narrated-story-video", workDir, stage: "thumbnail", subjectId: "synthetic-a", assetPath: inside });
  assert.equal(notStarted.reason, "loop-not-started");
  assert.equal(notStarted.code, "asset-quality-required:thumbnail:synthetic-a:loop-not-started");
  assert.match(notStarted.detail, /--harness narrated-story-video/u);
  assert.deepEqual(assetQualityUseFailureLines([notStarted, { pass: true }]), [`${notStarted.code}（${notStarted.detail}）`]);

  const koya = await checkKoyaAssetQuality({ contract: await currentKoyaContract(root), workDir, stage: "thumbnail", subjectId: "synthetic-a", assetPath: inside });
  assert.deepEqual({ ...koya, detail: "" }, { ...notStarted, detail: "" });
  assert.match(koya.detail, /--harness koya-manga-video/u);
  const legacy = await checkKoyaAssetQuality({ contract: await legacyKoyaContract(root), workDir, stage: "thumbnail", subjectId: "synthetic-a", assetPath: inside });
  assert.equal(legacy.pass, true);
  assert.equal(legacy.reason, "not-in-force");
});
