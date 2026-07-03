import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import { dirname, join } from "node:path";
import crypto from "node:crypto";

export const DEFAULT_BUZZASSIST_API_BASE = "https://buzzassist.ai";
const AUTH_CALLBACK_PATH = "/buzzassist-auth";
const AUTH_FILE_NAME = "excalidraw-media-auth.json";
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

export function resolveBuzzAssistApiBase() {
  const configured = String(process.env.BUZZASSIST_API_BASE || process.env.BUZZASSIST_API_URL || "").trim();
  return (configured || DEFAULT_BUZZASSIST_API_BASE).replace(/\/+$/, "");
}

export function resolveFalProxyUrl() {
  const configured = String(process.env.BUZZASSIST_FAL_PROXY_URL || "").trim();
  return configured || `${resolveBuzzAssistApiBase()}/api/fal/proxy`;
}

export function resolveSubtitleCreditsUrl() {
  return `${resolveBuzzAssistApiBase()}/api/subtitle/credits`;
}

export function resolveSubtitleGenerateUrl() {
  return `${resolveBuzzAssistApiBase()}/api/subtitle/generate`;
}

export function resolveAuthFilePath() {
  const configured = String(process.env.BUZZASSIST_AUTH_FILE || "").trim();
  if (configured) return configured;
  return join(os.homedir(), ".buzzassist", AUTH_FILE_NAME);
}

