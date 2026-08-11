import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
  ASSETS_ROUTE,
  resolveCanvasDir,
  sanitizeFileName,
  writeJsonAtomic,
} from "./canvasScene.mjs";

export const DEFAULT_SPEECH_MODEL = "eleven_v3";
export const DEFAULT_SPEECH_OUTPUT_FORMAT = "mp3_44100_128";
export const SPEECH_MODELS = [
  {
    id: "eleven_v3",
    label: "Eleven v3",
    provider: "elevenlabs",
    note: "表現力重視・日本語対応",
  },
  {
    id: "eleven_multilingual_v2",
    label: "Eleven Multilingual v2",
    provider: "elevenlabs",
    note: "長文の安定性重視",
  },
  {
    id: "eleven_flash_v2_5",
    label: "Eleven Flash v2.5",
    provider: "elevenlabs",
    note: "速度・コスト重視",
  },
];

const ELEVENLABS_API_BASE = "https://api.elevenlabs.io";
const ELEVENLABS_CONFIG_FILE_NAME = "elevenlabs.json";
const MAX_SPEECH_TEXT_LENGTH = 40_000;

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function finiteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, minimum, maximum, fallback) {
  return Math.min(maximum, Math.max(minimum, finiteNumber(value, fallback)));
}

function slug(value, fallback = "speech") {
  const normalized = nonEmptyString(value)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return normalized || fallback;
}

function headersToObject(headers) {
  if (!headers || typeof headers.get !== "function") return {};
  return {
    requestId: nonEmptyString(headers.get("request-id") || headers.get("x-request-id")),
    characterCost: finiteNumber(headers.get("character-cost"), null),
  };
}

export function resolveElevenLabsConfigPath() {
  const configured = nonEmptyString(process.env.BUZZASSIST_ELEVENLABS_CONFIG);
  return configured ? resolve(configured) : join(os.homedir(), ".buzzassist", ELEVENLABS_CONFIG_FILE_NAME);
}

export async function loadElevenLabsConfig() {
  try {
    const parsed = JSON.parse(await readFile(resolveElevenLabsConfigPath(), "utf8"));
    return {
      apiKey: nonEmptyString(parsed?.apiKey ?? parsed?.api_key),
      defaultVoiceId: nonEmptyString(parsed?.defaultVoiceId ?? parsed?.default_voice_id),
      defaultVoiceName: nonEmptyString(parsed?.defaultVoiceName ?? parsed?.default_voice_name),
      savedAt: nonEmptyString(parsed?.savedAt),
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { apiKey: "", defaultVoiceId: "", defaultVoiceName: "", savedAt: "" };
    throw error;
  }
}

async function writeConfigAtomic(payload) {
  const filePath = resolveElevenLabsConfigPath();
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, filePath);
  return filePath;
}

export async function saveElevenLabsConfig(input = {}) {
  const current = await loadElevenLabsConfig();
  const apiKey = input.apiKey === undefined ? current.apiKey : nonEmptyString(input.apiKey);
  const defaultVoiceId = input.defaultVoiceId === undefined
    ? current.defaultVoiceId
    : nonEmptyString(input.defaultVoiceId);
  const defaultVoiceName = input.defaultVoiceName === undefined
    ? current.defaultVoiceName
    : nonEmptyString(input.defaultVoiceName);
  const savedAt = new Date().toISOString();
  const filePath = await writeConfigAtomic({ apiKey, defaultVoiceId, defaultVoiceName, savedAt });
  return { configured: Boolean(apiKey), defaultVoiceId, defaultVoiceName, savedAt, filePath };
}

export async function getElevenLabsStatus() {
  const config = await loadElevenLabsConfig();
  const envKey = nonEmptyString(process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY);
  return {
    configured: Boolean(envKey || config.apiKey),
    source: envKey ? "env" : config.apiKey ? "file" : null,
    configFile: envKey ? null : resolveElevenLabsConfigPath(),
    defaultVoiceId: config.defaultVoiceId,
    defaultVoiceName: config.defaultVoiceName,
    defaultModel: DEFAULT_SPEECH_MODEL,
    models: SPEECH_MODELS,
  };
}

