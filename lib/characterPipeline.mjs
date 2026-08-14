import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveCanvasDir, writeJsonAtomic } from "./canvasScene.mjs";
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
import { publicBlindCandidateSummary, writeBlindCandidatePackage } from "./mangaBlindCandidateStore.mjs";

export const CHARACTER_WORKFLOW_FILE_NAME = "character-workflows.json";
export const DEFAULT_CHARACTER_CANDIDATE_COUNT = 3;
const CHARACTER_WORKFLOW_VERSION = 1;
const MAX_WORKFLOWS = 100;
const MAX_CAST_PER_WORKFLOW = 80;
const MAX_CANDIDATES_PER_CAST = 10;
const MAX_SCRIPT_LENGTH = 500_000;
const MAX_DESCRIPTION_LENGTH = 4_000;
const MAX_SCENES = 500;
const VALID_WORKFLOW_STATUSES = new Set([
  "draft",
  "awaiting-candidates",
  "awaiting-approval",
  "building-identity-pack",
  "ready",
  "archived",
]);
const VALID_CAST_STATUSES = new Set([
  "existing",
  "needs-candidates",
  "generating-candidates",
  "awaiting-approval",
  "building-identity-pack",
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
    name,
    role: override.role === "fixed" || override.role === "per-video" ? override.role : base.role,
    aliases: stringList([...(base.aliases ?? []), ...(override.aliases ?? [])], 20),
    description: (nonEmptyString(override.description) || base.description).slice(0, MAX_DESCRIPTION_LENGTH),
    invariants: stringList([...(base.invariants ?? []), ...(override.invariants ?? [])], 30),
    negativePrompt: nonEmptyString(override.negativePrompt ?? override.negative_prompt) || base.negativePrompt,
    stylePrompt: nonEmptyString(override.stylePrompt ?? override.style_prompt) || base.stylePrompt,
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
        }
      : null,
    expressionSheet: source.expressionSheet && typeof source.expressionSheet === "object"
      ? {
          elementId: nonEmptyString(source.expressionSheet.elementId),
          assetFile: nonEmptyString(source.expressionSheet.assetFile),
          assetUrl: nonEmptyString(source.expressionSheet.assetUrl),
        }
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
    workflows: (Array.isArray(source.workflows) ? source.workflows : [])
      .map(normalizeWorkflow)
      .slice(-MAX_WORKFLOWS),
  };
}

export async function readCharacterWorkflowStore(args = {}) {
  try {
    const raw = await readFile(resolveCharacterWorkflowFile(args), "utf8");
    return normalizeCharacterWorkflowStore(JSON.parse(raw));
  } catch {
    return normalizeCharacterWorkflowStore(null);
  }
}

export async function writeCharacterWorkflowStore(args = {}, store) {
  const normalized = normalizeCharacterWorkflowStore(store);
  const file = resolveCharacterWorkflowFile(args);
  await mkdir(dirname(file), { recursive: true });
  await writeJsonAtomic(file, normalized);
  return normalized;
}

export function getCharacterWorkflow(store, workflowId) {
  const id = nonEmptyString(workflowId);
  return (store?.workflows ?? []).find((workflow) => workflow.id === id) ?? null;
}

export async function updateCharacterWorkflow(args = {}, workflowId, updater) {
  const store = await readCharacterWorkflowStore(args);
  const index = store.workflows.findIndex((workflow) => workflow.id === workflowId);
  if (index < 0) throw new Error(`Unknown character workflow: ${workflowId}.`);
  const current = store.workflows[index];
  const next = normalizeWorkflow(
    typeof updater === "function" ? updater(structuredClone(current)) : updater,
    index,
  );
  next.updatedAt = new Date().toISOString();
  store.workflows[index] = next;
  await writeCharacterWorkflowStore(args, store);
  return next;
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
    let id = sameEpisodeOrFixed ? matched.id : `${slugPart(episodeId, "episode")}-${slugPart(entry.name, `character-${index + 1}`)}`;
    let suffix = 2;
    while (!sameEpisodeOrFixed && usedIds.has(id)) {
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
  "Variation direction: grounded and relatable; ordinary proportions; immediately readable as the role described.",
  "Variation direction: slightly sharper silhouette and facial structure while remaining believable and faithful to the role.",
  "Variation direction: slightly softer and more approachable facial structure while remaining faithful to the role.",
  "Variation direction: more distinctive hair silhouette and clothing rhythm, without adding props or changing the written identity.",
  "Variation direction: restrained mature interpretation, without making the character glamorous or changing age.",
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
      const variation = CANDIDATE_VARIATIONS[index % CANDIDATE_VARIATIONS.length];
      const prompt = `${template.replace(CHARACTER_SETUP_MARKER, setup)}\n\n${variation}\nThis is candidate ${index + 1} of ${candidateCount}. Keep all written identity requirements, but create a genuinely distinct design option from the other candidates. Never reuse or imitate the identity of a person visible in a STYLE-ONLY reference.`;
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
    workflow.cast = workflow.cast.map((cast) => byCast.has(cast.id)
      ? { ...cast, status: "generating-candidates", candidates: byCast.get(cast.id) }
      : cast);
    workflow.status = "awaiting-candidates";
    return workflow;
  });
}

