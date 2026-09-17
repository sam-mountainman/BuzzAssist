import { createHash, randomUUID } from "node:crypto";
import { resolveChannelPackPath } from "./channelPackResolver.mjs";
import { existsSync } from "node:fs";
import { access, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { getImageDimensionsFromBuffer, resolveCanvasDir, writeJsonAtomic } from "./canvasScene.mjs";
import { findWorkflowCast, getCharacterWorkflow, readCharacterWorkflowStore } from "./characterPipeline.mjs";
import {
  CHARACTER_IDENTITY_REVIEW_VERSION,
  IDENTITY_SHEET_BOUNDS_TOLERANCE_PX,
  REQUIRED_EXPRESSION_CELLS,
  REQUIRED_EYE_OPEN_CELLS,
  REQUIRED_OUTFIT_CELLS,
  REQUIRED_TURNAROUND_VIEWS,
  resolveRecordedIdentitySheetCellBounds,
  validateIdentityPackReview,
} from "./characterIdentityReview.mjs";
import { normalizeChannelVisualProfileStore } from "./channelVisualProfile.mjs";
import { normalizeCharacterRegistry, readCharacterRegistry } from "./characterRegistry.mjs";
import {
  auditKoyaCharacterRosterReview,
  KOYA_CHARACTER_ROSTER_REVIEW_VERSION,
  resolveKoyaCharacterRosterReviewPaths,
} from "./koyaCharacterRosterReview.mjs";
import { auditKoyaCharacterBootstrap, readKoyaChannelAuthority } from "./koyaChannelGovernance.mjs";
import {
  portableKoyaVoiceSelectionAttestation,
  portableKoyaVoiceSelectionAttestationFailures,
} from "./koyaVoiceSelectionGuard.mjs";

export const KOYA_HANDOFF_BUNDLE_VERSION = "koya-harness-handoff-v2";
export const KOYA_HANDOFF_REVIEW_ATTESTATION_VERSION = "koya-handoff-review-attestation-v1";
export const KOYA_HANDOFF_ROSTER_REVIEW_ATTESTATION_VERSION = "koya-handoff-roster-review-attestation-v1";
const CANVAS_TOKEN = "__BUNDLE_CANVAS__/";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROSTER_REVIEW_DIRECTORY = "character-roster-reviews/koya-fixed-cast";
const ROSTER_SHEET_BUNDLE_PATH = `project/canvas/${ROSTER_REVIEW_DIRECTORY}/roster-contact-sheet.svg`;
const ROSTER_ATTESTATION_BUNDLE_PATH = `project/canvas/${ROSTER_REVIEW_DIRECTORY}/roster-review-attestation.json`;

const PROJECT_CONFIG_PATHS = Object.freeze([
  "config/koya-show-bible.json",
  "config/koya-location-bible.json",
  "config/koya-thumbnail-contract.json",
]);
const CONTRACT_SNAPSHOT_PATHS = Object.freeze([
  "config/koya-manga-production-contract.json",
  "config/koya-manga-production-contract.schema.json",
  "config/koya-manga-quality-incidents.json",
]);

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function validSha256(value) {
  return /^[a-f0-9]{64}$/u.test(nonEmptyString(value));
}

function validIsoDate(value) {
  const text = nonEmptyString(value);
  return Boolean(text && /^\d{4}-\d{2}-\d{2}T/u.test(text) && Number.isFinite(Date.parse(text)));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Canonical(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function safeSegment(value, fallback = "item") {
  return nonEmptyString(value).normalize("NFKC").replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 80) || fallback;
}

function portablePath(value) {
  return String(value || "").split(sep).join("/");
}

function safeBundleRelative(value) {
  const normalized = portablePath(value).replace(/^\.\//u, "");
  if (!normalized || normalized.startsWith("/") || normalized.includes("../") || normalized === "..") {
    throw new Error(`Unsafe handoff bundle path: ${value}`);
  }
  return normalized;
}

function resolveInside(root, relativePath) {
  const output = resolve(root, safeBundleRelative(relativePath));
  if (output !== root && !output.startsWith(`${root}${sep}`)) throw new Error(`Handoff path escapes its root: ${relativePath}`);
  return output;
}

async function pathExists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function assertNoSymlinkAncestors(root, target) {
  const safeRoot = resolve(root);
  const safeTarget = resolve(target);
  const rel = relative(safeRoot, safeTarget);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Handoff restore target escapes its root: ${safeTarget}`);
  }
  const parts = rel && rel !== "." ? rel.split(sep) : [];
  let current = safeRoot;
  for (let index = -1; index < parts.length; index += 1) {
    if (index >= 0) current = join(current, parts[index]);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new Error(`Handoff restore refuses a symlink ancestor: ${current}`);
    }
    if (index < parts.length - 1 && !info.isDirectory()) {
      throw new Error(`Handoff restore ancestor is not a directory: ${current}`);
    }
  }
}

async function readJsonStrict(path) {
  const text = await readFile(path, "utf8");
  if (!text.trim()) throw new Error(`Required handoff JSON is empty: ${path}`);
  return JSON.parse(text);
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function fileEvidence(root, path, kind) {
  const info = await stat(path);
  return {
    path: portablePath(relative(root, path)),
    kind,
    size: info.size,
    sha256: await sha256File(path),
  };
}

async function copyEvidence(source, root, relativePath, kind) {
  const destination = resolveInside(root, relativePath);
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error(`Handoff source must be a regular file: ${source}`);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  return fileEvidence(root, destination, kind);
}

function sourceCanvasPath(canvasDir, value) {
  const path = nonEmptyString(value);
  if (!path) return "";
  return isAbsolute(path) ? resolve(path) : resolve(canvasDir, path);
}

function selectedIds(value) {
  const list = Array.isArray(value) ? value : nonEmptyString(value).split(",");
  return new Set(list.map((entry) => nonEmptyString(entry)).filter(Boolean));
}

function stripPrivateApproval(approval) {
  if (!approval || typeof approval !== "object") return null;
  const route = nonEmptyString(approval.route);
  return {
    route: ["anonymous-candidate-selection", "human-best-of-n", "legacy-migration"].includes(route)
      ? route
      : portableIdentifier("source-route-sha256", route),
    approvedBy: portableIdentifier("source-approver-sha256", approval.approvedBy),
    approvedAt: nonEmptyString(approval.approvedAt),
    selectedCandidateLabel: "",
    reason: portableIdentifier("source-reason-sha256", approval.reason),
    identityReviewPath: nonEmptyString(approval.identityReviewPath),
    identityReviewSha256: nonEmptyString(approval.identityReviewSha256),
  };
}

function characterMatchesKoya(character, showBible, explicitIds) {
  const cast = Array.isArray(showBible?.cast) ? showBible.cast : [];
  const isKoyaMember = cast.some((entry) => entry.id === character.id || entry.name === character.name || character.aliases?.includes(entry.name));
  if (!isKoyaMember) return false;
  return explicitIds.size === 0 || explicitIds.has(character.id) || explicitIds.has(character.name);
}

async function copyRegistryAsset({ source, bundleRoot, bundleId, characterId, role, copied, files }) {
  const actualSha = await sha256File(source);
  if (copied.has(source)) return copied.get(source);
  const extensionName = safeSegment(basename(source), "asset.bin");
  const relativePath = `project/canvas/assets/characters/${safeSegment(characterId)}/${safeSegment(role)}/${actualSha.slice(0, 12)}-${extensionName}`;
  files.push(await copyEvidence(source, bundleRoot, relativePath, "approved-character-evidence"));
  const tokenPath = `${CANVAS_TOKEN}assets/characters/${safeSegment(characterId)}/${safeSegment(role)}/${actualSha.slice(0, 12)}-${extensionName}`;
  const result = { tokenPath, sha256: actualSha };
  copied.set(source, result);
  return result;
}

function portableIdentifier(prefix, value) {
  const text = nonEmptyString(value);
  if (!text) return "";
  return `${prefix}:${createHash("sha256").update(text).digest("hex")}`;
}

const PORTABLE_IDENTITY_REVIEW_KEYS = Object.freeze([
  "version",
  "phase",
  "selectedFace",
  "reviewer",
  "generatorContextId",
  "checks",
  "pass",
]);
const PORTABLE_IDENTITY_CHECK_KEYS = Object.freeze([
  "originalScaleInspected",
  "turnaroundPass",
  "turnaroundViewsPass",
  "expressionPass",
  "expressionCellsPass",
  "outfitSheetsPass",
  "extraSheetsPass",
]);

function passingRows(rows, nestedKey = "") {
  if (!Array.isArray(rows)) return false;
  return rows.every((row) => row?.pass === true && (!nestedKey
    || (Array.isArray(row?.[nestedKey]) && row[nestedKey].every((nested) => nested?.pass === true))));
}

function portableReviewSnapshot(value) {
  const review = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const reviewer = review.reviewer && typeof review.reviewer === "object" && !Array.isArray(review.reviewer)
    ? review.reviewer
    : {};
  return {
    version: nonEmptyString(review.version),
    phase: nonEmptyString(review.phase),
    selectedFace: {
      path: portableIdentifier("source-path-sha256", review?.selectedFace?.path),
      sha256: nonEmptyString(review?.selectedFace?.sha256),
    },
    reviewer: {
      host: portableIdentifier("source-host-sha256", reviewer.host),
      id: portableIdentifier("source-agent-sha256", reviewer.id),
      contextId: portableIdentifier("source-context-sha256", reviewer.contextId),
      reviewedAt: nonEmptyString(reviewer.reviewedAt),
    },
    generatorContextId: portableIdentifier("source-context-sha256", review.generatorContextId),
    checks: {
      originalScaleInspected: review.originalScaleInspected === true,
      turnaroundPass: review?.turnaround?.pass === true,
      turnaroundViewsPass: passingRows(review?.turnaround?.viewChecks),
      expressionPass: review?.expression?.pass === true,
      expressionCellsPass: passingRows(review?.expression?.cells),
      outfitSheetsPass: passingRows(review.outfitSheets, "cells"),
      extraSheetsPass: passingRows(review.extraSheets, "cells"),
    },
    pass: review.pass === true,
  };
}

function exactPortableKeys(value, expected, pointer, failures) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failures.push(`${pointer} must be an object with an explicit portable schema.`);
    return false;
  }
  const expectedSet = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!expectedSet.has(key)) failures.push(`${pointer}.${key} is not allowed in portable identity evidence.`);
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) failures.push(`${pointer}.${key} is required by the portable identity schema.`);
  }
  return true;
}

function portableReviewPrivacyFailures(value) {
  const failures = [];
  if (!exactPortableKeys(value, PORTABLE_IDENTITY_REVIEW_KEYS, "snapshot", failures)) return failures;
  exactPortableKeys(value.selectedFace, ["path", "sha256"], "snapshot.selectedFace", failures);
  exactPortableKeys(value.reviewer, ["host", "id", "contextId", "reviewedAt"], "snapshot.reviewer", failures);
  exactPortableKeys(value.checks, PORTABLE_IDENTITY_CHECK_KEYS, "snapshot.checks", failures);
  if (value.version !== CHARACTER_IDENTITY_REVIEW_VERSION || value.phase !== "identity-pack") {
    failures.push("snapshot version/phase is not the explicit portable identity-pack schema.");
  }
  if (!/^source-path-sha256:[a-f0-9]{64}$/u.test(nonEmptyString(value?.selectedFace?.path))
    || !validSha256(value?.selectedFace?.sha256)) {
    failures.push("snapshot.selectedFace must contain only a hashed source path and SHA-256 asset binding.");
  }
  if (!/^source-host-sha256:[a-f0-9]{64}$/u.test(nonEmptyString(value?.reviewer?.host))
    || !/^source-agent-sha256:[a-f0-9]{64}$/u.test(nonEmptyString(value?.reviewer?.id))
    || !/^source-context-sha256:[a-f0-9]{64}$/u.test(nonEmptyString(value?.reviewer?.contextId))
    || !validIsoDate(value?.reviewer?.reviewedAt)
    || !/^source-context-sha256:[a-f0-9]{64}$/u.test(nonEmptyString(value?.generatorContextId))) {
    failures.push("snapshot reviewer/generator provenance must use one-way tokens and an ISO review time.");
  }
  for (const key of PORTABLE_IDENTITY_CHECK_KEYS) {
    if (typeof value?.checks?.[key] !== "boolean") failures.push(`snapshot.checks.${key} must be boolean.`);
  }
  if (typeof value.pass !== "boolean") failures.push("snapshot.pass must be boolean.");
  return failures;
}

async function copyReviewAsset({ source, bundleRoot, characterId, copied, files }) {
  const copiedKey = `review:${source}:${characterId}`;
  if (copied.has(copiedKey)) return copied.get(copiedKey);
  const sourceBytes = await readFile(source);
  const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
  let sourceReview;
  try { sourceReview = JSON.parse(sourceBytes.toString("utf8")); }
  catch (error) { throw new Error(`Approved identity review is not valid JSON: ${source}: ${error.message}`); }
  const attestation = {
    version: KOYA_HANDOFF_REVIEW_ATTESTATION_VERSION,
    subjectId: characterId,
    sourceReview: {
      version: nonEmptyString(sourceReview?.version),
      phase: nonEmptyString(sourceReview?.phase),
      sha256: sourceSha256,
    },
    snapshot: portableReviewSnapshot(sourceReview),
    note: "Portable approval evidence. Source-machine paths are deliberately redacted; approved asset bytes are independently SHA-bound by the portable registry and bundle manifest.",
  };
  const actualSha = createHash("sha256").update(`${JSON.stringify(attestation, null, 2)}\n`).digest("hex");
  const extensionName = safeSegment(basename(source).replace(/\.json$/iu, ""), "review");
  const relativePath = `project/canvas/assets/reviews/${safeSegment(characterId)}/${actualSha.slice(0, 12)}-${extensionName}-attestation.json`;
  const destination = resolveInside(bundleRoot, relativePath);
  await writeJsonAtomic(destination, attestation);
  files.push(await fileEvidence(bundleRoot, destination, "approved-review-attestation"));
  const result = {
    tokenPath: `${CANVAS_TOKEN}assets/reviews/${safeSegment(characterId)}/${actualSha.slice(0, 12)}-${extensionName}-attestation.json`,
    sha256: actualSha,
  };
  copied.set(copiedKey, result);
  return result;
}

function exactIds(rows, expectedIds) {
  return Array.isArray(rows)
    && rows.length === expectedIds.length
    && new Set(rows.map((row) => nonEmptyString(row?.id))).size === expectedIds.length
    && expectedIds.every((id) => rows.some((row) => row?.id === id));
}

function validReviewBox(value, width, height) {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((item) => Number.isFinite(Number(item)))) return false;
  const [x, y, boxWidth, boxHeight] = value.map(Number);
  return x >= 0 && y >= 0 && boxWidth >= 16 && boxHeight >= 16 && x + boxWidth <= width && y + boxHeight <= height;
}

async function auditSourceReviewAsset(record, expectedAsset, label, failures) {
  const recordPath = nonEmptyString(record?.path);
  const expectedPath = nonEmptyString(expectedAsset?.path);
  if (!recordPath || !expectedPath || !validSha256(record?.sha256) || !validSha256(expectedAsset?.sha256)) {
    failures.push(`${label} path/SHA-256 binding is incomplete.`);
    return null;
  }
  try {
    const [reviewBytes, registeredBytes] = await Promise.all([
      readFile(resolve(recordPath)),
      readFile(resolve(expectedPath)),
    ]);
    const reviewSha256 = createHash("sha256").update(reviewBytes).digest("hex");
    const registeredSha256 = createHash("sha256").update(registeredBytes).digest("hex");
    if (reviewSha256 !== record.sha256 || registeredSha256 !== expectedAsset.sha256 || reviewSha256 !== registeredSha256) {
      failures.push(`${label} does not bind the exact registered asset bytes.`);
    }
    const dimensions = getImageDimensionsFromBuffer(reviewBytes, label);
    if (dimensions.width !== Number(record?.width) || dimensions.height !== Number(record?.height)) {
      failures.push(`${label} machine width/height does not match the current image bytes.`);
    }
  } catch (error) {
    failures.push(`${label} asset is unreadable (${error.message}).`);
  }
  const width = Number(record?.width);
  const height = Number(record?.height);
  if (!(width >= 16 && height >= 16)) failures.push(`${label} machine width/height evidence is invalid.`);
  return { width, height };
}

async function auditSourceReviewGrid({ section, label, columns, rows, ids, booleanKeys, failures }) {
  const width = Number(section?.width);
  const height = Number(section?.height);
  const grid = section?.grid || {};
  if (Number(grid.columns) !== columns || Number(grid.rows) !== rows
    || Number(grid.sourceWidth) !== width || Number(grid.sourceHeight) !== height
    || canonicalJson(grid.coverage) !== canonicalJson([0, 0, width, height])
    || grid.alignmentConfirmed !== true) {
    failures.push(`${label}.grid is incomplete or does not cover the exact parent asset.`);
  }
  const cells = section?.viewChecks ?? section?.cells;
  if (!exactIds(cells, ids)) {
    failures.push(`${label} must contain exactly the ${ids.length} required machine-bound cells.`);
    return;
  }
  for (const [index, id] of ids.entries()) {
    const cell = cells.find((row) => row?.id === id);
    // 機械が記録した境界を、格子と矛盾しない限り正とする。丸め方
    // （Python の偶数丸めと Math.round）の差で正しい記録を落とさないため。
    // 記録そのものは、この後の fresh recheck で Python の再切り抜きと完全一致まで照合される。
    const { bounds, failure } = resolveRecordedIdentitySheetCellBounds({
      recorded: cell?.sourceBounds,
      width,
      height,
      columns,
      rows,
      index,
    });
    if (failure === "missing" || failure === "malformed") {
      failures.push(`${label}.${id}.sourceBounds is missing or is not an integer [x, y, width, height] box.`);
    } else if (failure) {
      failures.push(`${label}.${id}.sourceBounds does not match its required parent-sheet cell (${failure}; each edge must be within ${IDENTITY_SHEET_BOUNDS_TOLERANCE_PX}px of the grid).`);
    }
    const [, , cellWidth, cellHeight] = bounds;
    if (Number(cell?.width) !== cellWidth || Number(cell?.height) !== cellHeight) {
      failures.push(`${label}.${id} dimensions do not match its required parent-sheet cell.`);
    }
    const faceDetection = cell?.faceDetection || {};
    const detected = faceDetection.detected === true && validReviewBox(faceDetection.bbox, Number(cell?.width), Number(cell?.height));
    const manuallyReviewed = cell?.faceRegionReviewed === true
      && validReviewBox(cell.manualFaceRegion, Number(cell?.width), Number(cell?.height));
    if (!detected && !manuallyReviewed) failures.push(`${label}.${id} lacks detected or independently reviewed face-region evidence.`);
    if (!Number.isFinite(Number(cell?.machineFaceCropLumaDistanceToSelected))) {
      failures.push(`${label}.${id} lacks its machine face-crop comparison.`);
    }
    for (const key of booleanKeys) if (cell?.[key] !== true) failures.push(`${label}.${id}.${key} must be true.`);
    if (cell?.pass !== true || nonEmptyString(cell?.note).length < 4) failures.push(`${label}.${id} requires pass and a concrete visual note.`);
    const cellPath = nonEmptyString(cell?.path);
    if (!cellPath || !validSha256(cell?.sha256)) {
      failures.push(`${label}.${id} crop path/SHA-256 evidence is incomplete.`);
    } else {
      try {
        const bytes = await readFile(resolve(cellPath));
        if (createHash("sha256").update(bytes).digest("hex") !== cell.sha256) failures.push(`${label}.${id} crop SHA-256 is stale.`);
        const dimensions = getImageDimensionsFromBuffer(bytes, `${label}.${id}`);
        if (dimensions.width !== Number(cell.width) || dimensions.height !== Number(cell.height)) {
          failures.push(`${label}.${id} crop dimensions differ from the machine evidence.`);
        }
      } catch (error) {
        failures.push(`${label}.${id} crop is unreadable (${error.message}).`);
      }
    }
  }
}

async function auditSourceIdentityReviewForHandoff({ character, showMember, canvasDir, workflowStore, machineRecheckPath }) {
  const failures = [];
  const reviewPath = sourceCanvasPath(canvasDir, character?.approval?.identityReviewPath);
  let review = null;
  try { review = await readJsonStrict(reviewPath); }
  catch (error) { failures.push(`identity review is unreadable (${error.message}).`); }
  if (!review) throw new Error(`${character.id} source identity review is not exportable:\n- ${failures.join("\n- ")}`);
  if (review.version !== CHARACTER_IDENTITY_REVIEW_VERSION || review.phase !== "identity-pack" || review.pass !== true) {
    failures.push(`identity review must be a passing ${CHARACTER_IDENTITY_REVIEW_VERSION} identity-pack review.`);
  }
  const workflow = getCharacterWorkflow(workflowStore, character.sourceWorkflowId);
  const workflowCast = workflow ? findWorkflowCast(workflow, character.id) : null;
  if (!nonEmptyString(character.sourceWorkflowId) || !workflow || !workflowCast
    || review.workflowId !== character.sourceWorkflowId || review.castId !== workflowCast.id || workflowCast.id !== character.id) {
    failures.push("identity review workflowId/castId does not bind the registered source workflow and character.");
  }
  if (!nonEmptyString(review.generatorContextId)
    || !nonEmptyString(review?.reviewer?.host)
    || !nonEmptyString(review?.reviewer?.id)
    || !nonEmptyString(review?.reviewer?.contextId)
    || !validIsoDate(review?.reviewer?.reviewedAt)
    || review.reviewer.contextId === review.generatorContextId
    || review.generatorContextId !== nonEmptyString(workflowCast?.identityPack?.generatorContextId)
    || review.originalScaleInspected !== true) {
    failures.push("identity review lacks independent reviewer/generator provenance and original-scale inspection.");
  }
  try {
    if (await sha256File(reviewPath) !== nonEmptyString(character?.approval?.identityReviewSha256)) {
      failures.push("identity review SHA-256 differs from the approved registry binding.");
    }
  } catch (error) {
    failures.push(`identity review SHA-256 cannot be checked (${error.message}).`);
  }

  const assets = (character.referenceAssets || []).map((asset) => ({
    ...asset,
    path: sourceCanvasPath(canvasDir, asset.path),
  }));
  const identityAssets = assets.filter((asset) => ["identity-face", "turnaround", "expression", "outfit", "eye-open"].includes(asset.role));
  const requiredRoles = Array.isArray(showMember?.requiredReferenceRoles) && showMember.requiredReferenceRoles.length > 0
    ? showMember.requiredReferenceRoles
    : ["identity-face", "turnaround", "expression"];
  for (const role of requiredRoles) if (!identityAssets.some((asset) => asset.role === role)) failures.push(`registered identity evidence is missing required role ${role}.`);
  for (const asset of identityAssets) {
    if (sourceCanvasPath(canvasDir, asset.sourceReviewPath) !== reviewPath) failures.push(`${asset.id || asset.role} is not bound to the same identity review.`);
  }
  const oneAsset = (role) => {
    const matches = identityAssets.filter((asset) => asset.role === role);
    if (matches.length !== 1) failures.push(`registered identity evidence requires exactly one ${role} asset.`);
    return matches[0] || null;
  };
  const selectedFace = oneAsset("identity-face");
  const turnaround = oneAsset("turnaround");
  const expression = oneAsset("expression");
  await auditSourceReviewAsset(review.selectedFace, selectedFace, "selectedFace", failures);
  await auditSourceReviewAsset(review.turnaround, turnaround, "turnaround", failures);
  await auditSourceReviewAsset(review.expression, expression, "expression", failures);
  if (review?.turnaround?.isRealTurnaround !== true
    || review?.turnaround?.notCandidateSubstitute !== true
    || review?.turnaround?.pass !== true
    || nonEmptyString(review?.turnaround?.note).length < 4) {
    failures.push("turnaround requires real/non-candidate/pass judgments and a visual note.");
  }
  await auditSourceReviewGrid({
    section: review.turnaround,
    label: "turnaround",
    columns: 4,
    rows: 2,
    ids: REQUIRED_TURNAROUND_VIEWS,
    booleanKeys: ["sameIdentity", "ageConsistent", "hairConsistent", "faceContourConsistent"],
    failures,
  });
  if (review?.expression?.pass !== true || nonEmptyString(review?.expression?.note).length < 4) {
    failures.push("expression sheet requires pass and a visual note.");
  }
  await auditSourceReviewGrid({
    section: review.expression,
    label: "expression",
    columns: 4,
    rows: 3,
    ids: REQUIRED_EXPRESSION_CELLS,
    booleanKeys: ["sameIdentity", "ageConsistent", "hairConsistent", "faceContourConsistent"],
    failures,
  });

  const outfitAssets = identityAssets.filter((asset) => asset.role === "outfit");
  const outfitReviews = Array.isArray(review.outfitSheets) ? review.outfitSheets : [];
  const expectedOutfitStages = outfitAssets.map((asset) => nonEmptyString(asset.storyStage));
  if (outfitReviews.length !== outfitAssets.length || new Set(expectedOutfitStages).size !== outfitAssets.length
    || outfitReviews.some((row) => !expectedOutfitStages.includes(nonEmptyString(row?.storyStage)))) {
    failures.push("outfit review rows must exactly cover every distinct registered story-stage outfit.");
  }
  for (const asset of outfitAssets) {
    const row = outfitReviews.find((entry) => entry?.storyStage === asset.storyStage);
    await auditSourceReviewAsset(row, asset, `outfitSheets.${asset.storyStage}`, failures);
    if (row?.sameIdentity !== true || row?.outfitMatchesSpecification !== true || row?.pass !== true || nonEmptyString(row?.note).length < 4) {
      failures.push(`outfitSheets.${asset.storyStage} requires identity/outfit/pass judgments and a visual note.`);
    }
    await auditSourceReviewGrid({
      section: row,
      label: `outfitSheets.${asset.storyStage}`,
      columns: 4,
      rows: 1,
      ids: REQUIRED_OUTFIT_CELLS,
      booleanKeys: ["sameIdentity", "ageConsistent", "hairConsistent", "faceContourConsistent", "outfitMatchesSpecification"],
      failures,
    });
  }

  // Eye-open sheets are keyed like outfit stages: the variant id lives in
  // storyStage, and an unkeyed sheet is the single legacy differential.
  const eyeAssets = identityAssets.filter((asset) => asset.role === "eye-open");
  const extraReviews = Array.isArray(review.extraSheets) ? review.extraSheets : [];
  const eyeVariantOf = (value) => nonEmptyString(value?.storyStage);
  const expectedEyeVariants = eyeAssets.map(eyeVariantOf);
  if (new Set(expectedEyeVariants).size !== eyeAssets.length
    || extraReviews.length !== eyeAssets.length
    || extraReviews.some((row) => row?.role !== "eye-open" || !expectedEyeVariants.includes(eyeVariantOf(row)))) {
    failures.push("extraSheets must exactly cover every distinct registered eye-open variant.");
  }
  const declaredEyeVariants = (Array.isArray(showMember?.eyeOpenVariants) ? showMember.eyeOpenVariants : [])
    .map((variant) => nonEmptyString(variant?.id))
    .filter(Boolean);
  const missingEyeVariants = declaredEyeVariants.filter((id) => !expectedEyeVariants.includes(id));
  if (missingEyeVariants.length > 0) {
    failures.push(`registered identity evidence is missing declared eye-open variant(s): ${missingEyeVariants.join(", ")}.`);
  }
  for (const asset of eyeAssets) {
    const variant = eyeVariantOf(asset);
    const label = variant ? `extraSheets.eye-open:${variant}` : "extraSheets.eye-open";
    const row = extraReviews.find((entry) => entry?.role === "eye-open" && eyeVariantOf(entry) === variant);
    await auditSourceReviewAsset(row, asset, label, failures);
    if (row?.sameIdentity !== true || row?.pass !== true || nonEmptyString(row?.note).length < 4) {
      failures.push(`${label} requires identity/pass judgments and a visual note.`);
    }
    await auditSourceReviewGrid({
      section: row,
      label,
      columns: 2,
      rows: 2,
      ids: REQUIRED_EYE_OPEN_CELLS,
      booleanKeys: ["sameIdentity", "ageConsistent", "hairConsistent", "faceContourConsistent", "stateMatchesSpecification"],
      failures,
    });
  }
  if (failures.length > 0) {
    throw new Error(`${character.id} source identity review is not exportable:\n- ${failures.join("\n- ")}`);
  }
  try {
    await validateIdentityPackReview({
      reviewPath,
      workflow,
      cast: workflowCast,
      identityPack: workflowCast.identityPack,
      machineRecheckPath,
    });
  } catch (error) {
    throw new Error(`${character.id} source identity review failed the canonical fresh machine recheck:\n- ${error.message}`);
  }
  return { pass: true, reviewPath, review };
}

async function buildPortableRegistry({ projectDir, canvasDir, bundleRoot, bundleId, showBible, characterIds, files, workflowStore, identityReviewRecheckRoot }) {
  const source = await readCharacterRegistry({ projectDir, canvasDir });
  const explicitIds = selectedIds(characterIds);
  const copied = new Map();
  const characters = [];
  for (const character of source.characters.filter((entry) => entry.status === "approved" && characterMatchesKoya(entry, showBible, explicitIds))) {
    const showMember = (showBible.cast || []).find((member) => member.id === character.id || member.name === character.name || character.aliases?.includes(member.name));
    await auditSourceIdentityReviewForHandoff({
      character,
      showMember,
      canvasDir,
      workflowStore,
      machineRecheckPath: join(identityReviewRecheckRoot, safeSegment(character.id), "identity-pack-review.json"),
    });
    // Build from an allowlist. The normalized source also contains workflow,
    // candidate, casting-plan and free-form note fields that are useful on the
    // creator's machine but are not required to reproduce an approved identity.
    const next = {
      id: character.id,
      name: character.name,
      kind: character.kind,
      role: character.role,
      status: character.status,
      episodeId: character.episodeId,
      aliases: [...(character.aliases || [])],
      description: character.description,
      invariants: [...(character.invariants || [])],
      negativePrompt: character.negativePrompt,
      referenceImagePaths: [],
      referenceAssets: [],
      stylePrompt: character.stylePrompt,
      voiceId: character.voiceId,
      approval: stripPrivateApproval(character.approval),
      createdAt: character.createdAt,
      updatedAt: character.updatedAt,
    };
    const referenceAssets = [];
    for (const asset of character.referenceAssets || []) {
      const sourcePath = sourceCanvasPath(canvasDir, asset.path);
      if (!sourcePath) continue;
      const copiedAsset = await copyRegistryAsset({ source: sourcePath, bundleRoot, bundleId, characterId: character.id, role: asset.role, copied, files });
      let sourceReviewPath = "";
      if (nonEmptyString(asset.sourceReviewPath)) {
        const reviewSource = sourceCanvasPath(canvasDir, asset.sourceReviewPath);
        const copiedReview = await copyReviewAsset({ source: reviewSource, bundleRoot, characterId: character.id, copied, files });
        sourceReviewPath = copiedReview.tokenPath;
      }
      referenceAssets.push({ ...asset, path: copiedAsset.tokenPath, sha256: copiedAsset.sha256, sourceReviewPath });
    }
    next.referenceAssets = referenceAssets;
    next.referenceImagePaths = referenceAssets.map((entry) => entry.path);
    if (nonEmptyString(next.approval?.identityReviewPath)) {
      const reviewSource = sourceCanvasPath(canvasDir, next.approval.identityReviewPath);
      const copiedReview = await copyReviewAsset({ source: reviewSource, bundleRoot, characterId: character.id, copied, files });
      next.approval.identityReviewPath = copiedReview.tokenPath;
      next.approval.identityReviewSha256 = copiedReview.sha256;
    }
    characters.push(next);
  }
  const usedVoiceIds = new Set(characters.map((entry) => entry.voiceId).filter(Boolean));
  const voices = source.voices.filter((entry) => usedVoiceIds.has(entry.id)).map((voice) => {
    // Only a complete human selection travels, and only as the sanitized
    // attestation: the receiving Koya speech gate needs proof that a person
    // chose this voice, not the private audition plan, reason or approver.
    const selection = portableKoyaVoiceSelectionAttestation(voice.casting);
    return {
      id: voice.id,
      name: voice.name,
      provider: voice.provider,
      providerVoiceId: voice.providerVoiceId,
      modelId: voice.modelId,
      role: voice.role,
      episodeId: voice.episodeId,
      source: voice.source,
      description: voice.description,
      status: voice.status,
      settings: structuredClone(voice.settings),
      ...(selection ? { casting: selection } : {}),
    };
  });
  return normalizeCharacterRegistry({
    version: 1,
    revision: 0,
    characters,
    voices,
  });
}

async function buildPortableVisualProfiles({ projectDir, canvasDir, bundleRoot, visualProfileIds, files }) {
  const sourcePath = join(canvasDir, "channel-visual-profiles.json");
  if (!await pathExists(sourcePath)) return normalizeChannelVisualProfileStore(null);
  const source = normalizeChannelVisualProfileStore(await readJsonStrict(sourcePath));
  const explicitIds = selectedIds(visualProfileIds);
  const keepIds = explicitIds.size > 0 ? explicitIds : new Set([source.defaultProfileId]);
  const copied = new Map();
  const profiles = [];
  for (const profile of source.profiles.filter((entry) => keepIds.has(entry.id))) {
    const next = structuredClone(profile);
    next.referenceImages = [];
    for (const reference of profile.referenceImages || []) {
      const sourceFile = sourceCanvasPath(canvasDir, reference.path);
      const actualSha = await sha256File(sourceFile);
      let tokenPath = copied.get(sourceFile);
      if (!tokenPath) {
        const extensionName = safeSegment(basename(sourceFile), "style.bin");
        const relativePath = `project/canvas/assets/visual-profiles/${safeSegment(profile.id)}/${actualSha.slice(0, 12)}-${extensionName}`;
        files.push(await copyEvidence(sourceFile, bundleRoot, relativePath, "locked-visual-reference"));
        tokenPath = `${CANVAS_TOKEN}assets/visual-profiles/${safeSegment(profile.id)}/${actualSha.slice(0, 12)}-${extensionName}`;
        copied.set(sourceFile, tokenPath);
      }
      next.referenceImages.push({ ...reference, path: tokenPath, sha256: actualSha });
    }
    profiles.push(next);
  }
  return normalizeChannelVisualProfileStore({ version: 1, defaultProfileId: profiles.some((entry) => entry.id === source.defaultProfileId) ? source.defaultProfileId : profiles[0]?.id || "", profiles });
}

async function stylingSpecPaths(projectDir, showBible) {
  const paths = [];
  for (const cast of Array.isArray(showBible?.cast) ? showBible.cast : []) {
    const relativePath = nonEmptyString(cast.stylingSpecPath);
    if (relativePath && !paths.includes(relativePath)) paths.push(relativePath);
  }
  const directory = resolveChannelPackPath(projectDir, "config/koya-character-styling");
  if (await pathExists(directory)) {
    for (const name of await readdir(directory)) {
      if (/\.json$/u.test(name)) {
        const relativePath = `config/koya-character-styling/${name}`;
        if (!paths.includes(relativePath)) paths.push(relativePath);
      }
    }
  }
  return paths.sort();
}

function rosterCharacterForMember(registry, member) {
  const names = new Set([member?.id, member?.name, member?.hiddenName].map(nonEmptyString).filter(Boolean));
  return (registry?.characters || []).find((character) => character?.kind === "character" && character?.status === "approved" && (
    names.has(character.id)
    || names.has(character.name)
    || (character.aliases || []).some((alias) => names.has(alias))
  )) || null;
}

function portableRosterAgent(actor, timeKey) {
  const id = nonEmptyString(actor?.id);
  const contextId = nonEmptyString(actor?.contextId);
  return {
    host: portableIdentifier("source-host-sha256", actor?.host),
    id: id ? `source-agent-sha256:${createHash("sha256").update(id).digest("hex")}` : "",
    contextId: contextId ? `source-context-sha256:${createHash("sha256").update(contextId).digest("hex")}` : "",
    [timeKey]: nonEmptyString(actor?.[timeKey]),
  };
}

function rosterContractSnapshot(showBible) {
  const contract = showBible?.rosterReview || {};
  return {
    version: nonEmptyString(contract.version),
    requiredBeforeEpisodeProduction: contract.requiredBeforeEpisodeProduction === true,
    requiredMemberCount: Number(contract.requiredMemberCount),
    requiredPairCount: Number(contract.requiredPairCount),
    requireIndependentReviewerContext: contract.requireIndependentReviewerContext === true,
    requireOriginalScaleInspection: contract.requireOriginalScaleInspection === true,
    requireThumbnailScaleInspection: contract.requireThumbnailScaleInspection === true,
    requiredPairChecks: Array.isArray(contract.requiredPairChecks) ? [...contract.requiredPairChecks] : [],
  };
}

function rosterPairIds(showBible) {
  const ids = (showBible?.cast || []).map((member) => nonEmptyString(member?.id)).filter(Boolean);
  return ids.flatMap((left, index) => ids.slice(index + 1).map((right) => [left, right].sort().join("::")));
}

function rosterAttestationEvidence(attestation) {
  return {
    scope: attestation.scope,
    sourceReview: attestation.sourceReview,
    authority: attestation.authority,
    snapshot: attestation.snapshot,
  };
}

function portableRosterSnapshot({ sourceReview, showBible, portableRegistry, sheetTokenPath, sheetSha256 }) {
  const members = [];
  for (const member of showBible.cast || []) {
    const sourceRow = (sourceReview.members || []).find((row) => row?.showCharacterId === member.id);
    const character = rosterCharacterForMember(portableRegistry, member);
    const faceAssets = (character?.referenceAssets || []).filter((asset) => asset.role === "identity-face");
    if (!sourceRow || !character || faceAssets.length !== 1) {
      throw new Error(`${member.name || member.id}: portable roster cannot bind one current identity-face entry.`);
    }
    const identityReviewPath = nonEmptyString(character?.approval?.identityReviewPath);
    const identityReviewSha256 = nonEmptyString(character?.approval?.identityReviewSha256);
    if (!identityReviewPath || !validSha256(identityReviewSha256)) {
      throw new Error(`${member.name || member.id}: portable roster cannot bind the identity review attestation.`);
    }
    members.push({
      showCharacterId: member.id,
      name: member.name,
      role: nonEmptyString(member.role),
      registryCharacterId: character.id,
      identityFace: { path: faceAssets[0].path, sha256: faceAssets[0].sha256 },
      identityReview: { path: identityReviewPath, sha256: identityReviewSha256 },
      sourceIdentityReviewSha256: nonEmptyString(sourceRow?.identityReview?.sha256),
      checks: {
        silhouetteReadable: sourceRow?.checks?.silhouetteReadable === true,
        ageReadDistinct: sourceRow?.checks?.ageReadDistinct === true,
        roleReadDistinct: sourceRow?.checks?.roleReadDistinct === true,
        thumbnailScaleReadable: sourceRow?.checks?.thumbnailScaleReadable === true,
      },
      pass: sourceRow.pass === true,
      note: portableIdentifier("source-note-sha256", sourceRow.note),
    });
  }
  const pairChecks = [];
  for (const pairId of rosterPairIds(showBible)) {
    const sourcePair = (sourceReview.pairChecks || []).find((pair) => pair?.pairId === pairId);
    if (!sourcePair) throw new Error(`Portable roster pair ${pairId} is missing.`);
    pairChecks.push({
      pairId,
      memberIds: pairId.split("::"),
      silhouetteDistinct: sourcePair.silhouetteDistinct === true,
      faceAgeRoleDistinct: sourcePair.faceAgeRoleDistinct === true,
      hairOutfitColorNotConfusing: sourcePair.hairOutfitColorNotConfusing === true,
      thumbnailScaleDistinct: sourcePair.thumbnailScaleDistinct === true,
      originalScaleInspected: sourcePair.originalScaleInspected === true,
      thumbnailScaleInspected: sourcePair.thumbnailScaleInspected === true,
      pass: sourcePair.pass === true,
      note: portableIdentifier("source-note-sha256", sourcePair.note),
    });
  }
  return {
    version: KOYA_CHARACTER_ROSTER_REVIEW_VERSION,
    phase: "fixed-cast-roster",
    generator: portableRosterAgent(sourceReview.generator, "composedAt"),
    reviewer: portableRosterAgent(sourceReview.reviewer, "reviewedAt"),
    originalScaleInspected: sourceReview.originalScaleInspected === true,
    thumbnailScaleInspected: sourceReview.thumbnailScaleInspected === true,
    rosterSheet: { path: sheetTokenPath, sha256: sheetSha256 },
    members,
    pairChecks,
    pass: sourceReview.pass === true,
    note: portableIdentifier("source-note-sha256", sourceReview.note),
  };
}

async function exportPortableRosterReview({ projectDir, canvasDir, bundleRoot, showBible, showBiblePath, sourceRegistry, portableRegistry, files }) {
  const audit = await auditKoyaCharacterRosterReview({ projectDir, canvasDir, showBible, registry: sourceRegistry });
  if (!audit.pass) {
    throw new Error(`Koya handoff requires the current channel-wide 11-member/55-pair roster review:\n- ${audit.failures.join("\n- ")}`);
  }
  const sourcePaths = resolveKoyaCharacterRosterReviewPaths({ projectDir, canvasDir });
  const sourceReview = await readJsonStrict(sourcePaths.reviewPath);
  if (nonEmptyString(sourceReview.episodeId)) {
    throw new Error("Koya handoff roster review must be channel-wide and cannot carry an episodeId.");
  }
  const sourceReviewSha256 = await sha256File(sourcePaths.reviewPath);
  const sheetSha256 = await sha256File(sourcePaths.sheetPath);
  files.push(await copyEvidence(sourcePaths.sheetPath, bundleRoot, ROSTER_SHEET_BUNDLE_PATH, "approved-roster-review-sheet"));
  const sheetTokenPath = `${CANVAS_TOKEN}${ROSTER_REVIEW_DIRECTORY}/roster-contact-sheet.svg`;
  const snapshot = portableRosterSnapshot({ sourceReview, showBible, portableRegistry, sheetTokenPath, sheetSha256 });
  const authorityPath = resolve(nonEmptyString(showBiblePath) || resolveChannelPackPath(projectDir, "config/koya-show-bible.json"));
  const attestation = {
    version: KOYA_HANDOFF_ROSTER_REVIEW_ATTESTATION_VERSION,
    scope: { kind: "channel-fixed-cast", episodeId: null },
    sourceReview: {
      version: nonEmptyString(sourceReview.version),
      phase: nonEmptyString(sourceReview.phase),
      sha256: sourceReviewSha256,
    },
    authority: {
      showBibleSha256: await sha256File(authorityPath),
      rosterContract: rosterContractSnapshot(showBible),
    },
    snapshot,
    evidenceDigest: "",
    note: "Complete portable fixed-cast roster approval evidence. Source-machine paths and raw task/session identifiers are redacted; every member, identity review, sheet byte, and pair decision remains SHA-bound.",
  };
  attestation.evidenceDigest = sha256Canonical(rosterAttestationEvidence(attestation));
  const attestationPath = resolveInside(bundleRoot, ROSTER_ATTESTATION_BUNDLE_PATH);
  await writeJsonAtomic(attestationPath, attestation);
  files.push(await fileEvidence(bundleRoot, attestationPath, "approved-roster-review-attestation"));
  return {
    version: attestation.version,
    scope: attestation.scope,
    memberCount: snapshot.members.length,
    pairCount: snapshot.pairChecks.length,
    sourceReviewSha256,
    showBibleSha256: attestation.authority.showBibleSha256,
    evidenceDigest: attestation.evidenceDigest,
    sheet: { path: ROSTER_SHEET_BUNDLE_PATH, sha256: sheetSha256 },
    attestation: { path: ROSTER_ATTESTATION_BUNDLE_PATH, sha256: await sha256File(attestationPath) },
  };
}

export async function exportKoyaHandoffBundle(args = {}) {
  const projectDir = resolve(nonEmptyString(args.projectDir) || process.cwd());
  const canvasDir = resolveCanvasDir({ ...args, projectDir });
  const id = safeSegment(args.bundleId, `koya-${new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`);
  const bundleRoot = resolve(nonEmptyString(args.outputDir) || join(canvasDir, "koya-handoff", id));
  if (await pathExists(bundleRoot)) {
    if (args.force !== true) throw new Error(`Handoff output already exists: ${bundleRoot}`);
    await rm(bundleRoot, { recursive: true, force: true });
  }
  await mkdir(bundleRoot, { recursive: true });
  const files = [];
  const authority = await readKoyaChannelAuthority({ projectDir, runtimeRoot: repositoryRoot });
  if (authority.source !== "project") throw new Error("Restore all Koya project authority files before exporting a handoff bundle.");
  const showBible = authority.showBible;
  // チャンネル正本は Channel Pack 側にある。従来パスを直接見ていたので、
  // pack へ移した環境では export が ENOENT で落ちていた。
  // 束の中は従来のレイアウトのまま置く（復元先がどちらでも読めるように）。
  for (const relativePath of [...PROJECT_CONFIG_PATHS, ...await stylingSpecPaths(projectDir, showBible)]) {
    const source = resolveChannelPackPath(projectDir, relativePath);
    if (!existsSync(source)) {
      throw new Error(`番組正本が見つからない: ${relativePath}（Channel Pack を配置すること）`);
    }
    files.push(await copyEvidence(source, bundleRoot, `project/${relativePath}`, "project-authority"));
  }
  // 契約はジャンル層のもので、ランタイム（プラグイン）と一緒に配布・更新される。
  // ここが projectDir 固定だったので、契約を置かない新しいプロジェクトでは
  // export が ENOENT で落ち、古い契約が残るプロジェクトでは
  // 「制作はランタイム契約 / bundle は古いプロジェクト契約」となって、
  // verify を通った bundle が restore の SHA 比較で拒否された。
  // 通常の解決と同じ経路を使う。
  for (const relativePath of CONTRACT_SNAPSHOT_PATHS) {
    const source = existsSync(resolveInside(projectDir, relativePath))
      ? resolveInside(projectDir, relativePath)
      : resolveInside(repositoryRoot, relativePath);
    if (!existsSync(source)) {
      throw new Error(
        `契約の snapshot に要るファイルが見つからない: ${relativePath}。`
        + "プロジェクト側にもランタイム側にも無いと、bundle は復元先で SHA 比較を通れない。",
      );
    }
    files.push(await copyEvidence(source, bundleRoot, `contract-snapshot/${relativePath}`, "plugin-contract-snapshot"));
  }
  const sourceRegistry = await readCharacterRegistry({ projectDir, canvasDir });
  const sourceRosterAudit = await auditKoyaCharacterRosterReview({ projectDir, canvasDir, showBible, registry: sourceRegistry });
  if (!sourceRosterAudit.pass) {
    throw new Error(`Koya handoff requires the current channel-wide 11-member/55-pair roster review:\n- ${sourceRosterAudit.failures.join("\n- ")}`);
  }
  const workflowStore = await readCharacterWorkflowStore({ projectDir, canvasDir });
  const identityReviewRecheckRoot = await mkdtemp(join(dirname(bundleRoot), ".koya-handoff-identity-recheck-"));
  let registry;
  try {
    registry = await buildPortableRegistry({
      projectDir,
      canvasDir,
      bundleRoot,
      bundleId: id,
      showBible,
      characterIds: args.characterIds,
      files,
      workflowStore,
      identityReviewRecheckRoot,
    });
  } finally {
    await rm(identityReviewRecheckRoot, { recursive: true, force: true });
  }
  const registryPath = resolveInside(bundleRoot, "project/canvas/characters.json");
  await writeJsonAtomic(registryPath, registry);
  files.push(await fileEvidence(bundleRoot, registryPath, "approved-character-registry"));
  const rosterReview = await exportPortableRosterReview({
    projectDir,
    canvasDir,
    bundleRoot,
    showBible,
    showBiblePath: authority.paths.show,
    sourceRegistry,
    portableRegistry: registry,
    files,
  });
  const profiles = await buildPortableVisualProfiles({ projectDir, canvasDir, bundleRoot, visualProfileIds: args.visualProfileIds, files });
  const profilesPath = resolveInside(bundleRoot, "project/canvas/channel-visual-profiles.json");
  await writeJsonAtomic(profilesPath, profiles);
  files.push(await fileEvidence(bundleRoot, profilesPath, "locked-visual-profile"));
  const bootstrap = await auditKoyaCharacterBootstrap({
    showBible,
    registry: sourceRegistry,
    workflowStore,
  });
  const pendingApprovals = {
    version: "koya-handoff-pending-approvals-v1",
    createdAt: new Date().toISOString(),
    complete: bootstrap.pass,
    approvedCount: bootstrap.approvedCount,
    onHoldCount: bootstrap.onHoldCount,
    blockingCount: bootstrap.blockingCount,
    rows: bootstrap.rows.map((row) => ({
      id: row.id,
      name: row.name,
      designStatus: row.designStatus,
      selectedBaseLabel: row.selectedBaseLabel,
      stage: row.stage,
      declaredStylingSpecCount: row.declaredStylingSpecCount,
      selectedStylingRoundCount: row.selectedStylingRoundCount,
      requiredReferenceRoles: row.requiredReferenceRoles,
      availableReferenceRoles: row.availableReferenceRoles,
      nextAction: row.nextAction,
    })),
    note: "Read-only sanitized status. Candidate files, private mappings, workflow IDs, review paths, session IDs, and credentials are intentionally excluded.",
  };
  const pendingApprovalsPath = resolveInside(bundleRoot, "project/koya-pending-approvals.json");
  await writeJsonAtomic(pendingApprovalsPath, pendingApprovals);
  files.push(await fileEvidence(bundleRoot, pendingApprovalsPath, "pending-approval-status"));
  const readmePath = resolveInside(bundleRoot, "README.md");
  await writeFile(readmePath, [
    "# 漫画動画ハーネス 案件データ束",
    "",
    "このフォルダはBuzzAssistプラグイン本体ではありません。先に受領側へ安定版BuzzAssistを導入し、その後、公式CLIまたはMCPでこの束をverify/restoreしてください。",
    "候補の秘密対応表、Claude/Codexセッションログ、APIキー、未承認人物は含みません。",
    "比較シートは人物参照ではなく、登録済み個別assetだけが生成時の人物参照です。",
    "承認reviewは原文SHAと判断snapshotを持つ移送用attestationへ変換し、送信元端末の絶対pathを含めません。",
    "固定11人の同時比較sheetと、11人個別・全55ペアの判断を含むroster attestationも完全な1組として検証・復元します。episode専用の人物や一部だけのrosterは受理しません。",
    "project/koya-pending-approvals.json は送付時点の未完工程を、候補ファイル・private mapping・workflow/session pathなしで示します。",
    "",
  ].join("\n"), "utf8");
  files.push(await fileEvidence(bundleRoot, readmePath, "instructions"));
  files.sort((left, right) => left.path.localeCompare(right.path));
  const manifestBody = {
    version: KOYA_HANDOFF_BUNDLE_VERSION,
    id,
    createdAt: new Date().toISOString(),
    includes: {
      approvedCharacters: registry.characters.length,
      voices: registry.voices.length,
      visualProfiles: profiles.profiles.length,
      pendingApprovalRows: pendingApprovals.rows.length,
      rosterReviewAttestation: true,
      rosterMembers: rosterReview.memberCount,
      rosterPairs: rosterReview.pairCount,
      unapprovedCandidates: false,
      privateCandidateMapping: false,
      sessionLogs: false,
      credentials: false,
    },
    rosterReview,
    files,
  };
  const manifest = { ...manifestBody, digest: createHash("sha256").update(JSON.stringify(manifestBody)).digest("hex") };
  await writeJsonAtomic(join(bundleRoot, "manifest.json"), manifest);
  await verifyKoyaHandoffBundle({ bundleDir: bundleRoot });
  return { ok: true, bundleRoot, manifestPath: join(bundleRoot, "manifest.json"), manifest };
}

async function walkFiles(root, current = root) {
  const output = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Symlinks are forbidden in a handoff bundle: ${path}`);
    if (entry.isDirectory()) output.push(...await walkFiles(root, path));
    else if (entry.isFile()) output.push(portablePath(relative(root, path)));
  }
  return output;
}

export async function verifyKoyaHandoffBundle(args = {}) {
  const bundleRoot = resolve(nonEmptyString(args.bundleDir ?? args.bundlePath));
  if (!nonEmptyString(args.bundleDir ?? args.bundlePath)) throw new Error("bundleDir is required.");
  const manifest = await readJsonStrict(join(bundleRoot, "manifest.json"));
  if (manifest.version !== KOYA_HANDOFF_BUNDLE_VERSION) throw new Error(`Unsupported Koya handoff version: ${manifest.version || "(missing)"}.`);
  const body = { ...manifest };
  delete body.digest;
  const digest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  if (digest !== manifest.digest) throw new Error("Koya handoff manifest digest mismatch.");
  const failures = [];
  const expected = new Set(["manifest.json"]);
  for (const row of Array.isArray(manifest.files) ? manifest.files : []) {
    const relativePath = safeBundleRelative(row.path);
    expected.add(relativePath);
    const path = resolveInside(bundleRoot, relativePath);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) failures.push(`${relativePath} is not a regular file.`);
      else {
        if (info.size !== row.size) failures.push(`${relativePath} size mismatch.`);
        if (await sha256File(path) !== row.sha256) failures.push(`${relativePath} SHA-256 mismatch.`);
      }
    } catch (error) { failures.push(`${relativePath}: ${error.message}`); }
  }
  for (const actual of await walkFiles(bundleRoot)) if (!expected.has(actual)) failures.push(`Unexpected file in bundle: ${actual}`);
  if (failures.length > 0) throw new Error(`Koya handoff verification failed:\n- ${failures.join("\n- ")}`);
  const authority = await readKoyaChannelAuthority({
    projectDir: join(bundleRoot, "project"),
    runtimeRoot: repositoryRoot,
    directProjectAuthority: true,
  });
  const pendingApprovals = await readJsonStrict(join(bundleRoot, "project", "koya-pending-approvals.json"));
  if (pendingApprovals.version !== "koya-handoff-pending-approvals-v1"
    || !Array.isArray(pendingApprovals.rows)
    || pendingApprovals.rows.length !== Number(manifest?.includes?.pendingApprovalRows)
    || containsAbsolutePath(pendingApprovals)) {
    throw new Error("Koya handoff pending-approval status is missing, malformed, or leaks an absolute path.");
  }
  const registryEvidence = await verifyPortableRegistryEvidence(bundleRoot);
  const rosterReview = await verifyPortableRosterReviewEvidence({
    bundleRoot,
    manifest,
    showBible: authority.showBible,
    registry: registryEvidence.registry,
  });
  return { ok: true, bundleRoot, manifestPath: join(bundleRoot, "manifest.json"), manifest, rosterReview };
}

