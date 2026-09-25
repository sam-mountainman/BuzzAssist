import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  STRATEGY_BRIEF_GENERATOR_ID,
  STRATEGY_BRIEF_REVIEW_SHEET_FORBIDDEN_KEYS,
  STRATEGY_BRIEF_RUBRIC,
  createStrategyBriefQualityContract,
  recordStrategyBriefRound,
  startStrategyBriefLoop,
  strategyBriefReviewTemplate,
  strategyBriefStatus,
} from "../lib/strategyBriefQualityLoop.mjs";
import {
  captureStrategyBriefLearning,
  strategyBriefRoundLearningCandidates,
} from "../lib/strategyBriefLearning.mjs";
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
let clock = Date.parse("2026-09-26T00:00:00.000Z");
const now = () => {
  clock += 60_000;
  return new Date(clock).toISOString();
};
const CONTRACT = createStrategyBriefQualityContract();
const scores = (overrides = {}) => Object.fromEntries(CONTRACT.rubric.map((row) => [row.id, overrides[row.id] ?? 92]));

async function writeBrief(root, rel, brief) {
  const bytes = jsonBytes(brief);
  await writeFile(path.join(root, ...rel.split("/")), bytes);
  return { rel, sha256: sha(bytes), brief };
}

async function setup(t) {
  const root = await workspace(t);
  const metrics = await writeJson(root, "evidence/metrics.json", metricsOutput());
  const brief = sampleBrief({
    evidence: [evidenceRow(metrics, { id: "e-metrics", kind: "metrics", premiseBound: false, premiseIndependenceReason: "合成: 公開済みの動画の実測" })],
    changes: { previous: null, keep: [{ point: "合成の残す点", evidenceIds: ["e-metrics"] }], change: [] },
  });
  const first = await writeBrief(root, "brief-r1.json", brief);
  return { root, metrics, first };
}

async function writeReview(root, name, body) {
  const rel = `quality/reviews/${name}.json`;
  await writeJson(root, rel, body);
  return rel;
}

function review({ context, briefSha256, rubricScores = scores(), evaluatorId = "evaluator" }) {
  return {
    evaluatorId,
    evaluatorContextId: context,
    evaluatorHost: "codex",
    briefSha256,
    rubricScores,
    notes: `ブリーフと根拠のファイルを開いて照合した所見（${context}）`,
    findings: [],
  };
}

const start = (root, extra = {}) => startStrategyBriefLoop({ workDir: root, generatorContextId: PLANNER, generatorHost: "claude-code", now, ...extra });
const record = (root, extra) => recordStrategyBriefRound({ workDir: root, now, ...extra });

function forbiddenKeysIn(value, found = []) {
  if (Array.isArray(value)) value.forEach((entry) => forbiddenKeysIn(entry, found));
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (STRATEGY_BRIEF_REVIEW_SHEET_FORBIDDEN_KEYS.includes(key)) found.push(key);
      forbiddenKeysIn(child, found);
    }
  }
  return found;
}

test("企画の評価項目は BuzzAssist の一般的な基準6つで、下限つき", () => {
  assert.deepEqual(CONTRACT.rubric.map((row) => row.id), [
    "single-question", "audience-specificity", "promise-payoff", "evidence-honesty", "change-grounding", "producibility",
  ]);
  assert.equal(STRATEGY_BRIEF_RUBRIC.reduce((sum, row) => sum + row.weight, 0), 100);
  assert.ok(CONTRACT.rubric.every((row) => Number.isFinite(row.minimumScore)));
  assert.ok(CONTRACT.machineGates.includes("evidence-files-match"));
  assert.ok(CONTRACT.machineGates.includes("audience-runs-current"));
});

test("評価シートに合格点・下限・重み・前の回の点数を載せない（2回目の版でも）", async (t) => {
  const { root, first } = await setup(t);
  await start(root);
  const initial = await strategyBriefReviewTemplate({ workDir: root, briefPath: first.rel });
  assert.deepEqual(forbiddenKeysIn(initial.sheet), []);
  assert.deepEqual(Object.keys(initial.sheet.rubric[0]).sort(), ["description", "id", "label"]);
  assert.equal(initial.template.briefSha256, first.sha256);
  assert.ok(Object.values(initial.template.rubricScores).every((value) => value === null));

  // 1回目を不合格で記録してから、2回目の版のシートを見る。
  const r1 = await writeReview(root, "r1", review({ context: "ctx-eval-1", briefSha256: first.sha256, rubricScores: scores({ "promise-payoff": 40 }) }));
  assert.equal((await record(root, { briefPath: first.rel, reviewPath: r1 })).recorded, true);
  const second = await writeBrief(root, "brief-r2.json", { ...first.brief, label: "r2", changes: { ...first.brief.changes, previous: { label: "r1", sha256: first.sha256 } } });
  const sheet2 = await strategyBriefReviewTemplate({ workDir: root, briefPath: second.rel });
  assert.deepEqual(forbiddenKeysIn(sheet2.sheet), []);
  // 雛形の点数欄は空のまま（前の回の点数を写さない）。
  assert.ok(Object.values(sheet2.template.rubricScores).every((value) => value === null));
  assert.equal(sheet2.sheet.previousVersionLabel, "r1");
});

