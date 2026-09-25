// 漫画（koya-manga-video）の最終監査の必須監査 asset-quality-loops（契約 koya-manga-production-v54 から）。
//
// 途中の成果物のゲート（lib/koyaAssetQualityGate.mjs）は、登録・行の完了・テイクの採用の瞬間に効く。
// それだけでは次のものが、ゲートを通らないまま完成品に入る:
//   - 完了済みの画の行の再利用、承認済みの声のチェックポイントの再利用（ゲートより前に完了したもの）
//   - 汎用の経路（standard-cut の差し替え、汎用の画像スクリプト）で入った画
//   - 登録の後に差し替わった人物・場所の参照画
// ここは完成の直前に、回が実際に使っているものを manifest から集め直し、使ったファイルそのもの
// （SHA-256）で品質ループの合格を確かめ直す。判定は作り直さない——1つの成果物の合否は
// checkKoyaAssetQuality（= assetQualityStatus の pass）をそのまま使う。
//
// 見るもの:
//   1. 本編の画: 各カットが使う画（cameraSequence の各ショット・分割ページの各コマ・ショットの無いカットの画）。
//      画像計画の scene-image / split-panel の行ならその行の対象 id、計画に無い画は unplanned の対象 id。
//      決定論の板（editorial-plate）と分割ページの合成（split-page）は対象外（合成の元のコマを見る）
//   2. 声: 各カットの採用テイク（発話の audio.sourceDialoguePath）
//   3. 人物・場所: 回で使った画の行に出る人物と場所の登録。登録時の approval.assetQuality の SHA が、
//      今の referenceAssets（選ばれた顔を除く。顔は各シートの参照）と一致し、ファイルも同じバイト列であること。
//      記録の無い旧登録（ゲートより前の登録）は効力の外として outOfForce に出し、落とさない
//   4. サムネ: 回に含めたとき（manifest.outputs.thumbnail.planPath か <回>/thumbnail-plan.json）だけ、
//      final の監査（auditKoyaThumbnailPlan）が合格していること
//   5. 人の確認待ち: 画の台帳・音声の報告に awaiting-human-review が残っていれば不合格
//   6. 動画クリップ（契約 v55 から）: カットを動画に差し替えた回は、manifest の結び付け（videoSubstitution.status
//      applied）が指すクリップそのもの（clipPath の SHA）で、工程 video-clip のループの合格を確かめる。静止画へ
//      戻したカット（still-fallback）はクリップを使っていないので見ない。v54 の契約の回は見ない
//
// 契約が v54 より前なら何も見ない（applicable: false で合格。当時存在しなかった要求で過去作を落とさない）。

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

import { checkKoyaAssetQuality, checkKoyaVideoClipAssetQuality, koyaAssetQualityWorkDir } from "./koyaAssetQualityGate.mjs";
import {
  KOYA_ASSET_QUALITY_FINAL_AUDIT_ID,
  KOYA_ASSET_QUALITY_GATE_IN_FORCE_SINCE,
  KOYA_ASSET_QUALITY_REASONS,
  KOYA_SCENE_IMAGE_JOB_KINDS,
  KOYA_VIDEO_CLIP_STAGE,
  koyaAssetQualityFailureCode,
  koyaAssetQualityGateInForce,
  koyaAssetQualitySubjectId,
  koyaSceneImageAssetQualitySubjectId,
  koyaVideoClipAssetQualitySubjectId,
  koyaVideoClipGateInForce,
  koyaVoiceTakeAssetQualitySubjectId,
} from "./koyaAssetQualityGatePolicy.mjs";
import { findCharacter, readCharacterRegistry } from "./characterRegistry.mjs";

export const KOYA_ASSET_QUALITY_FINAL_AUDIT_VERSION = "koya-asset-quality-final-audit-v1";
/** 回に含めるサムネの plan の置き場（回のフォルダからの相対）。manifest.outputs.thumbnail.planPath が優先。 */
export const KOYA_EPISODE_THUMBNAIL_PLAN_FILE_NAME = "thumbnail-plan.json";

