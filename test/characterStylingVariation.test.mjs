import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildApprovedIdentityPackJobs,
  buildCharacterStylingVariationJobs,
  checkpointCharacterStylingVariationResult,
  composeCharacterStylingQaSheet,
  composeCharacterStylingReviewSheet,
  effectiveCharacterIdentityCandidate,
  findStylingVariationRound,
  findWorkflowCast,
  getCharacterWorkflow,
  markCharacterStylingVariationsGenerating,
  prepareCharacterWorkflow,
  readCharacterWorkflowStore,
  recordFailedCharacterStylingReview,
  recordCharacterStylingVariationResults,
  selectCharacterStylingVariation,
  updateCharacterWorkflow,
  validateCharacterStylingReview,
} from "../lib/characterPipeline.mjs";

function testRaster(seed = 0, width = 64, height = 48) {
  const colors = [[190, 45, 45], [45, 170, 70], [45, 80, 195], [210, 135, 30], [145, 55, 175]];
  const color = colors[seed % colors.length];
  const header = Buffer.from(`P6\n${width} ${height}\n255\n`);
  const pixels = Buffer.alloc(width * height * 3);
  for (let index = 0; index < width * height; index += 1) {
    pixels[index * 3] = color[0];
    pixels[index * 3 + 1] = color[1];
    pixels[index * 3 + 2] = color[2];
  }
  return Buffer.concat([header, pixels]);
}

async function fixture() {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-styling-"));
  const canvasDir = path.join(projectDir, "canvas");
  const assetDir = path.join(canvasDir, "assets");
  await mkdir(assetDir, { recursive: true });
  const baseAsset = path.join(assetDir, "horo-base.png");
  await writeFile(baseAsset, Buffer.from("fake-png-base"));
  const prepared = await prepareCharacterWorkflow({
    projectDir,
    canvasDir,
    episodeId: "episode-style-test",
    scriptText: "もも：テスト",
    cast: [{ name: "もも", role: "fixed", description: "旧案の灰色髪とスカジャンを着た大人の女性", invariants: ["旧案の灰色髪", "八重歯"] }],
  });
  const cast = prepared.cast[0];
  const workflow = await updateCharacterWorkflow({ projectDir, canvasDir }, prepared.id, (current) => {
    current.cast = current.cast.map((entry) => entry.id === cast.id ? {
      ...entry,
      status: "awaiting-approval",
      candidates: [{
        id: `${entry.id}-candidate-a`,
        index: 1,
        status: "generated",
        prompt: "base prompt",
        variationAxis: "base A",
        blindLabel: "A",
        assetFile: baseAsset,
      }],
    } : entry);
    current.status = "awaiting-approval";
    return current;
  });
  return { projectDir, canvasDir, assetDir, workflowId: workflow.id, castId: cast.id, baseAsset };
}

async function load(f) {
  const store = await readCharacterWorkflowStore(f);
  const workflow = getCharacterWorkflow(store, f.workflowId);
  return { store, workflow, cast: findWorkflowCast(workflow, f.castId) };
}

