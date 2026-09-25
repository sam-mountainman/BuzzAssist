// 戦略ブリーフの観測・仮説・未確認事項の試験。会話 id・チャンネル id・文面はすべて合成の値で、
// 戦略の道具のスクリプトもモデルも呼ばない。
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { claimChangesSince, openQuestionSummary, validateStrategyBrief } from "../lib/strategyBrief.mjs";
import {
  createStrategyBriefQualityContract,
  recordStrategyBriefRound,
  startStrategyBriefLoop,
  strategyBriefHandoff,
  strategyBriefReviewTemplate,
  strategyBriefVerdict,
} from "../lib/strategyBriefQualityLoop.mjs";
import { evidenceRow, jsonBytes, sampleBrief, sha, workspace, writeBytes, writeJson } from "./helpers/strategyBriefFixture.mjs";

let clock = Date.parse("2026-09-26T06:00:00.000Z");
const now = () => {
  clock += 60_000;
  return new Date(clock).toISOString();
};
const CONTRACT = createStrategyBriefQualityContract();
const scores = () => Object.fromEntries(CONTRACT.rubric.map((row) => [row.id, 92]));

const baseRow = { kind: "other", sha256: "a".repeat(64), state: "provisional", collected: { at: "2026-09-20", conditions: "合成" } };

function briefWithClaims(overrides = {}) {
  return sampleBrief({
    evidence: [{ ...baseRow, id: "e-1", path: "evidence/a.md" }],
    changes: { previous: null, keep: [{ point: "合成の残す点", evidenceIds: ["e-1"] }], change: [] },
    observations: [{ id: "o-1", statement: "合成の観測: 冒頭で離れる人が多い", evidenceIds: ["e-1"] }],
    hypotheses: [{ id: "h-1", statement: "合成の仮説: 約束の回収が遅い", evidenceIds: [], status: "untested" }],
    openQuestions: [{ id: "q-1", question: "合成の未確認: 視聴者が求める答えの深さ", blocksProduction: true, plannedCheck: "合成: 選定動画のコメントを4分析する" }],
    ...overrides,
  });
}

test("観測・仮説・未確認事項の形: 任意の欄で、観測は根拠に結び、支持された仮説と確認済みの事項には根拠が要る", () => {
  assert.deepEqual(validateStrategyBrief(briefWithClaims()), { ok: true, issues: [], linkIssues: [] });
  // 書かないブリーフも今までどおり通る。
  const plain = briefWithClaims();
  delete plain.observations;
  delete plain.hypotheses;
  delete plain.openQuestions;
  assert.equal(validateStrategyBrief(plain).ok, true);

  const broken = validateStrategyBrief(briefWithClaims({
    observations: [{ id: "o-1", statement: "合成の観測", evidenceIds: [] }],
    hypotheses: [{ id: "h-1", statement: "合成の仮説の文", evidenceIds: [], status: "supported" }, { id: "h-2", statement: "合成の仮説の文", evidenceIds: [], status: "maybe" }],
    openQuestions: [
      { id: "q-1", question: "合成の未確認の問い", plannedCheck: "合成の確かめ方" },
      { id: "q-2", question: "合成の未確認の問い", blocksProduction: false, plannedCheck: "合成の確かめ方", status: "resolved" },
      { id: "q-3", question: "合成の未確認の問い", blocksProduction: false, plannedCheck: "合成の確かめ方", resolution: { evidenceIds: ["e-1"], note: "合成の結果" } },
    ],
  }));
  for (const code of [
    "missing:observations[0].evidenceIds",
    "missing:hypotheses[0].evidenceIds",
    "invalid:hypotheses[1].status",
    "missing:openQuestions[0].blocksProduction",
    "missing:openQuestions[1].resolution",
    "unexpected:openQuestions[2].resolution",
  ]) assert.ok(broken.issues.includes(code), code);

  const unlinked = validateStrategyBrief(briefWithClaims({
    observations: [{ id: "o-1", statement: "合成の観測の文", evidenceIds: ["e-none"] }, { id: "o-1", statement: "合成の観測の文", evidenceIds: ["e-1"] }],
    openQuestions: [{ id: "q-1", question: "合成の未確認の問い", blocksProduction: true, plannedCheck: "合成の確かめ方", status: "resolved", resolution: { evidenceIds: ["e-gone"], note: "合成の結果" } }],
  }));
  assert.deepEqual(unlinked.issues, []);
  for (const code of ["link:observation-unknown-evidence:o-1:e-none", "link:duplicate-observation-id:o-1", "link:open-question-unknown-evidence:q-1:e-gone"]) {
    assert.ok(unlinked.linkIssues.includes(code), code);
  }
});

