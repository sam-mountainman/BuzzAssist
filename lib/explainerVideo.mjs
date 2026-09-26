// 解説動画のハーネス（explainer-video）の本体。チャンネルの既存のローカルの制作を作り直さず、共通の入口
// （scripts/run-video-harness.mjs の Job・RunReceipt・Canvas の投影）へつなぐ「薄い接続」。
//
// 実行の型（Job の options.explainerMode。lib/explainerChannelPack.mjs）:
//   - import-delivery（既定）: 制作が書いた納品の記録（Pack の delivery.file）の成果物（動画・字幕・サムネ・投稿用情報）と
//     台本の SHA を照合し、一致すれば制作のスクリプトを起動せずに取り込んで監査する。一致しなければ理由コードで止める。
//     子プロセスの環境には lib/paidCallGuard.mjs の関所（BUZZASSIST_PAID_CALL_GUARD）が入り、BuzzAssist の有料の送り口を
//     通る呼び出しは送る前に止まる。止めた呼び出しが1件でもあれば合格にしない
//   - produce: Pack の production.steps（argv の雛形。3つのパスを必ず明示）を順に子プロセスで起動し、できた納品を
//     同じ監査にかける
//
// 監査（完成 MP4 と納品の記録で測る。共通の部品を使い、2つ目を作らない）:
//   - 実デコード: lib/videoHarnessReceipt.mjs の validateFinalVideoMedia（ffprobe ＋ ffmpeg -xerror で映像と音声を最後まで）
//   - 台本の品質ループ: lib/scriptQualityUseGate.mjs（ジャンル explainer）
//   - 途中の成果物の品質ループ: lib/assetQualityUseGate.mjs（harness explainer-video）
//   - 記録: lib/harnessRunReceipt.mjs（宣言の保証 → 監査の対応、効力のある契約の版で測る）
//   - 複数のファイルの確定: lib/fileTransaction.mjs
//
// 人の試聴・初見の評価は機械の合格とは別。記録する口がまだ無いので、いつも knownRemainingIssues に残り、
// Job は awaiting-human-review で止まる（宣言の completion.status: pending）。点数を作らない。

import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { checkAssetQualityBeforeUse } from "./assetQualityUseGate.mjs";
import {
  EXPLAINER_HARNESS_ID,
  EXPLAINER_RENDERER_URL_OPTION,
  assertExplainerStartOptions,
  loadExplainerChannelPack,
  resolveExplainerSteps,
} from "./explainerChannelPack.mjs";
import { openFileTransaction, recoverFileTransactions } from "./fileTransaction.mjs";
import {
  declaredAuditIdsInForce,
  finalizeRunReceipt,
  openRunReceipt,
  recordGatesFromAuditChecks,
  recordRunArtifact,
} from "./harnessRunReceipt.mjs";
import { resolveFfmpegToolchain } from "./harnessRuntimeResolver.mjs";
import { getImageDimensionsFromBuffer } from "./imageDimensions.mjs";
import { paidCallGuardPath, readPaidCallGuardLedger } from "./paidCallGuard.mjs";
import { SCRIPT_QUALITY_WORK_DIR_OPTION, checkScriptQualityBeforeProduction } from "./scriptQualityUseGate.mjs";
import { validateFinalVideoMedia } from "./videoHarnessReceipt.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFile = promisify(execFileCallback);

export const EXPLAINER_AUDIT_VERSION = "buzzassist-explainer-audit-v1";
/** 監査契約の版（宣言の保証の inForceSince と同じ系列）。 */
export const EXPLAINER_AUDIT_CONTRACT = "buzzassist-explainer-audit-v1";
export const EXPLAINER_OUTCOME_VERSION = "buzzassist-explainer-video-outcome-v1";
export const EXPLAINER_PLAN_VERSION = "buzzassist-explainer-video-plan-v1";
export const EXPLAINER_OUTER_JOB_REQUIRED_CODE = "explainer-outer-job-required";
/** 人の試聴・初見の評価は機械の監査の外。記録の口ができるまで、いつもこの印で人待ちに残る。 */
export const EXPLAINER_HUMAN_REVIEW_ISSUE = "explainer-human-review-pending";
export const EXPLAINER_WORK_DIR = "explainer";

/** 宣言の evidenceAuditIds と同じ id（試験が宣言と一致を見る）。 */
export const EXPLAINER_AUDIT_IDS = Object.freeze([
  "deliveryManifestBound",
  "scriptBoundToDelivery",
  "deliveryArtifactsBound",
  "finalVideoFullDecode",
  "durationMatchesDelivery",
  "captionsTimingInRange",
  "thumbnailPresent",
  "scriptQualityAccepted",
  "assetQualityLoopsPassed",
  "displayNumeralsArabic",
  "bgmAbsentMeasured",
  "noBuzzAssistPaidCalls",
]);

// BGM の無い完成版は、語りの文の間に音のほぼ無い区間がある（-50 dBFS 未満が 0.3 秒以上）。BGM を敷くとこの区間が
// 消える。基準にした声だけの長尺の完成版では区間の間隔は最大 7 秒ほど、試験の合成で低い持続音を重ねた版は
// 区間が 0 個だった。間隔の上限は、その間で余裕を大きく取った 60 秒。
const BGM_SILENCE_NOISE_DB = -50;
const BGM_SILENCE_MIN_SECONDS = 0.3;
const BGM_MAX_SOUND_RUN_SECONDS = 60;
// 尺の許し: 1フレーム（30fps）より少し大きい値。納品の記録は同じファイルの ffprobe の値なので、普通は一致する。
const DURATION_TOLERANCE_SECONDS = 0.05;
// 算用数字の決まりで見るのは、漢数字が2字以上続き、そのあとに数え方の語が来る形だけ（「一方」「一人で」のような
// 語は拾わない。数量・年を漢数字で書いた「二〇二六年」「五百ピース」「十五分」を拾う）。
const KANJI_NUMERAL_QUANTITY = /[〇一二三四五六七八九十百千万億]{2,}(?:年|人|分|秒|時間|日|か月|ヶ月|カ月|ピース|個|回|本|点|歳|％|%|倍|枚|件|円|割|パーセント|ページ|問|種類|章)/gu;
const PRODUCTION_STEP_TIMEOUT_MS = 12 * 60 * 60 * 1000;

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function within(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** 通常ファイルとして読めるか（symlink は受けない）と、sha256・大きさ。読めなければ null と理由。 */
async function fileFacts(file) {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink()) return { ok: false, reason: "symlink" };
    if (!info.isFile()) return { ok: false, reason: "not-a-file" };
    if (info.size === 0) return { ok: false, reason: "empty" };
    return { ok: true, bytes: info.size, sha256: await sha256File(file) };
  } catch (error) {
    return { ok: false, reason: error?.code === "ENOENT" ? "missing" : "unreadable" };
  }
}

