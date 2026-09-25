/**
 * ナレーション物語の公式経路の試験で、途中の成果物の品質ループ（lib/assetQualityLoop.mjs）を本物の実装で回す
 * 合成の手順。ループの判定を差し替えず、start → 別文脈の評価者の採点 → record → 人の確認（要る欄だけ）を
 * 実際に書く。評価者・人の名前・会話 id・所見はすべて合成の値。
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  APPROVED_REFERENCES_VERSION,
  assetQualityStage,
  assetQualityStatus,
  recordAssetHumanVerification,
  recordAssetQualityRound,
  startAssetQualityLoop,
} from "../../lib/assetQualityLoop.mjs";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const IDENTITY_NOTES = { face: "輪郭と目の形を参照と並べて見た", hair: "分け目と前髪の形を並べて見た", body: "頭身と肩幅を並べて見た" };

let evaluatorCounter = 0;
/** 回ごとに新しい評価文脈（作った文脈とも前の回とも違う）。 */
export function freshEvaluatorContext(label = "fixture-asset-eval") {
  evaluatorCounter += 1;
  return `${label}-${process.pid}-${evaluatorCounter}`;
}

/** 承認済みの参照の一覧（buzzassist-approved-references-v1）を書く。 */
export async function writeApprovedReferences(file, shas) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ version: APPROVED_REFERENCES_VERSION, references: shas.map((sha) => ({ sha256: sha, kind: "character-identity" })) }, null, 2)}\n`);
  return file;
}

function scoresFor(contract, overrides = {}) {
  // 二値の安全項目（下限 100）は満点、ほかは 95（目標 90 を越え、どの下限も割らない）。
  return Object.fromEntries(contract.rubric.map((row) => [row.id, overrides[row.id] ?? (row.minimumScore >= 100 ? 100 : 95)]));
}

/**
 * 1つの対象のループを、1回の採点で進める。scores を渡すと低い点で不合格の回も作れる。
 * humanVerdict: "pass"（要る欄を全部可にする）/ "reject" / null（人の確認をしない）
 */
export async function recordAssetLoopRound({
  workDir,
  stage,
  subjectId,
  assetPath,
  harnessId = "narrated-story-video",
  generatorContextId = "fixture-asset-maker",
  producerHost = "buzzassist",
  route = "broker",
  references = [],
  approvedReferencesPath = "",
  measurementPath = "",
  charactersVisible = null,
  referenceExemptReason = "",
  scores = {},
  versionLabel = "",
  humanVerdict = "pass",
  evaluatorContextId = "",
  revisionDelta = "",
}) {
  const spec = assetQualityStage(stage);
  const before = await assetQualityStatus({ workDir, stage, subjectId });
  if (!before.started) {
    const started = await startAssetQualityLoop({ workDir, harnessId, stage, subjectId, generatorContextId, generatorHost: producerHost });
    if (!started.started) throw new Error(`fixture could not start the ${stage} loop: ${started.issues.join(", ")}`);
  }
  const state = (await assetQualityStatus({ workDir, stage, subjectId })).state;
  const contract = state.asset.contract;
  const absoluteAsset = path.resolve(workDir, assetPath);
  const assetSha = sha256(await readFile(absoluteAsset));
  const refs = references.map((value) => (/^[a-f0-9]{64}$/u.test(value) ? value : null)).filter(Boolean);
  const context = evaluatorContextId || freshEvaluatorContext();
  const visible = charactersVisible ?? refs.length > 0;
  const review = {
    evaluatorId: "fixture-evaluator",
    evaluatorContextId: context,
    evaluatorHost: "codex",
    assetSha256: assetSha,
    ...(spec.reviewRequirements.includes("charactersVisible") ? { charactersVisible: visible } : {}),
    ...(spec.reviewRequirements.includes("viewedAtDecidedSize") ? { viewedAtDecidedSize: true } : {}),
    ...(refs.length > 0 ? { comparedReferenceSha256s: refs, identityComparison: IDENTITY_NOTES } : {}),
    rubricScores: scoresFor(contract, scores),
    notes: `原寸で全体を見て（声は前後と続けて聞いて）判断した（合成の所見・${context}）`,
    findings: [],
  };
  const reviewRel = path.posix.join("review", "asset-loop", `${stage}--${subjectId}--${context}.json`);
  await mkdir(path.join(workDir, "review", "asset-loop"), { recursive: true });
  await writeFile(path.join(workDir, ...reviewRel.split("/")), `${JSON.stringify(review, null, 2)}\n`);
  const rounds = state.rounds?.length || 0;
  const previousFailure = rounds > 0 ? state.rounds[rounds - 1].failureFingerprint : "";
  const recorded = await recordAssetQualityRound({
    workDir,
    stage,
    subjectId,
    assetPath: absoluteAsset,
    versionLabel: versionLabel || `v${rounds + 1}`,
    reviewPath: path.join(workDir, ...reviewRel.split("/")),
    producerContexts: [generatorContextId],
    producerHost,
    generationRoute: route,
    references: refs,
    ...(refs.length === 0 && spec.referencePolicy === "required-or-exempt"
      ? { referenceExemptReason: referenceExemptReason || "人物が写らない合成の場面" }
      : {}),
    ...(approvedReferencesPath ? { approvedReferencesPath } : {}),
    ...(measurementPath ? { measurementPath: path.resolve(workDir, measurementPath) } : {}),
    ...(previousFailure ? { previousFailureFingerprint: previousFailure, revisionDelta: revisionDelta || "指摘された点を直した（合成）" } : {}),
  });
  if (!recorded.recorded) throw new Error(`fixture could not record the ${stage} round for ${subjectId}: ${recorded.issues.join(", ")}`);
  const missing = recorded.check?.humanVerification?.missing || [];
  if (humanVerdict && missing.length > 0) {
    await verifyAssetLoop({ workDir, stage, subjectId, assetPath: absoluteAsset, checks: missing, verdict: humanVerdict });
  }
  return assetQualityStatus({ workDir, stage, subjectId, assetPath: absoluteAsset });
}

/** 人の確認（対話端末＋--human-verified と同じ記録）。 */
export function verifyAssetLoop({ workDir, stage, subjectId, assetPath, checks, verdict = "pass" }) {
  return recordAssetHumanVerification({
    workDir,
    stage,
    subjectId,
    assetPath: path.resolve(workDir, assetPath),
    checks,
    verdict,
    reviewer: "fixture-human-reviewer",
    note: "原寸で参照と並べ、手元を拡大して見た（合成）",
    humanVerified: true,
    isInteractive: true,
  });
}

/**
 * pipeline が返した assetQualityLoop.pending のうち、Job の作業フォルダで回せるもの（broker の本編の画と
 * 声のテイク）を合格させる。運営者の画と人物の設定画は、運営者の作業フォルダで前もって回しておく。
 */
export async function passPendingNarratedAssetLoops(outcome) {
  const pending = outcome?.assetQualityLoop?.pending || [];
  for (const item of pending) {
    if (item.stage === "scene-image" && item.source === "broker") {
      await recordAssetLoopRound({
        workDir: item.workDir,
        stage: "scene-image",
        subjectId: item.subjectId,
        assetPath: item.assetPath,
        generatorContextId: item.generatorContextId,
        route: "broker",
      });
    } else if (item.stage === "voice-take" && item.reason !== "voice-quality-gate-failed") {
      await recordAssetLoopRound({
        workDir: item.workDir,
        stage: "voice-take",
        subjectId: item.subjectId,
        assetPath: item.assetPath,
        generatorContextId: item.generatorContextId,
        route: "broker",
        measurementPath: item.measurementPath,
      });
    }
  }
  return pending;
}

/**
 * pipeline を回し、途中の成果物の品質ループで止まったら pending を合格させてもう一度回す（運営者の画は
 * 有料の処理の前に1回、声のテイクは生成の後に1回止まり得るので、最大2回）。
 */
export async function runPastAssetLoops(run, { onStop = null } = {}) {
  let outcome = await run();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const pending = outcome?.assetQualityLoop?.pending || [];
    if (outcome?.assetQualityLoop?.pass !== false || pending.length === 0) break;
    if (typeof onStop === "function") await onStop(outcome);
    await passPendingNarratedAssetLoops(outcome);
    outcome = await run();
  }
  return outcome;
}