async function passingReview(pathname, rejectedId = "") {
  const review = JSON.parse(await readFile(pathname, "utf8"));
  const rejectedIds = new Set((Array.isArray(rejectedId) ? rejectedId : [rejectedId]).filter(Boolean));
  review.reviewer = { host: "codex", id: "qa-reviewer", contextId: "review-context", reviewedAt: new Date().toISOString() };
  review.originalScaleInspected = true;
  for (const row of review.candidates) {
    const pass = !rejectedIds.has(row.id);
    Object.assign(row, {
      sameIdentity: true,
      ageConsistent: true,
      faceContourConsistent: true,
      eyesConsistent: true,
      browsConsistent: true,
      bodyBuildConsistent: true,
      unchangedTraitsPreserved: true,
      requestedVariationSatisfied: pass,
      noUnrequestedAccessories: true,
      originalScaleInspected: true,
      requirementChecks: row.requirementChecks.map((check) => ({ ...check, pass: true, note: "原寸確認済み" })),
      pass,
      note: pass ? "同一人物と指定差分を原寸確認" : "指定差分が弱いため比較対象から除外",
    });
    for (const comparison of row.comparisonReferenceChecks || []) {
      Object.assign(comparison, {
        distinctFromReference: true,
        originalScaleInspected: true,
        requirementChecks: comparison.requirementChecks.map((check) => ({ ...check, pass: true, note: "参照と明確に異なる" })),
        note: "原寸で除外参照との非類似を確認",
      });
    }
  }
  for (const pair of review.pairChecks) {
    const bothPass = pair.optionIds.every((id) => !rejectedIds.has(id));
    Object.assign(pair, {
      requestedAxisVisiblyDistinct: bothPass,
      notDuplicateTake: bothPass,
      identityStillSamePerson: true,
      unrequestedTraitsRemainMatched: true,
      originalScaleInspected: true,
      pass: bothPass,
      note: bothPass ? "指定軸の差と同一人物性を原寸比較" : "除外候補を含むため比較不合格",
    });
  }
  review.pass = true;
  review.note = "合格候補のみ比較資料へ進める";
  await writeFile(pathname, `${JSON.stringify(review, null, 2)}\n`);
  return review;
}

