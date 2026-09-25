import { execFile as execFileCallback } from "node:child_process";
import { channelPackRoots, resolveChannelPackPath, resolveChannelPackSource } from "./channelPackResolver.mjs";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { getImageDimensionsFromBuffer, resolveCanvasDir, writeJsonAtomic } from "./canvasScene.mjs";
import { withCanvasFileLock } from "./canvasFileLock.mjs";
import { validateCandidateDiversityReview, validateCharacterStylingSpec } from "./characterPipeline.mjs";
import { readCharacterRegistry, writeCharacterRegistry } from "./characterRegistry.mjs";
import { assertKoyaDeclaredProtagonist, resolveKoyaMangaProductionContract } from "./koyaMangaProductionContract.mjs";
import {
  assertKoyaAssetQualityRows,
  checkKoyaAssetQuality,
  koyaAssetQualityFailureLines,
  koyaAssetQualityWorkDir,
  writeKoyaApprovedReferences,
} from "./koyaAssetQualityGate.mjs";
import {
  KOYA_ASSET_QUALITY_GATE_VERSION,
  koyaAssetQualityFailureCode,
  koyaAssetQualityGateInForce,
  koyaAssetQualitySubjectId,
} from "./koyaAssetQualityGatePolicy.mjs";
import { detectMangaEyeOpenBeats, mangaEyeOpenUnitLabels } from "./mangaEyeOpenBeats.mjs";
import { generateImageMedia } from "./mediaGeneration.mjs";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(moduleDir, "..");
const execFile = promisify(execFileCallback);

export const KOYA_STORY_REVIEW_VERSION = "koya-story-review-v1";
export const KOYA_LOCATION_ANCHOR_REVIEW_VERSION = "koya-location-anchor-review-v1";
export const KOYA_LOCATION_REVIEW_VERSION = "koya-location-review-v3";
export const KOYA_LOCATION_GENERATION_MANIFEST_VERSION = "koya-location-generation-v2";
export const KOYA_THUMBNAIL_PLAN_VERSION = "koya-thumbnail-plan-v1";
export const KOYA_VALIDATION_CANARY_VERSION = "koya-validation-canary-v1";
export const KOYA_CHANNEL_AUTHORITY_FINGERPRINT_VERSION = "koya-channel-authority-fingerprint-v1";

