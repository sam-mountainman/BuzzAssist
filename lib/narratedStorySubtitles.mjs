/**
 * ナレーション物語の焼き込み字幕（ジャンル層）。
 *
 * 公開 Core なので、チャンネル固有の値（書体・大きさ・色・縁・帯・位置・1行の字数）は1つも持たない。
 * 全部を署名済み Channel Pack の narrated-story.json `subtitles` から受け取り、足りなければ有料生成の
 * 前に blocker で止める。Core が持つのは
 *
 * - 日本語の改行の規則（行頭・行末の禁則、英数字の語を割らない、句読点の後ろを優先する）と、
 *   実際に描く書体の送り幅で測った行の幅（lib/fontMetrics.mjs）
 * - 1つの文（声のテイク1つ）を画面に収まる頁へ分け、その文の時間を字数の重みで配る時間割
 * - 頁ごとの透明な PNG（FFmpeg の drawtext と drawbox）と、それを番組の時間どおりに重ねる
 *   concat demuxer の一覧（フィルターは overlay 1つ。台本が長くても filter graph の長さが増えない）
 * - 完成 MP4 のフレームを読んで、字幕が計画した位置に計画したフレームで出ていること・縁か帯で
 *   読める明るさの差があること・字幕の無い間に出ていないことを測る監査
 *
 * 字幕の文字は台本の表記（segment.text）で、声に渡した読み（spokenText）は使わない。
 *
 * drawtext を選んだ理由（libass の subtitles / ass ではなく）: 有料生成の前の検査
 * （missingBookendFfmpegFilters）が既に drawtext を確かめていて、setup が入れる固定版 ffmpeg・
 * Linux・Windows の CI のどれでも drawtext があることを試験で確かめている。libass は書体を
 * 名前で探すので、Pack の書体が選ばれずに別の書体で描かれても気づけない。drawtext は fontfile で
 * 書体のファイルそのものを指す。
 */

import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { loadFontMetrics, measureTextWidth, missingGlyphs } from "./fontMetrics.mjs";

const execFile = promisify(execFileCallback);

export const NARRATED_SUBTITLE_PLAN_VERSION = "buzzassist-narrated-story-subtitle-plan-v1";
export const NARRATED_SUBTITLE_AUDIT_ID = "burnedSubtitlesMeasured";
export const NARRATED_SUBTITLE_ANCHORS = Object.freeze(["bottom", "top"]);

const HEX_COLOR = /^#[0-9a-f]{6}$/iu;
/** 1つの頁に載せてよい字数の上限（頁分けの探索の幅。これを越える頁は作らない）。 */
const MAX_PAGE_CHARACTERS = 120;
/** 行の上下の余白の最小（画面の高さに対する割合）。これより端に寄る配置は Pack の段階で止める。 */
export const SUBTITLE_VERTICAL_SAFE_RATIO = 0.01;

// ---- 監査の閾値 -------------------------------------------------------------
//
// test/narratedStorySubtitles.test.mjs の合成 fixture（640x360・24fps・libx264 crf 14、模様のある画の上に
// 縁つき（白い字に黒い縁）と帯つき（半透明の白い帯に濃い字））を、基準版と壊した版（焼き込みを抜いた版・
// 3px / 12px 横へずらした版・1フレーム早く出した版・字を縁と同じ暗さにした版）で同じ測定にかけて決めた
// （2026-09-25、ffmpeg 7.1.1）。値を変えるときは同じ fixture を測り直して、この根拠を書き換えること。

/**
 * 字の芯（PNG で不透明かつ字の色の画素）のうち、MP4 の同じ画素の輝度が字の色の輝度から
 * SUBTITLE_FILL_LUMA_TOLERANCE 以内にある割合の下限。
 * 実測: 基準版 1.00（縁・帯とも）、焼き込みを抜いた版 0.02〜0.23、3px ずらした版 0.31〜0.51、
 * 12px ずらした版 0.27〜0.43。
 */
export const SUBTITLE_FILL_MATCH_MIN = 0.8;
/** 字の芯の輝度の許容（0〜255）。H.264 の圧縮と 4:2:0 の色の間引きで芯の輝度は数段揺れる。 */
export const SUBTITLE_FILL_LUMA_TOLERANCE = 48;
/**
 * 字が出ていない（前の頁・字幕の無い間）とみなす一致率の上限。
 * 実測: 基準版で頁の始まりの1つ前のフレーム 0.02〜0.38（前の頁の字の上で高め）、終わりの次のフレーム
 * 0.06〜0.23、1フレーム早く出した版 1.00。
 */
export const SUBTITLE_ABSENT_MATCH_MAX = 0.5;
/**
 * 読める明るさの差: MP4 で測った字の芯の平均輝度と、縁（または帯）の平均輝度の差の下限。
 * 実測: 白い字に黒い縁 251、帯に濃い字 160〜167、字を縁と同じ暗さにした版 13.5。
 */
export const SUBTITLE_MIN_LUMA_CONTRAST = 60;

