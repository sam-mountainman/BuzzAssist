import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { basename, delimiter, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import PQueue from "p-queue";
import { extForMimeType, mimeTypeForFile, nonEmptyString, sanitizeFileName } from "./canvasScene.mjs";
import {
  FAL_IMAGE_MODELS,
  FAL_VIDEO_MODELS,
  falVideoDurationOptions,
  generateFalImageMedia,
  generateFalVideoMedia,
  isFalImageModel,
  isFalVideoModel,
} from "./falMediaGeneration.mjs";
import { getBuzzAssistAuthStatus, resolveBuzzAssistApiBase } from "./buzzassistApi.mjs";
import { withMachineSlot } from "./machineSlots.mjs";
import { assertPaidCallAllowed } from "./paidCallGuard.mjs";
import {
  LOVART_IMAGE_MODELS,
  LOVART_VIDEO_MODELS,
  generateLovartImageMedia,
  generateLovartVideoMedia,
  isLovartImageModel,
  isLovartVideoModel,
} from "./lovartMediaGeneration.mjs";

export const DEFAULT_IMAGE_MODEL = "gpt-image-2-codex";
export const DEFAULT_VIDEO_MODEL = "grok-imagine-video-hermes";
export const DEFAULT_MEDIA_BATCH_COLUMNS = 5;
export const DEFAULT_MEDIA_BATCH_CONCURRENCY = 10;
export const DEFAULT_MEDIA_BATCH_CHUNK_SIZE = 10;
export const MAX_CODEX_IMAGE_COUNT = DEFAULT_MEDIA_BATCH_CONCURRENCY;
export const MAX_GROK_GENERATION_COUNT = DEFAULT_MEDIA_BATCH_CONCURRENCY;
const GROK_CLI_VIDEO_DURATIONS = Object.freeze([6, 10]);

export const IMAGE_MODELS = [
  { id: "gpt-image-2-codex", label: "GPT Image 2 (Codex)", provider: "codex" },
  { id: "grok-imagine-image-hermes", label: "Grok Imagine (Grok CLI)", provider: "grok" },
  ...FAL_IMAGE_MODELS.map((model) => ({ ...model, requiresBuzzAssist: true })),
  ...LOVART_IMAGE_MODELS.map(({ id, label, provider }) => ({ id, label, provider, requiresLovart: true })),
];

export const VIDEO_MODELS = [
  { id: "grok-imagine-video-hermes", label: "Grok Imagine (Grok CLI)", provider: "grok" },
  ...FAL_VIDEO_MODELS.map((model) => ({ ...model, requiresBuzzAssist: true })),
  ...LOVART_VIDEO_MODELS.map(({ id, label, provider }) => ({ id, label, provider, requiresLovart: true })),
];

export function normalizeMediaBatchConcurrency(value, fallback = DEFAULT_MEDIA_BATCH_CONCURRENCY) {
  const parsed = Number(value);
  const safeFallback = Math.max(1, Math.round(Number(fallback) || DEFAULT_MEDIA_BATCH_CONCURRENCY));
  if (!Number.isFinite(parsed)) return safeFallback;
  return Math.max(1, Math.round(parsed));
}

export function normalizeMediaBatchColumns(value, fallback = DEFAULT_MEDIA_BATCH_COLUMNS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return Math.max(1, Math.round(Number(fallback) || DEFAULT_MEDIA_BATCH_COLUMNS));
  return Math.max(1, Math.round(parsed));
}

export function chunkMediaBatchJobs(jobs, chunkSize = DEFAULT_MEDIA_BATCH_CHUNK_SIZE) {
  const items = Array.isArray(jobs) ? jobs : [];
  const safeChunkSize = Math.max(1, Math.round(Number(chunkSize) || DEFAULT_MEDIA_BATCH_CHUNK_SIZE));
  const chunks = [];
  for (let start = 0; start < items.length; start += safeChunkSize) {
    chunks.push({ start, jobs: items.slice(start, start + safeChunkSize) });
  }
  return chunks;
}

// Where the next batch chunk's grid should start. Batches run in 10-job
// chunks, and only the first chunk receives anchor/placement args, so without
// an explicit origin every later chunk restarts at the scene's bottom anchor
// and a >10-job strip breaks into disconnected blocks. Align follow-up chunks
// with the previous chunk's left edge and continue below its lowest frame.
export function nextBatchChunkOrigin(frames, gap, previousOrigin = null) {
  const bounds = (Array.isArray(frames) ? frames : [])
    .map((frame) => frame?.bounds)
    .filter((value) => value && Number.isFinite(Number(value.x)) && Number.isFinite(Number(value.y)));
  if (bounds.length === 0) return previousOrigin;
  const normalizedGap = Number.isFinite(Number(gap)) ? Math.max(0, Number(gap)) : 24;
  const minX = Math.min(...bounds.map((value) => Number(value.x)));
  const maxBottom = Math.max(...bounds.map((value) => Number(value.y) + (Number(value.height) || 0)));
  return {
    x: previousOrigin && Number.isFinite(Number(previousOrigin.x))
      ? Math.min(Number(previousOrigin.x), minX)
      : minX,
    y: maxBottom + normalizedGap,
  };
}

export function mergeReferenceImagePaths(...pathLists) {
  const merged = [];
  const seen = new Set();
  for (const pathList of pathLists) {
    if (!Array.isArray(pathList)) continue;
    for (const value of pathList) {
      const path = typeof value === "string" ? value.trim() : "";
      if (!path || seen.has(path)) continue;
      seen.add(path);
      merged.push(path);
    }
  }
  return merged;
}

function getEnv(name) {
  return nonEmptyString(process.env[name]);
}

function safeProcessCwd() {
  try {
    return process.cwd();
  } catch {
    return os.homedir();
  }
}

export function resolveCodexImageBridgeCwd(env = process.env, fallback = safeProcessCwd()) {
  return nonEmptyString(env?.CODEX_IMAGE_BRIDGE_CWD) || fallback;
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

function resolveExplicitCodexImageBridgeCommand() {
  return getEnv("EXCALIDRAW_GPT_IMAGE_2_CODEX_COMMAND") || getEnv("EXCALIDRAW_IMAGE_GENERATION_COMMAND");
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// モデル名の別名（表記ゆれ）。ここに無く、IMAGE_MODELS / VIDEO_MODELS の id・表示名とも一致しない
// 名前は「知らないモデル」として止める。以前は既定のモデルへ黙って置き換えていたので、
// 頼んでいないモデルで生成・課金される経路があった（最適構成エンジンの設計 3-6「静かなすり替えの禁止」）。
const IMAGE_MODEL_ALIASES = new Map([
  ...[
    "grok imagine (grok cli)",
    "grok imagine image (grok cli)",
    "grok-imagine-image-grok-cli",
    "grok imagine image (hermes)",
    "grok imagine image hermes",
    "grok imagine(hermes)",
    "grok imagine (hermes)",
    "grok-imagine-hermes",
    "grok-imagine-image-hermes",
  ].map((alias) => [alias, "grok-imagine-image-hermes"]),
  ["gpt image 2 (codex)", "gpt-image-2-codex"],
  ["gpt-image-2-codex", "gpt-image-2-codex"],
  ["nano-banana-2", "nano-banana-2"],
  ["nano banana 2", "nano-banana-2"],
  ["gpt-image-2", "gpt-image-2"],
  ["gpt image 2(api)", "gpt-image-2"],
  ["gpt image 2 (api)", "gpt-image-2"],
  ["gpt-image-2-api", "gpt-image-2"],
  ["seedream-v5-lite", "seedream-v5-lite"],
  ["seedream 5.0 lite", "seedream-v5-lite"],
  ["seedream-5-lite", "seedream-v5-lite"],
  ["grok-imagine-image-api", "grok-imagine-image-api"],
  ["grok imagine(api)", "grok-imagine-image-api"],
  ["grok imagine (api)", "grok-imagine-image-api"],
  ["midjourney", "lovart-midjourney"],
  ["lovart midjourney", "lovart-midjourney"],
  ["midjourney (lovart)", "lovart-midjourney"],
  ["flux.2 max", "lovart-flux-2-max"],
  ["flux-2-max", "lovart-flux-2-max"],
  ["nano banana pro", "lovart-nano-banana-pro"],
  ["nano-banana-pro", "lovart-nano-banana-pro"],
  ["ideogram 4", "lovart-ideogram-v4"],
  ["ideogram-v4", "lovart-ideogram-v4"],
]);

const VIDEO_MODEL_ALIASES = new Map([
  ...[
    "grok imagine video (grok cli)",
    "grok-imagine-video-grok-cli",
    "grok imagine video (hermes)",
    "grok imagine video hermes",
    "grok imagine video(hermes)",
    "grok imagine (hermes)",
    "grok imagine hermes",
    "grok imagine(hermes)",
    "grok-imagine-video-hermes",
  ].map((alias) => [alias, "grok-imagine-video-hermes"]),
  ["seedance-2", "seedance-2"],
  ["seedance 2", "seedance-2"],
  ["seedance-2-fast", "seedance-2-fast"],
  ["seedance 2 fast", "seedance-2-fast"],
  ["kling-v3", "kling-v3"],
  ["kling v3", "kling-v3"],
  ["kling-o3", "kling-o3"],
  ["kling o3", "kling-o3"],
  ["kling-v2-6", "kling-v2-6"],
  ["kling v2.6", "kling-v2-6"],
  ["kling-v2.6", "kling-v2-6"],
  ["grok-imagine-video-api", "grok-imagine-video-api"],
  ["grok imagine video(api)", "grok-imagine-video-api"],
  ["grok imagine video (api)", "grok-imagine-video-api"],
  ["veo 3.1", "lovart-veo-3-1"],
  ["veo-3-1", "lovart-veo-3-1"],
  ["veo3.1", "lovart-veo-3-1"],
  ["veo 3.1 fast", "lovart-veo-3-1-fast"],
  ["veo-3-1-fast", "lovart-veo-3-1-fast"],
  ["hailuo 2.3", "lovart-hailuo-2-3"],
  ["hailuo-2-3", "lovart-hailuo-2-3"],
  ["kling 3.0 omni", "lovart-kling-3-omni"],
  ["kling-3-omni", "lovart-kling-3-omni"],
  ["wan 2.6", "lovart-wan-2-6"],
  ["wan-2-6", "lovart-wan-2-6"],
]);

export const UNKNOWN_MEDIA_MODEL_CODE = "UNKNOWN_MEDIA_MODEL";

/**
 * 名前をモデル id に解決する。未指定（空）は既定のモデル、知らない名前は null。
 * 順番: 別名 → id の完全一致 → 表示名の完全一致（大文字小文字は区別しない）。
 */
function resolveMediaModelId(rawModel, { aliases, models, defaultModel }) {
  const text = String(rawModel ?? "").trim();
  if (!text) return defaultModel;
  const lower = text.toLowerCase();
  if (aliases.has(lower)) return aliases.get(lower);
  const byId = models.find((model) => model.id.toLowerCase() === lower);
  if (byId) return byId.id;
  const byLabel = models.filter((model) => String(model.label || "").toLowerCase() === lower);
  return byLabel.length === 1 ? byLabel[0].id : null;
}

function unknownMediaModelError(kind, rawModel, models, defaultModel) {
  const label = kind === "video" ? "動画" : "画像";
  const error = new Error(
    `${label}のモデル「${String(rawModel)}」は知らないモデル。既定の ${defaultModel} に黙って置き換えずに止めた`
    + `（頼んでいないモデルで生成・課金しないため）。使えるモデル: ${models.map((model) => model.id).join(", ")}。`
    + "既定のモデルでよければ model を空にするか、allowDefaultFallback: true を明示する。",
  );
  error.code = UNKNOWN_MEDIA_MODEL_CODE;
  error.kind = kind;
  error.requestedModel = String(rawModel);
  return error;
}

export function resolveImageModelId(rawModel) {
  return resolveMediaModelId(rawModel, { aliases: IMAGE_MODEL_ALIASES, models: IMAGE_MODELS, defaultModel: DEFAULT_IMAGE_MODEL });
}

export function resolveVideoModelId(rawModel) {
  return resolveMediaModelId(rawModel, { aliases: VIDEO_MODEL_ALIASES, models: VIDEO_MODELS, defaultModel: DEFAULT_VIDEO_MODEL });
}

/**
 * 画像のモデル名を id にする。知らない名前は止める（UNKNOWN_MEDIA_MODEL）。
 * 既定のモデルへの置き換えは allowDefaultFallback: true を明示したときだけ。
 */
export function normalizeImageModel(rawModel, { allowDefaultFallback = false } = {}) {
  const resolved = resolveImageModelId(rawModel);
  if (resolved) return resolved;
  if (allowDefaultFallback) return DEFAULT_IMAGE_MODEL;
  throw unknownMediaModelError("image", rawModel, IMAGE_MODELS, DEFAULT_IMAGE_MODEL);
}

export function isCodexImageModel(rawModel) {
  return resolveImageModelId(rawModel) === "gpt-image-2-codex";
}

export function isGrokImageModel(rawModel) {
  return resolveImageModelId(rawModel) === "grok-imagine-image-hermes";
}

export function normalizeCodexImageCount(value, fallback = 1) {
  const parsed = Number(value);
  const safeFallback = Math.max(1, Math.min(MAX_CODEX_IMAGE_COUNT, Math.round(Number(fallback) || 1)));
  if (!Number.isFinite(parsed)) return safeFallback;
  return Math.max(1, Math.min(MAX_CODEX_IMAGE_COUNT, Math.round(parsed)));
}

export function normalizeGrokGenerationCount(value, fallback = 1) {
  const parsed = Number(value);
  const safeFallback = Math.max(1, Math.min(MAX_GROK_GENERATION_COUNT, Math.round(Number(fallback) || 1)));
  if (!Number.isFinite(parsed)) return safeFallback;
  return Math.max(1, Math.min(MAX_GROK_GENERATION_COUNT, Math.round(parsed)));
}

/**
 * 動画のモデル名を id にする。知らない名前は止める（UNKNOWN_MEDIA_MODEL）。
 * 既定のモデルへの置き換えは allowDefaultFallback: true を明示したときだけ。
 */
export function normalizeVideoModel(rawModel, { allowDefaultFallback = false } = {}) {
  const resolved = resolveVideoModelId(rawModel);
  if (resolved) return resolved;
  if (allowDefaultFallback) return DEFAULT_VIDEO_MODEL;
  throw unknownMediaModelError("video", rawModel, VIDEO_MODELS, DEFAULT_VIDEO_MODEL);
}

/**
 * Whole-second durations an image-to-video request honours exactly for this
 * model id. Unknown ids return [] — a paid pipeline must never be billed for
 * a model it did not ask for (normalizeVideoModel() now throws on unknown
 * names instead of substituting the default). Lovart routes
 * only pass duration as a prompt hint, so they have no exact option.
 */
export function imageToVideoDurationOptions(model) {
  const id = String(model || "");
  if (!VIDEO_MODELS.some((entry) => entry.id === id)) return [];
  if (id === "grok-imagine-video-hermes") return [...GROK_CLI_VIDEO_DURATIONS];
  if (isFalVideoModel(id)) return falVideoDurationOptions(id);
  return [];
}

export function isGrokVideoModel(rawModel) {
  return resolveVideoModelId(rawModel) === "grok-imagine-video-hermes";
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
        // Official Grok CLI (grok-cli-tools); key name kept for compatibility.
        autoDetectsCommand: true,
        grokCliPath: getEnv("GROK_CLI_PATH"),
        grokHome: getEnv("GROK_HOME"),
        apiKeyEnv: "XAI_API_KEY",
      },
      buzzassist: {
        loginEndpoint: "/api/buzzassist/login",
        statusEndpoint: "/api/buzzassist/auth-status",
        // Where the user buys credits / changes plans (desktop app parity:
        // buzzAssistPlanGate.js opens <base>/dashboard).
        dashboardUrl: `${resolveBuzzAssistApiBase()}/dashboard`,
      },
    },
  };
}

