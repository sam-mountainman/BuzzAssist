// 受け取り口の書き出し（JSON Lines）から自動の feedback bundle（v3）を取り込む口の試験。
//
// 運営者の鍵・提供元の鍵・bundle・受領証・ハーネス宣言・公開 catalog・検査語彙はすべて合成で、
// 一時ディレクトリの中だけに作る。本物の登録簿・台帳・HOME には書かず、ネットワークにも出ない。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalJson, publicKeyId } from "../lib/channelPackEnvelope.mjs";
import * as autoBundle from "../lib/harnessFeedbackAutoBundle.mjs";
import {
  autoFeedbackBundleDigest,
  loadFeedbackPrivacyContext,
  signAutoFeedbackBundle,
  signProviderIngestReceipt,
} from "../lib/harnessFeedbackAutoBundle.mjs";
import { buildHarnessFeedbackPayload, signHarnessFeedbackBundle } from "../lib/harnessFeedbackBundle.mjs";
import {
  EXPORT_IMPORT_REASON_CODES,
  HARNESS_FEEDBACK_EXPORT_IMPORT_DIR,
  importHarnessFeedbackExport,
} from "../lib/harnessFeedbackExportImport.mjs";
import {
  HARNESS_FEEDBACK_KEY_USE_AUTO,
  decideHarnessFeedbackBundle,
  enrollHarnessFeedbackOperator,
  ingestHarnessFeedbackBundle,
  loadHarnessFeedbackImportLedger,
  revokeHarnessFeedbackOperator,
} from "../lib/harnessFeedbackIngest.mjs";
import { buildSensitiveVocabularyDigest, SENSITIVE_VOCABULARY_KEY_ENV } from "../lib/packageTarballAudit.mjs";

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS = "synthetic-story";
const GATES = ["gate-alpha", "gate-beta"];
const TEST_VOCABULARY_KEY = "5a".repeat(32);
// 合成の語。管理側の検査語彙にだけ入れる（端末の検査は通ってしまった、という想定）。
const PRIVATE_TERM = "fictional-client-qq";
const OWNER = "synthetic-owner";
const KNOWN_PROPOSAL = { id: "aaaaaaaaaaa1", kind: "fact", target: "platform:platform-craft" };
// catalog には既にあるが、端末の古い catalog には無かったので newCandidates として届く提案。
const KNOWN_CANDIDATE = { id: "ccccccccccc3", kind: "preference", target: "genre:narrated-story-video" };
const UNKNOWN_CANDIDATE_ID = "eeeeeeeeeee5";
const UNKNOWN_PROPOSAL_ID = "ddddddddddd4";
const GENERAL_TEXT = "長い工程を始める前に空き容量を確かめ、足りなければ先に片付けてから始める。";
const CANDIDATE_TEXT = "書き出しの前に出力先の空き容量を確かめ、足りなければ止めて知らせる。";
const RECEIVED_AT = "2026-09-26T00:00:00.000Z";
const IMPORTED_AT = "2026-09-26T01:00:00.000Z";
const RECEIVER_KEY_ROW = `fok_${"0".repeat(32)}`;

function sha(label) {
  return createHash("sha256").update(label).digest("hex");
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  return file;
}

function keys() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    keyId: publicKeyId(pair.publicKey),
  };
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).map(String).filter((name) => fs.statSync(path.join(dir, name)).isFile()).sort();
}

/** 配る側の写し（合成の宣言・catalog・検査語彙）と、管理側の置き場（空）を作る。 */
function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "feedback-export-import-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const codeRoot = path.join(base, "code");
  const homeDir = path.join(base, "home");
  const root = path.join(base, "ingest");
  write(path.join(codeRoot, "config", "harnesses", `${HARNESS}.harness.json`), JSON.stringify({
    id: HARNESS,
    version: "1.0.0",
    guarantees: GATES.map((id) => ({ id })),
  }));
  write(
    path.join(codeRoot, "docs", "learning", "proposals.public.jsonl"),
    [KNOWN_PROPOSAL, KNOWN_CANDIDATE].map((entry) => `${JSON.stringify(entry)}\n`).join(""),
  );
  write(
    path.join(codeRoot, "docs", "learning", "sensitive-vocabulary.digest.json"),
    JSON.stringify(buildSensitiveVocabularyDigest([PRIVATE_TERM], { key: TEST_VOCABULARY_KEY, generatedAt: RECEIVED_AT })),
  );
  const env = { [SENSITIVE_VOCABULARY_KEY_ENV]: TEST_VOCABULARY_KEY };
  const privacy = loadFeedbackPrivacyContext({ codeRoot, env, homeDir, signals: { terms: [], castIds: [], sentences: [] } });
  assert.equal(privacy.available, true, "合成の検査語彙を照合できること");
  const operator = keys();
  const provider = keys();
  return { base, codeRoot, homeDir, root, env, privacy, operator, provider };
}

async function enrollAuto(fx, pair = fx.operator, operatorId = "operator-synthetic-a", allowedHarnessIds = [HARNESS]) {
  return enrollHarnessFeedbackOperator({
    rootDir: fx.root,
    operatorId,
    publicKeyPem: pair.publicKeyPem,
    keyUse: HARNESS_FEEDBACK_KEY_USE_AUTO,
    allowedHarnessIds,
    approvedBy: OWNER,
    enrolledAt: RECEIVED_AT,
  });
}