test("styling variations generate independent sheets, require per-option QA, and select only a SHA-bound passing asset", async () => {
  const f = await fixture();
  try {
    let { workflow, cast } = await load(f);
    const planned = await buildCharacterStylingVariationJobs(workflow, cast.id, "A", {
      version: "koya-character-styling-spec-v1",
      kind: "hairColor",
      sharedInvariants: ["Aの髪シルエット", "編み込みなし", "髪飾りなし"],
      minimumPassingCandidates: 2,
      options: [
        { id: "red-brown", label: "赤茶", description: "落ち着いた赤茶", invariants: ["髪以外の色を変更しない"] },
        { id: "dark-choco", label: "ダークチョコ", description: "暗い焦茶", invariants: ["髪以外の色を変更しない"] },
        { id: "weak-beige", label: "ベージュ", description: "淡いベージュ", invariants: ["髪以外の色を変更しない"] },
      ],
    }, {
      selectionReason: "運営者がAを髪型の土台として指定",
      selectedBy: "human-user",
      generatorHost: "claude",
      generatorId: "claude-generator",
      generatorContextId: "generator-context",
    });
    assert.equal(planned.jobs.length, 3);
    for (const job of planned.jobs) {
      assert.deepEqual(job.referenceImagePaths, [f.baseAsset]);
      assert.match(job.prompt, /ONE fully developed/u);
      assert.match(job.prompt, /NOT a comparison sheet/u);
      assert.match(job.prompt, /species-appropriate four-legged stance/u);
      assert.doesNotMatch(job.prompt, /front-facing full-body standing view/u);
      assert.doesNotMatch(job.prompt, /Reference images 2/u);
      assert.doesNotMatch(job.prompt, /旧案の灰色髪|スカジャン/u);
    }
    await markCharacterStylingVariationsGenerating({ ...f, castId: cast.id }, workflow.id, planned.round);
    const results = [];
    for (const [index, job] of planned.jobs.entries()) {
      const assetFile = path.join(f.assetDir, `style-${index + 1}.png`);
      await writeFile(assetFile, testRaster(index));
      results.push({ assetFile, assetUrl: `/assets/style-${index + 1}.png` });
    }
    const recorded = await recordCharacterStylingVariationResults({ ...f, castId: cast.id }, workflow.id, planned.round.id, planned.jobs, results);
    assert.equal(recorded.round.status, "awaiting-review");
    assert.ok(recorded.round.options.every((option) => option.sha256.length === 64));
    const qa = await composeCharacterStylingQaSheet({ ...f, workflowId: workflow.id, castId: cast.id, roundId: planned.round.id });
    assert.match(await readFile(qa.sheetPath, "utf8"), /未承認・原寸QA用/u);
    assert.equal(qa.manifest.authoritativeApproval, false);
    const reviewed = await passingReview(recorded.reviewDraftPath, "weak-beige");
    ({ workflow, cast } = await load(f));
    let round = findStylingVariationRound(cast, planned.round.id);
    reviewed.candidates[0].generationInputSha256 = "0".repeat(64);
    await writeFile(recorded.reviewDraftPath, `${JSON.stringify(reviewed, null, 2)}\n`);
    await assert.rejects(
      () => validateCharacterStylingReview({ reviewPath: recorded.reviewDraftPath, workflow, cast, round }),
      /generation input SHA-256/u,
    );
    reviewed.candidates[0].generationInputSha256 = round.options[0].generationInputSha256;
    await writeFile(recorded.reviewDraftPath, `${JSON.stringify(reviewed, null, 2)}\n`);
    const validated = await validateCharacterStylingReview({ reviewPath: recorded.reviewDraftPath, workflow, cast, round });
    assert.deepEqual(validated.passingOptionIds, ["red-brown", "dark-choco"]);
    const composed = await composeCharacterStylingReviewSheet({ ...f, workflowId: workflow.id, castId: cast.id, roundId: round.id, reviewPath: recorded.reviewDraftPath });
    const svg = await readFile(composed.sheetPath, "utf8");
    assert.match(svg, /赤茶/u);
    assert.match(svg, /ダークチョコ/u);
    assert.doesNotMatch(svg, /ベージュ/u);
    assert.deepEqual(composed.manifest.candidates.map((entry) => entry.optionId), ["red-brown", "dark-choco"]);

    const originalSvg = svg;
    await writeFile(composed.sheetPath, `${svg}\n<!-- tampered -->\n`);
    await assert.rejects(
      () => selectCharacterStylingVariation({ ...f, workflowId: workflow.id, castId: cast.id, roundId: round.id, optionId: "red-brown", reason: "人間が赤茶を選択" }),
      /bytes changed/u,
    );
    await writeFile(composed.sheetPath, originalSvg);
    const selectedWorkflow = await selectCharacterStylingVariation({ ...f, workflowId: workflow.id, castId: cast.id, roundId: round.id, optionId: "red-brown", reason: "人間が赤茶を選択" });
    const selectedCast = findWorkflowCast(selectedWorkflow, cast.id);
    assert.equal(selectedCast.stylingSelection.optionId, "red-brown");
    const effective = effectiveCharacterIdentityCandidate(selectedCast, selectedCast.candidates[0]);
    assert.equal(effective.assetFile, results[0].assetFile);
    assert.equal(effective.stylingSelection.optionId, "red-brown");
    assert.equal(selectedCast.stylingSelection.optionDescription, "落ち着いた赤茶");
    const identityJobs = buildApprovedIdentityPackJobs(selectedWorkflow, selectedCast, effective);
    assert.match(identityJobs[0].prompt, /落ち着いた赤茶/u);
    assert.match(identityJobs[0].prompt, /species-appropriate four-legged stance/u);
    assert.doesNotMatch(identityJobs[0].prompt, /full-body standing views/u);
    assert.doesNotMatch(identityJobs[0].prompt, /旧案の灰色髪|スカジャン/u);
  } finally {
    await rm(f.projectDir, { recursive: true, force: true });
  }
});

