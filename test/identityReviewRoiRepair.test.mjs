// ROI repair driven by a failed independent identity review
// (character-identity-repair --identity-review-path FAILED --roi-from-review).
//
// The image model kept drawing right-facing views as mirror copies of the
// left-facing ones, so a one-shoulder strap landed on the wrong shoulder three
// times in a row: whole-role regeneration never told the model what was wrong.
// These tests pin the contract of the review-driven ROI mode:
//   - only content-failed cells become <role>:<cellId> findings with equal-grid ROIs
//   - the job prompt names those ROIs and issues
//   - an alignment-only review is refused in favour of character-identity-repack
//   - a passing review is refused
//   - the plan is bound to the failed review SHA-256, never to the human-QA contract
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";

import { buildCharacterCandidateQualityContract } from "../lib/characterAttributeGate.mjs";
import {
  buildApprovedIdentityPackJobs,
  buildApprovedIdentityPackRepairJobs,
  buildCharacterCandidateJobs,
  markCharacterCandidatesGenerating,
  prepareCharacterWorkflow,
  readCharacterWorkflowStore,
  recordCharacterCandidateResults,
  stageApprovedCharacterIdentityPack,
} from "../lib/characterPipeline.mjs";
import { SIDE_LOCKED_REVIEW_FLAG } from "../lib/characterIdentityReview.mjs";
import { verifyCharacterRepairPlanDigest } from "../lib/characterRepairPlan.mjs";
import {
  IDENTITY_REVIEW_ROI_REPAIR_CONTRACT_ID,
  assertIdentityReviewRoiRepairable,
  buildIdentityReviewRoiRepairPlan,
  classifyFailedIdentityCell,
  deriveIdentityReviewRoiFindings,
  identityGridCellRegion,
} from "../lib/identityReviewRoiRepair.mjs";
import { repairKoyaCharacterIdentityPack } from "../lib/koyaMangaProduction.mjs";

const STRAP = { id: "one-shoulder-strap", feature: "one-shoulder dress strap", expectedSide: "subject-right" };

// ---------------------------------------------------------------- pure helpers

function passingCell(id, extra = {}) {
  return {
    id,
    sameIdentity: true,
    ageConsistent: true,
    hairConsistent: true,
    faceContourConsistent: true,
    pass: true,
    note: "原寸確認済み",
    ...extra,
  };
}

function syntheticReview() {
  const expressionIds = Array.from({ length: 12 }, (_, index) => `r${Math.floor(index / 4) + 1}c${(index % 4) + 1}`);
  const turnaroundIds = [
    "front-full-body", "left-profile-full-body", "right-profile-full-body", "back-full-body",
    "front-head", "left-three-quarter-head", "right-three-quarter-head", "top-head",
  ];
  return {
    reviewer: { host: "codex", id: "reviewer", contextId: "review-session", reviewedAt: "2026-10-25T00:00:00.000Z" },
    turnaround: { grid: { columns: 4, rows: 2, alignmentConfirmed: true }, viewChecks: turnaroundIds.map((id) => passingCell(id)), pass: true, note: "ok" },
    expression: { grid: { columns: 4, rows: 3, alignmentConfirmed: true }, cells: expressionIds.map((id) => passingCell(id)), pass: true, note: "ok" },
    outfitSheets: [],
    extraSheets: [],
    pass: false,
  };
}

function cellOf(review, id) {
  return [...review.turnaround.viewChecks, ...review.expression.cells].find((cell) => cell.id === id);
}

test("equal-grid ROI regions are the normalized cell rectangles of each sheet layout", () => {
  assert.deepEqual(identityGridCellRegion({ columns: 4, rows: 3, index: 1 }), [0.25, 0, 0.25, 0.333333]);
  assert.deepEqual(identityGridCellRegion({ columns: 4, rows: 3, index: 11 }), [0.75, 0.666667, 0.25, 0.333333]);
  assert.deepEqual(identityGridCellRegion({ columns: 4, rows: 2, index: 2 }), [0.5, 0, 0.25, 0.5]);
  assert.deepEqual(identityGridCellRegion({ columns: 2, rows: 2, index: 3 }), [0.5, 0.5, 0.5, 0.5]);
  for (const [columns, rows] of [[4, 2], [4, 3], [2, 2], [4, 1]]) {
    for (let index = 0; index < columns * rows; index += 1) {
      const [x, y, w, h] = identityGridCellRegion({ columns, rows, index });
      assert.ok(x + w <= 1 && y + h <= 1, `${columns}x${rows}#${index} stays inside the sheet`);
    }
  }
  assert.throws(() => identityGridCellRegion({ columns: 4, rows: 3, index: 12 }), /Invalid identity grid cell/u);
});

