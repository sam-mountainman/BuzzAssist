import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

function tamperSignature(signature) {
  // 末尾を "AA" にする改変は Ed25519 の S 上位 bit が常に 0 のため no-op になり得る（実測6%）。
  // 先頭 32 byte（R）の 1 文字を必ず別の値に置き換えて、bytes が確実に変わるようにする。
  const index = 10;
  const replacement = signature[index] === "A" ? "B" : "A";
  return `${signature.slice(0, index)}${replacement}${signature.slice(index + 1)}`;
}

import {
  auditBubbleTerminalJapanesePeriods,
  evaluateKoyaFinalAuditSteps,
  resolveKoyaFinalAuditPythonRuntime,
  validateKoyaPerceptualReviewNotes,
  validateKoyaVisualSignoff,
  verifyKoyaPerceptualEvidenceFiles,
  writeKoyaVisualSignoff,
} from "../lib/koyaMangaFinalAudit.mjs";
import { resolveKoyaMangaProductionContract, stableJson } from "../lib/koyaMangaProductionContract.mjs";
import { createKoyaOuterJobBinding } from "../lib/koyaOuterJobBinding.mjs";
import {
  KOYA_REVIEWER_TRUST_VERSION,
  createKoyaReviewAttestation,
  createKoyaReviewAttestationSubject,
  createKoyaReviewerTrustEntry,
  generateKoyaReviewerKeyPair,
  normalizeKoyaReviewerTrust,
  verifyKoyaReviewAttestation,
} from "../lib/koyaReviewAttestation.mjs";

const execFile = promisify(execFileCallback);
const digest = (value) => createHash("sha256").update(value).digest("hex");

