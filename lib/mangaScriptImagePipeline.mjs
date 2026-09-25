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
  buildCharacterIdentityPrompt,
  eyeOpenVariantId,
  findCharacter,
  isComicalReferenceIntent,
  normalizeCharacterRegistry,
  optimizeCharacterBindingsForGeneration,
  readCharacterRegistry,
  resolveCharacterBindings,
  resolveCharacterReferencePaths,
  selectEyeOpenReferenceAsset,
  verifyComicalReferenceBindings,
} from "./characterRegistry.mjs";
import { buildChannelArtStylePromptLines } from "./characterRenderDirectives.mjs";
import { buildChannelVisualStylePrompt, normalizeChannelVisualProfileSnapshot } from "./channelVisualProfile.mjs";
import { normalizeEyeOpenCandidates, resolveMangaEyeOpenBeats } from "./mangaEyeOpenBeats.mjs";
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

export const MANGA_SCRIPT_IMAGE_PIPELINE_VERSION = 15;
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

const LOCATION_INTERPRETATION_RULES = [
  {
    pattern: /(?:商店会|商店街).{0,30}(?:催事|会場)|(?:催事場|催事).{0,30}(?:商店会|商店街)/u,
    directive: "Required physical interpretation: a modest Japanese neighborhood merchants' association multipurpose event hall, with rows of simple folding chairs, a low stage, a plain folding-table reception/check-in desk, a small terminal or read-only device, and an ordinary transparent sealed box. Use practical local-community materials and restrained lighting. This is not a hotel, corporate reception lobby, ballroom, resort, luxury lounge, or high-rise venue.",
  },
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

// A stable id for a place named by a scene-script heading. An all-ASCII name
// keeps a readable slug; any other name gets a hash, because slugging drops
// every non-ASCII letter and would merge 「会議室A」 and 「倉庫A」 into "a".
function declaredLocationId(name) {
  const readable = /^[\x20-\x7E]+$/u.test(name.normalize("NFKC")) ? slug(name, "") : "";
  return readable || `location-${sha256(name).slice(0, 10)}`;
}

function inferLocation(cut = {}) {
  // Scene-script cuts carry the place from their 「#場面」 heading.
  const declaredPlace = nonEmptyString(cut.location?.name);
  if (declaredPlace) return { id: declaredLocationId(declaredPlace), name: declaredPlace };
  const source = `${cut.purpose || ""} ${cut.utterances?.map((entry) => entry.text).join(" ") || ""}`;
  const explicit = source.match(/(?:場所|ロケーション|location)\s*[：:]\s*([^、。\n]{1,40})/iu)?.[1]?.trim();
  if (explicit) return { id: slug(explicit, `location-${cut.number}`), name: explicit };
  return LOCATION_RULES.find((rule) => rule.pattern.test(source)) || { id: "primary-location", name: "主要舞台" };
}

function buildLocationSettingDirective(parsed = {}, location = {}) {
  const matchingCuts = (parsed.cuts || []).filter((cut) => inferLocation(cut).id === location.id);
  const sourceCuts = matchingCuts.length > 0 ? matchingCuts : (parsed.cuts || []);
  const purposes = unique(sourceCuts.map((cut) => nonEmptyString(cut.purpose))).slice(0, 3);
  const openingNarration = sourceCuts
    .flatMap((cut) => cut.utterances || [])
    .filter((utterance) => utterance.speakerId === "narration" || utterance.preset === "narration")
    .map((utterance) => nonEmptyString(utterance.text))
    .filter(Boolean)
    .slice(0, 2);
  const evidence = [...purposes, ...openingNarration].join(" / ").slice(0, 1_200);
  const interpretation = LOCATION_INTERPRETATION_RULES.find((rule) => rule.pattern.test(evidence))?.directive || "";
  return [
    `BINDING LOCATION EVIDENCE copied from the Japanese script: ${evidence || location.name || "unspecified primary location"}.`,
    "Treat the named venue type, physical scale, social context, furniture, and recurring props as hard visual requirements. Preserve them in the environment atlas and in every story image set at this location.",
    "Never upscale a script-described small, local, ordinary, or modest place into a luxury hotel, corporate lobby, ballroom, resort, high-rise, or grand commercial venue unless the script explicitly requires that upgrade.",
    interpretation,
  ].filter(Boolean).join("\n");
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

const MULTI_CAST_SAFE_SETUP_IDS = new Set([
  "establishing-deep",
  "exterior-through-glass",
  "triangular-confrontation",
  "doorway-low-intrusion",
  "staircase-diagonal",
  "floor-level-memory",
  "birdseye-memory",
  "staggered-four-character-depth",
]);

function applyVisibleCastCountCompositionOverride(beat = {}, visibleCastCount = 0) {
  if (visibleCastCount < 3 || MULTI_CAST_SAFE_SETUP_IDS.has(beat.setup?.id)) return beat;
  const triangular = MANGA_COMPOSITION_SETUPS.find((entry) => entry.id === "triangular-confrontation");
  const setup = visibleCastCount === 3
    ? triangular
    : {
        id: "staggered-four-character-depth",
        shotSize: "medium-wide",
        azimuth: "three-quarter-right",
        elevation: "eye",
        arrangement: "staggered-four-character-depth",
        lens: "35mm",
        foreground: "one named cast member at a readable edge, with the other named cast staggered across midground and background",
        depth: "three-plane",
      };
  return {
    ...beat,
    setup,
    visibleAction: `${beat.visibleAction}. Keep all ${visibleCastCount} named cast figures distinct in staggered depth; never flatten them into a two-shot or hide a required cast member outside frame`,
    bubbleReserve: "reserve one compact upper-side pocket while keeping every named face or required animal identity readable",
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

function exactBeatRequiresUnnamedBackgroundPeople(cut = {}, utterance = {}) {
  const source = `${cut.purpose || ""}\n${utterance.text || ""}`;
  return /(?:群衆|人々|観客(?:たち)?|来場者(?:たち)?|通行人(?:たち)?|社員たち|同僚たち|同級生たち|クラスメイトたち|客たち|スタッフたち|作業員たち|大勢の人|人だかり|長い列)/u.test(source);
}

// Reference paths for one on-screen character. Without an eye-open policy
// this is the registry order, unchanged. With one, eye-open sheets are sent
// only for that character's eye-open beat, directly after the identity face,
// so an ordinary image never receives an eyes-open reference.
function characterReferenceGroup(registry, characterId, canvasDir, eyeOpenActive, eyeOpenPath = "") {
  if (!eyeOpenActive) return resolveCharacterReferencePaths(registry, [characterId], { canvasDir });
  const [binding] = resolveCharacterBindings(registry, [characterId], { canvasDir });
  const eyeOpenPaths = new Set(binding.referenceAssets.filter((asset) => asset.role === "eye-open").map((asset) => asset.path));
  const rest = binding.referenceImagePaths.filter((path) => !eyeOpenPaths.has(path));
  return eyeOpenPath ? unique([rest[0], eyeOpenPath, ...rest.slice(1)]) : rest;
}

function balancedCharacterReferencePaths(groups, limit = 7) {
  const selected = [];
  const seen = new Set();
  // Identity anchors come first. A flat concatenation followed by slice(0, 8)
  // lets the first two characters consume every slot with turnaround and
  // expression sheets, leaving later on-screen cast with no identity source.
  for (const group of groups) {
    const anchor = group[0];
    if (!anchor || seen.has(anchor) || selected.length >= limit) continue;
    seen.add(anchor);
    selected.push(anchor);
  }
  for (let depth = 1; selected.length < limit; depth += 1) {
    let added = false;
    for (const group of groups) {
      const path = group[depth];
      if (!path || seen.has(path) || selected.length >= limit) continue;
      seen.add(path);
      selected.push(path);
      added = true;
    }
    if (!added) break;
  }
  return selected;
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

function editorialClassification(utterance, cut, index, visualOverride = {}) {
  const visibleParticipantCount = unique(cut.utterances
    .map((entry) => entry.speakerId)
    .filter((id) => id && id !== "narration")).length;
  const decision = classifyMangaEditorialBeat({
    utterance,
    openingExposition: index < 2 && utterance.preset === "narration",
    allowNeutralPlate: true,
    disableEditorialPlate: visualOverride.disableEditorialPlate === true,
    allowThoughtInference: true,
    visibleParticipantCount,
    montageBeatCount: /(?:翌|その後|それから|各地|日々|年月|数ヶ月|毎日|ルーティン)/u.test(utterance.text) ? 3 : 0,
  });
  const forcedSplitType = ["story-3", "vertical-2"].includes(visualOverride.splitType)
    ? visualOverride.splitType
    : "";
  if (!forcedSplitType) return decision;
  decision.editorialPlate = {
    ...decision.editorialPlate,
    recommended: false,
    type: null,
    motion: "none",
    reason: "episode visual plan requires an illustrated split page",
  };
  decision.backgroundOnly = {
    ...decision.backgroundOnly,
    recommended: false,
    type: null,
    style: null,
    reason: "episode visual plan requires an illustrated split page",
  };
  decision.split = {
    recommended: true,
    type: forcedSplitType,
    composition: "post-composite-on-black-then-flatten",
    separatorWidthRatio: 0.0145,
    panelCamera: "static",
    pageCamera: "single-continuous",
    flattenBeforeCamera: true,
    reason: "episode visual plan explicitly distributes an over-capacity cast across panels",
  };
  return decision;
}

/**
 * 番組の画風（show bible の artStyle）と visual profile の文面を、本編の画像と
 * 人物なしの環境アトラスのプロンプトへ入れるための正規化。
 *
 * 以前はこのどちらも本編のプロンプトに入っておらず、背景に画風の指定が無いまま
 * 写真のような絵が出た。画風はチャンネル単位の宣言なので、ここは受け取った宣言を
 * そのまま文にするだけで、特定チャンネルの画風を知らない。
 *
 * 宣言が無い（番組を持たない汎用経路・過去作の再現）ときは null を返し、プロンプトも
 * 入力 hash も従来と1バイトも変えない。宣言があるときは文面が変わるので入力 hash も
 * 変わり、画風無しで作った画像を「同じ入力の完成品」として黙って再利用しない。
 */
function normalizeScriptImageChannelStyle(value) {
  if (!value || typeof value !== "object") return null;
  const artStyle = value.artStyle && typeof value.artStyle === "object" && !Array.isArray(value.artStyle)
    ? value.artStyle
    : null;
  const visualProfile = normalizeChannelVisualProfileSnapshot(value.visualProfile);
  if (!artStyle && !visualProfile) return null;
  if (artStyle && (!nonEmptyString(artStyle.id) || !nonEmptyString(artStyle.medium))) {
    throw new Error("channelStyle.artStyle needs the channel art style id and its medium sentence; a style without a medium lets the image model fall back to a photographic look.");
  }
  return { artStyle, visualProfile };
}

function channelStyleSummary(channelStyle) {
  if (!channelStyle) return null;
  return {
    artStyleId: nonEmptyString(channelStyle.artStyle?.id),
    visualProfileId: nonEmptyString(channelStyle.visualProfile?.id),
  };
}

function sceneChannelStyleDirective(channelStyle, scenePrompt) {
  if (!channelStyle) return "";
  return [
    ...(channelStyle.artStyle ? buildChannelArtStylePromptLines(channelStyle.artStyle) : []),
    // 本編の1枚には画風の参照画像を添付しない（参照枠は人物と場所で埋まる）ので、
    // 書かれた仕様だけに従わせる（referenceCount = 0）。
    channelStyle.visualProfile ? buildChannelVisualStylePrompt(channelStyle.visualProfile, { prompt: scenePrompt }, 0) : "",
  ].filter(Boolean).join("\n");
}

function atlasChannelStyleDirective(channelStyle) {
  if (!channelStyle) return "";
  const profile = channelStyle.visualProfile;
  return [
    ...(channelStyle.artStyle ? buildChannelArtStylePromptLines(channelStyle.artStyle, { includeCharacter: false }) : []),
    // アトラスは4分割の板なので、本編のコマ運び（構図・ショットの間）は渡さず、描き方だけを渡す。
    profile ? `CHANNEL VISUAL STYLE LOCK [${profile.id}] — drawing style only for this environment atlas; the four-panel layout, gutters, and no-people rules below still apply:` : "",
    profile?.stylePrompt || "",
    profile?.negativePrompt ? `STRICTLY AVOID: ${profile.negativePrompt}` : "",
  ].filter(Boolean).join("\n");
}

function channelArtStyleJobFields(channelStyle) {
  if (!channelStyle?.artStyle) return {};
  return {
    channelArtStyle: {
      id: nonEmptyString(channelStyle.artStyle.id),
      medium: nonEmptyString(channelStyle.artStyle.medium),
    },
  };
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

// Eye-open candidates: characters named by the caller's policy (which may
// carry variant cues) plus every approved registry character that already has
// an eye-open sheet, so an unlisted sheet is never sent by accident.
function mergeEyeOpenCandidates(registry, episodeId, policyCandidates = []) {
  const merged = new Map();
  for (const entry of normalizeEyeOpenCandidates(policyCandidates)) merged.set(entry.characterId, entry);
  for (const character of registry.characters || []) {
    if (character.kind !== "character" || character.status !== "approved") continue;
    if (character.episodeId && character.episodeId !== episodeId) continue;
    const names = [character.id, character.name, ...(character.aliases || [])];
    const existing = merged.get(character.id);
    if (existing) {
      merged.set(character.id, { ...existing, names: unique([...existing.names, ...names]) });
    } else if ((character.referenceAssets || []).some((asset) => asset.role === "eye-open")) {
      merged.set(character.id, normalizeEyeOpenCandidates([{ characterId: character.id, label: character.name, names }])[0]);
    }
  }
  return [...merged.values()];
}

function bindEyeOpenBeat({ registry, canvasDir, beat, cut, utterance, cutCharacterIds, candidates }) {
  const character = findCharacter(registry, beat.characterId);
  if (!character || !cutCharacterIds.includes(character.id)) {
    throw new Error(`Eye-open beat ${utterance.id} needs ${beat.characterId} on screen, but cut ${cut.id} does not show that approved character.`);
  }
  const [binding] = resolveCharacterBindings(registry, [character.id], { canvasDir });
  const asset = selectEyeOpenReferenceAsset(binding.referenceAssets, beat.variant, `${character.name} (${character.id})`);
  if (!asset) {
    throw new Error(
      `Eye-open beat ${utterance.id} requires an approved eyes-open sheet for ${character.name}${beat.variant ? ` variant '${beat.variant}'` : ""}. ` +
      "Register it through the identity review before generation.",
    );
  }
  const variant = eyeOpenVariantId(asset);
  const candidate = candidates.find((entry) => entry.characterId === character.id);
  return {
    characterId: character.id,
    name: character.name,
    variant,
    variantLabel: candidate?.variants.find((entry) => entry.id === variant)?.label || variant,
    referencePath: asset.path,
    source: beat.source,
  };
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
      locationId: inferLocation(cut).id,
      utteranceIds: cut.utterances.map((entry) => entry.id),
    })),
    utterances: parsed.utterances,
    // Scene scripts only (legacy manifests keep their exact shape): the
    // script's own 主人公 declaration, so an explicit protagonist that
    // disagrees is refused before paid generation, and the reader's warnings,
    // so a line read differently from what the writer meant stays visible.
    ...(parsed.format === "scene-script"
      ? {
        scriptFormat: parsed.format,
        declaredProtagonistName: nonEmptyString(parsed.protagonistName),
        scriptWarnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
      }
      : {}),
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
  const visualPlanOverrides = input.visualPlanOverrides?.byUtterance
    && typeof input.visualPlanOverrides.byUtterance === "object"
    ? input.visualPlanOverrides.byUtterance
    : {};
  const eyeOpenPolicy = input.eyeOpen && typeof input.eyeOpen === "object" ? input.eyeOpen : null;
  const channelStyle = normalizeScriptImageChannelStyle(input.channelStyle);
  const atlasStyleDirective = atlasChannelStyleDirective(channelStyle);
  const eyeOpenCandidates = eyeOpenPolicy ? mergeEyeOpenCandidates(registry, episodeId, eyeOpenPolicy.candidates) : [];
  const eyeOpenResolution = eyeOpenPolicy
    ? resolveMangaEyeOpenBeats({ cuts: parsed.cuts, candidates: eyeOpenCandidates, reviewedBeats: eyeOpenPolicy.reviewedBeats ?? null })
    : null;
  const eyeOpenBeatsByUtterance = new Map();
  for (const beat of eyeOpenResolution?.beats || []) {
    eyeOpenBeatsByUtterance.set(beat.utteranceId, [...(eyeOpenBeatsByUtterance.get(beat.utteranceId) || []), beat]);
  }
  const boundEyeOpenImages = [];
  let globalIndex = 0;

  for (const cut of parsed.cuts) {
    const location = inferLocation(cut);
    const settingDirective = buildLocationSettingDirective(parsed, location);
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
    const castNames = unique(cutCharacterIds.map((characterId) => findCharacter(registry, characterId)?.name));

    for (const utterance of cut.utterances) {
      const visualOverride = visualPlanOverrides[utterance.id]
        && typeof visualPlanOverrides[utterance.id] === "object"
        ? visualPlanOverrides[utterance.id]
        : {};
      const originalBeat = compositionByUtterance.get(utterance.id);
      const beat = applyDialogueCompositionOverride(originalBeat, utterance);
      if (beat !== originalBeat) {
        Object.assign(originalBeat, beat);
        compositionByUtterance.set(utterance.id, originalBeat);
      }
      const editorial = editorialClassification(utterance, cut, globalIndex, visualOverride);
      if (isComicalReferenceIntent(visualOverride.referenceIntent) && editorial.editorialPlate.recommended) {
        throw new Error(`${utterance.id}: comical art requires an illustrated scene; set disableEditorialPlate=true.`);
      }
      editorialDecisions.push(editorial);
      const stem = `${cut.id}-${utterance.id.replace(`${cut.id}-`, "")}`;
      const storyStage = inferStoryStage(cut, utterance);
      const textFreeProps = textFreePropDirective(utterance);
      const dialogueRepair = dialogueBeatRepairDirective(utterance);
      const activeSpeakerCharacter = registryCharacterForSpeaker(registry, utterance);
      const activeSpeakerId = utterance.speakerId !== "narration" && utterance.preset !== "narration"
        ? (activeSpeakerCharacter?.id || nonEmptyString(utterance.speakerId))
        : "";
      const activeSpeakerName = activeSpeakerId
        ? (activeSpeakerCharacter?.name || nonEmptyString(utterance.speakerName) || activeSpeakerId)
        : "";
      const activeSpeakerDirective = activeSpeakerName
        ? `BINDING ACTIVE SPEAKER: ${activeSpeakerName} delivers this exact line. Show ${activeSpeakerName}'s identifiable face and mouth visibly in the act of speaking. Other visible cast are listeners and must not look like the sole or primary speaker unless the script explicitly marks overlapping dialogue.`
        : "";
      const allowUnnamedBackgroundPeople = visualOverride.allowUnnamedBackgroundPeople === true
        || exactBeatRequiresUnnamedBackgroundPeople(cut, utterance);
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
        pages.push({
          utteranceId: utterance.id,
          cutId: cut.id,
          assetJobId: `plate:${utterance.id}`,
          editorial,
          cameraMode: nonEmptyString(visualOverride.cameraMode),
          camera: visualOverride.camera && typeof visualOverride.camera === "object" ? structuredClone(visualOverride.camera) : null,
          pacing: visualOverride.pacing && typeof visualOverride.pacing === "object" ? structuredClone(visualOverride.pacing) : {},
          wholePageCamera: true,
        });
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
              // 画風の宣言は冒頭に置く（冒頭行ほど重く読まれる）。宣言が無ければ何も足さず、従来の文面のまま
              // （空の settingDirective が作る空行も含めて1バイトも変えない）。
              ...(atlasStyleDirective ? [atlasStyleDirective] : []),
              "Create one original 16:9 Japanese motion-comic ENVIRONMENT REFERENCE ATLAS, 1920x1080.",
              `Location: ${location.name}. Episode context: ${parsed.title}.`,
              settingDirective,
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
            ...channelArtStyleJobFields(channelStyle),
            model: nonEmptyString(input.model) || DEFAULT_IMAGE_MODEL,
            aspectRatio: "16:9",
            imageSize: "2K",
            quality: "high",
            imageCount: 1,
            location,
            settingDirective,
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
      const authoredPanels = Array.isArray(visualOverride.panels) ? visualOverride.panels : [];
      if (authoredPanels.length > 0 && authoredPanels.length !== splitCount) {
        throw new Error(`${utterance.id}: visual plan declares ${authoredPanels.length} panels but ${editorial.split.type || "single-scene"} requires ${splitCount}.`);
      }
      const authoredPanelCharacterIds = authoredPanels.map((panel, panelIndex) => {
        const resolvedIds = unique((Array.isArray(panel?.cast) ? panel.cast : []).map((token) => findCharacter(registry, token)?.id));
        if (resolvedIds.length !== (Array.isArray(panel?.cast) ? panel.cast.filter(Boolean).length : 0)) {
          throw new Error(`${utterance.id}: panel ${panelIndex + 1} contains an unknown or duplicate cast token.`);
        }
        return resolvedIds;
      });
      if (visualOverride.requireAllCutCastAcrossPanels === true) {
        const covered = new Set(authoredPanelCharacterIds.flat());
        const missing = cutCharacterIds.filter((id) => !covered.has(id));
        if (missing.length > 0) {
          throw new Error(`${utterance.id}: authored panels must cover every character inferred from the cut (missing: ${missing.join(", ")}).`);
        }
      }
      // Eye-open beats bind per utterance against every character this image
      // can show, then each panel receives only the sheets of its own cast.
      const utteranceVisibleIds = unique(Array.from({ length: splitCount }, (_, panelIndex) => (
        authoredPanelCharacterIds[panelIndex]?.length > 0 ? authoredPanelCharacterIds[panelIndex] : cutCharacterIds
      )).flat());
      const eyeOpenBindings = (eyeOpenBeatsByUtterance.get(utterance.id) || []).map((beat) => (
        bindEyeOpenBeat({ registry, canvasDir, beat, cut, utterance, cutCharacterIds: utteranceVisibleIds, candidates: eyeOpenCandidates })
      ));
      for (let panelIndex = 0; panelIndex < splitCount; panelIndex += 1) {
        const panelOverride = authoredPanels[panelIndex] && typeof authoredPanels[panelIndex] === "object"
          ? authoredPanels[panelIndex]
          : {};
        const panelCharacterIds = authoredPanelCharacterIds[panelIndex]?.length > 0
          ? authoredPanelCharacterIds[panelIndex]
          : cutCharacterIds;
        const panelCastNames = unique(panelCharacterIds.map((characterId) => findCharacter(registry, characterId)?.name));
        const basePanelBeat = splitCount > 1 ? compositionForPanel(beat, panelIndex, panelJobs.map((job) => job.composition.setup.id)) : beat;
        const rawPanelBeat = {
          ...basePanelBeat,
          ...(nonEmptyString(panelOverride.purpose) ? { purpose: nonEmptyString(panelOverride.purpose) } : {}),
          ...(nonEmptyString(panelOverride.visibleAction) ? { visibleAction: nonEmptyString(panelOverride.visibleAction) } : {}),
        };
        const panelBeat = applyVisibleCastCountCompositionOverride(rawPanelBeat, panelCastNames.length);
        const id = splitCount > 1 ? `panel:${utterance.id}:${panelIndex + 1}` : `image:${utterance.id}`;
        const outputPath = join(assetDir, splitCount > 1 ? `${stem}-panel-${panelIndex + 1}.png` : `${stem}.png`);
        const narrationIdentityAnchor = (utterance.speakerId === "narration" || utterance.preset === "narration")
          && protagonistCharacter
          && panelCharacterIds.includes(protagonistCharacter.id)
          ? `Narration identity anchor: ${protagonistCharacter.name} is the story protagonist and the first-person narrator referred to as 俺. Use the approved ${protagonistCharacter.name} identity whenever this narration depicts the narrator; do not replace explicitly named other characters.`
          : "";
        const panelAllowsActiveSpeaker = !activeSpeakerId || panelCharacterIds.includes(activeSpeakerId);
        const panelActiveSpeakerDirective = panelAllowsActiveSpeaker ? activeSpeakerDirective : "";
        const panelVisualDirective = nonEmptyString(panelOverride.visualDirective)
          || nonEmptyString(visualOverride.visualDirective);
        const panelBibleGuidance = characterBibleGuidance(characterBible, panelCastNames);
        const panelEyeOpenBindings = eyeOpenBindings.filter((entry) => panelCharacterIds.includes(entry.characterId));
        const panelEyeOpenDirective = panelEyeOpenBindings.map((entry) => (
          `EYES-OPEN BEAT (開眼): ${entry.name} has both eyes open in this image${entry.variantLabel ? `, in the approved '${entry.variantLabel}' state` : ""}. Copy the open eyes from the RIGHT COLUMN of ${entry.name}'s attached eyes-open reference sheet; take face, hair, and outfit from ${entry.name}'s identity face.`
        )).join("\n");
        const panelDefaultEyesNames = eyeOpenPolicy
          ? eyeOpenCandidates
            .filter((candidate) => panelCharacterIds.includes(candidate.characterId) && !panelEyeOpenBindings.some((entry) => entry.characterId === candidate.characterId))
            .map((candidate) => findCharacter(registry, candidate.characterId)?.name || candidate.label)
          : [];
        const panelDefaultEyesDirective = panelDefaultEyesNames.length > 0
          ? `DEFAULT EYES: ${panelDefaultEyesNames.join(", ")} keep their usual default eyes exactly as in their identity face reference; do not draw an eyes-open state in this image.`
          : "";
        const exactFigureDirective = authoredPanels.length === 0
          ? ""
          : allowUnnamedBackgroundPeople
            ? `Required named cast in this frame: ${panelCastNames.join(", ") || "none"}. Unnamed background attendees are allowed only as secondary figures required by the scene.`
            : `Show exactly ${panelCastNames.length} identifiable named cast figure${panelCastNames.length === 1 ? "" : "s"}: ${panelCastNames.join(", ")}. Do not add unnamed people or duplicate any character.`;
        let prompt = [visualBeatPrompt(panelBeat, {
          location: location.name,
          cast: panelCastNames,
          allowUnnamedBackgroundPeople,
          continuity: "lock face, hair, body identity, recurring props, time of day, and geography to approved references; change age and wardrobe only as required by the explicit story stage; vary viewpoint and blocking from adjacent images",
        }, editorial, splitCount > 1 ? (nonEmptyString(panelOverride.role) || panelRoles[panelIndex]) : ""), panelActiveSpeakerDirective, exactFigureDirective, panelVisualDirective ? `EPISODE-SPECIFIC VISUAL DIRECTIVE: ${panelVisualDirective}` : "", settingDirective, splitCount > 1 ? splitPanelSafeZoneDirective(editorial.split.type, panelIndex) : "", `Story age and wardrobe stage: ${storyStage}`, textFreeProps, dialogueRepair, panelBibleGuidance ? `Character bible authority:\n${panelBibleGuidance}` : "", narrationIdentityAnchor, panelEyeOpenDirective, panelDefaultEyesDirective].filter(Boolean).join("\n");
        // 番組の画風と visual profile は冒頭に置く。宣言が無ければ何も足さない（従来の文面・入力 hash のまま）。
        const sceneStyleDirective = sceneChannelStyleDirective(channelStyle, prompt);
        if (sceneStyleDirective) prompt = `${sceneStyleDirective}\n${prompt}`;
        // Codex imagegen accepts at most five local reference files. Reserve
        // one slot for location continuity, then give every visible character
        // an identity face before adding secondary turnaround/expression evidence.
        const locationAnchorRefs = locationRefs.slice(0, 1);
        const maxReferencePaths = 5;
        const characterReferenceCapacity = maxReferencePaths - locationAnchorRefs.length;
        if (panelCharacterIds.length > characterReferenceCapacity) {
          throw new Error(
            `${utterance.id} panel ${panelIndex + 1} has ${panelCharacterIds.length} visible characters but the image provider can bind only ${characterReferenceCapacity} character anchors while preserving the location reference. Split the cast across more panels or reduce the visible cast before paid generation.`,
          );
        }
        const referenceIntent = nonEmptyString(panelOverride.referenceIntent ?? visualOverride.referenceIntent);
        const comicalBindings = isComicalReferenceIntent(referenceIntent)
          ? optimizeCharacterBindingsForGeneration(resolveCharacterBindings(registry, panelCharacterIds, { canvasDir }), {
            referenceIntent,
            productionReferenceIndexPath: panelOverride.productionReferenceIndexPath ?? visualOverride.productionReferenceIndexPath ?? input.visualPlanOverrides?.productionReferenceIndexPath,
            projectDir: dirname(canvasDir),
            providerReferenceLimit: characterReferenceCapacity,
          })
          : null;
        if (comicalBindings && panelEyeOpenBindings.length > 0) {
          throw new Error(`${utterance.id} panel ${panelIndex + 1}: an eye-open beat cannot use the ${referenceIntent} reference route; choose one of them.`);
        }
        const characterRefs = comicalBindings ? comicalBindings.flatMap((binding) => binding.referenceImagePaths) : balancedCharacterReferencePaths(
          panelCharacterIds.map((characterId) => characterReferenceGroup(
            registry,
            characterId,
            canvasDir,
            Boolean(eyeOpenPolicy),
            panelEyeOpenBindings.find((entry) => entry.characterId === characterId)?.referencePath,
          )),
          characterReferenceCapacity,
        );
        const referenceImagePaths = unique([...characterRefs, ...locationAnchorRefs]).slice(0, maxReferencePaths);
        const unboundEyeOpen = panelEyeOpenBindings.filter((entry) => !referenceImagePaths.includes(entry.referencePath));
        if (unboundEyeOpen.length > 0) {
          throw new Error(
            `Eye-open beat ${utterance.id} cannot bind ${unboundEyeOpen.map((entry) => entry.name).join(", ")}'s eyes-open sheet within the ${maxReferencePaths}-reference budget. Split the cut or reduce its visible cast before paid generation.`,
          );
        }
        if (comicalBindings) prompt += `\n${buildCharacterIdentityPrompt(comicalBindings)}`;
        const panelCompactCharacterRefs = panelCharacterIds.flatMap((characterId) => (
          resolveCharacterReferencePaths(registry, [characterId], { canvasDir }).slice(0, 1)
        ));
        const eyeOpenReferencePaths = panelEyeOpenBindings.map((entry) => entry.referencePath);
        const fallbackReferenceImagePaths = comicalBindings ? referenceImagePaths : unique([
          ...panelCompactCharacterRefs,
          ...eyeOpenReferencePaths,
          ...(panelCompactCharacterRefs.length + eyeOpenReferencePaths.length < 3 ? locationRefs : []),
        ]).slice(0, 3);
        const job = {
          id,
          kind: splitCount > 1 ? "split-panel" : "scene-image",
          dependencies: environmentDependency ? [environmentDependency] : [],
          outputPath,
          prompt,
          referenceImagePaths,
          fallbackReferenceImagePaths,
          ...(comicalBindings ? { referenceIntent, comicalBindings } : {}),
          model: nonEmptyString(input.model) || DEFAULT_IMAGE_MODEL,
          aspectRatio: "16:9",
          imageSize: "2K",
          quality: "high",
          imageCount: 1,
          composition: panelBeat,
          editorial,
          location,
          settingDirective,
          activeSpeakerId: panelAllowsActiveSpeaker ? activeSpeakerId : "",
          activeSpeakerName: panelAllowsActiveSpeaker ? activeSpeakerName : "",
          characterIds: panelCharacterIds,
          castNames: panelCastNames,
          expectedVisibleCastCount: panelCastNames.length,
          allowUnnamedBackgroundPeople,
          storyStage,
          textFreeEvidencePolicy: Boolean(textFreeProps),
          ...channelArtStyleJobFields(channelStyle),
          ...(eyeOpenPolicy ? {
            eyeOpen: panelEyeOpenBindings.map(({ characterId, name, variant, variantLabel, referencePath, source }) => ({ characterId, name, variant, variantLabel, referencePath, source })),
            defaultEyesNames: panelDefaultEyesNames,
          } : {}),
        };
        job.inputHash = mangaVideoJobInputHash(job.kind, {
          prompt: job.prompt,
          referenceImagePaths: job.referenceImagePaths,
          ...(comicalBindings ? { comicalBindings } : {}),
          model: job.model,
          imageCount: 1,
        });
        jobs.push(job);
        panelJobs.push(job);
      }
      for (const entry of eyeOpenBindings) {
        boundEyeOpenImages.push({
          utteranceId: utterance.id,
          cutId: cut.id,
          characterId: entry.characterId,
          variant: entry.variant,
          source: entry.source,
          jobIds: panelJobs.filter((job) => job.characterIds.includes(entry.characterId)).map((job) => job.id),
        });
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
          layoutVariant: nonEmptyString(visualOverride.splitLayout),
          separatorWidthRatio: editorial.split.separatorWidthRatio,
          imageCount: 0,
          composition: beat,
          castNames,
          storyStage,
          settingDirective,
          montageTimeline: /(?:それから|その後|時は流れ|日々|年月|数ヶ月|毎日|ルーティン)/u.test(utterance.text || ""),
          editorial,
          inputHash: mangaVideoJobInputHash("split-page", {
            inputs: panelJobs.map((entry) => entry.inputHash),
            splitType: editorial.split.type,
            layoutVariant: nonEmptyString(visualOverride.splitLayout),
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
          layoutVariant: nonEmptyString(visualOverride.splitLayout),
          cameraMode: nonEmptyString(visualOverride.cameraMode),
          camera: visualOverride.camera && typeof visualOverride.camera === "object" ? structuredClone(visualOverride.camera) : null,
          pacing: visualOverride.pacing && typeof visualOverride.pacing === "object" ? structuredClone(visualOverride.pacing) : {},
          panelJobIds: panelJobs.map((entry) => entry.id),
          panelCamera: "static",
          flattenBeforeCamera: true,
          wholePageCamera: true,
        });
      } else {
        pages.push({
          utteranceId: utterance.id,
          cutId: cut.id,
          assetJobId: panelJobs[0].id,
          editorial,
          cameraMode: nonEmptyString(visualOverride.cameraMode),
          camera: visualOverride.camera && typeof visualOverride.camera === "object" ? structuredClone(visualOverride.camera) : null,
          pacing: visualOverride.pacing && typeof visualOverride.pacing === "object" ? structuredClone(visualOverride.pacing) : {},
          wholePageCamera: true,
        });
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
    visualPlan: input.visualPlanOverrides && typeof input.visualPlanOverrides === "object"
      ? structuredClone(input.visualPlanOverrides)
      : null,
    // どの画風宣言でプロンプトを作ったか（id だけ）。宣言が無い計画には書かない。
    ...(channelStyle ? { channelStyle: channelStyleSummary(channelStyle) } : {}),
    jobs,
    pages: pages.map((entry) => ({ ...entry, outputPath: jobById.get(entry.assetJobId)?.outputPath })),
    eyeOpen: eyeOpenPolicy
      ? {
          active: true,
          source: eyeOpenResolution.source,
          candidateIds: eyeOpenCandidates.map((entry) => entry.characterId),
          beats: eyeOpenResolution.beats,
          boundImages: boundEyeOpenImages,
        }
      : { active: false },
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
  if (job.splitType === "story-3" && job.layoutVariant === "grid-3") {
    const cellWidth = Math.floor((1920 - gutter) / 2);
    const cellHeight = Math.floor((1080 - gutter) / 2);
    const rightX = cellWidth + gutter;
    const bottomY = cellHeight + gutter;
    const bottomX = Math.floor((1920 - cellWidth) / 2);
    filter = [
      `[0:v]scale=${cellWidth}:${cellHeight}:force_original_aspect_ratio=decrease,pad=${cellWidth}:${cellHeight}:(ow-iw)/2:(oh-ih)/2:black[p0]`,
      `[1:v]scale=${cellWidth}:${cellHeight}:force_original_aspect_ratio=decrease,pad=${cellWidth}:${cellHeight}:(ow-iw)/2:(oh-ih)/2:black[p1]`,
      `[2:v]scale=${cellWidth}:${cellHeight}:force_original_aspect_ratio=decrease,pad=${cellWidth}:${cellHeight}:(ow-iw)/2:(oh-ih)/2:black[p2]`,
      `color=c=black:s=1920x1080[base]`,
      `[base][p0]overlay=0:0[b1]`,
      `[b1][p1]overlay=${rightX}:0[b2]`,
      `[b2][p2]overlay=${bottomX}:${bottomY}[out]`,
    ].join(";");
  } else if (job.splitType === "story-3") {
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
  const eyeOpenJobEntries = Array.isArray(payload.job.eyeOpen) ? payload.job.eyeOpen : [];
  const comparisonReferenceNames = mangaImageQaReferenceCandidates(payload.job).slice(0, 4).map((referencePath, index) => {
    const binding = payload.job.comicalBindings?.find((entry) => entry.referenceImagePaths.includes(referencePath));
    if (binding) {
      const role = binding.referenceAssets.find((asset) => asset.path === referencePath).role;
      return `attachment ${index + 1} after the candidate = ${binding.name} ${role === "identity-face" ? "approved identity" : `${role} supplemental expression art`}`;
    }
    const eyeOpenEntry = eyeOpenJobEntries.find((entry) => entry.referencePath === referencePath);
    if (eyeOpenEntry) return `attachment ${index + 1} after the candidate = ${eyeOpenEntry.name} approved eyes-open sheet${eyeOpenEntry.variantLabel ? ` (${eyeOpenEntry.variantLabel})` : ""}, right column = open eyes`;
    return index < (payload.job.castNames || []).length && !payload.job.comicalBindings
      ? `attachment ${index + 1} after the candidate = ${payload.job.castNames[index]} approved identity`
      : `attachment ${index + 1} after the candidate = environment or secondary continuity reference`;
  });
  const eyeOpenContract = [
    ...eyeOpenJobEntries.map((entry) => `Eyes-open beat contract: ${entry.name} must visibly have both eyes open${entry.variantLabel ? ` in the approved '${entry.variantLabel}' state` : ""}, matching the right column of the attached eyes-open sheet. Default closed or slit eyes, or a different open-eye expression, is a hard failure.`),
    Array.isArray(payload.job.defaultEyesNames) && payload.job.defaultEyesNames.length > 0
      ? `Default-eyes contract: ${payload.job.defaultEyesNames.join(", ")} must keep their usual default eyes from the identity reference; an eyes-open state here is a hard failure.`
      : "",
  ].filter(Boolean).join(" ");
  const isSingleGeneratedFrame = payload.job.kind === "scene-image" || payload.job.kind === "split-panel";
  const expectedVisibleCastCount = Number.isInteger(payload.job.expectedVisibleCastCount)
    ? payload.job.expectedVisibleCastCount
    : Array.isArray(payload.job.castNames)
      ? payload.job.castNames.length
      : 0;
  const exactFigureCountContract = isSingleGeneratedFrame && payload.job.allowUnnamedBackgroundPeople !== true
    ? `Exact figure-count contract: the candidate must contain exactly ${expectedVisibleCastCount} distinct named story figures total${expectedVisibleCastCount > 0 ? ` (${(payload.job.castNames || []).join(", ")})` : ""}. Count every visible person or animal, including tiny or blurred staff, workers, attendees, heads, limbs implying another body, distant silhouettes, human reflections, and figures on posters or screens. Any total other than ${expectedVisibleCastCount}, or any unnamed figure, is a hard failure.`
    : isSingleGeneratedFrame
      ? "This exact beat explicitly permits unnamed background people. They must remain secondary, while every named cast identity remains unique and readable."
      : "";
  return [
    "You are a fresh blind visual quality evaluator. The FIRST attached image is the generated candidate. Any later attached images are approved identity/environment references used only for consistency comparison.",
    "Do not edit files, do not generate an image, do not browse, and do not infer credit for invisible intentions.",
    `Job kind: ${payload.job.kind}. Expected result: ${expected}`,
    Array.isArray(payload.job.castNames) && payload.job.castNames.length > 0
      ? `Expected approved primary cast: ${payload.job.castNames.join(", ")}. Do not infer cast count from the number of attached reference sheets. A public venue, workplace, street, or event hall by itself does not authorize invented bystanders. Extra people, cloned approved characters, or repeated copies of the same identity are hard failures.`
      : "",
    exactFigureCountContract,
    payload.job.kind === "scene-image"
      && payload.job.activeSpeakerName
      ? `Active spoken-dialogue speaker: ${payload.job.activeSpeakerName}. Their identifiable face (eyes and mouth, or a readable profile with one eye and mouth) must be visibly present and usable for speech-bubble placement. They must visibly read as the person delivering this line; if another expected cast member looks like the sole or primary speaker while ${payload.job.activeSpeakerName} does not, that is a hard failure. A back-of-head-only speaker or a speaker reduced to an unreadably tiny distant figure is also a hard failure.`
      : "",
    payload.job.composition?.intent === "object-action"
      ? "Explicit physical-action contract: the named cause, acting hand or paw, affected prop, direction of movement, and required destination must be visibly readable in this frame. Merely showing the characters and prop before or after the action, or leaving the prop at the wrong destination, is a hard failure."
      : "",
    payload.job.composition?.intent === "resolution-montage"
      ? "Closing-tableau evaluation: judge whether the dominant comic consequence and each named character's narrated end-state are readable together in one anatomically coherent group frame. Do not require every transitional micro-movement or impossible-to-freeze biomechanical instant to be literalized simultaneously; narration is allowed to carry that fine transition. Still fail an absent named outcome, an unrelated pose, broken anatomy, or a concealed prop that is not suggested at all."
      : "",
    comparisonReferenceNames.length > 0 ? `Reference attachment identity map: ${comparisonReferenceNames.join("; ")}.` : "",
    eyeOpenContract,
    payload.job.storyStage ? `Explicit story stage: ${payload.job.storyStage}` : "",
    payload.job.settingDirective
      ? `Setting fidelity contract: ${payload.job.settingDirective} A visually polished image that changes this venue into a different social or architectural world is a hard failure.`
      : "",
    payload.job.settingDirective && payload.job.composition?.setup?.shotSize
      ? `Shot-scale setting interpretation: requested shot size is ${payload.job.composition.setup.shotSize}. Wide and medium-wide frames should establish multiple recurring venue features. Medium-close, close, extreme-close, insert, and object-led frames need only the location cues that can naturally remain inside that crop (for example one coherent material, furniture edge, curtain, chair row, terminal, or sealed box); do not require every recurring venue prop to be visible and do not force a wider camera that violates the requested shot. Missing all coherent location cues or changing the venue's social/architectural world remains a failure.`
      : "",
    "Approved character references lock face, hair, body identity, and rendering style. Their displayed outfit may belong to another age stage; do not penalize an intentional wardrobe change that follows the explicit story stage.",
    payload.job.channelArtStyle?.medium
      ? `Channel art-style contract (${payload.job.channelArtStyle.id}): the candidate must be drawn artwork in the channel's declared medium — ${payload.job.channelArtStyle.medium}. A photograph, a photoreal or 3D-rendered look, or a different illustration style is a hard failure.`
      : "",
    payload.job.comicalBindings ? `Explicit ${payload.job.referenceIntent} direction: ${payload.job.referenceIntent === "comical-A" ? "retain normal body proportions with exaggerated expressions" : "chibi proportions are intentional; retain recognizable character identity"}. Compare the selected supplemental art as well as the approved face. Do not reject intentional stylization as identity drift or mix A and B.` : "",
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

function correctivePrompt(job, qa, options = {}) {
  const issues = qa?.issues?.length ? qa.issues.join("; ") : "the previous image failed the visual quality contract";
  const editSource = options.previousCandidateAttached === true
    ? " The FIRST reference image is the immediately previous candidate. Treat it as the edit source: preserve its successful identity, venue, lighting, and overall composition, and visibly change the failed pose/action details instead of recreating the whole scene."
    : "";
  return `${job.prompt}\n\nCORRECTION PASS:${editSource} Fix these failures: ${issues}. Preserve identity and story meaning. Do not repeat the previous defect. No speech balloon, captions, readable text, logo, or watermark.`;
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
  // Reject stale plans before any generation, including environment jobs/cache reuse.
  const verifyComicalJob = (job, paths = job.referenceImagePaths, limit = 5) => {
    if (!isComicalReferenceIntent(job.referenceIntent) && !job.comicalBindings) return;
    verifyComicalReferenceBindings(job.comicalBindings);
    const required = job.comicalBindings.flatMap((binding) => binding.referenceImagePaths);
    if (!Array.isArray(paths) || required.some((path) => !paths.includes(path)) || paths.length > limit) {
      throw new Error(`${job.id}: comical identity and supplemental references must all fit the provider limit ${limit}.`);
    }
  };
  for (const job of plan.jobs) verifyComicalJob(job);
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
  // --retry-failed で「同じ入力のまま」pending へ戻した失敗行。入力が変わって
  // 作り直す行（replan）は数えない。ここに載る枚数だけが「失敗分の作り直し」で、
  // 外側の Job／Receipt は指紋を迂回する引数を使った事実をこれで確かめる。
  const retriedFailedJobIds = [];

  for (const job of plan.jobs) {
    const state = ledger.jobs[job.id];
    if (state?.status === "complete" && state.inputHash === job.inputHash && await fileExists(job.outputPath)) completed.add(job.id);
    else if (state?.status === "running" || state?.status === "waiting") state.status = "pending";
    else if (state?.status === "failed" && (retryFailed || state.inputHash !== job.inputHash)) {
      if (retryFailed && state.inputHash === job.inputHash) retriedFailedJobIds.push(job.id);
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
            const sameHashPriorFailure = old?.previousFailure?.qa && old.previousFailure.inputHash === job.inputHash;
            const isCorrectionPass = attempt > 0 || Boolean(sameHashPriorFailure);
            // Keep the explicit comical reference numbering and both mandatory
            // inputs unchanged; corrections still receive the prior QA notes.
            const previousCandidateAttached = isCorrectionPass
              && !job.comicalBindings
              && await fileExists(job.outputPath);
            const correctionReferenceImagePaths = previousCandidateAttached
              ? unique([job.outputPath, ...(job.referenceImagePaths || [])]).slice(0, 5)
              : job.referenceImagePaths;
            const fallbackCorrectionReferenceImagePaths = job.comicalBindings
              ? (previousCandidateAttached && job.referenceImagePaths.length < 3
                ? unique([job.outputPath, ...job.referenceImagePaths]) : job.referenceImagePaths)
              : previousCandidateAttached
              ? unique([job.outputPath, ...(job.fallbackReferenceImagePaths || job.referenceImagePaths || [])]).slice(0, 3)
              : (job.fallbackReferenceImagePaths || job.referenceImagePaths || []).slice(0, 3);
            const generationInput = {
              prompt: isCorrectionPass
                ? correctivePrompt(job, attempt === 0 ? old.previousFailure.qa : state.qa, { previousCandidateAttached })
                : job.prompt,
              model: job.model,
              aspectRatio: job.aspectRatio,
              imageSize: job.imageSize,
              quality: job.quality,
              referenceImagePaths: correctionReferenceImagePaths,
              imageCount: 1,
              fileName: basename(job.outputPath),
            };
            if (!(reuseGeneratedForQa && attempt === 0)) {
              verifyComicalJob(job, correctionReferenceImagePaths);
              let media;
              const canUseFallback = fallbackImageModel && fallbackImageModel !== job.model;
              if (primaryImageUsageLimited && canUseFallback) {
                verifyComicalJob(job, fallbackCorrectionReferenceImagePaths, 3);
                state.primaryGenerationSkippedReason = "usage-limit-circuit-open";
                state.fallbackGenerationAttempts = Number(state.fallbackGenerationAttempts || 0) + 1;
                await save();
                media = await generator({
                  ...generationInput,
                  model: fallbackImageModel,
                  referenceImagePaths: fallbackCorrectionReferenceImagePaths,
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
                  verifyComicalJob(job, fallbackCorrectionReferenceImagePaths, 3);
                  primaryImageUsageLimited = true;
                  state.primaryGenerationError = primaryError instanceof Error ? primaryError.message : String(primaryError);
                  state.fallbackGenerationAttempts = Number(state.fallbackGenerationAttempts || 0) + 1;
                  await save();
                  media = await generator({
                    ...generationInput,
                    model: fallbackImageModel,
                    referenceImagePaths: fallbackCorrectionReferenceImagePaths,
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
    // 失敗分の作り直し（--retry-failed）。requested は引数の有無、jobIds は実際に
    // pending へ戻した行、attempts はその行でこの回に増えた生成回数（＝再課金の回数）。
    retriedFailed: {
      requested: retryFailed,
      jobIds: [...retriedFailedJobIds],
      count: retriedFailedJobIds.length,
      // state.attempts はその回の生成回数（pending に戻すと数え直し）なので、そのまま足す。
      attempts: retriedFailedJobIds.reduce((sum, id) => sum + Number(ledger.jobs[id]?.attempts || 0), 0),
      completed: retriedFailedJobIds.filter((id) => ledger.jobs[id]?.status === "complete").length,
    },
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
    visualPlanOverrides: args.visualPlanOverrides,
    // 番組の画風（artStyle）と visual profile。渡された宣言だけを使い、ここで既定を補わない。
    channelStyle: args.channelStyle,
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
