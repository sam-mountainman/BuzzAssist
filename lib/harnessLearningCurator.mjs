// harness-learnのproposalと確定RunReceiptを、正本へ触れずに束ねるread-only curator。
// LLMへ丸投げせず、まず決定論で同一事象・類似事象・実測gateを分離する。

import { createHash } from "node:crypto";

import { rollup } from "../scripts/harness-receipts.mjs";
import {
  clusterForConsolidation,
  proposalId,
  resolveTarget,
  summarizeProposals,
} from "../scripts/harness-learn.mjs";

export const HARNESS_CURATOR_REPORT_VERSION = "buzzassist-harness-curator-v1";
export const PUBLIC_PROPOSAL_CATALOG_VERSION = "buzzassist-public-proposal-catalog-v1";
/** 公開catalogの1行が持てるfield。本文・根拠・session・時刻は持たない。 */
export const PUBLIC_PROPOSAL_CATALOG_KEYS = Object.freeze(["id", "kind", "target"]);
const PUBLIC_PROPOSAL_ID = /^[a-f0-9]{12}$/u;
const PUBLIC_PROPOSAL_KINDS = new Set(["correction", "preference", "constraint", "fact"]);
const SHARED_TARGET_SCOPE = /^(?:platform|genre):/u;

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .trim();
}

function ngrams(value, size = 3) {
  const text = normalizedText(value);
  if (!text) return new Set();
  if (text.length <= size) return new Set([text]);
  const out = new Set();
  for (let index = 0; index <= text.length - size; index += 1) out.add(text.slice(index, index + size));
  return out;
}

export function textSimilarity(left, right) {
  const a = ngrams(left);
  const b = ngrams(right);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

/**
 * 同じproposal IDを同じsessionで再捕捉しても、occurrenceを水増ししない。
 * session不明の古い記録だけはcapturedAtを独立事象として保守的に数える。
 */
export function dedupeProposalOccurrences(rows) {
  const seen = new Set();
  const output = [];
  for (const raw of rows || []) {
    const id = nonEmpty(raw?.id) || proposalId(raw || {});
    const session = nonEmpty(raw?.session);
    const eventKey = session
      ? `${id}\u001f${session}`
      : `${id}\u001flegacy:${nonEmpty(raw?.capturedAt) || sha256(JSON.stringify(raw)).slice(0, 16)}`;
    if (seen.has(eventKey)) {
      const existing = output.find((entry) => entry.__eventKey === eventKey);
      if (existing && raw?.evidence && !existing.__evidence.includes(String(raw.evidence))) {
        existing.__evidence.push(String(raw.evidence));
        existing.evidence = existing.__evidence.join(" / ");
      }
      continue;
    }
    seen.add(eventKey);
    output.push({
      ...raw,
      id,
      __eventKey: eventKey,
      __evidence: raw?.evidence ? [String(raw.evidence)] : [],
    });
  }
  return output.map(({ __eventKey: _eventKey, __evidence: _evidence, ...entry }) => entry);
}

export function proposalOccurrenceDigest(entry = {}) {
  const id = nonEmpty(entry.id) || proposalId(entry);
  const session = nonEmpty(entry.session);
  const legacyIdentity = nonEmpty(entry.capturedAt) || sha256(JSON.stringify(entry));
  return sha256(JSON.stringify({
    version: "buzzassist-proposal-occurrence-v1",
    proposalId: id,
    event: session ? { type: "session", value: session } : { type: "legacy", value: legacyIdentity },
  }));
}

function semanticClusters(pending, threshold = 0.42) {
  const parent = pending.map((_, index) => index);
  const find = (index) => {
    let current = index;
    while (parent[current] !== current) current = parent[current];
    while (parent[index] !== index) {
      const next = parent[index];
      parent[index] = current;
      index = next;
    }
    return current;
  };
  const union = (left, right) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent[b] = a;
  };
  for (let left = 0; left < pending.length; left += 1) {
    for (let right = left + 1; right < pending.length; right += 1) {
      if (pending[left].target !== pending[right].target) continue;
      if (textSimilarity(pending[left].text, pending[right].text) >= threshold) union(left, right);
    }
  }
  const groups = new Map();
  pending.forEach((entry, index) => {
    const key = find(index);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  });
  return [...groups.values()]
    .map((entries) => ({
      clusterId: `curator-${sha256(entries.map((entry) => entry.id).sort().join("\u001f")).slice(0, 12)}`,
      target: entries[0].target,
      proposalIds: entries.map((entry) => entry.id).sort(),
      occurrenceCount: entries.reduce((sum, entry) => sum + Number(entry.occurrences || 1), 0),
      classification: entries.length > 1 ? "similar-proposals" : "single-proposal",
      recommendation: entries.length > 1
        ? "個別Skillを増やさず、既存の同一クラス規則へ統合するdraftを作る"
        : "既存の節・既存テストへ吸収できるかを先に評価する",
    }))
    .sort((left, right) => right.occurrenceCount - left.occurrenceCount || left.clusterId.localeCompare(right.clusterId));
}

