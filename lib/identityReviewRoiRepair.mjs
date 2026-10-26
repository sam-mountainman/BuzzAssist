// ROI repair driven by a failed independent identity review.
//
// `character-identity-repair --identity-review-path FAILED --roi-from-review`
// turns the reviewer's own per-cell verdicts into findings and an in-memory
// repair plan with the same entry shape as the human-findings path
// (cellId/findingId/issue/repairRegion/acceptCriteria ...), so the repair job
// edits only the failed cells of the existing sheet instead of regenerating the
// whole role from scratch with no memory of what was wrong.
//
// The plan is bound to the SHA-256 of the failed review bytes (its
// previousFailureFingerprint) under its own contract id; it never borrows the
// historical human-QA contract that the findings path is bound to.
import { createHash } from "node:crypto";

import { buildCharacterCandidateQualityContract } from "./characterAttributeGate.mjs";
import {
  REQUIRED_EXPRESSION_CELLS,
  REQUIRED_EYE_OPEN_CELLS,
  REQUIRED_OUTFIT_CELLS,
  REQUIRED_TURNAROUND_VIEWS,
  eyeOpenReviewKey,
} from "./characterIdentityReview.mjs";
import {
  createCharacterRepairPlan,
  verifyCharacterRepairPlanDigest,
  verifyRepairPlanCoverage,
} from "./characterRepairPlan.mjs";

export const IDENTITY_REVIEW_ROI_REPAIR_CONTRACT_ID = "identity-review-roi-repair-v1";
export const IDENTITY_REVIEW_ROI_REPAIR_EVIDENCE_VERSION = "koya-identity-review-roi-repair-v1";
export const IDENTITY_REPAIR_MODES = Object.freeze({
  wholeRole: "review-whole-role",
  humanFindingsRoi: "human-findings-roi",
  identityReviewRoi: "identity-review-roi",
});

const IDENTITY_KEYS = Object.freeze(["sameIdentity", "ageConsistent", "hairConsistent", "faceContourConsistent"]);
const CHECK_WORDING = Object.freeze({
  sameIdentity: "the same person as the approved identity reference",
  ageConsistent: "the approved age",
  hairConsistent: "the approved hairstyle and hair color",
  faceContourConsistent: "the approved face contour",
  outfitMatchesSpecification: "the specified outfit",
  stateMatchesSpecification: "the specified eye state",
});

// A failed cell whose named checks and side-lock rows all pass is classified by
// its note. Only a note that talks about the grid/containment and not about a
// drawing defect makes the cell alignment-only; everything else is a content
// defect, so an ambiguous note is repaired rather than silently skipped.
const ALIGNMENT_NOTE = /\b(?:grid|gutters?|boundar(?:y|ies)|borders?|clearance|margins?|crop(?:ped|ping|s)?|clip(?:ped|ping|s)?|cut[ -]?off|leak(?:s|ed|ing)?|bleed(?:s|ing)?|overlap(?:s|ped|ping)?|outside (?:the |its )?cell|alignment|misalign(?:ed|ment)?|containment|spill(?:s|ed|ing)?)\b|セル境界|境界|はみ出|食み出|見切れ|余白|枠外|格子|グリッド|整列/iu;
const CONTENT_NOTE = /\b(?:mirror(?:ed|ing|s)?|flip(?:ped|s)?|revers(?:ed|al)|wrong (?:side|shoulder|direction|facing|view|expression|eye state|outfit|garment)|duplicate[ds]?|cop(?:y|ied) of|identity|different person|expression|outfit|garment|asymmetr\w*|subject-(?:left|right))\b|鏡像|反転|左右|逆向き|向きが逆|向き|表情|別人|衣装|服装|コピー|複製|同じ絵/iu;

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

/** Normalized [x, y, w, h] of cell `index` (row-major) in an equal columns x rows grid. */
export function identityGridCellRegion({ columns, rows, index }) {
  if (![columns, rows, index].every(Number.isInteger) || columns <= 0 || rows <= 0 || index < 0 || index >= columns * rows) {
    throw new Error(`Invalid identity grid cell: index ${index} in ${columns}x${rows}.`);
  }
  const column = index % columns;
  const row = Math.floor(index / columns);
  const x = round6(column / columns);
  const y = round6(row / rows);
  let w = round6(1 / columns);
  let h = round6(1 / rows);
  if (x + w > 1) w = 1 - x;
  if (y + h > 1) h = 1 - y;
  return [x, y, w, h];
}

