import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { writeJsonAtomic } from "./canvasScene.mjs";
import { mergeIntoPronunciations, readReadingDictionary } from "./readingDictionary.mjs";
import { auditVoiceQuality, voiceQualityAvailable, voiceQualityPenalty } from "./voiceQualityGate.mjs";
import { AMBIGUOUS_STATUSES, RetryablePaidApiError, ambiguousChargeError, redactSecrets, withPaidApiRetry } from "./paidApiRetry.mjs";
import { resolvePythonRuntime } from "./harnessRuntimeResolver.mjs";
import {
  createPaidMediaJobBroker,
  paidMediaJobReceiptSummary,
  readPaidMediaJobArtifact,
} from "./paidMediaJobBroker.mjs";

const execFile = promisify(execFileCallback);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, finite(value, minimum)));
export const KOYA_PAID_SPEECH_REQUEST_CONCURRENCY_LIMIT = 4;
export const KOYA_SPEECH_CHECKPOINT_VERSION = "koya-speech-cut-set-v1";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

/** Receipt-safe, fail-closed summary accepted by the outer common RunReceipt. */
export function normalizeKoyaDialogueMediaJobReceipt(summary = {}) {
  const digest = (value, label) => {
    const normalized = String(value || "").replace(/^sha256:/u, "");
    if (!SHA256_PATTERN.test(normalized)) throw new Error(`Koya dialogue Media Job ${label} must be SHA-256.`);
    return normalized;
  };
  const requiredText = (value, label) => {
    const normalized = String(value || "").trim();
    if (!normalized) throw new Error(`Koya dialogue Media Job ${label} is required.`);
    return normalized;
  };
  const finiteOrNull = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
  if (summary?.status !== "completed"
    || summary?.kind !== "voice.dialogue"
    || summary?.provider !== "elevenlabs"
    || summary?.model !== "eleven_v3"
    || summary?.adapterVersion !== "elevenlabs-dialogue-server-v1") {
    throw new Error("Koya dialogue Media Job receipt is not the completed exact paid adapter identity.");
  }
  const artifactSha256 = digest(summary?.artifact?.sha256, "artifact.sha256");
  const artifactBytes = finiteOrNull(summary?.artifact?.bytes);
  if (artifactBytes === null || artifactBytes < 1) {
    throw new Error("Koya dialogue Media Job artifact.bytes must be a positive number.");
  }
  return {
    version: String(summary.version || ""),
    jobId: requiredText(summary.jobId, "jobId"),
    requestKey: requiredText(summary.requestKey, "requestKey"),
    status: "completed",
    kind: "voice.dialogue",
    provider: "elevenlabs",
    adapterVersion: "elevenlabs-dialogue-server-v1",
    providerJobId: String(summary.providerJobId || ""),
    model: "eleven_v3",
    voiceId: String(summary.voiceId || ""),
    inputHash: digest(summary.inputHash, "inputHash"),
    reservation: {
      reservationId: String(summary.reservation?.reservationId || ""),
      status: String(summary.reservation?.status || ""),
      estimatedSeconds: finiteOrNull(summary.reservation?.estimatedSeconds),
      estimatedUnits: finiteOrNull(summary.reservation?.estimatedUnits),
      estimatedCost: finiteOrNull(summary.reservation?.estimatedCost),
      currency: String(summary.reservation?.currency || ""),
    },
    usage: {
      seconds: finiteOrNull(summary.usage?.seconds),
      units: finiteOrNull(summary.usage?.units),
      cost: finiteOrNull(summary.usage?.cost),
      currency: String(summary.usage?.currency || ""),
      freeRegeneration: summary.usage?.freeRegeneration === true,
    },
    artifact: {
      sha256: artifactSha256,
      mimeType: requiredText(summary.artifact?.mimeType, "artifact.mimeType"),
      bytes: artifactBytes,
    },
    attempts: {
      total: finiteOrNull(summary.attempts?.total) ?? 0,
      retries: Array.isArray(summary.attempts?.retries)
        ? summary.attempts.retries.map((entry) => ({
          operation: String(entry?.operation || ""),
          attempt: finiteOrNull(entry?.attempt),
          status: finiteOrNull(entry?.status),
          backoffMs: finiteOrNull(entry?.backoffMs),
        }))
        : [],
    },
  };
}

function mergeKoyaDialogueMediaJobReceipts(target, rows = []) {
  const byRequest = new Map((target || []).map((row) => [row.requestKey, row]));
  for (const raw of rows) {
    const row = normalizeKoyaDialogueMediaJobReceipt(raw);
    const previous = byRequest.get(row.requestKey);
    if (previous && JSON.stringify(previous) !== JSON.stringify(row)) {
      throw new Error(`Conflicting Koya dialogue Media Job receipt for ${row.requestKey}.`);
    }
    byRequest.set(row.requestKey, row);
  }
  return [...byRequest.values()].sort((left, right) => left.requestKey.localeCompare(right.requestKey, "en"));
}

export class KoyaUsageLimitError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "KoyaUsageLimitError";
    this.details = details;
  }
}

/**
 * Each cut launches all initial takes together. Cross-cut concurrency is
 * therefore derived from the shared paid-request ceiling, never guessed from
 * CPU count. A caller may lower the value but cannot raise the paid ceiling.
 */
export function normalizeKoyaSpeechCutConcurrency(value, takeCount = 2) {
  const simultaneousTakes = Math.max(1, Math.floor(finite(takeCount, 2)));
  if (simultaneousTakes > KOYA_PAID_SPEECH_REQUEST_CONCURRENCY_LIMIT) {
    throw new Error(
      `Koya initial takeCount ${simultaneousTakes} exceeds the shared paid-request concurrency limit ${KOYA_PAID_SPEECH_REQUEST_CONCURRENCY_LIMIT}.`,
    );
  }
  const safeMaximum = Math.max(1, Math.floor(
    KOYA_PAID_SPEECH_REQUEST_CONCURRENCY_LIMIT / simultaneousTakes,
  ));
  if (value === undefined || value === null || value === "" || value === "auto") return safeMaximum;
  const requested = Number(value);
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new Error("speechConcurrency must be auto or a positive integer.");
  }
  return Math.min(requested, safeMaximum);
}

/**
 * Bounded worker pool with a single serialized collector. Workers may write
 * only cut-unique artifacts; all shared manifest/report mutations belong in
 * onSettled. Once a worker fails, no new cut is claimed while already-running
 * cuts are allowed to checkpoint their durable results.
 */
export async function runKoyaSpeechCutPool(items = [], {
  concurrency = 1,
  worker,
  onSettled = async () => {},
  shouldStop = async () => false,
} = {}) {
  if (typeof worker !== "function") throw new Error("Koya speech cut pool requires a worker.");
  if (typeof onSettled !== "function") throw new Error("Koya speech cut pool requires a collector.");
  const limit = Math.max(1, Math.min(items.length || 1, Math.floor(finite(concurrency, 1))));
  const outcomes = new Array(items.length);
  let cursor = 0;
  let stopped = false;
  let cancelled = false;
  let firstError = null;
  let collectorFailed = false;
  let claimTail = Promise.resolve();
  let collectorTail = Promise.resolve();

  const claim = () => {
    const next = claimTail.then(async () => {
      if (stopped || cursor >= items.length) return null;
      if (await shouldStop()) {
        stopped = true;
        cancelled = true;
        return null;
      }
      const index = cursor;
      cursor += 1;
      return { index, item: items[index] };
    });
    claimTail = next.then(() => undefined, (error) => {
      stopped = true;
      firstError ||= error;
    });
    return next;
  };

  const collect = async (outcome) => {
    if (collectorFailed) throw firstError;
    const next = collectorTail.then(() => onSettled(outcome));
    collectorTail = next.then(() => undefined, (error) => {
      stopped = true;
      collectorFailed = true;
      firstError ||= error;
    });
    await next;
  };

  const runner = async () => {
    while (true) {
      let task;
      try {
        task = await claim();
      } catch (error) {
        stopped = true;
        firstError ||= error;
        return;
      }
      if (!task) return;
      let outcome;
      try {
        outcome = { index: task.index, item: task.item, status: "fulfilled", value: await worker(task.item, task.index) };
      } catch (error) {
        outcome = { index: task.index, item: task.item, status: "rejected", error };
        stopped = true;
        firstError ||= error;
      }
      outcomes[task.index] = outcome;
      try {
        await collect(outcome);
      } catch (error) {
        stopped = true;
        firstError ||= error;
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: limit }, () => runner()));
  await collectorTail;
  return {
    outcomes,
    unscheduled: items.filter((_item, index) => !outcomes[index]),
    firstError,
    cancelled,
    concurrency: limit,
  };
}

export function koyaPerformanceTag(utterance = {}) {
  if (utterance.preset === "narration") return "";
  const text = String(utterance.text || "");
  if (/(?:怒|許さ|ふざけ|やめて|最低|黙れ|！{1,})/u.test(text)) return "[angry]";
  if (/(?:悲し|つら|ごめん|さよなら|別れ|……)/u.test(text)) return "[sad]";
  if (/(?:まさか|本当|え[？?]|なんで|驚)/u.test(text)) return "[surprised]";
  if (/(?:絶対|決めた|負けない|証明|守る|やる)/u.test(text)) return "[determined]";
  if (/(?:ありがとう|嬉しい|好き|おかえり|ただいま)/u.test(text)) return "[warm]";
  if (/(?:どうせ|勝手|関係ない|釣り合わ|底辺)/u.test(text)) return "[cold]";
  if (/[。！？!?]$/u.test(text)) return "[conversational]";
  return "[conversational]";
}

export function applyKoyaSpeechPronunciations(text, pronunciations = []) {
  let spoken = String(text || "").normalize("NFKC");
  // Ruby in the display script is an authoring hint, not something the voice
  // actor should read twice. Keep only the approved reading.
  spoken = spoken.replace(
    /([\u3400-\u9fff々〆ヶ]+)[（(]([ぁ-ゖァ-ヶー\s]+)[）)]/gu,
    (_match, _surface, reading) => reading.trim(),
  );
  const entries = [...(pronunciations || [])]
    .filter((entry) => String(entry?.from || "").trim() && String(entry?.to || "").trim())
    .sort((left, right) => [...String(right.from)].length - [...String(left.from)].length);
  for (const entry of entries) {
    spoken = spoken.split(String(entry.from).trim()).join(String(entry.to).trim());
  }
  return spoken;
}

export function splitKoyaProviderSpeechText(speechText, utterance = {}) {
  const source = String(speechText || "").trim();
  if (utterance.preset !== "narration" || [...source].length < 90) return [source];
  const sentences = source.match(/[^。！？!?]+[。！？!?]?/gu)?.map((entry) => entry.trim()).filter(Boolean) || [];
  if (sentences.length < 2) return [source];
  const chunks = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && [...`${current}${sentence}`].length > 50) {
      chunks.push(current);
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current) chunks.push(current);
  return chunks.length > 1 && chunks.join("") === source ? chunks : [source];
}

export function prepareKoyaDialogueCut(manifest, cut, options = {}) {
  const utteranceById = new Map((manifest.utterances || []).map((entry) => [entry.id, entry]));
  const utterances = (cut.utteranceIds || []).map((id) => utteranceById.get(id)).filter(Boolean);
  if (utterances.length === 0) throw new Error(`${cut.id} has no utterances.`);
  const inputs = utterances.map((utterance) => {
    const authoredSpeechText = String(
      utterance.speechOverride || utterance.speechText || utterance.text || "",
    ).trim();
    const speechText = applyKoyaSpeechPronunciations(
      authoredSpeechText,
      manifest.speech?.pronunciations,
    ).trim();
    const performancePrompt = utterance.performancePrompt === undefined
      ? koyaPerformanceTag(utterance)
      : String(utterance.performancePrompt || "").trim();
    const providerText = performancePrompt ? `${performancePrompt} ${speechText}` : speechText;
    if (!utterance.voiceId) throw new Error(`An approved ElevenLabs voice is required for ${utterance.id}.`);
    return {
      utteranceId: utterance.id,
      displayText: utterance.text,
      speechText,
      // Confirmed kana from the preflight/human pass; keeps the CER gate
      // non-circular (empty means "not confirmed yet", never a guess).
      expectedReading: String(utterance.expectedReading || utterance.speechReading || "").trim(),
      performancePrompt,
      providerText,
      voiceId: utterance.voiceId,
      apiInput: { text: providerText, voice_id: utterance.voiceId },
    };
  });
  const providerInputs = [];
  for (let logicalInputIndex = 0; logicalInputIndex < inputs.length; logicalInputIndex += 1) {
    const input = inputs[logicalInputIndex];
    const utterance = utterances[logicalInputIndex];
    const speechParts = splitKoyaProviderSpeechText(input.speechText, utterance);
    input.providerInputIndices = [];
    for (let partIndex = 0; partIndex < speechParts.length; partIndex += 1) {
      const speechText = speechParts[partIndex];
      const performancePrompt = partIndex === 0 ? input.performancePrompt : "";
      const providerText = performancePrompt ? `${performancePrompt} ${speechText}` : speechText;
      const providerInputIndex = providerInputs.length;
      input.providerInputIndices.push(providerInputIndex);
      providerInputs.push({
        ...input,
        utteranceId: speechParts.length > 1 ? `${input.utteranceId}:part-${partIndex + 1}` : input.utteranceId,
        parentUtteranceId: input.utteranceId,
        logicalInputIndex,
        providerInputIndex,
        speechText,
        expectedReading: speechParts.length > 1 ? "" : input.expectedReading,
        performancePrompt,
        providerText,
        apiInput: { text: providerText, voice_id: input.voiceId },
      });
    }
  }
  const takeCount = clamp(options.takeCount ?? 2, 2, 8);
  return {
    cutId: cut.id,
    utterances,
    inputs,
    providerInputs,
    takeCount,
    model: "eleven_v3",
    languageCode: "ja",
  };
}

