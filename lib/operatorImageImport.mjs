/**
 * 運営者が用意した画を、来歴つきで公式経路へ取り込む（共有層。ジャンルに依存しない）。
 *
 * 公式経路の画は、これまで有料の Media Job（image.generation）でしか入らなかった。運営者は本編の画を
 * ChatGPT の web 画面・Codex・自前のローカルモデル・Grok などハーネスの外で作るので、その画を
 * 「どこで・どのモデルで・どのプロンプトで・どの承認済みの設定画を参照して・いつ作ったか」と一緒に
 * 取り込む入口がここ。BGM の `source.kind: "operator-file"`（運営者の曲）と同じ考え方で、
 * 費用は有料の Media Job に数えず「運営者の外部の契約」として記録する。
 *
 * 取り込みの記録（manifest、運営者が書く）の形:
 *
 *   {
 *     "version": "buzzassist-operator-image-manifest-v1",
 *     "scenes": [{
 *       "sceneId": "p001",                               // 台本の場面 id（台本パッケージの story[].id / review[].id）
 *       "image": { "path": "images/p001.png", "sha256": "<64桁>", "width": 1536, "height": 1024 },
 *       "route": "chatgpt-web",                          // chatgpt-web / codex / local-model / grok / other
 *       "routeNote": "…",                                // route が other のときだけ必須
 *       "modelLabel": "…",                               // 運営者が書くモデルの表示名
 *       "prompt": { "path": "prompts/p001.txt", "sha256": "<64桁>" },   // プロンプト全文のファイル
 *       "referenceSha256s": ["<承認済みの設定画の sha256>"],
 *       "generatedAt": "2026-09-25T10:00:00+09:00",
 *       "conversationUrl": "https://…",                  // chatgpt-web は必須。私有の Job フォルダにだけ残す
 *       "reuseReason": "…",                              // 同じ画を別の場面にも使うときは必須
 *       "assetLoop": { "statePath": "…", "passedSha256": "<64桁>" }   // 途中の成果物の品質ループ（任意）
 *     }]
 *   }
 *
 * パスは manifest のあるフォルダからの相対（区切りは "/"）。フォルダの外・絶対パス・"\\"・".." は受けない。
 *
 * 守ること:
 *   - 検査は全部、有料の処理の前に理由コードつきで止める（sha256 の不一致・場面の過不足・理由の無い使い回し・
 *     承認されていない参照・寸法の大きな違い・品質ループの未合格）
 *   - 会話の URL・経路の注記・使い回しの理由の本文は、私有の Job フォルダの記録（writePrivateRecord）にだけ
 *     残す。公開面（生成記録・監査・RunReceipt・Canvas）へ出すのは sha256 だけ
 *   - 寸法は1px違うことがある。Channel Pack が宣言した許容の幅の中なら、拡大と中央の切り取りで
 *     決まった寸法へ合わせ、その方法（倍率・切り取った画素）を記録する。幅を越えたら止める
 *   - 取り込んだ画の鍵（importKey）は元の画の sha256 と合わせ方から作る。画が差し替われば別の入力になり、
 *     再開（resume）は作り直す
 */

import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { readJsonIfExists, renameWithRetry } from "./atomicJsonFile.mjs";
import { getImageDimensionsFromBuffer } from "./imageDimensions.mjs";

const execFile = promisify(execFileCallback);

export const OPERATOR_IMAGE_MANIFEST_VERSION = "buzzassist-operator-image-manifest-v1";
/** 公開面へ出す取り込みの記録の版（sha256 と経路だけ）。 */
export const OPERATOR_IMAGE_IMPORT_VERSION = "buzzassist-operator-image-import-v1";
/** 私有の Job フォルダにだけ置く記録の版（会話の URL などの本文を持つ）。 */
export const OPERATOR_IMAGE_PRIVATE_RECORD_VERSION = "buzzassist-operator-image-private-record-v1";
export const OPERATOR_IMAGE_SIDECAR_VERSION = "buzzassist-operator-image-sidecar-v1";
/** 画の出どころ。broker は有料の Media Job（既定）、operator-file は運営者が用意した画。 */
export const OPERATOR_IMAGE_SOURCES = Object.freeze(["broker", "operator-file"]);
/**
 * 生成の経路。自由記述にすると同じ経路が別名で数えられ、経路ごとに後から比べられない。
 * 途中の成果物の品質ループ（lib/assetQualityLoop.mjs）の経路の名前と揃えてある。
 */
export const OPERATOR_IMAGE_ROUTES = Object.freeze(["chatgpt-web", "codex", "local-model", "grok", "other"]);
/** 会話の URL が無いと来歴を辿れない経路。 */
export const OPERATOR_IMAGE_ROUTES_REQUIRING_CONVERSATION = Object.freeze(["chatgpt-web"]);
/**
 * manifest の置き場。job-option は「Job の引数で渡す」（CLI --operator-image-manifest / Job の
 * options.operatorImageManifestPath）。Channel Pack は署名してチャンネルに1つなので、回ごとの画は置かない。
 */
export const OPERATOR_IMAGE_MANIFEST_LOCATIONS = Object.freeze(["job-option"]);
/** 寸法の合わせ方（倍率を上げて覆い、中央を切り取る）。 */
export const OPERATOR_IMAGE_FIT = "cover-center-crop";
export const OPERATOR_IMAGE_COST_BASIS = "operator-external-contract";
/** 途中の成果物の品質ループでの工程名（lib/assetQualityLoop.mjs の scene-image）。 */
export const OPERATOR_IMAGE_ASSET_LOOP_STAGE = "scene-image";
/**
 * 品質ループ本体が取り込み専用の検査を持つときの関数名。無ければ本体の assetQualityStatus で確かめ、
 * どちらも無ければ requireAssetLoopPass は止める。
 */
export const OPERATOR_IMAGE_ASSET_LOOP_VERIFIER = "verifyAssetLoopPassForImport";

