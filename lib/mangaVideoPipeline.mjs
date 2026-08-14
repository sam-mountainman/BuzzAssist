import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";

import {
  getImageDimensionsFromBuffer,
  resolveCanvasDir,
  sanitizeFileName,
  writeJsonAtomic,
} from "./canvasScene.mjs";
import { findCharacter, readCharacterRegistry, writeCharacterRegistry } from "./characterRegistry.mjs";
import { runWithConcurrency } from "./mediaGeneration.mjs";
import {
  MANGA_SOURCE_VIEWPOINTS,
  auditMangaPanelPageCameraGrammar,
  auditMangaShotCameraGrammar,
  cameraHasPushIn,
  mangaWideViewFor,
  normalizeMangaCameraMode,
  normalizeMangaCameraTransform,
  normalizeMangaSourceViewpoint,
} from "./mangaPageCameraGrammar.mjs";
import { buildCameraAwareBubblePlacement, cameraAtProgress } from "./mangaBubbleCameraPlacement.mjs";
import { auditMangaPreflight, createMangaQualityContract } from "./mangaQualityHarness.mjs";
import { renderSpeechBubbleSvg } from "./speechBubbleRenderer.mjs";
import {
  DEFAULT_SPEECH_MODEL,
  getElevenLabsStatus,
  listAllElevenLabsVoices,
  loadElevenLabsConfig,
  speechAssetPublicResult,
  writeSpeechAsset,
} from "./speechGeneration.mjs";
import { castRegistryVoices } from "./voiceCasting.mjs";

export const EPISODE_MANIFEST_VERSION = 1;
export const DEFAULT_VIDEO_WIDTH = 1920;
export const DEFAULT_VIDEO_HEIGHT = 1080;
export const DEFAULT_VIDEO_FPS = 30;
export const DEFAULT_SPEECH_CONCURRENCY = 4;
export const MAX_SPEECH_CONCURRENCY = 8;
export const DEFAULT_RENDER_CONCURRENCY = Math.max(2, Math.min(4, cpus().length || 2));
export const MAX_RENDER_CONCURRENCY = 4;

