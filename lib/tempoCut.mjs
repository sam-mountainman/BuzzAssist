import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { transcribeAudioWords } from "./subtitleGeneration.mjs";
import { applyCutRangesToClips, buildXmeml, fpsToTimebase, parseXmeml } from "./premiereXml.mjs";

// Standalone port of BuzzAssist's tempo-cut / silence-cut planning pipeline.
// It writes a non-destructive Premiere/FCP7 XML, not a rendered video.
// Supports the "ffmpeg-local" model (silencedetect) and the
// "elevenlabs-scribe-v2" cloud model (word-timestamp cuts with filler /
// cough / retake removal, ported from decisionEngine.ts). Silero VAD, LLM
// decisions, demucs BGM separation, and visual/scene analysis from the
// original are intentionally not ported.

const MAX_PROCESS_TIMEOUT_MS = 30 * 60_000;

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function nonEmptyString(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || "";
}

function capTimeoutMs(timeoutMs) {
  return Math.min(MAX_PROCESS_TIMEOUT_MS, Math.max(1_000, Math.ceil(timeoutMs)));
}

function runLocalProcess(command, args = [], options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      env: options.env || process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) {
        reject(error);
      } else {
        resolvePromise(result || { stdout, stderr });
      }
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`Command timed out: ${command} ${args.join(" ")}`));
    }, options.timeoutMs || 120_000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code === 0) {
        finish(undefined, { stdout, stderr });
      } else {
        const detail = (stderr || stdout || "").trim();
        finish(new Error(detail || `Command failed with exit code ${code}: ${command} ${args.join(" ")}`));
      }
    });
    child.stdin.end();
  });
}

function resolveTempoCutBinaries(options = {}) {
  return {
    ffmpeg: nonEmptyString(options.ffmpegPath) || nonEmptyString(process.env.FFMPEG_PATH) || "ffmpeg",
    ffprobe: nonEmptyString(options.ffprobePath) || nonEmptyString(process.env.FFPROBE_PATH) || "ffprobe",
  };
}

function normalizeSilenceCutNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function normalizeDurationSeconds(value) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function formatFilterSeconds(value) {
  return Math.max(0, value).toFixed(3).replace(/0+$/, "").replace(/\.$/, "") || "0";
}

function sumTimeRanges(ranges) {
  return ranges.reduce((sum, range) => sum + Math.max(0, range.end - range.start), 0);
}

function getTimeRangeCoverage(ranges, duration) {
  if (!duration || duration <= 0) {
    return 0;
  }
  return sumTimeRanges(ranges) / Math.max(0.001, duration);
}

function toSilenceCutProcessError(action, error) {
  const message = getErrorMessage(error);
  if (/ENOENT|spawn\s+ffmpeg|spawn\s+ffprobe|not found|command not found/i.test(message)) {
    return new Error("FFmpegを実行できませんでした。FFMPEG_PATH/FFPROBE_PATHの設定か、PATH上のFFmpegを確認してください。");
  }
  if (/Command timed out/i.test(message)) {
    return new Error(`${action}がタイムアウトしました。短い動画で試すか、動画を分割してから実行してください。`);
  }
  if (/Invalid data|moov atom not found|could not find codec parameters/i.test(message)) {
    return new Error("動画を読み込めませんでした。ファイルが壊れていないか、対応している動画形式か確認してください。");
  }
  if (/audio|stream|specifier|matches no streams|no such filter|unlabeled input pad/i.test(message)) {
    return new Error("動画の音声トラックを解析できませんでした。音声入りの動画を選択してください。");
  }
  return new Error(`${action}に失敗しました: ${message}`);
}

function toTempoCutUserError(error) {
  const message = getErrorMessage(error);
  if (/Invalid data|moov atom not found|could not find codec parameters|unsupported|format/i.test(message)) {
    return new Error("動画を読み込めませんでした。ファイルが壊れていないか、対応している動画形式か確認してください。");
  }
  if (/FFmpeg|ffmpeg|ffprobe|filter_complex|libx264|aac|No such filter/i.test(message)) {
    return toSilenceCutProcessError("無音カット処理", error);
  }
  return error instanceof Error ? error : new Error(message || "無音カットに失敗しました。");
}

async function probeMediaInfo(mediaPath, bin) {
  try {
    const result = await runLocalProcess(bin.ffprobe, [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_entries",
      "format=duration:stream=codec_type,r_frame_rate,width,height",
      mediaPath,
    ], { timeoutMs: 30_000 });
    const parsed = JSON.parse(result.stdout || "{}");
    const duration = normalizeDurationSeconds(Number(parsed.format?.duration));
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const videoStream = streams.find((stream) => stream?.codec_type === "video") || null;
    let fps = 0;
    const rate = String(videoStream?.r_frame_rate || "");
    const rateMatch = rate.match(/^(\d+)\/(\d+)$/);
    if (rateMatch && Number(rateMatch[2]) > 0) fps = Number(rateMatch[1]) / Number(rateMatch[2]);
    else if (Number.isFinite(Number(rate))) fps = Number(rate);
    return {
      duration,
      hasAudio: streams.some((stream) => stream?.codec_type === "audio"),
      hasVideo: Boolean(videoStream),
      fps,
      width: Number(videoStream?.width) || 0,
      height: Number(videoStream?.height) || 0,
    };
  } catch (error) {
    const message = getErrorMessage(error);
    if (/Invalid data|moov atom not found|No such file|could not find codec parameters/i.test(message)) {
      throw new Error("動画を読み込めませんでした。ファイルが壊れていないか確認してください。");
    }
    throw new Error(`動画情報を取得できませんでした: ${message}`);
  }
}

