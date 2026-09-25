#!/usr/bin/env node
// skill-evals の試験用の偽 claude / codex。本物のモデルは呼ばない。
// 起動口（PATH に置く claude / codex / *.cmd）が第1引数にホスト名を渡す。
//
// 実行者の役: 依頼に [weak-on-second] があれば codex だけ弱い答え（BAD）を返す。
//             [no-skill] が無ければ、依頼文に並んだ SKILL.md を全部「読む」。
//             [try-write] があれば作業ディレクトリへ書き込む（写しの書き換え検出の試験）。
// 採点者の役: 応答に GOOD があれば全項目合格、無ければ全項目不合格。
// FAKE_FAIL_HOST が自分のホスト名なら、利用枠の上限で失敗したふりをする。
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const [host, ...argv] = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write(`0.0.0-fake-${host}\n`);
  process.exit(0);
}

const input = readFileSync(0, "utf8");
const isGrader = input.includes("## 確認項目");

function listTree(root, dir = root, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listTree(root, full, out);
    else out.push(relative(root, full).split("\\").join("/"));
  }
  return out;
}

appendFileSync(process.env.FAKE_CLI_LOG, `${JSON.stringify({
  host,
  role: isGrader ? "grader" : "executor",
  argv,
  cwd: process.cwd(),
  input,
  tree: listTree(process.cwd()),
  env: { learningWriteForbidden: process.env.BUZZASSIST_LEARNING_WRITE_FORBIDDEN || null, fishKey: process.env.FISH_AUDIO_API_KEY || null },
})}\n`);

if (process.env.FAKE_FAIL_HOST === host) {
  process.stderr.write("Error: usage limit reached for this week\n");
  process.exit(1);
}

const valueAfter = (flag) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : null;
};

if (isGrader) {
  const section = input.split("## 確認項目")[1] || "";
  const count = section.split("\n").filter((line) => /^\d+\. /u.test(line)).length;
  const response = (input.split("<<<RESPONSE")[1] || "").split("RESPONSE>>>")[0];
  const passed = response.includes("GOOD");
  const verdict = JSON.stringify({
    assertions: Array.from({ length: count }, (_, index) => ({ index: index + 1, passed, evidence: passed ? "応答に GOOD がある" : "応答に GOOD が無い" })),
  });
  if (host === "claude") {
    process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: `\`\`\`json\n${verdict}\n\`\`\``, session_id: "fake-grader-session", modelUsage: { "fake-claude-model": {} } })}\n`);
  } else {
    writeFileSync(valueAfter("--output-last-message"), verdict);
    process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "fake-grader-thread" })}\n`);
  }
  process.exit(0);
}

const request = input.split("## 依頼")[1] || "";
const weak = host === "codex" && request.includes("[weak-on-second]");
const answer = weak ? "BAD: 手順を書かない" : "GOOD: 正本を読んでから手順を書く";
if (request.includes("[try-write]")) writeFileSync(join(process.cwd(), "escaped.txt"), "written by executor");
const skillFiles = request.includes("[no-skill]")
  ? []
  : [...input.matchAll(/`([^`]+\/SKILL\.md)`/gu)].map((match) => match[1]);

if (host === "claude") {
  const events = [{ type: "system", subtype: "init", model: "fake-claude-model", tools: ["Read", "Glob", "Grep"], session_id: "fake-exec-session" }];
  for (const file of skillFiles) {
    events.push({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: join(process.cwd(), file) } }] } });
  }
  events.push({ type: "result", subtype: "success", is_error: false, result: answer, session_id: "fake-exec-session", permission_denials: [] });
  process.stdout.write(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
} else {
  const events = [{ type: "thread.started", thread_id: "fake-exec-thread" }];
  for (const file of skillFiles) {
    events.push({ type: "item.completed", item: { type: "command_execution", command: `sed -n 1,200p ${file}`, exit_code: 0, status: "completed" } });
  }
  events.push({ type: "item.completed", item: { type: "agent_message", text: answer } });
  writeFileSync(valueAfter("--output-last-message"), answer);
  process.stdout.write(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
}
