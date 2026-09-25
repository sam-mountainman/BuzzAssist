/**
 * 企画の品質ループ（戦略ブリーフの版ごとの採点）。
 *
 * 中核（採点・下限・失敗指紋・止まる条件・作る係と評価する係の分離）は lib/qualityLoop.mjs の共通部品で、
 * ここが決めるのは次の4つだけ:
 *   - 評価項目と下限（BuzzAssist が決めた一般的な基準。戦略の道具の教えではない）
 *   - 機械ゲート（ブリーフの形、欄どうしの対応、根拠のファイルの照合、4分析の run が現行か、前の版とのつながり）
 *   - 上限の既定
 *   - ブリーフの「版」を1回の採点へ結び付ける配線（ブリーフ SHA・版・前の版・評価文脈）
 *
 * 守ること:
 *   - 採点はブリーフのファイルの SHA と版に縛る。採点ファイルの briefSha256 が今のブリーフと違えば記録しない
 *   - ブリーフを作った文脈（ループを始めた文脈・ブリーフの provenance.contextId・追加の作り手）は採点できない。
 *     前の回で採点した文脈も使えない
 *   - 評価シートには合格点・下限・重み・前の回の点数を載せない
 *   - 2回目以降は「前の失敗をどう直したか」が要る。無ければ例外ではなく人待ちで止める
 *   - 状態はブリーフと同じ作業フォルダ（私有側）の quality/ に原子的に書く。ブリーフの本文は持たない
 *   - 合格しなかった回は、失敗指紋・評価項目 id・機械ゲート id だけを Channel Pack の非公開台帳へ積む
 *   - 前提（動画の問い・見る人・入口の約束）を前の版から変えたら、その前提で集めた根拠は古い（stale）。
 *     機械ゲート evidence-premise-current が落ち、verdict は「根拠の取り直しが要る」を理由コードつきで返す。
 *     日数では決めない（対象と条件の変更で決める）
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { readJsonIfExists, writeJsonAtomic } from "./atomicJsonFile.mjs";
import { withCanvasFileLock } from "./canvasFileLock.mjs";
import {
  createQualityLoopState,
  normalizeQualityRubric,
  recordQualityRound,
  sanitizeEvidence,
} from "./qualityLoop.mjs";
import {
  EVIDENCE_REFRESH_REQUIRED_CODE,
  canonicalJson,
  evidencePremiseStaleness,
  evidenceStateCounts,
  evidenceStateUpgrades,
  inspectStrategyEvidenceRows,
  normalizeEvidenceRelPath,
  premiseChangedFields,
  sha256Hex,
  strategyBriefPremiseDigests,
  validateStrategyBrief,
} from "./strategyBrief.mjs";

export const STRATEGY_BRIEF_VERDICT_VERSION = "buzzassist-strategy-brief-verdict-v1";

export const STRATEGY_BRIEF_QUALITY_CONTRACT_VERSION = "buzzassist-strategy-brief-quality-contract-v1";
export const STRATEGY_BRIEF_QUALITY_STATE_VERSION = "buzzassist-strategy-brief-quality-loop-v1";
export const STRATEGY_BRIEF_QUALITY_DIR = "quality";
export const STRATEGY_BRIEF_QUALITY_STATE_FILE = "strategy-brief-loop.json";
export const STRATEGY_BRIEF_REVISION_DELTA_FILE = "strategy-brief-revision-delta.json";
/** 作る係の役割 id。評価者がこれを名乗っても採点できない。 */
export const STRATEGY_BRIEF_GENERATOR_ID = "strategy-planner";

/** 機械ゲート。採点より前に、ブリーフとファイルだけから決まる。 */
export const STRATEGY_BRIEF_MACHINE_GATES = Object.freeze({
  "brief-schema-valid": "ブリーフが buzzassist-strategy-brief-v1 の形（欄・値の範囲）に合う",
  "brief-links-valid": "入口の約束に本文の回収があり、残す点・変える点・指標が知られた根拠と約束を指す",
  "evidence-files-match": "根拠のファイルが作業フォルダにあり、sha256 が一致する",
  "evidence-formats-readable": "指標・関連元・取得スナップショット・視聴者の4分析の run が読める形",
  "audience-runs-current": "視聴者の4分析の run の report-manifest.json が今の結果と一致する（stale でない）",
  "previous-version-linked": "2回目以降の版は changes.previous が直前の版（label と sha256）を指す",
  "evidence-premise-current": "前提（動画の問い・見る人・入口の約束）を変えた版に、前の前提で集めた根拠が残っていない",
});

