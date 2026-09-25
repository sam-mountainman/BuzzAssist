/**
 * ナレーション物語の品質ループ（ジャンル層）。
 *
 * 中核（採点・下限・失敗指紋・止まる条件・作る係と評価する係の分離）は
 * lib/qualityLoop.mjs の共通部品で、ここが決めるのは次の3つだけ:
 *   - 評価項目（台本と画の意味の一致、人物の同一性、語りの声 …）と重み・下限
 *   - 上限（目標点・回数・時間・費用・停滞）の Core 既定と、Channel Pack からの上書き
 *   - 署名済み signoff を1回分の「回」にする配線（修正内容・評価文脈・前の Job からの引き継ぎ）
 *
 * ナレーション物語の Job は台本・Channel Pack・コードの指紋で同一性が決まるので、
 * 出力を直すと別の Job になる。だから「直して測り直す」2回目以降は、新しい Job の
 * 作業領域の revision-delta.json に前の Job（predecessorJobId）と前回の失敗指紋を書いて
 * ループを引き継ぐ。同じ Job の中の2回目（同じ MP4 の見直し）も記録できるが、
 * 出力が変わっていないことを証跡に残す。
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { renameWithRetry } from "./atomicJsonFile.mjs";
import {
  createQualityLoopState,
  normalizeQualityRubric,
  recordQualityRound,
  sanitizeEvidence,
  validSha256,
} from "./qualityLoop.mjs";

export const NARRATED_QUALITY_CONTRACT_VERSION = "buzzassist-narrated-story-quality-contract-v1";
/** 最終監査の auditChecks に載る id（宣言の quality-loop 保証の証拠）。 */
export const NARRATED_QUALITY_AUDIT_ID = "qualityLoopPassed";
export const NARRATED_QUALITY_DIR = "quality";
export const NARRATED_QUALITY_STATE_FILE = "quality-loop-state.json";
export const NARRATED_REVISION_DELTA_FILE = "revision-delta.json";
/** 作る係の id。評価者がこれを名乗っても採点できない。 */
export const NARRATED_GENERATOR_ID = "narrated-story-production";
const NARRATED_JOB_ID = /^video-narrated-story-video-[a-f0-9]{16}$/u;

// 評価項目。重みと下限（minimumScore）は実測から決めた閾値ではなく方針値。
// 視聴者が「話が違う」「別人」「声が違う」と気づく項目（台本と画の意味・人物の同一性・
// 語りの声）は下限 80、ほかは致命傷の足切りとして 60（漫画の品質ハーネスと同じ考え方）。
// 語りが主役のジャンルなので、声の重みは漫画（15）より高い 20 にした。
const NARRATED_RUBRIC = Object.freeze([
  {
    id: "script-image-fit",
    label: "台本と画の意味の一致",
    weight: 20,
    minimumScore: 80,
    description: "語っている場面・人物・物・時代が画に出ている。語りと食い違う画（話が違う）が無い",
  },
  {
    id: "character-identity",
    label: "画の一貫性と人物の同一性",
    weight: 15,
    minimumScore: 80,
    description: "同じ人物が場面をまたいで同じ顔・年齢・体型・服で出る（別人に見えない）。画風が途中で変わらない",
  },
  {
    id: "narration-voice",
    label: "語りの声と演技",
    weight: 20,
    minimumScore: 80,
    description: "承認済みの声のまま最後まで語る（声が違う箇所が無い）。読み間違い・不自然な間・感情の外れが無い",
  },
  {
    id: "subtitle-readability",
    label: "字幕の読みやすさ",
    weight: 10,
    minimumScore: 60,
    description: "誤字・表記揺れ・不自然な改行が無く、表示時間内に読み切れる。語りと字幕がずれない",
  },
  {
    id: "bgm-narration-balance",
    label: "BGMと語りの釣り合い",
    weight: 10,
    minimumScore: 60,
    description: "BGM が語りを邪魔せず、場面の空気に合う。急な音量の段差や途切れが無い",
  },
  {
    id: "full-length-viewing",
    label: "全尺視聴での完成度",
    weight: 15,
    minimumScore: 60,
    description: "最初から最後まで通して見て、公開してよい完成品として成立している",
  },
]);

// OP・感想パートを使う Pack だけの評価項目。使わない Pack では採点させない（該当しない項目に
// 満点を付けさせると、平均が実際より高く見える）。
const NARRATED_BOOKEND_CRITERION = Object.freeze({
  id: "bookend-boundaries",
  label: "OP・感想の境目",
  weight: 10,
  minimumScore: 60,
  description: "OP→本編、本編→感想の切り替えで語りが切れず、転換と間が自然。感想パートが本編と混ざらない",
});

