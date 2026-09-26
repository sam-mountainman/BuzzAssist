// 品質ループの状態ファイルから「同じ失敗が別の版で2回以上出たもの」を見つけ、機械の検査・関門へ上げる提案
// （失敗の格上げ）として学習の提案台帳へ積む。全部の品質ループ（台本・途中の成果物・企画ブリーフ・完成動画の
// 署名済みレビュー＝ナレーション物語と解説動画）で同じ部品を使う。
//
// 出典はまさおさんの記事の「失敗の昇格ラダー」: 口頭 → 注意書き（Gotcha） → 検査スクリプト → 通過必須の関門。
// 同じ失敗が2回起きたら、今の段で防げていない証拠なので1つ上げる。上げたら同じ中身の注意書きは消す。
// 上げ方の判断は3つ: 再発の頻度（2回で上げる）・被害の大きさ（大きければ1回目でも関門へ飛ばす）・
// 機械で判定できるか（できるものは注意書きを飛ばして最初から検査に）。
//
// 決まり（台本・途中の成果物の自動捕捉 lib/scriptQualityLearning.mjs・lib/assetQualityLearning.mjs と同じ）:
//
//   - **状態ファイルは読むだけ**。ループの状態・正本（スキル・要求台帳）・overlay には触らない。書くのは提案台帳への
//     追記だけ（captureLearningProposal）。正本へ反映するかは人かエージェントが pending → approve で決める
//   - **再発は「別の版」で数える**。同じ成果物（同じ sha256）を採点し直した回は1回に数える（漫画の事故台帳の
//     recordMangaQualityIncident と同じ考え。採点のやり直しの回数だけ格上げしない）
//   - **被害の大きい種類（公開面の安全・人物の取り違え・課金・署名や承認の詐称）は1回目でも上げる**。ただし
//     すでに通過必須の関門で止まっている失敗は、出荷は防げているので、再発してから前倒しを提案する
//   - **同じ提案を二重に積まない**。台帳に同じ失敗・同じ次の段の提案があれば積まない（反映済みでも、承認待ちでも）。
//     段が上がって反映された後は、反映より後の再発だけを数えて次の段を提案する
//   - **本文には id・コード・段の名前だけ**。台本の文・採点の所見・対象の id（人物名になりうる）・パス・人名は
//     入れない。件数・版の短い sha は evidence と metadata.failurePromotion に置く（本文を同じにして同じ提案として数える）
//   - **宛先はループの自動捕捉と同じチャンネルの非公開台帳**（channel-pack:）。台帳のチャンネルが分かればその保存先へ
//   - 子エージェント（BUZZASSIST_LEARNING_WRITE_FORBIDDEN）では積まない。ループから自動で呼ぶときは
//     BUZZASSIST_LEARNING_AUTO_CAPTURE=0 でも積まない。自動で呼ぶ経路は例外を投げない（ループを止めない）
//
// 漫画（koya-manga-video）の最終の品質ループは、ここでは読まない。漫画は事故台帳（lib/mangaQualityHarness.mjs の
// recordMangaQualityIncident、checklist → instruction → hard-gate）で同じことを先にやっていて、二重に数えないため。

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  captureLearningProposal,
  createCanonicalReaders,
  isActuallyApplied,
  readLearningLedgerRows,
} from "../scripts/harness-learn.mjs";
import { ASSET_QUALITY_DIR, ASSET_STAGES, assetQualityStage } from "./assetQualityLoop.mjs";
import { expandAppliedRecords } from "./harnessLearningChangeRecords.mjs";
import { learningWritesForbidden } from "./harnessLearningGuard.mjs";
import { HARNESS_LEARNING_ROUTES, SCRIPT_LEARNING_ROUTES, resolveLearningTarget } from "./harnessLearningTargets.mjs";
import { AUTO_RECEIPT_CAPTURE_ENV } from "./harnessReceiptLearning.mjs";
import {
  learningCaptureFailureReason,
  learningChannelCaptureOptions,
  learningChannelFields,
} from "./learningChannelResolver.mjs";
import {
  AUTO_FAILURE_PROMOTION_CREATOR,
  AUTO_FAILURE_PROMOTION_SOURCE,
  FAILURE_PROMOTION_RUNGS,
  FAILURE_VERSION_REF,
  normalizeFailurePromotionMetadata,
} from "./qualityFailurePromotionShape.mjs";
import { SCRIPT_QUALITY_DIR, SCRIPT_QUALITY_STATE_FILE, scriptQualityGenre } from "./scriptQualityLoop.mjs";
import { SIGNED_REVIEW_QUALITY_DIR, SIGNED_REVIEW_QUALITY_STATE_FILE } from "./signedReviewQualityLoop.mjs";
import { STRATEGY_BRIEF_QUALITY_DIR, STRATEGY_BRIEF_QUALITY_STATE_FILE } from "./strategyBriefQualityLoop.mjs";

export {
  AUTO_FAILURE_PROMOTION_CREATOR,
  AUTO_FAILURE_PROMOTION_SOURCE,
} from "./qualityFailurePromotionShape.mjs";