export const OPERATOR_IMAGE_MANIFEST_FIELDS = Object.freeze({
  top: Object.freeze(["version", "scenes", "note"]),
  scene: Object.freeze([
    "sceneId", "image", "route", "routeNote", "modelLabel", "prompt", "referenceSha256s",
    "generatedAt", "conversationUrl", "reuseReason", "assetLoop",
  ]),
  image: Object.freeze(["path", "sha256", "width", "height"]),
  prompt: Object.freeze(["path", "sha256"]),
  assetLoop: Object.freeze(["statePath", "passedSha256"]),
});
export const OPERATOR_IMAGE_POLICY_FIELDS = Object.freeze([
  "manifest", "expectedSize", "tolerancePx", "fit", "approvedReferences", "requireAssetLoopPass",
]);

export const DEFAULT_OPERATOR_IMAGE_TOLERANCE_PX = 2;
const MAX_TOLERANCE_PX = 16;
/** 宣言した寸法から決まった寸法へ合わせるときの上限（これを越える宣言は Pack の段階で止める）。 */
export const OPERATOR_IMAGE_MAX_UPSCALE = 2;
export const OPERATOR_IMAGE_MAX_CROP_FRACTION = 0.25;
const MAX_SCENES = 2_000;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_PROMPT_BYTES = 1024 * 1024;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT = 2_000;
const MAX_URL = 2_048;
/** 生成した時刻が未来すぎる記録は、書き間違いとして止める（端末の時計のずれは許す）。 */
const FUTURE_SKEW_MS = 10 * 60_000;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const SCENE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/u;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

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
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** 取り込みの記録の文（注記・理由・モデル名）。制御文字と長すぎる文は受けない（動画の取り込みも使う）。 */
export function boundedText(value, maximum = MAX_TEXT) {
  const text = nonEmpty(value);
  if (!text || [...text].length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) return "";
  return text;
}

function positiveInteger(value, minimum = 1, maximum = 16_384) {
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : null;
}

export function lowerSha(value) {
  const text = nonEmpty(value).toLowerCase();
  return SHA256_HEX.test(text) ? text : "";
}

function imageFormat(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp";
  return "";
}

/** 画の寸法（PNG / JPEG / WebP の見出しだけを読む。寸法の読み方は lib/imageDimensions.mjs の1か所）。 */
export function operatorImageInfo(bytes) {
  const format = imageFormat(bytes);
  if (!format) return null;
  try {
    const { width, height } = getImageDimensionsFromBuffer(bytes, "operator image");
    if (!positiveInteger(width, 1, 65_535) || !positiveInteger(height, 1, 65_535)) return null;
    return { format, width, height };
  } catch {
    return null;
  }
}

/**
 * manifest の中の相対パスを、manifest のあるフォルダの中の絶対パスにする。区切りは "/" だけを受ける
 * （"\\" は Windows でしか区切りにならないので、同じ manifest が OS で別のファイルを指さないように拒む）。
 * pathApi を差し替えると Windows の規則（path.win32）でも同じ判定になる（試験が見る）。
 */
export function resolveManifestRelativePath(baseDir, value, { pathApi = path } = {}) {
  const text = nonEmpty(value);
  if (!text || text.includes("\\") || /^[A-Za-z]:/u.test(text) || text.startsWith("/") || pathApi.isAbsolute(text)) return null;
  const parts = text.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  const full = pathApi.resolve(baseDir, ...parts);
  const rel = pathApi.relative(baseDir, full);
  if (!rel || rel === ".." || rel.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(rel)) return null;
  return { full, rel: parts.join("/") };
}

/** ファイルを読む。シンボリックリンク・フォルダの外（実体のパスで比べる）・大きすぎるものは読まない。 */
async function readInside(realBaseDir, full, maximumBytes) {
  let info;
  try {
    info = await lstat(full);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { ok: false, reason: "missing" };
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) return { ok: false, reason: "not-a-regular-file" };
  if (info.size === 0) return { ok: false, reason: "empty" };
  if (info.size > maximumBytes) return { ok: false, reason: "too-large" };
  const real = await realpath(full);
  const rel = path.relative(realBaseDir, real);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return { ok: false, reason: "outside-manifest-folder" };
  const bytes = await readFile(real);
  return { ok: true, bytes, realPath: real };
}

/**
 * Channel Pack の画の出どころの宣言（ジャンルが自分の設定の置き場から `image` を渡す）。
 *
 *   "image": {
 *     "source": "operator-file",                // 既定は broker（有料の Media Job）
 *     "operatorFile": {
 *       "manifest": { "location": "job-option" },
 *       "expectedSize": { "width": 1536, "height": 1024 },   // 任意。既定は描く寸法（render）
 *       "tolerancePx": 2,                                     // 任意。0〜16、既定 2
 *       "fit": "cover-center-crop",                           // 任意。これだけ
 *       "approvedReferences": { "sha256": ["<64桁>"], "characterRegistry": true },
 *       "requireAssetLoopPass": false
 *     }
 *   }
 *
 * 場面ごとの混在（一部だけ broker）は受けない。operator-file の Job は全部の場面の画を manifest から
 * 取り込み、足りない場面は有料生成へ落とさずに止める（黙って課金の経路へ流れないように）。
 */
