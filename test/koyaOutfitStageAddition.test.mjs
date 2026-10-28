import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deflateSync } from "node:zlib";

import {
  buildApprovedIdentityPackJobs,
  buildCharacterCandidateJobs,
  buildCharacterStylingVariationJobs,
  buildOutfitSheetJob,
  castOutfitSheetStages,
  composeCharacterStylingReviewSheet,
  finalizeApprovedCharacter,
  findStylingVariationRound,
  findWorkflowCast,
  getCharacterWorkflow,
  markCharacterCandidatesGenerating,
  markCharacterStylingVariationsGenerating,
  prepareCharacterWorkflow,
  readCharacterWorkflowStore,
  recordCharacterCandidateResults,
  recordCharacterStylingVariationResults,
  selectCharacterStylingVariation,
  stageApprovedCharacterIdentityPack,
} from "../lib/characterPipeline.mjs";
import {
  optimizeCharacterBindingsForGeneration,
  readCharacterRegistry,
  resolveCharacterBindings,
} from "../lib/characterRegistry.mjs";
import {
  addKoyaRegisteredCharacterOutfitStage,
  assertKoyaStylingSequence,
  buildKoyaIdentityPackJobInput,
} from "../lib/koyaMangaProduction.mjs";
import { createMangaScriptImagePlan } from "../lib/mangaScriptImagePipeline.mjs";

function patternedPng(seedNumber, width = 400, height = 300) {
  const seed = createHash("sha256").update(`outfit-stage-${seedNumber}`).digest();
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (bytes) => {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data = Buffer.alloc(0)) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
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
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND")]);
}

const sha256Of = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");

async function rewriteJson(pathname, mutate) {
  const value = JSON.parse(await readFile(pathname, "utf8"));
  mutate(value);
  await writeFile(pathname, `${JSON.stringify(value, null, 2)}\n`);
}

async function passCandidateReview(pathname) {
  await rewriteJson(pathname, (review) => {
    review.generatorContextId = "candidate-generator-session";
    review.reviewer = { host: "codex", id: "candidate-reviewer", contextId: "candidate-review-session", reviewedAt: new Date().toISOString() };
    review.originalScaleInspected = true;
    for (const candidate of review.candidates) {
      candidate.faceRegionReviewed = true;
      candidate.manualFaceRegion = [0, 0, Math.max(1, candidate.width), Math.max(1, candidate.height)];
    }
    for (const pair of review.pairChecks) {
      Object.assign(pair.visualAxes, { faceShapeDistinct: true, hairSilhouetteDistinct: true });
      Object.assign(pair, { pass: true, note: "原寸で顔型と髪シルエットの差を確認" });
    }
    Object.assign(review, { pass: true, notes: "候補は別設計として識別できる" });
  });
}

