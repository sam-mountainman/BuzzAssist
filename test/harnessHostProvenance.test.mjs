// どのホスト（Claude Code / Codex / Antigravity / 素の端末）から動かした実行かを判定し、Job に
// 「作ったホスト」と「再開したホストの一覧」を分けて残すことの試験（Receipt と集計は別の試験）。
// Job・台本・Pack・ホストの版・モデル ID は全て合成で、本物の claude / codex CLI は起動しない
// （MCP の clientInfo と環境変数の名前を合成して渡す）。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  HOST_MODEL_INVALID_CODE,
  claudeCodeVersionFromAiAgent,
  codexVersionFromPackageRoot,
  detectHostInvocation,
  hostFromEnvironment,
  hostFromMcpClientInfo,
  invocationHostSummary,
} from "../lib/harnessHostProvenance.mjs";
import { handleVideoHarnessToolCall, TOOL_RESUME_VIDEO_HARNESS_JOB, TOOL_RUN_VIDEO_HARNESS } from "../lib/videoHarnessMcp.mjs";
import {
  assertVideoHarnessJobIdentity,
  createVideoHarnessJob,
  readVideoHarnessJob,
  runVideoHarnessJob,
} from "../lib/videoHarnessJob.mjs";
import { createVideoHarnessService } from "../lib/videoHarnessService.mjs";
import { cliHostInvocation } from "../scripts/run-video-harness.mjs";

// Job の仕組みを実際の宣言とスキルの上で確かめる（test/videoHarnessJob.test.mjs と同じ理由で、
// スキルの人の承認の要求だけを外す）。
process.env.BUZZASSIST_REQUIRE_SKILL_APPROVAL = "0";

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS = "narrated-story-video";

function tempRoot(t, prefix = "host-provenance-") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// ---- 判定 --------------------------------------------------------------------------

test("MCP の clientInfo からホストと版を決め、表に無いクライアントは unknown にして名前だけ残す", () => {
  assert.deepEqual(
    { ...hostFromMcpClientInfo({ name: "claude-code", version: "9.9.1" }) },
    { host: "claude-code", hostVersion: "9.9.1", clientName: "claude-code", detectedFrom: "mcp-client-info", candidates: [] },
  );
  assert.equal(hostFromMcpClientInfo({ name: "codex-mcp-client", version: "9.9.2" }).host, "codex");
  assert.equal(hostFromMcpClientInfo({ name: "antigravity-client", version: "1.0.0" }).host, "antigravity");
  const other = hostFromMcpClientInfo({ name: "synthetic-editor", version: "not a version!" });
  assert.equal(other.host, "unknown");
  assert.equal(other.clientName, "synthetic-editor");
  assert.equal(other.hostVersion, "unknown", "版の形でない文字列は版として残さない");
  assert.equal(hostFromMcpClientInfo(null), null);
  assert.equal(hostFromMcpClientInfo({ version: "1" }), null);

  // clientInfo が無い MCP 呼び出しは、MCP サーバー自身の環境を見る。印も無ければ unknown（cli ではない）。
  assert.equal(detectHostInvocation({ via: "mcp", clientInfo: null, env: { CLAUDECODE: "1" } }).host, "claude-code");
  const bare = detectHostInvocation({ via: "mcp", clientInfo: null, env: {} });
  assert.equal(bare.host, "unknown");
  assert.equal(bare.detectedFrom, "none");
});

