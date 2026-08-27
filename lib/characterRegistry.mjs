// Channel character registry ("キャラ台帳"): canvas/characters.json keeps the
// recurring cast (fixed side characters) and per-video leads together with
// their reference images and voices, so generation tools can resolve a
// character id into binding reference image paths. The file follows the
// canvas/subtitle-glossary.json convention: user-visible, hand-editable JSON
// under canvas/, served over its own /api endpoint.
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { resolveCanvasDir, writeJsonAtomic } from "./canvasScene.mjs";
import { withCanvasFileLock } from "./canvasFileLock.mjs";

export const CHARACTER_REGISTRY_FILE_NAME = "characters.json";
export const CHARACTER_REGISTRY_VERSION = 1;
const MAX_CHARACTERS = 200;
const MAX_VOICES = 50;
const MAX_REFERENCE_IMAGES_PER_CHARACTER = 14;
const MAX_ALIASES_PER_CHARACTER = 20;
const MAX_INVARIANTS_PER_CHARACTER = 30;
const MAX_REFERENCE_ASSETS_PER_CHARACTER = 20;
const CHARACTER_ROLES = new Set(["fixed", "per-video"]);
const CHARACTER_KINDS = new Set(["character", "prop", "location"]);
const CHARACTER_STATUSES = new Set(["approved", "draft", "archived"]);
const CHARACTER_REFERENCE_ROLES = new Set([
  "identity-face",
  "turnaround",
  "expression",
  "eye-open",
  "outfit",
  "supplemental",
]);

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function normalizedStringList(value, limit) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map((item) => nonEmptyString(item))
      .filter(Boolean),
  )].slice(0, limit);
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function normalizeReferenceAsset(entry, index) {
  if (!plainObject(entry)) return null;
  const path = nonEmptyString(entry.path ?? entry.referenceImagePath);
  if (!path) return null;
  return {
    id: nonEmptyString(entry.id) || `reference-${index + 1}`,
    role: CHARACTER_REFERENCE_ROLES.has(entry.role) ? entry.role : "supplemental",
    path,
    sha256: nonEmptyString(entry.sha256),
    storyStage: nonEmptyString(entry.storyStage ?? entry.story_stage),
    sourceReviewPath: nonEmptyString(entry.sourceReviewPath ?? entry.source_review_path),
  };
}

export function resolveCharacterRegistryFile(args = {}) {
  return join(resolveCanvasDir(args), CHARACTER_REGISTRY_FILE_NAME);
}

