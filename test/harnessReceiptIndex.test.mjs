// Job の決着を Receipt の索引（学習の状態の置き場の receipts/index.jsonl）へ残し、rollup が
// それを読む試験。以前の rollup は docs/learning/receipts だけを読み、Job は
// <project>/canvas/harness-runs/<job>/ に RunReceipt を書くので、rollup は常に0件だった。
// 一時ディレクトリだけを使い、Job・ハーネス・プロジェクトは合成。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { childAgentEnvironment } from "../lib/harnessLearningGuard.mjs";
import { resolveLearningState } from "../lib/harnessLearningState.mjs";
import { captureSettledJobLearning, defaultReceiptIndexPath } from "../lib/harnessReceiptLearning.mjs";
import { defaultReceiptsDir, loadReceipts, rollup } from "../scripts/harness-receipts.mjs";

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RECEIPTS_SCRIPT = path.join(SOURCE_ROOT, "scripts", "harness-receipts.mjs");

function tempRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "harness-receipt-index-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function receiptFixture({ outcome = "fail", failed = ["final-audit"], version = "1.0.0", finalizedAt = "2026-09-24T00:00:00.000Z" } = {}) {
  return {
    version: "harness-run-receipt-v1",
    finalized: true,
    finalizedAt,
    outcome,
    outcomeOverridden: false,
    harnessBuild: { harness: { id: "sample-harness", version, declarationDigest: "b".repeat(64) }, genreSkills: {}, declaredGates: ["final-audit"] },
    gates: { "final-audit": { verdict: failed.includes("final-audit") ? "fail" : "pass", evidenceDigest: "d".repeat(64) } },
    summary: { failedGates: failed, skippedGates: [], incompleteMediaJobCount: 0 },
    knownRemainingIssues: [],
    mediaJobs: [],
  };
}

function writeRunReceipt(projectDir, jobId, receipt) {
  const file = path.join(projectDir, "canvas", "harness-runs", jobId, "run-receipt.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
  fs.writeFileSync(file, bytes);
  return { file, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function listTree(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push([path.relative(dir, full), fs.statSync(full).mtimeMs, fs.statSync(full).size]);
    }
  };
  walk(dir);
  return out.sort();
}

const noCapture = () => ({ appended: false, entry: { id: "000000000000" } });

test("決着した Job を索引へ1行だけ残す（自動捕捉を止めていても残し、子エージェントでは書かない）", async (t) => {
  const root = tempRoot(t);
  const project = path.join(root, "project");
  const indexPath = path.join(root, "state", "receipts", "index.jsonl");
  const { file, sha256 } = writeRunReceipt(project, "video-synthetic-a", receiptFixture());
  const job = {
    id: "video-synthetic-a",
    status: "completed",
    revision: 3,
    completedAt: "2026-09-24T01:00:00.000Z",
    harness: { id: "koya-manga-video", declarationVersion: "1.0.0" },
    artifacts: [{ kind: "run-receipt", path: file, sha256 }],
  };
  const first = await captureSettledJobLearning({ job, env: {}, capture: noCapture, receiptIndexPath: indexPath });
  assert.equal(first.receiptIndex.appended, true);
  const again = await captureSettledJobLearning({ job, env: {}, capture: noCapture, receiptIndexPath: indexPath });
  assert.equal(again.receiptIndex.appended, false, "同じ Job の同じ Receipt を二重に積んだ");
  const rows = readJsonl(indexPath);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { jobId: rows[0].jobId, harnessId: rows[0].harnessId, status: rows[0].status, receiptPath: rows[0].receiptPath, receiptSha256: rows[0].receiptSha256, settledAt: rows[0].settledAt },
    { jobId: job.id, harnessId: "sample-harness", status: "completed", receiptPath: file, receiptSha256: sha256, settledAt: job.completedAt },
  );

  // 自動捕捉を止めても、集計の読み先である索引は残す。
  const failedJob = { id: "video-synthetic-b", status: "failed", revision: 1, updatedAt: "2026-09-24T02:00:00.000Z", harness: { id: "koya-manga-video" }, blockers: ["canonical-identity-drift"] };
  const disabled = await captureSettledJobLearning({ job: failedJob, env: { BUZZASSIST_LEARNING_AUTO_CAPTURE: "0" }, capture: noCapture, receiptIndexPath: indexPath, locateReceipt: async () => null });
  assert.equal(disabled.skippedReason, "disabled");
  assert.equal(disabled.receiptIndex.appended, true);
  const noReceiptRow = readJsonl(indexPath).at(-1);
  assert.equal(noReceiptRow.receiptPath, null);
  assert.equal(noReceiptRow.receiptSource, "job-state");
  assert.match(noReceiptRow.stateDigest, /^[a-f0-9]{64}$/u);

  // 子エージェントは学習の状態へ書かない。未決着の Job も積まない。
  const child = await captureSettledJobLearning({ job: { ...failedJob, id: "video-synthetic-c" }, env: childAgentEnvironment({}), capture: noCapture, receiptIndexPath: indexPath });
  assert.equal(child.skippedReason, "child-agent");
  await captureSettledJobLearning({ job: { ...failedJob, id: "video-synthetic-d", status: "running" }, env: {}, capture: noCapture, receiptIndexPath: indexPath });
  assert.equal(readJsonl(indexPath).length, 2);
});

