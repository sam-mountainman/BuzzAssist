// 最適構成の選定——チャンネルの性格（traits）から、構成表の中で候補を2〜3案に絞る。
//
// 選ぶもの: 動画の構成（R##）、画像のワークフロー（W##）、モデル（主力・下書き・量・動画）、実行場所。
// 通すもの: 権利の関門（6層）と機材の判定（Mac のメモリ、CUDA 専用、借り GPU の可否、契約の有無）。
//
// 正解を決め打ちしない。調査は公式資料を読んだだけで何も実測していないので、ここが返すのは
// 「同じ10カットで比べる候補」まで。どれを本番にするかは試験の数字（trialRecord.mjs）で決める。
// 選べなかったもの・外したものは理由つきで返す（黙って落とさない）。

import { loadOptimalConfigCatalog, findWorkflow } from "./catalog.mjs";
import { assertChannelTraits } from "./channelTraits.mjs";
import { evaluateModelRights, rightsContextFromTraits } from "./rightsGate.mjs";

export const SELECT_CONFIG_VERSION = "optimal-config-selection-v1";
export const TRIAL_CUT_COUNT = 10;

const LOCAL_PLACES = new Set(["operator-mac", "operator-cuda"]);
const ROLE_LABEL = {
  "image-primary": "本番の画像",
  "image-draft": "下書き・候補出し",
  "image-bulk": "量のカット",
  "video-i2v": "動画のカット",
};
const BULK_MIN_LENGTH_MINUTES = 40;

// ---------------------------------------------------------------------------
// 機材の判定
// ---------------------------------------------------------------------------

/**
 * モデルが、このチャンネルの機材・契約で動く実行場所を返す。動かない場所は理由つきで返す。
 * 「未確認」は動くとは扱わない（unverified を選ぶと、試験の前に機材を買う判断を誘う）。
 */
export function runtimeFeasibility(model, traits) {
  const hardware = traits.hardware || {};
  const contracts = new Set(hardware.contracts || []);
  const places = [];
  const infeasible = [];
  for (const place of model.runtime?.places || []) {
    if (place === "operator-mac") {
      const mac = model.runtime.mac || {};
      if (!hardware.mac) infeasible.push({ place, reason: "Mac を使わない設定。" });
      else if (mac.supported === true) {
        const need = Number.isFinite(mac.minMemoryGiB) ? mac.minMemoryGiB : 0;
        if (hardware.mac.memoryGiB >= need) places.push(place);
        else infeasible.push({ place, reason: `Mac のメモリ ${hardware.mac.memoryGiB}GiB では動かない（${model.name} の手元の経路は ${need}GiB 以上が条件）。${mac.note || ""}`.trim() });
      } else {
        infeasible.push({ place, reason: mac.supported === false ? `${model.name} は Mac では動かない。` : `${model.name} が Mac で動くかは未確認。${mac.note || ""}`.trim() });
      }
    } else if (place === "operator-cuda") {
      const need = model.runtime.cuda?.minVramGiB;
      if (!(hardware.cudaVramGiB > 0)) infeasible.push({ place, reason: "手元に NVIDIA GPU が無い（CUDA 専用の経路は Mac へ持ち込まない）。" });
      else if (!Number.isFinite(need)) infeasible.push({ place, reason: `${model.name} の必要 VRAM が一次資料で確定できない（未実測）。` });
      else if (hardware.cudaVramGiB >= need) places.push(place);
      else infeasible.push({ place, reason: `手元の GPU（${hardware.cudaVramGiB}GiB）では足りない（${need}GiB 以上）。` });
    } else if (place === "operator-rented-gpu") {
      if (hardware.cloudGpu === true) places.push(place);
      else infeasible.push({ place, reason: "GPU を借りない設定（hardware.cloudGpu が false）。" });
    } else if (place === "operator-service") {
      const keys = model.contractKeys || [];
      if (keys.some((key) => contracts.has(key))) places.push(place);
      else infeasible.push({ place, reason: `${model.name} の契約（${keys.join(" / ") || "なし"}）が無い。` });
    } else {
      infeasible.push({ place, reason: `${place} では生成しない。` });
    }
  }
  return { places, infeasible };
}

function placeScore(place) {
  if (place === "operator-service") return 30; // 既に払っている契約の中で動く
  if (place === "operator-mac" || place === "operator-cuda") return 25; // 手元で無料
  if (place === "operator-rented-gpu") return 10; // 使う日だけお金がかかる
  return 0;
}

