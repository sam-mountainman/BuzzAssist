// BuzzAssist管理側で、運営者端末から返る署名feedback bundleを受ける境界。
//
// upload tokenだけを信頼せず、事前登録したoperator公開鍵でbundle署名を検証する。
// 検証済みbundleも即座にSkillへ反映せずquarantine/curationへ置き、ownerの
// 明示承認後にだけread-only curatorが読めるobservationへ昇格する。

import { createHash, createPublicKey, timingSafeEqual } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { withCanvasFileLock } from "./canvasFileLock.mjs";
import { readJsonIfExists, writeJsonAtomic } from "./atomicJsonFile.mjs";
import { canonicalJson, publicKeyId } from "./channelPackEnvelope.mjs";
import {
  HARNESS_FEEDBACK_MAX_BUNDLE_BYTES,
  HARNESS_FEEDBACK_PUBLIC_CATALOG_PATH,
  normalizeHarnessFeedbackBuild,
  parseHarnessFeedbackProposalCatalog,
  verifyHarnessFeedbackBundle,
} from "./harnessFeedbackBundle.mjs";

export const HARNESS_FEEDBACK_OPERATOR_REGISTRY_VERSION = "buzzassist-feedback-operator-registry-v2";
export const HARNESS_FEEDBACK_INGEST_RECEIPT_VERSION = "buzzassist-feedback-ingest-receipt-v1";
export const HARNESS_FEEDBACK_CURATION_CANDIDATE_VERSION = "buzzassist-feedback-curation-candidate-v1";
export const HARNESS_FEEDBACK_OWNER_DECISION_VERSION = "buzzassist-feedback-owner-decision-v1";
export const HARNESS_FEEDBACK_APPROVED_IMPORT_VERSION = "buzzassist-feedback-approved-observations-v1";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const SHA256 = /^(?:sha256:)?[a-f0-9]{64}$/u;
const DEFAULT_MAX_BUNDLE_BYTES = HARNESS_FEEDBACK_MAX_BUNDLE_BYTES;
// 既定catalogは配布物に同梱する公開版（id/kind/targetのみ）。本文つきの共有
// ledger（docs/learning/proposals.jsonl）は運営者名・顧客pathを含みうるので
// 配布せず、管理側がownerのcheckoutで --proposal-catalog に指定したときだけ読む。
const DEFAULT_PROPOSAL_CATALOG_PATH = HARNESS_FEEDBACK_PUBLIC_CATALOG_PATH;

export class HarnessFeedbackIngestError extends Error {
  constructor(message, { code = "FEEDBACK_INGEST_INVALID", statusCode = 400 } = {}) {
    super(message);
    this.name = "HarnessFeedbackIngestError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function cleanId(value, label) {
  const text = nonEmpty(value);
  if (!ID.test(text)) throw new HarnessFeedbackIngestError(`${label}が不正。`);
  return text;
}

function cleanSha(value, label) {
  const text = nonEmpty(value).replace(/^sha256:/u, "").toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(text)) throw new HarnessFeedbackIngestError(`${label}はSHA-256であること。`);
  return text;
}

function cleanTimestamp(value, label) {
  const text = nonEmpty(value);
  if (!Number.isFinite(Date.parse(text))) throw new HarnessFeedbackIngestError(`${label}が不正。`);
  return text;
}

function ingestPaths(rootDir) {
  const root = resolve(nonEmpty(rootDir));
  if (!nonEmpty(rootDir)) throw new HarnessFeedbackIngestError("feedback ingest rootDirが要る。");
  return {
    root,
    registry: join(root, "operator-registry.json"),
    lock: join(root, "ingest-state.json"),
    accepted: join(root, "accepted"),
    quarantine: join(root, "quarantine"),
    receipts: join(root, "receipts"),
    sources: join(root, "sources"),
    curation: join(root, "curation"),
    decisions: join(root, "decisions"),
    imports: join(root, "imports"),
  };
}

function emptyRegistry() {
  return {
    version: HARNESS_FEEDBACK_OPERATOR_REGISTRY_VERSION,
    revision: 0,
    operators: [],
  };
}

function normalizeAllowedBuilds(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) {
    throw new HarnessFeedbackIngestError("allowedBuildsは1..128件のrelease tuple arrayであること。");
  }
  const normalized = value.map((build) => normalizeHarnessFeedbackBuild(build));
  return [...new Map(normalized.map((build) => [canonicalJson(build), build])).values()]
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

function harnessIdsForBuilds(builds) {
  return [...new Set(builds.map((build) => build.harnessId))].sort();
}

function operatorAllowsBuild(operator, build) {
  const expected = canonicalJson(normalizeHarnessFeedbackBuild(build));
  return operator.allowedBuilds.some((candidate) => canonicalJson(candidate) === expected);
}