// 評価項目。重みと下限は実測から決めた閾値ではなく方針値。根拠の状態の正直さは、制作側がそれを信じて
// 作るので下限を高くした（80）。ほかは致命傷の足切りとして 60〜70。重みは合計 100。
export const STRATEGY_BRIEF_RUBRIC = Object.freeze([
  {
    id: "single-question",
    label: "問いが1つに絞れているか",
    weight: 20,
    minimumScore: 70,
    description: "動画の問いが1つで、本文の全体がその問いに答える形になっている。問いが2つ以上に割れていない、答えの無い問いになっていない",
  },
  {
    id: "audience-specificity",
    label: "見る人と見る理由が具体的か",
    weight: 15,
    minimumScore: 60,
    description: "誰が（状況・前提の知識）、なぜこの動画を選んで最後まで見るのかが、ほかの動画と区別できる具体さで書かれている",
  },
  {
    id: "promise-payoff",
    label: "約束と回収が対応しているか",
    weight: 20,
    minimumScore: 70,
    description: "タイトル・サムネイル・冒頭で約束したことが、本文のどこで回収されるかまで対応しており、回収されない約束や約束に無い山場が無い",
  },
  {
    id: "evidence-honesty",
    label: "根拠の状態が正直か",
    weight: 20,
    minimumScore: 80,
    description: "verified と書いた根拠は書かれた確かめ方で本当に確かめられ、推測や未確認のものは provisional / unverified のまま。取得の時期と条件が書かれ、足りない数字を推測で埋めていない",
  },
  {
    id: "change-grounding",
    label: "前の回からの変更が根拠に結び付いているか",
    weight: 15,
    minimumScore: 60,
    description: "残す点・変える点のそれぞれが、指した根拠から読み取れることに基づいている。前の回が無ければ、新しく決めた点が根拠に結び付いているかで見る",
  },
  {
    id: "producibility",
    label: "制作条件で作れるか",
    weight: 10,
    minimumScore: 60,
    description: "書かれた制作条件（形式・尺・使う声や素材・ハーネス）の範囲で、約束と回収を実際に作れる",
  },
]);

// 上限の既定（方針値）。企画は有料の生成をしないので、費用の上限は使わない（記録の形のために置く）。
// 回数 5・停滞 2 は台本のループと同じ。時間 14 日は、公開後の数字を待って次の版を作ることがあるため。
export const STRATEGY_BRIEF_LIMIT_DEFAULTS = Object.freeze({
  targetScore: 85,
  maximumReviewRounds: 5,
  maximumElapsedMs: 14 * 24 * 60 * 60 * 1_000,
  maximumCost: 100,
  minimumImprovement: 1,
  maximumStagnantRounds: 2,
});

const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const CONTEXT_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value)) deepFreeze(entry);
  return value;
}

function lastOf(list) {
  return Array.isArray(list) && list.length > 0 ? list[list.length - 1] : null;
}

/** 企画の品質契約。走行中は変えない（digest が変われば同じループを続けない）。 */
export function createStrategyBriefQualityContract() {
  const rubric = normalizeQualityRubric(STRATEGY_BRIEF_RUBRIC);
  const body = {
    version: STRATEGY_BRIEF_QUALITY_CONTRACT_VERSION,
    universalRules: {
      generatorEvaluatorSeparation: true,
      producerContextsExcludedFromEvaluation: true,
      distinctEvaluatorContextRequired: true,
      reviewBoundToBriefSha256: true,
      deterministicGatesBeforeJudgment: true,
      completeRubricRequired: true,
      rubricFloorsRequired: true,
      failureFingerprintRequired: true,
      revisionDeltaRequired: true,
      reviewSheetOmitsTargetFloorsAndPreviousScores: true,
      noModelCalls: true,
      immutableDuringRun: true,
    },
    machineGates: Object.keys(STRATEGY_BRIEF_MACHINE_GATES),
    rubric,
    limits: { ...STRATEGY_BRIEF_LIMIT_DEFAULTS },
  };
  return deepFreeze({ ...body, digest: sha256Hex(canonicalJson(body)) });
}

export function strategyBriefQualityPaths(workDir) {
  if (!nonEmpty(workDir)) throw new Error("--work-dir にブリーフの作業フォルダが要ります。");
  const root = resolve(workDir);
  const dir = join(root, STRATEGY_BRIEF_QUALITY_DIR);
  return {
    workDir: root,
    dir,
    statePath: join(dir, STRATEGY_BRIEF_QUALITY_STATE_FILE),
    revisionDeltaPath: join(dir, STRATEGY_BRIEF_REVISION_DELTA_FILE),
  };
}

