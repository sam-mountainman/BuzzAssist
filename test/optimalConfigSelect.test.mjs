import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { findModel, loadOptimalConfigCatalog } from "../lib/optimalConfig/catalog.mjs";
import { runtimeFeasibility, selectAccelerations, selectConfig } from "../lib/optimalConfig/selectConfig.mjs";

const catalog = loadOptimalConfigCatalog();
const example = (name) => JSON.parse(readFileSync(new URL(`../examples/optimal-config/traits/${name}.json`, import.meta.url), "utf8"));
const blockedIds = (result) => result.excludedModels.blockedByRights.map((item) => item.modelId);

test("koya: R04 が本編、動かす2カットは R03。W07/W03/W06、本番は GPT Image、下書きは klein 4B", () => {
  const result = selectConfig(example("koya"));
  assert.equal(result.videoConfigs.base, "R04");
  assert.equal(result.videoConfigs.clips, "R03");
  assert.deepEqual(result.imageWorkflows.selected.slice(0, 3).map((item) => item.id), ["W07", "W03", "W06"]);
  assert.ok(result.candidates.length >= 2 && result.candidates.length <= 3);
  const [first] = result.candidates;
  assert.equal(first.models.imagePrimary.modelId, "gpt-image");
  assert.equal(first.models.imagePrimary.place, "operator-service");
  assert.deepEqual(first.models.imagePrimary.mediaGenerationIds, ["gpt-image-2-codex", "gpt-image-2"]);
  assert.equal(first.models.imageDraft.modelId, "flux2-klein-4b");
  assert.equal(first.models.imageDraft.place, "operator-mac");
  assert.ok(first.reasons.some((reason) => /429/u.test(reason)), "下書き経路を持つ理由（利用上限）を言う");
  // 設計で外したものは、どれも権利の関門で理由つきで止まる
  for (const id of ["qwen-image-2-1", "noobai-xl", "pony-v7", "illustrious-xl-v0", "flux2-klein-9b", "instantid", "pulid"]) {
    assert.ok(blockedIds(result).includes(id), id);
  }
  // Anima は運営者の手元（借り GPU）の候補としてだけ出てくる
  const anima = result.candidates.find((candidate) => candidate.models.imagePrimary.modelId === "anima");
  assert.ok(anima, "Anima の候補がある");
  assert.equal(anima.models.imagePrimary.place, "operator-rented-gpu");
  assert.ok(anima.gpuCleanup, "借り GPU は止めるところまでを工程に入れる");
});

test("mike: 本編は R01＋人物まわりに R06、冒頭は R03。量のカットは Z-Image Turbo", () => {
  const result = selectConfig(example("mike"));
  assert.equal(result.videoConfigs.base, "R01");
  assert.ok(result.videoConfigs.overlays.includes("R06"));
  assert.ok(result.videoConfigs.overlays.includes("R13"), "長尺で枚数が多いので R13 の考え方を入れる");
  assert.equal(result.videoConfigs.clips, "R03");
  const [first] = result.candidates;
  assert.equal(first.models.imagePrimary.modelId, "gpt-image");
  assert.equal(first.models.imageBulk.modelId, "z-image-turbo");
  assert.equal(first.models.imageBulk.place, "operator-rented-gpu", "Mac は未確認なので借り GPU でまとめて作る");
  assert.ok(blockedIds(result).includes("hunyuan-image-3"));
  assert.ok(blockedIds(result).includes("flux-dev"));
  assert.ok(result.warnings.some((warning) => /予算が未設定/u.test(warning)));
});

test("unashi: R09（生成動画は足さない）。W25/W28/W01", () => {
  const result = selectConfig(example("unashi"));
  assert.equal(result.videoConfigs.base, "R09");
  assert.equal(result.videoConfigs.clips, null);
  assert.deepEqual(result.videoConfigs.overlays, []);
  assert.deepEqual(result.imageWorkflows.selected.map((item) => item.id), ["W25", "W28", "W01"]);
  assert.ok(result.candidates.every((candidate) => candidate.models.video === null));
});

