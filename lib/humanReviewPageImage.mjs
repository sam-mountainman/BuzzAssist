/**
 * 人が目で確かめるための「ページ画像」を組む部品（途中の成果物の品質ループの verify-pages が使う）。
 *
 * 1枚の PNG に、画（とその拡大・承認済みの設定画）を、決まった大きさのタイルとして並べる。
 *   - タイルの画素は呼び出し側の renderTile（既定は ffmpeg。lib/harnessRuntimeResolver.mjs の固定版）が作る。
 *     ffmpeg は PNG / JPEG / WebP を同じに読み、切り抜きと拡大縮小（lanczos）をする。並べる・文字を書く・PNG に
 *     書くのはここ（node:zlib だけ。外部パッケージに依存しない）
 *   - 文字は書体ファイルを使わず、ここに持つ 5x7 の点の字形で描く。drawtext は freetype 付きの ffmpeg と書体ファイルが
 *     要り（lib/narratedStoryBookends.mjs の missingBookendFfmpegFilters）、端末ごとに書体の置き場が違う。ページの
 *     文字は番号と短い英字の見出しだけなので、点の字形で足りる（日本語の説明は端末に出す）
 *   - どのタイルをどこにどの大きさで置いたか（placements）を返す。記録に残して、見せた大きさを後から確かめられるようにする
 */

import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { deflate as deflateCallback } from "node:zlib";

import { getImageDimensionsFromBuffer } from "./imageDimensions.mjs";

const execFile = promisify(execFileCallback);
const deflate = promisify(deflateCallback);

/**
 * タイルの短い辺（px）。出典は運営の決まり「公開面の画像は全数を目で見る」と、縮小したサムネの一覧では猥褻な手の
 * 身ぶりや実在の意匠に似た形を見落とした事故（運営側の記録）。720 は YouTube の 720p の高さで、16:9 の画なら
 * 1280x720。2列に並べると 2576px 幅（余白込み 2624px）で、Retina の 13〜14 インチ（物理 2560〜3024px 幅）に
 * 縮めずに収まる。これより小さくすると、顔と手が本編の再生より小さく見える。
 */
export const REVIEW_PAGE_TILE_SHORT_SIDE = 720;
/** 並べる列の基準（16:9 のタイル 2 枚）。これより広いタイルはこの幅へ縮める（極端に横長の画だけ）。 */
export const REVIEW_PAGE_CONTENT_WIDTH = 2 * 1280 + 16;

const MARGIN = 24;
const GAP = 16;
const PAGE_HEADER_HEIGHT = 88;
const SECTION_HEADER_HEIGHT = 72;
const SECTION_GAP = 40;
const LABEL_HEIGHT = 52;

const COLORS = Object.freeze({
  background: [24, 24, 24],
  pageHeader: [48, 48, 48],
  sectionHeader: [72, 72, 72],
  white: [255, 255, 255],
  black: [0, 0, 0],
  full: [70, 70, 70],
  reference: [31, 78, 140],
  zoom: [240, 180, 0],
});
/** タイルの種類ごとの見出しの帯の色と文字の色。 */
export const REVIEW_PAGE_TILE_KINDS = Object.freeze({
  full: Object.freeze({ band: COLORS.full, text: COLORS.white }),
  reference: Object.freeze({ band: COLORS.reference, text: COLORS.white }),
  zoom: Object.freeze({ band: COLORS.zoom, text: COLORS.black }),
});

// 5x7 の点の字形（行ごとに 5 ビット、左が上位）。番号・英字の見出し・対象 id に使う字だけ。
const GLYPHS = Object.freeze({
  "0": [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e], "1": [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  "2": [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f], "3": [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  "4": [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02], "5": [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  "6": [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e], "7": [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  "8": [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e], "9": [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11], B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e], D: [0x1c, 0x12, 0x11, 0x11, 0x11, 0x12, 0x1c],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f], F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f], H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e], J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11], L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11], N: [0x11, 0x11, 0x19, 0x15, 0x13, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e], P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d], R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e], T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e], V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0a], X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x11, 0x0a, 0x04, 0x04, 0x04], Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  " ": [0, 0, 0, 0, 0, 0, 0], "-": [0, 0, 0, 0x1f, 0, 0, 0], _: [0, 0, 0, 0, 0, 0, 0x1f],
  ".": [0, 0, 0, 0, 0, 0x0c, 0x0c], ":": [0, 0x0c, 0x0c, 0, 0x0c, 0x0c, 0], "/": [0x01, 0x01, 0x02, 0x04, 0x08, 0x10, 0x10],
  "#": [0x0a, 0x0a, 0x1f, 0x0a, 0x1f, 0x0a, 0x0a], "(": [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
  ")": [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08], "[": [0x0e, 0x08, 0x08, 0x08, 0x08, 0x08, 0x0e],
  "]": [0x0e, 0x02, 0x02, 0x02, 0x02, 0x02, 0x0e], "+": [0, 0x04, 0x04, 0x1f, 0x04, 0x04, 0],
  "?": [0x0e, 0x11, 0x01, 0x02, 0x04, 0, 0x04],
});

