#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { writeJsonAtomic } from "../lib/canvasScene.mjs";
import { applyMangaCameraGrammarToShot } from "../lib/mangaPageCameraGrammar.mjs";
import { createEpisodeManifest } from "../lib/mangaVideoPipeline.mjs";

const projectDir = resolve(process.argv[2] || process.cwd());
const episodeId = "manga-arano-amane-reversal-001";
const episodeDir = join(projectDir, "canvas/manga-videos", episodeId);
const scriptPath = join(episodeDir, "script.txt");
const productionScriptPath = join(episodeDir, "script-production-r1.txt");
const storyboard = JSON.parse(await readFile(join(episodeDir, "storyboard.json"), "utf8"));
const selection = JSON.parse(await readFile(join(episodeDir, "image-selection.json"), "utf8"));

const splitLongText = (value, maximum = 32) => {
  const characters = [...String(value || "")];
  if (characters.length <= maximum) return [value];
  const chunks = [];
  let rest = characters;
  const primaryBreaks = new Set(["。", "！", "？", "!", "?"]);
  const secondaryBreaks = new Set(["、", "，", ",", "…", " ", "　"]);
  while (rest.length > maximum) {
    let splitAt = -1;
    for (let index = Math.min(maximum, rest.length - 1); index >= Math.floor(maximum * 0.58); index -= 1) {
      if (primaryBreaks.has(rest[index])) { splitAt = index + 1; break; }
    }
    if (splitAt < 0) {
      for (let index = Math.min(maximum, rest.length - 1); index >= Math.floor(maximum * 0.58); index -= 1) {
        if (secondaryBreaks.has(rest[index])) { splitAt = index + 1; break; }
      }
    }
    if (splitAt < 0) splitAt = maximum;
    chunks.push(rest.slice(0, splitAt).join(""));
    rest = rest.slice(splitAt);
  }
  if (rest.length > 0) chunks.push(rest.join(""));
  return chunks.filter(Boolean);
};

const sourceScript = await readFile(scriptPath, "utf8");
const productionLines = [];
const sourceDialogue = [];
const productionDialogue = [];
for (const rawLine of sourceScript.split("\n")) {
  const match = rawLine.match(/^([^：:]{1,80})[：:]\s*(.+)$/u);
  if (!match || /^タイトル$/u.test(match[1].trim())) {
    productionLines.push(rawLine);
    continue;
  }
  const speaker = match[1].trim();
  const text = match[2];
  sourceDialogue.push(text);
  const chunks = splitLongText(text);
  for (const chunk of chunks) {
    productionDialogue.push(chunk);
    productionLines.push(`${speaker}：${chunk}`);
  }
}
if (sourceDialogue.join("") !== productionDialogue.join("")) {
  throw new Error("Production script segmentation changed or omitted source dialogue text.");
}
await writeFile(productionScriptPath, `${productionLines.join("\n")}\n`, "utf8");
await writeJsonAtomic(join(episodeDir, "audits/script-segmentation-audit-r1.json"), {
  version: "r1",
  pass: true,
  sourceScriptPath: scriptPath,
  productionScriptPath,
  maximumCharactersPerUtterance: 32,
  sourceTextLength: [...sourceDialogue.join("")].length,
  productionTextLength: [...productionDialogue.join("")].length,
  exactConcatenatedTextMatch: true,
  knownRemainingIssues: [],
});

const reference = (name) => resolve(episodeDir, selection.characterReferences[name]);
const imagePathByCutId = Object.fromEntries(Object.entries(selection.cuts)
  .map(([cutId, filePath]) => [cutId, resolve(episodeDir, filePath)]));

