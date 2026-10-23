import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  IMAGE_MODELS,
  UNKNOWN_MEDIA_MODEL_CODE,
  VIDEO_MODELS,
  generateImageMedia,
  generateVideoMedia,
  isCodexImageModel,
  isGrokImageModel,
  isGrokVideoModel,
  normalizeImageModel,
  normalizeVideoModel,
} from "../lib/mediaGeneration.mjs";

test("知っているモデルは id・表示名・従来の別名のどれでも同じ id になる", () => {
  for (const model of IMAGE_MODELS) {
    assert.equal(normalizeImageModel(model.id), model.id);
    assert.equal(normalizeImageModel(model.label), model.id, model.label);
  }
  for (const model of VIDEO_MODELS) {
    assert.equal(normalizeVideoModel(model.id), model.id);
    assert.equal(normalizeVideoModel(model.label), model.id, model.label);
  }
  // 従来の別名（後方互換）
  assert.equal(normalizeImageModel("Grok Imagine (Hermes)"), "grok-imagine-image-hermes");
  assert.equal(normalizeImageModel("gpt image 2 (api)"), "gpt-image-2");
  assert.equal(normalizeImageModel("Midjourney"), "lovart-midjourney");
  assert.equal(normalizeImageModel("Nano Banana Pro"), "lovart-nano-banana-pro");
  assert.equal(normalizeVideoModel("kling v2.6"), "kling-v2-6");
  assert.equal(normalizeVideoModel("Veo 3.1"), "lovart-veo-3-1");
  assert.equal(normalizeVideoModel("Grok Imagine Video (Grok CLI)"), "grok-imagine-video-hermes");
});

test("未指定は既定のモデル（明示しないことは置き換えではない）", () => {
  assert.equal(normalizeImageModel(undefined), DEFAULT_IMAGE_MODEL);
  assert.equal(normalizeImageModel("  "), DEFAULT_IMAGE_MODEL);
  assert.equal(normalizeVideoModel(null), DEFAULT_VIDEO_MODEL);
});

test("知らないモデルは既定のモデルに黙って置き換えず、日本語の理由で止める", () => {
  for (const [normalize, kind] of [[normalizeImageModel, "画像"], [normalizeVideoModel, "動画"]]) {
    assert.throws(() => normalize("flux-3-ultra-unknown"), (error) => {
      assert.equal(error.code, UNKNOWN_MEDIA_MODEL_CODE);
      assert.equal(error.requestedModel, "flux-3-ultra-unknown");
      assert.match(error.message, new RegExp(`${kind}のモデル「flux-3-ultra-unknown」は知らないモデル`, "u"));
      assert.match(error.message, /黙って置き換えずに止めた/u);
      return true;
    });
  }
  // 動画のモデルを画像に、画像のモデルを動画に渡しても既定へ落ちない
  assert.throws(() => normalizeImageModel("seedance-2"), (error) => error.code === UNKNOWN_MEDIA_MODEL_CODE);
  assert.throws(() => normalizeVideoModel("gpt-image-2"), (error) => error.code === UNKNOWN_MEDIA_MODEL_CODE);
});

test("既定への置き換えは allowDefaultFallback を明示したときだけ", () => {
  assert.equal(normalizeImageModel("unknown-model", { allowDefaultFallback: true }), DEFAULT_IMAGE_MODEL);
  assert.equal(normalizeVideoModel("unknown-model", { allowDefaultFallback: true }), DEFAULT_VIDEO_MODEL);
});

test("判定の関数は止めずに false を返す（知らないモデルを Codex や Grok と取り違えない）", () => {
  assert.equal(isCodexImageModel("unknown-model"), false, "以前は既定へ落ちて Codex と判定していた");
  assert.equal(isGrokImageModel("unknown-model"), false);
  assert.equal(isGrokVideoModel("unknown-model"), false, "以前は既定へ落ちて Grok と判定していた");
  assert.equal(isCodexImageModel(undefined), true);
});

test("生成の入口は、知らないモデルなら枠を取る前・課金の前に止める", async () => {
  await assert.rejects(() => generateImageMedia({ model: "made-up-image-model", prompt: "x" }), (error) => error.code === UNKNOWN_MEDIA_MODEL_CODE);
  await assert.rejects(() => generateVideoMedia({ model: "made-up-video-model", prompt: "x" }), (error) => error.code === UNKNOWN_MEDIA_MODEL_CODE);
});

test("構成表（最適構成エンジン）が指す生成の id は、すべて生成層の知っているモデル", async () => {
  const { loadOptimalConfigCatalog } = await import("../lib/optimalConfig/catalog.mjs");
  const known = new Set([...IMAGE_MODELS, ...VIDEO_MODELS].map((model) => model.id));
  for (const model of loadOptimalConfigCatalog().models) {
    for (const id of model.mediaGenerationIds || []) assert.ok(known.has(id), `${model.id} → ${id}`);
  }
});
