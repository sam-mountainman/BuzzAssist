import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { resolveCanvasDir, writeJsonAtomic } from "./canvasScene.mjs";
import { withCanvasFileLock } from "./canvasFileLock.mjs";
import {
  findCharacter,
  readCharacterRegistry,
  writeCharacterRegistry,
} from "./characterRegistry.mjs";
import {
  buildChannelVisualStylePrompt,
  inferChannelVisualTags,
  normalizeChannelVisualProfileSnapshot,
  resolveChannelVisualProfileSnapshot,
  selectChannelVisualReferences,
} from "./channelVisualProfile.mjs";
import { publicBlindCandidateSummary, writeBlindCandidatePackage, writePreservedBlindCandidatePackage } from "./mangaBlindCandidateStore.mjs";
import {
  characterAssetSha256,
  prepareCandidateDiversityReviewDraft,
  prepareIdentityPackReviewDraft,
  validateCandidateDiversityReview,
  validateIdentityPackReview,
} from "./characterIdentityReview.mjs";

export { validateCandidateDiversityReview } from "./characterIdentityReview.mjs";

export const CHARACTER_WORKFLOW_FILE_NAME = "character-workflows.json";
export const DEFAULT_CHARACTER_CANDIDATE_COUNT = 3;
const CHARACTER_WORKFLOW_VERSION = 1;
const MAX_WORKFLOWS = 100;
const MAX_CAST_PER_WORKFLOW = 80;
const MAX_CANDIDATES_PER_CAST = 10;
const MAX_SCRIPT_LENGTH = 500_000;
const MAX_DESCRIPTION_LENGTH = 4_000;
const MAX_SCENES = 500;
const MAX_STYLING_VARIATION_ROUNDS = 20;
const MAX_STYLING_VARIATION_OPTIONS = 12;
export const CHARACTER_STYLING_REVIEW_VERSION = "koya-character-styling-review-v2";
export const CHARACTER_CANDIDATE_IMPORT_VERSION = "koya-character-candidate-import-v1";
export const CHARACTER_CANDIDATE_SOURCE_MANIFEST_VERSION = "koya-character-candidate-source-manifest-v1";
export const CHARACTER_CANDIDATE_REBUILD_SPEC_VERSION = "koya-character-candidate-rebuild-spec-v1";
const VALID_WORKFLOW_STATUSES = new Set([
  "draft",
  "awaiting-candidates",
  "awaiting-approval",
  "building-identity-pack",
  "awaiting-identity-qa",
  "ready",
  "archived",
]);
const VALID_CAST_STATUSES = new Set([
  "existing",
  "needs-candidates",
  "generating-candidates",
  "awaiting-approval",
  "building-identity-pack",
  "awaiting-identity-qa",
  "ready",
  "failed",
]);
const NON_VISUAL_SPEAKERS = new Set([
  "タイトル",
  "題名",
  "サブタイトル",
  "ナレーション",
  "ナレーター",
  "モノローグ",
  "地の文",
  "テロップ",
  "字幕",
  "SE",
  "SFX",
  "BGM",
  "効果音",
  "場面",
  "シーン",
  "カット",
]);
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REFERENCE_PROMPTS_FILE = resolve(MODULE_DIR, "../skills/excalidraw-image-gen/reference-sheet-prompts.md");
const STYLING_COLOR_MEASUREMENT_SCRIPT = resolve(MODULE_DIR, "../scripts/measure-koya-styling-color.py");
const STYLING_COLOR_REGION_NORMALIZED = Object.freeze([0.29, 0.16, 0.18, 0.22]);
const MIN_STYLING_COLOR_DELTA_E76 = 12;
const execFile = promisify(execFileCallback);
const CHARACTER_SETUP_MARKER = "[Character appearance description]";

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function clampInteger(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringList(value, limit = 30) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map((item) => nonEmptyString(item))
      .filter(Boolean),
  )].slice(0, limit);
}

function normalizeOutfitStages(value) {
  return (Array.isArray(value) ? value : []).map((entry, index) => {
    const source = entry && typeof entry === "object" ? entry : {};
    const id = nonEmptyString(source.id ?? source.storyStage ?? source.story_stage) || `stage-${index + 1}`;
    return {
      id,
      label: nonEmptyString(source.label ?? source.name) || id,
      description: nonEmptyString(source.description),
      invariants: stringList(source.invariants, 20),
    };
  }).filter((entry) => entry.description || entry.invariants.length > 0).slice(0, 12);
}

function normalizeGeneratedAsset(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    elementId: nonEmptyString(source.elementId),
    assetFile: nonEmptyString(source.assetFile),
    assetUrl: nonEmptyString(source.assetUrl),
    sha256: nonEmptyString(source.sha256),
    storyStage: nonEmptyString(source.storyStage),
  };
}

function normalizeStylingVariationOption(value, index) {
  const source = value && typeof value === "object" ? value : {};
  const id = nonEmptyString(source.id) || `option-${index + 1}`;
  return {
    id,
    label: nonEmptyString(source.label) || id,
    description: nonEmptyString(source.description),
    invariants: stringList(source.invariants, 30),
    status: ["pending", "generating", "generated", "passed", "rejected", "failed", "selected"].includes(source.status)
      ? source.status
      : "pending",
    prompt: nonEmptyString(source.prompt),
    assetFile: nonEmptyString(source.assetFile),
    assetUrl: nonEmptyString(source.assetUrl),
    elementId: nonEmptyString(source.elementId),
    frameElementId: nonEmptyString(source.frameElementId),
    sha256: nonEmptyString(source.sha256),
    generationInputSha256: nonEmptyString(source.generationInputSha256),
    error: nonEmptyString(source.error),
  };
}

function normalizeStylingVariationRound(value, index) {
  const source = value && typeof value === "object" ? value : {};
  const id = nonEmptyString(source.id) || `styling-round-${index + 1}`;
  return {
    version: CHARACTER_STYLING_REVIEW_VERSION,
    id,
    kind: ["hairstyle", "hairColor", "outfit", "bodyBuild", "designRefinement"].includes(source.kind) ? source.kind : "outfit",
    status: ["planned", "generating", "awaiting-review", "reviewed", "awaiting-selection", "selected", "failed", "superseded"].includes(source.status)
      ? source.status
      : "planned",
    baseCandidateId: nonEmptyString(source.baseCandidateId),
    baseCandidateLabel: nonEmptyString(source.baseCandidateLabel),
    baseAssetFile: nonEmptyString(source.baseAssetFile),
    baseAssetSha256: nonEmptyString(source.baseAssetSha256),
    specPath: nonEmptyString(source.specPath),
    specSha256: nonEmptyString(source.specSha256),
    specCharacterId: nonEmptyString(source.specCharacterId),
    importEvidence: source.importEvidence && typeof source.importEvidence === "object" ? {
      version: nonEmptyString(source.importEvidence.version),
      sourceManifestPath: nonEmptyString(source.importEvidence.sourceManifestPath),
      sourceManifestSha256: nonEmptyString(source.importEvidence.sourceManifestSha256),
      importMapPath: nonEmptyString(source.importEvidence.importMapPath),
      importMapSha256: nonEmptyString(source.importEvidence.importMapSha256),
    } : null,
    selectionReason: nonEmptyString(source.selectionReason),
    selectedBy: nonEmptyString(source.selectedBy),
    sharedInvariants: stringList(source.sharedInvariants, 50),
    comparisonEvidenceRequired: source.comparisonEvidenceRequired === true,
    comparisonRequirements: stringList(source.comparisonRequirements, 20),
    comparisonReferences: (Array.isArray(source.comparisonReferences) ? source.comparisonReferences : []).map((entry, referenceIndex) => ({
      id: nonEmptyString(entry?.id) || `comparison-${referenceIndex + 1}`,
      path: nonEmptyString(entry?.path),
      sha256: nonEmptyString(entry?.sha256),
    })).filter((entry) => entry.path && entry.sha256).slice(0, 8),
    repairSource: source.repairSource && typeof source.repairSource === "object" ? {
      path: nonEmptyString(source.repairSource.path),
      sha256: nonEmptyString(source.repairSource.sha256),
      roundId: nonEmptyString(source.repairSource.roundId),
      optionId: nonEmptyString(source.repairSource.optionId),
    } : null,
    minimumPassingCandidates: clampInteger(source.minimumPassingCandidates, 1, MAX_STYLING_VARIATION_OPTIONS, 3),
    generatorHost: nonEmptyString(source.generatorHost),
    generatorId: nonEmptyString(source.generatorId),
    generatorContextId: nonEmptyString(source.generatorContextId),
    reviewDraftPath: nonEmptyString(source.reviewDraftPath),
    reviewPath: nonEmptyString(source.reviewPath),
    comparisonSheetPath: nonEmptyString(source.comparisonSheetPath),
    comparisonManifestPath: nonEmptyString(source.comparisonManifestPath),
    selectedOptionId: nonEmptyString(source.selectedOptionId),
    supersededByRoundId: nonEmptyString(source.supersededByRoundId),
    supersededAt: nonEmptyString(source.supersededAt),
    supersedeReason: nonEmptyString(source.supersedeReason),
    options: (Array.isArray(source.options) ? source.options : [])
      .map(normalizeStylingVariationOption)
      .slice(0, MAX_STYLING_VARIATION_OPTIONS),
    createdAt: nonEmptyString(source.createdAt),
    updatedAt: nonEmptyString(source.updatedAt),
  };
}

function normalizeStylingSelection(value) {
  const source = value && typeof value === "object" ? value : {};
  const optionId = nonEmptyString(source.optionId);
  if (!optionId) return null;
  return {
    roundId: nonEmptyString(source.roundId),
    optionId,
    kind: nonEmptyString(source.kind),
    baseCandidateId: nonEmptyString(source.baseCandidateId),
    assetFile: nonEmptyString(source.assetFile),
    assetUrl: nonEmptyString(source.assetUrl),
    sha256: nonEmptyString(source.sha256),
    reviewPath: nonEmptyString(source.reviewPath),
    comparisonManifestPath: nonEmptyString(source.comparisonManifestPath),
    specPath: nonEmptyString(source.specPath),
    specSha256: nonEmptyString(source.specSha256),
    specCharacterId: nonEmptyString(source.specCharacterId),
    optionLabel: nonEmptyString(source.optionLabel),
    optionDescription: nonEmptyString(source.optionDescription),
    optionInvariants: stringList(source.optionInvariants, 30),
    sharedInvariants: stringList(source.sharedInvariants, 50),
    selectedBy: nonEmptyString(source.selectedBy),
    selectedAt: nonEmptyString(source.selectedAt),
    reason: nonEmptyString(source.reason),
  };
}

function normalizeIdentityPack(value) {
  if (!value || typeof value !== "object") return null;
  return {
    selectedFace: normalizeGeneratedAsset(value.selectedFace),
    turnaround: normalizeGeneratedAsset(value.turnaround),
    expression: normalizeGeneratedAsset(value.expression),
    eyeOpen: normalizeGeneratedAsset(value.eyeOpen),
    outfitSheets: (Array.isArray(value.outfitSheets) ? value.outfitSheets : []).map(normalizeGeneratedAsset).filter((entry) => entry.assetFile),
    stylingSelection: normalizeStylingSelection(value.stylingSelection),
    generatedAt: nonEmptyString(value.generatedAt),
    generatorContextId: nonEmptyString(value.generatorContextId),
    repairHistory: (Array.isArray(value.repairHistory) ? value.repairHistory : []).slice(-20).map((entry) => ({
      repairId: nonEmptyString(entry?.repairId),
      failedReviewPath: nonEmptyString(entry?.failedReviewPath),
      failedReviewSha256: nonEmptyString(entry?.failedReviewSha256),
      failedRoles: stringList(entry?.failedRoles, 20),
      generationCheckpointPath: nonEmptyString(entry?.generationCheckpointPath),
      generatorContextId: nonEmptyString(entry?.generatorContextId),
      repairedAt: nonEmptyString(entry?.repairedAt),
    })).filter((entry) => entry.repairId && entry.failedReviewSha256),
  };
}

function normalizedName(value) {
  return nonEmptyString(value)
    .normalize("NFKC")
    .replace(/[\s　]+/g, "")
    .replace(/(?:さん|くん|君|ちゃん|様|氏)$/u, "")
    .toLowerCase();
}

function slugPart(value, fallback = "character") {
  const normalized = nonEmptyString(value)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || fallback;
}

function cleanSpeakerName(value) {
  return nonEmptyString(value)
    .replace(/^[-*・●○◆◇■□▶▷]+\s*/u, "")
    .replace(/[（(][^）)]{0,40}[）)]\s*$/u, "")
    .replace(/^【|】$/gu, "")
    .replace(/[\s:：]+$/u, "")
    .trim()
    .slice(0, 60);
}

function isVisualSpeaker(name) {
  const cleaned = cleanSpeakerName(name);
  if (!cleaned || cleaned.length > 40) return false;
  if (NON_VISUAL_SPEAKERS.has(cleaned)) return false;
  if (/^(?:第?\s*\d+\s*(?:話|章|幕)(?:\s|[:：]|$)|(?:scene|cut|シーン|カット|場面)\s*\d+(?:\s|[:：]|$))/iu.test(cleaned)) return false;
  if (/^[\d\s:：.,。、!?！？-]+$/u.test(cleaned)) return false;
  return true;
}

function inferCharacterRole(name, defaultRole = "per-video") {
  if (/助っ人|案内役|マスコット|固定|レギュラー/u.test(name)) return "fixed";
  return defaultRole === "fixed" ? "fixed" : "per-video";
}

function inferCharacterDescription(name, lines = []) {
  const appearances = lines
    .filter((line) => line.includes(name))
    .slice(0, 4)
    .join(" ")
    .replace(/\s+/g, " ")
    .slice(0, 500);
  return appearances ? `台本内の記述: ${appearances}` : `${name}。台本から抽出された登場人物。`;
}

function mergeCastEntry(base, override = {}) {
  const name = nonEmptyString(override.name) || base.name;
  return {
    ...base,
    id: nonEmptyString(override.id) || nonEmptyString(base.id),
    name,
    role: override.role === "fixed" || override.role === "per-video" ? override.role : base.role,
    aliases: stringList([...(base.aliases ?? []), ...(override.aliases ?? [])], 20),
    description: (nonEmptyString(override.description) || base.description).slice(0, MAX_DESCRIPTION_LENGTH),
    invariants: stringList([...(base.invariants ?? []), ...(override.invariants ?? [])], 30),
    negativePrompt: nonEmptyString(override.negativePrompt ?? override.negative_prompt) || base.negativePrompt,
    stylePrompt: nonEmptyString(override.stylePrompt ?? override.style_prompt) || base.stylePrompt,
    candidateVariants: stringList(override.candidateVariants ?? override.candidate_variants, 10),
    outfitStages: normalizeOutfitStages(override.outfitStages ?? override.outfit_stages),
    voiceId: nonEmptyString(override.voiceId ?? override.voice_id) || base.voiceId,
  };
}

function extractSpeakerFromLine(line) {
  const trimmed = line.trim();
  const explicitPrefixPatterns = [
    /^【([^】]{1,40})】/u,
    /^([^:：]{1,40}?)\s*[：:]/u,
  ];
  for (const pattern of explicitPrefixPatterns) {
    const match = trimmed.match(pattern);
    if (!match) continue;
    const candidate = cleanSpeakerName(match[1]);
    return isVisualSpeaker(candidate) ? candidate : "";
  }
  const fallbackPatterns = [
    /^([^「『]{1,40})[「『]/u,
    /^[-*・●○◆◇■□▶▷]?\s*([^\s（(]{1,30})\s*[（(][^）)]{0,40}[）)]\s*[：:]?/u,
  ];
  for (const pattern of fallbackPatterns) {
    const match = trimmed.match(pattern);
    const candidate = cleanSpeakerName(match?.[1]);
    if (isVisualSpeaker(candidate)) return candidate;
  }
  return "";
}

function maskLeadingYamlFrontmatter(text) {
  return text.replace(
    /^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/u,
    (frontmatter) => frontmatter.replace(/[^\n]/gu, " "),
  );
}

export function extractCastFromScript(scriptText, options = {}) {
  const text = String(scriptText ?? "").slice(0, MAX_SCRIPT_LENGTH).replace(/\r\n?/g, "\n");
  const lines = maskLeadingYamlFrontmatter(text).split("\n");
  const byName = new Map();
  for (const [lineIndex, line] of lines.entries()) {
    const name = extractSpeakerFromLine(line);
    if (!name) continue;
    const key = normalizedName(name);
    if (!key) continue;
    const current = byName.get(key) ?? {
      name,
      role: inferCharacterRole(name, options.defaultRole),
      aliases: [],
      description: "",
      invariants: [],
      negativePrompt: "",
      stylePrompt: "",
      voiceId: "",
      firstAppearanceLine: lineIndex + 1,
      dialogueCount: 0,
    };
    current.dialogueCount += 1;
    if (current.name !== name && !current.aliases.includes(name)) current.aliases.push(name);
    byName.set(key, current);
  }

  const extracted = [...byName.values()].map((entry) => ({
    ...entry,
    description: inferCharacterDescription(entry.name, lines),
  }));
  const overrides = Array.isArray(options.cast) ? options.cast : [];
  const merged = [];
  const seen = new Set();
  for (const entry of extracted) {
    const override = overrides.find((item) =>
      normalizedName(item?.name) === normalizedName(entry.name) ||
      stringList(item?.aliases).some((alias) => normalizedName(alias) === normalizedName(entry.name)),
    );
    const next = mergeCastEntry(entry, override);
    merged.push(next);
    seen.add(normalizedName(next.name));
  }
  for (const override of overrides) {
    const name = cleanSpeakerName(override?.name);
    if (!isVisualSpeaker(name) || seen.has(normalizedName(name))) continue;
    merged.push(mergeCastEntry({
      name,
      role: inferCharacterRole(name, options.defaultRole),
      aliases: [],
      description: `${name}。ユーザー指定の登場人物。`,
      invariants: [],
      negativePrompt: "",
      stylePrompt: "",
      voiceId: "",
      firstAppearanceLine: null,
      dialogueCount: 0,
    }, override));
    seen.add(normalizedName(name));
  }
  return merged.slice(0, MAX_CAST_PER_WORKFLOW);
}

export function resolveCharacterWorkflowFile(args = {}) {
  return join(resolveCanvasDir(args), CHARACTER_WORKFLOW_FILE_NAME);
}

function normalizeCandidate(candidate, index) {
  const source = candidate && typeof candidate === "object" ? candidate : {};
  return {
    id: nonEmptyString(source.id) || `candidate-${index + 1}`,
    index: clampInteger(source.index, 1, MAX_CANDIDATES_PER_CAST, index + 1),
    status: ["pending", "generating", "generated", "selected", "rejected", "failed"].includes(source.status)
      ? source.status
      : "pending",
    prompt: nonEmptyString(source.prompt),
    variationAxis: nonEmptyString(source.variationAxis),
    blindLabel: nonEmptyString(source.blindLabel),
    candidateSetId: nonEmptyString(source.candidateSetId),
    blindArtifactFile: nonEmptyString(source.blindArtifactFile),
    blindArtifactSha256: nonEmptyString(source.blindArtifactSha256),
    blindPublicPacketPath: nonEmptyString(source.blindPublicPacketPath),
    blindPrivateMappingPath: nonEmptyString(source.blindPrivateMappingPath),
    elementId: nonEmptyString(source.elementId),
    frameElementId: nonEmptyString(source.frameElementId),
    assetFile: nonEmptyString(source.assetFile),
    assetUrl: nonEmptyString(source.assetUrl),
    error: nonEmptyString(source.error),
  };
}

function normalizeWorkflowCast(entry, index) {
  const source = entry && typeof entry === "object" ? entry : {};
  const id = nonEmptyString(source.id) || `cast-${index + 1}`;
  const candidates = (Array.isArray(source.candidates) ? source.candidates : [])
    .map(normalizeCandidate)
    .slice(0, MAX_CANDIDATES_PER_CAST);
  return {
    id,
    name: nonEmptyString(source.name) || id,
    role: source.role === "fixed" ? "fixed" : "per-video",
    aliases: stringList(source.aliases, 20),
    description: nonEmptyString(source.description).slice(0, MAX_DESCRIPTION_LENGTH),
    invariants: stringList(source.invariants, 30),
    negativePrompt: nonEmptyString(source.negativePrompt),
    stylePrompt: nonEmptyString(source.stylePrompt),
    candidateVariants: stringList(source.candidateVariants ?? source.candidate_variants, 10),
    outfitStages: normalizeOutfitStages(source.outfitStages ?? source.outfit_stages),
    voiceId: nonEmptyString(source.voiceId),
    firstAppearanceLine: Number.isFinite(Number(source.firstAppearanceLine)) ? Number(source.firstAppearanceLine) : null,
    dialogueCount: Math.max(0, Math.round(Number(source.dialogueCount) || 0)),
    status: VALID_CAST_STATUSES.has(source.status) ? source.status : "needs-candidates",
    matchedCharacterId: nonEmptyString(source.matchedCharacterId),
    characterId: nonEmptyString(source.characterId),
    candidateGroupId: nonEmptyString(source.candidateGroupId) || `${id}-candidates`,
    candidates,
    selectedCandidateId: nonEmptyString(source.selectedCandidateId),
    blindCandidateSet: source.blindCandidateSet && typeof source.blindCandidateSet === "object"
      ? structuredClone(source.blindCandidateSet)
      : null,
    candidateReviewDraftPath: nonEmptyString(source.candidateReviewDraftPath),
    candidateGeneratorContextId: nonEmptyString(source.candidateGeneratorContextId),
    candidateImportEvidencePath: nonEmptyString(source.candidateImportEvidencePath),
    candidateImportEvidenceSha256: nonEmptyString(source.candidateImportEvidenceSha256),
    candidateReviewPath: nonEmptyString(source.candidateReviewPath),
    stylingVariationRounds: (Array.isArray(source.stylingVariationRounds) ? source.stylingVariationRounds : [])
      .map(normalizeStylingVariationRound)
      .slice(-MAX_STYLING_VARIATION_ROUNDS),
    stylingSelection: normalizeStylingSelection(source.stylingSelection),
    identityReviewDraftPath: nonEmptyString(source.identityReviewDraftPath),
    identityReviewPath: nonEmptyString(source.identityReviewPath),
    identityPack: normalizeIdentityPack(source.identityPack),
    approval: source.approval && typeof source.approval === "object"
      ? {
          route: nonEmptyString(source.approval.route),
          approvedBy: nonEmptyString(source.approval.approvedBy),
          approvedAt: nonEmptyString(source.approval.approvedAt),
          selectedCandidateId: nonEmptyString(source.approval.selectedCandidateId),
          selectedCandidateLabel: nonEmptyString(source.approval.selectedCandidateLabel),
          candidateSetId: nonEmptyString(source.approval.candidateSetId),
          verdictDigest: nonEmptyString(source.approval.verdictDigest),
          selectedVariationAxis: nonEmptyString(source.approval.selectedVariationAxis),
          reason: nonEmptyString(source.approval.reason),
          candidateReviewPath: nonEmptyString(source.approval.candidateReviewPath),
          stylingReviewPath: nonEmptyString(source.approval.stylingReviewPath),
          stylingRoundId: nonEmptyString(source.approval.stylingRoundId),
          stylingOptionId: nonEmptyString(source.approval.stylingOptionId),
        }
      : null,
    expressionSheet: source.expressionSheet && typeof source.expressionSheet === "object"
      ? normalizeGeneratedAsset(source.expressionSheet)
      : null,
    turnaroundSheet: source.turnaroundSheet && typeof source.turnaroundSheet === "object"
      ? normalizeGeneratedAsset(source.turnaroundSheet)
      : null,
    eyeOpenSheet: source.eyeOpenSheet && typeof source.eyeOpenSheet === "object"
      ? normalizeGeneratedAsset(source.eyeOpenSheet)
      : null,
  };
}