/** 端末側の宣言（取り込む側より新しいゲートを持つこともある）。 */
function senderRegistry(extraGates = []) {
  return new Map([[HARNESS, { version: "1.0.0", gateIds: new Set([...GATES, ...extraGates]), declarationDigest: sha("decl") }]]);
}

function payload({
  source = "source-1",
  generatedAt = "2026-09-25T23:00:00.000Z",
  gates = [{ gateId: "gate-alpha", verdict: "pass" }, { gateId: "gate-beta", verdict: "fail" }],
  proposals = [{ ...KNOWN_PROPOSAL, occurrences: 1, occurrenceDigests: [sha("occ-1")] }],
  newCandidates = [
    {
      candidateId: KNOWN_CANDIDATE.id,
      kind: KNOWN_CANDIDATE.kind,
      target: KNOWN_CANDIDATE.target,
      generalizedText: GENERAL_TEXT,
      evidenceKinds: ["operator-preference"],
      occurrences: 1,
      occurrenceDigests: [sha("cand-known-1")],
    },
    {
      candidateId: UNKNOWN_CANDIDATE_ID,
      kind: "preference",
      target: "genre:narrated-story-video",
      generalizedText: CANDIDATE_TEXT,
      evidenceKinds: ["operator-preference"],
      occurrences: 2,
      occurrenceDigests: [sha("cand-unknown-1"), sha("cand-unknown-2")],
    },
  ],
} = {}) {
  return {
    version: "buzzassist-harness-feedback-v3",
    kind: "operator-auto-feedback",
    generatedAt,
    trigger: "job-settled",
    consent: { scopes: ["settlements", "proposals", "new-candidates"], consentDigest: sha("consent") },
    build: { coreVersion: "0.1.27", harnessId: HARNESS, harnessVersion: "1.0.0", declarationDigest: sha("decl") },
    settlement: {
      sourceDigest: sha(source),
      receiptSource: "run-receipt",
      jobStatus: "failed",
      outcome: "fail",
      outcomeOverridden: false,
      gates,
      gateCounts: { declared: gates.length, pass: 1, fail: 1, skip: 0, notInForce: 0, missing: 0 },
      issueCodes: [{ code: "render-timeout", count: 1 }],
      counts: { mediaJobRetries: 0, incompleteMediaJobs: 0, imageRetries: 0, resumeAttempts: 0, pendingReceiptAttempts: 0 },
      failedStages: ["render"],
      host: { hostKey: "claude-code", hosts: ["claude-code"], createdByHost: "claude-code", buzzassistVersion: "0.1.27", models: ["unknown"], hostVersions: [] },
    },
    proposals,
    newCandidates,
    held: { proposals: 0, newCandidates: 1 },
    privacy: {
      containsScriptText: false, containsPrompts: false, containsEvidenceText: false, containsSessionIds: false,
      containsPaths: false, containsPersonNames: false, containsChannelTerms: false, vocabularyChecked: true,
    },
  };
}

function sign(value, pair, registry = senderRegistry()) {
  return signAutoFeedbackBundle({ payload: value, privateKeyPem: pair.privateKeyPem, registry });
}

/** 受け取り口の書き出しの bundle 行（受け取り口が最初に返した受領証つき）。 */
function bundleLine(bundle, providerPair, { receivedAt = RECEIVED_AT, receipt = undefined, bundleDigest = undefined } = {}) {
  const digest = bundleDigest ?? autoFeedbackBundleDigest(bundle);
  return {
    record: "bundle",
    bundleDigest: digest,
    operatorKeyId: RECEIVER_KEY_ROW,
    signerKeyId: bundle.signer.keyId,
    receivedAt,
    bundle,
    receipt: receipt ?? signProviderIngestReceipt({
      bundleDigest: autoFeedbackBundleDigest(bundle),
      receivedAt,
      privateKeyPem: providerPair.privateKeyPem,
    }),
  };
}

function rejectionLine(code = "FEEDBACK_SIGNATURE_INVALID") {
  return { record: "rejection", code, httpStatus: 400, requestSha256: sha(`req-${code}`), bodyBytes: 1234, signerKeyId: null, receivedAt: RECEIVED_AT };
}

/** 書き出しの本文。summary の bundles は既定で bundle 行の数（受け取り口の数え方と同じ）。 */
function exportText(records, { summary = true, bundles = undefined, excludedInactiveSigner = 0 } = {}) {
  const lines = records.map((record) => canonicalJson(record));
  if (summary) {
    lines.push(canonicalJson({
      record: "summary",
      exportedAt: "2026-09-26T00:30:00.000Z",
      bundles: bundles ?? records.filter((record) => record.record === "bundle").length,
      excludedInactiveSigner,
      rejections: records.filter((record) => record.record === "rejection").length,
    }));
  }
  return `${lines.join("\n")}\n`;
}

function importExport(fx, text, options = {}) {
  return importHarnessFeedbackExport({
    rootDir: fx.root,
    exportText: text,
    providerKeyFingerprint: fx.provider.keyId,
    codeRoot: fx.codeRoot,
    privacyContext: fx.privacy,
    now: () => IMPORTED_AT,
    ...options,
  });
}

