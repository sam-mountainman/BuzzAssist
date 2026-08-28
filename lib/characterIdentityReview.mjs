import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { resolveCanvasDir, writeJsonAtomic } from "./canvasScene.mjs";

export const CHARACTER_IDENTITY_REVIEW_VERSION = "koya-character-identity-review-v2";
export const REQUIRED_TURNAROUND_VIEWS = Object.freeze([
  "front-full-body",
  "left-profile-full-body",
  "right-profile-full-body",
  "back-full-body",
  "front-head",
  "left-three-quarter-head",
  "right-three-quarter-head",
  "top-head",
]);
export const REQUIRED_EXPRESSION_CELLS = Object.freeze(
  Array.from({ length: 12 }, (_, index) => `r${Math.floor(index / 4) + 1}c${(index % 4) + 1}`),
);
export const REQUIRED_OUTFIT_CELLS = Object.freeze(["front", "strict-side", "back", "seated-three-quarter"]);
export const REQUIRED_EYE_OPEN_CELLS = Object.freeze(["default-front", "open-front", "default-three-quarter", "open-three-quarter"]);
const MIN_FACE_CROP_LUMA_DISTANCE = 0.015;
const MIN_WHOLE_IMAGE_LUMA_DISTANCE = 0.02;

const execFile = promisify(execFileCallback);
const moduleDir = dirname(fileURLToPath(import.meta.url));
const auditScript = resolve(moduleDir, "../scripts/audit-koya-character-identity.py");

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function validBoundingBox(box, width, height) {
  if (!Array.isArray(box) || box.length !== 4 || !box.every((value) => Number.isFinite(Number(value)))) return false;
  const [x, y, boxWidth, boxHeight] = box.map(Number);
  const imageWidth = Number(width);
  const imageHeight = Number(height);
  if (!(imageWidth > 0 && imageHeight > 0 && x >= 0 && y >= 0 && boxWidth >= 16 && boxHeight >= 16)) return false;
  if (x + boxWidth > imageWidth || y + boxHeight > imageHeight) return false;
  return boxWidth * boxHeight >= imageWidth * imageHeight * 0.0005;
}

function requireReviewedFaceRegion(check, machineCheck, label, failures) {
  const detectedBox = Array.isArray(machineCheck?.faceDetection?.bbox) ? machineCheck.faceDetection.bbox : [];
  const manualBox = Array.isArray(check?.manualFaceRegion) ? check.manualFaceRegion : [];
  const machineFace = machineCheck?.faceDetection?.detected === true && validBoundingBox(detectedBox, machineCheck.width, machineCheck.height);
  const reviewedFace = check?.faceRegionReviewed === true && validBoundingBox(manualBox, machineCheck?.width, machineCheck?.height);
  if (!machineFace && !reviewedFace) failures.push(`${label} requires an in-bounds detected face bbox or manually reviewed face region.`);
}

function requireMachineGrid(reviewGrid, machineGrid, label, failures, options = {}) {
  const review = plainObject(reviewGrid) || {};
  const machine = plainObject(machineGrid) || {};
  for (const key of ["columns", "rows", "sourceWidth", "sourceHeight"]) {
    if (Number(review[key]) !== Number(machine[key])) failures.push(`${label}.${key} does not match the current parent sheet.`);
  }
  if (JSON.stringify(review.coverage || []) !== JSON.stringify(machine.coverage || [])) {
    failures.push(`${label}.coverage does not match the current parent sheet.`);
  }
  if (options.requirePass === false) {
    if (typeof review.alignmentConfirmed !== "boolean") failures.push(`${label}.alignmentConfirmed must record a boolean original-scale grid judgment.`);
  } else if (review.alignmentConfirmed !== true) {
    failures.push(`${label}.alignmentConfirmed must be true after original-scale grid inspection.`);
  }
}