export function normalizeOperatorImageSourceConfig(image, { render = null, label = "image" } = {}) {
  const blockers = [];
  const declared = plainObject(image) && image.source !== undefined ? nonEmpty(image.source) : "broker";
  if (!OPERATOR_IMAGE_SOURCES.includes(declared)) {
    return { config: { source: "broker", invalid: true }, blockers: [`${label}.source`] };
  }
  if (declared === "broker") {
    if (plainObject(image) && image.operatorFile !== undefined) blockers.push(`${label}.operatorFile-requires-operator-file-source`);
    return { config: { source: "broker" }, blockers };
  }
  const spec = image.operatorFile;
  const at = `${label}.operatorFile`;
  if (!plainObject(spec)) return { config: { source: "operator-file", invalid: true }, blockers: [at] };
  for (const key of Object.keys(spec)) if (!OPERATOR_IMAGE_POLICY_FIELDS.includes(key)) blockers.push(`${at}.${key}-unknown`);
  let manifestLocation = "";
  if (!plainObject(spec.manifest) || Object.keys(spec.manifest).some((key) => key !== "location")
    || !OPERATOR_IMAGE_MANIFEST_LOCATIONS.includes(nonEmpty(spec.manifest.location))) {
    blockers.push(`${at}.manifest.location`);
  } else manifestLocation = nonEmpty(spec.manifest.location);
  const renderWidth = positiveInteger(render?.width) || null;
  const renderHeight = positiveInteger(render?.height) || null;
  let expectedSize = renderWidth && renderHeight ? { width: renderWidth, height: renderHeight } : null;
  if (spec.expectedSize !== undefined) {
    const width = positiveInteger(spec.expectedSize?.width, 16, 16_384);
    const height = positiveInteger(spec.expectedSize?.height, 16, 16_384);
    if (!plainObject(spec.expectedSize) || Object.keys(spec.expectedSize).some((key) => !["width", "height"].includes(key)) || !width || !height) {
      blockers.push(`${at}.expectedSize`);
    } else expectedSize = { width, height };
  }
  if (!expectedSize) blockers.push(`${at}.expectedSize`);
  let tolerancePx = DEFAULT_OPERATOR_IMAGE_TOLERANCE_PX;
  if (spec.tolerancePx !== undefined) {
    if (!Number.isInteger(spec.tolerancePx) || spec.tolerancePx < 0 || spec.tolerancePx > MAX_TOLERANCE_PX) blockers.push(`${at}.tolerancePx`);
    else tolerancePx = spec.tolerancePx;
  }
  if (spec.fit !== undefined && spec.fit !== OPERATOR_IMAGE_FIT) blockers.push(`${at}.fit`);
  const approvedSha256 = [];
  let characterRegistry = false;
  if (spec.approvedReferences !== undefined) {
    const references = spec.approvedReferences;
    if (!plainObject(references)) blockers.push(`${at}.approvedReferences`);
    else {
      for (const key of Object.keys(references)) {
        if (!["sha256", "characterRegistry"].includes(key)) blockers.push(`${at}.approvedReferences.${key}-unknown`);
      }
      if (references.sha256 !== undefined) {
        if (!Array.isArray(references.sha256)) blockers.push(`${at}.approvedReferences.sha256`);
        else {
          for (const value of references.sha256) {
            const sha = lowerSha(value);
            if (!sha) blockers.push(`${at}.approvedReferences.sha256`);
            else if (!approvedSha256.includes(sha)) approvedSha256.push(sha);
          }
        }
      }
      if (references.characterRegistry !== undefined) {
        if (typeof references.characterRegistry !== "boolean") blockers.push(`${at}.approvedReferences.characterRegistry`);
        else characterRegistry = references.characterRegistry;
      }
    }
  }
  if (spec.requireAssetLoopPass !== undefined && typeof spec.requireAssetLoopPass !== "boolean") blockers.push(`${at}.requireAssetLoopPass`);
  // 宣言した寸法を描く寸法へ合わせるときの倍率と切り取りが大きすぎる宣言は、画を読む前に止める。
  if (expectedSize && renderWidth && renderHeight) {
    const fit = operatorImageFit(expectedSize, { width: renderWidth, height: renderHeight });
    if (fit.scale > OPERATOR_IMAGE_MAX_UPSCALE) blockers.push(`${at}.expectedSize-upscale-too-large`);
    if (fit.cropFraction.x > OPERATOR_IMAGE_MAX_CROP_FRACTION || fit.cropFraction.y > OPERATOR_IMAGE_MAX_CROP_FRACTION) {
      blockers.push(`${at}.expectedSize-crop-too-large`);
    }
  }
  return {
    config: {
      source: "operator-file",
      manifestLocation,
      expectedSize,
      tolerancePx,
      fit: OPERATOR_IMAGE_FIT,
      approvedReferences: { sha256: approvedSha256, characterRegistry },
      requireAssetLoopPass: spec.requireAssetLoopPass === true,
    },
    blockers: [...new Set(blockers)],
  };
}

/**
 * 画を決まった寸法へ合わせる方法（倍率を上げて覆い、中央を切り取る）。記録に残す値そのもの。
 * 寸法が同じなら method は none（画素に手を入れない）。
 */
export function operatorImageFit(source, target) {
  const width = Number(source?.width);
  const height = Number(source?.height);
  const scale = Math.max(target.width / width, target.height / height);
  const scaledWidth = Math.max(target.width, Math.round(width * scale));
  const scaledHeight = Math.max(target.height, Math.round(height * scale));
  const exact = width === target.width && height === target.height;
  return {
    method: exact ? "none" : OPERATOR_IMAGE_FIT,
    source: { width, height },
    target: { width: target.width, height: target.height },
    scale: Number(scale.toFixed(6)),
    scaled: { width: scaledWidth, height: scaledHeight },
    crop: {
      x: Math.floor((scaledWidth - target.width) / 2),
      y: Math.floor((scaledHeight - target.height) / 2),
      width: target.width,
      height: target.height,
    },
    cropFraction: {
      x: Number((1 - target.width / scaledWidth).toFixed(6)),
      y: Number((1 - target.height / scaledHeight).toFixed(6)),
    },
  };
}

export function normalizedTimestamp(value, now) {
  const text = nonEmpty(value);
  // 日付だけ・時差の無い書き方は、どの時刻か決まらないので受けない。
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(text)) return { ok: false };
  const time = Date.parse(text);
  if (!Number.isFinite(time)) return { ok: false };
  return { ok: true, value: new Date(time).toISOString(), future: time > now.getTime() + FUTURE_SKEW_MS };
}

export function conversationUrlOf(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return { present: false };
  if (text.length > MAX_URL || /\s/u.test(text)) return { present: true, ok: false };
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return { present: true, ok: false };
  }
  if (parsed.protocol !== "https:" || !parsed.hostname) return { present: true, ok: false };
  return { present: true, ok: true, value: text, sha256: sha256(text) };
}

/**
 * manifest と、それが指すファイル（画・プロンプト・品質ループの状態）を読み、実測の sha256 と寸法を持った
 * 行を返す。場面の過不足・参照の承認・寸法の許容はここでは見ない（checkOperatorImageImport）。
 * `digest` は実測の sha256 から作るので、manifest を直さずに画だけ差し替えても変わる（再開が気づく）。
 */
