/**
 * Receipt-safe output shared by narrated-story production stages and the outer
 * narrated-story-video adapter. A stage must never mark a gate as passed
 * merely because that gate belongs to a later stage.
 */

export const NARRATED_STORY_AUDIT_IDS = Object.freeze([
  "audioIntegratedLoudness",
  "narrationBedSeparation",
  "perceptualReviewChecks",
  "duration",
  "frozenV1AndParentHashes",
  "parentAudioPcmPreserved",
  "perceptualReviewBoundToOutput",
  "perceptualEvidenceHashes",
  "contactSheetOriginalDetailReviewed",
  "pixelAudit",
  "sceneTransitionOwnedByParent",
  "audioBoundaryBreathV16",
  "noWholeProgramAcrossfade",
  "avEndSync",
]);

function text(value) {
  return typeof value === "string" ? value : "";
}

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function receiptSafeMediaJob(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return null;
  return {
    version: text(receipt.version),
    jobId: text(receipt.jobId),
    requestKey: text(receipt.requestKey),
    status: text(receipt.status),
    kind: text(receipt.kind),
    provider: text(receipt.provider),
    adapterVersion: text(receipt.adapterVersion),
    providerJobId: text(receipt.providerJobId),
    model: text(receipt.model),
    voiceId: text(receipt.voiceId),
    inputHash: text(receipt.inputHash),
    identityHash: text(receipt.identityHash),
    reservation: {
      reservationId: text(receipt.reservation?.reservationId),
      status: text(receipt.reservation?.status),
      requestedAt: text(receipt.reservation?.requestedAt),
      unit: text(receipt.reservation?.unit),
      estimatedSeconds: finite(receipt.reservation?.estimatedSeconds),
      estimatedUnits: finite(receipt.reservation?.estimatedUnits),
      estimatedCost: finite(receipt.reservation?.estimatedCost),
      currency: text(receipt.reservation?.currency),
    },
    usage: {
      seconds: finite(receipt.usage?.seconds),
      units: finite(receipt.usage?.units),
      cost: finite(receipt.usage?.cost),
      currency: text(receipt.usage?.currency),
      freeRegeneration: receipt.usage?.freeRegeneration === true,
    },
    artifact: {
      sha256: text(receipt.artifact?.sha256),
      mimeType: text(receipt.artifact?.mimeType),
      bytes: finite(receipt.artifact?.bytes),
    },
    attempts: {
      total: finite(receipt.attempts?.total) ?? 0,
      retries: Array.isArray(receipt.attempts?.retries)
        ? receipt.attempts.retries.map((retry) => ({
          operation: text(retry?.operation),
          attempt: finite(retry?.attempt),
          status: finite(retry?.status),
          backoffMs: finite(retry?.backoffMs),
        }))
        : [],
    },
    createdAt: text(receipt.createdAt),
    updatedAt: text(receipt.updatedAt),
  };
}

export function receiptSafeMediaJobs(receipts = []) {
  const seen = new Set();
  const output = [];
  for (const raw of Array.isArray(receipts) ? receipts : []) {
    const receipt = receiptSafeMediaJob(raw);
    if (!receipt) continue;
    const identity = receipt.jobId || receipt.requestKey;
    if (identity && seen.has(identity)) continue;
    if (identity) seen.add(identity);
    output.push(receipt);
  }
  return output;
}

export function pendingNarratedStoryAuditChecks(stage = "production-stage") {
  const detail = `not evaluated by ${text(stage) || "production-stage"}`;
  return Object.fromEntries(NARRATED_STORY_AUDIT_IDS.map((id) => [id, { pass: false, detail }]));
}

export function buildNarratedStoryOutcome({
  status,
  artifacts = {},
  knownRemainingIssues = [],
  mediaJobs = [],
  auditChecks = null,
  runReceiptPath = null,
  ...details
} = {}) {
  if (!text(status)) throw new Error("Narrated-story outcome requires status.");
  if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts)) {
    throw new Error("Narrated-story outcome artifacts must be an object.");
  }
  if (!Array.isArray(knownRemainingIssues)) {
    throw new Error("Narrated-story outcome knownRemainingIssues must be an array.");
  }
  return {
    ...details,
    status,
    artifacts,
    knownRemainingIssues: knownRemainingIssues.map(String),
    mediaJobs: receiptSafeMediaJobs(mediaJobs),
    auditChecks: auditChecks && typeof auditChecks === "object" && !Array.isArray(auditChecks)
      ? auditChecks
      : pendingNarratedStoryAuditChecks(status),
    runReceiptPath: text(runReceiptPath) || null,
  };
}