/** モデル1つについて、動けて権利も通る実行場所を、良い順に返す。 */
export function usablePlaces(catalog, model, traits, { allowedPlaces = null } = {}) {
  const { places, infeasible } = runtimeFeasibility(model, traits);
  const usable = [];
  const blocked = [];
  for (const place of places) {
    if (allowedPlaces && !allowedPlaces.has(place)) continue;
    const verdict = evaluateModelRights(model, rightsContextFromTraits(traits, place), { catalog });
    if (verdict.allowed) usable.push({ place, verdict });
    else blocked.push({ place, verdict });
  }
  usable.sort((a, b) => placeScore(b.place) - placeScore(a.place) || a.place.localeCompare(b.place));
  return { usable, blocked, infeasible };
}

// ---------------------------------------------------------------------------
// 動画の構成（R##）
// ---------------------------------------------------------------------------

function bodyMotion(traits) {
  return traits.motion === "mostly-video" ? "mostly-video" : "stills-camera";
}

function scoreVideoConfig(config, traits, motion) {
  const target = config.targetTraits;
  const matches = {
    artStyle: target.artStyles.includes(traits.artStyle),
    identityLock: target.identityLocks.includes(traits.identityLock),
    motion: target.motions.includes(motion),
  };
  let score = 0;
  if (matches.artStyle) score += 3;
  if (matches.identityLock) score += 3;
  if (matches.motion) score += 2;
  // 当てはまる範囲が狭いほど、そのチャンネルに向けた構成（広く当てはまる構成に負けないように）
  if (target.artStyles.length <= 2) score += 1;
  return { score, matches };
}

function appliesWhen(config, traits) {
  const rule = config.appliesWhen || {};
  const hardware = traits.hardware || {};
  if (rule.minLengthMinutes !== undefined && !(traits.lengthMinutes >= rule.minLengthMinutes)) return false;
  if (rule.contractsAny && !rule.contractsAny.some((key) => (hardware.contracts || []).includes(key))) return false;
  if (rule.motionNot && rule.motionNot.includes(traits.motion)) return false;
  if (rule.macOnly && !(hardware.mac && !(hardware.cudaVramGiB > 0) && hardware.cloudGpu !== true)) return false;
  if (rule.confidentialAssets !== undefined && traits.confidentialAssets !== rule.confidentialAssets) return false;
  if (rule.priority && traits.priority !== rule.priority) return false;
  if (rule.noGpuNoContract && ((hardware.cudaVramGiB > 0) || (hardware.contracts || []).length > 0)) return false;
  return true;
}

function describeMatch(config, traits, motion) {
  return `${config.id}「${config.name}」——絵の種類 ${traits.artStyle}・固定したいもの ${traits.identityLock}・動き ${motion} に当てはまる`;
}

/**
 * 本編（base）・重ねる構成（overlays）・数カットの動画（clips）を選ぶ。
 * base は本編の作り方なので、数カットだけ動かすチャンネルでも本編の動きは「静止＋カメラ」で比べる。
 */
export function selectVideoConfigs(catalog, traits) {
  const motion = bodyMotion(traits);
  const reasons = [];
  const ranked = (role, scoreMotion) => catalog.videoConfigs
    .filter((config) => config.role === role)
    .map((config) => ({ config, ...scoreVideoConfig(config, traits, scoreMotion) }))
    .sort((a, b) => b.score - a.score || a.config.id.localeCompare(b.config.id));

  const baseRanking = ranked("base", motion);
  const base = baseRanking[0];
  reasons.push(`本編は ${describeMatch(base.config, traits, motion)}（${baseRanking.slice(1, 3).map((row) => `${row.config.id} より合う`).join("、") || "他に候補なし"}）。`);

  const overlays = [];
  for (const row of ranked("identity", traits.motion)) {
    if (row.matches.artStyle && row.matches.identityLock) {
      overlays.push(row.config.id);
      reasons.push(`人物まわりは ${row.config.id}「${row.config.name}」を重ねる（${traits.identityLock} を ${traits.artStyle} で保つ）。`);
      break;
    }
  }
  for (const config of catalog.videoConfigs.filter((item) => ["operations", "runtime", "confidential", "quality", "trial"].includes(item.role))) {
    if (config.appliesWhen && appliesWhen(config, traits)) {
      overlays.push(config.id);
      reasons.push(`${config.id}「${config.name}」の考え方を入れる。`);
    }
  }

  let clips = null;
  if (traits.motion !== "stills-camera") {
    const clipRanking = ranked("clips", traits.motion).filter((row) => row.matches.artStyle && row.matches.identityLock && row.matches.motion);
    if (clipRanking[0]) {
      clips = clipRanking[0].config.id;
      reasons.push(`動かすカットは ${clipRanking[0].config.id}「${clipRanking[0].config.name}」。`);
    }
  } else {
    reasons.push("生成動画は使わない（動き: stills-camera）。");
  }
  return { base: base.config.id, overlays, clips, reasons };
}