function restoreCanvasToken(value, prefix) {
  if (typeof value !== "string" || !value.startsWith(CANVAS_TOKEN)) return value;
  return portablePath(join(prefix, value.slice(CANVAS_TOKEN.length)));
}

function bundleCanvasTokenPath(bundleRoot, value) {
  if (typeof value !== "string" || !value.startsWith(CANVAS_TOKEN)) throw new Error(`Handoff evidence path is not portable: ${value || "(missing)"}`);
  return resolveInside(join(bundleRoot, "project", "canvas"), value.slice(CANVAS_TOKEN.length));
}

function containsAbsolutePath(value) {
  if (Array.isArray(value)) return value.some(containsAbsolutePath);
  if (value && typeof value === "object") return Object.values(value).some(containsAbsolutePath);
  return typeof value === "string" && (isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value));
}

function manifestRowsFor(manifest, path, kind) {
  return (Array.isArray(manifest?.files) ? manifest.files : []).filter((row) => row?.path === path && row?.kind === kind);
}

async function verifyPortableRosterReviewEvidence({ bundleRoot, manifest, showBible, registry }) {
  const failures = [];
  const attestationPath = resolveInside(bundleRoot, ROSTER_ATTESTATION_BUNDLE_PATH);
  const sheetPath = resolveInside(bundleRoot, ROSTER_SHEET_BUNDLE_PATH);
  let attestation = null;
  try { attestation = await readJsonStrict(attestationPath); } catch (error) { failures.push(`Roster review attestation is missing or unreadable: ${error.message}`); }
  if (!attestation) throw new Error(`Koya portable roster review evidence failed:\n- ${failures.join("\n- ")}`);

  const attestationRows = manifestRowsFor(manifest, ROSTER_ATTESTATION_BUNDLE_PATH, "approved-roster-review-attestation");
  const sheetRows = manifestRowsFor(manifest, ROSTER_SHEET_BUNDLE_PATH, "approved-roster-review-sheet");
  if (attestationRows.length !== 1) failures.push("Manifest must bind exactly one approved roster review attestation.");
  if (sheetRows.length !== 1) failures.push("Manifest must bind exactly one approved roster review sheet.");
  const attestationSha256 = await sha256File(attestationPath);
  const sheetSha256 = await sha256File(sheetPath);
  if (attestationRows[0]?.sha256 !== attestationSha256) failures.push("Manifest roster attestation SHA-256 is stale.");
  if (sheetRows[0]?.sha256 !== sheetSha256) failures.push("Manifest roster sheet SHA-256 is stale.");

  if (attestation.version !== KOYA_HANDOFF_ROSTER_REVIEW_ATTESTATION_VERSION) failures.push("Roster review attestation version is unsupported.");
  if (attestation?.scope?.kind !== "channel-fixed-cast" || attestation?.scope?.episodeId !== null) {
    failures.push("Roster review attestation must be channel-wide and cannot target an episode.");
  }
  if (containsAbsolutePath(attestation)) failures.push("Roster review attestation leaks a source-machine absolute path.");
  if (attestation?.sourceReview?.version !== KOYA_CHARACTER_ROSTER_REVIEW_VERSION
    || attestation?.sourceReview?.phase !== "fixed-cast-roster"
    || !validSha256(attestation?.sourceReview?.sha256)) {
    failures.push("Roster review attestation does not bind the complete source review version/phase/SHA-256.");
  }
  if (attestation.evidenceDigest !== sha256Canonical(rosterAttestationEvidence(attestation))) {
    failures.push("Roster review attestation evidence digest mismatch.");
  }

  const bundledShowBiblePath = resolveInside(bundleRoot, "project/config/koya-show-bible.json");
  const showBibleSha256 = await sha256File(bundledShowBiblePath);
  if (attestation?.authority?.showBibleSha256 !== showBibleSha256) failures.push("Roster review attestation is stale for the bundled show bible.");
  if (canonicalJson(attestation?.authority?.rosterContract) !== canonicalJson(rosterContractSnapshot(showBible))) {
    failures.push("Roster review attestation does not match the bundled roster contract.");
  }

  const snapshot = attestation.snapshot || {};
  if (snapshot.version !== KOYA_CHARACTER_ROSTER_REVIEW_VERSION || snapshot.phase !== "fixed-cast-roster") failures.push("Portable roster snapshot has the wrong schema or phase.");
  if (nonEmptyString(snapshot.episodeId)) failures.push("Portable roster snapshot must not carry an episodeId.");
  for (const [label, actor, timeKey] of [
    ["generator", snapshot.generator, "composedAt"],
    ["reviewer", snapshot.reviewer, "reviewedAt"],
  ]) {
    if (!/^source-host-sha256:[a-f0-9]{64}$/u.test(nonEmptyString(actor?.host))) failures.push(`Roster ${label}.host must be a redacted SHA-256 provenance token.`);
    if (!/^source-agent-sha256:[a-f0-9]{64}$/u.test(nonEmptyString(actor?.id))) failures.push(`Roster ${label}.id must be a redacted SHA-256 provenance token.`);
    if (!/^source-context-sha256:[a-f0-9]{64}$/u.test(nonEmptyString(actor?.contextId))) failures.push(`Roster ${label}.contextId must be a redacted SHA-256 provenance token.`);
    if (!validIsoDate(actor?.[timeKey])) failures.push(`Roster ${label}.${timeKey} must be a valid ISO-8601 date.`);
  }
  if (nonEmptyString(snapshot?.generator?.contextId) === nonEmptyString(snapshot?.reviewer?.contextId)) failures.push("Roster reviewer context must differ from the sheet composer context.");
  if (snapshot.originalScaleInspected !== true || snapshot.thumbnailScaleInspected !== true) failures.push("Roster snapshot requires original and thumbnail scale inspection.");
  const expectedSheetToken = `${CANVAS_TOKEN}${ROSTER_REVIEW_DIRECTORY}/roster-contact-sheet.svg`;
  if (snapshot?.rosterSheet?.path !== expectedSheetToken || snapshot?.rosterSheet?.sha256 !== sheetSha256) failures.push("Roster snapshot sheet path/SHA-256 is stale or non-portable.");

  const expectedMembers = Array.isArray(showBible?.cast) ? showBible.cast : [];
  const expectedMemberCount = Number(showBible?.rosterReview?.requiredMemberCount);
  const expectedPairCount = Number(showBible?.rosterReview?.requiredPairCount);
  if (expectedMembers.length !== expectedMemberCount || expectedMemberCount !== 11) failures.push("Bundled show bible does not define the required 11-member fixed cast.");
  if ((registry?.characters || []).length !== expectedMemberCount) failures.push("Portable registry must contain exactly the complete fixed-cast roster.");
  const members = Array.isArray(snapshot.members) ? snapshot.members : [];
  if (members.length !== expectedMemberCount || new Set(members.map((member) => member?.showCharacterId)).size !== expectedMemberCount) {
    failures.push("Portable roster snapshot must contain exactly 11 unique members.");
  }
  if (new Set(members.map((member) => member?.registryCharacterId)).size !== expectedMemberCount) {
    failures.push("Portable roster snapshot must bind 11 distinct registry characters.");
  }
  if (new Set(members.map((member) => member?.identityFace?.sha256)).size !== expectedMemberCount) {
    failures.push("Portable roster snapshot must bind 11 distinct identity-face byte hashes.");
  }
  for (const member of expectedMembers) {
    const row = members.find((entry) => entry?.showCharacterId === member.id);
    const character = rosterCharacterForMember(registry, member);
    if (!row || !character) {
      failures.push(`${member.id}: roster member or portable registry entry is missing.`);
      continue;
    }
    if (nonEmptyString(character.episodeId)) failures.push(`${member.id}: fixed-cast handoff entry is incorrectly episode-bound.`);
    const faceAssets = (character.referenceAssets || []).filter((asset) => asset.role === "identity-face");
    if (faceAssets.length !== 1) {
      failures.push(`${member.id}: exactly one portable identity-face is required.`);
      continue;
    }
    if (row.name !== member.name || row.role !== nonEmptyString(member.role) || row.registryCharacterId !== character.id
      || row?.identityFace?.path !== faceAssets[0].path || row?.identityFace?.sha256 !== faceAssets[0].sha256
      || row?.identityReview?.path !== character?.approval?.identityReviewPath
      || row?.identityReview?.sha256 !== character?.approval?.identityReviewSha256) {
      failures.push(`${member.id}: roster member identity evidence differs from the portable registry.`);
    }
    try {
      const identityAttestation = await readJsonStrict(bundleCanvasTokenPath(bundleRoot, character.approval.identityReviewPath));
      if (!validSha256(row.sourceIdentityReviewSha256)
        || row.sourceIdentityReviewSha256 !== identityAttestation?.sourceReview?.sha256) {
        failures.push(`${member.id}: roster member is not bound to the original identity review SHA-256.`);
      }
    } catch (error) {
      failures.push(`${member.id}: roster identity review attestation is unreadable (${error.message}).`);
    }
    for (const key of ["silhouetteReadable", "ageReadDistinct", "roleReadDistinct", "thumbnailScaleReadable"]) {
      if (row?.checks?.[key] !== true) failures.push(`${member.id}.checks.${key} must be true.`);
    }
    if (row.pass !== true || !/^source-note-sha256:[a-f0-9]{64}$/u.test(nonEmptyString(row.note))) {
      failures.push(`${member.id}: pass and a redacted, SHA-bound member note are required.`);
    }
  }

  const expectedPairs = rosterPairIds(showBible);
  const pairs = Array.isArray(snapshot.pairChecks) ? snapshot.pairChecks : [];
  if (expectedPairs.length !== expectedPairCount || expectedPairCount !== 55) failures.push("Bundled show bible does not define the required 55 pair comparisons.");
  if (pairs.length !== expectedPairCount || new Set(pairs.map((pair) => pair?.pairId)).size !== expectedPairCount) failures.push("Portable roster snapshot must contain exactly 55 unique pair checks.");
  for (const pairId of expectedPairs) {
    const pair = pairs.find((entry) => entry?.pairId === pairId);
    if (!pair) { failures.push(`Roster pair ${pairId} is missing.`); continue; }
    if (canonicalJson(pair.memberIds) !== canonicalJson(pairId.split("::"))) failures.push(`Roster pair ${pairId} memberIds are invalid.`);
    for (const key of ["silhouetteDistinct", "faceAgeRoleDistinct", "hairOutfitColorNotConfusing", "thumbnailScaleDistinct", "originalScaleInspected", "thumbnailScaleInspected"]) {
      if (pair[key] !== true) failures.push(`Roster pair ${pairId}.${key} must be true.`);
    }
    if (pair.pass !== true || !/^source-note-sha256:[a-f0-9]{64}$/u.test(nonEmptyString(pair.note))) {
      failures.push(`Roster pair ${pairId} requires pass and a redacted, SHA-bound note.`);
    }
  }
  if (snapshot.pass !== true || !/^source-note-sha256:[a-f0-9]{64}$/u.test(nonEmptyString(snapshot.note))) {
    failures.push("Portable roster snapshot requires final pass and a redacted, SHA-bound note.");
  }

  const manifestRoster = manifest?.rosterReview || {};
  if (manifest?.includes?.rosterReviewAttestation !== true
    || Number(manifest?.includes?.rosterMembers) !== expectedMemberCount
    || Number(manifest?.includes?.rosterPairs) !== expectedPairCount
    || manifestRoster.version !== attestation.version
    || canonicalJson(manifestRoster.scope) !== canonicalJson(attestation.scope)
    || manifestRoster.memberCount !== members.length
    || manifestRoster.pairCount !== pairs.length
    || manifestRoster.sourceReviewSha256 !== attestation.sourceReview.sha256
    || manifestRoster.showBibleSha256 !== showBibleSha256
    || manifestRoster.evidenceDigest !== attestation.evidenceDigest
    || manifestRoster?.sheet?.path !== ROSTER_SHEET_BUNDLE_PATH
    || manifestRoster?.sheet?.sha256 !== sheetSha256
    || manifestRoster?.attestation?.path !== ROSTER_ATTESTATION_BUNDLE_PATH
    || manifestRoster?.attestation?.sha256 !== attestationSha256) {
    failures.push("Manifest roster summary does not match the complete attestation and evidence files.");
  }

  if (failures.length > 0) throw new Error(`Koya portable roster review evidence failed:\n- ${failures.join("\n- ")}`);
  return {
    pass: true,
    memberCount: members.length,
    pairCount: pairs.length,
    sourceReviewSha256: attestation.sourceReview.sha256,
    evidenceDigest: attestation.evidenceDigest,
    attestation,
  };
}

