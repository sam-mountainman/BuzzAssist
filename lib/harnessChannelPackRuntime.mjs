import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

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
]);
const RUNTIME_FIELDS = new Set(["imageModel", "ttsProvider"]);
const IMAGE_FIELDS = new Set(["provider", "model", "adapterVersion", "stylePrompt"]);
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

function validateSourceConfigShape(source) {
  assertNoSensitiveFields(source);
  assertAllowedFields(source, TOP_LEVEL_FIELDS, "narrated-story.json");
  assertAllowedFields(source.runtime, RUNTIME_FIELDS, "narrated-story.json.runtime");
  assertAllowedFields(source.image, IMAGE_FIELDS, "narrated-story.json.image");
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
  if (source.scriptIntake !== undefined) {
    assertAllowedFields(source.scriptIntake, SCRIPT_INTAKE_FIELDS, "narrated-story.json.scriptIntake");
    if (source.scriptIntake.markdown !== undefined) {
      assertAllowedFields(source.scriptIntake.markdown, SCRIPT_INTAKE_MARKDOWN_FIELDS, "narrated-story.json.scriptIntake.markdown");
    }
  }
  if (source.blockers !== undefined) {
    if (!Array.isArray(source.blockers)) throw new Error("narrated-story.json.blockers must be an array.");
    source.blockers.forEach((entry, index) => assertAllowedFields(entry, BLOCKER_FIELDS, `narrated-story.json.blockers[${index}]`));
  }
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
  const info = await lstat(configPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0 || info.size > MAX_CONFIG_BYTES) {
    throw new Error(`${NARRATED_RUNTIME_CONFIG_PATH} must be a non-empty regular file no larger than ${MAX_CONFIG_BYTES} bytes.`);
  }
  const bytes = await readFile(configPath);
  let source;
  try { source = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error(`${NARRATED_RUNTIME_CONFIG_PATH} is not valid JSON.`); }
  validateSourceConfigShape(source);
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
  }, { harnessId: "narrated-story-video", payloadSha256 });
}

/** Revalidate durable metadata before doctor trusts it. Returns an allowlisted copy. */
export function validateChannelPackRuntime(value, { harnessId, payloadSha256 } = {}) {
  assertNoSensitiveFields(value);
  assertAllowedFields(value, new Set([
    "version", "harnessId", "payloadSha256", "configSha256",
    "imageModel", "ttsProvider", "imageProvider", "imageAdapterVersion", "ttsModel", "ttsAdapterVersion",
    "musicProvider", "musicModel", "musicAdapterVersion",
  ]), "channelPackRuntime");
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