export async function readOperatorImageManifest({ manifestPath, now = new Date() } = {}) {
  const problems = [];
  const base = {
    ok: false,
    manifestPath: "",
    manifestDir: "",
    manifestSha256: "",
    rows: [],
    bytes: null,
    digest: "",
  };
  if (!nonEmpty(manifestPath)) return { ...base, problems: ["operator-image-manifest-required"] };
  const absolute = path.resolve(nonEmpty(manifestPath));
  let info;
  try {
    info = await lstat(absolute);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { ...base, manifestPath: absolute, problems: ["operator-image-manifest-missing"] };
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile() || info.size === 0 || info.size > MAX_MANIFEST_BYTES) {
    return { ...base, manifestPath: absolute, problems: ["operator-image-manifest-unreadable"] };
  }
  const bytes = await readFile(absolute);
  const manifestSha256 = sha256(bytes);
  const manifestDir = await realpath(path.dirname(absolute));
  const result = { ...base, manifestPath: absolute, manifestDir, manifestSha256, bytes };
  let body;
  try {
    body = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { ...result, problems: ["operator-image-manifest-invalid:json"], digest: sha256(canonicalJson({ manifestSha256 })) };
  }
  if (!plainObject(body)) return { ...result, problems: ["operator-image-manifest-invalid:not-an-object"], digest: sha256(canonicalJson({ manifestSha256 })) };
  if (body.version !== OPERATOR_IMAGE_MANIFEST_VERSION) {
    return {
      ...result,
      problems: [`operator-image-manifest-version-unsupported:${boundedText(String(body.version ?? ""), 64).replace(/[^A-Za-z0-9._-]/gu, "-") || "missing"}`],
      digest: sha256(canonicalJson({ manifestSha256 })),
    };
  }
  for (const key of Object.keys(body)) if (!OPERATOR_IMAGE_MANIFEST_FIELDS.top.includes(key)) problems.push(`operator-image-manifest-invalid:${key}-unknown`);
  if (!Array.isArray(body.scenes) || body.scenes.length === 0) problems.push("operator-image-manifest-invalid:scenes");
  else if (body.scenes.length > MAX_SCENES) problems.push("operator-image-manifest-invalid:too-many-scenes");
  const rows = [];
  const seen = new Set();
  const scenes = Array.isArray(body.scenes) ? body.scenes.slice(0, MAX_SCENES) : [];
  for (const [index, entry] of scenes.entries()) {
    const at = `scenes[${index}]`;
    if (!plainObject(entry)) { problems.push(`operator-image-manifest-invalid:${at}`); continue; }
    for (const key of Object.keys(entry)) if (!OPERATOR_IMAGE_MANIFEST_FIELDS.scene.includes(key)) problems.push(`operator-image-manifest-invalid:${at}.${key}-unknown`);
    const sceneId = nonEmpty(entry.sceneId);
    if (!SCENE_ID.test(sceneId)) { problems.push(`operator-image-scene-id-invalid:${at}`); continue; }
    if (seen.has(sceneId)) { problems.push(`operator-image-scene-duplicated:${sceneId}`); continue; }
    seen.add(sceneId);
    const add = (code) => problems.push(`${code}:${sceneId}`);
    const row = { index, sceneId };

    // 画
    const image = entry.image;
    row.image = { sha256: "", declaredSha256: "", width: null, height: null, format: "", bytes: 0, full: "", rel: "" };
    if (!plainObject(image)) add("operator-image-file-required");
    else {
      for (const key of Object.keys(image)) if (!OPERATOR_IMAGE_MANIFEST_FIELDS.image.includes(key)) problems.push(`operator-image-manifest-invalid:${at}.image.${key}-unknown`);
      const resolved = resolveManifestRelativePath(manifestDir, image.path);
      const declaredSha256 = lowerSha(image.sha256);
      const declaredWidth = positiveInteger(image.width, 1, 65_535);
      const declaredHeight = positiveInteger(image.height, 1, 65_535);
      row.image.declaredSha256 = declaredSha256;
      if (!declaredSha256) add("operator-image-sha256-required");
      if (!declaredWidth || !declaredHeight) add("operator-image-size-required");
      if (!resolved) add("operator-image-path-invalid");
      else {
        row.image.full = resolved.full;
        row.image.rel = resolved.rel;
        const read = await readInside(manifestDir, resolved.full, MAX_IMAGE_BYTES);
        if (!read.ok) add(read.reason === "missing" ? "operator-image-file-missing" : "operator-image-file-unreadable");
        else {
          row.image.sha256 = sha256(read.bytes);
          row.image.bytes = read.bytes.length;
          const measured = operatorImageInfo(read.bytes);
          if (!measured) add("operator-image-format-unsupported");
          else {
            row.image.format = measured.format;
            row.image.width = measured.width;
            row.image.height = measured.height;
            if (declaredWidth && declaredHeight && (declaredWidth !== measured.width || declaredHeight !== measured.height)) {
              add("operator-image-declared-size-mismatch");
            }
          }
          if (declaredSha256 && declaredSha256 !== row.image.sha256) add("operator-image-sha256-mismatch");
        }
      }
    }

    // 経路とモデル
    row.route = nonEmpty(entry.route);
    if (!OPERATOR_IMAGE_ROUTES.includes(row.route)) add("operator-image-route-invalid");
    row.routeNote = entry.routeNote === undefined ? "" : boundedText(entry.routeNote);
    if (entry.routeNote !== undefined && !row.routeNote) add("operator-image-route-note-invalid");
    if (row.route === "other" && !row.routeNote) add("operator-image-route-note-required");
    row.modelLabel = boundedText(entry.modelLabel, 120);
    if (!row.modelLabel) add("operator-image-model-label-required");

    // プロンプト全文のファイル
    row.prompt = { sha256: "", declaredSha256: "", full: "", rel: "" };
    if (!plainObject(entry.prompt)) add("operator-image-prompt-required");
    else {
      for (const key of Object.keys(entry.prompt)) if (!OPERATOR_IMAGE_MANIFEST_FIELDS.prompt.includes(key)) problems.push(`operator-image-manifest-invalid:${at}.prompt.${key}-unknown`);
      const resolved = resolveManifestRelativePath(manifestDir, entry.prompt.path);
      const declaredSha256 = lowerSha(entry.prompt.sha256);
      row.prompt.declaredSha256 = declaredSha256;
      if (!declaredSha256) add("operator-image-prompt-sha256-required");
      if (!resolved) add("operator-image-prompt-path-invalid");
      else {
        row.prompt.full = resolved.full;
        row.prompt.rel = resolved.rel;
        const read = await readInside(manifestDir, resolved.full, MAX_PROMPT_BYTES);
        if (!read.ok) add(read.reason === "missing" ? "operator-image-prompt-missing" : (read.reason === "empty" ? "operator-image-prompt-empty" : "operator-image-prompt-unreadable"));
        else {
          row.prompt.sha256 = sha256(read.bytes);
          if (!read.bytes.toString("utf8").trim()) add("operator-image-prompt-empty");
          if (declaredSha256 && declaredSha256 !== row.prompt.sha256) add("operator-image-prompt-sha256-mismatch");
        }
      }
    }

    // 参照に使った画（承認済みの設定画の sha256）
    row.referenceSha256s = [];
    if (entry.referenceSha256s !== undefined) {
      if (!Array.isArray(entry.referenceSha256s)) add("operator-image-reference-invalid");
      else {
        for (const value of entry.referenceSha256s) {
          const sha = lowerSha(value);
          if (!sha) { add("operator-image-reference-invalid"); continue; }
          if (!row.referenceSha256s.includes(sha)) row.referenceSha256s.push(sha);
        }
      }
    }

    // 生成した時刻
    const generated = normalizedTimestamp(entry.generatedAt, now);
    row.generatedAt = generated.ok ? generated.value : "";
    if (!generated.ok) add("operator-image-generated-at-invalid");
    else if (generated.future) add("operator-image-generated-at-in-future");

    // 会話の URL（私有の記録にだけ残す。公開面には sha256 だけ）
    const url = conversationUrlOf(entry.conversationUrl);
    row.conversationUrl = url.ok ? url.value : "";
    row.conversationUrlSha256 = url.ok ? url.sha256 : "";
    if (url.present && !url.ok) add("operator-image-conversation-url-invalid");
    if (!url.present && OPERATOR_IMAGE_ROUTES_REQUIRING_CONVERSATION.includes(row.route)) add("operator-image-conversation-url-required");

    // 同じ画を別の場面にも使う理由
    row.reuseReason = entry.reuseReason === undefined ? "" : boundedText(entry.reuseReason);
    if (entry.reuseReason !== undefined && !row.reuseReason) add("operator-image-reuse-reason-invalid");

    // 途中の成果物の品質ループ
    row.assetLoop = null;
    if (entry.assetLoop !== undefined) {
      const loop = entry.assetLoop;
      if (!plainObject(loop) || Object.keys(loop).some((key) => !OPERATOR_IMAGE_MANIFEST_FIELDS.assetLoop.includes(key))) {
        add("operator-image-asset-loop-record-invalid");
      } else {
        const resolved = resolveManifestRelativePath(manifestDir, loop.statePath);
        const passedSha256 = lowerSha(loop.passedSha256);
        row.assetLoop = { rel: resolved?.rel || "", full: resolved?.full || "", passedSha256, stateSha256: "" };
        if (!resolved || !passedSha256) add("operator-image-asset-loop-record-invalid");
        else {
          const read = await readInside(manifestDir, resolved.full, MAX_STATE_BYTES);
          if (!read.ok) add("operator-image-asset-loop-state-missing");
          else row.assetLoop.stateSha256 = sha256(read.bytes);
        }
        // 合格した版と取り込む画が違う（別の版を取り込もうとしている）。
        if (passedSha256 && row.image.sha256 && passedSha256 !== row.image.sha256) add("operator-image-asset-loop-pass-mismatch");
      }
    }
    rows.push(row);
  }
  const digest = sha256(canonicalJson({
    version: OPERATOR_IMAGE_IMPORT_VERSION,
    manifestSha256,
    files: rows.map((row) => ({
      sceneId: row.sceneId,
      image: row.image.sha256,
      prompt: row.prompt.sha256,
      assetLoopState: row.assetLoop?.stateSha256 || "",
    })),
  }));
  return { ...result, ok: problems.length === 0, rows, problems: [...new Set(problems)], digest };
}

