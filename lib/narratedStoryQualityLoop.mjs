/**
 * ナレーション物語の品質ループ（ジャンル層）。
 *
 * 中核（採点・下限・失敗指紋・止まる条件・作る係と評価する係の分離）は
 * lib/qualityLoop.mjs の共通部品で、ここが決めるのは次の3つだけ:
 *   - 評価項目（台本と画の意味の一致、人物の同一性、語りの声 …）と重み・下限
 *   - 上限（目標点・回数・時間・費用・停滞）の Core 既定と、Channel Pack からの上書き
 *   - 署名済み signoff を1回分の「回」にするときの決まり（ハーネス id・Job id の形・作る係の id）
 *
 * 署名済み signoff を回にする配線（修正内容・評価文脈・前の Job からの引き継ぎ）そのものは、解説動画と共通の
 * lib/signedReviewQualityLoop.mjs にある。
 *
 * ナレーション物語の Job は台本・Channel Pack・コードの指紋で同一性が決まるので、
 * 出力を直すと別の Job になる。だから「直して測り直す」2回目以降は、新しい Job の
 * 作業領域の revision-delta.json に前の Job（predecessorJobId）と前回の失敗指紋を書いて
 * ループを引き継ぐ。同じ Job の中の2回目（同じ MP4 の見直し）も記録できるが、
 * 出力が変わっていないことを証跡に残す。
 */

import { createHash } from "node:crypto";

import { normalizeQualityRubric } from "./qualityLoop.mjs";
import {
  REVIEW_SHEET_FORBIDDEN_KEYS,
  SIGNED_REVIEW_QUALITY_DIR,
  SIGNED_REVIEW_QUALITY_STATE_FILE,
  SIGNED_REVIEW_REVISION_DELTA_FILE,
  advanceSignedReviewQualityLoop,
  inspectSignedQualityReview,
  normalizeSignedReviewInput,
  signedReviewQualityPaths,
  signedReviewSheet,
} from "./signedReviewQualityLoop.mjs";

export const NARRATED_QUALITY_CONTRACT_VERSION = "buzzassist-narrated-story-quality-contract-v1";
/** 最終監査の auditChecks に載る id（宣言の quality-loop 保証の証拠）。 */
export const NARRATED_QUALITY_AUDIT_ID = "qualityLoopPassed";
export const NARRATED_QUALITY_DIR = SIGNED_REVIEW_QUALITY_DIR;
export const NARRATED_QUALITY_STATE_FILE = SIGNED_REVIEW_QUALITY_STATE_FILE;
export const NARRATED_REVISION_DELTA_FILE = SIGNED_REVIEW_REVISION_DELTA_FILE;
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

/**
 * 評価者に渡す評価シート（pipeline state の review.quality）。形と「合格点・下限・重み・前の回の点数を載せない」
 * 決まりは共通の lib/signedReviewQualityLoop.mjs の signedReviewSheet にある（解説動画も同じものを使う）。
 * 修正内容の置き場（revision-delta.json）は作る側が書くもので、評価者には要らないので載せない。
 */
export function narratedQualityReviewSheet(contract, _runDir = "") {
  return signedReviewSheet(contract);
}

/** 評価シートに載せてはいけない項目（合否の判定の材料と、前の回の点数への手がかり）。試験が見る。 */
export const NARRATED_REVIEW_SHEET_FORBIDDEN_KEYS = REVIEW_SHEET_FORBIDDEN_KEYS;

export function narratedQualityPaths(runDir) {
  return signedReviewQualityPaths(runDir);
}

/**
 * reviewer の採点ファイル（signoff --review-path）を検査して signoff 本文へ載せる形にする。
 * 形: { rubricScores: { <id>: 0〜100 }, notes: "所見", findings: ["直すべき点", ...] }
 * `sheet` は pipeline state の review.quality（契約の写し）。本体は共通の normalizeSignedReviewInput。
 */
export const normalizeNarratedReviewInput = normalizeSignedReviewInput;

/** finalize 側で、signoff 本文の qualityReview が今の契約と評価文脈に合っているかを見る（共通の実装）。 */
export const inspectNarratedQualityReview = inspectSignedQualityReview;

/** ナレーション物語の Job を、署名済みレビューの品質ループ（共通の配線）へ渡すときの決まり。 */
function narratedSignedReviewSpec() {
  return {
    harnessId: "narrated-story-video",
    jobIdPattern: NARRATED_JOB_ID,
    generatorId: NARRATED_GENERATOR_ID,
    // 人物の同一性の監査はこの回の採点から決まる（ループの結果に依存する）ので、機械ゲートに数えない。
    loopAuditIds: [NARRATED_QUALITY_AUDIT_ID, NARRATED_CHARACTER_IDENTITY_AUDIT_ID],
  };
}

/**
 * 署名検証を通った signoff を品質ループの1回として記録し、auditChecks.qualityLoopPassed と
 * 人待ちの理由を返す。例外は投げない（人の判断が要る状態は issues で返す）。本体は共通の
 * lib/signedReviewQualityLoop.mjs の advanceSignedReviewQualityLoop（解説動画も同じものを使う）。
 *
 * - signoff が無い／署名や SHA の検査に落ちた → 回を記録しない（証拠にならない）
 * - 同じ signoff で既に記録済み → その回の結果をそのまま返す（再開しても二重に記録しない）
 * - 前の回で使われた評価文脈 → 人待ち（新しい文脈のレビューが要る）
 * - 2回目以降で修正内容が無い → 人待ち（前回の失敗指紋を示す）
 * - 合格しなかった回 → 状態を保存し、失敗指紋・下限割れ・目標未達を issues に並べて人待ち
 */
export async function advanceNarratedQualityLoop(input = {}) {
  return advanceSignedReviewQualityLoop({ ...input, spec: narratedSignedReviewSpec() });
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