const AUTHORITY_FILES = Object.freeze({
  show: "config/koya-show-bible.json",
  locations: "config/koya-location-bible.json",
  thumbnail: "config/koya-thumbnail-contract.json",
});

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function validIsoDate(value) {
  const text = nonEmpty(value);
  return Boolean(text && /^\d{4}-\d{2}-\d{2}T/u.test(text) && Number.isFinite(Date.parse(text)));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Hash the exact validated authority bytes restored into a Koya Job workspace.
 *
 * The signed envelope fingerprint protects the source bundle, but production
 * reads the restored workspace.  Keeping this snapshot in doctor evidence lets
 * the child runner detect a change made after restore/doctor and before the
 * first paid request.  Symlinks are rejected so a stable pathname cannot be
 * redirected to mutable bytes outside the isolated workspace.
 */
export async function fingerprintKoyaChannelAuthority(authority) {
  if (authority?.source !== "project") {
    throw new Error(`Koya authority fingerprint requires project authority, got ${authority?.source || "(missing)"}.`);
  }
  const projectDir = resolve(authority.projectDir || "");
  const canonicalProjectDir = await realpath(projectDir);
  const inputs = [
    { role: "show", path: authority.paths?.show },
    { role: "locations", path: authority.paths?.locations },
    { role: "thumbnail", path: authority.paths?.thumbnail },
    ...(authority.stylingSpecs || []).map((entry) => ({
      role: `styling:${nonEmpty(entry.characterId)}:${nonEmpty(entry.relativePath)}`,
      path: entry.path,
    })),
  ];
  if (inputs.some((entry) => !nonEmpty(entry.path))) {
    throw new Error("Koya authority fingerprint is missing an authority file path.");
  }
  const rows = [];
  const seenPaths = new Set();
  for (const input of inputs) {
    const absolutePath = resolve(input.path);
    if (!inside(projectDir, absolutePath)) {
      throw new Error(`Koya authority file is outside the declared isolated workspace: ${absolutePath}`);
    }
    const declaredRelativePath = relative(projectDir, absolutePath);
    const info = await lstat(absolutePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Koya authority must be a regular non-symlink file: ${absolutePath}`);
    }
    const canonicalPath = await realpath(absolutePath);
    if (!inside(canonicalProjectDir, canonicalPath)
      || canonicalPath !== resolve(canonicalProjectDir, declaredRelativePath)) {
      throw new Error(`Koya authority file escapes or redirects outside the isolated workspace: ${absolutePath}`);
    }
    const relativePath = relative(canonicalProjectDir, canonicalPath).split(sep).join("/");
    if (!relativePath || relativePath.startsWith("../") || seenPaths.has(relativePath)) {
      throw new Error(`Koya authority fingerprint contains an invalid or duplicate path: ${relativePath || absolutePath}`);
    }
    seenPaths.add(relativePath);
    const bytes = await readFile(canonicalPath);
    rows.push({
      role: input.role,
      path: relativePath,
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
    });
  }
  rows.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const payload = {
    version: KOYA_CHANNEL_AUTHORITY_FINGERPRINT_VERSION,
    fileCount: rows.length,
    files: rows,
  };
  return { ...payload, sha256: sha256(JSON.stringify(payload)) };
}

async function exists(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

async function readJsonStrict(path) {
  const source = await readFile(path, "utf8");
  if (!source.trim()) throw new Error(`Koya authority file is empty: ${path}`);
  try { return JSON.parse(source); } catch (error) {
    throw new Error(`Koya authority JSON is invalid (${path}): ${error.message}`);
  }
}

const EYE_OPEN_VARIANT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/u;
const MAX_EYE_OPEN_VARIANTS = 8;

// A member may declare several eye-open differentials. Each declared variant
// must be registered exactly once as an eye-open asset whose storyStage is the
// variant id; an unkeyed legacy eye-open sheet does not satisfy a variant.
function eyeOpenVariantCoverage(member, registered) {
  const required = (Array.isArray(member?.eyeOpenVariants) ? member.eyeOpenVariants : [])
    .map((variant) => nonEmpty(variant?.id))
    .filter(Boolean);
  const registeredVariants = (registered?.referenceAssets || [])
    .filter((asset) => asset?.role === "eye-open")
    .map((asset) => nonEmpty(asset.storyStage));
  const gaps = [];
  for (const id of required) {
    const count = registeredVariants.filter((entry) => entry === id).length;
    if (count === 0) gaps.push(`missing required approved eye-open variant '${id}'`);
    else if (count > 1) gaps.push(`registers eye-open variant '${id}' ${count} times`);
  }
  return { required, available: [...new Set(registeredVariants.filter(Boolean))], gaps };
}

function assertVersion(value, expected, label) {
  if (value?.version !== expected) throw new Error(`${label} version must be ${expected}.`);
}

const REQUIRED_STORY_CAST_SEMANTICS = Object.freeze([
  "recurringEyeOpen",
  "exitBlocker",
  "episodeRoleWardrobe",
  "reversalSignal",
]);

/**
 * Resolve channel-specific cast identities from the signed show bible.
 *
 * Runtime code deliberately knows only semantic roles. The actual cast IDs and
 * the channel's review-beat names belong to the Channel Pack, otherwise adding
 * another operator would require publishing their roster in this shared file.
 */
function resolveStoryCastSemantics(showBible, cast) {
  const declarations = showBible?.storyGrammar?.castSemantics;
  if (!declarations || typeof declarations !== "object" || Array.isArray(declarations)) {
    throw new Error("Show bible storyGrammar.castSemantics is required.");
  }
  const resolved = {};
  for (const semantic of REQUIRED_STORY_CAST_SEMANTICS) {
    const declaration = declarations[semantic];
    if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) {
      throw new Error(`Show bible storyGrammar.castSemantics.${semantic} must be an object with castId.`);
    }
    const castId = nonEmpty(declaration.castId);
    if (!castId) throw new Error(`Show bible storyGrammar.castSemantics.${semantic}.castId is required.`);
    resolved[semantic] = {
      castId,
      reviewBeat: nonEmpty(declaration.reviewBeat),
    };
  }

  const semanticCastIds = REQUIRED_STORY_CAST_SEMANTICS.map((semantic) => resolved[semantic].castId);
  if (new Set(semanticCastIds).size !== semanticCastIds.length) {
    throw new Error("Show bible storyGrammar.castSemantics must reference distinct cast IDs.");
  }
  const castById = new Map(cast.map((member) => [member.id, member]));
  for (const semantic of REQUIRED_STORY_CAST_SEMANTICS) {
    if (!castById.has(resolved[semantic].castId)) {
      throw new Error(`Show bible storyGrammar.castSemantics.${semantic}.castId does not exist in cast.`);
    }
  }

  const requiredBeats = Array.isArray(showBible?.storyReview?.requiredBeats)
    ? showBible.storyReview.requiredBeats.map(nonEmpty)
    : [];
  if (requiredBeats.length === 0 || requiredBeats.some((beat) => !beat)
    || new Set(requiredBeats).size !== requiredBeats.length) {
    throw new Error("Show bible storyReview.requiredBeats must contain unique non-empty beat names.");
  }
  const signalBeat = resolved.reversalSignal.reviewBeat;
  const expectedRequiredBeats = ["attack1", "attack2", "attack3", signalBeat, "evidence", "protagonistFinish"];
  if (!signalBeat || requiredBeats.length !== expectedRequiredBeats.length
    || requiredBeats.some((beat, index) => beat !== expectedRequiredBeats[index])) {
    throw new Error("Show bible reversalSignal.reviewBeat must occupy its exact position in the six required ordered story-review beats.");
  }
  const exitBeat = resolved.exitBlocker.reviewBeat;
  if (!exitBeat || exitBeat !== nonEmpty(showBible?.storyReview?.optionalBeatWhenCastAppears)
    || requiredBeats.includes(exitBeat) || exitBeat === signalBeat) {
    throw new Error("Show bible exitBlocker.reviewBeat must match the distinct optional story-review beat.");
  }
  return {
    ...resolved,
    requiredBeats,
    optionalBeat: exitBeat,
    castById,
  };
}

function nonEmptyStringList(value, label, { minimum = 1 } = {}) {
  const list = (Array.isArray(value) ? value : []).map(nonEmpty).filter(Boolean);
  if (list.length < minimum) throw new Error(`${label} must contain at least ${minimum} non-empty line(s).`);
  if (new Set(list).size !== list.length) throw new Error(`${label} must not repeat a line.`);
  return list;
}

/**
 * 画風はチャンネルの属性であって、生成器ごとの属性ではない。
 *
 * ここが無かったあいだ、キャラクターのプロンプト組み立てだけが画風の文章を
 * 抱えていて、ロケーションボードには画風の指示が一行も入っていなかった。
 * 結果として同じチャンネルの中で、人物は2Dの漫画、背景は写実的な建築CGという
 * 同居できない2つの画になった。宣言をここに1つ置き、人物・ロケーション・
 * サムネイルがそこから引く形にする。
 *
 * 文章そのものはチャンネル固有なので channel pack 側（番組正本）に置く。
 * 共有層はこの構造を検証して読むだけで、特定チャンネルの画風を知らない。
 */
export function validateKoyaChannelArtStyle(showBible) {
  const artStyle = showBible?.artStyle;
  if (!artStyle || typeof artStyle !== "object" || Array.isArray(artStyle)) {
    throw new Error("Show bible artStyle is required: the channel must declare one art style that characters, locations, and thumbnails all draw from.");
  }
  const id = nonEmpty(artStyle.id);
  if (!id) throw new Error("Show bible artStyle.id is required so a generated asset can name the style it was built under.");
  const medium = nonEmpty(artStyle.medium);
  if (!medium) throw new Error("Show bible artStyle.medium is required; it is the sentence that tells an image model this is drawn artwork rather than a photograph.");
  const sharedIdiom = nonEmptyStringList(artStyle.sharedIdiom, "Show bible artStyle.sharedIdiom");
  const environmentIdiom = nonEmptyStringList(artStyle.environmentIdiom, "Show bible artStyle.environmentIdiom");
  const characterIdiom = nonEmptyStringList(artStyle.characterIdiom, "Show bible artStyle.characterIdiom");
  const forbidden = nonEmptyStringList(artStyle.forbidden, "Show bible artStyle.forbidden");

  const styleReference = artStyle.styleReference;
  if (styleReference !== undefined && (!styleReference || typeof styleReference !== "object" || Array.isArray(styleReference))) {
    throw new Error("Show bible artStyle.styleReference must be an object when present.");
  }
  const declaredPaths = Array.isArray(styleReference?.paths) ? styleReference.paths.map(nonEmpty).filter(Boolean) : [];
  if (declaredPaths.length > 0 && !nonEmpty(styleReference?.policy)) {
    throw new Error("Show bible artStyle.styleReference.policy is required whenever style reference paths are declared.");
  }
  if (nonEmpty(styleReference?.policy) && nonEmpty(styleReference?.policy) !== "style-only") {
    throw new Error("Show bible artStyle.styleReference.policy must be 'style-only'; a reference that is allowed to carry architecture is not a style reference.");
  }
  const maximum = styleReference?.maximum === undefined ? 4 : Number(styleReference.maximum);
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 4) {
    throw new Error("Show bible artStyle.styleReference.maximum must be an integer between 1 and 4.");
  }
  if (new Set(declaredPaths).size !== declaredPaths.length) throw new Error("Show bible artStyle.styleReference.paths must not repeat a path.");
  if (declaredPaths.length > maximum) throw new Error(`Show bible artStyle.styleReference.paths declares more than the ${maximum} references it allows.`);
  for (const path of declaredPaths) {
    // 宣言は project-relative に限る。stylingSpecPaths と同じ理由で、
    // 宣言側に絶対パスを許すと脱出検査そのものが意味を失う。
    if (isAbsolute(path) || path.split("/").includes("..")) {
      throw new Error(`Show bible artStyle.styleReference.paths must stay project-relative without '..': ${path}`);
    }
  }
  return { pass: true, id, styleReferenceCount: declaredPaths.length, maximum, sharedIdiom, characterIdiom, environmentIdiom, forbidden, medium };
}

export function validateKoyaShowBible(showBible) {
  assertVersion(showBible, "koya-show-bible-v1", "Show bible");
  if (!nonEmpty(showBible?.channel?.name)) throw new Error("Show bible channel.name is required.");
  validateKoyaChannelArtStyle(showBible);
  if (!nonEmpty(showBible?.world?.town) || !nonEmpty(showBible?.world?.homeBase)) {
    throw new Error("Show bible fictional town and home base are required.");
  }
  const cast = Array.isArray(showBible?.cast) ? showBible.cast : [];
  if (cast.length === 0) throw new Error("Show bible cast must not be empty.");
  const ids = new Set();
  for (const member of cast) {
    if (!nonEmpty(member?.id) || !nonEmpty(member?.name) || !nonEmpty(member?.role) || !nonEmpty(member?.designStatus)) {
      throw new Error("Every show-bible cast member requires id, name, role, and designStatus.");
    }
    if (ids.has(member.id)) throw new Error(`Duplicate show-bible cast id: ${member.id}`);
    ids.add(member.id);
    const referenceRoles = Array.isArray(member.requiredReferenceRoles) ? member.requiredReferenceRoles : [];
    if (referenceRoles.some((role) => !["identity-face", "turnaround", "expression", "eye-open", "outfit"].includes(role))) {
      throw new Error(`${member.id}.requiredReferenceRoles contains an unsupported role.`);
    }
    if (member.requiredReferenceRoles?.includes("outfit") && (!Array.isArray(member.outfitStages) || member.outfitStages.length < 2)) {
      throw new Error(`${member.id} requires at least two explicit outfitStages when outfit evidence is mandatory.`);
    }
    if (Array.isArray(member.outfitStages)) {
      const stageIds = member.outfitStages.map((stage) => nonEmpty(stage?.id));
      if (stageIds.some((id) => !id) || new Set(stageIds).size !== stageIds.length
        || member.outfitStages.some((stage) => !nonEmpty(stage?.label) || !nonEmpty(stage?.description))) {
        throw new Error(`${member.id}.outfitStages require unique ids, labels, and descriptions.`);
      }
      for (const stage of member.outfitStages) {
        const referenceAssetFile = nonEmpty(stage?.referenceAssetFile);
        const referenceAssetSha256 = nonEmpty(stage?.referenceAssetSha256);
        if (Boolean(referenceAssetFile) !== Boolean(referenceAssetSha256)
          || (referenceAssetSha256 && !/^[a-f0-9]{64}$/u.test(referenceAssetSha256))) {
          throw new Error(`${member.id}.outfitStages.${stage.id} requires a paired referenceAssetFile and lowercase SHA-256.`);
        }
      }
    }
    if (member.eyeOpenVariants !== undefined) {
      const variants = Array.isArray(member.eyeOpenVariants) ? member.eyeOpenVariants : [];
      if (variants.length === 0 || variants.length > MAX_EYE_OPEN_VARIANTS) {
        throw new Error(`${member.id}.eyeOpenVariants must list 1-${MAX_EYE_OPEN_VARIANTS} variants when declared.`);
      }
      if (!referenceRoles.includes("eye-open")) {
        throw new Error(`${member.id}.eyeOpenVariants requires requiredReferenceRoles to include eye-open.`);
      }
      const variantIds = variants.map((variant) => nonEmpty(variant?.id));
      if (variantIds.some((id) => !EYE_OPEN_VARIANT_ID_PATTERN.test(id)) || new Set(variantIds).size !== variantIds.length
        || variants.some((variant) => !nonEmpty(variant?.label) || !nonEmpty(variant?.description))) {
        throw new Error(`${member.id}.eyeOpenVariants require unique lowercase slug ids, labels, and descriptions.`);
      }
      for (const variant of variants) {
        if (variant.cues !== undefined && (!Array.isArray(variant.cues) || variant.cues.some((cue) => !nonEmpty(cue)))) {
          throw new Error(`${member.id}.eyeOpenVariants.${variant.id}.cues must be non-empty strings.`);
        }
        const assets = variant.referenceAssets === undefined ? [] : variant.referenceAssets;
        if (!Array.isArray(assets) || assets.length > 4
          || assets.some((asset) => !nonEmpty(asset?.path) || !/^[a-f0-9]{64}$/u.test(nonEmpty(asset?.sha256)))) {
          throw new Error(`${member.id}.eyeOpenVariants.${variant.id}.referenceAssets require at most four paths, each with a lowercase SHA-256.`);
        }
      }
    }
    const declaredStylingSpecs = Array.isArray(member.stylingSpecPaths) && member.stylingSpecPaths.length > 0
      ? member.stylingSpecPaths
      : [member.stylingSpecPath].filter(Boolean);
    if (declaredStylingSpecs.length > 0 && !/^[A-E]$/u.test(nonEmpty(member.selectedBaseLabel))) {
      throw new Error(`${member.id}.selectedBaseLabel A..E is required when styling rounds branch from a human-selected candidate.`);
    }
    if (member.designStatus === "human-selected-awaiting-identity-pack" && !/^[A-E]$/u.test(nonEmpty(member.selectedLabel))) {
      throw new Error(`${member.id}.selectedLabel A..E is required for a human-selected design.`);
    }
  }
  const reversal = showBible?.storyGrammar?.reversal;
  if (!Array.isArray(reversal) || reversal.length !== 4) throw new Error("Show bible requires the four-step reversal grammar.");
  if (showBible?.storyReview?.version !== KOYA_STORY_REVIEW_VERSION
    || showBible?.storyReview?.bindToExactScriptSha256 !== true
    || showBible?.storyReview?.requireIndependentReviewerContext !== true) {
    throw new Error("Show bible must require the SHA-bound independent story review.");
  }
  const semantics = resolveStoryCastSemantics(showBible, cast);
  const recurringEyeOpen = semantics.castById.get(semantics.recurringEyeOpen.castId);
  const exitBlocker = semantics.castById.get(semantics.exitBlocker.castId);
  const episodeRoleWardrobe = semantics.castById.get(semantics.episodeRoleWardrobe.castId);
  if (recurringEyeOpen?.requiredEveryEpisode !== true || !recurringEyeOpen?.requiredReferenceRoles?.includes("eye-open")) {
    throw new Error("Show bible recurringEyeOpen cast member must be required every episode and provide an eye-open asset.");
  }
  if (!exitBlocker?.requiredReferenceRoles?.includes("eye-open")) {
    throw new Error("Show bible exitBlocker cast member must provide an eye-open asset.");
  }
  if (episodeRoleWardrobe?.episodeRoleSelectionRequired !== true || !episodeRoleWardrobe?.requiredReferenceRoles?.includes("outfit")) {
    throw new Error("Show bible episodeRoleWardrobe cast member must require an episode role and outfit evidence.");
  }
  const rosterReview = showBible?.rosterReview;
  if (rosterReview?.version !== "koya-character-roster-review-v1"
    || rosterReview?.requiredBeforeEpisodeProduction !== true
    || rosterReview?.requiredMemberCount !== 11
    || rosterReview?.requiredPairCount !== 55
    || rosterReview?.requireIndependentReviewerContext !== true
    || rosterReview?.requireOriginalScaleInspection !== true
    || rosterReview?.requireThumbnailScaleInspection !== true
    || !["silhouetteDistinct", "faceAgeRoleDistinct", "hairOutfitColorNotConfusing", "thumbnailScaleDistinct"].every((key) => rosterReview?.requiredPairChecks?.includes(key))) {
    throw new Error("Show bible must require the complete SHA-bound independent 11-member roster review before episode production.");
  }
  return { pass: true, castCount: cast.length, version: showBible.version };
}

function showBibleMemberMatches(member, value) {
  const id = nonEmpty(value?.id ?? value?.speakerId);
  const name = nonEmpty(value?.name ?? value?.speakerName ?? value);
  return [member.id, member.name, member.hiddenName].filter(Boolean).includes(id)
    || [member.id, member.name, member.hiddenName].filter(Boolean).includes(name);
}

/**
 * Resolve the deliberately narrow escape hatch used for a one-off, non-public
 * quality preview while the complete fixed-cast roster is still unfinished.
 * The policy lives in an episode-bound override file; there is no global flag
 * and no environment variable that can silently weaken normal production.
 */
export function resolveKoyaValidationCanary(options = {}) {
  const policy = options.policy && typeof options.policy === "object" ? options.policy : null;
  if (!policy) {
    return {
      version: KOYA_VALIDATION_CANARY_VERSION,
      active: false,
      pass: true,
      publicationEligible: true,
      failures: [],
    };
  }
  const showBible = options.showBible;
  validateKoyaShowBible(showBible);
  const episodeId = nonEmpty(options.episodeId);
  const allowedCastIds = [...new Set((Array.isArray(policy.allowedCastIds) ? policy.allowedCastIds : []).map(nonEmpty).filter(Boolean))];
  const omittedRequiredEveryEpisodeIds = [...new Set((Array.isArray(policy.omittedRequiredEveryEpisodeIds)
    ? policy.omittedRequiredEveryEpisodeIds
    : []).map(nonEmpty).filter(Boolean))];
  const provisionalVoiceProfileByCastId = policy.provisionalVoiceProfileByCastId
    && typeof policy.provisionalVoiceProfileByCastId === "object"
    && !Array.isArray(policy.provisionalVoiceProfileByCastId)
    ? Object.fromEntries(Object.entries(policy.provisionalVoiceProfileByCastId)
      .map(([id, profileId]) => [nonEmpty(id), nonEmpty(profileId)])
      .filter(([id, profileId]) => id && profileId))
    : {};
  const memberById = new Map((showBible.cast || []).map((member) => [member.id, member]));
  const failures = [];
  if (policy.version !== KOYA_VALIDATION_CANARY_VERSION) failures.push(`Validation canary version must be ${KOYA_VALIDATION_CANARY_VERSION}.`);
  if (policy.enabled !== true) failures.push("Validation canary must set enabled=true.");
  if (!episodeId || policy.episodeId !== episodeId || !/canary/iu.test(episodeId)) failures.push("Validation canary must bind the exact canary episode ID.");
  if (policy.scope !== "one-off-non-public-quality-preview") failures.push("Validation canary scope must be one-off-non-public-quality-preview.");
  if (policy.publicationEligible !== false) failures.push("Validation canary must be explicitly non-publication-eligible.");
  if (policy.requireExactAllowedCast !== true) failures.push("Validation canary must require the exact allowed cast.");
  if (policy.allowIncompleteRosterReview !== true) failures.push("Validation canary must explicitly acknowledge the incomplete roster review.");
  if (!nonEmpty(policy.reason)) failures.push("Validation canary requires a concrete reason.");
  if (allowedCastIds.length === 0) failures.push("Validation canary requires at least one allowed cast ID.");
  for (const id of allowedCastIds) {
    const member = memberById.get(id);
    if (!member) failures.push(`Validation canary contains unknown cast ID: ${id}`);
    else if (member.designStatus !== "approved") failures.push(`Validation canary cannot admit unapproved cast member ${member.name} (${id}).`);
  }
  for (const id of omittedRequiredEveryEpisodeIds) {
    const member = memberById.get(id);
    if (!member || member.requiredEveryEpisode !== true) failures.push(`Validation canary may omit only a requiredEveryEpisode cast member: ${id}`);
    if (allowedCastIds.includes(id)) failures.push(`Validation canary cannot both allow and omit cast member: ${id}`);
  }
  for (const member of showBible.cast || []) {
    if (member.requiredEveryEpisode === true
      && !allowedCastIds.includes(member.id)
      && !omittedRequiredEveryEpisodeIds.includes(member.id)) {
      failures.push(`Validation canary must explicitly list omitted required cast member ${member.name} (${member.id}).`);
    }
  }
  for (const id of Object.keys(provisionalVoiceProfileByCastId)) {
    if (!allowedCastIds.includes(id)) failures.push(`Validation canary voice mapping targets a cast member outside allowedCastIds: ${id}`);
  }
  return {
    version: KOYA_VALIDATION_CANARY_VERSION,
    active: true,
    pass: failures.length === 0,
    episodeId,
    scope: nonEmpty(policy.scope),
    publicationEligible: false,
    requireExactAllowedCast: policy.requireExactAllowedCast === true,
    allowIncompleteRosterReview: policy.allowIncompleteRosterReview === true,
    allowedCastIds,
    omittedRequiredEveryEpisodeIds,
    provisionalVoiceProfileByCastId,
    reason: nonEmpty(policy.reason),
    failures,
  };
}

function approvedRegistryCharacterForMember(registry, member) {
  return (registry?.characters || []).find((character) => (
    character?.status === "approved"
    && character?.kind === "character"
    && (
      character.id === member.id
      || character.name === member.name
      || character.name === member.hiddenName
      || (character.aliases || []).some((alias) => alias === member.name || alias === member.hiddenName)
    )
  )) || null;
}

export function auditKoyaFixedCastReadiness(options = {}) {
  const showBible = options.showBible;
  validateKoyaShowBible(showBible);
  const parsed = options.parsed;
  if (!parsed || !Array.isArray(parsed.utterances)) throw new Error("Parsed manga script is required for Koya fixed-cast readiness.");
  const declaredCast = Array.isArray(options.characterBible?.cast)
    ? options.characterBible.cast
    : Array.isArray(options.declaredCast) ? options.declaredCast : [];
  const activeIds = new Set();
  for (const member of showBible.cast || []) {
    if (parsed.utterances.some((utterance) => showBibleMemberMatches(member, utterance))) activeIds.add(member.id);
    if (declaredCast.some((entry) => showBibleMemberMatches(member, entry))) activeIds.add(member.id);
  }
  // auditKoyaStory と同じ理由でここも閉じる。pack が選ばれているのに
  // 誰も検出できないのは、免除ではなく台本かキャスト表記の異常。
  const castDetected = activeIds.size > 0;
  const active = options.enforce === true || castDetected;
  const failures = [];
  const validationCanary = options.validationCanary?.active === true ? options.validationCanary : null;
  if (validationCanary && validationCanary.pass !== true) {
    failures.push(`Validation canary policy is invalid: ${(validationCanary.failures || []).join("; ")}`);
  }
  if (active && !castDetected) {
    failures.push("Channel Pack が選択されているのに、台本にも人物台帳にも固定キャストが一人も現れない。キャスト未検出を理由に配役ゲートを外すことはしない。");
  }
  if (active
    && showBible?.rosterReview?.requiredBeforeEpisodeProduction === true
    && options.rosterReviewAudit?.pass !== true
    && !(validationCanary?.pass === true && validationCanary.allowIncompleteRosterReview === true)) {
    failures.push(`Fixed-cast roster review is not approved: ${(options.rosterReviewAudit?.failures || ["review missing"]).join("; ")}`);
  }
  if (active) {
    for (const member of showBible.cast || []) {
      if (member.requiredEveryEpisode === true
        && !activeIds.has(member.id)
        && !(validationCanary?.pass === true && validationCanary.omittedRequiredEveryEpisodeIds.includes(member.id))) {
        failures.push(`${member.name} (${member.id}) must be declared in every episode, including silent appearances.`);
      }
    }
  }
  if (active && validationCanary?.pass === true) {
    const allowed = new Set(validationCanary.allowedCastIds);
    const unexpected = [...activeIds].filter((id) => !allowed.has(id));
    const missing = validationCanary.requireExactAllowedCast
      ? validationCanary.allowedCastIds.filter((id) => !activeIds.has(id))
      : [];
    if (unexpected.length > 0) failures.push(`Validation canary contains cast outside allowedCastIds: ${unexpected.join(", ")}`);
    if (missing.length > 0) failures.push(`Validation canary is missing required approved cast: ${missing.join(", ")}`);
  }
  const rows = [];
  for (const member of (showBible.cast || []).filter((entry) => activeIds.has(entry.id))) {
    const declared = declaredCast.find((entry) => showBibleMemberMatches(member, entry));
    const registered = approvedRegistryCharacterForMember(options.registry, member);
    const requiredRoles = Array.isArray(member.requiredReferenceRoles) && member.requiredReferenceRoles.length > 0
      ? member.requiredReferenceRoles
      : ["identity-face", "turnaround", "expression"];
    const availableRoles = new Set((registered?.referenceAssets || []).map((asset) => asset.role));
    const eyeOpenVariants = eyeOpenVariantCoverage(member, registered);
    if (member.designStatus === "on-hold") failures.push(`${member.name} is on hold in the show bible and cannot enter an episode.`);
    if (!registered) failures.push(`${member.name} (${member.id}) is not an approved registered fixed character; current designStatus=${member.designStatus}. Do not generate an episode-local replacement.`);
    else {
      for (const role of requiredRoles) if (!availableRoles.has(role)) failures.push(`${member.name} is missing required approved reference role '${role}'.`);
      for (const gap of eyeOpenVariants.gaps) failures.push(`${member.name} ${gap}.`);
      if (!nonEmpty(registered?.approval?.identityReviewPath) || !/^[a-f0-9]{64}$/u.test(nonEmpty(registered?.approval?.identityReviewSha256))) failures.push(`${member.name} is missing SHA-bound identity review provenance.`);
    }
    if (member.episodeRoleSelectionRequired === true && !["ally", "antagonist"].includes(nonEmpty(declared?.episodeRole))) {
      failures.push(`${member.name} requires characterBible.cast[].episodeRole = ally or antagonist for this episode.`);
    }
    rows.push({
      id: member.id,
      name: member.name,
      designStatus: member.designStatus,
      declared: Boolean(declared),
      registeredCharacterId: registered?.id || "",
      requiredReferenceRoles: requiredRoles,
      availableReferenceRoles: [...availableRoles],
      requiredEyeOpenVariants: eyeOpenVariants.required,
      availableEyeOpenVariants: eyeOpenVariants.available,
      episodeRole: nonEmpty(declared?.episodeRole),
    });
  }
  return {
    version: "koya-fixed-cast-readiness-v1",
    active,
    pass: failures.length === 0,
    activeCastIds: [...activeIds],
    rows,
    validationCanary: validationCanary ? {
      version: validationCanary.version,
      active: true,
      episodeId: validationCanary.episodeId,
      scope: validationCanary.scope,
      publicationEligible: false,
      allowedCastIds: validationCanary.allowedCastIds,
      omittedRequiredEveryEpisodeIds: validationCanary.omittedRequiredEveryEpisodeIds,
      reason: validationCanary.reason,
    } : { active: false, publicationEligible: true },
    failures,
  };
}

export async function auditKoyaCharacterBootstrap(options = {}) {
  const showBible = options.showBible;
  validateKoyaShowBible(showBible);
  const workflows = Array.isArray(options.workflowStore?.workflows) ? options.workflowStore.workflows : [];
  const rows = [];
  const blockers = [];
  for (const member of showBible.cast || []) {
    const registered = approvedRegistryCharacterForMember(options.registry, member);
    const matches = workflows.flatMap((workflow) => (workflow.cast || [])
      .filter((cast) => showBibleMemberMatches(member, cast))
      .map((cast) => ({ workflow, cast })))
      .sort((left, right) => String(right.workflow.updatedAt || "").localeCompare(String(left.workflow.updatedAt || "")));
    const latest = matches[0] || null;
    const baseLabel = nonEmpty(member.selectedBaseLabel || member.selectedLabel);
    const baseCandidate = latest?.cast?.candidates?.find((candidate) => candidate.blindLabel === baseLabel) || null;
    const baseAssetExists = Boolean(baseCandidate?.assetFile && await exists(baseCandidate.assetFile));
    let candidateReviewPass = false;
    let candidateReviewFailure = "";
    const candidateReviewPath = nonEmpty(latest?.cast?.candidateReviewPath || latest?.cast?.candidateReviewDraftPath);
    if (latest && candidateReviewPath) {
      try {
        const result = await validateCandidateDiversityReview({
          reviewPath: candidateReviewPath,
          workflow: latest.workflow,
          cast: latest.cast,
        });
        candidateReviewPass = result.review?.pass === true;
      } catch (error) {
        candidateReviewFailure = error.message;
      }
    }
    const declaredSpecs = Array.isArray(member.stylingSpecPaths) && member.stylingSpecPaths.length > 0
      ? member.stylingSpecPaths
      : [member.stylingSpecPath].filter(Boolean);
    const selectedRounds = (latest?.cast?.stylingVariationRounds || []).filter((round) => round.status === "selected");
    const activeStylingRound = [...(latest?.cast?.stylingVariationRounds || [])].reverse().find((round) => (
      ["planned", "generating", "awaiting-review", "reviewed", "awaiting-selection"].includes(round.status)
    ));
    const requiredRoles = Array.isArray(member.requiredReferenceRoles) && member.requiredReferenceRoles.length > 0
      ? member.requiredReferenceRoles
      : ["identity-face", "turnaround", "expression"];
    const availableRoles = [...new Set((registered?.referenceAssets || []).map((asset) => asset.role))];
    const eyeOpenVariants = eyeOpenVariantCoverage(member, registered);
    let stage = "identity-pack-required";
    let nextAction = "Generate and independently review the real identity pack.";
    if (member.designStatus === "on-hold") {
      stage = "on-hold";
      nextAction = "Wait for an explicit human design decision; do not generate or register.";
    } else if (registered) {
      stage = requiredRoles.every((role) => availableRoles.includes(role)) && eyeOpenVariants.gaps.length === 0
        ? "approved"
        : "registered-evidence-incomplete";
      nextAction = stage === "approved" ? "No bootstrap action." : "Repair the approved registry evidence before episode use.";
    } else if (!latest) {
      stage = "workflow-missing";
      nextAction = "Create or migrate the fixed-cast workflow without selecting a replacement identity.";
    } else if (!baseLabel) {
      stage = candidateReviewPass ? "human-candidate-selection-required" : "candidate-review-required";
      nextAction = candidateReviewPass
        ? "A human must select one reviewed anonymous candidate and record the concrete reason."
        : "Complete the independent original-scale candidate diversity review before any selection.";
    } else if (!baseCandidate || !baseAssetExists) {
      stage = "selected-base-missing";
      nextAction = `Restore the human-selected anonymous base ${baseLabel || "A..E"} and its actual image bytes.`;
    } else if (!candidateReviewPass) {
      stage = "candidate-review-required";
      nextAction = "Complete the independent original-scale candidate diversity review.";
    } else if (selectedRounds.length < declaredSpecs.length) {
      stage = activeStylingRound ? `styling-${activeStylingRound.status}` : "styling-round-required";
      nextAction = activeStylingRound
        ? `Resume or finish styling round ${activeStylingRound.id}.`
        : `Run declared styling spec ${declaredSpecs[selectedRounds.length]}.`;
    } else if (latest.cast.status === "awaiting-identity-qa" || latest.cast.identityReviewDraftPath) {
      stage = "identity-review-required";
      const reviewParts = ["eight-view turnaround", "twelve-cell expression"];
      if (requiredRoles.includes("outfit")) reviewParts.push("every required outfit stage");
      if (requiredRoles.includes("eye-open")) {
        reviewParts.push(eyeOpenVariants.required.length > 0
          ? `every eye-open variant (${eyeOpenVariants.required.join(", ")})`
          : "eye-open differential");
      }
      nextAction = `Complete independent original-scale QA for ${reviewParts.join(", ")}, then register.`;
    }
    const blocking = !["approved", "on-hold"].includes(stage);
    if (blocking) blockers.push(`${member.name}: ${stage}`);
    rows.push({
      id: member.id,
      name: member.name,
      designStatus: member.designStatus,
      selectedBaseLabel: baseLabel,
      workflowId: latest?.workflow?.id || "",
      workflowCastId: latest?.cast?.id || "",
      workflowStatus: latest?.cast?.status || "",
      baseCandidateAsset: baseCandidate?.assetFile || "",
      baseAssetExists,
      candidateReviewPath,
      candidateReviewPass,
      candidateReviewFailure,
      declaredStylingSpecCount: declaredSpecs.length,
      selectedStylingRoundCount: selectedRounds.length,
      activeStylingRound: activeStylingRound?.id || "",
      registeredCharacterId: registered?.id || "",
      requiredReferenceRoles: requiredRoles,
      availableReferenceRoles: availableRoles,
      requiredEyeOpenVariants: eyeOpenVariants.required,
      availableEyeOpenVariants: eyeOpenVariants.available,
      stage,
      nextAction,
    });
  }
  return {
    version: "koya-character-bootstrap-status-v1",
    pass: blockers.length === 0,
    approvedCount: rows.filter((row) => row.stage === "approved").length,
    onHoldCount: rows.filter((row) => row.stage === "on-hold").length,
    blockingCount: blockers.length,
    rows,
    blockers,
  };
}

/**
 * 背景ボードの文字方針。既定の "none" は読める文字を一切認めない。
 * 商店街のように架空の店名看板があって当然の場所だけが
 * "fictional-signage-allowed" を宣言し、そのときに限り
 * readableTextAbsent を readableTextFictionalOnly（最小限の架空看板だけ、
 * 実在の名前・ブランドなし）へ置き換える。他の確認項目は変えない。
 */
export const KOYA_LOCATION_TEXT_POLICIES = Object.freeze(["none", "fictional-signage-allowed"]);
const MAX_LOCATION_ALIASES = 20;

export function koyaLocationTextPolicy(location) {
  return location?.textPolicy === undefined ? "none" : location.textPolicy;
}

function locationAllowsFictionalSignage(location) {
  return koyaLocationTextPolicy(location) === "fictional-signage-allowed";
}

/** 各ボードの本審査で true が必要な確認項目（順序は下書きの JSON にそのまま出る）。 */
export function koyaLocationBoardCheckKeys(location) {
  return [
    "containsPeopleFalse",
    locationAllowsFictionalSignage(location) ? "readableTextFictionalOnly" : "readableTextAbsent",
    "realBrandsAbsent",
    "architectureLockPass",
    "originalScalePass",
  ];
}

/** アンカー審査で true が必要な確認項目。 */
export function koyaLocationAnchorCheckKeys(location) {
  return [...koyaLocationBoardCheckKeys(location), "continuitySourceApproved"];
}

/**
 * 台本の場面見出しに書かれた場所名を登録済みロケーションへ結ぶ別名。
 * 画像計画は id・name・aliases のどれかが場面の場所名と一致したときだけ
 * 登録ボードを参照に使うので、別名が無いと見出しの書き方ひとつで
 * 登録済みの場所が使われなくなる。
 */
export function koyaLocationAliases(location) {
  return Array.isArray(location?.aliases) ? [...location.aliases] : [];
}

function locationBibleEntry(locationBible, locationId) {
  return (Array.isArray(locationBible?.locations) ? locationBible.locations : []).find((entry) => entry?.id === locationId) || null;
}

export function validateKoyaLocationBible(locationBible) {
  assertVersion(locationBible, "koya-location-bible-v1", "Location bible");
  if (locationBible?.reviewContract?.version !== KOYA_LOCATION_REVIEW_VERSION
    || locationBible?.reviewContract?.anchorReviewVersion !== KOYA_LOCATION_ANCHOR_REVIEW_VERSION
    || locationBible?.reviewContract?.generationManifestVersion !== KOYA_LOCATION_GENERATION_MANIFEST_VERSION
    || locationBible?.reviewContract?.requireGenerationManifestSha256 !== true
    || locationBible?.reviewContract?.requireAnchorReviewBeforeContinuity !== true
    || locationBible?.reviewContract?.requireIndependentReviewerContext !== true
    || locationBible?.reviewContract?.requireDistinctSha256PerBoard !== true) {
    throw new Error("Location bible must require independent, distinct-SHA board review.");
  }
  const locations = Array.isArray(locationBible?.locations) ? locationBible.locations : [];
  if (locations.length === 0) throw new Error("Location bible must contain locations.");
  const ids = new Set();
  // 場所名（id・name・別名）は1つのロケーションにしか結ばない。2つに結ぶと、
  // 場面の場所名がどちらの登録ボードを使うかが登録簿の並び順で決まってしまう。
  const placeOwners = new Map();
  for (const location of locations) {
    if (!nonEmpty(location?.id) || !nonEmpty(location?.name)) throw new Error("Every location requires id and name.");
    if (ids.has(location.id)) throw new Error(`Duplicate Koya location id: ${location.id}`);
    ids.add(location.id);
    if (!Array.isArray(location.requiredBoards) || location.requiredBoards.length !== 4) {
      throw new Error(`${location.id} must define exactly four required boards.`);
    }
    if (!Array.isArray(location.generationRules) || location.generationRules.length === 0) {
      throw new Error(`${location.id} must define generation rules.`);
    }
    if (!KOYA_LOCATION_TEXT_POLICIES.includes(koyaLocationTextPolicy(location))) {
      throw new Error(`${location.id}.textPolicy must be one of: ${KOYA_LOCATION_TEXT_POLICIES.join(", ")}.`);
    }
    if (location.aliases !== undefined) {
      if (!Array.isArray(location.aliases) || location.aliases.length > MAX_LOCATION_ALIASES) {
        throw new Error(`${location.id}.aliases must be an array of at most ${MAX_LOCATION_ALIASES} place names.`);
      }
      const seenAliases = new Set();
      for (const alias of location.aliases) {
        // 登録簿は前後の空白を落として保存する。ここで同じ正規化を要求しないと、
        // 宣言と登録簿の値が食い違い、場面の場所名と一致しなくなる。
        if (typeof alias !== "string" || !alias.trim() || alias !== alias.trim()) {
          throw new Error(`${location.id}.aliases must contain non-empty place names without surrounding whitespace.`);
        }
        if (seenAliases.has(alias)) throw new Error(`${location.id}.aliases contains a duplicate: ${alias}`);
        seenAliases.add(alias);
      }
    }
    for (const placeName of new Set([location.id, location.name, ...koyaLocationAliases(location)])) {
      const owner = placeOwners.get(placeName);
      if (owner && owner !== location.id) {
        throw new Error(`Place name '${placeName}' is claimed by both ${owner} and ${location.id}; a scene place must resolve to exactly one location.`);
      }
      placeOwners.set(placeName, location.id);
    }
  }
  return { pass: true, locationCount: locations.length, version: locationBible.version };
}

export function validateKoyaThumbnailContract(contract) {
  assertVersion(contract, "koya-thumbnail-contract-v1", "Thumbnail contract");
  if (contract?.canvas?.width !== 1280 || contract?.canvas?.height !== 720) {
    throw new Error("Koya thumbnail canvas must be 1280x720.");
  }
  if (contract?.sourcePolicy?.dedicatedThumbnailArtworkRequired !== true
    || contract?.sourcePolicy?.mainVideoFrameReuseForbidden !== true) {
    throw new Error("Koya thumbnail contract must require dedicated, non-reused artwork.");
  }
  if (contract?.copy?.band?.lines !== 2 || contract?.copy?.band?.maxCharactersPerLine !== 15) {
    throw new Error("Koya thumbnail band must remain two lines of at most 15 characters each.");
  }
  if (contract?.copy?.approvalBinding?.requireCopySha256 !== true
    || !(Number(contract?.sourcePolicy?.normalizedGray32MaximumReuseDistance) > 0)) {
    throw new Error("Koya thumbnail contract must bind copy approval and perceptual source-reuse detection.");
  }
  return { pass: true, version: contract.version, status: contract.status };
}

/**
 * 有償生成や本編レンダーの手前で、正本が本物であることを要求する。
 * 契約テストは合成 fixture の上で走ってよいが、本番がそこへ落ちたら
 * サンプルのキャストで作られた成果物が「正本準拠」として出てしまう。
 */
export function assertProductionChannelAuthority(authority, context = "production", options = {}) {
  const source = nonEmpty(authority?.source);
  if (source === "test-fixture") {
    throw new Error(`Channel Pack が見つからないため合成 fixture の番組正本を読んでいる。${context} は実 pack でしか実行できない。channel-packs/<id>/ を配置するか BUZZASSIST_CHANNEL_PACK を指定すること。`);
  }
  if (source === "borrowed-channel-data" && options?.allowBorrowedChannelData !== true) {
    // このプロジェクトに正本が無いのに、別の場所（ランタイム側）の Channel Pack を
    // 読んでいる。開発機ではリポジトリが runtime なので、空のプロジェクトが
    // **開発機のチャンネルデータで本番を回す**ことになる。配布物では fixture すら
    // 無いので、同じ呼び出しが生の ENOENT になる——開発機だけで動く状態。
    throw new Error(
      `このプロジェクトに番組正本が無く、別の場所の Channel Pack を読んでいる。${context} は実行できない。`
      + "別チャンネルの番組ルールで本番が走るのを防ぐため、"
      + "このプロジェクトへ pack を復元するか（handoff-restore）、"
      + "BUZZASSIST_CHANNEL_PACK で使う pack を明示すること。",
    );
  }
  // runtime-template（正本がどこにも無い）は、ここまで来ない——読み取りの
  // 時点で ENOENT になる。到達したら素通りさせず、それ自体を異常として扱う。
  if (source !== "project" && options?.allowBorrowedChannelData !== true) {
    throw new Error(`番組正本の出所が想定外（${source || "不明"}）のため ${context} は実行できない。`);
  }
  return { pass: true, source };
}

export async function readKoyaChannelAuthority(options = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  const runtimeRoot = resolve(options.runtimeRoot || repositoryRoot);
  // A verified handoff payload must validate the exact project/config bytes
  // inside that payload. Normal runtime lookup intentionally honours an
  // operator-selected Channel Pack, but allowing that override here would let
  // an unrelated local pack stand in for the signed payload during restore.
  const directProjectAuthority = options.directProjectAuthority === true;
  // Channel Pack は projectDir 直下ではなく channel-packs/<id>/ に置く。
  // このリポジトリは PUBLIC なプラグイン配布物なので、チャンネル固有の
  // 番組設定を追跡しない。解決層が pack → 従来パスの順に探す。
  const projectSources = Object.fromEntries(Object.entries(AUTHORITY_FILES).map(([key, path]) => [
    key,
    directProjectAuthority
      ? { path: join(projectDir, path), kind: "legacy", root: projectDir }
      : resolveChannelPackSource(projectDir, path),
  ]));
  const present = await Promise.all(Object.values(projectSources).map((entry) => exists(entry.path)));
  if (present.some(Boolean) && !present.every(Boolean)) {
    throw new Error("Koya project authority is partial. Restore or provide all three show/location/thumbnail files before production.");
  }
  // 合成 fixture を project 正本と同じ顔で返さない。契約テストのために
  // fixture へ落ちる道は残すが、その事実を source に出す——出さないと、
  // pack を持たない環境の本番がサンプルのキャストで走り、監査記録には
  // 「プロジェクトの正本を読んだ」と書かれる。読み取りは通し、
  // 本番の入口が test-fixture を拒む形にしてある。
  // 出所は「実際に読んだファイル」で決める。
  //
  // 以前は project 側の探索結果だけで source を決め、そこで揃わなければ
  // runtime 側から読み直していた。すると開発機（リポジトリ＝ runtime）では
  // 空のプロジェクトに対して runtime の合成 fixture を読み、それを
  // "runtime-template" と記録して全検証を通していた。同じ呼び出しを配布物で
  // すると fixture が無いので生の ENOENT——**開発機だけで動く**状態。
  const root = directProjectAuthority ? projectDir : present.every(Boolean) ? projectDir : runtimeRoot;
  const resolvedSources = directProjectAuthority
    ? projectSources
    : Object.fromEntries(
      Object.entries(AUTHORITY_FILES).map(([key, path]) => [key, resolveChannelPackSource(root, path)]),
    );
  const paths = Object.fromEntries(Object.entries(resolvedSources).map(([key, entry]) => [key, entry.path]));
  const usedFixture = Object.values(resolvedSources).some((entry) => entry.kind === "fixture");
  // プロジェクトに正本が無いのに、ランタイム側の Channel Pack を読んで
  // しまう経路。開発機ではリポジトリが runtime なので、空のプロジェクトが
  // **開発機のチャンネルデータを黙って使う**。別のチャンネルの番組ルールで
  // 本番が走るのと同じことで、配布物では fixture すら無く生の ENOENT になる。
  const borrowedChannelData = !present.every(Boolean)
    && Object.values(resolvedSources).some((entry) => entry.kind === "pack" || entry.kind === "env");
  const source = usedFixture
    ? "test-fixture"
    : borrowedChannelData ? "borrowed-channel-data"
      : present.every(Boolean) ? "project" : "runtime-template";

  // 読み取り自体は止めない。doctor のように「ランタイム側の状態を報告する」
  // 正当な読み方があるので、ここで throw すると報告経路まで壊れる。
  // 止めるのは本番の入口（assertProductionChannelAuthority）。

  // 既定で閉じる。20か所ある呼び出し側に個別のガードを足す形だと、
  // 後から増えた1か所が素通りする——この種の取りこぼしがこのコードベースで
  // 繰り返し見つかっている。fixture を読んでよいのは、そう明言した
  // 契約テストだけにする。
  if (source === "test-fixture" && options.allowFixture !== true) {
    throw new Error(
      "Channel Pack が見つからないため合成 fixture の番組正本に落ちている。"
      + "実データ前提の工程はここでは実行できない。channel-packs/<id>/ を配置するか "
      + "BUZZASSIST_CHANNEL_PACK を指定すること（契約テストは allowFixture: true を渡す）。",
    );
  }

  const [showBible, locationBible, thumbnailContract] = await Promise.all([
    readJsonStrict(paths.show),
    readJsonStrict(paths.locations),
    readJsonStrict(paths.thumbnail),
  ]);
  const validation = {
    show: validateKoyaShowBible(showBible),
    locations: validateKoyaLocationBible(locationBible),
    thumbnail: validateKoyaThumbnailContract(thumbnailContract),
  };
  const stylingSpecs = [];
  for (const member of showBible.cast || []) {
    const primary = nonEmpty(member.stylingSpecPath);
    const sequence = Array.isArray(member.stylingSpecPaths) ? member.stylingSpecPaths.map(nonEmpty).filter(Boolean) : [];
    if (sequence.length > 0 && primary !== sequence[0]) {
      throw new Error(`${member.id}.stylingSpecPaths must start with stylingSpecPath so attribute rounds have an explicit order.`);
    }
    const declaredSequence = sequence.length > 0 ? sequence : [primary].filter(Boolean);
    const declarations = [...new Set(declaredSequence)];
    if (declarations.length !== declaredSequence.length) {
      throw new Error(`${member.id} contains duplicate styling spec declarations.`);
    }
    for (const relativePath of declarations) {
      if (isAbsolute(relativePath)) throw new Error(`${member.id} styling spec path must be project-relative: ${relativePath}`);
      // styling spec は Channel Pack 側にある。宣言は project-relative の
      // ままにして、解決だけ pack を見る——宣言に絶対パスを許すと、
      // 脱出検査の意味が無くなるため。
      const absolutePath = directProjectAuthority ? resolve(root, relativePath) : resolveChannelPackPath(root, relativePath);
      const packRoots = directProjectAuthority ? [] : channelPackRoots(root);
      if (!inside(root, absolutePath) && !packRoots.some((r) => inside(r, absolutePath))) {
        throw new Error(`${member.id} styling spec path escapes the authority root: ${relativePath}`);
      }
      const spec = await readJsonStrict(absolutePath);
      const checked = validateCharacterStylingSpec(spec);
      if (checked.characterId !== member.id) throw new Error(`${relativePath} belongs to ${checked.characterId}, not show-bible cast ${member.id}.`);
      stylingSpecs.push({ characterId: member.id, relativePath, path: absolutePath, spec, validation: checked });
    }
  }
  validation.styling = { pass: true, specCount: stylingSpecs.length, sequenceCount: (showBible.cast || []).filter((member) => Array.isArray(member.stylingSpecPaths) && member.stylingSpecPaths.length > 1).length };
  return { projectDir, root, source, paths, showBible, locationBible, thumbnailContract, stylingSpecs, validation };
}

function castMemberForSpeaker(showBible, utterance) {
  const speaker = nonEmpty(utterance?.speakerName);
  const speakerId = nonEmpty(utterance?.speakerId);
  return (showBible.cast || []).find((member) => (
    member.id === speakerId || member.id === speaker || member.name === speaker || member.hiddenName === speaker
  )) || null;
}

function storyReviewFailure(failures, condition, message) {
  if (!condition) failures.push(message);
}

function normalizedJapaneseLength(value) {
  return Array.from(nonEmpty(value).replace(/[\s　]/gu, "")).length;
}

// 語ごとに数えると「日本酒」が「日本酒」と「酒」の2回になり、1語でタイトルの
// 上限（1回）を超えていた。長い語を先に並べた1本の正規表現で、重ならない出現を
// 1回ずつ数える。語は文字どおりに照合する（正規表現として解釈しない）。
export function koyaAlcoholHits(text, terms) {
  const source = String(text || "");
  const words = [...new Set((terms || []).map((term) => String(term || "").trim()).filter(Boolean))]
    .sort((left, right) => Array.from(right).length - Array.from(left).length);
  if (words.length === 0) return [];
  const pattern = new RegExp(words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|"), "gu");
  return source.match(pattern) || [];
}

const alcoholHits = koyaAlcoholHits;

function koyaEyeOpenMembers(showBible) {
  return (showBible?.cast || []).filter((member) => member.requiredReferenceRoles?.includes("eye-open"));
}

// Eye-open policy handed to the script image plan. Candidates are the
// show-bible members that own an eye-open sheet, mapped to their registry
// character; reviewed beats use show-bible cast ids and are mapped the same
// way. Variant cue words live in the show bible, never in this code.
export function buildKoyaEyeOpenPolicy({ showBible, registry, storyReview } = {}) {
  const candidates = koyaEyeOpenMembers(showBible).map((member) => {
    const registered = approvedRegistryCharacterForMember(registry, member);
    return {
      memberId: member.id,
      characterId: registered?.id || member.id,
      label: member.hiddenName || member.name,
      names: [member.id, member.name, member.hiddenName, ...(member.aliases || []), registered?.name, ...(registered?.aliases || [])].map(nonEmpty).filter(Boolean),
      variants: (Array.isArray(member.eyeOpenVariants) ? member.eyeOpenVariants : []).map((variant) => ({
        id: nonEmpty(variant?.id),
        label: nonEmpty(variant?.label),
        cues: Array.isArray(variant?.cues) ? variant.cues.map(nonEmpty).filter(Boolean) : [],
      })),
    };
  });
  const characterIdFor = (castId) => candidates.find((candidate) => candidate.memberId === castId)?.characterId || castId;
  const reviewedBeats = Array.isArray(storyReview?.eyeOpenBeats)
    ? storyReview.eyeOpenBeats.map((entry) => ({
        utteranceId: nonEmpty(entry?.utteranceId),
        characterId: characterIdFor(nonEmpty(entry?.castId)),
        variant: nonEmpty(entry?.variant),
        reason: nonEmpty(entry?.reason),
      }))
    : null;
  return { candidates, reviewedBeats };
}

// Eye-open is a rare trump card, never a per-episode requirement: a member
// that appears in every episode only has to own the approved sheet. Too many
// eye-open scenes for one member in one episode is reported as a warning.
export const KOYA_EYE_OPEN_SCENE_WARNING_THRESHOLD = 2;

// The scene an eye-open image belongs to: the cut for a legacy script, the
// whole 「#場面」 for a scene script whose scene was split into several cuts.
function eyeOpenSceneOf(cuts) {
  const labels = mangaEyeOpenUnitLabels(Array.isArray(cuts) ? cuts : []);
  return (cutId) => labels.get(cutId) || cutId;
}

function eyeOpenSceneWarnings(entries, labelFor = (key) => key) {
  const scenesByKey = new Map();
  for (const { key, scene } of entries) {
    if (!key || !scene) continue;
    scenesByKey.set(key, new Set([...(scenesByKey.get(key) || []), scene]));
  }
  return [...scenesByKey]
    .filter(([, scenes]) => scenes.size > KOYA_EYE_OPEN_SCENE_WARNING_THRESHOLD)
    .map(([key, scenes]) => `${labelFor(key)} opens their eyes in ${scenes.size} scenes (${[...scenes].join(", ")}). Eye-open is a rare trump card; keep it to ${KOYA_EYE_OPEN_SCENE_WARNING_THRESHOLD} or fewer per episode unless the story truly needs more.`);
}

// Plan-level eye-open report. Zero eye-open scenes is normal; only a member
// opening their eyes in too many scenes of one episode is flagged. `cuts`
// (the plan manifest's) lets a scene-script scene split into several cuts
// count once; without it every cut counts as a scene.
export function auditKoyaEyeOpenPlan({ policy, eyeOpenPlan, cuts } = {}) {
  const boundImages = Array.isArray(eyeOpenPlan?.boundImages) ? eyeOpenPlan.boundImages : [];
  const labelFor = (characterId) => policy?.candidates?.find((candidate) => candidate.characterId === characterId)?.memberId || characterId;
  const sceneOf = eyeOpenSceneOf(cuts);
  return {
    source: nonEmpty(eyeOpenPlan?.source),
    beatCount: Array.isArray(eyeOpenPlan?.beats) ? eyeOpenPlan.beats.length : 0,
    boundImageCount: boundImages.length,
    warnings: eyeOpenSceneWarnings(boundImages.map((entry) => ({ key: entry.characterId, scene: sceneOf(entry.cutId) })), labelFor),
  };
}

function auditReviewedEyeOpenBeats({ showBible, review, byId, failures }) {
  if (review?.eyeOpenBeats === undefined) return;
  const entries = Array.isArray(review.eyeOpenBeats) ? review.eyeOpenBeats : null;
  storyReviewFailure(failures, entries, "Story review eyeOpenBeats must be an array when present.");
  if (!entries) return;
  const members = koyaEyeOpenMembers(showBible);
  const seen = new Set();
  entries.forEach((entry, index) => {
    const label = `eyeOpenBeats[${index}]`;
    const utteranceId = nonEmpty(entry?.utteranceId);
    const castId = nonEmpty(entry?.castId);
    const variant = nonEmpty(entry?.variant);
    storyReviewFailure(failures, byId.has(utteranceId), `${label} must name a real utterance ID.`);
    const member = members.find((candidate) => candidate.id === castId);
    storyReviewFailure(failures, member, `${label}.castId must be a show-bible member that requires an eye-open sheet.`);
    storyReviewFailure(failures, !seen.has(`${utteranceId}\n${castId}`), `${label} repeats ${castId} on ${utteranceId}.`);
    seen.add(`${utteranceId}\n${castId}`);
    if (!member) return;
    const variantIds = (member.eyeOpenVariants || []).map((declared) => nonEmpty(declared?.id));
    if (variantIds.length >= 2) {
      storyReviewFailure(failures, variantIds.includes(variant), `${label}.variant must be one of ${variantIds.join(", ")} for ${castId}.`);
    } else if (variant) {
      storyReviewFailure(failures, variantIds.includes(variant), `${label}.variant '${variant}' is not declared for ${castId}.`);
    }
  });
}

// The eye-open scenes a story review would put on screen: the reviewed list
// when present, otherwise what the script cues suggest.
function storyEyeOpenScenes({ showBible, registry, review, parsed, byId }) {
  const sceneOf = eyeOpenSceneOf(parsed?.cuts);
  if (Array.isArray(review?.eyeOpenBeats)) {
    return review.eyeOpenBeats.map((entry) => {
      const cutId = byId.get(nonEmpty(entry?.utteranceId))?.cutId;
      return {
        key: nonEmpty(entry?.castId),
        scene: (cutId && sceneOf(cutId)) || nonEmpty(entry?.utteranceId),
      };
    });
  }
  // Registry names and aliases matter here: a script may name the member only
  // by a registered alias, and the show bible alone would miss that cue.
  const policy = buildKoyaEyeOpenPolicy({ showBible, registry });
  const memberIdFor = (characterId) => policy.candidates.find((candidate) => candidate.characterId === characterId)?.memberId || characterId;
  return detectMangaEyeOpenBeats({ cuts: Array.isArray(parsed?.cuts) ? parsed.cuts : [], candidates: policy.candidates })
    .beats.map((beat) => ({ key: memberIdFor(beat.characterId), scene: sceneOf(beat.cutId) }));
}

export function auditKoyaStory(options = {}) {
  const showBible = options.showBible;
  validateKoyaShowBible(showBible);
  const semantics = resolveStoryCastSemantics(showBible, showBible.cast || []);
  const parsed = options.parsed;
  if (!parsed || !Array.isArray(parsed.utterances)) throw new Error("Parsed manga script is required for Koya story audit.");
  const scriptText = String(options.scriptText || "");
  const scriptSha256 = sha256(scriptText);
  const fixedRows = parsed.utterances
    .map((utterance) => ({ utterance, cast: castMemberForSpeaker(showBible, utterance) }))
    .filter((row) => row.cast);
  const fixedCastIds = [...new Set(fixedRows.map((row) => row.cast.id))];
  const declaredCast = new Set((options.declaredCast || []).map(nonEmpty).filter(Boolean));
  const declaredFixedCastIds = (showBible.cast || [])
    .filter((member) => declaredCast.has(member.id) || declaredCast.has(member.name) || declaredCast.has(member.hiddenName))
    .map((member) => member.id);
  // どのハーネスを使うかは上位のルーターが決める。台本からキャストが
  // 見つからないことを「この番組ではない」証拠として扱うと、話者名の
  // 表記ゆれひとつで18の番組ルールが全部黙って外れる。pack が選ばれて
  // いる以上、キャストが一人も見つからないのは免除ではなく失敗。
  const castDetected = fixedCastIds.length > 0 || declaredFixedCastIds.length > 0;
  const active = options.enforce === true || castDetected;
  const terms = Array.isArray(showBible?.channel?.alcoholLexicon)
    ? showBible.channel.alcoholLexicon.map(nonEmpty).filter(Boolean)
    : ["日本酒", "焼酎", "ビール", "ワイン", "飲酒", "泥酔", "酒", "呑"];
  const titleHits = alcoholHits(options.title || parsed.title, terms);
  const scriptHits = alcoholHits(scriptText, terms);
  const warnings = [];
  if (titleHits.length > 1) warnings.push(`Title contains ${titleHits.length} alcohol-keyword hits; restrained policy expects at most one.`);
  if (scriptHits.length > Math.max(3, Math.ceil(parsed.utterances.length * 0.08))) {
    warnings.push(`Script contains ${scriptHits.length} alcohol-keyword hits; confirm alcohol is not the narrative hook.`);
  }
  if (!active) {
    return {
      version: "koya-story-audit-v1",
      pass: true,
      active: false,
      scriptSha256,
      fixedCastIds,
      declaredFixedCastIds,
      warnings,
      failures: [],
      castDetected,
      reason: "Channel Pack が選択されておらず固定キャストも検出/宣言されていない。ジャンル共通ハーネスの互換モード。",
    };
  }

  const failures = [];
  if (!castDetected) {
    failures.push("Channel Pack が選択されているのに、台本にも宣言にも固定キャストが一人も現れない。話者名の表記ゆれか、別番組の台本の可能性がある。キャスト未検出を理由に番組ルールを外すことはしない。");
  }
  const review = options.storyReview && typeof options.storyReview === "object" ? options.storyReview : null;
  storyReviewFailure(failures, review, `A ${KOYA_STORY_REVIEW_VERSION} file is required before Koya fixed-cast production.`);
  if (!review) return { version: "koya-story-audit-v1", pass: false, active, castDetected, scriptSha256, fixedCastIds, declaredFixedCastIds, warnings, failures };
  storyReviewFailure(failures, review.version === KOYA_STORY_REVIEW_VERSION, `Story review version must be ${KOYA_STORY_REVIEW_VERSION}.`);
  storyReviewFailure(failures, review.scriptSha256 === scriptSha256, "Story review scriptSha256 does not match the exact script.");
  storyReviewFailure(failures, nonEmpty(review?.reviewer?.host) && nonEmpty(review?.reviewer?.id) && nonEmpty(review?.reviewer?.contextId), "Story review requires reviewer.host, reviewer.id, and reviewer.contextId.");
  storyReviewFailure(failures, validIsoDate(review?.reviewedAt), "Story review requires a valid ISO-8601 reviewedAt.");
  const generatorContextId = nonEmpty(options?.generatorProvenance?.contextId);
  if (generatorContextId) {
    storyReviewFailure(failures, nonEmpty(review?.reviewer?.contextId) !== generatorContextId, "Story review must come from a context different from the generator task/session.");
  }
  storyReviewFailure(failures, nonEmpty(review?.protagonistSpeakerId), "Story review requires protagonistSpeakerId.");
  const byId = new Map(parsed.utterances.map((utterance, index) => [utterance.id, { ...utterance, sequenceIndex: index }]));
  const beatNames = semantics.requiredBeats;
  const beats = beatNames.map((name) => ({ name, id: nonEmpty(review?.beats?.[name]), row: byId.get(nonEmpty(review?.beats?.[name])) }));
  for (const beat of beats) storyReviewFailure(failures, beat.id && beat.row, `Story review beat '${beat.name}' must name a real utterance ID.`);
  const validBeatRows = beats.filter((beat) => beat.row);
  storyReviewFailure(
    failures,
    validBeatRows.length === beatNames.length && validBeatRows.every((beat, index) => index === 0 || beat.row.sequenceIndex > validBeatRows[index - 1].row.sequenceIndex),
    `Story review beats must be unique and ordered: ${beatNames.join(" -> ")}.`,
  );
  const reversalSignalBeat = beats.find((beat) => beat.name === semantics.reversalSignal.reviewBeat)?.row;
  storyReviewFailure(
    failures,
    castMemberForSpeaker(showBible, reversalSignalBeat)?.id === semantics.reversalSignal.castId,
    "The reversalSignal review beat must be spoken by the cast member assigned to storyGrammar.castSemantics.reversalSignal.",
  );
  const protagonistBeat = beats.find((beat) => beat.name === "protagonistFinish")?.row;
  storyReviewFailure(
    failures,
    protagonistBeat && [protagonistBeat.speakerId, protagonistBeat.speakerName].includes(review.protagonistSpeakerId),
    "protagonistFinish must be spoken by the reviewed protagonist, not an ally.",
  );
  const exitBlockerRows = fixedRows.filter((row) => row.cast.id === semantics.exitBlocker.castId);
  if (exitBlockerRows.length > 0) {
    const exitBlockerBeatId = nonEmpty(review?.beats?.[semantics.exitBlocker.reviewBeat]);
    storyReviewFailure(failures, exitBlockerRows.length === 1, "The exitBlocker cast member may speak exactly one exit-blocking line in a reviewed episode.");
    storyReviewFailure(failures, exitBlockerBeatId === exitBlockerRows[0]?.utterance.id, "The exitBlocker review beat must identify that cast member's only utterance.");
    storyReviewFailure(
      failures,
      !protagonistBeat || exitBlockerRows[0].utterance.order === undefined
        || byId.get(exitBlockerBeatId)?.sequenceIndex > protagonistBeat.sequenceIndex,
      "The exitBlocker line must follow the protagonist's finishing line.",
    );
  }
  auditReviewedEyeOpenBeats({ showBible, review, byId, failures });
  warnings.push(...eyeOpenSceneWarnings(storyEyeOpenScenes({ showBible, registry: options.registry, review, parsed, byId })));
  const requiredChecks = [
    "realPlaceNamesAbsent",
    "realBrandSignsAbsent",
    "directViolenceNotGlorified",
    "villainComedyPresent",
    "protagonistAgencyPass",
    "alcoholKeywordsRestrained",
  ];
  for (const key of requiredChecks) storyReviewFailure(failures, review?.checks?.[key] === true, `Story review check '${key}' must be true.`);
  if (titleHits.length > 1) failures.push("Title violates the restrained alcohol-keyword limit.");
  return {
    version: "koya-story-audit-v1",
    pass: failures.length === 0,
    active,
    scriptSha256,
    storyReviewVersion: review.version,
    fixedCastIds,
    declaredFixedCastIds,
    protagonistSpeakerId: nonEmpty(review.protagonistSpeakerId),
    beatUtteranceIds: Object.fromEntries(Object.entries(review.beats || {}).map(([key, value]) => [key, nonEmpty(value)])),
    eyeOpenBeatSource: Array.isArray(review.eyeOpenBeats) ? "review" : "script-cue",
    warnings,
    failures,
  };
}

export function createKoyaStoryReviewDraft(options = {}) {
  // A scene script names its protagonist (主人公: はい). A draft bound to a
  // different --protagonist-speaker-id would only fail later at planning.
  assertKoyaDeclaredProtagonist(options.parsed, options.protagonistSpeakerId);
  const showBible = options.showBible;
  validateKoyaShowBible(showBible);
  const semantics = resolveStoryCastSemantics(showBible, showBible.cast || []);
  const parsed = options.parsed;
  if (!parsed || !Array.isArray(parsed.utterances)) throw new Error("Parsed manga script is required for a story review draft.");
  const eyeOpenPolicy = buildKoyaEyeOpenPolicy({ showBible, registry: options.registry });
  const memberIdFor = (characterId) => eyeOpenPolicy.candidates.find((candidate) => candidate.characterId === characterId)?.memberId || characterId;
  const detectedEyeOpen = detectMangaEyeOpenBeats({ cuts: Array.isArray(parsed.cuts) ? parsed.cuts : [], candidates: eyeOpenPolicy.candidates });
  const sceneOf = eyeOpenSceneOf(parsed.cuts);
  return {
    version: KOYA_STORY_REVIEW_VERSION,
    scriptSha256: sha256(String(options.scriptText || "")),
    reviewer: { host: "", id: "", contextId: "" },
    reviewedAt: "",
    protagonistSpeakerId: nonEmpty(options.protagonistSpeakerId),
    beats: Object.fromEntries([...semantics.requiredBeats, semantics.optionalBeat].map((beat) => [beat, ""])),
    checks: Object.fromEntries((showBible.storyReview.requiredChecks || []).map((key) => [key, false])),
    // Machine suggestion from the script text. The reviewer confirms, fixes,
    // or empties it; once present, this list replaces detection in the plan.
    eyeOpenBeats: detectedEyeOpen.beats.map((beat) => ({
      utteranceId: beat.utteranceId,
      castId: memberIdFor(beat.characterId),
      variant: beat.variant,
      reason: beat.cue ? `script cue: ${beat.cue}` : "script cue",
    })),
    eyeOpenBeatWarnings: eyeOpenSceneWarnings(detectedEyeOpen.beats.map((beat) => ({ key: memberIdFor(beat.characterId), scene: sceneOf(beat.cutId) }))),
    eyeOpenBeatFindings: detectedEyeOpen.unresolved.map((finding) => ({
      ...finding,
      ...(finding.characterId ? { castId: memberIdFor(finding.characterId) } : {}),
      ...(finding.candidates ? { candidates: finding.candidates.map(memberIdFor) } : {}),
    })),
    utteranceInventory: parsed.utterances.map((utterance, sequenceIndex) => ({
      sequenceIndex,
      id: utterance.id,
      cutId: utterance.cutId,
      speakerId: utterance.speakerId,
      speakerName: utterance.speakerName,
      fixedCastId: castMemberForSpeaker(showBible, utterance)?.id || "",
      text: utterance.text,
    })),
    instructions: "Fill every required beat with one utteranceInventory id, complete the human checks, and remove utteranceInventory only if desired. Confirm eyeOpenBeats against the meaning of each line: every image utterance where a listed member has their eyes open, with the variant id when the member declares two or more; resolve eyeOpenBeatFindings. Eye-open is a rare trump card: an empty list is normal, and eyeOpenBeatWarnings flags a member opening their eyes in too many scenes. Never change scriptSha256 by hand.",
  };
}

function slug(value, fallback) {
  const normalized = nonEmpty(value).normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  return normalized || fallback;
}

/**
 * 参照画像には性質の違う2種類がある。混ぜると片方の意図が壊れる。
 *
 * - ARCHITECTURE 参照：間取り・什器・寸法・空間関係を継がせるためのもの。
 *   アンカーはこのチャンネルの建築の出所そのものなので、他の画像から
 *   建築を継いではならない。だからアンカーの architecture 参照は必ず空。
 * - STYLE 参照：線・塗り・階調・色域・仕上げだけを決めるもの。建築は一切
 *   持ち込まない。したがってアンカーに渡しても建築的独立性は損なわれない。
 *
 * 以前の referencePolicy は "no image reference" という一つの文でこの2つを
 * まとめて禁じていた。守りたかったのは建築の独立性だけだったのに、画風の
 * 参照まで塞いでいて、画風の指示もプロンプトに無かったため、アンカーは
 * 画風の手掛かりゼロで生成されていた——写実CGになったのはその結果。
 */
function resolveKoyaLocationStyleReferences(showBible, projectDir) {
  const style = validateKoyaChannelArtStyle(showBible);
  const declared = Array.isArray(showBible.artStyle?.styleReference?.paths)
    ? showBible.artStyle.styleReference.paths.map(nonEmpty).filter(Boolean)
    : [];
  const paths = declared.slice(0, style.maximum).map((relativePath) => resolve(projectDir, relativePath));
  for (const path of paths) {
    if (!inside(projectDir, path)) throw new Error(`Channel art-style reference escapes the project: ${path}`);
  }
  return { style, declared, paths };
}

export function buildKoyaLocationBoardPlan(options = {}) {
  const locationBible = options.locationBible;
  validateKoyaLocationBible(locationBible);
  // 画風はチャンネル全体の属性なので番組正本（show bible）が持つ。
  // 無い正本ではロケーションボードを1枚も計画させない——既定に落とすと、
  // 画風の指示が無いまま有償生成が走り、写実CGのアンカーがもう一度出る。
  // それは黙って再発するのが最悪の壊れ方なので、ここは硬い失敗にする。
  const showBible = options.showBible;
  if (!showBible) {
    throw new Error("Koya location board plan requires the show bible: the channel art style lives there, and a board planned without it reproduces the photoreal-render defect.");
  }
  const locationId = nonEmpty(options.locationId);
  const location = locationBible.locations.find((entry) => entry.id === locationId);
  if (!location) throw new Error(`Unknown Koya location: ${locationId || "(missing)"}`);
  const projectDir = resolve(options.projectDir || process.cwd());
  const outputDir = resolve(options.outputDir || join(projectDir, "canvas/assets/koya-locations", location.id, "source"));
  const { style, declared: declaredStyleReferences, paths: styleReferencePaths } = resolveKoyaLocationStyleReferences(showBible, projectDir);
  const anchorOutputPath = join(outputDir, `board-1-${slug(location.requiredBoards[0], "view-1")}.png`);
  const jobs = location.requiredBoards.map((board, index) => {
    const boardId = `board-${index + 1}-${slug(board, `view-${index + 1}`)}`;
    const isAnchor = index === 0;
    // アンカーだけがスタイル参照を受け取る。継続ビューはアンカー1枚を
    // 建築参照として引き継ぎ、そこに画風も既に乗っているので追加しない。
    const architectureReferences = isAnchor ? [] : [anchorOutputPath];
    const styleReferences = isAnchor ? styleReferencePaths : [];
    const referenceImagePaths = [...architectureReferences, ...styleReferences];
    const referenceClauses = [];
    if (architectureReferences.length > 0) {
      referenceClauses.push(
        "Reference image 1 is the approved ARCHITECTURE ANCHOR for this location. Reproduce its architecture, proportions, fixtures, materials and spatial relationships exactly, from this view's camera, and keep the identical drawn art style.",
      );
    }
    if (styleReferences.length > 0) {
      const first = architectureReferences.length + 1;
      const last = architectureReferences.length + styleReferences.length;
      const span = first === last ? `image ${first}` : `images ${first}-${last}`;
      referenceClauses.push(
        `Reference ${span} ${first === last ? "is a" : "are"} CHANNEL STYLE-ONLY reference${first === last ? "" : "s"}. Match only their linework, flat colour handling, cel-shadow restraint, palette, light quality and rendering finish. They are NOT an architecture, layout, camera, prop, or content source: every wall, opening, fixture, and spatial relationship comes from the architecture lock stated above and never from a reference image. Ignore any speech bubble, narration box, caption, signage or lettering that appears inside them.`,
      );
    }
    return {
      id: `${location.id}:${boardId}`,
      locationId: location.id,
      boardId,
      boardLabel: board,
      phase: isAnchor ? "anchor" : "continuity-view",
      dependsOn: isAnchor ? [] : [`${location.id}:board-1-${slug(location.requiredBoards[0], "view-1")}`],
      outputPath: join(outputDir, `${boardId}.png`),
      prompt: [
        // 冒頭行はプロンプト中で最も重く読まれる。ここに "production environment reference"
        // と書いていたことが写実CGを招いた原因だった。動詞は Draw に固定し、画材の宣言は
        // 独立した1文にする。medium を名詞句の途中へ差し込むと文が壊れて読めなくなる。
        `Draw one 16:9 BACKGROUND ART BOARD for the fictional location ${location.name}.`,
        `Medium: ${style.medium}.`,
        `Required view: ${board}.`,
        `CHANNEL ART STYLE [${style.id}] — mandatory, and identical to the art style of this channel's characters: ${style.sharedIdiom.join(" ")}`,
        `Environment rendering: ${style.environmentIdiom.join(" ")}`,
        `Never: ${style.forbidden.join("; ")}.`,
        `Architecture lock: ${(location.architectureLock || []).join("; ")}.`,
        `Material and light palette (what is depicted, drawn in the channel art style above, never as photographic material): ${(location.materialPalette || []).join("; ")}.`,
        `Hard rules: ${(location.generationRules || []).join("; ")}.`,
        ...referenceClauses,
        // 既定の文面は1バイトも変えない。変えると既存の生成記録の prompt SHA が
        // すべて古い扱いになり、承認済みのアンカーまで無効になる。
        locationAllowsFictionalSignage(location)
          ? "No people, silhouettes, or faces. Shop signs may carry only minimal invented names; no real names, real brands, real logos, or real place names. Preserve navigable spatial continuity across all approved views."
          : "No people, silhouettes, faces, readable lettering, real logos, or real place names. Preserve navigable spatial continuity across all approved views.",
      ].join("\n"),
      artStyleId: style.id,
      references: {
        architecture: architectureReferences,
        architectureRule: isAnchor
          ? "none by design: the anchor IS the canonical architecture and must not inherit architecture from any other image"
          : "exactly the current SHA-bound anchor candidate; final approval happens after all four views pass independent review",
        style: styleReferences,
        styleRule: styleReferences.length > 0
          ? "style-only: linework, fills, tonal steps and palette only, never architecture, layout, camera or content — so these do not compromise the anchor's architecture independence"
          : "none declared by the channel art style",
      },
      referenceImagePaths,
      referencePolicy: isAnchor
        ? `no architecture reference (the anchor establishes the canonical architecture); ${styleReferences.length} style-only reference(s), which carry rendering idiom and never architecture`
        : "use only the current SHA-bound anchor candidate as the architecture reference; final approval happens after all four views pass independent review",
    };
  });
  return {
    version: "koya-location-board-plan-v1",
    location: { id: location.id, name: location.name, status: location.status },
    artStyle: {
      id: style.id,
      styleReferencePolicy: "style-only",
      declaredStyleReferences,
      resolvedStyleReferences: styleReferencePaths,
    },
    jobs,
    anchorReviewVersion: KOYA_LOCATION_ANCHOR_REVIEW_VERSION,
    reviewVersion: KOYA_LOCATION_REVIEW_VERSION,
    reviewRequirements: [
      "anchor generation first; no combined all-stage generation",
      "SHA-bound independent anchor review before continuity generation",
      "official generation manifest and per-board generator provenance",
      "independent final reviewer in a context different from every generator",
      "original-scale review and SHA-256 per board",
      locationAllowsFictionalSignage(location)
        ? "no people or real brands; readable text limited to minimal fictional signage"
        : "no people, readable text, or real brands",
      "cross-view architecture continuity",
      "every board carries the channel art style declared in the show bible; no photoreal or 3D-render board is acceptable",
    ],
    registrationBlockedUntilReviewPass: true,
  };
}

