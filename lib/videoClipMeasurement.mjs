/**
 * 動画クリップの測定（途中の成果物の品質ループの工程 video-clip の機械ゲートの材料。ジャンル共通）。
 *
 * 動画クリップは、漫画のカットを差し替える短い動画（lib/mangaCutVideoSubstitution.mjs）と、ナレーション物語の
 * 回ごとの OP 映像・感想パートの人物の映像（lib/operatorVideoImport.mjs）。どちらも作った側の「こう作った」
 * ではなく、ffprobe と ffmpeg でファイルそのものを読んで測る:
 *   - 形式: コンテナ（ffprobe の format_name）と映像のコーデックが読める
 *   - 全フレームのデコード: ffmpeg -xerror で映像（と音声）を最後までデコードし、デコードしたフレームを数える
 *   - 尺・フレームレート・解像度（と縦横比）が、宣言（declaration）の範囲にある
 *   - 音声トラックの有無が宣言どおり（required / forbidden / optional）
 *
 * 宣言は使う側（ジャンル）が決める。漫画はカットの尺と契約（縦横比・生成した音の禁止）から、ナレーション物語は
 * Channel Pack の枠の決まりから作る。運営者が外で作った動画は、scripts/asset-quality-loop.mjs measure-video に
 * 宣言のファイルを渡して測る。
 *
 * 測定のファイル（buzzassist-video-clip-measurement-v1）は測ったファイルの sha256 を持ち、品質ループはその
 * sha256 が採点する版と同じときだけ使う（別のファイルの測定で通さない）。合否は測定のファイルに書かず、品質ループが
 * 数値から毎回決め直す（evaluateVideoClipMeasurement。ファイルに pass を書いても効かない）。
 *
 * このファイルは node: と依存の無い lib/atomicJsonFile.mjs 以外を import しない（ナレーション物語の配布物の実行系からも読むため。
 * test/runtimeDependencies.test.mjs）。
 */

import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";

import { writeJsonAtomic } from "./atomicJsonFile.mjs";

const execFile = promisify(execFileCallback);

export const VIDEO_CLIP_MEASUREMENT_VERSION = "buzzassist-video-clip-measurement-v1";
export const VIDEO_CLIP_DECLARATION_VERSION = "buzzassist-video-clip-declaration-v1";
/** 音声トラックの宣言。optional は有無を問わない（使う側が音を使わない枠）。 */
export const VIDEO_CLIP_AUDIO_POLICIES = Object.freeze(["required", "forbidden", "optional"]);
/**
 * 読めるコンテナ（ffprobe の format_name はカンマ区切りの別名の並び。どれか1つが入っていればよい）。
 * 公式経路が作る・受け取るのは MP4/MOV と WebM/Matroska だけ。
 */
export const VIDEO_CLIP_CONTAINERS = Object.freeze(["mov", "mp4", "m4a", "3gp", "3g2", "mj2", "matroska", "webm"]);
/** 機械ゲートの id（lib/assetQualityLoop.mjs の ASSET_MACHINE_GATES に同じ id がある。試験が一致を見る）。 */
export const VIDEO_CLIP_GATE_IDS = Object.freeze([
  "video-measurement-bound",
  "video-format-readable",
  "video-full-decode",
  "video-duration-declared",
  "video-frame-rate-declared",
  "video-resolution-declared",
  "video-audio-declared",
]);

