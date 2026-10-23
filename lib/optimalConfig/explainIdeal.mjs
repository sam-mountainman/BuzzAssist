// 運営者の理想と制約——理想（絵の種類・動き・固定したいもの・予算、使いたいモデル）を構成に翻訳する。
//
// 決めるのは運営者。ハーネスは理想をそのまま構成にできるかを調べ、できるなら構成を返す。できないときは
// 黙って別のものに置き換えず、理由（予算・機材・権利）と、いちばん近い代わりの案を返す。代わりの案は
// 提案で、どれにするかは運営者が選ぶ（match の config は null のまま）。
//
// 理由の種類:
//   budget    予算で動かせない（予算 0 円で借り GPU、試験の数字から見積もった月の現金が予算を超える）
//   hardware  機材・契約で動かない（Mac のメモリ、CUDA が無い、借り GPU を使わない設定、契約が無い、Mac で未確認）
//   rights    権利の関門で止まる（重みが非商用、地域の制限、外に出せない素材を外部へ送る、など）
//   catalog   構成表に無いモデル・その役目を持たないモデル
// 予算が未設定（null）なら予算では止めず、注意に出す（推定しない）。

import { findModel, loadOptimalConfigCatalog } from "./catalog.mjs";
import { ART_STYLES, IDENTITY_LOCKS, MOTIONS, assertChannelTraits } from "./channelTraits.mjs";
import { evaluateModelRights, rightsContextFromTraits } from "./rightsGate.mjs";
import { runtimeFeasibility, selectImageWorkflows, selectVideoConfigs } from "./selectConfig.mjs";
import { computeTrialMetrics } from "./trialRecord.mjs";

export const EXPLAIN_IDEAL_VERSION = "optimal-config-explain-v1";
export const IDEAL_REASON_TYPES = Object.freeze(["budget", "hardware", "rights", "catalog"]);

