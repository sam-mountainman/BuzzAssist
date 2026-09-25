import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  APPLICABILITY_REVIEW_REQUIRED_CODE,
  EVIDENCE_REFRESH_REQUIRED_CODE,
  evidencePremiseStaleness,
  premiseChangedFields,
  recordEvidenceApplicability,
  strategyBriefPremiseDigests,
  validateStrategyBrief,
} from "../lib/strategyBrief.mjs";
import {
  createStrategyBriefQualityContract,
  recordStrategyBriefRound,
  startStrategyBriefLoop,
  strategyBriefHandoff,
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
const capture = () => {
  const chunks = [];
  return { stdout: { write: (text) => chunks.push(text) }, json: () => JSON.parse(chunks.join("")) };
};

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

test("前提が変わっていなければ古くない。全角・半角や空白の揺れ、制作条件の並び順は前提の変更に数えない", () => {
  const brief = sampleBrief({
    production: { harnessId: "narrated-story-video", format: "long", conditions: ["合成の制作条件: 既存の声を使う", "合成の制作条件: 図は手描き風"], targetDurationSeconds: 3600 },
    evidence: [{ id: "e-1", kind: "other", path: "a.md", sha256: "a".repeat(64), state: "provisional", collected: { at: "2020-01-01", conditions: "合成" } }],
  });
  const premise = strategyBriefPremiseDigests(brief);
  assert.deepEqual(Object.keys(premise).sort(), ["audience", "digest", "production", "question"]);
  const bound = { ...brief.evidence[0], collected: { ...brief.evidence[0].collected, premise } };
  // 集めた日が古くても、前提が同じなら古くない（日数では決めない）。
  assert.deepEqual(evidencePremiseStaleness({ ...brief, evidence: [bound] }).stale, []);
  const spaced = {
    ...brief,
    question: `  ${brief.question.replace(":", "：")}  `,
    production: { ...brief.production, conditions: [...brief.production.conditions].reverse() },
    evidence: [bound],
  };
  assert.deepEqual(evidencePremiseStaleness(spaced).stale, []);
  // ハーネスの id は経路で、内容の前提ではない。
  assert.deepEqual(evidencePremiseStaleness({ ...brief, production: { ...brief.production, harnessId: "explainer-video" }, evidence: [bound] }).stale, []);
});

test("入口の約束（表現）だけを変えても根拠は古くならない", () => {
  const brief = sampleBrief({ evidence: [] });
  const oldPremise = strategyBriefPremiseDigests(brief);
  const rows = [{ id: "e-bound", kind: "audience-run", path: "runs/r1", sha256: "a".repeat(64), state: "provisional", collected: { at: "2026-09-20", conditions: "合成", premise: oldPremise } }];
  const changedPromise = {
    ...brief,
    entry: { promises: brief.entry.promises.map((row) => (row.id === "p-title" ? { ...row, text: "合成の別の言い方のタイトル" } : row)) },
    evidence: rows,
  };
  const result = evidencePremiseStaleness(changedPromise);
  assert.deepEqual(result.rows, []);
  assert.equal(result.applicabilityReviewRequired, false);
  assert.equal(result.refreshRequired, false);
});

test("前提（問い・見る人・制作条件）を変えると、前の前提で集めた根拠は当てはまりの確認待ちになり、判定で再利用と取り直しに分かれる", () => {
  const brief = sampleBrief({ evidence: [] });
  const oldPremise = strategyBriefPremiseDigests(brief);
  const rows = [
    { id: "e-bound", kind: "audience-run", path: "runs/r1", sha256: "a".repeat(64), state: "provisional", collected: { at: "2026-09-20", conditions: "合成", premise: oldPremise } },
    { id: "e-notes", kind: "market-research", path: "notes.md", sha256: "d".repeat(64), state: "provisional", collected: { at: "2026-09-20", conditions: "合成", premise: oldPremise } },
    { id: "e-free", kind: "metrics", path: "m.json", sha256: "b".repeat(64), state: "provisional", collected: { at: "2026-09-20", conditions: "合成" }, premiseBound: false, premiseIndependenceReason: "合成: 公開済みの実測" },
    { id: "e-new", kind: "other", path: "n.md", sha256: "c".repeat(64), state: "provisional", collected: { at: "2026-09-26", conditions: "合成" } },
  ];
  const changedAudience = { ...brief, audience: { ...brief.audience, who: "合成の別の視聴者像" }, evidence: rows };
  const result = evidencePremiseStaleness(changedAudience);
  assert.equal(result.applicabilityReviewRequired, true);
  assert.equal(result.refreshRequired, false);
  assert.equal(result.reasonCode, APPLICABILITY_REVIEW_REQUIRED_CODE);
  assert.deepEqual(result.stale.map((row) => [row.id, row.status, row.changedFields]), [
    ["e-bound", "applicability-review-required", ["audience"]],
    ["e-notes", "applicability-review-required", ["audience"]],
  ]);
  const changedProduction = { ...brief, production: { ...brief.production, targetDurationSeconds: 900 }, evidence: rows };
  assert.deepEqual(evidencePremiseStaleness(changedProduction).stale.map((row) => row.changedFields), [["production"], ["production"]]);

  // 上位の AI が根拠ごとに判定を記録する。当てはまる根拠は再利用、当てはまらない根拠は取り直し。
  const yes = recordEvidenceApplicability(changedAudience, { evidenceId: "e-bound", applies: true, reason: "合成: 同じ悩みの層の反応で、今の見る人にも当てはまる", decidedBy: "ctx-upper-1" });
  const both = recordEvidenceApplicability(yes.brief, { evidenceId: "e-notes", applies: false, reason: "合成: 前の見る人に限った調査で、今の見る人の需要は示さない" });
  assert.equal(validateStrategyBrief(both.brief).issues.length, 0, JSON.stringify(validateStrategyBrief(both.brief).issues));
  const decided = evidencePremiseStaleness(both.brief);
  assert.deepEqual(decided.reused.map((row) => row.id), ["e-bound"]);
  assert.deepEqual(decided.refresh.map((row) => row.id), ["e-notes"]);
  assert.equal(decided.reasonCode, EVIDENCE_REFRESH_REQUIRED_CODE);
  assert.equal(changedAudience.evidence[0].applicability, undefined, "元のブリーフは変えない");

  // 判定は今の前提の digest に縛る。前提をもう一度変えたら、判定は無いものとしてまた確認待ち。
  const again = evidencePremiseStaleness({ ...both.brief, question: "合成のさらに別の問い: 何から削るか" });
  assert.deepEqual(again.reviewRequired.map((row) => row.id), ["e-bound", "e-notes"]);

  // 判定の要らない行（前提に依らない・前提が変わっていない）には書けない。
  assert.throws(() => recordEvidenceApplicability(changedAudience, { evidenceId: "e-free", applies: true, reason: "合成の理由の文" }), { code: "strategy-evidence-applicability-not-required" });
  assert.throws(() => recordEvidenceApplicability(changedAudience, { evidenceId: "e-new", applies: true, reason: "合成の理由の文" }), { code: "strategy-evidence-applicability-not-required" });
  assert.throws(() => recordEvidenceApplicability(changedAudience, { evidenceId: "e-bound", applies: true, reason: "短" }), { code: "strategy-evidence-applicability-invalid" });
  // 前提に依らない行に判定を書いたブリーフは形の誤り。
  const wrong = { ...changedAudience, evidence: [{ ...rows[2], applicability: { premiseDigest: "e".repeat(64), applies: true, reason: "合成の理由の文" } }] };
  assert.ok(validateStrategyBrief(wrong).issues.includes("unexpected:evidence[0].applicability"));
});

test("前の記録に制作条件の digest が無い（入口の約束を前提に数えていた頃の記録）なら、分からないので確認待ちにする", () => {
  const brief = sampleBrief({ evidence: [] });
  const current = strategyBriefPremiseDigests(brief);
  const legacy = { digest: "f".repeat(64), question: current.question, audience: current.audience, entryPromises: "0".repeat(64) };
  assert.deepEqual(premiseChangedFields(legacy, current), ["production"]);
  const row = { id: "e-old", kind: "other", path: "old.md", sha256: "a".repeat(64), state: "provisional", collected: { at: "2026-09-01", conditions: "合成", premise: legacy } };
  assert.equal(validateStrategyBrief({ ...brief, evidence: [row] }).issues.length, 0);
  assert.deepEqual(evidencePremiseStaleness({ ...brief, evidence: [row] }).reviewRequired.map((entry) => entry.id), ["e-old"]);
});

test("品質ループと verdict: 問いを変えた版は確認待ちで落ち、判定の記録で再利用・取り直しに分かれ、取り直した版で合格する", async (t) => {
  const { root, brief } = await setup(t);
  await startStrategyBriefLoop({ workDir: root, generatorContextId: PLANNER, now });
  const v1 = await writeBrief(root, "brief-r1.json", brief);
  const r1 = await recordStrategyBriefRound({ workDir: root, briefPath: v1.rel, reviewPath: await reviewFor(root, "r1", { context: "ctx-eval-1", briefSha256: v1.sha256, rubricScores: scores({ "single-question": 40 }) }), now });
  assert.equal(r1.recorded, true);
  assert.deepEqual(r1.round.failedGateIds, []);

  // 入口の約束（タイトルの言い方）だけを変えた版では、根拠は古くならない。
  const v2 = await writeBrief(root, "brief-r2.json", {
    ...brief,
    label: "r2",
    entry: { promises: brief.entry.promises.map((row) => (row.id === "p-title" ? { ...row, text: "合成のタイトルの言い方を変えた" } : row)) },
    changes: { ...brief.changes, previous: { label: "r1", sha256: v1.sha256 } },
  });
  const sheet2 = await strategyBriefReviewTemplate({ workDir: root, briefPath: v2.rel });
  assert.deepEqual(sheet2.sheet.premiseChangedFromPrevious, []);
  assert.equal(sheet2.sheet.entryChangedFromPrevious, true);
  assert.deepEqual(sheet2.sheet.evidenceStaleByPremise, []);
  const r2 = await recordStrategyBriefRound({
    workDir: root, briefPath: v2.rel, reviewPath: await reviewFor(root, "r2", { context: "ctx-eval-2", briefSha256: v2.sha256, rubricScores: scores({ "single-question": 40 }) }), revisionDelta: "タイトルを言い換えた", now,
  });
  assert.deepEqual(r2.round.failedGateIds, []);

  // 問いを変えたが、前の問いで集めた4分析の run をそのまま根拠にしている → 当てはまりの確認待ち。
  const v3Brief = {
    ...v2.brief,
    label: "r3",
    question: "合成の問いを1つに絞り直した: 最初の一手は何か",
    changes: { ...v2.brief.changes, previous: { label: "r2", sha256: v2.sha256 } },
  };
  const v3 = await writeBrief(root, "brief-r3.json", v3Brief);
  const sheet3 = await strategyBriefReviewTemplate({ workDir: root, briefPath: v3.rel });
  assert.deepEqual(sheet3.sheet.premiseChangedFromPrevious, ["question"]);
  assert.deepEqual(sheet3.sheet.evidenceStaleByPremise, [{ id: "e-run", status: "applicability-review-required", changedFields: ["question"] }]);
  const verdict3 = await strategyBriefVerdict({ workDir: root, briefPath: path.join(root, v3.rel) });
  assert.ok(verdict3.reasonCodes.includes("strategy-evidence-applicability-review-required:e-run"));
  assert.ok(verdict3.reasonCodes.includes(APPLICABILITY_REVIEW_REQUIRED_CODE));
  assert.ok(!verdict3.reasonCodes.includes(EVIDENCE_REFRESH_REQUIRED_CODE));
  assert.match(verdict3.detail, /当てはまりの確認待ち 1 件/u);

  // CLI: 判定が要る根拠の一覧（何も書かない）。
  const list = capture();
  assert.equal((await runStrategyBriefCli(["applicability", "--brief", path.join(root, v3.rel)], { stdout: list.stdout })).exitCode, 0);
  assert.deepEqual(list.json().reviewRequired.map((row) => [row.id, row.boundBy, row.changedFields]), [["e-run", "quality-loop-history", ["question"]]]);
  assert.equal(sha(await readFile(path.join(root, v3.rel))), v3.sha256, "一覧は何も書かない");

  // 当てはまらないと判定 → その根拠だけ取り直し。判定はブリーフの行に入る（SHA が変わる）。
  const no = capture();
  const noResult = await runStrategyBriefCli([
    "applicability", "--brief", path.join(root, v3.rel), "--evidence", "e-run", "--applies", "no",
    "--reason", "合成: 前の問いの反応で、新しい問いの答えを示さない", "--context", "ctx-upper-1",
  ], { stdout: no.stdout, now });
  assert.equal(noResult.exitCode, 0);
  assert.equal(no.json().evidence.status, "refresh-required");
  assert.notEqual(no.json().briefSha256, v3.sha256);
  const written = JSON.parse(await readFile(path.join(root, v3.rel), "utf8"));
  assert.equal(written.evidence[1].applicability.applies, false);
  assert.equal(written.evidence[1].applicability.decidedBy, "ctx-upper-1");
  const refresh = await strategyBriefVerdict({ workDir: root, briefPath: path.join(root, v3.rel) });
  assert.ok(refresh.reasonCodes.includes("strategy-evidence-refresh-required:e-run"));
  assert.ok(refresh.reasonCodes.includes(EVIDENCE_REFRESH_REQUIRED_CODE));
  assert.equal(refresh.refreshRequired, true);
  const handoff = await strategyBriefHandoff({ briefPath: path.join(root, v3.rel) });
  assert.deepEqual(handoff.applicability, { reviewRequired: 0, refreshRequired: 1, reused: 0 });
  assert.equal(handoff.evidence.stale, 1);
  assert.match(handoff.summary, /取り直しが要る根拠 1 件/u);

  // 判定の要らない根拠（前提に依らない実測）は記録しない（終了コード 3）。
  const skip = await runStrategyBriefCli([
    "applicability", "--brief", path.join(root, v3.rel), "--evidence", "e-metrics", "--applies", "yes", "--reason", "合成の理由の文",
  ], { stdout: silent(), now });
  assert.equal(skip.exitCode, 3);
  assert.deepEqual(skip.result.issues, ["strategy-evidence-applicability-not-required:e-metrics"]);

  // 当てはまると判定し直す（--out で別のファイルへ。元のブリーフは変えない）→ 再利用して機械ゲートを通る。
  const reuseRel = "brief-r3-reuse.json";
  const yes = capture();
  assert.equal((await runStrategyBriefCli([
    "applicability", "--brief", path.join(root, v3.rel), "--evidence", "e-run", "--applies", "yes",
    "--reason", "合成: 問いを絞っただけで、同じ見る人の反応として今の問いにも当てはまる", "--out", path.join(root, reuseRel),
  ], { stdout: yes.stdout, now })).exitCode, 0);
  assert.equal(yes.json().written, reuseRel);
  assert.deepEqual(yes.json().reused.map((row) => row.id), ["e-run"]);
  const reuse = JSON.parse(await readFile(path.join(root, reuseRel), "utf8"));
  const r3 = await recordStrategyBriefRound({
    workDir: root, briefPath: reuseRel, reviewPath: await reviewFor(root, "r3", { context: "ctx-eval-3", briefSha256: sha(await readFile(path.join(root, reuseRel))) }),
    revisionDelta: "問いを1つに絞り、前の4分析が今の問いに当てはまるかを判定した", now,
  });
  assert.deepEqual(r3.round.failedGateIds, []);
  assert.equal(r3.state.status, "passed", JSON.stringify(r3.issues));
  assert.deepEqual(r3.version.reusedEvidence, [{ id: "e-run", changedFields: ["question"] }]);
  const pass = await strategyBriefVerdict({ workDir: root, briefPath: path.join(root, reuseRel) });
  assert.equal(pass.pass, true, JSON.stringify(pass.reasonCodes));
  assert.deepEqual(pass.evidence.reused.map((row) => row.id), ["e-run"]);
  assert.equal(reuse.evidence[1].applicability.applies, true);
});

test("品質ループ: 当てはまらない根拠を取り直した（別の run・別の SHA）版は、確認なしで合格する", async (t) => {
  const { root, brief } = await setup(t);
  await startStrategyBriefLoop({ workDir: root, generatorContextId: PLANNER, now });
  const v1 = await writeBrief(root, "brief-r1.json", brief);
  await recordStrategyBriefRound({ workDir: root, briefPath: v1.rel, reviewPath: await reviewFor(root, "r1", { context: "ctx-eval-1", briefSha256: v1.sha256, rubricScores: scores({ "single-question": 40 }) }), now });
  const v2 = await writeBrief(root, "brief-r2.json", {
    ...brief,
    label: "r2",
    question: "合成の問いを1つに絞り直した: 最初の一手は何か",
    changes: { ...brief.changes, previous: { label: "r1", sha256: v1.sha256 } },
  });
  const r2 = await recordStrategyBriefRound({ workDir: root, briefPath: v2.rel, reviewPath: await reviewFor(root, "r2", { context: "ctx-eval-2", briefSha256: v2.sha256 }), revisionDelta: "問いを1つに絞った", now });
  assert.deepEqual(r2.round.failedGateIds, ["evidence-premise-current"]);
  assert.deepEqual(r2.version.staleEvidence, [{ id: "e-run", status: "applicability-review-required", reasonCode: APPLICABILITY_REVIEW_REQUIRED_CODE, changedFields: ["question"] }]);
  // 前提に依らないと宣言した指標は確認待ちにならない。
  assert.ok(!r2.version.staleEvidence.some((row) => row.id === "e-metrics"));

  const rerun = await writeAudienceRun(root, "evidence/run-002");
  const v3 = await writeBrief(root, "brief-r3.json", {
    ...v2.brief,
    label: "r3",
    evidence: [v2.brief.evidence[0], { ...v2.brief.evidence[1], path: rerun.rel, sha256: rerun.reportManifestSha256, collected: { at: "2026-09-26", conditions: "合成の4分析（新しい問いで取り直し）" } }],
    changes: { ...v2.brief.changes, previous: { label: "r2", sha256: v2.sha256 } },
  });
  const r3 = await recordStrategyBriefRound({ workDir: root, briefPath: v3.rel, reviewPath: await reviewFor(root, "r3", { context: "ctx-eval-3", briefSha256: v3.sha256 }), revisionDelta: "新しい問いで4分析を取り直した", now });
  assert.equal(r3.state.status, "passed", JSON.stringify(r3.issues));
  const passVerdict = await strategyBriefVerdict({ workDir: root, briefPath: path.join(root, v3.rel) });
  assert.equal(passVerdict.pass, true, JSON.stringify(passVerdict.reasonCodes));
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
