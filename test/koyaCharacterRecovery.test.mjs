// 消えた承認済みの人物の絵を取り戻す経路（character-identity-recover）の回帰テスト。
//
// 背景: 2026-10-18 に自動整理が canvas/assets を消し、登録簿は「承認済み」のまま
// 参照先のファイルが無くなった。候補の取り込みは承認済みの身元を置き換えられず、
// refresh は消えた顔の SHA を照合できないので、取り戻し専用の経路を足した。
//
// ここで固定する契約:
//   1. 登録簿のファイルが1つでも残っていれば何も書かずに止まる（上書きしない）
//   2. 顔は取り戻した絵だけ。生成した顔では身元を置き換えない
//   3. 生成したセルは、取り戻した顔を身元の参照に持つ記録が要る
//   4. 板は、宣言したセルを宣言した順に並べたものでなければならない
//   5. 点検は取り戻しの確認（名前のある真偽値）が無いと通らず、通れば新しい SHA で登録し直す
//   6. 衣装の板は、登録簿の story stage をちょうど全部、登録簿のバイト（restored / repacked）で戻す
//   7. 登録簿の板から切り出しただけのセル（restored-cell）は、同じ役割の登録簿の SHA から切ったものだけ
import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { crc32, deflateSync } from "node:zlib";

import {
  buildApprovedIdentityPackJobs,
  buildCharacterCandidateJobs,
  finalizeApprovedCharacter,
  markCharacterCandidatesGenerating,
  prepareCharacterWorkflow,
  recordCharacterCandidateResults,
  readCharacterWorkflowStore,
  stageApprovedCharacterIdentityPack,
} from "../lib/characterPipeline.mjs";
import {
  REQUIRED_EXPRESSION_CELLS,
  REQUIRED_TURNAROUND_VIEWS,
} from "../lib/characterIdentityReview.mjs";
import {
  CHARACTER_IDENTITY_RECOVERY_VERSION,
  normalizeCharacterRegistry,
  readCharacterRegistry,
} from "../lib/characterRegistry.mjs";
import { requirePythonRuntime } from "../lib/harnessRuntimeResolver.mjs";
import {
  KOYA_CHARACTER_RECOVERY_MAP_VERSION,
  recoverKoyaRegisteredCharacterIdentity,
} from "../lib/koyaCharacterRecovery.mjs";

const execFile = promisify(execFileCallback);
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const COMPOSE_SCRIPT = path.join(REPO_ROOT, "scripts", "compose-koya-identity-grid.py");

// 実キャスト名は書かない（公開リポジトリの追跡下にチャンネル固有語を入れない）。
const CAST = [{ name: "仮名店主", description: "屋台の店主。", invariants: ["作務衣"] }];

function rasterPixels(seed, width, height) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      pixels[offset] = (x * (seed + 3) + y * 2) % 256;
      pixels[offset + 1] = (y * (seed + 5) + x) % 256;
      pixels[offset + 2] = ((x + y) * (seed + 7)) % 256;
    }
  }
  return pixels;
}

function testRaster(seed = 1, width = 96, height = 72) {
  return Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), rasterPixels(seed, width, height)]);
}

// 切り出しを画素で照らす試験用に、同じ絵柄を本物の PNG（8bit RGB）で書く。
function testPng(seed, width, height) {
  return pngFromRgb(rasterPixels(seed, width, height), width, height);
}

