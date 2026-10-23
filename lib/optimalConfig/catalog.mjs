// 最適構成エンジンの構成表（config/optimal-config/catalog.json）を読む。
//
// 構成表は scripts/build-optimal-config-catalog.mjs が作るデータで、手で直さない。
// ここでは読み込みと、エンジンが前提にする最低限の形だけを確かめる（JSON Schema の
// 全項目の検査はテストで ajv を使って行う。実行時に ajv を読み込まないため）。

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_OPTIMAL_CONFIG_CATALOG_PATH = path.join(REPO_ROOT, "config", "optimal-config", "catalog.json");
export const OPTIMAL_CONFIG_CATALOG_VERSION = "optimal-config-catalog-v1";

const cache = new Map();

export function assertOptimalConfigCatalog(catalog) {
  if (!catalog || typeof catalog !== "object") throw new Error("構成表が読めない（JSON のオブジェクトではない）。");
  if (catalog.version !== OPTIMAL_CONFIG_CATALOG_VERSION) {
    throw new Error(`構成表の版が違う（${String(catalog.version)}）。${OPTIMAL_CONFIG_CATALOG_VERSION} を期待している。`);
  }
  for (const key of ["videoConfigs", "imageWorkflows", "workflowSelectors", "models", "runtimePlaces", "accelerations"]) {
    if (!Array.isArray(catalog[key])) throw new Error(`構成表の ${key} が配列ではない。`);
  }
  if (catalog.reproduced !== false) {
    throw new Error("構成表の reproduced は false のはず（調査は公式資料を読んだだけで、何も実測していない）。");
  }
  return catalog;
}

/** 構成表を読む。同じパスは1回だけ読む。 */
export function loadOptimalConfigCatalog(filePath = DEFAULT_OPTIMAL_CONFIG_CATALOG_PATH) {
  const resolved = path.resolve(filePath);
  if (!cache.has(resolved)) {
    cache.set(resolved, assertOptimalConfigCatalog(JSON.parse(readFileSync(resolved, "utf8"))));
  }
  return cache.get(resolved);
}

export function findModel(catalog, modelId) {
  return catalog.models.find((model) => model.id === modelId) ?? null;
}

export function findVideoConfig(catalog, configId) {
  return catalog.videoConfigs.find((config) => config.id === configId) ?? null;
}

export function findWorkflow(catalog, workflowId) {
  return catalog.imageWorkflows.find((workflow) => workflow.id === workflowId) ?? null;
}

export function findRuntimePlace(catalog, placeId) {
  return catalog.runtimePlaces.find((place) => place.id === placeId) ?? null;
}
