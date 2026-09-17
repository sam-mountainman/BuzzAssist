import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { resolveCanvasDir, writeJsonAtomic } from "./canvasScene.mjs";
import { requirePythonRuntime } from "./harnessRuntimeResolver.mjs";

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
export const ANATOMICAL_SIDES = Object.freeze(["subject-left", "subject-right"]);
export const SIDE_LOCKED_FEATURE_SCOPES = Object.freeze(["turnaround", "expression", "outfit", "extra"]);
export const SIDE_NOT_VISIBLE = "not-visible";
// 左右（鏡像）の判定は、他の同一性チェックと同じ「名前のある真偽値」として
// セルに残させる。行だけを検査していた頃は、宣言のあるキャストでも
// 「左右を見たかどうか」がシート上のどこにも現れず、全部 true の合格シートと
// 見分けが付かなかった（監査所見 U2 / 本日4人が鏡像欠陥のまま通過）。
export const SIDE_LOCKED_REVIEW_FLAG = "sideLockedFeaturesConsistent";
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

/**
 * 左右（本人基準の解剖学的な側）が固定された特徴の宣言を正規化する。
 *
 * 宣言はワークフローの cast 側に置く。文字列から「本人の左/右」を推測しない
 * のは、推測が外れたときに黙って検査が消えるため。宣言が壊れていたら例外に
 * する。落として続行すると、typo ひとつで左右検査が無音で無効化される。
 */
export function normalizeSideLockedFeatures(value) {
  const rows = Array.isArray(value) ? value : [];
  const normalized = [];
  const seen = new Set();
  for (const [index, entry] of rows.entries()) {
    const source = plainObject(entry);
    if (!source) throw new Error(`sideLockedFeatures[${index}] must be an object.`);
    const feature = nonEmptyString(source.feature);
    if (!feature) throw new Error(`sideLockedFeatures[${index}].feature is required.`);
    const id = nonEmptyString(source.id) || feature;
    const expectedSide = nonEmptyString(source.expectedSide ?? source.expected_side);
    if (!ANATOMICAL_SIDES.includes(expectedSide)) {
      throw new Error(`sideLockedFeatures[${index}].expectedSide must be one of ${ANATOMICAL_SIDES.join(", ")}.`);
    }
    const requestedScopes = source.scopes ?? source.appliesTo ?? source.applies_to;
    const scopes = requestedScopes === undefined || requestedScopes === null
      ? [...SIDE_LOCKED_FEATURE_SCOPES]
      : (Array.isArray(requestedScopes) ? requestedScopes : [requestedScopes]).map((scope) => nonEmptyString(scope));
    if (scopes.length === 0 || scopes.some((scope) => !SIDE_LOCKED_FEATURE_SCOPES.includes(scope))) {
      throw new Error(`sideLockedFeatures[${index}].scopes must be a non-empty subset of ${SIDE_LOCKED_FEATURE_SCOPES.join(", ")}.`);
    }
    if (seen.has(id)) throw new Error(`sideLockedFeatures contains a duplicate feature id: ${id}.`);
    seen.add(id);
    normalized.push({
      id,
      feature,
      expectedSide,
      scopes: [...new Set(scopes)].sort(),
      note: nonEmptyString(source.note),
    });
  }
  return normalized;
}

/**
 * セル1枚ぶんの左右検査。宣言がある特徴は「向きが合っていて pass:true」か
 * 「そのセルでは見えない（applicable:false）」のどちらかを必ず記録させる。
 * 記録が無ければ、他の真偽値が全部 true でもレビューは通らない。
 */
