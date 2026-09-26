/**
 * 途中の成果物の品質ループの、ページ単位の人の確認（verify-pages）。
 *
 * 人物の同一性（identity）と、公開面に出る画の手指の安全（hand-safety）は、対象ごとに運営者本人が対話端末で
 * 確かめないと合格にならない（lib/assetQualityLoop.mjs の ASSET_HUMAN_CHECKS）。長い動画では本編の画が数百枚に
 * なり、1枚ずつ verify を打つのは回らない。ここは、人の確認が要る対象を数枚ずつの「ページ画像」に並べて1枚ずつ
 * 開き、運営者がページごとに「全部 pass」か「落とす画の番号と理由」を答える形にする。記録は対象ごとの verify と
 * 同じ形で、ページの id・ページ画像の sha256・見せた時刻・答えた時刻を足す（recordAssetPageVerification）。
 *
 * この確認は、機械のゲートを素通りした事故の最後の砦（猥褻な手の身ぶりが機械のゲートを全部通った、背景の丸い
 * ネオンが実在のキャラクターの意匠そっくりで2回のレビューを素通りした——どちらも運営側の記録）。運営の決まりは
 * 「公開面の画像は全数を目で見る」。なので、ここで減らすのは打つ手間だけで、見る量は減らさない:
 *   - 人の確認が要る対象の範囲は今のまま（要る欄はループの requiredHumanChecks が決め、ここは読むだけ）。機械の
 *     判定で対象を外さない。手と顔が小さいかも機械は決めない——人物の範囲の記録が無い画は、全部を4分割で拡大する
 *   - 対話端末（TTY）と --human-verified が要るのは verify と同じ。機械が代わりに答えを記録する道は無い
 *   - 1ページの枚数は少なく（既定 4、上限 6）、各画は短い辺 720px 以上で、拡大も同じ大きさで並べる
 *   - 見せてから答えるまでが短すぎる答えは受け付けず、ページを開き直して見直しを求める
 *   - 1ページに複数の対象を並べても記録は対象ごとで、1つの否は他の可を消さない
 *   - ページに並べた後で画が変わった対象（sha256 が違う）は記録しない。ページ画像が変わっていたらそのページは記録しない
 *   - 途中でやめても、答えたページまでは記録に残り、同じコマンドで残りから続く（記録の済んだ対象はページに載らない）
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import { readJsonIfExists, writeJsonAtomic } from "./atomicJsonFile.mjs";
import {
  ASSET_HUMAN_VERIFIED,
  ASSET_QUALITY_DIR,
  ASSET_STAGES,
  assetQualityPaths,
  assetQualityStage,
  assetQualityStatus,
  listAssetQualityStatus,
  loadApprovedReferences,
  recordAssetPageVerification,
} from "./assetQualityLoop.mjs";
import { withCanvasFileLock } from "./canvasFileLock.mjs";
import { resolveFfmpegToolchain } from "./harnessRuntimeResolver.mjs";
import {
  REVIEW_PAGE_TILE_SHORT_SIDE,
  encodeReviewPagePng,
  ffmpegReviewTileRenderer,
  layoutReviewPage,
  paintReviewPage,
  readReviewImageDimensions,
  reviewTileSize,
} from "./humanReviewPageImage.mjs";
import { openLocalFile } from "./openLocalFolder.mjs";
import { sanitizeEvidence } from "./qualityLoop.mjs";

/** ページの記録（作業フォルダの quality/assets/verify-pages/<工程>--<ページ id>.json。ページ画像は同じ名前の .png）。 */
export const ASSET_VERIFY_PAGE_RECORD_VERSION = "buzzassist-asset-quality-verify-page-v1";
/** 対象を絞る・並べる順と人物の範囲を渡す任意の一覧（--targets）。 */
export const ASSET_VERIFY_TARGETS_VERSION = "buzzassist-asset-quality-verify-targets-v1";
export const ASSET_VERIFY_PAGE_DIR = path.join(ASSET_QUALITY_DIR, "verify-pages");

/**
 * 1ページに並べる対象の数（方針値。実測して決めた閾値ではない）。
 *   - 既定 4: 16:9 の画を短い辺 720px（1280x720）で 2x2 に並べると 2576px 幅・1440px 高で、Retina の 13〜14 インチの
 *     画面（物理 2560〜3024px 幅）に縮めずに収まる。ページの全体の画が一度に見え、そのあと各画の拡大を順に見る
 *   - 上限 6: これより多いと全体の画だけで画面3つ分を超え、後ろの画ほど流し見になる。1回の「pass」の打ち間違いで
 *     可になる画も 6 枚までに抑える
 *   - 少なくしすぎない: 400 枚を 1〜2 枚ずつにすると 200〜400 ページになり、開く・答える手間が見る時間を上回る
 *     （4 枚なら 100 ページ）
 */
export const ASSET_VERIFY_PAGE_DEFAULT_ITEMS = 4;
export const ASSET_VERIFY_PAGE_MAX_ITEMS = 6;
/**
 * 人物の範囲の記録が無い画の拡大: 縦横それぞれ画の 55% を切り出す4つ（左上・右上・左下・右下）。隣どうしが
 * 1割重なるので、境目にある手や顔が2つのタイルに割れて見えなくなることが無い。各タイルは全体と同じ短い辺 720px で
 * 並べるので、全体の約 1.8 倍に見える。
 */
