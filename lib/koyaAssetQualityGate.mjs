// 漫画（koya-manga-video）の公式経路で、途中の成果物（人物の設定画・背景・本編の画・サムネ・声のテイク）を
// 使う前に、品質ループ（lib/assetQualityLoop.mjs）の合格を要求する照合の実体。
//
// 「合格」は assetQualityStatus の pass === true だけ——別文脈の評価者の採点で合格し、要る人の確認が
// 揃い、使おうとしているファイルが合格した版と同じバイト列。ここは判定を作り直さず、その結果を
// 工程ごとの理由コードへ写すだけ（2つ目の判定を持たない）。
//
// 契約の版で効力を決める（lib/koyaAssetQualityGatePolicy.mjs）。v54 より前の契約では何も要求しない。
// 照合そのもの（状態 → 理由コード）はジャンル共通の lib/assetQualityUseGate.mjs にある。

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { APPROVED_REFERENCES_VERSION, assetQualityStatus, listAssetQualityStatus } from "./assetQualityLoop.mjs";
import { assetQualityUseFailureLines, checkAssetQualityBeforeUse } from "./assetQualityUseGate.mjs";
import { writeJsonAtomic } from "./atomicJsonFile.mjs";
import { readCharacterWorkflowStore } from "./characterPipeline.mjs";
import { readCharacterRegistry } from "./characterRegistry.mjs";
import {
  KOYA_APPROVED_REFERENCES_RELATIVE_PATH,
  KOYA_ASSET_QUALITY_GATE_IN_FORCE_SINCE,
  KOYA_ASSET_QUALITY_HARNESS_ID,
  KOYA_ASSET_QUALITY_REQUIRED_CODE,
  KOYA_ASSET_QUALITY_WORK_DIR,
  KOYA_SCENE_IMAGE_JOB_KINDS,
  KOYA_VIDEO_CLIP_GATE_IN_FORCE_SINCE,
  KOYA_VIDEO_CLIP_STAGE,
  koyaAssetQualityGateInForce,
  koyaSceneImageAssetQualitySubjectId,
  koyaVideoClipAssetQualitySubjectId,
  koyaVideoClipGateInForce,
  koyaVoiceTakeAssetQualitySubjectId,
} from "./koyaAssetQualityGatePolicy.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** 品質ループの作業フォルダ（canvas/）。canvasDir を渡せばそれ、無ければ <projectDir>/canvas。 */
export function koyaAssetQualityWorkDir({ projectDir = "", canvasDir = "" } = {}) {
  if (text(canvasDir)) return path.resolve(canvasDir);
  return path.join(path.resolve(text(projectDir) || process.cwd()), KOYA_ASSET_QUALITY_WORK_DIR);
}

export function koyaApprovedReferencesPath(options = {}) {
  return path.join(koyaAssetQualityWorkDir(options), KOYA_APPROVED_REFERENCES_RELATIVE_PATH);
}

/**
 * 1つの成果物のループの合格を確かめる。例外は投げない（呼び出し側が止め方を決める）。
 * 照合の本体はジャンル共通の lib/assetQualityUseGate.mjs（ナレーション物語のサムネも同じものを使う）。
 * ここが足すのは契約の版による効力の判定だけ。
 * 戻り値: { stage, subjectId, assetPath, required, pass, reason, code, issues, detail, status }
 */
export async function checkKoyaAssetQuality({
  contract,
  workDir,
  stage,
  subjectId,
  assetPath,
  status = assetQualityStatus,
} = {}) {
  if (!koyaAssetQualityGateInForce(contract)) {
    return { stage, subjectId, assetPath: text(assetPath), required: false, pass: true, reason: "not-in-force", code: "", issues: [], detail: `契約が ${KOYA_ASSET_QUALITY_GATE_IN_FORCE_SINCE} より前なので求めない`, status: "not-in-force" };
  }
  return checkAssetQualityBeforeUse({ harnessId: KOYA_ASSET_QUALITY_HARNESS_ID, workDir, stage, subjectId, assetPath, status });
}