function validateRegistry(value) {
  if (!value || value.version !== HARNESS_FEEDBACK_OPERATOR_REGISTRY_VERSION
    || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !Array.isArray(value.operators)) {
    throw new HarnessFeedbackIngestError("operator registryが壊れている。", {
      code: "FEEDBACK_OPERATOR_REGISTRY_INVALID",
      statusCode: 500,
    });
  }
  try {
    const seenKeys = new Set();
    const activeOperators = new Set();
    for (const entry of value.operators) {
      const operatorId = cleanId(entry?.operatorId, "registry.operatorId");
      const keyId = cleanId(entry?.keyId, "registry.keyId");
      if (seenKeys.has(keyId)) throw new Error("operator key IDが重複している。");
      seenKeys.add(keyId);
      if (entry.algorithm !== "Ed25519") throw new Error("operator algorithmが不正。");
      const key = createPublicKey(nonEmpty(entry.publicKeyPem));
      if (key.asymmetricKeyType !== "ed25519" || publicKeyId(key) !== keyId) {
        throw new Error("operator公開鍵とkey IDが一致しない。");
      }
      const builds = normalizeAllowedBuilds(entry.allowedBuilds);
      if (canonicalJson(builds) !== canonicalJson(entry.allowedBuilds)) throw new Error("allowedBuildsがcanonicalではない。");
      const harnessIds = harnessIdsForBuilds(builds);
      if (canonicalJson(harnessIds) !== canonicalJson(entry.allowedHarnessIds)) throw new Error("allowedHarnessIdsがallowedBuildsと一致しない。");
      if (!['active', 'revoked'].includes(entry.status)) throw new Error("operator statusが不正。");
      cleanTimestamp(entry.enrolledAt, "registry.enrolledAt");
      cleanId(entry.approvedBy, "registry.approvedBy");
      if (entry.status === "active") {
        if (activeOperators.has(operatorId)) throw new Error("operatorにactive keyが複数ある。");
        activeOperators.add(operatorId);
      } else {
        cleanTimestamp(entry.revokedAt, "registry.revokedAt");
        cleanId(entry.revokedBy, "registry.revokedBy");
        if (nonEmpty(entry.revokeReason).length < 8) throw new Error("revoke reasonが不正。");
      }
    }
  } catch (error) {
    if (error instanceof HarnessFeedbackIngestError && error.code === "FEEDBACK_OPERATOR_REGISTRY_INVALID") throw error;
    throw new HarnessFeedbackIngestError(`operator registryが壊れている: ${error?.message || error}`, {
      code: "FEEDBACK_OPERATOR_REGISTRY_INVALID",
      statusCode: 500,
    });
  }
  return value;
}

/** Local owner action. Enrollment is deliberately not exposed by the upload API. */
export async function enrollHarnessFeedbackOperator({
  rootDir,
  operatorId,
  publicKeyPem,
  allowedBuilds,
  allowedHarnessIds,
  approvedBy,
  enrolledAt = new Date().toISOString(),
} = {}) {
  const paths = ingestPaths(rootDir);
  const normalizedOperatorId = cleanId(operatorId, "operatorId");
  const owner = cleanId(approvedBy, "approvedBy");
  const key = createPublicKey(nonEmpty(publicKeyPem));
  if (key.asymmetricKeyType !== "ed25519") throw new HarnessFeedbackIngestError("operator公開鍵はEd25519であること。");
  const keyId = publicKeyId(key);
  const builds = normalizeAllowedBuilds(allowedBuilds);
  const harnessIds = harnessIdsForBuilds(builds);
  if (Array.isArray(allowedHarnessIds)) {
    const requestedHarnessIds = [...new Set(allowedHarnessIds.map((value) => cleanId(value, "allowedHarnessId")))].sort();
    if (canonicalJson(requestedHarnessIds) !== canonicalJson(harnessIds)) {
      throw new HarnessFeedbackIngestError("allowedHarnessIdsはallowedBuildsから導出したscopeと一致すること。");
    }
  }
  const timestamp = cleanTimestamp(enrolledAt, "enrolledAt");
  return withCanvasFileLock(paths.lock, async () => {
    const registry = validateRegistry(await readJsonIfExists(paths.registry, emptyRegistry()));
    const sameKey = registry.operators.find((entry) => entry.keyId === keyId);
    if (sameKey) {
      const exact = sameKey.operatorId === normalizedOperatorId
        && sameKey.status === "active"
        && canonicalJson(sameKey.allowedHarnessIds) === canonicalJson(harnessIds)
        && canonicalJson(sameKey.allowedBuilds) === canonicalJson(builds);
      if (!exact) {
        throw new HarnessFeedbackIngestError("同じ公開鍵が別operatorまたは別権限で登録済み。鍵rotationとして明示的に登録し直すこと。", {
          code: "FEEDBACK_OPERATOR_KEY_CONFLICT",
          statusCode: 409,
        });
      }
      return { ok: true, attached: true, operator: sameKey };
    }
    const sameOperator = registry.operators.find((entry) => entry.operatorId === normalizedOperatorId && entry.status === "active");
    if (sameOperator) {
      throw new HarnessFeedbackIngestError("operatorには既にactive keyがある。既存鍵を失効してからrotationすること。", {
        code: "FEEDBACK_OPERATOR_ALREADY_ENROLLED",
        statusCode: 409,
      });
    }
    const record = {
      operatorId: normalizedOperatorId,
      keyId,
      algorithm: "Ed25519",
      publicKeyPem: key.export({ type: "spki", format: "pem" }).toString(),
      allowedHarnessIds: harnessIds,
      allowedBuilds: builds,
      status: "active",
      enrolledAt: timestamp,
      approvedBy: owner,
    };
    registry.revision += 1;
    registry.operators.push(record);
    registry.operators.sort((left, right) => left.operatorId.localeCompare(right.operatorId));
    await writeJsonAtomic(paths.registry, registry);
    return { ok: true, attached: false, operator: record };
  });
}

