// 台本駆動の衣装ゲート（wardrobe-readiness v1）。
//
// 台本に「プール」「葬儀」「寝間着」「雪の屋外」のような服を変える場面があっても、
// これまでは固定キャストがベース衣装のまま（あるいは画像ごとに思いつきの服で）
// 有料の画像生成へ進んでいた。漫画動画は1カットを数秒以上ホールドするので、
// 固定キャストの服は必ず見える。ここでは画像生成の前に、場面ごとに
// 「登場する固定キャストの登録済みの服で、その場面の要求を満たせるか」を照合する。
//
// 仕様は docs/manga-wardrobe-readiness-spec-ja.md（2.1 と 3、6 の決定）。
//
// このファイルは入力だけで答えが決まる関数だけを置く（ファイルもネットワークも
// 触らない）。契約の検証（koyaMangaProductionContract）からも読むので、外部
// パッケージも制作モジュールも import しない。読み書きは koyaMangaProduction が持つ。
//
// 判定の骨格:
//   - 場面 = 場面台本の場面番号（#場面 N）。旧形式の台本では各カット。
//   - 場面の属性は、見出し（カット目的）とナレーション行からだけ取る。台詞は見ない。
//     「プールに行こうよ」という台詞は、その場面がプールである根拠にならない。
//   - 照合の対象は、台帳でチャンネル共通の承認済み人物（エピソード専用・場所・小物は除く）
//     のうち、その場面で話す人物と、ナレーションに名前（別名）が出る人物。
//   - 場面タグはキーワードで検出する。コードは特別な場面（formal / swim / sleep /
//     winter-out / summer-out）の汎用キーワードだけを持つ。daily / work / home は、
//     Channel Pack がキーワードを足さない限り検出されない（＝スロットを作らない）。
//   - ベース衣装は show bible cast[].baseOutfitSceneTags（既定 daily/work/home）を覆い、
//     台帳の衣装（role "outfit"）は自分の sceneTags を覆う。
//   - どの服も覆わない場面タグが pending スロットになる。同じ人物×同じタグは1話で1つ。
//   - 1つの場面で特別なタグが2つ以上出て、両方を覆う服が無いときは機械で決めない
//     （undecidable）。v1 は LLM を使わず、生成とは別コンテキストのレビュー記録
//     （koya-wardrobe-review-v1）でだけ解決する。

import { createHash } from "node:crypto";

import { assertKoyaIndependentEvaluator } from "./koyaMangaProvenance.mjs";

export const KOYA_WARDROBE_READINESS_VERSION = "koya-wardrobe-readiness-v1";
export const KOYA_WARDROBE_REVIEW_VERSION = "koya-wardrobe-review-v1";
export const KOYA_WARDROBE_FINAL_AUDIT_VERSION = "koya-wardrobe-readiness-final-audit-v1";
export const KOYA_WARDROBE_READINESS_REQUIRED_CODE = "KOYA_WARDROBE_READINESS_REQUIRED";
export const KOYA_WARDROBE_REVIEW_INVALID_CODE = "KOYA_WARDROBE_REVIEW_INVALID";
export const KOYA_WARDROBE_POLICY_INVALID_CODE = "KOYA_WARDROBE_POLICY_INVALID";
export const KOYA_WARDROBE_READINESS_FILE_NAME = "wardrobe-readiness.json";
// この保証が入った契約の版。harness 宣言の inForceSince と契約の同名項目も同じ値。
export const KOYA_WARDROBE_READINESS_IN_FORCE_SINCE = "koya-manga-production-v53";
export const MINIMUM_WARDROBE_TEXT_LENGTH = 4;

export const KOYA_WARDROBE_SCENE_TAGS = Object.freeze([
  "daily", "work", "home", "formal", "swim", "sleep", "winter-out", "summer-out",
]);
export const KOYA_WARDROBE_BASE_OUTFIT_SCENE_TAGS = Object.freeze(["daily", "work", "home"]);
// 汎用のキーワードを持つ（＝既定で検出される）のはこの5つだけ。
export const KOYA_WARDROBE_DEFAULT_DETECTED_SCENE_TAGS = Object.freeze([
  "formal", "swim", "sleep", "winter-out", "summer-out",
]);
export const KOYA_WARDROBE_DEFAULT_SCENE_TAG_KEYWORDS = Object.freeze({
  formal: Object.freeze(["葬儀", "通夜", "告別式", "結婚式", "披露宴", "式典", "パーティー"]),
  swim: Object.freeze(["プール", "海水浴", "水着"]),
  sleep: Object.freeze(["パジャマ", "寝間着", "寝巻き", "就寝", "布団"]),
  "winter-out": Object.freeze(["雪", "吹雪", "真冬の屋外"]),
  "summer-out": Object.freeze(["夏祭り", "浴衣", "花火大会"]),
});

