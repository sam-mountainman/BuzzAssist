import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { writeJsonAtomic } from "./canvasScene.mjs";
import { mergeIntoPronunciations, readReadingDictionary } from "./readingDictionary.mjs";
import { requireElevenLabsApiKey } from "./speechGeneration.mjs";
import { auditVoiceQuality, voiceQualityAvailable, voiceQualityPenalty } from "./voiceQualityGate.mjs";

const execFile = promisify(execFileCallback);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, finite(value, minimum)));

export class KoyaUsageLimitError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "KoyaUsageLimitError";
    this.details = details;
  }
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
      performancePrompt,
      providerText,
      voiceId: utterance.voiceId,
      apiInput: { text: providerText, voice_id: utterance.voiceId },
    };
  });
  const takeCount = clamp(options.takeCount ?? 2, 2, 8);
  return {
    cutId: cut.id,
    utterances,
    inputs,
    takeCount,
    model: "eleven_v3",
    languageCode: "ja",
  };
}

export function buildKoyaDialogueRequest(cutPlan, takeIndex, pronunciationDictionaryLocators = null) {
  const numericCutId = Number(String(cutPlan.cutId).replace(/\D/gu, "")) || 0;
  const stabilityCycle = [0.46, 0.52, 0.49, 0.55, 0.43, 0.5, 0.47, 0.53];
  const request = {
    inputs: cutPlan.inputs.map((entry) => entry.apiInput),
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

function segmentBounds(metadata, inputIndex) {
  const segments = (metadata.voiceSegments || []).filter((segment) => (
    Number(segment.dialogue_input_index) === inputIndex
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
    const bounds = segmentBounds(metadata, index);
    const duration = Math.max(0.001, bounds.endSeconds - bounds.startSeconds);
    const characters = [...cutPlan.inputs[index].speechText.replace(/[\s。、，．！？!?…・]/gu, "")].length;
    const cps = characters / duration;
    const pacePenalty = cps < 3.2 ? (3.2 - cps) * 2 : cps > 8.2 ? (cps - 8.2) * 2 : Math.abs(cps - 5.4) / 5.4;
    const previousEnd = index === 0 ? 0 : segmentBounds(metadata, index - 1).endSeconds;
    const nextStart = index === cutPlan.inputs.length - 1
      ? finite(metadata.sourceDurationSeconds, bounds.endSeconds)
      : segmentBounds(metadata, index + 1).startSeconds;
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

export function selectKoyaDialogueTake(candidates, cutPlan, forcedTakeIndex = null, voiceQualityByTake = null) {
  const scored = candidates.map((candidate) => {
    const quality = candidate.quality || scoreKoyaDialogueTake(candidate, cutPlan);
    const voiceQuality = voiceQualityByTake?.[candidate.takeIndex] ?? null;
    // R194: naturalness/CER penalties fold into the same lower-is-better
    // score; a hard gate failure pushes the take behind every clean one.
    const combinedScore = quality.score + (voiceQuality?.penalty ?? 0);
    return { ...candidate, quality, voiceQuality, combinedScore };
  }).sort((left, right) => left.combinedScore - right.combinedScore);
  const selected = Number.isInteger(forcedTakeIndex)
    ? scored.find((entry) => entry.takeIndex === forcedTakeIndex) || scored[0]
    : scored[0];
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
  const segments = (metadata.voiceSegments || [])
    .filter((segment) => Number(segment.dialogue_input_index) === inputIndex);
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
  const serialized = JSON.stringify(payload || {}).toLowerCase();
  return status === 429 || /(?:quota|usage.?limit|credits|subscription)/u.test(serialized);
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
  const apiKey = await requireElevenLabsApiKey({ apiKey: context.apiKey });
  const fetchImpl = context.fetchImpl || fetch;
  let response;
  let payload;
  let outputFormat = "wav_44100";
  for (const candidateFormat of ["wav_44100", "wav_24000"]) {
    const url = new URL("https://api.elevenlabs.io/v1/text-to-dialogue/with-timestamps");
    url.searchParams.set("output_format", candidateFormat);
    url.searchParams.set("enable_logging", "true");
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", "xi-api-key": apiKey },
      body: JSON.stringify(body),
    });
    payload = await response.json().catch(() => null);
    if (response.ok) { outputFormat = candidateFormat; break; }
    const formatRejected = [400, 403, 422].includes(response.status)
      && /output format/iu.test(JSON.stringify(payload || {}));
    if (formatRejected && candidateFormat !== "wav_24000") continue;
    if (usageLimitResponse(response.status, payload)) {
      throw new KoyaUsageLimitError(`ElevenLabs usage limit reached during ${cutPlan.cutId}.`, {
        status: response.status,
        cutId: cutPlan.cutId,
        takeIndex,
      });
    }
    break;
  }
  if (!response?.ok) {
    throw new Error(`ElevenLabs dialogue generation failed for ${cutPlan.cutId} take ${takeIndex + 1}: ${JSON.stringify(payload)}`);
  }
  const audioBase64 = String(payload?.audio_base64 || "");
  const voiceSegments = Array.isArray(payload?.voice_segments) ? payload.voice_segments : [];
  if (!audioBase64 || voiceSegments.length < cutPlan.inputs.length) {
    throw new Error(`Incomplete ElevenLabs dialogue response for ${cutPlan.cutId}.`);
  }
  await writeFile(sourcePath, Buffer.from(audioBase64, "base64"));
  const metadata = {
    version: 1,
    pipeline: "koya-dialogue-v44",
    cutId: cutPlan.cutId,
    takeIndex,
    inputHash,
    model: "eleven_v3",
    languageCode: "ja",
    requestId: response.headers.get("request-id") || response.headers.get("x-request-id") || "",
    characterCost: finite(response.headers.get("character-cost"), null),
    sourcePath,
    sourceDurationSeconds: await probeDuration(sourcePath),
    outputFormat,
    inputs: cutPlan.inputs,
    voiceSegments,
    alignment: payload?.normalized_alignment || payload?.alignment || null,
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
  const segments = (metadata.voiceSegments || [])
    .filter((segment) => Number(segment.dialogue_input_index) === inputIndex);
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
  const reported = cutPlan.inputs.map((_, index) => segmentBounds(selected, index));
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

export async function generateKoyaDialogueSpeech(options = {}) {
  const manifestPath = resolve(options.manifestPath || "");
  if (!options.manifest && !options.manifestPath) throw new Error("manifestPath is required.");
  const manifest = options.manifest ? structuredClone(options.manifest) : JSON.parse(await readFile(manifestPath, "utf8"));
  const contract = options.contract?.contract || options.contract;
  if (!contract) throw new Error("A resolved Koya production contract is required.");
  const episodeDir = dirname(manifestPath);
  const canvasDir = resolve(options.canvasDir || join(episodeDir, "../.."));
  const sourceDir = join(episodeDir, ".koya-dialogue-source");
  const workDir = join(episodeDir, ".koya-dialogue-work");
  const audioDir = join(canvasDir, "assets/audio");
  const alignmentDir = join(canvasDir, "audio-alignments");
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
  const pronunciationDictionaryLocators = dictionarySync?.dictionaryId
    ? [{ pronunciation_dictionary_id: dictionarySync.dictionaryId, version_id: dictionarySync.versionId || undefined }]
    : null;
  const report = {
    version: "koya-dialogue-v44",
    episodeId: manifest.id,
    manifestPath,
    status: "running",
    cuts: [],
    knownRemainingIssues: [],
    updatedAt: new Date().toISOString(),
  };
  const reportPath = join(episodeDir, "koya-dialogue-generation.json");
  const requestedCuts = new Set(options.cutIds || []);
  for (const cut of manifest.cuts || []) {
    if (requestedCuts.size > 0 && !requestedCuts.has(cut.id)) continue;
    const cutPlan = prepareKoyaDialogueCut(manifest, cut, { takeCount: options.takeCount || contract.audio.takeCount });
    if (options.dryRun) {
      report.cuts.push({ cutId: cut.id, status: "planned", takeCount: cutPlan.takeCount, utteranceCount: cutPlan.inputs.length });
      continue;
    }
    try {
      const candidates = [];
      for (let takeIndex = 0; takeIndex < cutPlan.takeCount; takeIndex += 1) {
        candidates.push(await generateTake(cutPlan, takeIndex, { ...options, sourceDir, pronunciationDictionaryLocators }));
      }
      const forcedTakeIndex = options.forcedTakes?.[cut.id];
      // R194 voice quality gate: opt-in (options flag or env) so offline test
      // runs stay fast; unavailability is recorded, never silently skipped.
      let voiceQualityByTake = null;
      let voiceQualityNote = "disabled";
      const gateWanted = options.voiceQualityGate === true
        || (options.voiceQualityGate !== false && process.env.KOYA_VOICE_QUALITY_GATE === "1");
      if (gateWanted) {
        if (await voiceQualityAvailable()) {
          try {
            const expectedText = cutPlan.inputs.map((entry) => entry.speechText).join("");
            const gateReport = await auditVoiceQuality({
              checks: candidates.map((candidate) => ({
                id: `take-${candidate.takeIndex}`,
                type: "voiceQuality",
                audio: candidate.sourcePath,
                expectedText,
              })),
            });
            voiceQualityByTake = Object.fromEntries(gateReport.checks.map((check) => [
              Number(check.id.replace("take-", "")),
              voiceQualityPenalty(check),
            ]));
            voiceQualityNote = "applied";
          } catch (gateError) {
            voiceQualityNote = `unavailable: ${String(gateError.message).slice(0, 160)}`;
          }
        } else {
          voiceQualityNote = "unavailable: python voice QA stack missing";
        }
      }
      const selected = selectKoyaDialogueTake(candidates, cutPlan, forcedTakeIndex, voiceQualityByTake);
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
        report.nextCutId = cut.id;
        report.knownRemainingIssues = [{ id: "usage-limit", detail: error.message }];
        report.updatedAt = new Date().toISOString();
        manifest.status = "waiting-usage-limit";
        manifest.production = {
          ...(manifest.production || {}),
          checkpoint: { stage: "speech", nextCutId: cut.id, duplicateGenerationPrevented: true },
        };
        await Promise.all([writeJsonAtomic(manifestPath, manifest), writeJsonAtomic(reportPath, report)]);
        return { manifest, manifestPath, report, reportPath, waiting: true };
      }
      report.status = "failed";
      report.knownRemainingIssues = [{ id: `speech:${cut.id}`, detail: error.message }];
      await writeJsonAtomic(reportPath, report);
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