const HARD_BUBBLE_FACE_KINDS = new Set([
  "face", "mouth", "head", "speaker-face", "speaker-head",
  "active-speaker", "active-speaker-face", "active-speaker-head",
  "protected-hand", "protected-prop", "protected-evidence", "protected-text",
]);

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function acquireMangaRenderLock(lockPath, options = {}) {
  const pid = Number.isInteger(options.pid) ? options.pid : process.pid;
  const startedAt = options.startedAt || new Date().toISOString();
  const isAlive = typeof options.isProcessAlive === "function" ? options.isProcessAlive : processIsAlive;
  const token = `${pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const payload = { pid, startedAt, token };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(lockPath, JSON.stringify(payload), { encoding: "utf8", flag: "wx" });
      return async () => {
        try {
          const current = JSON.parse(await readFile(lockPath, "utf8"));
          if (current.token === token) await unlink(lockPath);
        } catch {}
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let existing = null;
      try { existing = JSON.parse(await readFile(lockPath, "utf8")); } catch {}
      if (existing && isAlive(Number(existing.pid))) {
        throw new Error(
          `Another render (pid ${existing.pid}, started ${existing.startedAt}) holds ${lockPath}. `
          + "Wait for it or stop it before rendering again.",
        );
      }
      // Invalid or dead-owner locks are stale. Remove only that exact episode
      // lock, then retry the atomic create once.
      try { await unlink(lockPath); } catch (unlinkError) {
        if (unlinkError?.code !== "ENOENT") throw unlinkError;
      }
    }
  }
  throw new Error(`Could not acquire render lock ${lockPath}.`);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function finiteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// Scripts gloss names for the voice engine as 「荒野（あらの）」 so the reading
// reaches text-to-speech. Balloons must show the plain kanji: the parenthesised
// reading is a production annotation, not dialogue the character speaks, and
// printing it makes the balloon read like a dictionary entry. Only kana
// readings that directly follow a kanji/Latin name are removed, so ordinary
// parenthetical dialogue survives untouched.
const FURIGANA_ANNOTATION = /(?<=[々㐀-鿿豈-﫿A-Za-zＡ-Ｚａ-ｚ])[（(]\s*[ぁ-ゟ゠-ヿー\s]+\s*[）)]/gu;

export function stripFuriganaAnnotations(value) {
  return String(value || "").replace(FURIGANA_ANNOTATION, "");
}

export function mangaBubbleDisplayText(value, options = {}) {
  const text = stripFuriganaAnnotations(String(value || ""));
  return options.stripTerminalJapanesePeriod === true
    ? text.replace(/。+$/u, "")
    : text;
}

function clamp(value, minimum, maximum, fallback) {
  return Math.min(maximum, Math.max(minimum, finiteNumber(value, fallback)));
}

function normalizeConcurrency(value, fallback, maximum) {
  return Math.max(1, Math.min(maximum, Math.round(finiteNumber(value, fallback))));
}

function normalizedBubbleBounds(bounds, width, height) {
  if (!bounds || typeof bounds !== "object") return null;
  const frameWidth = Math.max(1, finiteNumber(width, DEFAULT_VIDEO_WIDTH));
  const frameHeight = Math.max(1, finiteNumber(height, DEFAULT_VIDEO_HEIGHT));
  const x = finiteNumber(bounds.x, 0);
  const y = finiteNumber(bounds.y, 0);
  const bubbleWidth = finiteNumber(bounds.width, 0);
  const bubbleHeight = finiteNumber(bounds.height, 0);
  if (bubbleWidth <= 0 || bubbleHeight <= 0) return null;
  return {
    x: Math.abs(x) <= 1 ? x : x / frameWidth,
    y: Math.abs(y) <= 1 ? y : y / frameHeight,
    width: Math.abs(bubbleWidth) <= 1 ? bubbleWidth : bubbleWidth / frameWidth,
    height: Math.abs(bubbleHeight) <= 1 ? bubbleHeight : bubbleHeight / frameHeight,
  };
}

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map((entry) => stableJsonValue(entry));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableJsonValue(entry)]),
  );
}

export function mangaVideoJobInputHash(kind, input) {
  return createHash("sha256")
    .update(`${nonEmptyString(kind) || "job"}\n`)
    .update(JSON.stringify(stableJsonValue(input)))
    .digest("hex");
}

function ensureEpisodeJobs(manifest) {
  if (!manifest.jobs || typeof manifest.jobs !== "object") manifest.jobs = {};
  if (!manifest.jobs.speech || typeof manifest.jobs.speech !== "object") manifest.jobs.speech = {};
  if (!manifest.jobs.render || typeof manifest.jobs.render !== "object") manifest.jobs.render = {};
  return manifest.jobs;
}

function manifestCheckpointWriter(filePath, manifest) {
  let pending = Promise.resolve();
  return () => {
    pending = pending.then(() => writeJsonAtomic(filePath, manifest));
    return pending;
  };
}

function pad2(value) {
  return String(Math.max(0, Math.round(Number(value) || 0))).padStart(2, "0");
}

function slug(value, fallback = "episode") {
  const result = nonEmptyString(value)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return result || fallback;
}

function normalizeDialogueText(value) {
  return nonEmptyString(value)
    .replace(/^[「『"']+/u, "")
    .replace(/[」』"']+$/u, "")
    .trim();
}

function comparableText(value) {
  return normalizeDialogueText(value)
    .normalize("NFKC")
    .replace(/[\s　、。！？!?…・「」『』]/gu, "");
}

export function normalizeSpeechPronunciations(value) {
  return (Array.isArray(value) ? value : [])
    .map((rule) => {
      if (Array.isArray(rule)) return { from: nonEmptyString(rule[0]), to: nonEmptyString(rule[1]) };
      if (!rule || typeof rule !== "object") return { from: "", to: "" };
      return {
        from: nonEmptyString(rule.from ?? rule.source ?? rule.text),
        to: nonEmptyString(rule.to ?? rule.replacement ?? rule.speech),
      };
    })
    .filter((rule) => rule.from && rule.to && rule.from !== rule.to);
}

export function applySpeechPronunciations(text, rules = []) {
  return normalizeSpeechPronunciations(rules).reduce(
    (result, rule) => result.split(rule.from).join(rule.to),
    nonEmptyString(text),
  );
}

function unwrapMarkdownScript(source) {
  const lines = String(source ?? "").split("\n");
  const firstContentIndex = lines.findIndex((line) => line.trim());
  let bodyLines = lines;
  let frontmatterTitle = "";

  if (firstContentIndex >= 0 && lines[firstContentIndex].trim() === "---") {
    const closingIndex = lines.findIndex(
      (line, index) => index > firstContentIndex && line.trim() === "---",
    );
    if (closingIndex > firstContentIndex) {
      const frontmatter = lines.slice(firstContentIndex + 1, closingIndex).join("\n");
      frontmatterTitle = nonEmptyString(frontmatter.match(/^title\s*:\s*(.+)$/mu)?.[1]);
      bodyLines = [
        ...lines.slice(0, firstContentIndex),
        ...lines.slice(closingIndex + 1),
      ];
    }
  }

  const body = bodyLines.join("\n");
  const headingTitle = nonEmptyString(body.match(/^\s*#\s+(.+)$/mu)?.[1]);
  return { body, frontmatterTitle, headingTitle };
}

function speakerIdForName(name, registry) {
  const normalized = nonEmptyString(name);
  if (/^(?:ナレーション|ナレーター|地の文)$/u.test(normalized)) return "narration";
  const matched = findCharacter(registry, normalized);
  const asciiId = slug(normalized, "");
  return matched?.id || asciiId || `speaker-${createHash("sha256").update(normalized).digest("hex").slice(0, 10)}`;
}

export function parseMangaScript(scriptText, options = {}) {
  const source = String(scriptText ?? "").replace(/\r\n?/g, "\n");
  const markdown = unwrapMarkdownScript(source);
  const registry = options.registry && typeof options.registry === "object"
    ? options.registry
    : { characters: [], voices: [] };
  const titleMatch = markdown.body.match(/^\s*タイトル\s*[：:]\s*(.+)$/mu);
  const title = nonEmptyString(options.title)
    || nonEmptyString(titleMatch?.[1])
    || markdown.frontmatterTitle
    || markdown.headingTitle
    || "漫画動画";
  const cuts = [];
  let currentCut = null;

  for (const rawLine of markdown.body.split("\n")) {
    const line = rawLine.trim();
    if (!line || /^タイトル\s*[：:]/u.test(line)) continue;
    const cutMatch = line.match(/^【\s*(?:カット|CUT)\s*(\d+)\s*[：:]\s*(.*?)\s*】$/iu);
    if (cutMatch) {
      currentCut = {
        id: `cut-${pad2(cutMatch[1])}`,
        number: Number(cutMatch[1]),
        purpose: nonEmptyString(cutMatch[2]),
        utterances: [],
      };
      cuts.push(currentCut);
      continue;
    }
    const dialogueMatch = line.match(/^([^：:]{1,80})[：:]\s*(.+)$/u);
    if (!dialogueMatch) continue;
    if (!currentCut) {
      currentCut = { id: `cut-${pad2(cuts.length + 1)}`, number: cuts.length + 1, purpose: "", utterances: [] };
      cuts.push(currentCut);
    }
    const speakerName = nonEmptyString(dialogueMatch[1]);
    const isNarration = /^(?:ナレーション|ナレーター|地の文)$/u.test(speakerName);
    const text = isNarration ? nonEmptyString(dialogueMatch[2]) : normalizeDialogueText(dialogueMatch[2]);
    if (!text) continue;
    const utteranceNumber = currentCut.utterances.length + 1;
    const utteranceId = `${currentCut.id}-u${pad2(utteranceNumber)}`;
    currentCut.utterances.push({
      id: utteranceId,
      cutId: currentCut.id,
      order: utteranceNumber,
      speakerName,
      speakerId: speakerIdForName(speakerName, registry),
      text,
      bubbleId: `bubble-${utteranceId}`,
      preset: isNarration
        ? "narration"
        : /！|!$/u.test(text)
          ? "shout"
          : /じゃ[ぁあ]?……|だろうか|のか……/u.test(text)
            ? "thought"
            : "dialogue",
    });
  }

  return {
    title,
    cuts,
    utterances: cuts.flatMap((cut) => cut.utterances),
  };
}

async function pathExists(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function isDecodableRenderedCut(filePath) {
  try {
    const { stdout } = await runCommand("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=codec_type:format=duration",
      "-of", "json",
      filePath,
    ], { timeoutMs: 15_000 });
    const report = JSON.parse(stdout);
    return report.streams?.[0]?.codec_type === "video"
      && Number.isFinite(Number(report.format?.duration))
      && Number(report.format.duration) > 0;
  } catch {
    return false;
  }
}

export function canReuseRenderedCut({
  existingCut,
  decodableCut,
  previousJob,
  inputHash,
  forceRender = false,
  explicitlySelected = false,
  excludedBySelection = false,
} = {}) {
  if (forceRender || explicitlySelected || !existingCut || !decodableCut) return false;
  // --cut-ids is a requested minimum, not permission to preserve an artifact
  // whose bound image/audio/overlay input changed. A prepare/refresh step can
  // rewrite overlays outside the named cuts; reusing those old MP4s would make
  // the manifest and the rendered pixels disagree. Require the same completed
  // input binding for selected and unselected cuts alike. A path and matching
  // input hash are also insufficient on their own: interrupted ffmpeg jobs can
  // leave a partial MP4 at the final path, so require a completed checkpoint
  // and a real decodable video stream before any reuse.
  if (previousJob?.status !== "complete") return false;
  return previousJob.inputHash === inputHash;
}

async function firstExistingPath(paths) {
  for (const filePath of paths) {
    if (await pathExists(filePath)) return filePath;
  }
  return "";
}

export async function resolveEpisodeImageForCut(canvasDir, cutId, explicitPath = "", episodeId = "") {
  const assetsDir = join(canvasDir, "assets");
  const number = pad2(String(cutId).match(/(\d+)/)?.[1] || 0);
  const episodeAssetDir = nonEmptyString(episodeId) ? join(assetsDir, slug(episodeId)) : "";
  const candidates = [
    nonEmptyString(explicitPath) ? resolve(explicitPath) : "",
    episodeAssetDir ? join(episodeAssetDir, `cut-${number}.png`) : "",
    join(assetsDir, `e2e-v4-cut-${number}.png`),
    join(assetsDir, `e2e-v3-cut-${number}.png`),
    join(assetsDir, `e2e-v2-cut-${number}.png`),
    join(assetsDir, `e2e-script-20260803-cut-${number}.png`),
    join(assetsDir, `manga-office-001-cut-${number}.png`),
  ].filter(Boolean);
  return firstExistingPath(candidates);
}

async function readJsonIfExists(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function readBubbleTemplate(canvasDir, cutId, options = {}) {
  if (options.allowLegacy === false) return { parsed: null, filePath: "" };
  const number = pad2(String(cutId).match(/(\d+)/)?.[1] || 0);
  const paths = [
    join(canvasDir, "speech-bubbles", `element_e2e-v4-cut-${number}.json`),
    join(canvasDir, "speech-bubbles", `element_e2e-v3-cut-${number}.json`),
    join(canvasDir, "speech-bubbles", `element_e2e-v2-cut-${number}.json`),
    join(canvasDir, "speech-bubbles", `element_e2e-script-20260803-cut-${number}.json`),
  ];
  for (const filePath of paths) {
    const parsed = await readJsonIfExists(filePath);
    if (parsed) return { parsed, filePath };
  }
  return { parsed: null, filePath: "" };
}

function closestTemplateBubble(template, utterance) {
  const bubbles = Array.isArray(template?.bubbles) ? template.bubbles : [];
  const target = comparableText(utterance.text);
  return bubbles.find((bubble) => {
    const candidate = comparableText(bubble.text);
    return candidate && target && (candidate.includes(target) || target.includes(candidate));
  }) || null;
}

function oppositePosition(value) {
  if (value === "left") return "right";
  if (value === "right") return "left";
  return "left";
}

function defaultSpeakerPosition(utterance) {
  if (utterance.speakerId === "narration") {
    return /^cut-(?:08)$/u.test(utterance.cutId) ? "right" : "left";
  }
  // These confrontation cuts deliberately reserve the left side of the art
  // for every alternating dialogue bubble. Keeping one shared negative-space
  // lane prevents a bubble from covering the listener's face.
  if (/^cut-(?:05|07)$/u.test(utterance.cutId)) return "right";
  if (/黒川/u.test(utterance.speakerName)) return "right";
  if (/佐藤/u.test(utterance.speakerName)) return "right";
  if (/水野|澪|神谷|玲司/u.test(utterance.speakerName)) return "right";
  return "left";
}

function bubbleForUtterance(template, utterance, cutUtterances) {
  const matched = closestTemplateBubble(template, utterance);
  if (matched) {
    const exactTemplateText = comparableText(matched.text) === comparableText(utterance.text);
    const {
      columns: matchedColumns,
      bounds: matchedBounds,
      ...matchedBase
    } = matched;
    return {
      ...matchedBase,
      ...(exactTemplateText && Array.isArray(matchedColumns) ? { columns: matchedColumns } : {}),
      ...(exactTemplateText && matchedBounds ? { bounds: matchedBounds } : {}),
      id: utterance.bubbleId,
      order: utterance.order,
      text: utterance.text,
      preset: utterance.preset,
      utteranceId: utterance.id,
    };
  }
  const templateBubble = Array.isArray(template?.bubbles) ? template.bubbles[0] : null;
  const templatePosition = templateBubble?.speakerHint?.position || templateBubble?.speakerPosition || templateBubble?.side;
  const templateUtterance = templateBubble
    ? cutUtterances.find((candidate) => closestTemplateBubble({ bubbles: [templateBubble] }, candidate))
    : null;
  const position = templateUtterance && templateUtterance.speakerId !== utterance.speakerId
    ? oppositePosition(templatePosition)
    : defaultSpeakerPosition(utterance);
  return {
    id: utterance.bubbleId,
    order: utterance.order,
    text: utterance.text,
    preset: utterance.preset,
    tail: false,
    utteranceId: utterance.id,
    speakerHint: {
      position,
      faceBand: "upper",
      facing: position === "left" ? "right" : "left",
    },
  };
}

const JAPANESE_WORD_SEGMENTER = new Intl.Segmenter("ja", { granularity: "word" });
const JAPANESE_BOUNDARY_PARTICLE = /^(?:は|が|を|に|へ|と|で|の|も|や|か|から|まで|より|だけ|など|なら|ので|のに|って)$/u;
const JAPANESE_CONNECTIVE_PARTICLE = /^(?:の|へ)$/u;
const JAPANESE_BOUNDARY_AUXILIARY = /^(?:する|した|して|され|れる|られる|ない|なかった|ます|ました|です|でした|だ|だった|て|って|た)$/u;
const JAPANESE_COUNTER_END = /(?:月|日|年|時|分|秒|人|本|枚|回|件|個|台|冊)$/u;

function japaneseBubbleBoundaryProfile(text) {
  const source = String(text || "");
  const units = [...JAPANESE_WORD_SEGMENTER.segment(source)].map((entry) => ({
    text: entry.segment,
    start: entry.index,
    end: entry.index + entry.segment.length,
    isWordLike: entry.isWordLike === true,
  }));
  const allowed = new Map();
  for (let index = 0; index < units.length - 1; index += 1) {
    const previous = units[index];
    const next = units[index + 1];
    const boundary = previous.end;
    if (/[.!?。！？、,\s]$/u.test(previous.text)) {
      allowed.set(boundary, 0);
      continue;
    }
    // A particle or auxiliary belongs with the lexical unit before it.  A
    // sequential balloon must never start with one merely to balance length.
    if (JAPANESE_BOUNDARY_PARTICLE.test(next.text) || JAPANESE_BOUNDARY_AUXILIARY.test(next.text)) continue;
    if (JAPANESE_BOUNDARY_PARTICLE.test(previous.text)) {
      // Genitive/directional connectors must keep their following noun, while
      // topic/case particles can close a readable timed phrase.
      if (!JAPANESE_CONNECTIVE_PARTICLE.test(previous.text)) allowed.set(boundary, 6);
      continue;
    }
    const kanjiCompoundBoundary = previous.isWordLike && next.isWordLike
      && /\p{Script=Han}$/u.test(previous.text)
      && /^\p{Script=Han}/u.test(next.text)
      && !JAPANESE_COUNTER_END.test(previous.text);
    // Intl correctly separates components such as 回数/券/記録 and
    // 佐藤/誠司.  Those token boundaries are useful for morphology, but they
    // are not acceptable visual replacement points inside a compound/name.
    if (kanjiCompoundBoundary) continue;
    allowed.set(boundary, 18);
  }
  return allowed;
}

function bubbleSegmentBoundaryScore(characters, index, target, semanticBoundaries = null) {
  const previous = characters[index - 1] || "";
  const next = characters[index] || "";
  const semanticPenalty = semanticBoundaries?.get(index);
  if (semanticBoundaries && !Number.isFinite(semanticPenalty)) return Number.POSITIVE_INFINITY;
  const punctuationPenalty = /[.!?。！？]/u.test(previous)
    ? 0
    : /[,、]/u.test(previous)
      ? 5
      : /\s/u.test(previous) || /\s/u.test(next)
        ? 12
        : 40;
  return Math.abs(index - target) + (Number.isFinite(semanticPenalty) ? semanticPenalty : punctuationPenalty);
}

function splitBubbleTextNaturally(text, segmentCount, maximumCharactersPerSegment = 16) {
  const characters = Array.from(String(text || ""));
  if (segmentCount <= 1 || characters.length <= 1) return [String(text || "")];
  const semanticBoundaries = japaneseBubbleBoundaryProfile(text);
  const boundaries = [];
  let minimum = 1;
  for (let segmentIndex = 1; segmentIndex < segmentCount; segmentIndex += 1) {
    const remainingSegments = segmentCount - segmentIndex;
    const segmentStart = boundaries.at(-1) || 0;
    const requiredMinimum = characters.length - remainingSegments * maximumCharactersPerSegment;
    const maximum = Math.min(
      characters.length - remainingSegments,
      segmentStart + maximumCharactersPerSegment,
    );
    minimum = Math.max(minimum, requiredMinimum);
    const target = Math.round(characters.length * segmentIndex / segmentCount);
    let best = minimum;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let index = minimum; index <= maximum; index += 1) {
      // Whitespace is a soft Japanese authoring hint, never an independently
      // timed replacement. Do not permit a boundary pair to isolate only
      // spaces between visible phrases.
      if (!characters.slice(segmentStart, index).some((character) => !/\s/u.test(character))) continue;
      const score = bubbleSegmentBoundaryScore(characters, index, target, semanticBoundaries);
      if (score < bestScore) {
        best = index;
        bestScore = score;
      }
    }
    if (!Number.isFinite(bestScore)) return [];
    boundaries.push(best);
    minimum = best + 1;
  }
  const segments = [];
  let start = 0;
  for (const boundary of [...boundaries, characters.length]) {
    const value = characters.slice(start, boundary).join("");
    if (value) segments.push(value);
    start = boundary;
  }
  return segments;
}

export function naturalBubbleSegmentsForLimit(text, maximumCharactersPerSegment = 16) {
  const characterCount = Array.from(String(text || "").replace(/\s/gu, "")).length;
  const minimumSegments = Math.max(2, Math.ceil(characterCount / maximumCharactersPerSegment));
  for (let segmentCount = minimumSegments; segmentCount <= Math.min(12, characterCount); segmentCount += 1) {
    const segments = splitBubbleTextNaturally(text, segmentCount, maximumCharactersPerSegment);
    if (segments.length === segmentCount && segments.every((entry) => (
      Array.from(entry.replace(/\s/gu, "")).length <= maximumCharactersPerSegment
    ))) return segments;
  }
  return [];
}

export function auditBubbleSegmentNaturalness(text, segments) {
  const source = String(text || "");
  const values = (Array.isArray(segments) ? segments : [])
    .map((entry) => String(entry?.text ?? entry ?? ""))
    .filter(Boolean);
  if (values.length <= 1) return {
    pass: values.length === 0 || values.join("") === source,
    exactText: values.length === 0 || values.join("") === source,
    boundaries: [],
    unnaturalBoundaries: [],
  };
  const semanticBoundaries = japaneseBubbleBoundaryProfile(source);
  let cursor = 0;
  const boundaries = [];
  for (const value of values.slice(0, -1)) {
    cursor += Array.from(value).length;
    boundaries.push(cursor);
  }
  const unnaturalBoundaries = boundaries.filter((boundary) => !semanticBoundaries.has(boundary));
  return {
    pass: values.join("") === source && unnaturalBoundaries.length === 0,
    exactText: values.join("") === source,
    boundaries,
    unnaturalBoundaries,
  };
}

function renderBubbleOrSequentialSegments({
  bubble,
  width,
  height,
  avoidRegions,
  profileId,
  title,
  stripTerminalJapanesePeriod = false,
}) {
  const renderOne = (entry, suffix = "") => renderSpeechBubbleSvg({
    width,
    height,
    bubbles: [entry],
    avoidRegions,
    profileId,
    title: `${title}${suffix}`,
  });
  const direct = renderOne(bubble);
  const invalid = direct.quality.some((entry) => (
    entry.overflow || entry.textLoss || entry.tooSmall || entry.exactTextMatch === false
  ));
  const characterCount = Array.from(String(bubble.text || "").replace(/\s/gu, "")).length;
  // Whole-page split cameras have a smaller guaranteed-visible window than
  // an ordinary 16:9 shot. Proactively sequence longer clauses even when one
  // very tall bubble would technically fit the uncropped source frame.
  if (!invalid && characterCount <= 16) return { rendered: direct, segments: [] };

  const minimumSegments = Math.max(2, Math.ceil(characterCount / 16));
  for (let segmentCount = minimumSegments; segmentCount <= Math.min(12, characterCount); segmentCount += 1) {
    const texts = splitBubbleTextNaturally(bubble.text, segmentCount);
    if (texts.length !== segmentCount) continue;
    const renderedSegments = texts.map((text, index) => {
      const segmentBubble = {
        ...bubble,
        id: `${bubble.id}-s${index + 1}`,
        // `bubble.text` already follows the episode display policy before it
        // is split. Stripping `。` from every timed segment erases legitimate
        // sentence punctuation in the middle of a long utterance.
        text,
        columns: undefined,
        bounds: undefined,
      };
      const rendered = renderOne(segmentBubble, ` segment ${index + 1}`);
      return { bubble: segmentBubble, rendered, quality: rendered.quality[0] };
    });
    if (renderedSegments.every(({ quality }) => (
      !quality.overflow && !quality.textLoss && !quality.tooSmall && quality.exactTextMatch !== false
    ))) {
      return { rendered: renderedSegments[0].rendered, segments: renderedSegments };
    }
  }
  return { rendered: direct, segments: [] };
}

export function manifestFilePath(args = {}, episodeId = "") {
  const canvasDir = resolveCanvasDir(args);
  const id = nonEmptyString(episodeId || args.episodeId) || "episode";
  return join(canvasDir, "manga-videos", slug(id), "episode-manifest.json");
}

export async function createEpisodeManifest(args = {}) {
  const canvasDir = resolveCanvasDir(args);
  let registry = args.registry || await readCharacterRegistry({ canvasDir });
  const scriptText = nonEmptyString(args.scriptText)
    ? args.scriptText
    : await readFile(resolve(nonEmptyString(args.scriptPath)), "utf8");
  const parsedScript = parseMangaScript(scriptText, { registry, title: args.title });
  const episodeId = nonEmptyString(args.episodeId) || slug(parsedScript.title, `episode-${Date.now().toString(36)}`);
  let voiceCasting = {
    status: "disabled",
    assignments: [],
    catalogCount: 0,
    japaneseCandidateCount: 0,
    nativeJapaneseCandidateCount: 0,
  };
  if (args.autoCastVoices !== false && args.auto_cast_voices !== false) {
    const status = Array.isArray(args.voiceCatalog)
      ? { configured: true, source: "provided-catalog" }
      : await getElevenLabsStatus();
    if (status.configured) {
      const catalogResult = Array.isArray(args.voiceCatalog)
        ? { voices: args.voiceCatalog, totalCount: args.voiceCatalog.length, scope: "provided-catalog" }
        : await listAllElevenLabsVoices({
            apiKey: args.apiKey,
            fetchImpl: args.fetchImpl,
            japaneseOnly: true,
          });
      const usedCharacterIds = new Set(parsedScript.cuts
        .flatMap((cut) => cut.utterances)
        .map((utterance) => utterance.speakerId)
        .filter((speakerId) => speakerId && speakerId !== "narration"));
      const usedCharacters = registry.characters.filter((character) => usedCharacterIds.has(character.id));
      const cast = castRegistryVoices({
        registry,
        voices: catalogResult.voices,
        characters: usedCharacters,
        episodeId,
        includeNarration: true,
        preserveExisting: args.preserveExistingVoices !== false,
        force: args.forceVoiceCast === true || args.force_voice_cast === true,
        requireNativeJapanese: args.requireNativeJapaneseVoices !== false,
        modelId: nonEmptyString(args.model) || DEFAULT_SPEECH_MODEL,
      });
      registry = cast.registry;
      voiceCasting = {
        status: cast.changed ? "updated" : "verified",
        source: status.source,
        scope: catalogResult.scope || "all-account-voices",
        assignments: cast.assignments,
        catalogCount: cast.catalogCount,
        japaneseCandidateCount: cast.japaneseCandidateCount,
        nativeJapaneseCandidateCount: cast.nativeJapaneseCandidateCount,
      };
      if (cast.changed && !args.registry && args.persistVoiceCasting !== false) {
        registry = await writeCharacterRegistry({ canvasDir }, registry);
      }
    } else {
      voiceCasting = { ...voiceCasting, status: "unconfigured" };
    }
  }
  const rootDir = join(canvasDir, "manga-videos", slug(episodeId));
  const overlayDir = join(rootDir, "overlays");
  const overlaySpecsDir = join(rootDir, "overlay-specs");
  await mkdir(overlayDir, { recursive: true });
  await mkdir(overlaySpecsDir, { recursive: true });

  const explicitImages = args.imagePathByCutId && typeof args.imagePathByCutId === "object"
    ? args.imagePathByCutId
    : {};
  const cuts = [];
  const utterances = [];
  const speechPronunciations = normalizeSpeechPronunciations(args.speechPronunciations ?? args.pronunciations);
  for (const cut of parsedScript.cuts) {
    const imagePath = await resolveEpisodeImageForCut(canvasDir, cut.id, explicitImages[cut.id], episodeId);
    if (!imagePath) throw new Error(`No image asset was found for ${cut.id}.`);
    const imageSize = getImageDimensionsFromBuffer(await readFile(imagePath), imagePath);
    const useLegacyBubbleTemplates = args.useLegacyBubbleTemplates === true
      || (args.useLegacyBubbleTemplates !== false && /^manga-office-reversal/u.test(episodeId));
    const { parsed: template, filePath: templateFile } = await readBubbleTemplate(
      canvasDir,
      cut.id,
      { allowLegacy: useLegacyBubbleTemplates },
    );
    const cutUtteranceIds = [];
    for (const utterance of cut.utterances) {
      const bubbleDisplayText = mangaBubbleDisplayText(utterance.text, {
        stripTerminalJapanesePeriod: args.stripTerminalJapanesePeriod === true,
      });
      const bubble = bubbleForUtterance(
        template,
        { ...utterance, text: bubbleDisplayText },
        cut.utterances,
      );
      const bubbleRender = renderBubbleOrSequentialSegments({
        bubble,
        width: imageSize.width,
        height: imageSize.height,
        avoidRegions: Array.isArray(template?.avoidRegions) ? template.avoidRegions : [],
        profileId: nonEmptyString(template?.profileId) || undefined,
        title: `${parsedScript.title} ${utterance.id}`,
        stripTerminalJapanesePeriod: args.stripTerminalJapanesePeriod === true,
      });
      const rendered = bubbleRender.rendered;
      const invalidTypography = rendered.quality.find((entry) => (
        entry.overflow || entry.textLoss || entry.tooSmall || entry.exactTextMatch === false
      ));
      if (invalidTypography) {
        throw new Error(
          `Speech bubble typography failed for ${utterance.id}: `
          + `overflow=${invalidTypography.overflow}, textLoss=${invalidTypography.textLoss}, `
          + `exactTextMatch=${invalidTypography.exactTextMatch}, `
          + `edgeClearanceRatio=${finiteNumber(invalidTypography.edgeClearanceRatio, 0).toFixed(2)}. `
          + "Split the dialogue or regenerate the cut with more bubble-safe negative space.",
        );
      }
      const overlayFileName = `${utterance.id}.svg`;
      const overlayPath = join(overlayDir, overlayFileName);
      const overlaySpecPath = join(overlaySpecsDir, `${utterance.id}.json`);
      await writeFile(overlayPath, rendered.svg, "utf8");
      const bubbleSegments = [];
      for (const [segmentIndex, segment] of bubbleRender.segments.entries()) {
        const segmentOverlayPath = join(overlayDir, `${utterance.id}-s${segmentIndex + 1}.svg`);
        await writeFile(segmentOverlayPath, segment.rendered.svg, "utf8");
        bubbleSegments.push({
          id: `${utterance.id}-bubble-s${segmentIndex + 1}`,
          text: segment.bubble.text,
          columns: segment.quality.columnTexts,
          overlayPath: segmentOverlayPath,
          quality: segment.quality,
          bounds: segment.rendered.plan?.bubbles?.[0]?.bounds || null,
          autoTiming: true,
          timingPolicy: "proportional-character-count-v1",
        });
      }
      await writeJsonAtomic(overlaySpecPath, {
        version: "r5-timed",
        utteranceId: utterance.id,
        cutId: cut.id,
        speakerId: utterance.speakerId,
        speakerName: utterance.speakerName,
        imagePath,
        imageSize,
        bubble,
        plan: rendered.plan,
        quality: bubbleRender.segments.length > 0
          ? bubbleRender.segments.map((segment) => segment.quality)
          : rendered.quality,
        bubbleSegments,
        profile: rendered.profile,
        templateFile,
      });
      const character = utterance.speakerId === "narration" ? null : findCharacter(registry, utterance.speakerId);
      const registryVoice = utterance.speakerId === "narration"
        ? (registry.voices || []).find((voice) => voice.role === "narration" && voice.episodeId === episodeId)
          || (registry.voices || []).find((voice) => voice.role === "narration" || voice.id === "narration-default")
          || null
        : (registry.voices || []).find((voice) => voice.id === character?.voiceId) || null;
      utterances.push({
        ...utterance,
        bubbleDisplayText,
        speechText: applySpeechPronunciations(utterance.text, speechPronunciations),
        voiceProfileId: registryVoice?.id || "",
        voiceId: registryVoice?.providerVoiceId || registryVoice?.elevenLabsVoiceId || "",
        voiceName: registryVoice?.name || "",
        voiceSettings: registryVoice?.settings || null,
        model: registryVoice?.modelId || nonEmptyString(args.model) || DEFAULT_SPEECH_MODEL,
        overlayPath,
        overlaySpecPath,
        ...(bubbleSegments.length > 0 ? { bubbleSegments } : {}),
        audio: null,
        timing: null,
      });
      cutUtteranceIds.push(utterance.id);
    }
    cuts.push({
      id: cut.id,
      number: cut.number,
      purpose: cut.purpose,
      imagePath,
      imageSize,
      utteranceIds: cutUtteranceIds,
      motion: nonEmptyString(args.motion) || "pull-out",
      timing: null,
    });
  }

  const now = new Date().toISOString();
  const manifest = {
    version: EPISODE_MANIFEST_VERSION,
    id: episodeId,
    title: parsedScript.title,
    status: "planned",
    model: nonEmptyString(args.model) || DEFAULT_SPEECH_MODEL,
    defaultVoiceId: nonEmptyString(args.voiceId),
    defaultVoiceName: nonEmptyString(args.voiceName),
    scriptPath: nonEmptyString(args.scriptPath) ? resolve(args.scriptPath) : "",
    scriptText,
    video: {
      width: Math.max(320, Math.round(finiteNumber(args.width, DEFAULT_VIDEO_WIDTH))),
      height: Math.max(180, Math.round(finiteNumber(args.height, DEFAULT_VIDEO_HEIGHT))),
      fps: Math.max(12, Math.round(finiteNumber(args.fps, DEFAULT_VIDEO_FPS))),
      preRollSeconds: clamp(args.preRollSeconds, 0, 3, 0.12),
      interUtteranceGapSeconds: clamp(args.interUtteranceGapSeconds, 0, 3, 0.2),
      sameSpeakerGapSeconds: clamp(args.sameSpeakerGapSeconds, 0, 3, 0.17),
      speakerChangeGapSeconds: clamp(args.speakerChangeGapSeconds, 0, 3, 0.3),
      emphasisGapSeconds: clamp(args.emphasisGapSeconds, 0, 3, 0.5),
      bubbleLeadSeconds: clamp(args.bubbleLeadSeconds, 0, 2, 0.1),
      bubbleHoldSeconds: clamp(args.bubbleHoldSeconds, 0, 3, 0.25),
      bubbleTransitionGapSeconds: clamp(args.bubbleTransitionGapSeconds, 0, 1, 1 / DEFAULT_VIDEO_FPS),
      bubbleTransitionCrossfadeSeconds: clamp(args.bubbleTransitionCrossfadeSeconds, 0, 0.5, 0),
      bubbleFadeInMilliseconds: clamp(args.bubbleFadeInMilliseconds, 0, 500, 0),
      bubbleFadeOutMilliseconds: clamp(args.bubbleFadeOutMilliseconds, 0, 500, 0),
      cutTailSeconds: clamp(args.cutTailSeconds, 0, 3, 0.35),
      bgmPath: nonEmptyString(args.bgmPath) ? resolve(args.bgmPath) : "",
      bgmVolume: clamp(args.bgmVolume, 0, 1, 0.1),
      normalizeVoiceAudio: args.normalizeVoiceAudio !== false,
      voiceTargetLufs: clamp(args.voiceTargetLufs, -30, -10, -18),
      voiceLoudnessRange: clamp(args.voiceLoudnessRange, 1, 20, 7),
      voiceTruePeakDb: clamp(args.voiceTruePeakDb, -9, -0.1, -2),
      // Short edge fades only prevent decoder-boundary clicks when separately
      // generated speech clips are placed on the episode timeline. They do
      // not reshape pitch, timbre, or the performance inside the line.
      voiceFadeInMilliseconds: clamp(args.voiceFadeInMilliseconds, 0, 100, 12),
      voiceFadeOutMilliseconds: clamp(args.voiceFadeOutMilliseconds, 0, 100, 18),
      normalizeMasterAudio: args.normalizeMasterAudio !== false,
      masterTargetLufs: clamp(args.masterTargetLufs, -24, -10, -14),
      masterLoudnessRange: clamp(args.masterLoudnessRange, 1, 20, 7),
      masterTruePeakDb: clamp(args.masterTruePeakDb, -9, -0.1, -1.5),
      bgmDucking: args.bgmDucking !== false,
      bgmDuckThreshold: clamp(args.bgmDuckThreshold, 0.001, 1, 0.025),
      bgmDuckRatio: clamp(args.bgmDuckRatio, 1, 20, 8),
      speechConcurrency: normalizeConcurrency(
        args.speechConcurrency ?? args.speech_concurrency,
        DEFAULT_SPEECH_CONCURRENCY,
        MAX_SPEECH_CONCURRENCY,
      ),
      renderConcurrency: normalizeConcurrency(
        args.renderConcurrency ?? args.render_concurrency,
        DEFAULT_RENDER_CONCURRENCY,
        MAX_RENDER_CONCURRENCY,
      ),
    },
    speech: {
      pronunciations: speechPronunciations,
      voiceCasting,
    },
    jobs: {
      speech: {},
      render: {},
    },
    cuts,
    utterances,
    metrics: {
      characterCount: utterances.reduce((total, utterance) => total + [...utterance.text].length, 0),
      characterCost: 0,
      generationElapsedMs: 0,
      retryCount: 0,
      failedCount: 0,
      audioDurationSeconds: 0,
      videoDurationSeconds: 0,
    },
    outputs: {},
    createdAt: now,
    updatedAt: now,
  };
  const filePath = manifestFilePath({ canvasDir }, episodeId);
  await mkdir(dirname(filePath), { recursive: true });
  await writeJsonAtomic(filePath, manifest);
  return { manifest, filePath };
}

export async function readEpisodeManifest(args = {}) {
  const filePath = nonEmptyString(args.manifestPath)
    ? resolve(args.manifestPath)
    : manifestFilePath(args, args.episodeId);
  return { manifest: JSON.parse(await readFile(filePath, "utf8")), filePath };
}

export async function adoptEpisodeCutImages(args = {}) {
  const loaded = await readEpisodeManifest(args);
  const manifest = loaded.manifest;
  const canvasDir = resolveCanvasDir(args);
  const imageTemplate = nonEmptyString(args.imageTemplate ?? args.image_template)
    || join(canvasDir, "assets", "{episode}-v7-{cut}.png");
  const explicitImages = args.imagePathByCutId && typeof args.imagePathByCutId === "object"
    ? args.imagePathByCutId
    : {};
  const adopted = [];

  for (const cut of manifest.cuts || []) {
    const templatedPath = imageTemplate
      .replaceAll("{episode}", manifest.id)
      .replaceAll("{cut}", cut.id)
      .replaceAll("{number}", String(cut.number || "").padStart(2, "0"));
    const imagePath = resolve(nonEmptyString(explicitImages[cut.id]) || templatedPath);
    if (!await pathExists(imagePath)) throw new Error(`Approved cut image is not a file: ${imagePath}`);
    const imageSize = getImageDimensionsFromBuffer(await readFile(imagePath), imagePath);
    cut.imagePath = imagePath;
    cut.imageSize = imageSize;
    cut.imageGeneration = {
      ...(cut.imageGeneration || {}),
      status: nonEmptyString(args.generationStatus ?? args.generation_status) || "approved",
      route: nonEmptyString(args.route) || cut.imageGeneration?.route || "approved-assets",
      visualProfileId: nonEmptyString(args.visualProfileId ?? args.visual_profile_id)
        || cut.imageGeneration?.visualProfileId
        || "",
      adoptedAt: new Date().toISOString(),
    };
    adopted.push({ cutId: cut.id, imagePath, imageSize });
  }

  const cutsById = new Map((manifest.cuts || []).map((cut) => [cut.id, cut]));
  for (const utterance of manifest.utterances || []) {
    const cut = cutsById.get(utterance.cutId);
    if (!cut) continue;
    const overlaySpecPath = nonEmptyString(utterance.overlaySpecPath);
    const overlaySpec = overlaySpecPath ? await readJsonIfExists(overlaySpecPath) : null;
    if (!overlaySpec) continue;
    await writeJsonAtomic(overlaySpecPath, {
      ...overlaySpec,
      imagePath: cut.imagePath,
      imageSize: cut.imageSize,
      adoptedImageAt: new Date().toISOString(),
    });
  }

  manifest.status = nonEmptyString(args.status) || "visuals-ready";
  if (manifest.outputs?.reviewVideo) delete manifest.outputs.reviewVideo;
  manifest.updatedAt = new Date().toISOString();
  await writeJsonAtomic(loaded.filePath, manifest);
  return { manifest, filePath: loaded.filePath, adopted };
}

function pageCameraOffscreenRegions(cut, utterance, frameWidth, frameHeight, options = {}) {
  const sampleCount = finiteNumber(options.sampleCount, 17);
  const layout = normalizePanelLayout(cut.panelLayout, frameWidth, frameHeight, cut.imagePath);
  const camera = layout?.pageCamera;
  if (!camera) return [];
  const durationSeconds = Math.max(1e-6, finiteNumber(cut.timing?.durationSeconds, 0));
  const timing = utterance?.timing || {};
  const baseStart = finiteNumber(timing.bubbleStartInCutSeconds, finiteNumber(timing.audioStartInCutSeconds, 0));
  const baseEnd = finiteNumber(timing.bubbleEndInCutSeconds, finiteNumber(timing.audioEndInCutSeconds, durationSeconds));
  // A sequential segment only needs to stay readable for its own display
  // interval, which can be much shorter (and therefore wider on screen)
  // than the whole utterance's interval.
  const start = finiteNumber(options.intervalStartSeconds, baseStart);
  const end = finiteNumber(options.intervalEndSeconds, baseEnd);
  const p0 = Math.min(1, Math.max(0, start / durationSeconds));
  const p1 = Math.min(1, Math.max(0, end / durationSeconds));
  let left = 0;
  let top = 0;
  let right = 1;
  let bottom = 1;
  const count = Math.max(3, sampleCount);
  for (let index = 0; index < count; index += 1) {
    const progress = p0 + (p1 - p0) * index / (count - 1);
    const state = cameraAtProgress(camera, progress);
    const cropWidth = 1 / Math.max(1e-6, state.zoom);
    const cropHeight = 1 / Math.max(1e-6, state.zoom);
    const originX = Math.min(Math.max(state.focusX - cropWidth / 2, 0), Math.max(0, 1 - cropWidth));
    const originY = Math.min(Math.max(state.focusY - cropHeight / 2, 0), Math.max(0, 1 - cropHeight));
    left = Math.max(left, originX);
    top = Math.max(top, originY);
    right = Math.min(right, originX + cropWidth);
    bottom = Math.min(bottom, originY + cropHeight);
  }
  if (right <= left || bottom <= top) return [];
  const marginX = frameWidth * 0.006;
  const marginY = frameHeight * 0.006;
  const window = {
    x: left * frameWidth + marginX,
    y: top * frameHeight + marginY,
    right: right * frameWidth - marginX,
    bottom: bottom * frameHeight - marginY,
  };
  const regions = [];
  const push = (id, x, y, width, height) => {
    if (width > 2 && height > 2) {
      regions.push({ id, kind: "page-offscreen", x, y, width, height, weight: 1600 });
    }
  };
  push(`${utterance.id}-page-offscreen-left`, 0, 0, window.x, frameHeight);
  push(`${utterance.id}-page-offscreen-right`, window.right, 0, frameWidth - window.right, frameHeight);
  push(`${utterance.id}-page-offscreen-top`, window.x, 0, window.right - window.x, window.y);
  push(`${utterance.id}-page-offscreen-bottom`, window.x, window.bottom, window.right - window.x, frameHeight - window.bottom);
  return regions;
}

export async function refreshEpisodeBubbleOverlays(args = {}) {
  const loaded = await readEpisodeManifest(args);
  const manifest = loaded.manifest;
  const overridesPath = nonEmptyString(args.overridesPath ?? args.overrides_path);
  const overrideDocument = overridesPath ? await readJsonIfExists(resolve(overridesPath), {}) : {};
  const overrides = args.bubbleOverrides && typeof args.bubbleOverrides === "object"
    ? args.bubbleOverrides
    : (overrideDocument?.overrides && typeof overrideDocument.overrides === "object"
      ? overrideDocument.overrides
      : overrideDocument);
  const cameraOverrides = overrideDocument?.cameraOverrides && typeof overrideDocument.cameraOverrides === "object"
    ? overrideDocument.cameraOverrides
    : {};
  const refreshAll = args.refreshAll === true || args.refresh_all === true;
  const reflowPlacement = args.reflowPlacement === true || args.reflow_placement === true;
  const sequenceAware = args.sequenceAware !== false && args.sequence_aware !== false;
  const placementHistoryDepth = Math.max(1, Math.min(4, Math.round(finiteNumber(
    args.placementHistoryDepth ?? args.placement_history_depth,
    2,
  ))));
  const placementHistory = [];
  const refreshed = [];
  const cutsById = new Map((manifest.cuts || []).map((cut) => [cut.id, cut]));
  const utterancesByCutId = new Map();
  for (const utterance of manifest.utterances || []) {
    const rows = utterancesByCutId.get(utterance.cutId) || [];
    rows.push(utterance);
    utterancesByCutId.set(utterance.cutId, rows);
  }

  for (const cut of manifest.cuts || []) {
    const cameraOverride = cameraOverrides[cut.id];
    if (!cameraOverride || typeof cameraOverride !== "object") continue;
    cut.camera = { ...(cut.camera || {}), ...cameraOverride };
  }

  const appendHistory = (id, preset, bounds, width, height) => {
    const normalizedBounds = normalizedBubbleBounds(bounds, width, height);
    if (!sequenceAware || !normalizedBounds) return;
    placementHistory.push({ id, preset, bounds: normalizedBounds });
    if (placementHistory.length > placementHistoryDepth) placementHistory.shift();
  };

  for (const utterance of manifest.utterances || []) {
    const override = overrides?.[utterance.id];
    const overlaySpecPath = nonEmptyString(utterance.overlaySpecPath);
    const overlayPath = nonEmptyString(utterance.overlayPath);
    const overlaySpec = overlaySpecPath ? await readJsonIfExists(overlaySpecPath) : null;
    const shouldRefresh = refreshAll || (override && typeof override === "object");
    const frameWidth = overlaySpec?.imageSize?.width || manifest.video?.width || DEFAULT_VIDEO_WIDTH;
    const frameHeight = overlaySpec?.imageSize?.height || manifest.video?.height || DEFAULT_VIDEO_HEIGHT;
    const existingSegments = Array.isArray(utterance.bubbleSegments) && utterance.bubbleSegments.length > 0
      ? utterance.bubbleSegments
      : (Array.isArray(overlaySpec?.bubbleSegments) ? overlaySpec.bubbleSegments : []);
    const bubbleDisplayText = mangaBubbleDisplayText(
      nonEmptyString(utterance.bubbleDisplayText) || utterance.text,
      { stripTerminalJapanesePeriod: args.stripTerminalJapanesePeriod === true },
    );
    utterance.bubbleDisplayText = bubbleDisplayText;
    if (!shouldRefresh) {
      if (existingSegments.length > 0) {
        for (const segment of existingSegments) {
          appendHistory(segment.id, utterance.preset, segment.bounds, frameWidth, frameHeight);
        }
      } else {
        appendHistory(
          utterance.id,
          utterance.preset,
          overlaySpec?.plan?.bubbles?.[0]?.bounds,
          frameWidth,
          frameHeight,
        );
      }
      continue;
    }
    if (!overlaySpec || !overlayPath) throw new Error(`Overlay source is missing for ${utterance.id}.`);
    const cut = cutsById.get(utterance.cutId);
    if (!cut) throw new Error(`Unknown cut for ${utterance.id}: ${utterance.cutId}.`);
    const panelLayoutEnabled = Boolean(cut.panelLayout && cut.panelLayout.enabled !== false);
    // On a split page the balloon is composited onto the page BEFORE the
    // page-level camera, so screen-space swept-face protections from any
    // earlier per-shot camera are meaningless there (and, being stale, can
    // close every pocket). Page-space face regions plus the page-visibility
    // window are the correct constraint set for panel cuts.
    let cameraAwarePlacement = panelLayoutEnabled ? null : (overlaySpec.cameraAwarePlacement || null);
    if (reflowPlacement && !panelLayoutEnabled) {
      const cutUtterances = utterancesByCutId.get(cut.id) || [];
      const shotSequence = normalizeCameraShotSequence(
        cut,
        cutUtterances,
        // Manifest preparation intentionally runs before speech exists. Give
        // authored shots a provisional positive duration so their current
        // source-face annotations can still drive the first safe layout; the
        // post-speech refresh below recomputes the exact timed camera sweep.
        Math.max(1, finiteNumber(cut.timing?.durationSeconds, 0)),
      );
      const assignedShot = shotSequence.find((shot) => (
        Array.isArray(shot.utteranceIds) && shot.utteranceIds.includes(utterance.id)
      ));
      const durationSeconds = Math.max(1e-6, finiteNumber(cut.timing?.durationSeconds, 0));
      const shot = assignedShot || {
        id: `${cut.id}-whole-cut-current-camera`,
        utteranceIds: cut.utteranceIds || cutUtterances.map((entry) => entry.id),
        angle: nonEmptyString(cut.cameraMode) || "base",
        startSeconds: 0,
        endSeconds: durationSeconds,
        durationSeconds,
        camera: cut.camera || {},
      };
      const shotSpeakerFace = assignedShot?.sourceFaceBoundsBySpeakerId
        && typeof assignedShot.sourceFaceBoundsBySpeakerId === "object"
        ? assignedShot.sourceFaceBoundsBySpeakerId[utterance.speakerId]
        : null;
      const shotAvoidRegions = Array.isArray(assignedShot?.sourceAvoidRegions)
        ? assignedShot.sourceAvoidRegions
        : null;
      const speakerOffscreen = Array.isArray(assignedShot?.speakerOffscreenSpeakerIds)
        && assignedShot.speakerOffscreenSpeakerIds.includes(utterance.speakerId);
      const shotSpeakerAnchor = assignedShot?.speakerAnchorPointBySpeakerId
        && typeof assignedShot.speakerAnchorPointBySpeakerId === "object"
        ? assignedShot.speakerAnchorPointBySpeakerId[utterance.speakerId]
        : null;
      // Camera-sequence shots can replace the source illustration between
      // utterances.  When the current shot provides source annotations, they
      // must replace the stale overlay-spec coordinates rather than being
      // mixed with a previous image's cast geometry.
      const placementOverlaySpec = shotSpeakerFace || shotAvoidRegions
        ? {
            ...overlaySpec,
            sourceAvoidRegions: shotAvoidRegions || [
              { ...shotSpeakerFace, id: `${utterance.speakerId}-active-speaker`, kind: "face" },
            ],
            cameraAwarePlacement: {
              ...(overlaySpec.cameraAwarePlacement || {}),
              sourceAvoidRegions: shotAvoidRegions || [
                { ...shotSpeakerFace, id: `${utterance.speakerId}-active-speaker`, kind: "face" },
              ],
              sourceSpeakerFace: shotSpeakerFace
                ? { ...shotSpeakerFace, id: `${utterance.speakerId}-active-speaker`, kind: "face" }
                : speakerOffscreen
                  ? null
                  : overlaySpec.cameraAwarePlacement?.sourceSpeakerFace,
            },
          }
        : overlaySpec;
      cameraAwarePlacement = buildCameraAwareBubblePlacement({
        shot,
        utterance,
        overlaySpec: placementOverlaySpec,
        width: frameWidth,
        height: frameHeight,
        sampleCount: 33,
        proximitySampleCount: 9,
        speakerOffscreen,
        sourceSpeakerAnchor: shotSpeakerAnchor,
      });
    }
    const cameraProtectedRegions = Array.isArray(cameraAwarePlacement?.cameraAwareAvoidRegions)
      ? cameraAwarePlacement.cameraAwareAvoidRegions
      : [];
    const authoredAvoidRegions = (override?.clearAvoidRegions === true
      ? []
      : Array.isArray(override?.avoidRegions)
        ? override.avoidRegions
        : panelLayoutEnabled
          ? (Array.isArray(overlaySpec.plan?.avoidRegions) ? overlaySpec.plan.avoidRegions : [])
          : [])
      // Page-visibility masks are derived fresh per entry below; stale copies
      // persisted into a previous plan must never accumulate as authored
      // regions (they can close every pocket after a camera change).
      .filter((region) => region?.kind !== "page-offscreen");
    // A split page is flattened and then moved by one page-level camera, so a
    // bubble that is composited near a page edge can leave the visible crop
    // while its line is still being spoken. Mask everything outside the
    // interval's guaranteed-visible window as hard regions so the balloon is
    // always readable for its full display interval. (Computed per entry in
    // the loop below because each sequential segment has its own interval.)
    const entryPageVisibilityRegions = (entry) => {
      if (!panelLayoutEnabled) return [];
      const audioStartInCut = finiteNumber(utterance.timing?.audioStartInCutSeconds, 0);
      const segment = entry?.segment;
      const options = segment && Number.isFinite(Number(segment.startOffsetSeconds))
        ? {
            intervalStartSeconds: audioStartInCut + finiteNumber(segment.startOffsetSeconds, 0),
            intervalEndSeconds: audioStartInCut + finiteNumber(segment.endOffsetSeconds, 0),
          }
        : {};
      return pageCameraOffscreenRegions(cut, utterance, frameWidth, frameHeight, options);
    };
    // Camera-projected heads are mandatory and cannot be cleared by a manual
    // override. Manual regions may add prop/text protection, never remove the
    // active speaker contract.
    const baseAvoidRegions = [...cameraProtectedRegions, ...authoredAvoidRegions];
    const panelMaximumCharactersPerSegment = 13;
    const faceConstrainedMaximumCharactersPerSegment = 12;
    const panelCharacterCount = Array.from(bubbleDisplayText.replace(/\s/gu, "")).length;
    const existingNaturalness = auditBubbleSegmentNaturalness(bubbleDisplayText, existingSegments);
    const hasHardFaceProtection = baseAvoidRegions.some((region) => (
      HARD_BUBBLE_FACE_KINDS.has(String(region?.kind || ""))
    ));
    const existingSegmentExceedsFaceConstrainedLimit = existingSegments.some((segment) => (
      Array.from(String(segment?.text || "").replace(/\s/gu, "")).length
        > faceConstrainedMaximumCharactersPerSegment
    ));
    const shouldResegment = (panelLayoutEnabled && panelCharacterCount > panelMaximumCharactersPerSegment)
      || (existingSegments.length > 1 && !existingNaturalness.pass)
      // Once every detected face is a zero-pixel hard obstacle, crowded
      // frames can have a safe pocket too short for a legacy 13–16 character
      // replacement. Re-segment at natural Japanese boundaries instead of
      // shrinking type, clipping text, or weakening face protection.
      || (hasHardFaceProtection && existingSegmentExceedsFaceConstrainedLimit);
    const segmentCharacterLimit = hasHardFaceProtection
      ? faceConstrainedMaximumCharactersPerSegment
      : panelLayoutEnabled ? panelMaximumCharactersPerSegment : 16;
    const naturalSegmentTexts = shouldResegment
      ? naturalBubbleSegmentsForLimit(bubbleDisplayText, segmentCharacterLimit)
      : [];
    // Never invent an unnatural split merely to reach the compact target.
    // If the Japanese boundary model cannot form a <=12 character sequence,
    // keep the already-approved natural segments and let the real typography
    // and collision gates decide whether the composition must stop.
    const refreshSegments = shouldResegment && naturalSegmentTexts.length > 0
      ? naturalSegmentTexts.map((text, index) => {
          const characterCount = Array.from(text.replace(/\s/gu, "")).length;
          // A short one-column dialogue oval can be taller than the
          // guaranteed page-camera window. Two balanced vertical columns keep
          // the same phrase readable at the contracted minimum font.
          const naturalColumns = characterCount >= 6 && characterCount <= 10
            ? splitBubbleTextNaturally(text, 2, Math.ceil(characterCount / 2))
            : [];
          // Column breaks remain visible simultaneously, so unlike a timed
          // replacement they may use a balanced orthographic fallback.  This
          // keeps short split-page balloons inside the camera-safe window
          // without ever hiding half of a word between successive frames.
          const columns = characterCount >= 6 && characterCount <= 10
            ? naturalColumns.length === 2
              ? naturalColumns
              : [
                  Array.from(text).slice(0, Math.ceil(Array.from(text).length / 2)).join(""),
                  Array.from(text).slice(Math.ceil(Array.from(text).length / 2)).join(""),
                ]
            : undefined;
          return {
            id: `${utterance.id}-bubble-s${index + 1}`,
            text,
            columns,
            overlayPath: join(dirname(overlayPath), `${utterance.id}-s${index + 1}.svg`),
          };
        })
      : existingSegments;
    const entries = refreshSegments.length > 0
      ? refreshSegments.map((segment, index) => {
          const segmentText = String(segment.text || "");
          return {
            segment,
            id: segment.id || `${utterance.id}-bubble-s${index + 1}`,
            // The full display string was normalized once before segmentation.
            // Preserve all punctuation inside each timed replacement segment.
            text: segmentText,
            columns: Array.isArray(segment.columns) ? segment.columns : undefined,
            overlayPath: nonEmptyString(segment.overlayPath),
          };
        })
      : [{
          segment: null,
          id: utterance.bubbleId || overlaySpec.bubble?.id || `bubble-${utterance.id}`,
          text: bubbleDisplayText,
          columns: Array.isArray(overlaySpec.bubble?.columns) ? overlaySpec.bubble.columns : undefined,
          overlayPath,
        }];
    const renderedEntries = [];
    for (const [entryIndex, entry] of entries.entries()) {
      if (!String(entry.text || "").trim()) {
        throw new Error(`Speech bubble text is empty for ${utterance.id} entry ${entry.id || entryIndex + 1}.`);
      }
      const bubble = {
        ...(overlaySpec.bubble || {}),
        ...(override && typeof override === "object" ? override : {}),
        id: entry.id,
        order: utterance.order,
        text: entry.text,
        ...(entry.columns ? {
          columns: entry.columns,
          maxColumns: Math.max(1, Math.min(3, entry.columns.length)),
        } : {
          // A stale full-text column layout inherited from the spec would
          // force this entry's sizing to the whole utterance; without
          // authored columns the renderer must re-break this entry's text.
          columns: undefined,
        }),
        preset: utterance.preset,
        utteranceId: utterance.id,
        ...(utterance.preset !== "narration" && cameraAwarePlacement ? {
          target: cameraAwarePlacement.target,
          speakerProximityTargets: cameraAwarePlacement.speakerProximityTargets,
        } : {}),
      };
      delete bubble.clearAvoidRegions;
      delete bubble.avoidRegions;
      if (reflowPlacement && !(override && Object.hasOwn(override, "bounds"))) delete bubble.bounds;
      const avoidRegions = [...baseAvoidRegions, ...entryPageVisibilityRegions(entry)];
      const renderEntry = (candidateBubble) => renderSpeechBubbleSvg({
        width: frameWidth,
        height: frameHeight,
        bubbles: [candidateBubble],
        avoidRegions,
        placementHistory: sequenceAware ? placementHistory : [],
        profileId: overlaySpec.profile?.id,
        title: `${manifest.title} ${utterance.id}${entries.length > 1 ? ` segment ${entryIndex + 1}` : ""}`,
      });
      const segmentCharacterCount = Array.from(entry.text.replace(/\s/gu, "")).length;
      const compactColumnCount = !panelLayoutEnabled && hasHardFaceProtection && segmentCharacterCount >= 7
        ? segmentCharacterCount <= 10 ? 2 : 3
        : 0;
      const compactColumns = compactColumnCount > 0
        ? splitBubbleTextNaturally(
            entry.text,
            compactColumnCount,
            Math.ceil(segmentCharacterCount / compactColumnCount) + 1,
          )
        : [];
      const compactBubble = compactColumns.length === compactColumnCount
        ? { ...bubble, columns: compactColumns, maxColumns: compactColumnCount }
        : null;
      let effectiveBubble = bubble;
      let rendered;
      try {
        rendered = renderEntry(bubble);
      } catch (error) {
        if (!compactBubble || !/no collision-free placement/u.test(String(error?.message || error))) throw error;
        effectiveBubble = compactBubble;
        rendered = renderEntry(compactBubble);
      }
      let invalidTypography = rendered.quality.find((quality) => (
        quality.overflow || quality.textLoss || quality.tooSmall || quality.exactTextMatch === false
      ));
      if (invalidTypography && compactBubble && effectiveBubble !== compactBubble) {
        const compactRendered = renderEntry(compactBubble);
        const compactInvalid = compactRendered.quality.find((quality) => (
          quality.overflow || quality.textLoss || quality.tooSmall || quality.exactTextMatch === false
        ));
        if (!compactInvalid) {
          effectiveBubble = compactBubble;
          rendered = compactRendered;
          invalidTypography = null;
        }
      }
      if (invalidTypography) {
        throw new Error(
          `Speech bubble override failed typography gates for ${utterance.id}${entries.length > 1 ? ` segment ${entryIndex + 1}` : ""}: `
          + `characters=${Array.from(entry.text.replace(/\s/gu, "")).length}, overflow=${invalidTypography.overflow}, `
          + `textLoss=${invalidTypography.textLoss}, tooSmall=${invalidTypography.tooSmall}, `
          + `exactTextMatch=${invalidTypography.exactTextMatch}, placementScale=${rendered.plan?.bubbles?.[0]?.placementScale ?? 1}.`,
        );
      }
      const quality = rendered.quality[0];
      if (quality.faceOverlapRatio > 0 || quality.hardProtectedOverlapRatio > 0) {
        throw new Error(`Speech bubble ${entry.id} overlaps a protected face/head.`);
      }
      if (reflowPlacement && utterance.preset !== "narration" && !panelLayoutEnabled
        && cameraAwarePlacement?.speakerOffscreen !== true
        && quality.speakerProximitySampleCount < 9) {
        throw new Error(`Speech bubble ${entry.id} has fewer than 9 camera-interval speaker samples.`);
      }
      const plannedBubble = rendered.plan?.bubbles?.[0];
      appendHistory(entry.id, utterance.preset, plannedBubble?.bounds, frameWidth, frameHeight);
      renderedEntries.push({ ...entry, bubble: effectiveBubble, rendered, plannedBubble });
    }

    for (const entry of renderedEntries) {
      if (!entry.overlayPath) throw new Error(`Segment overlay path is missing for ${entry.id}.`);
      await writeFile(entry.overlayPath, entry.rendered.svg, "utf8");
    }
    if (existingSegments.length > 0) await writeFile(overlayPath, renderedEntries[0].rendered.svg, "utf8");
    const updatedSegments = existingSegments.length > 0
      ? renderedEntries.map((entry) => ({
          ...entry.segment,
          id: entry.id,
          text: entry.text,
          columns: entry.rendered.quality[0].columnTexts,
          overlayPath: entry.overlayPath,
          quality: entry.rendered.quality[0],
          bounds: entry.plannedBubble?.bounds || null,
          sequencePlacement: entry.plannedBubble?.sequencePlacement || null,
        }))
      : [];
    if (updatedSegments.length > 0) utterance.bubbleSegments = updatedSegments;
    const first = renderedEntries[0];
    await writeJsonAtomic(overlaySpecPath, {
      ...overlaySpec,
      displayText: bubbleDisplayText,
      bubble: first.plannedBubble || first.bubble,
      plan: first.rendered.plan,
      quality: renderedEntries.map((entry) => entry.rendered.quality[0]),
      bubbleSegments: updatedSegments,
      profile: first.rendered.profile,
      cameraAwarePlacement: panelLayoutEnabled
        ? {
            ...(overlaySpec.cameraAwarePlacement || {}),
            coordinateMode: "pre-camera-whole-page",
            motionPolicy: "whole-page",
            flattenBeforeCamera: true,
          }
        : cameraAwarePlacement,
      placementOverride: override && typeof override === "object"
        ? override
        : overlaySpec.placementOverride,
      sequencePlacement: first.plannedBubble?.sequencePlacement || null,
      sequencePlacementPolicy: "two previous visible bubbles, including segments, remain in placement history across cuts",
      speakerProtectionPolicy: panelLayoutEnabled
        ? "panel page, separators, and bubbles are flattened before one whole-page camera transform"
        : "current camera sampled >=33 times; active speaker/head overlap is a hard 0 px failure; dialogue tracks >=9 speaker points",
      refreshedAt: new Date().toISOString(),
    });
    delete utterance.rasterizedOverlayPath;
    for (const entry of renderedEntries) {
      refreshed.push({
        utteranceId: utterance.id,
        segmentId: existingSegments.length > 0 ? entry.id : null,
        bounds: entry.plannedBubble?.bounds || null,
        quality: entry.rendered.quality?.[0] || null,
        sequencePlacement: entry.plannedBubble?.sequencePlacement || null,
      });
    }
  }

  manifest.status = nonEmptyString(args.status) || "bubble-layout-ready";
  if (manifest.outputs?.reviewVideo) delete manifest.outputs.reviewVideo;
  manifest.updatedAt = new Date().toISOString();
  await writeJsonAtomic(loaded.filePath, manifest);
  return { manifest, filePath: loaded.filePath, refreshed };
}

export async function reviseEpisodeUtteranceText(args = {}) {
  const loaded = await readEpisodeManifest(args);
  const manifest = loaded.manifest;
  const utteranceId = nonEmptyString(args.utteranceId ?? args.utterance_id);
  const text = normalizeDialogueText(args.text);
  if (!utteranceId || !text) throw new Error("utteranceId and revised text are required.");
  const utterance = manifest.utterances.find((entry) => entry.id === utteranceId);
  if (!utterance) throw new Error(`Unknown utterance: ${utteranceId}.`);
  const previousText = utterance.text;
  utterance.text = text;
  utterance.speechText = applySpeechPronunciations(text, manifest.speech?.pronunciations);
  utterance.audio = null;
  utterance.timing = null;

  if (manifest.scriptPath && await pathExists(manifest.scriptPath)) {
    manifest.scriptText = await readFile(manifest.scriptPath, "utf8");
  } else if (manifest.scriptText.includes(previousText)) {
    manifest.scriptText = manifest.scriptText.replace(previousText, text);
  }

  const overlaySpecPath = nonEmptyString(utterance.overlaySpecPath);
  const overlayPath = nonEmptyString(utterance.overlayPath);
  const overlaySpec = overlaySpecPath ? await readJsonIfExists(overlaySpecPath) : null;
  if (overlaySpec && overlayPath) {
    const bubble = { ...(overlaySpec.bubble || {}), text };
    delete bubble.columns;
    delete bubble.bounds;
    const rendered = renderSpeechBubbleSvg({
      width: overlaySpec.imageSize?.width || manifest.video?.width || DEFAULT_VIDEO_WIDTH,
      height: overlaySpec.imageSize?.height || manifest.video?.height || DEFAULT_VIDEO_HEIGHT,
      bubbles: [bubble],
      avoidRegions: Array.isArray(overlaySpec.avoidRegions) ? overlaySpec.avoidRegions : [],
      profileId: overlaySpec.profile?.id,
      title: `${manifest.title} ${utterance.id}`,
    });
    const invalidTypography = rendered.quality.find((entry) => (
      entry.overflow || entry.textLoss || entry.tooSmall || entry.exactTextMatch === false
    ));
    if (invalidTypography) throw new Error(`Revised speech bubble typography failed for ${utteranceId}.`);
    await writeFile(overlayPath, rendered.svg, "utf8");
    await writeJsonAtomic(overlaySpecPath, {
      ...overlaySpec,
      bubble,
      plan: rendered.plan,
      quality: rendered.quality,
      profile: rendered.profile,
      revisedAt: new Date().toISOString(),
    });
  }

  manifest.status = "speech-partial";
  manifest.outputs = {};
  manifest.updatedAt = new Date().toISOString();
  await writeJsonAtomic(loaded.filePath, manifest);
  return { manifest, filePath: loaded.filePath, utterance };
}

async function reusableEpisodeSpeechAsset(canvasDir, fileName, utterance, inputHash = "") {
  const filePath = join(canvasDir, "assets", "audio", fileName);
  const alignmentFileName = `${fileName}.json`;
  const alignmentPath = join(canvasDir, "audio-alignments", alignmentFileName);
  if (!await pathExists(filePath)) return null;
  const sidecar = await readJsonIfExists(alignmentPath);
  const expectedSpeechText = nonEmptyString(utterance.speechText) || utterance.text;
  const expectedPerformancePrompt = nonEmptyString(utterance.performancePrompt ?? utterance.performance_prompt);
  if (!sidecar || (sidecar.displayText || sidecar.text) !== utterance.text) return null;
  if ((sidecar.speechText || sidecar.text) !== expectedSpeechText) return null;
  if (nonEmptyString(sidecar.performancePrompt) !== expectedPerformancePrompt) return null;
  if (utterance.voiceId && sidecar.voiceId !== utterance.voiceId) return null;
  if (utterance.model && sidecar.model !== utterance.model) return null;
  if (sidecar.inputHash && inputHash && sidecar.inputHash !== inputHash) return null;
  return speechAssetPublicResult({
    ...sidecar,
    inputHash: sidecar.inputHash || inputHash,
    utteranceId: utterance.id,
    voiceName: utterance.voiceName || sidecar.voiceName,
    fileName,
    filePath,
    assetUrl: `/excalidraw-assets/audio/${encodeURIComponent(fileName)}`,
    alignmentFileName,
    alignmentPath,
    mimeType: /\.wav$/iu.test(fileName) ? "audio/wav" : "audio/mpeg",
  });
}

export async function generateEpisodeSpeech(args = {}) {
  const { manifest, filePath } = args.manifest
    ? { manifest: structuredClone(args.manifest), filePath: nonEmptyString(args.manifestPath) || manifestFilePath(args, args.manifest.id) }
    : await readEpisodeManifest(args);
  const storedConfig = await loadElevenLabsConfig();
  const defaultVoiceId = nonEmptyString(args.voiceId) || manifest.defaultVoiceId || storedConfig.defaultVoiceId;
  const defaultVoiceName = nonEmptyString(args.voiceName) || manifest.defaultVoiceName || storedConfig.defaultVoiceName;
  const startedAt = Date.now();
  const speechConcurrency = normalizeConcurrency(
    args.speechConcurrency ?? args.speech_concurrency ?? manifest.video?.speechConcurrency,
    DEFAULT_SPEECH_CONCURRENCY,
    MAX_SPEECH_CONCURRENCY,
  );
  const speechWriter = typeof args.writeSpeechAssetImpl === "function"
    ? args.writeSpeechAssetImpl
    : writeSpeechAsset;
  const requestedUtteranceIds = new Set(
    (Array.isArray(args.utteranceIds)
      ? args.utteranceIds
      : nonEmptyString(args.utteranceIds ?? args.utterance_ids).split(","))
      .map((value) => nonEmptyString(value))
      .filter(Boolean),
  );
  const jobs = ensureEpisodeJobs(manifest);
  const checkpoint = manifestCheckpointWriter(filePath, manifest);
  const plans = [];

  for (let index = 0; index < manifest.utterances.length; index += 1) {
    const utterance = manifest.utterances[index];
    if (requestedUtteranceIds.size > 0 && !requestedUtteranceIds.has(utterance.id)) continue;
    // Keep display punctuation independent from the provider input. An
    // authored speech override can lock proper-name readings and sentence
    // release without changing the bubble text; otherwise pronunciation
    // profiles are rebuilt deterministically from the immutable display text.
    const speechText = nonEmptyString(utterance.speechOverride ?? utterance.speech_override)
      || applySpeechPronunciations(utterance.text, manifest.speech?.pronunciations);
    utterance.speechText = speechText;
    const performancePrompt = nonEmptyString(
      utterance.performancePrompt ?? utterance.performance_prompt,
    );
    const providerText = performancePrompt ? `${performancePrompt} ${speechText}` : speechText;
    const episodeAudioFileName = sanitizeFileName(
      utterance.audioFileName || `${slug(manifest.id)}-${utterance.id}.mp3`,
      `${slug(manifest.id)}-${utterance.id}.mp3`,
    );
    const speechModel = nonEmptyString(args.model) || utterance.model || manifest.model || DEFAULT_SPEECH_MODEL;
    const speechInput = {
      ...args,
      writeSpeechAssetImpl: undefined,
      canvasDir: resolveCanvasDir(args),
      utteranceId: utterance.id,
      text: providerText,
      displayText: utterance.text,
      speechText,
      performancePrompt,
      // An explicit call-level voice is a deliberate audition/replacement and
      // must override a voice already stored in the manifest. Without this,
      // `--voice-id` could never repair a poorly matched premade voice.
      voiceId: nonEmptyString(args.voiceId) || utterance.voiceId || defaultVoiceId,
      voiceName: nonEmptyString(args.voiceName) || utterance.voiceName || defaultVoiceName,
      model: speechModel,
      stability: args.stability === undefined
        ? finiteNumber(utterance.voiceSettings?.stability, 0.7)
        : finiteNumber(args.stability, 0.7),
      similarityBoost: args.similarityBoost === undefined
        ? finiteNumber(utterance.voiceSettings?.similarityBoost, 0.75)
        : finiteNumber(args.similarityBoost, 0.75),
      speed: args.speed === undefined
        ? finiteNumber(utterance.voiceSettings?.speed, 1)
        : finiteNumber(args.speed, 1),
      useSpeakerBoost: args.useSpeakerBoost === undefined
        ? utterance.voiceSettings?.useSpeakerBoost !== false
        : args.useSpeakerBoost !== false,
      previousText: index > 0
        ? applySpeechPronunciations(manifest.utterances[index - 1].text, manifest.speech?.pronunciations)
        : "",
      nextText: index < manifest.utterances.length - 1
        ? applySpeechPronunciations(manifest.utterances[index + 1].text, manifest.speech?.pronunciations)
        : "",
      previousRequestIds: index > 0
        && manifest.utterances[index - 1].audio?.requestId
        && manifest.utterances[index - 1].audio?.model === speechModel
        ? [manifest.utterances[index - 1].audio.requestId]
        : [],
      nextRequestIds: index < manifest.utterances.length - 1
        && manifest.utterances[index + 1].audio?.requestId
        && manifest.utterances[index + 1].audio?.model === speechModel
        ? [manifest.utterances[index + 1].audio.requestId]
        : [],
      applyLanguageTextNormalization: true,
      fileName: episodeAudioFileName,
    };
    if (!speechInput.voiceId) {
      throw new Error(`An ElevenLabs voice is required for ${utterance.id}.`);
    }
    const inputHash = mangaVideoJobInputHash("speech", {
      utteranceId: utterance.id,
      displayText: utterance.text,
      speechText,
      providerText,
      performancePrompt,
      model: speechInput.model,
      voiceId: speechInput.voiceId,
      stability: speechInput.stability,
      similarityBoost: speechInput.similarityBoost,
      speed: speechInput.speed,
      useSpeakerBoost: speechInput.useSpeakerBoost,
      previousText: speechInput.previousText,
      nextText: speechInput.nextText,
      applyLanguageTextNormalization: true,
    });
    const previousJob = jobs.speech[utterance.id];
    jobs.speech[utterance.id] = {
      ...(previousJob?.inputHash === inputHash ? previousJob : {}),
      id: `speech:${manifest.id}:${utterance.id}`,
      kind: "speech",
      inputHash,
      utteranceId: utterance.id,
      status: "queued",
      attempts: previousJob?.inputHash === inputHash
        ? Math.max(0, Math.round(finiteNumber(previousJob.attempts, 0)))
        : 0,
      queuedAt: new Date().toISOString(),
    };
    plans.push({ index, utterance, speechInput: { ...speechInput, inputHash }, inputHash, episodeAudioFileName });
  }

  manifest.video = { ...(manifest.video || {}), speechConcurrency };
  manifest.updatedAt = new Date().toISOString();
  await checkpoint();

  const outcomes = await runWithConcurrency(plans, speechConcurrency, async (plan) => {
    const { utterance, speechInput, inputHash, episodeAudioFileName } = plan;
    const job = jobs.speech[utterance.id];
    const finishReuse = async (audio, source) => {
      utterance.voiceId = speechInput.voiceId;
      utterance.voiceName = speechInput.voiceName;
      utterance.model = speechInput.model;
      utterance.audio = { ...speechAssetPublicResult(audio), inputHash };
      Object.assign(job, {
        status: "complete",
        reused: true,
        cacheSource: source,
        outputPath: utterance.audio.filePath,
        elapsedMs: 0,
        finishedAt: new Date().toISOString(),
        error: "",
      });
      manifest.updatedAt = new Date().toISOString();
      await checkpoint();
      return { ok: true, reused: true, utteranceId: utterance.id, audio: utterance.audio, retryCount: 0 };
    };

    if (args.force !== true && utterance.audio?.filePath && await pathExists(utterance.audio.filePath)) {
      const audioHashMatches = !utterance.audio.inputHash || utterance.audio.inputHash === inputHash;
      const audioIdentityMatches = (!utterance.audio.voiceId || utterance.audio.voiceId === speechInput.voiceId)
        && (!utterance.audio.model || utterance.audio.model === speechInput.model)
        && (!utterance.audio.speechText || utterance.audio.speechText === speechInput.speechText)
        && (!utterance.audio.providerText || utterance.audio.providerText === speechInput.text)
        && nonEmptyString(utterance.audio.performancePrompt) === speechInput.performancePrompt
        && (!utterance.audio.displayText || utterance.audio.displayText === utterance.text);
      if (audioHashMatches && audioIdentityMatches) return finishReuse(utterance.audio, "manifest");
    }

    if (args.force !== true) {
      const reusableAudio = await reusableEpisodeSpeechAsset(
        resolveCanvasDir(args),
        episodeAudioFileName,
        { ...utterance, voiceId: speechInput.voiceId, model: speechInput.model },
        inputHash,
      );
      if (reusableAudio) return finishReuse(reusableAudio, "sidecar");
    }

    job.status = "running";
    job.reused = false;
    job.startedAt = new Date().toISOString();
    job.error = "";
    let generated = null;
    let lastError = null;
    let attemptsThisRun = 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      attemptsThisRun += 1;
      job.attempts += 1;
      try {
        generated = await speechWriter(speechInput);
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!generated) {
      const error = lastError?.message || String(lastError);
      Object.assign(job, {
        status: "failed",
        elapsedMs: Date.now() - new Date(job.startedAt).getTime(),
        finishedAt: new Date().toISOString(),
        error,
      });
      manifest.updatedAt = new Date().toISOString();
      await checkpoint();
      return { ok: false, utteranceId: utterance.id, error, retryCount: Math.max(0, attemptsThisRun - 1) };
    }
    utterance.voiceId = generated.voiceId || speechInput.voiceId;
    utterance.voiceName = generated.voiceName || speechInput.voiceName;
    utterance.model = generated.model || speechInput.model;
    utterance.audio = { ...speechAssetPublicResult(generated), inputHash };
    Object.assign(job, {
      status: "complete",
      outputPath: utterance.audio.filePath,
      elapsedMs: Date.now() - new Date(job.startedAt).getTime(),
      finishedAt: new Date().toISOString(),
      error: "",
    });
    manifest.updatedAt = new Date().toISOString();
    await checkpoint();
    return {
      ok: true,
      utteranceId: utterance.id,
      audio: utterance.audio,
      retryCount: Math.max(0, attemptsThisRun - 1),
    };
  });

  const results = outcomes.map((outcome, index) => {
    if (outcome.ok) return outcome.value;
    const plan = plans[index];
    const error = outcome.error || "Unknown speech worker failure.";
    if (plan) {
      Object.assign(jobs.speech[plan.utterance.id], {
        status: "failed",
        finishedAt: new Date().toISOString(),
        error,
      });
    }
    return { ok: false, utteranceId: plan?.utterance.id || "", error, retryCount: 0 };
  });
  const failedCount = results.filter((result) => !result.ok).length;
  const retryCount = results.reduce((total, result) => total + finiteNumber(result.retryCount, 0), 0);
  manifest.defaultVoiceId = defaultVoiceId;
  manifest.defaultVoiceName = defaultVoiceName;
  manifest.status = failedCount > 0 ? "speech-partial" : "speech-ready";
  manifest.metrics = {
    ...(manifest.metrics || {}),
    generationElapsedMs: finiteNumber(manifest.metrics?.generationElapsedMs, 0) + (Date.now() - startedAt),
    retryCount: finiteNumber(manifest.metrics?.retryCount, 0) + retryCount,
    failedCount,
    audioDurationSeconds: manifest.utterances.reduce((total, utterance) => total + finiteNumber(utterance.audio?.durationSeconds, 0), 0),
    characterCost: manifest.utterances.reduce((total, utterance) => total + finiteNumber(utterance.audio?.characterCost, 0), 0),
  };
  manifest.updatedAt = new Date().toISOString();
  await checkpoint();
  return { manifest, filePath, results, failedCount, retryCount, concurrency: speechConcurrency };
}

// Balloon segments carry display text, which can differ from the spoken text
// wherever a script glosses a reading. Indexes are therefore scaled onto the
// spoken timeline rather than assumed to match one-to-one.
export function bubbleSegmentSpeechBoundaries(utterance, segments) {
  const timeline = utterance?.audio?.characterTimeline;
  if (!Array.isArray(timeline) || timeline.length === 0) return null;
  const lengths = segments.map((segment) => Array.from(String(segment?.text || "")).length);
  const total = lengths.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return null;
  const scale = timeline.length / total;
  const rows = [];
  let consumed = 0;
  for (const length of lengths) {
    const firstIndex = Math.min(timeline.length - 1, Math.max(0, Math.round(consumed * scale)));
    consumed += length;
    const lastIndex = Math.min(timeline.length - 1, Math.max(firstIndex, Math.round(consumed * scale) - 1));
    const startSeconds = Number(timeline[firstIndex]?.startSeconds);
    const endSeconds = Number(timeline[lastIndex]?.endSeconds);
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds < startSeconds) return null;
    rows.push({ startSeconds, endSeconds });
  }
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index].startSeconds < rows[index - 1].startSeconds) return null;
  }
  return rows;
}

export function proportionalSegmentBoundaries(segments, speechStart, speechDuration) {
  const weights = segments.map((segment) => Math.max(
    1,
    Array.from(String(segment?.text || "").replace(/\s/gu, "")).length,
  ));
  const total = weights.reduce((sum, value) => sum + value, 0);
  const rows = [];
  let consumed = 0;
  for (const weight of weights) {
    const startSeconds = speechStart + speechDuration * consumed / total;
    consumed += weight;
    rows.push({ startSeconds, endSeconds: speechStart + speechDuration * consumed / total });
  }
  return rows;
}

export function compileEpisodeTiming(manifestInput, options = {}) {
  const manifest = structuredClone(manifestInput);
  // CLI/MCP adapters intentionally keep optional keys present with an
  // `undefined` value. Do not let those erase authored manifest timing rules
  // when a later render only overrides an unrelated option.
  const definedOptions = Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined),
  );
  const settings = { ...(manifest.video || {}), ...definedOptions };
  const preRoll = clamp(settings.preRollSeconds, 0, 3, 0.12);
  const legacyGap = clamp(settings.interUtteranceGapSeconds, 0, 3, 0.2);
  const sameSpeakerGap = settings.sameSpeakerGapSeconds === undefined
    ? legacyGap
    : clamp(settings.sameSpeakerGapSeconds, 0, 3, 0.17);
  const speakerChangeGap = settings.speakerChangeGapSeconds === undefined
    ? legacyGap
    : clamp(settings.speakerChangeGapSeconds, 0, 3, 0.3);
  const emphasisGap = settings.emphasisGapSeconds === undefined
    ? speakerChangeGap
    : clamp(settings.emphasisGapSeconds, 0, 3, 0.5);
  const bubbleLead = clamp(settings.bubbleLeadSeconds, 0, 2, 0.1);
  const bubbleHold = clamp(settings.bubbleHoldSeconds, 0, 3, 0.25);
  const requestedTransitionGap = clamp(
    settings.bubbleTransitionGapSeconds,
    0,
    1,
    1 / Math.max(12, finiteNumber(settings.fps, DEFAULT_VIDEO_FPS)),
  );
  const transitionCrossfade = clamp(settings.bubbleTransitionCrossfadeSeconds, 0, 0.5, 0);
  // ffmpeg's between(t,start,end) is inclusive and each cut is quantized to
  // whole frames before concat. A one-frame authored gap can therefore land
  // on the old fade-out frame in one cut and the new alpha-zero frame in the
  // next, leaving no actually clear encoded frame. Always reserve two frame
  // periods so at least one decoded frame is free of both overlays.
  const minimumEncodedClearGap = 2
    / Math.max(12, finiteNumber(settings.fps, DEFAULT_VIDEO_FPS));
  const transitionGap = transitionCrossfade > 0
    ? requestedTransitionGap
    : Math.max(requestedTransitionGap, minimumEncodedClearGap);
  const cutTail = clamp(settings.cutTailSeconds, 0, 3, 0.35);
  const utterancesById = new Map(manifest.utterances.map((utterance) => [utterance.id, utterance]));
  let episodeCursor = 0;
  for (const cut of manifest.cuts) {
    let cutCursor = preRoll;
    const timedCutUtterances = [];
    for (const [utteranceIndex, utteranceId] of cut.utteranceIds.entries()) {
      const utterance = utterancesById.get(utteranceId);
      const duration = finiteNumber(utterance?.audio?.durationSeconds, 0);
      if (!utterance || duration <= 0 || !utterance.audio?.filePath) {
        throw new Error(`Missing generated audio for ${utteranceId}.`);
      }
      const previousUtterance = timedCutUtterances.at(-1) || null;
      const explicitGap = finiteNumber(
        utterance.pauseBeforeSeconds ?? utterance.pause_before_seconds,
        NaN,
      );
      const pauseClass = nonEmptyString(utterance.pauseClass ?? utterance.pause_class).toLowerCase();
      const gapBeforeSeconds = utteranceIndex === 0
        ? 0
        : Number.isFinite(explicitGap)
          // A small negative file gap is valid when approved WAVs contain
          // click-safe silent head/tail padding. It overlaps silence, never
          // speech, and lets the audible speech-to-speech gap match the
          // authored target without destructively trimming approved PCM.
          ? clamp(explicitGap, -0.25, 3, sameSpeakerGap)
          : pauseClass === "emphasis"
            ? emphasisGap
            : previousUtterance?.speakerId !== utterance.speakerId
              ? speakerChangeGap
              : sameSpeakerGap;
      cutCursor += gapBeforeSeconds;
      const speechStart = finiteNumber(utterance.audio.speechStartSeconds, 0);
      const speechEnd = finiteNumber(utterance.audio.speechEndSeconds, duration);
      // Approved WAVs can retain click-safe head/release padding that is
      // intentionally wider than the provider speech bounds. A visual-only
      // override lets bubbles follow the measured audible waveform without
      // trimming, regenerating, or otherwise changing approved audio.
      const bubbleSpeechStart = finiteNumber(
        utterance.bubbleTiming?.speechStartSeconds ?? utterance.bubble_timing?.speech_start_seconds,
        speechStart,
      );
      const bubbleSpeechEnd = finiteNumber(
        utterance.bubbleTiming?.speechEndSeconds ?? utterance.bubble_timing?.speech_end_seconds,
        speechEnd,
      );
      if (bubbleSpeechStart < 0 || bubbleSpeechEnd <= bubbleSpeechStart || bubbleSpeechEnd > duration) {
        throw new Error(`Invalid visual speech bounds for ${utterance.id}: ${bubbleSpeechStart}..${bubbleSpeechEnd}.`);
      }
      utterance.timing = {
        gapBeforeSeconds,
        audioStartInCutSeconds: cutCursor,
        audioEndInCutSeconds: cutCursor + duration,
        bubbleStartInCutSeconds: Math.max(0, cutCursor + bubbleSpeechStart - bubbleLead),
        bubbleEndInCutSeconds: Math.min(cutCursor + duration + bubbleHold, cutCursor + bubbleSpeechEnd + bubbleHold),
        audioStartSeconds: episodeCursor + cutCursor,
        audioEndSeconds: episodeCursor + cutCursor + duration,
        bubbleStartSeconds: episodeCursor + Math.max(0, cutCursor + bubbleSpeechStart - bubbleLead),
        bubbleEndSeconds: episodeCursor + Math.min(cutCursor + duration + bubbleHold, cutCursor + bubbleSpeechEnd + bubbleHold),
      };
      const bubbleSegments = Array.isArray(utterance.bubbleSegments)
        ? utterance.bubbleSegments.filter((segment) => nonEmptyString(segment?.text))
        : [];
      // Offsets the pipeline computed before are stale as soon as the audio is
      // re-split, so anything carrying a timingPolicy is recomputed rather than
      // trusted. Hand-authored segments carry no policy and are left alone.
      if (bubbleSegments.length > 1 && bubbleSegments.some((segment) => (
        segment.autoTiming === true
        || nonEmptyString(segment.timingPolicy)
        || !Number.isFinite(Number(segment.startOffsetSeconds))
        || !Number.isFinite(Number(segment.endOffsetSeconds))
      ))) {
        const segmentGap = 2 / Math.max(12, finiteNumber(settings.fps, DEFAULT_VIDEO_FPS));
        const speechDuration = Math.max(0.001, speechEnd - speechStart);
        const bubbleStartOffset = utterance.timing.bubbleStartInCutSeconds - cutCursor;
        const bubbleEndOffset = utterance.timing.bubbleEndInCutSeconds - cutCursor;
        // Prefer the voice's own per-character timeline. Character-count
        // interpolation assumes a constant speaking rate, so on a long line a
        // pause or an emphasised word pushes every later balloon out of sync
        // with what is actually being said.
        const measured = bubbleSegmentSpeechBoundaries(utterance, bubbleSegments);
        const boundaries = measured
          || proportionalSegmentBoundaries(bubbleSegments, speechStart, speechDuration);
        for (const [segmentIndex, segment] of bubbleSegments.entries()) {
          segment.startOffsetSeconds = Number((segmentIndex === 0
            ? bubbleStartOffset
            : boundaries[segmentIndex].startSeconds + segmentGap / 2).toFixed(4));
          segment.endOffsetSeconds = Number((segmentIndex === bubbleSegments.length - 1
            ? bubbleEndOffset
            : boundaries[segmentIndex].endSeconds - segmentGap / 2).toFixed(4));
          segment.timingPolicy = measured
            ? "provider-character-timeline-v1"
            : "proportional-character-count-v1";
        }
        utterance.bubbleSegments = bubbleSegments;
      }
      if (previousUtterance?.timing) previousUtterance.timing.gapAfterSeconds = gapBeforeSeconds;
      timedCutUtterances.push(utterance);
      cutCursor += duration;
    }
    for (let index = 0; index < timedCutUtterances.length - 1; index += 1) {
      const current = timedCutUtterances[index];
      const next = timedCutUtterances[index + 1];
      const retainBubbleThroughNext = current.retainBubbleThroughNext === true
        || current.retain_bubble_through_next === true;
      if (retainBubbleThroughNext) {
        // Some manga edits intentionally keep the previous balloon visible
        // while the next line appears on the same illustration.  This is an
        // authored editorial choice, so it takes precedence over the default
        // replacement crossfade/gap normalization below.
        current.timing.bubbleEndInCutSeconds = Math.max(
          current.timing.bubbleEndInCutSeconds,
          next.timing.bubbleEndInCutSeconds,
        );
        current.timing.bubbleEndSeconds = episodeCursor + current.timing.bubbleEndInCutSeconds;
        continue;
      }
      if (transitionCrossfade > 0) {
        current.timing.bubbleEndInCutSeconds = Math.max(
          current.timing.bubbleStartInCutSeconds,
          next.timing.bubbleStartInCutSeconds + transitionCrossfade,
        );
        current.timing.bubbleEndSeconds = episodeCursor + current.timing.bubbleEndInCutSeconds;
        continue;
      }
      const exclusiveEnd = Math.max(
        current.timing.bubbleStartInCutSeconds,
        next.timing.bubbleStartInCutSeconds - transitionGap,
      );
      current.timing.bubbleEndInCutSeconds = Math.min(current.timing.bubbleEndInCutSeconds, exclusiveEnd);
      current.timing.bubbleEndSeconds = episodeCursor + current.timing.bubbleEndInCutSeconds;
    }
    if (timedCutUtterances.at(-1)?.timing) timedCutUtterances.at(-1).timing.gapAfterSeconds = cutTail;
    const rawDurationSeconds = Math.max(1, cutCursor + cutTail);
    const fps = Math.max(12, finiteNumber(settings.fps, DEFAULT_VIDEO_FPS));
    // Koya masters are concatenations of independently encoded 30 fps cuts.
    // If the manifest keeps sub-frame cut durations, every encoded cut rounds
    // upward and the absolute audio/bubble clock drifts farther on each join.
    // Align the authored cut clock to the exact encoded frame boundary so the
    // final MP4 and every independent audit sample the same timeline.
    const durationSeconds = settings.frameAlignCutDurations === true
      ? Math.ceil(rawDurationSeconds * fps - 1e-7) / fps
      : rawDurationSeconds;
    cut.timing = {
      startSeconds: episodeCursor,
      endSeconds: episodeCursor + durationSeconds,
      durationSeconds,
    };
    episodeCursor += durationSeconds;
  }
  manifest.video = {
    ...(manifest.video || {}),
    ...settings,
    bubbleTransitionGapSeconds: transitionGap,
  };
  manifest.metrics = { ...(manifest.metrics || {}), videoDurationSeconds: episodeCursor };
  manifest.status = "timed";
  manifest.updatedAt = new Date().toISOString();
  return manifest;
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, options.timeoutMs)
      : null;
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      if (timedOut) {
        rejectPromise(new Error(`${command} timed out after ${options.timeoutMs}ms`));
        return;
      }
      if (code === 0) resolvePromise({ stdout, stderr });
      else rejectPromise(new Error(`${command} exited with ${code}: ${stderr.slice(-3000)}`));
    });
  });
}

function parseLoudnormMeasurement(stderr) {
  const blocks = String(stderr || "").match(/\{[\s\S]*?"input_i"[\s\S]*?\}/gu) || [];
  if (blocks.length === 0) throw new Error("FFmpeg loudnorm analysis returned no measurement JSON.");
  const measured = JSON.parse(blocks.at(-1));
  for (const key of ["input_i", "input_lra", "input_tp", "input_thresh", "target_offset"]) {
    if (!Number.isFinite(Number(measured[key]))) throw new Error(`Invalid loudnorm measurement: ${key}`);
  }
  return measured;
}

function peakSafeConstantGain(measured, targetI, targetTp, safetyDb = 0.3) {
  const inputI = Number(measured.input_i);
  const inputTp = Number(measured.input_tp);
  const requestedGainDb = targetI - inputI;
  const peakLimitedGainDb = targetTp - inputTp - safetyDb;
  const appliedGainDb = Math.min(requestedGainDb, peakLimitedGainDb);
  if (!Number.isFinite(appliedGainDb)) throw new Error("Unable to calculate peak-safe master gain.");
  return {
    ...measured,
    requestedGainDb,
    peakLimitedGainDb,
    appliedGainDb,
    peakSafetyDb: safetyDb,
    predictedIntegratedLufs: inputI + appliedGainDb,
    predictedTruePeakDb: inputTp + appliedGainDb,
    normalization_type: "constant-peak-safe",
  };
}

function constantGainFilter(measurement) {
  return `volume=${Number(measurement.appliedGainDb).toFixed(3)}dB`;
}

async function chromeExecutablePath() {
  const candidates = [
    nonEmptyString(process.env.BUZZASSIST_CHROME_PATH),
    process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "",
    process.platform === "darwin" ? "/Applications/Chromium.app/Contents/MacOS/Chromium" : "",
    process.platform === "darwin" ? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" : "",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return "";
}

async function runChromeScreenshot(chromePath, args, pngPath, timeoutMs = 45_000) {
  await unlink(pngPath).catch(() => {});
  const detached = process.platform !== "win32";
  const child = spawn(chromePath, args, {
    env: process.env,
    stdio: ["ignore", "ignore", "ignore"],
    detached,
  });
  const terminateTree = (signal) => {
    try {
      if (detached) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      try { child.kill(signal); } catch {}
    }
  };
  let spawnError = null;
  let closed = false;
  const closedPromise = new Promise((resolvePromise) => {
    child.once("error", (error) => {
      spawnError = error;
      resolvePromise();
    });
    child.once("close", resolvePromise);
  }).finally(() => { closed = true; });
  const startedAt = Date.now();
  let previousSize = -1;
  let stableChecks = 0;
  while (Date.now() - startedAt < timeoutMs) {
    if (spawnError) throw spawnError;
    let size = 0;
    try {
      size = (await stat(pngPath)).size;
    } catch {
      size = 0;
    }
    if (size > 0 && size === previousSize) stableChecks += 1;
    else stableChecks = 0;
    previousSize = size;
    if (stableChecks >= 2) {
      // Chrome can expose the screenshot file before SVG vertical-writing and
      // local Japanese font shaping have completed.  Give the headless page
      // its virtual-time budget before terminating a lingering browser;
      // otherwise the partially painted fallback looks like horizontal text
      // spilling out of the balloon.
      await Promise.race([closedPromise, new Promise((resolvePromise) => setTimeout(resolvePromise, 2_500))]);
      // Chrome can leave its browser process alive after the launcher has
      // reported a completed screenshot. Isolating the job in its own process
      // group lets us clean up the complete browser tree deterministically.
      terminateTree("SIGTERM");
      await Promise.race([closedPromise, new Promise((resolvePromise) => setTimeout(resolvePromise, 500))]);
      if (!closed && child.exitCode === null) terminateTree("SIGKILL");
      return pngPath;
    }
    if (closed && size === 0) throw new Error(`${chromePath} exited before writing ${pngPath}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
  }
  terminateTree("SIGTERM");
  await Promise.race([closedPromise, new Promise((resolvePromise) => setTimeout(resolvePromise, 500))]);
  if (!closed && child.exitCode === null) {
    terminateTree("SIGKILL");
    await Promise.race([closedPromise, new Promise((resolvePromise) => setTimeout(resolvePromise, 500))]);
  }
  throw new Error(`${chromePath} did not finish screenshot ${pngPath} within ${timeoutMs}ms`);
}

