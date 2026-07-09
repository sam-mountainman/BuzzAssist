#!/usr/bin/env node
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { generateKeyBetween } from "fractional-indexing";
import { z } from "zod";
import {
  DEFAULT_MEDIA_BATCH_CHUNK_SIZE,
  IMAGE_MODELS,
  VIDEO_MODELS,
  chunkMediaBatchJobs,
  generateImageMedia,
  generateVideoMedia,
  getHermesStatus,
  normalizeMediaBatchColumns,
  normalizeMediaBatchConcurrency,
  runWithConcurrency,
  setupHermesGrok,
} from "../lib/mediaGeneration.mjs";
import { getBuzzAssistAuthStatus, loginBuzzAssistViaBrowser } from "../lib/buzzassistApi.mjs";
import {
  OFFICIAL_EXCALIDRAW_README,
  createExcalidrawView,
  insertExcalidrawImage as insertExcalidrawImageMedia,
  insertExcalidrawSubtitle,
  insertExcalidrawVideo as insertExcalidrawVideoMedia,
  clearFrameGeneratingFlags,
  insertGeneratorFrameBatch,
  performCanvasMaintenance,
} from "../lib/canvasScene.mjs";
import { silenceCutVideo } from "../lib/tempoCut.mjs";
import { estimateCreditsForJob } from "../lib/mediaCredits.mjs";
import { isFalImageModel, isFalVideoModel, previewFalImageRequest, previewFalVideoRequest } from "../lib/falMediaGeneration.mjs";
import { generateSubtitleSrt, normalizeSubtitleHoldSeconds, renderSrt } from "../lib/subtitleGeneration.mjs";
import { startChatBridgeWorker } from "../lib/chatBridge.mjs";
import { readServerDiscovery } from "../lib/canvasServerRuntime.mjs";
import {
  canvasAttachmentBundleToMcpResult,
  createCanvasAttachmentBundle,
  listCanvasAttachmentBundles,
} from "../lib/canvasAttachmentBundle.mjs";
import {
  BUZZASSIST_WIDGET_MIME_TYPE,
  BUZZASSIST_WIDGET_URI,
  buzzAssistWidgetResourceMetadata,
  createBuzzAssistWidgetHtml,
} from "../lib/buzzassistWidgetResource.mjs";
import { tmpdir } from "node:os";

const SERVER_NAME = "BuzzAssist Excalidraw Plugin Tools";
const SERVER_VERSION = "0.1.5";
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
const TOOL_SETUP_HERMES = "setup_hermes_grok";
const TOOL_GENERATE_SUBTITLES = "generate_excalidraw_subtitles";
const TOOL_GENERATE_SUBTITLES_BATCH = "generate_excalidraw_subtitles_batch";
const TOOL_SILENCE_CUT_VIDEO = "silence_cut_excalidraw_video";
const TOOL_CANVAS_TUNNEL_START = "buzzassist_canvas_tunnel_start";
const TOOL_CANVAS_TUNNEL_STATUS = "buzzassist_canvas_tunnel_status";
const TOOL_CANVAS_TUNNEL_STOP = "buzzassist_canvas_tunnel_stop";
const TOOL_RENDER_BUZZASSIST_WIDGET = "render_buzzassist_canvas_widget";
const TOOL_PREPARE_CANVAS_ATTACHMENTS = "prepare_canvas_attachments";
const TOOL_READ_CANVAS_ATTACHMENT_BUNDLE = "read_canvas_attachment_bundle";
const TOOL_LIST_CANVAS_ATTACHMENT_BUNDLES = "list_canvas_attachment_bundles";
const IMAGE_MODEL_IDS = IMAGE_MODELS.map((model) => model.id);
const VIDEO_MODEL_IDS = VIDEO_MODELS.map((model) => model.id);
const CANVAS_FILE_NAME = "excalidraw-canvas.json";
const SELECTION_FILE_NAME = "excalidraw-selection.json";
const ASSETS_ROUTE = "/excalidraw-assets/";
const AI_HOLDER_KEY = "codexAiImageHolder";
const MEDIA_GENERATION_AGENT_INSTRUCTIONS = [
  "Project-local Excalidraw canvas tools. Use read_me/create_view for diagrams, get_excalidraw_selection before acting on selected items, and insert_* for local assets.",
  "Generation/subtitle/silence-cut tools require confirmedSettings=true unless the user's request already specified all relevant settings; use payloadPreview or read_me for workflow details.",
  "Canvas tools auto-start the local static canvas server and write canvas/.server.json with the dynamic URL and HTTP tool endpoint bearer token.",
  "For phone/mobile access to the exact same full Excalidraw UI, use buzzassist_canvas_tunnel_start/status/stop. This starts an ngrok Canvas Tunnel with a generated access URL; Remote Canvas is not required for same-UI access.",
  "For Codex and Claude Code interactive UI, open the local BUZZASSIST_CANVAS_URL in the host in-app browser/browser tool and use MCP tools for stable reads/writes. render_buzzassist_canvas_widget remains an experimental MCP Apps entrypoint only; do not use it for normal Codex or Claude Code work unless the user explicitly asks to test the widget.",
  "To attach selected canvas images/videos/SRT/XML into the current chat, use prepare_canvas_attachments or read_canvas_attachment_bundle. Do not rely on OS GUI paste automation for media attachments.",
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
let lastCanvasBaseUrl = null;

async function fetchJsonQuick(url, timeoutMs = 1500, token = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    const response = await fetch(url, { signal: controller.signal, headers });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function resolveProjectDir(args = {}) {
  const explicitProjectDir = nonEmptyString(args.projectDir);
  if (explicitProjectDir) return pathResolve(explicitProjectDir);

  const envProjectDir = nonEmptyString(process.env.EXCALIDRAW_PROJECT_DIR);
  if (envProjectDir) return pathResolve(envProjectDir);

  const canvasDir = resolveCanvasDir(args);
  return basename(canvasDir) === "canvas" ? dirname(canvasDir) : process.cwd();
}

async function readCanvasServerInfo(args = {}) {
  const discovered = await readServerDiscovery(resolveCanvasDir(args));
  if (discovered?.url) return discovered;
  const port = Number(process.env.EXCALIDRAW_PORT ?? 43219);
  const url = nonEmptyString(process.env.EXCALIDRAW_CANVAS_URL) || `http://127.0.0.1:${port}/`;
  return { url, mcpUrl: `${url.replace(/\/$/, "")}/mcp`, port, token: process.env.EXCALIDRAW_MCP_TOKEN || null };
}

async function fetchCanvasClientStatus(info) {
  const baseUrl = String(info.url || "").replace(/\/$/, "");
  if (!baseUrl) return null;
  return fetchJsonQuick(`${baseUrl}/api/canvas-clients`, 1500, info.token);
}

async function ensureCanvasServer(args = {}) {
  let info = await readCanvasServerInfo(args);
  let status = await fetchCanvasClientStatus(info);
  if (status) return { info, status };

  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const child = spawn(process.execPath, ["scripts/serve-canvas.mjs", resolveProjectDir(args)], {
    cwd: repoRoot,
    env: {
      ...process.env,
      EXCALIDRAW_ALLOW_WIDGET_ORIGINS: "1",
      EXCALIDRAW_CANVAS_DIR: resolveCanvasDir(args),
      EXCALIDRAW_PROJECT_DIR: resolveProjectDir(args),
    },
    detached: true,
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  child.unref();

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !status) {
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 1000));
    info = await readCanvasServerInfo(args);
    status = await fetchCanvasClientStatus(info);
  }

  return { info, status };
}

function runQuick(command, commandArgs, timeoutMs = 8000) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, commandArgs, { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      rejectRun(new Error("timeout"));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveRun();
      else rejectRun(new Error(`exit ${code}`));
    });
  });
}

