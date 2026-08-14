import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  auditBubbleTerminalJapanesePeriods,
  evaluateKoyaFinalAuditSteps,
  validateKoyaPerceptualReviewNotes,
  validateKoyaVisualSignoff,
  verifyKoyaPerceptualEvidenceFiles,
} from "../lib/koyaMangaFinalAudit.mjs";
import { stableJson } from "../lib/koyaMangaProductionContract.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");

test("terminal punctuation audit permits internal timed-segment sentence periods", async () => {
  const root = await mkdtemp(join(tmpdir(), "koya-terminal-segments-"));
  const first = join(root, "first.svg");
  const final = join(root, "final.svg");
  await writeFile(first, '<svg><g data-text="内部の文。"></g></svg>');
  await writeFile(final, '<svg><g data-text="最後の文"></g></svg>');
  const report = await auditBubbleTerminalJapanesePeriods({
    utterances: [{
      id: "u1",
      bubbleSegments: [
        { id: "u1-s1", overlayPath: first },
        { id: "u1-s2", overlayPath: final },
      ],
    }],
  }, { bubbles: { stripTerminalJapanesePeriod: true } });
  assert.equal(report.pass, true);
  assert.equal(report.rows[0].finalDisplayEntry, false);
  assert.equal(report.rows[1].finalDisplayEntry, true);
});

function reviewFixture() {
  const contract = {
    qualityReview: {
      version: "koya-agent-perceptual-signoff-v4",
      reviewNotesVersion: "koya-perceptual-review-notes-v3",
      minimumReviewNoteCharacters: 8,
      minimumRepresentativeFrames: 3,
      minimumAudioSpotChecks: 3,
      maximumFutureClockSkewSeconds: 300,
      requiredChecks: ["anatomyAndPropScale", "dialoguePacing", "audioBoundaryArtifacts"],
    },
  };
  const context = {
    episodeId: "episode-1",
    contractDigest: "d".repeat(64),
    videoPath: "/tmp/video.mp4",
    videoSha256: "a".repeat(64),
    videoDurationSeconds: 100,
    contactSheetPath: "/tmp/contact.jpg",
    contactSheetSha256: "b".repeat(64),
    nowMs: Date.parse("2026-08-12T12:30:00.000Z"),
  };
  const notes = {
    version: "koya-perceptual-review-notes-v3",
    episodeId: context.episodeId,
    contractDigest: context.contractDigest,
    reviewedAt: "2026-08-12T12:00:00.000Z",
    reviewer: { host: "codex", id: "codex:review-context-1", contextId: "review-context-1" },
    rubricScores: {
      "semantic-scene-fit": 95,
      "character-continuity": 95,
      "camera-composition": 95,
      "editorial-grammar": 95,
      "bubble-typography": 95,
      "voice-performance": 95,
      "audio-technical": 95,
      "timing-continuity": 95,
      "final-playback": 95
    },
    video: { path: context.videoPath, sha256: context.videoSha256, durationSeconds: 100 },
    contactSheet: { path: context.contactSheetPath, sha256: context.contactSheetSha256 },
    evidence: {
      fullVideoReviewed: { note: "全編を開始から終端まで確認した", startSeconds: 0, endSeconds: 100 },
      contactSheetReviewed: { note: "全コマを原寸で拡大確認した" },
      representativeFramesReviewed: {
        note: "人物と小道具の代表画面を確認した",
        frames: [
          { path: "/tmp/frame-1.jpg", sha256: "1".repeat(64), timestampSeconds: 1, checkIds: ["anatomyAndPropScale"] },
          { path: "/tmp/frame-2.jpg", sha256: "2".repeat(64), timestampSeconds: 50, checkIds: ["anatomyAndPropScale"] },
          { path: "/tmp/frame-3.jpg", sha256: "3".repeat(64), timestampSeconds: 99, checkIds: ["anatomyAndPropScale"] }
        ]
      },
      audioSpotChecksReviewed: {
        note: "冒頭と中盤と終端を実際に聴いた",
        intervals: [
          { startSeconds: 0, endSeconds: 1, note: "冒頭の頭切れがないことを確認" },
          { startSeconds: 49, endSeconds: 51, note: "中盤の話者交代を実聴確認した" },
          { startSeconds: 99, endSeconds: 100, note: "終端のクリックがないことを確認" }
        ]
      }
    },
    checks: {
      anatomyAndPropScale: { note: "手指と小道具比率に破綻なし", evidenceRefs: ["representativeFrames"] },
      dialoguePacing: { note: "話者交代の間が自然だった", evidenceRefs: ["fullVideo"] },
      audioBoundaryArtifacts: { note: "頭切れと末尾クリックなし", evidenceRefs: ["audioSpotChecks"] }
    },
    knownRemainingIssues: []
  };
  return { contract, context, notes };
}

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
  const { contract, context, notes } = reviewFixture();
  const complete = validateKoyaPerceptualReviewNotes(notes, contract, context);
  assert.equal(complete.pass, true);
  const blindNotes = structuredClone(notes);
  blindNotes.evidence = {};
  blindNotes.checks = {};
  const blindPass = validateKoyaPerceptualReviewNotes(blindNotes, contract, context);
  assert.equal(blindPass.pass, false);
  assert.ok(blindPass.failures.includes("missing-check-note:anatomyAndPropScale"));
});