export async function recordCharacterCandidateResults(args = {}, workflowId, jobs = [], results = []) {
  let updated = await updateCharacterWorkflow(args, workflowId, (workflow) => {
    const outcomeById = new Map();
    jobs.forEach((job, index) => outcomeById.set(job.pipeline?.candidateId, results[index] ?? {}));
    workflow.cast = workflow.cast.map((cast) => {
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
        status: generatedCount > 0 ? "awaiting-approval" : "failed",
      };
    });
    workflow.status = workflowStatusForCast(workflow.cast);
    return workflow;
  });
  const canvasDir = resolveCanvasDir(args);
  for (const cast of updated.cast.filter((entry) => entry.status === "awaiting-approval")) {
    const generated = cast.candidates.filter((candidate) => candidate.status === "generated" && candidate.assetFile);
    if (generated.length < 2) continue;
    const rootDir = join(canvasDir, "character-candidate-blind", updated.id, cast.id);
    const packageResult = await writeBlindCandidatePackage(generated.map((candidate) => ({
      id: candidate.id,
      variationAxis: candidate.variationAxis,
      artifact: candidate.assetFile,
      provider: updated.model,
      source: "character-candidate",
    })), {
      rootDir,
      artifactDir: join(canvasDir, "assets", `blind-${slugPart(updated.id, "workflow")}-${slugPart(cast.id, "cast")}`),
      minimumCandidates: 2,
      maximumCandidates: 5,
    });
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
  }
  return updated;
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
  return selectChannelVisualReferences(workflow.visualProfile, {
    prompt: cast.description,
    styleTags: ["character", "closeup", "day"],
    characterIds: [cast.id],
  }, { maxStyleReferences: 2 });
}

