import test from "node:test";
import { resolveChannelPackPath } from "../lib/channelPackResolver.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";

import {
  buildApprovedIdentityPackJobs,
  buildCharacterCandidateJobs,
  buildCharacterCandidateRegenerationJobs,
  buildCharacterStoryboardJobs,
  composeCharacterCandidateQaSheet,
  extractCastFromScript,
  finalizeApprovedCharacter,
  getCharacterWorkflow,
  importCharacterCandidateRebuild,
  markCharacterCandidatesGenerating,
  migrateLegacyCharacterCandidateBlindArtifacts,
  prepareCharacterWorkflow,
  readCharacterWorkflowStore,
  recordCharacterCandidateResults,
  stageApprovedCharacterIdentityPack,
  updateCharacterWorkflow,
  validateStoryboardCharacterBindings,
  writeCharacterWorkflowStore,
} from "../lib/characterPipeline.mjs";
import { readCharacterRegistry, writeCharacterRegistry } from "../lib/characterRegistry.mjs";
import { auditKoyaCharacterBootstrap } from "../lib/koyaChannelGovernance.mjs";

const SAMPLE_SCRIPT = `
【ナレーション】会社員の田中は今日も残業していた。
田中：また部長に無茶を言われたよ。
黒川部長「口答えするな」
BGM：緊張感のある音楽
佐藤（助っ人）：その契約書、私に見せてください。
田中：佐藤さん、助かります。
`;

test("character workflow store rejects corruption and stale concurrent writes", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-workflow-lock-"));
  try {
    const first = await writeCharacterWorkflowStore({ projectDir }, { workflows: [] });
    assert.equal(first.revision, 1);
    const snapshotA = await readCharacterWorkflowStore({ projectDir });
    const snapshotB = await readCharacterWorkflowStore({ projectDir });
    snapshotA.workflows.push({ id: "wf-a", title: "A" });
    const second = await writeCharacterWorkflowStore({ projectDir }, snapshotA);
    assert.equal(second.revision, 2);
    snapshotB.workflows.push({ id: "wf-b", title: "B" });
    await assert.rejects(() => writeCharacterWorkflowStore({ projectDir }, snapshotB), /Stale character workflow revision/u);

    const file = path.join(projectDir, "canvas", "character-workflows.json");
    await writeFile(file, "{broken\n");
    await assert.rejects(() => readCharacterWorkflowStore({ projectDir }), /JSON/u);
    await writeFile(file, "\n");
    await assert.rejects(() => readCharacterWorkflowStore({ projectDir }), /workflow store is empty/u);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

function testRaster(seed = 1, width = 96, height = 72) {
  const header = Buffer.from(`P6\n${width} ${height}\n255\n`);
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      pixels[offset] = (x * (seed + 3) + y * 2) % 256;
      pixels[offset + 1] = (y * (seed + 5) + x) % 256;
      pixels[offset + 2] = ((x + y) * (seed + 7)) % 256;
    }
  }
  return Buffer.concat([header, pixels]);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function testPng(seedNumber = 1, width = 64, height = 48) {
  const seed = createHash("sha256").update(String(seedNumber)).digest();
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 3;
      raw[offset] = (seed[0] + x * (seed[3] % 11 + 1) + y * 3) % 256;
      raw[offset + 1] = (seed[1] + y * (seed[4] % 13 + 1) + x * 2) % 256;
      raw[offset + 2] = (seed[2] + (x + y) * (seed[5] % 17 + 1)) % 256;
    }
  }
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND"),
  ]);
}

