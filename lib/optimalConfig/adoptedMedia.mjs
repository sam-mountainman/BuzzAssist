// 採用した構成を、制作の入口（run-video-harness）が使う画像・動画のモデルと経路に解く。
//
// - 採用の記録が無いチャンネルは今までどおり（既定のモデル・経路。ここは何もしない）
// - 採用の記録があれば、本番の構成の画像・動画のモデルと経路をそこから決める
// - 決められない（構成表に無い・生成層が知らないモデル・権利で止まる・このハーネスでは使えない経路・
//   人の確認がまだ・記録が壊れている）なら、既定へ黙って戻さずに、日本語の理由で止める（C5 と同じ考え方）
// 生成はしない。モデルの名前を生成層の id に解くのは lib/mediaGeneration.mjs の normalize*（既定への置き換え無し）。

import { normalizeImageModel, normalizeVideoModel, UNKNOWN_MEDIA_MODEL_CODE } from "../mediaGeneration.mjs";
import { imageFamilyForModel, routeIdForModel, videoFamilyForModel } from "../modelCatalog.mjs";
import { readAdoptedConfig } from "./adoption.mjs";
import { findModel, loadOptimalConfigCatalog } from "./catalog.mjs";
import { evaluateModelRights, rightsContextFromTraits } from "./rightsGate.mjs";

export const ADOPTED_MEDIA_SELECTION_VERSION = "optimal-config-adopted-media-v1";
/** Job の options に入れる鍵（Job の識別子に入る。採用し直したら別の Job になる）。 */
export const ADOPTED_MEDIA_OPTION_KEY = "optimalConfig";

export const ADOPTED_CONFIG_CODES = Object.freeze({
  NOT_HUMAN_VERIFIED: "adopted-config-not-human-verified",
  CHANNEL_MISMATCH: "adopted-config-channel-mismatch",
  UNKNOWN_MODEL: "adopted-config-unknown-model",
  RIGHTS_BLOCKED: "adopted-config-rights-blocked",
  ROUTE_UNSUPPORTED: "adopted-config-route-unsupported",
  PACK_CONFLICT: "adopted-config-pack-model-conflict",
  OPTIONS_CONFLICT: "adopted-config-options-conflict",
  INVALID: "adopted-config-invalid",
});

/** Ollama の画像生成で手元（Mac）に置けるモデル（構成表の id → 手元の実行の種類）。 */
const LOCAL_EXECUTORS = Object.freeze({
  "flux2-klein-4b": "ollama-local",
  "z-image-turbo": "ollama-local",
});

function codedError(code, message, extra = {}) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function executorFor(modelId, place) {
  if (place === "operator-service") return "media-broker";
  if (place === "operator-mac") return LOCAL_EXECUTORS[modelId] || "operator-local";
  if (place === "operator-cuda") return "operator-local";
  if (place === "operator-rented-gpu") return "rented-gpu";
  return "unknown";
}

/** 構成表のモデルの生成の id を、生成層が知っている id に解く。知らなければ止める（既定へ置き換えない）。 */
function generationModelFor(model, kind) {
  const ids = Array.isArray(model.mediaGenerationIds) ? model.mediaGenerationIds : [];
  const familyOf = kind === "video" ? videoFamilyForModel : imageFamilyForModel;
  const normalize = kind === "video" ? normalizeVideoModel : normalizeImageModel;
  const candidate = ids.find((id) => familyOf(id));
  if (!candidate) {
    throw codedError(ADOPTED_CONFIG_CODES.UNKNOWN_MODEL, `採用した${kind === "video" ? "動画" : "画像"}のモデル ${model.name} に、生成層が知っている生成の id が無い（${ids.join(", ") || "なし"}）。既定のモデルへは置き換えない。構成表と生成層を確かめて採用し直す。`);
  }
  try {
    normalize(candidate, { allowDefaultFallback: false });
  } catch (error) {
    if (error?.code === UNKNOWN_MEDIA_MODEL_CODE) {
      throw codedError(ADOPTED_CONFIG_CODES.UNKNOWN_MODEL, `採用したモデル ${model.name} の生成の id ${candidate} を生成層が知らない。既定のモデルへは置き換えない。`);
    }
    throw error;
  }
  return { generationModelId: candidate, mediaRoute: routeIdForModel(familyOf(candidate), candidate) };
}