async function rasterizeSvg(svgPath, pngPath) {
  const chromePath = await chromeExecutablePath();
  if (chromePath) {
    try {
      const source = await readFile(svgPath, "utf8");
      const width = Math.max(1, Math.round(finiteNumber(source.match(/<svg[^>]*\bwidth=["']([0-9.]+)/i)?.[1], DEFAULT_VIDEO_WIDTH)));
      const height = Math.max(1, Math.round(finiteNumber(source.match(/<svg[^>]*\bheight=["']([0-9.]+)/i)?.[1], DEFAULT_VIDEO_HEIGHT)));
      // NOTE: --run-all-compositor-stages-before-draw makes Chrome 151+
      // hang at exit after the screenshot is written, which stalled whole
      // renders and silently degraded typography via the sips fallback
      // (ledger R64). Never re-add it.
      // Plain --headless (not =new): on Chrome 151 the =new mode never
      // exits after writing the screenshot and its helper tree escapes the
      // process-group kill, so zombies accumulate until fresh launches time
      // out mid-render. Plain --headless exits cleanly by itself.
      await runChromeScreenshot(chromePath, [
        "--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
        "--no-first-run", "--disable-extensions", "--virtual-time-budget=1500",
        `--user-data-dir=${join(dirname(pngPath), `.chrome-${process.pid}-${basename(pngPath)}`)}`,
        "--default-background-color=00000000", `--window-size=${width},${height}`,
        `--screenshot=${pngPath}`, `file://${resolve(svgPath)}`,
      ], pngPath);
      if ((await stat(pngPath)).size > 0) return pngPath;
    } catch (error) {
      // Surface the actual Chrome failure before falling through — silent
      // fallbacks hid the R64 regression for a whole render cycle.
      console.error(`[rasterizeSvg] chrome failed for ${basename(svgPath)}: ${error instanceof Error ? error.message : error}`);
    }
  }
  try {
    await runCommand("rsvg-convert", ["-o", pngPath, svgPath]);
    return pngPath;
  } catch {
    try {
      await runCommand("magick", [svgPath, pngPath]);
      return pngPath;
    } catch {
      if (process.platform === "darwin") {
        // sips cannot render the per-glyph vertical typography (no
        // dominant-baseline / vert feature support) — glyph columns come out
        // skewed and overlapping. Failing loudly beats shipping broken text.
        const source = await readFile(svgPath, "utf8");
        if (source.includes("explicit-vertical-glyph")) {
          throw new Error(
            `No capable SVG rasterizer for vertical-glyph overlay ${svgPath}: `
            + "Chrome headless failed and rsvg-convert/magick are unavailable. "
            + "Fix Chrome or `brew install librsvg` — sips output is not acceptable for speech bubbles.",
          );
        }
        await runCommand("sips", ["-s", "format", "png", svgPath, "--out", pngPath]);
        return pngPath;
      }
      throw new Error("SVG rasterization requires Chrome/Chromium, rsvg-convert, or ImageMagick.");
    }
  }
}

async function rasterizeSvgIfFresh(svgPath, pngPath) {
  try {
    const [source, target] = await Promise.all([stat(svgPath), stat(pngPath)]);
    if (target.isFile() && target.size > 0 && target.mtimeMs >= source.mtimeMs) return pngPath;
  } catch {
    // Missing or stale raster: render it below.
  }
  return rasterizeSvg(svgPath, pngPath);
}

async function ensureRasterSize(pngPath, width, height) {
  const size = await imagePixelSize(pngPath);
  if (size.width === width && size.height === height) return pngPath;
  const resizedPath = `${pngPath}.resize.png`;
  await runCommand("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", pngPath,
    "-vf", `scale=${width}:${height}:flags=lanczos`,
    "-frames:v", "1",
    resizedPath,
  ]);
  await rename(resizedPath, pngPath);
  return pngPath;
}

async function rasterizeSvgAtSizeIfFresh(svgPath, pngPath, width, height) {
  await rasterizeSvgIfFresh(svgPath, pngPath);
  return ensureRasterSize(pngPath, width, height);
}

async function rasterizeEpisodeOverlays(
  utterances,
  workDir,
  concurrency = DEFAULT_RENDER_CONCURRENCY,
  width = DEFAULT_VIDEO_WIDTH,
  height = DEFAULT_VIDEO_HEIGHT,
) {
  const pending = utterances.flatMap((utterance) => {
    const segments = Array.isArray(utterance.bubbleSegments)
      ? utterance.bubbleSegments.filter((segment) => nonEmptyString(segment?.overlayPath))
      : [];
    if (segments.length > 0) {
      return segments.map((segment, index) => ({
        id: nonEmptyString(segment.id) || `${utterance.id}-bubble-${index + 1}`,
        overlayPath: segment.overlayPath,
        target: segment,
      }));
    }
    return nonEmptyString(utterance.overlayPath)
      ? [{ id: utterance.id, overlayPath: utterance.overlayPath, target: utterance }]
      : [];
  });
  if (pending.length === 0) return;
  const outcomes = await runWithConcurrency(pending, concurrency, async (entry) => {
    const outputPath = join(workDir, `${entry.id}.png`);
    // Reuse only a non-empty raster that is at least as new as its SVG source.
    // This preserves fail-closed invalidation while avoiding a duplicate Chrome
    // pass between episode preflight and the per-cut renderer.
    await rasterizeSvgAtSizeIfFresh(entry.overlayPath, outputPath, width, height);
    entry.target.rasterizedOverlayPath = outputPath;
    return outputPath;
  });
  const failures = outcomes.filter((outcome) => !outcome.ok).map((outcome) => outcome.error);
  if (failures.length > 0) {
    throw new Error(`Failed to rasterize ${failures.length} speech overlay(s): ${failures.join("\n")}`);
  }
}

function ffmpegSeconds(value) {
  // Three decimals turn exact 30 fps boundaries such as 44.466666… into
  // 44.467. FFmpeg then emits 1335 frames instead of the authored 1334 and
  // shifts every later audio window. Microsecond precision preserves the
  // exact frame count while staying readable in filter graphs.
  return Math.max(0, finiteNumber(value, 0)).toFixed(6);
}

export function overlayTranslationFilter(renderOffset = {}) {
  const offsetX = Math.round(finiteNumber(renderOffset.x, 0));
  const offsetY = Math.round(finiteNumber(renderOffset.y, 0));
  if (offsetX === 0 && offsetY === 0) return "";
  const horizontalPadding = Math.abs(offsetX);
  const verticalPadding = Math.abs(offsetY);
  return [
    `pad=w=iw+${horizontalPadding}:h=ih+${verticalPadding}:x=${Math.max(0, offsetX)}:y=${Math.max(0, offsetY)}:color=0x00000000`,
    `crop=w=iw-${horizontalPadding}:h=ih-${verticalPadding}:x=${Math.max(0, -offsetX)}:y=${Math.max(0, -offsetY)}`,
  ].join(",");
}

export function exactCutMediaClock(durationSeconds, fps, sampleRate = 48_000) {
  const normalizedFps = Math.max(12, finiteNumber(fps, DEFAULT_VIDEO_FPS));
  const frameCount = Math.max(1, Math.ceil(Math.max(0, finiteNumber(durationSeconds, 0)) * normalizedFps - 1e-7));
  const exactDurationSeconds = frameCount / normalizedFps;
  return {
    frameCount,
    durationSeconds: exactDurationSeconds,
    sampleCount: Math.max(1, Math.round(exactDurationSeconds * sampleRate)),
  };
}

export function buildEpisodeAudioMixFilter(utterances, options = {}) {
  const inputOffset = Math.max(0, Math.round(finiteNumber(options.inputOffset, 0)));
  const sampleRate = Math.max(8_000, Math.round(finiteNumber(options.sampleRate, 48_000)));
  const sampleCount = Math.max(1, Math.round(finiteNumber(options.sampleCount, 1)));
  const rows = [...(utterances || [])].sort((left, right) => (
    finiteNumber(left?.timing?.audioStartSeconds, 0) - finiteNumber(right?.timing?.audioStartSeconds, 0)
  ));
  if (rows.length === 0) {
    return {
      filterGraph: `anullsrc=channel_layout=stereo:sample_rate=${sampleRate},atrim=end_sample=${sampleCount}[episodeaudio]`,
      inputPaths: [],
      outputLabel: "episodeaudio",
    };
  }
  const filters = [];
  const labels = [];
  const inputPaths = [];
  for (const [index, utterance] of rows.entries()) {
    const audioPath = nonEmptyString(utterance?.audio?.filePath);
    if (!audioPath) throw new Error(`Episode audio source is missing for ${utterance?.id || index}.`);
    const delaySamples = Math.max(0, Math.round(
      finiteNumber(utterance?.timing?.audioStartSeconds, 0) * sampleRate,
    ));
    const label = `episodea${index}`;
    filters.push(
      `[${inputOffset + index}:a]aresample=${sampleRate},adelay=${delaySamples}S:all=1[${label}]`,
    );
    labels.push(`[${label}]`);
    inputPaths.push(audioPath);
  }
  filters.push(
    `${labels.join("")}amix=inputs=${labels.length}:duration=longest:dropout_transition=0:normalize=0,`
    + `apad=whole_len=${sampleCount},atrim=end_sample=${sampleCount}[episodeaudio]`,
  );
  return { filterGraph: filters.join(";"), inputPaths, outputLabel: "episodeaudio" };
}

function ffmpegDecimal(value, fallback = 0) {
  return finiteNumber(value, fallback).toFixed(5);
}

export function normalizeEpisodeCamera(value = {}, motion = "pull-out") {
  const source = value && typeof value === "object" ? value : {};
  const mode = motion === "none"
    ? "none"
    : normalizeMangaCameraMode(source.cameraMode ?? source.camera_mode ?? motion, "pullout-only");
  return normalizeMangaCameraTransform(source, mode, {
    intensity: source.cameraIntensity ?? source.camera_intensity ?? "strong",
  });
}

export function cameraProgressExpression(frameCount, easing = "linear", leadRatio = 0, tailRatio = 0) {
  const rawLinear = frameCount > 1 ? `on/${frameCount - 1}` : "0";
  // FFmpeg may decode one more looped source frame for fractional durations.
  // Clamp progress for every easing mode so that extra frame can only repeat
  // the authored endpoint instead of overshooting into another direction.
  const linear = `max(0,min(1,${rawLinear}))`;
  const lead = clamp(leadRatio, 0, 0.4, 0);
  const tail = clamp(tailRatio, 0, 0.4, 0);
  const movingSpan = Math.max(0.2, 1 - lead - tail);
  const phased = lead > 0 || tail > 0
    ? `max(0,min(1,((${linear})-${ffmpegDecimal(lead)})/${ffmpegDecimal(movingSpan)}))`
    : linear;
  if (easing === "smoothstep") {
    return `(${phased})*(${phased})*(3-2*(${phased}))`;
  }
  if (easing === "soft-linear") {
    // Preserve most of linear motion so very slow pans do not quantize into
    // stop/reverse steps near the last frame, while retaining a subtle ease.
    const smooth = `(${phased})*(${phased})*(3-2*(${phased}))`;
    return `0.82*(${phased})+0.18*(${smooth})`;
  }
  if (easing === "ease-out-cubic") {
    return `1-pow(1-(${phased}),3)`;
  }
  if (easing === "ease-in-cubic") {
    return `pow(${phased},3)`;
  }
  return phased;
}

export function cameraInterpolationExpression(start, end, progressExpression) {
  return `${ffmpegDecimal(start)}+(${ffmpegDecimal(end)}-${ffmpegDecimal(start)})*(${progressExpression})`;
}

export function cameraKeyframeExpression(keyframes, property, progressExpression) {
  if (!Array.isArray(keyframes) || keyframes.length < 2) {
    throw new Error(`At least two camera keyframes are required for ${property}`);
  }
  let expression = ffmpegDecimal(keyframes.at(-1)[property]);
  for (let index = keyframes.length - 2; index >= 0; index -= 1) {
    const start = keyframes[index];
    const end = keyframes[index + 1];
    const span = Math.max(1e-6, end.at - start.at);
    const localProgress = `max(0,min(1,((${progressExpression})-${ffmpegDecimal(start.at)})/${ffmpegDecimal(span)}))`;
    // A linear zoom-factor ramp visibly accelerates during a pullout because
    // each fixed decrement becomes a larger percentage of the remaining
    // scale. Geometric interpolation keeps the per-frame apparent scale rate
    // constant, while focus coordinates remain ordinary linear translations.
    const value = property === "zoom"
      ? `${ffmpegDecimal(start[property])}*pow(${ffmpegDecimal(end[property])}/${ffmpegDecimal(start[property])},${localProgress})`
      : cameraInterpolationExpression(start[property], end[property], localProgress);
    expression = `if(lte(${progressExpression},${ffmpegDecimal(end.at)}),${value},${expression})`;
  }
  return expression;
}

export function renderThoughtFocusSvg(input = {}) {
  const width = Math.max(320, Math.round(finiteNumber(input.width, DEFAULT_VIDEO_WIDTH)));
  const height = Math.max(180, Math.round(finiteNumber(input.height, DEFAULT_VIDEO_HEIGHT)));
  const faceBounds = input.faceBounds && typeof input.faceBounds === "object"
    ? input.faceBounds
    : input.face_bounds && typeof input.face_bounds === "object"
      ? input.face_bounds
      : null;
  const fallbackFocusX = faceBounds
    ? finiteNumber(faceBounds.x, 0) + finiteNumber(faceBounds.width, 0) / 2
    : 0.5;
  const fallbackFocusY = faceBounds
    ? finiteNumber(faceBounds.y, 0) + finiteNumber(faceBounds.height, 0) / 2
    : 0.38;
  const focusX = clamp(input.focusX ?? input.focus_x, 0, 1, fallbackFocusX) * width;
  const focusY = clamp(input.focusY ?? input.focus_y, 0, 1, fallbackFocusY) * height;
  const radiusX = clamp(
    input.radiusX ?? input.radius_x,
    0.04,
    0.18,
    faceBounds
      ? Math.min(0.1, Math.max(0.07, finiteNumber(faceBounds.width, 0.13) * 0.69))
      : 0.09,
  ) * width;
  const radiusY = clamp(
    input.radiusY ?? input.radius_y,
    0.06,
    0.23,
    faceBounds
      ? Math.min(0.17, Math.max(0.13, finiteNumber(faceBounds.height, 0.23) * 0.7))
      : 0.16,
  ) * height;
  // The locked references average 0.308 surrounding darkness, a compact
  // 18% x 32% face spot, and a 0.10 face lift.  Keep these measured values as
  // defaults instead of treating an inner monologue as a full-scene blackout.
  const opacity = clamp(input.opacity, 0, 0.8, 0.31);
  const faceBrightness = clamp(input.faceBrightness ?? input.face_brightness, 0, 0.3, 0.1);
  const feather = Math.max(8, Math.round(Math.min(radiusX, radiusY) * 0.12));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" data-thought-focus="face-local" data-reference-darkness="0.31">
  <defs>
    <filter id="feather"><feGaussianBlur stdDeviation="${feather}"/></filter>
    <radialGradient id="face-glow">
      <stop offset="0%" stop-color="white" stop-opacity="${faceBrightness.toFixed(3)}"/>
      <stop offset="58%" stop-color="white" stop-opacity="${(faceBrightness * 0.45).toFixed(3)}"/>
      <stop offset="100%" stop-color="white" stop-opacity="0"/>
    </radialGradient>
    <mask id="spotlight">
      <rect width="${width}" height="${height}" fill="white"/>
      <ellipse cx="${focusX.toFixed(1)}" cy="${focusY.toFixed(1)}" rx="${radiusX.toFixed(1)}" ry="${radiusY.toFixed(1)}" fill="black" filter="url(#feather)"/>
      <ellipse cx="${focusX.toFixed(1)}" cy="${focusY.toFixed(1)}" rx="${Math.max(1, radiusX - feather * 1.4).toFixed(1)}" ry="${Math.max(1, radiusY - feather * 1.4).toFixed(1)}" fill="black"/>
    </mask>
  </defs>
  <rect width="${width}" height="${height}" fill="black" fill-opacity="${opacity.toFixed(3)}" mask="url(#spotlight)"/>
  <ellipse cx="${focusX.toFixed(1)}" cy="${focusY.toFixed(1)}" rx="${(radiusX * 1.08).toFixed(1)}" ry="${(radiusY * 1.08).toFixed(1)}" fill="url(#face-glow)"/>
</svg>`;
}

function normalizedPanelRatios(value, panelCount) {
  const requested = Array.isArray(value.ratios)
    ? value.ratios
    : Array.from({ length: panelCount }, (_, index) => value.panels?.[index]?.ratio);
  const ratios = Array.from({ length: panelCount }, (_, index) => Math.max(0.05, finiteNumber(requested[index], 1)));
  const total = ratios.reduce((sum, ratio) => sum + ratio, 0);
  return ratios.map((ratio) => ratio / total);
}

function panelSlots(type, width, height, gutter, ratios, value) {
  if (type === "story-3") {
    const splitRatio = clamp(value.splitRatio ?? value.split_ratio, 0.28, 0.62, 0.38);
    const diagonalStart = clamp(value.diagonalStart ?? value.diagonal_start, 0.2, 0.58, 0.36);
    const diagonalEnd = clamp(value.diagonalEnd ?? value.diagonal_end, diagonalStart + 0.08, 0.8, 0.63);
    const splitX = Math.round(width * splitRatio);
    const halfGutter = gutter / 2;
    const rightX = Math.min(width - 2, Math.ceil(splitX + halfGutter));
    const rightWidth = Math.max(2, width - rightX);
    const leftWidth = Math.max(2, Math.floor(splitX - halfGutter));
    const startY = height * diagonalStart;
    const endY = height * diagonalEnd;
    const topHeight = Math.max(2, Math.min(height, Math.ceil(endY - halfGutter)));
    const bottomY = Math.max(0, Math.min(height - 2, Math.floor(startY + halfGutter)));
    const lineSlope = (endY - startY) / Math.max(1, rightWidth - 1);
    return {
      splitRatio,
      diagonalStart,
      diagonalEnd,
      slots: [
        { x: 0, y: 0, width: leftWidth, height },
        {
          x: rightX,
          y: 0,
          width: rightWidth,
          height: topHeight,
          alphaExpression: `if(lte(Y,${ffmpegDecimal(startY - halfGutter)}+X*${ffmpegDecimal(lineSlope)}),255,0)`,
        },
        {
          x: rightX,
          y: bottomY,
          width: rightWidth,
          height: height - bottomY,
          alphaExpression: `if(gte(Y,${ffmpegDecimal(startY + halfGutter - bottomY)}+X*${ffmpegDecimal(lineSlope)}),255,0)`,
        },
      ],
    };
  }

  const horizontal = type === "horizontal-2";
  const extent = horizontal ? height : width;
  const available = extent - gutter * (ratios.length - 1);
  const lengths = ratios.map((ratio) => Math.floor(available * ratio));
  lengths[lengths.length - 1] += available - lengths.reduce((sum, length) => sum + length, 0);
  let cursor = 0;
  const slots = lengths.map((length) => {
    const slot = horizontal
      ? { x: 0, y: cursor, width, height: length }
      : { x: cursor, y: 0, width: length, height };
    cursor += length + gutter;
    return slot;
  });
  return { slots };
}

export function normalizePanelLayout(value, width, height, fallbackImagePath) {
  if (!value || typeof value !== "object" || value.enabled === false) return null;
  const type = ["vertical-2", "vertical-3", "horizontal-2", "story-3"].includes(value.type)
    ? value.type
    : "vertical-2";
  const panelCount = type === "vertical-3" || type === "story-3" ? 3 : 2;
  // The measured median in the locked reference set is 1.45% of frame width.
  // Keep the separator as deterministic post-composite geometry rather than
  // asking an image model to draw it into every panel source.
  const gutter = Math.round(clamp(value.gutter, 4, Math.min(width, height) * 0.08, width * 0.0145));
  const requestedPanels = Array.isArray(value.panels) ? value.panels : [];
  const panels = Array.from({ length: panelCount }, (_, index) => {
    const panel = requestedPanels[index] && typeof requestedPanels[index] === "object" ? requestedPanels[index] : {};
    const legacyZoom = clamp(panel.zoom, 1, 2.2, 1.05);
    const legacyFocusX = clamp(panel.focusX ?? panel.focus_x, 0, 1, index / Math.max(1, panelCount - 1));
    const legacyFocusY = clamp(panel.focusY ?? panel.focus_y, 0, 1, 0.42);
    const cameraSource = panel.camera && typeof panel.camera === "object" ? panel.camera : {};
    // A split layout is first flattened into a single manga page. Individual
    // panels therefore keep only their authored opening crop; they never pan
    // or zoom independently. Camera motion is applied once to the completed
    // page (including gutters and speech graphics) below.
    const panelMotion = "none";
    const camera = normalizeEpisodeCamera({
      zoomStart: cameraSource.zoomStart ?? cameraSource.zoom_start ?? legacyZoom,
      zoomEnd: cameraSource.zoomStart ?? cameraSource.zoom_start ?? legacyZoom,
      focusX: cameraSource.focusX ?? cameraSource.focus_x ?? legacyFocusX,
      focusY: cameraSource.focusY ?? cameraSource.focus_y ?? legacyFocusY,
      focusXEnd: cameraSource.focusX ?? cameraSource.focus_x ?? legacyFocusX,
      focusYEnd: cameraSource.focusY ?? cameraSource.focus_y ?? legacyFocusY,
      easing: cameraSource.easing ?? "linear",
      motionLeadRatio: cameraSource.motionLeadRatio ?? cameraSource.motion_lead_ratio ?? 0,
      motionTailRatio: cameraSource.motionTailRatio ?? cameraSource.motion_tail_ratio ?? 0,
      saturation: cameraSource.saturation ?? 1,
      contrast: cameraSource.contrast ?? 1,
      brightness: cameraSource.brightness ?? 0,
      keyframes: cameraSource.keyframes,
    }, "none");
    return {
      imagePath: nonEmptyString(panel.imagePath ?? panel.image_path) || fallbackImagePath,
      focusX: camera.focusX,
      focusY: camera.focusY,
      zoom: camera.zoomStart,
      motion: panelMotion,
      camera,
      role: nonEmptyString(panel.role),
    };
  });
  const ratios = normalizedPanelRatios(value, panelCount);
  const geometry = panelSlots(type, width, height, gutter, ratios, value);
  const pageViewpoint = normalizeMangaSourceViewpoint(value.pageViewpoint ?? value.page_viewpoint, "wide");
  const pageMotion = normalizeMangaCameraMode(
    value.pageCameraMode ?? value.page_camera_mode ?? value.pageMotion ?? value.page_motion,
    pageViewpoint === "wide" ? "pullout-only" : `${pageViewpoint}-only`,
  );
  const pageCamera = normalizeEpisodeCamera(
    value.pageCamera ?? value.page_camera ?? {
      zoomStart: 1.08,
      zoomEnd: 1,
      focusX: 0.5,
      focusY: 0.5,
      focusXEnd: 0.5,
      focusYEnd: 0.5,
      easing: "linear",
    },
    pageMotion,
  );
  const pageFamily = pageMotion === "pullout-only"
    ? "pullout"
    : pageMotion.endsWith("-then-pullout")
      ? "combined"
      : "directional";
  return {
    type,
    gutter,
    separatorWidthRatio: gutter / width,
    separatorColor: "black",
    composition: "post-composite-then-flatten",
    motionPolicy: "whole-page",
    flattenBeforeCamera: true,
    panelCamera: "static",
    pageViewpoint,
    pageEndView: pageFamily === "pullout" || pageFamily === "combined"
      ? mangaWideViewFor(pageViewpoint)
      : pageViewpoint,
    pageMotion,
    pageCameraMode: pageMotion,
    pageCamera,
    ratios,
    panels,
    ...geometry,
  };
}

export function normalizeCameraShotSequence(cut = {}, utterances = [], durationSeconds = 0) {
  const requested = Array.isArray(cut.cameraSequence ?? cut.camera_sequence)
    ? (cut.cameraSequence ?? cut.camera_sequence)
    : [];
  if (requested.length === 0) return [];
  const duration = Math.max(0, finiteNumber(durationSeconds, cut.timing?.durationSeconds ?? 0));
  const utteranceById = new Map(utterances.map((utterance) => [utterance.id, utterance]));
  const prepared = requested.map((entry, index) => {
    const source = entry && typeof entry === "object" ? entry : {};
    const utteranceIds = [...new Set([
      ...(Array.isArray(source.utteranceIds ?? source.utterance_ids)
        ? (source.utteranceIds ?? source.utterance_ids)
        : []),
      source.utteranceId ?? source.utterance_id,
    ].map(nonEmptyString).filter(Boolean))];
    const assigned = utteranceIds.map((id) => utteranceById.get(id)).filter(Boolean);
    const firstUtterance = assigned[0] || null;
    const explicitStart = finiteNumber(source.startSeconds ?? source.start_seconds, NaN);
    const utteranceProgress = finiteNumber(
      source.utteranceProgress ?? source.utterance_progress,
      NaN,
    );
    const progressAnchor = firstUtterance && Number.isFinite(utteranceProgress)
      ? finiteNumber(firstUtterance.timing?.audioStartInCutSeconds, 0)
        + finiteNumber(firstUtterance.audio?.durationSeconds, 0) * clamp(utteranceProgress, 0, 1, 0)
      : NaN;
    const anchorStart = Number.isFinite(explicitStart)
      ? explicitStart
      : Number.isFinite(progressAnchor)
        ? progressAnchor
        : finiteNumber(firstUtterance?.timing?.audioStartInCutSeconds, index === 0 ? 0 : NaN);
    return {
      id: nonEmptyString(source.id) || `${cut.id || "cut"}-shot-${index + 1}`,
      imagePath: nonEmptyString(source.imagePath ?? source.image_path) || nonEmptyString(cut.imagePath),
      utteranceIds,
      angle: nonEmptyString(source.angle) || "base",
      viewpoint: nonEmptyString(source.viewpoint),
      endView: nonEmptyString(source.endView ?? source.end_view),
      viewFamily: nonEmptyString(source.viewFamily ?? source.view_family),
      shotType: nonEmptyString(source.shotType ?? source.shot_type),
      reason: nonEmptyString(source.reason),
      transition: nonEmptyString(source.transition) || "cut",
      motion: nonEmptyString(source.motion) || nonEmptyString(cut.motion) || "pull-out",
      camera: source.camera && typeof source.camera === "object" ? source.camera : cut.camera,
      editorialPlate: source.editorialPlate && typeof source.editorialPlate === "object"
        ? source.editorialPlate
        : null,
      sourceFaceBoundsBySpeakerId: source.sourceFaceBoundsBySpeakerId
        ?? source.source_face_bounds_by_speaker_id
        ?? null,
      sourceAvoidRegions: source.sourceAvoidRegions
        ?? source.source_avoid_regions
        ?? null,
      speakerOffscreenSpeakerIds: source.speakerOffscreenSpeakerIds
        ?? source.speaker_offscreen_speaker_ids
        ?? null,
      speakerAnchorPointBySpeakerId: source.speakerAnchorPointBySpeakerId
        ?? source.speaker_anchor_point_by_speaker_id
        ?? null,
      explicitStart: Number.isFinite(explicitStart),
      utteranceProgress: Number.isFinite(utteranceProgress)
        ? clamp(utteranceProgress, 0, 1, 0)
        : NaN,
      anchorStart,
      requestedEnd: finiteNumber(source.endSeconds ?? source.end_seconds, NaN),
    };
  });
  const starts = prepared.map((shot, index) => {
    if (index === 0) return Math.max(0, Math.min(duration, shot.explicitStart ? shot.anchorStart : 0));
    if (Number.isFinite(shot.anchorStart)) {
      const first = shot.utteranceIds.map((id) => utteranceById.get(id)).find(Boolean);
      const gapBefore = finiteNumber(first?.timing?.gapBeforeSeconds, 0);
      const boundaryLead = Number.isFinite(shot.utteranceProgress) && shot.utteranceProgress > 0
        ? 0
        : gapBefore / 2;
      return Math.max(0, Math.min(duration, shot.anchorStart - boundaryLead));
    }
    return duration * index / prepared.length;
  });
  return prepared.map((shot, index) => {
    const startSeconds = starts[index];
    const requestedEnd = Number.isFinite(shot.requestedEnd) ? shot.requestedEnd : NaN;
    const endSeconds = Math.max(
      startSeconds,
      Math.min(duration, Number.isFinite(requestedEnd) ? requestedEnd : starts[index + 1] ?? duration),
    );
    return {
      id: shot.id,
      imagePath: shot.imagePath,
      utteranceIds: shot.utteranceIds,
      angle: shot.angle,
      viewpoint: shot.viewpoint,
      endView: shot.endView,
      viewFamily: shot.viewFamily,
      shotType: shot.shotType,
      reason: shot.reason,
      utteranceProgress: Number.isFinite(shot.utteranceProgress) ? shot.utteranceProgress : undefined,
      transition: shot.transition,
      motion: shot.motion,
      editorialPlate: shot.editorialPlate,
      sourceFaceBoundsBySpeakerId: shot.sourceFaceBoundsBySpeakerId,
      sourceAvoidRegions: shot.sourceAvoidRegions,
      speakerOffscreenSpeakerIds: shot.speakerOffscreenSpeakerIds,
      speakerAnchorPointBySpeakerId: shot.speakerAnchorPointBySpeakerId,
      camera: normalizeEpisodeCamera(shot.camera, shot.motion),
      startSeconds,
      endSeconds,
      durationSeconds: endSeconds - startSeconds,
    };
  }).filter((shot) => shot.imagePath && shot.durationSeconds > 0.001);
}

export function auditCameraSequencePolicy(manifest = {}, cut = {}, shotSequence = []) {
  const video = manifest.video && typeof manifest.video === "object" ? manifest.video : {};
  const violations = [];
  const imageCounts = new Map();
  if (video.requireWholePageSplitCamera === true && cut.panelLayout?.enabled) {
    violations.push(...auditMangaPanelPageCameraGrammar(cut.panelLayout, cut.id));
  }
  for (const shot of shotSequence) {
    imageCounts.set(shot.imagePath, (imageCounts.get(shot.imagePath) || 0) + 1);
    const camera = shot.camera || {};
    const staticEditorialPlate = shot.motion === "none"
      && shot.editorialPlate?.characterPolicy === "strictly-none"
      && shot.editorialPlate?.environmentPolicy === "none";
    if (video.requireSemanticCameraViews === true) {
      violations.push(...auditMangaShotCameraGrammar(shot));
    } else if (video.forbidPushInCameraMotion === true && !staticEditorialPlate && cameraHasPushIn(camera)) {
      violations.push({ type: "push-in-zoom", shotId: shot.id });
    }
    if (video.requireSemanticCameraViews === true && !staticEditorialPlate && !MANGA_SOURCE_VIEWPOINTS.includes(shot.viewpoint)) {
      // Retain a pipeline-local diagnostic so render logs stay readable even
      // when the reusable grammar module evolves independently.
      violations.push({ type: "missing-camera-view-family", shotId: shot.id, value: shot.viewpoint });
    }
    if (video.requireConstantCameraSpeed === true) {
      if (camera.easing !== "linear") violations.push({ type: "non-linear-easing", shotId: shot.id, value: camera.easing });
      if (camera.motionLeadRatio > 1e-7 || camera.motionTailRatio > 1e-7) {
        violations.push({
          type: "camera-lead-or-tail-hold",
          shotId: shot.id,
          lead: camera.motionLeadRatio,
          tail: camera.motionTailRatio,
        });
      }
    }
    const labels = [shot.angle, shot.motion, shot.transition].filter(Boolean).join(" ");
    if (video.forbidDownwardCameraMotion === true && /down/i.test(labels)) {
      violations.push({ type: "down-camera-label", shotId: shot.id, labels });
    }
    const keyframes = Array.isArray(camera.keyframes) && camera.keyframes.length >= 2
      ? camera.keyframes
      : [
          { at: 0, zoom: camera.zoomStart, focusX: camera.focusX, focusY: camera.focusY },
          { at: 1, zoom: camera.zoomEnd, focusX: camera.focusXEnd, focusY: camera.focusYEnd },
        ];
    for (let index = 0; index < keyframes.length - 1; index += 1) {
      const start = keyframes[index];
      const end = keyframes[index + 1];
      const delta = {
        zoom: end.zoom - start.zoom,
        focusX: end.focusX - start.focusX,
        focusY: end.focusY - start.focusY,
      };
      if (video.forbidDownwardCameraMotion === true && delta.focusY > 1e-7) {
        violations.push({ type: "downward-focus-travel", shotId: shot.id, segmentIndex: index, deltaFocusY: delta.focusY });
      }
      if (!staticEditorialPlate && video.forbidCameraStops === true && Math.max(Math.abs(delta.zoom), Math.abs(delta.focusX), Math.abs(delta.focusY)) < 1e-7) {
        violations.push({ type: "stopped-camera-segment", shotId: shot.id, segmentIndex: index });
      }
    }
    if (!staticEditorialPlate && video.forbidCameraStops === true && shot.motion === "none") {
      violations.push({ type: "motion-none", shotId: shot.id });
    }
  }
  if (video.forbidRepeatedCameraImages === true) {
    // The user's rule bans REPEATING an image from its opening position
    // ("最初の位置に戻るんじゃなくて" — never reset to the initial crop).
    // A consecutive same-image shot that CONTINUES from the exact reached
    // focus/zoom is the taught direction-then-hold grammar and the R55
    // reference image-hold behaviour, so it is legal.
    for (let index = 1; index < shotSequence.length; index += 1) {
      const previous = shotSequence[index - 1];
      const shot = shotSequence[index];
      if (shot.imagePath !== previous.imagePath) continue;
      const previousCamera = previous.camera || {};
      const camera = shot.camera || {};
      const previousKeyframes = Array.isArray(previousCamera.keyframes) && previousCamera.keyframes.length >= 2
        ? previousCamera.keyframes
        : [{ zoom: previousCamera.zoomStart, focusX: previousCamera.focusX, focusY: previousCamera.focusY },
           { zoom: previousCamera.zoomEnd, focusX: previousCamera.focusXEnd, focusY: previousCamera.focusYEnd }];
      const keyframes = Array.isArray(camera.keyframes) && camera.keyframes.length >= 2
        ? camera.keyframes
        : [{ zoom: camera.zoomStart, focusX: camera.focusX, focusY: camera.focusY }];
      const reached = previousKeyframes.at(-1);
      const start = keyframes[0];
      const continuation = Math.abs(finiteNumber(start.focusX, NaN) - finiteNumber(reached.focusX, NaN)) <= 0.02
        && Math.abs(finiteNumber(start.focusY, NaN) - finiteNumber(reached.focusY, NaN)) <= 0.02
        && finiteNumber(start.zoom, NaN) <= finiteNumber(reached.zoom, NaN) + 1e-6;
      if (!continuation) {
        violations.push({ type: "repeated-image-in-cut", cutId: cut.id, imagePath: shot.imagePath, reset: true });
      }
    }
    const consecutiveByImage = new Map();
    for (const [index, shot] of shotSequence.entries()) {
      const previousIndex = consecutiveByImage.get(shot.imagePath);
      if (previousIndex !== undefined && previousIndex !== index - 1) {
        violations.push({ type: "repeated-image-in-cut", cutId: cut.id, imagePath: shot.imagePath, nonConsecutive: true });
      }
      consecutiveByImage.set(shot.imagePath, index);
    }
  }
  return {
    cutId: cut.id,
    shotCount: shotSequence.length,
    uniqueImageCount: imageCounts.size,
    violations,
    pass: violations.length === 0,
  };
}

async function fileContentSignature(filePath) {
  const resolvedPath = resolve(nonEmptyString(filePath));
  if (!resolvedPath || !await pathExists(resolvedPath)) {
    throw new Error(`Render input is not a file: ${resolvedPath || filePath}`);
  }
  return {
    filePath: resolvedPath,
    sha256: createHash("sha256").update(await readFile(resolvedPath)).digest("hex"),
  };
}

export async function renderCutInputHash(manifest, cut, utterances) {
  const width = Math.max(320, Math.round(finiteNumber(manifest.video?.width, DEFAULT_VIDEO_WIDTH)));
  const height = Math.max(180, Math.round(finiteNumber(manifest.video?.height, DEFAULT_VIDEO_HEIGHT)));
  const fps = Math.max(12, finiteNumber(manifest.video?.fps, DEFAULT_VIDEO_FPS));
  const duration = Math.max(0, finiteNumber(cut.timing?.durationSeconds, 0));
  const authoredFrameCount = Math.ceil(duration * fps - 1e-7);
  const legacyMillisecondFrameCount = Math.ceil(Number(duration.toFixed(3)) * fps - 1e-7);
  const panelLayout = normalizePanelLayout(cut.panelLayout, width, height, cut.imagePath);
  const shotSequence = panelLayout
    ? []
    : normalizeCameraShotSequence(cut, utterances, cut.timing?.durationSeconds);
  const sourcePaths = shotSequence.length > 0
    ? shotSequence.map((shot) => shot.imagePath)
    : panelLayout
    ? [...new Set([cut.imagePath, ...panelLayout.panels.map((panel) => panel.imagePath)].filter(Boolean))]
    : [cut.imagePath];
  const inputPaths = [
    ...sourcePaths,
    ...utterances.flatMap((utterance) => [
      utterance.overlayPath,
      utterance.overlaySpecPath,
      ...(Array.isArray(utterance.bubbleSegments)
        ? utterance.bubbleSegments.map((segment) => segment?.overlayPath)
        : []),
      utterance.audio?.filePath,
    ]).filter(Boolean),
  ];
  const files = [];
  for (const filePath of [...new Set(inputPaths)]) files.push(await fileContentSignature(filePath));
  return mangaVideoJobInputHash("render-cut", {
    episodeId: manifest.id,
    video: {
      width,
      height,
      fps: manifest.video?.fps,
      encodePreset: manifest.video?.encodePreset,
      normalizeVoiceAudio: manifest.video?.normalizeVoiceAudio,
      voiceTargetLufs: manifest.video?.voiceTargetLufs,
      voiceLoudnessRange: manifest.video?.voiceLoudnessRange,
      voiceTruePeakDb: manifest.video?.voiceTruePeakDb,
      voiceFadeInMilliseconds: manifest.video?.voiceFadeInMilliseconds,
      voiceFadeOutMilliseconds: manifest.video?.voiceFadeOutMilliseconds,
      cameraOversample: manifest.video?.cameraOversample,
      cameraRendererRevision: manifest.video?.cameraRendererRevision,
      bubbleTransitionCrossfadeSeconds: manifest.video?.bubbleTransitionCrossfadeSeconds,
      bubbleFadeInMilliseconds: manifest.video?.bubbleFadeInMilliseconds,
      bubbleFadeOutMilliseconds: manifest.video?.bubbleFadeOutMilliseconds,
      // Add a revision only to cuts whose former millisecond serialization
      // emitted an extra frame. Correct existing cut caches stay reusable.
      ...(authoredFrameCount !== legacyMillisecondFrameCount
        ? { durationSerializationPolicy: "frame-and-sample-count-exact-v3" }
        : {}),
    },
    cut: {
      id: cut.id,
      imagePath: cut.imagePath,
      motion: cut.motion,
      camera: cut.camera,
      thoughtFocus: cut.thoughtFocus,
      panelLayout: cut.panelLayout,
      cameraSequence: cut.cameraSequence ?? cut.camera_sequence,
      timing: cut.timing,
    },
    utterances: utterances.map((utterance) => ({
      id: utterance.id,
      preset: utterance.preset,
      thoughtFocus: utterance.thoughtFocus,
      timing: utterance.timing,
      // Raster paths are a transient render cache attached after this hash is
      // computed. Including them makes every successful segmented-bubble cut
      // immediately look stale to the final audit.
      bubbleSegments: Array.isArray(utterance.bubbleSegments)
        ? utterance.bubbleSegments.map(({ rasterizedOverlayPath: _cachePath, ...segment }) => segment)
        : utterance.bubbleSegments,
      audioInputHash: utterance.audio?.inputHash,
    })),
    files,
  });
}

function hasOwn(value, key) {
  return Boolean(value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key));
}

function normalizedFaceBounds(value, width, height) {
  const normalized = normalizedBubbleBounds(value, width, height);
  if (!normalized) return null;
  return {
    x: clamp(normalized.x, 0, 1, 0),
    y: clamp(normalized.y, 0, 1, 0),
    width: clamp(normalized.width, 0.01, 1, 0.13),
    height: clamp(normalized.height, 0.01, 1, 0.23),
  };
}

function activeShotForUtterance(cut, utterance) {
  const utteranceId = nonEmptyString(utterance?.id);
  return (Array.isArray(cut?.cameraSequence) ? cut.cameraSequence : [])
    .find((shot) => Array.isArray(shot?.utteranceIds) && shot.utteranceIds.includes(utteranceId)) || null;
}

function shotSpeakerFaceBounds(shot, utterance, width, height) {
  if (!shot || typeof shot !== "object") return null;
  const speakerId = nonEmptyString(utterance?.speakerId);
  const maps = [
    shot.screenFaceBoundsBySpeakerId,
    shot.speakerFaceBoundsById,
    shot.faceBoundsBySpeakerId,
  ];
  for (const map of maps) {
    const match = map && typeof map === "object" ? map[speakerId] : null;
    const normalized = normalizedFaceBounds(match, width, height);
    if (normalized) return normalized;
  }
  return normalizedFaceBounds(
    shot.activeSpeakerFaceBounds ?? shot.speakerFaceBounds ?? shot.thoughtFaceBounds,
    width,
    height,
  );
}

function shotSpeakerSourceFaceBounds(shot, utterance, width, height) {
  if (!shot || typeof shot !== "object") return null;
  const speakerId = nonEmptyString(utterance?.speakerId);
  const maps = [
    shot.sourceFaceBoundsBySpeakerId,
    shot.source_face_bounds_by_speaker_id,
  ];
  for (const map of maps) {
    const match = map && typeof map === "object" ? map[speakerId] : null;
    const normalized = normalizedFaceBounds(match, width, height);
    if (normalized) return normalized;
  }
  return normalizedFaceBounds(
    shot.activeSpeakerSourceFaceBounds
      ?? shot.active_speaker_source_face_bounds
      ?? shot.sourceFaceBounds
      ?? shot.source_face_bounds,
    width,
    height,
  );
}

/**
 * Projects a face annotation authored in the uncropped source illustration
 * through the exact normalized crop used by the page camera.  Thought masks
 * are composited after the camera transform, so reusing source coordinates as
 * screen coordinates shifts the clear spot whenever zoom or focus is active.
 */
export function projectFaceBoundsThroughCamera(faceBounds, camera = {}, motion = "pull-out", progress = 0.5) {
  if (!faceBounds || typeof faceBounds !== "object") return null;
  const source = normalizedFaceBounds(faceBounds, 1, 1);
  if (!source) return null;
  const normalizedCamera = normalizeEpisodeCamera(camera, motion);
  const position = clamp(progress, 0, 1, 0.5);
  const keyframes = Array.isArray(normalizedCamera.keyframes) && normalizedCamera.keyframes.length >= 2
    ? normalizedCamera.keyframes
    : [
        {
          at: 0,
          zoom: normalizedCamera.zoomStart,
          focusX: normalizedCamera.focusX,
          focusY: normalizedCamera.focusY,
        },
        {
          at: 1,
          zoom: normalizedCamera.zoomEnd,
          focusX: normalizedCamera.focusXEnd,
          focusY: normalizedCamera.focusYEnd,
        },
      ];
  const rightIndex = Math.max(1, keyframes.findIndex((entry) => entry.at >= position));
  const left = keyframes[Math.min(rightIndex - 1, keyframes.length - 2)];
  const right = keyframes[Math.min(rightIndex, keyframes.length - 1)];
  const span = Math.max(1e-6, right.at - left.at);
  const localProgress = clamp((position - left.at) / span, 0, 1, 0);
  // Match cameraKeyframeExpression(): zoom changes geometrically so apparent
  // scale speed stays constant; focus coordinates interpolate linearly.
  const zoom = left.zoom * Math.pow(right.zoom / left.zoom, localProgress);
  const focusX = left.focusX + (right.focusX - left.focusX) * localProgress;
  const focusY = left.focusY + (right.focusY - left.focusY) * localProgress;
  const viewport = 1 / zoom;
  const cropX = clamp(focusX - viewport / 2, 0, 1 - viewport, 0);
  const cropY = clamp(focusY - viewport / 2, 0, 1 - viewport, 0);
  return {
    x: clamp((source.x - cropX) * zoom, 0, 1, 0),
    y: clamp((source.y - cropY) * zoom, 0, 1, 0),
    width: clamp(source.width * zoom, 0.01, 1, source.width),
    height: clamp(source.height * zoom, 0.01, 1, source.height),
  };
}

function faceFromMatchingOverlaySpec(spec, shot, width, height) {
  if (!spec || typeof spec !== "object") return null;
  const specImage = nonEmptyString(spec.imagePath);
  const shotImage = nonEmptyString(shot?.imagePath);
  // An overlay spec may survive an image replacement. Never project a face
  // annotation authored for an old composition onto a new camera asset.
  if (specImage && shotImage && basename(specImage) !== basename(shotImage)) return null;
  const bubble = spec.bubble ?? spec.plan?.bubbles?.[0] ?? {};
  const hinted = normalizedFaceBounds(bubble.speakerHint?.faceBounds, width, height);
  if (hinted) return hinted;
  const regions = (spec.plan?.avoidRegions ?? spec.avoidRegions ?? [])
    .filter((region) => region?.kind === "face")
    .map((region) => normalizedFaceBounds(region, width, height))
    .filter(Boolean);
  if (regions.length === 0) return null;
  const position = nonEmptyString(bubble.speakerHint?.position).toLowerCase();
  if (position === "left") return regions.toSorted((a, b) => a.x + a.width / 2 - (b.x + b.width / 2))[0];
  if (position === "right") return regions.toSorted((a, b) => b.x + b.width / 2 - (a.x + a.width / 2))[0];
  return regions.toSorted((a, b) => (
    Math.abs(a.x + a.width / 2 - 0.5) - Math.abs(b.x + b.width / 2 - 0.5)
  ))[0];
}

/**
 * Resolves the face spot from the currently displayed camera shot. Per-shot
 * screen coordinates win over cut-level coordinates because a cut may replace
 * its illustration between utterances. Explicit utterance coordinates remain
 * the highest-priority author override.
 */
export async function resolveThoughtFocusForUtterance(cut, utterance, width, height) {
  const cutFocus = cut?.thoughtFocus && typeof cut.thoughtFocus === "object" ? cut.thoughtFocus : {};
  const utteranceFocus = utterance?.thoughtFocus && typeof utterance.thoughtFocus === "object"
    ? utterance.thoughtFocus
    : {};
  const shot = activeShotForUtterance(cut, utterance);
  const shotFocus = shot?.thoughtFocus && typeof shot.thoughtFocus === "object" ? shot.thoughtFocus : {};
  const explicitFace = normalizedFaceBounds(utteranceFocus.faceBounds ?? utteranceFocus.face_bounds, width, height);
  const explicitShotFace = normalizedFaceBounds(shotFocus.faceBounds ?? shotFocus.face_bounds, width, height);
  const sourceFace = shotSpeakerSourceFaceBounds(shot, utterance, width, height);
  const projectionProgress = clamp(
    utteranceFocus.cameraProgress
      ?? utteranceFocus.camera_progress
      ?? shotFocus.cameraProgress
      ?? shotFocus.camera_progress,
    0,
    1,
    0.5,
  );
  const projectedSourceFace = sourceFace
    ? projectFaceBoundsThroughCamera(sourceFace, shot?.camera, shot?.motion, projectionProgress)
    : null;
  const shotFace = explicitShotFace
    ?? projectedSourceFace
    ?? shotSpeakerFaceBounds(shot, utterance, width, height);
  let specFace = null;
  const overlaySpecPath = nonEmptyString(utterance?.overlaySpecPath);
  if (!explicitFace && !shotFace && overlaySpecPath && await pathExists(overlaySpecPath)) {
    try {
      specFace = faceFromMatchingOverlaySpec(JSON.parse(await readFile(overlaySpecPath, "utf8")), shot, width, height);
    } catch {
      specFace = null;
    }
  }
  const cutFace = normalizedFaceBounds(cutFocus.faceBounds ?? cutFocus.face_bounds, width, height);
  const faceBounds = explicitFace ?? shotFace ?? specFace ?? cutFace;
  const resolvedSource = explicitFace
    ? "utterance"
    : explicitShotFace
      ? "active-camera-shot"
      : projectedSourceFace
        ? "active-camera-projected-source-face"
        : shotFace
          ? "active-camera-shot"
      : specFace
        ? "matching-overlay-spec"
        : cutFace
          ? "cut-fallback"
          : "frame-fallback";
  const focus = { ...cutFocus, ...shotFocus, ...utteranceFocus };
  if (faceBounds) focus.faceBounds = faceBounds;
  if (sourceFace) focus.sourceFaceBounds = sourceFace;
  if (projectedSourceFace) focus.projectionProgress = projectionProgress;
  if (resolvedSource !== "cut-fallback" && resolvedSource !== "frame-fallback") {
    for (const key of ["focusX", "focusY", "focus_x", "focus_y", "radiusX", "radiusY", "radius_x", "radius_y"]) {
      if (!hasOwn(utteranceFocus, key) && !hasOwn(shotFocus, key)) delete focus[key];
    }
  }
  return { ...focus, resolvedSource, width, height };
}

async function thoughtFocusOverlayPath(cut, utterance, workDir, width, height) {
  const focus = await resolveThoughtFocusForUtterance(cut, utterance, width, height);
  const svgPath = join(workDir, `${utterance.id}-thought-focus.svg`);
  const pngPath = join(workDir, `${utterance.id}-thought-focus.png`);
  await writeFile(svgPath, renderThoughtFocusSvg(focus), "utf8");
  await rasterizeSvg(svgPath, pngPath);
  return pngPath;
}

async function imagePixelSize(imagePath) {
  const { stdout } = await runCommand("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "json",
    imagePath,
  ]);
  const stream = JSON.parse(stdout).streams?.[0];
  const width = Math.round(finiteNumber(stream?.width, 0));
  const height = Math.round(finiteNumber(stream?.height, 0));
  if (!(width > 0) || !(height > 0)) throw new Error(`Could not read image size: ${imagePath}`);
  return { width, height };
}

/**
 * Bakes the inner-voice spotlight (surround dim + face-sized glow) INTO the
 * shot's source illustration, before any camera motion. The user-approved
 * rule: the dim/highlight edit is applied to the completed image first, and
 * the video camera then moves over that finished page — so the bright region
 * is locked to the face at every camera position by construction. Screen-space
 * post-camera spotlight compositing caused visible drift and is forbidden.
 */
async function bakeThoughtSpotlightIntoImage({ cut, shot, utterance, workDir }) {
  const imagePath = nonEmptyString(shot?.imagePath) || nonEmptyString(cut?.imagePath);
  if (!imagePath) throw new Error(`Thought shot for ${utterance.id} has no source image.`);
  const { width: imageWidth, height: imageHeight } = await imagePixelSize(imagePath);
  const sourceFace = shotSpeakerSourceFaceBounds(shot, utterance, imageWidth, imageHeight);
  if (!sourceFace) {
    throw new Error(
      `Thought utterance ${utterance.id} has no source-image face annotation `
      + `(sourceFaceBoundsBySpeakerId) on its camera shot; the spotlight cannot be baked.`,
    );
  }
  const cutFocus = cut?.thoughtFocus && typeof cut.thoughtFocus === "object" ? cut.thoughtFocus : {};
  const utteranceFocus = utterance?.thoughtFocus && typeof utterance.thoughtFocus === "object"
    ? utterance.thoughtFocus
    : {};
  // Only the artistic intensity knobs carry over; every stale screen-space
  // geometry override (focusX/radius etc.) is ignored because geometry now
  // comes from the source-image face itself.
  const focus = {
    width: imageWidth,
    height: imageHeight,
    faceBounds: sourceFace,
    opacity: utteranceFocus.opacity ?? cutFocus.opacity,
    faceBrightness: utteranceFocus.faceBrightness ?? cutFocus.faceBrightness,
  };
  const svgPath = join(workDir, `${shot.id || utterance.id}-spotlight-source.svg`);
  const maskPngPath = join(workDir, `${shot.id || utterance.id}-spotlight-source-mask.png`);
  const bakedPath = join(workDir, `${shot.id || utterance.id}-spotlight-baked.png`);
  await writeFile(svgPath, renderThoughtFocusSvg(focus), "utf8");
  await rasterizeSvg(svgPath, maskPngPath);
  await runCommand("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", imagePath,
    "-i", maskPngPath,
    "-filter_complex", "[0:v][1:v]overlay=0:0:format=auto",
    "-frames:v", "1",
    bakedPath,
  ]);
  return { bakedPath, sourceFace, imageWidth, imageHeight };
}

async function renderCutVideo({ manifest, cut, utterances, workDir, ffmpegPath }) {
  const width = Math.max(320, Math.round(finiteNumber(manifest.video?.width, DEFAULT_VIDEO_WIDTH)));
  const height = Math.max(180, Math.round(finiteNumber(manifest.video?.height, DEFAULT_VIDEO_HEIGHT)));
  const fps = Math.max(12, Math.round(finiteNumber(manifest.video?.fps, DEFAULT_VIDEO_FPS)));
  const cameraOversample = Math.round(clamp(manifest.video?.cameraOversample, 1, 3, 1));
  const cameraWidth = width * cameraOversample;
  const cameraHeight = height * cameraOversample;
  const duration = finiteNumber(cut.timing?.durationSeconds, 0);
  const encodePreset = ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow"].includes(manifest.video?.encodePreset)
    ? manifest.video.encodePreset
    : "veryfast";
  // An authored split-screen is the final editorial composition for its
  // interval, so it takes precedence over the cut's ordinary camera sequence.
  // Conditional layouts still use cut.imagePath as the full-frame lead-in.
  const panelLayout = normalizePanelLayout(cut.panelLayout, width, height, cut.imagePath);
  const shotSequence = panelLayout ? [] : normalizeCameraShotSequence(cut, utterances, duration);
  const cameraPolicyAudit = auditCameraSequencePolicy(manifest, cut, shotSequence);
  if (!cameraPolicyAudit.pass) {
    throw new Error(`Camera policy failed for ${cut.id}: ${JSON.stringify(cameraPolicyAudit.violations)}`);
  }
  const conditionalPanelStartId = nonEmptyString(cut.panelLayout?.enableFromUtteranceId ?? cut.panelLayout?.enable_from_utterance_id);
  const conditionalPanelEndId = nonEmptyString(cut.panelLayout?.enableThroughUtteranceId ?? cut.panelLayout?.enable_through_utterance_id);
  const conditionalPanel = Boolean(panelLayout && conditionalPanelStartId);
  // Inner-voice spotlights are baked into the shot's source image BEFORE the
  // camera (user-approved order: dim/highlight the completed image first,
  // then move the camera over it). Never composited in screen space.
  const bakedSpotlightByShotId = new Map();
  const artificialDarkeningAllowedForCut = manifest.production?.bubblePolicy?.artificialBackgroundDarkening !== false;
  for (const utterance of utterances) {
    if (utterance.preset !== "thought") continue;
    if (!artificialDarkeningAllowedForCut) continue;
    if (cut.thoughtFocus?.enabled === false || utterance.thoughtFocus?.enabled === false) continue;
    const shot = shotSequence.find((entry) => (
      Array.isArray(entry.utteranceIds) && entry.utteranceIds.includes(utterance.id)
    ));
    if (!shot) {
      throw new Error(`Thought utterance ${utterance.id} has no camera shot; cannot bake its spotlight.`);
    }
    if (!bakedSpotlightByShotId.has(shot.id)) {
      const baked = await bakeThoughtSpotlightIntoImage({ cut, shot, utterance, workDir });
      bakedSpotlightByShotId.set(shot.id, baked);
      shot.imagePath = baked.bakedPath;
    }
  }
  const sourcePaths = shotSequence.length > 0
    ? shotSequence.map((shot) => shot.imagePath)
    : panelLayout
    ? [...(conditionalPanel ? [cut.imagePath] : []), ...panelLayout.panels.map((panel) => panel.imagePath)]
    : [cut.imagePath];
  for (const sourcePath of sourcePaths) {
    if (!(await pathExists(sourcePath))) throw new Error(`Panel/source image is not a file: ${sourcePath}`);
  }
  const visualOverlays = [];
  for (const utterance of utterances) {
    const bubbleSegments = Array.isArray(utterance.bubbleSegments)
      ? utterance.bubbleSegments.filter((segment) => nonEmptyString(segment?.overlayPath))
      : [];
    if (bubbleSegments.length > 0) {
      const audioStart = finiteNumber(utterance.timing?.audioStartInCutSeconds, 0);
      const defaultStart = finiteNumber(utterance.timing?.bubbleStartInCutSeconds, audioStart);
      const defaultEnd = finiteNumber(utterance.timing?.bubbleEndInCutSeconds, audioStart);
      for (const [segmentIndex, segment] of bubbleSegments.entries()) {
        const segmentId = nonEmptyString(segment.id) || `${utterance.id}-bubble-${segmentIndex + 1}`;
        const pngPath = nonEmptyString(segment.rasterizedOverlayPath) || join(workDir, `${segmentId}.png`);
        await rasterizeSvgAtSizeIfFresh(segment.overlayPath, pngPath, width, height);
        const requestedStart = audioStart + finiteNumber(segment.startOffsetSeconds, defaultStart - audioStart);
        const requestedEnd = audioStart + finiteNumber(segment.endOffsetSeconds, defaultEnd - audioStart);
        visualOverlays.push({
          path: pngPath,
          utterance,
          kind: "bubble-segment",
          renderOffset: segment.renderOffset,
          overlayStart: Math.max(defaultStart, Math.min(defaultEnd, requestedStart)),
          overlayEnd: Math.max(defaultStart, Math.min(defaultEnd, requestedEnd)),
          segmentId,
        });
      }
      continue;
    }
    const pngPath = nonEmptyString(utterance.rasterizedOverlayPath) || join(workDir, `${utterance.id}.png`);
    await rasterizeSvgAtSizeIfFresh(utterance.overlayPath, pngPath, width, height);
    const artificialDarkeningAllowed = manifest.production?.bubblePolicy?.artificialBackgroundDarkening !== false;
    const thoughtFocusEnabled = cut.thoughtFocus?.enabled !== false && utterance.thoughtFocus?.enabled !== false;
    const spotlightBaked = utterance.preset === "thought" && shotSequence.some((entry) => (
      Array.isArray(entry.utteranceIds)
      && entry.utteranceIds.includes(utterance.id)
      && bakedSpotlightByShotId.has(entry.id)
    ));
    if (utterance.preset === "thought" && artificialDarkeningAllowed && thoughtFocusEnabled && !spotlightBaked) {
      // Screen-space fallback only exists for cuts with no camera shots
      // (static single-image cuts, where post-camera equals pre-camera).
      visualOverlays.push({
        path: await thoughtFocusOverlayPath(cut, utterance, workDir, width, height),
        utterance,
        kind: "thought-focus",
      });
    }
    visualOverlays.push({
      path: pngPath,
      utterance,
      kind: "bubble",
      overlayStart: finiteNumber(utterance.timing?.bubbleStartInCutSeconds, 0),
      overlayEnd: finiteNumber(utterance.timing?.bubbleEndInCutSeconds, 0),
    });
  }
  const args = ["-hide_banner", "-y"];
  // Feed every still once. The graph performs expensive static preprocessing
  // on that single frame and then holds the processed frame with tpad. Using
  // `-loop 1` here caused the same PNG to be decoded and 3x-oversampled again
  // for every output frame.
  for (const sourcePath of sourcePaths) {
    args.push("-framerate", String(fps), "-i", sourcePath);
  }
  for (const overlay of visualOverlays) {
    args.push("-framerate", String(fps), "-i", overlay.path);
  }
  for (const utterance of utterances) args.push("-i", utterance.audio.filePath);

  const filters = [];
  const mediaClock = exactCutMediaClock(duration, fps, 48_000);
  const frameCount = mediaClock.frameCount;
  const camera = normalizeEpisodeCamera(cut.camera, cut.motion);
  const bubbleFadeInSeconds = clamp(manifest.video?.bubbleFadeInMilliseconds, 0, 500, 0) / 1000;
  const bubbleFadeOutSeconds = clamp(manifest.video?.bubbleFadeOutMilliseconds, 0, 500, 0) / 1000;
  const appendVisualOverlays = (initialLabel, targetWidth, targetHeight, labelPrefix = "") => {
    let currentLabel = initialLabel;
    visualOverlays.forEach((entry, index) => {
      const inputIndex = sourcePaths.length + index;
      const overlayLabel = `${labelPrefix}ov${index}`;
      const nextLabel = `${labelPrefix}v${index}`;
      const overlayStart = finiteNumber(entry.overlayStart, entry.utterance.timing.bubbleStartInCutSeconds);
      const overlayEnd = finiteNumber(entry.overlayEnd, entry.utterance.timing.bubbleEndInCutSeconds);
      const overlayDuration = Math.max(0, overlayEnd - overlayStart);
      const fadeInDuration = Math.min(bubbleFadeInSeconds, overlayDuration / 2);
      const fadeOutDuration = Math.min(bubbleFadeOutSeconds, overlayDuration / 2);
      const overlayFilters = [
        "format=rgba",
        `tpad=stop_mode=clone:stop_duration=${ffmpegSeconds(duration)}`,
        `fps=${fps}`,
        `trim=end_frame=${frameCount}`,
        "setpts=PTS-STARTPTS",
      ];
      const translationFilter = overlayTranslationFilter(entry.renderOffset);
      if (translationFilter) overlayFilters.push(translationFilter);
      if (fadeInDuration > 0) {
        overlayFilters.push(`fade=t=in:st=${ffmpegSeconds(overlayStart)}:d=${ffmpegSeconds(fadeInDuration)}:alpha=1`);
      }
      if (fadeOutDuration > 0) {
        overlayFilters.push(`fade=t=out:st=${ffmpegSeconds(Math.max(overlayStart, overlayEnd - fadeOutDuration))}:d=${ffmpegSeconds(fadeOutDuration)}:alpha=1`);
      }
      filters.push(`[${inputIndex}:v]${overlayFilters.join(",")}[${overlayLabel}]`);
      filters.push(
        `[${currentLabel}][${overlayLabel}]overlay=0:0:enable='between(t,${ffmpegSeconds(overlayStart)},${ffmpegSeconds(overlayEnd)})'[${nextLabel}]`,
      );
      currentLabel = nextLabel;
    });
    return currentLabel;
  };
  let visualOverlaysConsumedByPageCamera = false;
  if (shotSequence.length > 0) {
    shotSequence.forEach((shot, index) => {
      const shotFrames = Math.max(1, Math.ceil(shot.durationSeconds * fps));
      const shotCamera = shot.camera;
      if (shot.motion === "none") {
        filters.push(
          `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},` +
          `tpad=stop_mode=clone:stop_duration=${ffmpegSeconds(shot.durationSeconds)},` +
          `eq=saturation=${ffmpegDecimal(shotCamera.saturation)}:contrast=${ffmpegDecimal(shotCamera.contrast)}:brightness=${ffmpegDecimal(shotCamera.brightness)},` +
          `fps=${fps},trim=end_frame=${shotFrames},setsar=1,setpts=PTS-STARTPTS,format=rgba[shot${index}]`,
        );
      } else {
        const progress = cameraProgressExpression(
          shotFrames,
          shotCamera.easing,
          shotCamera.motionLeadRatio,
          shotCamera.motionTailRatio,
        );
        const hasKeyframes = Array.isArray(shotCamera.keyframes) && shotCamera.keyframes.length >= 2;
        const zoom = hasKeyframes
          ? cameraKeyframeExpression(shotCamera.keyframes, "zoom", progress)
          : cameraInterpolationExpression(shotCamera.zoomStart, shotCamera.zoomEnd, progress);
        const focusX = hasKeyframes
          ? cameraKeyframeExpression(shotCamera.keyframes, "focusX", progress)
          : cameraInterpolationExpression(shotCamera.focusX, shotCamera.focusXEnd, progress);
        const focusY = hasKeyframes
          ? cameraKeyframeExpression(shotCamera.keyframes, "focusY", progress)
          : cameraInterpolationExpression(shotCamera.focusY, shotCamera.focusYEnd, progress);
        const keyframeZooms = hasKeyframes
          ? shotCamera.keyframes.map((keyframe) => keyframe.zoom)
          : [shotCamera.zoomStart, shotCamera.zoomEnd];
        const constantZoom = Math.max(...keyframeZooms) - Math.min(...keyframeZooms) < 1e-7;
        if (constantZoom) {
          // A fixed-zoom pan should be a translation, not a fresh zoompan
          // resample on every frame.  Cropping the 3x canvas and scaling once
          // removes the tiny scale pulse that optical-flow QA can otherwise
          // detect during slow horizontal moves.
          const cropProgress = progress.replaceAll("on", "n");
          const cropFocusX = hasKeyframes
            ? cameraKeyframeExpression(shotCamera.keyframes, "focusX", cropProgress)
            : cameraInterpolationExpression(shotCamera.focusX, shotCamera.focusXEnd, cropProgress);
          const cropFocusY = hasKeyframes
            ? cameraKeyframeExpression(shotCamera.keyframes, "focusY", cropProgress)
            : cameraInterpolationExpression(shotCamera.focusY, shotCamera.focusYEnd, cropProgress);
          const fixedZoom = ffmpegDecimal(keyframeZooms[0]);
          filters.push(
            `[${index}:v]scale=${cameraWidth}:${cameraHeight}:force_original_aspect_ratio=increase:flags=lanczos,crop=${cameraWidth}:${cameraHeight},` +
            `tpad=stop_mode=clone:stop_duration=${ffmpegSeconds(shot.durationSeconds)},` +
            `crop=w='trunc(iw/${fixedZoom}/2)*2':h='trunc(ih/${fixedZoom}/2)*2':` +
            `x='max(0,min(iw-ow,iw*(${cropFocusX})-ow/2))':y='max(0,min(ih-oh,ih*(${cropFocusY})-oh/2))',` +
            `scale=${width}:${height}:flags=lanczos,fps=${fps},` +
            `eq=saturation=${ffmpegDecimal(shotCamera.saturation)}:contrast=${ffmpegDecimal(shotCamera.contrast)}:brightness=${ffmpegDecimal(shotCamera.brightness)},` +
            `trim=end_frame=${shotFrames},setsar=1,setpts=PTS-STARTPTS,format=rgba[shot${index}]`,
          );
        } else {
          filters.push(
            `[${index}:v]scale=${cameraWidth}:${cameraHeight}:force_original_aspect_ratio=increase:flags=lanczos,crop=${cameraWidth}:${cameraHeight},` +
            `tpad=stop_mode=clone:stop_duration=${ffmpegSeconds(shot.durationSeconds)},` +
            `zoompan=z='${zoom}':x='max(0,min(iw-iw/zoom,iw*(${focusX})-iw/zoom/2))':` +
            `y='max(0,min(ih-ih/zoom,ih*(${focusY})-ih/zoom/2))':d=1:s=${width}x${height}:fps=${fps},` +
            `eq=saturation=${ffmpegDecimal(shotCamera.saturation)}:contrast=${ffmpegDecimal(shotCamera.contrast)}:brightness=${ffmpegDecimal(shotCamera.brightness)},` +
            `trim=end_frame=${shotFrames},setsar=1,setpts=PTS-STARTPTS,format=rgba[shot${index}]`,
          );
        }
      }
    });
    filters.push(
      `${shotSequence.map((_, index) => `[shot${index}]`).join("")}` +
      `concat=n=${shotSequence.length}:v=1:a=0,format=rgba[base0]`,
    );
  } else if (panelLayout) {
    const panelInputOffset = conditionalPanel ? 1 : 0;
    panelLayout.panels.forEach((panel, index) => {
      const slot = panelLayout.slots[index];
      const panelCameraWidth = Math.max(slot.width, slot.width * cameraOversample);
      const panelCameraHeight = Math.max(slot.height, slot.height * cameraOversample);
      const panelCamera = panel.camera;
      const alphaFilter = slot.alphaExpression
        ? `,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${slot.alphaExpression}'`
        : "";
      const fixedZoom = ffmpegDecimal(panelCamera.zoomStart);
      const fixedFocusX = ffmpegDecimal(panelCamera.focusX);
      const fixedFocusY = ffmpegDecimal(panelCamera.focusY);
      filters.push(
        `[${panelInputOffset + index}:v]scale=${panelCameraWidth}:${panelCameraHeight}:force_original_aspect_ratio=increase:flags=lanczos,` +
        `crop=${panelCameraWidth}:${panelCameraHeight},` +
        `crop=w='trunc(iw/${fixedZoom}/2)*2':h='trunc(ih/${fixedZoom}/2)*2':` +
        `x='max(0,min(iw-ow,iw*${fixedFocusX}-ow/2))':y='max(0,min(ih-oh,ih*${fixedFocusY}-oh/2))',` +
        `scale=${slot.width}:${slot.height}:flags=lanczos,setsar=1,format=rgba${alphaFilter},` +
        `tpad=stop_mode=clone:stop_duration=${ffmpegSeconds(duration)},fps=${fps},trim=end_frame=${frameCount},` +
        `setpts=PTS-STARTPTS[p${index}]`,
      );
    });
    filters.push(`color=c=black:s=${width}x${height}:d=${ffmpegSeconds(duration)}:r=${fps},format=rgba[panelbase]`);
    let panelVideoLabel = "panelbase";
    panelLayout.panels.forEach((panel, index) => {
      const slot = panelLayout.slots[index];
      const nextLabel = `panelv${index}`;
      filters.push(`[${panelVideoLabel}][p${index}]overlay=${slot.x}:${slot.y}:shortest=1[${nextLabel}]`);
      panelVideoLabel = nextLabel;
    });
    let flattenedPageLabel;
    if (conditionalPanel) {
      const startUtterance = utterances.find((utterance) => utterance.id === conditionalPanelStartId);
      const endUtterance = utterances.find((utterance) => utterance.id === conditionalPanelEndId);
      const panelStart = finiteNumber(startUtterance?.timing?.bubbleStartInCutSeconds, 0);
      const panelEnd = finiteNumber(endUtterance?.timing?.bubbleEndInCutSeconds, duration);
      filters.push(
        `[${panelVideoLabel}]format=rgba[panelgraded]`,
      );
      filters.push(
        `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},` +
        `setsar=1,format=rgba,tpad=stop_mode=clone:stop_duration=${ffmpegSeconds(duration)},` +
        `fps=${fps},trim=end_frame=${frameCount},setpts=PTS-STARTPTS[fullbase]`,
      );
      filters.push(
        `[fullbase][panelgraded]overlay=0:0:enable='between(t,${ffmpegSeconds(panelStart)},${ffmpegSeconds(panelEnd)})'[pageflat]`,
      );
      flattenedPageLabel = "pageflat";
    } else {
      filters.push(`[${panelVideoLabel}]format=rgba[pageflat]`);
      flattenedPageLabel = "pageflat";
    }
    // Speech graphics, thought dimming, and black separators are part of the
    // authored manga page. Flatten all of them before applying one camera so
    // the page behaves exactly like an ordinary single-frame cut.
    const pageWithOverlays = appendVisualOverlays(flattenedPageLabel, width, height, "page");
    visualOverlaysConsumedByPageCamera = true;
    const pageCamera = panelLayout.pageCamera;
    const pageProgress = cameraProgressExpression(
      frameCount,
      pageCamera.easing,
      pageCamera.motionLeadRatio,
      pageCamera.motionTailRatio,
    );
    const pageHasKeyframes = Array.isArray(pageCamera.keyframes) && pageCamera.keyframes.length >= 2;
    const pageZoom = pageHasKeyframes
      ? cameraKeyframeExpression(pageCamera.keyframes, "zoom", pageProgress)
      : cameraInterpolationExpression(pageCamera.zoomStart, pageCamera.zoomEnd, pageProgress);
    const pageFocusX = pageHasKeyframes
      ? cameraKeyframeExpression(pageCamera.keyframes, "focusX", pageProgress)
      : cameraInterpolationExpression(pageCamera.focusX, pageCamera.focusXEnd, pageProgress);
    const pageFocusY = pageHasKeyframes
      ? cameraKeyframeExpression(pageCamera.keyframes, "focusY", pageProgress)
      : cameraInterpolationExpression(pageCamera.focusY, pageCamera.focusYEnd, pageProgress);
    if (panelLayout.pageMotion === "none") {
      filters.push(
        `[${pageWithOverlays}]eq=saturation=${ffmpegDecimal(pageCamera.saturation)}:contrast=${ffmpegDecimal(pageCamera.contrast)}:brightness=${ffmpegDecimal(pageCamera.brightness)},` +
        `fps=${fps},trim=end_frame=${frameCount},setsar=1,setpts=PTS-STARTPTS,format=rgba[base0]`,
      );
    } else {
      filters.push(
        `[${pageWithOverlays}]scale=${cameraWidth}:${cameraHeight}:flags=lanczos,` +
        `zoompan=z='${pageZoom}':x='max(0,min(iw-iw/zoom,iw*(${pageFocusX})-iw/zoom/2))':` +
        `y='max(0,min(ih-ih/zoom,ih*(${pageFocusY})-ih/zoom/2))':d=1:s=${width}x${height}:fps=${fps},` +
        `eq=saturation=${ffmpegDecimal(pageCamera.saturation)}:contrast=${ffmpegDecimal(pageCamera.contrast)}:brightness=${ffmpegDecimal(pageCamera.brightness)},` +
        `trim=end_frame=${frameCount},setsar=1,setpts=PTS-STARTPTS,format=rgba[base0]`,
      );
    }
  } else if (cut.motion === "none") {
    filters.push(
      `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},` +
      `tpad=stop_mode=clone:stop_duration=${ffmpegSeconds(duration)},fps=${fps},trim=end_frame=${frameCount},` +
      `eq=saturation=${ffmpegDecimal(camera.saturation)}:contrast=${ffmpegDecimal(camera.contrast)}:brightness=${ffmpegDecimal(camera.brightness)},` +
      `setsar=1,setpts=PTS-STARTPTS,format=rgba[base0]`,
    );
  } else {
    const progress = cameraProgressExpression(
      frameCount,
      camera.easing,
      camera.motionLeadRatio,
      camera.motionTailRatio,
    );
    const hasKeyframes = Array.isArray(camera.keyframes) && camera.keyframes.length >= 2;
    const zoom = hasKeyframes
      ? cameraKeyframeExpression(camera.keyframes, "zoom", progress)
      : cameraInterpolationExpression(camera.zoomStart, camera.zoomEnd, progress);
    const focusX = hasKeyframes
      ? cameraKeyframeExpression(camera.keyframes, "focusX", progress)
      : cameraInterpolationExpression(camera.focusX, camera.focusXEnd, progress);
    const focusY = hasKeyframes
      ? cameraKeyframeExpression(camera.keyframes, "focusY", progress)
      : cameraInterpolationExpression(camera.focusY, camera.focusYEnd, progress);
    filters.push(
      `[0:v]scale=${cameraWidth}:${cameraHeight}:force_original_aspect_ratio=increase:flags=lanczos,crop=${cameraWidth}:${cameraHeight},` +
      `tpad=stop_mode=clone:stop_duration=${ffmpegSeconds(duration)},` +
      `zoompan=z='${zoom}':x='max(0,min(iw-iw/zoom,iw*(${focusX})-iw/zoom/2))':` +
      `y='max(0,min(ih-ih/zoom,ih*(${focusY})-ih/zoom/2))':d=1:s=${width}x${height}:fps=${fps},` +
      `eq=saturation=${ffmpegDecimal(camera.saturation)}:contrast=${ffmpegDecimal(camera.contrast)}:brightness=${ffmpegDecimal(camera.brightness)},` +
      `trim=end_frame=${frameCount},setsar=1,setpts=PTS-STARTPTS,format=rgba[base0]`,
    );
  }
  let videoLabel = "base0";
  if (!visualOverlaysConsumedByPageCamera) {
    videoLabel = appendVisualOverlays(videoLabel, width, height);
  }
  if (visualOverlays.length === 0) filters.push(`[${videoLabel}]format=yuv420p[vout]`);
  else filters.push(`[${videoLabel}]format=yuv420p[vout]`);

  const audioLabels = [];
  const audioStartIndex = sourcePaths.length + visualOverlays.length;
  const normalizeVoiceAudio = manifest.video?.normalizeVoiceAudio !== false;
  const voiceTargetLufs = clamp(manifest.video?.voiceTargetLufs, -30, -10, -18);
  const voiceLoudnessRange = clamp(manifest.video?.voiceLoudnessRange, 1, 20, 7);
  const voiceTruePeakDb = clamp(manifest.video?.voiceTruePeakDb, -9, -0.1, -2);
  const voiceFadeInSeconds = clamp(manifest.video?.voiceFadeInMilliseconds, 0, 100, 12) / 1000;
  const voiceFadeOutSeconds = clamp(manifest.video?.voiceFadeOutMilliseconds, 0, 100, 18) / 1000;
  utterances.forEach((utterance, index) => {
    const delayMs = Math.max(0, Math.round(utterance.timing.audioStartInCutSeconds * 1000));
    const label = `a${index}`;
    const audioDuration = Math.max(0, finiteNumber(utterance.audio?.durationSeconds, 0));
    const loudnessFilter = normalizeVoiceAudio
      ? `loudnorm=I=${voiceTargetLufs.toFixed(1)}:LRA=${voiceLoudnessRange.toFixed(1)}:TP=${voiceTruePeakDb.toFixed(1)},`
      : "";
    const fadeInDuration = Math.min(voiceFadeInSeconds, audioDuration / 2);
    const fadeOutDuration = Math.min(voiceFadeOutSeconds, audioDuration / 2);
    const fadeFilter = [
      fadeInDuration > 0
        ? `afade=t=in:st=0:d=${ffmpegSeconds(fadeInDuration)}`
        : "",
      fadeOutDuration > 0
        ? `afade=t=out:st=${ffmpegSeconds(Math.max(0, audioDuration - fadeOutDuration))}:d=${ffmpegSeconds(fadeOutDuration)}`
        : "",
    ].filter(Boolean).join(",");
    filters.push(
      `[${audioStartIndex + index}:a]aresample=48000,${loudnessFilter}`
      + `${fadeFilter ? `${fadeFilter},` : ""}`
      + `adelay=${delayMs}|${delayMs}[${label}]`,
    );
    audioLabels.push(`[${label}]`);
  });
  if (audioLabels.length > 0) {
    filters.push(
      `${audioLabels.join("")}amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0:normalize=0,`
      + `apad=whole_len=${mediaClock.sampleCount},atrim=end_sample=${mediaClock.sampleCount}[aout]`,
    );
  } else {
    filters.push(
      `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=end_sample=${mediaClock.sampleCount}[aout]`,
    );
  }
  const outputPath = join(workDir, `${cut.id}.mp4`);
  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "[vout]", "-map", "[aout]",
    "-r", String(fps), "-c:v", "libx264", "-preset", encodePreset, "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-frames:v", String(frameCount), "-movflags", "+faststart", outputPath,
  );
  await runCommand(ffmpegPath, args);
  return outputPath;
}

export async function renderEpisodeVideo(args = {}) {
  const loaded = args.manifest
    ? { manifest: structuredClone(args.manifest), filePath: nonEmptyString(args.manifestPath) || manifestFilePath(args, args.manifest.id) }
    : await readEpisodeManifest(args);
  let manifest = loaded.manifest;
  const statusBeforeRender = manifest.status;
  if (manifest.status !== "timed" || manifest.utterances.some((utterance) => !utterance.timing)) {
    manifest = compileEpisodeTiming(manifest, args);
  }
  const qualityContract = createMangaQualityContract({
    manifest,
    overrides: manifest.production?.qualityHarness || {},
  });
  const renderPreflight = auditMangaPreflight({ manifest, contract: qualityContract, stage: "planning" });
  if (!renderPreflight.pass) {
    throw new Error(`Render preflight failed closed: ${renderPreflight.failedGateIds.join(", ")}`);
  }
  manifest.production = {
    ...(manifest.production || {}),
    qualityHarness: {
      ...(manifest.production?.qualityHarness || {}),
      automaticRenderPreflight: true,
      contractDigest: qualityContract.digest,
      planningReport: renderPreflight,
    },
  };
  const requestedEncodePreset = nonEmptyString(args.encodePreset ?? args.encode_preset);
  if (["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow"].includes(requestedEncodePreset)) {
    manifest.video = { ...(manifest.video || {}), encodePreset: requestedEncodePreset };
  }
  const canvasDir = resolveCanvasDir(args);
  const rootDir = dirname(loaded.filePath);
  const workDir = join(rootDir, ".render-work");
  const outputDir = join(canvasDir, "assets", "videos");
  await mkdir(workDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  // Two concurrent renders of the same episode share .render-work and the
  // manifest checkpoint, which deadlocks or corrupts both. A pid lock makes
  // the second invocation fail fast; a lock whose pid is dead is stale and
  // reclaimed.
  const lockPath = join(rootDir, ".render.lock");
  const releaseRenderLock = await acquireMangaRenderLock(lockPath);
  const ffmpegPath = nonEmptyString(args.ffmpegPath) || "ffmpeg";
  const utterancesById = new Map(manifest.utterances.map((utterance) => [utterance.id, utterance]));
  const requestedCutIds = nonEmptyString(args.cutIds)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const reuseRenderedCuts = args.reuseRenderedCuts === true || args.reuse_rendered_cuts === true;
  const selectedCutIds = requestedCutIds.length > 0 ? new Set(requestedCutIds) : null;
  const forceRender = args.force === true || args.forceRender === true || args.force_render === true;
  const renderConcurrency = normalizeConcurrency(
    args.renderConcurrency ?? args.render_concurrency ?? manifest.video?.renderConcurrency,
    DEFAULT_RENDER_CONCURRENCY,
    MAX_RENDER_CONCURRENCY,
  );
  const renderCutImpl = typeof args.renderCutVideoImpl === "function"
    ? args.renderCutVideoImpl
    : renderCutVideo;
  const jobs = ensureEpisodeJobs(manifest);
  const checkpoint = manifestCheckpointWriter(loaded.filePath, manifest);
  const cutFiles = new Array(manifest.cuts.length);
  const renderPlans = [];
  let reusedCutCount = 0;

  manifest.video = { ...(manifest.video || {}), renderConcurrency };
  for (const [index, cut] of manifest.cuts.entries()) {
    const utterances = cut.utteranceIds.map((id) => utterancesById.get(id)).filter(Boolean);
    const existingCutPath = join(workDir, `${cut.id}.mp4`);
    const inputHash = await renderCutInputHash(manifest, cut, utterances);
    const previousJob = jobs.render[cut.id];
    const existingCut = await pathExists(existingCutPath);
    const explicitlySelected = selectedCutIds?.has(cut.id) === true;
    const excludedBySelection = Boolean(selectedCutIds && !explicitlySelected);
    const decodableCut = existingCut && await isDecodableRenderedCut(existingCutPath);
    const hashCacheHit = decodableCut
      && previousJob?.status === "complete"
      && previousJob.inputHash === inputHash;
    // Unselected cuts are reused only when their completed input binding still
    // matches. If prepare changed one of them, the render safely expands past
    // the requested minimum instead of producing a mixed-generation MP4.
    const selectionReuse = hashCacheHit && excludedBySelection;
    const canReuse = canReuseRenderedCut({
      existingCut,
      decodableCut,
      previousJob,
      inputHash,
      forceRender,
      explicitlySelected,
      excludedBySelection,
      reuseRenderedCuts,
    });
    const job = {
      ...(previousJob?.inputHash === inputHash ? previousJob : {}),
      id: `render:${manifest.id}:${cut.id}`,
      kind: "render",
      inputHash,
      cutId: cut.id,
      outputPath: existingCutPath,
      attempts: previousJob?.inputHash === inputHash
        ? Math.max(0, Math.round(finiteNumber(previousJob.attempts, 0)))
        : 0,
      queuedAt: new Date().toISOString(),
    };
    jobs.render[cut.id] = job;
    if (canReuse) {
      Object.assign(job, {
        status: "complete",
        reused: true,
        cacheSource: selectionReuse
          ? "explicit-cut-selection"
          : hashCacheHit
            ? "input-hash"
            : "legacy-selection",
        elapsedMs: 0,
        finishedAt: new Date().toISOString(),
        error: "",
      });
      cutFiles[index] = existingCutPath;
      reusedCutCount += 1;
    } else {
      job.status = "queued";
      job.reused = false;
      renderPlans.push({ index, cut, utterances, inputHash, existingCutPath });
    }
  }

  manifest.updatedAt = new Date().toISOString();
  await checkpoint();
  const renderUtterances = renderPlans.flatMap((plan) => plan.utterances);
  await rasterizeEpisodeOverlays(
    renderUtterances,
    workDir,
    renderConcurrency,
    Math.max(320, Math.round(finiteNumber(manifest.video?.width, DEFAULT_VIDEO_WIDTH))),
    Math.max(180, Math.round(finiteNumber(manifest.video?.height, DEFAULT_VIDEO_HEIGHT))),
  );
  const renderStartedAt = Date.now();
  const renderOutcomes = await runWithConcurrency(renderPlans, renderConcurrency, async (plan) => {
    const job = jobs.render[plan.cut.id];
    job.status = "running";
    job.startedAt = new Date().toISOString();
    job.attempts += 1;
    job.error = "";
    manifest.updatedAt = new Date().toISOString();
    try {
      const outputPath = await renderCutImpl({
        manifest,
        cut: plan.cut,
        utterances: plan.utterances,
        workDir,
        ffmpegPath,
      });
      cutFiles[plan.index] = outputPath;
      Object.assign(job, {
        status: "complete",
        outputPath,
        elapsedMs: Date.now() - new Date(job.startedAt).getTime(),
        finishedAt: new Date().toISOString(),
        error: "",
      });
      manifest.updatedAt = new Date().toISOString();
      await checkpoint();
      return { cutId: plan.cut.id, outputPath };
    } catch (error) {
      Object.assign(job, {
        status: "failed",
        elapsedMs: Date.now() - new Date(job.startedAt).getTime(),
        finishedAt: new Date().toISOString(),
        error: error?.message || String(error),
      });
      manifest.updatedAt = new Date().toISOString();
      await checkpoint();
      throw error;
    }
  });
  const renderFailures = renderOutcomes
    .map((outcome, index) => outcome.ok ? null : `${renderPlans[index]?.cut.id || "cut"}: ${outcome.error}`)
    .filter(Boolean);
  if (renderFailures.length > 0) {
    await releaseRenderLock();
    throw new Error(`Failed to render ${renderFailures.length} cut(s):\n${renderFailures.join("\n")}`);
  }
  manifest.metrics = {
    ...(manifest.metrics || {}),
    renderElapsedMs: finiteNumber(manifest.metrics?.renderElapsedMs, 0) + (Date.now() - renderStartedAt),
    renderedCutCount: renderPlans.length,
    reusedCutCount,
  };
  const concatPath = join(workDir, "cuts.ffconcat");
  const concatText = [
    "ffconcat version 1.0",
    ...cutFiles.flatMap((filePath, index) => [
      `file '${filePath.replace(/'/g, "'\\''")}'`,
      // AAC packet padding and MP4 edit lists must not decide the start of the
      // next cut. The authored frame clock is the canonical concat clock.
      `duration ${ffmpegSeconds(manifest.cuts[index]?.timing?.durationSeconds)}`,
    ]),
  ].join("\n");
  await writeFile(concatPath, `${concatText}\n`, "utf8");
  const outputName = sanitizeFileName(args.fileName || `${slug(manifest.id)}-review.mp4`, "manga-review.mp4");
  const outputPath = join(outputDir, extname(outputName) ? outputName : `${outputName}.mp4`);
  const bgmPath = nonEmptyString(args.bgmPath || manifest.video?.bgmPath);
  const bgmVolume = clamp(args.bgmVolume ?? manifest.video?.bgmVolume, 0, 1, 0.1);
  const normalizeMasterAudio = args.normalizeMasterAudio === undefined
    ? manifest.video?.normalizeMasterAudio !== false
    : args.normalizeMasterAudio !== false;
  const masterTargetLufs = clamp(
    args.masterTargetLufs ?? manifest.video?.masterTargetLufs,
    -24,
    -10,
    -14,
  );
  const masterLoudnessRange = clamp(
    args.masterLoudnessRange ?? manifest.video?.masterLoudnessRange,
    1,
    20,
    7,
  );
  const masterTruePeakDb = clamp(
    args.masterTruePeakDb ?? manifest.video?.masterTruePeakDb,
    -9,
    -0.1,
    -1.5,
  );
  const masterLoudnorm = normalizeMasterAudio
    ? `,loudnorm=I=${masterTargetLufs.toFixed(1)}:LRA=${masterLoudnessRange.toFixed(1)}:TP=${masterTruePeakDb.toFixed(1)}`
    : "";
  if (bgmPath && !(await pathExists(resolve(bgmPath)))) {
    throw new Error(`BGM path is not a file: ${resolve(bgmPath)}`);
  }
  if (bgmPath) {
    const bgmDucking = manifest.video?.bgmDucking !== false;
    const bgmDuckThreshold = clamp(manifest.video?.bgmDuckThreshold, 0.001, 1, 0.025);
    const bgmDuckRatio = clamp(manifest.video?.bgmDuckRatio, 1, 20, 8);
    const bgmMixFilter = bgmDucking
      ? `[0:a]aresample=48000,asplit=2[voice][side];`
        + `[1:a]aresample=48000,volume=${bgmVolume.toFixed(3)}[bgm];`
        + `[bgm][side]sidechaincompress=threshold=${bgmDuckThreshold.toFixed(4)}:`
        + `ratio=${bgmDuckRatio.toFixed(2)}:attack=15:release=350[ducked];`
        + `[voice][ducked]amix=inputs=2:duration=first:dropout_transition=2:normalize=0,alimiter=limit=0.950${masterLoudnorm}[aout]`
      : `[1:a]volume=${bgmVolume.toFixed(3)}[bgm];`
        + `[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=2:normalize=0,alimiter=limit=0.950${masterLoudnorm}[aout]`;
    await runCommand(ffmpegPath, [
      // Assemble and master in one pass. Keeping a second full-size episode
      // copy in the work directory can exhaust disk space on long 1080p jobs.
      "-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", concatPath,
      "-stream_loop", "-1", "-i", resolve(bgmPath),
      "-filter_complex", bgmMixFilter,
      "-map", "0:v", "-map", "[aout]", "-c:v", "copy",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
      "-t", ffmpegSeconds(manifest.metrics.videoDurationSeconds), "-movflags", "+faststart", outputPath,
    ]);
  } else if (normalizeMasterAudio) {
    // FFmpeg's loudnorm can silently fall back to dynamic mode when the
    // requested integrated loudness and true-peak ceiling cannot both be met.
    // That changed onset gain by 22.7% across v41 even though every source WAV
    // was matched to the same -19 LUFS target. Analyze once, then apply the
    // largest peak-safe constant gain so relative line levels remain stable.
    const episodeClock = exactCutMediaClock(
      manifest.metrics.videoDurationSeconds,
      manifest.video?.fps,
      48_000,
    );
    const analysisMix = buildEpisodeAudioMixFilter(manifest.utterances, {
      inputOffset: 0,
      sampleRate: 48_000,
      sampleCount: episodeClock.sampleCount,
    });
    const analysis = await runCommand(ffmpegPath, [
      "-hide_banner",
      ...analysisMix.inputPaths.flatMap((audioPath) => ["-i", audioPath]),
      "-filter_complex",
      `${analysisMix.filterGraph};[${analysisMix.outputLabel}]`
      + `loudnorm=I=${masterTargetLufs.toFixed(1)}:LRA=${masterLoudnessRange.toFixed(1)}:`
      + `TP=${masterTruePeakDb.toFixed(1)}:print_format=json[analysis]`,
      "-map", "[analysis]", "-f", "null", "-",
    ]);
    const measuredMasterLoudness = peakSafeConstantGain(
      parseLoudnormMeasurement(analysis.stderr),
      masterTargetLufs,
      masterTruePeakDb,
    );
    const finalMix = buildEpisodeAudioMixFilter(manifest.utterances, {
      inputOffset: 1,
      sampleRate: 48_000,
      sampleCount: episodeClock.sampleCount,
    });
    await runCommand(ffmpegPath, [
      "-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", concatPath,
      ...finalMix.inputPaths.flatMap((audioPath) => ["-i", audioPath]),
      "-filter_complex",
      `${finalMix.filterGraph};[${finalMix.outputLabel}]${constantGainFilter(measuredMasterLoudness)}[aout]`,
      "-map", "0:v", "-map", "[aout]", "-c:v", "copy",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
      "-frames:v", String(episodeClock.frameCount), "-movflags", "+faststart", outputPath,
    ]);
    manifest.video.masterLoudnessMeasurement = measuredMasterLoudness;
  } else {
    await runCommand(ffmpegPath, [
      "-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", concatPath,
      "-c", "copy", "-movflags", "+faststart", outputPath,
    ]);
  }
  manifest.video = {
    ...(manifest.video || {}),
    bgmPath: bgmPath ? resolve(bgmPath) : "",
    bgmVolume,
    normalizeMasterAudio,
    masterTargetLufs,
    masterLoudnessRange,
    masterTruePeakDb,
    masterNormalizationMode: normalizeMasterAudio
      ? (bgmPath ? "single-pass-mixed-program" : "two-pass-peak-safe-constant-gain")
      : "disabled",
  };
  manifest.status = nonEmptyString(args.statusAfterRender ?? args.status_after_render)
    || (args.preserveStatus === true ? statusBeforeRender : "rendered");
  manifest.outputs = {
    ...(manifest.outputs || {}),
    reviewVideo: {
      fileName: basename(outputPath),
      filePath: outputPath,
      assetUrl: `/excalidraw-assets/videos/${encodeURIComponent(basename(outputPath))}`,
      durationSeconds: manifest.metrics.videoDurationSeconds,
      width: manifest.video.width,
      height: manifest.video.height,
      fps: manifest.video.fps,
      createdAt: new Date().toISOString(),
    },
  };
  const finalPreflight = auditMangaPreflight({ manifest, contract: qualityContract, stage: "final" });
  manifest.production.qualityHarness.finalReport = finalPreflight;
  if (!finalPreflight.pass) {
    await releaseRenderLock();
    throw new Error(`Final render quality harness failed closed: ${finalPreflight.failedGateIds.join(", ")}`);
  }
  manifest.updatedAt = new Date().toISOString();
  await writeJsonAtomic(loaded.filePath, manifest);
  await releaseRenderLock();
  return { manifest, filePath: loaded.filePath, outputPath, cutFiles };
}