async function passCandidateReview(pathname) {
  const review = JSON.parse(await readFile(pathname, "utf8"));
  review.generatorContextId = "candidate-generator-session";
  review.reviewer = { host: "codex", id: "candidate-reviewer", contextId: "candidate-review-session", reviewedAt: new Date().toISOString() };
  review.originalScaleInspected = true;
  for (const candidate of review.candidates) {
    candidate.faceRegionReviewed = true;
    candidate.manualFaceRegion = [0, 0, Math.max(1, candidate.width), Math.max(1, candidate.height)];
  }
  for (const pair of review.pairChecks) {
    pair.visualAxes.faceShapeDistinct = true;
    pair.visualAxes.hairSilhouetteDistinct = true;
    pair.pass = true;
    pair.note = "原寸で顔型と髪シルエットの差を確認";
  }
  review.pass = true;
  review.notes = "A/B/Cは実画像で別設計として識別できる";
  await writeFile(pathname, `${JSON.stringify(review, null, 2)}\n`);
}

async function passIdentityReview(pathname) {
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
  review.reviewer = { host: "codex", id: "identity-reviewer", contextId: "identity-review-session", reviewedAt: new Date().toISOString() };
  review.originalScaleInspected = true;
  review.turnaround.isRealTurnaround = true;
  review.turnaround.notCandidateSubstitute = true;
  review.turnaround.grid.alignmentConfirmed = true;
  review.turnaround.pass = true;
  review.turnaround.note = "8方向すべて同一人物と確認";
  for (const view of review.turnaround.viewChecks) {
    passCell(view);
  }
  review.expression.grid.alignmentConfirmed = true;
  review.expression.pass = true;
  review.expression.note = "12セルすべて同一人物と確認";
  for (const cell of review.expression.cells) {
    passCell(cell);
  }
  for (const sheet of review.outfitSheets) {
    Object.assign(sheet, { sameIdentity: true, outfitMatchesSpecification: true, pass: true, note: "衣装仕様一致" });
    sheet.grid.alignmentConfirmed = true;
    for (const cell of sheet.cells) passCell(cell, { outfitMatchesSpecification: true });
  }
  for (const sheet of review.extraSheets) {
    Object.assign(sheet, { sameIdentity: true, pass: true, note: "同一人物差分" });
    sheet.grid.alignmentConfirmed = true;
    for (const cell of sheet.cells) passCell(cell, { stateMatchesSpecification: true });
  }
  review.pass = true;
  review.notes = "人物登録可能";
  await writeFile(pathname, `${JSON.stringify(review, null, 2)}\n`);
}

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

