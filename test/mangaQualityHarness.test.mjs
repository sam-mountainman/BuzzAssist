import test from "node:test";
import assert from "node:assert/strict";

import {
  auditMangaPreflight,
  classifyMangaDecisionGate,
  createBlindCandidateSet,
  createMangaFinalQualityDecision,
  createMangaQualityContract,
  createMangaQualityLoopState,
  recordMangaQualityIncident,
  recordMangaQualityRound,
  revealBlindSelection,
} from "../lib/mangaQualityHarness.mjs";

function manifest() {
  return {
    id: "quality-episode",
    cuts: [{ id: "cut-01", description: "雨の写真店で対話", utteranceIds: ["u1", "u2"] }],
    utterances: [
      { id: "u1", cutId: "cut-01", text: "ただいま", speechText: "ただいま", speakerId: "mio", voiceId: "voice-mio" },
      { id: "u2", cutId: "cut-01", text: "おかえり", speechText: "おかえり", speakerId: "reiji", voiceId: "voice-reiji" },
    ],
  };
}

const perfectScores = {
  "semantic-scene-fit": 100,
  "character-continuity": 100,
  "camera-composition": 100,
  "editorial-grammar": 100,
  "bubble-typography": 100,
  "voice-performance": 100,
  "audio-technical": 100,
  "timing-continuity": 100,
  "final-playback": 100,
};

test("quality contract is deterministic, normalized, and immutable", () => {
  const first = createMangaQualityContract({
    manifest: manifest(),
    channelDirectives: { audience: "移動中のスマホ視聴者", prohibitedPatterns: ["同じ構図の連続", "同じ構図の連続"] },
  });
  const second = createMangaQualityContract({
    manifest: manifest(),
    channelDirectives: { prohibitedPatterns: ["同じ構図の連続"], audience: "移動中のスマホ視聴者" },
  });
  assert.equal(first.digest, second.digest);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.rubric), true);
  assert.equal(first.rubric.reduce((sum, entry) => sum + entry.weight, 0), 100);
  assert.deepEqual(first.channelDirectives.prohibitedPatterns, ["日本語文字を画像素材へ焼き込まない", "同じ構図の連続"]);
});

test("quality contract inherits the pinned manifest loop and candidate limits", () => {
  const pinned = manifest();
  pinned.production = {
    qualityPolicy: {
      qualityLoopLimits: {
        targetScore: 94,
        maximumReviewRounds: 3,
        maximumElapsedMinutes: 45,
        maximumCostUnits: 25,
        minimumImprovementPoints: 2,
        maximumStagnantRounds: 2,
      },
      candidateDecision: { minimumCandidates: 3, maximumCandidates: 4 },
    },
  };
  const contract = createMangaQualityContract({ manifest: pinned });
  assert.deepEqual(contract.limits, {
    targetScore: 94,
    maximumReviewRounds: 3,
    maximumElapsedMs: 45 * 60 * 1_000,
    maximumCost: 25,
    minimumImprovement: 2,
    maximumStagnantRounds: 2,
  });
  assert.equal(contract.candidatePolicy.minimumCandidates, 3);
  assert.equal(contract.candidatePolicy.maximumCandidates, 4);
});

test("preflight hard gates detect broken coverage, missing voices, and baked text", () => {
  const broken = manifest();
  broken.cuts[0].utteranceIds = ["u1", "missing"];
  broken.utterances[0].voiceId = "";
  broken.cuts[0].imageGeneration = { containsBakedText: true };
  const contract = createMangaQualityContract({ manifest: broken });
  const report = auditMangaPreflight({ manifest: broken, contract });
  assert.equal(report.pass, false);
  assert.ok(report.failedGateIds.includes("utterance-coverage"));
  assert.ok(report.failedGateIds.includes("voice-coverage"));
  assert.ok(report.failedGateIds.includes("asset-text-separation"));
  assert.equal(report.gates.find((entry) => entry.id === "final-media-evidence").status, "not-applicable");
});

