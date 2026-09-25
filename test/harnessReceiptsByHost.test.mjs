// RunReceipt のホスト別集計（rollup --by host）と、決着の索引のホストの欄の試験。
// Job・ハーネスの結果・ホストの版・モデル ID は全て合成で、一時ディレクトリだけを使う。
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { readReceiptIndex } from "../lib/harnessLearningState.mjs";
import { indexSettledJobReceipt } from "../lib/harnessReceiptLearning.mjs";
import { loadReceipts, rollup, rollupByHost } from "../scripts/harness-receipts.mjs";
import {
  HARNESS,
  PAST_REVISIONS,
  SOURCE_ROOT,
  finalizedReceipt,
  hostCall,
  invocationRecord,
} from "./fixtures/hostInvocationFixtures.mjs";

const execFile = promisify(execFileCallback);

function tempRoot(t, prefix) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("rollup --by host はハーネス × ホスト × 版で数え、片方のホストだけ低い組を警告する", () => {
  const claude = () => invocationRecord(hostCall());
  const codex = () => invocationRecord(hostCall({ host: "codex", hostVersion: "9.9.2", clientName: "codex-mcp-client", model: "synthetic-model-b" }));
  const weakGate = finalizedReceipt(claude()).harnessBuild.declaredGates[0];
  const entries = [
    // Claude Code: 4件とも合格。所要時間 10, 20, 30, 40 分。
    ...[10, 20, 30, 40].map((minutes, index) => ({
      file: `claude-${index}.json`,
      receipt: finalizedReceipt(claude(), { finalizedAt: new Date(Date.parse("2026-09-25T00:00:00.000Z") + minutes * 60_000).toISOString() }),
    })),
    // Codex: 4件中2件が同じゲートで不合格。Receipt の確定だけやり直した回は所要時間に数えない。
    { file: "codex-0.json", receipt: finalizedReceipt(codex(), { failing: [weakGate] }) },
    { file: "codex-1.json", receipt: finalizedReceipt(codex(), { failing: [weakGate] }) },
    { file: "codex-2.json", receipt: finalizedReceipt(codex()) },
    { file: "codex-3.json", receipt: finalizedReceipt(codex(), { receiptOnlyRetry: true, finalizedAt: "2026-09-27T00:00:00.000Z" }) },
    // Antigravity は1件だけ——少数の偶然をホストの差と言わない。
    { file: "antigravity.json", receipt: finalizedReceipt(invocationRecord(hostCall({ host: "antigravity", clientName: "antigravity-client" })), { failing: [weakGate] }) },
    // 混在（Claude Code で始め Codex で再開）はどちらの品質にも混ぜない。
    {
      file: "mixed.json",
      receipt: finalizedReceipt(invocationRecord(hostCall(), [hostCall({ host: "codex", clientName: "codex-mcp-client", operation: "resume" })]), { failing: [weakGate] }),
    },
    // 別の版の BuzzAssist は別の組。
    { file: "other-version.json", receipt: finalizedReceipt(invocationRecord(hostCall({ buzzassistVersion: "0.1.28" }))) },
    // ホストを残す前の版の記録。
    { file: "legacy.json", receipt: PAST_REVISIONS.revisions["1"] },
  ];
  const tampered = structuredClone(entries[4].receipt);
  tampered.invocation.createdBy.host = "claude-code";
  entries.push({ file: "tampered.json", receipt: tampered });

  const result = rollupByHost(entries);
  const row = (host, version = "0.1.27") => result.groups.find((group) => group.host === host && group.buzzassistVersion === version);
  assert.equal(result.invalid, 1, "ホストの欄を書き換えた Receipt は数えない");
  assert.equal(row("claude-code").receipts, 4);
  assert.equal(row("claude-code").passRate, 1);
  assert.equal(row("claude-code").medianDurationSeconds, 1500, "10・20・30・40 分の中央値は 25 分");
  assert.deepEqual(row("claude-code").models, { "synthetic-model-a": 4 });
  assert.equal(row("codex").receipts, 4);
  assert.equal(row("codex").passRate, 0.5);
  assert.equal(row("codex").durationSamples, 3, "Receipt の確定だけやり直した回は中央値から外す");
  assert.equal(row("codex").worstGates[0].id, weakGate);
  assert.equal(row("codex").worstGates[0].fail, 2);
  assert.equal(row("claude-code+codex").receipts, 1);
  assert.equal(row("antigravity").receipts, 1);
  assert.equal(row("claude-code", "0.1.28").receipts, 1);
  const unrecorded = result.groups.find((group) => group.host === "unrecorded");
  assert.equal(unrecorded.receipts, 1, "過去の版の記録も数え、ホストは unrecorded");
  assert.equal(unrecorded.medianDurationSeconds, null);

  assert.deepEqual(result.warnings.map((warning) => [warning.code, warning.lowHost, warning.highHost, warning.gap, warning.lowWorstGates[0]]), [
    ["host-pass-rate-gap", "codex", "claude-code", 0.5, weakGate],
  ]);
  assert.deepEqual(result.skippedComparisons.map((skip) => skip.hosts.map((host) => host.host)), [["antigravity"]]);

  // 閾値を上げれば警告は出ない。最少件数を下げれば Antigravity も比べる。
  assert.equal(rollupByHost(entries, { gap: 0.6 }).warnings.length, 0);
  assert.ok(rollupByHost(entries, { minRuns: 1 }).warnings.some((warning) => warning.lowHost === "antigravity"));

  // 既定の rollup にもホスト別の小計と警告が並び、過去の版の記録は版ごとの表にも入る。
  const summary = rollup(entries);
  assert.equal(summary.invalid, 1);
  assert.ok(summary.hostSubtotals.some((group) => group.host === "codex" && group.passRate === 0.5));
  assert.equal(summary.hostWarnings.length, 1);
  const legacyOnly = rollup([{ file: "legacy.json", receipt: PAST_REVISIONS.revisions["1"] }]);
  assert.equal(legacyOnly.builds.length, 1);
  assert.equal(legacyOnly.builds[0].passed, 1);
  assert.equal(legacyOnly.invalid, 0);
});