test("a complete independent failed styling review closes the round and permits a replacement-only round", async () => {
  const f = await fixture();
  try {
    let { workflow, cast } = await load(f);
    const planned = await buildCharacterStylingVariationJobs(workflow, cast.id, "A", {
      version: "koya-character-styling-spec-v1",
      kind: "hairstyle",
      minimumPassingCandidates: 2,
      options: [
        { id: "good", description: "短い不揃い前髪" },
        { id: "too-long", description: "長い片寄せ前髪" },
        { id: "top-flick", description: "頭頂にハネのある短髪" },
      ],
    }, { selectionReason: "前髪の修正版を比較する", generatorHost: "codex", generatorId: "generator", generatorContextId: "generator-context" });
    await markCharacterStylingVariationsGenerating({ ...f, castId: cast.id }, workflow.id, planned.round);
    const results = [];
    for (const [index] of planned.jobs.entries()) {
      const assetFile = path.join(f.assetDir, `failed-review-${index + 1}.png`);
      await writeFile(assetFile, Buffer.from(`failed-review-${index + 1}`));
      results.push({ assetFile });
    }
    const recorded = await recordCharacterStylingVariationResults({ ...f, castId: cast.id }, workflow.id, planned.round.id, planned.jobs, results);
    const review = await passingReview(recorded.reviewDraftPath, ["too-long", "top-flick"]);
    review.pass = false;
    review.note = "合格1案だけを保全し、弱い2案を次roundで修正する";
    await writeFile(recorded.reviewDraftPath, `${JSON.stringify(review, null, 2)}\n`);
    const failed = await recordFailedCharacterStylingReview({
      ...f,
      workflowId: workflow.id,
      castId: cast.id,
      roundId: planned.round.id,
      reviewPath: recorded.reviewDraftPath,
    });
    assert.equal(failed.round.status, "failed");
    assert.deepEqual(failed.passingOptionIds, ["good"]);
    assert.deepEqual(failed.rejectedOptionIds.sort(), ["too-long", "top-flick"].sort());
    assert.equal(failed.round.options.find((option) => option.id === "good").status, "passed");
    assert.ok(failed.round.options.filter((option) => option.id !== "good").every((option) => option.status === "rejected"));

    ({ workflow, cast } = await load(f));
    const replacement = await buildCharacterStylingVariationJobs(workflow, cast.id, "A", {
      version: "koya-character-styling-spec-v1",
      kind: "hairstyle",
      minimumPassingCandidates: 2,
      options: [
        { id: "offset-short", description: "頬骨で止まる片寄せ短髪" },
        { id: "broken-short", description: "細束へ分散した非対称短髪" },
      ],
    }, { roundId: "replacement-only", selectionReason: "不合格2案だけを別設計で修正する", generatorHost: "codex", generatorId: "generator", generatorContextId: "generator-context" });
    assert.equal(replacement.jobs.length, 2);
    assert.equal(replacement.round.baseAssetSha256, planned.round.baseAssetSha256);

    await assert.rejects(
      () => buildCharacterStylingVariationJobs(workflow, cast.id, "A", {
        version: "koya-character-styling-spec-v1",
        kind: "hairstyle",
        minimumPassingCandidates: 2,
        options: [
          { id: "invalid-a", description: "短い斜め前髪" },
          { id: "invalid-b", description: "短い細層前髪" },
        ],
      }, {
        ...f,
        roundId: "invalid-repair-source",
        selectionReason: "不合格assetは正の参照に使わない",
        generatorHost: "codex",
        generatorId: "generator",
        generatorContextId: "generator-context",
        repairSourcePath: results[1].assetFile,
      }),
      /passed an earlier independent styling review/u,
    );
    const guidedReplacement = await buildCharacterStylingVariationJobs(workflow, cast.id, "A", {
      version: "koya-character-styling-spec-v1",
      kind: "hairstyle",
      minimumPassingCandidates: 2,
      options: [
        { id: "guided-offset", description: "合格案の短さを保つ片寄せ前髪" },
        { id: "guided-layer", description: "合格案の頭頂を保つ細層前髪" },
      ],
    }, {
      ...f,
      roundId: "guided-replacement",
      selectionReason: "合格済み短髪を正の修復参照にする",
      generatorHost: "codex",
      generatorId: "generator",
      generatorContextId: "generator-context",
      repairSourcePath: results[0].assetFile,
    });
    assert.deepEqual(guidedReplacement.jobs[0].referenceImagePaths, [f.baseAsset, results[0].assetFile]);
    assert.equal(guidedReplacement.round.repairSource.optionId, "good");
    assert.equal(guidedReplacement.round.repairSource.sha256, failed.round.options.find((option) => option.id === "good").sha256);
    assert.match(guidedReplacement.jobs[0].prompt, /previously independently PASSED styling sheet/u);
  } finally {
    await rm(f.projectDir, { recursive: true, force: true });
  }
});