const voices = [
  {
    id: "voice-arano-r1",
    name: "BuzzAssist JP Reiji Sawaro / 荒野",
    provider: "elevenlabs",
    providerVoiceId: "EbuvaInXUGWtpYRUnKLQ",
    modelId: "eleven_v3",
    role: "character",
    episodeId,
    status: "approved",
    settings: { stability: 0.62, similarityBoost: 0.84, speed: 0.98, useSpeakerBoost: true },
  },
  {
    id: "voice-sakura-r1",
    name: "Sakura - Japanese Girl / 花園さくら",
    provider: "elevenlabs",
    providerVoiceId: "GxhGYQesaQaYKePCZDEC",
    modelId: "eleven_v3",
    role: "character",
    episodeId,
    status: "approved",
    settings: { stability: 0.58, similarityBoost: 0.82, speed: 1.02, useSpeakerBoost: true },
  },
  {
    id: "voice-amane-r1",
    name: "Hina - cute and friendly / 上沢天音",
    provider: "elevenlabs",
    providerVoiceId: "lhTvHflPVOqgSWyuWQry",
    modelId: "eleven_v3",
    role: "character",
    episodeId,
    status: "approved",
    settings: { stability: 0.55, similarityBoost: 0.82, speed: 1.01, useSpeakerBoost: true },
  },
  {
    id: "voice-boyfriend-r1",
    name: "Daisuke / T大の彼氏",
    provider: "elevenlabs",
    providerVoiceId: "ss9cJxDAEMXP4wfQ3GPr",
    modelId: "eleven_v3",
    role: "character",
    episodeId,
    status: "approved",
    settings: { stability: 0.66, similarityBoost: 0.8, speed: 1, useSpeakerBoost: true },
  },
  {
    id: "voice-narration-r1",
    name: "BuzzAssist JP Narrator Koichi / ナレーション",
    provider: "elevenlabs",
    providerVoiceId: "H8ZPDxbrPcks5hEsi2fq",
    modelId: "eleven_v3",
    role: "narration",
    episodeId,
    status: "approved",
    settings: { stability: 0.64, similarityBoost: 0.82, speed: 1, useSpeakerBoost: true },
  },
];

const characters = [
  {
    id: "arano",
    name: "荒野",
    kind: "character",
    role: "per-video",
    status: "approved",
    episodeId,
    aliases: ["あらの", "荒野くん"],
    description: "右分けの黒髪、切れ長の濃茶の目、細身で誠実。高校・大学・社会人・30代の時系列差分を持つ。",
    invariants: ["右分け黒髪", "切れ長の濃茶の目", "まっすぐな眉", "眼鏡とひげなし"],
    referenceImagePaths: [reference("arano")],
    voiceId: "voice-arano-r1",
  },
  {
    id: "hanazono-sakura",
    name: "花園さくら",
    kind: "character",
    role: "per-video",
    status: "approved",
    episodeId,
    aliases: ["さくら", "花園さん"],
    description: "内巻きダークブラウン髪、本人左側の桜色ヘアピン、右目下の泣きぼくろ、小柄。",
    invariants: ["桜色ヘアピン", "右目下の泣きぼくろ", "小柄", "ショート・金髪・眼鏡なし"],
    referenceImagePaths: [reference("sakura")],
    voiceId: "voice-sakura-r1",
  },
  {
    id: "kanzawa-amane",
    name: "上沢天音",
    kind: "character",
    role: "per-video",
    status: "approved",
    episodeId,
    aliases: ["かんざわ あまね", "天音", "上沢さん"],
    description: "黒髪ポニーテール、琥珀色の目、左耳の星形ピアス、活動的でまっすぐ。",
    invariants: ["黒髪ポニーテール", "琥珀色の目", "左耳の星形ピアス", "桜色ヘアピンなし"],
    referenceImagePaths: [reference("amane")],
    voiceId: "voice-amane-r1",
  },
  {
    id: "t-daigakuno-kareshi",
    name: "T大の彼氏",
    kind: "character",
    role: "per-video",
    status: "approved",
    episodeId,
    aliases: [],
    description: "20代前半、短い黒髪、ダークグレーのジャケット。荒野とは別人。",
    invariants: ["短い黒髪", "ダークグレーのジャケット", "荒野に似せない"],
    referenceImagePaths: [],
    voiceId: "voice-boyfriend-r1",
  },
];

