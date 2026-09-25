// 評価の関門つきの昇格（approve の前に skill-evals の記録を見る）の試験。
// eval は流さない（モデルを呼ばない）。合成の eval 記録を一時の学習の置き場へ書いて確かめる。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { sha256Hex } from "../lib/harnessLearningChangeRecords.mjs";
import {
  approveLearningChange,
  enqueueLearningChange,
  evaluateChangeEvalGate,
  formatEvalGate,
} from "../lib/harnessLearningChanges.mjs";
import { SKILL_EVAL_RECORD_SCHEMA } from "../lib/skillEvals.mjs";
import {
  BASE_SKILL,
  HUMAN,
  PACK_TARGET,
  RULE,
  SKILL,
  SKILL_REL,
  fixture,
  proposal,
  proposedWith,
  readJsonl,
  write,
} from "./fixtures/learningChangeFixture.mjs";

const EVAL_IDS = ["placement-first", "lock-before-append"];

function withEvals(fx) {
  write(path.join(fx.repo, ".agents", "skills", SKILL, "evals", "evals.json"), `${JSON.stringify({
    schemaVersion: 1,
    skill: SKILL,
    cases: EVAL_IDS.map((id) => ({ id, prompt: `合成の依頼 ${id}`, shouldTrigger: true, invariants: ["置き場を確かめる", "錠を取る"] })),
  }, null, 2)}\n`);
}

function evalRecord({ sha, evalId, host, passed, total = 3, recordedAt = "2026-09-25T00:00:00.000Z" }) {
  return {
    schema: SKILL_EVAL_RECORD_SCHEMA,
    runId: "synthetic-run",
    recordedAt,
    skillId: `buzzassist:${SKILL}`,
    skillName: SKILL,
    skillVersion: "1.0.0",
    contentSha256: `sha256:${sha}`,
    evalId,
    host,
    status: "graded",
    passed,
    total,
    allPassed: passed === total,
  };
}

