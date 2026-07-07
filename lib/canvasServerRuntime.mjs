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

export function isAllowedOrigin(origin, { port } = {}) {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (configuredAllowedOrigins().includes(url.origin)) return true;
    if (isTunnelOriginAllowed(url)) return true;
    if (!isLocalHostname(url.hostname)) return false;
    if (port && url.port && url.port !== String(port)) return false;
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
