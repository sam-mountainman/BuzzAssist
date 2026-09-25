/**
 * ナレーション物語の固定の重ね物（告知の枠・ロゴなど。ジャンル層）。
 *
 * Channel Pack の narrated-story.json `overlays` に置いた画像（PNG、透過つき可）を、宣言した区間に、宣言した
 * 位置で重ねる。画像は運営者が Pack に入れる。Core は既定の画像も位置も持たない（実在のブランドのロゴなどを
 * 重ねる運用を想定した既定値は置かない）。
 *
 *   "overlays": {
 *     "items": [
 *       { "id": "notice", "image": "overlays/notice.png", "part": "story",
 *         "startSeconds": 0, "endSeconds": 30,            // 部の頭からの秒（省略すると部の終わりまで）
 *         "x": 0.03, "y": 0.04, "width": 0.3 }             // 画面に対する割合。高さは画像の縦横比から決まる
 *     ],
 *     "faceRegions": {                                     // 人の顔が出うる範囲（部ごと、画面に対する割合）
 *       "story": [{ "x": 0.2, "y": 0.1, "width": 0.6, "height": 0.75 }]
 *     }
 *   }
 *
 * 重ねてよいのは本編（story）と感想パート（review）だけ（OP と境目の転換には重ねない。どちらも別の監査が
 * フレームを丸ごと測る）。置き場所の宣言は有料生成の前に検査する:
 *   - 画面の中に収まる
 *   - 焼き込み字幕の範囲（帯と、最大の行数の字の範囲）と重ならない
 *   - 感想パートの配置の TV 枠・人物の枠（線を含む）と重ならない
 *   - 重ねる部の faceRegions と重ならない。顔の範囲は Core には分からないので、重ねる部ごとに Pack が宣言する
 *     （宣言が無ければ止める）
 *   - 画像に不透明な画素がある（完成 MP4 で重ねたことを測るのに使う）
 *
 * 監査 fixedOverlaysMeasured は、完成 MP4 の輝度（Y）で、区間の始まり・中ほど・終わりのフレームに重ね物の
 * 不透明な画素が宣言の位置に出ていること、区間の直前・直後のフレームには出ていないことを測る。宣言が
 * 無ければ、重ね物を描いていない（組み立ての graph に重ね物の段が無い）ことを確かめる。
 */

import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { inflateSync } from "node:zlib";

import { subtitleLineBaselines } from "./narratedStorySubtitles.mjs";

const execFile = promisify(execFileCallback);

export const NARRATED_OVERLAY_AUDIT_ID = "fixedOverlaysMeasured";
export const NARRATED_OVERLAY_PLAN_VERSION = "buzzassist-narrated-story-overlay-plan-v1";
export const NARRATED_OVERLAY_PARTS = Object.freeze(["story", "review"]);
export const NARRATED_OVERLAY_FIELDS = Object.freeze({
  top: Object.freeze(["items", "faceRegions"]),
  item: Object.freeze(["id", "image", "part", "startSeconds", "endSeconds", "x", "y", "width"]),
  region: Object.freeze(["x", "y", "width", "height"]),
});
const MAX_ITEMS = 8;
const ID = /^[a-z][a-z0-9-]{0,31}$/u;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
/** 画像の不透明な画素（alpha ≥ 250）の最少の数。これより少ない画像は、重ねたことを MP4 で測れない。 */
export const OVERLAY_MIN_OPAQUE_PIXELS = 64;

// ---- 監査の閾値 -------------------------------------------------------------
//
// test/narratedStoryOverlays.test.mjs の合成 fixture（不透明な色の枠と半透明の縁を持つ PNG、320x180・24fps の
// 番組の本編と感想パート）で、基準版と壊した版（重ねない・位置をずらす・区間をずらす）を同じ測定にかけて決めた
// （2026-09-26、ffmpeg 7.1.1）。値を変えるときは同じ fixture を測り直すこと。