test("独立した評価文脈の採点で合格し、合格した版のブリーフが変わると制作へ渡せない", async (t) => {
  const { root, first } = await setup(t);
  assert.equal((await start(root)).started, true);
  const rel = await writeReview(root, "r1", review({ context: "ctx-eval-1", briefSha256: first.sha256 }));
  const result = await record(root, { briefPath: first.rel, reviewPath: rel });
  assert.equal(result.recorded, true, JSON.stringify(result.issues));
  assert.equal(result.state.status, "passed");
  assert.deepEqual(result.round.failedGateIds, []);
  assert.equal(result.version.premise.digest.length, 64);

  const status = await strategyBriefStatus({ workDir: root });
  assert.equal(status.deliverable, true);
  // 合格の後にブリーフを書き換えた。
  await writeFile(path.join(root, first.rel), jsonBytes({ ...first.brief, question: "合成の別の問いへ書き換えた" }));
  const after = await strategyBriefStatus({ workDir: root });
  assert.equal(after.deliverable, false);
  assert.ok(after.issues.includes("strategy-brief-changed-after-review"));
});

test("評価の文脈の独立: 作った文脈・ブリーフの作成文脈・作り手・作る係の id・前の回の文脈では採点できない", async (t) => {
  const { root, first } = await setup(t);
  await start(root);
  const cases = [
    [{ context: PLANNER }, [], "strategy-brief-evaluator-not-independent"],
    [{ context: "ctx-planner-1" }, [], "strategy-brief-evaluator-not-independent"],
    [{ context: "ctx-helper-9" }, ["ctx-helper-9"], "strategy-brief-evaluator-not-independent"],
    [{ context: "ctx-eval-x", evaluatorId: STRATEGY_BRIEF_GENERATOR_ID }, [], "strategy-brief-evaluator-not-independent"],
  ];
  for (const [index, [fields, producers, code]] of cases.entries()) {
    const rel = await writeReview(root, `bad-${index}`, review({ ...fields, briefSha256: first.sha256 }));
    const result = await record(root, { briefPath: first.rel, reviewPath: rel, producerContexts: producers });
    assert.equal(result.recorded, false);
    assert.deepEqual(result.issues, [code]);
  }
  // ブリーフ自身の provenance.contextId（ループを始めた文脈と別）も採点できない。
  const other = await writeBrief(root, "brief-other.json", { ...first.brief, label: "r1b", provenance: { ...first.brief.provenance, contextId: "ctx-brief-writer" } });
  const byWriter = await writeReview(root, "by-writer", review({ context: "ctx-brief-writer", briefSha256: other.sha256 }));
  assert.deepEqual((await record(root, { briefPath: other.rel, reviewPath: byWriter })).issues, ["strategy-brief-evaluator-not-independent"]);

  // 1回目を不合格で記録し、同じ評価文脈で2回目を採点しようとする。
  const r1 = await writeReview(root, "r1", review({ context: "ctx-eval-1", briefSha256: first.sha256, rubricScores: scores({ "evidence-honesty": 50 }) }));
  const round1 = await record(root, { briefPath: first.rel, reviewPath: r1 });
  assert.equal(round1.recorded, true);
  assert.deepEqual(round1.round.floorFailures, ["evidence-honesty"]);
  const second = await writeBrief(root, "brief-r2.json", { ...first.brief, label: "r2", changes: { ...first.brief.changes, previous: { label: "r1", sha256: first.sha256 } } });
  const reused = await writeReview(root, "r2-reused", review({ context: "ctx-eval-1", briefSha256: second.sha256 }));
  assert.deepEqual((await record(root, { briefPath: second.rel, reviewPath: reused, revisionDelta: "根拠の状態を書き直した" })).issues, ["strategy-brief-fresh-review-required"]);
});

