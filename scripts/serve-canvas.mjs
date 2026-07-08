#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import net from "node:net";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRemoteCanvasRelayClient,
  createRemoteCanvasSession,
} from "../lib/remoteCanvasRelayClient.mjs";
import { handleTunnelAccess } from "../lib/canvasServerRuntime.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);

function readArg(name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

function hasArg(name) {
  return argv.includes(name);
}

const host = readArg("--host", process.env.EXCALIDRAW_HOST || "127.0.0.1");
const requestedPort = Number(readArg("--port", process.env.EXCALIDRAW_PORT || "43219"));
const strictPort = hasArg("--strict-port") || /^(1|true|yes)$/i.test(String(process.env.EXCALIDRAW_STRICT_PORT || ""));
const valueArgs = new Set([
  "--port",
  "--host",
  "--remote-canvas-url",
  "--remote-canvas-session",
  "--remote-canvas-token",
  "--remote-canvas-title",
  "--remote-canvas-mode",
  "--remote-canvas-expires-hours",
]);
const projectArg = argv.find((arg, index) => !arg.startsWith("--") && !valueArgs.has(argv[index - 1]));
const projectDir = resolve(process.env.EXCALIDRAW_PROJECT_DIR || projectArg || process.cwd());
const canvasDir = resolve(process.env.EXCALIDRAW_CANVAS_DIR || join(projectDir, "canvas"));
const distDir = resolve(process.env.EXCALIDRAW_DIST_DIR || join(repoRoot, "dist"));
const remoteCanvasRequested =
  hasArg("--remote-canvas") ||
  /^(1|true|yes)$/i.test(String(process.env.BUZZASSIST_REMOTE_CANVAS || "")) ||
  Boolean(process.env.BUZZASSIST_REMOTE_CANVAS_SESSION_ID && process.env.BUZZASSIST_REMOTE_CANVAS_DESKTOP_TOKEN);
const remoteCanvasBaseUrl = readArg(
  "--remote-canvas-url",
  process.env.BUZZASSIST_REMOTE_CANVAS_BASE_URL || process.env.BUZZASSIST_REMOTE_CANVAS_URL || ""
);
const remoteCanvasSessionArg = readArg("--remote-canvas-session", process.env.BUZZASSIST_REMOTE_CANVAS_SESSION_ID || "");
const remoteCanvasTokenArg = readArg("--remote-canvas-token", process.env.BUZZASSIST_REMOTE_CANVAS_DESKTOP_TOKEN || "");
const remoteCanvasTitle = readArg("--remote-canvas-title", process.env.BUZZASSIST_REMOTE_CANVAS_TITLE || "BuzzAssist Remote Canvas");
const remoteCanvasMode = readArg("--remote-canvas-mode", process.env.BUZZASSIST_REMOTE_CANVAS_MODE || "generate");
const remoteCanvasExpiresHours = Number(readArg("--remote-canvas-expires-hours", process.env.BUZZASSIST_REMOTE_CANVAS_EXPIRES_HOURS || "24"));

function canListen(port) {
  return new Promise((resolveCanListen) => {
    const probe = net.createServer();
    probe.once("error", () => resolveCanListen(false));
    probe.once("listening", () => {
      probe.close(() => resolveCanListen(true));
    });
    probe.listen(port, host);
  });
}

async function resolvePort() {
  if (!Number.isFinite(requestedPort) || requestedPort <= 0) return 0;
  if (await canListen(requestedPort)) return requestedPort;
  if (strictPort) throw new Error(`Port ${requestedPort} is already in use.`);
  for (let port = requestedPort + 1; port < requestedPort + 100; port += 1) {
    if (await canListen(port)) return port;
  }
  return 0;
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: "inherit", shell: process.platform === "win32", ...options });
    child.on("error", rejectRun);
    child.on("close", (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

async function ensureBuiltAssets() {
  try {
    await access(join(distDir, "index.html"));
    return;
  } catch {
    // Source checkouts build on demand; installed packages should already ship dist/.
  }
  if (/^(0|false|no)$/i.test(String(process.env.EXCALIDRAW_AUTO_BUILD || ""))) {
    throw new Error(`Missing ${join(distDir, "index.html")}. Run npm run build first.`);
  }
  await run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], { cwd: repoRoot });
}

function createMiddlewareStack() {
  const layers = [];
  return {
    use(route, handler) {
      if (typeof route === "function") {
        layers.push({ route: null, handler: route });
      } else {
        layers.push({ route, handler });
      }
    },
    handle(req, res) {
      let index = 0;
      const next = (error) => {
        if (res.writableEnded || res.destroyed) return;
        if (error) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: error.message || String(error) }));
          return;
        }
        const layer = layers[index++];
        if (!layer) {
          if (res.writableEnded || res.destroyed) return;
          serveStatic(req, res).catch(next);
          return;
        }
        const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
        if (layer.route && pathname !== layer.route && !pathname.startsWith(`${layer.route}/`)) {
          next();
          return;
        }
        const originalUrl = req.url;
        if (layer.route) {
          req.url = `${pathname.slice(layer.route.length) || "/"}${new URL(originalUrl || "/", "http://127.0.0.1").search}`;
        }
        Promise.resolve(layer.handler(req, res, next))
          .catch(next)
          .finally(() => {
            req.url = originalUrl;
          });
      };
      next();
    },
  };
}

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