/**
 * カットを動画に差し替える経路のクリップ（工程 video-clip）の合格を確かめる。例外は投げない。
 * 効力は契約 v55 から（koyaVideoClipGateInForce）。照合の本体は checkKoyaAssetQuality と同じ
 * lib/assetQualityUseGate.mjs。戻り値の形も同じ（理由は before-use の語彙）。
 */
export async function checkKoyaVideoClipAssetQuality({
  contract,
  workDir,
  episodeId,
  cutId,
  clipPath,
  status = assetQualityStatus,
} = {}) {
  const subjectId = koyaVideoClipAssetQualitySubjectId(episodeId, cutId);
  if (!koyaVideoClipGateInForce(contract)) {
    return { stage: KOYA_VIDEO_CLIP_STAGE, subjectId, assetPath: text(clipPath), required: false, pass: true, reason: "not-in-force", code: "", issues: [], detail: `契約が ${KOYA_VIDEO_CLIP_GATE_IN_FORCE_SINCE} より前なので求めない`, status: "not-in-force" };
  }
  return checkAssetQualityBeforeUse({ harnessId: KOYA_ASSET_QUALITY_HARNESS_ID, workDir, stage: KOYA_VIDEO_CLIP_STAGE, subjectId, assetPath: clipPath, status });
}

/** 複数の結果から、合格していない行だけを機械で読める1行ずつにする（ジャンル共通の書き方）。 */
export function koyaAssetQualityFailureLines(rows = []) {
  return assetQualityUseFailureLines(rows);
}

/** 合格していない行があれば止める（登録・承認のような1回の操作用）。 */
export function assertKoyaAssetQualityRows(rows = [], context = "asset") {
  const failing = rows.filter((row) => row && row.pass !== true);
  if (failing.length === 0) return;
  const error = new Error(`${context} requires a passed asset quality loop for every asset before use: ${koyaAssetQualityFailureLines(failing).join("; ")}`);
  error.code = KOYA_ASSET_QUALITY_REQUIRED_CODE;
  error.assetQuality = failing.map(({ stage, subjectId, assetPath, reason, code, issues }) => ({ stage, subjectId, assetPath, reason, code, issues }));
  throw error;
}

function referenceRow(sha, kind, id) {
  return { sha256: sha, kind, id };
}

/**
 * 参照の照合に使う承認一覧（buzzassist-approved-references-v1）の中身を作る。
 *   - 登録簿で approved の人物・場所の参照画（referenceAssets の SHA。登録時に拘束した値。ファイル名は使わない）
 *   - 匿名の候補から人が選んだ顔（候補の判定 verdictDigest を持ち、identity pack の生成へ進んだもの）。
 *     identity pack の各シートは、この顔を参照にしてループを回す（登録はシートの合格の後）
 *   - 本編の画のループで合格した版（カットを動画に差し替えるクリップの元の画。種類 scene-image:passed-loop）
 *   - 呼び出し側が渡す追加の行（承認済みの場所の基準画など。SHA と種類だけ）
 */