function decodeTokenClaims(token) {
  const match = /^v1\.([A-Za-z0-9\-_]+)\.([A-Za-z0-9\-_]+)$/.exec(String(token || "").trim());
  if (!match) return null;
  try {
    const normalized = match[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const claims = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    return claims && typeof claims === "object" ? claims : null;
  } catch {
    return null;
  }
}

async function writeJsonAtomic(filePath, payload) {
  await mkdir(dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempFile, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await rename(tempFile, filePath);
}

export async function loadStoredAuth() {
  try {
    const parsed = JSON.parse(await readFile(resolveAuthFilePath(), "utf8"));
    if (parsed && typeof parsed.token === "string" && parsed.token.trim()) return parsed;
    return null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function saveStoredAuth({ token, expiresAt }) {
  const claims = decodeTokenClaims(token);
  await writeJsonAtomic(resolveAuthFilePath(), {
    token,
    expiresAt: Number(expiresAt) || claims?.exp || null,
    userId: claims?.sub || null,
    apiBase: resolveBuzzAssistApiBase(),
    savedAt: new Date().toISOString(),
  });
}

export async function clearStoredAuth() {
  try {
    await writeJsonAtomic(resolveAuthFilePath(), { token: null, clearedAt: new Date().toISOString() });
  } catch {
    // Clearing best-effort; a missing directory means nothing to clear.
  }
}

export async function getBuzzAssistAuthStatus() {
  const envToken = String(process.env.BUZZASSIST_MEDIA_TOKEN || process.env.BUZZASSIST_TOKEN || "").trim();
  const stored = envToken ? null : await loadStoredAuth();
  const token = envToken || stored?.token || null;
  if (!token) {
    return { loggedIn: false, source: null, userId: null, expiresAt: null };
  }
  const claims = decodeTokenClaims(token);
  const expiresAt = claims?.exp ?? stored?.expiresAt ?? null;
  const expired = typeof expiresAt === "number" && expiresAt * (expiresAt < 1e12 ? 1000 : 1) <= Date.now();
  return {
    loggedIn: !expired,
    expired,
    source: envToken ? "env" : "file",
    userId: claims?.sub ?? stored?.userId ?? null,
    expiresAt,
    authFile: envToken ? null : resolveAuthFilePath(),
  };
}

export async function requireBuzzAssistToken() {
  const status = await getBuzzAssistAuthStatus();
  const envToken = String(process.env.BUZZASSIST_MEDIA_TOKEN || process.env.BUZZASSIST_TOKEN || "").trim();
  if (envToken && status.loggedIn) return envToken;
  const stored = await loadStoredAuth();
  if (stored?.token && status.loggedIn) return stored.token;
  throw new Error(
    status.expired
      ? "BuzzAssist login has expired. Run the buzzassist_login MCP tool (or GET /api/buzzassist/login on the canvas server) to sign in again."
      : "BuzzAssist login is required for this model. Run the buzzassist_login MCP tool (or GET /api/buzzassist/login on the canvas server) to sign in, or set BUZZASSIST_MEDIA_TOKEN.",
  );
}

export function buildBuzzAssistAuthHeaders(token) {
  return token ? { "x-media-service-token": token } : {};
}

function openInBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function buildLoginUrl({ callbackPort, state }) {
  const callbackUri = `http://127.0.0.1:${callbackPort}${AUTH_CALLBACK_PATH}?state=${encodeURIComponent(state)}`;
  const url = new URL(`${resolveBuzzAssistApiBase()}/api/desktop/auth`);
  url.searchParams.set("callback_uri", callbackUri);
  return url.toString();
}

const LOGIN_SUCCESS_HTML = `<!doctype html><meta charset="utf-8"><title>BuzzAssist Login</title><body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h1 style="font-size:20px">ログインが完了しました</h1><p>このタブを閉じて、エージェントに戻ってください。</p></div></body>`;
const LOGIN_FAILURE_HTML = `<!doctype html><meta charset="utf-8"><title>BuzzAssist Login</title><body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h1 style="font-size:20px">ログインに失敗しました</h1><p>エージェント側のエラーメッセージを確認してください。</p></div></body>`;

export async function loginBuzzAssistViaBrowser({ openBrowser = true, timeoutMs = LOGIN_TIMEOUT_MS, onAuthUrl } = {}) {
  const state = crypto.randomBytes(16).toString("hex");

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const server = createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== AUTH_CALLBACK_PATH) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      const finishRequest = (html) => {
        res.statusCode = 200;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(html);
      };
      if (url.searchParams.get("state") !== state) {
        finishRequest(LOGIN_FAILURE_HTML);
        return finish(new Error("BuzzAssist login callback state mismatch."));
      }
      const callbackError = url.searchParams.get("error");
      if (callbackError) {
        finishRequest(LOGIN_FAILURE_HTML);
        return finish(new Error(`BuzzAssist login was not completed: ${callbackError}`));
      }
      const token = url.searchParams.get("token");
      if (!token) {
        finishRequest(LOGIN_FAILURE_HTML);
        return finish(new Error("BuzzAssist login callback did not include a token."));
      }
      finishRequest(LOGIN_SUCCESS_HTML);
      const expiresAt = Number(url.searchParams.get("expires_at")) || undefined;
      saveStoredAuth({ token, expiresAt })
        .then(() => finish(null, { token, expiresAt, userId: decodeTokenClaims(token)?.sub ?? null }))
        .catch((error) => finish(error));
    });

    const timeout = setTimeout(() => {
      finish(new Error(`BuzzAssist login timed out after ${Math.round(timeoutMs / 60000)} minutes.`));
    }, timeoutMs);

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      setTimeout(() => server.close(), 250);
      if (error) rejectPromise(error);
      else resolvePromise(result);
    }

    server.on("error", (error) => finish(error));
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const authUrl = buildLoginUrl({ callbackPort: port, state });
      if (typeof onAuthUrl === "function") onAuthUrl(authUrl);
      if (openBrowser) openInBrowser(authUrl);
    });
  });
}

function describeBillingError(status, payload) {
  if (status === 401) {
    return "BuzzAssist rejected the media token (401). Run buzzassist_login again.";
  }
  if (status === 402 || payload?.billing?.code === "insufficient_credits") {
    const required = payload?.requiredCredits ? ` Required credits: ${payload.requiredCredits}.` : "";
    return `BuzzAssist credits or plan are insufficient (402).${required} Purchase credits or upgrade the plan at ${resolveBuzzAssistApiBase()}.`;
  }
  if (status === 429) {
    return "BuzzAssist rate limit reached (429). Wait a moment and retry.";
  }
  return null;
}