// 上限の Core 既定（方針値）。漫画の既定（目標 92・2回・6時間）との違いの理由:
// - 回数 3: ナレーション物語は直すたびに新しい Job の有料再生成になるので、1回目の指摘
//   （声・画風など Pack 単位の問題が多い）を直して確かめる回を1つ多く取る
// - 時間 72 時間: 回と回のあいだに運営者の判断と再生成が入る。漫画の 6 時間は同じ話数の
//   中でレビューを回す前提の値で、ここでは足りない
// 目標点・費用・改善幅・停滞回数は漫画と同じ値。
export const NARRATED_QUALITY_LIMIT_DEFAULTS = Object.freeze({
  targetScore: 92,
  maximumReviewRounds: 3,
  maximumElapsedMs: 72 * 60 * 60 * 1_000,
  maximumCost: 100,
  minimumImprovement: 1,
  maximumStagnantRounds: 1,
});

// Channel Pack（narrated-story.json の qualityLoop）で上書きできる上限と、その範囲。
// 評価項目と下限は Pack から変えさせない（「別人」「声が違う」の足切りを番組ごとに
// 緩められると、この保証の意味が無くなる）。目標点も 80 未満には下げさせない。
const LIMIT_FIELDS = Object.freeze({
  targetScore: { key: "targetScore", minimum: 80, maximum: 100, integer: false },
  maximumReviewRounds: { key: "maximumReviewRounds", minimum: 1, maximum: 8, integer: true },
  maximumElapsedMinutes: { key: "maximumElapsedMs", minimum: 1, maximum: 7 * 24 * 60, integer: false, scale: 60_000 },
  maximumCostUnits: { key: "maximumCost", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, integer: false },
  minimumImprovementPoints: { key: "minimumImprovement", minimum: 0, maximum: 100, integer: false },
  maximumStagnantRounds: { key: "maximumStagnantRounds", minimum: 1, maximum: 5, integer: true },
});

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value)) deepFreeze(entry);
  return value;
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
 * narrated-story.json の `qualityLoop`（任意）を読む。数でない値・範囲外・評価項目の
 * 上書きは blocker にする（有料生成の前に止める。黙って既定へ戻すと、Pack の作者は
 * 効いているつもりになる）。
 */
export function normalizeNarratedQualityLoopConfig(source) {
  if (source === undefined || source === null) return { limits: {}, blockers: [] };
  if (typeof source !== "object" || Array.isArray(source)) return { limits: {}, blockers: ["qualityLoop"] };
  const limits = {};
  const blockers = [];
  for (const [field, value] of Object.entries(source)) {
    const spec = LIMIT_FIELDS[field];
    if (!spec) {
      blockers.push(["rubric", "minimumScore", "criteria"].includes(field)
        ? `qualityLoop.${field}-not-overridable`
        : `qualityLoop.${field}-unknown`);
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)
      || value < spec.minimum || value > spec.maximum
      || (spec.integer && !Number.isInteger(value))) {
      blockers.push(`qualityLoop.${field}`);
      continue;
    }
    limits[spec.key] = spec.scale ? Math.round(value * spec.scale) : value;
  }
  return { limits, blockers };
}

/**
 * ナレーション物語の品質契約。走行中は変えない（digest が変われば同じループを続けない）。
 * `bookendsEnabled` は Pack の bookends.enabled。`limits` は normalizeNarratedQualityLoopConfig の結果。
 */
export function createNarratedQualityContract({ bookendsEnabled = false, limits = {} } = {}) {
  const rows = [
    ...NARRATED_RUBRIC.slice(0, 5),
    ...(bookendsEnabled ? [NARRATED_BOOKEND_CRITERION] : []),
    ...NARRATED_RUBRIC.slice(5),
  ];
  const body = {
    version: NARRATED_QUALITY_CONTRACT_VERSION,
    harnessId: "narrated-story-video",
    universalRules: {
      generatorEvaluatorSeparation: true,
      distinctEvaluatorContextRequired: true,
      deterministicGatesBeforeJudgment: true,
      signedIndependentReviewRequired: true,
      completeRubricRequired: true,
      rubricFloorsRequired: true,
      failureFingerprintRequired: true,
      revisionDeltaRequired: true,
      fullLengthViewingRequired: true,
      immutableDuringRun: true,
    },
    rubric: normalizeQualityRubric(rows.map((row) => ({ ...row }))),
    limits: { ...NARRATED_QUALITY_LIMIT_DEFAULTS, ...limits },
  };
  return deepFreeze({ ...body, digest: sha256(canonicalJson(body)) });
}