// ---- 小道具 ---------------------------------------------------------------

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function rangeNumber(value, minimum, maximum) {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function colorOf(value) {
  const text = nonEmpty(value);
  return HEX_COLOR.test(text) ? text.toLowerCase() : "";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function rgbOf(hex) {
  const value = Number.parseInt(String(hex).slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function lumaOf([red, green, blue]) {
  return 0.299 * red + 0.587 * green + 0.114 * blue;
}

function ffColor(hex, alpha = null) {
  return `0x${String(hex).slice(1)}${alpha === null ? "" : `@${Number(alpha).toFixed(3)}`}`;
}

/** Pack 内の相対 path だけを受ける（lib/narratedStoryBookends.mjs の packRelativePath と同じ規則）。 */
function packRelative(value) {
  const text = nonEmpty(value);
  if (!text || text.startsWith("/") || text.includes("\\") || /^[a-z]:/iu.test(text)) return null;
  const parts = text.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts.join("/");
}

async function runRuntime(spec, args, { cwd, timeout = 10 * 60_000, encoding = "utf8" } = {}) {
  if (!spec?.command) throw new Error("A resolved executable is required.");
  return execFile(spec.command, [...(spec.args || []), ...args], {
    cwd,
    timeout,
    windowsHide: true,
    encoding,
    maxBuffer: 256 * 1024 * 1024,
  });
}

async function mapLimit(values, limit, worker) {
  const output = new Array(values.length);
  let next = 0;
  const run = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      output[index] = await worker(values[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, values.length)) }, run));
  return output;
}

// ---- Channel Pack の subtitles ----------------------------------------------

export const NARRATED_SUBTITLE_FIELDS = Object.freeze({
  top: Object.freeze([
    "burnIn", "fontFile", "fontSizeRatio", "textColor", "outline", "band", "position",
    "lineSpacingRatio", "sideMarginRatio", "maxLines", "maxCharsPerLine",
  ]),
  outline: Object.freeze(["color", "widthRatio"]),
  band: Object.freeze(["color", "opacity", "topRatio"]),
  position: Object.freeze(["anchor", "baselineRatio"]),
});

/**
 * narrated-story.json の `subtitles` を正規化する（純粋関数。file は見ない）。
 *
 *   "subtitles": {
 *     "burnIn": true,
 *     "fontFile": "fonts/subtitle.otf",           // Pack 内の書体
 *     "fontSizeRatio": 0.06,                       // 字の大きさ（画面の高さに対する割合）
 *     "textColor": "#ffffff",
 *     "outline": { "color": "#000000", "widthRatio": 0.12 },          // 縁（字の大きさに対する割合）
 *     "band": { "color": "#ffffff", "opacity": 0.55, "topRatio": 0.70 }, // 画面の下の帯（任意）
 *     "position": { "anchor": "bottom", "baselineRatio": 0.9 },         // 最後の行（top なら最初の行）の基線
 *     "lineSpacingRatio": 1.3,                     // 行の送り（字の大きさに対する割合。任意、既定 1.3）
 *     "sideMarginRatio": 0.07,                     // 左右の安全な余白（画面の幅に対する割合）
 *     "maxLines": 2,
 *     "maxCharsPerLine": 24                        // 任意。幅に加えて字数でも区切る
 *   }
 *
 * 縁か帯の少なくとも一方が要る（どちらも無い字幕は、明るい画の上で読めない）。
 */
export function normalizeNarratedSubtitlesConfig(source, { render = { width: 1280, height: 720 } } = {}) {
  const blockers = [];
  if (source === undefined || source === null) return { config: { burnIn: false }, blockers };
  if (!plainObject(source)) return { config: { burnIn: false }, blockers: ["subtitles"] };
  for (const key of Object.keys(source)) if (!NARRATED_SUBTITLE_FIELDS.top.includes(key)) blockers.push(`subtitles.${key}-unknown`);
  if (source.burnIn !== true) {
    if (source.burnIn !== false && source.burnIn !== undefined) blockers.push("subtitles.burnIn");
    return { config: { burnIn: false }, blockers };
  }
  const width = Number(render.width) || 1280;
  const height = Number(render.height) || 720;
  const fontFile = packRelative(source.fontFile);
  if (!fontFile) blockers.push(source.fontFile === undefined ? "subtitles.fontFile-required" : "subtitles.fontFile-invalid-pack-path");
  const fontSizeRatio = rangeNumber(source.fontSizeRatio, 0.02, 0.2);
  if (fontSizeRatio === null) blockers.push("subtitles.fontSizeRatio");
  const fontSizePx = Math.max(8, Math.round((fontSizeRatio ?? 0.05) * height));
  const textColor = colorOf(source.textColor);
  if (!textColor) blockers.push("subtitles.textColor");
  let outline = null;
  if (source.outline !== undefined) {
    if (!plainObject(source.outline)) blockers.push("subtitles.outline");
    else {
      for (const key of Object.keys(source.outline)) if (!NARRATED_SUBTITLE_FIELDS.outline.includes(key)) blockers.push(`subtitles.outline.${key}-unknown`);
      const color = colorOf(source.outline.color);
      const widthRatio = rangeNumber(source.outline.widthRatio, 0.02, 0.4);
      if (!color) blockers.push("subtitles.outline.color");
      if (widthRatio === null) blockers.push("subtitles.outline.widthRatio");
      outline = { color, widthRatio: widthRatio ?? 0, widthPx: Math.max(1, Math.round((widthRatio ?? 0) * fontSizePx)) };
    }
  }
  let band = null;
  if (source.band !== undefined) {
    if (!plainObject(source.band)) blockers.push("subtitles.band");
    else {
      for (const key of Object.keys(source.band)) if (!NARRATED_SUBTITLE_FIELDS.band.includes(key)) blockers.push(`subtitles.band.${key}-unknown`);
      const color = colorOf(source.band.color);
      const opacity = rangeNumber(source.band.opacity, 0.2, 1);
      const topRatio = rangeNumber(source.band.topRatio, 0.3, 0.98);
      if (!color) blockers.push("subtitles.band.color");
      if (opacity === null) blockers.push("subtitles.band.opacity");
      if (topRatio === null) blockers.push("subtitles.band.topRatio");
      band = { color, opacity: opacity ?? 0, topRatio: topRatio ?? 0, topPx: Math.round((topRatio ?? 0) * height) };
    }
  }
  if (!outline && !band) blockers.push("subtitles.outline-or-band-required");
  const position = plainObject(source.position) ? source.position : null;
  if (!position) blockers.push("subtitles.position");
  else for (const key of Object.keys(position)) if (!NARRATED_SUBTITLE_FIELDS.position.includes(key)) blockers.push(`subtitles.position.${key}-unknown`);
  const anchor = nonEmpty(position?.anchor);
  if (position && !NARRATED_SUBTITLE_ANCHORS.includes(anchor)) blockers.push("subtitles.position.anchor");
  const baselineRatio = rangeNumber(position?.baselineRatio, 0.05, 0.98);
  if (position && baselineRatio === null) blockers.push("subtitles.position.baselineRatio");
  let lineSpacingRatio = 1.3;
  if (source.lineSpacingRatio !== undefined) {
    const parsed = rangeNumber(source.lineSpacingRatio, 1, 2.5);
    if (parsed === null) blockers.push("subtitles.lineSpacingRatio");
    else lineSpacingRatio = parsed;
  }
  const sideMarginRatio = rangeNumber(source.sideMarginRatio, 0, 0.3);
  if (sideMarginRatio === null) blockers.push("subtitles.sideMarginRatio");
  const maxLines = Number.isInteger(source.maxLines) && source.maxLines >= 1 && source.maxLines <= 4 ? source.maxLines : null;
  if (maxLines === null) blockers.push("subtitles.maxLines");
  let maxCharsPerLine = 0;
  if (source.maxCharsPerLine !== undefined) {
    if (!Number.isInteger(source.maxCharsPerLine) || source.maxCharsPerLine < 4 || source.maxCharsPerLine > 80) blockers.push("subtitles.maxCharsPerLine");
    else maxCharsPerLine = source.maxCharsPerLine;
  }
  const sideMarginPx = Math.round((sideMarginRatio ?? 0) * width);
  const config = {
    burnIn: true,
    fontFile,
    fontSizeRatio: fontSizeRatio ?? 0,
    fontSizePx,
    textColor,
    outline,
    band,
    anchor: anchor || "bottom",
    baselineRatio: baselineRatio ?? 0,
    baselinePx: Math.round((baselineRatio ?? 0) * height),
    lineSpacingRatio,
    lineStepPx: Math.max(1, Math.round(lineSpacingRatio * fontSizePx)),
    sideMarginRatio: sideMarginRatio ?? 0,
    sideMarginPx,
    maxLineWidthPx: Math.max(1, width - 2 * sideMarginPx),
    maxLines: maxLines ?? 1,
    maxCharsPerLine,
    render: { width, height },
  };
  return { config, blockers: [...new Set(blockers)] };
}

async function regularFile(path) {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink() && info.size > 0;
  } catch {
    return false;
  }
}