async function passIdentityReview(pathname) {
  await rewriteJson(pathname, (review) => {
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
    Object.assign(review.turnaround, { isRealTurnaround: true, notCandidateSubstitute: true, pass: true, note: "8方向すべて同一人物" });
    review.turnaround.grid.alignmentConfirmed = true;
    for (const view of review.turnaround.viewChecks) passCell(view);
    Object.assign(review.expression, { pass: true, note: "12セルすべて同一人物" });
    review.expression.grid.alignmentConfirmed = true;
    for (const cell of review.expression.cells) passCell(cell);
    for (const sheet of review.outfitSheets) {
      Object.assign(sheet, { sameIdentity: true, outfitMatchesSpecification: true, pass: true, note: "段の衣装と一致" });
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
  });
}

async function passStylingReview(pathname) {
  await rewriteJson(pathname, (review) => {
    review.reviewer = { host: "codex", id: "styling-reviewer", contextId: "styling-review-session", reviewedAt: new Date().toISOString() };
    review.originalScaleInspected = true;
    for (const row of review.candidates) {
      Object.assign(row, {
        sameIdentity: true,
        ageConsistent: true,
        faceContourConsistent: true,
        eyesConsistent: true,
        browsConsistent: true,
        bodyBuildConsistent: true,
        unchangedTraitsPreserved: true,
        requestedVariationSatisfied: true,
        noUnrequestedAccessories: true,
        originalScaleInspected: true,
        requirementChecks: row.requirementChecks.map((check) => ({ ...check, pass: true, note: "原寸確認済み" })),
        pass: true,
        note: "同一人物と段の服を原寸確認",
      });
    }
    for (const pair of review.pairChecks) {
      Object.assign(pair, {
        requestedAxisVisiblyDistinct: true,
        notDuplicateTake: true,
        identityStillSamePerson: true,
        unrequestedTraitsRemainMatched: true,
        originalScaleInspected: true,
        pass: true,
        note: "服の違いと同一人物性を原寸比較",
      });
    }
    review.pass = true;
    review.note = "合格案だけを比較資料へ進める";
  });
}

async function loadCast(projectDir, workflowId, castId) {
  const store = await readCharacterWorkflowStore({ projectDir });
  const workflow = getCharacterWorkflow(store, workflowId);
  return { workflow, cast: findWorkflowCast(workflow, castId) };
}

// 候補の選択 → 三面図・表情の登録まで（今の通常の流れ）を済ませた、回ごとの人物を1人作る。
async function registeredCharacter(projectDir, episodeId) {
  const canvasDir = join(projectDir, "canvas");
  const assetDir = join(canvasDir, "assets");
  await mkdir(assetDir, { recursive: true });
  const prepared = await prepareCharacterWorkflow({
    projectDir,
    scriptText: "田中：同窓会で会おう。",
    episodeId,
    candidateCount: 3,
    cast: [{ name: "田中", description: "28歳の会社員。黒髪で前髪が重い。", invariants: ["黒髪", "黒いスーツ"] }],
  });
  const candidateJobs = await buildCharacterCandidateJobs(prepared);
  await markCharacterCandidatesGenerating({ projectDir }, prepared.id, candidateJobs);
  const candidateResults = [];
  for (const [index] of candidateJobs.entries()) {
    const assetFile = join(assetDir, `candidate-${index + 1}.png`);
    await writeFile(assetFile, patternedPng(index + 1, 96, 72));
    candidateResults.push({ elementId: `candidate-${index + 1}`, assetFile });
  }
  const awaiting = await recordCharacterCandidateResults({ projectDir, generatorContextId: "candidate-generator-session" }, prepared.id, candidateJobs, candidateResults);
  const cast = awaiting.cast[0];
  await passCandidateReview(cast.candidateReviewDraftPath);
  const selected = cast.candidates[1];
  const identityJobs = buildApprovedIdentityPackJobs(awaiting, cast, selected);
  const turnaroundFile = join(assetDir, "turnaround.png");
  const expressionFile = join(assetDir, "expression.png");
  await writeFile(turnaroundFile, patternedPng(11, 400, 200));
  await writeFile(expressionFile, patternedPng(12, 400, 300));
  const staged = await stageApprovedCharacterIdentityPack({
    projectDir,
    workflowId: prepared.id,
    castId: cast.id,
    candidateId: selected.id,
    approvalReason: "原寸比較で役柄に最も合うと判断した",
    approvedBy: "test-human",
    candidateReviewPath: cast.candidateReviewDraftPath,
    generatorContextId: "identity-generator-session",
    jobs: identityJobs,
    results: [{ assetFile: turnaroundFile }, { assetFile: expressionFile }],
  });
  await passIdentityReview(staged.identityReviewDraftPath);
  const finalized = await finalizeApprovedCharacter({
    projectDir,
    workflowId: prepared.id,
    castId: cast.id,
    identityReviewPath: staged.identityReviewDraftPath,
  });
  assert.equal(finalized.workflow.status, "ready");
  return { canvasDir, assetDir, workflowId: prepared.id, castId: cast.id, selected, registered: finalized.character };
}

const HIGH_SCHOOL_SPEC = {
  version: "koya-character-styling-spec-v1",
  characterId: "test-character",
  kind: "outfit",
  storyStage: { id: "high-school", label: "高校時代", age: "17歳（高校3年）" },
  sharedInvariants: ["同じ人物（顔の作り・目・髪の色と質感）"],
  minimumPassingCandidates: 1,
  options: [
    { id: "gakuran", label: "黒の学ラン", description: "黒の詰襟の学生服（学ラン）。金ボタン、白シャツは見せない", invariants: ["詰襟は閉じる"] },
    { id: "blazer", label: "紺のブレザー", description: "紺のブレザーの制服とえんじのネクタイ", invariants: ["ネクタイは結ぶ"] },
  ],
};

// 段の回（storyStage を書いたスタイリングの回）を、別担当のレビューと人の選択まで進める。
async function selectedStageRound(projectDir, fixture, { optionId = "gakuran" } = {}) {
  const { workflow, cast } = await loadCast(projectDir, fixture.workflowId, fixture.castId);
  const planned = await buildCharacterStylingVariationJobs(workflow, cast.id, fixture.selected.blindLabel, HIGH_SCHOOL_SPEC, {
    projectDir,
    selectionReason: "依頼主が回想の場面に高校時代の姿を求めた",
    selectedBy: "test-human",
    generatorHost: "claude",
    generatorId: "stage-generator",
    generatorContextId: "stage-generator-session",
  });
  assert.equal(planned.round.storyStage.id, "high-school");
  assert.match(planned.jobs[0].prompt, /17歳（高校3年）/u, "a story-stage round asks for the stage age instead of locking the default age");
  await markCharacterStylingVariationsGenerating({ projectDir, castId: cast.id }, workflow.id, planned.round);
  const results = [];
  for (const [index] of planned.jobs.entries()) {
    const assetFile = join(fixture.assetDir, `stage-option-${index + 1}.png`);
    await writeFile(assetFile, patternedPng(30 + index, 160, 90));
    results.push({ assetFile });
  }
  const recorded = await recordCharacterStylingVariationResults({ projectDir, castId: cast.id }, workflow.id, planned.round.id, planned.jobs, results);
  const draft = JSON.parse(await readFile(recorded.reviewDraftPath, "utf8"));
  assert.equal(draft.storyStage.age, "17歳（高校3年）", "the reviewer sees which story stage and age the round approves");
  assert.match(draft.storyStageGuidance, /not against the base asset's age/u);
  await passStylingReview(recorded.reviewDraftPath);
  await composeCharacterStylingReviewSheet({ projectDir, workflowId: workflow.id, castId: cast.id, roundId: planned.round.id, reviewPath: recorded.reviewDraftPath });
  await selectCharacterStylingVariation({
    projectDir,
    workflowId: workflow.id,
    castId: cast.id,
    roundId: planned.round.id,
    optionId,
    reason: "依頼主が回想の場面の服として学ランを選んだ",
    selectedBy: "test-client",
  });
  return { roundId: planned.round.id, authorityFile: results[0].assetFile };
}

test("後から足した段だけが衣装の板を要し、宣言どおりの2段以上は今までどおり全段で作る", () => {
  const added = { id: "high-school", description: "学ラン", addition: { version: "koya-outfit-stage-addition-v1" } };
  assert.deepEqual(castOutfitSheetStages({ outfitStages: [] }), []);
  assert.deepEqual(castOutfitSheetStages({ outfitStages: [{ id: "adult", description: "スーツ" }] }), [], "a single declared stage is the identity's own outfit");
  assert.deepEqual(castOutfitSheetStages({ outfitStages: [{ id: "office", description: "OL" }, { id: "private", description: "私服" }] }).map((stage) => stage.id), ["office", "private"]);
  assert.deepEqual(castOutfitSheetStages({ outfitStages: [added] }).map((stage) => stage.id), ["high-school"]);
  assert.deepEqual(castOutfitSheetStages({ outfitStages: [{ id: "adult", description: "スーツ" }, added] }).map((stage) => stage.id), ["high-school"], "adding a stage does not demand a sheet for the single declared stage");

  const workflow = { id: "wf", model: "test-model", aspectRatio: "16:9", imageSize: "2K", quality: "high" };
  const cast = { id: "cast-1", name: "田中", description: "28歳の会社員", invariants: [] };
  const candidate = { id: "cand-1", assetFile: "/tmp/face.png" };
  const aged = buildOutfitSheetJob(workflow, cast, candidate, { id: "high-school", label: "高校時代", age: "17歳", description: "学ラン", invariants: [], referenceAssetFile: "/tmp/stage.png" });
  assert.match(aged.prompt, /Required story-stage age: 17歳/u);
  assert.match(aged.prompt, /story-stage age, face proportions/u);
  assert.doesNotMatch(aged.prompt, /no age drift,/u);
  const unchanged = buildOutfitSheetJob(workflow, cast, candidate, { id: "office", label: "OL", description: "スーツ", invariants: [], referenceAssetFile: "/tmp/stage.png" });
  assert.match(unchanged.prompt, /no age drift, no face drift/u, "stages without an age keep the original prompt");
});

test("show bible の回の順の照合は、段の回を数えない", async () => {
  const root = await mkdtemp(join(tmpdir(), "koya-stage-sequence-"));
  try {
    const specPath = join(root, "spec.json");
    await writeFile(specPath, "{}\n");
    const specSha256 = await sha256Of(specPath);
    const authority = { root, showBible: {} };
    const member = { id: "member-1", name: "常連", stylingSpecPath: specPath };
    const cast = {
      stylingVariationRounds: [
        { id: "identity", status: "selected", specPath, specSha256, specCharacterId: "member-1", options: [] },
        { id: "stage", status: "selected", storyStage: { id: "high-school" }, specPath: join(root, "stage.json"), specSha256: "0".repeat(64), specCharacterId: "member-1", options: [] },
      ],
    };
    const sequence = await assertKoyaStylingSequence(authority, member, cast);
    assert.equal(sequence.complete, true);
    assert.deepEqual(sequence.selectedRounds.map((round) => round.id), ["identity"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("登録済みの人物に服の段を足すと、その段の板だけを作り、顔・三面図・表情は同じバイトのまま登録し直す", async () => {
  const savedPack = process.env.BUZZASSIST_CHANNEL_PACK;
  delete process.env.BUZZASSIST_CHANNEL_PACK;
  const projectDir = await mkdtemp(join(tmpdir(), "koya-outfit-stage-add-"));
  try {
    const episodeId = "manga-outfit-stage-add";
    const fixture = await registeredCharacter(projectDir, episodeId);
    const before = (await readCharacterRegistry({ projectDir })).characters.find((entry) => entry.id === fixture.castId);
    const beforeSha = Object.fromEntries(before.referenceAssets.map((asset) => [asset.role, asset.sha256]));
    const generator = { host: "codex", id: "stage-sheet-tool", contextId: "stage-sheet-session" };
    const add = (extra = {}) => addKoyaRegisteredCharacterOutfitStage({
      projectDir,
      episodeId,
      workflowId: fixture.workflowId,
      castId: fixture.castId,
      generatorHost: generator.host,
      generatorId: generator.id,
      generatorContextId: generator.contextId,
      ...extra,
    });

    // 段の回の人の選択が無いうちは、元絵として使わない。
    await assert.rejects(() => add({ stylingRoundId: "missing-round" }), /not a story-stage styling round/u);
    const stage = await selectedStageRound(projectDir, fixture);
    let { cast } = await loadCast(projectDir, fixture.workflowId, fixture.castId);
    assert.equal(cast.stylingSelection, null, "selecting a story-stage round never replaces the identity selection");
    assert.equal(cast.status, "ready");
    const round = findStylingVariationRound(cast, stage.roundId);
    assert.equal(round.status, "selected");
    assert.equal(round.stageSelection.optionId, "gakuran");
    assert.equal(round.stageSelection.selectedBy, "test-client");

    // 計画だけ：段の衣装の板1枚の公式ジョブと入力の SHA を返し、何も書かない。
    const plan = await add({ stylingRoundId: stage.roundId, planOnly: true });
    assert.equal(plan.planOnly, true);
    assert.deepEqual(plan.jobs.map((job) => job.key), ["outfit:high-school"]);
    assert.equal(plan.jobs[0].referenceImagePaths[0], fixture.selected.assetFile);
    assert.equal(plan.jobs[0].referenceImagePaths[1], stage.authorityFile, "the selected stage option is the outfit authority");
    assert.match(plan.jobs[0].prompt, /17歳（高校3年）/u);
    ({ cast } = await loadCast(projectDir, fixture.workflowId, fixture.castId));
    assert.deepEqual(cast.outfitStages, [], "planning does not declare the stage");

    // Codex などで作った板を import map で取り込む。
    const sourceFile = join(fixture.canvasDir, "identity-import", "high-school-sheet.png");
    await mkdir(join(fixture.canvasDir, "identity-import"), { recursive: true });
    await writeFile(sourceFile, patternedPng(50, 400, 100));
    const sourceSha256 = await sha256Of(sourceFile);
    const importMapPath = join(fixture.canvasDir, "identity-import", "high-school.json");
    const writeImportMap = async (entries) => writeFile(importMapPath, `${JSON.stringify({
      version: "koya-identity-generation-import-v1",
      workflowId: fixture.workflowId,
      castId: fixture.castId,
      candidateSha256: plan.frozenFaceSha256,
      generator,
      generationScopeId: plan.generationScopeId,
      entries,
    }, null, 2)}\n`);
    await writeImportMap([{ key: "outfit:high-school", sourceFile, sourceSha256, inputSha256: plan.jobs[0].inputSha256 }]);
    const recomputed = await buildKoyaIdentityPackJobInput({
      workflowId: fixture.workflowId,
      castId: fixture.castId,
      candidateSha256: plan.frozenFaceSha256,
      generator,
      job: plan.jobs[0],
    });
    assert.equal(recomputed.inputSha256, plan.jobs[0].inputSha256);

    const added = await add({ stylingRoundId: stage.roundId, identityGenerationImportMapPath: importMapPath });
    assert.equal(added.storyStage, "high-school");
    assert.equal(added.generatedCount, 1);
    ({ cast } = await loadCast(projectDir, fixture.workflowId, fixture.castId));
    assert.equal(cast.status, "awaiting-identity-qa");
    assert.equal(cast.outfitStages.length, 1);
    assert.equal(cast.outfitStages[0].id, "high-school");
    assert.equal(cast.outfitStages[0].age, "17歳（高校3年）");
    assert.equal(cast.outfitStages[0].referenceAssetSha256, await sha256Of(stage.authorityFile));
    assert.equal(cast.outfitStages[0].addition.stylingRoundId, stage.roundId);
    assert.equal(cast.identityPack.turnaround.sha256, beforeSha.turnaround);
    assert.equal(cast.identityPack.expression.sha256, beforeSha.expression);
    assert.equal(cast.identityPack.selectedFace.sha256, beforeSha["identity-face"]);
    assert.deepEqual(cast.identityPack.outfitSheets.map((sheet) => [sheet.storyStage, sheet.sha256]), [["high-school", sourceSha256]]);
    assert.equal(cast.identityPack.outfitAdditionHistory.at(-1).storyStage, "high-school");
    const archived = cast.identityPack.outfitAdditionHistory.at(-1).priorIdentityReviewArchivePath;
    assert.equal(await sha256Of(archived), before.approval.identityReviewSha256, "the registered identity review is archived before the draft is rewritten");
    const draft = JSON.parse(await readFile(added.identityReviewDraftPath, "utf8"));
    assert.deepEqual(draft.outfitSheets.map((sheet) => sheet.storyStage), ["high-school"]);
    assert.equal(draft.outfitSheets[0].storyStageAge, "17歳（高校3年）", "the identity reviewer judges the sheet against the stage age");
    assert.equal(added.state.status, "character-identity-review-required");

    // 一度置いた後は、同じ入口で置き直さない（点検の続きか、直しの入口で進める）。
    await assert.rejects(() => add({ stylingRoundId: stage.roundId, identityGenerationImportMapPath: importMapPath }), /registered ready character/u);

    // 直しの入口は、足した段の板を役割として扱える。
    const repairKeys = buildApprovedIdentityPackJobs((await loadCast(projectDir, fixture.workflowId, fixture.castId)).workflow, cast, fixture.selected)
      .map((job) => `${job.pipeline.identityRole}:${job.pipeline.storyStage || ""}`);
    assert.deepEqual(repairKeys, ["turnaround:", "expression:", "outfit:high-school"]);

    await passIdentityReview(added.identityReviewDraftPath);
    const finalized = await finalizeApprovedCharacter({
      projectDir,
      workflowId: fixture.workflowId,
      castId: fixture.castId,
      identityReviewPath: added.identityReviewDraftPath,
    });
    assert.equal(finalized.workflow.status, "ready");
    const after = finalized.character;
    assert.deepEqual(after.referenceAssets.map((asset) => [asset.role, asset.storyStage]), [
      ["identity-face", ""], ["turnaround", ""], ["expression", ""], ["outfit", "high-school"],
    ]);
    for (const role of ["identity-face", "turnaround", "expression"]) {
      assert.equal(after.referenceAssets.find((asset) => asset.role === role).sha256, beforeSha[role], `${role} keeps the registered bytes`);
    }
    const outfit = after.referenceAssets.find((asset) => asset.role === "outfit");
    assert.equal(outfit.id, "outfit-high-school");
    assert.equal(outfit.sha256, sourceSha256);
    assert.equal(outfit.stageOnly, true, "a stage added later is sent only to images that request it");

    // 登録した後は、同じ段をもう一度足さない。
    await assert.rejects(() => add({ stylingRoundId: stage.roundId }), /already registered/u);

    // 既定の参照には出ず、段を指定した時だけ選ばれる。
    const registry = await readCharacterRegistry({ projectDir });
    const [binding] = resolveCharacterBindings(registry, [fixture.castId], { projectDir });
    assert.equal(binding.referenceImagePaths.length, 3);
    assert.ok(binding.referenceAssets.some((asset) => asset.stageOnly === true));
    const [plainRoute] = optimizeCharacterBindingsForGeneration([binding], { referenceIntent: "outfit" });
    assert.ok(!plainRoute.referenceAssets.some((asset) => asset.role === "outfit"), "an unspecified outfit request never picks a stage-only sheet");
    const [stageRoute] = optimizeCharacterBindingsForGeneration([binding], { storyStage: "high-school" });
    assert.equal(stageRoute.referenceAssets.at(-1).sha256, sourceSha256);
  } finally {
    if (savedPack === undefined) delete process.env.BUZZASSIST_CHANNEL_PACK;
    else process.env.BUZZASSIST_CHANNEL_PACK = savedPack;
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("登録の画素が変わっていたら、段を足さない", async () => {
  const savedPack = process.env.BUZZASSIST_CHANNEL_PACK;
  delete process.env.BUZZASSIST_CHANNEL_PACK;
  const projectDir = await mkdtemp(join(tmpdir(), "koya-outfit-stage-tamper-"));
  try {
    const episodeId = "manga-outfit-stage-tamper";
    const fixture = await registeredCharacter(projectDir, episodeId);
    const stage = await selectedStageRound(projectDir, fixture);
    const turnaround = fixture.registered.referenceAssets.find((asset) => asset.role === "turnaround");
    await writeFile(join(fixture.canvasDir, turnaround.path), patternedPng(99, 400, 200));
    await assert.rejects(() => addKoyaRegisteredCharacterOutfitStage({
      projectDir,
      episodeId,
      workflowId: fixture.workflowId,
      castId: fixture.castId,
      stylingRoundId: stage.roundId,
      generatorHost: "codex",
      generatorId: "stage-sheet-tool",
      generatorContextId: "stage-sheet-session",
      planOnly: true,
    }), /turnaround.*bytes changed after registration/u);
  } finally {
    if (savedPack === undefined) delete process.env.BUZZASSIST_CHANNEL_PACK;
    else process.env.BUZZASSIST_CHANNEL_PACK = savedPack;
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("回想のコマは段の板を先頭の参照にし、指定の無いコマには後から足した段の板を送らない", async () => {
  const root = await mkdtemp(join(tmpdir(), "koya-outfit-stage-panels-"));
  try {
    const asset = (id, role, storyStage = "", extra = {}) => ({ id, role, path: `assets/characters/${id}.png`, sha256: "", storyStage, sourceReviewPath: "", ...extra });
    const tanakaAssets = [
      asset("tanaka-face", "identity-face"),
      asset("tanaka-turnaround", "turnaround"),
      asset("tanaka-expression", "expression"),
      asset("tanaka-outfit-high-school", "outfit", "high-school", { stageOnly: true }),
    ];
    const registry = {
      characters: [
        {
          id: "tanaka",
          name: "田中",
          kind: "character",
          status: "approved",
          aliases: [],
          // 登録はこの形で全部の板のパスを並べる（後から足した段の板も入る）。
          referenceImagePaths: tanakaAssets.map((entry) => entry.path),
          referenceAssets: tanakaAssets,
        },
        { id: "sato", name: "佐藤", kind: "character", status: "approved", aliases: [], referenceImagePaths: [] },
      ],
    };
    const scriptText = [
      "【カット1：同窓会】",
      "田中：久しぶりだな。",
      "【カット2：高校時代の回想】",
      "田中：あの日の音楽室を覚えてる。",
      "佐藤：もちろん。",
    ].join("\n");
    const plan = (overrides) => createMangaScriptImagePlan({
      scriptText,
      episodeId: "outfit-stage-panels",
      registry,
      canvasDir: root,
      assetDir: join(root, "assets"),
      visualPlanOverrides: overrides,
    });
    const stagePath = join(root, "assets/characters/tanaka-outfit-high-school.png");
    const facePath = join(root, "assets/characters/tanaka-face.png");

    const plain = plan(undefined);
    for (const job of plain.jobs.filter((entry) => entry.characterIds?.includes("tanaka"))) {
      assert.ok(!job.referenceImagePaths.includes(stagePath), `${job.id} must not receive the stage-only sheet`);
      assert.ok(!job.fallbackReferenceImagePaths.includes(stagePath), `${job.id} fallback must not receive the stage-only sheet`);
    }

    const flashback = plan({
      version: "test-visual-plan-v1",
      byUtterance: { "cut-02-u01": { disableEditorialPlate: true, storyStage: "high-school" } },
    });
    const flashbackJob = flashback.jobs.find((entry) => (entry.id === "image:cut-02-u01" || entry.id.startsWith("panel:cut-02-u01:")) && entry.characterIds.includes("tanaka"));
    assert.ok(flashbackJob);
    assert.equal(flashbackJob.referenceImagePaths[0], stagePath, "the stage sheet anchors the character in the flashback");
    assert.ok(flashbackJob.referenceImagePaths.includes(facePath));
    assert.ok(!flashbackJob.referenceImagePaths.includes(join(root, "assets/characters/tanaka-turnaround.png")), "the default-outfit turnaround is not sent in a stage panel");
    assert.match(flashbackJob.prompt, /story stage 'high-school'/u);
    assert.match(flashbackJob.prompt, /田中/u);
    assert.deepEqual(flashbackJob.outfitStage, { id: "high-school", characterIds: ["tanaka"] });
    const plainJob = plain.jobs.find((entry) => entry.id === flashbackJob.id);
    assert.notEqual(flashbackJob.inputHash, plainJob?.inputHash);

    assert.throws(() => plan({
      version: "test-visual-plan-v1",
      byUtterance: { "cut-02-u01": { disableEditorialPlate: true, storyStage: "middle-school" } },
    }), /middle-school/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