export const ASSET_VERIFY_ZOOM_CROP = 0.55;
/** 人物の範囲（--targets の regions）を拡大するときに、範囲の外へ足す余白（範囲の大きさの 1 割ずつ）。 */
export const ASSET_VERIFY_REGION_MARGIN = 0.1;
export const ASSET_VERIFY_MAX_REGIONS = 8;
/**
 * 見せてから答えるまでの最短（秒。方針値）。= max(floor, perImage × 画の数 + perZoomTile × 拡大のタイルの数)。
 *   - perImage 2 秒: 全体の画で顔と手を探して、同一性なら設定画と見比べる。1回の注視は 0.2〜0.3 秒で、顔・両手・
 *     背景の意匠へ目を動かすだけで数回の注視が要る
 *   - perZoomTile 1 秒: 拡大のタイルへ目を送って、指の本数や形・丸い意匠の形を確かめる下限
 *   - floor 5 秒: ページを開く（アプリが前に出る）だけで 1〜2 秒かかる。開いてすぐの Enter は必ず落とす
 * 目安の時間ではなく「目を通していない答え」を落とすための下限で、ちゃんと見る人はこれより長くかかる
 * （4 枚・4 分割の拡大なら 24 秒）。下げる設定は作らない。
 */
export const ASSET_VERIFY_PAGE_MIN_SECONDS = Object.freeze({ perImage: 2, perZoomTile: 1, floor: 5 });
/** 落とす理由の最短（文字数）。日本語の短い文（「指が6本」「別人」）を通し、空や1文字を落とす。 */
export const ASSET_VERIFY_REASON_MIN_CHARS = 2;

/**
 * ページで確かめられる工程: 画（media: image）で、人の確認の欄があるもの（人物の設定画・本編の画・サムネ）。
 * 動画クリップは入れない（ページの静止画では、動いている途中の手や顔の崩れを見落とす。通しで再生して1件ずつ verify）。
 */
export const ASSET_VERIFY_PAGE_STAGES = Object.freeze(ASSET_STAGES.filter((id) => {
  const spec = assetQualityStage(id);
  return spec.media === "image" && spec.humanChecks.length > 0;
}));

const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const CHECK_TAGS = Object.freeze({ identity: "ID", "hand-safety": "HAND" });
const CHECK_LABELS = Object.freeze({ identity: "同一性", "hand-safety": "手指" });
const TILE_RENDER_CONCURRENCY = 4;

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fileSha256(file) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    createReadStream(file).on("data", (chunk) => hash.update(chunk)).on("error", reject).on("end", () => resolvePromise(hash.digest("hex")));
  });
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (plainObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function lastOf(list) {
  return Array.isArray(list) && list.length > 0 ? list[list.length - 1] : null;
}

function iso(value) {
  return new Date(value).toISOString();
}

export function verifyPageStage(stage) {
  const spec = assetQualityStage(stage);
  if (!ASSET_VERIFY_PAGE_STAGES.includes(spec.id)) {
    throw new Error(spec.id === "video-clip"
      ? "動画クリップはページで確かめない（静止画では動いている途中の手や顔の崩れを見落とす）。通しで再生して1件ずつ verify する。"
      : `工程 ${spec.id}（${spec.label}）には人の確認の欄が無い（ページで確かめられる工程: ${ASSET_VERIFY_PAGE_STAGES.join(" / ")}）。`);
  }
  return spec;
}

export function verifyPageItemsOrThrow(value = ASSET_VERIFY_PAGE_DEFAULT_ITEMS) {
  const count = value === undefined || value === null || value === "" ? ASSET_VERIFY_PAGE_DEFAULT_ITEMS : Number(value);
  if (!Number.isInteger(count) || count < 1 || count > ASSET_VERIFY_PAGE_MAX_ITEMS) {
    throw new Error(`--per-page は 1〜${ASSET_VERIFY_PAGE_MAX_ITEMS}（既定 ${ASSET_VERIFY_PAGE_DEFAULT_ITEMS}。上限の理由は lib/assetQualityVerifyPages.mjs の ASSET_VERIFY_PAGE_MAX_ITEMS）。`);
  }
  return count;
}

/** 見せてから答えるまでの最短（秒）。 */
export function assetVerifyPageMinimumSeconds({ images = 0, zoomTiles = 0 } = {}) {
  const { perImage, perZoomTile, floor } = ASSET_VERIFY_PAGE_MIN_SECONDS;
  return Math.max(floor, perImage * images + perZoomTile * zoomTiles);
}

/** 対象 id を人の読む順（数字は数として）に並べる。 */
function naturalCompare(left, right) {
  return left.localeCompare(right, "en", { numeric: true, sensitivity: "base" }) || (left < right ? -1 : left > right ? 1 : 0);
}

function regionsOrThrow(value, where) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > ASSET_VERIFY_MAX_REGIONS) {
    throw new Error(`${where}.regions は ${ASSET_VERIFY_MAX_REGIONS} 件までの配列（画の中の人物の範囲。0〜1 の割合の x・y・width・height）。`);
  }
  return value.map((region, index) => {
    const at = `${where}.regions[${index}]`;
    const [x, y, width, height] = ["x", "y", "width", "height"].map((key) => Number(region?.[key]));
    const ok = plainObject(region) && [x, y, width, height].every(Number.isFinite)
      && x >= 0 && y >= 0 && width > 0 && height > 0 && x + width <= 1 + 1e-6 && y + height <= 1 + 1e-6;
    if (!ok) throw new Error(`${at} は画の中の範囲を 0〜1 の割合（x・y・width・height）で書く。`);
    return { x, y, width, height };
  });
}

/**
 * 任意の対象の一覧（--targets）を検める。
 * {
 *   "version": "buzzassist-asset-quality-verify-targets-v1",
 *   "stage": "<工程>",                                  // 省略可。書くなら --stage と同じ
 *   "referenceFiles": ["<承認済みの設定画のファイルかフォルダ。作業フォルダからの相対か絶対>"],
 *   "items": [{ "subjectId": "<対象 id>", "regions": [{ "x", "y", "width", "height" }] }]   // 省略すると全部の対象
 * }
 * regions は画の中の人物の範囲（0〜1 の割合）。あれば拡大はその範囲、無ければ画全体の4分割。
 */