// 生成プロセスとは別に信頼設定される reviewer 鍵。signoff には秘密鍵も公開鍵も入らない。
const REVIEWER_KEY = generateKoyaReviewerKeyPair();
const REVOKED_KEY = generateKoyaReviewerKeyPair();
const STRANGER_KEY = generateKoyaReviewerKeyPair();
const REVIEWER_TRUST = normalizeKoyaReviewerTrust({
  version: KOYA_REVIEWER_TRUST_VERSION,
  reviewers: [
    createKoyaReviewerTrustEntry({ publicKeyPem: REVIEWER_KEY.publicKeyPem, label: "fixture reviewer" }),
    {
      ...createKoyaReviewerTrustEntry({ publicKeyPem: REVOKED_KEY.publicKeyPem, label: "revoked reviewer" }),
      status: "revoked",
      revokedAt: "2026-08-31T00:00:00.000Z",
      reason: "fixture: key reported compromised",
    },
  ],
});
const TRUST_BEFORE_REVOCATION = normalizeKoyaReviewerTrust({
  version: KOYA_REVIEWER_TRUST_VERSION,
  reviewers: [createKoyaReviewerTrustEntry({ publicKeyPem: REVOKED_KEY.publicKeyPem })],
});
const STRANGER_TRUST = normalizeKoyaReviewerTrust({
  version: KOYA_REVIEWER_TRUST_VERSION,
  reviewers: [createKoyaReviewerTrustEntry({ publicKeyPem: STRANGER_KEY.publicKeyPem })],
});
// ffmpeg 7.1/libx264/AAC で生成した 0.5 秒の実 decode 可能 MP4（videoHarnessReceipt.test と同一）。
const FULLY_DECODABLE_AV_MP4 = Buffer.from(
  "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAYabW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAAfQAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAnB0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAAfQAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAEAAAABAAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAH0AAAAAAABAAAAAAHobWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAoAAAAFABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABk21pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAVNzdGJsAAAAt3N0c2QAAAAAAAAAAQAAAKdhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAEAAQABIAAAASAAAAAAAAAABFUxhdmM2MS4xOS4xMDEgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAALWF2Y0MBQsAK/+EAFmdCwAraEJsBEAAAAwAQAAADAUDxImoBAARozg/IAAAAEHBhc3AAAAABAAAAAQAAABRidHJ0AAAAAAAAKaAAAAAAAAAAGHN0dHMAAAAAAAAAAQAAAAUAAAQAAAAAFHN0c3MAAAAAAAAAAQAAAAEAAAAcc3RzYwAAAAAAAAABAAAAAQAAAAEAAAABAAAAKHN0c3oAAAAAAAAAAAAAAAUAAAJyAAAACgAAAAoAAAAKAAAACgAAACRzdGNvAAAAAAAAAAUAAAZfAAAI5QAACQMAAAkhAAAJOwAAAtV0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAACAAAAAAAAAfQAAAAAAAAAAAAAAAEBAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAH0AAAEAAABAAAAAAJNbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAC7gAAAYcBVxAAAAAAALWhkbHIAAAAAAAAAAHNvdW4AAAAAAAAAAAAAAABTb3VuZEhhbmRsZXIAAAAB+G1pbmYAAAAQc21oZAAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAABvHN0YmwAAAB+c3RzZAAAAAAAAAABAAAAbm1wNGEAAAAAAAAAAQAAAAAAAAAAAAEAEAAAAAC7gAAAAAAANmVzZHMAAAAAA4CAgCUAAgAEgICAF0AVAAAAAAB9AAAABwMFgICABRGIVuUABoCAgAECAAAAFGJ0cnQAAAAAAAB9AAAABwMAAAAgc3R0cwAAAAAAAAACAAAAGAAABAAAAAABAAABwAAAAEBzdHNjAAAAAAAAAAQAAAABAAAAAQAAAAEAAAACAAAABQAAAAEAAAAFAAAABAAAAAEAAAAGAAAABQAAAAEAAAB4c3RzegAAAAAAAAAAAAAAGQAAABUAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAoc3RjbwAAAAAAAAAGAAAGSgAACNEAAAjvAAAJDQAACSsAAAlFAAAAGnNncGQBAAAAcm9sbAAAAAIAAAAB//8AAAAcc2JncAAAAAByb2xsAAAAAQAAABkAAAABAAAAYXVkdGEAAABZbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAsaWxzdAAAACSpdG9vAAAAHGRhdGEAAAABAAAAAExhdmY2MS43LjEwMAAAAAhmcmVlAAADF21kYXTeAgBMYXZjNjEuMTkuMTAxAAIwQA4AAAJUBgX//1DcRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY0IHIzMTA4IDMxZTE5ZjkgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDIzIC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MCByZWY9MSBkZWJsb2NrPTA6MDowIGFuYWx5c2U9MDowIG1lPWRpYSBzdWJtZT0wIHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTAgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0wIDh4OGRjdD0wIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PTAgdGhyZWFkcz0yIGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MCB3ZWlnaHRwPTAga2V5aW50PTI1MCBrZXlpbnRfbWluPTEwIHNjZW5lY3V0PTAgaW50cmFfcmVmcmVzaD0wIHJjPWNyZiBtYnRyZWU9MCBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0wAIAAAAAWZYiEOiYoAAkCycnJ1111111111114AEYIAcBGCAHARggBwEYIAcBGCAHAAAABkGaIBGgjAEYIAcBGCAHARggBwEYIAcBGCAHAAAABkGaQBKgjAEYIAcBGCAHARggBwEYIAcBGCAHAAAABkGaYBKgjAEYIAcBGCAHARggBwEYIAcAAAAGQZqAEqCMARggBwEYIAcBGCAHARggBwEYIAc=",
  "base64",
);

test("final audit keeps a preverified Windows Python launcher command", async () => {
  const runtime = await resolveKoyaFinalAuditPythonRuntime({
    quick: true,
    pythonRuntime: { ok: true, command: "py.exe", args: ["-3"], version: "3.12.1" },
  }, "C:\\fixture-project");
  assert.equal(runtime.command, "py.exe");
  assert.deepEqual(runtime.args, ["-3"]);
});

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