function locationGenerationManifestPath(plan) {
  return join(dirname(plan.jobs[0].outputPath), "location-generation.manifest.json");
}

function locationAnchorEntrySha256(entry) {
  return sha256(JSON.stringify(entry || null));
}

/*
 * 取り込んだボード（location-import）の出所。
 *
 * 運営者の決まりで、有料の画像生成は人か、ブラウザを操作するエージェントが
 * チャット型の画像ツールで行う。そうして作ったボードには公式の生成記録が無いので、
 * 取り込みの時点で「どの会話で・どのプロンプトと参照画像から作ったか」を
 * マップで SHA 拘束し、生成記録と同じ形の entry に import ブロックとして残す。
 *
 * 審査側の規則は公式生成と同じ強さに保つ。
 * - プロンプトは実際に使った文を保存し、その SHA と一致すること
 * - 取り込み時の location bible と画風から作った計画プロンプトの SHA を残し、
 *   bible や画風が変わったら公式生成と同じく古い扱いにする
 * - 継続ビューは現在のアンカー画像を建築参照として宣言していること
 * - 審査者の context は、取り込んだ人と全ての外部生成 context のどれとも違うこと
 */
export const KOYA_LOCATION_IMPORT_MAP_VERSION = "koya-location-import-map-v1";
// derived: この場所で前に承認・取り込み済みの絵（そのボードの前の版や、同じ組の別のボード）を
// 直したり、つないだりして作ったときの元画像。アンカーから描いていないので、アンカーへの
// SHA 拘束は付けず、建築の一致は審査者が目で見る（参照の記録が無いボードと同じ扱い）。
const LOCATION_IMPORT_REFERENCE_ROLES = Object.freeze(["anchor", "derived", "style", "other"]);

