// RunReceipt の schema revision 4（skillApproval: 正本スキルの人の承認の状態）の試験。
// 開発用チェックアウトで承認前の正本スキルのまま作った事実を、止めずに読める形で残す。値は全て合成。
import assert from "node:assert/strict";
import test from "node:test";

import {
  RUN_RECEIPT_SCHEMA_REVISION,
  RUN_RECEIPT_SKILL_APPROVAL_IN_FORCE_SINCE,
  RUN_RECEIPT_SKILL_APPROVAL_VERSION,
  finalizeRunReceipt,
  openRunReceipt,
  recordGate,
  redactForPlatform,
  runReceiptSkillApprovalSummary,
  verifyRunReceiptSkillApproval,
} from "../lib/harnessRunReceipt.mjs";
import { SOURCE_ROOT } from "./fixtures/hostInvocationFixtures.mjs";

// lib/videoHarnessProductionProfile.mjs の SKILL_APPROVAL_RECORD_VERSION（Receipt は形だけを見て写す）。
const SKILL_APPROVAL_RECORD_VERSION = "buzzassist-skill-approval-record-v1";

// lib/videoHarnessProductionProfile.mjs が Job に残す形（productionProfile.skillApproval）。
function profileRecord({ checkout = "development", unapprovedSkills = null } = {}) {
  const rows = unapprovedSkills ?? [
    { id: "buzzassist:sample-genre", version: "1.2.0", sha256: "b".repeat(64), approvalState: "stale" },
    { id: "buzzassist:sample-craft", version: "0.3.0", sha256: "a".repeat(64), approvalState: "none" },
  ];
  return { version: SKILL_APPROVAL_RECORD_VERSION, checkout, builtWithUnapprovedSkills: rows.length > 0, unapprovedSkills: rows };
}

function receiptWith(skillApproval) {
  const receipt = openRunReceipt({
    projectDir: SOURCE_ROOT,
    harnessId: "narrated-story-video",
    entrypoint: "scripts/run-video-harness.mjs",
    action: "full",
    inputs: { scriptSha256: "5".repeat(64) },
    skillApproval,
    timing: { jobCreatedAt: "2026-09-26T00:00:00.000Z", runStartedAt: "2026-09-26T00:00:00.000Z" },
  });
  for (const id of receipt.harnessBuild.declaredGates) recordGate(receipt, { id, verdict: "pass", evidence: { synthetic: id } });
  return finalizeRunReceipt(receipt, { outcome: "pass", timestamp: "2026-09-26T00:05:00.000Z" });
}

test("承認前の正本スキルで作った事実を、スキルの id・版・sha256 で残し、改変を digest で検出する", () => {
  assert.equal(RUN_RECEIPT_SCHEMA_REVISION, 4);
  assert.equal(RUN_RECEIPT_SKILL_APPROVAL_IN_FORCE_SINCE, 4);
  const receipt = receiptWith(profileRecord());
  assert.equal(receipt.schemaRevision, 4);
  assert.equal(receipt.skillApproval.version, RUN_RECEIPT_SKILL_APPROVAL_VERSION);
  assert.equal(receipt.skillApproval.recorded, true);
  assert.equal(receipt.skillApproval.checkout, "development");
  assert.equal(receipt.skillApproval.builtWithUnapprovedSkills, true);
  assert.deepEqual(receipt.skillApproval.unapprovedSkills.map((row) => row.id), ["buzzassist:sample-craft", "buzzassist:sample-genre"], "id 順に並べる");
  assert.deepEqual(verifyRunReceiptSkillApproval(receipt), { ok: true, status: "recorded", revision: 4, failures: [] });
  // 承認前の正本で作っても、Receipt の合否は変えない（止めずに記録する）。
  assert.equal(receipt.outcome, "pass");
  // 承認の状態は入力の digest に入れない（同じ入力・同じ Job の記録が承認で別物にならない）。
  assert.equal(JSON.stringify(receipt.inputDigests).includes("sample-craft"), false);

  const tamper = (mutate) => {
    const copy = structuredClone(receipt);
    mutate(copy);
    return verifyRunReceiptSkillApproval(copy);
  };
  assert.deepEqual(tamper((copy) => { copy.skillApproval.builtWithUnapprovedSkills = false; }).failures, ["skill-approval-not-normal", "skill-approval-digest-mismatch"]);
  assert.ok(tamper((copy) => { copy.skillApproval.unapprovedSkills = []; }).failures.includes("skill-approval-not-normal"), "未承認のスキルを消しても通った");
  assert.ok(tamper((copy) => { copy.skillApproval.checkout = "distributed"; }).failures.includes("skill-approval-digest-mismatch"));
  assert.deepEqual(tamper((copy) => { delete copy.skillApproval; }).failures, ["skill-approval-missing"]);
  assert.deepEqual(tamper((copy) => { copy.schemaRevision = 3; }).failures, ["skill-approval-in-legacy-revision"], "版を下げて「当時は記録しなかった」に見せかけられない");

  const shared = redactForPlatform(receipt);
  assert.deepEqual(shared.skillApproval, runReceiptSkillApprovalSummary(receipt));
  assert.equal(shared.skillApproval.builtWithUnapprovedSkills, true);
  assert.equal(JSON.stringify(shared.skillApproval).includes("/"), false, "パスを持たない");
});

test("承認済みの写し・記録を渡されなかった Receipt・形の崩れた記録", () => {
  const clean = receiptWith(profileRecord({ checkout: "distributed", unapprovedSkills: [] }));
  assert.equal(clean.skillApproval.builtWithUnapprovedSkills, false);
  assert.equal(verifyRunReceiptSkillApproval(clean).status, "recorded");

  // Koya の最終監査の子 Receipt のように、記録を渡されなかったものは推測で埋めない。
  const unprovided = receiptWith(null);
  assert.deepEqual(
    { recorded: unprovided.skillApproval.recorded, checkout: unprovided.skillApproval.checkout, built: unprovided.skillApproval.builtWithUnapprovedSkills },
    { recorded: false, checkout: "", built: null },
  );
  assert.deepEqual(verifyRunReceiptSkillApproval(unprovided), { ok: true, status: "unrecorded", revision: 4, failures: [] });
  assert.equal(redactForPlatform(unprovided).skillApproval.recorded, false);

  // builtWithUnapprovedSkills の申告は信じず、未承認のスキルの列から導く。
  const understated = receiptWith({ ...profileRecord(), builtWithUnapprovedSkills: false });
  assert.equal(understated.skillApproval.builtWithUnapprovedSkills, true);

  for (const broken of [
    { ...profileRecord(), checkout: "somewhere" },
    { ...profileRecord(), unapprovedSkills: [{ id: "buzzassist:x", version: "1.0.0", sha256: "not-a-sha", approvalState: "stale" }] },
    { ...profileRecord(), unapprovedSkills: [{ id: "buzzassist:x", version: "1.0.0", sha256: "c".repeat(64), approvalState: "current" }] },
    { ...profileRecord(), unapprovedSkills: "none" },
  ]) {
    assert.throws(() => receiptWith(broken), /skillApproval/u, JSON.stringify(broken));
  }
});
