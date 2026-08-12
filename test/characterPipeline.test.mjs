import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildApprovedIdentityPackJobs,
  buildCharacterCandidateJobs,
  buildCharacterStoryboardJobs,
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

test("script cast extraction never promotes a quoted name inside narration to a speaker", () => {
  const script = `
ナレーション: 「会議」という言葉すら知らなかったらしい。
ナレーション: T大の彼氏にも「ニートと付き合うなんて無理」と振られた。
荒野: 価値観を押し付けるな。
`;
  const cast = extractCastFromScript(script);
  assert.deepEqual(cast.map((entry) => entry.name), ["荒野"]);
});

test("script cast extraction ignores YAML frontmatter and keeps spaced Japanese speaker names", () => {
  const script = `---
title: 消えかけた写真に、帰る場所が写っていた
kind: manga-video-script
episode_id: manga-photo-homecoming-001
visual_profile_id: koutani-reference-video-v1
target_cuts: 10
---

高瀬 蓮：「この写真、まだ持っていたのか」
水野 澪：「忘れるわけないでしょう」
神谷 玲司：「二人とも、早く来いよ」
`;

  const cast = extractCastFromScript(script);

  assert.deepEqual(cast.map((entry) => entry.name), ["高瀬 蓮", "水野 澪", "神谷 玲司"]);
  assert.deepEqual(cast.map((entry) => entry.firstAppearanceLine), [9, 10, 11]);
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

test("workflow reuses a draft same-episode id but requires new candidates", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-character-reapproval-"));
  try {
    await writeCharacterRegistry({ projectDir }, {
      characters: [
        {
          id: "episode-001-ren",
          name: "高瀬 蓮",
          role: "per-video",
          status: "draft",
          episodeId: "episode-001",
          referenceImagePaths: [],
        },
      ],
    });
    const workflow = await prepareCharacterWorkflow({
      projectDir,
      scriptText: "高瀬 蓮：ただいま。",
      episodeId: "episode-001",
      candidateCount: 3,
    });
    assert.equal(workflow.cast[0].id, "episode-001-ren");
    assert.equal(workflow.cast[0].status, "needs-candidates");
    assert.equal(workflow.cast[0].characterId, "");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("new cast receives three labeled lightweight manga candidate cards", async () => {
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
    assert.ok(jobs.every((job) => job.prompt.includes("CHARACTER CANDIDATE CARD")));
    assert.ok(jobs.every((job) => job.prompt.includes("exactly three head studies")));
    assert.ok(jobs.every((job) => job.prompt.includes("No material swatches")));
    assert.ok(jobs.every((job) => job.prompt.includes("Do not add realistic detail")));
    assert.ok(jobs.every((job) => job.customData.buzzassistCharacterCandidate === true));
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("approval builds turnaround and expression sheets, then registers the two approved references", async () => {
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
    assert.equal(new Set(cast.candidates.map((candidate) => candidate.variationAxis)).size, 3);

    const selected = cast.candidates[1];
    const [turnaroundJob, expressionJob] = buildApprovedIdentityPackJobs(awaitingApproval, cast, selected);
    assert.deepEqual(turnaroundJob.referenceImagePaths, [selected.assetFile]);
    assert.match(turnaroundJob.prompt, /front, strict left-profile, strict right-profile, and back full-body/);
    assert.match(turnaroundJob.prompt, /strict overhead\/top head views/);
    assert.deepEqual(expressionJob.referenceImagePaths, [selected.assetFile]);
    assert.match(expressionJob.prompt, /Every panel must depict the exact same person/);
    const turnaroundFile = path.join(canvasAssets, "turnaround.png");
    const expressionFile = path.join(canvasAssets, "expression.png");
    await writeFile(turnaroundFile, "fake-turnaround-png");
    await writeFile(expressionFile, "fake-expression-png");

    await assert.rejects(() => finalizeApprovedCharacter({
      projectDir,
      workflowId: workflow.id,
      castId: cast.id,
      candidateId: selected.id,
    }), /approvalReason/u);

    const finalized = await finalizeApprovedCharacter({
      projectDir,
      workflowId: workflow.id,
      castId: cast.id,
      candidateId: selected.id,
      approvalReason: "顔立ちと服装が役柄に最も合い、他人物とも明確に区別できる",
      approvedBy: "test-human",
      turnaroundResult: {
        elementId: "turnaround-element",
        assetFile: turnaroundFile,
        assetUrl: "/excalidraw-assets/turnaround.png",
      },
      expressionResult: {
        elementId: "expression-element",
        assetFile: expressionFile,
        assetUrl: "/excalidraw-assets/expression.png",
      },
    });
    assert.equal(finalized.workflow.status, "ready");
    assert.equal(finalized.character.status, "approved");
    assert.equal(finalized.character.approval.route, "human-best-of-n");
    assert.equal(finalized.character.approval.approvedBy, "test-human");
    assert.equal(finalized.character.approval.reason, "顔立ちと服装が役柄に最も合い、他人物とも明確に区別できる");
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