/** 不透明な画素の輝度（Y）が、画像を同じ大きさに縮めて読んだ輝度とこの差の中なら「重ね物の色」。 */
export const OVERLAY_LUMA_TOLERANCE = 20;
/**
 * 区間の中のフレームで、重ね物の色の画素の割合の下限。実測: 基準版 1.000、位置を 40px 以上ずらした版 0.271〜0.387、
 * 色の違う別の画像と比べた版 0.460〜0.474、区間を 6 フレーム後ろへずらした版の終わりのフレーム 0.045。
 */
export const OVERLAY_PRESENT_MIN_MATCH = 0.9;
/**
 * 区間の外のフレームで、重ね物の色の画素の割合の上限。実測: 基準版 0.023〜0.222（最大は感想パートの直前の字幕なし
 * lead-in のフレーム）、区間を 6 フレーム後ろへずらした版の頭の直前 1.000。
 */
export const OVERLAY_ABSENT_MAX_MATCH = 0.5;

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rangeNumber(value, minimum, maximum) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function even(value) {
  return Math.max(2, Math.round(value / 2) * 2);
}

function packRelative(value) {
  const text = nonEmpty(value);
  if (!text || isAbsolute(text) || text.includes("\\") || /^[a-z]:/iu.test(text)) return "";
  const parts = text.split("/");
  return parts.some((part) => !part || part === "." || part === "..") ? "" : parts.join("/");
}

// ---- PNG（寸法と不透明な画素の数だけを読む。8 bit・インタレース無しに限る） -----------

function paeth(left, up, upLeft) {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  return pa <= pb && pa <= pc ? left : (pb <= pc ? up : upLeft);
}

/** PNG の寸法と、alpha ≥ 250 の画素の数（alpha の無い形式は全部）。読めなければ problem を返す。 */
export function inspectOverlayPng(bytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!Buffer.isBuffer(bytes) || bytes.length < 33 || !bytes.subarray(0, 8).equals(signature)) return { problem: "image-not-png" };
  let offset = 8;
  let header = null;
  let transparency = null;
  const data = [];
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), bitDepth: body[8], colorType: body[9], interlace: body[12] };
    else if (type === "tRNS") transparency = Buffer.from(body);
    else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (!header || header.width < 1 || header.height < 1) return { problem: "image-not-png" };
  if (header.bitDepth !== 8 || header.interlace !== 0) return { problem: "image-png-8bit-non-interlaced-required" };
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[header.colorType];
  if (!channels) return { problem: "image-not-png" };
  const { width, height } = header;
  if (header.colorType === 0 || header.colorType === 2) {
    // alpha の無い形式（tRNS の単色の透過は、画素ごとに照合しないと数えられないので全部を不透明とはみなさない）。
    return transparency ? { problem: "image-png-color-key-transparency-unsupported" } : { width, height, opaquePixels: width * height };
  }
  let raw;
  try { raw = inflateSync(Buffer.concat(data)); } catch { return { problem: "image-not-png" }; }
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) return { problem: "image-not-png" };
  const previous = new Uint8Array(stride);
  const line = new Uint8Array(stride);
  let opaquePixels = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const source = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? line[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      const value = source[x];
      line[x] = (filter === 0 ? value
        : filter === 1 ? value + left
          : filter === 2 ? value + up
            : filter === 3 ? value + ((left + up) >> 1)
              : value + paeth(left, up, upLeft)) & 255;
    }
    for (let x = 0; x < width; x += 1) {
      const alpha = header.colorType === 3
        ? (transparency && line[x] < transparency.length ? transparency[line[x]] : 255)
        : line[x * channels + channels - 1];
      if (alpha >= 250) opaquePixels += 1;
    }
    previous.set(line);
  }
  return { width, height, opaquePixels };
}

// ---- Channel Pack の宣言 ------------------------------------------------------

function normalizeRegion(source, label, blockers) {
  if (!plainObject(source)) {
    blockers.push(label);
    return null;
  }
  for (const key of Object.keys(source)) if (!NARRATED_OVERLAY_FIELDS.region.includes(key)) blockers.push(`${label}.${key}-unknown`);
  const x = rangeNumber(source.x, 0, 1);
  const y = rangeNumber(source.y, 0, 1);
  const width = rangeNumber(source.width, 0.01, 1);
  const height = rangeNumber(source.height, 0.01, 1);
  if ([x, y, width, height].some((value) => value === null) || x + width > 1 || y + height > 1) {
    blockers.push(label);
    return null;
  }
  return { x, y, width, height };
}

