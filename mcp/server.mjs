import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import readline from "node:readline";
import { generateKeyBetween } from "fractional-indexing";
import { generateImageMedia, generateVideoMedia } from "../lib/mediaGeneration.mjs";
import {
  insertExcalidrawImage as insertExcalidrawImageMedia,
  insertExcalidrawVideo as insertExcalidrawVideoMedia,
} from "../lib/canvasScene.mjs";

const SERVER_NAME = "Codex Excalidraw MCP";
const SERVER_VERSION = "0.1.0";
const TOOL_GET_SELECTION = "get_excalidraw_selection";
const TOOL_INSERT_IMAGE = "insert_excalidraw_image";
const TOOL_INSERT_VIDEO = "insert_excalidraw_video";
const TOOL_GENERATE_IMAGE = "generate_excalidraw_image";
const TOOL_GENERATE_VIDEO = "generate_excalidraw_video";
const CANVAS_FILE_NAME = "excalidraw-canvas.json";
const SELECTION_FILE_NAME = "excalidraw-selection.json";
const ASSETS_ROUTE = "/excalidraw-assets/";
const AI_HOLDER_KEY = "codexAiImageHolder";

const JsonRpcError = {
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function finiteNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function pathResolve(value) {
  return resolve(String(value));
}

function resolveCanvasDir(args = {}) {
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

function resolveCanvasFile(args = {}) {
  return join(resolveCanvasDir(args), CANVAS_FILE_NAME);
}

function resolveSelectionFile(args = {}) {
  return join(resolveCanvasDir(args), SELECTION_FILE_NAME);
}

function isSafeChildPath(parent, child) {
  const pathToChild = relative(parent, child);
  return pathToChild && !pathToChild.startsWith("..") && !pathToChild.includes(`..${sep}`);
}

function sanitizeFileName(name, fallbackName = "image.png") {
  const rawName = basename(String(name || fallbackName));
  const extension = extname(rawName) || extname(fallbackName) || ".png";
  const baseName = rawName
    .slice(0, rawName.length - extname(rawName).length)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${baseName || "image"}${extension}`;
}

function sanitizeIdPart(value, fallback = "image") {
  return (
    String(value || fallback)
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || fallback
  );
}

function mimeTypeForFile(filePath) {
  switch (extname(filePath).toLowerCase()) {
    case ".apng":
      return "image/apng";
    case ".avif":
      return "image/avif";
    case ".gif":
      return "image/gif";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

async function writeJsonAtomic(filePath, payload) {
  await mkdir(dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempFile, `${JSON.stringify(payload, null, 2)}\n`);
  await rename(tempFile, filePath);
}

async function readJsonIfExists(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

function normalizeScene(value) {
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

async function loadScene(args = {}) {
  return normalizeScene(await readJsonIfExists(resolveCanvasFile(args), null));
}

async function saveScene(args = {}, scene) {
  await writeJsonAtomic(resolveCanvasFile(args), normalizeScene(scene));
}

function selectedIdsFromScene(scene) {
  return Object.entries(scene.appState?.selectedElementIds ?? {})
    .filter(([, selected]) => selected)
    .map(([id]) => id);
}

async function readSelectionState(args = {}) {
  const selectionFile = resolveSelectionFile(args);
  const selection = await readJsonIfExists(selectionFile, {
    selectedElements: [],
    selectedElementIds: [],
    updatedAt: null,
  });
  return { selection, selectionFile };
}

function elementSummary(element, files = {}) {
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

async function getImageDimensions(filePath) {
  const buffer = await readFile(filePath);
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
  throw new Error(`Could not read image dimensions for ${filePath}. Pass displayWidth/displayHeight and use a PNG/JPEG/WebP source.`);
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
  let x = anchorBounds ? anchorBounds.x + anchorBounds.width + margin : 0;
  let y = anchorBounds ? anchorBounds.y : 0;

  if ((placement === "replace" || placement === "inside") && anchorBounds) {
    return { x: anchorBounds.x, y: anchorBounds.y, width, height };
  }
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

function firstSelectedElementId(selection, scene) {
  if (Array.isArray(selection?.selectedElementIds) && selection.selectedElementIds.length === 1) {
    return selection.selectedElementIds[0];
  }
  const fromScene = selectedIdsFromScene(scene);
  return fromScene.length === 1 ? fromScene[0] : null;
}

function newElementRecord({ id, fileId, index, bounds, customData }) {
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

async function insertExcalidrawImage(args = {}) {
  const imagePath = nonEmptyString(args.imagePath);
  if (!imagePath) throw new Error("imagePath is required.");

  const sourceImagePath = pathResolve(imagePath);
  const sourceStat = await stat(sourceImagePath);
  if (!sourceStat.isFile()) throw new Error(`imagePath is not a file: ${sourceImagePath}`);

  const scene = await loadScene(args);
  const { selection } = await readSelectionState(args);
  const elementsById = new Map(scene.elements.map((element) => [element.id, element]));
  const anchorElementId = nonEmptyString(args.anchorElementId) || nonEmptyString(args.sourceElementId) || firstSelectedElementId(selection, scene);
  const anchorElement = anchorElementId ? elementsById.get(anchorElementId) : null;
  if (anchorElementId && !anchorElement) throw new Error(`Missing anchor element: ${anchorElementId}`);

  const imageSize = await getImageDimensions(sourceImagePath);
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

  const { fileName, filePath } = await uniqueFilePath(assetsDir, args.fileName || basename(sourceImagePath));
  const mimeType = mimeTypeForFile(fileName);
  const fileData = await readFile(sourceImagePath);
  const dataURL = `data:${mimeType};base64,${fileData.toString("base64")}`;
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

  const imageElement = newElementRecord({
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
    await copyFile(sourceImagePath, filePath);
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
    replacedAnchor: replaceAnchor,
    dryRun: Boolean(args.dryRun),
  };
}

async function insertExcalidrawVideo(args = {}) {
  return insertExcalidrawVideoMedia(args);
}

async function generateExcalidrawImage(args = {}) {
  const media = await generateImageMedia({
    ...args,
    aspectRatio: args.aspectRatio ?? args.aspect_ratio,
    imageSize: args.imageSize ?? args.size,
    fileName: args.fileName ?? args.imageName ?? args.image_name,
    referenceImagePaths: args.referenceImagePaths ?? args.reference_image_paths,
  });
  return insertExcalidrawImageMedia({
    ...args,
    mediaBuffer: media.buffer,
    mimeType: media.mimeType,
    fileName: args.fileName ?? args.imageName ?? args.image_name ?? media.fileName,
    customData: {
      codexGeneratedImage: true,
      codexGenerationModel: media.model,
      codexGenerationPrompt: args.prompt,
      codexGenerationAspectRatio: args.aspectRatio ?? args.aspect_ratio,
      codexGenerationQuality: args.quality,
      generatorPrompt: args.prompt,
      generatorModel: args.model,
      generatorAspectRatio: args.aspectRatio ?? args.aspect_ratio,
      generatorImageQuality: args.quality,
      generatorImageSize: args.imageSize ?? args.size ?? "1K",
      codexGenerationSource: media.source,
      ...(args.customData && typeof args.customData === "object" ? args.customData : {}),
    },
  });
}

async function generateExcalidrawVideo(args = {}) {
  const media = await generateVideoMedia({
    ...args,
    aspectRatio: args.aspectRatio ?? args.aspect_ratio,
    duration: args.duration,
    fileName: args.fileName ?? args.videoName ?? args.video_name,
    startFramePath: args.startFramePath ?? args.start_frame_path,
    referenceImagePaths: args.referenceImagePaths ?? args.reference_image_paths,
  });
  return insertExcalidrawVideoMedia({
    ...args,
    mediaBuffer: media.buffer,
    mimeType: media.mimeType,
    fileName: args.fileName ?? args.videoName ?? args.video_name ?? media.fileName,
    aspectRatio: args.aspectRatio ?? args.aspect_ratio,
    duration: args.duration,
    prompt: args.prompt,
    model: media.model,
    customData: {
      codexGeneratedVideo: true,
      codexGenerationModel: media.model,
      codexGenerationPrompt: args.prompt,
      codexGenerationAspectRatio: args.aspectRatio ?? args.aspect_ratio,
      codexGenerationDuration: args.duration,
      codexGenerationResolution: args.resolution,
      videoPrompt: args.prompt,
      videoModel: args.model,
      videoAspectRatio: args.aspectRatio ?? args.aspect_ratio,
      videoDuration: args.duration,
      videoResolution: args.resolution,
      codexGenerationSource: media.source,
      ...(args.customData && typeof args.customData === "object" ? args.customData : {}),
    },
  });
}

function toolDefinitions() {
  return [
    {
      name: TOOL_GET_SELECTION,
      title: "Get Excalidraw Selection",
      description: "Return selected Excalidraw elements from canvas/excalidraw-selection.json.",
      inputSchema: {
        type: "object",
        properties: {
          projectDir: { type: "string", description: "Absolute project directory containing canvas/." },
          canvasDir: { type: "string", description: "Absolute canvas directory. Overrides projectDir." },
        },
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: TOOL_INSERT_IMAGE,
      title: "Insert Excalidraw Image",
      description: "Copy a local bitmap into canvas/assets, create an Excalidraw image file and element, and save the scene.",
      inputSchema: {
        type: "object",
        properties: {
          imagePath: { type: "string", description: "Absolute local bitmap path to insert." },
          projectDir: { type: "string", description: "Absolute project directory containing canvas/." },
          canvasDir: { type: "string", description: "Absolute canvas directory. Overrides projectDir." },
          anchorElementId: { type: "string", description: "Existing Excalidraw element id to place beside." },
          sourceElementId: { type: "string", description: "Alias for anchorElementId." },
          fileName: { type: "string", description: "Optional destination filename under canvas/assets/." },
          placement: { type: "string", enum: ["right", "left", "below", "replace", "inside"] },
          margin: { type: "number", description: "Canvas units between the new image and nearby elements. Defaults to 40." },
          matchAnchor: { type: "boolean", description: "Use the anchor display size when possible. Defaults to true." },
          replaceAnchor: { type: "boolean", description: "Replace the anchor element with the inserted image." },
          displayWidth: { type: "number", description: "Displayed element width in canvas units." },
          displayHeight: { type: "number", description: "Displayed element height in canvas units." },
          customData: { type: "object", description: "Additional Excalidraw element customData." },
          dryRun: { type: "boolean", description: "Calculate insertion without copying or saving." },
        },
        required: ["imagePath"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    {
      name: TOOL_INSERT_VIDEO,
      title: "Insert Excalidraw Video",
      description: "Copy a local video into canvas/assets, create a linked video card, and save the scene.",
      inputSchema: {
        type: "object",
        properties: {
          videoPath: { type: "string", description: "Absolute local video path to insert." },
          projectDir: { type: "string", description: "Absolute project directory containing canvas/." },
          canvasDir: { type: "string", description: "Absolute canvas directory. Overrides projectDir." },
          anchorElementId: { type: "string", description: "Existing Excalidraw element id to place beside." },
          sourceElementId: { type: "string", description: "Alias for anchorElementId." },
          fileName: { type: "string", description: "Optional destination filename under canvas/assets/." },
          placement: { type: "string", enum: ["right", "left", "below", "replace", "inside"] },
          margin: { type: "number", description: "Canvas units between the new video card and nearby elements. Defaults to 40." },
          matchAnchor: { type: "boolean", description: "Use the anchor display size when possible. Defaults to true." },
          replaceAnchor: { type: "boolean", description: "Replace the anchor element with the inserted video card." },
          displayWidth: { type: "number", description: "Displayed card width in canvas units." },
          displayHeight: { type: "number", description: "Displayed card height in canvas units." },
          aspectRatio: { type: "string", description: "Aspect ratio such as 16:9, 9:16, or 1:1." },
          prompt: { type: "string", description: "Optional generation prompt to store in customData." },
          model: { type: "string", description: "Optional generation model to store in customData." },
          customData: { type: "object", description: "Additional Excalidraw element customData." },
          dryRun: { type: "boolean", description: "Calculate insertion without copying or saving." },
        },
        required: ["videoPath"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    {
      name: TOOL_GENERATE_IMAGE,
      title: "Generate Excalidraw Image",
      description: "Generate an image with GPT-Image-2.0(Codex) or Grok Imagine(Hermes), insert it into the canvas, and save the scene.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Image prompt." },
          model: {
            type: "string",
            enum: ["gpt-image-2-codex", "grok-imagine-image-hermes"],
            description: "Defaults to gpt-image-2-codex.",
          },
          projectDir: { type: "string", description: "Absolute project directory containing canvas/." },
          canvasDir: { type: "string", description: "Absolute canvas directory. Overrides projectDir." },
          anchorElementId: { type: "string", description: "Existing Excalidraw element id to place beside." },
          sourceElementId: { type: "string", description: "Alias for anchorElementId." },
          fileName: { type: "string", description: "Optional destination filename under canvas/assets/." },
          imageName: { type: "string", description: "Alias for fileName." },
          aspectRatio: { type: "string", description: "Aspect ratio such as 1:1, 16:9, or 9:16." },
          aspect_ratio: { type: "string", description: "Alias for aspectRatio." },
          imageSize: { type: "string", description: "Image size or Hermes resolution hint." },
          quality: { type: "string", description: "Quality hint. high maps to Grok quality mode." },
          referenceImagePaths: { type: "array", items: { type: "string" }, description: "Optional local image references for Hermes image edit." },
          reference_image_paths: { type: "array", items: { type: "string" }, description: "Alias for referenceImagePaths." },
          placement: { type: "string", enum: ["right", "left", "below", "replace", "inside"] },
          margin: { type: "number" },
          matchAnchor: { type: "boolean" },
          replaceAnchor: { type: "boolean", description: "Replace the anchor element with the generated image." },
          displayWidth: { type: "number" },
          displayHeight: { type: "number" },
          customData: { type: "object" },
          dryRun: { type: "boolean" },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    {
      name: TOOL_GENERATE_VIDEO,
      title: "Generate Excalidraw Video",
      description: "Generate a video with Grok Imagine(Hermes), insert a linked video card into the canvas, and save the scene.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Video prompt." },
          model: {
            type: "string",
            enum: ["grok-imagine-video-hermes"],
            description: "Defaults to grok-imagine-video-hermes.",
          },
          projectDir: { type: "string", description: "Absolute project directory containing canvas/." },
          canvasDir: { type: "string", description: "Absolute canvas directory. Overrides projectDir." },
          anchorElementId: { type: "string", description: "Existing Excalidraw element id to place beside." },
          sourceElementId: { type: "string", description: "Alias for anchorElementId." },
          fileName: { type: "string", description: "Optional destination filename under canvas/assets/." },
          videoName: { type: "string", description: "Alias for fileName." },
          aspectRatio: { type: "string", description: "Aspect ratio such as 16:9, 9:16, or 1:1." },
          aspect_ratio: { type: "string", description: "Alias for aspectRatio." },
          duration: { type: "string", description: "Duration seconds. Grok Hermes clamps text-to-video to 1-15 seconds." },
          resolution: { type: "string", description: "720p or 1080p." },
          startFramePath: { type: "string", description: "Optional local image path for image-to-video start frame." },
          start_frame_path: { type: "string", description: "Alias for startFramePath." },
          referenceImagePaths: { type: "array", items: { type: "string" }, description: "Optional local reference image paths." },
          reference_image_paths: { type: "array", items: { type: "string" }, description: "Alias for referenceImagePaths." },
          placement: { type: "string", enum: ["right", "left", "below", "replace", "inside"] },
          margin: { type: "number" },
          matchAnchor: { type: "boolean" },
          replaceAnchor: { type: "boolean", description: "Replace the anchor element with the generated video card." },
          displayWidth: { type: "number" },
          displayHeight: { type: "number" },
          customData: { type: "object" },
          dryRun: { type: "boolean" },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
  ];
}

async function handleToolCall(id, params) {
  if (params?.name === TOOL_GET_SELECTION) {
    const args = params.arguments ?? {};
    const scene = await loadScene(args);
    const { selection, selectionFile } = await readSelectionState(args);
    const selectedElements = selection.selectedElements ?? [];
    const summary =
      selectedElements.length === 0
        ? "No Excalidraw elements are currently selected."
        : selectedElements
            .map((element) => `${element.id} [${element.type ?? "unknown"}] ${element.width ?? "?"}x${element.height ?? "?"}`)
            .join("\n");

    sendResult(id, {
      content: [{ type: "text", text: summary }],
      structuredContent: { selection, selectionFile, sceneFile: resolveCanvasFile(args), sceneElementCount: scene.elements.length },
    });
    return;
  }

  if (params?.name === TOOL_INSERT_IMAGE) {
    const result = await insertExcalidrawImage(params.arguments ?? {});
    sendResult(id, {
      content: [
        {
          type: "text",
          text: `${result.dryRun ? "Planned" : "Inserted"} ${result.elementId} at (${result.bounds.x}, ${result.bounds.y}) sized ${result.bounds.width}x${result.bounds.height}.`,
        },
      ],
      structuredContent: result,
    });
    return;
  }

  if (params?.name === TOOL_INSERT_VIDEO) {
    const result = await insertExcalidrawVideo(params.arguments ?? {});
    sendResult(id, {
      content: [
        {
          type: "text",
          text: `${result.dryRun ? "Planned" : "Inserted"} video card ${result.elementId} at (${result.bounds.x}, ${result.bounds.y}) sized ${result.bounds.width}x${result.bounds.height}.`,
        },
      ],
      structuredContent: result,
    });
    return;
  }

  if (params?.name === TOOL_GENERATE_IMAGE) {
    const result = await generateExcalidrawImage(params.arguments ?? {});
    sendResult(id, {
      content: [
        {
          type: "text",
          text: `${result.dryRun ? "Planned" : "Generated"} image ${result.elementId} at (${result.bounds.x}, ${result.bounds.y}) sized ${result.bounds.width}x${result.bounds.height}.`,
        },
      ],
      structuredContent: result,
    });
    return;
  }

  if (params?.name === TOOL_GENERATE_VIDEO) {
    const result = await generateExcalidrawVideo(params.arguments ?? {});
    sendResult(id, {
      content: [
        {
          type: "text",
          text: `${result.dryRun ? "Planned" : "Generated"} video card ${result.elementId} at (${result.bounds.x}, ${result.bounds.y}) sized ${result.bounds.width}x${result.bounds.height}.`,
        },
      ],
      structuredContent: result,
    });
    return;
  }

  sendError(id, JsonRpcError.INVALID_PARAMS, `Unknown tool: ${params?.name ?? ""}`);
}

async function handleRequest(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: params?.protocolVersion ?? "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
      instructions:
        "Read and update project-local Excalidraw canvas state. Use get_excalidraw_selection for persisted browser selection, insert_excalidraw_image/insert_excalidraw_video for local assets, and generate_excalidraw_image/generate_excalidraw_video for GPT-Image-2.0(Codex) or Grok Imagine(Hermes) generation.",
    });
    return;
  }

  if (method === "ping") {
    sendResult(id, {});
    return;
  }

  if (method === "tools/list") {
    sendResult(id, { tools: toolDefinitions() });
    return;
  }

  if (method === "tools/call") {
    try {
      await handleToolCall(id, params);
    } catch (error) {
      sendError(id, JsonRpcError.INVALID_PARAMS, error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (id !== undefined) {
    sendError(id, JsonRpcError.METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

const lines = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

lines.on("line", (line) => {
  if (line.trim().length === 0) return;

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  handleRequest(message).catch((error) => {
    if (message.id !== undefined) {
      sendError(message.id, JsonRpcError.INVALID_PARAMS, error instanceof Error ? error.message : String(error));
    }
  });
});
