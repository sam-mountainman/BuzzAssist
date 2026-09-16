// 選んだカットだけを image-to-video のクリップへ差し替える工程。
//
// 流れ（台本 → 画像 → 吹き出し/カメラ → 音声 → ★ここ → レンダー → 監査）:
//   1. 契約（エピソード例外）で印の付いたカットを、音声で尺が確定した後に計画する
//   2. 承認済み静止画をカメラ設計どおりに切った「冒頭の1枚」を開始フレームにする
//   3. 既存の生成層（generateVideoMedia）でクリップを作る。新しい提供元は足さない
//   4. 台帳に要求・入出力の SHA-256 を残し、manifest のカットへ結び付ける
//   5. レンダーはそのカットの映像ベースだけをクリップに換える（音声・吹き出し・尺は同じ）
//   6. 最終監査は実MP4をデコードして差し替え区間を実測する
//
// 課金の規則（platform craft）:
//   - generateVideoMedia の例外には HTTP ステータスが無い。受理・課金された後の
//     失敗かどうか区別できないので、この工程では自動で再送しない。
//   - 呼ぶ前に「送信済み」を台帳へ書く。途中でプロセスが死んでも、再開時に
//     課金状態不明の試行として見え、運営者が --retry-failed を明示するまで
//     送り直さない。
//   - 試行はカットごとに契約の上限回数まで。成功・失敗を問わず数える。
//   - 静止画への黙った差し戻しはしない。運営者が理由と名前を付けて選んだ
//     カットだけを静止画で描き、その判断を監査に残す。

import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { writeJsonAtomic } from "./canvasScene.mjs";
import { withCanvasFileLock } from "./canvasFileLock.mjs";
import {
  MANGA_CUT_VIDEO_BINDING_VERSION,
  MANGA_CUT_VIDEO_LEDGER_VERSION,
  appliedCutVideoBinding,
  buildCutVideoSubstitutionPrompt,
  cameraStartPoint,
  cutFrameCount,
  cutVideoClipConformChain,
  cutVideoContentIdentity,
  cutVideoRequestIdentity,
  cutVideoStartFrameFilter,
  cutVideoStartFrameSpecDigest,
  evaluateCutVideoSubstitutionEligibility,
  resolveCutVideoSubstitutionPolicy,
} from "./mangaCutVideoSubstitutionPolicy.mjs";
import {
  normalizeCameraShotSequence,
  normalizeEpisodeCamera,
  projectFaceBoundsThroughCamera,
} from "./mangaVideoPipeline.mjs";
import { generateVideoMedia, imageToVideoDurationOptions } from "./mediaGeneration.mjs";
import { redactSecrets } from "./paidApiRetry.mjs";

const execFile = promisify(execFileCallback);
const repositoryRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");

export const MANGA_CUT_VIDEO_STAGE_REPORT_VERSION = "manga-cut-video-stage-report-v1";
export const MANGA_CUT_VIDEO_AUDIT_VERSION = "manga-cut-video-audit-v1";

// 実MP4の代表フレームで、差し替え区間ごとに人が必ず見るべき観点。
export const SUBSTITUTED_CUT_REVIEW_CHECK_IDS = Object.freeze([
  "characterContinuity",
  "bubblePlacement",
  "generatedTextArtifacts",
]);

/** 止まった理由と次の一手を持つ例外。CLI はこれを checkpoint として表示する。 */
export class CutVideoSubstitutionBlockedError extends Error {
  constructor(message, { blocked = [], ledgerPath = "" } = {}) {
    super(message);
    this.name = "CutVideoSubstitutionBlockedError";
    this.blocked = blocked;
    this.ledgerPath = ledgerPath;
  }
}

async function readJson(path, fallback = null) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}