test("CLI は環境変数の名前でホストを決め、値は記録しない。印が無ければ cli、重なれば決めない", (t) => {
  const claude = detectHostInvocation({ via: "cli", env: { CLAUDECODE: "1", AI_AGENT: "claude-code_9-9-1_harness" } });
  assert.equal(claude.host, "claude-code");
  assert.equal(claude.hostVersion, "9.9.1");
  assert.equal(claude.detectedFrom, "environment");
  assert.equal(claudeCodeVersionFromAiAgent("claude-code_9-9-1_agent"), "9.9.1");
  assert.equal(claudeCodeVersionFromAiAgent("other-agent/1.0"), "", "決まった形でなければ版を取り出さない");

  const secretThread = "synthetic-thread-value-7f3a";
  const codex = detectHostInvocation({ via: "cli", env: { CODEX_THREAD_ID: secretThread } });
  assert.equal(codex.host, "codex");
  assert.equal(codex.hostVersion, "unknown");
  assert.equal(JSON.stringify(codex).includes(secretThread), false, "環境変数の値は記録に入らない");
  assert.equal(detectHostInvocation({ via: "cli", env: { CODEX_SANDBOX: "seatbelt" } }).host, "codex");

  // npm から起動した Codex は自分の package の場所を渡す。@openai/codex の package.json のときだけ版を読む。
  const root = tempRoot(t);
  const packageRoot = path.join(root, "codex-package");
  fs.mkdirSync(packageRoot);
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@openai/codex", version: "9.9.2" }));
  const npmCodex = hostFromEnvironment({ CODEX_MANAGED_BY_NPM: "1", CODEX_MANAGED_PACKAGE_ROOT: packageRoot });
  assert.equal(npmCodex.host, "codex");
  assert.equal(npmCodex.hostVersion, "9.9.2");
  assert.equal(JSON.stringify(npmCodex).includes(packageRoot), false, "package の場所は記録しない");
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "some-other-package", version: "1.2.3" }));
  assert.equal(codexVersionFromPackageRoot(packageRoot), "", "別の package の版を Codex の版にしない");
  assert.equal(codexVersionFromPackageRoot(path.join("relative", "codex")), "", "相対の場所は読まない");

  assert.equal(detectHostInvocation({ via: "cli", env: { ANTIGRAVITY_AGENT: "1" } }).host, "antigravity");

  const nested = detectHostInvocation({ via: "cli", env: { CLAUDECODE: "1", CODEX_THREAD_ID: "x" } });
  assert.equal(nested.host, "unknown", "入れ子で起動して印が重なれば、どちらとも決めない");
  assert.equal(nested.detectedFrom, "ambiguous-environment");
  assert.deepEqual(nested.candidates, ["claude-code", "codex"]);

  const plain = detectHostInvocation({ via: "cli", env: { HOME: root, PATH: root } });
  assert.equal(plain.host, "cli");
  assert.equal(plain.detectedFrom, "none");
  assert.equal(cliHostInvocation({}, {}).host, "cli", "CLI の入口も同じ判定を使う");
});

test("モデル ID は宣言されたときだけ残し、分からなければ unknown。形の合わない宣言は拒否する", () => {
  const declared = detectHostInvocation({ via: "cli", env: {}, hostModel: "synthetic-model-a[1m]" });
  assert.equal(declared.model, "synthetic-model-a[1m]");
  assert.equal(declared.modelSource, "caller-declared");
  const none = detectHostInvocation({ via: "cli", env: {} });
  assert.equal(none.model, "unknown");
  assert.equal(none.modelSource, "unavailable");
  for (const bad of ["two words", "line\nbreak", "x".repeat(200), 42]) {
    assert.throws(() => detectHostInvocation({ via: "cli", env: {}, hostModel: bad }), new RegExp(HOST_MODEL_INVALID_CODE, "u"));
  }
  assert.throws(() => cliHostInvocation({ hostModel: true }, {}), /--host-model にはモデル ID が要る/u);
});

// ---- Job: 作ったホストと再開したホスト -----------------------------------------------------

function jobFixture(t) {
  const root = tempRoot(t, "host-provenance-job-");
  const deployment = path.join(root, "deployment");
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.mkdirSync(path.join(deployment, "production"), { recursive: true });
  fs.writeFileSync(path.join(deployment, "production", "story-harness.mjs"), "export const fixture = 1;\n");
  fs.writeFileSync(path.join(root, "script.txt"), "合成の台本です。\n");
  fs.writeFileSync(path.join(root, "pack.bundle"), "synthetic pack");
  fs.writeFileSync(path.join(root, "config", "harness-deployments.json"), `${JSON.stringify({
    deployments: [{ harnessId: HARNESS, root: "deployment", entrypoint: "node production/story-harness.mjs" }],
  }, null, 2)}\n`);
  return root;
}

