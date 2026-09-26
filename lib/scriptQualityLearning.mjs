// 台本の品質ループが合格しなかった回から、学習候補を機械的に取り出して提案台帳へ積む。
//
// Job 決着時の自動捕捉（lib/harnessReceiptLearning.mjs）と同じ規則で動く:
//
//   - **書くのは提案台帳への追記だけ**。正本（台本スキル・要求台帳）と overlay には触らない
//   - **本文には評価項目 id・機械ゲート id・工程・止まった理由のコードだけ**。台本の文・採点の所見・
//     人名・パスは入れない（件数は evidence 側に置き、本文に入れない。同じ観測を別の回から拾った
//     ときに同じ提案として数えるため）
//   - **冪等**。同じ回からは二重に積まない（session に回の digest を使う）
//   - **宛先はチャンネルの非公開台帳**（channel-pack:narrated-story-script）。ジャンル・共通層へ
//     一般化するのは人が target を明示して別の提案として capture するときだけ
//   - **台帳のチャンネルが分かればその保存先へ**。制作の Job（metadata.channel）か、ループの作業フォルダが
//     台帳のチャンネル（Job の台本の作業フォルダ・projectDir・strategy.workDir）に当たるときは、そのチャンネルの
//     保存先へ積む（lib/learningChannelResolver.mjs）。決まったのに保存先を決められなければ
//     channel-learning-store-unresolved で積まない。チャンネルが無ければ従来どおり
//   - **提案ゼロを正常とする**。合格した回からは何も積まない
//   - **ループを止めない**。捕捉に失敗しても回の記録は変えず、理由を返すだけ
//   - 子エージェント（BUZZASSIST_LEARNING_WRITE_FORBIDDEN）と BUZZASSIST_LEARNING_AUTO_CAPTURE=0 では積まない

import { createHash } from "node:crypto";

import { captureLearningProposal } from "../scripts/harness-learn.mjs";
import { learningWritesForbidden } from "./harnessLearningGuard.mjs";
import { HARNESS_LEARNING_ROUTES, SCRIPT_LEARNING_ROUTES } from "./harnessLearningTargets.mjs";
import { AUTO_RECEIPT_CAPTURE_ENV } from "./harnessReceiptLearning.mjs";
import {
  learningCaptureFailureReason,
  learningChannelCaptureOptions,
  learningChannelFields,
} from "./learningChannelResolver.mjs";
import { SCRIPT_STAGES, scriptQualityGenre } from "./scriptQualityLoop.mjs";

export const AUTO_SCRIPT_QUALITY_CREATOR = "auto-script-quality";
export const AUTO_SCRIPT_QUALITY_SOURCE = "script-quality-round";
export const AUTO_SCRIPT_QUALITY_EVIDENCE_TAG = "auto-script-quality-v1";
export const SCRIPT_LEARNING_VERSION = "buzzassist-script-quality-learning-v1";

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const STAGE_LABELS = Object.freeze({
  draft: "初稿",
  "external-rewrite": "外部モデルの手直し",
  "meaning-check": "意味照合",
  revision: "直し",
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeId(value) {
  const text = String(value ?? "");
  return ID.test(text) && text.length <= 64 ? text : "unclassified";
}

/** 1つの回の指紋。同じ回からは同じ値になる（冪等の鍵）。 */
export function scriptRoundDigest({ state, round, version } = {}) {
  return sha256(JSON.stringify({
    version: SCRIPT_LEARNING_VERSION,
    contractDigest: String(state?.contractDigest || ""),
    startedAt: String(state?.startedAt || ""),
    round: Number(round?.index) || 0,
    scriptSha256: String(version?.scriptSha256 || ""),
    reviewDigest: String(round?.reviewDigest || ""),
  }));
}

/**
 * 合格しなかった1回から、提案候補（本文は id とコードだけ）を作る。純関数。
 */
export function scriptRoundLearningCandidates({ state, round, version, contract } = {}) {
  if (!state || !round || state.status === "passed") return [];
  const genre = safeId(contract?.genre || state?.script?.genre);
  const stage = SCRIPT_STAGES.includes(version?.stage) ? version.stage : "revision";
  const where = `台本の品質ループ（${genre}）の${STAGE_LABELS[stage]}の版で`;
  const candidates = [];
  const add = (text, ids) => candidates.push({ text, gateIds: [...new Set(ids.map(safeId).filter((id) => id !== "unclassified"))].sort() });

  const floors = (round.floorFailures || []).map(safeId);
  for (const id of [...new Set(floors)].sort()) {
    add(`[自動捕捉] ${where}、評価項目 ${id} が下限を割った。繰り返すなら、この項目を落とす書き方の規則を台本スキルへ足す候補。`, [id]);
  }
  const target = Number(contract?.limits?.targetScore);
  if (floors.length === 0 && Number.isFinite(target) && Number(round.score) < target) {
    const scores = version?.rubricScores && typeof version.rubricScores === "object" ? version.rubricScores : {};
    const lowest = Object.entries(scores)
      .filter(([, value]) => typeof value === "number" && Number.isFinite(value))
      .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))[0]?.[0];
    const lowestId = safeId(lowest);
    add(`[自動捕捉] ${where}、加重平均が目標点に届かなかった（いちばん低い評価項目: ${lowestId}）。`, [lowestId]);
  }
  for (const gateId of [...new Set((round.failedGateIds || []).map(safeId))].sort()) {
    add(`[自動捕捉] ${where}、機械ゲート ${gateId} が落ちた。`, [gateId]);
  }
  if (state.status !== "active") {
    const status = safeId(state.status);
    const reason = safeId(state.stopReason);
    add(`[自動捕捉] 台本の品質ループ（${genre}）が ${status}（${reason}）で止まった。止まり方が繰り返すなら、上限か工程の順番を見直す候補。`, []);
  }
  return candidates;
}