test("an explicit fixed-cast id remains stable from the episode bible into its workflow", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-fixed-id-"));
  try {
    const workflow = await prepareCharacterWorkflow({
      projectDir,
      scriptText: "もも：ほな、いこか",
      episodeId: "appare-bootstrap-v2",
      cast: [{ id: "horo", name: "もも", role: "fixed", description: "漫画動画ハーネスshow bibleの固定人物" }],
    });
    assert.equal(workflow.cast[0].id, "horo");
    assert.equal(workflow.cast[0].candidateGroupId, "horo-candidates");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
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
visual_profile_id: manga-channel-reference-video-v1
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

test("characters with multiple story-stage outfits receive dedicated routed sheets", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-character-outfits-"));
  try {
    const workflow = await prepareCharacterWorkflow({
      projectDir,
      scriptText: "田中：着替えよう。",
      episodeId: "episode-outfits",
      cast: [{
        name: "田中",
        description: "会社員",
        outfitStages: [
          { id: "office", description: "紺色スーツ", invariants: ["白シャツ", "二つボタン"] },
          { id: "home", description: "灰色の部屋着", invariants: ["丸首", "ボタンなし"] },
        ],
      }],
    });
    const cast = workflow.cast[0];
    const jobs = buildApprovedIdentityPackJobs(workflow, cast, { id: "selected", assetFile: "/tmp/selected.png" });
    assert.deepEqual(jobs.map((job) => job.pipeline.identityRole), ["turnaround", "expression", "outfit", "outfit"]);
    assert.deepEqual(jobs.filter((job) => job.pipeline.identityRole === "outfit").map((job) => job.pipeline.storyStage), ["office", "home"]);
    assert.ok(jobs.filter((job) => job.pipeline.identityRole === "outfit").every((job) => job.referenceImagePaths.length === 1));
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("a weak anonymous candidate can be regenerated without replacing passing candidates", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-character-regenerate-one-"));
  try {
    const workflow = await prepareCharacterWorkflow({
      projectDir,
      scriptText: "田中：候補を比べる。",
      episodeId: "episode-regenerate-one",
      candidateCount: 3,
    });
    const jobs = await buildCharacterCandidateJobs(workflow);
    await markCharacterCandidatesGenerating({ projectDir }, workflow.id, jobs);
    const assetDir = path.join(projectDir, "canvas", "assets");
    await mkdir(assetDir, { recursive: true });
    const results = [];
    for (const [index] of jobs.entries()) {
      const assetFile = path.join(assetDir, `initial-${index}.png`);
      await writeFile(assetFile, testRaster(index + 1));
      results.push({ assetFile });
    }
    const firstPass = await recordCharacterCandidateResults({ projectDir, generatorContextId: "candidate-regeneration-session" }, workflow.id, jobs, results);
    const firstCast = firstPass.cast[0];
    const weak = firstCast.candidates[1];
    const unchanged = new Map(firstCast.candidates.filter((candidate) => candidate.id !== weak.id).map((candidate) => [candidate.id, candidate.assetFile]));
    const regenerationJobs = buildCharacterCandidateRegenerationJobs(firstPass, firstCast.id, [weak.blindLabel]);
    assert.equal(regenerationJobs.length, 1);
    assert.equal(regenerationJobs[0].pipeline.candidateId, weak.id);
    await markCharacterCandidatesGenerating({ projectDir }, workflow.id, regenerationJobs);
    const regeneratedFile = path.join(assetDir, "regenerated.png");
    await writeFile(regeneratedFile, testRaster(21));
    const secondPass = await recordCharacterCandidateResults(
      { projectDir, generatorContextId: "candidate-regeneration-session" },
      workflow.id,
      regenerationJobs,
      [{ assetFile: regeneratedFile }],
    );
    const secondCast = secondPass.cast[0];
    assert.equal(secondCast.candidates.find((candidate) => candidate.id === weak.id).assetFile, regeneratedFile);
    for (const [id, assetFile] of unchanged) assert.equal(secondCast.candidates.find((candidate) => candidate.id === id).assetFile, assetFile);
    assert.ok(secondCast.candidateReviewDraftPath.endsWith("candidate-diversity-review.json"));
    assert.equal(secondCast.candidates.filter((candidate) => candidate.blindLabel).length, 3);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("legacy published A-E labels migrate without reassigning the selected person and explicit F is retired", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-character-blind-migration-"));
  try {
    const workflow = await prepareCharacterWorkflow({
      projectDir,
      scriptText: "見本ノゾミ：候補を比べます。",
      episodeId: "episode-legacy-six",
      candidateCount: 3,
    });
    const jobs = await buildCharacterCandidateJobs(workflow);
    await markCharacterCandidatesGenerating({ projectDir }, workflow.id, jobs);
    const assetDir = path.join(projectDir, "canvas", "assets");
    await mkdir(assetDir, { recursive: true });
    const results = [];
    for (const [index] of jobs.entries()) {
      const assetFile = path.join(assetDir, `candidate-${index + 1}.png`);
      await writeFile(assetFile, testRaster(index + 1));
      results.push({ assetFile });
    }
    const generated = await recordCharacterCandidateResults({ projectDir, generatorContextId: "original-candidate-generator" }, workflow.id, jobs, results);
    const initialCast = generated.cast[0];
    await updateCharacterWorkflow({ projectDir }, workflow.id, (current) => {
      const cast = current.cast[0];
      const firstLabel = cast.candidates[0].blindLabel;
      cast.candidates[0].blindLabel = cast.candidates[1].blindLabel;
      cast.candidates[1].blindLabel = firstLabel;
      for (const [offset, label] of ["D", "E", "F"].entries()) {
        cast.candidates.push({
          id: `${cast.id}-legacy-${label}`,
          index: 4 + offset,
          status: "generated",
          variationAxis: `Legacy published design ${label}`,
          blindLabel: label,
          assetFile: path.join(assetDir, `candidate-${4 + offset}.png`),
        });
      }
      return current;
    });
    for (let index = 4; index <= 6; index += 1) await writeFile(path.join(assetDir, `candidate-${index}.png`), testRaster(index));
    await assert.rejects(() => migrateLegacyCharacterCandidateBlindArtifacts({
      projectDir,
      workflowId: workflow.id,
      castId: initialCast.id,
      candidateLabels: "A,B,C,D,E",
      retiredCandidateLabels: "F",
      migrationReason: "Preserve the published review labels after legacy delivery.",
      generatorHost: "codex",
      generatorId: "migration-tool",
      generatorContextId: "migration-context",
    }), /generatorHost=legacy-migration/u);
    const result = await migrateLegacyCharacterCandidateBlindArtifacts({
      projectDir,
      workflowId: workflow.id,
      castId: initialCast.id,
      candidateLabels: "A,B,C,D,E",
      retiredCandidateLabels: "F",
      migrationReason: "Preserve the published review labels after legacy delivery.",
      generatorHost: "legacy-migration",
      generatorId: "migration-tool",
      generatorContextId: "migration-context",
    });
    assert.deepEqual(result.activeLabels, ["A", "B", "C", "D", "E"]);
    assert.deepEqual(result.retiredLabels, ["F"]);
    assert.equal(result.mappingConflicts.length, 2);
    const migratedCast = result.workflow.cast[0];
    assert.equal(migratedCast.candidates.find((candidate) => candidate.blindLabel === "F").status, "rejected");
    assert.equal(migratedCast.candidates.filter((candidate) => candidate.status === "generated" && candidate.blindArtifactFile).length, 5);
    assert.equal(migratedCast.candidateGeneratorContextId, "original-candidate-generator");
    const privatePacket = JSON.parse(await readFile(migratedCast.candidates.find((candidate) => candidate.blindLabel === "E").blindPrivateMappingPath, "utf8"));
    assert.equal(privatePacket.mapping.find((entry) => entry.label === "E").id, `${initialCast.id}-legacy-E`);
    const review = JSON.parse(await readFile(result.reviewDraftPath, "utf8"));
    assert.deepEqual(review.candidates.map((candidate) => candidate.label), ["A", "B", "C", "D", "E"]);
    const report = JSON.parse(await readFile(result.reportPath, "utf8"));
    assert.equal(report.approvalStatus, "pending-independent-review");
    assert.deepEqual(report.retiredLabels, ["F"]);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("a SHA-bound candidate rebuild replaces only the exact unselected workflow cast and preserves prior packet evidence", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-character-candidate-import-"));
  try {
    const workflow = await prepareCharacterWorkflow({
      projectDir,
      scriptText: "参考ミナ：候補を見せなさい。\n店主：承知しました。",
      episodeId: "episode-candidate-rebuild",
      candidateCount: 3,
    });
    const jobs = await buildCharacterCandidateJobs(workflow);
    await markCharacterCandidatesGenerating({ projectDir }, workflow.id, jobs);
    const assetDir = path.join(projectDir, "canvas", "assets", "candidate-rebuild");
    await mkdir(assetDir, { recursive: true });
    const originalResults = [];
    for (const [index] of jobs.entries()) {
      const assetFile = path.join(assetDir, `original-${index + 1}.png`);
      await writeFile(assetFile, testPng(index + 1));
      originalResults.push({ assetFile });
    }
    const generated = await recordCharacterCandidateResults(
      { projectDir, generatorContextId: "original-generator-context" },
      workflow.id,
      jobs,
      originalResults,
    );
    const cast = generated.cast.find((entry) => entry.name === "参考ミナ");
    const unrelatedCast = generated.cast.find((entry) => entry.name === "店主");
    const originalEvidence = new Map(cast.candidates.map((candidate) => [candidate.blindLabel, {
      assetFile: candidate.assetFile,
      assetSha256: createHash("sha256").update(testPng(candidate.index)).digest("hex"),
      blindArtifactFile: candidate.blindArtifactFile,
      blindArtifactSha256: candidate.blindArtifactSha256,
    }]));

    const rebuildDir = path.join(assetDir, "miehara-v1");
    await mkdir(rebuildDir, { recursive: true });
    const entries = [];
    for (const [index, label] of ["A", "B", "C"].entries()) {
      const output = path.join(rebuildDir, `miehara-${label}.png`);
      const bytes = testPng(index + 11);
      await writeFile(output, bytes);
      entries.push({
        name: `miehara-${label}`,
        output,
        outputSha256: createHash("sha256").update(bytes).digest("hex"),
        prompt: `参考ミナの${label}設計を生成する`,
      });
    }
    const sourceManifestPath = path.join(rebuildDir, "source-manifest.json");
    await writeFile(sourceManifestPath, `${JSON.stringify({
      version: "koya-character-candidate-source-manifest-v1",
      generator: { host: "codex", id: "openai-imagegen", contextId: "candidate-rebuild-context", model: "fixture-imagegen" },
      generatedAt: new Date().toISOString(),
      entries,
    }, null, 2)}\n`);
    const specPath = path.join(projectDir, "config", "miehara-candidate-rebuild.json");
    await mkdir(path.dirname(specPath), { recursive: true });
    await writeFile(specPath, `${JSON.stringify({
      version: "koya-character-candidate-rebuild-spec-v1",
      characterId: "miehara",
      candidates: ["A", "B", "C"].map((label) => ({ label, axis: `axis-${label}`, description: `distinct design ${label}` })),
    }, null, 2)}\n`);
    const importMapPath = path.join(rebuildDir, "import-map.json");
    const importMap = {
      version: "koya-character-candidate-import-v1",
      characterId: "miehara",
      workflowCastId: cast.id,
      specPath,
      sourceManifestPath,
      entries: ["A", "B", "C"].map((label) => ({ candidateLabel: label, sourceEntryName: `miehara-${label}` })),
    };
    await writeFile(importMapPath, `${JSON.stringify({ ...importMap, workflowCastId: "wrong-cast" }, null, 2)}\n`);
    await assert.rejects(() => importCharacterCandidateRebuild({
      projectDir,
      workflowId: workflow.id,
      castId: cast.id,
      candidateImportMapPath: importMapPath,
      generatorHost: "codex",
      generatorId: "openai-imagegen",
      generatorContextId: "candidate-rebuild-context",
    }), /workflowCastId must bind the exact target/u);

    await writeFile(importMapPath, `${JSON.stringify(importMap, null, 2)}\n`);
    const imported = await importCharacterCandidateRebuild({
      projectDir,
      workflowId: workflow.id,
      castId: cast.id,
      candidateImportMapPath: importMapPath,
      generatorHost: "codex",
      generatorId: "openai-imagegen",
      generatorContextId: "candidate-rebuild-context",
    });
    assert.equal(imported.cast.candidateImportEvidencePath, imported.evidencePath);
    assert.equal(imported.cast.candidateImportEvidenceSha256, imported.evidenceSha256);
    assert.equal(imported.cast.candidateGeneratorContextId, "candidate-rebuild-context");
    const afterImportStore = await readCharacterWorkflowStore({ projectDir });
    const afterImportWorkflow = getCharacterWorkflow(afterImportStore, workflow.id);
    assert.equal(afterImportWorkflow.cast.find((entry) => entry.id === unrelatedCast.id).candidateGeneratorContextId, "original-generator-context");
    const importedByLabel = [...imported.cast.candidates].sort((left, right) => left.blindLabel.localeCompare(right.blindLabel));
    assert.deepEqual(importedByLabel.map((candidate) => candidate.blindLabel), ["A", "B", "C"]);
    assert.deepEqual(importedByLabel.map((candidate) => candidate.variationAxis), [
      "axis-A: distinct design A",
      "axis-B: distinct design B",
      "axis-C: distinct design C",
    ]);
    const evidence = JSON.parse(await readFile(imported.evidencePath, "utf8"));
    assert.deepEqual(evidence.previousCandidates.map((candidate) => candidate.blindLabel).sort(), ["A", "B", "C"]);
    for (const previous of evidence.previousCandidates) {
      const expected = originalEvidence.get(previous.blindLabel);
      assert.equal(previous.assetFile, expected.assetFile);
      assert.equal(previous.assetSha256, expected.assetSha256);
      assert.equal(previous.blindArtifactFile, expected.blindArtifactFile);
      assert.equal(previous.blindArtifactSha256, expected.blindArtifactSha256);
      await access(previous.assetFile);
      await access(previous.blindArtifactFile);
    }
    const review = JSON.parse(await readFile(imported.reviewDraftPath, "utf8"));
    assert.deepEqual(review.candidateImportEvidence, { path: imported.evidencePath, sha256: imported.evidenceSha256 });
    assert.equal(review.pass, false);
    const qa = await composeCharacterCandidateQaSheet({ projectDir, workflowId: workflow.id, castId: cast.id });
    const qaSvg = await readFile(qa.sheetPath, "utf8");
    assert.match(qaSvg, /未承認・原寸QA用/u);
    assert.doesNotMatch(qaSvg, new RegExp(cast.candidates[0].id, "u"));
    assert.equal(qa.manifest.authoritativeApproval, false);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("approval stages real sheets and registers only after eight-view and twelve-cell review", async () => {
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
      await writeFile(assetFile, testRaster(index + 1));
      results.push({
        elementId: `candidate-element-${index + 1}`,
        frameElementId: `candidate-frame-${index + 1}`,
        assetFile,
        assetUrl: `/excalidraw-assets/candidate-${index + 1}.png`,
      });
    }
    const awaitingApproval = await recordCharacterCandidateResults({ projectDir, generatorContextId: "candidate-generator-session" }, workflow.id, jobs, results);
    const cast = awaitingApproval.cast[0];
    assert.equal(cast.status, "awaiting-approval");
    assert.equal(cast.candidates.length, 3);
    assert.equal(new Set(cast.candidates.map((candidate) => candidate.variationAxis)).size, 3);
    assert.ok(cast.candidateReviewDraftPath.endsWith("candidate-diversity-review.json"));
    await passCandidateReview(cast.candidateReviewDraftPath);

    const selected = cast.candidates[1];
    const showBible = JSON.parse(await readFile(resolveChannelPackPath(new URL("..", import.meta.url).pathname, "config/koya-show-bible.json"), "utf8"));
    const bootstrapMember = showBible.cast.find((member) => member.id === "ibuki");
    bootstrapMember.hiddenName = cast.name;
    bootstrapMember.selectedBaseLabel = selected.blindLabel;
    bootstrapMember.selectedLabel = selected.blindLabel;
    const bootstrap = await auditKoyaCharacterBootstrap({
      showBible,
      registry: { characters: [] },
      workflowStore: { workflows: [awaitingApproval] },
    });
    const bootstrapRow = bootstrap.rows.find((row) => row.id === "ibuki");
    assert.equal(bootstrapRow.candidateReviewPass, true, JSON.stringify(bootstrapRow));
    assert.equal(bootstrapRow.stage, "identity-pack-required");

    const [turnaroundJob, expressionJob] = buildApprovedIdentityPackJobs(awaitingApproval, cast, selected);
    assert.deepEqual(turnaroundJob.referenceImagePaths, [selected.assetFile]);
    assert.match(turnaroundJob.prompt, /front, strict left-profile, strict right-profile, and back full-body/);
    assert.match(turnaroundJob.prompt, /exact 4x2 grid/);
    assert.match(turnaroundJob.prompt, /HARD CELL CONTAINMENT/);
    assert.match(turnaroundJob.prompt, /both shoe soles/);
    assert.match(turnaroundJob.prompt, /strict overhead\/top head/);
    assert.deepEqual(expressionJob.referenceImagePaths, [selected.assetFile]);
    assert.match(expressionJob.prompt, /Every panel must depict the exact same person/);
    assert.match(expressionJob.prompt, /HARD CELL CONTAINMENT/);
    assert.match(expressionJob.prompt, /do not invent towels/);
    const approvedAccessoryCast = {
      ...cast,
      approval: { selectedVariationAxis: "dark samue, towel over the shoulder" },
    };
    const [approvedAccessoryTurnaround, approvedAccessoryExpression] = buildApprovedIdentityPackJobs(awaitingApproval, approvedAccessoryCast, selected);
    assert.match(approvedAccessoryTurnaround.prompt, /Human-approved selected design axis: dark samue, towel over the shoulder/u);
    assert.match(approvedAccessoryTurnaround.prompt, /APPROVED ACCESSORY CONTINUITY/u);
    assert.match(approvedAccessoryTurnaround.prompt, /never make a shoulder towel/u);
    assert.match(approvedAccessoryTurnaround.prompt, /same anatomical side/u);
    assert.match(approvedAccessoryTurnaround.prompt, /Do not mirror it to the other side/u);
    assert.match(approvedAccessoryTurnaround.prompt, /nose points toward canvas LEFT/u);
    assert.match(approvedAccessoryTurnaround.prompt, /nose points toward canvas RIGHT/u);
    assert.match(approvedAccessoryExpression.prompt, /Preserve every visible selected trait, including declared clothing and accessories/u);
    assert.match(approvedAccessoryExpression.prompt, /shoulder-visible portrait/u);
    assert.match(approvedAccessoryExpression.prompt, /expressions never remove or relocate it/u);
    const turnaroundFile = path.join(canvasAssets, "turnaround.png");
    const expressionFile = path.join(canvasAssets, "expression.png");
    await writeFile(turnaroundFile, testRaster(11, 400, 200));
    await writeFile(expressionFile, testRaster(12, 400, 300));

    await assert.rejects(() => finalizeApprovedCharacter({
      projectDir,
      workflowId: workflow.id,
      castId: cast.id,
      candidateId: selected.id,
    }), /staged generated identity pack/u);

    await assert.rejects(() => stageApprovedCharacterIdentityPack({
      projectDir,
      workflowId: workflow.id,
      castId: cast.id,
      candidateId: selected.id,
      approvalReason: "顔立ちと服装が役柄に最も合い、他人物とも明確に区別できる",
      approvedBy: "test-human",
      candidateReviewPath: cast.candidateReviewDraftPath,
      generatorContextId: "identity-generator-session",
      jobs: [turnaroundJob, expressionJob],
      results: [{ assetFile: selected.assetFile }, { assetFile: expressionFile }],
    }), /byte-identical|real generated turnaround/u);

    const staged = await stageApprovedCharacterIdentityPack({
      projectDir,
      workflowId: workflow.id,
      castId: cast.id,
      candidateId: selected.id,
      approvalReason: "顔立ちと服装が役柄に最も合い、他人物とも明確に区別できる",
      approvedBy: "test-human",
      candidateReviewPath: cast.candidateReviewDraftPath,
      generatorContextId: "identity-generator-session",
      jobs: [turnaroundJob, expressionJob],
      results: [
        { elementId: "turnaround-element", assetFile: turnaroundFile, assetUrl: "/excalidraw-assets/turnaround.png" },
        { elementId: "expression-element", assetFile: expressionFile, assetUrl: "/excalidraw-assets/expression.png" },
      ],
    });
    assert.equal(staged.workflow.status, "awaiting-identity-qa");
    assert.equal((await readCharacterRegistry({ projectDir })).characters.length, 0);
    const postSelectionBootstrap = await auditKoyaCharacterBootstrap({
      showBible,
      registry: { characters: [] },
      workflowStore: { workflows: [staged.workflow] },
    });
    const postSelectionRow = postSelectionBootstrap.rows.find((row) => row.id === "ibuki");
    assert.equal(postSelectionRow.candidateReviewPass, true, JSON.stringify(postSelectionRow));
    assert.equal(postSelectionRow.stage, "identity-review-required");
    assert.equal(postSelectionRow.nextAction, "Complete independent original-scale QA for eight-view turnaround, twelve-cell expression, then register.");
    await assert.rejects(() => finalizeApprovedCharacter({
      projectDir,
      workflowId: workflow.id,
      castId: cast.id,
      identityReviewPath: staged.identityReviewDraftPath,
    }), /originalScaleInspected|turnaround\.isRealTurnaround|expression\.cells/u);
    await passIdentityReview(staged.identityReviewDraftPath);
    const oneBadCellReview = JSON.parse(await readFile(staged.identityReviewDraftPath, "utf8"));
    oneBadCellReview.expression.cells[7].sameIdentity = false;
    oneBadCellReview.expression.cells[7].pass = false;
    await writeFile(staged.identityReviewDraftPath, `${JSON.stringify(oneBadCellReview, null, 2)}\n`);
    await assert.rejects(() => finalizeApprovedCharacter({
      projectDir,
      workflowId: workflow.id,
      castId: cast.id,
      identityReviewPath: staged.identityReviewDraftPath,
    }), /expression\.cells\.r2c4\.sameIdentity|expression\.cells\.r2c4\.pass/u);
    await passIdentityReview(staged.identityReviewDraftPath);

    const tamperedReview = JSON.parse(await readFile(staged.identityReviewDraftPath, "utf8"));
    const tamperedCell = tamperedReview.expression.cells[0];
    const originalCellBytes = await readFile(tamperedCell.path);
    const originalCellSha256 = tamperedCell.sha256;
    const replacement = testRaster(99, tamperedCell.width, tamperedCell.height);
    await writeFile(tamperedCell.path, replacement);
    tamperedCell.sha256 = createHash("sha256").update(replacement).digest("hex");
    await writeFile(staged.identityReviewDraftPath, `${JSON.stringify(tamperedReview, null, 2)}\n`);
    await assert.rejects(() => finalizeApprovedCharacter({
      projectDir,
      workflowId: workflow.id,
      castId: cast.id,
      identityReviewPath: staged.identityReviewDraftPath,
    }), /fresh crop from the current parent sheet/u);
    await writeFile(tamperedCell.path, originalCellBytes);
    tamperedReview.expression.cells[0].sha256 = originalCellSha256;
    await writeFile(staged.identityReviewDraftPath, `${JSON.stringify(tamperedReview, null, 2)}\n`);

    const finalized = await finalizeApprovedCharacter({
      projectDir,
      workflowId: workflow.id,
      castId: cast.id,
      identityReviewPath: staged.identityReviewDraftPath,
    });
    assert.equal(finalized.workflow.status, "ready");
    assert.equal(finalized.character.status, "approved");
    assert.equal(finalized.character.approval.route, "human-best-of-n");
    assert.equal(finalized.character.approval.approvedBy, "test-human");
    assert.equal(finalized.character.approval.reason, "顔立ちと服装が役柄に最も合い、他人物とも明確に区別できる");
    assert.equal(finalized.character.referenceImagePaths.length, 3);
    assert.deepEqual(finalized.character.referenceAssets.map((entry) => entry.role), ["identity-face", "turnaround", "expression"]);
    assert.match(finalized.character.approval.identityReviewSha256, /^[a-f0-9]{64}$/u);
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
