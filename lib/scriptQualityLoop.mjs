/**
 * 台本の品質ループ（ジャンル層の共通 Core）。
 *
 * 中核（採点・下限・失敗指紋・止まる条件・作る係と評価する係の分離）は lib/qualityLoop.mjs の
 * 共通部品で、ここが決めるのは次の4つだけ:
 *   - ジャンル既定の評価項目と下限（ナレーション物語の台本なら、拍の型・意味の保持・語り口・
 *     尺・感想パートの一人称の差し替え印・読み）
 *   - 機械ゲート（台本が読める、外部モデルの手直しに呼び出しの記録が付いていて全部完了している）
 *   - 上限の既定と、Channel Pack（非公開）からの上書きの範囲
 *   - 台本の「版」を1回の採点へ結び付ける配線（台本 SHA・版・前の版・評価文脈・外部呼び出し）
 *
 * 台本づくりは「ホストの初稿 → 外部モデルの手直し → ホストの意味照合」の3段で、初稿を
 * 書いた文脈がそのまま照合もしていた。ここでは版ごとに、**その版を作った文脈（初稿の文脈・
 * 追加の作り手・外部モデルを呼んだ文脈）とは別の評価文脈**の採点を1回として記録する。
 *
 * 守ること:
 *   - 採点は台本ファイルの SHA と版に縛る。採点ファイルの scriptSha256 が今の台本と違えば
 *     記録しない。前の版から作った版は、前の版の SHA と比べたこと（baseScriptSha256）を要求する
 *   - 2回目以降は「前の失敗をどう直したか」が要る。無ければ例外ではなく人待ちで止める
 *   - Channel Pack はジャンルの下限を**上げる**・評価項目を**足す**・重みを変えることだけできる。
 *     下限を下げる・ジャンルの項目を消す・範囲外の上限は blocker（黙って既定へ戻さない）
 *   - 状態は台本と同じ作業フォルダ（私有側）の quality/ に原子的に書く。本文は持たない
 *   - 合格した版の後に台本が変わったら、その合格は今の台本を保証しない（status が示す）
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { readJsonIfExists, writeJsonAtomic } from "./atomicJsonFile.mjs";
import { withCanvasFileLock } from "./canvasFileLock.mjs";
import { trustedChannelPackKeyFromEnvironment, verifyChannelPackEnvelope } from "./channelPackEnvelope.mjs";
import { externalCallLedgerPath, findExternalCalls, isExternalCallId } from "./externalModelCallLedger.mjs";
import {
  QUALITY_ACCEPTANCE_MODES,
  createQualityLoopState,
  findStaleQualityFeedback,
  normalizeQualityAcceptance,
  normalizeQualityRubric,
  recordQualityRound,
  sanitizeEvidence,
} from "./qualityLoop.mjs";

export const SCRIPT_QUALITY_CONTRACT_VERSION = "buzzassist-script-quality-contract-v1";
export const SCRIPT_QUALITY_STATE_VERSION = "buzzassist-script-quality-loop-v1";
export const SCRIPT_QUALITY_CHANNEL_CONFIG_VERSION = "buzzassist-script-quality-channel-v1";
/** Channel Pack の payload に置く、チャンネル固有の評価項目と下限。 */
export const SCRIPT_QUALITY_CHANNEL_CONFIG_FILE = "script-quality.json";
export const SCRIPT_QUALITY_DIR = "quality";
export const SCRIPT_QUALITY_STATE_FILE = "script-quality-loop.json";
export const SCRIPT_REVISION_DELTA_FILE = "script-revision-delta.json";
/** 作る係の役割 id。評価者がこれを名乗っても採点できない。 */
export const SCRIPT_GENERATOR_ID = "script-writer";
/** 版を作った工程。 */
export const SCRIPT_STAGES = Object.freeze(["draft", "external-rewrite", "meaning-check", "revision"]);

/** 機械ゲート。採点より前に、ファイルと台帳だけから決まる。 */
export const SCRIPT_MACHINE_GATES = Object.freeze({
  "script-readable": "台本ファイルが UTF-8 で読めて、空でない",
  "external-call-recorded": "外部モデルの手直しの版に、外部モデル呼び出しの記録（harness-external-call）が付いていて、参照した id が全部台帳にある",
  "external-calls-complete": "参照した外部モデル呼び出しが全部 complete（空返答・途中切れ・上限・時間切れが無い）",
});

const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const CONTEXT_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;
const EVALUATOR_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/u;
/** 1つの評価の組に宣言できる評価者の数の上限。 */
export const SCRIPT_PANEL_MAX_EVALUATORS = 5;
const CRITERION_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

// ナレーション物語の台本の評価項目。重みと下限は実測から決めた閾値ではなく方針値。
// 視聴者や制作ラインが「話が違う」と気づく意味の保持は下限 90、生成した体験を本人の体験に
// 見せない差し替え印は満点（1つでも欠ければ不合格）、ほかは致命傷の足切りとして 60〜70。
// 重みは合計 100。外部モデルの手直しで最も壊れやすいのが意味なので、意味の保持を一番重くした。
const NARRATED_STORY_SCRIPT_RUBRIC = Object.freeze([
  {
    id: "beat-structure",
    label: "拍の型への適合",
    weight: 20,
    minimumScore: 70,
    description: "チャンネルが宣言した拍（場面の順・山場の位置・回収する言葉・締め）に沿っている。欠けた拍、順番の入れ替わり、山場の前寄りが無い",
  },
  {
    id: "meaning-preservation",
    label: "意味の保持",
    weight: 30,
    minimumScore: 90,
    description: "前の版から、人物・年齢・数字・否定・条件・因果・台詞の語順（鉤括弧の中の句読点を含む）が変わっていない。新しい出来事が足されていない。初稿では、依頼された題材と拍の表に対して見る",
  },
  {
    id: "narration-voice",
    label: "語り口",
    weight: 15,
    minimumScore: 60,
    description: "1行1文で、耳で聞いて自然。同じ説明・反省の繰り返し、説教、誰の台詞か分からない行が無い",
  },
  {
    id: "duration-fit",
    label: "尺",
    weight: 10,
    minimumScore: 60,
    description: "実測の話速で見積もった尺がチャンネルの宣言した範囲に入り、山場が宣言した位置までに来る",
  },
  {
    id: "review-first-person-marker",
    label: "感想パートの一人称の差し替え印",
    weight: 10,
    minimumScore: 100,
    description: "感想パートで案内役が自分の体験として語る文すべてに、差し替え印（Channel Pack が宣言した印）が付いている。生成した体験を本人の体験として確定させていない（該当する文が無ければ満点）",
  },
  {
    id: "reading-clarity",
    label: "読み",
    weight: 15,
    minimumScore: 70,
    description: "読みが割れる語・同音で意味が変わる語を避けるか、読みを指定している。人名の読みが一意",
  },
]);

// 上限の既定（方針値）。ナレーション物語の動画の品質ループ（目標 92・3回・72時間）との違い:
// - 目標 90・回数 5: 台本は3段（初稿・手直し・照合）を毎回それぞれ1回として採点するので、
//   直しの回を2つ足した数を上限にする。目標は動画より 2 点低い（台本の後に画・声の工程がある）
// - 時間 7 日: 外部モデルの利用枠が切れると戻るまで数日かかることがある
// - 停滞 2: 手直しの回は語り口を上げる代わりに他の項目が少し下がることがあり、1回の停滞で
//   止めると3段の途中で止まる
export const SCRIPT_QUALITY_LIMIT_DEFAULTS = Object.freeze({
  targetScore: 90,
  maximumReviewRounds: 5,
  maximumElapsedMs: 7 * 24 * 60 * 60 * 1_000,
  maximumCost: 100,
  minimumImprovement: 1,
  maximumStagnantRounds: 2,
});