async function probeAudioDurationSeconds(mediaPath, bin) {
  try {
    const result = await runLocalProcess(bin.ffprobe, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=nw=1:nk=1",
      mediaPath,
    ], { timeoutMs: 30_000 });
    return normalizeDurationSeconds(Number.parseFloat(result.stdout.trim()));
  } catch {
    return 0;
  }
}

function parseSilenceDetectRanges(stderr, duration, minSilenceSeconds) {
  const events = Array.from(stderr.matchAll(/silence_(start|end):\s*([0-9.]+)/g))
    .map((match) => ({
      kind: match[1] === "end" ? "end" : "start",
      value: Number.parseFloat(match[2]),
      index: typeof match.index === "number" ? match.index : 0,
    }))
    .filter((event) => Number.isFinite(event.value))
    .sort((a, b) => a.index - b.index);
  const ranges = [];
  let currentStart;
  for (const event of events) {
    if (event.kind === "start") {
      currentStart = Math.max(0, Math.min(duration, event.value));
      continue;
    }
    if (typeof currentStart !== "number") {
      continue;
    }
    const end = Math.max(currentStart, Math.min(duration, event.value));
    if (end - currentStart >= Math.max(0.01, minSilenceSeconds - 0.001)) {
      ranges.push({ start: currentStart, end });
    }
    currentStart = undefined;
  }
  if (typeof currentStart === "number" && duration - currentStart >= Math.max(0.01, minSilenceSeconds - 0.001)) {
    ranges.push({ start: currentStart, end: duration });
  }
  return ranges;
}

async function detectSilenceRanges(mediaPath, duration, thresholdDb, minSilenceSeconds, bin) {
  if (!duration || duration <= 0) {
    return [];
  }
  const noise = `${Math.round(thresholdDb)}dB`;
  const silenceDuration = formatFilterSeconds(minSilenceSeconds);
  try {
    const result = await runLocalProcess(bin.ffmpeg, [
      "-hide_banner",
      "-nostdin",
      "-i",
      mediaPath,
      "-vn",
      "-af",
      `silencedetect=noise=${noise}:d=${silenceDuration}`,
      "-f",
      "null",
      "-",
    ], { timeoutMs: capTimeoutMs(Math.max(60_000, duration * 2500)) });
    return parseSilenceDetectRanges(result.stderr, duration, minSilenceSeconds);
  } catch (error) {
    throw toSilenceCutProcessError("無音検出", error);
  }
}

function normalizeAdaptiveThresholdDb(value) {
  return Math.max(-60, Math.min(-20, Math.round(value)));
}

