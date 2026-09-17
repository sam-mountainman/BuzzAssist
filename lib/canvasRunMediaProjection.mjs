// Canvas Harness Runの成果物を、カードだけでなく実際に操作できるmediaへ投影する。
// source pathはCanvas JSONへ残さず、SHA検証済みbytesをcontent-addressed assetへ複製する。

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, open, readFile, rm } from "node:fs/promises";

import { renameWithRetry } from "./atomicJsonFile.mjs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { generateKeyBetween } from "fractional-indexing";

import { withCanvasFileLock } from "./canvasFileLock.mjs";
import { buildCanvasRunProjection } from "./canvasRunProjection.mjs";
import {
  ASSETS_ROUTE,
  getImageDimensionsFromBuffer,
  normalizeScene,
  readJsonIfExists,
  resolveCanvasDir,
  resolveCanvasFile,
  writeJsonAtomic,
} from "./canvasScene.mjs";
import {
  canonicalJson,
  canvasRunFingerprint,
  normalizeCanvasRun,
  resolveCanvasRunStateFile,
  sha256Hex,
  stableCanvasRunId,
} from "./canvasRunState.mjs";

export const CANVAS_RUN_MEDIA_PROJECTION_VERSION = 1;
export const CANVAS_RUN_MEDIA_TAG = "buzzassist.harnessRunMedia.v1";

const PROJECTABLE_STATUSES = new Set(["complete", "approved"]);
const IMAGE_KINDS = new Set(["image-candidate", "image-selected", "image-reference", "contact-sheet"]);
const VIDEO_KINDS = new Set(["preview-mp4", "final-mp4"]);
const AUDIO_KINDS = new Set(["audio", "bgm"]);
const MAX_PREFIX_BYTES = 1024 * 1024;
const PREPARED_MEDIA_ASSETS = Symbol("buzzassist.preparedCanvasRunMediaAssets");