/** アンカーを参照せず、承認済みの絵を直して作ったボードか（derived があり anchor が無い）。 */
function locationReferencesDerivedOnly(references) {
  const list = Array.isArray(references) ? references : [];
  return list.some((reference) => reference?.role === "derived") && !list.some((reference) => reference?.role === "anchor");
}
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function validSha256Hex(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isImportedLocationEntry(entry) {
  return Boolean(entry && typeof entry === "object" && Object.hasOwn(entry, "import"));
}

/*
 * 記録が最初から無いボードの扱い（provenanceGap）。
 *
 * 取り込みは「実際に使ったプロンプト」と「その画像が出た会話」を要求する。
 * これから作る物にはそれで正しいが、記録を残す決まりが無かった頃に作った
 * ボードは、その2つがどこにも残っていない。ここで選べる道は2つしかない。
 * プロンプトを書き起こす（作り話の記録。絶対に駄目）か、その場所を永久に
 * 未登録のままにするかである。
 *
 * そこで「記録が無い」と明示的に宣言する道を足す。宣言したボードは
 * 出所が欠けたまま通るのではなく、
 * - プロンプトと会話 id の代わりに、その絵が満たすべき文書（配置表など）を
 *   パスと SHA-256 で結び、
 * - 独立した審査者が理由と文書を読んだという専用チェック
 *   provenanceGapAcknowledged を、そのボードにだけ課す。
 * チェックが無い・false なら監査は落ちる（既定は不合格）。欠落は生成記録・
 * 審査・登録・引き渡しの全てに残るので、後から見て隠せない。
 *
 * 欠けるのはプロンプトと会話だけではない。参照画像も、記録を残す決まりが
 * 無かった頃の作業記録では「別の承認済み画像の一部を添えた」程度しか
 * 分からないことがある。そこを埋めるために「アンカーを参照として使った」と
 * 書けば、それは作り話の記録になる。だから旗を3つに分け、どれを宣言するかは
 * ボードごとに独立にする。参照画像の欠落を宣言したボードは
 * referenceImages を空で通し、アンカー参照を名乗らない。代わりに
 * アンカーとの建築の一致は記録では示せないので、審査者が目で見て
 * architectureLockPass を付けるほかない（下書きの指示にそう書く）。
 */
export const KOYA_LOCATION_PROVENANCE_GAP_FLAGS = Object.freeze([
  "promptRecorded",
  "generatorContextRecorded",
  "referenceImagesRecorded",
]);
const LOCATION_PROVENANCE_GAP_FLAGS = KOYA_LOCATION_PROVENANCE_GAP_FLAGS;
const LOCATION_PROVENANCE_GAP_KEYS = Object.freeze([
  "reason",
  "specificationPath",
  "specificationSha256",
]);
const MAX_LOCATION_PROVENANCE_GAP_REASON = 2000;
export const KOYA_LOCATION_PROVENANCE_GAP_CHECK = "provenanceGapAcknowledged";
/**
 * ボードごとの建築の一致を見る確認項目。参照画像の記録が無いボードでは、
 * これが「記録の代わりに目で見た」という唯一の証跡になるので、
 * 専用の項目を新しく作らずに既存のこれを使う。
 */
export const KOYA_LOCATION_BOARD_CONTINUITY_CHECK = "architectureLockPass";

export function koyaLocationEntryProvenanceGap(entry) {
  const gap = entry?.import?.provenanceGap;
  return gap && typeof gap === "object" && !Array.isArray(gap) ? gap : null;
}

/** その欠落の宣言が、この種類の記録を「無い」と言っているか。 */
export function koyaLocationGapDeclares(gap, flag) {
  return Boolean(gap) && typeof gap === "object" && gap[flag] === false;
}

/** 参照画像の記録が無いと宣言したボードか（アンカー参照を名乗れない）。 */
function locationEntryReferencesUnrecorded(entry) {
  return koyaLocationGapDeclares(koyaLocationEntryProvenanceGap(entry), "referenceImagesRecorded");
}

/** 取り込んだボードが、アンカーでなく承認済みの絵を直して作られたか。 */
function locationEntryDerivedOnly(entry) {
  return isImportedLocationEntry(entry) && locationReferencesDerivedOnly(entry.import?.referenceImages);
}

/** 出所欠落の宣言そのものが壊れていないか（ファイルの再読みはしない）。 */
function locationProvenanceGapShapeFailures(gap, label) {
  const failures = exactKeyFailures(gap, LOCATION_PROVENANCE_GAP_KEYS, LOCATION_PROVENANCE_GAP_FLAGS, `${label} provenanceGap`);
  if (failures.length > 0) return failures;
  const declared = LOCATION_PROVENANCE_GAP_FLAGS.filter((flag) => Object.hasOwn(gap, flag));
  if (declared.length === 0) {
    failures.push(`${label} provenanceGap must declare at least one of ${LOCATION_PROVENANCE_GAP_FLAGS.join(", ")} as false.`);
  }
  if (declared.some((flag) => gap[flag] !== false)) {
    failures.push(`${label} provenanceGap is only for records that do not exist: ${LOCATION_PROVENANCE_GAP_FLAGS.join(", ")} may only be false.`);
  }
  if (typeof gap.reason !== "string" || !gap.reason.trim() || gap.reason.length > MAX_LOCATION_PROVENANCE_GAP_REASON) {
    failures.push(`${label} provenanceGap.reason must say in at most ${MAX_LOCATION_PROVENANCE_GAP_REASON} characters why those records were never kept.`);
  }
  if (!nonEmpty(gap.specificationPath) || !validSha256Hex(gap.specificationSha256)) {
    failures.push(`${label} provenanceGap requires specificationPath and a lowercase specificationSha256 of the written specification the board was made to satisfy.`);
  }
  return failures;
}

/** 出所が欠けたボードにだけ足す、審査者の確認チェック。 */
export function koyaLocationBoardReviewCheckKeys(location, entry) {
  const keys = koyaLocationBoardCheckKeys(location);
  return koyaLocationEntryProvenanceGap(entry) ? [...keys, KOYA_LOCATION_PROVENANCE_GAP_CHECK] : keys;
}

export function koyaLocationAnchorReviewCheckKeys(location, entry) {
  const keys = koyaLocationAnchorCheckKeys(location);
  return koyaLocationEntryProvenanceGap(entry) ? [...keys, KOYA_LOCATION_PROVENANCE_GAP_CHECK] : keys;
}

/** 欠落が無いボードに確認チェックが付いていたら拒む（旗をどこにでも撒けないようにする）。 */
function locationGapCheckMisplacementFailure(checks, gap, label) {
  if (gap || !checks || typeof checks !== "object") return "";
  return Object.hasOwn(checks, KOYA_LOCATION_PROVENANCE_GAP_CHECK)
    ? `${label} check '${KOYA_LOCATION_PROVENANCE_GAP_CHECK}' is only for a board that declares a provenance gap.`
    : "";
}

function importedLocationEntryFailures({ entry, job, isAnchor, expectedAnchorSha256, label }) {
  const block = entry?.import;
  if (!block || typeof block !== "object" || Array.isArray(block)) return [`${label} import provenance is malformed.`];
  const failures = [];
  if (block.mapVersion !== KOYA_LOCATION_IMPORT_MAP_VERSION || !nonEmpty(block.mapPath) || !validSha256Hex(block.mapSha256)) {
    failures.push(`${label} import provenance must bind a ${KOYA_LOCATION_IMPORT_MAP_VERSION} map path and SHA-256.`);
  }
  if (!nonEmpty(block.sourcePath) || block.sourceSha256 !== entry.sha256) {
    failures.push(`${label} import source SHA-256 does not bind the imported board.`);
  }
  if (!validIsoDate(block.importedAt) || !validIsoDate(entry.generatedAt)) {
    failures.push(`${label} import and external generation times must be valid ISO-8601 dates.`);
  }
  if (!nonEmpty(block?.importedBy?.host) || !nonEmpty(block?.importedBy?.id) || !nonEmpty(block?.importedBy?.contextId)) {
    failures.push(`${label} importer host, id, and contextId are required.`);
  }
  if (block.boardLabel !== job.boardLabel) failures.push(`${label} import provenance names a different required board.`);
  if (block.planPromptSha256 !== sha256(job.prompt)) {
    failures.push(`${label} was imported under a different location bible or channel art style; import and review it again.`);
  }
  // 旗はボードごとに独立に読む。プロンプトだけ残っていて参照画像が
  // 残っていないボードも、その逆もあるので、まとめて「欠落あり」とは扱わない。
  const gap = koyaLocationEntryProvenanceGap(entry);
  const promptUnrecorded = koyaLocationGapDeclares(gap, "promptRecorded");
  const contextUnrecorded = koyaLocationGapDeclares(gap, "generatorContextRecorded");
  const referencesUnrecorded = koyaLocationGapDeclares(gap, "referenceImagesRecorded");
  if (Object.hasOwn(block, "provenanceGap")) {
    failures.push(...locationProvenanceGapShapeFailures(block.provenanceGap, label));
  }
  if (promptUnrecorded) {
    if (Object.hasOwn(block, "promptText") || Object.hasOwn(block, "promptPath") || nonEmpty(entry.promptSha256)) {
      failures.push(`${label} records both a prompt and a provenance gap; a board has complete provenance or a declared gap, never both.`);
    }
  } else if (typeof block.promptText !== "string" || !block.promptText.trim() || sha256(block.promptText) !== entry.promptSha256) {
    failures.push(`${label} imported prompt text does not match its recorded prompt SHA-256.`);
  }
  if (contextUnrecorded && nonEmpty(entry?.generator?.contextId)) {
    failures.push(`${label} declares that the generator conversation was not recorded but still names a generator contextId.`);
  }
  const references = Array.isArray(block.referenceImages) ? block.referenceImages : null;
  if (!references || references.some((reference) => !nonEmpty(reference?.path)
    || !validSha256Hex(reference?.sha256)
    || !LOCATION_IMPORT_REFERENCE_ROLES.includes(reference?.role))) {
    failures.push(`${label} imported reference images are malformed.`);
  } else if (referencesUnrecorded) {
    // 記録が無いと言いながら参照を並べたら、どちらかが嘘になる。
    if (references.length > 0) {
      failures.push(`${label} declares that its reference images were not recorded, so it must not list any reference image.`);
    }
  } else {
    const anchorReferences = references.filter((reference) => reference.role === "anchor");
    if (isAnchor && anchorReferences.length > 0) {
      failures.push(`${label} is the anchor and must not inherit architecture from another anchor image.`);
    }
    if (!isAnchor && !locationReferencesDerivedOnly(references)
      && (anchorReferences.length !== 1 || anchorReferences[0].sha256 !== nonEmpty(expectedAnchorSha256))) {
      failures.push(`${label} must declare exactly the current anchor board as its architecture reference.`);
    }
    if (references.some((reference) => reference.sha256 === entry.sha256)) {
      failures.push(`${label} lists itself as a reference image.`);
    }
  }
  return failures;
}

async function validExistingLocationBoard(path, minimumWidth, minimumHeight) {
  const buffer = await readFile(path);
  const dimensions = getImageDimensionsFromBuffer(buffer);
  if (!dimensions || dimensions.width < minimumWidth || dimensions.height < minimumHeight) {
    throw new Error(`Existing location board is below ${minimumWidth}x${minimumHeight}: ${path}`);
  }
  return { buffer, dimensions, sha256: sha256(buffer) };
}

export async function createKoyaLocationAnchorReviewDraft(options = {}) {
  const plan = buildKoyaLocationBoardPlan(options);
  const anchorJob = plan.jobs[0];
  const manifestPath = locationGenerationManifestPath(plan);
  let manifest = null;
  try { manifest = await readJsonStrict(manifestPath); } catch {}
  const anchorEntry = (Array.isArray(manifest?.entries) ? manifest.entries : []).find((entry) => entry?.boardId === anchorJob.boardId);
  let buffer = null;
  try { buffer = await readFile(anchorJob.outputPath); } catch {}
  let dimensions = null;
  try { dimensions = buffer ? getImageDimensionsFromBuffer(buffer) : null; } catch {}
  const location = locationBibleEntry(options.locationBible, plan.location.id);
  const imported = (Array.isArray(manifest?.entries) ? manifest.entries : []).some(isImportedLocationEntry);
  const anchorGap = koyaLocationEntryProvenanceGap(anchorEntry);
  const instructions = [
    "A reviewer in a different context from the anchor generator must inspect the anchor at original scale. Change only observed checks to true; continuity generation remains blocked until this exact SHA-bound review passes.",
    ...(imported ? ["These boards were imported from an external image tool: the reviewer context must also differ from the importer and from every external generator context recorded in the generation manifest, and the continuity views still need this review before the final review."] : []),
    ...(koyaLocationGapDeclares(anchorGap, "promptRecorded") || koyaLocationGapDeclares(anchorGap, "generatorContextRecorded")
      ? [`This anchor declares a provenance gap: its prompt and generator conversation were never recorded. Read the gap reason and the written specification named in the generation manifest (${nonEmpty(anchorGap.specificationPath)}), then set ${KOYA_LOCATION_PROVENANCE_GAP_CHECK} to true only if the anchor satisfies that specification.`]
      : []),
    ...(koyaLocationGapDeclares(anchorGap, "referenceImagesRecorded")
      ? [`This anchor declares that its reference images were never recorded. Read the gap reason and the written specification named in the generation manifest (${nonEmpty(anchorGap.specificationPath)}) and set ${KOYA_LOCATION_PROVENANCE_GAP_CHECK} to true only if the anchor satisfies it. No recorded reference shows what this board was drawn from, so the architecture continuity every later board is measured against has to be judged by eye here: set '${KOYA_LOCATION_BOARD_CONTINUITY_CHECK}' to true only when the architecture you see at original scale matches that specification.`]
      : []),
    ...(locationAllowsFictionalSignage(location) ? ["This location allows minimal fictional signage: set readableTextFictionalOnly only when every readable sign is an invented name and no real name or brand appears."] : []),
  ].join(" ");
  return {
    version: KOYA_LOCATION_ANCHOR_REVIEW_VERSION,
    locationId: plan.location.id,
    reviewer: { host: "", id: "", contextId: "" },
    reviewedAt: "",
    generationManifest: {
      path: manifestPath,
      anchorEntrySha256: anchorEntry ? locationAnchorEntrySha256(anchorEntry) : "",
    },
    anchor: {
      boardId: anchorJob.boardId,
      path: anchorJob.outputPath,
      sha256: buffer ? sha256(buffer) : "",
      dimensions,
      checks: Object.fromEntries(koyaLocationAnchorReviewCheckKeys(location, anchorEntry).map((key) => [key, false])),
    },
    instructions,
  };
}

export async function auditKoyaLocationAnchorReview(options = {}) {
  const plan = buildKoyaLocationBoardPlan(options);
  const anchorJob = plan.jobs[0];
  const review = options.review && typeof options.review === "object" ? options.review : null;
  const failures = [];
  if (!review) return { version: KOYA_LOCATION_ANCHOR_REVIEW_VERSION, pass: false, locationId: plan.location.id, failures: ["Location anchor review is required."] };
  storyReviewFailure(failures, review.version === KOYA_LOCATION_ANCHOR_REVIEW_VERSION, `Location anchor review version must be ${KOYA_LOCATION_ANCHOR_REVIEW_VERSION}.`);
  storyReviewFailure(failures, review.locationId === plan.location.id, "Location anchor review ID does not match the requested location.");
  storyReviewFailure(failures, nonEmpty(review?.reviewer?.host) && nonEmpty(review?.reviewer?.id) && nonEmpty(review?.reviewer?.contextId), "Independent anchor reviewer host, id, and contextId are required.");
  storyReviewFailure(failures, validIsoDate(review?.reviewedAt), "Location anchor review requires a valid ISO-8601 reviewedAt.");
  const expectedManifestPath = locationGenerationManifestPath(plan);
  const manifestPath = resolve(nonEmpty(review?.generationManifest?.path));
  let manifest = null;
  if (!nonEmpty(review?.generationManifest?.path)) failures.push("Location anchor review requires the official generation manifest path.");
  else if (manifestPath !== resolve(expectedManifestPath)) failures.push("Location anchor review must bind the official planned generation manifest path.");
  else {
    try {
      manifest = await readJsonStrict(manifestPath);
      if (!inside(resolve(options.projectDir || process.cwd()), manifestPath)) failures.push("Location anchor generation manifest must stay inside the project.");
      if (manifest.version !== KOYA_LOCATION_GENERATION_MANIFEST_VERSION || manifest.locationId !== plan.location.id) failures.push("Location anchor generation manifest version or locationId is invalid.");
    } catch (error) { failures.push(`Location anchor generation manifest is missing or invalid: ${error.message}`); }
  }
  const entries = Array.isArray(manifest?.entries) ? manifest.entries : [];
  const matchingEntries = entries.filter((entry) => entry?.boardId === anchorJob.boardId);
  const generated = matchingEntries[0];
  if (matchingEntries.length !== 1) failures.push("Location generation manifest must contain the anchor board exactly once.");
  if (!generated || locationAnchorEntrySha256(generated) !== nonEmpty(review?.generationManifest?.anchorEntrySha256)) {
    failures.push("Location anchor entry SHA-256 does not match the reviewed generation evidence.");
  }
  const reviewed = review?.anchor;
  if (reviewed?.boardId !== anchorJob.boardId) failures.push("Location anchor review must cover the planned anchor board.");
  const assetPath = resolve(nonEmpty(reviewed?.path));
  if (assetPath !== resolve(anchorJob.outputPath)) failures.push("Location anchor review path must match the planned anchor output.");
  if (!inside(resolve(options.projectDir || process.cwd()), assetPath)) failures.push("Location anchor asset must stay inside the recipient project.");
  let buffer = null;
  try { buffer = await readFile(assetPath); } catch { failures.push(`Location anchor asset is missing: ${assetPath}`); }
  const actualSha256 = buffer ? sha256(buffer) : "";
  let dimensions = null;
  try { dimensions = buffer ? getImageDimensionsFromBuffer(buffer) : null; } catch {}
  const minimumWidth = Number(options.locationBible.reviewContract.minimumWidth || 1280);
  const minimumHeight = Number(options.locationBible.reviewContract.minimumHeight || 720);
  if (!/^[a-f0-9]{64}$/u.test(nonEmpty(reviewed?.sha256)) || reviewed.sha256 !== actualSha256) failures.push("Location anchor SHA-256 does not match disk.");
  if (!dimensions || dimensions.width < minimumWidth || dimensions.height < minimumHeight) failures.push(`Location anchor must be reviewed at ${minimumWidth}x${minimumHeight} or larger.`);
  if (!generated || resolve(nonEmpty(generated.path)) !== assetPath || generated.sha256 !== actualSha256) failures.push("Location anchor is not bound to the official generation manifest.");
  const anchorImported = isImportedLocationEntry(generated);
  const anchorGap = koyaLocationEntryProvenanceGap(generated);
  if (anchorImported) {
    // 取り込んだアンカーの prompt SHA は実際に使った文の SHA なので、計画
    // プロンプトとは比べない。代わりに取り込み時の計画プロンプト SHA と
    // 保存した文の SHA を import ブロックの側で確かめる。
    if (nonEmpty(generated?.anchorSha256)) failures.push("Location anchor generation prompt or anchor binding is invalid.");
    failures.push(...importedLocationEntryFailures({ entry: generated, job: anchorJob, isAnchor: true, expectedAnchorSha256: "", label: "Location anchor" }));
  } else if (generated?.promptSha256 !== sha256(anchorJob.prompt) || nonEmpty(generated?.anchorSha256)) {
    failures.push("Location anchor generation prompt or anchor binding is invalid.");
  }
  // 会話まで残っていないと宣言したボードにだけ会話 id が無い。他の記録が
  // 欠けているだけのボードは、今までどおり会話 id を要る。
  if (!nonEmpty(generated?.generator?.host) || !nonEmpty(generated?.generator?.id)
    || (!koyaLocationGapDeclares(anchorGap, "generatorContextRecorded") && !nonEmpty(generated?.generator?.contextId))) failures.push("Location anchor generation provenance is incomplete.");
  const reviewerContextId = nonEmpty(review?.reviewer?.contextId);
  const anchorGeneratorContextId = nonEmpty(generated?.generator?.contextId);
  if (anchorGeneratorContextId && anchorGeneratorContextId === reviewerContextId) failures.push("Location anchor must be reviewed in a context different from its generator.");
  if (entries.some(isImportedLocationEntry)) {
    // 取り込みでは4枚が審査より前に揃っているので、アンカーの審査者も
    // 取り込んだ人と全ての外部生成 context から独立していなければならない。
    for (const entry of entries) {
      const entryContextId = nonEmpty(entry?.generator?.contextId);
      if (entry !== generated && entryContextId && entryContextId === reviewerContextId) {
        failures.push(`Location anchor must be reviewed in a context different from every external generator (${nonEmpty(entry?.boardId) || "unknown board"}).`);
      }
      if (isImportedLocationEntry(entry) && nonEmpty(entry?.import?.importedBy?.contextId) === reviewerContextId) {
        failures.push(`Location anchor must be reviewed in a context different from the importer (${nonEmpty(entry?.boardId) || "unknown board"}).`);
      }
    }
  }
  const anchorLocation = locationBibleEntry(options.locationBible, plan.location.id);
  for (const key of koyaLocationAnchorReviewCheckKeys(anchorLocation, generated)) {
    if (reviewed?.checks?.[key] !== true) failures.push(`Location anchor check '${key}' must be true.`);
  }
  const anchorMisplacement = locationGapCheckMisplacementFailure(reviewed?.checks, anchorGap, "Location anchor");
  if (anchorMisplacement) failures.push(anchorMisplacement);
  return {
    version: KOYA_LOCATION_ANCHOR_REVIEW_VERSION,
    pass: failures.length === 0,
    locationId: plan.location.id,
    review,
    manifestPath,
    anchorEntry: generated || null,
    anchorEntrySha256: generated ? locationAnchorEntrySha256(generated) : "",
    anchor: { path: assetPath, sha256: actualSha256, dimensions },
    failures,
  };
}

async function generateKoyaLocationBoardsUnlocked(options = {}) {
  const authority = options.authority || await readKoyaChannelAuthority({ projectDir: options.projectDir });
  if (authority.source !== "project") throw new Error("Restore the Koya project authority before generating location boards.");
  const generator = options.generator && typeof options.generator === "object" ? options.generator : {};
  for (const key of ["host", "id", "contextId"]) if (!nonEmpty(generator[key])) throw new Error(`Location generator.${key} is required for independent review provenance.`);
  const stage = nonEmpty(options.stage);
  if (!new Set(["anchor", "continuity"]).has(stage)) throw new Error("Location generation stage must be anchor or continuity; combined all-stage generation is forbidden because the anchor requires human review first.");
  const plan = buildKoyaLocationBoardPlan({
    projectDir: authority.projectDir,
    locationBible: authority.locationBible,
    showBible: authority.showBible,
    locationId: options.locationId,
    outputDir: options.outputDir,
  });
  const canvasDir = resolveCanvasDir({ projectDir: authority.projectDir });
  if (plan.jobs.some((job) => !inside(canvasDir, resolve(job.outputPath)))) throw new Error("Location boards must be generated inside canvas/ for portable review and handoff.");
  const minimumWidth = Number(authority.locationBible.reviewContract.minimumWidth || 1280);
  const minimumHeight = Number(authority.locationBible.reviewContract.minimumHeight || 720);
  const anchorJob = plan.jobs[0];
  const targetJobs = stage === "anchor" ? [anchorJob] : plan.jobs.slice(1);
  // 宣言されたスタイル参照が実在しないまま生成に入ると、プロンプトは
  // 「参照画像1-4はスタイル専用」と言っているのに参照が渡らない。
  // 齟齬を黙って通さず、生成の前に落とす。
  for (const path of new Set(targetJobs.flatMap((job) => job.references.style))) {
    if (!await exists(path)) throw new Error(`Declared channel art-style reference is missing: ${path}`);
  }
  const imageGenerator = typeof options.generateImage === "function" ? options.generateImage : generateImageMedia;
  const generatedAt = new Date().toISOString();
  const manifestPath = locationGenerationManifestPath(plan);
  let priorManifest = null;
  let priorEntries = [];
  if (await exists(manifestPath)) {
    priorManifest = await readJsonStrict(manifestPath);
    if (priorManifest.version !== KOYA_LOCATION_GENERATION_MANIFEST_VERSION || priorManifest.locationId !== plan.location.id) throw new Error(`Existing location generation manifest does not match ${plan.location.id}.`);
    const expectedBoardIds = plan.jobs.map((job) => job.boardId);
    if (JSON.stringify(priorManifest.requiredBoardIds || []) !== JSON.stringify(expectedBoardIds)) throw new Error("Existing location generation manifest does not match the current board plan.");
    priorEntries = Array.isArray(priorManifest.entries) ? priorManifest.entries : [];
    const priorIds = priorEntries.map((entry) => entry?.boardId);
    if (new Set(priorIds).size !== priorIds.length || priorIds.some((id) => !expectedBoardIds.includes(id))) throw new Error("Existing location generation manifest contains duplicate or unknown board IDs.");
  }
  const priorByBoardId = new Map(priorEntries.map((entry) => [entry.boardId, entry]));
  const results = [];
  let anchorEvidence = null;
  let anchorApproval = null;
  if (stage === "continuity") {
    try { anchorEvidence = await validExistingLocationBoard(anchorJob.outputPath, minimumWidth, minimumHeight); }
    catch (error) { throw new Error(`Generate a valid anchor board before continuity views: ${error.message}`); }
    const priorAnchor = priorByBoardId.get(anchorJob.boardId);
    if (!priorAnchor || priorAnchor.sha256 !== anchorEvidence.sha256 || resolve(priorAnchor.path) !== resolve(anchorJob.outputPath)) {
      throw new Error("The anchor board is not bound to the official location generation manifest; regenerate it with stage=anchor and force=true.");
    }
    const anchorReviewPath = resolve(nonEmpty(options.anchorReviewPath));
    if (!nonEmpty(options.anchorReviewPath)) throw new Error("A SHA-bound location anchor review path is required before continuity generation.");
    if (!inside(canvasDir, anchorReviewPath)) throw new Error("Location anchor review must be stored inside canvas/ for portable handoff.");
    const anchorReview = await readJsonStrict(anchorReviewPath);
    const anchorAudit = await auditKoyaLocationAnchorReview({
      projectDir: authority.projectDir,
      locationBible: authority.locationBible,
      showBible: authority.showBible,
      locationId: plan.location.id,
      outputDir: dirname(anchorJob.outputPath),
      review: anchorReview,
    });
    if (!anchorAudit.pass) throw new Error(`Koya location anchor review failed: ${anchorAudit.failures.join("; ")}`);
    anchorApproval = {
      path: anchorReviewPath,
      sha256: sha256(await readFile(anchorReviewPath)),
      anchorSha256: anchorEvidence.sha256,
      reviewedAt: anchorReview.reviewedAt,
      reviewer: anchorReview.reviewer,
    };
    if (options.force !== true
      && priorEntries.some((entry) => entry.boardId !== anchorJob.boardId)
      && JSON.stringify(priorManifest?.anchorApproval || null) !== JSON.stringify(anchorApproval)) {
      throw new Error("Existing continuity views were generated under a different anchor approval; pass force=true to regenerate continuity from the current approved anchor.");
    }
  }
  const workingByBoardId = new Map(stage === "anchor" ? [] : priorEntries.map((entry) => [entry.boardId, entry]));
  let manifest = priorManifest;
  let wroteManifest = false;
  // 非アンカーの背景はアンカー1枚だけに依存し、互いには依存しない。
  // アンカーを先に片付けてから残りを同時に投げる。順序を守るのは
  // anchorEvidence の確立だけで、そこから先は並列にしてよい。
  const resultsByIndex = new Array(targetJobs.length);

  // マニフェストは1つのファイル。書き込みだけは直列に流す。
  // 並列のジョブから writeJsonAtomic を同時に呼ぶと、後から始まった
  // 書き込みが先に終わって古い内容が残ることがある。
  let manifestWrite = Promise.resolve();
  const queueManifestWrite = (next) => {
    manifestWrite = manifestWrite.then(next, next);
    return manifestWrite;
  };

  const processJob = async (job, jobIndex) => {
    const isAnchor = job.boardId === anchorJob.boardId;
    if (!isAnchor && !anchorEvidence) anchorEvidence = await validExistingLocationBoard(anchorJob.outputPath, minimumWidth, minimumHeight);
    let evidence = null;
    let reused = false;
    if (await exists(job.outputPath) && options.force !== true) {
      evidence = await validExistingLocationBoard(job.outputPath, minimumWidth, minimumHeight);
      reused = true;
      const prior = priorByBoardId.get(job.boardId);
      if (!prior || prior.sha256 !== evidence.sha256 || resolve(prior.path) !== resolve(job.outputPath) || !nonEmpty(prior?.generator?.contextId)) {
        throw new Error(`${job.boardId} exists without matching official generation provenance; pass force=true to regenerate it.`);
      }
      if (prior.promptSha256 !== sha256(job.prompt) || (!isAnchor && prior.anchorSha256 !== anchorEvidence.sha256)) {
        throw new Error(`${job.boardId} was generated from a stale location prompt or anchor; pass force=true to regenerate it.`);
      }
    } else {
      const media = await imageGenerator({
        prompt: job.prompt,
        model: nonEmpty(options.model) || "gpt-image-2-codex",
        aspectRatio: "16:9",
        imageSize: "2K",
        quality: "high",
        imageCount: 1,
        fileName: basename(job.outputPath),
        // 建築参照とスタイル参照は plan が種類ごとに決めている。ここで
        // 作り直すと、また2種類が1つの真偽値に潰れる。
        referenceImagePaths: job.referenceImagePaths,
      });
      const buffer = media?.buffer instanceof Buffer ? media.buffer : media?.buffer ? Buffer.from(media.buffer) : null;
      if (!buffer) throw new Error(`Location generation returned no image for ${job.boardId}.`);
      const dimensions = getImageDimensionsFromBuffer(buffer);
      if (!dimensions || dimensions.width < minimumWidth || dimensions.height < minimumHeight) {
        throw new Error(`${job.boardId} generation is below ${minimumWidth}x${minimumHeight}; no file was accepted.`);
      }
      await mkdir(dirname(job.outputPath), { recursive: true });
      await writeFile(job.outputPath, buffer);
      evidence = { buffer, dimensions, sha256: sha256(buffer) };
    }
    const currentResult = {
      boardId: job.boardId,
      path: job.outputPath,
      sha256: evidence.sha256,
      dimensions: evidence.dimensions,
      promptSha256: sha256(job.prompt),
      anchorSha256: isAnchor ? "" : anchorEvidence.sha256,
      generator: { host: nonEmpty(generator.host), id: nonEmpty(generator.id), contextId: nonEmpty(generator.contextId) },
      generatedAt,
      reused,
    };
    const result = reused ? { ...priorByBoardId.get(job.boardId), reused: true } : currentResult;
    resultsByIndex[jobIndex] = result;
    workingByBoardId.set(job.boardId, reused ? priorByBoardId.get(job.boardId) : currentResult);
    if (!reused) {
      manifest = {
        version: KOYA_LOCATION_GENERATION_MANIFEST_VERSION,
        locationId: plan.location.id,
        requiredBoardIds: plan.jobs.map((entry) => entry.boardId),
        entries: plan.jobs.map((entry) => workingByBoardId.get(entry.boardId)).filter(Boolean),
        anchorApproval: stage === "continuity" ? anchorApproval : null,
        updatedAt: generatedAt,
      };
      await queueManifestWrite(() => writeJsonAtomic(manifestPath, manifest));
      wroteManifest = true;
    }
    if (isAnchor) anchorEvidence = evidence;
    };

  const anchorIndex = targetJobs.findIndex((job) => job.boardId === anchorJob.boardId);
  if (anchorIndex >= 0) {
    // アンカーは他の参照元になるので必ず先に確定させる。
    await processJob(targetJobs[anchorIndex], anchorIndex);
  }
  await Promise.all(
    targetJobs
      .map((job, jobIndex) => ({ job, jobIndex }))
      .filter(({ jobIndex }) => jobIndex !== anchorIndex)
      .map(({ job, jobIndex }) => processJob(job, jobIndex)),
  );
  await manifestWrite;
  results.push(...resultsByIndex.filter(Boolean));

  if (!wroteManifest && !manifest) throw new Error("No location board was generated and no official manifest exists.");
  const manifestSha256 = sha256(await readFile(manifestPath));
  const complete = JSON.stringify((manifest.entries || []).map((entry) => entry.boardId)) === JSON.stringify(plan.jobs.map((job) => job.boardId));
  return { locationId: plan.location.id, stage, manifestPath, manifestSha256, results, complete, manifestRewritten: wroteManifest };
}

export async function generateKoyaLocationBoards(options = {}) {
  const authority = options.authority || await readKoyaChannelAuthority({ projectDir: options.projectDir });
  if (authority.source !== "project") throw new Error("Restore the Koya project authority before generating location boards.");
  const plan = buildKoyaLocationBoardPlan({
    projectDir: authority.projectDir,
    locationBible: authority.locationBible,
    showBible: authority.showBible,
    locationId: options.locationId,
    outputDir: options.outputDir,
  });
  const manifestPath = locationGenerationManifestPath(plan);
  return withCanvasFileLock(
    manifestPath,
    () => generateKoyaLocationBoardsUnlocked({ ...options, authority }),
    { timeoutMs: 30 * 60_000, staleMs: 2 * 60 * 60_000 },
  );
}

function exactKeyFailures(value, required, optional, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [`${label} must be an object.`];
  const allowed = new Set([...required, ...optional]);
  const failures = [];
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) failures.push(`${label} has unknown key(s): ${unknown.join(", ")}.`);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) failures.push(`${label} is missing required key(s): ${missing.join(", ")}.`);
  return failures;
}

