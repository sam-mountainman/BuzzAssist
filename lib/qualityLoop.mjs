import { createHash } from "node:crypto";

/**
 * 品質ループの共通部品（ジャンルに依らない）。
 *
 * 作る係と採点する係を分け、採点基準を走行中に変えさせず、止まる条件を複数持たせる。
 * 漫画の品質ハーネス（lib/mangaQualityHarness.mjs）から中核を移したもので、
 * ナレーション物語も同じ部品を使う。ジャンルが決めるのは評価項目と機械ゲートと上限だけ。
 *
 * 止まる条件: 目標到達・人の判断が要る状態・費用・時間・回数・改善の停滞。
 * 合格: 機械ゲートが全部通り、加重平均が目標以上で、どの評価項目も下限を下回らないこと。
 */

export const QUALITY_LOOP_VERSION = 4;

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, minimum, maximum, fallback = minimum) {
  return Math.min(maximum, Math.max(minimum, finiteNumber(value, fallback)));
}

function uniqueStrings(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((entry) => nonEmptyString(entry))
    .filter(Boolean))];
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value)) deepFreeze(entry);
  return value;
}

function sha256Text(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function sanitizeEvidence(value, maximum = 2_000) {
  return nonEmptyString(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .replace(/[\r\n\u2028\u2029]+/gu, " ")
    .replace(/\[(?:採用案|理由)\]/gu, "（$&）")
    .slice(0, maximum);
}

export function validSha256(value) {
  return /^[a-f0-9]{64}$/u.test(nonEmptyString(value));
}

export function normalizeEvidenceRows(value, { required = true } = {}) {
  const rows = (Array.isArray(value) ? value : []).map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Evidence must be an object with path, sha256, and note.");
    }
    const path = sanitizeEvidence(entry.path, 1_000);
    const sha256 = nonEmptyString(entry.sha256).toLowerCase();
    const note = sanitizeEvidence(entry.note, 1_000);
    if (!path || !validSha256(sha256) || note.length < 4) {
      throw new Error("Evidence requires a path, a SHA-256 digest, and a concrete note.");
    }
    return { path, sha256, note };
  });
  if (required && rows.length === 0) throw new Error("At least one hash-bound evidence artifact is required.");
  return rows;
}

export function normalizeQualityRubric(value, defaults = []) {
  const source = Array.isArray(value) && value.length > 0 ? value : defaults;
  const rows = source.map((entry, index) => ({
    id: nonEmptyString(entry?.id) || `criterion-${index + 1}`,
    label: nonEmptyString(entry?.label) || nonEmptyString(entry?.id) || `評価項目${index + 1}`,
    weight: clamp(entry?.weight, 0.1, 100, 1),
    description: nonEmptyString(entry?.description),
    // 下限（0〜100）。平均が目標に届いても、この項目がこれを下回れば合格にしない。
    ...(Number.isFinite(Number(entry?.minimumScore)) ? { minimumScore: clamp(entry.minimumScore, 0, 100, 0) } : {}),
  }));
  const total = rows.reduce((sum, entry) => sum + entry.weight, 0) || 1;
  return rows.map((entry) => ({ ...entry, weight: Number((entry.weight * 100 / total).toFixed(6)) }));
}

/**
 * 合格の決め方。既定は average（今までの動き）。
 * - average: 評価者の総合点の平均が目標以上
 * - each-evaluator: 宣言した評価者それぞれの総合点が下限（minimumEvaluatorScore、無ければ目標）以上で、
 *   各自の項目の下限も満たす。平均だけ目標を越える回（1人が高く、1人が低い）を合格にしない
 */
export const QUALITY_ACCEPTANCE_MODES = Object.freeze(["average", "each-evaluator"]);
export const DEFAULT_QUALITY_ACCEPTANCE_MODE = "average";

/**
 * 契約の受け入れ方（acceptance）を正規化する。契約に acceptance が無ければ既定（average・評価者の宣言なし）で、
 * そのときの動きは今までと同じ。直せない値は例外にする（黙って既定へ戻すと、宣言した側は効いているつもりになる）。
 *
 * - evaluators: 1回に要る評価者の id。宣言があれば、全員の評価がそろわない回は合格にならず、宣言に無い
 *   評価者・同じ評価者の2件目は回に入れない。each-evaluator では宣言が要る
 * - minimumEvaluatorScore: each-evaluator の評価者ごとの総合点の下限（0〜100）。無ければ目標点
 */