export const FAILURE_PROMOTION_VERSION = "buzzassist-quality-failure-promotion-v1";
export const FAILURE_PROMOTION_EVIDENCE_TAG = "auto-failure-promotion-v1";
/** 同じ失敗が何回（別の版で）出たら上げるか。記事の「2回起きたら仕組みに」。 */
export const DEFAULT_PROMOTION_THRESHOLD = 2;
export const MAX_PROMOTION_THRESHOLD = 10;

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const FINGERPRINT = /^quality-failure:[a-f0-9]{24}$/u;
const FINDING_DIGEST = /^[a-f0-9]{16}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MEDIA_PATH = /\.(?:mp4|mov|m4v|webm|mkv|png|jpe?g|webp|wav|flac|mp3|m4a|aac|ogg)$/iu;
// 署名済みレビューの品質ループは Job の id を episodeId に持つ（lib/signedReviewQualityLoop.mjs）。
const SIGNED_REVIEW_EPISODE = /^video-([a-z][a-z0-9-]*)-[a-f0-9]{16}$/u;
// 署名済みレビューの品質ループを使うハーネス。漫画は事故台帳で先に格上げしているので入れない。
const SIGNED_REVIEW_HARNESSES = Object.freeze(["narrated-story-video", "explainer-video"]);
// 止まる条件は「コード: 説明」の形のときだけ、コードの部分を拾う（説明の文は拾わない）。
const BLOCKING_CODE = /^([a-z][a-z0-9]*(?:-[a-z0-9]+)+):/u;
const MAX_VERSION_REFS = 20;

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeId(value) {
  const text = String(value ?? "");
  return ID.test(text) && text.length <= 64 ? text : "";
}

function safeIds(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(safeId).filter(Boolean))].sort();
}

function isoOrEmpty(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function shortSha(value) {
  const text = String(value || "").toLowerCase();
  return SHA256.test(text) ? text.slice(0, 12) : "";
}

// ---------------------------------------------------------------------------------------------
// ループの状態を読む（純関数）
// ---------------------------------------------------------------------------------------------

/**
 * 状態ファイルがどのループのものかと、提案を積む宛先を決める。分からなければ { skippedReason }。
 *   loop: script / asset / strategy-brief / signed-review
 *   wrapper: ループ固有の欄（script / asset / strategy）。版と始め直しの履歴（history）がここにある
 *   scope: 台本はジャンル、ほかはハーネス。同じ失敗かどうかを決める範囲
 */
export function describeQualityLoopState(state) {
  if (!plainObject(state) || !Array.isArray(state.rounds)) return { skippedReason: "not-a-quality-loop-state" };
  if (plainObject(state.script)) {
    let spec;
    try {
      spec = scriptQualityGenre(state.script.genre);
    } catch {
      return { skippedReason: "unknown-script-genre" };
    }
    const target = SCRIPT_LEARNING_ROUTES[spec.id];
    if (!target) return { skippedReason: "unknown-script-genre-route" };
    const harnessId = spec.harnessId
      || Object.keys(HARNESS_LEARNING_ROUTES).find((id) => HARNESS_LEARNING_ROUTES[id].channel === target)
      || "";
    return { loop: "script", wrapper: "script", scope: spec.id, stage: "", target, harnessId, label: `台本の品質ループ（${spec.id}）`, humanChecks: [] };
  }
  if (plainObject(state.asset)) {
    const harnessId = String(state.asset.harnessId || "");
    const stage = String(state.asset.stage || "");
    const target = HARNESS_LEARNING_ROUTES[harnessId]?.channel;
    if (!target || !ASSET_STAGES.includes(stage)) return { skippedReason: "unknown-asset-harness-or-stage" };
    const spec = assetQualityStage(stage);
    return {
      loop: "asset",
      wrapper: "asset",
      scope: harnessId,
      stage,
      target,
      harnessId,
      label: `途中の成果物の品質ループ（${spec.label}）`,
      humanChecks: (spec.humanChecks || []).map((row) => row.id),
    };
  }
  if (plainObject(state.strategy)) {
    // ブリーフの制作条件のハーネス（版ごとに残る）。推測で宛先を決めない（lib/strategyBriefLearning.mjs と同じ）。
    const harnessId = loopStatesOf(state, "strategy")
      .flatMap((loop) => (Array.isArray(loop.strategy?.versions) ? loop.strategy.versions : []))
      .map((version) => String(version?.harnessId || ""))
      .filter((id) => HARNESS_LEARNING_ROUTES[id])
      .at(-1) || "";
    if (!harnessId) return { skippedReason: "unknown-strategy-brief-harness" };
    return {
      loop: "strategy-brief",
      wrapper: "strategy",
      scope: harnessId,
      stage: "",
      target: HARNESS_LEARNING_ROUTES[harnessId].channel,
      harnessId,
      label: "企画ブリーフの品質ループ",
      humanChecks: [],
    };
  }
  const match = SIGNED_REVIEW_EPISODE.exec(String(state.episodeId || ""));
  if (match && SIGNED_REVIEW_HARNESSES.includes(match[1]) && HARNESS_LEARNING_ROUTES[match[1]]) {
    return {
      loop: "signed-review",
      wrapper: "",
      scope: match[1],
      stage: "",
      target: HARNESS_LEARNING_ROUTES[match[1]].channel,
      harnessId: match[1],
      label: `完成動画の品質ループ（${match[1]}）`,
      humanChecks: [],
    };
  }
  return { skippedReason: "unknown-quality-loop" };
}

/** 始め直す前のループ（wrapper.history[].state）と今のループ。古い順。 */
function loopStatesOf(state, wrapper) {
  const history = wrapper && Array.isArray(state?.[wrapper]?.history) ? state[wrapper].history : [];
  return [...history.map((row) => row?.state).filter((loop) => plainObject(loop) && Array.isArray(loop.rounds)), state];
}

/** ループの印（sha の無い回を「回の番号＋ループ」で区別するため）。前の Job から引き継いだループは同じ印になる。 */
function loopMark(loop) {
  return sha256(`${loop?.startedAt || ""}\u001f${loop?.contractDigest || ""}`).slice(0, 6);
}

/**
 * 回が採点した版の短い識別子。成果物の sha256 の先頭12桁（回の artifactSha256・版の記録・証跡の媒体のファイル）、
 * どれも無ければ「回の番号＋ループの印」。同じ成果物を採点し直した回は同じ識別子になる。
 */
function roundVersionRef(round, version, mark) {
  const candidates = [
    round?.artifactSha256,
    version?.scriptSha256,
    version?.assetSha256,
    version?.briefSha256,
    ...(Array.isArray(round?.evidence) ? round.evidence : [])
      .filter((row) => MEDIA_PATH.test(String(row?.path || "")))
      .map((row) => row?.sha256),
  ];
  const sha = candidates.map(shortSha).find(Boolean);
  if (sha) return sha;
  const index = Number(round?.index);
  const ref = Number.isInteger(index) ? `r${index}-${mark}` : "";
  return FAILURE_VERSION_REF.test(ref) ? ref : "";
}

function lowestCriterion(version) {
  const scores = plainObject(version?.rubricScores) ? version.rubricScores : {};
  return safeId(Object.entries(scores)
    .filter(([id, value]) => safeId(id) && typeof value === "number" && Number.isFinite(value))
    .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))[0]?.[0]);
}

