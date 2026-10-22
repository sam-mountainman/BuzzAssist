// チャンネルの性格（traits）——最適構成エンジンの入力。
//
// 「このチャンネルは、どんな絵で、何を固定したくて、どれだけ動かしたくて、予算と機材はいくらか、
// 外に出せない素材はあるか」を1つの形で持つ。エンジンはここから R・W・モデル・実行場所を選ぶ。
//
// 置き場所は Channel Pack（config/channel-traits.json）。チャンネル固有のものなので、
// 公開リポジトリには例（examples/optimal-config/traits/）だけを置く。
// Channel Pack に traits が無くても、絵の種類だけは画風プロファイル（channel-visual-profiles.json）
// の文章から推定できる。ただし推定した欄は inferred に名前を残し、確定した値と混ぜない。

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { resolveChannelPackSource } from "../channelPackResolver.mjs";
import { getChannelVisualProfile, normalizeChannelVisualProfileStore } from "../channelVisualProfile.mjs";

export const CHANNEL_TRAITS_VERSION = "channel-traits-v1";
export const CHANNEL_TRAITS_PACK_PATH = "config/channel-traits.json";

export const ART_STYLES = Object.freeze(["flat-2d-manga", "anime", "photoreal", "diagram-mascot", "ai-footage", "live-footage"]);
export const IDENTITY_LOCKS = Object.freeze(["none", "mascot", "fixed-cast", "person+wardrobe"]);
export const MOTIONS = Object.freeze(["stills-camera", "few-clips", "mostly-video"]);
export const PUBLISH_SCOPES = Object.freeze(["worldwide", "japan-only"]);
export const PRIORITIES = Object.freeze(["balanced", "quality-deadline", "lowest-cost"]);

const LABELS = {
  artStyle: "絵の種類",
  identityLock: "固定したいもの",
  motion: "動きの量",
  budgetMonthlyJpy: "月の予算（円）",
  hardware: "機材",
  confidentialAssets: "外に出せない素材",
  aspect: "縦横比",
  lengthMinutes: "尺（分）",
};

/** traits の JSON Schema（draft 2020-12）。検査は validateChannelTraits と同じ規則。 */
export const CHANNEL_TRAITS_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://buzzassist.local/schemas/channel-traits-v1.json",
  title: "チャンネルの性格（最適構成エンジンの入力）",
  type: "object",
  required: ["version", "channelId", "artStyle", "identityLock", "motion", "budgetMonthlyJpy", "hardware", "confidentialAssets", "aspect", "lengthMinutes"],
  properties: {
    version: { const: CHANNEL_TRAITS_VERSION },
    channelId: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,63}$" },
    artStyle: { enum: [...ART_STYLES] },
    identityLock: { enum: [...IDENTITY_LOCKS] },
    motion: { enum: [...MOTIONS] },
    budgetMonthlyJpy: { type: ["number", "null"], minimum: 0 },
    hardware: {
      type: "object",
      required: ["mac", "cudaVramGiB", "cloudGpu", "contracts"],
      properties: {
        mac: { type: ["object", "null"], required: ["memoryGiB"], properties: { memoryGiB: { type: "number", exclusiveMinimum: 0 } } },
        cudaVramGiB: { type: "number", minimum: 0 },
        cloudGpu: { type: "boolean" },
        contracts: { type: "array", items: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$" }, uniqueItems: true },
      },
      additionalProperties: false,
    },
    confidentialAssets: { type: "boolean" },
    aspect: { type: "string", pattern: "^\\d{1,2}:\\d{1,2}$" },
    lengthMinutes: { type: "number", exclusiveMinimum: 0 },
    publishScope: { enum: [...PUBLISH_SCOPES] },
    priority: { enum: [...PRIORITIES] },
    annualRevenueUsd: { type: ["number", "null"], minimum: 0 },
    notes: { type: "string" },
  },
  additionalProperties: false,
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * traits を検査する。止まった理由は日本語で、どの欄かが分かる形で返す。
 * 黙って既定値で埋めない（足りない欄は足りないと返す）。
 */
