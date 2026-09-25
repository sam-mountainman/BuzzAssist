// 受け取り口（BuzzAssist 本体とは別の製品のサーバーに置いた POST /v2/feedback/bundles）が受け付けた
// 自動の feedback bundle（v3）を、owner がその書き出し（JSON Lines）から管理側へ取り込む。
//
// 受け取り口は BuzzAssist の宣言と公開 catalog を持たないので、次の照合を省いている
// （docs/harness-feedback-receiver-spec-ja.md「照合を owner の取り込みへ回す実装」）。この取り込みが
// それを必ず行う:
//
//   - settlement.gates[].gateId がハーネスの宣言（config/harnesses/*.harness.json）にあること
//   - proposals[].id が公開 catalog にあり kind / target が一致すること、newCandidates[].candidateId が
//     catalog にあれば既知の提案の観測として数えること（受け取り口の手順 7・8）
//   - 本文の privacy（公開面の検査と同じ語彙。受け取り口は運営者の語彙を持たない）
//
// 加えて、書き出しの行を信用せず、登録簿の鍵で署名と digest を検証し直し、受領証を提供元の鍵の
// 指紋で検証する。通った bundle は既存の verified-quarantine（curation の候補）へ置くだけで、
// 集計へ入るのは owner の approve のあと（lib/harnessFeedbackIngest.mjs と同じ流れ）。
// 落ちた bundle は理由のコードだけを取り込みの記録（<root>/export-imports/）に残し、隔離へ入れない。
// 本文（generalizedText など）は取り込みの記録へ写さない。

import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { writeJsonAtomic } from "./atomicJsonFile.mjs";
import {
  HARNESS_FEEDBACK_AUTO_BUNDLE_VERSION,
  HARNESS_FEEDBACK_AUTO_MAX_BYTES,
  assertFeedbackPayloadPrivacy,
  autoFeedbackBundleDigest,
  loadFeedbackPrivacyContext,
  loadHarnessGateRegistry,
  normalizeProviderKeyFingerprint,
  validateAutoFeedbackBundleForTransport,
  verifyAutoFeedbackBundle,
  verifyProviderIngestReceipt,
} from "./harnessFeedbackAutoBundle.mjs";
import {
  HARNESS_FEEDBACK_PUBLIC_CATALOG_RELATIVE_PATH,
  loadHarnessFeedbackProposalCatalog,
} from "./harnessFeedbackBundle.mjs";
import {
  HarnessFeedbackIngestError,
  RECEIVER_OPERATOR_KEY_ID,
  assertAutoFeedbackSignerUsable,
  autoFeedbackSourceReplayKey,
  peekAutoFeedbackImportState,
  permissiveAutoGateRegistry,
  quarantineAutoFeedbackBundle,
  readHarnessFeedbackOperatorRegistry,
  verifyStoredHarnessFeedbackChain,
} from "./harnessFeedbackIngest.mjs";

export const HARNESS_FEEDBACK_EXPORT_IMPORT_VERSION = "buzzassist-feedback-export-import-v1";
/** 取り込みの記録の置き場（<root> の直下）。dry-run では作らない。 */
export const HARNESS_FEEDBACK_EXPORT_IMPORT_DIR = "export-imports";

/**
 * 理由のコード。上の段は1つの bundle を取り込まない理由（残りの行は続ける）、
 * 「止める」の段は書き出しそのものが読めない・信用できない理由（その行で止める）。
 * 受け取り口と同じ意味のものは受け取り口と同じコードを使う。
 */