/** Revoke first; a subsequent enroll with the same operatorId is key rotation. */
export async function revokeHarnessFeedbackOperator({
  rootDir,
  operatorId,
  keyId = "",
  revokedBy,
  reason,
  revokedAt = new Date().toISOString(),
} = {}) {
  const paths = ingestPaths(rootDir);
  const normalizedOperatorId = cleanId(operatorId, "operatorId");
  const expectedKeyId = nonEmpty(keyId);
  const owner = cleanId(revokedBy, "revokedBy");
  const explanation = nonEmpty(reason);
  if (explanation.length < 8 || explanation.length > 1000) {
    throw new HarnessFeedbackIngestError("revoke reasonは8..1000文字であること。");
  }
  const timestamp = cleanTimestamp(revokedAt, "revokedAt");
  return withCanvasFileLock(paths.lock, async () => {
    const registry = validateRegistry(await readJsonIfExists(paths.registry, emptyRegistry()));
    const operatorIndexes = registry.operators
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.operatorId === normalizedOperatorId
        && (!expectedKeyId || entry.keyId === expectedKeyId));
    let selected;
    if (expectedKeyId) {
      if (operatorIndexes.length > 1) {
        throw new HarnessFeedbackIngestError("同じoperator/key IDがregistry内で重複している。", {
          code: "FEEDBACK_OPERATOR_REGISTRY_INVALID",
          statusCode: 500,
        });
      }
      [selected] = operatorIndexes;
    } else {
      const active = operatorIndexes.filter(({ entry }) => entry.status === "active");
      if (active.length > 1) {
        throw new HarnessFeedbackIngestError("operatorにactive keyが複数あるため失効対象を決められない。", {
          code: "FEEDBACK_OPERATOR_REGISTRY_INVALID",
          statusCode: 500,
        });
      }
      if (active.length === 1) [selected] = active;
      else if (operatorIndexes.length === 1 && operatorIndexes[0].entry.status === "revoked") [selected] = operatorIndexes;
      else if (operatorIndexes.length > 1) {
        throw new HarnessFeedbackIngestError("active keyが無く履歴が複数ある。--key-idで失効済み対象を明示すること。", {
          code: "FEEDBACK_OPERATOR_REVOKE_AMBIGUOUS",
          statusCode: 409,
        });
      }
    }
    if (!selected) {
      throw new HarnessFeedbackIngestError("失効対象operator keyが無い。", {
        code: "FEEDBACK_OPERATOR_NOT_FOUND",
        statusCode: 404,
      });
    }
    const { index } = selected;
    const current = registry.operators[index];
    if (current.status === "revoked") return { ok: true, attached: true, operator: current };
    if (current.status !== "active") throw new HarnessFeedbackIngestError("operator key statusが不正。", { statusCode: 500 });
    const revoked = {
      ...current,
      status: "revoked",
      revokedAt: timestamp,
      revokedBy: owner,
      revokeReason: explanation,
    };
    registry.operators[index] = revoked;
    registry.revision += 1;
    await writeJsonAtomic(paths.registry, registry);
    return { ok: true, attached: false, operator: revoked };
  });
}

function safeFailureMetadata(bundle, requestSha256, error, receivedAt) {
  return {
    version: "buzzassist-feedback-quarantine-failure-v1",
    receivedAt,
    requestSha256,
    signerKeyId: nonEmpty(bundle?.signer?.keyId).slice(0, 200),
    sourceHost: nonEmpty(bundle?.sourceHost).slice(0, 200),
    harnessId: nonEmpty(bundle?.build?.harnessId).slice(0, 200),
    sourceReportSha256: SHA256.test(nonEmpty(bundle?.sourceReportSha256))
      ? nonEmpty(bundle.sourceReportSha256).replace(/^sha256:/u, "")
      : "",
    errorCode: nonEmpty(error?.code) || "FEEDBACK_INGEST_INVALID",
    error: String(error?.message || error).slice(0, 1000),
    rawBundleStored: false,
  };
}

async function quarantineFailure(paths, bundle, requestSha256, error, receivedAt) {
  const suffix = `${receivedAt.replace(/[^0-9]/gu, "").slice(0, 14)}-${requestSha256}`;
  await writeJsonAtomic(join(paths.quarantine, `rejected-${suffix}.json`),
    safeFailureMetadata(bundle, requestSha256, error, receivedAt));
}

function sourceReplayKey(bundle, operator) {
  return sha256(canonicalJson({
    operatorId: operator.operatorId,
    harnessId: bundle.build.harnessId,
    sourceReportSha256: bundle.sourceReportSha256,
  }));
}

async function loadKnownProposalCatalog(filePath = DEFAULT_PROPOSAL_CATALOG_PATH) {
  let text;
  try { text = await readFile(resolve(filePath), "utf8"); }
  catch (error) { throw storageIntegrityError(`proposal catalogを読めない: ${error?.code || error?.message || error}`); }
  try { return parseHarnessFeedbackProposalCatalog(text); }
  catch (error) { throw storageIntegrityError(error?.message || String(error)); }
}

