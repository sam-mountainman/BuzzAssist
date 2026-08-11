import test from "node:test";
import assert from "node:assert/strict";

import {
  auditMangaPreflight,
  createBlindCandidateSet,
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
    { id: "gpt-output", provider: "GPT-Image", source: "/secret/gpt.png", artifact: "/secret/gpt.png" },
    { id: "grok-output", provider: "Grok", source: "/secret/grok.png", artifact: "/secret/grok.png" },
  ], { salt: "fixed-test-salt" });
  const publicText = JSON.stringify(set.judgePacket);
  assert.doesNotMatch(publicText, /GPT|Grok|secret|gpt-output|grok-output/u);
  const selected = revealBlindSelection(set, set.judgePacket.candidates[0].label);
  assert.ok(["gpt-output", "grok-output"].includes(selected.id));
  assert.match(selected.mappingDigest, /^[a-f0-9]{64}$/u);
});

test("quality loop separates generator and evaluator and stops at the immutable target", () => {
  const contract = createMangaQualityContract({ manifest: manifest(), overrides: { targetScore: 92 } });
  const initial = createMangaQualityLoopState({ contract, generatorId: "generator-a", startedAt: "2026-08-09T00:00:00.000Z" });
  assert.throws(() => recordMangaQualityRound({
    contract,
    state: initial,
    hardGateReport: { pass: true },
    reviews: [{ evaluatorId: "generator-a", scores: perfectScores }],
  }), /cannot judge its own output/u);
  const passed = recordMangaQualityRound({
    contract,
    state: initial,
    hardGateReport: { pass: true, failedGateIds: [] },
    candidateSetId: "set-1",
    reviews: [{ evaluatorId: "reviewer-a", scores: perfectScores, notes: "全尺を確認" }],
    evidence: ["native-size-frame-audit.json", "full-watch-checklist.json"],
    elapsedMs: 1_000,
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
  const first = recordMangaQualityRound({
    contract,
    state: createMangaQualityLoopState({ contract, generatorId: "g" }),
    hardGateReport: { pass: true },
    reviews: [{ evaluatorId: "r1", scores }],
  });
  assert.equal(first.status, "active");
  const second = recordMangaQualityRound({
    contract,
    state: first,
    hardGateReport: { pass: true },
    reviews: [{ evaluatorId: "r2", scores }],
  });
  assert.equal(second.status, "escalated");
  assert.equal(second.stopReason, "round-limit");
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