export async function requireElevenLabsApiKey(input = {}) {
  const direct = nonEmptyString(input.apiKey);
  if (direct) return direct;
  const envKey = nonEmptyString(process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY);
  if (envKey) return envKey;
  const stored = await loadElevenLabsConfig();
  if (stored.apiKey) return stored.apiKey;
  throw new Error(
    "ElevenLabs APIキーが未設定です。音声ジェネレーターの設定から保存するか、ELEVENLABS_API_KEYを設定してください。",
  );
}

async function readJsonResponse(response, label) {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload?.detail?.message || payload?.detail || payload?.message || response.statusText;
    throw new Error(`${label} failed (${response.status}): ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  }
  return payload;
}

function normalizedElevenLabsVoice(voice = {}, options = {}) {
  const labels = voice.labels && typeof voice.labels === "object" ? voice.labels : {};
  const verifiedLanguages = Array.isArray(voice.verified_languages)
    ? voice.verified_languages
    : Array.isArray(voice.verifiedLanguages)
      ? voice.verifiedLanguages
      : [];
  return {
    id: nonEmptyString(voice.voice_id ?? voice.id),
    name: nonEmptyString(voice.name) || nonEmptyString(voice.voice_id ?? voice.id),
    category: nonEmptyString(voice.category),
    description: nonEmptyString(voice.description),
    previewUrl: nonEmptyString(voice.preview_url ?? voice.previewUrl),
    labels,
    verifiedLanguages,
    settings: voice.settings && typeof voice.settings === "object" ? voice.settings : null,
    source: nonEmptyString(options.source) || "account",
    available: options.available !== false,
    publicOwnerId: nonEmptyString(voice.public_owner_id ?? voice.publicOwnerId),
    language: nonEmptyString(voice.language ?? labels.language),
    locale: nonEmptyString(voice.locale ?? labels.locale),
    accent: nonEmptyString(voice.accent ?? labels.accent),
    gender: nonEmptyString(voice.gender ?? labels.gender),
    age: nonEmptyString(voice.age ?? labels.age),
    descriptive: nonEmptyString(voice.descriptive ?? labels.descriptive),
    useCase: nonEmptyString(voice.use_case ?? voice.useCase ?? labels.use_case),
    freeUsersAllowed: voice.free_users_allowed === true,
    featured: voice.featured === true,
    liveModerationEnabled: voice.live_moderation_enabled === true,
    rate: finiteNumber(voice.rate, null),
    clonedByCount: finiteNumber(voice.cloned_by_count ?? voice.clonedByCount, null),
    usageCharacterCount1y: finiteNumber(voice.usage_character_count_1y ?? voice.usageCharacterCount1y, null),
    usageCharacterCount7d: finiteNumber(voice.usage_character_count_7d ?? voice.usageCharacterCount7d, null),
    noticePeriodDays: finiteNumber(voice.notice_period ?? voice.notice_period_days ?? voice.noticePeriodDays, null),
  };
}

export async function listElevenLabsVoices(input = {}) {
  const fetchImpl = input.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch is not available in this runtime.");
  const apiKey = await requireElevenLabsApiKey(input);
  const url = new URL(`${ELEVENLABS_API_BASE}/v2/voices`);
  url.searchParams.set("page_size", String(Math.min(100, Math.max(1, Math.round(finiteNumber(input.pageSize, 100))))));
  const voiceType = nonEmptyString(input.voiceType);
  if (voiceType !== "all") url.searchParams.set("voice_type", voiceType || "default");
  url.searchParams.set("include_total_count", "true");
  const nextPageToken = nonEmptyString(input.nextPageToken ?? input.next_page_token);
  if (nextPageToken) url.searchParams.set("next_page_token", nextPageToken);
  if (nonEmptyString(input.search)) url.searchParams.set("search", input.search.trim());
  const response = await fetchImpl(url, { headers: { "xi-api-key": apiKey } });
  const payload = await readJsonResponse(response, "ElevenLabs voice list");
  const voices = (Array.isArray(payload?.voices) ? payload.voices : [])
    .map((voice) => normalizedElevenLabsVoice(voice, { source: "account", available: true }))
    .filter((voice) => voice.id);
  return {
    voices,
    hasMore: Boolean(payload?.has_more),
    totalCount: finiteNumber(payload?.total_count, voices.length),
    nextPageToken: nonEmptyString(payload?.next_page_token),
  };
}

function voiceHasJapaneseMetadata(voice = {}) {
  const values = [
    voice.language,
    voice.locale,
    voice.labels?.language,
    voice.labels?.locale,
    voice.name,
    voice.description,
  ].map((value) => String(value ?? "").normalize("NFKC").toLowerCase());
  return values.some((value) => value === "ja" || value.startsWith("ja-") || value.includes("japanese") || value.includes("日本語") || value.includes("日本人"))
    || (Array.isArray(voice.verifiedLanguages) ? voice.verifiedLanguages : []).some((entry) => {
      const language = String(entry?.language ?? "").toLowerCase();
      const locale = String(entry?.locale ?? "").toLowerCase();
      return language === "ja" || locale.startsWith("ja");
    });
}

// Fetch every voice that is actually usable by the current ElevenLabs
// workspace. Unlike listElevenLabsVoices(), this intentionally omits the
// voice_type=default filter and follows next_page_token until exhaustion.
export async function listAllElevenLabsVoices(input = {}) {
  const voices = [];
  const seen = new Set();
  let nextPageToken = "";
  let pageCount = 0;
  const maxPages = Math.max(1, Math.min(100, Math.round(finiteNumber(input.maxPages, 100))));
  do {
    const page = await listElevenLabsVoices({
      ...input,
      voiceType: "all",
      pageSize: 100,
      nextPageToken,
    });
    for (const voice of page.voices) {
      if (seen.has(voice.id)) continue;
      seen.add(voice.id);
      voices.push(voice);
    }
    pageCount += 1;
    nextPageToken = page.hasMore ? page.nextPageToken : "";
  } while (nextPageToken && pageCount < maxPages);
  const filtered = input.japaneseOnly === true ? voices.filter(voiceHasJapaneseMetadata) : voices;
  return {
    voices: filtered,
    totalCount: filtered.length,
    unfilteredTotalCount: voices.length,
    pageCount,
    hasMore: Boolean(nextPageToken),
    nextPageToken,
    scope: "all-account-voices",
    japaneseOnly: input.japaneseOnly === true,
  };
}

export async function listElevenLabsSharedVoices(input = {}) {
  const fetchImpl = input.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch is not available in this runtime.");
  const apiKey = await requireElevenLabsApiKey(input);
  const pageSize = Math.min(100, Math.max(1, Math.round(finiteNumber(input.pageSize, 100))));
  const maxPages = Math.max(1, Math.min(100, Math.round(finiteNumber(input.maxPages, 100))));
  const voices = [];
  const seen = new Set();
  let page = Math.max(0, Math.round(finiteNumber(input.page, 0)));
  let hasMore = false;
  let pagesFetched = 0;
  do {
    const url = new URL(`${ELEVENLABS_API_BASE}/v1/shared-voices`);
    url.searchParams.set("page_size", String(pageSize));
    url.searchParams.set("page", String(page));
    url.searchParams.set("language", nonEmptyString(input.language) || "ja");
    if (nonEmptyString(input.search)) url.searchParams.set("search", input.search.trim());
    if (nonEmptyString(input.gender)) url.searchParams.set("gender", input.gender.trim());
    if (nonEmptyString(input.age)) url.searchParams.set("age", input.age.trim());
    if (nonEmptyString(input.accent)) url.searchParams.set("accent", input.accent.trim());
    if (nonEmptyString(input.locale)) url.searchParams.set("locale", input.locale.trim());
    if (nonEmptyString(input.category)) url.searchParams.set("category", input.category.trim());
    for (const useCase of Array.isArray(input.useCases) ? input.useCases : []) {
      if (nonEmptyString(useCase)) url.searchParams.append("use_cases", useCase.trim());
    }
    for (const descriptive of Array.isArray(input.descriptives) ? input.descriptives : []) {
      if (nonEmptyString(descriptive)) url.searchParams.append("descriptives", descriptive.trim());
    }
    if (input.featured === true) url.searchParams.set("featured", "true");
    if (input.minNoticePeriodDays !== undefined) {
      url.searchParams.set("min_notice_period_days", String(Math.max(0, Math.round(finiteNumber(input.minNoticePeriodDays, 0)))));
    }
    if (input.includeCustomRates !== undefined) {
      url.searchParams.set("include_custom_rates", input.includeCustomRates === true ? "true" : "false");
    }
    if (input.includeLiveModerated !== undefined) {
      url.searchParams.set("include_live_moderated", input.includeLiveModerated === true ? "true" : "false");
    }
    const sort = nonEmptyString(input.sort);
    if (sort) url.searchParams.set("sort", sort);
    const response = await fetchImpl(url, { headers: { "xi-api-key": apiKey } });
    const payload = await readJsonResponse(response, "ElevenLabs shared voice list");
    for (const item of Array.isArray(payload?.voices) ? payload.voices : []) {
      const voice = normalizedElevenLabsVoice(item, { source: "shared-library", available: false });
      if (!voice.id || seen.has(voice.id)) continue;
      seen.add(voice.id);
      voices.push(voice);
    }
    hasMore = Boolean(payload?.has_more);
    page += 1;
    pagesFetched += 1;
  } while (hasMore && pagesFetched < maxPages);
  return {
    voices,
    totalCount: voices.length,
    pageCount: pagesFetched,
    hasMore,
    nextPage: hasMore ? page : null,
    scope: "shared-library",
    language: nonEmptyString(input.language) || "ja",
  };
}

export async function addElevenLabsSharedVoice(input = {}) {
  if (input.confirmedSettings !== true && input.confirmedVoiceAdd !== true) {
    throw new Error("共有音声をMy Voicesへ追加するには confirmedSettings=true が必要です。");
  }
  const fetchImpl = input.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch is not available in this runtime.");
  const apiKey = await requireElevenLabsApiKey(input);
  const voiceId = nonEmptyString(input.voiceId ?? input.voice_id);
  const publicOwnerId = nonEmptyString(input.publicOwnerId ?? input.public_owner_id ?? input.publicUserId);
  const requestedName = nonEmptyString(input.newName ?? input.new_name);
  if (!voiceId) throw new Error("共有音声の voiceId が必要です。");
  if (!publicOwnerId) throw new Error("共有音声の publicOwnerId が必要です。");
  if (!requestedName) throw new Error("My Voicesで使用する newName が必要です。");
  const newName = requestedName.slice(0, 40);

  if (input.skipExistingCheck !== true) {
    const account = await listAllElevenLabsVoices({ ...input, japaneseOnly: false });
    const existing = account.voices.find((voice) => voice.id === voiceId);
    if (existing) {
      return {
        added: false,
        alreadyAvailable: true,
        voiceId,
        name: existing.name,
        source: "account",
      };
    }
  }

  const url = `${ELEVENLABS_API_BASE}/v1/voices/add/${encodeURIComponent(publicOwnerId)}/${encodeURIComponent(voiceId)}`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", "xi-api-key": apiKey },
    body: JSON.stringify({ new_name: newName, bookmarked: input.bookmarked !== false }),
  });
  const payload = await readJsonResponse(response, "ElevenLabs add shared voice");
  return {
    added: true,
    alreadyAvailable: false,
    voiceId: nonEmptyString(payload?.voice_id) || voiceId,
    name: newName,
    source: "shared-library",
  };
}

export function normalizeSpeechAlignment(value) {
  const source = value && typeof value === "object" ? value : {};
  const characters = Array.isArray(source.characters) ? source.characters.map((item) => String(item ?? "")) : [];
  const starts = Array.isArray(source.character_start_times_seconds)
    ? source.character_start_times_seconds.map((item) => Math.max(0, finiteNumber(item, 0)))
    : [];
  const ends = Array.isArray(source.character_end_times_seconds)
    ? source.character_end_times_seconds.map((item) => Math.max(0, finiteNumber(item, 0)))
    : [];
  const count = Math.min(characters.length, starts.length, ends.length);
  return {
    characters: characters.slice(0, count),
    characterStartTimesSeconds: starts.slice(0, count),
    characterEndTimesSeconds: ends.slice(0, count),
  };
}

export function speechBoundsFromAlignment(alignment, fallbackDuration = 0) {
  const normalized = normalizeSpeechAlignment({
    characters: alignment?.characters,
    character_start_times_seconds: alignment?.characterStartTimesSeconds,
    character_end_times_seconds: alignment?.characterEndTimesSeconds,
  });
  const voicedIndexes = normalized.characters
    .map((character, index) => (/\s/u.test(character) ? -1 : index))
    .filter((index) => index >= 0);
  if (voicedIndexes.length === 0) {
    return { startSeconds: 0, endSeconds: Math.max(0, finiteNumber(fallbackDuration, 0)) };
  }
  const first = voicedIndexes[0];
  const last = voicedIndexes.at(-1);
  return {
    startSeconds: normalized.characterStartTimesSeconds[first] ?? 0,
    endSeconds: normalized.characterEndTimesSeconds[last] ?? Math.max(0, finiteNumber(fallbackDuration, 0)),
  };
}

export async function generateElevenLabsSpeech(input = {}) {
  const fetchImpl = input.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch is not available in this runtime.");
  const text = nonEmptyString(input.text);
  if (!text) throw new Error("Speech text is required.");
  if (text.length > MAX_SPEECH_TEXT_LENGTH) throw new Error(`Speech text exceeds ${MAX_SPEECH_TEXT_LENGTH} characters.`);
  const config = await loadElevenLabsConfig();
  const voiceId = nonEmptyString(input.voiceId ?? input.voice_id) || config.defaultVoiceId;
  if (!voiceId) throw new Error("ElevenLabs voiceId is required. Choose a voice in the voice generator first.");
  const model = nonEmptyString(input.model ?? input.modelId ?? input.model_id) || DEFAULT_SPEECH_MODEL;
  if (!SPEECH_MODELS.some((candidate) => candidate.id === model)) {
    throw new Error(`Unsupported speech model: ${model}.`);
  }
  const apiKey = await requireElevenLabsApiKey(input);
  const outputFormat = nonEmptyString(input.outputFormat ?? input.output_format) || DEFAULT_SPEECH_OUTPUT_FORMAT;
  const url = new URL(`${ELEVENLABS_API_BASE}/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps`);
  url.searchParams.set("output_format", outputFormat);
  url.searchParams.set("enable_logging", input.enableLogging === false ? "false" : "true");
  const requestBody = {
    text,
    model_id: model,
    language_code: nonEmptyString(input.languageCode ?? input.language_code) || "ja",
    voice_settings: {
      stability: clamp(input.stability, 0, 1, 0.5),
      similarity_boost: clamp(input.similarityBoost ?? input.similarity_boost, 0, 1, 0.75),
      speed: clamp(input.speed, 0.7, 1.2, 1),
      use_speaker_boost: input.useSpeakerBoost !== false && input.use_speaker_boost !== false,
    },
  };
  if (model !== "eleven_v3") {
    requestBody.apply_text_normalization = nonEmptyString(
      input.applyTextNormalization ?? input.apply_text_normalization,
    ) || "on";
    requestBody.apply_language_text_normalization =
      input.applyLanguageTextNormalization !== false
      && input.apply_language_text_normalization !== false;
  }
  const previousText = nonEmptyString(input.previousText ?? input.previous_text);
  const nextText = nonEmptyString(input.nextText ?? input.next_text);
  // Eleven v3 currently rejects previous_text/next_text, but accepts request
  // IDs from neighboring clips for continuity-aware regeneration.
  if (model !== "eleven_v3" && previousText) requestBody.previous_text = previousText;
  if (model !== "eleven_v3" && nextText) requestBody.next_text = nextText;
  const previousRequestIds = (Array.isArray(input.previousRequestIds ?? input.previous_request_ids)
    ? (input.previousRequestIds ?? input.previous_request_ids)
    : [])
    .map((value) => nonEmptyString(value))
    .filter(Boolean)
    .slice(-3);
  const nextRequestIds = (Array.isArray(input.nextRequestIds ?? input.next_request_ids)
    ? (input.nextRequestIds ?? input.next_request_ids)
    : [])
    .map((value) => nonEmptyString(value))
    .filter(Boolean)
    .slice(0, 3);
  if (model !== "eleven_v3" && previousRequestIds.length > 0) requestBody.previous_request_ids = previousRequestIds;
  if (model !== "eleven_v3" && nextRequestIds.length > 0) requestBody.next_request_ids = nextRequestIds;
  const startedAt = Date.now();
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", "xi-api-key": apiKey },
    body: JSON.stringify(requestBody),
  });
  const responseHeaders = headersToObject(response.headers);
  const payload = await readJsonResponse(response, "ElevenLabs speech generation");
  const audioBase64 = nonEmptyString(payload?.audio_base64);
  if (!audioBase64) throw new Error("ElevenLabs speech generation returned no audio.");
  const audioBuffer = Buffer.from(audioBase64, "base64");
  if (audioBuffer.length === 0) throw new Error("ElevenLabs speech generation returned empty audio.");
  const alignment = normalizeSpeechAlignment(payload?.normalized_alignment || payload?.alignment);
  const rawAlignment = normalizeSpeechAlignment(payload?.alignment);
  const durationSeconds = Math.max(
    0,
    alignment.characterEndTimesSeconds.at(-1) || rawAlignment.characterEndTimesSeconds.at(-1) || 0,
  );
  const speechBounds = speechBoundsFromAlignment(alignment, durationSeconds);
  return {
    provider: "elevenlabs",
    model,
    voiceId,
    text,
    mimeType: outputFormat.startsWith("mp3") ? "audio/mpeg" : "audio/wav",
    outputFormat,
    audioBuffer,
    alignment,
    rawAlignment,
    durationSeconds,
    speechStartSeconds: speechBounds.startSeconds,
    speechEndSeconds: speechBounds.endSeconds,
    elapsedMs: Date.now() - startedAt,
    requestId: responseHeaders.requestId,
    characterCost: responseHeaders.characterCost,
    characterCount: [...text].length,
  };
}

export async function writeSpeechAsset(input = {}) {
  const generated = input.generated || await generateElevenLabsSpeech(input);
  const canvasDir = resolveCanvasDir(input);
  const assetsDir = join(canvasDir, "assets", "audio");
  const alignmentsDir = join(canvasDir, "audio-alignments");
  const utteranceId = slug(input.utteranceId ?? input.id, "speech");
  const requestedName = sanitizeFileName(
    input.fileName || `${utteranceId}-${generated.model}.mp3`,
    `${utteranceId}.mp3`,
  );
  const fileName = /\.(?:mp3|wav)$/i.test(requestedName) ? requestedName : `${requestedName}.mp3`;
  const filePath = join(assetsDir, fileName);
  const alignmentFileName = `${fileName}.json`;
  const alignmentPath = join(alignmentsDir, alignmentFileName);
  const createdAt = new Date().toISOString();
  const providerText = nonEmptyString(generated.text);
  const speechText = nonEmptyString(input.speechText ?? input.spokenText) || providerText;
  const displayText = nonEmptyString(input.displayText) || speechText;
  const performancePrompt = nonEmptyString(input.performancePrompt ?? input.performance_prompt);
  const sidecar = {
    version: 3,
    inputHash: nonEmptyString(input.inputHash ?? input.input_hash),
    utteranceId: nonEmptyString(input.utteranceId ?? input.id) || utteranceId,
    provider: generated.provider,
    model: generated.model,
    voiceId: generated.voiceId,
    voiceName: nonEmptyString(input.voiceName),
    // `text` remains the display string for backwards compatibility.  The
    // spoken string may intentionally use kana aliases to prevent Japanese
    // proper-name and compound-word misreadings.
    text: displayText,
    displayText,
    speechText,
    providerText,
    performancePrompt,
    durationSeconds: generated.durationSeconds,
    speechStartSeconds: generated.speechStartSeconds,
    speechEndSeconds: generated.speechEndSeconds,
    characterCount: generated.characterCount,
    characterCost: generated.characterCost,
    elapsedMs: generated.elapsedMs,
    requestId: generated.requestId,
    outputFormat: generated.outputFormat,
    alignment: generated.alignment,
    rawAlignment: generated.rawAlignment,
    createdAt,
  };
  await mkdir(assetsDir, { recursive: true });
  await writeFile(filePath, generated.audioBuffer);
  await writeJsonAtomic(alignmentPath, sidecar);
  return {
    ...sidecar,
    fileName,
    filePath,
    assetUrl: `${ASSETS_ROUTE}audio/${encodeURIComponent(fileName)}`,
    alignmentFileName,
    alignmentPath,
    mimeType: generated.mimeType,
  };
}

export function speechAssetPublicResult(result = {}) {
  return {
    inputHash: result.inputHash,
    utteranceId: result.utteranceId,
    provider: result.provider,
    model: result.model,
    voiceId: result.voiceId,
    voiceName: result.voiceName,
    text: result.text,
    displayText: result.displayText || result.text,
    speechText: result.speechText || result.text,
    providerText: result.providerText || result.speechText || result.text,
    performancePrompt: result.performancePrompt || "",
    durationSeconds: result.durationSeconds,
    speechStartSeconds: result.speechStartSeconds,
    speechEndSeconds: result.speechEndSeconds,
    characterCount: result.characterCount,
    characterCost: result.characterCost,
    elapsedMs: result.elapsedMs,
    requestId: result.requestId,
    fileName: result.fileName,
    filePath: result.filePath,
    assetUrl: result.assetUrl,
    alignmentFileName: result.alignmentFileName,
    alignmentPath: result.alignmentPath,
    mimeType: result.mimeType,
  };
}

export function voiceProfileFromElevenLabsVoice(voice = {}, options = {}) {
  const providerVoiceId = nonEmptyString(voice.id ?? voice.voice_id);
  if (!providerVoiceId) throw new Error("ElevenLabs voice id is required.");
  return {
    id: nonEmptyString(options.id) || `elevenlabs-${slug(voice.name || providerVoiceId, "voice")}`,
    name: nonEmptyString(options.name) || nonEmptyString(voice.name) || providerVoiceId,
    provider: "elevenlabs",
    providerVoiceId,
    elevenLabsVoiceId: providerVoiceId,
    modelId: nonEmptyString(options.modelId) || DEFAULT_SPEECH_MODEL,
    role: nonEmptyString(options.role) || "narration",
    previewUrl: nonEmptyString(voice.previewUrl ?? voice.preview_url),
    settings: {
      stability: clamp(options.stability, 0, 1, 0.5),
      similarityBoost: clamp(options.similarityBoost, 0, 1, 0.75),
      speed: clamp(options.speed, 0.7, 1.2, 1),
      useSpeakerBoost: options.useSpeakerBoost !== false,
    },
  };
}

export function audioAssetFromSpeechResult(result = {}) {
  return {
    id: `audio-${slug(result.utteranceId || basename(result.fileName || "speech"), "speech")}`,
    kind: "audio",
    name: result.fileName,
    mimeType: result.mimeType || "audio/mpeg",
    path: result.filePath,
    url: result.assetUrl,
    duration: finiteNumber(result.durationSeconds, 0),
    text: result.text,
    model: result.model,
    voiceId: result.voiceId,
  };
}