function reviewedRoleSheets(review) {
  const sheets = [
    {
      role: "turnaround", label: "turnaround", sheet: plainObject(review?.turnaround) || {},
      cells: review?.turnaround?.viewChecks, ids: REQUIRED_TURNAROUND_VIEWS, columns: 4, rows: 2, checkKeys: IDENTITY_KEYS,
    },
    {
      role: "expression", label: "expression", sheet: plainObject(review?.expression) || {},
      cells: review?.expression?.cells, ids: REQUIRED_EXPRESSION_CELLS, columns: 4, rows: 3, checkKeys: IDENTITY_KEYS,
    },
  ];
  for (const sheet of Array.isArray(review?.outfitSheets) ? review.outfitSheets : []) {
    sheets.push({
      role: `outfit:${nonEmpty(sheet?.storyStage)}`, label: "outfit", sheet: plainObject(sheet) || {},
      cells: sheet?.cells, ids: REQUIRED_OUTFIT_CELLS, columns: 4, rows: 1,
      checkKeys: [...IDENTITY_KEYS, "outfitMatchesSpecification"], sheetKeys: ["sameIdentity", "outfitMatchesSpecification"],
    });
  }
  for (const sheet of Array.isArray(review?.extraSheets) ? review.extraSheets : []) {
    if (sheet?.role !== "eye-open") continue;
    sheets.push({
      role: eyeOpenReviewKey(nonEmpty(sheet?.storyStage)), label: "eye-open", sheet: plainObject(sheet) || {},
      cells: sheet?.cells, ids: REQUIRED_EYE_OPEN_CELLS, columns: 2, rows: 2,
      checkKeys: [...IDENTITY_KEYS, "stateMatchesSpecification"], sheetKeys: ["sameIdentity"],
    });
  }
  return sheets;
}

function sideLockFailures(cell) {
  const rows = Array.isArray(cell?.asymmetricFeatureChecks) ? cell.asymmetricFeatureChecks : [];
  return rows
    .map(plainObject)
    .filter((row) => row && row.applicable !== false && row.pass !== true)
    .map((row) => ({
      id: nonEmpty(row.id) || nonEmpty(row.feature),
      feature: nonEmpty(row.feature) || nonEmpty(row.id),
      expectedSide: nonEmpty(row.expectedSide),
      observedSide: nonEmpty(row.observedSide),
      note: nonEmpty(row.note),
    }));
}

/**
 * Classify one failed cell. `content` cells become ROI findings;
 * `alignment` cells belong to character-identity-repack.
 */
export function classifyFailedIdentityCell(cell, checkKeys = IDENTITY_KEYS) {
  const failedChecks = checkKeys.filter((key) => cell?.[key] !== true);
  const sideFailures = sideLockFailures(cell);
  const note = nonEmpty(cell?.note);
  if (failedChecks.length > 0 || sideFailures.length > 0) {
    return { kind: "content", basis: "named-checks", failedChecks, sideFailures, note };
  }
  if (note && CONTENT_NOTE.test(note)) return { kind: "content", basis: "note-content-defect", failedChecks, sideFailures, note };
  if (note && ALIGNMENT_NOTE.test(note)) return { kind: "alignment", basis: "note-alignment-only", failedChecks, sideFailures, note };
  return { kind: "content", basis: "note-unclassified", failedChecks, sideFailures, note };
}

function describeFailure({ failedChecks, sideFailures }) {
  const parts = sideFailures.map((row) =>
    `side-locked feature ${row.id} must be on ${row.expectedSide || "its declared side"}; review recorded ${row.observedSide || "no side"}`);
  if (failedChecks.length > 0) parts.push(`failed ${failedChecks.join(", ")}`);
  if (parts.length === 0) parts.push("the independent reviewer failed this cell without naming a failed check");
  return parts.join("; ");
}

function anatomicalSideWords(side) {
  if (side === "subject-left") return "own left";
  if (side === "subject-right") return "own right";
  return "declared";
}