test("正常な書き出しを照合して隔離へ置き、2回目以降は新しい行だけを置く（取り込み済みは数えるだけ）", async (t) => {
  const fx = fixture(t);
  await enrollAuto(fx);
  const first = sign(payload(), fx.operator);
  const firstExport = exportText([bundleLine(first, fx.provider), rejectionLine()], { excludedInactiveSigner: 2 });

  const result1 = await importExport(fx, firstExport);
  assert.equal(result1.ok, true, JSON.stringify(result1.issues));
  assert.equal(result1.mode, "write");
  assert.deepEqual(
    { quarantined: result1.counts.quarantined, alreadyImported: result1.counts.alreadyImported, rejected: result1.counts.rejected },
    { quarantined: 1, alreadyImported: 0, rejected: 0 },
  );
  assert.deepEqual(result1.providerReceipts, { fingerprint: fx.provider.keyId, verified: 1, unverified: 0 });
  assert.equal(result1.summary.bundlesMatch, true);
  assert.equal(result1.summary.excludedInactiveSigner, 2, "失効・停止で出なかった件数は記録するだけ");
  assert.deepEqual(result1.receiverRejections, { lines: 1, byCode: { FEEDBACK_SIGNATURE_INVALID: 1 } });
  const digestA = autoFeedbackBundleDigest(first);
  assert.equal(result1.bundles[0].bundleDigest, digestA);
  assert.equal(result1.bundles[0].catalogMatchedCandidates, 1);
  assert.equal(result1.bundles[0].unregisteredCandidates, 1);

  const candidate = JSON.parse(fs.readFileSync(path.join(fx.root, "curation", `${digestA}.json`), "utf8"));
  assert.equal(candidate.status, "verified-quarantine");
  assert.equal(candidate.ownerApprovalRequired, true);
  assert.deepEqual(candidate.catalogMatchedCandidates.map((entry) => entry.candidateId), [KNOWN_CANDIDATE.id]);
  assert.equal(candidate.catalogMatchedCandidates[0].generalizedText, undefined, "catalog にある候補の文は捨てる（手順 8）");
  assert.deepEqual(candidate.unregisteredCandidates.map((entry) => entry.generalizedText), [CANDIDATE_TEXT]);
  const record1 = fs.readFileSync(result1.recordPath, "utf8");
  assert.equal(path.dirname(result1.recordPath), path.join(fx.root, HARNESS_FEEDBACK_EXPORT_IMPORT_DIR));
  assert.equal(record1.includes(GENERAL_TEXT) || record1.includes(CANDIDATE_TEXT), false, "取り込みの記録へ本文を写さない");

  // 書き出しは毎回「保持期限内の全件」。前回の行と新しい行が一緒に来る。
  const second = sign(payload({ source: "source-2", generatedAt: "2026-09-26T00:10:00.000Z" }), fx.operator);
  const secondExport = exportText([bundleLine(first, fx.provider), bundleLine(second, fx.provider, { receivedAt: "2026-09-26T00:20:00.000Z" })]);
  const result2 = await importExport(fx, secondExport, { now: () => "2026-09-26T02:00:00.000Z" });
  assert.equal(result2.ok, true);
  assert.deepEqual(result2.bundles.map((entry) => entry.outcome), ["already-imported", "quarantined"]);
  assert.equal(listFiles(path.join(fx.root, "curation")).length, 2, "新しい行だけが隔離へ入る");
  const receiptA = fs.readFileSync(path.join(fx.root, "receipts", `${digestA}.json`), "utf8");

  const result3 = await importExport(fx, secondExport, { now: () => "2026-09-26T03:00:00.000Z" });
  assert.equal(result3.ok, true);
  assert.deepEqual({ quarantined: result3.counts.quarantined, alreadyImported: result3.counts.alreadyImported }, { quarantined: 0, alreadyImported: 2 });
  assert.equal(fs.readFileSync(path.join(fx.root, "receipts", `${digestA}.json`), "utf8"), receiptA, "取り込み済みの記録を書き換えない");

  // 前回の bundle が次の書き出しに出てこなくても（保持期限切れ・鍵の失効）、取り込み済みの記録は消さない。
  const result4 = await importExport(fx, exportText([]), { now: () => "2026-09-26T04:00:00.000Z" });
  assert.equal(result4.ok, true);
  assert.equal(listFiles(path.join(fx.root, "curation")).length, 2);
  assert.equal(listFiles(path.join(fx.root, HARNESS_FEEDBACK_EXPORT_IMPORT_DIR)).length, 4, "回ごとに取り込みの記録を残す");

  // 隔離から先は既存の owner の承認だけ。承認した bundle だけが curator の観測になる。
  const decision = await decideHarnessFeedbackBundle({
    rootDir: fx.root, bundleDigest: digestA, decision: "approve", approvedBy: OWNER, reason: "合成の決着と既知の提案だけを確認した",
  });
  assert.equal(decision.decision, "approve");
  const ledger = await loadHarnessFeedbackImportLedger({ rootDir: fx.root });
  assert.equal(ledger.approved.length, 1);
  const approved = ledger.approved[0];
  assert.equal(approved.bundleDigest, digestA);
  assert.deepEqual(approved.proposalObservations.map((entry) => [entry.proposalId, entry.occurrences]), [
    [KNOWN_PROPOSAL.id, 1],
    [KNOWN_CANDIDATE.id, 1],
  ]);
  assert.deepEqual(approved.gateObservations.map((gate) => [gate.gateId, gate.pass, gate.fail]), [["gate-alpha", 1, 0], ["gate-beta", 0, 1]]);
  assert.equal(JSON.stringify(approved).includes(CANDIDATE_TEXT), false, "catalog に無い候補の文は承認しても観測へ入れない");
});