function writeRecords(fx, rows, name = "synthetic.jsonl") {
  write(path.join(fx.root, "learning", "evals", name), rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
}

function queue(fx) {
  const entry = fx.addProposal(proposal());
  const proposed = proposedWith(BASE_SKILL, [entry]);
  const { change } = enqueueLearningChange({ ...fx.options, proposalIds: [entry.id], proposedText: proposed, note: RULE });
  return { change, proposed, before: sha256Hex(Buffer.from(BASE_SKILL)), after: sha256Hex(Buffer.from(proposed)) };
}

function recordsFor(sha, passed) {
  return EVAL_IDS.flatMap((evalId) => ["claude", "codex"].map((host) => evalRecord({ sha, evalId, host, passed: passed(evalId, host) })));
}

test("記録が無ければ既定は警告して通し、--require-evals では止める（正本も台帳も変えない）", (t) => {
  const fx = fixture(t);
  withEvals(fx);
  const { change, proposed } = queue(fx);
  assert.throws(
    () => approveLearningChange({ ...fx.options, ...HUMAN, changeId: change.changeId, requireEvals: true }),
    (error) => error.code === "evals-gate-failed" && /変更後の版に claude の結果が無い/u.test(error.message),
  );
  assert.equal(fs.readFileSync(fx.skillPath, "utf8"), BASE_SKILL);
  assert.deepEqual(readJsonl(fx.ledger("applied")), []);

  const { record, gate } = approveLearningChange({ ...fx.options, ...HUMAN, changeId: change.changeId });
  assert.equal(gate.applicable, true);
  assert.equal(gate.ok, false);
  assert.match(formatEvalGate(gate), /警告のみ。止めるには --require-evals/u);
  assert.equal(fs.readFileSync(fx.skillPath, "utf8"), proposed, "既定（警告）で止めた");
  assert.deepEqual(record.evals, {
    applicable: true, ok: false, required: false, evals: 2,
    missing: { claude: 2, codex: 2 }, baselineMissing: { claude: 2, codex: 2 }, regressions: [],
  });
  assert.equal(JSON.stringify(record.evals).includes(fx.root), false, "台帳に端末のパスを残した");
});

test("変更後の版に両ホストの結果があり、変更前より悪化していなければ --require-evals でも通る", (t) => {
  const fx = fixture(t);
  withEvals(fx);
  const { change, before, after } = queue(fx);
  writeRecords(fx, [
    ...recordsFor(before, () => 2),
    ...recordsFor(after, (evalId) => (evalId === "placement-first" ? 3 : 2)),
  ]);
  const { gate, record } = approveLearningChange({ ...fx.options, ...HUMAN, changeId: change.changeId, requireEvals: true });
  assert.equal(gate.ok, true);
  assert.equal(record.evals.ok, true);
  assert.equal(record.evals.required, true);
  assert.match(formatEvalGate(gate, { required: true }), /悪化していません/u);
});

test("同じ eval とホストで変更前より合格が減っていたら悪化として止め、比べられない（変更前が無い）ものも通さない", (t) => {
  const fx = fixture(t);
  withEvals(fx);
  const { change, before, after } = queue(fx);
  writeRecords(fx, [
    ...recordsFor(before, () => 3),
    ...recordsFor(after, (evalId, host) => (evalId === "lock-before-append" && host === "codex" ? 1 : 3)),
    // 同じ版・同じ eval・同じホストを流し直したら、後の記録を使う。
    evalRecord({ sha: after, evalId: "placement-first", host: "claude", passed: 1, recordedAt: "2026-09-24T00:00:00.000Z" }),
  ]);
  const gate = evaluateChangeEvalGate({ repoRoot: fx.repo, targetPath: SKILL_REL, beforeSha256: before, afterSha256: after, env: fx.env, homeDir: fx.home });
  assert.equal(gate.ok, false);
  assert.deepEqual(gate.regressions, [{ evalId: "lock-before-append", host: "codex", before: { passed: 3, total: 3 }, after: { passed: 1, total: 3 } }]);
  assert.throws(() => approveLearningChange({ ...fx.options, ...HUMAN, changeId: change.changeId, requireEvals: true }), /悪化: lock-before-append codex 3\/3 → 1\/3/u);

  // 変更前の結果が片方のホストに無い: 「悪化していない」とは言えない。
  fs.rmSync(path.join(fx.root, "learning", "evals"), { recursive: true, force: true });
  writeRecords(fx, [...recordsFor(after, () => 3), ...recordsFor(before, () => 3).filter((row) => row.host === "claude")]);
  const partial = evaluateChangeEvalGate({ repoRoot: fx.repo, targetPath: SKILL_REL, beforeSha256: before, afterSha256: after, env: fx.env, homeDir: fx.home });
  assert.equal(partial.ok, false);
  assert.deepEqual(partial.baselineMissing, { codex: EVAL_IDS });
  assert.match(formatEvalGate(partial, { required: true }), /変更前の版に codex の結果が無い eval（比べられない）/u);

  // 記録の置き場は --evals-dir で指せる（両ホストの結果がそろった別の置き場）。
  const other = path.join(fx.root, "other-evals");
  write(path.join(other, "full.jsonl"), [...recordsFor(before, () => 2), ...recordsFor(after, () => 2)].map((row) => `${JSON.stringify(row)}\n`).join(""));
  assert.equal(evaluateChangeEvalGate({ repoRoot: fx.repo, targetPath: SKILL_REL, beforeSha256: before, afterSha256: after, env: fx.env, homeDir: fx.home, evalsDir: other }).ok, true);
  approveLearningChange({ ...fx.options, ...HUMAN, changeId: change.changeId, requireEvals: true, evalsDir: other });
});

test("正本スキルでない対象（台帳）と evals の無いスキルには関門を当てない。Windows の区切りでも正本スキルと分かる", (t) => {
  const fx = fixture(t);
  const sha = "a".repeat(64);
  assert.deepEqual(evaluateChangeEvalGate({ repoRoot: fx.repo, targetPath: "docs/sample-ledger.md", beforeSha256: sha, afterSha256: sha, env: fx.env }), { applicable: false, ok: true, reason: "not-a-canonical-skill" });
  const noEvals = evaluateChangeEvalGate({ repoRoot: fx.repo, targetPath: path.win32.join(".agents", "skills", SKILL, "SKILL.md"), beforeSha256: sha, afterSha256: sha, env: fx.env });
  assert.equal(noEvals.applicable, false);
  assert.equal(noEvals.reason, "no-evals");
  withEvals(fx);
  const windows = evaluateChangeEvalGate({ repoRoot: fx.repo, targetPath: path.win32.join(".agents", "skills", SKILL, "SKILL.md"), beforeSha256: sha, afterSha256: sha, env: fx.env, homeDir: fx.home });
  assert.equal(windows.applicable, true);
  assert.equal(windows.skill, SKILL);

  // Channel Pack の台帳への変更は --require-evals でも関門の対象外として通る。
  const packDir = path.join(fx.repo, "channel-packs", "sample-pack", "docs", "learning");
  const entry = fx.addProposal(proposal({ target: PACK_TARGET, text: "合成の台帳に規則を1行足す" }), packDir);
  const ledgerFile = path.join(fx.repo, "channel-packs", "sample-pack", "docs", "sample-ledger.md");
  const proposed = `${fs.readFileSync(ledgerFile, "utf8")}\n<!-- buzzassist-learning:${entry.id} -->\n- R2 ${RULE}\n`;
  const { change } = enqueueLearningChange({ ...fx.options, proposalIds: [entry.id], proposedText: proposed, note: RULE });
  const { record } = approveLearningChange({ ...fx.options, ...HUMAN, changeId: change.changeId, requireEvals: true });
  assert.deepEqual(record.evals, { applicable: false, reason: "not-a-canonical-skill", required: true });
});