async function verifyPortableRegistryEvidence(bundleRoot) {
  const registryPath = join(bundleRoot, "project", "canvas", "characters.json");
  const rawRegistry = await readJsonStrict(registryPath);
  const registry = normalizeCharacterRegistry(rawRegistry);
  const failures = [];
  if (canonicalJson(rawRegistry) !== canonicalJson(registry)) {
    failures.push("Portable registry contains fields or values outside its explicit normalized schema.");
  }
  for (const character of registry.characters) {
    if (nonEmptyString(character.sourceWorkflowId) || nonEmptyString(character.sourceCandidateId)) {
      failures.push(`${character.id} leaks source workflow/candidate identifiers.`);
    }
    if (character.voiceCasting && Object.keys(character.voiceCasting).length > 0) {
      failures.push(`${character.id} carries private voice-casting plan metadata instead of the approved voiceId only.`);
    }
    const approval = character.approval || {};
    if (!/^source-approver-sha256:[a-f0-9]{64}$/u.test(nonEmptyString(approval.approvedBy))
      || !validIsoDate(approval.approvedAt)
      || nonEmptyString(approval.selectedCandidateLabel)
      || (nonEmptyString(approval.reason) && !/^source-reason-sha256:[a-f0-9]{64}$/u.test(nonEmptyString(approval.reason)))
      || (![
        "anonymous-candidate-selection",
        "human-best-of-n",
        "legacy-migration",
      ].includes(nonEmptyString(approval.route)) && !/^source-route-sha256:[a-f0-9]{64}$/u.test(nonEmptyString(approval.route)))) {
      failures.push(`${character.id} approval metadata is missing or exposes raw approver/candidate/reason data.`);
    }
    for (const asset of character.referenceAssets || []) {
      try {
        const path = bundleCanvasTokenPath(bundleRoot, asset.path);
        if (await sha256File(path) !== nonEmptyString(asset.sha256)) failures.push(`${character.id}/${asset.id || asset.role} asset SHA-256 mismatch.`);
      } catch (error) { failures.push(`${character.id}/${asset.id || asset.role}: ${error.message}`); }
    }
    const reviewToken = nonEmptyString(character?.approval?.identityReviewPath);
    if (!reviewToken) {
      failures.push(`${character.id} is approved without portable review attestation.`);
      continue;
    }
    try {
      const reviewPath = bundleCanvasTokenPath(bundleRoot, reviewToken);
      const actualSha256 = await sha256File(reviewPath);
      if (actualSha256 !== nonEmptyString(character.approval.identityReviewSha256)) failures.push(`${character.id} review attestation SHA-256 mismatch.`);
      const attestation = await readJsonStrict(reviewPath);
      if (attestation.version !== KOYA_HANDOFF_REVIEW_ATTESTATION_VERSION || attestation.subjectId !== character.id) failures.push(`${character.id} review attestation version or subject is invalid.`);
      if (attestation?.sourceReview?.version !== CHARACTER_IDENTITY_REVIEW_VERSION
        || attestation?.sourceReview?.phase !== "identity-pack"
        || !/^[a-f0-9]{64}$/u.test(nonEmptyString(attestation?.sourceReview?.sha256))
        || attestation?.snapshot?.version !== CHARACTER_IDENTITY_REVIEW_VERSION
        || attestation?.snapshot?.phase !== "identity-pack"
        || PORTABLE_IDENTITY_CHECK_KEYS.some((key) => attestation?.snapshot?.checks?.[key] !== true)
        || attestation?.snapshot?.pass !== true) {
        failures.push(`${character.id} review attestation is not a passing identity-pack review bound to its source SHA-256.`);
      }
      const identityFace = (character.referenceAssets || []).find((asset) => asset.role === "identity-face");
      if (!identityFace
        || attestation?.snapshot?.selectedFace?.sha256 !== identityFace.sha256
        || !/^source-path-sha256:[a-f0-9]{64}$/u.test(nonEmptyString(attestation?.snapshot?.selectedFace?.path))) {
        failures.push(`${character.id} review attestation does not bind the approved identity-face bytes.`);
      }
      if (containsAbsolutePath(attestation)) failures.push(`${character.id} review attestation leaks a source-machine absolute path.`);
      failures.push(...portableReviewPrivacyFailures(attestation.snapshot).map((failure) => `${character.id} review attestation ${failure}`));
      for (const asset of character.referenceAssets || []) {
        if (!nonEmptyString(asset.sourceReviewPath)) failures.push(`${character.id}/${asset.id || asset.role} is missing its review attestation link.`);
        else if (asset.sourceReviewPath !== reviewToken) failures.push(`${character.id}/${asset.id || asset.role} points at a different review attestation.`);
      }
    } catch (error) { failures.push(`${character.id} review attestation: ${error.message}`); }
  }
  for (const voice of registry.voices) {
    if (nonEmptyString(voice.previewUrl) || (voice.labels && Object.keys(voice.labels).length > 0)) {
      failures.push(`${voice.id} leaks preview, audition-plan, or provider label metadata.`);
    }
    // The only casting data allowed is the exact sanitized human-selection
    // attestation; anything else is private audition-plan data.
    if (voice.casting && Object.keys(voice.casting).length > 0) {
      const attestationFailures = portableKoyaVoiceSelectionAttestationFailures(voice.casting);
      if (attestationFailures.length > 0) {
        failures.push(`${voice.id} carries casting data other than a sanitized human voice-selection attestation (${attestationFailures.join("; ")}).`);
      }
    }
  }
  if (failures.length > 0) throw new Error(`Koya portable registry evidence failed:\n- ${failures.join("\n- ")}`);
  return { pass: true, characterCount: registry.characters.length, registry };
}

