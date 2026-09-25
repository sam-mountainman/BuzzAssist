import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  paidMediaJobReceiptSummary,
  paidMediaRequestIdentity,
} from "./paidMediaJobBroker.mjs";
import {
  createBrokerMediaJobRunner,
  listUnsettledPaidMediaJobs,
  requestKeyInChain,
} from "./narratedStoryMediaRunner.mjs";
import { redactSecrets } from "./paidApiRetry.mjs";
import { resolveFfmpegToolchain } from "./harnessRuntimeResolver.mjs";
import {
  buildNarratedStoryOutcome,
  pendingNarratedStoryAuditChecks,
  receiptSafeMediaJobs,
} from "./narratedStoryOutcome.mjs";
import {
  loadReviewerTrust,
  reviewerTrustFailureCode,
  signNarratedReviewSignoff,
  verifyNarratedReviewSignoff,
} from "./koyaReviewAttestation.mjs";
import { fullDecodeVerdict } from "./fullDecodeVerdict.mjs";
import { renameWithRetry } from "./atomicJsonFile.mjs";
import { openFileTransaction, recoverFileTransactions } from "./fileTransaction.mjs";
import {
  buildBookendSrt,
  extractPartFrame,
  inspectNarratedBookendRenderGraphs,
  makeBookendBedStem,
  makeBookendContactSheet,
  makeBookendVoiceStem,
  measureNarratedBookendBoundaries,
  normalizeNarratedBookendsConfig,
  operatorReplacementSegments,
  partitionNarratedStoryScript,
  planNarratedBookendProgram,
  renderBookendProgram,
  renderOpeningPart,
  renderPresenterPart,
  renderSegmentImagesPart,
  renderTransitionClip,
  resolveNarratedBookendMedia,
  missingBookendFfmpegFilters,
  segmentFramePlan,
  EPISODE_OPENING_VIDEO_SLOT,
} from "./narratedStoryBookends.mjs";
import { audioSequenceConcatenates, concatAudioSequence } from "./ffmpegSequenceRender.mjs";
import { inspectNarratedSceneVideoGraph, planNarratedProgramSceneJoins } from "./narratedStorySceneTransitions.mjs";
import { subtitleOverlayGraph, videoConcatAssembled } from "./narratedStorySubtitles.mjs";
import {
  checkNarratedVisualPlan,
  loadNarratedVisualConfig,
  narratedProgramFrames,
  narratedVisualAuditChecks,
  narratedVisualManifestFields,
  annotateNarratedReviewVisuals,
  narratedReviewPresenterPath,
  narratedReviewSegmentCamera,
  planNarratedReviewLayout,
  planNarratedVisualCamera,
  prepareNarratedOperatorVideos,
  renderNarratedReviewLayoutPart,
  renderNarratedSubtitleLayer,
  subtitleExclusionRegion,
} from "./narratedStoryVisuals.mjs";
import {
  NARRATED_CHARACTER_IDENTITY_AUDIT_ID,
  NARRATED_QUALITY_AUDIT_ID,
  advanceNarratedQualityLoop,
  narratedCharacterIdentityCheck,
  createNarratedQualityContract,
  narratedQualityPaths,
  narratedQualityReviewSheet,
  normalizeNarratedQualityLoopConfig,
  normalizeNarratedReviewInput,
} from "./narratedStoryQualityLoop.mjs";
import {
  auditNarratedVoiceCasting,
  narratedCastManifest,
  narratedVoiceAdapters,
  normalizeNarratedCastConfig,
} from "./narratedStoryCast.mjs";
import {
  DEFAULT_NARRATED_VOICE_QUALITY_GATE,
  NARRATED_VOICE_QUALITY_AUDIT_ID,
  gateNarratedVoiceTakes,
  narratedVoiceTakeMeasurementReport,
  normalizeNarratedVoiceQualityConfig,
} from "./narratedStoryVoiceQuality.mjs";
import {
  NARRATED_ASSET_LOOP_AUDIT_IDS,
  NARRATED_VIDEO_CLIP_LOOP_AUDIT_ID,
  NARRATED_VOICE_TAKE_MEASUREMENT_DIR,
  brokerSceneLoopSubject,
  gateNarratedAssetLoops,
  narratedAssetLoopsRequired,
  narratedVideoClipLoopsRequired,
  narratedVoiceTakeMeasurementPath,
  operatorSceneLoopSubject,
  reverifyNarratedAssetLoops,
} from "./narratedStoryAssetLoops.mjs";
import {
  buildNarratedMusicBed,
  narratedMusicBedWindow,
  normalizeNarratedMusicPlanConfig,
} from "./narratedStoryMusicPlan.mjs";
import {
  narratedSegmentManifestFields,
  normalizeNarratedScriptIntakeConfig,
  planNarratedStoryInput,
} from "./narratedStoryScriptPackage.mjs";
import {
  NARRATED_SCRIPT_QUALITY_AUDIT_ID,
  gateNarratedScriptQuality,
} from "./narratedStoryScriptQuality.mjs";
import { scriptQualityWorkDirFor } from "./scriptQualityUseGate.mjs";
import {
  OPERATOR_IMAGE_COST_BASIS,
  checkOperatorImageImport,
  materializeOperatorImages,
  normalizeOperatorImageSourceConfig,
  readOperatorImageManifest,
  resolveApprovedReferenceSha256s,
} from "./operatorImageImport.mjs";

const execFile = promisify(execFileCallback);

export const NARRATED_STORY_PIPELINE_VERSION = "buzzassist-narrated-story-pipeline-v1";
export const NARRATED_STORY_CHANNEL_CONFIG = "narrated-story.json";
/**
 * 独立 signoff の版。v2 で、評価項目ごとの点数・所見・評価文脈（qualityReview）と、
 * 差し戻し（approved: false と findings）を載せられるようになった。品質ループの回は
 * v2 の signoff からしか作らない。
 */
export const NARRATED_STORY_SIGNOFF_VERSION = "buzzassist-narrated-story-contact-sheet-signoff-v2";
export const NARRATED_STORY_RUN_RECEIPT_VERSION = "buzzassist-narrated-story-run-receipt-v1";
export const NARRATED_STORY_AUDIT_VERSION = "buzzassist-narrated-story-audit-v1";
/**
 * 監査の中身の版（RunReceipt の contractVersion）。v2 で bookend 境目の実測監査
 * （bookendTransitionMeasured・実測化した audioBoundaryBreathV16）と
 * operatorReplacementCleared が入った。v3 で品質ループ（qualityLoopPassed）が入った。v4 で声の監査
 * （voiceTakeQuality: 語りと台詞の全テイクの音声品質ゲート、voiceCastRouting: 役の声の照合）と
 * 人物の同一性（characterIdentityReviewed: 署名済み独立レビューの評価項目の下限）が入った。v5 で途中の成果物の
 * 品質ループ（sceneImageAssetLoopPassed・voiceTakeAssetLoopPassed・characterAssetLoopPassed:
 * lib/narratedStoryAssetLoops.mjs。本編の画・人物の設定画・採用する声のテイクは、ループに合格した版でなければ
 * 描かない）と、場面の画の出どころ（sceneImageProvenance）が保証になった。v6 で見た目の実測
 * （burnedSubtitlesMeasured・cameraMotionMeasured・reviewLayoutMeasured・episodeOpeningProvenance:
 * lib/narratedStoryVisuals.mjs。完成 MP4 のフレームを読んで測る）が保証になった。v7 で回ごとの運営者の動画
 * （OP 映像・感想パートの人物の映像）の途中の成果物の品質ループ（operatorVideoAssetLoopPassed: 工程 video-clip。
 * lib/narratedStoryAssetLoops.mjs）が保証になった。v8 で台本の品質ループの合格（scriptQualityAccepted:
 * lib/narratedStoryScriptQuality.mjs。使う台本が台本の品質ループに合格した版か、人がそのまま使うと認めた版で
 * なければ有料の処理を始めない）が保証になった。
 * 宣言の inForceSince はこの系列で書く。production の state は作った版を auditContractVersion に残し、
 * 確定はその版で測る（v4 以前の state は、当時無かった関門を求めずに従来どおり確定する。v6 以前の state は動画の
 * 関門を求めない）。
 */
export const NARRATED_STORY_AUDIT_CONTRACT_VERSION = "buzzassist-narrated-story-audit-v8";
export const NARRATED_STORY_HARNESS_ID = "narrated-story-video";
const SHA256_HEX = /^[a-f0-9]{64}$/u;

