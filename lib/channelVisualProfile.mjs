import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { resolveCanvasDir } from "./canvasScene.mjs";

export const CHANNEL_VISUAL_PROFILE_FILE_NAME = "channel-visual-profiles.json";
const PROFILE_VERSION = 1;
const MAX_PROFILES = 50;
const MAX_REFERENCES = 30;

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function uniqueStrings(value, limit = 50) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map((item) => nonEmptyString(item).toLowerCase())
      .filter(Boolean),
  )].slice(0, limit);
}

function clampInteger(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

function normalizeReferenceMeasurements(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > 100_000) return null;
    const parsed = JSON.parse(serialized);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeReference(reference, index = 0) {
  const source = reference && typeof reference === "object" ? reference : {};
  const path = nonEmptyString(source.path ?? source.imagePath ?? source.image_path);
  return {
    id: nonEmptyString(source.id) || `style-reference-${index + 1}`,
    path,
    role: ["style", "composition", "lighting", "background", "character-style"].includes(source.role)
      ? source.role
      : "style",
    tags: uniqueStrings(source.tags, 30),
    notes: nonEmptyString(source.notes),
  };
}

export function normalizeChannelVisualProfile(profile, index = 0) {
  const source = profile && typeof profile === "object" ? profile : {};
  const id = nonEmptyString(source.id) || `visual-profile-${index + 1}`;
  return {
    id,
    name: nonEmptyString(source.name) || id,
    status: source.status === "draft" ? "draft" : "locked",
    sourceVideos: (Array.isArray(source.sourceVideos) ? source.sourceVideos : [])
      .map((video) => nonEmptyString(video))
      .filter(Boolean)
      .slice(0, 20),
    referenceMeasurements: normalizeReferenceMeasurements(source.referenceMeasurements),
    stylePrompt: nonEmptyString(source.stylePrompt),
    compositionPrompt: nonEmptyString(source.compositionPrompt),
    shotRhythmPrompt: nonEmptyString(source.shotRhythmPrompt),
    continuityPrompt: nonEmptyString(source.continuityPrompt),
    outputPrompt: nonEmptyString(source.outputPrompt),
    negativePrompt: nonEmptyString(source.negativePrompt),
    maxStyleReferences: clampInteger(source.maxStyleReferences, 1, 4, 2),
    referenceImages: (Array.isArray(source.referenceImages) ? source.referenceImages : [])
      .map(normalizeReference)
      .filter((reference) => reference.path)
      .slice(0, MAX_REFERENCES),
  };
}

export function normalizeChannelVisualProfileStore(value) {
  const source = value && typeof value === "object" ? value : {};
  const profiles = (Array.isArray(source.profiles) ? source.profiles : [])
    .map(normalizeChannelVisualProfile)
    .slice(0, MAX_PROFILES);
  const requestedDefault = nonEmptyString(source.defaultProfileId);
  return {
    version: PROFILE_VERSION,
    defaultProfileId: profiles.some((profile) => profile.id === requestedDefault)
      ? requestedDefault
      : profiles[0]?.id || "",
    profiles,
  };
}

export function resolveChannelVisualProfileFile(args = {}) {
  return join(resolveCanvasDir(args), CHANNEL_VISUAL_PROFILE_FILE_NAME);
}

export async function readChannelVisualProfileStore(args = {}) {
  try {
    const raw = await readFile(resolveChannelVisualProfileFile(args), "utf8");
    return normalizeChannelVisualProfileStore(JSON.parse(raw));
  } catch {
    return normalizeChannelVisualProfileStore(null);
  }
}

export function getChannelVisualProfile(store, profileId = "") {
  const requested = nonEmptyString(profileId) || store?.defaultProfileId || "";
  return (store?.profiles ?? []).find((profile) => profile.id === requested) ?? null;
}

function absoluteReferencePath(canvasDir, path) {
  if (!path) return "";
  return isAbsolute(path) ? resolve(path) : resolve(canvasDir, path);
}

export async function resolveChannelVisualProfileSnapshot(args = {}, profileId = "") {
  const store = await readChannelVisualProfileStore(args);
  const profile = getChannelVisualProfile(store, profileId);
  if (!profile) return null;
  const canvasDir = resolveCanvasDir(args);
  return {
    ...profile,
    referenceImages: profile.referenceImages.map((reference) => ({
      ...reference,
      path: absoluteReferencePath(canvasDir, reference.path),
    })),
  };
}

export function normalizeChannelVisualProfileSnapshot(value) {
  if (!value || typeof value !== "object") return null;
  const profile = normalizeChannelVisualProfile(value);
  return profile.id ? profile : null;
}

export function inferChannelVisualTags(scene = {}) {
  const prompt = nonEmptyString(scene.prompt ?? scene.description).toLowerCase();
  const explicitTags = uniqueStrings(scene.styleTags ?? scene.style_tags, 30);
  const tags = new Set(explicitTags);
  if (explicitTags.length > 0) {
    if (!tags.has("night") && !tags.has("day")) tags.add("day");
    if (!tags.has("closeup") && !tags.has("wide") && !tags.has("medium")) tags.add("medium");
    return [...tags];
  }
  const rules = [
    ["interior", /office|room|bedroom|cafe|restaurant|kitchen|indoor|室内|部屋|会社|オフィス|カフェ|店内|台所/u],
    ["exterior", /street|beach|park|outside|outdoor|屋外|道路|海|公園|街/u],
    ["night", /night|evening|dark|moon|夜|夕方|深夜/u],
    ["day", /day|morning|sunny|daylight|昼|朝|晴/u],
    ["closeup", /close[- ]?up|reaction|face|表情|顔|寄り|クローズアップ/u],
    ["wide", /\bwide\b|establishing|full[- ]shot|全景|引き|ロングショット/u],
    ["action", /run|fight|shout|grab|point|action|走|叫|掴|指差|動作/u],
    ["dialogue", /talk|conversation|dialogue|two[- ]?shot|会話|対話|二人/u],
    ["character", /person|man|woman|character|人物|男性|女性|主人公/u],
  ];
  for (const [tag, pattern] of rules) if (pattern.test(prompt)) tags.add(tag);
  if (!tags.has("night") && !tags.has("day")) tags.add("day");
  if (!tags.has("closeup") && !tags.has("wide")) tags.add("medium");
  return [...tags];
}

function referenceScore(reference, tags) {
  const tagSet = new Set(tags);
  let score = reference.tags.reduce((total, tag) => total + (tagSet.has(tag) ? 12 : 0), 0);
  if (reference.tags.includes("core")) score += 8;
  if (reference.role === "style") score += 3;
  if (reference.role === "character-style" && tagSet.has("character")) score += 5;
  if (reference.role === "background" && (tagSet.has("interior") || tagSet.has("exterior"))) score += 4;
  return score;
}

export function selectChannelVisualReferences(profile, scene = {}, options = {}) {
  if (!profile) return [];
  const tags = inferChannelVisualTags(scene);
  const requestedMaximum = clampInteger(
    options.maxStyleReferences ?? options.max_style_references,
    0,
    4,
    profile.maxStyleReferences,
  );
  const characterCount = Array.isArray(scene.characterIds ?? scene.character_ids ?? scene.characters)
    ? (scene.characterIds ?? scene.character_ids ?? scene.characters).length
    : 0;
  const routeReferenceBudget = clampInteger(
    options.referenceBudget ?? options.reference_budget,
    0,
    30,
    30,
  );
  const maximum = Math.min(
    characterCount >= 3 ? Math.min(1, requestedMaximum) : requestedMaximum,
    Math.max(0, routeReferenceBudget - characterCount),
  );
  const remaining = profile.referenceImages.map((reference, index) => ({
    reference,
    index,
    score: referenceScore(reference, tags),
  }));
  const selected = [];
  const covered = new Set();
  while (selected.length < maximum && remaining.length > 0) {
    remaining.sort((left, right) => {
      const leftNewCoverage = left.reference.tags.filter((tag) => tags.includes(tag) && !covered.has(tag)).length;
      const rightNewCoverage = right.reference.tags.filter((tag) => tags.includes(tag) && !covered.has(tag)).length;
      const leftTotal = left.score + leftNewCoverage * 15;
      const rightTotal = right.score + rightNewCoverage * 15;
      return rightTotal - leftTotal || left.index - right.index;
    });
    const [{ reference }] = remaining.splice(0, 1);
    selected.push(reference);
    reference.tags.forEach((tag) => covered.add(tag));
  }
  return selected;
}

export function buildChannelVisualStylePrompt(profile, scene = {}, referenceCount = 0) {
  if (!profile) return "";
  const tags = inferChannelVisualTags(scene);
  const lines = [
    `CHANNEL VISUAL STYLE LOCK [${profile.id}] — mandatory for this frame:`,
    referenceCount > 0
      ? `The ${referenceCount} channel visual reference image${referenceCount === 1 ? " is" : "s are"} STYLE-ONLY. Match only their linework, facial-drawing grammar, cel shading, palette, lighting, background finish, lens language, and visual density. Create entirely new character identities from the script and identity references. Never copy any reference person's face, hair, clothing, age, body, text, speech balloons, or exact composition.`
      : "Follow the written channel style specification exactly.",
    profile.stylePrompt,
    profile.compositionPrompt,
    profile.shotRhythmPrompt,
    profile.continuityPrompt,
    `Scene style tags: ${tags.join(", ")}.`,
    profile.outputPrompt,
    profile.negativePrompt ? `STRICTLY AVOID: ${profile.negativePrompt}` : "",
  ].filter(Boolean);
  return lines.join("\n");
}