export function buildKoyaDialogueRequest(cutPlan, takeIndex, pronunciationDictionaryLocators = null) {
  const numericCutId = Number(String(cutPlan.cutId).replace(/\D/gu, "")) || 0;
  const stabilityCycle = [0.46, 0.52, 0.49, 0.55, 0.43, 0.5, 0.47, 0.53];
  const request = {
    inputs: (cutPlan.providerInputs || cutPlan.inputs).map((entry) => entry.apiInput),
    model_id: "eleven_v3",
    language_code: "ja",
    settings: { stability: stabilityCycle[takeIndex] ?? 0.5 },
    seed: 440000 + numericCutId * 10 + takeIndex,
    apply_text_normalization: "auto",
  };
  if (Array.isArray(pronunciationDictionaryLocators) && pronunciationDictionaryLocators.length > 0) {
    // Native alias application inside ElevenLabs (max 3 locators). The text
    // substitution in prepareKoyaDialogueCut stays as the offline fallback.
    request.pronunciation_dictionary_locators = pronunciationDictionaryLocators.slice(0, 3);
  }
  return request;
}

function segmentBounds(metadata, inputIndex, cutPlan = null) {
  const providerInputIndices = cutPlan?.inputs?.[inputIndex]?.providerInputIndices || [inputIndex];
  const wanted = new Set(providerInputIndices.map(Number));
  const segments = (metadata.voiceSegments || []).filter((segment) => (
    wanted.has(Number(segment.dialogue_input_index))
  ));
  if (segments.length === 0) throw new Error(`Missing voice segment ${inputIndex} in ${metadata.cutId}.`);
  return {
    startSeconds: Math.min(...segments.map((entry) => finite(entry.start_time_seconds))),
    endSeconds: Math.max(...segments.map((entry) => finite(entry.end_time_seconds))),
  };
}

export function scoreKoyaDialogueTake(metadata, cutPlan) {
  const rows = [];
  let score = 0;
  for (let index = 0; index < cutPlan.inputs.length; index += 1) {
    const bounds = segmentBounds(metadata, index, cutPlan);
    const duration = Math.max(0.001, bounds.endSeconds - bounds.startSeconds);
    const characters = [...cutPlan.inputs[index].speechText.replace(/[\s。、，．！？!?…・]/gu, "")].length;
    const cps = characters / duration;
    const pacePenalty = cps < 3.2 ? (3.2 - cps) * 2 : cps > 8.2 ? (cps - 8.2) * 2 : Math.abs(cps - 5.4) / 5.4;
    const previousEnd = index === 0 ? 0 : segmentBounds(metadata, index - 1, cutPlan).endSeconds;
    const nextStart = index === cutPlan.inputs.length - 1
      ? finite(metadata.sourceDurationSeconds, bounds.endSeconds)
      : segmentBounds(metadata, index + 1, cutPlan).startSeconds;
    const headRoom = bounds.startSeconds - previousEnd;
    const tailRoom = nextStart - bounds.endSeconds;
    const edgePenalty = Math.max(0, 0.06 - headRoom) * 4 + Math.max(0, 0.045 - tailRoom) * 4;
    const rowScore = pacePenalty + edgePenalty;
    score += rowScore;
    rows.push({
      utteranceId: cutPlan.inputs[index].utteranceId,
      durationSeconds: Number(duration.toFixed(4)),
      charactersPerSecond: Number(cps.toFixed(3)),
      headRoomSeconds: Number(headRoom.toFixed(4)),
      tailRoomSeconds: Number(tailRoom.toFixed(4)),
      score: Number(rowScore.toFixed(6)),
    });
  }
  return { score: Number(score.toFixed(6)), rows };
}

export function selectKoyaDialogueTake(candidates, cutPlan, forcedTakeIndex = null, voiceQualityByTake = null, forcedTakeReason = "") {
  const scored = candidates.map((candidate) => {
    const quality = candidate.quality || scoreKoyaDialogueTake(candidate, cutPlan);
    const voiceQuality = voiceQualityByTake?.[candidate.takeIndex] ?? null;
    // R194: soft penalties fold into the same lower-is-better score; hard
    // failures additionally EXCLUDE the take from the eligible set below.
    const combinedScore = quality.score + (voiceQuality?.penalty ?? 0);
    return { ...candidate, quality, voiceQuality, combinedScore };
  }).sort((left, right) => left.combinedScore - right.combinedScore);
  // Hard gate is an eligibility filter, not a ranking nudge: a failed take can
  // never be auto-selected while any clean take exists. A forced index is an
  // explicit human decision and overrides the filter.
  const eligible = voiceQualityByTake
    ? scored.filter((entry) => entry.voiceQuality?.hardFail !== true)
    : scored;
  if (!Number.isInteger(forcedTakeIndex) && voiceQualityByTake && eligible.length === 0) {
    throw new Error("All takes failed the R194 voice quality gate; refusing automatic selection.");
  }
  let selected;
  if (Number.isInteger(forcedTakeIndex)) {
    selected = scored.find((entry) => entry.takeIndex === forcedTakeIndex);
    if (!selected) throw new Error(`forced take ${forcedTakeIndex} does not exist among ${scored.length} candidates.`);
    // 人が明示的に選ぶこと自体は認めるが、ゲートに落ちたテイクを理由なしに
    // 採用できると、ライブラリ呼び出し1つでゲートを無効化できてしまう。
    // 「誰がなぜ落選テイクを選んだか」を残さない限り通さない。
    if (selected.voiceQuality?.hardFail === true && !forcedTakeReason) {
      throw new Error(
        `forced take ${forcedTakeIndex} は音声品質ゲートに落ちています。`
        + "採用するなら理由（forcedTakeReasons）を記録してください。",
      );
    }
  } else {
    selected = eligible[0] ?? scored[0];
  }
  return {
    ...selected,
    candidateSelection: {
      method: voiceQualityByTake
        ? "alignment-completeness-edge-room-scene-paced-cps-and-r194-voice-quality"
        : "alignment-completeness-edge-room-and-scene-paced-cps",
      selectedTakeIndex: selected.takeIndex,
      candidates: scored.map((entry) => ({
        takeIndex: entry.takeIndex,
        sourcePath: entry.sourcePath,
        requestId: entry.requestId,
        reused: entry.reused === true,
        quality: entry.quality,
        voiceQuality: entry.voiceQuality,
        combinedScore: entry.combinedScore,
      })),
    },
  };
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

export async function approvedKoyaDialogueCutCheckpoint(cutPlan) {
  const logicalInputs = cutPlan?.inputs || [];
  const utterances = cutPlan?.utterances || [];
  if (logicalInputs.length === 0 || logicalInputs.length !== utterances.length) return null;
  const qaInputs = cutPlan.providerInputs || logicalInputs;
  const segmentUtmosRequired = new Set(qaInputs.map((entry) => entry.voiceId).filter(Boolean)).size > 1;
  const checkpoints = [];
  for (let index = 0; index < logicalInputs.length; index += 1) {
    const input = logicalInputs[index];
    const utterance = utterances[index];
    const audio = utterance?.audio;
    if (!audio
      || audio.pipeline !== "koya-dialogue-v44"
      || audio.utteranceId !== utterance.id
      || audio.displayText !== input.displayText
      || audio.speechText !== input.speechText
      || String(audio.performancePrompt || "") !== String(input.performancePrompt || "")
      || audio.providerText !== input.providerText
      || audio.voiceId !== input.voiceId
      || audio.model !== "eleven_v3"
      || !audio.filePath
      || !audio.alignmentPath
      || !audio.sourceDialoguePath
      || !audio.sourceDialogueMetadataPath) return null;
    const filesPresent = await Promise.all([
      audio.filePath,
      audio.alignmentPath,
      audio.sourceDialoguePath,
      audio.sourceDialogueMetadataPath,
    ].map((path) => exists(resolve(path))));
    if (!filesPresent.every(Boolean)) return null;
    const selection = audio.candidateSelection;
    if (!selection?.method?.includes("r194-voice-quality")) return null;
    const selectedTakeIndex = Number(audio.selectedTakeIndex);
    const selected = (selection.candidates || []).find((entry) => Number(entry.takeIndex) === selectedTakeIndex);
    const voiceQuality = selected?.voiceQuality;
    if (!voiceQuality
      || voiceQuality.hardFail !== false
      || (voiceQuality.missingRequiredMetrics || []).length > 0
      || (voiceQuality.problems || []).length > 0
      || !Number.isFinite(Number(voiceQuality.metrics?.utmos))) return null;
    if (segmentUtmosRequired) {
      const segments = voiceQuality.metrics?.segments || [];
      if (voiceQuality.metrics?.segmentUtmosApplied !== true
        || segments.length !== qaInputs.length
        || !segments.every((entry) => Number.isFinite(Number(entry?.utmos)))) return null;
    }
    checkpoints.push({ audio, selectedTakeIndex });
  }
  const selectedTakeIndex = checkpoints[0].selectedTakeIndex;
  const sourcePath = checkpoints[0].audio.sourceDialoguePath;
  if (!checkpoints.every((entry) => (
    entry.selectedTakeIndex === selectedTakeIndex && entry.audio.sourceDialoguePath === sourcePath
  ))) return null;
  return { selectedTakeIndex, sourcePath };
}

async function checkpointKoyaDialogueMediaJobs(cutPlan) {
  const selection = cutPlan?.utterances?.[0]?.audio?.candidateSelection;
  const candidates = Array.isArray(selection?.candidates) ? selection.candidates : [];
  if (candidates.length === 0) {
    throw new Error(`${cutPlan?.cutId || "Koya cut"} has approved audio but no paid-take roster; refusing duplicate regeneration.`);
  }
  const receipts = [];
  for (const candidate of candidates) {
    const sourcePath = String(candidate?.sourcePath || "").trim();
    if (!sourcePath) throw new Error(`${cutPlan.cutId} approved candidate lacks sourcePath Media Job provenance.`);
    const metadata = JSON.parse(await readFile(`${resolve(sourcePath)}.json`, "utf8"));
    receipts.push(normalizeKoyaDialogueMediaJobReceipt(metadata.mediaJobReceipt));
  }
  return mergeKoyaDialogueMediaJobReceipts([], receipts);
}

async function probeDuration(path) {
  const { stdout } = await execFile("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path,
  ]);
  return finite(stdout.trim());
}