export function buildHarnessCuratorReport({
  proposals = [],
  applied = [],
  receipts = [],
  approvedFeedbackImports = [],
  revokedFeedbackImports = [],
  readCanonical = null,
  hashCanonical = null,
  similarityThreshold = 0.42,
  generatedAt = new Date().toISOString(),
} = {}) {
  // 失効鍵のimportは呼び出し側（loadHarnessFeedbackImportLedger）で分離される
  // のが正だが、curatorは自分でも弾く。判定を1箇所に散らさず、取り違えで
  // 失効済みが混ざっても観測へ数えないため。分離記録は観測本体を持たない。
  const revokedImportRecords = [
    ...(approvedFeedbackImports || []).filter((entry) => entry?.status === "revoked-after-approval"),
    ...(revokedFeedbackImports || []),
  ].map((entry) => ({
    // 報告へ出す field はこの4つ＋status に限る（R2-D2-1）。観測本体・承認者・
    // 生 signer 記録は載せない。
    status: "revoked-after-approval",
    bundleDigest: nonEmpty(entry?.bundleDigest),
    operatorId: nonEmpty(entry?.operator?.operatorId),
    signerKeyId: nonEmpty(entry?.signer?.keyId) || nonEmpty(entry?.operator?.signerKeyId),
    ...(nonEmpty(entry?.signer?.revokedAt) ? { revokedAt: entry.signer.revokedAt } : {}),
  })).sort((left, right) => left.bundleDigest.localeCompare(right.bundleDigest));
  approvedFeedbackImports = (approvedFeedbackImports || []).filter((entry) => entry?.status !== "revoked-after-approval");
  const deduped = dedupeProposalOccurrences(proposals);
  const summary = summarizeProposals(deduped, applied, readCanonical, hashCanonical);
  const localOccurrenceDigestsByProposal = new Map();
  for (const entry of deduped) {
    const id = nonEmpty(entry.id) || proposalId(entry);
    if (!localOccurrenceDigestsByProposal.has(id)) localOccurrenceDigestsByProposal.set(id, new Set());
    localOccurrenceDigestsByProposal.get(id).add(proposalOccurrenceDigest(entry));
  }
  const remoteByProposal = new Map();
  for (const feedbackImport of approvedFeedbackImports || []) {
    for (const observation of feedbackImport?.proposalObservations || []) {
      const id = nonEmpty(observation?.proposalId);
      const operatorId = nonEmpty(feedbackImport?.operator?.operatorId);
      if (!id || !operatorId || !Array.isArray(observation?.occurrenceDigests)) continue;
      const current = remoteByProposal.get(id) || {
        occurrenceKeys: new Set(),
        bundleDigests: new Set(),
        evidenceDigests: new Set(),
        targets: new Set(),
      };
      for (const digest of observation.occurrenceDigests) {
        if (/^[a-f0-9]{64}$/u.test(String(digest || ""))) current.occurrenceKeys.add(`${operatorId}\u001f${digest}`);
      }
      if (nonEmpty(feedbackImport?.bundleDigest)) current.bundleDigests.add(feedbackImport.bundleDigest);
      for (const digest of observation?.evidenceDigests || []) current.evidenceDigests.add(String(digest));
      if (nonEmpty(observation?.target)) current.targets.add(observation.target);
      remoteByProposal.set(id, current);
    }
  }
  const pending = summary.filter((entry) => !entry.applied).map((entry) => {
    const remote = remoteByProposal.get(entry.id);
    const localOccurrenceDigests = [...(localOccurrenceDigestsByProposal.get(entry.id) || [])].sort();
    if (!remote) return { ...entry, localOccurrenceDigests, occurrenceDigests: localOccurrenceDigests };
    if (remote.targets.size !== 1 || !remote.targets.has(entry.target)) {
      return { ...entry, localOccurrenceDigests, occurrenceDigests: localOccurrenceDigests, remoteObservationConflict: true };
    }
    const approvedRemoteOccurrenceDigests = [...remote.occurrenceKeys].map((value) => sha256(value)).sort();
    return {
      ...entry,
      localOccurrences: localOccurrenceDigests.length,
      localOccurrenceDigests,
      approvedRemoteOccurrences: approvedRemoteOccurrenceDigests.length,
      approvedRemoteOccurrenceDigests,
      occurrenceDigests: [...localOccurrenceDigests, ...approvedRemoteOccurrenceDigests].sort(),
      occurrences: localOccurrenceDigests.length + approvedRemoteOccurrenceDigests.length,
      approvedRemoteBundleDigests: [...remote.bundleDigests].sort(),
      approvedRemoteEvidenceDigests: [...remote.evidenceDigests].sort(),
    };
  });
  const knownProposalIds = new Set(summary.map((entry) => entry.id));
  const unmatchedRemoteProposalIds = [...remoteByProposal.keys()].filter((id) => !knownProposalIds.has(id)).sort();
  const exactTargets = clusterForConsolidation(summary).map((cluster) => ({
    target: cluster.target,
    proposalIds: cluster.entries.map((entry) => entry.id),
    recommendation: cluster.recommendation,
  }));
  const receiptRollup = rollup(receipts);
  const observedGates = receiptRollup.builds.flatMap((build) => build.worstGates.map((gate) => ({
    source: "run-receipt",
    harnessId: build.harnessId,
    harnessVersion: build.harnessVersion,
    declarationDigest: build.declarationDigest,
    gateId: gate.id,
    pass: gate.pass,
    fail: gate.fail,
    skip: gate.skip,
    failRate: gate.failRate,
  })));
  return {
    version: HARNESS_CURATOR_REPORT_VERSION,
    generatedAt,
    readOnly: true,
    writesCanonical: false,
    counts: {
      rawProposalRows: proposals.length,
      uniqueSessionOccurrences: deduped.length,
      uniqueProposals: summary.length,
      pendingProposals: pending.length,
      finalizedReceipts: receipts.filter((entry) => !entry.error).length,
      approvedFeedbackImports: approvedFeedbackImports.length,
      revokedAfterApprovalImports: revokedImportRecords.length,
      approvedRemoteProposalObservations: [...remoteByProposal.values()]
        .reduce((sum, entry) => sum + entry.occurrenceKeys.size, 0),
      unmatchedRemoteProposalIds: unmatchedRemoteProposalIds.length,
    },
    pending: pending.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      target: entry.target,
      text: entry.text,
      occurrences: entry.occurrences,
      ...(entry.localOccurrences !== undefined ? { localOccurrences: entry.localOccurrences } : {}),
      ...(entry.localOccurrenceDigests ? { localOccurrenceDigests: entry.localOccurrenceDigests } : {}),
      ...(entry.approvedRemoteOccurrences !== undefined
        ? { approvedRemoteOccurrences: entry.approvedRemoteOccurrences }
        : {}),
      ...(entry.approvedRemoteOccurrenceDigests
        ? { approvedRemoteOccurrenceDigests: entry.approvedRemoteOccurrenceDigests }
        : {}),
      occurrenceDigests: entry.occurrenceDigests || [],
      ...(entry.approvedRemoteBundleDigests
        ? { approvedRemoteBundleDigests: entry.approvedRemoteBundleDigests }
        : {}),
      ...(entry.approvedRemoteEvidenceDigests
        ? { approvedRemoteEvidenceDigests: entry.approvedRemoteEvidenceDigests }
        : {}),
      ...(entry.remoteObservationConflict === true ? { remoteObservationConflict: true } : {}),
      evidenceDigests: (entry.evidence || []).map((value) => sha256(value)),
      firstSeenAt: entry.firstSeenAt,
      lastSeenAt: entry.lastSeenAt,
    })),
    targetClusters: exactTargets,
    semanticClusters: semanticClusters(pending, similarityThreshold),
    observedGates,
    approvedRemoteGateObservations: approvedFeedbackImports.flatMap((entry) => (entry?.gateObservations || []).map((gate) => ({
      source: "owner-approved-feedback-bundle",
      bundleDigest: entry.bundleDigest,
      ...gate,
    }))),
    unmatchedRemoteProposalIds,
    revokedAfterApprovalImports: revokedImportRecords,
    safeguards: [
      "proposalとRunReceipt実測を別sourceとして保持",
      "同一proposal・同一sessionの再捕捉を1 occurrenceとして数える",
      "正本・applied.jsonl・Channel Packを変更しない",
      "人間承認前のproposalを監査pass根拠へ使わない",
      "owner承認済みremote observationも既知proposal IDとの照合にだけ使い、本文や正本を生成しない",
      "署名鍵が後に失効したimportはrevoked-after-approvalとして分離し、観測数・gate観測へ数えない",
    ],
  };
}

