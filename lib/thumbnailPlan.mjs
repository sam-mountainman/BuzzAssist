// サムネの計画の下書き・検査・final の監査（ジャンル共通の層）。
//
// 漫画（koya-manga-video）とナレーション物語（narrated-story-video）が同じ仕組みを使う。ここには
// チャンネル固有の事実（ブランドの語・帯の行数と字数・配置の種類・承認済みの参照）を1つも書かない。
// それらは「決まり（rules）」として外から渡す:
//   - 漫画: Channel Pack の thumbnail contract（koya-thumbnail-contract-v1）を lib/koyaChannelGovernance.mjs の
//     koyaThumbnailRules が写す（今の出力を変えないため、新しい検査は契約の節で入れたときだけ効く）
//   - ナレーション物語: Channel Pack の narrated-story.json の thumbnail 節（読むのは
//     lib/harnessChannelPackRuntime.mjs、中身の検査はこのファイルの thumbnailRulesFromChannelSection）
//
// 検査の一覧と出典（リポジトリの文書・スキル・契約から引いた。運営側の記録にしか無いものはそう書く）:
//   1. 決定サイズで読める
//      - 文言の行数と字数の上限（帯・吹き出し・テロップ）。上限の値はチャンネルの決まり。
//        出典: Channel Pack の thumbnail contract（koya-thumbnail-contract-v1 の copy）、
//        lib/assetQualityLoop.mjs の THUMBNAIL_RUBRIC readable-at-decided-size
//      - 決定サイズ（既定 320×180）は原寸と同じ縦横比（縮めたとき切れない・歪まない）。完成画は原寸ぴったり。
//        出典: lib/koyaChannelGovernance.mjs の final の確認 mobile320x180・original1280x720、
//        lib/assetQualityLoop.mjs の機械ゲート thumbnail-aspect-16x9
//      - 読めるかどうかの判断は人の確認（checks.decidedSize）と、品質ループの評価者の採点
//        （readable-at-decided-size、下限 80）。機械は読めることを判定しない
//   2. 案どうしが別アイデアとして読める（auditThumbnailIdeaSet）
//      - 読める軸: 吹き出しの数・場面・構図・ビート・載せ物。書体・帯色・寄り広めの差は数えない。
//        出典: lib/assetQualityLoop.mjs の THUMBNAIL_RUBRIC distinct-idea-axes（軸の一覧は運営側の記録からで、
//        正本にまだ節が無い）
//      - 軸の文章だけで差を認めない。同じ画・同じ吹き出しの数の2案は、宣言した軸が違っても同じ案として落とす。
//        出典: .agents/skills/manga-video-production/references/quality-contract-ja.md「人物と絵」
//        （variationAxis 文章だけで差を認定せず）と「判断ゲートと改善ループ」（2〜5候補へ異なる variationAxis）
//   3. 文字入りなら文字の設計の指定（書体・抑揚・字間・色・担体）
//      出典: .agents/skills/manga-video-production/references/learned-auto.md の自動捕捉（文字の在り処だけを
//      指示すると既定ゴシック・朱ベタ・薄枠の平板が出る。補助指示で証跡ではない）、lib/textRenderingGate.mjs
//      （文字が乗る物＝担体を名指しする）、lib/assetQualityLoop.mjs の THUMBNAIL_RUBRIC lettering-design
//   4. 登場人物の参照が承認済みの設定画か（SHA で照合。ファイル名を信用しない）
//      出典: lib/assetQualityLoop.mjs の機械ゲート reference-approved、lib/operatorImageImport.mjs の
//      resolveApprovedReferenceSha256s、quality-contract-ja.md「人物と絵」（人物ごとに承認参照を固定）
//   5. 実在ブランドのロゴ・意匠が無い
//      - 文言の禁止語（チャンネルの決まり）と、人の確認（checks.realLogoZero）。ロゴや意匠そのものは機械で
//        判定しない。品質ループの評価項目 no-real-brand-logo（下限 100）が別文脈の評価者に見させる。
//        出典: quality-contract-ja.md「台本と編集」（疑似文字・数字・ロゴを生成しない）、
//        lib/assetQualityLoop.mjs の THUMBNAIL_RUBRIC no-real-brand-logo
//   6. 専用画の使い回しが無い（本編の画・過去のサムネ・同じサムネの別のコマ。SHA と 32×32 の正規化画素差）
//      出典: Channel Pack の thumbnail contract の sourcePolicy（dedicatedThumbnailArtworkRequired・
//      normalizedGray32MaximumReuseDistance）、lib/operatorImageImport.mjs（同じ画の使い回しを止める）
//   7. final では、専用画ごと（と完成画）に品質ループの thumbnail 工程の合格（assetQualityStatus の pass === true）
//      出典: lib/assetQualityLoop.mjs の assetQualityStatus、lib/assetQualityUseGate.mjs
//   8. Job との結び付け（jobId・話数・動画の sha256）。サムネは Job の成果物にも Receipt の保証にも入れない。
//      Job の外で作ったサムネが、どの Job の回のものかを記録し、final でそれが実在の Job と一致するかを見る。
//
// 失敗の行: 漫画の今の検査の文言は変えない（koya の出力を変えないため）。新しい検査の行は
// `thumbnail-<種類>:<対象>: <説明>` の形で、先頭の理由コードを機械で読める。

import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { assetQualityUseFailureLines } from "./assetQualityUseGate.mjs";
import { getImageDimensionsFromBuffer } from "./canvasScene.mjs";
// 品質ループの対象 id の組み立て（英数字と . _ -、64文字まで）。名前に koya が残るのは履歴で、中身は
// ジャンルに依らない純粋な関数（漫画の他の工程と同じ id になるように、同じ実装を使う）。
import { koyaAssetQualitySubjectId as assetQualitySubjectId } from "./koyaAssetQualityGatePolicy.mjs";

const execFile = promisify(execFileCallback);

export const THUMBNAIL_PLAN_VERSION = "buzzassist-thumbnail-plan-v1";
export const THUMBNAIL_RULES_VERSION = "buzzassist-thumbnail-rules-v1";
export const THUMBNAIL_AUDIT_VERSION = "buzzassist-thumbnail-audit-v1";
export const THUMBNAIL_IDEA_SET_AUDIT_VERSION = "buzzassist-thumbnail-idea-set-audit-v1";
export const THUMBNAIL_JOB_BINDING_VERSION = "buzzassist-thumbnail-job-binding-v1";
export const THUMBNAIL_STAGES = Object.freeze(["preflight", "final"]);
export const THUMBNAIL_TEXT_SLOTS = Object.freeze(["band", "speechBubble", "telop"]);
/** 別アイデアとして読める軸（吹き出しの数は計画の吹き出しから数える。宣言では変えられない）。 */
export const THUMBNAIL_IDEA_AXES = Object.freeze(["bubbleCount", "scene", "composition", "beat", "payload"]);
/** 案の宣言に書いてよい欄（軸と、案の束・案の id）。 */
export const THUMBNAIL_IDEA_FIELDS = Object.freeze(["setId", "id", "scene", "composition", "beat", "payload"]);
/** 差として数えない軸（書体・帯色・寄り広め）。宣言に書かれたら、数えないことを返す。 */
export const THUMBNAIL_NON_READING_AXES = Object.freeze(["typeface", "bandColor", "framing"]);
/** 文字の設計の指定（書体・太細の抑揚・字間・色・担体＝文字が乗る物）。 */
export const THUMBNAIL_LETTERING_FIELDS = Object.freeze(["typeface", "strokeContrast", "tracking", "color", "carrier"]);
/** ナレーション物語など、新しい計画の final の人の確認の欄（漫画は契約の今の欄のまま）。 */
export const THUMBNAIL_DEFAULT_FINAL_CHECKS = Object.freeze([
  "originalSize", "decidedSize", "textCropZero", "faceCropZero", "primaryEmotionReadable", "approvedCharacterReferencesOnly", "realLogoZero",
]);
// 原寸と決定サイズの既定。YouTube のサムネの原寸（品質ループの機械ゲート thumbnail-aspect-16x9 が 16:9・幅 1280 以上を
// 求める）と、漫画の契約の final の確認 mobile320x180 の値。
export const THUMBNAIL_DEFAULT_CANVAS = Object.freeze({ width: 1280, height: 720 });
export const THUMBNAIL_DEFAULT_DECIDED_SIZE = Object.freeze({ width: 320, height: 180 });
// 32×32 の正規化画素差の既定（漫画の契約の normalizedGray32MaximumReuseDistance と同じ値）。
export const THUMBNAIL_DEFAULT_REUSE_DISTANCE = 0.025;

