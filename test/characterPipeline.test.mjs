import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildCharacterCandidateJobs,
  buildCharacterStoryboardJobs,
  buildExpressionSheetJob,
  extractCastFromScript,
  finalizeApprovedCharacter,
  getCharacterWorkflow,
  markCharacterCandidatesGenerating,
  prepareCharacterWorkflow,
  readCharacterWorkflowStore,
  recordCharacterCandidateResults,
  validateStoryboardCharacterBindings,
} from "../lib/characterPipeline.mjs";
import { readCharacterRegistry, writeCharacterRegistry } from "../lib/characterRegistry.mjs";

const SAMPLE_SCRIPT = `
【ナレーション】会社員の田中は今日も残業していた。
田中：また部長に無茶を言われたよ。
黒川部長「口答えするな」
BGM：緊張感のある音楽
佐藤（助っ人）：その契約書、私に見せてください。
田中：佐藤さん、助かります。
`;

test("script cast extraction keeps visual speakers and accepts explicit character details", () => {
  const cast = extractCastFromScript(SAMPLE_SCRIPT, {
    cast: [
      {
        name: "田中",
        description: "28歳、黒髪、冴えない会社員。",
        invariants: ["黒い短髪", "紺色スーツ"],
      },
      {
        name: "固定の案内役",
        role: "fixed",
        description: "各動画に出る案内役。",
      },
    ],
  });

  assert.deepEqual(cast.map((entry) => entry.name), ["田中", "黒川部長", "佐藤", "固定の案内役"]);
  assert.equal(cast.find((entry) => entry.name === "田中").description, "28歳、黒髪、冴えない会社員。");
  assert.deepEqual(cast.find((entry) => entry.name === "田中").invariants, ["黒い短髪", "紺色スーツ"]);
  assert.equal(cast.find((entry) => entry.name === "固定の案内役").role, "fixed");
  assert.ok(!cast.some((entry) => entry.name === "ナレーション" || entry.name === "BGM"));
});

test("script cast extraction ignores title and cut headers and trims punctuation before dialogue quotes", () => {
  const script = `
タイトル：契約書の罠を見抜いた助っ人

【カット1：夜のオフィス】
ナレーション：田中だけが残業していた。
田中 悠斗：「また僕だけ残業か……」

【カット2：黒川が契約書を投げる】
黒川 部長：「今夜中に送れ」
佐藤 誠司：「送る前に見せてください」
`;
  const cast = extractCastFromScript(script, {
    cast: [
      { name: "田中 悠斗", role: "per-video" },
      { name: "黒川 部長", role: "per-video" },
      { name: "佐藤 誠司", role: "fixed" },
    ],
  });

  assert.deepEqual(cast.map((entry) => entry.name), ["田中 悠斗", "黒川 部長", "佐藤 誠司"]);
  assert.equal(cast.find((entry) => entry.name === "佐藤 誠司").role, "fixed");
});