async function requireMachineCell(check, machineCheck, label, failures, options = {}) {
  if (!plainObject(check)) return;
  if (!plainObject(machineCheck)) {
    failures.push(`${label} is missing from the fresh parent-sheet crop set.`);
    return;
  }
  if (check.path) await verifiedAsset(check, check.path, label, failures);
  for (const key of ["sha256", "width", "height", "machineFaceCropLumaDistanceToSelected"]) {
    if (String(check[key] ?? "") !== String(machineCheck[key] ?? "")) {
      failures.push(`${label}.${key} does not match a fresh crop from the current parent sheet.`);
    }
  }
  for (const key of ["sourceBounds", "faceDetection"]) {
    if (JSON.stringify(check[key] || {}) !== JSON.stringify(machineCheck[key] || {})) {
      failures.push(`${label}.${key} does not match a fresh crop from the current parent sheet.`);
    }
  }
  // A failed grid cell may genuinely contain no head because the parent sheet
  // cropped it outside the cell. Requiring a fabricated manual face rectangle
  // would corrupt the failure evidence and make bounded repair impossible.
  // Passing cells and final registration still require a real detected/manual
  // face or head region exactly as before.
  if (options.requirePass !== false || check?.pass === true) {
    requireReviewedFaceRegion(check, machineCheck, label, failures);
  }
}

export async function characterAssetSha256(path) {
  const bytes = await readFile(resolve(path));
  return createHash("sha256").update(bytes).digest("hex");
}

async function verifiedAsset(record, expectedPath, label, failures) {
  const path = nonEmptyString(record?.path);
  let expected = "";
  let reviewed = "";
  try {
    expected = await realpath(resolve(expectedPath));
    reviewed = path ? await realpath(resolve(path)) : "";
  } catch (error) {
    failures.push(`${label}.path is not readable: ${error.message}`);
    return null;
  }
  if (!path || reviewed !== expected) {
    failures.push(`${label}.path must bind the exact generated asset.`);
    return null;
  }
  let actualSha256 = "";
  try {
    actualSha256 = await characterAssetSha256(expected);
  } catch (error) {
    failures.push(`${label}.path is not readable: ${error.message}`);
    return null;
  }
  if (nonEmptyString(record?.sha256) !== actualSha256) {
    failures.push(`${label}.sha256 does not match the current file bytes.`);
  }
  return { path: expected, sha256: actualSha256 };
}

function requireReviewer(review, failures) {
  const reviewer = plainObject(review?.reviewer) || {};
  for (const key of ["host", "id", "contextId", "reviewedAt"]) {
    if (!nonEmptyString(reviewer[key])) failures.push(`reviewer.${key} is required.`);
  }
  const generatorContextId = nonEmptyString(review?.generatorContextId);
  if (!generatorContextId) failures.push("generatorContextId is required.");
  if (generatorContextId && nonEmptyString(reviewer.contextId) === generatorContextId) {
    failures.push("reviewer.contextId must differ from generatorContextId.");
  }
  if (review?.originalScaleInspected !== true) failures.push("originalScaleInspected must be true.");
}

function requirePassingCheck(check, label, failures, keys, options = {}) {
  if (!plainObject(check)) {
    failures.push(`${label} is missing.`);
    return;
  }
  for (const key of keys) {
    if (options.requirePass === false) {
      if (typeof check[key] !== "boolean") failures.push(`${label}.${key} must record a boolean visual judgment.`);
    } else if (check[key] !== true) failures.push(`${label}.${key} must be true.`);
  }
  if (options.requirePass === false) {
    if (typeof check.pass !== "boolean") failures.push(`${label}.pass must record a boolean visual judgment.`);
  } else if (check.pass !== true) failures.push(`${label}.pass must be true.`);
  if (nonEmptyString(check.note).length < 4) failures.push(`${label}.note must record the visual judgment.`);
}

async function readReview(reviewPath, expectedPhase) {
  const path = resolve(nonEmptyString(reviewPath));
  if (!nonEmptyString(reviewPath)) throw new Error(`${expectedPhase} review path is required.`);
  const review = JSON.parse(await readFile(path, "utf8"));
  if (review?.version !== CHARACTER_IDENTITY_REVIEW_VERSION) {
    throw new Error(`Unsupported character review version: ${review?.version || "missing"}.`);
  }
  if (review?.phase !== expectedPhase) throw new Error(`Character review phase must be ${expectedPhase}.`);
  return { path, review };
}