test("照合に落ちた bundle は理由のコードつきで記録し、隔離へ入れない", async (t) => {
  const fx = fixture(t);
  await enrollAuto(fx);
  const revokedPair = keys();
  await enrollAuto(fx, revokedPair, "operator-synthetic-b");
  await revokeHarnessFeedbackOperator({ rootDir: fx.root, operatorId: "operator-synthetic-b", revokedBy: OWNER, reason: "合成の運営者の端末を手放した", revokedAt: RECEIVED_AT });
  const manualPair = keys();
  await enrollHarnessFeedbackOperator({
    rootDir: fx.root,
    operatorId: "operator-synthetic-c",
    publicKeyPem: manualPair.publicKeyPem,
    allowedBuilds: [{ coreVersion: "0.1.27", harnessId: "narrated-story-video", harnessVersion: "1.0.0", skillDigests: [], channelPack: { id: "synthetic-pack", version: "1.0.0", payloadSha256: sha("pack") } }],
    approvedBy: OWNER,
    enrolledAt: RECEIVED_AT,
  });
  const strangerPair = keys();
  const otherProvider = keys();

  const good = sign(payload(), fx.operator);
  const tampered = { ...sign(payload({ source: "source-sig" }), fx.operator) };
  tampered.signature = `${tampered.signature.startsWith("A") ? "B" : "A"}${tampered.signature.slice(1)}`;
  const withUndeclaredGate = sign(payload({ source: "source-gate", gates: [{ gateId: "gate-alpha", verdict: "pass" }, { gateId: "gate-gamma", verdict: "fail" }] }), fx.operator, senderRegistry(["gate-gamma"]));
  const withUnknownProposal = sign(payload({ source: "source-catalog", proposals: [{ id: UNKNOWN_PROPOSAL_ID, kind: "fact", target: "platform:platform-craft", occurrences: 1, occurrenceDigests: [sha("occ-x")] }] }), fx.operator);
  const withMismatch = sign(payload({ source: "source-semantic", proposals: [{ ...KNOWN_PROPOSAL, kind: "correction", occurrences: 1, occurrenceDigests: [sha("occ-y")] }] }), fx.operator);
  const withPrivateTerm = sign(payload({
    source: "source-privacy",
    newCandidates: [{
      candidateId: UNKNOWN_CANDIDATE_ID, kind: "preference", target: "genre:narrated-story-video",
      generalizedText: `${PRIVATE_TERM} の案件では最終確認を二回に分けて行う。`,
      evidenceKinds: ["operator-preference"], occurrences: 1, occurrenceDigests: [sha("occ-z")],
    }],
  }), fx.operator);
  const replay = sign(payload({ generatedAt: "2026-09-25T23:59:00.000Z" }), fx.operator);
  const badReceipt = sign(payload({ source: "source-receipt" }), fx.operator);
  const receiptForOther = sign(payload({ source: "source-receipt-2" }), fx.operator);
  const signerMismatch = sign(payload({ source: "source-signer" }), fx.operator);

  const rows = [
    ["ok", bundleLine(good, fx.provider)],
    ["FEEDBACK_SIGNATURE_INVALID", bundleLine(tampered, fx.provider)],
    ["FEEDBACK_EXPORT_DIGEST_MISMATCH", bundleLine(sign(payload({ source: "source-digest" }), fx.operator), fx.provider, { bundleDigest: sha("another bundle") })],
    ["FEEDBACK_SIGNER_NOT_ENROLLED", bundleLine(sign(payload({ source: "source-stranger" }), strangerPair), fx.provider)],
    ["FEEDBACK_SIGNER_REVOKED", bundleLine(sign(payload({ source: "source-revoked" }), revokedPair), fx.provider)],
    ["FEEDBACK_SIGNER_KEY_USE_MISMATCH", bundleLine(sign(payload({ source: "source-manual" }), manualPair), fx.provider)],
    ["FEEDBACK_GATE_NOT_DECLARED", bundleLine(withUndeclaredGate, fx.provider)],
    ["FEEDBACK_PROPOSAL_NOT_REGISTERED", bundleLine(withUnknownProposal, fx.provider)],
    ["FEEDBACK_PROPOSAL_SEMANTIC_MISMATCH", bundleLine(withMismatch, fx.provider)],
    ["FEEDBACK_PRIVACY_BLOCKED", bundleLine(withPrivateTerm, fx.provider)],
    ["FEEDBACK_SOURCE_REPLAY_CONFLICT", bundleLine(replay, fx.provider)],
    ["FEEDBACK_PROVIDER_RECEIPT_INVALID", bundleLine(badReceipt, otherProvider)],
    ["FEEDBACK_PROVIDER_RECEIPT_INVALID", bundleLine(receiptForOther, fx.provider, {
      receipt: signProviderIngestReceipt({ bundleDigest: sha("different bundle"), receivedAt: RECEIVED_AT, privateKeyPem: fx.provider.privateKeyPem }),
    })],
    ["FEEDBACK_EXPORT_SIGNER_MISMATCH", { ...bundleLine(signerMismatch, fx.provider), signerKeyId: strangerPair.keyId }],
  ];
  // 署名の改ざんは、行の bundleDigest を改ざん後の bundle に合わせてある（digest の検査ではなく署名で落ちる）。
  assert.equal(rows[1][1].bundleDigest, autoFeedbackBundleDigest(tampered));
  const result = await importExport(fx, exportText(rows.map(([, line]) => line)));
  assert.equal(result.ok, true, "1件ずつの拒否は取り込み全体の失敗ではない");
  assert.deepEqual(result.bundles.map((entry) => entry.outcome === "rejected" ? entry.code : "ok"), rows.map(([code]) => code));
  for (const entry of result.bundles.filter((item) => item.outcome === "rejected")) {
    assert.ok(Object.hasOwn(EXPORT_IMPORT_REASON_CODES, entry.code), `${entry.code} は一覧にある理由のコード`);
  }
  assert.deepEqual(result.bundles[9].reasons, ["private-term"], "privacy は当たった語ではなく理由のコードだけを残す");
  assert.equal(result.counts.quarantined, 1);
  assert.equal(result.counts.rejected, rows.length - 1);
  assert.equal(result.rejectedByCode.FEEDBACK_PROVIDER_RECEIPT_INVALID, 2);
  assert.deepEqual(listFiles(path.join(fx.root, "curation")), [`${autoFeedbackBundleDigest(good)}.json`], "落ちた bundle は隔離へ入れない");
  assert.deepEqual(listFiles(path.join(fx.root, "accepted")), [`${autoFeedbackBundleDigest(good)}.json`]);
  const record = fs.readFileSync(result.recordPath, "utf8");
  assert.equal(record.includes(PRIVATE_TERM), false, "取り込みの記録へ当たった語を写さない");
  assert.equal(record.includes("gate-gamma"), false, "宣言に無い gate id は件数だけ残す");
});

