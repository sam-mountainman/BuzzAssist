#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);

function readArg(name, fallback = "") {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

const pluginRoot = resolve(readArg("--plugin-root", process.cwd()));
const projectDir = resolve(readArg("--project-dir", pluginRoot));
const canvasDir = resolve(readArg("--canvas-dir", join(projectDir, "canvas")));
const serverPath = join(pluginRoot, "scripts", "start-mcp.mjs");
await access(serverPath, constants.R_OK);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: pluginRoot,
  env: {
    ...process.env,
    EXCALIDRAW_NO_AUTO_OPEN: "1",
    EXCALIDRAW_PROJECT_DIR: projectDir,
    EXCALIDRAW_CANVAS_DIR: canvasDir,
  },
  stderr: "pipe",
});
const client = new Client({ name: "buzzassist-update-verifier", version: "1.0.0" });

// stderr: "pipe" を指定しながら読んでいなかったので、子プロセスが
// EMFILE などで死んでも「Connection closed」としか出ず、根因が見えなかった。
// 常時 drain して、失敗メッセージへ含める。
const childErrors = [];
transport.stderr?.on("data", (chunk) => {
  const text = String(chunk);
  childErrors.push(text);
  // 溜め込みすぎない。原因が分かる長さがあれば足りる。
  if (childErrors.length > 40) childErrors.shift();
});

function withChildStderr(error) {
  const tail = childErrors.join("").trim().slice(-1200);
  if (!tail) return error;
  const wrapped = new Error(`${error?.message || error}\n--- MCP プロセスの stderr ---\n${tail}`);
  wrapped.cause = error;
  return wrapped;
}

const timeoutMs = Number(readArg("--timeout-ms", "30000"));
const timeout = new Promise((_, reject) => {
  setTimeout(() => reject(new Error(`BuzzAssist MCP verification timed out after ${timeoutMs}ms.`)), timeoutMs).unref?.();
});

try {
  try {
    await Promise.race([client.connect(transport), timeout]);
  } catch (error) {
    // 「Connection closed」だけを出さない。子の stderr が根因を持っている。
    throw withChildStderr(error);
  }
  const listed = await Promise.race([client.listTools(), timeout]);
  const names = new Set((listed?.tools || []).map((tool) => tool.name));
  for (const required of ["read_me", "open_buzzassist_canvas", "get_excalidraw_selection"]) {
    if (!names.has(required)) throw new Error(`Installed MCP is missing required tool: ${required}`);
  }
  const result = await Promise.race([
    client.callTool({ name: "read_me", arguments: {} }),
    timeout,
  ]);
  if (result?.isError || result?.structuredContent?.ok !== true) {
    throw new Error("Installed MCP read_me smoke call failed.");
  }
  console.log(`BUZZASSIST_MCP_VERIFY=ok`);
  console.log(`BUZZASSIST_MCP_TOOL_COUNT=${names.size}`);
} catch (error) {
  throw withChildStderr(error);
} finally {
  await client.close().catch(() => {});
}
