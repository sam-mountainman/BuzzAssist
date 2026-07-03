// Canonical model catalog shared by the browser UI and Node servers.
// Browser-safe: pure data + helpers, no Node imports.
//
// One entry per model family (unique display name, no "(Provider)" suffix).
// `routes` maps an execution route (where the generation is billed/run) to
// the concrete backend model id used by lib/mediaGeneration.mjs. frameForm
// keeps storing concrete ids, so scenes stay backward compatible.

export const MEDIA_ROUTES = [
  { id: "codex", label: "Codex", icon: "openai", note: "ローカル" },
  { id: "hermes", label: "Hermes", icon: "grok", note: "ローカル" },
  { id: "buzzassist", label: "BuzzAssist", icon: "buzzassist", note: "クレジット" },
  { id: "lovart", label: "Lovart", icon: "lovart", note: "クレジット" },
];

// Route priority for a family's default: free/local first.
export const ROUTE_PRIORITY = ["codex", "hermes", "buzzassist", "lovart"];

export const IMAGE_MODEL_FAMILIES = [
  // Lovart bills GPT Image 2 quality tiers as separate tools; they are the
  // same model, so the quality setting maps to them at generation time
  // (see qualityVariants) instead of appearing as extra catalog entries.
  {
    id: "gpt-image-2",
    label: "GPT Image 2",
    provider: "openai",
    routes: { codex: "gpt-image-2-codex", buzzassist: "gpt-image-2", lovart: "lovart-gpt-image-2" },
    qualityVariants: {
      lovart: {
        low: "lovart-gpt-image-2-low",
        medium: "lovart-gpt-image-2-medium",
        high: "lovart-gpt-image-2-high",
      },
    },
  },
  { id: "grok-imagine", label: "Grok Imagine", provider: "grok", routes: { hermes: "grok-imagine-image-hermes", buzzassist: "grok-imagine-image-api" } },
  { id: "nano-banana-2", label: "Nano Banana 2", provider: "nano-banana", routes: { buzzassist: "nano-banana-2", lovart: "lovart-nano-banana-2" } },
  { id: "seedream-5-lite", label: "Seedream 5.0 Lite", provider: "seedream", routes: { buzzassist: "seedream-v5-lite", lovart: "lovart-seedream-v5" } },
  { id: "midjourney", label: "Midjourney", provider: "midjourney", routes: { lovart: "lovart-midjourney" } },
  { id: "nano-banana-pro", label: "Nano Banana Pro", provider: "nano-banana", routes: { lovart: "lovart-nano-banana-pro" } },
  { id: "nano-banana-2-lite", label: "Nano Banana 2 Lite", provider: "nano-banana", routes: { lovart: "lovart-nano-banana-2-lite" } },
  { id: "nano-banana", label: "Nano Banana", provider: "nano-banana", routes: { lovart: "lovart-nano-banana" } },
  { id: "gpt-image-1-5", label: "GPT Image 1.5", provider: "openai", routes: { lovart: "lovart-gpt-image-1-5" } },
  { id: "luma-uni-1", label: "Luma Uni-1", provider: "luma", routes: { lovart: "lovart-luma-uni-1" } },
  { id: "luma-uni-1-max", label: "Luma Uni-1 Max", provider: "luma", routes: { lovart: "lovart-luma-uni-1-max" } },
  { id: "flux-2-max", label: "Flux.2 Max", provider: "flux", routes: { lovart: "lovart-flux-2-max" } },
  { id: "flux-2-pro", label: "Flux.2 Pro", provider: "flux", routes: { lovart: "lovart-flux-2-pro" } },
  { id: "seedream-4-5", label: "Seedream 4.5", provider: "seedream", routes: { lovart: "lovart-seedream-v4-5" } },
  { id: "seedream-4", label: "Seedream 4", provider: "seedream", routes: { lovart: "lovart-seedream-v4" } },
  { id: "ideogram-4", label: "Ideogram 4", provider: "ideogram", routes: { lovart: "lovart-ideogram-v4" } },
];