function normalizeWorkflow(workflow, index) {
  const source = workflow && typeof workflow === "object" ? workflow : {};
  const id = nonEmptyString(source.id) || `workflow-${index + 1}`;
  return {
    id,
    title: nonEmptyString(source.title) || id,
    episodeId: nonEmptyString(source.episodeId),
    status: VALID_WORKFLOW_STATUSES.has(source.status) ? source.status : "draft",
    candidateCount: clampInteger(source.candidateCount, 1, MAX_CANDIDATES_PER_CAST, DEFAULT_CHARACTER_CANDIDATE_COUNT),
    model: nonEmptyString(source.model) || "gpt-image-2-codex",
    aspectRatio: nonEmptyString(source.aspectRatio) || "16:9",
    imageSize: nonEmptyString(source.imageSize) || "2K",
    quality: nonEmptyString(source.quality) || "high",
    channelStylePrompt: nonEmptyString(source.channelStylePrompt),
    visualProfileId: nonEmptyString(source.visualProfileId ?? source.visual_profile_id),
    visualProfile: normalizeChannelVisualProfileSnapshot(source.visualProfile),
    script: {
      sourcePath: nonEmptyString(source.script?.sourcePath),
      sha256: nonEmptyString(source.script?.sha256),
      text: String(source.script?.text ?? "").slice(0, MAX_SCRIPT_LENGTH),
    },
    cast: (Array.isArray(source.cast) ? source.cast : [])
      .map(normalizeWorkflowCast)
      .slice(0, MAX_CAST_PER_WORKFLOW),
    scenes: (Array.isArray(source.scenes) ? source.scenes : []).slice(0, MAX_SCENES),
    warnings: stringList(source.warnings, 50),
    createdAt: nonEmptyString(source.createdAt),
    updatedAt: nonEmptyString(source.updatedAt),
  };
}

export function normalizeCharacterWorkflowStore(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    version: CHARACTER_WORKFLOW_VERSION,
    revision: Math.max(0, Math.floor(Number(source.revision) || 0)),
    workflows: (Array.isArray(source.workflows) ? source.workflows : [])
      .map(normalizeWorkflow)
      .slice(-MAX_WORKFLOWS),
  };
}

async function readCharacterWorkflowStoreFile(file) {
  try {
    const raw = await readFile(file, "utf8");
    if (!raw.trim()) throw new Error(`Character workflow store is empty: ${file}.`);
    return normalizeCharacterWorkflowStore(JSON.parse(raw));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return normalizeCharacterWorkflowStore(null);
  }
}

export async function readCharacterWorkflowStore(args = {}) {
  return readCharacterWorkflowStoreFile(resolveCharacterWorkflowFile(args));
}

async function writeCharacterWorkflowStoreFile(file, store, currentRevision) {
  const normalized = normalizeCharacterWorkflowStore(store);
  normalized.revision = currentRevision + 1;
  await writeJsonAtomic(file, normalized);
  return normalized;
}

export async function writeCharacterWorkflowStore(args = {}, store) {
  const file = resolveCharacterWorkflowFile(args);
  const expectedRevision = Math.max(0, Math.floor(Number(store?.revision) || 0));
  return withCanvasFileLock(file, async () => {
    const current = await readCharacterWorkflowStoreFile(file);
    if (current.revision !== expectedRevision) {
      throw new Error(`Stale character workflow revision: expected ${expectedRevision}, current ${current.revision}. Read the store again before writing.`);
    }
    return writeCharacterWorkflowStoreFile(file, store, current.revision);
  });
}

export function getCharacterWorkflow(store, workflowId) {
  const id = nonEmptyString(workflowId);
  return (store?.workflows ?? []).find((workflow) => workflow.id === id) ?? null;
}

export async function updateCharacterWorkflow(args = {}, workflowId, updater) {
  const file = resolveCharacterWorkflowFile(args);
  return withCanvasFileLock(file, async () => {
    const store = await readCharacterWorkflowStoreFile(file);
    const index = store.workflows.findIndex((workflow) => workflow.id === workflowId);
    if (index < 0) throw new Error(`Unknown character workflow: ${workflowId}.`);
    const current = store.workflows[index];
    const next = normalizeWorkflow(
      typeof updater === "function" ? updater(structuredClone(current)) : updater,
      index,
    );
    next.updatedAt = new Date().toISOString();
    store.workflows[index] = next;
    await writeCharacterWorkflowStoreFile(file, store, store.revision);
    return next;
  });
}

async function resolveScriptInput(args = {}) {
  const scriptPath = nonEmptyString(args.scriptPath ?? args.script_path);
  if (scriptPath) {
    const text = await readFile(resolve(scriptPath), "utf8");
    return { text: text.slice(0, MAX_SCRIPT_LENGTH), sourcePath: resolve(scriptPath) };
  }
  return { text: String(args.scriptText ?? args.script_text ?? "").slice(0, MAX_SCRIPT_LENGTH), sourcePath: "" };
}

function workflowStatusForCast(cast) {
  if (cast.length === 0) return "draft";
  if (cast.every((entry) => entry.status === "ready" || entry.status === "existing")) return "ready";
  if (cast.some((entry) => entry.status === "awaiting-approval")) return "awaiting-approval";
  if (cast.some((entry) => entry.status === "awaiting-identity-qa" || entry.status === "building-identity-pack")) return "awaiting-identity-qa";
  return "awaiting-candidates";
}