async function assertKnownProposalSemantics(bundle, proposalCatalogPath) {
  const catalog = await loadKnownProposalCatalog(proposalCatalogPath);
  for (const proposal of bundle.proposals || []) {
    const expected = catalog.get(proposal.id);
    if (!expected) {
      throw new HarnessFeedbackIngestError(`未知のproposal IDは管理側へ取り込めない: ${proposal.id}`, {
        code: "FEEDBACK_PROPOSAL_NOT_REGISTERED",
        statusCode: 422,
      });
    }
    if (proposal.kind !== expected.kind || proposal.target !== expected.target) {
      throw new HarnessFeedbackIngestError(`proposal IDのkind/targetが管理側catalogと一致しない: ${proposal.id}`, {
        code: "FEEDBACK_PROPOSAL_SEMANTIC_MISMATCH",
        statusCode: 422,
      });
    }
  }
}

function curationCandidate(bundle, { operator, bundleDigest, requestSha256, sourceKey, receivedAt }) {
  return {
    version: HARNESS_FEEDBACK_CURATION_CANDIDATE_VERSION,
    status: "verified-quarantine",
    receivedAt,
    bundleDigest,
    requestSha256,
    sourceReplayKey: sourceKey,
    operator: { operatorId: operator.operatorId, signerKeyId: operator.keyId },
    source: {
      host: bundle.sourceHost,
      reportSha256: bundle.sourceReportSha256,
      generatedAt: bundle.generatedAt,
    },
    build: structuredClone(bundle.build),
    proposals: structuredClone(bundle.proposals),
    observedGates: structuredClone(bundle.observedGates),
    privacy: structuredClone(bundle.privacy),
    ownerApprovalRequired: true,
    writesCanonical: false,
  };
}

function ingestReceiptFor(bundle, {
  operator,
  bundleDigest,
  requestSha256,
  sourceKey,
  receivedAt,
  candidateDigest,
  paths,
}) {
  return {
    version: HARNESS_FEEDBACK_INGEST_RECEIPT_VERSION,
    ok: true,
    duplicate: false,
    status: "verified-quarantine",
    receivedAt,
    bundleDigest,
    requestSha256,
    sourceReplayKey: sourceKey,
    operatorId: operator.operatorId,
    signerKeyId: operator.keyId,
    harnessId: bundle.build.harnessId,
    sourceReportSha256: bundle.sourceReportSha256,
    candidateDigest,
    acceptedPath: join(paths.accepted, `${bundleDigest}.json`),
    candidatePath: join(paths.curation, `${bundleDigest}.json`),
    ownerApprovalRequired: true,
  };
}

function sourceIndexFor(bundle, operator, sourceKey, bundleDigest) {
  return {
    version: "buzzassist-feedback-source-index-v2",
    sourceReplayKey: sourceKey,
    bundleDigest,
    operatorId: operator.operatorId,
    signerKeyId: operator.keyId,
    harnessId: bundle.build.harnessId,
    sourceReportSha256: bundle.sourceReportSha256,
  };
}

function storageIntegrityError(message) {
  return new HarnessFeedbackIngestError(message, {
    code: "FEEDBACK_INGEST_STORAGE_TAMPER",
    statusCode: 500,
  });
}

function assertCanonicalEqual(actual, expected, message) {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw storageIntegrityError(message);
}

/**
 * Verify, deduplicate and quarantine one upload. Invalid uploads keep metadata
 * only; verified bundle bytes are retained because their schema forbids raw
 * scripts, Channel Pack payloads, provider responses and credentials.
 */