test("only content-failed cells become findings; alignment-only notes and passing cells do not", () => {
  const review = syntheticReview();
  Object.assign(cellOf(review, "r1c2"), {
    pass: false,
    [SIDE_LOCKED_REVIEW_FLAG]: false,
    note: "",
    asymmetricFeatureChecks: [{ ...STRAP, applicable: true, observedSide: "subject-left", pass: false, note: "右向きが左向きの鏡像" }],
  });
  Object.assign(cellOf(review, "r3c4"), { pass: false, hairConsistent: false, note: "前髪の分け目が逆になっている" });
  Object.assign(cellOf(review, "r2c1"), { pass: false, note: "セル境界で頭頂が見切れている" });
  review.expression.pass = false;
  review.expression.grid.alignmentConfirmed = false;

  const derived = deriveIdentityReviewRoiFindings({ review, failedRoles: ["expression"] });
  assert.deepEqual(derived.findings.map((entry) => entry.findingId), ["expression:r1c2", "expression:r3c4"]);
  assert.deepEqual(derived.targetRoles, ["expression"]);
  assert.deepEqual(derived.alignmentOnlyCells.map((entry) => entry.findingId), ["expression:r2c1"]);
  assert.deepEqual(derived.alignmentPendingRoles, ["expression"]);
  const [strap, hair] = derived.findings;
  assert.equal(strap.role, "expression");
  assert.equal(strap.cellId, "r1c2");
  assert.deepEqual(strap.repairRegion, [0.25, 0, 0.25, 0.333333]);
  assert.equal(strap.issue, "side-locked feature one-shoulder-strap must be on subject-right; review recorded subject-left");
  assert.match(strap.repair, /character's own right side \(subject-right\)/u);
  assert.match(strap.repair, /Never create this view by mirroring or flipping another cell/u);
  assert.equal(hair.issue, "前髪の分け目が逆になっている");
  assert.match(hair.problem, /failed hairConsistent/u);
  assert.deepEqual(hair.repairRegion, [0.75, 0.666667, 0.25, 0.333333]);

  // A note that names a drawing defect is content even with every check true.
  assert.equal(classifyFailedIdentityCell(passingCell("x", { pass: false, note: "right profile is a mirrored copy of the left profile" })).kind, "content");
  assert.equal(classifyFailedIdentityCell(passingCell("x", { pass: false, note: "右手が隣のセルにはみ出している" })).kind, "alignment");
  // An uninformative note is never silently skipped.
  assert.equal(classifyFailedIdentityCell(passingCell("x", { pass: false, note: "やり直し" })).kind, "content");
});

test("the in-memory plan is bound to the failed review SHA-256 under its own contract, not the human-QA contract", () => {
  const review = syntheticReview();
  Object.assign(cellOf(review, "r1c2"), { pass: false, sameIdentity: false, note: "別人に見える顔立ち" });
  const { findings } = deriveIdentityReviewRoiFindings({ review, failedRoles: ["expression"] });
  const failedReviewSha256 = createHash("sha256").update("failed-review-bytes").digest("hex");
  const first = buildIdentityReviewRoiRepairPlan({ findings, failedReviewSha256, createdAt: review.reviewer.reviewedAt });
  const second = buildIdentityReviewRoiRepairPlan({ findings, failedReviewSha256, createdAt: review.reviewer.reviewedAt });
  assert.equal(first.plan.digest, second.plan.digest, "resume reproduces the same plan and generation scope");
  assert.ok(verifyCharacterRepairPlanDigest(first.plan).valid);
  assert.equal(first.plan.previousFailureFingerprint, failedReviewSha256);
  assert.equal(first.contractId, IDENTITY_REVIEW_ROI_REPAIR_CONTRACT_ID);
  assert.equal(first.plan.contractDigest, buildCharacterCandidateQualityContract({ castId: IDENTITY_REVIEW_ROI_REPAIR_CONTRACT_ID, maximumReviewRounds: 3 }).digest);
  const humanContract = buildCharacterCandidateQualityContract({ castId: "setting-sheet-human-qa-findings-2026-08-30-r4", maximumReviewRounds: 3 });
  assert.notEqual(first.plan.contractDigest, humanContract.digest, "a review-derived plan can never pass as a human-findings plan");
  assert.deepEqual(first.plan.entries.map((entry) => [entry.cellId, entry.findingId, entry.repairRegion]), [["r1c2", "expression:r1c2", [0.25, 0, 0.25, 0.333333]]]);
  assert.ok(first.plan.entries[0].acceptCriteria.length > 0);
});

test("job prompts carry the ROI lines and issues for exactly the derived cells", () => {
  const review = syntheticReview();
  Object.assign(cellOf(review, "r1c2"), {
    pass: false,
    [SIDE_LOCKED_REVIEW_FLAG]: false,
    asymmetricFeatureChecks: [{ ...STRAP, applicable: true, observedSide: "subject-left", pass: false, note: "鏡像" }],
  });
  Object.assign(cellOf(review, "r3c4"), { pass: false, hairConsistent: false, note: "前髪の分け目が逆になっている" });
  const { findings } = deriveIdentityReviewRoiFindings({ review, failedRoles: ["expression"] });
  const { plan } = buildIdentityReviewRoiRepairPlan({
    findings,
    failedReviewSha256: "a".repeat(64),
    createdAt: review.reviewer.reviewedAt,
  });
  const workflow = { id: "wf", model: "fixture", aspectRatio: "16:9", imageSize: "2K", quality: "high" };
  const cast = { id: "cast", name: "Fixture", description: "Adult", invariants: [], identityPack: { expression: { assetFile: "/failed-expression.png" }, turnaround: { assetFile: "/turnaround.png" } } };
  const jobs = buildApprovedIdentityPackRepairJobs(workflow, cast, { assetFile: "/approved.png" }, ["expression"], { repairId: "roi-1", repairFindings: findings, repairPlan: plan });
  assert.equal(jobs.length, 1);
  const [job] = jobs;
  const roiLines = job.prompt.split("\n").filter((line) => line.startsWith("AUTHORIZED REPAIR ROI "));
  assert.deepEqual(roiLines, [
    "AUTHORIZED REPAIR ROI expression:r1c2: [0.25,0,0.25,0.333333]; everything outside this ROI is immutable.",
    "AUTHORIZED REPAIR ROI expression:r3c4: [0.75,0.666667,0.25,0.333333]; everything outside this ROI is immutable.",
  ]);
  assert.match(job.prompt, /FINDING expression:r1c2: .*side-locked feature one-shoulder-strap must be on subject-right; review recorded subject-left/u);
  assert.match(job.prompt, /FINDING expression:r3c4: 前髪の分け目が逆になっている/u);
  assert.match(job.prompt, /reference image 2 is the existing expression sheet to repair/u);
  assert.deepEqual(job.pipeline.repairRegions, [[0.25, 0, 0.25, 0.333333], [0.75, 0.666667, 0.25, 0.333333]]);
  assert.deepEqual(job.pipeline.repairFindingIds, ["expression:r1c2", "expression:r3c4"]);
  assert.equal(job.pipeline.repairPlanDigest, plan.digest);
});

test("alignment-only and sheet-level-only reviews are refused before any ROI plan exists", () => {
  const alignmentOnly = syntheticReview();
  alignmentOnly.expression.grid.alignmentConfirmed = false;
  alignmentOnly.expression.pass = false;
  const derivedAlignment = deriveIdentityReviewRoiFindings({ review: alignmentOnly, failedRoles: ["expression"] });
  assert.deepEqual(derivedAlignment.findings, []);
  assert.deepEqual(derivedAlignment.alignmentOnlyRoles, ["expression"]);
  assert.throws(() => assertIdentityReviewRoiRepairable(derivedAlignment), /only on grid alignment\/containment.*character-identity-repack/u);

  const sheetOnly = syntheticReview();
  sheetOnly.expression.pass = false;
  const derivedSheet = deriveIdentityReviewRoiFindings({ review: sheetOnly, failedRoles: ["expression"] });
  assert.throws(() => assertIdentityReviewRoiRepairable(derivedSheet), /without any failed cell/u);
});

test("--roi-from-review cannot be combined with the human-findings inputs", async () => {
  await assert.rejects(() => repairKoyaCharacterIdentityPack({
    episodeId: "e", workflowId: "w", castId: "c",
    identityReviewPath: "/tmp/review.json",
    identityFindingsPath: "/tmp/findings.json",
    identityRepairPlanPath: "/tmp/plan.json",
    identityRoiFromReview: true,
    identityRepairId: "r",
  }), /do not combine it with identityFindingsPath/u);
  await assert.rejects(() => repairKoyaCharacterIdentityPack({
    episodeId: "e", workflowId: "w", castId: "c", identityRoiFromReview: true, identityRepairId: "r",
  }), /identityRoiFromReview requires identityReviewPath/u);
});

// ------------------------------------------------------ end-to-end with fakes

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

function testPng(seedNumber, width, height) {
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

async function editJson(pathname, mutate) {
  const value = JSON.parse(await readFile(pathname, "utf8"));
  mutate(value);
  await writeFile(pathname, `${JSON.stringify(value, null, 2)}\n`);
  return value;
}

async function passCandidateReview(pathname) {
  await editJson(pathname, (review) => {
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
    review.notes = "3案は実画像で別設計として識別できる";
  });
}

// Every judgment passes and every side-locked row matches its declared side.
async function passIdentityReview(pathname) {
  return editJson(pathname, (review) => {
    const passCell = (cell) => {
      Object.assign(cell, {
        sameIdentity: true,
        ageConsistent: true,
        hairConsistent: true,
        faceContourConsistent: true,
        faceRegionReviewed: true,
        manualFaceRegion: [0, 0, cell.width, cell.height],
        pass: true,
        note: "原寸確認済み",
      });
      for (const row of cell.asymmetricFeatureChecks || []) {
        Object.assign(row, { applicable: true, observedSide: row.expectedSide, pass: true, note: "原寸で本人基準の左右を確認" });
      }
      if (cell.asymmetricFeatureChecks) cell[SIDE_LOCKED_REVIEW_FLAG] = true;
    };
    review.reviewer = { host: "codex", id: "identity-reviewer", contextId: "identity-review-session", reviewedAt: "2026-10-25T01:02:03.000Z" };
    review.originalScaleInspected = true;
    review.turnaround.isRealTurnaround = true;
    review.turnaround.notCandidateSubstitute = true;
    review.turnaround.grid.alignmentConfirmed = true;
    review.turnaround.pass = true;
    review.turnaround.note = "8方向すべて同一人物と確認";
    for (const view of review.turnaround.viewChecks) passCell(view);
    review.expression.grid.alignmentConfirmed = true;
    review.expression.pass = true;
    review.expression.note = "12セルすべて同一人物と確認";
    for (const cell of review.expression.cells) passCell(cell);
    review.pass = true;
    review.notes = "人物登録可能";
  });
}

async function stageSideLockedPack(projectDir, episodeId) {
  const workflow = await prepareCharacterWorkflow({
    projectDir,
    scriptText: "仮名店員：いらっしゃいませ。",
    episodeId,
    candidateCount: 3,
    cast: [{
      name: "仮名店員",
      description: "片方の肩だけ紐があるワンピースの店員。",
      invariants: ["ワンショルダーのワンピース"],
      sideLockedFeatures: [{ ...STRAP, scopes: ["turnaround", "expression"] }],
    }],
  });
  const jobs = await buildCharacterCandidateJobs(workflow);
  await markCharacterCandidatesGenerating({ projectDir }, workflow.id, jobs);
  const canvasAssets = path.join(projectDir, "canvas", "assets");
  await mkdir(canvasAssets, { recursive: true });
  const results = [];
  for (const [index] of jobs.entries()) {
    const assetFile = path.join(canvasAssets, `roi-candidate-${index + 1}.png`);
    await writeFile(assetFile, testRaster(index + 1));
    results.push({ elementId: `c-${index + 1}`, frameElementId: `f-${index + 1}`, assetFile, assetUrl: `/excalidraw-assets/roi-candidate-${index + 1}.png` });
  }
  const awaitingApproval = await recordCharacterCandidateResults({ projectDir, generatorContextId: "candidate-generator-session" }, workflow.id, jobs, results);
  const workflowCast = awaitingApproval.cast[0];
  await passCandidateReview(workflowCast.candidateReviewDraftPath);
  const selected = workflowCast.candidates[1];
  const packJobs = buildApprovedIdentityPackJobs(awaitingApproval, workflowCast, selected);
  assert.deepEqual(packJobs.map((job) => job.pipeline.identityRole), ["turnaround", "expression"]);
  const turnaroundFile = path.join(canvasAssets, "roi-turnaround.png");
  const expressionFile = path.join(canvasAssets, "roi-expression.png");
  await writeFile(turnaroundFile, testRaster(11, 400, 200));
  await writeFile(expressionFile, testRaster(12, 400, 300));
  const staged = await stageApprovedCharacterIdentityPack({
    projectDir,
    workflowId: workflow.id,
    castId: workflowCast.id,
    candidateId: selected.id,
    approvalReason: "役柄に最も合い、他人物とも明確に区別できる",
    approvedBy: "test-human",
    candidateReviewPath: workflowCast.candidateReviewDraftPath,
    generatorContextId: "identity-generator-session",
    jobs: packJobs,
    results: [
      { elementId: "turnaround-element", assetFile: turnaroundFile, assetUrl: "/excalidraw-assets/roi-turnaround.png" },
      { elementId: "expression-element", assetFile: expressionFile, assetUrl: "/excalidraw-assets/roi-expression.png" },
    ],
  });
  return { workflowId: workflow.id, castId: workflowCast.id, reviewPath: staged.identityReviewDraftPath, expressionFile, turnaroundFile };
}

test("a failed review with two content-failed expression cells repairs exactly those ROIs and stages fresh QA", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-roi-from-review-"));
  const episodeId = "episode-roi-from-review";
  try {
    const staged = await stageSideLockedPack(projectDir, episodeId);
    await passIdentityReview(staged.reviewPath);

    // (c) A passing review is refused: nothing to repair.
    const generatedJobs = [];
    const fakeGenerator = async (job) => {
      generatedJobs.push(job);
      return { buffer: testPng(`repair-${job.pipeline.identityRole}`, 400, 300) };
    };
    const repairOptions = (repairId) => ({
      projectDir,
      episodeId,
      workflowId: staged.workflowId,
      castId: staged.castId,
      identityReviewPath: staged.reviewPath,
      identityRoiFromReview: true,
      identityRepairId: repairId,
      generatorHost: "codex",
      generatorId: "fake-image-model",
      generatorContextId: "repair-generator-session",
      generateImage: fakeGenerator,
    });
    await assert.rejects(() => repairKoyaCharacterIdentityPack(repairOptions("roi-pass")), /review\.pass must be false before repair/u);

    // (b) Alignment-only failure is refused with a repack hint, before anything is archived.
    await editJson(staged.reviewPath, (review) => {
      review.expression.grid.alignmentConfirmed = false;
      review.expression.pass = false;
      review.expression.note = "下段のセルで外周の余白が足りない";
      review.pass = false;
    });
    await assert.rejects(() => repairKoyaCharacterIdentityPack(repairOptions("roi-align")), /character-identity-repack/u);
    const failedReviewsDir = path.join(path.dirname(staged.reviewPath), "failed-reviews");
    const archivedBefore = await readdir(failedReviewsDir).catch(() => []);
    assert.equal(archivedBefore.length, 0, "a refused ROI repair archives nothing");
    assert.equal(generatedJobs.length, 0);

    // (a) Two content-failed expression cells: one mirrored strap, one hair defect.
    await editJson(staged.reviewPath, (review) => {
      review.expression.grid.alignmentConfirmed = true;
      review.expression.note = "2セルが不合格";
      const mirrored = review.expression.cells.find((cell) => cell.id === "r1c2");
      mirrored.pass = false;
      mirrored[SIDE_LOCKED_REVIEW_FLAG] = false;
      Object.assign(mirrored.asymmetricFeatureChecks[0], { observedSide: "subject-left", pass: false, note: "右向きが左向きの鏡像で紐が逆" });
      const hair = review.expression.cells.find((cell) => cell.id === "r3c4");
      Object.assign(hair, { pass: false, hairConsistent: false, note: "前髪の分け目が逆になっている" });
    });
    const failedReviewSha256 = createHash("sha256").update(await readFile(staged.reviewPath)).digest("hex");
    const result = await repairKoyaCharacterIdentityPack(repairOptions("roi-1"));

    assert.equal(result.repairMode, "identity-review-roi");
    assert.deepEqual(result.failedRoles, ["expression"]);
    assert.deepEqual(result.repairedRoles, ["expression"]);
    assert.deepEqual(result.targetCells, ["expression:r1c2", "expression:r3c4"]);
    assert.equal(result.failedReviewSha256, failedReviewSha256);
    assert.equal(result.generatedCount, 1);
    assert.equal(result.reusedRequiredRoleCount, 1, "the passing turnaround is reused untouched");

    assert.equal(generatedJobs.length, 1);
    const [job] = generatedJobs;
    assert.equal(job.pipeline.identityRole, "expression");
    const roiLines = job.prompt.split("\n").filter((line) => line.startsWith("AUTHORIZED REPAIR ROI "));
    assert.deepEqual(roiLines, [
      "AUTHORIZED REPAIR ROI expression:r1c2: [0.25,0,0.25,0.333333]; everything outside this ROI is immutable.",
      "AUTHORIZED REPAIR ROI expression:r3c4: [0.75,0.666667,0.25,0.333333]; everything outside this ROI is immutable.",
    ]);
    assert.match(job.prompt, /FINDING expression:r1c2: 右向きが左向きの鏡像で紐が逆|FINDING expression:r1c2: .*one-shoulder-strap must be on subject-right; review recorded subject-left/u);
    assert.match(job.prompt, /FINDING expression:r3c4: 前髪の分け目が逆になっている/u);
    assert.ok(job.referenceImagePaths.includes(staged.expressionFile), "the failed sheet is the image being edited");
    assert.deepEqual(job.pipeline.repairRegions, [[0.25, 0, 0.25, 0.333333], [0.75, 0.666667, 0.25, 0.333333]]);
    assert.equal(job.pipeline.repairPlanDigest, result.repairPlanDigest);

    // The plan evidence sits next to the archived review and binds its SHA-256.
    const evidence = JSON.parse(await readFile(result.repairPlanPath, "utf8"));
    assert.equal(evidence.mode, "identity-review-roi");
    assert.equal(evidence.contractId, IDENTITY_REVIEW_ROI_REPAIR_CONTRACT_ID);
    assert.equal(evidence.failedReviewSha256, failedReviewSha256);
    assert.equal(evidence.repairPlan.previousFailureFingerprint, failedReviewSha256);
    assert.equal(evidence.repairPlan.digest, result.repairPlanDigest);
    assert.ok(verifyCharacterRepairPlanDigest(evidence.repairPlan).valid);
    assert.deepEqual(evidence.repairPlan.entries.map((entry) => entry.findingId), ["expression:r1c2", "expression:r3c4"]);
    assert.equal(createHash("sha256").update(await readFile(result.failedReviewPath)).digest("hex"), failedReviewSha256);

    // Fresh independent QA is required; nothing auto-passes.
    const store = await readCharacterWorkflowStore({ projectDir });
    const cast = store.workflows.find((entry) => entry.id === staged.workflowId).cast[0];
    assert.equal(cast.status, "awaiting-identity-qa");
    assert.match(cast.identityPack.expression.assetFile, /-repair-roi-1\.png$/u);
    assert.equal(cast.identityPack.turnaround.assetFile.endsWith("roi-turnaround.png"), true);
    const history = cast.identityPack.repairHistory.at(-1);
    assert.equal(history.repairMode, "identity-review-roi");
    assert.deepEqual(history.targetCells, ["expression:r1c2", "expression:r3c4"]);
    assert.equal(history.repairPlanDigest, result.repairPlanDigest);
    assert.equal(history.failedReviewSha256, failedReviewSha256);
    const draft = JSON.parse(await readFile(result.staged.identityReviewDraftPath, "utf8"));
    assert.equal(draft.pass, false);
    assert.ok(draft.expression.cells.every((cell) => cell.pass === false));
    const state = JSON.parse(await readFile(path.join(projectDir, "canvas", "manga-videos", episodeId, "koya-production-state.json"), "utf8"));
    assert.equal(state.status, "character-identity-review-required");
    assert.equal(state.knownRemainingIssues[0].repairMode, "identity-review-roi");
    assert.deepEqual(state.knownRemainingIssues[0].targetCells, ["expression:r1c2", "expression:r3c4"]);
    assert.match(state.knownRemainingIssues[0].detail, /expression:r1c2, expression:r3c4/u);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
