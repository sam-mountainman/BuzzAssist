import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { basename, delimiter, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extForMimeType, mimeTypeForFile, nonEmptyString, sanitizeFileName } from "./canvasScene.mjs";

export const DEFAULT_IMAGE_MODEL = "gpt-image-2-codex";
export const DEFAULT_VIDEO_MODEL = "grok-imagine-video-hermes";

export const IMAGE_MODELS = [
  { id: "gpt-image-2-codex", label: "GPT-Image-2.0(Codex)" },
  { id: "grok-imagine-image-hermes", label: "Grok Imagine(Hermes)" },
];

export const VIDEO_MODELS = [
  { id: "grok-imagine-video-hermes", label: "Grok Imagine(Hermes)" },
];

function getEnv(name) {
  return nonEmptyString(process.env[name]);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function bundledCodexImageBridgeCommand() {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const bridgePath = join(moduleDir, "..", "scripts", "codex-image-bridge.mjs");
  return `${shellQuote(process.execPath)} ${shellQuote(bridgePath)}`;
}

function isBundledCodexImageBridgeEnabled() {
  const raw = String(process.env.EXCALIDRAW_DISABLE_CODEX_APP_SERVER_BRIDGE || "").trim().toLowerCase();
  return raw !== "1" && raw !== "true" && raw !== "yes";
}

function resolveCodexImageBridgeCommand() {
  return (
    getEnv("EXCALIDRAW_GPT_IMAGE_2_CODEX_COMMAND") ||
    getEnv("EXCALIDRAW_IMAGE_GENERATION_COMMAND") ||
    (isBundledCodexImageBridgeEnabled() ? bundledCodexImageBridgeCommand() : "")
  );
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeImageModel(rawModel) {
  const lower = String(rawModel || DEFAULT_IMAGE_MODEL).trim().toLowerCase();
  if (
    lower === "grok imagine image (hermes)" ||
    lower === "grok imagine image hermes" ||
    lower === "grok imagine(hermes)" ||
    lower === "grok imagine (hermes)" ||
    lower === "grok-imagine-hermes" ||
    lower === "grok-imagine-image-hermes"
  ) {
    return "grok-imagine-image-hermes";
  }
  return "gpt-image-2-codex";
}

function normalizeVideoModel(rawModel) {
  const lower = String(rawModel || DEFAULT_VIDEO_MODEL).trim().toLowerCase();
  if (
    lower === "grok imagine video (hermes)" ||
    lower === "grok imagine video hermes" ||
    lower === "grok imagine video(hermes)" ||
    lower === "grok imagine (hermes)" ||
    lower === "grok imagine hermes" ||
    lower === "grok imagine(hermes)" ||
    lower === "grok-imagine-video-hermes"
  ) {
    return "grok-imagine-video-hermes";
  }
  return DEFAULT_VIDEO_MODEL;
}

export function getGenerationCapabilities() {
  return {
    defaults: {
      imageModel: DEFAULT_IMAGE_MODEL,
      videoModel: DEFAULT_VIDEO_MODEL,
    },
    imageModels: IMAGE_MODELS,
    videoModels: VIDEO_MODELS,
    bridges: {
      gptImage2Codex: {
        configured: Boolean(resolveCodexImageBridgeCommand() || getEnv("EXCALIDRAW_GPT_IMAGE_2_CODEX_URL")),
        commandEnv: "EXCALIDRAW_GPT_IMAGE_2_CODEX_COMMAND",
        urlEnv: "EXCALIDRAW_GPT_IMAGE_2_CODEX_URL",
        autoBridge: isBundledCodexImageBridgeEnabled(),
      },
      hermes: {
        autoDetectsCommand: true,
        hermesPath: getEnv("HERMES_PATH"),
        hermesHome: getEnv("HERMES_HOME"),
      },
    },
  };
}

function imageSizeForAspectRatio(aspectRatio, fallback = "1536x1024") {
  const raw = String(aspectRatio || "").trim();
  if (raw === "1:1") return "1024x1024";
  if (raw === "9:16" || raw === "2:3") return "1024x1536";
  if (raw === "16:9" || raw === "3:2") return "1536x1024";
  return fallback;
}

function normalizeAspectRatio(value, fallback = "1:1") {
  const raw = String(value || "").trim().toLowerCase();
  if (["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"].includes(raw)) return raw;
  if (raw === "square") return "1:1";
  if (raw === "landscape" || raw === "wide") return "16:9";
  if (raw === "portrait" || raw === "vertical") return "9:16";
  return fallback;
}

function normalizeHermesImageResolution(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (["1k", "2k", "4k", "1024x1024", "1024x1536", "1536x1024"].includes(raw)) return raw;
  return "1k";
}

function normalizeHermesImageQuality(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "standard" || raw === "low" || raw === "medium") return "grok-imagine-image";
  return "grok-imagine-image-quality";
}

function normalizeVideoResolution(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "1080p" || raw === "720p") return raw;
  return "720p";
}