async function signoffFixture({ signingKey = REVIEWER_KEY, signingTrust = REVIEWER_TRUST, subjectOverrides = {} } = {}) {
  const { contract, context, notes } = reviewFixture();
  const contentSha256 = digest(stableJson(notes));
  const outerJobBinding = createKoyaOuterJobBinding({
    jobId: "video-koya-manga-video-aaaaaaaaaaaaaaaa",
    identityDigest: "a".repeat(64),
    executionIdentityDigest: "1".repeat(64),
    resolvedProductionContractSha256: "2".repeat(64),
  });
  const subject = createKoyaReviewAttestationSubject({
    episodeId: context.episodeId,
    outerJobBinding,
    contractDigest: context.contractDigest,
    videoSha256: context.videoSha256,
    contactSheetSha256: context.contactSheetSha256,
    reviewNotesContentSha256: contentSha256,
    reviewer: notes.reviewer,
    ...subjectOverrides,
  });
  const reviewerAttestation = await createKoyaReviewAttestation({
    subject,
    privateKeyPem: signingKey.privateKeyPem,
    trust: signingTrust,
    signedAt: "2026-08-12T12:05:00.000Z",
  });
  const signoff = {
    version: contract.qualityReview.version,
    episodeId: context.episodeId,
    outerJobBinding,
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
    reviewerAttestation,
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
    outerJobBinding,
    contract,
    reviewerTrust: REVIEWER_TRUST,
  };
  return { signoff, options, outerJobBinding, subject };
}

test("visual signoff is bound to outer Job, contract, MP4, contact sheet, and review-note digests", async () => {
  const { signoff, options } = await signoffFixture();
  const gate = validateKoyaVisualSignoff(signoff, options);
  assert.deepEqual(gate.failures, []);
  assert.equal(gate.pass, true);
  assert.equal(gate.reviewerAttestation.pass, true);
  assert.equal(gate.reviewerAttestation.signerKeyId, REVIEWER_KEY.keyId);
  assert.equal(gate.reviewerAttestation.trustSha256, REVIEWER_TRUST.sha256);
  const stale = structuredClone(signoff);
  stale.contractDigest = "0".repeat(64);
  stale.contactSheetSha256 = "9".repeat(64);
  stale.outerJobBinding = createKoyaOuterJobBinding({
    jobId: "video-koya-manga-video-eeeeeeeeeeeeeeee",
    identityDigest: "e".repeat(64),
    executionIdentityDigest: "3".repeat(64),
    resolvedProductionContractSha256: "4".repeat(64),
  });
  const staleGate = validateKoyaVisualSignoff(stale, options);
  assert.equal(staleGate.pass, false);
  assert.ok(staleGate.failures.includes("contract-digest-mismatch"));
  assert.ok(staleGate.failures.includes("contact-sheet-digest-mismatch"));
  assert.ok(staleGate.failures.includes("outer-job-binding-mismatch"));
  // 署名対象は signoff の写しではなく監査側の期待値から組む。signoff 自身の申告 field を
  // 書き換えても attestation は元の対象へ有効なままで、その書き換えは既存の digest gate が捕まえる。
  // attestation が別に捕まえるのは「成果物や Job そのものが差し替わった」場合（次の test）。
  assert.equal(staleGate.reviewerAttestation.pass, true);
  assert.equal(staleGate.failures.some((code) => code.startsWith("reviewer-attestation-")), false);
});

