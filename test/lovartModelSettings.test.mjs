import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  LOVART_IMAGE_MODEL_SETTINGS,
  LOVART_VIDEO_MODEL_SETTINGS,
  getLovartImageSettings,
  getLovartVideoSettings,
} from "../lib/lovartModelSettings.mjs";
import { LOVART_IMAGE_MODELS, LOVART_VIDEO_MODELS, buildLovartPrompt, requestedLovartImageCount } from "../lib/lovartMediaGeneration.mjs";

test("every Lovart image model has an explicit settings entry", () => {
  const aliases = new Set(["lovart-gpt-image-2-low", "lovart-gpt-image-2-medium", "lovart-gpt-image-2-high"]);
  for (const { id } of LOVART_IMAGE_MODELS) {
    if (aliases.has(id)) continue;
    assert.ok(LOVART_IMAGE_MODEL_SETTINGS[id], `missing image settings for ${id}`);
  }
});

test("every Lovart video model has an explicit settings entry", () => {
  for (const { id } of LOVART_VIDEO_MODELS) {
    assert.ok(LOVART_VIDEO_MODEL_SETTINGS[id], `missing video settings for ${id}`);
  }
});

test("GPT Image 2 quality tiers share the base settings", () => {
  const base = getLovartImageSettings("lovart-gpt-image-2");
  const high = getLovartImageSettings("lovart-gpt-image-2-high");
  assert.deepEqual(high, base);
});

test("non-Lovart models resolve to null settings", () => {
  assert.equal(getLovartImageSettings("gpt-image-2-codex"), null);
  assert.equal(getLovartVideoSettings("seedance-2"), null);
});

test("video settings expose duration either as choices or a range", () => {
  for (const { id } of LOVART_VIDEO_MODELS) {
    const settings = getLovartVideoSettings(id);
    const hasChoices = Array.isArray(settings.durationChoices) && settings.durationChoices.length > 0;
    const hasRange = settings.durationRange && settings.durationRange.min > 0;
    assert.ok(hasChoices || hasRange, `no duration definition for ${id}`);
  }
});

test("verified capabilities stay pinned", () => {
  // These reflect real generations verified on 2026-07-10 — see
  // docs/lovart-fal-model-parity.md before loosening any of them.
  assert.ok(getLovartImageSettings("lovart-nano-banana-2").aspects.includes("8:1"));
  assert.ok(getLovartImageSettings("lovart-nano-banana-2-lite").maxImages >= 4);
  assert.deepEqual(getLovartVideoSettings("lovart-wan-2-6").durationChoices, ["5", "10", "15"]);
  assert.equal(getLovartVideoSettings("lovart-wan-2-6").audio, "toggle");
  assert.equal(getLovartVideoSettings("lovart-gemini-omni-flash").audio, "always");
  assert.equal(getLovartVideoSettings("lovart-vidu-q2").durationRange.min, 2);
});

test("Midjourney offers no version/detail settings (verified not honored)", () => {
  // 2026-07-11 real generations: both the version hint and a raw trailing
  // "--niji 7" flag were ignored by Lovart's Midjourney tool (photoreal
  // output for an anime-only version). Do not re-add these without a fresh
  // reflection test — see docs/lovart-fal-model-parity.md.
  const midjourney = getLovartImageSettings("lovart-midjourney");
  assert.equal(midjourney.versions, null);
  assert.equal(midjourney.detailRendering, false);
  assert.equal(getLovartImageSettings("lovart-nano-banana-2").versions, null);
  assert.equal(getLovartImageSettings("lovart-flux-2-max").detailRendering, false);
});

test("reference and end-frame gating mirrors fal.ai endpoints", () => {
  // reference-to-video exists: Seedance 2.0 family (9 img / 3 vid / 3 aud),
  // Vidu Q2 (7 img / 2 vid), Wan 2.6 (5 img / 3 vid).
  const seedance = getLovartVideoSettings("lovart-seedance-2");
  assert.equal(seedance.maxReferenceImages, 9);
  assert.equal(seedance.maxReferenceVideos, 3);
  assert.equal(seedance.maxReferenceAudios, 3);
  assert.equal(getLovartVideoSettings("lovart-vidu-q2").maxReferenceImages, 7);
  assert.equal(getLovartVideoSettings("lovart-vidu-q2").maxReferenceVideos, 2);
  // No reference variant on fal: Seedance 1.5 Pro, Hailuo 2.3, Veo 3.
  assert.equal(getLovartVideoSettings("lovart-seedance-pro-1-5").maxReferenceImages, 0);
  assert.equal(getLovartVideoSettings("lovart-hailuo-2-3").maxReferenceImages, 0);
  assert.equal(getLovartVideoSettings("lovart-veo-3").maxReferenceImages, 0);
  // No end frame on fal: Hailuo, Gemini Omni Flash, Wan 2.6 i2v.
  assert.equal(getLovartVideoSettings("lovart-hailuo-2-3").endFrame, false);
  assert.equal(getLovartVideoSettings("lovart-gemini-omni-flash").endFrame, false);
  assert.equal(getLovartVideoSettings("lovart-wan-2-6").endFrame, false);
  // End frame supported: Seedance, Kling, Veo 3.1, Vidu.
  assert.equal(getLovartVideoSettings("lovart-seedance-2").endFrame, true);
  assert.equal(getLovartVideoSettings("lovart-kling-v3").endFrame, true);
  assert.equal(getLovartVideoSettings("lovart-veo-3-1").endFrame, true);
  assert.equal(getLovartVideoSettings("lovart-vidu-q2").endFrame, true);
});

