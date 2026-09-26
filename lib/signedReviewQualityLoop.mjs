/**
 * 署名済みの独立レビュー（signoff）を、品質ループの1回にする配線（ジャンルに依らない）。
 *
 * 中核（採点・下限・失敗指紋・止まる条件・作る係と評価する係の分離）は lib/qualityLoop.mjs にあり、ここは
 * 「完成 MP4 を別の文脈の評価者が見て、信頼リストの鍵で署名した signoff」を回として記録するところだけを持つ。
 * ナレーション物語（lib/narratedStoryQualityLoop.mjs）と解説動画（lib/explainerQualityLoop.mjs）が同じものを使う。
 * ジャンルが決めるのは評価項目・下限・上限（品質契約）と、次の spec だけ:
 *   - harnessId: 前の Job を引き継ぐときに照らすハーネス（名乗りの確認と案内の文）
 *   - jobIdPattern: 前の Job の id の形（別のハーネスの Job から引き継がない）
 *   - generatorId: 作る係の id（評価者がこれを名乗っても採点できない）
 *   - loopAuditIds: 品質ループの結果から決まる監査の id（機械ゲートに数えない）
 *
 * 出力を直すと別の Job になるジャンルでは、2回目以降は新しい Job の作業領域の revision-delta.json に前の Job
 * （predecessorJobId）と前回の失敗指紋を書いてループを引き継ぐ。同じ Job の中の2回目（同じ MP4 の見直し）も
 * 記録できるが、出力が変わっていないことを証跡に残す。
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { renameWithRetry } from "./atomicJsonFile.mjs";
import {
  createQualityLoopState,
  recordQualityRound,
  sanitizeEvidence,
  validSha256,
} from "./qualityLoop.mjs";

export const SIGNED_REVIEW_QUALITY_DIR = "quality";
export const SIGNED_REVIEW_QUALITY_STATE_FILE = "quality-loop-state.json";
export const SIGNED_REVIEW_REVISION_DELTA_FILE = "revision-delta.json";

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJsonIfPresent(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await renameWithRetry(temp, path);
}

/**
 * 評価者に渡す評価シート。何を採点するか（評価項目の id・名前・説明）と点数の尺度、採点を結び付ける契約の
 * digest だけを載せる。
 *
 * 合格点（targetScore）・項目ごとの下限・重み・前の回の点数（とそれが書かれた品質ループの状態の置き場）は
 * 載せない。評価者に合格点や前回の点を見せると、採点がそれに寄る（合格点のすぐ上に集まる、前回から少しだけ
 * 上げる）。合否の判定はループ側（lib/qualityLoop.mjs と品質契約）だけが持つ。
 */
export function signedReviewSheet(contract) {
  return {
    contractVersion: contract.version,
    contractDigest: contract.digest,
    scale: { minimum: 0, maximum: 100 },
    rubric: contract.rubric.map((criterion) => ({
      id: criterion.id,
      label: criterion.label,
      description: criterion.description,
    })),
  };
}

/** 評価シートに載せてはいけない項目（合否の判定の材料と、前の回の点数への手がかり）。試験が見る。 */
export const REVIEW_SHEET_FORBIDDEN_KEYS = Object.freeze([
  "targetScore", "minimumScore", "weight", "score", "scores", "rubricScores", "rounds", "floorFailures",
  "failureFingerprint", "statePath", "revisionDeltaPath", "limits",
]);

/** 品質ループの状態と修正内容の置き場（Job の作業領域の quality/）。 */
export function signedReviewQualityPaths(runDir) {
  const dir = join(runDir, SIGNED_REVIEW_QUALITY_DIR);
  return {
    dir,
    statePath: join(dir, SIGNED_REVIEW_QUALITY_STATE_FILE),
    revisionDeltaPath: join(dir, SIGNED_REVIEW_REVISION_DELTA_FILE),
  };
}

/**
 * reviewer の採点ファイル（signoff --review-path）を検査して signoff 本文へ載せる形にする。
 * 形: { rubricScores: { <id>: 0〜100 }, notes: "所見", findings: ["直すべき点", ...] }
 * `sheet` はその Job の評価シート（signedReviewSheet の出力）。
 */