const SHA256 = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9-]{0,39}$/u;
const REASON_FIELD = /^[a-z][A-Za-z0-9]{0,39}$/u;
const RESERVED_PLAN_KEYS = new Set([
  "version", "harnessId", "stage", "layout", "idea", "bandLines", "speechBubbles", "telops", "lettering", "exactTextApproved",
  "textApproval", "charactersVisible", "characterReferences", "artworkPaths", "artworkQualitySubjectIds", "mainVideoFramePaths",
  "previousThumbnailPaths", "compositePath", "compositeQualitySubjectId", "checks", "jobBinding", "contractStatus", "brandTokens",
  "instructions",
]);
// 文字の設計の欄に「決めていない」と書いた値。空欄と同じに扱う（既定の書体に任せると平板な仮看板が出る）。
const LETTERING_PLACEHOLDER = /^(?:default|既定|標準|おまかせ|お任せ|任意|なし|無し|none|any|auto|tbd|未定|-)$/iu;
const JOB_ID = /^video-[a-z0-9_-]+-[a-f0-9]{16}$/u;

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(object, key) {
  return plainObject(object) && typeof key === "string" && Object.prototype.hasOwnProperty.call(object, key);
}

function validIsoDate(value) {
  const text = nonEmpty(value);
  return Boolean(text && /^\d{4}-\d{2}-\d{2}T/u.test(text) && Number.isFinite(Date.parse(text)));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedJapaneseLength(value) {
  return Array.from(nonEmpty(value).replace(/[\s　]/gu, "")).length;
}

function positiveInteger(value, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : 0;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** プロジェクトの中（プロジェクトそのものも含む）か。漫画の今の検査と同じ判定。pathApi で Windows も試せる。 */
export function insideProject(root, file, { pathApi = path } = {}) {
  const rel = pathApi.relative(root, file);
  return rel === "" || (!rel.startsWith(`..${pathApi.sep}`) && rel !== ".." && !pathApi.isAbsolute(rel));
}

// ---------------------------------------------------------------------------------------------
// 決まり（rules）
// ---------------------------------------------------------------------------------------------

function sizeRule(value, label, problems, fallback) {
  if (value === undefined) return { ...fallback };
  const width = positiveInteger(value?.width, 16, 16_384);
  const height = positiveInteger(value?.height, 16, 16_384);
  if (!plainObject(value) || !width || !height) {
    problems.push(`${label} must be { width, height } in pixels`);
    return { ...fallback };
  }
  return { width, height };
}

function slotRule(value, label, problems, kind) {
  if (value === undefined || value === null) return null;
  if (!plainObject(value)) {
    problems.push(`${label} must be an object or null`);
    return null;
  }
  if (kind === "telop") {
    const minimum = positiveInteger(value.minCharacters, 1, 40);
    const maximum = positiveInteger(value.maxCharacters, 1, 40);
    if (!minimum || !maximum || maximum < minimum) problems.push(`${label} needs 1 <= minCharacters <= maxCharacters <= 40`);
    return {
      minCharacters: minimum || 1,
      maxCharacters: maximum || minimum || 1,
      concreteNounReviewRequired: value.concreteNounReviewRequired === true,
    };
  }
  const lines = positiveInteger(value.lines, 1, 6);
  const maxCharactersPerLine = positiveInteger(value.maxCharactersPerLine, 1, 60);
  if (!lines) problems.push(`${label}.lines must be an integer from 1 to 6`);
  if (!maxCharactersPerLine) problems.push(`${label}.maxCharactersPerLine must be an integer from 1 to 60`);
  const rule = { lines: lines || 1, maxCharactersPerLine: maxCharactersPerLine || 1 };
  if (kind === "speechBubble") {
    const perPanel = value.perPanel;
    if (perPanel === undefined || perPanel === null) rule.perPanel = null;
    else if (perPanel === "pending") rule.perPanel = "pending";
    else if (plainObject(perPanel) && positiveInteger(perPanel.maximum, 1, 10)) rule.perPanel = { maximum: perPanel.maximum };
    else {
      problems.push(`${label}.perPanel must be "pending" or { maximum: 1..10 }`);
      rule.perPanel = null;
    }
  }
  return rule;
}

/**
 * 決まりを検査して凍結した形にする。直せない値は例外（黙って既定へ戻すと、決まりを書いた人は効いている
 * つもりになる）。各ハーネスの写し（漫画の契約・ナレーション物語の Pack の節）は、ここを通してから使う。
 */
export function normalizeThumbnailRules(input = {}) {
  if (input?.version === THUMBNAIL_RULES_VERSION && Object.isFrozen(input)) return input;
  const problems = [];
  const harnessId = nonEmpty(input.harnessId);
  if (!harnessId) problems.push("harnessId is required");
  const canvas = sizeRule(input.canvas, "canvas", problems, THUMBNAIL_DEFAULT_CANVAS);
  const decidedSize = sizeRule(input.decidedSize, "decidedSize", problems, THUMBNAIL_DEFAULT_DECIDED_SIZE);
  if (decidedSize.width > canvas.width || decidedSize.height > canvas.height) problems.push("decidedSize must not be larger than canvas");
  if (Math.abs(decidedSize.width / decidedSize.height - canvas.width / canvas.height) > 0.01) {
    problems.push("decidedSize must keep the canvas aspect ratio (a thumbnail is shrunk, not cropped, in the list)");
  }
  const layouts = {};
  if (!plainObject(input.layouts) || Object.keys(input.layouts).length === 0) problems.push("layouts must declare at least one layout");
  else {
    for (const [id, spec] of Object.entries(input.layouts)) {
      if (!IDENTIFIER.test(id)) problems.push(`layout id '${id}' must be letters, digits and hyphens`);
      const panels = positiveInteger(spec?.panels, 1, 6);
      if (!plainObject(spec) || !panels) problems.push(`layouts.${id}.panels must be an integer from 1 to 6`);
      layouts[id] = { panels: panels || 1, reasonRequired: spec?.reasonRequired === true };
    }
  }
  const layoutIds = Object.keys(layouts);
  const defaultLayout = nonEmpty(input.defaultLayout) || layoutIds[0] || "";
  if (layoutIds.length > 0 && !layoutIds.includes(defaultLayout)) problems.push(`defaultLayout '${defaultLayout}' is not a declared layout`);
  const layoutReasonField = nonEmpty(input.layoutReasonField) || "layoutReason";
  if (!REASON_FIELD.test(layoutReasonField) || RESERVED_PLAN_KEYS.has(layoutReasonField)) problems.push("layoutReasonField must be a free camelCase plan field");
  const copyInput = plainObject(input.copy) ? input.copy : {};
  const copy = {
    band: slotRule(copyInput.band, "copy.band", problems, "band"),
    speechBubble: slotRule(copyInput.speechBubble, "copy.speechBubble", problems, "speechBubble"),
    telop: slotRule(copyInput.telop, "copy.telop", problems, "telop"),
    forbiddenTerms: [],
    forbiddenTermSlots: [],
    exactTextApproval: "when-text",
  };
  for (const [index, term] of (Array.isArray(copyInput.forbiddenTerms) ? copyInput.forbiddenTerms : []).entries()) {
    if (!plainObject(term) || typeof term.text !== "string" || !term.text || !nonEmpty(term.kind)) {
      problems.push(`copy.forbiddenTerms[${index}] must be { text, kind }`);
      continue;
    }
    copy.forbiddenTerms.push({ text: term.text, kind: nonEmpty(term.kind) });
  }
  if (copyInput.forbiddenTerms !== undefined && !Array.isArray(copyInput.forbiddenTerms)) problems.push("copy.forbiddenTerms must be an array");
  const slots = copyInput.forbiddenTermSlots === undefined ? [...THUMBNAIL_TEXT_SLOTS] : copyInput.forbiddenTermSlots;
  if (!Array.isArray(slots) || slots.some((slot) => !THUMBNAIL_TEXT_SLOTS.includes(slot))) problems.push(`copy.forbiddenTermSlots must list ${THUMBNAIL_TEXT_SLOTS.join(" / ")}`);
  else copy.forbiddenTermSlots = [...slots];
  if (copyInput.exactTextApproval !== undefined) {
    if (!["always", "when-text"].includes(copyInput.exactTextApproval)) problems.push('copy.exactTextApproval must be "always" or "when-text"');
    else copy.exactTextApproval = copyInput.exactTextApproval;
  }
  const brandTokens = [];
  for (const [index, token] of (Array.isArray(input.brandTokens) ? input.brandTokens : []).entries()) {
    if (!plainObject(token) || !IDENTIFIER.test(String(token.id || "")) || !(token.value === undefined || typeof token.value === "string")) {
      problems.push(`brandTokens[${index}] must be { id, value }`);
      continue;
    }
    brandTokens.push({ id: token.id, value: token.value });
  }
  const sourceInput = plainObject(input.source) ? input.source : {};
  const reuseDistance = sourceInput.reuseDistance === undefined ? THUMBNAIL_DEFAULT_REUSE_DISTANCE : Number(sourceInput.reuseDistance);
  if (!(reuseDistance > 0 && reuseDistance <= 1)) problems.push("source.reuseDistance must be in (0, 1]");
  const finalChecks = input.finalChecks === undefined ? [...THUMBNAIL_DEFAULT_FINAL_CHECKS] : input.finalChecks;
  if (!Array.isArray(finalChecks) || finalChecks.length === 0 || finalChecks.some((key) => !/^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(String(key || "")))) {
    problems.push("finalChecks must be a non-empty list of check ids");
  }
  const finalChecksBinding = input.finalChecksBinding === undefined ? "none" : input.finalChecksBinding;
  if (!["none", "composite"].includes(finalChecksBinding)) problems.push('finalChecksBinding must be "none" or "composite"');
  const ideasInput = plainObject(input.ideas) ? input.ideas : {};
  const minimumDistinctAxes = ideasInput.minimumDistinctAxes === undefined ? 1 : positiveInteger(ideasInput.minimumDistinctAxes, 1, THUMBNAIL_IDEA_AXES.length);
  if (!minimumDistinctAxes) problems.push(`ideas.minimumDistinctAxes must be an integer from 1 to ${THUMBNAIL_IDEA_AXES.length}`);
  const composite = { required: input.composite?.required === true };
  if (finalChecksBinding === "composite" && !composite.required) problems.push("finalChecksBinding composite needs composite.required");
  if (problems.length > 0) throw new Error(`Thumbnail rules are invalid: ${problems.join("; ")}.`);
  return deepFreeze({
    version: THUMBNAIL_RULES_VERSION,
    harnessId,
    planVersion: nonEmpty(input.planVersion) || THUMBNAIL_PLAN_VERSION,
    auditVersion: nonEmpty(input.auditVersion) || THUMBNAIL_AUDIT_VERSION,
    status: typeof input.status === "string" ? input.status : "declared",
    canvas,
    decidedSize,
    layouts,
    defaultLayout,
    layoutReasonField,
    copy,
    lettering: { required: input.lettering?.required === true },
    brandTokens,
    source: {
      dedicatedArtworkRequired: sourceInput.dedicatedArtworkRequired !== false,
      reuseDistance,
      distinctPanelArtwork: sourceInput.distinctPanelArtwork === true,
    },
    finalChecks: [...finalChecks],
    finalChecksBinding,
    composite,
    characterReferences: { required: input.characterReferences?.required === true },
    ideas: { required: ideasInput.required === true, minimumDistinctAxes },
    jobBinding: { required: input.jobBinding?.required === true },
    draftInstructions: typeof input.draftInstructions === "string" ? input.draftInstructions : "",
  });
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value)) deepFreeze(entry);
  return value;
}