const SCENE_TAG_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const CONTRACT_VERSION_PATTERN = /^(?<series>.+)-v(?<number>\d+)$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REVIEW_KEYS = Object.freeze(["decisions", "episodeId", "inventoryDigest", "note", "reviewedAt", "reviewer", "scriptDigest", "version"]);
const REVIEW_DECISION_KEYS = Object.freeze(["decision", "outfit", "reason", "slotId"]);
const REVIEWER_HOSTS = Object.freeze(["codex", "claude", "human"]);
const WARDROBE_SECTION_KEYS = Object.freeze(["note", "sceneTagKeywords", "sceneTagVocabulary"]);
const MAXIMUM_KEYWORD_LENGTH = 40;
const UNRESOLVED_STATUSES = new Set(["pending", "undecidable"]);

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function plain(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unique(values) {
  return [...new Set(values)];
}

function charLength(value) {
  return Array.from(text(value)).length;
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!plain(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

export function koyaWardrobeDigest(value) {
  return sha256Hex(JSON.stringify(stableValue(value)));
}

/** 画像計画の scriptSha256 と同じ定義（台本の生テキストの SHA-256）。 */
export function koyaWardrobeScriptDigest(scriptText) {
  return sha256Hex(String(scriptText ?? ""));
}

function policyError(message) {
  const error = new Error(`wardrobe-readiness policy is invalid: ${message}`);
  error.code = KOYA_WARDROBE_POLICY_INVALID_CODE;
  return error;
}

function contractSeriesNumber(version) {
  const match = CONTRACT_VERSION_PATTERN.exec(text(version));
  return match ? { series: match.groups.series, number: Number(match.groups.number) } : null;
}

/**
 * 契約の wardrobeReadiness 節の意味検査（スキーマで閉じた上での追加の整合）。
 * 形の検査はスキーマが持つ。ここではコードの定数との一致と、inForceSince が
 * 現行の契約と同じ系列でそれ以前の版であることを見る。
 */
export function validateKoyaWardrobeReadinessContract(contract) {
  const failures = [];
  const fail = (path, message) => failures.push({ path: `wardrobeReadiness.${path}`, message });
  const section = contract?.wardrobeReadiness;
  if (!plain(section)) {
    failures.push({ path: "wardrobeReadiness", message: "must declare the pre-generation wardrobe-readiness gate" });
    return failures;
  }
  if (section.version !== KOYA_WARDROBE_READINESS_VERSION) fail("version", `must equal ${KOYA_WARDROBE_READINESS_VERSION}`);
  if (section.reviewVersion !== KOYA_WARDROBE_REVIEW_VERSION) fail("reviewVersion", `must equal ${KOYA_WARDROBE_REVIEW_VERSION}`);
  const since = contractSeriesNumber(section.inForceSince);
  const current = contractSeriesNumber(contract?.version);
  if (!since) fail("inForceSince", "must be a contract version such as koya-manga-production-v53");
  else if (current && (since.series !== current.series || since.number > current.number)) {
    fail("inForceSince", `must be ${current.series}-vN with N <= ${current.number}`);
  }
  const sameList = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  if (!sameList(section.sceneTagVocabulary, KOYA_WARDROBE_SCENE_TAGS)) {
    fail("sceneTagVocabulary", `must equal ${KOYA_WARDROBE_SCENE_TAGS.join(", ")}; channel packs extend it in the show bible`);
  }
  if (!sameList(section.baseOutfitSceneTags, KOYA_WARDROBE_BASE_OUTFIT_SCENE_TAGS)) {
    fail("baseOutfitSceneTags", `must equal ${KOYA_WARDROBE_BASE_OUTFIT_SCENE_TAGS.join(", ")}`);
  }
  if (!sameList(section.defaultDetectedSceneTags, KOYA_WARDROBE_DEFAULT_DETECTED_SCENE_TAGS)) {
    fail("defaultDetectedSceneTags", `must equal ${KOYA_WARDROBE_DEFAULT_DETECTED_SCENE_TAGS.join(", ")}`);
  }
  if (section.requirePassReportBeforeImages !== true) fail("requirePassReportBeforeImages", "paid images must wait for a pass report");
  if (section.bindReportToScriptDigest !== true) fail("bindReportToScriptDigest", "a script change must invalidate the report");
  if (section.requireIndependentReviewerContext !== true) fail("requireIndependentReviewerContext", "reviews must come from another context");
  if (section.allowModelJudgment !== false) fail("allowModelJudgment", "v1 decides undecidable slots only through a review file");
  if (section.operatorOverrideRequiresReason !== true) fail("operatorOverrideRequiresReason", "an override must carry a reason");
  return failures;
}

function tagList(value, vocabulary, label) {
  if (!Array.isArray(value)) throw policyError(`${label} must be an array of scene tags`);
  const tags = value.map(text);
  const unknown = tags.filter((tag) => !vocabulary.includes(tag));
  if (unknown.length > 0) throw policyError(`${label} uses tags outside the vocabulary: ${unknown.join(", ")}`);
  return unique(tags);
}

/**
 * show bible から照合の方針を作る。
 *
 * show bible（Channel Pack）が持てるもの:
 *   wardrobe.sceneTagVocabulary: [tag]           既定の8語に足すタグ
 *   wardrobe.sceneTagKeywords: { tag: [keyword] } 既定のキーワードに足すもの
 *   cast[].baseOutfitSceneTags: [tag]            ベース衣装が覆うタグ（既定 daily/work/home）
 *   cast[].defaultOutfit: "asset id か storyStage" タグの無い場面で着る登録済み衣装
 *   cast[].outfitStages[].sceneTags: [tag]       登録済み衣装（storyStage が同じもの）が覆うタグ
 * 形が壊れていれば止める（黙って既定に戻すと、書いた宣言が効かないまま通る）。
 */
export function resolveKoyaWardrobePolicy(showBible) {
  const section = showBible?.wardrobe;
  if (section !== undefined && !plain(section)) throw policyError("show bible wardrobe must be an object");
  const unknownKeys = Object.keys(section || {}).filter((key) => !WARDROBE_SECTION_KEYS.includes(key));
  if (unknownKeys.length > 0) throw policyError(`show bible wardrobe has unknown keys: ${unknownKeys.join(", ")}`);
  const extraTags = section?.sceneTagVocabulary === undefined ? [] : section.sceneTagVocabulary;
  if (!Array.isArray(extraTags)) throw policyError("wardrobe.sceneTagVocabulary must be an array");
  for (const tag of extraTags) {
    if (!SCENE_TAG_PATTERN.test(text(tag)) || text(tag) !== tag) {
      throw policyError(`wardrobe.sceneTagVocabulary entry ${JSON.stringify(tag)} must be a lowercase slug`);
    }
  }
  const vocabulary = unique([...KOYA_WARDROBE_SCENE_TAGS, ...extraTags]);
  const keywords = Object.fromEntries(Object.entries(KOYA_WARDROBE_DEFAULT_SCENE_TAG_KEYWORDS).map(([tag, list]) => [tag, [...list]]));
  const packKeywords = section?.sceneTagKeywords === undefined ? {} : section.sceneTagKeywords;
  if (!plain(packKeywords)) throw policyError("wardrobe.sceneTagKeywords must be an object of tag -> keywords");
  for (const [tag, list] of Object.entries(packKeywords)) {
    if (!vocabulary.includes(tag)) throw policyError(`wardrobe.sceneTagKeywords.${tag} is not in the scene tag vocabulary`);
    if (!Array.isArray(list) || list.length === 0) throw policyError(`wardrobe.sceneTagKeywords.${tag} must be a non-empty array`);
    for (const keyword of list) {
      if (!text(keyword) || charLength(keyword) > MAXIMUM_KEYWORD_LENGTH) {
        throw policyError(`wardrobe.sceneTagKeywords.${tag} entries must be non-empty strings of at most ${MAXIMUM_KEYWORD_LENGTH} characters`);
      }
    }
    keywords[tag] = unique([...(keywords[tag] || []), ...list.map(text)]);
  }
  for (const tag of Object.keys(keywords)) keywords[tag] = [...keywords[tag]].sort();
  const cast = [];
  for (const member of Array.isArray(showBible?.cast) ? showBible.cast : []) {
    const memberId = text(member?.id);
    if (!memberId) continue;
    const baseOutfitSceneTags = member.baseOutfitSceneTags === undefined
      ? [...KOYA_WARDROBE_BASE_OUTFIT_SCENE_TAGS]
      : tagList(member.baseOutfitSceneTags, vocabulary, `cast ${memberId}.baseOutfitSceneTags`);
    if (member.defaultOutfit !== undefined && !text(member.defaultOutfit)) {
      throw policyError(`cast ${memberId}.defaultOutfit must name a registered outfit asset id or storyStage`);
    }
    const stageSceneTags = {};
    for (const stage of Array.isArray(member.outfitStages) ? member.outfitStages : []) {
      if (stage?.sceneTags === undefined) continue;
      const stageId = text(stage?.id);
      if (!stageId) throw policyError(`cast ${memberId}.outfitStages entries with sceneTags need an id`);
      stageSceneTags[stageId] = tagList(stage.sceneTags, vocabulary, `cast ${memberId}.outfitStages.${stageId}.sceneTags`);
    }
    cast.push({
      memberId,
      names: unique([memberId, text(member.name), text(member.hiddenName)].filter(Boolean)),
      baseOutfitSceneTags,
      defaultOutfit: text(member.defaultOutfit),
      stageSceneTags,
    });
  }
  const detectedTags = vocabulary.filter((tag) => (keywords[tag] || []).length > 0);
  const policy = {
    vocabulary,
    detectedTags,
    keywords,
    declaredInShowBible: section !== undefined,
    cast,
  };
  return { ...policy, digest: koyaWardrobeDigest(policy) };
}

function castPolicyFor(policy, character) {
  const names = unique([character.id, character.name, ...(character.aliases || [])].map(text).filter(Boolean));
  return policy.cast.find((member) => member.memberId === character.id)
    || policy.cast.find((member) => member.names.some((name) => names.includes(name)))
    || null;
}

/** 台帳でチャンネル共通の承認済み人物（エピソード専用・場所・小物は照合しない）。 */
export function koyaWardrobeCheckedCharacters(registry) {
  return (Array.isArray(registry?.characters) ? registry.characters : []).filter((character) => (
    text(character?.id)
    && (character.kind === undefined || character.kind === "character")
    && (character.status === undefined || character.status === "approved")
    && !text(character.episodeId)
  ));
}

function isNarration(utterance) {
  return utterance?.speakerId === "narration" || utterance?.preset === "narration";
}

/**
 * 場面の一覧。場面台本（#場面 N）なら場面番号ごと、旧形式ならカットごと。
 * 属性の出所は見出し（またはカット目的）とナレーション行だけ。
 */
export function koyaWardrobeScenes(parsed) {
  const cuts = Array.isArray(parsed?.cuts) ? parsed.cuts : [];
  const utterances = Array.isArray(parsed?.utterances) && parsed.utterances.length > 0
    ? parsed.utterances
    : cuts.flatMap((cut) => (Array.isArray(cut?.utterances) ? cut.utterances : []));
  const byCut = new Map();
  for (const utterance of utterances) {
    const cutId = text(utterance?.cutId);
    if (!byCut.has(cutId)) byCut.set(cutId, []);
    byCut.get(cutId).push(utterance);
  }
  const scenes = [];
  const usedKeys = new Map();
  for (const cut of cuts) {
    const cutId = text(cut?.id);
    if (!cutId) continue;
    const info = plain(cut.scene) && Number.isFinite(Number(cut.scene.number)) ? cut.scene : null;
    const previous = scenes.at(-1);
    const heading = text(info ? info.heading : cut.purpose);
    if (info && previous?.scriptScene && previous.sceneNumber === Number(info.number) && previous.heading === heading) {
      previous.cutIds.push(cutId);
      previous.utterances.push(...(byCut.get(cutId) || []));
      continue;
    }
    const baseKey = info ? `scene-${Number(info.number)}` : cutId;
    const count = (usedKeys.get(baseKey) || 0) + 1;
    usedKeys.set(baseKey, count);
    const headingSources = [];
    if (heading) headingSources.push({ source: info ? "scene-heading" : "cut-purpose", text: heading });
    if (info) {
      for (const [source, value] of [["scene-place", info.place], ["scene-time", info.timeOfDay]]) {
        if (text(value) && !heading.includes(text(value))) headingSources.push({ source, text: text(value) });
      }
    }
    scenes.push({
      sceneKey: count === 1 ? baseKey : `${baseKey}-${count}`,
      scriptScene: Boolean(info),
      sceneNumber: info ? Number(info.number) : null,
      heading,
      cutIds: [cutId],
      headingSources,
      utterances: [...(byCut.get(cutId) || [])],
    });
  }
  return scenes.map((scene) => ({
    sceneKey: scene.sceneKey,
    sceneNumber: scene.sceneNumber,
    heading: scene.heading,
    cutIds: scene.cutIds,
    attributeSources: [
      ...scene.headingSources,
      ...scene.utterances.filter(isNarration).map((utterance) => ({ source: `narration:${text(utterance.id)}`, text: text(utterance.text) })),
    ].filter((entry) => entry.text),
    speakerIds: unique(scene.utterances.filter((utterance) => !isNarration(utterance)).map((utterance) => text(utterance.speakerId)).filter(Boolean)),
  }));
}

// 2文字以上の名前だけを伏せる・数える。1文字の別名（例「雪」）を伏せると、
// 本物の場面キーワードまで消えてしまう。
function significantNames(values) {
  return unique(values.map(text).filter((value) => charLength(value) >= 2))
    .sort((left, right) => charLength(right) - charLength(left) || left.localeCompare(right));
}

function maskNames(value, names) {
  let masked = String(value || "");
  for (const name of names) masked = masked.split(name).join("　");
  return masked;
}

function detectSceneTags(scene, policy, maskedNames) {
  const evidence = [];
  for (const source of scene.attributeSources) {
    const masked = maskNames(source.text, maskedNames);
    for (const tag of policy.detectedTags) {
      for (const keyword of policy.keywords[tag]) {
        if (masked.includes(keyword)) evidence.push({ tag, keyword, source: source.source });
      }
    }
  }
  const tags = policy.detectedTags.filter((tag) => evidence.some((entry) => entry.tag === tag));
  return { tags, evidence };
}

function outfitRecord(asset, castPolicy, vocabulary) {
  const registryTags = Array.isArray(asset.sceneTags) ? asset.sceneTags.map(text).filter(Boolean) : [];
  const stageTags = castPolicy?.stageSceneTags?.[text(asset.storyStage)] || [];
  const all = unique([...registryTags, ...stageTags]);
  return {
    kind: "outfit",
    assetId: text(asset.id),
    storyStage: text(asset.storyStage),
    sha256: text(asset.sha256),
    sceneTags: all.filter((tag) => vocabulary.includes(tag)),
    unknownSceneTags: all.filter((tag) => !vocabulary.includes(tag)),
    tagSources: unique([
      ...(registryTags.length > 0 ? ["registry"] : []),
      ...(stageTags.length > 0 ? ["show-bible-outfit-stage"] : []),
    ]),
  };
}

function wardrobeFor(character, policy) {
  const castPolicy = castPolicyFor(policy, character);
  const outfits = (Array.isArray(character.referenceAssets) ? character.referenceAssets : [])
    .filter((asset) => asset?.role === "outfit" && text(asset.id))
    .map((asset) => outfitRecord(asset, castPolicy, policy.vocabulary));
  const base = {
    kind: "base",
    sceneTags: castPolicy ? [...castPolicy.baseOutfitSceneTags] : [...KOYA_WARDROBE_BASE_OUTFIT_SCENE_TAGS],
  };
  let defaultOutfit = null;
  if (castPolicy?.defaultOutfit) {
    defaultOutfit = outfits.find((outfit) => outfit.assetId === castPolicy.defaultOutfit)
      || outfits.find((outfit) => outfit.storyStage === castPolicy.defaultOutfit)
      || null;
    if (!defaultOutfit) {
      throw policyError(`show bible cast ${castPolicy.memberId}.defaultOutfit "${castPolicy.defaultOutfit}" is not a registered outfit of ${character.id}`);
    }
  }
  return { castPolicy, outfits, base, defaultOutfit };
}

function outfitRef(outfit, source) {
  if (outfit.kind === "base") return { kind: "base", sceneTags: [...outfit.sceneTags], source };
  return {
    kind: "outfit",
    assetId: outfit.assetId,
    storyStage: outfit.storyStage,
    sha256: outfit.sha256,
    sceneTags: [...outfit.sceneTags],
    source,
  };
}

// 場面タグ（空でも可）を満たす服を1つ決める。順序は固定:
//   タグ無し: defaultOutfit → ベース衣装
//   タグ有り: 全タグを覆う defaultOutfit → 全タグを覆うベース衣装 → 全タグを覆う登録衣装（台帳の並び順）
// どれも覆わなければ null（スロットになる）。
function matchOutfit(tags, wardrobe) {
  if (tags.length === 0) {
    return wardrobe.defaultOutfit ? outfitRef(wardrobe.defaultOutfit, "default-outfit") : outfitRef(wardrobe.base, "base-outfit");
  }
  const covers = (sceneTags) => tags.every((tag) => sceneTags.includes(tag));
  if (wardrobe.defaultOutfit && covers(wardrobe.defaultOutfit.sceneTags)) return outfitRef(wardrobe.defaultOutfit, "default-outfit");
  if (covers(wardrobe.base.sceneTags)) return outfitRef(wardrobe.base, "base-outfit-scene-tags");
  const covering = wardrobe.outfits.filter((outfit) => covers(outfit.sceneTags));
  if (covering.length === 0) return null;
  return {
    ...outfitRef(covering[0], "outfit-scene-tags"),
    ...(covering.length > 1 ? { alternatives: covering.slice(1).map((outfit) => outfit.assetId) } : {}),
  };
}

function evidenceLabel(evidence) {
  return unique(evidence.map((entry) => `${entry.keyword}（${entry.source}）`)).join("、");
}

function requirementFor(tags, evidence, wardrobe) {
  const baseTags = wardrobe.base.sceneTags.join("/") || "なし";
  if (tags.length > 1) {
    return `場面タグ ${tags.join(" と ")} が同時に検出された（根拠: ${evidenceLabel(evidence)}）。`
      + "両方を覆う登録済みの服が無く、どちらの服を着るかを機械では決められない。別コンテキストのレビューで判定する。";
  }
  return `場面タグ ${tags[0]}（根拠: ${evidenceLabel(evidence)}）。`
    + `ベース衣装が覆うのは ${baseTags} で、sceneTags に ${tags[0]} を持つ登録済みの服が無い。`;
}

function reviewFailure(failures, message) {
  failures.push(message);
}

function resolveReviewOutfit(value, wardrobe) {
  const name = text(value);
  if (name === "base") return outfitRef(wardrobe.base, "review");
  const outfit = wardrobe.outfits.find((entry) => entry.assetId === name)
    || wardrobe.outfits.find((entry) => entry.storyStage === name);
  return outfit ? outfitRef(outfit, "review") : null;
}

/**
 * レビュー記録の検査。生成側のコンテキスト（エピソードの生成者、ゲートを
 * 実行したコンテキスト）と同じコンテキストが書いたレビューは受け取らない。
 */
export function validateKoyaWardrobeReview(review, context = {}) {
  const failures = [];
  if (!plain(review)) return ["review must be a JSON object"];
  const unknownKeys = Object.keys(review).filter((key) => !REVIEW_KEYS.includes(key));
  if (unknownKeys.length > 0) reviewFailure(failures, `unknown review keys: ${unknownKeys.join(", ")}`);
  if (review.version !== KOYA_WARDROBE_REVIEW_VERSION) reviewFailure(failures, `version must be ${KOYA_WARDROBE_REVIEW_VERSION}`);
  if (review.episodeId !== context.episodeId) reviewFailure(failures, `episodeId must be ${context.episodeId}`);
  if (review.scriptDigest !== context.scriptDigest) reviewFailure(failures, "scriptDigest does not match the current script");
  if (review.inventoryDigest !== context.inventoryDigest) {
    reviewFailure(failures, `inventoryDigest does not match the current inventory (${context.inventoryDigest}); rerun wardrobe-readiness without the review and review that inventory`);
  }
  if (!Number.isFinite(Date.parse(text(review.reviewedAt)))) reviewFailure(failures, "reviewedAt must be a valid time");
  const reviewer = plain(review.reviewer) ? review.reviewer : null;
  if (!reviewer) reviewFailure(failures, "reviewer {host, id, contextId} is required");
  else {
    if (!REVIEWER_HOSTS.includes(text(reviewer.host))) reviewFailure(failures, `reviewer.host must be one of ${REVIEWER_HOSTS.join(", ")}`);
    if (!text(reviewer.id)) reviewFailure(failures, "reviewer.id is required");
    if (charLength(reviewer.contextId) < 8) reviewFailure(failures, "reviewer.contextId must identify the reviewing task/session (8+ characters)");
    const generators = Array.isArray(context.generatorContexts) ? context.generatorContexts : [];
    if (generators.length === 0) {
      reviewFailure(failures, "the gate's generator context is unknown, so reviewer independence cannot be checked (pass --generator-host/--generator-context-id)");
    }
    for (const generator of generators) {
      const independence = assertKoyaIndependentEvaluator(generator, { id: text(reviewer.id), contextId: text(reviewer.contextId) });
      if (!independence.pass) {
        reviewFailure(failures, `reviewer is not independent of the ${generator.role || "generator"} context (${independence.failures.join(", ")})`);
      }
    }
  }
  const decisions = Array.isArray(review.decisions) ? review.decisions : null;
  if (!decisions || decisions.length === 0) reviewFailure(failures, "decisions must list at least one slot decision");
  const slotsById = new Map((context.slots || []).map((slot) => [slot.slotId, slot]));
  const seen = new Set();
  for (const [index, decision] of (decisions || []).entries()) {
    const label = `decisions[${index}]`;
    if (!plain(decision)) {
      reviewFailure(failures, `${label} must be an object`);
      continue;
    }
    const extra = Object.keys(decision).filter((key) => !REVIEW_DECISION_KEYS.includes(key));
    if (extra.length > 0) reviewFailure(failures, `${label} has unknown keys: ${extra.join(", ")}`);
    const slotId = text(decision.slotId);
    const slot = slotsById.get(slotId);
    if (!slot) reviewFailure(failures, `${label}.slotId ${slotId || "(empty)"} is not a slot of this inventory`);
    else if (!UNRESOLVED_STATUSES.has(slot.status)) reviewFailure(failures, `${label}.slotId ${slotId} is already ${slot.status}; only pending or undecidable slots are reviewed`);
    if (seen.has(slotId)) reviewFailure(failures, `${label}.slotId ${slotId} is decided twice`);
    seen.add(slotId);
    if (!["fits", "does-not-fit"].includes(decision.decision)) reviewFailure(failures, `${label}.decision must be fits or does-not-fit`);
    if (charLength(decision.reason) < MINIMUM_WARDROBE_TEXT_LENGTH) {
      reviewFailure(failures, `${label}.reason must explain the decision (${MINIMUM_WARDROBE_TEXT_LENGTH}+ characters)`);
    }
    if (decision.decision === "fits") {
      const wardrobe = slot ? context.wardrobes?.get(slot.castId) : null;
      if (!text(decision.outfit)) reviewFailure(failures, `${label}.outfit must name the outfit the slot fits with ("base" or a registered outfit asset id)`);
      else if (wardrobe && !resolveReviewOutfit(decision.outfit, wardrobe)) {
        reviewFailure(failures, `${label}.outfit ${decision.outfit} is neither "base" nor a registered outfit of ${slot.castId}`);
      }
    } else if (decision.outfit !== undefined && decision.outfit !== null && text(decision.outfit) !== "") {
      reviewFailure(failures, `${label}.outfit must be empty when the decision is does-not-fit`);
    }
  }
  return failures;
}

function reviewInvalid(failures) {
  const error = new Error(`wardrobe review was rejected: ${failures.join("; ")}`);
  error.code = KOYA_WARDROBE_REVIEW_INVALID_CODE;
  error.failures = failures;
  return error;
}

function generatorContextRecord(entry) {
  if (!plain(entry) || !text(entry.contextId)) return null;
  return {
    role: text(entry.role) || "generator",
    host: text(entry.host),
    id: text(entry.id),
    contextId: text(entry.contextId),
  };
}

export function koyaWardrobeOutcomeDigest(report) {
  return koyaWardrobeDigest({
    version: report.version,
    episodeId: report.episodeId,
    scriptDigest: report.scriptDigest,
    inventoryDigest: report.inventoryDigest,
    status: report.status,
    slots: report.slots,
    assignments: report.assignments,
    generatorContexts: report.generatorContexts,
    review: report.review
      ? { sha256: report.review.sha256, reviewer: report.review.reviewer, decisions: report.review.decisions }
      : null,
  });
}

/**
 * 台本・台帳・show bible（とレビュー記録）から照合結果を作る。
 * 返り値の generatedAt は呼び出し側が付ける（digest には入れない）。
 */
export function evaluateKoyaWardrobeReadiness(input = {}) {
  const episodeId = text(input.episodeId);
  if (!episodeId) throw new Error("wardrobe-readiness needs an episodeId.");
  if (!plain(input.parsed) || !Array.isArray(input.parsed.cuts)) throw new Error("wardrobe-readiness needs the parsed script.");
  const scriptDigest = text(input.scriptDigest) || koyaWardrobeScriptDigest(input.scriptText);
  const policy = input.policy || resolveKoyaWardrobePolicy(input.showBible);
  const registry = input.registry || { characters: [] };
  const checked = koyaWardrobeCheckedCharacters(registry);
  const wardrobes = new Map(checked.map((character) => [character.id, wardrobeFor(character, policy)]));
  const allNames = significantNames([
    ...(registry.characters || []).flatMap((character) => [character?.name, ...(character?.aliases || [])]),
    ...(Array.isArray(input.parsed.cast) ? input.parsed.cast.map((entry) => entry?.name ?? entry) : []),
    ...(input.parsed.utterances || []).filter((utterance) => !isNarration(utterance)).map((utterance) => utterance?.speakerName),
  ]);
  const scenes = koyaWardrobeScenes(input.parsed);
  const sceneRows = [];
  const assignments = [];
  const slotGroups = new Map();
  for (const scene of scenes) {
    const { tags, evidence } = detectSceneTags(scene, policy, allNames);
    const narrationText = scene.attributeSources.filter((entry) => entry.source.startsWith("narration:")).map((entry) => entry.text).join("\n");
    const present = [];
    for (const character of checked) {
      const appearance = [];
      if (scene.speakerIds.includes(character.id)) appearance.push("speaker");
      const names = significantNames([character.name, ...(character.aliases || [])]);
      if (names.some((name) => narrationText.includes(name))) appearance.push("named-in-narration");
      if (appearance.length > 0) present.push({ character, appearance });
    }
    sceneRows.push({
      sceneKey: scene.sceneKey,
      sceneNumber: scene.sceneNumber,
      heading: scene.heading,
      cutIds: [...scene.cutIds],
      sceneTags: tags,
      evidence,
      conflict: tags.length > 1,
      checkedCastIds: present.map((entry) => entry.character.id),
    });
    for (const { character, appearance } of present) {
      const wardrobe = wardrobes.get(character.id);
      const matched = matchOutfit(tags, wardrobe);
      let slotId = null;
      if (tags.length > 0) {
        const tagKey = tags.join("+");
        slotId = `wardrobe-${episodeId}-${character.id}-${tagKey}`;
        if (!slotGroups.has(slotId)) {
          slotGroups.set(slotId, {
            slotId,
            castId: character.id,
            castName: text(character.name) || character.id,
            sceneRef: [],
            sceneKeys: [],
            sceneTags: [...tags],
            evidence: [],
            requirement: "",
            matchedOutfit: matched,
            status: matched ? "matched" : tags.length > 1 ? "undecidable" : "pending",
          });
        }
        const slot = slotGroups.get(slotId);
        slot.sceneRef.push(...scene.cutIds);
        slot.sceneKeys.push(scene.sceneKey);
        slot.evidence.push(...evidence.map((entry) => ({ ...entry, sceneKey: scene.sceneKey })));
      }
      assignments.push({
        sceneKey: scene.sceneKey,
        cutIds: [...scene.cutIds],
        castId: character.id,
        appearance,
        sceneTags: [...tags],
        matchedOutfit: matched,
        slotId,
      });
    }
  }
  const slots = [...slotGroups.values()].map((slot) => ({
    ...slot,
    sceneRef: unique(slot.sceneRef),
    sceneKeys: unique(slot.sceneKeys),
    requirement: slot.status === "matched"
      ? `場面タグ ${slot.sceneTags.join(" と ")} は登録済みの服で覆われている。`
      : requirementFor(slot.sceneTags, slot.evidence, wardrobes.get(slot.castId)),
  }));
  const checkedCharacters = checked.map((character) => {
    const wardrobe = wardrobes.get(character.id);
    return {
      castId: character.id,
      name: text(character.name) || character.id,
      showBibleMemberId: wardrobe.castPolicy?.memberId || "",
      baseOutfitSceneTags: [...wardrobe.base.sceneTags],
      defaultOutfit: wardrobe.defaultOutfit ? wardrobe.defaultOutfit.assetId : "",
      outfits: wardrobe.outfits.map((outfit) => ({
        assetId: outfit.assetId,
        storyStage: outfit.storyStage,
        sha256: outfit.sha256,
        sceneTags: outfit.sceneTags,
        ...(outfit.unknownSceneTags.length > 0 ? { unknownSceneTags: outfit.unknownSceneTags } : {}),
        tagSources: outfit.tagSources,
      })),
    };
  });
  const policySummary = {
    vocabulary: policy.vocabulary,
    detectedTags: policy.detectedTags,
    keywordDigest: koyaWardrobeDigest(policy.keywords),
    declaredInShowBible: policy.declaredInShowBible,
    digest: policy.digest,
  };
  const inventoryDigest = koyaWardrobeDigest({
    version: KOYA_WARDROBE_READINESS_VERSION,
    episodeId,
    scriptDigest,
    policy: policySummary,
    checkedCharacters,
    scenes: sceneRows,
    assignments,
    slots,
  });
  const generatorContexts = unique((input.generatorContexts || []).map(generatorContextRecord).filter(Boolean)
    .map((entry) => JSON.stringify(entry))).map((entry) => JSON.parse(entry));

  let review = null;
  if (input.review !== undefined && input.review !== null) {
    const failures = validateKoyaWardrobeReview(input.review, {
      episodeId,
      scriptDigest,
      inventoryDigest,
      generatorContexts,
      slots,
      wardrobes,
    });
    if (!SHA256_PATTERN.test(text(input.reviewSha256))) failures.push("the review file SHA-256 is missing");
    if (failures.length > 0) throw reviewInvalid(failures);
    const decisions = input.review.decisions.map((decision) => ({
      slotId: text(decision.slotId),
      decision: decision.decision,
      outfit: decision.decision === "fits" ? text(decision.outfit) : null,
      reason: text(decision.reason),
    }));
    const reviewer = {
      host: text(input.review.reviewer.host),
      id: text(input.review.reviewer.id),
      contextId: text(input.review.reviewer.contextId),
    };
    for (const decision of decisions) {
      const slot = slots.find((entry) => entry.slotId === decision.slotId);
      const resolution = { decision: decision.decision, reason: decision.reason, reviewerId: reviewer.id };
      if (decision.decision === "fits") {
        const outfit = resolveReviewOutfit(decision.outfit, wardrobes.get(slot.castId));
        Object.assign(slot, { status: "resolved", matchedOutfit: outfit, resolution: { ...resolution, outfit: decision.outfit } });
        for (const assignment of assignments.filter((entry) => entry.slotId === slot.slotId)) assignment.matchedOutfit = outfit;
      } else {
        Object.assign(slot, { status: "pending", resolution });
      }
    }
    review = {
      version: KOYA_WARDROBE_REVIEW_VERSION,
      path: text(input.reviewPath),
      sha256: text(input.reviewSha256),
      reviewer,
      reviewedAt: text(input.review.reviewedAt),
      decisions,
    };
  }
  const pendingSlotIds = slots.filter((slot) => UNRESOLVED_STATUSES.has(slot.status)).map((slot) => slot.slotId);
  const report = {
    version: KOYA_WARDROBE_READINESS_VERSION,
    episodeId,
    scriptDigest,
    inventoryDigest,
    status: pendingSlotIds.length === 0 ? "pass" : "pending",
    pass: pendingSlotIds.length === 0,
    pendingSlotIds,
    policy: policySummary,
    checkedCharacters,
    scenes: sceneRows,
    assignments,
    slots,
    generatorContexts,
    review,
    summary: {
      sceneCount: sceneRows.length,
      taggedSceneCount: sceneRows.filter((scene) => scene.sceneTags.length > 0).length,
      checkedCharacterCount: checkedCharacters.length,
      slotCount: slots.length,
      pendingSlotCount: pendingSlotIds.length,
    },
  };
  report.outcomeDigest = koyaWardrobeOutcomeDigest(report);
  return report;
}

/**
 * 保存済みレポートが「今の台本のこのエピソードの pass」を名乗れるかを、
 * ファイルの中身だけで確かめる（再計算は呼び出し側が別にやる）。
 */
export function checkKoyaWardrobeReport(report, { episodeId, scriptDigest } = {}) {
  if (!plain(report)) return { pass: false, status: "missing", failures: ["no wardrobe-readiness report"] };
  const failures = [];
  if (report.version !== KOYA_WARDROBE_READINESS_VERSION) failures.push(`report version is not ${KOYA_WARDROBE_READINESS_VERSION}`);
  if (report.episodeId !== episodeId) failures.push(`report belongs to episode ${report.episodeId || "(none)"}`);
  if (report.scriptDigest !== scriptDigest) failures.push("report was made for a different script (scriptDigest mismatch); rerun wardrobe-readiness");
  if (failures.length > 0) return { pass: false, status: "stale", failures };
  if (report.outcomeDigest !== koyaWardrobeOutcomeDigest(report)) {
    return { pass: false, status: "stale", failures: ["report content does not match its outcomeDigest (edited by hand?); rerun wardrobe-readiness"] };
  }
  const unresolved = (report.slots || []).filter((slot) => UNRESOLVED_STATUSES.has(slot.status)).map((slot) => slot.slotId);
  if (report.status !== "pass" || report.pass !== true || unresolved.length > 0) {
    return {
      pass: false,
      status: "pending",
      pendingSlotIds: unresolved,
      failures: [`${unresolved.length} wardrobe slot(s) are unresolved: ${unresolved.join(", ")}`],
    };
  }
  return { pass: true, status: "pass", failures: [] };
}

export function validateKoyaWardrobeOverrideReason(reason) {
  const value = text(reason);
  if (charLength(value) < MINIMUM_WARDROBE_TEXT_LENGTH) {
    throw new Error(`--wardrobe-readiness-override-reason needs a concrete reason (${MINIMUM_WARDROBE_TEXT_LENGTH}+ characters).`);
  }
  return value;
}

/**
 * 最終監査の wardrobe-readiness。画像を作った時点の判定は制作状態に残っているので、
 * ここでは「今の台本に対して pass のレポートがあるか、同じ台本に対する明示の
 * オーバーライドが記録されているか」を見て、オーバーライドは必ず表に出す。
 *
 * 制作状態に wardrobe-readiness の記録が一つも無い回は、このゲートを持つコード
 * （契約 v53）より前に画像を作った回なので測定対象外にする。ゲート導入後の画像
 * 工程は、有料の呼び出しより前に必ずこの記録を書く。
 */
export function auditKoyaWardrobeReadinessFinal({ state, report, reportPath = "", reportSha256 = "", episodeId, scriptDigest } = {}) {
  const record = plain(state?.wardrobeReadiness) ? state.wardrobeReadiness : null;
  const base = {
    version: KOYA_WARDROBE_FINAL_AUDIT_VERSION,
    episodeId,
    scriptDigest,
    reportPath,
    reportSha256,
    inForceSince: KOYA_WARDROBE_READINESS_IN_FORCE_SINCE,
  };
  if (!record) {
    return {
      ...base,
      applicable: false,
      pass: true,
      status: "not-in-force",
      detail: `no wardrobe-readiness record: this episode's images were made before the gate (${KOYA_WARDROBE_READINESS_IN_FORCE_SINCE})`,
      overrides: [],
      failures: [],
    };
  }
  const overrides = (Array.isArray(record.overrideHistory) ? record.overrideHistory : [])
    .filter((entry) => entry?.scriptDigest === scriptDigest)
    .map((entry) => ({ reason: text(entry.reason), recordedAt: text(entry.recordedAt), stage: text(entry.stage), refusedStatus: text(entry.refusedStatus) }));
  const surfaced = overrides.length > 0
    ? ` operator override(s): ${overrides.map((entry) => `"${entry.reason}" (${entry.recordedAt})`).join("; ")}`
    : "";
  if (record.status === "overridden") {
    if (overrides.length === 0) {
      return {
        ...base,
        applicable: true,
        pass: false,
        status: "override-stale",
        detail: "the recorded wardrobe-readiness override was made for a different script",
        overrides,
        failures: ["override-script-mismatch"],
        stateStatus: record.status,
      };
    }
    return {
      ...base,
      applicable: true,
      pass: true,
      status: "overridden",
      detail: `wardrobe-readiness was overridden by the operator.${surfaced}`,
      overrides,
      failures: [],
      stateStatus: record.status,
    };
  }
  const checked = checkKoyaWardrobeReport(report, { episodeId, scriptDigest });
  if (!checked.pass) {
    if (overrides.length > 0) {
      return {
        ...base,
        applicable: true,
        pass: true,
        status: "overridden",
        detail: `no passing report for the current script, but images ran under an operator override.${surfaced} (${checked.failures.join("; ")})`,
        overrides,
        failures: [],
        stateStatus: record.status,
      };
    }
    return {
      ...base,
      applicable: true,
      pass: false,
      status: checked.status,
      detail: `wardrobe-readiness did not pass: ${checked.failures.join("; ")}`,
      overrides,
      failures: checked.failures,
      stateStatus: record.status,
    };
  }
  return {
    ...base,
    applicable: true,
    pass: true,
    status: overrides.length > 0 ? "pass-with-earlier-override" : "pass",
    detail: `wardrobe-readiness passed (${(report.slots || []).length} slot(s), inventory ${report.inventoryDigest.slice(0, 12)}).${surfaced}`,
    overrides,
    inventoryDigest: report.inventoryDigest,
    outcomeDigest: report.outcomeDigest,
    failures: [],
    stateStatus: record.status,
  };
}