test("採点はブリーフの SHA に縛る。2回目以降は直した内容と前の版へのつながりが要る", async (t) => {
  const { root, first } = await setup(t);
  await start(root);
  const mismatch = await writeReview(root, "mismatch", review({ context: "ctx-eval-0", briefSha256: "0".repeat(64) }));
  assert.deepEqual((await record(root, { briefPath: first.rel, reviewPath: mismatch })).issues, ["strategy-brief-review-brief-mismatch"]);

  const r1 = await writeReview(root, "r1", review({ context: "ctx-eval-1", briefSha256: first.sha256, rubricScores: scores({ "single-question": 30 }) }));
  const round1 = await record(root, { briefPath: first.rel, reviewPath: r1 });
  assert.equal(round1.state.status, "active");

  // 前の版を指さない2回目: 機械ゲート previous-version-linked が落ちる。直した内容が無ければ記録しない。
  const unlinked = await writeBrief(root, "brief-r2.json", { ...first.brief, label: "r2", question: "合成の問いを1つに絞り直した" });
  const r2 = await writeReview(root, "r2", review({ context: "ctx-eval-2", briefSha256: unlinked.sha256 }));
  const noDelta = await record(root, { briefPath: unlinked.rel, reviewPath: r2 });
  assert.equal(noDelta.recorded, false);
  assert.match(noDelta.issues[0], /^strategy-brief-revision-delta-required:quality-failure:/u);
  const withDelta = await record(root, { briefPath: unlinked.rel, reviewPath: r2, revisionDelta: "問いを1つに絞った" });
  assert.equal(withDelta.recorded, true);
  assert.deepEqual(withDelta.round.failedGateIds, ["previous-version-linked"]);
  assert.deepEqual(withDelta.version.premiseChangedFields, ["question"]);
});

test("機械ゲート: 根拠のファイルが変わった・4分析の run が stale なら合格しない", async (t) => {
  const { root, metrics, first } = await setup(t);
  const run = await writeAudienceRun(root, "evidence/run-001");
  const brief = {
    ...first.brief,
    label: "r1-run",
    evidence: [
      ...first.brief.evidence,
      { id: "e-run", kind: "audience-run", path: run.rel, sha256: run.reportManifestSha256, state: "provisional", collected: { at: "2026-09-20", conditions: "合成の4分析" } },
    ],
  };
  const written = await writeBrief(root, "brief-run.json", brief);
  await start(root);
  // 根拠の指標ファイルを書き換え、run のシナリオの結果も差し替える（レポートを作り直していない）。
  await writeFile(path.join(root, metrics.rel), jsonBytes({ ...metricsOutput(), row_count: 99 }));
  const receipt = JSON.parse(await readFile(path.join(run.runDir, "completed", "scenario.json"), "utf8"));
  await writeFile(path.join(run.runDir, "results", receipt.result_file), "# 差し替えた合成の本文\n");
  const rel = await writeReview(root, "r1", review({ context: "ctx-eval-1", briefSha256: written.sha256 }));
  const result = await record(root, { briefPath: written.rel, reviewPath: rel });
  assert.equal(result.recorded, true);
  assert.notEqual(result.state.status, "passed");
  assert.deepEqual(result.round.failedGateIds, ["audience-runs-current", "evidence-files-match"]);
});

test("前の版から根拠の確かさを上げた版は、その事実を版の記録に残す", async (t) => {
  const { root, first } = await setup(t);
  await start(root);
  const r1 = await writeReview(root, "r1", review({ context: "ctx-eval-1", briefSha256: first.sha256, rubricScores: scores({ "evidence-honesty": 40 }) }));
  await record(root, { briefPath: first.rel, reviewPath: r1 });
  const upgraded = {
    ...first.brief,
    label: "r2",
    evidence: [{ ...first.brief.evidence[0], state: "verified", verification: { method: "合成: 元の書き出しと列を照合した" } }],
    changes: { ...first.brief.changes, previous: { label: "r1", sha256: first.sha256 } },
  };
  const second = await writeBrief(root, "brief-r2.json", upgraded);
  const sheet = await strategyBriefReviewTemplate({ workDir: root, briefPath: second.rel });
  assert.deepEqual(sheet.sheet.evidenceStateUpgradesFromPrevious, [{ id: "e-metrics", from: "provisional", to: "verified", sameFile: true }]);
  const r2 = await writeReview(root, "r2", review({ context: "ctx-eval-2", briefSha256: second.sha256 }));
  const result = await record(root, { briefPath: second.rel, reviewPath: r2, revisionDelta: "根拠を確かめて verified にした" });
  assert.equal(result.recorded, true);
  assert.deepEqual(result.version.evidenceStateUpgrades, [{ id: "e-metrics", from: "provisional", to: "verified", sameFile: true }]);
});

test("不合格の回の学習の捕捉へ、作業フォルダとブリーフの channel.id を渡す（積むチャンネルを台帳から引く手がかり）", async (t) => {
  const { root, first } = await setup(t);
  await start(root);
  const inputs = [];
  const captureLearning = async (input) => {
    inputs.push(input);
    return { captured: 0, skippedReason: "disabled" };
  };
  const failing = await writeReview(root, "r1-low", review({ context: "ctx-eval-1", briefSha256: first.sha256, rubricScores: scores({ "promise-payoff": 30 }) }));
  const result = await record(root, { briefPath: first.rel, reviewPath: failing, captureLearning });
  assert.equal(result.recorded, true);
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].workDir, path.resolve(root));
  assert.equal(inputs[0].briefChannelId, first.brief.channel.id);
});