function runCaptured(command, commandArgs, timeoutMs = 8000) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, commandArgs, { shell: process.platform === "win32" });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      rejectRun(new Error(`${[command, ...commandArgs].join(" ")} timed out`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolveRun({ stdout, stderr, code });
        return;
      }
      const message = [stderr.trim(), stdout.trim(), `exit ${code}`].filter(Boolean).join("\n");
      rejectRun(new Error(message));
    });
  });
}

async function runCanvasTunnelCommand(action, args = {}) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const projectDir = resolveProjectDir(args);
  const canvasDir = resolveCanvasDir(args);
  const commandArgs = [
    join(repoRoot, "scripts", "canvas-tunnel.mjs"),
    action,
    "--project-dir",
    projectDir,
    "--canvas-dir",
    canvasDir,
  ];

  if (action === "start") {
    if (args.restart === true) commandArgs.push("--restart");
    if (args.reuseLocal === true) commandArgs.push("--reuse-local");
    if (nonEmptyString(args.localUrl)) commandArgs.push("--local-url", nonEmptyString(args.localUrl));
    if (nonEmptyString(args.ngrokAuthtoken)) commandArgs.push("--ngrok-authtoken", nonEmptyString(args.ngrokAuthtoken));
    if (nonEmptyString(args.accessToken)) commandArgs.push("--access-token", nonEmptyString(args.accessToken));
    if (args.basicAuth === true) commandArgs.push("--basic-auth");
    if (nonEmptyString(args.user)) commandArgs.push("--user", nonEmptyString(args.user));
    if (nonEmptyString(args.password)) commandArgs.push("--password", nonEmptyString(args.password));
    if (args.compression === false) commandArgs.push("--no-compression");
  }

  const timeoutMs = action === "start" ? 75_000 : 15_000;
  const result = await runCaptured(process.execPath, commandArgs, timeoutMs);
  const statusFile = join(canvasDir, ".canvas-tunnel.json");
  const status = await readJsonIfExists(statusFile, null);
  return {
    ok: action === "status" ? Boolean(status?.ok) : true,
    action,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    statusFile,
    status,
  };
}

async function getMacScreenBounds() {
  try {
    const script = 'tell application "Finder" to get bounds of window of desktop';
    const result = await new Promise((resolveRun, rejectRun) => {
      const child = spawn("osascript", ["-e", script]);
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.on("error", rejectRun);
      child.on("close", () => resolveRun(stdout));
    });
    const parts = String(result).trim().split(",").map((value) => Number.parseInt(value.trim(), 10));
    if (parts.length === 4 && parts.every(Number.isFinite)) {
      return { width: parts[2], height: parts[3] };
    }
  } catch {
    // fall through to the default bounds
  }
  return { width: 1440, height: 900 };
}

// "In-app browser" feel: hosts (Claude Code / Codex) expose no API to dock a
// panel inside their window, so the closest match is a chromeless app-mode
// window pinned to the right half of the screen. Falls back to the default
// browser when no Chromium-family browser is installed.
// EXCALIDRAW_OPEN_MODE=browser forces a plain tab; =none disables opening.
async function openCanvasWindow(baseUrl) {
  const mode = String(process.env.EXCALIDRAW_OPEN_MODE || "app").toLowerCase();
  if (mode === "none") return;
  // Under Codex/Claude Code the host has an in-app browser — the agent opens
  // the canvas there (see MCP instructions), so never spawn an external window.
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT || process.env.CODEX || process.env.CODEX_HOME) return;
  if (mode !== "browser" && process.platform === "darwin") {
    const bounds = await getMacScreenBounds();
    const width = Math.round(bounds.width / 2);
    const height = bounds.height;
    const x = bounds.width - width;
    for (const app of ["Google Chrome", "Microsoft Edge", "Brave Browser", "Chromium"]) {
      try {
        await runQuick("open", ["-na", app, "--args", `--app=${baseUrl}`, `--window-size=${width},${height}`, `--window-position=${x},0`]);
        return;
      } catch {
        // try the next browser
      }
    }
  }
  if (mode !== "browser" && process.platform === "win32") {
    for (const exe of ["chrome", "msedge"]) {
      try {
        await runQuick("cmd", ["/c", "start", "", exe, `--app=${baseUrl}`]);
        return;
      } catch {
        // try the next browser
      }
    }
  }
  if (mode !== "browser" && process.platform === "linux") {
    for (const exe of ["google-chrome", "chromium", "chromium-browser"]) {
      try {
        await runQuick(exe, [`--app=${baseUrl}`]);
        return;
      } catch {
        // try the next browser
      }
    }
  }
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const openerArgs = process.platform === "win32" ? ["/c", "start", "", baseUrl] : [baseUrl];
  spawn(opener, openerArgs, { detached: true, stdio: "ignore" }).unref();
}

async function ensureCanvasVisible(args = {}) {
  if (canvasAutoOpenAttempted) return;
  canvasAutoOpenAttempted = true;
  if (/^(1|true|yes)$/i.test(String(process.env.EXCALIDRAW_NO_AUTO_OPEN || ""))) return;
  try {
    const { info, status } = await ensureCanvasServer(args);
    const baseUrl = String(info.url || "").replace(/\/$/, "");
    if (baseUrl) lastCanvasBaseUrl = baseUrl;
    if (status && Number(status.clients) === 0) {
      await openCanvasWindow(baseUrl);
    }
  } catch {
    // best-effort — never block the tool call
  }
}

function canvasHintText() {
  const port = Number(process.env.EXCALIDRAW_PORT ?? 43219);
  const baseUrl = lastCanvasBaseUrl || nonEmptyString(process.env.EXCALIDRAW_CANVAS_URL) || `http://127.0.0.1:${port}`;
  return ` Canvas: ${baseUrl}`;
}

async function widgetStructuredContent(args = {}) {
  const { info, status } = await ensureCanvasServer(args);
  const canvasUrl = String(info?.url || "").replace(/\/$/, "");
  const tunnel = await readJsonIfExists(join(resolveCanvasDir(args), ".canvas-tunnel.json"), null);
  if (canvasUrl) lastCanvasBaseUrl = canvasUrl;
  return {
    version: 1,
    widget: "buzzassist-canvas-widget",
    rendering: "native-widget",
    title: nonEmptyString(args.title) || "BuzzAssist Canvas",
    preferredDisplayMode: nonEmptyString(args.displayMode) || "fullscreen",
    projectDir: resolveProjectDir(args),
    canvasDir: resolveCanvasDir(args),
    canvasUrl,
    localCanvasUrl: canvasUrl,
    canvasStatus: status || null,
    mcpUrl: info?.mcpUrl || null,
    tunnel: tunnel || null,
  };
}

function widgetToolResultMetadata(widgetData) {
  return {
    "openai/outputTemplate": BUZZASSIST_WIDGET_URI,
    widgetData,
  };
}

