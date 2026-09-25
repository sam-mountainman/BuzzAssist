// 変更台帳と巻き戻し（harness-learn rollback）の試験。合成の開発用チェックアウトだけを使う。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { CHANGE_APPLIED, CHANGE_ROLLED_BACK, expandAppliedRecords, foldLearningChanges } from "../lib/harnessLearningChangeRecords.mjs";
import {
  approveLearningChange,
  enqueueLearningChange,
  listLearningChanges,
  rollbackLearningChange,
} from "../lib/harnessLearningChanges.mjs";
import { learningRowKey } from "../lib/harnessLearningState.mjs";
import { createCanonicalReaders, summarizeProposals } from "../scripts/harness-learn.mjs";
import {
  BASE_SKILL,
  HUMAN,
  REVIEWER,
  RULE,
  fixture,
  proposal,
  proposedWith,
  readJsonl,
} from "./fixtures/learningChangeFixture.mjs";

function approved(fx, entries = [fx.addProposal(proposal())], text = proposedWith(BASE_SKILL, entries)) {
  const { change } = enqueueLearningChange({ ...fx.options, proposalIds: entries.map((entry) => entry.id), proposedText: text, note: RULE });
  approveLearningChange({ ...fx.options, ...HUMAN, changeId: change.changeId });
  return { change, entries, text };
}

function summaryOf(fx) {
  const targets = JSON.parse(fs.readFileSync(path.join(fx.repo, "docs", "learning", "targets.json"), "utf8")).targets;
  const readers = createCanonicalReaders({ repoRoot: fx.repo, targets });
  return summarizeProposals(readJsonl(fx.ledger("proposals")), readJsonl(fx.ledger("applied")), readers.readCanonical, readers.hashCanonical);
}

test("rollback は変更後と一致するときだけ変更前へ戻し、戻したことも applied 台帳へ残す", (t) => {
  const fx = fixture(t);
  const { change, entries } = approved(fx);
  assert.equal(summaryOf(fx)[0].applied, true);
  const { record } = rollbackLearningChange({ ...fx.options, ...HUMAN, changeId: change.changeId, reason: "合成の規則が別の節と重複した" });
  assert.equal(fs.readFileSync(fx.skillPath, "utf8"), BASE_SKILL, "変更前へ戻っていない");
  const rows = readJsonl(fx.ledger("applied"));
  assert.deepEqual(rows.map((row) => row.recordType), [CHANGE_APPLIED, CHANGE_ROLLED_BACK], "適用の記録を消した・巻き戻しを残していない");
  assert.deepEqual(
    { from: record.fromSha256, to: record.toSha256, reviewer: record.reviewer, attestedBy: record.attestedBy, ids: record.proposalIds },
    { from: rows[0].afterSha256, to: rows[0].beforeSha256, reviewer: REVIEWER, attestedBy: "human-verified", ids: [entries[0].id] },
  );
  // 巻き戻した変更は反映記録に数えない。提案は反映待ちへ戻る。
  assert.deepEqual(expandAppliedRecords(rows), []);
  assert.equal(summaryOf(fx)[0].applied, false);
  assert.equal(foldLearningChanges(readJsonl(fx.ledger("changes")), rows).get(change.changeId).status, "rolled-back");
  assert.equal(listLearningChanges({ ...fx.options, includeClosed: true })[0].status, "rolled-back");
  // 2回は戻さない。巻き戻しの行は移行の重複判定でも別の行として数える。
  assert.throws(() => rollbackLearningChange({ ...fx.options, ...HUMAN, changeId: change.changeId, reason: "もう一度戻す" }), (error) => error.code === "change-not-applied");
  assert.notEqual(learningRowKey("applied", rows[0]), learningRowKey("applied", rows[1]));
  // 戻したあと、同じ提案を新しい変更として出し直せる。
  const again = enqueueLearningChange({ ...fx.options, now: () => "2026-09-25T02:00:00.000Z", proposalIds: [entries[0].id], proposedText: proposedWith(BASE_SKILL, entries), note: RULE });
  assert.notEqual(again.change.changeId, change.changeId);
});

