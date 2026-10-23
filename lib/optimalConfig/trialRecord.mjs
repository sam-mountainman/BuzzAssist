// 10カット試験の記録——候補2〜3案を同じ10カット（典型5＋難しい5）で比べ、数字で決める。
//
// 1カット1候補ごとに残す欄は、動画生成 総合ガイド p18 の「試験記録の最小項目」と同じ:
//   カットID／用途／画風／入力素材ID／入力モード／固定条件／台詞・音声の有無／モデルと checkpoint の版／
//   実行環境の版／GPU・VRAM・RAM／解像度・尺・fps／step・CFG・量子化・LoRA／初回準備の時間／
//   生成の待ち時間／人の操作時間／現金の費用／生成した秒数／採用した秒数／不採用の理由／修正時間／
//   公開権の確認先／素材の送信先
// 比べる数字:
//   採用秒率 = 採用した秒数 ÷ 生成した秒数
//   採用1秒あたりの現金 = 現金の費用 ÷ 採用した秒数
//   採用1秒あたりの人の時間 = （人の操作時間＋修正時間）÷ 採用した秒数（分／秒）
// 初回準備の時間は別に合計する（1回だけの費用を毎カットに混ぜない）。
//
// RunReceipt へは、必要なときだけ configTrial 欄として足す（attachTrialToRunReceipt）。
// 既存の RunReceipt にこの欄は無く、無いことは「試験をしなかった」であって壊れではない。

import { createHash } from "node:crypto";

export const TRIAL_RECORD_VERSION = "optimal-config-trial-v1";
export const TRIAL_CUT_COUNT = 10;
export const TRIAL_TYPICAL_CUTS = 5;
export const TRIAL_HARD_CUTS = 5;

export const INPUT_MODES = Object.freeze(["t2i", "i2i", "multi-ref", "inpaint", "t2v", "i2v", "flf2v", "s2v", "edit-only"]);

/** p18 の最小項目（結果の欄名）。この順で並べ、欠けていれば止める。 */
export const TRIAL_RESULT_FIELDS = Object.freeze([
  "cutId", "candidateId", "purpose", "style", "inputAssetIds", "inputMode", "fixedConditions", "dialogueAudio",
  "model", "runtime", "hardware", "output", "params", "setupMinutes", "waitSeconds", "humanMinutes",
  "cashCostJpy", "generatedSeconds", "adoptedSeconds", "rejectionReason", "fixMinutes", "rightsCheckSource", "dataDestination",
]);