// Channel Pack の thumbnail 節の既定の文言（ナレーション物語など、新しい計画の下書きに載せる）。
const CHANNEL_DRAFT_INSTRUCTIONS = [
  "1) Fill idea (scene, composition, beat, payload), the copy and the lettering design (typeface, strokeContrast, tracking, color, carrier) for every text slot you use.",
  "2) List characterReferences by the SHA-256 of approved setting sheets, and set charactersVisible.",
  "3) A human approves the exact copy: set exactTextApproved and textApproval.copySha256 to the copySha256 the audit prints.",
  "4) After the dedicated artwork and the finished composite exist, set stage=final, add artworkPaths, compositePath, mainVideoFramePaths and jobBinding (jobId, episodeId, videoSha256 of the Job's final video).",
  "5) Run the asset quality loop (stage thumbnail) for every artwork and the composite, then set checks and checks.compositeSha256 after viewing the composite at the decided size.",
].join(" ");

/**
 * Channel Pack の thumbnail 節（ナレーション物語は narrated-story.json の thumbnail）を決まりにする。
 * 共通の検査（文字の設計・承認済みの参照・完成画・Job との結び付け・別のコマの使い回し・品質ループ）は
 * Pack から弱められない。Pack が決めるのは原寸と決定サイズ・配置の種類・文言の枠と上限・禁止語・
 * 承認の方針・ブランドの語・使い回しの距離（既定より厳しくだけ）・案の軸の最小数（上げるだけ）・人の確認の欄の追加。
 *
 * 形:
 * {
 *   "status": "<任意の状態の名前>",
 *   "rules": {
 *     "canvas": { "width": 1280, "height": 720 }, "decidedSize": { "width": 320, "height": 180 },
 *     "reuseDistance": 0.025, "minimumDistinctIdeaAxes": 1, "requireIdea": false,
 *     "brandTokens": { "<id>": "<値。未承認は PENDING_ で始める>" }, "finalChecks": ["<足す人の確認の欄>"]
 *   },
 *   "layouts": { "<id>": { "panels": 1, "default": true, "reasonRequired": false } },
 *   "text": {
 *     "band": { "lines": 2, "maxCharactersPerLine": 12 },
 *     "speechBubble": { "lines": 2, "maxCharactersPerLine": 8, "maximumPerPanel": 1 },
 *     "telop": { "minCharacters": 2, "maxCharacters": 4, "concreteNounReview": true },
 *     "forbiddenTerms": [{ "text": "<語>", "kind": "<brand など>" }],
 *     "approval": "when-text" | "always"
 *   },
 *   "approvedReferences": { "sha256": ["<64桁>"], "characterRegistry": true }
 * }
 * 無い枠（text.band が無いなど）は、その枠に文字を置けないという意味。
 */
export function thumbnailRulesFromChannelSection(section, { harnessId, planVersion = THUMBNAIL_PLAN_VERSION } = {}) {
  if (!plainObject(section)) throw new Error("Channel Pack has no thumbnail section; declare thumbnail.layouts and thumbnail.text before planning a thumbnail.");
  const problems = [];
  const rules = plainObject(section.rules) ? section.rules : {};
  if (section.rules !== undefined && !plainObject(section.rules)) problems.push("thumbnail.rules must be an object");
  const text = plainObject(section.text) ? section.text : null;
  if (!text) problems.push("thumbnail.text is required (text slots, forbidden terms and the approval policy are channel decisions)");
  if (!plainObject(section.layouts) || Object.keys(section.layouts).length === 0) problems.push("thumbnail.layouts is required (the layout kinds are a channel decision)");
  const canvas = rules.canvas === undefined ? { ...THUMBNAIL_DEFAULT_CANVAS } : rules.canvas;
  // 品質ループの thumbnail 工程は 16:9・幅 1280 以上の画しか通さない（機械ゲート thumbnail-aspect-16x9）。
  if (!plainObject(canvas) || !Number.isInteger(canvas.width) || !Number.isInteger(canvas.height)
    || canvas.width < 1280 || canvas.width * 9 !== canvas.height * 16) {
    problems.push("thumbnail.rules.canvas must be 16:9 and at least 1280 wide (the asset quality loop gate thumbnail-aspect-16x9)");
  }
  const reuseDistance = rules.reuseDistance === undefined ? THUMBNAIL_DEFAULT_REUSE_DISTANCE : rules.reuseDistance;
  if (!(typeof reuseDistance === "number" && reuseDistance >= THUMBNAIL_DEFAULT_REUSE_DISTANCE && reuseDistance <= 1)) {
    problems.push(`thumbnail.rules.reuseDistance may only be raised (${THUMBNAIL_DEFAULT_REUSE_DISTANCE}..1); a smaller distance lets reused artwork through`);
  }
  const extraChecks = rules.finalChecks === undefined ? [] : rules.finalChecks;
  if (!Array.isArray(extraChecks)) problems.push("thumbnail.rules.finalChecks must be an array of extra check ids");
  const layouts = {};
  let defaultLayout = "";
  for (const [id, spec] of Object.entries(plainObject(section.layouts) ? section.layouts : {})) {
    layouts[id] = { panels: spec?.panels, reasonRequired: spec?.reasonRequired === true };
    if (spec?.default === true) {
      if (defaultLayout) problems.push("thumbnail.layouts may mark only one layout as default");
      defaultLayout = id;
    }
  }
  const brandTokens = [];
  if (rules.brandTokens !== undefined) {
    if (!plainObject(rules.brandTokens)) problems.push("thumbnail.rules.brandTokens must be an object of id -> value");
    else for (const [id, value] of Object.entries(rules.brandTokens)) brandTokens.push({ id, value });
  }
  const bubble = text?.speechBubble;
  const approval = text?.approval === undefined ? "when-text" : text.approval;
  if (problems.length > 0) throw new Error(`Thumbnail rules are invalid: ${problems.join("; ")}.`);
  return normalizeThumbnailRules({
    harnessId,
    planVersion,
    auditVersion: THUMBNAIL_AUDIT_VERSION,
    status: typeof section.status === "string" ? section.status : "declared",
    canvas,
    decidedSize: rules.decidedSize,
    layouts,
    defaultLayout: defaultLayout || Object.keys(layouts)[0],
    layoutReasonField: "layoutReason",
    copy: {
      band: text?.band,
      speechBubble: plainObject(bubble)
        ? { lines: bubble.lines, maxCharactersPerLine: bubble.maxCharactersPerLine, perPanel: bubble.maximumPerPanel === undefined ? null : { maximum: bubble.maximumPerPanel } }
        : bubble,
      telop: plainObject(text?.telop)
        ? { minCharacters: text.telop.minCharacters, maxCharacters: text.telop.maxCharacters, concreteNounReviewRequired: text.telop.concreteNounReview === true }
        : text?.telop,
      forbiddenTerms: text?.forbiddenTerms,
      forbiddenTermSlots: [...THUMBNAIL_TEXT_SLOTS],
      exactTextApproval: approval,
    },
    lettering: { required: true },
    brandTokens,
    source: { dedicatedArtworkRequired: true, reuseDistance, distinctPanelArtwork: true },
    finalChecks: [...new Set([...THUMBNAIL_DEFAULT_FINAL_CHECKS, ...(Array.isArray(extraChecks) ? extraChecks : [])])],
    finalChecksBinding: "composite",
    composite: { required: true },
    characterReferences: { required: true },
    ideas: { required: rules.requireIdea === true, minimumDistinctAxes: rules.minimumDistinctIdeaAxes },
    jobBinding: { required: true },
    draftInstructions: CHANNEL_DRAFT_INSTRUCTIONS,
  });
}