const IMAGE_FORMATS = new Map([
  [".apng", "image/apng"],
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);
const AUDIO_FORMATS = new Map([
  [".aac", "audio/aac"],
  [".flac", "audio/flac"],
  [".m4a", "audio/mp4"],
  [".mp3", "audio/mpeg"],
  [".ogg", "audio/ogg"],
  [".opus", "audio/opus"],
  [".wav", "audio/wav"],
]);

export class CanvasRunMediaProjectionError extends Error {
  constructor(message, code = "CANVAS_RUN_MEDIA_INVALID") {
    super(message);
    this.name = "CanvasRunMediaProjectionError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new CanvasRunMediaProjectionError(message, code);
}

function digestOf(value) {
  const digest = String(value || "").replace(/^sha256:/iu, "").toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(digest)) fail("media artifactに有効なSHA-256が無い。", "CANVAS_RUN_MEDIA_SHA_INVALID");
  return digest;
}

function timestampForRun(run) {
  const value = run.updatedAt ? Date.parse(run.updatedAt) : Number.NaN;
  return Number.isFinite(value) ? value : run.revision;
}

function deterministicInteger(seed, offset = 0) {
  return Number.parseInt(sha256Hex(`${seed}:${offset}`).slice(0, 8), 16) & 0x7fffffff;
}

function xmlEscape(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function previewDataUrl({ kind, title, digest }) {
  const label = xmlEscape(String(title || kind).slice(0, 42));
  const hash = xmlEscape(digest.slice(0, 12));
  const video = kind === "video";
  const icon = video
    ? '<path d="M132 58v64l58-32z" fill="#7048b8"/>'
    : '<g fill="#7048b8"><rect x="84" y="74" width="8" height="32" rx="4"/><rect x="104" y="58" width="8" height="64" rx="4"/><rect x="124" y="68" width="8" height="44" rx="4"/><rect x="144" y="50" width="8" height="80" rx="4"/><rect x="164" y="72" width="8" height="36" rx="4"/></g>';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><rect width="320" height="180" rx="18" fill="#fff"/><rect x="20" y="20" width="200" height="120" rx="18" fill="#e8ddf5"/>${icon}<text x="232" y="58" font-family="Arial,sans-serif" font-size="14" font-weight="700" fill="#1f2937">${video ? "VIDEO" : "AUDIO"}</text><text x="232" y="84" font-family="Arial,sans-serif" font-size="10" fill="#6b7280">${hash}</text><text x="20" y="164" font-family="Arial,sans-serif" font-size="12" fill="#374151">${label}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function mediaKind(artifact) {
  if (IMAGE_KINDS.has(artifact.kind)) return "image";
  if (VIDEO_KINDS.has(artifact.kind)) return "video";
  if (AUDIO_KINDS.has(artifact.kind)) return "audio";
  if (artifact.kind === "subtitle") return "subtitle";
  return null;
}

function artifactFormat(artifact, kind, sourcePath) {
  const extension = extname(sourcePath).toLowerCase();
  const declaredMime = String(artifact.mimeType || "").trim().toLowerCase();
  if (kind === "image") {
    const inferred = IMAGE_FORMATS.get(extension);
    if (!inferred) fail(`未対応のCanvas image形式: ${extension || "拡張子なし"}`, "CANVAS_RUN_MEDIA_FORMAT_UNSUPPORTED");
    if (declaredMime && declaredMime !== inferred && !(extension === ".jpeg" && declaredMime === "image/jpg")) {
      fail("image artifactのmimeTypeと拡張子が一致しない。", "CANVAS_RUN_MEDIA_FORMAT_MISMATCH");
    }
    return { extension: extension === ".jpeg" ? ".jpg" : extension, mimeType: inferred };
  }
  if (kind === "video") {
    if (extension !== ".mp4" || (declaredMime && declaredMime !== "video/mp4")) {
      fail("MP4 artifactは.mp4 / video/mp4であること。", "CANVAS_RUN_MEDIA_FORMAT_MISMATCH");
    }
    return { extension: ".mp4", mimeType: "video/mp4" };
  }
  if (kind === "audio") {
    const inferred = AUDIO_FORMATS.get(extension);
    if (!inferred) fail(`未対応のCanvas audio形式: ${extension || "拡張子なし"}`, "CANVAS_RUN_MEDIA_FORMAT_UNSUPPORTED");
    if (declaredMime && declaredMime !== inferred) {
      fail("audio artifactのmimeTypeと拡張子が一致しない。", "CANVAS_RUN_MEDIA_FORMAT_MISMATCH");
    }
    return { extension, mimeType: inferred };
  }
  const subtitleMime = extension === ".vtt" ? "text/vtt" : "application/x-subrip";
  if (![".srt", ".vtt"].includes(extension)) {
    fail("subtitle artifactは.srtまたは.vttであること。", "CANVAS_RUN_MEDIA_FORMAT_UNSUPPORTED");
  }
  if (declaredMime && ![subtitleMime, "text/plain", "application/x-subrip"].includes(declaredMime)) {
    fail("subtitle artifactのmimeTypeと拡張子が一致しない。", "CANVAS_RUN_MEDIA_FORMAT_MISMATCH");
  }
  return { extension, mimeType: subtitleMime };
}

function safeCanvasAssetSource(args, assetUrl) {
  const raw = String(assetUrl || "").split(/[?#]/u, 1)[0];
  if (!raw.startsWith(ASSETS_ROUTE)) return "";
  const encoded = raw.slice(ASSETS_ROUTE.length);
  if (!encoded) fail("Canvas asset URLが空。", "CANVAS_RUN_MEDIA_SOURCE_INVALID");
  let segments;
  try {
    segments = encoded.split("/").map((segment) => decodeURIComponent(segment));
  } catch {
    fail("Canvas asset URLをdecodeできない。", "CANVAS_RUN_MEDIA_SOURCE_INVALID");
  }
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || /[\\/\u0000]/u.test(segment))) {
    fail("Canvas asset URLにpath traversalがある。", "CANVAS_RUN_MEDIA_SOURCE_INVALID");
  }
  const assetsDir = join(resolveCanvasDir(args), "assets");
  const candidate = join(assetsDir, ...segments);
  const rel = relative(assetsDir, candidate);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    fail("Canvas asset URLがassets directory外を指す。", "CANVAS_RUN_MEDIA_SOURCE_INVALID");
  }
  return candidate;
}

function sourcePathForArtifact(args, artifact) {
  if (artifact.path) {
    return isAbsolute(artifact.path)
      ? resolve(artifact.path)
      : resolve(String(args.projectDir || process.cwd()), artifact.path);
  }
  const fromCanvas = safeCanvasAssetSource(args, artifact.canvasAssetUrl);
  if (fromCanvas) return fromCanvas;
  fail(`media artifact ${artifact.id}にlocal pathまたはCanvas asset URLが無い。`, "CANVAS_RUN_MEDIA_SOURCE_MISSING");
}

function sourceArtifactFor(artifact, candidates) {
  if (!Array.isArray(candidates)) return artifact;
  const identityMatches = candidates.filter((candidate) => candidate?.canvasArtifactId === artifact.id);
  if (identityMatches.length > 1) {
    fail(`media artifact ${artifact.id}のsource identityが重複している。`, "CANVAS_RUN_MEDIA_SOURCE_AMBIGUOUS");
  }
  if (identityMatches.length === 1) {
    const candidate = identityMatches[0];
    const candidateDigest = String(candidate.sha256 || "").replace(/^sha256:/iu, "").toLowerCase();
    if (candidateDigest !== digestOf(artifact.sha256) || !Boolean(candidate.path || candidate.canvasAssetUrl)) {
      fail(`media artifact ${artifact.id}のsource identity/SHAが一致しない。`, "CANVAS_RUN_MEDIA_SOURCE_INVALID");
    }
    return { ...artifact, ...candidate, id: artifact.id, kind: artifact.kind, sha256: artifact.sha256 };
  }
  const digest = digestOf(artifact.sha256);
  const matches = candidates.filter((candidate) => {
    const candidateDigest = String(candidate?.sha256 || "").replace(/^sha256:/iu, "").toLowerCase();
    return candidateDigest === digest && Boolean(candidate?.path || candidate?.canvasAssetUrl);
  });
  if (matches.length === 0) return artifact;
  // 同じbytesを複数roleで使うことはある。異なるsource pathを黙って選ばない。
  const locations = new Set(matches.map((candidate) => String(candidate.path || candidate.canvasAssetUrl)));
  if (locations.size > 1) {
    fail(`media artifact ${artifact.id}のsourceが一意でない。`, "CANVAS_RUN_MEDIA_SOURCE_AMBIGUOUS");
  }
  return { ...artifact, ...matches[0], id: artifact.id, kind: artifact.kind, sha256: artifact.sha256 };
}

async function assertNoSymlinkComponents(root, target) {
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    fail("content-addressed asset pathがCanvas assets外。", "CANVAS_RUN_MEDIA_TARGET_INVALID");
  }
  const rootInfo = await lstat(root).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (rootInfo?.isSymbolicLink()) {
    fail("Canvas assets directoryがsymlink。", "CANVAS_RUN_MEDIA_SYMLINK_REJECTED");
  }
  let cursor = root;
  for (const segment of rel.split(sep)) {
    cursor = join(cursor, segment);
    const info = await lstat(cursor).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (info?.isSymbolicLink()) {
      fail("Canvas asset pathにsymlinkがある。", "CANVAS_RUN_MEDIA_SYMLINK_REJECTED");
    }
  }
}

async function streamDigest(path, copyTo = "") {
  const linkBefore = await lstat(path).catch((error) => {
    if (error?.code === "ENOENT") fail("media artifact fileが存在しない。", "CANVAS_RUN_MEDIA_SOURCE_MISSING");
    throw error;
  });
  if (linkBefore.isSymbolicLink()) fail("media artifactのsymlinkは読まない。", "CANVAS_RUN_MEDIA_SYMLINK_REJECTED");
  if (!linkBefore.isFile()) fail("media artifactは通常fileであること。", "CANVAS_RUN_MEDIA_SOURCE_INVALID");

  const handle = await open(path, "r");
  const hash = createHash("sha256");
  const prefixChunks = [];
  let prefixBytes = 0;
  let bytes = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      bytes += chunk.length;
      if (prefixBytes < MAX_PREFIX_BYTES) {
        const keep = chunk.subarray(0, Math.min(chunk.length, MAX_PREFIX_BYTES - prefixBytes));
        prefixChunks.push(keep);
        prefixBytes += keep.length;
      }
      callback(null, chunk);
    },
  });
  try {
    const before = await handle.stat();
    const input = handle.createReadStream({ start: 0, autoClose: false });
    if (copyTo) await pipeline(input, meter, createWriteStream(copyTo, { flags: "wx" }));
    else await pipeline(input, meter, new Transform({ transform(chunk, _encoding, callback) { callback(); } }));
    const after = await handle.stat();
    const linkAfter = await lstat(path);
    if (linkAfter.isSymbolicLink()
      || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || linkBefore.dev !== linkAfter.dev || linkBefore.ino !== linkAfter.ino
      || bytes !== after.size) {
      fail("media artifactが読取り中に変更された。", "CANVAS_RUN_MEDIA_SOURCE_CHANGED");
    }
    return { digest: hash.digest("hex"), bytes, prefix: Buffer.concat(prefixChunks) };
  } finally {
    await handle.close().catch(() => {});
  }
}

