import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { generateKeyBetween } from "fractional-indexing";
import { IMAGE_MODELS, VIDEO_MODELS, generateImageMedia, generateVideoMedia, runWithConcurrency } from "../lib/mediaGeneration.mjs";
import { getBuzzAssistAuthStatus, loginBuzzAssistViaBrowser } from "../lib/buzzassistApi.mjs";
import {
  OFFICIAL_EXCALIDRAW_README,
  createExcalidrawView,
  insertExcalidrawImage as insertExcalidrawImageMedia,
  insertExcalidrawSubtitle,
  insertExcalidrawVideo as insertExcalidrawVideoMedia,
  insertGeneratorFrameBatch,
  performCanvasMaintenance,
} from "../lib/canvasScene.mjs";
import { silenceCutVideo } from "../lib/tempoCut.mjs";
import { estimateCreditsForJob } from "../lib/mediaCredits.mjs";
import { isFalImageModel, isFalVideoModel, previewFalImageRequest, previewFalVideoRequest } from "../lib/falMediaGeneration.mjs";
import { generateSubtitleSrt, normalizeSubtitleHoldSeconds, renderSrt } from "../lib/subtitleGeneration.mjs";
import { tmpdir } from "node:os";

const SERVER_NAME = "Codex Excalidraw MCP";
const SERVER_VERSION = "0.1.0";
const TOOL_READ_ME = "read_me";
const TOOL_CREATE_VIEW = "create_view";
const TOOL_GET_SELECTION = "get_excalidraw_selection";
const TOOL_INSERT_IMAGE = "insert_excalidraw_image";
const TOOL_INSERT_VIDEO = "insert_excalidraw_video";
const TOOL_GENERATE_IMAGE = "generate_excalidraw_image";
const TOOL_GENERATE_VIDEO = "generate_excalidraw_video";
const TOOL_GENERATE_IMAGES_BATCH = "generate_excalidraw_images_batch";
const TOOL_GENERATE_VIDEOS_BATCH = "generate_excalidraw_videos_batch";
const TOOL_BUZZASSIST_LOGIN = "buzzassist_login";
const TOOL_BUZZASSIST_AUTH_STATUS = "buzzassist_auth_status";
const TOOL_GENERATE_SUBTITLES = "generate_excalidraw_subtitles";
const TOOL_SILENCE_CUT_VIDEO = "silence_cut_excalidraw_video";
const IMAGE_MODEL_IDS = IMAGE_MODELS.map((model) => model.id);
const VIDEO_MODEL_IDS = VIDEO_MODELS.map((model) => model.id);
const CANVAS_FILE_NAME = "excalidraw-canvas.json";
const SELECTION_FILE_NAME = "excalidraw-selection.json";
const ASSETS_ROUTE = "/excalidraw-assets/";
const AI_HOLDER_KEY = "codexAiImageHolder";
const MEDIA_GENERATION_AGENT_INSTRUCTIONS = [
  "Read and update the project-local Excalidraw browser canvas.",
  "Use read_me/create_view for official-compatible Excalidraw MCP drawing into the live local canvas.",
  "Use get_excalidraw_selection for persisted browser selection and insert_excalidraw_image/insert_excalidraw_video for local assets.",
  "Use generate_excalidraw_image/generate_excalidraw_video for media generation. Local models: GPT-Image-2.0(Codex), Grok Imagine(Hermes). BuzzAssist cloud models (require buzzassist_login first): images nano-banana-2, gpt-image-2, seedream-v5-lite, grok-imagine-image-api; videos seedance-2, seedance-2-fast, kling-v3, kling-o3, kling-v2-6, grok-imagine-video-api.",
  "Use buzzassist_auth_status to check BuzzAssist sign-in and buzzassist_login to sign in before using BuzzAssist cloud models, cloud subtitles, or when a tool reports missing login.",
  "Lovart models (require LOVART_ACCESS_KEY/LOVART_SECRET_KEY or ~/.lovart/credentials.json; billed in Lovart credits): images lovart-midjourney, lovart-flux-2-max, lovart-nano-banana-pro, lovart-ideogram-v4, lovart-agent (Lovart picks the model); videos lovart-veo-3-1, lovart-veo-3-1-fast, lovart-hailuo-2-3, lovart-kling-3-omni, lovart-wan-2-6. Lovart is prompt-driven: aspect ratio and duration are hints, not hard parameters.",
  "Use generate_excalidraw_subtitles to create Japanese SRT subtitles from an audio file (scripted mode aligns a provided script, scriptless mode transcribes) and place an SRT card on the canvas.",
  "Use silence_cut_excalidraw_video to remove silences from a local video with ffmpeg (jet-cut) and insert the cut video into the canvas with cut statistics.",
  "Use generate_excalidraw_images_batch/generate_excalidraw_videos_batch when the user asks for many images, many videos, storyboard scenes, or batch media; prepare one jobs item per requested output and let the tool lay results out as a grid.",
  "Before invoking image or video generation, if the user did not specify settings that materially affect the output, ask the user via the host's AskUserQuestion/request_user_input mechanism instead of guessing.",
  "Required image settings to confirm when missing: model, aspect ratio, and quality. Defaults to offer as Recommended are GPT-Image-2.0(Codex), 1:1, and Auto.",
  "Required video settings to confirm when missing: model, aspect ratio, duration, and resolution. Defaults to offer as Recommended are Grok Imagine(Hermes), 16:9, 5 seconds, and 720p.",
  "Before generating subtitles, confirm when missing: mode (scripted needs the script text; scriptless transcribes), lineCount (1 or 2), and maxCharsPerLine. Defaults to offer as Recommended are scriptless, 2 lines, 30 chars.",
  "Before silence-cutting, confirm when missing: model (ffmpeg-local jet-cut, or elevenlabs-scribe-v2 for AI cleanup of fillers/coughs/retakes) and for scribe the removal intensities (0/25/50/80, defaults 50/50/0). Default model to offer as Recommended is ffmpeg-local.",
  "The project-common 用語辞書 (canvas/subtitle-glossary.json, editable from the SRT panel's 用語 pill) is merged into every subtitle/scribe transcription automatically.",
  "Canvas tools auto-start the local canvas server and open it in the browser once when no tab is connected (set EXCALIDRAW_NO_AUTO_OPEN=1 to disable).",
  "When an attached or selected image/video could be used in more than one way, ask one disambiguation question before generation. For video, distinguish start frame/image-to-video from style reference; do not silently put the same media into multiple payload fields.",
  "For choice questions, keep options short and mark the default with (Recommended) in English or （推奨） in Japanese. Do not ask when only one value is valid.",
].join(" ");