export function validateChannelTraits(traits) {
  const errors = [];
  const push = (field, message) => errors.push({ field, message });
  if (!isPlainObject(traits)) {
    return { ok: false, errors: [{ field: "", message: "traits が JSON のオブジェクトではない。" }] };
  }
  const allowed = new Set(Object.keys(CHANNEL_TRAITS_SCHEMA.properties));
  for (const key of Object.keys(traits)) {
    if (!allowed.has(key)) push(key, `知らない欄 ${key} がある（綴りの間違いなら直す）。`);
  }
  if (traits.version !== CHANNEL_TRAITS_VERSION) push("version", `version は ${CHANNEL_TRAITS_VERSION} にする。`);
  if (typeof traits.channelId !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(traits.channelId)) {
    push("channelId", "channelId は英小文字・数字・ハイフンの id にする（表示名や依頼者の名前は入れない）。");
  }
  const enumField = (field, values) => {
    if (traits[field] === undefined) push(field, `${LABELS[field]}（${field}）が無い。${values.join(" / ")} のどれかを書く。`);
    else if (!values.includes(traits[field])) push(field, `${LABELS[field]}（${field}）の値 ${JSON.stringify(traits[field])} は使えない。${values.join(" / ")} のどれか。`);
  };
  enumField("artStyle", ART_STYLES);
  enumField("identityLock", IDENTITY_LOCKS);
  enumField("motion", MOTIONS);
  if (!("budgetMonthlyJpy" in traits)) push("budgetMonthlyJpy", "月の予算（budgetMonthlyJpy）が無い。決まっていなければ null と書く。");
  else if (traits.budgetMonthlyJpy !== null && (!finiteNumber(traits.budgetMonthlyJpy) || traits.budgetMonthlyJpy < 0)) {
    push("budgetMonthlyJpy", "月の予算は 0 以上の数（円）か null。");
  }
  const hardware = traits.hardware;
  if (!isPlainObject(hardware)) {
    push("hardware", "機材（hardware）が無い。{ mac, cudaVramGiB, cloudGpu, contracts } を書く。");
  } else {
    for (const key of Object.keys(hardware)) {
      if (!["mac", "cudaVramGiB", "cloudGpu", "contracts"].includes(key)) push(`hardware.${key}`, `知らない欄 hardware.${key} がある。`);
    }
    if (!("mac" in hardware)) push("hardware.mac", "hardware.mac が無い。Mac を使わないなら null。");
    else if (hardware.mac !== null && (!isPlainObject(hardware.mac) || !finiteNumber(hardware.mac.memoryGiB) || hardware.mac.memoryGiB <= 0)) {
      push("hardware.mac", "hardware.mac は { memoryGiB: 16 } の形（統合メモリの GiB）か null。");
    }
    if (!finiteNumber(hardware.cudaVramGiB) || hardware.cudaVramGiB < 0) push("hardware.cudaVramGiB", "hardware.cudaVramGiB は手元の NVIDIA GPU の VRAM（GiB）。無ければ 0。");
    if (typeof hardware.cloudGpu !== "boolean") push("hardware.cloudGpu", "hardware.cloudGpu は、使う日だけ GPU を借りてよいかを true / false で。");
    if (!Array.isArray(hardware.contracts) || hardware.contracts.some((value) => typeof value !== "string" || !/^[a-z0-9][a-z0-9-]*$/u.test(value))) {
      push("hardware.contracts", "hardware.contracts は契約しているサービスの id の配列（例: chatgpt, codex, grok, google-ai）。");
    } else if (new Set(hardware.contracts).size !== hardware.contracts.length) {
      push("hardware.contracts", "hardware.contracts に同じ id が2回ある。");
    }
  }
  if (typeof traits.confidentialAssets !== "boolean") push("confidentialAssets", "外に出せない素材（confidentialAssets）を true / false で書く。");
  if (typeof traits.aspect !== "string" || !/^\d{1,2}:\d{1,2}$/u.test(traits.aspect)) push("aspect", "縦横比（aspect）は 16:9 のように書く。");
  if (!finiteNumber(traits.lengthMinutes) || traits.lengthMinutes <= 0) push("lengthMinutes", "尺（lengthMinutes）は 1本の長さの目安（分、0 より大きい数）。");
  if (traits.publishScope !== undefined && !PUBLISH_SCOPES.includes(traits.publishScope)) push("publishScope", `publishScope は ${PUBLISH_SCOPES.join(" / ")} のどれか。`);
  if (traits.priority !== undefined && !PRIORITIES.includes(traits.priority)) push("priority", `priority は ${PRIORITIES.join(" / ")} のどれか。`);
  if (traits.annualRevenueUsd !== undefined && traits.annualRevenueUsd !== null && (!finiteNumber(traits.annualRevenueUsd) || traits.annualRevenueUsd < 0)) {
    push("annualRevenueUsd", "annualRevenueUsd は関連会社を含む年売上（米ドル）か null。");
  }
  if (traits.notes !== undefined && typeof traits.notes !== "string") push("notes", "notes は文字列。");
  return { ok: errors.length === 0, errors };
}