function uniqueThresholdCandidates(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (!Number.isFinite(value)) {
      continue;
    }
    const normalized = normalizeAdaptiveThresholdDb(value);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

async function measureMaxVolumeDb(mediaPath, duration, bin) {
  try {
    const result = await runLocalProcess(bin.ffmpeg, [
      "-hide_banner",
      "-nostdin",
      "-i",
      mediaPath,
      "-vn",
      "-af",
      "volumedetect",
      "-f",
      "null",
      "-",
    ], { timeoutMs: capTimeoutMs(Math.max(60_000, duration * 2500)) });
    const text = `${result.stderr}\n${result.stdout}`;
    const match = text.match(/max_volume:\s*(-?(?:inf|\d+(?:\.\d+)?))\s*dB/i);
    if (!match || /inf/i.test(match[1])) {
      return undefined;
    }
    const value = Number.parseFloat(match[1]);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

// Auto threshold: measure per-window RMS on the (denoised) analysis audio,
// take a low percentile as the noise floor, and sit the silence threshold
// 6dB above it. Beats any fixed default across mics and rooms.
async function calibrateSilenceThresholdDb(analysisAudioPath, duration, bin) {
  try {
    const result = await runLocalProcess(bin.ffmpeg, [
      "-hide_banner", "-nostdin", "-i", analysisAudioPath,
      "-af", "astats=metadata=1:reset=0.4,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-",
      "-f", "null", "-",
    ], { timeoutMs: capTimeoutMs(Math.max(60_000, duration * 1500)) });
    const values = [...result.stdout.matchAll(/RMS_level=(-?[\d.]+)/g)]
      .map((match) => Number(match[1]))
      .filter((value) => Number.isFinite(value));
    if (values.length < 8) return null;
    values.sort((a, b) => a - b);
    const noiseFloor = values[Math.floor(values.length * 0.15)];
    if (!Number.isFinite(noiseFloor)) return null;
    return Math.max(-60, Math.min(-20, Math.round(noiseFloor + 6)));
  } catch {
    return null;
  }
}

async function detectSilenceRangesWithFallback(mediaPath, duration, thresholdDb, minSilenceSeconds, bin) {
  const firstRanges = await detectSilenceRanges(mediaPath, duration, thresholdDb, minSilenceSeconds, bin);
  let bestRanges = firstRanges;
  let bestCoverage = getTimeRangeCoverage(firstRanges, duration);
  if (firstRanges.length === 0 || bestCoverage < 0.98) {
    return firstRanges;
  }

  const maxVolumeDb = await measureMaxVolumeDb(mediaPath, duration, bin);
  const candidates = uniqueThresholdCandidates([
    thresholdDb,
    typeof maxVolumeDb === "number" ? maxVolumeDb - 12 : Number.NaN,
    typeof maxVolumeDb === "number" ? maxVolumeDb - 18 : Number.NaN,
    typeof maxVolumeDb === "number" ? maxVolumeDb - 24 : Number.NaN,
    typeof maxVolumeDb === "number" ? maxVolumeDb - 30 : Number.NaN,
    thresholdDb - 5,
    thresholdDb - 10,
    thresholdDb - 15,
    -55,
    -60,
  ]);

  for (const candidateThresholdDb of candidates) {
    if (candidateThresholdDb === normalizeAdaptiveThresholdDb(thresholdDb)) {
      continue;
    }
    const ranges = await detectSilenceRanges(mediaPath, duration, candidateThresholdDb, minSilenceSeconds, bin);
    const coverage = getTimeRangeCoverage(ranges, duration);
    if (ranges.length > 0 && coverage < 0.98) {
      return ranges;
    }
    if (coverage < bestCoverage) {
      bestCoverage = coverage;
      bestRanges = ranges;
    }
  }
  return bestRanges;
}

async function createSpeechFocusedAnalysisAudio(inputPath, tempDir, duration, bin) {
  const audioPath = join(tempDir, "tempo-cut-speech-focused.wav");
  try {
    await runLocalProcess(bin.ffmpeg, [
      "-hide_banner",
      "-y",
      "-nostdin",
      "-i",
      inputPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-af",
      "highpass=f=80,lowpass=f=8000,afftdn=nf=-25,aresample=async=1:first_pts=0",
      "-c:a",
      "pcm_s16le",
      audioPath,
    ], { timeoutMs: capTimeoutMs(Math.max(60_000, duration * 1800)) });
    return { audioPath, provider: "ffmpeg-speech-focused-analysis", status: "used" };
  } catch (error) {
    return {
      audioPath: inputPath,
      provider: "ffmpeg-speech-focused-analysis",
      status: "fallback",
      error: getErrorMessage(error),
    };
  }
}

function mergeTempoCutRanges(duration, ranges) {
  const normalized = ranges
    .map((range) => ({
      start: Math.max(0, Math.min(duration, Number(range.start))),
      end: Math.max(0, Math.min(duration, Number(range.end))),
    }))
    .map((range) => (range.end >= range.start ? range : { start: range.end, end: range.start }))
    .filter((range) => range.end - range.start > 0.01)
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of normalized) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end + 0.015) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function buildSegmentsFromCutRanges(duration, cutRanges) {
  const segments = [];
  let cursor = 0;
  for (const cut of mergeTempoCutRanges(duration, cutRanges)) {
    if (cut.start - cursor > 0.04) {
      segments.push({ start: cursor, end: cut.start });
    }
    cursor = Math.max(cursor, cut.end);
  }
  if (duration - cursor > 0.04) {
    segments.push({ start: cursor, end: duration });
  }
  return segments;
}

// ---------------------------------------------------------------------------
// Scribe-cloud decision engine (port of decisionEngine.ts)
// ---------------------------------------------------------------------------

function normalizeTempoCutText(text) {
  return String(text || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ \t\r\n、。，．,.!?！？「」『』（）()【】[\]…・]/g, "")
    .replace(/[〜~]+/g, "ー");
}

function normalizeTempoCutWords(words, duration) {
  return (Array.isArray(words) ? words : [])
    .map((word) => {
      const start = Math.max(0, Math.min(duration, Number(word.start)));
      const end = Math.max(start, Math.min(duration, Number(word.end)));
      const confidence = Number(word.confidence);
      return {
        text: typeof word.text === "string" ? word.text : "",
        start,
        end,
        type: typeof word.type === "string" ? word.type : undefined,
        speakerId: typeof word.speakerId === "string" && word.speakerId.trim() ? word.speakerId.trim() : undefined,
        eventType: typeof word.eventType === "string" && word.eventType.trim() ? word.eventType.trim() : undefined,
        confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : undefined,
      };
    })
    .filter((word) => word.text.trim() && word.end - word.start > 0.01)
    .sort((a, b) => a.start - b.start);
}

function getTempoCutSpeechWords(words) {
  return words.filter((word) => {
    const type = (word.type || "").toLowerCase();
    return type !== "spacing" && type !== "audio_event" && type !== "event";
  });
}

function getTempoCutAudioEventWords(words) {
  return words.filter((word) => {
    const type = (word.type || "").toLowerCase();
    const text = normalizeTempoCutText(word.text);
    return type === "audio_event"
      || type === "event"
      || /^\[[^\]]+\]$/.test(word.text.trim())
      || /^\([^)]{1,40}\)$/.test(word.text.trim())
      || /咳|咳払い|くしゃみ|cough|sneeze|throatclearing|throatclear|breath|noise/.test(text);
  });
}