export function normalizeVerifyTargets(body, { stage }) {
  if (!plainObject(body)) throw new Error("--targets の一覧は JSON の object にしてください。");
  if (body.version !== ASSET_VERIFY_TARGETS_VERSION) throw new Error(`--targets の version は ${ASSET_VERIFY_TARGETS_VERSION} にしてください。`);
  if (body.stage !== undefined && body.stage !== stage) throw new Error(`--targets の工程（${body.stage}）が --stage（${stage}）と違います。`);
  if (body.referenceFiles !== undefined && (!Array.isArray(body.referenceFiles) || body.referenceFiles.some((value) => !nonEmpty(value)))) {
    throw new Error("--targets の referenceFiles はファイルかフォルダのパスの配列にしてください。");
  }
  let items = null;
  if (body.items !== undefined) {
    if (!Array.isArray(body.items) || body.items.length === 0) throw new Error("--targets の items は1件以上の配列にしてください（全部の対象なら items を書かない）。");
    const seen = new Set();
    items = body.items.map((item, index) => {
      const subjectId = nonEmpty(item?.subjectId);
      if (!plainObject(item) || !LABEL.test(subjectId)) throw new Error(`--targets の items[${index}].subjectId に対象 id が要ります。`);
      if (seen.has(subjectId)) throw new Error(`--targets の対象 ${subjectId} が重複しています。`);
      seen.add(subjectId);
      return { subjectId, regions: regionsOrThrow(item.regions, `items[${index}]`) };
    });
  }
  return { items, referenceFiles: (body.referenceFiles || []).map((value) => nonEmpty(value)) };
}

/** 参照の画（承認済みの設定画）を sha256 → ファイルの対応にする。フォルダを渡すと、その中の画（png / jpg / webp）を全部。 */
async function referencePool(root, values) {
  const pool = new Map();
  for (const value of values) {
    const full = path.resolve(root, value);
    const info = await stat(full).catch(() => null);
    if (!info) throw new Error(`参照の画が見つからない: ${value}`);
    const files = info.isDirectory()
      ? (await readdir(full)).filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase())).sort().map((name) => path.join(full, name))
      : [full];
    for (const file of files) {
      const sha = await fileSha256(file);
      if (!pool.has(sha)) pool.set(sha, file);
    }
  }
  return pool;
}

/** 拡大の切り抜き（元の画の px）。人物の範囲があればその範囲（余白つき）、無ければ画全体の4分割（1割重ねる）。 */
export function verifyZoomCrops({ width, height }, regions = []) {
  if (regions.length > 0) {
    return {
      kind: "regions",
      crops: regions.map((region, index) => {
        const clamp = (value) => Math.min(1, Math.max(0, value));
        const x0 = clamp(region.x - region.width * ASSET_VERIFY_REGION_MARGIN);
        const y0 = clamp(region.y - region.height * ASSET_VERIFY_REGION_MARGIN);
        const x1 = clamp(region.x + region.width * (1 + ASSET_VERIFY_REGION_MARGIN));
        const y1 = clamp(region.y + region.height * (1 + ASSET_VERIFY_REGION_MARGIN));
        // 割合の掛け算の誤差（0.46 × 1000 = 459.99…）で 1px ずれないように、px へ直すときに丸めの幅を持たせる。
        const x = Math.floor(x0 * width + 1e-6);
        const y = Math.floor(y0 * height + 1e-6);
        return {
          label: `P${index + 1}`,
          x,
          y,
          width: Math.max(1, Math.min(width - x, Math.ceil(x1 * width - 1e-6) - x)),
          height: Math.max(1, Math.min(height - y, Math.ceil(y1 * height - 1e-6) - y)),
        };
      }),
    };
  }
  const cropWidth = Math.max(1, Math.round(width * ASSET_VERIFY_ZOOM_CROP));
  const cropHeight = Math.max(1, Math.round(height * ASSET_VERIFY_ZOOM_CROP));
  return {
    kind: "quadrants",
    crops: [
      { label: "TL", x: 0, y: 0 },
      { label: "TR", x: width - cropWidth, y: 0 },
      { label: "BL", x: 0, y: height - cropHeight },
      { label: "BR", x: width - cropWidth, y: height - cropHeight },
    ].map((crop) => ({ ...crop, width: cropWidth, height: cropHeight })),
  };
}

/** ページに載せない理由（blocking: 人が直さないと進まない / そうでなければ今は人の確認を待っていないだけ）。 */
function exclusionFor(status) {
  if (!status.started) return { reason: "loop-not-started", blocking: true };
  const state = status.check.status;
  if (state === "awaiting-human-verification") {
    if (status.issues.includes("asset-quality-asset-missing")) return { reason: "asset-missing", blocking: true };
    if (!status.check.assetUnchangedSinceReview) return { reason: "asset-changed-after-review", blocking: true };
    return null;
  }
  if (state === "passed") return { reason: "already-verified", blocking: false };
  if (state === "human-rejected") return { reason: "human-rejected", blocking: false };
  if (state === "active") return { reason: "evaluator-review-pending", blocking: false };
  return { reason: `loop-stopped:${state}`, blocking: false };
}

const EXCLUSION_TEXT = Object.freeze({
  "loop-not-started": "品質ループが始まっていない",
  "asset-missing": "採点した版のファイルが無い",
  "asset-changed-after-review": "採点した後で画のファイルが変わった（sha256 が違う。作り直したなら新しい版を採点してから）",
  "already-verified": "人の確認が済んでいる",
  "human-rejected": "人の確認で否とされている",
  "evaluator-review-pending": "評価者の採点がまだ合格していない（人の確認は合格した版で行う）",
  "approved-references-required": "同一性の確認に、承認済みの参照の一覧（--approved-references）が要る",
  "identity-reference-missing": "同一性の確認が要るのに、版に参照の SHA が無い",
});

