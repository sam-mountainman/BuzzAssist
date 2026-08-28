import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";
import PQueue from "p-queue";

import {
  AdaptiveConcurrencyController,
  USAGE_LIMIT_SIGNAL,
  classifyGenerationError,
  runWithAdaptiveConcurrency,
} from "./adaptiveConcurrency.mjs";

import {
  getImageDimensionsFromBuffer,
  readJsonIfExists,
  resolveCanvasDir,
  writeJsonAtomic,
} from "./canvasScene.mjs";
import {
  buildCharacterCandidateJobs,
  markCharacterCandidatesGenerating,
  prepareCharacterWorkflow,
  recordCharacterCandidateResults,
} from "./characterPipeline.mjs";
import {
  findCharacter,
  normalizeCharacterRegistry,
  readCharacterRegistry,
  resolveCharacterReferencePaths,
} from "./characterRegistry.mjs";
import { classifyMangaEditorialBeat } from "./mangaEditorialGrammar.mjs";
import {
  DEFAULT_IMAGE_MODEL,
  generateImageMedia,
  normalizeMediaBatchConcurrency,
} from "./mediaGeneration.mjs";
import { mangaVideoJobInputHash, parseMangaScript } from "./mangaVideoPipeline.mjs";
import {
  buildMangaSceneImagePrompt,
  MANGA_COMPOSITION_SETUPS,
  planMangaSceneCompositions,
} from "./mangaSceneComposition.mjs";

export const MANGA_SCRIPT_IMAGE_PIPELINE_VERSION = 3;
export const DEFAULT_SCRIPT_IMAGE_CONCURRENCY = "auto";
export const DEFAULT_SCRIPT_QA_CONCURRENCY = 1;
export const DEFAULT_SCRIPT_IMAGE_RETRIES = 1;

const execFileAsync = promisify(execFile);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PLATE_TYPES = new Set(["white-solid", "black-solid", "pastel-sky"]);
const VISUAL_QA_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pass", "score", "hardFailures", "issues", "strengths"],
  properties: {
    pass: { type: "boolean" },
    score: { type: "integer", minimum: 0, maximum: 100 },
    hardFailures: { type: "array", items: { type: "string" } },
    issues: { type: "array", items: { type: "string" } },
    strengths: { type: "array", items: { type: "string" } },
  },
};
const LOCATION_RULES = [
  { id: "music-room", name: "高校の音楽室", pattern: /音楽室/u },
  { id: "reunion-venue", name: "華やかな高校同窓会の会場", pattern: /同窓会|華やかな会場/u },
  { id: "university-classroom", name: "大学の講義室", pattern: /大学の講義|講義を受け|ディスカッション/u },
  { id: "university-campus", name: "大学構内の落ち着いた告白場所", pattern: /大学構内|キャンパス/u },
  { id: "ramen-shop", name: "大学近くのラーメン店", pattern: /ラーメン|炒飯/u },
  { id: "graduation-venue", name: "春の大学卒業会場", pattern: /大学を卒業|卒業した/u },
  { id: "early-career-montage", name: "社会人生活（海外事業部・天音の職場・夜の電話）", pattern: /社会人生活|社会人になって数ヶ月|夜はほぼ毎日電話/u, multiScene: true },
  { id: "downfall-montage", name: "さくらの転落（職場・失職後・アルバイト）", pattern: /転落モンタージュ|無断欠勤|解雇された|アルバイト生活/u, multiScene: true },
  { id: "cinema-district", name: "映画館へ続く街中の待ち合わせ場所", pattern: /映画に向かった|待ち合わせ場所|街中/u },
  { id: "family-home", name: "荒野と天音の明るい家庭", pattern: /結婚した|子供も二人|毎日小さな幸せ/u },
  { id: "photo-shop", name: "写真店", pattern: /写真店|写真館|現像|暗室|プリンタ|カウンター/u },
  { id: "mountain-bus-stop", name: "山間の路線バス停", pattern: /バス停|停留所|路線バス|朝便/u },
  { id: "old-station-building", name: "古い駅舎と券売機の記録保管場所", pattern: /駅舎|券売機|回数券|運行記録|防犯映像/u },
  { id: "home", name: "自宅", pattern: /自宅|家|部屋|寝室|リビング|台所/u },
  { id: "school", name: "学校", pattern: /学校|教室|廊下|校庭/u },
  { id: "office", name: "職場", pattern: /職場|会社|事務所|オフィス/u },
  { id: "street", name: "街路", pattern: /街|路地|商店街|駅前|道路|歩道/u },
  { id: "park", name: "公園", pattern: /公園|遊具|広場/u },
  { id: "restaurant", name: "飲食店", pattern: /飲食店|レストラン|喫茶店|カフェ/u },
];

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function pad2(value) {
  return String(Math.max(0, Math.round(Number(value) || 0))).padStart(2, "0");
}