function sanitizeGrokVideoDuration(duration, useReference = false) {
  const parsed = Number.parseInt(String(duration || "5"), 10);
  const max = useReference ? 10 : 15;
  if (!Number.isFinite(parsed)) return 5;
  return Math.min(max, Math.max(1, parsed));
}

function runLocalProcess(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env || process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Command timed out: ${command} ${args.join(" ")}`));
    }, options.timeoutMs || 120_000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const detail = (stderr || stdout || "").trim();
        reject(new Error(detail || `Command failed with exit code ${code}: ${command} ${args.join(" ")}`));
      }
    });
    if (typeof options.stdin === "string") {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

async function runShellBridge(command, payload, timeoutMs = 30 * 60 * 1000) {
  const shell = process.env.SHELL || "/bin/sh";
  const result = await runLocalProcess(shell, ["-lc", command], {
    stdin: JSON.stringify(payload),
    timeoutMs,
  });
  return result.stdout;
}

async function postJsonBridge(url, payload, timeoutMs = 30 * 60 * 1000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type") || "";
    const body = contentType.includes("application/json") ? await response.json() : await response.text();
    if (!response.ok) {
      throw new Error(typeof body === "string" ? body : JSON.stringify(body));
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

function extractJsonObjectFromText(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function parseDataUrl(value) {
  const match = String(value || "").match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/s);
  if (!match) return null;
  return {
    mimeType: match[1] || "application/octet-stream",
    buffer: Buffer.from(match[2], "base64"),
  };
}

async function downloadMedia(url, fallbackMimeType) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download generated media: ${response.status} ${response.statusText}`);
  const mimeType = response.headers.get("content-type")?.split(";")[0] || fallbackMimeType || "application/octet-stream";
  return {
    mimeType,
    buffer: Buffer.from(await response.arrayBuffer()),
  };
}

async function mediaFromSource(source, fallback = {}) {
  const raw = nonEmptyString(source);
  if (!raw) throw new Error("Generated media response did not include a source.");

  const data = parseDataUrl(raw);
  if (data) {
    return {
      kind: fallback.kind || (data.mimeType.startsWith("video/") ? "video" : "image"),
      mimeType: data.mimeType,
      buffer: data.buffer,
      fileName: fallback.fileName || `generated-${Date.now()}${extForMimeType(data.mimeType)}`,
      source: "data-url",
    };
  }

  if (/^https?:\/\//i.test(raw)) {
    const media = await downloadMedia(raw, fallback.mimeType);
    return {
      kind: fallback.kind || (media.mimeType.startsWith("video/") ? "video" : "image"),
      mimeType: media.mimeType,
      buffer: media.buffer,
      fileName: fallback.fileName || sanitizeFileName(basename(new URL(raw).pathname) || `generated-${Date.now()}${extForMimeType(media.mimeType)}`),
      source: raw,
    };
  }

  const filePath = raw.startsWith("file://") ? new URL(raw) : raw;
  const buffer = await readFile(filePath);
  const mimeType = fallback.mimeType || mimeTypeForFile(String(filePath));
  return {
    kind: fallback.kind || (mimeType.startsWith("video/") ? "video" : "image"),
    mimeType,
    buffer,
    fileName: fallback.fileName || sanitizeFileName(basename(String(filePath)) || `generated-${Date.now()}${extForMimeType(mimeType)}`),
    source: String(filePath),
  };
}

