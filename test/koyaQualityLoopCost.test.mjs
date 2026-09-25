import assert from "node:assert/strict";
import test from "node:test";

import { createKoyaQualityRoundInput } from "../lib/koyaMangaFinalAudit.mjs";
import { createMangaQualityContract } from "../lib/mangaQualityHarness.mjs";
import { createQualityLoopState, recordQualityRound } from "../lib/qualityLoop.mjs";

// 漫画の最終監査は、品質ループの「費用」の停止条件へ値を渡していなかった（外部レビューの指摘）。
// 費用は常に 0 のまま数えられ、上限を何度作り直しても cost-limit で止まらなかった。
// 有料 take の台帳（speech report の mediaJobs。RunReceipt に載る有料生成の記録と同じもの）
// から回ごとに集計して渡す。同じ Media Job を2回数えない。単位と出どころを記録する。

const SHA = (char) => char.repeat(64);
const EVIDENCE = [{ path: "audits/koya-final/agent-visual-signoff.json", sha256: SHA("a"), note: "署名済みの全尺レビュー" }];

function contract(overrides = {}) {
  return createMangaQualityContract({ manifest: { id: "synthetic-episode" }, overrides });
}

function scores(value, loopContract) {
  return Object.fromEntries(loopContract.rubric.map((criterion) => [criterion.id, value]));
}

function paidTake(requestKey, usage = {}, reservation = {}) {
  return {
    jobId: `job-${requestKey}`,
    requestKey,
    status: "completed",
    kind: "voice.dialogue",
    provider: "synthetic-provider",
    usage: { cost: null, currency: "", freeRegeneration: false, ...usage },
    reservation: { estimatedCost: null, currency: "", ...reservation },
  };
}

function roundInput(loopContract, state, { context, jobs, score = 70, retry = null }) {
  return createKoyaQualityRoundInput({
    contract: loopContract,
    state,
    signoff: {
      reviewerProvenance: { host: "codex", id: "codex:synthetic-reviewer", contextId: context },
      reviewNotesContentSha256: SHA("b"),
      reviewedAt: "2026-09-24T01:00:00.000Z",
    },
    reviewNotes: { rubricScores: scores(score, loopContract), summary: "全尺を見て所見を書いた" },
    auditSteps: [{ id: "full-decode", pass: true }],
    roundEvidence: EVIDENCE,
    evidenceMerkleRoot: SHA("c"),
    qualityRoundReady: retry ? { ready: true, retry: true, ...retry } : { ready: true, retry: false },
    paidMediaJobs: jobs,
    paidCostSource: { path: "canvas/manga-videos/synthetic-episode/speech-report.json", sha256: SHA("d") },
  });
}

function freshState(loopContract) {
  return createQualityLoopState({
    contract: loopContract,
    generatorId: "codex:synthetic-generator",
    generatorContextId: "generator-context",
    startedAt: "2026-09-24T00:00:00.000Z",
  });
}

test("漫画の最終監査は有料 take の費用を回ごとに集計して品質ループへ渡し、同じ take を2回数えない", () => {
  const loopContract = contract();
  const first = recordQualityRound(roundInput(loopContract, freshState(loopContract), {
    context: "review-context-1",
    jobs: [paidTake("req-a", { cost: 1.5, currency: "USD" }), paidTake("req-b", { cost: 2.5, currency: "USD" })],
  }));
  assert.equal(first.rounds[0].cost, 4, "1回目はそこまでの有料 take 全部");
  assert.equal(first.totalCost, 4);
  assert.equal(first.rounds[0].costAccounting.unit, "USD", "単位を記録する");
  assert.equal(first.rounds[0].costAccounting.source.path, "canvas/manga-videos/synthetic-episode/speech-report.json", "出どころを記録する");
  assert.equal(first.rounds[0].costAccounting.source.sha256, SHA("d"));
  assert.equal(first.costUnit, "USD");

  const second = recordQualityRound(roundInput(loopContract, first, {
    context: "review-context-2",
    jobs: [
      paidTake("req-a", { cost: 1.5, currency: "USD" }),
      paidTake("req-b", { cost: 2.5, currency: "USD" }),
      paidTake("req-c", { cost: 1, currency: "USD" }),
    ],
    retry: { previousFailureFingerprint: first.rounds[0].failureFingerprint, revisionDelta: "声のテイクを1つ作り直した" },
  }));
  assert.equal(second.rounds[1].cost, 1, "2回目は新しく払った分だけ");
  assert.equal(second.totalCost, 5);
});

test("費用の上限に届いたら、合格していない回は cost-limit で人の判断へ回す", () => {
  const loopContract = contract({ maximumCost: 3 });
  const state = recordQualityRound(roundInput(loopContract, freshState(loopContract), {
    context: "review-context-1",
    jobs: [paidTake("req-a", { cost: 4, currency: "USD" })],
  }));
  assert.equal(state.status, "budget-exhausted");
  assert.equal(state.stopReason, "cost-limit");
});

test("実費が無い take は見積もりで数え、見積もりも無い take は数えられなかったことを残す", () => {
  const loopContract = contract();
  const state = recordQualityRound(roundInput(loopContract, freshState(loopContract), {
    context: "review-context-1",
    jobs: [
      paidTake("req-a", {}, { estimatedCost: 2, currency: "USD" }),
      paidTake("req-b"),
      paidTake("req-c", { cost: 9, currency: "USD", freeRegeneration: true }),
    ],
  }));
  const accounting = state.rounds[0].costAccounting;
  assert.equal(state.rounds[0].cost, 2);
  assert.equal(accounting.estimatedCount, 1);
  assert.equal(accounting.unpricedCount, 1, "費用の分からない take を 0 円として黙って通さない");
  assert.equal(accounting.freeCount, 1, "無料の作り直しは数えない");
});

test("通貨の混在は合計できないので、合格していない回は人の判断で止める", () => {
  const loopContract = contract();
  const state = recordQualityRound(roundInput(loopContract, freshState(loopContract), {
    context: "review-context-1",
    jobs: [paidTake("req-a", { cost: 1, currency: "USD" }), paidTake("req-b", { cost: 100, currency: "JPY" })],
  }));
  assert.equal(state.status, "blocked");
  assert.match(state.blockingCondition, /cost-unit/u);
  assert.equal(state.rounds[0].costAccounting.unit, "mixed");
});
