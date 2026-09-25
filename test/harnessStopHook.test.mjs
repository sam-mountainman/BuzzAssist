import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  HARD_TIMEOUT_MS,
  MAX_BLOCKS_PER_JOB,
  STOP_HOOK_REASON_PREFIX,
  STOP_HOOK_STATE_DIR_ENV,
  STOP_HOOK_SWITCH_ENV,
  createReferenceCollector,
  detectCompletionClaim,
  evaluateStop,
  jobRecordPath,
  runStopHookCli,
  stopHookStateDir,
} from "../scripts/harness-stop-hook.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(ROOT, "scripts", "harness-stop-hook.mjs");
// 合成の Job ID（videoHarnessJob.mjs と同じ形: video-<harness>-<16桁hex>）。
const JOB_ID = "video-sample-harness-00112233aabbccdd";
const OTHER_JOB_ID = "video-sample-harness-ffeeddccbbaa9988";

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** 合成のプロジェクトに Job の記録を置く。 */
function writeJob(projectDir, { id = JOB_ID, status, stages, blockers = [], knownRemainingIssues = [], receipt = null, receiptSha = null, pendingReceiptFinalization } = {}) {
  const runDir = join(projectDir, "canvas", "harness-runs", id);
  mkdirSync(runDir, { recursive: true });
  const artifacts = [];
  if (receipt) {
    const text = `${JSON.stringify(receipt, null, 2)}\n`;
    writeFileSync(join(runDir, "run-receipt.json"), text);
    artifacts.push({ kind: "run-receipt", path: join(runDir, "run-receipt.json"), sha256: receiptSha || sha256(text), bytes: Buffer.byteLength(text) });
  }
  const job = {
    version: "buzzassist-video-harness-job-v1",
    id,
    status,
    projectDir,
    runDir,
    stages: stages || [
      { id: "doctor", status: "pass" },
      { id: "production", status: status === "completed" ? "pass" : "running" },
      { id: "audit", status: status === "completed" ? "pass" : "pending" },
      { id: "canvas-projection", status: status === "completed" ? "pass" : "pending" },
    ],
    blockers,
    knownRemainingIssues,
    artifacts,
    ...(pendingReceiptFinalization ? { pendingReceiptFinalization } : {}),
  };
  writeFileSync(join(runDir, "job.json"), `${JSON.stringify(job, null, 2)}\n`);
  return job;
}

function passingReceipt() {
  return { version: "harness-run-receipt-v1", finalized: true, outcome: "pass", knownRemainingIssues: [] };
}