function endsJapaneseSentence(text) {
  return /[。．.!！?？…]\s*$/.test(String(text ?? "").trim());
}

function buildTempoCutGapRanges(words, duration, minGapSeconds) {
  const speechWords = getTempoCutSpeechWords(words);
  const ranges = [];
  const gap = Math.max(0.05, minGapSeconds);
  if (speechWords.length === 0) return [];
  if (speechWords[0].start >= gap) ranges.push({ start: 0, end: speechWords[0].start, afterSentence: false });
  for (let index = 1; index < speechWords.length; index += 1) {
    const previous = speechWords[index - 1];
    const current = speechWords[index];
    if (current.start - previous.end >= gap) {
      ranges.push({ start: previous.end, end: current.start, afterSentence: endsJapaneseSentence(previous.text) });
    }
  }
  const last = speechWords[speechWords.length - 1];
  if (duration - last.end >= gap) ranges.push({ start: last.end, end: duration, afterSentence: endsJapaneseSentence(last.text) });
  return ranges;
}

const TEMPO_CUT_FILLER_BASE_WORDS = new Set(["え", "えー", "ええ", "えっと", "えーと", "あの", "あのー"]);
const TEMPO_CUT_FILLER_MEDIUM_WORDS = new Set(["その", "そのー", "なんか", "まあ", "まー"]);
const TEMPO_CUT_PROTECTED_DISCOURSE_WORDS = new Set(["こう", "ちょっと", "ね", "はい", "うん"]);
const TEMPO_CUT_FILLER_STRONG_WORDS = new Set(["ていうか", "やっぱ", "やっぱり"]);

function isTempoCutFillerWord(normalized, intensity) {
  if (intensity <= 0) return false;
  if (TEMPO_CUT_PROTECTED_DISCOURSE_WORDS.has(normalized)) return false;
  if (TEMPO_CUT_FILLER_BASE_WORDS.has(normalized)) return true;
  if (intensity >= 35 && TEMPO_CUT_FILLER_MEDIUM_WORDS.has(normalized)) return true;
  if (intensity >= 70 && TEMPO_CUT_FILLER_STRONG_WORDS.has(normalized)) return true;
  return false;
}

function buildTempoCutFillerCandidates(words, duration, fillerRemoval) {
  const speechWords = getTempoCutSpeechWords(words);
  const candidates = [];
  if (fillerRemoval <= 0) return candidates;
  for (let index = 0; index < speechWords.length; index += 1) {
    const word = speechWords[index];
    const normalized = normalizeTempoCutText(word.text);
    const wordDuration = word.end - word.start;
    if (!isTempoCutFillerWord(normalized, fillerRemoval) || wordDuration <= 0.04 || wordDuration > 1.2) continue;
    const previousEnd = index > 0 ? speechWords[index - 1].end : 0;
    const nextStart = index < speechWords.length - 1 ? speechWords[index + 1].start : duration;
    const beforeGap = Math.max(0, word.start - previousEnd);
    const afterGap = Math.max(0, nextStart - word.end);
    if (beforeGap < 0.035 && afterGap < 0.035 && wordDuration < 0.22) continue;
    const padBefore = Math.min(0.03, beforeGap / 2);
    const padAfter = Math.min(0.03, afterGap / 2);
    candidates.push({
      start: Math.max(0, word.start - padBefore),
      end: Math.min(duration, word.end + padAfter),
      type: "filler",
      action: "CUT",
      keepDuration: 0,
      confidence: Math.max(0.72, Math.min(0.96, 0.68 + fillerRemoval / 350)),
      reason: "japanese_filler_word",
      text: word.text,
      speakerId: word.speakerId,
    });
  }
  return candidates;
}

function buildTempoCutAudioEventCandidates(words, duration, coughRemoval) {
  if (coughRemoval <= 0) return [];
  const candidates = [];
  for (const event of getTempoCutAudioEventWords(words)) {
    const normalized = normalizeTempoCutText(`${event.eventType || ""}${event.text}`);
    if (!/咳|咳払い|くしゃみ|cough|sneeze|throatclearing|throatclear/.test(normalized)) continue;
    const durationSeconds = event.end - event.start;
    if (durationSeconds <= 0.03 || durationSeconds > 3.2) continue;
    const pad = Math.min(0.08, Math.max(0.02, coughRemoval / 1000));
    candidates.push({
      start: Math.max(0, event.start - pad),
      end: Math.min(duration, event.end + pad),
      type: "audio_event",
      action: "CUT",
      keepDuration: 0,
      confidence: Math.max(0.7, Math.min(0.96, 0.66 + coughRemoval / 300)),
      reason: "scribe_audio_event",
      text: event.text,
      speakerId: event.speakerId,
    });
  }
  return candidates;
}

