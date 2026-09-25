import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { prepareKoyaQualityRound } from "../lib/koyaMangaFinalAudit.mjs";
import { createMangaFinalQualityDecision, createMangaQualityContract } from "../lib/mangaQualityHarness.mjs";
import {
  createQualityLoopState,
  deriveFailureFingerprint,
  findStaleQualityFeedback,
  normalizeQualityAcceptance,
  normalizeQualityRubric,
  recordQualityRound,
  rubricFloorFailures,
} from "../lib/qualityLoop.mjs";

const EVIDENCE = [{ path: "audits/signoff.json", sha256: "a".repeat(64), note: "署名済みの全尺レビュー" }];
const contract = createMangaQualityContract({ manifest: { id: "synthetic-episode" } });
const scores = (overrides = {}) => Object.fromEntries(contract.rubric.map((criterion) => [criterion.id, overrides[criterion.id] ?? 100]));

function freshState() {
  return createQualityLoopState({ contract, generatorId: "gen", generatorContextId: "generator-context", startedAt: "2026-09-24T00:00:00Z" });
}

function round(state, { context = "review-context-1", evaluator = "evaluator", reviewScores = scores(), failedGateIds = [], extra = {} } = {}) {
  return recordQualityRound({
    contract,
    state,
    hardGateReport: { pass: failedGateIds.length === 0, failedGateIds, contractDigest: contract.digest },
    // 所見は文脈ごとに違う（前の回の所見の写しは採点に使わない）。
    reviews: [{ evaluatorId: evaluator, evaluatorContextId: context, scores: reviewScores, notes: `全尺を見て所見を書いた（${context}）`, evidence: EVIDENCE }],
    evidence: EVIDENCE,
    observedAt: "2026-09-24T01:00:00Z",
    ...extra,
  });
}

test("1つの評価項目の致命的な低さは、平均が目標に届いても合格にしない", () => {
  // 同一性 47 点・他は満点で加重平均 92.05 が合格していた（2026-09-24）。
  const state = round(freshState(), { reviewScores: scores({ "character-continuity": 47 }) });
  assert.equal(state.rounds[0].score >= contract.limits.targetScore, true, "平均は目標に届いている");
  assert.notEqual(state.status, "passed");
  assert.deepEqual(state.rounds[0].floorFailures, ["character-continuity"]);
  assert.match(state.rounds[0].failureFingerprint, /^quality-failure:/u);
});

test("既定の評価項目は全部に下限があり、同一性・意味の一致・声は高い", () => {
  for (const criterion of contract.rubric) assert.ok(Number.isFinite(criterion.minimumScore), `${criterion.id} に下限が無い`);
  const byId = Object.fromEntries(contract.rubric.map((criterion) => [criterion.id, criterion.minimumScore]));
  assert.equal(byId["character-continuity"], 80);
  assert.equal(byId["semantic-scene-fit"], 80);
  assert.equal(byId["voice-performance"], 80);
  // 下限の無い評価項目の組も受け付ける（ジャンルが決める）。
  assert.deepEqual(rubricFloorFailures([{ scores: { a: 10 } }], { rubric: normalizeQualityRubric([{ id: "a", weight: 1 }]) }), []);
});

test("機械ゲートが全部通って評価点だけ足りない回でも、失敗指紋を作って止まらずに次へ進める", () => {
  // 以前は失敗指紋を落ちたゲート名からしか作らず、この回で例外になっていた。
  const lowAll = scores(Object.fromEntries(contract.rubric.map((criterion) => [criterion.id, 85])));
  const state = round(freshState(), { reviewScores: lowAll });
  assert.equal(state.status, "active");
  assert.equal(state.rounds[0].floorFailures.length, 0);
  assert.match(state.rounds[0].failureFingerprint, /^quality-failure:/u);
  assert.equal(
    state.rounds[0].failureFingerprint,
    deriveFailureFingerprint({ rawReviews: [{ scores: lowAll }], contract, belowTarget: true }),
    "同じ失敗なら同じ指紋",
  );
});