const SENSITIVE_KEY = /(?:api[-_]?key|authorization|auth[-_]?token|access[-_]?token|refresh[-_]?token|token|secret|password|credentials?|private[-_]?key|signing[-_]?key|client[-_]?secret|cookie)$/iu;
const TERMINAL_PUNCTUATION = /[。！？!?]/u;
const CLOSING_PUNCTUATION = /[」』）】〉》〕］}]/u;

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function finite(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, minimum, maximum, fallback) {
  return Math.min(maximum, Math.max(minimum, finite(value, fallback)));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function fileSha256(path) {
  return sha256(await readFile(path));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readJsonIfPresent(path) {
  try {
    return await readJson(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeAtomic(path, value, { json = false, mode = 0o600 } = {}) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const body = json ? `${JSON.stringify(value, null, 2)}\n` : value;
  await writeFile(temp, body, { mode });
  // Windows は、読まれている最中の置き換えを拒む（lib/atomicJsonFile.mjs と同じ理由）。
  await renameWithRetry(temp, path);
}

async function artifactRecord(path) {
  const absolute = resolve(path);
  const info = await stat(absolute);
  if (!info.isFile() || info.size === 0) throw new Error(`Artifact is missing or empty: ${absolute}`);
  return { path: absolute, sha256: await fileSha256(absolute), bytes: info.size };
}

async function artifactRecordValid(record) {
  if (!record?.path || !/^[a-f0-9]{64}$/u.test(String(record.sha256 || ""))) return false;
  try {
    const info = await stat(record.path);
    return info.isFile() && info.size > 0 && await fileSha256(record.path) === record.sha256;
  } catch {
    return false;
  }
}

function assertNoSensitiveFields(value, path = "channelPack", seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) {
      throw new Error(`${path}.${key} is forbidden; provider secrets must stay on the BuzzAssist server.`);
    }
    assertNoSensitiveFields(child, `${path}.${key}`, seen);
  }
}

function stableId(value, fallback = "job") {
  return nonEmpty(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 96) || fallback;
}

function providerConfig(value, label, { voice = false } = {}) {
  const source = value && typeof value === "object" ? value : {};
  const normalized = {
    provider: nonEmpty(source.provider),
    model: nonEmpty(source.model),
    adapterVersion: nonEmpty(source.adapterVersion),
    ...(voice ? { voiceId: nonEmpty(source.voiceId), speed: clamp(source.speed, 0.7, 1.3, 1) } : {}),
  };
  const missing = Object.entries(normalized)
    .filter(([key, item]) => key !== "speed" && !item)
    .map(([key]) => `${label}.${key}`);
  return { normalized, missing };
}

export async function loadNarratedStoryChannelConfig(channelPackDir) {
  const path = join(resolve(channelPackDir), NARRATED_STORY_CHANNEL_CONFIG);
  let source;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("config is not a regular file");
    source = await readJson(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { ok: false, path, blockers: [`channel-pack-${NARRATED_STORY_CHANNEL_CONFIG}-missing`] };
    }
    throw error;
  }
  assertNoSensitiveFields(source);
  const image = providerConfig(source.image, "image");
  const voice = providerConfig(source.voice, "voice", { voice: true });
  const music = providerConfig(source.music, "music");
  const stylePrompt = nonEmpty(source.image?.stylePrompt);
  const musicPrompt = nonEmpty(source.music?.prompt);
  const blockers = [...image.missing, ...voice.missing, ...music.missing];
  const runtimeMetadata = {
    imageModel: nonEmpty(source.runtime?.imageModel),
    ttsProvider: nonEmpty(source.runtime?.ttsProvider),
    imageProvider: image.normalized.provider,
    imageAdapterVersion: image.normalized.adapterVersion,
    ttsModel: voice.normalized.model,
    ttsAdapterVersion: voice.normalized.adapterVersion,
    musicProvider: music.normalized.provider,
    musicModel: music.normalized.model,
    musicAdapterVersion: music.normalized.adapterVersion,
  };
  if (!runtimeMetadata.imageModel) blockers.push("runtime.imageModel");
  if (!runtimeMetadata.ttsProvider) blockers.push("runtime.ttsProvider");
  if (runtimeMetadata.imageModel && runtimeMetadata.imageModel !== image.normalized.model) blockers.push("runtime.imageModel-mismatch");
  if (runtimeMetadata.ttsProvider && runtimeMetadata.ttsProvider !== voice.normalized.provider) blockers.push("runtime.ttsProvider-mismatch");
  const width = Math.round(clamp(source.render?.width, 160, 3840, 1280));
  const height = Math.round(clamp(source.render?.height, 90, 2160, 720));
  const fps = Math.round(clamp(source.render?.fps, 1, 60, 24));
  const render = {
    width: width % 2 === 0 ? width : width - 1,
    height: height % 2 === 0 ? height : height - 1,
    fps,
  };
  // 本編の画の出どころ（lib/operatorImageImport.mjs）。既定は有料の Media Job（broker）。
  // operator-file は運営者が用意した画を manifest から取り込み、全部の場面をそこから取る（混在させない）。
  const imageSource = normalizeOperatorImageSourceConfig(source.image, { render, label: "image" });
  // 画風の指示は有料の画像生成へ渡すものなので、運営者の画を取り込む Pack には要らない。
  if (!stylePrompt && imageSource.config.source === "broker") blockers.push("image.stylePrompt");
  if (!musicPrompt) blockers.push("music.prompt");
  blockers.push(...imageSource.blockers);
  const config = {
    version: nonEmpty(source.version) || "content-sha",
    runtimeMetadata,
    image: { ...image.normalized, stylePrompt, source: imageSource.config.source },
    imageImport: imageSource.config.source === "operator-file" ? imageSource.config : null,
    voice: voice.normalized,
    music: {
      ...music.normalized,
      prompt: musicPrompt,
      gain: clamp(source.music?.gain, 0.005, 0.25, 0.04),
    },
    render,
    concurrency: Math.round(clamp(source.concurrency, 1, 4, 4)),
  };
  const bookends = normalizeNarratedBookendsConfig(source.bookends, { render: config.render });
  blockers.push(...bookends.blockers);
  config.bookends = bookends.config;
  if (config.bookends.enabled) {
    // 転換を実測で確かめられるだけのフレーム数が無い宣言は、描く前に止める
    // （film-burn は出る側・白ゲート・入る側の 3 相を見るので 8 フレーム以上）。
    for (const [id, transition] of Object.entries(config.bookends.transitions || {})) {
      if (!transition) continue;
      const frames = Math.round(transition.durationSeconds * fps);
      const minimum = transition.type === "film-burn" ? 8 : (transition.type === "fade-through-black" ? 3 : 0);
      if (frames < minimum) blockers.push(`bookends.transitions.${id}.durationSeconds-too-short-for-fps`);
    }
    const resolved = await resolveNarratedBookendMedia(config.bookends, channelPackDir);
    blockers.push(...resolved.blockers);
    config.bookends.media = resolved.media;
  }
  // 品質ループの上限（目標点・回数・時間・費用・停滞）。無ければ Core の既定。
  // 評価項目と下限は Pack から変えさせない（lib/narratedStoryQualityLoop.mjs）。
  const qualityLoop = normalizeNarratedQualityLoopConfig(source.qualityLoop);
  blockers.push(...qualityLoop.blockers);
  config.qualityLoop = qualityLoop.limits;
  // 役ごとの声（lib/narratedStoryCast.mjs）。語りの役の声は voice のまま。
  const cast = normalizeNarratedCastConfig(source.cast, { narratorVoice: config.voice });
  blockers.push(...cast.blockers);
  config.cast = cast.config;
  // 声の品質ゲートの撮り直しの上限（lib/narratedStoryVoiceQuality.mjs）。
  const voiceQuality = normalizeNarratedVoiceQualityConfig(source.voiceQuality);
  blockers.push(...voiceQuality.blockers);
  config.voiceQuality = voiceQuality.config;
  // BGM の区分ごとの曲（lib/narratedStoryMusicPlan.mjs）。無ければ music.prompt の1曲。
  const musicPlan = await normalizeNarratedMusicPlanConfig(source.musicPlan, { channelPackDir });
  blockers.push(...musicPlan.blockers);
  config.musicPlan = musicPlan.config;
  // 台本の受け口（Markdown の見出しの宣言。lib/narratedStoryScriptPackage.mjs）。
  const scriptIntake = normalizeNarratedScriptIntakeConfig(source.scriptIntake);
  blockers.push(...scriptIntake.blockers);
  config.scriptIntake = scriptIntake.config;
  // 見た目の宣言（焼き込み字幕など。lib/narratedStoryVisuals.mjs）。
  const visuals = await loadNarratedVisualConfig(source, { render: config.render, channelPackDir });
  blockers.push(...visuals.blockers);
  Object.assign(config, visuals.config);
  // Pack の作者が「未確定」と宣言したもの（受領していない曲、権利根拠の無い声、未提供の
  // 人物素材など）。埋めずに宣言させ、有料生成の前に止める。
  config.declaredBlockers = [];
  if (source.blockers !== undefined) {
    if (!Array.isArray(source.blockers)) blockers.push("blockers");
    else {
      for (const entry of source.blockers) {
        const id = stableId(entry?.id, "");
        if (!id || !nonEmpty(entry?.what)) blockers.push("blockers.entry");
        else config.declaredBlockers.push(id);
      }
    }
  }
  return { ok: blockers.length === 0, path, blockers: [...new Set(blockers)], config };
}

/** Deterministic Japanese sentence segmentation without ICU-version variance. */
export function splitNarratedStoryScript(raw) {
  const text = String(raw ?? "").replaceAll("\r", "").trim();
  if (!text) return [];
  const output = [];
  for (const line of text.split(/\n+/u).map((entry) => entry.trim()).filter(Boolean)) {
    let current = "";
    let terminalSeen = false;
    for (const character of line) {
      if (terminalSeen && !CLOSING_PUNCTUATION.test(character)) {
        if (current.trim()) output.push(current.trim());
        current = "";
        terminalSeen = false;
      }
      current += character;
      if (TERMINAL_PUNCTUATION.test(character)) terminalSeen = true;
    }
    if (current.trim()) output.push(current.trim());
  }
  return output.map((entry, index) => ({
    id: `s${String(index + 1).padStart(3, "0")}`,
    order: index,
    text: entry,
    textHash: sha256(entry),
    characterCount: [...entry].length,
  }));
}

/**
 * 台本を本編と感想パートの segment に分け、有料生成の前に人の判断が要る点を返す。
 * - bookends の感想パートは Pack が宣言した区切り行の後ろ。区切りが無い・重複している台本は止める
 * - 「運営者の差し替え必須」印（本人の実体験で差し替える一人称の文など）が残った台本は、
 *   声にも字幕にもせず止める（最終監査の operatorReplacementCleared でも再確認する）
 * pipeline と plan-only の preflight が同じ判定を使う（判定を 2 か所に持たない）。
 */
export function planNarratedStoryScript(script, config) {
  const bookends = config?.bookends || { enabled: false };
  const partition = partitionNarratedStoryScript(script, bookends);
  if (partition.blockers.length > 0) {
    return {
      stage: "script-partition",
      issues: partition.blockers.map((item) => `script-structure-required:${item}`),
      storySegments: [],
      reviewSegments: [],
    };
  }
  const storySegments = splitNarratedStoryScript(partition.bodyText).map((segment) => ({ ...segment, part: "story" }));
  const reviewSegments = bookends.enabled && bookends.review
    ? splitNarratedStoryScript(partition.reviewText).map((segment, index) => ({
      ...segment,
      id: `r${String(index + 1).padStart(3, "0")}`,
      order: storySegments.length + index,
      part: "review",
    }))
    : [];
  const unreplaced = operatorReplacementSegments([...storySegments, ...reviewSegments], {
    extraMarker: bookends.review?.operatorReplacementMarker || "",
  });
  return {
    stage: unreplaced.length ? "operator-replacement" : "",
    issues: unreplaced.map((id) => `operator-replacement-required:${id}`),
    storySegments,
    reviewSegments,
  };
}

/**
 * 画が要る場面の id（台本の順）。台本パッケージでは場面（imageKey = story[].id / review[].id）に1枚、
 * 生テキストでは文（s001…）に1枚。人物素材を Pack が供給する感想パートは画を使わない。
 */
export function narratedSceneImageKeys(segments = [], { presenterReview = false } = {}) {
  const keys = new Set();
  for (const segment of segments) {
    // 感想の文の見た目（reviewVisual。lib/narratedStoryVisuals.mjs）が付いていれば、画が要るのは images の文だけ。
    if (segment.part === "review" && (segment.reviewVisual ? segment.reviewVisual !== "images" : presenterReview)) continue;
    keys.add(segment.imageKey || segment.id);
  }
  return [...keys];
}

/**
 * 運営者の画の取り込みの検査（lib/operatorImageImport.mjs）を、この台本の場面に当てる。
 * pipeline と plan-only の preflight が同じ判定を使う（判定を 2 か所に持たない）。
 */
async function checkNarratedOperatorImages({ config, manifest, storySegments = [], reviewSegments = [], projectDir = "" }) {
  const presenterReview = reviewSegments.length > 0 && Boolean(config.bookends?.media?.["review.presenter.video"]);
  const sceneIds = narratedSceneImageKeys([...storySegments, ...reviewSegments], { presenterReview });
  const approved = await resolveApprovedReferenceSha256s({ policy: config.imageImport, projectDir });
  const checked = await checkOperatorImageImport({
    manifest,
    sceneIds,
    target: { width: config.render.width, height: config.render.height },
    // 品質ループの合格は、Pack の requireAssetLoopPass に関わらずジャンルの関門
    // （lib/narratedStoryAssetLoops.mjs。止まると awaiting-human-review）が監査契約 v5 から必ず見る。
    // 取り込みの検査の側でも見ると、同じ未合格が別の状態（awaiting-operator-input）と別の理由コードで二度出る。
    policy: { ...config.imageImport, requireAssetLoopPass: false },
    approvedReferences: approved.approved,
  });
  return { checked, sceneIds, issues: [...new Set([...approved.problems, ...checked.issues])] };
}

/** 運営者の画の取り込みの検査に通った行を、本編の画の工程（scene-image）の対象にする。 */
function narratedOperatorSceneLoopSubjects(checked) {
  return (checked?.scenes || []).map(({ sceneId, row }) => operatorSceneLoopSubject(sceneId, row));
}

/**
 * plan-only の preflight（有料 API も provider probe も呼ばない、読むだけ）。検証済み Pack の
 * narrated-story.json と台本から、有料生成の前に止まる理由を全部まとめて返す。pipeline は最初の
 * 理由で止まるが、ここでは運営者へまとめて示すために全段を並べる。
 * 運営者の画を取り込む Pack なら、manifest（Job の options.operatorImageManifestPath）も読んで検査する。
 * 台本の品質ループの答え（監査契約 v8 から）も、Job の options.scriptQualityWorkDir（無ければ台本のあるフォルダ）で
 * 問い、pipeline と同じ理由コード（script-quality-required:<理由>）と次のコマンドを返す。
 */
export async function inspectNarratedStoryPlan({ scriptPath, channelPackDir, operatorImageManifestPath = "", operatorVideoManifestPath = "", scriptQualityWorkDir = "", projectDir = "", ffprobe = null } = {}) {
  const loaded = await loadNarratedStoryChannelConfig(channelPackDir);
  const blockers = [];
  if (!loaded.ok) blockers.push(...loaded.blockers.map((item) => `channel-pack-config-required:${item}`));
  // 台本の品質ループ（Pack に依らない）。pipeline と同じ関門を、start に渡した元の台本で問う。
  const scriptQuality = await gateNarratedScriptQuality({
    contractVersion: NARRATED_STORY_AUDIT_CONTRACT_VERSION,
    scriptPath,
    workDir: scriptQualityWorkDirFor({ options: nonEmpty(scriptQualityWorkDir) ? { scriptQualityWorkDir } : {}, scriptPath }),
    commandScriptPath: scriptPath,
  });
  blockers.push(...scriptQuality.issues);
  const config = loaded.config || null;
  blockers.push(...(config?.declaredBlockers || []).map((id) => `channel-pack-declared-blocker:${id}`));
  let segments = { story: 0, review: 0 };
  let scriptInput = null;
  let operatorImages = null;
  if (config) {
    const script = (await readFile(resolve(String(scriptPath || "")), "utf8")).replaceAll("\r", "").trim();
    const plan = planNarratedStoryInput({ script, scriptPath, config, planRawScript: planNarratedStoryScript });
    blockers.push(...plan.issues);
    segments = { story: plan.storySegments.length, review: plan.reviewSegments.length };
    // 感想の文の見た目の出どころ（人物の映像は Pack の素材か、回ごとの映像の枠を宣言していれば有るものとして数える）。
    if (loaded.ok) {
      annotateNarratedReviewVisuals({
        config,
        reviewSegments: plan.reviewSegments,
        presenterAvailable: Boolean(config.bookends?.media?.["review.presenter.video"] || config.bookends?.review?.presenter?.episodeVideo),
      });
    }
    scriptInput = plan.input || null;
    // 見た目（焼き込み字幕の書体に無い字・収まらない行など）を台本に当てて、描けない理由を先に並べる。
    if (loaded.ok) blockers.push(...(await checkNarratedVisualPlan({ config, segments: [...plan.storySegments, ...plan.reviewSegments] })).issues);
    // 運営者の動画（回ごとの OP 映像など）は読むだけで検査する（写さない）。尺と寸法は ffprobe があるときだけ測る。
    if (loaded.ok) {
      const videos = await prepareNarratedOperatorVideos({
        config,
        manifestPath: operatorVideoManifestPath,
        ffprobe: ffprobe || (await resolveFfmpegToolchain().catch(() => null))?.ffprobe || null,
        materialize: false,
      });
      blockers.push(...videos.issues);
      // 運営者の動画は有料の処理の前に品質ループ（工程 video-clip。監査契約 v7 から）の合格を見られる。
      if (videos.issues.length === 0 && videos.loopSubjects.length > 0) {
        const loops = await gateNarratedAssetLoops({ contractVersion: NARRATED_STORY_AUDIT_CONTRACT_VERSION, videos: videos.loopSubjects });
        blockers.push(...loops.issues);
      }
    }
    if (config.imageImport) {
      const manifest = await readOperatorImageManifest({ manifestPath: operatorImageManifestPath });
      if (!nonEmpty(operatorImageManifestPath)) blockers.push(...manifest.problems);
      else if (plan.storySegments.length > 0) {
        const operator = await checkNarratedOperatorImages({
          config,
          manifest,
          storySegments: plan.storySegments,
          reviewSegments: plan.reviewSegments,
          projectDir,
        });
        blockers.push(...operator.issues);
        operatorImages = { scenes: operator.sceneIds.length, manifestSha256: manifest.manifestSha256 || null };
        // 運営者の画は有料の処理の前に品質ループの合格を見られる（broker の画は生成の後でしか見られない）。
        if (operator.checked.scenes.length > 0) {
          const loops = await gateNarratedAssetLoops({ scenes: narratedOperatorSceneLoopSubjects(operator.checked) });
          blockers.push(...loops.issues);
        }
      }
    } else if (nonEmpty(operatorImageManifestPath)) {
      blockers.push("operator-image-manifest-unexpected");
    }
  }
  return {
    ok: blockers.length === 0,
    blockers: [...new Set(blockers)],
    bookendsEnabled: config?.bookends?.enabled === true,
    imageSource: config?.image?.source || "broker",
    ...(operatorImages ? { operatorImages } : {}),
    ...(scriptQuality.summary ? { scriptQuality: scriptQuality.summary } : {}),
    segments,
    scriptInput,
    paidCallsAttempted: false,
  };
}

async function payloadIdentity(root) {
  const absoluteRoot = resolve(String(root || ""));
  const rootInfo = await lstat(absoluteRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("--channel-pack-dir must be the verified payload directory.");
  }
  const files = [];
  const walk = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error("Verified Channel Pack payload must not contain symlinks.");
      if (info.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!info.isFile()) throw new Error("Verified Channel Pack payload contains an unsupported entry.");
      const bytes = await readFile(path);
      files.push({
        path: `payload/${relative(absoluteRoot, path).split(sep).join("/")}`,
        bytes: info.size,
        sha256: sha256(bytes),
      });
    }
  };
  await walk(absoluteRoot);
  if (files.length === 0) throw new Error("Verified Channel Pack payload is empty.");
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { sha256: sha256(canonicalJson(files)), fileCount: files.length };
}

export async function inspectNarratedStoryInputs({ scriptPath, channelPackDir } = {}) {
  if (!scriptPath) throw new Error("full requires --script-path.");
  if (!channelPackDir) throw new Error("full requires --channel-pack-dir from the verified outer envelope.");
  const absoluteScript = resolve(String(scriptPath));
  const scriptInfo = await lstat(absoluteScript);
  if (!scriptInfo.isFile() || scriptInfo.isSymbolicLink() || scriptInfo.size === 0) {
    throw new Error("Raw Japanese script must be a non-empty regular file.");
  }
  const scriptBytes = await readFile(absoluteScript);
  if (!scriptBytes.toString("utf8").trim()) throw new Error("Raw Japanese script is blank.");
  return {
    script: { sha256: sha256(scriptBytes), bytes: scriptInfo.size },
    channelPack: await payloadIdentity(channelPackDir),
  };
}

