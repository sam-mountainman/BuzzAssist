// チャンネルの plan-request を CLI（run-video-harness plan-request --channel）と MCP（plan_video_request の
// channelId）で呼んで同じ結果になること、CLI の start --channel が requireBrief で止まること、MCP の
// run_video_harness の channelId が台帳の作業フォルダを使うことの試験。台帳は環境変数
// BUZZASSIST_CHANNEL_REGISTRY で渡す（端末の本物の配置表は読まない）。チャンネル・台本・ブリーフは合成。
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { createChannelPackEnvelope } from "../lib/channelPackEnvelope.mjs";
import { CHANNEL_REGISTRY_PATH_ENV } from "../lib/channelRegistry.mjs";
import { TOOL_PLAN_VIDEO_REQUEST, TOOL_RUN_VIDEO_HARNESS, handleVideoHarnessToolCall } from "../lib/videoHarnessMcp.mjs";
import { recordStrategyBriefRound, startStrategyBriefLoop } from "../lib/strategyBriefQualityLoop.mjs";
import { evidenceRow, jsonBytes, metricsOutput, sampleBrief, sha, writeJson } from "./helpers/strategyBriefFixture.mjs";

const execFile = promisify(execFileCallback);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const now = () => "2026-09-26T09:00:00.000Z";

function childEnv(extra = {}) {
  const env = { ...process.env };
  for (const name of ["BUZZASSIST_CHANNEL_PACK_PUBLIC_KEY", "BUZZASSIST_CHANNEL_PACK_PUBLIC_KEY_PEM", "BUZZASSIST_LEARNING_DIR", CHANNEL_REGISTRY_PATH_ENV, "BUZZASSIST_CHANNEL_PACK", "BUZZASSIST_CHANNEL_PACK_ID"]) delete env[name];
  return { ...env, ...extra };
}

async function createFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "channel-plan-cli-mcp-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pair = generateKeyPairSync("ed25519");
  const key = {
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }),
  };
  const source = path.join(root, "pack-source");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "synthetic.json"), "{}\n");
  const alphaPack = path.join(root, "alpha", "pack");
  await createChannelPackEnvelope({ sourceDir: source, outputDir: alphaPack, id: "synthetic-alpha", version: "1.0.0", harnessId: "narrated-story-video", ...key, createdAt: "2026-09-25T00:00:00.000Z" });
  const channels = [
    {
      id: "alpha",
      projectDir: path.join(root, "alpha", "project"),
      channelPack: alphaPack,
      production: { kind: "harness", harnessId: "narrated-story-video" },
      strategy: { workDir: path.join(root, "alpha", "strategy"), requireBrief: true },
      scriptQuality: { genre: "narrated-story" },
    },
    {
      id: "gamma",
      projectDir: path.join(root, "gamma", "project"),
      channelPack: path.join(root, "gamma", "pack"),
      production: { kind: "external", note: "合成: チャンネルの既存の書き出しの仕組み" },
      strategy: { workDir: path.join(root, "gamma", "strategy"), requireBrief: false },
    },
  ];
  for (const channel of channels) {
    fs.mkdirSync(channel.projectDir, { recursive: true });
    fs.mkdirSync(channel.strategy.workDir, { recursive: true });
  }
  const registryPath = path.join(root, "channel-registry.json");
  fs.writeFileSync(registryPath, JSON.stringify({ channels }, null, 2));
  const script = path.join(channels[0].projectDir, "script.md");
  fs.writeFileSync(script, "# 本編\n合成の台本。\n");
  const env = childEnv({
    BUZZASSIST_CHANNEL_PACK_PUBLIC_KEY_PEM: key.publicKeyPem,
    BUZZASSIST_LEARNING_DIR: path.join(root, "learning"),
    [CHANNEL_REGISTRY_PATH_ENV]: registryPath,
    BUZZASSIST_REQUIRE_SKILL_APPROVAL: "0",
  });
  return { root, channels, registryPath, script, env, alpha: channels[0] };
}

async function passedBrief(workDir) {
  const metrics = await writeJson(workDir, "evidence/metrics.json", metricsOutput());
  const bytes = jsonBytes(sampleBrief({
    channel: { id: "alpha", designVersion: "design-v1" },
    evidence: [evidenceRow(metrics, { id: "e-metrics", kind: "metrics", premiseBound: false, premiseIndependenceReason: "合成: 公開済みの動画の実測" })],
    changes: { previous: null, keep: [{ point: "合成の残す点", evidenceIds: ["e-metrics"] }], change: [] },
  }));
  fs.writeFileSync(path.join(workDir, "brief.json"), bytes);
  await startStrategyBriefLoop({ workDir, generatorContextId: "ctx-planner-1", now });
  const review = await writeJson(workDir, "quality/reviews/r1.json", {
    evaluatorId: "evaluator",
    evaluatorContextId: "ctx-eval-1",
    evaluatorHost: "codex",
    briefSha256: sha(bytes),
    rubricScores: { "single-question": 92, "audience-specificity": 92, "promise-payoff": 92, "evidence-honesty": 92, "change-grounding": 92, producibility: 92 },
    notes: "合成: ブリーフと根拠のファイルを開いて照合した",
    findings: [],
  });
  await recordStrategyBriefRound({ workDir, briefPath: "brief.json", reviewPath: review.rel, now });
  return path.join(workDir, "brief.json");
}