// ---------------------------------------------------------------------------
// 画像のワークフロー（W##）
// ---------------------------------------------------------------------------

function selectorMatches(when, traits) {
  if (when.artStyles && !when.artStyles.includes(traits.artStyle)) return false;
  if (when.identityLocks && !when.identityLocks.includes(traits.identityLock)) return false;
  if (when.motions && !when.motions.includes(traits.motion)) return false;
  if (when.confidentialAssets !== undefined && when.confidentialAssets !== traits.confidentialAssets) return false;
  return true;
}

/** 当てはまるワークフローを優先順に返す。依存するモデルが権利で止まったワークフローは外して理由を返す。 */
export function selectImageWorkflows(catalog, traits, { blockedModelIds = new Set() } = {}) {
  const chosen = new Map();
  for (const selector of catalog.workflowSelectors) {
    if (!selectorMatches(selector.when, traits)) continue;
    const previous = chosen.get(selector.workflowId);
    if (!previous || selector.priority < previous.priority) chosen.set(selector.workflowId, selector);
  }
  const selected = [];
  const dropped = [];
  for (const selector of [...chosen.values()].sort((a, b) => a.priority - b.priority || a.workflowId.localeCompare(b.workflowId))) {
    const workflow = findWorkflow(catalog, selector.workflowId);
    if (!workflow) continue;
    const blockedDeps = (workflow.requiresModels || []).filter((id) => blockedModelIds.has(id));
    if (blockedDeps.length > 0) {
      dropped.push({ id: workflow.id, reason: `依存するモデル（${blockedDeps.join(", ")}）が権利の関門で止まった。` });
      continue;
    }
    selected.push({ id: workflow.id, name: workflow.name, purpose: selector.purpose, caveats: workflow.caveats, validation: workflow.validation });
  }
  return { selected, dropped };
}

// ---------------------------------------------------------------------------
// 高速化
// ---------------------------------------------------------------------------

/** 手元の機材で使える高速化と、使えない高速化（CUDA 専用を Mac に持ち込まない、など）。 */
export function selectAccelerations(catalog, traits) {
  const hardware = traits.hardware || {};
  const hasMac = Boolean(hardware.mac);
  const hasCuda = hardware.cudaVramGiB > 0;
  const usable = [];
  const excluded = [];
  const unverified = [];
  for (const entry of catalog.accelerations) {
    if (entry.platform === "cross-platform") usable.push(entry.id);
    else if (entry.platform === "cuda-only") {
      if (hasCuda) usable.push(entry.id);
      else excluded.push({ id: entry.id, name: entry.name, reason: hasMac ? "CUDA 専用。Mac には持ち込まない（借り GPU で使うときだけ）。" : "CUDA 専用で、手元に NVIDIA GPU が無い。" });
    } else if (entry.platform === "mac-only") {
      if (hasMac) usable.push(entry.id);
      else excluded.push({ id: entry.id, name: entry.name, reason: "Apple Silicon 専用で、Mac を使わない設定。" });
    } else unverified.push(entry.id);
  }
  return {
    local: { usable, excluded },
    rentedGpu: hardware.cloudGpu === true
      ? { usable: catalog.accelerations.filter((entry) => entry.platform === "cuda-only" || entry.platform === "cross-platform").map((entry) => entry.id) }
      : { usable: [] },
    unverified,
    note: "どの高速化も実測していない。足すときは1つずつ足し、同じ10カットで比べる。",
  };
}

// ---------------------------------------------------------------------------
// モデル
// ---------------------------------------------------------------------------