function formatSrtTime(seconds, { floor = false } = {}) {
  // 終わりの時刻は切り捨てる。四捨五入で映像尺（-t）を 1ms でも越えると、mux が最後の字幕を
  // 丸ごと落とす（2026-09-24 実測: 尺 6.791667s に対し 6.792 で終わる最後の cue が消えた）。
  const scaled = Number(seconds) * 1000;
  const total = Math.max(0, floor ? Math.floor(scaled + 1e-6) : Math.round(scaled));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const secs = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

export function buildNarratedStorySrt(segments) {
  return segments.map((segment, index) => [
    String(index + 1),
    `${formatSrtTime(segment.startSeconds)} --> ${formatSrtTime(segment.endSeconds, { floor: true })}`,
    segment.text,
    "",
  ].join("\n")).join("\n");
}

async function runRuntime(spec, args, { cwd, timeout = 10 * 60_000 } = {}) {
  if (!spec?.command) throw new Error("A resolved executable is required.");
  return execFile(spec.command, [...(spec.args || []), ...args], {
    cwd,
    timeout,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
}

async function mapLimit(values, limit, worker) {
  const output = new Array(values.length);
  let next = 0;
  let failure = null;
  const run = async () => {
    for (;;) {
      if (failure) return;
      const index = next;
      next += 1;
      if (index >= values.length) return;
      try {
        output[index] = await worker(values[index], index);
      } catch (error) {
        if (!failure) failure = error;
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, run));
  if (failure) throw failure;
  return output;
}

function expectedMagic(kind, bytes) {
  if (kind === "image.generation") {
    return bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  return bytes.length > 44 && bytes.subarray(0, 4).toString("ascii") === "RIFF";
}

async function acquireMediaArtifact({ runner, spec, outputPath, mimeType }) {
  const identity = paidMediaRequestIdentity(spec);
  const sidecarPath = `${outputPath}.media-job.json`;
  const previous = await readJsonIfPresent(sidecarPath).catch(() => null);
  if (previous?.requestKey === identity.requestKey
    && previous?.inputHash === identity.inputHash
    && await artifactRecordValid(previous.artifact)
    && resolve(previous.artifact.path) === resolve(outputPath)) {
    return { path: resolve(outputPath), receipt: receiptSafeMediaJobs([previous.receipt])[0], cached: true };
  }
  const requested = { ...spec, requestKey: identity.requestKey };
  const generated = await runner(requested);
  const bytes = Buffer.isBuffer(generated?.bytes)
    ? generated.bytes
    : Buffer.from(generated?.bytes || []);
  if (!expectedMagic(spec.kind, bytes)) {
    throw new Error(`${spec.kind} media job returned an invalid ${mimeType} artifact.`);
  }
  const digest = sha256(bytes);
  const rawReceipt = generated.receipt
    || (generated.job ? paidMediaJobReceiptSummary(generated.job) : null);
  if (!rawReceipt) throw new Error(`${spec.kind} media job did not return a receipt.`);
  for (const [field, expected] of Object.entries({
    kind: spec.kind,
    provider: spec.provider,
    model: spec.model,
    adapterVersion: spec.adapterVersion,
    ...(spec.voiceId ? { voiceId: spec.voiceId } : {}),
  })) {
    if (nonEmpty(rawReceipt[field]) !== nonEmpty(expected)) {
      throw new Error(`${spec.kind} media job receipt has a mismatched ${field}.`);
    }
  }
  if (!nonEmpty(rawReceipt.jobId) || !nonEmpty(rawReceipt.providerJobId)) {
    throw new Error(`${spec.kind} media job receipt must include internal and provider job IDs.`);
  }
  // 課金されていない失敗の送り直しは同じ入力の鍵の系列（<requestKey>:rN）で行うので、それだけは受ける。
  if (rawReceipt.requestKey && !requestKeyInChain(rawReceipt.requestKey, identity.requestKey)) {
    throw new Error(`${spec.kind} media job receipt is bound to a different requestKey.`);
  }
  if (rawReceipt.inputHash && rawReceipt.inputHash !== identity.inputHash) {
    throw new Error(`${spec.kind} media job receipt is bound to a different inputHash.`);
  }
  const receipt = receiptSafeMediaJobs([{
    ...rawReceipt,
    requestKey: nonEmpty(rawReceipt.requestKey) || identity.requestKey,
    inputHash: identity.inputHash,
    adapterVersion: rawReceipt.adapterVersion || spec.adapterVersion,
    status: "completed",
    artifact: { ...rawReceipt.artifact, sha256: digest, mimeType, bytes: bytes.length },
  }])[0];
  await writeAtomic(outputPath, bytes);
  const artifact = await artifactRecord(outputPath);
  await writeAtomic(sidecarPath, {
    version: "buzzassist-narrated-story-media-sidecar-v1",
    requestKey: identity.requestKey,
    inputHash: identity.inputHash,
    artifact,
    receipt,
  }, { json: true });
  return { path: resolve(outputPath), receipt, cached: false };
}

// 実行器は lib/narratedStoryMediaRunner.mjs（recovery-required と課金されていない失敗を決着させてから送る）。
export { createBrokerMediaJobRunner };

function mediaSpec({ kind, provider, model, adapterVersion, voiceId = "", input, output, reservation }) {
  return { kind, provider, model, adapterVersion, voiceId, input, output, reservation };
}

// Fish Audio's documented WAV sample-rate set currently tops out at 44.1 kHz.
// The render graph resamples every voice stem to the 48 kHz master timeline, so
// request the provider-native lossless rate explicitly rather than sending an
// impossible 48 kHz request or silently changing it server-side.
export function narratedVoiceOutputProfile(provider) {
  return {
    format: "wav",
    sampleRate: String(provider || "").trim().toLowerCase() === "fish-audio" ? 44_100 : 48_000,
    channels: 1,
  };
}

function safeMediaFailure(error) {
  return {
    name: nonEmpty(error?.name) || "Error",
    code: nonEmpty(error?.code),
    status: finite(error?.status),
    charged: error?.charged === true ? true : (error?.charged === false ? false : null),
    mediaJob: error?.job ? receiptSafeMediaJobs([error.job])[0] || null : null,
  };
}

function mediaFailureIssue(error) {
  const safe = safeMediaFailure(error);
  return `media-job-failure:${safe.code || safe.status || safe.name}`;
}

async function probeMedia(ffprobe, path) {
  const { stdout } = await runRuntime(ffprobe, [
    "-v", "error",
    "-show_entries", "format=duration:stream=index,codec_type,codec_name,width,height,duration,sample_rate,channels",
    "-of", "json",
    path,
  ]);
  return JSON.parse(stdout);
}

function durationFromProbe(probe) {
  return Math.max(0, finite(probe?.format?.duration, 0));
}

/**
 * 字幕だけの文（台本パッケージの captionOnlySeconds）の声の代わりの無音（48kHz mono）。声の Media Job ではない
 * ので受領記録は持たず、無音の sha256 だけを残す。
 */
async function makeCaptionOnlySilence(ffmpeg, segment, voiceDir) {
  const path = join(voiceDir, `${segment.id}.caption-only.wav`);
  const samples = Math.max(1, Math.round(segment.captionOnlySeconds * 48_000));
  await runRuntime(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono",
    "-af", `atrim=end_sample=${samples}`, "-c:a", "pcm_s16le", path,
  ]);
  return { type: "voice", segmentId: segment.id, path, receipt: null, silenceSha256: await fileSha256(path) };
}

async function makeVoiceStem(ffmpeg, paths, outputPath) {
  // 文ごとの声を 48kHz mono でつなぐ。文が多くコマンド行の上限に当たるときは塊に分けてつなぐ
  // （lib/ffmpegSequenceRender.mjs。1回で収まれば今までと同じ graph）。
  return concatAudioSequence({ ffmpeg, paths, outputPath, workDir: `${outputPath}.chunks`, sampleRate: 48_000, channelLayout: "mono", label: "voice" });
}

async function makeBgmStem(ffmpeg, sourcePath, durationSeconds, gain, outputPath) {
  const filterGraph = `aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${gain.toFixed(5)}`;
  await runRuntime(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y", "-stream_loop", "-1", "-i", sourcePath,
    "-t", durationSeconds.toFixed(6),
    "-af", filterGraph,
    "-c:a", "pcm_s16le", outputPath,
  ]);
  return { filterGraph, inputCount: 1, outputMap: "audio:0" };
}

async function makeMasterAudio(ffmpeg, voicePath, bgmPath, outputPath, { linear = false } = {}) {
  const mix = "[0:a]aresample=48000,pan=stereo|c0=c0|c1=c0[voice];"
    + "[1:a]aresample=48000[bed];"
    + "[voice][bed]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,";
  let loudnorm = "loudnorm=I=-14:TP=-1.5:LRA=11";
  if (linear) {
    // bookends の番組は 2 pass の線形正規化にする。1 pass の dynamic モードは lead-in や転換の
    // 静かな区間で利得を上げ下げするので、境目の BGM の音量が語りとの相対で決まらなくなる。
    // 1 pass 目で測った値を渡し、線形の利得 1 本で -14 LUFS に合わせる（TP を守れないときは
    // loudnorm 自身が dynamic へ戻る）。
    const { stderr } = await runRuntime(ffmpeg, [
      "-hide_banner", "-nostats", "-i", voicePath, "-i", bgmPath,
      "-filter_complex", `${mix}loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json[measure]`,
      "-map", "[measure]", "-f", "null", "-",
    ]);
    const block = [...String(stderr).matchAll(/\{[\s\S]*?"input_i"[\s\S]*?\}/gu)].at(-1)?.[0];
    const measured = block ? JSON.parse(block) : null;
    const value = (key) => finite(measured?.[key]);
    if (!measured || [value("input_i"), value("input_tp"), value("input_lra"), value("input_thresh"), value("target_offset")].some((item) => item === null)) {
      throw new Error("loudnorm measurement pass did not report the program loudness.");
    }
    loudnorm += `:measured_I=${value("input_i")}:measured_TP=${value("input_tp")}:measured_LRA=${value("input_lra")}`
      + `:measured_thresh=${value("input_thresh")}:offset=${value("target_offset")}:linear=true`;
  }
  const filterGraph = `${mix}${loudnorm},aresample=48000[master]`;
  await runRuntime(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y", "-i", voicePath, "-i", bgmPath,
    "-filter_complex", filterGraph,
    "-map", "[master]", "-c:a", "pcm_s16le", outputPath,
  ]);
  return { filterGraph, inputCount: 2, outputMap: "[master]" };
}

async function renderPreview(ffmpeg, segments, masterAudioPath, srtPath, config, outputPath, { subtitleLayer = null } = {}) {
  // 文のフレーム数は声の実尺の累積で丸める（字幕の頁と同じ時間割）。同じ画が続く文は1つのショットとして
  // 1つの動きで通す（lib/narratedStoryCamera.mjs。文ごとに寄りを始め直さない）。場面の画は bookends の
  // 本編と同じ描き方（lib/narratedStoryBookends.mjs の renderSegmentImagesPart: 場面の切り替えの宣言と、
  // コマンド行の上限を越えない塊に分けた描画）で1本の動画にしてから、音と字幕を載せる。
  const framePlan = segmentFramePlan(segments.map((segment) => segment.durationSeconds), config.render.fps);
  const story = await renderSegmentImagesPart({
    ffmpeg,
    segments: segments.map((segment, index) => ({ ...segment, part: segment.part || "story", partStartFrame: framePlan[index].startFrame, frames: framePlan[index].frames })),
    config,
    outputPath: join(dirname(outputPath), "story-video.mp4"),
  });
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", join(dirname(outputPath), "story-video.mp4"), "-i", masterAudioPath, "-i", srtPath];
  // 焼き込み字幕の層（concat の一覧）は最後の入力。
  if (subtitleLayer) args.push("-f", "concat", "-i", subtitleLayer.listPath);
  const filters = [`[0:v]concat=n=1:v=1:a=0[${subtitleLayer ? "story" : "video"}]`];
  if (subtitleLayer) filters.push(subtitleOverlayGraph({ inputIndex: 3, input: "story", output: "video" }));
  const filterGraph = filters.join(";");
  args.push(
    "-filter_complex", filterGraph,
    "-map", "[video]", "-map", "1:a:0", "-map", "2:s:0",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-c:a", "aac", "-b:a", "192k", "-c:s", "mov_text", "-metadata:s:s:0", "language=jpn",
    "-t", segments.at(-1).endSeconds.toFixed(6), "-movflags", "+faststart", outputPath,
  );
  await runRuntime(ffmpeg, args, { timeout: 30 * 60_000 });
  return {
    storyVideo: story.graph,
    preview: {
      filterGraph,
      imageInputCount: 1,
      shotCount: story.shots.length,
      videoMap: "[video]",
      audioMap: "1:a:0",
      subtitleMap: "2:s:0",
    },
  };
}

/**
 * bookends の番組を描く。部（OP・本編・感想）を映像だけで描き、境目クリップ（出る側の
 * 最終フレーム → 転換 → 入る側の最初のフレームの字幕なし lead-in）を挟んで concat する。
 * 音は番組全体の voice stem と BGM stem を作り、既存の master（[voice][bed] amix + loudnorm）で混ぜる。
 */
async function renderBookendProgramFromPlan({
  toolchain,
  config,
  plan,
  workDir,
  openingRender,
  musicPath,
  voiceStemPath,
  bgmStemPath,
  masterAudioPath,
  srtPath,
  outputPath,
  subtitleLayer = null,
  reviewLayout = null,
  reviewPresenterPath = "",
}) {
  const { ffmpeg } = toolchain;
  const bookends = config.bookends;
  const renderGraphs = {};
  const partPaths = {};
  if (openingRender) {
    partPaths.opening = join(workDir, "part-opening.mp4");
    renderGraphs.openingVideo = openingRender.graph;
  }
  const storySegments = plan.segments.filter((segment) => segment.part === "story");
  partPaths.story = join(workDir, "part-story.mp4");
  renderGraphs.storyVideo = (await renderSegmentImagesPart({
    ffmpeg, segments: storySegments, config, outputPath: partPaths.story,
  })).graph;
  const reviewPart = plan.parts.find((part) => part.id === "review");
  if (reviewPart) {
    partPaths.review = join(workDir, "part-review.mp4");
    renderGraphs.reviewVideo = reviewLayout
      ? (await renderNarratedReviewLayoutPart({
        ffmpeg,
        config,
        reviewLayout,
        reviewSegments: plan.segments.filter((segment) => segment.part === "review"),
        presenterPath: reviewPresenterPath,
        outputPath: partPaths.review,
      })).graph
      : reviewPart.visual === "presenter-video"
      ? (await renderPresenterPart({
        ffmpeg,
        presenterPath: reviewPresenterPath,
        frames: reviewPart.frames,
        backgroundColor: bookends.review.presenter.backgroundColor,
        config,
        outputPath: partPaths.review,
      })).graph
      : (await renderSegmentImagesPart({
        ffmpeg, segments: plan.segments.filter((segment) => segment.part === "review"), config, outputPath: partPaths.review,
      })).graph;
  }
  const clipPaths = [];
  for (const part of plan.parts) {
    const boundary = plan.boundaries.find((entry) => entry.incomingPart === part.id);
    if (boundary) {
      const outgoing = plan.parts.find((entry) => entry.id === boundary.outgoingPart);
      const stillOutgoing = join(workDir, `${boundary.id}-outgoing.png`);
      const stillIncoming = join(workDir, `${boundary.id}-incoming.png`);
      await extractPartFrame({ ffmpeg, videoPath: partPaths[outgoing.id], frameIndex: outgoing.frames - 1, outputPath: stillOutgoing });
      await extractPartFrame({ ffmpeg, videoPath: partPaths[part.id], frameIndex: 0, outputPath: stillIncoming });
      const clipPath = join(workDir, `transition-${boundary.id}.mp4`);
      renderGraphs[`transition:${boundary.id}`] = await renderTransitionClip({
        ffmpeg, boundary, stillOutgoing, stillIncoming, config, outputPath: clipPath,
      });
      clipPaths.push(clipPath);
    }
    clipPaths.push(partPaths[part.id]);
  }
  const voicePaths = Object.fromEntries(plan.segments.map((segment) => [segment.id, segment.voicePath]));
  renderGraphs.voiceStem = await makeBookendVoiceStem({ ffmpeg, plan, voicePaths, outputPath: voiceStemPath });
  renderGraphs.bgmStem = await makeBookendBedStem({
    ffmpeg,
    plan,
    storyMusicPath: musicPath,
    storyGain: config.music.gain,
    reviewMusicPath: bookends.media?.["review.music"] || "",
    reviewGain: bookends.review?.musicGain ?? config.music.gain,
    openingAudioPath: bookends.media?.["opening.audio"] || openingRender?.embeddedAudio || "",
    outputPath: bgmStemPath,
  });
  renderGraphs.masterAudio = await makeMasterAudio(ffmpeg, voiceStemPath, bgmStemPath, masterAudioPath, { linear: true });
  renderGraphs.preview = await renderBookendProgram({ ffmpeg, clipPaths, masterAudioPath, srtPath, plan, outputPath, subtitleLayer });
  return renderGraphs;
}

/** generation manifest に残す bookend の記録。台本の文・OP の文言・色は残さない（時刻・種類・素材 SHA だけ）。 */
async function bookendManifestEntry(plan, bookends) {
  const media = {};
  for (const [label, path] of Object.entries(bookends.media || {})) media[label] = { sha256: await fileSha256(path) };
  return {
    version: plan.version,
    fps: plan.fps,
    totalFrames: plan.totalFrames,
    totalSeconds: plan.totalSeconds,
    parts: plan.parts.map(({ id, startFrame, frames, visual }) => ({ id, startFrame, frames, visual })),
    boundaries: plan.boundaries.map((boundary) => ({
      id: boundary.id,
      type: boundary.type,
      outgoingPart: boundary.outgoingPart,
      incomingPart: boundary.incomingPart,
      effectStartFrame: boundary.effectStartFrame,
      effectFrames: boundary.effectFrames,
      leadFrames: boundary.leadFrames,
      incomingStartFrame: boundary.incomingStartFrame,
      outgoingFadeSeconds: boundary.outgoingFadeSeconds,
    })),
    openingKind: bookends.opening?.kind || null,
    media,
  };
}

async function makeContactSheet(ffmpeg, videoPath, durationSeconds, outputPath) {
  const rate = Math.max(0.1, 3 / Math.max(0.1, durationSeconds));
  await runRuntime(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y", "-i", videoPath,
    "-vf", `fps=${rate.toFixed(8)},scale=320:-2,tile=3x1`,
    "-frames:v", "1", outputPath,
  ]);
}

async function measureMeanVolume(ffmpeg, path, interval = null) {
  const trim = interval
    ? `atrim=start=${Number(interval.startSeconds).toFixed(6)}:end=${Number(interval.endSeconds).toFixed(6)},asetpts=PTS-STARTPTS,`
    : "";
  const { stderr } = await runRuntime(ffmpeg, [
    "-hide_banner", "-nostats", "-i", path, "-af", `${trim}volumedetect`, "-f", "null", "-",
  ]);
  const matches = [...String(stderr).matchAll(/mean_volume:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*dB/giu)];
  return matches.length ? finite(matches.at(-1)[1], -Infinity) : -Infinity;
}

async function measureLoudness(ffmpeg, path) {
  const { stderr } = await runRuntime(ffmpeg, [
    "-hide_banner", "-nostats", "-i", path,
    "-af", "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-",
  ]);
  const blocks = [...String(stderr).matchAll(/\{[\s\S]*?"input_i"[\s\S]*?\}/gu)];
  if (!blocks.length) return { integratedLufs: null, truePeakDbfs: null };
  const parsed = JSON.parse(blocks.at(-1)[0]);
  return {
    integratedLufs: finite(parsed.input_i),
    truePeakDbfs: finite(parsed.input_tp),
  };
}

async function fullDecode(ffmpeg, path) {
  const { stderr } = await runRuntime(ffmpeg, ["-hide_banner", "-v", "error", "-xerror", "-i", path, "-f", "null", "-"], {
    timeout: 30 * 60_000,
  });
  // 終了コードが0でも、誤りの報告があれば壊れているとみなす（漫画側と同じ判定）。
  const verdict = fullDecodeVerdict({ stderr });
  if (!verdict.pass) throw new Error(`全デコードで誤りが報告された: ${verdict.detail.slice(0, 300)}`);
  return true;
}

async function frameMd5(ffmpeg, path, seconds) {
  const { stdout } = await runRuntime(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-i", path,
    "-ss", Math.max(0, seconds).toFixed(6), "-frames:v", "1", "-an", "-f", "md5", "-",
  ]);
  const match = String(stdout).match(/MD5=([a-f0-9]{32})/iu);
  return match?.[1]?.toLowerCase() || "";
}

function check(pass, detail, evidence = {}) {
  return { pass: pass === true, detail: String(detail), ...evidence };
}

/**
 * 場面の画の出どころの監査の id。ハーネス宣言（config/harnesses/narrated-story-video.harness.json）の
 * 保証 scene-image-provenance の証拠（監査契約 v5 から）。最終化はこの監査も pass でなければ進まない。
 */
export const NARRATED_SCENE_IMAGE_PROVENANCE_AUDIT_ID = "sceneImageProvenance";

/** 描いた場面の画の sha256（有料の Media Job の受領記録か、運営者の画の取り込みの記録から）。 */
function sceneImageSha256(entry) {
  return entry?.receipt?.artifact?.sha256 || entry?.operatorImport?.sha256 || null;
}

/** Job・Receipt・Canvas へ出してよい画の出どころの要約（件数と sha256 だけ）。 */
function narratedImageSourceSummary(operatorImages) {
  if (!operatorImages?.publicRecord) return { kind: "broker" };
  const record = operatorImages.publicRecord;
  return {
    kind: "operator-file",
    manifestSha256: record.manifestSha256,
    digest: record.digest,
    sceneCount: record.sceneCount,
    routes: record.routes,
    paidMediaJobs: 0,
    costBasis: OPERATOR_IMAGE_COST_BASIS,
  };
}

/**
 * 描いた場面の画のファイルを読み直し、出どころの記録と sha256 で結び付いていることを確かめる。
 * - broker: 完了した image.generation の Media Job の受領記録の artifact と同じ
 * - operator-file: 取り込みの記録（元の画の sha256・合わせ方・合わせた画の sha256）と同じで、画の Media Job が 0 件
 */
async function sceneImageProvenanceCheck({ sceneIds, byKey, operatorImages, mediaJobs }) {
  const problems = [];
  const scenes = [];
  const imported = new Map((operatorImages?.publicRecord?.scenes || []).map((row) => [row.sceneId, row]));
  const paidImageJobs = mediaJobs.filter((receipt) => receipt?.kind === "image.generation");
  for (const sceneId of sceneIds) {
    const entry = byKey.get(`image:${sceneId}`);
    if (!entry?.path) { problems.push(`${sceneId}:image-missing`); continue; }
    let fileSha = "";
    try { fileSha = await fileSha256(entry.path); } catch { fileSha = ""; }
    if (operatorImages) {
      const row = imported.get(sceneId);
      if (!row || entry.receipt || !entry.operatorImport) problems.push(`${sceneId}:not-imported`);
      else if (fileSha !== entry.operatorImport.sha256 || row.normalized?.sha256 !== fileSha) problems.push(`${sceneId}:imported-sha-mismatch`);
      scenes.push({ sceneId, imageSha256: fileSha, sourceSha256: row?.source?.sha256 || null, route: row?.route || null, fit: row?.fit?.method || null });
    } else {
      const receipt = entry.receipt;
      if (receipt?.kind !== "image.generation" || receipt?.status !== "completed") problems.push(`${sceneId}:media-job-missing`);
      else if (receipt.artifact?.sha256 !== fileSha) problems.push(`${sceneId}:media-job-sha-mismatch`);
      scenes.push({ sceneId, imageSha256: fileSha, requestKey: receipt?.requestKey || null });
    }
  }
  if (operatorImages && paidImageJobs.length > 0) problems.push("paid-image-media-job-present");
  const source = operatorImages ? "operator-file" : "broker";
  const pass = sceneIds.length > 0 && problems.length === 0;
  const routes = operatorImages?.publicRecord?.routes || {};
  const detail = !pass
    ? `scene image provenance failed: ${problems.join(", ") || "no scene images"}`
    : (operatorImages
      ? `${sceneIds.length} scene images imported from operator files (routes: ${Object.entries(routes).map(([route, count]) => `${route}×${count}`).join(", ")}); 0 paid image Media Jobs — operator external contract; normalized SHA-256 re-read from disk`
      : `${sceneIds.length} scene images came from completed image.generation Media Jobs whose artifact SHA-256 matches the rendered files`);
  return check(pass, detail, {
    source,
    paidImageMediaJobs: paidImageJobs.length,
    ...(operatorImages ? { manifestSha256: operatorImages.publicRecord.manifestSha256, costBasis: OPERATOR_IMAGE_COST_BASIS } : {}),
    scenes,
    problems,
  });
}

/**
 * Inspect the exact FFmpeg filter graphs that were handed to the runtime.
 * Keeping this pure makes the negative cases testable: an `xfade` or
 * `acrossfade` mutation must turn the corresponding audit red.
 */