test("blind candidate packet hides provider and source until selection is revealed", () => {
  const set = createBlindCandidateSet([
    { id: "gpt-output", provider: "GPT-Image", source: "/secret/gpt.png", artifact: "/secret/gpt.png", variationAxis: "反応の近景" },
    { id: "grok-output", provider: "Grok", source: "/secret/grok.png", artifact: "/secret/grok.png", variationAxis: "空間の引き画" },
  ], { salt: "fixed-test-salt" });
  const publicText = JSON.stringify(set.judgePacket);
  assert.doesNotMatch(publicText, /GPT|Grok|secret|gpt-output|grok-output|反応|空間/u);
  assert.throws(() => revealBlindSelection(set, set.judgePacket.candidates[0].label), /recorded verdict/u);
  const selected = revealBlindSelection(set, {
    setId: set.setId,
    winnerLabel: set.judgePacket.candidates[0].label,
    decidedBy: "human-user",
    reason: "人物の感情と背景の因果が最も明確だった",
    decidedAt: "2026-08-12T01:00:00.000Z",
  });
  assert.ok(["gpt-output", "grok-output"].includes(selected.id));
  assert.match(selected.mappingDigest, /^[a-f0-9]{64}$/u);
  assert.match(selected.verdict.digest, /^[a-f0-9]{64}$/u);
  assert.throws(() => createBlindCandidateSet([
    { id: "a", artifact: "a.png", variationAxis: "同じ軸" },
    { id: "b", artifact: "b.png", variationAxis: "同じ軸" },
  ]), /unique.*variationAxis/u);
});

test("quality loop separates generator and evaluator and stops at the immutable target", () => {
  const contract = createMangaQualityContract({ manifest: manifest(), overrides: { targetScore: 92 } });
  const evidence = [{ path: "/tmp/review.json", sha256: "a".repeat(64), note: "全項目の監査証拠" }];
  const initial = createMangaQualityLoopState({
    contract,
    generatorId: "generator-a",
    generatorContextId: "generator-context-a",
    startedAt: "2026-08-09T00:00:00.000Z",
  });
  assert.throws(() => recordMangaQualityRound({
    contract,
    state: initial,
    hardGateReport: { pass: true, contractDigest: contract.digest },
    reviews: [{ evaluatorId: "generator-a", evaluatorContextId: "review-context", scores: perfectScores, notes: "自己採点", evidence }],
    evidence,
    observedAt: "2026-08-09T00:01:00.000Z",
  }), /cannot judge its own output/u);
  assert.throws(() => recordMangaQualityRound({
    contract,
    state: initial,
    hardGateReport: { pass: true, contractDigest: contract.digest },
    reviews: [{ evaluatorId: "renamed-reviewer", evaluatorContextId: "generator-context-a", scores: perfectScores, notes: "別名で自己採点", evidence }],
    evidence,
    observedAt: "2026-08-09T00:01:00.000Z",
  }), /generator context/u);
  const passed = recordMangaQualityRound({
    contract,
    state: initial,
    hardGateReport: { pass: true, failedGateIds: [], contractDigest: contract.digest },
    reviews: [{ evaluatorId: "reviewer-a", evaluatorContextId: "review-context-a", scores: perfectScores, notes: "全尺を確認", evidence }],
    evidence,
    observedAt: "2026-08-09T00:01:00.000Z",
    cost: 1,
  });
  assert.equal(passed.status, "passed");
  assert.equal(passed.stopReason, "target-reached");
  assert.equal(passed.rounds[0].score, 100);
});

