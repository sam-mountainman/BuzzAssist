// 途中の成果物を「使う前に」品質ループ（lib/assetQualityLoop.mjs）の合格を確かめる照合（ジャンル共通）。
//
// 「合格」は assetQualityStatus の pass === true だけ——別文脈の評価者の採点で合格し、要る人の確認が
// 揃い、使おうとしているファイルが合格した版と同じバイト列。ここは判定を作り直さず、その結果を
// 理由コードへ写すだけ（2つ目の判定を持たない）。
//
// 漫画（lib/koyaAssetQualityGate.mjs）は、契約の版で効力を決めたうえでここを呼ぶ。ナレーション物語の
// サムネ（lib/thumbnailPlanHarnesses.mjs）も同じ照合を使う。理由コードの形は両方で同じ:
//   asset-quality-required:<工程>:<対象>:<理由>
//
// 理由:
//   loop-not-started      その成果物のループが始まっていない（評価者の採点が1回も無い）
//   not-passed            ループはあるが合格していない（採点が不合格・人の確認待ち・人の否・上限で停止）
//   asset-sha-mismatch    使おうとしているファイルが、合格した版と違うバイト列
//   asset-missing         使おうとしているファイル、または合格した版のファイルが無い
//   outside-work-dir      ファイルが作業フォルダの外にある。ループは作業フォルダの中の成果物しか記録しない

import path from "node:path";

import { assetQualityStatus } from "./assetQualityLoop.mjs";

export const ASSET_QUALITY_USE_REASONS = Object.freeze([
  "loop-not-started",
  "not-passed",
  "asset-sha-mismatch",
  "asset-missing",
  "outside-work-dir",
]);

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** 失敗の行（機械で読める1行）。漫画の koyaAssetQualityFailureCode と同じ形（試験が一致を見る）。 */
export function assetQualityUseFailureCode(stage, subjectId, reason) {
  return `asset-quality-required:${stage}:${subjectId}:${reason}`;
}

/**
 * root の中（root そのものは除く）か。pathApi を差し替えると Windows の区切り（path.win32）でも
 * 同じ判定になる（試験が見る）。
 */
export function insideWorkDir(root, file, { pathApi = path } = {}) {
  const rel = pathApi.relative(root, file);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(rel);
}

/**
 * 1つの成果物のループの合格を確かめる。例外は投げない（呼び出し側が止め方を決める）。
 * harnessId は、ループが始まっていないときの案内（start の引数）にだけ使う。
 * 戻り値: { stage, subjectId, assetPath, required, pass, reason, code, issues, detail, status, assetSha256? }
 */
export async function checkAssetQualityBeforeUse({
  harnessId = "",
  workDir,
  stage,
  subjectId,
  assetPath,
  status = assetQualityStatus,
} = {}) {
  const base = { stage, subjectId, assetPath: text(assetPath) };
  const root = path.resolve(workDir);
  const file = path.resolve(root, text(assetPath));
  const failed = (reason, issues, detail, extra = {}) => ({
    ...base, required: true, pass: false, reason, code: assetQualityUseFailureCode(stage, subjectId, reason), issues, detail, ...extra,
  });
  if (!text(assetPath) || !insideWorkDir(root, file)) {
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
    return failed("loop-not-started", issues, `品質ループが始まっていない（node scripts/asset-quality-loop.mjs start --work-dir <canvas> --harness ${harnessId || "<harness>"} --stage ${stage} --subject ${subjectId} から回す）`, extra);
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
export function assetQualityUseFailureLines(rows = []) {
  return rows.filter((row) => row && row.pass !== true).map((row) => {
    const issues = (row.issues || []).filter((issue) => issue !== "asset-quality-loop-not-started");
    return `${row.code}（${row.detail}${issues.length ? `: ${issues.join(", ")}` : ""}）`;
  });
}
