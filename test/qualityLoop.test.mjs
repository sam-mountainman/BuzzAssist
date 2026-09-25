import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { prepareKoyaQualityRound } from "../lib/koyaMangaFinalAudit.mjs";
import { createMangaQualityContract } from "../lib/mangaQualityHarness.mjs";
import { createQualityLoopState, deriveFailureFingerprint, normalizeQualityRubric, recordQualityRound, rubricFloorFailures } from "../lib/qualityLoop.mjs";

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
    reviews: [{ evaluatorId: evaluator, evaluatorContextId: context, scores: reviewScores, notes: "全尺を見て所見を書いた", evidence: EVIDENCE }],
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