const registry = { characters, voices };
const pronunciations = [
  { from: "荒野（あらの）", to: "あらの" },
  { from: "上沢天音（かんざわ あまね）", to: "かんざわ あまね" },
  { from: "花園さくら", to: "はなぞの さくら" },
  { from: "花園さん", to: "はなぞのさん" },
  { from: "荒野くん", to: "あらのくん" },
  { from: "荒野", to: "あらの" },
  { from: "上沢さん", to: "かんざわさん" },
  { from: "上沢天音", to: "かんざわ あまね" },
  { from: "天音", to: "あまね" },
  { from: "T大", to: "ティーだい" },
  { from: "1周年", to: "いっしゅうねん" },
  { from: "2・3年生", to: "にねんせい、さんねんせい" },
  { from: "4年生", to: "よねんせい" },
  { from: "海外事業部", to: "かいがいじぎょうぶ" },
  { from: "総合職", to: "そうごうしょく" },
  { from: "就活", to: "しゅうかつ" },
];

const planned = await createEpisodeManifest({
  projectDir,
  scriptPath: productionScriptPath,
  episodeId,
  title: "学歴で振られた俺が、本当の幸せをつかむまで",
  registry,
  autoCastVoices: false,
  persistVoiceCasting: false,
  imagePathByCutId,
  speechPronunciations: pronunciations,
  useLegacyBubbleTemplates: false,
  model: "eleven_v3",
  width: 1920,
  height: 1080,
  fps: 30,
  motion: "pullout-only",
  preRollSeconds: 0.1,
  sameSpeakerGapSeconds: 0.06,
  speakerChangeGapSeconds: 0.09,
  emphasisGapSeconds: 0.22,
  bubbleLeadSeconds: 0.08,
  bubbleHoldSeconds: 0.16,
  bubbleTransitionGapSeconds: 2 / 30,
  bubbleTransitionCrossfadeSeconds: 0,
  bubbleFadeInMilliseconds: 45,
  bubbleFadeOutMilliseconds: 45,
  cutTailSeconds: 0.34,
  normalizeVoiceAudio: true,
  voiceTargetLufs: -19,
  voiceLoudnessRange: 7,
  voiceTruePeakDb: -2,
  voiceFadeInMilliseconds: 8,
  voiceFadeOutMilliseconds: 12,
  normalizeMasterAudio: true,
  masterTargetLufs: -14.5,
  masterLoudnessRange: 7,
  masterTruePeakDb: -1.5,
  speechConcurrency: 2,
  renderConcurrency: 2,
});

