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
export function deriveFailureFingerprint({ failedGateIds = [], floorFailures = [], rawReviews = [], contract, belowTarget = false } = {}) {
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
  const body = JSON.stringify({
    gates: uniqueStrings(failedGateIds).sort(),
    floors: uniqueStrings(floorFailures).sort(),
    lowest,
  });
  return `quality-failure:${sha256Text(body).slice(0, 24)}`;
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
    return {
      evaluatorId,
      evaluatorContextId,
      evaluatorHost: nonEmptyString(review?.evaluatorHost),
      repeatEvaluator: priorEvaluators.has(evaluatorId),
      candidateLabel: nonEmptyString(review.candidateLabel).toUpperCase(),
      score: weightedReviewScore(review, contract),
      notes,
      evidence: normalizeEvidenceRows(review.evidence),
    };
  });
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
  if (!Number.isFinite(Date.parse(observedAt)) || Date.parse(observedAt) < Date.parse(previous.startedAt)) {
    throw new Error("Round observedAt must be a valid timestamp at or after startedAt.");
  }
  const revisionDelta = sanitizeEvidence(input.revisionDelta);
  if (previous.rounds.length > 0 && revisionDelta.length < 4) {
    throw new Error("Every retry requires a concrete revisionDelta from the previous failure.");
  }
  const expectedPreviousFailure = previous.rounds.at(-1)?.failureFingerprint || "";
  if (previous.rounds.length > 0 && nonEmptyString(input.previousFailureFingerprint) !== expectedPreviousFailure) {
    throw new Error("Retry must reference the immediately previous failure fingerprint.");
  }
  const passingTarget = hardGatePass && score >= contract.limits.targetScore && floorFailures.length === 0;
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
    reviewDigest: nonEmptyString(input.reviewDigest),
    evidenceMerkleRoot: nonEmptyString(input.evidenceMerkleRoot),
    cost: Math.max(0, finiteNumber(input.cost, 0)),
    observedAt: new Date(observedAt).toISOString(),
    elapsedMs: Math.max(0, Date.parse(observedAt) - Date.parse(previous.startedAt)),
  };
  const state = {
    ...previous,
    rounds: [...previous.rounds, round],
    bestScore,
    stagnantRounds,
    totalCost: previous.totalCost + round.cost,
    elapsedMs: Math.max(previous.elapsedMs, round.elapsedMs),
  };
  const blockingCondition = sanitizeEvidence(input.blockingCondition);
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
  return deepFreeze(state);
}