function collectAsymmetricFeatureChecks(cell, label, features, scope, requiredIds, failures, options = {}) {
  const requirePass = options.requirePass !== false;
  const verified = new Set();
  const declaredById = new Map(features.map((feature) => [feature.id, feature]));
  const raw = cell?.asymmetricFeatureChecks;
  if (raw === undefined || raw === null) {
    if (requiredIds.length > 0) {
      failures.push(`${label}.asymmetricFeatureChecks must record a side judgment for every declared side-locked feature: ${requiredIds.join(", ")}.`);
    }
    return verified;
  }
  if (!Array.isArray(raw)) {
    failures.push(`${label}.asymmetricFeatureChecks must be an array.`);
    return verified;
  }
  const seen = new Set();
  let failedApplicable = false;
  for (const [index, entry] of raw.entries()) {
    const rowLabel = `${label}.asymmetricFeatureChecks[${index}]`;
    const row = plainObject(entry);
    if (!row) {
      failures.push(`${rowLabel} must be an object.`);
      continue;
    }
    const featureName = nonEmptyString(row.feature);
    const featureId = nonEmptyString(row.id) || featureName;
    if (!featureName) {
      failures.push(`${rowLabel}.feature is required.`);
      continue;
    }
    if (seen.has(featureId)) {
      failures.push(`${rowLabel} duplicates the side check for ${featureId}.`);
      continue;
    }
    seen.add(featureId);
    const declared = declaredById.get(featureId);
    if (features.length > 0 && !declared) {
      failures.push(`${rowLabel} names an undeclared side-locked feature: ${featureId}.`);
      continue;
    }
    const expectedSide = nonEmptyString(row.expectedSide);
    if (declared) {
      if (expectedSide !== declared.expectedSide) {
        failures.push(`${rowLabel}.expectedSide must stay ${declared.expectedSide} as declared for ${featureId}; a review cannot restate the approved side.`);
      }
    } else if (!ANATOMICAL_SIDES.includes(expectedSide)) {
      failures.push(`${rowLabel}.expectedSide must be one of ${ANATOMICAL_SIDES.join(", ")}.`);
    }
    const target = declared?.expectedSide ?? expectedSide;
    const observedSide = nonEmptyString(row.observedSide);
    if (typeof row.pass !== "boolean") failures.push(`${rowLabel}.pass must record a boolean side judgment.`);
    if (row.applicable === false) {
      // このセルに写っていないという判断も、記録として残させる。黙って
      // 省略できると「書かなかった」と「見えなかった」が区別できなくなる。
      if (observedSide !== SIDE_NOT_VISIBLE) failures.push(`${rowLabel}.observedSide must be "${SIDE_NOT_VISIBLE}" when applicable is false.`);
      if (row.pass !== false) failures.push(`${rowLabel}.pass must be false when the side-locked feature is not visible in this cell.`);
      if (nonEmptyString(row.note).length < 8) failures.push(`${rowLabel}.note must explain why ${featureId} is not visible in this cell.`);
      continue;
    }
    if (!ANATOMICAL_SIDES.includes(observedSide)) {
      failures.push(`${rowLabel}.observedSide must be one of ${ANATOMICAL_SIDES.join(", ")}; record applicable:false with observedSide "${SIDE_NOT_VISIBLE}" when the feature cannot be seen.`);
    }
    if (nonEmptyString(row.note).length < 4) failures.push(`${rowLabel}.note must record the side judgment.`);
    const matched = ANATOMICAL_SIDES.includes(observedSide) && observedSide === target;
    if (row.pass === true && !matched) {
      failures.push(`${rowLabel}.pass cannot be true while ${featureId} is observed on ${observedSide || "an unrecorded side"} instead of ${target}.`);
    }
    if (requirePass && !(matched && row.pass === true)) {
      failures.push(`${rowLabel}: ${featureName} must be on ${target} but the review records ${observedSide || "no side"}; redraw the sheet instead of re-reviewing it.`);
    }
    if (matched && row.pass === true) verified.add(featureId);
    else failedApplicable = true;
  }
  for (const id of requiredIds) {
    if (!seen.has(id)) failures.push(`${label}.asymmetricFeatureChecks is missing the declared side-locked feature: ${id}.`);
  }
  if (failedApplicable && cell?.pass === true) {
    failures.push(`${label}.pass cannot be true while one of its side-locked feature checks fails.`);
  }
  return verified;
}

