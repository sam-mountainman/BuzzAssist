import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { NARRATED_SUBTITLE_FIELDS } from "./narratedStorySubtitles.mjs";

export const CHANNEL_PACK_RUNTIME_VERSION = "buzzassist-channel-pack-runtime-v1";
export const NARRATED_RUNTIME_CONFIG_PATH = "narrated-story.json";

const SENSITIVE_KEY = /(?:api[-_]?key|authorization|auth[-_]?token|access[-_]?token|refresh[-_]?token|token|secret|password|credentials?|private[-_]?key|signing[-_]?key|client[-_]?secret|cookie)$/iu;
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_CONFIG_BYTES = 256 * 1024;

const TOP_LEVEL_FIELDS = new Set([
  "version", "runtime", "image", "voice", "music", "render", "concurrency", "bookends", "blockers",
  // 品質ループの上限と台本の受け口（中身の検査は lib/narratedStoryQualityLoop.mjs /
  // lib/narratedStoryScriptPackage.mjs。ここは durable Job へ持ち込む前の形の検査だけ）。
  "qualityLoop", "scriptIntake",
  // 役ごとの声（lib/narratedStoryCast.mjs）と BGM の区分（lib/narratedStoryMusicPlan.mjs）。
  "cast", "musicPlan",
  // 声の品質ゲートの撮り直しの上限（lib/narratedStoryVoiceQuality.mjs）。
  "voiceQuality",
  // サムネの決まり（任意。中身の検査は lib/thumbnailPlan.mjs の thumbnailRulesFromChannelSection）。
  // サムネは Job の成果物にも Receipt の保証にも入れないので、durable Job の runtime metadata には載せない。
  "thumbnail",
  // 焼き込み字幕（lib/narratedStorySubtitles.mjs）。
  "subtitles",
]);
const RUNTIME_FIELDS = new Set(["imageModel", "ttsProvider"]);
// source / operatorFile: 本編の画の出どころ（broker 既定／operator-file＝運営者が用意した画）。
// 中身の検査は lib/operatorImageImport.mjs の normalizeOperatorImageSourceConfig。
const IMAGE_FIELDS = new Set(["provider", "model", "adapterVersion", "stylePrompt", "source", "operatorFile"]);
const IMAGE_SOURCES = new Set(["broker", "operator-file"]);
const IMAGE_OPERATOR_FILE_FIELDS = new Set([
  "manifest", "expectedSize", "tolerancePx", "fit", "approvedReferences", "requireAssetLoopPass",
]);
const VOICE_FIELDS = new Set(["provider", "model", "adapterVersion", "voiceId", "speed"]);
const MUSIC_FIELDS = new Set(["provider", "model", "adapterVersion", "prompt", "gain"]);
const RENDER_FIELDS = new Set(["width", "height", "fps"]);
const BOOKEND_FIELDS = new Set(["enabled", "opening", "review", "transitions"]);
const BOOKEND_OPENING_FIELDS = new Set([
  "kind", "durationSeconds", "text", "fontFile", "textColor", "fontSize", "backgroundImage", "backgroundColor", "audio", "video",
]);
const BOOKEND_REVIEW_FIELDS = new Set(["scriptMarker", "presenter", "music", "musicGain", "operatorReplacementMarker"]);
const BOOKEND_PRESENTER_FIELDS = new Set(["required", "video", "backgroundColor"]);
const BOOKEND_TRANSITIONS_FIELDS = new Set(["openingToStory", "storyToReview"]);
const BOOKEND_TRANSITION_FIELDS = new Set(["type", "durationSeconds", "leadInSeconds", "outgoingFadeSeconds", "leakColors"]);
const BLOCKER_FIELDS = new Set(["id", "what"]);
const QUALITY_LOOP_FIELDS = new Set([
  "targetScore", "maximumReviewRounds", "maximumElapsedMinutes", "maximumCostUnits", "minimumImprovementPoints", "maximumStagnantRounds",
]);
const SCRIPT_INTAKE_FIELDS = new Set(["markdown"]);
const SCRIPT_INTAKE_MARKDOWN_FIELDS = new Set(["storyHeading", "reviewHeading"]);
const CAST_FIELDS = new Set(["roles", "undeclaredRoles", "acceptedRightsBases"]);
const CAST_ROLE_FIELDS = new Set(["status", "provider", "model", "adapterVersion", "voiceId", "speed", "rightsBasis", "blockReason"]);
const MUSIC_PLAN_FIELDS = new Set(["defaultSection", "crossfadeSeconds", "sections"]);
const VOICE_QUALITY_FIELDS = new Set(["maxTakesPerTurn"]);
const MUSIC_SECTION_FIELDS = new Set(["id", "position", "maxBlocks", "required", "source", "gain"]);
const MUSIC_SOURCE_FIELDS = new Set(["kind", "file", "prompt", "note"]);
// thumbnail 節の形（決まり・配置の種類・文字の方針・承認済みの参照）。値の検査は lib/thumbnailPlan.mjs。
const THUMBNAIL_FIELDS = new Set(["status", "rules", "layouts", "text", "approvedReferences"]);
const THUMBNAIL_RULES_FIELDS = new Set([
  "canvas", "decidedSize", "reuseDistance", "minimumDistinctIdeaAxes", "requireIdea", "brandTokens", "finalChecks",
]);
const THUMBNAIL_SIZE_FIELDS = new Set(["width", "height"]);
const THUMBNAIL_LAYOUT_FIELDS = new Set(["panels", "default", "reasonRequired"]);
const THUMBNAIL_TEXT_FIELDS = new Set(["band", "speechBubble", "telop", "forbiddenTerms", "approval"]);
const THUMBNAIL_BAND_FIELDS = new Set(["lines", "maxCharactersPerLine"]);
const THUMBNAIL_BUBBLE_FIELDS = new Set(["lines", "maxCharactersPerLine", "maximumPerPanel"]);
const THUMBNAIL_TELOP_FIELDS = new Set(["minCharacters", "maxCharacters", "concreteNounReview"]);
const THUMBNAIL_TERM_FIELDS = new Set(["text", "kind"]);
const THUMBNAIL_REFERENCE_FIELDS = new Set(["sha256", "characterRegistry"]);
const SUBTITLE_FIELDS = new Set(NARRATED_SUBTITLE_FIELDS.top);
const SUBTITLE_OUTLINE_FIELDS = new Set(NARRATED_SUBTITLE_FIELDS.outline);
const SUBTITLE_BAND_FIELDS = new Set(NARRATED_SUBTITLE_FIELDS.band);
const SUBTITLE_POSITION_FIELDS = new Set(NARRATED_SUBTITLE_FIELDS.position);

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertAllowedFields(value, allowed, label) {
  if (!plainObject(value)) throw new Error(`${label} must be an object.`);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) throw new Error(`${label} contains unsupported fields: ${unexpected.join(", ")}.`);
}