function secondsOf(timecode) {
  const match = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/u.exec(String(timecode || "").trim());
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4].padEnd(3, "0")) / 1000;
}

/**
 * SRT を読む。番号の行と時刻の行が続いたところを字幕の始まりとし、次の始まりまでを本文とする（本文の中の空行でも
 * 字幕を切らない）。本文は数を数えるためだけに持ち、外へは出さない。
 */
export function parseSrt(text) {
  const raw = String(text || "");
  const withoutBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const lines = withoutBom.replace(/\r\n?/gu, "\n").split("\n");
  const cues = [];
  const timing = /^\s*(\S+)\s+-->\s+(\S+)/u;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*\d+\s*$/u.test(lines[index]) && timing.test(lines[index + 1] || "")) {
      const [, start, end] = timing.exec(lines[index + 1]);
      cues.push({ number: Number(lines[index].trim()), start: secondsOf(start), end: secondsOf(end), lines: [] });
      index += 1;
      continue;
    }
    if (cues.length > 0) cues.at(-1).lines.push(lines[index]);
  }
  return cues.map((cue) => {
    // 末尾の空行（字幕の区切り）は数えない。時刻の行の直後の空行は数える（読み手によってはそこで字幕が終わる）。
    const body = [...cue.lines];
    while (body.length > 0 && !body.at(-1).trim()) body.pop();
    return {
      number: cue.number,
      start: cue.start,
      end: cue.end,
      text: body.map((line) => line.trim()).filter(Boolean).join(" "),
      blankFirstLine: body.length > 0 && !body[0].trim(),
    };
  });
}

// ---------------------------------------------------------------------------
// 納品の記録（制作が書いた DELIVERY.json の形）

/**
 * 納品の記録を読み、成果物の場所と記録された SHA を取り出す。受ける形（制作側の書き方）:
 *   { script_sha256, script, video: { file, sha256, bytes, duration_seconds, width, height, fps, frames?, bgm?, script_sha256? },
 *     captions, captions_sha256, thumbnail, thumbnail_sha256, upload_metadata, upload_metadata_sha256? }
 * パスは絶対か、記録のあるフォルダからの相対。成果物は Pack の outputDir、台本は productionDir の中でなければならない。
 */