/** 検査して、通らなければ理由を並べて止める。通れば省略可能な欄に既定値を入れた写しを返す。 */
export function assertChannelTraits(traits) {
  const { ok, errors } = validateChannelTraits(traits);
  if (!ok) {
    const error = new Error(`チャンネルの性格（traits）が足りない・おかしい:\n${errors.map((item) => `- ${item.field ? `${item.field}: ` : ""}${item.message}`).join("\n")}`);
    error.code = "CHANNEL_TRAITS_INVALID";
    error.errors = errors;
    throw error;
  }
  return {
    ...traits,
    hardware: { ...traits.hardware, contracts: [...traits.hardware.contracts] },
    publishScope: traits.publishScope ?? "worldwide",
    priority: traits.priority ?? "balanced",
    annualRevenueUsd: traits.annualRevenueUsd ?? null,
  };
}

/** Channel Pack の JSON（またはその一部）から traits を取り出す。無ければ null。 */
export function traitsFromChannelPack(pack) {
  if (!isPlainObject(pack)) return null;
  if (pack.version === CHANNEL_TRAITS_VERSION) return pack;
  if (isPlainObject(pack.channelTraits)) return pack.channelTraits;
  if (isPlainObject(pack.optimalConfig?.traits)) return pack.optimalConfig.traits;
  return null;
}

const ART_STYLE_HINTS = [
  { artStyle: "diagram-mascot", pattern: /(diagram|infographic|図解|インフォグラフィック|チャート)/iu },
  { artStyle: "flat-2d-manga", pattern: /(manga|comic|漫画|マンガ|コマ)/iu },
  { artStyle: "anime", pattern: /(anime|アニメ|cel[- ]?shad)/iu },
  { artStyle: "photoreal", pattern: /(photoreal|photo-?realistic|photograph|実写調|写真|フォトリアル)/iu },
  { artStyle: "live-footage", pattern: /(live[- ]footage|実写素材|撮影素材|原資料)/iu },
  { artStyle: "ai-footage", pattern: /(ai[- ]footage|ai映像|生成映像)/iu },
];

/** 画風プロファイルの文章から絵の種類を推定する。当たらなければ空文字（推定しない）。 */
export function inferArtStyleFromVisualProfile(profile) {
  if (!isPlainObject(profile)) return "";
  const corpus = [profile.name, profile.stylePrompt, profile.compositionPrompt, profile.outputPrompt]
    .filter((value) => typeof value === "string")
    .join("\n");
  if (!corpus.trim()) return "";
  const hit = ART_STYLE_HINTS.find(({ pattern }) => pattern.test(corpus));
  return hit ? hit.artStyle : "";
}

function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

/**
 * traits を読む。順番:
 *   1. traitsPath（明示したファイル。Channel Pack の JSON 全体でもよい）
 *   2. Channel Pack の config/channel-traits.json（合成 fixture は使わない）
 * 絵の種類が無く、画風プロファイルがあれば、そこから推定して inferred に残す。
 * 返す source は、どこから読んだか（Channel Pack・明示ファイル・無し）。
 */
export function readChannelTraits({ projectDir = process.cwd(), packId = "", traitsPath = "", visualProfile = null, visualProfileStore = null, visualProfileId = "" } = {}) {
  let raw = null;
  let source = { kind: "none", path: "" };
  if (traitsPath) {
    const resolved = path.resolve(traitsPath);
    raw = traitsFromChannelPack(readJsonFile(resolved));
    source = { kind: "file", path: resolved };
    if (!raw) throw new Error(`${resolved} に traits（version: ${CHANNEL_TRAITS_VERSION}、channelTraits、optimalConfig.traits のどれか）が無い。`);
  } else {
    const located = resolveChannelPackSource(projectDir, CHANNEL_TRAITS_PACK_PATH, packId, { includeFixture: false });
    if (located.kind !== "legacy" && existsSync(located.path)) {
      raw = traitsFromChannelPack(readJsonFile(located.path));
      source = { kind: `channel-pack:${located.kind}`, path: located.path };
    }
  }
  const traits = raw ? { ...raw } : {};
  const inferred = [];
  const profile = visualProfile
    ?? (visualProfileStore ? getChannelVisualProfile(normalizeChannelVisualProfileStore(visualProfileStore), visualProfileId) : null);
  if (traits.artStyle === undefined && profile) {
    const artStyle = inferArtStyleFromVisualProfile(profile);
    if (artStyle) {
      traits.artStyle = artStyle;
      inferred.push({ field: "artStyle", from: `画風プロファイル ${profile.id || ""}`.trim(), value: artStyle });
    }
  }
  const validation = validateChannelTraits(traits);
  return { traits, source, inferred, validation };
}