export async function collectKoyaApprovedReferences({ projectDir = "", canvasDir = "", extraReferences = [] } = {}) {
  const workDir = koyaAssetQualityWorkDir({ projectDir, canvasDir });
  const registry = await readCharacterRegistry({ canvasDir: workDir });
  const rows = [];
  for (const entry of registry.characters || []) {
    if (entry?.status !== "approved") continue;
    for (const asset of entry.referenceAssets || []) {
      const value = text(asset?.sha256).toLowerCase();
      if (SHA256.test(value)) rows.push(referenceRow(value, `${text(entry.kind) || "character"}:${text(asset.role) || "reference"}`, `${text(entry.id)}.${text(asset.id)}`));
    }
  }
  let workflows = [];
  try {
    workflows = (await readCharacterWorkflowStore({ canvasDir: workDir })).workflows || [];
  } catch {
    workflows = [];
  }
  for (const workflow of workflows) {
    for (const cast of workflow?.cast || []) {
      const face = text(cast?.identityPack?.selectedFace?.sha256).toLowerCase();
      if (!SHA256.test(face) || !text(cast?.approval?.verdictDigest)) continue;
      rows.push(referenceRow(face, "character:selected-face", `${text(cast.id)}.selected-face`));
    }
  }
  // 本編の画のループで合格した版。カットを動画に差し替えるクリップ（工程 video-clip。契約 v55 から）は、この
  // 「元の画」を参照にしてループを回す。合格は assetQualityStatus の pass（別文脈の評価者の採点・要る人の確認・
  // 合格した版のファイルが今も同じ）だけで、ファイル名や台帳の complete では数えない。
  let scenes = { entries: [] };
  try {
    scenes = await listAssetQualityStatus({ workDir, stage: "scene-image" });
  } catch {
    scenes = { entries: [] };
  }
  for (const entry of scenes.entries || []) {
    if (entry.pass !== true) continue;
    const status = await assetQualityStatus({ workDir, stage: "scene-image", subjectId: entry.subjectId });
    const value = text(status.check?.assetSha256).toLowerCase();
    if (status.pass === true && SHA256.test(value)) rows.push(referenceRow(value, "scene-image:passed-loop", entry.subjectId));
  }
  for (const row of Array.isArray(extraReferences) ? extraReferences : []) {
    const value = text(row?.sha256).toLowerCase();
    if (SHA256.test(value)) rows.push(referenceRow(value, text(row.kind) || "reference", text(row.id)));
  }
  const seen = new Set();
  const references = rows
    .filter((row) => (seen.has(row.sha256) ? false : (seen.add(row.sha256), true)))
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id) || left.sha256.localeCompare(right.sha256));
  return { version: APPROVED_REFERENCES_VERSION, source: "koya-registry-and-blind-verdicts", references };
}

/** 承認一覧を <canvas>/quality/approved-references.json に書く（record の --approved-references に渡す）。 */
export async function writeKoyaApprovedReferences(options = {}) {
  const body = await collectKoyaApprovedReferences(options);
  const file = koyaApprovedReferencesPath(options);
  await writeJsonAtomic(file, body);
  return { path: file, sha256: sha256(await readFile(file)), count: body.references.length };
}

/**
 * 本編の画の行ごとのゲート（lib/mangaScriptImagePipeline.mjs の assetQualityGate に渡す）。
 * 契約が v54 より前なら null（パイプラインは従来どおり動く）。
 */
export function createKoyaSceneImageAssetQualityGate({ contract, canvasDir, episodeId } = {}) {
  if (!koyaAssetQualityGateInForce(contract)) return null;
  const workDir = koyaAssetQualityWorkDir({ canvasDir });
  return async ({ job, outputPath }) => {
    if (!KOYA_SCENE_IMAGE_JOB_KINDS.includes(job?.kind)) return { required: false, pass: true, reason: "not-a-scene-image" };
    return checkKoyaAssetQuality({
      contract,
      workDir,
      stage: "scene-image",
      subjectId: koyaSceneImageAssetQualitySubjectId(episodeId, job.id),
      assetPath: outputPath,
    });
  };
}

/**
 * 声のテイクのゲート（lib/koyaDialogueSpeech.mjs が、採用するテイクを台帳へ書く前に呼ぶ）。
 * 契約が v54 より前なら null。
 */
export function createKoyaVoiceTakeAssetQualityGate({ contract, canvasDir, episodeId } = {}) {
  if (!koyaAssetQualityGateInForce(contract)) return null;
  const workDir = koyaAssetQualityWorkDir({ canvasDir });
  return async ({ cutId, takePath }) => checkKoyaAssetQuality({
    contract,
    workDir,
    stage: "voice-take",
    subjectId: koyaVoiceTakeAssetQualitySubjectId(episodeId, cutId),
    assetPath: takePath,
  });
}