test("変更後に正本が変わっていたら rollback-conflict で拒否し、正本も台帳も変えない", (t) => {
  const fx = fixture(t);
  const { change, text } = approved(fx);
  const edited = text.replace("- 確かめずに書く", "- 確かめずに書く\n- 錠を取らずに書く");
  fs.writeFileSync(fx.skillPath, edited);
  assert.throws(() => rollbackLearningChange({ ...fx.options, ...HUMAN, changeId: change.changeId, reason: "合成の理由で戻す" }), (error) => error.code === "rollback-conflict");
  assert.equal(fs.readFileSync(fx.skillPath, "utf8"), edited, "衝突したのに書き換えた");
  assert.deepEqual(readJsonl(fx.ledger("applied")).map((row) => row.recordType), [CHANGE_APPLIED]);
});

test("rollback も人の確認でだけ通り、承認していない変更は巻き戻せない", (t) => {
  const fx = fixture(t);
  const { change, text } = approved(fx);
  for (const attempt of [
    { reviewer: REVIEWER, agentAttested: true, isInteractive: true },
    { reviewer: REVIEWER, humanVerified: true, isInteractive: false },
    { reviewer: REVIEWER, isInteractive: true },
  ]) {
    assert.throws(() => rollbackLearningChange({ ...fx.options, ...attempt, changeId: change.changeId, reason: "合成の理由で戻す" }), (error) => error.code === "human-verification-required");
  }
  assert.throws(() => rollbackLearningChange({ ...fx.options, ...HUMAN, changeId: change.changeId, reason: "短" }), /理由/u);
  assert.equal(fs.readFileSync(fx.skillPath, "utf8"), text);
  const second = fx.addProposal(proposal({ text: "合成の手順では錠を取ってから追記する" }));
  const pending = enqueueLearningChange({ ...fx.options, proposalIds: [second.id], proposedText: proposedWith(text, [second], `${RULE}（二つ目）`), note: `${RULE}（二つ目）` });
  assert.throws(() => rollbackLearningChange({ ...fx.options, ...HUMAN, changeId: pending.change.changeId, reason: "合成の理由で戻す" }), (error) => error.code === "change-not-applied");
  assert.throws(() => rollbackLearningChange({ ...fx.options, ...HUMAN, changeId: "chg-000000000000", reason: "合成の理由で戻す" }), (error) => error.code === "change-not-found");
});

test("後の変更を先に戻せば、前の変更も戻せる（変更後の sha256 で順序が守られる）", (t) => {
  const fx = fixture(t);
  const first = approved(fx);
  const second = fx.addProposal(proposal({ text: "合成の手順では錠を取ってから追記する" }));
  const secondText = proposedWith(first.text, [second], `${RULE}（二つ目）`);
  const { change: later } = enqueueLearningChange({ ...fx.options, proposalIds: [second.id], proposedText: secondText, note: `${RULE}（二つ目）` });
  approveLearningChange({ ...fx.options, ...HUMAN, changeId: later.changeId });
  assert.throws(() => rollbackLearningChange({ ...fx.options, ...HUMAN, changeId: first.change.changeId, reason: "前の変更を戻す" }), (error) => error.code === "rollback-conflict");
  rollbackLearningChange({ ...fx.options, ...HUMAN, changeId: later.changeId, reason: "後の変更を先に戻す" });
  assert.equal(fs.readFileSync(fx.skillPath, "utf8"), first.text);
  rollbackLearningChange({ ...fx.options, ...HUMAN, changeId: first.change.changeId, reason: "前の変更も戻す" });
  assert.equal(fs.readFileSync(fx.skillPath, "utf8"), BASE_SKILL);
});
