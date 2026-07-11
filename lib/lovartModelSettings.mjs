// Per-model settings for Lovart-routed generation.
// Browser-safe: pure data + helpers, no Node imports.
//
// Lovart's OpenAPI has no structured parameters beyond tool selection and
// attachments — every setting here is delivered as an English prompt hint by
// lib/lovartMediaGeneration.mjs. The options listed per model mirror what the
// underlying model accepts on fal.ai, restricted to hint categories that were
// verified end-to-end on Lovart (aspect ratio, resolution tier, duration,
// audio on/off, transparency, style, output format, image count — see
// docs/lovart-fal-model-parity.md). Prompt hints are best-effort: the Lovart
// agent almost always honors them but, unlike include_tools, cannot be
// contractually guaranteed.

const NANO_BANANA_ASPECTS = ["21:9", "16:9", "3:2", "4:3", "5:4", "1:1", "4:5", "3:4", "2:3", "9:16"];
// Nano Banana 2 generation adds extreme banner ratios (verified: 8:1 → 5856×704).
const NANO_BANANA_2_ASPECTS = [...NANO_BANANA_ASPECTS, "2:1", "1:2", "4:1", "1:4", "8:1", "1:8"];
const PRESET_ASPECTS = ["1:1", "16:9", "9:16", "4:3", "3:4"];
const LUMA_ASPECTS = ["3:1", "2:1", "16:9", "3:2", "1:1", "2:3", "9:16", "1:2", "1:3"];
const GPT_IMAGE_ASPECTS = ["1:1", "3:2", "2:3", "16:9", "9:16", "4:3", "3:4"];

const DEFAULT_IMAGE_SETTINGS = {
  aspects: PRESET_ASPECTS,
  sizes: ["1K"],
  maxImages: 1,
  // Model-version picker (Midjourney v8.1/v7/niji/niji7). null hides it.
  versions: null,
  // 高精細レンダリング toggle (Midjourney draft-off / high quality mode).
  detailRendering: false,
  maxReferences: 3,
};

export const LOVART_IMAGE_MODEL_SETTINGS = {
  "lovart-gpt-image-2": { aspects: GPT_IMAGE_ASPECTS, maxImages: 4, maxReferences: 8 },
  // GPT Image 1.5 has 3 fixed sizes (1024², 1536×1024, 1024×1536).
  "lovart-gpt-image-1-5": { aspects: ["1:1", "3:2", "2:3"], maxImages: 4, maxReferences: 1 },
  "lovart-nano-banana-pro": { aspects: NANO_BANANA_ASPECTS, sizes: ["1K", "2K", "4K"], maxImages: 4, maxReferences: 14 },
  "lovart-nano-banana-2": { aspects: NANO_BANANA_2_ASPECTS, sizes: ["1K", "2K", "4K"], maxImages: 4, maxReferences: 14 },
  "lovart-nano-banana-2-lite": { aspects: NANO_BANANA_2_ASPECTS, maxImages: 4, maxReferences: 14 },
  "lovart-nano-banana": { aspects: NANO_BANANA_ASPECTS, maxImages: 4, maxReferences: 14 },
  "lovart-seedream-v5": { aspects: PRESET_ASPECTS, sizes: ["2K", "3K", "4K"], maxImages: 6, maxReferences: 10 },
  "lovart-seedream-v4-5": { aspects: PRESET_ASPECTS, sizes: ["2K", "4K"], maxImages: 6, maxReferences: 10 },
  "lovart-seedream-v4": { aspects: PRESET_ASPECTS, sizes: ["1K", "2K", "4K"], maxImages: 6, maxReferences: 10 },
  // Custom pixel sizes do NOT translate through Lovart (verified: 1280×720
  // request → 1024×576), so Flux only exposes the aspect presets.
  "lovart-flux-2-max": { aspects: PRESET_ASPECTS, maxReferences: 9 },
  "lovart-flux-2-pro": { aspects: PRESET_ASPECTS, maxReferences: 9 },
  "lovart-luma-uni-1": { aspects: LUMA_ASPECTS, maxReferences: 8 },
  "lovart-luma-uni-1-max": { aspects: LUMA_ASPECTS, maxReferences: 8 },
  "lovart-ideogram-v4": { aspects: PRESET_ASPECTS, maxImages: 4, maxReferences: 1 },
  // Midjourney is Lovart-only (no fal.ai endpoint). Lovart's own web UI has
  // a version picker (v8.1/v7/niji/niji7) and a 高精細レンダリング toggle,
  // but those are web-UI-side structured params: real generations on
  // 2026-07-11 showed both the parenthesized version hint AND a canonical
  // trailing "--niji 7" flag being ignored (photoreal output either way),
  // so no version/detail settings are offered here. Aspect ratio is the
  // one hint that does reflect (16:9 → 1456×816 verified).
  "lovart-midjourney": {
    aspects: ["16:9", "4:3", "1:1", "3:4", "9:16", "2:3", "3:2"],
    maxImages: 4,
  },
};

const DEFAULT_VIDEO_SETTINGS = {
  aspects: ["16:9", "9:16", "1:1"],
  durationChoices: null,
  durationRange: { min: 3, max: 15, step: 1 },
  resolutions: null,
  // "toggle" = user can turn audio on/off, "always" = model always produces
  // audio (no toggle shown), "none" = model cannot produce audio.
  audio: "none",
  // Whether the underlying model accepts an end frame (fal.ai end_image_url /
  // first-last-frame endpoints). false hides the 終了フレーム slot.
  endFrame: true,
  maxReferenceImages: 3,
  maxReferenceVideos: 3,
  maxReferenceAudios: 0,
};