export const VIDEO_MODEL_FAMILIES = [
  { id: "grok-imagine-video", label: "Grok Imagine", provider: "grok", routes: { hermes: "grok-imagine-video-hermes", buzzassist: "grok-imagine-video-api" } },
  { id: "seedance-2", label: "Seedance 2.0", provider: "seedance", routes: { buzzassist: "seedance-2", lovart: "lovart-seedance-2" } },
  { id: "seedance-2-fast", label: "Seedance 2.0 Fast", provider: "seedance", routes: { buzzassist: "seedance-2-fast", lovart: "lovart-seedance-2-fast" } },
  { id: "kling-3", label: "Kling 3.0", provider: "kling", routes: { buzzassist: "kling-v3", lovart: "lovart-kling-v3" } },
  { id: "kling-3-omni", label: "Kling 3.0 Omni", provider: "kling", routes: { buzzassist: "kling-o3", lovart: "lovart-kling-3-omni" } },
  { id: "kling-2-6", label: "Kling 2.6", provider: "kling", routes: { buzzassist: "kling-v2-6", lovart: "lovart-kling-v2-6" } },
  { id: "veo-3-1", label: "Veo 3.1", provider: "veo", routes: { lovart: "lovart-veo-3-1" } },
  { id: "veo-3-1-fast", label: "Veo 3.1 Fast", provider: "veo", routes: { lovart: "lovart-veo-3-1-fast" } },
  { id: "veo-3", label: "Veo 3", provider: "veo", routes: { lovart: "lovart-veo-3" } },
  { id: "seedance-2-mini", label: "Seedance 2.0 Mini", provider: "seedance", routes: { lovart: "lovart-seedance-2-mini" } },
  { id: "seedance-1-5-pro", label: "Seedance 1.5 Pro", provider: "seedance", routes: { lovart: "lovart-seedance-pro-1-5" } },
  { id: "kling-o1", label: "Kling O1", provider: "kling", routes: { lovart: "lovart-kling-omni-v1" } },
  { id: "hailuo-2-3", label: "Hailuo 2.3", provider: "hailuo", routes: { lovart: "lovart-hailuo-2-3" } },
  { id: "wan-2-6", label: "Wan 2.6", provider: "wan", routes: { lovart: "lovart-wan-2-6" } },
  { id: "vidu-q2", label: "Vidu Q2", provider: "vidu", routes: { lovart: "lovart-vidu-q2" } },
  { id: "gemini-omni-flash", label: "Gemini Omni Flash", provider: "gemini", routes: { lovart: "lovart-gemini-omni-flash" } },
];

function familyMatchesModel(family, modelId) {
  if (Object.values(family.routes).includes(modelId)) return true;
  for (const variants of Object.values(family.qualityVariants ?? {})) {
    if (Object.values(variants).includes(modelId)) return true;
  }
  return false;
}

function findFamily(families, modelId) {
  if (!modelId) return null;
  return families.find((family) => familyMatchesModel(family, modelId)) ?? null;
}

export function imageFamilyForModel(modelId) {
  return findFamily(IMAGE_MODEL_FAMILIES, modelId);
}

export function videoFamilyForModel(modelId) {
  return findFamily(VIDEO_MODEL_FAMILIES, modelId);
}

export function routeIdForModel(family, modelId) {
  if (!family) return null;
  for (const [routeId, id] of Object.entries(family.routes)) {
    if (id === modelId) return routeId;
  }
  for (const [routeId, variants] of Object.entries(family.qualityVariants ?? {})) {
    if (Object.values(variants).includes(modelId)) return routeId;
  }
  return null;
}

// Backend model id to submit for a route+quality combination. Falls back to
// the route's base id when the route has no tier for that quality (auto).
export function generationModelFor(family, modelId, quality) {
  const routeId = routeIdForModel(family, modelId);
  if (!family || !routeId) return modelId;
  const variants = family.qualityVariants?.[routeId];
  return variants?.[String(quality || "").toLowerCase()] ?? family.routes[routeId] ?? modelId;
}

export function defaultRouteIdFor(family) {
  if (!family) return null;
  return ROUTE_PRIORITY.find((routeId) => family.routes[routeId]) ?? null;
}

// Concrete model id when switching a family or route. Keeps the current
// route when the target family supports it, otherwise falls back to the
// family default.
export function concreteModelFor(family, preferredRouteId) {
  if (!family) return null;
  if (preferredRouteId && family.routes[preferredRouteId]) return family.routes[preferredRouteId];
  const fallback = defaultRouteIdFor(family);
  return fallback ? family.routes[fallback] : null;
}