function resolveSlot(catalog, row, kind, context) {
  if (!row || !nonEmpty(row.modelId)) return null;
  const model = findModel(catalog, row.modelId);
  if (!model) {
    throw codedError(ADOPTED_CONFIG_CODES.UNKNOWN_MODEL, `採用した構成のモデル ${row.modelId} が今の構成表（${catalog.as_of}）に無い。既定のモデルへは置き換えない。構成表を確かめて採用し直す。`);
  }
  const place = nonEmpty(row.place);
  if (!model.runtime.places.includes(place)) {
    throw codedError(ADOPTED_CONFIG_CODES.INVALID, `採用した構成の ${model.name} の実行場所 ${place || "（なし）"} は構成表のこのモデルの実行場所ではない。`);
  }
  const verdict = evaluateModelRights(model, rightsContextFromTraits(context, place), { catalog });
  if (!verdict.allowed) {
    throw codedError(ADOPTED_CONFIG_CODES.RIGHTS_BLOCKED, `採用した ${model.name}（${place}）は今の構成表（${catalog.as_of}）の権利の関門で止まる: ${verdict.blocks.map((item) => item.message).join(" ")}`);
  }
  const executor = executorFor(model.id, place);
  const generation = place === "operator-service" ? generationModelFor(model, kind) : { generationModelId: null, mediaRoute: null };
  return {
    catalogModelId: model.id,
    modelName: model.name,
    place,
    executor,
    ...generation,
    rightsWarnings: verdict.warnings.map((item) => item.code),
  };
}

function rightsContextOf(decision) {
  const summary = decision.traitsSummary || {};
  return {
    publishScope: summary.publishScope,
    confidentialAssets: summary.confidentialAssets === true,
    annualRevenueUsd: Number.isFinite(summary.annualRevenueUsd) ? summary.annualRevenueUsd : null,
    identityLock: summary.identityLock,
  };
}

/**
 * 採用の決定（human-verified のもの）を、画像・動画のモデルと経路に解く。止まる理由は例外（code つき）。
 * 予備の構成は、解けなければ止めずに backupIssues に残す（予備は上限に当たったときの下書きにだけ使う）。
 */
export function resolveAdoptedMediaSelection(decision, { catalog = loadOptimalConfigCatalog() } = {}) {
  if (!decision || decision.approval?.attestedBy !== "human-verified") {
    throw codedError(ADOPTED_CONFIG_CODES.NOT_HUMAN_VERIFIED, "採用の記録に人の確認（--human-verified）が無い。");
  }
  const context = rightsContextOf(decision);
  const models = decision.production?.models || {};
  const image = resolveSlot(catalog, models.imagePrimary, "image", context);
  if (!image) throw codedError(ADOPTED_CONFIG_CODES.INVALID, "採用した本番の構成に本番の画像のモデルが無い。");
  const video = resolveSlot(catalog, models.video, "video", context);
  const backupModels = decision.backup?.models || {};
  const backup = { image: null, video: null };
  const backupIssues = [];
  for (const [slot, key, kind] of [["image", "imagePrimary", "image"], ["video", "video", "video"]]) {
    try {
      backup[slot] = resolveSlot(catalog, backupModels[key], kind, context);
    } catch (error) {
      backupIssues.push({ slot, code: error.code || ADOPTED_CONFIG_CODES.INVALID, message: error.message });
    }
  }
  const warnings = [];
  if (decision.catalog?.asOf && decision.catalog.asOf !== catalog.as_of) {
    warnings.push(`構成表が採用したとき（${decision.catalog.asOf}）から更新されている（今は ${catalog.as_of}）。権利と生成の id は今の構成表で確かめ直した。数字が変わり得るので、必要なら10カットで取り直す。`);
  }
  return {
    version: ADOPTED_MEDIA_SELECTION_VERSION,
    adoptionSha256: decision.recordSha256,
    channelId: decision.channelId,
    decidedAt: decision.decidedAt,
    reviewer: decision.approval.reviewer,
    catalogAsOf: catalog.as_of,
    productionCandidateId: decision.production?.candidateId || "",
    backupCandidateId: decision.backup?.candidateId || "",
    image,
    video,
    backup,
    ...(backupIssues.length > 0 ? { backupIssues } : {}),
    warnings,
  };
}

/**
 * このハーネスで、解いた経路が使えるかを確かめる。使えなければ止める（既定へ戻さない）。
 *   koya-manga-video:      本番の画像は生成層の経路（media-broker）だけ。手元・借り GPU の画像はまだ取り込めない
 *   narrated-story-video:  生成層の経路か、運営者の画の取り込み（operator-file。手元・借り GPU で作った画）。
 *                          署名済み Pack の宣言との突き合わせは prepare（checkAdoptedAgainstPackRuntime）で行う
 */