/**
 * 行の縦の位置（基線）を、書体の上下の寸法から決める。drawtext の y は `基線 - ascent` で置くので、
 * 字の中身に依らず行の基線が揃う。
 */
export function subtitleLineBaselines(config, lineCount) {
  const count = Math.max(1, lineCount);
  return Array.from({ length: count }, (_, index) => (config.anchor === "top"
    ? config.baselinePx + index * config.lineStepPx
    : config.baselinePx - (count - 1 - index) * config.lineStepPx));
}

/**
 * Pack の書体を読み、字幕の配置が画面に収まるかを確かめる（有料生成の前）。
 * 返り値の metrics は行の幅を測るのに使う。
 */
export async function resolveNarratedSubtitleMedia(config, channelPackDir) {
  if (!config?.burnIn) return { media: {}, metrics: null, blockers: [] };
  const blockers = [];
  const fontPath = join(resolve(String(channelPackDir || "")), ...String(config.fontFile || "").split("/"));
  if (!config.fontFile || !await regularFile(fontPath)) return { media: {}, metrics: null, blockers: ["subtitles.fontFile-missing"] };
  let metrics;
  try {
    metrics = await loadFontMetrics(fontPath);
  } catch (error) {
    return { media: {}, metrics: null, blockers: [`subtitles.fontFile-unreadable:${String(error?.message || "").split(":")[0] || "font"}`] };
  }
  const { height } = config.render;
  const ascentPx = (metrics.ascender * config.fontSizePx) / metrics.unitsPerEm;
  const descentPx = (Math.abs(metrics.descender) * config.fontSizePx) / metrics.unitsPerEm;
  const border = config.outline?.widthPx || 0;
  const baselines = subtitleLineBaselines(config, config.maxLines);
  const top = Math.min(...baselines) - ascentPx - border;
  const bottom = Math.max(...baselines) + descentPx + border;
  const safe = SUBTITLE_VERTICAL_SAFE_RATIO * height;
  if (top < safe || bottom > height - safe) blockers.push("subtitles.position-outside-frame");
  // 帯を使うなら、字の行（最大行数のとき）が帯の上に載っていること。
  if (config.band && Math.min(...baselines) - ascentPx < config.band.topPx) blockers.push("subtitles.band.topRatio-below-text");
  return { media: { fontFile: fontPath }, metrics, blockers };
}

// ---- 改行（日本語の禁則と、書体の送り幅で測る行の幅） -------------------------------

/** 行頭に置かない字（閉じ括弧・句読点・小書きの仮名・長音・繰り返し記号・区切りの約物）。 */
const NO_LINE_START = new Set([..."、。，．,.:;：；!?！？‼⁇⁈⁉)）]］}｝〕〉》」』】〙〗〟’”'\"・ーゝゞヽヾ々〻ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻㇼㇽㇾㇿ‐゠–〜～…‥"]);
/** 行末に置かない字（開き括弧）。 */
const NO_LINE_END = new Set([..."(（[［{｛〔〈《「『【〘〖〝‘“"]);
/** 2つ続けて1つの記号になる字（間で割らない）。 */
const PAIRED_MARKS = new Set([..."…‥―—"]);
const TERMINAL = new Set([..."。！？!?‼⁇⁈⁉"]);
const COMMA = new Set([..."、，,"]);
const CLOSING = new Set([...")）]］}｝〕〉》」』】〙〗〟’”"]);
const HIRAGANA = /\p{Script=Hiragana}/u;
const KATAKANA = /[\p{Script=Katakana}ー]/u;
const HAN = /[\p{Script=Han}々〆〇]/u;
const WORD = /[A-Za-z0-9Ａ-Ｚａ-ｚ０-９]/u;

/**
 * i 文字目の後ろで改行してよいか、してよいならその費用（小さいほど良い）。null は禁止。
 * 規則はジャンル共通の日本語の組版: 句点の後ろ＞読点の後ろ＞閉じ括弧の後ろ＞仮名から漢字・片仮名への
 * 切り替わり（文節の頭）の順に良く、漢字の間・片仮名の間・漢字と送り仮名の間は悪い。
 */
export function lineBreakCost(characters, index) {
  const left = characters[index];
  const right = characters[index + 1];
  if (left === undefined || right === undefined) return null;
  if (NO_LINE_START.has(right) || NO_LINE_END.has(left)) return null;
  if (WORD.test(left) && WORD.test(right)) return null;
  if (PAIRED_MARKS.has(left) && PAIRED_MARKS.has(right)) return null;
  if (/[̀-゙゚ͯ︀-️]/u.test(right)) return null;
  if (TERMINAL.has(left)) return -3;
  if (COMMA.has(left)) return -2;
  if (CLOSING.has(left)) return -1.5;
  if (right === " " || right === "　" || left === " " || left === "　") return -1;
  if (HIRAGANA.test(left) && (HAN.test(right) || KATAKANA.test(right) || NO_LINE_END.has(right) || WORD.test(right))) return -1;
  if (HAN.test(left) && HAN.test(right)) return 2;
  if (KATAKANA.test(left) && KATAKANA.test(right)) return 2.5;
  if (HAN.test(left) && HIRAGANA.test(right)) return 1.5;
  return 0.5;
}