test("workflow matches reusable fixed cast but keeps other-episode cast isolated", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-character-match-"));
  try {
    await writeCharacterRegistry({ projectDir }, {
      characters: [
        { id: "channel-helper", name: "佐藤", role: "fixed", referenceImagePaths: ["assets/helper.png"] },
        { id: "old-hero", name: "田中", role: "per-video", episodeId: "episode-old", referenceImagePaths: ["assets/old.png"] },
      ],
    });
    const workflow = await prepareCharacterWorkflow({
      projectDir,
      scriptText: SAMPLE_SCRIPT,
      episodeId: "episode-001",
      candidateCount: 3,
    });
    const helper = workflow.cast.find((entry) => entry.name === "佐藤");
    const hero = workflow.cast.find((entry) => entry.name === "田中");
    assert.equal(helper.status, "existing");
    assert.equal(helper.characterId, "channel-helper");
    assert.equal(hero.status, "needs-candidates");
    assert.notEqual(hero.id, "old-hero");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("new cast receives three labeled manga character-sheet candidates", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-character-candidates-"));
  try {
    const workflow = await prepareCharacterWorkflow({
      projectDir,
      scriptText: "田中：今日は会社に行く。\n黒川：待ちなさい。",
      episodeId: "episode-002",
      candidateCount: 3,
      channelStylePrompt: "高品質な手描き青年漫画。",
    });
    const jobs = await buildCharacterCandidateJobs(workflow);
    assert.equal(jobs.length, 6);
    assert.deepEqual(jobs.slice(0, 3).map((job) => job.customData.buzzassistCharacterLabel), [
      "田中｜候補1",
      "田中｜候補2",
      "田中｜候補3",
    ]);
    assert.ok(jobs.every((job) => job.prompt.includes("full-body three-view turnaround")));
    assert.ok(jobs.every((job) => job.prompt.includes("high-quality hand-drawn Japanese manga / anime production")));
    assert.ok(jobs.every((job) => job.customData.buzzassistCharacterCandidate === true));
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("approval creates an expression sheet, copies two approved references, and registers the character", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-character-approval-"));
  try {
    const workflow = await prepareCharacterWorkflow({
      projectDir,
      scriptText: "田中：これはテストです。",
      episodeId: "episode-003",
      candidateCount: 3,
      cast: [{ name: "田中", description: "28歳、黒髪、紺色スーツ。", invariants: ["黒髪", "紺色スーツ"] }],
    });
    const jobs = await buildCharacterCandidateJobs(workflow);
    await markCharacterCandidatesGenerating({ projectDir }, workflow.id, jobs);
    const canvasAssets = path.join(projectDir, "canvas", "assets");
    await mkdir(canvasAssets, { recursive: true });
    const results = [];
    for (const [index, job] of jobs.entries()) {
      const assetFile = path.join(canvasAssets, `candidate-${index + 1}.png`);
      await writeFile(assetFile, `fake-png-${index + 1}`);
      results.push({
        elementId: `candidate-element-${index + 1}`,
        frameElementId: `candidate-frame-${index + 1}`,
        assetFile,
        assetUrl: `/excalidraw-assets/candidate-${index + 1}.png`,
      });
    }
    const awaitingApproval = await recordCharacterCandidateResults({ projectDir }, workflow.id, jobs, results);
    const cast = awaitingApproval.cast[0];
    assert.equal(cast.status, "awaiting-approval");
    assert.equal(cast.candidates.length, 3);

    const selected = cast.candidates[1];
    const expressionJob = buildExpressionSheetJob(awaitingApproval, cast, selected);
    assert.deepEqual(expressionJob.referenceImagePaths, [selected.assetFile]);
    assert.match(expressionJob.prompt, /Every panel must depict the exact same person/);
    const expressionFile = path.join(canvasAssets, "expression.png");
    await writeFile(expressionFile, "fake-expression-png");

    const finalized = await finalizeApprovedCharacter({
      projectDir,
      workflowId: workflow.id,
      castId: cast.id,
      candidateId: selected.id,
      expressionResult: {
        elementId: "expression-element",
        assetFile: expressionFile,
        assetUrl: "/excalidraw-assets/expression.png",
      },
    });
    assert.equal(finalized.workflow.status, "ready");
    assert.equal(finalized.character.status, "approved");
    assert.equal(finalized.character.referenceImagePaths.length, 2);
    assert.ok(finalized.character.referenceImagePaths.every((item) => item.startsWith("assets/characters/")));
    assert.equal(finalized.workflow.cast[0].candidates.filter((candidate) => candidate.status === "selected").length, 1);
    for (const relativePath of finalized.character.referenceImagePaths) {
      await access(path.join(projectDir, "canvas", relativePath));
    }
    const registry = await readCharacterRegistry({ projectDir });
    assert.equal(registry.characters[0].sourceCandidateId, selected.id);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("storyboard resolves character names to ids and flags multi-character identity mixing risk", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-character-storyboard-"));
  try {
    const workflow = await prepareCharacterWorkflow({
      projectDir,
      scriptText: "田中：こんにちは。\n佐藤：助けに来た。",
      episodeId: "episode-004",
      cast: [
        { name: "田中", description: "主人公" },
        { name: "佐藤", description: "助っ人" },
      ],
    });
    const store = await readCharacterWorkflowStore({ projectDir });
    const readyWorkflow = structuredClone(getCharacterWorkflow(store, workflow.id));
    readyWorkflow.status = "ready";
    readyWorkflow.cast = readyWorkflow.cast.map((entry) => ({ ...entry, status: "ready", characterId: entry.id }));
    const jobs = buildCharacterStoryboardJobs(readyWorkflow, [
      { prompt: "オフィスで田中と佐藤が向かい合う。", characters: ["田中", "佐藤"] },
      { prompt: "田中が一人で書類を見る。" },
    ]);
    assert.deepEqual(jobs[0].characterIds, readyWorkflow.cast.map((entry) => entry.id));
    assert.deepEqual(jobs[1].characterIds, [readyWorkflow.cast[0].id]);
    const validation = validateStoryboardCharacterBindings(readyWorkflow, jobs);
    assert.equal(validation.ok, false);
    assert.match(validation.warnings.join("\n"), /multi-character identity-mixing risk/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