function buildFinding({ role, label, cellId, index, columns, rows, classification }) {
  const repairRegion = identityGridCellRegion({ columns, rows, index });
  const generated = describeFailure(classification);
  const note = classification.note;
  const issue = note ? (note.length >= 8 ? note : `${note}: ${generated}`) : generated;
  const structural = classification.failedChecks.length > 0 || classification.sideFailures.length > 0;
  const problem = structural && !issue.includes(generated) ? `${issue} [${generated}]` : issue;
  const row = Math.floor(index / columns) + 1;
  const column = (index % columns) + 1;
  const repair = [
    `Redraw ONLY cell ${cellId} of the ${role} sheet (row ${row}, column ${column} of the ${columns}x${rows} grid; normalized ROI ${JSON.stringify(repairRegion)}) and keep every other cell exactly as it is.`,
    ...(label === "turnaround" ? [`The cell must show the required view: ${cellId.replaceAll("-", " ")}.`] : []),
    ...classification.sideFailures.map((side) =>
      `Draw ${side.feature} on the character's ${anatomicalSideWords(side.expectedSide)} side (${side.expectedSide || "declared side"}); this is the anatomical side, not the canvas side. Never create this view by mirroring or flipping another cell or view.${side.note ? ` Reviewer side note: "${side.note}".` : ""}`),
    ...(classification.failedChecks.length > 0
      ? [`Restore ${classification.failedChecks.map((key) => CHECK_WORDING[key] || key).join(", ")} from the approved references.`]
      : []),
    ...(note ? [`Fix the defect the independent reviewer recorded: "${note}".`] : []),
  ].join(" ");
  const acceptCriteria = [
    `${role} cell ${cellId} passes fresh independent original-scale QA (${[...IDENTITY_KEYS, ...classification.failedChecks.filter((key) => !IDENTITY_KEYS.includes(key))].join(", ")}).`,
    ...classification.sideFailures.map((side) => `${side.id} is visible on ${side.expectedSide || "its declared side"} in ${cellId}.`),
    `No pixel outside the ROI ${JSON.stringify(repairRegion)} changes.`,
  ];
  const rejectCriteria = [
    "The repaired cell is a mirrored or flipped copy of another view.",
    "Any change outside the ROI.",
    "The defect recorded by the failed review recurs.",
  ];
  return {
    findingId: `${role}:${cellId}`,
    role,
    cellId,
    issue,
    problem,
    repair,
    repairRegion,
    grid: { columns, rows, index },
    failureBasis: classification.basis,
    failedChecks: classification.failedChecks,
    sideLockFailures: classification.sideFailures,
    reviewerNote: note,
    acceptCriteria,
    rejectCriteria,
  };
}

/**
 * Derive cell-level ROI findings from a validated failed identity review.
 * `failedRoles` is the role list returned by validateFailedIdentityPackReview.
 */
export function deriveIdentityReviewRoiFindings({ review, failedRoles = [] } = {}) {
  const failed = new Set((Array.isArray(failedRoles) ? failedRoles : []).map(nonEmpty).filter(Boolean));
  const findings = [];
  const alignmentOnlyCells = [];
  const alignmentOnlyRoles = [];
  const sheetLevelOnlyRoles = [];
  // Failed roles whose grid alignment is still unconfirmed even after ROI
  // repair (repack them after the fresh QA if the alignment still fails).
  const alignmentPendingRoles = [];
  const known = new Set();
  for (const config of reviewedRoleSheets(review)) {
    known.add(config.role);
    if (!failed.has(config.role)) continue;
    const grid = plainObject(config.sheet.grid) || {};
    if ((grid.columns !== undefined && Number(grid.columns) !== config.columns) || (grid.rows !== undefined && Number(grid.rows) !== config.rows)) {
      throw new Error(`${config.role} review grid ${grid.columns}x${grid.rows} does not match the ${config.columns}x${config.rows} ROI grid.`);
    }
    const cells = Array.isArray(config.cells) ? config.cells : [];
    const roleFindings = [];
    const roleAlignmentCells = [];
    config.ids.forEach((cellId, index) => {
      const cell = cells.find((entry) => entry?.id === cellId);
      if (!cell || cell.pass === true) return;
      const classification = classifyFailedIdentityCell(cell, config.checkKeys);
      if (classification.kind === "alignment") {
        roleAlignmentCells.push({ findingId: `${config.role}:${cellId}`, role: config.role, cellId, note: classification.note });
        return;
      }
      roleFindings.push(buildFinding({ ...config, cellId, index, classification }));
    });
    findings.push(...roleFindings);
    alignmentOnlyCells.push(...roleAlignmentCells);
    if (grid.alignmentConfirmed !== true || roleAlignmentCells.length > 0) alignmentPendingRoles.push(config.role);
    if (roleFindings.length > 0) continue;
    const sheetContentFailed = (config.sheetKeys || []).some((key) => config.sheet[key] !== true);
    if (!sheetContentFailed && (grid.alignmentConfirmed !== true || roleAlignmentCells.length > 0)) {
      alignmentOnlyRoles.push(config.role);
    } else {
      sheetLevelOnlyRoles.push({ role: config.role, note: nonEmpty(config.sheet.note) });
    }
  }
  const unknownRoles = [...failed].filter((role) => !known.has(role));
  return {
    findings,
    targetRoles: [...new Set(findings.map((entry) => entry.role))],
    alignmentOnlyRoles,
    alignmentOnlyCells,
    alignmentPendingRoles,
    sheetLevelOnlyRoles,
    unknownRoles,
  };
}