/**
 * 台本の「採用したのに直らなかった指摘」。版の findingRecords の unresolvedOf が前の版の指摘を指す。
 * 同じ指摘は、元の指摘の文の指紋（textDigest）で1つに数える（始め直した後のループでも同じ指紋になる）。
 */
function findingOccurrences(loop, mark) {
  const versions = Array.isArray(loop?.script?.versions) ? loop.script.versions : [];
  const byId = new Map();
  for (const version of versions) {
    if (!plainObject(version)) continue;
    const ref = shortSha(version.scriptSha256) || (Number.isInteger(Number(version.round)) ? `r${Number(version.round)}-${mark}` : "");
    if (!FAILURE_VERSION_REF.test(ref)) continue;
    for (const record of Array.isArray(version.findingRecords) ? version.findingRecords : []) {
      if (plainObject(record) && typeof record.id === "string") {
        byId.set(record.id, { record, ref, observedAt: isoOrEmpty(version.recordedAt) });
      }
    }
  }
  const rows = [];
  for (const { record, ref, observedAt } of byId.values()) {
    for (const rootId of Array.isArray(record.unresolvedOf) ? record.unresolvedOf : []) {
      const root = byId.get(rootId);
      const digest = String(root?.record?.textDigest || "");
      if (!root || !FINDING_DIGEST.test(digest)) continue;
      const criterionId = safeId(root.record.criterionId) || safeId(record.criterionId);
      const id = `finding:${digest}`;
      rows.push({ kind: "finding", id, versionRef: root.ref, observedAt: root.observedAt, ...(criterionId ? { criterionId } : {}) });
      rows.push({ kind: "finding", id, versionRef: ref, observedAt, ...(criterionId ? { criterionId } : {}) });
    }
  }
  return rows;
}

/**
 * 1つの状態ファイル（始め直す前のループを含む）から、失敗の観測を並べる。純関数。
 * 1行: { kind, id, versionRef, observedAt, criterionId?, lowestId? }
 */
export function qualityLoopFailureOccurrences(state, description = describeQualityLoopState(state)) {
  if (!description || description.skippedReason) return [];
  const rows = [];
  for (const loop of loopStatesOf(state, description.wrapper)) {
    const mark = loopMark(loop);
    const versions = description.wrapper && Array.isArray(loop?.[description.wrapper]?.versions)
      ? loop[description.wrapper].versions.filter(plainObject)
      : [];
    const versionByRound = new Map(versions.map((version) => [Number(version.round), version]));
    let lastRef = "";
    for (const round of loop.rounds) {
      if (!plainObject(round)) continue;
      const version = versionByRound.get(Number(round.index)) || null;
      const versionRef = roundVersionRef(round, version, mark);
      if (!versionRef) continue;
      lastRef = versionRef;
      const observedAt = isoOrEmpty(round.observedAt);
      const gates = safeIds(round.failedGateIds);
      const floors = safeIds(round.floorFailures);
      for (const id of gates) rows.push({ kind: "gate", id, versionRef, observedAt });
      for (const id of floors) rows.push({ kind: "floor", id, versionRef, observedAt });
      // 機械ゲートも下限割れも無い不合格（目標点に届かない）は、失敗指紋で同じ形かを見る。ゲートや下限割れが
      // あるときは、そちらの id で数える（同じ失敗を指紋でも数えると二重の提案になる）。
      const fingerprint = String(round.failureFingerprint || "");
      if (gates.length === 0 && floors.length === 0 && FINGERPRINT.test(fingerprint)) {
        const lowestId = lowestCriterion(version);
        rows.push({ kind: "fingerprint", id: fingerprint, versionRef, observedAt, ...(lowestId ? { lowestId } : {}) });
      }
    }
    if (description.loop === "script") rows.push(...findingOccurrences(loop, mark));
    const code = BLOCKING_CODE.exec(String(loop.blockingCondition || ""))?.[1] || "";
    if (loop.status === "blocked" && loop.stopReason === "blocking-condition" && safeId(code) && lastRef) {
      rows.push({ kind: "blocking", id: code, versionRef: lastRef, observedAt: isoOrEmpty(loop.clockLatestAt) });
    }
    if (description.loop === "asset") {
      for (const row of Array.isArray(loop.asset?.humanVerifications) ? loop.asset.humanVerifications : []) {
        const check = safeId(row?.check);
        const versionRef = shortSha(row?.assetSha256);
        if (row?.verdict === "reject" && check && versionRef) {
          rows.push({ kind: "human-check", id: check, versionRef, observedAt: isoOrEmpty(row.recordedAt) });
        }
      }
    }
  }
  return rows;
}