test("summary の件数の不一致・summary 無しは記録して ok: false にする（行の取り込みは残る）", async (t) => {
  const fx = fixture(t);
  await enrollAuto(fx);
  const bundle = sign(payload(), fx.operator);
  const mismatch = await importExport(fx, exportText([bundleLine(bundle, fx.provider)], { bundles: 3 }));
  assert.equal(mismatch.ok, false);
  assert.deepEqual(mismatch.issues, ["FEEDBACK_EXPORT_SUMMARY_MISMATCH"]);
  assert.deepEqual({ bundles: mismatch.summary.bundles, read: mismatch.summary.bundleLinesRead, match: mismatch.summary.bundlesMatch }, { bundles: 3, read: 1, match: false });
  assert.equal(mismatch.counts.quarantined, 1, "件数の不一致は記録に出すだけで、照合を通った行は置く");

  const missing = await importExport(fx, exportText([bundleLine(bundle, fx.provider)], { summary: false }), { now: () => "2026-09-26T02:00:00.000Z" });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.issues, ["FEEDBACK_EXPORT_SUMMARY_MISSING"]);
  assert.equal(missing.counts.alreadyImported, 1);
});

test("壊れた行・未知の record・summary の後ろの行はその行で止め、どこまで取り込んだかを出す", async (t) => {
  const fx = fixture(t);
  await enrollAuto(fx);
  const first = sign(payload(), fx.operator);
  const second = sign(payload({ source: "source-2" }), fx.operator);
  const text = [
    canonicalJson(bundleLine(first, fx.provider)),
    "{\"record\":\"bundle\",",
    canonicalJson(bundleLine(second, fx.provider)),
  ].join("\n");
  const broken = await importExport(fx, text);
  assert.equal(broken.ok, false);
  assert.deepEqual(broken.stopped && { line: broken.stopped.line, code: broken.stopped.code, through: broken.stopped.processedThroughLine }, { line: 2, code: "FEEDBACK_EXPORT_LINE_INVALID", through: 1 });
  assert.deepEqual(broken.bundles.map((entry) => entry.outcome), ["quarantined"]);
  assert.equal(listFiles(path.join(fx.root, "curation")).length, 1, "止めた行より後ろは取り込まない");
  assert.ok(fs.existsSync(broken.recordPath), "止めたことも取り込みの記録に残す");

  const unknown = await importExport(fx, `${canonicalJson({ record: "annotation", note: "x" })}\n`, { now: () => "2026-09-26T02:00:00.000Z" });
  assert.equal(unknown.stopped.code, "FEEDBACK_EXPORT_RECORD_UNKNOWN");

  const extraField = { ...bundleLine(second, fx.provider), userId: "synthetic-user" };
  const shape = await importExport(fx, `${canonicalJson(extraField)}\n`, { now: () => "2026-09-26T03:00:00.000Z" });
  assert.equal(shape.stopped.code, "FEEDBACK_EXPORT_LINE_INVALID", "行の field が仕様と違えば止める");

  const afterSummary = `${exportText([])}${canonicalJson(bundleLine(second, fx.provider))}\n`;
  const trailing = await importExport(fx, afterSummary, { now: () => "2026-09-26T04:00:00.000Z" });
  assert.equal(trailing.stopped.code, "FEEDBACK_EXPORT_RECORD_AFTER_SUMMARY");
  assert.equal(listFiles(path.join(fx.root, "curation")).length, 1);
});