/**
 * 参照に使ってよい承認済みの画の sha256。Channel Pack の宣言（approvedReferences.sha256）と、宣言が
 * 許したときだけ人物の登録簿（project の canvas/characters.json の承認済みの人物の referenceAssets）。
 * 登録簿は手で書き換えられるファイルなので、承認（approval）の無い人物・sha256 の無い参照は数えない。
 */
// 人物の登録簿は lib/canvasScene.mjs 経由で外部パッケージ（fractional-indexing）を読むので、使う瞬間にだけ読む
// （配布物の実行系は依存を入れる前でも読み込めること、test/runtimeDependencies.test.mjs）。
async function readCharacterRegistry(...args) {
  const { readCharacterRegistry: read } = await import("./characterRegistry.mjs");
  return read(...args);
}

export async function resolveApprovedReferenceSha256s({ policy, projectDir = "", readRegistry = readCharacterRegistry } = {}) {
  const approved = new Map();
  const problems = [];
  for (const sha of policy?.approvedReferences?.sha256 || []) approved.set(sha, "channel-pack");
  if (policy?.approvedReferences?.characterRegistry === true) {
    if (!nonEmpty(projectDir)) problems.push("operator-image-character-registry-unavailable");
    else {
      try {
        const registry = await readRegistry({ projectDir });
        for (const character of registry?.characters || []) {
          if (character?.kind !== "character" || character?.status !== "approved" || !plainObject(character?.approval)) continue;
          for (const asset of character.referenceAssets || []) {
            const sha = lowerSha(asset?.sha256);
            if (sha && !approved.has(sha)) approved.set(sha, "character-registry");
          }
        }
      } catch {
        problems.push("operator-image-character-registry-unreadable");
      }
    }
  }
  return { approved, problems };
}