const LIMIT_FIELDS = Object.freeze({
  targetScore: { key: "targetScore", minimum: 80, maximum: 100, integer: false },
  maximumReviewRounds: { key: "maximumReviewRounds", minimum: 1, maximum: 10, integer: true },
  maximumElapsedMinutes: { key: "maximumElapsedMs", minimum: 1, maximum: 14 * 24 * 60, integer: false, scale: 60_000 },
  maximumCostUnits: { key: "maximumCost", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, integer: false },
  minimumImprovementPoints: { key: "minimumImprovement", minimum: 0, maximum: 100, integer: false },
  maximumStagnantRounds: { key: "maximumStagnantRounds", minimum: 1, maximum: 5, integer: true },
});

/** ジャンルごとの定義。ジャンルが決めるのは評価項目・下限・機械ゲート・上限だけ。 */
export const SCRIPT_QUALITY_GENRES = Object.freeze({
  "narrated-story": Object.freeze({
    id: "narrated-story",
    harnessId: "narrated-story-video",
    rubric: NARRATED_STORY_SCRIPT_RUBRIC,
    limits: SCRIPT_QUALITY_LIMIT_DEFAULTS,
    machineGates: Object.freeze(Object.keys(SCRIPT_MACHINE_GATES)),
  }),
});

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (plainObject(value)) {
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

export function scriptQualityGenre(genre = "narrated-story") {
  const spec = SCRIPT_QUALITY_GENRES[String(genre || "")];
  if (!spec) throw new Error(`未知の台本ジャンル: ${genre}（${Object.keys(SCRIPT_QUALITY_GENRES).join(" / ")}）`);
  return spec;
}

function boundedNumber(value, minimum, maximum) {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

/**
 * Channel Pack の script-quality.json を検査する。直せない値は blocker にする
 * （黙って既定へ戻すと、Pack の作者は効いているつもりになる）。
 *
 * 形:
 * {
 *   "version": "buzzassist-script-quality-channel-v1",
 *   "genre": "narrated-story",
 *   "criteria": [{ "id", "label", "weight", "minimumScore", "description" }],   // 足す項目
 *   "floors": { "<ジャンルの項目 id>": 下限 },                                   // 上げるだけ
 *   "weights": { "<ジャンルの項目 id>": 重み },
 *   "limits": { "targetScore", "maximumReviewRounds", "maximumElapsedMinutes", ... },
 *   "acceptance": {                                                             // 任意。無ければ今までどおり
 *     "mode": "average" | "each-evaluator",
 *     "evaluators": ["<評価者 id>", ...],
 *     "minimumEvaluatorScore": 88                                               // each-evaluator だけ。無ければ目標点
 *   }
 * }
 *
 * acceptance を書いたチャンネルだけ、1つの版を「宣言した評価者の全員」で採点する（評価の組）。
 * average は評価者の平均で、each-evaluator は評価者それぞれの総合点と項目の下限で合否を決める。
 * 書かなければ組は1人・平均で、今までの1件ずつの記録と同じに動く。既定をどのチャンネルにも強制しない。
 */
export function normalizeScriptChannelConfig(source, genreSpec = scriptQualityGenre()) {
  const empty = { criteria: [], floors: {}, weights: {}, limits: {}, acceptance: null, blockers: [] };
  if (source === undefined || source === null) return empty;
  if (!plainObject(source)) return { ...empty, blockers: ["script-quality"] };
  const blockers = [];
  const allowed = new Set(["version", "genre", "criteria", "floors", "weights", "limits", "acceptance"]);
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) blockers.push(key === "rubric" ? "script-quality.rubric-not-replaceable" : `script-quality.${key}-unknown`);
  }
  if (source.version !== SCRIPT_QUALITY_CHANNEL_CONFIG_VERSION) blockers.push("script-quality.version");
  if (source.genre !== undefined && source.genre !== genreSpec.id) blockers.push("script-quality.genre-mismatch");
  const genreIds = new Set(genreSpec.rubric.map((row) => row.id));
  const genreFloors = new Map(genreSpec.rubric.map((row) => [row.id, row.minimumScore]));

  const criteria = [];
  if (source.criteria !== undefined) {
    if (!Array.isArray(source.criteria) || source.criteria.length > 12) blockers.push("script-quality.criteria");
    else {
      const seen = new Set();
      for (const [index, row] of source.criteria.entries()) {
        const id = nonEmpty(row?.id);
        const field = `script-quality.criteria[${index}]`;
        if (!plainObject(row) || !CRITERION_ID.test(id) || id.length > 48) { blockers.push(`${field}.id`); continue; }
        if (genreIds.has(id)) { blockers.push(`script-quality.criteria.${id}-collides-with-genre`); continue; }
        if (seen.has(id)) { blockers.push(`script-quality.criteria.${id}-duplicated`); continue; }
        seen.add(id);
        const label = nonEmpty(row.label);
        const description = nonEmpty(row.description);
        if (!label || Array.from(label).length > 60) blockers.push(`script-quality.criteria.${id}.label`);
        if (Array.from(description).length < 4 || Array.from(description).length > 300) blockers.push(`script-quality.criteria.${id}.description`);
        if (!boundedNumber(row.weight, 1, 100)) blockers.push(`script-quality.criteria.${id}.weight`);
        if (!boundedNumber(row.minimumScore, 0, 100)) blockers.push(`script-quality.criteria.${id}.minimumScore`);
        criteria.push({ id, label, weight: row.weight, minimumScore: row.minimumScore, description });
      }
    }
  }

  const floors = {};
  if (source.floors !== undefined) {
    if (!plainObject(source.floors)) blockers.push("script-quality.floors");
    else {
      for (const [id, value] of Object.entries(source.floors)) {
        if (!genreIds.has(id)) { blockers.push(`script-quality.floors.${id}-unknown`); continue; }
        if (!boundedNumber(value, 0, 100)) { blockers.push(`script-quality.floors.${id}`); continue; }
        // ジャンルの足切りを番組ごとに緩められると、この保証の意味が無くなる。
        if (value < genreFloors.get(id)) { blockers.push(`script-quality.floors.${id}-cannot-lower`); continue; }
        floors[id] = value;
      }
    }
  }

  const weights = {};
  if (source.weights !== undefined) {
    if (!plainObject(source.weights)) blockers.push("script-quality.weights");
    else {
      for (const [id, value] of Object.entries(source.weights)) {
        if (!genreIds.has(id)) { blockers.push(`script-quality.weights.${id}-unknown`); continue; }
        if (!boundedNumber(value, 1, 100)) { blockers.push(`script-quality.weights.${id}`); continue; }
        weights[id] = value;
      }
    }
  }

  const limits = {};
  if (source.limits !== undefined) {
    if (!plainObject(source.limits)) blockers.push("script-quality.limits");
    else {
      for (const [field, value] of Object.entries(source.limits)) {
        const spec = LIMIT_FIELDS[field];
        if (!spec) { blockers.push(`script-quality.limits.${field}-unknown`); continue; }
        if (!boundedNumber(value, spec.minimum, spec.maximum) || (spec.integer && !Number.isInteger(value))) {
          blockers.push(`script-quality.limits.${field}`);
          continue;
        }
        limits[spec.key] = spec.scale ? Math.round(value * spec.scale) : value;
      }
    }
  }
  const acceptance = source.acceptance === undefined ? null : normalizeAcceptanceConfig(source.acceptance, blockers);
  return { criteria, floors, weights, limits, acceptance, blockers };
}

