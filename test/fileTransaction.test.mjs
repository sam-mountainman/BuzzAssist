// 複数ファイルの確定（lib/fileTransaction.mjs）の試験。落ちた位置ごとに、次の実行が
// やり切るか捨てるかして、半端な組み合わせを残さないことを確かめる。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FILE_TRANSACTION_DIR,
  FILE_TRANSACTION_TEST_FAULT_ENV,
  openFileTransaction,
  recoverFileTransactions,
} from "../lib/fileTransaction.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function workspace(t) {
  const root = await mkdtemp(path.join(tmpdir(), "buzzassist-file-txn-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "audit"), { recursive: true });
  await writeFile(path.join(root, "audit", "report.json"), "{\"status\":\"old\"}\n");
  await writeFile(path.join(root, "state.json"), "{\"phase\":\"old\"}\n");
  return root;
}

async function read(root, rel) {
  return readFile(path.join(root, rel), "utf8");
}

async function stageThree(root, label) {
  const txn = await openFileTransaction(root, { label });
  await txn.stageJson(path.join(root, "audit", "report.json"), { status: "pass" });
  await txn.stageJson(path.join(root, "audit", "receipt.json"), { status: "final" });
  await txn.stageJson(path.join(root, "state.json"), { phase: "final" });
  return txn;
}

function withFault(value, action) {
  const previous = process.env[FILE_TRANSACTION_TEST_FAULT_ENV];
  process.env[FILE_TRANSACTION_TEST_FAULT_ENV] = value;
  return action().finally(() => {
    if (previous === undefined) delete process.env[FILE_TRANSACTION_TEST_FAULT_ENV];
    else process.env[FILE_TRANSACTION_TEST_FAULT_ENV] = previous;
  });
}

test("a committed transaction replaces every target and leaves no staging", async (t) => {
  const root = await workspace(t);
  const txn = await stageThree(root, "fixture");
  const record = await txn.record(path.join(root, "state.json"));
  assert.equal(record.path, path.join(root, "state.json"));
  assert.equal(record.sha256, sha256(`${JSON.stringify({ phase: "final" }, null, 2)}\n`), "記録は置き場の中身から作る（確定の前に状態へ書ける）");
  assert.equal(await read(root, "state.json"), "{\"phase\":\"old\"}\n", "確定の前は対象に触らない");
  await txn.commit();
  assert.match(await read(root, "audit/report.json"), /"pass"/u);
  assert.match(await read(root, "audit/receipt.json"), /"final"/u);
  assert.match(await read(root, "state.json"), /"final"/u);
  assert.deepEqual(await readdir(root).then((names) => names.filter((name) => name === FILE_TRANSACTION_DIR)), []);
});

test("a crash before the journal changes nothing, and recovery discards the staging", async (t) => {
  const root = await workspace(t);
  await withFault("fixture:before-journal", async () => {
    const txn = await stageThree(root, "fixture");
    await assert.rejects(txn.commit(), (error) => error.code === "file-transaction-test-interrupt");
  });
  assert.equal(await read(root, "state.json"), "{\"phase\":\"old\"}\n");
  assert.equal(await read(root, "audit/report.json"), "{\"status\":\"old\"}\n");
  const recovered = await recoverFileTransactions(root);
  assert.equal(recovered.discarded.length, 1);
  assert.equal(recovered.rolledForward.length, 0);
  assert.equal(await read(root, "state.json"), "{\"phase\":\"old\"}\n", "捨てても対象は古いまま（全部古い）");
  await assert.rejects(readFile(path.join(root, "audit", "receipt.json")), (error) => error.code === "ENOENT");
});

test("a crash in the middle of the renames is rolled forward by the next run", async (t) => {
  const root = await workspace(t);
  await withFault("fixture:after-rename-1", async () => {
    const txn = await stageThree(root, "fixture");
    await assert.rejects(txn.commit(), (error) => error.code === "file-transaction-test-interrupt");
  });
  // 落ちた瞬間は、報告だけが新しく状態は古い（これが残ると困る組み合わせ）。
  assert.match(await read(root, "audit/report.json"), /"pass"/u);
  assert.equal(await read(root, "state.json"), "{\"phase\":\"old\"}\n");
  const recovered = await recoverFileTransactions(root);
  assert.equal(recovered.rolledForward.length, 1);
  assert.match(await read(root, "audit/receipt.json"), /"final"/u);
  assert.match(await read(root, "state.json"), /"final"/u, "状態を読む前に、全部が新しい組み合わせになる");
  assert.deepEqual(await recoverFileTransactions(root), { rolledForward: [], discarded: [] }, "2回目は何もしない");
});

test("recovery refuses to guess when a target was changed after the crash", async (t) => {
  const root = await workspace(t);
  await withFault("fixture:after-rename-1", async () => {
    const txn = await stageThree(root, "fixture");
    await assert.rejects(txn.commit());
  });
  // 入れ替え済みの報告を、別の誰かが書き換えた。
  await writeFile(path.join(root, "audit", "report.json"), "{\"status\":\"edited\"}\n");
  await assert.rejects(recoverFileTransactions(root), /neither staged nor committed/u);
  assert.equal(await read(root, "state.json"), "{\"phase\":\"old\"}\n", "食い違いがあれば何も動かさない");
  const leftover = await readdir(path.join(root, FILE_TRANSACTION_DIR));
  assert.equal(leftover.length, 1, "置き場は調べられるように残す");
});

test("targets outside the transaction root are refused before anything is written", async (t) => {
  const root = await workspace(t);
  const txn = await openFileTransaction(root, { label: "fixture" });
  assert.throws(() => txn.stagePath(path.join(path.dirname(root), "outside.json")), /must be inside/u);
  await txn.abort();
  assert.deepEqual(await recoverFileTransactions(root), { rolledForward: [], discarded: [] });
});

test("the test fault is ignored outside node --test", async (t) => {
  const root = await workspace(t);
  const previousContext = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    await withFault("fixture:before-journal", async () => {
      const txn = await stageThree(root, "fixture");
      await txn.commit();
    });
  } finally {
    if (previousContext !== undefined) process.env.NODE_TEST_CONTEXT = previousContext;
  }
  assert.match(await read(root, "state.json"), /"final"/u);
});