function assertNoSensitiveFields(value, label = "channelPackRuntime", seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) throw new Error(`${label}.${key} is forbidden; provider secrets must stay on the server.`);
    assertNoSensitiveFields(child, `${label}.${key}`, seen);
  }
}

function boundedString(value, label, maximum = 200) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  const normalized = value.trim();
  if (normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`${label} is not a bounded printable string.`);
  }
  return normalized;
}

function adapterMetadata(value, label, kind) {
  const provider = boundedString(value?.provider, `${label}.provider`, 64).toLowerCase();
  if (!PROVIDER_ID.test(provider)) throw new Error(`${label}.provider is not a stable adapter id.`);
  return {
    kind,
    provider,
    model: boundedString(value?.model, `${label}.model`),
    adapterVersion: boundedString(value?.adapterVersion, `${label}.adapterVersion`, 128),
  };
}

function validateThumbnailShape(thumbnail) {
  const at = "narrated-story.json.thumbnail";
  assertAllowedFields(thumbnail, THUMBNAIL_FIELDS, at);
  if (thumbnail.rules !== undefined) {
    assertAllowedFields(thumbnail.rules, THUMBNAIL_RULES_FIELDS, `${at}.rules`);
    for (const key of ["canvas", "decidedSize"]) {
      if (thumbnail.rules[key] !== undefined) assertAllowedFields(thumbnail.rules[key], THUMBNAIL_SIZE_FIELDS, `${at}.rules.${key}`);
    }
    if (thumbnail.rules.brandTokens !== undefined) {
      const tokens = thumbnail.rules.brandTokens;
      assertAllowedFields(tokens, new Set(Object.keys(tokens || {})), `${at}.rules.brandTokens`);
      for (const [id, value] of Object.entries(tokens)) {
        if (typeof value !== "string") throw new Error(`${at}.rules.brandTokens.${id} must be a string.`);
      }
    }
  }
  if (thumbnail.layouts !== undefined) {
    assertAllowedFields(thumbnail.layouts, new Set(Object.keys(thumbnail.layouts || {})), `${at}.layouts`);
    for (const [id, layout] of Object.entries(thumbnail.layouts)) assertAllowedFields(layout, THUMBNAIL_LAYOUT_FIELDS, `${at}.layouts.${id}`);
  }
  if (thumbnail.text !== undefined) {
    const text = thumbnail.text;
    assertAllowedFields(text, THUMBNAIL_TEXT_FIELDS, `${at}.text`);
    if (text.band !== undefined) assertAllowedFields(text.band, THUMBNAIL_BAND_FIELDS, `${at}.text.band`);
    if (text.speechBubble !== undefined) assertAllowedFields(text.speechBubble, THUMBNAIL_BUBBLE_FIELDS, `${at}.text.speechBubble`);
    if (text.telop !== undefined) assertAllowedFields(text.telop, THUMBNAIL_TELOP_FIELDS, `${at}.text.telop`);
    if (text.forbiddenTerms !== undefined) {
      if (!Array.isArray(text.forbiddenTerms)) throw new Error(`${at}.text.forbiddenTerms must be an array.`);
      text.forbiddenTerms.forEach((term, index) => assertAllowedFields(term, THUMBNAIL_TERM_FIELDS, `${at}.text.forbiddenTerms[${index}]`));
    }
  }
  if (thumbnail.approvedReferences !== undefined) {
    assertAllowedFields(thumbnail.approvedReferences, THUMBNAIL_REFERENCE_FIELDS, `${at}.approvedReferences`);
  }
}