/** Pack の thumbnail 節の approvedReferences（lib/operatorImageImport.mjs と同じ形）を検査して写す。 */
export function thumbnailApprovedReferencesPolicy(section) {
  const value = section?.approvedReferences;
  if (value === undefined) return { sha256: [], characterRegistry: false };
  if (!plainObject(value)) throw new Error("thumbnail.approvedReferences must be { sha256, characterRegistry }.");
  const unknown = Object.keys(value).filter((key) => !["sha256", "characterRegistry"].includes(key));
  if (unknown.length > 0) throw new Error(`thumbnail.approvedReferences has unsupported fields: ${unknown.join(", ")}.`);
  const list = value.sha256 === undefined ? [] : value.sha256;
  if (!Array.isArray(list) || list.some((entry) => !SHA256.test(String(entry || "").trim().toLowerCase()))) {
    throw new Error("thumbnail.approvedReferences.sha256 must be a list of 64-digit SHA-256 values.");
  }
  if (value.characterRegistry !== undefined && typeof value.characterRegistry !== "boolean") {
    throw new Error("thumbnail.approvedReferences.characterRegistry must be true or false.");
  }
  return { sha256: [...new Set(list.map((entry) => String(entry).trim().toLowerCase()))], characterRegistry: value.characterRegistry === true };
}

// ---------------------------------------------------------------------------------------------
// 文言の SHA・品質ループの対象 id・下書き
// ---------------------------------------------------------------------------------------------

/**
 * 人が承認する文言の SHA。配置・配置の理由の欄・帯・吹き出し・テロップを縛る。reasonField は決まりの
 * layoutReasonField（漫画は thirdBeatReason。漫画の今の SHA と同じ値になる）。
 */
export function thumbnailCopySha256(plan = {}, { reasonField = "layoutReason" } = {}) {
  return sha256(JSON.stringify({
    layout: nonEmpty(plan.layout),
    [reasonField]: nonEmpty(plan[reasonField]),
    bandLines: (plan.bandLines || []).map(nonEmpty),
    speechBubbles: (plan.speechBubbles || []).map((entry) => ({ panelId: nonEmpty(entry.panelId), lines: (entry.lines || []).map(nonEmpty) })),
    telops: (plan.telops || []).map((entry) => ({ text: nonEmpty(entry.text), concreteNounReviewPassed: entry.concreteNounReviewPassed === true })),
  }));
}

/**
 * 専用画の品質ループの対象 id。plan.artworkQualitySubjectIds[index] があればそれ（版ごとにファイル名が
 * 変わっても同じループを続けるため）、無ければ画のファイル名（拡張子を除く）から作る。
 */
export function thumbnailArtworkQualitySubjectId(plan, index, artworkPath) {
  const explicit = Array.isArray(plan?.artworkQualitySubjectIds) ? nonEmpty(plan.artworkQualitySubjectIds[index]) : "";
  if (explicit) return assetQualitySubjectId(explicit);
  return assetQualitySubjectId("thumbnail", path.basename(String(artworkPath || "")).replace(/\.[^.]+$/u, ""));
}

/** 完成画（帯・文字を載せた公開する1枚）の品質ループの対象 id。 */
export function thumbnailCompositeQualitySubjectId(plan, compositePath) {
  const explicit = nonEmpty(plan?.compositeQualitySubjectId);
  if (explicit) return assetQualitySubjectId(explicit);
  return assetQualitySubjectId("thumbnail", "composite", path.basename(String(compositePath || "")).replace(/\.[^.]+$/u, ""));
}

function emptyLettering() {
  return Object.fromEntries(THUMBNAIL_LETTERING_FIELDS.map((field) => [field, ""]));
}

/**
 * 計画の下書き（fail-closed: 承認も確認も false・空のまま）。includeOptionalFields を false にすると、
 * 漫画の今の下書きと同じ欄だけになる（新しい欄は計画に足したときだけ検査が効く）。
 * jobBinding を渡すと、その結び付けを下書きに入れる。
 */
export function createThumbnailPlanDraft({ rules: input, layout, includeOptionalFields = true, jobBinding = null } = {}) {
  const rules = normalizeThumbnailRules(input);
  const chosen = hasOwn(rules.layouts, layout) ? layout : rules.defaultLayout;
  const spec = rules.layouts[chosen];
  const draft = { version: rules.planVersion };
  if (includeOptionalFields) draft.harnessId = rules.harnessId;
  draft.stage = "preflight";
  draft.layout = chosen;
  if (spec.reasonRequired) draft[rules.layoutReasonField] = "";
  if (includeOptionalFields) draft.idea = { setId: "", id: "", scene: "", composition: "", beat: "", payload: [] };
  draft.bandLines = rules.copy.band ? Array.from({ length: rules.copy.band.lines }, () => "") : [];
  draft.speechBubbles = [];
  draft.telops = [];
  if (includeOptionalFields) {
    draft.lettering = Object.fromEntries(THUMBNAIL_TEXT_SLOTS.filter((slot) => rules.copy[slot]).map((slot) => [slot, emptyLettering()]));
  }
  draft.exactTextApproved = false;
  draft.textApproval = { approvedBy: "", approvedAt: "", copySha256: "" };
  if (includeOptionalFields) {
    draft.charactersVisible = null;
    draft.characterReferences = [];
  }
  draft.artworkPaths = [];
  if (includeOptionalFields) draft.artworkQualitySubjectIds = [];
  draft.mainVideoFramePaths = [];
  if (includeOptionalFields) {
    draft.previousThumbnailPaths = [];
    draft.compositePath = "";
    draft.compositeQualitySubjectId = "";
  }
  draft.checks = Object.fromEntries(rules.finalChecks.map((key) => [key, false]));
  if (includeOptionalFields && rules.finalChecksBinding === "composite") draft.checks.compositeSha256 = "";
  if (includeOptionalFields || jobBinding) {
    draft.jobBinding = {
      jobId: nonEmpty(jobBinding?.jobId),
      episodeId: nonEmpty(jobBinding?.episodeId),
      videoSha256: nonEmpty(jobBinding?.videoSha256),
    };
  }
  draft.contractStatus = rules.status;
  draft.brandTokens = Object.fromEntries(rules.brandTokens.map((token) => [token.id, token.value]));
  draft.instructions = rules.draftInstructions;
  return draft;
}

// ---------------------------------------------------------------------------------------------
// 画の読み取り（SHA と 32×32 の正規化画素）
// ---------------------------------------------------------------------------------------------

async function normalizedGray32(filePath) {
  const result = await execFile("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-i", filePath,
    "-vf", "scale=32:32:force_original_aspect_ratio=decrease,pad=32:32:(ow-iw)/2:(oh-ih)/2:black,format=gray",
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
  ], { encoding: null, maxBuffer: 1024 * 1024 });
  const buffer = Buffer.from(result.stdout || []);
  if (buffer.length !== 1024) throw new Error(`Could not normalize thumbnail audit image: ${filePath}`);
  return buffer;
}