export function normalizeSignedReviewInput(review, sheet, { approved } = {}) {
  if (!review || typeof review !== "object" || Array.isArray(review)) {
    throw new Error("quality-review-invalid: the review file must be a JSON object { rubricScores, notes, findings }.");
  }
  if (!sheet?.contractDigest || !Array.isArray(sheet.rubric) || sheet.rubric.length === 0) {
    throw new Error("quality-review-contract-unavailable: the Job has no recorded quality contract yet; resume the Job so production records it before signing.");
  }
  const scores = review.rubricScores;
  if (!scores || typeof scores !== "object" || Array.isArray(scores)) {
    throw new Error("quality-review-scores-required: rubricScores must map every criterion id to a score from 0 to 100.");
  }
  const ids = sheet.rubric.map((criterion) => criterion.id);
  const missing = ids.filter((id) => scores[id] === undefined);
  const unknown = Object.keys(scores).filter((id) => !ids.includes(id));
  const invalid = ids.filter((id) => scores[id] !== undefined
    && (typeof scores[id] !== "number" || !Number.isFinite(scores[id]) || scores[id] < 0 || scores[id] > 100));
  if (missing.length || unknown.length || invalid.length) {
    throw new Error(`quality-review-scores-invalid: missing=${missing.join(",") || "none"} unknown=${unknown.join(",") || "none"} invalid=${invalid.join(",") || "none"} (criteria: ${ids.join(", ")})`);
  }
  const notes = sanitizeEvidence(review.notes);
  if (notes.length < 4) throw new Error("quality-review-notes-required: notes must describe what was watched and judged (4+ characters).");
  if (review.findings !== undefined && !Array.isArray(review.findings)) {
    throw new Error("quality-review-findings-invalid: findings must be an array of strings.");
  }
  const findings = (review.findings || []).map((entry) => sanitizeEvidence(entry, 1_000)).filter(Boolean);
  if ((review.findings || []).length !== findings.length || findings.length > 50) {
    throw new Error("quality-review-findings-invalid: findings must be 0 to 50 non-empty strings.");
  }
  if (approved === true && findings.length > 0) {
    throw new Error("quality-review-findings-conflict: --pass means no remaining findings; use --fail to record a review that asks for changes.");
  }
  if (approved === false && findings.length === 0) {
    throw new Error("quality-review-findings-required: --fail needs at least one finding that says what to change.");
  }
  return {
    qualityReview: {
      contractDigest: sheet.contractDigest,
      rubricScores: Object.fromEntries(ids.map((id) => [id, scores[id]])),
      notes,
    },
    findings,
  };
}

/** finalize 側で、signoff 本文の qualityReview が今の契約と評価文脈に合っているかを見る。 */
export function inspectSignedQualityReview(signoff, contract) {
  const review = signoff?.qualityReview;
  const problems = [];
  if (!review || typeof review !== "object" || Array.isArray(review)) {
    return { ok: false, problems: ["quality-review-missing"] };
  }
  if (review.contractDigest !== contract.digest) problems.push("quality-review-contract-mismatch");
  const reviewerContextId = nonEmpty(signoff?.reviewerContextId);
  const evaluatorContextId = nonEmpty(review.evaluatorContextId) || reviewerContextId;
  // 評価文脈は reviewer の文脈そのもの。別の値を書けると「文脈は新しい」と見せかけて
  // 同じ reviewer 文脈で2回目を採点できてしまう。
  if (evaluatorContextId !== reviewerContextId) problems.push("quality-review-evaluator-context-mismatch");
  const scores = review.rubricScores && typeof review.rubricScores === "object" && !Array.isArray(review.rubricScores)
    ? review.rubricScores
    : null;
  if (!scores) problems.push("quality-review-scores-missing");
  else {
    for (const criterion of contract.rubric) {
      const score = scores[criterion.id];
      if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 100) {
        problems.push(`quality-review-score-invalid:${criterion.id}`);
      }
    }
    const known = new Set(contract.rubric.map((criterion) => criterion.id));
    for (const id of Object.keys(scores)) if (!known.has(id)) problems.push(`quality-review-score-unknown:${id}`);
  }
  if (sanitizeEvidence(review.notes).length < 4) problems.push("quality-review-notes-required");
  return {
    ok: problems.length === 0,
    problems,
    evaluatorContextId,
    scores: scores || {},
    notes: sanitizeEvidence(review.notes),
  };
}