function exclusionText(reason) {
  if (EXCLUSION_TEXT[reason]) return EXCLUSION_TEXT[reason];
  if (reason.startsWith("reference-not-approved:")) return `参照 ${reason.split(":")[1]} が承認済みの参照の一覧に無い（ページに並べない）`;
  if (reason.startsWith("reference-file-missing:")) return `参照 ${reason.split(":")[1]} のファイルが --reference / referenceFiles に無い`;
  if (reason.startsWith("loop-stopped:")) return `品質ループが止まっている（${reason.split(":")[1]}）`;
  return reason;
}

/** ページの id（工程・対象・版の sha256・見る欄・参照・拡大の切り抜きから決まる。同じ中身なら同じ id）。 */
function pageIdFor(stage, items) {
  return sha256(canonicalJson({
    version: ASSET_VERIFY_PAGE_RECORD_VERSION,
    stage,
    tileShortSide: REVIEW_PAGE_TILE_SHORT_SIDE,
    items: items.map((item) => ({
      slot: item.slot,
      subjectId: item.subjectId,
      assetSha256: item.assetSha256,
      checks: item.checks,
      referenceSha256s: item.references.map((row) => row.sha256),
      zoom: item.zoom,
    })),
  })).slice(0, 16);
}

/**
 * 人の確認を待っている対象をページに分ける（画は作らない・何も書かない）。
 * 載せるのは、評価者の採点が合格して人の確認を待っている対象（awaiting-human-verification）で、採点した版の
 * ファイルが今も同じもの。見る欄は、その版に要る人の確認のうちまだ済んでいない欄（ループが決める）。
 */
export async function planAssetVerifyPages({
  workDir,
  stage,
  perPage = ASSET_VERIFY_PAGE_DEFAULT_ITEMS,
  targetsPath = "",
  targets = null,
  references = [],
  approvedReferencesPath = "",
  readDimensions = (file) => readReviewImageDimensions(file),
} = {}) {
  const spec = verifyPageStage(stage);
  const size = verifyPageItemsOrThrow(perPage);
  const root = assetQualityPaths(workDir).workDir;
  let manifest = { items: null, referenceFiles: [] };
  if (targets || nonEmpty(targetsPath)) {
    let body = targets;
    if (!body) {
      try {
        body = JSON.parse(await readFile(path.resolve(targetsPath), "utf8"));
      } catch (error) {
        throw new Error(error?.code === "ENOENT" ? `--targets の一覧が見つからない: ${targetsPath}` : "--targets の一覧が JSON として読めない。");
      }
    }
    manifest = normalizeVerifyTargets(body, { stage: spec.id });
  }
  const referenceValues = [...(Array.isArray(references) ? references : [references]).map((value) => nonEmpty(value)).filter(Boolean), ...manifest.referenceFiles];
  const pool = await referencePool(root, referenceValues);
  const approved = nonEmpty(approvedReferencesPath) ? await loadApprovedReferences(approvedReferencesPath) : null;
  const regionsBySubject = new Map((manifest.items || []).map((item) => [item.subjectId, item.regions]));
  const subjects = manifest.items
    ? manifest.items.map((item) => item.subjectId)
    : (await listAssetQualityStatus({ workDir: root, stage: spec.id })).entries.map((entry) => entry.subjectId).sort(naturalCompare);
  const candidates = [];
  const excluded = [];
  for (const subjectId of subjects) {
    const status = await assetQualityStatus({ workDir: root, stage: spec.id, subjectId });
    const exclusion = exclusionFor(status);
    if (exclusion) {
      excluded.push({ subjectId, ...exclusion });
      continue;
    }
    const version = lastOf(status.state.asset.versions);
    const checks = [...status.check.humanVerification.missing];
    const referenceRows = [];
    let blocked = "";
    if (checks.includes("identity")) {
      const shas = version.referenceSha256s || [];
      if (shas.length === 0) blocked = "identity-reference-missing";
      else if (!approved?.valid) blocked = "approved-references-required";
      for (const sha of blocked ? [] : shas) {
        if (!approved.set.has(sha)) { blocked = `reference-not-approved:${sha.slice(0, 12)}`; break; }
        if (!pool.has(sha)) { blocked = `reference-file-missing:${sha.slice(0, 12)}`; break; }
        referenceRows.push({ sha256: sha, file: pool.get(sha) });
      }
    }
    if (blocked) {
      excluded.push({ subjectId, reason: blocked, blocking: true });
      continue;
    }
    const assetFull = path.resolve(root, version.assetPath);
    const dimensions = await readDimensions(assetFull);
    candidates.push({
      subjectId,
      assetPath: version.assetPath,
      assetFull,
      assetSha256: version.assetSha256,
      versionLabel: version.label,
      checks,
      references: referenceRows,
      dimensions: { width: dimensions.width, height: dimensions.height },
      zoom: verifyZoomCrops(dimensions, regionsBySubject.get(subjectId) || []),
    });
  }
  const pages = [];
  for (let start = 0; start < candidates.length; start += size) {
    const items = candidates.slice(start, start + size).map((item, index) => ({ ...item, slot: index + 1 }));
    const zoomTiles = items.reduce((sum, item) => sum + item.zoom.crops.length, 0);
    pages.push({
      index: pages.length + 1,
      pageId: pageIdFor(spec.id, items),
      items,
      minimumSeconds: assetVerifyPageMinimumSeconds({ images: items.length, zoomTiles }),
    });
  }
  return { stage: spec.id, workDir: root, perPage: size, pages, excluded, blocked: excluded.filter((row) => row.blocking) };
}