test("rollup は索引の RunReceipt と --project-dir の canvas/harness-runs を読み、同じ中身は1件に数える（読み取り専用）", async (t) => {
  const root = tempRoot(t);
  const project = path.join(root, "project");
  const receiptsDir = path.join(root, "state", "receipts");
  const indexPath = path.join(receiptsDir, "index.jsonl");
  const a = writeRunReceipt(project, "video-a", receiptFixture());
  const b = writeRunReceipt(project, "video-b", receiptFixture({ outcome: "pass", failed: [], finalizedAt: "2026-09-24T03:00:00.000Z" }));
  const c = writeRunReceipt(project, "video-c", receiptFixture({ finalizedAt: "2026-09-24T04:00:00.000Z" }));
  const index = (job, receipt) => captureSettledJobLearning({
    job: { id: job, status: "completed", harness: { id: "koya-manga-video" }, artifacts: [{ kind: "run-receipt", path: receipt.file, sha256: receipt.sha256 }] },
    env: {}, capture: noCapture, receiptIndexPath: indexPath,
  });
  await index("video-a", a);
  await index("video-b", b);
  // 決着後に書き換わった Receipt は、決着時の記録として数えない。
  await index("video-c", c);
  fs.appendFileSync(c.file, " ");
  // 索引が指す先が消えた（canvas を片づけた）ものは missing として数える。
  const gone = writeRunReceipt(root, "video-gone", receiptFixture({ finalizedAt: "2026-09-24T05:00:00.000Z" }));
  await index("video-gone", gone);
  fs.rmSync(gone.file);

  const fromIndex = rollup(loadReceipts(receiptsDir));
  assert.equal(fromIndex.receiptCount, 3);
  assert.equal(fromIndex.missing, 1);
  assert.equal(fromIndex.unreadable, 1, "書き換わった Receipt を読めないものとして数えていない");
  assert.equal(fromIndex.builds.length, 1);
  assert.equal(fromIndex.builds[0].runs, 2);
  assert.deepEqual(fromIndex.builds[0].worstGates.map((gate) => [gate.id, gate.fail]), [["final-audit", 1]]);

  // --project-dir を足すと canvas/harness-runs/*/run-receipt.json も読む。索引と同じ中身は重ねない。
  const before = listTree(project);
  const cli = spawnSync(process.execPath, [RECEIPTS_SCRIPT, "rollup", "--dir", receiptsDir, "--project-dir", project], { encoding: "utf8", timeout: 30_000 });
  assert.equal(cli.status, 0, cli.stderr);
  const report = JSON.parse(cli.stdout);
  assert.equal(report.builds[0].runs, 3, "project の Receipt（書き換わった video-c を含む現物）を読めていない");
  assert.deepEqual(listTree(project), before, "--project-dir の走査で project の中を書き換えた");

  const list = spawnSync(process.execPath, [RECEIPTS_SCRIPT, "list", "--dir", path.join(root, "empty"), "--project-dir", project], { encoding: "utf8", timeout: 30_000 });
  assert.equal(list.status, 0, list.stderr);
  assert.equal(JSON.parse(list.stdout).receipts.filter((entry) => entry.source === "project").length, 3);
});

test("索引と rollup の既定の置き場は、学習の状態の置き場の receipts/（開発用チェックアウトでは docs/learning/receipts）", () => {
  const state = resolveLearningState({ codeRoot: SOURCE_ROOT });
  assert.equal(state.mode, "development");
  assert.equal(defaultReceiptsDir(), path.join(SOURCE_ROOT, "docs", "learning", "receipts"));
  assert.equal(defaultReceiptIndexPath(), path.join(SOURCE_ROOT, "docs", "learning", "receipts", "index.jsonl"));
  const installed = resolveLearningState({ codeRoot: path.join(os.tmpdir(), "copy"), homeDir: path.join(os.tmpdir(), "home"), env: {}, developmentCheckout: false });
  assert.equal(installed.receiptIndexPath, path.join(os.tmpdir(), "home", ".buzzassist", "learning", "receipts", "index.jsonl"));
});