async function copyProjectAssetTree(bundleRoot, sourceDir, targetDir, targetRoot = targetDir) {
  if (!await pathExists(sourceDir)) return [];
  const copied = [];
  for (const relativePath of await walkFiles(sourceDir)) {
    const source = resolveInside(sourceDir, relativePath);
    const destination = resolveInside(targetDir, relativePath);
    await assertNoSymlinkAncestors(targetRoot, destination);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    copied.push(destination);
  }
  return copied;
}

async function pathFingerprint(path) {
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error(`Koya handoff transaction refuses a symlink target: ${path}`);
  if (info.isFile()) return `file:${info.size}:${await sha256File(path)}`;
  if (!info.isDirectory()) throw new Error(`Koya handoff transaction requires a regular file or directory: ${path}`);
  const rows = [];
  for (const relativePath of await walkFiles(path)) {
    const child = resolveInside(path, relativePath);
    const childInfo = await stat(child);
    rows.push({ path: relativePath, size: childInfo.size, sha256: await sha256File(child) });
  }
  return `directory:${sha256Canonical(rows)}`;
}

async function copyRegularPath(source, destination) {
  const info = await lstat(source);
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
    throw new Error(`Koya handoff transaction source must be a regular file or directory: ${source}`);
  }
  if (info.isDirectory()) await walkFiles(source); // Reject a nested symlink before copying anything.
  await mkdir(dirname(destination), { recursive: true });
  if (info.isDirectory()) await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
  else await copyFile(source, destination);
}