// Project-common 用語辞書 (canvas/subtitle-glossary.json) merges into every
// SRT / scribe-cut transcription, matching the BuzzAssist desktop app.
async function mergedProjectGlossary(args = {}) {
  const stored = await readJsonIfExists(join(resolveCanvasDir(args), "subtitle-glossary.json"), { terms: [] });
  const projectTerms = (Array.isArray(stored?.terms) ? stored.terms : []).filter((term) => nonEmptyString(term?.from));
  const requestTerms = Array.isArray(args.glossary) ? args.glossary : [];
  return [...projectTerms, ...requestTerms];
}

// Auto-open: when a canvas tool runs and no browser tab is connected, start
// the local canvas server if needed and open it once per MCP process.
// Disable with EXCALIDRAW_NO_AUTO_OPEN=1.
let canvasAutoOpenAttempted = false;

async function fetchJsonQuick(url, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function ensureCanvasVisible(args = {}) {
  if (canvasAutoOpenAttempted) return;
  canvasAutoOpenAttempted = true;
  if (/^(1|true|yes)$/i.test(String(process.env.EXCALIDRAW_NO_AUTO_OPEN || ""))) return;
  try {
    const port = Number(process.env.EXCALIDRAW_PORT ?? 43219);
    const baseUrl = nonEmptyString(process.env.EXCALIDRAW_CANVAS_URL) || `http://127.0.0.1:${port}`;
    let status = await fetchJsonQuick(`${baseUrl}/api/canvas-clients`);
    if (!status) {
      const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
      const child = spawn("npm", ["run", "dev"], {
        cwd: repoRoot,
        env: { ...process.env, EXCALIDRAW_CANVAS_DIR: resolveCanvasDir(args) },
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && !status) {
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 1000));
        status = await fetchJsonQuick(`${baseUrl}/api/canvas-clients`);
      }
    }
    if (status && Number(status.clients) === 0 && process.platform === "darwin") {
      spawn("open", [baseUrl], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // best-effort — never block the tool call
  }
}

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
  const assetUrl = `${ASSETS_ROUTE}${encodeURIComponent(fileName)}`;
  // The asset is always copied into canvas/assets, so reference it by URL
  // instead of embedding base64 into the scene JSON (hydrated client-side).
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
    codexAssetUrl: assetUrl,
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
    dataURL: assetUrl,
    codexAssetBacked: true,
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

function estimateJobCredits(kind, args) {
  try {
    return estimateCreditsForJob({
      kind,
      model: args.model,
      imageSize: args.imageSize ?? args.size,
      quality: args.quality,
      duration: args.duration,
      resolution: args.resolution,
      generateAudio: args.generateAudio ?? args.generate_audio,
      durationSeconds: args.durationSeconds,
    });
  } catch {
    return null;
  }
}

function buildGenerationPayloadPreview(kind, args = {}) {
  const isFal = kind === "image" ? isFalImageModel(args.model) : isFalVideoModel(args.model);
  const estimate = estimateJobCredits(kind, args);
  if (!isFal) {
    return {
      ok: true,
      payloadPreview: true,
      model: args.model ?? (kind === "image" ? "gpt-image-2-codex" : "grok-imagine-video-hermes"),
      local: true,
      estimatedCredits: estimate?.credits ?? 0,
      estimatedCostYen: estimate?.estimatedCostYen ?? 0,
      note: "Local model (Codex/Hermes) — no BuzzAssist credits consumed.",
    };
  }
  const preview = kind === "image" ? previewFalImageRequest(args) : previewFalVideoRequest(args);
  return {
    ok: true,
    payloadPreview: true,
    ...preview,
    estimatedCredits: estimate?.credits ?? null,
    estimatedCostYen: estimate?.estimatedCostYen ?? null,
  };
}

async function generateExcalidrawImage(args = {}) {
  if (args.payloadPreview) return buildGenerationPayloadPreview("image", args);
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
  if (args.payloadPreview) return buildGenerationPayloadPreview("video", args);
  const media = await generateVideoMedia({
    ...args,
    aspectRatio: args.aspectRatio ?? args.aspect_ratio,
    duration: args.duration,
    fileName: args.fileName ?? args.videoName ?? args.video_name,
    generateAudio: args.generateAudio ?? args.generate_audio,
    startFramePath: args.startFramePath ?? args.start_frame_path,
    referenceImagePaths: args.referenceImagePaths ?? args.reference_image_paths,
    referenceVideoPaths: args.referenceVideoPaths ?? args.reference_video_paths,
    referenceVideos: args.referenceVideos ?? args.reference_videos,
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
      videoGenerateAudio: args.generateAudio ?? args.generate_audio,
      codexGenerationSource: media.source,
      ...(args.customData && typeof args.customData === "object" ? args.customData : {}),
    },
  });
}

async function generateExcalidrawImagesBatch(args = {}) {
  const jobs = Array.isArray(args.jobs) ? args.jobs : [];
  if (jobs.length === 0) throw new Error("generate_excalidraw_images_batch requires a non-empty jobs array.");
  for (const job of jobs) {
    if (!nonEmptyString(job?.prompt)) throw new Error("Each image job requires a prompt.");
  }

  const columns = finiteNumber(Number(args.columns), 4);
  const gap = finiteNumber(Number(args.gap), 24);
  const concurrency = finiteNumber(Number(args.concurrency), 3);
  const dryRun = Boolean(args.dryRun);

  const frames = dryRun
    ? []
    : await insertGeneratorFrameBatch({
        projectDir: args.projectDir,
        canvasDir: args.canvasDir,
        frames: jobs.map((job) => ({
          kind: "image",
          prompt: job.prompt,
          model: job.model ?? "gpt-image-2-codex",
          aspectRatio: job.aspectRatio ?? job.aspect_ratio ?? "1:1",
          quality: job.quality ?? "auto",
          imageSize: job.imageSize ?? job.size ?? "1K",
          customData: job.customData,
        })),
        columns,
        gap,
        selectCreated: args.selectCreated !== false,
        focusCreated: args.focusCreated !== false,
      });

  let writeQueue = Promise.resolve();
  const enqueueWrite = (fn) => {
    const next = writeQueue.then(fn, fn);
    writeQueue = next.catch(() => {});
    return next;
  };

  const generated = await runWithConcurrency(jobs, concurrency, async (job, index) => {
    const media = await generateImageMedia({
      ...job,
      aspectRatio: job.aspectRatio ?? job.aspect_ratio,
      imageSize: job.imageSize ?? job.size,
      fileName: job.fileName ?? job.imageName ?? job.image_name,
      referenceImagePaths: job.referenceImagePaths ?? job.reference_image_paths,
    });
    if (dryRun) {
      return { media, placement: null, frame: null };
    }
    const frame = frames[index];
    const placement = await enqueueWrite(() =>
      insertExcalidrawImageMedia({
        projectDir: args.projectDir,
        canvasDir: args.canvasDir,
        mediaBuffer: media.buffer,
        mimeType: media.mimeType,
        fileName: job.fileName ?? job.imageName ?? job.image_name ?? media.fileName,
        anchorElementId: frame?.elementId,
        replaceAnchor: Boolean(frame?.elementId),
        matchAnchor: true,
        selectCreated: false,
        customData: {
          codexGeneratedImage: true,
          codexGenerationModel: media.model,
          codexGenerationPrompt: job.prompt,
          codexGenerationAspectRatio: job.aspectRatio ?? job.aspect_ratio,
          codexGenerationQuality: job.quality,
          generatorPrompt: job.prompt,
          generatorModel: job.model,
          generatorAspectRatio: job.aspectRatio ?? job.aspect_ratio,
          generatorImageQuality: job.quality,
          generatorImageSize: job.imageSize ?? job.size ?? "1K",
          codexGenerationSource: media.source,
          sourceFrameId: frame?.elementId,
          ...(job.customData && typeof job.customData === "object" ? job.customData : {}),
        },
      }),
    );
    return { media, placement, frame };
  });

  const results = jobs.map((job, i) => {
    const outcome = generated[i];
    if (!outcome.ok) return { prompt: job.prompt, error: outcome.error };
    const { media, placement, frame } = outcome.value;
    return {
      prompt: job.prompt,
      model: media.model,
      frameElementId: frame?.elementId,
      elementId: placement?.elementId,
      fileId: placement?.fileId,
      bounds: placement?.bounds,
      assetFile: placement?.assetFile,
      assetUrl: placement?.assetUrl,
    };
  });

  const succeeded = results.filter((result) => !result.error).length;
  return {
    ok: true,
    total: jobs.length,
    succeeded,
    failed: jobs.length - succeeded,
    dryRun,
    results,
  };
}

async function generateExcalidrawVideosBatch(args = {}) {
  const jobs = Array.isArray(args.jobs) ? args.jobs : [];
  if (jobs.length === 0) throw new Error("generate_excalidraw_videos_batch requires a non-empty jobs array.");
  for (const job of jobs) {
    if (!nonEmptyString(job?.prompt)) throw new Error("Each video job requires a prompt.");
  }

  const columns = finiteNumber(Number(args.columns), 3);
  const gap = finiteNumber(Number(args.gap), 24);
  const concurrency = finiteNumber(Number(args.concurrency), 1);
  const dryRun = Boolean(args.dryRun);

  const frames = dryRun
    ? []
    : await insertGeneratorFrameBatch({
        projectDir: args.projectDir,
        canvasDir: args.canvasDir,
        frames: jobs.map((job) => ({
          kind: "video",
          prompt: job.prompt,
          model: job.model ?? "grok-imagine-video-hermes",
          aspectRatio: job.aspectRatio ?? job.aspect_ratio ?? "16:9",
          duration: job.duration ?? "5",
          resolution: job.resolution ?? "720p",
          generateAudio: job.generateAudio ?? job.generate_audio ?? true,
          customData: job.customData,
        })),
        columns,
        gap,
        selectCreated: args.selectCreated !== false,
        focusCreated: args.focusCreated !== false,
      });

  let writeQueue = Promise.resolve();
  const enqueueWrite = (fn) => {
    const next = writeQueue.then(fn, fn);
    writeQueue = next.catch(() => {});
    return next;
  };

  const generated = await runWithConcurrency(jobs, concurrency, async (job, index) => {
    const media = await generateVideoMedia({
      ...job,
      aspectRatio: job.aspectRatio ?? job.aspect_ratio,
      duration: job.duration,
      fileName: job.fileName ?? job.videoName ?? job.video_name,
      generateAudio: job.generateAudio ?? job.generate_audio,
      startFramePath: job.startFramePath ?? job.start_frame_path,
      referenceImagePaths: job.referenceImagePaths ?? job.reference_image_paths,
      referenceVideoPaths: job.referenceVideoPaths ?? job.reference_video_paths,
      referenceVideos: job.referenceVideos ?? job.reference_videos,
    });
    if (dryRun) {
      return { media, placement: null, frame: null };
    }
    const frame = frames[index];
    const placement = await enqueueWrite(() =>
      insertExcalidrawVideoMedia({
        projectDir: args.projectDir,
        canvasDir: args.canvasDir,
        mediaBuffer: media.buffer,
        mimeType: media.mimeType,
        fileName: job.fileName ?? job.videoName ?? job.video_name ?? media.fileName,
        anchorElementId: frame?.elementId,
        replaceAnchor: Boolean(frame?.elementId),
        matchAnchor: true,
        selectCreated: false,
        aspectRatio: job.aspectRatio ?? job.aspect_ratio,
        duration: job.duration,
        prompt: job.prompt,
        model: media.model,
        customData: {
          codexGeneratedVideo: true,
          codexGenerationModel: media.model,
          codexGenerationPrompt: job.prompt,
          codexGenerationAspectRatio: job.aspectRatio ?? job.aspect_ratio,
          codexGenerationDuration: job.duration,
          codexGenerationResolution: job.resolution,
          videoPrompt: job.prompt,
          videoModel: job.model,
          videoAspectRatio: job.aspectRatio ?? job.aspect_ratio,
          videoDuration: job.duration,
          videoResolution: job.resolution,
          videoGenerateAudio: job.generateAudio ?? job.generate_audio,
          codexGenerationSource: media.source,
          sourceFrameId: frame?.elementId,
          ...(job.customData && typeof job.customData === "object" ? job.customData : {}),
        },
      }),
    );
    return { media, placement, frame };
  });

  const results = jobs.map((job, i) => {
    const outcome = generated[i];
    if (!outcome.ok) return { prompt: job.prompt, error: outcome.error };
    const { media, placement, frame } = outcome.value;
    return {
      prompt: job.prompt,
      model: media.model,
      frameElementId: frame?.elementId,
      elementId: placement?.elementId,
      fileId: placement?.fileId,
      bounds: placement?.bounds,
      assetFile: placement?.assetFile,
      assetUrl: placement?.assetUrl,
    };
  });

  const succeeded = results.filter((result) => !result.error).length;
  return {
    ok: true,
    total: jobs.length,
    succeeded,
    failed: jobs.length - succeeded,
    dryRun,
    results,
  };
}

function toolDefinitions() {
  return [
    {
      name: TOOL_READ_ME,
      title: "Read Excalidraw MCP Format",
      description: "Return the official-compatible Excalidraw element format for create_view. Call before drawing with create_view.",
      inputSchema: {
        type: "object",
        properties: {},
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
      name: TOOL_CREATE_VIEW,
      title: "Create Excalidraw View",
      description: "Official-compatible create_view tool. Writes Excalidraw-like elements into the project-local canvas used by the browser UI.",
      inputSchema: {
        type: "object",
        properties: {
          elements: { type: "string", description: "JSON array string of Excalidraw-like elements. Supports rectangle, ellipse, diamond, arrow, line, text, cameraUpdate, and delete." },
          projectDir: { type: "string", description: "Absolute project directory containing canvas/." },
          canvasDir: { type: "string", description: "Absolute canvas directory. Overrides projectDir." },
          append: { type: "boolean", description: "Append to the previous official-compatible MCP view instead of replacing it." },
          clearCanvas: { type: "boolean", description: "Mark all existing elements deleted before adding this view." },
          dryRun: { type: "boolean", description: "Parse and plan without saving." },
        },
        required: ["elements"],
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
      description: "Copy a local video into canvas/assets, create a Youtube-AGI-style video media element, and save the scene.",
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
          margin: { type: "number", description: "Canvas units between the new video media element and nearby elements. Defaults to 40." },
          matchAnchor: { type: "boolean", description: "Use the anchor display size when possible. Defaults to true." },
          replaceAnchor: { type: "boolean", description: "Replace the anchor element with the inserted video media element." },
          displayWidth: { type: "number", description: "Displayed media width in canvas units." },
          displayHeight: { type: "number", description: "Displayed media height in canvas units." },
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
            enum: IMAGE_MODEL_IDS,
            description: "Defaults to gpt-image-2-codex. Non-Codex/Hermes models are BuzzAssist cloud models and need buzzassist_login.",
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
          payloadPreview: { type: "boolean", description: "Return the resolved endpoint, request payload, and estimated BuzzAssist credits without generating." },
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
      description: "Generate a video with Grok Imagine(Hermes), insert a Youtube-AGI-style video media element into the canvas, and save the scene.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Video prompt." },
          model: {
            type: "string",
            enum: VIDEO_MODEL_IDS,
            description: "Defaults to grok-imagine-video-hermes. Other models are BuzzAssist cloud models and need buzzassist_login.",
          },
          mode: { type: "string", enum: ["standard", "pro"], description: "Kling quality mode. Defaults to standard." },
          endFramePath: { type: "string", description: "Optional local image path for keyframe end-frame interpolation (Seedance/Kling only)." },
          referenceAudioPaths: { type: "array", items: { type: "string" }, description: "Optional local audio reference paths (Seedance reference mode only)." },
          useMotion: { type: "boolean", description: "Kling v2.6 motion-control mode. Requires startFramePath and one referenceVideoPaths entry." },
          useReference: { type: "boolean", description: "Force reference mode when references are attached." },
          motionOrientation: { type: "string", enum: ["image", "video"], description: "Kling v2.6 motion character orientation. Defaults to image." },
          projectDir: { type: "string", description: "Absolute project directory containing canvas/." },
          canvasDir: { type: "string", description: "Absolute canvas directory. Overrides projectDir." },
          anchorElementId: { type: "string", description: "Existing Excalidraw element id to place beside." },
          sourceElementId: { type: "string", description: "Alias for anchorElementId." },
          fileName: { type: "string", description: "Optional destination filename under canvas/assets/." },
          videoName: { type: "string", description: "Alias for fileName." },
          aspectRatio: { type: "string", description: "Aspect ratio such as 16:9, 9:16, or 1:1." },
          aspect_ratio: { type: "string", description: "Alias for aspectRatio." },
          duration: { type: "string", description: "Duration seconds. Grok Hermes clamps text-to-video to 1-15 seconds." },
          resolution: { type: "string", description: "480p or 720p." },
          generateAudio: { type: "boolean", description: "Whether Grok Imagine should generate audio when supported." },
          generate_audio: { type: "boolean", description: "Alias for generateAudio." },
          startFramePath: { type: "string", description: "Optional local image path for image-to-video start frame." },
          start_frame_path: { type: "string", description: "Alias for startFramePath." },
          referenceImagePaths: { type: "array", items: { type: "string" }, description: "Optional local reference image paths." },
          reference_image_paths: { type: "array", items: { type: "string" }, description: "Alias for referenceImagePaths." },
          referenceVideoPaths: { type: "array", items: { type: "string" }, description: "Optional local reference video paths." },
          reference_video_paths: { type: "array", items: { type: "string" }, description: "Alias for referenceVideoPaths." },
          referenceVideos: { type: "array", items: { type: "string" }, description: "Optional reference video data URLs or URLs." },
          reference_videos: { type: "array", items: { type: "string" }, description: "Alias for referenceVideos." },
          payloadPreview: { type: "boolean", description: "Return the resolved endpoint, request payload, and estimated BuzzAssist credits without generating." },
          placement: { type: "string", enum: ["right", "left", "below", "replace", "inside"] },
          margin: { type: "number" },
          matchAnchor: { type: "boolean" },
          replaceAnchor: { type: "boolean", description: "Replace the anchor element with the generated video media element." },
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
      name: TOOL_GENERATE_IMAGES_BATCH,
      title: "Generate Excalidraw Images (Batch)",
      description: "Create Youtube-AGI-style image generator frames first, then generate many images with GPT-Image-2.0(Codex) or Grok Imagine(Hermes) and replace each frame as its result finishes.",
      inputSchema: {
        type: "object",
        properties: {
          jobs: {
            type: "array",
            description: "Image jobs to generate. Each requires a prompt.",
            items: {
              type: "object",
              properties: {
                prompt: { type: "string", description: "Image prompt." },
                model: {
                  type: "string",
                  enum: IMAGE_MODEL_IDS,
                  description: "Defaults to gpt-image-2-codex. Non-Codex/Hermes models need buzzassist_login.",
                },
                aspectRatio: { type: "string", description: "Aspect ratio such as 1:1, 16:9, or 9:16." },
                imageSize: { type: "string", description: "Image size or Hermes resolution hint." },
                quality: { type: "string", description: "Quality hint. high maps to Grok quality mode." },
                referenceImagePaths: { type: "array", items: { type: "string" }, description: "Optional local image references for Hermes image edit." },
                fileName: { type: "string", description: "Optional destination filename under canvas/assets/." },
                customData: { type: "object", description: "Additional Excalidraw element customData." },
              },
              required: ["prompt"],
              additionalProperties: true,
            },
          },
          columns: { type: "number", description: "Grid columns. Defaults to 4." },
          gap: { type: "number", description: "Canvas units between grid cells. Defaults to 24." },
          concurrency: { type: "number", description: "Parallel generations. Defaults to 3." },
          projectDir: { type: "string", description: "Absolute project directory containing canvas/." },
          canvasDir: { type: "string", description: "Absolute canvas directory. Overrides projectDir." },
          selectCreated: { type: "boolean", description: "Select the inserted elements after saving." },
          focusCreated: { type: "boolean", description: "Focus the canvas viewport on the newly created generator-frame grid. Defaults to true." },
          dryRun: { type: "boolean", description: "Generate without copying or saving." },
        },
        required: ["jobs"],
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
      name: TOOL_GENERATE_VIDEOS_BATCH,
      title: "Generate Excalidraw Videos (Batch)",
      description: "Create Youtube-AGI-style video generator frames first, then generate many videos with Grok Imagine(Hermes) and replace each frame as its result finishes.",
      inputSchema: {
        type: "object",
        properties: {
          jobs: {
            type: "array",
            description: "Video jobs to generate. Each requires a prompt.",
            items: {
              type: "object",
              properties: {
                prompt: { type: "string", description: "Video prompt." },
                model: {
                  type: "string",
                  enum: VIDEO_MODEL_IDS,
                  description: "Defaults to grok-imagine-video-hermes. Other models need buzzassist_login.",
                },
                aspectRatio: { type: "string", description: "Aspect ratio such as 16:9, 9:16, or 1:1." },
                duration: { type: "string", description: "Duration seconds. Grok Hermes clamps text-to-video to 1-15 seconds." },
                resolution: { type: "string", description: "480p or 720p." },
                generateAudio: { type: "boolean", description: "Whether Grok Imagine should generate audio when supported." },
                referenceImagePaths: { type: "array", items: { type: "string" }, description: "Optional local reference image paths." },
                fileName: { type: "string", description: "Optional destination filename under canvas/assets/." },
                customData: { type: "object", description: "Additional Excalidraw element customData." },
              },
              required: ["prompt"],
              additionalProperties: true,
            },
          },
          columns: { type: "number", description: "Grid columns. Defaults to 3." },
          gap: { type: "number", description: "Canvas units between grid cells. Defaults to 24." },
          concurrency: { type: "number", description: "Parallel generations. Defaults to 1 because video is heavy." },
          projectDir: { type: "string", description: "Absolute project directory containing canvas/." },
          canvasDir: { type: "string", description: "Absolute canvas directory. Overrides projectDir." },
          selectCreated: { type: "boolean", description: "Select the inserted elements after saving." },
          focusCreated: { type: "boolean", description: "Focus the canvas viewport on the newly created generator-frame grid. Defaults to true." },
          dryRun: { type: "boolean", description: "Generate without copying or saving." },
        },
        required: ["jobs"],
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
      name: TOOL_GENERATE_SUBTITLES,
      title: "Generate Excalidraw Subtitles",
      description: "Generate Japanese SRT subtitles from an audio file via BuzzAssist cloud (ElevenLabs forced alignment when a script is given, Scribe v2 otherwise), save the SRT under canvas/assets, and place an SRT card on the canvas. Requires buzzassist_login. For best line breaks use the two-step LLM flow: call once with returnWordsOnly=true to get timed words, decide semantic line breaks yourself (respect maxCharsPerLine and 1-2 lines per cue), then call again with subtitleLines to render and place the SRT without a second cloud call.",
      inputSchema: {
        type: "object",
        properties: {
          audioPath: { type: "string", description: "Absolute local audio file path (mp3/wav/m4a/ogg/opus/webm/flac/aac). Required unless subtitleLines is given." },
          returnWordsOnly: { type: "boolean", description: "Return the transcript and timed words without building SRT or touching the canvas. Use as step 1 of the LLM segmentation flow." },
          subtitleLines: {
            type: "array",
            description: "Pre-segmented cues (step 2 of the LLM flow). Each cue is rendered as one SRT block; no cloud call is made.",
            items: {
              type: "object",
              properties: {
                text: { type: "string", description: "Cue text. Use \\n for a second line." },
                start: { type: "number", description: "Cue start seconds." },
                end: { type: "number", description: "Cue end seconds." },
              },
              required: ["text", "start", "end"],
              additionalProperties: false,
            },
          },
          scriptText: { type: "string", description: "Full narration script. Providing it switches to scripted mode (forced alignment)." },
          scriptPath: { type: "string", description: "Absolute path to a UTF-8 script text file. Alternative to scriptText." },
          mode: { type: "string", enum: ["scripted", "scriptless"], description: "Defaults to scripted when a script is provided, else scriptless." },
          lineCount: { type: "number", description: "Subtitle lines per cue: 1 or 2." },
          maxCharsPerLine: { type: "number", description: "Max characters per line (Japanese-aware)." },
          holdSeconds: { type: "number", description: "Extra seconds each cue stays on screen." },
          punctuationMode: { type: "string", enum: ["auto", "none"] },
          fillerMode: { type: "string", enum: ["keep", "safe", "contextual"] },
          glossary: { type: "array", items: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"], additionalProperties: false }, description: "Term corrections applied to the transcription before segmentation (用語辞書)." },
          normalizeAudio: { type: "boolean", description: "Loudness-normalize quiet audio before transcription. Defaults to true." },
          durationSeconds: { type: "number", description: "Audio duration in seconds. Probed with ffprobe when omitted." },
          fileName: { type: "string", description: "Destination SRT filename under canvas/assets/." },
          projectDir: { type: "string", description: "Absolute project directory containing canvas/." },
          canvasDir: { type: "string", description: "Absolute canvas directory. Overrides projectDir." },
          anchorElementId: { type: "string", description: "Existing Excalidraw element id to place beside." },
          placement: { type: "string", enum: ["right", "left", "below", "replace", "inside"] },
          margin: { type: "number" },
          dryRun: { type: "boolean", description: "Generate the SRT without saving it to the canvas." },
        },
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
      name: TOOL_SILENCE_CUT_VIDEO,
      title: "Silence Cut Excalidraw Video",
      description: "Remove silences from a local video (jet cut), then insert the cut video into the canvas with cut statistics. model=ffmpeg-local runs fully offline; model=elevenlabs-scribe-v2 transcribes via BuzzAssist (requires buzzassist_login, ~1 credit/min) and additionally removes fillers, coughs, and retakes from word timestamps. Use dryRun first to preview the cut plan without rendering.",
      inputSchema: {
        type: "object",
        properties: {
          videoPath: { type: "string", description: "Absolute local video path to cut." },
          model: { type: "string", enum: ["ffmpeg-local", "elevenlabs-scribe-v2"], description: "Cut engine. Defaults to ffmpeg-local." },
          fillerRemoval: { type: "number", description: "0-100. Scribe mode only: remove Japanese fillers (えー/あのー…). 0 off, 35+ adds その/なんか, 70+ adds ていうか/やっぱり." },
          coughRemoval: { type: "number", description: "0-100. Scribe mode only: cut coughs/sneezes detected as audio events." },
          retakeRemoval: { type: "number", description: "0-100. Scribe mode only: cut retake markers (いや/違う/もう一回…); 70+ also rewinds over the flubbed phrase." },
          instructionPrompt: { type: "string", description: "Scribe mode only: natural-language bias, e.g. テンポよく (tighter) or 自然に余韻を残して (looser)." },
          glossary: { type: "array", items: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"], additionalProperties: false }, description: "Scribe mode only: term corrections applied to the transcription." },
          detectSeconds: { type: "number", description: "Minimum silence length to detect. Defaults to 0.6." },
          thresholdDb: { type: "number", description: "Silence threshold in dB (ffmpeg-local only). Defaults to -34." },
          keepSeconds: { type: "number", description: "Silence seconds to keep around cuts. Defaults to 0.25." },
          preMarginSeconds: { type: "number", description: "Safety margin before speech. Defaults to 0.08." },
          postMarginSeconds: { type: "number", description: "Safety margin after speech. Defaults to 0.12." },
          audioFadeSeconds: { type: "number", description: "Audio crossfade at cut points. Defaults to 0.03." },
          fileName: { type: "string", description: "Destination filename under canvas/assets/." },
          projectDir: { type: "string", description: "Absolute project directory containing canvas/." },
          canvasDir: { type: "string", description: "Absolute canvas directory. Overrides projectDir." },
          anchorElementId: { type: "string", description: "Existing Excalidraw element id to place beside." },
          placement: { type: "string", enum: ["right", "left", "below", "replace", "inside"] },
          margin: { type: "number" },
          displayWidth: { type: "number" },
          displayHeight: { type: "number" },
          dryRun: { type: "boolean", description: "Preview only: return the cut plan (ranges, candidates, durations) without rendering or touching the canvas." },
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
      name: TOOL_BUZZASSIST_LOGIN,
      title: "BuzzAssist Login",
      description: "Start BuzzAssist browser sign-in for fal-backed media models (Seedance/Kling/Nano Banana/Seedream/GPT Image 2 API/Grok API) and cloud subtitles. Opens the browser and returns the auth URL; confirm completion with buzzassist_auth_status.",
      inputSchema: {
        type: "object",
        properties: {
          openBrowser: { type: "boolean", description: "Open the sign-in URL in the default browser. Defaults to true." },
        },
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
      name: TOOL_BUZZASSIST_AUTH_STATUS,
      title: "BuzzAssist Auth Status",
      description: "Return the current BuzzAssist media auth status (logged in, user id, expiry).",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
  ];
}

let pendingBuzzAssistLogin = null;

async function handleBuzzAssistLogin(args = {}) {
  const openBrowser = args.openBrowser !== false;
  let authUrl = null;
  const urlReady = new Promise((resolveUrl) => {
    const login = loginBuzzAssistViaBrowser({
      openBrowser,
      onAuthUrl: (url) => {
        authUrl = url;
        resolveUrl(url);
      },
    });
    pendingBuzzAssistLogin = login;
    login
      .then(() => {
        if (pendingBuzzAssistLogin === login) pendingBuzzAssistLogin = null;
      })
      .catch(() => {
        if (pendingBuzzAssistLogin === login) pendingBuzzAssistLogin = null;
      });
  });
  await urlReady;
  return {
    ok: true,
    authUrl,
    openedBrowser: openBrowser,
    message: openBrowser
      ? "Opened the BuzzAssist sign-in page in the browser. Complete sign-in there, then check buzzassist_auth_status."
      : `Open this URL in a browser to sign in: ${authUrl}`,
  };
}

function normalizeProvidedSubtitleLines(rawLines) {
  const lines = rawLines
    .map((line) => ({
      text: String(line?.text ?? "").trim(),
      start: Number(line?.start),
      end: Number(line?.end),
    }))
    .filter((line) => line.text && Number.isFinite(line.start) && Number.isFinite(line.end) && line.end > line.start)
    .sort((a, b) => a.start - b.start);
  if (lines.length === 0) throw new Error("subtitleLines must contain cues with text, start, and end (end > start).");
  return lines;
}

async function generateExcalidrawSubtitles(args = {}) {
  if (Array.isArray(args.subtitleLines) && args.subtitleLines.length > 0) {
    const holdSeconds = normalizeSubtitleHoldSeconds(args.holdSeconds);
    const lines = normalizeProvidedSubtitleLines(args.subtitleLines).map((line, index, all) => {
      const nextStart = index + 1 < all.length ? all[index + 1].start : Infinity;
      return { ...line, end: Math.min(line.end + holdSeconds, nextStart) };
    });
    const srtText = renderSrt(lines);
    const placement = args.dryRun
      ? null
      : await insertExcalidrawSubtitle({
          projectDir: args.projectDir,
          canvasDir: args.canvasDir,
          srtText,
          subtitleLines: lines,
          fileName: args.fileName,
          model: args.model ?? "host-llm-segmented",
          mode: args.mode ?? "llm",
          anchorElementId: args.anchorElementId,
          placement: args.placement,
          margin: args.margin,
          customData: args.customData,
        });
    return {
      ok: true,
      mode: args.mode ?? "llm",
      model: args.model ?? "host-llm-segmented",
      cueCount: lines.length,
      srtPreview: srtText.split("\n").slice(0, 12).join("\n"),
      ...(placement
        ? { elementId: placement.elementId, groupId: placement.groupId, assetFile: placement.assetFile, assetUrl: placement.assetUrl, bounds: placement.bounds }
        : {}),
      dryRun: Boolean(args.dryRun),
    };
  }

  if (!nonEmptyString(args.audioPath)) {
    throw new Error("audioPath is required unless subtitleLines is provided.");
  }

  const generated = await generateSubtitleSrt({
    audioPath: args.audioPath,
    scriptText: args.scriptText,
    scriptPath: args.scriptPath,
    mode: args.mode,
    model: args.model,
    lineCount: args.lineCount,
    maxCharsPerLine: args.maxCharsPerLine,
    holdSeconds: args.holdSeconds,
    punctuationMode: args.punctuationMode,
    fillerMode: args.fillerMode,
    glossary: await mergedProjectGlossary(args),
    normalizeAudio: args.normalizeAudio,
    durationSeconds: args.durationSeconds,
    requestId: args.requestId,
  });

  if (args.returnWordsOnly) {
    return {
      ok: true,
      returnWordsOnly: true,
      mode: generated.mode,
      model: generated.model,
      provider: generated.provider,
      text: generated.text,
      words: generated.words,
      durationSeconds: generated.durationSeconds,
      credits: generated.credits,
      estimatedCostYen: generated.estimatedCostYen,
      requestId: generated.requestId,
      hint: "Decide semantic line breaks from words (respect maxCharsPerLine, 1-2 lines per cue, natural Japanese boundaries), then call this tool again with subtitleLines.",
    };
  }

  const placement = args.dryRun
    ? null
    : await insertExcalidrawSubtitle({
        projectDir: args.projectDir,
        canvasDir: args.canvasDir,
        srtText: generated.srtText,
        subtitleLines: generated.subtitleLines,
        fileName: args.fileName,
        model: generated.model,
        mode: generated.mode,
        anchorElementId: args.anchorElementId,
        placement: args.placement,
        margin: args.margin,
        customData: {
          subtitleLineCount: args.lineCount,
          subtitleMaxCharsPerLine: args.maxCharsPerLine,
          subtitleHoldSeconds: args.holdSeconds,
          subtitleDurationSeconds: generated.durationSeconds,
          subtitleCredits: generated.credits,
          ...(args.customData && typeof args.customData === "object" ? args.customData : {}),
        },
      });

  return {
    ok: true,
    mode: generated.mode,
    model: generated.model,
    provider: generated.provider,
    cueCount: generated.subtitleLines.length,
    durationSeconds: generated.durationSeconds,
    credits: generated.credits,
    estimatedCostYen: generated.estimatedCostYen,
    srtPreview: generated.srtText.split("\n").slice(0, 12).join("\n"),
    ...(placement
      ? {
          elementId: placement.elementId,
          groupId: placement.groupId,
          assetFile: placement.assetFile,
          assetUrl: placement.assetUrl,
          bounds: placement.bounds,
        }
      : {}),
    dryRun: Boolean(args.dryRun),
  };
}

async function silenceCutExcalidrawVideo(args = {}) {
  const videoPath = nonEmptyString(args.videoPath);
  if (!videoPath) throw new Error("videoPath is required.");

  const outputDir = join(tmpdir(), "codex-excalidraw-silence-cut");
  const cut = await silenceCutVideo({
    inputPath: pathResolve(videoPath),
    outputDir,
    fileName: args.fileName,
    model: args.model,
    fillerRemoval: args.fillerRemoval,
    coughRemoval: args.coughRemoval,
    retakeRemoval: args.retakeRemoval,
    instructionPrompt: args.instructionPrompt,
    glossary: await mergedProjectGlossary(args),
    detectSeconds: args.detectSeconds,
    thresholdDb: args.thresholdDb,
    keepSeconds: args.keepSeconds,
    preMarginSeconds: args.preMarginSeconds,
    postMarginSeconds: args.postMarginSeconds,
    audioFadeSeconds: args.audioFadeSeconds,
    planOnly: Boolean(args.dryRun),
  });

  const stats = {
    inputDuration: cut.inputDuration,
    outputDuration: cut.outputDuration,
    cutDuration: cut.cutDuration,
    cutCount: cut.cutCount,
  };

  if (args.dryRun) {
    return {
      ok: true,
      dryRun: true,
      model: cut.model,
      ...stats,
      plan: cut.plan,
      ...(cut.transcription ? { transcription: cut.transcription } : {}),
    };
  }

  const placement = await insertExcalidrawVideoMedia({
        projectDir: args.projectDir,
        canvasDir: args.canvasDir,
        videoPath: cut.outputPath,
        fileName: args.fileName ?? basename(cut.outputPath),
        anchorElementId: args.anchorElementId,
        placement: args.placement,
        margin: args.margin,
        displayWidth: args.displayWidth,
        displayHeight: args.displayHeight,
        duration: cut.outputDuration,
        customData: {
          codexSilenceCutVideo: true,
          silenceCut: stats,
          silenceCutSourcePath: pathResolve(videoPath),
          ...(args.customData && typeof args.customData === "object" ? args.customData : {}),
        },
      });

  return {
    ok: true,
    model: cut.model,
    ...stats,
    outputPath: cut.outputPath,
    ...(cut.transcription ? { transcription: cut.transcription } : {}),
    ...(placement
      ? {
          elementId: placement.elementId,
          assetFile: placement.assetFile,
          assetUrl: placement.assetUrl,
          bounds: placement.bounds,
        }
      : {}),
    dryRun: false,
  };
}

const CANVAS_AUTO_OPEN_TOOLS = new Set([
  TOOL_CREATE_VIEW,
  TOOL_INSERT_IMAGE,
  TOOL_INSERT_VIDEO,
  TOOL_GENERATE_IMAGE,
  TOOL_GENERATE_VIDEO,
  TOOL_GENERATE_IMAGES_BATCH,
  TOOL_GENERATE_VIDEOS_BATCH,
  TOOL_GENERATE_SUBTITLES,
  TOOL_SILENCE_CUT_VIDEO,
]);

async function handleToolCall(id, params) {
  if (CANVAS_AUTO_OPEN_TOOLS.has(params?.name)) {
    await ensureCanvasVisible(params.arguments ?? {});
  }
  if (params?.name === TOOL_GENERATE_SUBTITLES) {
    const result = await generateExcalidrawSubtitles(params.arguments ?? {});
    sendResult(id, {
      content: [
        {
          type: "text",
          text: `Generated ${result.cueCount} subtitle cue(s) with ${result.model} (${result.mode})${result.dryRun ? " [dry run]" : ""}.`,
        },
      ],
      structuredContent: result,
    });
    return;
  }

  if (params?.name === TOOL_SILENCE_CUT_VIDEO) {
    const result = await silenceCutExcalidrawVideo(params.arguments ?? {});
    sendResult(id, {
      content: [
        {
          type: "text",
          text: `Silence-cut ${result.cutCount} range(s): ${result.inputDuration.toFixed(1)}s -> ${result.outputDuration.toFixed(1)}s (${result.cutDuration.toFixed(1)}s removed)${result.dryRun ? " [dry run]" : ""}.`,
        },
      ],
      structuredContent: result,
    });
    return;
  }

  if (params?.name === TOOL_BUZZASSIST_LOGIN) {
    const result = await handleBuzzAssistLogin(params.arguments ?? {});
    sendResult(id, {
      content: [{ type: "text", text: result.message }],
      structuredContent: result,
    });
    return;
  }

  if (params?.name === TOOL_BUZZASSIST_AUTH_STATUS) {
    const status = await getBuzzAssistAuthStatus();
    const summary = status.loggedIn
      ? `Logged in as ${status.userId ?? "unknown user"} (source: ${status.source}).${status.expiresSoon ? ` WARNING: token expires in ${status.expiresInDays} day(s) — run buzzassist_login to renew.` : ""}`
      : status.expired
        ? "BuzzAssist login has expired. Run buzzassist_login."
        : "Not logged in to BuzzAssist. Run buzzassist_login.";
    sendResult(id, {
      content: [{ type: "text", text: summary }],
      structuredContent: status,
    });
    return;
  }

  if (params?.name === TOOL_READ_ME) {
    sendResult(id, {
      content: [{ type: "text", text: OFFICIAL_EXCALIDRAW_README }],
      structuredContent: { ok: true },
    });
    return;
  }

  if (params?.name === TOOL_CREATE_VIEW) {
    const result = await createExcalidrawView(params.arguments ?? {});
    sendResult(id, {
      content: [
        {
          type: "text",
          text: `${result.dryRun ? "Planned" : "Created"} Excalidraw view with ${result.addedElementCount} element(s).`,
        },
      ],
      structuredContent: result,
    });
    return;
  }

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
          text: `${result.dryRun ? "Planned" : "Inserted"} video media element ${result.elementId} at (${result.bounds.x}, ${result.bounds.y}) sized ${result.bounds.width}x${result.bounds.height}.`,
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
          text: result.payloadPreview
            ? `Payload preview for ${result.model}${result.endpoint ? ` -> ${result.endpoint}` : ""}: ~${result.estimatedCredits ?? "?"} credits.`
            : `${result.dryRun ? "Planned" : "Generated"} image ${result.elementId} at (${result.bounds.x}, ${result.bounds.y}) sized ${result.bounds.width}x${result.bounds.height}.`,
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
          text: result.payloadPreview
            ? `Payload preview for ${result.model}${result.endpoint ? ` -> ${result.endpoint}` : ""}: ~${result.estimatedCredits ?? "?"} credits.`
            : `${result.dryRun ? "Planned" : "Generated"} video media element ${result.elementId} at (${result.bounds.x}, ${result.bounds.y}) sized ${result.bounds.width}x${result.bounds.height}.`,
        },
      ],
      structuredContent: result,
    });
    return;
  }

  if (params?.name === TOOL_GENERATE_IMAGES_BATCH) {
    const result = await generateExcalidrawImagesBatch(params.arguments ?? {});
    sendResult(id, {
      content: [
        {
          type: "text",
          text: `${result.dryRun ? "Planned" : "Generated"} ${result.succeeded}/${result.total} image(s) as a grid${result.failed ? `, ${result.failed} failed` : ""}.`,
        },
      ],
      structuredContent: result,
    });
    return;
  }

  if (params?.name === TOOL_GENERATE_VIDEOS_BATCH) {
    const result = await generateExcalidrawVideosBatch(params.arguments ?? {});
    sendResult(id, {
      content: [
        {
          type: "text",
          text: `${result.dryRun ? "Planned" : "Generated"} ${result.succeeded}/${result.total} video media element(s) as a grid${result.failed ? `, ${result.failed} failed` : ""}.`,
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
      instructions: MEDIA_GENERATION_AGENT_INSTRUCTIONS,
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

// Startup housekeeping: migrate legacy inline file records, sweep stale .tmp
// files, and trash orphaned assets. Fire-and-forget — stdout is reserved for
// JSON-RPC, so results go to stderr.
performCanvasMaintenance({})
  .then((results) => {
    const summary = JSON.stringify(results);
    if (summary !== "{}") process.stderr.write(`[canvas-maintenance] ${summary}\n`);
  })
  .catch((error) => process.stderr.write(`[canvas-maintenance] failed: ${error?.message}\n`));

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