/** 失敗の鍵。ループの種類・範囲（ジャンルかハーネス）・工程・失敗の種類・id が同じなら同じ失敗。 */
export function failurePromotionKey({ loop, scope, stage = "", kind, id } = {}) {
  return sha256(JSON.stringify({ version: FAILURE_PROMOTION_VERSION, loop, scope, stage: stage || "", kind, id })).slice(0, 16);
}

/**
 * 読んだ状態（sources）の観測を、チャンネル・失敗の鍵ごとにまとめる。版は重複を除き、最初に観測した時刻を持つ。
 * sources: [{ description, occurrences, channelId? }]
 */
export function groupQualityLoopFailures(sources = []) {
  const groups = new Map();
  for (const source of sources) {
    const description = source?.description;
    if (!description || description.skippedReason) continue;
    const channelId = String(source.channelId || "");
    for (const row of Array.isArray(source.occurrences) ? source.occurrences : []) {
      const key = failurePromotionKey({ loop: description.loop, scope: description.scope, stage: description.stage, kind: row.kind, id: row.id });
      const groupKey = `${channelId}\u001f${key}`;
      let group = groups.get(groupKey);
      if (!group) {
        group = {
          key,
          channelId,
          loop: description.loop,
          scope: description.scope,
          stage: description.stage || "",
          target: description.target,
          harnessId: description.harnessId,
          label: description.label,
          humanChecks: [...(description.humanChecks || [])],
          kind: row.kind,
          id: row.id,
          versions: new Map(),
        };
        groups.set(groupKey, group);
      }
      if (row.criterionId && !group.criterionId) group.criterionId = row.criterionId;
      if (row.lowestId && !group.lowestId) group.lowestId = row.lowestId;
      const previous = group.versions.get(row.versionRef);
      const at = row.observedAt || "";
      if (previous === undefined || (at && (!previous || at < previous))) group.versions.set(row.versionRef, at || previous || "");
    }
  }
  return [...groups.values()];
}

// ---------------------------------------------------------------------------------------------
// 被害の大きさ・機械で判定できるか・段（純関数）
// ---------------------------------------------------------------------------------------------

// 被害の大きい種類。id の語で見る（上から順に当てる）。当たらなければ normal。
const BLAST_RULES = Object.freeze([
  ["public-safety", /hand-safety|gesture|obscen|nsfw|brand|logo|trademark|copyright|real-person|public-safety|first-person-marker/u],
  ["identity", /identity|wardrobe|reference-approved|reference-declared|speaker-attribution|protagonist|voice-continuity|same-person/u],
  ["attestation", /signature|signed|signoff|attest|forg|provenance|self-review|human-rejection|human-verified|external-call|evidence-files-match|approval/u],
  ["billing", /cost|budget|billing|paid|charge|price|unpriced|credit|spend|currency/u],
]);

// 決まった入力から測れる評価項目（尺・印・吹き出しの字数・字幕の読み速度・音量の釣り合い）。
const MEASURABLE_CRITERIA = new Set([
  "duration-fit",
  "review-first-person-marker",
  "bubble-fit",
  "subtitle-readability",
  "bgm-narration-balance",
]);
// 人の目か評価者の判断が要る評価項目（同一性・手指・画風・意図・意味の保存・全尺の視聴）。
const JUDGMENT_CRITERIA = /identity|wardrobe|hand-safety|art-style|scene-intent|source-intent|meaning-preservation|source-fidelity|full-length-viewing/u;

/** 何の id で被害の大きさと判定のしやすさを見るか。 */
function subjectIdOf(group) {
  if (group.kind === "finding") return group.criterionId || "";
  if (group.kind === "fingerprint") return group.lowestId || "";
  return group.id || "";
}

/** 被害の大きさの区分。目標点に届かないだけの失敗（fingerprint）は normal。 */
export function classifyFailureBlastRadius(group = {}) {
  if (group.kind === "fingerprint") return "normal";
  const subject = subjectIdOf(group);
  for (const [radius, pattern] of BLAST_RULES) {
    if (pattern.test(subject)) return radius;
  }
  return "normal";
}

/** 機械で判定できそうか（yes / no / unknown）。機械ゲートと止まる条件は、もう機械が判定している。 */
export function failureDetectability(group = {}) {
  if (group.kind === "gate" || group.kind === "blocking") return "yes";
  const subject = subjectIdOf(group);
  if (!subject) return "unknown";
  if (MEASURABLE_CRITERIA.has(subject)) return "yes";
  if (JUDGMENT_CRITERIA.test(subject)) return "no";
  return "unknown";
}

/**
 * 今その失敗を止めている段の土台。機械ゲート・人の確認の欄・止まる条件で見つかった失敗は、通過必須の関門で
 * 止まっている。途中の成果物の工程に同じ中身の人の確認の欄がある評価項目（同一性・手指の安全）も同じ。
 * それ以外（評価者の採点と所見だけで見つかった失敗）は口頭。
 */