/**
 * 品質ループの状態ファイルの置き場（本体の規則: <作業フォルダ>/quality/assets/<工程>--<対象 id>.json）から、
 * 作業フォルダと対象 id を戻す。本体の assetQualityPaths で同じ置き場になることを確かめ、違えば止める
 * （置き場を推測で読まない）。module は lib/assetQualityLoop.mjs（ASSET_QUALITY_DIR と assetQualityPaths）。
 * 取り込みの検査（下）と、ジャンル層の関門（lib/narratedStoryAssetLoops.mjs）が同じこの1か所を使う。
 */
export function assetLoopStateLocation(statePath, stage, module) {
  const absolute = path.resolve(String(statePath || ""));
  const base = path.basename(absolute, ".json");
  const prefix = `${stage}--`;
  if (!nonEmpty(statePath) || !base.startsWith(prefix)) return { ok: false, detail: "asset-loop-state-not-this-stage" };
  const subjectId = base.slice(prefix.length);
  const depth = String(module?.ASSET_QUALITY_DIR || "").split(/[\\/]+/u).filter(Boolean).length;
  const workDir = path.resolve(path.dirname(absolute), ...Array.from({ length: depth }, () => ".."));
  let expected = "";
  try {
    expected = module.assetQualityPaths(workDir, stage, subjectId).statePath;
  } catch {
    expected = "";
  }
  if (depth === 0 || !expected || path.resolve(expected) !== absolute) return { ok: false, detail: "asset-loop-state-path-layout" };
  return { ok: true, workDir, subjectId, statePath: absolute };
}

/**
 * 品質ループ本体の assetQualityStatus で、manifest の行が指す状態ファイルの合格を確かめる。
 * 置き場は assetLoopStateLocation で本体の規則どおりか確かめてから問い合わせる。合格は「評価者の採点と
 * 要る人の確認が揃い、取り込む画のファイルが合格した版そのもの」のときだけ（assetPath に取り込む画を
 * 渡して、本体に照合させる）。
 */
function assetQualityStatusVerifier(module) {
  return async ({ statePath, stage, imagePath, imageSha256 }) => {
    const location = assetLoopStateLocation(statePath, stage, module);
    if (!location.ok) return { pass: false, detail: location.detail };
    const { workDir, subjectId } = location;
    const status = await module.assetQualityStatus({ workDir, stage, subjectId, assetPath: imagePath });
    const passedSha256 = lowerSha(status?.check?.assetSha256);
    return {
      pass: status?.pass === true && passedSha256 === imageSha256,
      passedSha256,
      detail: (status?.issues || []).join(", "),
    };
  };
}

/**
 * 途中の成果物の品質ループ（lib/assetQualityLoop.mjs）の検査口。本体が無い間は available: false で、
 * Pack が requireAssetLoopPass を宣言していれば取り込みは「ループ未導入」で止まる。
 * 本体が `verifyAssetLoopPassForImport({ statePath, stage, subjectId, imagePath, imageSha256, passedSha256 })` →
 * `{ pass, passedSha256, detail }` を export していればそれを使い、無ければ本体の assetQualityStatus で確かめる。
 */
export async function loadDefaultAssetLoopVerifier({ importModule = (specifier) => import(specifier) } = {}) {
  let module;
  try {
    module = await importModule("./assetQualityLoop.mjs");
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND" && /assetQualityLoop/u.test(String(error?.message || error?.url || ""))) {
      return { available: false, reason: "not-installed" };
    }
    return { available: false, reason: "load-failed" };
  }
  if (typeof module?.[OPERATOR_IMAGE_ASSET_LOOP_VERIFIER] === "function") {
    return { available: true, via: OPERATOR_IMAGE_ASSET_LOOP_VERIFIER, verify: (args) => module[OPERATOR_IMAGE_ASSET_LOOP_VERIFIER](args) };
  }
  if (typeof module?.assetQualityStatus === "function" && typeof module?.assetQualityPaths === "function" && module?.ASSET_QUALITY_DIR) {
    return { available: true, via: "assetQualityStatus", verify: assetQualityStatusVerifier(module) };
  }
  return { available: false, reason: "verifier-missing" };
}

function publicSceneRow(row, { fit, referenceApprovals, reuseOf }) {
  return {
    sceneId: row.sceneId,
    route: row.route,
    modelLabel: row.modelLabel,
    generatedAt: row.generatedAt,
    source: {
      sha256: row.image.sha256,
      bytes: row.image.bytes,
      format: row.image.format,
      width: row.image.width,
      height: row.image.height,
    },
    promptSha256: row.prompt.sha256,
    referenceSha256s: [...row.referenceSha256s],
    referenceApprovals,
    conversationUrlSha256: row.conversationUrlSha256 || null,
    routeNoteSha256: row.routeNote ? sha256(row.routeNote) : null,
    reuse: reuseOf ? { of: reuseOf, reasonSha256: sha256(row.reuseReason) } : null,
    assetLoop: row.assetLoop ? { stateSha256: row.assetLoop.stateSha256, passedSha256: row.assetLoop.passedSha256 } : null,
    fit: {
      method: fit.method,
      source: fit.source,
      target: fit.target,
      scale: fit.scale,
      scaled: fit.scaled,
      crop: fit.crop,
    },
    paidMediaJob: false,
    costBasis: OPERATOR_IMAGE_COST_BASIS,
  };
}

/**
 * 取り込みの検査。場面の過不足・同じ画の使い回し・承認されていない参照・寸法・品質ループの合格を見て、
 * 止める理由を理由コードで返す（ok が false なら有料の処理へ進まない）。
 *
 * - sceneIds: 画が要る場面の id（台本の順）
 * - target: 描く寸法 { width, height }
 * - policy: normalizeOperatorImageSourceConfig の config
 * - approvedReferences: resolveApprovedReferenceSha256s の approved（sha256 → 出どころ）
 */