export async function ingestHarnessFeedbackBundle({
  rootDir,
  bundle,
  bundleBytes = null,
  receivedAt = new Date().toISOString(),
  maxBundleBytes = DEFAULT_MAX_BUNDLE_BYTES,
  proposalCatalogPath = DEFAULT_PROPOSAL_CATALOG_PATH,
  afterSignatureVerified = null,
} = {}) {
  const paths = ingestPaths(rootDir);
  const timestamp = cleanTimestamp(receivedAt, "receivedAt");
  const raw = bundleBytes === null
    ? Buffer.from(JSON.stringify(bundle ?? null))
    : Buffer.from(bundleBytes);
  const requestSha256 = sha256(raw);
  if (raw.length === 0 || raw.length > maxBundleBytes) {
    const error = new HarnessFeedbackIngestError(`feedback bundleは1..${maxBundleBytes} bytesであること。`, {
      code: "FEEDBACK_BUNDLE_SIZE_INVALID",
      statusCode: 413,
    });
    await quarantineFailure(paths, bundle, requestSha256, error, timestamp);
    throw error;
  }
  try {
    if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
      throw new HarnessFeedbackIngestError("feedback bundleはJSON objectであること。");
    }
    const registry = validateRegistry(await readJsonIfExists(paths.registry, emptyRegistry()));
    const signerKeyId = cleanId(bundle?.signer?.keyId, "signer.keyId");
    const operator = registry.operators.find((entry) => entry.keyId === signerKeyId && entry.status === "active");
    if (!operator) {
      throw new HarnessFeedbackIngestError("未登録または失効済みのfeedback signer。", {
        code: "FEEDBACK_SIGNER_NOT_ENROLLED",
        statusCode: 403,
      });
    }
    const harnessId = cleanId(bundle?.build?.harnessId, "build.harnessId");
    if (!operator.allowedHarnessIds.includes(harnessId)) {
      throw new HarnessFeedbackIngestError("operatorにこのHarnessのupload権限が無い。", {
        code: "FEEDBACK_HARNESS_NOT_ALLOWED",
        statusCode: 403,
      });
    }
    await verifyHarnessFeedbackBundle({
      bundle,
      trustedPublicKeyPem: operator.publicKeyPem,
      expectedHarnessId: harnessId,
    });
    const verifiedBuild = normalizeHarnessFeedbackBuild(bundle.build);
    if (!operatorAllowsBuild(operator, verifiedBuild)) {
      throw new HarnessFeedbackIngestError("operatorへ登録されたrelease tupleとfeedback buildが一致しない。", {
        code: "FEEDBACK_BUILD_NOT_ALLOWED",
        statusCode: 403,
      });
    }
    if (typeof afterSignatureVerified === "function") await afterSignatureVerified();
    const bundleDigest = sha256(canonicalJson(bundle));
    const sourceKey = sourceReplayKey(bundle, operator);
    return await withCanvasFileLock(paths.lock, async () => {
      // Revoke/rotationとingestのlinearization point。署名検証中に鍵が失効した
      // 場合、lock取得後のactive registryを再確認して保存を許可しない。
      const lockedRegistry = validateRegistry(await readJsonIfExists(paths.registry, emptyRegistry()));
      const lockedOperator = lockedRegistry.operators.find((entry) => entry.keyId === signerKeyId && entry.status === "active");
      if (!lockedOperator
        || lockedOperator.operatorId !== operator.operatorId
        || lockedOperator.publicKeyPem !== operator.publicKeyPem
        || canonicalJson(lockedOperator.allowedHarnessIds) !== canonicalJson(operator.allowedHarnessIds)
        || canonicalJson(lockedOperator.allowedBuilds) !== canonicalJson(operator.allowedBuilds)
        || !lockedOperator.allowedHarnessIds.includes(harnessId)
        || !operatorAllowsBuild(lockedOperator, verifiedBuild)) {
        throw new HarnessFeedbackIngestError("署名検証中にoperator権限または鍵状態が変わった。", {
          code: "FEEDBACK_SIGNER_NOT_ENROLLED",
          statusCode: 403,
        });
      }
      await assertKnownProposalSemantics(bundle, proposalCatalogPath);
      const receiptPath = join(paths.receipts, `${bundleDigest}.json`);
      const existingReceipt = await readJsonIfExists(receiptPath, null);
      if (existingReceipt) {
        const expectedCandidate = curationCandidate(bundle, {
          operator,
          bundleDigest,
          requestSha256: existingReceipt.requestSha256,
          sourceKey,
          receivedAt: existingReceipt.receivedAt,
        });
        const expectedCandidateDigest = sha256(canonicalJson(expectedCandidate));
        const expectedReceipt = ingestReceiptFor(bundle, {
          operator,
          bundleDigest,
          requestSha256: existingReceipt.requestSha256,
          sourceKey,
          receivedAt: existingReceipt.receivedAt,
          candidateDigest: expectedCandidateDigest,
          paths,
        });
        assertCanonicalEqual(existingReceipt, expectedReceipt, "ingest receiptが保存後に改変された。");
        const acceptedPath = expectedReceipt.acceptedPath;
        const candidatePath = expectedReceipt.candidatePath;
        const sourcePath = join(paths.sources, `${sourceKey}.json`);
        const [storedBundle, storedCandidate, storedSource] = await Promise.all([
          readJsonIfExists(acceptedPath, null),
          readJsonIfExists(candidatePath, null),
          readJsonIfExists(sourcePath, null),
        ]);
        if (storedBundle) assertCanonicalEqual(storedBundle, bundle, "accepted signed bundleが保存後に改変された。");
        else await writeJsonAtomic(acceptedPath, bundle);
        if (storedCandidate) assertCanonicalEqual(storedCandidate, expectedCandidate, "curation candidateが保存後に改変された。");
        else await writeJsonAtomic(candidatePath, expectedCandidate);
        const expectedSource = sourceIndexFor(bundle, operator, sourceKey, bundleDigest);
        if (storedSource) assertCanonicalEqual(storedSource, expectedSource, "feedback source indexが保存後に改変された。");
        else await writeJsonAtomic(sourcePath, expectedSource);
        return { ...existingReceipt, duplicate: true };
      }

      const sourcePath = join(paths.sources, `${sourceKey}.json`);
      const existingSource = await readJsonIfExists(sourcePath, null);
      if (existingSource && existingSource.bundleDigest !== bundleDigest) {
        throw new HarnessFeedbackIngestError("同じsigner/source reportが異なるbundleとして再送された。replay conflictとして隔離する。", {
          code: "FEEDBACK_SOURCE_REPLAY_CONFLICT",
          statusCode: 409,
        });
      }

      const candidate = curationCandidate(bundle, {
        operator,
        bundleDigest,
        requestSha256,
        sourceKey,
        receivedAt: timestamp,
      });
      const candidateDigest = sha256(canonicalJson(candidate));
      const candidatePath = join(paths.curation, `${bundleDigest}.json`);
      const acceptedPath = join(paths.accepted, `${bundleDigest}.json`);
      const receipt = ingestReceiptFor(bundle, {
        operator,
        bundleDigest,
        requestSha256,
        sourceKey,
        receivedAt: timestamp,
        candidateDigest,
        paths,
      });
      await writeJsonAtomic(acceptedPath, bundle);
      await writeJsonAtomic(candidatePath, candidate);
      await writeJsonAtomic(sourcePath, sourceIndexFor(bundle, operator, sourceKey, bundleDigest));
      await writeJsonAtomic(receiptPath, receipt);
      return receipt;
    });
  } catch (error) {
    await quarantineFailure(paths, bundle, requestSha256, error, timestamp);
    throw error;
  }
}