test("visual signoff requires a trusted reviewer attestation and reports each failure as a code", async (t) => {
  const base = await signoffFixture();
  const cases = [
    ["attestation missing", async () => {
      const { signoff, options } = await signoffFixture();
      delete signoff.reviewerAttestation;
      return { signoff, options };
    }, ["reviewer-attestation-missing"]],
    ["trust list unconfigured on the audit side", async () => {
      const { signoff, options } = await signoffFixture();
      return { signoff, options: { ...options, reviewerTrust: null, reviewerTrustFailure: "reviewer-trust-unreadable" } };
    }, ["reviewer-trust-unreadable"]],
    ["signed with a key later revoked", async () => signoffFixture({ signingKey: REVOKED_KEY, signingTrust: TRUST_BEFORE_REVOCATION }), ["reviewer-key-revoked"]],
    ["signed with an unregistered self-generated key", async () => signoffFixture({ signingKey: STRANGER_KEY, signingTrust: STRANGER_TRUST }), ["reviewer-key-untrusted"]],
    ["attestation borrowed from another Job", async () => {
      const { signoff, options } = await signoffFixture({
        subjectOverrides: {
          outerJobBinding: createKoyaOuterJobBinding({
            jobId: "video-koya-manga-video-eeeeeeeeeeeeeeee",
            identityDigest: "e".repeat(64),
            executionIdentityDigest: "3".repeat(64),
            resolvedProductionContractSha256: "4".repeat(64),
          }),
        },
      });
      return { signoff, options };
    }, ["reviewer-attestation-subject-mismatch:jobId", "reviewer-attestation-subject-mismatch:executionIdentityDigest", "reviewer-attestation-subject-mismatch:outerJobBindingSha256"]],
    ["MP4 replaced after the reviewer signed", async () => {
      const { signoff, options } = await signoffFixture();
      // 攻撃者は signoff/監査側の申告値を新しい MP4 に揃えられるが、署名は作り直せない。
      signoff.videoSha256 = "9".repeat(64);
      signoff.reviewNotes.video.sha256 = "9".repeat(64);
      const contentSha256 = digest(stableJson(signoff.reviewNotes));
      signoff.reviewNotesContentSha256 = contentSha256;
      return { signoff, options: { ...options, videoSha256: "9".repeat(64), reviewNotesContentSha256: contentSha256 } };
    }, ["reviewer-attestation-subject-mismatch:videoSha256", "reviewer-attestation-subject-mismatch:reviewNotesContentSha256"]],
    ["contact sheet replaced after the reviewer signed", async () => {
      const { signoff, options } = await signoffFixture();
      signoff.contactSheetSha256 = "9".repeat(64);
      signoff.reviewNotes.contactSheet.sha256 = "9".repeat(64);
      const contentSha256 = digest(stableJson(signoff.reviewNotes));
      signoff.reviewNotesContentSha256 = contentSha256;
      return { signoff, options: { ...options, contactSheetSha256: "9".repeat(64), reviewNotesContentSha256: contentSha256 } };
    }, ["reviewer-attestation-subject-mismatch:contactSheetSha256"]],
    ["review notes edited after the reviewer signed", async () => {
      const { signoff, options } = await signoffFixture();
      signoff.reviewNotes.checks.dialoguePacing.note = "編集後に書き換えた所見";
      const contentSha256 = digest(stableJson(signoff.reviewNotes));
      signoff.reviewNotesContentSha256 = contentSha256;
      return { signoff, options: { ...options, reviewNotesContentSha256: contentSha256 } };
    }, ["reviewer-attestation-subject-mismatch:reviewNotesContentSha256"]],
    ["reviewer context re-declared after signing", async () => {
      const { signoff, options } = await signoffFixture();
      signoff.reviewerProvenance = { ...signoff.reviewerProvenance, contextId: "review-context-2" };
      signoff.reviewNotes.reviewer = { ...signoff.reviewNotes.reviewer, contextId: "review-context-2" };
      const contentSha256 = digest(stableJson(signoff.reviewNotes));
      signoff.reviewNotesContentSha256 = contentSha256;
      return { signoff, options: { ...options, reviewNotesContentSha256: contentSha256 } };
    }, ["reviewer-attestation-subject-mismatch:reviewerContextId"]],
    ["signed subject carries a trailing space", async () => {
      const { signoff, options } = await signoffFixture();
      signoff.reviewerAttestation.subject.videoSha256 = `${signoff.reviewerAttestation.subject.videoSha256} `;
      return { signoff, options };
    }, ["reviewer-attestation-subject-noncanonical:videoSha256", "reviewer-attestation-signature-invalid"]],
    ["signed subject re-spelled in upper-case hex", async () => {
      const { signoff, options } = await signoffFixture();
      signoff.reviewerAttestation.subject.contactSheetSha256 = signoff.reviewerAttestation.subject.contactSheetSha256.toUpperCase();
      return { signoff, options };
    }, ["reviewer-attestation-subject-noncanonical:contactSheetSha256", "reviewer-attestation-signature-invalid"]],
    ["signature bytes tampered", async () => {
      const { signoff, options } = await signoffFixture();
      signoff.reviewerAttestation.signature = tamperSignature(signoff.reviewerAttestation.signature);
      return { signoff, options };
    }, ["reviewer-attestation-signature-invalid"]],
  ];
  for (const [name, build, expectedCodes] of cases) {
    await t.test(name, async () => {
      const { signoff, options } = await build();
      const gate = validateKoyaVisualSignoff(signoff, options);
      assert.equal(gate.pass, false);
      for (const code of expectedCodes) {
        assert.ok(gate.failures.includes(code), `${name}: expected ${code} in ${JSON.stringify(gate.failures)}`);
      }
      // 既存の知覚レビュー notes / evidence file ゲートは緩めていない: attestation 以外の理由が新たに増えない。
      const nonAttestation = gate.failures.filter((code) => !/^reviewer-(?:attestation|key|trust)-/u.test(code));
      assert.ok(nonAttestation.every((code) => validateKoyaVisualSignoff(base.signoff, base.options).failures.includes(code) || /mismatch|reused/u.test(code)), JSON.stringify(nonAttestation));
    });
  }
});