const manifest = planned.manifest;
// The production parser deliberately removes a leading Japanese quote from a
// field-looking value. Restore it for the on-screen bubble while keeping the
// spoken form natural and unquoted.
const meetingUtterance = manifest.utterances.find((entry) => entry.id === "cut-20-u03");
if (!meetingUtterance) throw new Error("Missing cut-20-u03.");
meetingUtterance.text = "「会議」という言葉すら知らなかったらしい。";
meetingUtterance.speechOverride = "会議という言葉すら知らなかったらしい。";
const learningMeaningUtterance = manifest.utterances.find((entry) => entry.id === "cut-18-u02");
if (!learningMeaningUtterance) throw new Error("Missing cut-18-u02.");
learningMeaningUtterance.text = "学歴だけが大事なわけじゃない。大学に行く意味は『何を学びたいか』";
learningMeaningUtterance.speechOverride = "学歴だけが大事なわけじゃない。大学に行く意味は、何を学びたいか";
const storyboardByCutId = new Map(storyboard.shots.map((shot) => [shot.cutId, shot]));
const faceBoundsByCutId = {
  "cut-01": { arano: { x: 0.29, y: 0.08, width: 0.11, height: 0.20 }, "hanazono-sakura": { x: 0.65, y: 0.07, width: 0.13, height: 0.23 } },
  "cut-02": { arano: { x: 0.04, y: 0.01, width: 0.25, height: 0.43 }, "hanazono-sakura": { x: 0.70, y: 0.13, width: 0.13, height: 0.23 } },
  "cut-03": { arano: { x: 0.47, y: 0.69, width: 0.05, height: 0.09 }, "hanazono-sakura": { x: 0.47, y: 0.09, width: 0.05, height: 0.08 } },
  "cut-04": { arano: { x: 0.52, y: 0.12, width: 0.10, height: 0.18 }, "hanazono-sakura": { x: 0.78, y: 0.18, width: 0.08, height: 0.15 } },
  "cut-05": { arano: { x: 0.30, y: 0.10, width: 0.11, height: 0.20 }, "hanazono-sakura": { x: 0.59, y: 0.08, width: 0.12, height: 0.22 } },
  "cut-06": { arano: { x: 0.61, y: 0.11, width: 0.09, height: 0.18 }, "hanazono-sakura": { x: 0.24, y: 0.09, width: 0.10, height: 0.19 } },
  "cut-07": { arano: { x: 0.63, y: 0.19, width: 0.10, height: 0.18 }, "kanzawa-amane": { x: 0.36, y: 0.07, width: 0.11, height: 0.20 } },
  "cut-08": { arano: { x: 0.40, y: 0.14, width: 0.09, height: 0.18 }, "kanzawa-amane": { x: 0.17, y: 0.15, width: 0.10, height: 0.18 } },
  "cut-09": { arano: { x: 0.33, y: 0.07, width: 0.11, height: 0.19 }, "kanzawa-amane": { x: 0.59, y: 0.10, width: 0.11, height: 0.20 } },
  "cut-10": { arano: { x: 0.29, y: 0.20, width: 0.11, height: 0.18 }, "kanzawa-amane": { x: 0.63, y: 0.05, width: 0.11, height: 0.20 } },
  "cut-11": { arano: { x: 0.08, y: 0.05, width: 0.12, height: 0.22 }, "kanzawa-amane": { x: 0.56, y: 0.13, width: 0.12, height: 0.22 } },
  "cut-12": { arano: { x: 0.30, y: 0.04, width: 0.12, height: 0.22 }, "kanzawa-amane": { x: 0.69, y: 0.18, width: 0.11, height: 0.20 } },
  "cut-13": { arano: { x: 0.57, y: 0.20, width: 0.09, height: 0.16 }, "kanzawa-amane": { x: 0.35, y: 0.12, width: 0.09, height: 0.16 } },
  "cut-14": { arano: { x: 0.64, y: 0.04, width: 0.10, height: 0.19 }, "kanzawa-amane": { x: 0.48, y: 0.18, width: 0.10, height: 0.18 } },
  "cut-15": { arano: { x: 0.14, y: 0.08, width: 0.08, height: 0.16 }, "kanzawa-amane": { x: 0.24, y: 0.16, width: 0.08, height: 0.15 } },
  "cut-16": { arano: { x: 0.31, y: 0.08, width: 0.10, height: 0.19 }, "hanazono-sakura": { x: 0.69, y: 0.09, width: 0.10, height: 0.19 } },
  "cut-17": { arano: { x: 0.53, y: 0.10, width: 0.09, height: 0.17 }, "hanazono-sakura": { x: 0.82, y: 0.13, width: 0.09, height: 0.17 }, "kanzawa-amane": { x: 0.17, y: 0.06, width: 0.11, height: 0.20 } },
  "cut-18": { arano: { x: 0.55, y: 0.09, width: 0.08, height: 0.16 }, "hanazono-sakura": { x: 0.24, y: 0.13, width: 0.09, height: 0.17 }, "kanzawa-amane": { x: 0.82, y: 0.08, width: 0.10, height: 0.19 } },
  "cut-19": { arano: { x: 0.30, y: 0.05, width: 0.09, height: 0.17 }, "hanazono-sakura": { x: 0.16, y: 0.53, width: 0.07, height: 0.14 }, "kanzawa-amane": { x: 0.59, y: 0.12, width: 0.09, height: 0.17 } },
  "cut-20": { "hanazono-sakura": { x: 0.27, y: 0.19, width: 0.07, height: 0.14 }, "t-daigakuno-kareshi": { x: 0.54, y: 0.30, width: 0.07, height: 0.14 } },
  "cut-21": { arano: { x: 0.24, y: 0.07, width: 0.10, height: 0.19 }, "kanzawa-amane": { x: 0.85, y: 0.13, width: 0.09, height: 0.17 } },
};