export function assetVerifyPagePaths(workDir, stage, pageId) {
  const root = assetQualityPaths(workDir).workDir;
  const base = path.join(root, ASSET_VERIFY_PAGE_DIR, `${stage}--${pageId}`);
  return {
    pngPath: `${base}.png`,
    recordPath: `${base}.json`,
    pngRel: path.relative(root, `${base}.png`).split(path.sep).join("/"),
  };
}

/**
 * ページ画像を作る。1つの対象が1つの段で、1行目に全体（と同一性なら承認済みの設定画）、2行目から拡大を並べる。
 * どのタイルも短い辺 720px（reviewTileSize）。書いたページ画像の sha256 と、タイルの配置（見せた大きさ）を返す。
 */
export async function buildAssetVerifyPage({ plan, page, renderTile, readDimensions = (file) => readReviewImageDimensions(file), referenceCache = new Map() }) {
  // ページに描く画が、ページに分けたとき（採点した版・承認一覧で照合した参照）と同じバイト列か。違えば描かない
  // （見せた画と記録の sha256 がずれる）。止まった後は同じコマンドで作り直す（変わった画は載らない理由として出る）。
  for (const item of page.items) {
    const sources = [[item.assetFull, item.assetSha256, item.subjectId], ...item.references.map((row) => [row.file, row.sha256, `${item.subjectId} の設定画`])];
    for (const [file, expected, label] of sources) {
      if (await fileSha256(file).catch(() => "") !== expected) {
        throw new Error(`ページ ${page.index} を作る前に ${label} のファイルが変わった（sha256 が違う）。答えたページまでは記録してある。同じコマンドでやり直す。`);
      }
    }
  }
  const sections = [];
  const renders = new Map();
  for (const item of page.items) {
    const slot = item.slot;
    const first = [{ id: `${slot}-full`, kind: "full", label: `${slot} FULL`, ...reviewTileSize(item.dimensions), sourceSha256: item.assetSha256 }];
    renders.set(`${slot}-full`, { source: item.assetFull, crop: null });
    for (const [index, reference] of item.references.entries()) {
      const id = `${slot}-ref-${index + 1}`;
      reference.dimensions ||= await readDimensions(reference.file);
      first.push({ id, kind: "reference", label: `${slot} REF ${index + 1}`, ...reviewTileSize(reference.dimensions), sourceSha256: reference.sha256 });
      renders.set(id, { source: reference.file, crop: null, cacheKey: reference.sha256 });
    }
    const zoom = item.zoom.crops.map((crop) => {
      const id = `${slot}-zoom-${crop.label}`;
      renders.set(id, { source: item.assetFull, crop });
      return { id, kind: "zoom", label: `${slot} ZOOM ${crop.label}`, ...reviewTileSize(crop), sourceSha256: item.assetSha256, crop };
    });
    sections.push({ header: `[${slot}] ${item.subjectId}  ${item.checks.map((id) => CHECK_TAGS[id] || id).join(" + ")}`, rows: [first, zoom] });
  }
  const layout = layoutReviewPage({ title: `PAGE ${page.index}/${plan.pages.length}  ${plan.stage}  ID ${page.pageId}`, sections });
  // タイルは ffmpeg の小さな呼び出しの積み重ねなので、4 つずつ並べて作る（手元の実測で 1 タイル約 150ms、8 並列で
  // 1 タイルあたり約 70ms）。同じ設定画は同じ大きさなら1回だけ作る（ページをまたいで使い回す）。
  const pixels = new Map();
  const queue = [...layout.placements];
  const worker = async () => {
    for (let placement = queue.shift(); placement; placement = queue.shift()) {
      const render = renders.get(placement.id);
      const key = render.cacheKey ? `${render.cacheKey}:${placement.width}x${placement.height}` : "";
      let pending = key ? referenceCache.get(key) : null;
      if (!pending) {
        pending = renderTile({ source: render.source, crop: render.crop, width: placement.width, height: placement.height });
        if (key) {
          referenceCache.set(key, pending);
          pending.catch(() => referenceCache.delete(key));
        }
      }
      pixels.set(placement.id, await pending);
    }
  };
  await Promise.all(Array.from({ length: Math.min(TILE_RENDER_CONCURRENCY, queue.length) }, worker));
  const png = await encodeReviewPagePng({ width: layout.width, height: layout.height, rgb: paintReviewPage(layout, pixels) });
  const paths = assetVerifyPagePaths(plan.workDir, plan.stage, page.pageId);
  await mkdir(path.dirname(paths.pngPath), { recursive: true });
  const temp = `${paths.pngPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temp, png);
    await rename(temp, paths.pngPath);
  } finally {
    await rm(temp, { force: true });
  }
  const tiles = layout.placements.map((placement) => {
    const tile = sections.flatMap((section) => section.rows.flat()).find((row) => row.id === placement.id);
    return {
      slot: Number(placement.id.split("-")[0]),
      kind: placement.kind,
      label: placement.label,
      x: placement.x,
      y: placement.y,
      width: placement.width,
      height: placement.height,
      sourceSha256: tile.sourceSha256,
      ...(tile.crop ? { crop: { x: tile.crop.x, y: tile.crop.y, width: tile.crop.width, height: tile.crop.height } } : {}),
    };
  });
  return { ...paths, pageSha256: sha256(png), width: layout.width, height: layout.height, tiles };
}

async function updatePageRecord(recordPath, update) {
  return withCanvasFileLock(recordPath, async () => {
    const previous = await readJsonIfExists(recordPath, null);
    const next = update(previous);
    await writeJsonAtomic(recordPath, next);
    return next;
  });
}

function pageRecordBase({ plan, page, built, reviewer }) {
  return {
    version: ASSET_VERIFY_PAGE_RECORD_VERSION,
    pageId: page.pageId,
    stage: plan.stage,
    pagePath: built.pngRel,
    pageSha256: built.pageSha256,
    size: { width: built.width, height: built.height },
    tileShortSide: REVIEW_PAGE_TILE_SHORT_SIDE,
    minimumSeconds: page.minimumSeconds,
    reviewer,
    items: page.items.map((item) => ({
      slot: item.slot,
      subjectId: item.subjectId,
      assetPath: item.assetPath,
      assetSha256: item.assetSha256,
      versionLabel: item.versionLabel,
      checks: item.checks,
      referenceSha256s: item.references.map((row) => row.sha256),
      zoom: item.zoom,
    })),
    tiles: built.tiles,
  };
}

/** ページの答え（1行目）。pass / 落とす番号（空白・読点区切り）/ q。 */
export function parseVerifyPageAnswer(line, count) {
  if (line === null || line === undefined) return { quit: true };
  const text = String(line).normalize("NFKC").trim().toLowerCase();
  if (text === "q" || text === "quit") return { quit: true };
  if (text === "pass") return { rejected: [] };
  const invalid = { error: `「pass」か、落とす画の番号（1〜${count}。例: 2 4）か、「q」で答える` };
  if (!text) return invalid;
  const numbers = [];
  for (const token of text.split(/[\s,、]+/u).filter(Boolean)) {
    if (!/^\d+$/u.test(token)) return invalid;
    const number = Number(token);
    if (number < 1 || number > count) return invalid;
    if (!numbers.includes(number)) numbers.push(number);
  }
  return numbers.length > 0 ? { rejected: numbers.sort((a, b) => a - b) } : invalid;
}

/** 否とする欄の答え（i = 同一性 / h = 手指 / ih = 両方）。 */
export function parseRejectedChecks(line, checks) {
  const text = String(line ?? "").normalize("NFKC").trim().toLowerCase().replace(/[\s,、+]+/gu, "");
  const wanted = new Set();
  if (["ih", "hi", "both"].includes(text)) {
    wanted.add("identity");
    wanted.add("hand-safety");
  } else if (text === "i") wanted.add("identity");
  else if (text === "h") wanted.add("hand-safety");
  else return null;
  const chosen = checks.filter((id) => wanted.has(id));
  return chosen.length === wanted.size ? chosen : null;
}

/** 対話端末で1行ずつ聞く（Ctrl-C・Ctrl-D は「やめる」）。 */
function terminalQuestioner({ input = process.stdin, output = process.stdout } = {}) {
  const rl = createInterface({ input, output });
  let closed = false;
  let pending = null;
  rl.on("close", () => {
    closed = true;
    if (pending) {
      const resolvePending = pending;
      pending = null;
      resolvePending(null);
    }
  });
  rl.on("SIGINT", () => rl.close());
  return {
    ask: (question) => new Promise((resolvePromise) => {
      if (closed) {
        resolvePromise(null);
        return;
      }
      pending = resolvePromise;
      rl.question(question, (answer) => {
        pending = null;
        resolvePromise(answer);
      });
    }),
    close: () => {
      if (!closed) rl.close();
    },
  };
}

function zoomText(zoom) {
  return zoom.kind === "regions" ? `人物の範囲 ${zoom.crops.length} か所` : "4分割（1割重ねる）";
}

function checksText(item) {
  return item.checks.map((id) => (id === "identity"
    ? `${CHECK_LABELS[id]}（承認済みの設定画 ${item.references.length} 枚と並べて）`
    : CHECK_LABELS[id] || id)).join("・");
}

function passNote(page, item) {
  return `verify-pages ページ ${page.pageId} の [${item.slot}]: 全体（短い辺 ${REVIEW_PAGE_TILE_SHORT_SIDE}px）と拡大（${zoomText(item.zoom)}）を見て可`
    + `${item.checks.includes("identity") ? `。同一性は承認済みの設定画 ${item.references.length} 枚と並べて見た` : ""}`;
}

/**
 * ページ単位の人の確認を回す。対話端末（isInteractive）と --human-verified（humanVerified）が無ければ、何も作らず・
 * 何も書かずに止める。試験は ask（1行を聞く）・openPage（ページを開く）・renderTile（タイルの画素）・now（時計）を
 * 差し替える。
 */
export async function runAssetVerifyPages({
  workDir,
  stage,
  reviewer = "",
  humanVerified = false,
  agentAttested = false,
  isInteractive = false,
  perPage = ASSET_VERIFY_PAGE_DEFAULT_ITEMS,
  targetsPath = "",
  references = [],
  approvedReferencesPath = "",
  ask = null,
  openPage = (file) => openLocalFile(file),
  renderTile = null,
  toolchain = null,
  now = () => new Date().toISOString(),
  captureLearning = null,
  output = process.stdout,
  attest = null,
  env = process.env,
} = {}) {
  if (agentAttested) {
    throw new Error("verify-pages は、確認した人が自分の対話端末で答えるときだけ使う（--agent-attested は使えない。機械は人の確認を記録できない）。");
  }
  const attestationFor = attest || (await import("../scripts/harness-learn.mjs")).attestationFor;
  const attestation = attestationFor({ reviewer, isInteractive, agentAttested: false, humanVerified });
  if (!attestation.ok) throw new Error(attestation.message);
  if (attestation.attestation.attestedBy !== ASSET_HUMAN_VERIFIED) {
    throw new Error("verify-pages は --human-verified が要る（確認した人が自分の対話端末から付ける。機械は人の確認を記録できない）。");
  }
  verifyPageStage(stage);
  verifyPageItemsOrThrow(perPage);
  const write = (text) => output.write(text);

  let tools = toolchain;
  let tileRenderer = renderTile;
  if (!tileRenderer) {
    tools ||= await resolveFfmpegToolchain({ env });
    if (!tools?.ffmpeg?.command || tools.ffmpeg.ok === false) {
      throw new Error("ffmpeg が見つからない（ページ画像を作るのに要る。setup で入れるか、BUZZASSIST_FFMPEG で指す）。");
    }
    tileRenderer = ffmpegReviewTileRenderer(tools.ffmpeg);
  }
  const ffprobe = tools?.ffprobe?.command && tools.ffprobe.ok !== false ? tools.ffprobe : null;
  const readDimensions = (file) => readReviewImageDimensions(file, { ffprobe });

  const plan = await planAssetVerifyPages({ workDir, stage, perPage, targetsPath, references, approvedReferencesPath, readDimensions });
  const waitingCount = plan.pages.reduce((sum, page) => sum + page.items.length, 0);
  write(`人の確認を待っている対象 ${waitingCount} 件を ${plan.pages.length} ページ（1ページ ${plan.perPage} 枚まで）で見る。\n`);
  for (const row of plan.blocked) write(`  載せない（直すまで進まない）: ${row.subjectId} — ${exclusionText(row.reason)}\n`);
  const benign = plan.excluded.filter((row) => !row.blocking);
  if (benign.length > 0) {
    const counts = new Map();
    for (const row of benign) counts.set(row.reason, (counts.get(row.reason) || 0) + 1);
    write(`  載せない（今は人の確認を待っていない）: ${[...counts].map(([reason, count]) => `${exclusionText(reason)} ${count} 件`).join(" / ")}\n`);
  }
  const summary = {
    stage: plan.stage,
    pagesPlanned: plan.pages.length,
    pagesAnswered: 0,
    quit: false,
    items: [],
    excluded: plan.excluded,
    blocked: plan.blocked,
  };
  if (plan.pages.length === 0) {
    summary.complete = plan.blocked.length === 0;
    return summary;
  }

  const terminal = ask ? null : terminalQuestioner({ output });
  const question = ask || terminal.ask;
  const referenceCache = new Map();
  const build = (page) => {
    const promise = buildAssetVerifyPage({ plan, page, renderTile: tileRenderer, readDimensions, referenceCache });
    promise.catch(() => {});
    return promise;
  };
  try {
    let next = build(plan.pages[0]);
    for (const [index, page] of plan.pages.entries()) {
      const built = await next;
      // 人が見ている間に次のページを作っておく（待ち時間を減らすだけで、見せる中身と記録は変えない）。
      next = index + 1 < plan.pages.length ? build(plan.pages[index + 1]) : null;
      const outcome = await presentPage({
        plan, page, built, question, openPage, write, now, reviewer, humanVerified, isInteractive, captureLearning, attest,
      });
      summary.items.push(...outcome.items);
      if (outcome.quit) {
        summary.quit = true;
        break;
      }
      summary.pagesAnswered += 1;
    }
  } finally {
    terminal?.close();
  }
  const recorded = summary.items.filter((row) => row.recorded);
  const notRecorded = summary.items.filter((row) => !row.recorded);
  write(`\n記録した: ${recorded.length} 件（可 ${recorded.filter((row) => row.verdict === "pass").length}・否 ${recorded.filter((row) => row.verdict === "reject").length}）`
    + `${notRecorded.length ? ` / 記録していない: ${notRecorded.length} 件` : ""}`
    + ` / 答えたページ ${summary.pagesAnswered}/${summary.pagesPlanned}\n`);
  if (summary.quit) write("途中でやめた。答えたページまでは記録してある。続きは同じコマンドで（残りの対象だけがページに載る）。\n");
  summary.complete = !summary.quit && summary.pagesAnswered === summary.pagesPlanned && notRecorded.length === 0 && plan.blocked.length === 0;
  return summary;
}

async function presentPage({ plan, page, built, question, openPage, write, now, reviewer, humanVerified, isInteractive, captureLearning, attest }) {
  const count = page.items.length;
  const zoomTiles = page.items.reduce((sum, item) => sum + item.zoom.crops.length, 0);
  // 同じ id のページ（同じ対象・同じ版・同じ欄）を前の回に見せた記録は残す。ページの見出しの番号が変わればページ画像の
  // sha256 も変わるので、見せた記録・答えの記録の1件ずつに、そのときのページ画像の sha256 を持たせる。
  await updatePageRecord(built.recordPath, (previous) => ({
    ...pageRecordBase({ plan, page, built, reviewer }),
    shows: previous?.shows || [],
    answers: previous?.answers || [],
  }));
  const addShow = (show) => updatePageRecord(built.recordPath, (previous) => ({
    ...previous, shows: [...(previous?.shows || []), { ...show, pageSha256: built.pageSha256 }],
  }));
  const addAnswer = (answer) => updatePageRecord(built.recordPath, (previous) => ({
    ...previous, answers: [...(previous?.answers || []), { ...answer, pageSha256: built.pageSha256 }],
  }));
  write(`\n── ページ ${page.index}/${plan.pages.length}（id ${page.pageId}・画 ${count} 枚・拡大 ${zoomTiles} 枚）──\n`
    + `ページ画像: ${built.pngRel}（sha256 ${built.pageSha256.slice(0, 12)}）\n`);
  for (const item of page.items) {
    write(`  [${item.slot}] ${item.subjectId}  確認: ${checksText(item)}  拡大: ${zoomText(item.zoom)}\n`);
  }
  let answer = null;
  let shownAt = "";
  let answeredAt = "";
  let elapsedMs = 0;
  for (;;) {
    try {
      await openPage(built.pngPath);
    } catch (error) {
      write(`ページ画像を自動で開けなかった（${sanitizeEvidence(error?.message || String(error), 200)}）。${built.pngPath} を自分で開く。\n`);
    }
    shownAt = iso(now());
    write(`全部の画の全体と拡大を見てから答える（このページは ${page.minimumSeconds} 秒より早い答えを受け付けない）。\n`);
    let parsed;
    do {
      parsed = parseVerifyPageAnswer(await question("全部 pass なら「pass」、落とす画があればその番号（例: 2 4）、ここでやめるなら「q」: "), count);
      if (parsed.error) write(`  ${parsed.error}\n`);
    } while (parsed.error);
    answeredAt = iso(now());
    elapsedMs = Date.parse(answeredAt) - Date.parse(shownAt);
    if (parsed.quit) {
      await addShow({ shownAt, answeredAt, elapsedMs, outcome: "quit" });
      return { quit: true, items: [] };
    }
    if (elapsedMs < page.minimumSeconds * 1000) {
      await addShow({ shownAt, answeredAt, elapsedMs, outcome: "too-fast" });
      write(`見せてから ${(elapsedMs / 1000).toFixed(1)} 秒で答えた（このページの最短は ${page.minimumSeconds} 秒）。目を通していない答えは受け付けない。`
        + "ページをもう一度開くので、全体と拡大を見てから答える。\n");
      continue;
    }
    answer = parsed;
    break;
  }

  // 落とす画ごとに、否とする欄（欄が2つあるときだけ聞く）と理由。
  const rejections = new Map();
  for (const slot of answer.rejected) {
    const item = page.items[slot - 1];
    let checks = item.checks;
    if (item.checks.length > 1) {
      checks = null;
      while (!checks) {
        const line = await question(`[${slot}] ${item.subjectId} で否とする確認（i = 同一性 / h = 手指 / ih = 両方）: `);
        if (line === null || String(line).trim().toLowerCase() === "q") return quitDuringReasons(addShow, { shownAt, answeredAt, elapsedMs }, write);
        checks = parseRejectedChecks(line, item.checks);
        if (!checks) write("  i・h・ih のどれかで答える\n");
      }
    }
    let reason = "";
    while (Array.from(reason).length < ASSET_VERIFY_REASON_MIN_CHARS) {
      const line = await question(`[${slot}] 落とす理由（短い文。例: 右手の指が6本）: `);
      if (line === null || String(line).trim().toLowerCase() === "q") return quitDuringReasons(addShow, { shownAt, answeredAt, elapsedMs }, write);
      reason = sanitizeEvidence(line, 300).trim();
      if (Array.from(reason).length < ASSET_VERIFY_REASON_MIN_CHARS) write(`  理由を ${ASSET_VERIFY_REASON_MIN_CHARS} 文字以上で書く\n`);
    }
    rejections.set(slot, { checks, reason });
  }
  await addShow({ shownAt, answeredAt, elapsedMs, outcome: "answered" });

  // ページ画像が見せたものと同じか（書き換えられていないか）。違えばこのページは記録しない。
  const pageNow = await fileSha256(built.pngPath).catch(() => "");
  if (pageNow !== built.pageSha256) {
    write("ページ画像が見せた後で変わった（sha256 が違う）。このページは記録しない。同じコマンドで作り直して見直す。\n");
    const items = page.items.map((item) => ({ subjectId: item.subjectId, pageId: page.pageId, slot: item.slot, recorded: false, issues: ["asset-quality-page-image-changed"] }));
    await addAnswer({ shownAt, answeredAt, recorded: [], notRecorded: items.map((row) => ({ slot: row.slot, subjectId: row.subjectId, issues: row.issues })) });
    return { quit: false, items };
  }

  const pageRow = { id: page.pageId, sha256: built.pageSha256, path: built.pngRel, shownAt, answeredAt };
  const items = [];
  for (const item of page.items) {
    const rejection = rejections.get(item.slot);
    const verdicts = rejection
      ? rejection.checks.map((check) => ({ check, verdict: "reject", note: `verify-pages ページ ${page.pageId} の [${item.slot}] で否: ${rejection.reason}` }))
      : item.checks.map((check) => ({ check, verdict: "pass", note: passNote(page, item) }));
    let result;
    try {
      result = await recordAssetPageVerification({
        workDir: plan.workDir,
        stage: plan.stage,
        subjectId: item.subjectId,
        expectedAssetSha256: item.assetSha256,
        verdicts,
        reviewer,
        humanVerified,
        isInteractive,
        page: { ...pageRow, slot: item.slot },
        now,
        captureLearning,
        attest,
      });
    } catch (error) {
      result = { recorded: false, issues: [`asset-quality-page-record-failed:${sanitizeEvidence(error?.message || String(error), 200)}`] };
    }
    items.push({
      subjectId: item.subjectId,
      pageId: page.pageId,
      slot: item.slot,
      recorded: result.recorded === true,
      verdict: rejection ? "reject" : "pass",
      checks: verdicts.map((row) => row.check),
      ...(rejection ? { reason: rejection.reason } : {}),
      issues: result.recorded ? [] : [...(result.issues || [])],
      status: result.check?.status || "",
    });
  }
  const recorded = items.filter((row) => row.recorded);
  const notRecorded = items.filter((row) => !row.recorded);
  await addAnswer({
    shownAt,
    answeredAt,
    recorded: recorded.map((row) => ({ slot: row.slot, subjectId: row.subjectId, verdict: row.verdict, checks: row.checks })),
    notRecorded: notRecorded.map((row) => ({ slot: row.slot, subjectId: row.subjectId, issues: row.issues })),
  });
  write(`  記録: 可 ${recorded.filter((row) => row.verdict === "pass").length}・否 ${recorded.filter((row) => row.verdict === "reject").length}`
    + `${notRecorded.length ? ` / 記録していない ${notRecorded.map((row) => `[${row.slot}] ${row.subjectId}（${row.issues.join(", ")}）`).join(" ")}` : ""}\n`);
  return { quit: false, items };
}

async function quitDuringReasons(addShow, show, write) {
  await addShow({ ...show, outcome: "quit-during-reasons" });
  write("理由を聞いている途中でやめた。このページは記録していない（次は同じページから）。\n");
  return { quit: true, items: [] };
}