export function normalizeQualityAcceptance(value) {
  if (value === undefined || value === null) {
    return { declared: false, mode: DEFAULT_QUALITY_ACCEPTANCE_MODE, evaluators: [], minimumEvaluatorScore: null };
  }
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Quality acceptance must be an object.");
  const mode = value.mode === undefined ? DEFAULT_QUALITY_ACCEPTANCE_MODE : nonEmptyString(value.mode);
  if (!QUALITY_ACCEPTANCE_MODES.includes(mode)) {
    throw new Error(`Unknown quality acceptance mode: ${String(value.mode)} (${QUALITY_ACCEPTANCE_MODES.join(" / ")}).`);
  }
  if (value.evaluators !== undefined && !Array.isArray(value.evaluators)) throw new Error("Quality acceptance evaluators must be a list.");
  const raw = (value.evaluators || []).map((entry) => nonEmptyString(entry));
  if (raw.some((entry) => !entry)) throw new Error("Quality acceptance evaluators must be non-empty ids.");
  if (new Set(raw).size !== raw.length) throw new Error("Quality acceptance evaluators must not repeat.");
  if (mode === "each-evaluator" && raw.length === 0) throw new Error("each-evaluator acceptance requires declared evaluators.");
  let minimumEvaluatorScore = null;
  if (value.minimumEvaluatorScore !== undefined && value.minimumEvaluatorScore !== null) {
    if (mode !== "each-evaluator") throw new Error("minimumEvaluatorScore applies only to each-evaluator acceptance.");
    const parsed = value.minimumEvaluatorScore;
    if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
      throw new Error("minimumEvaluatorScore must be a number between 0 and 100.");
    }
    minimumEvaluatorScore = parsed;
  }
  return { declared: true, mode, evaluators: raw, minimumEvaluatorScore };
}

/**
 * 受け入れ方の判定。failures が空でなければ、平均と下限が満たされていても合格にしない。
 * record は回に残す評価者ごとの結果（点・下限割れ・宣言した評価者の欠け）。
 */
function evaluateAcceptance({ acceptance, normalizedReviews, reviews, contract }) {
  const failures = [];
  const missingEvaluators = acceptance.evaluators.filter((id) => !normalizedReviews.some((review) => review.evaluatorId === id));
  for (const id of missingEvaluators) failures.push(`evaluator-missing:${id}`);
  const each = acceptance.mode === "each-evaluator";
  const minimum = each ? (acceptance.minimumEvaluatorScore ?? contract.limits.targetScore) : null;
  const evaluators = normalizedReviews.map((review, index) => {
    const floors = rubricFloorFailures([reviews[index]], contract);
    const row = {
      evaluatorId: review.evaluatorId,
      evaluatorContextId: review.evaluatorContextId,
      score: review.score,
      floorFailures: floors,
    };
    if (!each) return row;
    const meetsMinimum = review.score >= minimum;
    if (!meetsMinimum) failures.push(`evaluator-below-minimum:${review.evaluatorId}`);
    for (const id of floors) failures.push(`evaluator-floor-failed:${review.evaluatorId}:${id}`);
    return { ...row, meetsMinimum };
  });
  return {
    failures,
    record: {
      mode: acceptance.mode,
      declaredEvaluators: [...acceptance.evaluators],
      ...(each ? { minimumEvaluatorScore: minimum } : {}),
      missingEvaluators,
      evaluators,
      failures: [...failures],
    },
  };
}

function weightedReviewScore(review, contract) {
  const scores = review?.scores && typeof review.scores === "object" ? review.scores : {};
  const missing = (contract.rubric || []).filter((criterion) => !Number.isFinite(Number(scores[criterion.id]))).map((criterion) => criterion.id);
  if (missing.length > 0) throw new Error(`Every rubric criterion must be scored: ${missing.join(", ")}`);
  let weighted = 0;
  let includedWeight = 0;
  for (const criterion of contract.rubric || []) {
    const score = Number(scores[criterion.id]);
    if (!Number.isFinite(score)) continue;
    weighted += clamp(score, 0, 100, 0) * criterion.weight;
    includedWeight += criterion.weight;
  }
  if (includedWeight <= 0) throw new Error("Each review must score every rubric criterion.");
  return Number((weighted / includedWeight).toFixed(3));
}

