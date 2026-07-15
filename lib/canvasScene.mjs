import { spawn } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, posix, relative, resolve, sep } from "node:path";
import { generateKeyBetween } from "fractional-indexing";

export const CANVAS_FILE_NAME = "excalidraw-canvas.json";
export const SELECTION_FILE_NAME = "excalidraw-selection.json";
export const FOCUS_REQUEST_FILE_NAME = "excalidraw-focus-request.json";
export const ASSETS_ROUTE = "/excalidraw-assets/";
export const AI_HOLDER_KEY = "codexAiImageHolder";
export const GENERATOR_FRAME_TAG = "buzzassist.imageGenerator.frame";
export const VIDEO_GENERATOR_FRAME_TAG = "buzzassist.videoGenerator.frame";
export const SILENCE_CUT_GENERATOR_FRAME_TAG = "buzzassist.silenceCutGenerator.frame";
export const GENERATOR_FRAME_BORDER_COLOR = "#c4a5f7";
export const GENERATOR_FRAME_FILL_COLOR = "#e8ddf5";
export const GENERATOR_FRAME_STROKE_WIDTH = 1;

const IMAGE_FRAME_SIZES = {
  "21:9": { baseWidth: 1568, baseHeight: 672 },
  "16:9": { baseWidth: 1456, baseHeight: 816 },
  "4:3": { baseWidth: 1232, baseHeight: 928 },
  "3:2": { baseWidth: 1344, baseHeight: 896 },
  "1:1": { baseWidth: 1024, baseHeight: 1024 },
  "9:16": { baseWidth: 816, baseHeight: 1456 },
  "3:4": { baseWidth: 928, baseHeight: 1232 },
  "2:3": { baseWidth: 896, baseHeight: 1344 },
  "5:4": { baseWidth: 1280, baseHeight: 1024 },
  "4:5": { baseWidth: 1024, baseHeight: 1280 },
};

const VIDEO_FRAME_SIZES = {
  "16:9": { width: 364, height: 205 },
  "9:16": { width: 205, height: 364 },
  "1:1": { width: 256, height: 256 },
  "4:3": { width: 340, height: 255 },
  "3:4": { width: 255, height: 340 },
  "3:2": { width: 340, height: 227 },
  "2:3": { width: 227, height: 340 },
  "21:9": { width: 378, height: 162 },
};

export const assetMimeTypes = new Map([
  [".apng", "image/apng"],
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".m4v", "video/mp4"],
  [".mov", "video/quicktime"],
  [".mp4", "video/mp4"],
  [".webm", "video/webm"],
  [".aac", "audio/aac"],
  [".flac", "audio/flac"],
  [".m4a", "audio/mp4"],
  [".mp3", "audio/mpeg"],
  [".ogg", "audio/ogg"],
  [".opus", "audio/opus"],
  [".wav", "audio/wav"],
  [".xml", "application/xml"],
  [".srt", "application/x-subrip"],
]);

export function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function finiteNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function pathResolve(value) {
  return resolve(String(value));
}

export function resolveCanvasDir(args = {}) {
  const explicitCanvasDir = nonEmptyString(args.canvasDir);
  if (explicitCanvasDir) return pathResolve(explicitCanvasDir);

  const explicitProjectDir = nonEmptyString(args.projectDir);
  if (explicitProjectDir) return join(pathResolve(explicitProjectDir), "canvas");

  const envCanvasDir = nonEmptyString(process.env.EXCALIDRAW_CANVAS_DIR);
  if (envCanvasDir) return pathResolve(envCanvasDir);

  const envProjectDir = nonEmptyString(process.env.EXCALIDRAW_PROJECT_DIR);
  if (envProjectDir) return join(pathResolve(envProjectDir), "canvas");

  return join(process.cwd(), "canvas");
}

export function resolveCanvasFile(args = {}) {
  return join(resolveCanvasDir(args), CANVAS_FILE_NAME);
}

export function resolveSelectionFile(args = {}) {
  return join(resolveCanvasDir(args), SELECTION_FILE_NAME);
}

export function resolveFocusRequestFile(args = {}) {
  return join(resolveCanvasDir(args), FOCUS_REQUEST_FILE_NAME);
}

