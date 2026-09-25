import assert from "node:assert/strict";
import test from "node:test";

import {
  RUN_RECEIPT_CODE_IDENTITY_IN_FORCE_SINCE,
  RUN_RECEIPT_CODE_IDENTITY_VERSION,
  RUN_RECEIPT_SCHEMA_REVISION,
  finalizeRunReceipt,
  openRunReceipt,
  recordGate,
  redactForPlatform,
  runReceiptCodeIdentitySummary,
  verifyRunReceiptCodeIdentity,
} from "../lib/harnessRunReceipt.mjs";
import { PAST_REVISIONS, SOURCE_ROOT } from "./fixtures/hostInvocationFixtures.mjs";

// コードの同一性の要約（lib/videoHarnessUpdateFinalize.mjs の codeIdentitySummary と同じ形）。値は全て合成。
function summary(seed, { coreVersion = "0.1.27", contractVersion = "" } = {}) {
  return {
    digest: seed.repeat(64),
    coreVersion,
    coreSha256: "c".repeat(64),
    runtimeDependenciesDigest: seed.repeat(64),
    deploymentDependenciesDigest: seed.repeat(64),
    harnessDeclarationSha256: "d".repeat(64),
    deploymentEntrypointSha256: "e".repeat(64),
    productionContract: contractVersion ? { contractVersion, contractDigest: "f".repeat(64) } : null,
    skills: [{ id: "synthetic-genre-skill", sha256: "9".repeat(64) }],
  };
}

function crossedRecord() {
  const planned = summary("1", { coreVersion: "0.1.27", contractVersion: "synthetic-contract-v1" });
  const finalized = summary("2", { coreVersion: "0.1.28", contractVersion: "synthetic-contract-v2" });
  return {
    planned,
    finalized,
    rebinds: [{ at: "2026-09-26T00:00:00.000Z", from: planned, to: finalized, inputIdentityDigest: "7".repeat(64) }],
    pinnedProductionContract: { contractVersion: "synthetic-contract-v1", contractDigest: "f".repeat(64) },
    inputIdentityDigest: "7".repeat(64),
    finalizeRuns: [{ refusedPaidCalls: 0, mediaJobs: { reused: 12, recovered: 0, reissued: 0, issued: 0, carried: 1 } }],
  };
}

function receiptWith(codeIdentity) {
  const receipt = openRunReceipt({
    projectDir: SOURCE_ROOT,
    harnessId: "narrated-story-video",
    entrypoint: "scripts/run-video-harness.mjs",
    action: "full",
    inputs: { scriptSha256: "5".repeat(64) },
    codeIdentity,
    timing: { jobCreatedAt: "2026-09-26T00:00:00.000Z", runStartedAt: "2026-09-26T00:00:00.000Z" },
  });
  for (const id of receipt.harnessBuild.declaredGates) recordGate(receipt, { id, verdict: "pass", evidence: { synthetic: id } });
  return finalizeRunReceipt(receipt, { outcome: "pass", timestamp: "2026-09-26T00:05:00.000Z" });
}