async function readImportFile(path, label, failures) {
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      failures.push(`${label} is not a regular file: ${path}`);
      return null;
    }
    return await readFile(path);
  } catch (error) {
    failures.push(`${label} cannot be read (${error.code || error.message}): ${path}`);
    return null;
  }
}

async function writeFileAtomic(path, buffer) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporaryPath, buffer);
  await rename(temporaryPath, path);
}

/**
 * 取り込みマップ（koya-location-import-map-v1）を厳密に検証し、書き込む内容を
 * メモリ上に揃える。ファイルはここで一度だけ読み、SHA を確かめたバイト列を
 * そのまま書くので、検証と書き込みの間にファイルが差し替わっても混ざらない。
 */
async function validateKoyaLocationImportMap({ plan, locationBible, importMapPath, mapBytes }) {
  const failures = [];
  let map = null;
  try { map = JSON.parse(mapBytes.toString("utf8")); }
  catch (error) { return { failures: [`import map is not valid JSON: ${error.message}`] }; }
  failures.push(...exactKeyFailures(map, ["version", "locationId", "importedBy", "boards"], [], "import map"));
  if (failures.length > 0) return { failures };
  if (map.version !== KOYA_LOCATION_IMPORT_MAP_VERSION) failures.push(`import map version must be ${KOYA_LOCATION_IMPORT_MAP_VERSION}.`);
  if (map.locationId !== plan.location.id) failures.push(`import map locationId must be ${plan.location.id}.`);
  const importerFailures = exactKeyFailures(map.importedBy, ["host", "id", "contextId"], [], "importedBy");
  failures.push(...importerFailures);
  if (importerFailures.length === 0 && ["host", "id", "contextId"].some((key) => !nonEmpty(map.importedBy[key]))) {
    failures.push("importedBy host, id, and contextId must be non-empty strings (the importer context is required for reviewer independence).");
  }
  const mapDir = dirname(importMapPath);
  const resolveMapPath = (value) => (isAbsolute(value) ? resolve(value) : resolve(mapDir, value));
  const minimumWidth = Number(locationBible.reviewContract.minimumWidth || 1280);
  const minimumHeight = Number(locationBible.reviewContract.minimumHeight || 720);
  const jobs = plan.jobs;
  if (!Array.isArray(map.boards) || map.boards.length !== jobs.length) {
    failures.push(`import map boards must list every one of the ${jobs.length} required boards exactly once.`);
  }
  const rowsByIndex = new Map();
  for (const [position, board] of (Array.isArray(map.boards) ? map.boards : []).entries()) {
    const label = `boards[${position}]`;
    const shapeFailures = exactKeyFailures(
      board,
      ["sourcePath", "sourceSha256", "generator", "referenceImages"],
      ["boardIndex", "boardLabel", "promptText", "promptPath", "promptSha256", "note", "provenanceGap"],
      label,
    );
    if (shapeFailures.length > 0) { failures.push(...shapeFailures); continue; }
    const hasGap = Object.hasOwn(board, "provenanceGap");
    // 3つの旗は独立に読む。false 以外は下の形の検査で落ちるので、
    // ここで先に読んでも「true と書けば規則を外せる」道はできない。
    const declaredGap = hasGap && board.provenanceGap && typeof board.provenanceGap === "object" ? board.provenanceGap : null;
    const promptUnrecorded = koyaLocationGapDeclares(declaredGap, "promptRecorded");
    const contextUnrecorded = koyaLocationGapDeclares(declaredGap, "generatorContextRecorded");
    const referencesUnrecorded = koyaLocationGapDeclares(declaredGap, "referenceImagesRecorded");
    // 必須ボードの特定: 1始まりの boardIndex か、requiredBoards と完全一致する boardLabel。
    let jobIndex = -1;
    const hasIndex = Object.hasOwn(board, "boardIndex");
    const hasLabel = Object.hasOwn(board, "boardLabel");
    if (!hasIndex && !hasLabel) failures.push(`${label} must name its required board by boardIndex or boardLabel.`);
    if (hasIndex) {
      if (!Number.isInteger(board.boardIndex) || board.boardIndex < 1 || board.boardIndex > jobs.length) {
        failures.push(`${label}.boardIndex must be an integer from 1 to ${jobs.length}.`);
      } else jobIndex = board.boardIndex - 1;
    }
    if (hasLabel) {
      const matches = jobs.map((job, index) => (job.boardLabel === board.boardLabel ? index : -1)).filter((index) => index >= 0);
      if (typeof board.boardLabel !== "string" || matches.length === 0) {
        failures.push(`${label}.boardLabel does not exactly match a required board of ${plan.location.id}.`);
        jobIndex = -1;
      } else if (hasIndex) {
        if (jobIndex >= 0 && !matches.includes(jobIndex)) {
          failures.push(`${label}.boardIndex and boardLabel name different required boards.`);
          jobIndex = -1;
        }
      } else if (matches.length > 1) {
        failures.push(`${label}.boardLabel is ambiguous; add boardIndex.`);
      } else jobIndex = matches[0];
    }
    if (jobIndex >= 0 && rowsByIndex.has(jobIndex)) {
      failures.push(`${label} names required board ${jobIndex + 1} (${jobs[jobIndex].boardLabel}) a second time.`);
      continue;
    }
    const row = { position, label, jobIndex, board, referencesUnrecorded };
    if (jobIndex >= 0) rowsByIndex.set(jobIndex, row);

    if (!nonEmpty(board.sourcePath)) failures.push(`${label}.sourcePath is required.`);
    if (!validSha256Hex(board.sourceSha256)) failures.push(`${label}.sourceSha256 must be a lowercase SHA-256.`);
    if (nonEmpty(board.sourcePath)) {
      row.sourcePath = resolveMapPath(board.sourcePath);
      row.buffer = await readImportFile(row.sourcePath, `${label}.sourcePath`, failures);
      if (row.buffer) {
        row.sha256 = sha256(row.buffer);
        if (validSha256Hex(board.sourceSha256) && row.sha256 !== board.sourceSha256) {
          failures.push(`${label}.sourceSha256 does not match the source file (${row.sha256}).`);
        }
        // 保存先は計画どおりの .png。中身が PNG でないファイルを .png として置かない。
        if (row.buffer.length < 24 || !row.buffer.subarray(0, 8).equals(PNG_SIGNATURE) || row.buffer.toString("ascii", 12, 16) !== "IHDR") {
          failures.push(`${label}.sourcePath must be a PNG image (convert it losslessly first and record the converted file's SHA-256).`);
        } else {
          row.dimensions = getImageDimensionsFromBuffer(row.buffer);
          if (row.dimensions.width < minimumWidth || row.dimensions.height < minimumHeight) {
            failures.push(`${label} is ${row.dimensions.width}x${row.dimensions.height}; location boards must be at least ${minimumWidth}x${minimumHeight}.`);
          }
        }
      }
    }

    // 出所欠落を宣言したボードは会話 id を持たない（持っていたら矛盾なので拒む）。
    // host・id・生成時刻は欠落を宣言しても要る。
    const generatorFailures = exactKeyFailures(
      board.generator,
      contextUnrecorded ? ["host", "id", "generatedAt"] : ["host", "id", "contextId", "generatedAt"],
      contextUnrecorded ? ["contextId"] : [],
      `${label}.generator`,
    );
    failures.push(...generatorFailures);
    if (generatorFailures.length === 0) {
      if (!nonEmpty(board.generator.host) || !nonEmpty(board.generator.id)) failures.push(`${label}.generator host and id must be non-empty.`);
      if (contextUnrecorded) {
        if (Object.hasOwn(board.generator, "contextId")) {
          failures.push(`${label}.generator.contextId is recorded even though ${label}.provenanceGap says the conversation was not; drop one of the two.`);
        }
      } else if (!nonEmpty(board.generator.contextId)) failures.push(`${label}.generator.contextId must name the conversation that produced the image.`);
      if (!validIsoDate(board.generator.generatedAt)) failures.push(`${label}.generator.generatedAt must be a valid ISO-8601 date.`);
    }

    const hasPromptText = Object.hasOwn(board, "promptText");
    const hasPromptPath = Object.hasOwn(board, "promptPath");
    if (hasGap) {
      const gapFailures = exactKeyFailures(board.provenanceGap, LOCATION_PROVENANCE_GAP_KEYS, LOCATION_PROVENANCE_GAP_FLAGS, `${label}.provenanceGap`);
      failures.push(...gapFailures);
      if (gapFailures.length === 0) {
        const gap = board.provenanceGap;
        // 宣言した旗だけを記録に残す。書いていない旗は「その記録はある」の意味。
        const declaredFlags = LOCATION_PROVENANCE_GAP_FLAGS.filter((flag) => Object.hasOwn(gap, flag));
        if (declaredFlags.length === 0) {
          failures.push(`${label}.provenanceGap must declare at least one of ${LOCATION_PROVENANCE_GAP_FLAGS.join(", ")} as false; an empty declaration says nothing.`);
        }
        if (declaredFlags.some((flag) => gap[flag] !== false)) {
          failures.push(`${label}.provenanceGap is only for records that do not exist: ${LOCATION_PROVENANCE_GAP_FLAGS.join(", ")} may only be false.`);
        }
        if (typeof gap.reason !== "string" || !gap.reason.trim() || gap.reason.length > MAX_LOCATION_PROVENANCE_GAP_REASON) {
          failures.push(`${label}.provenanceGap.reason must say in at most ${MAX_LOCATION_PROVENANCE_GAP_REASON} characters why those records were never kept.`);
        }
        if (!nonEmpty(gap.specificationPath) || !validSha256Hex(gap.specificationSha256)) {
          failures.push(`${label}.provenanceGap requires specificationPath and a lowercase specificationSha256 of the written specification the board was made to satisfy.`);
        } else {
          const specificationPath = resolveMapPath(gap.specificationPath);
          const specificationBytes = await readImportFile(specificationPath, `${label}.provenanceGap.specificationPath`, failures);
          if (specificationBytes && sha256(specificationBytes) !== gap.specificationSha256) {
            failures.push(`${label}.provenanceGap.specificationSha256 does not match the specification file.`);
          } else if (specificationBytes) {
            row.provenanceGap = {
              ...Object.fromEntries(declaredFlags.map((flag) => [flag, false])),
              reason: gap.reason,
              specificationPath,
              specificationSha256: gap.specificationSha256,
            };
          }
        }
      }
    }
    if (promptUnrecorded) {
      // 記録が無いと宣言したボードにプロンプトが付いていたら、どちらかが嘘になる。
      if (hasPromptText || hasPromptPath || Object.hasOwn(board, "promptSha256")) {
        failures.push(`${label} records both a prompt and a provenanceGap; a board has complete provenance or a declared gap, never both.`);
      }
    } else if (hasPromptText === hasPromptPath) {
      failures.push(`${label} must record the prompt actually used as promptText or as promptPath + promptSha256 (exactly one).`);
    } else if (hasPromptText) {
      if (typeof board.promptText !== "string" || !board.promptText.trim()) failures.push(`${label}.promptText must be the non-empty prompt actually used.`);
      else {
        row.promptText = board.promptText;
        row.promptPath = "";
        if (Object.hasOwn(board, "promptSha256") && board.promptSha256 !== sha256(board.promptText)) {
          failures.push(`${label}.promptSha256 does not match promptText.`);
        }
      }
    } else if (!nonEmpty(board.promptPath) || !validSha256Hex(board.promptSha256)) {
      failures.push(`${label}.promptPath requires a lowercase promptSha256.`);
    } else {
      row.promptPath = resolveMapPath(board.promptPath);
      const promptBytes = await readImportFile(row.promptPath, `${label}.promptPath`, failures);
      if (promptBytes) {
        const promptText = promptBytes.toString("utf8");
        if (sha256(promptBytes) !== board.promptSha256) failures.push(`${label}.promptSha256 does not match the prompt file.`);
        else if (!Buffer.from(promptText, "utf8").equals(promptBytes) || !promptText.trim()) {
          failures.push(`${label}.promptPath must be a non-empty UTF-8 text file.`);
        } else row.promptText = promptText;
      }
    }

    if (!Array.isArray(board.referenceImages)) failures.push(`${label}.referenceImages must be an array (empty when no image was attached).`);
    row.referenceImages = [];
    for (const [referenceIndex, reference] of (Array.isArray(board.referenceImages) ? board.referenceImages : []).entries()) {
      const referenceLabel = `${label}.referenceImages[${referenceIndex}]`;
      const referenceFailures = exactKeyFailures(reference, ["path", "sha256", "role"], [], referenceLabel);
      if (referenceFailures.length > 0) { failures.push(...referenceFailures); continue; }
      if (!LOCATION_IMPORT_REFERENCE_ROLES.includes(reference.role)) {
        failures.push(`${referenceLabel}.role must be one of: ${LOCATION_IMPORT_REFERENCE_ROLES.join(", ")}.`);
      }
      if (!nonEmpty(reference.path) || !validSha256Hex(reference.sha256)) {
        failures.push(`${referenceLabel} requires a path and a lowercase SHA-256.`);
        continue;
      }
      const referencePath = resolveMapPath(reference.path);
      const referenceBytes = await readImportFile(referencePath, referenceLabel, failures);
      if (referenceBytes && sha256(referenceBytes) !== reference.sha256) failures.push(`${referenceLabel}.sha256 does not match the reference file.`);
      row.referenceImages.push({ path: referencePath, sha256: reference.sha256, role: reference.role });
    }
    // 参照の記録が無いと宣言したボードは、空で通す。1枚でも並べたら、
    // 「記録が無い」と「これを使った」のどちらかが嘘になる。
    if (referencesUnrecorded && row.referenceImages.length > 0) {
      failures.push(`${label}.provenanceGap says the reference images were not recorded, so referenceImages must be empty; it cannot also name the anchor or any other reference.`);
    }

    if (Object.hasOwn(board, "note") && (typeof board.note !== "string" || board.note.length > 2000)) {
      failures.push(`${label}.note must be a string of at most 2000 characters.`);
    }
  }
  for (const [index, job] of jobs.entries()) {
    if (!rowsByIndex.has(index)) failures.push(`import map is missing required board ${index + 1} (${job.boardLabel}).`);
  }
  const rows = [...rowsByIndex.values()].sort((left, right) => left.jobIndex - right.jobIndex);
  const shas = rows.map((row) => row.sha256).filter(Boolean);
  if (new Set(shas).size !== shas.length) failures.push("Every required board must be a distinct image; two boards share a SHA-256.");
  const anchorSha256 = rowsByIndex.get(0)?.sha256 || "";
  for (const row of rows) {
    const anchorReferences = row.referenceImages.filter((reference) => reference.role === "anchor");
    if (row.jobIndex === 0 && anchorReferences.length > 0) {
      failures.push(`${row.label} is the anchor board; it establishes the architecture and cannot list an anchor reference.`);
    }
    // 参照の記録が無いと宣言した継続ビューだけは、アンカー参照を要求しない。
    // 代わりにアンカーとの一致は審査者が目で見る（下書きの指示に書く）。
    // 承認済みの絵を直して作ったボード（derived だけ）も、アンカー参照を要求しない。
    // アンカーを添付していないのに anchor と書けば作り話になるので、一致は審査者が目で見る。
    if (row.jobIndex > 0 && !row.referencesUnrecorded && !locationReferencesDerivedOnly(row.referenceImages)
      && (anchorReferences.length !== 1 || !anchorSha256 || anchorReferences[0].sha256 !== anchorSha256)) {
      failures.push(`${row.label} is a continuity view; list the imported anchor board (sha256 ${anchorSha256 || "unknown"}) exactly once as its role "anchor" reference, or list the approved images it was edited from as role "derived" references.`);
    }
    if (row.sha256 && row.referenceImages.some((reference) => reference.sha256 === row.sha256)) {
      failures.push(`${row.label} lists itself as a reference image.`);
    }
  }
  return { failures, map, rows, anchorSha256 };
}