/** Claude Code 形式の記録（JSONL）。get_video_harness_job の呼び出しと結果、最後の発言。 */
function writeClaudeTranscript(file, { projectDir, jobId = JOB_ID, finalText = "" } = {}) {
  const lines = [
    { type: "user", message: { role: "user", content: "Job の状態を見て" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "mcp__plugin_buzzassist_buzzassist_mcp__get_video_harness_job", input: { projectDir, jobId } }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: JSON.stringify({ version: "buzzassist-video-harness-service-result-v1", ok: true, operation: "get", projectDir, jobId, status: "running" }) }] } },
  ];
  if (finalText) lines.push({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: finalText }] } });
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "stop-hook-"));
  const projectDir = join(dir, "project");
  mkdirSync(projectDir, { recursive: true });
  const stateDir = join(dir, "state");
  const transcript = join(dir, "session.jsonl");
  const env = { [STOP_HOOK_STATE_DIR_ENV]: stateDir };
  return { dir, projectDir, stateDir, transcript, env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function stopInput(fx, overrides = {}) {
  return {
    session_id: "session-synthetic-1",
    transcript_path: fx.transcript,
    cwd: fx.dir,
    hook_event_name: "Stop",
    stop_hook_active: false,
    ...overrides,
  };
}

/** runStopHookCli を実プロセスと同じ入出力で呼ぶ（stdin/stdout を差し替える）。 */
async function runCli(input, { env, home = tmpdir() } = {}) {
  const { Readable, Writable } = await import("node:stream");
  let out = "";
  const stdout = new Writable({ write(chunk, _enc, done) { out += chunk.toString(); done(); } });
  const stderr = new Writable({ write(_chunk, _enc, done) { done(); } });
  const stdin = Readable.from([typeof input === "string" ? input : JSON.stringify(input)]);
  const code = await runStopHookCli({ stdin, stdout, stderr, env, home, exit: () => {}, timeoutMs: 20_000 });
  return { code, stdout: out };
}

test("(a) 未合格の Job で「完成しました」→ block し、reason に Job・状態・残りの項目を入れる", async () => {
  const fx = fixture();
  try {
    writeJob(fx.projectDir, { status: "failed", blockers: ["paid-media-recovery-pending"], knownRemainingIssues: ["audio: 合成の不合格理由"] });
    writeClaudeTranscript(fx.transcript, { projectDir: fx.projectDir });
    const result = await runCli(stopInput(fx, { last_assistant_message: "動画が完成しました。MP4 を確認してください。" }), { env: fx.env });
    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(output).sort(), ["decision", "reason"], "decision と reason 以外（continue など）を出さない");
    assert.equal(output.decision, "block");
    assert.match(output.reason, new RegExp(`Job ${JOB_ID} は`, "u"));
    assert.match(output.reason, /status=failed/u);
    assert.match(output.reason, /残っている項目: .*paid-media-recovery-pending/u);
    assert.match(output.reason, /audio: 合成の不合格理由/u);
    assert.match(output.reason, /完成と言わずに状態を報告するか、次の工程を進める/u);
    assert.ok(output.reason.startsWith(STOP_HOOK_REASON_PREFIX));
  } finally {
    fx.cleanup();
  }
});

test("(a') completed と書かれていても RunReceipt が現物と一致しなければ block する", async () => {
  const fx = fixture();
  try {
    writeJob(fx.projectDir, { status: "completed", receipt: passingReceipt(), receiptSha: "0".repeat(64) });
    writeClaudeTranscript(fx.transcript, { projectDir: fx.projectDir });
    const result = await runCli(stopInput(fx, { last_assistant_message: "The video is done and ready to deliver." }), { env: fx.env });
    const output = JSON.parse(result.stdout);
    assert.equal(output.decision, "block");
    assert.match(output.reason, /RunReceipt の SHA-256 が Job の記録と一致しない/u);
  } finally {
    fx.cleanup();
  }
});

test("(b) 合格で決着した Job（completed・Receipt pass・残りなし）なら止めない", async () => {
  const fx = fixture();
  try {
    writeJob(fx.projectDir, { status: "completed", receipt: passingReceipt() });
    writeClaudeTranscript(fx.transcript, { projectDir: fx.projectDir });
    const result = await runCli(stopInput(fx, { last_assistant_message: "動画が完成しました。" }), { env: fx.env });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.equal(evaluateStop(stopInput(fx, { last_assistant_message: "動画が完成しました。" }), { env: fx.env }).why, "settled-or-reported");
  } finally {
    fx.cleanup();
  }
});

test("(c) 人の確認待ちで「確認待ちです」と報告 → 止めない。完成と書いたときだけ、確認待ちの報告を促す", async () => {
  const fx = fixture();
  try {
    writeJob(fx.projectDir, { status: "awaiting-human-review", blockers: ["run-receipt-finalization"], knownRemainingIssues: ["run-receipt: reviewer-trust-unconfigured"] });
    writeClaudeTranscript(fx.transcript, { projectDir: fx.projectDir });
    for (const message of [
      `Job ${JOB_ID} は人の確認待ちです。signoff をお願いします。`,
      "動画の生成は完了しました。あとは確認待ちです。",
    ]) {
      const result = await runCli(stopInput(fx, { last_assistant_message: message }), { env: fx.env });
      assert.equal(result.stdout, "", message);
    }
    const claimed = await runCli(stopInput(fx, { last_assistant_message: "動画が完成しました。" }), { env: fx.env });
    const output = JSON.parse(claimed.stdout);
    assert.equal(output.decision, "block");
    assert.match(output.reason, /人の確認待ち（status=awaiting-human-review）/u);
    assert.match(output.reason, /作業を進めなくてよい/u);
    assert.match(output.reason, /確認待ちであること/u);
    assert.doesNotMatch(output.reason, /次の工程を進める/u);
  } finally {
    fx.cleanup();
  }
});

