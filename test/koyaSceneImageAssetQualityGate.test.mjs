// 本編の画（scene-image）: 機械の QA の後、行を complete にする前に品質ループの合格を要求する（契約 v54 から）。
// ループ未合格 → 行を止め再生成しない / 合格 → complete / 合格した版と SHA が違う → 止まる / 古い契約 → 従来どおり。
// 回・行 id はすべて合成の値。
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createKoyaSceneImageAssetQualityGate } from "../lib/koyaAssetQualityGate.mjs";
import { koyaSceneImageAssetQualitySubjectId } from "../lib/koyaAssetQualityGatePolicy.mjs";
import { executeMangaScriptImagePlan, renderEditorialPlatePng } from "../lib/mangaScriptImagePipeline.mjs";
import { currentKoyaContract, legacyKoyaContract, passKoyaAssetQualityLoop } from "./helpers/koyaAssetQualityFixture.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

async function tempRoot(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function sceneJob(assetDir, index) {
  return {
    id: `image:cut-0${index}-u01`,
    kind: "scene-image",
    dependencies: [],
    outputPath: join(assetDir, `cut-0${index}-u01.png`),
    prompt: `synthetic scene ${index}`,
    referenceImagePaths: [],
    model: "fake",
    aspectRatio: "16:9",
    imageSize: "2K",
    quality: "high",
    imageCount: 1,
    inputHash: `hash-${index}`,
  };
}

test("本編の画: 機械の QA の後、scene-image 工程のループ合格まで行を止め、再生成しない（未合格・合格・SHA 違い・古い契約）", async (t) => {
  const base = await tempRoot(t, "koya-scene-gate-");
  const canvasDir = join(base, "canvas");
  const assetDir = join(canvasDir, "assets", "synthetic-ep");
  const plateJob = {
    id: "plate:cut-02-u01",
    kind: "editorial-plate",
    dependencies: [],
    outputPath: join(assetDir, "cut-02-u01-white-solid.png"),
    plateType: "white-solid",
    imageCount: 0,
    inputHash: "hash-plate",
  };
  const plan = { version: 1, episodeId: "synthetic-ep", scriptSha256: "script-hash", assetDir, jobs: [sceneJob(assetDir, 1), plateJob] };
  let generated = 0;
  const generateImage = async (input) => {
    generated += 1;
    return { buffer: renderEditorialPlatePng("pastel-sky", 320, 180), fileName: input.fileName, mimeType: "image/png" };
  };
  let qaCalls = 0;
  const visualQa = async () => {
    qaCalls += 1;
    return { pass: true, issues: [] };
  };
  const contract = await currentKoyaContract(root);
  const gate = createKoyaSceneImageAssetQualityGate({ contract, canvasDir, episodeId: "synthetic-ep" });
  const run = () => executeMangaScriptImagePlan(plan, { maxRetries: 1, generateImage, visualQa, assetQualityGate: gate });
  const subjectId = koyaSceneImageAssetQualitySubjectId("synthetic-ep", "image:cut-01-u01");

  const first = await run();
  assert.equal(generated, 1);
  assert.equal(first.ledger.status, "awaiting-human-review");
  assert.equal(first.ledger.jobs["plate:cut-02-u01"].status, "complete", "ゲートは本編の画だけ（決定論の板は対象外）");
  const held = first.ledger.jobs["image:cut-01-u01"];
  assert.equal(held.status, "awaiting-human-review");
  assert.equal(held.assetQuality.code, `asset-quality-required:scene-image:${subjectId}:loop-not-started`);
  assert.deepEqual(first.ledger.summary.assetQualityAwaiting, [{ jobId: "image:cut-01-u01", subjectId, code: held.assetQuality.code }]);

  const second = await run();
  assert.equal(generated, 1, "止めた行は有料の再生成を回さない");
  assert.equal(second.ledger.status, "awaiting-human-review");

  await passKoyaAssetQualityLoop({ workDir: canvasDir, stage: "scene-image", subjectId, assetPath: held.outputPath });
  const qaBefore = qaCalls;
  const third = await run();
  assert.equal(generated, 1);
  assert.equal(qaCalls, qaBefore, "同じファイルなら機械の QA も掛け直さない");
  assert.equal(third.ledger.status, "complete");
  assert.equal(third.ledger.jobs["image:cut-01-u01"].assetQuality.pass, true);

  // 別の行: 合格した版の後でファイルが差し替わった → 機械の QA だけ掛け直し、SHA 違いで止める。
  const plan2 = { ...plan, jobs: [...plan.jobs, sceneJob(assetDir, 3)] };
  const run2 = () => executeMangaScriptImagePlan(plan2, { maxRetries: 1, generateImage, visualQa, assetQualityGate: gate });
  const firstOfThird = await run2();
  assert.equal(generated, 2);
  const subject3 = koyaSceneImageAssetQualitySubjectId("synthetic-ep", "image:cut-03-u01");
  const path3 = firstOfThird.ledger.jobs["image:cut-03-u01"].outputPath;
  await passKoyaAssetQualityLoop({ workDir: canvasDir, stage: "scene-image", subjectId: subject3, assetPath: path3 });
  await writeFile(path3, Buffer.concat([renderEditorialPlatePng("pastel-sky", 320, 180), Buffer.from("synthetic-v2")]));
  const qaBeforeSwap = qaCalls;
  const swapped = await run2();
  assert.equal(generated, 2);
  assert.equal(qaCalls, qaBeforeSwap + 1, "差し替わったファイルへ機械の QA を掛け直す（生成はしない）");
  assert.equal(swapped.ledger.jobs["image:cut-03-u01"].status, "awaiting-human-review");
  assert.equal(swapped.ledger.jobs["image:cut-03-u01"].assetQuality.reason, "asset-sha-mismatch");

  // 古い契約（v53）: ゲートは作られず、従来どおり QA の合格で complete。
  assert.equal(createKoyaSceneImageAssetQualityGate({ contract: await legacyKoyaContract(root), canvasDir, episodeId: "synthetic-ep" }), null);
  const legacyBase = await tempRoot(t, "koya-scene-legacy-");
  const legacyAssetDir = join(legacyBase, "canvas", "assets", "synthetic-ep");
  const legacy = await executeMangaScriptImagePlan(
    { ...plan, assetDir: legacyAssetDir, jobs: [sceneJob(legacyAssetDir, 1)] },
    { maxRetries: 1, generateImage, visualQa, assetQualityGate: null },
  );
  assert.equal(legacy.ledger.status, "complete");
  assert.equal(Object.hasOwn(legacy.ledger.jobs["image:cut-01-u01"], "assetQuality"), false);
});
