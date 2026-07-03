import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { extForMimeType, mimeTypeForFile, nonEmptyString } from "./canvasScene.mjs";

const DEFAULT_LOVART_API_BASE = "https://lgw.lovart.ai";
const LOVART_PATH_PREFIX = "/v1/openapi";
const LOVART_STATE_FILE = join(os.homedir(), ".lovart", "excalidraw-state.json");
const LOVART_CREDENTIALS_FILE = join(os.homedir(), ".lovart", "credentials.json");
const LOVART_PROJECT_NAME = "Codex Excalidraw";
const ARTIFACT_DOWNLOAD_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) LovartAgentSkill/1.0",
  Referer: "https://www.lovart.ai/",
};

// Full Lovart tool catalog (lovartai/lovart-skill SKILL.md).
export const LOVART_IMAGE_MODELS = [
  { id: "lovart-midjourney", label: "Midjourney (Lovart)", tool: "generate_image_midjourney", provider: "midjourney" },
  { id: "lovart-nano-banana-pro", label: "Nano Banana Pro (Lovart)", tool: "generate_image_nano_banana_pro", provider: "nano-banana" },
  { id: "lovart-nano-banana-2", label: "Nano Banana 2 (Lovart)", tool: "generate_image_nano_banana_2", provider: "nano-banana" },
  { id: "lovart-nano-banana-2-lite", label: "Nano Banana 2 Lite (Lovart)", tool: "generate_image_nano_banana_2_lite", provider: "nano-banana" },
  { id: "lovart-nano-banana", label: "Nano Banana (Lovart)", tool: "generate_image_nano_banana", provider: "nano-banana" },
  { id: "lovart-gpt-image-2", label: "GPT Image 2 (Lovart)", tool: "generate_image_gpt_image_2", provider: "openai" },
  { id: "lovart-gpt-image-2-low", label: "GPT Image 2 Low (Lovart)", tool: "generate_image_gpt_image_2_low", provider: "openai" },
  { id: "lovart-gpt-image-2-medium", label: "GPT Image 2 Medium (Lovart)", tool: "generate_image_gpt_image_2_medium", provider: "openai" },
  { id: "lovart-gpt-image-2-high", label: "GPT Image 2 High (Lovart)", tool: "generate_image_gpt_image_2_high", provider: "openai" },
  { id: "lovart-gpt-image-1-5", label: "GPT Image 1.5 (Lovart)", tool: "generate_image_gpt_image_1_5", provider: "openai" },
  { id: "lovart-luma-uni-1", label: "Luma Uni-1 (Lovart)", tool: "generate_image_luma_uni_1", provider: "luma" },
  { id: "lovart-luma-uni-1-max", label: "Luma Uni-1 Max (Lovart)", tool: "generate_image_luma_uni_1_max", provider: "luma" },
  { id: "lovart-flux-2-max", label: "Flux.2 Max (Lovart)", tool: "generate_image_flux_2_max", provider: "flux" },
  { id: "lovart-flux-2-pro", label: "Flux.2 Pro (Lovart)", tool: "generate_image_flux_2_pro", provider: "flux" },
  { id: "lovart-seedream-v5", label: "Seedream 5.0 Lite (Lovart)", tool: "generate_image_seedream_v5", provider: "seedream" },
  { id: "lovart-seedream-v4-5", label: "Seedream 4.5 (Lovart)", tool: "generate_image_seedream_v4_5", provider: "seedream" },
  { id: "lovart-seedream-v4", label: "Seedream 4 (Lovart)", tool: "generate_image_seedream_v4", provider: "seedream" },
  { id: "lovart-ideogram-v4", label: "Ideogram 4 (Lovart)", tool: "generate_image_ideogram_v4", provider: "ideogram" },
];

