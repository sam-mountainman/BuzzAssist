// BuzzAssist の音声基盤（/api/voice/*）クライアント。
// 方針: ElevenLabs の直叩きは廃止し、すべて自前基盤経由にする。
// 返り値は generateElevenLabsSpeech と同じ形に揃えてあるので、
// speechBoundsFromAlignment / writeSpeechAsset などの既存処理は無改修で動く。

import {
  buzzAssistFetch,
  resolveBuzzAssistApiBase,
} from "./buzzassistApi.mjs";

export const BUZZASSIST_SPEECH_PROVIDER = "buzzassist";
export const DEFAULT_BUZZASSIST_SPEECH_FORMAT = "mp3";

const JOB_POLL_INTERVAL_MS = 2_000;
const JOB_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * API 呼び出しの実体。既定は buzzAssistFetch（デスクトップ認証トークンを付ける）。
 * テストやローカル検証では apiFetch を差し替えられる。
 */
function resolveApiFetch(input = {}) {
  return typeof input.apiFetch === "function" ? input.apiFetch : buzzAssistFetch;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function resolveVoiceApiUrl(path) {
  return `${resolveBuzzAssistApiBase()}/api/voice${path}`;
}

/**
 * BuzzAssist の alignment（[{char,start,end}]）を、
 * 既存コードが期待する ElevenLabs 形式に変換する。
 */
export function alignmentFromBuzzAssist(alignment) {
  const rows = Array.isArray(alignment) ? alignment : [];
  const characters = [];
  const characterStartTimesSeconds = [];
  const characterEndTimesSeconds = [];
  for (const row of rows) {
    const char = typeof row?.char === "string" ? row.char : "";
    if (!char) continue;
    characters.push(char);
    characterStartTimesSeconds.push(Math.max(0, finiteNumber(row.start)));
    characterEndTimesSeconds.push(Math.max(0, finiteNumber(row.end)));
  }
  return { characters, characterStartTimesSeconds, characterEndTimesSeconds };
}

async function readJson(response, label) {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = nonEmptyString(payload?.error) || `${label} に失敗しました (HTTP ${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    error.code = nonEmptyString(payload?.code);
    throw error;
  }
  return payload ?? {};
}

/** ライブラリ声＋自分の専用声。get_voices ツールの実体 */
export async function listBuzzAssistVoices(input = {}) {
  const { signal } = input;
  const response = await resolveApiFetch(input)(resolveVoiceApiUrl("/voices"), { method: "GET", signal, timeoutMs: 60_000 });
  const payload = await readJson(response, "声の一覧の取得");
  const voices = Array.isArray(payload.voices) ? payload.voices : [];
  return voices.map((voice) => ({
    voiceId: nonEmptyString(voice.voiceId),
    name: nonEmptyString(voice.name),
    description: nonEmptyString(voice.description),
    gender: nonEmptyString(voice.gender),
    ageGroup: nonEmptyString(voice.ageGroup),
    styles: Array.isArray(voice.styles) ? voice.styles.map((style) => String(style)) : [],
    actorName: nonEmptyString(voice.actorName),
    ownerType: nonEmptyString(voice.ownerType) || "library",
    sampleUrl: nonEmptyString(voice.sampleUrl),
    favorite: Boolean(voice.favorite),
    provider: BUZZASSIST_SPEECH_PROVIDER,
  }));
}

/** 今月の残り分数など */
export async function getBuzzAssistVoiceQuota(input = {}) {
  const { signal } = input;
  const response = await resolveApiFetch(input)(resolveVoiceApiUrl("/quota"), { method: "GET", signal, timeoutMs: 60_000 });
  return readJson(response, "残り分数の取得");
}

/** アカウント辞書に読みを登録する */
export async function saveBuzzAssistReadings(readings, options = {}) {
  const { signal } = options;
  const entries = (Array.isArray(readings) ? readings : [])
    .map((entry) => ({ word: nonEmptyString(entry?.word), reading: nonEmptyString(entry?.reading) }))
    .filter((entry) => entry.word && entry.reading);
  if (entries.length === 0) return { saved: 0 };
  const response = await resolveApiFetch(options)(resolveVoiceApiUrl("/readings"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ readings: entries }),
    signal,
    timeoutMs: 60_000,
  });
  return readJson(response, "読み辞書の保存");
}

async function waitForJob(jobId, options = {}) {
  const { signal, onStatus } = options;
  const startedAt = Date.now();
  for (;;) {
    if (Date.now() - startedAt > JOB_TIMEOUT_MS) {
      throw new Error("音声生成が時間内に完了しませんでした。");
    }
    await new Promise((resolve) => setTimeout(resolve, JOB_POLL_INTERVAL_MS));
    const response = await resolveApiFetch(options)(resolveVoiceApiUrl(`/jobs/${encodeURIComponent(jobId)}`), {
      method: "GET",
      signal,
      timeoutMs: 60_000,
    });
    const job = await readJson(response, "ジョブ状態の取得");
    if (typeof onStatus === "function") {
      onStatus({ status: job.status, done: job.doneChunks, total: job.totalChunks });
    }
    if (job.status === "completed") return job;
    if (job.status === "failed") {
      throw new Error(nonEmptyString(job.errorMessage) || "音声生成に失敗しました。");
    }
  }
}

/**
 * BuzzAssist の音声基盤で読み上げる。
 * 返り値は generateElevenLabsSpeech と同じ形（provider だけ "buzzassist"）。
 */
export async function generateBuzzAssistSpeech(input = {}) {
  const text = nonEmptyString(input.text);
  if (!text) throw new Error("Speech text is required.");
  const voiceId = nonEmptyString(input.voiceId ?? input.voice_id);
  if (!voiceId) throw new Error("voiceId is required. get_voices で声を選んでください。");

  const format = nonEmptyString(input.format ?? input.outputFormat) === "wav" ? "wav" : DEFAULT_BUZZASSIST_SPEECH_FORMAT;
  const body = {
    voiceId,
    text,
    speed: finiteNumber(input.speed, 1),
    style: nonEmptyString(input.style) || "neutral",
    format,
    requestKey: nonEmptyString(input.requestKey),
    readings: Array.isArray(input.readings) ? input.readings : undefined,
  };
  const startedAt = Date.now();
  const response = await resolveApiFetch(input)(resolveVoiceApiUrl("/generate"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: input.signal,
    timeoutMs: 300_000,
  });

  let result = await readJson(response, "音声生成");
  // 30秒相当を超える台本はジョブ化される
  if (response.status === 202 && nonEmptyString(result.jobId)) {
    result = await waitForJob(result.jobId, { signal: input.signal, onStatus: input.onStatus, apiFetch: input.apiFetch });
  }

  const audioUrl = nonEmptyString(result.audioUrl);
  if (!audioUrl) throw new Error("音声のURLが返りませんでした。");
  const audioResponse = await fetch(audioUrl, { signal: input.signal });
  if (!audioResponse.ok) {
    throw new Error(`生成した音声を取得できませんでした (HTTP ${audioResponse.status})`);
  }
  const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
  if (audioBuffer.length === 0) throw new Error("生成した音声が空でした。");

  const alignment = alignmentFromBuzzAssist(result.alignment);
  const durationSeconds = Math.max(0, finiteNumber(result.durationSec));

  return {
    provider: BUZZASSIST_SPEECH_PROVIDER,
    model: BUZZASSIST_SPEECH_PROVIDER,
    voiceId,
    text,
    mimeType: format === "wav" ? "audio/wav" : "audio/mpeg",
    outputFormat: format,
    audioBuffer,
    alignment,
    rawAlignment: alignment,
    durationSeconds,
    elapsedMs: Date.now() - startedAt,
    requestId: nonEmptyString(result.requestId),
    characterCount: [...text].length,
    // BuzzAssist 固有: 課金された秒数と、再生成が無料だったか
    chargedSeconds: finiteNumber(result.chargedSec),
    freeRegeneration: Boolean(result.freeRegeneration),
    remainingMinutes: finiteNumber(result?.quota?.remainingMin, NaN),
  };
}