async function isFile(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function nowIso(now) {
  return (typeof now === "function" ? now() : new Date()).toISOString();
}

export function cutVideoSubstitutionPaths(episodeDir) {
  const root = join(resolve(episodeDir), "video-substitution");
  return {
    root,
    ledgerPath: join(root, "ledger.json"),
    stageReportPath: join(root, "stage-report.json"),
    cutDir: (cutId) => join(root, cutId),
  };
}

function emptyLedger(episodeId) {
  return { version: MANGA_CUT_VIDEO_LEDGER_VERSION, episodeId, cuts: {}, updatedAt: "" };
}

async function readLedger(ledgerPath, episodeId) {
  const ledger = await readJson(ledgerPath, null);
  if (!ledger) return emptyLedger(episodeId);
  if (ledger.version !== MANGA_CUT_VIDEO_LEDGER_VERSION || ledger.episodeId !== episodeId) {
    throw new Error(`Video substitution ledger ${ledgerPath} belongs to ${ledger.episodeId} (${ledger.version}).`);
  }
  return ledger;
}

function ledgerCut(ledger, cutId) {
  if (!ledger.cuts[cutId]) ledger.cuts[cutId] = { attempts: [], stillFallback: null };
  return ledger.cuts[cutId];
}

function utterancesForCut(manifest, cut) {
  const byId = new Map((manifest.utterances || []).map((row) => [row.id, row]));
  return (cut?.utteranceIds || []).map((id) => byId.get(id)).filter(Boolean);
}

function startShotForCut(cut, shots) {
  if (shots.length > 0) return { camera: shots[0].camera, motion: shots[0].motion };
  return { camera: normalizeEpisodeCamera(cut.camera, cut.motion), motion: cut.motion };
}

/**
 * 印の付いたカットごとに、動画化できるか・何秒で頼むか・開始フレームを
 * どう切るかを決める。課金も書き込みもしない。
 */
export function planCutVideoSubstitutions({ manifest, contract, durationOptionsFor = imageToVideoDurationOptions }) {
  const policy = resolveCutVideoSubstitutionPolicy(contract);
  const fps = Math.max(12, Number(manifest?.video?.fps || contract?.video?.fps || 30));
  const width = Number(manifest?.video?.width || contract?.video?.width || 1920);
  const height = Number(manifest?.video?.height || contract?.video?.height || 1080);
  const oversample = Number(manifest?.video?.cameraOversample || contract?.camera?.cameraOversample || 3);
  const cutsById = new Map((manifest?.cuts || []).map((cut) => [cut.id, cut]));
  const durationOptions = policy.cuts.length > 0 ? durationOptionsFor(policy.model) : [];
  const rows = policy.cuts.map((entry) => {
    const cut = cutsById.get(entry.cutId) || null;
    const utterances = cut ? utterancesForCut(manifest, cut) : [];
    const shots = cut && !cut.panelLayout?.enabled
      ? normalizeCameraShotSequence(cut, utterances, cut.timing?.durationSeconds)
      : [];
    const eligibility = evaluateCutVideoSubstitutionEligibility({
      cutId: entry.cutId,
      cut,
      utterances,
      shots,
      fps,
      durationOptions,
      maximumClipShortfallFrames: policy.maximumClipShortfallFrames,
    });
    const start = cut && eligibility.eligible ? startShotForCut(cut, shots) : null;
    return {
      ...entry,
      ...eligibility,
      shots,
      startCamera: start ? cameraStartPoint(start.camera) : null,
      startShot: start,
      prompt: entry.motionPrompt ? buildCutVideoSubstitutionPrompt(entry.motionPrompt) : "",
    };
  });
  const marked = new Set(policy.cuts.map((entry) => entry.cutId));
  const unmarkedBindings = (manifest?.cuts || [])
    .filter((cut) => cut.videoSubstitution && !marked.has(cut.id))
    .map((cut) => cut.id);
  return {
    applicable: policy.cuts.length > 0,
    policy,
    fps,
    width,
    height,
    oversample,
    durationOptions,
    rows,
    unmarkedBindings,
  };
}

async function runTool(command, args, { maxBuffer = 64 * 1024 * 1024 } = {}) {
  return execFile(command, args, { maxBuffer });
}

async function writeStartFrame({ ffmpegPath, sourceImagePath, outputPath, filter }) {
  if (await isFile(outputPath)) return;
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.${Date.now()}.tmp.png`;
  await runTool(ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", sourceImagePath,
    "-vf", filter,
    "-frames:v", "1", "-update", "1", temporaryPath,
  ]);
  await rename(temporaryPath, outputPath);
}

/** 開始フレームを作る（ローカル処理・無課金）。仕様が同じなら既存を使う。 */
async function prepareStartFrame({ plan, row, cutDir, ffmpegPath }) {
  const sourceImagePath = resolve(row.sourceImagePath);
  if (!await isFile(sourceImagePath)) throw new Error(`${row.cutId}: approved still is missing: ${sourceImagePath}`);
  const sourceImageSha256 = await sha256File(sourceImagePath);
  const specDigest = cutVideoStartFrameSpecDigest({
    sourceImageSha256,
    width: plan.width,
    height: plan.height,
    oversample: plan.oversample,
    start: row.startCamera,
  });
  const startFramePath = join(cutDir, `start-frame-${specDigest.slice(0, 16)}.png`);
  await writeStartFrame({
    ffmpegPath,
    sourceImagePath,
    outputPath: startFramePath,
    filter: cutVideoStartFrameFilter({ width: plan.width, height: plan.height, oversample: plan.oversample, start: row.startCamera }),
  });
  return {
    sourceImagePath,
    sourceImageSha256,
    startFramePath,
    startFrameSha256: await sha256File(startFramePath),
    startFrameSpecDigest: specDigest,
  };
}

function frameRate(value) {
  const [numerator, denominator] = String(value || "0/1").split("/").map(Number);
  return denominator > 0 ? numerator / denominator : 0;
}

/** ffprobe の要約。本体の尺はストリームを優先し、無ければコンテナの尺。 */
export async function probeGeneratedClip(clipPath, { ffprobePath = "ffprobe" } = {}) {
  const { stdout } = await runTool(ffprobePath, [
    "-v", "error",
    "-show_entries", "stream=codec_type,codec_name,width,height,avg_frame_rate,duration,nb_frames:format=duration",
    "-of", "json", clipPath,
  ]);
  const report = JSON.parse(stdout);
  const video = (report.streams || []).find((row) => row.codec_type === "video");
  const hasAudio = (report.streams || []).some((row) => row.codec_type === "audio");
  if (!video) return { hasVideo: false, hasAudio };
  const durationSeconds = Number(video.duration) > 0 ? Number(video.duration) : Number(report.format?.duration || 0);
  return {
    hasVideo: true,
    hasAudio,
    codec: video.codec_name,
    width: Number(video.width),
    height: Number(video.height),
    frameRate: frameRate(video.avg_frame_rate),
    frameCount: Number(video.nb_frames) || null,
    durationSeconds,
  };
}

async function clipDecodesFully(clipPath, ffmpegPath) {
  try {
    await runTool(ffmpegPath, ["-hide_banner", "-v", "error", "-xerror", "-i", clipPath, "-f", "null", "-"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * クリップの1枚目とカメラ設計どおりの開始フレームの構造類似度（SSIM）。
 * 縮小して比べる——720p の生成物を 1080p に拡大した分のぼけで、
 * 本当は同じ絵を不一致と判定しないため。
 */
export function startFrameSimilarityGraph({ width, height, fps }) {
  const analysis = "480:270";
  const conform = cutVideoClipConformChain({ width, height, fps, frameCount: 1, shortfallFrames: 0 });
  return `[0:v]${conform},scale=${analysis}:flags=area,format=gray[clip];`
    + `[1:v]scale=${analysis}:flags=area,format=gray[still];[clip][still]ssim`;
}

export async function measureStartFrameSimilarity({ clipPath, startFramePath, width, height, fps, ffmpegPath = "ffmpeg" }) {
  const { stderr } = await runTool(ffmpegPath, [
    "-hide_banner", "-i", clipPath, "-i", startFramePath,
    "-lavfi", startFrameSimilarityGraph({ width, height, fps }),
    "-f", "null", "-",
  ]);
  const match = String(stderr).match(/All:([0-9.]+)/u);
  if (!match) throw new Error(`Could not measure start-frame similarity for ${clipPath}.`);
  return Number(match[1]);
}

/** 生成直後（と再開時）のクリップ検査。どれか1つでも落ちたら採用しない。 */
async function validateGeneratedClip({ clipPath, plan, row, startFrame, ffmpegPath, ffprobePath }) {
  const failures = [];
  const probe = await probeGeneratedClip(clipPath, { ffprobePath });
  if (!probe.hasVideo) failures.push("no-video-stream");
  const decodes = probe.hasVideo && await clipDecodesFully(clipPath, ffmpegPath);
  if (probe.hasVideo && !decodes) failures.push("clip-does-not-decode");
  if (probe.hasVideo) {
    const aspect = probe.width / Math.max(1, probe.height);
    if (Math.abs(aspect - plan.width / plan.height) > 0.02 * (plan.width / plan.height)) failures.push(`aspect-ratio-mismatch:${probe.width}x${probe.height}`);
    if (probe.height < 480) failures.push(`resolution-too-low:${probe.width}x${probe.height}`);
    const availableFrames = Math.floor(probe.durationSeconds * plan.fps + 1e-6);
    if (availableFrames + plan.policy.maximumClipShortfallFrames < row.frameCount) {
      failures.push(`clip-shorter-than-cut:${availableFrames}<${row.frameCount}`);
    }
  }
  let startFrameSimilarity = null;
  if (decodes) {
    startFrameSimilarity = await measureStartFrameSimilarity({
      clipPath,
      startFramePath: startFrame.startFramePath,
      width: plan.width,
      height: plan.height,
      fps: plan.fps,
      ffmpegPath,
    });
    if (!(startFrameSimilarity >= plan.policy.minimumStartFrameSimilarity)) {
      failures.push(`start-frame-drift:${startFrameSimilarity.toFixed(4)}<${plan.policy.minimumStartFrameSimilarity}`);
    }
  }
  return { pass: failures.length === 0, failures, probe, startFrameSimilarity };
}

function latestAttempt(entry, predicate) {
  return [...(entry.attempts || [])].reverse().find(predicate) || null;
}

function bindingFromAttempt({ row, attempt, plan, reason }) {
  return {
    version: MANGA_CUT_VIDEO_BINDING_VERSION,
    status: "applied",
    reason,
    model: attempt.model,
    resolution: attempt.resolution,
    requestedDurationSeconds: attempt.durationSeconds,
    contentIdentity: attempt.contentIdentity,
    requestIdentity: attempt.requestIdentity,
    promptSha256: attempt.promptSha256,
    sourceImagePath: attempt.sourceImagePath,
    sourceImageSha256: attempt.sourceImageSha256,
    startFramePath: attempt.startFramePath,
    startFrameSha256: attempt.startFrameSha256,
    startFrameSpecDigest: attempt.startFrameSpecDigest,
    clipPath: attempt.clip.path,
    clipSha256: attempt.clip.sha256,
    clipDurationSeconds: attempt.clip.probe.durationSeconds,
    clipWidth: attempt.clip.probe.width,
    clipHeight: attempt.clip.probe.height,
    cutFrameCount: row.frameCount,
    maximumClipShortfallFrames: plan.policy.maximumClipShortfallFrames,
    attemptId: attempt.attemptId,
  };
}

function fallbackBinding(fallback) {
  return {
    version: MANGA_CUT_VIDEO_BINDING_VERSION,
    status: "still-fallback",
    fallback: { ...fallback },
  };
}

function clipCoversCut(attempt, row, plan) {
  const availableFrames = Math.floor(Number(attempt?.clip?.probe?.durationSeconds || 0) * plan.fps + 1e-6);
  return availableFrames + plan.policy.maximumClipShortfallFrames >= row.frameCount;
}

// 提供元の例外文は台帳・状態ファイル・CLI 出力にそのまま載る。既知の鍵の値に
// 加えて、鍵らしい形の文字列も消す（生成層は例外に何を混ぜるかを保証しない）。
const CREDENTIAL_ENV_NAMES = [
  "XAI_API_KEY", "GROK_DEPLOYMENT_KEY", "LOVART_ACCESS_KEY", "LOVART_SECRET_KEY",
  "BUZZASSIST_TOKEN", "BUZZASSIST_MEDIA_TOKEN",
];
const CREDENTIAL_SHAPES = [
  /(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/giu,
  /((?:api[-_]?key|access[-_]?key|secret|token|authorization|password)["']?\s*[:=]\s*["']?)[^\s"',;&]{6,}/giu,
  /\b(?:sk|pk|xai|fal|key)[-_][A-Za-z0-9_-]{6,}/giu,
];

function redactedError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const secrets = CREDENTIAL_ENV_NAMES.map((name) => process.env[name]).filter(Boolean);
  let text = redactSecrets(message, secrets);
  for (const shape of CREDENTIAL_SHAPES) {
    text = text.replace(shape, (match, prefix) => (typeof prefix === "string" ? `${prefix}[redacted]` : "[redacted]"));
  }
  return text.slice(0, 800);
}

/**
 * 印の付いたカットのクリップを用意し、manifest へ結び付ける。
 *
 * 戻り値の status:
 *   not-applicable  印が無い（manifest に残った古い結び付けは外す）
 *   ready           全カットが applied か、理由付きの still-fallback
 *   waiting         有料生成の確認待ち（--confirm-paid-generation が無い）
 *   blocked         失敗・課金状態不明・上限到達・対象外。運営者の判断が要る
 */
export async function runCutVideoSubstitutions(options = {}) {
  const manifestPath = resolve(options.manifestPath);
  const episodeDir = resolve(options.episodeDir || dirname(manifestPath));
  const paths = cutVideoSubstitutionPaths(episodeDir);
  // 印も結び付けも無い回（既定）は、ロック・台帳・レポートを含め何も書かない。
  // 差し替えを使わない回の成果物が、この工程の追加前と同じであるように。
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const plan = planCutVideoSubstitutions({ manifest, contract: options.contract, durationOptionsFor: options.durationOptionsFor });
  const stillFallbackRequested = (options.stillFallback?.cutIds || []).some((value) => String(value).trim());
  if (!plan.applicable && plan.unmarkedBindings.length === 0 && !stillFallbackRequested) {
    if (String(options.cutIds || "").trim()) {
      throw new Error(`--cut-ids names cuts that are not marked for video substitution: ${options.cutIds}`);
    }
    return {
      version: MANGA_CUT_VIDEO_STAGE_REPORT_VERSION,
      episodeId: manifest.id,
      status: "not-applicable",
      model: plan.policy.model,
      rows: [],
      blocked: [],
      removedUnmarkedBindings: [],
      manifestChanged: false,
      ledgerPath: "",
      stageReportPath: "",
      manifest,
    };
  }
  return withCanvasFileLock(paths.ledgerPath, () => runCutVideoSubstitutionsLocked({ ...options, manifestPath, episodeDir, paths }), { timeoutMs: 0 });
}

async function runCutVideoSubstitutionsLocked({
  manifestPath,
  paths,
  contract,
  confirmPaidGeneration = false,
  retryFailed = false,
  cutIds = "",
  stillFallback = null,
  generateVideo = generateVideoMedia,
  durationOptionsFor = imageToVideoDurationOptions,
  ffmpegPath = "ffmpeg",
  ffprobePath = "ffprobe",
  now = () => new Date(),
}) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const plan = planCutVideoSubstitutions({ manifest, contract, durationOptionsFor });
  const ledger = await readLedger(paths.ledgerPath, manifest.id);
  const selected = new Set(String(cutIds || "").split(",").map((value) => value.trim()).filter(Boolean));
  const isSelected = (cutId) => selected.size === 0 || selected.has(cutId);
  const marked = new Set(plan.rows.map((row) => row.cutId));
  const unknownSelection = [...selected].filter((cutId) => !marked.has(cutId));
  if (unknownSelection.length > 0) {
    throw new Error(`--cut-ids names cuts that are not marked for video substitution: ${unknownSelection.join(", ")}`);
  }
  const blocked = [];
  const block = (cutId, reason, detail, next) => blocked.push({ cutId, reason, detail, next });

  // 静止画で描く判断は、理由と名前が揃ったときだけ台帳へ残す。
  const fallbackCutIds = (stillFallback?.cutIds || []).map((value) => String(value).trim()).filter(Boolean);
  if (fallbackCutIds.length > 0) {
    const reason = String(stillFallback.reason || "").trim();
    const decidedBy = String(stillFallback.decidedBy || "").trim();
    if (reason.length < 8) throw new Error("A still fallback requires --still-fallback-reason with a concrete reason (8+ characters).");
    if (!decidedBy) throw new Error("A still fallback requires --still-fallback-decided-by with the operator's name.");
    for (const cutId of fallbackCutIds) {
      if (!marked.has(cutId)) throw new Error(`${cutId} is not marked for video substitution; nothing to fall back from.`);
      ledgerCut(ledger, cutId).stillFallback = { reason, decidedBy, decidedAt: nowIso(now) };
    }
  }

  const rowsOut = [];
  let spendingStopped = false;
  for (const row of plan.rows) {
    const entry = ledgerCut(ledger, row.cutId);
    const out = { cutId: row.cutId, status: "pending", eligible: row.eligible, failures: row.failures };
    rowsOut.push(out);
    if (entry.stillFallback && !(retryFailed && selected.has(row.cutId))) {
      out.status = "still-fallback";
      out.stillFallback = entry.stillFallback;
      continue;
    }
    if (!row.eligible) {
      out.status = "ineligible";
      block(row.cutId, "cut-not-eligible", row.failures, "契約のエピソード例外からこのカットを外すか、カットを分割してから再実行する。");
      continue;
    }
    const cutDir = paths.cutDir(row.cutId);
    const startFrame = await prepareStartFrame({ plan, row, cutDir, ffmpegPath });
    const contentIdentity = cutVideoContentIdentity({
      model: plan.policy.model,
      resolution: plan.policy.resolution,
      aspectRatio: plan.policy.aspectRatio,
      prompt: row.prompt,
      startFrameSpecDigest: startFrame.startFrameSpecDigest,
    });
    const requestIdentity = cutVideoRequestIdentity({ contentIdentity, durationSeconds: row.requestDurationSeconds });
    Object.assign(out, {
      model: plan.policy.model,
      requestDurationSeconds: row.requestDurationSeconds,
      cutDurationSeconds: row.durationSeconds,
      frameCount: row.frameCount,
      startFramePath: startFrame.startFramePath,
      startFrameSha256: startFrame.startFrameSha256,
      contentIdentity,
      requestIdentity,
      attemptsUsed: entry.attempts.length,
      attemptsAllowed: plan.policy.maximumGenerationAttemptsPerCut,
    });

    // 再開: 同じ内容で完了済みのクリップが実在し、尺を覆っていれば作り直さない。
    const reusable = latestAttempt(entry, (attempt) => (
      attempt.status === "completed" && attempt.contentIdentity === contentIdentity && clipCoversCut(attempt, row, plan)
    ));
    if (reusable && await isFile(reusable.clip.path) && await sha256File(reusable.clip.path) === reusable.clip.sha256) {
      if (retryFailed && selected.has(row.cutId) && entry.stillFallback) entry.stillFallback = null;
      out.status = "applied";
      out.reused = true;
      out.binding = bindingFromAttempt({ row, attempt: reusable, plan, reason: row.reason });
      continue;
    }
    if (!isSelected(row.cutId)) {
      block(row.cutId, "not-selected", "this run was limited by --cut-ids", "対象カットを --cut-ids に含めて再実行する。");
      continue;
    }
    const previous = latestAttempt(entry, (attempt) => attempt.contentIdentity === contentIdentity);
    if (previous?.status === "completed" && clipCoversCut(previous, row, plan) && !retryFailed) {
      // 完了済みのクリップが消えた・書き換わった。黙って作り直す（再課金する）より止める。
      out.status = "clip-missing";
      block(row.cutId, "completed-clip-missing-or-altered", previous.clip?.path || "",
        "クリップの所在を確かめる。作り直してよい場合だけ --retry-failed を付けて再実行する。");
      continue;
    }
    if (previous?.status === "submitted" && !retryFailed) {
      out.status = "charge-unknown";
      block(row.cutId, "charge-unknown-in-flight", `attempt ${previous.attemptId} was submitted at ${previous.submittedAt} and never recorded a result`,
        "提供元の管理画面で生成・課金の有無を確かめ、再送してよい場合だけ --retry-failed を付けて再実行する。");
      continue;
    }
    if (previous && ["failed", "rejected"].includes(previous.status) && !retryFailed) {
      out.status = previous.status;
      block(row.cutId, `previous-attempt-${previous.status}`, previous.error || previous.validation?.failures,
        "指示文・モデルを見直すか、--retry-failed で再試行する。静止画にするなら --allow-still-fallback を理由付きで使う。");
      continue;
    }
    if (entry.attempts.length >= plan.policy.maximumGenerationAttemptsPerCut) {
      out.status = "budget-exhausted";
      block(row.cutId, "attempt-budget-exhausted", `${entry.attempts.length} of ${plan.policy.maximumGenerationAttemptsPerCut} attempts used`,
        "静止画に戻す（--allow-still-fallback）か、契約の上限の範囲で方針を決め直す。");
      continue;
    }
    if (spendingStopped) {
      block(row.cutId, "stopped-after-earlier-failure", "an earlier cut failed in this run", "先に失敗したカットを解決してから再実行する。");
      continue;
    }
    if (!confirmPaidGeneration) {
      out.status = "awaiting-paid-confirmation";
      block(row.cutId, "awaiting-paid-confirmation",
        `${plan.policy.model} ${row.requestDurationSeconds}s ${plan.policy.resolution} (attempt ${entry.attempts.length + 1}/${plan.policy.maximumGenerationAttemptsPerCut})`,
        "費用を確認し、--confirm-paid-generation を付けて再実行する。");
      continue;
    }

    const attempt = {
      attemptId: `${row.cutId}-a${entry.attempts.length + 1}-${requestIdentity.slice(0, 12)}`,
      attemptNumber: entry.attempts.length + 1,
      status: "submitted",
      chargeState: "unknown",
      model: plan.policy.model,
      resolution: plan.policy.resolution,
      aspectRatio: plan.policy.aspectRatio,
      durationSeconds: row.requestDurationSeconds,
      contentIdentity,
      requestIdentity,
      promptSha256: sha256Text(row.prompt),
      prompt: row.prompt,
      ...startFrame,
      submittedAt: nowIso(now),
    };
    entry.attempts.push(attempt);
    ledger.updatedAt = nowIso(now);
    // 呼ぶ前に書く。ここで落ちたプロセスの試行は「課金状態不明」として残る。
    await writeJsonAtomic(paths.ledgerPath, ledger);

    let media;
    try {
      media = await generateVideo({
        model: plan.policy.model,
        prompt: row.prompt,
        startFramePath: startFrame.startFramePath,
        duration: String(row.requestDurationSeconds),
        resolution: plan.policy.resolution,
        aspectRatio: plan.policy.aspectRatio,
        generateAudio: false,
        videoCount: 1,
        fileName: `${row.cutId}-${attempt.attemptId}.mp4`,
      });
    } catch (error) {
      Object.assign(attempt, { status: "failed", error: redactedError(error), finishedAt: nowIso(now) });
      out.status = "failed";
      spendingStopped = true;
      block(row.cutId, "generation-failed", attempt.error,
        "エラー内容を確認し、--retry-failed で再試行するか、静止画に戻す判断をする。");
      await writeJsonAtomic(paths.ledgerPath, ledger);
      continue;
    }
    // ここから先は提供元が仕事を終えている＝課金済み。何があっても再送しない。
    attempt.chargeState = "charged";
    const extension = extname(String(media?.fileName || "")) || ".mp4";
    const clipPath = join(paths.cutDir(row.cutId), `clip-${attempt.attemptId}${extension}`);
    try {
      if (!Buffer.isBuffer(media?.buffer) || media.buffer.length === 0) throw new Error("generator returned no video bytes");
      if (media.model && media.model !== plan.policy.model) throw new Error(`generator used ${media.model} instead of ${plan.policy.model}`);
      await mkdir(dirname(clipPath), { recursive: true });
      const temporaryPath = `${clipPath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, media.buffer);
      await rename(temporaryPath, clipPath);
      const clipSha256 = await sha256File(clipPath);
      const validation = await validateGeneratedClip({ clipPath, plan, row, startFrame, ffmpegPath, ffprobePath });
      attempt.clip = {
        path: clipPath,
        sha256: clipSha256,
        bytes: media.buffer.length,
        mimeType: media.mimeType || "",
        source: typeof media.source === "string" && !media.source.startsWith("data:") ? media.source : "inline",
        probe: validation.probe,
      };
      attempt.validation = { failures: validation.failures, startFrameSimilarity: validation.startFrameSimilarity };
      attempt.finishedAt = nowIso(now);
      if (!validation.pass) {
        attempt.status = "rejected";
        out.status = "rejected";
        spendingStopped = true;
        block(row.cutId, "clip-rejected", validation.failures,
          "クリップは保存済み（課金済み）。指示文を見直して --retry-failed で作り直すか、静止画に戻す判断をする。");
      } else {
        attempt.status = "completed";
        if (entry.stillFallback) entry.stillFallback = null;
        out.status = "applied";
        out.binding = bindingFromAttempt({ row, attempt, plan, reason: row.reason });
      }
    } catch (error) {
      Object.assign(attempt, { status: "rejected", error: redactedError(error), finishedAt: nowIso(now) });
      out.status = "rejected";
      spendingStopped = true;
      block(row.cutId, "clip-unusable", attempt.error, "保存・検査に失敗した。課金済みなので自動では作り直さない。");
    }
    ledger.updatedAt = nowIso(now);
    await writeJsonAtomic(paths.ledgerPath, ledger);
  }

  // manifest への結び付け。印の無いカットの結び付けは必ず外す。
  let manifestChanged = false;
  const bindingByCut = new Map(rowsOut.map((row) => [row.cutId, row]));
  for (const cut of manifest.cuts || []) {
    const row = bindingByCut.get(cut.id);
    let next;
    if (row?.status === "applied") next = row.binding;
    else if (row?.status === "still-fallback") next = fallbackBinding(row.stillFallback);
    else next = undefined;
    if (JSON.stringify(cut.videoSubstitution) !== JSON.stringify(next)) {
      if (next === undefined) delete cut.videoSubstitution;
      else cut.videoSubstitution = next;
      manifestChanged = true;
    }
  }
  if (manifestChanged) await writeJsonAtomic(manifestPath, manifest);
  ledger.updatedAt = nowIso(now);
  await writeJsonAtomic(paths.ledgerPath, ledger);

  const waitingOnly = blocked.length > 0 && blocked.every((row) => row.reason === "awaiting-paid-confirmation");
  const status = !plan.applicable ? "not-applicable" : blocked.length === 0 ? "ready" : waitingOnly ? "waiting" : "blocked";
  const report = {
    version: MANGA_CUT_VIDEO_STAGE_REPORT_VERSION,
    episodeId: manifest.id,
    status,
    model: plan.policy.model,
    maximumCutsPerEpisode: plan.policy.maximumCutsPerEpisode,
    maximumGenerationAttemptsPerCut: plan.policy.maximumGenerationAttemptsPerCut,
    rows: rowsOut.map(({ binding, ...row }) => ({ ...row, clipSha256: binding?.clipSha256 || "" })),
    blocked,
    removedUnmarkedBindings: plan.unmarkedBindings,
    manifestChanged,
    ledgerPath: paths.ledgerPath,
    generatedAt: nowIso(now),
  };
  await writeJsonAtomic(paths.stageReportPath, report);
  return { ...report, stageReportPath: paths.stageReportPath, manifest };
}

