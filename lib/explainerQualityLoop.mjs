/**
 * 解説動画（explainer-video）の完成動画の品質ループ（ジャンル層）。
 *
 * 人が完成 MP4 を全編通して見て（聞いて）、初見の視聴者として評価したものを、信頼リストの鍵で署名した signoff
 * にし、品質ループの1回として記録する。中核は lib/qualityLoop.mjs、署名済み signoff を回にする配線は
 * lib/signedReviewQualityLoop.mjs（ナレーション物語と共通）。ここが決めるのは次の3つだけ:
 *   - 評価項目（共通の解説動画の評価項目を、完成した動画を見て採点する形にしたもの）と重み・下限
 *   - 上限（目標点・回数・時間・費用・停滞）
 *   - 署名済み signoff を1回分の「回」にするときの決まり（ハーネス id・Job id の形・作る係の id）
 *
 * 評価項目は、台本の品質ループの解説動画のジャンル（lib/scriptQualityLoop.mjs の SCRIPT_QUALITY_GENRES.explainer）
 * と同じ id・名前・重み・下限を使う（評価の語彙を1つにする）。説明の文だけを「完成した動画を初見で通して見て
 * どうか」に書き直す（台本の項目の説明は台本の書き方の指示で、見る人には判断できない）。
 *   - 根拠が支える範囲（evidence-scope）は入れない。初見の視聴者は出所を確かめられないので、台本の品質ループで見る
 *   - 聞きやすさ（listenability）だけは完成した音でしか分からないので、動画だけの項目として足す
 * チャンネルごとの評価者の数・回数・点は作らない（合否は下の契約だけが決める。評価者にはシートだけを渡す）。
 */

import { createHash } from "node:crypto";
import path from "node:path";

import { normalizeQualityRubric } from "./qualityLoop.mjs";
import { SCRIPT_QUALITY_GENRES } from "./scriptQualityLoop.mjs";
import {
  REVIEW_SHEET_FORBIDDEN_KEYS,
  advanceSignedReviewQualityLoop,
  signedReviewQualityPaths,
  signedReviewSheet,
} from "./signedReviewQualityLoop.mjs";

export const EXPLAINER_VIDEO_QUALITY_CONTRACT_VERSION = "buzzassist-explainer-video-quality-contract-v1";
/** 監査の id（宣言の quality-loop 保証の証拠）。ナレーション物語と同じ名前。 */
export const EXPLAINER_QUALITY_AUDIT_ID = "qualityLoopPassed";
/** 人の評価の署名の監査の id（宣言の human-review-signed 保証の証拠）。 */
export const EXPLAINER_HUMAN_REVIEW_AUDIT_ID = "humanReviewSigned";
/** 作る係の id。評価者がこれを名乗っても採点できない。 */
export const EXPLAINER_GENERATOR_ID = "explainer-video-production";
export const EXPLAINER_JOB_ID = /^video-explainer-video-[a-f0-9]{16}$/u;

// 完成した動画を見て採点するときの説明（共通の項目の id ごと）。id・名前・重み・下限は共通の項目から取る。
const VIEWING_DESCRIPTIONS = Object.freeze({
  "question-clarity": "見始めてすぐに、この動画が答える問いが1つに分かり、見終えたときに何が分かるかが伝わる。途中で問いがすり替わらない",
  "first-view-comprehension": "前提の知識が無い人が1回通して見て、説明を追える。用語は初めて出たところで説明され、置いていかれる箇所・指示語の指す先が分からない箇所が無い",
  "discovery-progression": "各段が前の段で分かったことを使って新しい発見を1つ足している。同じ説明の繰り返しや、前提を飛ばした段の飛躍が無い",
  "opening-promise-payoff": "冒頭で約束した答え・見せ場が本編で回収されている。回収されない約束や、本編に無い内容を匂わせる冒頭が無い",
  "visual-narration-alignment": "画面の図・表・文字が、そのとき読み上げている説明と同じことを指している。画面の数字・用語と読み上げが食い違わず、説明より先に図が答えを見せる・説明に無いことを図だけで言う箇所が無い",
  pacing: "1つの段の情報が1回聞いて追える量で、段や章が切り替わるところに間がある。同じ説明の言い直しで間延びする箇所や、図と説明が追いつかないほど詰め込んだ箇所が無い",
  "reading-clarity": "専門用語・人名・数字の読み上げが正しく一意で、聞き取りで別の語と取り違えない",
});

// 完成した音でしか分からない項目。重みと下限は方針値（読みの下限と同じ 70。声が聞き取れない箇所は理解の前に
// 落ちるので、足切りとして置く）。
const LISTENABILITY = Object.freeze({
  id: "listenability",
  label: "聞きやすさ",
  weight: 15,
  minimumScore: 70,
  description: "声の大きさ・速さ・間・発音が最後まで聞き取りやすい。音の途切れ・割れ・急な音量の段差・聞き取れない箇所が無い",
});