export const LOVART_VIDEO_MODELS = [
  { id: "lovart-veo-3-1", label: "Veo 3.1 (Lovart)", tool: "generate_video_veo3_1", provider: "veo" },
  { id: "lovart-veo-3-1-fast", label: "Veo 3.1 Fast (Lovart)", tool: "generate_video_veo3_1_fast", provider: "veo" },
  { id: "lovart-veo-3", label: "Veo 3 (Lovart)", tool: "generate_video_veo3", provider: "veo" },
  { id: "lovart-seedance-2", label: "Seedance 2.0 (Lovart)", tool: "generate_video_seedance_v2_0", provider: "seedance" },
  { id: "lovart-seedance-2-fast", label: "Seedance 2.0 Fast (Lovart)", tool: "generate_video_seedance_v2_0_fast", provider: "seedance" },
  { id: "lovart-seedance-2-mini", label: "Seedance 2.0 Mini (Lovart)", tool: "generate_video_seedance_v2_0_mini", provider: "seedance" },
  { id: "lovart-seedance-pro-1-5", label: "Seedance 1.5 Pro (Lovart)", tool: "generate_video_seedance_pro_v1_5", provider: "seedance" },
  { id: "lovart-kling-v3", label: "Kling 3.0 (Lovart)", tool: "generate_video_kling_v3", provider: "kling" },
  { id: "lovart-kling-3-omni", label: "Kling 3.0 Omni (Lovart)", tool: "generate_video_kling_v3_omni", provider: "kling" },
  { id: "lovart-kling-v2-6", label: "Kling 2.6 (Lovart)", tool: "generate_video_kling_v2_6", provider: "kling" },
  { id: "lovart-kling-omni-v1", label: "Kling O1 (Lovart)", tool: "generate_video_kling_omni_v1", provider: "kling" },
  { id: "lovart-hailuo-2-3", label: "Hailuo 2.3 (Lovart)", tool: "generate_video_hailuo_v2_3", provider: "hailuo" },
  { id: "lovart-wan-2-6", label: "Wan 2.6 (Lovart)", tool: "generate_video_wan_v2_6", provider: "wan" },
  { id: "lovart-vidu-q2", label: "Vidu Q2 (Lovart)", tool: "generate_video_vidu_q2", provider: "vidu" },
  { id: "lovart-gemini-omni-flash", label: "Gemini Omni Flash (Lovart)", tool: "generate_video_gemini_omni_flash", provider: "gemini" },
];

export function isLovartImageModel(model) {
  return LOVART_IMAGE_MODELS.some((entry) => entry.id === model);
}

export function isLovartVideoModel(model) {
  return LOVART_VIDEO_MODELS.some((entry) => entry.id === model);
}

function lovartToolForModel(model) {
  const entry = [...LOVART_IMAGE_MODELS, ...LOVART_VIDEO_MODELS].find((candidate) => candidate.id === model);
  return entry?.tool ?? null;
}

function resolveLovartApiBase() {
  return (nonEmptyString(process.env.LOVART_API_BASE) || DEFAULT_LOVART_API_BASE).replace(/\/+$/, "");
}

async function resolveLovartCredentials() {
  const envAccess = nonEmptyString(process.env.LOVART_ACCESS_KEY);
  const envSecret = nonEmptyString(process.env.LOVART_SECRET_KEY);
  if (envAccess && envSecret) return { accessKey: envAccess, secretKey: envSecret };
  try {
    const stored = JSON.parse(await readFile(LOVART_CREDENTIALS_FILE, "utf8"));
    const accessKey = nonEmptyString(stored.access_key ?? stored.accessKey);
    const secretKey = nonEmptyString(stored.secret_key ?? stored.secretKey);
    if (accessKey && secretKey) return { accessKey, secretKey };
  } catch {
    // fall through to the error below
  }
  throw new Error(
    "Lovart credentials are missing. Set LOVART_ACCESS_KEY / LOVART_SECRET_KEY or create ~/.lovart/credentials.json with access_key and secret_key (issued in Lovart's OpenClaw settings).",
  );
}

export async function getLovartAuthStatus() {
  try {
    const { accessKey } = await resolveLovartCredentials();
    return { configured: true, accessKeyPreview: `${accessKey.slice(0, 6)}…${accessKey.slice(-4)}` };
  } catch {
    return { configured: false };
  }
}