function normalizedPixelDistance(left, right) {
  if (!left || !right || left.length !== right.length || left.length === 0) return Infinity;
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) sum += Math.abs(left[index] - right[index]);
  return sum / (left.length * 255);
}

async function readImageRow(filePath) {
  const buffer = await readFile(filePath);
  const normalized = await normalizedGray32(filePath);
  return {
    row: { path: filePath, sha256: sha256(buffer), normalizedGray32Sha256: sha256(normalized), dimensions: getImageDimensionsFromBuffer(buffer) },
    normalized,
  };
}

// ---------------------------------------------------------------------------------------------
// 検査の部品
// ---------------------------------------------------------------------------------------------

function validateLines(lines, expectedLines, maximumLength, label, failures) {
  if (!Array.isArray(lines) || lines.length !== expectedLines) {
    failures.push(`${label} requires exactly ${expectedLines} lines.`);
    return;
  }
  lines.forEach((line, index) => {
    if (!nonEmpty(line)) failures.push(`${label} line ${index + 1} is empty.`);
    if (normalizedJapaneseLength(line) > maximumLength) failures.push(`${label} line ${index + 1} exceeds ${maximumLength} characters.`);
  });
}

function bubbleLineRange(lines) {
  if (lines === 1) return "exactly one line";
  if (lines === 2) return "one or two lines";
  return `between one and ${lines} lines`;
}

function slotTexts(plan) {
  const band = Array.isArray(plan.bandLines) ? plan.bandLines.filter((line) => nonEmpty(line)) : [];
  const speechBubble = Array.isArray(plan.speechBubbles)
    ? plan.speechBubbles.flatMap((bubble) => (Array.isArray(bubble?.lines) ? bubble.lines : [])).filter((line) => nonEmpty(line))
    : [];
  const telop = Array.isArray(plan.telops) ? plan.telops.map((telop) => telop?.text).filter((line) => nonEmpty(line)) : [];
  return { band, speechBubble, telop };
}

function checkLettering(plan, rules, texts, failures) {
  const lettering = plan.lettering;
  const report = { required: rules.lettering.required, slots: {} };
  if (lettering !== undefined && !plainObject(lettering)) {
    failures.push("thumbnail-lettering-invalid: lettering must map a text slot (band / speechBubble / telop) to its design.");
    return report;
  }
  for (const key of Object.keys(lettering || {})) {
    if (!THUMBNAIL_TEXT_SLOTS.includes(key)) failures.push(`thumbnail-lettering-unknown-slot:${key}: lettering is keyed by band / speechBubble / telop.`);
  }
  for (const slot of THUMBNAIL_TEXT_SLOTS) {
    const hasText = texts[slot].length > 0;
    const spec = lettering?.[slot];
    if (!plainObject(spec)) {
      if (hasText && rules.lettering.required) {
        failures.push(`thumbnail-lettering-required:${slot}: the ${slot} copy has text but no lettering design (${THUMBNAIL_LETTERING_FIELDS.join(", ")}). Unspecified lettering comes out as a default typeface on a flat plate.`);
      }
      report.slots[slot] = { hasText, specified: false };
      continue;
    }
    const missing = THUMBNAIL_LETTERING_FIELDS.filter((field) => !nonEmpty(spec[field]) || LETTERING_PLACEHOLDER.test(nonEmpty(spec[field])));
    if (hasText && missing.length > 0) {
      failures.push(`thumbnail-lettering-unspecified:${slot}:${missing.join(",")}: name each of ${THUMBNAIL_LETTERING_FIELDS.join(", ")} (carrier = the object the letters are on); "default" or blank does not count.`);
    }
    report.slots[slot] = { hasText, specified: missing.length === 0, missing };
  }
  return report;
}

function normalizedAxisText(value) {
  return nonEmpty(value).normalize("NFKC").replace(/\s+/gu, " ").toLowerCase();
}

/** 案の軸（読める軸だけ）。吹き出しの数は計画の吹き出しから数え、構図には配置の種類を含める。 */
export function thumbnailIdeaAxes(plan = {}) {
  const idea = plainObject(plan.idea) ? plan.idea : {};
  const payload = Array.isArray(idea.payload) ? [...new Set(idea.payload.map(normalizedAxisText).filter(Boolean))].sort() : [];
  return {
    bubbleCount: Array.isArray(plan.speechBubbles) ? plan.speechBubbles.length : 0,
    scene: normalizedAxisText(idea.scene),
    composition: `${nonEmpty(plan.layout)}|${normalizedAxisText(idea.composition)}`,
    beat: normalizedAxisText(idea.beat),
    payload: payload.join("|"),
  };
}

function checkIdea(plan, rules, failures) {
  const idea = plan.idea;
  if (idea === undefined || idea === null) {
    if (rules.ideas.required) failures.push(`thumbnail-idea-required: declare idea { scene, composition, beat, payload } so candidates can be compared on the reading axes (${THUMBNAIL_IDEA_AXES.join(", ")}).`);
    return null;
  }
  if (!plainObject(idea)) {
    failures.push("thumbnail-idea-invalid: idea must be an object.");
    return null;
  }
  for (const key of Object.keys(idea)) {
    if (THUMBNAIL_IDEA_FIELDS.includes(key)) continue;
    failures.push(THUMBNAIL_NON_READING_AXES.includes(key)
      ? `thumbnail-idea-non-reading-axis:${key}: typeface, band colour and tighter/wider framing do not make a different idea at the decided size; remove it from idea.`
      : `thumbnail-idea-unknown-axis:${key}: idea accepts ${THUMBNAIL_IDEA_FIELDS.join(", ")}.`);
  }
  for (const key of ["scene", "composition", "beat"]) {
    if (!nonEmpty(idea[key])) failures.push(`thumbnail-idea-axis-missing:${key}: name the ${key} of this candidate.`);
  }
  if (!Array.isArray(idea.payload) || idea.payload.filter((entry) => nonEmpty(entry)).length === 0) {
    failures.push("thumbnail-idea-axis-missing:payload: list what is on the thumbnail (people, objects).");
  }
  return { setId: nonEmpty(idea.setId), id: nonEmpty(idea.id), axes: thumbnailIdeaAxes(plan) };
}

async function resolveReferenceSha(reference, projectDir) {
  if (typeof reference === "string") {
    const value = reference.trim().toLowerCase();
    if (SHA256.test(value)) return { sha256: value, characterId: "" };
    const filePath = path.resolve(projectDir, reference);
    if (!insideProject(projectDir, filePath)) throw new Error("outside-project");
    return { sha256: sha256(await readFile(filePath)), characterId: "" };
  }
  if (!plainObject(reference)) throw new Error("invalid");
  const characterId = nonEmpty(reference.characterId);
  const direct = nonEmpty(reference.sha256).toLowerCase();
  if (direct) {
    if (!SHA256.test(direct)) throw new Error("invalid");
    return { sha256: direct, characterId };
  }
  const file = nonEmpty(reference.path);
  if (!file) throw new Error("invalid");
  const filePath = path.resolve(projectDir, file);
  if (!insideProject(projectDir, filePath)) throw new Error("outside-project");
  return { sha256: sha256(await readFile(filePath)), characterId };
}

async function checkCharacterReferences(plan, rules, projectDir, approvedReferences, failures) {
  const references = plan.characterReferences;
  const required = rules.characterReferences.required;
  if (references === undefined && plan.charactersVisible === undefined && !required) return null;
  const rows = [];
  if (required && typeof plan.charactersVisible !== "boolean") {
    failures.push("thumbnail-characters-visible-undeclared: set charactersVisible to true or false.");
  }
  if (references !== undefined && !Array.isArray(references)) {
    failures.push("thumbnail-character-references-invalid: characterReferences must be a list.");
    return { rows };
  }
  const list = Array.isArray(references) ? references : [];
  if (plan.charactersVisible === true && list.length === 0 && required) {
    failures.push("thumbnail-character-references-required: people are shown, so list the approved setting sheets the artwork is drawn from (by SHA-256).");
  }
  if (list.length === 0) return { rows };
  let approved = null;
  try {
    approved = typeof approvedReferences === "function" ? await approvedReferences() : null;
  } catch {
    approved = null;
  }
  if (!(approved instanceof Map)) {
    failures.push("thumbnail-approved-references-unavailable: the approved reference list could not be read, so the references cannot be checked.");
  }
  for (const [index, reference] of list.entries()) {
    try {
      const resolved = await resolveReferenceSha(reference, projectDir);
      const source = approved instanceof Map ? approved.get(resolved.sha256) || "" : "";
      rows.push({ characterId: resolved.characterId, sha256: resolved.sha256, approved: Boolean(source), source });
      if (approved instanceof Map && !source) {
        failures.push(`thumbnail-character-reference-unapproved:${resolved.characterId || index}:${resolved.sha256.slice(0, 12)}: this reference is not an approved setting sheet (checked by SHA-256, not by file name).`);
      }
    } catch (error) {
      failures.push(error?.message === "outside-project"
        ? `thumbnail-character-reference-outside-project:${index}: reference files must stay inside the project.`
        : `thumbnail-character-reference-invalid:${index}: give { characterId, sha256 } or a readable file inside the project.`);
    }
  }
  return { rows };
}

