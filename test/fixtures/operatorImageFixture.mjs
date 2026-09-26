/**
 * 運営者の画の取り込み（lib/operatorImageImport.mjs）の合成 fixture。外部素材もネットワークも使わず、
 * 小さな PNG を JS だけで作り、取り込みの記録（manifest）とプロンプトのファイルを並べる。
 * 人名・チャンネル名・会話の URL は合成（.invalid ドメイン）。
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";

import { OPERATOR_IMAGE_MANIFEST_VERSION } from "../../lib/operatorImageImport.mjs";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * 横と縦のグラデーションの PNG（RGB 8bit）。カメラのズームとパンでフレームが変わるように一様な色にしない。
 * seed を変えると別の画（別の sha256）になる。
 */
export function makeGradientPng(width, height, seed = 0) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = y * stride + 1 + x * 3;
      raw[offset] = Math.floor((x * 255) / Math.max(1, width - 1));
      raw[offset + 1] = Math.floor((y * 255) / Math.max(1, height - 1));
      raw[offset + 2] = ((x >> 3) + (y >> 3) + seed * 37) % 2 === 0 ? (seed * 53) % 256 : 255 - ((seed * 53) % 256);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 合成の「承認済みの設定画」（中身は何でもよい。sha256 だけを照合に使う）。 */
export const FIXTURE_REFERENCE_SHEET = makeGradientPng(24, 32, 91);
export const FIXTURE_REFERENCE_SHA256 = sha256(FIXTURE_REFERENCE_SHEET);
/** 合成の会話の URL（公開面に出てはいけない文字列の見本）。 */
export const fixtureConversationUrl = (sceneId) => `https://chat.example.invalid/c/fixture-conversation-${sceneId}-0001`;

async function put(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

/**
 * 取り込みの記録と、それが指す画・プロンプトを folder に書く。
 * scenes: [{ sceneId, width, height, seed?, bytes?, route?, reuseOf?, reuseReason?, referenceSha256s?, conversationUrl?,
 *   cameraFocus?, ... }]
 * bytes は用意済みの PNG（width・height はその寸法を書く）。無ければグラデーションの PNG を作る。
 * 返り値の manifest を書き換えて writeManifest で書き直せる。
 */
export async function writeOperatorImageFolder(folder, scenes, { generatedAt = "2026-09-20T10:00:00+09:00" } = {}) {
  const images = new Map();
  const entries = [];
  for (const scene of scenes) {
    const imageRel = `images/${scene.sceneId}.png`;
    let bytes;
    if (scene.reuseOf) bytes = images.get(scene.reuseOf);
    else if (scene.bytes) bytes = scene.bytes;
    else bytes = makeGradientPng(scene.width, scene.height, scene.seed ?? entries.length + 1);
    images.set(scene.sceneId, bytes);
    await put(join(folder, ...imageRel.split("/")), bytes);
    const promptRel = `prompts/${scene.sceneId}.txt`;
    const prompt = Buffer.from(`fixture prompt for ${scene.sceneId}: a quiet street at dusk, soft light, no text\n`, "utf8");
    await put(join(folder, ...promptRel.split("/")), prompt);
    const route = scene.route || "chatgpt-web";
    entries.push({
      sceneId: scene.sceneId,
      image: { path: imageRel, sha256: sha256(bytes), width: scene.width, height: scene.height },
      route,
      ...(route === "other" ? { routeNote: "fixture route note" } : {}),
      modelLabel: scene.modelLabel || "fixture image model",
      prompt: { path: promptRel, sha256: sha256(prompt) },
      referenceSha256s: scene.referenceSha256s ?? [FIXTURE_REFERENCE_SHA256],
      generatedAt,
      ...(scene.conversationUrl === null ? {} : { conversationUrl: scene.conversationUrl || fixtureConversationUrl(scene.sceneId) }),
      ...(scene.reuseReason ? { reuseReason: scene.reuseReason } : {}),
      ...(scene.cameraFocus !== undefined ? { cameraFocus: scene.cameraFocus } : {}),
    });
  }
  const manifest = { version: OPERATOR_IMAGE_MANIFEST_VERSION, scenes: entries };
  const manifestPath = join(folder, "operator-images.json");
  await writeManifest(manifestPath, manifest);
  return { manifestPath, manifest, images };
}

export async function writeManifest(manifestPath, manifest) {
  await put(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));
}

/** 画だけを差し替える（manifest の sha256 はそのまま）。差し替えた画の bytes を返す。 */
export async function replaceImage(folder, sceneId, width, height, seed) {
  const bytes = makeGradientPng(width, height, seed);
  await put(join(folder, "images", `${sceneId}.png`), bytes);
  return bytes;
}