/**
 * レンダー直前の検査。印の付いたカットは、台帳の完了試行と一致する
 * applied か、台帳に記録された still-fallback でなければ止める。
 * manifest を手で書き換えて出所の無いクリップを結び付ける道もここで塞ぐ。
 */
export async function verifyCutVideoSubstitutionBindings({ manifest, manifestPath, contract, durationOptionsFor = imageToVideoDurationOptions }) {
  const episodeDir = dirname(resolve(manifestPath));
  const paths = cutVideoSubstitutionPaths(episodeDir);
  const plan = planCutVideoSubstitutions({ manifest, contract, durationOptionsFor });
  const failures = [];
  const fail = (cutId, reason, detail = "") => failures.push({ cutId, reason, detail });
  for (const cutId of plan.unmarkedBindings) fail(cutId, "binding-without-contract-mark");
  const boundCutIds = (manifest.cuts || []).filter((cut) => cut.videoSubstitution).map((cut) => cut.id);
  if (!plan.applicable && boundCutIds.length === 0) {
    return { applicable: false, pass: failures.length === 0, failures, plan, rows: [] };
  }
  const ledger = await readLedger(paths.ledgerPath, manifest.id).catch((error) => {
    fail("*", "ledger-unreadable", error.message);
    return emptyLedger(manifest.id);
  });
  const cutsById = new Map((manifest.cuts || []).map((cut) => [cut.id, cut]));
  const rows = [];
  for (const row of plan.rows) {
    const cut = cutsById.get(row.cutId);
    const entry = ledger.cuts[row.cutId] || { attempts: [], stillFallback: null };
    const summary = { cutId: row.cutId, status: cut?.videoSubstitution?.status || "missing" };
    rows.push(summary);
    let binding;
    try {
      binding = appliedCutVideoBinding(cut);
    } catch (error) {
      fail(row.cutId, "binding-invalid", error.message);
      continue;
    }
    if (!cut?.videoSubstitution) {
      fail(row.cutId, "clip-not-ready", "run video-substitute before rendering");
      continue;
    }
    if (!binding) {
      const recorded = entry.stillFallback;
      if (!recorded || JSON.stringify(recorded) !== JSON.stringify(cut.videoSubstitution.fallback)) {
        fail(row.cutId, "still-fallback-not-recorded", "a still fallback must come from the operator decision in the ledger");
      }
      summary.stillFallback = cut.videoSubstitution.fallback;
      continue;
    }
    if (!row.eligible) {
      fail(row.cutId, "cut-not-eligible", row.failures);
      continue;
    }
    const attempt = (entry.attempts || []).find((candidate) => candidate.attemptId === binding.attemptId);
    if (!attempt || attempt.status !== "completed") {
      fail(row.cutId, "binding-without-completed-attempt", binding.attemptId);
      continue;
    }
    if (attempt.clip?.sha256 !== binding.clipSha256 || attempt.clip?.path !== binding.clipPath) {
      fail(row.cutId, "binding-differs-from-ledger");
    }
    if (!await isFile(binding.clipPath)) fail(row.cutId, "clip-missing", binding.clipPath);
    else if (await sha256File(binding.clipPath) !== binding.clipSha256) fail(row.cutId, "clip-bytes-changed", binding.clipPath);
    if (!await isFile(row.sourceImagePath)) {
      fail(row.cutId, "source-image-missing", row.sourceImagePath);
      continue;
    }
    const currentSpec = cutVideoStartFrameSpecDigest({
      sourceImageSha256: await sha256File(row.sourceImagePath),
      width: plan.width,
      height: plan.height,
      oversample: plan.oversample,
      start: row.startCamera,
    });
    if (currentSpec !== binding.startFrameSpecDigest) {
      fail(row.cutId, "start-frame-stale", "the approved still or its camera start changed; regenerate the clip");
    }
    const currentContent = cutVideoContentIdentity({
      model: plan.policy.model,
      resolution: plan.policy.resolution,
      aspectRatio: plan.policy.aspectRatio,
      prompt: row.prompt,
      startFrameSpecDigest: currentSpec,
    });
    if (currentContent !== binding.contentIdentity) fail(row.cutId, "request-stale", "model, resolution or motion prompt changed; regenerate the clip");
    if (!clipCoversCut(attempt, row, plan)) fail(row.cutId, "clip-shorter-than-cut", `${row.frameCount} frames needed`);
    Object.assign(summary, { clipSha256: binding.clipSha256, startFrameSha256: binding.startFrameSha256, frameCount: row.frameCount });
  }
  return { applicable: true, pass: failures.length === 0, failures, plan, rows, ledgerPath: paths.ledgerPath };
}