/** 作業フォルダの中のファイルだけを受け、フォルダからの相対パス（/ 区切り）を返す。 */
function insideWorkDir(workDir, file, label) {
  if (!nonEmpty(file)) throw new Error(`${label} が要ります。`);
  const full = resolve(workDir, file);
  const rel = relative(workDir, full);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${label} はブリーフの作業フォルダの中に置いてください（状態は作業フォルダからの相対パスで残します）。`);
  }
  return { full, rel: rel.split(sep).join("/") };
}

function evidenceRecord(row) {
  return {
    id: String(row?.id ?? ""),
    kind: String(row?.kind ?? ""),
    path: String(row?.path ?? ""),
    sha256: String(row?.sha256 ?? ""),
    state: String(row?.state ?? ""),
    premiseBound: row?.premiseBound !== false,
  };
}

/** 前の版の記録（状態に残した根拠の状態）と比べて、確かさが上がった根拠。 */
function upgradesSince(previousVersion, brief) {
  if (!previousVersion) return [];
  return evidenceStateUpgrades({ evidence: previousVersion.evidence || [] }, brief);
}

function evidenceKey(row) {
  const normalized = normalizeEvidenceRelPath(row?.path);
  return `${normalized.ok ? normalized.rel : String(row?.path ?? "")}\u0000${String(row?.sha256 ?? "")}`;
}

/**
 * 品質ループの記録から、根拠の行が最初に現れた版の前提を引く関数。前提に依らない行（premiseBound: false）
 * として最初に現れた行は、後の版でも結び付けない。
 */
export function boundPremiseFromVersions(versions = []) {
  const firstSeen = new Map();
  for (const version of Array.isArray(versions) ? versions : []) {
    for (const row of version?.evidence || []) {
      const key = evidenceKey(row);
      if (!firstSeen.has(key)) firstSeen.set(key, row.premiseBound === false ? null : version.premise || null);
    }
  }
  return (row) => firstSeen.get(evidenceKey(row)) || null;
}

/**
 * 評価者へ渡す評価シート。何を採点するか（評価項目の id・名前・説明）、点数の尺度、採点を結び付ける
 * 契約の digest とブリーフの SHA、機械で分かった照合の結果だけを載せる。合格点・下限・重み・前の回の点数は
 * 載せない（STRATEGY_BRIEF_REVIEW_SHEET_FORBIDDEN_KEYS）。
 */
export function strategyBriefReviewSheet(contract, { briefRel = "", briefSha256 = "", label = "", inspection = [], previousVersion = null, brief = null, staleness = null } = {}) {
  const premiseChanged = previousVersion && brief
    ? premiseChangedFields(previousVersion.premise, strategyBriefPremiseDigests(brief))
    : [];
  return {
    contractVersion: contract.version,
    contractDigest: contract.digest,
    scale: { minimum: 0, maximum: 100 },
    rubric: contract.rubric.map((row) => ({ id: row.id, label: row.label, description: row.description })),
    brief: { path: briefRel, sha256: briefSha256, label },
    previousVersionLabel: previousVersion?.label || null,
    premiseChangedFromPrevious: premiseChanged,
    evidenceStateUpgradesFromPrevious: brief ? upgradesSince(previousVersion, brief) : [],
    evidenceStaleByPremise: (staleness?.stale || []).map((row) => ({ id: row.id, changedFields: row.changedFields })),
    evidenceInspection: inspection.map((row) => ({
      id: row.id,
      kind: row.kind,
      state: row.state,
      exists: row.exists === true,
      sha256Matches: row.sha256Matches === true,
      format: row.format || "not-checked",
      ...(row.audienceRun ? { audienceRunStatus: row.audienceRun.status } : {}),
      reasonCodes: [...(row.reasonCodes || [])],
    })),
    independence: "このブリーフを作った文脈（ループを始めた文脈・ブリーフの provenance.contextId・追加の作り手）と、前の回で採点した文脈では採点できない。新しい文脈で、ブリーフと根拠のファイルを開いて採点する",
  };
}

/** 評価シートに載せない欄（合格点・下限・重み・前の回の点数と、それが書かれた状態の置き場）。 */
export const STRATEGY_BRIEF_REVIEW_SHEET_FORBIDDEN_KEYS = Object.freeze([
  "targetScore", "minimumScore", "weight", "weights", "floors", "limits", "score", "scores", "bestScore",
  "improvement", "stagnantRounds", "rounds", "floorFailures", "failedGateIds", "failureFingerprint",
  "previousFailureFingerprint", "revisionDelta", "statePath", "revisionDeltaPath", "versions", "rubricScores",
]);

function issuesFromState(state) {
  if (!state || state.status === "passed") return [];
  const round = lastOf(state.rounds);
  const target = state.strategy?.contract?.limits?.targetScore;
  const issues = [];
  if (round) {
    issues.push(`strategy-brief-round-${round.index}-not-passed:${round.failureFingerprint}`);
    for (const id of round.floorFailures || []) issues.push(`strategy-brief-floor-failed:${id}`);
    if (Number.isFinite(target) && round.score < target) issues.push("strategy-brief-below-target");
    for (const id of round.failedGateIds || []) issues.push(`strategy-brief-machine-gate-failed:${id}`);
  }
  if (state.status === "active") {
    if (round) issues.push("strategy-brief-revision-and-fresh-review-required");
    else issues.push("strategy-brief-first-review-required");
  } else issues.push(`strategy-brief-stopped:${state.status}:${state.stopReason || "unknown"}`);
  return issues;
}

function nextStepDetail(state, paths) {
  const round = lastOf(state?.rounds);
  if (!state) return "先に start でループを始める";
  if (state.status === "passed") return "合格した。ブリーフをこの後で変えたら、その合格は今のブリーフを保証しない";
  if (state.status !== "active") return `企画の品質ループは ${state.status}（${state.stopReason}）で止まった。続けるかどうかは人が決める`;
  if (!round) return "最初の版を、作った文脈とは別の評価文脈で採点して record する";
  return `次の版には、前回の失敗（${round.failureFingerprint}）をどう直したかが要る。--revision-delta "直した内容" を付けるか、`
    + `${paths.revisionDeltaPath} に { "previousFailureFingerprint": "${round.failureFingerprint}", "revisionDelta": "直した内容" } を書く。`
    + "採点は、前の回で使っていない評価文脈で行う";
}

function checkFor(state, extra = {}) {
  const round = lastOf(state?.rounds);
  const version = lastOf(state?.strategy?.versions);
  return {
    pass: state?.status === "passed",
    status: state?.status || "not-started",
    stopReason: state?.stopReason || "",
    rounds: state?.rounds?.length || 0,
    score: round ? round.score : null,
    targetScore: state?.strategy?.contract?.limits?.targetScore ?? null,
    floorFailures: round ? [...(round.floorFailures || [])] : [],
    failedGateIds: round ? [...(round.failedGateIds || [])] : [],
    failureFingerprint: round?.failureFingerprint || "",
    label: version?.label || "",
    briefSha256: version?.briefSha256 || "",
    contractDigest: state?.contractDigest || "",
    ...extra,
  };
}

function waiting(state, issues, detail) {
  return { recorded: false, state, issues, detail, check: checkFor(state) };
}

/**
 * ループを始める。既に状態があれば始め直さない（restart は止まったループだけ。続いているループを
 * 始め直せると、回数・停滞の上限を消せてしまう）。始め直しても前の状態は history に残す。
 */
export async function startStrategyBriefLoop({
  workDir,
  generatorContextId,
  generatorHost = "",
  restart = false,
  restartReason = "",
  now = () => new Date().toISOString(),
} = {}) {
  const paths = strategyBriefQualityPaths(workDir);
  const context = nonEmpty(generatorContextId);
  if (!CONTEXT_ID.test(context)) {
    throw new Error("--generator-context にブリーフを書いた会話・タスクの ID が要ります（英数字と . _ : @ -）。この文脈は採点できない。");
  }
  const contract = createStrategyBriefQualityContract();
  return withCanvasFileLock(paths.statePath, async () => {
    const existing = await readJsonIfExists(paths.statePath, null);
    let history = [];
    if (existing) {
      if (!restart) {
        return { started: false, state: existing, issues: ["strategy-brief-loop-already-started"], detail: "この作業フォルダのループは始まっている。record で回を足すか、止まった後に --restart で始め直す" };
      }
      if (existing.status === "active") {
        return {
          started: false,
          state: existing,
          issues: ["strategy-brief-loop-active-cannot-restart"],
          detail: "続いているループは始め直せない（回数と停滞の上限を消せてしまう）。合格・人待ち・上限で止まってから始め直す",
        };
      }
      const reason = sanitizeEvidence(restartReason, 500);
      if (Array.from(reason).length < 4) throw new Error("--restart には --reason で始め直す理由が要ります（何が変わったか）。");
      const { strategy: previousStrategy, ...previousCore } = existing;
      history = [
        ...(previousStrategy?.history || []),
        {
          archivedAt: new Date(now()).toISOString(),
          reason,
          status: existing.status,
          stopReason: existing.stopReason || "",
          contractDigest: existing.contractDigest,
          state: { ...previousCore, strategy: { ...previousStrategy, history: [] } },
        },
      ];
    }
    const core = createQualityLoopState({
      contract,
      episodeId: "strategy-brief",
      generatorHost: nonEmpty(generatorHost),
      generatorId: STRATEGY_BRIEF_GENERATOR_ID,
      generatorContextId: context,
      startedAt: now(),
    });
    const state = {
      ...core,
      strategy: {
        version: STRATEGY_BRIEF_QUALITY_STATE_VERSION,
        contract,
        versions: [],
        history,
      },
    };
    await writeJsonAtomic(paths.statePath, state);
    return { started: true, state, issues: [], detail: nextStepDetail(state, paths) };
  });
}

function validateReviewScores(review, contract) {
  const scores = review?.rubricScores;
  if (!plainObject(scores)) return ["rubricScores-missing"];
  const ids = contract.rubric.map((row) => row.id);
  const problems = [];
  for (const id of ids) {
    const value = scores[id];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) problems.push(`score-invalid:${id}`);
  }
  for (const id of Object.keys(scores)) if (!ids.includes(id)) problems.push(`score-unknown:${id}`);
  return problems;
}

/**
 * ブリーフを読み、形と根拠を照合して機械ゲートを決める。例外は投げない（読めないものは gates に出す）。
 * extraGates は後から足したゲート（前提の食い違い）を同じ場所で決めるための口。
 */
export async function evaluateStrategyBriefGates({ workDir, brief, versions = [], contract = createStrategyBriefQualityContract() }) {
  const previousVersion = lastOf(versions);
  const validation = validateStrategyBrief(brief);
  const inspection = plainObject(brief) && Array.isArray(brief.evidence) ? await inspectStrategyEvidenceRows(workDir, brief) : [];
  const staleness = plainObject(brief)
    ? evidencePremiseStaleness(brief, { boundPremiseFor: boundPremiseFromVersions(versions) })
    : { stale: [], refreshRequired: false };
  const previous = brief?.changes?.previous;
  const gates = {
    "brief-schema-valid": validation.issues.length === 0,
    "brief-links-valid": validation.issues.length === 0 && validation.linkIssues.length === 0,
    "evidence-files-match": inspection.every((row) => row.exists === true && row.sha256Matches === true),
    "evidence-formats-readable": inspection.every((row) => row.format !== "unreadable"),
    "audience-runs-current": inspection.every((row) => !row.audienceRun || row.audienceRun.status === "current"),
    "previous-version-linked": !previousVersion || (plainObject(previous)
      && previous.sha256 === previousVersion.briefSha256 && previous.label === previousVersion.label),
    "evidence-premise-current": staleness.stale.length === 0,
  };
  const failedGateIds = contract.machineGates.filter((id) => gates[id] !== true).sort();
  return { validation, inspection, staleness, gates, failedGateIds };
}

/**
 * 1つの版を、品質ループの1回として記録する。例外は入力の形が壊れているときだけで、
 * 人の判断や直しが要る状態は issues で返す（recorded: false）。
 */
export async function recordStrategyBriefRound({
  workDir,
  briefPath,
  reviewPath,
  producerContexts = [],
  revisionDelta = "",
  blockingCondition = "",
  now = () => new Date().toISOString(),
  captureLearning = null,
} = {}) {
  const paths = strategyBriefQualityPaths(workDir);
  const briefFile = insideWorkDir(paths.workDir, briefPath, "--brief");
  const reviewFile = insideWorkDir(paths.workDir, reviewPath, "--review");
  const producers = [...new Set(producerContexts.map((value) => nonEmpty(value)).filter(Boolean))];
  for (const producer of producers) {
    if (!CONTEXT_ID.test(producer)) throw new Error("--producer-context は会話・タスクの ID（英数字と . _ : @ -）にしてください。");
  }

  return withCanvasFileLock(paths.statePath, async () => {
    const existing = await readJsonIfExists(paths.statePath, null);
    if (!existing?.strategy) return waiting(null, ["strategy-brief-loop-not-started"], "先に start でループを始める");
    // 採点に使うのは状態ファイルに写した契約ではなく、いま作り直した契約（digest が一致したもの）。
    const contract = createStrategyBriefQualityContract();
    if (contract.digest !== existing.contractDigest) {
      return waiting(existing, ["strategy-brief-contract-changed"], "このループは別の契約（評価項目・下限・上限・機械ゲート）で始まっている。続けるか始め直すかは人が決める");
    }
    const briefBytes = await readFile(briefFile.full);
    const briefSha256 = sha256Hex(briefBytes);
    let brief;
    try {
      brief = JSON.parse(briefBytes.toString("utf8"));
    } catch {
      return waiting(existing, ["strategy-brief-unreadable"], "ブリーフが JSON として読めない");
    }
    const reviewBytes = await readFile(reviewFile.full);
    const reviewSha256 = sha256Hex(reviewBytes);
    let review;
    try {
      review = JSON.parse(reviewBytes.toString("utf8"));
    } catch {
      return waiting(existing, ["strategy-brief-review-unreadable"], "採点ファイルが JSON として読めない");
    }
    const versions = existing.strategy.versions || [];
    const previousVersion = lastOf(versions);
    if (previousVersion && previousVersion.reviewSha256 === reviewSha256 && previousVersion.briefSha256 === briefSha256) {
      return { recorded: false, alreadyRecorded: true, state: existing, issues: issuesFromState(existing), detail: nextStepDetail(existing, paths), check: checkFor(existing) };
    }
    if (existing.status === "passed") {
      const changed = previousVersion && previousVersion.briefSha256 !== briefSha256;
      return waiting(
        existing,
        ["strategy-brief-loop-already-passed", ...(changed ? ["strategy-brief-changed-after-pass"] : [])],
        "このループは合格で止まっている。ブリーフを変えたなら、start --restart --reason \"何を変えたか\" で新しいループを始める",
      );
    }
    if (existing.status !== "active") return waiting(existing, issuesFromState(existing), nextStepDetail(existing, paths));
    const label = nonEmpty(brief?.label);
    if (!LABEL.test(label)) return waiting(existing, ["strategy-brief-label-invalid"], "ブリーフの label に版の名前（英数字と . _ -、64文字まで）が要る");
    if (versions.some((row) => row.label === label)) {
      return waiting(existing, [`strategy-brief-label-reused:${label}`], "版の名前は回ごとに変える（同じ名前の版は既に採点した）");
    }
    const sameBrief = versions.find((row) => row.briefSha256 === briefSha256);
    if (sameBrief) {
      return waiting(existing, [`strategy-brief-unchanged:${sameBrief.label}`], `このブリーフは版 ${sameBrief.label} と同じバイト列。直していない版を別の評価者に採点し直させない`);
    }
    if (review?.briefSha256 !== briefSha256) {
      return waiting(existing, ["strategy-brief-review-brief-mismatch"], "採点ファイルの briefSha256 が今のブリーフと違う。今のブリーフを採点し直す");
    }
    const evaluatorId = nonEmpty(review?.evaluatorId);
    const evaluatorContextId = nonEmpty(review?.evaluatorContextId);
    if (!evaluatorId || !CONTEXT_ID.test(evaluatorContextId)) {
      return waiting(existing, ["strategy-brief-review-evaluator-missing"], "採点ファイルに evaluatorId と evaluatorContextId（評価した会話・タスクの ID）が要る");
    }
    const briefContext = nonEmpty(brief?.provenance?.contextId);
    const producerSet = new Set([existing.generatorContextId, ...producers, ...(briefContext ? [briefContext] : [])]);
    if (evaluatorId === STRATEGY_BRIEF_GENERATOR_ID || producerSet.has(evaluatorContextId)) {
      return waiting(existing, ["strategy-brief-evaluator-not-independent"], "このブリーフを作った文脈（ループを始めた文脈・ブリーフの provenance.contextId・作り手）は採点できない。別の文脈で採点する");
    }
    const usedContexts = new Set((existing.rounds || []).flatMap((round) => (round.reviews || []).map((row) => row.evaluatorContextId)));
    if (usedContexts.has(evaluatorContextId)) {
      return waiting(existing, ["strategy-brief-fresh-review-required"], "この評価文脈は前の回で採点している。回ごとに新しい文脈で採点する");
    }
    const scoreProblems = validateReviewScores(review, contract);
    if (scoreProblems.length > 0) {
      return waiting(existing, scoreProblems.map((problem) => `strategy-brief-review-${problem}`), `採点ファイルの rubricScores は全項目（${contract.rubric.map((row) => row.id).join(", ")}）を 0〜100 で埋める`);
    }
    const notes = sanitizeEvidence(review.notes);
    if (Array.from(notes).length < 4) return waiting(existing, ["strategy-brief-review-notes-required"], "採点ファイルの notes に、何を読んで何を見たかを書く");

    const evaluated = await evaluateStrategyBriefGates({ workDir: paths.workDir, brief, versions, contract });

    let revision = {};
    if ((existing.rounds || []).length > 0) {
      const expected = lastOf(existing.rounds).failureFingerprint;
      let text = sanitizeEvidence(revisionDelta);
      if (!text) {
        const delta = await readJsonIfExists(paths.revisionDeltaPath, null).catch(() => null);
        if (nonEmpty(delta?.previousFailureFingerprint) === expected) text = sanitizeEvidence(delta?.revisionDelta);
      }
      if (Array.from(text).length < 4) {
        return waiting(existing, [`strategy-brief-revision-delta-required:${expected}`], nextStepDetail(existing, paths));
      }
      revision = { previousFailureFingerprint: expected, revisionDelta: text };
    }

    const observedAt = now();
    const briefRow = { path: briefFile.rel, sha256: briefSha256, note: `この回に採点したブリーフ（版 ${label}）` };
    const evidence = [
      briefRow,
      { path: reviewFile.rel, sha256: reviewSha256, note: "別の評価文脈の採点ファイル（評価項目の点数つき）" },
      ...evaluated.inspection
        .filter((row) => row.exists && row.sha256Matches && row.path)
        .map((row) => ({ path: row.path, sha256: (brief.evidence.find((entry) => entry.id === row.id) || {}).sha256, note: `ブリーフの根拠 ${row.id}（${row.kind}・${row.state}）` }))
        .filter((row) => /^[a-f0-9]{64}$/u.test(String(row.sha256 || ""))),
    ];
    let recorded;
    try {
      recorded = recordQualityRound({
        contract,
        state: existing,
        hardGateReport: { pass: evaluated.failedGateIds.length === 0, failedGateIds: evaluated.failedGateIds, contractDigest: contract.digest },
        reviews: [{
          evaluatorId,
          evaluatorContextId,
          evaluatorHost: nonEmpty(review.evaluatorHost),
          scores: review.rubricScores,
          notes,
          evidence: [briefRow],
        }],
        evidence,
        reviewDigest: reviewSha256,
        artifactSha256: briefSha256,
        observedAt,
        blockingCondition: nonEmpty(blockingCondition) || nonEmpty(review.blockingCondition),
        ...revision,
      });
    } catch (error) {
      return waiting(existing, ["strategy-brief-round-rejected"], `この採点は品質ループの回として記録できない: ${sanitizeEvidence(error?.message || String(error), 300)}`);
    }
    const premise = strategyBriefPremiseDigests(brief);
    const version = {
      round: recorded.rounds.length,
      label,
      briefPath: briefFile.rel,
      briefSha256,
      premise,
      premiseChangedFields: previousVersion ? premiseChangedFields(previousVersion.premise, premise) : [],
      harnessId: nonEmpty(brief?.production?.harnessId),
      provenance: { host: nonEmpty(brief?.provenance?.host), contextId: briefContext },
      evidence: (Array.isArray(brief?.evidence) ? brief.evidence : []).map(evidenceRecord),
      evidenceStateCounts: evidenceStateCounts(brief),
      evidenceStateUpgrades: upgradesSince(previousVersion, brief),
      staleEvidence: evaluated.staleness.stale.map((row) => ({ id: row.id, reasonCode: row.reasonCode, changedFields: row.changedFields })),
      validationIssues: [...evaluated.validation.issues, ...evaluated.validation.linkIssues].slice(0, 100),
      reviewPath: reviewFile.rel,
      reviewSha256,
      producerContexts: producers,
      machineGates: evaluated.gates,
      rubricScores: Object.fromEntries(contract.rubric.map((row) => [row.id, review.rubricScores[row.id]])),
      findings: (Array.isArray(review.findings) ? review.findings : []).map((entry) => sanitizeEvidence(entry, 500)).filter(Boolean).slice(0, 50),
      recordedAt: new Date(observedAt).toISOString(),
    };
    const next = { ...recorded, strategy: { ...recorded.strategy, versions: [...versions, version] } };
    await writeJsonAtomic(paths.statePath, next);
    const stateSha256 = sha256Hex(await readFile(paths.statePath));
    const round = lastOf(next.rounds);
    let learning = null;
    if (next.status !== "passed" && typeof captureLearning === "function") {
      // 学習の捕捉に失敗しても、回の記録は変えない。
      try {
        learning = await captureLearning({ state: next, round, version, contract });
      } catch (error) {
        learning = { captured: 0, skippedReason: "capture-failed", detail: sanitizeEvidence(error?.message || String(error), 200) };
      }
    }
    return {
      recorded: true,
      state: next,
      round,
      version,
      issues: issuesFromState(next),
      detail: next.status === "passed"
        ? `企画の品質ループ ${next.rounds.length} 回目（版 ${label}）で合格（目標点以上、下限割れなし、機械ゲート全通過）`
        : `企画の品質ループ ${next.rounds.length} 回目（版 ${label}）は不合格`
          + `${round.floorFailures.length ? `（下限割れ: ${round.floorFailures.join(", ")}）` : ""}`
          + `${round.failedGateIds.length ? `（落ちた機械ゲート: ${round.failedGateIds.join(", ")}）` : ""}。${nextStepDetail(next, paths)}`,
      check: checkFor(next, { stateSha256 }),
      learning,
    };
  });
}

/**
 * 今の状態。deliverable は「合格していて、合格した版のブリーフのファイルが今も同じバイト列」のときだけ true。
 */
export async function strategyBriefStatus({ workDir } = {}) {
  const paths = strategyBriefQualityPaths(workDir);
  const state = await readJsonIfExists(paths.statePath, null);
  if (!state?.strategy) {
    return { started: false, deliverable: false, issues: ["strategy-brief-loop-not-started"], detail: nextStepDetail(null, paths), check: checkFor(null) };
  }
  const version = lastOf(state.strategy.versions);
  let currentSha256 = "";
  if (version) {
    try {
      currentSha256 = sha256Hex(await readFile(resolve(paths.workDir, version.briefPath)));
    } catch {
      currentSha256 = "";
    }
  }
  const unchanged = Boolean(version) && currentSha256 === version.briefSha256;
  const issues = issuesFromState(state);
  if (version && !unchanged) issues.push(currentSha256 ? "strategy-brief-changed-after-review" : "strategy-brief-missing");
  const deliverable = state.status === "passed" && unchanged;
  return {
    started: true,
    deliverable,
    state,
    issues,
    detail: nextStepDetail(state, paths),
    check: checkFor(state, { currentBriefSha256: currentSha256, briefUnchangedSinceReview: unchanged }),
    rounds: (state.rounds || []).map((round, index) => ({
      index: round.index,
      label: state.strategy.versions[index]?.label || "",
      score: round.score,
      floorFailures: round.floorFailures,
      failedGateIds: round.failedGateIds,
      failureFingerprint: round.failureFingerprint,
      evaluatorContextId: round.reviews?.[0]?.evaluatorContextId || "",
    })),
  };
}

/** 評価者へ渡す評価シートと採点ファイルの雛形。briefSha256 はここで計算して埋める。点数は埋めない。 */
export async function strategyBriefReviewTemplate({ workDir, briefPath } = {}) {
  const paths = strategyBriefQualityPaths(workDir);
  const state = await readJsonIfExists(paths.statePath, null);
  if (!state?.strategy) throw new Error("先に start でループを始めてください。");
  const briefFile = insideWorkDir(paths.workDir, briefPath, "--brief");
  const bytes = await readFile(briefFile.full);
  const briefSha256 = sha256Hex(bytes);
  let brief = null;
  try {
    brief = JSON.parse(bytes.toString("utf8"));
  } catch {
    brief = null;
  }
  const inspection = plainObject(brief) && Array.isArray(brief.evidence) ? await inspectStrategyEvidenceRows(paths.workDir, brief) : [];
  const staleness = plainObject(brief)
    ? evidencePremiseStaleness(brief, { boundPremiseFor: boundPremiseFromVersions(state.strategy.versions) })
    : null;
  const sheet = strategyBriefReviewSheet(state.strategy.contract, {
    briefRel: briefFile.rel,
    briefSha256,
    label: nonEmpty(brief?.label),
    inspection,
    previousVersion: lastOf(state.strategy.versions),
    brief,
    staleness,
  });
  return {
    sheet,
    template: {
      evaluatorId: `<評価者の名前（作る係の ${STRATEGY_BRIEF_GENERATOR_ID} は不可）>`,
      evaluatorContextId: "<この採点をする会話・タスクの ID（ブリーフを作った文脈・前の回の文脈は不可）>",
      evaluatorHost: "<claude-code|codex|human>",
      briefSha256,
      rubricScores: Object.fromEntries(state.strategy.contract.rubric.map((row) => [row.id, null])),
      notes: "<ブリーフと根拠のファイルの何を読んで、どう判断したか>",
      findings: [],
    },
  };
}

/**
 * 制作へ渡す前の判定（verdict）。モデルを呼ばず、ブリーフ・品質ループの記録・根拠のファイルだけで決める。
 *
 * pass は次の全部が揃うときだけ:
 *   - ブリーフの形が合っている
 *   - 品質ループが合格していて、合格した版がこのブリーフ（同じ SHA）
 *   - 根拠のファイルが全部あって SHA が一致し、4分析の run が現行
 *   - 前提を変えて古くなった根拠が無い
 * 制作側でブリーフを書き換えた（provisional を verified にした等）ときは SHA が記録と合わず、
 * 最後に採点した版から確かさを上げた根拠を strategy-brief-evidence-upgraded-without-review で名指しする。
 */
export async function strategyBriefVerdict({ workDir = "", briefPath } = {}) {
  if (!nonEmpty(briefPath)) throw new Error("--brief にブリーフのファイルが要ります。");
  const briefFull = resolve(briefPath);
  const root = nonEmpty(workDir) ? resolve(workDir) : resolve(briefFull, "..");
  const paths = strategyBriefQualityPaths(root);
  const reasons = [];
  const bytes = await readFile(briefFull);
  const briefSha256 = sha256Hex(bytes);
  let brief = null;
  try {
    brief = JSON.parse(bytes.toString("utf8"));
  } catch {
    brief = null;
  }
  const base = {
    version: STRATEGY_BRIEF_VERDICT_VERSION,
    modelCallsAttempted: false,
    briefSha256,
  };
  if (!plainObject(brief)) {
    return { ...base, pass: false, reasonCodes: ["strategy-brief-unreadable"], refreshRequired: false, detail: "ブリーフが JSON として読めない" };
  }
  const validation = validateStrategyBrief(brief);
  if (!validation.ok) reasons.push("strategy-brief-invalid");

  const state = await readJsonIfExists(paths.statePath, null);
  const versions = state?.strategy?.versions || [];
  const matched = versions.find((row) => row.briefSha256 === briefSha256) || null;
  const latest = lastOf(versions);
  let upgrades = [];
  if (!state?.strategy) reasons.push("strategy-brief-loop-not-started");
  else if (!matched) {
    reasons.push("strategy-brief-not-reviewed");
    if (latest) {
      reasons.push("strategy-brief-changed-after-review");
      upgrades = evidenceStateUpgrades({ evidence: latest.evidence || [] }, brief);
      for (const row of upgrades) reasons.push(`strategy-brief-evidence-upgraded-without-review:${row.id}`);
    }
  } else if (state.status !== "passed") {
    reasons.push(`strategy-brief-loop-not-passed:${state.status}`);
  } else if (matched !== latest) {
    reasons.push("strategy-brief-not-the-passed-version");
  }

  const inspection = Array.isArray(brief.evidence) ? await inspectStrategyEvidenceRows(root, brief) : [];
  for (const row of inspection) for (const code of row.reasonCodes || []) reasons.push(`${code}:${row.id}`);
  const staleness = evidencePremiseStaleness(brief, { boundPremiseFor: boundPremiseFromVersions(versions) });
  for (const row of staleness.stale) reasons.push(`${row.reasonCode}:${row.id}`);
  if (staleness.refreshRequired) reasons.push(EVIDENCE_REFRESH_REQUIRED_CODE);

  const reasonCodes = [...new Set(reasons)];
  const pass = reasonCodes.length === 0;
  const counts = evidenceStateCounts(brief);
  const staleFields = [...new Set(staleness.stale.flatMap((row) => row.changedFields))];
  return {
    ...base,
    pass,
    label: nonEmpty(brief.label),
    harnessId: nonEmpty(brief.production?.harnessId) || null,
    loop: {
      started: Boolean(state?.strategy),
      status: state?.status || "not-started",
      stopReason: state?.stopReason || "",
      rounds: state?.rounds?.length || 0,
      reviewedLabel: matched?.label || null,
      latestLabel: latest?.label || null,
    },
    evidence: {
      counts,
      total: inspection.length,
      stale: staleness.stale.map((row) => ({ id: row.id, reasonCode: row.reasonCode, changedFields: row.changedFields })),
      upgradedWithoutReview: upgrades,
    },
    refreshRequired: staleness.refreshRequired,
    reasonCodes,
    validationIssues: [...validation.issues, ...validation.linkIssues].slice(0, 50),
    detail: pass
      ? `企画の品質ループで合格した版（${nonEmpty(brief.label)}）。根拠 verified ${counts.verified} / provisional ${counts.provisional} / unverified ${counts.unverified}`
      : staleness.refreshRequired
        ? `前提（${staleFields.join("・") || "問い・見る人・入口の約束"}）を変えたので、その前提で集めた根拠 ${staleness.stale.length} 件の取り直しが要る`
        : `制作へ渡す前に要ること: ${reasonCodes.join(", ")}`,
  };
}
