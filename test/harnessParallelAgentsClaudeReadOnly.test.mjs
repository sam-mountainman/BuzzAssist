import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildEngineArgs,
  engineReadOnlySupport,
  resolveExecutable,
  spawnInvocation,
} from "../scripts/harness-parallel-agents.mjs";

// claude を読み取り専用の実行に入れる引数で、書き込みが**本当に**止まるかを確かめる。
//
// 本物のモデルは呼ばない。ANTHROPIC_BASE_URL をこの試験の中の偽の API サーバーへ向け、
// その「モデル」に Write / Edit / Bash を要求させる。claude CLI が道具を実行すればファイルが
// できる。HOME と設定の置き場は一時ディレクトリにし、利用者の本物の設定・鍵・フックには
// 触れない（設定の置き場には、全部を許す意地悪な設定を置く）。
//
// 物差しが壊れていないことを示すため、書き込みを許す引数（acceptEdits）でも同じ要求を流し、
// そちらではファイルができることも確かめる。claude CLI が無い、または読み取り専用の引数を
// 持たない版の機械（CI を含む）では飛ばす。

const claudeBinary = resolveExecutable("claude");
const support = claudeBinary ? await engineReadOnlySupport("claude") : { supported: false, missing: ["claude executable"] };
const skip = !claudeBinary
  ? "claude CLI が無い"
  : !support.supported ? `claude CLI に読み取り専用の引数が無い: ${support.missing.join(", ")}` : false;

function sse(res, events) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const [type, data] of events) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  res.end();
}

async function runAgainstFakeModel({ args, toolName }) {
  const root = mkdtempSync(join(tmpdir(), "claude-read-only-"));
  const work = join(root, "work");
  const home = join(root, "home");
  const configDir = join(home, ".claude");
  mkdirSync(work, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  // 利用者の設定がどれだけ緩くても、読み取り専用の引数が勝つこと。
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({
    permissions: { allow: ["Write", "Edit", "Bash", "NotebookEdit"], defaultMode: "bypassPermissions" },
  }));
  const target = join(work, "written.txt");
  if (toolName === "Edit") writeFileSync(target, "original\n");
  const requests = [];
  const credentials = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (!req.url.startsWith("/v1/messages") || req.url.includes("count_tokens")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "not found" } }));
        return;
      }
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* 読めない要求 */ }
      requests.push(parsed);
      // 本物の資格情報（OAuth の Bearer など）が使われていないことを確かめるため、鍵の形だけ残す。
      credentials.push({ apiKey: req.headers["x-api-key"] || "", bearer: /^bearer\s/iu.test(String(req.headers.authorization || "")) });
      const answered = (parsed?.messages || []).some((message) => Array.isArray(message.content)
        && message.content.some((block) => block?.type === "tool_result"));
      const message = { id: `msg_${requests.length}`, type: "message", role: "assistant", model: parsed?.model || "fake", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
      if (!answered) {
        const input = toolName === "Bash" ? { command: `echo written > ${JSON.stringify(target)}`, description: "write a file" }
          : toolName === "Edit" ? { file_path: target, old_string: "original", new_string: "changed" }
            : { file_path: target, content: "written\n" };
        sse(res, [
          ["message_start", { message }],
          ["content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_read_only_probe", name: toolName, input: {} } }],
          ["content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }],
          ["content_block_stop", { index: 0 }],
          ["message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } }],
          ["message_stop", {}],
        ]);
      } else {
        sse(res, [
          ["message_start", { message }],
          ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
          ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "PROBE-DONE" } }],
          ["content_block_stop", { index: 0 }],
          ["message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
          ["message_stop", {}],
        ]);
      }
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  try {
    const env = {
      PATH: process.env.PATH ?? process.env.Path ?? "",
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: configDir,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      ANTHROPIC_API_KEY: "sk-ant-synthetic-read-only-probe",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_AUTOUPDATER: "1",
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    };
    const invocation = spawnInvocation(claudeBinary, args, { env });
    const outcome = await new Promise((done) => {
      const child = spawn(invocation.command, invocation.args, { ...invocation.options, cwd: work, env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.stdin.end("Reply");
      child.on("close", (code) => { clearTimeout(timer); done({ code, stdout, stderr }); });
    });
    const toolResult = requests
      .flatMap((request) => (request?.messages || []).flatMap((message) => (Array.isArray(message.content) ? message.content : [])))
      .find((block) => block?.type === "tool_result");
    const current = existsSync(target) ? readFileSync(target, "utf8") : null;
    return {
      ...outcome,
      written: toolName === "Edit" ? current !== "original\n" : current !== null,
      toolResult: JSON.stringify(toolResult?.content ?? null),
      offeredTools: (requests[0]?.tools || []).map((tool) => tool.name),
      requestCount: requests.length,
      credentials,
    };
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
}

// CI には claude CLI が無いので、飛ばすのはこの1件だけ（config/ci-test-skip-allowlist.json）。
test("claude の読み取り専用の引数で、偽のモデルが要求した書き込みが本当に止まる", { skip, timeout: 600_000 }, async (t) => {
  await t.test("物差しの確認: 書き込みを許す引数なら、偽のモデルの Write 要求でファイルができる", async () => {
    const result = await runAgainstFakeModel({ args: ["-p", "--permission-mode", "acceptEdits"], toolName: "Write" });
    assert.equal(result.written, true, `書き込みが観測できない（物差しが壊れている）: ${result.stderr}`);
    assert.ok(result.credentials.length > 0);
    assert.ok(
      result.credentials.every((row) => row.apiKey === "sk-ant-synthetic-read-only-probe" && !row.bearer),
      "偽の鍵だけが使われ、本物の資格情報は使われていない",
    );
  });

  for (const toolName of ["Write", "Edit", "Bash"]) {
    await t.test(`読み取り専用の引数では、${toolName} を要求されてもファイルは変わらない`, async () => {
      const args = buildEngineArgs("claude", { prompt: "x" }, { readOnly: true });
      const result = await runAgainstFakeModel({ args, toolName });
      assert.equal(result.code, 0, result.stderr);
      assert.ok(result.requestCount >= 2, "道具の要求に対する返答まで往復している");
      assert.equal(result.written, false, `${toolName} で書けてしまった`);
      assert.match(result.toolResult, /No such tool available|not available|disabled|denied|permission/iu, result.toolResult);
      for (const forbidden of ["Write", "Edit", "Bash", "NotebookEdit", "Agent", "PowerShell"]) {
        assert.equal(result.offeredTools.includes(forbidden), false, `${forbidden} がモデルに渡っている: ${result.offeredTools.join(",")}`);
      }
      assert.ok(result.offeredTools.includes("Read"), "読む道具は渡す");
    });
  }
});
