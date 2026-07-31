// Channel character registry ("キャラ台帳"): canvas/characters.json keeps the
// recurring cast (fixed side characters) and per-video leads together with
// their reference images and voices, so generation tools can resolve a
// character id into binding reference image paths. The file follows the
// canvas/subtitle-glossary.json convention: user-visible, hand-editable JSON
// under canvas/, served over its own /api endpoint.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { resolveCanvasDir } from "./canvasScene.mjs";

export const CHARACTER_REGISTRY_FILE_NAME = "characters.json";
const MAX_CHARACTERS = 200;
const MAX_VOICES = 50;
const MAX_REFERENCE_IMAGES_PER_CHARACTER = 14;
const MAX_ALIASES_PER_CHARACTER = 20;
const MAX_INVARIANTS_PER_CHARACTER = 30;
const CHARACTER_ROLES = new Set(["fixed", "per-video"]);
const CHARACTER_KINDS = new Set(["character", "prop", "location"]);
const CHARACTER_STATUSES = new Set(["approved", "draft", "archived"]);

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
    referenceImagePaths,
    stylePrompt: nonEmptyString(entry.stylePrompt),
    voiceId: nonEmptyString(entry.voiceId ?? entry.voice_id),
    sourceWorkflowId: nonEmptyString(entry.sourceWorkflowId ?? entry.source_workflow_id),
    sourceCandidateId: nonEmptyString(entry.sourceCandidateId ?? entry.source_candidate_id),
    createdAt: nonEmptyString(entry.createdAt ?? entry.created_at),
    updatedAt: nonEmptyString(entry.updatedAt ?? entry.updated_at),
    notes: nonEmptyString(entry.notes),
  };
}

function normalizeVoice(entry, index) {
  if (!entry || typeof entry !== "object") return null;
  const id = nonEmptyString(entry.id) || `voice-${index + 1}`;
  return {
    id,
    name: nonEmptyString(entry.name) || id,
    elevenLabsVoiceId: nonEmptyString(entry.elevenLabsVoiceId ?? entry.eleven_labs_voice_id),
    role: nonEmptyString(entry.role) || "narration",
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
  return { characters: uniqueCharacters, voices };
}

export async function readCharacterRegistry(args = {}) {
  try {
    const raw = await readFile(resolveCharacterRegistryFile(args), "utf8");
    if (!raw.trim()) return normalizeCharacterRegistry(null);
    return normalizeCharacterRegistry(JSON.parse(raw));
  } catch {
    return normalizeCharacterRegistry(null);
  }
}

export async function writeCharacterRegistry(args = {}, registry) {
  const canvasDir = resolveCanvasDir(args);
  const normalized = normalizeCharacterRegistry(registry);
  await mkdir(canvasDir, { recursive: true });
  await writeFile(
    join(canvasDir, CHARACTER_REGISTRY_FILE_NAME),
    `${JSON.stringify(normalized, null, 2)}\n`,
  );
  return normalized;
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

export function resolveCharacterBindings(registry, characterIds, args = {}) {
  const ids = normalizeCharacterIds(characterIds);
  if (ids.length === 0) return [];
  const bindings = [];
  const missing = [];
  for (const id of ids) {
    const character = findCharacter(registry, id);
    if (!character || character.status === "archived") {
      missing.push(id);
      continue;
    }
    bindings.push({
      ...character,
      referenceImagePaths: absoluteCharacterReferencePaths(character, args),
    });
  }
  if (missing.length > 0) {
    const available = (registry?.characters ?? [])
      .filter((character) => character.status !== "archived")
      .map((character) => character.id);
    throw new Error(
      `Unknown character id(s): ${missing.join(", ")}. ` +
        (available.length > 0
          ? `Available ids in canvas/${CHARACTER_REGISTRY_FILE_NAME}: ${available.join(", ")}.`
          : `canvas/${CHARACTER_REGISTRY_FILE_NAME} has no characters yet; register them first.`),
    );
  }
  return bindings;
}

export function optimizeCharacterBindingsForGeneration(bindings = [], options = {}) {
  const normalized = Array.isArray(bindings) ? bindings.filter(Boolean) : [];
  const threshold = Math.max(2, Math.round(Number(options.multiCharacterThreshold) || 3));
  const maxReferencesPerCharacter = Math.max(1, Math.round(Number(options.maxReferencesPerCharacter) || 1));
  if (normalized.length < threshold) return normalized;
  return normalized.map((binding) => ({
    ...binding,
    referenceImagePaths: (binding.referenceImagePaths ?? []).slice(0, maxReferencesPerCharacter),
  }));
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