/**
 * 理由コード（failures に `asset-quality-required:<工程>:<対象>:<理由>` で載る）。
 * 1つの成果物のループの理由（KOYA_ASSET_QUALITY_REASONS）に、完成前の見直しだけが使う理由を足したもの。
 *   take-unrecorded          カットの発話に採用テイク（audio.sourceDialoguePath）の記録が無い
 *   registry-entry-missing   回の画に出る人物・場所が、承認済みとして登録簿に無い
 *   registered-sha-mismatch  登録の時点で合格した版の SHA と、今の参照画（referenceAssets）の SHA が合わない
 *   reference-file-changed   参照画のファイルが、登録簿の SHA と違うバイト列（または無い）
 *   thumbnail-not-final      回に含めたサムネの plan が読めない、または stage が final でない
 *   thumbnail-audit-failed   final のサムネの監査が、品質ループ以外の理由で合格していない
 *   awaiting-human-review    画の台帳・音声の報告に、人の確認待ちの行が残っている
 */
export const KOYA_ASSET_QUALITY_FINAL_AUDIT_REASONS = Object.freeze([
  ...KOYA_ASSET_QUALITY_REASONS,
  "take-unrecorded",
  "registry-entry-missing",
  "registered-sha-mismatch",
  "reference-file-changed",
  "thumbnail-not-final",
  "thumbnail-audit-failed",
  "awaiting-human-review",
]);

