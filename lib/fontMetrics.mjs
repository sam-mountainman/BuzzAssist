/**
 * フォントファイル（TrueType / OpenType / TrueType Collection）から、字幕の組版に要る最小限の値を読む
 * （共有層。ジャンルに依存しない）。
 *
 * 読むのは次だけ:
 *   - cmap（文字 → グリフ）: 台本の字がフォントに有るか。無い字は FFmpeg の drawtext が .notdef の箱
 *     （いわゆる豆腐）で描くので、描いてから気づくのでは遅い。有料生成の前に止めるために使う
 *   - hmtx / hhea / head: グリフの送り幅と em の大きさ。字幕の1行の幅を、実際に描くフォントの
 *     送り幅で測る（字数で数えると、全角と半角・約物の幅の違いで行が画面からはみ出す）
 *
 * カーニングや合字は見ない（日本語の字幕の行幅にはほぼ効かない）。TTC は先頭の書体（face 0）を読む。
 * FFmpeg の drawtext も fontfile の face 0 を使うので、測る書体と描く書体が同じになる。
 */

import { readFile } from "node:fs/promises";

export const FONT_METRICS_VERSION = "buzzassist-font-metrics-v1";

const MAX_FONT_BYTES = 64 * 1024 * 1024;

function tagAt(view, offset) {
  return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
}

function tableDirectory(view, base) {
  const version = view.getUint32(base);
  const tag = tagAt(view, base);
  if (version !== 0x00010000 && tag !== "OTTO" && tag !== "true") throw new Error("font-unsupported:sfnt-version");
  const count = view.getUint16(base + 4);
  const tables = new Map();
  for (let index = 0; index < count; index += 1) {
    const record = base + 12 + index * 16;
    const offset = view.getUint32(record + 8);
    const length = view.getUint32(record + 12);
    if (offset + length > view.byteLength) throw new Error("font-invalid:table-out-of-range");
    tables.set(tagAt(view, record), { offset, length });
  }
  return tables;
}

function requireTable(tables, tag) {
  const table = tables.get(tag);
  if (!table) throw new Error(`font-invalid:${tag.trim()}-missing`);
  return table;
}

/** cmap の format 4（BMP）を、文字 → グリフ の関数にする。 */
function format4(view, offset) {
  const segCount = view.getUint16(offset + 6) / 2;
  const endBase = offset + 14;
  const startBase = endBase + segCount * 2 + 2;
  const deltaBase = startBase + segCount * 2;
  const rangeBase = deltaBase + segCount * 2;
  return (codePoint) => {
    if (codePoint > 0xffff) return 0;
    let low = 0;
    let high = segCount - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const end = view.getUint16(endBase + middle * 2);
      if (end < codePoint) low = middle + 1;
      else high = middle - 1;
    }
    if (low >= segCount) return 0;
    const start = view.getUint16(startBase + low * 2);
    if (start > codePoint) return 0;
    const delta = view.getInt16(deltaBase + low * 2);
    const rangeOffset = view.getUint16(rangeBase + low * 2);
    if (rangeOffset === 0) return (codePoint + delta) & 0xffff;
    const glyphAddress = rangeBase + low * 2 + rangeOffset + (codePoint - start) * 2;
    if (glyphAddress + 2 > view.byteLength) return 0;
    const glyph = view.getUint16(glyphAddress);
    return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
  };
}

/** cmap の format 12（全 Unicode）。 */
function format12(view, offset) {
  const groups = view.getUint32(offset + 12);
  const base = offset + 16;
  return (codePoint) => {
    let low = 0;
    let high = groups - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const record = base + middle * 12;
      const start = view.getUint32(record);
      const end = view.getUint32(record + 4);
      if (codePoint < start) high = middle - 1;
      else if (codePoint > end) low = middle + 1;
      else return view.getUint32(record + 8) + (codePoint - start);
    }
    return 0;
  };
}