async function verifiedAsset(args, run, artifact, { dryRun = false, sourceArtifacts = null } = {}) {
  const kind = mediaKind(artifact);
  const declaredDigest = digestOf(artifact.sha256);
  const sourceArtifact = sourceArtifactFor(artifact, sourceArtifacts);
  const sourcePath = sourcePathForArtifact(args, sourceArtifact);
  const format = artifactFormat(sourceArtifact, kind, sourcePath);
  const canvasDir = resolveCanvasDir(args);
  const assetsDir = join(canvasDir, "assets");
  const targetDir = join(assetsDir, "harness-runs", run.runId);
  const targetPath = join(targetDir, `${declaredDigest}${format.extension}`);
  await assertNoSymlinkComponents(assetsDir, targetPath);

  if (dryRun) {
    const observed = await streamDigest(sourcePath);
    if (observed.digest !== declaredDigest) {
      fail(`media artifact ${artifact.id}のSHA-256が実fileと一致しない。`, "CANVAS_RUN_MEDIA_SHA_MISMATCH");
    }
    return { artifact, kind, format, targetPath, observed, copied: false, reused: false };
  }

  await mkdir(targetDir, { recursive: true });
  await assertNoSymlinkComponents(assetsDir, targetPath);
  return withCanvasFileLock(targetPath, async () => {
    const existing = await lstat(targetPath).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (existing?.isSymbolicLink()) fail("content-addressed assetがsymlink。", "CANVAS_RUN_MEDIA_SYMLINK_REJECTED");
    if (existing) {
      if (!existing.isFile()) fail("content-addressed assetが通常fileではない。", "CANVAS_RUN_MEDIA_TARGET_INVALID");
      const observed = await streamDigest(targetPath);
      if (observed.digest !== declaredDigest) {
        fail("既存content-addressed assetのSHA-256が名前と一致しない。", "CANVAS_RUN_MEDIA_TARGET_CORRUPT");
      }
      // sourceも宣言SHAへ拘束する。既存assetが正しくても、入力artifactの差替えを黙認しない。
      if (resolve(sourcePath) !== resolve(targetPath)) {
        const sourceObserved = await streamDigest(sourcePath);
        if (sourceObserved.digest !== declaredDigest) {
          fail(`media artifact ${artifact.id}のSHA-256が実fileと一致しない。`, "CANVAS_RUN_MEDIA_SHA_MISMATCH");
        }
      }
      return { artifact, kind, format, targetPath, observed, copied: false, reused: true };
    }

    const tempPath = join(targetDir, `.${declaredDigest}.${process.pid}.tmp`);
    await rm(tempPath, { force: true });
    try {
      const observed = await streamDigest(sourcePath, tempPath);
      if (observed.digest !== declaredDigest) {
        fail(`media artifact ${artifact.id}のSHA-256が実fileと一致しない。`, "CANVAS_RUN_MEDIA_SHA_MISMATCH");
      }
      // Canvas サーバーが同じファイルを配っている最中でも置き換えられるよう、やり直す。
      await renameWithRetry(tempPath, targetPath);
      return { artifact, kind, format, targetPath, observed, copied: true, reused: false };
    } finally {
      await rm(tempPath, { force: true }).catch(() => {});
    }
  });
}