const TEMPO_CUT_RETAKE_MARKERS = new Set([
  "いや", "違う", "ちがう", "じゃなくて", "ではなく", "訂正", "言い直し", "もう一回", "もう一度", "すみません", "ごめん",
]);

function buildTempoCutRetakeCandidates(words, duration, retakeRemoval) {
  const speechWords = getTempoCutSpeechWords(words);
  if (retakeRemoval <= 0 || speechWords.length < 2) return [];
  const candidates = [];
  for (let index = 0; index < speechWords.length; index += 1) {
    const word = speechWords[index];
    const normalized = normalizeTempoCutText(word.text);
    if (!TEMPO_CUT_RETAKE_MARKERS.has(normalized)) continue;
    const previous = speechWords[index - 1];
    const next = speechWords[index + 1];
    if (!next) continue;
    let start = word.start;
    if (retakeRemoval >= 70 && previous && word.start - previous.end < 0.75) {
      let rewindIndex = index - 1;
      while (rewindIndex > 0) {
        const current = speechWords[rewindIndex];
        const before = speechWords[rewindIndex - 1];
        if (current.start - before.end > 0.55 || word.start - before.start > 1.8 || /[。！？!?]$/.test(before.text)) break;
        rewindIndex -= 1;
      }
      start = speechWords[rewindIndex].start;
    }
    const end = Math.min(duration, word.end + Math.min(0.08, Math.max(0, next.start - word.end) / 2));
    if (end - start > 0.04 && end - start <= 2.4) {
      candidates.push({
        start,
        end,
        type: "retake",
        action: "CUT",
        keepDuration: 0,
        confidence: Math.max(0.62, Math.min(0.9, 0.55 + retakeRemoval / 280)),
        reason: retakeRemoval >= 70 ? "retake_marker_with_previous_phrase" : "retake_marker",
        text: word.text,
        speakerId: word.speakerId,
      });
    }
  }
  return candidates;
}

function getDefaultTempoCutInstructionOptions() {
  return { preserveSentenceEnds: true, tempoBias: 0, keepEmotionalPauses: true };
}

export function parseTempoCutInstructionPrompt(prompt) {
  const raw = typeof prompt === "string" ? prompt.trim() : "";
  const compact = raw.replace(/\s+/g, "");
  const options = getDefaultTempoCutInstructionOptions();
  if (!compact) return options;
  if (/テンポ|詰め|短く|サクサク|早め|速め/.test(compact)) options.tempoBias = 1;
  if (/自然|ゆったり|残し|余韻|感情|強調|語尾/.test(compact)) {
    options.tempoBias = -1;
    options.keepEmotionalPauses = true;
  }
  if (/語尾|文末|切らない|頭を切らない/.test(compact)) options.preserveSentenceEnds = true;
  return options;
}

function getInstructionAdjustedKeepSeconds(keepSeconds, options, candidateType, silenceDuration) {
  let next = keepSeconds;
  if (options.tempoBias > 0) next = Math.max(0, keepSeconds - 0.08);
  else if (options.tempoBias < 0) next = Math.min(silenceDuration, keepSeconds + 0.12);
  if (options.preserveSentenceEnds && candidateType === "word_gap") {
    next = Math.min(silenceDuration, next + 0.04);
  }
  return next;
}

export function buildTempoCutScribePlan(input) {
  const words = normalizeTempoCutWords(input.words, input.duration);
  const speechWords = getTempoCutSpeechWords(words);
  if (speechWords.length === 0) {
    return { segments: [{ start: 0, end: input.duration }], cutRanges: [], cutDuration: 0, candidates: [] };
  }
  const instructionOptions = parseTempoCutInstructionPrompt(input.instructionPrompt);
  // Meaning-aware pauses: right after a sentence end the pause is deliberate
  // breathing room — require a clearly longer gap before cutting, and leave
  // more of it behind (keepScale consumed by buildTempoCutSilencePlan).
  const gapRanges = buildTempoCutGapRanges(words, input.duration, input.detectSeconds)
    .filter((range) => !range.afterSentence || range.end - range.start >= input.detectSeconds * 1.4)
    .map((range) => (range.afterSentence ? { ...range, keepScale: 1.6 } : range));
  const gapPlan = buildTempoCutSilencePlan(
    input.duration,
    gapRanges,
    input.keepSeconds,
    input.preMarginSeconds,
    input.postMarginSeconds,
    "word_gap",
    instructionOptions,
  );
  const fillerCandidates = buildTempoCutFillerCandidates(words, input.duration, input.fillerRemoval);
  const audioEventCandidates = buildTempoCutAudioEventCandidates(words, input.duration, input.coughRemoval);
  const retakeCandidates = buildTempoCutRetakeCandidates(words, input.duration, input.retakeRemoval);
  const candidateCuts = [
    ...gapPlan.cutRanges,
    ...fillerCandidates.map((candidate) => ({ start: candidate.start, end: candidate.end })),
    ...audioEventCandidates.map((candidate) => ({ start: candidate.start, end: candidate.end })),
    ...retakeCandidates.map((candidate) => ({ start: candidate.start, end: candidate.end })),
  ];
  const cutRanges = mergeTempoCutRanges(input.duration, candidateCuts);
  return {
    segments: buildSegmentsFromCutRanges(input.duration, cutRanges),
    cutRanges,
    cutDuration: sumTimeRanges(cutRanges),
    candidates: [...gapPlan.candidates, ...fillerCandidates, ...audioEventCandidates, ...retakeCandidates],
  };
}