async function mediaFromProviderOutput(output, fallback = {}) {
  const payload = typeof output === "string" ? extractJsonObjectFromText(output) : output;
  if (!payload || typeof payload !== "object") {
    const source = typeof output === "string" ? output.trim() : "";
    if (source) return mediaFromSource(source, fallback);
    throw new Error("Generation bridge returned no JSON payload.");
  }
  if (payload.success === false) {
    throw new Error(typeof payload.error === "string" ? payload.error : "Generation bridge failed.");
  }
  const mimeType = payload.mimeType || payload.mime_type || fallback.mimeType;
  const fileName = payload.fileName || payload.file_name || fallback.fileName;
  const base64 = payload.base64 || payload.b64_json;
  if (typeof base64 === "string" && base64.trim()) {
    const resolvedMime = mimeType || fallback.mimeType || "image/png";
    return {
      kind: fallback.kind || (String(resolvedMime).startsWith("video/") ? "video" : "image"),
      mimeType: resolvedMime,
      buffer: Buffer.from(base64, "base64"),
      fileName: fileName || `generated-${Date.now()}${extForMimeType(resolvedMime)}`,
      source: "base64",
    };
  }

  const source =
    payload.image ||
    payload.video ||
    payload.url ||
    payload.path ||
    payload.filePath ||
    payload.file_path ||
    payload.dataURL ||
    payload.data_url ||
    payload.video_url ||
    payload.image_url;

  return mediaFromSource(source, { ...fallback, mimeType, fileName });
}

function getHermesHomePath() {
  const configured = getEnv("HERMES_HOME");
  if (configured) return configured;
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, "hermes");
  }
  return join(os.homedir(), ".hermes");
}

function getHermesProjectPath() {
  return getEnv("HERMES_PROJECT_PATH") || join(getHermesHomePath(), "hermes-agent");
}

async function resolveHermesCommand() {
  const windowsHermesHome = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "hermes") : undefined;
  const candidates = [
    getEnv("HERMES_PATH"),
    "hermes",
    process.platform === "win32" ? "hermes.exe" : undefined,
    join(os.homedir(), ".local", "bin", "hermes"),
    join(os.homedir(), ".cargo", "bin", "hermes"),
    windowsHermesHome ? join(windowsHermesHome, "hermes-agent", "venv", "Scripts", "hermes.exe") : undefined,
  ].filter(Boolean);
  const failures = [];
  for (const candidate of candidates) {
    try {
      await runLocalProcess(candidate, ["--version"], { timeoutMs: 15_000 });
      return candidate;
    } catch (error) {
      failures.push(`${candidate}: ${getErrorMessage(error)}`);
    }
  }
  throw new Error(`Hermes Agent was not found. Checked:\n${failures.join("\n")}`);
}