function cmapLookup(view, cmap) {
  const count = view.getUint16(cmap.offset + 2);
  const candidates = [];
  for (let index = 0; index < count; index += 1) {
    const record = cmap.offset + 4 + index * 8;
    const platform = view.getUint16(record);
    const encoding = view.getUint16(record + 2);
    const subtable = cmap.offset + view.getUint32(record + 4);
    const format = view.getUint16(subtable);
    // Unicode の表だけを使う（Windows Unicode BMP / full、Unicode platform）。
    const unicode = (platform === 3 && (encoding === 1 || encoding === 10)) || platform === 0;
    if (!unicode || (format !== 4 && format !== 12)) continue;
    candidates.push({ format, subtable });
  }
  const full = candidates.find((entry) => entry.format === 12);
  const bmp = candidates.find((entry) => entry.format === 4);
  if (!full && !bmp) throw new Error("font-unsupported:no-unicode-cmap");
  const primary = full ? format12(view, full.subtable) : null;
  const fallback = bmp ? format4(view, bmp.subtable) : null;
  return (codePoint) => (primary ? primary(codePoint) : 0) || (fallback ? fallback(codePoint) : 0);
}

/**
 * フォントの寸法を読む。path か Buffer を受ける。読めない・対応しない形式は例外（理由コードつき）。
 */
export async function loadFontMetrics(source) {
  const bytes = Buffer.isBuffer(source) ? source : await readFile(String(source));
  if (bytes.length < 12 || bytes.length > MAX_FONT_BYTES) throw new Error("font-invalid:size");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let base = 0;
  let collection = false;
  if (tagAt(view, 0) === "ttcf") {
    const fonts = view.getUint32(8);
    if (fonts < 1) throw new Error("font-invalid:empty-collection");
    base = view.getUint32(12);
    collection = true;
  }
  const tables = tableDirectory(view, base);
  const head = requireTable(tables, "head");
  const hhea = requireTable(tables, "hhea");
  const hmtx = requireTable(tables, "hmtx");
  const maxp = requireTable(tables, "maxp");
  const unitsPerEm = view.getUint16(head.offset + 18);
  if (!(unitsPerEm >= 16 && unitsPerEm <= 16_384)) throw new Error("font-invalid:units-per-em");
  const ascender = view.getInt16(hhea.offset + 4);
  const descender = view.getInt16(hhea.offset + 6);
  const lineGap = view.getInt16(hhea.offset + 8);
  const metricCount = view.getUint16(hhea.offset + 34);
  const glyphCount = view.getUint16(maxp.offset + 4);
  if (metricCount < 1 || hmtx.length < metricCount * 4) throw new Error("font-invalid:hmtx");
  const glyphFor = cmapLookup(view, requireTable(tables, "cmap"));
  const advanceOfGlyph = (glyph) => {
    const index = Math.min(glyph, metricCount - 1);
    return view.getUint16(hmtx.offset + index * 4);
  };
  return {
    version: FONT_METRICS_VERSION,
    collection,
    unitsPerEm,
    ascender,
    descender,
    lineGap,
    glyphCount,
    glyphFor(codePoint) {
      const glyph = glyphFor(codePoint);
      return glyph > 0 && glyph < glyphCount ? glyph : 0;
    },
    /** 送り幅（フォント単位）。グリフが無い字は null。 */
    advanceFor(codePoint) {
      const glyph = this.glyphFor(codePoint);
      return glyph ? advanceOfGlyph(glyph) : null;
    },
  };
}

/** 字幕に描かない（幅を持たない）制御文字。改行はここに来る前に取り除いてある。 */
const INVISIBLE = /[​-‍⁠﻿]/u;

/** フォントに無い字（重複なし・出てきた順）。空白と見えない制御文字は数えない。 */
export function missingGlyphs(metrics, text) {
  const missing = [];
  const seen = new Set();
  for (const character of String(text ?? "")) {
    if (character === " " || character === "　" || INVISIBLE.test(character) || seen.has(character)) continue;
    seen.add(character);
    if (!metrics.glyphFor(character.codePointAt(0))) missing.push(character);
  }
  return missing;
}

/**
 * 1行の幅（px）。送り幅の和を fontSize / unitsPerEm で px にする。無い字は全角（1em）として数える
 * （無い字は有料生成の前に止めるので、ここは幅の見積りが途切れないためだけの置き方）。
 */
export function measureTextWidth(metrics, text, fontSizePx) {
  let units = 0;
  for (const character of String(text ?? "")) {
    if (INVISIBLE.test(character)) continue;
    const advance = metrics.advanceFor(character.codePointAt(0));
    units += advance === null ? metrics.unitsPerEm : advance;
  }
  return (units * Number(fontSizePx)) / metrics.unitsPerEm;
}