const SEEDANCE_2_ASPECTS = ["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];

export const LOVART_VIDEO_MODEL_SETTINGS = {
  "lovart-seedance-2": {
    aspects: SEEDANCE_2_ASPECTS,
    durationRange: { min: 4, max: 15, step: 1 },
    resolutions: ["480p", "720p", "1080p", "4K"],
    audio: "toggle",
    maxReferenceImages: 9,
    maxReferenceVideos: 3,
    maxReferenceAudios: 3,
  },
  "lovart-seedance-2-fast": {
    aspects: SEEDANCE_2_ASPECTS,
    durationRange: { min: 4, max: 15, step: 1 },
    resolutions: ["480p", "720p"],
    audio: "toggle",
    maxReferenceImages: 9,
    maxReferenceVideos: 3,
    maxReferenceAudios: 3,
  },
  "lovart-seedance-2-mini": {
    aspects: SEEDANCE_2_ASPECTS,
    durationRange: { min: 4, max: 15, step: 1 },
    resolutions: ["480p", "720p"],
    audio: "toggle",
    maxReferenceImages: 9,
    maxReferenceVideos: 3,
    maxReferenceAudios: 3,
  },
  "lovart-seedance-pro-1-5": {
    aspects: ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"],
    durationRange: { min: 4, max: 12, step: 1 },
    resolutions: ["480p", "720p", "1080p"],
    audio: "toggle",
    maxReferenceImages: 0,
    maxReferenceVideos: 0,
  },
  "lovart-kling-v3": { durationRange: { min: 3, max: 15, step: 1 }, audio: "toggle", maxReferenceImages: 4 },
  "lovart-kling-3-omni": { durationRange: { min: 3, max: 15, step: 1 }, audio: "toggle", maxReferenceImages: 4 },
  "lovart-kling-v2-6": { durationChoices: ["5", "10"], durationRange: null, audio: "toggle", maxReferenceImages: 0 },
  "lovart-kling-omni-v1": { durationRange: { min: 3, max: 10, step: 1 }, maxReferenceImages: 7 },
  "lovart-veo-3-1": {
    aspects: ["16:9", "9:16"],
    durationChoices: ["4", "6", "8"],
    durationRange: null,
    resolutions: ["720p", "1080p", "4K"],
    audio: "toggle",
  },
  "lovart-veo-3-1-fast": {
    aspects: ["16:9", "9:16"],
    durationChoices: ["4", "6", "8"],
    durationRange: null,
    resolutions: ["720p", "1080p", "4K"],
    audio: "toggle",
  },
  // Veo 3 (deprecated on fal) has no reference-to-video variant — start/end
  // keyframes only.
  "lovart-veo-3": {
    aspects: ["16:9", "9:16"],
    durationChoices: ["4", "6", "8"],
    durationRange: null,
    resolutions: ["720p", "1080p"],
    audio: "toggle",
    maxReferenceImages: 0,
    maxReferenceVideos: 0,
  },
  // Gemini Omni Flash always generates audio (no off switch on fal either).
  // No end-frame variant exists (i2v start frame + reference-to-video only).
  "lovart-gemini-omni-flash": { aspects: ["16:9", "9:16"], durationRange: { min: 3, max: 10, step: 1 }, audio: "always", endFrame: false },
  // Hailuo has no aspect/resolution parameters at all; duration is 6/10 on
  // the standard tier. Single start frame only — no end frame, no references.
  "lovart-hailuo-2-3": { aspects: null, durationChoices: ["6", "10"], durationRange: null, endFrame: false, maxReferenceImages: 0, maxReferenceVideos: 0 },
  // Wan 2.6 i2v has no end_image_url on fal — start frame + references only.
  "lovart-wan-2-6": {
    aspects: ["16:9", "9:16", "1:1", "4:3", "3:4"],
    durationChoices: ["5", "10", "15"],
    durationRange: null,
    resolutions: ["720p", "1080p"],
    audio: "toggle",
    endFrame: false,
    maxReferenceImages: 5,
    maxReferenceVideos: 3,
  },
  "lovart-vidu-q2": {
    durationRange: { min: 2, max: 8, step: 1 },
    resolutions: ["360p", "520p", "720p", "1080p"],
    maxReferenceImages: 7,
    maxReferenceVideos: 2,
  },
};

// GPT Image 2 quality tiers are separate Lovart tools that share the base
// model's settings.
const IMAGE_SETTINGS_ALIASES = {
  "lovart-gpt-image-2-low": "lovart-gpt-image-2",
  "lovart-gpt-image-2-medium": "lovart-gpt-image-2",
  "lovart-gpt-image-2-high": "lovart-gpt-image-2",
};

export function isLovartModelId(modelId) {
  return String(modelId || "").startsWith("lovart-");
}

export function getLovartImageSettings(modelId) {
  if (!isLovartModelId(modelId)) return null;
  const key = IMAGE_SETTINGS_ALIASES[modelId] ?? modelId;
  const entry = LOVART_IMAGE_MODEL_SETTINGS[key];
  return entry ? { ...DEFAULT_IMAGE_SETTINGS, ...entry } : { ...DEFAULT_IMAGE_SETTINGS };
}

export function getLovartVideoSettings(modelId) {
  if (!isLovartModelId(modelId)) return null;
  const entry = LOVART_VIDEO_MODEL_SETTINGS[modelId];
  return entry ? { ...DEFAULT_VIDEO_SETTINGS, ...entry } : { ...DEFAULT_VIDEO_SETTINGS };
}