function normalizeAcceptanceConfig(value, blockers) {
  if (!plainObject(value)) {
    blockers.push("script-quality.acceptance");
    return null;
  }
  for (const key of Object.keys(value)) {
    if (!["mode", "evaluators", "minimumEvaluatorScore"].includes(key)) blockers.push(`script-quality.acceptance.${key}-unknown`);
  }
  const mode = value.mode === undefined ? "average" : value.mode;
  if (!QUALITY_ACCEPTANCE_MODES.includes(mode)) {
    blockers.push("script-quality.acceptance.mode");
    blockers.push("script-quality.acceptance");
    return null;
  }
  const evaluators = [];
  if (value.evaluators !== undefined) {
    if (!Array.isArray(value.evaluators) || value.evaluators.length > SCRIPT_PANEL_MAX_EVALUATORS) {
      blockers.push("script-quality.acceptance.evaluators");
    } else {
      for (const entry of value.evaluators) {
        const id = nonEmpty(entry);
        if (!EVALUATOR_ID.test(id) || id === SCRIPT_GENERATOR_ID) { blockers.push("script-quality.acceptance.evaluators.id"); continue; }
        if (evaluators.includes(id)) { blockers.push(`script-quality.acceptance.evaluators.${id}-duplicated`); continue; }
        evaluators.push(id);
      }
    }
  }
  if (mode === "each-evaluator" && evaluators.length === 0 && value.evaluators === undefined) {
    blockers.push("script-quality.acceptance.evaluators-required");
    return null;
  }
  const acceptance = { mode, evaluators };
  if (value.minimumEvaluatorScore !== undefined) {
    // 評価者ごとの総合点の下限。目標点と同じ範囲（80〜100）でだけ受ける。
    if (mode !== "each-evaluator") blockers.push("script-quality.acceptance.minimumEvaluatorScore-each-evaluator-only");
    else if (!boundedNumber(value.minimumEvaluatorScore, LIMIT_FIELDS.targetScore.minimum, LIMIT_FIELDS.targetScore.maximum)) {
      blockers.push("script-quality.acceptance.minimumEvaluatorScore");
    } else acceptance.minimumEvaluatorScore = value.minimumEvaluatorScore;
    if (blockers.some((row) => row.startsWith("script-quality.acceptance.minimumEvaluatorScore"))) return null;
  }
  try {
    normalizeQualityAcceptance(acceptance);
  } catch {
    blockers.push("script-quality.acceptance");
  }
  return acceptance;
}

/** 1つの版を採点する評価者の宣言（無ければ1人で、評価者を名指ししない）。 */
function panelEvaluators(contract) {
  return normalizeQualityAcceptance(contract?.acceptance).evaluators;
}

function panelSize(contract) {
  return Math.max(1, panelEvaluators(contract).length);
}

/**
 * 台本の品質契約。走行中は変えない（digest が変われば同じループを続けない）。
 * channelSource は契約に入る（どの Pack・どの設定で採点したかが digest に残る）。パスは入れない。
 */
export function createScriptQualityContract({ genre = "narrated-story", channelConfig = null, channelSource = { kind: "none" } } = {}) {
  const spec = scriptQualityGenre(genre);
  const channel = normalizeScriptChannelConfig(channelConfig, spec);
  if (channel.blockers.length > 0) return { contract: null, blockers: channel.blockers };
  const rows = [
    ...spec.rubric.map((row) => ({
      ...row,
      weight: channel.weights[row.id] ?? row.weight,
      minimumScore: channel.floors[row.id] ?? row.minimumScore,
      origin: "genre",
    })),
    ...channel.criteria.map((row) => ({ ...row, origin: "channel" })),
  ];
  const rubric = normalizeQualityRubric(rows).map((row, index) => ({ ...row, origin: rows[index].origin }));
  const body = {
    version: SCRIPT_QUALITY_CONTRACT_VERSION,
    genre: spec.id,
    harnessId: spec.harnessId,
    universalRules: {
      generatorEvaluatorSeparation: true,
      producerContextsExcludedFromEvaluation: true,
      distinctEvaluatorContextRequired: true,
      reviewBoundToScriptSha256: true,
      derivedVersionReviewBoundToBaseSha256: true,
      deterministicGatesBeforeJudgment: true,
      completeRubricRequired: true,
      rubricFloorsRequired: true,
      failureFingerprintRequired: true,
      revisionDeltaRequired: true,
      externalCallsRecordedWithoutBodies: true,
      channelMayOnlyTightenGenreFloors: true,
      immutableDuringRun: true,
    },
    machineGates: [...spec.machineGates],
    rubric,
    limits: { ...spec.limits, ...channel.limits },
    channelSource: normalizeChannelSource(channelSource),
    // 受け入れ方は宣言したチャンネルの契約にだけ入れる（宣言の無い契約の digest は今までと同じ値）。
    ...(channel.acceptance ? { acceptance: channel.acceptance } : {}),
  };
  return { contract: deepFreeze({ ...body, digest: sha256(canonicalJson(body)) }), blockers: [] };
}

function normalizeChannelSource(source = {}) {
  const kind = nonEmpty(source?.kind) || "none";
  if (kind === "signed-channel-pack") {
    return {
      kind,
      packId: nonEmpty(source.packId),
      packVersion: nonEmpty(source.packVersion),
      payloadSha256: nonEmpty(source.payloadSha256),
      configSha256: SHA256.test(String(source.configSha256 || "")) ? source.configSha256 : null,
    };
  }
  if (kind === "unsigned-file") return { kind, configSha256: nonEmpty(source.configSha256) };
  return { kind: "none" };
}

/**
 * チャンネル固有の評価項目の読み込み元を解決する。
 * - channelPack: 署名済み Channel Pack（envelope）。受領側が信頼した公開鍵
 *   （BUZZASSIST_CHANNEL_PACK_PUBLIC_KEY）で検証し、payload/script-quality.json を読む
 * - channelConfig: 署名の無い設定ファイル（手元の試行用）。契約に unsigned-file と刻まれる
 */