function fixtureService(root, calls) {
  return createVideoHarnessService({
    env: {},
    createJob: (input) => createVideoHarnessJob({ ...input, repoRoot: root }),
    projectCanvas: async () => {},
    planPreflight: async () => null,
    preflightReviewerTrust: async () => ({ ok: true, code: "", activeReviewers: 1, source: "fixture" }),
    captureRunLearning: null,
    // 本物の Job 層を通し、doctor と adapter だけを合成にする（有料処理は無い）。
    runJob: (input) => runVideoHarnessJob({
      ...input,
      prepare: null,
      doctor: async () => ({ ready: true, blocking: [] }),
      adapter: async ({ job }) => {
        calls.push(job.metadata?.invocation?.resumedBy?.length ?? 0);
        return { status: "awaiting-human-review", knownRemainingIssues: ["synthetic-hold: 合成の停止"] };
      },
      projectCanvas: async () => {},
    }),
  });
}

test("MCP で作った Job に作ったホストが残り、別ホストの再開は別の一覧に積まれ、Job の同一性は変わらない", async (t) => {
  const root = jobFixture(t);
  const adapterCalls = [];
  const service = fixtureService(root, adapterCalls);
  const baseArgs = { projectDir: root, scriptPath: path.join(root, "script.txt"), channelPackPath: path.join(root, "pack.bundle"), harnessId: HARNESS };

  const planned = await handleVideoHarnessToolCall({
    name: TOOL_RUN_VIDEO_HARNESS,
    arguments: { ...baseArgs, hostModel: "synthetic-model-a" },
  }, { service, env: {}, clientInfo: { name: "claude-code", version: "9.9.1" } });
  const created = await readVideoHarnessJob({ projectDir: root, jobId: planned.structuredContent.jobId });
  const createdBy = created.metadata.invocation.createdBy;
  assert.equal(createdBy.host, "claude-code");
  assert.equal(createdBy.hostVersion, "9.9.1");
  assert.equal(createdBy.via, "mcp");
  assert.equal(createdBy.model, "synthetic-model-a");
  assert.equal(createdBy.modelSource, "caller-declared");
  assert.equal(createdBy.operation, "start");
  assert.equal(createdBy.mode, "plan-only");
  assert.match(createdBy.buzzassistVersion, /^\d+\.\d+\.\d+/u);
  assert.deepEqual(created.metadata.invocation.resumedBy, []);
  assert.equal(JSON.stringify(created.options).includes("synthetic-model-a"), false, "モデル ID は Job の options（同一性）に入らない");

  // Codex から MCP で再開する。同じ Job に積まれ、作った記録は書き換わらない。
  await handleVideoHarnessToolCall({
    name: TOOL_RESUME_VIDEO_HARNESS_JOB,
    arguments: { projectDir: root, jobId: created.id, confirmed: true },
  }, { service, env: {}, clientInfo: { name: "codex-mcp-client", version: "9.9.2" } });
  // 素の端末から CLI で再開する。
  await service.resume({ projectDir: root, jobId: created.id, confirmed: true, invocation: cliHostInvocation({}, {}) });

  const resumed = await readVideoHarnessJob({ projectDir: root, jobId: created.id });
  assert.deepEqual(resumed.metadata.invocation.createdBy, createdBy, "作ったホストの記録は再開で変わらない");
  assert.deepEqual(resumed.metadata.invocation.resumedBy.map((row) => [row.host, row.via, row.operation, row.model]), [
    ["codex", "mcp", "resume", "unknown"],
    ["cli", "cli", "resume", "unknown"],
  ]);
  assert.deepEqual(adapterCalls, [1, 2], "再開の記録は adapter（と Receipt の確定）より前に残る");
  assert.equal(resumed.id, created.id);
  assert.equal(resumed.identityDigest, created.identityDigest, "ホストは Job の同一性に入らない");
  await assertVideoHarnessJobIdentity(resumed);

  // 別のホストから同じ入力で start しても同じ Job に接続し、confirmed なら再開として積む。
  const attached = await service.start({
    ...baseArgs,
    confirmed: true,
    invocation: detectHostInvocation({ via: "cli", env: { ANTIGRAVITY_AGENT: "1" } }),
  });
  assert.equal(attached.attached, true);
  assert.equal(attached.jobId, created.id);
  const afterAttach = await readVideoHarnessJob({ projectDir: root, jobId: created.id });
  assert.deepEqual(afterAttach.metadata.invocation.resumedBy.at(-1).operation, "start-attached");
  assert.equal(afterAttach.metadata.invocation.resumedBy.at(-1).host, "antigravity");
  assert.equal(invocationHostSummary(afterAttach.metadata.invocation).hostKey, "antigravity+cli+codex",
    "計画だけの作成は実行に数えず、実行したホストを混在のまま並べる");

  // 形の誤った記録は Job に触る前に止める。
  await assert.rejects(
    service.resume({ projectDir: root, jobId: created.id, confirmed: true, invocation: { ...cliHostInvocation({}, {}), host: "somewhere-else" } }),
    /host invocation の host が不正/u,
  );
  const unchanged = await readVideoHarnessJob({ projectDir: root, jobId: created.id });
  assert.equal(unchanged.revision, afterAttach.revision);
});