function assetUrlFor(run, asset) {
  return `${ASSETS_ROUTE}harness-runs/${encodeURIComponent(run.runId)}/${encodeURIComponent(basename(asset.targetPath))}`;
}

function safeDisplayName(asset) {
  return `harness-${asset.kind}-${digestOf(asset.artifact.sha256).slice(0, 12)}${asset.format.extension}`;
}

function imageBounds(asset) {
  let width = 1280;
  let height = 720;
  try {
    const dimensions = getImageDimensionsFromBuffer(asset.observed.prefix, asset.artifact.id);
    width = dimensions.width;
    height = dimensions.height;
  } catch {
    // SHAとmimeは検証済み。寸法をprefixから読めない形式だけ安全な16:9表示へfallbackする。
  }
  const aspect = Math.max(0.2, Math.min(5, width / Math.max(1, height)));
  const displayWidth = aspect >= 1 ? 320 : Math.max(150, Math.round(320 * aspect));
  const displayHeight = aspect >= 1 ? Math.max(120, Math.round(displayWidth / aspect)) : 320;
  return { width: displayWidth, height: displayHeight, pixelWidth: width, pixelHeight: height };
}

function cueCount(asset) {
  if (asset.kind !== "subtitle" || asset.observed.bytes > asset.observed.prefix.length) return 0;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(asset.observed.prefix);
    return (text.match(/(?:^|\n)\s*\d+\s*(?:\r?\n)/gu) || []).length;
  } catch {
    fail("subtitle artifactがUTF-8ではない。", "CANVAS_RUN_MEDIA_SUBTITLE_INVALID");
  }
}