// ---------------------------------------------------------------------------------------------
// Job との結び付け
// ---------------------------------------------------------------------------------------------

async function defaultReadJob({ projectDir, jobId }) {
  // 動画 Job の層は重いので、結び付けを確かめるときだけ読む（置き場の規則は1か所: videoHarnessJobPath）。
  const { readVideoHarnessJob } = await import("./videoHarnessJob.mjs");
  return readVideoHarnessJob({ projectDir, jobId });
}

/**
 * サムネの計画の jobBinding（jobId・episodeId＝話数・videoSha256＝その回の完成動画の SHA-256）が、実在の
 * Job と一致するかを確かめる。サムネは Job の成果物にも Receipt の保証にも入れない。ここは記録の照合だけ。
 *   - Job が <project>/canvas/harness-runs/<jobId>/job.json に実在し、id とハーネスが一致する
 *   - Job に回の id があれば一致する（無い Job では計画の話数は確かめられないので警告）
 *   - final では、videoSha256 が Job の final-video の成果物の SHA と一致し、Job が completed
 */
export async function verifyThumbnailJobBinding({ binding, harnessId, projectDir, stage = "final", readJob = defaultReadJob } = {}) {
  const failures = [];
  const warnings = [];
  const report = {
    version: THUMBNAIL_JOB_BINDING_VERSION,
    jobId: nonEmpty(binding?.jobId),
    episodeId: nonEmpty(binding?.episodeId),
    videoSha256: nonEmpty(binding?.videoSha256).toLowerCase(),
    verified: false,
    jobStatus: "",
    jobEpisodeId: "",
  };
  if (!plainObject(binding)) {
    failures.push("thumbnail-job-binding-invalid: jobBinding must be { jobId, episodeId, videoSha256 }.");
    return { report, failures, warnings };
  }
  if (!JOB_ID.test(report.jobId)) {
    failures.push("thumbnail-job-binding-job-id-invalid: jobBinding.jobId must be a Video Harness Job id (video-<harness>-<16 hex>).");
    return { report, failures, warnings };
  }
  let job;
  try {
    job = await readJob({ projectDir, jobId: report.jobId });
  } catch {
    failures.push(`thumbnail-job-binding-job-missing:${report.jobId}: no Video Harness Job with this id under the project (canvas/harness-runs).`);
    return { report, failures, warnings };
  }
  report.jobStatus = nonEmpty(job?.status);
  report.jobEpisodeId = nonEmpty(job?.options?.episodeId);
  if (job?.id !== report.jobId) failures.push(`thumbnail-job-binding-job-id-mismatch:${report.jobId}: the Job file does not carry this id.`);
  if (nonEmpty(job?.harness?.id) !== harnessId) {
    failures.push(`thumbnail-job-binding-harness-mismatch:${nonEmpty(job?.harness?.id) || "(none)"}: the Job was made by another harness than ${harnessId}.`);
  }
  if (report.episodeId && report.jobEpisodeId && report.episodeId !== report.jobEpisodeId) {
    failures.push(`thumbnail-job-binding-episode-mismatch:${report.episodeId}: the Job is episode ${report.jobEpisodeId}.`);
  } else if (report.episodeId && !report.jobEpisodeId) {
    warnings.push(`thumbnail-job-binding-episode-unverified:${report.episodeId}: the Job has no episode id, so the episode label is recorded but not checked.`);
  }
  const finalVideos = (Array.isArray(job?.artifacts) ? job.artifacts : [])
    .filter((artifact) => artifact?.kind === "final-video" && SHA256.test(nonEmpty(artifact?.sha256).toLowerCase()))
    .map((artifact) => nonEmpty(artifact.sha256).toLowerCase());
  if (report.videoSha256 && !SHA256.test(report.videoSha256)) {
    failures.push("thumbnail-job-binding-video-sha-invalid: jobBinding.videoSha256 must be a 64-digit SHA-256.");
  } else if (stage === "final") {
    if (!report.videoSha256) failures.push("thumbnail-job-binding-video-sha-required: record the SHA-256 of the Job's final video in jobBinding.videoSha256.");
    else if (finalVideos.length === 0) failures.push(`thumbnail-job-binding-final-video-missing:${report.jobId}: the Job has no final video yet.`);
    else if (!finalVideos.includes(report.videoSha256)) failures.push(`thumbnail-job-binding-video-mismatch:${report.videoSha256.slice(0, 12)}: this is not the Job's final video.`);
    if (report.jobStatus !== "completed") failures.push(`thumbnail-job-binding-job-not-completed:${report.jobStatus || "(unknown)"}: publish the thumbnail only for a completed Job.`);
  } else if (report.videoSha256 && finalVideos.length > 0 && !finalVideos.includes(report.videoSha256)) {
    failures.push(`thumbnail-job-binding-video-mismatch:${report.videoSha256.slice(0, 12)}: this is not the Job's final video.`);
  }
  report.verified = failures.length === 0;
  return { report, failures, warnings };
}

// ---------------------------------------------------------------------------------------------
// 1つの計画の検査
// ---------------------------------------------------------------------------------------------

/**
 * サムネの計画を検査する（preflight: 生成してよいか / final: 公開してよいか）。
 *
 * options:
 *   rules              決まり（normalizeThumbnailRules を通す）
 *   plan               計画
 *   projectDir         画はこの中に置く
 *   assetQualityGate   async () => ({ check({ kind, index, path, subjectId }) }) | null。final の品質ループの照合。
 *                      null を返すと照合しない（漫画の v54 より前の契約だけ）。渡さなければ final は落ちる
 *   approvedReferences async () => Map<sha256, 出どころ>。登場人物の参照の照合
 *   readJob            Job の読み取り（試験用に差し替えられる）
 *   rulesProvenance    決まりの出どころ（{ kind: "signed-channel-pack" | "unsigned-file" | "project-authority", ... }）
 */