/** 画を、短い辺が shortSide になる表示寸法にする（幅が maxWidth を超える極端に横長の画だけは幅へ縮める）。 */
export function reviewTileSize({ width, height }, { shortSide = REVIEW_PAGE_TILE_SHORT_SIDE, maxWidth = REVIEW_PAGE_CONTENT_WIDTH } = {}) {
  const w = Number(width);
  const h = Number(height);
  if (!(w > 0) || !(h > 0)) throw new Error("タイルの元の寸法が要ります。");
  let scale = shortSide / Math.min(w, h);
  if (w * scale > maxWidth) scale = maxWidth / w;
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

function fillRect(canvas, pageWidth, x, y, width, height, color) {
  const x0 = Math.max(0, Math.floor(x));
  const x1 = Math.min(pageWidth, Math.floor(x + width));
  if (x1 <= x0) return;
  const row = Buffer.alloc((x1 - x0) * 3);
  for (let i = 0; i < x1 - x0; i += 1) {
    row[i * 3] = color[0];
    row[i * 3 + 1] = color[1];
    row[i * 3 + 2] = color[2];
  }
  const pageHeight = canvas.length / (pageWidth * 3);
  for (let yy = Math.max(0, Math.floor(y)); yy < Math.min(pageHeight, Math.floor(y + height)); yy += 1) {
    row.copy(canvas, (yy * pageWidth + x0) * 3);
  }
}

/** 点の字形で文字を描く（右端で切る）。小文字は大文字で、字形の無い字は ? で描く。 */
export function drawReviewText(canvas, pageWidth, text, x, y, scale, color, { maxWidth = Infinity } = {}) {
  let cursor = x;
  const limit = Math.min(pageWidth, x + maxWidth);
  for (const char of String(text).toUpperCase()) {
    const glyph = GLYPHS[char] || GLYPHS["?"];
    if (cursor + 5 * scale > limit) break;
    for (let row = 0; row < 7; row += 1) {
      for (let column = 0; column < 5; column += 1) {
        if (glyph[row] & (0x10 >> column)) fillRect(canvas, pageWidth, cursor + column * scale, y + row * scale, scale, scale, color);
      }
    }
    cursor += 6 * scale;
  }
  return cursor;
}

/**
 * ページの配置を決める（画素はまだ作らない）。
 *   title: ページの見出し（英数字）
 *   sections: [{ header, rows: [[tile, ...], ...] }]  1つの section が1つの対象。rows の各行は新しい行から始め、
 *             幅に入りきらなければ折り返す
 *   tile: { id, kind: full|reference|zoom, label, width, height }（width・height は表示寸法）
 */
export function layoutReviewPage({ title = "", sections = [], contentWidth = REVIEW_PAGE_CONTENT_WIDTH } = {}) {
  const widest = Math.max(contentWidth, ...sections.flatMap((section) => section.rows.flat().map((tile) => tile.width)));
  const pageWidth = widest + 2 * MARGIN;
  const placements = [];
  const bands = [{ kind: "page-header", x: 0, y: 0, width: pageWidth, height: PAGE_HEADER_HEIGHT, text: title }];
  let y = PAGE_HEADER_HEIGHT + MARGIN;
  for (const section of sections) {
    bands.push({ kind: "section-header", x: MARGIN, y, width: widest, height: SECTION_HEADER_HEIGHT, text: section.header });
    y += SECTION_HEADER_HEIGHT + GAP;
    for (const row of section.rows) {
      let x = MARGIN;
      let rowHeight = 0;
      for (const tile of row) {
        if (x > MARGIN && x + tile.width > MARGIN + widest) {
          y += rowHeight + GAP;
          x = MARGIN;
          rowHeight = 0;
        }
        bands.push({ kind: `label-${tile.kind}`, tileKind: tile.kind, x, y, width: tile.width, height: LABEL_HEIGHT, text: tile.label });
        placements.push({ id: tile.id, kind: tile.kind, label: tile.label, x, y: y + LABEL_HEIGHT, width: tile.width, height: tile.height });
        x += tile.width + GAP;
        rowHeight = Math.max(rowHeight, LABEL_HEIGHT + tile.height);
      }
      if (row.length > 0) y += rowHeight + GAP;
    }
    y += SECTION_GAP;
  }
  return { width: pageWidth, height: y + MARGIN, placements, bands };
}

/**
 * ページの画素を作る。tilePixels は placements の id → rgb24 の画素（width*height*3 バイト）。
 * 返すのは rgb24 の画素（width*height*3）。
 */
export function paintReviewPage(layout, tilePixels) {
  const { width, height } = layout;
  const canvas = Buffer.alloc(width * height * 3);
  fillRect(canvas, width, 0, 0, width, height, COLORS.background);
  for (const band of layout.bands) {
    if (band.kind === "page-header") {
      fillRect(canvas, width, band.x, band.y, band.width, band.height, COLORS.pageHeader);
      drawReviewText(canvas, width, band.text, MARGIN, band.y + Math.round((band.height - 49) / 2), 7, COLORS.white);
    } else if (band.kind === "section-header") {
      fillRect(canvas, width, band.x, band.y, band.width, band.height, COLORS.sectionHeader);
      drawReviewText(canvas, width, band.text, band.x + 16, band.y + Math.round((band.height - 42) / 2), 6, COLORS.white, { maxWidth: band.width - 32 });
    } else {
      const style = REVIEW_PAGE_TILE_KINDS[band.tileKind] || REVIEW_PAGE_TILE_KINDS.full;
      fillRect(canvas, width, band.x, band.y, band.width, band.height, style.band);
      drawReviewText(canvas, width, band.text, band.x + 12, band.y + Math.round((band.height - 35) / 2), 5, style.text, { maxWidth: band.width - 24 });
    }
  }
  for (const placement of layout.placements) {
    const pixels = tilePixels.get(placement.id);
    const rowBytes = placement.width * 3;
    if (!Buffer.isBuffer(pixels) || pixels.length !== rowBytes * placement.height) {
      throw new Error(`タイル ${placement.label} の画素の大きさが違う（${placement.width}x${placement.height} の rgb24 が要る）`);
    }
    for (let row = 0; row < placement.height; row += 1) {
      pixels.copy(canvas, ((placement.y + row) * width + placement.x) * 3, row * rowBytes, (row + 1) * rowBytes);
    }
  }
  return canvas;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffers) {
  let crc = 0xffffffff;
  for (const buffer of buffers) {
    for (let index = 0; index < buffer.length; index += 1) crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32([typeBuffer, data]));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/** rgb24 の画素を PNG（8bit・RGB・非インターレース・行ごとに Paeth の予測）にする。 */
export async function encodeReviewPagePng({ width, height, rgb }, { level = 3 } = {}) {
  const stride = width * 3;
  if (!Buffer.isBuffer(rgb) || rgb.length !== stride * height) throw new Error("PNG にする画素の大きさが違う。");
  const filtered = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const out = y * (stride + 1);
    const at = y * stride;
    filtered[out] = 4;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= 3 ? rgb[at + x - 3] : 0;
      const up = y > 0 ? rgb[at - stride + x] : 0;
      const upLeft = y > 0 && x >= 3 ? rgb[at - stride + x - 3] : 0;
      const estimate = left + up - upLeft;
      const toLeft = Math.abs(estimate - left);
      const toUp = Math.abs(estimate - up);
      const toUpLeft = Math.abs(estimate - upLeft);
      const predictor = toLeft <= toUp && toLeft <= toUpLeft ? left : (toUp <= toUpLeft ? up : upLeft);
      filtered[out + 1 + x] = (rgb[at + x] - predictor) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", await deflate(filtered, { level })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * ffmpeg でタイルの画素を作る renderTile。入力の画（PNG / JPEG / WebP）を rgb24 にしてから切り抜き（crop は元の画の
 * px）、表示寸法へ lanczos で拡大縮小し、rgb24 の生の画素を標準出力で受け取る。ファイルは書かない。
 */
export function ffmpegReviewTileRenderer(ffmpeg, { run = execFile } = {}) {
  if (!ffmpeg?.command) throw new Error("ffmpeg が要ります（setup で入れるか、BUZZASSIST_FFMPEG で指す）。");
  return async ({ source, crop = null, width, height }) => {
    const filters = ["format=rgb24"];
    if (crop) filters.push(`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`);
    filters.push(`scale=${width}:${height}:flags=lanczos`, "format=rgb24");
    const expected = width * height * 3;
    const { stdout } = await run(ffmpeg.command, [
      ...(ffmpeg.args || []), "-hide_banner", "-loglevel", "error", "-i", source,
      "-vf", filters.join(","), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
    ], { encoding: "buffer", maxBuffer: expected + 1024 * 1024, timeout: 120_000, windowsHide: true });
    const pixels = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || "");
    if (pixels.length !== expected) throw new Error(`ffmpeg のタイルの画素の大きさが違う（${pixels.length} バイト、${expected} バイトが要る）`);
    return pixels;
  };
}

/**
 * 画の寸法。見出し（PNG / JPEG / WebP の VP8X）から読み、読めなければ ffprobe に聞く（VP8・VP8L の WebP など）。
 */
export async function readReviewImageDimensions(file, { ffprobe = null, run = execFile } = {}) {
  try {
    return getImageDimensionsFromBuffer(await readFile(file), file);
  } catch (error) {
    if (!ffprobe?.command) throw error;
  }
  const { stdout } = await run(ffprobe.command, [
    ...(ffprobe.args || []), "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", file,
  ], { timeout: 60_000, windowsHide: true });
  const stream = JSON.parse(String(stdout || "{}"))?.streams?.[0] || {};
  const width = Number(stream.width);
  const height = Number(stream.height);
  if (!(width > 0) || !(height > 0)) throw new Error(`画の寸法を読めない: ${file}`);
  return { width, height };
}