function normalizeCharacter(entry, index) {
  if (!entry || typeof entry !== "object") return null;
  const id = nonEmptyString(entry.id) || `character-${index + 1}`;
  const role = CHARACTER_ROLES.has(entry.role) ? entry.role : "fixed";
  const kind = CHARACTER_KINDS.has(entry.kind) ? entry.kind : "character";
  const referenceImagePaths = normalizedStringList(
    entry.referenceImagePaths,
    MAX_REFERENCE_IMAGES_PER_CHARACTER,
  );
  let referenceAssets = (Array.isArray(entry.referenceAssets) ? entry.referenceAssets : [])
    .map(normalizeReferenceAsset)
    .filter(Boolean)
    .slice(0, MAX_REFERENCE_ASSETS_PER_CHARACTER);
  if (referenceAssets.length === 0) {
    referenceAssets = referenceImagePaths.map((path, referenceIndex) => ({
      id: `legacy-reference-${referenceIndex + 1}`,
      role: referenceIndex === 0 ? "identity-face" : "supplemental",
      path,
      sha256: "",
      storyStage: "",
      sourceReviewPath: "",
    }));
  }
  const allReferencePaths = normalizedStringList(
    [...referenceAssets.map((asset) => asset.path), ...referenceImagePaths],
    MAX_REFERENCE_IMAGES_PER_CHARACTER,
  );
  return {
    id,
    name: nonEmptyString(entry.name) || id,
    kind,
    role,
    status: CHARACTER_STATUSES.has(entry.status) ? entry.status : "approved",
    episodeId: nonEmptyString(entry.episodeId ?? entry.episode_id),
    aliases: normalizedStringList(entry.aliases, MAX_ALIASES_PER_CHARACTER),
    description: nonEmptyString(entry.description),
    invariants: normalizedStringList(entry.invariants, MAX_INVARIANTS_PER_CHARACTER),
    negativePrompt: nonEmptyString(entry.negativePrompt ?? entry.negative_prompt),
    referenceImagePaths: allReferencePaths,
    referenceAssets,
    stylePrompt: nonEmptyString(entry.stylePrompt),
    voiceId: nonEmptyString(entry.voiceId ?? entry.voice_id),
    voiceCasting: plainObject(entry.voiceCasting ?? entry.voice_casting),
    sourceWorkflowId: nonEmptyString(entry.sourceWorkflowId ?? entry.source_workflow_id),
    sourceCandidateId: nonEmptyString(entry.sourceCandidateId ?? entry.source_candidate_id),
    approval: plainObject(entry.approval) ? {
      route: nonEmptyString(entry.approval.route),
      approvedBy: nonEmptyString(entry.approval.approvedBy ?? entry.approval.approved_by),
      approvedAt: nonEmptyString(entry.approval.approvedAt ?? entry.approval.approved_at),
      selectedCandidateId: nonEmptyString(entry.approval.selectedCandidateId ?? entry.approval.selected_candidate_id),
      selectedCandidateLabel: nonEmptyString(entry.approval.selectedCandidateLabel ?? entry.approval.selected_candidate_label),
      candidateSetId: nonEmptyString(entry.approval.candidateSetId ?? entry.approval.candidate_set_id),
      verdictDigest: nonEmptyString(entry.approval.verdictDigest ?? entry.approval.verdict_digest),
      selectedVariationAxis: nonEmptyString(entry.approval.selectedVariationAxis ?? entry.approval.selected_variation_axis),
      reason: nonEmptyString(entry.approval.reason),
      candidateReviewPath: nonEmptyString(entry.approval.candidateReviewPath ?? entry.approval.candidate_review_path),
      identityReviewPath: nonEmptyString(entry.approval.identityReviewPath ?? entry.approval.identity_review_path),
      identityReviewSha256: nonEmptyString(entry.approval.identityReviewSha256 ?? entry.approval.identity_review_sha256),
    } : null,
    createdAt: nonEmptyString(entry.createdAt ?? entry.created_at),
    updatedAt: nonEmptyString(entry.updatedAt ?? entry.updated_at),
    notes: nonEmptyString(entry.notes),
  };
}

function normalizeVoice(entry, index) {
  if (!entry || typeof entry !== "object") return null;
  const id = nonEmptyString(entry.id) || `voice-${index + 1}`;
  const providerVoiceId = nonEmptyString(
    entry.providerVoiceId ?? entry.provider_voice_id ?? entry.elevenLabsVoiceId ?? entry.eleven_labs_voice_id,
  );
  const settings = entry.settings && typeof entry.settings === "object"
    ? {
        stability: Number.isFinite(Number(entry.settings.stability)) ? Number(entry.settings.stability) : 0.5,
        similarityBoost: Number.isFinite(Number(entry.settings.similarityBoost ?? entry.settings.similarity_boost))
          ? Number(entry.settings.similarityBoost ?? entry.settings.similarity_boost)
          : 0.75,
        speed: Number.isFinite(Number(entry.settings.speed)) ? Number(entry.settings.speed) : 1,
        useSpeakerBoost: entry.settings.useSpeakerBoost !== false && entry.settings.use_speaker_boost !== false,
      }
    : { stability: 0.5, similarityBoost: 0.75, speed: 1, useSpeakerBoost: true };
  return {
    id,
    name: nonEmptyString(entry.name) || id,
    provider: nonEmptyString(entry.provider) || "elevenlabs",
    providerVoiceId,
    elevenLabsVoiceId: providerVoiceId,
    modelId: nonEmptyString(entry.modelId ?? entry.model_id) || "eleven_v3",
    role: nonEmptyString(entry.role) || "narration",
    episodeId: nonEmptyString(entry.episodeId ?? entry.episode_id),
    previewUrl: nonEmptyString(entry.previewUrl ?? entry.preview_url),
    source: nonEmptyString(entry.source) || "account",
    description: nonEmptyString(entry.description),
    labels: plainObject(entry.labels) || {},
    casting: plainObject(entry.casting),
    status: nonEmptyString(entry.status) || "approved",
    settings,
  };
}