test("同じ評価者でも文脈が新しければ次の回を採点でき、文脈の使い回しは拒否する", () => {
  const first = round(freshState(), { reviewScores: scores({ "voice-performance": 50 }) });
  const second = round(first, {
    context: "review-context-2",
    extra: { previousFailureFingerprint: first.rounds[0].failureFingerprint, revisionDelta: "声を契約の声に差し替えた" },
  });
  assert.equal(second.status, "passed");
  assert.equal(second.rounds[1].reviews[0].repeatEvaluator, true, "同じ評価者であることを記録に残す");
  assert.throws(() => round(first, {
    context: "review-context-1",
    extra: { previousFailureFingerprint: first.rounds[0].failureFingerprint, revisionDelta: "声を差し替えた" },
  }), /Fresh evaluator context required/u);
});

test("回の時刻がループの開始や前の回より早くても例外にせず、経過時間は2つの時刻をまたぐ長さで数える", () => {
  // レビューの署名（observedAt）と、ループを開いた監査の時刻（startedAt）は、
  // 運用によってどちらが先にもなる。順序に依存して例外にすると監査が落ちる。
  const early = round(freshState(), {
    reviewScores: scores({ "voice-performance": 50 }),
    extra: { observedAt: "2026-09-23T23:00:00Z" }, // startedAt の 1 時間前
  });
  assert.equal(early.clockStartedAt, "2026-09-23T23:00:00.000Z");
  assert.equal(early.elapsedMs, 60 * 60_000);
  assert.equal(early.rounds[0].elapsedMs, 60 * 60_000);

  // 2回目のレビューが1回目より前の時刻を名乗っても、経過時間は縮まず負にもならない。
  const second = round(early, {
    context: "review-context-2",
    extra: {
      observedAt: "2026-09-23T22:30:00Z",
      previousFailureFingerprint: early.rounds[0].failureFingerprint,
      revisionDelta: "声を差し替えた",
    },
  });
  assert.equal(second.clockStartedAt, "2026-09-23T22:30:00.000Z");
  assert.equal(second.elapsedMs, 90 * 60_000, "最も早い時刻から最も遅い時刻まで");
  assert.ok(second.rounds.every((entry) => entry.elapsedMs >= 0));

  // 時刻として読めない値は、理由つきで拒否する（順序を正せない）。
  assert.throws(() => round(freshState(), { extra: { observedAt: "not-a-time" } }), /observedAt/u);
});