function pixelBox(rect, render) {
  return { x: rect.x * render.width, y: rect.y * render.height, width: rect.width * render.width, height: rect.height * render.height };
}

function overlaps(left, right) {
  return Math.min(left.x + left.width, right.x + right.width) > Math.max(left.x, right.x)
    && Math.min(left.y + left.height, right.y + right.height) > Math.max(left.y, right.y);
}

/**
 * 焼き込み字幕が描かれうる範囲（描く寸法の px の矩形の一覧）。帯があれば帯の全体と、最大の行数の字の範囲（基線から
 * 字の大きさの上下と縁の幅）。焼き込みを宣言していなければ空。
 */
export function subtitleReservedRegions(subtitles) {
  if (!subtitles?.burnIn) return [];
  const { width, height } = subtitles.render;
  const regions = [];
  if (subtitles.band) regions.push({ x: 0, y: subtitles.band.topPx, width, height: height - subtitles.band.topPx });
  const baselines = subtitleLineBaselines(subtitles, subtitles.maxLines);
  const outline = subtitles.outline?.widthPx || 0;
  const top = Math.max(0, Math.min(...baselines) - subtitles.fontSizePx - outline);
  const bottom = Math.min(height, Math.max(...baselines) + Math.ceil(subtitles.fontSizePx * 0.35) + outline);
  const left = Math.max(0, subtitles.sideMarginPx - outline);
  regions.push({ x: left, y: top, width: Math.min(width, width - subtitles.sideMarginPx + outline) - left, height: bottom - top });
  return regions;
}

/**
 * narrated-story.json の `overlays` を読む。画像は Pack の中のファイルを読んで寸法と不透明な画素を確かめ、
 * 置き場所を字幕・感想の配置の枠・顔の範囲と照合する。宣言が無ければ { enabled: false }。
 * subtitles・bookends は正規化した後の Pack の設定。
 */