export function inspectNarratedStoryRenderGraphs(renderGraphs = {}, segmentCount = 0, { shotCount = segmentCount, sceneJoins = [], fps = 24 } = {}) {
  const renderFilterGraph = nonEmpty(renderGraphs?.preview?.filterGraph);
  const graphEvidence = Object.fromEntries(Object.entries(renderGraphs || {}).map(([name, value]) => [name, {
    filterGraphSha256: sha256(String(value?.filterGraph || "")),
    inputCount: finite(value?.inputCount ?? value?.imageInputCount, 0),
    outputMap: nonEmpty(value?.outputMap ?? value?.videoMap),
  }]));
  // 場面の画を別に描いた形（storyVideo。lib/narratedStoryBookends.mjs の renderSegmentImagesPart）では、組み立ては
  // その1本に音と字幕を載せるだけ。場面の間は storyVideo の graph で見る（宣言した crossfade の xfade だけを許す）。
  // storyVideo の無い旧い形は、組み立ての graph の中でショットごとの入力を concat する。
  const story = renderGraphs?.storyVideo || null;
  const assembledClips = story ? 1 : shotCount;
  const sceneGraph = story ? inspectNarratedSceneVideoGraph(story, { shotCount, joins: sceneJoins, fps }) : { ok: true, problems: [] };
  // 画はショット（同じ画が続く文のまとまり）ごとの入力で、声と字幕は文ごと。
  const expectedVideoConcat = `concat=n=${assembledClips}:v=1:a=0[video]`;
  const transitionFilterPresent = /(?:^|[;,])\s*(?:x?fade|blend|tblend)(?:=|[;,])/iu.test(renderFilterGraph);
  const requiredGraphNames = ["voiceStem", "bgmStem", "masterAudio", "preview"];
  const allFilterGraphs = requiredGraphNames.map((name) => String(renderGraphs?.[name]?.filterGraph || ""));
  const acrossfadeEvidenceComplete = allFilterGraphs.every(Boolean);
  const acrossfadeGraphs = Object.entries(renderGraphs || {})
    .filter(([, value]) => /(?:^|[;,])\s*acrossfade(?:=|[;,])/iu.test(String(value?.filterGraph || "")))
    .map(([name]) => name);
  return {
    graphEvidence,
    expectedVideoConcat,
    expectedAudioMap: `${assembledClips}:a:0`,
    transitionFilterPresent,
    sceneGraphProblems: sceneGraph.problems,
    sceneTransitionOwnedByParent: Boolean(renderFilterGraph)
      && renderGraphs?.preview?.imageInputCount === assembledClips
      && renderGraphs?.preview?.videoMap === "[video]"
      // 焼き込み字幕があれば、場面の concat の出力に字幕の層を overlay で1回だけ重ねて [video] にする。
      && videoConcatAssembled(renderFilterGraph, { count: assembledClips, label: "story" })
      && !transitionFilterPresent
      && sceneGraph.ok,
    parentAudioMapped: Boolean(renderGraphs?.voiceStem?.filterGraph)
      && renderGraphs.voiceStem.inputCount === segmentCount
      && renderGraphs.voiceStem.outputMap === "[voice]"
      // 塊に分けてつないだ声は、塊ごとの concat の和が文の数（lib/ffmpegSequenceRender.mjs）。
      && (renderGraphs.voiceStem.chunks ? audioSequenceConcatenates(renderGraphs.voiceStem, segmentCount) : renderGraphs.voiceStem.filterGraph.includes(`concat=n=${segmentCount}:v=0:a=1[voice]`))
      && Boolean(renderGraphs?.masterAudio?.filterGraph)
      && renderGraphs.masterAudio.inputCount === 2
      && renderGraphs.masterAudio.outputMap === "[master]"
      && renderGraphs.masterAudio.filterGraph.includes("[voice][bed]amix=inputs=2")
      && renderGraphs?.preview?.audioMap === `${assembledClips}:a:0`,
    acrossfadeEvidenceComplete,
    acrossfadeGraphs,
    noWholeProgramAcrossfade: acrossfadeEvidenceComplete && acrossfadeGraphs.length === 0,
  };
}

async function automaticAudit({ ffmpeg, ffprobe, previewPath, voiceStemPath, bgmStemPath, expectedDuration, segments, config, hashes, renderGraphs, bookendPlan = null, renderedSegments = [], boundaryExcludeRegion = null, cameraShotCount = segments.length, sceneJoins = [] }) {
  const beforeVoiceHash = await fileSha256(voiceStemPath);
  const probe = await probeMedia(ffprobe, previewPath);
  await fullDecode(ffmpeg, previewPath);
  const afterVoiceHash = await fileSha256(voiceStemPath);
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const video = streams.find((entry) => entry.codec_type === "video");
  const audio = streams.find((entry) => entry.codec_type === "audio");
  const subtitle = streams.find((entry) => entry.codec_type === "subtitle");
  const duration = durationFromProbe(probe);
  const videoDuration = finite(video?.duration, duration);
  const audioDuration = finite(audio?.duration, duration);
  const loudness = await measureLoudness(ffmpeg, previewPath);
  // 語りと BGM の差は、声のある文だけで測る（字幕だけの文は語りが無い）。
  const voicedIntervals = segments.filter((segment) => !segment.captionOnly);
  const intervalSeparation = await mapLimit(voicedIntervals, Math.min(4, voicedIntervals.length), async (segment) => {
    const interval = { startSeconds: segment.startSeconds, endSeconds: segment.endSeconds };
    const voiceMeanDb = await measureMeanVolume(ffmpeg, voiceStemPath, interval);
    const bgmMeanDb = await measureMeanVolume(ffmpeg, bgmStemPath, interval);
    return {
      id: segment.id,
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds,
      voiceMeanDb,
      bgmMeanDb,
      separationDb: voiceMeanDb - bgmMeanDb,
    };
  });
  const separationDb = Math.min(...intervalSeparation.map((entry) => entry.separationDb));
  const movingSegments = segments.filter((segment) => segment.camera !== "presenter-video" && segment.camera !== "static");
  const staticSegmentCount = segments.filter((segment) => segment.camera === "static").length;
  const presenterSegmentCount = segments.length - movingSegments.length - staticSegmentCount;
  const cameraFrames = await mapLimit(movingSegments, Math.min(4, movingSegments.length), async (segment) => {
    const frameSeconds = 1 / config.render.fps;
    const startSeconds = segment.startSeconds + Math.min(frameSeconds * 0.25, segment.endSeconds - segment.startSeconds);
    const middleSeconds = (segment.startSeconds + segment.endSeconds) / 2;
    const endSeconds = Math.max(startSeconds, segment.endSeconds - frameSeconds * 1.25);
    const hashes = await Promise.all([
      frameMd5(ffmpeg, previewPath, startSeconds),
      frameMd5(ffmpeg, previewPath, middleSeconds),
      frameMd5(ffmpeg, previewPath, endSeconds),
    ]);
    return {
      id: segment.id,
      camera: segment.camera,
      startSeconds,
      middleSeconds,
      endSeconds,
      frameMd5: { start: hashes[0], middle: hashes[1], end: hashes[2] },
      motionObserved: hashes.every(Boolean) && new Set(hashes).size >= 2,
    };
  });
  const graphAudit = bookendPlan
    ? inspectNarratedBookendRenderGraphs(renderGraphs, bookendPlan, { sceneTransition: config.sceneTransition || null })
    : inspectNarratedStoryRenderGraphs(renderGraphs, segments.length, { shotCount: cameraShotCount, sceneJoins, fps: config.render.fps });
  // 境目の実測は完成 MP4（と、それへ mux した voice stem）を decode して行う。
  const bookendMeasurement = bookendPlan
    // 焼き込み字幕の範囲は、字幕の出入りを転換と取り違えないように外して測る（字幕は別の監査が測る）。
    ? await measureNarratedBookendBoundaries({ ffmpeg, ffprobe, videoPath: previewPath, voiceStemPath, plan: bookendPlan, excludeRegion: boundaryExcludeRegion, render: config.render })
    : null;
  const checks = pendingNarratedStoryAuditChecks("automatic-audit");
  checks.audioIntegratedLoudness = check(
    loudness.integratedLufs !== null
      && Math.abs(loudness.integratedLufs - (-14)) <= 0.5
      && loudness.truePeakDbfs !== null
      && loudness.truePeakDbfs <= -1.5,
    `I=${loudness.integratedLufs} LUFS, TP=${loudness.truePeakDbfs} dBFS`,
    loudness,
  );
  checks.narrationBedSeparation = check(
    intervalSeparation.length > 0
      && intervalSeparation.every((entry) => Number.isFinite(entry.separationDb) && entry.separationDb >= 6),
    `minimum per-utterance voice/bed separation ${separationDb} dB across ${intervalSeparation.length} intervals`,
    { minimumSeparationDb: separationDb, intervals: intervalSeparation },
  );
  checks.duration = check(
    Math.abs(duration - expectedDuration) <= Math.max(1 / config.render.fps, expectedDuration * 0.03),
    `actual=${duration}s expected=${expectedDuration}s`,
    { actualSeconds: duration, expectedSeconds: expectedDuration },
  );
  checks.frozenV1AndParentHashes = check(
    Object.values(hashes).every((value) => /^[a-f0-9]{64}$/u.test(String(value || ""))),
    "script, Channel Pack and generated parent artifacts are SHA-256-bound",
  );
  checks.parentAudioPcmPreserved = check(
    beforeVoiceHash === afterVoiceHash
      && beforeVoiceHash === hashes.voiceStem
      && graphAudit.parentAudioMapped,
    `voice stem remained ${afterVoiceHash}; master audio map=${graphAudit.graphEvidence.preview?.outputMap || "missing"}/${renderGraphs?.preview?.audioMap || "missing"}`,
    {
      voiceStemSha256: afterVoiceHash,
      expectedVoiceStemSha256: hashes.voiceStem,
      expectedAudioMap: graphAudit.expectedAudioMap,
      renderGraphs: graphAudit.graphEvidence,
    },
  );
  checks.pixelAudit = check(
    video?.width === config.render.width
      && video?.height === config.render.height
      && Boolean(subtitle)
      && (movingSegments.length > 0 || staticSegmentCount > 0)
      && cameraFrames.length === movingSegments.length
      && cameraFrames.every((entry) => entry.motionObserved),
    `video=${video?.width || 0}x${video?.height || 0}, subtitle=${subtitle?.codec_name || "missing"}, `
      + `moving segments=${cameraFrames.filter((entry) => entry.motionObserved).length}/${cameraFrames.length}`
      + `${presenterSegmentCount ? `, presenter-video segments=${presenterSegmentCount}` : ""}, fullDecode=pass`,
    { cameraPlan: "camera-shots", staticSegments: staticSegmentCount, frames: cameraFrames },
  );
  checks.sceneTransitionOwnedByParent = check(
    graphAudit.sceneTransitionOwnedByParent,
    bookendPlan
      ? `bookend graphs: ${graphAudit.problems.join(", ") || "scene cuts are concat-only; transitions only in the declared boundary clips"}`
      : `parent graph=${graphAudit.graphEvidence.preview?.filterGraphSha256 || "missing"}, concat=${graphAudit.expectedVideoConcat}, transitionFilter=${graphAudit.transitionFilterPresent}${graphAudit.sceneGraphProblems?.length ? `, scenes=${graphAudit.sceneGraphProblems.join("+")}` : ""}`,
    { renderGraphs: graphAudit.graphEvidence },
  );
  if (bookendMeasurement) {
    const audioProblems = [
      ...bookendMeasurement.audio.boundaries.flatMap((entry) => entry.problems.map((problem) => `${entry.id}:${problem}`)),
      ...bookendMeasurement.audio.end.problems.map((problem) => `end:${problem}`),
    ];
    checks.audioBoundaryBreathV16 = check(
      bookendMeasurement.audio.pass,
      bookendMeasurement.audio.pass
        ? `measured ${bookendMeasurement.audio.boundaries.length} boundaries on the MP4: narration tails intact, no dead air, caption-free lead-in carries bed only, next narration and first caption start together, no clipping, frame/audio ends match the plan`
        : `boundary audio failed: ${audioProblems.join(", ")}`,
      { measurement: bookendMeasurement.audio, narrationReferenceDb: bookendMeasurement.narrationReferenceDb },
    );
    const visualProblems = bookendMeasurement.visual.boundaries.flatMap((entry) => entry.problems.map((problem) => `${entry.id}:${problem}`));
    checks.bookendTransitionMeasured = check(
      bookendMeasurement.visual.pass,
      bookendMeasurement.visual.pass
        ? `declared transitions observed in the MP4 frames: ${bookendMeasurement.visual.boundaries.map((entry) => `${entry.id}=${entry.type}`).join(", ")}`
        : `transition not observed as declared: ${visualProblems.join(", ")}`,
      { measurement: bookendMeasurement.visual },
    );
  } else {
    const detail = config.bookends.enabled
      ? "bookends are enabled but no bookend program plan was rendered"
      : "Channel Pack disables bookends; the rendered program is a single story part with no OP/review boundary";
    checks.audioBoundaryBreathV16 = check(config.bookends.enabled === false, detail);
    checks.bookendTransitionMeasured = check(config.bookends.enabled === false, detail);
  }
  // 実際に声と字幕にした文に「差し替え必須」印が残っていないこと（印は有料生成前にも止めている）。
  const unreplaced = operatorReplacementSegments(renderedSegments, {
    extraMarker: config.bookends.review?.operatorReplacementMarker || "",
  });
  checks.operatorReplacementCleared = check(
    renderedSegments.length > 0 && unreplaced.length === 0,
    renderedSegments.length === 0
      ? "rendered segment list is unavailable"
      : (unreplaced.length ? `operator replacement still required: ${unreplaced.join(", ")}` : `${renderedSegments.length} rendered segments carry no operator-replacement marker`),
    { unreplacedSegmentIds: unreplaced },
  );
  checks.noWholeProgramAcrossfade = check(
    graphAudit.noWholeProgramAcrossfade,
    graphAudit.acrossfadeEvidenceComplete
      ? `${Object.keys(graphAudit.graphEvidence).length} executed filter graphs contain no acrossfade filter (${Object.values(graphAudit.graphEvidence).map((entry) => entry.filterGraphSha256).join(",")})`
      : "executed filter-graph evidence is incomplete",
    { renderGraphs: graphAudit.graphEvidence, acrossfadeGraphs: graphAudit.acrossfadeGraphs },
  );
  const avDelta = Math.abs(videoDuration - audioDuration);
  checks.avEndSync = check(avDelta <= 0.12, `video=${videoDuration}s audio=${audioDuration}s delta=${avDelta}s`, { avDeltaSeconds: avDelta });
  return { checks, probe, loudness, separationDb, durationSeconds: duration };
}

/**
 * signoff 本文の検査。`documentOk` は「この Job のこの成果物を、独立した文脈の reviewer が
 * 原寸で見た記録として形が正しい」こと（品質ループの回にしてよいか）。`ok` はそれに加えて
 * reviewer が承認した（approved: true・findings 無し）こと（目視の監査を pass にしてよいか）。
 * 差し戻し（approved: false）は findings が1件以上あるときだけ正しい形とみなす。
 */
function validateExternalSignoff(signoff, { jobId, videoSha256, contactSheetSha256 }) {
  const problems = [];
  if (signoff?.version !== NARRATED_STORY_SIGNOFF_VERSION) problems.push("signoff-version");
  if (!nonEmpty(signoff?.reviewer)) problems.push("signoff-reviewer");
  const context = nonEmpty(signoff?.reviewerContextId);
  if (!context || context === jobId || context === `production:${jobId}`) problems.push("independent-reviewer-context");
  if (signoff?.videoSha256 !== videoSha256) problems.push("signoff-video-sha");
  if (signoff?.contactSheetSha256 !== contactSheetSha256) problems.push("signoff-contact-sheet-sha");
  if (signoff?.originalDetailReviewed !== true) problems.push("original-detail-review-required");
  const findings = Array.isArray(signoff?.findings) ? signoff.findings : null;
  const knownIssues = Array.isArray(signoff?.knownRemainingIssues) ? signoff.knownRemainingIssues : null;
  if (signoff?.approved !== true && signoff?.approved !== false) problems.push("signoff-verdict");
  if (!findings || (signoff?.approved === true && findings.length > 0)) problems.push("signoff-findings");
  if (!knownIssues || (signoff?.approved === true && knownIssues.length > 0)) problems.push("signoff-known-issues");
  if (signoff?.approved === false && findings && findings.length === 0) problems.push("signoff-rejection-findings-required");
  const documentOk = problems.length === 0;
  if (documentOk && signoff?.approved !== true) problems.push("signoff-not-approved");
  return {
    ok: problems.length === 0,
    documentOk,
    problems,
    reviewer: nonEmpty(signoff?.reviewer),
    reviewerContextId: context,
  };
}

/**
 * ジャンル側 finalizer でも reviewer attestation を検証する（R3-5）。共通 Receipt と
 * 同じ verifyNarratedReviewSignoff を、Job の真値（jobId / identityDigest）と disk から
 * 計算した MP4・contact sheet の SHA で呼ぶ。信頼リストが読めない、identityDigest が
 * 渡っていない、といった監査側の欠落も理由コードとして残し、pass にしない。
 * signoff file がまだ無い場合は attestation 段へ進まない（本文検査の問題だけ残す）。
 */
async function verifySignoffAttestation(signoff, {
  jobId,
  identityDigest,
  videoSha256,
  contactSheetSha256,
  reviewerTrust = null,
  reviewerTrustPath = "",
  env = process.env,
}) {
  const result = { pass: false, failures: [], signerKeyId: "", reviewerLabel: "", trustSha256: "" };
  if (!signoff || typeof signoff !== "object" || Array.isArray(signoff)) {
    result.failures.push("signoff-missing");
    return result;
  }
  let trust = null;
  try {
    trust = await loadReviewerTrust({ trust: reviewerTrust, trustPath: reviewerTrustPath, env });
  } catch (error) {
    result.failures.push(reviewerTrustFailureCode(error));
  }
  const digest = nonEmpty(identityDigest);
  if (!SHA256_HEX.test(digest)) {
    // 期待 subject の材料が無い: 署名 subject の不正とは別コード（R2-S5）。
    result.failures.push("reviewer-attestation-expected-subject-unavailable:identityDigest");
  }
  const verified = verifyNarratedReviewSignoff(signoff, {
    jobId,
    identityDigest: digest,
    videoSha256,
    contactSheetSha256,
    trust,
  });
  result.signerKeyId = verified.signerKeyId;
  result.reviewerLabel = verified.reviewerLabel;
  result.trustSha256 = verified.trustSha256;
  result.failures = [...new Set([...result.failures, ...verified.failures])];
  result.pass = result.failures.length === 0;
  return result;
}