test("直前の回と同じ所見（正規化後）の評価は採点に使わず、理由コードつきで新しい評価を求める", () => {
  const first = round(freshState(), { reviewScores: scores({ "voice-performance": 50 }) });
  const retry = {
    previousFailureFingerprint: first.rounds[0].failureFingerprint,
    revisionDelta: "声を契約の声に差し替えた",
  };
  // 文脈は新しいが、所見の本文は前回の写し（空白と全角・半角だけ違う）。
  const copied = "  全尺を見て 所見を書いた（review－context－1） ";
  let caught = null;
  try {
    recordQualityRound({
      contract,
      state: first,
      hardGateReport: { pass: true, failedGateIds: [], contractDigest: contract.digest },
      reviews: [{ evaluatorId: "evaluator", evaluatorContextId: "review-context-2", scores: scores(), notes: copied, evidence: EVIDENCE }],
      evidence: EVIDENCE,
      observedAt: "2026-09-24T02:00:00Z",
      ...retry,
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, "前回と同じ所見で満点が付いても回として受け取らない");
  assert.equal(caught.code, "quality-feedback-not-updated");
  assert.equal(
    findStaleQualityFeedback({ state: first, reviews: [{ notes: copied, evaluatorContextId: "review-context-2" }] })?.reasonCode,
    "quality-feedback-not-updated",
  );
  // 所見が更新されていれば回として受け取る。
  const second = round(first, { context: "review-context-2", extra: { ...retry, observedAt: "2026-09-24T02:00:00Z" } });
  assert.equal(second.rounds.length, 2);
  assert.equal(findStaleQualityFeedback({ state: first, reviews: [{ notes: "声の差し替えを確認した" }] }), null);
});

test("合格せずに止まったら、最高点の回を成果物 SHA つきで bestRound に残す（合格扱いにはしない）", () => {
  const limited = createMangaQualityContract({ manifest: { id: "synthetic-episode" }, overrides: { maximumReviewRounds: 2, minimumImprovement: 0 } });
  const start = createQualityLoopState({ contract: limited, generatorId: "gen", generatorContextId: "generator-context", startedAt: "2026-09-24T00:00:00Z" });
  const review = (context, value, notes) => ({ evaluatorId: "evaluator", evaluatorContextId: context, scores: Object.fromEntries(limited.rubric.map((criterion) => [criterion.id, value])), notes, evidence: EVIDENCE });
  const first = recordQualityRound({
    contract: limited,
    state: start,
    hardGateReport: { pass: true, failedGateIds: [], contractDigest: limited.digest },
    reviews: [review("review-context-1", 88, "全体に良いが声の間が詰まっている")],
    evidence: EVIDENCE,
    artifactSha256: "1".repeat(64),
    observedAt: "2026-09-24T01:00:00Z",
  });
  assert.equal(first.status, "active");
  assert.equal(first.bestRound, undefined, "走っている間は置かない");
  const second = recordQualityRound({
    contract: limited,
    state: first,
    hardGateReport: { pass: true, failedGateIds: [], contractDigest: limited.digest },
    reviews: [review("review-context-2", 80, "声の間を直したら背景の破綻が目立った")],
    evidence: EVIDENCE,
    artifactSha256: "2".repeat(64),
    observedAt: "2026-09-24T02:00:00Z",
    previousFailureFingerprint: first.rounds[0].failureFingerprint,
    revisionDelta: "声の間を広げた",
  });
  assert.equal(second.stopReason, "round-limit");
  assert.notEqual(second.status, "passed");
  assert.equal(second.bestRound.index, 1, "最高点は1回目");
  assert.equal(second.bestRound.artifactSha256, "1".repeat(64));
  assert.equal(second.bestRound.score, 88);
  assert.equal(second.bestRound.passed, false, "最高点の回は合格ではない");

  // 最終判定には納品判断の材料として載るが、合格にはならない。
  const decision = createMangaFinalQualityDecision({
    episodeId: "synthetic-episode",
    contractDigest: "3".repeat(64),
    videoSha256: "2".repeat(64),
    requiredAuditIds: ["full-decode"],
    auditSteps: [{ id: "full-decode", pass: true, evidencePath: "audits/media.json", evidenceSha256: "4".repeat(64) }],
    qualityLoopState: second,
  });
  assert.equal(decision.pass, false);
  assert.equal(decision.qualityLoopBestRound.artifactSha256, "1".repeat(64));
});

test("最終監査は、前の回と同じ所見の署名では回を記録せず、理由コードつきで新しい評価を求める", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quality-round-stale-"));
  try {
    const first = round(freshState(), { reviewScores: scores({ "semantic-scene-fit": 40 }) });
    const signoff = { reviewerProvenance: { id: "reviewer", contextId: "review-context-2" } };
    const stale = await prepareKoyaQualityRound({
      state: first,
      signoff,
      outputDir: dir,
      revisionDelta: "背景を差し替えた",
      reviewNotes: { summary: "全尺を見て所見を書いた（review-context-1）" },
    });
    assert.equal(stale.ready, false);
    assert.equal(stale.step.id, "quality-loop-feedback-not-updated");
    assert.match(stale.step.detail, /quality-feedback-not-updated/u);
    const fresh = await prepareKoyaQualityRound({
      state: first,
      signoff,
      outputDir: dir,
      revisionDelta: "背景を差し替えた",
      reviewNotes: { summary: "差し替えた背景を全尺で確かめた" },
    });
    assert.equal(fresh.ready, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("最終監査は、2回目以降の修正内容が無ければ例外ではなく人待ちの理由を返す", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quality-round-"));
  try {
    const first = round(freshState(), { reviewScores: scores({ "semantic-scene-fit": 40 }) });
    const signoff = (contextId) => ({ reviewerProvenance: { id: "reviewer", contextId } });
    const fingerprint = first.rounds[0].failureFingerprint;

    const reused = await prepareKoyaQualityRound({ state: first, signoff: signoff("review-context-1"), outputDir: dir });
    assert.equal(reused.ready, false);
    assert.equal(reused.step.id, "quality-loop-fresh-review");

    const missing = await prepareKoyaQualityRound({ state: first, signoff: signoff("review-context-2"), outputDir: dir });
    assert.equal(missing.ready, false);
    assert.equal(missing.step.id, "quality-loop-revision-delta");
    assert.match(missing.step.detail, new RegExp(fingerprint.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"), "どの失敗への修正かを示す");

    // 別の失敗に宛てた古い修正内容は使わない。
    await writeFile(join(dir, "revision-delta.json"), JSON.stringify({ previousFailureFingerprint: "quality-failure:old", revisionDelta: "古い修正" }));
    assert.equal((await prepareKoyaQualityRound({ state: first, signoff: signoff("review-context-2"), outputDir: dir })).ready, false);

    await writeFile(join(dir, "revision-delta.json"), JSON.stringify({ previousFailureFingerprint: fingerprint, revisionDelta: "台本の3場面目の背景を差し替えた" }));
    const fromFile = await prepareKoyaQualityRound({ state: first, signoff: signoff("review-context-2"), outputDir: dir });
    assert.deepEqual(fromFile, { ready: true, retry: true, previousFailureFingerprint: fingerprint, revisionDelta: "台本の3場面目の背景を差し替えた" });

    const fromFlag = await prepareKoyaQualityRound({ state: first, signoff: signoff("review-context-2"), outputDir: dir, revisionDelta: "引数で渡した修正" });
    assert.equal(fromFlag.revisionDelta, "引数で渡した修正");

    // 用意できた修正内容で、実際に2回目が記録できる。
    const second = round(first, { context: "review-context-2", extra: { previousFailureFingerprint: fromFile.previousFailureFingerprint, revisionDelta: fromFile.revisionDelta } });
    assert.equal(second.rounds.length, 2);
    assert.equal((await prepareKoyaQualityRound({ state: freshState(), signoff: signoff("review-context-9"), outputDir: dir })).retry, false, "1回目は修正内容が要らない");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const panelReview = (context, evaluator, extra = {}) => ({
  evaluatorId: evaluator, evaluatorContextId: context, scores: scores(), notes: `全尺を見て所見を書いた（${context}）`, evidence: EVIDENCE, ...extra,
});
const panelBase = (target) => ({
  hardGateReport: { pass: true, failedGateIds: [], contractDigest: target.digest }, evidence: EVIDENCE, observedAt: "2026-09-24T01:00:00Z",
});
const declaredState = (target) => createQualityLoopState({ contract: target, generatorId: "gen", generatorContextId: "generator-context", startedAt: "2026-09-24T00:00:00Z" });

test("1つの回の中の評価は別々の評価文脈で同じ成果物を採点したものに限る", () => {
  // 同じ文脈の2件を2人分に数えない。
  assert.throws(() => recordQualityRound({
    ...panelBase(contract), contract, state: freshState(), reviews: [panelReview("ctx-a", "eval-a"), panelReview("ctx-a", "eval-b")],
  }), /own evaluator context/u);
  // 別の版の点を混ぜない。
  assert.throws(() => recordQualityRound({
    ...panelBase(contract), contract, state: freshState(), artifactSha256: "1".repeat(64),
    reviews: [panelReview("ctx-a", "eval-a", { artifactSha256: "1".repeat(64) }), panelReview("ctx-b", "eval-b", { artifactSha256: "2".repeat(64) })],
  }), /same artifact/u);
  const two = recordQualityRound({
    ...panelBase(contract), contract, state: freshState(), artifactSha256: "1".repeat(64),
    reviews: [panelReview("ctx-a", "eval-a", { artifactSha256: "1".repeat(64) }), panelReview("ctx-b", "eval-b")],
  });
  assert.equal(two.status, "passed");
  assert.equal(two.rounds[0].reviews.length, 2);
  assert.equal(two.rounds[0].acceptance, undefined, "受け入れ方を宣言していない契約の回の形は変えない");
});

test("評価者を宣言した契約では、欠けた回は平均と下限を満たしても合格にせず、宣言に無い評価者と2件目は回に入れない", () => {
  const declared = { ...contract, acceptance: { evaluators: ["eval-a", "eval-b"] } };
  const start = declaredState(declared);
  const partial = recordQualityRound({ ...panelBase(declared), contract: declared, state: start, reviews: [panelReview("ctx-a", "eval-a")] });
  assert.notEqual(partial.status, "passed");
  assert.deepEqual(partial.rounds[0].acceptance.missingEvaluators, ["eval-b"]);
  assert.deepEqual(partial.rounds[0].acceptance.failures, ["evaluator-missing:eval-b"]);
  assert.match(partial.rounds[0].failureFingerprint, /^quality-failure:/u);
  assert.throws(() => recordQualityRound({ ...panelBase(declared), contract: declared, state: start, reviews: [panelReview("ctx-z", "eval-z")] }), /undeclared evaluator/u);
  assert.throws(() => recordQualityRound({
    ...panelBase(declared), contract: declared, state: start, reviews: [panelReview("ctx-a", "eval-a"), panelReview("ctx-b", "eval-a")],
  }), /only once/u);
  const full = recordQualityRound({
    ...panelBase(declared), contract: declared, state: start, reviews: [panelReview("ctx-a", "eval-a"), panelReview("ctx-b", "eval-b")],
  });
  assert.equal(full.status, "passed");
  assert.throws(() => normalizeQualityAcceptance({ mode: "no-such-mode" }), /Unknown quality acceptance mode/u);
  assert.throws(() => normalizeQualityAcceptance({ evaluators: ["a", "a"] }), /must not repeat/u);
  assert.equal(normalizeQualityAcceptance(undefined).mode, "average");
  assert.throws(() => normalizeQualityAcceptance({ mode: "each-evaluator" }), /requires declared evaluators/u);
  // 受け入れ方の失敗が無い回の失敗指紋は、今までと同じ値。
  assert.equal(
    deriveFailureFingerprint({ floorFailures: ["x"], acceptanceFailures: [] }),
    deriveFailureFingerprint({ floorFailures: ["x"] }),
  );
});

test("前のループから持ち越した回数・費用・時間を、止まる条件の判定に足す（持ち越しが無ければ今までと同じ）", () => {
  const low = scores({ "voice-performance": 50 });
  const first = (carriedOver) => round(createQualityLoopState({
    contract, generatorId: "gen", generatorContextId: "generator-context", startedAt: "2026-09-24T00:00:00Z", ...(carriedOver ? { carriedOver } : {}),
  }), { reviewScores: low });
  assert.equal(first(null).status, "active", "持ち越しが無ければ1回目で止まらない");
  assert.equal(first(null).carriedOver, undefined);
  // 漫画の既定は2回まで。前のループの1回を足すと、この1回で回数の上限に届く。
  const rounds = first({ rounds: 1, cost: 0, elapsedMs: 0, loops: 1 });
  assert.equal(rounds.stopReason, "round-limit");
  assert.deepEqual(rounds.carriedOver, { loops: 1, rounds: 1, cost: 0, elapsedMs: 0, unpricedCount: 0 });
  assert.equal(first({ rounds: 0, cost: 100, elapsedMs: 0, loops: 1 }).stopReason, "cost-limit");
  assert.equal(first({ rounds: 0, cost: 0, elapsedMs: contract.limits.maximumElapsedMs, loops: 1 }).stopReason, "time-limit");
});

test("採用した指摘が次の回でも出たら、点が上がっても停滞として数える（渡さなければ今までと同じ）", () => {
  const limited = createMangaQualityContract({ manifest: { id: "synthetic-episode" }, overrides: { maximumReviewRounds: 5, maximumStagnantRounds: 1 } });
  const start = createQualityLoopState({ contract: limited, generatorId: "gen", generatorContextId: "generator-context", startedAt: "2026-09-24T00:00:00Z" });
  const reviewWith = (context, value) => ({
    evaluatorId: "evaluator", evaluatorContextId: context, notes: `全尺を見た（${context}）`, evidence: EVIDENCE,
    scores: Object.fromEntries(limited.rubric.map((criterion) => [criterion.id, criterion.id === "voice-performance" ? value : 100])),
  });
  const next = (state, context, value, extra = {}) => recordQualityRound({
    contract: limited,
    state,
    hardGateReport: { pass: true, failedGateIds: [], contractDigest: limited.digest },
    reviews: [reviewWith(context, value)],
    evidence: EVIDENCE,
    observedAt: "2026-09-24T01:00:00Z",
    ...(state.rounds.length ? { previousFailureFingerprint: state.rounds.at(-1).failureFingerprint, revisionDelta: "声を差し替えた" } : {}),
    ...extra,
  });
  const first = next(start, "ctx-1", 40);
  const improved = next(first, "ctx-2", 60);
  assert.equal(improved.status, "active", "点が上がり、直っていない指摘も無ければ止まらない");
  assert.equal(improved.rounds[1].unresolvedFindingIds, undefined);
  const recurring = next(first, "ctx-2", 60, { unresolvedFindingIds: ["r1-f1"] });
  assert.equal(recurring.stagnantRounds, 1);
  assert.equal(recurring.stopReason, "no-improvement");
  assert.deepEqual(recurring.rounds[1].unresolvedFindingIds, ["r1-f1"]);
});

test("each-evaluator は宣言した評価者それぞれの総合点と項目の下限を見て、平均だけ目標を越える回を合格にしない", () => {
  const each = { ...contract, acceptance: { mode: "each-evaluator", evaluators: ["eval-a", "eval-b"] } };
  const average = { ...contract, acceptance: { mode: "average", evaluators: ["eval-a", "eval-b"] } };
  const low = scores(Object.fromEntries(contract.rubric.map((criterion) => [criterion.id, 86])));
  const reviews = [panelReview("ctx-a", "eval-a"), panelReview("ctx-b", "eval-b", { scores: low })];
  // 平均は 93 で目標（92）を越え、どの項目も下限を割らない。
  const byAverage = recordQualityRound({ ...panelBase(average), contract: average, state: declaredState(average), reviews });
  assert.equal(byAverage.status, "passed");
  const byEach = recordQualityRound({ ...panelBase(each), contract: each, state: declaredState(each), reviews });
  assert.notEqual(byEach.status, "passed");
  assert.ok(byEach.rounds[0].score >= contract.limits.targetScore, "平均は目標に届いている");
  assert.deepEqual(byEach.rounds[0].acceptance.failures, ["evaluator-below-minimum:eval-b"]);
  assert.deepEqual(byEach.rounds[0].acceptance.evaluators.map((row) => row.meetsMinimum), [true, false]);
  assert.notEqual(byEach.rounds[0].failureFingerprint, deriveFailureFingerprint({ rawReviews: reviews, contract: each }), "受け入れ方の失敗は指紋に入る");
  // 片方欠けも合格にしない。
  const partial = recordQualityRound({ ...panelBase(each), contract: each, state: declaredState(each), reviews: [panelReview("ctx-a", "eval-a")] });
  assert.deepEqual(partial.rounds[0].acceptance.failures, ["evaluator-missing:eval-b"]);
  // 評価者ごとの項目の下限割れは、その評価者の失敗として残る。
  const floor = scores({ "character-continuity": 70 });
  const floored = recordQualityRound({ ...panelBase(each), contract: each, state: declaredState(each), reviews: [panelReview("ctx-a", "eval-a"), panelReview("ctx-b", "eval-b", { scores: floor })] });
  assert.deepEqual(floored.rounds[0].acceptance.failures, ["evaluator-floor-failed:eval-b:character-continuity"]);
  // 評価者ごとの総合点の下限を目標とは別に宣言できる。
  const relaxed = { ...contract, acceptance: { mode: "each-evaluator", evaluators: ["eval-a", "eval-b"], minimumEvaluatorScore: 85 } };
  const relaxedRound = recordQualityRound({ ...panelBase(relaxed), contract: relaxed, state: declaredState(relaxed), reviews });
  assert.equal(relaxedRound.status, "passed");
  assert.throws(() => normalizeQualityAcceptance({ mode: "average", evaluators: ["a"], minimumEvaluatorScore: 85 }), /each-evaluator/u);
  assert.throws(() => normalizeQualityAcceptance({ mode: "each-evaluator", evaluators: ["a"], minimumEvaluatorScore: 120 }), /minimumEvaluatorScore/u);
});