test("(d) stop_hook_active が true なら、未合格でも止めない", async () => {
  const fx = fixture();
  try {
    writeJob(fx.projectDir, { status: "running" });
    writeClaudeTranscript(fx.transcript, { projectDir: fx.projectDir });
    const result = await runCli(stopInput(fx, { stop_hook_active: true, last_assistant_message: "動画が完成しました。" }), { env: fx.env });
    assert.equal(result.stdout, "");
    assert.equal(evaluateStop(stopInput(fx, { stop_hook_active: true, last_assistant_message: "動画が完成しました。" }), { env: fx.env }).why, "stop-hook-active");
  } finally {
    fx.cleanup();
  }
});

test("(e) 同じ会話・同じ Job で2回差し戻したら、3回目は通す（別の会話は別に数える）", async () => {
  const fx = fixture();
  try {
    writeJob(fx.projectDir, { status: "running" });
    writeClaudeTranscript(fx.transcript, { projectDir: fx.projectDir });
    const input = stopInput(fx, { last_assistant_message: "動画が完成しました。" });
    const outputs = [];
    for (let turn = 0; turn < MAX_BLOCKS_PER_JOB + 1; turn += 1) outputs.push((await runCli(input, { env: fx.env })).stdout);
    assert.equal(JSON.parse(outputs[0]).decision, "block");
    assert.equal(JSON.parse(outputs[1]).decision, "block");
    assert.equal(outputs[2], "", "3回目は通す");
    const other = await runCli({ ...input, session_id: "session-synthetic-2" }, { env: fx.env });
    assert.equal(JSON.parse(other.stdout).decision, "block", "別の会話は別に数える");
    // 回数はリポジトリ外（指定の置き場）に、会話本文なしで残る。
    const stateText = readFileSync(join(fx.stateDir, `${sha256("session-synthetic-1").slice(0, 32)}.json`), "utf8");
    assert.equal(JSON.parse(stateText).jobs[JOB_ID].blocks, 2);
    assert.doesNotMatch(stateText, /完成しました/u);
  } finally {
    fx.cleanup();
  }
});

test("(f) 壊れた入力・壊れた Job 記録・書けない回数記録では exit 0 で止めない", async () => {
  const fx = fixture();
  try {
    for (const raw of ["", "{", "[]", "null", "\"text\"", JSON.stringify({ hook_event_name: "Stop" })]) {
      const result = await runCli(raw, { env: fx.env });
      assert.equal(result.code, 0);
      assert.equal(result.stdout, "", `入力: ${raw}`);
    }
    // Job の記録が JSON として壊れている → 読めない＝止めない。
    const runDir = join(fx.projectDir, "canvas", "harness-runs", JOB_ID);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "job.json"), "{ broken");
    writeClaudeTranscript(fx.transcript, { projectDir: fx.projectDir });
    const broken = await runCli(stopInput(fx, { last_assistant_message: "動画が完成しました。" }), { env: fx.env });
    assert.equal(broken.stdout, "");
    assert.equal(evaluateStop(stopInput(fx, { last_assistant_message: "動画が完成しました。" }), { env: fx.env }).why, "job-unreadable");
    // 回数を書けない（置き場がファイル）→ 上限を守れないので差し戻さない。
    writeJob(fx.projectDir, { status: "running" });
    const blockedFile = join(fx.dir, "not-a-dir");
    writeFileSync(blockedFile, "x");
    const unwritableEnv = { [STOP_HOOK_STATE_DIR_ENV]: join(blockedFile, "sub") };
    assert.equal(evaluateStop(stopInput(fx, { last_assistant_message: "動画が完成しました。" }), { env: unwritableEnv }).action, "block");
    const unwritable = await runCli(stopInput(fx, { last_assistant_message: "動画が完成しました。" }), { env: unwritableEnv });
    assert.equal(unwritable.stdout, "", "判定は block でも、回数を書けなければ差し戻さない");
    // 記録のパスが無い・存在しない。
    const missing = await runCli(stopInput(fx, { transcript_path: join(fx.dir, "missing.jsonl"), last_assistant_message: "動画が完成しました。" }), { env: fx.env });
    assert.equal(missing.stdout, "");
  } finally {
    fx.cleanup();
  }
});