function evidenceFor({ stage, round, contractDigest }) {
  return [
    AUTO_SCRIPT_QUALITY_EVIDENCE_TAG,
    `source=${AUTO_SCRIPT_QUALITY_SOURCE}`,
    `stage=${stage}`,
    `round=${Number(round?.index) || 0}`,
    `contract=${String(contractDigest || "").slice(0, 16)}`,
    "count=1",
  ].join(" ");
}

/**
 * 合格しなかった回の学習候補を、チャンネルの非公開台帳へ捕捉する。例外は投げない。
 * lib/scriptQualityLoop.mjs の recordScriptQualityRound へ captureLearning として渡す形。
 */
export async function captureScriptRoundLearning({
  state,
  round,
  version,
  contract,
  env = process.env,
  now = () => new Date().toISOString(),
  capture = captureLearningProposal,
  captureOptions = {},
  // 積むチャンネルの手がかり（lib/learningChannelResolver.mjs）。ループは workDir を渡す。
  workDir = "",
  job = null,
  channelId = "",
  resolveChannel = undefined,
} = {}) {
  const base = { version: SCRIPT_LEARNING_VERSION, captured: 0, duplicates: 0, candidates: 0 };
  if (learningWritesForbidden(env)) return { ...base, skippedReason: "child-agent" };
  if (String(env?.[AUTO_RECEIPT_CAPTURE_ENV] ?? "").trim() === "0") return { ...base, skippedReason: "disabled" };
  if (!state || !round || state.status === "passed") return { ...base, skippedReason: "passed" };
  let genreSpec;
  try {
    genreSpec = scriptQualityGenre(contract?.genre || state?.script?.genre);
  } catch {
    return { ...base, skippedReason: "unknown-genre" };
  }
  const target = SCRIPT_LEARNING_ROUTES[genreSpec.id];
  if (!target) return { ...base, skippedReason: "unknown-genre-route" };
  // 記録に残すハーネス。解説動画のジャンルは台本の契約に harnessId を持たない（契約の digest に入るので、足すと
  // 走っているループが別の契約になる）ので、宛先のチャンネルを持つハーネス（HARNESS_LEARNING_ROUTES）から引く。
  const learningHarnessId = genreSpec.harnessId
    || Object.keys(HARNESS_LEARNING_ROUTES).find((id) => HARNESS_LEARNING_ROUTES[id].channel === target)
    || "";
  if (!learningHarnessId) return { ...base, skippedReason: "unknown-genre-route" };
  const candidates = scriptRoundLearningCandidates({ state, round, version, contract });
  const digest = scriptRoundDigest({ state, round, version });
  let result = { ...base, target, roundDigest: digest.slice(0, 16), candidates: candidates.length, proposalIds: [] };
  if (candidates.length === 0) return result;
  const channel = await learningChannelCaptureOptions({
    captureOptions, env, workDir, job, channelId, ...(resolveChannel ? { resolveChannel } : {}),
  });
  if (channel.skippedReason) return { ...result, skippedReason: channel.skippedReason };
  result = { ...result, ...learningChannelFields(channel.channel) };
  const stage = SCRIPT_STAGES.includes(version?.stage) ? version.stage : "revision";
  const capturedAt = String(now());
  for (const candidate of candidates) {
    try {
      const output = capture({
        kind: "fact",
        target,
        text: candidate.text,
        evidence: evidenceFor({ stage, round, contractDigest: state.contractDigest }),
        session: `auto-script-quality:${digest.slice(0, 32)}`,
        now: capturedAt,
        metadata: {
          createdBy: AUTO_SCRIPT_QUALITY_CREATOR,
          receiptDigest: digest,
          receiptSource: AUTO_SCRIPT_QUALITY_SOURCE,
          harness: { id: learningHarnessId, version: String(contract?.version || "unknown") },
          ...(candidate.gateIds.length > 0 ? { gateIds: candidate.gateIds } : {}),
        },
      }, channel.captureOptions);
      if (output?.appended) result.captured += 1;
      else result.duplicates += 1;
      if (output?.entry?.id) result.proposalIds.push(output.entry.id);
    } catch (error) {
      // 1件目で落ちる理由（台帳が分離されていない・チャンネルの保存先を決められない等）は残りも同じなので、そこで止める。
      return { ...result, skippedReason: learningCaptureFailureReason(error, result.channelId) };
    }
  }
  return result;
}