const SHA256 = /^[a-f0-9]{64}$/u;
const DETERMINISTIC_IMAGE_JOB_KINDS = new Set(["editorial-plate", "split-page"]);
const MAX_DETAIL_CODES = 8;

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function plain(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readJson(file) {
  if (!text(file)) return null;
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function exists(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function sha256File(file) {
  try {
    return createHash("sha256").update(await readFile(file)).digest("hex");
  } catch {
    return "";
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function resolveFrom(base, value) {
  const raw = text(value);
  if (!raw) return "";
  return isAbsolute(raw) ? resolve(raw) : resolve(base, raw);
}

/** 回が実際に使う画（カット順・重複なし）。どのカットで使ったかも残す。 */
export function koyaEpisodeUsedImages(manifest) {
  const byPath = new Map();
  const add = (cutId, value, via) => {
    const file = text(value) ? resolve(text(value)) : "";
    if (!file) return;
    const row = byPath.get(file) || { path: file, cutIds: [], via: [] };
    if (cutId && !row.cutIds.includes(cutId)) row.cutIds.push(cutId);
    if (!row.via.includes(via)) row.via.push(via);
    byPath.set(file, row);
  };
  for (const cut of Array.isArray(manifest?.cuts) ? manifest.cuts : []) {
    const cutId = text(cut?.id);
    const shots = Array.isArray(cut?.cameraSequence) ? cut.cameraSequence : [];
    const panels = cut?.panelLayout?.enabled === true && Array.isArray(cut.panelLayout.panels) ? cut.panelLayout.panels : [];
    for (const panel of panels) add(cutId, panel?.imagePath, "split-panel");
    for (const shot of shots) add(cutId, shot?.imagePath, "shot");
    if (shots.length === 0 || panels.length > 0) add(cutId, cut?.imagePath, panels.length > 0 ? "split-page" : "cut");
  }
  return [...byPath.values()];
}

function failureDetail(row) {
  return `${row.code}${row.detail ? `（${row.detail}）` : ""}`;
}

async function auditSceneImages({ contract, workDir, episodeId, manifest, plan }) {
  const jobsByOutput = new Map();
  for (const job of Array.isArray(plan?.jobs) ? plan.jobs : []) {
    const output = text(job?.outputPath) ? resolve(job.outputPath) : "";
    if (output && !jobsByOutput.has(output)) jobsByOutput.set(output, job);
  }
  const rows = [];
  const usedJobs = [];
  for (const used of koyaEpisodeUsedImages(manifest)) {
    const job = jobsByOutput.get(used.path) || null;
    if (job && DETERMINISTIC_IMAGE_JOB_KINDS.has(job.kind)) {
      rows.push({ stage: "scene-image", cutIds: used.cutIds, assetPath: used.path, jobId: text(job.id), jobKind: job.kind, required: false, pass: true, reason: "deterministic", code: "" });
      continue;
    }
    // 決定論の板と分割ページの合成のほかは、種類が本編の画（scene-image / split-panel）でなくても
    // 使った画として確かめる。知らない種類を「対象外」に倒すと、そこが迂回路になる。
    if (job) usedJobs.push(job);
    const subjectId = job
      ? koyaSceneImageAssetQualitySubjectId(episodeId, job.id)
      : koyaSceneImageAssetQualitySubjectId(episodeId, `unplanned.${basename(used.path, extname(used.path))}`);
    const checked = await checkKoyaAssetQuality({ contract, workDir, stage: "scene-image", subjectId, assetPath: used.path });
    rows.push({
      stage: "scene-image",
      subjectId,
      cutIds: used.cutIds,
      assetPath: used.path,
      jobId: job ? text(job.id) : "",
      jobKind: job ? text(job.kind) : "unplanned",
      ...(job && !KOYA_SCENE_IMAGE_JOB_KINDS.includes(job.kind) ? { unexpectedKind: true } : {}),
      required: true,
      pass: checked.pass === true,
      reason: checked.reason,
      code: checked.pass === true ? "" : checked.code,
      detail: checked.pass === true ? "" : (job ? checked.detail : `画像計画に無い画（${checked.detail}）`),
      assetSha256: checked.assetSha256 || "",
    });
  }
  return { rows, usedJobs };
}

async function auditVoiceTakes({ contract, workDir, episodeId, manifest }) {
  const utterances = new Map((Array.isArray(manifest?.utterances) ? manifest.utterances : []).map((row) => [text(row?.id), row]));
  const rows = [];
  for (const cut of Array.isArray(manifest?.cuts) ? manifest.cuts : []) {
    const cutId = text(cut?.id);
    const cutUtterances = (Array.isArray(cut?.utteranceIds) ? cut.utteranceIds : [])
      .map((id) => utterances.get(text(id)))
      .filter(Boolean);
    if (!cutId || cutUtterances.length === 0) continue;
    const subjectId = koyaVoiceTakeAssetQualitySubjectId(episodeId, cutId);
    const takes = unique(cutUtterances.map((row) => (text(row?.audio?.sourceDialoguePath) ? resolve(row.audio.sourceDialoguePath) : "")));
    const unrecorded = cutUtterances.filter((row) => !text(row?.audio?.sourceDialoguePath)).map((row) => text(row.id));
    if (unrecorded.length > 0 || takes.length === 0) {
      rows.push({
        stage: "voice-take", subjectId, cutId, assetPath: "", required: true, pass: false, reason: "take-unrecorded",
        code: koyaAssetQualityFailureCode("voice-take", subjectId, "take-unrecorded"),
        detail: `採用テイクの記録（audio.sourceDialoguePath）が無い発話: ${unrecorded.join(", ") || "全部"}`,
      });
    }
    for (const take of takes) {
      const checked = await checkKoyaAssetQuality({ contract, workDir, stage: "voice-take", subjectId, assetPath: take });
      rows.push({
        stage: "voice-take",
        subjectId,
        cutId,
        assetPath: take,
        required: true,
        pass: checked.pass === true,
        reason: checked.reason,
        code: checked.pass === true ? "" : checked.code,
        detail: checked.pass === true ? "" : checked.detail,
        assetSha256: checked.assetSha256 || "",
      });
    }
  }
  return rows;
}

/**
 * 動画クリップ（契約 v55 から）: 差し替えたカットの結び付けが指すクリップそのものの SHA で、工程 video-clip の
 * ループの合格を確かめる。結び付けにクリップのパスが無ければ asset-missing で落とす（静止画へ戻したカットは見ない）。
 */
async function auditVideoClips({ contract, workDir, episodeId, manifest }) {
  if (!koyaVideoClipGateInForce(contract)) return [];
  const rows = [];
  for (const cut of Array.isArray(manifest?.cuts) ? manifest.cuts : []) {
    const binding = cut?.videoSubstitution;
    if (binding?.status !== "applied") continue;
    const cutId = text(cut.id);
    const subjectId = koyaVideoClipAssetQualitySubjectId(episodeId, cutId);
    const clipPath = text(binding.clipPath) ? resolve(binding.clipPath) : "";
    if (!clipPath) {
      rows.push({
        stage: KOYA_VIDEO_CLIP_STAGE, subjectId, cutId, assetPath: "", required: true, pass: false, reason: "asset-missing",
        code: koyaAssetQualityFailureCode(KOYA_VIDEO_CLIP_STAGE, subjectId, "asset-missing"),
        detail: "差し替えの結び付けにクリップのパスが無い",
      });
      continue;
    }
    const checked = await checkKoyaVideoClipAssetQuality({ contract, workDir, episodeId, cutId, clipPath });
    rows.push({
      stage: KOYA_VIDEO_CLIP_STAGE,
      subjectId,
      cutId,
      assetPath: clipPath,
      required: true,
      pass: checked.pass === true,
      reason: checked.reason,
      code: checked.pass === true ? "" : checked.code,
      detail: checked.pass === true ? "" : checked.detail,
      assetSha256: checked.assetSha256 || "",
      boundClipSha256: text(binding.clipSha256),
    });
  }
  return rows;
}

function registryLocationFor(registry, location) {
  if (!plain(location)) return null;
  const id = text(location.id);
  const name = text(location.name);
  return (registry.characters || []).find((entry) => entry.kind === "location" && (
    (id && entry.id === id) || (name && (entry.name === name || (entry.aliases || []).includes(name)))
  )) || null;
}

async function auditRegistryEntry({ entry, kind, canvasDir }) {
  const stage = kind === "location" ? "location" : "character";
  const entrySubject = koyaAssetQualitySubjectId(entry.id);
  const record = plain(entry.approval?.assetQuality) ? entry.approval.assetQuality : null;
  const recordRows = Array.isArray(record?.rows) ? record.rows : [];
  const base = { stage, kind, id: entry.id, subjectId: entrySubject };
  if (!record || recordRows.length === 0) {
    return {
      ...base,
      required: false,
      pass: true,
      outOfForce: true,
      reason: "registered-before-gate",
      code: "",
      detail: "登録の時点で品質ループの合格の記録が無い旧登録（効力の外）。この回の画そのものは scene-image のループで確かめる",
      failures: [],
    };
  }
  const failures = [];
  const current = (Array.isArray(entry.referenceAssets) ? entry.referenceAssets : []).filter((asset) => asset?.role !== "identity-face");
  const registered = new Set(recordRows.map((row) => text(row?.assetSha256).toLowerCase()).filter((value) => SHA256.test(value)));
  const currentShas = new Set(current.map((asset) => text(asset?.sha256).toLowerCase()));
  for (const asset of current) {
    const assetSubject = koyaAssetQualitySubjectId(entry.id, text(asset.id) || text(asset.role) || "reference");
    const declared = text(asset.sha256).toLowerCase();
    if (!registered.has(declared)) {
      failures.push({
        subjectId: assetSubject,
        reason: "registered-sha-mismatch",
        code: koyaAssetQualityFailureCode(stage, assetSubject, "registered-sha-mismatch"),
        detail: `今の参照画 ${text(asset.id) || text(asset.role)} は、登録の時点で品質ループに合格した版ではない（登録の後に差し替わった）`,
      });
      continue;
    }
    const file = resolveFrom(canvasDir, asset.path);
    const actual = file ? await sha256File(file) : "";
    if (actual !== declared) {
      failures.push({
        subjectId: assetSubject,
        reason: "reference-file-changed",
        code: koyaAssetQualityFailureCode(stage, assetSubject, "reference-file-changed"),
        detail: actual ? `参照画のファイルが登録簿の SHA と違うバイト列: ${file}` : `参照画のファイルが無い: ${file || "(path なし)"}`,
      });
    }
  }
  for (const row of recordRows) {
    const value = text(row?.assetSha256).toLowerCase();
    if (currentShas.has(value)) continue;
    const subjectId = text(row?.subjectId) || entrySubject;
    failures.push({
      subjectId,
      reason: "registered-sha-mismatch",
      code: koyaAssetQualityFailureCode(stage, subjectId, "registered-sha-mismatch"),
      detail: "登録の時点で合格した版が、今の参照画に無い（登録の後に参照画が差し替わった）",
    });
  }
  return {
    ...base,
    required: true,
    pass: failures.length === 0,
    outOfForce: false,
    reason: failures.length === 0 ? "passed" : failures[0].reason,
    code: failures[0]?.code || "",
    contractVersion: text(record.contractVersion),
    registeredRows: recordRows.length,
    failures,
  };
}

async function auditRegistry({ canvasDir, usedJobs }) {
  const registry = await readCharacterRegistry({ canvasDir });
  const characterIds = unique(usedJobs.flatMap((job) => (Array.isArray(job?.characterIds) ? job.characterIds.map(text) : [])));
  const rows = [];
  const unregisteredLocations = [];
  for (const id of characterIds) {
    const entry = findCharacter(registry, id);
    if (!entry || entry.kind === "location" || entry.status !== "approved") {
      const subjectId = koyaAssetQualitySubjectId(id);
      rows.push({
        stage: "character", kind: "character", id, subjectId, required: true, pass: false, outOfForce: false,
        reason: "registry-entry-missing",
        code: koyaAssetQualityFailureCode("character", subjectId, "registry-entry-missing"),
        detail: entry ? `登録簿の状態が ${entry.status}（approved ではない）` : "回の画に出る人物が登録簿に無い",
        failures: [],
      });
      continue;
    }
    rows.push(await auditRegistryEntry({ entry, kind: "character", canvasDir }));
  }
  const seenLocations = new Set();
  for (const job of usedJobs) {
    const location = plain(job?.location) ? job.location : null;
    if (!location) continue;
    const key = text(location.id) || text(location.name);
    if (!key || seenLocations.has(key)) continue;
    seenLocations.add(key);
    const entry = registryLocationFor(registry, location);
    if (!entry) {
      // 登録の無い場所は、画像計画が環境アトラスを描き起こして参照にする（正本スキルの既知の挙動）。
      // この監査では落とさず、見える所に出す。
      unregisteredLocations.push({ id: text(location.id), name: text(location.name) });
      continue;
    }
    if (entry.status !== "approved") {
      const subjectId = koyaAssetQualitySubjectId(entry.id);
      rows.push({
        stage: "location", kind: "location", id: entry.id, subjectId, required: true, pass: false, outOfForce: false,
        reason: "registry-entry-missing",
        code: koyaAssetQualityFailureCode("location", subjectId, "registry-entry-missing"),
        detail: `登録簿の状態が ${entry.status}（approved ではない）`,
        failures: [],
      });
      continue;
    }
    rows.push(await auditRegistryEntry({ entry, kind: "location", canvasDir }));
  }
  return { rows, unregisteredLocations };
}

async function auditThumbnail({ contract, projectDir, episodeDir, episodeId, manifest, thumbnailContract, readThumbnailContract, auditThumbnailPlan }) {
  const declared = text(manifest?.outputs?.thumbnail?.planPath);
  const conventional = join(episodeDir, KOYA_EPISODE_THUMBNAIL_PLAN_FILE_NAME);
  const planPath = declared ? resolveFrom(episodeDir, declared) : (await exists(conventional) ? conventional : "");
  if (!planPath) {
    return { included: false, pass: true, detail: `サムネは回の成果物に含まれていない（manifest.outputs.thumbnail.planPath も ${KOYA_EPISODE_THUMBNAIL_PLAN_FILE_NAME} も無い）`, failures: [] };
  }
  const planSubject = koyaAssetQualitySubjectId(episodeId, "thumbnail");
  const failed = (reason, detail, extra = {}) => ({
    included: true,
    planPath,
    pass: false,
    detail,
    failures: [{ subjectId: planSubject, reason, code: koyaAssetQualityFailureCode("thumbnail", planSubject, reason), detail }],
    ...extra,
  });
  const plan = await readJson(planPath);
  if (!plain(plan)) return failed("thumbnail-not-final", `回に含めたサムネの plan を読めない: ${planPath}`);
  if (plan.stage !== "final") return failed("thumbnail-not-final", `回に含めたサムネの plan が final でない（stage=${text(plan.stage) || "なし"}）`);
  let governance = null;
  if (!auditThumbnailPlan || (!thumbnailContract && !readThumbnailContract)) governance = await import("./koyaChannelGovernance.mjs");
  const audit = auditThumbnailPlan || governance.auditKoyaThumbnailPlan;
  let contractForThumbnail = thumbnailContract;
  if (!contractForThumbnail) {
    try {
      contractForThumbnail = readThumbnailContract
        ? await readThumbnailContract({ projectDir })
        : (await governance.readKoyaChannelAuthority({ projectDir })).thumbnailContract;
    } catch (error) {
      return failed("thumbnail-audit-failed", `サムネの契約（Channel Pack）を読めない: ${String(error?.message || error).slice(0, 200)}`);
    }
  }
  let result;
  try {
    result = await audit({ projectDir, thumbnailContract: contractForThumbnail, plan, productionContract: contract });
  } catch (error) {
    return failed("thumbnail-audit-failed", `サムネの final 監査が走らなかった: ${String(error?.message || error).slice(0, 200)}`);
  }
  const loopRows = Array.isArray(result?.assetQuality) ? result.assetQuality : [];
  const failures = loopRows.filter((row) => row?.pass !== true).map((row) => ({
    subjectId: text(row.subjectId), reason: text(row.reason), code: text(row.code), detail: "サムネの専用画の品質ループが合格していない",
  }));
  const otherFailures = (Array.isArray(result?.failures) ? result.failures : []).filter((line) => !String(line).startsWith("asset-quality-required:"));
  if (otherFailures.length > 0 || (result?.pass !== true && failures.length === 0)) {
    failures.push({
      subjectId: planSubject,
      reason: "thumbnail-audit-failed",
      code: koyaAssetQualityFailureCode("thumbnail", planSubject, "thumbnail-audit-failed"),
      detail: otherFailures.slice(0, 3).join(" / ").slice(0, 400) || "サムネの final 監査が合格していない",
    });
  }
  if (loopRows.length === 0 && failures.length === 0) {
    // v54 の契約で final 監査が品質ループの行を1つも出さないのは、専用画が無いか、監査が契約の外で走った。
    failures.push({
      subjectId: planSubject,
      reason: "thumbnail-audit-failed",
      code: koyaAssetQualityFailureCode("thumbnail", planSubject, "thumbnail-audit-failed"),
      detail: "サムネの final 監査が専用画の品質ループを1つも確かめていない",
    });
  }
  return {
    included: true,
    planPath,
    pass: failures.length === 0 && result?.pass === true,
    readyForPublish: result?.readyForPublish === true,
    assetQuality: loopRows,
    failures,
    detail: failures.length === 0 ? "サムネの final 監査が合格（専用画の品質ループを含む）" : `${failures.length} 件`,
  };
}

async function auditAwaitingHumanReview({ episodeId, episodeDir, manifest, planPath, plan }) {
  const state = await readJson(join(episodeDir, "koya-production-state.json"));
  const ledgerCandidates = unique([
    text(state?.imageLedgerPath) ? resolve(state.imageLedgerPath) : "",
    text(plan?.assetDir) ? join(resolve(plan.assetDir), "image-generation-ledger.json") : "",
    planPath ? join(dirname(planPath), "image-generation-ledger.json") : "",
    planPath ? join(dirname(planPath), "script-image-ledger.json") : "",
  ]);
  const failures = [];
  // 状態ファイルが指す台帳を先に、無ければ置き場の既定名の順で、読めた最初の1つだけを見る
  // （古い名前の台帳が残っていても、今の台帳より優先しない）。
  let imageLedgerPath = "";
  let ledger = null;
  for (const candidate of ledgerCandidates) {
    ledger = await readJson(candidate);
    if (plain(ledger)) {
      imageLedgerPath = candidate;
      break;
    }
    ledger = null;
  }
  if (ledger) {
    const ledgerPath = imageLedgerPath;
    for (const [jobId, entry] of Object.entries(plain(ledger.jobs) ? ledger.jobs : {})) {
      if (entry?.status !== "awaiting-human-review") continue;
      const subjectId = text(entry.assetQuality?.subjectId) || koyaSceneImageAssetQualitySubjectId(episodeId, jobId);
      failures.push({
        stage: "scene-image",
        subjectId,
        jobId,
        source: ledgerPath,
        reason: "awaiting-human-review",
        code: koyaAssetQualityFailureCode("scene-image", subjectId, "awaiting-human-review"),
        detail: `画の台帳の行 ${jobId} が人の確認待ち${text(entry.assetQuality?.code) ? `（${entry.assetQuality.code}）` : ""}`,
      });
    }
  }
  const reportPath = text(manifest?.production?.audioPipeline?.reportPath)
    ? resolve(manifest.production.audioPipeline.reportPath)
    : join(episodeDir, "koya-dialogue-generation.json");
  const report = await readJson(reportPath);
  if (plain(report)) {
    const heldCuts = (Array.isArray(report.cuts) ? report.cuts : []).filter((row) => row?.status === "awaiting-human-review");
    for (const row of heldCuts) {
      const subjectId = text(row.assetQuality?.subjectId) || koyaVoiceTakeAssetQualitySubjectId(episodeId, text(row.cutId) || "cut");
      failures.push({
        stage: "voice-take",
        subjectId,
        cutId: text(row.cutId),
        source: reportPath,
        reason: "awaiting-human-review",
        code: koyaAssetQualityFailureCode("voice-take", subjectId, "awaiting-human-review"),
        detail: `音声の報告のカット ${text(row.cutId)} が人の確認待ち${text(row.assetQuality?.code) ? `（${row.assetQuality.code}）` : ""}`,
      });
    }
    if (report.status === "awaiting-human-review" && heldCuts.length === 0) {
      const subjectId = koyaAssetQualitySubjectId(episodeId, "speech");
      failures.push({
        stage: "voice-take",
        subjectId,
        source: reportPath,
        reason: "awaiting-human-review",
        code: koyaAssetQualityFailureCode("voice-take", subjectId, "awaiting-human-review"),
        detail: "音声の報告が人の確認待ちのまま",
      });
    }
  }
  return { imageLedgerPath, speechReportPath: plain(report) ? reportPath : "", failures };
}

/**
 * 回の途中の成果物の品質ループを、完成の前に確かめ直す（最終監査の asset-quality-loops）。
 * 例外は、manifest が無いなど監査そのものが成り立たないときだけ。成果物ごとの不足は failures に出す。
 */
export async function auditKoyaEpisodeAssetQuality({
  contract,
  manifest,
  manifestPath,
  projectDir = "",
  canvasDir = "",
  thumbnailContract = null,
  readThumbnailContract = null,
  auditThumbnailPlan = null,
} = {}) {
  if (!plain(manifest)) throw new Error("auditKoyaEpisodeAssetQuality requires the episode manifest.");
  const episodeId = text(manifest.id);
  if (!episodeId) throw new Error("auditKoyaEpisodeAssetQuality requires manifest.id.");
  const contractVersion = text(contract?.contract?.version || contract?.version);
  const base = {
    version: KOYA_ASSET_QUALITY_FINAL_AUDIT_VERSION,
    auditId: KOYA_ASSET_QUALITY_FINAL_AUDIT_ID,
    episodeId,
    contractVersion,
    inForceSince: KOYA_ASSET_QUALITY_GATE_IN_FORCE_SINCE,
  };
  if (!koyaAssetQualityGateInForce(contract)) {
    return {
      ...base,
      applicable: false,
      pass: true,
      detail: `対象外: 契約 ${contractVersion || "(版なし)"} は ${KOYA_ASSET_QUALITY_GATE_IN_FORCE_SINCE} より前`,
      failures: [],
      outOfForce: [],
    };
  }
  const episodeDir = manifestPath ? dirname(resolve(manifestPath)) : "";
  const canvas = text(canvasDir)
    ? resolve(canvasDir)
    : episodeDir ? resolve(episodeDir, "..", "..") : join(resolve(text(projectDir) || process.cwd()), "canvas");
  const workDir = koyaAssetQualityWorkDir({ canvasDir: canvas });
  const project = text(projectDir) ? resolve(projectDir) : dirname(canvas);
  const planPath = text(manifest.production?.imagePlan?.path)
    ? resolve(manifest.production.imagePlan.path)
    : join(canvas, "assets", episodeId, "script-image-plan.json");
  const plan = await readJson(planPath);

  const scene = await auditSceneImages({ contract, workDir, episodeId, manifest, plan });
  const voiceTakes = await auditVoiceTakes({ contract, workDir, episodeId, manifest });
  const videoClips = await auditVideoClips({ contract, workDir, episodeId, manifest });
  const registry = await auditRegistry({ canvasDir: canvas, usedJobs: scene.usedJobs });
  const thumbnail = await auditThumbnail({
    contract, projectDir: project, episodeDir: episodeDir || join(canvas, "manga-videos", episodeId), episodeId, manifest,
    thumbnailContract, readThumbnailContract, auditThumbnailPlan,
  });
  const awaiting = await auditAwaitingHumanReview({
    episodeId, episodeDir: episodeDir || join(canvas, "manga-videos", episodeId), manifest, planPath, plan,
  });

  const failures = [
    ...(plan ? [] : [{
      stage: "scene-image",
      subjectId: koyaAssetQualitySubjectId(episodeId, "image-plan"),
      reason: "asset-missing",
      code: koyaAssetQualityFailureCode("scene-image", koyaAssetQualitySubjectId(episodeId, "image-plan"), "asset-missing"),
      detail: `画像計画を読めない（どの画がどの行か決められない）: ${planPath}`,
    }]),
    ...scene.rows.filter((row) => row.required && !row.pass),
    ...voiceTakes.filter((row) => !row.pass),
    ...videoClips.filter((row) => !row.pass),
    ...registry.rows.flatMap((row) => (row.pass ? [] : (row.failures?.length ? row.failures.map((entry) => ({ stage: row.stage, ...entry })) : [row]))),
    ...thumbnail.failures.map((entry) => ({ stage: "thumbnail", ...entry })),
    ...awaiting.failures,
  ].map((row) => ({ stage: row.stage, subjectId: row.subjectId || "", reason: row.reason, code: row.code, detail: row.detail || "" }));
  const codes = unique(failures.map((row) => row.code));
  const outOfForce = registry.rows.filter((row) => row.outOfForce).map((row) => ({ kind: row.kind, id: row.id, reason: row.reason }));
  const counts = {
    sceneImages: scene.rows.filter((row) => row.required).length,
    voiceTakes: voiceTakes.length,
    videoClips: videoClips.length,
    registryEntries: registry.rows.length,
    outOfForce: outOfForce.length,
    unregisteredLocations: registry.unregisteredLocations.length,
    thumbnailIncluded: thumbnail.included === true,
  };
  const pass = failures.length === 0;
  return {
    ...base,
    applicable: true,
    pass,
    workDir,
    imagePlanPath: planPath,
    counts,
    detail: pass
      ? `passed（画 ${counts.sceneImages}・声 ${counts.voiceTakes}${counts.videoClips ? `・動画クリップ ${counts.videoClips}` : ""}・人物/場所 ${counts.registryEntries}`
        + `${counts.outOfForce ? `、効力の外の旧登録 ${counts.outOfForce}` : ""}`
        + `${counts.unregisteredLocations ? `、登録の無い場所 ${counts.unregisteredLocations}` : ""}`
        + `${counts.thumbnailIncluded ? "、サムネ" : ""}）`
      : `${codes.length} 件: ${failures.slice(0, MAX_DETAIL_CODES).map(failureDetail).join("; ")}${failures.length > MAX_DETAIL_CODES ? " …" : ""}`,
    failures,
    codes,
    outOfForce,
    unregisteredLocations: registry.unregisteredLocations,
    sceneImages: scene.rows,
    voiceTakes,
    videoClips,
    registry: registry.rows,
    thumbnail,
    awaitingHumanReview: awaiting,
  };
}

/** 最終監査の step（record に渡す形）。監査が例外で成り立たなかったときも理由つきで落とす。 */
export function koyaAssetQualityFinalAuditStep(report, evidencePath = "") {
  return {
    id: KOYA_ASSET_QUALITY_FINAL_AUDIT_ID,
    pass: report?.pass === true,
    detail: text(report?.detail) || (report?.pass === true ? "passed" : "asset quality loops were not verified"),
    evidencePath,
    extra: {
      applicable: report?.applicable !== false,
      failureCount: Array.isArray(report?.failures) ? report.failures.length : 0,
      outOfForce: Array.isArray(report?.outOfForce) ? report.outOfForce : [],
    },
  };
}