const SPACE = /^[ 　]$/u;

/**
 * 字の並びの幅を前計算した、行の寸法の物差し。行の両端の空白は数えない。
 * charWidth は1字の送り幅（px）、extraPx は行ごとに足す幅（縁の太さぶん）。
 */
function lineRuler(characters, { charWidth, extraPx = 0 }) {
  const prefix = new Float64Array(characters.length + 1);
  characters.forEach((character, index) => { prefix[index + 1] = prefix[index] + charWidth(character); });
  const measure = (from, to) => {
    let first = from;
    let last = to - 1;
    while (first <= last && SPACE.test(characters[first])) first += 1;
    while (last >= first && SPACE.test(characters[last])) last -= 1;
    if (first > last) return null;
    return { width: prefix[last + 1] - prefix[first] + extraPx, characters: last + 1 - first, text: characters.slice(first, last + 1).join("") };
  };
  return { measure };
}

/**
 * [from, to) の字を、幅と字数の上限の中で maxLines 行以内に割る（行の幅がそろうほど良い）。割れなければ null。
 * 改行の位置の探索は動的計画（字数 m、行数 L で O(L·m²)。幅は前計算の和で O(1)）。
 */
function layoutLines(characters, ruler, from, to, { maxWidthPx, maxLines, maxCharsPerLine }) {
  const fits = (start, end) => {
    const line = ruler.measure(start, end);
    if (!line) return null;
    if (maxCharsPerLine > 0 && line.characters > maxCharsPerLine) return null;
    return line.width <= maxWidthPx + 1e-6 ? line : null;
  };
  const whole = fits(from, to);
  if (whole) return [whole.text];
  const total = ruler.measure(from, to)?.width || 0;
  for (let lines = 2; lines <= maxLines; lines += 1) {
    const target = total / lines;
    // best[k]: from から end 字目までを k 行にした最小の費用と、直前の改行位置。
    const best = Array.from({ length: lines + 1 }, () => new Map());
    best[0].set(from, { cost: 0, from: -1 });
    for (let line = 1; line <= lines; line += 1) {
      for (let end = from + 1; end <= to; end += 1) {
        if (end < to && lineBreakCost(characters, end - 1) === null) continue;
        let chosen = null;
        for (const [start, previous] of best[line - 1]) {
          if (start >= end) continue;
          const measured = fits(start, end);
          if (!measured) continue;
          const imbalance = ((measured.width - target) / Math.max(1, maxWidthPx)) ** 2 * 40;
          const breakCost = end < to ? lineBreakCost(characters, end - 1) : 0;
          const cost = previous.cost + imbalance + breakCost;
          if (!chosen || cost < chosen.cost) chosen = { cost, from: start };
        }
        if (chosen) best[line].set(end, chosen);
      }
    }
    if (best[lines].has(to)) {
      const output = [];
      let end = to;
      for (let line = lines; line >= 1; line -= 1) {
        const entry = best[line].get(end);
        output.unshift(ruler.measure(entry.from, end).text);
        end = entry.from;
      }
      return output;
    }
  }
  return null;
}

/**
 * [from, to) を最少で何行に割れるか（改行してよい位置の中で、行に入るだけ詰める。この詰め方は行数を
 * 最少にする）。1字が1行より長いなど割れない、または limit 行を越えるなら Infinity。頁の切れ目の探索で使う。
 */
function minimumLines(characters, ruler, from, to, { maxWidthPx, maxCharsPerLine }, limit) {
  let lines = 0;
  let start = from;
  while (start < to) {
    let lastBreak = -1;
    for (let end = start + 1; end <= to; end += 1) {
      const line = ruler.measure(start, end);
      if (line && (line.width > maxWidthPx + 1e-6 || (maxCharsPerLine > 0 && line.characters > maxCharsPerLine))) break;
      if (end === to || lineBreakCost(characters, end - 1) !== null) lastBreak = end;
    }
    if (lastBreak <= start) return Infinity;
    lines += 1;
    if (lines > limit) return Infinity;
    start = lastBreak;
  }
  return lines;
}

/** 字数の重み（半角の英数字・記号は半分、空白は数えない）。頁に時間を配るときに使う。 */
export function subtitleWeight(text) {
  let weight = 0;
  for (const character of String(text ?? "")) {
    if (character === " " || character === "　") continue;
    weight += /[ -~｡-ﾟ]/u.test(character) ? 0.5 : 1;
  }
  return weight;
}

/**
 * 1つの文を、画面に収まる頁（それぞれ maxLines 行以内）に分ける。頁の切れ目は改行と同じ規則で選び、
 * 句点・読点の後ろを優先して頁の数をできるだけ少なくする。頁の中は行の幅がそろうように割る。
 * どうやっても収まらない（1つの語が1行より長い）ときは problems に理由を返す（有料生成の前に止める材料）。
 *
 * charWidth(character) は実際に描く書体の1字の送り幅（px）。extraPx は行の両端の縁の太さの和。
 */
export function layoutSubtitlePages(text, { charWidth, extraPx = 0, maxWidthPx, maxLines, maxCharsPerLine = 0 }) {
  const characters = [...String(text ?? "").replace(/[\r\n]+/gu, " ").trim()];
  if (characters.length === 0) return { pages: [], problems: ["subtitle-text-empty"] };
  const ruler = lineRuler(characters, { charWidth, extraPx });
  const limits = { maxWidthPx, maxLines, maxCharsPerLine };
  const count = characters.length;
  // best[j]: 先頭 j 字を頁に分けた最小の費用。頁の数を最優先し、切れ目の費用で並べる。
  const best = new Array(count + 1).fill(null);
  best[0] = { pages: 0, cost: 0, from: -1 };
  for (let end = 1; end <= count; end += 1) {
    if (end < count && lineBreakCost(characters, end - 1) === null) continue;
    for (let start = Math.max(0, end - MAX_PAGE_CHARACTERS); start < end; start += 1) {
      const previous = best[start];
      if (!previous) continue;
      const lines = minimumLines(characters, ruler, start, end, limits, maxLines);
      if (!Number.isFinite(lines)) continue;
      const cost = previous.cost + (end < count ? lineBreakCost(characters, end - 1) : 0) + lines * 0.25;
      const pages = previous.pages + 1;
      const current = best[end];
      if (!current || pages < current.pages || (pages === current.pages && cost < current.cost)) {
        best[end] = { pages, cost, from: start };
      }
    }
  }
  if (!best[count]) return { pages: [], problems: ["subtitle-line-too-wide"] };
  const bounds = [];
  let end = count;
  while (end > 0) {
    bounds.unshift([best[end].from, end]);
    end = best[end].from;
  }
  const pages = [];
  for (const [from, to] of bounds) {
    const lines = layoutLines(characters, ruler, from, to, limits);
    if (!lines) return { pages: [], problems: ["subtitle-line-too-wide"] };
    pages.push({ lines, weight: subtitleWeight(lines.join("")) });
  }
  return { pages, problems: [] };
}