/** 各レビューで下限を下回った評価項目（重複なし、項目 id 順）。 */
export function rubricFloorFailures(reviews, contract) {
  const failures = new Set();
  for (const review of Array.isArray(reviews) ? reviews : []) {
    const scores = review?.scores && typeof review.scores === "object" ? review.scores : {};
    for (const criterion of contract?.rubric || []) {
      if (!Number.isFinite(Number(criterion.minimumScore))) continue;
      const score = Number(scores[criterion.id]);
      if (Number.isFinite(score) && score < criterion.minimumScore) failures.add(criterion.id);
    }
  }
  return [...failures].sort();
}

/**
 * 合格しなかった回の失敗指紋。落ちた機械ゲート・下限割れの項目・（目標未達なら）最低点の
 * 項目から作る。同じ失敗なら同じ指紋になり、次の回はこれを「直した失敗」として指す。
 */
export function deriveFailureFingerprint({ failedGateIds = [], floorFailures = [], rawReviews = [], contract, belowTarget = false, acceptanceFailures = [] } = {}) {
  let lowest = "";
  if (belowTarget) {
    const totals = new Map();
    for (const review of rawReviews) {
      for (const criterion of contract?.rubric || []) {
        const score = Number(review?.scores?.[criterion.id]);
        if (Number.isFinite(score)) totals.set(criterion.id, (totals.get(criterion.id) || 0) + score);
      }
    }
    lowest = [...totals.entries()].sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))[0]?.[0] || "";
  }
  const acceptance = uniqueStrings(acceptanceFailures).sort();
  const body = JSON.stringify({
    gates: uniqueStrings(failedGateIds).sort(),
    floors: uniqueStrings(floorFailures).sort(),
    lowest,
    // 受け入れ方の失敗（評価者の欠け・評価者ごとの点）は、あるときだけ指紋に入れる。
    // 無いときの指紋は今までと同じ値になる。
    ...(acceptance.length > 0 ? { acceptance } : {}),
  });
  return `quality-failure:${sha256Text(body).slice(0, 24)}`;
}