function mediaBaseElement({ id, fileId = null, index, bounds, customData, run, link = null, type = "image" }) {
  return {
    id,
    type,
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    angle: 0,
    strokeColor: type === "rectangle" ? "#d9d9d9" : "transparent",
    backgroundColor: type === "rectangle" ? "#ffffff" : "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: type === "rectangle" ? 1 : 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: deterministicInteger(id, 1),
    version: 1,
    versionNonce: deterministicInteger(id, 2),
    isDeleted: false,
    boundElements: null,
    updated: timestampForRun(run),
    link,
    locked: false,
    index,
    ...(fileId ? { fileId, status: "saved", scale: [1, 1], crop: null } : {}),
    customData,
  };
}

function finalizeElement(element) {
  const { version: _version, versionNonce: _nonce, updated: _updated, index: _index, customData: raw, ...stable } = element;
  const { buzzassistMediaProjectionHash: _old, ...customData } = raw;
  element.customData = {
    ...raw,
    buzzassistMediaProjectionHash: `sha256:${sha256Hex(canonicalJson({ ...stable, customData }))}`,
  };
  return element;
}

function nextIndexes(run, count) {
  const main = buildCanvasRunProjection(run).elements
    .map((element) => element.index)
    .filter((value) => typeof value === "string")
    .sort();
  let previous = main.at(-1) ?? null;
  return Array.from({ length: count }, () => {
    previous = generateKeyBetween(previous, null);
    return previous;
  });
}

function layoutBaseY(run) {
  const elements = buildCanvasRunProjection(run).elements;
  const bottom = elements.reduce((max, element) => Math.max(max, Number(element.y) + Number(element.height)), 0);
  return Math.ceil(bottom / 20) * 20 + 80;
}

