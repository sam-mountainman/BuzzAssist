import assert from "node:assert/strict";
import test from "node:test";

import { buildCharacterCandidateQualityContract } from "../lib/characterAttributeGate.mjs";
import {
  createCharacterRepairPlan,
  repairPlanToNextRound,
  verifyRepairPlanCoverage,
} from "../lib/characterRepairPlan.mjs";
import { createMangaQualityLoopState, recordMangaQualityRound } from "../lib/mangaQualityHarness.mjs";

function failedLoopState(contract) {
  const state = createMangaQualityLoopState({
    contract,
    generatorHost: "claude",
    generatorId: "generator-1",
    generatorContextId: "ctx-generator-1",
  });
  return recordMangaQualityRound({
    contract,
    state,
    hardGateReport: { contractDigest: contract.digest, pass: false, failedGateIds: ["attribute-hair-color-delta"] },
    reviews: [{
      evaluatorId: "evaluator-1",
      evaluatorContextId: "ctx-evaluator-1",
      evaluatorHost: "codex",
      notes: "hair drifted lighter on the ivory sheet",
      evidence: [{ path: "canvas/assets/appare-revisions/horo-v7-akacha-ivoryjersey2.png", sha256: "a".repeat(64), note: "ivory sheet full-size review crop" }],
      scores: Object.fromEntries([
        "semantic-scene-fit", "character-continuity", "camera-composition",
        "editorial-grammar", "bubble-typography", "voice-performance",
        "audio-technical", "timing-continuity", "final-playback",
      ].map((category) => [category, 80])),
    }],
    failureFingerprint: "hair-drift-ivory",
    evidence: [{ path: "canvas/assets/appare-revisions/horo-v7-akacha-ivoryjersey2.png", sha256: "a".repeat(64), note: "ivory sheet full-size review crop" }],
  });
}

test("repair plan binds to contract and previous failure", () => {
  const contract = buildCharacterCandidateQualityContract({ castId: "horo" });
  const state = failedLoopState(contract);
  const plan = createCharacterRepairPlan({
    contract,
    state,
    entries: [{
      cellId: "turnaround-front",
      issue: "hair color drifted lighter than the approved red-brown",
      repairRegion: [0.5, 0.0, 0.5, 0.5],
      protectRegions: [[0.0, 0.5, 0.5, 0.5]],
      acceptCriteria: ["hairColorDelta deltaE < 3.5 against horo-v7-akacha-fangbig"],
      rejectCriteria: ["any face-region change"],
    }],
  });
  assert.equal(plan.contractDigest, contract.digest);
  assert.equal(plan.previousFailureFingerprint, "hair-drift-ivory");
  assert.equal(plan.roundIndex, 1);
  assert.ok(plan.digest.length === 64);
  assert.throws(() => {
    plan.entries.push({});
  });

  const coverage = verifyRepairPlanCoverage(plan, ["turnaround-front", "turnaround-back"]);
  assert.equal(coverage.complete, false);
  assert.deepEqual(coverage.missing, ["turnaround-back"]);

  const next = repairPlanToNextRound(plan, {
    imageByCell: { "turnaround-front": "/tmp/new.png" },
    baseByCell: { "turnaround-front": "/tmp/old.png" },
  });
  assert.equal(next.previousFailureFingerprint, "hair-drift-ivory");
  assert.match(next.revisionDelta, /turnaround-front/);
  assert.equal(next.unintendedChangeChecks.length, 1);
  assert.deepEqual(next.unintendedChangeChecks[0].allowedRegions, [[0.5, 0, 0.5, 0.5]]);
});

test("repair plan rejects vague or duplicate entries and stale states", () => {
  const contract = buildCharacterCandidateQualityContract({ castId: "reiji" });
  const state = failedLoopState(contract);
  const entry = {
    cellId: "cell-1",
    issue: "concrete defect description",
    repairRegion: [0.1, 0.1, 0.2, 0.2],
    acceptCriteria: ["ok when x"],
  };
  assert.throws(() => createCharacterRepairPlan({ contract, state, entries: [] }), /at least one entry/);
  assert.throws(() => createCharacterRepairPlan({ contract, state, entries: [{ ...entry, issue: "vague" }] }), /concretely/);
  assert.throws(() => createCharacterRepairPlan({ contract, state, entries: [entry, { ...entry }] }), /duplicate/);
  assert.throws(() => createCharacterRepairPlan({ contract, state, entries: [{ ...entry, repairRegion: [0.9, 0.9, 0.3, 0.3] }] }), /inside 0\.\.1/);
  assert.throws(() => createCharacterRepairPlan({ contract, state, entries: [{ ...entry, acceptCriteria: [] }] }), /acceptCriteria/);
  const otherContract = buildCharacterCandidateQualityContract({ castId: "ema" });
  assert.throws(() => createCharacterRepairPlan({ contract: otherContract, state, entries: [entry] }), /same quality contract/);
});