function lastRound(state) {
  return Array.isArray(state?.rounds) ? state.rounds.at(-1) || null : null;
}

function contextsUsed(state) {
  return new Set((state?.rounds || []).flatMap((round) => (round.reviews || []).map((review) => review.evaluatorContextId)));
}

/** 状態から、次に何が要るかを knownRemainingIssues の形で返す。合格なら空。 */
function issuesFromState(state, contract) {
  if (!state || state.status === "passed") return [];
  const round = lastRound(state);
  const issues = [];
  if (round) {
    issues.push(`quality-loop-round-${round.index}-not-passed:${round.failureFingerprint}`);
    for (const id of round.floorFailures || []) issues.push(`quality-loop-floor-failed:${id}`);
    if (round.score < contract.limits.targetScore) issues.push(`quality-loop-below-target:${round.score}<${contract.limits.targetScore}`);
    for (const id of round.failedGateIds || []) issues.push(`quality-loop-hard-gate-failed:${id}`);
  }
  if (state.status === "active") issues.push("quality-loop-revision-and-fresh-review-required");
  else issues.push(`quality-loop-stopped:${state.status}:${state.stopReason || "unknown"}`);
  return issues;
}

function nextStepDetail(state, paths) {
  const round = lastRound(state);
  if (!round) return "";
  if (state.status !== "active") {
    return `品質ループは ${state.status}（${state.stopReason}）で止まった。続けるかどうかは人が決める。`;
  }
  return `次の回には、前回の失敗（${round.failureFingerprint}）をどう直したかを ${paths.revisionDeltaPath} に `
    + `{ "previousFailureFingerprint": "${round.failureFingerprint}", "revisionDelta": "直した内容" } で書き、`
    + "新しい評価文脈のレビューで signoff し直すこと。直した出力が別の Job になったときは、その Job の作業領域の "
    + `${SIGNED_REVIEW_QUALITY_DIR}/${SIGNED_REVIEW_REVISION_DELTA_FILE} に "predecessorJobId" としてこの Job の id も書く`;
}

/** 監査の qualityLoopPassed を組む。合格のときだけ signoff と成果物の SHA（binding）を載せる。 */
function qualityCheck({ state, contract, pass, detail, stateSha256 = "", binding = {} }) {
  const round = lastRound(state);
  return {
    pass: pass === true,
    detail,
    contractVersion: contract.version,
    contractDigest: contract.digest,
    status: state?.status || "not-started",
    stopReason: state?.stopReason || "",
    rounds: state?.rounds?.length || 0,
    score: round ? round.score : null,
    targetScore: contract.limits.targetScore,
    floorFailures: round ? [...(round.floorFailures || [])] : [],
    failureFingerprint: round?.failureFingerprint || "",
    stateSha256,
    ...(pass === true ? binding : {}),
  };
}

function waiting({ state, contract, issues, detail, stateSha256 = "" }) {
  return {
    state,
    recorded: false,
    issues,
    check: qualityCheck({ state, contract, pass: false, detail, stateSha256 }),
  };
}

