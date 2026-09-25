// ホストの記録（invocation）つきの RunReceipt を合成する試験用の部品。値は全て合成で、
// 実在のホストの版・会話・端末の場所は入れない。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { finalizeRunReceipt, openRunReceipt, recordGate } from "../../lib/harnessRunReceipt.mjs";

export const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const HARNESS = "narrated-story-video";

/** 過去の schema revision の実例（test/fixtures/run-receipt-past-schema-revisions.json）。 */
export const PAST_REVISIONS = JSON.parse(fs.readFileSync(
  path.join(SOURCE_ROOT, "test", "fixtures", "run-receipt-past-schema-revisions.json"),
  "utf8",
));

/** 1回の呼び出しの記録（既定は MCP 経由の Claude Code、実行、モデルは宣言あり）。 */
export function hostCall(overrides = {}) {
  return {
    host: "claude-code",
    hostVersion: "9.9.1",
    clientName: "claude-code",
    candidates: [],
    model: "synthetic-model-a",
    modelSource: "caller-declared",
    buzzassistVersion: "0.1.27",
    via: "mcp",
    detectedFrom: "mcp-client-info",
    operation: "start",
    mode: "execute",
    at: "2026-09-25T00:00:00.000Z",
    ...overrides,
  };
}

export function invocationRecord(createdBy, resumedBy = []) {
  return { version: "buzzassist-host-invocation-v1", createdBy, resumedBy };
}

/** 宣言された全ゲートに合成の判定を付けて閉じた Receipt。failing のゲートだけ不合格。 */
export function finalizedReceipt(invocation, {
  failing = [],
  runStartedAt = "2026-09-25T00:00:00.000Z",
  finalizedAt = "2026-09-25T00:10:00.000Z",
  receiptOnlyRetry = false,
} = {}) {
  const receipt = openRunReceipt({
    projectDir: SOURCE_ROOT,
    harnessId: HARNESS,
    entrypoint: "scripts/run-video-harness.mjs",
    action: "full",
    inputs: { scriptSha256: "2".repeat(64) },
    invocation,
    timing: { jobCreatedAt: "2026-09-24T00:00:00.000Z", runStartedAt, receiptOnlyRetry },
  });
  for (const id of receipt.harnessBuild.declaredGates) {
    recordGate(receipt, { id, verdict: failing.includes(id) ? "fail" : "pass", evidence: { synthetic: id } });
  }
  return finalizeRunReceipt(receipt, { outcome: failing.length ? "fail" : "pass", timestamp: finalizedAt });
}
