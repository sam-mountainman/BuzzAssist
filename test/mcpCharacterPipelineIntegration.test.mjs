import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("MCP character pipeline runs candidates, approval packs, and a multi-character storyboard end to end", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-character-e2e-"));
  const canvasDir = path.join(projectDir, "canvas");
  const fixturePath = fileURLToPath(new URL("./fixtures/fakeImageBridge.mjs", import.meta.url));
  const client = new Client({ name: "buzzassist-character-e2e", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repoRoot, "mcp", "server.mjs")],
    cwd: repoRoot,
    env: {
      ...process.env,
      CODEX: "1",
      EXCALIDRAW_NO_AUTO_OPEN: "1",
      EXCALIDRAW_PROJECT_DIR: projectDir,
      EXCALIDRAW_CANVAS_DIR: canvasDir,
      EXCALIDRAW_GPT_IMAGE_2_CODEX_COMMAND: `"${process.execPath}" "${fixturePath}"`,
    },
    stderr: "pipe",
  });

  try {
    await client.connect(transport);
    const analyzed = await client.callTool({
      name: "analyze_character_script",
      arguments: {
        projectDir,
        canvasDir,
        episodeId: "e2e-episode",
        title: "漫画キャラE2E",
        scriptText: "田中：残業はつらい。\n佐藤：私が助けます。",
        candidateCount: 3,
        cast: [
          { name: "田中", description: "28歳、黒髪で冴えない会社員。", invariants: ["黒い短髪", "紺色スーツ"] },
          { name: "佐藤", role: "fixed", description: "55歳、落ち着いた助っ人。", invariants: ["短い白髪", "銀縁眼鏡"] },
        ],
      },
    });
    assert.equal(analyzed.isError, undefined, JSON.stringify(analyzed));
    const workflowId = analyzed.structuredContent.workflow.id;

    const candidates = await client.callTool({
      name: "generate_character_candidates",
      arguments: {
        projectDir,
        canvasDir,
        workflowId,
        model: "gpt-image-2-codex",
        aspectRatio: "16:9",
        imageSize: "2K",
        quality: "high",
        confirmedSettings: true,
      },
    });
    assert.equal(candidates.isError, undefined, JSON.stringify(candidates));
    assert.equal(candidates.structuredContent.total, 6);
    assert.equal(candidates.structuredContent.succeeded, 6);
    assert.equal(candidates.structuredContent.workflow.status, "awaiting-approval");

    for (const cast of candidates.structuredContent.workflow.cast) {
      const selected = cast.candidates[1];
      const approved = await client.callTool({
        name: "approve_character_candidate",
        arguments: {
          projectDir,
          canvasDir,
          workflowId,
          castId: cast.id,
          candidateLabel: selected.label,
          approvalReason: `${cast.name}の役割と固定特徴が最も明瞭に出ているため`,
          approvedBy: "integration-test-user",
          model: "gpt-image-2-codex",
          aspectRatio: "16:9",
          imageSize: "2K",
          quality: "high",
          confirmedSettings: true,
        },
      });
      assert.equal(approved.isError, undefined, JSON.stringify(approved));
      assert.equal(approved.structuredContent.character.referenceImagePaths.length, 2);
      assert.equal(approved.structuredContent.character.approval.approvedBy, "integration-test-user");
      assert.match(approved.structuredContent.character.approval.reason, /固定特徴/);
    }

    const storyboard = await client.callTool({
      name: "generate_character_storyboard",
      arguments: {
        projectDir,
        canvasDir,
        workflowId,
        scenes: [
          { prompt: "高品質な青年漫画。オフィスで田中と佐藤が向かい合う。", characters: ["田中", "佐藤"] },
          { prompt: "高品質な青年漫画。田中が一人で契約書を読む。", characters: ["田中"] },
        ],
        model: "gpt-image-2-codex",
        aspectRatio: "16:9",
        imageSize: "2K",
        quality: "high",
        confirmedSettings: true,
      },
    });
    assert.equal(storyboard.isError, undefined, JSON.stringify(storyboard));
    assert.equal(storyboard.structuredContent.succeeded, 2);
    assert.match(storyboard.structuredContent.validation.warnings.join("\n"), /identity-mixing risk/);

    const registry = JSON.parse(await readFile(path.join(canvasDir, "characters.json"), "utf8"));
    assert.equal(registry.characters.length, 2);
    assert.ok(registry.characters.every((character) => character.referenceImagePaths.length === 2));
    assert.equal(registry.characters.find((character) => character.name === "佐藤").role, "fixed");
    assert.equal(registry.characters.find((character) => character.name === "田中").episodeId, "e2e-episode");

    const workflowStore = JSON.parse(await readFile(path.join(canvasDir, "character-workflows.json"), "utf8"));
    const finalWorkflow = workflowStore.workflows.find((workflow) => workflow.id === workflowId);
    assert.equal(finalWorkflow.status, "ready");
    assert.equal(finalWorkflow.scenes.length, 2);

    const canvas = JSON.parse(await readFile(path.join(canvasDir, "excalidraw-canvas.json"), "utf8"));
    const candidateElements = canvas.elements.filter((element) => element.customData?.buzzassistCharacterCandidate === true && !element.isDeleted);
    const expressionElements = canvas.elements.filter((element) => element.customData?.buzzassistCharacterExpressionSheet === true && !element.isDeleted);
    const sceneElements = canvas.elements.filter((element) => element.customData?.buzzassistCharacterScene === true && !element.isDeleted);
    assert.equal(candidateElements.length, 6);
    assert.equal(expressionElements.length, 2);
    assert.equal(sceneElements.length, 2);
    assert.equal(candidateElements.filter((element) => element.customData.buzzassistCharacterApprovalStatus === "selected").length, 2);
    assert.ok(candidateElements.filter((element) => element.customData.buzzassistCharacterApprovalStatus === "selected").every((element) => element.strokeColor === "#22c55e"));
    const groupScene = sceneElements.find((element) => element.customData.generatorCharacterIds?.length === 2);
    assert.ok(groupScene);
    assert.match(groupScene.customData.generatorResolvedPrompt, /Never blend faces, hair, clothing/);
    assert.match(groupScene.customData.generatorResolvedPrompt, /田中/);
    assert.match(groupScene.customData.generatorResolvedPrompt, /佐藤/);
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    await rm(projectDir, { recursive: true, force: true });
  }
});