export async function loadNarratedOverlayConfig(source, { render, channelPackDir, subtitles = null, bookends = null }) {
  const blockers = [];
  if (source === undefined || source === null) return { config: { enabled: false }, blockers };
  if (!plainObject(source)) return { config: { enabled: false }, blockers: ["overlays"] };
  for (const key of Object.keys(source)) if (!NARRATED_OVERLAY_FIELDS.top.includes(key)) blockers.push(`overlays.${key}-unknown`);
  const itemsSource = Array.isArray(source.items) ? source.items : null;
  if (!itemsSource || itemsSource.length === 0 || itemsSource.length > MAX_ITEMS) blockers.push("overlays.items");
  const faceRegions = {};
  if (source.faceRegions !== undefined) {
    if (!plainObject(source.faceRegions)) blockers.push("overlays.faceRegions");
    else {
      for (const [part, list] of Object.entries(source.faceRegions)) {
        if (!NARRATED_OVERLAY_PARTS.includes(part)) { blockers.push(`overlays.faceRegions.${part}-unknown`); continue; }
        if (!Array.isArray(list)) { blockers.push(`overlays.faceRegions.${part}`); continue; }
        faceRegions[part] = list.map((entry, index) => normalizeRegion(entry, `overlays.faceRegions.${part}[${index}]`, blockers)).filter(Boolean);
      }
    }
  }
  const reviewAvailable = Boolean(bookends?.enabled && bookends.review);
  const reserved = subtitleReservedRegions(subtitles);
  const layout = reviewAvailable ? bookends.review.layout : null;
  const layoutFrames = layout
    ? [["tv-frame", layout.tv], ["presenter-frame", layout.presenterFrame]].map(([name, rect]) => [name, {
      x: rect.x - rect.borderPx, y: rect.y - rect.borderPx, width: rect.width + 2 * rect.borderPx, height: rect.height + 2 * rect.borderPx,
    }])
    : [];
  const items = [];
  const seen = new Set();
  for (const [index, item] of (itemsSource || []).entries()) {
    const label = `overlays.items[${index}]`;
    if (!plainObject(item)) { blockers.push(label); continue; }
    for (const key of Object.keys(item)) if (!NARRATED_OVERLAY_FIELDS.item.includes(key)) blockers.push(`${label}.${key}-unknown`);
    const id = nonEmpty(item.id);
    if (!ID.test(id) || seen.has(id)) blockers.push(`${label}.id`);
    seen.add(id);
    const at = ID.test(id) ? `overlays.items.${id}` : label;
    const part = nonEmpty(item.part);
    if (!NARRATED_OVERLAY_PARTS.includes(part)) blockers.push(`${at}.part`);
    else if (part === "review" && !reviewAvailable) blockers.push(`${at}.part-review-without-bookends-review`);
    const startSeconds = item.startSeconds === undefined ? 0 : rangeNumber(item.startSeconds, 0, 36_000);
    if (startSeconds === null) blockers.push(`${at}.startSeconds`);
    const endSeconds = item.endSeconds === undefined ? null : rangeNumber(item.endSeconds, 0, 36_000);
    if (item.endSeconds !== undefined && (endSeconds === null || (startSeconds !== null && endSeconds <= startSeconds))) blockers.push(`${at}.endSeconds`);
    const x = rangeNumber(item.x, 0, 0.99);
    const y = rangeNumber(item.y, 0, 0.99);
    const width = rangeNumber(item.width, 0.02, 1);
    for (const [key, value] of Object.entries({ x, y, width })) if (value === null) blockers.push(`${at}.${key}`);
    const image = packRelative(item.image);
    if (!image) { blockers.push(`${at}.image-invalid-pack-path`); continue; }
    const imagePath = join(resolve(String(channelPackDir || "")), ...image.split("/"));
    let bytes = null;
    try {
      const info = await lstat(imagePath);
      if (info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= MAX_IMAGE_BYTES) bytes = await readFile(imagePath);
    } catch {
      bytes = null;
    }
    if (!bytes) { blockers.push(`${at}.image-missing`); continue; }
    const png = inspectOverlayPng(bytes);
    if (png.problem) { blockers.push(`${at}.${png.problem}`); continue; }
    if (png.opaquePixels < OVERLAY_MIN_OPAQUE_PIXELS) blockers.push(`${at}.image-needs-opaque-pixels`);
    if (x === null || y === null || width === null || !NARRATED_OVERLAY_PARTS.includes(part)) continue;
    const box = { x: even(x * render.width), y: even(y * render.height), width: even(width * render.width) };
    box.height = even((box.width * png.height) / png.width);
    if (box.x + box.width > render.width || box.y + box.height > render.height) { blockers.push(`${at}.outside-frame`); continue; }
    if (reserved.some((region) => overlaps(box, region))) blockers.push(`${at}.overlaps-subtitles`);
    if (part === "review") for (const [name, rect] of layoutFrames) if (overlaps(box, rect)) blockers.push(`${at}.overlaps-${name}`);
    if (!faceRegions[part] || faceRegions[part].length === 0) blockers.push(`${at}.face-regions-undeclared:${part}`);
    else if (faceRegions[part].some((region) => overlaps(box, pixelBox(region, render)))) blockers.push(`${at}.overlaps-face-region`);
    items.push({ id, part, startSeconds: startSeconds ?? 0, endSeconds, box, imagePath, imageSha256: createHash("sha256").update(bytes).digest("hex"), opaquePixels: png.opaquePixels });
  }
  if (blockers.length > 0) return { config: null, blockers: [...new Set(blockers)] };
  return { config: { enabled: true, items, faceRegions }, blockers: [] };
}

// ---- 番組の中の区間と描き方 ---------------------------------------------------

/**
 * 重ね物の番組の中のフレームの区間。部（bookends があればその部、無ければ本編＝番組全体）の頭からの秒を
 * フレームにし、部の終わりで止める（部より長い宣言は部の終わりまで。clipped に残す）。
 */