function applyPerceptualChecks(checks, validation, evidence) {
  const detail = validation.ok
    ? `independent SHA-bound signoff: ${validation.reviewer} (${validation.reviewerContextId})`
    : (validation.documentOk
      ? `independent reviewer asked for changes: ${validation.reviewer} (${validation.reviewerContextId})`
      : `pending/invalid independent signoff: ${validation.problems.join(", ") || "missing"}`);
  return {
    ...checks,
    perceptualReviewChecks: check(validation.ok, detail, evidence),
    perceptualReviewBoundToOutput: check(validation.ok, detail, evidence),
    perceptualEvidenceHashes: check(validation.ok, detail, evidence),
    contactSheetOriginalDetailReviewed: check(validation.ok, detail, evidence),
  };
}

function failedAuditIds(checks) {
  return Object.entries(checks).filter(([, value]) => value?.pass !== true).map(([id]) => id);
}

async function collectArtifacts(paths) {
  const output = {};
  for (const [kind, path] of Object.entries(paths)) output[kind] = await artifactRecord(path);
  return output;
}

async function collectCachedMediaJobs(runDir) {
  const receipts = [];
  const walk = async (directory) => {
    let entries = [];
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".media-job.json")) {
        const sidecar = await readJsonIfPresent(path).catch(() => null);
        if (sidecar?.receipt) receipts.push(sidecar.receipt);
      }
    }
  };
  await walk(join(runDir, "media"));
  return receiptSafeMediaJobs(receipts);
}

async function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