function validateSourceConfigShape(source) {
  assertNoSensitiveFields(source);
  assertAllowedFields(source, TOP_LEVEL_FIELDS, "narrated-story.json");
  assertAllowedFields(source.runtime, RUNTIME_FIELDS, "narrated-story.json.runtime");
  assertAllowedFields(source.image, IMAGE_FIELDS, "narrated-story.json.image");
  if (source.image.source !== undefined && !IMAGE_SOURCES.has(source.image.source)) {
    throw new Error("narrated-story.json.image.source must be broker or operator-file.");
  }
  if (source.image.operatorFile !== undefined) {
    assertAllowedFields(source.image.operatorFile, IMAGE_OPERATOR_FILE_FIELDS, "narrated-story.json.image.operatorFile");
  }
  assertAllowedFields(source.voice, VOICE_FIELDS, "narrated-story.json.voice");
  if (source.music !== undefined) assertAllowedFields(source.music, MUSIC_FIELDS, "narrated-story.json.music");
  if (source.render !== undefined) assertAllowedFields(source.render, RENDER_FIELDS, "narrated-story.json.render");
  if (source.bookends !== undefined) {
    assertAllowedFields(source.bookends, BOOKEND_FIELDS, "narrated-story.json.bookends");
    const { opening, review, transitions } = source.bookends;
    if (opening !== undefined && opening !== null) assertAllowedFields(opening, BOOKEND_OPENING_FIELDS, "narrated-story.json.bookends.opening");
    if (review !== undefined && review !== null) {
      assertAllowedFields(review, BOOKEND_REVIEW_FIELDS, "narrated-story.json.bookends.review");
      if (review.presenter !== undefined && review.presenter !== null) {
        assertAllowedFields(review.presenter, BOOKEND_PRESENTER_FIELDS, "narrated-story.json.bookends.review.presenter");
      }
    }
    if (transitions !== undefined) {
      assertAllowedFields(transitions, BOOKEND_TRANSITIONS_FIELDS, "narrated-story.json.bookends.transitions");
      for (const [id, transition] of Object.entries(transitions)) {
        assertAllowedFields(transition, BOOKEND_TRANSITION_FIELDS, `narrated-story.json.bookends.transitions.${id}`);
      }
    }
  }
  if (source.qualityLoop !== undefined) assertAllowedFields(source.qualityLoop, QUALITY_LOOP_FIELDS, "narrated-story.json.qualityLoop");
  if (source.voiceQuality !== undefined) assertAllowedFields(source.voiceQuality, VOICE_QUALITY_FIELDS, "narrated-story.json.voiceQuality");
  if (source.musicPlan !== undefined) {
    assertAllowedFields(source.musicPlan, MUSIC_PLAN_FIELDS, "narrated-story.json.musicPlan");
    if (!Array.isArray(source.musicPlan.sections)) throw new Error("narrated-story.json.musicPlan.sections must be an array.");
    source.musicPlan.sections.forEach((section, index) => {
      assertAllowedFields(section, MUSIC_SECTION_FIELDS, `narrated-story.json.musicPlan.sections[${index}]`);
      assertAllowedFields(section.source, MUSIC_SOURCE_FIELDS, `narrated-story.json.musicPlan.sections[${index}].source`);
    });
  }
  if (source.cast !== undefined) {
    assertAllowedFields(source.cast, CAST_FIELDS, "narrated-story.json.cast");
    assertAllowedFields(source.cast.roles, new Set(Object.keys(source.cast.roles || {})), "narrated-story.json.cast.roles");
    for (const [roleId, role] of Object.entries(source.cast.roles)) {
      assertAllowedFields(role, CAST_ROLE_FIELDS, `narrated-story.json.cast.roles.${roleId}`);
    }
  }
  if (source.scriptIntake !== undefined) {
    assertAllowedFields(source.scriptIntake, SCRIPT_INTAKE_FIELDS, "narrated-story.json.scriptIntake");
    if (source.scriptIntake.markdown !== undefined) {
      assertAllowedFields(source.scriptIntake.markdown, SCRIPT_INTAKE_MARKDOWN_FIELDS, "narrated-story.json.scriptIntake.markdown");
    }
  }
  if (source.subtitles !== undefined) {
    assertAllowedFields(source.subtitles, SUBTITLE_FIELDS, "narrated-story.json.subtitles");
    if (source.subtitles.outline !== undefined) assertAllowedFields(source.subtitles.outline, SUBTITLE_OUTLINE_FIELDS, "narrated-story.json.subtitles.outline");
    if (source.subtitles.band !== undefined) assertAllowedFields(source.subtitles.band, SUBTITLE_BAND_FIELDS, "narrated-story.json.subtitles.band");
    if (source.subtitles.position !== undefined) assertAllowedFields(source.subtitles.position, SUBTITLE_POSITION_FIELDS, "narrated-story.json.subtitles.position");
  }
  if (source.blockers !== undefined) {
    if (!Array.isArray(source.blockers)) throw new Error("narrated-story.json.blockers must be an array.");
    source.blockers.forEach((entry, index) => assertAllowedFields(entry, BLOCKER_FIELDS, `narrated-story.json.blockers[${index}]`));
  }
  if (source.thumbnail !== undefined) validateThumbnailShape(source.thumbnail);
}