async function commitRestoreOperations(operations, options = {}) {
  if (!Array.isArray(operations) || operations.length === 0) throw new Error("Koya handoff restore transaction has no operations.");
  const targets = new Set();
  const sourceFingerprints = new Map();
  for (const operation of operations) {
    const target = resolve(nonEmptyString(operation?.target));
    const source = resolve(nonEmptyString(operation?.source));
    const targetRoot = resolve(nonEmptyString(operation?.targetRoot));
    if (!nonEmptyString(operation?.target) || !nonEmptyString(operation?.source) || !nonEmptyString(operation?.targetRoot)) {
      throw new Error("Koya handoff restore transaction operation is incomplete.");
    }
    if (targets.has(target)) throw new Error(`Koya handoff restore transaction has a duplicate target: ${target}`);
    targets.add(target);
    await assertNoSymlinkAncestors(targetRoot, target);
    const sourceFingerprint = await pathFingerprint(source);
    if (sourceFingerprint === "missing") throw new Error(`Koya handoff restore transaction source is missing: ${source}`);
    sourceFingerprints.set(target, sourceFingerprint);
    if (source === target) throw new Error(`Koya handoff restore transaction source and target are identical: ${target}`);
    const current = await pathFingerprint(target);
    if (nonEmptyString(operation.expectedTargetFingerprint) && current !== operation.expectedTargetFingerprint) {
      throw new Error(`Koya handoff restore target changed while staging: ${target}`);
    }
  }
  const orderedTargets = [...targets];
  for (const [index, target] of orderedTargets.entries()) {
    for (const other of orderedTargets.slice(index + 1)) {
      if (target.startsWith(`${other}${sep}`) || other.startsWith(`${target}${sep}`)) {
        throw new Error(`Koya handoff restore transaction targets overlap: ${target} / ${other}`);
      }
    }
  }

  const transactionParent = resolve(nonEmptyString(options.transactionParent) || dirname(operations[0].target));
  await mkdir(transactionParent, { recursive: true });
  const backupRoot = await mkdtemp(join(transactionParent, ".koya-handoff-restore-backup-"));
  const applied = [];
  let afterInstallResult;
  let preserveBackup = false;
  try {
    for (const [index, operation] of operations.entries()) {
      const target = resolve(operation.target);
      const backup = join(backupRoot, String(index));
      if (typeof options.beforeOperation === "function") await options.beforeOperation({ index, operation });
      const existing = await pathFingerprint(target);
      if (nonEmptyString(operation.expectedTargetFingerprint) && existing !== operation.expectedTargetFingerprint) {
        throw new Error(`Koya handoff restore target changed immediately before commit: ${target}`);
      }
      const sourceFingerprint = sourceFingerprints.get(target);
      if (await pathFingerprint(operation.source) !== sourceFingerprint) {
        throw new Error(`Koya handoff restore source changed immediately before commit: ${operation.source}`);
      }
      const record = { target, backup, hadOriginal: existing !== "missing", sourceFingerprint };
      if (record.hadOriginal) {
        await copyRegularPath(target, backup);
        if (await pathFingerprint(backup) !== existing || await pathFingerprint(target) !== existing) {
          throw new Error(`Koya handoff restore target changed while its rollback backup was created: ${target}`);
        }
      }
      applied.push(record);
      await rm(target, { recursive: true, force: true });
      await copyRegularPath(operation.source, target);
      record.installedFingerprint = await pathFingerprint(target);
      if (record.installedFingerprint !== record.sourceFingerprint) {
        throw new Error(`Koya handoff restore installed bytes differ from the staged source: ${target}`);
      }
      if (Number(options.failAfterOperation) === index + 1) {
        throw new Error(`Injected Koya handoff restore failure after operation ${index + 1}.`);
      }
    }
    for (const record of applied) {
      if (await pathFingerprint(record.target) !== record.installedFingerprint) {
        throw new Error(`Koya handoff restore target changed after it was installed: ${record.target}`);
      }
    }
    if (typeof options.afterInstall === "function") afterInstallResult = await options.afterInstall();
    for (const record of applied) {
      if (await pathFingerprint(record.target) !== record.installedFingerprint) {
        throw new Error(`Koya handoff restore target changed during its post-install audit: ${record.target}`);
      }
    }
    return { ok: true, operationCount: operations.length, afterInstallResult };
  } catch (error) {
    const rollbackFailures = [];
    for (const record of [...applied].reverse()) {
      try {
        const current = await pathFingerprint(record.target);
        if (record.installedFingerprint && current !== record.installedFingerprint) {
          rollbackFailures.push(`${record.target}: external writer changed the installed target; it was preserved instead of overwritten.`);
          continue;
        }
        await rm(record.target, { recursive: true, force: true });
        if (record.hadOriginal) await copyRegularPath(record.backup, record.target);
      } catch (rollbackError) {
        rollbackFailures.push(`${record.target}: ${rollbackError.message}`);
      }
    }
    if (rollbackFailures.length > 0) {
      preserveBackup = true;
      throw new Error(`${error.message}\nKoya handoff restore rollback failed; recovery backup preserved at ${backupRoot}:\n- ${rollbackFailures.join("\n- ")}`);
    }
    throw error;
  } finally {
    if (!preserveBackup) await rm(backupRoot, { recursive: true, force: true });
  }
}

