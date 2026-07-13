#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function listen(server) {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen(server.address()));
  });
}

function closeServer(server) {
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "buzzassist-active-project-"));
const fallbackProject = path.join(tempRoot, "setup-project");
const activeProject = path.join(tempRoot, "current-task-project");
const fallbackCanvas = path.join(fallbackProject, "canvas");
const activeCanvas = path.join(activeProject, "canvas");
await mkdir(fallbackCanvas, { recursive: true });
await mkdir(activeProject, { recursive: true });

// A healthy install-time URL reproduces the dangerous case: the current
// project must not reuse it merely because it answers canvas-client probes.
const fallbackServer = createServer((req, res) => {
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ clients: 1, setupFallback: true }));
});
const fallbackAddress = await listen(fallbackServer);
const fallbackUrl = `http://127.0.0.1:${fallbackAddress.port}`;

let client;
let transport;
let activeServerPid = null;
try {
  client = new Client(
    { name: "buzzassist-active-project-test", version: "1.0.0" },
    { capabilities: { roots: {} } },
  );
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: pathToFileURL(activeProject).href, name: "current-task-project" }],
  }));
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repoRoot, "mcp", "server.mjs")],
    cwd: repoRoot,
    env: {
      ...process.env,
      CODEX: "1",
      EXCALIDRAW_NO_AUTO_OPEN: "1",
      EXCALIDRAW_PROJECT_DIR: fallbackProject,
      EXCALIDRAW_CANVAS_DIR: fallbackCanvas,
      EXCALIDRAW_CANVAS_URL: fallbackUrl,
      EXCALIDRAW_PORT: String(fallbackAddress.port),
    },
    stderr: "pipe",
  });
  await client.connect(transport);
  const result = await client.callTool({ name: "open_buzzassist_canvas", arguments: {} });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(result.structuredContent?.projectDir, activeProject);
  assert.equal(result.structuredContent?.canvasDir, activeCanvas);
  assert.equal(result.structuredContent?.assetsDir, path.join(activeCanvas, "assets"));
  assert.notEqual(String(result.structuredContent?.canvasUrl || "").replace(/\/$/, ""), fallbackUrl);
  await access(path.join(activeCanvas, "assets"));

  const discovery = JSON.parse(await readFile(path.join(activeCanvas, ".server.json"), "utf8"));
  activeServerPid = Number(discovery.pid) || null;
  assert.equal(discovery.projectDir, activeProject);
  assert.equal(discovery.canvasDir, activeCanvas);
  const response = await fetch(discovery.url);
  assert.equal(response.status, 200);
  console.log(`BuzzAssist active project routing passed: ${activeProject} -> ${discovery.url}`);
} finally {
  await client?.close().catch(() => {});
  await transport?.close().catch(() => {});
  if (activeServerPid) {
    try {
      process.kill(activeServerPid, "SIGTERM");
    } catch {
      // Already stopped.
    }
  }
  await closeServer(fallbackServer);
  await rm(tempRoot, { recursive: true, force: true });
}
