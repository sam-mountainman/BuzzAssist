// RunReceipt の schema revision 2（invocation と timing）の試験。ホストの欄の改変を digest で
// 検出し、欄の無い過去の版の記録は従来どおり通ること。値は全て合成。
import assert from "node:assert/strict";
import test from "node:test";

import {
  RUN_RECEIPT_INVOCATION_IN_FORCE_SINCE,
  RUN_RECEIPT_SCHEMA_REVISION,
  RUN_RECEIPT_SKILL_APPROVAL_IN_FORCE_SINCE,
  RUN_RECEIPT_STAGE_TIMINGS_IN_FORCE_SINCE,
  RUN_RECEIPT_VERSION,
  redactForPlatform,
  runReceiptHostSummary,
  verifyRunReceiptInvocation,
  verifyRunReceiptSkillApproval,
} from "../lib/harnessRunReceipt.mjs";
import { PAST_REVISIONS, finalizedReceipt, hostCall, invocationRecord } from "./fixtures/hostInvocationFixtures.mjs";

test("Receipt は invocation を持つ版を名乗り、ホストの欄の改変を digest で検出する。ホストは入力の digest に入らない", () => {
  const record = invocationRecord(hostCall(), [
    hostCall({ host: "codex", hostVersion: "9.9.2", clientName: "codex-mcp-client", model: "unknown", modelSource: "unavailable", operation: "resume" }),
  ]);
  const receipt = finalizedReceipt(record, { runStartedAt: "2026-09-25T00:00:00.000Z", finalizedAt: "2026-09-25T00:12:30.000Z" });
  assert.equal(receipt.version, RUN_RECEIPT_VERSION, "系列名は変えない（Canvas 投影と学習の索引が完全一致で読む）");
  assert.equal(receipt.schemaRevision, RUN_RECEIPT_SCHEMA_REVISION);
  assert.equal(receipt.invocation.createdBy.host, "claude-code");
  assert.deepEqual(receipt.invocation.resumedBy.map((row) => row.host), ["codex"]);
  assert.equal(receipt.timing.durationSeconds, 750);
  assert.match(receipt.harnessBuild.platform["lib/harnessHostProvenance.mjs"] || "", /^[0-9a-f]{64}$/u, "ホストの判定の版も指紋に入る");
  assert.deepEqual(verifyRunReceiptInvocation(receipt), { ok: true, status: "recorded", revision: RUN_RECEIPT_SCHEMA_REVISION, failures: [] });
  assert.equal(runReceiptHostSummary(receipt).hostKey, "claude-code+codex");

  // 同じ入力なら、どのホストから動かしても inputDigests は同じ（Job の同一性と同じく、ホストで分かれない）。
  const other = finalizedReceipt(invocationRecord(hostCall({ host: "codex", clientName: "codex-mcp-client" })));
  assert.deepEqual(other.inputDigests, receipt.inputDigests);
  assert.equal(JSON.stringify(receipt.inputDigests).includes("claude-code"), false);

  const tamper = (mutate) => {
    const copy = structuredClone(receipt);
    mutate(copy);
    return verifyRunReceiptInvocation(copy);
  };
  assert.deepEqual(tamper((copy) => { copy.invocation.createdBy.host = "codex"; }).failures, ["invocation-digest-mismatch"]);
  assert.deepEqual(tamper((copy) => {
    copy.invocation.resumedBy[0].model = "synthetic-model-b";
    copy.invocation.resumedBy[0].modelSource = "caller-declared";
  }).failures, ["invocation-digest-mismatch"]);
  assert.deepEqual(tamper((copy) => { copy.invocation.resumedBy = []; }).failures, ["invocation-digest-mismatch"]);
  assert.ok(tamper((copy) => { copy.invocation.createdBy.host = "elsewhere"; }).failures.includes("invocation-entry-invalid"));
  assert.deepEqual(tamper((copy) => { delete copy.invocation; }).failures, ["invocation-missing"]);
  assert.deepEqual(tamper((copy) => { copy.schemaRevision = RUN_RECEIPT_SCHEMA_REVISION + 1; }).failures, ["schema-revision-unsupported"]);
  // 版を消して「当時は記録しなかった」に見せかけても、invocation が残っていれば形が合わない。
  assert.deepEqual(tamper((copy) => { delete copy.schemaRevision; }).failures, ["invocation-in-legacy-revision"]);

  // 記録を渡されなかった Receipt（Koya の最終監査の子 Receipt など）は、推測せず unknown。
  const unprovided = finalizedReceipt(null);
  assert.equal(unprovided.invocation.createdBy, null);
  assert.equal(verifyRunReceiptInvocation(unprovided).ok, true);
  assert.equal(runReceiptHostSummary(unprovided).hostKey, "unknown");

  const shared = redactForPlatform(receipt);
  assert.equal(shared.host.hostKey, "claude-code+codex");
  assert.equal(shared.durationSeconds, 750);
});

test("過去の版の Receipt は従来どおり検証が通り、ホストは unrecorded と読む", () => {
  const revisions = Object.keys(PAST_REVISIONS.revisions).map(Number).sort((a, b) => a - b);
  for (let revision = 1; revision < RUN_RECEIPT_SCHEMA_REVISION; revision += 1) {
    assert.ok(revisions.includes(revision), `schema revision ${revision} の実例を test/fixtures/run-receipt-past-schema-revisions.json に足すこと`);
  }
  assert.equal(RUN_RECEIPT_INVOCATION_IN_FORCE_SINCE, 2);
  for (const revision of revisions) {
    const receipt = PAST_REVISIONS.revisions[String(revision)];
    const verdict = verifyRunReceiptInvocation(receipt);
    assert.equal(verdict.ok, true, `revision ${revision}: ${verdict.failures.join(", ")}`);
    if (revision < RUN_RECEIPT_INVOCATION_IN_FORCE_SINCE) {
      assert.equal(verdict.status, "not-in-force");
      assert.equal(runReceiptHostSummary(receipt).hostKey, "unrecorded");
      assert.equal(redactForPlatform(receipt).host.hostKey, "unrecorded");
    } else {
      // ホストの記録がある版は、当時の記録どおりに読む（後から unrecorded へ落とさない）。
      assert.equal(verdict.status, "recorded");
      assert.notEqual(runReceiptHostSummary(receipt).hostKey, "unrecorded");
    }
    assert.equal(redactForPlatform(receipt).durationSeconds, null);
    // 工程ごとの内訳（timing.stages）は版 3 から。それより前の記録は空の内訳として読み、版 3 以降は当時の記録どおり読む。
    if (revision < RUN_RECEIPT_STAGE_TIMINGS_IN_FORCE_SINCE) assert.deepEqual(redactForPlatform(receipt).stageDurations, []);
    else assert.ok(redactForPlatform(receipt).stageDurations.length > 0, `revision ${revision}: 工程ごとの内訳を読めていない`);
    // 正本スキルの承認の状態（skillApproval）は版 4 から。それより前の記録は「当時は記録しなかった」。
    if (revision < RUN_RECEIPT_SKILL_APPROVAL_IN_FORCE_SINCE) {
      assert.deepEqual(verifyRunReceiptSkillApproval(receipt), { ok: true, status: "not-in-force", revision, failures: [] });
      assert.equal(redactForPlatform(receipt).skillApproval.recorded, false);
    }
  }
});