export async function auditThumbnailPlan(options = {}) {
  const rules = normalizeThumbnailRules(options.rules);
  const plan = options.plan && typeof options.plan === "object" ? options.plan : {};
  const projectDir = path.resolve(options.projectDir || process.cwd());
  const failures = [];
  const warnings = [];
  const require = (condition, message) => {
    if (!condition) failures.push(message);
  };
  const layoutIds = Object.keys(rules.layouts);
  require(plan.version === rules.planVersion, `Thumbnail plan version must be ${rules.planVersion}.`);
  if (plan.harnessId !== undefined && plan.harnessId !== rules.harnessId) {
    failures.push(`thumbnail-plan-harness-mismatch:${nonEmpty(plan.harnessId) || "(blank)"}: this plan is audited with the ${rules.harnessId} rules.`);
  }
  require(THUMBNAIL_STAGES.includes(plan.stage), "Thumbnail plan stage must be preflight or final.");
  require(layoutIds.includes(plan.layout), `Thumbnail layout must be ${layoutIds.join(" or ")}.`);
  if (hasOwn(rules.layouts, plan.layout) && rules.layouts[plan.layout].reasonRequired) {
    require(nonEmpty(plan[rules.layoutReasonField]), `${plan.layout} requires a concrete ${rules.layoutReasonField}.`);
  }

  // 文言（帯・禁止語・吹き出し・テロップ）。枠の無い決まりでは、その枠に文字を置けない。
  const { band, speechBubble, telop } = rules.copy;
  if (band) validateLines(plan.bandLines, band.lines, band.maxCharactersPerLine, "Band copy", failures);
  else if (Array.isArray(plan.bandLines) && plan.bandLines.some((line) => nonEmpty(line))) {
    failures.push("thumbnail-text-slot-not-allowed:band: this channel's thumbnail has no band copy.");
  }
  const termSlots = rules.copy.forbiddenTermSlots;
  const termTexts = [
    ...(termSlots.includes("band") ? [...(plan.bandLines || [])] : []),
    ...(termSlots.includes("speechBubble") ? (plan.speechBubbles || []).flatMap((entry) => entry.lines || []) : []),
    ...(termSlots.includes("telop") ? (Array.isArray(plan.telops) ? plan.telops : []).map((entry) => entry?.text) : []),
  ];
  for (const text of termTexts) {
    for (const term of rules.copy.forbiddenTerms) {
      if (String(text || "").includes(term.text)) failures.push(`Forbidden ${term.kind} '${term.text}' appears in thumbnail copy.`);
    }
  }
  const panelIds = new Set();
  const panelCounts = new Map();
  const bubbles = Array.isArray(plan.speechBubbles) ? plan.speechBubbles : [];
  if (!speechBubble && bubbles.length > 0) failures.push("thumbnail-text-slot-not-allowed:speechBubble: this channel's thumbnail has no speech bubbles.");
  for (const bubble of speechBubble ? bubbles : []) {
    if (!nonEmpty(bubble.panelId)) failures.push("Every speech bubble requires panelId.");
    if (speechBubble.perPanel === "pending") {
      // 1コマあたりの吹き出しの数がチャンネルで未決のとき（漫画の今の契約）は警告に留める。
      if (panelIds.has(bubble.panelId)) warnings.push(`Panel ${bubble.panelId} has more than one speech bubble; bubble count per panel is pending client decision.`);
    } else if (speechBubble.perPanel) {
      const count = (panelCounts.get(bubble.panelId) || 0) + 1;
      panelCounts.set(bubble.panelId, count);
      if (count === speechBubble.perPanel.maximum + 1) {
        failures.push(`thumbnail-speech-bubbles-per-panel:${bubble.panelId || "(unknown)"}: at most ${plural(speechBubble.perPanel.maximum, "speech bubble")} per panel.`);
      }
    }
    panelIds.add(bubble.panelId);
    if (!Array.isArray(bubble.lines) || bubble.lines.length < 1 || bubble.lines.length > speechBubble.lines) {
      failures.push(`Speech bubble ${bubble.panelId || "(unknown)"} requires ${bubbleLineRange(speechBubble.lines)}.`);
    } else {
      for (const [index, line] of bubble.lines.entries()) {
        if (normalizedJapaneseLength(line) > speechBubble.maxCharactersPerLine) failures.push(`Speech bubble ${bubble.panelId} line ${index + 1} exceeds ${speechBubble.maxCharactersPerLine} characters.`);
      }
    }
  }
  const telops = Array.isArray(plan.telops) ? plan.telops : [];
  if (!telop && telops.length > 0) failures.push("thumbnail-text-slot-not-allowed:telop: this channel's thumbnail has no telops.");
  for (const entry of telop ? telops : []) {
    const length = normalizedJapaneseLength(entry.text);
    if (length < telop.minCharacters || length > telop.maxCharacters) failures.push(`Telop '${entry.text || ""}' must be ${telop.minCharacters}-${telop.maxCharacters} characters.`);
    if (telop.concreteNounReviewRequired && entry.concreteNounReviewPassed !== true) failures.push(`Telop '${entry.text || ""}' requires concrete-noun human review.`);
  }
  const texts = slotTexts(plan);
  const hasText = THUMBNAIL_TEXT_SLOTS.some((slot) => texts[slot].length > 0);
  const approvalRequired = rules.copy.exactTextApproval === "always" || hasText;
  if (approvalRequired) require(plan.exactTextApproved === true, "Exact thumbnail text requires human approval.");
  const copySha256 = thumbnailCopySha256(plan, { reasonField: rules.layoutReasonField });
  if (approvalRequired) {
    require(nonEmpty(plan?.textApproval?.approvedBy) && validIsoDate(plan?.textApproval?.approvedAt), "Thumbnail text approval requires approvedBy and a valid ISO-8601 approvedAt.");
    require(plan?.textApproval?.copySha256 === copySha256, "Thumbnail text approval is stale or does not match the exact copy.");
  }
  const pendingTokens = rules.brandTokens.map((token) => token.value).filter((value) => /^PENDING_/u.test(nonEmpty(value)));
  if (pendingTokens.length > 0) failures.push(`Thumbnail brand tokens are pending: ${pendingTokens.join(", ")}.`);

  // 新しい検査（計画にその欄があるとき、または決まりが求めるとき）。漫画の今の計画には欄が無いので効かない。
  const lettering = plan.lettering !== undefined || (rules.lettering.required && hasText)
    ? checkLettering(plan, rules, texts, failures)
    : null;
  const idea = plan.idea !== undefined || rules.ideas.required ? checkIdea(plan, rules, failures) : null;
  const characterReferences = await checkCharacterReferences(plan, rules, projectDir, options.approvedReferences, failures);
  let jobBinding = null;
  if (plan.jobBinding !== undefined) {
    const verified = await verifyThumbnailJobBinding({
      binding: plan.jobBinding,
      harnessId: rules.harnessId,
      projectDir,
      stage: plan.stage === "final" ? "final" : "preflight",
      ...(options.readJob ? { readJob: options.readJob } : {}),
    });
    jobBinding = verified.report;
    failures.push(...verified.failures);
    warnings.push(...verified.warnings);
  } else if (rules.jobBinding.required) {
    if (plan.stage === "final") failures.push("thumbnail-job-binding-required: record jobBinding { jobId, episodeId, videoSha256 } for the Job this thumbnail belongs to.");
    else warnings.push("thumbnail-job-binding-required-at-final: the final audit needs jobBinding { jobId, episodeId, videoSha256 }.");
  }
  const provenance = plainObject(options.rulesProvenance) ? options.rulesProvenance : null;
  if (provenance?.kind === "unsigned-file") {
    if (plan.stage === "final") failures.push("thumbnail-rules-unsigned: the final audit needs the thumbnail rules from a signed Channel Pack.");
    else warnings.push("thumbnail-rules-unsigned: these rules come from an unsigned file (trial only).");
  }

  const artRows = [];
  const videoRows = [];
  const previousRows = [];
  let compositeRow = null;
  const assetQuality = [];
  if (plan.stage === "final") {
    const countLayout = hasOwn(rules.layouts, plan.layout) ? plan.layout : rules.defaultLayout;
    const expectedArtCount = rules.layouts[countLayout].panels;
    require(Array.isArray(plan.artworkPaths) && plan.artworkPaths.length === expectedArtCount, `${plan.layout} final audit requires ${expectedArtCount} dedicated artwork ${expectedArtCount === 1 ? "file" : "files"}.`);
    if (rules.source.dedicatedArtworkRequired) {
      require(Array.isArray(plan.mainVideoFramePaths) && plan.mainVideoFramePaths.length > 0, "Final thumbnail audit requires mainVideoFramePaths to prove non-reuse.");
    }
    const normalizedByPath = new Map();
    const collections = [
      [plan.artworkPaths, artRows, "artwork"],
      [plan.mainVideoFramePaths, videoRows, "video frame/source image"],
      ...(plan.previousThumbnailPaths !== undefined ? [[plan.previousThumbnailPaths, previousRows, "previous thumbnail"]] : []),
    ];
    for (const [collection, rows, label] of collections) {
      for (const value of Array.isArray(collection) ? collection : []) {
        const filePath = path.resolve(value);
        if (!insideProject(projectDir, filePath)) failures.push(`Thumbnail ${label} must stay inside the project: ${filePath}`);
        try {
          const { row, normalized } = await readImageRow(filePath);
          normalizedByPath.set(filePath, normalized);
          rows.push(row);
        } catch { failures.push(`Thumbnail ${label} is missing: ${filePath}`); }
      }
    }
    const reuseDistance = rules.source.reuseDistance;
    const reuse = (line) => (rules.source.dedicatedArtworkRequired ? failures : warnings).push(line);
    const frameDigests = new Set(videoRows.map((row) => row.sha256));
    for (const row of artRows) if (frameDigests.has(row.sha256)) reuse(`Dedicated thumbnail artwork reuses a main-video frame: ${row.path}`);
    for (const artwork of artRows) {
      for (const frame of videoRows) {
        const distance = normalizedPixelDistance(normalizedByPath.get(artwork.path), normalizedByPath.get(frame.path));
        if (distance < reuseDistance) reuse(`Dedicated thumbnail artwork is perceptually the same as a main-video frame/source image (distance=${distance.toFixed(4)}): ${artwork.path}`);
      }
    }
    if (rules.finalChecks.some((key) => plan?.checks?.[key] !== true)) {
      failures.push(`Final thumbnail audit requires all checks: ${rules.finalChecks.join(", ")}.`);
    }

    // 過去のサムネの画・同じサムネの別のコマの使い回し。
    const previousDigests = new Set(previousRows.map((row) => row.sha256));
    for (const artwork of artRows) {
      if (previousDigests.has(artwork.sha256)) failures.push(`thumbnail-artwork-reuses-previous-thumbnail: ${artwork.path}`);
      else if (previousRows.some((row) => normalizedPixelDistance(normalizedByPath.get(artwork.path), normalizedByPath.get(row.path)) < reuseDistance)) {
        failures.push(`thumbnail-artwork-perceptually-reuses-previous-thumbnail: ${artwork.path}`);
      }
    }
    if (rules.source.distinctPanelArtwork) {
      for (let left = 0; left < artRows.length; left += 1) {
        for (let right = left + 1; right < artRows.length; right += 1) {
          const same = artRows[left].sha256 === artRows[right].sha256
            || normalizedPixelDistance(normalizedByPath.get(artRows[left].path), normalizedByPath.get(artRows[right].path)) < reuseDistance;
          if (same) failures.push(`thumbnail-panel-artwork-duplicated:${left + 1}:${right + 1}: two panels use the same artwork.`);
        }
      }
    }

    // 完成画（帯と文字を載せた、公開する1枚）。原寸ぴったりで、人の確認はこの版に結び付ける。
    const compositePath = nonEmpty(plan.compositePath);
    if (!compositePath && rules.composite.required) failures.push("thumbnail-composite-required: add compositePath (the finished thumbnail that will be published).");
    if (compositePath) {
      const filePath = path.resolve(projectDir, compositePath);
      if (!insideProject(projectDir, filePath)) failures.push(`thumbnail-composite-outside-project: ${filePath}`);
      try {
        compositeRow = (await readImageRow(filePath)).row;
        const { width, height } = compositeRow.dimensions || {};
        if (width !== rules.canvas.width || height !== rules.canvas.height) {
          failures.push(`thumbnail-composite-size:${width || "?"}x${height || "?"}: the composite must be exactly ${rules.canvas.width}x${rules.canvas.height}.`);
        }
      } catch { failures.push(`thumbnail-composite-missing: ${filePath}`); }
    }
    if (rules.finalChecksBinding === "composite") {
      const bound = nonEmpty(plan?.checks?.compositeSha256).toLowerCase();
      if (!compositeRow || bound !== compositeRow.sha256) {
        failures.push("thumbnail-checks-stale: checks.compositeSha256 must be the SHA-256 of the composite that was viewed at original and decided size.");
      }
    }

    // 品質ループ: 専用画ごと（と完成画）に thumbnail 工程の合格が要る。自己申告の checks だけでは合格にしない。
    const gateFactory = typeof options.assetQualityGate === "function" ? options.assetQualityGate : null;
    const gate = gateFactory ? await gateFactory() : undefined;
    if (gate === undefined) {
      failures.push("thumbnail-asset-quality-unavailable: the final audit needs the asset quality loop (stage thumbnail) for every artwork.");
    } else if (gate) {
      for (const [index, value] of (Array.isArray(plan.artworkPaths) ? plan.artworkPaths : []).entries()) {
        assetQuality.push(await gate.check({
          kind: "artwork",
          index,
          path: path.resolve(String(value || "")),
          subjectId: thumbnailArtworkQualitySubjectId(plan, index, value),
        }));
      }
      if (compositePath) {
        assetQuality.push(await gate.check({
          kind: "composite",
          index: 0,
          path: path.resolve(projectDir, compositePath),
          subjectId: thumbnailCompositeQualitySubjectId(plan, compositePath),
        }));
      }
      failures.push(...assetQualityUseFailureLines(assetQuality));
    }
  } else if (Array.isArray(plan.artworkPaths) && plan.artworkPaths.length > 0) {
    warnings.push("Preflight ignores artwork files; use stage=final after dedicated artwork is generated.");
  }
  return {
    version: rules.auditVersion,
    harnessId: rules.harnessId,
    pass: failures.length === 0,
    readyForGeneration: failures.length === 0 && plan.stage === "preflight",
    readyForPublish: failures.length === 0 && plan.stage === "final",
    contractStatus: rules.status,
    ...(provenance ? { rulesProvenance: provenance } : {}),
    copySha256,
    pendingTokens,
    decidedSize: { ...rules.decidedSize },
    artwork: artRows,
    videoFrames: videoRows,
    previousThumbnails: previousRows,
    composite: compositeRow,
    lettering,
    idea,
    characterReferences,
    jobBinding,
    assetQuality: assetQuality.map(({ stage, subjectId, assetPath, pass, reason, code }) => ({ stage, subjectId, assetPath, pass, reason, code })),
    failures,
    warnings,
  };
}

