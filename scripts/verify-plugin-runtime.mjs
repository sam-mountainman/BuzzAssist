#!/usr/bin/env node
// 導入した BuzzAssist の MCP を実際に起動し、ツールの一覧と read_me の呼び出しを確かめる。
//
// 自動更新（update-current.mjs）は、setup が作り直した置き場（~/plugins/buzzassist/plugin）で
// この script を 60 秒の上限で走らせる。置き場は v0.1.26 から依存なしで配っている（node_modules が
// あるとホストの plugin キャッシュが依存の木を丸ごと写すため）。以前はこの script が先頭で
// @modelcontextprotocol/sdk を静的に import していたので、依存の無い置き場では起動した瞬間に
// ERR_MODULE_NOT_FOUND で落ち、更新が毎回巻き戻っていた（2026-09-26、0.1.27 → 0.1.29）。
//
// 運営者の端末にある古い update-current.mjs は変えられないので、ここ（Release に入る側）で直す:
// - 静的に import するのは Node の組み込みと、組み込みだけで書いた lib だけ。
// - 置き場に依存があれば今までどおりそこで確かめる。無ければ、置き場には何も作らず、一時フォルダの
//   写しに依存（同じ版の Release の展開先、無ければ写しの中の npm install）をつないで確かめる。
// - SDK は依存をつないだ後に、その置き場から動的に読み込む。
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";

import { importMcpClientSdk, prepareVerificationRuntime } from "../lib/pluginRuntimeDependencies.mjs";

const argv = process.argv.slice(2);

function readArg(name, fallback = "") {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

function log(message) {
  console.log(`[verify-plugin-runtime] ${message}`);
}

const startedAt = Date.now();
const pluginRoot = resolve(readArg("--plugin-root", process.cwd()));
// 依存の在りか（node_modules を持つディレクトリ）。新しい update-current は Release の展開先を渡す。
// 渡されなくても、同じ版の Release の展開先を自分で探す（古い update-current から呼ばれたとき）。
const depsRootArg = readArg("--deps-root", "");
const timeoutMs = Number(readArg("--timeout-ms", "30000"));
const installTimeoutMs = Number(readArg("--install-timeout-ms", String(5 * 60 * 1000)));
await access(join(pluginRoot, "scripts", "start-mcp.mjs"), constants.R_OK);

const runtime = await prepareVerificationRuntime({
  pluginRoot,
  depsRoot: depsRootArg ? resolve(depsRootArg) : "",
  installTimeoutMs,
  log,
});
console.log(`BUZZASSIST_MCP_VERIFY_DEPS=${runtime.mode}`);

// 既定の project は確かめる置き場（写しなら写し）。置き場そのものに canvas を作らない。
const projectDir = resolve(readArg("--project-dir", runtime.runtimeRoot));
const canvasDir = resolve(readArg("--canvas-dir", join(projectDir, "canvas")));
const serverPath = join(runtime.runtimeRoot, "scripts", "start-mcp.mjs");

// stderr: "pipe" を指定しながら読んでいなかったので、子プロセスが
// EMFILE などで死んでも「Connection closed」としか出ず、根因が見えなかった。
// 常時 drain して、失敗メッセージへ含める。
const childErrors = [];

function withChildStderr(error) {
  const tail = childErrors.join("").trim().slice(-1200);
  if (!tail) return error;
  const wrapped = new Error(`${error?.message || error}\n--- MCP プロセスの stderr ---\n${tail}`);
  wrapped.cause = error;
  return wrapped;
}

let client = null;
let timer = null;
const timeout = new Promise((_, reject) => {
  timer = setTimeout(() => reject(new Error(`BuzzAssist MCP verification timed out after ${timeoutMs}ms.`)), timeoutMs);
  timer.unref?.();
});
// race で使わなかった後に時間切れになっても、未処理の reject で落とさない。
timeout.catch(() => {});

try {
  const { Client, StdioClientTransport } = await importMcpClientSdk(runtime.runtimeRoot);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: runtime.runtimeRoot,
    env: {
      ...process.env,
      EXCALIDRAW_NO_AUTO_OPEN: "1",
      EXCALIDRAW_PROJECT_DIR: projectDir,
      EXCALIDRAW_CANVAS_DIR: canvasDir,
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => {
    childErrors.push(String(chunk));
    // 溜め込みすぎない。原因が分かる長さがあれば足りる。
    if (childErrors.length > 40) childErrors.shift();
  });
  client = new Client({ name: "buzzassist-update-verifier", version: "1.0.0" });

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
  log(`確かめ終わりました（${runtime.mode}、${Date.now() - startedAt}ms）。`);
} catch (error) {
  throw withChildStderr(error);
} finally {
  clearTimeout(timer);
  // MCP の子プロセスを先に閉じてから写しを消す（Windows は使用中のフォルダを消せない）。
  await client?.close().catch(() => {});
  await runtime.cleanup();
}
