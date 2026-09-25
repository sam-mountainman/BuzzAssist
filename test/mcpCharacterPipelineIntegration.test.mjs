import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// MCP の要求の制限時間。SDK の既定（DEFAULT_REQUEST_TIMEOUT_MSEC）は要求1件につき 60 秒で、作業の大きさと
// 関係がない。この試験の1件は、候補6枚の生成（偽の画像ブリッジを6本同時に起動する）と、Python の人物監査を
// 何本も続けて呼ぶ。単独では1件 2〜5 秒・全体 9 秒前後だが、別の試験が並列で走っている端末では同じ1件が
// 60 秒を超え、`MCP error -32001: Request timed out` で落ちた（全体 81 秒）。同じ試験を 8 本並列で回すと、
// 全体が 169 秒まで延びた（負荷の平均 180 超）。止まったときに気づけるよう上限は残し、作業に見合う長さにする。
const MCP_REQUEST_OPTIONS = { timeout: 5 * 60_000 };

async function passCandidateReview(pathname, castName) {
  const review = JSON.parse(await readFile(pathname, "utf8"));
  review.reviewer = { host: "codex", id: "candidate-reviewer", contextId: `candidate-review-${castName}`, reviewedAt: new Date().toISOString() };
  review.originalScaleInspected = true;
  for (const candidate of review.candidates) {
    candidate.faceRegionReviewed = true;
    candidate.manualFaceRegion = [0, 0, Math.max(1, candidate.width), Math.max(1, candidate.height)];
  }
  for (const pair of review.pairChecks) {
    pair.visualAxes.faceShapeDistinct = true;
    pair.visualAxes.hairSilhouetteDistinct = true;
    pair.pass = true;
    pair.note = "原寸で顔型と髪シルエットを比較済み";
  }
  review.pass = true;
  review.notes = "三候補の実画像差を確認";
  await writeFile(pathname, `${JSON.stringify(review, null, 2)}\n`);
}

async function passIdentityReview(pathname, castName) {
  const review = JSON.parse(await readFile(pathname, "utf8"));
  const passCell = (cell, extra = {}) => Object.assign(cell, {
    sameIdentity: true,
    ageConsistent: true,
    hairConsistent: true,
    faceContourConsistent: true,
    faceRegionReviewed: true,
    manualFaceRegion: [0, 0, cell.width, cell.height],
    pass: true,
    note: "原寸確認済み",
    ...extra,
  });
  review.reviewer = { host: "codex", id: "identity-reviewer", contextId: `identity-review-${castName}`, reviewedAt: new Date().toISOString() };
  review.originalScaleInspected = true;
  Object.assign(review.turnaround, { isRealTurnaround: true, notCandidateSubstitute: true, pass: true, note: "8方向を原寸確認" });
  review.turnaround.grid.alignmentConfirmed = true;
  for (const row of review.turnaround.viewChecks) passCell(row);
  Object.assign(review.expression, { pass: true, note: "12セルを原寸確認" });
  review.expression.grid.alignmentConfirmed = true;
  for (const row of review.expression.cells) passCell(row);
  for (const sheet of review.extraSheets) {
    Object.assign(sheet, { sameIdentity: true, pass: true, note: "同一人物差分" });
    sheet.grid.alignmentConfirmed = true;
    for (const cell of sheet.cells) passCell(cell, { stateMatchesSpecification: true });
  }
  for (const sheet of review.outfitSheets) {
    Object.assign(sheet, { sameIdentity: true, outfitMatchesSpecification: true, pass: true, note: "衣装一致" });
    sheet.grid.alignmentConfirmed = true;
    for (const cell of sheet.cells) passCell(cell, { outfitMatchesSpecification: true });
  }
  review.pass = true;
  review.notes = "人物登録可";
  await writeFile(pathname, `${JSON.stringify(review, null, 2)}\n`);
}

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
      // 画像ブリッジの命令は `$SHELL -lc` で起動される（lib/mediaGeneration.mjs の runShellBridge）。
      // 開発者のログインシェル（zsh の profile など）を読むと、偽のブリッジ1本ごとに起動が 0.4 秒ほど
      // 延び、この試験の12本ぶんが端末の設定しだいで変わる。偽のブリッジは profile を要らないので、
      // 何も読まない /bin/sh で起動する。
      SHELL: "/bin/sh",
    },
    stderr: "pipe",
  });
  const callTool = (params) => client.callTool(params, undefined, MCP_REQUEST_OPTIONS);

  try {
    await client.connect(transport, MCP_REQUEST_OPTIONS);
    const analyzed = await callTool({
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

    const candidates = await callTool({
      name: "generate_character_candidates",
      arguments: {
        projectDir,
        canvasDir,
        workflowId,
        generatorContextId: "candidate-generator-e2e",
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
      await passCandidateReview(cast.candidateReviewDraftPath, cast.id);
      const approved = await callTool({
        name: "approve_character_candidate",
        arguments: {
          projectDir,
          canvasDir,
          workflowId,
          castId: cast.id,
          candidateLabel: selected.label,
          approvalReason: `${cast.name}の役割と固定特徴が最も明瞭に出ているため`,
          approvedBy: "integration-test-user",
          candidateReviewPath: cast.candidateReviewDraftPath,
          generatorContextId: `identity-generator-${cast.id}`,
          model: "gpt-image-2-codex",
          aspectRatio: "16:9",
          imageSize: "2K",
          quality: "high",
          confirmedSettings: true,
        },
      });
      assert.equal(approved.isError, undefined, JSON.stringify(approved));
      assert.equal(approved.structuredContent.cast.status, "awaiting-identity-qa");
      assert.equal(approved.structuredContent.cast.approval.approvedBy, "integration-test-user");
      assert.match(approved.structuredContent.cast.approval.reason, /固定特徴/);
      await passIdentityReview(approved.structuredContent.identityReviewDraftPath, cast.id);
      const registered = await callTool({
        name: "register_character_identity",
        arguments: {
          projectDir,
          canvasDir,
          workflowId,
          castId: cast.id,
          identityReviewPath: approved.structuredContent.identityReviewDraftPath,
        },
      });
      assert.equal(registered.isError, undefined, JSON.stringify(registered));
      assert.equal(registered.structuredContent.character.referenceImagePaths.length, 3);
      assert.match(registered.structuredContent.character.approval.identityReviewSha256, /^[a-f0-9]{64}$/u);
    }

    const storyboard = await callTool({
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

    const missingVariant = await callTool({
      name: "generate_character_storyboard",
      arguments: {
        projectDir,
        canvasDir,
        workflowId,
        scenes: [{ prompt: "高品質な青年漫画。田中が目を見開く。", characters: ["田中"], eyeOpenVariant: "open-angry" }],
        model: "gpt-image-2-codex",
        aspectRatio: "16:9",
        imageSize: "2K",
        quality: "high",
        confirmedSettings: true,
      },
    });
    assert.equal(missingVariant.isError, true, JSON.stringify(missingVariant));
    assert.match(missingVariant.content[0].text, /no approved eye-open sheet for variant 'open-angry'/u);

    const registry = JSON.parse(await readFile(path.join(canvasDir, "characters.json"), "utf8"));
    assert.equal(registry.characters.length, 2);
    assert.ok(registry.characters.every((character) => character.referenceImagePaths.length === 3));
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