function buildPreparedProjection(run, prepared) {
  const fingerprint = canvasRunFingerprint(run);
  const indexes = nextIndexes(run, prepared.length);
  const baseY = layoutBaseY(run);
  const elements = [];
  const files = {};

  prepared.forEach((asset, position) => {
    const artifact = asset.artifact;
    const digest = digestOf(artifact.sha256);
    const elementId = stableCanvasRunId(run.runId, `${asset.kind}-media`, `${artifact.id}:${digest}`);
    const fileId = asset.kind === "subtitle" ? null : `file_${sha256Hex(`buzzassist-media-file:v1:${asset.kind}:${digest}`).slice(0, 24)}`;
    const assetUrl = assetUrlFor(run, asset);
    const displayName = safeDisplayName(asset);
    const column = position % 3;
    const row = Math.floor(position / 3);
    const imageSize = asset.kind === "image" ? imageBounds(asset) : null;
    const width = asset.kind === "subtitle" ? 205 : (imageSize?.width || 320);
    const height = asset.kind === "subtitle" ? 364 : (imageSize?.height || 180);
    const bounds = { x: 40 + column * 360, y: baseY + row * 420, width, height };
    const common = {
      [CANVAS_RUN_MEDIA_TAG]: true,
      buzzassistHarnessRun: true,
      buzzassistRunId: run.runId,
      buzzassistRunRevision: run.revision,
      buzzassistRunFingerprint: fingerprint,
      buzzassistEntityKind: "artifact-media",
      buzzassistEntityId: artifact.id,
      buzzassistArtifactId: artifact.stableId,
      buzzassistArtifactCardId: stableCanvasRunId(run.runId, "artifact-card", artifact.id),
      buzzassistArtifactKind: artifact.kind,
      buzzassistArtifactSha256: artifact.sha256,
      buzzassistMediaProjectionVersion: CANVAS_RUN_MEDIA_PROJECTION_VERSION,
      codexFileName: displayName,
      codexAssetUrl: assetUrl,
    };

    let customData;
    if (asset.kind === "image") {
      customData = {
        ...common,
        codexInsertedImage: true,
        codexMediaKind: "image",
        codexAssetMimeType: asset.format.mimeType,
        codexPixelWidth: imageSize.pixelWidth,
        codexPixelHeight: imageSize.pixelHeight,
      };
      files[fileId] = {
        id: fileId,
        name: displayName,
        mimeType: asset.format.mimeType,
        dataURL: assetUrl,
        codexAssetBacked: true,
        codexAssetUrl: assetUrl,
        created: deterministicInteger(fileId, 3),
        lastRetrieved: deterministicInteger(fileId, 3),
      };
    } else if (asset.kind === "video") {
      customData = {
        ...common,
        codexInsertedVideo: true,
        codexGeneratedVideo: true,
        codexMediaKind: "video",
        codexVideoMimeType: asset.format.mimeType,
        codexVideoDuration: Number(artifact.durationSeconds) || 0,
        codexPixelWidth: 1280,
        codexPixelHeight: 720,
      };
      files[fileId] = {
        id: fileId,
        name: `${displayName}-poster.svg`,
        mimeType: "image/svg+xml",
        dataURL: previewDataUrl({ kind: "video", title: artifact.title, digest }),
        created: deterministicInteger(fileId, 3),
        lastRetrieved: deterministicInteger(fileId, 3),
      };
    } else if (asset.kind === "audio") {
      customData = {
        ...common,
        codexInsertedAttachment: true,
        codexGeneratedSpeech: artifact.kind === "audio",
        codexKeepInlinePreview: true,
        codexMediaKind: "audio",
        codexAssetMimeType: asset.format.mimeType,
        codexAssetDuration: Number(artifact.durationSeconds) || 0,
      };
      files[fileId] = {
        id: fileId,
        name: `${displayName}-preview.svg`,
        mimeType: "image/svg+xml",
        dataURL: previewDataUrl({ kind: "audio", title: artifact.title, digest }),
        created: deterministicInteger(fileId, 3),
        lastRetrieved: deterministicInteger(fileId, 3),
      };
    } else {
      customData = {
        ...common,
        codexGeneratedSubtitle: true,
        codexMediaKind: "subtitle",
        codexAssetMimeType: asset.format.mimeType,
        subtitleCueCount: cueCount(asset),
      };
    }

    elements.push(finalizeElement(mediaBaseElement({
      id: elementId,
      fileId,
      index: indexes[position],
      bounds,
      customData,
      run,
      link: asset.kind === "video" || asset.kind === "subtitle" ? null : assetUrl,
      type: asset.kind === "subtitle" ? "rectangle" : "image",
    })));
  });

  return { run, runFingerprint: fingerprint, elements, files };
}

function selectedArtifacts(run) {
  return run.artifacts.filter((artifact) => mediaKind(artifact) && PROJECTABLE_STATUSES.has(artifact.status));
}

export async function prepareCanvasRunMediaAssets(args = {}, input, options = {}) {
  const run = normalizeCanvasRun(input);
  const artifacts = selectedArtifacts(run);
  const prepared = [];
  for (const artifact of artifacts) prepared.push(await verifiedAsset(args, run, artifact, options));
  const result = {
    runId: run.runId,
    runFingerprint: canvasRunFingerprint(run),
    copied: prepared.filter((asset) => asset.copied).length,
    reused: prepared.filter((asset) => asset.reused).length,
  };
  Object.defineProperty(result, PREPARED_MEDIA_ASSETS, {
    value: Object.freeze(prepared.map((asset) => Object.freeze(asset))),
    enumerable: false,
    writable: false,
  });
  return Object.freeze(result);
}