function baseRung(group) {
  if (["gate", "blocking", "human-check"].includes(group.kind)) return "gate";
  if (group.kind === "floor") {
    const checks = group.humanChecks || [];
    if (checks.includes("hand-safety") && group.id === "hand-safety") return "gate";
    if (checks.includes("identity") && /identity/u.test(group.id)) return "gate";
  }
  return "verbal";
}

/**
 * 次の段。
 *   - 関門で止まっている → shift-left（同じ検査を生成の直後へ前倒しし、作る側の指示にも足す）
 *   - 被害が大きい → 関門へ飛ばす
 *   - 検査スクリプトまで来ている → 関門
 *   - 注意書きでも防げなかった → 機械で判定できなければ関門（人の確認の欄）、できれば（か、分からなければ）検査スクリプト
 *   - 口頭だけ → 機械で判定できれば検査スクリプト（注意書きを飛ばす）、できなければ注意書き
 */
export function nextPromotionRung({ currentRung = "verbal", detectable = "unknown", high = false } = {}) {
  if (currentRung === "gate") return "shift-left";
  if (high) return "gate";
  if (currentRung === "script") return "gate";
  if (currentRung === "gotcha") return detectable === "no" ? "gate" : "script";
  return detectable === "yes" ? "script" : "gotcha";
}

const RUNG_RANK = Object.freeze(Object.fromEntries(FAILURE_PROMOTION_RUNGS.map((rung, index) => [rung, index])));

const BLAST_LABELS = Object.freeze({
  "public-safety": "公開面の安全",
  identity: "人物の取り違え",
  billing: "課金",
  attestation: "署名や承認の詐称",
  normal: "通常",
});
const DETECTABLE_LABELS = Object.freeze({
  yes: "できる",
  no: "できない（人の目か評価者の判断が要る）",
  unknown: "分からない（人が決める）",
});
const NEXT_LABELS = Object.freeze({
  gotcha: "注意書き（Gotcha）",
  script: "検査スクリプト",
  gate: "通過必須の関門",
  "shift-left": "関門の前倒し",
});

function currentRungLabel(group, rung) {
  if (rung === "verbal") return "口頭（評価者の採点・所見だけで、作る側の決まりにも検査にも無い）";
  if (rung === "gotcha") return "注意書き（作る側のスキルの Gotcha）";
  if (rung === "script") return "検査スクリプト";
  if (group.kind === "gate") return "通過必須の関門（機械ゲート）";
  if (group.kind === "blocking") return "通過必須の関門（ループが止まる条件）";
  if (group.kind === "human-check" || group.kind === "floor") return "通過必須の関門（人の確認の欄）";
  return "通過必須の関門";
}

function nextRungDescription(nextRung, detectable) {
  if (nextRung === "gotcha") return "作る側のスキルに、1行と短い理由で足す。機械で判定できる形が見つかれば検査スクリプトへ";
  if (nextRung === "script") return "決まった入力から合否が決まる検査（exit code）にして、評価の前に走らせる。上げたら同じ中身の注意書きは消す";
  if (nextRung === "gate") {
    return detectable === "yes"
      ? "検査をループの機械ゲート・フック・CI の必須の関門にする。上げたら同じ中身の注意書きは消す"
      : "機械で判定できなければ人の確認の欄を必須にし、判定できる部分は機械ゲートにする。上げたら同じ中身の注意書きは消す";
  }
  return "関門で止まっていて出荷は防げている。同じ検査を生成の直後へ前倒しし、作る側の指示にも足して、評価の回を使う前に止める";
}

function failureDescription(group) {
  if (group.kind === "gate") return `機械ゲート ${group.id} の不合格`;
  if (group.kind === "floor") return `評価項目 ${group.id} の下限割れ`;
  if (group.kind === "human-check") return `人の確認（${group.id}）の否`;
  if (group.kind === "blocking") return `止まる条件 ${group.id}`;
  if (group.kind === "finding") {
    return `採用したのに直らなかった指摘（評価項目 ${group.criterionId || "指定なし"}、指摘の指紋 ${group.id.replace(/^finding:/u, "")}）`;
  }
  return `目標点に届かない同じ形の失敗（失敗指紋 ${group.id}${group.lowestId ? `、いちばん低い評価項目 ${group.lowestId}` : ""}）`;
}

/**
 * 提案の本文。件数・版・理由は入れない（同じ失敗・同じ段なら同じ本文にして、台帳で同じ提案として数える）。
 */
export function failurePromotionText(group, { blastRadius, detectable, currentRung, nextRung }) {
  const high = blastRadius !== "normal";
  const phrase = high && currentRung !== "gate"
    ? `が出た（被害の大きい種類: ${BLAST_LABELS[blastRadius]}。1回目から上げる）`
    : high
      ? `が別の版で繰り返し出た（被害の大きい種類: ${BLAST_LABELS[blastRadius]}）`
      : "が別の版で繰り返し出た（今の段で防げていない）";
  return `[失敗の格上げ] ${group.label}で、${failureDescription(group)}${phrase}。`
    + `今の段: ${currentRungLabel(group, currentRung)}。`
    + `次の段: ${NEXT_LABELS[nextRung]}（${nextRungDescription(nextRung, detectable)}）。`
    + `機械で判定できるか: ${DETECTABLE_LABELS[detectable]}。`;
}

function historyKey({ channelId = "", target = "", key = "" }) {
  return `${channelId}\u001f${resolveLearningTarget(target)}\u001f${key}`;
}