async function loadVerifiedCandidateChain(paths, digest) {
  const [accepted, receipt, candidate, registry] = await Promise.all([
    readJsonIfExists(join(paths.accepted, `${digest}.json`), null),
    readJsonIfExists(join(paths.receipts, `${digest}.json`), null),
    readJsonIfExists(join(paths.curation, `${digest}.json`), null),
    readJsonIfExists(paths.registry, emptyRegistry()).then(validateRegistry),
  ]);
  if (!accepted || sha256(canonicalJson(accepted)) !== digest) {
    throw storageIntegrityError("owner decisionのaccepted signed bundleが欠落または改変されている。");
  }
  const operator = registry.operators.find((entry) => entry.keyId === accepted?.signer?.keyId);
  if (!operator) throw storageIntegrityError("accepted bundleのoperator keyがregistryに無い。");
  await verifyHarnessFeedbackBundle({
    bundle: accepted,
    trustedPublicKeyPem: operator.publicKeyPem,
    expectedHarnessId: accepted?.build?.harnessId,
  });
  if (!receipt || receipt.version !== HARNESS_FEEDBACK_INGEST_RECEIPT_VERSION) {
    throw storageIntegrityError("owner decisionのingest receiptが欠落または不正。");
  }
  const sourceKey = sourceReplayKey(accepted, operator);
  const expectedCandidate = curationCandidate(accepted, {
    operator,
    bundleDigest: digest,
    requestSha256: receipt.requestSha256,
    sourceKey,
    receivedAt: receipt.receivedAt,
  });
  const candidateDigest = sha256(canonicalJson(expectedCandidate));
  const expectedReceipt = ingestReceiptFor(accepted, {
    operator,
    bundleDigest: digest,
    requestSha256: receipt.requestSha256,
    sourceKey,
    receivedAt: receipt.receivedAt,
    candidateDigest,
    paths,
  });
  assertCanonicalEqual(receipt, expectedReceipt, "ingest receiptがsigned bundle/candidateと一致しない。");
  if (!candidate) throw storageIntegrityError("verified curation candidateが欠落している。");
  assertCanonicalEqual(candidate, expectedCandidate, "verified curation candidateがsigned bundle/receiptと一致しない。");
  const source = await readJsonIfExists(join(paths.sources, `${sourceKey}.json`), null);
  assertCanonicalEqual(source, sourceIndexFor(accepted, operator, sourceKey, digest),
    "feedback source indexがsigned bundleと一致しない。");
  return { accepted, receipt, candidate, candidateDigest, operator };
}

/**
 * 登録簿上の鍵状態を、bundleへ結合してよい最小情報に絞る。公開鍵PEMや
 * allowedBuildsは載せない（分離記録から再集計・再承認の入口を作らないため）。
 */
function signerStateOf(operator) {
  return operator.status === "active"
    ? { keyId: operator.keyId, status: "active" }
    : {
      keyId: operator.keyId,
      status: "revoked",
      revokedAt: operator.revokedAt,
      revokedBy: operator.revokedBy,
    };
}

/**
 * 失効した鍵の署名は、ingest済み・approve済みを問わず後から信用しない。
 * ownerの例外承認経路は意図的に用意しない（失効鍵の署名を後から信用しない原則）。
 */
function assertSignerStillActive(operator, action) {
  if (operator.status === "active") return;
  throw new HarnessFeedbackIngestError(
    `署名鍵 ${operator.keyId} は ${operator.revokedAt} に失効している。${action}できない。`,
    { code: "FEEDBACK_SIGNER_REVOKED", statusCode: 403 },
  );
}

function ownerDecisionFor({ digest, candidateDigest, decision, owner, reason, decidedAt }) {
  return {
    version: HARNESS_FEEDBACK_OWNER_DECISION_VERSION,
    bundleDigest: digest,
    candidateDigest,
    decision,
    approvedBy: owner,
    reason,
    decidedAt,
    writesCanonical: false,
  };
}