export async function checkOperatorImageImport({
  manifest,
  sceneIds = [],
  target,
  policy,
  approvedReferences = new Map(),
  assetLoopVerifier = null,
} = {}) {
  const issues = [...(manifest?.problems || [])];
  const rows = new Map((manifest?.rows || []).map((row) => [row.sceneId, row]));
  const wanted = [...new Set(sceneIds)];
  for (const id of wanted) if (!rows.has(id)) issues.push(`operator-image-scene-missing:${id}`);
  for (const id of rows.keys()) if (!wanted.includes(id)) issues.push(`operator-image-scene-unknown:${id}`);
  const expected = policy?.expectedSize || target;
  const tolerance = Number.isInteger(policy?.tolerancePx) ? policy.tolerancePx : DEFAULT_OPERATOR_IMAGE_TOLERANCE_PX;
  const firstBySha = new Map();
  const scenes = [];
  let verifier = null;
  if (policy?.requireAssetLoopPass === true) {
    verifier = assetLoopVerifier || await loadDefaultAssetLoopVerifier();
    if (!verifier?.available) {
      issues.push(verifier?.reason === "verifier-missing" ? "operator-image-asset-loop-verifier-missing" : "operator-image-asset-loop-not-installed");
    }
  }
  for (const sceneId of wanted) {
    const row = rows.get(sceneId);
    if (!row) continue;
    const add = (code) => issues.push(`${code}:${sceneId}`);
    let fit = null;
    if (row.image.width && row.image.height && expected) {
      const deviation = { width: Math.abs(row.image.width - expected.width), height: Math.abs(row.image.height - expected.height) };
      if (deviation.width > tolerance || deviation.height > tolerance) {
        issues.push(`operator-image-size-out-of-tolerance:${sceneId}:${row.image.width}x${row.image.height}`);
      } else {
        fit = operatorImageFit(row.image, target);
        if (fit.scale > OPERATOR_IMAGE_MAX_UPSCALE) add("operator-image-upscale-too-large");
        if (fit.cropFraction.x > OPERATOR_IMAGE_MAX_CROP_FRACTION || fit.cropFraction.y > OPERATOR_IMAGE_MAX_CROP_FRACTION) add("operator-image-crop-too-large");
      }
    }
    let reuseOf = "";
    if (row.image.sha256) {
      const first = firstBySha.get(row.image.sha256);
      if (!first) firstBySha.set(row.image.sha256, sceneId);
      else {
        reuseOf = first;
        if (!row.reuseReason) issues.push(`operator-image-reused-without-reason:${sceneId}:${first}`);
      }
    }
    const referenceApprovals = [];
    for (const sha of row.referenceSha256s) {
      const source = approvedReferences.get(sha);
      if (!source) issues.push(`operator-image-reference-unapproved:${sceneId}:${sha.slice(0, 12)}`);
      else referenceApprovals.push({ sha256: sha, source });
    }
    if (policy?.requireAssetLoopPass === true) {
      if (!row.assetLoop) add("operator-image-asset-loop-record-required");
      else if (verifier?.available && row.assetLoop.stateSha256 && row.image.sha256) {
        let verdict = null;
        try {
          verdict = await verifier.verify({
            statePath: row.assetLoop.full,
            stage: OPERATOR_IMAGE_ASSET_LOOP_STAGE,
            subjectId: sceneId,
            imagePath: row.image.full,
            imageSha256: row.image.sha256,
            passedSha256: row.assetLoop.passedSha256,
          });
        } catch {
          verdict = null;
        }
        const passedSha256 = lowerSha(verdict?.passedSha256) || row.assetLoop.passedSha256;
        if (verdict?.pass !== true || passedSha256 !== row.image.sha256) add("operator-image-asset-loop-not-passed");
      }
    }
    scenes.push({ sceneId, row, fit, referenceApprovals, reuseOf });
  }
  const unique = [...new Set(issues)];
  const ok = unique.length === 0;
  return {
    ok,
    issues: unique,
    scenes,
    manifestSha256: manifest?.manifestSha256 || "",
    digest: manifest?.digest || "",
    publicScenes: ok ? scenes.map((scene) => publicSceneRow(scene.row, scene)) : [],
  };
}