/**
 * 台帳の行から、失敗ごとの格上げの履歴を作る。純関数。
 * appliedAt: 反映済みの提案 id → 反映した時刻（isActuallyApplied を通ったものだけ）。
 * 返す値: Map(historyKey → { queued: Set(次の段), applied: Map(次の段 → 反映した時刻) })
 */
export function failurePromotionHistoryFromRows({ channelId = "", proposals = [], appliedAt = new Map(), into = new Map() } = {}) {
  for (const row of Array.isArray(proposals) ? proposals : []) {
    if (row?.createdBy !== AUTO_FAILURE_PROMOTION_CREATOR || !plainObject(row.failurePromotion)) continue;
    // チャンネルの範囲で読んだ行のうち、別のチャンネルの印がある行は使わない（印の無い行は引き継いだ従来の行）。
    if (typeof row.channel === "string" && row.channel && row.channel !== channelId) continue;
    const meta = row.failurePromotion;
    if (typeof meta.key !== "string" || typeof meta.nextRung !== "string") continue;
    const hk = historyKey({ channelId, target: row.target, key: meta.key });
    const entry = into.get(hk) || { queued: new Set(), applied: new Map() };
    entry.queued.add(meta.nextRung);
    if (appliedAt.has(row.id)) {
      const at = String(appliedAt.get(row.id) || row.capturedAt || "");
      const previous = entry.applied.get(meta.nextRung);
      if (previous === undefined || at > previous) entry.applied.set(meta.nextRung, at);
    }
    into.set(hk, entry);
  }
  return into;
}

function currentRungFromHistory(group, entry) {
  const base = baseRung(group);
  if (base === "gate") return { currentRung: "gate", since: entry?.applied.get("shift-left") || "" };
  let best = "verbal";
  for (const rung of entry?.applied.keys() || []) {
    if (rung in RUNG_RANK && RUNG_RANK[rung] > RUNG_RANK[best]) best = rung;
  }
  return { currentRung: best, since: best === "verbal" ? "" : entry.applied.get(best) || "" };
}

/**
 * まとめた失敗から、格上げの提案を作る。純関数。
 * 返す値: { candidates: [...], held: [...] }。held は上げなかったもの（理由つき: below-threshold / already-queued）。
 */
export function failurePromotionCandidates({ groups = [], history = new Map(), threshold = DEFAULT_PROMOTION_THRESHOLD } = {}) {
  const limit = normalizeThreshold(threshold);
  const candidates = [];
  const held = [];
  for (const group of groups) {
    const blastRadius = classifyFailureBlastRadius(group);
    const high = blastRadius !== "normal";
    const detectable = failureDetectability(group);
    const entry = history.get(historyKey(group));
    const { currentRung, since } = currentRungFromHistory(group, entry);
    // 段を上げて反映した後は、反映より後の再発だけを数える（反映より前の失敗は、前の段で起きたもの）。
    const refs = [...group.versions.entries()]
      .filter(([, at]) => !since || (at && at > since))
      .sort((left, right) => String(left[1]).localeCompare(String(right[1])) || left[0].localeCompare(right[0]))
      .map(([ref]) => ref);
    const occurrences = refs.length;
    const summary = {
      key: group.key,
      channelId: group.channelId,
      target: group.target,
      loop: group.loop,
      scope: group.scope,
      stage: group.stage,
      failureKind: group.kind,
      failureId: group.id,
      occurrences,
      versions: refs.slice(-MAX_VERSION_REFS),
      blastRadius,
      detectable,
      currentRung,
    };
    // すでに関門で止まっている失敗は、被害が大きくても再発してから（出荷は防げている）。
    const needed = high && currentRung !== "gate" ? 1 : limit;
    if (occurrences < needed) {
      held.push({ ...summary, heldReason: "below-threshold", needed });
      continue;
    }
    const nextRung = nextPromotionRung({ currentRung, detectable, high });
    if (entry?.queued.has(nextRung)) {
      held.push({ ...summary, nextRung, heldReason: "already-queued" });
      continue;
    }
    const reason = occurrences >= limit ? "recurrence" : "high-blast-radius";
    const metadata = normalizeFailurePromotionMetadata({
      key: group.key,
      loop: group.loop,
      scope: group.scope,
      stage: group.stage,
      failureKind: group.kind,
      failureId: group.id,
      occurrences,
      versions: summary.versions,
      blastRadius,
      detectable,
      currentRung,
      nextRung,
      reason,
    });
    candidates.push({
      ...summary,
      harnessId: group.harnessId,
      nextRung,
      reason,
      text: failurePromotionText(group, { blastRadius, detectable, currentRung, nextRung }),
      evidence: [
        FAILURE_PROMOTION_EVIDENCE_TAG,
        `source=${AUTO_FAILURE_PROMOTION_SOURCE}`,
        `loop=${group.loop}`,
        `scope=${group.scope}`,
        `stage=${group.stage || "-"}`,
        `kind=${group.kind}`,
        `occurrences=${occurrences}`,
        `versions=${summary.versions.join(",")}`,
        `blast=${blastRadius}`,
        `detectable=${detectable}`,
        `current=${currentRung}`,
        `next=${nextRung}`,
        `reason=${reason}`,
      ].join(" "),
      session: `${AUTO_FAILURE_PROMOTION_CREATOR}:${sha256(`${resolveLearningTarget(group.target)}\u001f${group.key}\u001f${nextRung}`).slice(0, 32)}`,
      metadata,
    });
  }
  return { candidates, held };
}