async function withPipelineLock(runDir, action, recovery = 0) {
  const path = join(runDir, ".pipeline.lock");
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`);
  } catch (error) {
    if (error?.code === "EEXIST" && recovery === 0) {
      const owner = await readJsonIfPresent(path).catch(() => null);
      if (owner && !await processAlive(Number(owner.pid))) {
        await rm(path, { force: true });
        return withPipelineLock(runDir, action, recovery + 1);
      }
    }
    throw new Error("The same narrated-story job is already running; duplicate media submission is blocked.");
  }
  let heartbeat = null;
  const timer = setInterval(() => {
    if (heartbeat) return;
    heartbeat = writeFile(path, `${JSON.stringify({ pid: process.pid, heartbeatAt: new Date().toISOString() })}\n`, { mode: 0o600 })
      .catch(() => {})
      .finally(() => { heartbeat = null; });
  }, 5_000);
  timer.unref?.();
  try {
    return await action();
  } finally {
    clearInterval(timer);
    if (heartbeat) await heartbeat;
    await handle?.close();
    await rm(path, { force: true });
  }
}

function outcomeFromReadyState(state, {
  knownRemainingIssues,
  auditChecks,
  runReceiptPath = null,
  status = "awaiting-human-review",
  artifacts = state.artifacts,
  assetQualityLoop = null,
} = {}) {
  return buildNarratedStoryOutcome({
    // 途中の成果物の品質ループの再照合で止まったときだけ、何が足りないか（工程・対象・理由）を載せる。
    ...(assetQualityLoop ? { assetQualityLoop } : {}),
    version: NARRATED_STORY_PIPELINE_VERSION,
    status,
    jobId: state.jobId,
    inputs: state.inputs,
    runtimeMetadata: state.runtimeMetadata,
    adapterProbes: state.adapterProbes,
    execution: state.execution,
    // 画の出どころ（broker か、運営者の画の取り込みか）。件数と sha256 だけ。
    imageSource: state.imageSource || { kind: "broker" },
    review: state.review,
    artifacts,
    knownRemainingIssues,
    mediaJobs: state.mediaJobs,
    auditChecks,
    runReceiptPath,
  });
}

/** この Job の有料 Media Job の費用の合計（品質ループの費用の上限に数える）。 */
function mediaJobsCost(mediaJobs = []) {
  return mediaJobs.reduce((sum, receipt) => {
    const cost = Number(receipt?.usage?.cost);
    return sum + (Number.isFinite(cost) && cost > 0 && receipt?.usage?.freeRegeneration !== true ? cost : 0);
  }, 0);
}

/**
 * ready state を作った監査契約の版。production は auditContractVersion を残す。それより前の state には印が
 * 無いので、production が書いた自動監査の報告（state が SHA で拘束している成果物）の版で測る。どちらも
 * 読めなければ今の版（関門を要る側）に倒す。
 */
async function readyStateContractVersion(state) {
  const declared = nonEmpty(state?.auditContractVersion);
  if (declared) return declared;
  const reportPath = nonEmpty(state?.artifacts?.auditReport?.path);
  const report = reportPath ? await readJsonIfPresent(reportPath).catch(() => null) : null;
  return nonEmpty(report?.contractVersion) || NARRATED_STORY_AUDIT_CONTRACT_VERSION;
}

function qualityLoopSummary(check) {
  return {
    status: check.status,
    stopReason: check.stopReason,
    rounds: check.rounds,
    score: check.score,
    targetScore: check.targetScore,
    floorFailures: check.floorFailures,
    failureFingerprint: check.failureFingerprint,
    contractDigest: check.contractDigest,
    stateSha256: check.stateSha256,
  };
}

async function finalizeReadyState({
  state,
  statePath,
  signoffPath,
  ffmpeg,
  qualityContract,
  deploymentRoot = "",
  revisionDelta = "",
  now = () => new Date().toISOString(),
  identityDigest = "",
  reviewerTrust = null,
  reviewerTrustPath = "",
  env = process.env,
}) {
  const video = state.artifacts?.previewVideo;
  const sheet = state.artifacts?.contactSheet;
  const runDir = dirname(statePath);
  // reviewer が採点に使う契約の写し。production より後に契約が入った state でも、
  // 再開のたびに今の契約へ揃える（写しが古いと reviewer が別の項目で採点してしまう）。
  const reviewSheet = narratedQualityReviewSheet(qualityContract, runDir);
  if (canonicalJson(state.review?.quality || null) !== canonicalJson(reviewSheet)) {
    state.review = { ...(state.review || {}), requiredVersion: NARRATED_STORY_SIGNOFF_VERSION, quality: reviewSheet };
    await writeAtomic(statePath, state, { json: true });
  }
  // 監査は、この state を作った監査契約の版で測る（当時無かった関門を後から求めない）。
  const contractVersion = await readyStateContractVersion(state);
  let productionChecks = state.auditChecks;
  if (narratedAssetLoopsRequired(contractVersion)) {
    // 描いた画と採用したテイクが、今も品質ループに合格した版のままか（人が否とした・始め直した・ファイルが
    // 差し替わった、を確定の前に見る）。落ちたら signoff と品質ループには触れずに止める（回を消費しない）。
    const assetLoops = await reverifyNarratedAssetLoops({ runDir, plan: state.assetQualityLoop, generatorContextId: `production:${state.jobId}` });
    productionChecks = { ...state.auditChecks, ...assetLoops.checks };
    // 動画クリップの監査は、それが入った契約（v7）以降の state だけに求める。
    const loopAuditIds = [
      ...NARRATED_ASSET_LOOP_AUDIT_IDS,
      ...(narratedVideoClipLoopsRequired(contractVersion) ? [NARRATED_VIDEO_CLIP_LOOP_AUDIT_ID] : []),
    ];
    if (!assetLoops.pass) {
      return outcomeFromReadyState(state, {
        knownRemainingIssues: [...new Set([
          ...assetLoops.issues,
          ...loopAuditIds.filter((id) => productionChecks[id]?.pass !== true).map((id) => `audit-${id}-pending-or-failed`),
        ])],
        auditChecks: productionChecks,
        assetQualityLoop: assetLoops.summary,
      });
    }
  }
  const signoff = await readJsonIfPresent(signoffPath).catch(() => null);
  const validation = validateExternalSignoff(signoff, {
    jobId: state.jobId,
    videoSha256: video?.sha256,
    contactSheetSha256: sheet?.sha256,
  });
  // 本文検査が通っても、信頼リスト上の active な reviewer 鍵で Job・成果物へ結合された
  // 署名が無ければ pass にしない。共通 Receipt と同じ検証器を使い、判定を 2 箇所で
  // 食い違わせない（audit report は pass・Receipt は拒否、という状態を作らない）。
  const attestation = await verifySignoffAttestation(signoff, {
    jobId: state.jobId,
    identityDigest,
    videoSha256: video?.sha256,
    contactSheetSha256: sheet?.sha256,
    reviewerTrust,
    reviewerTrustPath,
    env,
  });
  if (!attestation.pass) {
    validation.ok = false;
    validation.documentOk = false;
    validation.problems = [...new Set([...validation.problems, ...attestation.failures])];
  }
  const signoffSha256 = validation.documentOk ? await fileSha256(signoffPath) : "";
  const perceptualChecks = applyPerceptualChecks(productionChecks, validation, {
    signoffPath: resolve(signoffPath),
    signoffSha256,
    videoSha256: video?.sha256 || "",
    contactSheetSha256: sheet?.sha256 || "",
  });
  // 品質ループの回は、署名と SHA の検査を通った signoff（承認でも差し戻しでも）からだけ作る。
  // 合格しない限り final-audited にしない。人の判断が要る状態は例外ではなく issues で返る。
  const quality = await advanceNarratedQualityLoop({
    contract: qualityContract,
    jobId: state.jobId,
    runDir,
    signoff: validation.documentOk ? signoff : null,
    signoffPath: resolve(signoffPath),
    signoffSha256,
    documentValid: validation.documentOk,
    auditChecks: perceptualChecks,
    video: { path: video?.path || "", sha256: video?.sha256 || "" },
    contactSheet: { path: sheet?.path || "", sha256: sheet?.sha256 || "" },
    roundCost: mediaJobsCost(state.mediaJobs),
    revisionDelta,
    // 直した出力は別の Job になるので、前の Job のループは同じ配備 root の下から読む。
    predecessorStatePath: (predecessorJobId) => narratedQualityPaths(
      narratedStoryRunPaths({ deploymentRoot, jobId: predecessorJobId }).runDir,
    ).statePath,
    now,
  });
  const auditChecks = {
    ...perceptualChecks,
    [NARRATED_QUALITY_AUDIT_ID]: quality.check,
    // 人物の同一性: 合格した回の署名済み独立レビューが、評価項目 character-identity を下限以上で採点したこと。
    [NARRATED_CHARACTER_IDENTITY_AUDIT_ID]: narratedCharacterIdentityCheck({
      contract: qualityContract,
      qualityCheck: quality.check,
      signoff: validation.ok ? signoff : null,
      signoffSha256,
      video,
      contactSheet: sheet,
    }),
  };
  const failures = failedAuditIds(auditChecks);
  if (failures.length > 0) {
    // 失敗理由を audit report にも残す（outcome の detail だけに置かない）。
    // report の SHA が変わるので state の artifact 記録も同時に更新する。
    const artifacts = await recordSignoffRejectionInAuditReport(state, statePath, {
      signoffPath,
      signoffPresent: Boolean(signoff),
      problems: validation.problems,
      qualityLoop: qualityLoopSummary(quality.check),
    });
    return outcomeFromReadyState(state, {
      knownRemainingIssues: [...new Set([
        ...failures.map((id) => `audit-${id}-pending-or-failed`),
        ...quality.issues,
      ])],
      auditChecks,
      artifacts,
    });
  }
  // 確定は1つの transaction（lib/fileTransaction.mjs）: 完成 MP4・監査の報告・Receipt・状態ファイルを
  // 置き場へ全部書いてから入れ替える。途中で落ちても「報告だけ pass・状態は古い」を残さない。
  // 確定（commit）の前に例外で抜けた置き場は journal を持たないので、次の実行が状態を読む前に
  // recoverFileTransactions が捨てる。確定の後に落ちた置き場は、同じ所でやり切る。
  const finalPath = join(dirname(video.path), "final-audited.mp4");
  const txn = await openFileTransaction(runDir, { label: "narrated-finalize" });
  const finalStaged = await txn.stageCopy(finalPath, video.path);
  await fullDecode(ffmpeg, finalStaged);
  const artifacts = { ...state.artifacts, finalVideo: await txn.record(finalPath) };
  const auditPath = state.artifacts.auditReport.path;
  await txn.stageJson(auditPath, {
    version: NARRATED_STORY_AUDIT_VERSION,
    contractVersion,
    status: "pass",
    jobId: state.jobId,
    videoSha256: artifacts.finalVideo.sha256,
    contactSheetSha256: artifacts.contactSheet.sha256,
    auditChecks,
    imageSource: state.imageSource || { kind: "broker" },
    knownRemainingIssues: [],
    independentSignoff: {
      path: resolve(signoffPath),
      sha256: signoffSha256,
      reviewer: validation.reviewer,
      reviewerContextId: validation.reviewerContextId,
      reviewerAttestation: {
        signerKeyId: attestation.signerKeyId,
        reviewerLabel: attestation.reviewerLabel,
        trustSha256: attestation.trustSha256,
      },
    },
    qualityLoop: qualityLoopSummary(quality.check),
  });
  artifacts.auditReport = await txn.record(auditPath);
  const receiptPath = join(dirname(auditPath), "run-receipt.json");
  await txn.stageJson(receiptPath, {
    version: NARRATED_STORY_RUN_RECEIPT_VERSION,
    status: "final-audited",
    contractVersion,
    jobId: state.jobId,
    inputs: state.inputs,
    runtimeMetadata: state.runtimeMetadata,
    adapterProbes: state.adapterProbes,
    providerVersions: [...new Map(state.mediaJobs.map((receipt) => [
      `${receipt.provider}:${receipt.adapterVersion}`,
      { provider: receipt.provider, adapterVersion: receipt.adapterVersion, model: receipt.model },
    ])).values()],
    mediaJobs: receiptSafeMediaJobs(state.mediaJobs),
    // 運営者の画は有料の Media Job に数えない。経路と「運営者の外部の契約」として残す（sha256 だけ）。
    imageSource: state.imageSource || { kind: "broker" },
    auditChecks,
    artifacts: Object.fromEntries(Object.entries(artifacts).map(([kind, artifact]) => [kind, {
      path: artifact.path,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
    }])),
    reviewerAttestation: {
      signerKeyId: attestation.signerKeyId,
      trustSha256: attestation.trustSha256,
    },
    qualityLoop: qualityLoopSummary(quality.check),
    knownRemainingIssues: [],
  });
  artifacts.runReceipt = await txn.record(receiptPath);
  const completed = {
    ...state,
    phase: "final-audited",
    auditChecks,
    artifacts,
    runReceiptPath: receiptPath,
    completedAt: new Date().toISOString(),
  };
  // 状態ファイルは最後に入れ替える（journal の順）。ここまでが1つの確定。
  await txn.stageJson(statePath, completed);
  await txn.commit();
  return outcomeFromReadyState(completed, {
    status: "final-audited",
    artifacts,
    knownRemainingIssues: [],
    auditChecks,
    runReceiptPath: receiptPath,
  });
}

/**
 * signoff が無い／拒否された理由を automatic-audit.json の independentSignoff に残す。
 * status は pass にしない。内容が前回と同じなら書き直さない（SHA の無駄な揺れを防ぐ）。
 */
async function recordSignoffRejectionInAuditReport(state, statePath, { signoffPath, signoffPresent, problems, qualityLoop = null }) {
  const auditPath = state.artifacts?.auditReport?.path;
  if (!auditPath) return state.artifacts;
  const report = await readJsonIfPresent(auditPath).catch(() => null);
  if (!report || typeof report !== "object" || report.status === "pass") return state.artifacts;
  const independentSignoff = {
    path: resolve(signoffPath),
    status: signoffPresent ? "rejected" : "pending",
    problems: [...problems],
  };
  if (canonicalJson(report.independentSignoff || null) === canonicalJson(independentSignoff)
    && canonicalJson(report.qualityLoop || null) === canonicalJson(qualityLoop)) return state.artifacts;
  // 報告と状態ファイル（報告の SHA を持つ）を1つの確定で入れ替える。片方だけ書けた状態を残すと、
  // 状態が報告の SHA と合わず、次の実行が ready state を再利用できずに描き直しからやり直す。
  const txn = await openFileTransaction(dirname(statePath), { label: "narrated-signoff-rejection" });
  await txn.stageJson(auditPath, { ...report, independentSignoff, qualityLoop });
  const artifacts = { ...state.artifacts, auditReport: await txn.record(auditPath) };
  await txn.stageJson(statePath, { ...state, artifacts });
  await txn.commit();
  state.artifacts = artifacts;
  return artifacts;
}

async function readyStateIsReusable(state, inputs) {
  if (state?.version !== NARRATED_STORY_PIPELINE_VERSION
    || state.inputs?.script?.sha256 !== inputs.script.sha256
    || state.inputs?.channelPack?.sha256 !== inputs.channelPack.sha256
    // 運営者の画は実測の sha256 から作った digest で束縛する。manifest を直さずに画だけ差し替えても
    // 別の入力になり、作り直す（broker の Job はどちらも持たない）。
    || canonicalJson(state.inputs?.operatorImages || null) !== canonicalJson(inputs.operatorImages || null)
    || canonicalJson(state.inputs?.operatorVideos || null) !== canonicalJson(inputs.operatorVideos || null)
    || !["awaiting-human-review", "final-audited"].includes(state.phase)) return false;
  const artifacts = Object.values(state.artifacts || {});
  if (artifacts.length === 0) return false;
  return (await Promise.all(artifacts.map(artifactRecordValid))).every(Boolean);
}

/**
 * Job workspace の配置。production と reviewer CLI（signoff）が同じ場所を指すための
 * 唯一の定義。signoffPath を明示すればそれを優先する。
 */
export function narratedStoryRunPaths({ deploymentRoot = process.cwd(), jobId, signoffPath = "" } = {}) {
  const id = stableId(jobId, "narrated-story-job");
  const runDir = join(resolve(deploymentRoot), ".media", NARRATED_STORY_HARNESS_ID, id);
  return {
    runDir,
    statePath: join(runDir, "pipeline-state.json"),
    signoffPath: nonEmpty(signoffPath) ? resolve(signoffPath) : join(runDir, "review", "contact-sheet-signoff.json"),
  };
}

/**
 * 独立 reviewer が contact sheet を確認した後に、署名付き signoff を書く。生成側は
 * これを呼ばない。署名ロジックは lib/koyaReviewAttestation.mjs の
 * signNarratedReviewSignoff だけで、ここでは本文を組み、MP4 / contact sheet の SHA を
 * disk から計算し、書き出すだけ。identityDigest は呼び出し側（CLI）が durable Job から
 * 読んで渡す。既存 signoff は force 無しで上書きしない。
 *
 * 採点（review / reviewPath）は必須: { rubricScores, notes, findings }。評価項目は
 * pipeline state の review.quality（その Job の品質契約の写し）から取る。`pass` は承認
 * （findings 無し）、`fail` は差し戻し（findings 1件以上）で、どちらか1つを明示する。
 * 差し戻しも品質ループの1回として記録される。
 */
export async function writeNarratedReviewSignoff({
  deploymentRoot = process.cwd(),
  jobId,
  identityDigest,
  reviewerHost = "",
  reviewerId = "",
  reviewerContextId,
  videoPath = "",
  contactSheetPath = "",
  signoffPath = "",
  outputPath = "",
  reviewerPrivateKeyPath = "",
  reviewerPrivateKeyPem = "",
  reviewerTrust = null,
  reviewerTrustPath = "",
  env = process.env,
  pass = false,
  fail = false,
  review = null,
  reviewPath = "",
  force = false,
  signedAt = new Date().toISOString(),
} = {}) {
  const id = nonEmpty(jobId);
  if (!id) throw new Error("signoff requires --job-id of the durable outer Job.");
  if (!SHA256_HEX.test(nonEmpty(identityDigest))) {
    throw new Error("reviewer-attestation-expected-subject-unavailable:identityDigest — signoff requires the durable Job's identityDigest (read from the Job, not typed by hand).");
  }
  if ((pass === true) === (fail === true)) {
    throw new Error("Signoff requires exactly one of --pass (approve) or --fail (ask for changes), and only after the MP4 and contact sheet have actually been inspected at original detail.");
  }
  let reviewInput = review;
  if (!reviewInput) {
    if (!nonEmpty(reviewPath)) {
      throw new Error("quality-review-required: signoff needs --review-path FILE with { rubricScores, notes, findings } scored against the Job's review.quality rubric.");
    }
    try {
      reviewInput = JSON.parse(await readFile(resolve(reviewPath), "utf8"));
    } catch (error) {
      throw new Error(`quality-review-invalid: the review file could not be read as JSON (${error?.code || error?.name || "error"}).`);
    }
  }
  const host = nonEmpty(reviewerHost).toLowerCase();
  if (host && !["claude", "codex"].includes(host)) throw new Error("--reviewer must be claude or codex.");
  const contextId = nonEmpty(reviewerContextId);
  if (!contextId || contextId.length < 8) {
    throw new Error("--reviewer-context-id must identify the real reviewer Codex task / Claude session (8+ chars).");
  }
  if (contextId === id || contextId === `production:${id}`) {
    throw new Error("independent-reviewer-context: the reviewer context must differ from the production Job.");
  }
  const reviewer = nonEmpty(reviewerId) || (host ? `${host}:${contextId}` : "");
  if (!reviewer) throw new Error("signoff requires --reviewer claude|codex or --reviewer-id ID.");
  const paths = narratedStoryRunPaths({ deploymentRoot, jobId: id, signoffPath: nonEmpty(outputPath) || signoffPath });
  const state = await readJsonIfPresent(paths.statePath).catch(() => null);
  if (state && state.jobId !== id) throw new Error("The narrated-story workspace belongs to another Job.");
  const resolvedVideoPath = nonEmpty(videoPath) ? resolve(videoPath) : nonEmpty(state?.artifacts?.previewVideo?.path);
  const resolvedSheetPath = nonEmpty(contactSheetPath) ? resolve(contactSheetPath) : nonEmpty(state?.artifacts?.contactSheet?.path);
  if (!resolvedVideoPath || !resolvedSheetPath) {
    throw new Error("signoff needs the reviewed MP4 and contact sheet: run production first or pass --video-path and --contact-sheet-path.");
  }
  const [videoRecord, sheetRecord] = await Promise.all([artifactRecord(resolvedVideoPath), artifactRecord(resolvedSheetPath)]);
  if (!force && await readJsonIfPresent(paths.signoffPath).catch(() => ({}))) {
    throw new Error(`signoff-exists: ${paths.signoffPath} already exists; pass --force to replace it after a new review.`);
  }
  const approved = pass === true;
  const scored = normalizeNarratedReviewInput(reviewInput, state?.review?.quality, { approved });
  const trust = await loadReviewerTrust({ trust: reviewerTrust, trustPath: reviewerTrustPath, env });
  const body = {
    version: NARRATED_STORY_SIGNOFF_VERSION,
    jobId: id,
    reviewer,
    ...(host ? { reviewerHost: host } : {}),
    reviewerContextId: contextId,
    approved,
    originalDetailReviewed: true,
    videoPath: videoRecord.path,
    videoSha256: videoRecord.sha256,
    contactSheetPath: sheetRecord.path,
    contactSheetSha256: sheetRecord.sha256,
    findings: scored.findings,
    knownRemainingIssues: [],
    // 評価文脈は reviewer の文脈そのもの（別の値を書かせない）。品質ループは回ごとに新しい文脈を求める。
    qualityReview: { ...scored.qualityReview, evaluatorContextId: contextId },
    reviewedAt: new Date(signedAt).toISOString(),
  };
  const signoff = await signNarratedReviewSignoff({
    signoff: body,
    jobId: id,
    identityDigest: nonEmpty(identityDigest),
    privateKeyPath: reviewerPrivateKeyPath,
    privateKeyPem: reviewerPrivateKeyPem,
    trust,
    signedAt,
  });
  await writeAtomic(paths.signoffPath, signoff, { json: true, mode: 0o644 });
  return {
    outputPath: paths.signoffPath,
    signoff,
    signerKeyId: signoff.reviewerAttestation?.signer?.keyId || "",
    videoSha256: videoRecord.sha256,
    contactSheetSha256: sheetRecord.sha256,
  };
}

export async function runNarratedStoryPipeline({
  scriptPath,
  channelPackDir,
  jobId,
  deploymentRoot = process.cwd(),
  mediaJobRunner = null,
  mediaJobProbe = null,
  mediaJobApiBase = process.env.BUZZASSIST_MEDIA_JOB_API_BASE,
  mediaJobFetch,
  artifactFetch,
  signoffPath = "",
  ffmpegToolchain = null,
  jobIdentityDigest = "",
  reviewerTrust = null,
  reviewerTrustPath = "",
  revisionDelta = "",
  retryFailedImages = false,
  voiceQualityGate = DEFAULT_NARRATED_VOICE_QUALITY_GATE,
  // 運営者の画の取り込みの記録（lib/operatorImageImport.mjs）。Pack の image.source が operator-file のときだけ使う。
  operatorImageManifestPath = "",
  // 運営者の動画の取り込みの記録（lib/operatorVideoImport.mjs）。Pack が回ごとの動画の枠を宣言したときだけ使う。
  operatorVideoManifestPath = "",
  // 台本の品質ループの作業フォルダ（Job の options.scriptQualityWorkDir。無ければ台本のあるフォルダ）。
  scriptQualityWorkDir = "",
  // 台本の品質ループの答え（試験だけが差し替える。既定は lib/scriptQualityLoop.mjs の scriptQualityVerdict）。
  scriptQualityVerdict = undefined,
  now = () => new Date().toISOString(),
  env = process.env,
} = {}) {
  if (!nonEmpty(jobId)) throw new Error("Narrated-story production requires the durable outer jobId.");
  const paths = narratedStoryRunPaths({ deploymentRoot, jobId, signoffPath });
  const runDir = paths.runDir;
  await mkdir(runDir, { recursive: true });
  // 有料 Media Job の journal の置き場（Job 層の recover がここを探す）と、画像の作り直しの記録。
  const brokerStateDir = join(runDir, "broker-journal");
  let createdRunner = null;
  const resumeEvidence = () => {
    const stateDir = nonEmpty(mediaJobRunner?.stateDir)
      || (createdRunner ? createdRunner.stateDir : "")
      || (!mediaJobRunner && nonEmpty(mediaJobApiBase) ? brokerStateDir : "");
    return {
      ...(stateDir ? { mediaJobStateDir: stateDir } : {}),
      imageRetry: {
        requested: retryFailedImages === true,
        retriedFailed: createdRunner?.stats ? createdRunner.stats().retriedFailed : null,
      },
    };
  };
  const finalizeOptions = {
    deploymentRoot: resolve(deploymentRoot),
    revisionDelta: nonEmpty(revisionDelta),
    now,
    identityDigest: nonEmpty(jobIdentityDigest),
    reviewerTrust,
    reviewerTrustPath: nonEmpty(reviewerTrustPath),
    env,
  };
  const outcome = await withPipelineLock(runDir, async () => {
    const inputs = await inspectNarratedStoryInputs({ scriptPath, channelPackDir });
    const statePath = paths.statePath;
    const reviewSignoffPath = paths.signoffPath;
    const loadedConfig = await loadNarratedStoryChannelConfig(channelPackDir);
    if (!loadedConfig.ok) {
      return buildNarratedStoryOutcome({
        version: NARRATED_STORY_PIPELINE_VERSION,
        status: "awaiting-media",
        jobId,
        inputs,
        runtimeMetadata: loadedConfig.config?.runtimeMetadata || null,
        execution: { paidGenerationAttempted: false, providerCallsAttempted: false, legacyAssetFallbackUsed: false },
        artifacts: {},
        knownRemainingIssues: loadedConfig.blockers.map((item) => `channel-pack-config-required:${item}`),
        mediaJobs: [],
        auditChecks: pendingNarratedStoryAuditChecks("channel-pack-preflight"),
      });
    }
    const config = loadedConfig.config;
    const qualityContract = createNarratedQualityContract({
      bookendsEnabled: config.bookends?.enabled === true,
      limits: config.qualityLoop,
    });
    const operatorInputOutcome = (issues, stage) => buildNarratedStoryOutcome({
      version: NARRATED_STORY_PIPELINE_VERSION,
      status: "awaiting-operator-input",
      jobId,
      inputs,
      runtimeMetadata: config.runtimeMetadata,
      execution: { paidGenerationAttempted: false, providerCallsAttempted: false, legacyAssetFallbackUsed: false },
      artifacts: {},
      knownRemainingIssues: issues,
      mediaJobs: [],
      auditChecks: pendingNarratedStoryAuditChecks(stage),
    });
    // 途中の成果物の品質ループ（本編の画・人物の設定画・声のテイク）が合格していない: 描かずに人待ちで止まる。
    // 何が足りないか（工程・対象 id・理由コード）を knownRemainingIssues と assetQualityLoop.pending に載せる。
    // 有料の再生成は回さない（作った画・テイクは Media Job の記録で再開時にそのまま使う）。
    const assetLoopOutcome = (gate, { adapterProbes = null, mediaJobs = [], paid = false, extraChecks = {} } = {}) => buildNarratedStoryOutcome({
      version: NARRATED_STORY_PIPELINE_VERSION,
      status: "awaiting-human-review",
      jobId,
      inputs,
      runtimeMetadata: config.runtimeMetadata,
      ...(adapterProbes ? { adapterProbes } : {}),
      execution: { paidGenerationAttempted: paid, providerCallsAttempted: paid, legacyAssetFallbackUsed: false },
      artifacts: {},
      knownRemainingIssues: gate.issues,
      mediaJobs,
      auditChecks: { ...pendingNarratedStoryAuditChecks("asset-quality-loop"), ...extraChecks, ...gate.checks },
      assetQualityLoop: gate.summary,
    });
    const productionContext = `production:${jobId}`;
    if (config.declaredBlockers.length > 0) {
      return operatorInputOutcome(
        config.declaredBlockers.map((id) => `channel-pack-declared-blocker:${id}`),
        "channel-pack-declared-blockers",
      );
    }
    // 運営者の画の取り込みの記録を読む（実測の sha256 から作った digest を入力の指紋に入れる）。
    // broker の Pack に manifest が渡されたら、黙って捨てずに止める（どちらの画を使うつもりか分からない）。
    let operatorManifest = null;
    if (config.imageImport) {
      if (!nonEmpty(operatorImageManifestPath)) {
        return operatorInputOutcome(["operator-image-manifest-required"], "operator-image-import");
      }
      operatorManifest = await readOperatorImageManifest({ manifestPath: operatorImageManifestPath, now: new Date(now()) });
      inputs.operatorImages = { manifestSha256: operatorManifest.manifestSha256 || null, digest: operatorManifest.digest || null };
    } else if (nonEmpty(operatorImageManifestPath)) {
      return operatorInputOutcome(["operator-image-manifest-unexpected"], "operator-image-import");
    }
    const toolchain = ffmpegToolchain || await resolveFfmpegToolchain();
    if (!toolchain?.ok) {
      return buildNarratedStoryOutcome({
        version: NARRATED_STORY_PIPELINE_VERSION,
        status: "awaiting-media",
        jobId,
        inputs,
        runtimeMetadata: config.runtimeMetadata,
        execution: { paidGenerationAttempted: false, providerCallsAttempted: false, legacyAssetFallbackUsed: false },
        artifacts: {},
        knownRemainingIssues: ["ffmpeg-toolchain-unavailable"],
        mediaJobs: [],
        auditChecks: pendingNarratedStoryAuditChecks("ffmpeg-preflight"),
      });
    }
    const missingFilters = await missingBookendFfmpegFilters(toolchain.ffmpeg, config);
    if (missingFilters.length > 0) {
      return buildNarratedStoryOutcome({
        version: NARRATED_STORY_PIPELINE_VERSION,
        status: "awaiting-media",
        jobId,
        inputs,
        runtimeMetadata: config.runtimeMetadata,
        execution: { paidGenerationAttempted: false, providerCallsAttempted: false, legacyAssetFallbackUsed: false },
        artifacts: {},
        knownRemainingIssues: missingFilters.map((name) => `ffmpeg-filter-missing:${name}`),
        mediaJobs: [],
        auditChecks: pendingNarratedStoryAuditChecks("ffmpeg-preflight"),
      });
    }
    // 前回の確定が途中で落ちていれば、状態を読む前にやり切るか捨てる（lib/fileTransaction.mjs）。
    await recoverFileTransactions(runDir);
    // 運営者の動画（回ごとの OP 映像など。lib/operatorVideoImport.mjs）: 有料の処理の前に検査して Job の作業
    // フォルダへ写し、実測の sha256 から作った digest を入力の指紋に入れる（動画を差し替えれば作り直す）。
    const operatorVideos = await prepareNarratedOperatorVideos({
      config,
      manifestPath: operatorVideoManifestPath,
      ffprobe: toolchain.ffprobe,
      runDir,
      now,
    });
    if (operatorVideos.inputs) inputs.operatorVideos = operatorVideos.inputs;
    if (operatorVideos.issues.length > 0) return operatorInputOutcome(operatorVideos.issues, "operator-video-import");
    const previousState = await readJsonIfPresent(statePath).catch(() => null);
    if (await readyStateIsReusable(previousState, inputs)) {
      if (previousState.phase === "final-audited") {
        return outcomeFromReadyState(previousState, {
          status: "final-audited",
          artifacts: previousState.artifacts,
          knownRemainingIssues: [],
          auditChecks: previousState.auditChecks,
          runReceiptPath: previousState.runReceiptPath,
        });
      }
      return finalizeReadyState({ state: previousState, statePath, signoffPath: reviewSignoffPath, ffmpeg: toolchain.ffmpeg, qualityContract, ...finalizeOptions });
    }
    // 回ごとの運営者の動画（監査契約 v7 から）: 有料の probe と Media Job より前に、取り込んだ動画が工程 video-clip の
    // 品質ループで合格しているかを見る（確定を待つ古い契約の state は上で当時の契約のまま確定させる）。
    const earlyVideoLoops = await gateNarratedAssetLoops({
      runDir,
      contractVersion: NARRATED_STORY_AUDIT_CONTRACT_VERSION,
      videos: operatorVideos.loopSubjects || [],
    });
    if (!earlyVideoLoops.pass) return assetLoopOutcome(earlyVideoLoops);
    const script = (await readFile(resolve(scriptPath), "utf8")).replaceAll("\r", "").trim();
    const scriptPlan = planNarratedStoryInput({ script, scriptPath, config, planRawScript: planNarratedStoryScript });
    if (scriptPlan.issues.length > 0) return operatorInputOutcome(scriptPlan.issues, scriptPlan.stage);
    const { storySegments, reviewSegments } = scriptPlan;
    const segments = [...storySegments, ...reviewSegments];
    // 声を作る文（字幕だけの文を除く）。
    const voicedSegments = segments.filter((segment) => !segment.captionOnly);
    if (storySegments.length === 0) throw new Error("Raw Japanese script did not produce any deterministic segment.");
    // 見た目（焼き込み字幕の書体に無い字・画面に収まらない行など）を台本に当て、描けないなら有料生成の前に止める。
    const visualPlan = await checkNarratedVisualPlan({ config, segments });
    if (visualPlan.issues.length > 0) return operatorInputOutcome(visualPlan.issues, "visual-plan");
    // 台本の品質ループ（監査契約 v8）: 使う台本（Job に保存した写しのバイト列）が、台本の品質ループに合格した版か、
    // 人がそのまま使うと認めた版でなければ、有料の処理の前に人待ちで止まる。理由コードと次のコマンドを返す。
    const scriptQuality = await gateNarratedScriptQuality({
      contractVersion: NARRATED_STORY_AUDIT_CONTRACT_VERSION,
      scriptPath: resolve(scriptPath),
      workDir: scriptQualityWorkDirFor({ options: nonEmpty(scriptQualityWorkDir) ? { scriptQualityWorkDir } : {}, scriptPath }),
      ...(scriptQualityVerdict ? { verdict: scriptQualityVerdict } : {}),
    });
    if (!scriptQuality.pass) {
      return buildNarratedStoryOutcome({
        version: NARRATED_STORY_PIPELINE_VERSION,
        status: "awaiting-human-review",
        jobId,
        inputs,
        runtimeMetadata: config.runtimeMetadata,
        execution: { paidGenerationAttempted: false, providerCallsAttempted: false, legacyAssetFallbackUsed: false },
        artifacts: {},
        knownRemainingIssues: scriptQuality.issues,
        mediaJobs: [],
        auditChecks: { ...pendingNarratedStoryAuditChecks("script-quality"), [NARRATED_SCRIPT_QUALITY_AUDIT_ID]: scriptQuality.check },
        scriptQuality: scriptQuality.summary,
        // 外側の Job（lib/videoHarnessJob.mjs の adapterResult）へ残るのは文字列の next だけ。
        next: scriptQuality.next.join("\n"),
      });
    }
    // 感想パートの人物の映像（Pack の共通の素材か、回ごとの運営者の動画）と、文ごとの見た目の出どころ。
    const reviewPresenterPath = narratedReviewPresenterPath(config, operatorVideos);
    const presenterReview = reviewSegments.length > 0 && Boolean(reviewPresenterPath);
    annotateNarratedReviewVisuals({ config, reviewSegments, presenterAvailable: presenterReview });
    const imageDir = join(runDir, "media", "images");
    const voiceDir = join(runDir, "media", "voice");
    const musicDir = join(runDir, "media", "music");
    const renderDir = join(runDir, "render");
    const auditDir = join(runDir, "audit");
    // 運営者の画（image.source: operator-file）: 有料の処理より前に全部の検査を通し、場面の画にする。
    // 画の Media Job は作らない。場面が足りなければ有料生成へ落とさずに止める（混在させない）。
    let operatorImages = null;
    let operatorCheck = null;
    if (config.imageImport) {
      operatorCheck = await checkNarratedOperatorImages({
        config,
        manifest: operatorManifest,
        storySegments,
        reviewSegments,
        projectDir: deploymentRoot,
      });
      if (operatorCheck.issues.length > 0) return operatorInputOutcome(operatorCheck.issues, "operator-image-import");
      // 運営者の画は、有料の probe と Media Job より前に品質ループの合格を見る（本編の画と、その参照の人物の設定画）。
      const earlyLoops = await gateNarratedAssetLoops({
        runDir,
        contractVersion: NARRATED_STORY_AUDIT_CONTRACT_VERSION,
        scenes: narratedOperatorSceneLoopSubjects(operatorCheck.checked),
      });
      if (!earlyLoops.pass) return assetLoopOutcome(earlyLoops);
      operatorImages = await materializeOperatorImages({
        ffmpeg: toolchain.ffmpeg,
        manifest: operatorManifest,
        checked: operatorCheck.checked,
        target: { width: config.render.width, height: config.render.height },
        outputDir: imageDir,
        // 私有の Job フォルダ（会話の URL・プロンプト・元の画の写しはここにだけ置く）。
        privateDir: join(runDir, "operator-images"),
        now,
      });
      if (!operatorImages.ok) return operatorInputOutcome(operatorImages.issues, "operator-image-import");
    }
    const runner = mediaJobRunner || createBrokerMediaJobRunner({
      apiBase: mediaJobApiBase,
      stateDir: brokerStateDir,
      apiFetch: mediaJobFetch,
      artifactFetch,
      retryFailedKinds: retryFailedImages === true ? ["image.generation"] : [],
    });
    if (!mediaJobRunner) createdRunner = runner;
    if (!runner) {
      return buildNarratedStoryOutcome({
        version: NARRATED_STORY_PIPELINE_VERSION,
        status: "awaiting-media",
        jobId,
        inputs,
        runtimeMetadata: config.runtimeMetadata,
        execution: { paidGenerationAttempted: false, providerCallsAttempted: false, legacyAssetFallbackUsed: false },
        artifacts: {},
        knownRemainingIssues: ["BUZZASSIST_MEDIA_JOB_API_BASE-required"],
        mediaJobs: [],
        auditChecks: pendingNarratedStoryAuditChecks("paid-media-preflight"),
      });
    }
    const probeAdapter = typeof mediaJobProbe === "function"
      ? mediaJobProbe
      : (typeof runner.probeAdapter === "function" ? runner.probeAdapter : null);
    if (!probeAdapter) {
      return buildNarratedStoryOutcome({
        version: NARRATED_STORY_PIPELINE_VERSION,
        status: "awaiting-media",
        jobId,
        inputs,
        runtimeMetadata: config.runtimeMetadata,
        execution: { paidGenerationAttempted: false, providerCallsAttempted: false, legacyAssetFallbackUsed: false },
        artifacts: {},
        knownRemainingIssues: ["typed-media-adapter-probe-required"],
        mediaJobs: [],
        auditChecks: pendingNarratedStoryAuditChecks("paid-media-probe"),
      });
    }
    // 声の品質ゲート（語りと台詞の全テイク）の実行系が無ければ、課金してから止まらないようにここで止める。
    if (!(await voiceQualityGate.available())) {
      return buildNarratedStoryOutcome({
        version: NARRATED_STORY_PIPELINE_VERSION,
        status: "awaiting-media",
        jobId,
        inputs,
        runtimeMetadata: config.runtimeMetadata,
        execution: { paidGenerationAttempted: false, providerCallsAttempted: false, legacyAssetFallbackUsed: false },
        artifacts: {},
        knownRemainingIssues: ["voice-quality-gate-unavailable"],
        mediaJobs: [],
        auditChecks: pendingNarratedStoryAuditChecks("voice-quality-preflight"),
      });
    }
    const adapterProbes = await Promise.all([
      // 運営者の画を取り込む Job は画の Media Job を作らないので、画の adapter は probe しない。
      ...(operatorImages ? [] : [{ kind: "image.generation", provider: config.image.provider, model: config.image.model, adapterVersion: config.image.adapterVersion }]),
      // 語りの声と、台本で使う役の声（配役）を全部 probe してから有料生成へ進む。
      ...narratedVoiceAdapters(config, voicedSegments),
      { kind: "music.generation", provider: config.music.provider, model: config.music.model, adapterVersion: config.music.adapterVersion },
    ].map(async (adapter) => {
      try {
        const result = await probeAdapter(adapter);
        return {
          ok: result?.ok === true,
          status: nonEmpty(result?.status) || "unavailable",
          ...adapter,
          httpStatus: finite(result?.httpStatus),
          serverVersion: nonEmpty(result?.serverVersion),
          detail: redactSecrets(result?.detail || "adapter did not report ready"),
        };
      } catch (error) {
        return {
          ok: false,
          status: "unreachable",
          ...adapter,
          httpStatus: finite(error?.status),
          serverVersion: "",
          detail: redactSecrets(error?.message || String(error)),
        };
      }
    }));
    const unavailableAdapters = adapterProbes.filter((probe) => !probe.ok);
    if (unavailableAdapters.length > 0) {
      return buildNarratedStoryOutcome({
        version: NARRATED_STORY_PIPELINE_VERSION,
        status: "awaiting-media",
        jobId,
        inputs,
        runtimeMetadata: config.runtimeMetadata,
        adapterProbes,
        execution: { paidGenerationAttempted: false, providerCallsAttempted: false, legacyAssetFallbackUsed: false },
        artifacts: {},
        knownRemainingIssues: unavailableAdapters.map((probe) => (
          `media-adapter-unavailable:${probe.kind}:${probe.provider}:${probe.model}:${probe.adapterVersion}`
        )),
        mediaJobs: [],
        auditChecks: pendingNarratedStoryAuditChecks("paid-media-probe"),
      });
    }

    await Promise.all([imageDir, voiceDir, musicDir, renderDir, auditDir, dirname(reviewSignoffPath)].map((path) => mkdir(path, { recursive: true })));
    // 声のテイクの依頼。字幕は表記（text）、声は読み（spokenText。台本パッケージの readings を当てた文）。
    // 撮り直し（声の品質ゲート）は take を入力に足して別の requestKey にする（1本目は従来と同じ入力）。
    const voiceSpecFor = (segment, take = 1) => {
      const voice = segment.voice || config.voice;
      return mediaSpec({
        kind: "voice.synthesis",
        ...voice,
        input: { text: segment.spokenText || segment.text, language: "ja", speed: voice.speed, ...(take > 1 ? { take } : {}) },
        output: narratedVoiceOutputProfile(voice.provider),
        reservation: {
          unit: "characters",
          estimatedUnits: segment.characterCount,
          estimatedSeconds: Math.max(0.5, segment.characterCount / 6),
        },
      });
    };
    // 台本パッケージでは、1つの場面（imageKey）の中の話者・文の区切りごとに声と字幕を作り、画は場面に1枚。
    const imageKeys = new Set();
    const tasks = segments.flatMap((segment) => {
      const imageKey = segment.imageKey || segment.id;
      // 人物素材を Pack が供給する感想パートは画像を生成しない（素材で代用しない・素材を生成しない）。
      // 運営者の画を取り込んだ Job は、画を1枚も生成しない（取り込んだ画を下で足す）。
      const wantsImage = !operatorImages && !(segment.part === "review" && segment.reviewVisual !== "images") && !imageKeys.has(imageKey);
      if (wantsImage) imageKeys.add(imageKey);
      // 字幕だけの文（captionOnly）は声を作らない。
      return [...(wantsImage ? [{ type: "image", segment }] : []), ...(segment.captionOnly ? [] : [{ type: "voice", segment }])];
    });
    let generated;
    try {
      generated = await mapLimit(tasks, config.concurrency, async ({ type, segment }) => {
        if (type === "image") {
          const imageKey = segment.imageKey || segment.id;
          return {
            type,
            segmentId: imageKey,
            ...(await acquireMediaArtifact({
              runner,
              spec: mediaSpec({
                kind: "image.generation",
                ...config.image,
                input: {
                  prompt: `${config.image.stylePrompt}\nScene ${imageKey}: ${segment.imagePrompt || segment.text}`,
                  scriptHash: inputs.script.sha256,
                  segmentId: imageKey,
                },
                output: { format: "png", width: config.render.width, height: config.render.height },
                reservation: { unit: "images", estimatedUnits: 1 },
              }),
              outputPath: join(imageDir, `${imageKey}.png`),
              mimeType: "image/png",
            })),
          };
        }
        return {
          type,
          segmentId: segment.id,
          ...(await acquireMediaArtifact({
            runner,
            spec: voiceSpecFor(segment),
            outputPath: join(voiceDir, `${segment.id}.wav`),
            mimeType: "audio/wav",
          })),
        };
      });
    } catch (error) {
      // 完成した Media Job に加え、決着していない（recovery-required・進行中の）Media Job も Job へ報告する。
      const mediaJobs = receiptSafeMediaJobs([
        ...await collectCachedMediaJobs(runDir),
        ...await listUnsettledPaidMediaJobs(runner.stateDir),
      ]);
      await writeAtomic(statePath, {
        version: NARRATED_STORY_PIPELINE_VERSION,
        phase: "awaiting-media",
        jobId,
        inputs,
        runtimeMetadata: config.runtimeMetadata,
        mediaJobs,
        error: safeMediaFailure(error),
      }, { json: true });
      return buildNarratedStoryOutcome({
        version: NARRATED_STORY_PIPELINE_VERSION,
        status: "awaiting-media",
        jobId,
        inputs,
        runtimeMetadata: config.runtimeMetadata,
        adapterProbes,
        execution: { paidGenerationAttempted: true, providerCallsAttempted: true, legacyAssetFallbackUsed: false },
        artifacts: {},
        knownRemainingIssues: ["typed-media-generation-incomplete", mediaFailureIssue(error)],
        mediaJobs,
        auditChecks: pendingNarratedStoryAuditChecks("media-generation"),
      });
    }
    // 声の品質ゲート: 語りと台詞の全テイクを測り、落ちたテイクは Pack の上限まで撮り直して採用しない。
    let voiceQuality;
    try {
      voiceQuality = await gateNarratedVoiceTakes({
        segments: voicedSegments,
        takesBySegment: new Map(generated.filter((entry) => entry.type === "voice")
          .map((entry) => [entry.segmentId, [{ take: 1, path: entry.path, receipt: entry.receipt }]])),
        retake: (segment, take) => acquireMediaArtifact({
          runner,
          spec: voiceSpecFor(segment, take),
          outputPath: join(voiceDir, `${segment.id}.take${take}.wav`),
          mimeType: "audio/wav",
        }),
        maxTakes: config.voiceQuality.maxTakesPerTurn,
        gate: voiceQualityGate,
      });
    } catch (error) {
      const mediaJobs = receiptSafeMediaJobs([
        ...await collectCachedMediaJobs(runDir),
        ...await listUnsettledPaidMediaJobs(runner.stateDir),
      ]);
      return buildNarratedStoryOutcome({
        version: NARRATED_STORY_PIPELINE_VERSION,
        status: "awaiting-media",
        jobId,
        inputs,
        runtimeMetadata: config.runtimeMetadata,
        adapterProbes,
        execution: { paidGenerationAttempted: true, providerCallsAttempted: true, legacyAssetFallbackUsed: false },
        artifacts: {},
        knownRemainingIssues: ["voice-quality-gate-incomplete", mediaFailureIssue(error)],
        mediaJobs,
        auditChecks: pendingNarratedStoryAuditChecks("voice-quality"),
      });
    }
    const byKey = new Map(generated.map((entry) => [`${entry.type}:${entry.segmentId}`, entry]));
    // 運営者の画: 受領記録（Media Job）は無く、取り込みの記録（sha256・合わせ方）を持つ。
    for (const [sceneId, image] of operatorImages?.images || []) {
      byKey.set(`image:${sceneId}`, { type: "image", segmentId: sceneId, path: image.path, receipt: null, operatorImport: image });
    }
    for (const [segmentId, take] of voiceQuality.selected) {
      byKey.set(`voice:${segmentId}`, { type: "voice", segmentId, path: take.path, receipt: take.receipt });
    }
    // 声のテイクの測定（CER・UTMOS など）を、声のテイクの工程の measurement として Job の作業フォルダに置く
    // （ループの機械ゲート voice-metrics-pass がテイクの sha256 で引く）。台本の文・文字起こし・パスは持たない。
    // 文（対象 id）ごとに1ファイル（ループの機械ゲートは行を sha256 だけで引くので、別の文の同じバイト列の
    // テイクの判定を拾わないように分ける）。
    const takeShas = new Map();
    for (const row of voiceQuality.measurements) {
      if (!takeShas.has(row.path)) takeShas.set(row.path, await fileSha256(row.path).catch(() => ""));
    }
    const measurementShas = [];
    for (const segment of voicedSegments) {
      const file = join(runDir, ...narratedVoiceTakeMeasurementPath(segment.id).split("/"));
      const rows = voiceQuality.measurements.filter((row) => row.segmentId === segment.id);
      await writeAtomic(file, narratedVoiceTakeMeasurementReport(rows, takeShas), { json: true });
      measurementShas.push({ segmentId: segment.id, sha256: await fileSha256(file) });
    }
    // 途中の成果物の品質ループ（監査契約 v5）: 描く画・その参照の人物の設定画・採用するテイクが、ループに合格した
    // 版でなければ描かない。BGM はまだ依頼していない（合格の前に曲の代金を払わない）。
    const assetLoops = await gateNarratedAssetLoops({
      runDir,
      contractVersion: NARRATED_STORY_AUDIT_CONTRACT_VERSION,
      generatorContextId: productionContext,
      scenes: operatorImages
        ? narratedOperatorSceneLoopSubjects(operatorCheck?.checked)
        : narratedSceneImageKeys(segments, { presenterReview }).map((sceneId) => brokerSceneLoopSubject(sceneId, {
          runDir,
          imagePath: byKey.get(`image:${sceneId}`)?.path || join(imageDir, `${sceneId}.png`),
        })),
      voices: voicedSegments.map((segment) => ({
        segmentId: segment.id,
        machineTake: voiceQuality.selected.get(segment.id)?.take ?? null,
        candidates: voiceQuality.candidates.get(segment.id) || [],
      })),
      // 回ごとの運営者の動画（監査契約 v7 から。取り込んだ動画が無い回は []）。確定の前にもう一度照合する。
      videos: operatorVideos.loopSubjects || [],
    });
    if (!assetLoops.pass) {
      return assetLoopOutcome(assetLoops, {
        adapterProbes,
        paid: true,
        mediaJobs: receiptSafeMediaJobs([...generated.map((entry) => entry.receipt), ...voiceQuality.extraReceipts]),
        extraChecks: {
          [NARRATED_VOICE_QUALITY_AUDIT_ID]: check(voiceQuality.check.pass, voiceQuality.check.detail, {
            measuredTakes: voiceQuality.check.measuredTakes,
            retakes: voiceQuality.check.retakes,
            failedSegmentIds: voiceQuality.check.failedSegmentIds,
          }),
        },
      });
    }
    // 評価者がループで合格させたテイクを採用する（声の品質ゲートに通ったテイクの中から。機械の順位で上書きしない）。
    for (const [segmentId, adopted] of assetLoops.adoptedTakes) {
      byKey.set(`voice:${segmentId}`, { type: "voice", segmentId, path: adopted.path, receipt: adopted.receipt });
      const row = voiceQuality.report.segments.find((entry) => entry.segmentId === segmentId);
      if (row && row.selectedTake !== adopted.take) {
        row.selectedTake = adopted.take;
        row.adoptedBy = "voice-take-asset-loop";
      }
    }
    const measuredSegments = [];
    let cursor = 0;
    for (const segment of segments) {
      // 字幕だけの文は、宣言した秒数の無音を声の代わりに置く（声の Media Job は無い）。
      if (segment.captionOnly) byKey.set(`voice:${segment.id}`, await makeCaptionOnlySilence(toolchain.ffmpeg, segment, voiceDir));
      const voicePath = byKey.get(`voice:${segment.id}`).path;
      const voiceProbe = await probeMedia(toolchain.ffprobe, voicePath);
      const durationSeconds = durationFromProbe(voiceProbe);
      if (!(durationSeconds > 0)) throw new Error(`${segment.id} voice artifact has no measurable duration.`);
      measuredSegments.push({
        ...segment,
        imagePath: byKey.get(`image:${segment.imageKey || segment.id}`)?.path || "",
        voicePath,
        durationSeconds,
        startSeconds: cursor,
        endSeconds: cursor + durationSeconds,
      });
      cursor += durationSeconds;
    }
    const voiceTotalDuration = cursor;
    // bookends: OP・境目・感想の時間割を声の実尺から決める（BGM の長さもこの番組尺で依頼する）。
    const bookends = config.bookends.enabled ? config.bookends : null;
    const bookendWorkDir = join(renderDir, "bookends");
    let bookendPlan = null;
    let openingRender = null;
    if (bookends) {
      await mkdir(bookendWorkDir, { recursive: true });
      if (bookends.opening) {
        openingRender = await renderOpeningPart({
          ffmpeg: toolchain.ffmpeg,
          ffprobe: toolchain.ffprobe,
          opening: bookends.opening,
          // 回ごとの OP 映像は、Pack の動画ではなく運営者の動画の取り込みの写しを使う。
          media: bookends.opening.kind === "episode-video"
            ? { ...bookends.media, "opening.video": operatorVideos.clips.get(EPISODE_OPENING_VIDEO_SLOT)?.path || "" }
            : bookends.media,
          config,
          workDir: bookendWorkDir,
          outputPath: join(bookendWorkDir, "part-opening.mp4"),
        });
      }
      bookendPlan = planNarratedBookendProgram({
        fps: config.render.fps,
        openingFrames: openingRender?.frames || 0,
        story: measuredSegments.filter((segment) => segment.part === "story"),
        review: measuredSegments.filter((segment) => segment.part === "review"),
        reviewPresenter: presenterReview,
        // 感想パートの配置（lib/narratedStoryReviewLayout.mjs）の宣言があれば、区間の型で描く。
        ...(bookends.review?.layout ? { reviewVisual: "review-layout", reviewSegmentCamera: narratedReviewSegmentCamera(reviewSegments) } : {}),
        transitions: bookends.transitions,
      });
    }
    const programSegments = bookendPlan ? bookendPlan.segments : measuredSegments;
    const totalDuration = bookendPlan ? bookendPlan.totalSeconds : voiceTotalDuration;
    let music;
    try {
      music = config.musicPlan.enabled
        // 区分ごとの曲（運営者の曲か生成）をつないだ本編の曲。未受領の区分は計画の段階で止めてある。
        ? await buildNarratedMusicBed({
          ffmpeg: toolchain.ffmpeg,
          musicPlan: config.musicPlan,
          blocks: scriptPlan.musicBlocks,
          segments: programSegments.filter((segment) => (segment.part || "story") === "story"),
          ...narratedMusicBedWindow(bookendPlan, totalDuration),
          musicAdapter: config.music,
          scriptHash: inputs.script.sha256,
          acquireTrack: (spec, outputPath) => acquireMediaArtifact({ runner, spec, outputPath, mimeType: "audio/wav" }),
          workDir: musicDir,
          outputPath: join(musicDir, "story-bed.wav"),
        })
        : await acquireMediaArtifact({
        runner,
        spec: mediaSpec({
          kind: "music.generation",
          ...config.music,
          input: { prompt: config.music.prompt, durationSeconds: totalDuration, scriptHash: inputs.script.sha256 },
          output: { format: "wav", sampleRate: 48_000, channels: 2 },
          reservation: { unit: "seconds", estimatedSeconds: totalDuration },
        }),
        outputPath: join(musicDir, "generated-bed.wav"),
        mimeType: "audio/wav",
      });
    } catch (error) {
      const mediaJobs = receiptSafeMediaJobs([
        ...await collectCachedMediaJobs(runDir),
        ...await listUnsettledPaidMediaJobs(runner.stateDir),
      ]);
      return buildNarratedStoryOutcome({
        version: NARRATED_STORY_PIPELINE_VERSION,
        status: "awaiting-media",
        jobId,
        inputs,
        runtimeMetadata: config.runtimeMetadata,
        adapterProbes,
        execution: { paidGenerationAttempted: true, providerCallsAttempted: true, legacyAssetFallbackUsed: false },
        artifacts: {},
        knownRemainingIssues: ["typed-music-generation-incomplete", mediaFailureIssue(error)],
        mediaJobs,
        auditChecks: pendingNarratedStoryAuditChecks("music-generation"),
      });
    }
    const srtPath = join(renderDir, "subtitles.srt");
    await writeAtomic(
      srtPath,
      bookendPlan ? buildBookendSrt(bookendPlan, formatSrtTime) : buildNarratedStorySrt(measuredSegments),
      { mode: 0o600 },
    );
    const voiceStemPath = join(renderDir, "voice-stem.wav");
    const bgmStemPath = join(renderDir, "bgm-stem.wav");
    const masterAudioPath = join(renderDir, "master-audio.wav");
    const previewPath = join(renderDir, "preview.mp4");
    const previewTemp = `${previewPath}.${process.pid}.${randomUUID()}.tmp.mp4`;
    const contactSheetPath = join(auditDir, "contact-sheet.png");
    // 焼き込み字幕（Pack が宣言したときだけ）。番組のフレームで時刻を持つ文から頁の層を作る。
    const programFrames = narratedProgramFrames({ bookendPlan, segments: measuredSegments, fps: config.render.fps });
    // カメラのショット（同じ画が続く文のまとまり）の計画。描く側と同じまとめ方で、監査はこれと MP4 を比べる。
    const cameraPlan = planNarratedVisualCamera({ config, programFrames });
    // 感想パートの配置の区間（TV の中は本編の場面の画を台本の順に使う）。
    const reviewLayout = planNarratedReviewLayout({
      config,
      bookendPlan,
      storyScenes: [...new Set(storySegments.map((segment) => segment.imageKey || segment.id))]
        .map((sceneId) => ({ sceneId, imagePath: byKey.get(`image:${sceneId}`)?.path || "" })),
    });
    const staticCameraSegments = new Set(cameraPlan.shots.filter((shot) => shot.move === "static").flatMap((shot) => shot.segmentIds));
    const cameraShotBySegment = new Map(cameraPlan.shots.flatMap((shot) => shot.segmentIds.map((id) => [id, shot])));
    const subtitleLayer = await renderNarratedSubtitleLayer({
      ffmpeg: toolchain.ffmpeg,
      config,
      timedSegments: programFrames.segments,
      totalFrames: programFrames.totalFrames,
      workDir: renderDir,
    });
    let renderGraphs;
    if (bookendPlan) {
      renderGraphs = await renderBookendProgramFromPlan({
        toolchain,
        config,
        plan: bookendPlan,
        workDir: bookendWorkDir,
        openingRender,
        musicPath: music.path,
        voiceStemPath,
        bgmStemPath,
        masterAudioPath,
        srtPath,
        outputPath: previewTemp,
        subtitleLayer,
        reviewLayout,
        reviewPresenterPath,
      });
    } else {
      renderGraphs = {
        voiceStem: await makeVoiceStem(toolchain.ffmpeg, measuredSegments.map((segment) => segment.voicePath), voiceStemPath),
        bgmStem: await makeBgmStem(toolchain.ffmpeg, music.path, totalDuration, config.music.gain, bgmStemPath),
        masterAudio: await makeMasterAudio(toolchain.ffmpeg, voiceStemPath, bgmStemPath, masterAudioPath),
      };
      const preview = await renderPreview(toolchain.ffmpeg, measuredSegments, masterAudioPath, srtPath, config, previewTemp, { subtitleLayer });
      Object.assign(renderGraphs, { storyVideo: preview.storyVideo, preview: preview.preview });
    }
    // 区分の曲をつないだグラフも、番組全体の acrossfade 禁止の監査にかける。
    if (music.graph) renderGraphs.musicBed = music.graph;
    await rm(previewPath, { force: true });
    await renameWithRetry(previewTemp, previewPath);
    if (bookendPlan) {
      await makeBookendContactSheet({ ffmpeg: toolchain.ffmpeg, videoPath: previewPath, plan: bookendPlan, outputPath: contactSheetPath });
    } else {
      const previewProbe = await probeMedia(toolchain.ffprobe, previewPath);
      await makeContactSheet(toolchain.ffmpeg, previewPath, durationFromProbe(previewProbe), contactSheetPath);
    }

    const generationManifestPath = join(runDir, "generation-manifest.json");
    const mediaJobs = receiptSafeMediaJobs([
      ...generated.map((entry) => entry.receipt),
      ...voiceQuality.extraReceipts,
      ...(music.receipts || [music.receipt]),
    ]);
    // 声のテイクが宣言どおりの役の声で作られたかを、Media Job の受領記録で照合する。
    const voiceCasting = auditNarratedVoiceCasting({
      segments: measuredSegments.filter((segment) => !segment.captionOnly),
      voiceReceipts: new Map(measuredSegments.filter((segment) => !segment.captionOnly).map((segment) => [segment.id, byKey.get(`voice:${segment.id}`)?.receipt])),
      config,
    });
    await writeAtomic(generationManifestPath, {
      version: "buzzassist-narrated-story-generation-manifest-v1",
      jobId,
      inputs,
      scriptInput: scriptPlan.input || null,
      channelConfig: {
        version: config.version,
        runtimeMetadata: config.runtimeMetadata,
        image: {
          provider: config.image.provider,
          model: config.image.model,
          adapterVersion: config.image.adapterVersion,
          ...(operatorImages ? { source: "operator-file" } : {}),
        },
        voice: { provider: config.voice.provider, model: config.voice.model, adapterVersion: config.voice.adapterVersion, voiceId: config.voice.voiceId },
        ...(config.cast.enabled ? { cast: narratedCastManifest(config.cast) } : {}),
        music: { provider: config.music.provider, model: config.music.model, adapterVersion: config.music.adapterVersion },
        ...(music.manifest ? { musicPlan: music.manifest } : {}),
        render: config.render,
      },
      segments: programSegments.map((segment, index) => ({
        id: segment.id,
        order: segment.order,
        ...(segment.part ? { part: segment.part } : {}),
        textHash: segment.textHash,
        characterCount: segment.characterCount,
        ...narratedSegmentManifestFields(segment),
        durationSeconds: segment.durationSeconds,
        startSeconds: segment.startSeconds,
        endSeconds: segment.endSeconds,
        // カメラ: この文が属するショット（同じ画が続く文のまとまり）の型。動きの数値は manifest の camera にある。
        camera: segment.camera === "presenter-video"
          ? { mode: "presenter-video" }
          : { mode: cameraShotBySegment.get(segment.id)?.move || "unplanned", shotId: cameraShotBySegment.get(segment.id)?.id || null },
        imageSha256: sceneImageSha256(byKey.get(`image:${segment.imageKey || segment.id}`)),
        // 字幕だけの文は声のテイクが無い（置いた無音の sha256 だけを残す）。
        ...(segment.captionOnly
          ? { captionOnly: true, voiceSha256: null, silenceSha256: byKey.get(`voice:${segment.id}`).silenceSha256 }
          : { voiceSha256: byKey.get(`voice:${segment.id}`).receipt.artifact.sha256 }),
      })),
      ...(bookendPlan ? { bookends: await bookendManifestEntry(bookendPlan, bookends) } : {}),
      // 運営者の画の来歴（sha256・経路・合わせ方だけ。会話の URL などの本文は私有の Job フォルダにだけある）。
      ...(operatorImages ? { operatorImages: operatorImages.publicRecord } : {}),
      voiceCasting: { pass: voiceCasting.pass, takes: voiceCasting.takes, byRole: voiceCasting.byRole, fallbackToNarrator: voiceCasting.fallbackToNarrator, problems: voiceCasting.problems },
      voiceQuality: voiceQuality.report,
      // 見た目（焼き込み字幕の頁の時刻と PNG の sha256 など。台本の字は残さない）。
      ...narratedVisualManifestFields({ config, subtitleLayer, cameraPlan, operatorVideos, reviewLayout }),
      // 途中の成果物の品質ループ（件数と声のテイクの measurement の sha256 だけ。状態ファイルは作業フォルダにある）。
      assetQualityLoop: {
        contractVersion: NARRATED_STORY_AUDIT_CONTRACT_VERSION,
        counts: assetLoops.summary.counts,
        voiceTakeMeasurements: {
          dir: NARRATED_VOICE_TAKE_MEASUREMENT_DIR,
          files: measurementShas.length,
          sha256: sha256(canonicalJson(measurementShas)),
        },
      },
      mediaJobs,
      adapterProbes,
    }, { json: true });
    const audit = await automaticAudit({
      ffmpeg: toolchain.ffmpeg,
      ffprobe: toolchain.ffprobe,
      previewPath,
      voiceStemPath,
      bgmStemPath,
      expectedDuration: totalDuration,
      segments: programSegments.map((segment) => ({
        id: segment.id,
        startSeconds: segment.startSeconds,
        endSeconds: segment.endSeconds,
        // 静止の型のショットは動かないのが正しい（動きの実測は cameraMotionMeasured が計画と比べる）。
        camera: staticCameraSegments.has(segment.id) || segment.camera === "review-tv" ? "static" : segment.camera,
        partIndex: segment.partIndex,
        ...(segment.captionOnly ? { captionOnly: true } : {}),
      })),
      cameraShotCount: cameraPlan.shots.length,
      // 本編の場面の切り替え（Pack の sceneTransition。lib/narratedStorySceneTransitions.mjs）の計画。
      sceneJoins: planNarratedProgramSceneJoins({ cameraPlan, transition: config.sceneTransition || null }),
      config,
      hashes: {
        script: inputs.script.sha256,
        channelPack: inputs.channelPack.sha256,
        generationManifest: await fileSha256(generationManifestPath),
        voiceStem: await fileSha256(voiceStemPath),
        bgmStem: await fileSha256(bgmStemPath),
      },
      renderGraphs,
      bookendPlan,
      renderedSegments: measuredSegments,
      boundaryExcludeRegion: subtitleExclusionRegion(subtitleLayer, config.subtitles),
    });
    // 声の監査: 品質ゲート（全テイク）と、受領記録で照合した配役。
    audit.checks[NARRATED_VOICE_QUALITY_AUDIT_ID] = check(voiceQuality.check.pass, voiceQuality.check.detail, {
      measuredTakes: voiceQuality.check.measuredTakes,
      retakes: voiceQuality.check.retakes,
      failedSegmentIds: voiceQuality.check.failedSegmentIds,
    });
    audit.checks.voiceCastRouting = check(voiceCasting.pass, voiceCasting.detail, {
      takes: voiceCasting.takes,
      byRole: voiceCasting.byRole,
      fallbackToNarrator: voiceCasting.fallbackToNarrator,
      problems: voiceCasting.problems,
    });
    // 台本の品質ループ（監査契約 v8）: 有料の処理の前に問うた答え（台本の SHA・理由コード・受け入れ方）。
    audit.checks[NARRATED_SCRIPT_QUALITY_AUDIT_ID] = scriptQuality.check;
    // 途中の成果物の品質ループ（描く前に合格を確かめた結果。確定の前にもう一度照合する）。
    Object.assign(audit.checks, assetLoops.checks);
    // 見た目の実測（焼き込み字幕など。lib/narratedStoryVisuals.mjs）。完成 MP4 のフレームを読んで測る。
    Object.assign(audit.checks, await narratedVisualAuditChecks({
      ffmpeg: toolchain.ffmpeg,
      videoPath: previewPath,
      config,
      subtitleLayer,
      renderGraphs,
      cameraPlan,
      operatorVideos,
      bookendPlan,
      reviewLayout,
    }));
    // 場面の画の出どころ: 描いた画のファイルを読み直し、有料の Media Job の受領記録か、運営者の画の
    // 取り込みの記録のどちらか一方に sha256 で結び付いていること（保証 scene-image-provenance。監査契約 v5 から）。
    audit.checks[NARRATED_SCENE_IMAGE_PROVENANCE_AUDIT_ID] = await sceneImageProvenanceCheck({
      sceneIds: narratedSceneImageKeys(segments, { presenterReview }),
      byKey,
      operatorImages,
      mediaJobs,
    });
    const auditReportPath = join(auditDir, "automatic-audit.json");
    // 独立 signoff と品質ループは自動監査の後に判定する（ここで pending なのは失敗ではない）。
    const perceptualAuditIds = new Set([
      "perceptualReviewChecks",
      "perceptualReviewBoundToOutput",
      "perceptualEvidenceHashes",
      "contactSheetOriginalDetailReviewed",
      NARRATED_QUALITY_AUDIT_ID,
      NARRATED_CHARACTER_IDENTITY_AUDIT_ID,
    ]);
    const automaticFailures = failedAuditIds(audit.checks).filter((auditId) => !perceptualAuditIds.has(auditId));
    await writeAtomic(auditReportPath, {
      version: NARRATED_STORY_AUDIT_VERSION,
      contractVersion: NARRATED_STORY_AUDIT_CONTRACT_VERSION,
      status: automaticFailures.length ? "failed" : "automatic-pass-awaiting-independent-signoff",
      jobId,
      auditChecks: audit.checks,
      probe: audit.probe,
      knownRemainingIssues: [
        ...automaticFailures.map((auditId) => `audit-${auditId}-failed`),
        "independent-contact-sheet-signoff-required",
        "quality-loop-scored-review-required",
      ],
    }, { json: true });
    const artifacts = await collectArtifacts({
      previewVideo: previewPath,
      subtitles: srtPath,
      voiceStem: voiceStemPath,
      bgmStem: bgmStemPath,
      masterAudio: masterAudioPath,
      generationManifest: generationManifestPath,
      auditReport: auditReportPath,
      contactSheet: contactSheetPath,
    });
    const state = {
      version: NARRATED_STORY_PIPELINE_VERSION,
      phase: "awaiting-human-review",
      // この state を作った監査契約の版（確定はこの版で測る）と、描いた画・採用したテイクの品質ループの対象
      // （確定の前に、今も合格した版のままかを照合する）。
      auditContractVersion: NARRATED_STORY_AUDIT_CONTRACT_VERSION,
      assetQualityLoop: assetLoops.plan,
      jobId,
      inputs,
      runtimeMetadata: config.runtimeMetadata,
      adapterProbes,
      execution: { paidGenerationAttempted: true, providerCallsAttempted: true, legacyAssetFallbackUsed: false },
      imageSource: narratedImageSourceSummary(operatorImages),
      mediaJobs,
      auditChecks: audit.checks,
      artifacts,
      review: {
        signoffPath: reviewSignoffPath,
        requiredVersion: NARRATED_STORY_SIGNOFF_VERSION,
        videoSha256: artifacts.previewVideo.sha256,
        contactSheetSha256: artifacts.contactSheet.sha256,
        // reviewer はこの評価項目で採点する（signoff --review-path）。
        quality: narratedQualityReviewSheet(qualityContract, runDir),
      },
    };
    await writeAtomic(statePath, state, { json: true });
    return finalizeReadyState({ state, statePath, signoffPath: reviewSignoffPath, ffmpeg: toolchain.ffmpeg, qualityContract, ...finalizeOptions });
  });
  return { ...outcome, ...resumeEvidence() };
}
