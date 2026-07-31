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
  const patterns = [
    /^【([^】]{1,40})】/u,
    /^([^\s:：]{1,40})\s*[：:]/u,
    /^([^「『]{1,40})[「『]/u,
    /^[-*・●○◆◇■□▶▷]?\s*([^\s（(]{1,30})\s*[（(][^）)]{0,40}[）)]\s*[：:]?/u,
  ];
  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    const candidate = cleanSpeakerName(match?.[1]);
    if (isVisualSpeaker(candidate)) return candidate;
  }
  return "";
}

export function extractCastFromScript(scriptText, options = {}) {
  const text = String(scriptText ?? "").slice(0, MAX_SCRIPT_LENGTH);
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
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
  const episodeId = nonEmptyString(args.episodeId ?? args.episode_id) || `episode-${new Date().toISOString().slice(0, 10)}`;
  const extracted = extractCastFromScript(script.text, {
    cast: providedCast,
    defaultRole: args.defaultRole ?? args.default_role,
  });
  const usedIds = new Set(registry.characters.map((character) => character.id));
  const cast = extracted.map((entry, index) => {
    const matched = findCharacter(registry, entry.name) || entry.aliases.map((alias) => findCharacter(registry, alias)).find(Boolean);
    const reusable = matched && (
      matched.role === "fixed" ||
      !matched.episodeId ||
      matched.episodeId === episodeId
    );
    let id = reusable ? matched.id : `${slugPart(episodeId, "episode")}-${slugPart(entry.name, `character-${index + 1}`)}`;
    let suffix = 2;
    while (!reusable && usedIds.has(id)) {
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

let cachedCharacterSheetTemplate = "";
async function readCharacterSheetTemplate() {
  if (cachedCharacterSheetTemplate) return cachedCharacterSheetTemplate;
  const markdown = await readFile(REFERENCE_PROMPTS_FILE, "utf8");
  const section = markdown.split('## キャラクターシート（kind: "character"）')[1] ?? markdown;
  const fenced = section.match(/~~~\s*\n([\s\S]*?)\n~~~/u)?.[1]?.trim();
  if (!fenced) throw new Error(`Character sheet template was not found: ${REFERENCE_PROMPTS_FILE}`);
  cachedCharacterSheetTemplate = fenced;
  return cachedCharacterSheetTemplate;
}

const CANDIDATE_VARIATIONS = [
  "Variation direction: grounded and relatable; ordinary proportions; immediately readable as the role described.",
  "Variation direction: slightly sharper silhouette and facial structure while remaining believable and faithful to the role.",
  "Variation direction: slightly softer and more approachable facial structure while remaining faithful to the role.",
  "Variation direction: more distinctive hair silhouette and clothing rhythm, without adding props or changing the written identity.",
  "Variation direction: restrained mature interpretation, without making the character glamorous or changing age.",
];

function characterAppearanceDescription(cast, workflow) {
  const details = [
    `Name / role label: ${cast.name}.`,
    cast.description,
    cast.invariants.length > 0 ? `Non-negotiable identity traits: ${cast.invariants.join("; ")}.` : "",
    cast.negativePrompt ? `Avoid: ${cast.negativePrompt}.` : "",
    cast.stylePrompt,
    workflow.channelStylePrompt,
    "For a high-quality hand-drawn Japanese manga / anime production. Do not render as photorealistic, 3D, chibi, western superhero art, or a social media screenshot.",
  ].filter(Boolean);
  return details.join(" ");
}

export async function buildCharacterCandidateJobs(workflow, options = {}) {
  const template = await readCharacterSheetTemplate();
  const model = nonEmptyString(options.model) || workflow.model;
  const aspectRatio = nonEmptyString(options.aspectRatio ?? options.aspect_ratio) || workflow.aspectRatio;
  const imageSize = nonEmptyString(options.imageSize ?? options.image_size) || workflow.imageSize;
  const quality = nonEmptyString(options.quality) || workflow.quality;
  const candidateCount = clampInteger(
    options.candidateCount ?? options.candidate_count,
    1,
    MAX_CANDIDATES_PER_CAST,
    workflow.candidateCount,
  );
  const jobs = [];
  for (const cast of workflow.cast.filter((entry) => entry.status === "needs-candidates" || entry.status === "failed")) {
    const setup = characterAppearanceDescription(cast, workflow);
    for (let index = 0; index < candidateCount; index += 1) {
      const candidateId = `${cast.candidateGroupId}-${index + 1}`;
      const variation = CANDIDATE_VARIATIONS[index % CANDIDATE_VARIATIONS.length];
      const prompt = `${template.replace(CHARACTER_SETUP_MARKER, setup)}\n\n${variation}\nThis is candidate ${index + 1} of ${candidateCount}. Keep all written identity requirements, but create a genuinely distinct design option from the other candidates.`;
      jobs.push({
        prompt,
        model,
        aspectRatio,
        imageSize,
        quality,
        fileName: `${slugPart(cast.id)}-candidate-${index + 1}.png`,
        customData: {
          buzzassistCharacterCandidate: true,
          buzzassistCharacterWorkflowId: workflow.id,
          buzzassistCharacterCastId: cast.id,
          buzzassistCharacterCandidateGroupId: cast.candidateGroupId,
          buzzassistCharacterCandidateId: candidateId,
          buzzassistCharacterCandidateIndex: index + 1,
          buzzassistCharacterName: cast.name,
          buzzassistCharacterLabel: `${cast.name}｜候補${index + 1}`,
          buzzassistCharacterApprovalStatus: "pending",
        },
        pipeline: { castId: cast.id, candidateId, candidateIndex: index + 1 },
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
  return updateCharacterWorkflow(args, workflowId, (workflow) => {
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
    (Number.isFinite(numeric) && candidate.index === Math.round(numeric)),
  ) ?? null;
}

export function buildExpressionSheetJob(workflow, cast, candidate, options = {}) {
  if (!candidate?.assetFile) throw new Error(`Candidate ${candidate?.id ?? ""} has no generated asset.`);
  const model = nonEmptyString(options.model) || workflow.model;
  const prompt = [
    `Create a high-definition Japanese manga character expression and head-angle reference sheet for ${cast.name}.`,
    "The attached selected character sheet is the binding identity reference. Preserve the exact same facial structure, eye shape, eyebrow thickness, nose, jaw, ears, hairline, hairstyle, age, skin tone, and clothing.",
    "Show a clean 4x2 production grid on a pure white background: neutral front, anxious front, shocked front, sad/downward, gentle smile 3/4, strict left profile, close-up of both eyes, close-up of the hairline and bangs.",
    "Every panel must depict the exact same person. No beautification, no age drift, no hairstyle drift, no clothing drift, no added accessories, no text, no logo, no watermark, no UI.",
    cast.description,
    cast.invariants.length > 0 ? `Must preserve: ${cast.invariants.join("; ")}.` : "",
    cast.negativePrompt ? `Avoid: ${cast.negativePrompt}.` : "",
    cast.stylePrompt,
    workflow.channelStylePrompt,
  ].filter(Boolean).join("\n");
  return {
    prompt,
    model,
    aspectRatio: nonEmptyString(options.aspectRatio ?? options.aspect_ratio) || workflow.aspectRatio,
    imageSize: nonEmptyString(options.imageSize ?? options.image_size) || workflow.imageSize,
    quality: nonEmptyString(options.quality) || workflow.quality,
    fileName: `${slugPart(cast.id)}-expressions.png`,
    referenceImagePaths: [candidate.assetFile],
    customData: {
      buzzassistCharacterExpressionSheet: true,
      buzzassistCharacterWorkflowId: workflow.id,
      buzzassistCharacterCastId: cast.id,
      buzzassistCharacterCandidateId: candidate.id,
      buzzassistCharacterName: cast.name,
      buzzassistCharacterLabel: `${cast.name}｜表情・角度シート`,
    },
  };
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
  const store = await readCharacterWorkflowStore(args);
  const workflow = getCharacterWorkflow(store, workflowId);
  if (!workflow) throw new Error(`Unknown character workflow: ${workflowId}.`);
  const cast = findWorkflowCast(workflow, castId);
  if (!cast) throw new Error(`Unknown workflow character: ${castId}.`);
  const candidate = findWorkflowCandidate(cast, candidateSelector);
  if (!candidate) throw new Error(`Unknown candidate for ${cast.name}: ${candidateSelector}.`);
  if (!candidate.assetFile) throw new Error(`Candidate ${candidate.id} has no generated asset.`);
  const expressionResult = args.expressionResult && typeof args.expressionResult === "object" ? args.expressionResult : {};
  if (!nonEmptyString(expressionResult.assetFile)) throw new Error("expressionResult.assetFile is required before final registration.");

  const canvasDir = resolveCanvasDir(args);
  const characterDir = join(canvasDir, "assets", "characters");
  await mkdir(characterDir, { recursive: true });
  const identityDestination = await availableDestination(characterDir, `${slugPart(cast.id)}-identity${extname(candidate.assetFile) || ".png"}`);
  const expressionsDestination = await availableDestination(characterDir, `${slugPart(cast.id)}-expressions${extname(expressionResult.assetFile) || ".png"}`);
  await copyFile(resolve(candidate.assetFile), identityDestination);
  await copyFile(resolve(expressionResult.assetFile), expressionsDestination);

  const registry = await readCharacterRegistry(args);
  const now = new Date().toISOString();
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
          candidates: entry.candidates.map((item) => ({
            ...item,
            status: item.id === candidate.id ? "selected" : item.status === "failed" ? "failed" : "rejected",
          })),
          expressionSheet: {
            elementId: nonEmptyString(expressionResult.elementId),
            assetFile: expressionsDestination,
            assetUrl: nonEmptyString(expressionResult.assetUrl),
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

export function buildCharacterStoryboardJobs(workflow, scenes, options = {}) {
  const normalizedScenes = Array.isArray(scenes) ? scenes.slice(0, MAX_SCENES) : [];
  if (normalizedScenes.length === 0) throw new Error("scenes must contain at least one storyboard scene.");
  const readyCast = workflow.cast.filter((cast) => cast.status === "ready" || cast.status === "existing");
  const unresolved = workflow.cast.filter((cast) => cast.status !== "ready" && cast.status !== "existing");
  if (unresolved.length > 0) {
    throw new Error(`Character workflow is not ready. Approve: ${unresolved.map((cast) => cast.name).join(", ")}.`);
  }
  return normalizedScenes.map((scene, index) => {
    const prompt = nonEmptyString(scene?.prompt ?? scene?.description);
    if (!prompt) throw new Error(`Scene ${index + 1} requires prompt/description.`);
    const requested = stringList(scene.characterIds ?? scene.character_ids ?? scene.characters, 20);
    const inferred = requested.length > 0
      ? requested
      : readyCast.filter((cast) => [cast.name, ...cast.aliases].some((name) => prompt.includes(name))).map((cast) => cast.id);
    const characterIds = [...new Set(inferred.map((value) => castCharacterId(workflow, value)).filter(Boolean))];
    return {
      prompt,
      model: nonEmptyString(scene.model) || nonEmptyString(options.model) || workflow.model,
      aspectRatio: nonEmptyString(scene.aspectRatio ?? scene.aspect_ratio) || nonEmptyString(options.aspectRatio ?? options.aspect_ratio) || "16:9",
      imageSize: nonEmptyString(scene.imageSize ?? scene.image_size) || nonEmptyString(options.imageSize ?? options.image_size) || workflow.imageSize,
      quality: nonEmptyString(scene.quality) || nonEmptyString(options.quality) || workflow.quality,
      characterIds,
      fileName: nonEmptyString(scene.fileName) || `${slugPart(workflow.episodeId, "episode")}-scene-${String(index + 1).padStart(3, "0")}.png`,
      customData: {
        buzzassistCharacterScene: true,
        buzzassistCharacterWorkflowId: workflow.id,
        buzzassistCharacterSceneId: nonEmptyString(scene.id) || `scene-${index + 1}`,
        buzzassistCharacterSceneIndex: index + 1,
        buzzassistCharacterSceneCharacterIds: characterIds,
        buzzassistCharacterLabel: `${workflow.episodeId}｜シーン${index + 1}`,
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