async function decodeMonoSamples(filePath) {
  const { stdout } = await execFile("ffmpeg", [
    "-v", "error", "-i", filePath,
    "-vn", "-ar", "48000", "-ac", "1", "-f", "f32le", "-",
  ], { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
  return new Float32Array(
    stdout.buffer,
    stdout.byteOffset,
    Math.floor(stdout.byteLength / Float32Array.BYTES_PER_ELEMENT),
  );
}

// The provider's per-segment `start_time_seconds` is an approximation and
// routinely lands *inside* the previous speaker's still-sounding tail. Cutting
// there truncates one line mid-word and prepends the residue — a different
// character's voice — to the next line. The per-character alignment the same
// response carries is accurate, so speech spans are derived from it and the
// physical cut is then moved to the quietest point between two spans.
export function alignmentSpeechSpan(metadata, cutPlan, inputIndex) {
  const alignment = metadata?.alignment;
  const characters = alignment?.characters;
  const starts = alignment?.character_start_times_seconds;
  const ends = alignment?.character_end_times_seconds;
  if (!Array.isArray(characters) || !Array.isArray(starts) || !Array.isArray(ends)) return null;
  if (characters.length === 0 || starts.length !== characters.length || ends.length !== characters.length) {
    return null;
  }
  const providerInputIndices = cutPlan?.inputs?.[inputIndex]?.providerInputIndices || [inputIndex];
  const wanted = new Set(providerInputIndices.map(Number));
  const segments = (metadata.voiceSegments || [])
    .filter((segment) => wanted.has(Number(segment.dialogue_input_index)));
  if (segments.length === 0) return null;
  const from = Math.min(...segments.map((segment) => Number(segment.character_start_index)));
  const to = Math.max(...segments.map((segment) => Number(segment.character_end_index)));
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to > characters.length) return null;
  const window = characters.slice(from, to).join("");
  // Index arithmetic below is only valid while every alignment entry is a
  // single UTF-16 unit, which holds for Japanese dialogue but not for
  // astral-plane characters.
  if (window.length !== to - from) return null;
  const speechText = String(cutPlan?.inputs?.[inputIndex]?.speechText || "");
  if (speechText.length === 0) return null;
  const offset = window.indexOf(speechText);
  if (offset < 0) return null;
  const first = from + offset;
  const last = first + speechText.length - 1;
  const startSeconds = Number(starts[first]);
  const endSeconds = Number(ends[last]);
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) return null;
  return { startSeconds, endSeconds };
}

function windowRms(samples, startIndex, lengthSamples) {
  const first = Math.max(0, startIndex);
  const last = Math.min(samples.length, startIndex + lengthSamples);
  if (last <= first) return 0;
  let sumSquares = 0;
  for (let index = first; index < last; index += 1) sumSquares += samples[index] * samples[index];
  return Math.sqrt(sumSquares / (last - first));
}

function fftInPlace(real, imaginary) {
  const size = real.length;
  for (let i = 1, j = 0; i < size; i += 1) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]];
    }
  }
  for (let length = 2; length <= size; length <<= 1) {
    const angle = -2 * Math.PI / length;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let start = 0; start < size; start += length) {
      let spinReal = 1;
      let spinImaginary = 0;
      for (let offset = 0; offset < length / 2; offset += 1) {
        const a = start + offset;
        const b = a + length / 2;
        const productReal = real[b] * spinReal - imaginary[b] * spinImaginary;
        const productImaginary = real[b] * spinImaginary + imaginary[b] * spinReal;
        real[b] = real[a] - productReal;
        imaginary[b] = imaginary[a] - productImaginary;
        real[a] += productReal;
        imaginary[a] += productImaginary;
        const nextSpinReal = spinReal * stepReal - spinImaginary * stepImaginary;
        spinImaginary = spinReal * stepImaginary + spinImaginary * stepReal;
        spinReal = nextSpinReal;
      }
    }
  }
}

const ENVELOPE_FFT_SIZE = 2048;
const ENVELOPE_BANDS = 26;
const ENVELOPE_WINDOW = Float64Array.from(
  { length: ENVELOPE_FFT_SIZE },
  (_value, index) => 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (ENVELOPE_FFT_SIZE - 1)),
);
const ENVELOPE_FILTERBANK = (() => {
  const toMel = (hz) => 2595 * Math.log10(1 + hz / 700);
  const toHz = (mel) => 700 * (10 ** (mel / 2595) - 1);
  const low = toMel(80);
  const high = toMel(7000);
  const edges = Array.from({ length: ENVELOPE_BANDS + 2 }, (_value, index) => Math.floor(
    (ENVELOPE_FFT_SIZE + 1) * toHz(low + (high - low) * index / (ENVELOPE_BANDS + 1)) / 48_000,
  ));
  return Array.from({ length: ENVELOPE_BANDS }, (_value, band) => {
    const weights = new Float64Array(ENVELOPE_FFT_SIZE / 2 + 1);
    const left = edges[band];
    const centre = Math.max(edges[band + 1], left + 1);
    const right = Math.min(Math.max(edges[band + 2], centre + 1), ENVELOPE_FFT_SIZE / 2);
    for (let index = left; index < centre; index += 1) weights[index] = (index - left) / (centre - left);
    for (let index = centre; index < right; index += 1) weights[index] = (right - index) / (right - centre);
    return weights;
  });
})();

// Speaker identity read from vocal tract timbre. Pitch cannot do this job: a
// weak fundamental at a line's onset makes a low voice measure two or three
// octaves high, and correcting for that drops high voices onto subharmonics.
export function spectralEnvelope(samples, fromSeconds, toSeconds, sampleRate = 48_000) {
  const hop = Math.round(sampleRate * 0.010);
  const first = Math.max(0, Math.round(fromSeconds * sampleRate));
  const last = Math.min(samples.length, Math.round(toSeconds * sampleRate));
  const total = new Float64Array(ENVELOPE_BANDS);
  let frames = 0;
  for (let start = first; start + ENVELOPE_FFT_SIZE <= last; start += hop) {
    if (windowRms(samples, start, ENVELOPE_FFT_SIZE) < 0.012) continue;
    const real = new Float64Array(ENVELOPE_FFT_SIZE);
    const imaginary = new Float64Array(ENVELOPE_FFT_SIZE);
    for (let index = 0; index < ENVELOPE_FFT_SIZE; index += 1) {
      real[index] = samples[start + index] * ENVELOPE_WINDOW[index];
    }
    fftInPlace(real, imaginary);
    for (let band = 0; band < ENVELOPE_BANDS; band += 1) {
      const weights = ENVELOPE_FILTERBANK[band];
      let energy = 0;
      for (let bin = 0; bin < weights.length; bin += 1) {
        if (weights[bin] === 0) continue;
        energy += weights[bin] * (real[bin] * real[bin] + imaginary[bin] * imaginary[bin]);
      }
      total[band] += Math.log(energy + 1e-10);
    }
    frames += 1;
  }
  if (frames < 2) return null;
  let mean = 0;
  for (let band = 0; band < ENVELOPE_BANDS; band += 1) mean += total[band] / frames;
  mean /= ENVELOPE_BANDS;
  return total.map((value) => value / frames - mean);
}

export function envelopeDistance(left, right) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  return 1 - dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm) + 1e-12);
}

// First moment the take is audible again, judged at the same -48 dBFS the
// media-quality gate uses. The acoustic onset detector runs an order of
// magnitude more sensitively, so it treats inaudible residue as speech and
// would leave a second of dead air at the head of the line.
const AUDIBLE_RMS = 10 ** (-48 / 20);

// Narrow the detector's bounds to what a listener would actually hear, never
// widen them: the sensitive detector still decides where speech *could* be.
async function refineAudibleBounds(filePath, detected) {
  const samples = await decodeMonoSamples(filePath);
  const runSamples = Math.round(48_000 * 0.040);
  const stepSamples = Math.round(48_000 * 0.010);
  const first = Math.max(0, Math.round(detected.startSeconds * 48_000));
  const last = Math.min(samples.length, Math.round(detected.endSeconds * 48_000));
  let audibleStart = -1;
  let audibleEnd = -1;
  for (let start = first; start + runSamples <= last; start += stepSamples) {
    if (windowRms(samples, start, runSamples) < AUDIBLE_RMS) continue;
    if (audibleStart < 0) audibleStart = start;
    audibleEnd = start + runSamples;
  }
  if (audibleStart < 0 || audibleEnd <= audibleStart) return detected;
  return {
    ...detected,
    startSeconds: audibleStart / 48_000,
    endSeconds: Math.min(detected.endSeconds, audibleEnd / 48_000),
    audibleRefinement: {
      thresholdDbfs: -48,
      detectedStartSeconds: detected.startSeconds,
      detectedEndSeconds: detected.endSeconds,
    },
  };
}

export function firstAudibleSeconds(samples, fromSeconds, limitSeconds, sampleRate = 48_000) {
  const runSamples = Math.max(1, Math.round(sampleRate * 0.040));
  const stepSamples = Math.max(1, Math.round(sampleRate * 0.010));
  const first = Math.max(0, Math.round(fromSeconds * sampleRate));
  const last = Math.min(samples.length, Math.round(limitSeconds * sampleRate));
  for (let start = first; start + runSamples <= last; start += stepSamples) {
    if (windowRms(samples, start, runSamples) >= AUDIBLE_RMS) return start / sampleRate;
  }
  return null;
}

// Pick the least energetic 20 ms inside the inter-utterance window so the cut
// lands in real silence instead of across a vowel.
export function quietestBoundarySeconds(samples, fromSeconds, toSeconds, sampleRate = 48_000) {
  const midpoint = (fromSeconds + toSeconds) / 2;
  if (!(toSeconds > fromSeconds)) return midpoint;
  const windowSamples = Math.max(1, Math.round(sampleRate * 0.020));
  const first = Math.max(0, Math.round(fromSeconds * sampleRate));
  const last = Math.min(samples.length, Math.round(toSeconds * sampleRate));
  if (last - first <= windowSamples) return midpoint;
  let bestStart = -1;
  let bestEnergy = Number.POSITIVE_INFINITY;
  const step = Math.max(1, Math.round(sampleRate * 0.002));
  for (let start = first; start + windowSamples <= last; start += step) {
    let sumSquares = 0;
    for (let index = start; index < start + windowSamples; index += 1) {
      sumSquares += samples[index] * samples[index];
    }
    if (sumSquares < bestEnergy) {
      bestEnergy = sumSquares;
      bestStart = start;
    }
  }
  if (bestStart < 0) return midpoint;
  return (bestStart + windowSamples / 2) / sampleRate;
}

async function detectAcousticSpeechBounds(filePath) {
  const samples = await decodeMonoSamples(filePath);
  const sampleRate = 48_000;
  const windowSamples = Math.round(sampleRate * 0.005);
  const active = [];
  for (let start = 0; start < samples.length; start += windowSamples) {
    const end = Math.min(samples.length, start + windowSamples);
    let sumSquares = 0;
    let peak = 0;
    for (let index = start; index < end; index += 1) {
      const value = Math.abs(samples[index]);
      sumSquares += value * value;
      peak = Math.max(peak, value);
    }
    const rms = Math.sqrt(sumSquares / Math.max(1, end - start));
    active.push(rms >= 0.001 || peak >= 0.008);
  }
  const minimumRun = 3;
  let firstWindow = -1;
  let lastWindow = -1;
  for (let index = 0; index <= active.length - minimumRun; index += 1) {
    if (active.slice(index, index + minimumRun).every(Boolean)) {
      firstWindow = index;
      break;
    }
  }
  for (let index = active.length - minimumRun; index >= 0; index -= 1) {
    if (active.slice(index, index + minimumRun).every(Boolean)) {
      lastWindow = index + minimumRun;
      break;
    }
  }
  const durationSeconds = samples.length / sampleRate;
  if (firstWindow < 0 || lastWindow <= firstWindow) {
    throw new Error(`No sustained speech energy detected in ${filePath}.`);
  }
  return {
    startSeconds: firstWindow * windowSamples / sampleRate,
    endSeconds: Math.min(durationSeconds, lastWindow * windowSamples / sampleRate),
    durationSeconds,
    detector: {
      sampleRate,
      windowMilliseconds: 5,
      minimumSustainedMilliseconds: minimumRun * 5,
      rmsThreshold: 0.001,
      peakThreshold: 0.008,
    },
  };
}