function validateOwnerDecision(value, { digest, candidateDigest, requireApproved = false } = {}) {
  const expectedKeys = [
    "approvedBy", "bundleDigest", "candidateDigest", "decidedAt", "decision",
    "reason", "version", "writesCanonical",
  ];
  if (!value || Object.keys(value).sort().join("\u001f") !== expectedKeys.sort().join("\u001f")
    || value.version !== HARNESS_FEEDBACK_OWNER_DECISION_VERSION
    || value.bundleDigest !== digest
    || value.candidateDigest !== candidateDigest
    || !["approve", "reject"].includes(value.decision)
    || (requireApproved && value.decision !== "approve")
    || !ID.test(nonEmpty(value.approvedBy))
    || nonEmpty(value.reason).length < 8 || nonEmpty(value.reason).length > 1000
    || !Number.isFinite(Date.parse(nonEmpty(value.decidedAt)))
    || value.writesCanonical !== false) {
    throw storageIntegrityError("owner decisionがcandidateへ正しく結合されていない。");
  }
  return value;
}

function approvedImportFor(candidate, ownerDecision) {
  return {
    version: HARNESS_FEEDBACK_APPROVED_IMPORT_VERSION,
    bundleDigest: candidate.bundleDigest,
    candidateDigest: ownerDecision.candidateDigest,
    approvedBy: ownerDecision.approvedBy,
    approvedAt: ownerDecision.decidedAt,
    operator: candidate.operator,
    source: candidate.source,
    build: candidate.build,
    proposalObservations: candidate.proposals.map((proposal) => ({
      proposalId: proposal.id,
      kind: proposal.kind,
      target: proposal.target,
      occurrences: proposal.occurrences,
      occurrenceDigests: proposal.occurrenceDigests,
      evidenceDigests: proposal.evidenceDigests,
    })),
    gateObservations: candidate.observedGates,
    writesCanonical: false,
  };
}

async function ensureApprovedImport(paths, candidate, ownerDecision) {
  const importPath = join(paths.imports, `${candidate.bundleDigest}.json`);
  const expectedImport = approvedImportFor(candidate, ownerDecision);
  const existingImport = await readJsonIfExists(importPath, null);
  if (existingImport) assertCanonicalEqual(existingImport, expectedImport, "approved curator importがowner decision/candidateと一致しない。");
  else await writeJsonAtomic(importPath, expectedImport);
  return expectedImport;
}

export async function decideHarnessFeedbackBundle({
  rootDir,
  bundleDigest,
  decision,
  approvedBy,
  reason,
  decidedAt = new Date().toISOString(),
} = {}) {
  const paths = ingestPaths(rootDir);
  const digest = cleanSha(bundleDigest, "bundleDigest");
  const owner = cleanId(approvedBy, "approvedBy");
  const normalizedDecision = nonEmpty(decision);
  if (!new Set(["approve", "reject"]).has(normalizedDecision)) {
    throw new HarnessFeedbackIngestError("decisionはapproveまたはrejectであること。");
  }
  const explanation = nonEmpty(reason);
  if (explanation.length < 8 || explanation.length > 1000) {
    throw new HarnessFeedbackIngestError("owner decision reasonは8..1000文字であること。");
  }
  const timestamp = cleanTimestamp(decidedAt, "decidedAt");
  return withCanvasFileLock(paths.lock, async () => {
    const { candidate, candidateDigest, operator } = await loadVerifiedCandidateChain(paths, digest);
    // 失効伝播: lock内でregistryの現在状態を見る。verified-quarantineに入った後で
    // 鍵が失効していればapproveを拒否し、approve済みの再接続（import修復）も
    // 行わない。rejectは無害な向きなので失効後も記録できる。
    if (normalizedDecision === "approve") assertSignerStillActive(operator, "owner approve");
    const decisionPath = join(paths.decisions, `${digest}.json`);
    const existing = await readJsonIfExists(decisionPath, null);
    if (existing) {
      validateOwnerDecision(existing, { digest, candidateDigest });
      if (existing.decision !== normalizedDecision
        || existing.approvedBy !== owner
        || existing.reason !== explanation) {
        throw new HarnessFeedbackIngestError("既存owner decisionと競合する。上書きしない。", {
          code: "FEEDBACK_OWNER_DECISION_CONFLICT",
          statusCode: 409,
        });
      }
      if (existing.decision === "approve") await ensureApprovedImport(paths, candidate, existing);
      else if (await readJsonIfExists(join(paths.imports, `${digest}.json`), null)) {
        throw storageIntegrityError("reject済みcandidateにapproved importが存在する。");
      }
      return { ...existing, attached: true };
    }
    const ownerDecision = ownerDecisionFor({
      digest,
      candidateDigest,
      decision: normalizedDecision,
      owner,
      reason: explanation,
      decidedAt: timestamp,
    });
    await writeJsonAtomic(decisionPath, ownerDecision);
    if (normalizedDecision === "approve") await ensureApprovedImport(paths, candidate, ownerDecision);
    return { ...ownerDecision, attached: false };
  });
}

/**
 * approve済みimportを、署名鍵の現在状態で2つに分ける。
 *
 * - `approved`: 署名chainが正しく、鍵が今もactiveなもの。curator観測へ数えてよい
 * - `revokedAfterApproval`: approve当時は正しかったが鍵が後に失効したもの。
 *   観測本体（proposalObservations/gateObservations）は載せず、bundleDigestと
 *   鍵の失効情報だけを残す。owner承認をやり直しても復活しない
 *
 * lock内で読む。revoke → import読込の順序が入れ替わって失効鍵の観測が1回だけ
 * 数えられる窓を残さないため（ingest/approveと同じlinearization point）。
 */