export async function assertCutVideoSubstitutionsReadyForRender(options) {
  const verification = await verifyCutVideoSubstitutionBindings(options);
  if (!verification.pass) {
    throw new CutVideoSubstitutionBlockedError(
      `Render is blocked until marked cuts have a verified clip or a recorded still fallback: ${JSON.stringify(verification.failures)}`,
      { blocked: verification.failures, ledgerPath: verification.ledgerPath || "" },
    );
  }
  return verification;
}

async function renderedCutFrameCount(manifest, cut, fps, ffprobePath) {
  const renderedPath = manifest.jobs?.render?.[cut.id]?.outputPath;
  if (renderedPath && await isFile(renderedPath)) {
    try {
      const { stdout } = await runTool(ffprobePath, [
        "-v", "error", "-select_streams", "v:0", "-count_packets",
        "-show_entries", "stream=nb_read_packets", "-of", "default=noprint_wrappers=1:nokey=1", renderedPath,
      ]);
      const frames = Number(String(stdout).trim());
      if (Number.isInteger(frames) && frames > 0) return frames;
    } catch {
      // 下の計算値へ落とす。
    }
  }
  return cutFrameCount(cut.timing?.durationSeconds, fps);
}

function bubbleWindowsForCut(manifest, cut) {
  const rows = [];
  for (const utterance of utterancesForCut(manifest, cut)) {
    const timing = utterance.timing || {};
    const segments = Array.isArray(utterance.bubbleSegments)
      ? utterance.bubbleSegments.filter((segment) => segment?.overlayPath)
      : [];
    if (segments.length > 0) {
      const audioStart = Number(timing.audioStartInCutSeconds || 0);
      const defaultStart = Number(timing.bubbleStartInCutSeconds ?? audioStart);
      const defaultEnd = Number(timing.bubbleEndInCutSeconds ?? audioStart);
      for (const [index, segment] of segments.entries()) {
        const requestedStart = audioStart + Number(segment.startOffsetSeconds ?? (defaultStart - audioStart));
        const requestedEnd = audioStart + Number(segment.endOffsetSeconds ?? (defaultEnd - audioStart));
        rows.push({
          id: segment.id || `${utterance.id}-bubble-${index + 1}`,
          utteranceId: utterance.id,
          rasterPath: segment.rasterizedOverlayPath || "",
          renderOffset: segment.renderOffset || null,
          startInCut: Math.max(defaultStart, Math.min(defaultEnd, requestedStart)),
          endInCut: Math.max(defaultStart, Math.min(defaultEnd, requestedEnd)),
        });
      }
      continue;
    }
    rows.push({
      id: utterance.id,
      utteranceId: utterance.id,
      rasterPath: utterance.rasterizedOverlayPath || "",
      renderOffset: null,
      startInCut: Number(timing.bubbleStartInCutSeconds || 0),
      endInCut: Number(timing.bubbleEndInCutSeconds || 0),
    });
  }
  return rows;
}