/**
 * 台本の各文（segment）の字幕の頁を決め、Pack の書体に無い字を数える（有料生成の前の検査）。
 * issue の文字列には台本の字を入れない（コードポイントの数と segment id だけ）。
 */
export function layoutNarratedSubtitles({ segments = [], config, metrics }) {
  if (!config?.burnIn) return { bySegment: new Map(), issues: [] };
  const issues = [];
  const bySegment = new Map();
  const missing = new Set();
  const widths = new Map();
  const charWidth = (character) => {
    if (!widths.has(character)) widths.set(character, measureTextWidth(metrics, character, config.fontSizePx));
    return widths.get(character);
  };
  for (const segment of segments) {
    const text = String(segment.text ?? "");
    for (const character of missingGlyphs(metrics, text)) missing.add(character.codePointAt(0));
    const layout = layoutSubtitlePages(text, {
      charWidth,
      extraPx: 2 * (config.outline?.widthPx || 0),
      maxWidthPx: config.maxLineWidthPx,
      maxLines: config.maxLines,
      maxCharsPerLine: config.maxCharsPerLine,
    });
    if (layout.problems.length > 0) issues.push(...layout.problems.map((problem) => `${problem}:${segment.id}`));
    else bySegment.set(segment.id, layout.pages);
  }
  if (missing.size > 0) {
    const sample = [...missing].slice(0, 8).map((code) => `U+${code.toString(16).toUpperCase().padStart(4, "0")}`).join(",");
    issues.push(`subtitle-font-missing-glyphs:${missing.size}:${sample}`);
  }
  return { bySegment, issues };
}

/**
 * 時間の付いた文（番組のフレームで startFrame / frames）へ頁を置き、字幕の頁の時間割を作る。
 * 1つの文の頁は、その文の時間を字数の重みで分ける（累積で丸めるので合計がずれない）。
 */
export function planNarratedSubtitleCues({ timedSegments = [], pagesBySegment = new Map() }) {
  const cues = [];
  const problems = [];
  for (const segment of timedSegments) {
    const pages = pagesBySegment.get(segment.id) || [];
    if (pages.length === 0) {
      problems.push(`subtitle-pages-missing:${segment.id}`);
      continue;
    }
    if (segment.frames < pages.length) {
      problems.push(`subtitle-segment-too-short-for-pages:${segment.id}`);
      continue;
    }
    const total = pages.reduce((sum, page) => sum + Math.max(0.5, page.weight), 0);
    let cumulative = 0;
    let previousEnd = segment.startFrame;
    pages.forEach((page, index) => {
      cumulative += Math.max(0.5, page.weight);
      const end = index === pages.length - 1
        ? segment.startFrame + segment.frames
        : Math.max(previousEnd + 1, segment.startFrame + Math.round((segment.frames * cumulative) / total));
      cues.push({
        id: `${segment.id}.p${index + 1}`,
        segmentId: segment.id,
        page: index + 1,
        pageCount: pages.length,
        lines: page.lines,
        textHash: sha256(page.lines.join("\n")),
        startFrame: previousEnd,
        endFrame: end,
      });
      previousEnd = end;
    });
  }
  return { cues, problems };
}

// ---- 描画 -----------------------------------------------------------------

/** 1つの頁の PNG を描く filter（drawbox の帯と、行ごとの drawtext）。文言は textfile で渡す。 */
function cueFilter(config, textFiles, fontName) {
  const filters = [];
  if (config.band) {
    filters.push(`drawbox=x=0:y=${config.band.topPx}:w=iw:h=ih-${config.band.topPx}:color=${ffColor(config.band.color, config.band.opacity)}:t=fill:replace=1`);
  }
  const baselines = subtitleLineBaselines(config, textFiles.length);
  textFiles.forEach((file, index) => {
    const border = config.outline ? `:borderw=${config.outline.widthPx}:bordercolor=${ffColor(config.outline.color)}` : "";
    // expansion=none: 台本の % を書式として解釈させない。x は行ごとに中央。y は基線から書体の ascent を引く。
    filters.push(`drawtext=fontfile=${fontName}:textfile=${file}:expansion=none:fontsize=${config.fontSizePx}:fontcolor=${ffColor(config.textColor)}${border}:x=(w-text_w)/2:y=${baselines[index]}-ascent`);
  });
  return filters.join(",");
}

async function decodeRgba(ffmpeg, path, { width, height }) {
  const { stdout } = await runRuntime(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { encoding: "buffer" });
  if (stdout.length !== width * height * 4) throw new Error("subtitle cue image has an unexpected size");
  return stdout;
}

/**
 * 頁の PNG の画素を、字の芯・縁（または帯）・何も無いところに分ける。監査はこの分け方を MP4 の
 * 同じ画素に当てて測る。inkBox は不透明に近い字と縁が乗った範囲。
 */