async function serveStatic(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("allow", "GET, HEAD");
    res.end();
    return;
  }
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const decoded = decodeURIComponent(url.pathname);
  const safePath = decoded.split("/").filter((part) => part && part !== "." && part !== "..").join("/");
  let filePath = join(distDir, safePath || "index.html");
  let fileStat = await stat(filePath).catch(() => null);
  if (!fileStat?.isFile()) {
    filePath = join(distDir, "index.html");
    fileStat = await stat(filePath).catch(() => null);
  }
  if (!fileStat?.isFile()) {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }
  res.statusCode = 200;
  res.setHeader("content-type", mimeTypes.get(extname(filePath).toLowerCase()) || "application/octet-stream");
  res.setHeader("cache-control", basename(filePath) === "index.html" ? "no-cache" : "public, max-age=31536000, immutable");
  res.setHeader("content-length", String(fileStat.size));
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
}

await ensureBuiltAssets();
const port = await resolvePort();
process.env.EXCALIDRAW_PROJECT_DIR = projectDir;
process.env.EXCALIDRAW_CANVAS_DIR = canvasDir;
process.env.EXCALIDRAW_PORT = String(port);
process.env.EXCALIDRAW_HOST = host;

const { canvasStoragePlugin } = await import("../vite.config.js");
const middlewares = createMiddlewareStack();
const server = createServer((req, res) => middlewares.handle(req, res));
const watcher = { add() {}, on() {} };

middlewares.use((req, res, next) => {
  if (handleTunnelAccess(req, res)) return;
  next();
});

canvasStoragePlugin().configureServer({ middlewares, watcher, httpServer: server });

async function patchServerDiscovery(patch) {
  const discoveryPath = join(canvasDir, ".server.json");
  try {
    const existing = JSON.parse(await readFile(discoveryPath, "utf8"));
    await writeFile(discoveryPath, `${JSON.stringify({ ...existing, ...patch, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // Discovery is best-effort; the Vite plugin writes the base file.
  }
}

async function startRemoteCanvasRelay({ actualPort }) {
  if (!remoteCanvasRequested) return null;
  let sessionId = String(remoteCanvasSessionArg || "").trim();
  let desktopToken = String(remoteCanvasTokenArg || "").trim();
  let viewerUrl = "";
  let relayBaseUrl = remoteCanvasBaseUrl;

  if (!sessionId || !desktopToken) {
    const created = await createRemoteCanvasSession({
      relayBaseUrl: remoteCanvasBaseUrl,
      title: remoteCanvasTitle,
      mode: remoteCanvasMode === "view" ? "view" : "generate",
      expiresInHours: remoteCanvasExpiresHours,
    });
    sessionId = created.sessionId;
    desktopToken = created.desktopToken;
    viewerUrl = created.viewerUrl;
    relayBaseUrl = created.relayBaseUrl || relayBaseUrl;
  }

  const localBaseUrl = `http://${host}:${actualPort}`;
  const client = createRemoteCanvasRelayClient({
    relayBaseUrl,
    sessionId,
    desktopToken,
    canvasDir,
    localBaseUrl,
  });
  await patchServerDiscovery({
    remoteCanvas: {
      enabled: true,
      relayBaseUrl: client.relayBaseUrl,
      sessionId,
      viewerUrl: viewerUrl || null,
      startedAt: new Date().toISOString(),
    },
  });
  console.log(`BuzzAssist remote canvas session: ${sessionId}`);
  if (viewerUrl) console.log(`BuzzAssist remote canvas viewer: ${viewerUrl}`);
  return client;
}

server.listen(port, host, async () => {
  const actual = server.address();
  const actualPort = typeof actual === "object" && actual ? actual.port : port;
  console.log(`BuzzAssist canvas: http://${host}:${actualPort}/`);
  console.log(`BuzzAssist plugin HTTP MCP endpoint: http://${host}:${actualPort}/mcp`);
  console.log(`BuzzAssist canvas data: ${join(canvasDir, "excalidraw-canvas.json")}`);
  console.log(`BuzzAssist canvas server: ${join(canvasDir, ".server.json")}`);
  startRemoteCanvasRelay({ actualPort }).catch((error) => {
    console.warn(`[remote-canvas] disabled: ${error instanceof Error ? error.message : String(error)}`);
  });
});