export async function buzzAssistFetch(url, { method = "POST", headers = {}, body, signal, timeoutMs = 180_000 } = {}) {
  const token = await requireBuzzAssistToken();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });
  try {
    const response = await fetch(url, {
      method,
      headers: { ...buildBuzzAssistAuthHeaders(token), ...headers },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      const payload = await response.clone().json().catch(() => null);
      const billingMessage = describeBillingError(response.status, payload);
      if (billingMessage) throw new Error(billingMessage);
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

export async function falFetch(targetUrl, { method = "POST", headers = {}, body, signal, timeoutMs = 180_000 } = {}) {
  return buzzAssistFetch(resolveFalProxyUrl(), {
    method,
    headers: {
      "content-type": "application/json",
      "x-fal-target-url": targetUrl,
      ...headers,
    },
    body,
    signal,
    timeoutMs,
  });
}

async function readJsonOrThrow(response, label) {
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const message = typeof payload?.error === "string" ? payload.error : text.slice(0, 500) || response.statusText;
    throw new Error(`${label} failed (${response.status}): ${message}`);
  }
  if (!payload || typeof payload !== "object") {
    throw new Error(`${label} returned no JSON payload.`);
  }
  return payload;
}

const QUEUE_FAILURE_STATUSES = new Set(["FAILED", "CANCELLED", "NOT_FOUND"]);

export async function runFalQueueRequest(endpoint, payload, { pollIntervalMs = 3000, timeoutMs = 30 * 60 * 1000, onStatus } = {}) {
  const submitUrl = `https://queue.fal.run/${endpoint.replace(/^\/+/, "")}`;
  const acceptance = await readJsonOrThrow(
    await falFetch(submitUrl, { body: JSON.stringify(payload), timeoutMs: 120_000 }),
    `fal queue submit ${endpoint}`,
  );
  const statusUrl = typeof acceptance.status_url === "string" ? acceptance.status_url : null;
  const responseUrl = typeof acceptance.response_url === "string" ? acceptance.response_url : null;
  if (!statusUrl || !responseUrl) {
    throw new Error(`fal queue submit ${endpoint} returned no status_url/response_url.`);
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolveSleep) => setTimeout(resolveSleep, pollIntervalMs));
    const status = await readJsonOrThrow(
      await falFetch(statusUrl, { method: "GET", timeoutMs: 60_000 }),
      `fal queue status ${endpoint}`,
    );
    const state = String(status.status || "").toUpperCase();
    if (typeof onStatus === "function") onStatus(state, status);
    if (QUEUE_FAILURE_STATUSES.has(state)) {
      const detail = typeof status.error === "string" ? `: ${status.error}` : "";
      throw new Error(`fal queue request ${endpoint} ${state.toLowerCase()}${detail}`);
    }
    if (state === "COMPLETED") {
      return readJsonOrThrow(
        await falFetch(responseUrl, { method: "GET", timeoutMs: 120_000 }),
        `fal queue result ${endpoint}`,
      );
    }
  }
  throw new Error(`fal queue request ${endpoint} timed out after ${Math.round(timeoutMs / 60000)} minutes.`);
}

export async function runFalSyncRequest(endpoint, payload, { timeoutMs = 10 * 60 * 1000 } = {}) {
  const targetUrl = `https://fal.run/${endpoint.replace(/^\/+/, "")}`;
  return readJsonOrThrow(
    await falFetch(targetUrl, { body: JSON.stringify(payload), timeoutMs }),
    `fal request ${endpoint}`,
  );
}