/** 開始フレーム上の保護領域（手動注釈・自動検出の顔と重要物）を画面座標へ。 */
function hardRegionsAtStart(row, plan) {
  const regions = [];
  const seen = new Set();
  const push = (id, kind, bounds, source) => {
    const projected = projectFaceBoundsThroughCamera(bounds, row.startShot.camera, row.startShot.motion, 0);
    if (!projected) return;
    const px = {
      x: Math.round(projected.x * plan.width),
      y: Math.round(projected.y * plan.height),
      width: Math.max(1, Math.round(projected.width * plan.width)),
      height: Math.max(1, Math.round(projected.height * plan.height)),
    };
    const key = `${kind}:${px.x}:${px.y}:${px.width}:${px.height}`;
    if (seen.has(key)) return;
    seen.add(key);
    regions.push({ id, kind, source, ...px });
  };
  for (const shot of row.shots) {
    for (const [index, region] of (Array.isArray(shot.sourceAvoidRegions) ? shot.sourceAvoidRegions : []).entries()) {
      if (region?.kind !== "face" && region?.hardProtection !== true) continue;
      push(region.id || `${shot.id}-avoid-${index + 1}`, region.kind || "region", region, "source-avoid-region");
    }
    for (const [speakerId, bounds] of Object.entries(shot.sourceFaceBoundsBySpeakerId || {})) {
      push(`${shot.id}-${speakerId}-face`, "face", bounds, "source-speaker-face");
    }
  }
  return regions;
}