export function normalizeThreshold(value) {
  const parsed = Number(value ?? DEFAULT_PROMOTION_THRESHOLD);
  if (!Number.isInteger(parsed) || parsed < DEFAULT_PROMOTION_THRESHOLD || parsed > MAX_PROMOTION_THRESHOLD) {
    throw new Error(`--threshold は ${DEFAULT_PROMOTION_THRESHOLD}〜${MAX_PROMOTION_THRESHOLD} の整数にしてください（記事の「2回起きたら仕組みに」が既定）。`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------------------------
// ファイルを読む・台帳へ積む
// ---------------------------------------------------------------------------------------------

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function isFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * 作業フォルダの品質ループの状態ファイルを列挙する（読むだけ）。
 * 台本・企画ブリーフ・完成動画の署名済みレビュー（Job の作業領域）は quality/ の1ファイル、途中の成果物は
 * quality/assets/<工程>--<対象>.json。
 */
export async function findQualityLoopStateFiles(workDir) {
  const root = path.resolve(String(workDir || ""));
  const files = [];
  for (const [dir, name] of [
    [SCRIPT_QUALITY_DIR, SCRIPT_QUALITY_STATE_FILE],
    [STRATEGY_BRIEF_QUALITY_DIR, STRATEGY_BRIEF_QUALITY_STATE_FILE],
    [SIGNED_REVIEW_QUALITY_DIR, SIGNED_REVIEW_QUALITY_STATE_FILE],
  ]) {
    const file = path.join(root, dir, name);
    if (await isFile(file)) files.push(file);
  }
  let entries = [];
  try {
    entries = await readdir(path.join(root, ASSET_QUALITY_DIR), { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".json") && !entry.name.endsWith(".revision-delta.json")) {
      files.push(path.join(root, ASSET_QUALITY_DIR, entry.name));
    }
  }
  return [...new Set(files)].sort();
}

/** 状態ファイルの置き場から、作業フォルダ（チャンネルを決める手がかり）を戻す。 */
function workDirOfStateFile(file, description) {
  const levels = description?.loop === "asset" ? ASSET_QUALITY_DIR.split(/[\\/]/u).length : 1;
  let dir = path.dirname(path.resolve(file));
  for (let index = 0; index < levels; index += 1) dir = path.dirname(dir);
  return dir;
}

/** 完成動画の品質ループの作業領域の近くにある Job（job.json）。チャンネルの手がかりにする。読めなければ null。 */
async function readJobNear(workDir) {
  for (const dir of [workDir, path.dirname(workDir)]) {
    try {
      const job = await readJson(path.join(dir, "job.json"));
      if (plainObject(job)) return job;
    } catch {
      // 無ければ次へ。
    }
  }
  return null;
}

/**
 * 状態ファイルを読んで、ループの種類・宛先・失敗の観測を並べる（読むだけ）。
 * 返す値: [{ file, workDir, description, occurrences, job, skippedReason? }]
 */
export async function readQualityLoopSources({ workDirs = [], stateFiles = [] } = {}) {
  const files = [...stateFiles.map((file) => path.resolve(String(file)))];
  for (const dir of workDirs) files.push(...await findQualityLoopStateFiles(dir));
  const sources = [];
  for (const file of [...new Set(files)].sort()) {
    let state;
    try {
      state = await readJson(file);
    } catch {
      sources.push({ file, workDir: "", description: null, occurrences: [], job: null, skippedReason: "state-unreadable" });
      continue;
    }
    const description = describeQualityLoopState(state);
    if (description.skippedReason) {
      sources.push({ file, workDir: "", description: null, occurrences: [], job: null, skippedReason: description.skippedReason });
      continue;
    }
    const workDir = workDirOfStateFile(file, description);
    sources.push({
      file,
      workDir,
      description,
      occurrences: qualityLoopFailureOccurrences(state, description),
      job: description.loop === "signed-review" ? await readJobNear(workDir) : null,
    });
  }
  return sources;
}

/**
 * 台帳から、失敗ごとの格上げの履歴を読む（読むだけ）。チャンネルごとに、そのチャンネルの保存先の範囲で読む。
 * 読めない台帳は空として扱う（captureLearningProposal の id と session の重複検査は、書くときに別に効く）。
 */
export function readFailurePromotionHistory({ channelIds = [""] } = {}) {
  const history = new Map();
  for (const channelId of new Set(channelIds.map((id) => String(id || "")))) {
    try {
      const channel = channelId || null;
      const proposals = readLearningLedgerRows("proposals", { channel });
      const applied = readLearningLedgerRows("applied", { channel });
      const { readCanonical, hashCanonical } = createCanonicalReaders({ channel });
      const appliedAt = new Map();
      for (const record of expandAppliedRecords(applied)) {
        let ok = false;
        try {
          ok = isActuallyApplied(record, readCanonical, hashCanonical);
        } catch {
          ok = false;
        }
        if (ok) appliedAt.set(record.id, String(record.appliedAt || record.promotedAt || ""));
      }
      failurePromotionHistoryFromRows({ channelId, proposals, appliedAt, into: history });
    } catch {
      // このチャンネルの台帳は読めない。履歴なしとして扱う。
    }
  }
  return history;
}

/**
 * 品質ループの状態を読み、同じ失敗の再発（被害の大きい種類は1回目）を「機械の検査・関門へ上げる提案」にする。
 * write が false（既定）なら台帳に書かず、候補を返すだけ（dry-run）。
 *
 * auto: ループの record の直後から自動で呼ぶ形。BUZZASSIST_LEARNING_AUTO_CAPTURE=0 で積まず、例外を投げない。
 * 子エージェント（BUZZASSIST_LEARNING_WRITE_FORBIDDEN）では、write でも積まない（候補だけ返す）。
 *
 * 返す値: { version, write, sources, candidates, held, skippedSources, captured, duplicates, failures, skippedReason? }
 */
export async function promoteRecurringQualityFailures({
  workDirs = [],
  stateFiles = [],
  sources = null,
  write = false,
  auto = false,
  threshold = DEFAULT_PROMOTION_THRESHOLD,
  env = process.env,
  now = () => new Date().toISOString(),
  capture = captureLearningProposal,
  captureOptions = {},
  channelId = "",
  job = null,
  resolveChannel = undefined,
  readHistory = readFailurePromotionHistory,
} = {}) {
  const base = {
    version: FAILURE_PROMOTION_VERSION,
    write: Boolean(write),
    sources: 0,
    candidates: [],
    held: [],
    skippedSources: [],
    captured: 0,
    duplicates: 0,
    failures: [],
  };
  try {
    if (write && learningWritesForbidden(env)) return { ...base, write: false, skippedReason: "child-agent" };
    if (write && auto && String(env?.[AUTO_RECEIPT_CAPTURE_ENV] ?? "").trim() === "0") return { ...base, write: false, skippedReason: "disabled" };
    const limit = normalizeThreshold(threshold);
    const loaded = sources || await readQualityLoopSources({ workDirs, stateFiles });
    const usable = [];
    const skippedSources = [];
    for (const source of loaded) {
      if (source.skippedReason || !source.description) {
        skippedSources.push({ file: source.file, skippedReason: source.skippedReason || "unknown-quality-loop" });
        continue;
      }
      // 積むチャンネル（lib/learningChannelResolver.mjs）。ループの自動捕捉と同じ決め方。
      const channel = await learningChannelCaptureOptions({
        captureOptions,
        env,
        workDir: source.workDir,
        job: source.job || job,
        channelId,
        ...(resolveChannel ? { resolveChannel } : {}),
      });
      if (channel.skippedReason) {
        skippedSources.push({ file: source.file, skippedReason: channel.skippedReason });
        continue;
      }
      usable.push({
        ...source,
        channelId: channel.channel?.channelId || "",
        channelFields: learningChannelFields(channel.channel),
        captureOptions: channel.captureOptions,
      });
    }
    const groups = groupQualityLoopFailures(usable);
    const history = await readHistory({ channelIds: [...new Set(usable.map((source) => source.channelId))], env });
    const { candidates, held } = failurePromotionCandidates({ groups, history, threshold: limit });
    const optionsByChannel = new Map(usable.map((source) => [source.channelId, source.captureOptions]));
    const fieldsByChannel = new Map(usable.map((source) => [source.channelId, source.channelFields]));
    const decorated = candidates.map((candidate) => ({ ...candidate, ...(fieldsByChannel.get(candidate.channelId) || {}) }));
    const result = { ...base, sources: usable.length, candidates: decorated, held, skippedSources };
    if (!write || decorated.length === 0) return result;
    const capturedAt = String(now());
    for (const candidate of decorated) {
      try {
        const output = capture({
          kind: "constraint",
          target: candidate.target,
          text: candidate.text,
          evidence: candidate.evidence,
          session: candidate.session,
          now: capturedAt,
          metadata: {
            createdBy: AUTO_FAILURE_PROMOTION_CREATOR,
            receiptSource: AUTO_FAILURE_PROMOTION_SOURCE,
            receiptDigest: sha256(JSON.stringify({ version: FAILURE_PROMOTION_VERSION, key: candidate.key, next: candidate.nextRung, versions: candidate.versions })),
            ...(candidate.harnessId && safeId(candidate.harnessId) ? { harness: { id: candidate.harnessId } } : {}),
            ...(["gate", "floor"].includes(candidate.failureKind) ? { gateIds: [candidate.failureId] } : {}),
            ...(candidate.failureKind === "human-check" ? { gateIds: [`human-${candidate.failureId}`] } : {}),
            failurePromotion: candidate.metadata,
          },
        }, optionsByChannel.get(candidate.channelId) || captureOptions);
        if (output?.appended) result.captured += 1;
        else result.duplicates += 1;
        if (output?.entry?.id) candidate.proposalId = output.entry.id;
      } catch (error) {
        const reason = learningCaptureFailureReason(error, candidate.channelId);
        if (reason === "child-agent") return { ...result, skippedReason: "child-agent" };
        result.failures.push({ key: candidate.key, target: candidate.target, reason });
      }
    }
    return result;
  } catch (error) {
    if (!auto) throw error;
    return { ...base, skippedReason: "promotion-failed", detail: String(error?.message || error).slice(0, 300) };
  }
}

/**
 * ループの record（回を記録した直後）から呼ぶ形。その作業フォルダの全部の品質ループの状態を読み、格上げの提案を
 * 台帳へ積む。例外は投げない（ループの記録は変えない）。BUZZASSIST_LEARNING_AUTO_CAPTURE=0 と子エージェントでは積まない。
 */
export function autoPromoteQualityLoopFailures({ workDir, ...options } = {}) {
  return promoteRecurringQualityFailures({ ...options, workDirs: workDir ? [workDir] : [], write: true, auto: true });
}