test("未確認を確認済みにするには、前の版に無かった根拠（新しい id か SHA の変わった根拠）が要る", () => {
  const before = briefWithClaims();
  const previous = { evidence: before.evidence, openQuestions: before.openQuestions, hypotheses: before.hypotheses };
  const resolvedWithOld = briefWithClaims({
    openQuestions: [{ ...before.openQuestions[0], status: "resolved", resolution: { evidenceIds: ["e-1"], note: "合成: 前からある根拠を指しただけ" } }],
  });
  assert.deepEqual(claimChangesSince(previous, resolvedWithOld).map((row) => [row.id, row.change, row.ok]), [["q-1", "resolved", false]]);
  const resolvedWithNew = briefWithClaims({
    evidence: [...before.evidence, { ...baseRow, id: "e-2", path: "evidence/b.md", sha256: "b".repeat(64) }],
    openQuestions: [{ ...before.openQuestions[0], status: "resolved", resolution: { evidenceIds: ["e-2"], note: "合成: 新しく4分析した" } }],
  });
  assert.deepEqual(claimChangesSince(previous, resolvedWithNew).map((row) => [row.id, row.ok, row.newEvidenceIds]), [["q-1", true, ["e-2"]]]);
  // 同じ id でもファイルを取り直した（SHA が変わった）根拠は新しい根拠。
  const refreshed = briefWithClaims({
    evidence: [{ ...before.evidence[0], sha256: "c".repeat(64) }],
    openQuestions: [{ ...before.openQuestions[0], status: "resolved", resolution: { evidenceIds: ["e-1"], note: "合成: 取り直した" } }],
  });
  assert.equal(claimChangesSince(previous, refreshed)[0].ok, true);
  // 黙って消した未確認事項と、根拠なしの仮説の状態の変更。
  const dropped = briefWithClaims({ openQuestions: [], hypotheses: [{ ...before.hypotheses[0], status: "supported", evidenceIds: ["e-1"] }] });
  assert.deepEqual(claimChangesSince(previous, dropped).map((row) => [row.kind, row.change, row.ok]), [
    ["open-question", "dropped", false],
    ["hypothesis", "status-changed", false],
  ]);
  assert.deepEqual(openQuestionSummary(before), { total: 1, open: 1, resolved: 0, blocking: ["q-1"] });
});

async function writeBrief(root, rel, brief) {
  const bytes = jsonBytes(brief);
  await writeFile(path.join(root, ...rel.split("/")), bytes);
  return { rel, sha256: sha(bytes), brief };
}

async function reviewFor(root, name, context, briefSha256) {
  const rel = `quality/reviews/${name}.json`;
  await writeJson(root, rel, {
    evaluatorId: "evaluator",
    evaluatorContextId: context,
    evaluatorHost: "codex",
    briefSha256,
    rubricScores: scores(),
    notes: `合成: ブリーフと根拠を開いて照合した（${context}）`,
    findings: [],
  });
  return rel;
}

test("verdict: 制作を止める未確認事項が残ると品質ループで合格しても制作へ渡さず、採点後に根拠なしで確認済みへ書き換えると名指しする", async (t) => {
  const root = await workspace(t);
  const notes = await writeBytes(root, "evidence/a.md", Buffer.from("合成の調査メモ\n"));
  const brief = briefWithClaims({ evidence: [evidenceRow(notes, { id: "e-1" })] });
  await startStrategyBriefLoop({ workDir: root, generatorContextId: "ctx-planner-1", now });
  const v1 = await writeBrief(root, "brief-r1.json", brief);
  const r1 = await recordStrategyBriefRound({ workDir: root, briefPath: v1.rel, reviewPath: await reviewFor(root, "r1", "ctx-eval-1", v1.sha256), now });
  assert.equal(r1.state.status, "passed", JSON.stringify(r1.issues));
  assert.deepEqual(r1.version.openQuestions, [{ id: "q-1", status: "open", blocksProduction: true }]);

  const blocked = await strategyBriefVerdict({ briefPath: path.join(root, v1.rel) });
  assert.equal(blocked.pass, false);
  assert.deepEqual(blocked.reasonCodes, ["strategy-brief-open-question-blocks-production:q-1"]);
  assert.match(blocked.detail, /制作を止める未確認事項 1 件/u);
  const handoff = await strategyBriefHandoff({ briefPath: path.join(root, v1.rel) });
  assert.deepEqual(handoff.openQuestions, { open: 1, blocking: ["q-1"] });
  assert.match(handoff.summary, /制作を止める未確認事項 1 件/u);

  // 制作側で、根拠を足さずに確認済みへ書き換えた → 名指しで検出する。
  await writeFile(path.join(root, v1.rel), jsonBytes({
    ...brief,
    openQuestions: [{ ...brief.openQuestions[0], status: "resolved", resolution: { evidenceIds: ["e-1"], note: "合成: 確かめたことにした" } }],
  }));
  const forged = await strategyBriefVerdict({ briefPath: path.join(root, v1.rel) });
  assert.ok(forged.reasonCodes.includes("strategy-brief-open-question-resolved-without-new-evidence:q-1"), JSON.stringify(forged.reasonCodes));
  assert.ok(!forged.reasonCodes.some((code) => code.startsWith("strategy-brief-open-question-blocks-production")));
});