export function planNarratedOverlayLayer({ config, bookendPlan = null, totalFrames, fps }) {
  const overlays = config?.overlays;
  if (!overlays?.enabled) return null;
  const partRange = (part) => {
    if (!bookendPlan) return part === "story" ? { startFrame: 0, endFrame: totalFrames } : null;
    const entry = bookendPlan.parts.find((candidate) => candidate.id === part);
    return entry ? { startFrame: entry.startFrame, endFrame: entry.startFrame + entry.frames } : null;
  };
  const problems = [];
  const items = [];
  for (const item of overlays.items) {
    const range = partRange(item.part);
    if (!range) { problems.push(`overlay-part-missing:${item.id}`); continue; }
    const startFrame = range.startFrame + Math.round(item.startSeconds * fps);
    const wanted = item.endSeconds === null ? range.endFrame : range.startFrame + Math.round(item.endSeconds * fps);
    const endFrame = Math.min(range.endFrame, wanted);
    if (endFrame - startFrame < 1) { problems.push(`overlay-range-outside-part:${item.id}`); continue; }
    items.push({ ...item, startFrame, endFrame, clipped: wanted > range.endFrame });
  }
  return { version: NARRATED_OVERLAY_PLAN_VERSION, items, problems, totalFrames, fps };
}

/** 番組の組み立ての入力（重ね物の画像を1枚ずつ。数は Pack の宣言の数で、台本の長さに依らない）。 */
export function overlayLayerInputs(layer) {
  return (layer?.items || []).flatMap((item) => ["-i", item.imagePath]);
}

/**
 * 番組の組み立ての graph で、重ね物を重ねる段（[input] → [output]）。firstInputIndex は重ね物の最初の入力の番号。
 * 各段は宣言の区間のフレームだけ（enable の n は番組のフレーム番号）で、画像は宣言の大きさに縮めて重ねる。
 */
export function fixedOverlayGraph(layer, { firstInputIndex, input, output }) {
  const stages = [];
  let current = input;
  layer.items.forEach((item, index) => {
    const k = index + 1;
    const next = index === layer.items.length - 1 ? output : `${input}fixed${k}`;
    stages.push(`[${firstInputIndex + index}:v]scale=${item.box.width}:${item.box.height},format=rgba[fixedoverlay${k}]`);
    stages.push(`[${current}][fixedoverlay${k}]overlay=x=${item.box.x}:y=${item.box.y}:eof_action=repeat:format=auto:enable=between(n\\,${item.startFrame}\\,${item.endFrame - 1})[${next}]`);
    current = next;
  });
  return stages.join(";");
}

/** 動かない重ね物の範囲（カメラ・場面の切り替え・境目の実測で外す）。 */
export function overlayExclusionRegions(layer) {
  return (layer?.items || []).map((item) => ({ ...item.box }));
}

/** generation manifest に残す重ね物の記録（画像の sha256・位置・区間だけ）。 */
export function narratedOverlayManifestEntry(layer) {
  if (!layer) return { enabled: false };
  return {
    version: layer.version,
    enabled: true,
    items: layer.items.map(({ id, part, box, startFrame, endFrame, clipped, imageSha256 }) => ({ id, part, box, startFrame, endFrame, clipped, imageSha256 })),
  };
}

// ---- 実測（完成 MP4） ---------------------------------------------------------