export async function readExplainerDelivery(pack) {
  const file = pack.delivery.file;
  const facts = await fileFacts(file);
  if (!facts.ok) return { ok: false, file, problems: [`delivery-${facts.reason}`] };
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return { ok: false, file, sha256: facts.sha256, problems: ["delivery-unreadable"] };
  }
  const problems = [];
  const base = path.dirname(file);
  const place = (value, label, parent) => {
    const text = nonEmpty(value);
    if (!text) { problems.push(`delivery-field-missing:${label}`); return ""; }
    const resolved = path.isAbsolute(text) ? path.resolve(text) : path.resolve(base, text);
    if (!within(parent, resolved)) problems.push(`delivery-path-outside:${label}`);
    return resolved;
  };
  const sha = (value, label, { required = true } = {}) => {
    const text = nonEmpty(value).toLowerCase();
    if (!text) { if (required) problems.push(`delivery-field-missing:${label}`); return ""; }
    if (!/^[a-f0-9]{64}$/u.test(text)) { problems.push(`delivery-sha-invalid:${label}`); return ""; }
    return text;
  };
  const video = plainObject(parsed?.video) ? parsed.video : {};
  if (!plainObject(parsed?.video)) problems.push("delivery-field-missing:video");
  const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
  const delivery = {
    ok: true,
    file,
    sha256: facts.sha256,
    bytes: facts.bytes,
    scriptSha256: sha(parsed?.script_sha256, "script_sha256"),
    script: { file: place(parsed?.script, "script", pack.paths.productionDir) },
    video: {
      file: place(video.file, "video.file", pack.paths.outputDir),
      sha256: sha(video.sha256, "video.sha256"),
      bytes: number(video.bytes),
      durationSeconds: number(video.duration_seconds),
      width: number(video.width),
      height: number(video.height),
      fps: number(video.fps),
      frames: number(video.frames),
      bgm: typeof video.bgm === "boolean" ? video.bgm : null,
      scriptSha256: sha(video.script_sha256, "video.script_sha256", { required: false }),
    },
    captions: { file: place(parsed?.captions, "captions", pack.paths.outputDir), sha256: sha(parsed?.captions_sha256, "captions_sha256") },
    thumbnail: { file: place(parsed?.thumbnail, "thumbnail", pack.paths.outputDir), sha256: sha(parsed?.thumbnail_sha256, "thumbnail_sha256") },
    uploadMetadata: {
      file: place(parsed?.upload_metadata, "upload_metadata", pack.paths.outputDir),
      sha256: sha(parsed?.upload_metadata_sha256, "upload_metadata_sha256", { required: false }),
    },
  };
  if (delivery.video.durationSeconds === null) problems.push("delivery-field-missing:video.duration_seconds");
  return { ...delivery, ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// 監査

async function probeStreams(file, { toolchain, runCommand = execFile, env = process.env }) {
  const { stdout = "" } = await runCommand(
    toolchain.ffprobe.command,
    [...(toolchain.ffprobe.args || []), "-v", "error",
      "-show_entries", "stream=codec_type,width,height,r_frame_rate,nb_frames:format=duration",
      "-of", "json", file],
    { env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
  );
  const parsed = JSON.parse(String(stdout));
  const videoStream = (parsed.streams || []).find((stream) => stream?.codec_type === "video") || {};
  const [num, den] = String(videoStream.r_frame_rate || "0/1").split("/").map(Number);
  return {
    durationSeconds: Number(parsed?.format?.duration),
    width: Number(videoStream.width),
    height: Number(videoStream.height),
    fps: den > 0 ? num / den : null,
    frames: Number.isFinite(Number(videoStream.nb_frames)) ? Number(videoStream.nb_frames) : null,
  };
}

/** 音の区間（-50 dBFS 未満が 0.3 秒以上続く区間の間）の最長と、無音の区間の数。 */
export function soundRunsFromSilencedetect(stderr, durationSeconds) {
  const silences = [];
  for (const line of String(stderr || "").split(/\r?\n/u)) {
    const start = /silence_start:\s*(-?[\d.]+)/u.exec(line);
    if (start) silences.push({ start: Math.max(0, Number(start[1])), end: null });
    const end = /silence_end:\s*([\d.]+)/u.exec(line);
    if (end && silences.length > 0 && silences.at(-1).end === null) silences.at(-1).end = Number(end[1]);
  }
  let cursor = 0;
  let longest = 0;
  for (const silence of silences) {
    longest = Math.max(longest, silence.start - cursor);
    cursor = silence.end === null ? durationSeconds : silence.end;
  }
  longest = Math.max(longest, Math.max(0, durationSeconds - cursor));
  return { silenceCount: silences.length, longestSoundRunSeconds: Math.round(longest * 1000) / 1000 };
}

async function measureBgmAbsence(file, durationSeconds, { toolchain, runCommand = execFile, env = process.env }) {
  let stderr = "";
  try {
    const result = await runCommand(
      toolchain.ffmpeg.command,
      [...(toolchain.ffmpeg.args || []), "-hide_banner", "-nostats", "-i", file, "-map", "0:a:0",
        "-af", `silencedetect=noise=${BGM_SILENCE_NOISE_DB}dB:d=${BGM_SILENCE_MIN_SECONDS}`, "-f", "null", "-"],
      { env, timeout: 30 * 60 * 1000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    );
    stderr = String(result?.stderr || "");
  } catch (error) {
    throw new Error(`音の区間を測れない: ${String(error?.stderr || error?.message || error).slice(-600)}`);
  }
  return soundRunsFromSilencedetect(stderr, durationSeconds);
}

function check(pass, detail, extra = {}) {
  return { pass: pass === true, detail: String(detail || ""), ...extra };
}

/**
 * 取り込む納品を監査する。返すのは監査の checks（宣言の evidenceAuditIds と同じ id）、残りの項目（理由コード）、
 * 取り込んだ成果物の一覧、観察（合否に使わない）。書き込みはしない。
 *
 * runtime で差し替えられるもの（試験用）: toolchain, runCommand, verifyFinalVideo, scriptQualityCheck, assetQualityCheck
 */
export async function auditExplainerDelivery({ job, pack, mode, env = process.env, guardPath = "" } = {}, runtime = {}) {
  const checks = {};
  const issues = [];
  const observations = [];
  const artifacts = [];
  const delivery = await readExplainerDelivery(pack);
  const release = pack.release || null;

  // 納品の記録そのもの。
  const deliveryProblems = [...(delivery.problems || [])];
  if (release && delivery.sha256 && release.deliverySha256 !== delivery.sha256) deliveryProblems.push("delivery-release-pin-mismatch");
  checks.deliveryManifestBound = check(
    deliveryProblems.length === 0,
    deliveryProblems.length === 0
      ? `納品の記録を読めた（sha256 ${delivery.sha256.slice(0, 12)}…${release ? "、Pack の版の SHA と一致" : "、Pack は版の SHA を宣言していない"}）`
      : `納品の記録を使えない: ${deliveryProblems.join(", ")}`,
    { deliverySha256: delivery.sha256 || "", pinned: Boolean(release) },
  );
  for (const problem of deliveryProblems) issues.push(`explainer-${problem}`);

  // 台本。Job に保存した写しの SHA が、納品の記録・動画の記録・台本のファイル・Pack の版と同じであること。
  const scriptSha256 = String(job?.script?.sha256 || "");
  const scriptFacts = delivery.script?.file ? await fileFacts(delivery.script.file) : { ok: false, reason: "missing" };
  const scriptProblems = [];
  if (!delivery.scriptSha256 || delivery.scriptSha256 !== scriptSha256) scriptProblems.push("delivery-record");
  if (delivery.video?.scriptSha256 && delivery.video.scriptSha256 !== scriptSha256) scriptProblems.push("video-record");
  if (!scriptFacts.ok || scriptFacts.sha256 !== scriptSha256) scriptProblems.push("script-file");
  if (release && release.scriptSha256 !== scriptSha256) scriptProblems.push("release-pin");
  checks.scriptBoundToDelivery = check(
    scriptProblems.length === 0,
    scriptProblems.length === 0
      ? `Job の台本（${scriptSha256.slice(0, 12)}…）が納品の記録・台本のファイル${release ? "・Pack の版" : ""}と同じ`
      : `Job の台本が一致しない: ${scriptProblems.join(", ")}`,
    { scriptSha256 },
  );
  if (scriptProblems.length > 0) issues.push(`explainer-script-not-bound-to-delivery:${scriptProblems.join("+")}`);

  // 成果物。記録の SHA と実ファイル、Pack の版の SHA（宣言があれば）。
  const roles = [
    { role: "final-video", kind: "final-video", entry: delivery.video, pin: release?.videoSha256 },
    { role: "subtitle", kind: "subtitle", entry: delivery.captions, pin: release?.captionsSha256 },
    { role: "thumbnail", kind: "thumbnail", entry: delivery.thumbnail, pin: release?.thumbnailSha256 },
    { role: "upload-metadata", kind: "upload-metadata", entry: delivery.uploadMetadata, pin: release?.uploadMetadataSha256 },
  ];
  const artifactProblems = [];
  const measured = {};
  for (const { role, kind, entry, pin } of roles) {
    if (!entry?.file) { artifactProblems.push(`${role}:missing`); continue; }
    const facts = await fileFacts(entry.file);
    if (!facts.ok) { artifactProblems.push(`${role}:${facts.reason}`); continue; }
    measured[role] = { ...facts, file: entry.file };
    const declared = entry.sha256 || "";
    if (!declared && !pin) artifactProblems.push(`${role}:sha-unrecorded`);
    if (declared && declared !== facts.sha256) artifactProblems.push(`${role}:delivery-sha-mismatch`);
    if (pin && pin !== facts.sha256) artifactProblems.push(`${role}:release-pin-mismatch`);
    if (role === "final-video" && Number.isFinite(entry.bytes) && entry.bytes !== facts.bytes) artifactProblems.push(`${role}:bytes-mismatch`);
    artifacts.push({ kind, path: entry.file, sha256: facts.sha256, bytes: facts.bytes });
  }
  checks.deliveryArtifactsBound = check(
    artifactProblems.length === 0,
    artifactProblems.length === 0
      ? `動画・字幕・サムネ・投稿用情報の SHA が納品の記録${release ? "と Pack の版" : ""}と一致`
      : `成果物が納品の記録と一致しない: ${artifactProblems.join(", ")}`,
    { artifacts: artifacts.map(({ kind, sha256, bytes }) => ({ kind, sha256, bytes })) },
  );
  for (const problem of artifactProblems) issues.push(`explainer-delivery-artifact:${problem}`);

  // 動画の実デコード（SHA が合った動画だけ。合わない動画をデコードして合格にしない）。
  // 納品の記録（と Pack の版）と一致した成果物だけを測る。一致しないファイルを測って合格にしない。
  const boundArtifact = (role) => (measured[role] && !artifactProblems.some((problem) => problem.startsWith(`${role}:`)) ? measured[role] : null);
  const video = boundArtifact("final-video");
  const videoBound = Boolean(video);
  let decode = null;
  if (videoBound) {
    try {
      decode = await (runtime.verifyFinalVideo || validateFinalVideoMedia)(
        { path: video.file, sha256: video.sha256, bytes: video.bytes },
        { env },
      );
      checks.finalVideoFullDecode = check(decode?.pass === true && decode.sha256 === video.sha256,
        `映像と音声を最後までデコードした（${Math.round(Number(decode?.durationSeconds) * 1000) / 1000} 秒、${(decode?.streamTypes || []).join("+")}）`,
        { videoSha256: video.sha256, durationSeconds: decode?.durationSeconds ?? null });
    } catch (error) {
      checks.finalVideoFullDecode = check(false, `デコードに失敗: ${String(error?.message || error).slice(0, 400)}`);
    }
  } else {
    checks.finalVideoFullDecode = check(false, "動画が納品の記録と一致しないので、デコードしない");
  }
  if (!checks.finalVideoFullDecode.pass) issues.push("explainer-final-video-not-decoded");

  // 尺・寸法・フレームレートを納品の記録と比べる。
  let toolchain = runtime.toolchain || null;
  const needToolchain = async () => {
    if (!toolchain) toolchain = await resolveFfmpegToolchain({ env });
    if (!toolchain?.ok) throw new Error(`ffmpeg / ffprobe を解決できない: ${toolchain?.ffmpeg?.detail || toolchain?.ffprobe?.detail || "unavailable"}`);
    return toolchain;
  };
  let probed = null;
  if (videoBound && checks.finalVideoFullDecode.pass) {
    try {
      probed = await (runtime.probeStreams || probeStreams)(video.file, { toolchain: await needToolchain(), runCommand: runtime.runCommand, env });
      const problems = [];
      const recorded = delivery.video;
      if (!(Math.abs(probed.durationSeconds - recorded.durationSeconds) <= DURATION_TOLERANCE_SECONDS)) problems.push(`duration ${probed.durationSeconds} / ${recorded.durationSeconds}`);
      if (recorded.width !== null && probed.width !== recorded.width) problems.push(`width ${probed.width} / ${recorded.width}`);
      if (recorded.height !== null && probed.height !== recorded.height) problems.push(`height ${probed.height} / ${recorded.height}`);
      if (recorded.fps !== null && !(Math.abs(Number(probed.fps) - recorded.fps) < 0.01)) problems.push(`fps ${probed.fps} / ${recorded.fps}`);
      if (recorded.frames !== null && probed.frames !== null && probed.frames !== recorded.frames) problems.push(`frames ${probed.frames} / ${recorded.frames}`);
      checks.durationMatchesDelivery = check(problems.length === 0,
        problems.length === 0
          ? `尺 ${probed.durationSeconds} 秒・${probed.width}x${probed.height}・${probed.fps}fps が納品の記録と一致（許し ±${DURATION_TOLERANCE_SECONDS} 秒）`
          : `納品の記録と違う: ${problems.join(", ")}`,
        { durationSeconds: probed.durationSeconds, recordedDurationSeconds: recorded.durationSeconds });
    } catch (error) {
      checks.durationMatchesDelivery = check(false, `尺を測れない: ${String(error?.message || error).slice(0, 300)}`);
    }
  } else {
    checks.durationMatchesDelivery = check(false, "動画を確かめられないので、尺を比べない");
  }
  if (!checks.durationMatchesDelivery.pass) issues.push("explainer-duration-mismatch");
  const durationSeconds = Number.isFinite(probed?.durationSeconds) ? probed.durationSeconds : null;

  // 字幕: 存在と時刻の範囲。
  const captions = boundArtifact("subtitle");
  let cues = [];
  if (captions) {
    try {
      cues = parseSrt(await readFile(captions.file, "utf8"));
    } catch {
      cues = [];
    }
    const problems = [];
    if (cues.length === 0) problems.push("字幕が1件も読めない");
    let previousStart = -Infinity;
    let outOfOrder = 0;
    let invalid = 0;
    let beyondEnd = 0;
    let overlapping = 0;
    cues.forEach((cue, index) => {
      if (cue.start === null || cue.end === null || cue.start < 0 || cue.end <= cue.start) invalid += 1;
      if (cue.start !== null && cue.start < previousStart) outOfOrder += 1;
      if (durationSeconds !== null && cue.end !== null && cue.end > durationSeconds + DURATION_TOLERANCE_SECONDS) beyondEnd += 1;
      const next = cues[index + 1];
      if (next && cue.end !== null && next.start !== null && cue.end > next.start + 0.001) overlapping += 1;
      if (cue.start !== null) previousStart = cue.start;
    });
    if (invalid > 0) problems.push(`時刻が読めない・始まりが終わり以後の字幕 ${invalid} 件`);
    if (outOfOrder > 0) problems.push(`始まりが前の字幕より早い字幕 ${outOfOrder} 件`);
    if (durationSeconds === null) problems.push("動画の尺が無いので、終わりの範囲を確かめられない");
    else if (beyondEnd > 0) problems.push(`動画の終わりを越える字幕 ${beyondEnd} 件`);
    const blankFirst = cues.filter((cue) => cue.blankFirstLine).length;
    if (blankFirst > 0) {
      observations.push({
        id: "captions-blank-line-after-timing",
        count: blankFirst,
        cueNumbers: cues.filter((cue) => cue.blankFirstLine).map((cue) => cue.number).slice(0, 40),
        detail: "時刻の行の直後が空行の字幕。ffmpeg は読めるが、読み手によってはそこで字幕が終わったと読み、本文が落ちる。合否には使わない",
      });
    }
    if (overlapping > 0) observations.push({ id: "captions-overlap", count: overlapping, detail: "次の字幕と時刻が重なる字幕。合否には使わない" });
    const last = cues.at(-1);
    checks.captionsTimingInRange = check(problems.length === 0,
      problems.length === 0
        ? `字幕 ${cues.length} 件の時刻が 0〜${durationSeconds} 秒の中で、順に並ぶ（最後の終わり ${last?.end} 秒）`
        : `字幕の時刻に問題: ${problems.join(" / ")}`,
      { cueCount: cues.length, lastEndSeconds: last?.end ?? null });
  } else {
    checks.captionsTimingInRange = check(false, "字幕のファイルが無い・納品の記録と一致しない");
  }
  if (!checks.captionsTimingInRange.pass) issues.push("explainer-captions-invalid");

  // サムネ: 存在と、画として読めること（寸法）。
  const thumbnail = boundArtifact("thumbnail");
  if (thumbnail) {
    let dims = null;
    try {
      dims = getImageDimensionsFromBuffer(await readFile(thumbnail.file), "thumbnail");
    } catch {
      dims = null;
    }
    const ok = Number(dims?.width) > 0 && Number(dims?.height) > 0;
    checks.thumbnailPresent = check(ok,
      ok ? `サムネ ${dims.width}x${dims.height}（${thumbnail.bytes} bytes）` : "サムネを画として読めない（PNG / JPEG / WebP の見出しが無い）",
      ok ? { width: dims.width, height: dims.height } : {});
  } else {
    checks.thumbnailPresent = check(false, "サムネのファイルが無い・納品の記録と一致しない");
  }
  if (!checks.thumbnailPresent.pass) issues.push("explainer-thumbnail-missing");

  // 台本の品質ループ（ジャンル explainer）。作業フォルダは Job の options.scriptQualityWorkDir、無ければ Pack の宣言。
  const scriptWorkDir = nonEmpty(job?.options?.[SCRIPT_QUALITY_WORK_DIR_OPTION]) || pack.scriptQuality.workDir;
  let scriptGate;
  try {
    scriptGate = await (runtime.scriptQualityCheck || checkScriptQualityBeforeProduction)({
      workDir: scriptWorkDir,
      scriptPath: job.script.path,
      genre: "explainer",
      commandScriptPath: delivery.script?.file || "",
    });
  } catch (error) {
    scriptGate = { pass: false, reasonCode: "script-quality-check-error", issues: ["script-quality-required:script-quality-check-error"], next: [], evidence: null, detail: String(error?.message || error) };
  }
  checks.scriptQualityAccepted = check(scriptGate.pass,
    scriptGate.pass
      ? `台本の品質ループ（explainer）で使ってよい版（${scriptGate.acceptedBy === "human" ? "人がそのまま使うと認めた" : "ループが合格した"}）`
      : `台本の品質ループの答え: ${scriptGate.reasonCode}`,
    { evidence: scriptGate.evidence || null });
  if (!scriptGate.pass) issues.push(...(scriptGate.issues?.length ? scriptGate.issues : [`script-quality-required:${scriptGate.reasonCode}`]));

  // 途中の成果物の品質ループ（harness explainer-video）。Pack が宣言した工程の成果物を、合格した版かで照合する。
  const assetRows = [];
  for (const stage of pack.assetQuality.stages) {
    const target = stage === "thumbnail" ? thumbnail : null;
    if (!target) {
      assetRows.push({ stage, pass: false, code: `asset-quality-required:${stage}:${stage}:asset-missing`, detail: "照合する成果物が無い" });
      continue;
    }
    try {
      assetRows.push(await (runtime.assetQualityCheck || checkAssetQualityBeforeUse)({
        harnessId: EXPLAINER_HARNESS_ID,
        workDir: pack.assetQuality.workDir,
        stage,
        subjectId: stage,
        assetPath: target.file,
      }));
    } catch (error) {
      assetRows.push({ stage, pass: false, code: `asset-quality-required:${stage}:${stage}:check-error`, detail: String(error?.message || error).slice(0, 300) });
    }
  }
  const assetPassed = assetRows.length > 0 && assetRows.every((row) => row.pass === true);
  checks.assetQualityLoopsPassed = check(assetPassed,
    assetPassed
      ? `途中の成果物の品質ループに合格した版（${assetRows.map((row) => row.stage).join(", ")}）`
      : `品質ループが合格していない: ${assetRows.filter((row) => row.pass !== true).map((row) => row.code).join(", ")}`,
    { rows: assetRows.map((row) => ({ stage: row.stage, pass: row.pass === true, code: row.code || "", detail: String(row.detail || "").slice(0, 300) })) });
  for (const row of assetRows.filter((entry) => entry.pass !== true)) issues.push(row.code);

  // 表示の決まり: 数の書き方（字幕の文字で見る。声の読みではない）。
  if (pack.display.numerals === "arabic") {
    if (!captions || cues.length === 0) {
      checks.displayNumeralsArabic = check(false, "字幕が読めないので、数の書き方を確かめられない");
    } else {
      const flagged = cues.filter((cue) => { KANJI_NUMERAL_QUANTITY.lastIndex = 0; return KANJI_NUMERAL_QUANTITY.test(cue.text); });
      checks.displayNumeralsArabic = check(flagged.length === 0,
        flagged.length === 0
          ? `字幕 ${cues.length} 件に、漢数字で書いた数量・年（2字以上の漢数字＋数え方の語）が無い`
          : `漢数字で書いた数量・年がある字幕 ${flagged.length} 件（番号 ${flagged.map((cue) => cue.number).slice(0, 20).join(", ")}）`,
        { flaggedCueNumbers: flagged.map((cue) => cue.number).slice(0, 100) });
    }
  } else {
    checks.displayNumeralsArabic = check(true, "Pack は数の書き方を決めていない（display.numerals: any）");
  }
  if (!checks.displayNumeralsArabic.pass) issues.push("explainer-display-numerals-not-arabic");

  // 表示の決まり: BGM なし（完成 MP4 の音で測る。納品の記録の bgm も見る）。
  if (pack.display.bgm === "none") {
    if (!videoBound || !checks.finalVideoFullDecode.pass || durationSeconds === null) {
      checks.bgmAbsentMeasured = check(false, "動画を確かめられないので、BGM の有無を測らない");
    } else {
      try {
        const runs = await (runtime.measureBgm || measureBgmAbsence)(video.file, durationSeconds, { toolchain: await needToolchain(), runCommand: runtime.runCommand, env });
        const problems = [];
        if (runs.silenceCount === 0) problems.push("語りの間の無音の区間が1つも無い");
        if (runs.longestSoundRunSeconds > BGM_MAX_SOUND_RUN_SECONDS) problems.push(`音の途切れない区間が ${runs.longestSoundRunSeconds} 秒続く（上限 ${BGM_MAX_SOUND_RUN_SECONDS} 秒）`);
        if (delivery.video.bgm === true) problems.push("納品の記録が BGM ありと書いている");
        checks.bgmAbsentMeasured = check(problems.length === 0,
          problems.length === 0
            ? `語りの間の無音（${BGM_SILENCE_NOISE_DB} dBFS 未満・${BGM_SILENCE_MIN_SECONDS} 秒以上）が ${runs.silenceCount} 区間、音の途切れない最長 ${runs.longestSoundRunSeconds} 秒（上限 ${BGM_MAX_SOUND_RUN_SECONDS} 秒）`
            : `BGM が敷かれている疑い: ${problems.join(" / ")}`,
          runs);
      } catch (error) {
        checks.bgmAbsentMeasured = check(false, String(error?.message || error).slice(0, 400));
      }
    }
  } else {
    checks.bgmAbsentMeasured = check(true, "Pack は BGM を禁じていない（display.bgm: allowed）");
  }
  if (!checks.bgmAbsentMeasured.pass) issues.push("explainer-display-bgm-present");

  // BuzzAssist の有料の送り口を通った呼び出し（関所の台帳）。取り込みでは関所が効いていなければ合格にしない。
  const guard = nonEmpty(guardPath) || paidCallGuardPath(env);
  if (!guard) {
    checks.noBuzzAssistPaidCalls = check(mode !== "import-delivery",
      mode === "import-delivery"
        ? "取り込みなのに有料の呼び出しの関所（BUZZASSIST_PAID_CALL_GUARD）が効いていない"
        : "制作の実行（produce）: 関所は入れていない。チャンネルの制作のスクリプトが外で何を呼ぶかは、このハーネスの外");
  } else {
    const refused = readPaidCallGuardLedger(guard);
    checks.noBuzzAssistPaidCalls = check(refused.length === 0,
      refused.length === 0
        ? "BuzzAssist の有料の送り口を通った呼び出しは 0 件（関所の台帳が空）"
        : `関所が止めた有料の呼び出し ${refused.length} 件（課金はしていない）`,
      { refusedPaidCalls: refused.length });
  }
  if (!checks.noBuzzAssistPaidCalls.pass) issues.push("explainer-paid-call-refused");

  return { checks, issues: [...new Set(issues)], observations, artifacts, delivery };
}

// ---------------------------------------------------------------------------
// 計画（plan-only。読むだけ）

/**
 * 何を実行し、何を再利用するかを出す。モデルも有料 API も呼ばず、制作のスクリプトも起動しない。書き込みもしない。
 * 動画の実デコードはしない（取り込みの監査で行う）。成果物の SHA は計算して比べる。
 */
export async function planExplainerVideo({ pack, scriptPath = "", options = {} } = {}, runtime = {}) {
  const mode = assertExplainerStartOptions(options);
  const delivery = await readExplainerDelivery(pack);
  const release = pack.release || null;
  const blockers = [];
  const reuse = [];
  if (mode === "import-delivery") {
    for (const problem of delivery.problems || []) blockers.push(`explainer-${problem}`);
    if (release && delivery.sha256 && release.deliverySha256 !== delivery.sha256) blockers.push("explainer-delivery-release-pin-mismatch");
    const rows = [
      ["final-video", delivery.video, release?.videoSha256],
      ["subtitle", delivery.captions, release?.captionsSha256],
      ["thumbnail", delivery.thumbnail, release?.thumbnailSha256],
      ["upload-metadata", delivery.uploadMetadata, release?.uploadMetadataSha256],
    ];
    for (const [role, entry, pin] of rows) {
      if (!entry?.file) continue;
      const facts = await fileFacts(entry.file);
      const matches = facts.ok && (!entry.sha256 || entry.sha256 === facts.sha256) && (!pin || pin === facts.sha256) && Boolean(entry.sha256 || pin);
      reuse.push({ role, file: entry.file, sha256: facts.sha256 || "", recordedSha256: entry.sha256 || "", pinnedSha256: pin || "", matches });
      if (!matches) blockers.push(`explainer-delivery-artifact:${role}:${facts.ok ? "sha-mismatch" : facts.reason}`);
    }
  }
  let script = { provided: false };
  if (nonEmpty(scriptPath)) {
    const facts = await fileFacts(path.resolve(scriptPath));
    const sha = facts.sha256 || "";
    const bound = Boolean(sha) && sha === delivery.scriptSha256 && (!release || release.scriptSha256 === sha);
    script = { provided: true, sha256: sha, boundToDelivery: bound };
    if (mode === "import-delivery" && !bound) blockers.push("explainer-script-not-bound-to-delivery");
  }
  const scriptWorkDir = nonEmpty(options?.[SCRIPT_QUALITY_WORK_DIR_OPTION]) || pack.scriptQuality.workDir;
  let scriptQuality = { checked: false };
  if (script.provided && script.sha256) {
    const gate = await (runtime.scriptQualityCheck || checkScriptQualityBeforeProduction)({
      workDir: scriptWorkDir,
      scriptPath: path.resolve(scriptPath),
      genre: "explainer",
      commandScriptPath: path.resolve(scriptPath),
    });
    scriptQuality = { checked: true, pass: gate.pass, reasonCode: gate.reasonCode, workDir: gate.workDir, next: gate.next };
    if (!gate.pass) blockers.push(...gate.issues);
  }
  const assetQuality = [];
  if (mode === "import-delivery" && delivery.thumbnail?.file) {
    for (const stage of pack.assetQuality.stages) {
      const row = await (runtime.assetQualityCheck || checkAssetQualityBeforeUse)({
        harnessId: EXPLAINER_HARNESS_ID, workDir: pack.assetQuality.workDir, stage, subjectId: stage, assetPath: delivery.thumbnail.file,
      });
      assetQuality.push({ stage, pass: row.pass === true, code: row.code || "", detail: row.detail || "" });
      if (row.pass !== true) blockers.push(row.code);
    }
  }
  let wouldRun = [];
  if (mode === "produce") {
    if (!pack.production.declared) blockers.push("explainer-production-not-declared");
    else {
      const resolved = resolveExplainerSteps(pack, { rendererUrl: options?.[EXPLAINER_RENDERER_URL_OPTION] || "" });
      wouldRun = resolved.steps.map((step) => ({ id: step.id, label: step.label, command: step.command, args: step.args, cwd: step.cwd }));
      for (const name of resolved.missing) blockers.push(name === "rendererUrl" ? "explainer-renderer-url-required" : `explainer-step-placeholder-missing:${name}`);
    }
  }
  return {
    version: EXPLAINER_PLAN_VERSION,
    harnessId: EXPLAINER_HARNESS_ID,
    channelId: pack.channelId,
    mode,
    paths: { videoRoot: pack.videoRoot, ...pack.paths },
    delivery: {
      file: pack.delivery.file,
      sha256: delivery.sha256 || "",
      pinned: Boolean(release),
      readable: !(delivery.problems || []).some((problem) => /^delivery-(?:missing|unreadable|symlink|not-a-file|empty)$/u.test(problem)),
    },
    script,
    reuse,
    wouldRun,
    productionDeclared: pack.production.declared,
    ...(pack.production.declared ? {} : { productionNotDeclaredReason: pack.production.reason }),
    scriptQuality,
    assetQuality,
    humanReview: { status: "pending", issue: EXPLAINER_HUMAN_REVIEW_ISSUE },
    blockers: [...new Set(blockers)],
    paidCallsAttempted: false,
    modelCallsAttempted: false,
    productionScriptsRun: false,
  };
}

// ---------------------------------------------------------------------------
// 制作の実行（produce）

async function runStep(step, { logPath, env, timeoutMs = PRODUCTION_STEP_TIMEOUT_MS, spawnProcess = spawn }) {
  await mkdir(path.dirname(logPath), { recursive: true });
  const log = createWriteStream(logPath, { flags: "w" });
  const started = Date.now();
  const child = spawnProcess(step.command, step.args, { cwd: step.cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* 既に終わっている */ } }, timeoutMs);
  const result = await new Promise((resolveExit) => {
    child.once("error", (error) => resolveExit({ code: null, signal: null, error: String(error?.code || error?.message || error) }));
    child.once("close", (code, signal) => resolveExit({ code, signal, error: "" }));
  });
  clearTimeout(timer);
  await new Promise((done) => log.end(done));
  return { id: step.id, exitCode: result.code, signal: result.signal || "", error: result.error, durationMs: Date.now() - started, logPath };
}

/** Pack の制作のコマンドを順に起動する。1つでも失敗したらそこで止める（次の工程へ進まない）。 */
export async function runExplainerProduction({ pack, rendererUrl = "", workDir, env = process.env } = {}, runtime = {}) {
  if (!pack.production.declared) {
    return { ok: false, code: "explainer-production-not-declared", detail: pack.production.reason, steps: [] };
  }
  const resolved = resolveExplainerSteps(pack, { rendererUrl });
  if (resolved.missing.length > 0) {
    return {
      ok: false,
      code: resolved.missing.includes("rendererUrl") ? "explainer-renderer-url-required" : `explainer-step-placeholder-missing:${resolved.missing.join("+")}`,
      detail: `制作のコマンドに要る値が無い: ${resolved.missing.join(", ")}（start の --options-json で options.${EXPLAINER_RENDERER_URL_OPTION} を渡す）`,
      steps: [],
    };
  }
  const results = [];
  for (const step of resolved.steps) {
    const result = await (runtime.runStep || runStep)(step, { logPath: path.join(workDir, "production-logs", `${step.id}.log`), env });
    results.push(result);
    if (result.exitCode !== 0) {
      return { ok: false, code: `explainer-production-step-failed:${step.id}`, detail: `${step.label} が終了コード ${result.exitCode ?? result.signal ?? result.error} で止まった（記録: ${result.logPath}）`, steps: results };
    }
  }
  return { ok: true, code: "", detail: `${results.length} 工程が終わった`, steps: results };
}

// ---------------------------------------------------------------------------
// 上位 Job から呼ばれる本番の入口（full）

function outcome(fields) {
  return { version: EXPLAINER_OUTCOME_VERSION, mediaJobs: [], ...fields };
}

/**
 * 上位の Job（scripts/run-video-harness.mjs の start / resume）からだけ呼ばれる。Job の束縛（upstream binding）が無い・
 * 一部だけの呼び出しは、何もせずに止める（Koya・ナレーション物語の runner と同じ規則）。
 */
export async function runExplainerVideo({
  scriptPath,
  channelPackDir,
  jobId,
  projectDir = "",
  upstreamJobPath,
  upstreamJobId,
  upstreamJobRevision,
  upstreamExecutionBinding,
  env = process.env,
  now = () => new Date().toISOString(),
} = {}, runtime = {}) {
  const upstream = [upstreamJobPath, upstreamJobId, upstreamJobRevision === undefined ? "" : String(upstreamJobRevision), upstreamExecutionBinding];
  const given = upstream.filter((value) => nonEmpty(String(value ?? ""))).length;
  if (given !== upstream.length) {
    const error = new Error(given === 0
      ? `${EXPLAINER_OUTER_JOB_REQUIRED_CODE}: 解説動画の runner は上位の Job（node scripts/run-video-harness.mjs start / resume、MCP の run_video_harness）からだけ起動する。`
      : `${EXPLAINER_OUTER_JOB_REQUIRED_CODE}: --upstream-job-path・--upstream-job-id・--upstream-job-revision・--upstream-execution-binding は全部そろえて渡す（一部だけは受けない）。`);
    error.code = EXPLAINER_OUTER_JOB_REQUIRED_CODE;
    throw error;
  }
  if (String(jobId || "") !== String(upstreamJobId || "")) throw new Error("--job-id が上位の Job と違う。");
  const verifyUpstream = runtime.verifyUpstream
    || (await import("./videoHarnessJob.mjs")).verifyVideoHarnessUpstreamExecution;
  await verifyUpstream({
    upstreamJobPath,
    upstreamJobId,
    upstreamJobRevision,
    upstreamExecutionBinding,
    harnessId: EXPLAINER_HARNESS_ID,
    scriptPath,
  });
  const job = JSON.parse(await readFile(path.resolve(upstreamJobPath), "utf8"));
  if (nonEmpty(projectDir) && path.resolve(projectDir) !== path.resolve(String(job.projectDir || ""))) {
    throw new Error("--project-dir が上位の Job の作業フォルダと違う。");
  }

  // Pack は、上位の Job が署名を検証した封筒の payload（Job の識別子が封筒のフォルダの中身の SHA を縛っている）。
  const verification = job.channelPackVerification || {};
  const expectedPayloadDir = path.join(path.resolve(String(job.channelPack?.path || "")), "payload");
  if (verification.harnessId !== EXPLAINER_HARNESS_ID || !/^[a-f0-9]{64}$/u.test(String(verification.payloadSha256 || ""))) {
    throw new Error("上位の Job に解説動画の Channel Pack の署名の検証の記録が無い。");
  }
  if (path.resolve(nonEmpty(channelPackDir) || expectedPayloadDir) !== expectedPayloadDir) {
    throw new Error("--channel-pack-dir が上位の Job の Channel Pack の payload と違う。");
  }
  const pack = await loadExplainerChannelPack(expectedPayloadDir);
  const channelOfJob = nonEmpty(job.metadata?.channel?.id);
  if (channelOfJob && channelOfJob !== pack.channelId) {
    throw new Error(`Channel Pack のチャンネル（${pack.channelId}）が Job のチャンネル（${channelOfJob}）と違う。`);
  }
  const mode = assertExplainerStartOptions(job.options || {});
  const workDir = path.join(path.resolve(job.runDir), EXPLAINER_WORK_DIR);
  await mkdir(workDir, { recursive: true });
  await recoverFileTransactions(workDir);
  const guardPath = paidCallGuardPath(env);

  let production = null;
  if (mode === "produce") {
    production = await runExplainerProduction({
      pack,
      rendererUrl: nonEmpty(job.options?.[EXPLAINER_RENDERER_URL_OPTION]),
      workDir,
      env,
    }, runtime);
    if (!production.ok) {
      const blocked = production.code === "explainer-production-not-declared" || production.code.startsWith("explainer-renderer-url-required") || production.code.startsWith("explainer-step-placeholder-missing");
      return outcome({
        status: blocked ? "awaiting-human-review" : "failed",
        jobId: job.id,
        mode,
        knownRemainingIssues: [`${production.code}: ${production.detail}`],
        production: { steps: production.steps.map(({ id, exitCode, durationMs }) => ({ id, exitCode, durationMs })) },
        paidCallsAttempted: 0,
        modelCallsAttempted: 0,
        productionScriptsRun: production.steps.length > 0,
      });
    }
  }

  const audit = await auditExplainerDelivery({ job, pack, mode, env, guardPath }, runtime);
  const knownRemainingIssues = [...audit.issues, `${EXPLAINER_HUMAN_REVIEW_ISSUE}: 人の試聴・初見の評価は機械の監査の外。記録の口がまだ無いので人待ちに残す（点数を作らない）`];
  const generatedAt = now();
  // Job を計画した宣言（上位の Job の識別子の照合で、計画のときと同じ SHA だと確かめてある）。
  const declarationPath = nonEmpty(job.harness?.declarationPath)
    || path.join(runtime.repoRoot || REPO_ROOT, "config", "harnesses", `${EXPLAINER_HARNESS_ID}.harness.json`);
  const declaration = JSON.parse(await readFile(declarationPath, "utf8"));
  const inForce = declaredAuditIdsInForce(declaration, EXPLAINER_AUDIT_CONTRACT);
  const report = {
    version: EXPLAINER_AUDIT_VERSION,
    contractVersion: EXPLAINER_AUDIT_CONTRACT,
    requiredAuditIds: inForce.requiredAuditIds,
    jobId: job.id,
    harnessId: EXPLAINER_HARNESS_ID,
    channelId: pack.channelId,
    mode,
    generatedAt,
    status: knownRemainingIssues.length === 0 ? "pass" : "awaiting-human-review",
    delivery: { file: pack.delivery.file, sha256: audit.delivery.sha256 || "", pinned: Boolean(pack.release) },
    importedArtifacts: audit.artifacts,
    checks: audit.checks,
    observations: audit.observations,
    knownRemainingIssues,
    production: production ? { steps: production.steps.map(({ id, exitCode, durationMs, logPath }) => ({ id, exitCode, durationMs, logPath })) } : null,
    paidCallsAttempted: 0,
    modelCallsAttempted: 0,
    productionScriptsRun: Boolean(production),
  };

  const txn = await openFileTransaction(workDir, { label: "explainer-audit" });
  const reportPath = path.join(workDir, "audit-report.json");
  const receiptPath = path.join(workDir, "run-receipt.json");
  let reportRecord;
  let receiptRecord;
  try {
    await txn.stageJson(reportPath, report);
    reportRecord = await txn.record(reportPath);
    const receipt = openRunReceipt({
      projectDir: job.projectDir,
      harnessId: EXPLAINER_HARNESS_ID,
      repoRoot: job.canonicalIdentity?.repositoryRoot || REPO_ROOT,
      deploymentRoot: job.canonicalIdentity?.deployment?.root || REPO_ROOT,
      expectedProductionDependencies: job.canonicalIdentity?.productionDependencies || null,
      entrypoint: "scripts/explainer-video.mjs",
      action: mode,
      inputs: {
        scriptSha256: job.script.sha256,
        jobIdentityDigest: job.identityDigest,
        channelPackPayloadSha256: verification.payloadSha256,
        deliverySha256: audit.delivery.sha256 || "",
        auditReportSha256: reportRecord.sha256,
        auditContract: { source: "declaration-in-force-since", contractVersion: EXPLAINER_AUDIT_CONTRACT, requiredAuditIds: inForce.requiredAuditIds },
      },
      verifiedChannelPack: {
        id: verification.id,
        version: verification.version,
        payloadSha256: verification.payloadSha256,
        fileCount: verification.fileCount,
        signerKeyId: verification.signerKeyId,
        trustedPublicKeyId: verification.trustedPublicKeyId,
      },
      invocation: job.metadata?.invocation ?? null,
      skillApproval: job.canonicalIdentity?.productionProfile?.skillApproval ?? null,
      timing: {
        jobCreatedAt: job.createdAt,
        runStartedAt: (job.stages || []).find((stage) => stage?.id === "doctor")?.startedAt,
      },
    });
    recordGatesFromAuditChecks(receipt, {
      declaration,
      checks: Object.fromEntries(Object.entries(audit.checks).map(([id, value]) => [id, { pass: value.pass, detail: value.detail }])),
      requiredAuditIds: inForce.requiredAuditIds,
      contractVersion: EXPLAINER_AUDIT_CONTRACT,
    });
    for (const artifact of audit.artifacts) recordRunArtifact(receipt, { kind: artifact.kind, sha256: artifact.sha256, bytes: artifact.bytes });
    recordRunArtifact(receipt, { kind: "audit-report", sha256: reportRecord.sha256, bytes: reportRecord.bytes });
    finalizeRunReceipt(receipt, { outcome: "pass", knownRemainingIssues, timestamp: generatedAt });
    await txn.stageJson(receiptPath, receipt);
    receiptRecord = await txn.record(receiptPath);
    await txn.commit();
  } catch (error) {
    await txn.abort().catch(() => {});
    throw error;
  }
  const status = knownRemainingIssues.length === 0 ? "final-audited" : "awaiting-human-review";
  return outcome({
    status,
    jobId: job.id,
    mode,
    knownRemainingIssues,
    auditChecks: Object.fromEntries(Object.entries(audit.checks).map(([id, value]) => [id, { pass: value.pass, detail: value.detail }])),
    artifacts: {
      auditReport: { path: reportRecord.path, sha256: reportRecord.sha256 },
      runReceipt: { path: receiptRecord.path, sha256: receiptRecord.sha256 },
    },
    importedArtifacts: audit.artifacts.map(({ kind, sha256, bytes }) => ({ kind, sha256, bytes })),
    runReceiptPath: receiptRecord.path,
    observations: audit.observations.map(({ id, count }) => ({ id, count })),
    paidCallsAttempted: 0,
    modelCallsAttempted: 0,
    productionScriptsRun: Boolean(production),
  });
}

export const _testing = Object.freeze({ fileFacts, soundRunsFromSilencedetect, KANJI_NUMERAL_QUANTITY, BGM_MAX_SOUND_RUN_SECONDS });
