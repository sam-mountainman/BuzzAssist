import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { generateKeyBetween } from "fractional-indexing";

export const CANVAS_FILE_NAME = "excalidraw-canvas.json";
export const SELECTION_FILE_NAME = "excalidraw-selection.json";
export const ASSETS_ROUTE = "/excalidraw-assets/";
export const AI_HOLDER_KEY = "codexAiImageHolder";

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

export function isSafeChildPath(parent, child) {
  const pathToChild = relative(parent, child);
  return pathToChild && !pathToChild.startsWith("..") && !pathToChild.includes(`..${sep}`);
}

export function sanitizeFileName(name, fallbackName = "asset.bin") {
  const rawName = basename(String(name || fallbackName));
  const extension = extname(rawName) || extname(fallbackName) || ".bin";
  const baseName = rawName
    .slice(0, rawName.length - extname(rawName).length)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${baseName || "asset"}${extension}`;
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
  const tempFile = `${filePath}.${process.pid}.tmp`;
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

  return {
    type: value.type ?? "excalidraw",
    version: value.version ?? 2,
    source: value.source ?? "codex-excalidraw-canvas",
    elements: value.elements,
    appState: value.appState && typeof value.appState === "object" ? value.appState : {},
    files: value.files && typeof value.files === "object" ? value.files : {},
  };
}

export async function loadScene(args = {}) {
  return normalizeScene(await readJsonIfExists(resolveCanvasFile(args), null));
}

export async function saveScene(args = {}, scene) {
  await writeJsonAtomic(resolveCanvasFile(args), normalizeScene(scene));
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

async function uniqueFilePath(dir, requestedName) {
  const safeName = sanitizeFileName(requestedName);
  const ext = extname(safeName);
  const base = safeName.slice(0, safeName.length - ext.length);
  let candidate = safeName;
  let counter = 2;
  while (true) {
    const candidatePath = join(dir, candidate);
    try {
      await stat(candidatePath);
      candidate = `${base}-v${counter}${ext}`;
      counter += 1;
    } catch (error) {
      if (error?.code === "ENOENT") return { fileName: candidate, filePath: candidatePath };
      throw error;
    }
  }
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
    .map((element) => element.index)
    .filter((index) => typeof index === "string")
    .sort();
  return generateKeyBetween(indexes.at(-1) ?? null, null);
}

function chooseIndexAfter(elements, previousIndex) {
  const indexes = elements
    .map((element) => element.index)
    .filter((index) => typeof index === "string")
    .sort();
  const nextIndex = indexes.find((index) => previousIndex && index > previousIndex) ?? null;
  return generateKeyBetween(previousIndex ?? indexes.at(-1) ?? null, nextIndex);
}

function firstSelectedElementId(selection, scene) {
  if (Array.isArray(selection?.selectedElementIds) && selection.selectedElementIds.length === 1) {
    return selection.selectedElementIds[0];
  }
  const fromScene = selectedIdsFromScene(scene);
  return fromScene.length === 1 ? fromScene[0] : null;
}

function newImageElementRecord({ id, fileId, index, bounds, customData }) {
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
    link: null,
    locked: false,
    index,
    fileId,
    status: "saved",
    scale: [1, 1],
    crop: null,
    customData,
  };
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
    strokeColor: "#0b7285",
    backgroundColor: "#e3fafc",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [groupId],
    frameId: null,
    roundness: { type: 3 },
    seed: Math.floor(Math.random() * 2 ** 31),
    version: 1,
    versionNonce: Math.floor(Math.random() * 2 ** 31),
    isDeleted: false,
    boundElements: null,
    updated: now,
    link: assetUrl,
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
    link: assetUrl,
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
  const requestedName = args.fileName || (sourceImagePath ? basename(sourceImagePath) : `generated-${Date.now()}${fallbackExt}`);
  const { fileName, filePath } = await uniqueFilePath(assetsDir, requestedName);
  const mimeType = args.mimeType || mimeTypeForFile(fileName);
  const dataURL = args.dataURL || `data:${mimeType};base64,${fileData.toString("base64")}`;
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
    codexAssetPath: filePath,
    codexAssetUrl: `${ASSETS_ROUTE}${encodeURIComponent(fileName)}`,
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
    mimeType,
    dataURL,
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
  const requestedName = args.fileName || (sourceVideoPath ? basename(sourceVideoPath) : `generated-video-${Date.now()}${fallbackExt}`);
  const { fileName, filePath } = await uniqueFilePath(assetsDir, requestedName);
  const mimeType = args.mimeType || mimeTypeForFile(fileName);
  const assetUrl = `${ASSETS_ROUTE}${encodeURIComponent(fileName)}`;
  const existingIds = new Set(scene.elements.map((element) => element.id));
  const recordSeed = sanitizeIdPart(fileName);
  const groupId = uniqueId(existingIds, "group", recordSeed);
  const elementId = uniqueId(existingIds, "video", recordSeed);
  const labelId = uniqueId(existingIds, "label", recordSeed);
  const index = chooseIndex(scene.elements);
  const textIndex = chooseIndexAfter([...scene.elements, { index }], index);
  const labelLines = [
    "Video",
    nonEmptyString(args.prompt) ? nonEmptyString(args.prompt).slice(0, 64) : fileName,
    nonEmptyString(args.duration) ? `${args.duration}s` : "",
  ].filter(Boolean);
  const customData = {
    codexInsertedVideo: true,
    codexMediaKind: "video",
    codexAssetPath: filePath,
    codexAssetUrl: assetUrl,
    codexVideoMimeType: mimeType,
    ...(anchorElementId ? { codexAnchorElementId: anchorElementId } : {}),
    ...(args.prompt ? { codexGenerationPrompt: args.prompt } : {}),
    ...(args.model ? { codexGenerationModel: args.model } : {}),
    ...(args.customData && typeof args.customData === "object" ? args.customData : {}),
  };

  const cardElement = newRectangleElementRecord({
    id: elementId,
    index,
    bounds,
    groupId,
    assetUrl,
    customData,
  });
  const textElement = newTextElementRecord({
    id: labelId,
    index: textIndex,
    bounds,
    groupId,
    assetUrl,
    text: labelLines.join("\n"),
    customData: {
      codexVideoLabelFor: elementId,
      codexMediaKind: "video-label",
    },
  });

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
    scene.elements.push(cardElement, textElement);
    scene.appState = {
      ...scene.appState,
      selectedElementIds: { [elementId]: true, [labelId]: true },
    };
    await saveScene(args, scene);
  }

  return {
    elementId,
    labelId,
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

export async function getImageDimensionsFromFile(filePath) {
  return getImageDimensions(filePath);
}