function rankModels(catalog, traits, role, { allowedPlaces = null } = {}) {
  const rows = [];
  for (const model of catalog.models) {
    if (!model.roles.includes(role)) continue;
    if (!model.fit.artStyles.includes(traits.artStyle)) continue;
    const { usable } = usablePlaces(catalog, model, traits, { allowedPlaces });
    if (usable.length === 0) continue;
    rows.push({ model, place: usable[0].place, verdict: usable[0].verdict });
  }
  return rows.sort((a, b) => placeScore(b.place) - placeScore(a.place)
    || a.model.preference - b.model.preference
    || a.model.id.localeCompare(b.model.id));
}

function pick(row, role) {
  if (!row) return null;
  return {
    role,
    roleLabel: ROLE_LABEL[role],
    modelId: row.model.id,
    modelName: row.model.name,
    place: row.place,
    ...(row.model.mediaGenerationIds ? { mediaGenerationIds: row.model.mediaGenerationIds } : {}),
    rightsWarnings: row.verdict.warnings.map((item) => item.code),
  };
}

/** 権利の関門で止まったモデルと、機材で動かないモデルを理由つきで返す。 */
export function excludedModels(catalog, traits) {
  const blockedByRights = [];
  const notRunnable = [];
  const wantsVideo = traits.motion !== "stills-camera";
  for (const model of catalog.models) {
    const relevant = model.kind !== "video" || wantsVideo;
    const { usable, blocked, infeasible } = usablePlaces(catalog, model, traits);
    // 権利は「どこで動かしても止まる」ものだけを権利の除外として出す（場所次第で通るものは候補側で扱う）。
    const anyPlaceVerdicts = model.runtime.places.map((place) => evaluateModelRights(model, rightsContextFromTraits(traits, place), { catalog }));
    if (anyPlaceVerdicts.length > 0 && anyPlaceVerdicts.every((verdict) => !verdict.allowed)) {
      const reasons = new Map();
      for (const verdict of anyPlaceVerdicts) for (const item of verdict.blocks) reasons.set(item.code, item);
      blockedByRights.push({ modelId: model.id, modelName: model.name, blocks: [...reasons.values()] });
      continue;
    }
    if (relevant && model.fit.artStyles.includes(traits.artStyle) && usable.length === 0) {
      notRunnable.push({
        modelId: model.id,
        modelName: model.name,
        reasons: [...infeasible.map((item) => `${item.place}: ${item.reason}`), ...blocked.map((item) => `${item.place}: ${item.verdict.blocks.map((b) => b.message).join(" ")}`)],
      });
    }
  }
  return { blockedByRights, notRunnable };
}

function candidateLabel(index) {
  return ["本命", "予備", "比較"][index] || `候補${index + 1}`;
}

/**
 * traits から候補を2〜3案返す。
 * 返すもの: 動画の構成・ワークフロー・モデル（本番の画像・下書き・量のカット・動画）・実行場所・理由・注意、
 * 外したモデルと理由、使える高速化、10カット試験の段取り。
 */