// ---------------------------------------------------------------------------------------------
// 案どうしの検査（別アイデアとして読めるか）
// ---------------------------------------------------------------------------------------------

/**
 * 並べる案（2案以上）が、読める軸で別のアイデアになっているか。
 *   - どの2案も、読める軸（吹き出しの数・場面・構図・ビート・載せ物）のうち minimumDistinctAxes 個以上が違う
 *   - final の2案が同じ画（どの専用画も相手のどれかと同じ）で吹き出しの数も同じなら、宣言した軸が違っても
 *     同じ案として落とす（軸の文章だけで差を認めない）
 * plans: [{ plan, label }]（label は結果に載せる名前。無ければ idea.id か番号）
 */
export async function auditThumbnailIdeaSet({ rules: input, plans = [], projectDir = process.cwd() } = {}) {
  const rules = normalizeThumbnailRules(input);
  const root = path.resolve(projectDir);
  const failures = [];
  const warnings = [];
  const entries = (Array.isArray(plans) ? plans : []).map((entry, index) => {
    const plan = plainObject(entry?.plan) ? entry.plan : (plainObject(entry) ? entry : {});
    const ideaFailures = [];
    const idea = checkIdea(plan, { ...rules, ideas: { ...rules.ideas, required: true } }, ideaFailures);
    const label = nonEmpty(entry?.label) || idea?.id || `candidate-${index + 1}`;
    for (const line of ideaFailures) failures.push(`${label}: ${line}`);
    return { label, plan, idea };
  });
  if (entries.length < 2) failures.push("thumbnail-ideas-too-few: compare at least two candidates.");
  const labels = entries.map((entry) => entry.label);
  const duplicateLabels = labels.filter((label, index) => labels.indexOf(label) !== index);
  for (const label of new Set(duplicateLabels)) failures.push(`thumbnail-ideas-duplicate-id:${label}: every candidate needs its own idea.id.`);
  const setIds = [...new Set(entries.map((entry) => entry.idea?.setId).filter(Boolean))];
  if (setIds.length > 1) failures.push(`thumbnail-ideas-mixed-sets:${setIds.join(",")}: compare candidates of one set.`);
  const artwork = new Map();
  for (const entry of entries) {
    const rows = [];
    if (entry.plan.stage === "final") {
      for (const value of Array.isArray(entry.plan.artworkPaths) ? entry.plan.artworkPaths : []) {
        const filePath = path.resolve(String(value || ""));
        if (!insideProject(root, filePath)) continue;
        try { rows.push((await readImageRow(filePath)).normalized); } catch { /* 読めない画は計画の検査が落とす */ }
      }
    }
    artwork.set(entry.label, rows);
  }
  const sameArtwork = (left, right) => left.length > 0 && right.length > 0
    && left.every((a) => right.some((b) => normalizedPixelDistance(a, b) < rules.source.reuseDistance))
    && right.every((b) => left.some((a) => normalizedPixelDistance(a, b) < rules.source.reuseDistance));
  const pairs = [];
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i];
      const b = entries[j];
      if (!a.idea || !b.idea) continue;
      const distinctAxes = THUMBNAIL_IDEA_AXES.filter((axis) => a.idea.axes[axis] !== b.idea.axes[axis]);
      const shared = sameArtwork(artwork.get(a.label), artwork.get(b.label));
      pairs.push({ a: a.label, b: b.label, distinctAxes, sameArtwork: shared });
      if (distinctAxes.length < rules.ideas.minimumDistinctAxes) {
        failures.push(`thumbnail-ideas-not-distinct:${a.label}:${b.label}: they differ on ${distinctAxes.length ? distinctAxes.join(", ") : "no reading axis"}; at least ${rules.ideas.minimumDistinctAxes} of ${THUMBNAIL_IDEA_AXES.join(", ")} must differ (typeface, band colour and tighter/wider framing do not count).`);
      } else if (shared && !distinctAxes.includes("bubbleCount")) {
        failures.push(`thumbnail-ideas-same-artwork:${a.label}:${b.label}: both use the same artwork with the same number of speech bubbles, so the declared difference (${distinctAxes.join(", ")}) is not visible.`);
      }
    }
  }
  return {
    version: THUMBNAIL_IDEA_SET_AUDIT_VERSION,
    harnessId: rules.harnessId,
    pass: failures.length === 0,
    candidates: entries.map((entry) => ({ label: entry.label, id: entry.idea?.id || "", axes: entry.idea?.axes || null })),
    pairs,
    failures,
    warnings,
  };
}