const FAL_STORAGE_INITIATE_URL = "https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3";
const FAL_STORAGE_INITIATE_MULTIPART_URL = "https://rest.fal.ai/storage/upload/initiate-multipart?storage_type=fal-cdn-v3";
const FAL_STORAGE_MULTIPART_THRESHOLD_BYTES = 90 * 1024 * 1024;
const FAL_STORAGE_MULTIPART_CHUNK_BYTES = 10 * 1024 * 1024;
const FAL_INPUT_OBJECT_LIFECYCLE = JSON.stringify({ expiration_duration_seconds: 24 * 60 * 60 });

async function initiateFalStorageUpload({ mimeType, fileName, multipart }) {
  const initiate = await readJsonOrThrow(
    await falFetch(multipart ? FAL_STORAGE_INITIATE_MULTIPART_URL : FAL_STORAGE_INITIATE_URL, {
      headers: { "x-fal-object-lifecycle": FAL_INPUT_OBJECT_LIFECYCLE },
      body: JSON.stringify({ content_type: mimeType, file_name: fileName }),
      timeoutMs: 60_000,
    }),
    "fal storage initiate",
  );
  const uploadUrl = typeof initiate.upload_url === "string" ? initiate.upload_url : null;
  const fileUrl = typeof initiate.file_url === "string" ? initiate.file_url : null;
  if (!uploadUrl || !fileUrl) throw new Error("fal storage initiate returned no upload_url/file_url.");
  return { uploadUrl, fileUrl };
}

async function putFalStorageObject(uploadUrl, buffer, mimeType) {
  const putResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "content-type": mimeType },
    body: buffer,
  });
  if (!putResponse.ok) {
    throw new Error(`fal storage upload failed (${putResponse.status}): ${(await putResponse.text()).slice(0, 300)}`);
  }
}

function multipartPartUrl(uploadUrl, partNumber) {
  const url = new URL(uploadUrl);
  return `${url.origin}${url.pathname}/${partNumber}${url.search}`;
}

async function putFalStorageMultipartPart(uploadUrl, chunk, partNumber) {
  const response = await fetch(multipartPartUrl(uploadUrl, partNumber), { method: "PUT", body: chunk });
  if (!response.ok) {
    throw new Error(`fal storage multipart part ${partNumber} failed (${response.status}).`);
  }
  const payload = await response.clone().json().catch(() => null);
  const etag = payload?.etag || response.headers.get("etag") || "";
  if (!etag) throw new Error(`fal storage multipart part ${partNumber} returned no etag.`);
  return { etag, partNumber };
}

async function completeFalStorageMultipartUpload(uploadUrl, parts) {
  const url = new URL(uploadUrl);
  const completeUrl = `${url.origin}${url.pathname}/complete${url.search}`;
  const response = await fetch(completeUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parts }),
  });
  if (!response.ok) {
    throw new Error(`fal storage multipart complete failed (${response.status}).`);
  }
}

export async function uploadBufferToFalStorage(buffer, { mimeType = "application/octet-stream", fileName = "upload.bin" } = {}) {
  const multipart = buffer.length > FAL_STORAGE_MULTIPART_THRESHOLD_BYTES;
  const { uploadUrl, fileUrl } = await initiateFalStorageUpload({ mimeType, fileName, multipart });
  if (!multipart) {
    await putFalStorageObject(uploadUrl, buffer, mimeType);
    return fileUrl;
  }
  const parts = [];
  for (let offset = 0, partNumber = 1; offset < buffer.length; offset += FAL_STORAGE_MULTIPART_CHUNK_BYTES, partNumber += 1) {
    const chunk = buffer.subarray(offset, Math.min(offset + FAL_STORAGE_MULTIPART_CHUNK_BYTES, buffer.length));
    parts.push(await putFalStorageMultipartPart(uploadUrl, chunk, partNumber));
  }
  await completeFalStorageMultipartUpload(uploadUrl, parts);
  return fileUrl;
}