const FIELD_LABELS = {
  cutId: "カットID", candidateId: "候補ID", purpose: "用途", style: "画風", inputAssetIds: "入力素材ID", inputMode: "入力モード",
  fixedConditions: "固定条件", dialogueAudio: "台詞・音声の有無", model: "モデルと checkpoint の版", runtime: "実行環境の版",
  hardware: "GPU・VRAM・RAM", output: "解像度・尺・fps", params: "step・CFG・量子化・LoRA", setupMinutes: "初回準備の時間（分）",
  waitSeconds: "生成の待ち時間（秒）", humanMinutes: "人の操作時間（分）", cashCostJpy: "現金の費用（円）", generatedSeconds: "生成した秒数",
  adoptedSeconds: "採用した秒数", rejectionReason: "不採用の理由", fixMinutes: "修正時間（分）", rightsCheckSource: "公開権の確認先",
  dataDestination: "素材の送信先",
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * 試験の段取り（結果はまだ空）を作る。cuts は典型5＋難しい5。
 * candidates は selectConfig の candidates をそのまま渡せる。
 */
export function createTrialPlan({ channelId, candidates = [], cuts = [], createdAt = new Date().toISOString() } = {}) {
  if (!nonEmpty(channelId)) throw new Error("試験の記録には channelId が要る。");
  const plannedCandidates = candidates.map((candidate) => ({
    candidateId: String(candidate.id ?? candidate.candidateId ?? ""),
    label: String(candidate.label ?? ""),
    videoConfigs: candidate.videoConfigs ?? null,
    imageWorkflows: Array.isArray(candidate.imageWorkflows) ? [...candidate.imageWorkflows] : [],
    models: candidate.models ?? null,
    runtimePlaces: Array.isArray(candidate.runtimePlaces) ? [...candidate.runtimePlaces] : [],
  }));
  const plannedCuts = cuts.length > 0 ? cuts.map((cut) => ({ ...cut })) : [
    ...Array.from({ length: TRIAL_TYPICAL_CUTS }, (_, index) => ({ cutId: `typical-${index + 1}`, kind: "typical", purpose: "", mustHave: [], targetSeconds: null, allowedFixMinutes: null, budgetCapJpy: null })),
    ...Array.from({ length: TRIAL_HARD_CUTS }, (_, index) => ({ cutId: `hard-${index + 1}`, kind: "hard", purpose: "", mustHave: [], targetSeconds: null, allowedFixMinutes: null, budgetCapJpy: null })),
  ];
  return {
    version: TRIAL_RECORD_VERSION,
    channelId,
    createdAt,
    candidates: plannedCandidates,
    cuts: plannedCuts,
    results: [],
  };
}

/** 1カット1候補の結果を検査する。足りない欄は日本語で返す。 */
export function validateTrialResult(result) {
  const errors = [];
  const push = (field, message) => errors.push({ field, message: `${FIELD_LABELS[field] || field}: ${message}` });
  if (!isPlainObject(result)) return { ok: false, errors: [{ field: "", message: "結果が JSON のオブジェクトではない。" }] };
  for (const field of TRIAL_RESULT_FIELDS) {
    if (!(field in result)) push(field, "欄が無い（分からなければ null と書き、空欄のまま埋めない）。");
  }
  if ("cutId" in result && !nonEmpty(result.cutId)) push("cutId", "空にしない。");
  if ("candidateId" in result && !nonEmpty(result.candidateId)) push("candidateId", "空にしない。");
  if ("inputAssetIds" in result && !Array.isArray(result.inputAssetIds)) push("inputAssetIds", "素材 ID の配列にする。");
  if ("inputMode" in result && !INPUT_MODES.includes(result.inputMode)) push("inputMode", `${INPUT_MODES.join(" / ")} のどれか。`);
  if ("fixedConditions" in result && !Array.isArray(result.fixedConditions)) push("fixedConditions", "固定した条件の配列にする。");
  if ("dialogueAudio" in result && (!isPlainObject(result.dialogueAudio) || typeof result.dialogueAudio.dialogue !== "boolean" || typeof result.dialogueAudio.audio !== "boolean")) {
    push("dialogueAudio", "{ dialogue: true/false, audio: true/false } の形。");
  }
  if ("model" in result && (!isPlainObject(result.model) || !nonEmpty(result.model.id) || !("checkpointVersion" in result.model))) {
    push("model", "{ id, checkpointVersion } の形（版が分からなければ checkpointVersion: null）。");
  }
  if ("runtime" in result && (!isPlainObject(result.runtime) || !nonEmpty(result.runtime.name) || !("version" in result.runtime))) {
    push("runtime", "{ name, version, place } の形。");
  }
  if ("hardware" in result && (!isPlainObject(result.hardware) || !("gpu" in result.hardware) || !("vramGiB" in result.hardware) || !("ramGiB" in result.hardware))) {
    push("hardware", "{ gpu, vramGiB, ramGiB } の形（Mac なら gpu に機種、vramGiB は null）。");
  }
  if ("output" in result && (!isPlainObject(result.output) || !("resolution" in result.output) || !("durationSeconds" in result.output) || !("fps" in result.output))) {
    push("output", "{ resolution, durationSeconds, fps } の形（静止画なら fps は null）。");
  }
  if ("params" in result && (!isPlainObject(result.params) || !("steps" in result.params) || !("cfg" in result.params) || !("quantization" in result.params) || !Array.isArray(result.params.loras))) {
    push("params", "{ steps, cfg, quantization, loras: [] } の形。");
  }
  for (const field of ["setupMinutes", "waitSeconds", "humanMinutes", "cashCostJpy", "generatedSeconds", "adoptedSeconds", "fixMinutes"]) {
    if (field in result && !nonNegative(result[field])) push(field, "0 以上の数。");
  }
  if (nonNegative(result.generatedSeconds) && nonNegative(result.adoptedSeconds) && result.adoptedSeconds > result.generatedSeconds) {
    push("adoptedSeconds", "生成した秒数より多くは採用できない。");
  }
  if (nonNegative(result.adoptedSeconds) && nonNegative(result.generatedSeconds) && result.adoptedSeconds < result.generatedSeconds && !nonEmpty(result.rejectionReason)) {
    push("rejectionReason", "採用しなかった秒数があるので、理由を書く。");
  }
  if ("rejectionReason" in result && result.rejectionReason !== null && typeof result.rejectionReason !== "string") push("rejectionReason", "文字列か null。");
  if ("rightsCheckSource" in result && !nonEmpty(result.rightsCheckSource)) push("rightsCheckSource", "どこで公開権を確かめたか（構成表の版・規約の URL など）を書く。");
  if ("dataDestination" in result && !nonEmpty(result.dataDestination)) push("dataDestination", "素材の送信先を書く（手元だけなら local）。");
  return { ok: errors.length === 0, errors };
}

/** 試験の記録に結果を1件足す（検査を通らなければ止める）。 */
export function addTrialResult(trial, result) {
  if (trial?.version !== TRIAL_RECORD_VERSION) throw new Error(`試験の記録の版が違う（${TRIAL_RECORD_VERSION} を期待）。`);
  const { ok, errors } = validateTrialResult(result);
  if (!ok) throw new Error(`10カット試験の結果が足りない:\n${errors.map((item) => `- ${item.message}`).join("\n")}`);
  if (!trial.cuts.some((cut) => cut.cutId === result.cutId)) throw new Error(`段取りに無いカット: ${result.cutId}`);
  if (!trial.candidates.some((candidate) => candidate.candidateId === result.candidateId)) throw new Error(`段取りに無い候補: ${result.candidateId}`);
  if (trial.results.some((row) => row.cutId === result.cutId && row.candidateId === result.candidateId)) {
    throw new Error(`同じカット・同じ候補の結果が既にある: ${result.cutId} / ${result.candidateId}（やり直しは別の試験として記録する）`);
  }
  trial.results.push({ ...result });
  return trial;
}

function ratio(numerator, denominator) {
  return denominator > 0 ? Math.round((numerator / denominator) * 10_000) / 10_000 : null;
}

/** 候補ごとの比べる数字。カットが10本そろっていない候補は complete: false。 */
export function computeTrialMetrics(trial) {
  const cutIds = new Set((trial?.cuts || []).map((cut) => cut.cutId));
  return (trial?.candidates || []).map(({ candidateId, label }) => {
    const rows = (trial.results || []).filter((row) => row.candidateId === candidateId);
    const sum = (field) => rows.reduce((total, row) => total + (nonNegative(row[field]) ? row[field] : 0), 0);
    const generated = sum("generatedSeconds");
    const adopted = sum("adoptedSeconds");
    const cash = sum("cashCostJpy");
    const human = sum("humanMinutes") + sum("fixMinutes");
    const rejectionReasons = {};
    for (const row of rows) {
      if (nonEmpty(row.rejectionReason)) rejectionReasons[row.rejectionReason] = (rejectionReasons[row.rejectionReason] || 0) + 1;
    }
    const covered = new Set(rows.map((row) => row.cutId));
    return {
      candidateId,
      label,
      cutsRecorded: covered.size,
      complete: cutIds.size === TRIAL_CUT_COUNT && [...cutIds].every((id) => covered.has(id)),
      generatedSeconds: generated,
      adoptedSeconds: adopted,
      adoptedSecondRate: ratio(adopted, generated),
      cashPerAdoptedSecondJpy: ratio(cash, adopted),
      humanMinutesPerAdoptedSecond: ratio(human, adopted),
      totalCashJpy: cash,
      totalHumanMinutes: human,
      setupMinutes: sum("setupMinutes"),
      waitSeconds: sum("waitSeconds"),
      rejectionReasons,
    };
  });
}

/**
 * 本番1案と予備1案の提案。完了した候補だけを、採用秒率（高い順）→採用1秒あたりの現金（安い順）→
 * 採用1秒あたりの人の時間（短い順）で並べる。決めるのは人（ここは提案だけ）。
 */
export function recommendFromTrial(trial) {
  const metrics = computeTrialMetrics(trial).filter((row) => row.complete && row.adoptedSeconds > 0);
  const order = (value, fallback) => (value === null ? fallback : value);
  metrics.sort((a, b) => order(b.adoptedSecondRate, -1) - order(a.adoptedSecondRate, -1)
    || order(a.cashPerAdoptedSecondJpy, Infinity) - order(b.cashPerAdoptedSecondJpy, Infinity)
    || order(a.humanMinutesPerAdoptedSecond, Infinity) - order(b.humanMinutesPerAdoptedSecond, Infinity)
    || a.candidateId.localeCompare(b.candidateId));
  return {
    production: metrics[0]?.candidateId ?? null,
    fallback: metrics[1]?.candidateId ?? null,
    note: metrics.length === 0
      ? "10カットがそろった候補がまだ無い。"
      : "提案であって決定ではない。数字と不採用の理由を見て、運営者が本番と予備を決める。",
  };
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

/**
 * RunReceipt に試験の記録を足す（configTrial 欄、任意）。finalize 済みの記録には足せない。
 * 素材 ID は digest にして残す（記録をプラットフォームへ返すときに素材の名前を出さない）。
 */
export function attachTrialToRunReceipt(receipt, trial) {
  if (!receipt || typeof receipt !== "object") throw new Error("RunReceipt が無い。");
  if (receipt.finalized) throw new Error("finalize 済みの RunReceipt に10カット試験の記録は足せない。");
  if (trial?.version !== TRIAL_RECORD_VERSION) throw new Error(`試験の記録の版が違う（${TRIAL_RECORD_VERSION} を期待）。`);
  for (const result of trial.results || []) {
    const { ok, errors } = validateTrialResult(result);
    if (!ok) throw new Error(`RunReceipt に足す前の検査で止めた:\n${errors.map((item) => `- ${item.message}`).join("\n")}`);
  }
  receipt.configTrial = {
    version: TRIAL_RECORD_VERSION,
    channelIdDigest: sha256(trial.channelId),
    createdAt: String(trial.createdAt || ""),
    candidates: trial.candidates.map(({ candidateId, label, videoConfigs, imageWorkflows, runtimePlaces, models }) => ({
      candidateId,
      label,
      videoConfigs,
      imageWorkflows,
      runtimePlaces,
      modelIds: models ? Object.values(models).filter(Boolean).map((item) => item.modelId) : [],
    })),
    cuts: trial.cuts.map(({ cutId, kind }) => ({ cutId, kind })),
    results: (trial.results || []).map((row) => ({
      ...row,
      inputAssetIds: row.inputAssetIds.map((id) => sha256(id)),
    })),
    metrics: computeTrialMetrics(trial),
    recommendation: recommendFromTrial(trial),
  };
  return receipt;
}

/** プラットフォームへ返す形（候補 ID と数字だけ）。configTrial の無い記録は null。 */
export function redactConfigTrialForPlatform(configTrial) {
  if (!configTrial || typeof configTrial !== "object") return null;
  return {
    version: String(configTrial.version || ""),
    candidateCount: Array.isArray(configTrial.candidates) ? configTrial.candidates.length : 0,
    cutCount: Array.isArray(configTrial.cuts) ? configTrial.cuts.length : 0,
    metrics: (Array.isArray(configTrial.metrics) ? configTrial.metrics : []).map((row) => ({
      candidateId: row.candidateId,
      complete: row.complete === true,
      adoptedSecondRate: row.adoptedSecondRate ?? null,
      cashPerAdoptedSecondJpy: row.cashPerAdoptedSecondJpy ?? null,
      humanMinutesPerAdoptedSecond: row.humanMinutesPerAdoptedSecond ?? null,
    })),
  };
}