async function probeDuration(videoPath) {
  const { stdout } = await execFile("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", videoPath]);
  return Number(stdout.trim());
}

/** writeKoyaVisualSignoff を実 manifest / 実 MP4 / 実 contact sheet で通す temp project。 */
async function signoffProject(root) {
  const episodeId = "koya-attestation-fixture";
  const episodeDir = join(root, "canvas", "koya", episodeId);
  const auditDir = join(episodeDir, "audits", "koya-final");
  await mkdir(auditDir, { recursive: true });
  const videoPath = join(episodeDir, "final.mp4");
  await writeFile(videoPath, FULLY_DECODABLE_AV_MP4);
  const contactSheetPath = join(auditDir, "contact-sheet.jpg");
  await writeFile(contactSheetPath, "fixture-contact-sheet");
  const frames = [];
  for (const index of [1, 2, 3]) {
    const path = join(auditDir, `frame-${index}.jpg`);
    await writeFile(path, `fixture-frame-${index}`);
    frames.push({ path, sha256: digest(`fixture-frame-${index}`) });
  }
  const outerJobBinding = createKoyaOuterJobBinding({
    jobId: "video-koya-manga-video-aaaaaaaaaaaaaaaa",
    identityDigest: "a".repeat(64),
    executionIdentityDigest: "1".repeat(64),
    resolvedProductionContractSha256: "2".repeat(64),
  });
  const generator = { version: "koya-agent-provenance-v1", role: "generator", host: "claude", id: "claude:generator-context", contextId: "generator-context" };
  const manifestPath = join(episodeDir, "manifest.json");
  await writeFile(manifestPath, JSON.stringify({
    id: episodeId,
    outputs: { finalVideo: { filePath: videoPath } },
    production: { outerJobBinding, provenance: { generator } },
  }));
  const resolved = await resolveKoyaMangaProductionContract({ projectDir: root, episodeId });
  const durationSeconds = await probeDuration(videoPath);
  const videoSha256 = digest(FULLY_DECODABLE_AV_MP4);
  const reviewer = { host: "codex", id: "codex:review-context-1", contextId: "review-context-1" };
  const requiredChecks = resolved.contract.qualityReview.requiredChecks;
  const frameRefs = ["representativeFrames"];
  const notes = {
    version: resolved.contract.qualityReview.reviewNotesVersion,
    episodeId,
    contractDigest: resolved.digest,
    reviewedAt: "2026-09-04T15:00:00.000Z",
    reviewer,
    rubricScores: Object.fromEntries([
      "semantic-scene-fit", "character-continuity", "camera-composition", "editorial-grammar",
      "bubble-typography", "voice-performance", "audio-technical", "timing-continuity", "final-playback",
    ].map((id) => [id, 95])),
    video: { path: videoPath, sha256: videoSha256, durationSeconds },
    contactSheet: { path: contactSheetPath, sha256: digest("fixture-contact-sheet") },
    evidence: {
      fullVideoReviewed: { note: "全編を開始から終端まで確認した", startSeconds: 0, endSeconds: durationSeconds },
      contactSheetReviewed: { note: "全コマを原寸で拡大確認した" },
      representativeFramesReviewed: {
        note: "人物と小道具の代表画面を確認した",
        frames: frames.map((frame, index) => ({ ...frame, timestampSeconds: Math.min(durationSeconds, index * 0.2), checkIds: ["anatomyAndPropScale"] })),
      },
      audioSpotChecksReviewed: {
        note: "冒頭と中盤と終端を実際に聴いた",
        intervals: [
          { startSeconds: 0, endSeconds: 0.1, note: "冒頭の頭切れがないことを確認" },
          { startSeconds: 0.21, endSeconds: Math.max(0.22, durationSeconds - 0.21), note: "中盤の話者交代を実聴確認した" },
          { startSeconds: Math.max(0, durationSeconds - 0.1), endSeconds: durationSeconds, note: "終端のクリックがないことを確認" },
        ],
      },
    },
    checks: Object.fromEntries(requiredChecks.map((key) => [key, {
      note: `${key} に破綻が無いことを実物で確認した`,
      evidenceRefs: ["audioNaturalness", "audioBoundaryArtifacts"].includes(key)
        ? ["audioSpotChecks"]
        : ["camera", "editContinuity", "imagePacing", "dialoguePacing"].includes(key) ? ["fullVideo"] : frameRefs,
    }])),
    knownRemainingIssues: [],
  };
  const reviewNotesPath = join(auditDir, "review.json");
  await writeFile(reviewNotesPath, JSON.stringify(notes));
  return { episodeId, manifestPath, videoPath, contactSheetPath, reviewNotesPath, reviewer, outerJobBinding, resolved, durationSeconds, videoSha256 };
}