function pngFromRgb(pixels, width, height) {
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) pixels.copy(rows, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha256File = async (file) => sha256(await readFile(file));

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

async function passIdentityReview(pathname, reviewerContextId) {
  return editJson(pathname, (review) => {
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
    review.reviewer = { host: "codex", id: "identity-reviewer", contextId: reviewerContextId, reviewedAt: new Date().toISOString() };
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
    for (const sheet of review.extraSheets || []) {
      Object.assign(sheet, { sameIdentity: true, pass: true, note: "同一人物差分" });
      sheet.grid.alignmentConfirmed = true;
      for (const cell of sheet.cells) passCell(cell, { stateMatchesSpecification: true });
    }
    for (const sheet of review.outfitSheets || []) {
      Object.assign(sheet, { sameIdentity: true, outfitMatchesSpecification: true, pass: true, note: "衣装の4方向を確認" });
      sheet.grid.alignmentConfirmed = true;
      for (const cell of sheet.cells) passCell(cell, { outfitMatchesSpecification: true });
    }
    review.pass = true;
    review.notes = "人物登録可能";
  });
}

// 候補 → identity pack → 登録までを一度流し、登録済みの人物を作る。
// options.cast で衣装の story stage を持つ人物にでき、options.pngSheets で板を本物の PNG にする。
async function registerCharacter(projectDir, options = {}) {
  const workflow = await prepareCharacterWorkflow({
    projectDir,
    scriptText: "仮名店主：いらっしゃい。",
    episodeId: "episode-recovery",
    candidateCount: 3,
    cast: options.cast || CAST,
  });
  const jobs = await buildCharacterCandidateJobs(workflow);
  await markCharacterCandidatesGenerating({ projectDir }, workflow.id, jobs);
  const assets = path.join(projectDir, "canvas", "assets");
  await mkdir(assets, { recursive: true });
  const results = [];
  for (const [index] of jobs.entries()) {
    const assetFile = path.join(assets, `candidate-${index + 1}.png`);
    await writeFile(assetFile, testRaster(index + 1));
    results.push({ elementId: `c-${index + 1}`, frameElementId: `f-${index + 1}`, assetFile, assetUrl: `/excalidraw-assets/candidate-${index + 1}.png` });
  }
  const awaitingApproval = await recordCharacterCandidateResults(
    { projectDir, generatorContextId: "candidate-generator-session" },
    workflow.id,
    jobs,
    results,
  );
  const cast = awaitingApproval.cast[0];
  await passCandidateReview(cast.candidateReviewDraftPath);
  const selected = cast.candidates[1];
  const identityJobs = buildApprovedIdentityPackJobs(awaitingApproval, cast, selected);
  const sheetBytes = (seed, width, height) => (options.pngSheets ? testPng(seed, width, height) : testRaster(seed, width, height));
  const identityResults = [];
  for (const [index, job] of identityJobs.entries()) {
    const role = job.pipeline?.identityRole;
    const stage = job.pipeline?.storyStage || "";
    const name = role === "outfit" ? `outfit-${stage}` : role;
    const assetFile = path.join(assets, `${name}.png`);
    const size = role === "turnaround" ? [400, 200] : role === "expression" ? [400, 300] : role === "outfit" ? [400, 100] : [200, 200];
    await writeFile(assetFile, sheetBytes(role === "turnaround" ? 11 : role === "expression" ? 12 : 20 + index, ...size));
    identityResults.push({ elementId: `${name}-element`, assetFile, assetUrl: `/excalidraw-assets/${name}.png` });
  }
  const staged = await stageApprovedCharacterIdentityPack({
    projectDir,
    workflowId: workflow.id,
    castId: cast.id,
    candidateId: selected.id,
    approvalReason: "役柄に最も合い、他人物とも明確に区別できる",
    approvedBy: "test-human",
    candidateReviewPath: cast.candidateReviewDraftPath,
    generatorContextId: "identity-generator-session",
    jobs: identityJobs,
    results: identityResults,
  });
  await passIdentityReview(staged.identityReviewDraftPath, "identity-review-session");
  const finalized = await finalizeApprovedCharacter({ projectDir, workflowId: workflow.id, castId: cast.id, identityReviewPath: staged.identityReviewDraftPath });
  return { workflowId: workflow.id, castId: cast.id, character: finalized.character };
}

async function deleteRegisteredFiles(projectDir, character) {
  for (const asset of character.referenceAssets) await rm(path.join(projectDir, "canvas", asset.path), { force: true });
}

async function compose(python, cells, { columns, rows, width, height, output, manifest, workDir }) {
  const cellsPath = path.join(workDir, `${path.basename(output, ".png")}-cells.json`);
  await writeFile(cellsPath, JSON.stringify(cells));
  await execFile(python.command, [...python.args, COMPOSE_SCRIPT, "--cells", cellsPath, "--output", output, "--manifest", manifest,
    "--columns", String(columns), "--rows", String(rows), "--width", String(width), "--height", String(height)]);
}

// PDF から取り出した絵の代わりに、色の違うラスタを置く。8 方向の 1 つだけを「生成した」セルにする。
async function buildRecoveryMap(projectDir, { workflowId, castId }, python, overrides = {}) {
  const workDir = path.join(projectDir, "recovery-materials");
  await mkdir(workDir, { recursive: true });
  const pdfPath = path.join(workDir, "client-delivery.pdf");
  await writeFile(pdfPath, "%PDF-1.4 fixture\n");
  const pdfSha256 = await sha256File(pdfPath);
  const specPath = path.join(workDir, "recovery-spec.md");
  await writeFile(specPath, "# 取り戻しの仕様\n先方へ送った PDF の採用の絵を、描き直さずに格子へ並べる。\n");
  const write = async (name, bytes) => {
    const file = path.join(workDir, name);
    await writeFile(file, bytes);
    return { path: file, sha256: sha256(bytes) };
  };
  const recovered = (file, page, index) => ({
    origin: "recovered",
    source: { path: file.path, sha256: file.sha256, pdfPath, pdfSha256, page, index, extractor: "pdfimgs.swift" },
  });
  const face = await write("face.ppm", testRaster(40, 160, 90));
  const promptFile = await write("generated-prompt.md", Buffer.from("右横の全身を、参照1の顔のまま白背景で描く\n"));
  const turnaroundCells = [];
  for (const [index, id] of REQUIRED_TURNAROUND_VIEWS.entries()) {
    const file = await write(`turnaround-${id}.ppm`, testRaster(50 + index, 60, 120));
    turnaroundCells.push(id === "right-profile-full-body" ? {
      id,
      origin: "generated",
      generated: {
        path: file.path,
        sha256: file.sha256,
        generator: { host: "codex", id: "image-model", contextId: "recovery-generator-session", generatedAt: "2026-10-25T00:00:00.000Z" },
        promptPath: promptFile.path,
        promptSha256: promptFile.sha256,
        referenceImages: [{ path: face.path, sha256: face.sha256, role: overrides.generatedReferenceRole || "identity-face" }],
      },
    } : { id, ...recovered(file, 35, index + 1) });
  }
  const expressionCells = [];
  for (const [index, id] of REQUIRED_EXPRESSION_CELLS.entries()) {
    const file = await write(`expression-${id}.ppm`, testRaster(70 + index, 80, 80));
    expressionCells.push({ id, ...recovered(file, 36, index + 1) });
  }
  const cellPath = (cell) => cell.source?.path || cell.generated.path;
  const turnaroundSheet = path.join(workDir, "turnaround.png");
  const expressionSheet = path.join(workDir, "expression.png");
  const turnaroundOrder = overrides.swapTurnaroundCells
    ? [turnaroundCells[1], turnaroundCells[0], ...turnaroundCells.slice(2)]
    : turnaroundCells;
  await compose(python, turnaroundOrder.map((cell, index) => ({ id: turnaroundCells[index].id, path: cellPath(cell) })), {
    columns: 4, rows: 2, width: 800, height: 400, output: turnaroundSheet, manifest: path.join(workDir, "turnaround.compose.json"), workDir,
  });
  await compose(python, expressionCells.map((cell) => ({ id: cell.id, path: cellPath(cell) })), {
    columns: 4, rows: 3, width: 800, height: 600, output: expressionSheet, manifest: path.join(workDir, "expression.compose.json"), workDir,
  });
  const map = {
    version: KOYA_CHARACTER_RECOVERY_MAP_VERSION,
    workflowId,
    castId,
    recoveryId: overrides.recoveryId || "fixture-recovery-1",
    reason: "承認済みの設定画のファイルが自動整理で消えたため、先方へ送った PDF の採用の絵から取り戻す",
    importedBy: { host: "claude", id: "importer", contextId: "recovery-importer-session" },
    specification: { path: specPath, sha256: await sha256File(specPath) },
    selectedFace: overrides.generatedFace
      ? { origin: "generated", generated: turnaroundCells[2].generated }
      : recovered(face, 8, 1),
    turnaround: {
      sheetPath: turnaroundSheet,
      sha256: await sha256File(turnaroundSheet),
      composeManifestPath: path.join(workDir, "turnaround.compose.json"),
      composeManifestSha256: await sha256File(path.join(workDir, "turnaround.compose.json")),
      cells: turnaroundCells,
    },
    expression: {
      sheetPath: expressionSheet,
      sha256: await sha256File(expressionSheet),
      composeManifestPath: path.join(workDir, "expression.compose.json"),
      composeManifestSha256: await sha256File(path.join(workDir, "expression.compose.json")),
      cells: expressionCells,
    },
    eyeOpenSheets: [],
  };
  const mapPath = path.join(workDir, "recovery-map.json");
  await writeFile(mapPath, `${JSON.stringify(map, null, 2)}\n`);
  return mapPath;
}

async function pythonOrSkip(t) {
  try {
    return await requirePythonRuntime({ purposeEnv: "KOYA_GATE_PYTHON", projectDir: REPO_ROOT, requiredModules: ["cv2", "cv2:CascadeClassifier", "numpy", "PIL"] });
  } catch (error) {
    t.skip(`取り戻しの試験には identity review と同じ Python（cv2・numpy・PIL）が要る: ${error.message}`);
    return null;
  }
}

test("recovery refuses a registration whose approved files and identity review are all intact", async (t) => {
  const python = await pythonOrSkip(t);
  if (!python) return;
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-recovery-present-"));
  try {
    const registered = await registerCharacter(projectDir);
    const mapPath = await buildRecoveryMap(projectDir, registered, python);
    const before = await readFile(path.join(projectDir, "canvas", "character-workflows.json"), "utf8");
    await assert.rejects(
      () => recoverKoyaRegisteredCharacterIdentity({ projectDir, workflowId: registered.workflowId, castId: registered.castId, recoveryMapPath: mapPath }),
      /identity review intact; there is nothing to recover/u,
    );
    assert.equal(await readFile(path.join(projectDir, "canvas", "character-workflows.json"), "utf8"), before);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("recovery map rejects a generated face, an unanchored generated cell, and a sheet composed in a different order", async (t) => {
  const python = await pythonOrSkip(t);
  if (!python) return;
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-recovery-invalid-"));
  try {
    const registered = await registerCharacter(projectDir);
    await deleteRegisteredFiles(projectDir, registered.character);
    const run = (mapPath) => recoverKoyaRegisteredCharacterIdentity({ projectDir, workflowId: registered.workflowId, castId: registered.castId, recoveryMapPath: mapPath });
    await assert.rejects(async () => run(await buildRecoveryMap(projectDir, registered, python, { generatedFace: true })), /selectedFace\.origin must be recovered/u);
    await assert.rejects(async () => run(await buildRecoveryMap(projectDir, registered, python, { generatedReferenceRole: "style" })), /must include the recovered identity face/u);
    await assert.rejects(async () => run(await buildRecoveryMap(projectDir, registered, python, { swapTurnaroundCells: true })), /is not the image that was composed into the sheet/u);
    const store = await readCharacterWorkflowStore({ projectDir });
    assert.equal(store.workflows[0].cast[0].status, "ready", "a rejected map must not move the character out of ready");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("a recovered pack needs the recovery acknowledgement and re-registers with new SHA-bound files", async (t) => {
  const python = await pythonOrSkip(t);
  if (!python) return;
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-recovery-pass-"));
  try {
    const registered = await registerCharacter(projectDir);
    const previousFaceSha256 = registered.character.referenceAssets.find((asset) => asset.role === "identity-face").sha256;
    await deleteRegisteredFiles(projectDir, registered.character);
    const mapPath = await buildRecoveryMap(projectDir, registered, python);
    const result = await recoverKoyaRegisteredCharacterIdentity({ projectDir, workflowId: registered.workflowId, castId: registered.castId, recoveryMapPath: mapPath });
    assert.equal(result.recoveredCellCount, 19);
    assert.equal(result.generatedCellCount, 1);

    const draft = JSON.parse(await readFile(result.identityReviewDraftPath, "utf8"));
    assert.equal(draft.recovery.evidenceSha256, result.evidenceSha256);
    assert.equal(draft.recovery.provenanceGapAcknowledged, false, "the draft must start unacknowledged");
    assert.equal(draft.recovery.generatedCellsConsistent, false);

    const register = () => finalizeApprovedCharacter({ projectDir, workflowId: registered.workflowId, castId: registered.castId, identityReviewPath: result.identityReviewDraftPath });
    await passIdentityReview(result.identityReviewDraftPath, "recovery-review-session");
    await assert.rejects(register, /recovery\.provenanceGapAcknowledged must be true/u);

    await editJson(result.identityReviewDraftPath, (review) => {
      Object.assign(review.recovery, {
        provenanceGapAcknowledged: true,
        recoveredCellsMatchSources: true,
        generatedCellsConsistent: true,
        note: "証跡の PDF・ページ・番号と各セルを原寸で照合した",
      });
    });
    // 証跡が見た後に差し替えられたら通さない。
    const evidence = await readFile(result.evidencePath, "utf8");
    await writeFile(result.evidencePath, evidence.replace("fixture-recovery-1", "fixture-recovery-x"));
    await assert.rejects(register, /recovery evidence file is missing or changed/u);
    await writeFile(result.evidencePath, evidence);

    const finalized = await register();
    assert.equal(finalized.character.status, "approved");
    assert.equal(finalized.character.approval.recovery.recoveryId, "fixture-recovery-1");
    assert.equal(finalized.character.approval.recovery.version, CHARACTER_IDENTITY_RECOVERY_VERSION);
    const face = finalized.character.referenceAssets.find((asset) => asset.role === "identity-face");
    assert.notEqual(face.sha256, previousFaceSha256, "recovery binds the recovered bytes, not the lost SHA");
    assert.equal(face.sha256, await sha256File(path.join(projectDir, "canvas", face.path)));
    assert.match(finalized.character.notes, /^Recovered \(fixture-recovery-1\)/u);
    const reread = await readCharacterRegistry({ projectDir });
    assert.equal(reread.characters.find((entry) => entry.id === registered.castId).approval.recovery.evidenceSha256, result.evidenceSha256);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("the registry drops a malformed recovery record instead of keeping half of it", () => {
  const registry = normalizeCharacterRegistry({
    characters: [{
      id: "cast-1",
      status: "approved",
      approval: { route: "human-best-of-n", recovery: { version: CHARACTER_IDENTITY_RECOVERY_VERSION, recoveryId: "r1", evidencePath: "/x.json", evidenceSha256: "not-a-sha" } },
    }],
  });
  assert.equal(Object.hasOwn(registry.characters[0].approval, "recovery"), false);
});

// 送付用の素材一式（zip）などから、登録簿の SHA とバイトまで同じ板を戻せた場合の対応表。
// overrides.recoverExpressionFromArchive なら表情だけを、zip の中の絵から組み直したセルにする。
async function buildRestoredMap(projectDir, registered, python, overrides = {}) {
  const workDir = path.join(projectDir, "restore-materials");
  await mkdir(workDir, { recursive: true });
  const canvas = path.join(projectDir, "canvas");
  const asset = (role) => registered.character.referenceAssets.find((entry) => entry.role === role);
  const restored = (role) => ({ origin: "restored", sheetPath: path.join(canvas, asset(role).path), sha256: asset(role).sha256 });
  const specPath = path.join(workDir, "restore-spec.md");
  await writeFile(specPath, "# 戻しの仕様\n送付用の素材一式から、登録簿の SHA と同じ板を戻す。\n");
  const map = {
    version: KOYA_CHARACTER_RECOVERY_MAP_VERSION,
    workflowId: registered.workflowId,
    castId: registered.castId,
    recoveryId: overrides.recoveryId || "fixture-restore-1",
    reason: "点検の記録と一部の板が消えたため、送付用の素材一式から戻して点検をやり直す",
    importedBy: { host: "claude", id: "importer", contextId: "restore-importer-session" },
    specification: { path: specPath, sha256: await sha256File(specPath) },
    selectedFace: { origin: "restored", path: path.join(canvas, asset("identity-face").path), sha256: asset("identity-face").sha256 },
    turnaround: restored("turnaround"),
    expression: restored("expression"),
    eyeOpenSheets: [],
  };
  if (overrides.recoverExpressionFromArchive) {
    const archivePath = path.join(workDir, "delivery-package.zip");
    await writeFile(archivePath, "PK fixture archive\n");
    const archiveSha256 = await sha256File(archivePath);
    const cells = [];
    for (const [index, id] of REQUIRED_EXPRESSION_CELLS.entries()) {
      const bytes = testRaster(90 + index, 80, 80);
      const file = path.join(workDir, `expression-${id}.ppm`);
      await writeFile(file, bytes);
      cells.push({ id, origin: "recovered", source: { path: file, sha256: sha256(bytes), archivePath, archiveSha256, member: `characters/fixture/expression_${id}.png` } });
    }
    const sheet = path.join(workDir, "expression.png");
    const manifest = path.join(workDir, "expression.compose.json");
    await compose(python, cells.map((cell) => ({ id: cell.id, path: cell.source.path })), { columns: 4, rows: 3, width: 800, height: 600, output: sheet, manifest, workDir });
    map.expression = { sheetPath: sheet, sha256: await sha256File(sheet), composeManifestPath: manifest, composeManifestSha256: await sha256File(manifest), cells };
  }
  const mapPath = path.join(workDir, "restore-map.json");
  await writeFile(mapPath, `${JSON.stringify(map, null, 2)}\n`);
  return mapPath;
}

test("a partly lost registration keeps restored sheets and recovers only the lost role from an archive", async (t) => {
  const python = await pythonOrSkip(t);
  if (!python) return;
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-recovery-partial-"));
  try {
    const registered = await registerCharacter(projectDir);
    const canvas = path.join(projectDir, "canvas");
    const before = Object.fromEntries(registered.character.referenceAssets.map((entry) => [entry.role, entry.sha256]));
    await rm(path.join(canvas, registered.character.referenceAssets.find((entry) => entry.role === "expression").path));
    const mapPath = await buildRestoredMap(projectDir, registered, python, { recoverExpressionFromArchive: true });
    const result = await recoverKoyaRegisteredCharacterIdentity({ projectDir, workflowId: registered.workflowId, castId: registered.castId, recoveryMapPath: mapPath });
    assert.equal(result.restoredSheetCount, 2);
    assert.equal(result.recoveredCellCount, 12);
    const draft = JSON.parse(await readFile(result.identityReviewDraftPath, "utf8"));
    assert.equal(draft.recovery.recoveredCellsMatchSources, false);
    assert.equal(Object.hasOwn(draft.recovery, "generatedCellsConsistent"), false);

    await passIdentityReview(result.identityReviewDraftPath, "restore-review-session");
    await editJson(result.identityReviewDraftPath, (review) => Object.assign(review.recovery, {
      provenanceGapAcknowledged: true, recoveredCellsMatchSources: true, note: "zip の中の元の絵と各セルを照合した",
    }));
    const finalized = await finalizeApprovedCharacter({ projectDir, workflowId: registered.workflowId, castId: registered.castId, identityReviewPath: result.identityReviewDraftPath });
    const after = Object.fromEntries(finalized.character.referenceAssets.map((entry) => [entry.role, entry.sha256]));
    assert.equal(after["identity-face"], before["identity-face"], "a restored face keeps its approved SHA");
    assert.equal(after.turnaround, before.turnaround, "a restored sheet keeps its approved SHA");
    assert.notEqual(after.expression, before.expression);
    assert.equal(finalized.character.approval.recovery.restoredSheetCount, 2);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("a registered file with different bytes stops recovery before anything is written", async (t) => {
  const python = await pythonOrSkip(t);
  if (!python) return;
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-recovery-tampered-"));
  try {
    const registered = await registerCharacter(projectDir);
    const canvas = path.join(projectDir, "canvas");
    const mapPath = await buildRestoredMap(projectDir, registered, python);
    await rm(path.join(canvas, registered.character.referenceAssets.find((entry) => entry.role === "expression").path));
    await writeFile(path.join(canvas, registered.character.referenceAssets.find((entry) => entry.role === "turnaround").path), testRaster(77, 400, 200));
    await assert.rejects(
      () => recoverKoyaRegisteredCharacterIdentity({ projectDir, workflowId: registered.workflowId, castId: registered.castId, recoveryMapPath: mapPath }),
      /not byte-identical to the registry/u,
    );
    const store = await readCharacterWorkflowStore({ projectDir });
    assert.equal(store.workflows[0].cast[0].status, "ready");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("a lost identity review alone is re-recorded with every sheet restored and the approved SHAs unchanged", async (t) => {
  const python = await pythonOrSkip(t);
  if (!python) return;
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-recovery-review-only-"));
  try {
    const registered = await registerCharacter(projectDir);
    await rm(registered.character.approval.identityReviewPath);
    const mapPath = await buildRestoredMap(projectDir, registered, python);
    const result = await recoverKoyaRegisteredCharacterIdentity({ projectDir, workflowId: registered.workflowId, castId: registered.castId, recoveryMapPath: mapPath });
    assert.equal(result.restoredSheetCount, 3);
    assert.equal(result.recoveredCellCount, 0);
    const draft = JSON.parse(await readFile(result.identityReviewDraftPath, "utf8"));
    assert.deepEqual(Object.keys(draft.recovery).filter((key) => typeof draft.recovery[key] === "boolean"), ["provenanceGapAcknowledged"]);

    await passIdentityReview(result.identityReviewDraftPath, "restore-review-session");
    await editJson(result.identityReviewDraftPath, (review) => Object.assign(review.recovery, { provenanceGapAcknowledged: true, note: "消えた点検の記録を、戻した板で取り直した" }));
    const finalized = await finalizeApprovedCharacter({ projectDir, workflowId: registered.workflowId, castId: registered.castId, identityReviewPath: result.identityReviewDraftPath });
    assert.deepEqual(
      finalized.character.referenceAssets.map((entry) => entry.sha256),
      registered.character.referenceAssets.map((entry) => entry.sha256),
    );
    assert.notEqual(finalized.character.approval.identityReviewSha256, registered.character.approval.identityReviewSha256);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

const REPACK_SCRIPT = path.join(REPO_ROOT, "scripts", "repack-koya-identity-grid.py");

async function repackRegisteredSheet(projectDir, registered, python, role, { columns, rows, fromPath, storyStage = "" } = {}) {
  const workDir = path.join(projectDir, "repack-materials");
  await mkdir(workDir, { recursive: true });
  const asset = registered.character.referenceAssets.find((entry) => entry.role === role && (entry.storyStage || "") === storyStage);
  const source = fromPath || path.join(projectDir, "canvas", asset.path);
  const name = storyStage ? `${role}-${storyStage}` : role;
  const output = path.join(workDir, `${name}-repack.png`);
  const manifest = path.join(workDir, `${name}-repack.manifest.json`);
  await execFile(python.command, [...python.args, REPACK_SCRIPT, "--input", source, "--output", output, "--manifest", manifest,
    "--columns", String(columns), "--rows", String(rows)]);
  return { origin: "repacked", sheetPath: output, sha256: await sha256File(output), repackManifestPath: manifest, repackManifestSha256: await sha256File(manifest) };
}

test("a restored sheet repacked without redrawing is accepted only from the registered bytes and needs its own acknowledgement", async (t) => {
  const python = await pythonOrSkip(t);
  if (!python) return;
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-recovery-repacked-"));
  try {
    const registered = await registerCharacter(projectDir);
    await rm(registered.character.approval.identityReviewPath);
    const mapPath = await buildRestoredMap(projectDir, registered, python);
    const map = JSON.parse(await readFile(mapPath, "utf8"));

    // 登録簿の板ではないもの（顔の画像）から収め直した板は拒む
    const wrongSource = await repackRegisteredSheet(projectDir, registered, python, "expression", {
      columns: 4, rows: 3, fromPath: path.join(projectDir, "canvas", registered.character.referenceAssets.find((entry) => entry.role === "turnaround").path),
    });
    await writeFile(mapPath, JSON.stringify({ ...map, expression: wrongSource }, null, 2));
    await assert.rejects(
      recoverKoyaRegisteredCharacterIdentity({ projectDir, workflowId: registered.workflowId, castId: registered.castId, recoveryMapPath: mapPath }),
      /not repacked from the registered sheet/u,
    );

    const repacked = await repackRegisteredSheet(projectDir, registered, python, "expression", { columns: 4, rows: 3 });
    await writeFile(mapPath, JSON.stringify({ ...map, recoveryId: "fixture-repacked-1", expression: repacked }, null, 2));
    const result = await recoverKoyaRegisteredCharacterIdentity({ projectDir, workflowId: registered.workflowId, castId: registered.castId, recoveryMapPath: mapPath });
    assert.equal(result.repackedSheetCount, 1);
    assert.equal(result.restoredSheetCount, 2);
    const draft = JSON.parse(await readFile(result.identityReviewDraftPath, "utf8"));
    assert.deepEqual(Object.keys(draft.recovery).filter((key) => typeof draft.recovery[key] === "boolean"), ["provenanceGapAcknowledged", "repackedSheetsMatchSources"]);

    await passIdentityReview(result.identityReviewDraftPath, "repack-review-session");
    await editJson(result.identityReviewDraftPath, (review) => Object.assign(review.recovery, { provenanceGapAcknowledged: true, note: "戻した板と収め直した板を照らした" }));
    await assert.rejects(
      finalizeApprovedCharacter({ projectDir, workflowId: registered.workflowId, castId: registered.castId, identityReviewPath: result.identityReviewDraftPath }),
      /repackedSheetsMatchSources/u,
    );
    await editJson(result.identityReviewDraftPath, (review) => Object.assign(review.recovery, { repackedSheetsMatchSources: true }));
    const finalized = await finalizeApprovedCharacter({ projectDir, workflowId: registered.workflowId, castId: registered.castId, identityReviewPath: result.identityReviewDraftPath });
    const sha = (character, role) => character.referenceAssets.find((entry) => entry.role === role).sha256;
    assert.equal(sha(finalized.character, "identity-face"), sha(registered.character, "identity-face"));
    assert.equal(sha(finalized.character, "turnaround"), sha(registered.character, "turnaround"));
    assert.equal(sha(finalized.character, "expression"), repacked.sha256);
    assert.equal(finalized.character.approval.recovery.repackedSheetCount, 1);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("a recovery still waiting for review can be replaced by a new recovery, and the old one is kept as evidence", async (t) => {
  const python = await pythonOrSkip(t);
  if (!python) return;
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-recovery-restage-"));
  try {
    const registered = await registerCharacter(projectDir);
    await rm(registered.character.approval.identityReviewPath);
    const mapPath = await buildRestoredMap(projectDir, registered, python);
    const first = await recoverKoyaRegisteredCharacterIdentity({ projectDir, workflowId: registered.workflowId, castId: registered.castId, recoveryMapPath: mapPath });
    const map = JSON.parse(await readFile(mapPath, "utf8"));
    const repacked = await repackRegisteredSheet(projectDir, registered, python, "expression", { columns: 4, rows: 3 });
    await writeFile(mapPath, JSON.stringify({ ...map, recoveryId: "fixture-restage-2", expression: repacked }, null, 2));
    const second = await recoverKoyaRegisteredCharacterIdentity({ projectDir, workflowId: registered.workflowId, castId: registered.castId, recoveryMapPath: mapPath });
    const evidence = JSON.parse(await readFile(second.evidencePath, "utf8"));
    assert.equal(evidence.supersedesRecovery.recoveryId, first.recoveryId);
    assert.equal(evidence.supersedesRecovery.evidenceSha256, first.evidenceSha256);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

// 衣装の story stage を2つ持つ人物（実例は7つ。数が違うだけで扱いは同じ）。
const OUTFIT_CAST = [{
  ...CAST[0],
  outfitStages: [
    { id: "stage-a", label: "仕込み", description: "仕込みの前掛け姿" },
    { id: "stage-b", label: "営業", description: "営業中の作務衣姿" },
  ],
}];

const outfitAsset = (registered, stage) => registered.character.referenceAssets.find((entry) => entry.role === "outfit" && entry.storyStage === stage);
const restoredOutfit = (projectDir, registered, stage, fromStage = stage) => ({
  storyStage: stage,
  origin: "restored",
  sheetPath: path.join(projectDir, "canvas", outfitAsset(registered, fromStage).path),
  sha256: outfitAsset(registered, fromStage).sha256,
});

async function writeMap(mapPath, map) {
  await writeFile(mapPath, `${JSON.stringify(map, null, 2)}\n`);
  return mapPath;
}

test("registered outfit sheets are restored byte-identical (or repacked), reviewed, and re-registered with their roles and story stages", async (t) => {
  const python = await pythonOrSkip(t);
  if (!python) return;
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-recovery-outfits-"));
  try {
    const registered = await registerCharacter(projectDir, { cast: OUTFIT_CAST });
    assert.deepEqual(registered.character.referenceAssets.filter((entry) => entry.role === "outfit").map((entry) => entry.storyStage), ["stage-a", "stage-b"]);
    // 衣装の1枚が消え、送付用の素材一式から同じバイトの板が見つかった。点検の記録も消えている。
    const backupDir = path.join(projectDir, "delivery-package");
    await mkdir(backupDir, { recursive: true });
    const stageAFile = path.join(projectDir, "canvas", outfitAsset(registered, "stage-a").path);
    const stageABackup = path.join(backupDir, "outfit-stage-a.png");
    await copyFile(stageAFile, stageABackup);
    await rm(stageAFile);
    await rm(registered.character.approval.identityReviewPath);

    const mapPath = await buildRestoredMap(projectDir, registered, python);
    const map = JSON.parse(await readFile(mapPath, "utf8"));
    const repackedStageB = await repackRegisteredSheet(projectDir, registered, python, "outfit", { columns: 4, rows: 1, storyStage: "stage-b" });
    await writeMap(mapPath, {
      ...map,
      outfitSheets: [
        { storyStage: "stage-b", ...repackedStageB },
        { storyStage: "stage-a", origin: "restored", sheetPath: stageABackup, sha256: outfitAsset(registered, "stage-a").sha256 },
      ],
    });
    const result = await recoverKoyaRegisteredCharacterIdentity({ projectDir, workflowId: registered.workflowId, castId: registered.castId, recoveryMapPath: mapPath });
    assert.equal(result.restoredSheetCount, 4, "face, turnaround, expression and the restored outfit");
    assert.equal(result.repackedSheetCount, 1);
    assert.equal(result.outfitSheetCount, 2);
    assert.equal(Object.hasOwn(result, "restoredCellCount"), false, "a zero restored-cell count is not written");

    const store = await readCharacterWorkflowStore({ projectDir });
    const stagedOutfits = store.workflows[0].cast[0].identityPack.outfitSheets;
    assert.deepEqual(stagedOutfits.map((sheet) => sheet.storyStage), ["stage-a", "stage-b"], "staged in registry order");
    assert.equal(stagedOutfits[0].sha256, outfitAsset(registered, "stage-a").sha256);
    assert.equal(stagedOutfits[1].sha256, repackedStageB.sha256);
    const evidence = JSON.parse(await readFile(result.evidencePath, "utf8"));
    assert.deepEqual(evidence.staged.outfitSheets.map((sheet) => sheet.storyStage), ["stage-a", "stage-b"]);
    assert.equal(evidence.sheets.outfitSheets[1].repackedFromSha256, outfitAsset(registered, "stage-b").sha256);

    const draft = JSON.parse(await readFile(result.identityReviewDraftPath, "utf8"));
    assert.deepEqual(draft.outfitSheets.map((sheet) => sheet.storyStage), ["stage-a", "stage-b"], "the review draft covers the outfit sheets");
    assert.equal(draft.outfitSheets[0].cells.length, 4);
    assert.deepEqual(Object.keys(draft.recovery).filter((key) => typeof draft.recovery[key] === "boolean"), ["provenanceGapAcknowledged", "repackedSheetsMatchSources"]);

    const register = () => finalizeApprovedCharacter({ projectDir, workflowId: registered.workflowId, castId: registered.castId, identityReviewPath: result.identityReviewDraftPath });
    await passIdentityReview(result.identityReviewDraftPath, "outfit-review-session");
    await editJson(result.identityReviewDraftPath, (review) => Object.assign(review.recovery, {
      provenanceGapAcknowledged: true, repackedSheetsMatchSources: true, note: "戻した衣装の板と収め直した板を登録簿の板と照らした",
    }));
    // 衣装の板の点検が抜けていれば通らない（通常の衣装つきの人物と同じ検め）。
    const reviewed = await readFile(result.identityReviewDraftPath, "utf8");
    await editJson(result.identityReviewDraftPath, (review) => { review.outfitSheets = review.outfitSheets.slice(0, 1); });
    await assert.rejects(register, /outfitSheets must cover every generated story-stage outfit sheet/u);
    await writeFile(result.identityReviewDraftPath, reviewed);

    const finalized = await register();
    const outfits = finalized.character.referenceAssets.filter((entry) => entry.role === "outfit");
    assert.deepEqual(outfits.map((entry) => [entry.id, entry.storyStage]), [["outfit-stage-a", "stage-a"], ["outfit-stage-b", "stage-b"]]);
    assert.equal(outfits[0].sha256, outfitAsset(registered, "stage-a").sha256, "a restored outfit keeps its approved SHA");
    assert.equal(outfits[1].sha256, repackedStageB.sha256);
    for (const entry of outfits) assert.equal(await sha256File(path.join(projectDir, "canvas", entry.path)), entry.sha256);
    assert.equal(finalized.character.approval.recovery.restoredSheetCount, 4);
    assert.equal(finalized.character.approval.recovery.repackedSheetCount, 1);
    assert.equal(Object.hasOwn(finalized.character.approval.recovery, "restoredCellCount"), false);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("outfit recovery refuses a missing, an extra, or an absent story stage", async (t) => {
  const python = await pythonOrSkip(t);
  if (!python) return;
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-recovery-outfit-stages-"));
  try {
    const registered = await registerCharacter(projectDir, { cast: OUTFIT_CAST });
    await rm(registered.character.approval.identityReviewPath);
    const mapPath = await buildRestoredMap(projectDir, registered, python);
    const map = JSON.parse(await readFile(mapPath, "utf8"));
    const run = () => recoverKoyaRegisteredCharacterIdentity({ projectDir, workflowId: registered.workflowId, castId: registered.castId, recoveryMapPath: mapPath });
    const coverage = /outfitSheets must cover exactly the character's registered outfit sheets: stage-a, stage-b/u;
    await writeMap(mapPath, { ...map, outfitSheets: [restoredOutfit(projectDir, registered, "stage-a")] });
    await assert.rejects(run, coverage);
    await writeMap(mapPath, { ...map, outfitSheets: [restoredOutfit(projectDir, registered, "stage-a"), restoredOutfit(projectDir, registered, "stage-b"), restoredOutfit(projectDir, registered, "stage-c", "stage-b")] });
    await assert.rejects(run, coverage);
    await writeMap(mapPath, map);
    await assert.rejects(run, coverage);
    const store = await readCharacterWorkflowStore({ projectDir });
    assert.equal(store.workflows[0].cast[0].status, "ready", "a rejected map must not move the character out of ready");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("an outfit sheet whose bytes are not the registered sheet of its story stage is refused", async (t) => {
  const python = await pythonOrSkip(t);
  if (!python) return;
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-recovery-outfit-sha-"));
  try {
    const registered = await registerCharacter(projectDir, { cast: OUTFIT_CAST });
    await rm(registered.character.approval.identityReviewPath);
    const mapPath = await buildRestoredMap(projectDir, registered, python);
    const map = JSON.parse(await readFile(mapPath, "utf8"));
    const run = () => recoverKoyaRegisteredCharacterIdentity({ projectDir, workflowId: registered.workflowId, castId: registered.castId, recoveryMapPath: mapPath });
    // stage-a として stage-b の板を差し出す
    await writeMap(mapPath, { ...map, outfitSheets: [restoredOutfit(projectDir, registered, "stage-a", "stage-b"), restoredOutfit(projectDir, registered, "stage-b")] });
    await assert.rejects(run, /outfitSheets\.stage-a\.sheet is marked restored, but its bytes differ from the registered SHA-256/u);
    // stage-a の板から収め直したものを stage-b として差し出す
    const wrongSource = await repackRegisteredSheet(projectDir, registered, python, "outfit", { columns: 4, rows: 1, storyStage: "stage-a" });
    await writeMap(mapPath, { ...map, outfitSheets: [restoredOutfit(projectDir, registered, "stage-a"), { storyStage: "stage-b", ...wrongSource }] });
    await assert.rejects(run, /outfitSheets\.stage-b\.repackManifest was not repacked from the registered sheet/u);
    // 組み直し（origin なし）は、組んだ記録とセルが無ければ通らない
    await writeMap(mapPath, { ...map, outfitSheets: [restoredOutfit(projectDir, registered, "stage-a"), { storyStage: "stage-b", sheetPath: wrongSource.sheetPath, sha256: wrongSource.sha256 }] });
    await assert.rejects(run, /outfitSheets\.stage-b\.cells must list exactly 4 cells in grid order/u);
    // 知らない origin は通らない
    await writeMap(mapPath, { ...map, outfitSheets: [restoredOutfit(projectDir, registered, "stage-a"), { storyStage: "stage-b", origin: "generated", sheetPath: wrongSource.sheetPath, sha256: wrongSource.sha256 }] });
    await assert.rejects(run, /outfitSheets\.stage-b\.origin must be restored or repacked, or omitted/u);
    const store = await readCharacterWorkflowStore({ projectDir });
    assert.equal(store.workflows[0].cast[0].status, "ready");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

// 表情の板を、登録簿の板（PNG）から切り出した11セルと、顔を参照して作り直した1セルで組み直す。
// overrides.cropRole で別の役割の登録簿の板から切り、overrides.plainPathFor のセルは "crop" ではなく
// 切り出し済みのファイルをそのまま渡して組む（組んだ道具の記録に切り出しが残らない）。
async function buildRestoredCellMap(projectDir, registered, python, overrides = {}) {
  const canvas = path.join(projectDir, "canvas");
  const workDir = path.join(projectDir, overrides.workDirName || "restored-cell-materials");
  const deliveryDir = path.join(projectDir, "delivery-package");
  await mkdir(workDir, { recursive: true });
  const asset = (role) => registered.character.referenceAssets.find((entry) => entry.role === role);
  const delivered = (role) => path.join(deliveryDir, path.basename(asset(role).path));
  const cropRole = overrides.cropRole || "expression";
  const cropSource = delivered(cropRole);
  const cropSourceSha256 = asset(cropRole).sha256;
  const specPath = path.join(workDir, "spec.md");
  await writeFile(specPath, "# 表情の板の組み直し\n登録簿の板から11セルを切り出し、鏡像の1セルだけ顔を参照して作り直す。\n");
  const generatedId = "r3c4";
  const promptFile = path.join(workDir, "generated-prompt.md");
  await writeFile(promptFile, "参照1の顔のまま、鏡像になっていた全身を正しい向きで描く\n");
  const generatedFile = path.join(workDir, `expression-${generatedId}.ppm`);
  await writeFile(generatedFile, testRaster(99, 100, 100));
  const cropOutput = (id) => path.join(workDir, "crops", `expression-${id}.png`);
  const composeCells = REQUIRED_EXPRESSION_CELLS.map((id) => {
    if (id === generatedId) return { id, path: generatedFile };
    if (id === overrides.plainPathFor) return { id, path: cropOutput(id) };
    return { id, crop: { source: cropSource, sourceSha256: cropSourceSha256, grid: { columns: 4, rows: 3, cell: id }, output: cropOutput(id) } };
  });
  if (overrides.plainPathFor) {
    // 先に切り出しだけを作っておき、組むときは切り出し済みのファイルとして渡す。
    await compose(python, composeCells.map((cell) => (cell.id === overrides.plainPathFor
      ? { id: cell.id, crop: { source: cropSource, grid: { columns: 4, rows: 3, cell: cell.id }, output: cropOutput(cell.id) } }
      : cell)), { columns: 4, rows: 3, width: 800, height: 600, output: path.join(workDir, "pre-cut.png"), manifest: path.join(workDir, "pre-cut.json"), workDir });
  }
  const sheet = path.join(workDir, "expression.png");
  const manifestPath = path.join(workDir, "expression.compose.json");
  await compose(python, composeCells, { columns: 4, rows: 3, width: 800, height: 600, output: sheet, manifest: manifestPath, workDir });
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (overrides.shiftBoundsFor) {
    // 記録と申告の位置を両方ずらす（切り出しの画素はずらす前のまま）。画素の照合だけが気づける。
    const entry = manifest.cells.find((cell) => cell.id === overrides.shiftBoundsFor);
    entry.cropOf.bounds = [entry.cropOf.bounds[0] + 1, ...entry.cropOf.bounds.slice(1)];
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  const preCutBounds = (id) => [(REQUIRED_EXPRESSION_CELLS.indexOf(id) % 4) * 100, Math.floor(REQUIRED_EXPRESSION_CELLS.indexOf(id) / 4) * 100, 100, 100];
  const faceFile = delivered("identity-face");
  const faceSha256 = asset("identity-face").sha256;
  const cells = await Promise.all(REQUIRED_EXPRESSION_CELLS.map(async (id) => {
    if (id === generatedId) {
      return {
        id,
        origin: "generated",
        generated: {
          path: generatedFile,
          sha256: await sha256File(generatedFile),
          generator: { host: "codex", id: "image-model", contextId: "restored-cell-generator-session", generatedAt: "2026-10-26T00:00:00.000Z" },
          promptPath: promptFile,
          promptSha256: await sha256File(promptFile),
          referenceImages: [
            { path: faceFile, sha256: faceSha256, role: "identity-face" },
            { path: cropOutput("r3c3"), sha256: await sha256File(cropOutput("r3c3")), role: "restored-cell" },
          ],
        },
      };
    }
    const recorded = manifest.cells.find((cell) => cell.id === id).cropOf;
    return {
      id,
      origin: "restored-cell",
      restored: {
        sourcePath: cropSource,
        sourceSha256: cropSourceSha256,
        bounds: recorded ? recorded.bounds : preCutBounds(id),
        path: cropOutput(id),
        sha256: await sha256File(cropOutput(id)),
      },
    };
  }));
  const map = {
    version: KOYA_CHARACTER_RECOVERY_MAP_VERSION,
    workflowId: registered.workflowId,
    castId: registered.castId,
    recoveryId: overrides.recoveryId || "fixture-restored-cells-1",
    reason: "登録済みの表情の板の1セルが鏡像だったため、残りの11セルを登録簿の板から切り出して組み直す",
    importedBy: { host: "claude", id: "importer", contextId: "restored-cell-importer-session" },
    specification: { path: specPath, sha256: await sha256File(specPath) },
    selectedFace: { origin: "restored", path: faceFile, sha256: faceSha256 },
    turnaround: { origin: "restored", sheetPath: delivered("turnaround"), sha256: asset("turnaround").sha256 },
    expression: { sheetPath: sheet, sha256: await sha256File(sheet), composeManifestPath: manifestPath, composeManifestSha256: await sha256File(manifestPath), cells },
    eyeOpenSheets: [],
  };
  return { mapPath: await writeMap(path.join(workDir, "recovery-map.json"), map), manifest };
}

// 登録簿の絵を送付用の素材一式へ写してから、canvas の登録ファイルを消す。
async function loseRegisteredFilesKeepingDelivery(projectDir, registered) {
  const deliveryDir = path.join(projectDir, "delivery-package");
  await mkdir(deliveryDir, { recursive: true });
  for (const asset of registered.character.referenceAssets) {
    await copyFile(path.join(projectDir, "canvas", asset.path), path.join(deliveryDir, path.basename(asset.path)));
  }
  await deleteRegisteredFiles(projectDir, registered.character);
}

test("an expression sheet rebuilt from restored cells plus one face-anchored generated cell is accepted and needs restoredCellsMatchSources", async (t) => {
  const python = await pythonOrSkip(t);
  if (!python) return;
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-recovery-restored-cells-"));
  try {
    const registered = await registerCharacter(projectDir, { pngSheets: true });
    const before = Object.fromEntries(registered.character.referenceAssets.map((entry) => [entry.role, entry.sha256]));
    await loseRegisteredFilesKeepingDelivery(projectDir, registered);
    const { mapPath, manifest } = await buildRestoredCellMap(projectDir, registered, python);
    assert.deepEqual(manifest.cells.find((cell) => cell.id === "r2c3").cropOf.bounds, [200, 100, 100, 100], "grid crops use the identity review's grid");
    assert.equal(manifest.cells.find((cell) => cell.id === "r2c3").cropOf.sourceSha256, before.expression);

    const result = await recoverKoyaRegisteredCharacterIdentity({ projectDir, workflowId: registered.workflowId, castId: registered.castId, recoveryMapPath: mapPath });
    assert.equal(result.restoredCellCount, 11);
    assert.equal(result.generatedCellCount, 1);
    assert.equal(result.recoveredCellCount, 0);
    assert.equal(result.restoredSheetCount, 2, "face and turnaround");
    const evidence = JSON.parse(await readFile(result.evidencePath, "utf8"));
    assert.equal(evidence.restoredCellCount, 11);
    const restoredCell = evidence.sheets.expression.cells.find((cell) => cell.id === "r1c2");
    assert.equal(restoredCell.origin, "restored-cell");
    assert.deepEqual(restoredCell.restored.bounds, [100, 0, 100, 100]);
    assert.equal(restoredCell.restored.sourceSha256, before.expression);
    assert.deepEqual(restoredCell.restored.cropCheck, { method: "decoded-pixels", matched: true });

    const draft = JSON.parse(await readFile(result.identityReviewDraftPath, "utf8"));
    assert.equal(draft.recovery.restoredCellCount, 11);
    assert.deepEqual(Object.keys(draft.recovery).filter((key) => typeof draft.recovery[key] === "boolean"), ["provenanceGapAcknowledged", "generatedCellsConsistent", "restoredCellsMatchSources"]);

    const register = () => finalizeApprovedCharacter({ projectDir, workflowId: registered.workflowId, castId: registered.castId, identityReviewPath: result.identityReviewDraftPath });
    await passIdentityReview(result.identityReviewDraftPath, "restored-cell-review-session");
    await editJson(result.identityReviewDraftPath, (review) => Object.assign(review.recovery, {
      provenanceGapAcknowledged: true, generatedCellsConsistent: true, note: "作り直した1セルを顔と照らした",
    }));
    await assert.rejects(register, /recovery\.restoredCellsMatchSources must be true/u);
    await editJson(result.identityReviewDraftPath, (review) => Object.assign(review.recovery, { restoredCellsMatchSources: true }));
    const finalized = await register();
    const after = Object.fromEntries(finalized.character.referenceAssets.map((entry) => [entry.role, entry.sha256]));
    assert.equal(after["identity-face"], before["identity-face"]);
    assert.equal(after.turnaround, before.turnaround);
    assert.notEqual(after.expression, before.expression, "the rebuilt sheet is registered under its new SHA");
    assert.equal(finalized.character.approval.recovery.restoredCellCount, 11);
    const reread = await readCharacterRegistry({ projectDir });
    assert.equal(reread.characters.find((entry) => entry.id === registered.castId).approval.recovery.restoredCellCount, 11);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("a restored cell is refused unless it was cut, as recorded, from the registered sheet of the same role", async (t) => {
  const python = await pythonOrSkip(t);
  if (!python) return;
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-recovery-restored-cell-invalid-"));
  try {
    const registered = await registerCharacter(projectDir, { pngSheets: true });
    await loseRegisteredFilesKeepingDelivery(projectDir, registered);
    const run = (mapPath) => recoverKoyaRegisteredCharacterIdentity({ projectDir, workflowId: registered.workflowId, castId: registered.castId, recoveryMapPath: mapPath });
    // 三面図（別の役割の登録簿の板）から切った「表情」のセル
    const otherRole = await buildRestoredCellMap(projectDir, registered, python, { cropRole: "turnaround", workDirName: "other-role" });
    await assert.rejects(run(otherRole.mapPath), /expression\.cells\.r1c1\.restored\.sourceSha256 must be the registry SHA-256 of this role/u);
    // 申告と記録の位置をずらしても、切り出しの画素が元の板のその位置と合わなければ通らない
    const shifted = await buildRestoredCellMap(projectDir, registered, python, { shiftBoundsFor: "r2c2", workDirName: "shifted" });
    await assert.rejects(run(shifted.mapPath), /expression\.cells\.r2c2\.restored crop pixels differ from the registered sheet at bounds \[101, 100, 100, 100\]/u);
    // 組んだ道具の記録に切り出しが残っていないセル
    const unrecorded = await buildRestoredCellMap(projectDir, registered, python, { plainPathFor: "r1c3", workDirName: "unrecorded" });
    await assert.rejects(run(unrecorded.mapPath), /expression\.cells\.r1c3 is a restored-cell, but the compose manifest does not record cutting it/u);
    const store = await readCharacterWorkflowStore({ projectDir });
    assert.equal(store.workflows[0].cast[0].status, "ready");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("a delivered part with its own drawn frame is placed from the trim rectangle only, keeping the untouched source SHA", async (t) => {
  const python = await pythonOrSkip(t);
  if (!python) return;
  const workDir = await mkdtemp(path.join(os.tmpdir(), "buzzassist-compose-trim-"));
  try {
    // 白地に、外周近くの黒い枠線（2px 内側）と、中の赤い四角（20..39）。
    const width = 60;
    const height = 60;
    const pixels = Buffer.alloc(width * height * 3, 255);
    const paint = (x, y, rgb) => rgb.forEach((value, channel) => { pixels[(y * width + x) * 3 + channel] = value; });
    for (let i = 2; i < 58; i += 1) {
      for (const [x, y] of [[i, 2], [i, 57], [2, i], [57, i]]) paint(x, y, [0, 0, 0]);
    }
    for (let y = 20; y < 40; y += 1) for (let x = 20; x < 40; x += 1) paint(x, y, [220, 30, 30]);
    const part = path.join(workDir, "delivered-part.png");
    await writeFile(part, pngFromRgb(pixels, width, height));
    const output = path.join(workDir, "sheet.png");
    const manifestPath = path.join(workDir, "sheet.compose.json");
    await compose(python, [{ id: "only", path: part, trim: [4, 4, 52, 52] }], { columns: 1, rows: 1, width: 100, height: 100, output, manifest: manifestPath, workDir });
    const cell = JSON.parse(await readFile(manifestPath, "utf8")).cells[0];
    assert.equal(cell.sourceSha256, await sha256File(part), "the cell still names the untouched delivered file");
    assert.deepEqual(cell.sourceSize, [60, 60]);
    assert.deepEqual(cell.trimBounds, [4, 4, 52, 52]);
    // 枠線が入っていれば内容の範囲は切り出しの端まで広がる。中の四角（とその周りのわずかな余白）だけなら端から離れる。
    const [contentX, contentY, contentWidth, contentHeight] = cell.sourceContentBounds;
    assert.ok(contentX >= 10 && contentY >= 10 && contentX + contentWidth <= 42 && contentY + contentHeight <= 42, `only the drawing inside the frame is placed: ${cell.sourceContentBounds}`);

    // 切り出し（crop）と trim は一緒に使えない。
    await assert.rejects(
      compose(python, [{ id: "only", trim: [4, 4, 52, 52], crop: { source: part, bounds: [0, 0, 60, 60], output: path.join(workDir, "crop.png") } }], { columns: 1, rows: 1, width: 100, height: 100, output: path.join(workDir, "bad.png"), manifest: path.join(workDir, "bad.json"), workDir }),
      /give either path \(with optional trim\) or crop, not both/u,
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