export const EXPORT_IMPORT_REASON_CODES = Object.freeze({
  FEEDBACK_EXPORT_SIGNER_MISMATCH: "行の signerKeyId と bundle の signer.keyId が違う",
  FEEDBACK_EXPORT_DIGEST_MISMATCH: "行の bundleDigest と、bundle から計算し直した digest が違う",
  FEEDBACK_INGEST_INVALID: "v3 の形ではない（未許可 field・範囲外の値・同意の範囲外の中身・文の形）",
  FEEDBACK_SIGNER_NOT_ENROLLED: "署名鍵が管理側の登録簿に無い",
  FEEDBACK_SIGNER_KEY_USE_MISMATCH: "署名鍵が手動の bundle 用として登録されている",
  FEEDBACK_SIGNER_REVOKED: "署名鍵が管理側で失効している",
  FEEDBACK_HARNESS_NOT_ALLOWED: "その鍵に build.harnessId の許可が無い",
  FEEDBACK_SIGNATURE_INVALID: "登録簿の公開鍵で署名を検証できない",
  FEEDBACK_PROVIDER_RECEIPT_INVALID: "受領証が提供元の鍵の指紋・署名・digest・受領時刻のどれかと合わない",
  FEEDBACK_HARNESS_NOT_DECLARED: "build.harnessId のハーネス宣言が無い",
  FEEDBACK_GATE_NOT_DECLARED: "settlement.gates の gateId がハーネス宣言に無い",
  FEEDBACK_PROPOSAL_NOT_REGISTERED: "proposals の id が公開 catalog に無い",
  FEEDBACK_PROPOSAL_SEMANTIC_MISMATCH: "catalog にある id の kind / target が食い違う",
  FEEDBACK_PRIVACY_BLOCKED: "本文が検査語彙・Channel Pack の語・端末のパスなどに当たる",
  FEEDBACK_SOURCE_REPLAY_CONFLICT: "同じ operator の同じ決着が別の bundle として既にある",
});
export const EXPORT_IMPORT_STOP_CODES = Object.freeze({
  FEEDBACK_EXPORT_LINE_INVALID: "JSON ではない・形が違う行",
  FEEDBACK_EXPORT_RECORD_UNKNOWN: "未知の record",
  FEEDBACK_EXPORT_RECORD_AFTER_SUMMARY: "summary の後ろに行がある",
  FEEDBACK_INGEST_STORAGE_TAMPER: "既に取り込んだ記録が改変されている",
});

const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHA256 = /^[a-f0-9]{64}$/u;
const KEY_ID = /^ed25519:[a-f0-9]{24}$/u;
const REJECTION_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
// 1行 = 署名つき bundle（1 MiB 以下）＋受領証＋包み。余裕を見て4倍までを1行として読む。
const MAX_LINE_BYTES = HARNESS_FEEDBACK_AUTO_MAX_BYTES * 4;
const RECORD_KEYS = Object.freeze({
  bundle: ["record", "bundleDigest", "operatorKeyId", "signerKeyId", "receivedAt", "bundle", "receipt"],
  rejection: ["record", "code", "httpStatus", "requestSha256", "bodyBytes", "signerKeyId", "receivedAt"],
  summary: ["record", "exportedAt", "bundles", "excludedInactiveSigner", "rejections"],
});