export function classifyCueImage(rgba, { width, height }, config) {
  const text = rgbOf(config.textColor);
  const outline = config.outline ? rgbOf(config.outline.color) : null;
  const band = config.band ? rgbOf(config.band.color) : null;
  const bandAlpha = config.band ? Math.round(config.band.opacity * 255) : null;
  const near = (offset, color, tolerance) => Math.abs(rgba[offset] - color[0]) <= tolerance
    && Math.abs(rgba[offset + 1] - color[1]) <= tolerance
    && Math.abs(rgba[offset + 2] - color[2]) <= tolerance;
  const fill = new Uint8Array(width * height);
  const surround = new Uint8Array(width * height);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const offset = index * 4;
      const alpha = rgba[offset + 3];
      if (alpha >= 250 && near(offset, text, 12)) fill[index] = 1;
      else if (outline && alpha >= 250 && near(offset, outline, 12)) surround[index] = 1;
      if (alpha >= 250 && (fill[index] || surround[index])) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  // 芯は縁（字の輪郭）から 1px 内側だけにする（圧縮で輪郭の画素は揺れる）。十分に残らない小さな字は内側に寄せない。
  const eroded = new Uint8Array(width * height);
  let erodedCount = 0;
  let fillCount = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      if (!fill[index]) continue;
      fillCount += 1;
      if (fill[index - 1] && fill[index + 1] && fill[index - width] && fill[index + width]) {
        eroded[index] = 1;
        erodedCount += 1;
      }
    }
  }
  const core = erodedCount >= 40 ? eroded : fill;
  // 帯だけの字幕は、字の周り（inkBox の中）の帯の画素を比べる相手にする。
  if (!outline && band && maxX >= 0) {
    for (let y = Math.max(0, minY - 2); y <= Math.min(height - 1, maxY + 2); y += 1) {
      for (let x = Math.max(0, minX - 2); x <= Math.min(width - 1, maxX + 2); x += 1) {
        const index = y * width + x;
        const offset = index * 4;
        if (fill[index]) continue;
        let nearInk = false;
        for (let dy = -2; dy <= 2 && !nearInk; dy += 1) {
          for (let dx = -2; dx <= 2 && !nearInk; dx += 1) {
            const neighbor = (y + dy) * width + (x + dx);
            if (neighbor >= 0 && neighbor < fill.length && fill[neighbor]) nearInk = true;
          }
        }
        if (!nearInk && Math.abs(rgba[offset + 3] - bandAlpha) <= 3 && near(offset, band, 12)) surround[index] = 1;
      }
    }
  }
  const inkBox = maxX >= 0 ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null;
  return { core, fill, surround, inkBox, coreCount: core === eroded ? erodedCount : fillCount };
}

/**
 * 字幕の頁の PNG と、番組の時間どおりに重ねる concat の一覧を作る。書体は作業フォルダへ写し、
 * filter には相対名だけを書く（Windows の `C:` と filter の `:` がぶつからない。文言の escape も要らない）。
 */
export async function renderNarratedSubtitleOverlay({ ffmpeg, cues, config, fontPath, fps, totalFrames, workDir, concurrency = 4 }) {
  const { width, height } = config.render;
  await mkdir(workDir, { recursive: true });
  const fontName = `subtitle-font${extname(fontPath).toLowerCase() || ".ttf"}`;
  await copyFile(fontPath, join(workDir, fontName));
  const blank = "blank.png";
  await runRuntime(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=black@0.0:s=${width}x${height},format=rgba`, "-frames:v", "1", blank], { cwd: workDir });
  const rendered = await mapLimit(cues, concurrency, async (cue, index) => {
    const base = `cue-${String(index + 1).padStart(5, "0")}`;
    const textFiles = [];
    for (const [line, text] of cue.lines.entries()) {
      const file = `${base}-l${line + 1}.txt`;
      await writeFile(join(workDir, file), text, "utf8");
      textFiles.push(file);
    }
    const image = `${base}.png`;
    await runRuntime(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=black@0.0:s=${width}x${height},format=rgba`,
      "-vf", cueFilter(config, textFiles, fontName), "-frames:v", "1", image,
    ], { cwd: workDir });
    const bytes = await readFile(join(workDir, image));
    const classified = classifyCueImage(await decodeRgba(ffmpeg, join(workDir, image), { width, height }), { width, height }, config);
    return { ...cue, image, imagePath: join(workDir, image), imageSha256: sha256(bytes), inkBox: classified.inkBox, coreCount: classified.coreCount };
  });
  // concat の一覧。頁の切り替えは半フレーム前に置く（main のフレーム n は n/fps で、重ねる側は
  // その時点で最新のフレームを使う。境目を (n - 0.5)/fps にすると、丸めでフレームがずれない）。
  const boundary = (frame) => Math.max(0, (frame - 0.5) / fps);
  const events = [];
  let cursor = 0;
  for (const cue of [...rendered].sort((left, right) => left.startFrame - right.startFrame)) {
    if (cue.startFrame < cursor) throw new Error("subtitle cues overlap");
    if (cue.startFrame > cursor) events.push({ image: blank, start: cursor, end: cue.startFrame });
    events.push({ image: cue.image, start: cue.startFrame, end: cue.endFrame });
    cursor = cue.endFrame;
  }
  if (cursor < totalFrames) events.push({ image: blank, start: cursor, end: totalFrames });
  let list = "ffconcat version 1.0\n";
  for (const event of events) list += `file '${event.image}'\nduration ${(boundary(event.end) - boundary(event.start)).toFixed(6)}\n`;
  // 画像の concat は最後の duration を使わないので、最後の空白をもう一度置く。
  list += `file '${blank}'\n`;
  const listPath = join(workDir, "subtitles.ffconcat");
  await writeFile(listPath, list, "utf8");
  return {
    version: NARRATED_SUBTITLE_PLAN_VERSION,
    listPath,
    fontSha256: sha256(await readFile(fontPath)),
    cues: rendered,
    totalFrames,
    fps,
  };
}

/** 番組の組み立ての graph で、字幕を重ねる部分（入力 index の concat 一覧を、[input] の上に重ねて [output] にする）。 */
export function subtitleOverlayGraph({ inputIndex, input, output }) {
  return `[${inputIndex}:v]format=rgba[subtitlelayer];[${input}][subtitlelayer]overlay=x=0:y=0:eof_action=repeat:format=auto,format=yuv420p[${output}]`;
}

/**
 * 組み立ての graph が、N 本の concat で [video] を作っているか（焼き込み字幕があれば、concat の出力 [label] に
 * 字幕の層を overlay で1回だけ重ねて [video] にしているか）。場面の間の転換を足していないことの検査で使う。
 */
export function videoConcatAssembled(graph, { count, label }) {
  const text = String(graph || "");
  if (text.includes(`concat=n=${count}:v=1:a=0[video]`)) return !/subtitlelayer/u.test(text);
  const overlays = text.match(/\[subtitlelayer\]overlay=/gu) || [];
  return text.includes(`concat=n=${count}:v=1:a=0[${label}]`)
    && overlays.length === 1
    && text.includes(`[${label}][subtitlelayer]overlay=`)
    && /format=yuv420p\[video\]$/u.test(text);
}