function restoredRosterReview({ snapshot, canvasDir, assetPrefix, sheetPath, attestationPath, attestationSha256, bundleId, attestation }) {
  const restoreEvidence = (evidence) => {
    const restored = restoreCanvasToken(evidence?.path, assetPrefix);
    if (!restored || restored === evidence?.path) throw new Error(`Roster evidence path is not portable: ${evidence?.path || "(missing)"}`);
    return { path: resolve(canvasDir, restored), sha256: nonEmptyString(evidence?.sha256) };
  };
  return {
    version: snapshot.version,
    phase: snapshot.phase,
    generator: structuredClone(snapshot.generator),
    reviewer: structuredClone(snapshot.reviewer),
    originalScaleInspected: snapshot.originalScaleInspected === true,
    thumbnailScaleInspected: snapshot.thumbnailScaleInspected === true,
    rosterSheet: { path: sheetPath, sha256: nonEmptyString(snapshot?.rosterSheet?.sha256) },
    members: (snapshot.members || []).map((member) => ({
      ...structuredClone(member),
      identityFace: restoreEvidence(member.identityFace),
      identityReview: restoreEvidence(member.identityReview),
    })),
    pairChecks: structuredClone(snapshot.pairChecks || []),
    pass: snapshot.pass === true,
    note: nonEmptyString(snapshot.note),
    handoffAttestation: {
      version: KOYA_HANDOFF_ROSTER_REVIEW_ATTESTATION_VERSION,
      bundleId,
      path: portablePath(relative(canvasDir, attestationPath)),
      sha256: attestationSha256,
      sourceReviewSha256: nonEmptyString(attestation?.sourceReview?.sha256),
      evidenceDigest: nonEmptyString(attestation?.evidenceDigest),
    },
  };
}