export function assertAdoptedSelectionForHarness(harnessId, selection) {
  if (!selection) return;
  if (harnessId === "koya-manga-video" && selection.image.executor !== "media-broker") {
    throw codedError(ADOPTED_CONFIG_CODES.ROUTE_UNSUPPORTED, `採用した本番の画像（${selection.image.modelName}・${selection.image.place}）は、漫画のハーネスの制作の入口ではまだ使えない（生成層の経路だけ）。既定のモデルへは置き換えない。予備との入れ替えか、別の構成を運営者が採用し直す。`);
  }
  if (harnessId === "narrated-story-video" && !["media-broker", "ollama-local", "operator-local", "rented-gpu"].includes(selection.image.executor)) {
    throw codedError(ADOPTED_CONFIG_CODES.ROUTE_UNSUPPORTED, `採用した本番の画像の経路 ${selection.image.executor} はナレーション物語のハーネスで使えない。`);
  }
}

/** Job の options に入れる形（Job の識別子に入る。秘密は入らない）。 */
export function adoptedSelectionForJob(selection) {
  const slot = (row) => (row ? {
    catalogModelId: row.catalogModelId,
    place: row.place,
    executor: row.executor,
    generationModelId: row.generationModelId,
    mediaRoute: row.mediaRoute,
  } : null);
  return {
    version: selection.version,
    adoptionSha256: selection.adoptionSha256,
    channelId: selection.channelId,
    productionCandidateId: selection.productionCandidateId,
    backupCandidateId: selection.backupCandidateId,
    image: slot(selection.image),
    video: slot(selection.video),
    backup: { image: slot(selection.backup?.image), video: slot(selection.backup?.video) },
  };
}

/**
 * 制作の入口が呼ぶ。採用の記録が無ければ { status: "none" }（今までどおり）。
 * あれば、解いた経路を { status: "adopted", selection, jobOption } で返す。止まる理由は例外（code つき）。
 */
export async function resolveAdoptedConfigForRun({
  projectDir,
  channelId = "",
  harnessId = "",
  readAdopted = readAdoptedConfig,
  catalog = null,
} = {}) {
  const read = await readAdopted({ projectDir });
  if (read.status === "none") return { status: "none" };
  if (read.status === "pending-human") {
    throw codedError(ADOPTED_CONFIG_CODES.NOT_HUMAN_VERIFIED, `この作業フォルダの採用の記録（${read.source?.path || ""}）は機械の提案だけで、人の確認がまだ。既定の構成では作らずに止める。提案を記録したときに出た next のコマンドを、決めた人が自分の端末で打つ（状態は node scripts/optimal-config.mjs adopted で見られる）。`);
  }
  if (nonEmpty(channelId) && read.channelId !== channelId) {
    throw codedError(ADOPTED_CONFIG_CODES.CHANNEL_MISMATCH, `採用の記録はチャンネル ${read.channelId} のもので、このチャンネル（${channelId}）とは違う。作業フォルダを確かめる。`);
  }
  const selection = resolveAdoptedMediaSelection(read.decision, { catalog: catalog || loadOptimalConfigCatalog() });
  assertAdoptedSelectionForHarness(harnessId, selection);
  return {
    status: "adopted",
    source: read.source,
    selection,
    jobOption: adoptedSelectionForJob(selection),
    ...(read.newerUnverifiedCount ? { newerUnverifiedCount: read.newerUnverifiedCount } : {}),
  };
}

/**
 * ナレーション物語の prepare で、署名済み Pack の画像の宣言と採用した構成を突き合わせる。
 * 合わなければ止める理由を返す（Pack を黙って上書きもしないし、採用を黙って捨てもしない）。
 */
export function checkAdoptedAgainstPackRuntime(jobOption, channelPackRuntime, { catalog = loadOptimalConfigCatalog() } = {}) {
  if (!jobOption || !channelPackRuntime) return null;
  const image = jobOption.image || {};
  const operatorFile = channelPackRuntime.imageSource === "operator-file";
  if (image.executor !== "media-broker") {
    if (operatorFile) return null;
    return {
      code: ADOPTED_CONFIG_CODES.PACK_CONFLICT,
      message: `採用した本番の画像は手元・借り GPU（${image.catalogModelId}・${image.place}）で作るが、署名済み Channel Pack は画を生成層（${channelPackRuntime.imageProvider} / ${channelPackRuntime.imageModel}）で作る宣言になっている。Pack の image.source を operator-file にして署名し直すか、採用し直す。`,
    };
  }
  if (operatorFile) return null;
  const model = findModel(catalog, image.catalogModelId);
  const allowed = new Set(model?.mediaGenerationIds || []);
  if (!allowed.has(channelPackRuntime.imageModel)) {
    return {
      code: ADOPTED_CONFIG_CODES.PACK_CONFLICT,
      message: `採用した本番の画像のモデル（${image.catalogModelId}: ${[...allowed].join(" / ")}）と、署名済み Channel Pack の画像のモデル（${channelPackRuntime.imageModel}）が違う。どちらかに黙ってそろえない。Pack を採用したモデルで署名し直すか、採用し直す。`,
    };
  }
  return null;
}