function readYamlSectionValue(content, section, key) {
  const lines = String(content || "").split(/\r?\n/);
  let inSection = false;
  for (const line of lines) {
    if (!inSection) {
      if (line.trim() === `${section}:`) inSection = true;
      continue;
    }
    if (/^\S/.test(line)) break;
    const match = line.match(new RegExp(`^\\s+${key}:\\s*(.+?)\\s*$`));
    if (match) return match[1].replace(/^['"]|['"]$/g, "").trim();
  }
  return undefined;
}

async function readHermesConfig(command) {
  let configPath = join(getHermesHomePath(), "config.yaml");
  try {
    const result = await runLocalProcess(command, ["config", "path"], { timeoutMs: 15_000 });
    const printed = result.stdout.trim();
    if (printed) configPath = printed;
  } catch {
    // Use the default Hermes home config path.
  }
  try {
    return await readFile(configPath, "utf8");
  } catch {
    return "";
  }
}

async function resolveHermesPython() {
  const hermesProject = getHermesProjectPath();
  const candidates = [
    join(hermesProject, "venv", "bin", "python"),
    join(hermesProject, ".venv", "bin", "python"),
    join(hermesProject, "venv", "Scripts", "python.exe"),
    join(hermesProject, ".venv", "Scripts", "python.exe"),
    getEnv("PYTHON"),
    "python3",
    "python",
  ].filter(Boolean);
  const env = buildHermesPythonEnv();
  const failures = [];
  for (const candidate of candidates) {
    try {
      await runLocalProcess(candidate, ["-c", "import tools.xai_http; print('ok')"], { env, timeoutMs: 15_000 });
      return candidate;
    } catch (error) {
      failures.push(`${candidate}: ${getErrorMessage(error)}`);
    }
  }
  throw new Error(`Hermes Python runtime is not ready. Checked:\n${failures.join("\n")}`);
}

function buildHermesPythonEnv() {
  const hermesProject = getHermesProjectPath();
  return {
    ...process.env,
    HERMES_HOME: process.env.HERMES_HOME || getHermesHomePath(),
    PYTHONPATH: process.env.PYTHONPATH ? `${hermesProject}${delimiter}${process.env.PYTHONPATH}` : hermesProject,
  };
}

async function ensureHermesGrokOAuthReady(command) {
  const auth = await runLocalProcess(command, ["auth", "status", "xai-oauth"], { timeoutMs: 20_000 })
    .then((result) => result.stdout + result.stderr)
    .catch((error) => getErrorMessage(error));
  if (!/logged in/i.test(auth)) {
    throw new Error("Hermes is not logged in to xAI Grok OAuth. Run: hermes auth add xai-oauth --timeout 600");
  }
}

async function ensureHermesGrokImageReady(command) {
  await ensureHermesGrokOAuthReady(command);
  const config = await readHermesConfig(command);
  const provider = readYamlSectionValue(config, "image_gen", "provider");
  if (provider && provider !== "xai") {
    throw new Error(`Hermes image_gen.provider must be xai. Current value: ${provider}`);
  }
  if (!provider) {
    throw new Error("Hermes image_gen.provider is not set. Configure Hermes image generation provider to xAI Grok Imagine.");
  }
  return config;
}

function extractMediaSourceFromHermesText(text, kind) {
  const payload = extractJsonObjectFromText(text);
  if (payload && payload.success === false) {
    throw new Error(typeof payload.error === "string" ? payload.error : `Hermes ${kind} generation failed.`);
  }
  const direct = kind === "video"
    ? payload?.video || payload?.url || payload?.path || payload?.video_url
    : payload?.image || payload?.url || payload?.path || payload?.image_url;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const extensionPattern = kind === "video" ? "\\.(?:mp4|mov|webm|m4v)" : "\\.(?:png|jpe?g|webp|gif)";
  const url = String(text || "").match(new RegExp(`https?://[^\\s"'<>)]*${extensionPattern}[^\\s"'<>)]*`, "i"));
  if (url?.[0]) return url[0].trim();
  const localPath = String(text || "").match(new RegExp(`(?:/|file://)[^\\s"'<>)]*${extensionPattern}`, "i"));
  return localPath?.[0]?.trim() || "";
}

async function referenceImagePathsToDataUrls(paths = []) {
  const result = [];
  for (const value of paths) {
    const filePath = nonEmptyString(value);
    if (!filePath) continue;
    const mimeType = mimeTypeForFile(filePath);
    if (!mimeType.startsWith("image/")) throw new Error(`Reference is not an image: ${filePath}`);
    const buffer = await readFile(filePath);
    result.push(`data:${mimeType};base64,${buffer.toString("base64")}`);
  }
  return result;
}

function normalizeReferenceImages(values = []) {
  return values
    .map((value) => {
      if (typeof value === "string") return value.trim();
      if (value && typeof value === "object" && typeof value.dataURL === "string") return value.dataURL.trim();
      if (value && typeof value === "object" && typeof value.url === "string") return value.url.trim();
      return "";
    })
    .filter(Boolean);
}

async function generateHermesGrokImage(input) {
  const commandOverride = getEnv("EXCALIDRAW_GROK_IMAGE_HERMES_COMMAND") || getEnv("EXCALIDRAW_HERMES_IMAGE_COMMAND");
  const payload = buildImagePayload(input, "grok-imagine-image-hermes");
  if (commandOverride) {
    return mediaFromProviderOutput(await runShellBridge(commandOverride, payload, 240_000), {
      kind: "image",
      mimeType: "image/png",
      fileName: payload.fileName,
    });
  }

  const hermes = await resolveHermesCommand();
  const hermesConfig = await ensureHermesGrokImageReady(hermes);
  const python = await resolveHermesPython();
  const referenceImages = [
    ...normalizeReferenceImages(input.referenceImages),
    ...(await referenceImagePathsToDataUrls(input.referenceImagePaths)),
  ].filter(Boolean);
  if (referenceImages.length > 3) {
    throw new Error("Grok Imagine(Hermes) supports up to 3 image references for image edits.");
  }
  const configuredModel = readYamlSectionValue(hermesConfig, "image_gen", "model");
  const model = configuredModel === "grok-imagine-image" || configuredModel === "grok-imagine-image-quality"
    ? configuredModel
    : normalizeHermesImageQuality(input.quality);
  const aspectRatio = normalizeAspectRatio(input.aspectRatio, "1:1");
  const resolution = normalizeHermesImageResolution(input.resolution || input.imageSize);
  const script = `
import json
import sys

import requests

from tools.xai_http import hermes_xai_user_agent, resolve_xai_http_credentials

request = json.loads(sys.stdin.read() or "{}")
creds = resolve_xai_http_credentials() or {}
api_key = str(creds.get("api_key") or "").strip()
base_url = str(creds.get("base_url") or "https://api.x.ai/v1").strip().rstrip("/")
provider = str(creds.get("provider") or "xai").strip()
if not api_key:
    print(json.dumps({
        "success": False,
        "error": "No xAI credentials found. Run hermes auth add xai-oauth and sign in with X / SuperGrok.",
        "provider": provider,
    }))
    sys.exit(0)

image_urls = [
    str(value).strip()
    for value in (request.get("image_urls") or [])
    if str(value).strip()
]
body = {
    "model": request.get("model") or "grok-imagine-image-quality",
    "prompt": request.get("prompt") or "",
    "resolution": request.get("resolution") or "1k",
}
endpoint = "/images/generations"
if image_urls:
    endpoint = "/images/edits"
    if len(image_urls) == 1:
        body["image"] = {"url": image_urls[0], "type": "image_url"}
    else:
        body["images"] = [{"url": image_url, "type": "image_url"} for image_url in image_urls]
        body["aspect_ratio"] = request.get("aspect_ratio") or "1:1"
else:
    body["aspect_ratio"] = request.get("aspect_ratio") or "1:1"
    body["response_format"] = "b64_json"
    body["n"] = 1

try:
    response = requests.post(
        base_url + endpoint,
        headers={
            "Authorization": "Bearer " + api_key,
            "Content-Type": "application/json",
            "User-Agent": hermes_xai_user_agent(),
        },
        json=body,
        timeout=180,
    )
    response.raise_for_status()
    payload = response.json()
except requests.HTTPError as exc:
    response = exc.response
    status = response.status_code if response is not None else 0
    try:
        err_payload = response.json()
        err = err_payload.get("error", {})
        message = err.get("message") if isinstance(err, dict) else str(err)
    except Exception:
        message = response.text[:500] if response is not None else str(exc)
    print(json.dumps({"success": False, "error": f"xAI image generation failed ({status}): {message}"}))
    sys.exit(0)
except Exception as exc:
    print(json.dumps({"success": False, "error": f"xAI image generation failed: {exc}"}))
    sys.exit(0)

data = payload.get("data") or []
first = data[0] if data else {}
if isinstance(first, dict) and first.get("b64_json"):
    print(json.dumps({"success": True, "image": "data:image/png;base64," + first["b64_json"]}))
elif isinstance(first, dict) and first.get("url"):
    print(json.dumps({"success": True, "image": first["url"]}))
else:
    print(json.dumps({"success": False, "error": "xAI image generation returned no image."}))
`;
  const result = await runLocalProcess(python, ["-c", script], {
    env: buildHermesPythonEnv(),
    stdin: JSON.stringify({
      prompt: input.prompt,
      model,
      image_urls: referenceImages,
      aspect_ratio: aspectRatio,
      resolution,
    }),
    timeoutMs: 240_000,
  });
  const source = extractMediaSourceFromHermesText(result.stdout, "image");
  return mediaFromSource(source, {
    kind: "image",
    mimeType: "image/png",
    fileName: input.fileName || `grok-image-${Date.now()}.png`,
  });
}

async function generateHermesGrokVideo(input) {
  const commandOverride = getEnv("EXCALIDRAW_GROK_VIDEO_HERMES_COMMAND") || getEnv("EXCALIDRAW_HERMES_VIDEO_COMMAND");
  const payload = await buildVideoPayload(input, "grok-imagine-video-hermes");
  if (commandOverride) {
    return mediaFromProviderOutput(await runShellBridge(commandOverride, payload, 31 * 60 * 1000), {
      kind: "video",
      mimeType: "video/mp4",
      fileName: payload.fileName,
    });
  }

  const hermes = await resolveHermesCommand();
  await ensureHermesGrokOAuthReady(hermes);
  const python = await resolveHermesPython();
  const script = `
import json
import sys
import time

import requests

from tools.xai_http import hermes_xai_user_agent, resolve_xai_http_credentials

request = json.loads(sys.stdin.read() or "{}")
creds = resolve_xai_http_credentials() or {}
api_key = str(creds.get("api_key") or "").strip()
base_url = str(creds.get("base_url") or "https://api.x.ai/v1").strip().rstrip("/")
provider = str(creds.get("provider") or "xai").strip()
if not api_key:
    print(json.dumps({
        "success": False,
        "error": "No xAI credentials found. Run hermes auth add xai-oauth and sign in with X / SuperGrok.",
        "provider": provider,
    }))
    sys.exit(0)

headers = {
    "Authorization": "Bearer " + api_key,
    "Content-Type": "application/json",
    "User-Agent": hermes_xai_user_agent(),
}
body = {
    "model": "grok-imagine-video",
    "prompt": request.get("prompt") or "",
    "duration": request.get("duration") or 5,
    "resolution": request.get("resolution") or "720p",
}
aspect_ratio = str(request.get("aspect_ratio") or "").strip()
if aspect_ratio:
    body["aspect_ratio"] = aspect_ratio
image_url = str(request.get("image_url") or "").strip()
reference_images = [
    str(value).strip()
    for value in (request.get("reference_image_urls") or [])
    if str(value).strip()
]
if image_url and reference_images:
    print(json.dumps({"success": False, "error": "Grok Imagine Video cannot combine image-to-video and reference-to-video in one request."}))
    sys.exit(0)
if image_url:
    body["image"] = {"url": image_url}
    body.pop("aspect_ratio", None)
if reference_images:
    body["reference_images"] = [{"url": value} for value in reference_images]

try:
    response = requests.post(base_url + "/videos/generations", headers=headers, json=body, timeout=180)
    response.raise_for_status()
    payload = response.json()
except requests.HTTPError as exc:
    response = exc.response
    status = response.status_code if response is not None else 0
    try:
        err_payload = response.json()
        err = err_payload.get("error", {})
        message = err.get("message") if isinstance(err, dict) else str(err)
    except Exception:
        message = response.text[:500] if response is not None else str(exc)
    print(json.dumps({"success": False, "error": f"xAI video generation failed ({status}): {message}"}))
    sys.exit(0)
except Exception as exc:
    print(json.dumps({"success": False, "error": f"xAI video generation failed: {exc}"}))
    sys.exit(0)

request_id = str(payload.get("request_id") or "").strip()
if not request_id:
    print(json.dumps({"success": False, "error": "xAI video generation returned no request_id."}))
    sys.exit(0)

deadline = time.time() + 30 * 60
while time.time() < deadline:
    time.sleep(5)
    try:
        result = requests.get(base_url + "/videos/" + request_id, headers={"Authorization": "Bearer " + api_key, "User-Agent": hermes_xai_user_agent()}, timeout=60)
        result.raise_for_status()
        data = result.json()
    except requests.HTTPError as exc:
        response = exc.response
        status = response.status_code if response is not None else 0
        try:
            err_payload = response.json()
            err = err_payload.get("error", {})
            message = err.get("message") if isinstance(err, dict) else str(err)
        except Exception:
            message = response.text[:500] if response is not None else str(exc)
        print(json.dumps({"success": False, "error": f"xAI video polling failed ({status}): {message}"}))
        sys.exit(0)
    except Exception as exc:
        print(json.dumps({"success": False, "error": f"xAI video polling failed: {exc}"}))
        sys.exit(0)
    status = str(data.get("status") or "").lower()
    if status == "done":
        video = data.get("video") or {}
        url = video.get("url") if isinstance(video, dict) else ""
        if url:
            print(json.dumps({"success": True, "video": url, "duration": video.get("duration"), "request_id": request_id}))
            sys.exit(0)
        print(json.dumps({"success": False, "error": "xAI video generation completed without a video URL."}))
        sys.exit(0)
    if status in ("failed", "expired"):
        print(json.dumps({"success": False, "error": f"xAI video generation {status}.", "request_id": request_id, "response": data}))
        sys.exit(0)

print(json.dumps({"success": False, "error": "xAI video generation timed out after 30 minutes.", "request_id": request_id}))
`;
  const result = await runLocalProcess(python, ["-c", script], {
    env: buildHermesPythonEnv(),
    stdin: JSON.stringify(payload),
    timeoutMs: 31 * 60 * 1000,
  });
  const source = extractMediaSourceFromHermesText(result.stdout, "video");
  return mediaFromSource(source, {
    kind: "video",
    mimeType: "video/mp4",
    fileName: input.fileName || `grok-video-${Date.now()}.mp4`,
  });
}

function buildImagePayload(input, model) {
  const prompt = nonEmptyString(input.prompt);
  if (!prompt) throw new Error("prompt is required.");
  const aspectRatio = normalizeAspectRatio(input.aspectRatio, "1:1");
  const imageSize = nonEmptyString(input.imageSize) || imageSizeForAspectRatio(aspectRatio, "1024x1024");
  return {
    prompt,
    model,
    imageSize,
    size: imageSize,
    aspect_ratio: aspectRatio,
    aspectRatio,
    resolution: input.resolution || normalizeHermesImageResolution(imageSize),
    quality: input.quality || "high",
    fileName: input.fileName || input.imageName || `generated-${Date.now()}.png`,
    referenceImages: Array.isArray(input.referenceImages) ? input.referenceImages : [],
    referenceImagePaths: Array.isArray(input.referenceImagePaths) ? input.referenceImagePaths : [],
  };
}

async function buildVideoPayload(input, model) {
  const prompt = nonEmptyString(input.prompt);
  if (!prompt) throw new Error("prompt is required.");
  const aspectRatio = normalizeAspectRatio(input.aspectRatio, "16:9");
  const duration = sanitizeGrokVideoDuration(input.duration, Boolean(input.useReference));
  const referenceImageUrls = [
    ...normalizeReferenceImages(input.referenceImages),
    ...(await referenceImagePathsToDataUrls(input.referenceImagePaths)),
  ].filter(Boolean);
  let imageUrl = nonEmptyString(input.startFrameDataURL) || nonEmptyString(input.imageUrl);
  if (!imageUrl && nonEmptyString(input.startFramePath)) {
    const mimeType = mimeTypeForFile(input.startFramePath);
    if (!mimeType.startsWith("image/")) throw new Error("startFramePath must point to an image.");
    const buffer = await readFile(input.startFramePath);
    imageUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;
  }
  return {
    prompt,
    model,
    aspect_ratio: aspectRatio,
    aspectRatio,
    duration,
    resolution: normalizeVideoResolution(input.resolution),
    image_url: imageUrl,
    reference_image_urls: referenceImageUrls,
    fileName: input.fileName || input.videoName || `generated-video-${Date.now()}.mp4`,
  };
}

async function generateImageWithCodexBridge(input) {
  const model = "gpt-image-2-codex";
  const payload = buildImagePayload(input, model);
  const command = resolveCodexImageBridgeCommand();
  if (command) {
    return mediaFromProviderOutput(await runShellBridge(command, payload, 30 * 60 * 1000), {
      kind: "image",
      mimeType: "image/png",
      fileName: payload.fileName,
    });
  }
  const url = getEnv("EXCALIDRAW_GPT_IMAGE_2_CODEX_URL") || getEnv("EXCALIDRAW_IMAGE_GENERATION_URL");
  if (url) {
    return mediaFromProviderOutput(await postJsonBridge(url, payload, 30 * 60 * 1000), {
      kind: "image",
      mimeType: "image/png",
      fileName: payload.fileName,
    });
  }
  throw new Error(
    "GPT-Image-2.0(Codex) bridge is not configured. Set EXCALIDRAW_GPT_IMAGE_2_CODEX_COMMAND or EXCALIDRAW_GPT_IMAGE_2_CODEX_URL, or enable the bundled Codex app-server bridge.",
  );
}

export async function generateImageMedia(input = {}) {
  const model = normalizeImageModel(input.model);
  const media = model === "grok-imagine-image-hermes"
    ? await generateHermesGrokImage({ ...input, model })
    : await generateImageWithCodexBridge({ ...input, model });
  return {
    ...media,
    kind: "image",
    model,
    fileName: sanitizeFileName(media.fileName || input.fileName || `generated-${Date.now()}${extForMimeType(media.mimeType, ".png")}`),
  };
}

export async function generateVideoMedia(input = {}) {
  const model = normalizeVideoModel(input.model);
  const media = await generateHermesGrokVideo({ ...input, model });
  return {
    ...media,
    kind: "video",
    model,
    fileName: sanitizeFileName(media.fileName || input.fileName || `generated-video-${Date.now()}${extForMimeType(media.mimeType, ".mp4")}`),
  };
}