test("styling review rejects self-review and an insufficient number of passing independent sheets", async () => {
  const f = await fixture();
  try {
    const { workflow, cast } = await load(f);
    const planned = await buildCharacterStylingVariationJobs(workflow, cast.id, "A", {
      version: "koya-character-styling-spec-v1",
      kind: "outfit",
      minimumPassingCandidates: 2,
      options: [
        { id: "ol", description: "社会人のOL服" },
        { id: "casual", description: "社会人の私服" },
      ],
    }, { selectionReason: "Bを顔の土台にする", generatorHost: "claude", generatorId: "generator", generatorContextId: "same-context" });
    await markCharacterStylingVariationsGenerating({ ...f, castId: cast.id }, workflow.id, planned.round);
    const results = [];
    for (const [index] of planned.jobs.entries()) {
      const assetFile = path.join(f.assetDir, `outfit-${index + 1}.png`);
      await writeFile(assetFile, Buffer.from(`outfit-${index + 1}`));
      results.push({ assetFile });
    }
    const recorded = await recordCharacterStylingVariationResults({ ...f, castId: cast.id }, workflow.id, planned.round.id, planned.jobs, results);
    const review = await passingReview(recorded.reviewDraftPath, "casual");
    review.reviewer.contextId = "same-context";
    await writeFile(recorded.reviewDraftPath, `${JSON.stringify(review, null, 2)}\n`);
    const loaded = await load(f);
    const round = findStylingVariationRound(loaded.cast, planned.round.id);
    await assert.rejects(
      () => validateCharacterStylingReview({ reviewPath: recorded.reviewDraftPath, workflow: loaded.workflow, cast: loaded.cast, round }),
      /reviewer.contextId must differ|At least 2 styling options/u,
    );
  } finally {
    await rm(f.projectDir, { recursive: true, force: true });
  }
});

test("styling review rejects duplicate takes that are both marked as passing", async () => {
  const f = await fixture();
  try {
    const { workflow, cast } = await load(f);
    const planned = await buildCharacterStylingVariationJobs(workflow, cast.id, "A", {
      version: "koya-character-styling-spec-v1",
      kind: "hairColor",
      minimumPassingCandidates: 2,
      options: [
        { id: "red", description: "赤茶の髪" },
        { id: "brown", description: "焦茶の髪" },
      ],
    }, { selectionReason: "髪色を比較する", generatorHost: "claude", generatorId: "generator", generatorContextId: "generator-context" });
    await markCharacterStylingVariationsGenerating({ ...f, castId: cast.id }, workflow.id, planned.round);
    const duplicateAsset = path.join(f.assetDir, "duplicate-style.png");
    await writeFile(duplicateAsset, testRaster(0));
    const recorded = await recordCharacterStylingVariationResults(
      { ...f, castId: cast.id },
      workflow.id,
      planned.round.id,
      planned.jobs,
      [{ assetFile: duplicateAsset }, { assetFile: duplicateAsset }],
    );
    await passingReview(recorded.reviewDraftPath);
    const loaded = await load(f);
    const round = findStylingVariationRound(loaded.cast, planned.round.id);
    await assert.rejects(
      () => validateCharacterStylingReview({ reviewPath: recorded.reviewDraftPath, workflow: loaded.workflow, cast: loaded.cast, round }),
      /reuses identical bytes/u,
    );
  } finally {
    await rm(f.projectDir, { recursive: true, force: true });
  }
});

test("styling spec rejects duplicate option descriptions disguised by different ids", async () => {
  const f = await fixture();
  try {
    const { workflow, cast } = await load(f);
    await assert.rejects(
      () => buildCharacterStylingVariationJobs(workflow, cast.id, "A", {
        version: "koya-character-styling-spec-v1",
        kind: "outfit",
        options: [
          { id: "take-1", description: "同じ OL 服" },
          { id: "take-2", description: "同じOL服" },
        ],
      }, { selectionReason: "衣装比較を行う", generatorHost: "claude", generatorId: "generator", generatorContextId: "generator-context" }),
      /genuinely different options/u,
    );
  } finally {
    await rm(f.projectDir, { recursive: true, force: true });
  }
});