async function readNarratedConfigFile(configPath) {
  const info = await lstat(configPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0 || info.size > MAX_CONFIG_BYTES) {
    throw new Error(`${NARRATED_RUNTIME_CONFIG_PATH} must be a non-empty regular file no larger than ${MAX_CONFIG_BYTES} bytes.`);
  }
  const bytes = await readFile(configPath);
  let source;
  try { source = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error(`${NARRATED_RUNTIME_CONFIG_PATH} is not valid JSON.`); }
  validateSourceConfigShape(source);
  return { bytes, source };
}

/**
 * Extract only the provider identity needed by doctor from the signed payload.
 * Prompts, voice IDs, arbitrary JSON and secrets never enter the durable Job.
 */
export async function extractNarratedChannelPackRuntime({ payloadDir, evidence } = {}) {
  const payloadSha256 = String(evidence?.payloadSha256 || "");
  if (!SHA256.test(payloadSha256)) throw new Error("Signed payload SHA-256 is required for runtime metadata binding.");
  if (evidence?.harnessId !== "narrated-story-video") throw new Error("Runtime metadata harness does not match the signed envelope.");
  const configPath = join(resolve(String(payloadDir || "")), NARRATED_RUNTIME_CONFIG_PATH);
  const { bytes, source } = await readNarratedConfigFile(configPath);
  const image = adapterMetadata(source.image, "image", "image.generation");
  const tts = adapterMetadata(source.voice, "voice", "voice.synthesis");
  const music = adapterMetadata(source.music, "music", "music.generation");
  const declaredImageModel = boundedString(source.runtime.imageModel, "runtime.imageModel");
  const declaredTtsProvider = boundedString(source.runtime.ttsProvider, "runtime.ttsProvider", 64).toLowerCase();
  if (declaredImageModel !== image.model) throw new Error("runtime.imageModel must equal image.model in the signed Channel Pack.");
  if (declaredTtsProvider !== tts.provider) throw new Error("runtime.ttsProvider must equal voice.provider in the signed Channel Pack.");
  return validateChannelPackRuntime({
    version: CHANNEL_PACK_RUNTIME_VERSION,
    harnessId: "narrated-story-video",
    payloadSha256,
    configSha256: createHash("sha256").update(bytes).digest("hex"),
    imageModel: declaredImageModel,
    ttsProvider: declaredTtsProvider,
    imageProvider: image.provider,
    imageAdapterVersion: image.adapterVersion,
    ttsModel: tts.model,
    ttsAdapterVersion: tts.adapterVersion,
    musicProvider: music.provider,
    musicModel: music.model,
    musicAdapterVersion: music.adapterVersion,
    // 運営者の画を取り込む Pack だけが持つ（broker の Pack の記録は従来と同じ形のまま）。Job と
    // RunReceipt の channelPackRuntimeIdentity に「画は有料の Media Job ではない」ことが残る。
    ...(source.image.source === "operator-file" ? { imageSource: "operator-file" } : {}),
  }, { harnessId: "narrated-story-video", payloadSha256 });
}