export async function prepareCharacterWorkflow(args = {}) {
  const script = await resolveScriptInput(args);
  const providedCast = Array.isArray(args.cast) ? args.cast : [];
  if (!script.text.trim() && providedCast.length === 0) {
    throw new Error("scriptText/scriptPath or an explicit cast array is required.");
  }
  const registry = await readCharacterRegistry(args);
  const requestedVisualProfileId = nonEmptyString(args.visualProfileId ?? args.visual_profile_id);
  const visualProfile = await resolveChannelVisualProfileSnapshot(args, requestedVisualProfileId);
  if (requestedVisualProfileId && !visualProfile) {
    throw new Error(`Unknown channel visual profile: ${requestedVisualProfileId}.`);
  }
  const episodeId = nonEmptyString(args.episodeId ?? args.episode_id) || `episode-${new Date().toISOString().slice(0, 10)}`;
  const extracted = extractCastFromScript(script.text, {
    cast: providedCast,
    defaultRole: args.defaultRole ?? args.default_role,
  });
  const usedIds = new Set(registry.characters.map((character) => character.id));
  const cast = extracted.map((entry, index) => {
    const matched = findCharacter(registry, entry.name) || entry.aliases.map((alias) => findCharacter(registry, alias)).find(Boolean);
    const sameEpisodeOrFixed = matched && (
      matched.role === "fixed" ||
      !matched.episodeId ||
      matched.episodeId === episodeId
    );
    const reusable = sameEpisodeOrFixed && matched.status === "approved";
    const requestedId = nonEmptyString(entry.id);
    let id = sameEpisodeOrFixed ? matched.id : requestedId || `${slugPart(episodeId, "episode")}-${slugPart(entry.name, `character-${index + 1}`)}`;
    if (!sameEpisodeOrFixed && requestedId && usedIds.has(requestedId)) {
      throw new Error(`Explicit character id '${requestedId}' is already used by another registry character.`);
    }
    let suffix = 2;
    while (!sameEpisodeOrFixed && !requestedId && usedIds.has(id)) {
      id = `${slugPart(episodeId, "episode")}-${slugPart(entry.name, `character-${index + 1}`)}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(id);
    return normalizeWorkflowCast({
      ...entry,
      id,
      status: reusable ? "existing" : "needs-candidates",
      matchedCharacterId: reusable ? matched.id : "",
      characterId: reusable ? matched.id : "",
      candidateGroupId: `${id}-candidates`,
    }, index);
  });
  const warnings = [];
  if (cast.length === 0) {
    warnings.push("台本から人物名を抽出できませんでした。『名前：セリフ』形式にするかcast配列を指定してください。");
  }
  const now = new Date().toISOString();
  const workflowId = nonEmptyString(args.workflowId ?? args.workflow_id) || `workflow-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const workflow = normalizeWorkflow({
    id: workflowId,
    title: nonEmptyString(args.title) || `${episodeId} キャラクター制作`,
    episodeId,
    status: workflowStatusForCast(cast),
    candidateCount: args.candidateCount ?? args.candidate_count,
    model: args.model,
    aspectRatio: args.aspectRatio ?? args.aspect_ratio,
    imageSize: args.imageSize ?? args.image_size,
    quality: args.quality,
    channelStylePrompt: args.channelStylePrompt ?? args.channel_style_prompt,
    visualProfileId: visualProfile?.id || "",
    visualProfile,
    script: {
      sourcePath: script.sourcePath,
      sha256: createHash("sha256").update(script.text).digest("hex"),
      text: script.text,
    },
    cast,
    warnings,
    createdAt: now,
    updatedAt: now,
  }, 0);
  const store = await readCharacterWorkflowStore(args);
  const existingIndex = store.workflows.findIndex((item) => item.id === workflow.id);
  if (existingIndex >= 0) store.workflows[existingIndex] = workflow;
  else store.workflows.push(workflow);
  await writeCharacterWorkflowStore(args, store);
  return workflow;
}

let cachedCharacterCandidateTemplate = "";
async function readCharacterCandidateTemplate() {
  if (cachedCharacterCandidateTemplate) return cachedCharacterCandidateTemplate;
  const markdown = await readFile(REFERENCE_PROMPTS_FILE, "utf8");
  const section = markdown.split("## キャラクター候補カード（承認前）")[1]?.split('## キャラクターシート（kind: "character"）')[0] ?? markdown;
  const fenced = section.match(/~~~\s*\n([\s\S]*?)\n~~~/u)?.[1]?.trim();
  if (!fenced) throw new Error(`Character candidate template was not found: ${REFERENCE_PROMPTS_FILE}`);
  cachedCharacterCandidateTemplate = fenced;
  return cachedCharacterCandidateTemplate;
}

const CANDIDATE_VARIATIONS = [
  "Variation direction A (FAITHFUL BASELINE): the most literal, conventional reading of the written setup. Ordinary proportions, the default hairstyle and outfit exactly as described, a neutral default expression. This is the reference point the other candidates must visibly differ from.",
  "Variation direction B (DIFFERENT FACE CONSTRUCTION): keep every non-negotiable trait, but change the face construction noticeably so it reads as a different design option at a glance: a different eye size and eye shape, a different face length and jaw, a different eyebrow weight, a clearly different bangs/fringe treatment and hair volume or hair-mass silhouette. Same clothing category, but restyle its cut and details.",
  "Variation direction C (DIFFERENT AGE, BODY AND ATTITUDE READING): keep every non-negotiable trait, but reinterpret the character through personality: push the age cues toward the other end of the stated range, change the body build and posture, give the default expression and stance the strongest version of the written personality, and alter the hairstyle details and outfit styling within the written setup.",
  "Variation direction D (MORE DISTINCTIVE SILHOUETTE): keep every non-negotiable trait, but make the hair silhouette and clothing rhythm more distinctive and iconic, without adding props or changing the written identity.",
  "Variation direction E (RESTRAINED MATURE INTERPRETATION): keep every non-negotiable trait, but use a restrained mature interpretation, without making the character glamorous or changing the stated age.",
];

function characterAppearanceDescription(cast, workflow, styleReferenceCount = 0) {
  const otherCast = workflow.cast
    .filter((entry) => entry.id !== cast.id)
    .map((entry) => entry.name)
    .filter(Boolean);
  const details = [
    `Name / role label: ${cast.name}.`,
    cast.description,
    cast.invariants.length > 0 ? `Non-negotiable identity traits: ${cast.invariants.join("; ")}.` : "",
    cast.negativePrompt ? `Avoid: ${cast.negativePrompt}.` : "",
    cast.stylePrompt,
    workflow.channelStylePrompt,
    buildChannelVisualStylePrompt(workflow.visualProfile, {
      prompt: cast.description,
      styleTags: ["character", "closeup", "day"],
    }, styleReferenceCount),
    otherCast.length > 0
      ? `CAST SEPARATION: ${cast.name} must have a visibly different face shape, eye shape, eyebrows, hair silhouette, age cues, build and wardrobe from ${otherCast.join(", ")}. Share only the rendering style.`
      : "CAST SEPARATION: create an original identity that does not resemble any person in the style references.",
    "Match the channel's intended production density exactly. Do not add realistic detail, glossy game-art polish, 3D, chibi, western superhero anatomy, or social-media screenshot styling.",
  ].filter(Boolean);
  return details.join(" ");
}

export async function buildCharacterCandidateJobs(workflow, options = {}) {
  const template = await readCharacterCandidateTemplate();
  const model = nonEmptyString(options.model) || workflow.model;
  const aspectRatio = nonEmptyString(options.aspectRatio ?? options.aspect_ratio) || workflow.aspectRatio;
  const imageSize = nonEmptyString(options.imageSize ?? options.image_size) || workflow.imageSize;
  const quality = nonEmptyString(options.quality) || workflow.quality;
  const candidateCount = clampInteger(
    options.candidateCount ?? options.candidate_count,
    2,
    Math.min(5, MAX_CANDIDATES_PER_CAST),
    workflow.candidateCount,
  );
  const jobs = [];
  for (const cast of workflow.cast.filter((entry) => entry.status === "needs-candidates" || entry.status === "failed")) {
    const styleReferences = selectChannelVisualReferences(workflow.visualProfile, {
      prompt: cast.description,
      styleTags: ["character", "closeup", "day"],
      characterIds: [cast.id],
    }, { maxStyleReferences: 2 });
    const setup = characterAppearanceDescription(cast, workflow, styleReferences.length);
    for (let index = 0; index < candidateCount; index += 1) {
      const candidateId = `${cast.candidateGroupId}-${index + 1}`;
      const variation = cast.candidateVariants?.[index]
        ? `Variation direction ${String.fromCharCode(65 + index)} (CHARACTER-SPECIFIC DESIGN): ${cast.candidateVariants[index]}`
        : CANDIDATE_VARIATIONS[index % CANDIDATE_VARIATIONS.length];
      const prompt = `${template.replace(CHARACTER_SETUP_MARKER, setup)}\n\n${variation}\nThis is candidate ${index + 1} of ${candidateCount}. Keep all written identity requirements, but create a genuinely distinct design option from the other candidates: a viewer comparing the candidates side by side must see an obvious difference in face construction, hair silhouette or build, not only a change of pose or color. Never reuse or imitate the identity of a person visible in a STYLE-ONLY reference.`;
      jobs.push({
        prompt,
        model,
        aspectRatio,
        imageSize,
        quality,
        referenceImagePaths: styleReferences.map((reference) => reference.path),
        fileName: `${slugPart(cast.id)}-candidate-${index + 1}.png`,
        customData: {
          buzzassistCharacterCandidate: true,
          buzzassistCharacterWorkflowId: workflow.id,
          buzzassistCharacterCastId: cast.id,
          buzzassistCharacterCandidateGroupId: cast.candidateGroupId,
          buzzassistCharacterCandidateId: candidateId,
          buzzassistCharacterCandidateIndex: index + 1,
          buzzassistCharacterVariationAxis: variation,
          buzzassistCharacterName: cast.name,
          buzzassistCharacterLabel: `${cast.name}｜候補${index + 1}`,
          buzzassistCharacterApprovalStatus: "pending",
          buzzassistChannelVisualProfileId: workflow.visualProfile?.id || "",
          buzzassistStyleReferencePaths: styleReferences.map((reference) => reference.path),
        },
        pipeline: { castId: cast.id, candidateId, candidateIndex: index + 1, variationAxis: variation },
      });
    }
  }
  return jobs;
}

export function buildCharacterCandidateRegenerationJobs(workflow, castSelector, candidateLabels = [], options = {}) {
  const cast = findWorkflowCast(workflow, castSelector);
  if (!cast) throw new Error(`Unknown workflow character: ${castSelector}.`);
  const labels = stringList(candidateLabels, MAX_CANDIDATES_PER_CAST).map((label) => label.toUpperCase());
  if (labels.length === 0) throw new Error("regenerateCandidateLabels must contain at least one anonymous label.");
  const selected = labels.map((label) => {
    const candidate = findWorkflowCandidate(cast, label);
    if (!candidate?.assetFile || !candidate.prompt) throw new Error(`Anonymous candidate ${label} cannot be regenerated from this workflow.`);
    return candidate;
  });
  const styleReferences = selectChannelVisualReferences(workflow.visualProfile, {
    prompt: cast.description,
    styleTags: ["character", "closeup", "day"],
    characterIds: [cast.id],
  }, { maxStyleReferences: 2 });
  return selected.map((candidate) => ({
    prompt: `${candidate.prompt}\n\nREGENERATION: the previous anonymous option was too visually similar to another candidate. Preserve this option's written variation axis, but make its face construction, hair silhouette, and body build unmistakably different at original size.`,
    model: nonEmptyString(options.model) || workflow.model,
    aspectRatio: nonEmptyString(options.aspectRatio ?? options.aspect_ratio) || workflow.aspectRatio,
    imageSize: nonEmptyString(options.imageSize ?? options.image_size) || workflow.imageSize,
    quality: nonEmptyString(options.quality) || workflow.quality,
    referenceImagePaths: styleReferences.map((reference) => reference.path),
    fileName: `${slugPart(cast.id)}-candidate-${candidate.index}-regenerated.png`,
    customData: {
      buzzassistCharacterCandidate: true,
      buzzassistCharacterCandidateRegeneration: true,
      buzzassistCharacterWorkflowId: workflow.id,
      buzzassistCharacterCastId: cast.id,
      buzzassistCharacterCandidateGroupId: cast.candidateGroupId,
      buzzassistCharacterCandidateId: candidate.id,
      buzzassistCharacterCandidateIndex: candidate.index,
      buzzassistCharacterVariationAxis: candidate.variationAxis,
      buzzassistCharacterName: cast.name,
      buzzassistCharacterLabel: `${cast.name}｜候補${candidate.index}再生成`,
      buzzassistCharacterApprovalStatus: "pending",
      buzzassistStyleReferencePaths: styleReferences.map((reference) => reference.path),
    },
    pipeline: { castId: cast.id, candidateId: candidate.id, candidateIndex: candidate.index, variationAxis: candidate.variationAxis },
  }));
}

export async function markCharacterCandidatesGenerating(args = {}, workflowId, jobs = []) {
  return updateCharacterWorkflow(args, workflowId, (workflow) => {
    const byCast = new Map();
    for (const job of jobs) {
      if (!job.pipeline?.castId) continue;
      const candidates = byCast.get(job.pipeline.castId) ?? [];
      candidates.push({
        id: job.pipeline.candidateId,
        index: job.pipeline.candidateIndex,
        variationAxis: nonEmptyString(job.pipeline.variationAxis),
        status: "generating",
        prompt: job.prompt,
      });
      byCast.set(job.pipeline.castId, candidates);
    }
    workflow.cast = workflow.cast.map((cast) => {
      if (!byCast.has(cast.id)) return cast;
      const requested = byCast.get(cast.id);
      if (cast.candidates.length === 0) return { ...cast, status: "generating-candidates", candidates: requested };
      const replacementById = new Map(requested.map((candidate) => [candidate.id, candidate]));
      return {
        ...cast,
        status: "generating-candidates",
        candidateReviewDraftPath: "",
        candidateReviewPath: "",
        candidates: cast.candidates.map((candidate) => replacementById.has(candidate.id)
          ? {
              ...candidate,
              ...replacementById.get(candidate.id),
              blindLabel: "",
              candidateSetId: "",
              blindArtifactFile: "",
              blindArtifactSha256: "",
              blindPublicPacketPath: "",
              blindPrivateMappingPath: "",
              elementId: "",
              frameElementId: "",
              assetFile: "",
              assetUrl: "",
              error: "",
            }
          : candidate),
      };
    });
    workflow.status = "awaiting-candidates";
    return workflow;
  });
}

export async function recordCharacterCandidateResults(args = {}, workflowId, jobs = [], results = []) {
  const candidateGeneratorContextId = nonEmptyString(args.generatorContextId ?? args.generator_context_id);
  const targetCastIds = new Set(jobs.map((job) => nonEmptyString(job?.pipeline?.castId)).filter(Boolean));
  const preserveBlindLabels = args.preserveBlindLabels === true;
  const preservedLabelByCandidateId = new Map(jobs.map((job) => [
    nonEmptyString(job?.pipeline?.candidateId),
    nonEmptyString(job?.pipeline?.candidateLabel).toUpperCase(),
  ]).filter(([id, label]) => id && /^[A-E]$/u.test(label)));
  let updated = await updateCharacterWorkflow(args, workflowId, (workflow) => {
    const outcomeById = new Map();
    jobs.forEach((job, index) => outcomeById.set(job.pipeline?.candidateId, results[index] ?? {}));
    workflow.cast = workflow.cast.map((cast) => {
      if (!targetCastIds.has(cast.id)) return cast;
      if (!cast.candidates.length) return cast;
      const candidates = cast.candidates.map((candidate) => {
        const outcome = outcomeById.get(candidate.id);
        if (!outcome) return candidate;
        return {
          ...candidate,
          status: outcome.error ? "failed" : "generated",
          elementId: nonEmptyString(outcome.elementId),
          frameElementId: nonEmptyString(outcome.frameElementId),
          assetFile: nonEmptyString(outcome.assetFile),
          assetUrl: nonEmptyString(outcome.assetUrl),
          error: nonEmptyString(outcome.error),
        };
      });
      const generatedCount = candidates.filter((candidate) => candidate.status === "generated").length;
      return {
        ...cast,
        candidates,
        candidateGeneratorContextId,
        status: generatedCount > 0 ? "awaiting-approval" : "failed",
      };
    });
    workflow.status = workflowStatusForCast(workflow.cast);
    return workflow;
  });
  const canvasDir = resolveCanvasDir(args);
  for (const cast of updated.cast.filter((entry) => entry.status === "awaiting-approval" && targetCastIds.has(entry.id))) {
    const generated = cast.candidates.filter((candidate) => candidate.status === "generated" && candidate.assetFile);
    if (generated.length < 2) continue;
    const rootDir = join(canvasDir, "character-candidate-blind", updated.id, cast.id);
    if (preserveBlindLabels && preservedLabelByCandidateId.size !== generated.length) {
      throw new Error("Preserved candidate import requires one explicit A..E public label for every generated candidate.");
    }
    const packageInput = generated.map((candidate) => ({
      ...(preserveBlindLabels ? { label: preservedLabelByCandidateId.get(candidate.id) } : {}),
      id: candidate.id,
      variationAxis: candidate.variationAxis,
      artifact: candidate.assetFile,
      provider: updated.model,
      source: preserveBlindLabels ? "character-candidate-import" : "character-candidate",
    }));
    const packageOptions = {
      rootDir,
      artifactDir: join(canvasDir, "assets", `blind-${slugPart(updated.id, "workflow")}-${slugPart(cast.id, "cast")}`),
      minimumCandidates: 2,
      maximumCandidates: 5,
    };
    const packageResult = preserveBlindLabels
      ? await writePreservedBlindCandidatePackage(packageInput, packageOptions)
      : await writeBlindCandidatePackage(packageInput, packageOptions);
    const privateSource = JSON.parse(await readFile(packageResult.privatePath, "utf8"));
    const labelById = new Map(privateSource.mapping.map((entry) => [entry.id, entry.label]));
    updated = await updateCharacterWorkflow(args, workflowId, (workflow) => {
      workflow.cast = workflow.cast.map((entry) => entry.id !== cast.id ? entry : {
        ...entry,
        blindCandidateSet: publicBlindCandidateSummary(packageResult),
        candidates: entry.candidates.map((candidate) => {
          const label = labelById.get(candidate.id) || "";
          const publicRow = packageResult.publicPacket.candidates.find((row) => row.label === label);
          return label ? {
            ...candidate,
            blindLabel: label,
            candidateSetId: packageResult.setId,
            blindArtifactFile: publicRow?.artifactRef || "",
            blindArtifactSha256: publicRow?.artifactSha256 || "",
            blindPublicPacketPath: packageResult.publicPath,
            blindPrivateMappingPath: packageResult.privatePath,
          } : candidate;
        }),
      });
      return workflow;
    });
    const reviewedCast = findWorkflowCast(updated, cast.id);
    const draft = await prepareCandidateDiversityReviewDraft({
      ...args,
      workflow: updated,
      cast: reviewedCast,
      generatorContextId: reviewedCast.candidateGeneratorContextId,
    });
    updated = await updateCharacterWorkflow(args, workflowId, (workflow) => {
      workflow.cast = workflow.cast.map((entry) => entry.id === cast.id
        ? { ...entry, candidateReviewDraftPath: draft.path }
        : entry);
      return workflow;
    });
  }
  return updated;
}

export async function refreshCharacterCandidateReviewDrafts(args = {}) {
  const workflowId = nonEmptyString(args.workflowId ?? args.workflow_id);
  const generatorContextBase = nonEmptyString(args.generatorContextId ?? args.generator_context_id);
  if (!workflowId) throw new Error("workflowId is required to refresh candidate reviews.");
  if (!generatorContextBase) throw new Error("generatorContextId is required to bind migrated candidate artifacts.");
  const store = await readCharacterWorkflowStore(args);
  let workflow = getCharacterWorkflow(store, workflowId);
  if (!workflow) throw new Error(`Unknown character workflow: ${workflowId}.`);
  const requestedCast = nonEmptyString(args.castId ?? args.cast_id);
  const targets = requestedCast ? [findWorkflowCast(workflow, requestedCast)].filter(Boolean) : workflow.cast;
  if (requestedCast && targets.length === 0) throw new Error(`Unknown workflow character: ${requestedCast}.`);
  const refreshed = [];
  for (const target of targets) {
    const generated = target.candidates.filter((candidate) => candidate.status === "generated" && candidate.blindLabel && candidate.blindArtifactFile && candidate.blindArtifactSha256);
    if (generated.length < 2) {
      throw new Error(`${target.name} requires at least two generated anonymous candidates before review refresh.`);
    }
    const generatorContextId = `${generatorContextBase}:${target.id}`;
    const reviewCast = { ...target, candidateGeneratorContextId: generatorContextId };
    const draft = await prepareCandidateDiversityReviewDraft({
      ...args,
      workflow,
      cast: reviewCast,
      generatorContextId,
    });
    workflow = await updateCharacterWorkflow(args, workflowId, (current) => {
      current.cast = current.cast.map((entry) => entry.id === target.id
        ? { ...entry, candidateGeneratorContextId: generatorContextId, candidateReviewDraftPath: draft.path }
        : entry);
      return current;
    });
    refreshed.push({ castId: target.id, name: target.name, generatorContextId, reviewPath: draft.path, candidateCount: generated.length });
  }
  return { workflowId, workflow, refreshed };
}

export async function migrateLegacyCharacterCandidateBlindArtifacts(args = {}) {
  const workflowId = nonEmptyString(args.workflowId ?? args.workflow_id);
  const castId = nonEmptyString(args.castId ?? args.cast_id);
  const generatorHost = nonEmptyString(args.generatorHost ?? args.generator_host);
  const generatorId = nonEmptyString(args.generatorId ?? args.generator_id);
  const generatorContextId = nonEmptyString(args.generatorContextId ?? args.generator_context_id);
  const migrationReason = nonEmptyString(args.migrationReason ?? args.migration_reason);
  const requestedLabels = stringList(String(args.candidateLabels ?? args.candidate_labels ?? "").split(","), 5).map((label) => label.toUpperCase()).sort();
  const retiredLabels = stringList(String(args.retiredCandidateLabels ?? args.retired_candidate_labels ?? "").split(","), MAX_CANDIDATES_PER_CAST).map((label) => label.toUpperCase()).sort();
  if (generatorHost !== "legacy-migration") throw new Error("Legacy blind candidate migration requires generatorHost=legacy-migration.");
  if (!workflowId || !castId) throw new Error("workflowId and castId are required for legacy blind candidate migration.");
  if (!generatorId || !generatorContextId) throw new Error("generatorId and generatorContextId are required for legacy blind candidate migration provenance.");
  if (migrationReason.length < 12) throw new Error("A concrete migrationReason of at least 12 characters is required.");
  if (requestedLabels.length < 2 || requestedLabels.length > 5) throw new Error("candidateLabels must contain 2 to 5 published labels.");
  const expectedLabels = requestedLabels.map((_, index) => String.fromCharCode(65 + index));
  if (requestedLabels.some((label, index) => label !== expectedLabels[index])) throw new Error(`candidateLabels must be a complete ${expectedLabels.join("/")} set.`);
  if (retiredLabels.some((label) => requestedLabels.includes(label))) throw new Error("retiredCandidateLabels cannot overlap candidateLabels.");

  const canvasDir = resolveCanvasDir(args);
  const store = await readCharacterWorkflowStore(args);
  const workflow = getCharacterWorkflow(store, workflowId);
  if (!workflow) throw new Error(`Unknown character workflow: ${workflowId}.`);
  const cast = findWorkflowCast(workflow, castId);
  if (!cast) throw new Error(`Unknown workflow character: ${castId}.`);
  if (cast.selectedCandidateId || cast.approval || cast.candidateReviewPath) {
    throw new Error(`${cast.name} already has approval state; legacy blind migration is no longer allowed.`);
  }
  if (!cast.candidateGeneratorContextId) throw new Error(`${cast.name} is missing its original candidate generator context.`);
  const byLabel = new Map(cast.candidates.map((candidate) => [candidate.blindLabel.toUpperCase(), candidate]));
  const allRequested = [...requestedLabels, ...retiredLabels];
  if (new Set(allRequested).size !== allRequested.length || allRequested.some((label) => !/^[A-Z]$/u.test(label))) {
    throw new Error("Candidate migration labels must be unique A-Z labels.");
  }
  const labeledCandidates = cast.candidates.filter((candidate) => candidate.blindLabel);
  if (new Set(labeledCandidates.map((candidate) => candidate.blindLabel.toUpperCase())).size !== labeledCandidates.length) {
    throw new Error("Published workflow candidate labels must be unique before migration.");
  }
  if (labeledCandidates.some((candidate) => !allRequested.includes(candidate.blindLabel.toUpperCase()))) {
    throw new Error("Every published workflow candidate must be explicitly included or retired during migration.");
  }
  if (allRequested.some((label) => !byLabel.has(label))) throw new Error("Every included or retired label must exist in the workflow.");
  const active = requestedLabels.map((label) => byLabel.get(label));
  if (active.some((candidate) => candidate.status !== "generated" || !candidate.assetFile || !candidate.variationAxis)) {
    throw new Error("Every included candidate must be generated and retain its source asset and variationAxis.");
  }
  const canvasRoot = resolve(canvasDir);
  for (const candidate of active) {
    const source = resolve(candidate.assetFile);
    const rel = relative(canvasRoot, source);
    if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
      throw new Error(`Legacy candidate source must be stored inside canvas/: ${candidate.blindLabel}`);
    }
  }
  const sourceRows = await Promise.all(active.map(async (candidate) => ({
    label: candidate.blindLabel.toUpperCase(),
    id: candidate.id,
    variationAxis: candidate.variationAxis,
    assetFile: resolve(candidate.assetFile),
    assetSha256: await characterAssetSha256(candidate.assetFile),
  })));
  if (new Set(sourceRows.map((row) => row.assetSha256)).size !== sourceRows.length) {
    throw new Error("Legacy candidate migration refuses duplicate image bytes under different labels.");
  }
  const rootDir = join(canvasDir, "character-candidate-blind", workflow.id, cast.id);
  const priorPublicPath = cast.blindCandidateSet?.publicPath || join(rootDir, "judge-packet.json");
  const priorPrivatePath = cast.candidates.find((candidate) => candidate.blindPrivateMappingPath)?.blindPrivateMappingPath || join(rootDir, "private-mapping.json");
  const readOptionalJson = async (path) => {
    try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  };
  const [priorPublic, priorPrivate] = await Promise.all([readOptionalJson(priorPublicPath), readOptionalJson(priorPrivatePath)]);
  const [priorPublicPacketSha256, priorPrivateMappingSha256] = await Promise.all([
    priorPublic ? characterAssetSha256(priorPublicPath) : "",
    priorPrivate ? characterAssetSha256(priorPrivatePath) : "",
  ]);
  const oldIdByLabel = new Map((priorPrivate?.mapping || []).map((entry) => [nonEmptyString(entry.label).toUpperCase(), nonEmptyString(entry.id)]));
  const mappingConflicts = sourceRows.filter((row) => oldIdByLabel.has(row.label) && oldIdByLabel.get(row.label) !== row.id).map((row) => ({
    label: row.label,
    priorCandidateId: oldIdByLabel.get(row.label),
    publishedCandidateId: row.id,
  }));
  const packageResult = await writePreservedBlindCandidatePackage(sourceRows.map((row) => ({
    label: row.label,
    id: row.id,
    variationAxis: row.variationAxis,
    artifact: row.assetFile,
    artifactSha256: row.assetSha256,
    provider: workflow.model,
    source: "legacy-published-candidate",
  })), {
    rootDir,
    artifactDir: join(canvasDir, "assets", `blind-${slugPart(workflow.id, "workflow")}-${slugPart(cast.id, "cast")}`),
  });
  const publicByLabel = new Map(packageResult.publicPacket.candidates.map((entry) => [entry.label, entry]));
  const sourceFingerprint = new Map(sourceRows.map((row) => [row.id, `${row.assetFile}:${row.assetSha256}`]));
  for (const row of sourceRows) {
    if (await characterAssetSha256(row.assetFile) !== row.assetSha256) {
      throw new Error(`${cast.name} candidate bytes changed during migration; retry from a fresh workflow read.`);
    }
  }
  const migrated = await updateCharacterWorkflow(args, workflowId, (current) => {
    const currentCast = findWorkflowCast(current, cast.id);
    if (!currentCast || currentCast.selectedCandidateId || currentCast.approval || currentCast.candidateReviewPath) {
      throw new Error(`${cast.name} approval state changed during migration; workflow was not updated.`);
    }
    for (const candidate of currentCast.candidates) {
      if (!sourceFingerprint.has(candidate.id)) continue;
      const sourceRow = sourceRows.find((row) => row.id === candidate.id);
      if (!sourceRow || resolve(candidate.assetFile) !== sourceRow.assetFile) {
        throw new Error(`${cast.name} candidate source changed during migration; retry from a fresh workflow read.`);
      }
    }
    current.cast = current.cast.map((entry) => entry.id !== cast.id ? entry : {
      ...entry,
      status: "awaiting-approval",
      blindCandidateSet: publicBlindCandidateSummary(packageResult),
      candidateReviewPath: "",
      candidates: entry.candidates.map((candidate) => {
        const label = candidate.blindLabel.toUpperCase();
        if (retiredLabels.includes(label)) return {
          ...candidate,
          status: "rejected",
          candidateSetId: "",
          blindArtifactFile: "",
          blindArtifactSha256: "",
          blindPublicPacketPath: "",
          blindPrivateMappingPath: "",
        };
        if (!requestedLabels.includes(label)) return candidate;
        const publicRow = publicByLabel.get(label);
        return {
          ...candidate,
          status: "generated",
          candidateSetId: packageResult.setId,
          blindArtifactFile: publicRow.artifactRef,
          blindArtifactSha256: publicRow.artifactSha256,
          blindPublicPacketPath: packageResult.publicPath,
          blindPrivateMappingPath: packageResult.privatePath,
        };
      }),
    });
    return current;
  });
  const migratedCast = findWorkflowCast(migrated, cast.id);
  const draft = await prepareCandidateDiversityReviewDraft({
    ...args,
    workflow: migrated,
    cast: migratedCast,
    generatorContextId: migratedCast.candidateGeneratorContextId,
  });
  const finalized = await updateCharacterWorkflow(args, workflowId, (current) => {
    current.cast = current.cast.map((entry) => entry.id === cast.id ? { ...entry, candidateReviewDraftPath: draft.path } : entry);
    return current;
  });
  const reportPath = join(rootDir, "legacy-migration-report.json");
  await writeJsonAtomic(reportPath, {
    version: "koya-character-candidate-blind-migration-v1",
    workflowId: workflow.id,
    castId: cast.id,
    castName: cast.name,
    migratedAt: new Date().toISOString(),
    migrationReason,
    generatorHost,
    generatorId,
    generatorContextId,
    originalCandidateGeneratorContextId: cast.candidateGeneratorContextId,
    priorPublicPacketSha256,
    priorPrivateMappingSha256,
    priorSetId: nonEmptyString(priorPublic?.setId),
    mappingConflicts,
    activeLabels: requestedLabels,
    retiredLabels,
    newSetId: packageResult.setId,
    candidates: sourceRows.map((row) => ({ ...row, blindArtifactFile: publicByLabel.get(row.label).artifactRef, blindArtifactSha256: publicByLabel.get(row.label).artifactSha256 })),
    reviewDraftPath: draft.path,
    approvalStatus: "pending-independent-review",
  });
  return {
    version: "koya-character-candidate-blind-migration-v1",
    workflowId,
    castId: cast.id,
    castName: cast.name,
    candidateSetId: packageResult.setId,
    activeLabels: requestedLabels,
    retiredLabels,
    mappingConflicts,
    reviewDraftPath: draft.path,
    reportPath,
    workflow: finalized,
  };
}

function pathInsideDirectory(root, value, label) {
  const absolute = resolve(nonEmptyString(value));
  const rel = relative(resolve(root), absolute);
  if (!nonEmptyString(value) || rel === "" || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error(`${label} must be stored inside ${resolve(root)}.`);
  }
  return absolute;
}

function validCandidateImageBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 1024) return false;
  const hex = buffer.subarray(0, 12).toString("hex");
  return hex.startsWith("89504e470d0a1a0a") || hex.startsWith("ffd8ff") || (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP");
}

export async function importCharacterCandidateRebuild(args = {}) {
  const workflowId = nonEmptyString(args.workflowId ?? args.workflow_id);
  const castId = nonEmptyString(args.castId ?? args.cast_id);
  const importMapValue = nonEmptyString(args.candidateImportMapPath ?? args.candidate_import_map_path);
  const generatorHost = nonEmptyString(args.generatorHost ?? args.generator_host);
  const generatorId = nonEmptyString(args.generatorId ?? args.generator_id);
  const generatorContextId = nonEmptyString(args.generatorContextId ?? args.generator_context_id);
  if (!workflowId || !castId || !importMapValue) throw new Error("workflowId, castId, and candidateImportMapPath are required for candidate rebuild import.");
  if (!generatorHost || !generatorId || !generatorContextId) throw new Error("Candidate rebuild import requires generatorHost, generatorId, and generatorContextId provenance.");
  const canvasDir = resolveCanvasDir(args);
  const projectDir = resolve(args.projectDir || process.cwd());
  const importMapPath = pathInsideDirectory(canvasDir, importMapValue, "Candidate import map");
  const importMap = JSON.parse(await readFile(importMapPath, "utf8"));
  if (importMap.version !== CHARACTER_CANDIDATE_IMPORT_VERSION) throw new Error(`Candidate import map must use ${CHARACTER_CANDIDATE_IMPORT_VERSION}.`);
  const sourceManifestValue = nonEmptyString(importMap.sourceManifestPath);
  const specValue = nonEmptyString(importMap.specPath ?? args.candidateRebuildSpecPath ?? args.candidate_rebuild_spec_path);
  if (!sourceManifestValue || !specValue) throw new Error("Candidate import map requires sourceManifestPath and specPath.");
  const sourceManifestPath = pathInsideDirectory(canvasDir, isAbsolute(sourceManifestValue) ? sourceManifestValue : resolve(dirname(importMapPath), sourceManifestValue), "Candidate source manifest");
  const specPath = resolve(specValue);
  const specRel = relative(projectDir, specPath);
  if (specRel === "" || specRel === ".." || specRel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(specRel)) throw new Error("Candidate rebuild spec must be stored inside the project.");
  const [sourceManifest, spec, sourceManifestSha256, importMapSha256, specSha256] = await Promise.all([
    readFile(sourceManifestPath, "utf8").then((value) => JSON.parse(value)),
    readFile(specPath, "utf8").then((value) => JSON.parse(value)),
    characterAssetSha256(sourceManifestPath),
    characterAssetSha256(importMapPath),
    characterAssetSha256(specPath),
  ]);
  if (sourceManifest.version !== CHARACTER_CANDIDATE_SOURCE_MANIFEST_VERSION) throw new Error(`Candidate source manifest must use ${CHARACTER_CANDIDATE_SOURCE_MANIFEST_VERSION}.`);
  if (spec.version !== CHARACTER_CANDIDATE_REBUILD_SPEC_VERSION) throw new Error(`Candidate rebuild spec must use ${CHARACTER_CANDIDATE_REBUILD_SPEC_VERSION}.`);
  const characterId = nonEmptyString(importMap.characterId);
  if (!characterId || characterId !== nonEmptyString(spec.characterId)) throw new Error("Candidate import map and rebuild spec characterId must match.");
  if (nonEmptyString(sourceManifest?.generator?.host) !== generatorHost
    || nonEmptyString(sourceManifest?.generator?.id) !== generatorId
    || nonEmptyString(sourceManifest?.generator?.contextId) !== generatorContextId
    || !nonEmptyString(sourceManifest?.generator?.model)) throw new Error("Candidate source manifest generator provenance does not match the import invocation.");
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(nonEmptyString(sourceManifest.generatedAt)) || !Number.isFinite(Date.parse(sourceManifest.generatedAt))) throw new Error("Candidate source manifest requires a valid generatedAt timestamp.");
  const mapEntries = Array.isArray(importMap.entries) ? importMap.entries : [];
  const declaredCandidates = Array.isArray(spec.candidates) ? spec.candidates : [];
  if (mapEntries.length < 2 || mapEntries.length > 5 || mapEntries.length !== declaredCandidates.length) throw new Error("Candidate import must map every declared rebuild candidate, between two and five options.");
  const labels = mapEntries.map((entry) => nonEmptyString(entry?.candidateLabel).toUpperCase());
  const sourceNames = mapEntries.map((entry) => nonEmptyString(entry?.sourceEntryName));
  if (labels.some((label) => !/^[A-E]$/u.test(label)) || new Set(labels).size !== labels.length) throw new Error("Candidate import labels must be unique A..E values.");
  if (sourceNames.some((name) => !name) || new Set(sourceNames).size !== sourceNames.length) throw new Error("Candidate import source entry names must be non-empty and unique.");
  const sourceEntries = Array.isArray(sourceManifest.entries) ? sourceManifest.entries : [];
  const resolvedImports = [];
  for (const [index, mapping] of mapEntries.entries()) {
    const label = labels[index];
    const declared = declaredCandidates.find((candidate) => nonEmptyString(candidate?.label).toUpperCase() === label);
    if (!declared || !nonEmptyString(declared.axis) || !nonEmptyString(declared.description)) throw new Error(`Candidate rebuild spec is missing a complete ${label} design axis.`);
    const matches = sourceEntries.filter((entry) => nonEmptyString(entry?.name) === sourceNames[index]);
    if (matches.length !== 1) throw new Error(`Candidate source '${sourceNames[index]}' must exist exactly once.`);
    const source = matches[0];
    const outputValue = nonEmptyString(source.output);
    const assetFile = pathInsideDirectory(canvasDir, isAbsolute(outputValue) ? outputValue : resolve(dirname(sourceManifestPath), outputValue), `Candidate ${label} output`);
    const bytes = await readFile(assetFile);
    if (!validCandidateImageBuffer(bytes)) throw new Error(`Candidate ${label} output is not a valid generated raster image.`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== nonEmptyString(source.outputSha256)) throw new Error(`Candidate ${label} output SHA-256 does not match disk.`);
    if (!nonEmptyString(source.prompt)) throw new Error(`Candidate ${label} requires its exact generation prompt.`);
    resolvedImports.push({ label, source, declared, assetFile, sha256 });
  }
  if (new Set(resolvedImports.map((entry) => entry.sha256)).size !== resolvedImports.length) throw new Error("Candidate imports must use distinct image bytes.");

  const evidenceDigest = createHash("sha256").update(`${sourceManifestSha256}\n${importMapSha256}\n${specSha256}`).digest("hex");

  const store = await readCharacterWorkflowStore({ ...args, projectDir, canvasDir });
  const workflow = getCharacterWorkflow(store, workflowId);
  if (!workflow) throw new Error(`Unknown character workflow: ${workflowId}.`);
  const cast = findWorkflowCast(workflow, castId);
  if (!cast) throw new Error(`Unknown workflow character: ${castId}.`);
  const workflowCastId = nonEmptyString(importMap.workflowCastId);
  if (!workflowCastId || workflowCastId !== cast.id) {
    throw new Error("Candidate import map workflowCastId must bind the exact target workflow cast entry.");
  }
  if (cast.approval || cast.selectedCandidateId || cast.stylingSelection || cast.identityPack) throw new Error("Candidate rebuild import cannot replace an already selected or approved identity.");
  if (cast.candidates.length !== resolvedImports.length) throw new Error("Candidate rebuild import currently requires the same candidate count as the existing anonymous packet so no public slot silently disappears.");
  const evidenceDir = join(canvasDir, "character-candidate-imports", slugPart(workflow.id, "workflow"), slugPart(cast.id, "cast"), evidenceDigest.slice(0, 16));
  const evidencePath = join(evidenceDir, "candidate-import-evidence.json");
  let existingEvidence = null;
  try {
    existingEvidence = JSON.parse(await readFile(evidencePath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (existingEvidence && (
    existingEvidence.version !== CHARACTER_CANDIDATE_IMPORT_VERSION
    || existingEvidence.workflowId !== workflow.id
    || existingEvidence.castId !== cast.id
    || nonEmptyString(existingEvidence?.sourceManifest?.sha256) !== sourceManifestSha256
    || nonEmptyString(existingEvidence?.importMap?.sha256) !== importMapSha256
    || nonEmptyString(existingEvidence?.rebuildSpec?.sha256) !== specSha256
  )) {
    throw new Error("Existing candidate import evidence does not match this exact rebuild invocation.");
  }
  const currentByLabel = new Map(cast.candidates.filter((candidate) => candidate.blindLabel).map((candidate) => [candidate.blindLabel, candidate]));
  if (resolvedImports.some((entry) => !currentByLabel.has(entry.label)) && existingEvidence) {
    const byId = new Map(cast.candidates.map((candidate) => [candidate.id, candidate]));
    for (const previous of existingEvidence.previousCandidates || []) {
      const candidate = byId.get(nonEmptyString(previous?.id));
      const label = nonEmptyString(previous?.blindLabel).toUpperCase();
      if (candidate && /^[A-E]$/u.test(label)) currentByLabel.set(label, candidate);
    }
  }
  if (resolvedImports.some((entry) => !currentByLabel.has(entry.label))) throw new Error("Candidate rebuild import labels must match every currently published anonymous label or an exact interrupted-import evidence record.");
  const previousCandidates = existingEvidence?.previousCandidates?.length ? structuredClone(existingEvidence.previousCandidates) : [];
  if (previousCandidates.length === 0) {
    for (const candidate of cast.candidates) {
      previousCandidates.push({
        id: candidate.id,
        index: candidate.index,
        blindLabel: candidate.blindLabel,
        variationAxis: candidate.variationAxis,
        assetFile: candidate.assetFile,
        assetSha256: candidate.assetFile ? await characterAssetSha256(candidate.assetFile) : "",
        blindArtifactFile: candidate.blindArtifactFile,
        blindArtifactSha256: candidate.blindArtifactSha256,
      });
    }
  }
  await mkdir(evidenceDir, { recursive: true });
  await writeJsonAtomic(evidencePath, {
    version: CHARACTER_CANDIDATE_IMPORT_VERSION,
    workflowId: workflow.id,
    castId: cast.id,
    characterId,
    generator: structuredClone(sourceManifest.generator),
    generatedAt: sourceManifest.generatedAt,
    importedAt: new Date().toISOString(),
    sourceManifest: { path: sourceManifestPath, sha256: sourceManifestSha256 },
    importMap: { path: importMapPath, sha256: importMapSha256 },
    rebuildSpec: { path: specPath, sha256: specSha256 },
    supersededCandidateSetId: cast.blindCandidateSet?.setId || "",
    previousCandidates,
    importedCandidates: resolvedImports.map((entry) => ({ label: entry.label, path: entry.assetFile, sha256: entry.sha256, axis: entry.declared.axis })),
  });
  const jobs = resolvedImports.map((entry) => {
    const previous = currentByLabel.get(entry.label);
    return {
      prompt: entry.source.prompt,
      model: sourceManifest.generator.model,
      aspectRatio: workflow.aspectRatio,
      imageSize: workflow.imageSize,
      quality: workflow.quality,
      referenceImagePaths: [],
      fileName: basename(entry.assetFile),
      customData: { buzzassistCharacterCandidate: true, buzzassistCharacterCandidateImport: true },
      pipeline: {
        castId: cast.id,
        candidateId: previous.id,
        candidateIndex: previous.index,
        candidateLabel: entry.label,
        variationAxis: `${entry.declared.axis}: ${entry.declared.description}`,
      },
    };
  });
  await markCharacterCandidatesGenerating({ ...args, projectDir, canvasDir }, workflow.id, jobs);
  let updated = await recordCharacterCandidateResults({
    ...args,
    projectDir,
    canvasDir,
    generatorContextId,
    preserveBlindLabels: true,
  }, workflow.id, jobs, resolvedImports.map((entry) => ({ assetFile: entry.assetFile })));
  const evidenceSha256 = await characterAssetSha256(evidencePath);
  updated = await updateCharacterWorkflow({ ...args, projectDir, canvasDir }, workflow.id, (current) => {
    current.cast = current.cast.map((entry) => entry.id === cast.id ? {
      ...entry,
      candidateImportEvidencePath: evidencePath,
      candidateImportEvidenceSha256: evidenceSha256,
    } : entry);
    return current;
  });
  const importedCast = findWorkflowCast(updated, cast.id);
  const refreshed = await prepareCandidateDiversityReviewDraft({
    ...args,
    projectDir,
    canvasDir,
    workflow: updated,
    cast: importedCast,
    generatorContextId,
  });
  updated = await updateCharacterWorkflow({ ...args, projectDir, canvasDir }, workflow.id, (current) => {
    current.cast = current.cast.map((entry) => entry.id === cast.id ? { ...entry, candidateReviewDraftPath: refreshed.path } : entry);
    return current;
  });
  return { workflow: updated, cast: findWorkflowCast(updated, cast.id), evidencePath, evidenceSha256, reviewDraftPath: refreshed.path };
}

export function findWorkflowCast(workflow, castIdOrName) {
  const requested = nonEmptyString(castIdOrName);
  const normalized = normalizedName(requested);
  return workflow.cast.find((cast) =>
    cast.id === requested ||
    normalizedName(cast.name) === normalized ||
    cast.aliases.some((alias) => normalizedName(alias) === normalized),
  ) ?? null;
}

export function findWorkflowCandidate(cast, candidateIdOrIndex) {
  const requested = nonEmptyString(candidateIdOrIndex);
  const numeric = Number(candidateIdOrIndex);
  return cast.candidates.find((candidate) =>
    candidate.id === requested ||
    candidate.blindLabel === requested.toUpperCase() ||
    (Number.isFinite(numeric) && candidate.index === Math.round(numeric)),
  ) ?? null;
}

export function findStylingVariationRound(cast, roundId) {
  const requested = nonEmptyString(roundId);
  return (cast?.stylingVariationRounds || []).find((round) => round.id === requested) ?? null;
}

function normalizeStylingVariationSpec(value) {
  const source = value && typeof value === "object" ? value : {};
  if (source.version !== "koya-character-styling-spec-v1") throw new Error("Styling spec must use koya-character-styling-spec-v1.");
  const kind = nonEmptyString(source.kind);
  if (!["hairstyle", "hairColor", "outfit", "bodyBuild", "designRefinement"].includes(kind)) {
    throw new Error("Styling variation kind must be hairstyle, hairColor, outfit, bodyBuild, or designRefinement.");
  }
  const options = (Array.isArray(source.options) ? source.options : []).map((entry, index) => {
    const option = normalizeStylingVariationOption(entry, index);
    if (!option.description) throw new Error(`Styling option ${option.id} requires a description.`);
    return { ...option, status: "pending", prompt: "", assetFile: "", assetUrl: "", elementId: "", frameElementId: "", sha256: "", error: "" };
  });
  if (options.length < 2) throw new Error("At least two independently generated styling options are required.");
  const ids = new Set(options.map((option) => option.id));
  if (ids.size !== options.length) throw new Error("Styling option ids must be unique.");
  const descriptions = new Set(options.map((option) => option.description.normalize("NFKC").replace(/\s+/gu, "").toLowerCase()));
  if (descriptions.size !== options.length) throw new Error("Styling option descriptions must define genuinely different options; duplicate take descriptions are forbidden.");
  return {
    kind,
    sharedInvariants: stringList(source.sharedInvariants, 50),
    comparisonEvidenceRequired: source.comparisonEvidenceRequired === true,
    comparisonRequirements: stringList(source.comparisonRequirements, 20),
    minimumPassingCandidates: clampInteger(
      source.minimumPassingCandidates,
      1,
      options.length,
      Math.min(3, options.length),
    ),
    options,
  };
}

export function validateCharacterStylingSpec(value) {
  const normalized = normalizeStylingVariationSpec(value);
  const characterId = nonEmptyString(value?.characterId);
  if (!characterId) throw new Error("Styling spec characterId is required.");
  if (normalized.comparisonEvidenceRequired && normalized.comparisonRequirements.length === 0) throw new Error("A styling spec that requires comparison evidence must define comparisonRequirements.");
  return { pass: true, characterId, kind: normalized.kind, optionCount: normalized.options.length, minimumPassingCandidates: normalized.minimumPassingCandidates, comparisonEvidenceRequired: normalized.comparisonEvidenceRequired };
}

function stylingChangeBoundary(kind) {
  if (kind === "hairColor") return "Change ONLY the hair color. Preserve the exact hair silhouette, part, bangs, length, tie position, clothing, accessories, face, age and body.";
  if (kind === "hairstyle") return "Change ONLY the requested hairstyle details. Preserve the exact face, age, body, skin tone, clothing, accessories and approved hair color unless this option explicitly says otherwise.";
  if (kind === "outfit") return "Change ONLY the requested clothing and footwear. Preserve the exact face, age, body proportions, skin tone, hair color, hair silhouette and identity accessories.";
  if (kind === "bodyBuild") return "Change ONLY the requested body-build or posture adjustment. Preserve the exact face, age, markings, hair, clothing colors and identity accessories.";
  return "Apply ONLY the explicitly written refinement requirements. Preserve every identity trait and every visual attribute not named in those requirements; do not invent additional redesigns.";
}

const ACTIVE_STYLING_ROUND_STATUSES = new Set(["planned", "generating", "awaiting-review", "reviewed", "awaiting-selection"]);

function assertStylingRoundBaseIsCurrent(cast, round) {
  const current = cast?.stylingSelection;
  if (!current) return;
  if (current.baseCandidateId !== round.baseCandidateId || current.sha256 !== round.baseAssetSha256) {
    throw new Error("Styling round is stale: its base is not the character's current human-selected styling asset. Rebuild this round from the latest selection.");
  }
}

export async function buildCharacterStylingVariationJobs(workflow, castSelector, baseCandidateSelector, specInput, options = {}) {
  const cast = findWorkflowCast(workflow, castSelector);
  if (!cast) throw new Error(`Unknown workflow character: ${castSelector}.`);
  const activeRound = cast.stylingVariationRounds.find((round) => ACTIVE_STYLING_ROUND_STATUSES.has(round.status));
  const requestedRoundId = nonEmptyString(options.roundId ?? options.round_id);
  if (activeRound && (!requestedRoundId || activeRound.id !== requestedRoundId)) {
    throw new Error(`Finish or resume the active styling round ${activeRound.id}; pass that exact roundId to resume it without regenerating completed options.`);
  }
  if (activeRound && !["planned", "generating", "awaiting-review"].includes(activeRound.status)) {
    throw new Error(`Styling round ${activeRound.id} is already ${activeRound.status}; generation cannot resume after review has started.`);
  }
  const baseCandidate = findWorkflowCandidate(cast, baseCandidateSelector);
  if (!baseCandidate?.assetFile) throw new Error(`Styling base candidate has no generated asset: ${baseCandidateSelector}.`);
  const candidate = effectiveCharacterIdentityCandidate(cast, baseCandidate);
  const selectionReason = nonEmptyString(options.selectionReason ?? options.selection_reason);
  if (selectionReason.length < 4) throw new Error("selectionReason must record why the human selected this base candidate.");
  const generatorHost = nonEmptyString(options.generatorHost ?? options.generator_host);
  const generatorId = nonEmptyString(options.generatorId ?? options.generator_id);
  const generatorContextId = nonEmptyString(options.generatorContextId ?? options.generator_context_id);
  if (!generatorHost || !generatorId || !generatorContextId) throw new Error("generatorHost, generatorId, and generatorContextId are required for independent styling review provenance.");
  const spec = normalizeStylingVariationSpec(specInput);
  if (spec.comparisonEvidenceRequired && spec.comparisonRequirements.length === 0) throw new Error("comparisonRequirements are required when comparisonEvidenceRequired is true.");
  const now = new Date().toISOString();
  const roundId = requestedRoundId || `styling-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const baseAssetSha256 = await characterAssetSha256(candidate.assetFile);
  if (cast.stylingSelection && cast.stylingSelection.sha256 !== baseAssetSha256) {
    throw new Error("The current human-selected styling asset bytes changed; do not branch a new styling round from mutated evidence.");
  }
  const comparisonReferencePaths = stringList(
    Array.isArray(options.comparisonReferencePaths)
      ? options.comparisonReferencePaths
      : nonEmptyString(options.comparisonReferencePaths ?? options.comparison_reference_paths).split(","),
    8,
  ).map((path) => resolve(path));
  if (spec.comparisonEvidenceRequired && comparisonReferencePaths.length === 0) {
    throw new Error("This styling spec requires comparisonReferencePaths for SHA-bound independent QA; comparison references are not sent to the image generator.");
  }
  const canvasDir = resolveCanvasDir(options);
  const comparisonReferences = [];
  for (const [index, path] of comparisonReferencePaths.entries()) {
    const rel = relative(canvasDir, path);
    if (rel === "" || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
      throw new Error(`Styling comparison reference must be stored inside canvas/: ${path}`);
    }
    const referenceSha256 = await characterAssetSha256(path);
    if (referenceSha256 === baseAssetSha256) throw new Error("A styling exclusion/comparison reference cannot reuse the base identity bytes.");
    comparisonReferences.push({ id: `comparison-${index + 1}`, path, sha256: referenceSha256 });
  }
  if (new Set(comparisonReferences.map((entry) => entry.sha256)).size !== comparisonReferences.length) throw new Error("Styling comparison references must have distinct SHA-256 values.");
  const repairSourcePath = nonEmptyString(options.repairSourcePath ?? options.repair_source_path);
  let repairSource = null;
  if (repairSourcePath) {
    const path = resolve(repairSourcePath);
    const rel = relative(canvasDir, path);
    if (rel === "" || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
      throw new Error(`Styling repair source must be stored inside canvas/: ${path}`);
    }
    const sha256 = await characterAssetSha256(path);
    const sourceMatch = cast.stylingVariationRounds.flatMap((round) => round.options.map((option) => ({ round, option })))
      .find(({ round, option }) => round.id !== roundId
        && ["passed", "selected"].includes(option.status)
        && resolve(option.assetFile) === path
        && option.sha256 === sha256);
    if (!sourceMatch) throw new Error("Styling repair source must be a SHA-matching option that passed an earlier independent styling review for the same character.");
    if (sha256 === baseAssetSha256) throw new Error("Styling repair source must be distinct from the base identity bytes.");
    repairSource = { path, sha256, roundId: sourceMatch.round.id, optionId: sourceMatch.option.id };
  }
  const model = nonEmptyString(options.model) || workflow.model;
  const aspectRatio = nonEmptyString(options.aspectRatio ?? options.aspect_ratio) || workflow.aspectRatio;
  const imageSize = nonEmptyString(options.imageSize ?? options.image_size) || workflow.imageSize;
  const quality = nonEmptyString(options.quality) || workflow.quality;
  const commonPrompt = [
    `Create ONE fully developed 2D Japanese manga STYLING OPTION CHARACTER SHEET for ${cast.name}.`,
    "Reference image 1 is the human-selected BASE IDENTITY. Preserve the exact same person: facial construction, face contour, eyes, eyebrows, nose, mouth placement, ears, age, body build, skin tone and posture grammar.",
    "This output is one independent production-quality character sheet, NOT a comparison sheet and NOT a row of alternate people.",
    "On a pure white 16:9 canvas, show exactly one front-facing full-body neutral identity view plus exactly three head studies: front, gentle 3/4, and strict profile. Preserve the base subject's natural anatomy and stance: humans stand naturally; non-human animals use a species-appropriate four-legged stance or seated identity pose and must never be anthropomorphized. Every view must depict the same identity and the same option.",
    stylingChangeBoundary(spec.kind),
    repairSource
      ? "Reference image 2 is a previously independently PASSED styling sheet for this same identity. Use it only as positive styling guidance: preserve its compliant length boundary, low crown, restrained outer silhouette and identity continuity. Do not copy its exact option; create the separately declared option below. Reference image 1 remains the authority for face, body and clothing."
      : "",
    spec.sharedInvariants.length > 0 ? `Shared non-negotiable requirements: ${spec.sharedInvariants.join("; ")}.` : "",
    repairSource
      ? "The base identity image, the SHA-bound passed repair source, and this styling spec are the only design authorities. Ignore and do not restore superseded traits from earlier character descriptions or prompts."
      : "The base identity image plus this styling spec are the only design authorities. Ignore and do not restore superseded traits from earlier character descriptions or prompts.",
    "No other people, no alternate option, no inset material swatches, no labels, no Japanese text, no captions, no logo, no watermark and no UI. Labels are added later by deterministic composition.",
    workflow.channelStylePrompt,
    buildChannelVisualStylePrompt(workflow.visualProfile, {
      prompt: "approved character identity styling sheet",
      styleTags: ["character", "styling-variation", spec.kind],
    }, 0),
  ].filter(Boolean).join("\n");
  const specPath = nonEmptyString(options.specPath ?? options.spec_path);
  const specSha256 = nonEmptyString(options.specSha256 ?? options.spec_sha256);
  const specCharacterId = nonEmptyString(options.specCharacterId ?? options.spec_character_id);
  const jobs = spec.options.map((option, index) => {
    const prompt = [
      commonPrompt,
      `OPTION ${index + 1} (${option.id}): ${option.description}`,
      option.invariants.length > 0 ? `Option-specific invariants: ${option.invariants.join("; ")}.` : "",
      "Do not redesign the identity. If a requested style conflicts with identity preservation, preserve identity and render the closest safe styling interpretation.",
    ].filter(Boolean).join("\n");
    const generationInputSha256 = createHash("sha256").update(JSON.stringify({
      prompt,
      model,
      aspectRatio,
      imageSize,
      quality,
      baseAssetFile: candidate.assetFile,
      baseAssetSha256,
      repairSource,
      specPath,
      specSha256,
      specCharacterId,
      stylingRoundId: roundId,
      stylingOptionId: option.id,
    })).digest("hex");
    return {
      prompt,
      model,
      aspectRatio,
      imageSize,
      quality,
      referenceImagePaths: [candidate.assetFile, ...(repairSource ? [repairSource.path] : [])],
      fileName: `${slugPart(cast.id)}-styling-${slugPart(roundId, "round")}-${slugPart(option.id, `option-${index + 1}`)}.png`,
      customData: {
        buzzassistCharacterStylingVariation: true,
        buzzassistCharacterWorkflowId: workflow.id,
        buzzassistCharacterCastId: cast.id,
        buzzassistCharacterCandidateId: candidate.id,
        buzzassistCharacterStylingRoundId: roundId,
        buzzassistCharacterStylingOptionId: option.id,
        buzzassistCharacterStylingKind: spec.kind,
        buzzassistCharacterIdentitySourceSha256: baseAssetSha256,
        buzzassistCharacterApprovalStatus: "pending",
      },
      pipeline: { castId: cast.id, candidateId: candidate.id, stylingRoundId: roundId, stylingOptionId: option.id, generationInputSha256 },
    };
  });
  const round = normalizeStylingVariationRound({
    id: roundId,
    kind: spec.kind,
    status: "planned",
    baseCandidateId: baseCandidate.id,
    baseCandidateLabel: baseCandidate.blindLabel,
    baseAssetFile: candidate.assetFile,
    baseAssetSha256,
    specPath,
    specSha256,
    specCharacterId,
    importEvidence: options.importEvidence,
    selectionReason,
    selectedBy: nonEmptyString(options.selectedBy ?? options.selected_by) || "human-user",
    sharedInvariants: spec.sharedInvariants,
    comparisonEvidenceRequired: spec.comparisonEvidenceRequired,
    comparisonRequirements: spec.comparisonRequirements,
    comparisonReferences,
    repairSource,
    minimumPassingCandidates: spec.minimumPassingCandidates,
    generatorHost,
    generatorId,
    generatorContextId,
    options: spec.options.map((option, index) => ({
      ...option,
      prompt: jobs[index].prompt,
      generationInputSha256: jobs[index].pipeline.generationInputSha256,
    })),
    createdAt: now,
    updatedAt: now,
  }, 0);
  if (activeRound) {
    const activeSignature = JSON.stringify({
      kind: activeRound.kind,
      baseCandidateId: activeRound.baseCandidateId,
      baseAssetFile: activeRound.baseAssetFile,
      baseAssetSha256: activeRound.baseAssetSha256,
      specPath: activeRound.specPath,
      specSha256: activeRound.specSha256,
      specCharacterId: activeRound.specCharacterId,
      importEvidence: activeRound.importEvidence,
      repairSource: activeRound.repairSource,
      generatorHost: activeRound.generatorHost,
      generatorId: activeRound.generatorId,
      generatorContextId: activeRound.generatorContextId,
      options: activeRound.options.map((option) => [option.id, option.generationInputSha256]),
    });
    const plannedSignature = JSON.stringify({
      kind: round.kind,
      baseCandidateId: round.baseCandidateId,
      baseAssetFile: round.baseAssetFile,
      baseAssetSha256: round.baseAssetSha256,
      specPath: round.specPath,
      specSha256: round.specSha256,
      specCharacterId: round.specCharacterId,
      importEvidence: round.importEvidence,
      repairSource: round.repairSource,
      generatorHost: round.generatorHost,
      generatorId: round.generatorId,
      generatorContextId: round.generatorContextId,
      options: round.options.map((option) => [option.id, option.generationInputSha256]),
    });
    if (activeSignature !== plannedSignature) {
      throw new Error(`Styling round ${roundId} cannot resume because its identity, spec, generator provenance, or generation inputs changed.`);
    }
    return { round: activeRound, jobs, cast, candidate, resumed: true };
  }
  return { round, jobs, cast, candidate, resumed: false };
}

export async function markCharacterStylingVariationsGenerating(args = {}, workflowId, round) {
  return updateCharacterWorkflow(args, workflowId, (workflow) => {
    const castId = nonEmptyString(args.castId ?? args.cast_id);
    const target = findWorkflowCast(workflow, castId);
    if (!target) throw new Error(`Unknown workflow character: ${castId}.`);
    assertStylingRoundBaseIsCurrent(target, round);
    const supersedeRoundId = nonEmptyString(args.supersedeStylingRoundId ?? args.supersede_styling_round_id);
    const supersededRound = supersedeRoundId ? findStylingVariationRound(target, supersedeRoundId) : null;
    if (supersedeRoundId) {
      if (!supersededRound || supersededRound.id === round.id) throw new Error("Styling consolidation requires a distinct existing round to supersede.");
      if (supersededRound.status !== "awaiting-selection" || supersededRound.selectedOptionId) {
        throw new Error(`Styling round ${supersedeRoundId} can be superseded only while awaiting an unmade human selection.`);
      }
      if (supersededRound.options.length < 2 || !supersededRound.options.every((option) => option.status === "passed" && option.assetFile && option.sha256)) {
        throw new Error(`Styling round ${supersedeRoundId} can be superseded only after every option independently passed with SHA-bound evidence.`);
      }
      if (target.stylingSelection) throw new Error("A styling round cannot be superseded after a human styling selection exists.");
    }
    const conflictingRound = target.stylingVariationRounds.find((entry) => entry.id !== round.id
      && entry.id !== supersedeRoundId
      && ACTIVE_STYLING_ROUND_STATUSES.has(entry.status));
    if (conflictingRound) throw new Error(`Finish or fail the active styling round ${conflictingRound.id} before starting ${round.id}.`);
    const existingRound = findStylingVariationRound(target, round.id);
    if (existingRound) {
      const existingInputs = existingRound.options.map((option) => [option.id, option.generationInputSha256]);
      const requestedInputs = round.options.map((option) => [option.id, option.generationInputSha256]);
      if (JSON.stringify(existingInputs) !== JSON.stringify(requestedInputs)
        || existingRound.baseAssetSha256 !== round.baseAssetSha256
        || existingRound.specSha256 !== round.specSha256) {
        throw new Error(`Styling round ${round.id} cannot be resumed with different generation inputs.`);
      }
    }
    const nextRound = normalizeStylingVariationRound({
      ...(existingRound || round),
      status: existingRound?.options.every((option) => option.status === "generated") ? "awaiting-review" : "generating",
      options: round.options.map((option) => {
        const existingOption = existingRound?.options.find((entry) => entry.id === option.id);
        if (existingOption?.status === "generated") return existingOption;
        return { ...option, status: "generating", sha256: "", error: "" };
      }),
      updatedAt: new Date().toISOString(),
    }, target.stylingVariationRounds.length);
    const supersededAt = new Date().toISOString();
    workflow.cast = workflow.cast.map((cast) => cast.id === target.id
      ? {
        ...cast,
        stylingVariationRounds: [
          ...cast.stylingVariationRounds
            .filter((entry) => entry.id !== nextRound.id)
            .map((entry) => entry.id === supersedeRoundId ? normalizeStylingVariationRound({
              ...entry,
              status: "superseded",
              supersededByRoundId: nextRound.id,
              supersededAt,
              supersedeReason: round.selectionReason,
              updatedAt: supersededAt,
            }, 0) : entry),
          nextRound,
        ],
      }
      : cast);
    return workflow;
  });
}

export async function checkpointCharacterStylingVariationResult(args = {}, workflowId, roundId, job, result = {}) {
  const optionId = nonEmptyString(job?.pipeline?.stylingOptionId);
  const generationInputSha256 = nonEmptyString(job?.pipeline?.generationInputSha256);
  if (!optionId || !generationInputSha256) throw new Error("Styling checkpoint requires a job option id and generation input SHA-256.");
  const assetFile = nonEmptyString(result.assetFile);
  const error = nonEmptyString(result.error || (!assetFile ? "Generation returned no asset file." : ""));
  const sha256 = error ? "" : await characterAssetSha256(assetFile);
  return updateCharacterWorkflow(args, workflowId, (workflow) => {
    const castId = nonEmptyString(args.castId ?? args.cast_id ?? job?.pipeline?.castId);
    const target = findWorkflowCast(workflow, castId);
    if (!target) throw new Error(`Unknown workflow character: ${castId}.`);
    const round = findStylingVariationRound(target, roundId);
    if (!round) throw new Error(`Unknown styling variation round: ${roundId}.`);
    const current = round.options.find((option) => option.id === optionId);
    if (!current) throw new Error(`Unknown styling option: ${optionId}.`);
    if (current.generationInputSha256 !== generationInputSha256) {
      throw new Error(`Styling option ${optionId} input changed; refusing a stale generation checkpoint.`);
    }
    if (current.assetFile && assetFile && resolve(current.assetFile) !== resolve(assetFile)) {
      throw new Error(`Styling option ${optionId} checkpoint path changed; refusing to replace evidence.`);
    }
    if (current.status === "generated" && (current.sha256 !== sha256 || resolve(current.assetFile) !== resolve(assetFile))) {
      throw new Error(`Styling option ${optionId} already has a different immutable generated checkpoint.`);
    }
    const nextOptions = round.options.map((option) => option.id === optionId ? {
      ...option,
      status: error ? "failed" : "generated",
      assetFile,
      assetUrl: nonEmptyString(result.assetUrl),
      elementId: nonEmptyString(result.elementId),
      frameElementId: nonEmptyString(result.frameElementId),
      sha256,
      error,
    } : option);
    const unfinished = nextOptions.some((option) => ["pending", "generating"].includes(option.status));
    const nextStatus = unfinished ? "generating" : nextOptions.some((option) => option.status === "generated") ? "awaiting-review" : "failed";
    const nextRound = { ...round, status: nextStatus, options: nextOptions, updatedAt: new Date().toISOString() };
    workflow.cast = workflow.cast.map((entry) => entry.id === target.id ? {
      ...entry,
      stylingVariationRounds: entry.stylingVariationRounds.map((item) => item.id === round.id ? nextRound : item),
    } : entry);
    return workflow;
  });
}

function stylingReviewRoot(args, workflowId, castId, roundId) {
  return join(resolveCanvasDir(args), "character-styling-reviews", slugPart(workflowId, "workflow"), slugPart(castId, "cast"), slugPart(roundId, "round"));
}

async function measureStylingColorAxis(options) {
  const payload = {
    normalizedRegion: [...STYLING_COLOR_REGION_NORMALIZED],
    minimumDeltaE76: MIN_STYLING_COLOR_DELTA_E76,
    entries: options.map((option) => ({ id: option.id, path: option.assetFile })),
  };
  const { stdout } = await execFile("python3", [STYLING_COLOR_MEASUREMENT_SCRIPT, JSON.stringify(payload)], { maxBuffer: 8 * 1024 * 1024 });
  const measurement = JSON.parse(stdout);
  if (measurement?.error) throw new Error(`Styling hair-color measurement failed: ${measurement.error}`);
  return measurement;
}

async function writeStylingReviewDraft(args, workflow, cast, round) {
  const root = stylingReviewRoot(args, workflow.id, cast.id, round.id);
  const path = join(root, "styling-review.json");
  await mkdir(root, { recursive: true });
  const generatedOptions = round.options.filter((option) => option.status === "generated");
  let machineAxisMeasurement = null;
  if (round.kind === "hairColor") machineAxisMeasurement = await measureStylingColorAxis(generatedOptions);
  const review = {
    version: CHARACTER_STYLING_REVIEW_VERSION,
    phase: "styling-variation",
    workflowId: workflow.id,
    castId: cast.id,
    roundId: round.id,
    kind: round.kind,
    generatorContextId: round.generatorContextId,
    generator: { host: round.generatorHost, id: round.generatorId, contextId: round.generatorContextId },
    reviewer: { host: "", id: "", contextId: "", reviewedAt: "" },
    originalScaleInspected: false,
    baseAsset: { path: round.baseAssetFile, sha256: round.baseAssetSha256 },
    stylingSpec: { path: round.specPath, sha256: round.specSha256, characterId: round.specCharacterId },
    importEvidence: round.importEvidence,
    comparisonEvidenceRequired: round.comparisonEvidenceRequired,
    comparisonRequirements: round.comparisonRequirements,
    comparisonReferences: round.comparisonReferences,
    minimumPassingCandidates: round.minimumPassingCandidates,
    machineAxisMeasurement,
    candidates: generatedOptions.map((option) => ({
      id: option.id,
      label: option.label,
      path: option.assetFile,
      sha256: option.sha256,
      generationInputSha256: option.generationInputSha256,
      sameIdentity: false,
      ageConsistent: false,
      faceContourConsistent: false,
      eyesConsistent: false,
      browsConsistent: false,
      bodyBuildConsistent: false,
      unchangedTraitsPreserved: false,
      requestedVariationSatisfied: false,
      noUnrequestedAccessories: false,
      originalScaleInspected: false,
      requirementChecks: [...round.sharedInvariants, ...option.invariants].map((requirement) => ({ requirement, pass: false, note: "" })),
      comparisonReferenceChecks: round.comparisonReferences.map((reference) => ({
        id: reference.id,
        path: reference.path,
        sha256: reference.sha256,
        distinctFromReference: false,
        originalScaleInspected: false,
        requirementChecks: round.comparisonRequirements.map((requirement) => ({ requirement, pass: false, note: "" })),
        note: "",
      })),
      pass: false,
      note: "",
    })),
    pairChecks: generatedOptions.flatMap((left, leftIndex) => generatedOptions.slice(leftIndex + 1).map((right) => ({
      pairId: [left.id, right.id].sort().join("::"),
      optionIds: [left.id, right.id].sort(),
      machineAxisDistance: machineAxisMeasurement?.pairChecks?.find((pair) => pair.pairId === [left.id, right.id].sort().join("::")) || null,
      requestedAxisVisiblyDistinct: false,
      notDuplicateTake: false,
      identityStillSamePerson: false,
      unrequestedTraitsRemainMatched: false,
      originalScaleInspected: false,
      pass: false,
      note: "",
    }))),
    pass: false,
    note: "",
  };
  await writeJsonAtomic(path, review);
  return { path, review };
}

export async function refreshCharacterStylingReviewDraft(args = {}) {
  const workflowId = nonEmptyString(args.workflowId ?? args.workflow_id);
  const castId = nonEmptyString(args.castId ?? args.cast_id);
  const roundId = nonEmptyString(args.roundId ?? args.round_id);
  const store = await readCharacterWorkflowStore(args);
  const workflow = getCharacterWorkflow(store, workflowId);
  if (!workflow) throw new Error(`Unknown character workflow: ${workflowId}.`);
  const cast = findWorkflowCast(workflow, castId);
  if (!cast) throw new Error(`Unknown workflow character: ${castId}.`);
  const round = findStylingVariationRound(cast, roundId);
  if (!round || round.status !== "awaiting-review") throw new Error("Styling review draft can be refreshed only while the exact round awaits review.");
  if (!round.options.every((option) => option.status === "generated" && option.assetFile && option.sha256)) throw new Error("Styling review refresh requires every option to have generated SHA-bound bytes.");
  const draft = await writeStylingReviewDraft(args, workflow, cast, round);
  const updated = await updateCharacterWorkflow(args, workflow.id, (current) => {
    current.cast = current.cast.map((entry) => entry.id === cast.id ? {
      ...entry,
      stylingVariationRounds: entry.stylingVariationRounds.map((item) => item.id === round.id ? { ...item, reviewDraftPath: draft.path } : item),
    } : entry);
    return current;
  });
  return { workflow: updated, cast: findWorkflowCast(updated, cast.id), round: findStylingVariationRound(findWorkflowCast(updated, cast.id), round.id), reviewDraftPath: draft.path, machineAxisMeasurement: draft.review.machineAxisMeasurement };
}

export async function recordCharacterStylingVariationResults(args = {}, workflowId, roundId, jobs = [], results = []) {
  let updated = await updateCharacterWorkflow(args, workflowId, (workflow) => {
    const castId = nonEmptyString(args.castId ?? args.cast_id ?? jobs[0]?.pipeline?.castId);
    const target = findWorkflowCast(workflow, castId);
    if (!target) throw new Error(`Unknown workflow character: ${castId}.`);
    const round = findStylingVariationRound(target, roundId);
    if (!round) throw new Error(`Unknown styling variation round: ${roundId}.`);
    const resultById = new Map();
    jobs.forEach((job, index) => resultById.set(job.pipeline?.stylingOptionId, results[index] || {}));
    const nextOptions = round.options.map((option) => {
      const result = resultById.get(option.id);
      if (!result) return option;
      return {
        ...option,
        status: result.error || !result.assetFile ? "failed" : "generated",
        assetFile: nonEmptyString(result.assetFile),
        assetUrl: nonEmptyString(result.assetUrl),
        elementId: nonEmptyString(result.elementId),
        frameElementId: nonEmptyString(result.frameElementId),
        error: nonEmptyString(result.error || (!result.assetFile ? "Generation returned no asset file." : "")),
      };
    });
    const unfinished = nextOptions.some((option) => ["pending", "generating"].includes(option.status));
    const nextStatus = unfinished ? "generating" : nextOptions.some((option) => option.status === "generated") ? "awaiting-review" : "failed";
    const nextRound = { ...round, status: nextStatus, options: nextOptions, updatedAt: new Date().toISOString() };
    workflow.cast = workflow.cast.map((cast) => cast.id === target.id
      ? { ...cast, stylingVariationRounds: cast.stylingVariationRounds.map((entry) => entry.id === round.id ? nextRound : entry) }
      : cast);
    return workflow;
  });
  const castId = nonEmptyString(args.castId ?? args.cast_id ?? jobs[0]?.pipeline?.castId);
  let cast = findWorkflowCast(updated, castId);
  let round = findStylingVariationRound(cast, roundId);
  const hashedOptions = [];
  for (const option of round.options) hashedOptions.push(option.status === "generated" ? { ...option, sha256: await characterAssetSha256(option.assetFile) } : option);
  updated = await updateCharacterWorkflow(args, workflowId, (workflow) => {
    workflow.cast = workflow.cast.map((entry) => entry.id === cast.id ? {
      ...entry,
      stylingVariationRounds: entry.stylingVariationRounds.map((item) => item.id === round.id ? { ...item, options: hashedOptions } : item),
    } : entry);
    return workflow;
  });
  cast = findWorkflowCast(updated, cast.id);
  round = findStylingVariationRound(cast, round.id);
  const draft = await writeStylingReviewDraft(args, updated, cast, round);
  updated = await updateCharacterWorkflow(args, workflowId, (workflow) => {
    workflow.cast = workflow.cast.map((entry) => entry.id === cast.id ? {
      ...entry,
      stylingVariationRounds: entry.stylingVariationRounds.map((item) => item.id === round.id ? { ...item, reviewDraftPath: draft.path } : item),
    } : entry);
    return workflow;
  });
  return { workflow: updated, cast: findWorkflowCast(updated, cast.id), round: findStylingVariationRound(findWorkflowCast(updated, cast.id), round.id), reviewDraftPath: draft.path };
}

function stylingReviewerFailures(review, round) {
  const failures = [];
  const reviewer = review?.reviewer && typeof review.reviewer === "object" ? review.reviewer : {};
  for (const key of ["host", "id", "contextId", "reviewedAt"]) if (!nonEmptyString(reviewer[key])) failures.push(`reviewer.${key} is required.`);
  if (nonEmptyString(reviewer.reviewedAt) && !(/^\d{4}-\d{2}-\d{2}T/u.test(reviewer.reviewedAt) && Number.isFinite(Date.parse(reviewer.reviewedAt)))) failures.push("reviewer.reviewedAt must be a valid ISO-8601 timestamp.");
  if (nonEmptyString(reviewer.contextId) === nonEmptyString(round.generatorContextId)) failures.push("reviewer.contextId must differ from generatorContextId.");
  if (review?.originalScaleInspected !== true) failures.push("originalScaleInspected must be true.");
  return failures;
}

export async function validateCharacterStylingReview({ reviewPath, workflow, cast, round, allowFailedOutcome = false } = {}) {
  const path = resolve(nonEmptyString(reviewPath));
  if (!nonEmptyString(reviewPath)) throw new Error("Styling review path is required.");
  const review = JSON.parse(await readFile(path, "utf8"));
  const failures = [];
  if (review.version !== CHARACTER_STYLING_REVIEW_VERSION || review.phase !== "styling-variation") failures.push(`Review must use ${CHARACTER_STYLING_REVIEW_VERSION}.`);
  if (review.workflowId !== workflow?.id || review.castId !== cast?.id || review.roundId !== round?.id) failures.push("Review workflowId/castId/roundId does not match the active styling round.");
  if (nonEmptyString(review.generatorContextId) !== nonEmptyString(round?.generatorContextId)) failures.push("generatorContextId does not match the styling generation context.");
  if (nonEmptyString(review?.generator?.host) !== round.generatorHost
    || nonEmptyString(review?.generator?.id) !== round.generatorId
    || nonEmptyString(review?.generator?.contextId) !== round.generatorContextId) failures.push("Review generator provenance does not match the active styling round.");
  failures.push(...stylingReviewerFailures(review, round));
  const actualBaseSha = await characterAssetSha256(round.baseAssetFile);
  if (resolve(nonEmptyString(review?.baseAsset?.path)) !== resolve(round.baseAssetFile) || nonEmptyString(review?.baseAsset?.sha256) !== actualBaseSha || actualBaseSha !== round.baseAssetSha256) {
    failures.push("baseAsset must bind the current human-selected source bytes and SHA-256.");
  }
  if (round.specPath || round.specSha256 || round.specCharacterId) {
    let actualSpecSha256 = "";
    try { actualSpecSha256 = await characterAssetSha256(round.specPath); } catch (error) { failures.push(`Styling spec is unreadable: ${error.message}`); }
    if (resolve(nonEmptyString(review?.stylingSpec?.path)) !== resolve(round.specPath)
      || nonEmptyString(review?.stylingSpec?.sha256) !== round.specSha256
      || actualSpecSha256 !== round.specSha256
      || nonEmptyString(review?.stylingSpec?.characterId) !== round.specCharacterId) {
      failures.push("stylingSpec must bind the exact declared spec path, characterId, and current SHA-256.");
    }
  }
  if (round.importEvidence) {
    const evidence = round.importEvidence;
    let sourceManifestSha256 = "";
    let importMapSha256 = "";
    try { sourceManifestSha256 = await characterAssetSha256(evidence.sourceManifestPath); } catch (error) { failures.push(`Styling import source manifest is unreadable: ${error.message}`); }
    try { importMapSha256 = await characterAssetSha256(evidence.importMapPath); } catch (error) { failures.push(`Styling import map is unreadable: ${error.message}`); }
    const reviewedEvidence = review.importEvidence && typeof review.importEvidence === "object" ? review.importEvidence : {};
    if (evidence.version !== "koya-character-styling-import-v1"
      || sourceManifestSha256 !== evidence.sourceManifestSha256
      || importMapSha256 !== evidence.importMapSha256
      || ["version", "sourceManifestPath", "sourceManifestSha256", "importMapPath", "importMapSha256"].some((key) => nonEmptyString(reviewedEvidence[key]) !== evidence[key])) {
      failures.push("Styling import review must bind the exact legacy source manifest and human-authored import map bytes.");
    }
  } else if (review.importEvidence) {
    failures.push("Native styling generation review must not invent legacy import evidence.");
  }
  if (review.comparisonEvidenceRequired !== round.comparisonEvidenceRequired
    || JSON.stringify(review.comparisonRequirements || []) !== JSON.stringify(round.comparisonRequirements)
    || !Array.isArray(review.comparisonReferences)
    || review.comparisonReferences.length !== round.comparisonReferences.length) {
    failures.push("Styling comparison evidence contract does not match the active round.");
  }
  for (const reference of round.comparisonReferences) {
    const reviewedReference = (review.comparisonReferences || []).find((entry) => entry?.id === reference.id);
    const actualSha256 = await characterAssetSha256(reference.path);
    if (!reviewedReference || resolve(nonEmptyString(reviewedReference.path)) !== resolve(reference.path) || reviewedReference.sha256 !== actualSha256 || actualSha256 !== reference.sha256) {
      failures.push(`Styling comparison reference ${reference.id} path/SHA-256 does not match current bytes.`);
    }
  }
  const generated = round.options.filter((option) => option.status === "generated" || option.status === "passed" || option.status === "rejected" || option.status === "selected");
  let freshMachineAxisMeasurement = null;
  if (round.kind === "hairColor") {
    try {
      freshMachineAxisMeasurement = await measureStylingColorAxis(generated);
      if (JSON.stringify(review.machineAxisMeasurement || null) !== JSON.stringify(freshMachineAxisMeasurement)) {
        failures.push("Hair-color machine measurement was edited or is stale; refresh the review draft from current image bytes.");
      }
      if (freshMachineAxisMeasurement.pass !== true) {
        const weakPairs = (freshMachineAxisMeasurement.pairChecks || []).filter((pair) => pair.pass !== true).map((pair) => `${pair.pairId} ΔE76=${pair.deltaE76}`);
        failures.push(`Hair-color options do not meet the minimum measured color distance: ${weakPairs.join(", ")}.`);
      }
    } catch (error) {
      failures.push(`Hair-color machine measurement failed: ${error.message}`);
    }
  } else if (review.machineAxisMeasurement) {
    failures.push("Non-color styling review must not contain a hair-color machine measurement.");
  }
  const rows = Array.isArray(review.candidates) ? review.candidates : [];
  if (rows.length !== generated.length) failures.push("review.candidates must cover every generated styling option exactly once.");
  const seen = new Set();
  const passingOptionIds = [];
  for (const option of generated) {
    const row = rows.find((entry) => entry?.id === option.id);
    if (!row || seen.has(option.id)) { failures.push(`Styling option ${option.id} is missing or duplicated.`); continue; }
    seen.add(option.id);
    const actualSha = await characterAssetSha256(option.assetFile);
    if (resolve(nonEmptyString(row.path)) !== resolve(option.assetFile) || nonEmptyString(row.sha256) !== actualSha || actualSha !== option.sha256) failures.push(`Styling option ${option.id} path/SHA-256 does not match current bytes.`);
    if (option.generationInputSha256 && nonEmptyString(row.generationInputSha256) !== option.generationInputSha256) failures.push(`Styling option ${option.id} review does not bind its generation input SHA-256.`);
    const manualKeys = ["sameIdentity", "ageConsistent", "faceContourConsistent", "eyesConsistent", "browsConsistent", "bodyBuildConsistent", "unchangedTraitsPreserved", "requestedVariationSatisfied", "noUnrequestedAccessories", "originalScaleInspected"];
    if (manualKeys.some((key) => typeof row[key] !== "boolean")) failures.push(`Styling option ${option.id} must explicitly judge every identity and requirement axis.`);
    const expectedRequirements = [...round.sharedInvariants, ...option.invariants];
    const checks = Array.isArray(row.requirementChecks) ? row.requirementChecks : [];
    if (checks.length !== expectedRequirements.length) failures.push(`Styling option ${option.id} requirementChecks must cover every written invariant.`);
    for (const requirement of expectedRequirements) {
      const check = checks.find((entry) => entry?.requirement === requirement);
      if (!check || typeof check.pass !== "boolean" || nonEmptyString(check.note).length < 2) failures.push(`Styling option ${option.id} requires an explicit check and note for: ${requirement}`);
    }
    if (nonEmptyString(row.note).length < 4) failures.push(`Styling option ${option.id}.note must record the original-scale judgment.`);
    const calculatedPass = manualKeys.every((key) => row[key] === true) && checks.every((check) => check.pass === true);
    const comparisonChecks = Array.isArray(row.comparisonReferenceChecks) ? row.comparisonReferenceChecks : [];
    if (comparisonChecks.length !== round.comparisonReferences.length) failures.push(`Styling option ${option.id} must review every comparison reference exactly once.`);
    let comparisonPass = true;
    for (const reference of round.comparisonReferences) {
      const comparison = comparisonChecks.find((entry) => entry?.id === reference.id);
      const requirementChecks = Array.isArray(comparison?.requirementChecks) ? comparison.requirementChecks : [];
      if (!comparison || resolve(nonEmptyString(comparison.path)) !== resolve(reference.path) || comparison.sha256 !== reference.sha256) {
        failures.push(`Styling option ${option.id} comparison reference ${reference.id} is missing or stale.`);
        comparisonPass = false;
        continue;
      }
      if (comparison.distinctFromReference !== true || comparison.originalScaleInspected !== true || nonEmptyString(comparison.note).length < 4) comparisonPass = false;
      if (requirementChecks.length !== round.comparisonRequirements.length) comparisonPass = false;
      for (const requirement of round.comparisonRequirements) {
        const check = requirementChecks.find((entry) => entry?.requirement === requirement);
        if (!check || check.pass !== true || nonEmptyString(check.note).length < 2) comparisonPass = false;
      }
      if (option.sha256 === reference.sha256) comparisonPass = false;
    }
    if (row.pass === true && !comparisonPass) failures.push(`Styling option ${option.id} cannot pass without SHA-bound original-scale comparison-reference evidence.`);
    if (row.pass === true && !calculatedPass) failures.push(`Styling option ${option.id} cannot pass while an identity or requirement check fails.`);
    if (row.pass === true) passingOptionIds.push(option.id);
  }
  const pairChecks = Array.isArray(review.pairChecks) ? review.pairChecks : [];
  const expectedPairs = generated.flatMap((left, leftIndex) => generated.slice(leftIndex + 1).map((right) => ({
    pairId: [left.id, right.id].sort().join("::"),
    optionIds: [left.id, right.id].sort(),
  })));
  if (pairChecks.length !== expectedPairs.length) failures.push("pairChecks must cover every generated styling option pair exactly once.");
  const seenPairs = new Set();
  const pairKeys = ["requestedAxisVisiblyDistinct", "notDuplicateTake", "identityStillSamePerson", "unrequestedTraitsRemainMatched", "originalScaleInspected"];
  for (const expected of expectedPairs) {
    const pair = pairChecks.find((entry) => entry?.pairId === expected.pairId);
    if (!pair || seenPairs.has(expected.pairId)) {
      failures.push(`Styling pair ${expected.pairId} is missing or duplicated.`);
      continue;
    }
    seenPairs.add(expected.pairId);
    if (JSON.stringify([...(Array.isArray(pair.optionIds) ? pair.optionIds : [])].sort()) !== JSON.stringify(expected.optionIds)) {
      failures.push(`Styling pair ${expected.pairId}.optionIds does not match the reviewed options.`);
    }
    if (round.kind === "hairColor") {
      const measuredPair = freshMachineAxisMeasurement?.pairChecks?.find((entry) => entry.pairId === expected.pairId) || null;
      if (JSON.stringify(pair.machineAxisDistance || null) !== JSON.stringify(measuredPair)) failures.push(`Styling pair ${expected.pairId} machine color distance is missing or stale.`);
      if (measuredPair?.pass !== true) failures.push(`Styling pair ${expected.pairId} cannot pass below ΔE76 ${MIN_STYLING_COLOR_DELTA_E76}.`);
    } else if (pair.machineAxisDistance) {
      failures.push(`Styling pair ${expected.pairId} must not invent a color-distance measurement for ${round.kind}.`);
    }
    if (pairKeys.some((key) => typeof pair[key] !== "boolean") || typeof pair.pass !== "boolean") {
      failures.push(`Styling pair ${expected.pairId} must explicitly judge every comparison axis and pass.`);
    }
    if (nonEmptyString(pair.note).length < 4) failures.push(`Styling pair ${expected.pairId}.note must record the original-scale comparison.`);
    const bothPass = expected.optionIds.every((id) => passingOptionIds.includes(id));
    if (bothPass) {
      const left = generated.find((option) => option.id === expected.optionIds[0]);
      const right = generated.find((option) => option.id === expected.optionIds[1]);
      if (left?.sha256 && left.sha256 === right?.sha256) failures.push(`Styling pair ${expected.pairId} reuses identical bytes; reject or regenerate one option.`);
      if (pair.pass !== true || pairKeys.some((key) => pair[key] !== true)) {
        failures.push(`Passing styling options ${expected.pairId} must be visibly different on the requested axis without identity drift; reject or regenerate the weak option.`);
      }
    }
  }
  const outcomePass = passingOptionIds.length >= round.minimumPassingCandidates;
  if (allowFailedOutcome) {
    if (review.pass !== outcomePass) failures.push(`Styling review.pass must equal the independently reviewed outcome (${outcomePass}); ${passingOptionIds.length}/${round.minimumPassingCandidates} options passed.`);
  } else {
    if (!outcomePass) failures.push(`At least ${round.minimumPassingCandidates} styling options must pass before comparison; only ${passingOptionIds.length} passed.`);
    if (review.pass !== true) failures.push("Styling review.pass must be true after the minimum passing count is met.");
  }
  if (nonEmptyString(review.note).length < 4) failures.push("Styling review.note is required.");
  if (failures.length > 0) throw new Error(`Styling variation review failed:\n- ${failures.join("\n- ")}`);
  return {
    path,
    review,
    pass: outcomePass,
    passingOptionIds,
    rejectedOptionIds: generated.map((option) => option.id).filter((id) => !passingOptionIds.includes(id)),
  };
}

export async function recordFailedCharacterStylingReview(args = {}) {
  const workflowId = nonEmptyString(args.workflowId ?? args.workflow_id);
  const castId = nonEmptyString(args.castId ?? args.cast_id);
  const roundId = nonEmptyString(args.roundId ?? args.round_id);
  const reviewPath = nonEmptyString(args.reviewPath ?? args.review_path);
  if (!workflowId || !castId || !roundId || !reviewPath) throw new Error("workflowId, castId, roundId, and reviewPath are required to record a failed styling review.");
  const store = await readCharacterWorkflowStore(args);
  const workflow = getCharacterWorkflow(store, workflowId);
  if (!workflow) throw new Error(`Unknown character workflow: ${workflowId}.`);
  const cast = findWorkflowCast(workflow, castId);
  if (!cast) throw new Error(`Unknown workflow character: ${castId}.`);
  const round = findStylingVariationRound(cast, roundId);
  if (!round) throw new Error(`Unknown styling variation round: ${roundId}.`);
  if (round.status !== "awaiting-review") throw new Error(`Styling round ${round.id} must be awaiting-review before a failed review can be recorded.`);
  const validated = await validateCharacterStylingReview({ reviewPath, workflow, cast, round, allowFailedOutcome: true });
  if (validated.pass) throw new Error("This styling review reached the minimum passing count; use character-style-compose instead of recording a failure.");
  const updated = await updateCharacterWorkflow(args, workflow.id, (current) => {
    current.cast = current.cast.map((entry) => entry.id === cast.id ? {
      ...entry,
      stylingVariationRounds: entry.stylingVariationRounds.map((item) => item.id === round.id ? {
        ...item,
        status: "failed",
        reviewPath: validated.path,
        options: item.options.map((option) => ({
          ...option,
          status: validated.passingOptionIds.includes(option.id) ? "passed" : "rejected",
        })),
        updatedAt: new Date().toISOString(),
      } : item),
    } : entry);
    return current;
  });
  const updatedCast = findWorkflowCast(updated, cast.id);
  return {
    workflow: updated,
    cast: updatedCast,
    round: findStylingVariationRound(updatedCast, round.id),
    reviewPath: validated.path,
    passingOptionIds: validated.passingOptionIds,
    rejectedOptionIds: validated.rejectedOptionIds,
  };
}

function escapeXml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function imageMime(path) {
  const extension = extname(path).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  return "image/png";
}

async function composePreReviewQaSheet({ title, note, entries, root, fileStem, manifestBase }) {
  if (!Array.isArray(entries) || entries.length < 2) throw new Error("Pre-review QA sheet requires at least two images.");
  const columns = entries.length === 3 ? 3 : 2;
  const cardWidth = 820;
  const cardHeight = 610;
  const margin = 42;
  const headerHeight = 145;
  const rows = Math.ceil(entries.length / columns);
  const width = margin * 2 + columns * cardWidth;
  const height = headerHeight + margin + rows * cardHeight + margin;
  const cards = [];
  const manifestEntries = [];
  for (const [index, entry] of entries.entries()) {
    const path = resolve(nonEmptyString(entry.path));
    const bytes = await readFile(path);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (nonEmptyString(entry.sha256) && nonEmptyString(entry.sha256) !== sha256) throw new Error(`QA sheet source SHA-256 changed: ${entry.label}`);
    const data = `data:${imageMime(path)};base64,${bytes.toString("base64")}`;
    const x = margin + (index % columns) * cardWidth;
    const y = headerHeight + margin + Math.floor(index / columns) * cardHeight;
    const reference = entry.kind === "comparison-reference";
    cards.push(`<g transform="translate(${x} ${y})"><rect width="${cardWidth - 22}" height="${cardHeight - 22}" rx="16" fill="#fff" stroke="${reference ? "#b42318" : "#202020"}" stroke-width="${reference ? 5 : 3}"/><text x="24" y="39" font-family="sans-serif" font-size="25" font-weight="700" fill="${reference ? "#b42318" : "#111"}">${escapeXml(entry.label)}</text><text x="24" y="66" font-family="monospace" font-size="14" fill="#555">SHA-256 ${escapeXml(sha256.slice(0, 16))}…</text><image x="20" y="80" width="${cardWidth - 62}" height="${cardHeight - 128}" preserveAspectRatio="xMidYMid meet" href="${data}"/></g>`);
    manifestEntries.push({ kind: reference ? "comparison-reference" : "candidate", label: entry.label, optionId: nonEmptyString(entry.optionId), path, sha256 });
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#f4f1eb"/><rect x="0" y="0" width="100%" height="108" fill="#7a271a"/><text x="${margin}" y="46" font-family="sans-serif" font-size="34" font-weight="700" fill="#fff">${escapeXml(title)}</text><text x="${margin}" y="82" font-family="sans-serif" font-size="24" font-weight="700" fill="#ffe2dd">未承認・原寸QA用（採用や合格を示す資料ではありません）</text><text x="${margin}" y="132" font-family="sans-serif" font-size="19" fill="#333">${escapeXml(note)}</text>${cards.join("")}</svg>`;
  await mkdir(root, { recursive: true });
  const sheetPath = join(root, `${fileStem}.svg`);
  const manifestPath = join(root, `${fileStem}.manifest.json`);
  await writeFile(sheetPath, svg, "utf8");
  const manifest = {
    version: "koya-pre-review-original-scale-comparison-v1",
    ...manifestBase,
    sheetPath,
    sheetSha256: await characterAssetSha256(sheetPath),
    entries: manifestEntries,
    createdAt: new Date().toISOString(),
    authoritativeApproval: false,
  };
  await writeJsonAtomic(manifestPath, manifest);
  return { sheetPath, manifestPath, manifest };
}

export async function composeCharacterCandidateQaSheet(args = {}) {
  const workflowId = nonEmptyString(args.workflowId ?? args.workflow_id);
  const castId = nonEmptyString(args.castId ?? args.cast_id);
  const store = await readCharacterWorkflowStore(args);
  const workflow = getCharacterWorkflow(store, workflowId);
  if (!workflow) throw new Error(`Unknown character workflow: ${workflowId}.`);
  const cast = findWorkflowCast(workflow, castId);
  if (!cast) throw new Error(`Unknown workflow character: ${castId}.`);
  const candidates = cast.candidates
    .filter((candidate) => candidate.status === "generated" && candidate.blindLabel && candidate.blindArtifactFile && candidate.blindArtifactSha256)
    .sort((left, right) => left.blindLabel.localeCompare(right.blindLabel));
  const root = join(resolveCanvasDir(args), "character-reviews", slugPart(workflow.id, "workflow"), slugPart(cast.id, "cast"), "candidates");
  return composePreReviewQaSheet({
    title: `${cast.name}｜匿名デザイン候補`,
    note: "A/B/Cを横並びで比較。生成順・モデル・設計軸は伏せ、顔型・目眉・髪外形・体格を原画像でも確認してください。",
    entries: candidates.map((candidate) => ({ label: `候補 ${candidate.blindLabel}`, path: candidate.blindArtifactFile, sha256: candidate.blindArtifactSha256 })),
    root,
    fileStem: "pre-review-candidate-comparison",
    manifestBase: { workflowId: workflow.id, castId: cast.id, phase: "candidate-diversity", generatorContextId: cast.candidateGeneratorContextId },
  });
}

export async function composeCharacterStylingQaSheet(args = {}) {
  const workflowId = nonEmptyString(args.workflowId ?? args.workflow_id);
  const castId = nonEmptyString(args.castId ?? args.cast_id);
  const roundId = nonEmptyString(args.roundId ?? args.round_id);
  const store = await readCharacterWorkflowStore(args);
  const workflow = getCharacterWorkflow(store, workflowId);
  if (!workflow) throw new Error(`Unknown character workflow: ${workflowId}.`);
  const cast = findWorkflowCast(workflow, castId);
  if (!cast) throw new Error(`Unknown workflow character: ${castId}.`);
  const round = findStylingVariationRound(cast, roundId);
  if (!round) throw new Error(`Unknown styling variation round: ${roundId}.`);
  const options = round.options.filter((option) => option.status === "generated" && option.assetFile && option.sha256);
  const references = round.comparisonReferences.map((reference, index) => ({
    kind: "comparison-reference",
    label: `QA除外参照 ${index + 1}（似せない）`,
    path: reference.path,
    sha256: reference.sha256,
  }));
  const root = stylingReviewRoot(args, workflow.id, cast.id, round.id);
  return composePreReviewQaSheet({
    title: `${cast.name}｜${round.kind} 修正候補`,
    note: references.length > 0 ? "候補同士の差と同一人物性を確認。赤枠は生成参照ではなく、非類似性だけを判定するQA除外参照です。" : "候補同士の差と同一人物性を確認し、各原画像を100%表示でも検査してください。",
    entries: [
      ...options.map((option, index) => ({ label: `${index + 1}. ${option.label}`, optionId: option.id, path: option.assetFile, sha256: option.sha256 })),
      ...references,
    ],
    root,
    fileStem: "pre-review-original-scale-comparison",
    manifestBase: { workflowId: workflow.id, castId: cast.id, roundId: round.id, phase: "styling-variation", generatorContextId: round.generatorContextId },
  });
}

export async function composeCharacterStylingReviewSheet(args = {}) {
  const workflowId = nonEmptyString(args.workflowId ?? args.workflow_id);
  const castId = nonEmptyString(args.castId ?? args.cast_id);
  const roundId = nonEmptyString(args.roundId ?? args.round_id);
  const store = await readCharacterWorkflowStore(args);
  const workflow = getCharacterWorkflow(store, workflowId);
  if (!workflow) throw new Error(`Unknown character workflow: ${workflowId}.`);
  const cast = findWorkflowCast(workflow, castId);
  if (!cast) throw new Error(`Unknown workflow character: ${castId}.`);
  const round = findStylingVariationRound(cast, roundId);
  if (!round) throw new Error(`Unknown styling variation round: ${roundId}.`);
  const validated = await validateCharacterStylingReview({ reviewPath: args.reviewPath ?? args.review_path, workflow, cast, round });
  const passing = round.options.filter((option) => validated.passingOptionIds.includes(option.id));
  const columns = Math.min(2, passing.length);
  const cardWidth = 920;
  const cardHeight = 610;
  const margin = 48;
  const headerHeight = 120;
  const rows = Math.ceil(passing.length / columns);
  const width = margin * 2 + columns * cardWidth;
  const height = headerHeight + margin + rows * cardHeight + margin;
  const cards = [];
  for (const [index, option] of passing.entries()) {
    const bytes = await readFile(option.assetFile);
    const data = `data:${imageMime(option.assetFile)};base64,${bytes.toString("base64")}`;
    const x = margin + (index % columns) * cardWidth;
    const y = headerHeight + margin + Math.floor(index / columns) * cardHeight;
    cards.push(`<g transform="translate(${x} ${y})"><rect width="${cardWidth - 24}" height="${cardHeight - 24}" rx="18" fill="#fff" stroke="#222" stroke-width="3"/><text x="28" y="42" font-family="sans-serif" font-size="27" font-weight="700">${escapeXml(`${index + 1}. ${option.label}`)}</text><image x="24" y="62" width="${cardWidth - 72}" height="${cardHeight - 116}" preserveAspectRatio="xMidYMid meet" href="${data}"/></g>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#f4f1eb"/><text x="${margin}" y="52" font-family="sans-serif" font-size="34" font-weight="700">${escapeXml(`${cast.name}｜${round.kind} 微調整候補`)}</text><text x="${margin}" y="91" font-family="sans-serif" font-size="20" fill="#444">各候補は独立生成・原寸QA済み。番号は比較表示用で画像本体には含まれません。</text>${cards.join("")}</svg>`;
  const root = stylingReviewRoot(args, workflow.id, cast.id, round.id);
  const sheetPath = join(root, "passing-options-comparison.svg");
  const manifestPath = join(root, "passing-options-comparison.manifest.json");
  await mkdir(root, { recursive: true });
  await writeFile(sheetPath, svg, "utf8");
  const manifest = {
    version: "koya-styling-comparison-manifest-v1",
    workflowId: workflow.id,
    castId: cast.id,
    roundId: round.id,
    kind: round.kind,
    reviewPath: validated.path,
    reviewSha256: await characterAssetSha256(validated.path),
    baseAssetSha256: round.baseAssetSha256,
    sheetPath,
    sheetSha256: await characterAssetSha256(sheetPath),
    candidates: passing.map((option, index) => ({ displayNumber: index + 1, optionId: option.id, label: option.label, path: option.assetFile, sha256: option.sha256 })),
    createdAt: new Date().toISOString(),
  };
  await writeJsonAtomic(manifestPath, manifest);
  const updated = await updateCharacterWorkflow(args, workflow.id, (current) => {
    current.cast = current.cast.map((entry) => entry.id === cast.id ? {
      ...entry,
      stylingVariationRounds: entry.stylingVariationRounds.map((item) => item.id === round.id ? {
        ...item,
        status: "awaiting-selection",
        reviewPath: validated.path,
        comparisonSheetPath: sheetPath,
        comparisonManifestPath: manifestPath,
        options: item.options.map((option) => ({ ...option, status: validated.passingOptionIds.includes(option.id) ? "passed" : option.status === "failed" ? "failed" : "rejected" })),
      } : item),
    } : entry);
    return current;
  });
  return { workflow: updated, cast: findWorkflowCast(updated, cast.id), round: findStylingVariationRound(findWorkflowCast(updated, cast.id), round.id), sheetPath, manifestPath, manifest };
}

export async function selectCharacterStylingVariation(args = {}) {
  const workflowId = nonEmptyString(args.workflowId ?? args.workflow_id);
  const castId = nonEmptyString(args.castId ?? args.cast_id);
  const roundId = nonEmptyString(args.roundId ?? args.round_id);
  const optionId = nonEmptyString(args.optionId ?? args.option_id);
  const reason = nonEmptyString(args.reason ?? args.selectionReason ?? args.selection_reason);
  if (reason.length < 4) throw new Error("A human selection reason is required.");
  const store = await readCharacterWorkflowStore(args);
  const storedWorkflow = getCharacterWorkflow(store, workflowId);
  if (!storedWorkflow) throw new Error(`Unknown character workflow: ${workflowId}.`);
  const storedCast = findWorkflowCast(storedWorkflow, castId);
  if (!storedCast) throw new Error(`Unknown workflow character: ${castId}.`);
  const storedRound = findStylingVariationRound(storedCast, roundId);
  if (!storedRound || storedRound.status !== "awaiting-selection" || !storedRound.comparisonManifestPath) throw new Error("Styling round must pass review and comparison composition before selection.");
  assertStylingRoundBaseIsCurrent(storedCast, storedRound);
  const validated = await validateCharacterStylingReview({ reviewPath: storedRound.reviewPath, workflow: storedWorkflow, cast: storedCast, round: storedRound });
  if (!validated.passingOptionIds.includes(optionId)) throw new Error(`Styling option ${optionId} is not an eligible passing option.`);
  const manifest = JSON.parse(await readFile(storedRound.comparisonManifestPath, "utf8"));
  const manifestOption = (manifest.candidates || []).find((entry) => entry.optionId === optionId);
  if (!manifestOption) throw new Error(`Styling option ${optionId} is absent from the SHA-bound comparison manifest.`);
  if (manifest.sheetSha256 !== await characterAssetSha256(manifest.sheetPath)) throw new Error("Styling comparison sheet bytes changed after review.");
  return updateCharacterWorkflow(args, workflowId, (workflow) => {
    const cast = findWorkflowCast(workflow, castId);
    if (!cast) throw new Error(`Unknown workflow character: ${castId}.`);
    const round = findStylingVariationRound(cast, roundId);
    if (!round || round.status !== "awaiting-selection" || !round.comparisonManifestPath) throw new Error("Styling round must pass review and comparison composition before selection.");
    assertStylingRoundBaseIsCurrent(cast, round);
    const option = round.options.find((entry) => entry.id === optionId);
    if (!option || option.status !== "passed" || !option.assetFile || !option.sha256) throw new Error(`Styling option ${optionId} is not an eligible passing option.`);
    const selectedAt = new Date().toISOString();
    const selection = normalizeStylingSelection({
      roundId: round.id,
      optionId: option.id,
      kind: round.kind,
      baseCandidateId: round.baseCandidateId,
      assetFile: option.assetFile,
      assetUrl: option.assetUrl,
      sha256: option.sha256,
      reviewPath: round.reviewPath,
      comparisonManifestPath: round.comparisonManifestPath,
      specPath: round.specPath,
      specSha256: round.specSha256,
      specCharacterId: round.specCharacterId,
      optionLabel: option.label,
      optionDescription: option.description,
      optionInvariants: option.invariants,
      sharedInvariants: round.sharedInvariants,
      selectedBy: nonEmptyString(args.selectedBy ?? args.selected_by) || "human-user",
      selectedAt,
      reason,
    });
    workflow.cast = workflow.cast.map((entry) => entry.id === cast.id ? {
      ...entry,
      stylingSelection: selection,
      stylingVariationRounds: entry.stylingVariationRounds.map((item) => item.id === round.id ? {
        ...item,
        status: "selected",
        selectedOptionId: option.id,
        options: item.options.map((candidate) => ({ ...candidate, status: candidate.id === option.id ? "selected" : candidate.status })),
      } : item),
    } : entry);
    return workflow;
  });
}

export function effectiveCharacterIdentityCandidate(cast, candidate) {
  const selection = cast?.stylingSelection;
  if (!selection?.assetFile || selection.baseCandidateId !== candidate?.id) return candidate;
  return {
    ...candidate,
    assetFile: selection.assetFile,
    assetUrl: selection.assetUrl,
    variationAxis: [candidate.variationAxis, `Human-selected ${selection.kind} styling option ${selection.optionId}`].filter(Boolean).join(" | "),
    stylingSelection: structuredClone(selection),
  };
}

function publicCanvasAssetUrl(filePath) {
  const normalized = nonEmptyString(filePath).replaceAll("\\", "/");
  const marker = "/assets/";
  const index = normalized.lastIndexOf(marker);
  if (index < 0) return "";
  return `/excalidraw-assets/${normalized.slice(index + marker.length).split("/").map(encodeURIComponent).join("/")}`;
}

export function publicCharacterWorkflow(workflow) {
  if (!workflow || typeof workflow !== "object") return workflow;
  return {
    ...workflow,
    cast: (workflow.cast || []).map((cast) => ({
      ...cast,
      candidates: cast.status === "awaiting-approval"
        ? (cast.candidates || []).filter((candidate) => candidate.blindLabel).map((candidate) => ({
            label: candidate.blindLabel,
            candidateSetId: candidate.candidateSetId,
            status: candidate.status,
            artifactRef: candidate.blindArtifactFile,
            assetUrl: publicCanvasAssetUrl(candidate.blindArtifactFile),
            artifactSha256: candidate.blindArtifactSha256,
          }))
        : (cast.candidates || []).map((candidate) => ({
            label: candidate.blindLabel,
            candidateSetId: candidate.candidateSetId,
            status: candidate.status,
          })),
    })),
  };
}

function identityPackStyleReferences(workflow, cast) {
  // Once a face has been selected, do not place another person's channel
  // reference beside it. The approved text profile carries style; the selected
  // face is the only image identity source for all identity-pack jobs.
  return [];
}

function identityPackTextAuthority(cast, options = {}) {
  const selection = normalizeStylingSelection(cast?.stylingSelection);
  if (!selection) {
    const approvedVariationAxis = nonEmptyString(cast?.approval?.selectedVariationAxis);
    return {
      description: [
        nonEmptyString(cast?.description),
        approvedVariationAxis ? `Human-approved selected design axis: ${approvedVariationAxis}. Preserve every visible selected trait, including declared clothing and accessories.` : "",
      ].filter(Boolean).join(" "),
      invariants: stringList(cast?.invariants, 30),
      negativePrompt: nonEmptyString(cast?.negativePrompt),
    };
  }
  const outfitStageOverride = options.forOutfitStage === true && selection.kind === "outfit";
  return {
    description: [
      `The current human-selected styling asset is the identity authority for ${cast.name}.`,
      !outfitStageOverride && selection.optionDescription ? `Selected ${selection.kind} option '${selection.optionLabel || selection.optionId}': ${selection.optionDescription}` : "",
      outfitStageOverride ? "Preserve the selected person's face, hair, age, build and identity accessories, but use the explicitly requested story-stage outfit instead of the selected default outfit." : "",
      "Do not revert to traits from an earlier candidate description when they differ from reference image 1 or this selected styling record.",
    ].filter(Boolean).join(" "),
    invariants: [...new Set([...selection.sharedInvariants, ...(outfitStageOverride ? [] : selection.optionInvariants)])],
    negativePrompt: "do not restore superseded hair, clothing, body-build, posture, accessory, or color traits from an earlier candidate prompt",
  };
}

export function buildApprovedTurnaroundJob(workflow, cast, candidate, options = {}) {
  if (!candidate?.assetFile) throw new Error(`Candidate ${candidate?.id ?? ""} has no generated asset.`);
  const model = nonEmptyString(options.model) || workflow.model;
  const styleReferences = identityPackStyleReferences(workflow, cast);
  const textAuthority = identityPackTextAuthority(cast);
  const styleStart = 2;
  const styleEnd = 1 + styleReferences.length;
  const prompt = [
    `Create a clean 2D Japanese manga APPROVED CHARACTER TURNAROUND for ${cast.name}.`,
    "Reference image 1 is the selected CHARACTER IDENTITY. Preserve its exact original facial structure, eye shape, eyebrow thickness, nose, jaw, ears, hairline, hairstyle, age, build, skin tone, clothing, and accessories.",
    styleReferences.length > 0
      ? `Reference images ${styleStart}-${styleEnd} are CHANNEL STYLE-ONLY. They control rendering style and visual information density only. Never copy a person or identity from them.`
      : "",
    "Use an exact 4x2 grid on a pure white 16:9 canvas. Row 1, left to right: front, strict left-profile, strict right-profile, and back full-body identity views. CELL 2 LEFT PROFILE: the nose points toward canvas LEFT. CELL 3 RIGHT PROFILE: the nose points toward canvas RIGHT. These two profiles must be horizontally opposite views, never duplicate poses facing the same direction. Preserve the approved subject's natural anatomy and stance in all four views: humans stand naturally; non-human animals use the same species-appropriate four-legged stance or seated pose and must never be anthropomorphized. Row 2, left to right: front head, gentle left 3/4 head looking toward canvas LEFT, gentle right 3/4 head looking toward canvas RIGHT, and strict overhead/top head. The two 3/4 heads must also be opposite directions. Every view must depict the exact same approved identity.",
    "HARD CELL CONTAINMENT: treat every one of the 8 cells as an isolated production asset. Keep every full-body figure, including all hair, hands and both shoe soles, completely inside its top-row cell with at least 8% white clearance from every cell edge. Feet must end well above the horizontal row boundary. Keep every head view completely inside its bottom-row cell with white clearance. No person, body part, shadow, clothing, prop or line may cross a row/column boundary or appear in a neighboring cell.",
    "APPROVED ACCESSORY CONTINUITY: preserve every wearable accessory visible in reference image 1 or named by the human-approved selected design axis in every applicable full-body angle. Render its view-correct front/side/back visibility; never make a shoulder towel, scarf, glasses, headband, jewelry or other approved wearable disappear merely because the camera angle changes. A one-sided shoulder towel or similar asymmetric wearable must stay on the same anatomical side in all views and must remain visible whenever that shoulder, neck edge, or upper back is visible. In a strict far-side profile where the approved shoulder is genuinely fully occluded by the body, do not move or mirror the wearable merely to expose it; adjacent front, opposite-profile, and back views must prove its continuous placement on the correct side. Do not mirror it to the other side. Do not add any accessory that is absent from both authorities.",
    "Use mostly uniform thin contours, a smooth simple face, minimal nose and mouth, broad graphic hair masses, flat pale skin, at most one restrained cel-shadow, broad clothing fills, and very few fold lines.",
    "No material swatches, no garment/fabric/skin/hand/shoe close-ups, no realistic texture, no extra props, no text, no logo, no watermark, no UI.",
    textAuthority.description,
    textAuthority.invariants.length > 0 ? `Must preserve: ${textAuthority.invariants.join("; ")}.` : "",
    textAuthority.negativePrompt ? `Avoid: ${textAuthority.negativePrompt}.` : "",
    cast.stylePrompt,
    workflow.channelStylePrompt,
    buildChannelVisualStylePrompt(workflow.visualProfile, {
      prompt: textAuthority.description,
      styleTags: ["character", "closeup", "turnaround"],
    }, styleReferences.length),
  ].filter(Boolean).join("\n");
  return {
    prompt,
    model,
    aspectRatio: nonEmptyString(options.aspectRatio ?? options.aspect_ratio) || workflow.aspectRatio,
    imageSize: nonEmptyString(options.imageSize ?? options.image_size) || workflow.imageSize,
    quality: nonEmptyString(options.quality) || workflow.quality,
    fileName: `${slugPart(cast.id)}-turnaround.png`,
    referenceImagePaths: [candidate.assetFile, ...styleReferences.map((reference) => reference.path)],
    customData: {
      buzzassistCharacterTurnaroundSheet: true,
      buzzassistCharacterWorkflowId: workflow.id,
      buzzassistCharacterCastId: cast.id,
      buzzassistCharacterCandidateId: candidate.id,
      buzzassistCharacterName: cast.name,
      buzzassistCharacterLabel: `${cast.name}｜採用三面図`,
      buzzassistStyleReferencePaths: styleReferences.map((reference) => reference.path),
    },
    pipeline: { identityRole: "turnaround" },
  };
}

export function buildExpressionSheetJob(workflow, cast, candidate, options = {}) {
  if (!candidate?.assetFile) throw new Error(`Candidate ${candidate?.id ?? ""} has no generated asset.`);
  const model = nonEmptyString(options.model) || workflow.model;
  const styleReferences = identityPackStyleReferences(workflow, cast);
  const textAuthority = identityPackTextAuthority(cast);
  const styleStart = 2;
  const styleEnd = 1 + styleReferences.length;
  const prompt = [
    `Create a high-definition Japanese manga character expression and head-angle reference sheet for ${cast.name}.`,
    "Reference image 1 is the selected CHARACTER IDENTITY. Preserve the exact same facial structure, eye shape, eyebrow thickness, nose, jaw, ears, hairline, hairstyle, age, skin tone, and clothing.",
    styleReferences.length > 0
      ? `Reference images ${styleStart}-${styleEnd} are CHANNEL STYLE-ONLY. They control rendering style and visual information density only. Never copy a person or identity from them.`
      : "",
    "Show a clean 4x3 production grid on a pure white background. Row 1: neutral front, anxious front, shocked front, sad/downward. Row 2: gentle smile left 3/4 looking toward canvas LEFT, strict left profile with the nose pointing canvas LEFT, strict right profile with the nose pointing canvas RIGHT, strict overhead/top view. The left/right views must be opposite directions, never duplicates facing the same way. Row 3 is CAMERA COVERAGE: left-side wide shot, right-side wide shot, elevated/top wide shot, and an eye-level full-body wide shot. Keep the face readable even in the coverage thumbnails.",
    "HARD CELL CONTAINMENT: treat all 12 cells as isolated production assets. Keep the complete head/hair silhouette inside every close-up cell and the complete person inside every coverage cell, with at least 8% white clearance from all cell boundaries. No head, hair, body, clothing, prop, shadow or line may cross a row/column boundary or leak into another cell. Preserve only accessories already present in reference image 1 or named by the human-approved selected design axis; do not invent towels, jewelry, badges or garments.",
    "APPROVED ACCESSORY CONTINUITY: every approved wearable visible in reference image 1 or named by the human-approved selected design axis must remain present wherever that body area is visible, with angle-correct placement. It may be naturally outside a tight head crop, but it must not disappear from a shoulder-visible portrait or any full-body coverage cell. For an approved shoulder towel, keep one continuous towel segment on the same anatomical shoulder/upper back in every shoulder-visible Row 1 or Row 2 portrait and in every Row 3 coverage view; expressions never remove or relocate it.",
    "Every panel must depict the exact same person. No beautification, no age drift, no hairstyle drift, no clothing drift, no added accessories, no text, no logo, no watermark, no UI.",
    textAuthority.description,
    textAuthority.invariants.length > 0 ? `Must preserve: ${textAuthority.invariants.join("; ")}.` : "",
    textAuthority.negativePrompt ? `Avoid: ${textAuthority.negativePrompt}.` : "",
    cast.stylePrompt,
    workflow.channelStylePrompt,
    buildChannelVisualStylePrompt(workflow.visualProfile, {
      prompt: textAuthority.description,
      styleTags: ["character", "closeup", "expression-sheet"],
    }, styleReferences.length),
  ].filter(Boolean).join("\n");
  return {
    prompt,
    model,
    aspectRatio: nonEmptyString(options.aspectRatio ?? options.aspect_ratio) || workflow.aspectRatio,
    imageSize: nonEmptyString(options.imageSize ?? options.image_size) || workflow.imageSize,
    quality: nonEmptyString(options.quality) || workflow.quality,
    fileName: `${slugPart(cast.id)}-expressions.png`,
    referenceImagePaths: [candidate.assetFile, ...styleReferences.map((reference) => reference.path)],
    customData: {
      buzzassistCharacterExpressionSheet: true,
      buzzassistCharacterWorkflowId: workflow.id,
      buzzassistCharacterCastId: cast.id,
      buzzassistCharacterCandidateId: candidate.id,
      buzzassistCharacterName: cast.name,
      buzzassistCharacterLabel: `${cast.name}｜表情・角度シート`,
      buzzassistStyleReferencePaths: styleReferences.map((reference) => reference.path),
    },
    pipeline: { identityRole: "expression" },
  };
}

export function buildOutfitSheetJob(workflow, cast, candidate, outfitStage, options = {}) {
  if (!candidate?.assetFile) throw new Error(`Candidate ${candidate?.id ?? ""} has no generated asset.`);
  const model = nonEmptyString(options.model) || workflow.model;
  const styleReferences = identityPackStyleReferences(workflow, cast);
  const textAuthority = identityPackTextAuthority(cast, { forOutfitStage: true });
  const prompt = [
    `Create a clean 2D Japanese manga OUTFIT CONTINUITY SHEET for ${cast.name}, story stage '${outfitStage.id}'.`,
    "Reference image 1 is the selected CHARACTER IDENTITY. Preserve the exact face, head, hair, age, build, skin tone and accessories; change only the stage-specific clothing described below.",
    styleReferences.length > 0
      ? `Reference images 2-${1 + styleReferences.length} are CHANNEL STYLE-ONLY. Never copy a person or clothing design from them.`
      : "",
    `Required outfit: ${outfitStage.label}. ${outfitStage.description}`,
    outfitStage.invariants.length > 0 ? `Exact garment invariants: ${outfitStage.invariants.join("; ")}.` : "",
    textAuthority.description,
    textAuthority.invariants.length > 0 ? `Identity invariants that do not conflict with the story-stage outfit: ${textAuthority.invariants.join("; ")}.` : "",
    "Show the same person in front, strict side, back and seated 3/4 views on a white 4x1 sheet. Lock material, collar, buttons/fasteners, sleeve length, color blocks, footwear and accessories across all views.",
    "No alternate outfits, no age drift, no face drift, no text, no logo, no watermark, no UI.",
    buildChannelVisualStylePrompt(workflow.visualProfile, {
      prompt: `${textAuthority.description} ${outfitStage.description}`,
      styleTags: ["character", "outfit-sheet"],
    }, styleReferences.length),
  ].filter(Boolean).join("\n");
  return {
    prompt,
    model,
    aspectRatio: nonEmptyString(options.aspectRatio ?? options.aspect_ratio) || workflow.aspectRatio,
    imageSize: nonEmptyString(options.imageSize ?? options.image_size) || workflow.imageSize,
    quality: nonEmptyString(options.quality) || workflow.quality,
    fileName: `${slugPart(cast.id)}-outfit-${slugPart(outfitStage.id, "stage")}.png`,
    referenceImagePaths: [candidate.assetFile, ...styleReferences.map((reference) => reference.path)],
    customData: {
      buzzassistCharacterOutfitSheet: true,
      buzzassistCharacterWorkflowId: workflow.id,
      buzzassistCharacterCastId: cast.id,
      buzzassistCharacterCandidateId: candidate.id,
      buzzassistCharacterStoryStage: outfitStage.id,
      buzzassistStyleReferencePaths: styleReferences.map((reference) => reference.path),
    },
    pipeline: { identityRole: "outfit", storyStage: outfitStage.id },
  };
}

const EYE_OPEN_TRAIT_PATTERN = /itome|closed-arc|slit eyes|droopy slit|narrow droopy|糸目|開眼/iu;

// Characters whose default expression is closed-arc / slit "itome" eyes need an
// explicit 開眼 (eyes-open) differential, because the production scripts use the
// eyes-open moment as a dramatic switch and the standard expression sheet does
// not guarantee that differential.
export function castNeedsEyeOpenVariant(cast) {
  const selection = normalizeStylingSelection(cast?.stylingSelection);
  const haystack = [cast?.description, ...(cast?.invariants ?? []), ...(selection?.sharedInvariants ?? []), ...(selection?.optionInvariants ?? []), cast?.notes].filter(Boolean).join(" ");
  return EYE_OPEN_TRAIT_PATTERN.test(haystack);
}

export function buildEyeOpenVariantJob(workflow, cast, candidate, options = {}) {
  if (!candidate?.assetFile) throw new Error(`Candidate ${candidate?.id ?? ""} has no generated asset.`);
  const model = nonEmptyString(options.model) || workflow.model;
  const styleReferences = identityPackStyleReferences(workflow, cast);
  const textAuthority = identityPackTextAuthority(cast);
  const styleStart = 2;
  const styleEnd = 1 + styleReferences.length;
  const prompt = [
    `Create a clean 2D Japanese manga EYES-OPEN DIFFERENTIAL SHEET (開眼差分) for ${cast.name}.`,
    "Reference image 1 is the selected CHARACTER IDENTITY. Preserve the exact same facial structure, eyebrow thickness, nose, jaw, ears, hairline, hairstyle, age, skin tone, and clothing.",
    styleReferences.length > 0
      ? `Reference images ${styleStart}-${styleEnd} are CHANNEL STYLE-ONLY. They control rendering style and visual information density only. Never copy a person or identity from them.`
      : "",
    "On a pure white 16:9 canvas show a 2x2 grid of the same person. LEFT COLUMN = DEFAULT STATE: the eyes drawn as the character's usual narrow closed-arc slit eyes (top: relaxed front bust-up, bottom: relaxed 3/4 bust-up). RIGHT COLUMN = EYES-OPEN STATE (開眼): the SAME person with both eyes fully open, showing clear irises with a sharp, intense, frightening, dead-serious gaze (top: front bust-up, bottom: 3/4 bust-up). The open eyes must belong to this exact face; keep eyebrows, nose, mouth placement and hair identical between the two columns so the only change is the eyes and the intensity of expression.",
    "No text, no labels, no logo, no watermark, no UI, no extra panels.",
    textAuthority.description,
    textAuthority.invariants.length > 0 ? `Must preserve: ${textAuthority.invariants.join("; ")}.` : "",
    textAuthority.negativePrompt ? `Avoid: ${textAuthority.negativePrompt}.` : "",
    cast.stylePrompt,
    workflow.channelStylePrompt,
    buildChannelVisualStylePrompt(workflow.visualProfile, {
      prompt: textAuthority.description,
      styleTags: ["character", "closeup", "expression-sheet"],
    }, styleReferences.length),
  ].filter(Boolean).join("\n");
  return {
    prompt,
    model,
    aspectRatio: nonEmptyString(options.aspectRatio ?? options.aspect_ratio) || workflow.aspectRatio,
    imageSize: nonEmptyString(options.imageSize ?? options.image_size) || workflow.imageSize,
    quality: nonEmptyString(options.quality) || workflow.quality,
    fileName: `${slugPart(cast.id)}-eyes-open.png`,
    referenceImagePaths: [candidate.assetFile, ...styleReferences.map((reference) => reference.path)],
    customData: {
      buzzassistCharacterEyeOpenSheet: true,
      buzzassistCharacterWorkflowId: workflow.id,
      buzzassistCharacterCastId: cast.id,
      buzzassistCharacterCandidateId: candidate.id,
      buzzassistCharacterName: cast.name,
      buzzassistCharacterLabel: `${cast.name}｜開眼差分`,
      buzzassistStyleReferencePaths: styleReferences.map((reference) => reference.path),
    },
    pipeline: { identityRole: "eye-open" },
  };
}

// Height comparison lineup prompt: all approved characters on one ground line.
// The caller passes the approved identity images as referenceImagePaths in the
// same order as `entries`; `heightNote` carries the channel's relative-height
// rules (e.g. "Horo is the shortest adult; Ibuki and Nodoka are the same height").
export function buildCastLineupPrompt(entries = [], options = {}) {
  const list = entries.map((entry, index) => `${index + 1}. ${entry.name}${entry.heightHint ? ` — ${entry.heightHint}` : ""} (identity = reference image ${index + 1})`);
  return [
    "Create a clean 2D Japanese manga CAST HEIGHT COMPARISON LINEUP on a pure white 16:9 canvas.",
    `Show exactly ${entries.length} characters standing side by side on ONE shared ground line, full body, front-facing, relaxed neutral standing poses, evenly spaced, no overlap, in this left-to-right order:`,
    ...list,
    "Each character's identity comes ONLY from the matching reference image: preserve face, hair, age, build, clothing and accessories exactly. Scale every character so their relative heights follow the height notes; draw faint horizontal guide lines behind them at head-top height to make the height differences readable.",
    nonEmptyString(options.heightNote),
    "Same rendering style for everyone. No text, no numbers, no labels, no logo, no watermark, no background scenery, no props beyond what the references wear.",
    nonEmptyString(options.channelStylePrompt),
  ].filter(Boolean).join("\n");
}

export function buildApprovedIdentityPackJobs(workflow, cast, candidate, options = {}) {
  const jobs = [
    buildApprovedTurnaroundJob(workflow, cast, candidate, options),
    buildExpressionSheetJob(workflow, cast, candidate, options),
  ];
  if (castNeedsEyeOpenVariant(cast)) jobs.push(buildEyeOpenVariantJob(workflow, cast, candidate, options));
  if ((cast.outfitStages || []).length > 1) {
    jobs.push(...cast.outfitStages.map((stage) => buildOutfitSheetJob(workflow, cast, candidate, stage, options)));
  }
  return jobs;
}

export function buildApprovedIdentityPackRepairJobs(workflow, cast, candidate, failedRoles, options = {}) {
  const requested = new Set((Array.isArray(failedRoles) ? failedRoles : []).map(nonEmptyString).filter(Boolean));
  if (requested.size === 0) throw new Error("Identity-pack repair requires at least one independently failed identity role.");
  const repairId = slugPart(options.repairId, "repair");
  const allJobs = buildApprovedIdentityPackJobs(workflow, cast, candidate, options);
  const keyFor = (job) => {
    const role = nonEmptyString(job.pipeline?.identityRole);
    return role === "outfit" ? `outfit:${nonEmptyString(job.pipeline?.storyStage)}` : role;
  };
  const available = new Set(allJobs.map(keyFor));
  const unknown = [...requested].filter((role) => !available.has(role));
  if (unknown.length > 0) throw new Error(`Identity-pack repair review contains unsupported roles: ${unknown.join(", ")}.`);
  return allJobs.filter((job) => requested.has(keyFor(job))).map((job) => {
    const extension = extname(job.fileName) || ".png";
    const stem = basename(job.fileName, extension);
    return {
      ...job,
      fileName: `${stem}-repair-${repairId}${extension}`,
      prompt: [
        job.prompt,
        "REPAIR ROUND: the previous parent sheet failed independent original-scale cell QA. Generate a fresh sheet from reference image 1; do not copy or trace the failed sheet.",
        "The exact grid boundary and white-clearance rules above are hard acceptance constraints. Shrink subjects as needed so every required body/head and every extremity remains fully inside its own cell. A single boundary leak, crop, added accessory or identity drift fails the whole sheet.",
      ].join("\n"),
      pipeline: {
        ...job.pipeline,
        identityRepairId: repairId,
        identityRepairSourceRole: keyFor(job),
      },
    };
  });
}

async function availableDestination(directory, requestedName) {
  const extension = extname(requestedName) || ".png";
  const stem = basename(requestedName, extension);
  let index = 1;
  while (true) {
    const name = index === 1 ? `${stem}${extension}` : `${stem}-${index}${extension}`;
    const path = join(directory, name);
    try {
      await stat(path);
      index += 1;
    } catch (error) {
      if (error?.code === "ENOENT") return path;
      throw error;
    }
  }
}

function registryRelativePath(canvasDir, absolutePath) {
  return relative(canvasDir, absolutePath).split("\\").join("/");
}

export async function stageApprovedCharacterIdentityPack(args = {}) {
  const workflowId = nonEmptyString(args.workflowId ?? args.workflow_id);
  const castId = nonEmptyString(args.castId ?? args.cast_id);
  const candidateId = args.candidateId ?? args.candidate_id;
  const generatorContextId = nonEmptyString(args.generatorContextId ?? args.generator_context_id);
  if (!generatorContextId) throw new Error("generatorContextId is required for independent identity-pack review.");
  const store = await readCharacterWorkflowStore(args);
  const workflow = getCharacterWorkflow(store, workflowId);
  if (!workflow) throw new Error(`Unknown character workflow: ${workflowId}.`);
  const cast = findWorkflowCast(workflow, castId);
  if (!cast) throw new Error(`Unknown workflow character: ${castId}.`);
  const baseCandidate = findWorkflowCandidate(cast, candidateId);
  if (!baseCandidate?.assetFile) throw new Error(`Selected candidate has no generated asset: ${candidateId}.`);
  const candidate = effectiveCharacterIdentityCandidate(cast, baseCandidate);
  const approvalReason = nonEmptyString(args.approvalReason ?? args.approval_reason);
  if (approvalReason.length < 4) throw new Error("approvalReason must explain why this character candidate was selected.");
  const candidateReview = await validateCandidateDiversityReview({
    reviewPath: args.candidateReviewPath ?? args.candidate_review_path,
    workflow,
    cast,
  });
  let stylingReview = null;
  if (cast.stylingSelection) {
    const stylingRound = findStylingVariationRound(cast, cast.stylingSelection.roundId);
    if (!stylingRound || stylingRound.status !== "selected" || stylingRound.selectedOptionId !== cast.stylingSelection.optionId) {
      throw new Error("The selected styling option is not bound to a completed styling variation round.");
    }
    stylingReview = await validateCharacterStylingReview({
      reviewPath: cast.stylingSelection.reviewPath,
      workflow,
      cast,
      round: stylingRound,
    });
    if (!stylingReview.passingOptionIds.includes(cast.stylingSelection.optionId)) {
      throw new Error("The selected styling option did not pass the independent styling review.");
    }
    if (await characterAssetSha256(candidate.assetFile) !== cast.stylingSelection.sha256) {
      throw new Error("The selected styling asset bytes changed after human selection.");
    }
  }
  const jobs = Array.isArray(args.jobs) ? args.jobs : [];
  const results = Array.isArray(args.results) ? args.results : [];
  const byRole = new Map();
  jobs.forEach((job, index) => {
    const result = results[index];
    if (!result?.assetFile || result.error) return;
    const role = nonEmptyString(job.pipeline?.identityRole);
    const rows = byRole.get(role) || [];
    rows.push({ ...normalizeGeneratedAsset(result), storyStage: nonEmptyString(job.pipeline?.storyStage) });
    byRole.set(role, rows);
  });
  const turnaround = byRole.get("turnaround")?.[0];
  const expression = byRole.get("expression")?.[0];
  if (!turnaround?.assetFile || !expression?.assetFile) {
    throw new Error("A real generated turnaround and expression sheet are required before identity QA.");
  }
  if (castNeedsEyeOpenVariant(cast) && !byRole.get("eye-open")?.[0]?.assetFile) {
    throw new Error("This character requires a generated eyes-open differential before identity QA.");
  }
  if ((cast.outfitStages || []).length > 1) {
    const generatedStages = new Set((byRole.get("outfit") || []).map((entry) => entry.storyStage));
    const missingStages = cast.outfitStages.map((entry) => entry.id).filter((id) => !generatedStages.has(id));
    if (missingStages.length > 0) throw new Error(`Missing required outfit sheets for storyStage: ${missingStages.join(", ")}.`);
  }
  const selectedFace = { assetFile: candidate.assetFile, assetUrl: candidate.assetUrl, elementId: candidate.elementId };
  for (const asset of [selectedFace, turnaround, expression, ...(byRole.get("eye-open") || []), ...(byRole.get("outfit") || [])]) {
    asset.sha256 = await characterAssetSha256(asset.assetFile);
  }
  if (selectedFace.sha256 === turnaround.sha256) {
    throw new Error("The generated turnaround is byte-identical to the candidate; candidate substitution is forbidden.");
  }
  const approval = {
    route: "human-best-of-n",
    approvedBy: nonEmptyString(args.approvedBy ?? args.approved_by) || "human-user",
    approvedAt: new Date().toISOString(),
    selectedCandidateId: baseCandidate.id,
    selectedCandidateLabel: nonEmptyString(args.candidateLabel ?? candidate.blindLabel),
    candidateSetId: nonEmptyString(args.candidateSetId ?? candidate.candidateSetId),
    verdictDigest: nonEmptyString(args.verdictDigest),
    selectedVariationAxis: nonEmptyString(candidate.variationAxis),
    reason: approvalReason,
    candidateReviewPath: candidateReview.path,
    stylingReviewPath: stylingReview?.path || "",
    stylingRoundId: cast.stylingSelection?.roundId || "",
    stylingOptionId: cast.stylingSelection?.optionId || "",
  };
  const identityPack = {
    selectedFace,
    turnaround,
    expression,
    eyeOpen: byRole.get("eye-open")?.[0] || null,
    outfitSheets: byRole.get("outfit") || [],
    stylingSelection: cast.stylingSelection || null,
    generatedAt: new Date().toISOString(),
    generatorContextId,
    repairHistory: [
      ...(cast.identityPack?.repairHistory || []),
      ...(args.repairEvidence && typeof args.repairEvidence === "object" ? [{
        repairId: nonEmptyString(args.repairEvidence.repairId),
        failedReviewPath: nonEmptyString(args.repairEvidence.failedReviewPath),
        failedReviewSha256: nonEmptyString(args.repairEvidence.failedReviewSha256),
        failedRoles: stringList(args.repairEvidence.failedRoles, 20),
        generationCheckpointPath: nonEmptyString(args.repairEvidence.generationCheckpointPath),
        generatorContextId,
        repairedAt: new Date().toISOString(),
      }] : []),
    ].slice(-20),
  };
  let updated = await updateCharacterWorkflow(args, workflow.id, (current) => {
    current.cast = current.cast.map((entry) => entry.id === cast.id ? {
      ...entry,
      status: "awaiting-identity-qa",
      selectedCandidateId: baseCandidate.id,
      candidateReviewPath: approval.candidateReviewPath,
      approval,
      identityPack,
      candidates: entry.candidates.map((item) => ({
        ...item,
        status: item.id === baseCandidate.id ? "selected" : item.status === "failed" ? "failed" : "rejected",
      })),
    } : entry);
    current.status = workflowStatusForCast(current.cast);
    return current;
  });
  const updatedCast = findWorkflowCast(updated, cast.id);
  const draft = await prepareIdentityPackReviewDraft({
    ...args,
    workflow: updated,
    cast: updatedCast,
    identityPack: updatedCast.identityPack,
    generatorContextId: identityPack.generatorContextId,
  });
  updated = await updateCharacterWorkflow(args, workflow.id, (current) => {
    current.cast = current.cast.map((entry) => entry.id === cast.id ? { ...entry, identityReviewDraftPath: draft.path } : entry);
    return current;
  });
  return { workflow: updated, cast: findWorkflowCast(updated, cast.id), identityReviewDraftPath: draft.path };
}

export async function finalizeApprovedCharacter(args = {}) {
  const workflowId = nonEmptyString(args.workflowId ?? args.workflow_id);
  const castId = nonEmptyString(args.castId ?? args.cast_id ?? args.characterName);
  const candidateSelector = args.candidateId ?? args.candidate_id ?? args.candidateIndex ?? args.candidate_index;
  const store = await readCharacterWorkflowStore(args);
  const workflow = getCharacterWorkflow(store, workflowId);
  if (!workflow) throw new Error(`Unknown character workflow: ${workflowId}.`);
  const cast = findWorkflowCast(workflow, castId);
  if (!cast) throw new Error(`Unknown workflow character: ${castId}.`);
  const candidate = findWorkflowCandidate(cast, candidateSelector || cast.selectedCandidateId);
  if (!candidate) throw new Error(`Unknown candidate for ${cast.name}: ${candidateSelector}.`);
  if (!nonEmptyString(candidate.variationAxis)) {
    throw new Error(`Candidate ${candidate.id} has no variationAxis; regenerate distinct candidates before approval.`);
  }
  if (!candidate.assetFile) throw new Error(`Candidate ${candidate.id} has no generated asset.`);
  if (cast.status !== "awaiting-identity-qa" || !cast.identityPack?.turnaround?.assetFile || !cast.identityPack?.expression?.assetFile) {
    throw new Error("Character registration requires a staged generated identity pack in awaiting-identity-qa status.");
  }
  const reviewResult = await validateIdentityPackReview({
    reviewPath: args.identityReviewPath ?? args.identity_review_path,
    workflow,
    cast,
    identityPack: cast.identityPack,
  });
  const reviewSha256 = await characterAssetSha256(reviewResult.path);
  const selectedFaceSource = cast.identityPack.selectedFace.assetFile;
  const turnaroundSource = cast.identityPack.turnaround.assetFile;
  const expressionSource = cast.identityPack.expression.assetFile;

  const canvasDir = resolveCanvasDir(args);
  const characterDir = join(canvasDir, "assets", "characters");
  await mkdir(characterDir, { recursive: true });
  const faceDestination = await availableDestination(characterDir, `${slugPart(cast.id)}-selected-face${extname(selectedFaceSource) || ".png"}`);
  const turnaroundDestination = await availableDestination(characterDir, `${slugPart(cast.id)}-turnaround${extname(turnaroundSource) || ".png"}`);
  const expressionsDestination = await availableDestination(characterDir, `${slugPart(cast.id)}-expressions${extname(expressionSource) || ".png"}`);
  await copyFile(resolve(selectedFaceSource), faceDestination);
  await copyFile(resolve(turnaroundSource), turnaroundDestination);
  await copyFile(resolve(expressionSource), expressionsDestination);
  let eyeOpenDestination = "";
  if (nonEmptyString(cast.identityPack.eyeOpen?.assetFile)) {
    eyeOpenDestination = await availableDestination(characterDir, `${slugPart(cast.id)}-eyes-open${extname(cast.identityPack.eyeOpen.assetFile) || ".png"}`);
    await copyFile(resolve(cast.identityPack.eyeOpen.assetFile), eyeOpenDestination);
  }
  const outfitDestinations = [];
  for (const sheet of cast.identityPack.outfitSheets || []) {
    const destination = await availableDestination(characterDir, `${slugPart(cast.id)}-outfit-${slugPart(sheet.storyStage, "stage")}${extname(sheet.assetFile) || ".png"}`);
    await copyFile(resolve(sheet.assetFile), destination);
    outfitDestinations.push({ storyStage: sheet.storyStage, destination });
  }

  const registry = await readCharacterRegistry(args);
  const now = new Date().toISOString();
  const approval = {
    ...cast.approval,
    identityReviewPath: reviewResult.path,
    identityReviewSha256: reviewSha256,
  };
  const referenceRows = [
    { id: "selected-face", role: "identity-face", destination: faceDestination, sha256: cast.identityPack.selectedFace.sha256 },
    { id: "turnaround", role: "turnaround", destination: turnaroundDestination, sha256: cast.identityPack.turnaround.sha256 },
    { id: "expression", role: "expression", destination: expressionsDestination, sha256: cast.identityPack.expression.sha256 },
    ...(eyeOpenDestination ? [{ id: "eye-open", role: "eye-open", destination: eyeOpenDestination, sha256: cast.identityPack.eyeOpen.sha256 }] : []),
    ...outfitDestinations.map((entry) => ({
      id: `outfit-${entry.storyStage}`,
      role: "outfit",
      destination: entry.destination,
      sha256: cast.identityPack.outfitSheets.find((sheet) => sheet.storyStage === entry.storyStage)?.sha256 || "",
      storyStage: entry.storyStage,
    })),
  ];
  const characterEntry = {
    id: cast.id,
    name: cast.name,
    kind: "character",
    role: cast.role,
    status: "approved",
    episodeId: cast.role === "per-video" ? workflow.episodeId : "",
    aliases: cast.aliases,
    description: cast.description,
    invariants: cast.invariants,
    negativePrompt: cast.negativePrompt,
    stylePrompt: [cast.stylePrompt, workflow.channelStylePrompt].filter(Boolean).join(" "),
    voiceId: cast.voiceId,
    referenceImagePaths: referenceRows.map((entry) => registryRelativePath(canvasDir, entry.destination)),
    referenceAssets: referenceRows.map((entry) => ({
      id: entry.id,
      role: entry.role,
      path: registryRelativePath(canvasDir, entry.destination),
      sha256: entry.sha256,
      storyStage: entry.storyStage || "",
      sourceReviewPath: reviewResult.path,
    })),
    sourceWorkflowId: workflow.id,
    sourceCandidateId: candidate.id,
    approval,
    createdAt: registry.characters.find((character) => character.id === cast.id)?.createdAt || now,
    updatedAt: now,
    notes: `Approved from ${workflow.title} only after candidate-diversity and cell-level identity review.`,
  };
  const existingIndex = registry.characters.findIndex((character) => character.id === cast.id);
  if (existingIndex >= 0) registry.characters[existingIndex] = characterEntry;
  else registry.characters.push(characterEntry);
  const writtenRegistry = await writeCharacterRegistry(args, registry);
  const updatedWorkflow = await updateCharacterWorkflow(args, workflow.id, (current) => {
    current.cast = current.cast.map((entry) => entry.id === cast.id
      ? {
          ...entry,
          status: "ready",
          characterId: cast.id,
          selectedCandidateId: candidate.id,
          approval,
          identityReviewPath: reviewResult.path,
          candidates: entry.candidates.map((item) => ({
            ...item,
            status: item.id === candidate.id ? "selected" : item.status === "failed" ? "failed" : "rejected",
          })),
          expressionSheet: {
            elementId: nonEmptyString(cast.identityPack.expression.elementId),
            assetFile: expressionsDestination,
            assetUrl: nonEmptyString(cast.identityPack.expression.assetUrl),
            sha256: cast.identityPack.expression.sha256,
          },
          turnaroundSheet: {
            elementId: nonEmptyString(cast.identityPack.turnaround.elementId),
            assetFile: turnaroundDestination,
            assetUrl: nonEmptyString(cast.identityPack.turnaround.assetUrl),
            sha256: cast.identityPack.turnaround.sha256,
          },
          eyeOpenSheet: eyeOpenDestination ? { ...cast.identityPack.eyeOpen, assetFile: eyeOpenDestination } : null,
        }
      : entry);
    current.status = workflowStatusForCast(current.cast);
    return current;
  });
  return {
    workflow: updatedWorkflow,
    character: writtenRegistry.characters.find((character) => character.id === cast.id),
    copiedAssets: [faceDestination, turnaroundDestination, expressionsDestination, ...(eyeOpenDestination ? [eyeOpenDestination] : []), ...outfitDestinations.map((entry) => entry.destination)],
  };
}

function castCharacterId(workflow, value) {
  const requested = nonEmptyString(value);
  const cast = findWorkflowCast(workflow, requested);
  if (cast?.characterId) return cast.characterId;
  return requested;
}

function normalizedSpeakerPosition(value) {
  const raw = nonEmptyString(value).toLowerCase();
  if (["left", "左"].includes(raw)) return "left";
  if (["right", "右"].includes(raw)) return "right";
  if (["center", "centre", "中央"].includes(raw)) return "center";
  return "";
}

function defaultBubbleSafeZone(scene, index) {
  const explicit = nonEmptyString(scene.bubbleSafeZone ?? scene.bubble_safe_zone);
  if (explicit) return explicit;
  const speakerPosition = normalizedSpeakerPosition(scene.speakerPosition ?? scene.speaker_position);
  if (speakerPosition === "left") return "upper right outer negative space";
  if (speakerPosition === "right") return "upper left outer negative space";
  return index % 2 === 0 ? "upper right outer negative space" : "upper left outer negative space";
}

function defaultShotType(tags, index = 0) {
  if (tags.includes("wide")) {
    return index % 2 === 0
      ? "elevated establishing wide with a normal lens; people occupy 35-55% of frame height"
      : "eye-level establishing wide with a normal lens; people occupy 35-55% of frame height";
  }
  if (tags.includes("closeup")) return "reaction close-up with the face occupying 30-45% of frame height";
  if (tags.includes("dialogue")) {
    return index % 2 === 0
      ? "left three-quarter medium two-shot; primary face occupies 18-30% of frame height"
      : "right three-quarter medium two-shot; primary face occupies 18-30% of frame height";
  }
  return "medium-close story shot; primary face occupies 20-32% of frame height";
}

export function buildCharacterStoryboardJobs(workflow, scenes, options = {}) {
  const normalizedScenes = Array.isArray(scenes) ? scenes.slice(0, MAX_SCENES) : [];
  if (normalizedScenes.length === 0) throw new Error("scenes must contain at least one storyboard scene.");
  const readyCast = workflow.cast.filter((cast) => cast.status === "ready" || cast.status === "existing");
  const unresolved = workflow.cast.filter((cast) => cast.status !== "ready" && cast.status !== "existing");
  if (unresolved.length > 0) {
    throw new Error(`Character workflow is not ready. Approve: ${unresolved.map((cast) => cast.name).join(", ")}.`);
  }
  return normalizedScenes.map((scene, index) => {
    const sourcePrompt = nonEmptyString(scene?.prompt ?? scene?.description);
    if (!sourcePrompt) throw new Error(`Scene ${index + 1} requires prompt/description.`);
    const requested = stringList(scene.characterIds ?? scene.character_ids ?? scene.characters, 20);
    const inferred = requested.length > 0
      ? requested
      : readyCast.filter((cast) => [cast.name, ...cast.aliases].some((name) => sourcePrompt.includes(name))).map((cast) => cast.id);
    const characterIds = [...new Set(inferred.map((value) => castCharacterId(workflow, value)).filter(Boolean))];
    const sceneWithCharacters = { ...scene, prompt: sourcePrompt, characterIds };
    const requestedModel = nonEmptyString(scene.model) || nonEmptyString(options.model) || workflow.model;
    const grokRoute = requestedModel === "grok-imagine-image-hermes" || requestedModel === "grok-imagine-image-api";
    // Grok accepts at most three reference images.  A three-person scene uses
    // the ChatGPT route so it can retain all identity bindings instead of
    // silently dropping a cast member or overflowing the Grok request.
    const resolvedModel = grokRoute && characterIds.length >= 3 ? "gpt-image-2-codex" : requestedModel;
    const referenceBudget = resolvedModel.startsWith("grok-imagine-image-") ? 3 : 30;
    const styleReferences = selectChannelVisualReferences(workflow.visualProfile, sceneWithCharacters, {
      ...options,
      referenceBudget,
      maxStyleReferences: characterIds.length > 0 ? 0 : Math.min(
        finiteNumber(options.maxStyleReferences ?? options.max_style_references, workflow.visualProfile?.maxStyleReferences ?? 2),
        Math.max(0, referenceBudget - characterIds.length),
      ),
    });
    const stylePrompt = buildChannelVisualStylePrompt(workflow.visualProfile, sceneWithCharacters, styleReferences.length);
    const styleTags = inferChannelVisualTags(sceneWithCharacters);
    const storyStage = nonEmptyString(scene.storyStage ?? scene.story_stage);
    const explicitReferenceIntent = nonEmptyString(scene.referenceIntent ?? scene.reference_intent);
    const referenceIntent = explicitReferenceIntent
      || (storyStage ? "outfit"
        : styleTags.includes("closeup") ? "closeup"
          : /profile|side view|横顔|全身|full[- ]?body/iu.test(sourcePrompt) ? "full-body"
            : "default");
    const bubbleSafeZone = defaultBubbleSafeZone(scene, index);
    const speakerPosition = normalizedSpeakerPosition(scene.speakerPosition ?? scene.speaker_position);
    const sceneDirectives = [
      `Shot type: ${nonEmptyString(scene.shotType ?? scene.shot_type) || defaultShotType(styleTags, index)}.`,
      `Camera: ${nonEmptyString(scene.camera) || (index % 6 === 2 ? "restrained elevated/top three-quarter view" : index % 2 === 0 ? "left three-quarter view" : "right three-quarter view")}. Avoid a distant full-room composition unless this cut is explicitly tagged wide.`,
      `Lighting: ${nonEmptyString(scene.lighting) || (styleTags.includes("night") ? "soft cool night ambience with controlled warm practical lights" : "soft natural or diffused daytime light")}.`,
      "Background: simplified but lively, with 2-4 story-specific props, one warm practical/light plane, and one controlled accent color (muted blue-green, lavender, dusty pink, or foliage green). Character contrast remains strongest.",
      nonEmptyString(scene.panelLayout ?? scene.panel_layout)
        ? `COMIC PANEL LAYOUT REQUESTED: ${nonEmptyString(scene.panelLayout ?? scene.panel_layout)}. Use thick clean black gutters, 2-3 readable panels, and no text or balloons.`
        : "Use one full-bleed frame; no panel gutters for this cut.",
      `Reserve clean negative space for the later speech bubble at: ${bubbleSafeZone}. Do not draw a bubble or text now.`,
    ].filter(Boolean).join("\n");
    const prompt = [sourcePrompt, sceneDirectives, stylePrompt].filter(Boolean).join("\n\n");
    return {
      prompt,
      model: resolvedModel,
      aspectRatio: nonEmptyString(scene.aspectRatio ?? scene.aspect_ratio) || nonEmptyString(options.aspectRatio ?? options.aspect_ratio) || "16:9",
      imageSize: nonEmptyString(scene.imageSize ?? scene.image_size) || nonEmptyString(options.imageSize ?? options.image_size) || workflow.imageSize,
      quality: nonEmptyString(scene.quality) || nonEmptyString(options.quality) || workflow.quality,
      characterIds,
      referenceIntent,
      storyStage,
      referenceImagePaths: styleReferences.map((reference) => reference.path),
      fileName: nonEmptyString(scene.fileName) || `${slugPart(workflow.episodeId, "episode")}-scene-${String(index + 1).padStart(3, "0")}.png`,
      customData: {
        buzzassistCharacterScene: true,
        buzzassistCharacterWorkflowId: workflow.id,
        buzzassistCharacterSceneId: nonEmptyString(scene.id) || `scene-${index + 1}`,
        buzzassistCharacterSceneIndex: index + 1,
        buzzassistCharacterSceneCharacterIds: characterIds,
        buzzassistCharacterReferenceIntent: referenceIntent,
        buzzassistCharacterStoryStage: storyStage,
        buzzassistCharacterLabel: `${workflow.episodeId}｜シーン${index + 1}`,
        buzzassistCharacterSceneSourcePrompt: sourcePrompt,
        buzzassistChannelVisualProfileId: workflow.visualProfile?.id || "",
        buzzassistStyleReferencePaths: styleReferences.map((reference) => reference.path),
        buzzassistStyleTags: styleTags,
        buzzassistSpeakerPosition: speakerPosition,
        buzzassistBubbleSafeZone: bubbleSafeZone,
        buzzassistGenerationRoutePolicy: grokRoute && characterIds.length >= 3
          ? "gpt-image-2-codex-multi-character-fallback"
          : resolvedModel,
      },
    };
  });
}

export function validateStoryboardCharacterBindings(workflow, jobs) {
  const warnings = [];
  const known = new Set(workflow.cast.map((cast) => cast.characterId).filter(Boolean));
  for (const [index, job] of (Array.isArray(jobs) ? jobs : []).entries()) {
    if (!Array.isArray(job.characterIds) || job.characterIds.length === 0) {
      warnings.push(`Scene ${index + 1} has no character binding.`);
      continue;
    }
    const unknown = job.characterIds.filter((id) => !known.has(id));
    if (unknown.length > 0) warnings.push(`Scene ${index + 1} references characters outside the workflow: ${unknown.join(", ")}.`);
    if (job.characterIds.length > 1) {
      warnings.push(`Scene ${index + 1} is a multi-character identity-mixing risk; keep all characterIds and the generated identity-lock prompt.`);
    }
  }
  return { ok: warnings.length === 0, warnings };
}

export function validateStoryboardVisualProfile(workflow, jobs) {
  const profile = workflow?.visualProfile;
  if (!profile) return { ok: true, profileId: "", warnings: [], scenes: [] };
  const warnings = [];
  const scenes = (Array.isArray(jobs) ? jobs : []).map((job, index) => {
    const references = Array.isArray(job.customData?.buzzassistStyleReferencePaths)
      ? job.customData.buzzassistStyleReferencePaths.filter(Boolean)
      : [];
    const expectedMaximum = (job.characterIds?.length ?? 0) > 0 ? 0 : profile.maxStyleReferences;
    const checks = {
      profile: job.customData?.buzzassistChannelVisualProfileId === profile.id,
      styleReferences: references.length <= expectedMaximum && (references.length > 0 || (job.characterIds?.length ?? 0) > 0),
      styleOnlyPrompt: job.prompt.includes("STYLE-ONLY") || references.length === 0,
      landscape16x9: job.aspectRatio === "16:9",
      bubbleSafeZone: Boolean(job.customData?.buzzassistBubbleSafeZone)
        && job.prompt.includes("Do not draw a bubble or text now"),
      noEmbeddedTypography: /no (?:built-in )?captions|no readable text|no text/iu.test(job.prompt),
    };
    const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
    if (failed.length > 0) warnings.push(`Scene ${index + 1} failed visual-profile checks: ${failed.join(", ")}.`);
    return {
      id: job.customData?.buzzassistCharacterSceneId || `scene-${index + 1}`,
      styleReferenceCount: references.length,
      expectedMaximum,
      checks,
      ok: failed.length === 0,
    };
  });
  return { ok: warnings.length === 0, profileId: profile.id, warnings, scenes };
}
