import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { writeJsonAtomic } from "./canvasScene.mjs";
import { requireElevenLabsApiKey } from "./speechGeneration.mjs";

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

export function buildKoyaDialogueRequest(cutPlan, takeIndex) {
  const numericCutId = Number(String(cutPlan.cutId).replace(/\D/gu, "")) || 0;
  const stabilityCycle = [0.46, 0.52, 0.49, 0.55, 0.43, 0.5, 0.47, 0.53];
  return {
    inputs: cutPlan.inputs.map((entry) => entry.apiInput),
    model_id: "eleven_v3",
    language_code: "ja",
    settings: { stability: stabilityCycle[takeIndex] ?? 0.5 },
    seed: 440000 + numericCutId * 10 + takeIndex,
    apply_text_normalization: "auto",
  };
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

export function selectKoyaDialogueTake(candidates, cutPlan, forcedTakeIndex = null) {
  const scored = candidates.map((candidate) => ({
    ...candidate,
    quality: candidate.quality || scoreKoyaDialogueTake(candidate, cutPlan),
  })).sort((left, right) => left.quality.score - right.quality.score);
  const selected = Number.isInteger(forcedTakeIndex)
    ? scored.find((entry) => entry.takeIndex === forcedTakeIndex) || scored[0]
    : scored[0];
  return {
    ...selected,
    candidateSelection: {
      method: "alignment-completeness-edge-room-and-scene-paced-cps",
      selectedTakeIndex: selected.takeIndex,
      candidates: scored.map((entry) => ({
        takeIndex: entry.takeIndex,
        sourcePath: entry.sourcePath,
        requestId: entry.requestId,
        reused: entry.reused === true,
        quality: entry.quality,
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

async function detectAcousticSpeechBounds(filePath) {
  const { stdout } = await execFile("ffmpeg", [
    "-v", "error", "-i", filePath,
    "-vn", "-ar", "48000", "-ac", "1", "-f", "f32le", "-",
  ], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  const samples = new Float32Array(
    stdout.buffer,
    stdout.byteOffset,
    Math.floor(stdout.byteLength / Float32Array.BYTES_PER_ELEMENT),
  );
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
  const body = buildKoyaDialogueRequest(cutPlan, takeIndex);
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

async function splitSelectedTake(manifest, cutPlan, selected, context) {
  const bounds = cutPlan.inputs.map((_, index) => segmentBounds(selected, index));
  const rows = [];
  for (let index = 0; index < cutPlan.inputs.length; index += 1) {
    const plan = cutPlan.inputs[index];
    const utterance = cutPlan.utterances[index];
    const current = bounds[index];
    const previousBoundary = index === 0 ? 0 : (bounds[index - 1].endSeconds + current.startSeconds) / 2;
    const nextBoundary = index === bounds.length - 1
      ? selected.sourceDurationSeconds
      : (current.endSeconds + bounds[index + 1].startSeconds) / 2;
    const trimStart = Math.max(0, previousBoundary);
    const trimEnd = Math.min(selected.sourceDurationSeconds, nextBoundary);
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
    const acousticBounds = await detectAcousticSpeechBounds(sourceSplitPath);
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
        candidates.push(await generateTake(cutPlan, takeIndex, { ...options, sourceDir }));
      }
      const forcedTakeIndex = options.forcedTakes?.[cut.id];
      const selected = selectKoyaDialogueTake(candidates, cutPlan, forcedTakeIndex);
      const rows = await splitSelectedTake(manifest, cutPlan, selected, {
        contract, workDir, audioDir, alignmentDir,
      });
      report.cuts.push({
        cutId: cut.id,
        status: "complete",
        selectedTakeIndex: selected.takeIndex,
        sourcePath: selected.sourcePath,
        utteranceCount: rows.length,
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