function ownedMedia(element, runId) {
  return element?.customData?.[CANVAS_RUN_MEDIA_TAG] === true
    && element?.customData?.buzzassistRunId === runId;
}

function nextElement(existing, desired, run) {
  if (existing.customData?.buzzassistMediaProjectionHash === desired.customData?.buzzassistMediaProjectionHash
    && existing.isDeleted !== true) return existing;
  const version = Math.max(1, Number(existing.version) || 1) + 1;
  return {
    ...desired,
    // Canvas上でユーザーが並べ直した位置・cropは、artifact内容が変わらない限り保持する。
    x: existing.x,
    y: existing.y,
    width: existing.width,
    height: existing.height,
    angle: existing.angle,
    index: existing.index ?? desired.index,
    ...(desired.type === "image" ? {
      scale: Array.isArray(existing.scale) ? existing.scale : desired.scale,
      crop: existing.crop ?? desired.crop,
    } : {}),
    version,
    versionNonce: deterministicInteger(`${desired.id}:${desired.customData.buzzassistMediaProjectionHash}`, version),
    updated: timestampForRun(run),
    isDeleted: false,
  };
}

function tombstone(element, run) {
  if (element.isDeleted === true) return element;
  const version = Math.max(1, Number(element.version) || 1) + 1;
  return {
    ...element,
    version,
    versionNonce: deterministicInteger(`${element.id}:deleted`, version),
    updated: timestampForRun(run),
    isDeleted: true,
  };
}

export function reconcileCanvasRunMedia(sceneValue, projection) {
  const scene = normalizeScene(sceneValue);
  // Run cardより先にmediaをprecommitする二段階投影では、同じ旧Run stateを見た
  // 競合writer同士をscene側でも直列化する必要がある。同revisionの別fingerprint、
  // または新しいrevisionのmediaを古い候補で上書きすることを必ず拒否する。
  for (const element of scene.elements) {
    if (!ownedMedia(element, projection.run.runId)) continue;
    const existingRevision = Number(element.customData?.buzzassistRunRevision);
    const existingFingerprint = String(element.customData?.buzzassistRunFingerprint || "");
    if (Number.isSafeInteger(existingRevision) && existingRevision > projection.run.revision) {
      fail("古いCanvas Run mediaは投影できない。", "CANVAS_RUN_MEDIA_STALE_REVISION");
    }
    if (
      existingRevision === projection.run.revision
      && existingFingerprint
      && existingFingerprint !== projection.runFingerprint
    ) {
      fail("同じrevisionの異なるCanvas Run mediaは投影できない。", "CANVAS_RUN_MEDIA_REVISION_CONFLICT");
    }
  }
  const desired = new Map(projection.elements.map((element) => [element.id, element]));
  const statistics = { added: 0, updated: 0, unchanged: 0, removed: 0, filesAdded: 0, filesUpdated: 0 };
  const elements = [];

  for (const element of scene.elements) {
    const replacement = desired.get(element.id);
    if (replacement) {
      if (!ownedMedia(element, projection.run.runId)) {
        fail(`Canvas element IDが非BuzzAssist elementと衝突: ${element.id}`, "CANVAS_RUN_MEDIA_ID_COLLISION");
      }
      const next = nextElement(element, replacement, projection.run);
      elements.push(next);
      desired.delete(element.id);
      if (next === element) statistics.unchanged += 1;
      else statistics.updated += 1;
    } else if (ownedMedia(element, projection.run.runId)) {
      const next = tombstone(element, projection.run);
      elements.push(next);
      if (next === element) statistics.unchanged += 1;
      else statistics.removed += 1;
    } else {
      elements.push(element);
    }
  }
  for (const element of desired.values()) {
    elements.push(element);
    statistics.added += 1;
  }

  const files = { ...scene.files };
  for (const [id, file] of Object.entries(projection.files)) {
    const existing = files[id];
    if (!existing) {
      files[id] = file;
      statistics.filesAdded += 1;
    } else if (canonicalJson(existing) !== canonicalJson(file)) {
      const foreignReference = scene.elements.some((element) => element.fileId === id && !ownedMedia(element, projection.run.runId));
      if (foreignReference) fail(`Canvas file IDが非BuzzAssist elementと衝突: ${id}`, "CANVAS_RUN_MEDIA_ID_COLLISION");
      files[id] = file;
      statistics.filesUpdated += 1;
    }
  }
  // 削除されたelementのfile recordは残す。tombstoneをundoでき、asset bytesも破壊しない。
  return { scene: { ...scene, elements, files, appState: { ...scene.appState } }, statistics };
}