test("perceptual review requires full ranges, hashed frames, and start/middle/end audio checks", () => {
  const { contract, context, notes } = reviewFixture();
  notes.evidence.fullVideoReviewed.endSeconds = 90;
  notes.evidence.representativeFramesReviewed.frames[1].sha256 = "not-a-digest";
  notes.evidence.audioSpotChecksReviewed.intervals[1] = { startSeconds: 0.1, endSeconds: 0.5, note: "冒頭だけを重複確認してしまった" };
  const result = validateKoyaPerceptualReviewNotes(notes, contract, context);
  assert.equal(result.pass, false);
  assert.ok(result.failures.includes("full-video-range-incomplete"));
  assert.ok(result.failures.includes("representative-frame-digest-invalid:1"));
  assert.ok(result.failures.includes("audio-spot-check-middle-missing"));
});

test("visual signoff is bound to contract, MP4, contact sheet, and review-note digests", () => {
  const { contract, context, notes } = reviewFixture();
  const contentSha256 = digest(stableJson(notes));
  const signoff = {
    version: contract.qualityReview.version,
    episodeId: context.episodeId,
    contractDigest: context.contractDigest,
    videoPath: context.videoPath,
    videoSha256: context.videoSha256,
    videoDurationSeconds: context.videoDurationSeconds,
    contactSheetPath: context.contactSheetPath,
    contactSheetSha256: context.contactSheetSha256,
    reviewNotesFileSha256: "f".repeat(64),
    reviewNotesContentSha256: contentSha256,
    reviewNotes: notes,
    reviewerHost: "codex",
    reviewerProvenance: notes.reviewer,
    checks: Object.fromEntries(contract.qualityReview.requiredChecks.map((key) => [key, true])),
    pass: true,
    knownRemainingIssues: [],
  };
  const options = {
    ...context,
    reviewNotesFileSha256: "f".repeat(64),
    reviewNotesContentSha256: contentSha256,
    evidenceFilesGate: { pass: true, failures: [] },
    generatorProvenance: { host: "claude", id: "claude:generator-context", contextId: "generator-context" },
    contract,
  };
  assert.equal(validateKoyaVisualSignoff(signoff, options).pass, true);
  const stale = structuredClone(signoff);
  stale.contractDigest = "0".repeat(64);
  stale.contactSheetSha256 = "9".repeat(64);
  const staleGate = validateKoyaVisualSignoff(stale, options);
  assert.equal(staleGate.pass, false);
  assert.ok(staleGate.failures.includes("contract-digest-mismatch"));
  assert.ok(staleGate.failures.includes("contact-sheet-digest-mismatch"));
});

test("perceptual evidence hashes are verified against the real files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "koya-review-"));
  try {
    const files = ["video.mp4", "contact.jpg", "frame-1.jpg", "frame-2.jpg", "frame-3.jpg"];
    const paths = Object.fromEntries(files.map((name) => [name, join(directory, name)]));
    for (const name of files) await writeFile(paths[name], `fixture:${name}`);
    const { notes } = reviewFixture();
    notes.video = { ...notes.video, path: paths["video.mp4"], sha256: digest("fixture:video.mp4") };
    notes.contactSheet = { ...notes.contactSheet, path: paths["contact.jpg"], sha256: digest("fixture:contact.jpg") };
    notes.evidence.representativeFramesReviewed.frames.forEach((frame, index) => {
      const name = `frame-${index + 1}.jpg`;
      frame.path = paths[name];
      frame.sha256 = digest(`fixture:${name}`);
    });
    assert.equal((await verifyKoyaPerceptualEvidenceFiles(notes)).pass, true);
    await writeFile(paths["frame-2.jpg"], "changed-after-review");
    const changed = await verifyKoyaPerceptualEvidenceFiles(notes);
    assert.equal(changed.pass, false);
    assert.ok(changed.failures.includes("evidence-file-digest-mismatch:representative-frame:1"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