function paidMediaJobKey(job) {
  const digest = nonEmptyString(job?.requestKeyDigest).replace(/^sha256:/u, "").toLowerCase();
  if (validSha256(digest)) return `request:${digest}`;
  const requestKey = nonEmptyString(job?.requestKey);
  if (requestKey) return `request:${sha256Text(requestKey)}`;
  const jobId = nonEmptyString(job?.jobId);
  return jobId ? `job:${sha256Text(jobId)}` : "";
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 有料生成の記録（Media Job の受領記録。RunReceipt の mediaJobs と同じ形）から、
 * まだどの回にも数えていない分の費用を集計する。ジャンルに依らない。
 *
 * - 同じ Media Job（requestKey の digest で識別）を2回数えない。countedKeys は前の回までに
 *   数えた分（状態の costedKeys）
 * - 実費（usage.cost）が無ければ予約時の見積もり（reservation.estimatedCost）で数え、
 *   どちらも無い take は 0 として足すが unpricedCount に残す（黙って 0 円にしない）
 * - 無料の作り直し（usage.freeRegeneration）は数えない
 * - 単位は提供元が申告した通貨。無申告なら "unspecified"、複数あれば "mixed"（合計できない）
 */
export function summarizePaidMediaCost(mediaJobs = [], { countedKeys = [], source = null } = {}) {
  const counted = new Set(uniqueStrings(countedKeys));
  const newKeys = [];
  const units = new Set();
  let cost = 0;
  let pricedCount = 0;
  let estimatedCount = 0;
  let unpricedCount = 0;
  let freeCount = 0;
  for (const job of Array.isArray(mediaJobs) ? mediaJobs : []) {
    const key = paidMediaJobKey(job);
    if (!key || counted.has(key) || newKeys.includes(key)) continue;
    newKeys.push(key);
    if (job?.usage?.freeRegeneration === true) {
      freeCount += 1;
      continue;
    }
    const actual = finiteOrNull(job?.usage?.cost);
    const estimate = finiteOrNull(job?.reservation?.estimatedCost);
    const amount = actual ?? estimate;
    if (amount === null) {
      unpricedCount += 1;
      continue;
    }
    if (actual === null) estimatedCount += 1;
    else pricedCount += 1;
    cost += Math.max(0, amount);
    const unit = nonEmptyString(actual === null ? job?.reservation?.currency : job?.usage?.currency)
      || nonEmptyString(job?.usage?.currency)
      || nonEmptyString(job?.reservation?.currency);
    units.add(unit ? unit.toUpperCase() : "unspecified");
  }
  const specified = [...units].filter((unit) => unit !== "unspecified");
  const unit = specified.length > 1
    ? "mixed"
    : specified[0] || "unspecified";
  return {
    cost: Number(cost.toFixed(6)),
    unit,
    units: [...units].sort(),
    source: source && typeof source === "object"
      ? { path: sanitizeEvidence(source.path, 1_000), sha256: nonEmptyString(source.sha256).toLowerCase(), kind: sanitizeEvidence(source.kind, 200) }
      : null,
    countedKeys: newKeys,
    newJobCount: newKeys.length,
    pricedCount,
    estimatedCount,
    unpricedCount,
    freeCount,
  };
}

function normalizeCostAccounting(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    unit: nonEmptyString(value.unit) || "unspecified",
    units: uniqueStrings(value.units),
    source: value.source && typeof value.source === "object"
      ? {
        path: sanitizeEvidence(value.source.path, 1_000),
        sha256: nonEmptyString(value.source.sha256).toLowerCase(),
        kind: sanitizeEvidence(value.source.kind, 200),
      }
      : null,
    countedKeys: uniqueStrings(value.countedKeys),
    newJobCount: Math.max(0, Math.round(finiteNumber(value.newJobCount, 0))),
    pricedCount: Math.max(0, Math.round(finiteNumber(value.pricedCount, 0))),
    estimatedCount: Math.max(0, Math.round(finiteNumber(value.estimatedCount, 0))),
    unpricedCount: Math.max(0, Math.round(finiteNumber(value.unpricedCount, 0))),
    freeCount: Math.max(0, Math.round(finiteNumber(value.freeCount, 0))),
    cost: Math.max(0, finiteNumber(value.cost, 0)),
  };
}

// 回に残すのは集計の内訳だけ。数えた Media Job の一覧は状態（costedKeys）に1つだけ持つ。
function roundCostAccounting({ countedKeys: _countedKeys, ...rest }) {
  return rest;
}

export const STALE_FEEDBACK_REASON_CODE = "quality-feedback-not-updated";

// 所見の本文の比較用の正規化。全角・半角の揺れ（NFKC）、大文字小文字、空白の有無では
// 別の所見にならない。
function normalizeFeedbackText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/gu, "");
}

/**
 * 直前の回と同じ所見（正規化後）の評価を見つける。見つかれば理由コードを返す。
 *
 * 文脈を新しくしても、所見が前回の写しなら「評価が更新されていない」。直した版を見ずに
 * 前回の所見と点数だけを貼り直した評価で回を進めると、改善したかどうかが分からないまま
 * 合格や停滞の判定が付く。
 */
export function findStaleQualityFeedback({ state, reviews = [] } = {}) {
  const previousRound = Array.isArray(state?.rounds) ? state.rounds.at(-1) : null;
  if (!previousRound) return null;
  const previousNotes = new Set((previousRound.reviews || [])
    .map((review) => normalizeFeedbackText(review?.notes))
    .filter(Boolean));
  for (const review of Array.isArray(reviews) ? reviews : []) {
    const normalized = normalizeFeedbackText(sanitizeEvidence(review?.notes));
    if (normalized && previousNotes.has(normalized)) {
      return {
        reasonCode: STALE_FEEDBACK_REASON_CODE,
        previousRoundIndex: previousRound.index,
        evaluatorContextId: nonEmptyString(review?.evaluatorContextId),
        detail: `評価の所見が直前の回（${previousRound.index} 回目）と同じ。直した版を見た新しい評価で採点し直すこと`,
      };
    }
  }
  return null;
}