// 宣言の範囲（方針値）。上限はナレーション物語の感想パートの人物の映像（最長 3600 秒）と、operatorVideoImport の
// フレームレートの受け入れ（10〜120）に合わせた。尺の比較の許容 1ms は、ffprobe が尺を小数6桁で返す丸めの分。
const LIMITS = Object.freeze({
  durationSeconds: { minimum: 0.04, maximum: 3600 },
  frameRate: { minimum: 1, maximum: 240 },
  size: { minimum: 16, maximum: 16384 },
  aspectTolerance: { minimum: 0, maximum: 0.1 },
  // 縦横比の項（16:9 の 16 と 9 など）。
  aspectTerm: { minimum: 1, maximum: 16384 },
});
const DURATION_EPSILON = 0.001;
const FRAME_RATE_EPSILON = 0.01;
// デコードしたフレームが「尺 × フレームレート」の 90% に届かなければ、途中で切れた動画として落とす
// （ffmpeg は途中で切れた MP4 を、読めた所までで正常終了することがある）。-2 は先頭・末尾の丸めの分。
const DECODED_FRAME_RATIO = 0.9;
const SHA256 = /^[a-f0-9]{64}$/u;

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finite(value) {
  const number = Number(value);
  return value !== null && value !== "" && Number.isFinite(number) ? number : null;
}

function inRange(value, { minimum, maximum }) {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function frameRateOf(value) {
  const [numerator, denominator] = String(value || "").split("/").map(Number);
  if (!Number.isFinite(numerator) || numerator <= 0) return null;
  const rate = denominator ? numerator / denominator : numerator;
  return Number.isFinite(rate) && rate > 0 ? Math.round(rate * 1000) / 1000 : null;
}

async function fileSha256(file) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    createReadStream(file).on("data", (chunk) => hash.update(chunk)).on("error", reject).on("end", () => resolvePromise(hash.digest("hex")));
  });
}

function range(source, field, limit, problems, { optionalMaximum = false } = {}) {
  if (!plainObject(source)) {
    problems.push(`${field}-required`);
    return null;
  }
  for (const key of Object.keys(source)) if (!["min", "max"].includes(key)) problems.push(`${field}.${key}-unknown`);
  const min = source.min;
  const max = source.max;
  if (!inRange(min, limit)) problems.push(`${field}.min`);
  if (max === undefined && optionalMaximum) return inRange(min, limit) ? { min } : null;
  if (!inRange(max, limit)) problems.push(`${field}.max`);
  if (inRange(min, limit) && inRange(max, limit) && min > max) problems.push(`${field}.min-above-max`);
  return inRange(min, limit) && inRange(max, limit) && min <= max ? { min, max } : null;
}

/**
 * 宣言を検める。形:
 * {
 *   "version": "buzzassist-video-clip-declaration-v1",
 *   "durationSeconds": { "min", "max" },       // 秒
 *   "frameRate": { "min", "max" },             // fps
 *   "width": { "min", "max"? }, "height": { "min", "max"? },   // px
 *   "aspectRatio": { "width", "height", "tolerance" }?,       // 例 16:9、許容は比の相対差（0〜0.1）
 *   "audio": "required" | "forbidden" | "optional"
 * }
 * 直せない値は problems に入れて ok: false（黙って既定へ戻さない）。
 */
export function normalizeVideoClipDeclaration(source) {
  const problems = [];
  if (!plainObject(source)) return { ok: false, declaration: null, problems: ["declaration-required"] };
  const known = ["version", "durationSeconds", "frameRate", "width", "height", "aspectRatio", "audio"];
  for (const key of Object.keys(source)) if (!known.includes(key)) problems.push(`${key}-unknown`);
  if (source.version !== VIDEO_CLIP_DECLARATION_VERSION) problems.push("version");
  const durationSeconds = range(source.durationSeconds, "durationSeconds", LIMITS.durationSeconds, problems);
  const frameRate = range(source.frameRate, "frameRate", LIMITS.frameRate, problems);
  const width = range(source.width, "width", LIMITS.size, problems, { optionalMaximum: true });
  const height = range(source.height, "height", LIMITS.size, problems, { optionalMaximum: true });
  let aspectRatio = null;
  if (source.aspectRatio !== undefined) {
    const aspect = source.aspectRatio;
    if (!plainObject(aspect) || !inRange(aspect.width, LIMITS.aspectTerm) || !inRange(aspect.height, LIMITS.aspectTerm)
      || !inRange(aspect.tolerance, LIMITS.aspectTolerance)
      || Object.keys(aspect).some((key) => !["width", "height", "tolerance"].includes(key))) {
      problems.push("aspectRatio");
    } else {
      aspectRatio = { width: aspect.width, height: aspect.height, tolerance: aspect.tolerance };
    }
  }
  if (!VIDEO_CLIP_AUDIO_POLICIES.includes(source.audio)) problems.push("audio");
  if (problems.length > 0) return { ok: false, declaration: null, problems };
  return {
    ok: true,
    declaration: {
      version: VIDEO_CLIP_DECLARATION_VERSION,
      durationSeconds,
      frameRate,
      width,
      height,
      ...(aspectRatio ? { aspectRatio } : {}),
      audio: source.audio,
    },
    problems: [],
  };
}