test("索引の行にホストを足し、ホストの無い既存の行も読める。改変された Receipt は索引の sha256 か digest で外れる", async (t) => {
  const root = tempRoot(t, "host-receipts-index-");
  const receiptsDir = path.join(root, "state", "receipts");
  const indexPath = path.join(receiptsDir, "index.jsonl");
  const projectDir = path.join(root, "project");
  const write = (jobId, receipt) => {
    const file = path.join(projectDir, "canvas", "harness-runs", jobId, "run-receipt.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
    fs.writeFileSync(file, bytes);
    return { file, digest: sha256(bytes), receipt };
  };

  // 既存の行（ホストの欄が無い版で積んだ行）をそのまま置く。
  const legacy = write("video-synthetic-legacy-0000000000000001", PAST_REVISIONS.revisions["1"]);
  fs.mkdirSync(receiptsDir, { recursive: true });
  fs.writeFileSync(indexPath, `${JSON.stringify({
    version: "buzzassist-receipt-index-v1",
    jobId: "video-synthetic-legacy-0000000000000001",
    harnessId: HARNESS,
    status: "completed",
    receiptSource: "run-receipt",
    receiptPath: legacy.file,
    receiptSha256: legacy.digest,
    settledAt: "2026-09-20T01:00:00.000Z",
  })}\n`);

  // 端末で計画し、Codex から MCP で実行した Job。
  const invocation = invocationRecord(
    hostCall({ mode: "plan-only", host: "cli", clientName: "", via: "cli", detectedFrom: "none", model: "unknown", modelSource: "unavailable" }),
    [hostCall({ host: "codex", clientName: "codex-mcp-client", operation: "resume" })],
  );
  const current = write("video-synthetic-current-000000000000002", finalizedReceipt(invocation));
  const indexed = indexSettledJobReceipt({
    job: {
      id: "video-synthetic-current-000000000000002",
      status: "completed",
      harness: { id: HARNESS },
      completedAt: "2026-09-25T00:10:00.000Z",
      metadata: { invocation },
    },
    located: { receipt: current.receipt, digest: current.digest, source: "run-receipt", path: current.file },
    indexPath,
    now: () => "2026-09-25T00:11:00.000Z",
  });
  assert.equal(indexed.appended, true);
  const rows = readReceiptIndex(indexPath).rows;
  assert.equal(rows.length, 2);
  assert.equal("host" in rows[0], false, "既存の行はホスト無しのまま");
  assert.equal(rows[1].host, "codex", "計画だけを作った端末は実行したホストに数えない");

  const loaded = loadReceipts(receiptsDir);
  assert.equal(loaded.filter((row) => row.receipt).length, 2, "ホストの無い既存の行も読める");
  assert.deepEqual(rollupByHost(loaded).groups.map((group) => group.host).sort(), ["codex", "unrecorded"]);

  // 索引が指す Receipt のホストを書き換えると、索引の sha256 と合わなくなる。
  const edited = structuredClone(current.receipt);
  edited.invocation.resumedBy[0].host = "claude-code";
  fs.writeFileSync(current.file, `${JSON.stringify(edited, null, 2)}\n`);
  assert.ok(loadReceipts(receiptsDir).some((row) => /索引の sha256 と一致しない/u.test(row.error || "")));
  // 索引を通らない読み方（--project-dir の走査）でも、invocation の digest で外れる。
  const scanned = loadReceipts(path.join(root, "no-dir"), { projectDirs: [projectDir] });
  const invalid = scanned.filter((row) => row.invalid);
  assert.equal(invalid.length, 1);
  assert.match(invalid[0].error, /invocation-digest-mismatch/u);
  assert.equal(rollupByHost(scanned).invalid, 1);
});

test("harness-receipts.mjs rollup --by host は CLI からも同じ集計を出す", async (t) => {
  const root = tempRoot(t, "host-receipts-cli-");
  const dir = path.join(root, "receipts");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "one.json"), `${JSON.stringify(finalizedReceipt(invocationRecord(hostCall())), null, 2)}\n`);
  const script = path.join(SOURCE_ROOT, "scripts", "harness-receipts.mjs");
  const { stdout } = await execFile(process.execPath, [script, "rollup", "--by", "host", "--dir", dir], { windowsHide: true });
  const printed = JSON.parse(stdout);
  assert.equal(printed.by, "host");
  assert.deepEqual(printed.groups.map((group) => [group.harnessId, group.host, group.receipts, group.passRate, group.medianDurationSeconds]), [
    [HARNESS, "claude-code", 1, 1, 600],
  ]);
  const listed = JSON.parse((await execFile(process.execPath, [script, "list", "--dir", dir], { windowsHide: true })).stdout);
  assert.equal(listed.receipts[0].host, "claude-code");
  await assert.rejects(execFile(process.execPath, [script, "rollup", "--by", "model", "--dir", dir], { windowsHide: true }), /--by は host か build/u);
  await assert.rejects(execFile(process.execPath, [script, "rollup", "--by", "host", "--gap", "2", "--dir", dir], { windowsHide: true }), /--gap は 0 より大きく 1 以下/u);
});