const performanceFor = (utterance) => {
  const cut = Number(utterance.cutId.slice(-2));
  if (utterance.speakerId === "hanazono-sakura") {
    if (cut === 1) return utterance.order === 1 ? "[hesitant]" : "[cold]";
    if ([2, 5, 6].includes(cut)) return "[smug]";
    if (cut === 4) return "[casual]";
    return "[mocking]";
  }
  if (utterance.speakerId === "arano") {
    if (cut <= 3) return cut === 3 ? "[hurt]" : "[shocked]";
    if (cut === 5) return "[under his breath]";
    if ([7, 8, 9, 10].includes(cut)) return "[friendly]";
    if ([12, 13].includes(cut)) return "[sincere]";
    if (cut === 14) return "[nervous]";
    return "[firm]";
  }
  if (utterance.speakerId === "kanzawa-amane") {
    if ([7, 8, 9].includes(cut)) return "[bright]";
    if ([10, 11].includes(cut)) return "[enthusiastic]";
    if (cut === 14) return "[warm]";
    if ([18, 19].includes(cut)) return "[firm]";
    return "[earnest]";
  }
  if (utterance.speakerId === "t-daigakuno-kareshi") return "[cold]";
  return "";
};

const speakerSide = (bounds) => bounds && bounds.x + bounds.width / 2 < 0.5 ? "left" : "right";
const bubbleOverrides = { version: "r1", overrides: {}, cameraOverrides: {} };
const shotProof = [];
for (const cut of manifest.cuts) {
  const board = storyboardByCutId.get(cut.id);
  if (!board) throw new Error(`Missing storyboard entry for ${cut.id}`);
  const sourceFaceBoundsBySpeakerId = faceBoundsByCutId[cut.id] || {};
  const sourceAvoidRegions = Object.entries(sourceFaceBoundsBySpeakerId).map(([speakerId, bounds]) => ({
    id: `${cut.id}-${speakerId}-face`,
    kind: "face",
    speakerId,
    ...bounds,
  }));
  const shot = applyMangaCameraGrammarToShot({
    id: `${cut.id}-r1-shot`,
    utteranceIds: [...cut.utteranceIds],
    imagePath: cut.imagePath,
    transition: "cut",
    cameraIntensity: "strong",
    sourceFaceBoundsBySpeakerId,
    sourceAvoidRegions,
  }, board.viewpoint, board.cameraMode);
  // In the overhead classroom source, Amane enters from the top edge while
  // the authored top-then-pullout starts on the lower desk geography. Her
  // earliest line is intentionally off the opening crop; later lines reveal
  // her. Treat the early balloon as an offscreen entrance instead of faking
  // nine on-screen speaker samples or weakening the top-travel amplitude.
  if (["cut-07", "cut-17", "cut-18"].includes(cut.id)) {
    shot.speakerOffscreenSpeakerIds = ["kanzawa-amane"];
  }
  cut.motion = shot.cameraMode;
  cut.cameraMode = shot.cameraMode;
  cut.viewpoint = shot.viewpoint;
  cut.endView = shot.endView;
  cut.camera = shot.camera;
  cut.cameraSequence = [shot];
  cut.imageGeneration = {
    status: "approved-r1-manual-visual-audit",
    route: "built-in-imagegen",
    containsBakedText: false,
    identityReferences: Object.values(selection.characterReferences).map((value) => resolve(episodeDir, value)),
  };
  cut.storyboard = board;
  if (board.splitPage) {
    cut.flattenedSplitPage = {
      enabled: true,
      panelCount: ["cut-15", "cut-20"].includes(cut.id) ? 3 : 2,
      composition: "post-composite-then-flatten",
      motionPolicy: "whole-page",
      flattenBeforeCamera: true,
      panelCamera: "static",
      pageCameraMode: shot.cameraMode,
      pageMotion: shot.cameraMode,
    };
  }
  bubbleOverrides.cameraOverrides[cut.id] = shot.camera;
  shotProof.push({
    cutId: cut.id,
    viewpoint: shot.viewpoint,
    endView: shot.endView,
    cameraMode: shot.cameraMode,
    camera: shot.camera,
    splitPage: Boolean(board.splitPage),
  });
  for (const utteranceId of cut.utteranceIds) {
    const utterance = manifest.utterances.find((entry) => entry.id === utteranceId);
    const face = sourceFaceBoundsBySpeakerId[utterance.speakerId];
    const position = speakerSide(face);
    bubbleOverrides.overrides[utterance.id] = {
      speakerPosition: position,
      placementSide: utterance.preset === "narration"
        ? ((utterance.order + cut.number) % 2 === 0 ? "left" : "right")
        : (position === "left" ? "right" : "left"),
      lockPlacementSide: false,
      speakerHint: face ? { position, faceBand: "upper", faceBounds: face } : undefined,
      avoidRegions: sourceAvoidRegions,
    };
    utterance.performancePrompt = performanceFor(utterance);
    utterance.speechOverride = pronunciations.reduce(
      (text, rule) => text.split(rule.from).join(rule.to),
      utterance.text,
    );
  }
}

