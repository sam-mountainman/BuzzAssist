// 途中の成果物の品質ループ（lib/assetQualityLoop.mjs）が合格しなかった回と、人の確認で否とされた
// 成果物から、学習候補を機械的に取り出して Channel Pack の提案台帳へ積む。
//
// 台本の品質ループの自動捕捉（lib/scriptQualityLearning.mjs）と同じ規則で動く:
//
//   - **書くのは提案台帳への追記だけ**（captureLearningProposal）。正本（スキル・要求台帳）と overlay には触らない
//   - **本文には工程・失敗指紋・評価項目 id・機械ゲート id・人の確認の欄 id だけ**。プロンプト・台本・
//     採点の所見・対象の id（人物名になりうる）・パス・人名は入れない。件数は evidence 側に置く
//     （同じ失敗を別の成果物から拾ったとき、同じ提案の再発として数えるため）
//   - **冪等**。同じ失敗指紋を同じ版から二重に積まない（session に版と指紋の digest を使う）
//   - **宛先はそのハーネスの Channel Pack の非公開台帳**（HARNESS_LEARNING_ROUTES[harness].channel）。
//     ジャンル・共通層へ一般化するのは、人が target を明示して別の提案として capture するときだけ
//   - **提案ゼロを正常とする**。合格した回からは何も積まない
//   - **ループを止めない**。捕捉に失敗しても回の記録は変えず、理由を返すだけ
//   - 子エージェント（BUZZASSIST_LEARNING_WRITE_FORBIDDEN）と BUZZASSIST_LEARNING_AUTO_CAPTURE=0 では積まない
//
// 捕捉経路の印（metadata.createdBy / receiptSource）は scripts/harness-learn.mjs の許可一覧にある値しか
// 書けない。一覧に "auto-asset-quality" が入るまでは印を付けず、evidence の先頭の
// "auto-asset-quality-v1" と session の接頭辞で経路を示す（一覧に入った時点で自動で印を付ける）。

import { createHash } from "node:crypto";

import {
  PROPOSAL_METADATA_CREATORS,
  PROPOSAL_RECEIPT_SOURCES,
  captureLearningProposal,
} from "../scripts/harness-learn.mjs";
import { ASSET_STAGES, assetQualityHarness, assetQualityStage } from "./assetQualityLoop.mjs";
import { learningWritesForbidden } from "./harnessLearningGuard.mjs";
import { HARNESS_LEARNING_ROUTES } from "./harnessLearningTargets.mjs";
import { AUTO_RECEIPT_CAPTURE_ENV } from "./harnessReceiptLearning.mjs";

export const AUTO_ASSET_QUALITY_CREATOR = "auto-asset-quality";
export const AUTO_ASSET_QUALITY_SOURCE = "asset-quality-round";
export const AUTO_ASSET_QUALITY_EVIDENCE_TAG = "auto-asset-quality-v1";
export const ASSET_LEARNING_VERSION = "buzzassist-asset-quality-learning-v1";

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const FINGERPRINT = /^quality-failure:[a-f0-9]{24}$/u;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeId(value) {
  const text = String(value ?? "");
  return ID.test(text) && text.length <= 64 ? text : "unclassified";
}

function safeIds(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(safeId).filter((id) => id !== "unclassified"))].sort();
}

function stageOf(state, contract) {
  const stage = String(contract?.stage || state?.asset?.stage || "");
  return ASSET_STAGES.includes(stage) ? stage : "";
}

function harnessOf(state, contract) {
  const id = String(contract?.harnessId || state?.asset?.harnessId || "");
  try {
    return assetQualityHarness(id).id;
  } catch {
    return "";
  }
}

