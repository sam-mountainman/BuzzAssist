import { createHash } from "node:crypto";

import { canonicalJson } from "./channelPackEnvelope.mjs";

export const VIDEO_HARNESS_EXECUTION_IDENTITY_VERSION = "buzzassist-video-harness-execution-identity-v2";
export const VIDEO_HARNESS_EXECUTION_IDENTITY_NO_CHANNEL_PACK = "none";

const SHA256 = /^[a-f0-9]{64}$/u;
const JOB_ID = /^video-[a-z0-9_-]+-[a-f0-9]{16}$/u;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/**
 * Digest fields are compared byte-for-byte. A trimmed or lower-cased copy of a
 * digest is a different string; accepting it would let two spellings of one
 * identity coexist in manifests, reviews and receipts, and a reviewer could no
 * longer tell a copy from the original by equality alone.
 */
const canonicalSha256 = (value) => typeof value === "string" && SHA256.test(value) ? value : "";
const canonicalJobId = (value) => typeof value === "string" && JOB_ID.test(value) ? value : "";

/**
 * Allowlisted fields of the persisted Channel Pack verification. These are the
 * outputs of verifyChannelPackEnvelope after a trusted public key was applied,
 * so binding them anchors the execution identity to an externally signed root
 * (signer key, trusted key, signed payload manifest) rather than only to bytes
 * the local owner can rewrite together with the Job.
 */
export const VIDEO_HARNESS_EXECUTION_IDENTITY_CHANNEL_PACK_FIELDS = Object.freeze([
  "envelopeVersion",
  "id",
  "version",
  "harnessId",
  "payloadKind",
  "coreCompatibility",
  "coreVersion",
  "payloadSha256",
  "signerKeyId",
  "trustedPublicKeyId",
  "fileCount",
]);

export function resolvedProductionContractSha256(resolvedProductionContract) {
  if (!resolvedProductionContract || typeof resolvedProductionContract !== "object" || Array.isArray(resolvedProductionContract)) {
    throw new Error("resolved production contract is required for execution identity.");
  }
  return sha256(canonicalJson(resolvedProductionContract));
}

/**
 * Digest of the verified Channel Pack binding, or the explicit "none" marker
 * when the Job was planned without a Channel Pack. The marker is written into
 * the identity payload on purpose: a later Job that gains a verification can
 * never share an execution identity with one that had none.
 */
export function channelPackVerificationSha256(channelPackVerification) {
  if (channelPackVerification === null || channelPackVerification === undefined) {
    return VIDEO_HARNESS_EXECUTION_IDENTITY_NO_CHANNEL_PACK;
  }
  if (typeof channelPackVerification !== "object" || Array.isArray(channelPackVerification)) {
    throw new Error("Channel Pack verification must be an object for execution identity.");
  }
  const picked = {};
  for (const field of VIDEO_HARNESS_EXECUTION_IDENTITY_CHANNEL_PACK_FIELDS) {
    if (channelPackVerification[field] === undefined) continue;
    const value = channelPackVerification[field];
    if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
      throw new Error(`Channel Pack verification field ${field} must be a scalar for execution identity.`);
    }
    picked[field] = value;
  }
  if (Object.keys(picked).length === 0) {
    throw new Error("Channel Pack verification carries no identity field for execution identity.");
  }
  return sha256(canonicalJson(picked));
}

/**
 * Base Job identity is known before Channel Pack restore. This second immutable
 * identity is created exactly once after the effective episode contract has
 * been resolved and the Channel Pack has been verified against a trusted key,
 * and is carried through child manifests, reviews and receipts.
 *
 * Inputs and what they anchor:
 * - jobId / identityDigest: script bytes, options, Channel Pack bundle bytes,
 *   canonical core files, harness declaration, deployment and canonical Skill
 *   SHAs (all folded into identityDigest at planning time).
 * - resolvedProductionContract: the effective Koya contract including a signed
 *   episode override, fixed once after restore.
 * - channelPackVerification: the trusted-key verification result of the signed
 *   Channel Pack envelope (signer/trusted key id, signed payload manifest SHA).
 */
export function createVideoHarnessExecutionIdentityDigest({
  jobId,
  identityDigest,
  resolvedProductionContract,
  channelPackVerification = null,
} = {}) {
  const normalizedJobId = canonicalJobId(jobId);
  const normalizedIdentityDigest = canonicalSha256(identityDigest);
  if (!normalizedJobId) {
    throw new Error("video harness Job id is invalid for execution identity.");
  }
  if (!normalizedIdentityDigest || !normalizedJobId.endsWith(normalizedIdentityDigest.slice(0, 16))) {
    throw new Error("video harness base identity is invalid for execution identity.");
  }
  const contractSha256 = resolvedProductionContractSha256(resolvedProductionContract);
  const packVerificationSha256 = channelPackVerificationSha256(channelPackVerification);
  return sha256(canonicalJson({
    version: VIDEO_HARNESS_EXECUTION_IDENTITY_VERSION,
    jobId: normalizedJobId,
    identityDigest: normalizedIdentityDigest,
    resolvedProductionContractSha256: contractSha256,
    channelPackVerificationSha256: packVerificationSha256,
  }));
}

export function assertVideoHarnessExecutionIdentity(job = {}) {
  const stored = job?.executionIdentityDigest;
  if (stored === undefined || stored === null || stored === "") {
    throw new Error("Video Harness execution identity is missing from the Job.");
  }
  if (!canonicalSha256(stored)) {
    throw new Error("Video Harness execution identity is not a canonical lowercase SHA-256 digest.");
  }
  const expected = createVideoHarnessExecutionIdentityDigest({
    jobId: job.id,
    identityDigest: job.identityDigest,
    resolvedProductionContract: job.resolvedProductionContract,
    channelPackVerification: job.channelPackVerification ?? null,
  });
  if (stored !== expected) {
    throw new Error("Video Harness execution identity does not match the fixed resolved production contract and verified Channel Pack.");
  }
  return {
    executionIdentityDigest: expected,
    resolvedProductionContractSha256: resolvedProductionContractSha256(job.resolvedProductionContract),
    channelPackVerificationSha256: channelPackVerificationSha256(job.channelPackVerification ?? null),
  };
}