// Port of decisionEngine.buildTempoCutSilencePlan. candidateType "word_gap"
// (scribe mode) applies the instruction-prompt keep adjustments; the
// ffmpeg-local path passes "silence" with default options, matching the
// original behavior.
function buildTempoCutSilencePlan(
  duration,
  silenceRanges,
  keepSeconds,
  preMarginSeconds,
  postMarginSeconds,
  candidateType = "silence",
  instructionOptions = getDefaultTempoCutInstructionOptions(),
) {
  const cutRanges = [];
  const candidates = [];
  for (const range of silenceRanges) {
    const start = Math.max(0, Math.min(duration, range.start));
    const end = Math.max(start, Math.min(duration, range.end));
    const silenceDuration = end - start;
    if (silenceDuration <= 0.04) {
      continue;
    }
    const adjustedKeep = getInstructionAdjustedKeepSeconds(keepSeconds, instructionOptions, candidateType, silenceDuration)
      * (Number.isFinite(range.keepScale) && range.keepScale > 0 ? range.keepScale : 1);
    const keep = Math.min(silenceDuration, Math.max(0, adjustedKeep));
    const baseLeft = Math.max(0, preMarginSeconds);
    const baseRight = Math.max(0, postMarginSeconds);
    let leftKeep = 0;
    let rightKeep = 0;
    if (keep > 0 && baseLeft + baseRight > 0) {
      if (baseLeft + baseRight >= keep) {
        leftKeep = keep * (baseLeft / (baseLeft + baseRight));
        rightKeep = keep - leftKeep;
      } else {
        const extra = keep - baseLeft - baseRight;
        leftKeep = baseLeft + extra / 2;
        rightKeep = baseRight + extra / 2;
      }
    } else if (keep > 0) {
      leftKeep = keep / 2;
      rightKeep = keep - leftKeep;
    }
    const cutStart = Math.max(start, Math.min(end, start + leftKeep));
    const cutEnd = Math.max(cutStart, Math.min(end, end - rightKeep));
    if (cutEnd - cutStart > 0.04) {
      cutRanges.push({ start: cutStart, end: cutEnd });
      candidates.push({
        start: cutStart,
        end: cutEnd,
        type: candidateType,
        action: "COMPRESS",
        keepDuration: Math.max(0, Math.min(silenceDuration, keep)),
        confidence: candidateType === "word_gap" ? 0.9 : 0.84,
        reason: candidateType === "word_gap" ? "long_gap_between_words" : "ffmpeg_detected_silence",
      });
    }
  }
  const mergedCutRanges = mergeTempoCutRanges(duration, cutRanges);
  return {
    segments: buildSegmentsFromCutRanges(duration, mergedCutRanges),
    cutRanges: mergedCutRanges,
    cutDuration: sumTimeRanges(mergedCutRanges),
    candidates,
  };
}

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function nextGeneratedSilenceCutName(outputDir) {
  let maxN = 0;
  const entries = await readdir(outputDir).catch(() => []);
  const pattern = /^JetCut(\d+)\.xml$/i;
  for (const name of entries) {
    const match = name.match(pattern);
    if (match) {
      const n = Number.parseInt(match[1], 10);
      if (n > maxN) {
        maxN = n;
      }
    }
  }
  return `JetCut${maxN + 1}.xml`;
}

