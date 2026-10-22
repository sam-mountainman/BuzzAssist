import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

import { buildCatalog, importedFromCatalog, serializeCatalog } from "../scripts/build-optimal-config-catalog.mjs";
import { assertOptimalConfigCatalog, loadOptimalConfigCatalog } from "../lib/optimalConfig/catalog.mjs";

const catalogPath = fileURLToPath(new URL("../config/optimal-config/catalog.json", import.meta.url));
const schemaPath = fileURLToPath(new URL("../config/optimal-config/catalog.schema.json", import.meta.url));
const raw = readFileSync(catalogPath, "utf8");
const catalog = JSON.parse(raw);

test("構成表は JSON Schema を満たす", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(JSON.parse(readFileSync(schemaPath, "utf8")));
  assert.equal(validate(catalog), true, JSON.stringify(validate.errors?.slice(0, 5)));
});

test("構成表は R01〜R18 と W01〜W40 を欠けなく持ち、何も実測していないことを残している", () => {
  assert.deepEqual(catalog.videoConfigs.map((row) => row.id), Array.from({ length: 18 }, (_, index) => `R${String(index + 1).padStart(2, "0")}`));
  assert.deepEqual(catalog.imageWorkflows.map((row) => row.id), Array.from({ length: 40 }, (_, index) => `W${String(index + 1).padStart(2, "0")}`));
  assert.equal(catalog.reproduced, false);
  assert.equal(catalog.benchmarked, false);
  assert.match(catalog.as_of, /^\d{4}-\d{2}-\d{2}$/u);
  assert.match(catalog.note, /reproduced=false/u);
  assert.ok(catalog.imageWorkflows.every((row) => row.reproduced === false));
  assert.ok(catalog.models.every((row) => row.reproduced === false && row.asOf === catalog.as_of));
  // migrateTo と workflowSelectors が実在する id だけを指す
  const rIds = new Set(catalog.videoConfigs.map((row) => row.id));
  for (const config of catalog.videoConfigs) for (const move of config.migrateTo) for (const to of move.to) assert.ok(rIds.has(to), `${config.id} → ${to}`);
  const wIds = new Set(catalog.imageWorkflows.map((row) => row.id));
  for (const selector of catalog.workflowSelectors) assert.ok(wIds.has(selector.workflowId), selector.workflowId);
  const modelIds = new Set(catalog.models.map((row) => row.id));
  for (const workflow of catalog.imageWorkflows) for (const id of workflow.requiresModels || []) assert.ok(modelIds.has(id), `${workflow.id} → ${id}`);
});

test("構成に関わるモデルが揃い、権利は6層の欄を全部持つ", () => {
  const ids = catalog.models.map((row) => row.id);
  for (const id of [
    "gpt-image", "flux2-klein-4b", "flux2-klein-9b", "flux-dev", "z-image-turbo", "anima", "qwen-image-2-1", "noobai-xl",
    "pony-v7", "illustrious-xl-v0", "hunyuan-image-3", "minimax-h3", "instantid", "pulid", "wan2-2-ti2v-5b", "ltx-2-5", "grok-imagine", "veo",
  ]) assert.ok(ids.includes(id), `${id} が構成表に無い`);
  for (const model of catalog.models) {
    assert.deepEqual(Object.keys(model.rights).sort(), ["code", "data", "hosting", "outputs", "region", "weights"], model.id);
  }
});

test("構成表は手元の絶対パスや ~/Downloads を含まない（作り直しが手元の調査一式に依存しない）", () => {
  assert.doesNotMatch(raw, /\/Users\/|Downloads|[A-Z]:\\\\/u);
});

test("コミット済みの取り込み結果だけで、構成表を同じ形に作り直せる", () => {
  const rebuilt = serializeCatalog(buildCatalog(importedFromCatalog(catalog)));
  assert.equal(rebuilt, raw);
});

test("読み込みは版と reproduced を確かめる", () => {
  assert.equal(loadOptimalConfigCatalog().version, "optimal-config-catalog-v1");
  assert.throws(() => assertOptimalConfigCatalog({ ...catalog, version: "x" }), /版が違う/u);
  assert.throws(() => assertOptimalConfigCatalog({ ...catalog, reproduced: true }), /reproduced/u);
});