async function moveToSuperseded({ path, supersededDir, moved }) {
  await mkdir(supersededDir, { recursive: true });
  let target = join(supersededDir, basename(path));
  for (let suffix = 2; await exists(target); suffix += 1) target = join(supersededDir, `${suffix}-${basename(path)}`);
  await rename(path, target);
  moved.push({ from: path, to: target });
}

async function importKoyaLocationBoardsUnlocked({ authority, plan, importMapPath, canvasDir }) {
  const manifestPath = locationGenerationManifestPath(plan);
  let mapBytes;
  try { mapBytes = await readFile(importMapPath); }
  catch (error) { throw new Error(`Koya location import map cannot be read: ${importMapPath}: ${error.message}`); }
  const validated = await validateKoyaLocationImportMap({ plan, locationBible: authority.locationBible, importMapPath, mapBytes });
  if (validated.failures.length > 0) {
    throw new Error(`Koya location import map is invalid; nothing was written:\n- ${validated.failures.join("\n- ")}`);
  }
  // 承認済みの登録が参照しているファイルを差し替えると、本編の画像生成が
  // 審査していないボードを黙って使う。登録を archived にするか、別の
  // --output-dir へ取り込むまで止める。
  const registry = await readCharacterRegistry({ projectDir: authority.projectDir });
  const targets = new Set([...plan.jobs.map((job) => resolve(job.outputPath)), resolve(manifestPath)]);
  for (const entry of registry.characters.filter((character) => character.status === "approved")) {
    const referenced = [...(entry.referenceImagePaths || []), ...(entry.referenceAssets || []).map((asset) => asset.path)]
      .map((value) => (isAbsolute(value) ? resolve(value) : resolve(canvasDir, value)));
    const collision = referenced.find((path) => targets.has(path));
    if (collision) {
      throw new Error(`Approved registry entry ${entry.id} still references ${collision}; archive that registration or import into a different --output-dir first. Nothing was written.`);
    }
  }
  const importedAt = new Date().toISOString();
  const supersededDir = join(dirname(manifestPath), `superseded-${importedAt.replace(/[:.]/gu, "-")}`);
  const moved = [];
  const writes = [];
  for (const row of validated.rows) {
    const job = plan.jobs[row.jobIndex];
    if (await exists(job.outputPath)) {
      const current = await readFile(job.outputPath);
      if (sha256(current) === row.sha256) continue;
      await moveToSuperseded({ path: job.outputPath, supersededDir, moved });
    }
    writes.push({ path: job.outputPath, buffer: row.buffer });
  }
  if (await exists(manifestPath)) await moveToSuperseded({ path: manifestPath, supersededDir, moved });
  // 元ファイルは動かさずに複製する（メモリ上の検証済みバイト列を書く）。
  for (const write of writes) await writeFileAtomic(write.path, write.buffer);
  const importedBy = {
    host: nonEmpty(validated.map.importedBy.host),
    id: nonEmpty(validated.map.importedBy.id),
    contextId: nonEmpty(validated.map.importedBy.contextId),
  };
  const mapSha256 = sha256(mapBytes);
  const entries = validated.rows.map((row) => {
    const job = plan.jobs[row.jobIndex];
    const board = row.board;
    const gap = row.provenanceGap || null;
    const promptUnrecorded = koyaLocationGapDeclares(gap, "promptRecorded");
    const contextUnrecorded = koyaLocationGapDeclares(gap, "generatorContextRecorded");
    const referencesUnrecorded = koyaLocationGapDeclares(gap, "referenceImagesRecorded");
    return {
      boardId: job.boardId,
      path: job.outputPath,
      sha256: row.sha256,
      dimensions: row.dimensions,
      // 欠落を宣言したボードのプロンプト SHA は作らない。無いものは空で残す。
      promptSha256: promptUnrecorded ? "" : sha256(row.promptText),
      // 参照の記録が無いボードにアンカーの SHA を書けば、それは
      // 「アンカーを参照した」という作り話の記録になる。空で残す。
      anchorSha256: row.jobIndex === 0 || referencesUnrecorded || locationReferencesDerivedOnly(row.referenceImages)
        ? ""
        : validated.anchorSha256,
      generator: {
        host: nonEmpty(board.generator.host),
        id: nonEmpty(board.generator.id),
        ...(contextUnrecorded ? {} : { contextId: nonEmpty(board.generator.contextId) }),
      },
      generatedAt: board.generator.generatedAt,
      reused: false,
      import: {
        mapVersion: KOYA_LOCATION_IMPORT_MAP_VERSION,
        mapPath: importMapPath,
        mapSha256,
        sourcePath: row.sourcePath,
        sourceSha256: row.sha256,
        importedAt,
        importedBy,
        boardIndex: row.jobIndex + 1,
        boardLabel: job.boardLabel,
        planPromptSha256: sha256(job.prompt),
        ...(promptUnrecorded ? {} : { promptText: row.promptText, promptPath: row.promptPath }),
        ...(gap ? { provenanceGap: gap } : {}),
        referenceImages: row.referenceImages,
        note: typeof board.note === "string" ? board.note : "",
      },
    };
  });
  const manifest = {
    version: KOYA_LOCATION_GENERATION_MANIFEST_VERSION,
    locationId: plan.location.id,
    requiredBoardIds: plan.jobs.map((job) => job.boardId),
    entries,
    // アンカー承認は書かない。取り込んだアンカーも location-anchor-audit を
    // 独立した審査者で通すまで、本審査にも登録にも進めない。
    anchorApproval: null,
    updatedAt: importedAt,
  };
  await writeJsonAtomic(manifestPath, manifest);
  return {
    locationId: plan.location.id,
    stage: "import",
    manifestPath,
    manifestSha256: sha256(await readFile(manifestPath)),
    importMapPath,
    importMapSha256: mapSha256,
    importedAt,
    results: entries.map((entry) => ({
      boardId: entry.boardId,
      path: entry.path,
      sha256: entry.sha256,
      dimensions: entry.dimensions,
      anchorSha256: entry.anchorSha256,
      generatorContextId: nonEmpty(entry.generator.contextId),
      // 欠落を宣言したボードは、取り込みの結果でもそう見えるようにする。
      ...(koyaLocationEntryProvenanceGap(entry) ? { provenanceGap: entry.import.provenanceGap } : {}),
    })),
    written: writes.map((write) => write.path),
    superseded: { directory: moved.length > 0 ? supersededDir : "", moved },
    complete: true,
    anchorApproved: false,
    next: [
      "location-anchor-review-draft, then an original-scale anchor review in a context different from the importer and every external generator",
      "location-anchor-audit with that review",
      "location-review-draft --location-anchor-review-path <passed anchor review>, then an independent original-scale review of all four boards",
      "location-register --location-review-path <final review>",
    ],
  };
}