test("(g) Job を扱っていない会話・完成を主張しない発言・子エージェント・Stop 以外では何もしない", async () => {
  const fx = fixture();
  try {
    writeFileSync(fx.transcript, `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "テストを直しました" }] } })}\n`);
    assert.equal(evaluateStop(stopInput(fx, { last_assistant_message: "動画が完成しました。" }), { env: fx.env }).why, "no-job");

    writeJob(fx.projectDir, { status: "running" });
    writeClaudeTranscript(fx.transcript, { projectDir: fx.projectDir });
    assert.equal(evaluateStop(stopInput(fx, { last_assistant_message: "Job は実行中です。終わったら報告します。" }), { env: fx.env }).why, "no-claim");
    assert.equal(evaluateStop(stopInput(fx, { last_assistant_message: "まだ完成していません。動画は生成中です。" }), { env: fx.env }).why, "no-claim");
    // 状態を書いている弱い主張（完成品の主張でない）は報告として通す。
    assert.equal(evaluateStop(stopInput(fx, { last_assistant_message: "Job の確認は完了しました。status=running で、動画はまだ生成中です。" }), { env: fx.env }).why, "settled-or-reported");
    assert.equal(evaluateStop(stopInput(fx, { last_assistant_message: "動画が完成しました。" }), { env: { ...fx.env, BUZZASSIST_LEARNING_WRITE_FORBIDDEN: "child-agent" } }).why, "child-agent");
    assert.equal(evaluateStop(stopInput(fx, { last_assistant_message: "動画が完成しました。" }), { env: { ...fx.env, [STOP_HOOK_SWITCH_ENV]: "off" } }).why, "switched-off");
    assert.equal(evaluateStop(stopInput(fx, { hook_event_name: "SubagentStop", last_assistant_message: "動画が完成しました。" }), { env: fx.env }).why, "not-stop");
    assert.equal(evaluateStop(stopInput(fx, { agent_id: "agent-1", last_assistant_message: "動画が完成しました。" }), { env: fx.env }).why, "subagent");
  } finally {
    fx.cleanup();
  }
});

