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
// 人の確認（全編の試聴と、初見の視聴者の理解・聞きやすさの評価）は機械の監査とは別の工程で、ナレーション物語と
// 同じ仕組みで記録する（監査契約 v2 から）:
//   - 完成 MP4 から contact sheet を作り、評価シート（評価項目の id・名前・説明だけ。合格点・下限は載せない）を置く
//   - 評価者は別の文脈で `node scripts/explainer-video.mjs signoff`（MCP の signoff_video_harness_job）を打ち、
//     信頼リストの鍵（lib/koyaReviewAttestation.mjs の explainer-video の subject）で Job・完成 MP4・contact sheet・
//     納品の記録に結び付けて署名する
//   - runner は署名を確かめ、機械の監査が全部通っているときだけ、その評価を品質ループの1回として記録する
//     （lib/explainerQualityLoop.mjs。回を消費するのは機械の監査が通った後）。合格すれば final-audited になり、
//     共通の RunReceipt（lib/videoHarnessReceipt.mjs）が同じ署名を検証し直して completed に確定する

import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
import {
  EXPLAINER_HUMAN_REVIEW_AUDIT_ID,
  EXPLAINER_QUALITY_AUDIT_ID,
  advanceExplainerQualityLoop,
  createExplainerVideoQualityContract,
  explainerVideoReviewSheet,
  explainerVideoScoringTemplate,
} from "./explainerQualityLoop.mjs";
import { openFileTransaction, recoverFileTransactions } from "./fileTransaction.mjs";
import {
  loadReviewerTrust,
  narratedSignoffReviewer,
  reviewerTrustFailureCode,
  signExplainerReviewSignoff,
  verifyExplainerReviewSignoff,
} from "./koyaReviewAttestation.mjs";
import { normalizeSignedReviewInput } from "./signedReviewQualityLoop.mjs";
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

/** 監査の報告の形の版（欄を足しただけで、形の版は変えていない）。 */
export const EXPLAINER_AUDIT_VERSION = "buzzassist-explainer-audit-v1";
/**
 * 監査契約の版（宣言の保証の inForceSince と同じ系列）。v2 で人の評価の署名（humanReviewSigned）と品質ループ
 * （qualityLoopPassed）が入った。v1 で測る記録では、この2つは効力の外（not-in-force）になる。
 */
export const EXPLAINER_AUDIT_CONTRACT = "buzzassist-explainer-audit-v2";
export const EXPLAINER_OUTCOME_VERSION = "buzzassist-explainer-video-outcome-v1";
export const EXPLAINER_PLAN_VERSION = "buzzassist-explainer-video-plan-v1";
export const EXPLAINER_OUTER_JOB_REQUIRED_CODE = "explainer-outer-job-required";
/** 人の試聴・初見の評価の署名つきの signoff がまだ無い（または使えない）ときの印。 */
export const EXPLAINER_HUMAN_REVIEW_ISSUE = "explainer-human-review-pending";
/** 機械の監査が通るまで、人の評価を品質ループの回にしない（回を消費しない）ときの印。 */
export const EXPLAINER_HUMAN_REVIEW_WAITING_ISSUE = "explainer-human-review-waiting-for-machine-audits";
export const EXPLAINER_WORK_DIR = "explainer";
/** 人の評価の signoff の本文の版。 */
export const EXPLAINER_SIGNOFF_VERSION = "buzzassist-explainer-video-human-review-signoff-v1";
export const EXPLAINER_CONTACT_SHEET_VERSION = "buzzassist-explainer-contact-sheet-v1";

