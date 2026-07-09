import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export const SERVER_DISCOVERY_FILE = ".server.json";

let generatedToken = null;

export function getOrCreateMcpToken() {
  const configured = typeof process.env.EXCALIDRAW_MCP_TOKEN === "string" ? process.env.EXCALIDRAW_MCP_TOKEN.trim() : "";
  if (configured) return configured;
  if (!generatedToken) generatedToken = randomUUID();
  process.env.EXCALIDRAW_MCP_TOKEN = generatedToken;
  return generatedToken;
}

export function isMcpAuthRequired() {
  return !/^(0|false|no)$/i.test(String(process.env.EXCALIDRAW_REQUIRE_MCP_AUTH || ""));
}

export function isLocalHostname(hostname) {
  const normalized = String(hostname || "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

export function isLocalHostHeader(hostHeader) {
  const raw = String(hostHeader || "").trim();
  if (!raw) return true;
  const hostname = raw.startsWith("[")
    ? raw.slice(1, raw.indexOf("]"))
    : raw.split(":")[0];
  return isLocalHostname(hostname);
}

function configuredAllowedOrigins() {
  return String(process.env.EXCALIDRAW_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

function isTunnelOriginAllowed(url) {
  if (!/^(1|true|yes)$/i.test(String(process.env.EXCALIDRAW_ALLOW_TUNNEL_ORIGINS || ""))) return false;
  if (url.protocol !== "https:") return false;
  const hostname = url.hostname.toLowerCase();
  return hostname.endsWith(".ngrok-free.dev") || hostname.endsWith(".ngrok.app") || hostname.endsWith(".ngrok.dev");
}

function isWidgetOriginAllowed(url) {
  if (!/^(1|true|yes)$/i.test(String(process.env.EXCALIDRAW_ALLOW_WIDGET_ORIGINS || ""))) return false;
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const hostname = url.hostname.toLowerCase();
  return (
    hostname === "chatgpt.com" ||
    hostname === "claude.ai" ||
    hostname.endsWith(".chatgpt.com") ||
    hostname.endsWith(".oaiusercontent.com") ||
    hostname.endsWith(".openai.com") ||
    hostname.endsWith(".anthropic.com") ||
    hostname.endsWith(".claude.ai")
  );
}

export function isAllowedOrigin(origin, { port } = {}) {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (configuredAllowedOrigins().includes(url.origin)) return true;
    if (isTunnelOriginAllowed(url)) return true;
    if (isWidgetOriginAllowed(url)) return true;
    if (!isLocalHostname(url.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

export function setLocalCorsHeaders(req, res, { port } = {}) {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin, { port })) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "Origin");
  }
  res.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("access-control-allow-headers", "Content-Type, Accept, Authorization, Mcp-Session-Id, X-Upload-Filename");
  res.setHeader("access-control-expose-headers", "Mcp-Session-Id");
}

export function rejectDisallowedOrigin(req, res, { port } = {}) {
  if (isAllowedOrigin(req.headers.origin, { port })) return false;
  res.statusCode = 403;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error: "Origin is not allowed for this local Excalidraw server." }));
  return true;
}

// Local-operator-only guard for endpoints that act on the host machine
// (desktop chat keystroke injection, outbound network probes). When the server
// is exposed through a tunnel, a request carrying a non-local Origin comes from
// a remote browser or a cross-site page — never the operator sitting at the
// Mac. A missing Origin (local CLI, same-origin navigation) is treated as
// local. This blocks remote/CSRF misuse while keeping the local browser and
// local tooling working even while a tunnel is up.
export function isLocalOperatorRequest(req) {
  const origin = req?.headers?.origin;
  if (!origin) return true;
  try {
    return isLocalHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export function rejectRemoteOperator(req, res) {
  if (isLocalOperatorRequest(req)) return false;
  res.statusCode = 403;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error: "このエンドポイントはローカルからのみ利用できます（トンネル経由では無効です）。" }));
  return true;
}

export function hasBearerToken(req, token) {
  if (!token) return true;
  const authorization = String(req.headers.authorization || "");
  return authorization === `Bearer ${token}`;
}

export function rejectMissingBearer(req, res, token) {
  if (!isMcpAuthRequired() || hasBearerToken(req, token)) return false;
  res.statusCode = 401;
  res.setHeader("www-authenticate", "Bearer");
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error: "Missing or invalid Excalidraw MCP bearer token." }));
  return true;
}

export function tunnelAccessToken() {
  return String(process.env.EXCALIDRAW_TUNNEL_ACCESS_TOKEN || "").trim();
}

function parseCookieHeader(header) {
  const cookies = new Map();
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies.set(key, decodeURIComponent(value));
  }
  return cookies;
}

export function handleTunnelAccess(req, res) {
  const token = tunnelAccessToken();
  if (!token) return false;
  if (isLocalHostHeader(req.headers.host)) return false;

  const url = new URL(req.url || "/", "http://127.0.0.1");
  const queryToken = url.searchParams.get("t") || url.searchParams.get("token") || "";
  const cookies = parseCookieHeader(req.headers.cookie);
  if (queryToken === token) {
    res.setHeader("set-cookie", `buzzassist_tunnel_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Secure`);
    url.searchParams.delete("t");
    url.searchParams.delete("token");
    req.url = `${url.pathname}${url.search}${url.hash}`;
    return false;
  }
  if (cookies.get("buzzassist_tunnel_token") === token) return false;

  res.statusCode = 401;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><title>BuzzAssist Canvas Tunnel</title></head>
<body style="font-family:system-ui,-apple-system,BlinkMacSystemFont,sans-serif;padding:32px;line-height:1.6">
  <h1>BuzzAssist Canvas Tunnel</h1>
  <p>このURLは共有トークンが必要です。<code>npm run tunnel:status</code> で表示される <code>Access URL</code> を開いてください。</p>
</body>
</html>`);
  return true;
}

export async function writeServerDiscovery({ canvasDir, projectDir, host = "127.0.0.1", port, token, pid = process.pid }) {
  const baseUrl = `http://${host}:${port}`;
  const payload = {
    version: 1,
    name: "codex-excalidraw-canvas",
    pid,
    host,
    port,
    url: `${baseUrl}/`,
    mcpUrl: `${baseUrl}/mcp`,
    assetsUrl: `${baseUrl}/excalidraw-assets/`,
    projectDir,
    canvasDir,
    token: token || null,
    auth: token ? { type: "bearer", env: "EXCALIDRAW_MCP_TOKEN" } : { type: "none" },
    updatedAt: new Date().toISOString(),
  };
  await mkdir(canvasDir, { recursive: true });
  await writeFile(join(canvasDir, SERVER_DISCOVERY_FILE), `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return payload;
}

export async function readServerDiscovery(canvasDir) {
  try {
    return JSON.parse(await readFile(join(canvasDir, SERVER_DISCOVERY_FILE), "utf8"));
  } catch {
    return null;
  }
}