/** generation manifest に残す字幕の記録（台本の字は残さない。頁の数・時刻・PNG の SHA だけ）。 */
export function narratedSubtitleManifestEntry(overlay, config) {
  if (!overlay) return { burnIn: false };
  return {
    version: overlay.version,
    burnIn: true,
    fontSha256: overlay.fontSha256,
    style: {
      fontSizePx: config.fontSizePx,
      outline: config.outline ? { widthPx: config.outline.widthPx } : null,
      band: config.band ? { topPx: config.band.topPx, opacity: config.band.opacity } : null,
      anchor: config.anchor,
      baselinePx: config.baselinePx,
      lineStepPx: config.lineStepPx,
      maxLines: config.maxLines,
      maxLineWidthPx: config.maxLineWidthPx,
    },
    cueCount: overlay.cues.length,
    cues: overlay.cues.map((cue) => ({
      id: cue.id,
      segmentId: cue.segmentId,
      page: cue.page,
      pageCount: cue.pageCount,
      lineCount: cue.lines.length,
      textHash: cue.textHash,
      startFrame: cue.startFrame,
      endFrame: cue.endFrame,
      imageSha256: cue.imageSha256,
      inkBox: cue.inkBox,
    })),
  };
}

// ---- 実測（完成 MP4） ---------------------------------------------------------

async function extractRgbCrop(ffmpeg, videoPath, frame, fps, box, count = 1) {
  const { stdout } = await runRuntime(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-ss", Math.max(0, (frame - 0.25) / fps).toFixed(6), "-i", videoPath,
    "-frames:v", String(count), "-vf", `crop=${box.width}:${box.height}:${box.x}:${box.y}`, "-pix_fmt", "rgb24", "-f", "rawvideo", "-",
  ], { encoding: "buffer" });
  const size = box.width * box.height * 3;
  const frames = [];
  for (let offset = 0; offset + size <= stdout.length; offset += size) frames.push(stdout.subarray(offset, offset + size));
  return frames;
}

function expandBox(box, margin, { width, height }) {
  const x = Math.max(0, box.x - margin);
  const y = Math.max(0, box.y - margin);
  const right = Math.min(width, box.x + box.width + margin);
  const bottom = Math.min(height, box.y + box.height + margin);
  // crop は偶数の寸法の方が 4:2:0 の変換で安全。
  const evenWidth = Math.max(2, (right - x) - ((right - x) % 2));
  const evenHeight = Math.max(2, (bottom - y) - ((bottom - y) % 2));
  return { x, y, width: evenWidth, height: evenHeight };
}

/**
 * MP4 の1フレーム（crop 済みの rgb24）に、頁の PNG の分け方を当てて測る（純粋関数）。
 * - fillMatch: 字の芯の画素のうち、MP4 の輝度が字の色の輝度に近い割合
 * - contrast: MP4 で測った字の芯の平均輝度と、縁（帯）の平均輝度の差
 */
export function measureCueFrame(frame, box, classified, frameSize, config) {
  const textLuma = lumaOf(rgbOf(config.textColor));
  let coreTotal = 0;
  let coreMatch = 0;
  let coreLuma = 0;
  let surroundTotal = 0;
  let surroundLuma = 0;
  for (let y = 0; y < box.height; y += 1) {
    for (let x = 0; x < box.width; x += 1) {
      const index = (box.y + y) * frameSize.width + (box.x + x);
      const offset = (y * box.width + x) * 3;
      const luma = lumaOf([frame[offset], frame[offset + 1], frame[offset + 2]]);
      if (classified.core[index]) {
        coreTotal += 1;
        coreLuma += luma;
        if (Math.abs(luma - textLuma) <= SUBTITLE_FILL_LUMA_TOLERANCE) coreMatch += 1;
      } else if (classified.surround[index]) {
        surroundTotal += 1;
        surroundLuma += luma;
      }
    }
  }
  const fillMatch = coreTotal ? coreMatch / coreTotal : 0;
  const contrast = coreTotal && surroundTotal ? Math.abs(coreLuma / coreTotal - surroundLuma / surroundTotal) : 0;
  return { fillMatch: Math.round(fillMatch * 1000) / 1000, contrast: Math.round(contrast * 10) / 10, corePixels: coreTotal, surroundPixels: surroundTotal };
}

/** 1つの頁の芯のうち、もう1つの頁の字（芯でない輪郭も含む）に重ならない画素だけの分け方。 */
function exclusiveCore(classified, other) {
  const core = new Uint8Array(classified.core.length);
  let count = 0;
  for (let index = 0; index < core.length; index += 1) {
    if (classified.core[index] && !other.fill[index] && !other.surround[index]) {
      core[index] = 1;
      count += 1;
    }
  }
  return { core, surround: new Uint8Array(core.length), count };
}

function unionBox(left, right) {
  if (!right) return left;
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  return { x, y, width: Math.max(left.x + left.width, right.x + right.width) - x, height: Math.max(left.y + left.height, right.y + right.height) - y };
}

/** 頁の切り替えを見分けるのに要る、頁だけにある字の芯の画素の最小数（これより少なければ同じ字面とみなす）。 */
const SWITCH_MIN_EXCLUSIVE_PIXELS = 12;

/**
 * 焼き込み字幕を完成 MP4 で測る。頁ごとに、始まりの前のフレームと始まりのフレーム（字幕の無い間へ
 * 続く頁は終わりのフレームも）を取り出し、頁の PNG の字の芯の位置に字の色が出ているか、縁・帯との
 * 明るさの差が読める幅か、前後のフレームでは出ていないかを見る。
 * 前の頁が間を空けずに続くときは、2つの頁の字面の違う画素（その頁にだけある字の芯）で切り替わりを見る
 * （「一文目」「二文目」のように字面が近い頁を、同じ字の重なりで取り違えない）。
 * 画面に収まることは、PNG の字の範囲（inkBox）が左右の安全な余白と上下の端から内側にあり、
 * その位置に MP4 の字が実在すること（fillMatch）で確かめる。
 */
