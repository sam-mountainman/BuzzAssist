import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ASSETS_ROUTE,
  assetMimeTypes,
  loadScene,
  readSelectionState,
  resolveCanvasDir,
} from "./canvasScene.mjs";

export const AGENT_ATTACHMENTS_DIR = ".agent-attachments";

const TEXT_MIME_PREFIXES = ["text/"];
const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".srt", ".txt", ".xml"]);
const IMAGE_INLINE_MAX_BYTES = 4 * 1024 * 1024;
const TEXT_INLINE_MAX_BYTES = 512 * 1024;
const ALLOWED_KINDS = new Set(["image", "video", "audio", "srt", "xml", "script", "file"]);

function isSafeChildPath(parent, child) {
  const pathToChild = relative(parent, child);
  return Boolean(pathToChild) && !pathToChild.startsWith("..") && !pathToChild.includes(`..${sep}`);
}

function sanitizeBundleId(value) {
  return (
    String(value || "")
      .replace(/[^a-zA-Z0-9_-]+/g, "")
      .slice(0, 96) || ""
  );
}

function createBundleId() {
  return `att_${Date.now().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function canvasLeafFileName(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("data:") || trimmed.startsWith("blob:")) return "";
  const clean = trimmed.split(/[?#]/)[0];
  const parts = clean.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) || "";
}

function decodeAssetUrlName(assetUrl) {
  if (typeof assetUrl !== "string" || !assetUrl) return "";
  try {
    const url = new URL(assetUrl, "http://127.0.0.1");
    if (!url.pathname.startsWith(ASSETS_ROUTE)) return "";
    return decodeURIComponent(url.pathname.slice(ASSETS_ROUTE.length));
  } catch {
    const clean = assetUrl.split(/[?#]/)[0];
    if (!clean.startsWith(ASSETS_ROUTE)) return "";
    return decodeURIComponent(clean.slice(ASSETS_ROUTE.length));
  }
}

function normalizeAssetUrl(value) {
  if (typeof value !== "string" || !value) return "";
  try {
    const url = new URL(value, "http://127.0.0.1");
    if (!url.pathname.startsWith(ASSETS_ROUTE)) return "";
    return `${url.pathname}${url.search || ""}`;
  } catch {
    return value.startsWith(ASSETS_ROUTE) ? value : "";
  }
}

function mimeTypeForFileName(fileName) {
  return assetMimeTypes.get(extname(fileName).toLowerCase()) || "application/octet-stream";
}

function kindFromMimeAndName(mimeType, fileName) {
  const mime = String(mimeType || "").toLowerCase();
  const ext = extname(String(fileName || "")).toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (ext === ".srt" || mime === "application/x-subrip") return "srt";
  if (ext === ".xml" || mime === "application/xml" || mime === "text/xml") return "xml";
  if (TEXT_EXTENSIONS.has(ext) || TEXT_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix))) return "script";
  return "file";
}

function kindFromElement(element, fallbackMimeType, fallbackName) {
  const customData = element?.customData ?? {};
  const customKind = customData.codexMediaKind;
  if (ALLOWED_KINDS.has(customKind)) return customKind;
  if (customData.codexGeneratedVideo === true) return "video";
  if (customData.codexGeneratedSubtitle === true) return "srt";
  if (customData.codexGeneratedImage === true || element?.type === "image") return "image";
  return kindFromMimeAndName(fallbackMimeType, fallbackName);
}

function resolveAssetPathFromUrl(canvasDir, assetUrl) {
  const fileName = decodeAssetUrlName(assetUrl);
  if (!fileName) return "";
  const assetsDir = join(canvasDir, "assets");
  const filePath = resolve(assetsDir, fileName);
  return isSafeChildPath(assetsDir, filePath) ? filePath : "";
}

function resolveAssetPath(canvasDir, item = {}) {
  const assetsDir = join(canvasDir, "assets");
  const rawPath = typeof item.path === "string" ? item.path : "";
  if (rawPath) {
    const filePath = resolve(rawPath);
    if (isSafeChildPath(assetsDir, filePath)) return filePath;
  }
  return resolveAssetPathFromUrl(canvasDir, item.assetUrl || item.url || "");
}

function displayNameForElement(element, file, outputAsset) {
  const customData = element?.customData ?? {};
  return (
    canvasLeafFileName(outputAsset?.name) ||
    canvasLeafFileName(customData.codexFileName) ||
    canvasLeafFileName(customData.generatorFileName) ||
    canvasLeafFileName(customData.codexAssetPath) ||
    canvasLeafFileName(customData.generatorAssetPath) ||
    canvasLeafFileName(decodeAssetUrlName(customData.codexAssetUrl)) ||
    canvasLeafFileName(decodeAssetUrlName(customData.generatorAssetUrl)) ||
    canvasLeafFileName(decodeAssetUrlName(file?.codexAssetUrl)) ||
    canvasLeafFileName(decodeAssetUrlName(file?.dataURL)) ||
    canvasLeafFileName(element?.id) ||
    "canvas-asset"
  );
}

function elementOutputAssets(element) {
  const customData = element?.customData ?? {};
  const output = customData.silenceCutOutputAsset;
  if (output && typeof output === "object" && (output.url || output.path)) {
    return [output];
  }
  return [];
}

async function normalizeAssetRecord(canvasDir, rawAsset, sourceElement = null, fileRecord = null, outputAsset = null) {
  const assetUrl = normalizeAssetUrl(rawAsset?.assetUrl || rawAsset?.url || outputAsset?.url || "");
  const filePath = resolveAssetPath(canvasDir, {
    path: rawAsset?.path || outputAsset?.path || "",
    assetUrl,
  });
  if (!filePath) return null;
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) return null;
  const fileName =
    canvasLeafFileName(rawAsset?.fileName || rawAsset?.name) ||
    displayNameForElement(sourceElement, fileRecord, outputAsset) ||
    basename(filePath);
  const mimeType =
    rawAsset?.mimeType ||
    outputAsset?.mimeType ||
    sourceElement?.customData?.codexAssetMimeType ||
    sourceElement?.customData?.codexVideoMimeType ||
    fileRecord?.mimeType ||
    mimeTypeForFileName(filePath);
  const kind = ALLOWED_KINDS.has(rawAsset?.kind)
    ? rawAsset.kind
    : kindFromElement(sourceElement, mimeType, fileName);
  return {
    id: sourceElement?.id || rawAsset?.id || `${kind}_${basename(filePath)}`,
    elementId: sourceElement?.id || "",
    kind,
    name: fileName,
    fileName: basename(filePath),
    mimeType,
    size: info.size,
    path: filePath,
    uri: pathToFileURL(filePath).href,
    assetUrl: assetUrl || `${ASSETS_ROUTE}${encodeURIComponent(basename(filePath))}`,
    createdAt: info.birthtime?.toISOString?.() || null,
    modifiedAt: info.mtime?.toISOString?.() || null,
  };
}

async function selectedAssetsFromScene(args = {}) {
  const canvasDir = resolveCanvasDir(args);
  const scene = await loadScene(args);
  const { selection, selectionFile } = await readSelectionState(args);
  const selectedIds = Array.isArray(selection.selectedElementIds) && selection.selectedElementIds.length
    ? selection.selectedElementIds
    : Array.isArray(selection.selectedElements)
      ? selection.selectedElements.map((element) => element?.id).filter(Boolean)
      : [];
  const selectedIdSet = new Set(selectedIds);
  const assets = [];
  for (const element of scene.elements ?? []) {
    if (!selectedIdSet.has(element?.id) || element?.isDeleted) continue;
    const customData = element.customData ?? {};
    const file = element.fileId ? scene.files?.[element.fileId] : null;
    const directUrl = customData.codexAssetUrl || customData.generatorAssetUrl || element.link || file?.codexAssetUrl || file?.dataURL || "";
    const directPath = customData.codexAssetPath || customData.generatorAssetPath || "";
    const direct = await normalizeAssetRecord(canvasDir, { assetUrl: directUrl, path: directPath }, element, file);
    if (direct) assets.push(direct);
    for (const outputAsset of elementOutputAssets(element)) {
      const output = await normalizeAssetRecord(canvasDir, outputAsset, element, file, outputAsset);
      if (output) assets.push(output);
    }
  }
  return { assets, selection, selectionFile, sceneFile: join(canvasDir, "excalidraw-canvas.json") };
}

function uniqueAssets(assets) {
  const seen = new Set();
  const result = [];
  for (const asset of assets) {
    if (!asset?.path) continue;
    const key = resolve(asset.path);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(asset);
  }
  return result;
}

async function writeJsonAtomic(filePath, payload) {
  await mkdir(dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tempFile, filePath);
}

export async function createCanvasAttachmentBundle(args = {}) {
  const canvasDir = resolveCanvasDir(args);
  const explicitAssets = Array.isArray(args.assets) ? args.assets : [];
  let source = args.source || "selection";
  let selection = null;
  let selectionFile = null;
  let sceneFile = null;
  let normalizedAssets = [];

  if (explicitAssets.length) {
    source = args.source || "ui";
    normalizedAssets = await Promise.all(explicitAssets.map((asset) => normalizeAssetRecord(canvasDir, asset)));
  } else {
    const selected = await selectedAssetsFromScene(args);
    normalizedAssets = selected.assets;
    selection = selected.selection;
    selectionFile = selected.selectionFile;
    sceneFile = selected.sceneFile;
  }

  const assets = uniqueAssets(normalizedAssets.filter(Boolean));
  if (assets.length === 0) {
    throw new Error("添付できるキャンバス上の画像・動画・SRT・XMLが選択されていません。");
  }

  const bundleId = createBundleId();
  const createdAt = new Date().toISOString();
  const bundleDir = join(canvasDir, AGENT_ATTACHMENTS_DIR, bundleId);
  const manifestPath = join(bundleDir, "manifest.json");
  const manifest = {
    version: 1,
    id: bundleId,
    createdAt,
    source,
    canvasDir,
    projectDir: args.projectDir || "",
    note: typeof args.note === "string" ? args.note.trim() : "",
    assets,
    selection,
    selectionFile,
    sceneFile,
    usage: {
      codex: `BuzzAssistのキャンバス添付 ${bundleId} を読んで。`,
      claude: `BuzzAssistのキャンバス添付 ${bundleId} を読んで。`,
      tool: "read_canvas_attachment_bundle",
    },
  };
  await writeJsonAtomic(manifestPath, manifest);
  await writeJsonAtomic(join(canvasDir, AGENT_ATTACHMENTS_DIR, "latest.json"), {
    bundleId,
    manifestPath,
    createdAt,
    assetCount: assets.length,
  });
  return { ...manifest, manifestPath };
}

export async function listCanvasAttachmentBundles(args = {}) {
  const canvasDir = resolveCanvasDir(args);
  const baseDir = join(canvasDir, AGENT_ATTACHMENTS_DIR);
  const limit = Math.max(1, Math.min(50, Number(args.limit) || 10));
  const entries = await readdir(baseDir, { withFileTypes: true }).catch(() => []);
  const manifests = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const bundleId = sanitizeBundleId(entry.name);
    if (!bundleId) continue;
    const manifest = await readCanvasAttachmentBundle({ ...args, bundleId, includeContent: false }).catch(() => null);
    if (manifest) manifests.push(manifest);
  }
  return manifests
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, limit);
}

export async function readCanvasAttachmentBundle(args = {}) {
  const canvasDir = resolveCanvasDir(args);
  let bundleId = sanitizeBundleId(args.bundleId || args.id || "");
  if (!bundleId || bundleId === "latest") {
    const latest = JSON.parse(await readFile(join(canvasDir, AGENT_ATTACHMENTS_DIR, "latest.json"), "utf8"));
    bundleId = sanitizeBundleId(latest.bundleId);
  }
  if (!bundleId) throw new Error("bundleId is required.");
  const manifestPath = join(canvasDir, AGENT_ATTACHMENTS_DIR, bundleId, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  return { ...manifest, manifestPath };
}

function isTextAsset(asset) {
  const mime = String(asset.mimeType || "").toLowerCase();
  const ext = extname(String(asset.name || asset.fileName || asset.path || "")).toLowerCase();
  return TEXT_EXTENSIONS.has(ext) || TEXT_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix));
}

export async function canvasAttachmentBundleToMcpResult(args = {}) {
  const bundle = await readCanvasAttachmentBundle(args);
  const maxInlineImageBytes = Number(args.maxInlineImageBytes) || IMAGE_INLINE_MAX_BYTES;
  const maxInlineTextBytes = Number(args.maxInlineTextBytes) || TEXT_INLINE_MAX_BYTES;
  const content = [
    {
      type: "text",
      text: [
        `BuzzAssist canvas attachment bundle: ${bundle.id}`,
        `Assets: ${bundle.assets.length}`,
        ...bundle.assets.map((asset, index) => `${index + 1}. ${asset.name} (${asset.kind}, ${asset.mimeType}, ${asset.size} bytes)\n   ${asset.path}`),
      ].join("\n"),
    },
  ];

  for (const asset of bundle.assets) {
    content.push({
      type: "resource_link",
      uri: asset.uri,
      name: asset.name,
      mimeType: asset.mimeType,
      description: `${asset.kind} from BuzzAssist canvas`,
    });
    if (asset.kind === "image" && asset.size <= maxInlineImageBytes) {
      const data = await readFile(asset.path, "base64");
      content.push({ type: "image", data, mimeType: asset.mimeType || "image/png" });
    } else if (isTextAsset(asset) && asset.size <= maxInlineTextBytes) {
      const text = await readFile(asset.path, "utf8");
      content.push({
        type: "resource",
        resource: {
          uri: asset.uri,
          mimeType: asset.mimeType || "text/plain",
          text,
        },
      });
    }
  }

  return {
    content,
    structuredContent: bundle,
  };
}