async function readPredecessor({ spec, predecessorJobId, jobId, predecessorStatePath, contract, previousFailureFingerprint }) {
  if (!spec.jobIdPattern.test(predecessorJobId) || predecessorJobId === jobId) {
    return { ok: false, issue: "quality-loop-predecessor-invalid", detail: `predecessorJobId は別の ${spec.harnessId} Job の id であること` };
  }
  if (typeof predecessorStatePath !== "function") {
    return { ok: false, issue: "quality-loop-predecessor-unavailable", detail: "前の Job の品質ループを読む手段が無い" };
  }
  const state = await readJsonIfPresent(predecessorStatePath(predecessorJobId)).catch(() => null);
  if (!state || !Array.isArray(state.rounds) || state.rounds.length === 0) {
    return { ok: false, issue: `quality-loop-predecessor-missing:${predecessorJobId}`, detail: `前の Job ${predecessorJobId} に記録済みの品質ループの回が無い` };
  }
  if (state.contractDigest !== contract.digest) {
    return {
      ok: false,
      issue: `quality-loop-predecessor-contract-changed:${predecessorJobId}`,
      detail: `前の Job ${predecessorJobId} の品質ループは別の契約で回っていた。引き継ぐか新しく始めるかは人が決める（新しく始めるなら predecessorJobId を外す）`,
    };
  }
  if (state.status !== "active") {
    return {
      ok: false,
      issue: `quality-loop-predecessor-stopped:${state.status}:${state.stopReason || "unknown"}`,
      detail: `前の Job ${predecessorJobId} の品質ループは ${state.status}（${state.stopReason || ""}）で止まっている。続けるかどうかは人が決める`,
    };
  }
  if (lastRound(state)?.failureFingerprint !== previousFailureFingerprint) {
    return {
      ok: false,
      issue: `quality-loop-revision-delta-stale:${lastRound(state)?.failureFingerprint || ""}`,
      detail: `revision-delta.json の previousFailureFingerprint が前の Job の最後の失敗（${lastRound(state)?.failureFingerprint || ""}）と違う`,
    };
  }
  const predecessors = Array.isArray(state.predecessorJobIds) ? state.predecessorJobIds.map(String) : [];
  if (predecessors.includes(jobId)) {
    return { ok: false, issue: "quality-loop-predecessor-cycle", detail: "前の Job の系譜にこの Job が含まれている" };
  }
  return {
    ok: true,
    state: {
      ...state,
      predecessorJobIds: [...predecessors, predecessorJobId],
    },
  };
}

function assertSpec(spec) {
  if (!nonEmpty(spec?.harnessId) || !(spec?.jobIdPattern instanceof RegExp) || !nonEmpty(spec?.generatorId)) {
    throw new Error("signed-review-quality-spec-invalid: harnessId・jobIdPattern・generatorId が要る。");
  }
}

/**
 * 署名検証を通った signoff を品質ループの1回として記録し、監査の qualityLoopPassed と人待ちの理由を返す。
 * 例外は投げない（人の判断が要る状態は issues で返す）。
 *
 * - signoff が無い／署名や SHA の検査に落ちた → 回を記録しない（証拠にならない）
 * - 同じ signoff で既に記録済み → その回の結果をそのまま返す（再開しても二重に記録しない）
 * - 前の回で使われた評価文脈 → 人待ち（新しい文脈のレビューが要る）
 * - 2回目以降で修正内容が無い → 人待ち（前回の失敗指紋を示す）
 * - 合格しなかった回 → 状態を保存し、失敗指紋・下限割れ・目標未達を issues に並べて人待ち
 *
 * binding は合格の check に載せる SHA（signoffSha256・videoSha256・contactSheetSha256 と、ジャンルが足すもの）。
 * evidence は回の証跡の行（path・sha256・note）。
 */
