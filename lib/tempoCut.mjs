import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Standalone port of BuzzAssist's tempo-cut / silence-cut pipeline
// ("ffmpeg-local" model path only). Cloud transcription (ElevenLabs Scribe),
// Silero VAD, LLM decisions, demucs BGM separation, and visual/scene analysis
// from the original are intentionally not ported.

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
      "format=duration:stream=codec_type",
      mediaPath,
    ], { timeoutMs: 30_000 });
    const parsed = JSON.parse(result.stdout || "{}");
    const duration = normalizeDurationSeconds(Number(parsed.format?.duration));
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    return {
      duration,
      hasAudio: streams.some((stream) => stream?.codec_type === "audio"),
      hasVideo: streams.some((stream) => stream?.codec_type === "video"),
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

// Port of decisionEngine.buildTempoCutSilencePlan for the ffmpeg-local path.
// The local path always uses the default instruction options (tempoBias 0),
// under which the instruction-adjusted keep equals keepSeconds for the
// "silence" candidate type, so the instruction machinery is omitted here.
function buildTempoCutSilencePlan(duration, silenceRanges, keepSeconds, preMarginSeconds, postMarginSeconds) {
  const cutRanges = [];
  const candidates = [];
  for (const range of silenceRanges) {
    const start = Math.max(0, Math.min(duration, range.start));
    const end = Math.max(start, Math.min(duration, range.end));
    const silenceDuration = end - start;
    if (silenceDuration <= 0.04) {
      continue;
    }
    const keep = Math.min(silenceDuration, Math.max(0, keepSeconds));
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
        type: "silence",
        action: "COMPRESS",
        keepDuration: Math.max(0, Math.min(silenceDuration, keep)),
        confidence: 0.84,
        reason: "ffmpeg_detected_silence",
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

// Port of renderTimeline.buildTempoCutFfmpegFilter (unchanged math).
function buildTempoCutFfmpegFilter(segments, audioFadeSeconds) {
  const fade = Math.max(0, Math.min(0.1, audioFadeSeconds));
  const parts = [];
  const concatInputs = [];
  segments.forEach((segment, index) => {
    const start = formatFilterSeconds(segment.start);
    const end = formatFilterSeconds(segment.end);
    const segmentDuration = Math.max(0, segment.end - segment.start);
    parts.push(`[0:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${index}]`);
    let audioFilter = `[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS`;
    const fadeDuration = segmentDuration > 0 ? Math.min(fade, segmentDuration / 3) : 0;
    if (fadeDuration > 0 && index > 0) {
      audioFilter += `,afade=t=in:st=0:d=${formatFilterSeconds(fadeDuration)}`;
    }
    if (fadeDuration > 0 && index < segments.length - 1) {
      audioFilter += `,afade=t=out:st=${formatFilterSeconds(Math.max(0, segmentDuration - fadeDuration))}:d=${formatFilterSeconds(fadeDuration)}`;
    }
    audioFilter += `[a${index}]`;
    parts.push(audioFilter);
    concatInputs.push(`[v${index}][a${index}]`);
  });
  parts.push(`${concatInputs.join("")}concat=n=${segments.length}:v=1:a=1[outv][outa]`);
  return parts.join(";\n");
}

async function renderSilenceCutVideo(inputPath, outputPath, segments, audioFadeSeconds, tempDir, duration, bin) {
  if (segments.length === 0) {
    throw new Error("書き出す区間がありません。設定をゆるめてください。");
  }
  const filterPath = join(tempDir, "silence-cut-filter.txt");
  await writeFile(filterPath, buildTempoCutFfmpegFilter(segments, audioFadeSeconds), "utf8");
  await runLocalProcess(bin.ffmpeg, [
    "-hide_banner",
    "-y",
    "-nostdin",
    "-i",
    inputPath,
    "-filter_complex_script",
    filterPath,
    "-map",
    "[outv]",
    "-map",
    "[outa]",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-movflags",
    "+faststart",
    outputPath,
  ], { timeoutMs: capTimeoutMs(Math.max(120_000, duration * 4000)) });
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
  const pattern = /^SilenceCut(\d+)\.mp4$/i;
  for (const name of entries) {
    const match = name.match(pattern);
    if (match) {
      const n = Number.parseInt(match[1], 10);
      if (n > maxN) {
        maxN = n;
      }
    }
  }
  return `SilenceCut${maxN + 1}.mp4`;
}

function normalizeOutputFileName(fileName) {
  const raw = nonEmptyString(fileName);
  if (!raw) {
    return "";
  }
  const base = basename(raw)
    .replace(/\.(mp4|mov|m4v|webm|mkv|avi)$/i, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .trim();
  return base ? `${base}.mp4` : "";
}

async function resolveAvailableOutputPath(outputDir, desiredFileName) {
  const base = desiredFileName.replace(/\.mp4$/i, "");
  let candidate = join(outputDir, `${base}.mp4`);
  let counter = 2;
  while (await pathExists(candidate)) {
    candidate = join(outputDir, `${base}-${counter}.mp4`);
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
    throw new Error(`Input video was not found: ${inputPath}`);
  }
  const bin = resolveTempoCutBinaries(opts);
  const detectSeconds = normalizeSilenceCutNumber(opts.detectSeconds, 0.3, 2, 0.6);
  const thresholdDb = normalizeSilenceCutNumber(opts.thresholdDb, -60, -20, -34);
  const keepSeconds = normalizeSilenceCutNumber(opts.keepSeconds, 0, 1, 0.25);
  const preMarginSeconds = normalizeSilenceCutNumber(opts.preMarginSeconds, 0.05, 0.3, 0.08);
  const postMarginSeconds = normalizeSilenceCutNumber(opts.postMarginSeconds, 0.05, 0.3, 0.12);
  const audioFadeSeconds = normalizeSilenceCutNumber(opts.audioFadeSeconds, 0, 0.1, 0.03);
  await mkdir(outputDir, { recursive: true });
  let analysisTempDir;
  let renderTempDir;
  try {
    const mediaInfo = await probeMediaInfo(inputPath, bin);
    if (!mediaInfo.hasVideo) {
      throw new Error("動画ストリームが見つかりませんでした。動画ファイルを選択してください。");
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
    analysisTempDir = await mkdtemp(join(os.tmpdir(), "tempo-cut-analysis-"));
    const speechFocused = await createSpeechFocusedAnalysisAudio(inputPath, analysisTempDir, duration, bin);
    const silenceRanges = await detectSilenceRangesWithFallback(
      speechFocused.audioPath,
      duration,
      thresholdDb,
      detectSeconds,
      bin,
    );
    if (silenceRanges.length === 0) {
      throw new Error("条件に一致する無音が見つかりませんでした。無音判定の音量を上げるか、無音と判定する長さを短くしてください。");
    }
    const silenceCoverage = getTimeRangeCoverage(silenceRanges, duration);
    if (silenceCoverage >= 0.98) {
      throw new Error("動画のほぼ全体が無音として検出されました。無音判定の音量を下げて、判定を厳しくしてください。");
    }
    const plan = buildTempoCutSilencePlan(duration, silenceRanges, keepSeconds, preMarginSeconds, postMarginSeconds);
    const segments = plan.segments;
    const keptDuration = sumTimeRanges(segments);
    const cutCount = plan.cutRanges.length;
    if (cutCount === 0 || plan.cutDuration <= 0.04) {
      throw new Error("カットできる無音がありませんでした。設定を調整してください。");
    }
    if (keptDuration < Math.min(duration, Math.max(0.75, duration * 0.08))) {
      throw new Error("残る映像が短すぎます。無音判定の音量を下げるか、残す間を長くしてください。");
    }
    const desiredFileName = normalizeOutputFileName(opts.fileName) || (await nextGeneratedSilenceCutName(outputDir));
    const outputPath = await resolveAvailableOutputPath(outputDir, desiredFileName);
    renderTempDir = await mkdtemp(join(os.tmpdir(), "tempo-cut-render-"));
    try {
      await renderSilenceCutVideo(inputPath, outputPath, segments, audioFadeSeconds, renderTempDir, duration, bin);
    } catch (error) {
      await rm(outputPath, { force: true }).catch(() => {});
      throw toSilenceCutProcessError("無音カットの書き出し", error);
    }
    const outputDuration = normalizeDurationSeconds(await probeAudioDurationSeconds(outputPath, bin));
    return {
      outputPath,
      mimeType: "video/mp4",
      inputDuration: duration,
      outputDuration: outputDuration || keptDuration,
      cutDuration: plan.cutDuration,
      cutCount,
      plan: {
        segments: plan.segments,
        cutRanges: plan.cutRanges,
        candidates: plan.candidates,
      },
    };
  } catch (error) {
    throw toTempoCutUserError(error);
  } finally {
    for (const dir of [analysisTempDir, renderTempDir]) {
      if (dir) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const inputArg = process.argv[2];
  if (!inputArg) {
    console.error("Usage: node lib/tempoCut.mjs <video-path> [output-dir]");
    process.exit(1);
  }
  const outputDir = resolve(process.argv[3] || join(os.tmpdir(), "tempo-cut-selfcheck"));
  silenceCutVideo({ inputPath: resolve(inputArg), outputDir })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(getErrorMessage(error));
      process.exit(1);
    });
}
