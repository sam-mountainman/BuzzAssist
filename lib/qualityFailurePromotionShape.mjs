// 品質ループの「失敗の格上げ」提案（lib/qualityFailurePromotion.mjs）が学習の提案台帳へ残す付帯情報の形。
//
// scripts/harness-learn.mjs の normalizeProposalMetadata がここを読んで、台帳へ書く前に形を確かめる。
// 付帯情報に自由文を入れさせない（ループの状態には人物名になりうる対象 id や所見の文があるので、
// 台帳に残すのは決まった語彙・id・短い sha だけにする）。何も import しない（harness-learn と
// lib/qualityFailurePromotion.mjs の両方から読むので、循環させない）。

/** 捕捉経路の印（metadata.createdBy）。 */
export const AUTO_FAILURE_PROMOTION_CREATOR = "auto-failure-promotion";
/** 観測の出所（metadata.receiptSource）。品質ループの状態ファイルを読んで見つけた。 */
export const AUTO_FAILURE_PROMOTION_SOURCE = "quality-loop-state";

/** 読むループの種類。 */
export const FAILURE_PROMOTION_LOOPS = Object.freeze(["script", "asset", "strategy-brief", "signed-review"]);

/**
 * 失敗の種類。
 *   gate: 機械ゲートが落ちた / floor: 評価項目が下限を割った / finding: 採用したのに直らなかった指摘 /
 *   human-check: 人の確認の欄で否 / fingerprint: 目標点に届かなかった同じ形の失敗（ゲート・下限割れなし）/
 *   blocking: ループが止まる条件（費用の単位の食い違いなど、コードの形の条件だけ）
 */
export const FAILURE_PROMOTION_KINDS = Object.freeze(["gate", "floor", "finding", "human-check", "fingerprint", "blocking"]);

/** 被害の大きさの区分。normal 以外は1回目でも上げる。 */
export const FAILURE_BLAST_RADII = Object.freeze(["public-safety", "identity", "billing", "attestation", "normal"]);

/** 機械で判定できそうか。yes は機械ゲート・決まった入力から測れる評価項目、no は人の目か評価者の判断が要るもの。 */
export const FAILURE_DETECTABILITY = Object.freeze(["yes", "no", "unknown"]);

/**
 * 失敗を防ぐ段（低い順）。まさおさんの記事の「失敗の昇格ラダー」（口頭 → 注意書き → 検査スクリプト → 通過必須の関門）。
 *   verbal: 評価者の採点・所見だけ（作る側の決まりにも検査にも無い）
 *   gotcha: 作る側のスキルの注意書き（Gotcha）
 *   script: 決まった入力から合否が決まる検査スクリプト
 *   gate: 通過必須の関門（ループの機械ゲート・人の確認の欄・フック・CI）
 */
export const FAILURE_PROMOTION_RUNGS = Object.freeze(["verbal", "gotcha", "script", "gate"]);

/** 次の段。関門で止まっている失敗の次は shift-left（同じ検査を生成の直後へ前倒しし、作る側にも知らせる）。 */
export const FAILURE_PROMOTION_NEXT_RUNGS = Object.freeze(["gotcha", "script", "gate", "shift-left"]);

/** 提案した理由。recurrence: 別の版で2回以上 / high-blast-radius: 被害の大きい種類なので1回目から。 */
export const FAILURE_PROMOTION_REASONS = Object.freeze(["recurrence", "high-blast-radius"]);

const KEY = /^[a-f0-9]{16}$/u;
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const FAILURE_ID = /^(?:[a-z][a-z0-9]*(?:-[a-z0-9]+)*|quality-failure:[a-f0-9]{24}|finding:[a-f0-9]{16})$/u;
/** 版の短い識別子。成果物の sha256 の先頭12桁か、sha の無い回の「回の番号＋ループの印」。 */
export const FAILURE_VERSION_REF = /^(?:[a-f0-9]{12}|r[1-9][0-9]{0,3}-[a-f0-9]{6})$/u;
const MAX_VERSIONS = 20;

function oneOf(list, value, label) {
  if (!list.includes(value)) throw new Error(`metadata.failurePromotion.${label} が不正です`);
  return value;
}

/**
 * metadata.failurePromotion の形を確かめて、決まった形へそろえる。直せない値は例外にする（黙って落とさない）。
 */
export function normalizeFailurePromotionMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("metadata.failurePromotion は object にしてください");
  }
  const allowed = new Set([
    "key", "loop", "scope", "stage", "failureKind", "failureId", "occurrences", "versions",
    "blastRadius", "detectable", "currentRung", "nextRung", "reason",
  ]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`metadata.failurePromotion に未知のキーがあります: ${unknown.join(", ")}`);
  if (!KEY.test(String(value.key || ""))) throw new Error("metadata.failurePromotion.key は16桁の16進にしてください");
  const scope = String(value.scope ?? "");
  if (!ID.test(scope) || scope.length > 64) throw new Error("metadata.failurePromotion.scope が不正です");
  const stage = value.stage === undefined || value.stage === null || value.stage === "" ? "" : String(value.stage);
  if (stage && (!ID.test(stage) || stage.length > 64)) throw new Error("metadata.failurePromotion.stage が不正です");
  const failureId = String(value.failureId ?? "");
  if (!FAILURE_ID.test(failureId) || failureId.length > 80) throw new Error("metadata.failurePromotion.failureId が不正です");
  const occurrences = Number(value.occurrences);
  if (!Number.isInteger(occurrences) || occurrences < 1 || occurrences > 100_000) {
    throw new Error("metadata.failurePromotion.occurrences は1以上の整数にしてください");
  }
  const versions = Array.isArray(value.versions) ? value.versions.map(String) : null;
  if (!versions || versions.length === 0 || versions.length > MAX_VERSIONS || versions.some((ref) => !FAILURE_VERSION_REF.test(ref))) {
    throw new Error(`metadata.failurePromotion.versions は版の短い識別子の配列（1〜${MAX_VERSIONS}件）にしてください`);
  }
  return {
    key: String(value.key),
    loop: oneOf(FAILURE_PROMOTION_LOOPS, value.loop, "loop"),
    scope,
    ...(stage ? { stage } : {}),
    failureKind: oneOf(FAILURE_PROMOTION_KINDS, value.failureKind, "failureKind"),
    failureId,
    occurrences,
    versions: [...new Set(versions)],
    blastRadius: oneOf(FAILURE_BLAST_RADII, value.blastRadius, "blastRadius"),
    detectable: oneOf(FAILURE_DETECTABILITY, value.detectable, "detectable"),
    currentRung: oneOf(FAILURE_PROMOTION_RUNGS, value.currentRung, "currentRung"),
    nextRung: oneOf(FAILURE_PROMOTION_NEXT_RUNGS, value.nextRung, "nextRung"),
    reason: oneOf(FAILURE_PROMOTION_REASONS, value.reason, "reason"),
  };
}