test("styling rounds cannot branch in parallel or overwrite a newer human selection", async () => {
  const f = await fixture();
  try {
    let { workflow, cast } = await load(f);
    const spec = {
      version: "koya-character-styling-spec-v1",
      kind: "hairColor",
      minimumPassingCandidates: 2,
      options: [
        { id: "red", description: "赤茶の髪" },
        { id: "brown", description: "焦茶の髪" },
      ],
    };
    const first = await buildCharacterStylingVariationJobs(workflow, cast.id, "A", spec, {
      roundId: "first-round",
      selectionReason: "最初の属性を決める",
      generatorHost: "claude",
      generatorId: "generator-one",
      generatorContextId: "generator-one",
    });
    const staleSecond = await buildCharacterStylingVariationJobs(workflow, cast.id, "A", { ...spec, kind: "outfit" }, {
      roundId: "stale-second-round",
      selectionReason: "古いベースから別属性を作る",
      generatorHost: "claude",
      generatorId: "generator-two",
      generatorContextId: "generator-two",
    });
    await markCharacterStylingVariationsGenerating({ ...f, castId: cast.id }, workflow.id, first.round);
    await assert.rejects(
      () => markCharacterStylingVariationsGenerating({ ...f, castId: cast.id }, workflow.id, staleSecond.round),
      /active styling round/u,
    );
    const results = [];
    for (const [index] of first.jobs.entries()) {
      const assetFile = path.join(f.assetDir, `chain-${index + 1}.png`);
      await writeFile(assetFile, testRaster(index));
      results.push({ assetFile });
    }
    const recorded = await recordCharacterStylingVariationResults({ ...f, castId: cast.id }, workflow.id, first.round.id, first.jobs, results);
    await passingReview(recorded.reviewDraftPath);
    ({ workflow, cast } = await load(f));
    const firstRound = findStylingVariationRound(cast, first.round.id);
    await composeCharacterStylingReviewSheet({ ...f, workflowId: workflow.id, castId: cast.id, roundId: firstRound.id, reviewPath: recorded.reviewDraftPath });
    await selectCharacterStylingVariation({ ...f, workflowId: workflow.id, castId: cast.id, roundId: firstRound.id, optionId: "red", reason: "赤茶を正式採用" });
    await assert.rejects(
      () => markCharacterStylingVariationsGenerating({ ...f, castId: cast.id }, workflow.id, staleSecond.round),
      /Styling round is stale/u,
    );
    ({ workflow, cast } = await load(f));
    const chained = await buildCharacterStylingVariationJobs(workflow, cast.id, "A", { ...spec, kind: "outfit" }, {
      roundId: "chained-round",
      selectionReason: "採用済み赤茶assetから次属性を決める",
      generatorHost: "claude",
      generatorId: "generator-three",
      generatorContextId: "generator-three",
    });
    assert.equal(chained.round.baseAssetSha256, cast.stylingSelection.sha256);
    assert.deepEqual(chained.jobs[0].referenceImagePaths, [cast.stylingSelection.assetFile]);
  } finally {
    await rm(f.projectDir, { recursive: true, force: true });
  }
});