export async function validateCandidateDiversityReview({ reviewPath, workflow, cast } = {}) {
  const { path, review } = await readReview(reviewPath, "candidate-diversity");
  const failures = [];
  if (review.workflowId !== workflow?.id) failures.push("workflowId does not match the active workflow.");
  if (review.castId !== cast?.id) failures.push("castId does not match the active character.");
  if (!nonEmptyString(cast?.candidateGeneratorContextId)) failures.push("candidateGeneratorContextId is missing from the workflow; regenerate candidates through the official route.");
  if (nonEmptyString(review.generatorContextId) !== nonEmptyString(cast?.candidateGeneratorContextId)) failures.push("generatorContextId does not match the candidate generation context.");
  if (nonEmptyString(cast?.candidateImportEvidencePath) || nonEmptyString(cast?.candidateImportEvidenceSha256)) {
    const evidence = plainObject(review.candidateImportEvidence) || {};
    const expectedPath = nonEmptyString(cast.candidateImportEvidencePath);
    let expectedSha256 = "";
    try { expectedSha256 = await characterAssetSha256(expectedPath); } catch (error) { failures.push(`candidate import evidence is unreadable: ${error.message}`); }
    if (resolve(nonEmptyString(evidence.path)) !== resolve(expectedPath)
      || nonEmptyString(evidence.sha256) !== expectedSha256
      || expectedSha256 !== nonEmptyString(cast.candidateImportEvidenceSha256)) {
      failures.push("candidateImportEvidence must bind the exact current candidate import evidence path and SHA-256.");
    }
  }
  requireReviewer(review, failures);

  // Selection changes the packet members from `generated` to `selected`/`rejected`.
  // The published anonymous packet and its review remain the evidence set after
  // that state transition; explicitly retired legacy extras have no artifact.
  const generated = (cast?.candidates || []).filter((candidate) =>
    ["generated", "selected", "rejected"].includes(candidate.status)
    && candidate.blindLabel
    && candidate.blindArtifactFile);
  const generatedForMachine = [...generated].sort((left, right) => left.blindLabel.localeCompare(right.blindLabel));
  const rows = Array.isArray(review.candidates) ? review.candidates : [];
  const machineRecheck = await runDraftBuilder({
    phase: "candidate-diversity",
    workflowId: workflow.id,
    castId: cast.id,
    generatorContextId: nonEmptyString(review.generatorContextId),
    animeFaceCascade: resolve(moduleDir, "../scripts/data/lbpcascade_animeface.xml"),
    candidates: generatedForMachine.map((candidate) => ({
      label: candidate.blindLabel,
      path: candidate.blindArtifactFile,
      sha256: candidate.blindArtifactSha256,
    })),
  }, join(dirname(path), ".machine-recheck", "candidate-diversity-review.json"));
  if (generated.length < 2 || rows.length !== generated.length) failures.push("review.candidates must cover every generated anonymous candidate.");
  for (const candidate of generated) {
    const row = rows.find((entry) => entry?.label === candidate.blindLabel);
    if (!row) {
      failures.push(`candidate ${candidate.blindLabel} is missing from the review.`);
      continue;
    }
    await verifiedAsset(row, candidate.blindArtifactFile, `candidate ${candidate.blindLabel}`, failures);
    if (nonEmptyString(row.sha256) !== candidate.blindArtifactSha256) {
      failures.push(`candidate ${candidate.blindLabel} SHA-256 does not match the anonymous packet.`);
    }
    const machineRow = machineRecheck.review.candidates.find((entry) => entry.label === candidate.blindLabel);
    if (JSON.stringify(row?.faceDetection || {}) !== JSON.stringify(machineRow?.faceDetection || {})) {
      failures.push(`candidate ${candidate.blindLabel} machine face detection was edited; use manualFaceRegion instead.`);
    }
    requireReviewedFaceRegion(row, machineRow, `candidate ${candidate.blindLabel}`, failures);
  }
  const contactSheet = plainObject(review.contactSheet) || {};
  if (nonEmptyString(contactSheet.path)) {
    await verifiedAsset(contactSheet, contactSheet.path, "contactSheet", failures);
  } else {
    failures.push("contactSheet.path is required.");
  }

  const expectedPairs = [];
  const labels = generated.map((candidate) => candidate.blindLabel).sort();
  for (let left = 0; left < labels.length; left += 1) {
    for (let right = left + 1; right < labels.length; right += 1) expectedPairs.push(`${labels[left]}:${labels[right]}`);
  }
  const pairChecks = Array.isArray(review.pairChecks) ? review.pairChecks : [];
  const observedPairs = new Set();
  for (const check of pairChecks) {
    const pair = Array.isArray(check?.labels) ? [...check.labels].sort() : [];
    const pairId = pair.join(":");
    if (!expectedPairs.includes(pairId) || observedPairs.has(pairId)) {
      failures.push(`pairChecks contains an unknown or duplicate pair: ${pairId || "missing"}.`);
      continue;
    }
    observedPairs.add(pairId);
    const machine = plainObject(check.machine) || {};
    const machineCheck = machineRecheck.review.pairChecks.find((entry) => [...entry.labels].sort().join(":") === pairId);
    if (JSON.stringify(machine) !== JSON.stringify(machineCheck?.machine || {})) {
      failures.push(`pair ${pairId} machine measurements were edited; regenerate the review draft instead.`);
    }
    if (!Number.isFinite(Number(machineCheck?.machine?.faceCropLumaDistance)) || Number(machineCheck.machine.faceCropLumaDistance) < MIN_FACE_CROP_LUMA_DISTANCE) {
      failures.push(`pair ${pairId} faceCropLumaDistance is below ${MIN_FACE_CROP_LUMA_DISTANCE}; regenerate the weak candidate.`);
    }
    if (!Number.isFinite(Number(machineCheck?.machine?.wholeImageLumaDistance)) || Number(machineCheck.machine.wholeImageLumaDistance) < MIN_WHOLE_IMAGE_LUMA_DISTANCE) {
      failures.push(`pair ${pairId} wholeImageLumaDistance is below ${MIN_WHOLE_IMAGE_LUMA_DISTANCE}; regenerate the weak candidate.`);
    }
    const axes = plainObject(check.visualAxes) || {};
    const axisKeys = ["faceShapeDistinct", "eyesDistinct", "browsDistinct", "hairSilhouetteDistinct", "bodyBuildDistinct"];
    if (axisKeys.some((key) => typeof axes[key] !== "boolean")) failures.push(`pair ${pairId} must judge all five visual axes.`);
    if (axisKeys.filter((key) => axes[key] === true).length < 2) failures.push(`pair ${pairId} needs at least two visibly distinct design axes.`);
    if (!["faceShapeDistinct", "eyesDistinct", "browsDistinct"].some((key) => axes[key] === true)) {
      failures.push(`pair ${pairId} needs at least one visibly distinct craniofacial axis; clothing, pose, or color alone cannot create a new person.`);
    }
    if (!["hairSilhouetteDistinct", "bodyBuildDistinct"].some((key) => axes[key] === true)) {
      failures.push(`pair ${pairId} needs at least one visibly distinct silhouette axis in hair or body build.`);
    }
    if (check.pass !== true) failures.push(`pair ${pairId}.pass must be true; regenerate only the weak candidate before selection.`);
    if (nonEmptyString(check.note).length < 4) failures.push(`pair ${pairId}.note must record the original-scale comparison.`);
  }
  for (const pairId of expectedPairs) if (!observedPairs.has(pairId)) failures.push(`pair ${pairId} is missing.`);
  if (review.pass !== true) failures.push("candidate diversity review.pass must be true.");
  if (failures.length > 0) throw new Error(`Candidate diversity review failed:\n- ${failures.join("\n- ")}`);
  return { path, review };
}