/** reviewer が採点に使う契約の写し（pipeline state の review.quality に置く）。 */
/**
 * 評価者に渡す評価シート（pipeline state の review.quality）。何を採点するか（評価項目の id・名前・
 * 説明）と点数の尺度、採点を結び付ける契約の digest だけを載せる。
 *
 * 合格点（targetScore）・項目ごとの下限・重み・前の回の点数（とそれが書かれた品質ループの状態の
 * 置き場）は載せない。評価者に合格点や前回の点を見せると、採点がそれに寄る（合格点のすぐ上に
 * 集まる、前回から少しだけ上げる）。合否の判定はループ側（lib/qualityLoop.mjs と品質契約）だけが持つ。
 * 修正内容の置き場（revision-delta.json）は作る側が書くもので、評価者には要らないので載せない。
 */
export function narratedQualityReviewSheet(contract, _runDir = "") {
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
export const NARRATED_REVIEW_SHEET_FORBIDDEN_KEYS = Object.freeze([
  "targetScore", "minimumScore", "weight", "score", "scores", "rubricScores", "rounds", "floorFailures",
  "failureFingerprint", "statePath", "revisionDeltaPath", "limits",
]);

export function narratedQualityPaths(runDir) {
  const dir = join(runDir, NARRATED_QUALITY_DIR);
  return {
    dir,
    statePath: join(dir, NARRATED_QUALITY_STATE_FILE),
    revisionDeltaPath: join(dir, NARRATED_REVISION_DELTA_FILE),
  };
}

/**
 * reviewer の採点ファイル（signoff --review-path）を検査して signoff 本文へ載せる形にする。
 * 形: { rubricScores: { <id>: 0〜100 }, notes: "所見", findings: ["直すべき点", ...] }
 * `sheet` は pipeline state の review.quality（契約の写し）。
 */
export function normalizeNarratedReviewInput(review, sheet, { approved } = {}) {
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
export function inspectNarratedQualityReview(signoff, contract) {
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
    + `${NARRATED_QUALITY_DIR}/${NARRATED_REVISION_DELTA_FILE} に "predecessorJobId" としてこの Job の id も書く`;
}

/** auditChecks.qualityLoopPassed を組む。合格のときだけ signoff / MP4 / contact sheet の SHA を載せる。 */
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
    ...(pass === true ? {
      signoffSha256: binding.signoffSha256,
      videoSha256: binding.videoSha256,
      contactSheetSha256: binding.contactSheetSha256,
    } : {}),
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

async function readPredecessor({ predecessorJobId, jobId, predecessorStatePath, contract, previousFailureFingerprint }) {
  if (!NARRATED_JOB_ID.test(predecessorJobId) || predecessorJobId === jobId) {
    return { ok: false, issue: "quality-loop-predecessor-invalid", detail: "predecessorJobId は別の narrated-story-video Job の id であること" };
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

/**
 * 署名検証を通った signoff を品質ループの1回として記録し、auditChecks.qualityLoopPassed と
 * 人待ちの理由を返す。例外は投げない（人の判断が要る状態は issues で返す）。
 *
 * - signoff が無い／署名や SHA の検査に落ちた → 回を記録しない（証拠にならない）
 * - 同じ signoff で既に記録済み → その回の結果をそのまま返す（再開しても二重に記録しない）
 * - 前の回で使われた評価文脈 → 人待ち（新しい文脈のレビューが要る）
 * - 2回目以降で修正内容が無い → 人待ち（前回の失敗指紋を示す）
 * - 合格しなかった回 → 状態を保存し、失敗指紋・下限割れ・目標未達を issues に並べて人待ち
 */
export async function advanceNarratedQualityLoop({
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
  roundCost = 0,
  revisionDelta = "",
  predecessorStatePath = null,
  now = () => new Date().toISOString(),
} = {}) {
  const paths = narratedQualityPaths(runDir);
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
  const review = inspectNarratedQualityReview(signoff, contract);
  if (!review.ok) {
    return waiting({
      state: existing,
      contract,
      stateSha256: existingSha256,
      issues: review.problems.map((problem) => `quality-loop-${problem}`),
      detail: `signoff に今の契約の採点が無い: ${review.problems.join(", ")}（評価項目: ${contract.rubric.map((criterion) => criterion.id).join(", ")}）`,
    });
  }
  const binding = { signoffSha256, videoSha256: video.sha256, contactSheetSha256: contactSheet.sha256 };

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
        binding,
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
      generatorId: NARRATED_GENERATOR_ID,
      generatorContextId: `production:${jobId}`,
      startedAt: observedAt,
    });
  }
  // 人物の同一性の監査はこの回の採点から決まる（ループの結果に依存する）ので、機械ゲートに数えない。
  const failedGateIds = Object.entries(auditChecks)
    .filter(([id, value]) => id !== NARRATED_QUALITY_AUDIT_ID && id !== NARRATED_CHARACTER_IDENTITY_AUDIT_ID && value?.pass !== true)
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
  ].filter((row) => nonEmpty(row.path) && validSha256(row.sha256));
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
      binding,
      detail: passed
        ? `品質ループ ${next.rounds.length} 回目で合格（${round.score} ≥ ${contract.limits.targetScore}、下限割れなし、機械ゲート全通過）`
        : `品質ループ ${next.rounds.length} 回目は不合格（${round.score}/${contract.limits.targetScore}`
          + `${round.floorFailures.length ? `、下限割れ: ${round.floorFailures.join(", ")}` : ""}`
          + `${round.failedGateIds.length ? `、落ちた機械ゲート: ${round.failedGateIds.join(", ")}` : ""}）。${nextStepDetail(next, paths)}`,
    }),
  };
}