const SLOTS = Object.freeze({
  imagePrimary: { role: "image-primary", label: "本番の画像" },
  video: { role: "video-i2v", label: "動画のカット" },
});
const IDEAL_FIELDS = new Set(["artStyle", "motion", "identityLock", "budgetMonthlyJpy", "models", "places", "monthlyAdoptedSeconds"]);
const PLACE_SCORE = { "operator-service": 30, "operator-mac": 25, "operator-cuda": 25, "operator-rented-gpu": 10 };
const HARDWARE_CODE = {
  "operator-mac": "HARDWARE_MAC",
  "operator-cuda": "HARDWARE_CUDA",
  "operator-rented-gpu": "HARDWARE_CLOUD_GPU_OFF",
  "operator-service": "CONTRACT_MISSING",
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 理想の形を確かめる。足りない欄は traits の値のまま（理想は traits の上に重ねる差分）。 */
export function validateIdeal(ideal) {
  const errors = [];
  if (!isPlainObject(ideal)) return ["理想（ideal）が JSON のオブジェクトではない。"];
  for (const key of Object.keys(ideal)) if (!IDEAL_FIELDS.has(key)) errors.push(`知らない欄 ${key}（${[...IDEAL_FIELDS].join(" / ")}）。`);
  if (ideal.artStyle !== undefined && !ART_STYLES.includes(ideal.artStyle)) errors.push(`artStyle は ${ART_STYLES.join(" / ")} のどれか。`);
  if (ideal.motion !== undefined && !MOTIONS.includes(ideal.motion)) errors.push(`motion は ${MOTIONS.join(" / ")} のどれか。`);
  if (ideal.identityLock !== undefined && !IDENTITY_LOCKS.includes(ideal.identityLock)) errors.push(`identityLock は ${IDENTITY_LOCKS.join(" / ")} のどれか。`);
  if (ideal.budgetMonthlyJpy !== undefined && ideal.budgetMonthlyJpy !== null && !(Number.isFinite(ideal.budgetMonthlyJpy) && ideal.budgetMonthlyJpy >= 0)) {
    errors.push("budgetMonthlyJpy は 0 以上の数（円）か null。");
  }
  if (ideal.monthlyAdoptedSeconds !== undefined && !(Number.isFinite(ideal.monthlyAdoptedSeconds) && ideal.monthlyAdoptedSeconds > 0)) {
    errors.push("monthlyAdoptedSeconds は月に採用する秒数（0 より大きい数）。");
  }
  for (const key of ["models", "places"]) {
    if (ideal[key] === undefined) continue;
    if (!isPlainObject(ideal[key])) errors.push(`${key} は { imagePrimary, video } の形。`);
    else for (const slot of Object.keys(ideal[key])) if (!SLOTS[slot]) errors.push(`${key}.${slot} は使えない（imagePrimary / video）。`);
  }
  return errors;
}

/** 試験の記録から、モデル（と実行場所）ごとの「採用1秒あたりの現金」を引く。 */
function trialCashRates(trial) {
  if (!trial) return new Map();
  const metrics = computeTrialMetrics(trial);
  const rates = new Map();
  for (const candidate of trial.candidates || []) {
    const row = metrics.find((item) => item.candidateId === candidate.candidateId);
    if (!row?.complete || row.cashPerAdoptedSecondJpy === null) continue;
    for (const model of Object.values(candidate.models || {})) {
      if (!model?.modelId) continue;
      const key = `${model.modelId}@${model.place}`;
      const previous = rates.get(key);
      if (!previous || row.cashPerAdoptedSecondJpy < previous.cashPerAdoptedSecondJpy) {
        rates.set(key, { candidateId: candidate.candidateId, cashPerAdoptedSecondJpy: row.cashPerAdoptedSecondJpy });
      }
    }
  }
  return rates;
}

function budgetReasons(model, place, traits, { monthlyAdoptedSeconds, rates }) {
  const budget = traits.budgetMonthlyJpy;
  if (budget === null) return [];
  const reasons = [];
  if (budget === 0 && place === "operator-rented-gpu") {
    reasons.push({ type: "budget", code: "BUDGET_ZERO_RENTED_GPU", message: `月の予算が 0 円なので、${model.name} を借り GPU（使う日だけお金がかかる）では動かせない。` });
  }
  const rate = rates.get(`${model.id}@${place}`);
  if (rate && Number.isFinite(monthlyAdoptedSeconds)) {
    const estimate = Math.round(rate.cashPerAdoptedSecondJpy * monthlyAdoptedSeconds);
    if (estimate > budget) {
      reasons.push({
        type: "budget",
        code: "BUDGET_EXCEEDED_BY_TRIAL",
        message: `10カット試験の候補 ${rate.candidateId} の数字（採用1秒あたり ${rate.cashPerAdoptedSecondJpy} 円）で月 ${monthlyAdoptedSeconds} 秒を採用すると約 ${estimate.toLocaleString("ja-JP")} 円で、月の予算 ${budget.toLocaleString("ja-JP")} 円を超える。`,
        estimateJpy: estimate,
      });
    }
  }
  return reasons;
}

/** モデル1つを、理想の役目で調べる。通る実行場所（良い順）と、通らない理由を返す。 */
function evaluateForSlot(catalog, model, traits, { slot, allowedPlaces = null, monthlyAdoptedSeconds, rates }) {
  const reasons = [];
  const passing = [];
  const role = SLOTS[slot].role;
  if (!model.roles.includes(role)) {
    reasons.push({ type: "catalog", code: "MODEL_ROLE_MISMATCH", modelId: model.id, message: `${model.name} は構成表で「${SLOTS[slot].label}」の役目を持たない（${model.roles.join(" / ")}）。` });
    return { passing, reasons };
  }
  const { places, infeasible } = runtimeFeasibility(model, traits);
  for (const item of infeasible) {
    if (allowedPlaces && !allowedPlaces.includes(item.place)) continue;
    reasons.push({ type: "hardware", code: HARDWARE_CODE[item.place] || "HARDWARE", modelId: model.id, place: item.place, message: `${model.name}（${item.place}）: ${item.reason}` });
  }
  for (const place of places) {
    if (allowedPlaces && !allowedPlaces.includes(place)) continue;
    const verdict = evaluateModelRights(model, rightsContextFromTraits(traits, place), { catalog });
    const placeReasons = verdict.blocks.map((item) => ({ type: "rights", code: item.code, layer: item.layer, modelId: model.id, place, message: item.message }));
    placeReasons.push(...budgetReasons(model, place, traits, { monthlyAdoptedSeconds, rates }).map((item) => ({ ...item, modelId: model.id, place })));
    if (placeReasons.length === 0) passing.push({ place, warnings: verdict.warnings.map((item) => item.code) });
    else reasons.push(...placeReasons);
  }
  passing.sort((a, b) => (PLACE_SCORE[b.place] || 0) - (PLACE_SCORE[a.place] || 0) || a.place.localeCompare(b.place));
  return { passing, reasons };
}

function pickRow(model, passing) {
  return {
    modelId: model.id,
    modelName: model.name,
    place: passing.place,
    ...(model.mediaGenerationIds ? { mediaGenerationIds: [...model.mediaGenerationIds] } : {}),
    rightsWarnings: passing.warnings,
  };
}

function slotsFor(traits) {
  return traits.motion === "stills-camera" ? ["imagePrimary"] : ["imagePrimary", "video"];
}

/** 役目ごとに候補になるモデル（名指しが無ければ、絵の種類に当てはまるもの全部を好みの順に）。 */
function wantedModels(catalog, traits, slot, named) {
  if (named) return [findModel(catalog, named) || { missing: named }];
  return catalog.models
    .filter((model) => model.roles.includes(SLOTS[slot].role) && model.fit.artStyles.includes(traits.artStyle))
    .sort((a, b) => a.preference - b.preference || a.id.localeCompare(b.id));
}

function resolveSlots(catalog, traits, { models = {}, places = {}, monthlyAdoptedSeconds, rates }) {
  const chosen = {};
  const reasons = [];
  const skipped = [];
  const unsatisfied = [];
  for (const slot of slotsFor(traits)) {
    const allowedPlaces = places[slot] ? [places[slot]] : null;
    const candidates = wantedModels(catalog, traits, slot, models[slot]);
    const slotReasons = [];
    let best = null;
    for (const model of candidates) {
      if (model.missing) {
        slotReasons.push({ type: "catalog", code: "MODEL_NOT_IN_CATALOG", modelId: model.missing, message: `${model.missing} は構成表に無い（構成表の版 ${catalog.as_of}）。` });
        continue;
      }
      const evaluated = evaluateForSlot(catalog, model, traits, { slot, allowedPlaces, monthlyAdoptedSeconds, rates });
      if (evaluated.passing.length > 0) {
        const row = pickRow(model, evaluated.passing[0]);
        const score = (PLACE_SCORE[row.place] || 0) * 1000 - model.preference;
        if (!best || score > best.score) best = { row, score };
        if (models[slot]) break;
      } else {
        slotReasons.push(...evaluated.reasons);
      }
    }
    if (candidates.length === 0) {
      slotReasons.push({ type: "catalog", code: "NO_MODEL_FOR_ART_STYLE", message: `構成表に、絵の種類 ${traits.artStyle} の「${SLOTS[slot].label}」に当てはまるモデルが無い。` });
    }
    if (best) {
      chosen[slot] = best.row;
      skipped.push(...slotReasons.map((item) => ({ slot, slotLabel: SLOTS[slot].label, ...item })));
    } else {
      unsatisfied.push(slot);
      reasons.push(...slotReasons.map((item) => ({ slot, slotLabel: SLOTS[slot].label, ...item })));
    }
  }
  return { chosen, reasons, skipped, unsatisfied };
}

function configFrom(catalog, traits, chosen) {
  const videoConfigs = selectVideoConfigs(catalog, traits);
  const workflows = selectImageWorkflows(catalog, traits);
  return {
    videoConfigs: { base: videoConfigs.base, overlays: videoConfigs.overlays, clips: videoConfigs.clips },
    imageWorkflows: workflows.selected.map((item) => item.id),
    models: { imagePrimary: chosen.imagePrimary || null, video: chosen.video || null },
    runtimePlaces: [...new Set(Object.values(chosen).map((row) => row.place))],
  };
}

function dedupeReasons(reasons) {
  const seen = new Set();
  return reasons.filter((item) => {
    const key = [item.slot, item.type, item.code, item.modelId, item.place].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 理想を構成にできるかを調べる。
 * 返すもの:
 *   status: "match"   理想どおりの構成（config）
 *   status: "blocked" config は null。reasons（type: budget / hardware / rights / catalog）と alternatives（近い順の代わりの案）
 */
export function explainIdeal(rawTraits, ideal = {}, { catalog = loadOptimalConfigCatalog(), trial = null } = {}) {
  const errors = validateIdeal(ideal);
  if (errors.length > 0) {
    const error = new Error(`理想（ideal）の形が違う:\n${errors.map((item) => `- ${item}`).join("\n")}`);
    error.code = "OPTIMAL_CONFIG_IDEAL_INVALID";
    throw error;
  }
  const base = assertChannelTraits(rawTraits);
  const traits = assertChannelTraits({
    ...rawTraits,
    ...(ideal.artStyle !== undefined ? { artStyle: ideal.artStyle } : {}),
    ...(ideal.motion !== undefined ? { motion: ideal.motion } : {}),
    ...(ideal.identityLock !== undefined ? { identityLock: ideal.identityLock } : {}),
    ...(ideal.budgetMonthlyJpy !== undefined ? { budgetMonthlyJpy: ideal.budgetMonthlyJpy } : {}),
  });
  const rates = trialCashRates(trial);
  const context = { models: ideal.models || {}, places: ideal.places || {}, monthlyAdoptedSeconds: ideal.monthlyAdoptedSeconds, rates };
  const warnings = [];
  if (traits.budgetMonthlyJpy === null) warnings.push("月の予算が未設定なので、予算では判定していない（推定しない）。");
  if (Number.isFinite(ideal.monthlyAdoptedSeconds) && !trial) warnings.push("monthlyAdoptedSeconds があるが試験の記録（--trial）が無いので、月の現金は見積もっていない。");
  if (traits.confidentialAssets) warnings.push("外に出せない素材があるので、外部へ送る経路は権利の関門（F 層）で止まる。");
  for (const [slot, modelId] of Object.entries(context.models)) {
    const model = findModel(catalog, modelId);
    if (model && !model.fit.artStyles.includes(traits.artStyle)) {
      warnings.push(`${model.name} は構成表で絵の種類 ${traits.artStyle} に当てはまるとされていない（${SLOTS[slot].label}）。10カット試験で確かめる。`);
    }
  }
  const ideally = {
    artStyle: traits.artStyle,
    identityLock: traits.identityLock,
    motion: traits.motion,
    budgetMonthlyJpy: traits.budgetMonthlyJpy,
    models: { ...context.models },
    places: { ...context.places },
  };
  const resolved = resolveSlots(catalog, traits, context);
  const out = {
    version: EXPLAIN_IDEAL_VERSION,
    catalogVersion: catalog.version,
    catalogAsOf: catalog.as_of,
    reproduced: false,
    channelId: traits.channelId,
    ideal: ideally,
    changedFromTraits: ["artStyle", "identityLock", "motion", "budgetMonthlyJpy"].filter((field) => base[field] !== traits[field]),
  };
  if (resolved.unsatisfied.length === 0) {
    return {
      ...out,
      status: "match",
      config: configFrom(catalog, traits, resolved.chosen),
      reasons: [],
      // 名指しの無い役目で、理想の条件に当てはまるのに外したモデルと理由（黙って落とさない）
      excluded: dedupeReasons(resolved.skipped),
      alternatives: [],
      warnings,
      note: "理想どおりの構成。本番にする前に、同じ10カットで試して数字を見てから運営者が決める。",
    };
  }

  // 近い代わりの案（それぞれ、もう一度全部の関門を通したものだけ）
  const alternatives = [];
  const push = (changes, altTraits, altContext) => {
    const alt = resolveSlots(catalog, altTraits, altContext);
    if (alt.unsatisfied.length > 0) return;
    const config = configFrom(catalog, altTraits, alt.chosen);
    const key = JSON.stringify(config.models);
    if (alternatives.some((row) => JSON.stringify(row.config.models) === key)) return;
    alternatives.push({ distance: changes.length, changes, config });
  };
  // 1) 理想のまま、止まった役目のモデル（か実行場所）だけを替える
  const freeModels = { ...context.models };
  const freePlaces = { ...context.places };
  for (const slot of resolved.unsatisfied) { delete freeModels[slot]; delete freePlaces[slot]; }
  const swapped = resolveSlots(catalog, traits, { ...context, models: freeModels, places: freePlaces });
  if (swapped.unsatisfied.length === 0) {
    const changes = resolved.unsatisfied.map((slot) => ({
      field: `models.${slot}`,
      from: context.models[slot] ? `${context.models[slot]}${context.places[slot] ? `@${context.places[slot]}` : ""}` : "（理想の条件で選べるもの）",
      to: `${swapped.chosen[slot].modelId}@${swapped.chosen[slot].place}`,
      why: `${SLOTS[slot].label}を、予算・機材・権利を通る別のモデル（か実行場所）にする。`,
    }));
    push(changes, traits, { ...context, models: freeModels, places: freePlaces });
  }
  // 2) 名指しのモデルはそのままで、実行場所の縛りだけを外す
  if (Object.keys(context.places).length > 0) {
    const placesFree = { ...context.places };
    for (const slot of resolved.unsatisfied) delete placesFree[slot];
    push(resolved.unsatisfied.filter((slot) => context.places[slot]).map((slot) => ({ field: `places.${slot}`, from: context.places[slot], to: "（通る実行場所）", why: "同じモデルを、動いて権利も通る実行場所で使う。" })), traits, { ...context, places: placesFree });
  }
  // 3) 動画が止まったなら、動きを下げる（静止＋カメラ）
  if (resolved.unsatisfied.includes("video") && traits.motion !== "stills-camera") {
    const stills = assertChannelTraits({ ...traits, motion: "stills-camera" });
    const altModels = { ...context.models };
    delete altModels.video;
    const motionChange = { field: "motion", from: traits.motion, to: "stills-camera", why: "動画のカットをやめて、静止画＋カメラで見せる。" };
    push([motionChange], stills, { ...context, models: altModels });
    // 画像の役目も止まっていたら、そのモデルも替えて動きを下げる
    if (resolved.unsatisfied.includes("imagePrimary")) {
      const both = resolveSlots(catalog, stills, { ...context, models: freeModels, places: freePlaces });
      if (both.unsatisfied.length === 0) {
        push([
          { field: "models.imagePrimary", from: context.models.imagePrimary || "（理想の条件で選べるもの）", to: `${both.chosen.imagePrimary.modelId}@${both.chosen.imagePrimary.place}`, why: "本番の画像を、予算・機材・権利を通る別のモデル（か実行場所）にする。" },
          motionChange,
        ], stills, { ...context, models: freeModels, places: freePlaces });
      }
    }
  }
  alternatives.sort((a, b) => a.distance - b.distance);
  return {
    ...out,
    status: "blocked",
    config: null,
    unsatisfied: resolved.unsatisfied.map((slot) => ({ slot, label: SLOTS[slot].label })),
    reasons: dedupeReasons(resolved.reasons),
    reasonTypes: [...new Set(resolved.reasons.map((item) => item.type))],
    alternatives: alternatives.slice(0, 3),
    warnings,
    note: "理想どおりにはできない。黙って別の構成に置き換えない。理由と近い代わりの案から、運営者が選ぶ（理想を変えるか、機材・契約・予算を変えるか）。",
  };
}