manifest.video = {
  ...(manifest.video || {}),
  width: 1920,
  height: 1080,
  fps: 30,
  fileName: `${episodeId}-r1-final.mp4`,
  statusAfterRender: "rendered-r1",
  bgmPath: "",
  bgmVolume: 0,
  encodePreset: "veryfast",
  cameraOversample: 1,
  cameraRendererRevision: "r1-manga-page-camera-v2",
  bubbleRendererRevision: "r1-sequence-camera-aware",
  cameraGrammarVersion: "manga-page-camera-v2",
  requireSemanticCameraViews: true,
  forbidPushInCameraMotion: true,
  requireWholePageSplitCamera: true,
  requireConstantCameraSpeed: true,
  forbidCameraStops: true,
  forbidDownwardCameraMotion: true,
  forbidRepeatedCameraImages: true,
};
manifest.production = {
  version: "r1-full-production",
  sourceScriptPath: scriptPath,
  productionScriptPath,
  characterBiblePath: join(episodeDir, "character-bible.md"),
  storyboardPath: join(episodeDir, "storyboard.json"),
  imageSelectionPath: join(episodeDir, "image-selection.json"),
  imageManualAuditPath: join(episodeDir, "audits/image-manual-audit-r1.json"),
  cameraPolicy: {
    version: "manga-page-camera-v2",
    repeatedImageShotsAllowed: false,
    terminalStopsAllowed: false,
    downwardMotionAllowed: false,
    pushInAllowed: false,
  },
  bubblePolicy: {
    exactTextRequired: true,
    activeSpeakerFaceOverlapAllowed: false,
    encodedClearFrameRequired: true,
  },
  speechPolicy: {
    provider: "elevenlabs",
    model: "eleven_v3",
    nativeJapaneseVoices: true,
    perSpeakerCasting: true,
  },
  qualityHarness: {
    targetScore: 92,
    maximumReviewRounds: 4,
  },
};
manifest.updatedAt = new Date().toISOString();

await Promise.all([
  writeJsonAtomic(planned.filePath, manifest),
  writeJsonAtomic(join(episodeDir, "bubble-overrides-r1.json"), bubbleOverrides),
  writeJsonAtomic(join(episodeDir, "camera-plan-r1.json"), {
    version: "r1",
    cameraGrammarVersion: "manga-page-camera-v2",
    shots: shotProof,
    familyCounts: storyboard.cameraFamilyCounts,
    knownRemainingIssues: [],
  }),
]);

process.stdout.write(`${JSON.stringify({
  episodeId,
  manifestPath: planned.filePath,
  cutCount: manifest.cuts.length,
  utteranceCount: manifest.utterances.length,
  bubbleOverridesPath: join(episodeDir, "bubble-overrides-r1.json"),
  cameraPlanPath: join(episodeDir, "camera-plan-r1.json"),
}, null, 2)}\n`);