test("quality loop escalates after bounded non-passing rounds", () => {
  const contract = createMangaQualityContract({
    manifest: manifest(),
    overrides: { maximumReviewRounds: 2, maximumStagnantRounds: 2, targetScore: 95 },
  });
  const scores = Object.fromEntries(Object.keys(perfectScores).map((key) => [key, 80]));
  const evidence = [{ path: "/tmp/round.json", sha256: "b".repeat(64), note: "失敗箇所を固定した証拠" }];
  const startedAt = "2026-08-09T00:00:00.000Z";
  const first = recordMangaQualityRound({
    contract,
    state: createMangaQualityLoopState({ contract, generatorId: "g", generatorContextId: "gc", startedAt }),
    hardGateReport: { pass: true, contractDigest: contract.digest },
    reviews: [{ evaluatorId: "r1", evaluatorContextId: "rc1", scores, notes: "構図変化が不足", evidence }],
    evidence,
    failureFingerprint: "camera-composition-low",
    observedAt: "2026-08-09T00:01:00.000Z",
  });
  assert.equal(first.status, "active");
  const second = recordMangaQualityRound({
    contract,
    state: first,
    hardGateReport: { pass: true, contractDigest: contract.digest },
    reviews: [{ evaluatorId: "r2", evaluatorContextId: "rc2", scores, notes: "修正後も構図変化が不足", evidence }],
    evidence,
    previousFailureFingerprint: "camera-composition-low",
    failureFingerprint: "camera-composition-low",
    revisionDelta: "引き画を反応の近景へ差し替えた",
    observedAt: "2026-08-09T00:02:00.000Z",
  });
  assert.equal(second.status, "needs-human-approval");
  assert.equal(second.stopReason, "round-limit");
});

test("decision routing keeps objective gates automatic and subjective paid forks human", () => {
  assert.equal(classifyMangaDecisionGate({ objectivelyVerifiable: true }).route, "deterministic-gate");
  assert.equal(classifyMangaDecisionGate({ candidateCount: 3, subjective: true, irreversibleOrPaid: true }).route, "human-best-of-n");
  assert.equal(classifyMangaDecisionGate({ candidateCount: 3, rubricDefined: true }).route, "independent-blind-best-of-n");
  assert.equal(classifyMangaDecisionGate({ candidateCount: 1, subjective: true }).route, "human-red-pen");
});

test("final quality decision cannot pass without every independent audit and hash-bound evidence", () => {
  const requiredAuditIds = ["contract-manifest", "agent-contact-sheet-review", "quality-harness-final"];
  const common = {
    episodeId: "quality-episode",
    contractDigest: "c".repeat(64),
    videoSha256: "d".repeat(64),
    requiredAuditIds,
  };
  const awaiting = createMangaFinalQualityDecision({
    ...common,
    auditSteps: [
      { id: "contract-manifest", pass: true, evidencePath: "/tmp/contract.json", evidenceSha256: "e".repeat(64) },
      { id: "agent-contact-sheet-review", pass: false, evidencePath: "", evidenceSha256: "" },
    ],
    decidedAt: "2026-08-12T00:00:00.000Z",
  });
  assert.equal(awaiting.status, "needs-human-approval");
  assert.equal(awaiting.pass, false);
  const passed = createMangaFinalQualityDecision({
    ...common,
    auditSteps: [
      { id: "contract-manifest", pass: true, evidencePath: "/tmp/contract.json", evidenceSha256: "e".repeat(64) },
      { id: "agent-contact-sheet-review", pass: true, evidencePath: "/tmp/signoff.json", evidenceSha256: "f".repeat(64) },
    ],
    decidedAt: "2026-08-12T00:01:00.000Z",
  });
  assert.equal(passed.status, "passed");
  assert.equal(passed.pass, true);
  const unbound = createMangaFinalQualityDecision({
    ...common,
    auditSteps: [
      { id: "contract-manifest", pass: true, evidencePath: "/tmp/contract.json", evidenceSha256: "" },
      { id: "agent-contact-sheet-review", pass: true, evidencePath: "/tmp/signoff.json", evidenceSha256: "f".repeat(64) },
    ],
  });
  assert.equal(unbound.status, "blocked");
  assert.deepEqual(unbound.invalidEvidenceAuditIds, ["contract-manifest"]);
});

test("repeated deterministic high-impact incidents are promoted into hard gates", () => {
  const first = recordMangaQualityIncident({
    incident: { signature: "bubble-overflow", severity: "high", deterministic: true, failure: "文字が枠外へ出た" },
  });
  assert.equal(first.incidents[0].promotion, "checklist");
  const second = recordMangaQualityIncident({
    ledger: first,
    incident: { signature: "bubble-overflow", severity: "high", deterministic: true, evidence: ["frame-0042.png"] },
  });
  assert.equal(second.incidents[0].occurrences, 2);
  assert.equal(second.incidents[0].promotion, "hard-gate");
});
