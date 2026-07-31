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
const CHARACTER_ROLES = new Set(["fixed", "per-video"]);
const CHARACTER_KINDS = new Set(["character", "prop", "location"]);

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function resolveCharacterRegistryFile(args = {}) {
  return join(resolveCanvasDir(args), CHARACTER_REGISTRY_FILE_NAME);
}

function normalizeCharacter(entry, index) {
  if (!entry || typeof entry !== "object") return null;
  const id = nonEmptyString(entry.id) || `character-${index + 1}`;
  const role = CHARACTER_ROLES.has(entry.role) ? entry.role : "fixed";
  const kind = CHARACTER_KINDS.has(entry.kind) ? entry.kind : "character";
  const referenceImagePaths = [...new Set(
    (Array.isArray(entry.referenceImagePaths) ? entry.referenceImagePaths : [])
      .map((value) => nonEmptyString(value))
      .filter(Boolean),
  )].slice(0, MAX_REFERENCE_IMAGES_PER_CHARACTER);
  return {
    id,
    name: nonEmptyString(entry.name) || id,
    kind,
    role,
    referenceImagePaths,
    stylePrompt: nonEmptyString(entry.stylePrompt),
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

function findCharacter(registry, id) {
  const characters = Array.isArray(registry?.characters) ? registry.characters : [];
  return (
    characters.find((character) => character.id === id) ||
    characters.find((character) => character.name === id) ||
    null
  );
}

// Resolve character ids (or names) to absolute reference image paths.
// Relative registry paths are resolved against canvasDir so the registry can
// use portable paths like "assets/characters/hero.png".
export function resolveCharacterReferencePaths(registry, characterIds, args = {}) {
  const ids = normalizeCharacterIds(characterIds);
  if (ids.length === 0) return [];
  const canvasDir = resolveCanvasDir(args);
  const paths = [];
  const seen = new Set();
  const missing = [];
  for (const id of ids) {
    const character = findCharacter(registry, id);
    if (!character) {
      missing.push(id);
      continue;
    }
    for (const referencePath of character.referenceImagePaths) {
      const absolutePath = isAbsolute(referencePath)
        ? resolve(referencePath)
        : resolve(join(canvasDir, referencePath));
      if (seen.has(absolutePath)) continue;
      seen.add(absolutePath);
      paths.push(absolutePath);
    }
  }
  if (missing.length > 0) {
    const available = (registry?.characters ?? []).map((character) => character.id);
    throw new Error(
      `Unknown character id(s): ${missing.join(", ")}. ` +
        (available.length > 0
          ? `Available ids in canvas/${CHARACTER_REGISTRY_FILE_NAME}: ${available.join(", ")}.`
          : `canvas/${CHARACTER_REGISTRY_FILE_NAME} has no characters yet; register them first.`),
    );
  }
  return paths;
}