function slug(value, fallback = "episode") {
  const normalized = nonEmptyString(value)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return normalized || fallback;
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

async function fileExists(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function normalizeScriptImageConcurrency(value = DEFAULT_SCRIPT_IMAGE_CONCURRENCY) {
  const raw = String(value ?? DEFAULT_SCRIPT_IMAGE_CONCURRENCY).trim().toLowerCase();
  if (!raw || raw === "auto") return { mode: "auto", initial: 16, label: "auto" };
  if (raw === "unlimited") return { mode: "unlimited", initial: 64, label: "unlimited" };
  const limit = normalizeMediaBatchConcurrency(Number(raw), 16);
  return { mode: "fixed", fixedLimit: limit, initial: limit, label: String(limit) };
}

async function runGenerationJobs(items, concurrencySpec, worker, options = {}) {
  const controller = options.controller || new AdaptiveConcurrencyController({
    mode: concurrencySpec.mode,
    fixedLimit: concurrencySpec.fixedLimit,
    initial: concurrencySpec.initial,
  });
  const outcomes = await runWithAdaptiveConcurrency(
    items.map((item, index) => () => worker(item, index)),
    controller,
    options.adaptiveRunOptions,
  );
  return outcomes.map((outcome) => outcome?.ok
    ? outcome
    : { ...outcome, error: outcome?.error instanceof Error ? outcome.error.message : String(outcome?.error || "Unknown generation failure") });
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/** Deterministic characterless graphic plates; no model can accidentally add a person. */
export function renderEditorialPlatePng(type, width = 1920, height = 1080) {
  if (!PLATE_TYPES.has(type)) throw new Error(`Unsupported editorial plate type: ${type}`);
  const w = Math.max(16, Math.round(Number(width) || 1920));
  const h = Math.max(16, Math.round(Number(height) || 1080));
  const rows = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    const row = y * (w * 4 + 1);
    rows[row] = 0;
    const t = h <= 1 ? 0 : y / (h - 1);
    for (let x = 0; x < w; x += 1) {
      const index = row + 1 + x * 4;
      let r = type === "black-solid" ? 0 : 255;
      let g = r;
      let b = r;
      if (type === "pastel-sky") {
        const top = [251, 230, 244];
        const bottom = [150, 210, 249];
        r = Math.round(top[0] * (1 - t) + bottom[0] * t);
        g = Math.round(top[1] * (1 - t) + bottom[1] * t);
        b = Math.round(top[2] * (1 - t) + bottom[2] * t);
        const glow = Math.max(0, 1 - Math.hypot((x / w - 0.22) / 0.22, (t - 0.1) / 0.16));
        r = Math.min(255, Math.round(r + glow * 16));
        g = Math.min(255, Math.round(g + glow * 20));
        b = Math.min(255, Math.round(b + glow * 18));
      }
      rows[index] = r;
      rows[index + 1] = g;
      rows[index + 2] = b;
      rows[index + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(rows, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function inferLocation(cut = {}) {
  const source = `${cut.purpose || ""} ${cut.utterances?.map((entry) => entry.text).join(" ") || ""}`;
  const explicit = source.match(/(?:場所|ロケーション|location)\s*[：:]\s*([^、。\n]{1,40})/iu)?.[1]?.trim();
  if (explicit) return { id: slug(explicit, `location-${cut.number}`), name: explicit };
  return LOCATION_RULES.find((rule) => rule.pattern.test(source)) || { id: "primary-location", name: "主要舞台" };
}

function inferStoryStage(cut = {}, utterance = {}) {
  const source = `${cut.purpose || ""} ${utterance.text || ""}`;
  if (/同窓会/u.test(source)) {
    return "University-age reunion stage, age 21–22: use polished private clothes specified for each character in the character bible; never use high-school uniforms or adult office suits.";
  }
  if (/高校3年|高校時代|音楽室|秋の放課後/u.test(source)) {
    return "High-school senior stage, age 17–18: use the exact Japanese high-school uniforms described in the character bible; never use adult office or university-reunion clothing.";
  }
  if (/課長|結婚|子供|30代|本当の幸せ/u.test(source)) {
    return "Married thirties stage: preserve the approved adult identities with subtle age progression and use mature family or management-level clothing appropriate to the described moment.";
  }
  if (/社会人|海外事業部|スーツ|有名企業|仕事でミス|無断欠勤|解雇|アルバイト|ニート/u.test(source)) {
    return "Early-career adult stage, age 23 or later: use the office, business, or post-employment clothing specified by the story and character bible; never use school uniforms.";
  }
  if (/大学|講義|就活|卒業|内定|ラーメン|ディスカッション|告白|恋人/u.test(source)) {
    return "University senior stage, age 21–22: use each character's university casual wardrobe from the character bible; never use high-school uniforms or office suits unless the exact line explicitly advances to employment.";
  }
  return "Use the age and wardrobe stage explicitly implied by this cut and line. Approved references lock identity, not a single outfit across the entire multi-year story.";
}

function characterBibleGuidance(characterBible, castNames) {
  const wanted = new Set(castNames);
  const entries = Array.isArray(characterBible?.cast) ? characterBible.cast : [];
  return entries
    .filter((entry) => wanted.has(entry.name))
    .map((entry) => `${entry.name}: ${entry.description || ""} Invariants: ${(entry.invariants || []).join("; ")}. Avoid: ${entry.negativePrompt || "identity drift"}.`)
    .join("\n");
}

function textFreePropDirective(utterance = {}) {
  if (!/(?:英語|大学|学歴|就活|内定|講義|ディスカッション|会議|スマホ|ライン|資料|勉強|授業|仕事|職場|欠勤|解雇|アルバイト|レシート|記録|時刻表|券売機|回数券|申請|防犯映像|掲示|書類|帳票|日付|曜日)/u.test(utterance.text || "")) return "";
  return "Text-free evidence rule: every book cover, brochure, worksheet, notebook, phone screen, sign, badge, ticket, timetable, log, and document must be blank or use only simple non-linguistic color blocks, punched marks, repeated geometric slots, or icon-free material wear. Draw no letters, pseudo-text, numbers, notation, logos, or glyph-like lines. Never attempt to write the quoted dates, times, weekdays, route names, or record fields. Communicate repetition, removal, comparison, and proof through character action, aligned shapes, color, physical gaps, stamps without glyphs, and composition instead.";
}

function dialogueBeatRepairDirective(utterance = {}) {
  const text = utterance.text || "";
  if (text === "別れよう") {
    return "Dialogue-specific staging: make this a tight chest-up reaction two-shot. 荒野 occupies about 60% of the frame with clearly shocked eyes, stopped breath, lowered shoulders, and no raised hand. 花園さくら occupies about 25% in sharp readable profile, shows one unmistakable palm-out stop gesture between them, and keeps physical distance. Crop away most chairs and music stands.";
  }
  if (/^冗談なのはそっちでしょ/u.test(text)) {
    return "Dialogue-specific staging: use a tight chest-up 70mm two-shot. 花園さくら has half-lidded cold eyes, a controlled contemptuous mouth, and one palm-out dismissive gesture. 荒野 visibly drops his shoulders and looks wounded. Keep a clean psychological gap between them and minimize background furniture.";
  }
  if (text === "近いね") {
    return "Dialogue-specific staging: 上沢天音 is the active speaker. Show her at medium-close range in a readable three-quarter view with both eyes and her mouth visible, smiling as she gestures about the conversational distance. Keep 荒野's distinct reaction visible, but never reduce 天音 to a strict side silhouette.";
  }
  if (/^荒野くんは？ 就活どう？/u.test(text)) {
    return "Dialogue-specific staging: 上沢天音 is the active speaker. Preserve enough of the university lecture hall to establish the location, but place 天音 in the foreground at medium-wide scale with a readable three-quarter face, both eyes, and mouth visible as she asks the question. Keep 荒野 in the same spatially coherent scene as the listener.";
  }
  if (/^すごい！ 大手企業の内定/u.test(text)) {
    return "Dialogue-specific staging: 上沢天音 is the active speaker. Keep her identifiable three-quarter or profile face clearly visible at the foreground edge, including both eyes or one eye plus her mouth, while still using 荒野's impressed listener reaction as the over-shoulder focal response. Never show only the back of 天音's head.";
  }
  if (/^就活が決まっただけじゃ夢が叶った/u.test(text)) {
    return "Dialogue-specific staging: 荒野 is the active speaker. Preserve the rainy campus establishing context, but stage the pair as a medium-wide foreground conversation under the shelter so 荒野's three-quarter face, eyes, and mouth are clearly readable. The people must occupy at least the central third of the frame; do not reduce them to tiny distant figures.";
  }
  return "";
}

function applyDialogueCompositionOverride(beat = {}, utterance = {}) {
  if ((utterance.text || "") !== "近いね") return beat;
  return {
    ...beat,
    bubbleReserve: "reserve a compact clean pocket above and to the right without weakening the close conversational distance",
    setup: {
      ...(beat.setup || {}),
      id: "intimate-three-quarter-two-shot",
      azimuth: "three-quarter-left",
      arrangement: "layered-two-shot",
      foreground: "one soft shoulder edge",
    },
  };
}

function registryCharacterForSpeaker(registry, utterance) {
  return findCharacter(registry, utterance.speakerId) || findCharacter(registry, utterance.speakerName);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function registryCharactersMentionedInCut(registry, cut, episodeId) {
  const source = `${cut.purpose || ""}\n${cut.utterances?.map((entry) => entry.text).join("\n") || ""}`;
  return (registry.characters || []).filter((character) => {
    if (character.kind !== "character") return false;
    if (character.episodeId && character.episodeId !== episodeId) return false;
    const tokens = unique([character.name, ...(character.aliases || [])])
      .filter((token) => token.length >= 2);
    return tokens.some((token) => source.includes(token));
  });
}

function narrationClearlyTargetsAnotherCharacter(cut, protagonistCharacter, mentionedCharacters) {
  if (!protagonistCharacter) return false;
  if (cut.utterances?.some((entry) => entry.speakerId !== "narration" && entry.preset !== "narration")) return false;
  const openingNarration = cut.utterances?.find((entry) => entry.speakerId === "narration" || entry.preset === "narration")?.text || "";
  const subjectSource = `${cut.purpose || ""}\n${openingNarration}`;
  if (/(?:俺|僕|わたし|私)(?:は|が|の|たち)/u.test(subjectSource)) return false;
  const protagonistTokens = unique([protagonistCharacter.name, ...(protagonistCharacter.aliases || [])]);
  if (protagonistTokens.some((token) => token && subjectSource.includes(token))) return false;
  return mentionedCharacters
    .filter((character) => character.id !== protagonistCharacter.id)
    .some((character) => unique([character.name, ...(character.aliases || [])])
      .filter(Boolean)
      .some((token) => new RegExp(`${escapeRegExp(token)}(?:は|が|の)`, "u").test(subjectSource)));
}

function compositionForPanel(base, panelIndex, recentIds = []) {
  const baseIndex = Math.max(0, MANGA_COMPOSITION_SETUPS.findIndex((entry) => entry.id === base.setup.id));
  const offsets = [0, 7, 13];
  let setup = MANGA_COMPOSITION_SETUPS[(baseIndex + offsets[panelIndex % offsets.length]) % MANGA_COMPOSITION_SETUPS.length];
  if (recentIds.includes(setup.id)) {
    setup = MANGA_COMPOSITION_SETUPS[(baseIndex + offsets[panelIndex % offsets.length] + 3) % MANGA_COMPOSITION_SETUPS.length];
  }
  return {
    ...base,
    id: `${base.id}:panel-${panelIndex + 1}`,
    setup,
    bubbleReserve: "reserve a clean interior pocket, but generate no bubble or readable text",
  };
}

function splitPanelSafeZoneDirective(splitType, panelIndex) {
  if (splitType !== "story-3") return "Keep every required face and story object well inside the final panel crop safe area.";
  const continuity = "Cross-panel continuity: this three-panel montage belongs to one explicit story stage. Keep the approved character identity, age, hair, glasses, and the same wardrobe across all three panels unless the script explicitly requires a wardrobe change.";
  if (panelIndex === 0) {
    return `${continuity} Final-page crop safety: this source becomes a narrow full-height LEFT panel occupying about 39% of the page. Keep exactly one primary character's complete face, hands, and torso centered inside the middle 25% horizontal band of the source with generous margin on both sides. No required body part may touch a source edge. Do not place empty furniture or background in that band.`;
  }
  if (panelIndex === 1) {
    return `${continuity} Final-page crop safety: this source becomes the UPPER-RIGHT panel with a rising diagonal lower edge. Keep all required faces in the upper-center safe area, away from every edge and diagonal; any foreground shoulder must cover less than 15% of the frame.`;
  }
  return `${continuity} Final-page crop safety: this source becomes the LOWER-RIGHT panel under a rising diagonal upper edge. Compose unusually large headroom on purpose: place the primary face center between 58% and 70% of source-image height and between 55% and 75% of source-image width. The complete hair, eyes, glasses, nose, mouth, and chin must remain in the lower half, with the top 45% reserved for scenery. Keep hands and story props below the diagonal too. Never place the face in the ordinary upper third because the final page mask will hide it.`;
}

function editorialClassification(utterance, cut, index) {
  const visibleParticipantCount = unique(cut.utterances
    .map((entry) => entry.speakerId)
    .filter((id) => id && id !== "narration")).length;
  return classifyMangaEditorialBeat({
    utterance,
    openingExposition: index < 2 && utterance.preset === "narration",
    allowNeutralPlate: true,
    allowThoughtInference: true,
    visibleParticipantCount,
    montageBeatCount: /(?:翌|その後|それから|各地|日々|年月|数ヶ月|毎日|ルーティン)/u.test(utterance.text) ? 3 : 0,
  });
}

function visualBeatPrompt(beat, context, editorial, panelRole = "") {
  const additions = [
    buildMangaSceneImagePrompt(beat, context),
    panelRole ? `Panel story role: ${panelRole}. Make it a distinct viewpoint and moment, not a duplicate pose.` : "",
    editorial.thoughtFocus.recommended
      ? "Private-thought staging: keep the whole scene normally illustrated; post-production will dim the surroundings and reveal only a face-sized spotlight. Keep the thinking face unobstructed."
      : "",
    "Do not draw speech balloons or lettering. Typography and bubbles are deterministic overlays added after generation.",
  ];
  return additions.filter(Boolean).join("\n");
}

/**
 * Converts one parsed script into every required visual job before generation.
 * Every paid image job is exactly one image; the worker pool controls concurrency.
 */
export function createMangaScriptImagePlan(input = {}) {
  const scriptText = String(input.scriptText ?? "");
  const registry = normalizeCharacterRegistry(input.registry && typeof input.registry === "object" ? input.registry : null);
  const parsed = input.parsed || parseMangaScript(scriptText, { title: input.title, registry });
  if (parsed.utterances.length === 0) throw new Error("The script contains no dialogue/narration lines in 'name: text' form.");
  const episodeId = nonEmptyString(input.episodeId) || slug(parsed.title, `episode-${sha256(scriptText).slice(0, 8)}`);
  const manifest = {
    id: episodeId,
    title: parsed.title,
    scriptText,
    cuts: parsed.cuts.map((cut) => ({
      ...cut,
      description: cut.purpose,
      utteranceIds: cut.utterances.map((entry) => entry.id),
    })),
    utterances: parsed.utterances,
  };
  const compositionPlan = planMangaSceneCompositions({ manifest });
  const compositionByUtterance = new Map(compositionPlan.beats.map((entry) => [entry.utteranceId, entry]));
  const assetDir = resolve(nonEmptyString(input.assetDir) || join(process.cwd(), "canvas", "assets", slug(episodeId)));
  const canvasDir = resolve(nonEmptyString(input.canvasDir) || dirname(dirname(assetDir)));
  const jobs = [];
  const pages = [];
  const editorialDecisions = [];
  const environmentJobByLocation = new Map();
  const protagonistCharacter = findCharacter(registry, input.protagonistSpeakerId)
    || findCharacter(registry, input.protagonistSpeakerName);
  const characterBible = input.characterBible && typeof input.characterBible === "object" ? input.characterBible : null;
  let globalIndex = 0;

  for (const cut of parsed.cuts) {
    const location = inferLocation(cut);
    const registryLocation = registry.characters?.find((entry) => entry.kind === "location" && (
      entry.id === location.id || entry.name === location.name || entry.aliases?.includes(location.name)
    ));
    let locationRefs = registryLocation
      ? resolveCharacterReferencePaths(registry, [registryLocation.id], { canvasDir })
      : [];
    let environmentDependency = "";
    const cutHasNarration = cut.utterances.some((entry) => entry.speakerId === "narration" || entry.preset === "narration");
    const mentionedCharacters = registryCharactersMentionedInCut(registry, cut, episodeId);
    const includeNarrationProtagonist = cutHasNarration
      && protagonistCharacter
      && !narrationClearlyTargetsAnotherCharacter(cut, protagonistCharacter, mentionedCharacters);
    const cutCharacterIds = unique([
      ...cut.utterances.map((entry) => registryCharacterForSpeaker(registry, entry)?.id),
      ...mentionedCharacters.map((entry) => entry.id),
      ...(includeNarrationProtagonist ? [protagonistCharacter.id] : []),
    ]);
    const characterRefs = resolveCharacterReferencePaths(registry, cutCharacterIds, { canvasDir });
    const compactCharacterRefs = cutCharacterIds.flatMap((characterId) => (
      resolveCharacterReferencePaths(registry, [characterId], { canvasDir }).slice(0, 1)
    ));
    const castNames = unique(cutCharacterIds.map((characterId) => findCharacter(registry, characterId)?.name));

    for (const utterance of cut.utterances) {
      const originalBeat = compositionByUtterance.get(utterance.id);
      const beat = applyDialogueCompositionOverride(originalBeat, utterance);
      if (beat !== originalBeat) {
        Object.assign(originalBeat, beat);
        compositionByUtterance.set(utterance.id, originalBeat);
      }
      const editorial = editorialClassification(utterance, cut, globalIndex);
      editorialDecisions.push(editorial);
      const stem = `${cut.id}-${utterance.id.replace(`${cut.id}-`, "")}`;
      const storyStage = inferStoryStage(cut, utterance);
      const bibleGuidance = characterBibleGuidance(characterBible, castNames);
      const textFreeProps = textFreePropDirective(utterance);
      const dialogueRepair = dialogueBeatRepairDirective(utterance);
      if (editorial.editorialPlate.recommended) {
        const outputPath = join(assetDir, `${stem}-${editorial.editorialPlate.type}.png`);
        jobs.push({
          id: `plate:${utterance.id}`,
          kind: "editorial-plate",
          dependencies: [],
          outputPath,
          plateType: editorial.editorialPlate.type,
          imageCount: 0,
          inputHash: mangaVideoJobInputHash("editorial-plate", { type: editorial.editorialPlate.type, width: 1920, height: 1080 }),
          editorial,
        });
        pages.push({ utteranceId: utterance.id, cutId: cut.id, assetJobId: `plate:${utterance.id}`, editorial, wholePageCamera: true });
        globalIndex += 1;
        continue;
      }

      if (locationRefs.length === 0) {
        let environmentJob = environmentJobByLocation.get(location.id);
        if (!environmentJob) {
          const outputPath = join(assetDir, `reference-environment-${slug(location.id, "primary-location")}.png`);
          environmentJob = {
            id: `environment-sheet:${location.id}`,
            kind: "environment-sheet",
            dependencies: [],
            outputPath,
            prompt: [
              "Create one original 16:9 Japanese motion-comic ENVIRONMENT REFERENCE ATLAS, 1920x1080.",
              `Location: ${location.name}. Episode context: ${parsed.title}.`,
              location.multiScene
                ? "Show four clean panels covering the distinct recurring places required by this montage. Each place must be unambiguous, coherent, and reusable for its corresponding story panel."
                : "Show four clean panels of exactly the same place: establishing view, reverse view, side view, and important prop/detail view.",
              location.multiScene
                ? "Lock the architecture, palette, materials, permanent props, and light direction within each depicted place; do not blend the separate places into one impossible room."
                : "Lock architecture, doors, windows, furniture, permanent props, palette, material finish, time-of-day baseline, and light direction across all four panels.",
              "Separate all four panels with solid, clearly visible black gutters; never use white or pale divider lines.",
              "No people, no character silhouettes, no speech bubbles, no captions, no readable signs, no logo, no watermark.",
              "This is a continuity atlas, not a dramatic story frame. Keep useful empty space and complete environmental coverage.",
            ].join("\n"),
            referenceImagePaths: [],
            model: nonEmptyString(input.model) || DEFAULT_IMAGE_MODEL,
            aspectRatio: "16:9",
            imageSize: "2K",
            quality: "high",
            imageCount: 1,
            location,
          };
          environmentJob.inputHash = mangaVideoJobInputHash("environment-sheet", {
            prompt: environmentJob.prompt,
            model: environmentJob.model,
            location,
            imageCount: 1,
          });
          environmentJobByLocation.set(location.id, environmentJob);
          jobs.push(environmentJob);
        }
        environmentDependency = environmentJob.id;
        locationRefs = [environmentJob.outputPath];
      }

      const splitCount = editorial.split.type === "story-3" ? 3 : editorial.split.type === "vertical-2" ? 2 : 1;
      const panelJobs = [];
      const panelRoles = splitCount === 3 ? ["cause / earlier moment", "action / intermediate moment", "consequence / later moment"] : ["speaker or cause", "listener reaction or consequence"];
      for (let panelIndex = 0; panelIndex < splitCount; panelIndex += 1) {
        const panelBeat = splitCount > 1 ? compositionForPanel(beat, panelIndex, panelJobs.map((job) => job.composition.setup.id)) : beat;
        const id = splitCount > 1 ? `panel:${utterance.id}:${panelIndex + 1}` : `image:${utterance.id}`;
        const outputPath = join(assetDir, splitCount > 1 ? `${stem}-panel-${panelIndex + 1}.png` : `${stem}.png`);
        const narrationIdentityAnchor = (utterance.speakerId === "narration" || utterance.preset === "narration")
          && protagonistCharacter
          && cutCharacterIds.includes(protagonistCharacter.id)
          ? `Narration identity anchor: ${protagonistCharacter.name} is the story protagonist and the first-person narrator referred to as 俺. Use the approved ${protagonistCharacter.name} identity whenever this narration depicts the narrator; do not replace explicitly named other characters.`
          : "";
        const prompt = [visualBeatPrompt(panelBeat, {
          location: location.name,
          cast: castNames,
          continuity: "lock face, hair, body identity, recurring props, time of day, and geography to approved references; change age and wardrobe only as required by the explicit story stage; vary viewpoint and blocking from adjacent images",
        }, editorial, splitCount > 1 ? panelRoles[panelIndex] : ""), splitCount > 1 ? splitPanelSafeZoneDirective(editorial.split.type, panelIndex) : "", `Story age and wardrobe stage: ${storyStage}`, textFreeProps, dialogueRepair, bibleGuidance ? `Character bible authority:\n${bibleGuidance}` : "", narrationIdentityAnchor].filter(Boolean).join("\n");
        const referenceImagePaths = unique([...characterRefs, ...locationRefs]).slice(0, 8);
        const fallbackReferenceImagePaths = unique([
          ...compactCharacterRefs,
          ...(compactCharacterRefs.length < 3 ? locationRefs : []),
        ]).slice(0, 3);
        const job = {
          id,
          kind: splitCount > 1 ? "split-panel" : "scene-image",
          dependencies: environmentDependency ? [environmentDependency] : [],
          outputPath,
          prompt,
          referenceImagePaths,
          fallbackReferenceImagePaths,
          model: nonEmptyString(input.model) || DEFAULT_IMAGE_MODEL,
          aspectRatio: "16:9",
          imageSize: "2K",
          quality: "high",
          imageCount: 1,
          composition: panelBeat,
          editorial,
          location,
          characterIds: cutCharacterIds,
          castNames,
          storyStage,
          textFreeEvidencePolicy: Boolean(textFreeProps),
        };
        job.inputHash = mangaVideoJobInputHash(job.kind, {
          prompt: job.prompt,
          referenceImagePaths: job.referenceImagePaths,
          model: job.model,
          imageCount: 1,
        });
        jobs.push(job);
        panelJobs.push(job);
      }
      if (splitCount > 1) {
        const pageId = `split-page:${utterance.id}`;
        const outputPath = join(assetDir, `${stem}-${editorial.split.type}.png`);
        const pageJob = {
          id: pageId,
          kind: "split-page",
          dependencies: panelJobs.map((entry) => entry.id),
          panelPaths: panelJobs.map((entry) => entry.outputPath),
          referenceImagePaths: unique(panelJobs.flatMap((entry) => entry.referenceImagePaths || [])).slice(0, 4),
          fallbackReferenceImagePaths: unique(panelJobs.flatMap((entry) => entry.fallbackReferenceImagePaths || [])).slice(0, 4),
          outputPath,
          splitType: editorial.split.type,
          separatorWidthRatio: editorial.split.separatorWidthRatio,
          imageCount: 0,
          composition: beat,
          castNames,
          storyStage,
          montageTimeline: /(?:それから|その後|時は流れ|日々|年月|数ヶ月|毎日|ルーティン)/u.test(utterance.text || ""),
          editorial,
          inputHash: mangaVideoJobInputHash("split-page", {
            inputs: panelJobs.map((entry) => entry.inputHash),
            splitType: editorial.split.type,
            separatorWidthRatio: editorial.split.separatorWidthRatio,
            flattenBeforeCamera: true,
          }),
        };
        jobs.push(pageJob);
        pages.push({
          utteranceId: utterance.id,
          cutId: cut.id,
          assetJobId: pageId,
          editorial,
          panelJobIds: panelJobs.map((entry) => entry.id),
          panelCamera: "static",
          flattenBeforeCamera: true,
          wholePageCamera: true,
        });
      } else {
        pages.push({ utteranceId: utterance.id, cutId: cut.id, assetJobId: panelJobs[0].id, editorial, wholePageCamera: true });
      }
      globalIndex += 1;
    }
  }
  const jobById = new Map(jobs.map((entry) => [entry.id, entry]));
  return {
    version: MANGA_SCRIPT_IMAGE_PIPELINE_VERSION,
    episodeId,
    title: parsed.title,
    scriptSha256: sha256(scriptText),
    assetDir,
    manifest,
    compositionPlan,
    editorialDecisions,
    jobs,
    pages: pages.map((entry) => ({ ...entry, outputPath: jobById.get(entry.assetJobId)?.outputPath })),
    policy: {
      allJobsSubmittedUpFront: true,
      paidImageCountPerJob: 1,
      maximumConcurrency: 10,
      adjacentCompositionMinimumChangedAxes: 3,
      repeatedSetupLookback: 6,
      typographyGeneratedInImage: false,
      splitComposition: "generate-panels-independently; deterministic-black-gutters; flatten-page-before-camera",
      splitPanelCamera: "static",
      splitPageCamera: "single-continuous",
      editorialPlateCharacterPolicy: "strictly-none",
    },
  };
}

async function composeSplitPage(job) {
  const gutter = Math.max(8, Math.round(1920 * Number(job.separatorWidthRatio || 0.0145)));
  const inputs = job.panelPaths.flatMap((path) => ["-i", path]);
  let filter;
  if (job.splitType === "story-3") {
    const splitX = Math.round(1920 * 0.39);
    const halfGutter = gutter / 2;
    const leftW = Math.max(2, Math.floor(splitX - halfGutter));
    const rightX = Math.min(1918, Math.ceil(splitX + halfGutter));
    const rightW = 1920 - rightX;
    const startY = 1080 * 0.36;
    const endY = 1080 * 0.63;
    const topH = Math.max(2, Math.ceil(endY - halfGutter));
    const bottomY = Math.max(0, Math.min(1078, Math.floor(startY + halfGutter)));
    const bottomH = 1080 - bottomY;
    const slope = (endY - startY) / Math.max(1, rightW - 1);
    filter = [
      `[0:v]scale=${leftW}:1080:force_original_aspect_ratio=increase,crop=${leftW}:1080[p0]`,
      `[1:v]scale=${rightW}:${topH}:force_original_aspect_ratio=increase,crop=${rightW}:${topH},format=rgba,` +
        `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte(Y,${(startY - halfGutter).toFixed(4)}+X*${slope.toFixed(8)}),255,0)'[p1]`,
      `[2:v]scale=${rightW}:${bottomH}:force_original_aspect_ratio=increase,crop=${rightW}:${bottomH},format=rgba,` +
        `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(gte(Y,${(startY + halfGutter - bottomY).toFixed(4)}+X*${slope.toFixed(8)}),255,0)'[p2]`,
      `color=c=black:s=1920x1080[base]`,
      `[base][p0]overlay=0:0[b1]`,
      `[b1][p1]overlay=${rightX}:0[b2]`,
      `[b2][p2]overlay=${rightX}:${bottomY}[out]`,
    ].join(";");
  } else {
    const leftW = Math.round((1920 - gutter) * 0.47);
    const rightX = leftW + gutter;
    const rightW = 1920 - rightX;
    filter = [
      `[0:v]scale=${leftW}:1080:force_original_aspect_ratio=increase,crop=${leftW}:1080[p0]`,
      `[1:v]scale=${rightW}:1080:force_original_aspect_ratio=increase,crop=${rightW}:1080[p1]`,
      `color=c=black:s=1920x1080[base]`,
      `[base][p0]overlay=0:0[b1]`,
      `[b1][p1]overlay=${rightX}:0[out]`,
    ].join(";");
  }
  await mkdir(dirname(job.outputPath), { recursive: true });
  await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...inputs, "-filter_complex", filter, "-map", "[out]", "-frames:v", "1", job.outputPath]);
  return { outputPath: job.outputPath };
}

async function defaultTechnicalQa(job) {
  const buffer = await readFile(job.outputPath);
  const dimensions = getImageDimensionsFromBuffer(buffer, job.outputPath);
  const aspect = dimensions.width / dimensions.height;
  const issues = [];
  if (buffer.length < 1024) issues.push("image file is unexpectedly small");
  if (Math.abs(aspect - 16 / 9) > 0.04) issues.push(`aspect ratio is ${aspect.toFixed(3)}, expected 16:9`);
  if (job.kind === "split-page" && (dimensions.width !== 1920 || dimensions.height !== 1080)) issues.push("flattened split page is not 1920x1080");
  return { pass: issues.length === 0, issues, dimensions, checks: ["decode", "file-size", "aspect-ratio", "split-page-size"] };
}

async function runQaCommand(command, payload) {
  if (!nonEmptyString(command)) return null;
  const { stdout } = await execFileAsync("/bin/sh", ["-lc", command], {
    env: { ...process.env, BUZZASSIST_IMAGE_QA_INPUT: JSON.stringify(payload) },
    maxBuffer: 10 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout.trim());
  return { pass: parsed.pass === true, issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : [], evaluator: "external-command" };
}

export function mangaImageQaStructureContract(job = {}) {
  if (job.kind === "split-page") return "Require the authored number of panels and solid black dividers between them.";
  if (job.kind === "environment-sheet") return "Require exactly four atlas panels and solid black gutters between all panels.";
  if (job.kind === "split-panel") return "Require exactly one standalone panel image. Multiple panels, any divider, or a precomposed page are failures; gutters are added only by the later split-page job.";
  if (job.kind === "scene-image") return "Require one continuous scene image. Multiple panels or any divider are failures.";
  if (job.kind === "editorial-plate") return "Require one characterless full-frame plate with no panel divider.";
  return "Judge the requested structure literally for this job kind.";
}

function spawnToCompletion(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`Process timed out after ${options.timeoutMs}ms: ${command}`));
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString("utf8");
      const errorOutput = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) reject(new Error(`${command} exited ${code}: ${[errorOutput, output].filter(Boolean).join("\n")}`.slice(0, 24_000)));
      else resolvePromise({ stdout: output, stderr: errorOutput });
    });
    child.stdin.end();
  });
}