test("最後の発言が入力に無ければ記録の末尾から取り、Codex 形式の記録（MCP 呼び出し・シェル実行）からも Job を見つける", async () => {
  const fx = fixture();
  try {
    writeJob(fx.projectDir, { status: "blocked-preflight", blockers: ["doctor"] });
    // Claude Code 形式: 最後の発言は記録の中だけにある。
    writeClaudeTranscript(fx.transcript, { projectDir: fx.projectDir, finalText: "All done — the video is complete." });
    assert.equal(evaluateStop(stopInput(fx), { env: fx.env }).action, "block");

    // Codex 形式: mcp_tool_call_end と exec_command。projectDir は --project-dir と invocation から。
    const codex = [
      { type: "event_msg", payload: { type: "mcp_tool_call_end", invocation: { server: "buzzassist_mcp", tool: "run_video_harness", arguments: { projectDir: fx.projectDir } }, result: { Ok: { content: [{ type: "text", text: `Video harness Job ${JOB_ID}: status=blocked-preflight.` }] } } } },
      { type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: `node scripts/run-video-harness.mjs status --job-id ${OTHER_JOB_ID} --project-dir "${fx.projectDir}"` }) } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "動画の制作が完了しました。" }] } },
    ];
    writeFileSync(fx.transcript, `${codex.map((line) => JSON.stringify(line)).join("\n")}\n`);
    // 最後に扱ったのは OTHER_JOB_ID だが記録が無い → 見つかった方（JOB_ID）で判定する。
    const decision = evaluateStop(stopInput(fx, { cwd: join(fx.dir, "elsewhere"), last_assistant_message: null }), { env: fx.env });
    assert.equal(decision.action, "block");
    assert.deepEqual(decision.jobIds, [JOB_ID]);
  } finally {
    fx.cleanup();
  }
});

test("発言が Job を名指ししていればその Job だけを見る（別の合格済み Job を名指しした完成報告は通す）", async () => {
  const fx = fixture();
  try {
    writeJob(fx.projectDir, { id: JOB_ID, status: "planned" });
    writeJob(fx.projectDir, { id: OTHER_JOB_ID, status: "completed", receipt: passingReceipt() });
    const lines = [JOB_ID, OTHER_JOB_ID].map((jobId) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: jobId, name: "mcp__buzzassist_mcp__get_video_harness_job", input: { projectDir: fx.projectDir, jobId } }] } }));
    writeFileSync(fx.transcript, `${lines.join("\n")}\n`);
    assert.equal(evaluateStop(stopInput(fx, { last_assistant_message: `Job ${OTHER_JOB_ID} の動画が完成しました。` }), { env: fx.env }).action, "none");
    const named = evaluateStop(stopInput(fx, { last_assistant_message: `Job ${JOB_ID} の動画が完成しました。` }), { env: fx.env });
    assert.equal(named.action, "block");
    assert.match(named.reason, /計画だけで、有料生成はまだ始まっていない/u);
  } finally {
    fx.cleanup();
  }
});

test("(h) Windows のパス: 記録の projectDir・--project-dir・harness-runs のパスからプロジェクトを取り、win32 で Job の記録の位置を組む", () => {
  const collector = createReferenceCollector({ cwd: "C:\\Users\\operator\\work" });
  collector.addLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__buzzassist_mcp__get_video_harness_job", input: { projectDir: "C:\\Users\\operator\\proj one", jobId: JOB_ID } }] } }));
  collector.addLine(JSON.stringify({ payload: { type: "function_call", arguments: JSON.stringify({ cmd: `node scripts\\run-video-harness.mjs status --job-id ${JOB_ID} --project-dir "D:\\media\\proj two"` }) } }));
  collector.addLine(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: `type "E:\\runs\\proj three\\canvas\\harness-runs\\${OTHER_JOB_ID}\\job.json"` }] } }));
  collector.addLine(JSON.stringify({ payload: { arguments: JSON.stringify({ cmd: "node scripts\\run-video-harness.mjs list --project-dir ." }) } }));
  const { jobIds, projectDirs } = collector.result();
  assert.deepEqual(jobIds, [OTHER_JOB_ID, JOB_ID]);
  assert.ok(projectDirs.includes("C:\\Users\\operator\\proj one"), projectDirs.join(" | "));
  assert.ok(projectDirs.includes("D:\\media\\proj two"), projectDirs.join(" | "));
  assert.ok(projectDirs.includes("E:\\runs\\proj three"), projectDirs.join(" | "));
  assert.ok(projectDirs.includes("C:\\Users\\operator\\work"), "相対の --project-dir は cwd（Windows）で解決する");
  // harness-runs のパスから取ったプロジェクトを先に試す。
  assert.equal(projectDirs[0], "E:\\runs\\proj three");
  assert.equal(
    jobRecordPath("C:\\Users\\operator\\proj one", JOB_ID, win32),
    `C:\\Users\\operator\\proj one\\canvas\\harness-runs\\${JOB_ID}\\job.json`,
  );
  // 回数の置き場は既定でホーム配下（リポジトリ外）。
  assert.equal(stopHookStateDir({}, join(tmpdir(), "home")), join(tmpdir(), "home", ".buzzassist", "hooks", "stop-guard"));
});