// The "hermes" route now runs on the OFFICIAL Grok CLI (sam-mountainman/
// grok-cli-tools — the hermes-grok-tools repo was renamed and the legacy
// Hermes agent stack no longer exists). Internal ids keep the historical
// "hermes" name for scene/model compatibility; everything user-visible says
// Grok. Detection mirrors grok-cli-tools' grok_status: the `grok` binary
// plus ~/.grok/auth.json or XAI_API_KEY/GROK_DEPLOYMENT_KEY.

function getGrokCliHomePath() {
  const configured = getEnv("GROK_HOME");
  if (configured) return configured;
  return join(os.homedir(), ".grok");
}

async function resolveGrokCliCommand() {
  const home = getGrokCliHomePath();
  const candidates = [
    getEnv("GROK_CLI_PATH"),
    getEnv("HERMES_PATH"),
    "grok",
    process.platform === "win32" ? "grok.cmd" : undefined,
    join(home, "bin", "grok"),
    process.platform === "win32" ? join(home, "bin", "grok.exe") : undefined,
    process.platform === "win32" && process.env.APPDATA ? join(process.env.APPDATA, "npm", "grok.cmd") : undefined,
    process.platform === "win32" && process.env.APPDATA ? join(process.env.APPDATA, "npm", "grok.exe") : undefined,
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
  throw new Error(`Grok CLI was not found. Checked:\n${failures.join("\n")}`);
}

async function readGrokCliAuthFile() {
  try {
    const raw = await readFile(join(getGrokCliHomePath(), "auth.json"), "utf8");
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

const GROK_TOKEN_REFRESH_BUFFER_MS = 5 * 60_000;
let grokCredentialRefreshInFlight = null;
let rejectedGrokCliCredential = null;

function grokCredentialExpiryMs(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

// auth.json is keyed by issuer/client id and may contain more than one login.
// Keep each token together with its own expiry/refresh metadata instead of
// deep-searching for an arbitrary string named `token` or `key`.
function findGrokCliAuthSession(value) {
  const candidates = [];
  const visit = (node) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== "object") return;

    const tokenEntry = Object.entries(node).find(
      ([key, child]) =>
        typeof child === "string" &&
        child.trim() &&
        /^(api[_-]?key|apikey|key|token|access[_-]?token)$/i.test(key),
    );
    if (tokenEntry) {
      const token = tokenEntry[1].trim();
      const expiresAt = nonEmptyString(node.expires_at ?? node.expiresAt ?? node.expiry ?? node.expires);
      candidates.push({
        apiKey: token,
        expiresAt: expiresAt || null,
        expiresAtMs: grokCredentialExpiryMs(expiresAt),
        refreshToken: nonEmptyString(node.refresh_token ?? node.refreshToken) || null,
        authMode: nonEmptyString(node.auth_mode ?? node.authMode) || null,
        isStaticApiKey: token.startsWith("xai-"),
      });
    }
    Object.values(node).forEach(visit);
  };
  visit(value);
  if (candidates.length === 0) return null;
  const now = Date.now();
  candidates.sort((left, right) => {
    const score = (candidate) => {
      if (candidate.isStaticApiKey) return Number.MAX_SAFE_INTEGER;
      if (candidate.expiresAtMs && candidate.expiresAtMs > now) return 2_000_000_000_000_000 + candidate.expiresAtMs;
      if (!candidate.expiresAtMs) return 1_000_000_000_000_000;
      return candidate.expiresAtMs;
    };
    return score(right) - score(left);
  });
  return candidates[0];
}

function isGrokCredentialNearExpiry(session, now = Date.now()) {
  return Boolean(
    session &&
      !session.isStaticApiKey &&
      session.expiresAtMs &&
      session.expiresAtMs <= now + GROK_TOKEN_REFRESH_BUFFER_MS,
  );
}

function grokReauthenticationError(cause) {
  const error = new Error(
    "Grokの再ログインが必要です。保存されたOAuthセッションを自動更新できませんでした。AIエージェントに「Grokを再ログインして」と依頼するか、`grok login` を実行してから再試行してください。",
  );
  if (cause) error.cause = cause;
  return error;
}

async function refreshGrokCliCredential(command, { staleToken = "", staleExpiresAt = null } = {}) {
  const readCurrent = async () => findGrokCliAuthSession(await readGrokCliAuthFile());
  const before = await readCurrent();
  if (
    staleToken &&
    before?.apiKey &&
    (before.apiKey !== staleToken || (staleExpiresAt && before.expiresAt !== staleExpiresAt)) &&
    !isGrokCredentialNearExpiry(before)
  ) {
    rejectedGrokCliCredential = null;
    return before;
  }

  if (!grokCredentialRefreshInFlight) {
    grokCredentialRefreshInFlight = runLocalProcess(command, ["models"], { timeoutMs: 60_000 })
      .finally(() => {
        grokCredentialRefreshInFlight = null;
      });
  }
  await grokCredentialRefreshInFlight;

  const after = await readCurrent();
  if (!after?.apiKey || isGrokCredentialNearExpiry(after)) {
    throw new Error("Grok CLI did not return a usable refreshed credential.");
  }
  if (
    staleToken &&
    after.apiKey === staleToken &&
    (!staleExpiresAt || after.expiresAt === staleExpiresAt)
  ) {
    throw new Error("Grok CLI kept the credential that xAI rejected.");
  }
  rejectedGrokCliCredential = null;
  return after;
}

export function isGrokAuthenticationError(status, message = "") {
  const code = Number(status);
  if (code === 401) return true;
  if (code !== 403) return false;
  return /oauth|access token|token.*(?:invalid|expired|validat)|credential|authentication|unauthori[sz]ed/i.test(String(message));
}

export function isRetryableGrokRateLimit(status, message = "") {
  if (Number(status) !== 429) return false;
  return !/quota|credit|billing|payment|plan limit|monthly limit|upgrade/i.test(String(message));
}

function xaiRetryDelayMs(response, attempt) {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(30_000, retryAfter * 1000);
  return Math.min(12_000, 1500 * (2 ** attempt));
}

async function requestXaiJson(creds, endpoint, body, { timeoutMs = 180_000, action = "xAI request", method = "POST" } = {}) {
  const maxAttempts = 3;
  let activeCreds = creds;
  let authenticationRefreshAttempted = false;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetch(`${activeCreds.baseUrl}${endpoint}`, {
        method,
        headers: {
          Authorization: `Bearer ${activeCreds.apiKey}`,
          "user-agent": "buzzassist-excalidraw-canvas/1.0",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new Error(`${action} failed: ${getErrorMessage(error)}`);
    }
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (response.ok) return parsed ?? {};

    const errorField = parsed?.error;
    const message = (errorField && typeof errorField === "object" ? errorField.message : errorField) || text.slice(0, 500);
    if (isGrokAuthenticationError(response.status, message)) {
      if (activeCreds.source === "grok-cli" && !authenticationRefreshAttempted) {
        authenticationRefreshAttempted = true;
        try {
          activeCreds = await resolveXaiCredentials({
            forceRefresh: true,
            staleToken: activeCreds.apiKey,
            staleExpiresAt: activeCreds.expiresAt,
          });
          continue;
        } catch (error) {
          rejectedGrokCliCredential = { token: activeCreds.apiKey, expiresAt: activeCreds.expiresAt };
          throw grokReauthenticationError(error);
        }
      }
      if (activeCreds.source === "grok-cli") {
        rejectedGrokCliCredential = { token: activeCreds.apiKey, expiresAt: activeCreds.expiresAt };
        throw grokReauthenticationError();
      }
      throw new Error("XAI_API_KEYを認証できませんでした。正しいAPIキーを設定してから再試行してください。");
    }
    if (isRetryableGrokRateLimit(response.status, message) && attempt < maxAttempts - 1) {
      await new Promise((resolveRetry) => setTimeout(resolveRetry, xaiRetryDelayMs(response, attempt)));
      continue;
    }
    // xAI rate/usage limits are tied to the SuperGrok / X Premium plan tiers —
    // point the user at the upgrade pages (the UI turns this into a dialog).
    if (response.status === 429 || /rate.?limit|too many requests|quota/i.test(String(message))) {
      throw new Error(
        `Grokのレート制限に達しました（${response.status}）。時間をおいて再試行するか、SuperGrokプラン（https://grok.com/plans）またはX Premium（https://x.com/i/premium_sign_up）へのアップグレードで上限を増やせます。 — ${message}`,
      );
    }
    throw new Error(`${action} failed (${response.status}): ${message}`);
  }
  throw new Error(`${action} failed after retries.`);
}

async function resolveXaiCredentials({ forceRefresh = false, staleToken = "", staleExpiresAt = null } = {}) {
  const baseUrl = (getEnv("XAI_BASE_URL") || "https://api.x.ai/v1").replace(/\/+$/, "");
  const envKey = getEnv("XAI_API_KEY") || getEnv("GROK_DEPLOYMENT_KEY");
  if (envKey) return { apiKey: envKey, baseUrl, source: "env" };
  const auth = await readGrokCliAuthFile();
  let session = auth ? findGrokCliAuthSession(auth) : null;
  if (session?.apiKey && !session.isStaticApiKey) {
    const wasRejected = rejectedGrokCliCredential?.token === session.apiKey;
    if (forceRefresh || wasRejected || isGrokCredentialNearExpiry(session)) {
      try {
        const command = await resolveGrokCliCommand();
        session = await refreshGrokCliCredential(command, {
          staleToken: staleToken || (wasRejected ? rejectedGrokCliCredential.token : ""),
          staleExpiresAt: staleExpiresAt || (wasRejected ? rejectedGrokCliCredential.expiresAt : null),
        });
      } catch (error) {
        rejectedGrokCliCredential = { token: session.apiKey, expiresAt: session.expiresAt };
        throw grokReauthenticationError(error);
      }
    }
  }
  if (session?.apiKey) {
    if (rejectedGrokCliCredential?.token !== session.apiKey) rejectedGrokCliCredential = null;
    return {
      apiKey: session.apiKey,
      baseUrl,
      source: session.isStaticApiKey ? "grok-cli-api-key" : "grok-cli",
      expiresAt: session.expiresAt,
    };
  }
  throw new Error("Grokの認証情報が見つかりません。`grok login` でログインするか、XAI_API_KEY を設定してください。");
}

// Availability probe for the Grok route (canvas hint + setup_hermes_grok —
// tool/endpoint names keep the legacy "hermes" spelling for compatibility).
export async function getHermesStatus() {
  try {
    const command = await resolveGrokCliCommand();
    const envKey = getEnv("XAI_API_KEY") || getEnv("GROK_DEPLOYMENT_KEY");
    if (envKey) return { installed: true, command, session: "logged-in", authentication: "api-key" };
    const auth = await readGrokCliAuthFile();
    const storedSession = auth ? findGrokCliAuthSession(auth) : null;
    if (!storedSession?.apiKey) return { installed: true, command, session: "logged-out" };
    try {
      const creds = await resolveXaiCredentials({
        forceRefresh: rejectedGrokCliCredential?.token === storedSession.apiKey,
        staleToken: rejectedGrokCliCredential?.token || "",
        staleExpiresAt: rejectedGrokCliCredential?.expiresAt || null,
      });
      return {
        installed: true,
        command,
        session: "logged-in",
        authentication: creds.source === "grok-cli-api-key" ? "api-key" : "oauth",
        expiresAt: creds.expiresAt || null,
      };
    } catch (error) {
      return {
        installed: true,
        command,
        session: "logged-out",
        reauthenticationRequired: true,
        error: getErrorMessage(error),
      };
    }
  } catch (error) {
    return { installed: false, session: "logged-out", error: getErrorMessage(error).split("\n")[0] };
  }
}

// Runs `grok login` (opens the browser; the user signs in with X /
// SuperGrok). Meant to be driven by the host agent via setup_hermes_grok.
export async function setupHermesGrok() {
  const before = await getHermesStatus();
  if (!before.installed) {
    throw new Error(
      "Grok CLI is not installed, so login cannot run. Set up https://github.com/sam-mountainman/grok-cli-tools first (its installer puts the `grok` binary on PATH), then call setup_hermes_grok again.",
    );
  }
  if (before.session === "logged-in") {
    return { ...before, action: "already-logged-in" };
  }
  await runLocalProcess(before.command, ["login"], { timeoutMs: 620_000 });
  const after = await getHermesStatus();
  if (after.session !== "logged-in") {
    throw new Error("Grok login did not complete. Ask the user to finish the X sign-in in the opened browser window (or run `grok login --device-auth`), then retry.");
  }
  return { ...after, action: "logged-in" };
}

export async function getBuzzAssistCapability() {
  try {
    return await getBuzzAssistAuthStatus();
  } catch {
    return { loggedIn: false, source: null, userId: null, expiresAt: null };
  }
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

export function normalizeGrokImageResolution(value) {
  const raw = String(value || "").trim().toLowerCase();
  // xAI's Grok image endpoint accepts resolution tiers only. Keep aspect
  // ratio in `aspect_ratio`; GPT-style pixel dimensions (used internally to
  // pick the start-frame shape) must never leak into `resolution`.
  if (raw === "1k" || raw === "2k") return raw;
  if (raw === "4k") return "2k";
  const dimensions = raw.match(/^(\d+)x(\d+)$/);
  if (dimensions) {
    const longestEdge = Math.max(Number(dimensions[1]), Number(dimensions[2]));
    return longestEdge >= 2048 ? "2k" : "1k";
  }
  return "1k";
}

function normalizeHermesImageQuality(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "standard" || raw === "low" || raw === "medium") return "grok-imagine-image";
  return "grok-imagine-image-quality";
}

function normalizeVideoResolution(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "480p" || raw === "720p" || raw === "1080p") return raw;
  return "720p";
}

export function sanitizeGrokVideoDuration(duration) {
  if (duration === undefined || duration === null || String(duration).trim() === "") return 6;
  const raw = String(duration).trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error("Grok CLI video duration must be 6 or 10 seconds.");
  }
  const parsed = Number.parseInt(raw, 10);
  if (!GROK_CLI_VIDEO_DURATIONS.includes(parsed)) {
    throw new Error("Grok CLI video duration must be 6 or 10 seconds.");
  }
  return parsed;
}

function runLocalProcess(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const needsWindowsCommandShell = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(String(command));
    const child = spawn(command, args, {
      cwd: options.cwd || safeProcessCwd(),
      env: options.env || process.env,
      shell: options.shell ?? needsWindowsCommandShell,
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
  if (process.platform === "win32") {
    const result = await runLocalProcess(command, [], {
      shell: process.env.ComSpec || true,
      stdin: JSON.stringify(payload),
      timeoutMs,
    });
    return result.stdout;
  }
  const shell = process.env.SHELL || "/bin/sh";
  const result = await runLocalProcess(shell, ["-lc", command], {
    cwd: getEnv("CODEX_IMAGE_BRIDGE_CWD") || safeProcessCwd(),
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

// (Legacy Hermes-agent helpers removed: the hermes-grok-tools repo was
// renamed to grok-cli-tools. The route talks to api.x.ai with credentials
// refreshed by the official Grok CLI — see resolveXaiCredentials.)

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

async function referenceVideoPathsToDataUrls(paths = []) {
  const result = [];
  for (const value of paths) {
    const filePath = nonEmptyString(value);
    if (!filePath) continue;
    const mimeType = mimeTypeForFile(filePath);
    if (!mimeType.startsWith("video/")) throw new Error(`Reference is not a video: ${filePath}`);
    const buffer = await readFile(filePath);
    result.push(`data:${mimeType};base64,${buffer.toString("base64")}`);
  }
  return result;
}

async function referenceAudioPathsToDataUrls(paths = []) {
  const result = [];
  for (const value of paths) {
    const filePath = nonEmptyString(value);
    if (!filePath) continue;
    const mimeType = mimeTypeForFile(filePath);
    if (!mimeType.startsWith("audio/")) throw new Error(`Reference is not an audio file: ${filePath}`);
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

function normalizeReferenceVideos(values = []) {
  return values
    .map((value) => {
      if (typeof value === "string") return value.trim();
      if (value && typeof value === "object" && typeof value.dataURL === "string") return value.dataURL.trim();
      if (value && typeof value === "object" && typeof value.url === "string") return value.url.trim();
      return "";
    })
    .filter(Boolean);
}

function normalizeReferenceAudios(values = []) {
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

  // Official Grok CLI credentials + direct xAI REST call (the legacy Hermes
  // agent stack, and its Python bridge, no longer exist upstream).
  const creds = await resolveXaiCredentials();
  const referenceImages = [
    ...normalizeReferenceImages(input.referenceImages),
    ...(await referenceImagePathsToDataUrls(input.referenceImagePaths)),
  ].filter(Boolean);
  if (referenceImages.length > 3) {
    throw new Error("Grok Imagine supports up to 3 image references for image edits.");
  }
  const configuredModel = getEnv("GROK_IMAGE_MODEL");
  const model = configuredModel === "grok-imagine-image" || configuredModel === "grok-imagine-image-quality"
    ? configuredModel
    : normalizeHermesImageQuality(input.quality);
  const aspectRatio = normalizeAspectRatio(input.aspectRatio, "1:1");
  const resolution = normalizeGrokImageResolution(input.resolution || input.imageSize);
  const body = { model, prompt: input.prompt, resolution };
  let endpoint = "/images/generations";
  if (referenceImages.length === 1) {
    endpoint = "/images/edits";
    body.image = { url: referenceImages[0], type: "image_url" };
  } else if (referenceImages.length > 1) {
    endpoint = "/images/edits";
    body.images = referenceImages.map((url) => ({ url, type: "image_url" }));
    body.aspect_ratio = aspectRatio;
  } else {
    body.aspect_ratio = aspectRatio;
    body.response_format = "b64_json";
    body.n = 1;
  }
  const result = await requestXaiJson(creds, endpoint, body, { timeoutMs: 240_000, action: "xAI image generation" });
  const first = Array.isArray(result?.data) ? result.data[0] : null;
  const source = first && typeof first === "object"
    ? (first.b64_json ? `data:image/png;base64,${first.b64_json}` : nonEmptyString(first.url))
    : "";
  if (!source) throw new Error("xAI image generation returned no image.");
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

  const creds = await resolveXaiCredentials();
  const body = {
    model: "grok-imagine-video",
    prompt: payload.prompt || "",
    duration: payload.duration || 6,
    resolution: payload.resolution || "720p",
  };
  if (payload.generate_audio !== undefined && payload.generate_audio !== null) {
    body.generate_audio = Boolean(payload.generate_audio);
  }
  let imageUrl = nonEmptyString(payload.image_url);
  const referenceImageUrls = Array.isArray(payload.reference_image_urls) ? payload.reference_image_urls.filter(Boolean) : [];
  const referenceVideoUrls = Array.isArray(payload.reference_video_urls) ? payload.reference_video_urls.filter(Boolean) : [];
  if (imageUrl && (referenceImageUrls.length > 0 || referenceVideoUrls.length > 0)) {
    throw new Error("Grok Imagine Video cannot combine image-to-video and reference-to-video in one request.");
  }
  // The official Grok CLI does not expose a direct text-to-video tool. Its
  // prompt-only video path is image_gen -> image_to_video, so keep the local
  // Grok route aligned with that behavior instead of using xAI's direct T2V
  // REST shape.
  if (!imageUrl && referenceImageUrls.length === 0 && referenceVideoUrls.length === 0) {
    const startImage = await generateHermesGrokImage({
      prompt: payload.prompt,
      aspectRatio: payload.aspect_ratio,
      imageSize: "1K",
      quality: "high",
      fileName: `grok-video-start-${Date.now()}.png`,
    });
    imageUrl = `data:${startImage.mimeType};base64,${startImage.buffer.toString("base64")}`;
  }
  if (payload.aspect_ratio) body.aspect_ratio = payload.aspect_ratio;
  if (imageUrl) {
    body.image = { url: imageUrl };
    delete body.aspect_ratio;
  }
  if (referenceImageUrls.length > 0) body.reference_images = referenceImageUrls.map((url) => ({ url }));
  if (referenceVideoUrls.length > 0) body.reference_videos = referenceVideoUrls.map((url) => ({ url }));

  const submitted = await requestXaiJson(creds, "/videos/generations", body, { timeoutMs: 180_000, action: "xAI video generation" });
  const requestId = nonEmptyString(submitted?.request_id);
  if (!requestId) throw new Error("xAI video generation returned no request_id.");

  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 5000));
    const data = await requestXaiJson(creds, `/videos/${requestId}`, undefined, { method: "GET", timeoutMs: 60_000, action: "xAI video polling" });
    const status = String(data?.status || "").toLowerCase();
    if (status === "done") {
      const url = data?.video && typeof data.video === "object" ? nonEmptyString(data.video.url) : "";
      if (!url) throw new Error("xAI video generation completed without a video URL.");
      return mediaFromSource(url, {
        kind: "video",
        mimeType: "video/mp4",
        fileName: input.fileName || `grok-video-${Date.now()}.mp4`,
      });
    }
    if (status === "failed" || status === "expired") {
      throw new Error(`xAI video generation ${status}.`);
    }
  }
  throw new Error("xAI video generation timed out after 30 minutes.");
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
    resolution: input.resolution || normalizeGrokImageResolution(imageSize),
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
  const duration = sanitizeGrokVideoDuration(input.duration);
  const referenceImageUrls = [
    ...normalizeReferenceImages(input.referenceImages ?? input.reference_images),
    ...(await referenceImagePathsToDataUrls(input.referenceImagePaths ?? input.reference_image_paths)),
  ].filter(Boolean);
  const referenceVideoUrls = [
    ...normalizeReferenceVideos(input.referenceVideos ?? input.reference_videos),
    ...(await referenceVideoPathsToDataUrls(input.referenceVideoPaths ?? input.reference_video_paths)),
  ].filter(Boolean);
  const referenceAudioUrls = [
    ...normalizeReferenceAudios(input.referenceAudios ?? input.reference_audios),
    ...(await referenceAudioPathsToDataUrls(input.referenceAudioPaths ?? input.reference_audio_paths)),
  ].filter(Boolean);
  let imageUrl = nonEmptyString(input.startFrameDataURL ?? input.start_frame_data_url) || nonEmptyString(input.imageUrl ?? input.image_url);
  const startFramePath = nonEmptyString(input.startFramePath ?? input.start_frame_path);
  if (!imageUrl && startFramePath) {
    const mimeType = mimeTypeForFile(startFramePath);
    if (!mimeType.startsWith("image/")) throw new Error("startFramePath must point to an image.");
    const buffer = await readFile(startFramePath);
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
    reference_video_urls: referenceVideoUrls,
    reference_audio_urls: referenceAudioUrls,
    generate_audio: input.generateAudio ?? input.generate_audio,
    fileName: input.fileName || input.videoName || `generated-video-${Date.now()}.mp4`,
  };
}

async function generateImageWithCodexBridge(input) {
  const model = "gpt-image-2-codex";
  const payload = buildImagePayload(input, model);
  const command = resolveExplicitCodexImageBridgeCommand();
  if (command) {
    return mediaFromProviderOutput(await runShellBridge(command, payload, 30 * 60 * 1000), {
      kind: "image",
      mimeType: "image/png",
      fileName: payload.fileName,
    });
  }
  if (isBundledCodexImageBridgeEnabled()) {
    const { generateCodexImage } = await import("../scripts/codex-image-bridge.mjs");
    return mediaFromProviderOutput(await generateCodexImage(payload, {
      shared: true,
      cwd: resolveCodexImageBridgeCwd(),
      model: getEnv("CODEX_IMAGE_BRIDGE_MODEL"),
    }), {
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
    "実行先ChatGPT (Codex)を利用できません。ChatGPTデスクトップアプリまたはCodex CLIをインストールしてサインインしてください。入手先: https://chatgpt.com/ja-JP/codex/ （上級者向け: EXCALIDRAW_GPT_IMAGE_2_CODEX_COMMAND / EXCALIDRAW_GPT_IMAGE_2_CODEX_URL でも指定できます）",
  );
}

function indexedMediaFileName(baseFileName, index, timestamp, fallbackExtension = ".png") {
  const safeBase = sanitizeFileName(baseFileName || `generated-${timestamp}${fallbackExtension}`);
  const extension = extname(safeBase) || fallbackExtension;
  const stem = extname(safeBase) ? safeBase.slice(0, -extname(safeBase).length) : safeBase;
  return index === 0 ? `${stem}${extension}` : `${stem}-${index + 1}${extension}`;
}

function codexImageFileName(baseFileName, index, timestamp) {
  return indexedMediaFileName(baseFileName, index, timestamp, ".png");
}

async function generateCodexImageMedia(input, model) {
  const count = normalizeCodexImageCount(input.imageCount ?? input.image_count);
  const timestamp = Date.now();
  const generated = await Promise.all(
    Array.from({ length: count }, (_, index) => {
      const fileName = codexImageFileName(input.fileName || input.imageName, index, timestamp);
      return generateImageWithCodexBridge({ ...input, model, imageCount: 1, fileName });
    }),
  );
  const normalized = generated.map((media, index) => ({
    ...media,
    kind: "image",
    model,
    fileName: codexImageFileName(input.fileName || input.imageName, index, timestamp),
  }));
  return {
    ...normalized[0],
    ...(normalized.length > 1 ? { extraMedia: normalized.slice(1) } : {}),
  };
}

async function generateIndependentGrokMedia(input, model, kind, generator) {
  const countField = kind === "image"
    ? (input.imageCount ?? input.image_count)
    : (input.videoCount ?? input.video_count);
  const count = normalizeGrokGenerationCount(countField);
  const timestamp = Date.now();
  const fallbackExtension = kind === "video" ? ".mp4" : ".png";
  const baseFileName = input.fileName || (kind === "video" ? input.videoName : input.imageName);
  const outcomes = await runWithConcurrency(
    Array.from({ length: count }, (_, index) => index),
    DEFAULT_MEDIA_BATCH_CONCURRENCY,
    (index) => generator({
      ...input,
      imageCount: 1,
      videoCount: 1,
      fileName: indexedMediaFileName(baseFileName, index, timestamp, fallbackExtension),
    }),
  );
  const generated = outcomes
    .map((outcome, index) => ({ outcome, index }))
    .filter(({ outcome }) => outcome.ok)
    .map(({ outcome, index }) => ({
      ...outcome.value,
      kind,
      model,
      fileName: indexedMediaFileName(baseFileName, index, timestamp, fallbackExtension),
    }));
  const generationErrors = Array.from(new Set(outcomes.filter((outcome) => !outcome.ok).map((outcome) => outcome.error)));
  if (generated.length === 0) {
    throw new Error(generationErrors.join("\n") || `Grok ${kind} generation failed.`);
  }
  return {
    ...generated[0],
    ...(generated.length > 1 ? { extraMedia: generated.slice(1) } : {}),
    ...(generationErrors.length > 0 ? { generationErrors } : {}),
    requestedCount: count,
  };
}

export async function generateImageMedia(input = {}) {
  // 知らないモデル名は止める。既定のモデルへの置き換えは allowDefaultModelFallback を明示したときだけ。
  const model = normalizeImageModel(input.model, { allowDefaultFallback: input.allowDefaultModelFallback === true });
  // 再利用だけの実行（lib/paidCallGuard.mjs）では新しい画を作らない。枠を取る前に止める。
  assertPaidCallAllowed({ route: "image-generation", kind: "image", model });
  // 有料の画像生成は端末全体の枠（lib/machineSlots.mjs の paid-image）の中で行う。プロセスごとの
  // 適応並列だけでは、別のセッションが同時に画像を作ると端末全体で上限を超えていた。
  const media = await withMachineSlot("paid-image", () => (isLovartImageModel(model)
    ? generateLovartImageMedia({ ...input, model })
    : isFalImageModel(model)
      ? generateFalImageMedia({ ...input, model })
      : model === "grok-imagine-image-hermes"
        ? generateIndependentGrokMedia(input, model, "image", (job) => generateHermesGrokImage({ ...job, model }))
        : generateCodexImageMedia({ ...input, model }, model)), { label: `image ${model}` });
  return {
    ...media,
    kind: "image",
    model,
    fileName: sanitizeFileName(media.fileName || input.fileName || `generated-${Date.now()}${extForMimeType(media.mimeType, ".png")}`),
  };
}

/** Release the shared Codex app-server so one-shot CLI commands can exit cleanly. */
export async function disposeMediaGenerationResources() {
  if (!isBundledCodexImageBridgeEnabled()) return;
  const { disposeSharedCodexImageBridges } = await import("../scripts/codex-image-bridge.mjs");
  disposeSharedCodexImageBridges();
}

export async function runWithConcurrency(items, limit, worker, options = {}) {
  const results = new Array(items.length);
  if (items.length === 0) return results;
  const concurrency = Math.max(1, Math.min(Math.round(Number(limit) || 1), items.length));
  const intervalCap = Math.max(1, Math.round(Number(options.intervalCap) || Number.MAX_SAFE_INTEGER));
  const interval = Math.max(0, Math.round(Number(options.interval) || 0));
  const queue = new PQueue({
    concurrency,
    ...(interval > 0 && intervalCap < Number.MAX_SAFE_INTEGER
      ? { intervalCap, interval, carryoverIntervalCount: true }
      : {}),
  });
  const promises = items.map((item, index) => queue.add(async () => {
    try {
      results[index] = { ok: true, value: await worker(item, index) };
    } catch (error) {
      results[index] = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }, { id: nonEmptyString(options.jobId?.(item, index)) || `job-${index + 1}` }));
  await Promise.all(promises);
  await queue.onIdle();
  return results;
}

export async function generateVideoMedia(input = {}) {
  const model = normalizeVideoModel(input.model, { allowDefaultFallback: input.allowDefaultModelFallback === true });
  assertPaidCallAllowed({ route: "video-generation", kind: "video", model });
  const media = isLovartVideoModel(model)
    ? await generateLovartVideoMedia({ ...input, model })
    : isFalVideoModel(model)
      ? await generateFalVideoMedia({ ...input, model })
      : await generateIndependentGrokMedia(input, model, "video", (job) => generateHermesGrokVideo({ ...job, model }));
  return {
    ...media,
    kind: "video",
    model,
    fileName: sanitizeFileName(media.fileName || input.fileName || `generated-video-${Date.now()}${extForMimeType(media.mimeType, ".mp4")}`),
  };
}