function readWidgetResource(uri) {
  if (uri !== BUZZASSIST_WIDGET_URI) {
    throw new Error(`Unknown resource: ${uri}`);
  }
  const metadata = buzzAssistWidgetResourceMetadata();
  return {
    contents: [
      {
        uri: BUZZASSIST_WIDGET_URI,
        mimeType: BUZZASSIST_WIDGET_MIME_TYPE,
        text: createBuzzAssistWidgetHtml({ version: SERVER_VERSION }),
        _meta: metadata._meta,
      },
    ],
  };
}

function describeZodType(schema, type) {
  return nonEmptyString(schema?.description) ? type.describe(schema.description) : type;
}

function zodTypeFromJsonSchema(schema = {}) {
  if (!schema || typeof schema !== "object") return z.any();
  if (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every((value) => typeof value === "string")) {
    return describeZodType(schema, z.enum(schema.enum));
  }
  if (Array.isArray(schema.type)) {
    const options = schema.type.map((type) => zodTypeFromJsonSchema({ ...schema, type })).filter(Boolean);
    return describeZodType(schema, options.length > 1 ? z.union(options) : options[0] || z.any());
  }
  switch (schema.type) {
    case "string":
      return describeZodType(schema, z.string());
    case "integer":
      return describeZodType(schema, z.number().int());
    case "number":
      return describeZodType(schema, z.number());
    case "boolean":
      return describeZodType(schema, z.boolean());
    case "array":
      return describeZodType(schema, z.array(zodTypeFromJsonSchema(schema.items || {})));
    case "object": {
      const shape = jsonSchemaToZodShape(schema);
      const objectSchema = z.object(shape);
      return describeZodType(schema, schema.additionalProperties === false ? objectSchema.strict() : objectSchema.passthrough());
    }
    default:
      return describeZodType(schema, z.any());
  }
}

function jsonSchemaToZodShape(schema = {}) {
  const properties = schema && typeof schema === "object" ? schema.properties || {} : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const shape = {};
  for (const [key, value] of Object.entries(properties)) {
    const type = zodTypeFromJsonSchema(value);
    shape[key] = required.has(key) ? type : type.optional();
  }
  return shape;
}

function toolConfigForMcpServer(definition) {
  return {
    title: definition.title,
    description: definition.description,
    inputSchema: zodTypeFromJsonSchema(definition.inputSchema || { type: "object", properties: {} }),
    annotations: definition.annotations,
    _meta: definition._meta,
  };
}