/** Refuse inputs ROI repair cannot honestly target. */
export function assertIdentityReviewRoiRepairable(derivation, { reviewPath = "" } = {}) {
  const source = reviewPath ? ` ${reviewPath}` : "";
  if (derivation.unknownRoles.length > 0) {
    throw new Error(`ROI repair from review cannot target roles without a fixed cell grid: ${derivation.unknownRoles.join(", ")}. Regenerate them without --roi-from-review.`);
  }
  if (derivation.sheetLevelOnlyRoles.length > 0) {
    throw new Error(`Identity review${source} failed ${derivation.sheetLevelOnlyRoles.map((entry) => entry.role).join(", ")} without any failed cell (sheet-level verdict only). ROI repair needs cell-level failures: mark the failing cells in the review, or regenerate the whole role without --roi-from-review.`);
  }
  if (derivation.findings.length === 0) {
    const cells = derivation.alignmentOnlyCells.map((entry) => entry.findingId);
    throw new Error(`Identity review${source} fails only on grid alignment/containment (roles: ${derivation.alignmentOnlyRoles.join(", ") || "none"}${cells.length ? `; cells: ${cells.join(", ")}` : ""}). ROI repair redraws content defects only; run character-identity-repack with the same --identity-review-path to contain the existing views in exact cells, then re-review.`);
  }
}

/**
 * Build the in-memory repair plan. The digest is computed by
 * createCharacterRepairPlan exactly as for any other character repair plan;
 * only the contract id and the failure fingerprint (failed review SHA-256)
 * differ from the human-findings path.
 */
export function buildIdentityReviewRoiRepairPlan({ findings = [], failedReviewSha256, createdAt, roundIndex = 0 } = {}) {
  if (!/^[a-f0-9]{64}$/u.test(nonEmpty(failedReviewSha256))) throw new Error("ROI repair plan requires the failed review SHA-256.");
  if (!nonEmpty(createdAt)) throw new Error("ROI repair plan requires a deterministic createdAt (the failed review's reviewedAt).");
  const contract = buildCharacterCandidateQualityContract({ castId: IDENTITY_REVIEW_ROI_REPAIR_CONTRACT_ID, maximumReviewRounds: 3 });
  const plan = createCharacterRepairPlan({
    contract,
    state: { contractDigest: contract.digest, rounds: [{ index: roundIndex, failureFingerprint: failedReviewSha256 }] },
    createdAt,
    entries: findings.map((finding) => ({
      cellId: finding.cellId,
      findingId: finding.findingId,
      issue: finding.issue,
      repairRegion: finding.repairRegion,
      protectRegions: [],
      acceptCriteria: finding.acceptCriteria,
      rejectCriteria: finding.rejectCriteria,
    })),
  });
  if (!verifyCharacterRepairPlanDigest(plan).valid) throw new Error("ROI repair plan digest does not match its body.");
  const coverage = verifyRepairPlanCoverage(plan, findings);
  if (!coverage.complete) throw new Error(`ROI repair plan misses findings: ${coverage.missing.join(", ")}`);
  return { plan, contractId: IDENTITY_REVIEW_ROI_REPAIR_CONTRACT_ID, contractDigest: contract.digest };
}

/**
 * Bind the validated review object to the exact bytes it was parsed from and
 * derive findings + plan. Throws for alignment-only or sheet-level-only reviews.
 */
export function prepareIdentityReviewRoiRepair({ reviewBytes, validatedReview, failedRoles, reviewPath = "", roundIndex = 0 } = {}) {
  const bytes = Buffer.isBuffer(reviewBytes) ? reviewBytes : Buffer.from(String(reviewBytes ?? ""));
  const parsed = JSON.parse(bytes.toString("utf8"));
  if (JSON.stringify(parsed) !== JSON.stringify(validatedReview)) {
    throw new Error("The failed identity review changed after it was validated; rerun the repair.");
  }
  const failedReviewSha256 = createHash("sha256").update(bytes).digest("hex");
  const derivation = deriveIdentityReviewRoiFindings({ review: validatedReview, failedRoles });
  assertIdentityReviewRoiRepairable(derivation, { reviewPath });
  const { plan, contractId, contractDigest } = buildIdentityReviewRoiRepairPlan({
    findings: derivation.findings,
    failedReviewSha256,
    createdAt: nonEmpty(validatedReview?.reviewer?.reviewedAt),
    roundIndex,
  });
  return {
    mode: IDENTITY_REPAIR_MODES.identityReviewRoi,
    contractId,
    contractDigest,
    failedReviewSha256,
    ...derivation,
    targetCells: derivation.findings.map((entry) => entry.findingId),
    repairPlan: plan,
  };
}