test("--dry-run は何も書かず、受領証の指紋が無いときは照合だけして隔離へ置かない", async (t) => {
  const fx = fixture(t);
  await enrollAuto(fx);
  const first = sign(payload(), fx.operator);
  const replay = sign(payload({ generatedAt: "2026-09-25T23:30:00.000Z" }), fx.operator);
  const text = exportText([bundleLine(first, fx.provider), bundleLine(first, fx.provider), bundleLine(replay, fx.provider)]);
  const before = listFiles(fx.root);

  const dry = await importExport(fx, text, { dryRun: true });
  assert.deepEqual(listFiles(fx.root), before, "dry-run は置き場に何も書かない");
  assert.equal(dry.mode, "dry-run");
  assert.equal(dry.recordPath, null);
  assert.deepEqual(dry.bundles.map((entry) => entry.outcome === "rejected" ? entry.code : entry.outcome), [
    "would-quarantine",
    "already-imported",
    "FEEDBACK_SOURCE_REPLAY_CONFLICT",
  ], "dry-run でも同じ回の中の重複と replay を見る");

  const unverified = await importExport(fx, text, { providerKeyFingerprint: "" });
  assert.equal(unverified.ok, false);
  assert.ok(unverified.issues.includes("FEEDBACK_PROVIDER_FINGERPRINT_REQUIRED"));
  assert.equal(unverified.mode, "unverified-no-write");
  // 受領証を確かめられなかった bundle は、その後の照合で落ちたもの（replay）も「未検証」に数える。
  assert.deepEqual(unverified.providerReceipts, { fingerprint: null, verified: 0, unverified: 2 });
  assert.equal(fs.existsSync(path.join(fx.root, "curation")), false, "指紋が無ければ隔離へ置かない");
  assert.equal(fs.existsSync(path.join(fx.root, "accepted")), false);
  assert.ok(fs.existsSync(unverified.recordPath), "未検証として取り込みの記録だけを残す");
});

test("取り込んだ記録の改変はその行で止める・承認後に鍵を失効すれば観測へ数えない", async (t) => {
  const fx = fixture(t);
  await enrollAuto(fx);
  const bundle = sign(payload(), fx.operator);
  const text = exportText([bundleLine(bundle, fx.provider)]);
  await importExport(fx, text);
  const digest = autoFeedbackBundleDigest(bundle);
  await decideHarnessFeedbackBundle({ rootDir: fx.root, bundleDigest: digest, decision: "approve", approvedBy: OWNER, reason: "合成の決着だけを確認した" });
  await revokeHarnessFeedbackOperator({ rootDir: fx.root, operatorId: "operator-synthetic-a", revokedBy: OWNER, reason: "合成の運営者の鍵が漏れた想定", revokedAt: IMPORTED_AT });
  const ledger = await loadHarnessFeedbackImportLedger({ rootDir: fx.root });
  assert.equal(ledger.approved.length, 0);
  assert.deepEqual(ledger.revokedAfterApproval.map((entry) => entry.bundleDigest), [digest]);

  const candidatePath = path.join(fx.root, "curation", `${digest}.json`);
  const candidate = JSON.parse(fs.readFileSync(candidatePath, "utf8"));
  candidate.unregisteredCandidates = [];
  fs.writeFileSync(candidatePath, JSON.stringify(candidate));
  const again = await importExport(fx, text, { now: () => "2026-09-26T02:00:00.000Z" });
  assert.equal(again.ok, false);
  assert.equal(again.stopped.code, "FEEDBACK_INGEST_STORAGE_TAMPER");
});