class ExportStop extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isIsoTime(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/u.test(value) && Number.isFinite(Date.parse(value));
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/** 1行を読んで、包み（record の種類と field の形）を確かめる。中身の bundle / receipt はまだ信用しない。 */
function parseExportLine(text) {
  if (Buffer.byteLength(text) > MAX_LINE_BYTES) throw new ExportStop("FEEDBACK_EXPORT_LINE_INVALID", "1行が大きすぎる。");
  let value;
  try { value = JSON.parse(text); }
  catch { throw new ExportStop("FEEDBACK_EXPORT_LINE_INVALID", "JSON として読めない行。"); }
  if (!isObject(value) || typeof value.record !== "string") {
    throw new ExportStop("FEEDBACK_EXPORT_LINE_INVALID", "record を持つ object ではない行。");
  }
  const keys = RECORD_KEYS[value.record];
  if (!Object.hasOwn(RECORD_KEYS, value.record) || !keys) {
    throw new ExportStop("FEEDBACK_EXPORT_RECORD_UNKNOWN", "未知の record。");
  }
  const invalid = (message) => new ExportStop("FEEDBACK_EXPORT_LINE_INVALID", `${value.record} 行の形が違う: ${message}`);
  if (!hasExactKeys(value, keys)) throw invalid("field の組が仕様と違う。");
  if (value.record === "bundle") {
    if (!SHA256.test(String(value.bundleDigest))) throw invalid("bundleDigest");
    if (typeof value.operatorKeyId !== "string" || !RECEIVER_OPERATOR_KEY_ID.test(value.operatorKeyId)) throw invalid("operatorKeyId");
    if (!KEY_ID.test(String(value.signerKeyId))) throw invalid("signerKeyId");
    if (!isIsoTime(value.receivedAt)) throw invalid("receivedAt");
    if (!isObject(value.bundle)) throw invalid("bundle");
    if (!isObject(value.receipt)) throw invalid("receipt");
  } else if (value.record === "rejection") {
    if (!REJECTION_CODE.test(String(value.code))) throw invalid("code");
    if (!Number.isSafeInteger(value.httpStatus) || value.httpStatus < 100 || value.httpStatus > 599) throw invalid("httpStatus");
    if (value.requestSha256 !== null && !SHA256.test(String(value.requestSha256))) throw invalid("requestSha256");
    if (!isCount(value.bodyBytes)) throw invalid("bodyBytes");
    if (value.signerKeyId !== null && !KEY_ID.test(String(value.signerKeyId))) throw invalid("signerKeyId");
    if (!isIsoTime(value.receivedAt)) throw invalid("receivedAt");
  } else {
    if (!isIsoTime(value.exportedAt)) throw invalid("exportedAt");
    for (const key of ["bundles", "excludedInactiveSigner", "rejections"]) {
      if (!isCount(value[key])) throw invalid(key);
    }
  }
  return value;
}

function sortedCounts(map) {
  return Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

/**
 * bundle の1行を照合し、通れば verified-quarantine へ置く（書かない mode では置いたつもりで数える）。
 * 1つの bundle を取り込まない理由は outcome: "rejected" で返す。置き場の改変など、書き出しの続きを
 * 読むべきでない異常だけを throw する。
 */
async function importBundleRecord(record, ctx) {
  const { bundle } = record;
  const base = {
    bundleDigest: record.bundleDigest,
    signerKeyId: record.signerKeyId,
    receiverOperatorKeyId: record.operatorKeyId,
  };
  const reject = (code, extra = {}) => ({ ...base, outcome: "rejected", code, ...extra });

  // 行の包みと bundle の結び付き。署名つきの本体から計算し直した digest だけを信用する。
  if (bundle?.signer?.keyId !== record.signerKeyId) return reject("FEEDBACK_EXPORT_SIGNER_MISMATCH");
  const digest = autoFeedbackBundleDigest(bundle);
  if (digest !== record.bundleDigest) return reject("FEEDBACK_EXPORT_DIGEST_MISMATCH");

  // 書き出しは毎回「保持期限内の全件」なので、同じ bundle が回をまたいで何度も来る。既に置いた
  // digest は、置いた記録の chain を検証してから「取り込み済み」として数え、何も書かない。
  if (ctx.seenDigests.has(digest)) return { ...base, outcome: "already-imported", withinExport: true };
  if ((await peekAutoFeedbackImportState({ rootDir: ctx.root, bundleDigest: digest })).receiptExists) {
    const chain = await verifyStoredHarnessFeedbackChain({ rootDir: ctx.root, bundleDigest: digest });
    ctx.seenDigests.add(digest);
    return { ...base, outcome: "already-imported", operatorId: chain.operatorId };
  }

  // 形（v3 の strict schema）。ゲートの宣言との照合は後で本物の宣言に対して行う。
  if (bundle.version !== HARNESS_FEEDBACK_AUTO_BUNDLE_VERSION) return reject("FEEDBACK_INGEST_INVALID");
  try { validateAutoFeedbackBundleForTransport(bundle, { registry: permissiveAutoGateRegistry(bundle) }); }
  catch { return reject("FEEDBACK_INGEST_INVALID"); }
  const harnessId = bundle.build.harnessId;

  // 登録簿の鍵（用途・状態・harness の許可）と署名。
  const operator = ctx.registry.operators.find((entry) => entry.keyId === record.signerKeyId);
  try { assertAutoFeedbackSignerUsable(operator, bundle); }
  catch (error) {
    if (!(error instanceof HarnessFeedbackIngestError)) throw error;
    return reject(error.code);
  }
  try {
    verifyAutoFeedbackBundle({ bundle, trustedPublicKeyPem: operator.publicKeyPem, registry: permissiveAutoGateRegistry(bundle) });
  } catch {
    return reject("FEEDBACK_SIGNATURE_INVALID");
  }
  const known = { ...base, operatorId: operator.operatorId, harnessId };

  // 受領証。digest と受領時刻は常に、提供元の鍵の指紋との一致は指紋を渡されたときに確かめる。
  const receipt = record.receipt;
  if (receipt.bundleDigest !== digest || receipt.receivedAt !== record.receivedAt) {
    return reject("FEEDBACK_PROVIDER_RECEIPT_INVALID", { operatorId: operator.operatorId });
  }
  let providerReceipt = "unverified";
  if (ctx.fingerprint) {
    try {
      verifyProviderIngestReceipt({ receipt, bundleDigest: digest, providerKeyFingerprint: ctx.fingerprint });
      providerReceipt = "verified";
    } catch {
      return reject("FEEDBACK_PROVIDER_RECEIPT_INVALID", { operatorId: operator.operatorId });
    }
  }

  // ここから先の拒否にも、受領証を確かめたかどうか（verified / unverified）を残す。
  const rejectVerified = (code, extra = {}) => reject(code, { operatorId: operator.operatorId, harnessId, providerReceipt, ...extra });

  // 受け取り口が省いた照合 1: ゲートがハーネス宣言にあること。
  if (harnessId !== null) {
    const declared = ctx.gates.get(harnessId);
    if (!declared) return rejectVerified("FEEDBACK_HARNESS_NOT_DECLARED");
    const undeclared = (bundle.settlement?.gates || []).filter((gate) => !declared.gateIds.has(gate.gateId)).length;
    // 宣言に無い gate id そのものは記録へ写さない（照合前の自由な文字列なので）。件数だけ残す。
    if (undeclared > 0) return rejectVerified("FEEDBACK_GATE_NOT_DECLARED", { undeclaredGates: undeclared });
    try { validateAutoFeedbackBundleForTransport(bundle, { registry: ctx.gates }); }
    catch { return rejectVerified("FEEDBACK_INGEST_INVALID"); }
  }

  // 受け取り口が省いた照合 2: 提案が公開 catalog にあること（手順 7）と、catalog に既にある候補（手順 8）。
  const missing = bundle.proposals.filter((entry) => !ctx.catalog.has(entry.id)).map((entry) => entry.id);
  if (missing.length > 0) return rejectVerified("FEEDBACK_PROPOSAL_NOT_REGISTERED", { proposalIds: missing });
  const mismatched = [
    ...bundle.proposals.map((entry) => ({ id: entry.id, kind: entry.kind, target: entry.target })),
    ...bundle.newCandidates.map((entry) => ({ id: entry.candidateId, kind: entry.kind, target: entry.target })),
  ].filter((entry) => {
    const semantic = ctx.catalog.get(entry.id);
    return semantic && (semantic.kind !== entry.kind || semantic.target !== entry.target);
  }).map((entry) => entry.id);
  if (mismatched.length > 0) {
    return rejectVerified("FEEDBACK_PROPOSAL_SEMANTIC_MISMATCH", { proposalIds: [...new Set(mismatched)].sort() });
  }
  const catalogMatchedCandidateIds = bundle.newCandidates
    .filter((entry) => ctx.catalog.has(entry.candidateId))
    .map((entry) => entry.candidateId)
    .sort();

  // 受け取り口が省いた照合 3: 本文の privacy。端末と同じ検査を、管理側の語彙（端末より広い）で行う。
  const { signer: _signer, signature: _signature, ...payload } = bundle;
  try { assertFeedbackPayloadPrivacy(payload, ctx.privacy); }
  catch (error) {
    return rejectVerified("FEEDBACK_PRIVACY_BLOCKED", { reasons: Array.isArray(error?.reasons) ? error.reasons : [] });
  }

  // replay（同じ operator の同じ決着が別の bundle）。書かない mode でも、この回の中の分も含めて見る。
  const sourceKey = autoFeedbackSourceReplayKey(bundle, operator.operatorId);
  if (sourceKey) {
    const earlier = ctx.seenSources.get(sourceKey)
      ?? (await peekAutoFeedbackImportState({ rootDir: ctx.root, bundleDigest: digest, sourceKey })).sourceBundleDigest;
    if (earlier && earlier !== digest) return rejectVerified("FEEDBACK_SOURCE_REPLAY_CONFLICT");
  }
  const detail = {
    ...known,
    providerReceipt,
    proposals: bundle.proposals.length,
    catalogMatchedCandidates: catalogMatchedCandidateIds.length,
    unregisteredCandidates: bundle.newCandidates.length - catalogMatchedCandidateIds.length,
  };
  if (!ctx.writes) {
    ctx.seenDigests.add(digest);
    if (sourceKey) ctx.seenSources.set(sourceKey, digest);
    return { ...detail, outcome: "would-quarantine" };
  }
  let stored;
  try {
    stored = await quarantineAutoFeedbackBundle({
      rootDir: ctx.root,
      bundle,
      receivedAt: record.receivedAt,
      importedAt: ctx.importedAt,
      receiverOperatorKeyId: record.operatorKeyId,
      providerReceipt: receipt,
      catalogMatchedCandidateIds,
    });
  } catch (error) {
    // lock の中で鍵が失効した・replay が見つかった、などは1件の拒否。置き場の改変は止める。
    if (error instanceof HarnessFeedbackIngestError
      && !["FEEDBACK_INGEST_STORAGE_TAMPER", "FEEDBACK_OPERATOR_REGISTRY_INVALID"].includes(error.code)) {
      return rejectVerified(error.code);
    }
    throw error;
  }
  ctx.seenDigests.add(digest);
  if (sourceKey) ctx.seenSources.set(sourceKey, digest);
  if (stored.outcome === "already-imported") return { ...base, outcome: "already-imported", operatorId: operator.operatorId };
  return { ...detail, outcome: "quarantined", candidateDigest: stored.receipt.candidateDigest };
}

/**
 * 受け取り口の書き出し（JSON Lines の文字列）を取り込む。
 *
 * - providerKeyFingerprint（提供元の受領証の鍵の指紋）が無いときは、全部を照合して「未検証」として
 *   数えるが、隔離へは置かない（取り込みの記録だけを書き、ok: false で止める）
 * - dryRun のときは何も書かない（隔離も取り込みの記録も）
 * - 形の壊れた行・未知の record・summary の後ろの行・置き場の改変に当たったら、その行で止める。
 *   それより前の行の取り込みは残る（bundleDigest で冪等なので、直した書き出しで最初から流し直してよい）
 * - summary の bundles（その回に書き出した bundle 行の数）と、読んだ bundle 行の数を突き合わせる。
 *   excludedInactiveSigner と rejections は件数として記録するだけ
 */
export async function importHarnessFeedbackExport({
  rootDir,
  exportText,
  providerKeyFingerprint = "",
  dryRun = false,
  codeRoot = MODULE_ROOT,
  gateRegistry = undefined,
  proposalCatalogPath = "",
  privacyContext = undefined,
  env = process.env,
  homeDir = undefined,
  now = () => new Date().toISOString(),
} = {}) {
  if (!nonEmpty(rootDir)) throw new HarnessFeedbackIngestError("取り込みの置き場（--root）が要る。");
  const root = resolve(rootDir);
  let fingerprint = null;
  if (nonEmpty(providerKeyFingerprint)) {
    try { fingerprint = normalizeProviderKeyFingerprint(providerKeyFingerprint); }
    catch (error) { throw new HarnessFeedbackIngestError(error?.message || String(error)); }
  }
  const privacy = privacyContext ?? loadFeedbackPrivacyContext({ codeRoot, env, ...(homeDir ? { homeDir } : {}) });
  if (privacy?.available !== true || !privacy.vocabulary) {
    throw new HarnessFeedbackIngestError(
      `検査語彙を照合できないので取り込まない（${privacy?.reason || "vocabulary-unavailable"}）。受け取り口は運営者の語彙を持たないので、この照合を省けない。`,
      { code: "FEEDBACK_PRIVACY_VOCABULARY_UNAVAILABLE", statusCode: 500 },
    );
  }
  const gates = gateRegistry ?? loadHarnessGateRegistry(codeRoot);
  let catalog;
  try {
    catalog = await loadHarnessFeedbackProposalCatalog(nonEmpty(proposalCatalogPath) || join(codeRoot, HARNESS_FEEDBACK_PUBLIC_CATALOG_RELATIVE_PATH));
  } catch (error) {
    throw new HarnessFeedbackIngestError(`proposal catalogを読めない: ${error?.code || error?.message || error}`, {
      code: "FEEDBACK_PROPOSAL_CATALOG_UNAVAILABLE",
      statusCode: 500,
    });
  }
  const registry = await readHarnessFeedbackOperatorRegistry({ rootDir: root });
  const importedAt = now();
  if (!isIsoTime(importedAt)) throw new HarnessFeedbackIngestError("importedAt が ISO-8601 ではない。");
  const mode = dryRun ? "dry-run" : (fingerprint ? "write" : "unverified-no-write");
  const text = String(exportText ?? "");
  const ctx = {
    root,
    registry,
    gates,
    catalog,
    privacy,
    fingerprint,
    importedAt,
    writes: mode === "write",
    seenDigests: new Set(),
    seenSources: new Map(),
  };

  const bundles = [];
  const receiverRejections = new Map();
  let bundleLines = 0;
  let rejectionLines = 0;
  let nonBlankLines = 0;
  let summaryRecord = null;
  let stopped = null;
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index].replace(/\r$/u, "");
    if (!raw.trim()) continue;
    nonBlankLines += 1;
    const line = index + 1;
    try {
      const record = parseExportLine(raw);
      if (summaryRecord) throw new ExportStop("FEEDBACK_EXPORT_RECORD_AFTER_SUMMARY", "summary の後ろに行がある。");
      if (record.record === "summary") { summaryRecord = record; continue; }
      if (record.record === "rejection") {
        rejectionLines += 1;
        receiverRejections.set(record.code, (receiverRejections.get(record.code) || 0) + 1);
        continue;
      }
      bundleLines += 1;
      bundles.push({ line, ...(await importBundleRecord(record, ctx)) });
    } catch (error) {
      stopped = {
        line,
        code: nonEmpty(error?.code) || "FEEDBACK_EXPORT_IMPORT_FAILED",
        reason: String(error?.message || error).slice(0, 300),
        processedThroughLine: line - 1,
      };
      break;
    }
  }

  const outcomeCount = (outcome) => bundles.filter((entry) => entry.outcome === outcome).length;
  const rejectedByCode = new Map();
  for (const entry of bundles.filter((item) => item.outcome === "rejected")) {
    rejectedByCode.set(entry.code, (rejectedByCode.get(entry.code) || 0) + 1);
  }
  const summary = summaryRecord
    ? {
      present: true,
      exportedAt: summaryRecord.exportedAt,
      bundles: summaryRecord.bundles,
      excludedInactiveSigner: summaryRecord.excludedInactiveSigner,
      rejections: summaryRecord.rejections,
      bundleLinesRead: bundleLines,
      rejectionLinesRead: rejectionLines,
      bundlesMatch: summaryRecord.bundles === bundleLines,
    }
    : { present: false, bundleLinesRead: bundleLines, rejectionLinesRead: rejectionLines };
  const issues = [];
  if (stopped) issues.push(stopped.code);
  else if (!summaryRecord) issues.push("FEEDBACK_EXPORT_SUMMARY_MISSING");
  else if (!summary.bundlesMatch) issues.push("FEEDBACK_EXPORT_SUMMARY_MISMATCH");
  if (mode === "unverified-no-write") issues.push("FEEDBACK_PROVIDER_FINGERPRINT_REQUIRED");
  const result = {
    version: HARNESS_FEEDBACK_EXPORT_IMPORT_VERSION,
    ok: issues.length === 0,
    issues,
    mode,
    dryRun: mode === "dry-run",
    importedAt,
    exportSha256: sha256(text),
    providerReceipts: {
      fingerprint,
      verified: bundles.filter((entry) => entry.providerReceipt === "verified").length,
      unverified: bundles.filter((entry) => entry.providerReceipt === "unverified").length,
    },
    counts: {
      lines: nonBlankLines,
      bundleLines,
      quarantined: outcomeCount("quarantined"),
      wouldQuarantine: outcomeCount("would-quarantine"),
      alreadyImported: outcomeCount("already-imported"),
      rejected: outcomeCount("rejected"),
      receiverRejectionLines: rejectionLines,
    },
    rejectedByCode: sortedCounts(rejectedByCode),
    receiverRejections: { lines: rejectionLines, byCode: sortedCounts(receiverRejections) },
    summary,
    stopped,
    bundles,
    ownerApprovalRequired: true,
    writesCanonical: false,
    recordPath: null,
    next: outcomeCount("quarantined") > 0
      ? "curation/<bundleDigest>.json を読んでから approve / reject する（harness-feedback-ingest.mjs approve|reject）。"
      : "",
  };
  if (mode !== "dry-run") {
    const stamp = importedAt.replace(/[^0-9]/gu, "").slice(0, 17);
    const recordPath = join(root, HARNESS_FEEDBACK_EXPORT_IMPORT_DIR, `${stamp}-${result.exportSha256.slice(0, 16)}.json`);
    await writeJsonAtomic(recordPath, result);
    result.recordPath = recordPath;
  }
  return result;
}