export async function writeCanvasFocusRequest(args = {}, elementIds = [], options = {}) {
  const normalizedIds = [...new Set((Array.isArray(elementIds) ? elementIds : [elementIds])
    .map(nonEmptyString)
    .filter(Boolean))];
  if (normalizedIds.length === 0) return null;

  const payload = {
    version: 1,
    requestId: `focus_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    elementIds: normalizedIds,
    applySelection: options.applySelection !== false,
    applyViewport: options.applyViewport !== false,
    createdAt: Date.now(),
  };
  await writeJsonAtomic(resolveFocusRequestFile(args), payload);
  return payload;
}

export function isSafeChildPath(parent, child) {
  const pathToChild = relative(parent, child);
  return pathToChild && !pathToChild.startsWith("..") && !pathToChild.includes(`..${sep}`);
}

export function sanitizeFileName(name, fallbackName = "asset.bin") {
  const fallback = posix.basename(String(fallbackName || "asset.bin")) || "asset.bin";
  const rawName = posix.basename(String(name || fallback))
    .normalize("NFC")
    .replace(/[\\/]/g, "_")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  if (!rawName || rawName === "." || rawName === "..") return fallback;
  return rawName;
}

function sanitizeIdPart(value, fallback = "asset") {
  return (
    String(value || fallback)
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || fallback
  );
}

export function extForMimeType(mimeType, fallback = ".bin") {
  switch (String(mimeType || "").toLowerCase()) {
    case "image/apng":
      return ".apng";
    case "image/avif":
      return ".avif";
    case "image/gif":
      return ".gif";
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/svg+xml":
      return ".svg";
    case "image/webp":
      return ".webp";
    case "video/mp4":
      return ".mp4";
    case "video/quicktime":
      return ".mov";
    case "video/webm":
      return ".webm";
    default:
      return fallback;
  }
}

export function mimeTypeForFile(filePath) {
  return assetMimeTypes.get(extname(filePath).toLowerCase()) ?? "application/octet-stream";
}

export async function writeJsonAtomic(filePath, payload) {
  await mkdir(dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tempFile, `${JSON.stringify(payload, null, 2)}\n`);
  await rename(tempFile, filePath);
}

export async function readJsonIfExists(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

export function normalizeScene(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.elements)) {
    return {
      type: "excalidraw",
      version: 2,
      source: "codex-excalidraw-canvas",
      elements: [],
      appState: { viewBackgroundColor: "#ffffff" },
      files: {},
    };
  }

  const files = value.files && typeof value.files === "object" ? value.files : {};
  return {
    type: value.type ?? "excalidraw",
    version: value.version ?? 2,
    source: value.source ?? "codex-excalidraw-canvas",
    elements: restoreAssetBackedImageStatuses(value.elements, files),
    appState: value.appState && typeof value.appState === "object" ? value.appState : {},
    files,
  };
}

function isAssetBackedFileRecord(file) {
  return (
    (typeof file?.dataURL === "string" && file.dataURL.startsWith(ASSETS_ROUTE)) ||
    (file?.codexAssetBacked === true &&
      typeof file?.codexAssetUrl === "string" &&
      file.codexAssetUrl.startsWith(ASSETS_ROUTE))
  );
}

function restoreAssetBackedImageStatuses(elements, files) {
  if (!Array.isArray(elements) || !files || typeof files !== "object") return elements;
  const fileIds = new Set(
    Object.entries(files)
      .filter(([, file]) => isAssetBackedFileRecord(file))
      .map(([id]) => id),
  );
  if (fileIds.size === 0) return elements;
  let changed = false;
  const next = elements.map((element) => {
    if (
      element?.type !== "image" ||
      element.status !== "error" ||
      !fileIds.has(element.fileId) ||
      element.customData?.codexMediaKind === "video"
    ) {
      return element;
    }
    changed = true;
    return { ...element, status: "saved" };
  });
  return changed ? next : elements;
}

export async function loadScene(args = {}) {
  return normalizeScene(await readJsonIfExists(resolveCanvasFile(args), null));
}

async function assetFileExists(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

// Replace inline base64 dataURLs with their asset URL for file records whose
// scene element points at an EXISTING file under canvas/assets
// (customData.codexAssetPath on disk + customData.codexAssetUrl under
// /excalidraw-assets/). Safety rules:
// - never strips a record without a verified on-disk asset (drag-dropped
//   images without codexAssetPath keep their inline base64 — zero data loss);
// - video elements (customData.codexMediaKind === "video") keep their small
//   inline SVG poster dataURLs untouched.
export async function stripAssetBackedFileDataURLs(scene) {
  const files = scene?.files;
  if (!files || typeof files !== "object" || !Array.isArray(scene?.elements)) return scene;

  const elementsByFileId = new Map();
  for (const element of scene.elements) {
    if (!element || typeof element !== "object" || !element.fileId) continue;
    const list = elementsByFileId.get(element.fileId);
    if (list) list.push(element);
    else elementsByFileId.set(element.fileId, [element]);
  }

  for (const [fileId, file] of Object.entries(files)) {
    if (!file || typeof file !== "object") continue;
    if (typeof file.dataURL !== "string" || !file.dataURL.startsWith("data:")) continue;
    const elements = elementsByFileId.get(fileId) ?? [];
    if (elements.some((element) =>
      element.customData?.codexMediaKind === "video" ||
      element.customData?.codexKeepInlinePreview === true
    )) continue;
    const backing = elements.find((element) => {
      const customData = element.customData;
      return (
        typeof customData?.codexAssetPath === "string" &&
        customData.codexAssetPath.length > 0 &&
        typeof customData?.codexAssetUrl === "string" &&
        customData.codexAssetUrl.startsWith(ASSETS_ROUTE)
      );
    });
    if (!backing) continue;
    if (!(await assetFileExists(backing.customData.codexAssetPath))) continue;
    files[fileId] = { ...file, dataURL: backing.customData.codexAssetUrl, codexAssetBacked: true };
  }

  return scene;
}

export async function saveScene(args = {}, scene) {
  const normalized = normalizeScene(scene);
  await stripAssetBackedFileDataURLs(normalized);
  await writeJsonAtomic(resolveCanvasFile(args), normalized);
  await syncDeletedCanvasAssets(args, normalized);
}

// ---------------------------------------------------------------------------
// Canvas maintenance — run at server startup (vite dev server and MCP server).
// Every step is fail-safe: a maintenance error must never prevent the canvas
// from being served.

const INLINE_MIGRATION_MIN_BYTES = 64 * 1024;
const TMP_FILE_MAX_AGE_MS = 60 * 60 * 1000;
const ORPHAN_ASSET_MIN_AGE_MS = 60 * 60 * 1000;

function parseDataURL(dataURL) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataURL);
  if (!match || !match[2]) return null;
  try {
    return { mimeType: match[1] || "application/octet-stream", buffer: Buffer.from(match[3], "base64") };
  } catch {
    return null;
  }
}

// Scenes written before asset externalization keep generated images inline as
// base64 forever (stripAssetBackedFileDataURLs only strips records whose
// element carries codexAssetPath). Move big inline payloads to canvas/assets
// and point the record at the asset URL — the browser hydrates such records
// lazily and marks them codexAssetBacked, so its save path re-strips them and
// the cycle stays closed. Video poster records stay inline (the poster
// pipeline swaps fileIds and assumes inline data).
export async function migrateInlineFilesToAssets(args = {}) {
  const assetsDir = join(resolveCanvasDir(args), "assets");
  const scene = await loadScene(args);
  const files = scene.files ?? {};
  const elementsByFileId = new Map();
  for (const element of scene.elements ?? []) {
    if (!element?.fileId) continue;
    const list = elementsByFileId.get(element.fileId);
    if (list) list.push(element);
    else elementsByFileId.set(element.fileId, [element]);
  }
  const stats = { migrated: 0, dropped: 0, migratedBytes: 0 };
  for (const [fileId, file] of Object.entries(files)) {
    const dataURL = typeof file?.dataURL === "string" ? file.dataURL : "";
    if (!dataURL.startsWith("data:") || dataURL.length < INLINE_MIGRATION_MIN_BYTES) continue;
    const elements = elementsByFileId.get(fileId) ?? [];
    if (elements.length === 0) {
      delete files[fileId];
      stats.dropped += 1;
      continue;
    }
    if (elements.some((element) => element.customData?.codexMediaKind === "video")) continue;
    const parsed = parseDataURL(dataURL);
    if (!parsed) continue;
    const fileName = sanitizeFileName(`migrated-${fileId}${extForMimeType(parsed.mimeType, ".bin")}`);
    const assetPath = join(assetsDir, fileName);
    await mkdir(assetsDir, { recursive: true });
    if (!(await assetFileExists(assetPath))) await writeFile(assetPath, parsed.buffer);
    files[fileId] = { ...file, dataURL: `${ASSETS_ROUTE}${fileName}`, codexAssetBacked: true };
    stats.migrated += 1;
    stats.migratedBytes += dataURL.length;
  }
  if (stats.migrated > 0 || stats.dropped > 0) {
    const canvasFile = resolveCanvasFile(args);
    const backupPath = `${canvasFile}.bak-migrate-${new Date().toISOString().slice(0, 10)}`;
    try {
      if (!(await assetFileExists(backupPath))) await copyFile(canvasFile, backupPath);
    } catch {
      // backup is best-effort
    }
    await saveScene(args, scene);
  }
  return stats;
}

export async function cleanupCanvasTmpFiles(args = {}) {
  const canvasDir = resolveCanvasDir(args);
  const stats = { removed: 0 };
  let entries;
  try {
    entries = await readdir(canvasDir);
  } catch {
    return stats;
  }
  const cutoff = Date.now() - TMP_FILE_MAX_AGE_MS;
  for (const name of entries) {
    if (!name.endsWith(".tmp")) continue;
    const filePath = join(canvasDir, name);
    try {
      const info = await stat(filePath);
      if (!info.isFile() || info.mtimeMs > cutoff) continue;
      await rm(filePath);
      stats.removed += 1;
    } catch {
      // leave the file for the next run
    }
  }
  return stats;
}

// Assets referenced nowhere in the canvas/selection/view-state JSON (deleted
// media, superseded posters) move to canvas/assets-trash rather than being
// deleted, so a mistake stays recoverable. Substring matching on the file
// name errs on the side of keeping files.
export async function trashOrphanAssets(args = {}) {
  const canvasDir = resolveCanvasDir(args);
  const assetsDir = join(canvasDir, "assets");
  const trashDir = join(canvasDir, "assets-trash");
  const stats = { trashed: 0, trashedBytes: 0 };
  let entries;
  try {
    entries = await readdir(assetsDir);
  } catch {
    return stats;
  }
  let referencedText = "";
  for (const name of [CANVAS_FILE_NAME, SELECTION_FILE_NAME, "excalidraw-view-state.json"]) {
    try {
      referencedText += await readFile(join(canvasDir, name), "utf8");
    } catch {
      // missing file → nothing referenced from it
    }
  }
  const cutoff = Date.now() - ORPHAN_ASSET_MIN_AGE_MS;
  for (const name of entries) {
    if (referencedText.includes(name) || referencedText.includes(encodeURIComponent(name))) continue;
    const filePath = join(assetsDir, name);
    try {
      const info = await stat(filePath);
      if (!info.isFile() || info.mtimeMs > cutoff) continue;
      await mkdir(trashDir, { recursive: true });
      await rename(filePath, join(trashDir, name));
      stats.trashed += 1;
      stats.trashedBytes += info.size;
    } catch {
      // leave the file for the next run
    }
  }
  return stats;
}

function assetLeafNameFromUrl(value) {
  if (typeof value !== "string" || !value.includes(ASSETS_ROUTE)) return null;
  try {
    const url = new URL(value, "http://127.0.0.1");
    if (!url.pathname.startsWith(ASSETS_ROUTE)) return null;
    const encodedName = url.pathname.slice(ASSETS_ROUTE.length);
    if (!encodedName || encodedName.includes("/")) return null;
    const decodedName = decodeURIComponent(encodedName);
    return sanitizeFileName(decodedName) === decodedName ? decodedName : null;
  } catch {
    return null;
  }
}

function assetLeafNameFromPath(value, assetsDir) {
  if (typeof value !== "string" || !value) return null;
  const absolutePath = resolve(value);
  if (!isSafeChildPath(assetsDir, absolutePath) || dirname(absolutePath) !== assetsDir) return null;
  const name = basename(absolutePath);
  return sanitizeFileName(name) === name ? name : null;
}

function addAssetNameFromValue(output, value, assetsDir) {
  const fromUrl = assetLeafNameFromUrl(value);
  if (fromUrl) output.add(fromUrl);
  const fromPath = assetLeafNameFromPath(value, assetsDir);
  if (fromPath) output.add(fromPath);
}

function collectNestedAssetNames(value, assetsDir, output, seen = new Set()) {
  if (typeof value === "string") {
    addAssetNameFromValue(output, value, assetsDir);
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectNestedAssetNames(item, assetsDir, output, seen);
    return;
  }
  for (const nested of Object.values(value)) collectNestedAssetNames(nested, assetsDir, output, seen);
}

function ownedAssetNamesForElement(element, files, assetsDir) {
  const names = new Set();
  const customData = element?.customData ?? {};
  addAssetNameFromValue(names, customData.codexAssetUrl, assetsDir);
  addAssetNameFromValue(names, customData.codexAssetPath, assetsDir);
  addAssetNameFromValue(names, element?.link, assetsDir);
  const file = element?.fileId ? files?.[element.fileId] : null;
  if (file) {
    addAssetNameFromValue(names, file.dataURL, assetsDir);
    addAssetNameFromValue(names, file.codexAssetUrl, assetsDir);
  }
  return names;
}

function referencedAssetNamesForLiveElement(element, files, assetsDir) {
  const names = ownedAssetNamesForElement(element, files, assetsDir);
  collectNestedAssetNames(element?.customData, assetsDir, names);
  const file = element?.fileId ? files?.[element.fileId] : null;
  collectNestedAssetNames(file, assetsDir, names);
  return names;
}

async function pathIsFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function archiveTrashCollision(trashDir, fileName) {
  const existingPath = join(trashDir, fileName);
  if (!(await pathIsFile(existingPath))) return;
  const historyDir = join(trashDir, ".history");
  await mkdir(historyDir, { recursive: true });
  const ext = extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  let counter = 1;
  while (true) {
    const suffix = `${Date.now()}-${counter}`;
    const historyPath = join(historyDir, `${stem}.${suffix}${ext}`);
    if (!(await pathIsFile(historyPath))) {
      await renameWithRetry(existingPath, historyPath);
      return;
    }
    counter += 1;
  }
}

async function renameWithRetry(sourcePath, destinationPath) {
  const retryableCodes = new Set(["EACCES", "EBUSY", "EPERM"]);
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rename(sourcePath, destinationPath);
      return;
    } catch (error) {
      lastError = error;
      if (!retryableCodes.has(error?.code) || attempt === 4) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 75 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function removeAssetPreviews(canvasDir, fileName) {
  const previewsDir = join(canvasDir, ".asset-previews");
  let entries;
  try {
    entries = await readdir(previewsDir);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((name) => name.startsWith(`${fileName}.`))
      .map((name) => rm(join(previewsDir, name), { force: true }).catch(() => undefined)),
  );
}

// Keep the project-local assets folder in sync with visible canvas results.
// Deleting a disk-backed result moves its owned file to assets-trash. Undoing
// the deletion restores the same file, while any asset still referenced by a
// live frame/result remains untouched. Moving instead of unlinking keeps this
// operation recoverable and works consistently on macOS and Windows.
export async function syncDeletedCanvasAssets(args = {}, sceneValue) {
  const scene = normalizeScene(sceneValue);
  const canvasDir = resolveCanvasDir(args);
  const assetsDir = join(canvasDir, "assets");
  const trashDir = join(canvasDir, "assets-trash");
  const files = scene.files ?? {};
  const ownedNames = new Set();
  const liveReferencedNames = new Set();

  for (const element of scene.elements) {
    for (const name of ownedAssetNamesForElement(element, files, assetsDir)) ownedNames.add(name);
    if (!element?.isDeleted) {
      for (const name of referencedAssetNamesForLiveElement(element, files, assetsDir)) liveReferencedNames.add(name);
    }
  }

  const stats = { trashed: 0, restored: 0, keptReferenced: 0, failed: 0 };

  // Undo can make an element live again. Restore before considering deletions.
  for (const name of liveReferencedNames) {
    const assetPath = join(assetsDir, name);
    const trashPath = join(trashDir, name);
    if (await pathIsFile(assetPath)) {
      stats.keptReferenced += 1;
      continue;
    }
    if (!(await pathIsFile(trashPath))) continue;
    try {
      await mkdir(assetsDir, { recursive: true });
      await renameWithRetry(trashPath, assetPath);
      stats.restored += 1;
    } catch {
      stats.failed += 1;
    }
  }

  for (const name of ownedNames) {
    if (liveReferencedNames.has(name)) continue;
    const assetPath = join(assetsDir, name);
    if (!(await pathIsFile(assetPath))) continue;
    try {
      await mkdir(trashDir, { recursive: true });
      await archiveTrashCollision(trashDir, name);
      await renameWithRetry(assetPath, join(trashDir, name));
      await removeAssetPreviews(canvasDir, name);
      stats.trashed += 1;
    } catch {
      stats.failed += 1;
    }
  }

  return stats;
}

// Mirror direct Finder/Explorer/terminal deletion back into the canvas. Only
// disk-backed media owned by a live element participates; reference assets
// nested in generator settings do not delete their generator frame. A
// watcher-triggered deletion passes restoreFromTrash=false because the user
// deliberately removed the live file. Startup reconciliation keeps the
// default true so an offline Undo can still restore from assets-trash.
export async function syncMissingCanvasAssets(args = {}) {
  const scene = await loadScene(args);
  const canvasDir = resolveCanvasDir(args);
  const assetsDir = join(canvasDir, "assets");
  const trashDir = join(canvasDir, "assets-trash");
  const targetName = nonEmptyString(args.assetFileName);
  const restoreFromTrash = args.restoreFromTrash !== false;
  const deletedElementIds = [];
  let restored = 0;

  for (const element of scene.elements) {
    if (!element || element.isDeleted) continue;
    const ownedNames = ownedAssetNamesForElement(element, scene.files ?? {}, assetsDir);
    if (ownedNames.size === 0 || (targetName && !ownedNames.has(targetName))) continue;

    let hasMissingAsset = false;
    for (const name of ownedNames) {
      if (targetName && name !== targetName) continue;
      const assetPath = join(assetsDir, name);
      if (await pathIsFile(assetPath)) continue;
      const trashPath = join(trashDir, name);
      if (restoreFromTrash && (await pathIsFile(trashPath))) {
        try {
          await mkdir(assetsDir, { recursive: true });
          await renameWithRetry(trashPath, assetPath);
          restored += 1;
          continue;
        } catch {
          // If restoration fails, treat the asset as genuinely unavailable.
        }
      }
      hasMissingAsset = true;
      break;
    }

    if (hasMissingAsset) deletedElementIds.push(element.id);
  }

  if (deletedElementIds.length === 0) {
    return { deleted: 0, restored, deletedElementIds: [] };
  }

  const deletedIds = new Set(deletedElementIds);
  const now = Date.now();
  scene.elements = scene.elements.map((element) =>
    deletedIds.has(element.id)
      ? {
          ...element,
          isDeleted: true,
          version: (Number(element.version) || 1) + 1,
          versionNonce: Math.floor(Math.random() * 2 ** 31),
          updated: now,
        }
      : element,
  );
  if (scene.appState?.selectedElementIds) {
    scene.appState = {
      ...scene.appState,
      selectedElementIds: Object.fromEntries(
        Object.entries(scene.appState.selectedElementIds).filter(([id]) => !deletedIds.has(id)),
      ),
    };
  }
  await saveScene(args, scene);
  return { deleted: deletedElementIds.length, restored, deletedElementIds };
}

// Match the desktop app's subtitle-card migration: re-color transparent
// cards (their interior was not hit-testable, so they could not be
// dragged) and shrink obsolete landscape footprints back to the portrait
// 205x364 card, keeping the card's center in place.
const SUBTITLE_CARD_WIDTH = 205;
const SUBTITLE_CARD_HEIGHT = 364;

function isObsoleteSubtitleCardSize(width, height) {
  const w = Math.round(width);
  const h = Math.round(height);
  if (w === SUBTITLE_CARD_WIDTH && h === SUBTITLE_CARD_HEIGHT) return false;
  return (
    (w === 360 && h === 640) ||
    (w === 560 && h >= 310 && h <= 325) ||
    (w === 364 && h === 205) ||
    (w === 512 && h === 512)
  );
}

export async function normalizeSubtitleCards(args = {}) {
  const scene = await loadScene(args);
  let changed = 0;
  scene.elements = scene.elements.map((element) => {
    if (!element?.customData?.codexGeneratedSubtitle || element.isDeleted) return element;
    const needsColors = element.backgroundColor !== "#faf8ff" || element.strokeColor !== "#d9d9d9";
    const needsResize = isObsoleteSubtitleCardSize(element.width, element.height);
    if (!needsColors && !needsResize) return element;
    changed += 1;
    const next = {
      ...element,
      strokeColor: "#d9d9d9",
      backgroundColor: "#faf8ff",
      strokeWidth: 1,
      fillStyle: "solid",
      version: (Number(element.version) || 1) + 1,
      versionNonce: Math.floor(Math.random() * 2 ** 31),
      updated: Date.now(),
    };
    if (needsResize) {
      next.x = element.x + (element.width - SUBTITLE_CARD_WIDTH) / 2;
      next.y = element.y + (element.height - SUBTITLE_CARD_HEIGHT) / 2;
      next.width = SUBTITLE_CARD_WIDTH;
      next.height = SUBTITLE_CARD_HEIGHT;
    }
    return next;
  });
  if (changed > 0) await saveScene(args, scene);
  return { normalized: changed };
}

// v0.1.14 stored silence-cut XMLs as landscape image cards. v0.1.15 renders
// XML as source text like SRT, so migrate only those legacy cards once. The
// center stays fixed to avoid making the canvas appear to jump on upgrade.
export async function normalizeSilenceCutTextPreviewCards(args = {}) {
  const scene = await loadScene(args);
  let changed = 0;
  scene.elements = scene.elements.map((element) => {
    if (
      element?.isDeleted ||
      element?.customData?.codexGeneratedSilenceCut !== true ||
      element?.customData?.codexTextPreview === true
    ) {
      return element;
    }
    changed += 1;
    return {
      ...element,
      x: element.x + (element.width - SUBTITLE_CARD_WIDTH) / 2,
      y: element.y + (element.height - SUBTITLE_CARD_HEIGHT) / 2,
      width: SUBTITLE_CARD_WIDTH,
      height: SUBTITLE_CARD_HEIGHT,
      customData: {
        ...(element.customData ?? {}),
        codexTextPreview: true,
      },
      version: (Number(element.version) || 1) + 1,
      versionNonce: Math.floor(Math.random() * 2 ** 31),
      updated: Date.now(),
    };
  });
  if (changed > 0) await saveScene(args, scene);
  return { normalized: changed };
}

// safeOnly (the default for server startup) runs health, consistency, and
// idempotent schema migrations: externalizing inline base64, removing .tmp
// files, reflecting deleted assets, and upgrading legacy silence-cut cards.
// It skips discretionary cleanup such as moving arbitrary old subtitle cards
// or trashing orphan files; those require full: true.
export async function performCanvasMaintenance(args = {}) {
  const full = args.full === true && args.safeOnly !== true;
  const results = {};
  try {
    results.migration = await migrateInlineFilesToAssets(args);
  } catch (error) {
    results.migrationError = error?.message ?? String(error);
  }
  try {
    results.tmpCleanup = await cleanupCanvasTmpFiles(args);
  } catch (error) {
    results.tmpError = error?.message ?? String(error);
  }
  try {
    results.missingAssets = await syncMissingCanvasAssets(args);
  } catch (error) {
    results.missingAssetsError = error?.message ?? String(error);
  }
  try {
    results.silenceCutTextCards = await normalizeSilenceCutTextPreviewCards(args);
  } catch (error) {
    results.silenceCutTextCardsError = error?.message ?? String(error);
  }
  if (full) {
    try {
      results.subtitleCards = await normalizeSubtitleCards(args);
    } catch (error) {
      results.subtitleCardsError = error?.message ?? String(error);
    }
    try {
      results.orphans = await trashOrphanAssets(args);
    } catch (error) {
      results.orphanError = error?.message ?? String(error);
    }
  }
  return results;
}

function selectedIdsFromScene(scene) {
  return Object.entries(scene.appState?.selectedElementIds ?? {})
    .filter(([, selected]) => selected)
    .map(([id]) => id);
}

export async function readSelectionState(args = {}) {
  const selectionFile = resolveSelectionFile(args);
  const selection = await readJsonIfExists(selectionFile, {
    selectedElements: [],
    selectedElementIds: [],
    updatedAt: null,
  });
  return { selection, selectionFile };
}

export const OFFICIAL_EXCALIDRAW_README = `# Excalidraw MCP Element Format

Use create_view with a JSON array string of Excalidraw-like elements. This local endpoint writes those elements into the currently running local Excalidraw canvas.

Supported element types:
- rectangle, ellipse, diamond, arrow, line, text
- cameraUpdate pseudo-element for viewport state
- delete pseudo-element for marking existing ids deleted

Required fields for drawable elements:
- type, id, x, y, width, height

Useful shape fields:
- strokeColor, backgroundColor, fillStyle, strokeWidth, strokeStyle, roughness, opacity
- roundness: { "type": 3 } for rounded rectangles
- label: { "text": "Label", "fontSize": 18 } on rectangle, ellipse, diamond, or arrow

Example:
[
  { "type": "cameraUpdate", "width": 800, "height": 600, "x": 0, "y": 0 },
  { "type": "rectangle", "id": "client", "x": 80, "y": 100, "width": 180, "height": 80, "backgroundColor": "#a5d8ff", "fillStyle": "solid", "roundness": { "type": 3 }, "label": { "text": "Client", "fontSize": 18 } },
  { "type": "rectangle", "id": "api", "x": 360, "y": 100, "width": 180, "height": 80, "backgroundColor": "#b2f2bb", "fillStyle": "solid", "roundness": { "type": 3 }, "label": { "text": "API", "fontSize": 18 } },
  { "type": "arrow", "id": "client_to_api", "x": 260, "y": 140, "width": 100, "height": 0, "points": [[0, 0], [100, 0]], "endArrowhead": "arrow", "label": { "text": "request", "fontSize": 14 } }
]

By default create_view replaces only elements previously created by this official-compatible MCP view. It does not delete user-created canvas content unless clearCanvas is true.`;

function parseElementsInput(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
  }
  throw new Error("create_view requires elements as a JSON array string or array.");
}

function diagramNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function diagramPositiveNumber(value, fallback = 1) {
  const numeric = diagramNumber(value, fallback);
  return numeric > 0 ? numeric : fallback;
}

function diagramString(value, fallback = "") {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function diagramId(existingIds, requestedId, prefix, fallbackSeed) {
  const requested = sanitizeIdPart(requestedId, "");
  if (requested && !existingIds.has(requested)) {
    existingIds.add(requested);
    return requested;
  }
  return uniqueId(existingIds, prefix, fallbackSeed || requested || prefix);
}

function diagramBaseElement(raw, { id, index, type, customData }) {
  const now = Date.now();
  return {
    id,
    type,
    x: diagramNumber(raw.x, 0),
    y: diagramNumber(raw.y, 0),
    width: diagramPositiveNumber(raw.width, type === "text" ? 120 : 1),
    height: diagramPositiveNumber(raw.height, type === "text" ? 32 : 1),
    angle: diagramNumber(raw.angle, 0),
    strokeColor: diagramString(raw.strokeColor, "#1e1e1e"),
    backgroundColor: diagramString(raw.backgroundColor, "transparent"),
    fillStyle: diagramString(raw.fillStyle, "solid"),
    strokeWidth: diagramPositiveNumber(raw.strokeWidth, type === "text" ? 1 : 2),
    strokeStyle: diagramString(raw.strokeStyle, "solid"),
    roughness: diagramNumber(raw.roughness, 1),
    opacity: Math.max(0, Math.min(100, diagramNumber(raw.opacity, 100))),
    groupIds: Array.isArray(raw.groupIds) ? raw.groupIds : [],
    frameId: raw.frameId ?? null,
    roundness: raw.roundness ?? (type === "rectangle" ? { type: 3 } : null),
    seed: Math.floor(Math.random() * 2 ** 31),
    version: 1,
    versionNonce: Math.floor(Math.random() * 2 ** 31),
    isDeleted: false,
    boundElements: null,
    updated: now,
    link: raw.link ?? null,
    locked: Boolean(raw.locked),
    index,
    customData,
  };
}

function estimateTextWidth(text, fontSize) {
  return Math.max(24, Math.ceil(String(text).length * fontSize * 0.56));
}

function newDiagramTextElement(raw, { id, index, customData, containerId = null }) {
  const text = diagramString(raw.text ?? raw.rawText, "");
  const fontSize = Math.max(8, diagramNumber(raw.fontSize, 18));
  return {
    ...diagramBaseElement(raw, { id, index, type: "text", customData }),
    width: diagramPositiveNumber(raw.width, estimateTextWidth(text, fontSize)),
    height: diagramPositiveNumber(raw.height, Math.ceil(fontSize * 1.35)),
    backgroundColor: "transparent",
    fillStyle: "hachure",
    fontSize,
    fontFamily: diagramNumber(raw.fontFamily, 1),
    text,
    rawText: text,
    textAlign: diagramString(raw.textAlign, "left"),
    verticalAlign: diagramString(raw.verticalAlign, "top"),
    containerId,
    originalText: text,
    autoResize: raw.autoResize !== false,
    lineHeight: diagramNumber(raw.lineHeight, 1.25),
  };
}

function labelTextElement(raw, label, { id, index, customData, containerId = null }) {
  const text = diagramString(label?.text, "");
  const fontSize = Math.max(8, diagramNumber(label?.fontSize, 18));
  const width = estimateTextWidth(text, fontSize);
  const height = Math.ceil(fontSize * 1.35);
  const x = diagramNumber(raw.x, 0) + diagramPositiveNumber(raw.width, 1) / 2 - width / 2;
  const y = diagramNumber(raw.y, 0) + diagramPositiveNumber(raw.height, 1) / 2 - height / 2;
  return newDiagramTextElement(
    {
      x,
      y,
      width,
      height,
      text,
      fontSize,
      strokeColor: label?.strokeColor ?? raw.strokeColor ?? "#1e1e1e",
      textAlign: "center",
      verticalAlign: "middle",
    },
    { id, index, customData, containerId },
  );
}

function arrowLabelElement(raw, label, { id, index, customData }) {
  const text = diagramString(label?.text, "");
  const fontSize = Math.max(8, diagramNumber(label?.fontSize, 14));
  const width = estimateTextWidth(text, fontSize);
  const height = Math.ceil(fontSize * 1.35);
  const x = diagramNumber(raw.x, 0) + diagramNumber(raw.width, 0) / 2 - width / 2;
  const y = diagramNumber(raw.y, 0) + diagramNumber(raw.height, 0) / 2 - height - 4;
  return newDiagramTextElement(
    {
      x,
      y,
      width,
      height,
      text,
      fontSize,
      strokeColor: label?.strokeColor ?? raw.strokeColor ?? "#1e1e1e",
      textAlign: "center",
      verticalAlign: "middle",
    },
    { id, index, customData },
  );
}

function normalizeArrowPoints(raw) {
  if (Array.isArray(raw.points) && raw.points.length >= 2) {
    return raw.points.map((point) => Array.isArray(point) ? [diagramNumber(point[0], 0), diagramNumber(point[1], 0)] : [0, 0]);
  }
  return [[0, 0], [diagramNumber(raw.width, 1), diagramNumber(raw.height, 0)]];
}

function toDiagramElementRecords(raw, { existingIds, elements, indexSeed, customData }) {
  const type = diagramString(raw.type, "");
  const id = diagramId(existingIds, raw.id, type || "element", `${type}_${indexSeed}`);
  const index = chooseIndex(elements);
  const elementCustomData = {
    ...(raw.customData && typeof raw.customData === "object" ? raw.customData : {}),
    ...customData,
  };

  if (type === "text") {
    return [newDiagramTextElement(raw, { id, index, customData: elementCustomData })];
  }

  if (type === "arrow" || type === "line") {
    const element = {
      ...diagramBaseElement(raw, { id, index, type, customData: elementCustomData }),
      points: normalizeArrowPoints(raw),
      startBinding: raw.startBinding ?? null,
      endBinding: raw.endBinding ?? null,
      startArrowhead: raw.startArrowhead ?? null,
      endArrowhead: raw.endArrowhead ?? (type === "arrow" ? "arrow" : null),
      elbowed: Boolean(raw.elbowed),
    };
    const records = [element];
    if (raw.label?.text) {
      const labelId = diagramId(existingIds, raw.label.id, "label", `${id}_label`);
      records.push(arrowLabelElement(raw, raw.label, { id: labelId, index: chooseIndex([...elements, ...records]), customData: elementCustomData }));
    }
    return records;
  }

  if (!["rectangle", "ellipse", "diamond"].includes(type)) {
    throw new Error(`Unsupported Excalidraw element type: ${type || "(missing)"}`);
  }

  const element = diagramBaseElement(raw, { id, index, type, customData: elementCustomData });
  const records = [element];
  if (raw.label?.text) {
    const labelId = diagramId(existingIds, raw.label.id, "label", `${id}_label`);
    const textElement = labelTextElement(raw, raw.label, {
      id: labelId,
      index: chooseIndex([...elements, ...records]),
      customData: elementCustomData,
      containerId: id,
    });
    element.boundElements = [{ type: "text", id: labelId }];
    records.push(textElement);
  }
  return records;
}

function boundsForElements(elements) {
  const drawable = elements.filter((element) => !element.isDeleted && ["rectangle", "ellipse", "diamond", "arrow", "line", "text"].includes(element.type));
  if (drawable.length === 0) return null;
  const left = Math.min(...drawable.map((element) => diagramNumber(element.x, 0)));
  const top = Math.min(...drawable.map((element) => diagramNumber(element.y, 0)));
  const right = Math.max(...drawable.map((element) => diagramNumber(element.x, 0) + diagramPositiveNumber(element.width, 1)));
  const bottom = Math.max(...drawable.map((element) => diagramNumber(element.y, 0) + diagramPositiveNumber(element.height, 1)));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export async function createExcalidrawView(args = {}) {
  const rawElements = parseElementsInput(args.elements);
  const scene = await loadScene(args);
  const existingIds = new Set(scene.elements.map((element) => element.id));
  const customData = {
    codexOfficialMcpView: true,
    codexOfficialMcpViewId: nonEmptyString(args.viewId) || `view_${Date.now()}`,
  };
  const deleteIds = new Set();
  let camera = null;
  let added = [];
  let nextElements = scene.elements.map((element) => {
    if (args.clearCanvas || (args.append !== true && element.customData?.codexOfficialMcpView === true)) {
      return {
        ...element,
        isDeleted: true,
        version: (Number(element.version) || 1) + 1,
        versionNonce: Math.floor(Math.random() * 2 ** 31),
        updated: Date.now(),
      };
    }
    return element;
  });

  for (const [index, raw] of rawElements.entries()) {
    if (!raw || typeof raw !== "object") continue;
    if (raw.type === "cameraUpdate") {
      camera = {
        x: diagramNumber(raw.x, 0),
        y: diagramNumber(raw.y, 0),
        width: diagramPositiveNumber(raw.width, 800),
        height: diagramPositiveNumber(raw.height, 600),
      };
      continue;
    }
    if (raw.type === "delete") {
      const ids = String(raw.ids ?? raw.id ?? "").split(",").map((id) => id.trim()).filter(Boolean);
      for (const id of ids) deleteIds.add(id);
      continue;
    }
    if (raw.type === "restoreCheckpoint") continue;

    const records = toDiagramElementRecords(raw, {
      existingIds,
      elements: nextElements,
      indexSeed: index + 1,
      customData,
    });
    nextElements = [...nextElements, ...records];
    added = [...added, ...records];
  }

  if (deleteIds.size > 0) {
    nextElements = nextElements.map((element) =>
      deleteIds.has(element.id) || deleteIds.has(element.containerId)
        ? {
            ...element,
            isDeleted: true,
            version: (Number(element.version) || 1) + 1,
            versionNonce: Math.floor(Math.random() * 2 ** 31),
            updated: Date.now(),
          }
        : element,
    );
  }

  const selectedElementIds = args.selectCreated === true && added[0]?.id ? { [added[0].id]: true } : scene.appState?.selectedElementIds ?? {};
  scene.elements = nextElements;
  scene.appState = {
    ...scene.appState,
    ...(camera && args.applyCamera === true
      ? {
          scrollX: -camera.x,
          scrollY: -camera.y,
          zoom: scene.appState?.zoom ?? { value: 1 },
        }
      : {}),
    selectedElementIds,
  };

  if (!args.dryRun) await saveScene(args, scene);

  return {
    ok: true,
    sceneFile: resolveCanvasFile(args),
    addedElementCount: added.length,
    deletedElementCount: deleteIds.size,
    camera,
    bounds: boundsForElements(added),
    dryRun: Boolean(args.dryRun),
  };
}

export function elementSummary(element, files = {}) {
  const file = element.fileId ? files[element.fileId] : null;
  return {
    id: element.id,
    type: element.type,
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
    angle: element.angle,
    index: element.index,
    frameId: element.frameId ?? null,
    customData: element.customData ?? null,
    isAiImageHolder: element.customData?.[AI_HOLDER_KEY] === true,
    file: file
      ? {
          id: file.id,
          mimeType: file.mimeType,
          created: file.created,
          lastRetrieved: file.lastRetrieved ?? null,
        }
      : null,
  };
}

function uniqueId(existingIds, prefix, seed) {
  const cleanSeed = sanitizeIdPart(seed);
  let candidate = `${prefix}_${cleanSeed}`;
  let counter = 2;
  while (existingIds.has(candidate)) {
    candidate = `${prefix}_${cleanSeed}_${counter}`;
    counter += 1;
  }
  existingIds.add(candidate);
  return candidate;
}

async function uniqueFilePath(dir, requestedName, reservedNames = null) {
  const safeName = sanitizeFileName(requestedName);
  const ext = extname(safeName);
  const base = safeName.slice(0, safeName.length - ext.length);
  let candidate = safeName;
  let counter = 1;
  while (true) {
    const candidatePath = join(dir, candidate);
    if (!isSafeChildPath(dir, candidatePath)) {
      throw new Error(`Unsafe asset filename: ${candidate}`);
    }
    if (reservedNames?.has(candidate)) {
      candidate = `${base} (${counter})${ext}`;
      counter += 1;
      continue;
    }
    try {
      await stat(candidatePath);
      candidate = `${base} (${counter})${ext}`;
      counter += 1;
    } catch (error) {
      if (error?.code === "ENOENT") {
        const trashPath = basename(dir) === "assets" ? join(dirname(dir), "assets-trash", candidate) : null;
        if (trashPath && (await pathIsFile(trashPath))) {
          candidate = `${base} (${counter})${ext}`;
          counter += 1;
          continue;
        }
        if (reservedNames) reservedNames.add(candidate);
        return { fileName: candidate, filePath: candidatePath };
      }
      throw error;
    }
  }
}

async function nextNumberedFileName(dir, prefix, ext, pattern) {
  const safeExt = ext && ext.startsWith(".") ? ext : `.${String(ext || "bin").replace(/^\.+/, "")}`;
  let maxN = 0;
  try {
    const entries = await readdir(dir);
    for (const name of entries) {
      const match = name.match(pattern);
      if (!match) continue;
      const value = Number.parseInt(match[1], 10);
      if (Number.isFinite(value) && value > maxN) maxN = value;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return `${prefix}${maxN + 1}${safeExt}`;
}

function nextGeneratedImageName(dir, ext = ".png") {
  return nextNumberedFileName(dir, "Image", ext, /^Image(\d+)\./);
}

function nextGeneratedVideoName(dir, ext = ".mp4") {
  return nextNumberedFileName(dir, "Video", ext, /^Video(\d+)\./);
}

function nextGeneratedSubtitleName(dir) {
  return nextNumberedFileName(dir, "SRT", ".srt", /^SRT(\d+)(?:\s+\(\d+\))?\.srt$/i);
}

export function getImageDimensionsFromBuffer(buffer, label = "image") {
  if (buffer.length >= 24 && buffer.toString("ascii", 1, 4) === "PNG") {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 10 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset < buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      const size = buffer.readUInt16BE(offset + 2);
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      }
      offset += 2 + size;
    }
  }
  if (buffer.length >= 30 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buffer.toString("ascii", 12, 16);
    if (chunk === "VP8X") {
      return {
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3),
      };
    }
  }
  throw new Error(`Could not read image dimensions for ${label}. Pass displayWidth/displayHeight and use a PNG/JPEG/WebP source.`);
}

async function getImageDimensions(filePath) {
  return getImageDimensionsFromBuffer(await readFile(filePath), filePath);
}

function elementBounds(element) {
  return {
    x: finiteNumber(element.x, 0),
    y: finiteNumber(element.y, 0),
    width: Math.max(1, finiteNumber(element.width, 1)),
    height: Math.max(1, finiteNumber(element.height, 1)),
  };
}

function rectsOverlap(a, b, padding = 0) {
  return !(
    a.x + a.width + padding <= b.x ||
    b.x + b.width + padding <= a.x ||
    a.y + a.height + padding <= b.y ||
    b.y + b.height + padding <= a.y
  );
}

function choosePlacement({ scene, anchorElement, width, height, margin, placement }) {
  const anchorBounds = anchorElement ? elementBounds(anchorElement) : null;
  if ((placement === "replace" || placement === "inside") && anchorBounds) {
    return { ...anchorBounds };
  }
  let x = anchorBounds ? anchorBounds.x + anchorBounds.width + margin : 0;
  let y = anchorBounds ? anchorBounds.y : 0;

  if (placement === "left" && anchorBounds) x = anchorBounds.x - width - margin;
  if (placement === "below" && anchorBounds) {
    x = anchorBounds.x;
    y = anchorBounds.y + anchorBounds.height + margin;
  }

  const obstacles = scene.elements.filter((element) => !element.isDeleted && element.id !== anchorElement?.id).map(elementBounds);
  const stepX = Math.max(width + margin, 1);
  const stepY = Math.max(height + margin, 1);
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const candidate = { x, y, width, height };
    if (!obstacles.some((bounds) => rectsOverlap(candidate, bounds, margin / 2))) return candidate;
    if (placement === "below") y += stepY;
    else if (placement === "left") x -= stepX;
    else x += stepX;
  }

  return { x, y, width, height };
}

function chooseIndex(elements) {
  const indexes = elements
    .filter((element) => element && !element.isDeleted)
    .map((element) => element.index)
    .filter((index) => typeof index === "string")
    .sort();

  while (indexes.length) {
    const index = indexes.at(-1);
    try {
      return generateKeyBetween(index, null);
    } catch {
      indexes.pop();
    }
  }
  return generateKeyBetween(null, null);
}

function chooseIndexAfter(elements, previousIndex) {
  const indexes = elements
    .filter((element) => element && !element.isDeleted)
    .map((element) => element.index)
    .filter((index) => typeof index === "string")
    .sort();
  const nextIndex = indexes.find((index) => previousIndex && index > previousIndex) ?? null;

  try {
    return generateKeyBetween(previousIndex ?? indexes.at(-1) ?? null, nextIndex);
  } catch {
    return chooseIndex(elements);
  }
}

function firstSelectedElementId(selection, scene) {
  if (Array.isArray(selection?.selectedElementIds) && selection.selectedElementIds.length === 1) {
    return selection.selectedElementIds[0];
  }
  const fromScene = selectedIdsFromScene(scene);
  return fromScene.length === 1 ? fromScene[0] : null;
}

function newImageElementRecord({ id, fileId, index, bounds, customData, link = null }) {
  const now = Date.now();
  return {
    id,
    type: "image",
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    angle: 0,
    strokeColor: "transparent",
    backgroundColor: "transparent",
    fillStyle: "hachure",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: Math.floor(Math.random() * 2 ** 31),
    version: 1,
    versionNonce: Math.floor(Math.random() * 2 ** 31),
    isDeleted: false,
    boundElements: null,
    updated: now,
    link,
    locked: false,
    index,
    fileId,
    status: "saved",
    scale: [1, 1],
    crop: null,
    customData,
  };
}

function videoPlaceholderDataURL({ width, height, label = "Video" }) {
  const safeWidth = Math.max(1, Math.round(Number(width) || 1280));
  const safeHeight = Math.max(1, Math.round(Number(height) || 720));
  const iconSize = Math.max(28, Math.min(160, Math.round(Math.min(safeWidth, safeHeight) * 0.26)));
  const iconX = Math.round((safeWidth - iconSize) / 2);
  const iconY = Math.round((safeHeight - iconSize) / 2);
  const text = String(label || "Video").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  })[char]);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${safeWidth}" height="${safeHeight}" viewBox="0 0 ${safeWidth} ${safeHeight}"><rect width="100%" height="100%" fill="#e8ddf5"/><rect x="${iconX}" y="${iconY}" width="${iconSize}" height="${iconSize}" rx="${Math.round(iconSize * 0.14)}" fill="none" stroke="#b89de0" stroke-width="${Math.max(6, Math.round(iconSize * 0.07))}"/><path d="M ${Math.round(iconX + iconSize * 0.42)} ${Math.round(iconY + iconSize * 0.32)} L ${Math.round(iconX + iconSize * 0.42)} ${Math.round(iconY + iconSize * 0.68)} L ${Math.round(iconX + iconSize * 0.72)} ${Math.round(iconY + iconSize * 0.5)} Z" fill="#b89de0"/><text x="${Math.round(safeWidth / 2)}" y="${Math.round(safeHeight - Math.max(22, safeHeight * 0.08))}" text-anchor="middle" font-family="Arial, sans-serif" font-size="${Math.max(18, Math.round(Math.min(safeWidth, safeHeight) * 0.06))}" fill="#8f80a6">${text}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function resolveFfmpegPath() {
  return nonEmptyString(process.env.FFMPEG_PATH) || "ffmpeg";
}

function runFfmpeg(args, timeoutMs = 60_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(resolveFfmpegPath(), args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      rejectPromise(new Error("ffmpeg timed out extracting a video poster."));
    }, timeoutMs);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(stderr.trim().slice(-400) || `ffmpeg exited with code ${code}`));
    });
  });
}

function videoPosterSeekTimes() {
  return [0.5, 1.2, 2.5, 4, 8, 0.1];
}

export async function extractVideoPosterDataURL({ path, buffer }, { maxWidth = 512, quality = 5 } = {}) {
  const tempDir = join(tmpdir(), "codex-excalidraw-posters");
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const cleanup = [];
  try {
    await mkdir(tempDir, { recursive: true });
    let inputPath = nonEmptyString(path);
    if (!inputPath) {
      if (!Buffer.isBuffer(buffer)) return null;
      inputPath = join(tempDir, `poster-src-${stamp}.mp4`);
      await writeFile(inputPath, buffer);
      cleanup.push(inputPath);
    }
    let bestPosterData = null;
    for (const [index, time] of videoPosterSeekTimes().entries()) {
      const outputPath = join(tempDir, `poster-${stamp}-${index}.jpg`);
      cleanup.push(outputPath);
      const outputArgs = ["-ss", String(time), "-frames:v", "1", "-vf", `scale='min(${maxWidth},iw)':-2`, "-q:v", String(quality), "-f", "image2", outputPath];
      try {
        await runFfmpeg(["-y", "-v", "error", "-i", inputPath, ...outputArgs], 30_000);
        const posterData = await readFile(outputPath);
        if (posterData.length > (bestPosterData?.length || 0)) bestPosterData = posterData;
      } catch {
        // The seek may be past the end of short videos. Try the next candidate.
      }
    }
    if (!bestPosterData) {
      const outputPath = join(tempDir, `poster-${stamp}-fallback.jpg`);
      cleanup.push(outputPath);
      const outputArgs = ["-frames:v", "1", "-vf", `scale='min(${maxWidth},iw)':-2`, "-q:v", String(quality), "-f", "image2", outputPath];
      await runFfmpeg(["-y", "-v", "error", "-i", inputPath, ...outputArgs], 30_000);
      bestPosterData = await readFile(outputPath);
    }
    if (!bestPosterData || bestPosterData.length === 0) return null;
    return `data:image/jpeg;base64,${bestPosterData.toString("base64")}`;
  } catch {
    return null;
  } finally {
    for (const file of cleanup) {
      rm(file, { force: true }).catch(() => {});
    }
  }
}

function newRectangleElementRecord({ id, index, bounds, groupId, assetUrl, customData }) {
  const now = Date.now();
  return {
    id,
    type: "rectangle",
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    angle: 0,
    // Invisible under the SRT preview overlay: the overlay draws the card,
    // the element only provides geometry/selection.
    // BuzzAssist subtitle-card chrome: a solid fill makes the card's
    // interior grabbable (transparent fills are only hit on their stroke,
    // which made SRT cards effectively immovable).
    strokeColor: "#d9d9d9",
    backgroundColor: "#faf8ff",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: groupId ? [groupId] : [],
    frameId: null,
    roundness: { type: 3 },
    seed: Math.floor(Math.random() * 2 ** 31),
    version: 1,
    versionNonce: Math.floor(Math.random() * 2 ** 31),
    isDeleted: false,
    boundElements: null,
    updated: now,
    link: null,
    locked: false,
    index,
    customData,
  };
}

function newTextElementRecord({ id, index, bounds, groupId, assetUrl, text, customData }) {
  const now = Date.now();
  const textBounds = {
    x: bounds.x + 22,
    y: bounds.y + Math.max(18, Math.round(bounds.height / 2 - 42)),
    width: Math.max(80, bounds.width - 44),
    height: 84,
  };
  return {
    id,
    type: "text",
    x: textBounds.x,
    y: textBounds.y,
    width: textBounds.width,
    height: textBounds.height,
    angle: 0,
    strokeColor: "#0b7285",
    backgroundColor: "transparent",
    fillStyle: "hachure",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [groupId],
    frameId: null,
    roundness: null,
    seed: Math.floor(Math.random() * 2 ** 31),
    version: 1,
    versionNonce: Math.floor(Math.random() * 2 ** 31),
    isDeleted: false,
    boundElements: null,
    updated: now,
    link: null,
    locked: false,
    index,
    fontSize: Math.max(16, Math.min(26, Math.round(bounds.width / 18))),
    fontFamily: 1,
    text,
    rawText: text,
    textAlign: "center",
    verticalAlign: "middle",
    containerId: null,
    originalText: text,
    autoResize: false,
    lineHeight: 1.25,
    customData,
  };
}

function parseAspectRatio(value, fallback = 16 / 9) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/);
  if (!match) return fallback;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? width / height : fallback;
}

async function readMediaSource({ path, buffer }) {
  if (Buffer.isBuffer(buffer)) return buffer;
  const sourcePath = nonEmptyString(path);
  if (!sourcePath) throw new Error("A media path or media buffer is required.");
  const resolvedPath = pathResolve(sourcePath);
  const sourceStat = await stat(resolvedPath);
  if (!sourceStat.isFile()) throw new Error(`Media path is not a file: ${resolvedPath}`);
  return readFile(resolvedPath);
}

function resolveAnchor(scene, selection, args = {}) {
  const elementsById = new Map(scene.elements.map((element) => [element.id, element]));
  const anchorElementId = nonEmptyString(args.anchorElementId) || nonEmptyString(args.sourceElementId) || firstSelectedElementId(selection, scene);
  const anchorElement = anchorElementId ? elementsById.get(anchorElementId) : null;
  if (anchorElementId && !anchorElement) throw new Error(`Missing anchor element: ${anchorElementId}`);
  return { anchorElementId, anchorElement };
}

export async function insertExcalidrawImage(args = {}) {
  const imagePath = nonEmptyString(args.imagePath);
  const sourceImagePath = imagePath ? pathResolve(imagePath) : null;
  const fileData = await readMediaSource({ path: sourceImagePath, buffer: args.mediaBuffer });

  const scene = await loadScene(args);
  const { selection } = await readSelectionState(args);
  const { anchorElementId, anchorElement } = resolveAnchor(scene, selection, args);

  const imageSize = args.imageSize && finiteNumber(args.imageSize.width, 0) > 0 && finiteNumber(args.imageSize.height, 0) > 0
    ? { width: args.imageSize.width, height: args.imageSize.height }
    : getImageDimensionsFromBuffer(fileData, sourceImagePath ?? args.fileName ?? "generated image");
  const anchorBounds = anchorElement ? elementBounds(anchorElement) : null;
  const matchAnchor = args.matchAnchor !== false && anchorBounds;
  const width = finiteNumber(args.displayWidth, matchAnchor ? anchorBounds.width : Math.min(imageSize.width, 512));
  const height = finiteNumber(args.displayHeight, matchAnchor ? anchorBounds.height : Math.round(width * (imageSize.height / imageSize.width)));
  const margin = Math.max(0, finiteNumber(args.margin, 40));
  const replaceAnchor = Boolean(args.replaceAnchor) && anchorElement;
  const placement = replaceAnchor ? "replace" : (["right", "left", "below", "replace", "inside"].includes(args.placement) ? args.placement : "right");
  const bounds = choosePlacement({ scene, anchorElement, width, height, margin, placement });

  const canvasDir = resolveCanvasDir(args);
  const assetsDir = join(canvasDir, "assets");
  if (!isSafeChildPath(canvasDir, assetsDir)) throw new Error(`Unsafe assets directory: ${assetsDir}`);

  const fallbackExt = extForMimeType(args.mimeType, sourceImagePath ? extname(sourceImagePath) || ".png" : ".png");
  const requestedName = args.fileName || (sourceImagePath ? basename(sourceImagePath) : await nextGeneratedImageName(assetsDir, fallbackExt));
  const { fileName, filePath } = await uniqueFilePath(assetsDir, requestedName);
  const mimeType = args.mimeType || mimeTypeForFile(fileName);
  const assetUrl = `${ASSETS_ROUTE}${encodeURIComponent(fileName)}`;
  // The asset is always written to canvas/assets, so reference it by URL
  // instead of embedding megabytes of base64 into the scene JSON. The browser
  // hydrates URL-style dataURLs back to base64 on load.
  const dataURL = nonEmptyString(args.dataURL) || assetUrl;
  const existingIds = new Set([
    ...scene.elements.map((element) => element.id),
    ...Object.keys(scene.files ?? {}),
  ]);
  const recordSeed = sanitizeIdPart(fileName);
  const fileId = uniqueId(existingIds, "file", recordSeed);
  const elementId = uniqueId(existingIds, "element", recordSeed);
  const index = chooseIndex(scene.elements);
  const customData = {
    codexInsertedImage: true,
    codexMediaKind: "image",
    codexFileName: fileName,
    codexAssetPath: filePath,
    codexAssetUrl: assetUrl,
    codexAssetMimeType: mimeType,
    codexPixelWidth: imageSize.width,
    codexPixelHeight: imageSize.height,
    ...(anchorElementId ? { codexAnchorElementId: anchorElementId } : {}),
    ...(args.customData && typeof args.customData === "object" ? args.customData : {}),
  };

  const imageElement = newImageElementRecord({
    id: elementId,
    fileId,
    index,
    bounds,
    customData,
  });
  const fileRecord = {
    id: fileId,
    name: fileName,
    mimeType,
    dataURL,
    ...(dataURL === assetUrl ? { codexAssetBacked: true } : {}),
    created: Date.now(),
    lastRetrieved: Date.now(),
  };

  if (!args.dryRun) {
    await mkdir(assetsDir, { recursive: true });
    await writeFile(filePath, fileData);
    if (replaceAnchor) {
      scene.elements = scene.elements.map((element) =>
        element.id === anchorElementId
          ? {
              ...element,
              isDeleted: true,
              version: (Number(element.version) || 1) + 1,
              versionNonce: Math.floor(Math.random() * 2 ** 31),
              updated: Date.now(),
            }
          : element,
      );
    }
    scene.files[fileId] = fileRecord;
    scene.elements.push(imageElement);
    scene.appState = {
      ...scene.appState,
      selectedElementIds: { [elementId]: true },
    };
    await saveScene(args, scene);
  }

  return {
    elementId,
    fileId,
    anchorElementId,
    sourceImagePath,
    fileName,
    assetFile: filePath,
    assetUrl: customData.codexAssetUrl,
    imageSize,
    bounds,
    mimeType,
    replacedAnchor: replaceAnchor,
    dryRun: Boolean(args.dryRun),
  };
}

export async function insertExcalidrawVideo(args = {}) {
  const videoPath = nonEmptyString(args.videoPath);
  const sourceVideoPath = videoPath ? pathResolve(videoPath) : null;
  const fileData = await readMediaSource({ path: sourceVideoPath, buffer: args.mediaBuffer });

  const scene = await loadScene(args);
  const { selection } = await readSelectionState(args);
  const { anchorElementId, anchorElement } = resolveAnchor(scene, selection, args);
  const anchorBounds = anchorElement ? elementBounds(anchorElement) : null;
  const aspect = parseAspectRatio(args.aspectRatio, 16 / 9);
  const matchAnchor = args.matchAnchor !== false && anchorBounds;
  const width = finiteNumber(args.displayWidth, matchAnchor ? anchorBounds.width : 560);
  const height = finiteNumber(args.displayHeight, matchAnchor ? anchorBounds.height : Math.round(width / aspect));
  const margin = Math.max(0, finiteNumber(args.margin, 40));
  const replaceAnchor = Boolean(args.replaceAnchor) && anchorElement;
  const placement = replaceAnchor ? "replace" : (["right", "left", "below", "replace", "inside"].includes(args.placement) ? args.placement : "right");
  const bounds = choosePlacement({ scene, anchorElement, width, height, margin, placement });

  const canvasDir = resolveCanvasDir(args);
  const assetsDir = join(canvasDir, "assets");
  if (!isSafeChildPath(canvasDir, assetsDir)) throw new Error(`Unsafe assets directory: ${assetsDir}`);

  const fallbackExt = extForMimeType(args.mimeType, sourceVideoPath ? extname(sourceVideoPath) || ".mp4" : ".mp4");
  const requestedName = args.fileName || (sourceVideoPath ? basename(sourceVideoPath) : await nextGeneratedVideoName(assetsDir, fallbackExt));
  const { fileName, filePath } = await uniqueFilePath(assetsDir, requestedName);
  const mimeType = args.mimeType || mimeTypeForFile(fileName);
  const assetUrl = `${ASSETS_ROUTE}${encodeURIComponent(fileName)}`;
  const existingIds = new Set(scene.elements.map((element) => element.id));
  const recordSeed = sanitizeIdPart(fileName);
  const elementId = uniqueId(existingIds, "video", recordSeed);
  const fileId = uniqueId(
    new Set([
      ...Object.keys(scene.files ?? {}),
      ...scene.elements.map((element) => element.fileId).filter(Boolean),
    ]),
    "file",
    recordSeed,
  );
  const index = chooseIndex(scene.elements);
  const pixelWidth = Math.max(1, Math.round(width * 4));
  const pixelHeight = Math.max(1, Math.round(height * 4));
  const posterDataURL =
    args.posterDataURL ||
    (await extractVideoPosterDataURL({ path: sourceVideoPath, buffer: fileData })) ||
    videoPlaceholderDataURL({ width: pixelWidth, height: pixelHeight, label: "Video" });
  const customData = {
    codexInsertedVideo: true,
    codexGeneratedVideo: true,
    codexMediaKind: "video",
    codexFileName: fileName,
    codexAssetPath: filePath,
    codexAssetUrl: assetUrl,
    codexVideoMimeType: mimeType,
    codexVideoDuration: finiteNumber(Number(args.duration), 0),
    codexPixelWidth: pixelWidth,
    codexPixelHeight: pixelHeight,
    ...(anchorElementId ? { codexAnchorElementId: anchorElementId } : {}),
    ...(args.prompt ? { codexGenerationPrompt: args.prompt } : {}),
    ...(args.model ? { codexGenerationModel: args.model } : {}),
    ...(args.customData && typeof args.customData === "object" ? args.customData : {}),
  };

  const videoElement = newImageElementRecord({
    id: elementId,
    fileId,
    index,
    bounds,
    customData,
    link: null,
  });
  const fileRecord = {
    id: fileId,
    name: fileName,
    mimeType: posterDataURL.startsWith("data:image/jpeg") ? "image/jpeg" : "image/svg+xml",
    dataURL: posterDataURL,
    created: Date.now(),
    lastRetrieved: Date.now(),
  };

  if (!args.dryRun) {
    await mkdir(assetsDir, { recursive: true });
    await writeFile(filePath, fileData);
    if (replaceAnchor) {
      scene.elements = scene.elements.map((element) =>
        element.id === anchorElementId
          ? {
              ...element,
              isDeleted: true,
              version: (Number(element.version) || 1) + 1,
              versionNonce: Math.floor(Math.random() * 2 ** 31),
              updated: Date.now(),
            }
          : element,
      );
    }
    scene.files = scene.files && typeof scene.files === "object" ? scene.files : {};
    scene.files[fileId] = fileRecord;
    scene.elements.push(videoElement);
    scene.appState = {
      ...scene.appState,
      selectedElementIds: { [elementId]: true },
    };
    await saveScene(args, scene);
  }

  return {
    elementId,
    fileId,
    anchorElementId,
    sourceVideoPath,
    assetFile: filePath,
    assetUrl,
    bounds,
    mimeType,
    replacedAnchor: replaceAnchor,
    dryRun: Boolean(args.dryRun),
  };
}

export async function insertExcalidrawSubtitle(args = {}) {
  const srtText = nonEmptyString(args.srtText);
  if (!srtText) throw new Error("srtText is required.");

  const scene = await loadScene(args);
  const { selection } = await readSelectionState(args);
  const { anchorElementId, anchorElement } = resolveAnchor(scene, selection, args);
  const anchorBounds = anchorElement ? elementBounds(anchorElement) : null;
  const matchAnchor = args.matchAnchor === true && anchorBounds;
  // BuzzAssist subtitle-card default footprint (205x364).
  const width = finiteNumber(args.displayWidth, matchAnchor ? anchorBounds.width : 205);
  const height = finiteNumber(args.displayHeight, matchAnchor ? anchorBounds.height : 364);
  const margin = Math.max(0, finiteNumber(args.margin, 40));
  const replaceAnchor = Boolean(args.replaceAnchor) && anchorElement;
  const placement = replaceAnchor ? "replace" : (["right", "left", "below", "replace", "inside"].includes(args.placement) ? args.placement : "below");
  const bounds = choosePlacement({ scene, anchorElement, width, height, margin, placement });

  const canvasDir = resolveCanvasDir(args);
  const assetsDir = join(canvasDir, "assets");
  if (!isSafeChildPath(canvasDir, assetsDir)) throw new Error(`Unsafe assets directory: ${assetsDir}`);

  const requestedName = args.fileName || await nextGeneratedSubtitleName(assetsDir);
  const { fileName, filePath } = await uniqueFilePath(assetsDir, requestedName.endsWith(".srt") ? requestedName : `${requestedName}.srt`);
  const assetUrl = `${ASSETS_ROUTE}${encodeURIComponent(fileName)}`;

  const subtitleLines = Array.isArray(args.subtitleLines) ? args.subtitleLines : [];

  const existingIds = new Set(scene.elements.map((element) => element.id));
  const recordSeed = sanitizeIdPart(fileName);
  const cardElementId = uniqueId(existingIds, "subtitle", recordSeed);
  const cardIndex = chooseIndex(scene.elements);
  const customData = {
    codexGeneratedSubtitle: true,
    codexMediaKind: "subtitle",
    codexFileName: fileName,
    codexAssetPath: filePath,
    codexAssetUrl: assetUrl,
    subtitleCueCount: subtitleLines.length,
    ...(args.model ? { subtitleModel: args.model } : {}),
    ...(args.mode ? { subtitleMode: args.mode } : {}),
    ...(anchorElementId ? { codexAnchorElementId: anchorElementId } : {}),
    ...(args.customData && typeof args.customData === "object" ? args.customData : {}),
  };

  // Single element (no group): grouped members get dashed per-element
  // selection borders in Excalidraw, which Youtube-AGI's subtitle cards do
  // not show. The SRT content itself is rendered by the browser overlay.
  const cardElement = newRectangleElementRecord({
    id: cardElementId,
    index: cardIndex,
    bounds,
    groupId: null,
    assetUrl,
    customData,
  });

  if (!args.dryRun) {
    await mkdir(assetsDir, { recursive: true });
    await writeFile(filePath, srtText.endsWith("\n") ? srtText : `${srtText}\n`);
    if (replaceAnchor) {
      scene.elements = scene.elements.map((element) =>
        element.id === anchorElementId
          ? {
              ...element,
              isDeleted: true,
              version: (Number(element.version) || 1) + 1,
              versionNonce: Math.floor(Math.random() * 2 ** 31),
              updated: Date.now(),
            }
          : element,
      );
    }
    scene.elements.push(cardElement);
    scene.appState = {
      ...scene.appState,
      selectedElementIds: { [cardElementId]: true },
    };
    await saveScene(args, scene);
  }

  return {
    elementId: cardElementId,
    anchorElementId,
    assetFile: filePath,
    assetUrl,
    bounds,
    cueCount: subtitleLines.length,
    replacedAnchor: replaceAnchor,
    dryRun: Boolean(args.dryRun),
  };
}

export async function insertExcalidrawSilenceCutResult(args = {}) {
  const assetPath = nonEmptyString(args.assetPath || args.outputPath);
  if (!assetPath) throw new Error("assetPath is required.");

  const scene = await loadScene(args);
  const { selection } = await readSelectionState(args);
  const { anchorElementId, anchorElement } = resolveAnchor(scene, selection, args);
  const anchorBounds = anchorElement ? elementBounds(anchorElement) : null;
  const matchAnchor = args.matchAnchor === true && anchorBounds;
  // XML is a text document, so use the same portrait editor-card footprint
  // as generated SRT files. `matchAnchor` remains available to explicit MCP
  // callers, but the canvas UI intentionally replaces its landscape utility
  // generator with this centered portrait result.
  const width = finiteNumber(args.displayWidth, matchAnchor ? anchorBounds.width : SUBTITLE_CARD_WIDTH);
  const height = finiteNumber(args.displayHeight, matchAnchor ? anchorBounds.height : SUBTITLE_CARD_HEIGHT);
  const margin = Math.max(0, finiteNumber(args.margin, 40));
  const replaceAnchor = Boolean(args.replaceAnchor && anchorElement);
  const placement = replaceAnchor ? "replace" : (["right", "left", "below", "replace", "inside"].includes(args.placement) ? args.placement : "below");
  const placementBounds = choosePlacement({ scene, anchorElement, width, height, margin, placement });
  const bounds = replaceAnchor && !matchAnchor && anchorBounds
    ? {
        x: anchorBounds.x + (anchorBounds.width - width) / 2,
        y: anchorBounds.y + (anchorBounds.height - height) / 2,
        width,
        height,
      }
    : placementBounds;

  const canvasDir = resolveCanvasDir(args);
  const assetsDir = join(canvasDir, "assets");
  const filePath = pathResolve(assetPath);
  if (!isSafeChildPath(assetsDir, filePath)) throw new Error(`Unsafe silence-cut asset path: ${filePath}`);

  const fileName = sanitizeFileName(args.fileName || basename(filePath), "jetcut.xml");
  const assetUrl = nonEmptyString(args.assetUrl) || `${ASSETS_ROUTE}${encodeURIComponent(fileName)}`;
  const existingIds = new Set([
    ...scene.elements.map((element) => element.id),
    ...Object.keys(scene.files ?? {}),
  ]);
  const recordSeed = sanitizeIdPart(fileName, "silence-cut");
  const elementId = uniqueId(existingIds, "silence-cut", recordSeed);
  const index = chooseIndex(scene.elements);
  const outputAsset = {
    id: `xml-${recordSeed}-${Date.now().toString(36)}`,
    name: fileName,
    kind: "xml",
    mimeType: mimeTypeForFile(filePath),
    path: filePath,
    url: assetUrl,
    dataURL: "",
    thumbnail: "",
    duration: 0,
  };
  const inputAsset = args.inputAsset && typeof args.inputAsset === "object" ? args.inputAsset : null;
  const customData = {
    codexInsertedAttachment: true,
    codexGeneratedSilenceCut: true,
    codexMediaKind: "xml",
    codexFileName: fileName,
    codexAssetPath: filePath,
    codexAssetUrl: assetUrl,
    codexAssetMimeType: outputAsset.mimeType,
    codexTextPreview: true,
    silenceCutModel: args.model || "ffmpeg-local",
    ...(Number.isFinite(Number(args.inputDuration)) ? { silenceCutInputDuration: Number(args.inputDuration) } : {}),
    ...(Number.isFinite(Number(args.outputDuration)) ? { silenceCutOutputDuration: Number(args.outputDuration) } : {}),
    ...(Number.isFinite(Number(args.cutDuration)) ? { silenceCutCutDuration: Number(args.cutDuration) } : {}),
    ...(Number.isFinite(Number(args.cutCount)) ? { silenceCutCutCount: Number(args.cutCount) } : {}),
    ...(Number.isFinite(Number(args.clipCount)) ? { silenceCutClipCount: Number(args.clipCount) } : {}),
    ...(Number.isFinite(Number(args.thresholdDbUsed)) ? { silenceCutThresholdDb: Number(args.thresholdDbUsed) } : {}),
    ...(args.thresholdAuto !== undefined ? { silenceCutThresholdAuto: Boolean(args.thresholdAuto) } : {}),
    ...(inputAsset ? { silenceCutVideoAsset: inputAsset } : {}),
    silenceCutOutputAsset: outputAsset,
    ...(anchorElementId ? { codexAnchorElementId: anchorElementId } : {}),
    ...(args.customData && typeof args.customData === "object" ? args.customData : {}),
  };

  // The browser renders the XML source in the same editor-style overlay as
  // SRT. A rectangle supplies selection/geometry while the actual .xml stays
  // as the downloadable backing asset.
  const resultElement = newRectangleElementRecord({
    id: elementId,
    index,
    bounds,
    groupId: null,
    assetUrl,
    customData,
  });

  if (!args.dryRun) {
    if (replaceAnchor) {
      scene.elements = scene.elements.map((element) =>
        element.id === anchorElementId
          ? {
              ...element,
              isDeleted: true,
              version: (Number(element.version) || 1) + 1,
              versionNonce: Math.floor(Math.random() * 2 ** 31),
              updated: Date.now(),
            }
          : element,
      );
    }
    scene.elements.push(resultElement);
    scene.appState = {
      ...scene.appState,
      selectedElementIds: { [elementId]: true },
    };
    await saveScene(args, scene);
  }

  return {
    elementId,
    anchorElementId,
    assetFile: filePath,
    assetUrl,
    bounds,
    outputAsset,
    replacedAnchor: replaceAnchor,
    dryRun: Boolean(args.dryRun),
  };
}

function sceneContentBottomAnchor(scene) {
  const bounds = scene.elements
    .filter((element) => element && !element.isDeleted)
    .map(elementBounds);
  if (bounds.length === 0) return { x: 0, y: 0 };
  const minX = Math.min(...bounds.map((bound) => bound.x));
  const maxBottom = Math.max(...bounds.map((bound) => bound.y + bound.height));
  return { x: minX, y: maxBottom };
}

function boundsForRects(rects) {
  if (!Array.isArray(rects) || rects.length === 0) return null;
  const left = Math.min(...rects.map((rect) => finiteNumber(rect.x, 0)));
  const top = Math.min(...rects.map((rect) => finiteNumber(rect.y, 0)));
  const right = Math.max(...rects.map((rect) => finiteNumber(rect.x, 0) + Math.max(1, finiteNumber(rect.width, 1))));
  const bottom = Math.max(...rects.map((rect) => finiteNumber(rect.y, 0) + Math.max(1, finiteNumber(rect.height, 1))));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function resolveGeneratorFrameSize(kind, item = {}) {
  if (kind === "video") {
    const ratio = String(item.aspectRatio ?? item.aspect_ratio ?? "16:9");
    return VIDEO_FRAME_SIZES[ratio] ?? VIDEO_FRAME_SIZES["16:9"];
  }
  const ratio = String(item.aspectRatio ?? item.aspect_ratio ?? "1:1");
  const base = IMAGE_FRAME_SIZES[ratio] ?? IMAGE_FRAME_SIZES["1:1"];
  return {
    width: Math.max(140, Math.min(980, Math.round(base.baseWidth * 0.25))),
    height: Math.max(140, Math.min(980, Math.round(base.baseHeight * 0.25))),
    pixelWidth: base.baseWidth,
    pixelHeight: base.baseHeight,
  };
}

function newGeneratorFrameRecord({ id, index, bounds, kind, customData }) {
  const now = Date.now();
  const frameTag = kind === "video"
    ? VIDEO_GENERATOR_FRAME_TAG
    : kind === "silenceCut"
      ? SILENCE_CUT_GENERATOR_FRAME_TAG
      : GENERATOR_FRAME_TAG;
  return {
    id,
    type: "rectangle",
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    angle: 0,
    strokeColor: GENERATOR_FRAME_BORDER_COLOR,
    backgroundColor: GENERATOR_FRAME_FILL_COLOR,
    fillStyle: "solid",
    strokeWidth: GENERATOR_FRAME_STROKE_WIDTH,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    // Square corners, matching UI-created generator frames (BuzzAssist).
    roundness: null,
    seed: Math.floor(Math.random() * 2 ** 31),
    version: 1,
    versionNonce: Math.floor(Math.random() * 2 ** 31),
    isDeleted: false,
    boundElements: null,
    updated: now,
    link: null,
    locked: false,
    index,
    customData: {
      [frameTag]: true,
      role: "frame",
      // Batch placeholders show the Generating... overlay in the browser
      // until the result replaces them (cleared on failure).
      codexGenerating: true,
      ...customData,
    },
  };
}

// Remove the Generating flag from frames whose batch job failed, so the
// browser stops showing the spinner on a frame that will never fill.
export async function clearFrameGeneratingFlags(args = {}, elementIds = []) {
  const ids = new Set(elementIds.filter(Boolean));
  if (ids.size === 0) return { cleared: 0 };
  const scene = await loadScene(args);
  let cleared = 0;
  scene.elements = scene.elements.map((element) => {
    if (!ids.has(element.id) || !element?.customData?.codexGenerating) return element;
    cleared += 1;
    const { codexGenerating, ...rest } = element.customData;
    return {
      ...element,
      customData: rest,
      version: (Number(element.version) || 1) + 1,
      versionNonce: Math.floor(Math.random() * 2 ** 31),
      updated: Date.now(),
    };
  });
  if (cleared > 0) await saveScene(args, scene);
  return { cleared };
}

export async function insertGeneratorFrameBatch(args = {}) {
  const frames = Array.isArray(args.frames) ? args.frames : [];
  if (frames.length === 0) throw new Error("insertGeneratorFrameBatch requires a non-empty frames array.");

  const columns = Math.max(1, Math.round(finiteNumber(Number(args.columns), 5)));
  // Batch chunks contain at most ten jobs. Fill each row first so the default
  // layout is five columns x two rows: item 1-5 in the first row and item 6-10
  // in the second row.
  const gap = Math.max(0, finiteNumber(Number(args.gap), 24));
  const scene = await loadScene(args);
  const anchorElementId = nonEmptyString(args.anchorElementId) || nonEmptyString(args.sourceElementId);
  const anchorElement = anchorElementId
    ? scene.elements.find((element) => element.id === anchorElementId && !element.isDeleted)
    : null;
  if (anchorElementId && !anchorElement) throw new Error(`Missing anchor element: ${anchorElementId}`);
  const anchorBounds = anchorElement ? elementBounds(anchorElement) : null;
  const matchAnchor = args.matchAnchor !== false && anchorBounds;
  const sizes = frames.map((frame) => {
    const resolved = resolveGeneratorFrameSize(frame.kind === "video" ? "video" : "image", frame);
    return matchAnchor
      ? { ...resolved, width: anchorBounds.width, height: anchorBounds.height }
      : resolved;
  });
  const cellW = Math.max(1, ...sizes.map((size) => size.width));
  const cellH = Math.max(1, ...sizes.map((size) => size.height));
  const anchor = sceneContentBottomAnchor(scene);
  const usedColumns = Math.max(1, Math.min(columns, frames.length));
  const usedRows = Math.max(1, Math.ceil(frames.length / columns));
  const gridWidth = usedColumns * cellW + Math.max(0, usedColumns - 1) * gap;
  const gridHeight = usedRows * cellH + Math.max(0, usedRows - 1) * gap;
  const margin = Math.max(0, finiteNumber(Number(args.margin), 40));
  const placement = ["right", "left", "below", "replace", "inside"].includes(args.placement)
    ? args.placement
    : "right";
  const placedGrid = anchorElement
    ? choosePlacement({ scene, anchorElement, width: gridWidth, height: gridHeight, margin, placement })
    : null;
  const startX = finiteNumber(Number(args.x), placedGrid?.x ?? anchor.x);
  const startY = finiteNumber(
    Number(args.y),
    placedGrid?.y ?? (scene.elements.some((element) => element && !element.isDeleted) ? anchor.y + gap : anchor.y),
  );
  const existingIds = new Set(scene.elements.map((element) => element.id));
  const newElements = [];
  const results = [];
  let previousIndex = null;

  for (let i = 0; i < frames.length; i += 1) {
    const frame = frames[i] ?? {};
    const kind = frame.kind === "video" ? "video" : "image";
    const size = sizes[i];
    const col = i % columns;
    const row = Math.floor(i / columns);
    const bounds = {
      x: startX + col * (cellW + gap),
      y: startY + row * (cellH + gap),
      width: size.width,
      height: size.height,
    };
    const id = uniqueId(existingIds, kind === "video" ? "video_generator" : "image_generator", `${Date.now()}_${i + 1}`);
    const index = chooseIndexAfter(scene.elements, previousIndex);
    previousIndex = index;
    const customData = kind === "video"
      ? {
          videoPrompt: frame.prompt ?? "",
          videoModel: frame.model ?? "grok-imagine-video-hermes",
          videoAspectRatio: frame.aspectRatio ?? frame.aspect_ratio ?? "16:9",
          videoDuration: frame.duration ?? "6",
          videoResolution: frame.resolution ?? "720p",
          videoGenerateAudio: frame.generateAudio ?? frame.generate_audio ?? true,
          videoTab: frame.videoTab ?? "keyframe",
          ...(frame.customData && typeof frame.customData === "object" ? frame.customData : {}),
        }
      : {
          pixelWidth: size.pixelWidth,
          pixelHeight: size.pixelHeight,
          generatorPrompt: frame.prompt ?? "",
          generatorModel: frame.model ?? "gpt-image-2-codex",
          generatorAspectRatio: frame.aspectRatio ?? frame.aspect_ratio ?? "1:1",
          generatorImageQuality: frame.quality ?? "auto",
          generatorImageSize: frame.imageSize ?? frame.size ?? "1K",
          ...(frame.customData && typeof frame.customData === "object" ? frame.customData : {}),
        };
    const element = newGeneratorFrameRecord({ id, index, bounds, kind, customData });
    newElements.push(element);
    results.push({ elementId: id, kind, bounds });
  }

  if (!args.dryRun) {
    if (args.replaceAnchor === true && anchorElementId) {
      scene.elements = scene.elements.map((element) =>
        element.id === anchorElementId
          ? {
              ...element,
              isDeleted: true,
              version: (Number(element.version) || 1) + 1,
              versionNonce: Math.floor(Math.random() * 2 ** 31),
              updated: Date.now(),
            }
          : element,
      );
    }
    scene.elements.push(...newElements);
    if (args.focusCreated === true) {
      const batchBounds = boundsForRects(results.map((result) => result.bounds));
      if (batchBounds) {
        const zoom = Math.max(0.1, finiteNumber(Number(scene.appState?.zoom?.value), 1));
        const viewportWidth = Math.max(1, finiteNumber(Number(scene.appState?.width), 1280));
        const viewportHeight = Math.max(1, finiteNumber(Number(scene.appState?.height), 720));
        const isOnlyVideo = frames.every((frame) => frame?.kind === "video");
        const targetScreenRatio = isOnlyVideo ? 0.36 : 0.44;
        const targetScreenY = Math.min(
          viewportHeight * targetScreenRatio,
          Math.max(120, viewportHeight - (isOnlyVideo ? 280 : 195)),
        );
        scene.appState = {
          ...scene.appState,
          zoom: scene.appState?.zoom && typeof scene.appState.zoom === "object" ? scene.appState.zoom : { value: zoom },
          scrollX: viewportWidth / (2 * zoom) - (batchBounds.x + batchBounds.width / 2),
          scrollY: targetScreenY / zoom - (batchBounds.y + batchBounds.height / 2),
        };
      }
    }
    if (args.selectCreated === true) {
      scene.appState = {
        ...scene.appState,
        selectedElementIds: Object.fromEntries(newElements.map((element) => [element.id, true])),
      };
    }
    await saveScene(args, scene);
  }

  return results;
}

function resolveBatchItemSize(item) {
  const width = finiteNumber(Number(item.width), 0);
  const height = finiteNumber(Number(item.height), 0);
  if (width > 0 && height > 0) return { width, height };
  if (item.kind === "video") {
    const aspect = parseAspectRatio(item.aspectRatio, 16 / 9);
    const fallbackWidth = width > 0 ? width : 560;
    return { width: fallbackWidth, height: height > 0 ? height : Math.round(fallbackWidth / aspect) };
  }
  const pixelSize = getImageDimensionsFromBuffer(item.mediaBuffer, item.fileName ?? "generated image");
  const fallbackWidth = width > 0 ? width : Math.min(pixelSize.width, 512);
  return {
    width: fallbackWidth,
    height: height > 0 ? height : Math.round(fallbackWidth * (pixelSize.height / pixelSize.width)),
  };
}

export async function insertExcalidrawMediaBatch(args = {}) {
  const items = Array.isArray(args.items) ? args.items : [];
  if (items.length === 0) throw new Error("insertExcalidrawMediaBatch requires a non-empty items array.");

  const columns = Math.max(1, Math.round(finiteNumber(Number(args.columns), 4)));
  const gap = Math.max(0, finiteNumber(Number(args.gap), 24));

  const scene = await loadScene(args);
  const canvasDir = resolveCanvasDir(args);
  const assetsDir = join(canvasDir, "assets");
  if (!isSafeChildPath(canvasDir, assetsDir)) throw new Error(`Unsafe assets directory: ${assetsDir}`);

  const sizes = items.map((item) => resolveBatchItemSize(item));
  const cellW = Math.max(1, ...sizes.map((size) => size.width));
  const cellH = Math.max(1, ...sizes.map((size) => size.height));
  const anchor = sceneContentBottomAnchor(scene);
  const startX = anchor.x;
  const startY = scene.elements.some((element) => element && !element.isDeleted) ? anchor.y + gap : anchor.y;

  const existingIds = new Set([
    ...scene.elements.map((element) => element.id),
    ...Object.keys(scene.files ?? {}),
    ...scene.elements.map((element) => element.fileId).filter(Boolean),
  ]);

  const newElements = [];
  const newFiles = {};
  const results = [];
  let previousIndex = null;
  const reservedFileNames = new Set();

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const kind = item.kind === "video" ? "video" : "image";
    const size = sizes[i];
    const col = i % columns;
    const row = Math.floor(i / columns);
    const bounds = {
      x: startX + col * (cellW + gap),
      y: startY + row * (cellH + gap),
      width: size.width,
      height: size.height,
    };

    const fallbackExt = extForMimeType(item.mimeType, kind === "video" ? ".mp4" : ".png");
    const requestedName = item.fileName || (kind === "video"
      ? await nextGeneratedVideoName(assetsDir, fallbackExt)
      : await nextGeneratedImageName(assetsDir, fallbackExt));
    const { fileName, filePath } = await uniqueFilePath(assetsDir, requestedName, reservedFileNames);
    const mimeType = item.mimeType || mimeTypeForFile(fileName);
    const assetUrl = `${ASSETS_ROUTE}${encodeURIComponent(fileName)}`;
    const recordSeed = sanitizeIdPart(fileName);
    const elementId = uniqueId(existingIds, kind === "video" ? "video" : "element", recordSeed);
    const fileId = uniqueId(existingIds, "file", recordSeed);
    const index = chooseIndexAfter(scene.elements, previousIndex);
    previousIndex = index;

    let element;
    let fileRecord;
    if (kind === "video") {
      const pixelWidth = Math.max(1, Math.round(bounds.width * 4));
      const pixelHeight = Math.max(1, Math.round(bounds.height * 4));
      const posterDataURL =
        item.posterDataURL ||
        (await extractVideoPosterDataURL({ path: item.videoPath, buffer: item.mediaBuffer })) ||
        videoPlaceholderDataURL({ width: pixelWidth, height: pixelHeight, label: "Video" });
      const customData = {
        codexInsertedVideo: true,
        codexGeneratedVideo: true,
        codexMediaKind: "video",
        codexFileName: fileName,
        codexAssetPath: filePath,
        codexAssetUrl: assetUrl,
        codexVideoMimeType: mimeType,
        codexVideoDuration: finiteNumber(Number(item.duration), 0),
        codexPixelWidth: pixelWidth,
        codexPixelHeight: pixelHeight,
        ...(item.customData && typeof item.customData === "object" ? item.customData : {}),
      };
      element = newImageElementRecord({ id: elementId, fileId, index, bounds, customData });
      fileRecord = {
        id: fileId,
        name: fileName,
        mimeType: posterDataURL.startsWith("data:image/jpeg") ? "image/jpeg" : "image/svg+xml",
        dataURL: posterDataURL,
        created: Date.now(),
        lastRetrieved: Date.now(),
      };
    } else {
      // Asset-backed images reference their canvas/assets URL instead of
      // embedding base64 into the scene JSON (hydrated client-side on load).
      const dataURL = nonEmptyString(item.dataURL) || assetUrl;
      const imagePixelSize = getImageDimensionsFromBuffer(item.mediaBuffer, item.fileName ?? fileName);
      const customData = {
        codexInsertedImage: true,
        codexMediaKind: "image",
        codexFileName: fileName,
        codexAssetPath: filePath,
        codexAssetUrl: assetUrl,
        codexAssetMimeType: mimeType,
        codexPixelWidth: imagePixelSize.width,
        codexPixelHeight: imagePixelSize.height,
        ...(item.customData && typeof item.customData === "object" ? item.customData : {}),
      };
      element = newImageElementRecord({ id: elementId, fileId, index, bounds, customData });
      fileRecord = {
        id: fileId,
        name: fileName,
        mimeType,
        dataURL,
        ...(dataURL === assetUrl ? { codexAssetBacked: true } : {}),
        created: Date.now(),
        lastRetrieved: Date.now(),
      };
    }

    newElements.push(element);
    newFiles[fileId] = fileRecord;
    results.push({ elementId, fileId, fileName, bounds, assetFile: filePath, assetUrl, mimeType, kind });
  }

  if (!args.dryRun) {
    await mkdir(assetsDir, { recursive: true });
    for (let i = 0; i < items.length; i += 1) {
      await writeFile(results[i].assetFile, items[i].mediaBuffer);
    }
    scene.files = scene.files && typeof scene.files === "object" ? scene.files : {};
    for (const [fileId, fileRecord] of Object.entries(newFiles)) {
      scene.files[fileId] = fileRecord;
    }
    for (const element of newElements) {
      scene.elements.push(element);
    }
    if (args.selectCreated === true) {
      scene.appState = {
        ...scene.appState,
        selectedElementIds: Object.fromEntries(newElements.map((element) => [element.id, true])),
      };
    }
    await saveScene(args, scene);
  }

  return results.map((result) => ({
    elementId: result.elementId,
    fileId: result.fileId,
    fileName: result.fileName,
    bounds: result.bounds,
    assetFile: result.assetFile,
    assetUrl: result.assetUrl,
    mimeType: result.mimeType,
    kind: result.kind,
  }));
}

export async function getImageDimensionsFromFile(filePath) {
  return getImageDimensions(filePath);
}