test("登録簿は後方互換: 既存の手動の鍵の行はそのまま読み、用途の違う鍵は互いに使えない", async (t) => {
  const fx = fixture(t);
  const manualPair = keys();
  const manual = await enrollHarnessFeedbackOperator({
    rootDir: fx.root,
    operatorId: "operator-synthetic-a",
    publicKeyPem: manualPair.publicKeyPem,
    allowedBuilds: [{ coreVersion: "0.1.25", harnessId: "narrated-story-video", harnessVersion: "1.2.0", skillDigests: ["c".repeat(64)], channelPack: { id: "synthetic-pack", version: "1.0.0", payloadSha256: "d".repeat(64) } }],
    approvedBy: OWNER,
    enrolledAt: RECEIVED_AT,
  });
  assert.equal(Object.hasOwn(manual.operator, "keyUse"), false, "手動の鍵の行は従来の形のまま");
  // 同じ operator が用途ごとに1本ずつ active な鍵を持てる。
  const auto = await enrollAuto(fx, fx.operator, "operator-synthetic-a");
  assert.equal(auto.operator.keyUse, HARNESS_FEEDBACK_KEY_USE_AUTO);
  assert.equal(Object.hasOwn(auto.operator, "allowedBuilds"), false);
  await assert.rejects(enrollAuto(fx, keys(), "operator-synthetic-a"), (error) => error?.code === "FEEDBACK_OPERATOR_ALREADY_ENROLLED");
  await assert.rejects(
    enrollHarnessFeedbackOperator({ rootDir: fx.root, operatorId: "operator-synthetic-z", publicKeyPem: keys().publicKeyPem, keyUse: HARNESS_FEEDBACK_KEY_USE_AUTO, allowedHarnessIds: [HARNESS], allowedBuilds: manual.operator.allowedBuilds, approvedBy: OWNER }),
    /allowedBuilds/u,
  );

  // 自動の bundle の鍵で署名した手動の bundle（v2）は受け付けない。
  const v2Payload = buildHarnessFeedbackPayload({
    curatorReport: { readOnly: true, pending: [], observedGates: [] },
    coreVersion: "0.1.25",
    harnessId: "narrated-story-video",
    harnessVersion: "1.2.0",
    skillDigests: ["c".repeat(64)],
    channelPack: { id: "synthetic-pack", version: "1.0.0", payloadSha256: "d".repeat(64) },
    sourceHost: "codex",
    generatedAt: RECEIVED_AT,
  });
  const v2WithAutoKey = await signHarnessFeedbackBundle({ payload: v2Payload, privateKeyPem: fx.operator.privateKeyPem });
  await assert.rejects(ingestHarnessFeedbackBundle({ rootDir: fx.root, bundle: v2WithAutoKey }), (error) => error?.code === "FEEDBACK_SIGNER_NOT_ENROLLED");

  // 用途の違う active な鍵が2本あるとき、どちらを失効するかは推測しない。
  await assert.rejects(
    revokeHarnessFeedbackOperator({ rootDir: fx.root, operatorId: "operator-synthetic-a", revokedBy: OWNER, reason: "失効対象を明示しない失効" }),
    (error) => error?.code === "FEEDBACK_OPERATOR_REVOKE_AMBIGUOUS",
  );
  const revoked = await revokeHarnessFeedbackOperator({ rootDir: fx.root, operatorId: "operator-synthetic-a", keyId: fx.operator.keyId, revokedBy: OWNER, reason: "自動の bundle の鍵だけを失効する" });
  assert.equal(revoked.operator.keyId, fx.operator.keyId);
});