/**
 * 合格しないまま止まったときに、納品判断の材料として残す最高点の回。合格扱いにはしない。
 * 同点なら後の回（直した後の版）を選ぶ。
 */
function bestNonPassingRound(rounds = []) {
  let best = null;
  for (const round of rounds) {
    if (!best || round.score >= best.score) best = round;
  }
  if (!best) return null;
  return {
    index: best.index,
    score: best.score,
    passed: false,
    hardGatePass: best.hardGatePass,
    floorFailures: [...(best.floorFailures || [])],
    failedGateIds: [...(best.failedGateIds || [])],
    failureFingerprint: best.failureFingerprint,
    artifactSha256: nonEmptyString(best.artifactSha256),
    evidence: (best.evidence || []).map((row) => ({ path: row.path, sha256: row.sha256 })),
    evidenceMerkleRoot: nonEmptyString(best.evidenceMerkleRoot),
    observedAt: best.observedAt,
    note: "合格していない。止まった時点で最も点の高かった回で、納品するかは人が決める",
  };
}

export function createQualityLoopState(input = {}) {
  const contract = input.contract;
  if (!contract?.digest) throw new Error("An immutable quality contract is required.");
  const startedAt = nonEmptyString(input.startedAt) || new Date().toISOString();
  if (!Number.isFinite(Date.parse(startedAt))) throw new Error("Quality loop startedAt must be a valid timestamp.");
  const generatorId = nonEmptyString(input.generatorId);
  const generatorContextId = nonEmptyString(input.generatorContextId);
  if (!generatorId || !generatorContextId) {
    throw new Error("Quality loop requires real generatorId and generatorContextId provenance.");
  }
  return {
    version: input.version ?? contract.version ?? QUALITY_LOOP_VERSION,
    episodeId: nonEmptyString(input.episodeId || contract.episodeId),
    contractDigest: contract.digest,
    generatorHost: nonEmptyString(input.generatorHost),
    generatorId,
    generatorContextId,
    generatorProvenance: input.generatorProvenance && typeof input.generatorProvenance === "object"
      ? structuredClone(input.generatorProvenance)
      : null,
    status: "active",
    startedAt: new Date(startedAt).toISOString(),
    rounds: [],
    bestScore: null,
    stagnantRounds: 0,
    totalCost: 0,
    elapsedMs: 0,
    nextAction: "run-deterministic-gates",
  };
}