// 上限（方針値）。ナレーション物語の完成動画の品質ループ（目標 92・3回・72時間）との違い:
// - 目標 90: 解説動画の台本の品質ループと同じ値。完成版は BuzzAssist の外で作られ、ここで作り直さない
// - 時間 7 日: 回と回のあいだに、チャンネルの制作での作り直しと人の全編の試聴が入る
// 回数・費用・改善幅・停滞回数はナレーション物語と同じ値（取り込みは有料の呼び出しをしないので費用は数えない）。
export const EXPLAINER_QUALITY_LIMIT_DEFAULTS = Object.freeze({
  targetScore: 90,
  maximumReviewRounds: 3,
  maximumElapsedMs: 7 * 24 * 60 * 60 * 1_000,
  maximumCost: 100,
  minimumImprovement: 1,
  maximumStagnantRounds: 1,
});

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value)) deepFreeze(entry);
  return value;
}

/** 完成動画の評価項目（共通の項目から作る）。共通の項目に無い id を説明に書いていたら、ここで止める。 */
function explainerVideoRubricRows() {
  const common = new Map(SCRIPT_QUALITY_GENRES.explainer.rubric.map((row) => [row.id, row]));
  const rows = Object.entries(VIEWING_DESCRIPTIONS).map(([id, description]) => {
    const row = common.get(id);
    if (!row) throw new Error(`explainer-video-quality-contract-invalid: 共通の解説動画の評価項目に ${id} が無い`);
    return { id, label: row.label, weight: row.weight, minimumScore: row.minimumScore, description };
  });
  return [...rows, { ...LISTENABILITY }];
}

/**
 * 解説動画の完成動画の品質契約。走行中は変えない（digest が変われば同じループを続けない）。
 * チャンネルから評価項目・下限・上限を変えさせない（初見の視聴者の足切りを番組ごとに緩めない）。
 */
export function createExplainerVideoQualityContract() {
  const body = {
    version: EXPLAINER_VIDEO_QUALITY_CONTRACT_VERSION,
    harnessId: "explainer-video",
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
    rubric: normalizeQualityRubric(explainerVideoRubricRows()),
    limits: { ...EXPLAINER_QUALITY_LIMIT_DEFAULTS },
  };
  return deepFreeze({ ...body, digest: createHash("sha256").update(canonicalJson(body)).digest("hex") });
}

/**
 * 評価者に渡す評価シート（何を採点するか・点数の尺度・契約の digest と、採点のしかた）。
 * 合格点・下限・重み・前の回の点数は載せない（lib/signedReviewQualityLoop.mjs の決まり）。
 */
export function explainerVideoReviewSheet(contract) {
  return {
    ...signedReviewSheet(contract),
    instructions: "完成 MP4 を最初から最後まで通して見て（聞いて）、前提の知識が無い初見の視聴者として、評価項目ごとに 0〜100 で採点する。"
      + " 機械では測れない所見（分かりにくかった所・聞き取りにくかった所・図と説明の食い違い・直すべき点）は notes と findings に書く。"
      + " 承認（--pass）なら findings は空、差し戻し（--fail）なら直すべき点を1つ以上書く。採点ファイルの形は隣の review-template.json。",
  };
}

/** 採点ファイルの雛形（signoff --review-path の形。点は空のまま渡す）。評価シートとは別のファイルに置く。 */
export function explainerVideoScoringTemplate(contract) {
  return {
    rubricScores: Object.fromEntries(contract.rubric.map((criterion) => [criterion.id, null])),
    notes: "",
    findings: [],
  };
}

/** 評価シートに載せてはいけない項目（試験が見る。共通の一覧）。 */
export const EXPLAINER_REVIEW_SHEET_FORBIDDEN_KEYS = REVIEW_SHEET_FORBIDDEN_KEYS;

export function explainerQualityPaths(workDir) {
  return signedReviewQualityPaths(workDir);
}

/**
 * 署名検証を通った人の評価の signoff を品質ループの1回として記録する（共通の配線）。
 * workDir は Job の作業領域の explainer/。前の Job の品質ループは同じ作業フォルダの harness-runs の下から読む。
 */
export async function advanceExplainerQualityLoop({ workDir, jobsDir = "", ...input } = {}) {
  return advanceSignedReviewQualityLoop({
    ...input,
    runDir: workDir,
    spec: {
      harnessId: "explainer-video",
      jobIdPattern: EXPLAINER_JOB_ID,
      generatorId: EXPLAINER_GENERATOR_ID,
      // 品質ループそのものの監査だけを機械ゲートから外す。評価者の承認（humanReviewSigned）は回の関門に数える:
      // 評価者が差し戻した（--fail）回を、点数だけで合格にしない。
      loopAuditIds: [EXPLAINER_QUALITY_AUDIT_ID],
    },
    predecessorStatePath: jobsDir
      ? (predecessorJobId) => explainerQualityPaths(path.join(jobsDir, predecessorJobId, "explainer")).statePath
      : null,
  });
}