test("入口が記録を渡さなかった Job は、作ったホストを推測せず not-provided として残す", async (t) => {
  const root = jobFixture(t);
  const { job } = await createVideoHarnessJob({
    projectDir: root,
    scriptPath: path.join(root, "script.txt"),
    channelPackPath: path.join(root, "pack.bundle"),
    harnessId: HARNESS,
    repoRoot: root,
  });
  assert.equal(job.metadata.invocation.createdBy, null);
  const service = fixtureService(root, []);
  await service.start({ projectDir: root, scriptPath: path.join(root, "script.txt"), channelPackPath: path.join(root, "pack.bundle"), harnessId: HARNESS, confirmed: true });
  const after = await readVideoHarnessJob({ projectDir: root, jobId: job.id });
  const last = after.metadata.invocation.resumedBy.at(-1);
  assert.equal(last.host, "unknown");
  assert.equal(last.detectedFrom, "not-provided");
});

test("実物の MCP サーバーは initialize の clientInfo を Job の作成まで渡す", async (t) => {
  const projectDir = tempRoot(t, "host-provenance-mcp-");
  fs.writeFileSync(path.join(projectDir, "script.txt"), "合成の台本です。\n");
  fs.writeFileSync(path.join(projectDir, "pack.bundle"), "synthetic pack");
  const client = new Client({ name: "claude-code", version: "9.9.1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(SOURCE_ROOT, "mcp", "server.mjs")],
    cwd: SOURCE_ROOT,
    env: {
      ...process.env,
      BUZZASSIST_REQUIRE_SKILL_APPROVAL: "0",
      EXCALIDRAW_NO_AUTO_OPEN: "1",
      EXCALIDRAW_PROJECT_DIR: projectDir,
      EXCALIDRAW_CANVAS_DIR: path.join(projectDir, "canvas"),
    },
    stderr: "pipe",
  });
  t.after(() => client.close().catch(() => {}));
  await client.connect(transport);
  const result = await client.callTool({
    name: TOOL_RUN_VIDEO_HARNESS,
    arguments: {
      projectDir,
      scriptPath: path.join(projectDir, "script.txt"),
      channelPackPath: path.join(projectDir, "pack.bundle"),
      harnessId: HARNESS,
      hostModel: "synthetic-model-a",
    },
  });
  assert.equal(result.isError, undefined, JSON.stringify(result).slice(0, 2000));
  assert.equal(result.structuredContent.execution.planOnly, true, "有料処理へは進まない");
  const job = await readVideoHarnessJob({ projectDir, jobId: result.structuredContent.jobId });
  assert.equal(job.metadata.invocation.createdBy.host, "claude-code");
  assert.equal(job.metadata.invocation.createdBy.hostVersion, "9.9.1");
  assert.equal(job.metadata.invocation.createdBy.model, "synthetic-model-a");
  assert.equal(job.metadata.invocation.createdBy.via, "mcp");
  assert.equal(job.runDir, path.join(projectDir, "canvas", "harness-runs", job.id));
});