async function lumaCrop(ffmpeg, videoPath, frame, fps, box) {
  const { stdout } = await execFile(ffmpeg.command, [...(ffmpeg.args || []),
    "-hide_banner", "-loglevel", "error", "-ss", Math.max(0, (frame - 0.25) / fps).toFixed(6), "-i", videoPath,
    "-frames:v", "1", "-vf", `crop=${box.width}:${box.height}:${box.x}:${box.y},format=gray`, "-f", "rawvideo", "-",
  ], { encoding: "buffer", timeout: 120_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return stdout.length >= box.width * box.height ? stdout.subarray(0, box.width * box.height) : null;
}

/** 画像を宣言の大きさに縮め、YUVA の Y と A を読む（番組の組み立てと同じ RGBA → YUV の変換）。 */
async function expectedOverlayPlanes(ffmpeg, item) {
  const { width, height } = item.box;
  const { stdout } = await execFile(ffmpeg.command, [...(ffmpeg.args || []),
    "-hide_banner", "-loglevel", "error", "-i", item.imagePath,
    "-frames:v", "1", "-vf", `scale=${width}:${height},format=yuva444p`, "-f", "rawvideo", "-",
  ], { encoding: "buffer", timeout: 120_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  const size = width * height;
  if (stdout.length < size * 4) return null;
  return { luma: stdout.subarray(0, size), alpha: stdout.subarray(size * 3, size * 4) };
}

/** 不透明で、上下左右斜めの隣も不透明な画素（縁の混ざりを外す）。 */
export function opaqueCore(alpha, width, height) {
  const core = [];
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      let ok = true;
      for (let dy = -1; dy <= 1 && ok; dy += 1) for (let dx = -1; dx <= 1 && ok; dx += 1) if (alpha[(y + dy) * width + x + dx] < 250) ok = false;
      if (ok) core.push(y * width + x);
    }
  }
  return core;
}

/** 重ね物の色（期待の輝度との差が許容の中）の画素の割合。 */
export function overlayMatch(frame, expected, core) {
  if (!frame || core.length === 0) return 0;
  let match = 0;
  for (const index of core) if (Math.abs(frame[index] - expected[index]) <= OVERLAY_LUMA_TOLERANCE) match += 1;
  return match / core.length;
}

/**
 * 重ね物を完成 MP4 で測る。区間の始まり・中ほど・終わりのフレームで重ね物が宣言の位置に出ていて、区間の直前と
 * 直後のフレーム（同じ位置に別の重ね物が出ている時刻は除く）には出ていないこと。
 */
export async function measureNarratedOverlays({ ffmpeg, videoPath, layer, fps }) {
  const rows = [];
  for (const item of layer.items) {
    const problems = [];
    const planes = await expectedOverlayPlanes(ffmpeg, item);
    const core = planes ? opaqueCore(planes.alpha, item.box.width, item.box.height) : [];
    if (core.length < 16) {
      rows.push({ id: item.id, pass: false, problems: ["overlay-unmeasurable"], samples: [] });
      continue;
    }
    const inside = [...new Set([item.startFrame, Math.floor((item.startFrame + item.endFrame - 1) / 2), item.endFrame - 1])];
    const covered = (frame) => layer.items.some((other) => other !== item && frame >= other.startFrame && frame < other.endFrame
      && Math.min(other.box.x + other.box.width, item.box.x + item.box.width) > Math.max(other.box.x, item.box.x)
      && Math.min(other.box.y + other.box.height, item.box.y + item.box.height) > Math.max(other.box.y, item.box.y));
    const outside = [item.startFrame - 1, item.endFrame].filter((frame) => frame >= 0 && frame < layer.totalFrames && !covered(frame));
    const samples = [];
    for (const frame of inside) {
      const match = overlayMatch(await lumaCrop(ffmpeg, videoPath, frame, fps, item.box), planes.luma, core);
      samples.push({ frame, expected: "present", match: Math.round(match * 1000) / 1000 });
      if (match < OVERLAY_PRESENT_MIN_MATCH) problems.push("overlay-not-observed-in-range");
    }
    for (const frame of outside) {
      const match = overlayMatch(await lumaCrop(ffmpeg, videoPath, frame, fps, item.box), planes.luma, core);
      samples.push({ frame, expected: "absent", match: Math.round(match * 1000) / 1000 });
      if (match > OVERLAY_ABSENT_MAX_MATCH) problems.push("overlay-observed-outside-range");
    }
    rows.push({ id: item.id, part: item.part, box: item.box, startFrame: item.startFrame, endFrame: item.endFrame, corePixels: core.length, pass: problems.length === 0, problems: [...new Set(problems)], samples });
  }
  const failed = rows.filter((row) => !row.pass);
  return {
    version: NARRATED_OVERLAY_PLAN_VERSION,
    pass: rows.length > 0 && failed.length === 0,
    itemCount: rows.length,
    failedIds: failed.map((row) => row.id),
    problems: [...new Set(failed.flatMap((row) => row.problems))],
    items: rows,
  };
}