export function buildApprovedTurnaroundJob(workflow, cast, candidate, options = {}) {
  if (!candidate?.assetFile) throw new Error(`Candidate ${candidate?.id ?? ""} has no generated asset.`);
  const model = nonEmptyString(options.model) || workflow.model;
  const styleReferences = identityPackStyleReferences(workflow, cast);
  const styleStart = 2;
  const styleEnd = 1 + styleReferences.length;
  const prompt = [
    `Create a clean 2D Japanese manga APPROVED CHARACTER TURNAROUND for ${cast.name}.`,
    "Reference image 1 is the selected CHARACTER IDENTITY. Preserve its exact original facial structure, eye shape, eyebrow thickness, nose, jaw, ears, hairline, hairstyle, age, build, skin tone, clothing, and accessories.",
    styleReferences.length > 0
      ? `Reference images ${styleStart}-${styleEnd} are CHANNEL STYLE-ONLY. They control rendering style and visual information density only. Never copy a person or identity from them.`
      : "",
    "On a pure white 16:9 canvas, show front, strict left-profile, strict right-profile, and back full-body standing views plus front, gentle left 3/4, gentle right 3/4, and strict overhead/top head views. Every view must depict the exact same approved person.",
    "Use mostly uniform thin contours, a smooth simple face, minimal nose and mouth, broad graphic hair masses, flat pale skin, at most one restrained cel-shadow, broad clothing fills, and very few fold lines.",
    "No material swatches, no garment/fabric/skin/hand/shoe close-ups, no realistic texture, no extra props, no text, no logo, no watermark, no UI.",
    cast.description,
    cast.invariants.length > 0 ? `Must preserve: ${cast.invariants.join("; ")}.` : "",
    cast.negativePrompt ? `Avoid: ${cast.negativePrompt}.` : "",
    cast.stylePrompt,
    workflow.channelStylePrompt,
    buildChannelVisualStylePrompt(workflow.visualProfile, {
      prompt: cast.description,
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
  };
}

export function buildExpressionSheetJob(workflow, cast, candidate, options = {}) {
  if (!candidate?.assetFile) throw new Error(`Candidate ${candidate?.id ?? ""} has no generated asset.`);
  const model = nonEmptyString(options.model) || workflow.model;
  const styleReferences = identityPackStyleReferences(workflow, cast);
  const styleStart = 2;
  const styleEnd = 1 + styleReferences.length;
  const prompt = [
    `Create a high-definition Japanese manga character expression and head-angle reference sheet for ${cast.name}.`,
    "Reference image 1 is the selected CHARACTER IDENTITY. Preserve the exact same facial structure, eye shape, eyebrow thickness, nose, jaw, ears, hairline, hairstyle, age, skin tone, and clothing.",
    styleReferences.length > 0
      ? `Reference images ${styleStart}-${styleEnd} are CHANNEL STYLE-ONLY. They control rendering style and visual information density only. Never copy a person or identity from them.`
      : "",
    "Show a clean 4x3 production grid on a pure white background. Row 1: neutral front, anxious front, shocked front, sad/downward. Row 2: gentle smile left 3/4, strict left profile, strict right profile, strict overhead/top view. Row 3 is CAMERA COVERAGE: left-side wide shot, right-side wide shot, elevated/top wide shot, and an eye-level full-body wide shot. Keep the face readable even in the coverage thumbnails.",
    "Every panel must depict the exact same person. No beautification, no age drift, no hairstyle drift, no clothing drift, no added accessories, no text, no logo, no watermark, no UI.",
    cast.description,
    cast.invariants.length > 0 ? `Must preserve: ${cast.invariants.join("; ")}.` : "",
    cast.negativePrompt ? `Avoid: ${cast.negativePrompt}.` : "",
    cast.stylePrompt,
    workflow.channelStylePrompt,
    buildChannelVisualStylePrompt(workflow.visualProfile, {
      prompt: cast.description,
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
  };
}

export function buildApprovedIdentityPackJobs(workflow, cast, candidate, options = {}) {
  return [
    buildApprovedTurnaroundJob(workflow, cast, candidate, options),
    buildExpressionSheetJob(workflow, cast, candidate, options),
  ];
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

export async function finalizeApprovedCharacter(args = {}) {
  const workflowId = nonEmptyString(args.workflowId ?? args.workflow_id);
  const castId = nonEmptyString(args.castId ?? args.cast_id ?? args.characterName);
  const candidateSelector = args.candidateId ?? args.candidate_id ?? args.candidateIndex ?? args.candidate_index;
  const approvalReason = nonEmptyString(args.approvalReason ?? args.approval_reason);
  const approvedBy = nonEmptyString(args.approvedBy ?? args.approved_by) || "human-user";
  if (approvalReason.length < 4) {
    throw new Error("approvalReason must explain why this character candidate was selected.");
  }
  const store = await readCharacterWorkflowStore(args);
  const workflow = getCharacterWorkflow(store, workflowId);
  if (!workflow) throw new Error(`Unknown character workflow: ${workflowId}.`);
  const cast = findWorkflowCast(workflow, castId);
  if (!cast) throw new Error(`Unknown workflow character: ${castId}.`);
  const candidate = findWorkflowCandidate(cast, candidateSelector);
  if (!candidate) throw new Error(`Unknown candidate for ${cast.name}: ${candidateSelector}.`);
  if (!nonEmptyString(candidate.variationAxis)) {
    throw new Error(`Candidate ${candidate.id} has no variationAxis; regenerate distinct candidates before approval.`);
  }
  if (!candidate.assetFile) throw new Error(`Candidate ${candidate.id} has no generated asset.`);
  const turnaroundResult = args.turnaroundResult && typeof args.turnaroundResult === "object" ? args.turnaroundResult : {};
  const expressionResult = args.expressionResult && typeof args.expressionResult === "object" ? args.expressionResult : {};
  const turnaroundSource = nonEmptyString(turnaroundResult.assetFile) || candidate.assetFile;
  if (!nonEmptyString(expressionResult.assetFile)) throw new Error("expressionResult.assetFile is required before final registration.");

  const canvasDir = resolveCanvasDir(args);
  const characterDir = join(canvasDir, "assets", "characters");
  await mkdir(characterDir, { recursive: true });
  const identityDestination = await availableDestination(characterDir, `${slugPart(cast.id)}-turnaround${extname(turnaroundSource) || ".png"}`);
  const expressionsDestination = await availableDestination(characterDir, `${slugPart(cast.id)}-expressions${extname(expressionResult.assetFile) || ".png"}`);
  await copyFile(resolve(turnaroundSource), identityDestination);
  await copyFile(resolve(expressionResult.assetFile), expressionsDestination);

  const registry = await readCharacterRegistry(args);
  const now = new Date().toISOString();
  const approval = {
    route: "human-best-of-n",
    approvedBy,
    approvedAt: now,
    selectedCandidateId: candidate.id,
    selectedCandidateLabel: nonEmptyString(args.candidateLabel ?? candidate.blindLabel),
    candidateSetId: nonEmptyString(args.candidateSetId ?? candidate.candidateSetId),
    verdictDigest: nonEmptyString(args.verdictDigest),
    selectedVariationAxis: nonEmptyString(candidate.variationAxis),
    reason: approvalReason,
  };
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
    referenceImagePaths: [
      registryRelativePath(canvasDir, identityDestination),
      registryRelativePath(canvasDir, expressionsDestination),
    ],
    sourceWorkflowId: workflow.id,
    sourceCandidateId: candidate.id,
    approval,
    createdAt: registry.characters.find((character) => character.id === cast.id)?.createdAt || now,
    updatedAt: now,
    notes: `Approved from ${workflow.title}. Identity pack contains turnaround and expression/angle sheets.`,
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
          candidates: entry.candidates.map((item) => ({
            ...item,
            status: item.id === candidate.id ? "selected" : item.status === "failed" ? "failed" : "rejected",
          })),
          expressionSheet: {
            elementId: nonEmptyString(expressionResult.elementId),
            assetFile: expressionsDestination,
            assetUrl: nonEmptyString(expressionResult.assetUrl),
          },
          turnaroundSheet: {
            elementId: nonEmptyString(turnaroundResult.elementId),
            assetFile: identityDestination,
            assetUrl: nonEmptyString(turnaroundResult.assetUrl),
          },
        }
      : entry);
    current.status = workflowStatusForCast(current.cast);
    return current;
  });
  return {
    workflow: updatedWorkflow,
    character: writtenRegistry.characters.find((character) => character.id === cast.id),
    copiedAssets: [identityDestination, expressionsDestination],
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
      maxStyleReferences: Math.min(
        finiteNumber(options.maxStyleReferences ?? options.max_style_references, workflow.visualProfile?.maxStyleReferences ?? 2),
        Math.max(0, referenceBudget - characterIds.length),
      ),
    });
    const stylePrompt = buildChannelVisualStylePrompt(workflow.visualProfile, sceneWithCharacters, styleReferences.length);
    const styleTags = inferChannelVisualTags(sceneWithCharacters);
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
      referenceImagePaths: styleReferences.map((reference) => reference.path),
      fileName: nonEmptyString(scene.fileName) || `${slugPart(workflow.episodeId, "episode")}-scene-${String(index + 1).padStart(3, "0")}.png`,
      customData: {
        buzzassistCharacterScene: true,
        buzzassistCharacterWorkflowId: workflow.id,
        buzzassistCharacterSceneId: nonEmptyString(scene.id) || `scene-${index + 1}`,
        buzzassistCharacterSceneIndex: index + 1,
        buzzassistCharacterSceneCharacterIds: characterIds,
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
    const expectedMaximum = (job.characterIds?.length ?? 0) >= 3
      ? 1
      : profile.maxStyleReferences;
    const checks = {
      profile: job.customData?.buzzassistChannelVisualProfileId === profile.id,
      styleReferences: references.length > 0 && references.length <= expectedMaximum,
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
