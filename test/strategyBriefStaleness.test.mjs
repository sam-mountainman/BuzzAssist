import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  EVIDENCE_REFRESH_REQUIRED_CODE,
  evidencePremiseStaleness,
  strategyBriefPremiseDigests,
} from "../lib/strategyBrief.mjs";
import {
  createStrategyBriefQualityContract,
  recordStrategyBriefRound,
  startStrategyBriefLoop,
  strategyBriefReviewTemplate,
  strategyBriefVerdict,
} from "../lib/strategyBriefQualityLoop.mjs";
import { runStrategyBriefCli } from "../scripts/strategy-brief.mjs";
import {
  evidenceRow,
  jsonBytes,
  metricsOutput,
  sampleBrief,
  sha,
  workspace,
  writeAudienceRun,
  writeJson,
} from "./helpers/strategyBriefFixture.mjs";

// 会話 id・チャンネル id・文面はすべて合成の値。
const PLANNER = "ctx-planner-1";
let clock = Date.parse("2026-09-26T06:00:00.000Z");
const now = () => {
  clock += 60_000;
  return new Date(clock).toISOString();
};
const CONTRACT = createStrategyBriefQualityContract();
const scores = (overrides = {}) => Object.fromEntries(CONTRACT.rubric.map((row) => [row.id, overrides[row.id] ?? 92]));
const silent = () => ({ write: () => {} });

async function writeBrief(root, rel, brief) {
  const bytes = jsonBytes(brief);
  await writeFile(path.join(root, ...rel.split("/")), bytes);
  return { rel, sha256: sha(bytes), brief };
}

async function reviewFor(root, name, { context, briefSha256, rubricScores = scores() }) {
  const rel = `quality/reviews/${name}.json`;
  await writeJson(root, rel, {
    evaluatorId: "evaluator",
    evaluatorContextId: context,
    evaluatorHost: "codex",
    briefSha256,
    rubricScores,
    notes: `ブリーフと根拠を開いて照合した所見（${context}）`,
    findings: [],
  });
  return rel;
}

async function setup(t) {
  const root = await workspace(t);
  const metrics = await writeJson(root, "evidence/metrics.json", metricsOutput());
  const run = await writeAudienceRun(root, "evidence/run-001");
  const evidence = [
    evidenceRow(metrics, { id: "e-metrics", kind: "metrics", premiseBound: false, premiseIndependenceReason: "合成: 公開済みの動画の実測" }),
    { id: "e-run", kind: "audience-run", path: run.rel, sha256: run.reportManifestSha256, state: "provisional", collected: { at: "2026-09-20", conditions: "合成の4分析" } },
  ];
  const brief = sampleBrief({
    evidence,
    changes: { previous: null, keep: [{ point: "合成の残す点", evidenceIds: ["e-run"] }], change: [] },
  });
  return { root, metrics, run, brief };
}

test("前提が変わっていなければ古くない。全角・半角や空白の揺れは前提の変更に数えない", () => {
  const brief = sampleBrief({ evidence: [{ id: "e-1", kind: "other", path: "a.md", sha256: "a".repeat(64), state: "provisional", collected: { at: "2020-01-01", conditions: "合成" } }] });
  const premise = strategyBriefPremiseDigests(brief);
  const bound = { ...brief.evidence[0], collected: { ...brief.evidence[0].collected, premise } };
  // 集めた日が古くても、前提が同じなら古くない（日数では決めない）。
  assert.deepEqual(evidencePremiseStaleness({ ...brief, evidence: [bound] }).stale, []);
  const spaced = { ...brief, question: `  ${brief.question.replace(":", "：")}  `, evidence: [bound] };
  assert.deepEqual(evidencePremiseStaleness(spaced).stale, []);
});

