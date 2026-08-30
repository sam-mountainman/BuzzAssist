// Mike-style ROI repair plans for the character sheet stage (turnarounds,
// expression cells). After a failed quality round, the retry must carry a
// machine-checkable plan: which cell, which region to repair, which regions
// to protect, and the concrete accept/reject criteria — so "fix it" never
// degrades into a blind regeneration and the next round's revisionDelta has
// verifiable content.
import { createHash } from "node:crypto";

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function normalizedRegion(region, label) {
  if (!Array.isArray(region) || region.length !== 4) {
    throw new Error(`${label} must be a normalized [x, y, w, h] rectangle.`);
  }
  const [x, y, w, h] = region.map(Number);
  if (![x, y, w, h].every(Number.isFinite) || x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1 || y + h > 1) {
    throw new Error(`${label} must stay inside 0..1 with positive size.`);
  }
  return [x, y, w, h];
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Recompute and verify a persisted plan before it is trusted by an import. */
export function verifyCharacterRepairPlanDigest(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return { valid: false, expectedDigest: "", actualDigest: "" };
  }
  const { digest: declaredDigest, ...body } = plan;
  const actualDigest = digest(body);
  return {
    valid: nonEmptyString(declaredDigest) === actualDigest,
    expectedDigest: nonEmptyString(declaredDigest),
    actualDigest,
  };
}

/**
 * Create an immutable repair plan bound to the active loop state.
 * Every entry names one cell-level defect and the exact geometry and
 * criteria of its fix; protected regions default to "everything outside the
 * repair region is protected" semantics enforced by the unintendedChange gate.
 */
export function createCharacterRepairPlan(input = {}) {
  const contract = input.contract;
  const state = input.state;
  if (!contract?.digest) throw new Error("A repair plan requires the immutable quality contract.");
  if (!state || state.contractDigest !== contract.digest) {
    throw new Error("Repair plan state must belong to the same quality contract.");
  }
  const lastRound = Array.isArray(state.rounds) ? state.rounds.at(-1) : null;
  if (!lastRound) throw new Error("A repair plan requires at least one recorded failed round.");
  if (!nonEmptyString(lastRound.failureFingerprint)) {
    throw new Error("The previous round has no failure fingerprint to repair against.");
  }
  const entries = Array.isArray(input.entries) ? input.entries : [];
  if (entries.length === 0) throw new Error("A repair plan requires at least one entry.");
  const seenFindings = new Set();
  const normalizedEntries = entries.map((entry, index) => {
    const cellId = nonEmptyString(entry?.cellId);
    const issue = nonEmptyString(entry?.issue);
    // findingId allows several distinct defects on the same cell (Codex final
    // audit); it defaults to the cellId for single-finding cells.
    const findingId = nonEmptyString(entry?.findingId) || cellId;
    if (!cellId) throw new Error(`entries[${index}].cellId is required.`);
    if (issue.length < 8) throw new Error(`entries[${index}].issue must describe the defect concretely.`);
    if (seenFindings.has(findingId)) throw new Error(`duplicate repair entry for finding ${findingId}.`);
    seenFindings.add(findingId);
    const acceptCriteria = (entry?.acceptCriteria ?? []).map(nonEmptyString).filter(Boolean);
    const rejectCriteria = (entry?.rejectCriteria ?? []).map(nonEmptyString).filter(Boolean);
    if (acceptCriteria.length === 0) throw new Error(`entries[${index}] requires at least one acceptCriteria.`);
    return {
      cellId,
      findingId,
      issue,
      repairRegion: normalizedRegion(entry?.repairRegion, `entries[${index}].repairRegion`),
      protectRegions: (entry?.protectRegions ?? []).map((region, j) =>
        normalizedRegion(region, `entries[${index}].protectRegions[${j}]`)),
      acceptCriteria,
      rejectCriteria,
    };
  });
  const body = {
    version: 1,
    contractDigest: contract.digest,
    previousFailureFingerprint: lastRound.failureFingerprint,
    roundIndex: lastRound.index,
    entries: normalizedEntries,
    createdAt: nonEmptyString(input.createdAt) || new Date().toISOString(),
  };
  for (const entry of normalizedEntries) {
    Object.freeze(entry.repairRegion);
    for (const region of entry.protectRegions) Object.freeze(region);
    Object.freeze(entry.protectRegions);
    Object.freeze(entry.acceptCriteria);
    Object.freeze(entry.rejectCriteria);
    Object.freeze(entry);
  }
  Object.freeze(normalizedEntries);
  return Object.freeze({ ...body, digest: digest(body) });
}

/** Verify that a plan addresses every failed finding before regeneration starts. */
export function verifyRepairPlanCoverage(plan, findings = []) {
  if (!plan?.digest) throw new Error("verifyRepairPlanCoverage requires a created repair plan.");
  const covered = new Set(plan.entries.flatMap((entry) => [entry.findingId, entry.cellId]));
  const missing = [];
  for (const finding of findings) {
    const findingId = nonEmptyString(finding?.findingId ?? finding?.cellId ?? finding);
    if (findingId && !covered.has(findingId)) missing.push(findingId);
  }
  return { complete: missing.length === 0, missing };
}

/**
 * Express a plan as the revisionDelta + unintendedChange checks for the next
 * round: each entry becomes one allowed region; everything else must not move.
 */
export function repairPlanToNextRound(plan, { imageByCell = {}, baseByCell = {} } = {}) {
  if (!plan?.digest) throw new Error("repairPlanToNextRound requires a created repair plan.");
  const revisionDelta = plan.entries
    .map((entry) => `${entry.cellId}: ${entry.issue} -> repair ${JSON.stringify(entry.repairRegion)}`)
    .join("; ");
  const unintendedChangeChecks = plan.entries.map((entry) => {
    const image = imageByCell[entry.cellId];
    const base = baseByCell[entry.cellId];
    if (!image || !base) {
      // A plan entry without its image/base pair must stop the round: an
      // unmapped cell would silently escape the off-spec-change audit.
      throw new Error(`repair entry ${entry.findingId} has no image/base mapping for cell ${entry.cellId}.`);
    }
    return {
      id: `repair-${entry.findingId}`,
      type: "unintendedChange",
      image,
      base,
      allowedRegions: [entry.repairRegion],
    };
  });
  return {
    previousFailureFingerprint: plan.previousFailureFingerprint,
    revisionDelta,
    repairPlanDigest: plan.digest,
    unintendedChangeChecks,
  };
}