export function recordQualityRound(input = {}) {
  const contract = input.contract;
  const previous = input.state;
  if (!contract?.digest || previous?.contractDigest !== contract.digest) {
    throw new Error("Quality contract changed during the run; start a new run instead.");
  }
  if (previous.status !== "active") throw new Error(`Quality loop is already ${previous.status}.`);
  const reviews = Array.isArray(input.reviews) ? input.reviews : [];
  if (reviews.length === 0) throw new Error("At least one independent review is required.");
  const acceptance = normalizeQualityAcceptance(contract.acceptance);
  // 1つの回（評価の組）の中の評価は、それぞれ別の評価文脈で、同じ成果物を採点したものでなければならない。
  // 同じ文脈の2件を2人分に数えたり、別の版の点を混ぜて平均したりしない。
  const roundContexts = reviews.map((review) => nonEmptyString(review?.evaluatorContextId)).filter(Boolean);
  if (new Set(roundContexts).size !== roundContexts.length) {
    throw new Error("Each review in a round requires its own evaluator context.");
  }
  const roundArtifact = nonEmptyString(input.artifactSha256).toLowerCase();
  const reviewArtifacts = reviews.map((review) => nonEmptyString(review?.artifactSha256).toLowerCase()).filter(Boolean);
  if (reviewArtifacts.some((sha) => sha !== (validSha256(roundArtifact) ? roundArtifact : reviewArtifacts[0]))) {
    throw new Error("Every review in a round must score the same artifact (artifactSha256).");
  }
  if (acceptance.evaluators.length > 0) {
    const ids = reviews.map((review) => nonEmptyString(review?.evaluatorId));
    const undeclared = ids.filter((id) => id && !acceptance.evaluators.includes(id));
    if (undeclared.length > 0) throw new Error(`Review from an undeclared evaluator: ${undeclared.join(", ")}.`);
    if (new Set(ids).size !== ids.length) throw new Error("A declared evaluator can review a round only once.");
  }
  const costAccounting = normalizeCostAccounting(input.costAccounting);
  // 回ごとに求めるのは「まっさらな文脈」。同じ人（同じ reviewer id）が直した版を見直すのは
  // 許す——運営者が1人のチャンネルでは、id まで毎回変えることを求めると2回目の回が
  // 記録できず、ループが1回で止まっていた（2026-09-24）。文脈の使い回しは今どおり拒否する。
  const priorEvaluators = new Set(previous.rounds.flatMap((round) => round.reviews.map((review) => review.evaluatorId)));
  const priorEvaluatorContexts = new Set(previous.rounds.flatMap((round) => round.reviews.map((review) => review.evaluatorContextId)));
  const normalizedReviews = reviews.map((review) => {
    const evaluatorId = nonEmptyString(review?.evaluatorId);
    const evaluatorContextId = nonEmptyString(review?.evaluatorContextId);
    if (!evaluatorId) throw new Error("Every review requires evaluatorId.");
    if (!evaluatorContextId) throw new Error("Every review requires evaluatorContextId.");
    if (evaluatorId === previous.generatorId) throw new Error("The generator cannot judge its own output.");
    if (evaluatorContextId === previous.generatorContextId) throw new Error("The generator context cannot judge its own output under another name.");
    if (priorEvaluatorContexts.has(evaluatorContextId)) throw new Error(`Fresh evaluator context required; ${evaluatorContextId} already reviewed an earlier round.`);
    const notes = sanitizeEvidence(review.notes);
    if (notes.length < 4) throw new Error("Every review requires concrete notes.");
    const reviewArtifact = nonEmptyString(review?.artifactSha256).toLowerCase();
    return {
      evaluatorId,
      evaluatorContextId,
      evaluatorHost: nonEmptyString(review?.evaluatorHost),
      repeatEvaluator: priorEvaluators.has(evaluatorId),
      candidateLabel: nonEmptyString(review.candidateLabel).toUpperCase(),
      score: weightedReviewScore(review, contract),
      notes,
      evidence: normalizeEvidenceRows(review.evidence),
      ...(validSha256(reviewArtifact) ? { artifactSha256: reviewArtifact } : {}),
    };
  });
  const staleFeedback = findStaleQualityFeedback({ state: previous, reviews: normalizedReviews });
  if (staleFeedback) {
    const error = new Error(`${staleFeedback.reasonCode}: ${staleFeedback.detail}`);
    error.code = staleFeedback.reasonCode;
    error.staleFeedback = staleFeedback;
    throw error;
  }
  const score = Number((normalizedReviews.reduce((sum, review) => sum + review.score, 0) / normalizedReviews.length).toFixed(3));
  // 加重平均だけで判定すると、1つの項目の致命的な低さが他の満点で薄まる
  // （同一性 47 点・他は満点で平均 92.05 が合格していた。2026-09-24）。
  const floorFailures = rubricFloorFailures(reviews, contract);
  if (input.hardGateReport?.contractDigest !== contract.digest) {
    throw new Error("Hard-gate report must be bound to the immutable quality contract digest.");
  }
  const hardGatePass = input.hardGateReport?.pass === true;
  const candidateSetId = nonEmptyString(input.candidateSetId);
  const candidateVerdictDigest = nonEmptyString(input.candidateVerdictDigest);
  if (candidateSetId && (!candidateVerdictDigest || normalizedReviews.some((review) => !review.candidateLabel))) {
    throw new Error("Candidate comparison requires labeled reviews and a recorded verdict digest.");
  }
  const previousBest = previous.bestScore;
  const improvement = previousBest === null ? score : score - previousBest;
  const bestScore = previousBest === null ? score : Math.max(previousBest, score);
  const stagnantRounds = previousBest === null || improvement >= contract.limits.minimumImprovement
    ? 0
    : previous.stagnantRounds + 1;
  const observedAt = nonEmptyString(input.observedAt) || new Date().toISOString();
  if (!Number.isFinite(Date.parse(observedAt))) {
    throw new Error("Round observedAt must be a valid timestamp.");
  }
  // 時計は「ループの中で観測された最も早い時刻」から「最も遅い時刻」までの長さで数える。
  // レビューの署名時刻（observedAt）とループを開いた監査の時刻（startedAt）は、運用に
  // よってどちらが先にもなる（署名してから最初の監査を走らせる、契約が変わってループを
  // 作り直す、など）。以前は observedAt < startedAt を例外にしていて、レビュー後に監査すると
  // 監査そのものが落ちていた。拒否ではなく順序を正す理由: レビューは現在の MP4 の SHA に
  // 縛られているので、その MP4 が出来る前の時刻にはなれない。早い方を起点にしても
  // 予算が延びることはなく（経過時間は必ず長くなる側に倒れる）、逆に拒否すると
  // 意味の無い署名のやり直しを強いるだけになる。
  const priorClockStart = Date.parse(nonEmptyString(previous.clockStartedAt) || previous.startedAt);
  const priorClockLatest = Date.parse(nonEmptyString(previous.clockLatestAt) || previous.startedAt);
  const observedMs = Date.parse(observedAt);
  const clockStartMs = Math.min(priorClockStart, observedMs);
  const clockLatestMs = Math.max(priorClockLatest, observedMs);
  const revisionDelta = sanitizeEvidence(input.revisionDelta);
  if (previous.rounds.length > 0 && revisionDelta.length < 4) {
    throw new Error("Every retry requires a concrete revisionDelta from the previous failure.");
  }
  const expectedPreviousFailure = previous.rounds.at(-1)?.failureFingerprint || "";
  if (previous.rounds.length > 0 && nonEmptyString(input.previousFailureFingerprint) !== expectedPreviousFailure) {
    throw new Error("Retry must reference the immediately previous failure fingerprint.");
  }
  const acceptanceResult = evaluateAcceptance({ acceptance, normalizedReviews, reviews, contract });
  const passingTarget = hardGatePass
    && score >= contract.limits.targetScore
    && floorFailures.length === 0
    && acceptanceResult.failures.length === 0;
  // 呼び出し側が指紋を渡さないときは、何が足りなかったかから作る。機械ゲートが全部通って
  // 評価点だけ足りない回でも、次の回が「どの失敗を直したか」を指せるようにするため
  // （以前は落ちたゲート名からしか作っておらず、この回で例外になっていた）。
  const failureFingerprint = nonEmptyString(input.failureFingerprint)
    || (passingTarget ? "" : deriveFailureFingerprint({
      failedGateIds: input.hardGateReport?.failedGateIds,
      floorFailures,
      reviews: normalizedReviews,
      rawReviews: reviews,
      contract,
      belowTarget: score < contract.limits.targetScore,
      acceptanceFailures: acceptanceResult.failures,
    }));
  if (!passingTarget && failureFingerprint.length < 8) {
    throw new Error("A non-passing round requires a stable failureFingerprint.");
  }
  const round = {
    index: previous.rounds.length + 1,
    candidateSetId,
    candidateVerdictDigest,
    hardGatePass,
    failedGateIds: uniqueStrings(input.hardGateReport?.failedGateIds),
    floorFailures,
    score,
    improvement: Number(improvement.toFixed(3)),
    reviews: normalizedReviews,
    evidence: normalizeEvidenceRows(input.evidence),
    failureFingerprint,
    previousFailureFingerprint: nonEmptyString(input.previousFailureFingerprint),
    revisionDelta,
    // 受け入れ方を宣言した契約だけ、評価者ごとの結果を回に残す（既定の契約の回の形は変えない）。
    ...(acceptance.declared ? { acceptance: acceptanceResult.record } : {}),
    reviewDigest: nonEmptyString(input.reviewDigest),
    evidenceMerkleRoot: nonEmptyString(input.evidenceMerkleRoot),
    // この回に評価した成果物（完成 MP4 など）の SHA。止まったときの bestRound に使う。
    artifactSha256: validSha256(nonEmptyString(input.artifactSha256).toLowerCase())
      ? nonEmptyString(input.artifactSha256).toLowerCase()
      : "",
    // 費用は呼び出し側が数えた値（cost）か、有料生成の記録を集計した costAccounting の値。
    // 両方あれば cost を優先する（旧来の呼び出し側の意味を変えない）。
    cost: Math.max(0, finiteNumber(input.cost, costAccounting?.cost ?? 0)),
    ...(costAccounting ? { costAccounting: roundCostAccounting(costAccounting) } : {}),
    observedAt: new Date(observedAt).toISOString(),
    // この回までの経過時間（ループの時計の起点から、この回までに観測した最も遅い時刻まで）。
    elapsedMs: Math.max(0, clockLatestMs - clockStartMs),
  };
  const state = {
    ...previous,
    rounds: [...previous.rounds, round],
    bestScore,
    stagnantRounds,
    totalCost: previous.totalCost + round.cost,
    ...(costAccounting ? {
      // 数えた Media Job（requestKey の digest）。次の回は、ここに無い分だけを数える。
      costedKeys: uniqueStrings([...(previous.costedKeys || []), ...costAccounting.countedKeys]),
      costUnit: nonEmptyString(previous.costUnit)
        || (costAccounting.unit !== "unspecified" && costAccounting.unit !== "mixed" ? costAccounting.unit : ""),
    } : {}),
    clockStartedAt: new Date(clockStartMs).toISOString(),
    clockLatestAt: new Date(clockLatestMs).toISOString(),
    elapsedMs: Math.max(finiteNumber(previous.elapsedMs, 0), round.elapsedMs),
  };
  // 通貨が混ざった、または前の回と単位が変わった費用は合計できない。上限の判定ができない
  // まま回し続けないよう、人の判断へ回す。
  const costUnitConflict = costAccounting && round.cost > 0 && (
    costAccounting.unit === "mixed"
    || (nonEmptyString(previous.costUnit)
      && costAccounting.unit !== "unspecified"
      && costAccounting.unit !== previous.costUnit)
  )
    ? `cost-unit-conflict: この回の費用の単位 ${costAccounting.unit}（${costAccounting.units.join(", ") || "-"}）を`
      + `${nonEmptyString(previous.costUnit) ? `これまでの単位 ${previous.costUnit} と` : ""}合計できない`
    : "";
  const blockingCondition = sanitizeEvidence(input.blockingCondition) || costUnitConflict;
  if (passingTarget) {
    state.status = "passed";
    state.stopReason = "target-reached";
    state.nextAction = "publish-checklist-and-final-watch";
  } else if (blockingCondition) {
    state.status = "blocked";
    state.stopReason = "blocking-condition";
    state.blockingCondition = blockingCondition;
    state.nextAction = "human-review";
  } else if (state.totalCost >= contract.limits.maximumCost) {
    state.status = "budget-exhausted";
    state.stopReason = "cost-limit";
    state.nextAction = "human-review";
  } else if (state.elapsedMs >= contract.limits.maximumElapsedMs) {
    state.status = "budget-exhausted";
    state.stopReason = "time-limit";
    state.nextAction = "human-review";
  } else if (state.rounds.length >= contract.limits.maximumReviewRounds) {
    state.status = "needs-human-approval";
    state.stopReason = "round-limit";
    state.nextAction = "human-review";
  } else if (state.stagnantRounds >= contract.limits.maximumStagnantRounds) {
    state.status = "needs-human-approval";
    state.stopReason = "no-improvement";
    state.nextAction = "human-review";
  } else {
    state.status = "active";
    state.stopReason = "";
    state.nextAction = hardGatePass ? "revise-lowest-rubric-category" : "repair-failed-hard-gates";
  }
  // 合格しないまま止まったら、最高点の回を納品判断の材料として残す（合格扱いにはしない）。
  if (state.status !== "passed" && state.status !== "active") state.bestRound = bestNonPassingRound(state.rounds);
  else delete state.bestRound;
  return deepFreeze(state);
}