export function mangaImageQaVisualPrompt(payload) {
  const expected = payload.job.kind === "editorial-plate"
    ? `A strict ${payload.job.plateType} characterless editorial plate. No room, scenery, person, silhouette, text, logo, or watermark.`
      : payload.job.kind === "split-page"
        ? `A finished ${payload.job.splitType} manga page with intentional black gutters. Judge the entire page as one composition; panel contents must be coherent and distinct.${payload.job.montageTimeline ? " This is an intentional earlier/intermediate/later montage: weather, time of day, and moment may change between panels when the progression is visually clear. Do not require identical weather across the montage; require stable character identity and a recognizable recurring location instead." : ""}`
        : payload.job.kind === "split-panel"
          ? `One standalone static manga panel for a later ${payload.job.editorial?.split?.type || "split"} page. It must be one continuous image with no divider, no gutter, and no precomposed neighboring panel.`
      : payload.job.kind === "environment-sheet"
        ? payload.job.location?.multiScene
          ? `A coherent four-panel multi-location montage atlas for ${payload.job.location?.name || "the montage"}, with solid black gutters, no people, and no readable text. Separate story places must remain distinct rather than being forced into one room.`
          : `A consistent four-view environment atlas for ${payload.job.location?.name || "the location"}, with solid black gutters, no people or readable text.`
        : [
            payload.job.composition?.purpose,
            payload.job.composition?.visibleAction,
            payload.job.composition?.setup ? `Camera: ${JSON.stringify(payload.job.composition.setup)}` : "",
            payload.job.editorial?.thoughtFocus?.recommended ? "The face must remain clear for a compact post-production thought spotlight." : "",
          ].filter(Boolean).join(" ");
  const comparisonReferenceNames = mangaImageQaReferenceCandidates(payload.job).slice(0, 4).map((referencePath, index) => (
    index < (payload.job.castNames || []).length
      ? `attachment ${index + 1} after the candidate = ${payload.job.castNames[index]} approved identity`
      : `attachment ${index + 1} after the candidate = environment or secondary continuity reference`
  ));
  return [
    "You are a fresh blind visual quality evaluator. The FIRST attached image is the generated candidate. Any later attached images are approved identity/environment references used only for consistency comparison.",
    "Do not edit files, do not generate an image, do not browse, and do not infer credit for invisible intentions.",
    `Job kind: ${payload.job.kind}. Expected result: ${expected}`,
    Array.isArray(payload.job.castNames) && payload.job.castNames.length > 0
      ? `Expected approved primary cast: ${payload.job.castNames.join(", ")}. Do not infer cast count from the number of attached reference sheets. Unnamed, non-prominent background crowd is allowed only when the story or location explicitly requires classmates, a reunion, graduation, workplace, or street activity; do not treat that crowd as an extra primary cast member.`
      : "",
    payload.job.kind === "scene-image"
      && payload.job.composition?.speakerId
      && payload.job.composition.speakerId !== "narration"
      && Array.isArray(payload.job.castNames)
      && payload.job.castNames[0]
      ? `Active spoken-dialogue speaker: ${payload.job.castNames[0]}. Their identifiable face (eyes and mouth, or a readable profile with one eye and mouth) must be visibly present and usable for speech-bubble placement. A back-of-head-only speaker or a speaker reduced to an unreadably tiny distant figure is a hard failure.`
      : "",
    comparisonReferenceNames.length > 0 ? `Reference attachment identity map: ${comparisonReferenceNames.join("; ")}.` : "",
    payload.job.storyStage ? `Explicit story stage: ${payload.job.storyStage}` : "",
    "Approved character references lock face, hair, body identity, and rendering style. Their displayed outfit may belong to another age stage; do not penalize an intentional wardrobe change that follows the explicit story stage.",
    `Structure contract: ${mangaImageQaStructureContract(payload.job)}`,
    payload.job.textFreeEvidencePolicy
      ? "Text-free evidence contract: do not require any readable word, date, time, weekday, number, route name, or form field. Judge whether repetition, removal, comparison, or proof is communicated by physical gaps, aligned non-linguistic shapes, color, wear, character action, and composition. Asking the generator to add readable labels or numbers would violate the contract."
      : "",
    "Hard-fail any: unreadable or generated text, speech bubble baked into artwork, violation of the structure contract above, character on a strict editorial plate, broken anatomy/hand/face, duplicated body parts, wrong cast count, severe identity drift, obvious reference-camera copying, incoherent environment, or requested action/camera not visibly delivered.",
    "Also penalize generic centered eye-level staging, excessive empty accidental space, repeated-looking poses, weak subject hierarchy, and panel-to-panel inconsistency.",
    payload.job.kind === "split-panel"
      ? "This candidate is only one static source panel. Do not require gutters, neighboring panels, a flattened page, or panel motion; those belong to the later split-page job."
      : payload.job.kind === "split-page"
        ? "This candidate is the final flattened page with static panel contents and intentional gutters. Judge it as one page and do not request separate motion inside individual panels."
        : "",
    "Set pass=true only at score 88 or higher with zero hardFailures. Return concise, actionable Japanese issue strings so a correction prompt can fix them.",
  ].filter(Boolean).join("\n");
}