export async function restoreKoyaHandoffBundle(args = {}) {
  const verified = await verifyKoyaHandoffBundle(args);
  const bundleRoot = verified.bundleRoot;
  const projectDir = resolve(nonEmptyString(args.projectDir) || process.cwd());
  const canvasDir = resolveCanvasDir({ ...args, projectDir });
  await assertNoSymlinkAncestors(dirname(projectDir), projectDir);
  await assertNoSymlinkAncestors(dirname(canvasDir), canvasDir);
  const targetContract = join(repositoryRoot, "config", "koya-manga-production-contract.json");
  const snapshotContract = join(bundleRoot, "contract-snapshot", "config", "koya-manga-production-contract.json");
  if (await sha256File(targetContract) !== await sha256File(snapshotContract)) {
    throw new Error("Installed Koya production contract differs from the handoff snapshot. Install the matching stable BuzzAssist release before restore.");
  }
  const authorityRelativePaths = new Set(PROJECT_CONFIG_PATHS);
  for (const row of verified.manifest.files || []) {
    const prefix = "project/config/koya-character-styling/";
    if (row.kind === "project-authority" && row.path.startsWith(prefix) && row.path.endsWith(".json")) {
      authorityRelativePaths.add(row.path.slice("project/".length));
    }
  }

  await mkdir(dirname(projectDir), { recursive: true });
  const stageRoot = await mkdtemp(join(dirname(projectDir), `.${safeSegment(basename(projectDir), "project")}.koya-handoff-restore-`));
  const stageProjectDir = join(stageRoot, "project");
  const stageCanvasDir = join(stageProjectDir, "canvas");
  const assetPrefix = portablePath(join("koya-handoff-assets", verified.manifest.id));
  try {
    for (const relativePath of authorityRelativePaths) {
      const source = resolveInside(join(bundleRoot, "project"), relativePath);
      const destination = resolveInside(stageProjectDir, relativePath);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
    }
    const copiedAssets = await copyProjectAssetTree(
      bundleRoot,
      join(bundleRoot, "project", "canvas", "assets"),
      join(stageCanvasDir, assetPrefix, "assets"),
      stageCanvasDir,
    );
    const incomingRegistry = normalizeCharacterRegistry(await readJsonStrict(join(bundleRoot, "project", "canvas", "characters.json")));
    for (const character of incomingRegistry.characters) {
      character.referenceImagePaths = character.referenceImagePaths.map((value) => restoreCanvasToken(value, assetPrefix));
      character.referenceAssets = character.referenceAssets.map((asset) => ({
        ...asset,
        path: restoreCanvasToken(asset.path, assetPrefix),
        sourceReviewPath: restoreCanvasToken(asset.sourceReviewPath, assetPrefix),
      }));
      if (character.approval) character.approval.identityReviewPath = restoreCanvasToken(character.approval.identityReviewPath, assetPrefix);
    }
    const currentRegistry = await readCharacterRegistry({ projectDir, canvasDir });
    const incomingIds = new Set(incomingRegistry.characters.map((entry) => entry.id));
    const writtenRegistry = normalizeCharacterRegistry({
      ...currentRegistry,
      characters: [...currentRegistry.characters.filter((entry) => !incomingIds.has(entry.id)), ...incomingRegistry.characters],
      voices: [...currentRegistry.voices.filter((entry) => !incomingRegistry.voices.some((incoming) => incoming.id === entry.id)), ...incomingRegistry.voices],
    });
    writtenRegistry.revision = currentRegistry.revision + 1;
    const stageRegistryPath = join(stageCanvasDir, "characters.json");
    await writeJsonAtomic(stageRegistryPath, writtenRegistry);

    const incomingProfiles = normalizeChannelVisualProfileStore(await readJsonStrict(join(bundleRoot, "project", "canvas", "channel-visual-profiles.json")));
    for (const profile of incomingProfiles.profiles) {
      profile.referenceImages = profile.referenceImages.map((reference) => ({ ...reference, path: restoreCanvasToken(reference.path, assetPrefix) }));
    }
    const targetProfilePath = join(canvasDir, "channel-visual-profiles.json");
    const currentProfiles = await pathExists(targetProfilePath)
      ? normalizeChannelVisualProfileStore(await readJsonStrict(targetProfilePath))
      : normalizeChannelVisualProfileStore(null);
    const incomingProfileIds = new Set(incomingProfiles.profiles.map((entry) => entry.id));
    const mergedProfiles = normalizeChannelVisualProfileStore({
      version: 1,
      defaultProfileId: incomingProfiles.defaultProfileId || currentProfiles.defaultProfileId,
      profiles: [...currentProfiles.profiles.filter((entry) => !incomingProfileIds.has(entry.id)), ...incomingProfiles.profiles],
    });
    const stageProfilePath = join(stageCanvasDir, "channel-visual-profiles.json");
    await writeJsonAtomic(stageProfilePath, mergedProfiles);

    const stageRosterPaths = resolveKoyaCharacterRosterReviewPaths({ projectDir: stageProjectDir, canvasDir: stageCanvasDir });
    const stageAttestationPath = join(stageRosterPaths.root, "roster-review-attestation.json");
    await mkdir(stageRosterPaths.root, { recursive: true });
    await copyFile(resolveInside(bundleRoot, ROSTER_SHEET_BUNDLE_PATH), stageRosterPaths.sheetPath);
    await copyFile(resolveInside(bundleRoot, ROSTER_ATTESTATION_BUNDLE_PATH), stageAttestationPath);
    const stageRosterReview = restoredRosterReview({
      snapshot: verified.rosterReview.attestation.snapshot,
      canvasDir: stageCanvasDir,
      assetPrefix,
      sheetPath: stageRosterPaths.sheetPath,
      attestationPath: stageAttestationPath,
      attestationSha256: verified.manifest.rosterReview.attestation.sha256,
      bundleId: verified.manifest.id,
      attestation: verified.rosterReview.attestation,
    });
    await writeJsonAtomic(stageRosterPaths.reviewPath, stageRosterReview);
    const stagedAuthority = await readKoyaChannelAuthority({
      projectDir: stageProjectDir,
      runtimeRoot: repositoryRoot,
      directProjectAuthority: true,
    });
    const stagedRosterAudit = await auditKoyaCharacterRosterReview({
      projectDir: stageProjectDir,
      canvasDir: stageCanvasDir,
      showBible: stagedAuthority.showBible,
      registry: writtenRegistry,
      reviewPath: stageRosterPaths.reviewPath,
    });
    if (!stagedRosterAudit.pass) {
      throw new Error(`Staged Koya roster review did not pass its canonical audit:\n- ${stagedRosterAudit.failures.join("\n- ")}`);
    }

    const rosterPaths = resolveKoyaCharacterRosterReviewPaths({ projectDir, canvasDir });
    const restoredAttestationPath = join(rosterPaths.root, "roster-review-attestation.json");
    const targetRosterReview = restoredRosterReview({
      snapshot: verified.rosterReview.attestation.snapshot,
      canvasDir,
      assetPrefix,
      sheetPath: rosterPaths.sheetPath,
      attestationPath: restoredAttestationPath,
      attestationSha256: verified.manifest.rosterReview.attestation.sha256,
      bundleId: verified.manifest.id,
      attestation: verified.rosterReview.attestation,
    });
    await writeJsonAtomic(stageRosterPaths.reviewPath, targetRosterReview);

    const operations = [];
    const appendOperation = async (source, target, targetRoot) => {
      operations.push({ source, target, targetRoot, expectedTargetFingerprint: await pathFingerprint(target) });
    };
    for (const relativePath of authorityRelativePaths) {
      await appendOperation(resolveInside(stageProjectDir, relativePath), resolveInside(projectDir, relativePath), projectDir);
    }
    await appendOperation(join(stageCanvasDir, assetPrefix), join(canvasDir, assetPrefix), canvasDir);
    await appendOperation(stageRegistryPath, join(canvasDir, "characters.json"), canvasDir);
    await appendOperation(stageProfilePath, targetProfilePath, canvasDir);
    await appendOperation(stageRosterPaths.root, rosterPaths.root, canvasDir);

    const transaction = await commitRestoreOperations(operations, {
      transactionParent: dirname(projectDir),
      afterInstall: async () => {
        const installedRegistry = await readCharacterRegistry({ projectDir, canvasDir });
        const restoredAuthority = await readKoyaChannelAuthority({
          projectDir,
          runtimeRoot: repositoryRoot,
          directProjectAuthority: true,
        });
        const rosterAudit = await auditKoyaCharacterRosterReview({
          projectDir,
          canvasDir,
          showBible: restoredAuthority.showBible,
          registry: installedRegistry,
          reviewPath: rosterPaths.reviewPath,
        });
        if (!rosterAudit.pass) {
          throw new Error(`Restored Koya roster review did not pass its canonical audit:\n- ${rosterAudit.failures.join("\n- ")}`);
        }
        return { installedRegistry, rosterAudit };
      },
    });
    const { installedRegistry, rosterAudit } = transaction.afterInstallResult;
    return {
      ok: true,
      bundleId: verified.manifest.id,
      projectDir,
      canvasDir,
      copiedAssets: copiedAssets.length,
      restoredCharacters: incomingRegistry.characters.length,
      restoredVisualProfiles: incomingProfiles.profiles.length,
      restoredRosterMembers: rosterAudit.approvedMemberCount,
      restoredRosterPairs: verified.rosterReview.pairCount,
      rosterReviewPath: rosterPaths.reviewPath,
      rosterAttestationPath: restoredAttestationPath,
      registryRevision: installedRegistry.revision,
      transactionOperations: transaction.operationCount,
    };
  } finally {
    await rm(stageRoot, { recursive: true, force: true });
  }
}

export const _testing = Object.freeze({
  assertNoSymlinkAncestors,
  auditSourceIdentityReviewForHandoff,
  auditSourceReviewGrid,
  commitRestoreOperations,
  pathFingerprint,
  portableReviewPrivacyFailures,
});
