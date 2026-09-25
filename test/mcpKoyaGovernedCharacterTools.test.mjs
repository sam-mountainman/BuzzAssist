// MCP の汎用の人物登録（approve_character_candidate / register_character_identity）は finalizeApprovedCharacter を
// 直接呼ぶので、Koya の公式経路の対象のプロジェクトで使うと、契約 v54 の identity pack の各シートの
// 品質ループを迂回できた。対象のプロジェクトでは公式の action（character-approve / character-register）へ
// 案内して止め、対象でないプロジェクトでは従来どおり動く。プロジェクト・workflow・人物はすべて合成の値。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function connect(t, projectDir) {
  const client = new Client({ name: "buzzassist-koya-governed-character", version: "1.0.0" });
  const env = { ...process.env, CODEX: "1", EXCALIDRAW_NO_AUTO_OPEN: "1", EXCALIDRAW_PROJECT_DIR: projectDir, EXCALIDRAW_CANVAS_DIR: path.join(projectDir, "canvas") };
  delete env.BUZZASSIST_CHANNEL_PACK;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repoRoot, "mcp", "server.mjs")],
    cwd: repoRoot,
    env,
    stderr: "pipe",
  });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

function errorText(result) {
  return (result.content || []).map((entry) => entry.text || "").join("\n");
}

test("Koya の公式経路の対象のプロジェクトでは、MCP の汎用の人物登録・候補承認が公式の action へ案内して止まる", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-koya-governed-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await mkdir(path.join(projectDir, "canvas"), { recursive: true });
  await mkdir(path.join(projectDir, "channel-packs", "synthetic-pack", "config"), { recursive: true });
  await writeFile(path.join(projectDir, "channel-packs", "synthetic-pack", "config", "koya-show-bible.json"), "{}\n");
  const client = await connect(t, projectDir);

  const registered = await client.callTool({
    name: "register_character_identity",
    arguments: { projectDir, workflowId: "synthetic-workflow", castId: "synthetic-cast", identityReviewPath: path.join(projectDir, "canvas", "review.json") },
  });
  assert.equal(registered.isError, true);
  assert.match(errorText(registered), /公式経路の対象/u);
  assert.match(errorText(registered), /run_koya_manga_pipeline の action "character-register"/u);

  const approved = await client.callTool({
    name: "approve_character_candidate",
    arguments: {
      projectDir,
      workflowId: "synthetic-workflow",
      castId: "synthetic-cast",
      candidateLabel: "A",
      approvalReason: "合成の理由で選んだ",
      candidateReviewPath: path.join(projectDir, "canvas", "candidate-review.json"),
      generatorContextId: "ctx-synthetic-generator",
      payloadPreview: true,
    },
  });
  assert.equal(approved.isError, true);
  assert.match(errorText(approved), /run_koya_manga_pipeline の action "character-approve"/u);
});

test("Koya の公式経路の対象でないプロジェクトでは、MCP の汎用の人物登録は従来どおり処理へ進む", async (t) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-generic-character-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await mkdir(path.join(projectDir, "canvas"), { recursive: true });
  const client = await connect(t, projectDir);
  const registered = await client.callTool({
    name: "register_character_identity",
    arguments: { projectDir, workflowId: "synthetic-workflow", castId: "synthetic-cast", identityReviewPath: path.join(projectDir, "canvas", "review.json") },
  });
  // ルーティングでは止まらず、汎用の処理（workflow の読み込み）まで進んで、その理由で落ちる。
  assert.equal(registered.isError, true);
  assert.doesNotMatch(errorText(registered), /公式経路の対象/u);
  assert.match(errorText(registered), /workflow/iu);
});