/**
 * 共有ledger（docs/learning/proposals.jsonl）から、配布してよい意味情報だけの
 * 公開catalogを作る。
 *
 * ledger本文には運営者名・キャスト名・顧客の作業path・端末の一時path・
 * ユーザー発言の逐語が入りうる（実際に入っていた）。管理側ingestが必要と
 * するのは「このIDはどのkind/targetの提案か」だけなので、公開catalogは
 * id・kind・targetの3 fieldに限る。channel-pack宛は共有層に置かない規則
 * なので、混ざっていてもcatalogへは出さず件数だけ返す。
 */
export function buildPublicProposalCatalog(rows = []) {
  const byId = new Map();
  let confidentialExcluded = 0;
  let invalidRows = 0;
  for (const raw of rows || []) {
    if (!raw || typeof raw !== "object") { invalidRows += 1; continue; }
    const id = nonEmpty(raw.id) || proposalId(raw);
    const kind = nonEmpty(raw.kind);
    const target = resolveTarget(nonEmpty(raw.target));
    if (!PUBLIC_PROPOSAL_ID.test(id) || !PUBLIC_PROPOSAL_KINDS.has(kind) || !target) {
      invalidRows += 1;
      continue;
    }
    if (!SHARED_TARGET_SCOPE.test(target)) { confidentialExcluded += 1; continue; }
    const semantic = { id, kind, target };
    const existing = byId.get(id);
    if (existing && (existing.kind !== kind || existing.target !== target)) {
      throw new Error(`proposal ledgerで同じIDが別のkind/targetを指している: ${id}`);
    }
    byId.set(id, semantic);
  }
  return {
    version: PUBLIC_PROPOSAL_CATALOG_VERSION,
    entries: [...byId.values()].sort((left, right) => left.id.localeCompare(right.id)),
    counts: {
      sourceRows: (rows || []).length,
      entries: byId.size,
      confidentialExcluded,
      invalidRows,
    },
  };
}