test("完成の主張の判定: 否定・伝聞・仮定・path の「パス」は主張にしない", () => {
  for (const text of ["動画が完成しました。", "MP4 を書き出して、納品できます。", "The final video is done.", "All checks passed and the video is ready to publish."]) {
    assert.equal(detectCompletionClaim(text).claimed, true, text);
  }
  for (const text of [
    "まだ完成していません。動画は生成中です。",
    "動画は未完成です。",
    "「完成しました」とは言えません。動画は止まっています。",
    "動画が完成したら報告します。",
    "MP4 のパスです: out/final.mp4",
    "The video is not done yet.",
    "テストの追加が完了しました。",
  ]) {
    assert.equal(detectCompletionClaim(text).claimed, false, text);
  }
});

// 実プロセスを起動する試験の待ちの上限。フックが止まったときに気づくための見張りで、速さの基準ではない。
// 負荷の高い端末ではシェルと node の起動・読み込みだけで 20 秒を超え、spawnSync が子を殺して status が
// null で落ちた（同じ試験を 4 本並列で回して3回）。止めない長さはフックの見張りを試験の時計で確かめる。
const PROCESS_HANG_GUARD_MS = 120_000;

// フック自身の見張り（scripts/harness-stop-hook.mjs の HARD_TIMEOUT_MS）。読み込みの後、この長さで判定を
// 終えられなければ、止めない側に倒して何も出さずに exit 0 で終わる（ユーザーを待たせない作り）。
const STOP_HOOK_GUARD_MS = HARD_TIMEOUT_MS;

test("実プロセス: 起動行をシェルで動かし、stdin の JSON に stdout の JSON で答える（両ホストの起動行）", (t) => {
  const fx = fixture();
  try {
    writeJob(fx.projectDir, { status: "failed", knownRemainingIssues: ["synthetic issue"] });
    writeClaudeTranscript(fx.transcript, { projectDir: fx.projectDir });
    const env = { ...process.env, ...fx.env };
    delete env.BUZZASSIST_LEARNING_WRITE_FORBIDDEN;
    delete env[STOP_HOOK_SWITCH_ENV];
    const readJson = (relative) => JSON.parse(readFileSync(join(ROOT, relative), "utf8"));
    const claude = readJson("hooks/claude-hooks.json").hooks.Stop[0].hooks[0].command.replaceAll("${CLAUDE_PLUGIN_ROOT}", ROOT);
    const codex = readJson("hooks/codex-hooks.json").hooks.Stop[0].hooks[0].command;
    let session = 0;
    for (const [label, command, extraEnv] of [["claude", claude, {}], ["codex", codex, { PLUGIN_ROOT: ROOT }]]) {
      // 負荷の高い端末では、読み込みの後の判定そのものがフックの見張り（HARD_TIMEOUT_MS）を超え、止めない側に倒れて
      // 何も出さないことがある（同じ試験を 4 本並列で回して 20 回中 2 回、"Unexpected end of JSON input"）。
      // それは作りどおりの動きなので、見張りより長くかかって空だった回だけ、別の会話として起動し直す。
      // 見張りより早く空で返るのは本当の取りこぼしなので、測り直さずに落とす。
      let result;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        session += 1;
        const input = JSON.stringify(stopInput(fx, { session_id: `process-${session}`, last_assistant_message: "動画が完成しました。" }));
        const started = Date.now();
        result = spawnSync(command, { shell: true, cwd: tmpdir(), input, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: PROCESS_HANG_GUARD_MS });
        const elapsedMs = Date.now() - started;
        if (!(result.status === 0 && result.stdout === "" && elapsedMs >= STOP_HOOK_GUARD_MS)) break;
        t.diagnostic(`${label}: ${elapsedMs}ms かかって空の応答（フックの見張りで打ち切り）。起動し直す（${attempt} 回目）`);
      }
      assert.equal(result.status, 0, `${label}: ${result.stderr}`);
      const output = JSON.parse(result.stdout);
      assert.equal(output.decision, "block", label);
      assert.match(output.reason, /synthetic issue/u, label);
    }
    // plugin root が渡らなくても exit 0 で何も出さない。
    const missing = spawnSync(readJson("hooks/codex-hooks.json").hooks.Stop[0].hooks[0].command, {
      shell: true, cwd: tmpdir(), input: JSON.stringify(stopInput(fx, { session_id: "process-x", last_assistant_message: "動画が完成しました。" })),
      env: { ...env, PLUGIN_ROOT: "", CLAUDE_PLUGIN_ROOT: "" }, encoding: "utf8", timeout: PROCESS_HANG_GUARD_MS,
    });
    assert.equal(missing.status, 0);
    assert.equal(missing.stdout, "");
  } finally {
    fx.cleanup();
  }
});