/**
 * 最終監査の本体。実MP4をデコードして差し替え区間を実測する。
 * 印もクリップも無い回は「対象外」で通すが、片方だけある状態は落とす。
 */
export async function auditCutVideoSubstitutions({
  projectDir = process.cwd(),
  manifestPath,
  videoPath,
  contract,
  outputDir,
  pythonPath = "python3",
  pythonArgs = [],
  ffprobePath = "ffprobe",
  cascadePath = "",
  runAnalysis = null,
}) {
  const manifest = JSON.parse(await readFile(resolve(manifestPath), "utf8"));
  const reportPath = join(resolve(outputDir), "audit.json");
  await mkdir(dirname(reportPath), { recursive: true });
  const verification = await verifyCutVideoSubstitutionBindings({ manifest, manifestPath, contract });
  if (!verification.applicable) {
    const report = {
      version: MANGA_CUT_VIDEO_AUDIT_VERSION,
      applicable: false,
      pass: verification.pass,
      failures: verification.failures,
      detail: "not applicable: no cut is marked for video substitution",
      generatedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(reportPath, report);
    return { reportPath, report };
  }
  const plan = verification.plan;
  const cutsById = new Map((manifest.cuts || []).map((cut) => [cut.id, cut]));
  const ranges = [];
  let cursor = 0;
  for (const cut of manifest.cuts || []) {
    const frames = await renderedCutFrameCount(manifest, cut, plan.fps, ffprobePath);
    ranges.push({ cutId: cut.id, startFrame: cursor, frameCount: frames });
    cursor += frames;
  }
  const rangeByCut = new Map(ranges.map((row) => [row.cutId, row]));
  const analysisCuts = [];
  const failures = [...verification.failures];
  const fallbackCuts = [];
  for (const row of plan.rows) {
    const cut = cutsById.get(row.cutId);
    const binding = cut?.videoSubstitution;
    if (binding?.status === "still-fallback") {
      fallbackCuts.push({ cutId: row.cutId, ...binding.fallback });
      continue;
    }
    if (binding?.status !== "applied" || !row.eligible) continue;
    const range = rangeByCut.get(row.cutId);
    if (range.frameCount !== row.frameCount) {
      failures.push({ cutId: row.cutId, reason: "rendered-frame-count-mismatch", detail: `${range.frameCount} != ${row.frameCount}` });
    }
    if (manifest.jobs?.render?.[row.cutId]?.status !== "complete") {
      failures.push({ cutId: row.cutId, reason: "render-job-not-complete" });
    }
    const bubbles = bubbleWindowsForCut(manifest, cut);
    for (const bubble of bubbles) {
      if (!bubble.rasterPath || !await isFile(bubble.rasterPath)) {
        failures.push({ cutId: row.cutId, reason: "bubble-raster-missing", detail: bubble.id });
      }
    }
    analysisCuts.push({
      cutId: row.cutId,
      startFrame: range.startFrame,
      frameCount: row.frameCount,
      clipPath: binding.clipPath,
      clipSha256: binding.clipSha256,
      startFramePath: binding.startFramePath,
      startFrameSha256: binding.startFrameSha256,
      conformFilter: cutVideoClipConformChain({
        width: plan.width,
        height: plan.height,
        fps: plan.fps,
        frameCount: row.frameCount,
        shortfallFrames: binding.maximumClipShortfallFrames,
      }),
      maximumClipShortfallFrames: binding.maximumClipShortfallFrames,
      minimumStartFrameSimilarity: plan.policy.minimumStartFrameSimilarity,
      startFrameSimilarityGraph: startFrameSimilarityGraph({ width: plan.width, height: plan.height, fps: plan.fps }),
      denseFaceSamplesPerSecond: plan.policy.denseFaceSamplesPerSecond,
      bubbles,
      hardRegionsAtStart: hardRegionsAtStart(row, plan),
    });
  }
  const analysisPlanPath = join(resolve(outputDir), "analysis-plan.json");
  const analysisReportPath = join(resolve(outputDir), "analysis.json");
  const videoSha256 = await sha256File(videoPath);
  await writeJsonAtomic(analysisPlanPath, {
    version: MANGA_CUT_VIDEO_AUDIT_VERSION,
    videoPath: resolve(videoPath),
    videoSha256,
    fps: plan.fps,
    width: plan.width,
    height: plan.height,
    totalRenderedFrames: cursor,
    framesDir: join(resolve(outputDir), "frames"),
    cuts: analysisCuts,
  });
  let analysis = { pass: analysisCuts.length === 0, cuts: [] };
  if (analysisCuts.length > 0) {
    const run = runAnalysis || (async () => {
      await execFile(pythonPath, [
        ...pythonArgs,
        join(repositoryRoot, "scripts/audit-manga-video-substitution.py"),
        "--plan", analysisPlanPath,
        "--output", analysisReportPath,
        "--cascade", cascadePath || join(repositoryRoot, "scripts/data/lbpcascade_animeface.xml"),
      ], { cwd: projectDir, maxBuffer: 64 * 1024 * 1024 }).catch((error) => {
        // 不合格は終了コード1で返る。レポートがあればそれを読む。
        if (error?.code !== 1) throw error;
      });
      const written = await readJson(analysisReportPath, null);
      if (!written) throw new Error("video substitution analysis wrote no report");
      return written;
    });
    try {
      analysis = await run({ planPath: analysisPlanPath, reportPath: analysisReportPath });
    } catch (error) {
      analysis = { pass: false, error: String(error?.message || error).slice(0, 800), cuts: [] };
    }
    const analyzed = new Set((analysis.cuts || []).map((row) => row.cutId));
    for (const row of analysisCuts) {
      if (!analyzed.has(row.cutId)) failures.push({ cutId: row.cutId, reason: "cut-not-analyzed" });
    }
    for (const row of analysis.cuts || []) {
      for (const gate of (row.gates || []).filter((entry) => entry.pass !== true)) {
        failures.push({ cutId: row.cutId, reason: gate.id, detail: gate.detail || "" });
      }
    }
    if (analysis.error) failures.push({ cutId: "*", reason: "analysis-failed", detail: analysis.error });
  }
  const report = {
    version: MANGA_CUT_VIDEO_AUDIT_VERSION,
    applicable: true,
    videoPath: resolve(videoPath),
    videoSha256,
    substitutedCutIds: analysisCuts.map((row) => row.cutId),
    stillFallbackCuts: fallbackCuts,
    evidence: analysisCuts.map((row) => ({
      cutId: row.cutId,
      clipPath: row.clipPath,
      clipSha256: row.clipSha256,
      startFramePath: row.startFramePath,
      startFrameSha256: row.startFrameSha256,
      startFrame: row.startFrame,
      frameCount: row.frameCount,
    })),
    analysisPlanPath,
    analysisReportPath: analysisCuts.length > 0 ? analysisReportPath : "",
    analysis,
    failures,
    pass: failures.length === 0 && analysis.pass === true,
    generatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(reportPath, report);
  return { reportPath, report };
}

/**
 * 人の目視が差し替え区間を実際に見たか。機械の指標では同一人物かどうかは
 * 判定できない（顔の画素指標は本人性を見分けない）ので、区間の前・中・後の
 * 実フレームを、人物・吹き出し・疑似文字の観点で見た記録を要求する。
 */
export function auditSubstitutedCutReviewCoverage({ manifest, reviewNotes }) {
  const applied = (manifest?.cuts || []).filter((cut) => cut.videoSubstitution?.status === "applied");
  if (applied.length === 0) return { applicable: false, pass: true, failures: [] };
  const frames = reviewNotes?.evidence?.representativeFramesReviewed?.frames;
  const rows = Array.isArray(frames) ? frames : [];
  const failures = [];
  for (const cut of applied) {
    const start = Number(cut.timing?.startSeconds);
    const duration = Number(cut.timing?.durationSeconds);
    if (!(duration > 0) || !Number.isFinite(start)) {
      failures.push(`substituted-cut-untimed:${cut.id}`);
      continue;
    }
    const inside = rows.filter((row) => {
      const at = Number(row?.timestampSeconds);
      return at >= start && at < start + duration;
    });
    const thirds = new Set(inside.map((row) => Math.min(2, Math.floor(((Number(row.timestampSeconds) - start) / duration) * 3))));
    if (thirds.size < 3) failures.push(`substituted-cut-frames-not-reviewed:${cut.id}`);
    const checks = new Set(inside.flatMap((row) => (Array.isArray(row.checkIds) ? row.checkIds : [])));
    const missing = SUBSTITUTED_CUT_REVIEW_CHECK_IDS.filter((id) => !checks.has(id));
    if (missing.length > 0) failures.push(`substituted-cut-checks-missing:${cut.id}:${missing.join("+")}`);
  }
  return { applicable: true, pass: failures.length === 0, failures };
}
