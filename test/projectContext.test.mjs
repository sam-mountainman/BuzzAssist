import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import {
  applyProjectContext,
  projectDirFromRequestMeta,
  projectDirFromRoots,
} from "../lib/projectContext.mjs";

test("explicit project and canvas directories override host workspace context", () => {
  assert.deepEqual(
    applyProjectContext(
      { projectDir: "/explicit/project", prompt: "cat" },
      { requestMeta: { cwd: "/active/project" }, roots: [{ uri: pathToFileURL("/root/project").href }] },
    ),
    { projectDir: "/explicit/project", prompt: "cat" },
  );
  assert.deepEqual(
    applyProjectContext(
      { canvasDir: "/explicit/canvas" },
      { requestMeta: { cwd: "/active/project" } },
    ),
    { canvasDir: "/explicit/canvas" },
  );
});

test("request metadata selects the current host project before MCP roots", () => {
  const result = applyProjectContext(
    { prompt: "cat" },
    {
      requestMeta: { workspaceRoot: "/current/project" },
      roots: [{ uri: pathToFileURL("/fallback/root").href }],
    },
  );
  assert.equal(result.projectDir, resolve("/current/project"));
  assert.equal(projectDirFromRequestMeta({ workspace: { uri: pathToFileURL("/nested/project").href } }), resolve("/nested/project"));
});

test("the first local MCP workspace root becomes the project fallback", () => {
  const roots = [
    { uri: "https://example.com/not-local" },
    { uri: pathToFileURL("/workspace/primary").href, name: "primary" },
    { uri: pathToFileURL("/workspace/secondary").href, name: "secondary" },
  ];
  assert.equal(projectDirFromRoots(roots), resolve("/workspace/primary"));
  assert.equal(applyProjectContext({}, { roots }).projectDir, resolve("/workspace/primary"));
});

test("the MCP server applies host roots to every project-scoped tool and exposes a project canvas opener", async () => {
  const source = await readFile(new URL("../mcp/server.mjs", import.meta.url), "utf8");
  assert.match(source, /TOOL_OPEN_CANVAS = "open_buzzassist_canvas"/);
  assert.match(source, /mcpServer\.server\.listRoots\(\{\}, \{ timeout: 1500, signal: extra\?\.signal \}\)/);
  assert.match(source, /contextualizeToolArgs\(server, definition\.name, args, extra\)/);
  assert.match(source, /const canvasAutoOpenAttempted = new Set\(\)/);
  assert.match(source, /const assetsDir = join\(activeCanvasDir, "assets"\)/);
  assert.match(source, /projectRuntimeStops\.set\(activeCanvasDir, startChatBridgeWorker/);
  assert.match(source, /if \(envCanvasDir && pathResolve\(envCanvasDir\) !== activeCanvasDir\)/);
  assert.match(source, /return \{ url: "", mcpUrl: "", port: null, token: null \}/);
});