export async function loadScriptChannelConfig({
  channelPack = "",
  channelConfig = "",
  env = process.env,
  expectedHarnessId = "",
  verifyEnvelope = verifyChannelPackEnvelope,
  trustedKey = trustedChannelPackKeyFromEnvironment,
} = {}) {
  if (nonEmpty(channelPack) && nonEmpty(channelConfig)) {
    throw new Error("--channel-pack と --channel-config はどちらか1つにしてください。");
  }
  if (nonEmpty(channelPack)) {
    const bundleDir = resolve(channelPack);
    const verified = await verifyEnvelope({ bundleDir, ...(await trustedKey(env)), expectedHarnessId });
    const configPath = join(verified.payloadDir, SCRIPT_QUALITY_CHANNEL_CONFIG_FILE);
    let bytes = null;
    try {
      bytes = await readFile(configPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return {
      config: bytes ? JSON.parse(bytes.toString("utf8")) : null,
      source: {
        kind: "signed-channel-pack",
        packId: verified.id,
        packVersion: verified.packVersion,
        payloadSha256: verified.payloadSha256,
        configSha256: bytes ? sha256(bytes) : null,
      },
      spec: { kind: "signed-channel-pack", bundleDir },
    };
  }
  if (nonEmpty(channelConfig)) {
    const file = resolve(channelConfig);
    const bytes = await readFile(file);
    return {
      config: JSON.parse(bytes.toString("utf8")),
      source: { kind: "unsigned-file", configSha256: sha256(bytes) },
      spec: { kind: "unsigned-file", file },
    };
  }
  return { config: null, source: { kind: "none" }, spec: { kind: "none" } };
}

function channelArgsFromSpec(spec = {}) {
  if (spec.kind === "signed-channel-pack") return { channelPack: spec.bundleDir };
  if (spec.kind === "unsigned-file") return { channelConfig: spec.file };
  return {};
}

export function scriptQualityPaths(workDir) {
  if (!nonEmpty(workDir)) throw new Error("--work-dir に台本の作業フォルダが要ります。");
  const root = resolve(workDir);
  const dir = join(root, SCRIPT_QUALITY_DIR);
  return {
    workDir: root,
    dir,
    statePath: join(dir, SCRIPT_QUALITY_STATE_FILE),
    revisionDeltaPath: join(dir, SCRIPT_REVISION_DELTA_FILE),
    externalCallLedgerPath: externalCallLedgerPath({ workDir: root }),
  };
}

/** 作業フォルダの中のファイルだけを受け、フォルダからの相対パス（/ 区切り）を返す。 */
function insideWorkDir(workDir, file, label) {
  if (!nonEmpty(file)) throw new Error(`${label} が要ります。`);
  const full = resolve(workDir, file);
  const rel = relative(workDir, full);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${label} は台本の作業フォルダの中に置いてください（状態は作業フォルダからの相対パスで残します）。`);
  }
  return { full, rel: rel.split(sep).join("/") };
}

async function inspectScript(path) {
  const bytes = await readFile(path);
  let text = "";
  let decoded = true;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    decoded = false;
  }
  const nonEmptyLines = text.split(/\r?\n/u).filter((line) => line.trim()).length;
  return { sha256: sha256(bytes), bytes: bytes.length, nonEmptyLines, readable: decoded && nonEmptyLines > 0 };
}

function lastOf(list) {
  return Array.isArray(list) && list.length > 0 ? list[list.length - 1] : null;
}

/** 評価者へ渡す採点表（契約の写し）。 */
export function scriptQualityReviewSheet(contract) {
  return {
    contractVersion: contract.version,
    contractDigest: contract.digest,
    genre: contract.genre,
    targetScore: contract.limits.targetScore,
    rubric: contract.rubric.map((row) => ({
      id: row.id,
      label: row.label,
      weight: row.weight,
      minimumScore: row.minimumScore,
      origin: row.origin,
      description: row.description,
    })),
    machineGates: contract.machineGates.map((id) => ({ id, description: SCRIPT_MACHINE_GATES[id] })),
  };
}

function issuesFromState(state) {
  if (!state || state.status === "passed") return [];
  const round = lastOf(state.rounds);
  const target = state.script?.contract?.limits?.targetScore;
  const issues = [];
  if (round) {
    issues.push(`script-quality-round-${round.index}-not-passed:${round.failureFingerprint}`);
    for (const id of round.floorFailures || []) issues.push(`script-quality-floor-failed:${id}`);
    if (Number.isFinite(target) && round.score < target) issues.push(`script-quality-below-target:${round.score}<${target}`);
    for (const id of round.failedGateIds || []) issues.push(`script-quality-machine-gate-failed:${id}`);
  }
  if (state.status === "active") {
    const panel = state.script?.pendingPanel;
    if (panel) issues.push(`script-quality-panel-waiting:${panelMissing(panel).join(",")}`);
    else if (round) issues.push("script-quality-revision-and-fresh-review-required");
    else issues.push("script-quality-first-review-required");
  } else issues.push(`script-quality-stopped:${state.status}:${state.stopReason || "unknown"}`);
  return issues;
}

/** 組がまだ待っている評価者（宣言した順）。 */
function panelMissing(panel) {
  const received = new Set((panel?.reviews || []).map((row) => row.evaluatorId));
  return (panel?.declaredEvaluators || []).filter((id) => !received.has(id));
}

function panelSummary(panel) {
  if (!panel) return null;
  return {
    versionLabel: panel.versionLabel,
    stage: panel.stage,
    scriptSha256: panel.scriptSha256,
    declaredEvaluators: [...(panel.declaredEvaluators || [])],
    received: (panel.reviews || []).map((row) => row.evaluatorId),
    missing: panelMissing(panel),
  };
}

function nextStepDetail(state, paths) {
  const round = lastOf(state?.rounds);
  if (!state) return "先に start でループを始める";
  if (state.status === "passed") return "合格した。台本をこの後で変えたら、その合格は今の台本を保証しない";
  if (state.status !== "active") return `品質ループは ${state.status}（${state.stopReason}）で止まった。続けるかどうかは人が決める`;
  const panel = state.script?.pendingPanel;
  if (panel) {
    return `版 ${panel.versionLabel} の評価の組は ${panelMissing(panel).join(", ")} の採点を待っている。`
      + "record --review <採点ファイル> で組に入れる（同じ台本 SHA を、組の中でも前の回とも別の評価文脈で採点する）。全員そろった時点で1回として閉じる";
  }
  if (!round) return "最初の版を、作った文脈とは別の評価文脈で採点して record する";
  return `次の版には、前回の失敗（${round.failureFingerprint}）をどう直したかが要る。--revision-delta "直した内容" を付けるか、`
    + `${paths.revisionDeltaPath} に { "previousFailureFingerprint": "${round.failureFingerprint}", "revisionDelta": "直した内容" } を書く。`
    + "採点は、前の回で使っていない評価文脈で行う";
}

function checkFor(state, extra = {}) {
  const round = lastOf(state?.rounds);
  const version = lastOf(state?.script?.versions);
  return {
    pass: state?.status === "passed",
    status: state?.status || "not-started",
    stopReason: state?.stopReason || "",
    rounds: state?.rounds?.length || 0,
    score: round ? round.score : null,
    targetScore: state?.script?.contract?.limits?.targetScore ?? null,
    floorFailures: round ? [...(round.floorFailures || [])] : [],
    failedGateIds: round ? [...(round.failedGateIds || [])] : [],
    failureFingerprint: round?.failureFingerprint || "",
    versionLabel: version?.label || "",
    stage: version?.stage || "",
    scriptSha256: version?.scriptSha256 || "",
    contractDigest: state?.contractDigest || "",
    ...(state?.script?.pendingPanel ? { pendingPanel: panelSummary(state.script.pendingPanel) } : {}),
    ...extra,
  };
}

function waiting(state, issues, detail) {
  return { recorded: false, state, issues, detail, check: checkFor(state) };
}

/**
 * ループを始める。既に状態があれば始め直さない（restart は、止まったループだけ。続いている
 * ループを始め直せると、回数・停滞の上限を消せてしまう）。始め直しても前の状態は history に残す。
 */
export async function startScriptQualityLoop({
  workDir,
  genre = "narrated-story",
  generatorContextId,
  generatorHost = "",
  channelPack = "",
  channelConfig = "",
  restart = false,
  restartReason = "",
  env = process.env,
  now = () => new Date().toISOString(),
  loadChannel = loadScriptChannelConfig,
} = {}) {
  const paths = scriptQualityPaths(workDir);
  const spec = scriptQualityGenre(genre);
  const context = nonEmpty(generatorContextId);
  if (!CONTEXT_ID.test(context)) {
    throw new Error("--generator-context に初稿を書いた会話・タスクの ID が要ります（英数字と . _ : @ -）。この文脈は採点できない。");
  }
  const channel = await loadChannel({ channelPack, channelConfig, env, expectedHarnessId: spec.harnessId });
  const { contract, blockers } = createScriptQualityContract({ genre: spec.id, channelConfig: channel.config, channelSource: channel.source });
  if (!contract) {
    return {
      started: false,
      state: null,
      issues: blockers.map((blocker) => `script-quality-channel-config-invalid:${blocker}`),
      detail: "Channel Pack の script-quality.json に直せない値がある。黙って既定へ戻さないので、Pack を直してから始める",
    };
  }
  return withCanvasFileLock(paths.statePath, async () => {
    const existing = await readJsonIfExists(paths.statePath, null);
    let history = [];
    if (existing) {
      if (!restart) {
        return { started: false, state: existing, issues: ["script-quality-loop-already-started"], detail: "この作業フォルダのループは始まっている。record で回を足すか、止まった後に --restart で始め直す" };
      }
      if (existing.status === "active") {
        return {
          started: false,
          state: existing,
          issues: ["script-quality-loop-active-cannot-restart"],
          detail: "続いているループは始め直せない（回数と停滞の上限を消せてしまう）。合格・人待ち・上限で止まってから始め直す",
        };
      }
      const reason = sanitizeEvidence(restartReason, 500);
      if (Array.from(reason).length < 4) throw new Error("--restart には --reason で始め直す理由が要ります（何が変わったか）。");
      const { script: previousScript, ...previousCore } = existing;
      history = [
        ...(previousScript?.history || []),
        {
          archivedAt: new Date(now()).toISOString(),
          reason,
          status: existing.status,
          stopReason: existing.stopReason || "",
          contractDigest: existing.contractDigest,
          state: { ...previousCore, script: { ...previousScript, history: [] } },
        },
      ];
    }
    const core = createQualityLoopState({
      contract,
      episodeId: `script-quality:${spec.id}`,
      generatorHost: nonEmpty(generatorHost),
      generatorId: SCRIPT_GENERATOR_ID,
      generatorContextId: context,
      startedAt: now(),
    });
    const state = {
      ...core,
      script: {
        version: SCRIPT_QUALITY_STATE_VERSION,
        genre: spec.id,
        contract,
        channelSource: contract.channelSource,
        channelSpec: channel.spec,
        versions: [],
        history,
      },
    };
    await writeJsonAtomic(paths.statePath, state);
    return { started: true, state, issues: [], detail: nextStepDetail(state, paths), sheet: scriptQualityReviewSheet(contract) };
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
 * 1つの版の採点を記録する。組の評価者が1人（既定）なら、その採点で1回が閉じる（今までと同じ）。
 * Channel Pack が評価者を宣言していれば、採点は組に入り、宣言した評価者が全員そろった時点で1回として閉じる。
 * 例外は入力の形が壊れているときだけで、人の判断や直しが要る状態は issues で返す（recorded: false）。
 *
 * 組に入れないもの: 別の版（台本 SHA 違い）の採点・その版を作った文脈・前の回か組の中で使った評価文脈・
 * 宣言に無い評価者・同じ評価者の2件目・組の中の別の評価と同じ所見。
 * 組が開いている間の record は --review だけでよい（版・工程・台本は組を開いた記録のものを使う）。
 */
export async function recordScriptQualityRound({
  workDir,
  scriptPath = "",
  versionLabel = "",
  stage = "",
  reviewPath,
  producerContexts = [],
  externalCallIds = [],
  baseVersion = "",
  revisionDelta = "",
  blockingCondition = "",
  cost = 0,
  ledgerPath = "",
  env = process.env,
  now = () => new Date().toISOString(),
  loadChannel = loadScriptChannelConfig,
  captureLearning = null,
} = {}) {
  const paths = scriptQualityPaths(workDir);
  const stageName = nonEmpty(stage);
  if (stageName && !SCRIPT_STAGES.includes(stageName)) throw new Error(`--stage は ${SCRIPT_STAGES.join(" / ")} のどれかにしてください。`);
  const label = nonEmpty(versionLabel);
  if (label && !LABEL.test(label)) throw new Error("--version に版の名前（英数字と . _ -、64文字まで）が要ります。");
  const script = nonEmpty(scriptPath) ? insideWorkDir(paths.workDir, scriptPath, "--script") : null;
  const reviewFile = insideWorkDir(paths.workDir, reviewPath, "--review");
  const producers = [...new Set(producerContexts.map((value) => nonEmpty(value)).filter(Boolean))];
  for (const producer of producers) {
    if (!CONTEXT_ID.test(producer)) throw new Error("--producer-context は会話・タスクの ID（英数字と . _ : @ -）にしてください。");
  }
  const callIds = [...new Set(externalCallIds.map((value) => nonEmpty(value)).filter(Boolean))];
  for (const id of callIds) if (!isExternalCallId(id)) throw new Error(`--external-call の id の形が違います: ${id}`);
  const base = nonEmpty(baseVersion);
  if (base && !LABEL.test(base)) throw new Error("--base-version は版の名前にしてください。");

  return withCanvasFileLock(paths.statePath, async () => {
    const existing = await readJsonIfExists(paths.statePath, null);
    if (!existing?.script) return waiting(null, ["script-quality-loop-not-started"], "先に start でループを始める");
    const genreSpec = scriptQualityGenre(existing.script.genre);

    // 契約は走行中に変えない。Pack の設定が変わっていれば、同じループとして続けない。
    // 採点に使うのは状態ファイルに写した契約ではなく、いま作り直した契約（digest が一致したもの）。
    // 状態ファイルの写しを書き換えて評価項目や下限を緩める道を残さないため。
    let contract = null;
    try {
      const channel = await loadChannel({ ...channelArgsFromSpec(existing.script.channelSpec), env, expectedHarnessId: genreSpec.harnessId });
      contract = createScriptQualityContract({ genre: genreSpec.id, channelConfig: channel.config, channelSource: channel.source }).contract;
    } catch (error) {
      return waiting(existing, ["script-quality-channel-config-unavailable"], `始めたときの Channel Pack の設定を読み直せない: ${sanitizeEvidence(error?.message || String(error), 300)}`);
    }
    if (!contract || contract.digest !== existing.contractDigest) {
      return waiting(existing, ["script-quality-contract-changed"], "このループは別の契約（評価項目・下限・上限・Pack の設定）で始まっている。続けるか始め直すかは人が決める");
    }

    const scriptInfo = script ? await inspectScript(script.full) : null;
    const reviewBytes = await readFile(reviewFile.full);
    const reviewSha256 = sha256(reviewBytes);
    let review;
    try {
      review = JSON.parse(reviewBytes.toString("utf8"));
    } catch {
      return waiting(existing, ["script-quality-review-unreadable"], "採点ファイルが JSON として読めない");
    }
    const versions = existing.script.versions || [];
    const pending = existing.script.pendingPanel || null;

    // 同じ採点で既に記録した回・組に入れた採点なら、記録し直さずにその結果を返す（再実行・二重起動）。
    if (pending && (pending.reviews || []).some((row) => row.reviewSha256 === reviewSha256)) {
      return { recorded: false, alreadyRecorded: true, pending: true, state: existing, issues: issuesFromState(existing), detail: nextStepDetail(existing, paths), check: checkFor(existing) };
    }
    const previousVersion = lastOf(versions);
    if (previousVersion
      && versionReviewShas(previousVersion).includes(reviewSha256)
      && (!scriptInfo || previousVersion.scriptSha256 === scriptInfo.sha256)) {
      return { recorded: false, alreadyRecorded: true, state: existing, issues: issuesFromState(existing), detail: nextStepDetail(existing, paths), check: checkFor(existing) };
    }
    if (existing.status === "passed") {
      const changed = previousVersion && scriptInfo && previousVersion.scriptSha256 !== scriptInfo.sha256;
      return waiting(
        existing,
        ["script-quality-loop-already-passed", ...(changed ? ["script-quality-script-changed-after-pass"] : [])],
        "このループは合格で止まっている。台本を変えたなら、start --restart --reason \"何を変えたか\" で新しいループを始める",
      );
    }
    if (existing.status !== "active") return waiting(existing, issuesFromState(existing), nextStepDetail(existing, paths));

    const context = { existing, contract, paths, review, reviewSha256, reviewFile };
    if (pending) {
      return joinPanel({
        ...context, pending, scriptInfo, label, stageName, producers, callIds, now, captureLearning,
      });
    }
    if (!stageName) throw new Error(`--stage は ${SCRIPT_STAGES.join(" / ")} のどれかにしてください。`);
    if (!label) throw new Error("--version に版の名前（英数字と . _ -、64文字まで）が要ります。");
    if (!script) throw new Error("--script が要ります。");

    if (versions.some((row) => row.label === label)) {
      return waiting(existing, [`script-quality-version-label-reused:${label}`], "版の名前は回ごとに変える（同じ名前の版は既に採点した）");
    }
    const sameText = versions.find((row) => row.scriptSha256 === scriptInfo.sha256);
    if (sameText) {
      return waiting(existing, [`script-quality-script-unchanged:${sameText.label}`], `この台本は版 ${sameText.label} と同じバイト列。直していない版を別の評価者に採点し直させない`);
    }
    if (review?.scriptSha256 !== scriptInfo.sha256) {
      return waiting(existing, ["script-quality-review-script-mismatch"], "採点ファイルの scriptSha256 が今の台本と違う。今の台本を採点し直す");
    }
    let baseRow = null;
    if (stageName !== "draft") {
      baseRow = base ? versions.find((row) => row.label === base) : previousVersion;
      if (base && !baseRow) return waiting(existing, [`script-quality-base-version-unknown:${base}`], "--base-version の版はこのループに無い");
      if (baseRow) {
        if (!SHA256.test(String(review?.baseScriptSha256 || ""))) {
          return waiting(existing, ["script-quality-review-base-missing"], `前の版（${baseRow.label}）と比べて採点したことを baseScriptSha256 に書く（意味の保持は前の版との比較で決まる）`);
        }
        if (review.baseScriptSha256 !== baseRow.scriptSha256) {
          return waiting(existing, ["script-quality-review-base-mismatch"], `採点ファイルの baseScriptSha256 が前の版（${baseRow.label}）と違う`);
        }
      }
    }

    // 外部モデルの呼び出しを台帳から引く。呼んだ文脈も「作った文脈」に数える。
    const ledger = nonEmpty(ledgerPath) ? resolve(ledgerPath) : paths.externalCallLedgerPath;
    const calls = callIds.length > 0 ? await findExternalCalls(ledger, callIds) : new Map();
    const producerContextsAll = [...new Set([existing.generatorContextId, ...producers, ...[...calls.values()].map((row) => row.callerSession)].filter(Boolean))];
    const panelDraft = {
      declaredEvaluators: panelEvaluators(contract),
      producerContextsAll,
      reviews: [],
    };
    const rejected = validatePanelReview({ ...context, panel: panelDraft });
    if (rejected) return rejected;

    // 機械ゲート（ファイルと台帳だけから決まる）。
    const missingCalls = callIds.filter((id) => !calls.has(id));
    const gates = {
      "script-readable": scriptInfo.readable,
      "external-call-recorded": missingCalls.length === 0 && (stageName !== "external-rewrite" || callIds.length > 0),
      "external-calls-complete": [...calls.values()].every((row) => row.status === "complete"),
    };
    const failedGateIds = contract.machineGates.filter((id) => gates[id] !== true).sort();

    let revision = {};
    if ((existing.rounds || []).length > 0) {
      const expected = lastOf(existing.rounds).failureFingerprint;
      let text = sanitizeEvidence(revisionDelta);
      if (!text) {
        const delta = await readJsonIfExists(paths.revisionDeltaPath, null).catch(() => null);
        if (nonEmpty(delta?.previousFailureFingerprint) === expected) text = sanitizeEvidence(delta?.revisionDelta);
      }
      if (Array.from(text).length < 4) {
        return waiting(existing, [`script-quality-revision-delta-required:${expected}`], nextStepDetail(existing, paths));
      }
      revision = { previousFailureFingerprint: expected, revisionDelta: text };
    }

    const panel = {
      versionLabel: label,
      stage: stageName,
      scriptPath: script.rel,
      scriptSha256: scriptInfo.sha256,
      scriptBytes: scriptInfo.bytes,
      nonEmptyLines: scriptInfo.nonEmptyLines,
      ...(baseRow ? { baseVersion: baseRow.label, baseScriptSha256: baseRow.scriptSha256, baseScriptPath: baseRow.scriptPath } : {}),
      producerContexts: producers,
      producerContextsAll,
      externalCalls: callIds.map((id) => {
        const row = calls.get(id);
        return row
          ? { id, status: row.status, host: row.host, model: row.model, callerSession: row.callerSession, outputSha256: row.output?.sha256 || null, inputSha256: row.input?.sha256 || null }
          : { id, status: "missing" };
      }),
      machineGates: gates,
      failedGateIds,
      revision,
      blockingCondition: sanitizeEvidence(blockingCondition),
      cost: Math.max(0, Number(cost) || 0),
      declaredEvaluators: panelDraft.declaredEvaluators,
      openedAt: new Date(now()).toISOString(),
      reviews: [panelReviewEntry({ review, reviewFile, reviewSha256 })],
    };
    return settlePanel({ existing, contract, paths, panel, now, captureLearning });
  });
}

function versionReviewShas(version) {
  const rows = Array.isArray(version?.reviews) ? version.reviews.map((row) => row.reviewSha256) : [];
  return [...new Set([nonEmpty(version?.reviewSha256), ...rows].filter(Boolean))];
}

function panelReviewEntry({ review, reviewFile, reviewSha256 }) {
  return {
    evaluatorId: nonEmpty(review.evaluatorId),
    evaluatorContextId: nonEmpty(review.evaluatorContextId),
    evaluatorHost: nonEmpty(review.evaluatorHost),
    reviewPath: reviewFile.rel,
    reviewSha256,
    rubricScores: { ...review.rubricScores },
    notes: sanitizeEvidence(review.notes),
    findings: (Array.isArray(review.findings) ? review.findings : []),
    blockingCondition: sanitizeEvidence(review.blockingCondition),
  };
}

/**
 * 組に入れてよい採点かを確かめる。入れてよければ null、だめなら人待ちの結果を返す。
 * 評価者の独立（作った文脈でない・前の回でも組の中でも使っていない文脈）・宣言した評価者・
 * 全項目の点・所見・前の回や組の中の写しでない所見を見る。
 */
function validatePanelReview({ existing, contract, review, panel }) {
  const evaluatorId = nonEmpty(review?.evaluatorId);
  const evaluatorContextId = nonEmpty(review?.evaluatorContextId);
  if (!evaluatorId || !CONTEXT_ID.test(evaluatorContextId)) {
    return waiting(existing, ["script-quality-review-evaluator-missing"], "採点ファイルに evaluatorId と evaluatorContextId（評価した会話・タスクの ID）が要る");
  }
  if (evaluatorId === SCRIPT_GENERATOR_ID || panel.producerContextsAll.includes(evaluatorContextId)) {
    return waiting(existing, ["script-quality-evaluator-not-independent"], "この版を作った文脈（初稿の文脈・作り手・外部モデルを呼んだ文脈）は採点できない。別の文脈で採点する");
  }
  const usedContexts = new Set((existing.rounds || []).flatMap((round) => (round.reviews || []).map((row) => row.evaluatorContextId)));
  if (usedContexts.has(evaluatorContextId)) {
    return waiting(existing, ["script-quality-fresh-review-required"], "この評価文脈は前の回で採点している。回ごとに新しい文脈で採点する");
  }
  if (panel.reviews.some((row) => row.evaluatorContextId === evaluatorContextId)) {
    return waiting(existing, ["script-quality-panel-context-reused"], "この評価文脈は同じ組で既に採点している。組の評価者はそれぞれ別の文脈で採点する");
  }
  const declared = panel.declaredEvaluators || [];
  if (declared.length > 0 && !declared.includes(evaluatorId)) {
    return waiting(existing, [`script-quality-panel-evaluator-undeclared:${evaluatorId}`], `この組の評価者は ${declared.join(", ")}（Channel Pack の宣言）。宣言に無い評価者の採点は組に入れない`);
  }
  if (panel.reviews.some((row) => row.evaluatorId === evaluatorId)) {
    return waiting(existing, [`script-quality-panel-evaluator-duplicate:${evaluatorId}`], `評価者 ${evaluatorId} はこの組で既に採点している。同じ評価者の2件目は組に入れない`);
  }
  const scoreProblems = validateReviewScores(review, contract);
  if (scoreProblems.length > 0) {
    return waiting(existing, scoreProblems.map((problem) => `script-quality-review-${problem}`), `採点ファイルの rubricScores は全項目（${contract.rubric.map((row) => row.id).join(", ")}）を 0〜100 で埋める`);
  }
  const notes = sanitizeEvidence(review.notes);
  if (Array.from(notes).length < 4) return waiting(existing, ["script-quality-review-notes-required"], "採点ファイルの notes に、何を読んで何を見たかを書く");
  const stale = findStaleQualityFeedback({ state: existing, reviews: [{ notes, evaluatorContextId }] });
  if (stale) return waiting(existing, [`script-quality-${stale.reasonCode}`], stale.detail);
  const normalized = normalizeNotes(notes);
  if (panel.reviews.some((row) => normalizeNotes(row.notes) === normalized)) {
    return waiting(existing, ["script-quality-panel-notes-duplicated"], "組の中の別の評価と同じ所見。評価者ごとに、自分で読んだ所見を書く");
  }
  return null;
}

function normalizeNotes(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/\s+/gu, "");
}

/** 組が開いている版に、別の評価者の採点を足す。全員そろえば1回として閉じる。 */
async function joinPanel({
  existing, contract, paths, review, reviewSha256, reviewFile, pending, scriptInfo, label, stageName, producers, callIds, now, captureLearning,
}) {
  const mismatch = (label && label !== pending.versionLabel)
    || (stageName && stageName !== pending.stage)
    || (scriptInfo && scriptInfo.sha256 !== pending.scriptSha256)
    || review?.scriptSha256 !== pending.scriptSha256;
  if (mismatch) {
    return waiting(existing, ["script-quality-panel-version-mismatch"], `評価の組は版 ${pending.versionLabel}（台本 ${pending.scriptSha256.slice(0, 12)}）を採点している。別の版の採点は組に入れない`);
  }
  const extraProducers = producers.filter((id) => !pending.producerContexts.includes(id));
  const extraCalls = callIds.filter((id) => !pending.externalCalls.some((row) => row.id === id));
  if (extraProducers.length > 0 || extraCalls.length > 0) {
    return waiting(existing, ["script-quality-panel-inputs-differ"], "組に入る採点では、作った文脈と外部モデルの呼び出しは組を開いた記録のものを使う（足せない）");
  }
  if (pending.baseScriptSha256 && review?.baseScriptSha256 !== pending.baseScriptSha256) {
    return waiting(existing, [review?.baseScriptSha256 ? "script-quality-review-base-mismatch" : "script-quality-review-base-missing"], `前の版（${pending.baseVersion}）と比べて採点したことを baseScriptSha256 に書く`);
  }
  const rejected = validatePanelReview({ existing, contract, review, panel: pending });
  if (rejected) return rejected;
  const panel = { ...pending, reviews: [...pending.reviews, panelReviewEntry({ review, reviewFile, reviewSha256 })] };
  return settlePanel({ existing, contract, paths, panel, now, captureLearning });
}

/** 組が全員そろっていれば1回として閉じ、そろっていなければ組を状態に残す。 */
async function settlePanel({ existing, contract, paths, panel, now, captureLearning }) {
  if (panel.reviews.length < panelSize(contract)) {
    const next = { ...existing, script: { ...existing.script, pendingPanel: panel } };
    await writeJsonAtomic(paths.statePath, next);
    return {
      recorded: false,
      panelAccepted: true,
      state: next,
      panel: panelSummary(panel),
      issues: issuesFromState(next),
      detail: `採点を版 ${panel.versionLabel} の評価の組に入れた（${panel.reviews.length}/${panelSize(contract)}）。${nextStepDetail(next, paths)}`,
      check: checkFor(next),
    };
  }
  return closePanel({ existing, contract, paths, panel, now, captureLearning });
}

async function closePanel({ existing, contract, paths, panel, now, captureLearning }) {
  const observedAt = now();
  const scriptRow = { path: panel.scriptPath, sha256: panel.scriptSha256, note: `この回に採点した台本（版 ${panel.versionLabel}・${panel.stage}）` };
  const reviewShas = panel.reviews.map((row) => row.reviewSha256);
  const reviewDigest = reviewShas.length === 1 ? reviewShas[0] : sha256(canonicalJson([...reviewShas].sort()));
  const evidence = [
    scriptRow,
    ...panel.reviews.map((row) => ({
      path: row.reviewPath,
      sha256: row.reviewSha256,
      note: panel.reviews.length === 1
        ? "別の評価文脈の採点ファイル（評価項目の点数つき）"
        : `別の評価文脈の採点ファイル（評価者 ${row.evaluatorId}、評価項目の点数つき）`,
    })),
    ...(panel.baseScriptSha256 ? [{ path: panel.baseScriptPath, sha256: panel.baseScriptSha256, note: `意味の保持を比べた前の版（${panel.baseVersion}）` }] : []),
    ...panel.externalCalls.filter((row) => row.status !== "missing").map((row) => ({
      path: `external-call:${row.id}`,
      sha256: row.outputSha256 || row.inputSha256,
      note: `外部モデル呼び出しの記録（${row.host}/${row.model}、状態 ${row.status}）`,
    })),
  ];
  const { pendingPanel: _closed, ...scriptRest } = existing.script;
  const stateForCore = { ...existing, script: scriptRest };
  let recorded;
  try {
    recorded = recordQualityRound({
      contract,
      state: stateForCore,
      hardGateReport: { pass: panel.failedGateIds.length === 0, failedGateIds: panel.failedGateIds, contractDigest: contract.digest },
      reviews: panel.reviews.map((row) => ({
        evaluatorId: row.evaluatorId,
        evaluatorContextId: row.evaluatorContextId,
        evaluatorHost: row.evaluatorHost,
        scores: row.rubricScores,
        notes: row.notes,
        evidence: [scriptRow],
      })),
      evidence,
      reviewDigest,
      cost: panel.cost,
      observedAt,
      blockingCondition: panel.blockingCondition || panel.reviews.map((row) => row.blockingCondition).find(Boolean) || "",
      ...panel.revision,
    });
  } catch (error) {
    return waiting(existing, ["script-quality-round-rejected"], `この採点は品質ループの回として記録できない: ${sanitizeEvidence(error?.message || String(error), 300)}`);
  }
  const findings = panel.reviews.flatMap((row) => row.findings)
    .map((entry) => sanitizeEvidence(typeof entry === "string" ? entry : entry?.text, 500))
    .filter(Boolean)
    .slice(0, 50);
  const version = {
    round: recorded.rounds.length,
    label: panel.versionLabel,
    stage: panel.stage,
    scriptPath: panel.scriptPath,
    scriptSha256: panel.scriptSha256,
    scriptBytes: panel.scriptBytes,
    nonEmptyLines: panel.nonEmptyLines,
    reviewPath: panel.reviews[0].reviewPath,
    reviewSha256: panel.reviews[0].reviewSha256,
    ...(panel.baseScriptSha256 ? { baseVersion: panel.baseVersion, baseScriptSha256: panel.baseScriptSha256 } : {}),
    producerContexts: panel.producerContexts,
    externalCalls: panel.externalCalls.map((row) => (row.status === "missing"
      ? { id: row.id, status: "missing" }
      : { id: row.id, status: row.status, host: row.host, model: row.model, outputSha256: row.outputSha256 })),
    machineGates: panel.machineGates,
    // 項目ごとの点（組なら評価者の平均）。学習の自動捕捉が「どの項目が低かったか」を本文なしで言うのに使う。
    rubricScores: Object.fromEntries(contract.rubric.map((row) => [
      row.id,
      Number((panel.reviews.reduce((sum, entry) => sum + entry.rubricScores[row.id], 0) / panel.reviews.length).toFixed(3)),
    ])),
    reviews: panel.reviews.map((row) => ({
      evaluatorId: row.evaluatorId,
      evaluatorContextId: row.evaluatorContextId,
      evaluatorHost: row.evaluatorHost,
      reviewPath: row.reviewPath,
      reviewSha256: row.reviewSha256,
      rubricScores: Object.fromEntries(contract.rubric.map((criterion) => [criterion.id, row.rubricScores[criterion.id]])),
    })),
    findings,
    recordedAt: new Date(observedAt).toISOString(),
  };
  const next = { ...recorded, script: { ...recorded.script, versions: [...(recorded.script.versions || []), version] } };
  await writeJsonAtomic(paths.statePath, next);
  const stateSha256 = sha256(await readFile(paths.statePath));
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
  const label = panel.versionLabel;
  return {
    recorded: true,
    state: next,
    round,
    version,
    issues: issuesFromState(next),
    detail: next.status === "passed"
      ? `品質ループ ${next.rounds.length} 回目（版 ${label}）で合格（${round.score} ≥ ${contract.limits.targetScore}、下限割れなし、機械ゲート全通過）`
      : `品質ループ ${next.rounds.length} 回目（版 ${label}）は不合格（${round.score}/${contract.limits.targetScore}`
        + `${round.floorFailures.length ? `、下限割れ: ${round.floorFailures.join(", ")}` : ""}`
        + `${round.failedGateIds.length ? `、落ちた機械ゲート: ${round.failedGateIds.join(", ")}` : ""}`
        + `${round.acceptance?.failures?.length ? `、受け入れ方: ${round.acceptance.failures.join(", ")}` : ""}）。${nextStepDetail(next, paths)}`,
    check: checkFor(next, { stateSha256 }),
    learning,
  };
}

/**
 * 今の状態。deliverable は「合格していて、合格した版の台本ファイルが今も同じバイト列」のときだけ true。
 */
export async function scriptQualityStatus({ workDir } = {}) {
  const paths = scriptQualityPaths(workDir);
  const state = await readJsonIfExists(paths.statePath, null);
  if (!state?.script) {
    return { started: false, deliverable: false, issues: ["script-quality-loop-not-started"], detail: nextStepDetail(null, paths), check: checkFor(null) };
  }
  const version = lastOf(state.script.versions);
  let currentSha256 = "";
  if (version) {
    try {
      currentSha256 = sha256(await readFile(resolve(paths.workDir, version.scriptPath)));
    } catch {
      currentSha256 = "";
    }
  }
  const unchanged = Boolean(version) && currentSha256 === version.scriptSha256;
  const issues = issuesFromState(state);
  if (version && !unchanged) issues.push(currentSha256 ? "script-quality-script-changed-after-review" : "script-quality-script-missing");
  const deliverable = state.status === "passed" && unchanged;
  return {
    started: true,
    deliverable,
    state,
    issues,
    detail: nextStepDetail(state, paths),
    check: checkFor(state, { currentScriptSha256: currentSha256, scriptUnchangedSinceReview: unchanged }),
    sheet: scriptQualityReviewSheet(state.script.contract),
    rounds: (state.rounds || []).map((round, index) => ({
      index: round.index,
      version: state.script.versions[index]?.label || "",
      stage: state.script.versions[index]?.stage || "",
      score: round.score,
      floorFailures: round.floorFailures,
      failedGateIds: round.failedGateIds,
      failureFingerprint: round.failureFingerprint,
      evaluatorContextId: round.reviews?.[0]?.evaluatorContextId || "",
    })),
  };
}

/** 評価者へ渡す採点ファイルの雛形。scriptSha256 と baseScriptSha256 はここで計算して埋める。 */
export async function scriptQualityReviewTemplate({ workDir, scriptPath, baseVersion = "", stage = "draft" } = {}) {
  const paths = scriptQualityPaths(workDir);
  const state = await readJsonIfExists(paths.statePath, null);
  if (!state?.script) throw new Error("先に start でループを始めてください。");
  const script = insideWorkDir(paths.workDir, scriptPath, "--script");
  const info = await inspectScript(script.full);
  const versions = state.script.versions || [];
  const baseRow = stage === "draft" ? null : (nonEmpty(baseVersion) ? versions.find((row) => row.label === baseVersion) : lastOf(versions));
  return {
    sheet: scriptQualityReviewSheet(state.script.contract),
    template: {
      evaluatorId: "<評価者の名前（作る係の script-writer は不可）>",
      evaluatorContextId: "<この採点をする会話・タスクの ID（作った文脈・前の回の文脈は不可）>",
      evaluatorHost: "<claude-code|codex|human>",
      scriptSha256: info.sha256,
      ...(baseRow ? { baseScriptSha256: baseRow.scriptSha256 } : {}),
      rubricScores: Object.fromEntries(state.script.contract.rubric.map((row) => [row.id, null])),
      notes: "<何を読んで、何を見たか>",
      findings: [],
    },
  };
}
