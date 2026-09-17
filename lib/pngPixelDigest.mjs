// PNG を画素へ戻して比べるための最小デコーダ。
//
// なぜ要るか:
// 機械レビューの切り抜き PNG は Python（PIL）が書く。同じ画素でも、PIL や
// zlib の版・圧縮設定が違えばファイルのバイト列は変わる。ファイル SHA-256 で
// 「同じ切り抜きか」を決めていたので、画素が1つも違わない切り抜きが
// 「再切り抜きと一致しない」として落ち、登録済みキャラの大半が監査を
// 通れなくなっていた。
//
// ここでは「同じ画素か」だけを決める。ファイル SHA-256 は出所の証跡として
// 呼び出し側が引き続き記録・照合する。
//
// 依存を増やさないため node:zlib だけで書く。対応は 8bit・非インターレースの
// グレー / RGB / パレット / グレー+α / RGBA。それ以外は例外にし、呼び出し側は
// 画素比較を諦めてファイル一致だけで判定する（黙って一致扱いにしない）。

import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

export const PNG_PIXEL_DIGEST_VERSION = "png-pixels-v1";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PIXELS = 64_000_000;
const SOURCE_CHANNELS = Object.freeze({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 });

export class UnsupportedPngError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnsupportedPngError";
  }
}

function readChunks(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new UnsupportedPngError("not a PNG file");
  }
  const chunks = [];
  let offset = PNG_SIGNATURE.length;
  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) throw new UnsupportedPngError("truncated PNG chunk header");
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > buffer.length) throw new UnsupportedPngError(`truncated PNG ${type} chunk`);
    chunks.push({ type, data: buffer.subarray(offset + 8, offset + 8 + length) });
    offset = end;
    if (type === "IEND") break;
  }
  if (chunks.at(-1)?.type !== "IEND") throw new UnsupportedPngError("PNG has no IEND chunk");
  return chunks;
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

function unfilter(inflated, width, height, bytesPerPixel) {
  const stride = width * bytesPerPixel;
  const output = Buffer.alloc(stride * height);
  for (let row = 0; row < height; row += 1) {
    const filterType = inflated[row * (stride + 1)];
    const source = row * (stride + 1) + 1;
    const target = row * stride;
    const previous = target - stride;
    for (let index = 0; index < stride; index += 1) {
      const raw = inflated[source + index];
      const left = index >= bytesPerPixel ? output[target + index - bytesPerPixel] : 0;
      const up = row > 0 ? output[previous + index] : 0;
      const upLeft = row > 0 && index >= bytesPerPixel ? output[previous + index - bytesPerPixel] : 0;
      let value;
      if (filterType === 0) value = raw;
      else if (filterType === 1) value = raw + left;
      else if (filterType === 2) value = raw + up;
      else if (filterType === 3) value = raw + ((left + up) >> 1);
      else if (filterType === 4) value = raw + paeth(left, up, upLeft);
      else throw new UnsupportedPngError(`unknown PNG filter type ${filterType}`);
      output[target + index] = value & 0xff;
    }
  }
  return output;
}

/**
 * PNG を RGB か RGBA の生バイト列へ戻す。グレーは RGB へ、パレットは
 * RGB（tRNS があれば RGBA）へ展開するので、同じ見た目の画素は同じ並びになる。
 */
export function decodePngPixels(buffer) {
  const chunks = readChunks(buffer);
  const header = chunks[0];
  if (header?.type !== "IHDR" || header.data.length !== 13) throw new UnsupportedPngError("PNG must start with IHDR");
  const width = header.data.readUInt32BE(0);
  const height = header.data.readUInt32BE(4);
  const [bitDepth, colorType, compression, filterMethod, interlace] = header.data.subarray(8, 13);
  if (!(width > 0 && height > 0) || width * height > MAX_PIXELS) throw new UnsupportedPngError(`unsupported PNG size ${width}x${height}`);
  if (bitDepth !== 8) throw new UnsupportedPngError(`unsupported PNG bit depth ${bitDepth}`);
  if (!Object.hasOwn(SOURCE_CHANNELS, colorType)) throw new UnsupportedPngError(`unsupported PNG color type ${colorType}`);
  if (compression !== 0 || filterMethod !== 0) throw new UnsupportedPngError("unsupported PNG compression or filter method");
  if (interlace !== 0) throw new UnsupportedPngError("interlaced PNG is not supported");
  const palette = chunks.find((chunk) => chunk.type === "PLTE")?.data || null;
  const transparency = chunks.find((chunk) => chunk.type === "tRNS")?.data || null;
  if (colorType === 3 && (!palette || palette.length % 3 !== 0 || palette.length === 0)) {
    throw new UnsupportedPngError("palette PNG has no valid PLTE chunk");
  }
  if (transparency && colorType !== 3) throw new UnsupportedPngError("colour-key transparency is not supported");

  const sourceChannels = SOURCE_CHANNELS[colorType];
  const expectedLength = height * (width * sourceChannels + 1);
  const compressed = Buffer.concat(chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data));
  if (compressed.length === 0) throw new UnsupportedPngError("PNG has no IDAT data");
  let inflated;
  try {
    inflated = inflateSync(compressed, { maxOutputLength: expectedLength });
  } catch (error) {
    throw new UnsupportedPngError(`PNG image data cannot be inflated (${error.message})`);
  }
  if (inflated.length !== expectedLength) {
    throw new UnsupportedPngError(`PNG image data has ${inflated.length} bytes, expected ${expectedLength}`);
  }
  const raw = unfilter(inflated, width, height, sourceChannels);
  const pixels = width * height;

  if (colorType === 2) return { width, height, channels: "RGB", data: raw };
  if (colorType === 6) return { width, height, channels: "RGBA", data: raw };
  if (colorType === 0) {
    const data = Buffer.alloc(pixels * 3);
    for (let index = 0; index < pixels; index += 1) data.fill(raw[index], index * 3, index * 3 + 3);
    return { width, height, channels: "RGB", data };
  }
  if (colorType === 4) {
    const data = Buffer.alloc(pixels * 4);
    for (let index = 0; index < pixels; index += 1) {
      const gray = raw[index * 2];
      data[index * 4] = gray;
      data[index * 4 + 1] = gray;
      data[index * 4 + 2] = gray;
      data[index * 4 + 3] = raw[index * 2 + 1];
    }
    return { width, height, channels: "RGBA", data };
  }
  // colorType === 3
  const entries = palette.length / 3;
  const withAlpha = Boolean(transparency);
  const channels = withAlpha ? 4 : 3;
  const data = Buffer.alloc(pixels * channels);
  for (let index = 0; index < pixels; index += 1) {
    const entry = raw[index];
    if (entry >= entries) throw new UnsupportedPngError(`palette index ${entry} is outside PLTE`);
    const target = index * channels;
    data[target] = palette[entry * 3];
    data[target + 1] = palette[entry * 3 + 1];
    data[target + 2] = palette[entry * 3 + 2];
    if (withAlpha) data[target + 3] = entry < transparency.length ? transparency[entry] : 255;
  }
  return { width, height, channels: withAlpha ? "RGBA" : "RGB", data };
}

/**
 * 画素だけで決まる SHA-256。寸法・チャンネル並び・生バイト列を含み、
 * PNG の圧縮レベルやフィルタ、付随チャンクには左右されない。
 */
export function pngPixelSha256(buffer) {
  const { width, height, channels, data } = decodePngPixels(buffer);
  return createHash("sha256")
    .update(`${PNG_PIXEL_DIGEST_VERSION}\n${width}x${height}\n${channels}\n`)
    .update(data)
    .digest("hex");
}