test("更新をまたいで確定した事実と、計画と確定のコードの同一性（版・SHA）を digest つきで残す", () => {
  assert.ok(RUN_RECEIPT_SCHEMA_REVISION >= 5);
  assert.equal(RUN_RECEIPT_CODE_IDENTITY_IN_FORCE_SINCE, 5);
  const receipt = receiptWith(crossedRecord());
  const section = receipt.codeIdentity;
  assert.equal(receipt.schemaRevision, RUN_RECEIPT_SCHEMA_REVISION);
  assert.equal(section.version, RUN_RECEIPT_CODE_IDENTITY_VERSION);
  assert.equal(section.recorded, true);
  assert.equal(section.crossedUpdate, true);
  assert.equal(section.planned.coreVersion, "0.1.27");
  assert.equal(section.finalized.coreVersion, "0.1.28");
  assert.deepEqual(section.rebinds.map((row) => [row.fromDigest, row.toDigest]), [["1".repeat(64), "2".repeat(64)]]);
  assert.equal(section.pinnedProductionContract.contractVersion, "synthetic-contract-v1");
  assert.deepEqual(section.reuseOnly, {
    runs: 1,
    refusedPaidCalls: 0,
    lastRun: { refusedPaidCalls: 0, mediaJobs: { reused: 12, recovered: 0, reissued: 0, issued: 0, carried: 1 } },
  });
  assert.deepEqual(verifyRunReceiptCodeIdentity(receipt), { ok: true, status: "recorded", revision: RUN_RECEIPT_SCHEMA_REVISION, failures: [] });
  // 入力の digest には入れない（同じ入力の Job の記録が、更新をまたいだかどうかで別物にならない）。
  assert.equal(JSON.stringify(receipt.inputDigests).includes("0.1.28"), false);

  const tamper = (mutate) => {
    const copy = structuredClone(receipt);
    mutate(copy);
    return verifyRunReceiptCodeIdentity(copy);
  };
  assert.ok(tamper((copy) => { copy.codeIdentity.crossedUpdate = false; }).failures.includes("code-identity-digest-mismatch"), "更新をまたいだ事実を書き換えて通った");
  assert.ok(tamper((copy) => { copy.codeIdentity.rebinds = []; }).failures.includes("code-identity-entry-invalid"), "付け替えの履歴を消して通った");
  assert.ok(tamper((copy) => { copy.codeIdentity.reuseOnly.refusedPaidCalls = 3; }).failures.includes("code-identity-digest-mismatch"));
  assert.deepEqual(tamper((copy) => { delete copy.codeIdentity; }).failures, ["code-identity-missing"]);
  assert.deepEqual(tamper((copy) => { copy.schemaRevision = 4; }).failures, ["code-identity-in-legacy-revision"], "版を下げて「当時は記録しなかった」に見せかけられない");

  const shared = redactForPlatform(receipt);
  assert.deepEqual(shared.codeIdentity, runReceiptCodeIdentitySummary(receipt));
  assert.equal(shared.codeIdentity.crossedUpdate, true);
  assert.equal(shared.codeIdentity.refusedPaidCalls, 0);
  assert.equal(JSON.stringify(shared.codeIdentity).includes("/"), false, "パスを持たない");
});

test("更新をまたいでいない記録・記録を渡されなかった記録・つながらない記録", () => {
  const same = summary("3");
  const plain = receiptWith({ planned: same, finalized: same, rebinds: [], inputIdentityDigest: "7".repeat(64) });
  assert.equal(plain.codeIdentity.crossedUpdate, false);
  assert.equal(plain.codeIdentity.reuseOnly, null);
  assert.equal(verifyRunReceiptCodeIdentity(plain).status, "recorded");

  const unprovided = receiptWith(null);
  assert.equal(unprovided.codeIdentity.recorded, false);
  assert.equal(verifyRunReceiptCodeIdentity(unprovided).status, "unrecorded");
  assert.equal(runReceiptCodeIdentitySummary(unprovided).recorded, false);

  // 履歴が無いのに計画と確定が違う・履歴が計画や確定とつながらない記録は、記録を開く前に止める。
  assert.throws(() => receiptWith({ planned: summary("3"), finalized: summary("4"), rebinds: [] }), /付け替えの履歴が無い/u);
  const broken = crossedRecord();
  broken.rebinds[0].to = summary("8");
  assert.throws(() => receiptWith(broken), /つながらない/u);
  assert.throws(() => receiptWith({ planned: { ...summary("3"), digest: "not-a-sha" }, finalized: summary("3") }), /SHA-256/u);
});

test("過去の版の Receipt は codeIdentity を当時の契約に無かったものとして通す", () => {
  const revisions = Object.keys(PAST_REVISIONS.revisions).map(Number).sort((a, b) => a - b);
  for (let revision = 1; revision < RUN_RECEIPT_SCHEMA_REVISION; revision += 1) {
    assert.ok(revisions.includes(revision), `schema revision ${revision} の実例を test/fixtures/run-receipt-past-schema-revisions.json に足すこと`);
  }
  for (const revision of revisions) {
    const receipt = PAST_REVISIONS.revisions[String(revision)];
    assert.deepEqual(verifyRunReceiptCodeIdentity(receipt), { ok: true, status: "not-in-force", revision, failures: [] });
    assert.equal(redactForPlatform(receipt).codeIdentity.recorded, false);
  }
});