export function mangaImageQaReferenceCandidates(job = {}) {
  return unique([
    ...(job.fallbackReferenceImagePaths || []),
    ...(job.referenceImagePaths || []),
  ]);
}

async function runCodexVisualQa(payload, options = {}) {
  const qaDir = resolve(nonEmptyString(options.qaDir) || join(dirname(payload.outputPath), ".qa"));
  await mkdir(qaDir, { recursive: true });
  const schemaPath = join(qaDir, "visual-qa-schema.json");
  const outputPath = join(qaDir, `${slug(payload.job.id, "image")}-attempt-${payload.attempt + 1}.json`);
  if (!await fileExists(schemaPath)) await writeFile(schemaPath, `${JSON.stringify(VISUAL_QA_SCHEMA, null, 2)}\n`, "utf8");
  const prompt = mangaImageQaVisualPrompt(payload);
  const comparisonReferences = [];
  for (const candidate of mangaImageQaReferenceCandidates(payload.job)) {
    if (comparisonReferences.length >= 4) break;
    if (candidate !== payload.outputPath && await fileExists(candidate)) comparisonReferences.push(candidate);
  }
  const cliArgs = [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox", "read-only",
    "--skip-git-repo-check",
    "--image", payload.outputPath, ...comparisonReferences,
    "--output-schema", schemaPath,
    "--output-last-message", outputPath,
    "--color", "never",
    "--json",
    ...(nonEmptyString(options.model) ? ["--model", options.model] : []),
    prompt,
  ];
  const processResult = await spawnToCompletion(nonEmptyString(options.codexCommand) || "codex", cliArgs, {
    cwd: resolve(nonEmptyString(options.projectDir) || process.cwd()),
    timeoutMs: Math.max(30_000, Number(options.timeoutMs) || 10 * 60_000),
  });
  let rawResult = await fileExists(outputPath) ? await readFile(outputPath, "utf8") : "";
  if (!rawResult.trim()) {
    const events = processResult.stdout.split("\n").map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    rawResult = [...events].reverse().find((event) => event.type === "item.completed" && event.item?.type === "agent_message")?.item?.text || "";
  }
  if (!rawResult.trim()) throw new Error("Codex visual QA completed without a structured verdict.");
  const parsed = JSON.parse(rawResult);
  const hardFailures = Array.isArray(parsed.hardFailures) ? parsed.hardFailures.map(String) : [];
  const issues = Array.isArray(parsed.issues) ? parsed.issues.map(String) : [];
  const rawScore = Number(parsed.score);
  const score = rawScore >= 0 && rawScore <= 1 && parsed.pass === true ? rawScore * 100 : rawScore;
  return {
    pass: parsed.pass === true && Number.isFinite(score) && score >= 88 && hardFailures.length === 0,
    score,
    hardFailures,
    issues: [...hardFailures, ...issues],
    strengths: Array.isArray(parsed.strengths) ? parsed.strengths.map(String) : [],
    evaluator: "codex-ephemeral-blind-vision",
  };
}