function normalizeOutputFileName(fileName) {
  const raw = nonEmptyString(fileName);
  if (!raw) {
    return "";
  }
  const base = basename(raw)
    .replace(/\.(xml|mp4|mov|m4v|webm|mkv|avi)$/i, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .trim();
  return base ? `${base}.xml` : "";
}

async function resolveAvailableOutputPath(outputDir, desiredFileName) {
  const base = desiredFileName.replace(/\.xml$/i, "");
  let candidate = join(outputDir, `${base}.xml`);
  let counter = 2;
  while (await pathExists(candidate)) {
    candidate = join(outputDir, `${base}-${counter}.xml`);
    counter += 1;
  }
  return candidate;
}

export async function silenceCutVideo(options) {
  const opts = options && typeof options === "object" ? options : {};
  const inputPath = nonEmptyString(opts.inputPath);
  if (!inputPath) {
    throw new Error("inputPath is required.");
  }
  if (!isAbsolute(inputPath)) {
    throw new Error("inputPath must be an absolute path.");
  }
  const outputDir = nonEmptyString(opts.outputDir);
  if (!outputDir) {
    throw new Error("outputDir is required.");
  }
  if (!(await pathExists(inputPath))) {
    throw new Error(`Input file was not found: ${inputPath}`);
  }
  const bin = resolveTempoCutBinaries(opts);
  const detectSeconds = normalizeSilenceCutNumber(opts.detectSeconds, 0.3, 2, 0.6);
  const thresholdAuto = opts.thresholdDb == null || opts.thresholdDb === "auto";
  const manualThresholdDb = thresholdAuto ? -34 : normalizeSilenceCutNumber(opts.thresholdDb, -60, -20, -34);
  const keepSeconds = normalizeSilenceCutNumber(opts.keepSeconds, 0, 1, 0.25);
  const preMarginSeconds = normalizeSilenceCutNumber(opts.preMarginSeconds, 0.05, 0.3, 0.08);
  const postMarginSeconds = normalizeSilenceCutNumber(opts.postMarginSeconds, 0.05, 0.3, 0.12);
  const model = opts.model === "elevenlabs-scribe-v2" ? "elevenlabs-scribe-v2" : "ffmpeg-local";
  const fillerRemoval = normalizeSilenceCutNumber(opts.fillerRemoval, 0, 100, 0);
  const coughRemoval = normalizeSilenceCutNumber(opts.coughRemoval, 0, 100, 0);
  const retakeRemoval = normalizeSilenceCutNumber(opts.retakeRemoval, 0, 100, 0);
  const planOnly = Boolean(opts.planOnly);
  await mkdir(outputDir, { recursive: true });
  let analysisTempDir;
  try {
    analysisTempDir = await mkdtemp(join(os.tmpdir(), "tempo-cut-analysis-"));
    const isXmlInput = /\.xml$/i.test(inputPath);

    // Resolve the timeline: an xmeml sequence's clips, or the whole video as
    // one clip. Cuts are planned in SOURCE time and applied per clip.
    let sequence;
    let clips;
    if (isXmlInput) {
      const parsed = parseXmeml(await readFile(inputPath, "utf8"));
      sequence = {
        name: `${parsed.name} jetcut`,
        timebase: parsed.timebase,
        ntsc: parsed.ntsc,
        width: parsed.width,
        height: parsed.height,
      };
      clips = parsed.clips.map((clip) => ({
        name: clip.name,
        filePath: clip.filePath,
        inSeconds: clip.inSeconds,
        outSeconds: clip.outSeconds,
        fileDurationSeconds: clip.fileDurationFrames > 0 ? clip.fileDurationFrames / parsed.fps : clip.outSeconds,
      }));
      for (const clip of clips) {
        if (!(await pathExists(clip.filePath))) {
          throw new Error(`XMLが参照するメディアが見つかりません: ${clip.filePath}`);
        }
      }
    } else {
      const mediaInfo = await probeMediaInfo(inputPath, bin);
      if (!mediaInfo.hasVideo) {
        throw new Error("動画ストリームが見つかりませんでした。動画ファイルかPremiere XMLを選択してください。");
      }
      if (!mediaInfo.hasAudio) {
        throw new Error("音声トラックがない動画です。無音カットには音声入りの動画が必要です。");
      }
      const duration = mediaInfo.duration || normalizeDurationSeconds(await probeAudioDurationSeconds(inputPath, bin));
      if (!duration) {
        throw new Error("動画の長さを取得できませんでした。");
      }
      if (duration < 0.2) {
        throw new Error("動画が短すぎます。0.2秒以上の動画を選択してください。");
      }
      const { timebase, ntsc } = fpsToTimebase(mediaInfo.fps);
      sequence = {
        name: `${basename(inputPath).replace(/\.[^.]+$/, "")} jetcut`,
        timebase,
        ntsc,
        width: mediaInfo.width || 1920,
        height: mediaInfo.height || 1080,
      };
      clips = [{
        name: basename(inputPath),
        filePath: inputPath,
        inSeconds: 0,
        outSeconds: duration,
        fileDurationSeconds: duration,
      }];
    }

    // Plan cuts once per referenced source file.
    const sourcePaths = [...new Set(clips.map((clip) => clip.filePath))];
    const cutRangesByPath = new Map();
    const candidates = [];
    let thresholdDbUsed = manualThresholdDb;
    let transcriptionTotals = null;
    for (const sourcePath of sourcePaths) {
      const info = isXmlInput ? await probeMediaInfo(sourcePath, bin) : null;
      if (info && !info.hasAudio) {
        throw new Error(`音声トラックがないメディアです: ${basename(sourcePath)}`);
      }
      const duration = (info?.duration || 0)
        || (isXmlInput ? normalizeDurationSeconds(await probeAudioDurationSeconds(sourcePath, bin)) : clips[0].fileDurationSeconds);
      if (!duration) {
        throw new Error(`メディアの長さを取得できませんでした: ${basename(sourcePath)}`);
      }
      let plan;
      let transcription = null;
      if (model === "elevenlabs-scribe-v2") {
        transcription = await transcribeAudioWords({
          audioPath: sourcePath,
          durationSeconds: duration,
          glossary: opts.glossary,
          normalizeAudio: opts.normalizeAudio,
        });
        transcriptionTotals = {
          credits: (transcriptionTotals?.credits || 0) + (transcription.credits || 0),
          estimatedCostYen: (transcriptionTotals?.estimatedCostYen || 0) + (transcription.estimatedCostYen || 0),
          wordCount: (transcriptionTotals?.wordCount || 0) + transcription.words.length,
          audioNormalized: transcription.audioNormalized,
          glossaryReplacements: (transcriptionTotals?.glossaryReplacements || 0) + (transcription.glossaryReplacements || 0),
        };
        plan = buildTempoCutScribePlan({
          duration,
          words: transcription.words,
          detectSeconds,
          keepSeconds,
          preMarginSeconds,
          postMarginSeconds,
          fillerRemoval,
          coughRemoval,
          retakeRemoval,
          instructionPrompt: opts.instructionPrompt,
        });
      } else {
        const speechFocused = await createSpeechFocusedAnalysisAudio(sourcePath, analysisTempDir, duration, bin);
        if (thresholdAuto) {
          const calibrated = await calibrateSilenceThresholdDb(speechFocused.audioPath, duration, bin);
          if (calibrated !== null) {
            thresholdDbUsed = calibrated;
          }
        }
        const silenceRanges = await detectSilenceRangesWithFallback(
          speechFocused.audioPath,
          duration,
          thresholdDbUsed,
          detectSeconds,
          bin,
        );
        if (!isXmlInput && silenceRanges.length === 0) {
          throw new Error("条件に一致する無音が見つかりませんでした。無音判定の音量を上げるか、無音と判定する長さを短くしてください。");
        }
        const silenceCoverage = getTimeRangeCoverage(silenceRanges, duration);
        if (silenceCoverage >= 0.98) {
          throw new Error("メディアのほぼ全体が無音として検出されました。無音判定の音量を下げて、判定を厳しくしてください。");
        }
        plan = buildTempoCutSilencePlan(duration, silenceRanges, keepSeconds, preMarginSeconds, postMarginSeconds);
      }
      cutRangesByPath.set(sourcePath, plan.cutRanges);
      candidates.push(...plan.candidates);
    }

    const keptClips = applyCutRangesToClips(clips, cutRangesByPath);
    const inputTimelineDuration = clips.reduce((sum, clip) => sum + (clip.outSeconds - clip.inSeconds), 0);
    const outputTimelineDuration = keptClips.reduce((sum, clip) => sum + (clip.outSeconds - clip.inSeconds), 0);
    const cutDuration = Math.max(0, inputTimelineDuration - outputTimelineDuration);
    const cutCount = clips.reduce((count, clip) => {
      const cuts = (cutRangesByPath.get(clip.filePath) || []).filter(
        (range) => range.end > clip.inSeconds + 0.01 && range.start < clip.outSeconds - 0.01,
      );
      return count + cuts.length;
    }, 0);
    if (cutCount === 0 || cutDuration <= 0.04) {
      throw new Error("カットできる無音がありませんでした。設定を調整してください。");
    }
    if (outputTimelineDuration < Math.min(inputTimelineDuration, Math.max(0.75, inputTimelineDuration * 0.08))) {
      throw new Error("残る映像が短すぎます。無音判定の音量を下げるか、残す間を長くしてください。");
    }

    const stats = {
      model,
      mimeType: "application/xml",
      kind: "premiere-xml",
      inputDuration: inputTimelineDuration,
      outputDuration: outputTimelineDuration,
      cutDuration,
      cutCount,
      clipCount: keptClips.length,
      thresholdAuto,
      ...(model === "ffmpeg-local" ? { thresholdDbUsed } : {}),
      ...(transcriptionTotals ? { transcription: transcriptionTotals } : {}),
    };
    const planPayload = {
      segments: keptClips.map((clip) => ({ start: clip.inSeconds, end: clip.outSeconds, path: clip.filePath })),
      cutRanges: [...cutRangesByPath.entries()].flatMap(([path, ranges]) => ranges.map((range) => ({ ...range, path }))),
      candidates,
    };
    if (planOnly) {
      return { planOnly: true, ...stats, plan: planPayload };
    }

    const desiredFileName = normalizeOutputFileName(opts.fileName) || (await nextGeneratedSilenceCutName(outputDir));
    const outputPath = await resolveAvailableOutputPath(outputDir, desiredFileName);
    const xmlText = buildXmeml({
      name: sequence.name,
      timebase: sequence.timebase,
      ntsc: sequence.ntsc,
      width: sequence.width,
      height: sequence.height,
      clips: keptClips.map((clip) => ({
        name: clip.name,
        path: clip.filePath,
        inSeconds: clip.inSeconds,
        outSeconds: clip.outSeconds,
        fileDurationSeconds: clip.fileDurationSeconds,
      })),
    });
    await writeFile(outputPath, xmlText);
    return { outputPath, fileName: basename(outputPath), ...stats, plan: planPayload };
  } catch (error) {
    throw toTempoCutUserError(error);
  } finally {
    if (analysisTempDir) {
      await rm(analysisTempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const inputArg = process.argv[2];
  if (!inputArg) {
    console.error("Usage: node lib/tempoCut.mjs <video-or-xml-path> [output-dir]");
    process.exit(1);
  }
  const outputDir = resolve(process.argv[3] || join(os.tmpdir(), "tempo-cut-selfcheck"));
  silenceCutVideo({ inputPath: resolve(inputArg), outputDir, model: "ffmpeg-local" })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(getErrorMessage(error));
      process.exit(1);
    });
}