test("buildLovartPrompt renders image hints", () => {
  const prompt = buildLovartPrompt(
    {
      prompt: "a red circle",
      aspectRatio: "16:9",
      imageSize: "2K",
      modelVersion: "niji7",
      detailRendering: true,
      imageCount: 4,
    },
    "image",
  );
  assert.match(prompt, /aspect ratio 16:9/);
  assert.match(prompt, /resolution 2K/);
  assert.match(prompt, /--niji 7/);
  assert.match(prompt, /high-detail rendering/);
  assert.match(prompt, /Generate exactly 4 images\.\)$/);
});

test("buildLovartPrompt maps v-prefixed Midjourney versions to --v flags", () => {
  const prompt = buildLovartPrompt({ prompt: "a cat", modelVersion: "v8.1" }, "image");
  assert.match(prompt, /--v 8\.1/);
});

test("buildLovartPrompt keeps single-image suffix and skips auto values", () => {
  const prompt = buildLovartPrompt({ prompt: "a cat", aspectRatio: "auto", imageCount: 1 }, "image");
  assert.match(prompt, /Generate exactly one image\.\)$/);
  assert.doesNotMatch(prompt, /aspect ratio/);
  assert.doesNotMatch(prompt, /--v/);
  assert.doesNotMatch(prompt, /high-detail/);
});

test("buildLovartPrompt renders video hints and silence", () => {
  const prompt = buildLovartPrompt(
    { prompt: "a boat", aspectRatio: "9:16", duration: 5, resolution: "1080p", generateAudio: false },
    "video",
  );
  assert.match(prompt, /aspect ratio 9:16/);
  assert.match(prompt, /duration about 5 seconds/);
  assert.match(prompt, /resolution 1080p/);
  assert.match(prompt, /no audio, silent video/);
  assert.match(prompt, /Generate exactly one video\.\)$/);
});

test("buildLovartPrompt omits the silent hint when generateAudio is undefined", () => {
  const prompt = buildLovartPrompt({ prompt: "a boat", duration: 5 }, "video");
  assert.doesNotMatch(prompt, /silent/);
});

test("Grok rate limits point at SuperGrok / X Premium upgrades", async () => {
  const mediaSource = await readFile(new URL("../lib/mediaGeneration.mjs", import.meta.url), "utf8");
  assert.match(mediaSource, /Grokのレート制限に達しました/);
  assert.match(mediaSource, /https:\/\/grok\.com\/plans/);
  assert.match(mediaSource, /https:\/\/x\.com\/i\/premium_sign_up/);
  const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(appSource, /Grokのレート制限に達しました/);
  assert.match(appSource, /secondaryUrl: 'https:\/\/x\.com\/i\/premium_sign_up'/);
  assert.match(appSource, /href=\{generationErrorAction\.secondaryUrl\}/);
  assert.match(appSource, /href=\{generationErrorAction\.url\}/);
  assert.doesNotMatch(appSource, /openGenerationErrorAction/);
});

test("Lovart quota failures point at the plan page", async () => {
  // 402 and silent empty-items failures can only be fixed on Lovart's plan
  // page; the UI's generationErrorAction matches these exact phrases.
  const lovartSource = await readFile(new URL("../lib/lovartMediaGeneration.mjs", import.meta.url), "utf8");
  assert.match(lovartSource, /Lovartのクレジットまたはプランが不足しています（402）/);
  assert.match(lovartSource, /https:\/\/www\.lovart\.ai\/ja\/pricing/);
  const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(appSource, /Lovartのクレジットまたはプランが不足\|Lovartが\(動画\|画像\)を返しませんでした/);
  assert.match(appSource, /https:\/\/www\.lovart\.ai\/ja\/pricing/);
});

test("requestedLovartImageCount clamps to 1-6", () => {
  assert.equal(requestedLovartImageCount({}), 1);
  assert.equal(requestedLovartImageCount({ imageCount: 0 }), 1);
  assert.equal(requestedLovartImageCount({ imageCount: 4 }), 4);
  assert.equal(requestedLovartImageCount({ imageCount: 99 }), 6);
});