/**
 * 宣言のあるキャストでは、セルごとに名前の付いた左右判定
 * （sideLockedFeaturesConsistent）を必須にする。行の記録だけだと
 * 「左右を見た」という判断がシートの真偽値の並びに現れず、鏡像欠陥のシートが
 * 全項目 true の合格シートと同じ見た目で通ってしまう。
 *
 * 宣言が無いキャスト、およびこのスコープに掛かる宣言が1つも無い場合は、
 * 何も要求せず何も記録させない（既存の挙動をそのまま維持する）。
 */
function requireAsymmetricFeatureChecks(cell, label, features, scope, failures, options = {}) {
  const requiredIds = features.filter((feature) => feature.scopes.includes(scope)).map((feature) => feature.id);
  const failuresBefore = failures.length;
  const verified = collectAsymmetricFeatureChecks(cell, label, features, scope, requiredIds, failures, options);
  if (requiredIds.length === 0) return verified;

  const requirePass = options.requirePass !== false;
  const flagLabel = `${label}.${SIDE_LOCKED_REVIEW_FLAG}`;
  const flag = plainObject(cell) ? cell[SIDE_LOCKED_REVIEW_FLAG] : undefined;
  // 行の検査で1つでも指摘が出ていれば、このセルの左右は「合っていない」。
  const sidesAgree = failures.length === failuresBefore;
  if (requirePass) {
    if (flag !== true) {
      failures.push(`${flagLabel} must be true after checking every declared side-locked feature on this view: ${requiredIds.join(", ")}.`);
    }
  } else if (typeof flag !== "boolean") {
    failures.push(`${flagLabel} must record a boolean left/right judgment for: ${requiredIds.join(", ")}.`);
  }
  if (flag === true && !sidesAgree) {
    failures.push(`${flagLabel} cannot be true while a declared side-locked feature check on this view fails; redraw the sheet instead of re-reviewing it.`);
  }
  if (flag === false && cell?.pass === true) {
    failures.push(`${label}.pass cannot be true while ${SIDE_LOCKED_REVIEW_FLAG} is false.`);
  }
  return verified;
}

function requireSideLockedCoverage(sheetLabel, features, scope, verifiedByFeature, cellCount, failures, options = {}) {
  if (options.requirePass === false || cellCount === 0) return;
  for (const feature of features) {
    if (!feature.scopes.includes(scope)) continue;
    if (!verifiedByFeature.has(feature.id)) {
      failures.push(`${sheetLabel} must confirm ${feature.id} on ${feature.expectedSide} in at least one cell; a sheet where the feature is never visible cannot approve a side-locked design.`);
    }
  }
}

// Eye-open differentials may come in several variants. Packs staged after
// variants existed list every sheet in eyeOpenSheets with the variant id in
// storyStage; older packs carry one unkeyed eyeOpen, which stays valid.
export function identityPackEyeOpenSheets(identityPack) {
  const sheets = (Array.isArray(identityPack?.eyeOpenSheets) ? identityPack.eyeOpenSheets : [])
    .filter((sheet) => nonEmptyString(sheet?.assetFile))
    .map((sheet) => ({ ...sheet, storyStage: nonEmptyString(sheet.storyStage) }));
  if (sheets.length > 0) return sheets;
  const legacy = identityPack?.eyeOpen;
  return nonEmptyString(legacy?.assetFile) ? [{ ...legacy, storyStage: nonEmptyString(legacy.storyStage) }] : [];
}

// Review and repair key for one eye-open sheet. The unkeyed sheet keeps the
// historical "eye-open" key so existing reviews and repair plans still match.
export function eyeOpenReviewKey(variant = "") {
  const id = nonEmptyString(variant);
  return id ? `eye-open:${id}` : "eye-open";
}