async function inspectIdentityPackReview({ reviewPath, workflow, cast, identityPack } = {}, options = {}) {
  const requirePass = options.requirePass !== false;
  const { path, review } = await readReview(reviewPath, "identity-pack");
  const failures = [];
  if (review.workflowId !== workflow?.id) failures.push("workflowId does not match the active workflow.");
  if (review.castId !== cast?.id) failures.push("castId does not match the active character.");
  if (nonEmptyString(review.generatorContextId) !== nonEmptyString(identityPack?.generatorContextId)) {
    failures.push("generatorContextId does not match the staged identity-pack generation context.");
  }
  requireReviewer(review, failures);

  const machineRecheck = await runDraftBuilder(
    identityPackReviewSpec({ workflow, cast, identityPack, generatorContextId: review.generatorContextId }),
    join(dirname(path), ".machine-recheck", "identity-pack-review.json"),
  );

  const selected = await verifiedAsset(review.selectedFace, identityPack?.selectedFace?.assetFile, "selectedFace", failures);
  const turnaround = await verifiedAsset(review.turnaround, identityPack?.turnaround?.assetFile, "turnaround", failures);
  await verifiedAsset(review.expression, identityPack?.expression?.assetFile, "expression", failures);
  if (selected && turnaround && selected.sha256 === turnaround.sha256) failures.push("turnaround cannot reuse the selected candidate bytes.");
  if (review?.turnaround?.isRealTurnaround !== true) failures.push("turnaround.isRealTurnaround must be true.");
  if (review?.turnaround?.notCandidateSubstitute !== true) failures.push("turnaround.notCandidateSubstitute must be true.");
  requireMachineGrid(review?.turnaround?.grid, machineRecheck.review?.turnaround?.grid, "turnaround.grid", failures, { requirePass });
  const turnaroundChecks = Array.isArray(review?.turnaround?.viewChecks) ? review.turnaround.viewChecks : [];
  for (const id of REQUIRED_TURNAROUND_VIEWS) {
    const check = turnaroundChecks.find((entry) => entry?.id === id);
    const machineCheck = machineRecheck.review?.turnaround?.viewChecks?.find((entry) => entry?.id === id);
    requirePassingCheck(check, `turnaround.viewChecks.${id}`, failures, ["sameIdentity", "ageConsistent", "hairConsistent", "faceContourConsistent"], { requirePass });
    await requireMachineCell(check, machineCheck, `turnaround.viewChecks.${id}`, failures, { requirePass });
  }
  if (turnaroundChecks.length !== REQUIRED_TURNAROUND_VIEWS.length) failures.push("turnaround.viewChecks must contain exactly eight required views.");
  if (requirePass ? review?.turnaround?.pass !== true : typeof review?.turnaround?.pass !== "boolean") failures.push(`turnaround.pass must be ${requirePass ? "true" : "a boolean visual judgment"}.`);
  if (nonEmptyString(review?.turnaround?.note).length < 4) failures.push("turnaround.note is required.");

  const grid = plainObject(review?.expression?.grid) || {};
  if (grid.columns !== 4 || grid.rows !== 3) failures.push("expression.grid must be 4x3.");
  requireMachineGrid(grid, machineRecheck.review?.expression?.grid, "expression.grid", failures, { requirePass });
  const expressionCells = Array.isArray(review?.expression?.cells) ? review.expression.cells : [];
  for (const id of REQUIRED_EXPRESSION_CELLS) {
    const check = expressionCells.find((entry) => entry?.id === id);
    const machineCheck = machineRecheck.review?.expression?.cells?.find((entry) => entry?.id === id);
    requirePassingCheck(check, `expression.cells.${id}`, failures, ["sameIdentity", "ageConsistent", "hairConsistent", "faceContourConsistent"], { requirePass });
    await requireMachineCell(check, machineCheck, `expression.cells.${id}`, failures, { requirePass });
  }
  if (expressionCells.length !== REQUIRED_EXPRESSION_CELLS.length) failures.push("expression.cells must contain exactly twelve unique cells.");
  if (requirePass ? review?.expression?.pass !== true : typeof review?.expression?.pass !== "boolean") failures.push(`expression.pass must be ${requirePass ? "true" : "a boolean visual judgment"}.`);
  if (nonEmptyString(review?.expression?.note).length < 4) failures.push("expression.note is required.");

  const expectedOutfits = Array.isArray(identityPack?.outfitSheets) ? identityPack.outfitSheets : [];
  const reviewedOutfits = Array.isArray(review.outfitSheets) ? review.outfitSheets : [];
  if (reviewedOutfits.length !== expectedOutfits.length) failures.push("outfitSheets must cover every generated story-stage outfit sheet.");
  for (const expected of expectedOutfits) {
    const check = reviewedOutfits.find((entry) => entry?.storyStage === expected.storyStage);
    const machineSheet = machineRecheck.review?.outfitSheets?.find((entry) => entry?.storyStage === expected.storyStage);
    requirePassingCheck(check, `outfitSheets.${expected.storyStage}`, failures, ["sameIdentity", "outfitMatchesSpecification"], { requirePass });
    if (check) await verifiedAsset(check, expected.assetFile, `outfitSheets.${expected.storyStage}`, failures);
    requireMachineGrid(check?.grid, machineSheet?.grid, `outfitSheets.${expected.storyStage}.grid`, failures, { requirePass });
    const cells = Array.isArray(check?.cells) ? check.cells : [];
    if (cells.length !== REQUIRED_OUTFIT_CELLS.length) failures.push(`outfitSheets.${expected.storyStage}.cells must contain exactly four required cells.`);
    for (const id of REQUIRED_OUTFIT_CELLS) {
      const cell = cells.find((entry) => entry?.id === id);
      const machineCell = machineSheet?.cells?.find((entry) => entry?.id === id);
      requirePassingCheck(cell, `outfitSheets.${expected.storyStage}.cells.${id}`, failures, ["sameIdentity", "ageConsistent", "hairConsistent", "faceContourConsistent", "outfitMatchesSpecification"], { requirePass });
      await requireMachineCell(cell, machineCell, `outfitSheets.${expected.storyStage}.cells.${id}`, failures, { requirePass });
    }
  }
  const expectedExtras = identityPack?.eyeOpen?.assetFile ? [{ role: "eye-open", assetFile: identityPack.eyeOpen.assetFile }] : [];
  const reviewedExtras = Array.isArray(review.extraSheets) ? review.extraSheets : [];
  if (reviewedExtras.length !== expectedExtras.length) failures.push("extraSheets must cover every generated identity differential.");
  for (const expected of expectedExtras) {
    const check = reviewedExtras.find((entry) => entry?.role === expected.role);
    const machineSheet = machineRecheck.review?.extraSheets?.find((entry) => entry?.role === expected.role);
    requirePassingCheck(check, `extraSheets.${expected.role}`, failures, ["sameIdentity"], { requirePass });
    if (check) await verifiedAsset(check, expected.assetFile, `extraSheets.${expected.role}`, failures);
    requireMachineGrid(check?.grid, machineSheet?.grid, `extraSheets.${expected.role}.grid`, failures, { requirePass });
    const cells = Array.isArray(check?.cells) ? check.cells : [];
    if (cells.length !== REQUIRED_EYE_OPEN_CELLS.length) failures.push(`extraSheets.${expected.role}.cells must contain exactly four required cells.`);
    for (const id of REQUIRED_EYE_OPEN_CELLS) {
      const cell = cells.find((entry) => entry?.id === id);
      const machineCell = machineSheet?.cells?.find((entry) => entry?.id === id);
      requirePassingCheck(cell, `extraSheets.${expected.role}.cells.${id}`, failures, ["sameIdentity", "ageConsistent", "hairConsistent", "faceContourConsistent", "stateMatchesSpecification"], { requirePass });
      await requireMachineCell(cell, machineCell, `extraSheets.${expected.role}.cells.${id}`, failures, { requirePass });
    }
  }
  if (requirePass ? review.pass !== true : review.pass !== false) failures.push(`identity-pack review.pass must be ${requirePass ? "true" : "false before repair"}.`);
  if (failures.length > 0) throw new Error(`Identity-pack review failed:\n- ${failures.join("\n- ")}`);
  const failedRoles = [];
  if (review.turnaround?.pass !== true || review.turnaround?.grid?.alignmentConfirmed !== true || turnaroundChecks.some((entry) => entry.pass !== true)) failedRoles.push("turnaround");
  if (review.expression?.pass !== true || review.expression?.grid?.alignmentConfirmed !== true || expressionCells.some((entry) => entry.pass !== true)) failedRoles.push("expression");
  for (const sheet of reviewedOutfits) {
    if (sheet.pass !== true || sheet.grid?.alignmentConfirmed !== true || (sheet.cells || []).some((entry) => entry.pass !== true)) failedRoles.push(`outfit:${sheet.storyStage}`);
  }
  for (const sheet of reviewedExtras) {
    if (sheet.pass !== true || sheet.grid?.alignmentConfirmed !== true || (sheet.cells || []).some((entry) => entry.pass !== true)) failedRoles.push(sheet.role);
  }
  if (!requirePass && failedRoles.length === 0) throw new Error("Identity-pack review failed:\n- failed review does not identify any failed identity role to repair.");
  return { path, review, failedRoles };
}