test("MCP（plan_video_request の channelId）と CLI（plan-request --channel）は同じ結果を返す", async (t) => {
  const fixture = await createFixture(t);
  const briefPath = await passedBrief(fixture.alpha.strategy.workDir);
  const cases = [
    { channelId: "alpha", request: "次の動画の企画をお願いします", scriptPath: fixture.script },
    { channelId: "alpha", request: "確定稿から動画を作って", scriptPath: fixture.script, strategyBriefPath: briefPath },
    { channelId: "alpha", request: "台本を添削して、確定稿で制作に進みたい" },
    { channelId: "alpha", request: "台本を添削して、確定稿で制作に進みたい", requestKind: "script-review", scriptPath: fixture.script },
    { channelId: "gamma", request: "確定稿から動画を作って" },
  ];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(REPO_ROOT, "mcp", "server.mjs")],
    cwd: REPO_ROOT,
    env: {
      ...fixture.env,
      CODEX: "1",
      EXCALIDRAW_NO_AUTO_OPEN: "1",
      EXCALIDRAW_PROJECT_DIR: fixture.root,
      EXCALIDRAW_CANVAS_DIR: path.join(fixture.root, "canvas"),
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "channel-plan-cli-mcp-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    for (const entry of cases) {
      const mcp = await client.callTool({ name: TOOL_PLAN_VIDEO_REQUEST, arguments: { ...entry, projectDir: fixture.root } });
      assert.equal(mcp.isError, undefined, JSON.stringify(mcp));
      const argv = [path.join(REPO_ROOT, "scripts", "run-video-harness.mjs"), "plan-request", "--channel", entry.channelId, "--request", entry.request, "--project-dir", fixture.root];
      if (entry.scriptPath) argv.push("--script-path", entry.scriptPath);
      if (entry.strategyBriefPath) argv.push("--strategy-brief", entry.strategyBriefPath);
      if (entry.requestKind) argv.push("--request-kind", entry.requestKind);
      const { stdout } = await execFile(process.execPath, argv, { cwd: REPO_ROOT, env: fixture.env, maxBuffer: 16 * 1024 * 1024 });
      const cli = JSON.parse(stdout);
      assert.deepEqual(mcp.structuredContent, cli, `${entry.channelId}: ${entry.request}`);
      assert.equal(mcp.content[0].text, mcp.structuredContent.summaryLines.join("\n"));
      assert.equal(cli.records.channelRegistry.source, "env");
      assert.equal(cli.channel.id, entry.channelId);
    }
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
});

test("CLI の start --channel: requireBrief のチャンネルは合格したブリーフが無ければ Job を作らずに止まる", async (t) => {
  const fixture = await createFixture(t);
  const argv = [path.join(REPO_ROOT, "scripts", "run-video-harness.mjs"), "start", "--channel", "alpha", "--script-path", fixture.script];
  await assert.rejects(
    execFile(process.execPath, argv, { cwd: REPO_ROOT, env: fixture.env, maxBuffer: 16 * 1024 * 1024 }),
    (error) => error.code === 1 && /channel-strategy-brief-required/u.test(error.stderr) && /hyp-design/u.test(error.stderr),
  );
  assert.equal(fs.existsSync(path.join(fixture.alpha.projectDir, "canvas", "harness-runs")), false, "Job を作らない");
  // 外部の制作のチャンネルは start しない。
  await assert.rejects(
    execFile(process.execPath, [path.join(REPO_ROOT, "scripts", "run-video-harness.mjs"), "start", "--channel", "gamma", "--script-path", fixture.script], { cwd: REPO_ROOT, env: fixture.env }),
    (error) => /channel-production-external/u.test(error.stderr),
  );
});

test("MCP の run_video_harness: channelId だけなら台帳の作業フォルダを使い、相対 path もそこから解決する", async (t) => {
  const fixture = await createFixture(t);
  const calls = [];
  const service = { start: async (args) => { calls.push(args); return { operation: "start", jobId: "video-synthetic-0123456789abcdef", status: "planned", execution: { planOnly: true } }; } };
  const loadRegistry = async ({ env }) => {
    const { loadRuntimeChannelRegistry } = await import("../lib/channelStartGate.mjs");
    return loadRuntimeChannelRegistry({ env });
  };
  await handleVideoHarnessToolCall({
    name: TOOL_RUN_VIDEO_HARNESS,
    arguments: { channelId: "alpha", scriptPath: "script.md", strategyBriefPath: "../strategy/brief.json" },
  }, { service, env: { [CHANNEL_REGISTRY_PATH_ENV]: fixture.registryPath, EXCALIDRAW_PROJECT_DIR: fixture.root }, channelRegistry: loadRegistry });
  assert.equal(calls[0].channelId, "alpha");
  assert.equal(calls[0].projectDir, fixture.alpha.projectDir);
  assert.equal(calls[0].scriptPath, path.join(fixture.alpha.projectDir, "script.md"));
  assert.equal(calls[0].strategyBriefPath, path.join(fixture.alpha.strategy.workDir, "brief.json"));
  // projectDir を明示したらそのまま渡す（台帳との照合は service がする）。
  await handleVideoHarnessToolCall({
    name: TOOL_RUN_VIDEO_HARNESS,
    arguments: { channelId: "alpha", projectDir: fixture.root, scriptPath: "script.md" },
  }, { service, env: { [CHANNEL_REGISTRY_PATH_ENV]: fixture.registryPath }, channelRegistry: loadRegistry });
  assert.equal(calls[1].projectDir, fixture.root);
  // 台帳に無いチャンネルは止める。
  await assert.rejects(
    handleVideoHarnessToolCall({ name: TOOL_RUN_VIDEO_HARNESS, arguments: { channelId: "synthetic-missing", scriptPath: "script.md" } }, { service, env: { [CHANNEL_REGISTRY_PATH_ENV]: fixture.registryPath }, channelRegistry: loadRegistry }),
    { code: "channel-unknown" },
  );
});