/** 公開catalogのJSONL表現。行順・field順を固定し、差分レビューを読めるようにする。 */
export function renderPublicProposalCatalog(entries = []) {
  return entries
    .map((entry) => JSON.stringify({ id: entry.id, kind: entry.kind, target: entry.target }))
    .join("\n")
    .concat(entries.length > 0 ? "\n" : "");
}

/** 公開catalogを読む。許可外fieldが1つでもあれば読まない（本文が混ざる入口を残さない）。 */
export function parsePublicProposalCatalog(text = "") {
  const entries = [];
  for (const [index, line] of String(text || "").split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); }
    catch (error) { throw new Error(`公開catalog ${index + 1}行目がJSONではない: ${error.message}`); }
    const unexpected = Object.keys(row || {}).filter((key) => !PUBLIC_PROPOSAL_CATALOG_KEYS.includes(key));
    if (unexpected.length > 0) {
      throw new Error(`公開catalog ${index + 1}行目に許可外field: ${unexpected.join(", ")}`);
    }
    const id = nonEmpty(row?.id);
    const kind = nonEmpty(row?.kind);
    const target = nonEmpty(row?.target);
    if (!PUBLIC_PROPOSAL_ID.test(id) || !PUBLIC_PROPOSAL_KINDS.has(kind) || !SHARED_TARGET_SCOPE.test(target)) {
      throw new Error(`公開catalog ${index + 1}行目のid/kind/targetが不正。`);
    }
    entries.push({ id, kind, target });
  }
  return entries;
}

/**
 * 公開catalogがledgerから乖離していないか。ledgerに増えた提案がcatalogに無い、
 * catalogにledgerに無いIDがある、同じIDのkind/targetが違う、の3種を返す。
 */
export function comparePublicProposalCatalog({ ledgerRows = [], catalogText = "" } = {}) {
  const expected = buildPublicProposalCatalog(ledgerRows).entries;
  const actual = parsePublicProposalCatalog(catalogText);
  const expectedById = new Map(expected.map((entry) => [entry.id, entry]));
  const actualById = new Map(actual.map((entry) => [entry.id, entry]));
  const missing = expected.filter((entry) => !actualById.has(entry.id)).map((entry) => entry.id);
  const extra = actual.filter((entry) => !expectedById.has(entry.id)).map((entry) => entry.id);
  const drift = expected
    .filter((entry) => actualById.has(entry.id))
    .filter((entry) => {
      const other = actualById.get(entry.id);
      return other.kind !== entry.kind || other.target !== entry.target;
    })
    .map((entry) => entry.id);
  const renderedMatches = renderPublicProposalCatalog(expected) === String(catalogText || "");
  return {
    ok: missing.length === 0 && extra.length === 0 && drift.length === 0 && renderedMatches,
    missing,
    extra,
    drift,
    renderedMatches,
    expectedCount: expected.length,
    actualCount: actual.length,
  };
}