export function normalizeCharacterRegistry(parsed) {
  const source = parsed && typeof parsed === "object" ? parsed : {};
  const characters = (Array.isArray(source.characters) ? source.characters : [])
    .map(normalizeCharacter)
    .filter(Boolean)
    .slice(0, MAX_CHARACTERS);
  const seen = new Set();
  const uniqueCharacters = characters.filter((character) => {
    if (seen.has(character.id)) return false;
    seen.add(character.id);
    return true;
  });
  const voices = (Array.isArray(source.voices) ? source.voices : [])
    .map(normalizeVoice)
    .filter(Boolean)
    .slice(0, MAX_VOICES);
  return {
    version: CHARACTER_REGISTRY_VERSION,
    revision: Math.max(0, Math.floor(Number(source.revision) || 0)),
    characters: uniqueCharacters,
    voices,
  };
}

async function readCharacterRegistryFile(file) {
  try {
    const raw = await readFile(file, "utf8");
    if (!raw.trim()) throw new Error(`Character registry is empty: ${file}.`);
    return normalizeCharacterRegistry(JSON.parse(raw));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return normalizeCharacterRegistry(null);
  }
}

export async function readCharacterRegistry(args = {}) {
  return readCharacterRegistryFile(resolveCharacterRegistryFile(args));
}

export async function writeCharacterRegistry(args = {}, registry) {
  const file = resolveCharacterRegistryFile(args);
  const expectedRevision = Math.max(0, Math.floor(Number(registry?.revision) || 0));
  return withCanvasFileLock(file, async () => {
    const current = await readCharacterRegistryFile(file);
    if (current.revision !== expectedRevision) {
      throw new Error(`Stale character registry revision: expected ${expectedRevision}, current ${current.revision}. Read the registry again before writing.`);
    }
    const normalized = normalizeCharacterRegistry(registry);
    normalized.revision = current.revision + 1;
    await writeJsonAtomic(file, normalized);
    return normalized;
  });
}

export function normalizeCharacterIds(...idLists) {
  const merged = [];
  const seen = new Set();
  for (const idList of idLists) {
    if (!Array.isArray(idList)) continue;
    for (const value of idList) {
      const id = nonEmptyString(value);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      merged.push(id);
    }
  }
  return merged;
}

export function findCharacter(registry, id) {
  const characters = Array.isArray(registry?.characters) ? registry.characters : [];
  const requested = nonEmptyString(id);
  return (
    characters.find((character) => character.id === requested) ||
    characters.find((character) => character.name === requested) ||
    characters.find((character) => character.aliases.includes(requested)) ||
    null
  );
}

function absoluteCharacterReferencePaths(character, args = {}) {
  const canvasDir = resolveCanvasDir(args);
  return character.referenceImagePaths.map((referencePath) =>
    isAbsolute(referencePath)
      ? resolve(referencePath)
      : resolve(join(canvasDir, referencePath)),
  );
}

function absoluteCharacterReferenceAssets(character, args = {}) {
  const canvasDir = resolveCanvasDir(args);
  return (character.referenceAssets || []).map((asset) => ({
    ...asset,
    path: isAbsolute(asset.path) ? resolve(asset.path) : resolve(join(canvasDir, asset.path)),
  }));
}

export function resolveCharacterBindings(registry, characterIds, args = {}) {
  const ids = normalizeCharacterIds(characterIds);
  if (ids.length === 0) return [];
  const bindings = [];
  const missing = [];
  for (const id of ids) {
    const character = findCharacter(registry, id);
    if (!character || character.status !== "approved") {
      missing.push(id);
      continue;
    }
    bindings.push({
      ...character,
      referenceImagePaths: absoluteCharacterReferencePaths(character, args),
      referenceAssets: absoluteCharacterReferenceAssets(character, args),
    });
  }
  if (missing.length > 0) {
    const available = (registry?.characters ?? [])
      .filter((character) => character.status === "approved")
      .map((character) => character.id);
    throw new Error(
      `Unknown or unapproved character id(s): ${missing.join(", ")}. ` +
        (available.length > 0
          ? `Available ids in canvas/${CHARACTER_REGISTRY_FILE_NAME}: ${available.join(", ")}.`
          : `canvas/${CHARACTER_REGISTRY_FILE_NAME} has no characters yet; register them first.`),
    );
  }
  return bindings;
}