async function compactLiteralSilence(inputPath, outputPath, maximumPauseSeconds = 0.68) {
  let stderr = "";
  try {
    ({ stderr } = await execFile("ffmpeg", [
      "-hide_banner", "-nostats", "-i", inputPath,
      "-af", "silencedetect=noise=-42dB:d=0.35", "-f", "null", "-",
    ]));
  } catch (error) {
    stderr = String(error?.stderr || "");
  }
  const starts = [...stderr.matchAll(/silence_start: ([0-9.]+)/gu)].map((match) => Number(match[1]));
  const endings = [...stderr.matchAll(/silence_end: ([0-9.]+) \| silence_duration: ([0-9.]+)/gu)]
    .map((match) => ({ end: Number(match[1]), duration: Number(match[2]) }));
  const durationSeconds = await probeDuration(inputPath);
  const edits = endings.map((ending, index) => ({
    start: starts[index],
    end: ending.end,
    duration: ending.duration,
  })).filter((silence) => (
    Number.isFinite(silence.start)
    && silence.start > 0.06
    && silence.end < durationSeconds - 0.06
    && silence.duration > maximumPauseSeconds + 0.04
  ));
  if (edits.length === 0) {
    await execFile("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-i", inputPath,
      "-ar", "48000", "-ac", "1", "-c:a", "pcm_s24le", outputPath,
    ]);
    return { edits: [], durationBeforeSeconds: durationSeconds, durationAfterSeconds: durationSeconds };
  }
  const segments = [];
  let cursor = 0;
  for (const silence of edits) {
    if (silence.start > cursor) segments.push({ start: cursor, end: silence.start });
    cursor = silence.end - maximumPauseSeconds;
  }
  if (cursor < durationSeconds) segments.push({ start: cursor, end: durationSeconds });
  const chains = segments.map((segment, index) => (
    `[0:a]atrim=start=${segment.start.toFixed(6)}:end=${segment.end.toFixed(6)},`
      + `asetpts=PTS-STARTPTS[a${index}]`
  ));
  const inputs = segments.map((_, index) => `[a${index}]`).join("");
  await execFile("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-i", inputPath,
    "-filter_complex", `${chains.join(";")};${inputs}concat=n=${segments.length}:v=0:a=1[out]`,
    "-map", "[out]", "-ar", "48000", "-ac", "1", "-c:a", "pcm_s24le", outputPath,
  ]);
  return {
    edits: edits.map((silence) => ({
      ...silence,
      retainedSeconds: maximumPauseSeconds,
      removedSeconds: silence.duration - maximumPauseSeconds,
    })),
    durationBeforeSeconds: durationSeconds,
    durationAfterSeconds: await probeDuration(outputPath),
  };
}

function loudnormSummary(stderr) {
  const matches = [...String(stderr).matchAll(/\{[\s\S]*?"input_i"[\s\S]*?\}/gu)];
  if (matches.length === 0) throw new Error("FFmpeg did not return a loudnorm measurement.");
  return JSON.parse(matches.at(-1)[0]);
}

async function normalizeLineTwoPass(inputPath, outputPath, targetLufs) {
  const measured = await execFile("ffmpeg", [
    "-hide_banner", "-nostats", "-i", inputPath,
    "-af", `loudnorm=I=${targetLufs}:LRA=7:TP=-2:print_format=json`,
    "-f", "null", "-",
  ], { maxBuffer: 16 * 1024 * 1024 });
  const measurement = loudnormSummary(measured.stderr || "");
  const filter = [
    `loudnorm=I=${targetLufs}:LRA=7:TP=-2`,
    `measured_I=${measurement.input_i}`,
    `measured_LRA=${measurement.input_lra}`,
    `measured_TP=${measurement.input_tp}`,
    `measured_thresh=${measurement.input_thresh}`,
    `offset=${measurement.target_offset}`,
    "linear=true:print_format=summary",
  ].join(":");
  await execFile("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-i", inputPath,
    "-af", filter, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s24le", outputPath,
  ]);
}

function usageLimitResponse(status, payload) {
  const code = Number(status);
  const serialized = JSON.stringify(payload || {}).toLowerCase();
  // 429 は提供側の残枠、402 は BuzzAssist クレジット残高。どちらも「待って同じ入力を
  // もう一度」が正しい運用なので、失敗ではなく park（waiting-usage-limit）に寄せる。
  return code === 429 || code === 402 || /(?:quota|usage.?limit|credits|subscription)/u.test(serialized);
}

const KOYA_PARKED_REQUEST_KEY_CHAIN_LIMIT = 8;

/**
 * 残枠・残高で拒否され、課金されずに終わった（＝返金済みで terminal な）journal 上の job。
 * サーバ側の requestKey は failed に固定されるので、同じ鍵では二度と再開できない。
 *
 * ただし `charged:false` はサーバの申告とは限らない。edge/WAF/proxy が HTTP 429/402 を
 * 返した transport 失敗も NonRetryablePaidApiError の既定値で charged=false になるが、
 * その裏でアプリが job を作成・dispatch 済みの可能性は消せない。そこで鍵を進めるのは、
 * サーバが 2xx envelope で job を認識し `local-` 以外の jobId を journal に残したときに限る。
 * transport 失敗の journal は `local-` のままなので、base 鍵に留まり（attach-only で park
 * のまま）新規の有償 submit は起きない。
 */
function parkedWithoutCharge(job) {
  return job?.status === "failed"
    && serverAcknowledgedJobId(job.jobId)
    && job.error?.charged === false
    && usageLimitResponse(job.error?.status, job.error);
}

function serverAcknowledgedJobId(jobId) {
  const id = typeof jobId === "string" ? jobId.trim() : "";
  return id.length > 0 && !id.startsWith("local-");
}

/**
 * park 後の再実行で使う requestKey を決める。
 *
 * 同一入力の鍵は正規化で1本に寄せるが、その鍵が「未課金の拒否」で terminal になって
 * いる場合だけ、決定論的な `:rN` を足して次の鍵へ進む。journal を読むだけで判定する
 * ので、直前に受けた 429/402 を自動再送することはない（park の意図は変えない）——
 * 進むのはオペレーターが再実行した回に限られ、同時起動も同じ鍵へ収束する。
 */
async function resumableKoyaRequestKey(mediaJobBroker, baseKey) {
  if (typeof mediaJobBroker?.getLocal !== "function") return baseKey;
  let requestKey = baseKey;
  for (let suffix = 1; suffix <= KOYA_PARKED_REQUEST_KEY_CHAIN_LIMIT; suffix += 1) {
    const local = await mediaJobBroker.getLocal({ requestKey });
    if (!local || !parkedWithoutCharge(local)) return requestKey;
    requestKey = `${baseKey}:r${suffix}`;
  }
  return requestKey;
}

/**
 * ElevenLabs の対話合成を1回投げる。再送規則は platform craft と共有。
 *
 * ここには再送が1つも無く、一過性の 503 でテイクが死んでいた。
 * 429 は呼び出し側の usageLimitResponse が park する扱いを変えない
 * ——残枠を焼かないための判断なので、ここで再送に変えるとその意図を壊す。
 */
export async function requestElevenLabsDialogue({ url, apiKey, body, fetchImpl, label = "ElevenLabs dialogue", sleepFn, maxAttempts = 3 } = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error(
      "Direct ElevenLabs transport is disabled. Use requestKoyaDialogueMediaJob; fetchImpl exists only for legacy adapter tests.",
    );
  }
  return withPaidApiRetry(async () => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", "xi-api-key": apiKey },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok && AMBIGUOUS_STATUSES.includes(response.status)) {
      // 504/408 は上流が受理して課金した後にも返る。再送すると二重に払う。
      throw ambiguousChargeError(`${label} が HTTP ${response.status}`, { status: response.status });
    }
    if (!response.ok && response.status >= 500) {
      throw new RetryablePaidApiError(`${label} が HTTP ${response.status}`, { status: response.status });
    }
    // 2xx でも 4xx でも、ここまで来たら再送しない。4xx は投げ直しても
    // 結果が変わらず課金だけ増え、2xx は既に課金済み。
    return { response, payload };
  }, { label, maxAttempts, secrets: apiKey ? [apiKey] : [], sleepFn });
}

/**
 * Submit one Koya dialogue take through the durable, server-side media adapter.
 * This function deliberately has no provider URL or credential parameter.
 */
export async function requestKoyaDialogueMediaJob(cutPlan, takeIndex, context = {}) {
  const body = buildKoyaDialogueRequest(
    cutPlan,
    takeIndex,
    context.pronunciationDictionaryLocators || null,
  );
  const inputHash = sha256(JSON.stringify(body));
  const mediaJobBroker = context.mediaJobBroker || createPaidMediaJobBroker({
    stateDir: context.mediaJobStateDir || join(context.sourceDir, "paid-media-jobs"),
    apiBase: context.mediaJobApiBase,
    apiFetch: context.mediaJobFetch,
    sleepFn: context.sleepFn,
    maxAttempts: context.maxAttempts,
    onRetry: context.onPaidMediaRetry,
  });
  const requestKey = await resumableKoyaRequestKey(
    mediaJobBroker,
    context.requestKey || `koya:${cutPlan.cutId}:take:${takeIndex + 1}:${inputHash}`,
  );
  const characterCount = (cutPlan.providerInputs || cutPlan.inputs)
    .reduce((sum, entry) => sum + [...String(entry.providerText || "")].length, 0);
  let job;
  try {
    job = await mediaJobBroker.start({
      kind: "voice.dialogue",
      provider: "elevenlabs",
      model: "eleven_v3",
      adapterVersion: "elevenlabs-dialogue-server-v1",
      voiceId: `dialogue-${sha256(
        (cutPlan.providerInputs || cutPlan.inputs).map((entry) => entry.voiceId).join("\n"),
      ).slice(0, 24)}`,
      requestKey,
      input: body,
      output: {
        acceptedFormats: ["wav_44100", "wav_24000"],
        enableLogging: true,
      },
      reservation: {
        unit: "characters",
        estimatedUnits: characterCount,
        estimatedSeconds: Math.max(1, characterCount / 5),
      },
    }, {
      signal: context.signal,
      timeoutMs: 300_000,
      onRetry: context.onPaidMediaRetry,
    });
    if (job.status !== "completed") {
      job = await mediaJobBroker.waitFor({ requestKey: job.requestKey }, {
        signal: context.signal,
        timeoutMs: finite(context.jobTimeoutMs, 15 * 60_000),
        pollIntervalMs: finite(context.jobPollIntervalMs, 2_000),
        onStatus: context.onPaidMediaStatus,
        onRetry: context.onPaidMediaRetry,
      });
    }
  } catch (error) {
    if (usageLimitResponse(error?.status, { code: error?.code, message: error?.message })) {
      throw new KoyaUsageLimitError(`ElevenLabs usage limit reached during ${cutPlan.cutId}.`, {
        status: error?.status ?? null,
        cutId: cutPlan.cutId,
        takeIndex,
        mediaJob: error?.job || null,
      });
    }
    throw error;
  }
  if (job.status !== "completed") {
    if (usageLimitResponse(job.error?.status, job.error)) {
      throw new KoyaUsageLimitError(`ElevenLabs usage limit reached during ${cutPlan.cutId}.`, {
        status: job.error?.status ?? null,
        cutId: cutPlan.cutId,
        takeIndex,
        mediaJob: paidMediaJobReceiptSummary(job),
      });
    }
    throw new Error(
      job.error?.message
        || `ElevenLabs media job ${job.jobId} is ${job.status}; recover the existing job instead of resubmitting.`,
    );
  }
  const artifactReader = context.artifactReader || readPaidMediaJobArtifact;
  const audioBuffer = await artifactReader(job, {
    fetchImpl: context.artifactFetch,
    signal: context.signal,
  });
  const voiceSegments = Array.isArray(job.result?.voiceSegments) ? job.result.voiceSegments : [];
  const expectedProviderInputCount = (cutPlan.providerInputs || cutPlan.inputs).length;
  if (voiceSegments.length < expectedProviderInputCount) {
    throw new Error(
      `Incomplete ElevenLabs dialogue result for ${cutPlan.cutId}; recover media job ${job.jobId} without resubmitting.`,
    );
  }
  return {
    audioBuffer,
    inputHash,
    job,
    mediaJobReceipt: typeof mediaJobBroker.receipt === "function"
      ? mediaJobBroker.receipt(job)
      : paidMediaJobReceiptSummary(job),
    outputFormat: job.result?.outputFormat || "wav_44100",
    requestId: job.result?.requestId || "",
    characterCost: finite(job.usage?.units, null),
    voiceSegments,
    alignment: job.result?.alignment || null,
  };
}

async function generateTake(cutPlan, takeIndex, context) {
  const body = buildKoyaDialogueRequest(cutPlan, takeIndex, context.pronunciationDictionaryLocators || null);
  const inputHash = sha256(JSON.stringify(body));
  const inputDigest = inputHash.slice(0, 12);
  const sourcePath = join(context.sourceDir, `${cutPlan.cutId}-take-${takeIndex + 1}-${inputDigest}-eleven-v3-dialogue.wav`);
  const metadataPath = `${sourcePath}.json`;
  try {
    const cached = JSON.parse(await readFile(metadataPath, "utf8"));
    if (cached.inputHash === inputHash && await exists(sourcePath)) {
      return { ...cached, sourcePath, metadataPath, reused: true };
    }
  } catch {}
  const media = await requestKoyaDialogueMediaJob(cutPlan, takeIndex, context);
  await writeFile(sourcePath, media.audioBuffer);
  const metadata = {
    version: 1,
    pipeline: "koya-dialogue-v44",
    cutId: cutPlan.cutId,
    takeIndex,
    inputHash,
    model: "eleven_v3",
    languageCode: "ja",
    requestId: media.requestId,
    characterCost: media.characterCost,
    mediaJobId: media.job.jobId,
    providerJobId: media.job.providerJobId,
    requestKey: media.job.requestKey,
    mediaJobReceipt: media.mediaJobReceipt,
    sourcePath,
    sourceDurationSeconds: await probeDuration(sourcePath),
    outputFormat: media.outputFormat,
    inputs: cutPlan.inputs,
    providerInputs: cutPlan.providerInputs || cutPlan.inputs,
    voiceSegments: media.voiceSegments,
    alignment: media.alignment,
    createdAt: new Date().toISOString(),
  };
  await writeJsonAtomic(metadataPath, metadata);
  return { ...metadata, metadataPath, reused: false };
}