function validateStoredRun(storedValue, run, { exact }) {
  if (!storedValue) {
    if (exact) fail("Canvas Run本体を先に投影すること。", "CANVAS_RUN_MEDIA_STATE_MISSING");
    return;
  }
  const { runFingerprint: recorded, ...raw } = storedValue;
  const stored = normalizeCanvasRun(raw);
  const actual = canvasRunFingerprint(stored);
  if (recorded && recorded !== actual) fail("Canvas Run stateのfingerprintが壊れている。", "CANVAS_RUN_MEDIA_STATE_INVALID");
  if (stored.runId !== run.runId || stored.revision > run.revision) {
    fail("古いCanvas Run mediaは投影できない。", "CANVAS_RUN_MEDIA_STALE_REVISION");
  }
  if (stored.revision === run.revision && actual !== canvasRunFingerprint(run)) {
    fail("同じrevisionの異なるCanvas Run mediaは投影できない。", "CANVAS_RUN_MEDIA_REVISION_CONFLICT");
  }
  if (exact && actual !== canvasRunFingerprint(run)) {
    fail("Canvas Run本体とmediaのrevision/fingerprintが一致しない。", "CANVAS_RUN_MEDIA_STATE_MISMATCH");
  }
}

export async function projectCanvasRunMedia(args = {}, input, options = {}) {
  const run = normalizeCanvasRun(input);
  const fingerprint = canvasRunFingerprint(run);
  const prepared = options.preparedAssets || await prepareCanvasRunMediaAssets(args, run, options);
  const preparedAssetRows = prepared?.[PREPARED_MEDIA_ASSETS];
  if (prepared.runId !== run.runId || prepared.runFingerprint !== fingerprint || !Array.isArray(preparedAssetRows)) {
    fail("prepared media assetsがCanvas Runへ拘束されていない。", "CANVAS_RUN_MEDIA_PREPARED_MISMATCH");
  }
  const projection = buildPreparedProjection(run, preparedAssetRows);
  const canvasFile = resolveCanvasFile(args);
  const stateFile = resolveCanvasRunStateFile(args, run.runId);

  if (options.dryRun === true) {
    validateStoredRun(await readJsonIfExists(stateFile, null), run, { exact: false });
    const reconciled = reconcileCanvasRunMedia(await readJsonIfExists(canvasFile, null), projection);
    return {
      ...reconciled.statistics,
      assetsCopied: 0,
      assetsReused: prepared.reused,
      projectedMedia: projection.elements.length,
      dryRun: true,
    };
  }

  return withCanvasFileLock(stateFile, async () => {
    // projectVideoHarnessJob may precommit content-addressed media before advancing
    // the visible Run card. In that narrow mode, absent/older state is allowed,
    // while a newer revision or same-revision fingerprint conflict still fails.
    validateStoredRun(await readJsonIfExists(stateFile, null), run, {
      exact: options.allowRunStateLag !== true,
    });
    const statistics = await withCanvasFileLock(canvasFile, async () => {
      const reconciled = reconcileCanvasRunMedia(await readJsonIfExists(canvasFile, null), projection);
      await writeJsonAtomic(canvasFile, reconciled.scene);
      return reconciled.statistics;
    });
    return {
      ...statistics,
      assetsCopied: prepared.copied,
      assetsReused: prepared.reused,
      projectedMedia: projection.elements.length,
      dryRun: false,
    };
  });
}

export const _testing = Object.freeze({
  artifactFormat,
  buildPreparedProjection,
  mediaKind,
  safeCanvasAssetSource,
  selectedArtifacts,
});