/** 1つの版と失敗指紋の組の digest。同じ版・同じ指紋からは同じ値になる（冪等の鍵）。 */
export function assetRoundDigest({ state, round, version } = {}) {
  return sha256(JSON.stringify({
    version: ASSET_LEARNING_VERSION,
    harness: String(state?.asset?.harnessId || ""),
    stage: String(state?.asset?.stage || ""),
    // 対象 id は人物名になりうるので digest の材料にだけ使い、台帳には出さない。
    subject: sha256(String(state?.asset?.subjectId || "")),
    startedAt: String(state?.startedAt || ""),
    versionLabel: String(version?.label || ""),
    assetSha256: String(version?.assetSha256 || ""),
    failureFingerprint: String(round?.failureFingerprint || ""),
  }));
}

/**
 * 合格しなかった1回から、提案候補を作る（1回につき1件。本文は工程・失敗指紋・id だけ）。純関数。
 */
export function assetRoundLearningCandidates({ state, round, contract } = {}) {
  if (!state || !round || state.status === "passed") return [];
  const stage = stageOf(state, contract);
  if (!stage) return [];
  const fingerprint = FINGERPRINT.test(String(round.failureFingerprint || "")) ? round.failureFingerprint : "quality-failure:unknown";
  const floors = safeIds(round.floorFailures);
  const gates = safeIds(round.failedGateIds);
  const parts = [
    ...(floors.length > 0 ? [`下限割れ: ${floors.join(", ")}`] : []),
    ...(gates.length > 0 ? [`機械ゲート: ${gates.join(", ")}`] : []),
  ];
  if (parts.length === 0) parts.push("目標点に届かなかった");
  const stopped = state.status !== "active" ? `。ループは ${safeId(state.status)}（${safeId(state.stopReason)}）で止まった` : "";
  return [{
    text: `[自動捕捉] 途中の成果物の品質ループ（${assetQualityStage(stage).label}）の版が不合格だった`
      + `（失敗指紋 ${fingerprint}。${parts.join(" / ")}）${stopped}。`
      + "同じ失敗指紋が繰り返すなら、この工程の作り方（プロンプト・参照の渡し方）か採点の基準を見直す候補。",
    gateIds: [...new Set([...floors, ...gates])].sort(),
    counts: { floors: floors.length, gates: gates.length },
  }];
}

/** 人の確認で否とされた成果物から、提案候補を作る（欄ごとに1件）。純関数。 */
export function assetHumanRejectionCandidates({ state, version, verifications = [], contract } = {}) {
  const stage = stageOf(state, contract);
  if (!stage) return [];
  const evaluator = !version ? "not-scored" : (state?.status === "passed" && state?.asset?.versions?.at(-1)?.assetSha256 === version.assetSha256 ? "passed" : "not-passed");
  const evaluatorLabel = { passed: "合格", "not-passed": "不合格", "not-scored": "未採点" }[evaluator];
  return [...new Set(verifications.filter((row) => row?.verdict === "reject").map((row) => safeId(row.check)))]
    .filter((check) => check !== "unclassified")
    .sort()
    .map((check) => ({
      text: `[自動捕捉] 途中の成果物の品質ループ（${assetQualityStage(stage).label}）で、人の確認（${check}）が否だった`
        + `（評価者の採点: ${evaluatorLabel}）。評価者が通して人が否とする形が繰り返すなら、評価の基準か評価者に渡す参照を見直す候補。`,
      gateIds: [`human-${check}`],
      counts: { floors: 0, gates: 1 },
      evaluator,
    }));
}

function evidenceFor({ harness, stage, round, contractDigest, counts }) {
  return [
    AUTO_ASSET_QUALITY_EVIDENCE_TAG,
    `source=${AUTO_ASSET_QUALITY_SOURCE}`,
    `harness=${harness}`,
    `stage=${stage}`,
    `round=${Number(round?.index) || 0}`,
    `floors=${Number(counts?.floors) || 0}`,
    `gates=${Number(counts?.gates) || 0}`,
    `contract=${String(contractDigest || "").slice(0, 16)}`,
    "count=1",
  ].join(" ");
}

