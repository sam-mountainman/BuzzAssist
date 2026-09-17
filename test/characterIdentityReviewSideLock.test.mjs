// 左右（鏡像）ゲートの回帰テスト。
//
// 背景: 2026-09-05 の監査所見 U2。左右非対称の意匠を持つ4人が鏡像欠陥のまま
// 出荷され、4人とも identity review を「全項目 true」で通過した。当時の
// レビューには左右を見たかどうかを表す欄が無く、鏡像シートと正しいシートが
// 帳票上まったく同じ見た目になっていたため。
//
// ここで固定する契約は3つ:
//   1. 宣言があるのに各ビューへ左右判定が入っていなければ落ちる（fail closed）
//   2. 宣言があり各ビューで左右が一致していれば通る
//   3. 宣言が無いキャストの挙動は一切変わらない（完全に無音）
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildApprovedIdentityPackJobs,
  buildCharacterCandidateJobs,
  finalizeApprovedCharacter,
  markCharacterCandidatesGenerating,
  prepareCharacterWorkflow,
  recordCharacterCandidateResults,
  stageApprovedCharacterIdentityPack,
} from "../lib/characterPipeline.mjs";
import { SIDE_LOCKED_REVIEW_FLAG } from "../lib/characterIdentityReview.mjs";
import { readCharacterRegistry } from "../lib/characterRegistry.mjs";

// 実キャスト名は書かない。公開リポジトリの追跡下にチャンネル固有語を入れない
// ため（公開面監査で実際に検出された）。見ているのは左右ゲートの挙動だけ。
const SIDE_LOCKED_CAST = [{
  name: "仮名店主",
  description: "屋台の店主。",
  invariants: ["作務衣"],
  sideLockedFeatures: [
    { id: "shoulder-towel", feature: "肩に掛けた手拭い", expectedSide: "subject-right" },
  ],
}];

const PLAIN_CAST = [{
  name: "仮名店主",
  description: "屋台の店主。",
  invariants: ["作務衣"],
}];

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
  review.notes = "3案は実画像で別設計として識別できる";
  await writeFile(pathname, `${JSON.stringify(review, null, 2)}\n`);
}

// 左右以外の判断だけを全部 true にする。これが「今日 4 人を通した帳票」の形。
async function passEverythingExceptSides(pathname) {
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
  for (const view of review.turnaround.viewChecks) passCell(view);
  review.expression.grid.alignmentConfirmed = true;
  review.expression.pass = true;
  review.expression.note = "12セルすべて同一人物と確認";
  for (const cell of review.expression.cells) passCell(cell);
  for (const sheet of review.outfitSheets || []) {
    Object.assign(sheet, { sameIdentity: true, outfitMatchesSpecification: true, pass: true, note: "衣装仕様一致" });
    sheet.grid.alignmentConfirmed = true;
    for (const cell of sheet.cells) passCell(cell, { outfitMatchesSpecification: true });
  }
  for (const sheet of review.extraSheets || []) {
    Object.assign(sheet, { sameIdentity: true, pass: true, note: "同一人物差分" });
    sheet.grid.alignmentConfirmed = true;
    for (const cell of sheet.cells) passCell(cell, { stateMatchesSpecification: true });
  }
  review.pass = true;
  review.notes = "人物登録可能";
  await writeFile(pathname, `${JSON.stringify(review, null, 2)}\n`);
  return review;
}

function allCells(review) {
  return [
    ...(review.turnaround?.viewChecks || []),
    ...(review.expression?.cells || []),
    ...(review.outfitSheets || []).flatMap((sheet) => sheet.cells || []),
    ...(review.extraSheets || []).flatMap((sheet) => sheet.cells || []),
  ];
}

async function editReview(pathname, mutate) {
  const review = JSON.parse(await readFile(pathname, "utf8"));
  mutate(review);
  await writeFile(pathname, `${JSON.stringify(review, null, 2)}\n`);
  return review;
}

// 候補生成から identity pack の staging までを一通り流す。ここは左右ゲートとは
// 無関係の下ごしらえなので、両ケースで同じ手順を使う。
async function stageIdentityPack(projectDir, cast) {
  const workflow = await prepareCharacterWorkflow({
    projectDir,
    scriptText: "仮名店主：いらっしゃい。",
    episodeId: "episode-side-lock-gate",
    candidateCount: 3,
    cast,
  });
  const jobs = await buildCharacterCandidateJobs(workflow);
  await markCharacterCandidatesGenerating({ projectDir }, workflow.id, jobs);
  const canvasAssets = path.join(projectDir, "canvas", "assets");
  await mkdir(canvasAssets, { recursive: true });
  const results = [];
  for (const [index] of jobs.entries()) {
    const assetFile = path.join(canvasAssets, `gate-candidate-${index + 1}.png`);
    await writeFile(assetFile, testRaster(index + 1));
    results.push({
      elementId: `c-${index + 1}`,
      frameElementId: `f-${index + 1}`,
      assetFile,
      assetUrl: `/excalidraw-assets/gate-candidate-${index + 1}.png`,
    });
  }
  const awaitingApproval = await recordCharacterCandidateResults(
    { projectDir, generatorContextId: "candidate-generator-session" },
    workflow.id,
    jobs,
    results,
  );
  const workflowCast = awaitingApproval.cast[0];
  await passCandidateReview(workflowCast.candidateReviewDraftPath);
  const selected = workflowCast.candidates[1];
  const [turnaroundJob, expressionJob] = buildApprovedIdentityPackJobs(awaitingApproval, workflowCast, selected);
  const turnaroundFile = path.join(canvasAssets, "gate-turnaround.png");
  const expressionFile = path.join(canvasAssets, "gate-expression.png");
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
    jobs: [turnaroundJob, expressionJob],
    results: [
      { elementId: "turnaround-element", assetFile: turnaroundFile, assetUrl: "/excalidraw-assets/gate-turnaround.png" },
      { elementId: "expression-element", assetFile: expressionFile, assetUrl: "/excalidraw-assets/gate-expression.png" },
    ],
  });
  return {
    workflowId: workflow.id,
    castId: workflowCast.id,
    reviewPath: staged.identityReviewDraftPath,
    register: () => finalizeApprovedCharacter({
      projectDir,
      workflowId: workflow.id,
      castId: workflowCast.id,
      identityReviewPath: staged.identityReviewDraftPath,
    }),
  };
}