export async function validateIdentityPackReview(args = {}) {
  return inspectIdentityPackReview(args, { requirePass: true });
}

export async function validateFailedIdentityPackReview(args = {}) {
  return inspectIdentityPackReview(args, { requirePass: false });
}

async function runDraftBuilder(spec, outputPath) {
  // この成果物は「機械の再チェックが実際に走った」ことの証跡で、後から
  // 読み戻される。一時領域へ逃がすと証跡が消えるので、ここは書き込みで正しい。
  // 書き込むという事実のほうを正直に扱う（呼び出し元を READ_ONLY_ACTIONS から外した）。
  const output = resolve(outputPath);
  await mkdir(dirname(output), { recursive: true });
  const specPath = join(dirname(output), `${spec.phase}-spec.json`);
  await writeJsonAtomic(specPath, spec);
  // R199: python の解決先は環境で変わる。依存の無い実行系を引くと
  // ゲートが黙って無効になるので、他のゲートと同じ変数で明示固定する。
  const python = process.env.KOYA_GATE_PYTHON || "/usr/bin/python3";
  await execFile(python, [auditScript, "--spec", specPath, "--output", output], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return { path: output, review: JSON.parse(await readFile(output, "utf8")) };
}

export async function prepareCandidateDiversityReviewDraft(args = {}) {
  const { workflow, cast } = args;
  const canvasDir = resolveCanvasDir(args);
  const outputDir = join(canvasDir, "character-reviews", workflow.id, cast.id, "candidates");
  const candidates = (cast.candidates || [])
    .filter((candidate) => ["generated", "selected", "rejected"].includes(candidate.status) && candidate.blindLabel && candidate.blindArtifactFile)
    .map((candidate) => ({ label: candidate.blindLabel, path: candidate.blindArtifactFile, sha256: candidate.blindArtifactSha256 }))
    .sort((left, right) => left.label.localeCompare(right.label));
  const draft = await runDraftBuilder({
    phase: "candidate-diversity",
    workflowId: workflow.id,
    castId: cast.id,
    generatorContextId: nonEmptyString(args.generatorContextId),
    animeFaceCascade: resolve(moduleDir, "../scripts/data/lbpcascade_animeface.xml"),
    candidates,
  }, join(outputDir, "candidate-diversity-review.json"));
  if (nonEmptyString(cast.candidateImportEvidencePath) || nonEmptyString(cast.candidateImportEvidenceSha256)) {
    draft.review.candidateImportEvidence = {
      path: nonEmptyString(cast.candidateImportEvidencePath),
      sha256: nonEmptyString(cast.candidateImportEvidenceSha256),
    };
    await writeJsonAtomic(draft.path, draft.review);
  }
  return draft;
}

function identityPackReviewSpec({ workflow, cast, identityPack, generatorContextId } = {}) {
  const asset = (value, extra = {}) => ({ path: value.assetFile, ...extra });
  return {
    phase: "identity-pack",
    workflowId: workflow.id,
    castId: cast.id,
    generatorContextId: nonEmptyString(generatorContextId),
    animeFaceCascade: resolve(moduleDir, "../scripts/data/lbpcascade_animeface.xml"),
    selectedFace: asset(identityPack.selectedFace, { label: cast.name }),
    turnaround: asset(identityPack.turnaround),
    expression: asset(identityPack.expression),
    outfitSheets: (identityPack.outfitSheets || []).map((entry) => asset(entry, { storyStage: entry.storyStage })),
    extraSheets: identityPack.eyeOpen?.assetFile ? [asset(identityPack.eyeOpen, { role: "eye-open" })] : [],
  };
}

export async function prepareIdentityPackReviewDraft(args = {}) {
  const { workflow, cast, identityPack } = args;
  const canvasDir = resolveCanvasDir(args);
  const outputDir = join(canvasDir, "character-reviews", workflow.id, cast.id, "identity-pack");
  return runDraftBuilder(
    identityPackReviewSpec({ workflow, cast, identityPack, generatorContextId: args.generatorContextId }),
    join(outputDir, "identity-pack-review.json"),
  );
}