async function makeGrokQaImageBlock(inputPath, outputPath, width) {
  await execFileAsync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-i", inputPath,
    "-vf", `scale=${width}:-2:force_original_aspect_ratio=decrease`,
    "-frames:v", "1", "-q:v", "6", outputPath,
  ]);
  return { type: "image", data: (await readFile(outputPath)).toString("base64"), mimeType: "image/jpeg" };
}

async function runGrokVisualQa(payload, options = {}) {
  const qaDir = resolve(nonEmptyString(options.qaDir) || join(dirname(payload.outputPath), ".qa"));
  await mkdir(qaDir, { recursive: true });
  const stem = `${slug(payload.job.id, "image")}-attempt-${payload.attempt + 1}-grok`;
  const blocks = [{ type: "text", text: mangaImageQaVisualPrompt(payload) }];
  blocks.push(await makeGrokQaImageBlock(payload.outputPath, join(qaDir, `${stem}-candidate.jpg`), 384));
  let referenceIndex = 0;
  for (const candidate of mangaImageQaReferenceCandidates(payload.job)) {
    if (referenceIndex >= 4) break;
    if (candidate === payload.outputPath || !await fileExists(candidate)) continue;
    referenceIndex += 1;
    blocks.push(await makeGrokQaImageBlock(candidate, join(qaDir, `${stem}-reference-${referenceIndex}.jpg`), 192));
  }
  const processResult = await spawnToCompletion(nonEmptyString(options.grokCommand) || "grok", [
    "--prompt-json", JSON.stringify(blocks),
    "--json-schema", JSON.stringify(VISUAL_QA_SCHEMA),
    "--output-format", "json",
    "--no-plan", "--no-subagents", "--no-memory", "--no-auto-update",
    "--max-turns", "3", "--disable-web-search",
    "--disallowed-tools", "run_terminal_cmd,search_replace,apply_patch,write_file,Agent",
  ], {
    cwd: resolve(nonEmptyString(options.projectDir) || process.cwd()),
    timeoutMs: Math.max(30_000, Number(options.timeoutMs) || 5 * 60_000),
  });
  const envelope = JSON.parse(processResult.stdout);
  const parsed = envelope.structuredOutput || JSON.parse(envelope.text || "{}");
  const hardFailures = Array.isArray(parsed.hardFailures) ? parsed.hardFailures.map(String) : [];
  const issues = Array.isArray(parsed.issues) ? parsed.issues.map(String) : [];
  const rawScore = Number(parsed.score);
  const score = rawScore >= 0 && rawScore <= 1 && parsed.pass === true ? rawScore * 100 : rawScore;
  return {
    pass: parsed.pass === true && Number.isFinite(score) && score >= 88 && hardFailures.length === 0,
    score,
    hardFailures,
    issues: [...hardFailures, ...issues],
    strengths: Array.isArray(parsed.strengths) ? parsed.strengths.map(String) : [],
    evaluator: "grok-headless-blind-vision",
    fallbackFromEvaluator: "codex-ephemeral-blind-vision",
  };
}