// One entry per character of `speechText`, in this utterance's own output
// timeline. Balloon segments read it directly, so a segment boundary lands on
// the moment the voice reaches that character rather than on a character-count
// estimate that drifts across long lines.
export function buildCharacterTimeline(metadata, cutPlan, inputIndex, toOutputSeconds, speechBounds = {}) {
  const alignment = metadata?.alignment;
  const characters = alignment?.characters;
  const starts = alignment?.character_start_times_seconds;
  const ends = alignment?.character_end_times_seconds;
  if (!Array.isArray(characters) || !Array.isArray(starts) || !Array.isArray(ends)) return null;
  const providerInputIndices = cutPlan?.inputs?.[inputIndex]?.providerInputIndices || [inputIndex];
  const wanted = new Set(providerInputIndices.map(Number));
  const segments = (metadata.voiceSegments || [])
    .filter((segment) => wanted.has(Number(segment.dialogue_input_index)));
  if (segments.length === 0) return null;
  const from = Math.min(...segments.map((segment) => Number(segment.character_start_index)));
  const to = Math.max(...segments.map((segment) => Number(segment.character_end_index)));
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to > characters.length) return null;
  const window = characters.slice(from, to).join("");
  if (window.length !== to - from) return null;
  const speechText = String(cutPlan?.inputs?.[inputIndex]?.speechText || "");
  const offset = speechText.length > 0 ? window.indexOf(speechText) : -1;
  if (offset < 0) return null;
  const first = from + offset;
  const rows = [];
  for (let position = 0; position < speechText.length; position += 1) {
    const index = first + position;
    const startSeconds = Number(starts[index]);
    const endSeconds = Number(ends[index]);
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) return null;
    rows.push({
      char: characters[index],
      startSeconds: toOutputSeconds(startSeconds),
      endSeconds: toOutputSeconds(endSeconds),
    });
  }
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index].startSeconds < rows[index - 1].startSeconds - 0.001) return null;
  }
  // Anchor to the onset this file was actually measured at. Moving the split
  // off its reported boundary shifts every character time by the same amount,
  // and the alignment carries no way to know that happened.
  const speechStartSeconds = Number(speechBounds.speechStartSeconds);
  const speechEndSeconds = Number(speechBounds.speechEndSeconds);
  if (!Number.isFinite(speechStartSeconds) || !Number.isFinite(speechEndSeconds)) return null;
  const shift = speechStartSeconds - rows[0].startSeconds;
  const anchored = rows.map((row) => ({
    char: row.char,
    startSeconds: Number((row.startSeconds + shift).toFixed(6)),
    endSeconds: Number((row.endSeconds + shift).toFixed(6)),
  }));
  // A shifted timeline is only trustworthy if it still describes a line of
  // this length. The tolerance is asymmetric on purpose: the last character's
  // reported end excludes the vowel release, so the timeline legitimately
  // finishes a little before the measured speech end. Finishing *after* it
  // means the provider attributed a neighbour's speech to this line, and the
  // balloons would run late.
  const endDrift = anchored.at(-1).endSeconds - speechEndSeconds;
  if (endDrift > 0.15 || endDrift < -0.60) return null;
  return anchored;
}

// Sample the middle of a reported span. Alignment error concentrates at the
// edges, so the interior is a trustworthy sample of that speaker even when the
// boundary timestamps are wrong.
function interiorEnvelope(samples, span) {
  if (!span) return null;
  const duration = span.endSeconds - span.startSeconds;
  if (!(duration > 0.5)) return null;
  return spectralEnvelope(
    samples,
    span.startSeconds + duration * 0.35,
    span.startSeconds + duration * 0.75,
  );
}

async function resolveSplitBoundaries(cutPlan, selected) {
  const reported = cutPlan.inputs.map((_, index) => segmentBounds(selected, index, cutPlan));
  const spans = cutPlan.inputs.map((_, index) => (
    alignmentSpeechSpan(selected, cutPlan, index) || reported[index]
  ));
  const sources = cutPlan.inputs.map((_, index) => (
    alignmentSpeechSpan(selected, cutPlan, index) ? "alignment" : "provider-segment"
  ));
  let samples = null;
  try {
    samples = await decodeMonoSamples(selected.sourcePath);
  } catch {
    samples = null;
  }
  const boundaries = [0];
  const resolutions = [null];
  for (let index = 1; index < spans.length; index += 1) {
    const previousEnd = spans[index - 1].endSeconds;
    const currentStart = spans[index].startSeconds;
    if (!samples) {
      boundaries.push((previousEnd + currentStart) / 2);
      resolutions.push("reported-midpoint");
      continue;
    }
    // Search past the reported end, because the last character's timestamp
    // excludes the vowel release and the breath after it. The far edge stays
    // just past the next line's first character so a late pause inside that
    // line is not mistaken for the boundary.
    const searchFrom = Math.max(0, previousEnd - 0.02);
    const searchTo = currentStart + 0.25;
    let boundary = searchTo - searchFrom >= 0.04
      ? quietestBoundarySeconds(samples, searchFrom, searchTo)
      : (previousEnd + currentStart) / 2;
    let resolution = searchTo - searchFrom >= 0.04 ? "quietest-window" : "reported-midpoint";
    // The alignment is not always right either: on some boundaries the
    // provider reports a line ending more than a second before the performer
    // stops. Confirm with the two speakers' own timbre that the audio after
    // the cut really belongs to the incoming character, and walk to the next
    // silence while it does not.
    const speakerChanged = cutPlan.utterances?.[index - 1]?.speakerId !== cutPlan.utterances?.[index]?.speakerId;
    if (speakerChanged) {
      const previousInterior = interiorEnvelope(samples, spans[index - 1]);
      const currentInterior = interiorEnvelope(samples, spans[index]);
      if (previousInterior && currentInterior
        && envelopeDistance(previousInterior, currentInterior) >= 0.05) {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const after = spectralEnvelope(samples, boundary, boundary + 0.35);
          if (!after) break;
          const toPrevious = envelopeDistance(after, previousInterior);
          const toCurrent = envelopeDistance(after, currentInterior);
          if (toPrevious >= toCurrent * 0.7) break;
          const nextBoundary = quietestBoundarySeconds(samples, boundary + 0.12, boundary + 0.90);
          if (!(nextBoundary > boundary)) break;
          boundary = nextBoundary;
          resolution = "speaker-verified-extension";
        }
      }
    }
    // A cut placed at the quietest instant can sit well before the incoming
    // line actually starts. Left there it becomes a second of dead air at the
    // head of that line, so close the distance while staying inside silence.
    const audible = firstAudibleSeconds(samples, boundary, boundary + 2.5);
    if (audible !== null && audible - boundary > 0.30) {
      boundary = audible - 0.20;
      resolution = `${resolution}+lead-in-trimmed`;
    }
    boundaries.push(boundary);
    resolutions.push(resolution);
  }
  boundaries.push(selected.sourceDurationSeconds);
  // Boundaries must stay monotonic even when a span pair overlaps.
  for (let index = 1; index < boundaries.length; index += 1) {
    if (boundaries[index] < boundaries[index - 1]) boundaries[index] = boundaries[index - 1];
  }
  return { boundaries, spans, sources, resolutions };
}

