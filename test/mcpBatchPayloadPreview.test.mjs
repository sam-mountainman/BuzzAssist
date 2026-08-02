import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("MCP batch payload previews validate and do not start or mutate a canvas", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-batch-preview-"));
  const canvasDir = path.join(projectDir, "canvas");
  const identityOne = path.join(canvasDir, "assets", "characters", "hero-identity.png");
  const identityTwo = path.join(canvasDir, "assets", "characters", "hero-expressions.png");
  const styleOne = path.join(canvasDir, "assets", "style-references", "linework.png");
  const styleTwo = path.join(canvasDir, "assets", "style-references", "lighting.png");
  await mkdir(path.dirname(identityOne), { recursive: true });
  await mkdir(path.dirname(styleOne), { recursive: true });
  await writeFile(path.join(canvasDir, "characters.json"), `${JSON.stringify({
    characters: [{
      id: "hero",
      name: "主人公",
      kind: "character",
      role: "fixed",
      status: "approved",
      description: "A newly designed protagonist who must not resemble a style-reference person.",
      invariants: ["short black hair", "navy jacket"],
      referenceImagePaths: [
        "assets/characters/hero-identity.png",
        "assets/characters/hero-expressions.png",
      ],
    }],
    voices: [],
  }, null, 2)}\n`, "utf8");
  const client = new Client({ name: "buzzassist-batch-preview-test", version: "1.0.0" });
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
    },
    stderr: "pipe",
  });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    for (const name of [
      "generate_excalidraw_images_batch",
      "generate_excalidraw_videos_batch",
      "analyze_character_script",
      "get_character_pipeline",
      "generate_character_candidates",
      "approve_character_candidate",
      "generate_character_storyboard",
    ]) {
      const tool = tools.tools.find((candidate) => candidate.name === name);
      assert.ok(tool, `${name} should be registered`);
      if (name.startsWith("generate_") || name === "approve_character_candidate") {
        assert.ok(tool.inputSchema.properties.payloadPreview, `${name} should accept payloadPreview`);
      }
    }

    const analyzed = await client.callTool({
      name: "analyze_character_script",
      arguments: {
        scriptText: "田中：残業はつらい。\n佐藤：私が助けます。",
        episodeId: "preview-episode",
        candidateCount: 3,
        projectDir,
        canvasDir,
      },
    });
    assert.equal(analyzed.isError, undefined, JSON.stringify(analyzed));
    assert.equal(analyzed.structuredContent.workflow.cast.length, 2);

    const candidatePreview = await client.callTool({
      name: "generate_character_candidates",
      arguments: {
        workflowId: analyzed.structuredContent.workflow.id,
        payloadPreview: true,
        projectDir,
        canvasDir,
      },
    });
    assert.equal(candidatePreview.isError, undefined, JSON.stringify(candidatePreview));
    assert.equal(candidatePreview.structuredContent.payloadPreview, true);
    assert.equal(candidatePreview.structuredContent.total, 6);
    assert.ok(candidatePreview.structuredContent.results.every((result) => result.local === true));

    const imagePreview = await client.callTool({
      name: "generate_excalidraw_images_batch",
      arguments: {
        payloadPreview: true,
        referenceImagePaths: ["/tmp/shared-character.png"],
        jobs: [
          { prompt: "local image", model: "gpt-image-2-codex", aspectRatio: "1:1" },
          { prompt: "cloud image", model: "nano-banana-2", aspectRatio: "16:9", imageSize: "2K" },
        ],
      },
    });
    assert.equal(imagePreview.isError, undefined, JSON.stringify(imagePreview));
    assert.equal(imagePreview.structuredContent.payloadPreview, true);
    assert.equal(imagePreview.structuredContent.total, 2);
    assert.equal(imagePreview.structuredContent.results[1].body.image_urls[0], "https://preview.invalid/image/shared-character.png");

    const identityBeforeStylePreview = await client.callTool({
      name: "generate_excalidraw_images_batch",
      arguments: {
        payloadPreview: true,
        projectDir,
        canvasDir,
        jobs: [{
          prompt: "Render the registered hero in the channel style while preserving a distinct new identity.",
          model: "nano-banana-2",
          aspectRatio: "16:9",
          characterIds: ["hero"],
          referenceImagePaths: [styleOne, styleTwo],
          customData: {
            buzzassistStyleReferencePaths: [styleOne, styleTwo],
          },
        }],
      },
    });
    assert.equal(identityBeforeStylePreview.isError, undefined, JSON.stringify(identityBeforeStylePreview));
    const identityBeforeStyleResult = identityBeforeStylePreview.structuredContent.results[0];
    assert.deepEqual(identityBeforeStyleResult.body.image_urls, [
      "https://preview.invalid/image/hero-identity.png",
      "https://preview.invalid/image/hero-expressions.png",
      "https://preview.invalid/image/linework.png",
      "https://preview.invalid/image/lighting.png",
    ]);
    assert.match(identityBeforeStyleResult.body.prompt, /reference images 1-2 only for this character/i);
    assert.match(identityBeforeStyleResult.body.prompt, /Reference images 3-4 are CHANNEL STYLE-ONLY references/);
    assert.match(identityBeforeStyleResult.body.prompt, /Do not reproduce any person, face, hairstyle, clothing/);

    const videoPreview = await client.callTool({
      name: "generate_excalidraw_videos_batch",
      arguments: {
        payloadPreview: true,
        jobs: [
          { prompt: "local video", model: "grok-imagine-video-hermes", duration: "6" },
          { prompt: "cloud video", model: "seedance-2-fast", duration: "5", resolution: "720p" },
        ],
      },
    });
    assert.equal(videoPreview.isError, undefined, JSON.stringify(videoPreview));
    assert.equal(videoPreview.structuredContent.payloadPreview, true);
    assert.equal(videoPreview.structuredContent.total, 2);
    assert.equal(videoPreview.structuredContent.results[1].endpoint, "bytedance/seedance-2.0/fast/text-to-video");

    await assert.rejects(access(path.join(canvasDir, ".server.json")));
    await assert.rejects(access(path.join(canvasDir, "excalidraw-canvas.json")));
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    await rm(projectDir, { recursive: true, force: true });
  }
});