test("writeKoyaVisualSignoff attaches a trusted reviewer attestation that the final-audit gate re-verifies, and refuses untrusted or unconfigured keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "koya-signoff-attestation-"));
  try {
    const project = await signoffProject(root);
    const keyPath = join(root, "reviewer-ed25519.pem");
    await writeFile(keyPath, REVIEWER_KEY.privateKeyPem, { mode: 0o600 });
    const trustPath = join(root, "reviewer-trust.json");
    await writeFile(trustPath, JSON.stringify({
      version: KOYA_REVIEWER_TRUST_VERSION,
      reviewers: [createKoyaReviewerTrustEntry({ publicKeyPem: REVIEWER_KEY.publicKeyPem, label: "fixture reviewer" })],
    }));
    const common = {
      projectDir: root,
      manifestPath: project.manifestPath,
      reviewerHost: "codex",
      reviewerId: project.reviewer.id,
      reviewerContextId: project.reviewer.contextId,
      reviewNotesPath: project.reviewNotesPath,
      pass: true,
      // 信頼アンカーは運営者の env だけ。--reviewer-trust-path は照合用。
      env: { BUZZASSIST_REVIEWER_TRUST: trustPath },
    };
    const written = await writeKoyaVisualSignoff({ ...common, reviewerPrivateKeyPath: keyPath, reviewerTrustPath: trustPath });
    const signoff = JSON.parse(await readFile(written.outputPath, "utf8"));
    assert.equal(signoff.reviewerAttestation.signer.keyId, REVIEWER_KEY.keyId);
    assert.equal(signoff.reviewerAttestation.subject.videoSha256, project.videoSha256);
    assert.equal(signoff.reviewerAttestation.subject.outerJobBindingSha256, project.outerJobBinding.bindingSha256);
    assert.equal(signoff.reviewerAttestation.subject.reviewerContextId, project.reviewer.contextId);
    assert.equal(JSON.stringify(signoff).includes("PRIVATE KEY"), false);
    const reviewNotes = JSON.parse(await readFile(project.reviewNotesPath, "utf8"));
    const gate = validateKoyaVisualSignoff(signoff, {
      episodeId: project.episodeId,
      videoPath: project.videoPath,
      videoSha256: project.videoSha256,
      videoDurationSeconds: project.durationSeconds,
      contactSheetPath: project.contactSheetPath,
      contactSheetSha256: digest("fixture-contact-sheet"),
      reviewNotesFileSha256: digest(await readFile(project.reviewNotesPath)),
      reviewNotesContentSha256: digest(stableJson(reviewNotes)),
      evidenceFilesGate: await verifyKoyaPerceptualEvidenceFiles(reviewNotes),
      contractDigest: project.resolved.digest,
      contract: project.resolved.contract,
      generatorProvenance: { host: "claude", id: "claude:generator-context", contextId: "generator-context" },
      outerJobBinding: project.outerJobBinding,
      reviewerTrust: normalizeKoyaReviewerTrust(JSON.parse(await readFile(trustPath, "utf8"))),
    });
    assert.deepEqual(gate.failures, []);
    assert.equal(gate.pass, true);
    // 独立検証: 同じ attestation を lib 単体でも検証できる（監査と Receipt が同じ 1 関数を使う前提）。
    assert.equal(verifyKoyaReviewAttestation(signoff.reviewerAttestation, {
      expectedSubject: signoff.reviewerAttestation.subject,
      trust: REVIEWER_TRUST,
    }).pass, true);

    const strangerKeyPath = join(root, "stranger-ed25519.pem");
    await writeFile(strangerKeyPath, STRANGER_KEY.privateKeyPem, { mode: 0o600 });
    await assert.rejects(
      writeKoyaVisualSignoff({ ...common, reviewerPrivateKeyPath: strangerKeyPath, reviewerTrustPath: trustPath, outputPath: join(root, "stranger-signoff.json") }),
      /^Error: reviewer-key-untrusted/u,
    );
    await assert.rejects(
      writeKoyaVisualSignoff({ ...common, env: {}, reviewerPrivateKeyPath: keyPath, outputPath: join(root, "unconfigured-signoff.json") }),
      /^Error: reviewer-trust-unconfigured/u,
    );
    // env 未設定なら、正しい内容の --reviewer-trust-path があっても信頼アンカーは立たない。
    await assert.rejects(
      writeKoyaVisualSignoff({ ...common, env: {}, reviewerPrivateKeyPath: keyPath, reviewerTrustPath: trustPath, outputPath: join(root, "path-only-signoff.json") }),
      /^Error: reviewer-trust-unconfigured/u,
    );
    // env あり + 別内容の --reviewer-trust-path → conflict。自作の信頼リストで自分の鍵を通せない。
    const selfMintedTrustPath = join(root, "self-minted-trust.json");
    await writeFile(selfMintedTrustPath, JSON.stringify({
      version: KOYA_REVIEWER_TRUST_VERSION,
      reviewers: [createKoyaReviewerTrustEntry({ publicKeyPem: STRANGER_KEY.publicKeyPem, label: "self-minted" })],
    }));
    await assert.rejects(
      writeKoyaVisualSignoff({ ...common, reviewerPrivateKeyPath: strangerKeyPath, reviewerTrustPath: selfMintedTrustPath, outputPath: join(root, "conflict-signoff.json") }),
      (error) => /^reviewer-trust-conflict/u.test(error.message) && !error.message.includes("self-minted-trust.json"),
    );
    for (const name of ["unconfigured-signoff.json", "path-only-signoff.json", "conflict-signoff.json"]) {
      await assert.rejects(stat(join(root, name)), (error) => error?.code === "ENOENT", `${name} は書かれない`);
    }
    await assert.rejects(
      writeKoyaVisualSignoff({ ...common, reviewerTrustPath: trustPath, outputPath: join(root, "keyless-signoff.json") }),
      /^Error: reviewer-private-key-missing/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