async function splitSelectedTake(manifest, cutPlan, selected, context) {
  const { boundaries, spans, sources, resolutions } = await resolveSplitBoundaries(cutPlan, selected);
  const rows = [];
  for (let index = 0; index < cutPlan.inputs.length; index += 1) {
    const plan = cutPlan.inputs[index];
    const utterance = cutPlan.utterances[index];
    const trimStart = Math.max(0, boundaries[index]);
    const trimEnd = Math.min(selected.sourceDurationSeconds, boundaries[index + 1]);
    const sourceSplitPath = join(context.workDir, `${plan.utteranceId}.source-split.wav`);
    const acousticSafePath = join(context.workDir, `${plan.utteranceId}.acoustic-safe.wav`);
    const compactPath = join(context.workDir, `${plan.utteranceId}.compact.wav`);
    const rawPath = join(context.workDir, `${plan.utteranceId}.raw.wav`);
    const outputPath = join(context.audioDir, `${manifest.id}-${plan.utteranceId}-koya-v44.wav`);
    const sourceFilters = [
      "aresample=48000",
      `atrim=duration=${Math.max(0.1, trimEnd - trimStart).toFixed(6)}`,
      "asetpts=PTS-STARTPTS",
    ];
    await execFile("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-ss", trimStart.toFixed(6), "-i", selected.sourcePath,
      "-vn", "-af", sourceFilters.join(","), "-ar", "48000", "-ac", "1", "-c:a", "pcm_s24le", sourceSplitPath,
    ]);
    const detectedBounds = await detectAcousticSpeechBounds(sourceSplitPath);
    // The onset detector is deliberately sensitive, which means it also marks
    // residue an order of magnitude below audibility as speech. Left alone
    // that residue becomes seconds of dead air inside the line and pushes the
    // measured speech end far past the last word actually spoken.
    const acousticBounds = await refineAudibleBounds(sourceSplitPath, detectedBounds);
    const requestedHeadPadding = finite(context.contract.audio.acousticHeadPaddingSeconds, 0.1);
    const requestedTailPadding = finite(context.contract.audio.minimumReleasePaddingSeconds, 0.045);
    const acousticTrimStartSeconds = Math.max(0, acousticBounds.startSeconds - requestedHeadPadding);
    const acousticTrimEndSeconds = Math.min(
      acousticBounds.durationSeconds,
      acousticBounds.endSeconds + requestedTailPadding,
    );
    const syntheticHeadSeconds = Math.max(
      0,
      requestedHeadPadding - (acousticBounds.startSeconds - acousticTrimStartSeconds),
    );
    const syntheticTailSeconds = Math.max(
      0,
      requestedTailPadding - (acousticTrimEndSeconds - acousticBounds.endSeconds),
    );
    const safeFilters = [
      `atrim=duration=${Math.max(0.1, acousticTrimEndSeconds - acousticTrimStartSeconds).toFixed(6)}`,
      "asetpts=PTS-STARTPTS",
    ];
    if (syntheticHeadSeconds > 0.0005) safeFilters.push(`adelay=${Math.round(syntheticHeadSeconds * 1000)}:all=1`);
    if (syntheticTailSeconds > 0.0005) safeFilters.push(`apad=pad_dur=${syntheticTailSeconds.toFixed(6)}`);
    await execFile("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-ss", acousticTrimStartSeconds.toFixed(6), "-i", sourceSplitPath,
      "-af", safeFilters.join(","), "-ar", "48000", "-ac", "1", "-c:a", "pcm_s24le", acousticSafePath,
    ]);
    const silenceCompaction = await compactLiteralSilence(acousticSafePath, compactPath, 0.68);
    const rawSpeechStartSeconds = Math.max(
      0,
      acousticBounds.startSeconds - acousticTrimStartSeconds + syntheticHeadSeconds,
    );
    const rawSpeechEndSeconds = Math.max(
      rawSpeechStartSeconds,
      acousticBounds.endSeconds - acousticTrimStartSeconds + syntheticHeadSeconds,
    );
    const removedBeforeSpeechEndSeconds = (silenceCompaction.edits || [])
      .filter((edit) => Number(edit.end) <= rawSpeechEndSeconds + 0.001)
      .reduce((sum, edit) => sum + Math.max(0, Number(edit.removedSeconds) || 0), 0);
    const compactDurationSeconds = await probeDuration(compactPath);
    const speechStartSeconds = rawSpeechStartSeconds;
    const speechEndSeconds = Math.min(
      compactDurationSeconds,
      Math.max(speechStartSeconds, rawSpeechEndSeconds - removedBeforeSpeechEndSeconds),
    );
    const fadeInSeconds = Math.min(
      context.contract.audio.joinFadeInMilliseconds / 1000,
      Math.max(0.001, compactDurationSeconds - speechStartSeconds),
    );
    const fadeOutSeconds = Math.min(
      context.contract.audio.joinFadeOutMilliseconds / 1000,
      Math.max(0.001, speechEndSeconds - speechStartSeconds),
    );
    const edgeFilters = [];
    if (fadeInSeconds > 0.0005) {
      edgeFilters.push(`afade=t=in:st=${speechStartSeconds.toFixed(6)}:d=${fadeInSeconds.toFixed(6)}`);
    }
    if (fadeOutSeconds > 0.0005) {
      edgeFilters.push(
        `afade=t=out:st=${Math.max(speechStartSeconds, speechEndSeconds - fadeOutSeconds).toFixed(6)}:`
        + `d=${fadeOutSeconds.toFixed(6)}`,
      );
    }
    await execFile("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-i", compactPath,
      ...(edgeFilters.length > 0 ? ["-af", edgeFilters.join(",")] : []),
      "-ar", "48000", "-ac", "1", "-c:a", "pcm_s24le", rawPath,
    ]);
    await normalizeLineTwoPass(rawPath, outputPath, context.contract.audio.targetLineLufs);
    await Promise.all([
      sourceSplitPath,
      acousticSafePath,
      compactPath,
      rawPath,
    ].map((path) => unlink(path).catch(() => {})));
    const durationSeconds = await probeDuration(outputPath);
    // Map the provider's per-character times from take-relative seconds into
    // this WAV's own timeline so balloons can follow the real voice instead of
    // interpolating on character counts.
    const toOutputSeconds = (takeSeconds) => {
      const safeSeconds = takeSeconds - trimStart - acousticTrimStartSeconds + syntheticHeadSeconds;
      const removed = (silenceCompaction.edits || []).reduce((sum, edit) => (
        safeSeconds > Number(edit.start) + Number(edit.retainedSeconds || 0)
          ? sum + Math.max(0, Number(edit.removedSeconds) || 0)
          : sum
      ), 0);
      return Number((safeSeconds - removed).toFixed(6));
    };
    const characterTimeline = buildCharacterTimeline(selected, cutPlan, index, toOutputSeconds, { speechStartSeconds, speechEndSeconds });
    const sidecar = {
      version: 1,
      pipeline: "koya-dialogue-v44",
      utteranceId: utterance.id,
      provider: "elevenlabs",
      generationMode: "text-to-dialogue-with-timestamps",
      model: "eleven_v3",
      voiceId: utterance.voiceId,
      voiceName: utterance.voiceName || "",
      displayText: plan.displayText,
      speechText: plan.speechText,
      providerText: plan.providerText,
      performancePrompt: plan.performancePrompt,
      durationSeconds,
      speechStartSeconds,
      speechEndSeconds,
      outputHeadPaddingSeconds: speechStartSeconds,
      outputTailPaddingSeconds: Math.max(0, durationSeconds - speechEndSeconds),
      releasePaddingSeconds: Math.max(0, durationSeconds - speechEndSeconds),
      acousticSpeechDetection: acousticBounds,
      acousticTrimStartSeconds,
      acousticTrimEndSeconds,
      acousticSafetyPaddingSeconds: requestedHeadPadding,
      silenceCompaction,
      splitBoundary: {
        startSeconds: Number(trimStart.toFixed(6)),
        endSeconds: Number(trimEnd.toFixed(6)),
        source: sources[index],
        resolution: resolutions[index] || "cut-start",
        alignmentSpan: spans[index]
          ? {
            startSeconds: Number(Number(spans[index].startSeconds).toFixed(6)),
            endSeconds: Number(Number(spans[index].endSeconds).toFixed(6)),
          }
          : null,
      },
      characterTimeline,
      sourceDialoguePath: selected.sourcePath,
      sourceDialogueMetadataPath: selected.metadataPath,
      sourceDialogueRequestId: selected.requestId,
      dialogueInputIndex: index,
      selectedTakeIndex: selected.takeIndex,
      candidateSelection: selected.candidateSelection,
      outputFormat: "wav_48000_pcm_s24le_loudnorm_two_pass",
      splitFadeInMilliseconds: Number((fadeInSeconds * 1000).toFixed(3)),
      splitFadeOutMilliseconds: Number((fadeOutSeconds * 1000).toFixed(3)),
      createdAt: new Date().toISOString(),
      fileName: basename(outputPath),
      filePath: outputPath,
      alignmentFileName: `${basename(outputPath)}.json`,
      alignmentPath: join(context.alignmentDir, `${basename(outputPath)}.json`),
      assetUrl: `/excalidraw-assets/audio/${encodeURIComponent(basename(outputPath))}`,
      mimeType: "audio/wav",
    };
    await writeJsonAtomic(sidecar.alignmentPath, sidecar);
    Object.assign(utterance, {
      speechText: plan.speechText,
      performancePrompt: plan.performancePrompt,
      model: "eleven_v3",
      audio: sidecar,
    });
    rows.push(sidecar);
  }
  return rows;
}

function gateWantedForCut(options) {
  return options.voiceQualityGate === true
    || (options.voiceQualityGate !== false && process.env.KOYA_VOICE_QUALITY_GATE === "1");
}

const SPEECH_TEXT_PREFLIGHT = fileURLToPath(new URL("../scripts/prepare-speech-text.py", import.meta.url));

