// Release の受け入れ確認（lib/releaseAcceptance.mjs）の試験用の偽の MCP サーバー（stdio・改行区切りの JSON-RPC）。
// 本物の MCP は起動しない。試験はこの中身を偽の置き場の scripts/start-mcp.mjs として写して使う。
//
// FAKE_MCP_LOG があれば、起動した環境（project・canvas の置き場と作業フォルダ）を1行ずつ書く。
// FAKE_MCP_TOOLS で返す道具の名前を変えられる（カンマ区切り）。
import { appendFileSync } from "node:fs";

if (process.env.FAKE_MCP_LOG) {
  appendFileSync(process.env.FAKE_MCP_LOG, `${JSON.stringify({
    projectDir: process.env.EXCALIDRAW_PROJECT_DIR || "",
    canvasDir: process.env.EXCALIDRAW_CANVAS_DIR || "",
    noAutoOpen: process.env.EXCALIDRAW_NO_AUTO_OPEN || "",
    cwd: process.cwd(),
  })}\n`);
}

const tools = String(process.env.FAKE_MCP_TOOLS || "read_me,open_buzzassist_canvas,get_excalidraw_selection")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean)
  .map((name) => ({ name, inputSchema: { type: "object" } }));

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function handle(message) {
  if (message.method === "initialize") {
    reply(message.id, { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-buzzassist", version: "0.0.0" } });
  } else if (message.method === "tools/list") {
    // ページ送りも通るよう、1ページ目は2つだけ返す。
    if (!message.params?.cursor) reply(message.id, { tools: tools.slice(0, 2), ...(tools.length > 2 ? { nextCursor: "page-2" } : {}) });
    else reply(message.id, { tools: tools.slice(2) });
  } else if (message.method === "tools/call") {
    reply(message.id, { content: [{ type: "text", text: "ok" }], structuredContent: { ok: true } });
  } else if (message.id !== undefined) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } })}\n`);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\n");
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
