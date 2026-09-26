// 人の選択（lib/humanChoice.mjs）の理由を、「そのチャンネルの採点表に足す候補」として学習の台帳の
// 承認キュー（チャンネル単位の保存先の proposals）へ積む。
//
// 途中の成果物の品質ループの自動捕捉（lib/assetQualityLearning.mjs）と同じ規則で動く:
//
//   - **書くのは提案台帳への追記だけ**（captureLearningProposal）。採点表（署名済みの Channel Pack の
//     asset-quality.json など）・正本（要求台帳・スキル）・overlay には触らない。反映は、人が
//     harness-learn の承認キュー（pending → approve）と Pack の作者の署名し直しで行う
//   - **宛先はそのハーネスの Channel Pack の非公開台帳**（HARNESS_LEARNING_ROUTES[harness].channel）。
//     台帳のチャンネルが分かれば（--channel・--job・作業フォルダ）、そのチャンネルの保存先へ積む
//     （lib/learningChannelResolver.mjs）。決まったのに保存先を決められなければ積まない
//   - **積むのは数える人の選択（human-verified）の理由だけ**。--agent-attested・お任せからは積まない
//     （機械の好みを人の好みとして採点表へ上げない。お任せには理由が無い）
//   - **札の提案の本文は工程と札で決まる定型文**（組の id・候補のパス・人名を入れない）。同じ札が別の組で
//     選ばれると同じ提案 id になり、再発（何回その理由で選ばれたか）として数えられる
//   - 一言は、人が自分の言葉で書いた理由そのものが材料なので本文に入れる（非公開のチャンネルの台帳だけに積む。
//     共有層へは人が一般的な言い方で別の提案として capture し直したときだけ上がる）
//   - **冪等**。同じ組の同じ版から二重に積まない（session に組の digest を使う）
//   - **選択を止めない**。捕捉に失敗しても選択の記録は変えず、理由を返すだけ
//   - 子エージェント（BUZZASSIST_LEARNING_WRITE_FORBIDDEN）と BUZZASSIST_LEARNING_AUTO_CAPTURE=0 では積まない
//
// 捕捉経路の印（metadata.createdBy / receiptSource）は scripts/harness-learn.mjs の許可一覧にある値しか
// 書けない。一覧に "human-choice" が入るまでは印を付けず、evidence の先頭の "human-choice-v1" と session の
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
import { HUMAN_CHOICE_HUMAN_VERIFIED, HUMAN_CHOICE_VERSION, humanChoiceStage } from "./humanChoice.mjs";
import {
  learningCaptureFailureReason,
  learningChannelCaptureOptions,
  learningChannelFields,
} from "./learningChannelResolver.mjs";

export const HUMAN_CHOICE_CREATOR = "human-choice";
export const HUMAN_CHOICE_SOURCE = "human-choice";
export const HUMAN_CHOICE_EVIDENCE_TAG = "human-choice-v1";
export const HUMAN_CHOICE_LEARNING_VERSION = "buzzassist-human-choice-learning-v1";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** 札1つの提案の本文（工程と札で決まる定型文。同じ札は別の組でも同じ本文＝同じ提案 id）。 */
export function humanChoiceChipProposalText(stageSpec, reason) {
  const head = `[人の選択] ${stageSpec.label}の候補から人が選んだ決め手「${reason.label}」。`;
  const decide = "重みと下限は人が決める（採点表は自動では書き換えない）。";
  if (reason.kind === "existing") {
    if (stageSpec.configurableRubric) {
      return `${head}既定の評価項目 ${reason.criterionId}（${reason.criterionLabel}）を、このチャンネルでは重く見る候補。`
        + `反映先: ${reason.rubricHome} の weights / floors（下限は上げるだけ）。${decide}`;
    }
    return `${head}${stageSpec.defaultRubricSource || "既定の採点表"}の評価項目 ${reason.criterionId}（${reason.criterionLabel}）を、`
      + `このチャンネルでは重く見る候補。その採点表はチャンネルで変えられないので、反映先は ${reason.rubricHome}。${decide}`;
  }
  const where = stageSpec.configurableRubric ? `${reason.rubricHome} の criteria` : reason.rubricHome;
  return `${head}このチャンネルの採点表に足す評価項目の候補: ${reason.criterionId}「${reason.criterionLabel}」— ${reason.description}。`
    + `反映先: ${where}。${decide}`;
}

/** 一言の提案の本文（人の言葉をそのまま運ぶ。非公開のチャンネルの台帳だけに積む）。 */
export function humanChoiceNoteProposalText(stageSpec, note) {
  return `[人の選択] ${stageSpec.label}の候補から人が選んだ理由（人の一言）: 「${note}」。`
    + `このチャンネルの採点表（${stageSpec.rubricHome}）に足す評価項目にできるかを、人が読んで決める候補。`;
}

/**
 * 1つの選択から、提案の候補を作る（札ごとに1件、一言があれば1件）。純関数。
 * 数えない選択（human-verified でない）・お任せからは何も作らない。
 */