test("iq-comparison: R09＋R03。下書きは Mac の klein 4B、短い動画は Wan2.2 TI2V-5B を借り GPU で", () => {
  const result = selectConfig(example("iq-comparison"));
  assert.equal(result.videoConfigs.base, "R09");
  assert.equal(result.videoConfigs.clips, "R03");
  assert.deepEqual(result.imageWorkflows.selected.map((item) => item.id), ["W07", "W28", "W29", "W23"]);
  const [first] = result.candidates;
  assert.equal(first.models.imageDraft.modelId, "flux2-klein-4b");
  assert.equal(first.models.video.modelId, "wan2-2-ti2v-5b");
  assert.equal(first.models.video.place, "operator-rented-gpu");
  assert.ok(first.reasons.some((reason) => /月1万円/u.test(reason)));
});

test("Mac 16GiB では LTX Desktop のローカル経路（32GiB 以上）を選ばず、32GiB なら選べる", () => {
  const ltx = findModel(catalog, "ltx-2-5");
  const mac16 = { ...example("koya"), hardware: { mac: { memoryGiB: 16 }, cudaVramGiB: 0, cloudGpu: false, contracts: [] } };
  const small = runtimeFeasibility(ltx, mac16);
  assert.deepEqual(small.places, []);
  assert.match(small.infeasible.find((item) => item.place === "operator-mac").reason, /16GiB.*32GiB/u);
  const mac32 = { ...mac16, hardware: { ...mac16.hardware, mac: { memoryGiB: 32 } } };
  assert.deepEqual(runtimeFeasibility(ltx, mac32).places, ["operator-mac"]);
  // 選定でも、Mac 16GiB・借り GPU なし・契約なしなら LTX は動かないモデルとして理由つきで出る
  const result = selectConfig({ ...example("koya"), artStyle: "anime", hardware: mac16.hardware });
  const notRunnable = result.excludedModels.notRunnable.find((item) => item.modelId === "ltx-2-5");
  assert.ok(notRunnable);
  assert.ok(notRunnable.reasons.some((reason) => /32GiB/u.test(reason)));
});

test("CUDA 専用の高速化は Mac へ持ち込まない", () => {
  const macOnly = selectAccelerations(catalog, example("unashi"));
  const excludedIds = macOnly.local.excluded.map((item) => item.id);
  for (const id of ["Q07", "Q06", "O03", "E04"]) assert.ok(excludedIds.includes(id), id);
  assert.ok(macOnly.local.usable.includes("M02"), "Mac 専用（MFLUX）は使える");
  assert.deepEqual(macOnly.rentedGpu.usable, [], "借り GPU を使わない設定");
  const cuda = selectAccelerations(catalog, { ...example("unashi"), hardware: { mac: null, cudaVramGiB: 24, cloudGpu: false, contracts: [] } });
  assert.ok(cuda.local.usable.includes("Q07"));
  assert.ok(cuda.local.excluded.some((item) => item.id === "M02"));
});

test("外に出せない素材があると、手元の経路だけから選び、外部へ送るモデルは使わない", () => {
  const traits = { ...example("mike"), confidentialAssets: true, hardware: { mac: { memoryGiB: 16 }, cudaVramGiB: 24, cloudGpu: true, contracts: ["chatgpt"] } };
  const result = selectConfig(traits);
  assert.ok(result.videoConfigs.overlays.includes("R16"));
  for (const candidate of result.candidates) {
    for (const pickRow of Object.values(candidate.models).filter(Boolean)) {
      assert.ok(["operator-mac", "operator-cuda"].includes(pickRow.place), `${pickRow.modelId}@${pickRow.place}`);
    }
  }
  assert.ok(result.candidates.every((candidate) => candidate.models.imagePrimary.modelId !== "gpt-image"));
  assert.ok(result.warnings.some((warning) => /外に出せない素材/u.test(warning)));
});

test("traits が足りなければ選ばずに止める", () => {
  const traits = example("koya");
  delete traits.hardware;
  assert.throws(() => selectConfig(traits), (error) => error.code === "CHANNEL_TRAITS_INVALID");
});

test("選定の結果は何も実測していないことと、試験の段取りを返す", () => {
  const result = selectConfig(example("koya"));
  assert.equal(result.reproduced, false);
  assert.equal(result.trial.cutCount, 10);
  assert.equal(result.trial.typicalCuts + result.trial.hardCuts, 10);
  assert.equal(result.catalogAsOf, catalog.as_of);
});