export async function advanceSignedReviewQualityLoop({
  spec,
  contract,
  jobId,
  runDir,
  signoff = null,
  signoffPath = "",
  signoffSha256 = "",
  documentValid = false,
  auditChecks = {},
  video = {},
  contactSheet = {},
  binding = null,
  extraEvidence = [],
  roundCost = 0,
  revisionDelta = "",
  predecessorStatePath = null,
  now = () => new Date().toISOString(),
} = {}) {
  assertSpec(spec);
  const paths = signedReviewQualityPaths(runDir);
  const existing = await readJsonIfPresent(paths.statePath);
  const existingSha256 = existing ? sha256(await readFile(paths.statePath)) : "";
  if (existing && existing.contractDigest !== contract.digest) {
    return waiting({
      state: existing,
      contract,
      stateSha256: existingSha256,
      issues: ["quality-loop-contract-changed"],
      detail: "この Job の品質ループは別の契約で始まっている。契約は走行中に変えない（続けるか新しい Job で始め直すかは人が決める）",
    });
  }
  if (!signoff || documentValid !== true) {
    return waiting({
      state: existing,
      contract,
      stateSha256: existingSha256,
      issues: existing ? issuesFromState(existing, contract) : [],
      detail: existing && lastRound(existing)
        ? `署名検証を通った新しいレビューを待っている。${nextStepDetail(existing, paths)}`
        : "署名検証を通った、評価項目の点数つきの独立レビューを待っている",
    });
  }
  const review = inspectSignedQualityReview(signoff, contract);
  if (!review.ok) {
    return waiting({
      state: existing,
      contract,
      stateSha256: existingSha256,
      issues: review.problems.map((problem) => `quality-loop-${problem}`),
      detail: `signoff に今の契約の採点が無い: ${review.problems.join(", ")}（評価項目: ${contract.rubric.map((criterion) => criterion.id).join(", ")}）`,
    });
  }
  const passBinding = binding || { signoffSha256, videoSha256: video.sha256, contactSheetSha256: contactSheet.sha256 };

  // 同じ signoff で既に記録した回なら、記録し直さずにその結果を返す（再開・二重起動）。
  const previousRound = lastRound(existing);
  if (existing && previousRound?.reviewDigest === signoffSha256) {
    const passed = existing.status === "passed";
    return {
      state: existing,
      recorded: false,
      issues: issuesFromState(existing, contract),
      check: qualityCheck({
        state: existing,
        contract,
        pass: passed,
        stateSha256: existingSha256,
        binding: passBinding,
        detail: passed
          ? `品質ループ ${existing.rounds.length} 回目で合格（${previousRound.score} ≥ ${contract.limits.targetScore}、下限割れなし）`
          : `品質ループ ${existing.rounds.length} 回目は不合格（${previousRound.score}/${contract.limits.targetScore}）。${nextStepDetail(existing, paths)}`,
      }),
    };
  }
  if (existing?.status === "passed") {
    return waiting({
      state: existing,
      contract,
      stateSha256: existingSha256,
      issues: ["quality-loop-passed-review-replaced"],
      detail: "合格した回の signoff が差し替えられた。合格の根拠が今の signoff ではないので、人が確かめる",
    });
  }
  if (existing && existing.status !== "active") {
    return waiting({
      state: existing,
      contract,
      stateSha256: existingSha256,
      issues: issuesFromState(existing, contract),
      detail: nextStepDetail(existing, paths),
    });
  }

  const delta = await readJsonIfPresent(paths.revisionDeltaPath).catch(() => null);
  let state = existing;
  if ((!state || state.rounds.length === 0) && nonEmpty(delta?.predecessorJobId)) {
    const imported = await readPredecessor({
      spec,
      predecessorJobId: nonEmpty(delta.predecessorJobId),
      jobId,
      predecessorStatePath,
      contract,
      previousFailureFingerprint: nonEmpty(delta.previousFailureFingerprint),
    });
    if (!imported.ok) {
      return waiting({ state: existing, contract, stateSha256: existingSha256, issues: [imported.issue], detail: imported.detail });
    }
    state = imported.state;
  }
  if (contextsUsed(state).has(review.evaluatorContextId)) {
    return waiting({
      state,
      contract,
      stateSha256: existingSha256,
      issues: ["quality-loop-fresh-review-required", ...issuesFromState(state, contract).filter((issue) => !issue.startsWith("quality-loop-revision-and"))],
      detail: "この signoff の評価文脈は前の回で使われている。直した版を、新しい文脈のレビューで signoff し直すこと",
    });
  }
  let revision = null;
  if (state && state.rounds.length > 0) {
    const expected = lastRound(state).failureFingerprint;
    let text = sanitizeEvidence(revisionDelta);
    if (!text && nonEmpty(delta?.previousFailureFingerprint) === expected) text = sanitizeEvidence(delta?.revisionDelta);
    if (text.length < 4) {
      return waiting({
        state,
        contract,
        stateSha256: existingSha256,
        issues: [`quality-loop-revision-delta-required:${expected}`],
        detail: `品質ループの ${state.rounds.length + 1} 回目には、前回の失敗（${expected}）をどう直したかが要る。${paths.revisionDeltaPath} に `
          + `{ "previousFailureFingerprint": "${expected}", "revisionDelta": "直した内容" } を書いてから再開すること`,
      });
    }
    revision = { previousFailureFingerprint: expected, revisionDelta: text };
  }
  const observedAt = now();
  if (!state) {
    state = createQualityLoopState({
      contract,
      episodeId: jobId,
      generatorHost: "buzzassist",
      generatorId: spec.generatorId,
      generatorContextId: `production:${jobId}`,
      startedAt: observedAt,
    });
  }
  // 品質ループの結果から決まる監査（ループそのものと、この回の採点から決まる監査）は機械ゲートに数えない。
  const loopAuditIds = new Set(spec.loopAuditIds || []);
  const failedGateIds = Object.entries(auditChecks)
    .filter(([id, value]) => !loopAuditIds.has(id) && value?.pass !== true)
    .map(([id]) => id)
    .sort();
  const costedJobIds = Array.isArray(state.costedJobIds) ? state.costedJobIds.map(String) : [];
  const cost = costedJobIds.includes(jobId) ? 0 : Math.max(0, Number(roundCost) || 0);
  const priorRound = lastRound(state);
  const outputUnchanged = Boolean(priorRound) && (priorRound.evidence || [])
    .some((row) => row.sha256 === video.sha256);
  const evidence = [
    { path: signoffPath, sha256: signoffSha256, note: "信頼リストの鍵で署名された独立レビュー（評価項目の点数つき）" },
    {
      path: video.path,
      sha256: video.sha256,
      note: outputUnchanged ? "この回に評価した MP4（前の回と同じバイト列で、出力は変わっていない）" : "この回に評価した MP4",
    },
    { path: contactSheet.path, sha256: contactSheet.sha256, note: "この回に評価した contact sheet" },
    ...(Array.isArray(extraEvidence) ? extraEvidence : []),
  ].filter((row) => nonEmpty(row?.path) && validSha256(row?.sha256));
  let recorded;
  try {
    recorded = recordQualityRound({
      contract,
      state,
      hardGateReport: { pass: failedGateIds.length === 0, failedGateIds, contractDigest: contract.digest },
      reviews: [{
        evaluatorId: nonEmpty(typeof signoff.reviewer === "string" ? signoff.reviewer : signoff.reviewer?.id),
        evaluatorContextId: review.evaluatorContextId,
        evaluatorHost: nonEmpty(signoff.reviewerHost),
        scores: review.scores,
        notes: review.notes,
        evidence: evidence.slice(0, 1),
      }],
      evidence,
      reviewDigest: signoffSha256,
      cost,
      observedAt,
      ...(revision || {}),
    });
  } catch (error) {
    // 回として受け取れない入力（作る係と同じ名乗り等）は、例外で Job を落とさず人待ちにする。
    return waiting({
      state: existing,
      contract,
      stateSha256: existingSha256,
      issues: ["quality-loop-round-rejected"],
      detail: `この signoff は品質ループの回として記録できない: ${sanitizeEvidence(error?.message || String(error), 300)}`,
    });
  }
  const next = {
    ...recorded,
    costedJobIds: costedJobIds.includes(jobId) ? costedJobIds : [...costedJobIds, jobId],
  };
  await writeJsonAtomic(paths.statePath, next);
  const stateSha256 = sha256(await readFile(paths.statePath));
  const round = lastRound(next);
  const passed = next.status === "passed";
  return {
    state: next,
    recorded: true,
    issues: issuesFromState(next, contract),
    check: qualityCheck({
      state: next,
      contract,
      pass: passed,
      stateSha256,
      binding: passBinding,
      detail: passed
        ? `品質ループ ${next.rounds.length} 回目で合格（${round.score} ≥ ${contract.limits.targetScore}、下限割れなし、機械ゲート全通過）`
        : `品質ループ ${next.rounds.length} 回目は不合格（${round.score}/${contract.limits.targetScore}`
          + `${round.floorFailures.length ? `、下限割れ: ${round.floorFailures.join(", ")}` : ""}`
          + `${round.failedGateIds.length ? `、落ちた機械ゲート: ${round.failedGateIds.join(", ")}` : ""}）。${nextStepDetail(next, paths)}`,
    }),
  };
}