export function optimizeCharacterBindingsForGeneration(bindings = [], options = {}) {
  const normalized = Array.isArray(bindings) ? bindings.filter(Boolean) : [];
  const intent = nonEmptyString(options.referenceIntent) || "default";
  const storyStage = nonEmptyString(options.storyStage);
  const providerReferenceLimit = Number.isFinite(Number(options.providerReferenceLimit))
    ? Math.max(0, Math.floor(Number(options.providerReferenceLimit)))
    : Infinity;
  const route = (binding) => {
    const assets = Array.isArray(binding.referenceAssets) ? binding.referenceAssets : [];
    const first = (role, predicate = () => true) => assets.find((asset) => asset.role === role && predicate(asset));
    const identity = first("identity-face") || assets[0];
    const selected = [];
    if (identity) selected.push(identity);
    if (normalized.length === 1) {
      if (intent === "closeup" || intent === "expression") {
        const expression = first("expression");
        if (expression) selected.push(expression);
      } else if (intent === "full-body" || intent === "profile") {
        const turnaround = first("turnaround");
        if (turnaround) selected.push(turnaround);
      } else if (intent === "eye-open") {
        const eyeOpen = first("eye-open");
        if (eyeOpen) selected.push(eyeOpen);
      } else if (intent === "outfit" || storyStage) {
        const outfit = first("outfit", (asset) => !storyStage || asset.storyStage === storyStage);
        if (storyStage && !outfit) throw new Error(`Character ${binding.id} has no approved outfit sheet for storyStage '${storyStage}'.`);
        if (outfit) selected.push(outfit);
      }
    }
    const fallbackPaths = (binding.referenceImagePaths || []).slice(0, normalized.length >= 2 ? 1 : 2);
    const paths = selected.length > 0 ? selected.map((asset) => asset.path) : fallbackPaths;
    return { ...binding, referenceAssets: selected, referenceImagePaths: [...new Set(paths)] };
  };
  const routed = normalized.map(route);
  const referenceCount = new Set(routed.flatMap((binding) => binding.referenceImagePaths)).size;
  if (referenceCount > providerReferenceLimit) {
    throw new Error(
      `Approved character references require ${referenceCount} images, but the selected provider accepts ${providerReferenceLimit}. ` +
      "Do not drop an identity-face reference; reduce the cast in this generation or use a provider with a larger reference budget.",
    );
  }
  return routed;
}

export function buildCharacterIdentityPrompt(bindings = [], options = {}) {
  const normalized = Array.isArray(bindings) ? bindings.filter(Boolean) : [];
  if (normalized.length === 0) return "";
  const lines = [
    "CHARACTER IDENTITY LOCK (binding references are mandatory):",
    "Keep every named character distinct. Never blend faces, hair, clothing, age, body shape, or accessories between characters.",
  ];
  let referenceIndex = Math.max(1, Math.round(Number(options.startReferenceIndex) || 1));
  for (const binding of normalized) {
    const count = binding.referenceImagePaths.length;
    const referenceLabel = count > 0
      ? `reference image${count === 1 ? "" : "s"} ${referenceIndex}${count > 1 ? `-${referenceIndex + count - 1}` : ""}`
      : "the written identity specification";
    const details = [binding.description, binding.stylePrompt].filter(Boolean).join(" ");
    lines.push(`- ${binding.name} [${binding.id}]: use ${referenceLabel} only for this character.${details ? ` ${details}` : ""}`);
    if (binding.invariants.length > 0) lines.push(`  Must preserve: ${binding.invariants.join("; ")}.`);
    if (binding.negativePrompt) lines.push(`  Must avoid: ${binding.negativePrompt}.`);
    referenceIndex += count;
  }
  lines.push("If two or more characters appear together, preserve each identity independently in the same frame.");
  return lines.join("\n");
}

// Resolve character ids (or names) to absolute reference image paths.
// Relative registry paths are resolved against canvasDir so the registry can
// use portable paths like "assets/characters/hero.png".
export function resolveCharacterReferencePaths(registry, characterIds, args = {}) {
  const bindings = resolveCharacterBindings(registry, characterIds, args);
  const paths = [];
  const seen = new Set();
  for (const character of bindings) {
    for (const referencePath of character.referenceImagePaths) {
      if (seen.has(referencePath)) continue;
      seen.add(referencePath);
      paths.push(referencePath);
    }
  }
  return paths;
}