async function runSpeechTextPreflight(texts, dictionaryPath) {
  const { mkdtemp, rm, writeFile: write } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const workDir = await mkdtemp(join(tmpdir(), "koya-speech-preflight-"));
  const configPath = join(workDir, "texts.json");
  try {
    await write(configPath, `${JSON.stringify({ texts, dictionary: dictionaryPath })}\n`);
    const runtime = await resolvePythonRuntime({
      purposeEnv: "KOYA_SPEECH_PREFLIGHT_PYTHON",
      projectDir: resolve(dirname(SPEECH_TEXT_PREFLIGHT), ".."),
      requiredModules: [],
    });
    if (!runtime.ok) {
      throw new Error(`Koya speech-text preflight Python is unavailable: ${runtime.detail || "no usable Python 3.9+ runtime"}`);
    }
    const { stdout } = await execFile(runtime.command, [...runtime.args, SPEECH_TEXT_PREFLIGHT, configPath], {
      maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function generateKoyaDialogueSpeechSerial(options = {}) {
  const manifestPath = resolve(options.manifestPath || "");
  if (!options.manifest && !options.manifestPath) throw new Error("manifestPath is required.");
  const manifest = options.manifest ? structuredClone(options.manifest) : JSON.parse(await readFile(manifestPath, "utf8"));
  const contract = options.contract?.contract || options.contract;
  if (!contract) throw new Error("A resolved Koya production contract is required.");
  const episodeDir = dirname(manifestPath);
  const canvasDir = resolve(options.canvasDir || join(episodeDir, "../.."));
  const sourceDir = resolve(options.sourceDir || join(episodeDir, ".koya-dialogue-source"));
  const workDir = resolve(options.workDir || join(episodeDir, ".koya-dialogue-work"));
  const audioDir = resolve(options.audioDir || join(canvasDir, "assets/audio"));
  const alignmentDir = resolve(options.alignmentDir || join(canvasDir, "audio-alignments"));
  await Promise.all([sourceDir, workDir, audioDir, alignmentDir].map((path) => mkdir(path, { recursive: true })));
  // Channel reading dictionary (R194 phase 3): active entries merge under the
  // episode's own pronunciations so every cut benefits from promoted fixes.
  const readingDictionaryPath = options.readingDictionaryPath
    || join(resolve(options.projectDir || join(canvasDir, "..")), "config/koya-reading-dictionary.json");
  const readingDictionary = await readReadingDictionary(readingDictionaryPath);
  manifest.speech = {
    ...(manifest.speech || {}),
    pronunciations: mergeIntoPronunciations(readingDictionary, manifest.speech?.pronunciations || []),
  };
  // When the channel dictionary has been synced to ElevenLabs
  // (scripts/sync-elevenlabs-reading-dictionary.mjs stores the ids), apply it
  // natively inside the API as well as via local text substitution.
  const dictionarySync = readingDictionary.elevenlabs;
  // Stale-sync guard: attach the native dictionary only when its synced rule
  // hash still matches the current active rule set; otherwise the API would
  // apply outdated readings (local substitution stays authoritative).
  const { buildElevenLabsRules, readingRulesHash } = await import("./readingDictionary.mjs");
  const currentRulesHash = readingRulesHash(buildElevenLabsRules(readingDictionary));
  const pronunciationDictionaryLocators = dictionarySync?.dictionaryId && dictionarySync.rulesHash === currentRulesHash
    ? [{ pronunciation_dictionary_id: dictionarySync.dictionaryId, version_id: dictionarySync.versionId || undefined }]
    : null;
  const report = {
    version: "koya-dialogue-v44",
    episodeId: manifest.id,
    manifestPath,
    status: "running",
    mediaJobs: [],
    cuts: [],
    knownRemainingIssues: [],
    updatedAt: new Date().toISOString(),
  };
  const reportPath = resolve(options.reportPath || join(episodeDir, "koya-dialogue-generation.json"));
  const requestedCuts = new Set(options.cutIds || []);
  // R199: 音声QAの可用性は **有料生成より前に** 一度だけ確かめる。
  // これまでは cut ごとに、しかも generateTake でテイクを作った後に見ていたので、
  // QA環境が無い環境では課金してから停止していた。1回で済むうえ、
  // 止まるときは1円も使わずに止まる。
  const gateWantedGlobally = options.voiceQualityGate === true
    || (options.voiceQualityGate !== false && process.env.KOYA_VOICE_QUALITY_GATE === "1");
  if (!options.skipGlobalVoiceQualityPreflight && gateWantedGlobally && (manifest.cuts || []).length > 0) {
    if (!(await (options.voiceQualityAvailableImpl || voiceQualityAvailable)())) {
      throw new Error(
        "R194 音声品質ゲートが要求されていますが、python の QA 実行系が使えません。"
        + "有料生成を始める前に停止しました（VOICE_QA_PYTHON を確認してください）。",
      );
    }
  }

  for (const cut of manifest.cuts || []) {
    if (requestedCuts.size > 0 && !requestedCuts.has(cut.id)) continue;
    const cutPlan = prepareKoyaDialogueCut(manifest, cut, { takeCount: options.takeCount || contract.audio.takeCount });
    if (options.dryRun) {
      report.cuts.push({ cutId: cut.id, status: "planned", takeCount: cutPlan.takeCount, utteranceCount: cutPlan.inputs.length });
      continue;
    }
    const approvedCheckpoint = await (options.approvedCheckpointImpl || approvedKoyaDialogueCutCheckpoint)(cutPlan);
    if (approvedCheckpoint) {
      report.mediaJobs = mergeKoyaDialogueMediaJobReceipts(
        report.mediaJobs,
        await checkpointKoyaDialogueMediaJobs(cutPlan),
      );
      const checkpointSelection = cutPlan.utterances?.[0]?.audio?.candidateSelection;
      const checkpointVoiceQualityByTake = Object.fromEntries(
        (checkpointSelection?.candidates || [])
          .filter((candidate) => Number.isInteger(Number(candidate?.takeIndex)) && candidate?.voiceQuality)
          .map((candidate) => [Number(candidate.takeIndex), candidate.voiceQuality]),
      );
      // A resumable checkpoint already carries the complete R194 evidence in
      // every selected utterance sidecar. Mirror that evidence into the
      // reviewer-facing per-cut report as well; otherwise an older partial
      // report can misleadingly omit the selected adaptive take.
      await writeJsonAtomic(join(sourceDir, `${cut.id}-voice-quality.json`), {
        cutId: cut.id,
        selectedTakeIndex: approvedCheckpoint.selectedTakeIndex,
        selectedSourcePath: approvedCheckpoint.sourcePath,
        byTake: checkpointVoiceQualityByTake,
      });
      report.cuts.push({
        cutId: cut.id,
        status: "complete",
        selectedTakeIndex: approvedCheckpoint.selectedTakeIndex,
        sourcePath: approvedCheckpoint.sourcePath,
        utteranceCount: cutPlan.inputs.length,
        voiceQualityGate: "reused-approved-checkpoint",
      });
      report.updatedAt = new Date().toISOString();
      await Promise.all([writeJsonAtomic(manifestPath, manifest), writeJsonAtomic(reportPath, report)]);
      continue;
    }
    try {
      // R194 anti-circularity: fill missing expectedReading from the preflight,
      // adopting ONLY readings it marks confirmed (flag-free lines). A flagged
      // line stays empty so the CER gate cannot certify it against a guess.
      const qaInputs = cutPlan.providerInputs || cutPlan.inputs;
      if (gateWantedForCut(options) && qaInputs.some((entry) => !entry.expectedReading)) {
        try {
          const preflight = await runSpeechTextPreflight(
            qaInputs.map((entry) => ({ id: entry.utteranceId, text: entry.speechText })),
            readingDictionaryPath,
          );
          const byId = new Map((preflight.rows || []).map((row) => [row.id, row]));
          for (const entry of qaInputs) {
            const row = byId.get(entry.utteranceId);
            if (!entry.expectedReading && row?.readingConfirmed && row.expectedReading) {
              entry.expectedReading = row.expectedReading;
              entry.expectedReadingSource = "preflight-confirmed";
            }
          }
        } catch (preflightError) {
          report.knownRemainingIssues.push({
            id: `preflight:${cut.id}`,
            detail: String(preflightError.message).slice(0, 200),
          });
        }
      }
      // 初期テイクは互いに独立した有償生成で、品質ゲートは全候補が
      // 揃ってから走る。1本ずつ待つ理由がないので同時に投げる。
      // Promise.all は入力順で返すため、テイク番号と候補の対応は
      // 逐次実行と変わらない（選定はインデックスで参照される）。
      const initialTakeOutcomes = await Promise.allSettled(
        Array.from(
          { length: cutPlan.takeCount },
          (_unused, takeIndex) => generateTake(
            cutPlan,
            takeIndex,
            { ...options, sourceDir, pronunciationDictionaryLocators },
          ),
        ),
      );
      const candidates = initialTakeOutcomes
        .filter((outcome) => outcome.status === "fulfilled")
        .map((outcome) => outcome.value);
      report.mediaJobs = mergeKoyaDialogueMediaJobReceipts(
        report.mediaJobs,
        candidates.map((candidate) => candidate.mediaJobReceipt),
      );
      const initialFailure = initialTakeOutcomes.find((outcome) => outcome.status === "rejected");
      if (initialFailure) throw initialFailure.reason;
      const forcedTakeIndex = options.forcedTakes?.[cut.id];
      // R194 voice quality gate (fail-closed): when the gate is requested, an
      // unavailable QA stack or an all-fail take set stops the cut instead of
      // silently degrading to unguarded selection (Codex review 2026-08-28).
      let voiceQualityByTake = null;
      let voiceQualityNote = "disabled";
      const gateWanted = options.voiceQualityGate === true
        || (options.voiceQualityGate !== false && process.env.KOYA_VOICE_QUALITY_GATE === "1");
      if (gateWanted) {
        // 生成前に一度確認済み。ここは実行中に環境が壊れた場合の保険で、
        // 通常は即座に true を返す。
        if (!(await (options.voiceQualityAvailableImpl || voiceQualityAvailable)())) {
          throw new Error(`R194 voice quality gate requested for ${cut.id} but the python QA stack is unavailable`);
        }
        const gateCache = new Map();
        const segmentUtmos = new Set(qaInputs.map((entry) => entry.voiceId).filter(Boolean)).size > 1;
        const runGate = async () => {
          const pending = candidates.filter((candidate) => !gateCache.has(candidate.sourcePath));
          const gateReport = pending.length === 0 ? { checks: [] } : await auditVoiceQuality({
            checks: pending.map((candidate) => ({
              id: `take-${candidate.takeIndex}`,
              type: "voiceQuality",
              audio: candidate.sourcePath,
              // UTMOS models a continuous single performance. A multi-speaker
              // dialogue can score below the floor solely at legitimate voice
              // changes, so enforce the unchanged 2.7 floor on every speaker
              // segment while retaining the combined score as a warning.
              segmentUtmos,
              segments: qaInputs.map((entry, inputIndex) => {
                // Provider segment times are approximate; pad the CER window
                // toward the neighbouring utterances so a shifted boundary
                // cannot truncate the first/last mora into a false CER hit.
                const bounds = segmentBounds(candidate, inputIndex);
                const previousEnd = inputIndex === 0 ? 0 : segmentBounds(candidate, inputIndex - 1).endSeconds;
                const nextStart = inputIndex === qaInputs.length - 1
                  ? Number.POSITIVE_INFINITY
                  : segmentBounds(candidate, inputIndex + 1).startSeconds;
                return {
                  id: entry.utteranceId,
                  start: Math.max(previousEnd, bounds.startSeconds - 0.2),
                  end: Math.min(nextStart, bounds.endSeconds + 0.2),
                  expectedText: entry.speechText,
                  expectedReading: entry.expectedReading || "",
                };
              }),
            })),
          });
          for (const check of gateReport.checks) {
            const takeIndex = Number(check.id.replace("take-", ""));
            const candidate = candidates.find((entry) => entry.takeIndex === takeIndex);
            if (candidate) {
              gateCache.set(candidate.sourcePath, voiceQualityPenalty(check, { requiredMetrics: ["utmos", "cer"] }));
            }
          }
          const merged = Object.fromEntries(candidates.map((candidate) => [
            candidate.takeIndex,
            gateCache.get(candidate.sourcePath),
          ]));
          await writeJsonAtomic(join(sourceDir, `${cut.id}-voice-quality.json`), {
            cutId: cut.id,
            selectedTakeIndex: null,
            selectedSourcePath: null,
            byTake: merged,
          });
          return merged;
        };
        voiceQualityByTake = await runGate();
        const allFailed = () => Object.values(voiceQualityByTake).every((entry) => entry.hardFail);
        const maxAdaptiveTakes = Math.min(8, Math.max(cutPlan.takeCount, options.maxAdaptiveTakes ?? 4));
        while (allFailed() && candidates.length < maxAdaptiveTakes && !Number.isInteger(forcedTakeIndex)) {
          const adaptive = await generateTake(cutPlan, candidates.length, { ...options, sourceDir, pronunciationDictionaryLocators });
          candidates.push(adaptive);
          report.mediaJobs = mergeKoyaDialogueMediaJobReceipts(report.mediaJobs, [adaptive.mediaJobReceipt]);
          voiceQualityByTake = await runGate();
        }
        if (allFailed() && !Number.isInteger(forcedTakeIndex)) {
          const worst = Object.values(voiceQualityByTake).flatMap((entry) => entry.problems).slice(0, 4).join("; ");
          throw new Error(`R194 voice quality gate rejected all ${candidates.length} takes for ${cut.id}: ${worst}`);
        }
        const unavailableNotes = [...new Set(Object.values(voiceQualityByTake).flatMap((entry) => entry.unavailable))];
        voiceQualityNote = unavailableNotes.length > 0
          ? `applied-with-unavailable: ${unavailableNotes.join(" | ").slice(0, 200)}`
          : "applied";
      }
      const selected = selectKoyaDialogueTake(
        candidates, cutPlan, forcedTakeIndex, voiceQualityByTake,
        options.forcedTakeReasons?.[cut.id] ?? "",
      );
      if (voiceQualityByTake) {
        await writeJsonAtomic(join(sourceDir, `${cut.id}-voice-quality.json`), {
          cutId: cut.id,
          selectedTakeIndex: selected.takeIndex,
          selectedSourcePath: selected.sourcePath,
          byTake: voiceQualityByTake,
        });
      }
      const rows = await splitSelectedTake(manifest, cutPlan, selected, {
        contract, workDir, audioDir, alignmentDir,
      });
      report.cuts.push({
        cutId: cut.id,
        status: "complete",
        selectedTakeIndex: selected.takeIndex,
        sourcePath: selected.sourcePath,
        utteranceCount: rows.length,
        voiceQualityGate: voiceQualityNote,
      });
      report.updatedAt = new Date().toISOString();
      await Promise.all([writeJsonAtomic(manifestPath, manifest), writeJsonAtomic(reportPath, report)]);
    } catch (error) {
      if (error instanceof KoyaUsageLimitError) {
        report.status = "waiting-usage-limit";
        report.checkpointVersion = KOYA_SPEECH_CHECKPOINT_VERSION;
        report.completedCutIds = [];
        report.pendingCutIds = [cut.id];
        report.knownRemainingIssues = [{ id: "usage-limit", detail: error.message }];
        report.updatedAt = new Date().toISOString();
        manifest.status = "waiting-usage-limit";
        manifest.production = {
          ...(manifest.production || {}),
          checkpoint: {
            version: KOYA_SPEECH_CHECKPOINT_VERSION,
            stage: "speech",
            completedCutIds: [],
            pendingCutIds: [cut.id],
            duplicateGenerationPrevented: true,
          },
        };
        await Promise.all([writeJsonAtomic(manifestPath, manifest), writeJsonAtomic(reportPath, report)]);
        return { manifest, manifestPath, report, reportPath, waiting: true };
      }
      report.status = "failed";
      report.knownRemainingIssues = [{ id: `speech:${cut.id}`, detail: error.message }];
      await writeJsonAtomic(reportPath, report);
      error.mediaJobs = [...report.mediaJobs];
      throw error;
    }
  }
  report.status = options.dryRun ? "planned" : "complete";
  report.knownRemainingIssues = [];
  report.updatedAt = new Date().toISOString();
  if (!options.dryRun) {
    manifest.status = "speech-ready";
    manifest.production = {
      ...(manifest.production || {}),
      audioPipeline: { version: report.version, reportPath, takeCount: contract.audio.takeCount },
    };
    await writeJsonAtomic(manifestPath, manifest);
  }
  await writeJsonAtomic(reportPath, report);
  return { manifest, manifestPath, report, reportPath, waiting: false };
}

function normalizeRequestedCutIds(value) {
  if (value === undefined || value === null || value === "") return [];
  const rows = Array.isArray(value) ? value : String(value).split(",");
  return [...new Set(rows.map((entry) => String(entry || "").trim()).filter(Boolean))];
}

function safeCutFilePart(value) {
  return String(value || "cut").replace(/[^a-zA-Z0-9_-]+/gu, "-").slice(0, 100) || "cut";
}

function reusedCheckpointReportRow(cutPlan, checkpoint) {
  return {
    cutId: cutPlan.cutId,
    status: "complete",
    selectedTakeIndex: checkpoint.selectedTakeIndex,
    sourcePath: checkpoint.sourcePath,
    utteranceCount: cutPlan.inputs.length,
    voiceQualityGate: "reused-approved-checkpoint",
  };
}

/**
 * Public Koya speech coordinator. Each worker owns one cut and an isolated
 * manifest/report; only the collector below may mutate the canonical files.
 * Completed-cut sets replace the historical nextCutId cursor, so out-of-order
 * completion remains resumable without duplicate paid generation.
 */
export async function generateKoyaDialogueSpeech(options = {}) {
  const manifestPath = resolve(options.manifestPath || "");
  if (!options.manifest && !options.manifestPath) throw new Error("manifestPath is required.");
  const manifest = options.manifest
    ? structuredClone(options.manifest)
    : JSON.parse(await readFile(manifestPath, "utf8"));
  const contract = options.contract?.contract || options.contract;
  if (!contract) throw new Error("A resolved Koya production contract is required.");

  const episodeDir = dirname(manifestPath);
  const canvasDir = resolve(options.canvasDir || join(episodeDir, "../.."));
  const sourceDir = resolve(options.sourceDir || join(episodeDir, ".koya-dialogue-source"));
  const workDir = resolve(options.workDir || join(episodeDir, ".koya-dialogue-work"));
  const audioDir = resolve(options.audioDir || join(canvasDir, "assets/audio"));
  const alignmentDir = resolve(options.alignmentDir || join(canvasDir, "audio-alignments"));
  const reportPath = resolve(options.reportPath || join(episodeDir, "koya-dialogue-generation.json"));
  await Promise.all([sourceDir, workDir, audioDir, alignmentDir, dirname(reportPath)].map(
    (path) => mkdir(path, { recursive: true }),
  ));

  const readingDictionaryPath = options.readingDictionaryPath
    || join(resolve(options.projectDir || join(canvasDir, "..")), "config/koya-reading-dictionary.json");
  const readingDictionary = await readReadingDictionary(readingDictionaryPath);
  manifest.speech = {
    ...(manifest.speech || {}),
    pronunciations: mergeIntoPronunciations(readingDictionary, manifest.speech?.pronunciations || []),
  };

  const cuts = Array.isArray(manifest.cuts) ? manifest.cuts : [];
  const utteranceOwner = new Map();
  for (const cut of cuts) {
    for (const utteranceId of cut.utteranceIds || []) {
      const owner = utteranceOwner.get(utteranceId);
      if (owner && owner !== cut.id) {
        throw new Error(`Koya speech utterance ${utteranceId} belongs to multiple cuts (${owner}, ${cut.id}); parallel ownership is ambiguous.`);
      }
      utteranceOwner.set(utteranceId, cut.id);
    }
  }
  const cutById = new Map(cuts.map((cut) => [cut.id, cut]));
  const requestedCutIds = normalizeRequestedCutIds(options.cutIds);
  const unknownCutIds = requestedCutIds.filter((id) => !cutById.has(id));
  if (unknownCutIds.length > 0) throw new Error(`Unknown Koya speech cutIds: ${unknownCutIds.join(", ")}.`);
  const selectedIds = new Set(requestedCutIds.length > 0 ? requestedCutIds : cuts.map((cut) => cut.id));
  const takeCount = clamp(options.takeCount ?? contract.audio.takeCount ?? 2, 2, 8);
  const concurrency = normalizeKoyaSpeechCutConcurrency(options.speechConcurrency, takeCount);
  const enforceMediaJobReceipts = typeof options.cutRunner !== "function"
    || options.requireMediaJobReceipts === true;
  const cutPlans = cuts.map((cut) => ({
    cut,
    plan: prepareKoyaDialogueCut(manifest, cut, { takeCount }),
  }));

  const gateWanted = options.voiceQualityGate === true
    || (options.voiceQualityGate !== false && process.env.KOYA_VOICE_QUALITY_GATE === "1");
  if (gateWanted && cuts.length > 0
    && !(await (options.voiceQualityAvailableImpl || voiceQualityAvailable)())) {
    throw new Error(
      "R194 音声品質ゲートが要求されていますが、python の QA 実行系が使えません。"
      + "有料生成を始める前に停止しました（VOICE_QA_PYTHON を確認してください）。",
    );
  }

  const approvedCheckpointImpl = options.approvedCheckpointImpl || approvedKoyaDialogueCutCheckpoint;
  const checkpointRows = await Promise.all(cutPlans.map(async ({ cut, plan }) => {
    const checkpoint = await approvedCheckpointImpl(plan);
    return {
      cut,
      plan,
      checkpoint,
      checkpointMediaJobs: checkpoint && typeof options.cutRunner !== "function"
        ? await checkpointKoyaDialogueMediaJobs(plan)
        : [],
    };
  }));
  let previousReport = null;
  try { previousReport = JSON.parse(await readFile(reportPath, "utf8")); } catch {}
  let collectedMediaJobs = previousReport?.episodeId === manifest.id
    && resolve(previousReport?.manifestPath || "") === manifestPath
    ? mergeKoyaDialogueMediaJobReceipts([], previousReport.mediaJobs || [])
    : [];
  for (const row of checkpointRows) {
    collectedMediaJobs = mergeKoyaDialogueMediaJobReceipts(collectedMediaJobs, row.checkpointMediaJobs);
  }
  const completed = new Set(checkpointRows.filter((entry) => entry.checkpoint).map((entry) => entry.cut.id));
  const rowByCut = new Map(checkpointRows.map(({ cut, plan, checkpoint }) => [
    cut.id,
    checkpoint
      ? reusedCheckpointReportRow(plan, checkpoint)
      : {
        cutId: cut.id,
        status: selectedIds.has(cut.id) ? "pending" : "not-selected",
        takeCount: plan.takeCount,
        utteranceCount: plan.inputs.length,
      },
  ]));
  const report = {
    version: "koya-dialogue-v44",
    checkpointVersion: KOYA_SPEECH_CHECKPOINT_VERSION,
    episodeId: manifest.id,
    manifestPath,
    status: options.dryRun ? "planned" : "running",
    mediaJobs: collectedMediaJobs,
    concurrency: {
      cutWorkers: concurrency,
      takesPerCut: takeCount,
      paidRequestLimit: KOYA_PAID_SPEECH_REQUEST_CONCURRENCY_LIMIT,
    },
    requestedCutIds: [...selectedIds],
    completedCutIds: [],
    pendingCutIds: [],
    cuts: [],
    knownRemainingIssues: [],
    updatedAt: new Date().toISOString(),
  };

  const orderedIds = cuts.map((cut) => cut.id);
  const syncDerivedState = () => {
    report.completedCutIds = orderedIds.filter((id) => completed.has(id));
    report.pendingCutIds = orderedIds.filter((id) => !completed.has(id));
    report.cuts = orderedIds.map((id) => rowByCut.get(id)).filter(Boolean);
    report.mediaJobs = [...collectedMediaJobs];
    report.updatedAt = new Date().toISOString();
    const production = { ...(manifest.production || {}) };
    if (report.pendingCutIds.length > 0) {
      production.checkpoint = {
        version: KOYA_SPEECH_CHECKPOINT_VERSION,
        stage: "speech",
        completedCutIds: [...report.completedCutIds],
        pendingCutIds: [...report.pendingCutIds],
        duplicateGenerationPrevented: true,
        collectorOnlySharedWrites: true,
        updatedAt: report.updatedAt,
      };
    } else {
      delete production.checkpoint;
    }
    manifest.production = production;
  };
  const persistCanonical = async () => {
    syncDerivedState();
    await writeJsonAtomic(manifestPath, manifest);
    await writeJsonAtomic(reportPath, report);
  };

  if (options.dryRun) {
    for (const { cut, plan, checkpoint } of checkpointRows) {
      if (selectedIds.has(cut.id) && !checkpoint) {
        rowByCut.set(cut.id, {
          cutId: cut.id,
          status: "planned",
          takeCount: plan.takeCount,
          utteranceCount: plan.inputs.length,
        });
      }
    }
    syncDerivedState();
    await writeJsonAtomic(reportPath, report);
    return { manifest, manifestPath, report, reportPath, waiting: false, partial: false, planned: true };
  }

  const pendingSelected = checkpointRows
    .filter(({ cut, checkpoint }) => selectedIds.has(cut.id) && !checkpoint)
    .map(({ cut }) => cut);
  // A caller-owned gate that must pass before any paid request. It runs only
  // when at least one selected cut would really be generated, and before any
  // file is written, so a refusal leaves the manifest and report untouched.
  if (pendingSelected.length > 0 && typeof options.beforePaidSpeech === "function") {
    await options.beforePaidSpeech({
      manifest: structuredClone(manifest),
      pendingCutIds: pendingSelected.map((cut) => cut.id),
    });
  }
  // Persist the set checkpoint before the first paid request. A crash can
  // therefore never restore the obsolete sequential nextCutId authority.
  await persistCanonical();
  const canonicalUtteranceById = new Map((manifest.utterances || []).map((entry) => [entry.id, entry]));
  const defaultCutRunner = async ({ cut, workerManifest, index }) => {
    const filePart = `${String(index).padStart(4, "0")}-${safeCutFilePart(cut.id)}`;
    const isolatedDir = join(workDir, ".cut-workers");
    await mkdir(isolatedDir, { recursive: true });
    const isolatedManifestPath = join(isolatedDir, `${filePart}.manifest.json`);
    const isolatedReportPath = join(isolatedDir, `${filePart}.report.json`);
    const result = await generateKoyaDialogueSpeechSerial({
      ...options,
      beforePaidSpeech: undefined,
      manifest: workerManifest,
      manifestPath: isolatedManifestPath,
      reportPath: isolatedReportPath,
      canvasDir,
      sourceDir,
      workDir,
      audioDir,
      alignmentDir,
      cutIds: [cut.id],
      takeCount,
      speechConcurrency: 1,
      skipGlobalVoiceQualityPreflight: true,
      approvedCheckpointImpl,
    });
    if (result.waiting) {
      const error = new KoyaUsageLimitError(
        result.report?.knownRemainingIssues?.[0]?.detail || `Speech usage limit reached during ${cut.id}.`,
        { cutId: cut.id },
      );
      error.partialResult = result;
      error.mediaJobs = Array.isArray(result.report?.mediaJobs) ? result.report.mediaJobs : [];
      throw error;
    }
    return {
      cutId: cut.id,
      manifest: result.manifest,
      reportRow: result.report.cuts.find((row) => row.cutId === cut.id),
      mediaJobs: result.report.mediaJobs || [],
    };
  };
  const cutRunner = options.cutRunner || defaultCutRunner;

  const pool = await runKoyaSpeechCutPool(pendingSelected, {
    concurrency,
    shouldStop: async () => (
      options.signal?.aborted === true
      || (typeof options.isCancellationRequested === "function" && await options.isCancellationRequested())
    ),
    worker: async (cut, index) => {
      const workerManifest = structuredClone(manifest);
      const value = await cutRunner({
        cut,
        index,
        manifest: workerManifest,
        workerManifest,
        contract,
        directories: { sourceDir, workDir, audioDir, alignmentDir },
      });
      return {
        cutId: cut.id,
        manifest: value?.manifest || workerManifest,
        reportRow: value?.reportRow || {
          cutId: cut.id,
          status: "complete",
          takeCount,
          utteranceCount: cut.utteranceIds?.length || 0,
        },
        mediaJobs: Array.isArray(value?.mediaJobs) ? value.mediaJobs : [],
      };
    },
    onSettled: async (outcome) => {
      const cutId = outcome.item.id;
      const settledMediaJobs = outcome.status === "fulfilled"
        ? outcome.value.mediaJobs
        : (Array.isArray(outcome.error?.mediaJobs) ? outcome.error.mediaJobs : []);
      collectedMediaJobs = mergeKoyaDialogueMediaJobReceipts(collectedMediaJobs, settledMediaJobs);
      if (outcome.status === "fulfilled") {
        if (enforceMediaJobReceipts && outcome.value.mediaJobs.length < takeCount) {
          throw new Error(`${cutId} completed without the full paid-take Media Job roster.`);
        }
        const workerUtteranceById = new Map(
          (outcome.value.manifest?.utterances || []).map((entry) => [entry.id, entry]),
        );
        for (const utteranceId of outcome.item.utteranceIds || []) {
          const canonical = canonicalUtteranceById.get(utteranceId);
          const workerValue = workerUtteranceById.get(utteranceId);
          if (canonical && workerValue) Object.assign(canonical, structuredClone(workerValue));
        }
        if (outcome.value.manifest?.speech) manifest.speech = structuredClone(outcome.value.manifest.speech);
        completed.add(cutId);
        rowByCut.set(cutId, { ...outcome.value.reportRow, cutId, status: "complete" });
      } else if (outcome.error instanceof KoyaUsageLimitError) {
        report.status = "waiting-usage-limit";
        report.knownRemainingIssues = [{ id: "usage-limit", detail: outcome.error.message }];
        rowByCut.set(cutId, { ...rowByCut.get(cutId), status: "waiting-usage-limit" });
        manifest.status = "waiting-usage-limit";
      } else {
        report.status = "failed";
        report.knownRemainingIssues = [{ id: `speech:${cutId}`, detail: String(outcome.error?.message || outcome.error) }];
        rowByCut.set(cutId, { ...rowByCut.get(cutId), status: "failed" });
      }
      await persistCanonical();
    },
  });

  if (pool.cancelled || options.signal?.aborted === true) {
    report.status = "cancelled";
    report.knownRemainingIssues = [{ id: "cancelled", detail: "Speech generation cancelled; completed cuts were checkpointed." }];
    manifest.status = "speech-checkpointed";
    await persistCanonical();
    return { manifest, manifestPath, report, reportPath, waiting: false, cancelled: true, partial: true };
  }
  if (pool.firstError instanceof KoyaUsageLimitError) {
    report.status = "waiting-usage-limit";
    manifest.status = "waiting-usage-limit";
    await persistCanonical();
    return { manifest, manifestPath, report, reportPath, waiting: true, partial: true };
  }
  if (pool.firstError) {
    report.status = "failed";
    await persistCanonical();
    throw pool.firstError;
  }

  syncDerivedState();
  const partial = report.pendingCutIds.length > 0;
  report.status = partial ? "partial-complete" : "complete";
  report.knownRemainingIssues = partial
    ? [{ id: "pending-cuts", detail: `Pending speech cuts: ${report.pendingCutIds.join(", ")}.` }]
    : [];
  manifest.status = partial ? "speech-partial" : "speech-ready";
  manifest.production = {
    ...(manifest.production || {}),
    audioPipeline: {
      version: report.version,
      reportPath,
      takeCount,
      cutConcurrency: concurrency,
      paidRequestConcurrencyLimit: KOYA_PAID_SPEECH_REQUEST_CONCURRENCY_LIMIT,
    },
  };
  await persistCanonical();
  return { manifest, manifestPath, report, reportPath, waiting: false, partial };
}