function correctivePrompt(job, qa) {
  const issues = qa?.issues?.length ? qa.issues.join("; ") : "the previous image failed the visual quality contract";
  return `${job.prompt}\n\nCORRECTION PASS: Fix these failures: ${issues}. Preserve identity and story meaning. Do not repeat the previous defect. No speech balloon, captions, readable text, logo, or watermark.`;
}

function ledgerState(plan, previous = {}) {
  const jobs = previous.jobs && typeof previous.jobs === "object" ? previous.jobs : {};
  return {
    version: MANGA_SCRIPT_IMAGE_PIPELINE_VERSION,
    episodeId: plan.episodeId,
    scriptSha256: plan.scriptSha256,
    planFile: previous.planFile || "",
    status: "running",
    startedAt: previous.startedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    jobs,
    retiredJobs: previous.retiredJobs && typeof previous.retiredJobs === "object" ? previous.retiredJobs : {},
    summary: {},
  };
}

async function writeGeneratedMedia(media, outputPath) {
  const buffer = media?.buffer instanceof Buffer ? media.buffer : media?.buffer ? Buffer.from(media.buffer) : null;
  if (!buffer) throw new Error("Image generator returned no buffer.");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, buffer);
}

/** Executes a complete plan with a persistent ledger and retry-only-failures semantics. */
export async function executeMangaScriptImagePlan(plan, options = {}) {
  const concurrencySpec = normalizeScriptImageConcurrency(options.concurrency);
  const generationController = options.adaptiveController || new AdaptiveConcurrencyController({
    mode: concurrencySpec.mode,
    fixedLimit: concurrencySpec.fixedLimit,
    initial: concurrencySpec.initial,
  });
  const qaConcurrency = normalizeMediaBatchConcurrency(options.qaConcurrency, DEFAULT_SCRIPT_QA_CONCURRENCY);
  const qaInfrastructureRetries = Math.max(0, Math.min(4, Math.round(Number(options.qaInfrastructureRetries ?? 2))));
  const qaQueue = new PQueue({ concurrency: qaConcurrency });
  const maxRetries = Math.max(0, Math.min(3, Math.round(Number(options.maxRetries ?? DEFAULT_SCRIPT_IMAGE_RETRIES))));
  const ledgerPath = resolve(nonEmptyString(options.ledgerPath) || join(plan.assetDir, "image-generation-ledger.json"));
  const prior = await readJsonIfExists(ledgerPath, {});
  const ledger = ledgerState(plan, prior.scriptSha256 === plan.scriptSha256 ? prior : {});
  const activeJobIds = new Set(plan.jobs.map((job) => job.id));
  for (const [jobId, state] of Object.entries(ledger.jobs)) {
    if (activeJobIds.has(jobId)) continue;
    ledger.retiredJobs[jobId] = { ...state, retiredAt: new Date().toISOString(), retiredReason: "not-present-in-current-plan" };
    delete ledger.jobs[jobId];
  }
  let checkpoint = Promise.resolve();
  const save = () => {
    ledger.updatedAt = new Date().toISOString();
    checkpoint = checkpoint.then(() => writeJsonAtomic(ledgerPath, ledger));
    return checkpoint;
  };
  const generator = typeof options.generateImage === "function" ? options.generateImage : generateImageMedia;
  const fallbackImageModel = nonEmptyString(options.fallbackImageModel);
  const primarySemanticQa = typeof options.visualQa === "function"
    ? options.visualQa
    : nonEmptyString(options.qaCommand)
      ? (payload) => runQaCommand(options.qaCommand, payload)
      : options.autoSemanticQa === false
        ? null
        : (payload) => runCodexVisualQa(payload, {
            qaDir: join(plan.assetDir, ".qa"),
            projectDir: options.projectDir,
            model: options.qaModel,
            codexCommand: options.codexCommand,
            timeoutMs: options.qaTimeoutMs,
          });
  const qaFallbackProvider = nonEmptyString(options.qaFallbackProvider).toLowerCase();
  const fallbackSemanticQa = typeof options.fallbackVisualQa === "function"
    ? options.fallbackVisualQa
    : qaFallbackProvider === "grok"
      ? (payload) => runGrokVisualQa(payload, {
          qaDir: join(plan.assetDir, ".qa"),
          projectDir: options.projectDir,
          grokCommand: options.grokCommand,
          timeoutMs: options.qaTimeoutMs,
        })
      : null;
  const priorJobStates = Object.values(ledger.jobs || {});
  let primaryQaUsageLimited = Boolean(fallbackSemanticQa && priorJobStates.some((state) =>
    state?.qa?.semantic?.fallbackFromEvaluator === "codex-ephemeral-blind-vision"));
  const semanticQa = primarySemanticQa && fallbackSemanticQa
    ? async (payload) => {
        if (primaryQaUsageLimited) return fallbackSemanticQa(payload);
        try {
          return await primarySemanticQa(payload);
        } catch (error) {
          if (classifyGenerationError(error) !== USAGE_LIMIT_SIGNAL) throw error;
          primaryQaUsageLimited = true;
          return fallbackSemanticQa(payload);
        }
      }
    : primarySemanticQa;
  let primaryImageUsageLimited = Boolean(fallbackImageModel && priorJobStates.some((state) =>
    state?.fallbackFromModel && classifyGenerationError(state?.primaryGenerationError) === USAGE_LIMIT_SIGNAL));
  const byId = new Map(plan.jobs.map((entry) => [entry.id, entry]));
  const completed = new Set();
  const retryFailed = options.retryFailed === true;

  for (const job of plan.jobs) {
    const state = ledger.jobs[job.id];
    if (state?.status === "complete" && state.inputHash === job.inputHash && await fileExists(job.outputPath)) completed.add(job.id);
    else if (state?.status === "running" || state?.status === "waiting") state.status = "pending";
    else if (state?.status === "failed" && (retryFailed || state.inputHash !== job.inputHash)) {
      state.status = "pending";
      state.previousFailure = {
        error: state.error || "",
        failedAt: state.failedAt || "",
        inputHash: state.inputHash || "",
        qa: state.qa || null,
      };
      delete state.failedAt;
    }
  }
  await mkdir(plan.assetDir, { recursive: true });
  await save();

  while (completed.size < plan.jobs.length) {
    const ready = plan.jobs.filter((job) => !completed.has(job.id)
      && job.dependencies.every((dependency) => completed.has(dependency))
      && ledger.jobs[job.id]?.status !== "failed");
    if (ready.length === 0) break;
    const outcomes = await runGenerationJobs(ready, concurrencySpec, async (job) => {
      const old = ledger.jobs[job.id];
      if (old?.status === "complete" && old.inputHash === job.inputHash && await fileExists(job.outputPath)) return { job, reused: true };
      const reuseGeneratedForQa = old?.inputHash === job.inputHash
        && Boolean(old?.qaInfrastructureError)
        && (!old?.qa || old?.qaGenerationAttempt !== old?.retries)
        && await fileExists(job.outputPath);
      const state = ledger.jobs[job.id] = {
        ...(reuseGeneratedForQa ? old : {}),
        id: job.id,
        kind: job.kind,
        inputHash: job.inputHash,
        outputPath: job.outputPath,
        status: "running",
        attempts: 0,
        retries: 0,
        startedAt: new Date().toISOString(),
        ...(old?.previousFailure ? { previousFailure: old.previousFailure } : {}),
        ...(reuseGeneratedForQa ? { reusedGeneratedForQa: true } : {}),
      };
      await save();
      let lastError = "";
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        state.attempts += 1;
        state.retries = attempt;
        try {
          if (job.kind === "editorial-plate") {
            await mkdir(dirname(job.outputPath), { recursive: true });
            await writeFile(job.outputPath, renderEditorialPlatePng(job.plateType));
          } else if (job.kind === "split-page") {
            await composeSplitPage(job);
          } else {
            const generationInput = {
              prompt: attempt === 0
                ? (old?.previousFailure?.qa && old.previousFailure.inputHash === job.inputHash
                    ? correctivePrompt(job, old.previousFailure.qa)
                    : job.prompt)
                : correctivePrompt(job, state.qa),
              model: job.model,
              aspectRatio: job.aspectRatio,
              imageSize: job.imageSize,
              quality: job.quality,
              referenceImagePaths: job.referenceImagePaths,
              imageCount: 1,
              fileName: basename(job.outputPath),
            };
            if (!(reuseGeneratedForQa && attempt === 0)) {
              let media;
              const canUseFallback = fallbackImageModel && fallbackImageModel !== job.model;
              if (primaryImageUsageLimited && canUseFallback) {
                state.primaryGenerationSkippedReason = "usage-limit-circuit-open";
                state.fallbackGenerationAttempts = Number(state.fallbackGenerationAttempts || 0) + 1;
                await save();
                media = await generator({
                  ...generationInput,
                  model: fallbackImageModel,
                  referenceImagePaths: (job.fallbackReferenceImagePaths || job.referenceImagePaths || []).slice(0, 3),
                });
                state.generationModel = fallbackImageModel;
                state.fallbackFromModel = job.model;
              } else {
                try {
                  media = await generator(generationInput);
                  state.generationModel = job.model;
                } catch (primaryError) {
                  const canFallback = classifyGenerationError(primaryError) === USAGE_LIMIT_SIGNAL
                    && canUseFallback;
                  if (!canFallback) throw primaryError;
                  primaryImageUsageLimited = true;
                  state.primaryGenerationError = primaryError instanceof Error ? primaryError.message : String(primaryError);
                  state.fallbackGenerationAttempts = Number(state.fallbackGenerationAttempts || 0) + 1;
                  await save();
                  media = await generator({
                    ...generationInput,
                    model: fallbackImageModel,
                    referenceImagePaths: (job.fallbackReferenceImagePaths || job.referenceImagePaths || []).slice(0, 3),
                  });
                  state.generationModel = fallbackImageModel;
                  state.fallbackFromModel = job.model;
                }
              }
              await writeGeneratedMedia(media, job.outputPath);
              delete state.qa;
              delete state.qaGenerationAttempt;
            }
          }
          const technical = await defaultTechnicalQa(job);
          const semantic = semanticQa
            ? await qaQueue.add(
                async () => {
                  let lastError;
                  for (let qaAttempt = 0; qaAttempt <= qaInfrastructureRetries; qaAttempt += 1) {
                    state.qaInfrastructureAttempts = Number(state.qaInfrastructureAttempts || 0) + 1;
                    try {
                      return await semanticQa({ job, outputPath: job.outputPath, technical, attempt, qaInfrastructureAttempt: qaAttempt });
                    } catch (error) {
                      if (classifyGenerationError(error) === USAGE_LIMIT_SIGNAL) throw error;
                      lastError = error;
                      state.qaInfrastructureError = error instanceof Error ? error.message : String(error);
                      await save();
                      if (qaAttempt < qaInfrastructureRetries) {
                        await new Promise((resolvePromise) => setTimeout(resolvePromise, 500 * (qaAttempt + 1)));
                      }
                    }
                  }
                  throw lastError || new Error(`Semantic QA failed without a verdict: ${job.id}`);
                },
                { id: `qa:${job.id}:${attempt}` },
              )
            : null;
          const qa = {
            pass: technical.pass && (semantic ? semantic.pass : true),
            issues: [...technical.issues, ...(semantic?.issues || [])],
            technical,
            semantic: semantic || { pass: null, evaluator: "not-configured" },
          };
          state.qa = qa;
          state.qaGenerationAttempt = attempt;
          delete state.qaInfrastructureError;
          if (!qa.pass) throw new Error(qa.issues.join("; ") || "visual QA failed");
          state.status = "complete";
          state.completedAt = new Date().toISOString();
          await save();
          return { job, reused: false };
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          state.error = lastError;
          if (classifyGenerationError(error) === USAGE_LIMIT_SIGNAL) {
            state.status = "waiting";
            state.waitingSince = new Date().toISOString();
            state.waitingReason = "usage-limit";
            await save();
            // Let the adaptive pool park this exact unfinished job. Do not
            // consume a QA retry or turn the persistent checkpoint red.
            throw error;
          }
          await save();
        }
      }
      state.status = "failed";
      state.failedAt = new Date().toISOString();
      await save();
      throw new Error(lastError || `Job failed: ${job.id}`);
    }, {
      jobId: (job) => job.id,
      controller: generationController,
      adaptiveRunOptions: {
        ...(options.adaptiveRunOptions || {}),
        onPark: async (event) => {
          ledger.status = "waiting";
          ledger.parkedAt = new Date().toISOString();
          ledger.waitingReason = event.verdict?.signal || "usage-limit";
          ledger.generationControllerHistory = event.controller?.history || [];
          await save();
          await options.adaptiveRunOptions?.onPark?.(event);
        },
        onResume: async (event) => {
          ledger.status = "running";
          ledger.resumedAt = new Date().toISOString();
          delete ledger.waitingReason;
          await save();
          await options.adaptiveRunOptions?.onResume?.(event);
        },
      },
    });
    for (const outcome of outcomes) {
      if (outcome.ok) completed.add(outcome.value.job.id);
    }
    if (outcomes.every((entry) => !entry.ok)) break;
  }

  const states = Object.values(ledger.jobs);
  ledger.summary = {
    total: plan.jobs.length,
    complete: states.filter((entry) => entry.status === "complete").length,
    failed: states.filter((entry) => entry.status === "failed").length,
    reused: plan.jobs.filter((job) => prior.jobs?.[job.id]?.status === "complete" && ledger.jobs[job.id]?.status === "complete").length,
    paidImages: plan.jobs.filter((job) => job.imageCount === 1).length,
    attempts: states.reduce((sum, entry) => sum + Number(entry.attempts || 0), 0),
    concurrency: concurrencySpec.label,
    generationMode: concurrencySpec.mode,
    generationFinalLimit: generationController?.limit ?? concurrencySpec.fixedLimit,
    generationControllerHistory: generationController?.history || [],
    qaConcurrency,
    qaInfrastructureRetries,
    qaFallbackProvider,
    qaFallbackApproved: states.filter((entry) => entry.qa?.semantic?.evaluator === "grok-headless-blind-vision" && entry.status === "complete").length,
    fallbackImageModel,
    fallbackGenerated: states.filter((entry) => entry.generationModel === fallbackImageModel && fallbackImageModel).length,
  };
  const hasWaitingJobs = states.some((entry) => entry.status === "waiting");
  ledger.status = ledger.summary.complete === plan.jobs.length
    ? "complete"
    : hasWaitingJobs
      ? "waiting"
      : "failed";
  if (ledger.status === "complete") ledger.completedAt = new Date().toISOString();
  await save();
  await checkpoint;
  return { ledgerPath, ledger };
}