test("a declared side-locked feature makes the named left/right verdict mandatory on every view", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-side-gate-declared-"));
  try {
    const staged = await stageIdentityPack(projectDir, SIDE_LOCKED_CAST);

    // 下書きは必ず未判定で出る。true が先に置かれていたら、見なくても通る。
    const draft = JSON.parse(await readFile(staged.reviewPath, "utf8"));
    const draftCells = allCells(draft);
    assert.ok(draftCells.length > 0);
    for (const cell of draftCells) {
      assert.equal(cell[SIDE_LOCKED_REVIEW_FLAG], false, `${cell.id} must start unset`);
      for (const row of cell.asymmetricFeatureChecks) {
        assert.equal(row.pass, false);
        assert.equal(row.observedSide, "");
      }
    }

    // 1) 宣言あり・左右未記入: 他の真偽値が全部 true でも落ちる。
    await passEverythingExceptSides(staged.reviewPath);
    await assert.rejects(staged.register, new RegExp(`${SIDE_LOCKED_REVIEW_FLAG} must be true`, "u"));

    // 2) 行だけ正しく埋めてフラグを false のまま残しても落ちる。
    //    「左右を見た」という判断がシートに現れないことが今回の欠陥だった。
    await editReview(staged.reviewPath, (review) => {
      for (const cell of allCells(review)) {
        for (const row of cell.asymmetricFeatureChecks) {
          Object.assign(row, { applicable: true, observedSide: row.expectedSide, pass: true, note: "原寸で本人基準の左右を確認" });
        }
      }
    });
    await assert.rejects(staged.register, new RegExp(`${SIDE_LOCKED_REVIEW_FLAG} must be true`, "u"));

    // 3) 鏡像のシートは、フラグを true にしても通らない（自己申告で上書きできない）。
    await editReview(staged.reviewPath, (review) => {
      for (const cell of allCells(review)) {
        cell[SIDE_LOCKED_REVIEW_FLAG] = true;
        for (const row of cell.asymmetricFeatureChecks) {
          row.observedSide = row.expectedSide === "subject-right" ? "subject-left" : "subject-right";
        }
      }
    });
    await assert.rejects(staged.register, new RegExp(`${SIDE_LOCKED_REVIEW_FLAG} cannot be true`, "u"));

    // 4) 行が一致し、名前付きの判定も true なら通る。
    const registered = await editReview(staged.reviewPath, (review) => {
      for (const cell of allCells(review)) {
        cell[SIDE_LOCKED_REVIEW_FLAG] = true;
        for (const row of cell.asymmetricFeatureChecks) row.observedSide = row.expectedSide;
      }
    });
    assert.ok(allCells(registered).every((cell) => cell[SIDE_LOCKED_REVIEW_FLAG] === true));
    const finalized = await staged.register();
    assert.equal(finalized.character.status, "approved");

    // 宣言は台帳へ残る。ここで落とすと次に読み直したとき検査が黙って消える。
    const registry = await readCharacterRegistry({ projectDir });
    const entry = registry.characters.find((character) => character.id === staged.castId);
    assert.deepEqual(entry.sideLockedFeatures.map((feature) => [feature.id, feature.expectedSide]), [["shoulder-towel", "subject-right"]]);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("a cast that declares no side-locked feature is unaffected by the left/right gate", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-side-gate-undeclared-"));
  try {
    const staged = await stageIdentityPack(projectDir, PLAIN_CAST);

    // 宣言が無ければ、下書きに欄そのものが現れない。
    const draft = JSON.parse(await readFile(staged.reviewPath, "utf8"));
    for (const cell of allCells(draft)) {
      assert.equal(Object.hasOwn(cell, "asymmetricFeatureChecks"), false, `${cell.id} must stay untouched`);
      assert.equal(Object.hasOwn(cell, SIDE_LOCKED_REVIEW_FLAG), false, `${cell.id} must stay untouched`);
    }

    // 従来どおり、左右欄を1つも書かずに登録できる。
    await passEverythingExceptSides(staged.reviewPath);
    const finalized = await staged.register();
    assert.equal(finalized.character.status, "approved");

    const registry = await readCharacterRegistry({ projectDir });
    const entry = registry.characters.find((character) => character.id === staged.castId);
    assert.deepEqual(entry.sideLockedFeatures, []);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