export async function measureNarratedBurnedSubtitles({ ffmpeg, videoPath, overlay, config, fps, concurrency = 4 }) {
  const frameSize = config.render;
  const safeY = Math.floor(SUBTITLE_VERTICAL_SAFE_RATIO * frameSize.height);
  const cues = [...overlay.cues].sort((left, right) => left.startFrame - right.startFrame);
  const covered = new Set(cues.map((cue) => cue.startFrame));
  const classify = async (cue) => classifyCueImage(await decodeRgba(ffmpeg, cue.imagePath, frameSize), frameSize, config);
  const rows = await mapLimit(cues, concurrency, async (cue, index) => {
    const problems = [];
    if (sha256(await readFile(cue.imagePath)) !== cue.imageSha256) problems.push("cue-image-changed");
    const classified = await classify(cue);
    if (!classified.inkBox || classified.coreCount === 0) {
      return { id: cue.id, pass: false, problems: ["cue-image-has-no-text"] };
    }
    const ink = classified.inkBox;
    if (ink.x < config.sideMarginPx - 1 || ink.x + ink.width > frameSize.width - config.sideMarginPx + 1) problems.push("subtitle-outside-side-margin");
    if (ink.y < safeY || ink.y + ink.height > frameSize.height - safeY) problems.push("subtitle-outside-vertical-safe-area");
    if (cue.lines.length > config.maxLines) problems.push("subtitle-too-many-lines");
    const previousCue = cues[index - 1];
    const contiguous = previousCue && previousCue.endFrame === cue.startFrame && previousCue.imageSha256 !== cue.imageSha256
      ? previousCue
      : null;
    const previousClassified = contiguous ? await classify(contiguous) : null;
    const box = expandBox(unionBox(ink, previousClassified?.inkBox || null), 4, frameSize);
    const [previousImage, startImage] = cue.startFrame > 0
      ? await extractRgbCrop(ffmpeg, videoPath, cue.startFrame - 1, fps, box, 2)
      : [null, ...await extractRgbCrop(ffmpeg, videoPath, 0, fps, box, 1)];
    const atStart = startImage ? measureCueFrame(startImage, box, classified, frameSize, config) : null;
    if (!atStart) problems.push("start-frame-unavailable");
    else {
      if (atStart.fillMatch < SUBTITLE_FILL_MATCH_MIN) problems.push("subtitle-not-observed-at-start");
      if (atStart.contrast < SUBTITLE_MIN_LUMA_CONTRAST) problems.push("subtitle-contrast-too-low");
    }
    let previousFrameFillMatch = null;
    let switchMetrics = null;
    if (previousImage && previousClassified) {
      // 前の頁から間を空けずに切り替わる: 1つ前のフレームはまだ前の頁、始まりのフレームはこの頁。
      const mine = exclusiveCore(classified, previousClassified);
      const theirs = exclusiveCore(previousClassified, classified);
      if (mine.count >= SWITCH_MIN_EXCLUSIVE_PIXELS && theirs.count >= SWITCH_MIN_EXCLUSIVE_PIXELS) {
        const before = { mine: measureCueFrame(previousImage, box, mine, frameSize, config).fillMatch, theirs: measureCueFrame(previousImage, box, theirs, frameSize, config).fillMatch };
        const after = startImage
          ? { mine: measureCueFrame(startImage, box, mine, frameSize, config).fillMatch, theirs: measureCueFrame(startImage, box, theirs, frameSize, config).fillMatch }
          : null;
        switchMetrics = { exclusivePixels: mine.count, previousExclusivePixels: theirs.count, before, after };
        previousFrameFillMatch = before.mine;
        if (before.mine > SUBTITLE_ABSENT_MATCH_MAX || before.theirs < SUBTITLE_FILL_MATCH_MIN) problems.push("subtitle-appears-before-its-start");
        if (after && (after.mine < SUBTITLE_FILL_MATCH_MIN || after.theirs > SUBTITLE_ABSENT_MATCH_MAX)) problems.push("subtitle-switch-not-observed-at-start");
      } else {
        switchMetrics = { exclusivePixels: mine.count, previousExclusivePixels: theirs.count, indistinguishable: true };
      }
    } else if (previousImage) {
      // 前に字幕の無い間（lead-in など）か、同じ字面の頁: 1つ前のフレームにこの頁の字が出ていないこと。
      const sameAsPrevious = previousCue && previousCue.endFrame === cue.startFrame && previousCue.imageSha256 === cue.imageSha256;
      previousFrameFillMatch = measureCueFrame(previousImage, box, classified, frameSize, config).fillMatch;
      if (!sameAsPrevious && previousFrameFillMatch > SUBTITLE_ABSENT_MATCH_MAX) problems.push("subtitle-appears-before-its-start");
    }
    let afterEnd = null;
    if (!covered.has(cue.endFrame) && cue.endFrame < overlay.totalFrames) {
      const endBox = expandBox(ink, 4, frameSize);
      const [frame] = await extractRgbCrop(ffmpeg, videoPath, cue.endFrame, fps, endBox, 1);
      afterEnd = frame ? measureCueFrame(frame, endBox, classified, frameSize, config) : null;
      if (!afterEnd) problems.push("end-frame-unavailable");
      else if (afterEnd.fillMatch > SUBTITLE_ABSENT_MATCH_MAX) problems.push("subtitle-remains-after-its-end");
    }
    return {
      id: cue.id,
      segmentId: cue.segmentId,
      startFrame: cue.startFrame,
      endFrame: cue.endFrame,
      pass: problems.length === 0,
      problems,
      inkBox: ink,
      metrics: {
        fillMatch: atStart?.fillMatch ?? null,
        contrast: atStart?.contrast ?? null,
        previousFrameFillMatch,
        afterEndFillMatch: afterEnd?.fillMatch ?? null,
        corePixels: atStart?.corePixels ?? 0,
        ...(switchMetrics ? { switch: switchMetrics } : {}),
      },
    };
  });
  const failed = rows.filter((row) => !row.pass);
  return {
    version: NARRATED_SUBTITLE_PLAN_VERSION,
    pass: rows.length > 0 && failed.length === 0,
    cueCount: rows.length,
    failedCueIds: failed.map((row) => row.id),
    problems: [...new Set(failed.flatMap((row) => row.problems))],
    minimumFillMatch: rows.length ? Math.min(...rows.map((row) => row.metrics?.fillMatch ?? 0)) : null,
    minimumContrast: rows.length ? Math.min(...rows.map((row) => row.metrics?.contrast ?? 0)) : null,
    cues: rows,
  };
}