test("an all-pass unselected styling round can be atomically superseded by an explicit consolidation round", async () => {
  const f = await fixture();
  try {
    let { workflow, cast } = await load(f);
    const firstSpec = {
      version: "koya-character-styling-spec-v1",
      kind: "hairColor",
      minimumPassingCandidates: 2,
      options: [
        { id: "copper", description: "銅色の明るい茶髪" },
        { id: "amber", description: "琥珀色の自然な茶髪" },
      ],
    };
    const first = await buildCharacterStylingVariationJobs(workflow, cast.id, "A", firstSpec, {
      roundId: "repair-pass-round",
      selectionReason: "修復2色を比較する",
      generatorHost: "claude",
      generatorId: "generator-one",
      generatorContextId: "generator-one-context",
    });
    await markCharacterStylingVariationsGenerating({ ...f, castId: cast.id }, workflow.id, first.round);
    const results = [];
    for (const [index] of first.jobs.entries()) {
      const assetFile = path.join(f.assetDir, `repair-pass-${index + 1}.png`);
      await writeFile(assetFile, testRaster(index));
      results.push({ assetFile });
    }
    const recorded = await recordCharacterStylingVariationResults({ ...f, castId: cast.id }, workflow.id, first.round.id, first.jobs, results);
    await passingReview(recorded.reviewDraftPath);
    await composeCharacterStylingReviewSheet({ ...f, workflowId: workflow.id, castId: cast.id, roundId: first.round.id, reviewPath: recorded.reviewDraftPath });

    ({ workflow, cast } = await load(f));
    const planningWorkflow = {
      ...workflow,
      cast: workflow.cast.map((entry) => entry.id === cast.id ? {
        ...entry,
        stylingVariationRounds: entry.stylingVariationRounds.map((round) => round.id === first.round.id ? { ...round, status: "superseded" } : round),
      } : entry),
    };
    const replacement = await buildCharacterStylingVariationJobs(planningWorkflow, cast.id, "A", {
      ...firstSpec,
      minimumPassingCandidates: 3,
      options: [
        ...firstSpec.options,
        { id: "caramel", description: "キャラメル色の中明度茶髪" },
      ],
    }, {
      roundId: "unified-round",
      selectionReason: "過去の合格色を全て一つの比較へ統合する",
      generatorHost: "legacy-migration",
      generatorId: "passed-byte-unifier",
      generatorContextId: "unifier-context",
    });
    await assert.rejects(
      () => markCharacterStylingVariationsGenerating({ ...f, castId: cast.id }, workflow.id, replacement.round),
      /active styling round/u,
    );
    await markCharacterStylingVariationsGenerating({
      ...f,
      castId: cast.id,
      supersedeStylingRoundId: first.round.id,
    }, workflow.id, replacement.round);
    ({ cast } = await load(f));
    const superseded = findStylingVariationRound(cast, first.round.id);
    const unified = findStylingVariationRound(cast, replacement.round.id);
    assert.equal(superseded.status, "superseded");
    assert.equal(superseded.supersededByRoundId, replacement.round.id);
    assert.match(superseded.supersedeReason, /一つの比較/u);
    assert.equal(unified.status, "generating");
  } finally {
    await rm(f.projectDir, { recursive: true, force: true });
  }
});

test("styling generation resumes the exact round from per-option SHA checkpoints", async () => {
  const f = await fixture();
  try {
    let { workflow, cast } = await load(f);
    const spec = {
      version: "koya-character-styling-spec-v1",
      kind: "hairColor",
      minimumPassingCandidates: 2,
      options: [
        { id: "red", description: "赤茶の髪" },
        { id: "brown", description: "焦茶の髪" },
      ],
    };
    const generation = {
      roundId: "resumable-round",
      selectionReason: "途中停止しても同じ案を再課金しない",
      generatorHost: "claude",
      generatorId: "generator-one",
      generatorContextId: "stable-generation-context",
    };
    const planned = await buildCharacterStylingVariationJobs(workflow, cast.id, "A", spec, generation);
    await markCharacterStylingVariationsGenerating({ ...f, castId: cast.id }, workflow.id, planned.round);
    const firstAsset = path.join(f.assetDir, "resumable-red.png");
    await writeFile(firstAsset, Buffer.from("first-paid-result"));
    await checkpointCharacterStylingVariationResult(
      { ...f, castId: cast.id },
      workflow.id,
      planned.round.id,
      planned.jobs[0],
      { assetFile: firstAsset },
    );
    ({ workflow, cast } = await load(f));
    assert.equal(findStylingVariationRound(cast, planned.round.id).options[0].status, "generated");
    assert.equal(findStylingVariationRound(cast, planned.round.id).options[1].status, "generating");

    const resumed = await buildCharacterStylingVariationJobs(workflow, cast.id, "A", spec, generation);
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.round.options[0].sha256.length, 64);
    const marked = await markCharacterStylingVariationsGenerating({ ...f, castId: cast.id }, workflow.id, resumed.round);
    const markedRound = findStylingVariationRound(findWorkflowCast(marked, cast.id), planned.round.id);
    assert.equal(markedRound.options[0].status, "generated");
    assert.equal(markedRound.options[0].assetFile, firstAsset);

    await assert.rejects(
      () => buildCharacterStylingVariationJobs(marked, cast.id, "A", spec, { ...generation, generatorContextId: "different-context" }),
      /cannot resume/u,
    );
  } finally {
    await rm(f.projectDir, { recursive: true, force: true });
  }
});