function toolErrorResult(error) {
  return {
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}

function registerBuzzAssistWidget(server) {
  const metadata = buzzAssistWidgetResourceMetadata();
  registerAppResource(
    server,
    "buzzassist-canvas-widget",
    BUZZASSIST_WIDGET_URI,
    {
      title: metadata.title,
      description: metadata.description,
      _meta: metadata._meta,
    },
    async () => readWidgetResource(BUZZASSIST_WIDGET_URI),
  );

  const widgetDefinition = toolDefinitions().find((tool) => tool.name === TOOL_RENDER_BUZZASSIST_WIDGET);
  if (!widgetDefinition) throw new Error(`${TOOL_RENDER_BUZZASSIST_WIDGET} definition is missing`);
  registerAppTool(
    server,
    TOOL_RENDER_BUZZASSIST_WIDGET,
    toolConfigForMcpServer(widgetDefinition),
    async (input = {}) => {
      try {
        const widgetData = await widgetStructuredContent(input);
        return {
          content: [
            {
              type: "text",
              text: `Rendered BuzzAssist canvas widget. Local canvas: ${widgetData.canvasUrl || "unavailable"}`,
            },
          ],
          structuredContent: widgetData,
          _meta: widgetToolResultMetadata(widgetData),
        };
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );
}

// AskUserQuestion enforcement: generation tools refuse to run until the agent
// attests (confirmedSettings: true) that the settings were confirmed with the
// user — mirroring how the BuzzAssist app always asks before generating.
const SETTINGS_CONFIRMATION_TOOLS = new Map([
  [TOOL_GENERATE_IMAGE, "image"],
  [TOOL_GENERATE_IMAGES_BATCH, "image"],
  [TOOL_GENERATE_VIDEO, "video"],
  [TOOL_GENERATE_VIDEOS_BATCH, "video"],
  [TOOL_GENERATE_SUBTITLES, "subtitle"],
  [TOOL_GENERATE_SUBTITLES_BATCH, "subtitle"],
  [TOOL_SILENCE_CUT_VIDEO, "silenceCut"],
]);

const SETTINGS_QUESTION_GUIDES = {
  image:
    "model (GPT-Image-2.0 / Grok Imagine / NanoBanana 2 / Seedream v5 Lite / Midjourney …), 実行先 (execution route) whenever the chosen model can run on more than one of Codex(local) / Hermes(local) / BuzzAssist API / Lovart (e.g. GPT Image 2 → Codex or BuzzAssist or Lovart; Grok Imagine → Hermes or BuzzAssist), aspect ratio (1:1 / 16:9 / 9:16 …), and quality (Auto / Low / Medium / High). Recommended defaults: GPT-Image-2.0 (Codex), 1:1, Auto.",
  video:
    "model (Grok Imagine / Seedance 2 / Kling v3 / Veo 3.1 …), 実行先 (execution route) whenever the chosen model can run on more than one of Hermes(local) / BuzzAssist API / Lovart (e.g. Grok Imagine → Hermes or BuzzAssist; Kling → BuzzAssist or Lovart), aspect ratio (16:9 / 9:16 / 1:1), duration (e.g. 5s / 10s), and resolution (480p / 720p). Recommended defaults: Grok Imagine (Hermes), 16:9, 5s, 720p.",
  subtitle:
    "mode (scripted aligns a provided script / scriptless transcribes), lineCount (1 or 2), and maxCharsPerLine. Recommended defaults: scripted when a script exists (otherwise scriptless), 2 lines, 30 chars.",
  silenceCut:
    "input type (Premiere XML preferred, or video), model (elevenlabs-scribe-v2 for AI cleanup, or ffmpeg-local for offline threshold cuts), and, for scribe, the filler/cough/retake removal intensities (0-100). Recommended default: Premiere XML input, elevenlabs-scribe-v2, filler 40 / cough 0 / retake 0.",
};

function settingsConfirmationErrorText(kind) {
  return (
    "Settings not confirmed — call rejected. Like the BuzzAssist app, confirm the generation settings with the user BEFORE generating: " +
    `ask ONE AskUserQuestion covering ${SETTINGS_QUESTION_GUIDES[kind]} ` +
    "Mark the default option with (Recommended) / （推奨）. Skip asking ONLY when the user's own message already specified every one of these settings. " +
    "Then call this tool again with confirmedSettings: true and the chosen values."
  );
}

function createProgressReporter(extra) {
  const progressToken = extra?._meta?.progressToken;
  if (progressToken === undefined || progressToken === null || typeof extra?.sendNotification !== "function") {
    return () => {};
  }
  return (progress, total, message) => {
    extra
      .sendNotification({
        method: "notifications/progress",
        params: {
          progressToken,
          progress,
          ...(total !== undefined ? { total } : {}),
          ...(message ? { message } : {}),
        },
      })
      .catch((error) => process.stderr.write(`[mcp-progress] failed: ${error?.message ?? String(error)}\n`));
  };
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
      source: "buzzassist-canvas",
      elements: [],
      appState: { viewBackgroundColor: "#ffffff" },
      files: {},
    };
  }

  const files = value.files && typeof value.files === "object" ? value.files : {};
  return {
    type: value.type ?? "excalidraw",
    version: value.version ?? 2,
    source: value.source ?? "buzzassist-canvas",
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
    referenceAudioPaths: args.referenceAudioPaths ?? args.reference_audio_paths,
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

  const columns = normalizeMediaBatchColumns(args.columns);
  const gap = finiteNumber(Number(args.gap), 24);
  const concurrency = normalizeMediaBatchConcurrency(args.concurrency);
  const dryRun = Boolean(args.dryRun);
  const results = new Array(jobs.length);
  const chunks = [];

  for (const [chunkIndex, chunk] of chunkMediaBatchJobs(jobs, DEFAULT_MEDIA_BATCH_CHUNK_SIZE).entries()) {
    const chunkJobs = chunk.jobs;
    const frames = dryRun
      ? []
      : await insertGeneratorFrameBatch({
          projectDir: args.projectDir,
          canvasDir: args.canvasDir,
          frames: chunkJobs.map((job) => ({
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
          focusCreated: args.focusCreated === true,
        });

    let writeQueue = Promise.resolve();
    const enqueueWrite = (fn) => {
      const next = writeQueue.then(fn, fn);
      writeQueue = next.catch(() => {});
      return next;
    };

    const generated = await runWithConcurrency(chunkJobs, concurrency, async (job, index) => {
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

    const chunkResults = chunkJobs.map((job, i) => {
      const outcome = generated[i];
      if (!outcome.ok) return { prompt: job.prompt, error: outcome.error, frameElementId: frames[i]?.elementId };
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

    for (const [i, result] of chunkResults.entries()) {
      results[chunk.start + i] = result;
    }

    if (!dryRun) {
      const failedFrameIds = chunkResults.filter((result) => result.error).map((result) => result.frameElementId);
      if (failedFrameIds.length > 0) {
        await enqueueWrite(() => clearFrameGeneratingFlags({ projectDir: args.projectDir, canvasDir: args.canvasDir }, failedFrameIds));
      }
    }

    const chunkSucceeded = chunkResults.filter((result) => !result.error).length;
    chunks.push({
      index: chunkIndex + 1,
      start: chunk.start,
      total: chunkJobs.length,
      succeeded: chunkSucceeded,
      failed: chunkJobs.length - chunkSucceeded,
      columns,
      concurrency,
    });
  }

  const succeeded = results.filter((result) => !result.error).length;
  return {
    ok: true,
    total: jobs.length,
    succeeded,
    failed: jobs.length - succeeded,
    dryRun,
    columns,
    concurrency,
    chunkSize: DEFAULT_MEDIA_BATCH_CHUNK_SIZE,
    chunks,
    results,
  };
}

async function generateExcalidrawVideosBatch(args = {}) {
  const jobs = Array.isArray(args.jobs) ? args.jobs : [];
  if (jobs.length === 0) throw new Error("generate_excalidraw_videos_batch requires a non-empty jobs array.");
  for (const job of jobs) {
    if (!nonEmptyString(job?.prompt)) throw new Error("Each video job requires a prompt.");
  }

  const columns = normalizeMediaBatchColumns(args.columns);
  const gap = finiteNumber(Number(args.gap), 24);
  const concurrency = normalizeMediaBatchConcurrency(args.concurrency);
  const dryRun = Boolean(args.dryRun);
  const results = new Array(jobs.length);
  const chunks = [];

  for (const [chunkIndex, chunk] of chunkMediaBatchJobs(jobs, DEFAULT_MEDIA_BATCH_CHUNK_SIZE).entries()) {
    const chunkJobs = chunk.jobs;
    const frames = dryRun
      ? []
      : await insertGeneratorFrameBatch({
          projectDir: args.projectDir,
          canvasDir: args.canvasDir,
          frames: chunkJobs.map((job) => ({
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
          focusCreated: args.focusCreated === true,
        });

    let writeQueue = Promise.resolve();
    const enqueueWrite = (fn) => {
      const next = writeQueue.then(fn, fn);
      writeQueue = next.catch(() => {});
      return next;
    };

    const generated = await runWithConcurrency(chunkJobs, concurrency, async (job, index) => {
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

    const chunkResults = chunkJobs.map((job, i) => {
      const outcome = generated[i];
      if (!outcome.ok) return { prompt: job.prompt, error: outcome.error, frameElementId: frames[i]?.elementId };
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

    for (const [i, result] of chunkResults.entries()) {
      results[chunk.start + i] = result;
    }

    if (!dryRun) {
      const failedFrameIds = chunkResults.filter((result) => result.error).map((result) => result.frameElementId);
      if (failedFrameIds.length > 0) {
        await enqueueWrite(() => clearFrameGeneratingFlags({ projectDir: args.projectDir, canvasDir: args.canvasDir }, failedFrameIds));
      }
    }

    const chunkSucceeded = chunkResults.filter((result) => !result.error).length;
    chunks.push({
      index: chunkIndex + 1,
      start: chunk.start,
      total: chunkJobs.length,
      succeeded: chunkSucceeded,
      failed: chunkJobs.length - chunkSucceeded,
      columns,
      concurrency,
    });
  }

  const succeeded = results.filter((result) => !result.error).length;
  return {
    ok: true,
    total: jobs.length,
    succeeded,
    failed: jobs.length - succeeded,
    dryRun,
    columns,
    concurrency,
    chunkSize: DEFAULT_MEDIA_BATCH_CHUNK_SIZE,
    chunks,
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
      name: TOOL_RENDER_BUZZASSIST_WIDGET,
      title: "Render BuzzAssist Canvas Widget",
      description: "Experimental MCP Apps widget for BuzzAssist. Use BUZZASSIST_CANVAS_URL in the host in-app browser for normal Codex and Claude Code work; call this only when the user explicitly asks to test the widget.",
      inputSchema: {
        type: "object",
        properties: {
          projectDir: { type: "string", description: "Absolute project directory containing canvas/." },
          canvasDir: { type: "string", description: "Absolute canvas directory. Overrides projectDir." },
          title: { type: "string", description: "Optional widget title." },
          displayMode: { type: "string", enum: ["inline", "fullscreen"], description: "Preferred display mode. Defaults to fullscreen." },
        },
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: {
        ui: {
          resourceUri: BUZZASSIST_WIDGET_URI,
          visibility: ["model", "app"],
        },
        "ui/resourceUri": BUZZASSIST_WIDGET_URI,
        "openai/outputTemplate": BUZZASSIST_WIDGET_URI,
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "Opening BuzzAssist canvas widget...",
        "openai/toolInvocation/invoked": "BuzzAssist canvas widget ready",
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
      name: TOOL_PREPARE_CANVAS_ATTACHMENTS,
      title: "Attach Selected Canvas Media",
      description: "Create a BuzzAssist attachment bundle from the current canvas selection and return images/resources/text into this current chat. Supports images, videos, audio, SRT, XML, and text/script assets.",
      inputSchema: {
        type: "object",
        properties: {
          projectDir: { type: "string", description: "Absolute project directory containing canvas/." },
          canvasDir: { type: "string", description: "Absolute canvas directory. Overrides projectDir." },
          note: { type: "string", description: "Optional note to store with the bundle." },
          maxInlineImageBytes: { type: "number", description: "Maximum image bytes to inline into the tool result. Larger files are returned as resource links only." },
          maxInlineTextBytes: { type: "number", description: "Maximum text bytes to inline for SRT/XML/text files." },
        },
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    {
      name: TOOL_READ_CANVAS_ATTACHMENT_BUNDLE,
      title: "Read Canvas Attachment Bundle",
      description: "Read a BuzzAssist attachment bundle created from the canvas UI and return its images/resources/text into this current chat. Use bundleId='latest' for the most recent bundle.",
      inputSchema: {
        type: "object",
        properties: {
          bundleId: { type: "string", description: "Attachment bundle id from the canvas UI, or 'latest'." },
          projectDir: { type: "string", description: "Absolute project directory containing canvas/." },
          canvasDir: { type: "string", description: "Absolute canvas directory. Overrides projectDir." },
          maxInlineImageBytes: { type: "number", description: "Maximum image bytes to inline into the tool result. Larger files are returned as resource links only." },
          maxInlineTextBytes: { type: "number", description: "Maximum text bytes to inline for SRT/XML/text files." },
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
      name: TOOL_LIST_CANVAS_ATTACHMENT_BUNDLES,
      title: "List Canvas Attachment Bundles",
      description: "List recent BuzzAssist attachment bundles prepared from the canvas.",
      inputSchema: {
        type: "object",
        properties: {
          projectDir: { type: "string", description: "Absolute project directory containing canvas/." },
          canvasDir: { type: "string", description: "Absolute canvas directory. Overrides projectDir." },
          limit: { type: "number", description: "Maximum bundles to return. Defaults to 10." },
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
      description: "Generate an image, insert it into the project canvas, and save the scene. Requires confirmedSettings=true unless using payloadPreview.",
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
          confirmedSettings: { type: "boolean", description: "True only after the user has confirmed the generation settings; payloadPreview is exempt." },
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
      description: "Generate a video, insert a media element into the project canvas, and save the scene. Requires confirmedSettings=true unless using payloadPreview.",
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
          referenceAudioPaths: { type: "array", items: { type: "string" }, description: "Optional local audio reference paths for video reference mode when supported by the selected route." },
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
          confirmedSettings: { type: "boolean", description: "True only after the user has confirmed the generation settings; payloadPreview is exempt." },
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
      description: "Create image generator frames, run image jobs in chunks of 10, and replace each frame as results finish. Requires confirmedSettings=true unless using payloadPreview.",
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
          columns: { type: "number", description: "Grid columns. Defaults to 5." },
          gap: { type: "number", description: "Canvas units between grid cells. Defaults to 24." },
          concurrency: { type: "number", description: "Parallel generations per chunk. Defaults to 10 and is capped at 10." },
          projectDir: { type: "string", description: "Absolute project directory containing canvas/." },
          canvasDir: { type: "string", description: "Absolute canvas directory. Overrides projectDir." },
          selectCreated: { type: "boolean", description: "Select the inserted elements after saving." },
          focusCreated: { type: "boolean", description: "Focus the canvas viewport on the newly created generator-frame grid. Defaults to false; leave unset to avoid moving the user's current canvas view." },
          confirmedSettings: { type: "boolean", description: "True only after the user has confirmed the batch generation settings; payloadPreview is exempt." },
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
      description: "Create video generator frames, run video jobs in chunks of 10, and replace each frame as results finish. Requires confirmedSettings=true unless using payloadPreview.",
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
          columns: { type: "number", description: "Grid columns. Defaults to 5." },
          gap: { type: "number", description: "Canvas units between grid cells. Defaults to 24." },
          concurrency: { type: "number", description: "Parallel generations per chunk. Defaults to 10 and is capped at 10." },
          projectDir: { type: "string", description: "Absolute project directory containing canvas/." },
          canvasDir: { type: "string", description: "Absolute canvas directory. Overrides projectDir." },
          selectCreated: { type: "boolean", description: "Select the inserted elements after saving." },
          focusCreated: { type: "boolean", description: "Focus the canvas viewport on the newly created generator-frame grid. Defaults to false; leave unset to avoid moving the user's current canvas view." },
          confirmedSettings: { type: "boolean", description: "True only after the user has confirmed the batch generation settings; payloadPreview is exempt." },
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
      description: "Generate Japanese SRT subtitles, save the SRT under canvas/assets, and place an SRT card on the canvas. Requires confirmedSettings=true.",
      inputSchema: {
        type: "object",
        properties: {
          audioPath: { type: "string", description: "Absolute local audio file path (mp3/wav/m4a/ogg/opus/webm/flac/aac) or a video file (mp4/mov/webm/mkv… — the audio track is extracted automatically). Required unless subtitleLines is given." },
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
          confirmedSettings: { type: "boolean", description: "True only after the user has confirmed subtitle settings." },
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
      name: TOOL_GENERATE_SUBTITLES_BATCH,
      title: "Generate Excalidraw Subtitles (Batch)",
      description: "Generate Japanese SRT subtitles for many audio/video files and place one SRT card per job. Requires confirmedSettings=true.",
      inputSchema: {
        type: "object",
        properties: {
          jobs: {
            type: "array",
            minItems: 1,
            description: "One entry per SRT to generate.",
            items: {
              type: "object",
              properties: {
                audioPath: { type: "string", description: "Absolute local audio or video file path." },
                scriptText: { type: "string", description: "Narration script for this job (scripted mode)." },
                scriptPath: { type: "string", description: "Absolute path to a UTF-8 script file for this job." },
                fileName: { type: "string", description: "Destination SRT filename under canvas/assets/." },
                anchorElementId: { type: "string", description: "Existing Excalidraw element id to place beside." },
              },
              required: ["audioPath"],
              additionalProperties: false,
            },
          },
          mode: { type: "string", enum: ["scripted", "scriptless"], description: "Shared mode. Defaults per job: scripted when that job has a script, else scriptless." },
          lineCount: { type: "number", description: "Subtitle lines per cue: 1 or 2." },
          maxCharsPerLine: { type: "number", description: "Max characters per line (Japanese-aware)." },
          holdSeconds: { type: "number", description: "Extra seconds each cue stays on screen." },
          punctuationMode: { type: "string", enum: ["auto", "none"] },
          fillerMode: { type: "string", enum: ["keep", "safe", "contextual"] },
          normalizeAudio: { type: "boolean", description: "Loudness-normalize before transcription. Defaults to true." },
          projectDir: { type: "string", description: "Absolute project directory containing canvas/." },
          canvasDir: { type: "string", description: "Absolute canvas directory. Overrides projectDir." },
          confirmedSettings: { type: "boolean", description: "True only after the user has confirmed the shared subtitle settings." },
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
      name: TOOL_SILENCE_CUT_VIDEO,
      title: "Silence Cut Excalidraw Video",
      description: "Remove silences and write a non-destructive Premiere Pro XML under canvas/assets. Requires confirmedSettings=true except ffmpeg-local dryRun previews.",
      inputSchema: {
        type: "object",
        properties: {
          videoPath: { type: "string", description: "Absolute local path to cut: a video file (mp4/mov/…) or a Premiere Pro XML (.xml, FCP7 xmeml with one video track)." },
          model: { type: "string", enum: ["elevenlabs-scribe-v2", "ffmpeg-local"], description: "Cut engine. Defaults/recommended to elevenlabs-scribe-v2; use ffmpeg-local only for fully offline threshold cuts." },
          fillerRemoval: { type: "number", description: "0-100. Scribe mode only: remove Japanese fillers (えー/あのー…). 0 off, 35+ adds その/なんか, 70+ adds ていうか/やっぱり." },
          coughRemoval: { type: "number", description: "0-100. Scribe mode only: cut coughs/sneezes detected as audio events." },
          retakeRemoval: { type: "number", description: "0-100. Scribe mode only: cut retake markers (いや/違う/もう一回…); 70+ also rewinds over the flubbed phrase." },
          instructionPrompt: { type: "string", description: "Scribe mode only: natural-language bias, e.g. テンポよく (tighter) or 自然に余韻を残して (looser)." },
          glossary: { type: "array", items: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"], additionalProperties: false }, description: "Scribe mode only: term corrections applied to the transcription." },
          detectSeconds: { type: "number", description: "Minimum silence length to detect. Defaults to 0.6." },
          thresholdDb: { type: ["number", "string"], description: "Silence threshold in dB (ffmpeg-local only), or \"auto\" (default) to calibrate from the media's measured noise floor (+6dB)." },
          keepSeconds: { type: "number", description: "Silence seconds to keep around cuts. Defaults to 0.25." },
          preMarginSeconds: { type: "number", description: "Safety margin before speech. Defaults to 0.08." },
          postMarginSeconds: { type: "number", description: "Safety margin after speech. Defaults to 0.12." },
          fileName: { type: "string", description: "Destination .xml filename under canvas/assets/." },
          projectDir: { type: "string", description: "Absolute project directory containing canvas/." },
          canvasDir: { type: "string", description: "Absolute canvas directory. Overrides projectDir." },
          confirmedSettings: { type: "boolean", description: "True only after the user has confirmed silence-cut settings; ffmpeg-local dryRun is exempt." },
          dryRun: { type: "boolean", description: "Preview only: return the cut plan (ranges, candidates, durations) without writing the XML." },
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
      name: TOOL_SETUP_HERMES,
      title: "Setup Hermes Grok",
      description:
        "Set up the Hermes route for Grok Imagine: checks the Hermes Agent CLI and, when not logged in, runs `hermes auth add xai-oauth` which opens the browser so the user can complete the X (xAI) OAuth. Call this when the user asks to set up Hermes or a Hermes generation fails with 'Hermes Agent was not found' / 'not logged in'. Blocks up to 10 minutes while the user signs in.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
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
    {
      name: TOOL_CANVAS_TUNNEL_START,
      title: "Start BuzzAssist Canvas Tunnel",
      description: "Start an ngrok tunnel for the same full local Excalidraw canvas UI, protected by a generated access URL. Use for phone/mobile access when the user wants the exact local canvas UI.",
      inputSchema: {
        type: "object",
        properties: {
          projectDir: { type: "string", description: "Absolute project directory containing canvas/." },
          canvasDir: { type: "string", description: "Absolute canvas directory. Overrides projectDir." },
          ngrokAuthtoken: { type: "string", description: "Optional personal ngrok authtoken to configure before starting." },
          accessToken: { type: "string", description: "Optional URL access token. Defaults to a generated token." },
          basicAuth: { type: "boolean", description: "Also enable ngrok Basic Auth. Defaults to false because some in-app browsers do not show the auth prompt." },
          user: { type: "string", description: "Basic Auth user when --basic-auth is enabled. Defaults to buzzassist." },
          password: { type: "string", description: "Basic Auth password when --basic-auth is enabled. Defaults to a generated password." },
          localUrl: { type: "string", description: "Existing local canvas URL to expose. Usually omitted so the tool starts a tunnel-ready canvas server." },
          reuseLocal: { type: "boolean", description: "Reuse canvas/.server.json instead of starting a tunnel-ready canvas server. Use only when the local server already allows the tunnel origin." },
          restart: { type: "boolean", description: "Restart an existing tunnel. Defaults to false." },
          compression: { type: "boolean", description: "Enable ngrok gzip compression. Defaults to true." },
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
      name: TOOL_CANVAS_TUNNEL_STATUS,
      title: "BuzzAssist Canvas Tunnel Status",
      description: "Return the current ngrok Canvas Tunnel URL, access URL, optional Basic Auth credentials, local canvas URL, and status file path.",
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
      name: TOOL_CANVAS_TUNNEL_STOP,
      title: "Stop BuzzAssist Canvas Tunnel",
      description: "Stop the ngrok Canvas Tunnel and any tunnel-managed canvas server.",
      inputSchema: {
        type: "object",
        properties: {
          projectDir: { type: "string", description: "Absolute project directory containing canvas/." },
          canvasDir: { type: "string", description: "Absolute canvas directory. Overrides projectDir." },
        },
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
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
      hint: "Step 2 is line breaking. Decide semantic cue boundaries from the timed words (respect maxCharsPerLine, 1-2 lines per cue, break only at natural Japanese bunsetsu boundaries — never right after a particle or mid compound verb). Then call this tool again with subtitleLines; keep each cue's start/end from the word timings.",
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
    quality: generated.quality,
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
  const videoPath = nonEmptyString(args.videoPath) || nonEmptyString(args.inputPath);
  if (!videoPath) throw new Error("videoPath is required (a video file or a Premiere XML).");

  // Output is a jet-cut Premiere XML written straight into canvas/assets so
  // it is downloadable — no canvas element is created.
  const assetsDir = join(resolveCanvasDir(args), "assets");
  const cut = await silenceCutVideo({
    inputPath: pathResolve(videoPath),
    outputDir: assetsDir,
    fileName: args.fileName,
    model: args.model || "elevenlabs-scribe-v2",
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
    planOnly: Boolean(args.dryRun),
  });

  const stats = {
    inputDuration: cut.inputDuration,
    outputDuration: cut.outputDuration,
    cutDuration: cut.cutDuration,
    cutCount: cut.cutCount,
    clipCount: cut.clipCount,
    thresholdAuto: cut.thresholdAuto,
    ...(cut.thresholdDbUsed !== undefined ? { thresholdDbUsed: cut.thresholdDbUsed } : {}),
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

  return {
    ok: true,
    model: cut.model,
    kind: "premiere-xml",
    ...stats,
    outputPath: cut.outputPath,
    fileName: cut.fileName,
    assetUrl: `/excalidraw-assets/${cut.fileName}`,
    ...(cut.transcription ? { transcription: cut.transcription } : {}),
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
  TOOL_GENERATE_SUBTITLES_BATCH,
  TOOL_SILENCE_CUT_VIDEO,
]);

async function handleToolCall(params, progress = () => {}) {
  const settingsGateKind = SETTINGS_CONFIRMATION_TOOLS.get(params?.name);
  if (settingsGateKind) {
    const gateArgs = params.arguments ?? {};
    // payloadPreview never generates. Only ffmpeg-local silence-cut dryRun is
    // exempt; Scribe dryRun transcribes and consumes credits, so it still
    // needs the user-confirmed settings attestation.
    const gateExempt =
      gateArgs.payloadPreview === true ||
      (settingsGateKind === "silenceCut" && gateArgs.dryRun === true && gateArgs.model === "ffmpeg-local");
    if (!gateArgs.confirmedSettings && !gateExempt) {
      return {
        content: [{ type: "text", text: settingsConfirmationErrorText(settingsGateKind) }],
        isError: true,
      };
    }
    delete gateArgs.confirmedSettings;
  }
  if (CANVAS_AUTO_OPEN_TOOLS.has(params?.name)) {
    progress(0, 1, "Opening Excalidraw canvas");
    await ensureCanvasVisible(params.arguments ?? {});
  }
  if (params?.name === TOOL_GENERATE_SUBTITLES) {
    progress(0, 2, "Generating subtitles");
    const result = await generateExcalidrawSubtitles(params.arguments ?? {});
    progress(2, 2, "Subtitles complete");
    return {
      content: [
        {
          type: "text",
          text: `Generated ${result.cueCount} subtitle cue(s) with ${result.model} (${result.mode})${result.dryRun ? " [dry run]" : ""}.${result.dryRun ? "" : canvasHintText()}`,
        },
      ],
      structuredContent: result,
    };
  }

  if (params?.name === TOOL_GENERATE_SUBTITLES_BATCH) {
    const args = params.arguments ?? {};
    const jobs = Array.isArray(args.jobs) ? args.jobs : [];
    if (jobs.length === 0) {
      return {
        content: [{ type: "text", text: "jobs must contain at least one entry." }],
        isError: true,
      };
    }
    const results = [];
    let succeeded = 0;
    for (const [index, job] of jobs.entries()) {
      try {
        progress(index, jobs.length, `Generating subtitles ${index + 1}/${jobs.length}`);
        const merged = { ...args, ...job };
        delete merged.jobs;
        delete merged.returnWordsOnly;
        delete merged.subtitleLines;
        const result = await generateExcalidrawSubtitles(merged);
        succeeded += 1;
        results.push({
          ok: true,
          audioPath: job.audioPath,
          cueCount: result.cueCount,
          credits: result.credits,
          elementId: result.elementId,
          assetUrl: result.assetUrl,
        });
      } catch (error) {
        results.push({ ok: false, audioPath: job.audioPath, error: error?.message || String(error) });
      }
    }
    progress(jobs.length, jobs.length, "Subtitle batch complete");
    const failed = jobs.length - succeeded;
    return {
      content: [
        {
          type: "text",
          text: `Generated ${succeeded}/${jobs.length} SRT card(s)${failed ? `, ${failed} failed` : ""}.${succeeded ? canvasHintText() : ""}`,
        },
      ],
      structuredContent: { ok: succeeded > 0, total: jobs.length, succeeded, failed, results },
    };
  }

  if (params?.name === TOOL_SILENCE_CUT_VIDEO) {
    progress(0, 1, "Building silence-cut XML");
    const result = await silenceCutExcalidrawVideo(params.arguments ?? {});
    progress(1, 1, "Silence-cut complete");
    return {
      content: [
        {
          type: "text",
          text: `Silence-cut ${result.cutCount} range(s): ${result.inputDuration.toFixed(1)}s -> ${result.outputDuration.toFixed(1)}s (${result.cutDuration.toFixed(1)}s removed)${result.dryRun ? " [dry run]" : ` — Premiere XML saved as ${result.fileName} (${result.assetUrl}); import it into Premiere Pro as a cut-applied sequence`}.`,
        },
      ],
      structuredContent: result,
    };
  }

  if (params?.name === TOOL_BUZZASSIST_LOGIN) {
    const result = await handleBuzzAssistLogin(params.arguments ?? {});
    return {
      content: [{ type: "text", text: result.message }],
      structuredContent: result,
    };
  }

  if (params?.name === TOOL_SETUP_HERMES) {
    const before = await getHermesStatus();
    if (before.installed && before.session === "logged-in") {
      return {
        content: [{ type: "text", text: "Hermes is installed and already logged in to xAI Grok OAuth. The Hermes route is ready." }],
        structuredContent: { ...before, action: "already-logged-in" },
      };
    }
    const result = await setupHermesGrok();
    return {
      content: [
        {
          type: "text",
          text:
            result.action === "already-logged-in"
              ? "Hermes was already logged in. The Hermes route is ready."
              : "Hermes xAI OAuth completed — the browser sign-in succeeded and the Hermes route is ready for Grok Imagine.",
        },
      ],
      structuredContent: result,
    };
  }

  if (params?.name === TOOL_BUZZASSIST_AUTH_STATUS) {
    const status = await getBuzzAssistAuthStatus();
    const summary = status.loggedIn
      ? `ログイン中: ${status.userId ?? "不明なユーザー"}（source: ${status.source}）。${status.expiresSoon ? ` 警告: トークンの有効期限まであと${status.expiresInDays}日です — buzzassist_login で更新してください。` : ""}`
      : status.expired
        ? "BuzzAssistのログイン有効期限が切れています。buzzassist_login を実行してください。"
        : "BuzzAssistにログインしていません。buzzassist_login を実行してください。";
    return {
      content: [{ type: "text", text: summary }],
      structuredContent: status,
    };
  }

  if (params?.name === TOOL_CANVAS_TUNNEL_START) {
    progress(0, 1, "Starting Canvas Tunnel");
    const result = await runCanvasTunnelCommand("start", params.arguments ?? {});
    progress(1, 1, "Canvas Tunnel ready");
    const status = result.status || {};
    const text = status.publicUrl
      ? `Canvas Tunnel is running. Open: ${status.accessUrl || status.publicUrl}. Local canvas: ${status.localBaseUrl}${status.basicAuth ? ` (Basic Auth: ${status.user} / ${status.password})` : ""}`
      : result.stdout || "Canvas Tunnel start completed.";
    return {
      content: [{ type: "text", text }],
      structuredContent: result,
    };
  }

  if (params?.name === TOOL_CANVAS_TUNNEL_STATUS) {
    const result = await runCanvasTunnelCommand("status", params.arguments ?? {});
    const status = result.status || {};
    const text = status.publicUrl
      ? `Canvas Tunnel ${status.ok ? "running" : "stopped"}. Open: ${status.accessUrl || status.publicUrl}. Local canvas: ${status.localBaseUrl}${status.basicAuth ? ` (Basic Auth: ${status.user} / ${status.password})` : ""}`
      : result.stdout || "Canvas Tunnel is not running.";
    return {
      content: [{ type: "text", text }],
      structuredContent: result,
    };
  }

  if (params?.name === TOOL_CANVAS_TUNNEL_STOP) {
    const result = await runCanvasTunnelCommand("stop", params.arguments ?? {});
    return {
      content: [{ type: "text", text: result.stdout || "Canvas Tunnel stopped." }],
      structuredContent: result,
    };
  }

  if (params?.name === TOOL_RENDER_BUZZASSIST_WIDGET) {
    const widgetData = await widgetStructuredContent(params.arguments ?? {});
    return {
      content: [
        {
          type: "text",
          text: `Rendered BuzzAssist canvas widget. Local canvas: ${widgetData.canvasUrl || "unavailable"}`,
        },
      ],
      structuredContent: widgetData,
      _meta: widgetToolResultMetadata(widgetData),
    };
  }

  if (params?.name === TOOL_READ_ME) {
    return {
      content: [{ type: "text", text: OFFICIAL_EXCALIDRAW_README }],
      structuredContent: { ok: true },
    };
  }

  if (params?.name === TOOL_CREATE_VIEW) {
    const result = await createExcalidrawView(params.arguments ?? {});
    return {
      content: [
        {
          type: "text",
          text: `${result.dryRun ? "Planned" : "Created"} Excalidraw view with ${result.addedElementCount} element(s).`,
        },
      ],
      structuredContent: result,
    };
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

    return {
      content: [{ type: "text", text: summary }],
      structuredContent: { selection, selectionFile, sceneFile: resolveCanvasFile(args), sceneElementCount: scene.elements.length },
    };
  }

  if (params?.name === TOOL_PREPARE_CANVAS_ATTACHMENTS) {
    const args = params.arguments ?? {};
    const bundle = await createCanvasAttachmentBundle({ ...args, source: "mcp-selection" });
    return canvasAttachmentBundleToMcpResult({ ...args, bundleId: bundle.id });
  }

  if (params?.name === TOOL_READ_CANVAS_ATTACHMENT_BUNDLE) {
    const args = params.arguments ?? {};
    return canvasAttachmentBundleToMcpResult(args);
  }

  if (params?.name === TOOL_LIST_CANVAS_ATTACHMENT_BUNDLES) {
    const args = params.arguments ?? {};
    const bundles = await listCanvasAttachmentBundles(args);
    const summary =
      bundles.length === 0
        ? "No BuzzAssist canvas attachment bundles found."
        : bundles
            .map((bundle) => `${bundle.id} — ${bundle.assets.length} asset(s) — ${bundle.createdAt}`)
            .join("\n");
    return {
      content: [{ type: "text", text: summary }],
      structuredContent: { bundles },
    };
  }

  if (params?.name === TOOL_INSERT_IMAGE) {
    const result = await insertExcalidrawImage(params.arguments ?? {});
    return {
      content: [
        {
          type: "text",
          text: `${result.dryRun ? "Planned" : "Inserted"} ${result.elementId} at (${result.bounds.x}, ${result.bounds.y}) sized ${result.bounds.width}x${result.bounds.height}.`,
        },
      ],
      structuredContent: result,
    };
  }

  if (params?.name === TOOL_INSERT_VIDEO) {
    const result = await insertExcalidrawVideo(params.arguments ?? {});
    return {
      content: [
        {
          type: "text",
          text: `${result.dryRun ? "Planned" : "Inserted"} video media element ${result.elementId} at (${result.bounds.x}, ${result.bounds.y}) sized ${result.bounds.width}x${result.bounds.height}.`,
        },
      ],
      structuredContent: result,
    };
  }

  if (params?.name === TOOL_GENERATE_IMAGE) {
    progress(0, 1, "Generating image");
    const result = await generateExcalidrawImage(params.arguments ?? {});
    progress(1, 1, "Image generation complete");
    return {
      content: [
        {
          type: "text",
          text: result.payloadPreview
            ? `Payload preview for ${result.model}${result.endpoint ? ` -> ${result.endpoint}` : ""}: ~${result.estimatedCredits ?? "?"} credits.`
            : `${result.dryRun ? "Planned" : "Generated"} image ${result.elementId} at (${result.bounds.x}, ${result.bounds.y}) sized ${result.bounds.width}x${result.bounds.height}.${result.dryRun ? "" : canvasHintText()}`,
        },
      ],
      structuredContent: result,
    };
  }

  if (params?.name === TOOL_GENERATE_VIDEO) {
    progress(0, 1, "Generating video");
    const result = await generateExcalidrawVideo(params.arguments ?? {});
    progress(1, 1, "Video generation complete");
    return {
      content: [
        {
          type: "text",
          text: result.payloadPreview
            ? `Payload preview for ${result.model}${result.endpoint ? ` -> ${result.endpoint}` : ""}: ~${result.estimatedCredits ?? "?"} credits.`
            : `${result.dryRun ? "Planned" : "Generated"} video media element ${result.elementId} at (${result.bounds.x}, ${result.bounds.y}) sized ${result.bounds.width}x${result.bounds.height}.${result.dryRun ? "" : canvasHintText()}`,
        },
      ],
      structuredContent: result,
    };
  }

  if (params?.name === TOOL_GENERATE_IMAGES_BATCH) {
    progress(0, 1, "Generating image batch");
    const result = await generateExcalidrawImagesBatch(params.arguments ?? {});
    progress(1, 1, "Image batch complete");
    return {
      content: [
        {
          type: "text",
          text: `${result.dryRun ? "Planned" : "Generated"} ${result.succeeded}/${result.total} image(s) as a grid${result.failed ? `, ${result.failed} failed` : ""}.${result.dryRun ? "" : canvasHintText()}`,
        },
      ],
      structuredContent: result,
    };
  }

  if (params?.name === TOOL_GENERATE_VIDEOS_BATCH) {
    progress(0, 1, "Generating video batch");
    const result = await generateExcalidrawVideosBatch(params.arguments ?? {});
    progress(1, 1, "Video batch complete");
    return {
      content: [
        {
          type: "text",
          text: `${result.dryRun ? "Planned" : "Generated"} ${result.succeeded}/${result.total} video media element(s) as a grid${result.failed ? `, ${result.failed} failed` : ""}.${result.dryRun ? "" : canvasHintText()}`,
        },
      ],
      structuredContent: result,
    };
  }

  throw new Error(`Unknown tool: ${params?.name ?? ""}`);
}

// Startup housekeeping (safe-only): migrate legacy inline file records and
// sweep stale .tmp files. Never moves subtitle cards or trashes assets on its
// own. Fire-and-forget — stdout is reserved for JSON-RPC, so results go to stderr.
performCanvasMaintenance({ safeOnly: true })
  .then((results) => {
    const summary = JSON.stringify(results);
    if (summary !== "{}") process.stderr.write(`[canvas-maintenance] ${summary}\n`);
  })
  .catch((error) => process.stderr.write(`[canvas-maintenance] failed: ${error?.message}\n`));

// This process lives in the user's GUI session (spawned by Claude Code /
// Codex), so it can run the osascript paste that the browser canvas and the
// preview-jailed vite server cannot — execute their queued chat-send
// requests (canvas/.chat-bridge/).
try {
  startChatBridgeWorker({ canvasDir: resolveCanvasDir() });
} catch (error) {
  process.stderr.write(`[chat-bridge] failed to start: ${error?.message}\n`);
}

const server = new McpServer(
  {
    name: SERVER_NAME,
    version: SERVER_VERSION,
  },
  {
    instructions: MEDIA_GENERATION_AGENT_INSTRUCTIONS,
  },
);

registerBuzzAssistWidget(server);
for (const definition of toolDefinitions()) {
  if (definition.name === TOOL_RENDER_BUZZASSIST_WIDGET) continue;
  server.registerTool(
    definition.name,
    toolConfigForMcpServer(definition),
    async (args = {}, extra) => {
      try {
        return await handleToolCall({ name: definition.name, arguments: args }, createProgressReporter(extra));
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