function captureMetadata({ digest, harness, contract, gateIds }) {
  return {
    // 印は scripts/harness-learn.mjs の許可一覧にあるときだけ付ける（無い値は台帳が拒否する）。
    ...(PROPOSAL_METADATA_CREATORS.has(AUTO_ASSET_QUALITY_CREATOR) ? { createdBy: AUTO_ASSET_QUALITY_CREATOR } : {}),
    ...(PROPOSAL_RECEIPT_SOURCES.has(AUTO_ASSET_QUALITY_SOURCE) ? { receiptSource: AUTO_ASSET_QUALITY_SOURCE } : {}),
    receiptDigest: digest,
    harness: { id: harness, version: String(contract?.version || "unknown") },
    ...(gateIds.length > 0 ? { gateIds } : {}),
  };
}

/**
 * 品質ループの回（event: "round"）か、人の確認の否（event: "human-rejection"）の学習候補を、
 * そのハーネスの Channel Pack の非公開台帳へ捕捉する。例外は投げない。
 * lib/assetQualityLoop.mjs の recordAssetQualityRound / recordAssetHumanVerification へ captureLearning として渡す形。
 */
export async function captureAssetLearning({
  event = "round",
  state,
  round = null,
  version = null,
  verifications = [],
  contract,
  env = process.env,
  now = () => new Date().toISOString(),
  capture = captureLearningProposal,
  captureOptions = {},
} = {}) {
  const base = { version: ASSET_LEARNING_VERSION, event, captured: 0, duplicates: 0, candidates: 0 };
  if (learningWritesForbidden(env)) return { ...base, skippedReason: "child-agent" };
  if (String(env?.[AUTO_RECEIPT_CAPTURE_ENV] ?? "").trim() === "0") return { ...base, skippedReason: "disabled" };
  const harness = harnessOf(state, contract);
  const stage = stageOf(state, contract);
  if (!harness || !stage) return { ...base, skippedReason: "unknown-harness-or-stage" };
  const target = HARNESS_LEARNING_ROUTES[harness]?.channel;
  if (!target) return { ...base, skippedReason: "unknown-harness-route" };
  let candidates = [];
  let digest = "";
  if (event === "round") {
    if (!round || state?.status === "passed") return { ...base, skippedReason: "passed" };
    candidates = assetRoundLearningCandidates({ state, round, contract });
    digest = assetRoundDigest({ state, round, version });
  } else if (event === "human-rejection") {
    candidates = assetHumanRejectionCandidates({ state, version, verifications, contract });
    const assetSha256 = String(verifications[0]?.assetSha256 || version?.assetSha256 || "");
    digest = sha256(JSON.stringify({
      version: ASSET_LEARNING_VERSION,
      event,
      harness,
      stage,
      subject: sha256(String(state?.asset?.subjectId || "")),
      assetSha256,
      checks: candidates.flatMap((candidate) => candidate.gateIds),
    }));
  } else {
    return { ...base, skippedReason: "unknown-event" };
  }
  const result = { ...base, target, digest: digest.slice(0, 16), candidates: candidates.length, proposalIds: [] };
  if (candidates.length === 0) return result;
  const capturedAt = String(now());
  for (const candidate of candidates) {
    try {
      const output = capture({
        kind: "fact",
        target,
        text: candidate.text,
        evidence: evidenceFor({ harness, stage, round, contractDigest: state?.contractDigest, counts: candidate.counts }),
        session: `${AUTO_ASSET_QUALITY_CREATOR}:${digest.slice(0, 32)}`,
        now: capturedAt,
        metadata: captureMetadata({ digest, harness, contract, gateIds: candidate.gateIds }),
      }, captureOptions);
      if (output?.appended) result.captured += 1;
      else result.duplicates += 1;
      if (output?.entry?.id) result.proposalIds.push(output.entry.id);
    } catch (error) {
      // 1件目で落ちる理由（台帳が分離されていない等）は残りも同じなので、そこで止める。
      return {
        ...result,
        skippedReason: error?.code === "LEARNING_WRITE_FORBIDDEN_IN_CHILD_AGENT"
          ? "child-agent"
          : /分離されていない/u.test(String(error?.message || "")) ? "ledger-not-isolated" : "capture-failed",
      };
    }
  }
  return result;
}