/** 機械の監査（納品の照合・実デコード・表示の決まり・品質ループの照合・関所）。宣言の v1 の保証の証拠。 */
export const EXPLAINER_MACHINE_AUDIT_IDS = Object.freeze([
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
/** 人の確認の監査（v2 から）。 */
export const EXPLAINER_HUMAN_REVIEW_AUDIT_IDS = Object.freeze([EXPLAINER_HUMAN_REVIEW_AUDIT_ID, EXPLAINER_QUALITY_AUDIT_ID]);
/** 宣言の evidenceAuditIds と同じ id（試験が宣言と一致を見る）。 */
export const EXPLAINER_AUDIT_IDS = Object.freeze([...EXPLAINER_MACHINE_AUDIT_IDS, ...EXPLAINER_HUMAN_REVIEW_AUDIT_IDS]);

/**
 * 人の確認の置き場（Job の作業領域の explainer/review/）。runner と signoff の CLI が同じものを使う。
 *   review-sheet.json      評価シート（評価者が読むのはこれと完成 MP4・contact sheet だけ）
 *   review-template.json   採点ファイルの雛形（signoff --review-path の形。点は空）
 *   contact-sheet.png      完成 MP4 から作った contact sheet（署名に入る）
 *   contact-sheet.json     contact sheet を作った MP4 の SHA（同じ MP4 なら作り直さない）
 *   human-review-signoff.json  評価者が書いた署名つきの signoff
 */
export function explainerReviewPaths(workDir) {
  const dir = path.join(workDir, "review");
  return {
    dir,
    sheetPath: path.join(dir, "review-sheet.json"),
    templatePath: path.join(dir, "review-template.json"),
    contactSheetPath: path.join(dir, "contact-sheet.png"),
    contactSheetRecordPath: path.join(dir, "contact-sheet.json"),
    signoffPath: path.join(dir, "human-review-signoff.json"),
  };
}

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

  // 人の評価を結び付けてよい完成 MP4 と納品の記録（納品の記録と一致し、最後までデコードできたものだけ）。
  const boundVideo = videoBound && checks.finalVideoFullDecode.pass
    ? { path: video.file, sha256: video.sha256, bytes: video.bytes, durationSeconds }
    : null;
  const boundDelivery = checks.deliveryManifestBound.pass && delivery.sha256
    ? { path: delivery.file, sha256: delivery.sha256, bytes: delivery.bytes }
    : null;
  return {
    checks,
    issues: [...new Set(issues)],
    observations,
    artifacts,
    delivery,
    bound: { video: boundVideo, delivery: boundDelivery },
  };
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
    // 人の確認は取り込みの監査の後（contact sheet と評価シートができてから）。計画では入口だけを示す。
    humanReview: {
      status: "after-import",
      issue: EXPLAINER_HUMAN_REVIEW_ISSUE,
      signoff: "node scripts/explainer-video.mjs signoff（MCP の signoff_video_harness_job）",
    },
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
// 人の確認（全編の試聴と、初見の視聴者の理解・聞きやすさの評価）

async function readJsonIfPresent(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJsonAtomicFile(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
  await rename(temp, file);
}

/**
 * 完成 MP4 から contact sheet（全尺から 24 枚を 4x6 に並べた1枚の PNG）を作る。同じ MP4 から作ったものが既に
 * あれば作り直さない（署名に入る SHA が、再開のたびに揺れないように）。MP4 が変われば作り直す（前の署名は落ちる）。
 * runtime で差し替えられるもの（試験用）: makeContactSheet, toolchain, runCommand
 */
export async function ensureExplainerContactSheet({ workDir, video, env = process.env } = {}, runtime = {}) {
  const paths = explainerReviewPaths(workDir);
  const record = await readJsonIfPresent(paths.contactSheetRecordPath).catch(() => null);
  if (record?.version === EXPLAINER_CONTACT_SHEET_VERSION && record.videoSha256 === video.sha256) {
    const facts = await fileFacts(paths.contactSheetPath);
    if (facts.ok && facts.sha256 === record.contactSheetSha256) {
      return { path: paths.contactSheetPath, sha256: facts.sha256, bytes: facts.bytes, reused: true };
    }
  }
  await mkdir(paths.dir, { recursive: true });
  const temp = path.join(paths.dir, `.contact-sheet.${process.pid}.${randomUUID()}.png`);
  try {
    if (typeof runtime.makeContactSheet === "function") {
      await runtime.makeContactSheet({ videoPath: video.path, durationSeconds: video.durationSeconds, outputPath: temp });
    } else {
      const toolchain = runtime.toolchain || await resolveFfmpegToolchain({ env });
      if (!toolchain?.ok) throw new Error(`ffmpeg を解決できない: ${toolchain?.ffmpeg?.detail || "unavailable"}`);
      const interval = Math.max(0.5, Number(video.durationSeconds || 0) / 24);
      await (runtime.runCommand || execFile)(
        toolchain.ffmpeg.command,
        [...(toolchain.ffmpeg.args || []), "-hide_banner", "-loglevel", "error", "-y", "-i", video.path,
          "-vf", `fps=1/${interval.toFixed(6)},scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2:black,tile=4x6:padding=2:margin=2`,
          "-frames:v", "1", temp],
        { env, timeout: 30 * 60 * 1000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      );
    }
    const facts = await fileFacts(temp);
    if (!facts.ok) throw new Error(`contact sheet を作れない（${facts.reason}）`);
    await rename(temp, paths.contactSheetPath);
    await writeJsonAtomicFile(paths.contactSheetRecordPath, {
      version: EXPLAINER_CONTACT_SHEET_VERSION,
      videoSha256: video.sha256,
      contactSheetSha256: facts.sha256,
      layout: "4x6",
    });
    return { path: paths.contactSheetPath, sha256: facts.sha256, bytes: facts.bytes, reused: false };
  } finally {
    await rm(temp, { force: true });
  }
}

/** 評価シート（評価者が読むのはこれだけ）と採点ファイルの雛形を置く。中身が同じなら書き直さない。 */
async function writeExplainerReviewSheet(workDir, contract) {
  const paths = explainerReviewPaths(workDir);
  const sheet = { version: "buzzassist-explainer-video-review-sheet-v1", ...explainerVideoReviewSheet(contract) };
  const template = explainerVideoScoringTemplate(contract);
  for (const [file, value] of [[paths.sheetPath, sheet], [paths.templatePath, template]]) {
    const current = await readJsonIfPresent(file).catch(() => null);
    if (JSON.stringify(current) !== JSON.stringify(value)) await writeJsonAtomicFile(file, value);
  }
  return { path: paths.sheetPath, templatePath: paths.templatePath, sheet };
}

/**
 * signoff 本文の検査。documentOk は「この Job のこの完成 MP4・contact sheet・納品の記録を、別の文脈の評価者が
 * 全編通して見た記録として形が正しい」こと（品質ループの回にしてよいか）。ok はそれに加えて評価者が承認した
 * （approved: true・findings 無し）こと。差し戻し（approved: false）は findings が1件以上あるときだけ正しい形。
 */
export function validateExplainerSignoffDocument(signoff, { jobId, videoSha256, contactSheetSha256, deliverySha256 } = {}) {
  const problems = [];
  if (!plainObject(signoff)) return { ok: false, documentOk: false, problems: ["signoff-invalid"], reviewer: "", reviewerContextId: "", approved: false };
  if (signoff.version !== EXPLAINER_SIGNOFF_VERSION) problems.push("signoff-version");
  if (String(signoff.jobId || "") !== String(jobId || "")) problems.push("signoff-job");
  if (!nonEmpty(signoff.reviewer)) problems.push("signoff-reviewer");
  const context = nonEmpty(signoff.reviewerContextId);
  if (!context || context.length < 8 || context === jobId || context === `production:${jobId}`) problems.push("independent-reviewer-context");
  if (signoff.videoSha256 !== videoSha256) problems.push("signoff-video-sha");
  if (signoff.contactSheetSha256 !== contactSheetSha256) problems.push("signoff-contact-sheet-sha");
  if (signoff.deliverySha256 !== deliverySha256) problems.push("signoff-delivery-sha");
  if (signoff.fullLengthViewed !== true) problems.push("full-length-viewing-required");
  const findings = Array.isArray(signoff.findings) ? signoff.findings : null;
  const knownIssues = Array.isArray(signoff.knownRemainingIssues) ? signoff.knownRemainingIssues : null;
  if (signoff.approved !== true && signoff.approved !== false) problems.push("signoff-verdict");
  if (!findings || (signoff.approved === true && findings.length > 0)) problems.push("signoff-findings");
  if (!knownIssues || (signoff.approved === true && knownIssues.length > 0)) problems.push("signoff-known-issues");
  if (signoff.approved === false && findings && findings.length === 0) problems.push("signoff-rejection-findings-required");
  const documentOk = problems.length === 0;
  if (documentOk && signoff.approved !== true) problems.push("signoff-not-approved");
  return {
    ok: problems.length === 0,
    documentOk,
    problems,
    reviewer: nonEmpty(signoff.reviewer),
    reviewerContextId: context,
    approved: signoff.approved === true,
  };
}

/**
 * 信頼リストの鍵の署名を確かめる（共通の RunReceipt と同じ検証器）。信頼リストが読めない・Job の identityDigest が
 * 無い、といった監査側の欠落も理由コードとして返し、合格にしない。
 */
async function verifyExplainerSignoffAttestation(signoff, {
  jobId, identityDigest, videoSha256, contactSheetSha256, deliverySha256, reviewerTrust = null, reviewerTrustPath = "", env = process.env,
}) {
  const failures = [];
  let trust = null;
  try {
    trust = await loadReviewerTrust({ trust: reviewerTrust, trustPath: reviewerTrustPath, env });
  } catch (error) {
    failures.push(reviewerTrustFailureCode(error));
  }
  if (!/^[a-f0-9]{64}$/u.test(String(identityDigest || ""))) failures.push("reviewer-attestation-expected-subject-unavailable:identityDigest");
  const verified = verifyExplainerReviewSignoff(signoff, { jobId, identityDigest, videoSha256, contactSheetSha256, deliverySha256, trust });
  const all = [...new Set([...failures, ...verified.failures])];
  return { pass: all.length === 0, failures: all, signerKeyId: verified.signerKeyId, reviewerLabel: verified.reviewerLabel, trustSha256: verified.trustSha256 };
}

function signoffCommandHint(job, paths) {
  return `評価者（生成とは別の文脈）が ${paths.sheetPath} の評価シートで採点し、node scripts/explainer-video.mjs signoff --job-id ${job.id} `
    + `--project-dir <作業フォルダ> --reviewer-id <評価者の名前> --reviewer-context-id <この評価の文脈の ID> --reviewer-key-path <鍵> `
    + "--review-path <採点ファイル> --full-length-viewed --pass|--fail を打つ（MCP は signoff_video_harness_job）";
}

/**
 * 人の評価を確かめて、監査の humanReviewSigned と qualityLoopPassed、人待ちの理由を返す。例外は投げない。
 * 機械の監査が全部通っていなければ、署名を確かめるだけで品質ループの回は記録しない（回を消費しない）。
 */
export async function evaluateExplainerHumanReview({
  job,
  workDir,
  contract,
  video = null,
  contactSheet = null,
  delivery = null,
  machineChecks = {},
  reviewerTrust = null,
  reviewerTrustPath = "",
  env = process.env,
  now = () => new Date().toISOString(),
} = {}) {
  const paths = explainerReviewPaths(workDir);
  const loopBase = {
    contract,
    jobId: job.id,
    workDir,
    jobsDir: path.dirname(path.resolve(String(job.runDir || workDir))),
    now,
  };
  const waitingLoop = async (detail) => {
    const loop = await advanceExplainerQualityLoop({ ...loopBase, signoff: null, documentValid: false });
    return { check: { ...loop.check, detail: detail || loop.check.detail }, issues: loop.issues };
  };
  if (!video || !contactSheet || !delivery) {
    const detail = "納品の記録と一致して最後までデコードできた完成 MP4 が無いので、人の評価を結び付けられない";
    const loop = await waitingLoop(detail);
    return {
      checks: { [EXPLAINER_HUMAN_REVIEW_AUDIT_ID]: check(false, detail, { signoffPath: paths.signoffPath }), [EXPLAINER_QUALITY_AUDIT_ID]: loop.check },
      issues: [`${EXPLAINER_HUMAN_REVIEW_ISSUE}: ${detail}`, ...loop.issues],
      independentSignoff: { path: paths.signoffPath, status: "pending", problems: ["final-video-not-bound"] },
    };
  }
  const facts = await fileFacts(paths.signoffPath);
  let signoff = null;
  if (facts.ok) {
    try {
      // 読んだバイト列が SHA を取ったものと同じときだけ使う（読む間に書き換わった signoff を回にしない）。
      const bytes = await readFile(paths.signoffPath);
      if (createHash("sha256").update(bytes).digest("hex") === facts.sha256) signoff = JSON.parse(bytes.toString("utf8"));
    } catch {
      signoff = null;
    }
  }
  if (!signoff) {
    const detail = `人の全編の試聴・初見の評価の signoff がまだ無い（${facts.ok ? "JSON として読めない" : facts.reason}）`;
    const loop = await waitingLoop();
    return {
      checks: { [EXPLAINER_HUMAN_REVIEW_AUDIT_ID]: check(false, detail, { signoffPath: paths.signoffPath }), [EXPLAINER_QUALITY_AUDIT_ID]: loop.check },
      issues: [`${EXPLAINER_HUMAN_REVIEW_ISSUE}: ${detail}。${signoffCommandHint(job, paths)}`, ...loop.issues],
      independentSignoff: { path: paths.signoffPath, status: "pending", problems: [facts.ok ? "signoff-unreadable" : "signoff-missing"] },
    };
  }
  const truth = { jobId: job.id, videoSha256: video.sha256, contactSheetSha256: contactSheet.sha256, deliverySha256: delivery.sha256 };
  const validation = validateExplainerSignoffDocument(signoff, truth);
  const attestation = await verifyExplainerSignoffAttestation(signoff, {
    ...truth,
    identityDigest: job.identityDigest,
    reviewerTrust,
    reviewerTrustPath,
    env,
  });
  if (!attestation.pass) {
    validation.ok = false;
    validation.documentOk = false;
    validation.problems = [...new Set([...validation.problems, ...attestation.failures])];
  }
  const signoffSha256 = validation.documentOk ? facts.sha256 : "";
  const binding = { signoffSha256, videoSha256: video.sha256, contactSheetSha256: contactSheet.sha256, deliverySha256: delivery.sha256 };
  const humanReviewSigned = check(validation.ok,
    validation.ok
      ? `別の文脈の評価者 ${validation.reviewer}（${validation.reviewerContextId}）が全編を通して見て承認し、信頼リストの鍵 ${attestation.signerKeyId} で完成 MP4・contact sheet・納品の記録に結び付けて署名した`
      : validation.documentOk
        ? `評価者 ${validation.reviewer}（${validation.reviewerContextId}）が差し戻した（直すべき点 ${(signoff.findings || []).length} 件）`
        : `signoff を使えない: ${validation.problems.join(", ")}`,
    validation.ok
      ? { ...binding, reviewer: validation.reviewer, reviewerContextId: validation.reviewerContextId, signerKeyId: attestation.signerKeyId, trustSha256: attestation.trustSha256 }
      : { problems: validation.problems });
  if (!validation.documentOk) {
    const loop = await waitingLoop();
    return {
      checks: { [EXPLAINER_HUMAN_REVIEW_AUDIT_ID]: humanReviewSigned, [EXPLAINER_QUALITY_AUDIT_ID]: loop.check },
      issues: [`${EXPLAINER_HUMAN_REVIEW_ISSUE}: signoff を使えない（${validation.problems.join(", ")}）。${signoffCommandHint(job, paths)}`, ...loop.issues],
      independentSignoff: { path: paths.signoffPath, status: "rejected", problems: validation.problems },
    };
  }
  const failingMachine = EXPLAINER_MACHINE_AUDIT_IDS.filter((id) => machineChecks[id]?.pass !== true);
  if (failingMachine.length > 0) {
    const detail = `機械の監査（${failingMachine.join(", ")}）が通ってから、この人の評価を品質ループの回として記録する（回は消費していない）`;
    const loop = await waitingLoop(detail);
    return {
      checks: { [EXPLAINER_HUMAN_REVIEW_AUDIT_ID]: humanReviewSigned, [EXPLAINER_QUALITY_AUDIT_ID]: loop.check },
      issues: [
        `${EXPLAINER_HUMAN_REVIEW_WAITING_ISSUE}: ${detail}`,
        ...(validation.ok ? [] : [`explainer-human-review-rejected: ${humanReviewSigned.detail}`]),
        ...loop.issues,
      ],
      independentSignoff: { path: paths.signoffPath, status: "waiting-for-machine-audits", problems: validation.ok ? [] : validation.problems },
    };
  }
  const loop = await advanceExplainerQualityLoop({
    ...loopBase,
    signoff,
    signoffPath: paths.signoffPath,
    signoffSha256,
    documentValid: true,
    auditChecks: { ...Object.fromEntries(EXPLAINER_MACHINE_AUDIT_IDS.map((id) => [id, machineChecks[id]])), [EXPLAINER_HUMAN_REVIEW_AUDIT_ID]: humanReviewSigned },
    video: { path: video.path, sha256: video.sha256 },
    contactSheet: { path: contactSheet.path, sha256: contactSheet.sha256 },
    binding,
    extraEvidence: [{ path: delivery.path, sha256: delivery.sha256, note: "この回に評価した完成版の納品の記録" }],
    roundCost: 0,
  });
  const issues = [
    ...(validation.ok ? [] : [`explainer-human-review-rejected: ${humanReviewSigned.detail}`]),
    ...loop.issues,
  ];
  const passed = validation.ok && loop.check.pass === true && issues.length === 0;
  return {
    checks: { [EXPLAINER_HUMAN_REVIEW_AUDIT_ID]: humanReviewSigned, [EXPLAINER_QUALITY_AUDIT_ID]: loop.check },
    issues,
    independentSignoff: passed
      ? {
        path: paths.signoffPath,
        sha256: signoffSha256,
        reviewer: validation.reviewer,
        reviewerContextId: validation.reviewerContextId,
        reviewerAttestation: { signerKeyId: attestation.signerKeyId, reviewerLabel: attestation.reviewerLabel, trustSha256: attestation.trustSha256 },
      }
      : { path: paths.signoffPath, status: validation.ok ? "quality-loop-not-passed" : "rejected", problems: validation.ok ? [] : validation.problems },
  };
}

/**
 * 評価者が、自分の端末（生成とは別の文脈）で人の評価の signoff を書いて署名する。生成側はこれを呼ばない。
 * 完成 MP4・contact sheet・納品の記録は、Job の監査の報告が指すファイルを disk から読み直して SHA を取り、
 * 報告の SHA と違えば（取り込んだ後にファイルが変わった）書かない。採点は評価シート（契約）で検査する。
 * 既にある signoff は force 無しで上書きしない。
 */
export async function writeExplainerReviewSignoff({
  job,
  reviewerId = "",
  reviewerHost = "",
  reviewerContextId = "",
  reviewerPrivateKeyPath = "",
  reviewerPrivateKeyPem = "",
  reviewerTrust = null,
  reviewerTrustPath = "",
  review = null,
  reviewPath = "",
  pass = false,
  fail = false,
  fullLengthViewed = false,
  force = false,
  env = process.env,
  signedAt = new Date().toISOString(),
} = {}) {
  if (job?.harness?.id !== EXPLAINER_HARNESS_ID || !nonEmpty(job?.id)) throw new Error("signoff の Job が解説動画（explainer-video）の Job ではない。");
  if (!/^[a-f0-9]{64}$/u.test(String(job.identityDigest || ""))) {
    throw new Error("reviewer-attestation-expected-subject-unavailable:identityDigest — Job に identityDigest が無い。");
  }
  if ((pass === true) === (fail === true)) {
    throw new Error("signoff には --pass（承認）か --fail（差し戻し）のどちらか1つが要る。完成 MP4 を全編通して見て（聞いて）から打つ。");
  }
  if (fullLengthViewed !== true) {
    throw new Error("full-length-viewing-required: 完成 MP4 を最初から最後まで通して見た（聞いた）ときだけ --full-length-viewed を付けて signoff する。");
  }
  const contextId = nonEmpty(reviewerContextId);
  if (!contextId || contextId.length < 8) throw new Error("--reviewer-context-id は、この評価の文脈（評価者の会話・作業の ID、8文字以上）にする。");
  if (contextId === job.id || contextId === `production:${job.id}`) {
    throw new Error("independent-reviewer-context: 評価の文脈は、Job を動かした生成の文脈と別でなければならない。");
  }
  const host = nonEmpty(reviewerHost).toLowerCase();
  if (host && !["claude", "codex"].includes(host)) throw new Error("--reviewer は claude か codex（記録に使ったホスト）。人の名前は --reviewer-id に書く。");
  const reviewer = nonEmpty(reviewerId);
  if (!reviewer) throw new Error("--reviewer-id（評価した人の名前・呼び名）が要る。");
  let reviewInput = review;
  if (!reviewInput) {
    if (!nonEmpty(reviewPath)) throw new Error("quality-review-required: --review-path（評価シートで採点した { rubricScores, notes, findings } の JSON）が要る。");
    try {
      reviewInput = JSON.parse(await readFile(path.resolve(reviewPath), "utf8"));
    } catch (error) {
      throw new Error(`quality-review-invalid: 採点ファイルを JSON として読めない（${error?.code || error?.name || "error"}）。`);
    }
  }
  const workDir = path.join(path.resolve(String(job.runDir || "")), EXPLAINER_WORK_DIR);
  const paths = explainerReviewPaths(workDir);
  const report = await readJsonIfPresent(path.join(workDir, "audit-report.json")).catch(() => null);
  if (!report || report.jobId !== job.id) throw new Error("signoff の前に Job を resume して、取り込みの監査の報告を作る（explainer/audit-report.json が無い）。");
  const videoRecord = (report.importedArtifacts || []).find((row) => row?.kind === "final-video");
  const contactRecord = await readJsonIfPresent(paths.contactSheetRecordPath).catch(() => null);
  if (!videoRecord?.path || !report.delivery?.file || !contactRecord) {
    throw new Error("監査の報告に、人の評価を結び付ける完成 MP4・納品の記録・contact sheet が無い。機械の監査の失敗を直して resume してから signoff する。");
  }
  const [videoFacts, sheetFacts, deliveryFacts] = await Promise.all([
    fileFacts(videoRecord.path), fileFacts(paths.contactSheetPath), fileFacts(report.delivery.file),
  ]);
  if (!videoFacts.ok || videoFacts.sha256 !== videoRecord.sha256 || videoFacts.sha256 !== contactRecord.videoSha256) {
    throw new Error("完成 MP4 が、監査したとき（と contact sheet を作ったとき）から変わった。Job を resume し直してから signoff する。");
  }
  if (!sheetFacts.ok || sheetFacts.sha256 !== contactRecord.contactSheetSha256) throw new Error("contact sheet が作ったときから変わった。Job を resume し直してから signoff する。");
  if (!deliveryFacts.ok || deliveryFacts.sha256 !== report.delivery.sha256) throw new Error("納品の記録が監査したときから変わった。Job を resume し直してから signoff する。");
  if (!force && await readJsonIfPresent(paths.signoffPath).catch(() => ({}))) {
    throw new Error(`signoff-exists: ${paths.signoffPath} は既にある。新しい評価（新しい --reviewer-context-id）で書き直すときだけ --force を付ける。`);
  }
  const contract = createExplainerVideoQualityContract();
  const approved = pass === true;
  const scored = normalizeSignedReviewInput(reviewInput, explainerVideoReviewSheet(contract), { approved });
  const trust = await loadReviewerTrust({ trust: reviewerTrust, trustPath: reviewerTrustPath, env });
  const body = {
    version: EXPLAINER_SIGNOFF_VERSION,
    jobId: job.id,
    reviewer,
    reviewerKind: "human",
    ...(host ? { reviewerHost: host } : {}),
    reviewerContextId: contextId,
    approved,
    fullLengthViewed: true,
    videoPath: videoRecord.path,
    videoSha256: videoFacts.sha256,
    contactSheetPath: paths.contactSheetPath,
    contactSheetSha256: sheetFacts.sha256,
    deliveryPath: report.delivery.file,
    deliverySha256: deliveryFacts.sha256,
    findings: scored.findings,
    knownRemainingIssues: [],
    // 評価文脈は評価者の文脈そのもの（別の値を書かせない）。品質ループは回ごとに新しい文脈を求める。
    qualityReview: { ...scored.qualityReview, evaluatorContextId: contextId },
    reviewedAt: new Date(signedAt).toISOString(),
  };
  const signoff = await signExplainerReviewSignoff({
    signoff: body,
    jobId: job.id,
    identityDigest: job.identityDigest,
    privateKeyPath: reviewerPrivateKeyPath,
    privateKeyPem: reviewerPrivateKeyPem,
    trust,
    signedAt,
  });
  await writeJsonAtomicFile(paths.signoffPath, signoff);
  return {
    outputPath: paths.signoffPath,
    signoff,
    signerKeyId: signoff.reviewerAttestation?.signer?.keyId || "",
    reviewer: narratedSignoffReviewer(signoff),
    videoSha256: videoFacts.sha256,
    contactSheetSha256: sheetFacts.sha256,
    deliverySha256: deliveryFacts.sha256,
  };
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
  // 上位の Job 層が運営者の環境変数と照合済みの信頼リストの path（照合用。アンカーは環境変数だけ）。
  reviewerTrustPath = "",
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

  // 人の確認: 完成 MP4 の contact sheet と評価シートを置き、評価者の signoff を確かめ、機械の監査が全部通って
  // いればその評価を品質ループの1回として記録する（lib/explainerQualityLoop.mjs）。
  const contract = createExplainerVideoQualityContract();
  const reviewSheet = await writeExplainerReviewSheet(workDir, contract);
  let contactSheet = null;
  const reviewIssues = [];
  if (audit.bound.video) {
    try {
      contactSheet = await ensureExplainerContactSheet({ workDir, video: audit.bound.video, env }, runtime);
    } catch (error) {
      reviewIssues.push(`explainer-contact-sheet-failed: ${String(error?.message || error).slice(0, 300)}`);
    }
  }
  const humanReview = await evaluateExplainerHumanReview({
    job,
    workDir,
    contract,
    video: audit.bound.video,
    contactSheet,
    delivery: audit.bound.delivery,
    machineChecks: audit.checks,
    reviewerTrust: runtime.reviewerTrust || null,
    reviewerTrustPath,
    env,
    now,
  });
  const checks = { ...audit.checks, ...humanReview.checks };
  const knownRemainingIssues = [...new Set([...audit.issues, ...reviewIssues, ...humanReview.issues])];
  const finalAudited = knownRemainingIssues.length === 0
    && EXPLAINER_AUDIT_IDS.every((id) => checks[id]?.pass === true)
    && Boolean(audit.bound.video && contactSheet && audit.bound.delivery);
  const generatedAt = now();
  // Job を計画した宣言（上位の Job の識別子の照合で、計画のときと同じ SHA だと確かめてある）。
  const declarationPath = nonEmpty(job.harness?.declarationPath)
    || path.join(runtime.repoRoot || REPO_ROOT, "config", "harnesses", `${EXPLAINER_HARNESS_ID}.harness.json`);
  const declaration = JSON.parse(await readFile(declarationPath, "utf8"));
  const inForce = declaredAuditIdsInForce(declaration, EXPLAINER_AUDIT_CONTRACT);
  const qualityLoopCheck = humanReview.checks[EXPLAINER_QUALITY_AUDIT_ID] || {};
  const report = {
    version: EXPLAINER_AUDIT_VERSION,
    contractVersion: EXPLAINER_AUDIT_CONTRACT,
    requiredAuditIds: inForce.requiredAuditIds,
    jobId: job.id,
    harnessId: EXPLAINER_HARNESS_ID,
    channelId: pack.channelId,
    mode,
    generatedAt,
    status: finalAudited ? "pass" : "awaiting-human-review",
    delivery: { file: pack.delivery.file, sha256: audit.delivery.sha256 || "", pinned: Boolean(pack.release) },
    // 人の評価を結び付けた完成 MP4 と contact sheet（納品の記録と一致して最後までデコードできたときだけ）。
    ...(audit.bound.video ? { videoSha256: audit.bound.video.sha256 } : {}),
    ...(contactSheet ? { contactSheetSha256: contactSheet.sha256 } : {}),
    importedArtifacts: audit.artifacts,
    checks,
    observations: audit.observations,
    knownRemainingIssues,
    review: {
      sheetPath: reviewSheet.path,
      templatePath: reviewSheet.templatePath,
      contactSheetPath: contactSheet?.path || "",
      signoffPath: explainerReviewPaths(workDir).signoffPath,
    },
    independentSignoff: humanReview.independentSignoff,
    qualityLoop: {
      contractVersion: qualityLoopCheck.contractVersion || contract.version,
      contractDigest: qualityLoopCheck.contractDigest || contract.digest,
      status: qualityLoopCheck.status || "not-started",
      stopReason: qualityLoopCheck.stopReason || "",
      rounds: qualityLoopCheck.rounds || 0,
      pass: qualityLoopCheck.pass === true,
    },
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
        qualityContractDigest: contract.digest,
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
      checks: Object.fromEntries(Object.entries(checks).map(([id, value]) => [id, { pass: value.pass, detail: value.detail }])),
      requiredAuditIds: inForce.requiredAuditIds,
      contractVersion: EXPLAINER_AUDIT_CONTRACT,
    });
    for (const artifact of audit.artifacts) recordRunArtifact(receipt, { kind: artifact.kind, sha256: artifact.sha256, bytes: artifact.bytes });
    if (contactSheet) recordRunArtifact(receipt, { kind: "contact-sheet", sha256: contactSheet.sha256, bytes: contactSheet.bytes });
    recordRunArtifact(receipt, { kind: "audit-report", sha256: reportRecord.sha256, bytes: reportRecord.bytes });
    finalizeRunReceipt(receipt, { outcome: "pass", knownRemainingIssues, timestamp: generatedAt });
    await txn.stageJson(receiptPath, receipt);
    receiptRecord = await txn.record(receiptPath);
    await txn.commit();
  } catch (error) {
    await txn.abort().catch(() => {});
    throw error;
  }
  // 成果物の一覧。完成版の動画と納品の記録は、人の評価が合格して確定する（final-audited）ときだけ Job の成果物に
  // 載せる（共通の RunReceipt が検証し直す。Canvas はそのとき完成 MP4 を1回だけ投影する）。人待ちの間は contact
  // sheet だけを載せる（評価者が Canvas で見られるように）。どれもチャンネルのフォルダの元のファイルを指し、写さない。
  const artifacts = {
    auditReport: { path: reportRecord.path, sha256: reportRecord.sha256 },
    runReceipt: { path: receiptRecord.path, sha256: receiptRecord.sha256 },
    ...(contactSheet ? { contactSheet: { path: contactSheet.path, sha256: contactSheet.sha256 } } : {}),
    ...(finalAudited ? {
      finalVideo: { path: audit.bound.video.path, sha256: audit.bound.video.sha256 },
      deliveryManifest: { path: audit.bound.delivery.path, sha256: audit.bound.delivery.sha256 },
    } : {}),
  };
  return outcome({
    status: finalAudited ? "final-audited" : "awaiting-human-review",
    jobId: job.id,
    mode,
    knownRemainingIssues,
    auditChecks: Object.fromEntries(Object.entries(checks).map(([id, value]) => [id, { pass: value.pass, detail: value.detail }])),
    artifacts,
    review: {
      sheetPath: reviewSheet.path,
      templatePath: reviewSheet.templatePath,
      contactSheetPath: contactSheet?.path || "",
      signoffPath: explainerReviewPaths(workDir).signoffPath,
      videoPath: audit.bound.video?.path || "",
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