function routeCounts(rows) {
  const counts = {};
  for (const row of rows) counts[row.route] = (counts[row.route] || 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

/** 公開面へ出す取り込みの記録（sha256・経路・合わせ方だけ。会話の URL・注記・理由の本文は持たない）。 */
export function operatorImagePublicRecord(checked, normalized = new Map()) {
  const scenes = checked.publicScenes.map((row) => ({
    ...row,
    ...(normalized.get(row.sceneId) ? { normalized: { sha256: normalized.get(row.sceneId).sha256, bytes: normalized.get(row.sceneId).bytes } } : {}),
  }));
  return {
    version: OPERATOR_IMAGE_IMPORT_VERSION,
    source: "operator-file",
    manifestSha256: checked.manifestSha256,
    digest: checked.digest,
    sceneCount: scenes.length,
    routes: routeCounts(scenes),
    paidMediaJobs: 0,
    costBasis: OPERATOR_IMAGE_COST_BASIS,
    scenes,
  };
}

/** 取り込みの鍵。元の画の sha256・寸法の合わせ方・描く寸法が同じなら同じ鍵（画が差し替われば別の入力）。 */
export function operatorImageImportKey({ sceneId, sourceSha256, fit }) {
  return `operator-image:${sha256(canonicalJson({
    version: OPERATOR_IMAGE_IMPORT_VERSION,
    sceneId,
    sourceSha256,
    fit: { method: fit.method, source: fit.source, target: fit.target, scaled: fit.scaled, crop: fit.crop },
  }))}`;
}

async function writeBytesAtomic(target, bytes, mode = 0o600) {
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, bytes, { mode });
  await renameWithRetry(temp, target);
}

async function fileRecord(target) {
  const info = await stat(target);
  if (!info.isFile() || info.size === 0) throw new Error("normalized operator image is missing or empty");
  const bytes = await readFile(target);
  return { path: path.resolve(target), sha256: sha256(bytes), bytes: bytes.length, info: operatorImageInfo(bytes) };
}

async function runFfmpeg(ffmpeg, args) {
  if (!ffmpeg?.command) throw new Error("A resolved ffmpeg executable is required to normalize operator images.");
  return execFile(ffmpeg.command, [...(ffmpeg.args || []), ...args], { timeout: 5 * 60_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
}

/**
 * 検査を通った取り込みを、場面の画（決まった寸法の PNG）にする。元の画・プロンプト・manifest の写しと
 * 会話の URL などの本文は privateDir（私有の Job フォルダ）にだけ置く。
 *
 * 画は読み直して sha256 を確かめてから使う（検査のあとで差し替わった画を黙って使わない）。同じ鍵の
 * 取り込みが済んでいれば作り直さない。戻り値の issues が空でなければ、呼び出し側は有料の処理へ進まない。
 */
export async function materializeOperatorImages({
  ffmpeg,
  manifest,
  checked,
  target,
  outputDir,
  privateDir,
  now = () => new Date().toISOString(),
} = {}) {
  if (!checked?.ok) throw new Error("materializeOperatorImages requires a passing checkOperatorImageImport result.");
  const issues = [];
  const images = new Map();
  await mkdir(outputDir, { recursive: true });
  await mkdir(path.join(privateDir, "source"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(privateDir, "prompts"), { recursive: true, mode: 0o700 });
  // manifest の写し（検査した本文そのもの）。
  if (manifest?.bytes && sha256(manifest.bytes) === checked.manifestSha256) {
    await writeBytesAtomic(path.join(privateDir, "manifest.json"), manifest.bytes);
  } else issues.push("operator-image-manifest-changed-during-import");
  const privateScenes = [];
  for (const scene of checked.scenes) {
    const { row, fit, sceneId } = scene;
    const add = (code) => issues.push(`${code}:${sceneId}`);
    let bytes;
    let promptBytes;
    try {
      bytes = await readFile(row.image.full);
      promptBytes = await readFile(row.prompt.full);
    } catch {
      add("operator-image-changed-during-import");
      continue;
    }
    if (sha256(bytes) !== row.image.sha256) { add("operator-image-changed-during-import"); continue; }
    if (sha256(promptBytes) !== row.prompt.sha256) { add("operator-image-prompt-changed-during-import"); continue; }
    const sourceCopy = path.join(privateDir, "source", `${sceneId}.${row.image.format === "jpeg" ? "jpg" : row.image.format}`);
    const promptCopy = path.join(privateDir, "prompts", `${sceneId}.txt`);
    await writeBytesAtomic(sourceCopy, bytes);
    await writeBytesAtomic(promptCopy, promptBytes);
    const outputPath = path.join(outputDir, `${sceneId}.png`);
    const sidecarPath = `${outputPath}.operator-import.json`;
    const importKey = operatorImageImportKey({ sceneId, sourceSha256: row.image.sha256, fit });
    const previous = await readJsonIfExists(sidecarPath, null).catch(() => null);
    let record = null;
    if (previous?.version === OPERATOR_IMAGE_SIDECAR_VERSION && previous.importKey === importKey) {
      try {
        const current = await fileRecord(outputPath);
        if (current.sha256 === previous.artifact?.sha256) record = { ...current, cached: true };
      } catch {
        record = null;
      }
    }
    if (!record) {
      try {
        if (fit.method === "none" && row.image.format === "png") {
          await writeBytesAtomic(outputPath, bytes, 0o644);
        } else {
          const temp = `${outputPath}.${process.pid}.${randomUUID()}.tmp.png`;
          const filters = fit.method === "none"
            ? "setsar=1,format=rgb24"
            : `scale=${fit.scaled.width}:${fit.scaled.height}:flags=lanczos,crop=${fit.crop.width}:${fit.crop.height}:${fit.crop.x}:${fit.crop.y},setsar=1,format=rgb24`;
          try {
            await runFfmpeg(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", sourceCopy, "-vf", filters, "-frames:v", "1", temp]);
            await renameWithRetry(temp, outputPath);
          } finally {
            await rm(temp, { force: true });
          }
        }
        const written = await fileRecord(outputPath);
        if (written.info?.width !== target.width || written.info?.height !== target.height) {
          add("operator-image-normalized-size-mismatch");
          continue;
        }
        record = { ...written, cached: false };
        await writeBytesAtomic(sidecarPath, `${JSON.stringify({
          version: OPERATOR_IMAGE_SIDECAR_VERSION,
          importKey,
          sceneId,
          sourceSha256: row.image.sha256,
          fit: { method: fit.method, source: fit.source, target: fit.target, scale: fit.scale, scaled: fit.scaled, crop: fit.crop },
          artifact: { sha256: written.sha256, bytes: written.bytes },
        }, null, 2)}\n`);
      } catch {
        add("operator-image-normalize-failed");
        continue;
      }
    }
    images.set(sceneId, { path: record.path, sha256: record.sha256, bytes: record.bytes, cached: record.cached, importKey, fit });
    privateScenes.push({
      sceneId,
      conversationUrl: row.conversationUrl || null,
      routeNote: row.routeNote || null,
      reuseReason: row.reuseReason || null,
      sourceCopy: path.relative(privateDir, sourceCopy).split(path.sep).join("/"),
      promptCopy: path.relative(privateDir, promptCopy).split(path.sep).join("/"),
      source: { sha256: row.image.sha256, relativePath: row.image.rel },
      prompt: { sha256: row.prompt.sha256, relativePath: row.prompt.rel },
      normalizedSha256: record.sha256,
      importKey,
    });
  }
  if (issues.length > 0) return { ok: false, issues: [...new Set(issues)], images, publicRecord: null, privateRecordPath: "" };
  const publicRecord = operatorImagePublicRecord(checked, images);
  const privateRecordPath = path.join(privateDir, "import-record.json");
  await writeBytesAtomic(privateRecordPath, `${JSON.stringify({
    version: OPERATOR_IMAGE_PRIVATE_RECORD_VERSION,
    note: "私有の Job フォルダの記録。会話の URL・注記・理由の本文はここにだけ残す（公開面は sha256 だけ）。",
    importedAt: now(),
    manifestSha256: checked.manifestSha256,
    digest: checked.digest,
    publicRecordSha256: sha256(canonicalJson(publicRecord)),
    scenes: privateScenes,
  }, null, 2)}\n`);
  return { ok: true, issues: [], images, publicRecord, privateRecordPath };
}