test("品質ループの機械ゲート claims-updated-with-new-evidence: 同じループの前の版から根拠なしで確認済みにした版は合格しない", async (t) => {
  const root2 = await workspace(t);
  const notes2 = await writeBytes(root2, "evidence/a.md", Buffer.from("合成の調査メモ\n"));
  const base = briefWithClaims({ evidence: [evidenceRow(notes2, { id: "e-1" })] });
  await startStrategyBriefLoop({ workDir: root2, generatorContextId: "ctx-planner-1", now });
  const low = { ...scores(), "single-question": 40 };
  const a1 = await writeBrief(root2, "brief-r1.json", base);
  await writeJson(root2, "quality/reviews/r1.json", { evaluatorId: "evaluator", evaluatorContextId: "ctx-eval-1", evaluatorHost: "codex", briefSha256: a1.sha256, rubricScores: low, notes: "合成: 問いが割れている", findings: [] });
  const first = await recordStrategyBriefRound({ workDir: root2, briefPath: a1.rel, reviewPath: "quality/reviews/r1.json", now });
  assert.equal(first.state.status, "active");

  const a2 = await writeBrief(root2, "brief-r2.json", {
    ...base,
    label: "r2",
    changes: { ...base.changes, previous: { label: "r1", sha256: a1.sha256 } },
    openQuestions: [{ ...base.openQuestions[0], status: "resolved", resolution: { evidenceIds: ["e-1"], note: "合成: 前からある根拠" } }],
  });
  const sheet = await strategyBriefReviewTemplate({ workDir: root2, briefPath: a2.rel });
  assert.deepEqual(sheet.sheet.claimChangesFromPrevious.map((row) => [row.id, row.ok]), [["q-1", false]]);
  assert.deepEqual(sheet.sheet.openQuestions.blocking, []);
  const second = await recordStrategyBriefRound({ workDir: root2, briefPath: a2.rel, reviewPath: await reviewFor(root2, "r2", "ctx-eval-2", a2.sha256), revisionDelta: "問いを絞った", now });
  assert.equal(second.recorded, true);
  assert.deepEqual(second.round.failedGateIds, ["claims-updated-with-new-evidence"]);
  assert.deepEqual(second.version.claimChanges.map((row) => [row.id, row.change, row.ok]), [["q-1", "resolved", false]]);

  // r2 と同じ書き換え（前からある根拠で確認済み）を次の版でも繰り返すと、やはり落ちる。
  const repeat = await writeBrief(root2, "brief-r2b.json", { ...a2.brief, label: "r2b", changes: { ...base.changes, previous: { label: "r2", sha256: a2.sha256 } } });
  const repeated = await recordStrategyBriefRound({ workDir: root2, briefPath: repeat.rel, reviewPath: await reviewFor(root2, "r2b", "ctx-eval-4", repeat.sha256), revisionDelta: "版の名前だけ変えた", now });
  assert.deepEqual(repeated.round.failedGateIds, ["claims-updated-with-new-evidence"]);

  const fresh = await writeBytes(root2, "evidence/b.md", Buffer.from("合成: 選定動画のコメントの4分析の結果\n"));
  const a3 = await writeBrief(root2, "brief-r3.json", {
    ...a2.brief,
    label: "r3",
    evidence: [...base.evidence, evidenceRow(fresh, { id: "e-2" })],
    changes: { ...base.changes, previous: { label: "r2b", sha256: repeat.sha256 } },
    openQuestions: [{ ...base.openQuestions[0], status: "resolved", resolution: { evidenceIds: ["e-2"], note: "合成: 新しく4分析した" } }],
  });
  const third = await recordStrategyBriefRound({ workDir: root2, briefPath: a3.rel, reviewPath: await reviewFor(root2, "r3", "ctx-eval-3", a3.sha256), revisionDelta: "未確認事項を新しい根拠で確かめた", now });
  // 比べる基準は、このゲートが落ちた r2 ではなく r1（落ちた版の「確認済み」を基準にすると、同じ書き換えを
  // 繰り返すだけで変化が消えて通ってしまう）。r1 に無かった e-2 を指したので通る。
  assert.deepEqual(third.round.failedGateIds, []);
  assert.deepEqual(third.version.claimChanges.map((row) => [row.id, row.ok, row.newEvidenceIds]), [["q-1", true, ["e-2"]]]);
  assert.equal(third.state.status, "passed", JSON.stringify(third.issues));
  const verdict = await strategyBriefVerdict({ briefPath: path.join(root2, a3.rel) });
  assert.equal(verdict.pass, true, JSON.stringify(verdict.reasonCodes));
  assert.deepEqual(verdict.openQuestions.blocking, []);
});