function reviewedSheetVariant(sheet) {
  return nonEmptyString(sheet?.storyStage);
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

async function inspectIdentityPackReview(args = {}, options = {}) {
  const { reviewPath, workflow, cast, identityPack } = args;
  const requirePass = options.requirePass !== false;
  const { path, review } = await readReview(reviewPath, "identity-pack");
  const failures = [];
  if (review.workflowId !== workflow?.id) failures.push("workflowId does not match the active workflow.");
  if (review.castId !== cast?.id) failures.push("castId does not match the active character.");
  if (nonEmptyString(review.generatorContextId) !== nonEmptyString(identityPack?.generatorContextId)) {
    failures.push("generatorContextId does not match the staged identity-pack generation context.");
  }
  requireReviewer(review, failures);
  const sideLockedFeatures = normalizeSideLockedFeatures(cast?.sideLockedFeatures);

  const machineRecheck = await runDraftBuilder(
    identityPackReviewSpec({ workflow, cast, identityPack, generatorContextId: review.generatorContextId }),
    nonEmptyString(args.machineRecheckPath)
      ? resolve(args.machineRecheckPath)
      : join(dirname(path), ".machine-recheck", "identity-pack-review.json"),
  );

  const selected = await verifiedAsset(review.selectedFace, identityPack?.selectedFace?.assetFile, "selectedFace", failures);
  const turnaround = await verifiedAsset(review.turnaround, identityPack?.turnaround?.assetFile, "turnaround", failures);
  await verifiedAsset(review.expression, identityPack?.expression?.assetFile, "expression", failures);
  if (selected && turnaround && selected.sha256 === turnaround.sha256) failures.push("turnaround cannot reuse the selected candidate bytes.");
  if (review?.turnaround?.isRealTurnaround !== true) failures.push("turnaround.isRealTurnaround must be true.");
  if (review?.turnaround?.notCandidateSubstitute !== true) failures.push("turnaround.notCandidateSubstitute must be true.");
  requireMachineGrid(review?.turnaround?.grid, machineRecheck.review?.turnaround?.grid, "turnaround.grid", failures, { requirePass });
  const turnaroundChecks = Array.isArray(review?.turnaround?.viewChecks) ? review.turnaround.viewChecks : [];
  const turnaroundSideVerified = new Set();
  for (const id of REQUIRED_TURNAROUND_VIEWS) {
    const check = turnaroundChecks.find((entry) => entry?.id === id);
    const machineCheck = machineRecheck.review?.turnaround?.viewChecks?.find((entry) => entry?.id === id);
    requirePassingCheck(check, `turnaround.viewChecks.${id}`, failures, ["sameIdentity", "ageConsistent", "hairConsistent", "faceContourConsistent"], { requirePass });
    await requireMachineCell(check, machineCheck, `turnaround.viewChecks.${id}`, failures, { requirePass });
    for (const featureId of requireAsymmetricFeatureChecks(check, `turnaround.viewChecks.${id}`, sideLockedFeatures, "turnaround", failures, { requirePass })) {
      turnaroundSideVerified.add(featureId);
    }
  }
  requireSideLockedCoverage("turnaround", sideLockedFeatures, "turnaround", turnaroundSideVerified, turnaroundChecks.length, failures, { requirePass });
  if (turnaroundChecks.length !== REQUIRED_TURNAROUND_VIEWS.length) failures.push("turnaround.viewChecks must contain exactly eight required views.");
  if (requirePass ? review?.turnaround?.pass !== true : typeof review?.turnaround?.pass !== "boolean") failures.push(`turnaround.pass must be ${requirePass ? "true" : "a boolean visual judgment"}.`);
  if (nonEmptyString(review?.turnaround?.note).length < 4) failures.push("turnaround.note is required.");

  const grid = plainObject(review?.expression?.grid) || {};
  if (grid.columns !== 4 || grid.rows !== 3) failures.push("expression.grid must be 4x3.");
  requireMachineGrid(grid, machineRecheck.review?.expression?.grid, "expression.grid", failures, { requirePass });
  const expressionCells = Array.isArray(review?.expression?.cells) ? review.expression.cells : [];
  const expressionSideVerified = new Set();
  for (const id of REQUIRED_EXPRESSION_CELLS) {
    const check = expressionCells.find((entry) => entry?.id === id);
    const machineCheck = machineRecheck.review?.expression?.cells?.find((entry) => entry?.id === id);
    requirePassingCheck(check, `expression.cells.${id}`, failures, ["sameIdentity", "ageConsistent", "hairConsistent", "faceContourConsistent"], { requirePass });
    await requireMachineCell(check, machineCheck, `expression.cells.${id}`, failures, { requirePass });
    for (const featureId of requireAsymmetricFeatureChecks(check, `expression.cells.${id}`, sideLockedFeatures, "expression", failures, { requirePass })) {
      expressionSideVerified.add(featureId);
    }
  }
  requireSideLockedCoverage("expression", sideLockedFeatures, "expression", expressionSideVerified, expressionCells.length, failures, { requirePass });
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
    const outfitSideVerified = new Set();
    for (const id of REQUIRED_OUTFIT_CELLS) {
      const cell = cells.find((entry) => entry?.id === id);
      const machineCell = machineSheet?.cells?.find((entry) => entry?.id === id);
      requirePassingCheck(cell, `outfitSheets.${expected.storyStage}.cells.${id}`, failures, ["sameIdentity", "ageConsistent", "hairConsistent", "faceContourConsistent", "outfitMatchesSpecification"], { requirePass });
      await requireMachineCell(cell, machineCell, `outfitSheets.${expected.storyStage}.cells.${id}`, failures, { requirePass });
      for (const featureId of requireAsymmetricFeatureChecks(cell, `outfitSheets.${expected.storyStage}.cells.${id}`, sideLockedFeatures, "outfit", failures, { requirePass })) {
        outfitSideVerified.add(featureId);
      }
    }
    requireSideLockedCoverage(`outfitSheets.${expected.storyStage}`, sideLockedFeatures, "outfit", outfitSideVerified, cells.length, failures, { requirePass });
  }
  const expectedExtras = identityPackEyeOpenSheets(identityPack).map((sheet) => ({
    role: "eye-open",
    storyStage: sheet.storyStage,
    key: eyeOpenReviewKey(sheet.storyStage),
    assetFile: sheet.assetFile,
  }));
  if (new Set(expectedExtras.map((entry) => entry.key)).size !== expectedExtras.length) {
    failures.push("The staged identity pack binds more than one eye-open sheet to the same variant.");
  }
  const reviewedExtras = Array.isArray(review.extraSheets) ? review.extraSheets : [];
  const extraKey = (entry) => (entry?.role === "eye-open" ? eyeOpenReviewKey(reviewedSheetVariant(entry)) : nonEmptyString(entry?.role));
  if (reviewedExtras.length !== expectedExtras.length) failures.push("extraSheets must cover every generated identity differential.");
  const reviewedExtraKeys = reviewedExtras.map(extraKey);
  for (const key of new Set(reviewedExtraKeys)) {
    if (!expectedExtras.some((entry) => entry.key === key)) failures.push(`extraSheets contains an unexpected identity differential: ${key || "missing role"}.`);
    else if (reviewedExtraKeys.filter((entry) => entry === key).length > 1) failures.push(`extraSheets.${key} is reviewed more than once.`);
  }
  for (const expected of expectedExtras) {
    const label = `extraSheets.${expected.key}`;
    const check = reviewedExtras.find((entry) => extraKey(entry) === expected.key);
    const machineSheet = machineRecheck.review?.extraSheets?.find((entry) => extraKey(entry) === expected.key);
    requirePassingCheck(check, label, failures, ["sameIdentity"], { requirePass });
    if (check) await verifiedAsset(check, expected.assetFile, label, failures);
    requireMachineGrid(check?.grid, machineSheet?.grid, `${label}.grid`, failures, { requirePass });
    const cells = Array.isArray(check?.cells) ? check.cells : [];
    if (cells.length !== REQUIRED_EYE_OPEN_CELLS.length) failures.push(`${label}.cells must contain exactly four required cells.`);
    const extraSideVerified = new Set();
    for (const id of REQUIRED_EYE_OPEN_CELLS) {
      const cell = cells.find((entry) => entry?.id === id);
      const machineCell = machineSheet?.cells?.find((entry) => entry?.id === id);
      requirePassingCheck(cell, `${label}.cells.${id}`, failures, ["sameIdentity", "ageConsistent", "hairConsistent", "faceContourConsistent", "stateMatchesSpecification"], { requirePass });
      await requireMachineCell(cell, machineCell, `${label}.cells.${id}`, failures, { requirePass });
      for (const featureId of requireAsymmetricFeatureChecks(cell, `${label}.cells.${id}`, sideLockedFeatures, "extra", failures, { requirePass })) {
        extraSideVerified.add(featureId);
      }
    }
    requireSideLockedCoverage(label, sideLockedFeatures, "extra", extraSideVerified, cells.length, failures, { requirePass });
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
    if (sheet.pass !== true || sheet.grid?.alignmentConfirmed !== true || (sheet.cells || []).some((entry) => entry.pass !== true)) failedRoles.push(extraKey(sheet));
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
  const python = await requirePythonRuntime({
    purposeEnv: "KOYA_GATE_PYTHON",
    projectDir: resolve(moduleDir, ".."),
    requiredModules: ["cv2", "cv2:CascadeClassifier", "numpy", "PIL"],
  });
  await execFile(python.command, [...python.args, auditScript, "--spec", specPath, "--output", output], {
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
    extraSheets: identityPackEyeOpenSheets(identityPack).map((sheet) => asset(sheet, {
      role: "eye-open",
      ...(sheet.storyStage ? { storyStage: sheet.storyStage } : {}),
    })),
  };
}

/**
 * 宣言された左右固定特徴を、レビュー下書きの各セルへ空欄として置いておく。
 * 「書く欄が無かった」という言い訳を消すのが目的で、判断そのものは人が入れる。
 */
function seedSideLockedFeatureChecks(review, features) {
  if (features.length === 0) return false;
  let seeded = false;
  const seedCell = (cell, scope) => {
    if (!plainObject(cell)) return;
    const applicable = features.filter((feature) => feature.scopes.includes(scope));
    if (applicable.length === 0) return;
    cell.asymmetricFeatureChecks = applicable.map((feature) => ({
      id: feature.id,
      feature: feature.feature,
      expectedSide: feature.expectedSide,
      observedSide: "",
      applicable: true,
      pass: false,
      note: "",
    }));
    // 下書きは必ず未判定（false）で出す。true を先に入れておくと、
    // 「見ないまま合格が置いてある」状態になり、この検査の意味が消える。
    cell[SIDE_LOCKED_REVIEW_FLAG] = false;
    seeded = true;
  };
  for (const view of review?.turnaround?.viewChecks || []) seedCell(view, "turnaround");
  for (const cell of review?.expression?.cells || []) seedCell(cell, "expression");
  for (const sheet of review?.outfitSheets || []) for (const cell of sheet?.cells || []) seedCell(cell, "outfit");
  for (const sheet of review?.extraSheets || []) for (const cell of sheet?.cells || []) seedCell(cell, "extra");
  return seeded;
}

export async function prepareIdentityPackReviewDraft(args = {}) {
  const { workflow, cast, identityPack } = args;
  const canvasDir = resolveCanvasDir(args);
  const outputDir = join(canvasDir, "character-reviews", workflow.id, cast.id, "identity-pack");
  const draft = await runDraftBuilder(
    identityPackReviewSpec({ workflow, cast, identityPack, generatorContextId: args.generatorContextId }),
    join(outputDir, "identity-pack-review.json"),
  );
  if (seedSideLockedFeatureChecks(draft.review, normalizeSideLockedFeatures(cast?.sideLockedFeatures))) {
    await writeJsonAtomic(draft.path, draft.review);
  }
  return draft;
}