test("入力が閉じなくても、見張りの時計で exit 0 を呼び、何も出さない（停止を待たせない長さ）", async (t) => {
  // 停止を待たせないことを、実プロセスの壁時計（起動を含めて 15 秒未満）で見ていた。起動の重さは端末の
  // 負荷しだいなので、見張りの長さは試験の時計で確かめる: 入力が閉じないまま、進めた長さで exit(0) が呼ばれる。
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { PassThrough, Writable } = await import("node:stream");
  const stdin = new PassThrough();
  let out = "";
  const exits = [];
  const running = runStopHookCli({
    stdin,
    stdout: new Writable({ write(chunk, _enc, done) { out += chunk.toString(); done(); } }),
    stderr: new Writable({ write(_chunk, _enc, done) { done(); } }),
    env: { ...process.env, [STOP_HOOK_STATE_DIR_ENV]: join(tmpdir(), "stop-hook-never") },
    home: tmpdir(),
    exit: (code) => { exits.push(code); },
  });
  stdin.write("{\"hook_event_name\":\"Stop\",");
  let virtualMs = 0;
  while (exits.length === 0 && virtualMs < 60_000) {
    t.mock.timers.tick(100);
    virtualMs += 100;
  }
  assert.deepEqual(exits, [0], "入力が閉じないまま待ち続けた");
  assert.ok(virtualMs <= HARD_TIMEOUT_MS, `停止を待たせすぎる（${virtualMs}ms）`);
  stdin.end();
  assert.equal(await running, 0);
  assert.equal(out, "");
});

test("実プロセス: 入力が閉じなくても、自分で exit 0 で終わり、何も出さない", { timeout: PROCESS_HANG_GUARD_MS }, async (t) => {
  const child = spawn(process.execPath, [HOOK], { cwd: ROOT, env: { ...process.env, [STOP_HOOK_STATE_DIR_ENV]: join(tmpdir(), "stop-hook-never") }, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stdin.on("error", () => {});
  child.stdin.write("{\"hook_event_name\":\"Stop\",");
  const started = Date.now();
  const code = await new Promise((resolve) => child.on("close", resolve));
  // 入力は最後まで閉じていない（終わったのはフック自身の見張り）。壁時計は起動を含むので記録だけにする。
  assert.equal(child.stdin.writableEnded, false);
  assert.equal(code, 0);
  assert.equal(stdout, "");
  t.diagnostic(`起動から終了まで ${Date.now() - started}ms`);
});