async function generateCharacterCandidates(workflow, args, options) {
  const jobs = await buildCharacterCandidateJobs(workflow, {
    model: options.model,
    candidateCount: options.candidateCount,
  });
  if (jobs.length === 0) return workflow;
  await markCharacterCandidatesGenerating(args, workflow.id, jobs);
  const generator = typeof options.generateImage === "function" ? options.generateImage : generateImageMedia;
  const assetDir = join(resolveCanvasDir(args), "assets", "characters", slug(workflow.episodeId));
  await mkdir(assetDir, { recursive: true });
  const concurrencySpec = normalizeScriptImageConcurrency(options.concurrency);
  // 例外はそのまま投げる。ここで catch して正常値として返すと、
  // AIMD は 429 を「成功」と受け取って並列度を下げず、リトライもしない。
  // レート制御が丸ごと効かなくなり、候補だけが静かに失敗する。
  // 失敗結果への変換はプールが終わったあとで行う。
  const outcomes = await runGenerationJobs(jobs, concurrencySpec, async (job) => {
    const media = await generator({ ...job, imageCount: 1 });
    const assetFile = join(assetDir, job.fileName);
    await writeGeneratedMedia(media, assetFile);
    return { assetFile };
  });
  return recordCharacterCandidateResults(args, workflow.id, jobs, outcomes.map((entry) => entry.ok ? entry.value : { error: entry.error }));
}