export function selectConfig(rawTraits, { catalog = loadOptimalConfigCatalog() } = {}) {
  const traits = assertChannelTraits(rawTraits);
  const warnings = [];
  const videoConfigs = selectVideoConfigs(catalog, traits);
  const exclusions = excludedModels(catalog, traits);
  const blockedIds = new Set(exclusions.blockedByRights.map((item) => item.modelId));
  const workflows = selectImageWorkflows(catalog, traits, { blockedModelIds: blockedIds });

  const allowedPlaces = traits.confidentialAssets ? LOCAL_PLACES : null;
  if (traits.confidentialAssets) warnings.push("外に出せない素材があるので、手元（operator-mac / operator-cuda）の経路だけから選んだ。");

  const primaries = rankModels(catalog, traits, "image-primary", { allowedPlaces });
  const drafts = rankModels(catalog, traits, "image-draft", { allowedPlaces: LOCAL_PLACES });
  const wantsBulk = traits.lengthMinutes >= BULK_MIN_LENGTH_MINUTES;
  const bulks = wantsBulk ? rankModels(catalog, traits, "image-bulk", { allowedPlaces: allowedPlaces || new Set(["operator-mac", "operator-cuda", "operator-rented-gpu"]) }) : [];
  const videos = traits.motion !== "stills-camera" ? rankModels(catalog, traits, "video-i2v", { allowedPlaces }) : [];
  const lowBudget = Number.isFinite(traits.budgetMonthlyJpy) && traits.budgetMonthlyJpy <= 10000;

  if (primaries.length === 0) {
    warnings.push("本番の画像に使えるモデルが構成表に無い（権利か機材で全部止まった）。外したモデルの理由を見て、機材・契約・素材の条件を見直す。");
  }
  if (traits.motion !== "stills-camera" && videos.length === 0) {
    warnings.push("動画のカットに使えるモデルが無い。借り GPU（hardware.cloudGpu）か動画の契約を足すか、動きを stills-camera に戻す。");
  }
  if (traits.budgetMonthlyJpy === null) warnings.push("月の予算が未設定。試験の前に上限を決める（10カット試験は上限の中で行う）。");

  const candidates = [];
  const count = Math.min(3, Math.max(primaries.length, Math.min(2, videos.length)));
  for (let index = 0; index < count; index += 1) {
    const primary = primaries[index] || primaries[0];
    if (!primary) break;
    const draft = drafts.find((row) => row.model.id !== primary.model.id) || null;
    const bulk = bulks.find((row) => row.model.id !== primary.model.id) || null;
    const video = videos.length > 0 ? videos[Math.min(index, videos.length - 1)] : null;
    const models = {
      imagePrimary: pick(primary, "image-primary"),
      imageDraft: pick(draft, "image-draft"),
      imageBulk: pick(bulk, "image-bulk"),
      video: pick(video, "video-i2v"),
    };
    const key = [models.imagePrimary?.modelId, models.video?.modelId].join("|");
    if (candidates.some((candidate) => candidate.key === key)) continue;
    const reasons = [];
    reasons.push(`本番の画像は ${primary.model.name}（${primary.place}）。${primary.place === "operator-service" ? "既に払っている契約の中で動く。" : LOCAL_PLACES.has(primary.place) ? "手元で動き、追加の現金がかからない。" : "使う日だけ GPU を借りる。"}`);
    if (draft) reasons.push(`下書き・候補出しは ${draft.model.name}（${draft.place}）。${primary.place === "operator-service" ? "本番の経路が利用上限（429）に当たっている間に候補を先に作る。" : "本番の前に構図と候補を無料で絞る。"}`);
    if (bulk) reasons.push(`量のカット（背景・小物・繰り返し）は ${bulk.model.name}（${bulk.place}）でまとめて作る。1話分を一度に作り、終わったら止める。`);
    if (video) reasons.push(`動画のカットは ${video.model.name}（${video.place}）。先頭画像を合格にしてから動かす。`);
    if (lowBudget) reasons.push("予算が月1万円以内なので、下書きは手元で無料に作り、良いものだけ有料で仕上げる。生成の前に回ごとの見積もりを出す。");
    const runtimePlaces = [...new Set(Object.values(models).filter(Boolean).map((item) => item.place))];
    candidates.push({
      key,
      id: String.fromCharCode(65 + candidates.length),
      label: candidateLabel(candidates.length),
      videoConfigs: { base: videoConfigs.base, overlays: videoConfigs.overlays, clips: videoConfigs.clips },
      imageWorkflows: workflows.selected.map((item) => item.id),
      models,
      runtimePlaces,
      reasons,
      gpuCleanup: runtimePlaces.includes("operator-rented-gpu")
        ? "借り GPU は、生成が終わったら止め、止めた後の保存費を確かめるところまでを工程に入れる。"
        : null,
    });
  }
  if (candidates.length < 2) warnings.push("候補が1案しか作れない。比べる相手が無いので、機材・契約の条件を見直すか、この1案を10カットで確かめる。");

  return {
    version: SELECT_CONFIG_VERSION,
    catalogVersion: catalog.version,
    catalogAsOf: catalog.as_of,
    reproduced: false,
    channelId: traits.channelId,
    videoConfigs,
    imageWorkflows: workflows,
    candidates: candidates.map(({ key, ...candidate }) => candidate),
    excludedModels: exclusions,
    accelerations: selectAccelerations(catalog, traits),
    trial: {
      cutCount: TRIAL_CUT_COUNT,
      typicalCuts: 5,
      hardCuts: 5,
      next: "同じ10カット（典型5＋難しい5）で候補を比べ、採用秒率・採用1秒あたりの現金・採用1秒あたりの人の時間で決める。本番1案と予備1案を Channel Pack に記録する。",
    },
    warnings,
    note: "候補は調査資料からの当てはめで、まだ誰も動かしていない。実際に生成してお金を使う前に、運営者の確認をもらう。",
  };
}