test("不合格の回の学習候補は id だけで、ブリーフの制作条件のハーネスの Channel Pack 宛へ積む", async () => {
  const state = { status: "active", contractDigest: "d".repeat(64), startedAt: "2026-09-26T00:00:00.000Z" };
  const round = { index: 1, failureFingerprint: `quality-failure:${"a".repeat(24)}`, floorFailures: ["promise-payoff"], failedGateIds: ["evidence-files-match"] };
  const version = { label: "r1", briefSha256: "b".repeat(64), harnessId: "narrated-story-video" };
  const [candidate] = strategyBriefRoundLearningCandidates({ state, round });
  assert.match(candidate.text, /promise-payoff/u);
  assert.doesNotMatch(candidate.text, /合成/u);
  const captured = [];
  const capture = (entry) => {
    captured.push(entry);
    return { appended: true, entry: { id: `p-${captured.length}` } };
  };
  const result = await captureStrategyBriefLearning({ state, round, version, contract: CONTRACT, env: {}, capture });
  assert.equal(result.target, "channel-pack:narrated-story");
  assert.equal(result.captured, 1);
  assert.equal(captured[0].target, "channel-pack:narrated-story");
  assert.deepEqual(captured[0].metadata.gateIds, ["evidence-files-match", "promise-payoff"]);
  // 同じ版・同じ指紋は同じ session（冪等の鍵）。
  const again = await captureStrategyBriefLearning({ state, round, version, contract: CONTRACT, env: {}, capture });
  assert.equal(captured[1].session, captured[0].session);
  assert.equal(again.captured, 1);
  // ハーネスの無いブリーフ・止める設定・合格した回からは積まない。
  assert.equal((await captureStrategyBriefLearning({ state, round, version: { ...version, harnessId: "" }, env: {}, capture })).skippedReason, "unknown-harness-route");
  assert.equal((await captureStrategyBriefLearning({ state, round, version, env: { BUZZASSIST_LEARNING_AUTO_CAPTURE: "0" }, capture })).skippedReason, "disabled");
  assert.equal((await captureStrategyBriefLearning({ state: { ...state, status: "passed" }, round, version, env: {}, capture })).skippedReason, "passed");
});

test("CLI: 台本のループと同じ終了コード（0 済んだ / 3 人待ち / 4 未合格）で、--work-dir を省くとブリーフのフォルダを使う", async (t) => {
  const { root, first } = await setup(t);
  const out = () => {
    const chunks = [];
    return { write: (chunk) => chunks.push(chunk), text: () => chunks.join("") };
  };
  const briefPath = path.join(root, first.rel);
  assert.equal((await runStrategyBriefCli(["validate", "--brief", briefPath], { stdout: out() })).exitCode, 0);
  assert.equal((await runStrategyBriefCli(["status", "--brief", briefPath], { stdout: out() })).exitCode, 3);
  assert.equal((await runStrategyBriefCli(["start", "--work-dir", root, "--generator-context", PLANNER], { stdout: out(), now })).exitCode, 0);
  assert.equal((await runStrategyBriefCli(["start", "--work-dir", root, "--generator-context", PLANNER], { stdout: out(), now })).exitCode, 3);
  assert.equal((await runStrategyBriefCli(["status", "--brief", briefPath, "--require-pass"], { stdout: out() })).exitCode, 4);
  const sheetOut = out();
  assert.equal((await runStrategyBriefCli(["sheet", "--brief", briefPath], { stdout: sheetOut })).exitCode, 0);
  assert.equal(JSON.parse(sheetOut.text()).template.briefSha256, first.sha256);

  const learning = [];
  const captureLearning = async (input) => {
    learning.push(input);
    return { captured: 0, skippedReason: "disabled" };
  };
  const bad = await writeReview(root, "cli-bad", review({ context: PLANNER, briefSha256: first.sha256 }));
  assert.equal((await runStrategyBriefCli(["record", "--brief", briefPath, "--review", path.join(root, bad)], { stdout: out(), now, captureLearning })).exitCode, 3);
  const good = await writeReview(root, "cli-good", review({ context: "ctx-eval-cli", briefSha256: first.sha256 }));
  assert.equal((await runStrategyBriefCli(["record", "--brief", briefPath, "--review", path.join(root, good)], { stdout: out(), now, captureLearning })).exitCode, 0);
  assert.equal(learning.length, 0);
  assert.equal((await runStrategyBriefCli(["status", "--brief", briefPath, "--require-pass"], { stdout: out() })).exitCode, 0);
  await assert.rejects(runStrategyBriefCli(["record", "--brief", briefPath], { stdout: out() }), /--review/u);
});
