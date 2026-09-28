// 決着した Job の作業場所にある品質ループ（完成動画の署名済みレビューのループなど）から、
// 同じ失敗の格上げの提案を積む配線の試験。完成動画のループには record の CLI が無いので、
// Job の決着で拾う（lib/harnessReceiptLearning.mjs の captureSettledJobLearning）。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { captureSettledJobLearning, settledJobQualityWorkDirs } from "../lib/harnessReceiptLearning.mjs";

const noCapture = () => ({ appended: false, entry: { id: "000000000000" } });

function tempRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "settled-job-promotion-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("決着した Job の品質ループの置き場を、Job の作業場所とジャンルの Receipt の置き場から並べる", (t) => {
  const root = tempRoot(t);
  const jobRunDir = path.join(root, "canvas", "harness-runs", "video-synthetic-a");
  // ナレーション物語は配備先の .media/<ハーネス>/<Job>/audit/run-receipt.json に Receipt を置き、
  // 品質ループは .media/<ハーネス>/<Job>/quality/ にある。
  const genreRunDir = path.join(root, "deploy", ".media", "sample-harness", "video-synthetic-a");
  const job = {
    id: "video-synthetic-a",
    runDir: jobRunDir,
    adapterRunReceiptPath: path.join(genreRunDir, "audit", "run-receipt.json"),
    artifacts: [{ kind: "genre-run-receipt", path: path.join(genreRunDir, "audit", "run-receipt.json") }],
  };
  const dirs = settledJobQualityWorkDirs(job);
  assert.ok(dirs.includes(path.resolve(jobRunDir)));
  // 解説動画は Job の作業場所の explainer/ の下に品質ループを置く。
  assert.ok(dirs.includes(path.resolve(jobRunDir, "explainer")));
  assert.ok(dirs.includes(path.resolve(genreRunDir)));
  assert.equal(new Set(dirs).size, dirs.length, "同じ置き場を二度並べない");
  assert.deepEqual(settledJobQualityWorkDirs({ id: "video-synthetic-b" }), [], "手がかりの無い Job では何も並べない");
});

test("格上げの関数を渡すと、決着した Job の置き場を書き込みありで渡す。試験の経路では既定で走らせない", async (t) => {
  const root = tempRoot(t);
  const indexPath = path.join(root, "state", "receipts", "index.jsonl");
  const job = {
    id: "video-synthetic-c",
    status: "failed",
    revision: 1,
    updatedAt: "2026-09-28T01:00:00.000Z",
    harness: { id: "sample-harness" },
    blockers: ["sample-blocker"],
    runDir: path.join(root, "canvas", "harness-runs", "video-synthetic-c"),
  };
  const calls = [];
  const promoted = await captureSettledJobLearning({
    job,
    env: {},
    capture: noCapture,
    receiptIndexPath: indexPath,
    locateReceipt: async () => null,
    syncOverlays: null,
    queueFeedback: null,
    promoteFailures: (input) => {
      calls.push(input);
      return { captured: 1, candidates: [{}] };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].write, true);
  assert.equal(calls[0].auto, true);
  assert.ok(calls[0].workDirs.includes(path.resolve(job.runDir)));
  assert.deepEqual(promoted.failurePromotion, { captured: 1, candidates: 1 });

  // 格上げが落ちても Job の決着は止めない。
  const broken = await captureSettledJobLearning({
    job: { ...job, id: "video-synthetic-d" },
    env: {},
    capture: noCapture,
    receiptIndexPath: indexPath,
    locateReceipt: async () => null,
    syncOverlays: null,
    queueFeedback: null,
    promoteFailures: () => { throw new Error("合成の失敗"); },
  });
  assert.deepEqual(broken.failurePromotion, { status: "failed", reason: "promotion-error" });

  // 捕捉の経路を差し替えた呼び出し（試験など）では、明示しない限り本物の台帳へ積まない。
  const plain = await captureSettledJobLearning({
    job: { ...job, id: "video-synthetic-e" },
    env: {},
    capture: noCapture,
    receiptIndexPath: indexPath,
    locateReceipt: async () => null,
  });
  assert.equal(plain.failurePromotion, undefined);
});