/**
 * 公式ルートの外（チャット型の画像ツール）で作ったボードを、生成記録つきで取り込む。
 * 有料 API は呼ばない。アンカー承認は書かないので、この後もアンカー審査・本審査・
 * 登録を公式ルートと同じ条件で通す必要がある。
 */
export async function importKoyaLocationBoards(options = {}) {
  const authority = options.authority || await readKoyaChannelAuthority({ projectDir: options.projectDir });
  if (authority.source !== "project") throw new Error("Restore the Koya project authority before importing location boards.");
  if (!nonEmpty(options.importMapPath)) throw new Error("Koya location import requires importMapPath.");
  const plan = buildKoyaLocationBoardPlan({
    projectDir: authority.projectDir,
    locationBible: authority.locationBible,
    showBible: authority.showBible,
    locationId: options.locationId,
    outputDir: options.outputDir,
  });
  const canvasDir = resolveCanvasDir({ projectDir: authority.projectDir });
  if (plan.jobs.some((job) => !inside(canvasDir, resolve(job.outputPath)))) {
    throw new Error("Location boards must be imported inside canvas/ for portable review and handoff.");
  }
  const manifestPath = locationGenerationManifestPath(plan);
  return withCanvasFileLock(
    manifestPath,
    () => importKoyaLocationBoardsUnlocked({ authority, plan, importMapPath: resolve(options.importMapPath), canvasDir }),
    { timeoutMs: 30 * 60_000, staleMs: 2 * 60 * 60_000 },
  );
}

function inside(root, path) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export async function auditKoyaLocationReview(options = {}) {
  const plan = buildKoyaLocationBoardPlan(options);
  const review = options.review && typeof options.review === "object" ? options.review : null;
  const failures = [];
  if (!review) return { version: KOYA_LOCATION_REVIEW_VERSION, pass: false, locationId: plan.location.id, failures: ["Location review is required."], rows: [] };
  storyReviewFailure(failures, review.version === KOYA_LOCATION_REVIEW_VERSION, `Location review version must be ${KOYA_LOCATION_REVIEW_VERSION}.`);
  storyReviewFailure(failures, review.locationId === plan.location.id, "Location review ID does not match the requested location.");
  storyReviewFailure(failures, nonEmpty(review?.reviewer?.host) && nonEmpty(review?.reviewer?.id) && nonEmpty(review?.reviewer?.contextId), "Independent reviewer host, id, and contextId are required.");
  storyReviewFailure(failures, validIsoDate(review?.reviewedAt), "Location review requires a valid ISO-8601 reviewedAt.");
  storyReviewFailure(failures, review?.checks?.crossViewArchitectureContinuity === true, "Cross-view architecture continuity must pass.");
  storyReviewFailure(failures, review?.checks?.originalScaleReview === true, "Original-scale review must pass.");
  const manifestPath = resolve(nonEmpty(review?.generationManifest?.path));
  let generationManifest = null;
  let generationManifestSha256 = "";
  if (!nonEmpty(review?.generationManifest?.path)) failures.push("Location review requires the official generation manifest path.");
  else {
    try {
      const manifestBuffer = await readFile(manifestPath);
      generationManifestSha256 = sha256(manifestBuffer);
      generationManifest = JSON.parse(manifestBuffer.toString("utf8"));
      if (!inside(resolve(options.projectDir || process.cwd()), manifestPath)) failures.push("Location generation manifest must stay inside the project.");
      // 承認の再検証（アンカー審査）は、審査された manifest の場所を正とする。
      // その場所が canvas/ の外だと、引き渡しに乗らない証跡の上で登録できてしまう。
      if (!inside(resolveCanvasDir({ projectDir: resolve(options.projectDir || process.cwd()) }), manifestPath)) {
        failures.push("Location generation manifest must stay inside canvas/ for portable review and handoff.");
      }
      if (generationManifestSha256 !== nonEmpty(review?.generationManifest?.sha256)) failures.push("Location generation manifest SHA-256 does not match the reviewed bytes.");
      if (generationManifest.version !== KOYA_LOCATION_GENERATION_MANIFEST_VERSION || generationManifest.locationId !== plan.location.id) failures.push("Location generation manifest version or locationId is invalid.");
    } catch (error) { failures.push(`Location generation manifest is missing or invalid: ${error.message}`); }
  }
  const generationByBoardId = new Map((Array.isArray(generationManifest?.entries) ? generationManifest.entries : []).map((entry) => [entry.boardId, entry]));
  const expectedBoardIds = plan.jobs.map((job) => job.boardId);
  if (JSON.stringify(generationManifest?.requiredBoardIds || []) !== JSON.stringify(expectedBoardIds)
    || !Array.isArray(generationManifest?.entries)
    || generationManifest.entries.length !== expectedBoardIds.length
    || generationByBoardId.size !== expectedBoardIds.length
    || JSON.stringify(generationManifest.entries.map((entry) => entry?.boardId)) !== JSON.stringify(expectedBoardIds)) {
    failures.push("Location generation manifest must cover the four required boards exactly once and in the planned order.");
  }
  // 公式生成では継続ビューの生成時にアンカー承認を manifest へ書く。
  // 取り込んだ継続ビューはアンカー審査より前に作られているので、manifest には
  // 承認が無い。その場合に限り、本審査の review 自身が審査済みアンカー review を
  // {path, sha256} で拘束する。取り込みはアンカー承認を書かないので、
  // アンカー審査を通らないまま登録へ進む道は無い。
  const manifestAnchorApproval = generationManifest?.anchorApproval ?? null;
  const continuityEntries = plan.jobs.slice(1).map((job) => generationByBoardId.get(job.boardId));
  const continuityImported = continuityEntries.length > 0 && continuityEntries.every(isImportedLocationEntry);
  const reviewAnchorApproval = review.anchorApproval ?? null;
  let anchorApproval = manifestAnchorApproval;
  let anchorApprovalSource = "manifest";
  let anchorReview = null;
  if (reviewAnchorApproval !== null) {
    const shapeValid = typeof reviewAnchorApproval === "object" && !Array.isArray(reviewAnchorApproval)
      && JSON.stringify(Object.keys(reviewAnchorApproval).sort()) === JSON.stringify(["path", "sha256"]);
    if (!shapeValid) {
      failures.push("Location review anchorApproval must contain exactly path and sha256.");
    } else if (manifestAnchorApproval) {
      if (resolve(nonEmpty(reviewAnchorApproval.path)) !== resolve(nonEmpty(manifestAnchorApproval.path))
        || reviewAnchorApproval.sha256 !== manifestAnchorApproval.sha256) {
        failures.push("Location review anchorApproval differs from the anchor approval recorded in the generation manifest.");
      }
    } else if (!continuityImported) {
      failures.push("Location review anchorApproval is accepted only for imported continuity boards; official continuity generation records the anchor approval in the generation manifest.");
    } else {
      anchorApproval = reviewAnchorApproval;
      anchorApprovalSource = "review";
    }
  }
  if (!nonEmpty(anchorApproval?.path) || !/^[a-f0-9]{64}$/u.test(nonEmpty(anchorApproval?.sha256))) {
    failures.push(continuityImported && !manifestAnchorApproval
      ? "Imported location boards require review.anchorApproval {path, sha256} binding the passed, SHA-bound anchor review."
      : "Location generation manifest requires the SHA-bound anchor approval used before continuity generation.");
  } else {
    const anchorReviewPath = resolve(anchorApproval.path);
    try {
      const anchorReviewBytes = await readFile(anchorReviewPath);
      if (sha256(anchorReviewBytes) !== anchorApproval.sha256) failures.push("Location anchor approval SHA-256 no longer matches disk.");
      anchorReview = JSON.parse(anchorReviewBytes.toString("utf8"));
      const anchorAudit = await auditKoyaLocationAnchorReview({
        projectDir: options.projectDir,
        locationBible: options.locationBible,
        // 画風宣言は show bible にあり、ボード計画の組み立てに必須になった。
        // ここで渡し忘れると、アンカー承認の再検証が「正本が無い」で落ちて、
        // 実際には有効な承認まで無効に見える。
        showBible: options.showBible,
        locationId: plan.location.id,
        // 審査済みの manifest がある場所を正にする。登録は --output-dir を
        // 受け取らないので、計画の既定の場所で読むと別の場所で作った
        // ボードのアンカー承認を必ず無効と判定してしまう。
        outputDir: nonEmpty(options.outputDir) ? options.outputDir : dirname(manifestPath),
        review: anchorReview,
      });
      if (!anchorAudit.pass) failures.push(`Location anchor approval is no longer valid: ${anchorAudit.failures.join("; ")}`);
      if (anchorApprovalSource === "manifest") {
        if (anchorApproval.anchorSha256 !== generationByBoardId.get(plan.jobs[0].boardId)?.sha256) failures.push("Location anchor approval does not bind the current anchor SHA-256.");
        if (anchorApproval.reviewedAt !== anchorReview.reviewedAt || JSON.stringify(anchorApproval.reviewer || {}) !== JSON.stringify(anchorReview.reviewer || {})) failures.push("Location anchor approval provenance does not match its review file.");
      } else {
        if (nonEmpty(anchorReview?.anchor?.sha256) !== nonEmpty(generationByBoardId.get(plan.jobs[0].boardId)?.sha256)) failures.push("Location anchor approval does not bind the current anchor SHA-256.");
        if (!inside(resolveCanvasDir({ projectDir: resolve(options.projectDir || process.cwd()) }), anchorReviewPath)) {
          failures.push("Location anchor review must be stored inside canvas/ for portable handoff.");
        }
      }
    } catch (error) { failures.push(`Location anchor approval is missing or invalid: ${error.message}`); }
  }
  const location = locationBibleEntry(options.locationBible, plan.location.id);
  const reviewerContextId = nonEmpty(review?.reviewer?.contextId);
  if (!Array.isArray(review.boards) || review.boards.length !== expectedBoardIds.length) failures.push("Location review must cover the four required boards exactly once.");
  const reviewedById = new Map((Array.isArray(review.boards) ? review.boards : []).map((entry) => [entry.boardId, entry]));
  if (reviewedById.size !== expectedBoardIds.length) failures.push("Location review contains duplicate or unknown board IDs.");
  const minimumWidth = Number(options.locationBible.reviewContract.minimumWidth || 1280);
  const minimumHeight = Number(options.locationBible.reviewContract.minimumHeight || 720);
  const rows = [];
  for (const job of plan.jobs) {
    const reviewed = reviewedById.get(job.boardId);
    if (!reviewed) { failures.push(`Missing review for ${job.boardId}.`); continue; }
    const assetPath = resolve(nonEmpty(reviewed.path));
    if (!inside(resolve(options.projectDir || process.cwd()), assetPath)) failures.push(`${job.boardId} asset must stay inside the recipient project.`);
    let buffer = null;
    try { buffer = await readFile(assetPath); } catch { failures.push(`${job.boardId} asset is missing: ${assetPath}`); }
    const actualSha256 = buffer ? sha256(buffer) : "";
    const dimensions = buffer ? getImageDimensionsFromBuffer(buffer) : null;
    if (!/^[a-f0-9]{64}$/u.test(nonEmpty(reviewed.sha256)) || reviewed.sha256 !== actualSha256) failures.push(`${job.boardId} SHA-256 does not match disk.`);
    if (!dimensions || dimensions.width < minimumWidth || dimensions.height < minimumHeight) failures.push(`${job.boardId} must be reviewed at ${minimumWidth}x${minimumHeight} or larger.`);
    const generated = generationByBoardId.get(job.boardId);
    if (!generated || resolve(nonEmpty(generated.path)) !== assetPath || generated.sha256 !== actualSha256) failures.push(`${job.boardId} is not bound to the official generation manifest.`);
    const isAnchor = job.boardId === plan.jobs[0].boardId;
    const expectedAnchorSha = isAnchor ? "" : generationByBoardId.get(plan.jobs[0].boardId)?.sha256;
    const imported = isImportedLocationEntry(generated);
    const gap = koyaLocationEntryProvenanceGap(generated);
    if (imported) {
      failures.push(...importedLocationEntryFailures({ entry: generated, job, isAnchor, expectedAnchorSha256: expectedAnchorSha, label: job.boardId }));
    } else if (generated?.promptSha256 !== sha256(job.prompt)) {
      failures.push(`${job.boardId} generation prompt does not match the current location bible.`);
    }
    // 参照の記録が無いと宣言したボードは、アンカーへの SHA 拘束を持たない
    // （持っていたら作り話になる）。一致は建築の確認項目を目で見て付ける。
    const expectedAnchorBinding = locationEntryReferencesUnrecorded(generated) || locationEntryDerivedOnly(generated)
      ? ""
      : nonEmpty(expectedAnchorSha);
    if (nonEmpty(generated?.anchorSha256) !== expectedAnchorBinding) failures.push(`${job.boardId} is not bound to the current anchor SHA-256.`);
    // 会話まで残っていないと宣言したボードにだけ会話 id が無い。残りは要る。
    if (!nonEmpty(generated?.generator?.host) || !nonEmpty(generated?.generator?.id)
      || (!koyaLocationGapDeclares(gap, "generatorContextRecorded") && !nonEmpty(generated?.generator?.contextId))) failures.push(`${job.boardId} generation provenance is incomplete.`);
    const generatorContextId = nonEmpty(generated?.generator?.contextId);
    if (generatorContextId && generatorContextId === reviewerContextId) failures.push(`${job.boardId} must be reviewed in a context different from its generator.`);
    if (imported && nonEmpty(generated?.import?.importedBy?.contextId) === reviewerContextId) {
      failures.push(`${job.boardId} must be reviewed in a context different from its importer.`);
    }
    // 参照の記録が無いボードでは、アンカーとの建築の一致を示す記録がどこにも
    // 無い。既存のボード単位の確認項目（architectureLockPass）が、審査者が
    // 目で見たという唯一の証跡になるので、そのボードでも必ず true を要る。
    const referencesUnrecorded = locationEntryReferencesUnrecorded(generated);
    const derivedOnly = locationEntryDerivedOnly(generated);
    for (const key of koyaLocationBoardReviewCheckKeys(location, generated)) {
      if (reviewed?.checks?.[key] === true) continue;
      failures.push(referencesUnrecorded && key === KOYA_LOCATION_BOARD_CONTINUITY_CHECK
        ? `${job.boardId} check '${key}' must be true: its reference images were never recorded, so nothing but this by-eye check shows its architecture continuity with the anchor.`
        : derivedOnly && key === KOYA_LOCATION_BOARD_CONTINUITY_CHECK
          ? `${job.boardId} check '${key}' must be true: it was edited from previously approved images, not drawn from the anchor, so nothing but this by-eye check shows its architecture continuity with the anchor.`
          : `${job.boardId} check '${key}' must be true.`);
    }
    const misplacement = locationGapCheckMisplacementFailure(reviewed?.checks, gap, job.boardId);
    if (misplacement) failures.push(misplacement);
    rows.push({ boardId: job.boardId, path: assetPath, sha256: actualSha256, dimensions });
  }
  if (rows.length > 0 && new Set(rows.map((row) => row.sha256)).size !== rows.length) {
    failures.push("All four location views must be distinct image files; duplicate SHA-256 values are not allowed.");
  }
  return {
    version: KOYA_LOCATION_REVIEW_VERSION,
    pass: failures.length === 0,
    locationId: plan.location.id,
    review,
    generationManifestPath: manifestPath,
    generationManifestSha256,
    // 引き渡し束の移送用 attestation は、ここで検証した証跡だけから作る。
    generationEntries: Array.isArray(generationManifest?.entries) ? generationManifest.entries : [],
    anchorApproval: anchorReview ? {
      source: anchorApprovalSource,
      path: resolve(anchorApproval.path),
      sha256: anchorApproval.sha256,
      reviewer: anchorReview.reviewer || null,
      reviewedAt: nonEmpty(anchorReview.reviewedAt),
    } : null,
    textPolicy: koyaLocationTextPolicy(location),
    rows,
    failures,
  };
}