/**
 * ナレーション物語の Channel Pack の thumbnail 節を読む（任意の節。無ければ thumbnail は null）。
 * 署名済みの payload（payloadDir）か、署名の無い設定ファイル（configPath。手元の試行用）のどちらか。
 * narrated-story.json 全体の形の検査（秘密の欄・未知の欄の拒否）を runtime と同じく通してから返す。
 * 中身（行数・字数・配置・承認済みの参照）の検査と決まりへの写しは lib/thumbnailPlan.mjs が行う。
 * 戻り値: { thumbnail, configSha256, configPath }
 */
export async function readNarratedThumbnailSection({ payloadDir = "", configPath = "" } = {}) {
  if (Boolean(String(payloadDir || "").trim()) === Boolean(String(configPath || "").trim())) {
    throw new Error("readNarratedThumbnailSection needs exactly one of payloadDir or configPath.");
  }
  const file = String(configPath || "").trim()
    ? resolve(String(configPath))
    : join(resolve(String(payloadDir)), NARRATED_RUNTIME_CONFIG_PATH);
  const { bytes, source } = await readNarratedConfigFile(file);
  return {
    thumbnail: source.thumbnail === undefined ? null : source.thumbnail,
    configSha256: createHash("sha256").update(bytes).digest("hex"),
    configPath: file,
  };
}