/** One-call entrypoint: character gate -> full planning -> generation -> QA ledger. */
export async function runMangaScriptImagePipeline(args = {}) {
  const scriptText = nonEmptyString(args.scriptText) || await readFile(resolve(args.scriptPath), "utf8");
  const canvasDir = resolveCanvasDir(args);
  const parsedWithoutRegistry = parseMangaScript(scriptText, { title: args.title });
  const episodeId = nonEmptyString(args.episodeId) || slug(parsedWithoutRegistry.title, `episode-${sha256(scriptText).slice(0, 8)}`);
  const concurrency = args.concurrency ?? DEFAULT_SCRIPT_IMAGE_CONCURRENCY;
  let workflow = await prepareCharacterWorkflow({
    ...args,
    canvasDir,
    episodeId,
    scriptText,
    model: args.model || DEFAULT_IMAGE_MODEL,
    candidateCount: args.candidateCount ?? 3,
  });
  if (workflow.cast.some((entry) => ["needs-candidates", "failed"].includes(entry.status))) {
    workflow = await generateCharacterCandidates(workflow, { ...args, canvasDir }, {
      model: args.model || DEFAULT_IMAGE_MODEL,
      candidateCount: args.candidateCount ?? 3,
      concurrency,
      generateImage: args.generateImage,
    });
  }
  const blockingCast = workflow.cast.filter((entry) => !["existing", "ready"].includes(entry.status));
  if (blockingCast.length > 0) {
    return {
      status: "awaiting-character-approval",
      episodeId,
      workflowId: workflow.id,
      cast: blockingCast.map((entry) => ({
        id: entry.id,
        name: entry.name,
        status: entry.status,
        candidateSetId: entry.blindCandidateSet?.setId || "",
        judgePacketPath: entry.blindCandidateSet?.publicPath || "",
        candidates: (entry.blindCandidateSet?.candidates || []).map((candidate) => ({
          label: candidate.label,
          artifactRef: candidate.artifactRef,
          artifactSha256: candidate.artifactSha256,
        })),
      })),
      message: "Review only the anonymous A–E judge packet, record the winning label and concrete reason, then run character-approve. Private IDs, provider, generation order, and variation axes stay hidden until the verdict is written.",
    };
  }
  const registry = await readCharacterRegistry({ ...args, canvasDir });
  const assetDir = join(canvasDir, "assets", slug(episodeId));
  const plan = createMangaScriptImagePlan({
    scriptText,
    title: args.title,
    episodeId,
    registry,
    canvasDir,
    assetDir,
    model: args.model,
    protagonistSpeakerId: args.protagonistSpeakerId,
    protagonistSpeakerName: args.protagonistSpeakerName,
    characterBible: args.characterBible,
  });
  const planPath = join(assetDir, "script-image-plan.json");
  await mkdir(assetDir, { recursive: true });
  await writeJsonAtomic(planPath, plan);
  const execution = await executeMangaScriptImagePlan(plan, {
    concurrency,
    maxRetries: args.maxRetries,
    qaCommand: args.qaCommand,
    autoSemanticQa: args.autoSemanticQa,
    qaModel: args.qaModel,
    qaTimeoutMs: args.qaTimeoutMs,
    qaConcurrency: args.qaConcurrency,
    fallbackImageModel: args.fallbackImageModel,
    qaFallbackProvider: args.qaFallbackProvider,
    fallbackVisualQa: args.fallbackVisualQa,
    adaptiveController: args.adaptiveController,
    adaptiveRunOptions: args.adaptiveRunOptions,
    projectDir: args.projectDir,
    visualQa: args.visualQa,
    generateImage: args.generateImage,
    retryFailed: args.retryFailed,
  });
  return { status: execution.ledger.status, episodeId, workflowId: workflow.id, planPath, plan, ...execution };
}