export async function createKoyaLocationReviewDraft(options = {}) {
  const plan = buildKoyaLocationBoardPlan(options);
  const manifestPath = locationGenerationManifestPath(plan);
  let manifestSha256 = "";
  let manifest = null;
  try {
    const manifestBytes = await readFile(manifestPath);
    manifestSha256 = sha256(manifestBytes);
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {}
  const location = locationBibleEntry(options.locationBible, plan.location.id);
  const entryById = new Map((Array.isArray(manifest?.entries) ? manifest.entries : []).map((entry) => [entry?.boardId, entry]));
  const boards = [];
  const gapBoards = [];
  const referenceGapBoards = [];
  const derivedBoards = [];
  for (const job of plan.jobs) {
    let buffer = null;
    try { buffer = await readFile(job.outputPath); } catch {}
    let dimensions = null;
    try { dimensions = buffer ? getImageDimensionsFromBuffer(buffer) : null; } catch {}
    const generated = entryById.get(job.boardId);
    const gap = koyaLocationEntryProvenanceGap(generated);
    // どの記録が無いかで文を分ける。参照だけが無いボードに「プロンプトと
    // 会話が無い」と書いたら、指示そのものが事実と違うことになる。
    if (koyaLocationGapDeclares(gap, "promptRecorded") || koyaLocationGapDeclares(gap, "generatorContextRecorded")) {
      gapBoards.push({ boardId: job.boardId, specificationPath: nonEmpty(gap.specificationPath) });
    }
    if (koyaLocationGapDeclares(gap, "referenceImagesRecorded")) {
      referenceGapBoards.push({ boardId: job.boardId, specificationPath: nonEmpty(gap.specificationPath) });
    }
    if (locationEntryDerivedOnly(generated)) derivedBoards.push(job.boardId);
    boards.push({
      boardId: job.boardId,
      path: job.outputPath,
      sha256: buffer ? sha256(buffer) : "",
      dimensions,
      checks: Object.fromEntries(koyaLocationBoardReviewCheckKeys(location, generated).map((key) => [key, false])),
    });
  }
  // 取り込んだ継続ビューだけは、manifest に無いアンカー承認を本審査の側で拘束する。
  // 公式生成の下書きは従来どおりで、このキーを持たない。
  const needsAnchorApproval = Boolean(manifest) && !manifest.anchorApproval
    && plan.jobs.slice(1).every((job) => isImportedLocationEntry(entryById.get(job.boardId)));
  let anchorApproval = null;
  if (needsAnchorApproval) {
    const anchorReviewPath = nonEmpty(options.anchorReviewPath) ? resolve(options.anchorReviewPath) : "";
    let anchorReviewSha256 = "";
    if (anchorReviewPath) {
      try { anchorReviewSha256 = sha256(await readFile(anchorReviewPath)); }
      catch (error) { throw new Error(`Location anchor review cannot be read for the review draft: ${error.message}`); }
    }
    anchorApproval = { path: anchorReviewPath, sha256: anchorReviewSha256 };
  }
  const instructions = [
    "SHA and dimensions are read from the current planned files. A different reviewer must inspect every image at original scale and change only observed checks to true.",
    ...(needsAnchorApproval ? [`These boards were imported from an external image tool. anchorApproval must bind the anchor review that already passed location-anchor-audit${anchorApproval.path ? "" : " (pass --location-anchor-review-path)"}, and the reviewer context must differ from the importer and from every external generator context.`] : []),
    ...(gapBoards.length > 0 ? [`These boards declare a provenance gap (their prompt and generator conversation were never recorded): ${gapBoards.map((board) => `${board.boardId} against ${board.specificationPath}`).join("; ")}. Read each gap reason and its written specification in the generation manifest, then set ${KOYA_LOCATION_PROVENANCE_GAP_CHECK} to true only for a board that satisfies its specification.`] : []),
    ...(referenceGapBoards.length > 0 ? [`These boards declare that their reference images were never recorded: ${referenceGapBoards.map((board) => `${board.boardId} against ${board.specificationPath}`).join("; ")}. Read each gap reason and its written specification in the generation manifest and set ${KOYA_LOCATION_PROVENANCE_GAP_CHECK} to true only for a board that satisfies it. The architecture continuity of such a board with the anchor cannot be shown by a recorded reference and has to be judged by eye: open it beside the anchor at original scale and set '${KOYA_LOCATION_BOARD_CONTINUITY_CHECK}' to true only when the architecture you see actually matches.`] : []),
    ...(derivedBoards.length > 0 ? [`These boards were edited from previously approved images of this location (their role "derived" references in the generation manifest), not drawn from the anchor: ${derivedBoards.join(", ")}. Their architecture continuity with the anchor has to be judged by eye: open each beside the anchor at original scale and set '${KOYA_LOCATION_BOARD_CONTINUITY_CHECK}' to true only when the architecture you see actually matches.`] : []),
    ...(locationAllowsFictionalSignage(location) ? ["This location allows minimal fictional signage: set readableTextFictionalOnly only when every readable sign is an invented name and no real name or brand appears."] : []),
  ].join(" ");
  return {
    version: KOYA_LOCATION_REVIEW_VERSION,
    locationId: plan.location.id,
    reviewer: { host: "", id: "", contextId: "" },
    reviewedAt: "",
    generationManifest: { path: manifestPath, sha256: manifestSha256 },
    ...(anchorApproval ? { anchorApproval } : {}),
    checks: { crossViewArchitectureContinuity: false, originalScaleReview: false },
    boards,
    instructions,
  };
}

/**
 * 途中の成果物の品質ループ（lib/koyaAssetQualityGate.mjs）を見るときの制作契約。解決済みの契約を
 * 渡されればそれ、無ければランタイムの制作契約（今の版）で決める。渡し忘れでゲートが外れる道を残さない。
 */
async function koyaProductionContractForAssetQuality(options = {}, projectDir) {
  const given = options.productionContract;
  if (given) return given.contract || given;
  return (await resolveKoyaMangaProductionContract({ projectDir, contractPath: options.contractPath })).contract;
}

/** 場所のボードの品質ループの対象 id（場所 id と board id）。 */
export function koyaLocationAssetQualitySubjectId(locationId, boardId) {
  return koyaAssetQualitySubjectId(locationId, boardId);
}

/**
 * サムネの専用画の品質ループの対象 id。plan.artworkQualitySubjectIds[index] があればそれ（版ごとに
 * ファイル名が変わっても同じループを続けるため）、無ければ画のファイル名（拡張子を除く）から作る。
 */
export function koyaThumbnailAssetQualitySubjectId(plan, index, artworkPath) {
  const explicit = Array.isArray(plan?.artworkQualitySubjectIds) ? nonEmpty(plan.artworkQualitySubjectIds[index]) : "";
  if (explicit) return koyaAssetQualitySubjectId(explicit);
  return koyaAssetQualitySubjectId("thumbnail", basename(String(artworkPath || "")).replace(/\.[^.]+$/u, ""));
}

/** 独立レビューで承認された場所の基準画（continuity の唯一の参照）。登録前のボードのループが参照にする。 */
async function approvedLocationAnchorReferences(authority) {
  const rows = [];
  for (const location of authority?.locationBible?.locations || []) {
    try {
      const plan = buildKoyaLocationBoardPlan({
        projectDir: authority.projectDir,
        locationBible: authority.locationBible,
        showBible: authority.showBible,
        locationId: location.id,
      });
      const manifest = await readJsonStrict(locationGenerationManifestPath(plan));
      const approval = manifest?.anchorApproval;
      if (!nonEmpty(approval?.path) || !/^[a-f0-9]{64}$/u.test(nonEmpty(approval?.sha256)) || !/^[a-f0-9]{64}$/u.test(nonEmpty(approval?.anchorSha256))) continue;
      // 承認の記録（anchor review）が今も同じバイト列のときだけ載せる。
      if (sha256(await readFile(resolve(approval.path))) !== approval.sha256) continue;
      rows.push({ sha256: approval.anchorSha256, kind: "location:approved-anchor", id: `${location.id}.anchor` });
    } catch {
      // 基準画の承認が無い場所は載せない。
    }
  }
  return rows;
}

/**
 * 品質ループが参照の照合に使う承認一覧（buzzassist-approved-references-v1）を
 * <canvas>/quality/approved-references.json へ書き出す。登録簿の承認済みの人物・場所の参照画、
 * 匿名の候補から人が選んだ顔、承認済みの場所の基準画の SHA だけを載せる（ファイル名は使わない）。
 */
export async function refreshKoyaApprovedReferences(options = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  let authority = options.authority || null;
  if (!authority) {
    try {
      authority = await readKoyaChannelAuthority({ projectDir });
    } catch {
      authority = null;
    }
  }
  const anchors = authority ? await approvedLocationAnchorReferences(authority) : [];
  return writeKoyaApprovedReferences({ projectDir, canvasDir: options.canvasDir, extraReferences: anchors });
}

export async function registerApprovedKoyaLocation(options = {}) {
  const authority = options.authority || await readKoyaChannelAuthority({ projectDir: options.projectDir });
  if (authority.source !== "project") throw new Error("Restore the Koya project authority before registering a location.");
  if (!nonEmpty(options.reviewPath)) throw new Error("Koya location reviewPath is required so the exact reviewed evidence can be SHA-bound and transferred.");
  const review = options.review || await readJsonStrict(resolve(options.reviewPath));
  const audit = await auditKoyaLocationReview({
    projectDir: authority.projectDir,
    locationBible: authority.locationBible,
    showBible: authority.showBible,
    locationId: options.locationId,
    review,
  });
  if (!audit.pass) throw new Error(`Koya location review failed: ${audit.failures.join("; ")}`);
  const location = authority.locationBible.locations.find((entry) => entry.id === options.locationId);
  const registry = await readCharacterRegistry({ projectDir: authority.projectDir });
  const existing = registry.characters.find((entry) => entry.id === location.id);
  if (existing?.status === "approved") throw new Error(`Approved location already exists: ${location.id}`);
  const canvasDir = resolveCanvasDir({ projectDir: authority.projectDir });
  const reviewPath = resolve(options.reviewPath);
  if (!inside(canvasDir, reviewPath) || audit.rows.some((row) => !inside(canvasDir, row.path))) {
    throw new Error("Location review and all approved boards must be stored inside canvas/ for portable handoff.");
  }
  // 契約 v54 から: 4枚のボードは、それぞれ場所（location）工程の品質ループの合格（別文脈の評価者の採点・
  // 合格した版と同じバイト列）が無いと登録しない。レビューの合格だけでは使わない。
  const productionContract = await koyaProductionContractForAssetQuality(options, authority.projectDir);
  const assetQualityGate = koyaAssetQualityGateInForce(productionContract);
  let assetQualityApproval = null;
  if (assetQualityGate) {
    const rows = [];
    for (const row of audit.rows) {
      const subjectId = koyaLocationAssetQualitySubjectId(location.id, row.boardId);
      const checked = await checkKoyaAssetQuality({ contract: productionContract, workDir: koyaAssetQualityWorkDir({ canvasDir }), stage: "location", subjectId, assetPath: row.path });
      rows.push(checked.pass && checked.assetSha256 && checked.assetSha256 !== row.sha256
        ? { ...checked, pass: false, reason: "asset-sha-mismatch", code: koyaAssetQualityFailureCode("location", subjectId, "asset-sha-mismatch"), detail: "レビューで拘束したボードと、品質ループで合格した版が違う" }
        : checked);
    }
    assertKoyaAssetQualityRows(rows, `Koya location ${location.id} registration`);
    assetQualityApproval = {
      version: KOYA_ASSET_QUALITY_GATE_VERSION,
      contractVersion: productionContract.version,
      rows: audit.rows.map((row) => ({ stage: "location", subjectId: koyaLocationAssetQualitySubjectId(location.id, row.boardId), assetSha256: row.sha256 })),
    };
  }
  const now = new Date().toISOString();
  const importedBoards = audit.generationEntries.some(isImportedLocationEntry);
  // 出所が欠けたまま登録したボードは、台帳の承認に残す。後の監査と
  // 引き渡しの attestation が、同じ事実をそこから読める。
  const provenanceGaps = audit.generationEntries
    .map((generationEntry) => ({ generationEntry, gap: koyaLocationEntryProvenanceGap(generationEntry) }))
    .filter(({ gap }) => gap)
    .map(({ generationEntry, gap }) => ({
      boardId: nonEmpty(generationEntry.boardId),
      reason: nonEmpty(gap.reason),
      specificationSha256: nonEmpty(gap.specificationSha256),
      // どの記録が無かったのかを旗のまま残す。ここで畳んで「欠落あり」と
      // だけ書くと、引き渡しの attestation が「会話は残っていた」と名乗った
      // ときに、台帳と突き合わせても矛盾が出なくなる。
      ...Object.fromEntries(KOYA_LOCATION_PROVENANCE_GAP_FLAGS
        .filter((flag) => koyaLocationGapDeclares(gap, flag))
        .map((flag) => [flag, false])),
    }));
  // どの記録が無かったのかを、そのまま文にする。旗を読まずに
  // 「プロンプトと会話が無い」と決め打つと、参照だけが無いボードの行で
  // 台帳に事実でない文が残る。
  const gapRecordNames = KOYA_LOCATION_PROVENANCE_GAP_FLAGS
    .filter((flag) => provenanceGaps.some((gap) => gap[flag] === false))
    .map((flag) => ({
      promptRecorded: "the prompt",
      generatorContextRecorded: "the generator conversation",
      referenceImagesRecorded: "the reference images",
    })[flag]);
  const entry = {
    id: location.id,
    name: location.name,
    kind: "location",
    role: "fixed",
    status: "approved",
    // 場面見出しの場所名は別名で登録ボードへ結ばれる（画像計画は id・name・aliases で照合する）。
    aliases: koyaLocationAliases(location),
    description: `${(location.architectureLock || []).join("、")}。${(location.materialPalette || []).join("、")}。`,
    invariants: [...(location.architectureLock || []), ...(location.materialPalette || [])],
    negativePrompt: locationAllowsFictionalSignage(location)
      ? "people, silhouettes, real names or real brands on signs, real logos, real place names, architecture drift"
      : "people, silhouettes, readable text, real logos, real place names, architecture drift",
    referenceImagePaths: audit.rows.map((row) => relative(canvasDir, row.path)),
    referenceAssets: audit.rows.map((row) => ({
      id: row.boardId,
      role: "supplemental",
      path: relative(canvasDir, row.path),
      sha256: row.sha256,
      sourceReviewPath: relative(canvasDir, reviewPath),
    })),
    approval: {
      route: KOYA_LOCATION_REVIEW_VERSION,
      approvedBy: nonEmpty(review?.reviewer?.id),
      approvedAt: nonEmpty(review.reviewedAt) || now,
      reason: importedBoards
        ? (provenanceGaps.length > 0
          ? `All four SHA-bound environment boards passed independent original-scale and continuity review. The boards were imported from an external image tool, and every record that was kept is SHA-bound. ${provenanceGaps.length === 1 ? "One of them declares" : `${provenanceGaps.length} of them declare`} a provenance gap for records that were never kept (${gapRecordNames.join(", ")}), and the independent reviewer acknowledged each gap against its written specification.`
          : "All four SHA-bound environment boards passed independent original-scale and continuity review. The boards were imported from an external image tool with SHA-bound prompt, reference and context provenance.")
        : "All four SHA-bound environment boards passed independent original-scale and continuity review.",
      ...(provenanceGaps.length > 0 ? { provenanceGaps } : {}),
      identityReviewPath: relative(canvasDir, reviewPath),
      identityReviewSha256: sha256(await readFile(reviewPath)),
      ...(assetQualityApproval ? { assetQuality: assetQualityApproval } : {}),
    },
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  registry.characters = [...registry.characters.filter((character) => character.id !== location.id), entry];
  const written = await writeCharacterRegistry({ projectDir: authority.projectDir }, registry);
  // 登録したボードは、以降の本編の画・サムネのループが参照に使える承認一覧へ載せる。
  const approvedReferences = assetQualityGate ? await refreshKoyaApprovedReferences({ projectDir: authority.projectDir, authority }) : null;
  return {
    location: written.characters.find((character) => character.id === location.id),
    registryRevision: written.revision,
    audit,
    ...(approvedReferences ? { approvedReferences } : {}),
  };
}

function validateLines(lines, expectedLines, maximumLength, label, failures) {
  if (!Array.isArray(lines) || lines.length !== expectedLines) {
    failures.push(`${label} requires exactly ${expectedLines} lines.`);
    return;
  }
  lines.forEach((line, index) => {
    if (!nonEmpty(line)) failures.push(`${label} line ${index + 1} is empty.`);
    if (normalizedJapaneseLength(line) > maximumLength) failures.push(`${label} line ${index + 1} exceeds ${maximumLength} characters.`);
  });
}

export function koyaThumbnailCopySha256(plan = {}) {
  return sha256(JSON.stringify({
    layout: nonEmpty(plan.layout),
    thirdBeatReason: nonEmpty(plan.thirdBeatReason),
    bandLines: (plan.bandLines || []).map(nonEmpty),
    speechBubbles: (plan.speechBubbles || []).map((entry) => ({ panelId: nonEmpty(entry.panelId), lines: (entry.lines || []).map(nonEmpty) })),
    telops: (plan.telops || []).map((entry) => ({ text: nonEmpty(entry.text), concreteNounReviewPassed: entry.concreteNounReviewPassed === true })),
  }));
}

async function normalizedGray32(path) {
  const result = await execFile("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-i", path,
    "-vf", "scale=32:32:force_original_aspect_ratio=decrease,pad=32:32:(ow-iw)/2:(oh-ih)/2:black,format=gray",
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
  ], { encoding: null, maxBuffer: 1024 * 1024 });
  const buffer = Buffer.from(result.stdout || []);
  if (buffer.length !== 1024) throw new Error(`Could not normalize thumbnail audit image: ${path}`);
  return buffer;
}

function normalizedPixelDistance(left, right) {
  if (!left || !right || left.length !== right.length || left.length === 0) return Infinity;
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) sum += Math.abs(left[index] - right[index]);
  return sum / (left.length * 255);
}

export async function auditKoyaThumbnailPlan(options = {}) {
  const contract = options.thumbnailContract;
  validateKoyaThumbnailContract(contract);
  const plan = options.plan && typeof options.plan === "object" ? options.plan : {};
  const projectDir = resolve(options.projectDir || process.cwd());
  const failures = [];
  const warnings = [];
  storyReviewFailure(failures, plan.version === KOYA_THUMBNAIL_PLAN_VERSION, `Thumbnail plan version must be ${KOYA_THUMBNAIL_PLAN_VERSION}.`);
  storyReviewFailure(failures, ["preflight", "final"].includes(plan.stage), "Thumbnail plan stage must be preflight or final.");
  storyReviewFailure(failures, ["twoPanel", "threePanel"].includes(plan.layout), "Thumbnail layout must be twoPanel or threePanel.");
  if (plan.layout === "threePanel") storyReviewFailure(failures, nonEmpty(plan.thirdBeatReason), "threePanel requires a concrete thirdBeatReason.");
  validateLines(plan.bandLines, contract.copy.band.lines, contract.copy.band.maxCharactersPerLine, "Band copy", failures);
  const forbidden = contract.copy.forbiddenAbstractHooks || [];
  for (const text of [...(plan.bandLines || []), ...(plan.speechBubbles || []).flatMap((entry) => entry.lines || [])]) {
    for (const hook of forbidden) if (String(text || "").includes(hook)) failures.push(`Forbidden abstract hook '${hook}' appears in thumbnail copy.`);
  }
  const panelIds = new Set();
  for (const bubble of Array.isArray(plan.speechBubbles) ? plan.speechBubbles : []) {
    if (!nonEmpty(bubble.panelId)) failures.push("Every speech bubble requires panelId.");
    // Client wording (制作資料 5章) limits each bubble to 2 lines; it does not limit bubbles per panel.
    // Bubble count per panel is an open client decision (帯仕様書v1), so this is a warning, not a failure.
    if (panelIds.has(bubble.panelId)) warnings.push(`Panel ${bubble.panelId} has more than one speech bubble; bubble count per panel is pending client decision.`);
    panelIds.add(bubble.panelId);
    if (!Array.isArray(bubble.lines) || bubble.lines.length < 1 || bubble.lines.length > contract.copy.speechBubble.lines) {
      failures.push(`Speech bubble ${bubble.panelId || "(unknown)"} requires one or two lines.`);
    } else {
      for (const [index, line] of bubble.lines.entries()) if (normalizedJapaneseLength(line) > contract.copy.speechBubble.maxCharactersPerLine) failures.push(`Speech bubble ${bubble.panelId} line ${index + 1} exceeds ${contract.copy.speechBubble.maxCharactersPerLine} characters.`);
    }
  }
  for (const telop of Array.isArray(plan.telops) ? plan.telops : []) {
    const length = normalizedJapaneseLength(telop.text);
    if (length < contract.copy.telop.minCharacters || length > contract.copy.telop.maxCharacters) failures.push(`Telop '${telop.text || ""}' must be ${contract.copy.telop.minCharacters}-${contract.copy.telop.maxCharacters} characters.`);
    if (telop.concreteNounReviewPassed !== true) failures.push(`Telop '${telop.text || ""}' requires concrete-noun human review.`);
  }
  storyReviewFailure(failures, plan.exactTextApproved === true, "Exact thumbnail text requires human approval.");
  const copySha256 = koyaThumbnailCopySha256(plan);
  storyReviewFailure(failures, nonEmpty(plan?.textApproval?.approvedBy) && validIsoDate(plan?.textApproval?.approvedAt), "Thumbnail text approval requires approvedBy and a valid ISO-8601 approvedAt.");
  storyReviewFailure(failures, plan?.textApproval?.copySha256 === copySha256, "Thumbnail text approval is stale or does not match the exact copy.");
  const pendingTokens = [contract.visual.bandColorToken, contract.visual.bandFontToken].filter((value) => /^PENDING_/u.test(nonEmpty(value)));
  if (pendingTokens.length > 0) failures.push(`Thumbnail brand tokens are pending: ${pendingTokens.join(", ")}.`);
  const artRows = [];
  const videoRows = [];
  const assetQuality = [];
  if (plan.stage === "final") {
    const expectedArtCount = plan.layout === "threePanel" ? 3 : 2;
    storyReviewFailure(failures, Array.isArray(plan.artworkPaths) && plan.artworkPaths.length === expectedArtCount, `${plan.layout} final audit requires ${expectedArtCount} dedicated artwork files.`);
    storyReviewFailure(failures, Array.isArray(plan.mainVideoFramePaths) && plan.mainVideoFramePaths.length > 0, "Final thumbnail audit requires mainVideoFramePaths to prove non-reuse.");
    const normalizedByPath = new Map();
    for (const [collection, rows, label] of [[plan.artworkPaths, artRows, "artwork"], [plan.mainVideoFramePaths, videoRows, "video frame/source image"]]) {
      for (const value of Array.isArray(collection) ? collection : []) {
        const path = resolve(value);
        if (!inside(projectDir, path)) failures.push(`Thumbnail ${label} must stay inside the project: ${path}`);
        try {
          const buffer = await readFile(path);
          const normalized = await normalizedGray32(path);
          normalizedByPath.set(path, normalized);
          rows.push({ path, sha256: sha256(buffer), normalizedGray32Sha256: sha256(normalized), dimensions: getImageDimensionsFromBuffer(buffer) });
        } catch { failures.push(`Thumbnail ${label} is missing: ${path}`); }
      }
    }
    const frameDigests = new Set(videoRows.map((row) => row.sha256));
    for (const row of artRows) if (frameDigests.has(row.sha256)) failures.push(`Dedicated thumbnail artwork reuses a main-video frame: ${row.path}`);
    for (const artwork of artRows) {
      for (const frame of videoRows) {
        const distance = normalizedPixelDistance(normalizedByPath.get(artwork.path), normalizedByPath.get(frame.path));
        const reuseDistance = Number(contract?.sourcePolicy?.normalizedGray32MaximumReuseDistance ?? 0.025);
        if (distance < reuseDistance) failures.push(`Dedicated thumbnail artwork is perceptually the same as a main-video frame/source image (distance=${distance.toFixed(4)}): ${artwork.path}`);
      }
    }
    const requiredFinalChecks = ["original1280x720", "mobile320x180", "textCropZero", "faceCropZero", "primaryEmotionReadable", "approvedCharacterReferencesOnly", "realLogoZero"];
    if (requiredFinalChecks.some((key) => plan?.checks?.[key] !== true)) {
      failures.push(`Final thumbnail audit requires all checks: ${requiredFinalChecks.join(", ")}.`);
    }
    // 契約 v54 から: 専用画は1枚ずつ、サムネ（thumbnail）工程の品質ループの合格（別文脈の評価者の採点・
    // 手指の安全などの人の確認・合格した版と同じバイト列）が無いと公開に使わない。
    // 上の自己申告の checks は残すが、それだけでは合格にしない。
    const productionContract = await koyaProductionContractForAssetQuality(options, projectDir);
    if (koyaAssetQualityGateInForce(productionContract)) {
      const workDir = koyaAssetQualityWorkDir({ projectDir });
      for (const [index, value] of (Array.isArray(plan.artworkPaths) ? plan.artworkPaths : []).entries()) {
        assetQuality.push(await checkKoyaAssetQuality({
          contract: productionContract,
          workDir,
          stage: "thumbnail",
          subjectId: koyaThumbnailAssetQualitySubjectId(plan, index, value),
          assetPath: resolve(String(value || "")),
        }));
      }
      failures.push(...koyaAssetQualityFailureLines(assetQuality));
    }
  } else if (Array.isArray(plan.artworkPaths) && plan.artworkPaths.length > 0) {
    warnings.push("Preflight ignores artwork files; use stage=final after dedicated artwork is generated.");
  }
  return {
    version: "koya-thumbnail-audit-v1",
    pass: failures.length === 0,
    readyForGeneration: failures.length === 0 && plan.stage === "preflight",
    readyForPublish: failures.length === 0 && plan.stage === "final",
    contractStatus: contract.status,
    copySha256,
    pendingTokens,
    artwork: artRows,
    videoFrames: videoRows,
    assetQuality: assetQuality.map(({ stage, subjectId, assetPath, pass, reason, code }) => ({ stage, subjectId, assetPath, pass, reason, code })),
    failures,
    warnings,
  };
}

export function createKoyaThumbnailPlanDraft(options = {}) {
  const contract = options.thumbnailContract;
  validateKoyaThumbnailContract(contract);
  const layout = options.layout === "threePanel" ? "threePanel" : "twoPanel";
  return {
    version: KOYA_THUMBNAIL_PLAN_VERSION,
    stage: "preflight",
    layout,
    ...(layout === "threePanel" ? { thirdBeatReason: "" } : {}),
    bandLines: ["", ""],
    speechBubbles: [],
    telops: [],
    exactTextApproved: false,
    textApproval: { approvedBy: "", approvedAt: "", copySha256: "" },
    artworkPaths: [],
    mainVideoFramePaths: [],
    checks: {
      original1280x720: false,
      mobile320x180: false,
      textCropZero: false,
      faceCropZero: false,
      primaryEmotionReadable: false,
      approvedCharacterReferencesOnly: false,
      realLogoZero: false,
    },
    contractStatus: contract.status,
    brandTokens: { bandColorToken: contract.visual.bandColorToken, bandFontToken: contract.visual.bandFontToken },
    instructions: "Approve exact copy and record koyaThumbnailCopySha256(plan) only after band/font tokens are human-approved. Change stage to final and add dedicated artwork plus main-video source images for reuse audit.",
  };
}