test("a non-similarity styling spec requires SHA-bound QA-only comparison references", async () => {
  const f = await fixture();
  try {
    const { workflow, cast } = await load(f);
    const comparisonReference = path.join(f.canvasDir, "references", "existing-anime-comparison.png");
    await mkdir(path.dirname(comparisonReference), { recursive: true });
    await writeFile(comparisonReference, Buffer.from("comparison-reference"));
    const spec = {
      version: "koya-character-styling-spec-v1",
      kind: "hairstyle",
      comparisonEvidenceRequired: true,
      comparisonRequirements: ["輪郭と前髪シルエットが明確に異なる"],
      minimumPassingCandidates: 2,
      options: [
        { id: "short", description: "短い流し前髪" },
        { id: "layered", description: "不揃いな短いレイヤー前髪" },
      ],
    };
    await assert.rejects(
      () => buildCharacterStylingVariationJobs(workflow, cast.id, "A", spec, { ...f, selectionReason: "非類似を確認する", generatorHost: "claude", generatorId: "generator", generatorContextId: "generator-context" }),
      /requires comparisonReferencePaths/u,
    );
    const planned = await buildCharacterStylingVariationJobs(workflow, cast.id, "A", spec, {
      ...f,
      selectionReason: "非類似を確認する",
      generatorHost: "claude",
      generatorId: "generator",
      generatorContextId: "generator-context",
      comparisonReferencePaths: [comparisonReference],
    });
    assert.deepEqual(planned.jobs[0].referenceImagePaths, [f.baseAsset]);
    assert.equal(planned.round.comparisonReferences[0].path, comparisonReference);
    await markCharacterStylingVariationsGenerating({ ...f, castId: cast.id }, workflow.id, planned.round);
    const results = [];
    for (const [index] of planned.jobs.entries()) {
      const assetFile = path.join(f.assetDir, `non-similar-${index + 1}.png`);
      await writeFile(assetFile, Buffer.from(`non-similar-style-${index + 1}`));
      results.push({ assetFile });
    }
    const recorded = await recordCharacterStylingVariationResults({ ...f, castId: cast.id }, workflow.id, planned.round.id, planned.jobs, results);
    await passingReview(recorded.reviewDraftPath);
    let loaded = await load(f);
    let round = findStylingVariationRound(loaded.cast, planned.round.id);
    const passed = await validateCharacterStylingReview({ reviewPath: recorded.reviewDraftPath, workflow: loaded.workflow, cast: loaded.cast, round });
    assert.deepEqual(passed.passingOptionIds, ["short", "layered"]);
    await writeFile(comparisonReference, Buffer.from("mutated-comparison-reference"));
    loaded = await load(f);
    round = findStylingVariationRound(loaded.cast, planned.round.id);
    await assert.rejects(
      () => validateCharacterStylingReview({ reviewPath: recorded.reviewDraftPath, workflow: loaded.workflow, cast: loaded.cast, round }),
      /comparison reference comparison-1 path\/SHA-256/u,
    );
  } finally {
    await rm(f.projectDir, { recursive: true, force: true });
  }
});