function signLovartRequest(secretKey, accessKey, method, path) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", secretKey).update(`${method}\n${path}\n${timestamp}`).digest("hex");
  return {
    "X-Access-Key": accessKey,
    "X-Timestamp": timestamp,
    "X-Signature": signature,
    "X-Signed-Method": method,
    "X-Signed-Path": path,
  };
}

async function lovartRequest(method, path, { body, params, timeoutMs = 60_000, retries } = {}) {
  const { accessKey, secretKey } = await resolveLovartCredentials();
  const maxAttempts = retries ?? (method === "GET" ? 3 : 1);
  const idempotencyKey = method === "POST" ? randomUUID().replaceAll("-", "") : null;
  let url = `${resolveLovartApiBase()}${path}`;
  if (params) url += `?${new URLSearchParams(params)}`;

  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = {
        ...signLovartRequest(secretKey, accessKey, method, path),
        "Content-Type": "application/json",
        "User-Agent": ARTIFACT_DOWNLOAD_HEADERS["User-Agent"],
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      };
      const response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        if ([404, 429, 502, 503].includes(response.status) && attempt < maxAttempts - 1) {
          lastError = new Error(`Lovart API ${response.status}`);
          await new Promise((resolveSleep) => setTimeout(resolveSleep, 2000 * (attempt + 1)));
          continue;
        }
        let message = `Lovart API HTTP ${response.status}`;
        try {
          const payload = JSON.parse(text);
          message = payload.message || payload.error || message;
          if (payload.details) message += `: ${payload.details}`;
        } catch {
          if (text) message += `: ${text.slice(0, 300)}`;
        }
        throw new Error(message);
      }
      const payload = text ? JSON.parse(text) : {};
      if (payload && typeof payload === "object" && (payload.code ?? 0) !== 0) {
        throw new Error(payload.message || `Lovart API error code ${payload.code}`);
      }
      return payload?.data ?? payload;
    } catch (error) {
      if (error?.name === "AbortError") {
        lastError = new Error("Lovart API request timed out.");
      } else if (error instanceof TypeError && attempt < maxAttempts - 1) {
        lastError = error;
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 2000 * (attempt + 1)));
        continue;
      } else {
        throw error;
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError ?? new Error("Lovart API request failed.");
}