/** 道具の出力の頭（測ったファイルのパスは伏せる。測定のファイルは sha256 だけでファイルを指す）。 */
function errorSample(value, file) {
  return String(value || "").split(String(file)).join("<clip>").replace(/\s+/gu, " ").trim().slice(0, 300);
}

function tool(spec, fallback) {
  if (typeof spec === "string" && spec.trim()) return { command: spec.trim(), args: [] };
  if (plainObject(spec) && typeof spec.command === "string" && spec.command.trim()) {
    return { command: spec.command.trim(), args: Array.isArray(spec.args) ? spec.args.map(String) : [] };
  }
  return { command: fallback, args: [] };
}

async function probe(ffprobe, file) {
  try {
    const { stdout } = await execFile(ffprobe.command, [...ffprobe.args,
      "-v", "error",
      "-show_entries", "format=format_name,duration:stream=index,codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,duration",
      "-of", "json", file,
    ], { timeout: 120_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    const report = JSON.parse(stdout);
    const streams = Array.isArray(report.streams) ? report.streams : [];
    const videos = streams.filter((row) => row.codec_type === "video");
    const audios = streams.filter((row) => row.codec_type === "audio");
    const video = videos[0] || null;
    const streamDuration = finite(video?.duration);
    return {
      readable: true,
      formatName: typeof report.format?.format_name === "string" ? report.format.format_name : "",
      formatDurationSeconds: finite(report.format?.duration),
      videoStreams: videos.length,
      videoCodec: typeof video?.codec_name === "string" ? video.codec_name : "",
      width: finite(video?.width),
      height: finite(video?.height),
      frameRate: video ? (frameRateOf(video.avg_frame_rate) || frameRateOf(video.r_frame_rate)) : null,
      durationSeconds: streamDuration && streamDuration > 0 ? streamDuration : finite(report.format?.duration),
      audioStreams: audios.length,
      audioCodec: typeof audios[0]?.codec_name === "string" ? audios[0].codec_name : "",
      hasAudio: audios.length > 0,
    };
  } catch (error) {
    return { readable: false, errorSample: errorSample(error?.stderr || error?.message || error, file) };
  }
}

/** 映像（と音声）を最後までデコードする。-xerror で最初のデコードの誤りで止め、-progress で数えたフレームを読む。 */
async function decode(ffmpeg, file) {
  try {
    const { stdout, stderr } = await execFile(ffmpeg.command, [...ffmpeg.args,
      "-hide_banner", "-nostats", "-v", "error", "-xerror",
      "-i", file, "-map", "0:v:0", "-map", "0:a?", "-progress", "pipe:1", "-f", "null", "-",
    ], { timeout: 30 * 60_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    const frames = [...String(stdout).matchAll(/^frame=(\d+)\s*$/gmu)].map((match) => Number(match[1]));
    const decodedFrames = frames.length > 0 ? frames[frames.length - 1] : 0;
    const errors = String(stderr || "").trim();
    return { pass: errors === "" && decodedFrames > 0, decodedFrames, errorSample: errorSample(errors, file) };
  } catch (error) {
    return { pass: false, decodedFrames: 0, errorSample: errorSample(error?.stderr || error?.message || error, file) };
  }
}

/**
 * 動画クリップを測る（書き込みはしない）。宣言が壊れていれば例外（入力の誤り）。
 * ffprobe / ffmpeg はコマンド名か { command, args }（lib/harnessRuntimeResolver の形）で渡す。
 */
export async function measureVideoClip({
  assetPath,
  declaration,
  ffprobe = "ffprobe",
  ffmpeg = "ffmpeg",
  now = () => new Date().toISOString(),
} = {}) {
  const normalized = normalizeVideoClipDeclaration(declaration);
  if (!normalized.ok) throw new Error(`動画クリップの宣言が読めない: ${normalized.problems.join(", ")}`);
  const info = await stat(assetPath);
  if (!info.isFile() || info.size === 0) throw new Error(`測る動画クリップが無いか空: ${assetPath}`);
  const assetSha256 = await fileSha256(assetPath);
  const probed = await probe(tool(ffprobe, "ffprobe"), assetPath);
  const decoded = probed.readable && probed.videoStreams > 0
    ? await decode(tool(ffmpeg, "ffmpeg"), assetPath)
    : { pass: false, decodedFrames: 0, errorSample: probed.readable ? "no video stream" : probed.errorSample || "unreadable" };
  return {
    version: VIDEO_CLIP_MEASUREMENT_VERSION,
    assetSha256,
    assetBytes: info.size,
    measuredAt: new Date(now()).toISOString(),
    tools: { probe: "ffprobe", decode: "ffmpeg -xerror" },
    declaration: normalized.declaration,
    probe: probed,
    decode: decoded,
  };
}

/**
 * 測定の数値から機械ゲートを決める（純関数。測定のファイルに書かれた合否は読まない）。
 * assetSha256 は採点する版の sha256。測定が別のファイルのもの・宣言が壊れているものは、どのゲートも通さない。
 * 戻り値: { bound, gates: { <id>: boolean }, problems: string[], metrics }
 */
export function evaluateVideoClipMeasurement(measurement, { assetSha256 = "" } = {}) {
  const gates = Object.fromEntries(VIDEO_CLIP_GATE_IDS.map((id) => [id, false]));
  const problems = [];
  const expected = String(assetSha256 || "").toLowerCase();
  if (!plainObject(measurement)) return { bound: false, gates, problems: ["measurement-missing"], metrics: {} };
  if (measurement.version !== VIDEO_CLIP_MEASUREMENT_VERSION) problems.push("measurement-version");
  const measured = String(measurement.assetSha256 || "").toLowerCase();
  if (!SHA256.test(measured) || measured !== expected) problems.push("measurement-not-bound-to-clip");
  const declared = normalizeVideoClipDeclaration(measurement.declaration);
  if (!declared.ok) problems.push(...declared.problems.map((problem) => `declaration:${problem}`));
  const probe = plainObject(measurement.probe) ? measurement.probe : {};
  const decoded = plainObject(measurement.decode) ? measurement.decode : {};
  const metrics = {
    formatName: typeof probe.formatName === "string" ? probe.formatName : "",
    videoCodec: typeof probe.videoCodec === "string" ? probe.videoCodec : "",
    width: finite(probe.width),
    height: finite(probe.height),
    frameRate: finite(probe.frameRate),
    durationSeconds: finite(probe.durationSeconds),
    hasAudio: probe.hasAudio === true,
    decodedFrames: finite(decoded.decodedFrames),
  };
  if (problems.length > 0) return { bound: false, gates, problems, metrics };
  gates["video-measurement-bound"] = true;
  const declaration = declared.declaration;
  const containers = metrics.formatName.split(",").map((value) => value.trim()).filter(Boolean);
  gates["video-format-readable"] = probe.readable === true
    && containers.some((value) => VIDEO_CLIP_CONTAINERS.includes(value))
    && Number(probe.videoStreams) >= 1
    && metrics.videoCodec !== "";
  if (!gates["video-format-readable"]) problems.push(`format-unreadable:${metrics.formatName || "none"}/${metrics.videoCodec || "none"}`);
  const expectedFrames = metrics.durationSeconds && metrics.frameRate ? metrics.durationSeconds * metrics.frameRate : null;
  gates["video-full-decode"] = decoded.pass === true && Number(metrics.decodedFrames) > 0
    && (expectedFrames === null || metrics.decodedFrames >= Math.floor(expectedFrames * DECODED_FRAME_RATIO) - 2);
  if (!gates["video-full-decode"]) problems.push(`decode-failed:${metrics.decodedFrames ?? 0}${expectedFrames ? `/${Math.round(expectedFrames)}` : ""}`);
  const duration = metrics.durationSeconds;
  gates["video-duration-declared"] = duration !== null
    && duration >= declaration.durationSeconds.min - DURATION_EPSILON
    && duration <= declaration.durationSeconds.max + DURATION_EPSILON;
  if (!gates["video-duration-declared"]) problems.push(`duration-outside:${duration}∉[${declaration.durationSeconds.min},${declaration.durationSeconds.max}]`);
  const rate = metrics.frameRate;
  gates["video-frame-rate-declared"] = rate !== null
    && rate >= declaration.frameRate.min - FRAME_RATE_EPSILON
    && rate <= declaration.frameRate.max + FRAME_RATE_EPSILON;
  if (!gates["video-frame-rate-declared"]) problems.push(`frame-rate-outside:${rate}∉[${declaration.frameRate.min},${declaration.frameRate.max}]`);
  const { width, height } = metrics;
  const within = (value, spec) => value !== null && value >= spec.min && (spec.max === undefined || value <= spec.max);
  const aspect = declaration.aspectRatio;
  const aspectOk = !aspect || (width && height
    && Math.abs(width / height - aspect.width / aspect.height) <= aspect.tolerance * (aspect.width / aspect.height));
  gates["video-resolution-declared"] = within(width, declaration.width) && within(height, declaration.height) && Boolean(aspectOk);
  if (!gates["video-resolution-declared"]) problems.push(`resolution-outside:${width}x${height}`);
  gates["video-audio-declared"] = declaration.audio === "optional"
    || (declaration.audio === "required" && metrics.hasAudio)
    || (declaration.audio === "forbidden" && !metrics.hasAudio);
  if (!gates["video-audio-declared"]) problems.push(`audio-not-as-declared:${declaration.audio}:${metrics.hasAudio ? "present" : "absent"}`);
  return { bound: true, gates, problems, metrics };
}

/**
 * 測って、測定のファイルを原子的に書く（record --measurement に渡すファイル）。同じクリップ（sha256）・同じ宣言の
 * 測定が既にあれば測り直さずにそれを返す（reused: true）。戻り値の verdict は evaluateVideoClipMeasurement の結果。
 */
export async function writeVideoClipMeasurement({
  assetPath,
  declaration,
  outputPath,
  ffprobe = "ffprobe",
  ffmpeg = "ffmpeg",
  now = () => new Date().toISOString(),
} = {}) {
  if (!outputPath) throw new Error("測定の書き先（outputPath）が要ります。");
  const normalized = normalizeVideoClipDeclaration(declaration);
  if (!normalized.ok) throw new Error(`動画クリップの宣言が読めない: ${normalized.problems.join(", ")}`);
  const assetSha256 = await fileSha256(assetPath);
  let existing = null;
  try {
    existing = JSON.parse(await readFile(outputPath, "utf8"));
  } catch {
    existing = null;
  }
  const sameDeclaration = JSON.stringify(normalizeVideoClipDeclaration(existing?.declaration).declaration)
    === JSON.stringify(normalized.declaration);
  const measurement = existing?.version === VIDEO_CLIP_MEASUREMENT_VERSION && existing.assetSha256 === assetSha256 && sameDeclaration
    ? existing
    : await measureVideoClip({ assetPath, declaration: normalized.declaration, ffprobe, ffmpeg, now });
  const reused = measurement === existing;
  if (!reused) await writeJsonAtomic(outputPath, measurement);
  const bytes = await readFile(outputPath);
  return {
    path: outputPath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    measurement,
    verdict: evaluateVideoClipMeasurement(measurement, { assetSha256 }),
    reused,
  };
}