export function humanChoiceLearningCandidates({ state, decision } = {}) {
  if (!state || !decision) return [];
  if (decision.counted !== true || decision.attestedBy !== HUMAN_CHOICE_HUMAN_VERIFIED || decision.delegated) return [];
  const spec = humanChoiceStage(state.stage);
  const rows = (decision.reasons || []).map((reason) => ({
    kind: "chip",
    text: humanChoiceChipProposalText(spec, reason),
    chip: reason.chip,
    criterionIds: [reason.criterionId],
  }));
  if (decision.note) {
    rows.push({ kind: "note", text: humanChoiceNoteProposalText(spec, decision.note), chip: "", criterionIds: [] });
  }
  return rows;
}

function evidenceFor({ state, decision, candidate }) {
  return [
    HUMAN_CHOICE_EVIDENCE_TAG,
    `source=${HUMAN_CHOICE_SOURCE}`,
    `harness=${state.harnessId}`,
    `stage=${state.stage}`,
    candidate.chip ? `chip=${candidate.chip}` : "reason=note",
    `candidates=${(state.candidates || []).length}`,
    `picked=${decision.pick?.label || "?"}`,
    `set=${String(state.digest || "").slice(0, 16)}`,
    "count=1",
  ].join(" ");
}

function captureMetadata({ digest, state, criterionIds }) {
  return {
    // 印は scripts/harness-learn.mjs の許可一覧にあるときだけ付ける（無い値は台帳が拒否する）。
    ...(PROPOSAL_METADATA_CREATORS.has(HUMAN_CHOICE_CREATOR) ? { createdBy: HUMAN_CHOICE_CREATOR } : {}),
    ...(PROPOSAL_RECEIPT_SOURCES.has(HUMAN_CHOICE_SOURCE) ? { receiptSource: HUMAN_CHOICE_SOURCE } : {}),
    receiptDigest: digest,
    harness: { id: state.harnessId, version: HUMAN_CHOICE_VERSION },
    ...(criterionIds.length > 0 ? { gateIds: criterionIds } : {}),
  };
}

/**
 * 1つの人の選択の理由を、そのハーネスの Channel Pack の非公開台帳（承認キューの提案）へ捕捉する。例外は投げない。
 * lib/humanChoice.mjs の recordHumanChoice へ captureLearning として渡す形（{ state, decision, workDir }）。
 */
export async function captureHumanChoiceLearning({
  state,
  decision,
  env = process.env,
  now = () => new Date().toISOString(),
  capture = captureLearningProposal,
  captureOptions = {},
  // 積むチャンネルの手がかり（lib/learningChannelResolver.mjs）。CLI は workDir と --channel / --job を渡す。
  workDir = "",
  job = null,
  channelId = "",
  resolveChannel = undefined,
} = {}) {
  const base = { version: HUMAN_CHOICE_LEARNING_VERSION, captured: 0, duplicates: 0, candidates: 0 };
  if (!state || !decision) return { ...base, skippedReason: "no-decision" };
  if (decision.counted !== true || decision.attestedBy !== HUMAN_CHOICE_HUMAN_VERIFIED) return { ...base, skippedReason: "not-human-verified" };
  if (decision.delegated) return { ...base, skippedReason: "delegated" };
  if (learningWritesForbidden(env)) return { ...base, skippedReason: "child-agent" };
  if (String(env?.[AUTO_RECEIPT_CAPTURE_ENV] ?? "").trim() === "0") return { ...base, skippedReason: "disabled" };
  const target = HARNESS_LEARNING_ROUTES[state.harnessId]?.channel;
  if (!target) return { ...base, skippedReason: "unknown-harness-route" };
  const candidates = humanChoiceLearningCandidates({ state, decision });
  // 同じ組（同じ候補の組の digest）からの選択は同じ session。選び直しで同じ札を二重に数えない。
  const digest = sha256(JSON.stringify({ version: HUMAN_CHOICE_LEARNING_VERSION, harness: state.harnessId, stage: state.stage, set: state.digest }));
  let result = { ...base, target, digest: digest.slice(0, 16), candidates: candidates.length, proposalIds: [] };
  if (candidates.length === 0) return result;
  const channel = await learningChannelCaptureOptions({
    captureOptions, env, workDir, job, channelId, ...(resolveChannel ? { resolveChannel } : {}),
  });
  if (channel.skippedReason) return { ...result, skippedReason: channel.skippedReason };
  result = { ...result, ...learningChannelFields(channel.channel) };
  const capturedAt = String(now());
  for (const candidate of candidates) {
    try {
      const output = await capture({
        kind: "preference",
        target,
        text: candidate.text,
        evidence: evidenceFor({ state, decision, candidate }),
        session: `${HUMAN_CHOICE_CREATOR}:${digest.slice(0, 32)}`,
        now: capturedAt,
        metadata: captureMetadata({ digest, state, criterionIds: candidate.criterionIds }),
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
