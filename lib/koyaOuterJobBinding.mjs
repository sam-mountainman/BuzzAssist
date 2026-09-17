import { createHash } from "node:crypto";

export const KOYA_OUTER_JOB_BINDING_VERSION = "koya-outer-video-harness-job-binding-v2";

const SHA256 = /^[a-f0-9]{64}$/u;
const JOB_ID = /^video-koya-manga-video-[a-f0-9]{16}$/u;

const nonEmpty = (value) => typeof value === "string" && value.trim() ? value.trim() : "";
// Digest fields are accepted only in their canonical spelling. Trimming or
// lower-casing here would let an upper-cased or padded copy hash to the same
// bindingSha256 as the original, so the sealed digest could no longer tell a
// rewritten binding from the one the Job actually produced.
const canonicalSha256 = (value) => typeof value === "string" && SHA256.test(value) ? value : "";
const canonicalJobId = (value) => typeof value === "string" && JOB_ID.test(value) ? value : "";
const digest = (value) => createHash("sha256").update(String(value)).digest("hex");

function payload({ jobId, identityDigest, executionIdentityDigest, resolvedProductionContractSha256 }) {
  return {
    version: KOYA_OUTER_JOB_BINDING_VERSION,
    harnessId: "koya-manga-video",
    jobId,
    identityDigest,
    executionIdentityDigest,
    resolvedProductionContractSha256,
  };
}

/**
 * Carry the immutable outer Job identity into the Koya manifest and review
 * evidence. Revision is intentionally excluded: it changes as the durable Job
 * advances, while jobId + canonical identityDigest remain stable for the run.
 */
export function createKoyaOuterJobBinding({
  jobId,
  identityDigest,
  executionIdentityDigest,
  resolvedProductionContractSha256,
} = {}) {
  if (!nonEmpty(jobId) && !nonEmpty(identityDigest)) return null;
  const normalizedJobId = canonicalJobId(jobId);
  const normalizedIdentityDigest = canonicalSha256(identityDigest);
  const normalizedExecutionIdentityDigest = canonicalSha256(executionIdentityDigest);
  const normalizedContractSha256 = canonicalSha256(resolvedProductionContractSha256);
  if (!normalizedJobId) throw new Error("Koya outer Job id is invalid.");
  if (!normalizedIdentityDigest) throw new Error("Koya outer Job identityDigest is invalid.");
  if (!normalizedExecutionIdentityDigest) throw new Error("Koya outer Job executionIdentityDigest is invalid.");
  if (!normalizedContractSha256) throw new Error("Koya outer Job resolvedProductionContractSha256 is invalid.");
  if (!normalizedJobId.endsWith(normalizedIdentityDigest.slice(0, 16))) {
    throw new Error("Koya outer Job id is not derived from the canonical identityDigest.");
  }
  const core = payload({
    jobId: normalizedJobId,
    identityDigest: normalizedIdentityDigest,
    executionIdentityDigest: normalizedExecutionIdentityDigest,
    resolvedProductionContractSha256: normalizedContractSha256,
  });
  return Object.freeze({ ...core, bindingSha256: digest(JSON.stringify(core)) });
}

export function assertKoyaOuterJobBinding(binding, {
  required = false,
  expectedJobId = "",
  expectedIdentityDigest = "",
  expectedExecutionIdentityDigest = "",
  expectedResolvedProductionContractSha256 = "",
} = {}) {
  if (binding === null || binding === undefined) {
    if (required) throw new Error("Koya outer Job binding is required.");
    return null;
  }
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    throw new Error("Koya outer Job binding must be an object.");
  }
  const normalized = createKoyaOuterJobBinding({
    jobId: binding.jobId,
    identityDigest: binding.identityDigest,
    executionIdentityDigest: binding.executionIdentityDigest,
    resolvedProductionContractSha256: binding.resolvedProductionContractSha256,
  });
  if (binding.version !== normalized.version
    || binding.harnessId !== normalized.harnessId
    || binding.bindingSha256 !== normalized.bindingSha256) {
    throw new Error("Koya outer Job binding digest or contract is invalid.");
  }
  if (nonEmpty(expectedJobId) && normalized.jobId !== nonEmpty(expectedJobId)) {
    throw new Error("Koya outer Job binding belongs to another Job.");
  }
  if (nonEmpty(expectedIdentityDigest)
    && normalized.identityDigest !== nonEmpty(expectedIdentityDigest).toLowerCase()) {
    throw new Error("Koya outer Job binding has another canonical identityDigest.");
  }
  if (nonEmpty(expectedExecutionIdentityDigest)
    && normalized.executionIdentityDigest !== nonEmpty(expectedExecutionIdentityDigest).toLowerCase()) {
    throw new Error("Koya outer Job binding has another executionIdentityDigest.");
  }
  if (nonEmpty(expectedResolvedProductionContractSha256)
    && normalized.resolvedProductionContractSha256 !== nonEmpty(expectedResolvedProductionContractSha256).toLowerCase()) {
    throw new Error("Koya outer Job binding has another resolved production contract digest.");
  }
  return normalized;
}

export function sameKoyaOuterJobBinding(left, right) {
  try {
    const a = assertKoyaOuterJobBinding(left, { required: true });
    const b = assertKoyaOuterJobBinding(right, { required: true });
    return a.bindingSha256 === b.bindingSha256;
  } catch {
    return false;
  }
}