/** 人物の同一性の監査の id（宣言の character-identity 保証の証拠）。 */
export const NARRATED_CHARACTER_IDENTITY_AUDIT_ID = "characterIdentityReviewed";
/** 人物の同一性を採点する評価項目。下限は契約（NARRATED_RUBRIC）のまま、Pack から変えさせない。 */
export const NARRATED_CHARACTER_IDENTITY_CRITERION = "character-identity";

/**
 * 人物の同一性は機械の顔照合では決めない。生成とは別の文脈の reviewer が完成 MP4 と contact sheet を
 * 原寸で見て、評価項目 character-identity を採点する（人の判断）。ここはその採点が
 *   - 今の品質契約（contractDigest）に対するもので
 *   - 信頼リストの鍵で署名され、承認された（validation.ok の）signoff にあり
 *   - その signoff で品質ループが合格し（qualityLoopPassed と同じ回・同じ MP4）
 *   - 下限（minimumScore）以上である
 * ことを確かめる。合格のときだけ signoff / MP4 / contact sheet の SHA を載せる（Receipt が照合する）。
 */
export function narratedCharacterIdentityCheck({
  contract,
  qualityCheck = null,
  signoff = null,
  signoffSha256 = "",
  video = {},
  contactSheet = {},
} = {}) {
  const criterion = (contract?.rubric || []).find((entry) => entry.id === NARRATED_CHARACTER_IDENTITY_CRITERION) || null;
  const rawScore = signoff?.qualityReview?.rubricScores?.[NARRATED_CHARACTER_IDENTITY_CRITERION];
  const score = typeof rawScore === "number" && Number.isFinite(rawScore) ? rawScore : null;
  const reviewerContextId = nonEmpty(signoff?.reviewerContextId);
  const problems = [];
  if (!criterion) problems.push("criterion-missing-from-contract");
  if (!signoff) problems.push("approved-signed-review-missing");
  else if (signoff.qualityReview?.contractDigest !== contract?.digest) problems.push("review-contract-mismatch");
  if (signoff && score === null) problems.push("score-missing");
  if (criterion && score !== null && score < criterion.minimumScore) problems.push(`below-floor:${score}<${criterion.minimumScore}`);
  if (qualityCheck?.pass !== true) problems.push("quality-loop-not-passed");
  if (qualityCheck?.pass === true && qualityCheck.signoffSha256 !== signoffSha256) problems.push("quality-loop-round-bound-to-another-review");
  const pass = problems.length === 0;
  return {
    pass,
    detail: pass
      ? `independent signed review scored ${NARRATED_CHARACTER_IDENTITY_CRITERION} ${score} >= floor ${criterion.minimumScore} in the passing quality-loop round (reviewer context ${reviewerContextId})`
      : `character identity is not confirmed by an approved signed independent review: ${problems.join(", ")}`,
    criterionId: NARRATED_CHARACTER_IDENTITY_CRITERION,
    minimumScore: criterion?.minimumScore ?? null,
    score,
    reviewerContextId,
    contractDigest: contract?.digest || "",
    ...(pass ? {
      signoffSha256,
      videoSha256: video?.sha256 || "",
      contactSheetSha256: contactSheet?.sha256 || "",
    } : {}),
  };
}