/** Revalidate durable metadata before doctor trusts it. Returns an allowlisted copy. */
export function validateChannelPackRuntime(value, { harnessId, payloadSha256 } = {}) {
  assertNoSensitiveFields(value);
  assertAllowedFields(value, new Set([
    "version", "harnessId", "payloadSha256", "configSha256",
    "imageModel", "ttsProvider", "imageProvider", "imageAdapterVersion", "ttsModel", "ttsAdapterVersion",
    "musicProvider", "musicModel", "musicAdapterVersion", "imageSource",
  ]), "channelPackRuntime");
  if (value.imageSource !== undefined && value.imageSource !== "operator-file") {
    throw new Error("Channel Pack runtime imageSource must be operator-file when present.");
  }
  if (value.version !== CHANNEL_PACK_RUNTIME_VERSION) throw new Error("Channel Pack runtime metadata version is unsupported.");
  if (!harnessId || value.harnessId !== harnessId) throw new Error("Channel Pack runtime metadata harness does not match the Job.");
  if (!SHA256.test(String(value.payloadSha256 || "")) || value.payloadSha256 !== payloadSha256) {
    throw new Error("Channel Pack runtime metadata is not bound to the verified payload SHA-256.");
  }
  if (!SHA256.test(String(value.configSha256 || ""))) throw new Error("Channel Pack runtime config identity is invalid.");
  const image = adapterMetadata({
    provider: value.imageProvider,
    model: value.imageModel,
    adapterVersion: value.imageAdapterVersion,
  }, "channelPackRuntime.image", "image.generation");
  const tts = adapterMetadata({
    provider: value.ttsProvider,
    model: value.ttsModel,
    adapterVersion: value.ttsAdapterVersion,
  }, "channelPackRuntime.tts", "voice.synthesis");
  const music = adapterMetadata({
    provider: value.musicProvider,
    model: value.musicModel,
    adapterVersion: value.musicAdapterVersion,
  }, "channelPackRuntime.music", "music.generation");
  return {
    version: CHANNEL_PACK_RUNTIME_VERSION,
    harnessId,
    payloadSha256,
    configSha256: value.configSha256,
    imageModel: image.model,
    ttsProvider: tts.provider,
    imageProvider: image.provider,
    imageAdapterVersion: image.adapterVersion,
    ttsModel: tts.model,
    ttsAdapterVersion: tts.adapterVersion,
    musicProvider: music.provider,
    musicModel: music.model,
    musicAdapterVersion: music.adapterVersion,
    ...(value.imageSource === "operator-file" ? { imageSource: "operator-file" } : {}),
  };
}

export function channelPackRuntimeAdapterSpecs(value, binding = {}) {
  const runtime = validateChannelPackRuntime(value, binding);
  return {
    image: {
      kind: "image.generation",
      provider: runtime.imageProvider,
      model: runtime.imageModel,
      adapterVersion: runtime.imageAdapterVersion,
    },
    tts: {
      kind: "voice.synthesis",
      provider: runtime.ttsProvider,
      model: runtime.ttsModel,
      adapterVersion: runtime.ttsAdapterVersion,
    },
    music: {
      kind: "music.generation",
      provider: runtime.musicProvider,
      model: runtime.musicModel,
      adapterVersion: runtime.musicAdapterVersion,
    },
  };
}