test("前提（問い・見る人・入口の約束）を変えると、前の前提で集めた根拠は stale になり、変わった欄を名指しする", () => {
  const brief = sampleBrief({ evidence: [] });
  const oldPremise = strategyBriefPremiseDigests(brief);
  const rows = [
    { id: "e-bound", kind: "audience-run", path: "runs/r1", sha256: "a".repeat(64), state: "provisional", collected: { at: "2026-09-20", conditions: "合成", premise: oldPremise } },
    { id: "e-free", kind: "metrics", path: "m.json", sha256: "b".repeat(64), state: "provisional", collected: { at: "2026-09-20", conditions: "合成", premise: oldPremise }, premiseBound: false, premiseIndependenceReason: "合成: 公開済みの実測" },
    { id: "e-new", kind: "other", path: "n.md", sha256: "c".repeat(64), state: "provisional", collected: { at: "2026-09-26", conditions: "合成" } },
  ];
  const changedAudience = { ...brief, audience: { ...brief.audience, who: "合成の別の視聴者像" }, evidence: rows };
  const result = evidencePremiseStaleness(changedAudience);
  assert.equal(result.refreshRequired, true);
  assert.equal(result.reasonCode, EVIDENCE_REFRESH_REQUIRED_CODE);
  assert.deepEqual(result.stale.map((row) => [row.id, row.changedFields]), [["e-bound", ["audience"]]]);
  const changedPromise = {
    ...brief,
    entry: { promises: brief.entry.promises.map((row) => (row.id === "p-title" ? { ...row, text: "合成の別の約束" } : row)) },
    evidence: rows,
  };
  assert.deepEqual(evidencePremiseStaleness(changedPromise).stale.map((row) => row.changedFields), [["entryPromises"]]);
});

test("品質ループ: 前提を変えた版に前の版の根拠が残ると evidence-premise-current が落ち、取り直した版で合格する", async (t) => {
  const { root, brief } = await setup(t);
  await startStrategyBriefLoop({ workDir: root, generatorContextId: PLANNER, now });
  const v1 = await writeBrief(root, "brief-r1.json", brief);
  const r1 = await recordStrategyBriefRound({ workDir: root, briefPath: v1.rel, reviewPath: await reviewFor(root, "r1", { context: "ctx-eval-1", briefSha256: v1.sha256, rubricScores: scores({ "single-question": 40 }) }), now });
  assert.equal(r1.recorded, true);
  assert.deepEqual(r1.round.failedGateIds, []);

  // 問いを変えたが、前の問いで集めた4分析の run をそのまま根拠にしている。
  const v2 = await writeBrief(root, "brief-r2.json", {
    ...brief,
    label: "r2",
    question: "合成の問いを1つに絞り直した: 最初の一手は何か",
    changes: { ...brief.changes, previous: { label: "r1", sha256: v1.sha256 } },
  });
  const sheet = await strategyBriefReviewTemplate({ workDir: root, briefPath: v2.rel });
  assert.deepEqual(sheet.sheet.premiseChangedFromPrevious, ["question"]);
  assert.deepEqual(sheet.sheet.evidenceStaleByPremise, [{ id: "e-run", changedFields: ["question"] }]);
  const r2 = await recordStrategyBriefRound({
    workDir: root,
    briefPath: v2.rel,
    reviewPath: await reviewFor(root, "r2", { context: "ctx-eval-2", briefSha256: v2.sha256 }),
    revisionDelta: "問いを1つに絞った",
    now,
  });
  assert.equal(r2.recorded, true);
  assert.deepEqual(r2.round.failedGateIds, ["evidence-premise-current"]);
  assert.deepEqual(r2.version.staleEvidence, [{ id: "e-run", reasonCode: "strategy-evidence-stale-premise", changedFields: ["question"] }]);
  // 前提に依らないと宣言した指標は古くならない。
  assert.ok(!r2.version.staleEvidence.some((row) => row.id === "e-metrics"));
  const staleVerdict = await strategyBriefVerdict({ workDir: root, briefPath: path.join(root, v2.rel) });
  assert.equal(staleVerdict.pass, false);
  assert.equal(staleVerdict.refreshRequired, true);
  assert.ok(staleVerdict.reasonCodes.includes(EVIDENCE_REFRESH_REQUIRED_CODE));
  assert.ok(staleVerdict.reasonCodes.includes("strategy-evidence-stale-premise:e-run"));
  assert.match(staleVerdict.detail, /取り直し/u);

  // 新しい問いで4分析を取り直した（別の run・別の SHA）。
  const rerun = await writeAudienceRun(root, "evidence/run-002");
  const v3 = await writeBrief(root, "brief-r3.json", {
    ...v2.brief,
    label: "r3",
    evidence: [v2.brief.evidence[0], { ...v2.brief.evidence[1], path: rerun.rel, sha256: rerun.reportManifestSha256, collected: { at: "2026-09-26", conditions: "合成の4分析（新しい問いで取り直し）" } }],
    changes: { ...v2.brief.changes, previous: { label: "r2", sha256: v2.sha256 } },
  });
  const r3 = await recordStrategyBriefRound({
    workDir: root,
    briefPath: v3.rel,
    reviewPath: await reviewFor(root, "r3", { context: "ctx-eval-3", briefSha256: v3.sha256 }),
    revisionDelta: "新しい問いで4分析を取り直した",
    now,
  });
  assert.equal(r3.state.status, "passed", JSON.stringify(r3.issues));
  const passVerdict = await strategyBriefVerdict({ workDir: root, briefPath: path.join(root, v3.rel) });
  assert.equal(passVerdict.pass, true, JSON.stringify(passVerdict.reasonCodes));
  assert.equal(passVerdict.loop.reviewedLabel, "r3");
  assert.deepEqual(passVerdict.evidence.counts, { unverified: 0, provisional: 2, verified: 0 });
});

