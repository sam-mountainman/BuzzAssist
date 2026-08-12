import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateKoyaFinalAuditSteps,
  validateKoyaPerceptualReviewNotes,
} from "../lib/koyaMangaFinalAudit.mjs";

test("final audit cannot pass when a required result is absent", () => {
  const result = evaluateKoyaFinalAuditSteps({ requiredAudits: ["a", "b"] }, [{ id: "a", pass: true }]);
  assert.equal(result.pass, false);
  assert.deepEqual(result.missingAuditIds, ["b"]);
});

test("final audit requires every declared gate to pass", () => {
  const result = evaluateKoyaFinalAuditSteps(
    { requiredAudits: ["a", "b"] },
    [{ id: "a", pass: true }, { id: "b", pass: true }],
  );
  assert.equal(result.pass, true);
  assert.deepEqual(result.knownRemainingIssues, []);
});

test("perceptual signoff requires concrete evidence and a note for every quality check", () => {
  const contract = {
    qualityReview: {
      requiredChecks: ["anatomyAndPropScale", "dialoguePacing", "audioBoundaryArtifacts"],
    },
  };
  const complete = validateKoyaPerceptualReviewNotes({
    version: "koya-perceptual-review-notes-v1",
    evidence: {
      fullVideoReviewed: "全編を再生した",
      contactSheetReviewed: "全24枚を拡大した",
      representativeFramesReviewed: "人物と小道具を確認した",
      audioSpotChecksReviewed: "境界と末尾を実聴した",
    },
    checks: {
      anatomyAndPropScale: "手指と小道具比率に破綻なし",
      dialoguePacing: "話者交代の間が自然",
      audioBoundaryArtifacts: "頭切れと末尾クリックなし",
    },
    knownRemainingIssues: [],
  }, contract);
  assert.equal(complete.pass, true);
  const blindPass = validateKoyaPerceptualReviewNotes({
    version: "koya-perceptual-review-notes-v1",
    evidence: {},
    checks: {},
    knownRemainingIssues: [],
  }, contract);
  assert.equal(blindPass.pass, false);
  assert.ok(blindPass.failures.includes("missing-check-note:anatomyAndPropScale"));
});