test("先方の見本（make_sender_vectors.mjs）が使う関数の名前と形を変えていない", async (t) => {
  // 見本は lib/harnessFeedbackAutoBundle.mjs と lib/channelPackEnvelope.mjs を import する。
  for (const name of [
    "signAutoFeedbackBundle",
    "autoFeedbackBundleDigest",
    "signProviderIngestReceipt",
    "verifyAutoFeedbackBundle",
    "validateAutoFeedbackBundleForTransport",
    "normalizeAutoFeedbackPayload",
  ]) {
    assert.equal(typeof autoBundle[name], "function", `${name} が export されている`);
  }
  assert.equal(typeof canonicalJson, "function");
  assert.equal(typeof publicKeyId, "function");

  // 見本と同じく、ラベルの SHA-256 を seed にした鍵と、Map で渡す宣言で作る（ラベルは合成）。
  const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  const keyFromLabel = (label) => createPrivateKey({ key: Buffer.concat([pkcs8Prefix, createHash("sha256").update(label).digest()]), format: "der", type: "pkcs8" });
  const operatorKey = keyFromLabel("synthetic-feedback-test-operator-key");
  const providerKey = keyFromLabel("synthetic-feedback-test-provider-key");
  const operatorPem = operatorKey.export({ type: "pkcs8", format: "pem" }).toString();
  const providerPem = providerKey.export({ type: "pkcs8", format: "pem" }).toString();
  const operatorPublicPem = createPublicKey(operatorKey).export({ type: "spki", format: "pem" }).toString();
  const gateIds = ["audio-loudness", "Voice-quality", "9x", "b.gate", "a-gate", "A_gate", "zeta", "Z9"];
  const registry = new Map([[HARNESS, { version: "1.0.0", gateIds: new Set(gateIds), declarationDigest: sha("decl") }]]);
  const settlementPayload = payload({ gates: gateIds.map((gateId, index) => ({ gateId, verdict: ["pass", "fail", "skip", "not-in-force"][index % 4] })) });
  settlementPayload.settlement.gateCounts = { declared: 8, pass: 2, fail: 2, skip: 2, notInForce: 2, missing: 0 };
  const candidateOnly = {
    ...settlementPayload,
    trigger: "manual",
    consent: { scopes: ["new-candidates"], consentDigest: sha("consent-2") },
    build: { coreVersion: "unknown", harnessId: null, harnessVersion: null, declarationDigest: null },
    settlement: null,
    proposals: [],
    newCandidates: [{ ...settlementPayload.newCandidates[1], candidateId: "fffffffffff6", generalizedText: "字幕の \"引用\" は使わず、改行もしない短い一文にする。" }],
  };
  // 孤立したサロゲートを含む文と、Date.parse が有効とみなす 24:00（見本の3件目と同じ種類の端）。
  const edgeCase = {
    ...candidateOnly,
    generatedAt: "2026-09-25T24:00:00.000Z",
    newCandidates: [{ ...candidateOnly.newCandidates[0], candidateId: "abcdefabcdef", generalizedText: `長い工程の前に${String.fromCharCode(0xd800)}空き容量を確かめてから始める。` }],
  };
  const lines = [];
  for (const value of [settlementPayload, candidateOnly, edgeCase]) {
    assert.doesNotThrow(() => autoBundle.normalizeAutoFeedbackPayload(value, { registry }));
    const bundle = autoBundle.signAutoFeedbackBundle({ payload: value, privateKeyPem: operatorPem, registry });
    autoBundle.verifyAutoFeedbackBundle({ bundle, trustedPublicKeyPem: operatorPublicPem, registry });
    const transport = autoBundle.validateAutoFeedbackBundleForTransport(bundle, { registry });
    const digest = autoBundle.autoFeedbackBundleDigest(bundle);
    assert.match(digest, /^[a-f0-9]{64}$/u);
    assert.equal(transport.digest, digest);
    const receipt = autoBundle.signProviderIngestReceipt({ bundleDigest: digest, duplicate: false, receivedAt: "2026-09-26T01:02:03.004Z", privateKeyPem: providerPem });
    assert.deepEqual(Object.keys(receipt).sort(), ["bundleDigest", "duplicate", "ok", "ownerApprovalRequired", "provider", "receivedAt", "signature", "status", "version"]);
    // 受け取り口は bundle を正規 JSON で保存し、書き出しで JSON として読み直して出す。
    const roundTripped = JSON.parse(canonicalJson(bundle));
    assert.equal(autoBundle.autoFeedbackBundleDigest(roundTripped), digest, "正規 JSON を読み直しても digest が変わらない");
    lines.push({ record: "bundle", bundleDigest: digest, operatorKeyId: RECEIVER_KEY_ROW, signerKeyId: bundle.signer.keyId, receivedAt: "2026-09-26T01:02:03.004Z", bundle: roundTripped, receipt });
  }

  // その3件を書き出しとして取り込めること（見本の宣言を取り込む側の宣言として渡す）。
  const fx = fixture(t);
  await enrollHarnessFeedbackOperator({ rootDir: fx.root, operatorId: "operator-synthetic-v", publicKeyPem: operatorPublicPem, keyUse: HARNESS_FEEDBACK_KEY_USE_AUTO, allowedHarnessIds: [HARNESS], approvedBy: OWNER });
  const result = await importHarnessFeedbackExport({
    rootDir: fx.root,
    exportText: exportText(lines),
    providerKeyFingerprint: publicKeyId(createPublicKey(providerKey)),
    codeRoot: fx.codeRoot,
    gateRegistry: registry,
    privacyContext: fx.privacy,
    now: () => IMPORTED_AT,
  });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.deepEqual(result.bundles.map((entry) => entry.outcome), ["quarantined", "quarantined", "quarantined"]);
});

test("CLI: import-export の dry-run・指紋なし・書き込みと、自動の bundle の鍵の enroll", async (t) => {
  const fx = fixture(t);
  const script = path.join(SOURCE_ROOT, "scripts", "harness-feedback-ingest.mjs");
  const env = { ...process.env, ...fx.env, HOME: fx.homeDir, USERPROFILE: fx.homeDir };
  const run = (args) => spawnSync(process.execPath, [script, ...args], { env, encoding: "utf8" });
  const publicKeyFile = write(path.join(fx.base, "operator.pub.pem"), fx.operator.publicKeyPem);
  const enrolled = run(["enroll", "--root", fx.root, "--operator", "operator-synthetic-a", "--public-key", publicKeyFile, "--key-use", "auto-feedback", "--allowed-harness-ids", HARNESS, "--approved-by", OWNER]);
  assert.equal(enrolled.status, 0, enrolled.stderr);
  assert.equal(JSON.parse(enrolled.stdout).operator.keyUse, "auto-feedback");

  const exportFile = write(path.join(fx.base, "feedback-export.jsonl"), exportText([bundleLine(sign(payload(), fx.operator), fx.provider)]));
  const common = ["import-export", "--root", fx.root, "--export", exportFile, "--code-root", fx.codeRoot];
  const before = listFiles(fx.root);
  const dry = run([...common, "--provider-key-fingerprint", fx.provider.keyId, "--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).counts.wouldQuarantine, 1);
  assert.deepEqual(listFiles(fx.root), before, "CLI の dry-run も何も書かない");

  const unverified = run(common);
  assert.equal(unverified.status, 2);
  assert.ok(JSON.parse(unverified.stdout).issues.includes("FEEDBACK_PROVIDER_FINGERPRINT_REQUIRED"));

  const written = run([...common, "--provider-key-fingerprint", fx.provider.keyId]);
  assert.equal(written.status, 0, written.stderr);
  assert.equal(JSON.parse(written.stdout).counts.quarantined, 1);
});