async function readLovartState() {
  try {
    return JSON.parse(await readFile(LOVART_STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function writeLovartState(state) {
  await mkdir(dirname(LOVART_STATE_FILE), { recursive: true });
  await writeFile(LOVART_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

async function ensureLovartProject() {
  const state = await readLovartState();
  const existing = nonEmptyString(state.project_id);
  if (existing) {
    try {
      const validation = await lovartRequest("GET", `${LOVART_PATH_PREFIX}/project/validate`, {
        params: { project_id: existing },
      });
      if (validation?.valid !== false) return existing;
    } catch {
      // Recreate below when validation fails.
    }
  }
  const created = await lovartRequest("POST", `${LOVART_PATH_PREFIX}/project/save`, {
    body: {
      project_id: "",
      canvas: "",
      project_cover_list: [],
      pic_count: 0,
      project_type: 3,
      project_name: LOVART_PROJECT_NAME,
    },
  });
  const projectId = nonEmptyString(created?.project_id);
  if (!projectId) throw new Error("Lovart project creation returned no project_id.");
  await writeLovartState({ ...state, project_id: projectId });
  return projectId;
}

export async function uploadLovartFile(localPath) {
  const { accessKey, secretKey } = await resolveLovartCredentials();
  const fileData = await readFile(localPath);
  const boundary = randomUUID().replaceAll("-", "");
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${basename(localPath)}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const path = `${LOVART_PATH_PREFIX}/file/upload`;
  const response = await fetch(`${resolveLovartApiBase()}${path}`, {
    method: "POST",
    headers: {
      ...signLovartRequest(secretKey, accessKey, "POST", path),
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "User-Agent": ARTIFACT_DOWNLOAD_HEADERS["User-Agent"],
    },
    body: Buffer.concat([head, fileData, tail]),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.code !== 0) {
    throw new Error(`Lovart file upload failed: ${payload?.message ?? response.status}`);
  }
  const url = nonEmptyString(payload.data?.url);
  if (!url) throw new Error("Lovart file upload returned no URL.");
  return url;
}

function collectArtifacts(result, kind) {
  const artifacts = [];
  for (const item of result?.items ?? []) {
    for (const artifact of item?.artifacts ?? []) {
      const url = nonEmptyString(artifact?.content);
      if (!url) continue;
      artifacts.push({ url, type: String(artifact.type || "unknown") });
    }
  }
  const wanted = artifacts.filter((artifact) =>
    kind === "video" ? artifact.type === "video" || /\.(mp4|mov|webm)(\?|$)/i.test(artifact.url) : artifact.type !== "video",
  );
  return wanted.length > 0 ? wanted : artifacts;
}

async function downloadLovartArtifact(url, kind) {
  const response = await fetch(url, { headers: ARTIFACT_DOWNLOAD_HEADERS });
  if (!response.ok) throw new Error(`Failed to download Lovart artifact: ${response.status}`);
  const headerMime = response.headers.get("content-type")?.split(";")[0];
  const extension = extname(new URL(url).pathname);
  const mimeType =
    headerMime && headerMime !== "application/octet-stream"
      ? headerMime
      : extension
        ? mimeTypeForFile(`artifact${extension}`)
        : kind === "video"
          ? "video/mp4"
          : "image/png";
  return { buffer: Buffer.from(await response.arrayBuffer()), mimeType };
}

function buildLovartPrompt(input, kind) {
  const hints = [];
  const aspectRatio = nonEmptyString(input.aspectRatio ?? input.aspect_ratio);
  if (aspectRatio) hints.push(`aspect ratio ${aspectRatio}`);
  if (kind === "video") {
    const duration = Number.parseInt(String(input.duration ?? ""), 10);
    if (Number.isFinite(duration) && duration > 0) hints.push(`duration about ${duration} seconds`);
    const resolution = nonEmptyString(input.resolution);
    if (resolution) hints.push(`resolution ${resolution}`);
  }
  const prompt = String(input.prompt).trim();
  if (hints.length === 0) return prompt;
  return `${prompt}\n\n(${hints.join(", ")}. Generate exactly one ${kind}.)`;
}

// pending_confirmation is the only place Lovart quotes a credit cost — pull
// any numeric *cost* field out of it so callers can report what was approved.
function extractLovartEstimatedCost(result) {
  const seen = new Set();
  const walk = (value) => {
    if (!value || typeof value !== "object" || seen.has(value)) return null;
    seen.add(value);
    for (const [key, entry] of Object.entries(value)) {
      if (/cost|credit/i.test(key)) {
        const parsed = Number.parseFloat(String(entry));
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
      }
      const nested = walk(entry);
      if (nested !== null) return nested;
    }
    return null;
  };
  return walk(result);
}

async function pollLovartThread(threadId, { timeoutMs, autoConfirm, onStatus, onEstimatedCost }) {
  const deadline = Date.now() + timeoutMs;
  let confirmedOnce = false;
  while (Date.now() < deadline) {
    const status = await lovartRequest("GET", `${LOVART_PATH_PREFIX}/chat/status`, {
      params: { thread_id: threadId },
      timeoutMs: 30_000,
    });
    const state = String(status?.status ?? "").toLowerCase();
    if (typeof onStatus === "function") onStatus(state);
    if (state === "abort") throw new Error("Lovart generation was aborted.");
    if (state === "done") {
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 5000));
      const recheck = await lovartRequest("GET", `${LOVART_PATH_PREFIX}/chat/status`, {
        params: { thread_id: threadId },
        timeoutMs: 30_000,
      });
      if (String(recheck?.status ?? "").toLowerCase() !== "done") continue;
      const result = await lovartRequest("GET", `${LOVART_PATH_PREFIX}/chat/result`, {
        params: { thread_id: threadId },
        timeoutMs: 60_000,
      });
      if (result?.pending_confirmation) {
        const estimatedCost = extractLovartEstimatedCost(result);
        if (estimatedCost !== null && typeof onEstimatedCost === "function") onEstimatedCost(estimatedCost);
        if (!autoConfirm || confirmedOnce) {
          throw new Error(
            `Lovart is waiting for a credit confirmation (thread ${threadId})${estimatedCost !== null ? ` — estimated cost ${estimatedCost} credits` : ""}. Re-run with autoConfirmCredits=true to approve the estimated cost.`,
          );
        }
        confirmedOnce = true;
        await lovartRequest("POST", `${LOVART_PATH_PREFIX}/chat/confirm`, { body: { thread_id: threadId } });
        continue;
      }
      return result;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 3000));
  }
  throw new Error("Lovart generation timed out. Check the Lovart canvas for the result.");
}

async function generateLovartMedia(input, kind) {
  const prompt = nonEmptyString(input.prompt);
  if (!prompt) throw new Error("prompt is required.");
  const model = String(input.model);
  const tool = lovartToolForModel(model);
  const projectId = await ensureLovartProject();

  const attachments = [];
  const referencePaths = [
    ...(Array.isArray(input.referenceImagePaths) ? input.referenceImagePaths : []),
    ...(kind === "video" && nonEmptyString(input.startFramePath) ? [input.startFramePath] : []),
  ];
  for (const referencePath of referencePaths) {
    attachments.push(await uploadLovartFile(referencePath));
  }

  const body = {
    prompt: buildLovartPrompt({ ...input, prompt }, kind),
    project_id: projectId,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(tool ? { tool_config: { include_tools: [tool] } } : {}),
  };
  const sent = await lovartRequest("POST", `${LOVART_PATH_PREFIX}/chat`, { body, timeoutMs: 120_000 });
  const threadId = nonEmptyString(sent?.thread_id ?? sent);
  if (!threadId) throw new Error("Lovart chat returned no thread_id.");

  let estimatedCostCredits = null;
  const result = await pollLovartThread(threadId, {
    timeoutMs: kind === "video" ? 25 * 60 * 1000 : 10 * 60 * 1000,
    autoConfirm: input.autoConfirmCredits !== false,
    onEstimatedCost: (cost) => {
      estimatedCostCredits = cost;
    },
  });

  const artifacts = collectArtifacts(result, kind);
  if (artifacts.length === 0) {
    const agentMessage = nonEmptyString(result?.agent_message) || nonEmptyString(result?.warning);
    throw new Error(
      agentMessage
        ? `Lovart returned no ${kind}: ${agentMessage}`
        : `Lovart returned no ${kind} artifact. The model may have refused the prompt.`,
    );
  }
  const artifact = artifacts.at(-1);
  const media = await downloadLovartArtifact(artifact.url, kind);
  const extension = extForMimeType(media.mimeType, kind === "video" ? ".mp4" : ".png");
  return {
    kind,
    model,
    mimeType: media.mimeType,
    buffer: media.buffer,
    fileName: input.fileName || `lovart-${Date.now()}${extension}`,
    source: artifact.url,
    lovart: {
      threadId,
      projectId,
      canvasUrl: `https://www.lovart.ai/canvas?projectId=${projectId}`,
      ...(estimatedCostCredits !== null ? { estimatedCostCredits } : {}),
    },
  };
}

export async function generateLovartImageMedia(input = {}) {
  return generateLovartMedia(input, "image");
}

export async function generateLovartVideoMedia(input = {}) {
  return generateLovartMedia(input, "video");
}

export async function saveLovartCredentials({ accessKey, secretKey }) {
  const access = nonEmptyString(accessKey);
  const secret = nonEmptyString(secretKey);
  if (!access || !secret) throw new Error("accessKey and secretKey are both required.");
  if (!access.startsWith("ak_") || !secret.startsWith("sk_")) {
    throw new Error("Lovart keys look wrong: access key starts with ak_, secret key with sk_.");
  }
  await mkdir(dirname(LOVART_CREDENTIALS_FILE), { recursive: true });
  await writeFile(
    LOVART_CREDENTIALS_FILE,
    `${JSON.stringify({ access_key: access, secret_key: secret }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return getLovartAuthStatus();
}