export async function loadHarnessFeedbackImportLedger({ rootDir } = {}) {
  const paths = ingestPaths(rootDir);
  return withCanvasFileLock(paths.lock, async () => {
    let names;
    try { names = await readdir(paths.imports); }
    catch (error) {
      if (error?.code === "ENOENT") return { approved: [], revokedAfterApproval: [] };
      throw error;
    }
    const approved = [];
    const revokedAfterApproval = [];
    for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
      const digest = cleanSha(basename(name, ".json"), "approved import filename");
      const chain = await loadVerifiedCandidateChain(paths, digest);
      const ownerDecision = validateOwnerDecision(
        await readJsonIfExists(join(paths.decisions, `${digest}.json`), null),
        { digest, candidateDigest: chain.candidateDigest, requireApproved: true },
      );
      const value = JSON.parse(await readFile(join(paths.imports, basename(name)), "utf8"));
      assertCanonicalEqual(value, approvedImportFor(chain.candidate, ownerDecision),
        `approved feedback importが不正: ${name}`);
      if (chain.operator.status === "active") {
        approved.push(value);
        continue;
      }
      revokedAfterApproval.push({
        version: HARNESS_FEEDBACK_APPROVED_IMPORT_VERSION,
        status: "revoked-after-approval",
        reasonCode: "FEEDBACK_SIGNER_REVOKED",
        bundleDigest: value.bundleDigest,
        candidateDigest: value.candidateDigest,
        approvedBy: value.approvedBy,
        approvedAt: value.approvedAt,
        operator: value.operator,
        signer: signerStateOf(chain.operator),
        writesCanonical: false,
      });
    }
    return { approved, revokedAfterApproval };
  });
}

/** curatorが観測へ数えてよいimportだけ。失効鍵のものは含まない。 */
export async function loadApprovedHarnessFeedbackImports({ rootDir } = {}) {
  return (await loadHarnessFeedbackImportLedger({ rootDir })).approved;
}

function tokenMatches(authorization, expectedToken) {
  const supplied = /^Bearer\s+(.+)$/iu.exec(String(authorization || ""))?.[1] || "";
  if (!supplied || !nonEmpty(expectedToken)) return false;
  const left = createHash("sha256").update(supplied).digest();
  const right = createHash("sha256").update(expectedToken).digest();
  return timingSafeEqual(left, right);
}

async function readHttpBody(request, maximum) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maximum) {
      throw new HarnessFeedbackIngestError(`request bodyが${maximum} bytesを超えた。`, {
        code: "FEEDBACK_BUNDLE_SIZE_INVALID",
        statusCode: 413,
      });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sendJson(response, statusCode, value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.length,
    "cache-control": "no-store",
  });
  response.end(bytes);
}

function publicIngestReceipt(receipt) {
  return Object.fromEntries([
    "version", "ok", "duplicate", "status", "receivedAt", "bundleDigest",
    "requestSha256", "sourceReplayKey", "operatorId", "signerKeyId",
    "harnessId", "sourceReportSha256", "candidateDigest", "ownerApprovalRequired",
  ].filter((key) => receipt?.[key] !== undefined).map((key) => [key, receipt[key]]));
}

/** HTTP upload surface. Enrollment/owner approval stay local-only. */
export function createHarnessFeedbackUploadHandler({
  rootDir,
  uploadToken,
  maxBundleBytes = DEFAULT_MAX_BUNDLE_BYTES,
  proposalCatalogPath = DEFAULT_PROPOSAL_CATALOG_PATH,
  now = () => new Date().toISOString(),
} = {}) {
  if (!nonEmpty(uploadToken)) throw new HarnessFeedbackIngestError("feedback upload API tokenが要る。");
  return async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/healthz") {
        sendJson(response, 200, { ok: true, service: "buzzassist-feedback-ingest" });
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/feedback/bundles") {
        sendJson(response, 404, { ok: false, code: "NOT_FOUND" });
        return;
      }
      if (!tokenMatches(request.headers.authorization, uploadToken)) {
        sendJson(response, 401, { ok: false, code: "UNAUTHORIZED" });
        return;
      }
      const bytes = await readHttpBody(request, maxBundleBytes);
      let bundle;
      try { bundle = JSON.parse(bytes.toString("utf8")); }
      catch {
        // Route malformed authenticated uploads through the same metadata-only
        // quarantine; never persist their unvalidated raw bytes.
        await ingestHarnessFeedbackBundle({
          rootDir,
          bundle: null,
          bundleBytes: bytes,
          maxBundleBytes,
          proposalCatalogPath,
          receivedAt: now(),
        });
      }
      const result = await ingestHarnessFeedbackBundle({
        rootDir,
        bundle,
        bundleBytes: bytes,
        maxBundleBytes,
        proposalCatalogPath,
        receivedAt: now(),
      });
      sendJson(response, result.duplicate ? 200 : 202, publicIngestReceipt(result));
    } catch (error) {
      sendJson(response, Number(error?.statusCode) || 400, {
        ok: false,
        code: nonEmpty(error?.code) || "FEEDBACK_INGEST_INVALID",
        error: String(error?.message || error).slice(0, 1000),
      });
    }
  };
}