test("制作側で provisional を verified に書き換えると verdict が名指しで検出する", async (t) => {
  const { root, brief } = await setup(t);
  await startStrategyBriefLoop({ workDir: root, generatorContextId: PLANNER, now });
  const v1 = await writeBrief(root, "brief.json", brief);
  const r1 = await recordStrategyBriefRound({ workDir: root, briefPath: v1.rel, reviewPath: await reviewFor(root, "r1", { context: "ctx-eval-1", briefSha256: v1.sha256 }), now });
  assert.equal(r1.state.status, "passed");
  assert.equal((await strategyBriefVerdict({ briefPath: path.join(root, v1.rel) })).pass, true);

  // 確かめ方も書き足して形だけは合わせた書き換え。
  await writeFile(path.join(root, v1.rel), jsonBytes({
    ...brief,
    evidence: brief.evidence.map((row) => (row.id === "e-run" ? { ...row, state: "verified", verification: { method: "合成: 見たことにした" } } : row)),
  }));
  const forged = await strategyBriefVerdict({ briefPath: path.join(root, v1.rel) });
  assert.equal(forged.pass, false);
  for (const code of ["strategy-brief-not-reviewed", "strategy-brief-changed-after-review", "strategy-brief-evidence-upgraded-without-review:e-run"]) {
    assert.ok(forged.reasonCodes.includes(code), code);
  }
  assert.deepEqual(forged.evidence.upgradedWithoutReview, [{ id: "e-run", from: "provisional", to: "verified", sameFile: true }]);

  // 確かめ方を書かずに verified にすると、形の誤りでもある。
  await writeFile(path.join(root, v1.rel), jsonBytes({
    ...brief,
    evidence: brief.evidence.map((row) => (row.id === "e-run" ? { ...row, state: "verified" } : row)),
  }));
  const bare = await strategyBriefVerdict({ briefPath: path.join(root, v1.rel) });
  assert.ok(bare.reasonCodes.includes("strategy-brief-invalid"));
  assert.ok(bare.reasonCodes.includes("strategy-brief-evidence-upgraded-without-review:e-run"));
});

test("verdict: ループ前・根拠のファイルの欠落・CLI の --require-pass", async (t) => {
  const { root, brief } = await setup(t);
  const v1 = await writeBrief(root, "brief.json", brief);
  const before = await strategyBriefVerdict({ briefPath: path.join(root, v1.rel) });
  assert.equal(before.pass, false);
  assert.deepEqual(before.reasonCodes, ["strategy-brief-loop-not-started"]);
  assert.equal(before.modelCallsAttempted, false);
  const cli = await runStrategyBriefCli(["verdict", "--brief", path.join(root, v1.rel), "--require-pass"], { stdout: silent() });
  assert.equal(cli.exitCode, 4);
  assert.equal((await runStrategyBriefCli(["verdict", "--brief", path.join(root, v1.rel)], { stdout: silent() })).exitCode, 0);

  const missing = await writeBrief(root, "brief-missing.json", {
    ...brief,
    evidence: [...brief.evidence, { id: "e-gone", kind: "other", path: "evidence/gone.md", sha256: "d".repeat(64), state: "unverified", collected: { at: "unknown", conditions: "合成" } }],
  });
  const result = await strategyBriefVerdict({ briefPath: path.join(root, missing.rel) });
  assert.ok(result.reasonCodes.includes("strategy-evidence-missing:e-gone"));
});
