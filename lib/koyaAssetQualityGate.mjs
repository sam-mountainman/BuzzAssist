// 漫画（koya-manga-video）の公式経路で、途中の成果物（人物の設定画・背景・本編の画・サムネ・声のテイク）を
// 使う前に、品質ループ（lib/assetQualityLoop.mjs）の合格を要求する照合の実体。
//
// 「合格」は assetQualityStatus の pass === true だけ——別文脈の評価者の採点で合格し、要る人の確認が
// 揃い、使おうとしているファイルが合格した版と同じバイト列。ここは判定を作り直さず、その結果を
// 工程ごとの理由コードへ写すだけ（2つ目の判定を持たない）。
//
// 契約の版で効力を決める（lib/koyaAssetQualityGatePolicy.mjs）。v54 より前の契約では何も要求しない。

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { APPROVED_REFERENCES_VERSION, assetQualityStatus } from "./assetQualityLoop.mjs";
import { writeJsonAtomic } from "./atomicJsonFile.mjs";
import { readCharacterWorkflowStore } from "./characterPipeline.mjs";
import { readCharacterRegistry } from "./characterRegistry.mjs";
import {
  KOYA_APPROVED_REFERENCES_RELATIVE_PATH,
  KOYA_ASSET_QUALITY_GATE_IN_FORCE_SINCE,
  KOYA_ASSET_QUALITY_REQUIRED_CODE,
  KOYA_ASSET_QUALITY_WORK_DIR,
  KOYA_SCENE_IMAGE_JOB_KINDS,
  koyaAssetQualityFailureCode,
  koyaAssetQualityGateInForce,
  koyaSceneImageAssetQualitySubjectId,
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

function insideDir(dir, file) {
  const rel = path.relative(dir, file);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * 1つの成果物のループの合格を確かめる。例外は投げない（呼び出し側が止め方を決める）。
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
  const base = { stage, subjectId, assetPath: text(assetPath) };
  if (!koyaAssetQualityGateInForce(contract)) {
    return { ...base, required: false, pass: true, reason: "not-in-force", code: "", issues: [], detail: `契約が ${KOYA_ASSET_QUALITY_GATE_IN_FORCE_SINCE} より前なので求めない`, status: "not-in-force" };
  }
  const root = path.resolve(workDir);
  const file = path.resolve(root, text(assetPath));
  const failed = (reason, issues, detail, extra = {}) => ({
    ...base, required: true, pass: false, reason, code: koyaAssetQualityFailureCode(stage, subjectId, reason), issues, detail, ...extra,
  });
  if (!text(assetPath) || !insideDir(root, file)) {
    return failed("outside-work-dir", [], `成果物は品質ループの作業フォルダ（${root}）の中に置いてから、ループを回す`, { status: "outside-work-dir" });
  }
  const result = await status({ workDir: root, stage, subjectId, assetPath: file });
  const issues = [...(result.issues || [])];
  if (result.pass === true) {
    return { ...base, required: true, pass: true, reason: "passed", code: "", issues: [], detail: "品質ループの合格（評価者の採点・要る人の確認・合格した版と同じファイル）", status: "passed", assetSha256: result.check?.candidateAssetSha256 || "" };
  }
  const extra = {
    status: result.check?.status || "not-started",
    assetSha256: result.check?.candidateAssetSha256 || "",
    reviewedSha256: result.check?.assetSha256 || "",
  };
  if (!result.started) {
    return failed("loop-not-started", issues, `品質ループが始まっていない（node scripts/asset-quality-loop.mjs start --work-dir <canvas> --harness koya-manga-video --stage ${stage} --subject ${subjectId} から回す）`, extra);
  }
  if (issues.some((issue) => issue === "asset-quality-candidate-missing" || issue === "asset-quality-asset-missing")) {
    return failed("asset-missing", issues, "使おうとしているファイル、または合格した版のファイルが無い", extra);
  }
  if (issues.some((issue) => issue === "asset-quality-candidate-not-reviewed-version" || issue === "asset-quality-asset-changed-after-review")) {
    return failed("asset-sha-mismatch", issues, "使おうとしているファイルが、品質ループで採点した版と違うバイト列。今のファイルを新しい版として採点し直す", extra);
  }
  return failed("not-passed", issues, result.detail || "品質ループが合格していない", extra);
}

/** 複数の結果から、合格していない行だけを機械で読める1行ずつにする。 */
export function koyaAssetQualityFailureLines(rows = []) {
  return rows.filter((row) => row && row.pass !== true).map((row) => {
    const issues = (row.issues || []).filter((issue) => issue !== "asset-quality-loop-not-started");
    return `${row.code}（${row.detail}${issues.length ? `: ${issues.join(", ")}` : ""}）`;
  });
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
