// 企画の品質ループ（lib/strategyBriefQualityLoop.mjs）が合格しなかった回から、学習候補を機械的に取り出して
// Channel Pack の提案台帳へ積む。途中の成果物の品質ループの自動捕捉（lib/assetQualityLearning.mjs）と同じ規則:
//
//   - **書くのは提案台帳への追記だけ**（captureLearningProposal）。正本（スキル・要求台帳）と overlay には触らない
//   - **本文には失敗指紋・評価項目 id・機械ゲート id・止まった理由のコードだけ**。ブリーフの文（問い・約束）・
//     採点の所見・チャンネル id・パスは入れない
//   - **冪等**。同じ版・同じ失敗指紋からは二重に積まない（session に digest を使う）
//   - **宛先はブリーフの制作条件のハーネスの Channel Pack の非公開台帳**（HARNESS_LEARNING_ROUTES[harness].channel）。
//     ハーネスが書かれていないブリーフからは積まない（推測で宛先を決めない）
//   - **提案ゼロを正常とする**。合格した回からは何も積まない
//   - **ループを止めない**。捕捉に失敗しても回の記録は変えず、理由を返すだけ
//   - 子エージェント（BUZZASSIST_LEARNING_WRITE_FORBIDDEN）と BUZZASSIST_LEARNING_AUTO_CAPTURE=0 では積まない
//
// 捕捉経路の印（metadata.createdBy / receiptSource）は scripts/harness-learn.mjs の許可一覧にある値しか書けない。
// 一覧に "auto-strategy-brief" が入るまでは印を付けず、evidence の先頭の "auto-strategy-brief-v1" と session の
// 接頭辞で経路を示す（一覧に入った時点で自動で印を付ける）。

import { createHash } from "node:crypto";

import {
  PROPOSAL_METADATA_CREATORS,
  PROPOSAL_RECEIPT_SOURCES,
  captureLearningProposal,
} from "../scripts/harness-learn.mjs";
import { learningWritesForbidden } from "./harnessLearningGuard.mjs";
import { HARNESS_LEARNING_ROUTES } from "./harnessLearningTargets.mjs";
import { AUTO_RECEIPT_CAPTURE_ENV } from "./harnessReceiptLearning.mjs";

export const AUTO_STRATEGY_BRIEF_CREATOR = "auto-strategy-brief";
export const AUTO_STRATEGY_BRIEF_SOURCE = "strategy-brief-round";
export const AUTO_STRATEGY_BRIEF_EVIDENCE_TAG = "auto-strategy-brief-v1";
export const STRATEGY_BRIEF_LEARNING_VERSION = "buzzassist-strategy-brief-learning-v1";

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

/** 1つの版と失敗指紋の組の digest。同じ版・同じ指紋からは同じ値になる（冪等の鍵）。 */
export function strategyBriefRoundDigest({ state, round, version } = {}) {
  return sha256(JSON.stringify({
    version: STRATEGY_BRIEF_LEARNING_VERSION,
    contractDigest: String(state?.contractDigest || ""),
    startedAt: String(state?.startedAt || ""),
    label: String(version?.label || ""),
    briefSha256: String(version?.briefSha256 || ""),
    failureFingerprint: String(round?.failureFingerprint || ""),
  }));
}

/** 合格しなかった1回から、提案候補を作る（1回につき1件。本文は失敗指紋と id だけ）。純関数。 */
export function strategyBriefRoundLearningCandidates({ state, round } = {}) {
  if (!state || !round || state.status === "passed") return [];
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
    text: `[自動捕捉] 企画ブリーフの品質ループの版が不合格だった（失敗指紋 ${fingerprint}。${parts.join(" / ")}）${stopped}。`
      + "同じ失敗指紋が繰り返すなら、ブリーフの作り方（根拠の集め方・約束と回収の書き方）か採点の基準を見直す候補。",
    gateIds: [...new Set([...floors, ...gates])].sort(),
    counts: { floors: floors.length, gates: gates.length },
  }];
}

function evidenceFor({ harness, round, contractDigest, counts }) {
  return [
    AUTO_STRATEGY_BRIEF_EVIDENCE_TAG,
    `source=${AUTO_STRATEGY_BRIEF_SOURCE}`,
    `harness=${harness}`,
    `round=${Number(round?.index) || 0}`,
    `floors=${Number(counts?.floors) || 0}`,
    `gates=${Number(counts?.gates) || 0}`,
    `contract=${String(contractDigest || "").slice(0, 16)}`,
    "count=1",
  ].join(" ");
}

/**
 * 合格しなかった回の学習候補を、ブリーフの制作条件のハーネスの Channel Pack の非公開台帳へ捕捉する。
 * 例外は投げない。lib/strategyBriefQualityLoop.mjs の recordStrategyBriefRound へ captureLearning として渡す形。
 */
export async function captureStrategyBriefLearning({
  state,
  round = null,
  version = null,
  contract = null,
  env = process.env,
  now = () => new Date().toISOString(),
  capture = captureLearningProposal,
  captureOptions = {},
} = {}) {
  const base = { version: STRATEGY_BRIEF_LEARNING_VERSION, captured: 0, duplicates: 0, candidates: 0 };
  if (learningWritesForbidden(env)) return { ...base, skippedReason: "child-agent" };
  if (String(env?.[AUTO_RECEIPT_CAPTURE_ENV] ?? "").trim() === "0") return { ...base, skippedReason: "disabled" };
  if (!round || state?.status === "passed") return { ...base, skippedReason: "passed" };
  const harness = String(version?.harnessId || "");
  const target = harness ? HARNESS_LEARNING_ROUTES[harness]?.channel : "";
  if (!target) return { ...base, skippedReason: "unknown-harness-route" };
  const candidates = strategyBriefRoundLearningCandidates({ state, round });
  const digest = strategyBriefRoundDigest({ state, round, version });
  const result = { ...base, target, digest: digest.slice(0, 16), candidates: candidates.length, proposalIds: [] };
  if (candidates.length === 0) return result;
  const capturedAt = String(now());
  for (const candidate of candidates) {
    try {
      const output = capture({
        kind: "fact",
        target,
        text: candidate.text,
        evidence: evidenceFor({ harness, round, contractDigest: state?.contractDigest, counts: candidate.counts }),
        session: `${AUTO_STRATEGY_BRIEF_CREATOR}:${digest.slice(0, 32)}`,
        now: capturedAt,
        metadata: {
          // 印は scripts/harness-learn.mjs の許可一覧にあるときだけ付ける（無い値は台帳が拒否する）。
          ...(PROPOSAL_METADATA_CREATORS.has(AUTO_STRATEGY_BRIEF_CREATOR) ? { createdBy: AUTO_STRATEGY_BRIEF_CREATOR } : {}),
          ...(PROPOSAL_RECEIPT_SOURCES.has(AUTO_STRATEGY_BRIEF_SOURCE) ? { receiptSource: AUTO_STRATEGY_BRIEF_SOURCE } : {}),
          receiptDigest: digest,
          harness: { id: harness, version: String(contract?.version || "unknown") },
          ...(candidate.gateIds.length > 0 ? { gateIds: candidate.gateIds } : {}),
        },
      }, captureOptions);
      if (output?.appended) result.captured += 1;
      else result.duplicates += 1;
      if (output?.entry?.id) result.proposalIds.push(output.entry.id);
    } catch (error) {
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
