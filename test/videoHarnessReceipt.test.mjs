import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

function tamperSignature(signature) {
  // 末尾を "AA" にする改変は Ed25519 の S 上位 bit が常に 0 のため no-op になり得る（実測6%）。
  // 先頭 32 byte（R）の 1 文字を必ず別の値に置き換えて、bytes が確実に変わるようにする。
  const index = 10;
  const replacement = signature[index] === "A" ? "B" : "A";
  return `${signature.slice(0, index)}${replacement}${signature.slice(index + 1)}`;
}

import { executeVideoHarnessAdapter } from "../lib/videoHarnessAdapters.mjs";
import {
  createVideoHarnessJob,
  readVideoHarnessJob,
  resolveVideoHarnessExecutionContract,
  runVideoHarnessJob,
} from "../lib/videoHarnessJob.mjs";
import { projectVideoHarnessJob } from "../lib/videoHarnessCanvasAdapter.mjs";
import { createVideoHarnessRunReceipt } from "../lib/videoHarnessReceipt.mjs";
import { RUN_RECEIPT_SCHEMA_REVISION, verifyRunReceiptInvocation } from "../lib/harnessRunReceipt.mjs";
import { resolveCanvasRunStateFile } from "../lib/canvasRunState.mjs";
import { createKoyaOuterJobBinding } from "../lib/koyaOuterJobBinding.mjs";
import { stableJson } from "../lib/koyaMangaProductionContract.mjs";
import {
  KOYA_REVIEWER_TRUST_JSON_ENV,
  KOYA_REVIEWER_TRUST_VERSION,
  createKoyaReviewAttestation,
  createKoyaReviewAttestationSubject,
  createKoyaReviewerTrustEntry,
  generateKoyaReviewerKeyPair,
  normalizeKoyaReviewerTrust,
  signNarratedReviewSignoff,
} from "../lib/koyaReviewAttestation.mjs";
import {
  createVideoHarnessExecutionIdentityDigest,
  resolvedProductionContractSha256,
} from "../lib/videoHarnessExecutionIdentity.mjs";

// 完走の試験は Job の仕組み（Receipt・Canvas・再開で二重課金しない）を、リポジトリの実際の
// 宣言とスキルの上で確かめる。スキルの人の承認は人の手番で、正本を直した直後は必ず古く
// なるので、ここでは承認の要求を外す（子プロセスにも引き継がれる）。承認ゲート自体は
// test/videoHarnessProductionProfile.test.mjs が、公開前の承認は Release の skills:check:release が見る。
process.env.BUZZASSIST_REQUIRE_SKILL_APPROVAL = "0";

// Koya signoff の reviewer 鍵。信頼リストは生成プロセスとは別経路（環境変数）で
// Receipt 側へ渡す。runVideoHarnessJob 経由の e2e は process.env を読むので、
// この file の全 test に対して inline JSON で設定する（node --test は file ごとに別 process）。
const REVIEWER_KEY = generateKoyaReviewerKeyPair();
const REVOKED_KEY = generateKoyaReviewerKeyPair();
const STRANGER_KEY = generateKoyaReviewerKeyPair();
const REVIEWER_TRUST_RAW = {
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
};
process.env[KOYA_REVIEWER_TRUST_JSON_ENV] = JSON.stringify(REVIEWER_TRUST_RAW);
const REVIEWER_TRUST = normalizeKoyaReviewerTrust(REVIEWER_TRUST_RAW);
const TRUST_BEFORE_REVOCATION = normalizeKoyaReviewerTrust({
  version: KOYA_REVIEWER_TRUST_VERSION,
  reviewers: [createKoyaReviewerTrustEntry({ publicKeyPem: REVOKED_KEY.publicKeyPem })],
});
const STRANGER_TRUST = normalizeKoyaReviewerTrust({
  version: KOYA_REVIEWER_TRUST_VERSION,
  reviewers: [createKoyaReviewerTrustEntry({ publicKeyPem: STRANGER_KEY.publicKeyPem })],
});

const CHECKS = Object.freeze({
  audioIntegratedLoudness: true,
  narrationBedSeparation: true,
  perceptualReviewChecks: true,
  duration: true,
  frozenV1AndParentHashes: true,
  parentAudioPcmPreserved: true,
  perceptualReviewBoundToOutput: true,
  perceptualEvidenceHashes: true,
  contactSheetOriginalDetailReviewed: true,
  pixelAudit: true,
  sceneTransitionOwnedByParent: true,
  audioBoundaryBreathV16: true,
  noWholeProgramAcrossfade: true,
  avEndSync: true,
  bookendTransitionMeasured: true,
  operatorReplacementCleared: true,
  qualityLoopPassed: true,
  voiceTakeQuality: true,
  voiceCastRouting: true,
  characterIdentityReviewed: true,
  // 監査契約 v5: 場面の画の出どころと、途中の成果物の品質ループ。
  sceneImageProvenance: true,
  sceneImageAssetLoopPassed: true,
  voiceTakeAssetLoopPassed: true,
  characterAssetLoopPassed: true,
  // 監査契約 v6: 見た目の実測（焼き込み字幕・カメラの動き・感想パートの配置・回ごとの OP 映像の来歴）。
  burnedSubtitlesMeasured: true,
  cameraMotionMeasured: true,
  reviewLayoutMeasured: true,
  episodeOpeningProvenance: true,
});
const SIGNOFF_AUDIT_IDS = Object.freeze([
  "perceptualReviewChecks",
  "perceptualReviewBoundToOutput",
  "perceptualEvidenceHashes",
  "contactSheetOriginalDetailReviewed",
  "qualityLoopPassed",
  "characterIdentityReviewed",
]);
// 人物の同一性の採点（合成値）。署名された採点が下限以上であることを Receipt が見る。
const IDENTITY_SCORE = 90;
// 品質ループの契約 digest（合成値）。合格した回の採点がこの契約に対するものであることを Receipt が見る。
const QUALITY_CONTRACT_DIGEST = "9".repeat(64);
// 1秒・16x16の黒映像と無音AACを持つ、ffprobe/ffmpegで実際に全編decode
// できるprovider-free fixture。ftyp断片や任意bytesを完成証拠にしない。
const VALID_AV_MP4 = Buffer.from(
  "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",
  "base64",
);
// ffmpeg 7.1/libx264/AACで生成し、`ffmpeg -xerror -map 0:v:0 -map 0:a:0`
// の全decodeを通した0.5秒fixture。上の旧fixtureはAAC packetが壊れていたため、
// 実decode gateのnegative regression用に残し、正常系ではこちらだけを使う。
const FULLY_DECODABLE_AV_MP4 = Buffer.from(
  "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",
  "base64",
);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function artifact(root, kind, filename, contents) {
  const path = join(root, filename);
  const bytes = Buffer.from(contents);
  await writeFile(path, bytes);
  return { kind, path, sha256: sha256(bytes), bytes: bytes.length };
}

function job(root) {
  return {
    id: "video-narrated-story-video-aaaaaaaaaaaaaaaa",
    runDir: root,
    projectDir: root,
    identityDigest: "1".repeat(64),
    harness: { id: "narrated-story-video" },
    script: { sha256: "2".repeat(64) },
    channelPackVerification: {
      id: "test-pack",
      version: "1.0.0",
      payloadSha256: "3".repeat(64),
      fileCount: 2,
      signerKeyId: "signer",
      trustedPublicKeyId: "trusted",
    },
    channelPackRuntime: {
      imageModel: "image-model-v1",
      ttsProvider: "fixture-tts",
      imageProvider: "fixture-image",
      imageAdapterVersion: "image-adapter-v1",
      ttsModel: "tts-model-v1",
      ttsAdapterVersion: "tts-adapter-v1",
      musicProvider: "fixture-music",
      musicModel: "music-model-v1",
      musicAdapterVersion: "music-adapter-v1",
    },
  };
}

/**
 * narrated signoff の reviewer 署名。attest:
 *   "trusted"  = 信頼リストで active な鍵で署名（正系）
 *   "none"     = 署名無し（旧形式 / 鍵を持たない自作 signoff）
 *   "revoked"  = 後に失効した鍵で署名
 *   "stranger" = 信頼リストに無い鍵で署名
 *   "otherJob" = 別 Job の id / identityDigest に対して署名（転用）
 * mutateAfterSigning: 署名後に signoff 本文を書き換える（本文 digest 不一致の検査用）。
 */
async function completedFixture(root, {
  checks = CHECKS,
  requiredAuditIds = Object.keys(CHECKS),
  includeRequiredAuditIds = true,
  includeSignoff = true,
  signoffOverrides = {},
  reportOverrides = {},
  attest = "trusted",
  mutateAfterSigning = null,
  auditCheckOverrides = {},
} = {}) {
  const finalVideo = await artifact(root, "final-video", "final.mp4", FULLY_DECODABLE_AV_MP4);
  const contactSheet = await artifact(root, "contact-sheet", "contact-sheet.jpg", "fixture contact sheet");
  const unsigned = {
    version: "buzzassist-narrated-story-contact-sheet-signoff-v2",
    reviewer: "codex-reviewer",
    reviewerContextId: "review-context-001",
    approved: true,
    originalDetailReviewed: true,
    videoSha256: finalVideo.sha256,
    contactSheetSha256: contactSheet.sha256,
    findings: [],
    knownRemainingIssues: [],
    qualityReview: {
      contractDigest: QUALITY_CONTRACT_DIGEST,
      evaluatorContextId: "review-context-001",
      rubricScores: { "script-image-fit": 95, "character-identity": IDENTITY_SCORE },
      notes: "合成の採点",
    },
    reviewedAt: "2026-09-01T00:00:00.000Z",
    ...signoffOverrides,
  };
  const signers = {
    trusted: { key: REVIEWER_KEY, trust: REVIEWER_TRUST, jobId: job(root).id, identityDigest: job(root).identityDigest },
    revoked: { key: REVOKED_KEY, trust: TRUST_BEFORE_REVOCATION, jobId: job(root).id, identityDigest: job(root).identityDigest },
    stranger: { key: STRANGER_KEY, trust: STRANGER_TRUST, jobId: job(root).id, identityDigest: job(root).identityDigest },
    otherJob: { key: REVIEWER_KEY, trust: REVIEWER_TRUST, jobId: "video-narrated-story-video-bbbbbbbbbbbbbbbb", identityDigest: "7".repeat(64) },
  };
  let signoff = unsigned;
  if (attest !== "none") {
    const signer = signers[attest];
    if (!signer) throw new Error(`unknown attest mode ${attest}`);
    signoff = await signNarratedReviewSignoff({
      signoff: unsigned,
      jobId: signer.jobId,
      identityDigest: signer.identityDigest,
      privateKeyPem: signer.key.privateKeyPem,
      trust: signer.trust,
      signedAt: "2026-09-01T00:00:00.000Z",
    });
  }
  if (typeof mutateAfterSigning === "function") mutateAfterSigning(signoff);
  const signoffArtifact = await artifact(root, "signoff", "signoff.json", JSON.stringify(signoff));
  const auditChecks = Object.fromEntries(Object.entries(checks).map(([id, value]) => [id, value]));
  for (const id of SIGNOFF_AUDIT_IDS) {
    if (checks[id] === true || checks[id]?.pass === true) {
      auditChecks[id] = {
        pass: true,
        signoffSha256: signoffArtifact.sha256,
        videoSha256: finalVideo.sha256,
        contactSheetSha256: contactSheet.sha256,
        ...(id === "qualityLoopPassed" ? { contractDigest: QUALITY_CONTRACT_DIGEST } : {}),
        ...(id === "characterIdentityReviewed" ? {
          contractDigest: QUALITY_CONTRACT_DIGEST,
          criterionId: "character-identity",
          minimumScore: 80,
          score: IDENTITY_SCORE,
        } : {}),
      };
    }
  }
  Object.assign(auditChecks, auditCheckOverrides);
  const report = {
    version: "buzzassist-narrated-story-audit-v1",
    status: "pass",
    jobId: job(root).id,
    auditChecks,
    videoSha256: finalVideo.sha256,
    contactSheetSha256: contactSheet.sha256,
    contractVersion: "fixture-v1",
    generatedAt: "2026-09-01T00:00:00.000Z",
    ...(includeRequiredAuditIds ? { requiredAuditIds } : {}),
    ...(includeSignoff ? {
      independentSignoff: {
        path: signoffArtifact.path,
        sha256: signoffArtifact.sha256,
        reviewer: signoff.reviewer,
        reviewerContextId: signoff.reviewerContextId,
      },
    } : {}),
    ...reportOverrides,
  };
  const artifacts = [
    await artifact(root, "audit-report", "audit.json", JSON.stringify(report)),
    finalVideo,
    contactSheet,
    await artifact(root, "audio", "narration.wav", "fixture audio"),
    await artifact(root, "subtitle", "subtitles.srt", "fixture subtitles"),
    await artifact(root, "bgm", "background.mp3", "fixture bgm"),
  ];
  return {
    status: "completed",
    knownRemainingIssues: [],
    artifacts,
    mediaJobs: [{
      status: "completed",
      kind: "voice.synthesis",
      provider: "fixture",
      adapterVersion: "v1",
      inputHash: "5".repeat(64),
      artifact: { sha256: "6".repeat(64), bytes: 10 },
    }],
    runtimeMetadata: {
      imageModel: "image-model-v1",
      ttsProvider: "fixture-tts",
      imageProvider: "fixture-image",
      imageAdapterVersion: "image-adapter-v1",
      ttsModel: "tts-model-v1",
      ttsAdapterVersion: "tts-adapter-v1",
      musicProvider: "fixture-music",
      musicModel: "music-model-v1",
      musicAdapterVersion: "music-adapter-v1",
    },
    adapterProbes: [{
      ok: true,
      status: "ready",
      kind: "voice.synthesis",
      provider: "fixture-tts",
      model: "tts-model-v1",
      adapterVersion: "tts-adapter-v1",
      serverVersion: "fixture-server-v1",
    }],
  };
}

async function completedKoyaOuterFixture(root, options = {}) {
  const {
    brokenVideo = false,
    episodeId = "koya-provider-free",
    outerJob = null,
    contractPath = "",
    overridePath = "",
  } = options;
  const scriptPath = join(root, "raw-script.txt");
  const scriptText = "これはprovider-freeのKoya統合fixtureです。";
  await writeFile(scriptPath, scriptText);
  const finalVideo = await artifact(
    root,
    "final-video",
    "koya-final.mp4",
    brokenVideo ? VALID_AV_MP4 : FULLY_DECODABLE_AV_MP4,
  );
  const contactSheet = await artifact(
    root,
    "contact-sheet",
    "koya-contact-sheet.png",
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
  );
  const outerIdentity = outerJob || {
    id: "video-koya-manga-video-bbbbbbbbbbbbbbbb",
    identityDigest: "b".repeat(64),
  };
  const resolvedProductionContract = await resolveVideoHarnessExecutionContract({
    harness: { id: "koya-manga-video" },
    projectDir: root,
    executionProjectDir: root,
    options: { episodeId, contractPath, overridePath },
  });
  // 実行識別子は「Job id + canonical identity + 固定した解決済み制作契約」から
  // 導く。fixture 側で手打ちにすると、finalize が突き合わせている対象が
  // fixture の定数になってしまい、契約固定の検証が空洞になる。
  // 検証済み Channel Pack（署名鍵・信頼鍵・署名済み payload manifest）も入力。
  // Job と契約だけから導くと、別の署名 pack で走った Job が同じ識別子を持てる。
  // 実 Job と組む場合は、prepare が永続化するのと同じ検証結果を渡すこと。
  // 1 field でも違えば、それは「別の pack で走った Job」として拒否される。
  const channelPackVerification = options.channelPackVerification || {
    id: "koya-pack",
    version: "1.0.0",
    payloadSha256: "3".repeat(64),
    fileCount: 3,
    signerKeyId: "signer",
    trustedPublicKeyId: "trusted",
  };
  const executionIdentityDigest = createVideoHarnessExecutionIdentityDigest({
    jobId: outerIdentity.id,
    identityDigest: outerIdentity.identityDigest,
    resolvedProductionContract,
    channelPackVerification,
  });
  const outerJobBinding = createKoyaOuterJobBinding({
    jobId: outerIdentity.id,
    identityDigest: outerIdentity.identityDigest,
    executionIdentityDigest,
    resolvedProductionContractSha256: resolvedProductionContractSha256(resolvedProductionContract),
  });
  const signoffOuterJobBinding = Object.hasOwn(options, "signoffOuterJobBinding")
    ? options.signoffOuterJobBinding
    : outerJobBinding;
  const reportOuterJobBinding = Object.hasOwn(options, "reportOuterJobBinding")
    ? options.reportOuterJobBinding
    : outerJobBinding;
  const reportedContractVersion = options.reportedContractVersion
    || resolvedProductionContract.contractVersion;
  const reportedContractDigest = options.reportedContractDigest
    || resolvedProductionContract.contractDigest;
  const reviewerProvenance = { host: "codex", id: "independent-reviewer", contextId: "review-context-koya" };
  const reviewNotes = options.reviewNotes || {
    version: "koya-perceptual-review-notes-v3",
    episodeId,
    reviewer: reviewerProvenance,
    summary: "provider-free fixture review notes",
  };
  const reviewNotesContentSha256 = sha256(stableJson(reviewNotes));
  // 信頼設定済み reviewer 鍵の署名。subject は Receipt 側が期待値から組む値と同じ材料。
  // 否定テストは subjectOverrides で「別の対象へ署名した attestation」を作る。
  let reviewerAttestation = null;
  if (!options.omitAttestation) {
    const attestationBinding = options.attestationOuterJobBinding || signoffOuterJobBinding || outerJobBinding;
    const subject = createKoyaReviewAttestationSubject({
      episodeId,
      outerJobBinding: attestationBinding,
      contractDigest: reportedContractDigest,
      videoSha256: finalVideo.sha256,
      contactSheetSha256: contactSheet.sha256,
      reviewNotesContentSha256,
      reviewer: reviewerProvenance,
      ...(options.attestationSubjectOverrides || {}),
    });
    reviewerAttestation = await createKoyaReviewAttestation({
      subject,
      privateKeyPem: (options.signingKey || REVIEWER_KEY).privateKeyPem,
      trust: options.signingTrust || REVIEWER_TRUST,
      signedAt: "2026-09-01T00:00:00.000Z",
    });
    if (typeof options.mutateAttestation === "function") options.mutateAttestation(reviewerAttestation);
  }
  const signoffDocument = {
    version: "koya-agent-perceptual-signoff-v4",
    episodeId,
    outerJobBinding: signoffOuterJobBinding,
    contractVersion: reportedContractVersion,
    contractDigest: reportedContractDigest,
    videoPath: finalVideo.path,
    videoSha256: finalVideo.sha256,
    videoDurationSeconds: 1,
    contactSheetPath: contactSheet.path,
    contactSheetSha256: contactSheet.sha256,
    pass: true,
    knownRemainingIssues: [],
    reviewerProvenance,
    ...(reviewerAttestation ? { reviewerAttestation } : {}),
    reviewNotes,
    reviewNotesContentSha256: options.reviewNotesContentSha256 || reviewNotesContentSha256,
    reviewedAt: "2026-09-01T00:00:00.000Z",
  };
  const signoff = await artifact(root, "signoff-report", "koya-signoff.json", JSON.stringify(signoffDocument));
  // 実際の最終監査と同じく、report の必須監査は Job が固定した制作契約の requiredAudits。
  // omitAuditIds: 監査を走らせなかった回（report の必須監査一覧と実測の両方から外す）。
  const pinnedContract = JSON.parse(await readFile(resolvedProductionContract.contractPath, "utf8"));
  const omitted = new Set(options.omitAuditIds || []);
  const requiredAuditIds = pinnedContract.requiredAudits.filter((id) => !omitted.has(id));
  const steps = requiredAuditIds.map((id) => ({ id, pass: true, detail: "provider-free measured fixture" }));
  Object.assign(steps.find((step) => step.id === "agent-contact-sheet-review"), {
    evidencePath: signoff.path,
    evidenceSha256: signoff.sha256,
    contactSheetPath: contactSheet.path,
    contactSheetSha256: contactSheet.sha256,
    contactSheetPass: true,
    signoffGate: { pass: true, failures: [] },
  });
  const report = {
    version: "koya-final-audit-v1",
    episodeId,
    outerJobBinding: reportOuterJobBinding,
    contractVersion: reportedContractVersion,
    contractDigest: reportedContractDigest,
    videoPath: finalVideo.path,
    videoSha256: finalVideo.sha256,
    videoDurationSeconds: 1,
    requiredAuditIds,
    steps,
    pass: true,
    knownRemainingIssues: [],
    generatedAt: "2026-09-01T00:00:00.000Z",
  };
  const audit = await artifact(root, "audit-report", "koya-audit.json", JSON.stringify(report));
  const makeMediaJob = (takeIndex) => ({
    version: "paid-media-job-receipt-v1",
    jobId: `koya-media-${takeIndex}`,
    requestKey: `koya:cut-01:take:${takeIndex + 1}:${sha256(`take-${takeIndex}`)}`,
    status: "completed",
    kind: "voice.dialogue",
    provider: "elevenlabs",
    adapterVersion: "elevenlabs-dialogue-server-v1",
    model: "eleven_v3",
    inputHash: sha256(`input-${takeIndex}`),
    artifact: { sha256: sha256(`audio-${takeIndex}`), mimeType: "audio/wav", bytes: 128 },
  });
  const mediaJobs = [makeMediaJob(0), makeMediaJob(1)];
  const job = {
    id: outerIdentity.id,
    runDir: root,
    projectDir: root,
    executionProjectDir: root,
    identityDigest: outerIdentity.identityDigest,
    executionIdentityDigest,
    resolvedProductionContract,
    harness: { id: "koya-manga-video" },
    script: { path: scriptPath, sha256: sha256(scriptText) },
    channelPackVerification,
    options: {
      episodeId,
      ...(contractPath ? { contractPath } : {}),
      ...(overridePath ? { overridePath } : {}),
      protagonistSpeakerId: "lead",
      characterBiblePath: join(root, "character-bible.json"),
      storyReviewPath: join(root, "story-review.json"),
    },
  };
  const outcome = await executeVideoHarnessAdapter({
    job,
    runChild: async () => ({
      code: 0,
      signal: null,
      stderr: "",
      stdout: JSON.stringify({
        status: "final-koya-audited",
        knownRemainingIssues: [],
        videoPath: finalVideo.path,
        reportPath: audit.path,
        contactSheetPath: contactSheet.path,
        visualSignoffPath: signoff.path,
        visualSignoffSha256: signoff.sha256,
        mediaJobs,
      }),
    }),
  });
  return { job, outcome, signoff, mediaJobs };
}

test("Koya adapter payloadの全paid takeとSHA-bound signoffでouter RunReceiptがpassになる", async () => {
  const root = await mkdtemp(join(tmpdir(), "video-koya-outer-receipt-"));
  try {
    const fixture = await completedKoyaOuterFixture(root);
    const result = await createVideoHarnessRunReceipt({
      job: fixture.job,
      outcome: fixture.outcome,
      now: () => "2026-09-01T00:00:00.000Z",
    });
    assert.equal(result.receipt.outcome, "pass");
    assert.equal(result.receipt.mediaJobs.length, 2);
    assert.deepEqual(result.receipt.mediaJobs.map((row) => row.inputHash), fixture.mediaJobs.map((row) => row.inputHash));
    assert.equal(result.receipt.approvals[0].evidenceDigest, fixture.signoff.sha256);
    // RunReceipt は入力を digest でしか持たない。信頼リストの SHA と署名者 keyId は
    // 既知の値から再計算して突き合わせられる（記録から辿れる）ことを確認する。
    assert.equal(result.receipt.inputDigests.reviewerTrustSha256, sha256(REVIEWER_TRUST.sha256));
    assert.equal(result.receipt.inputDigests.reviewerAttestations, sha256(JSON.stringify([{
      signerKeyId: REVIEWER_KEY.keyId,
      reviewerLabel: "fixture reviewer",
      trustSha256: REVIEWER_TRUST.sha256,
    }])));
    assert.equal(JSON.stringify(result.receipt).includes("PRIVATE KEY"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Koya signoffのreviewer attestationを共通finalizeで再検証し、失効鍵・未登録鍵・別Job・成果物改変・欠落・非正規形を理由コードで拒否する", async (t) => {
  const otherBinding = createKoyaOuterJobBinding({
    jobId: "video-koya-manga-video-dddddddddddddddd",
    identityDigest: "d".repeat(64),
    executionIdentityDigest: "5".repeat(64),
    resolvedProductionContractSha256: "6".repeat(64),
  });
  const cases = [
    ["attestation欠落", { omitAttestation: true }, /reviewer-attestation-missing/u],
    // 失効前の日付で署名されていても拒否する。signedAt は鍵の持ち主の自己申告。
    ["署名後に失効した鍵", { signingKey: REVOKED_KEY, signingTrust: TRUST_BEFORE_REVOCATION }, /reviewer-key-revoked/u],
    ["未登録の自己生成鍵", { signingKey: STRANGER_KEY, signingTrust: STRANGER_TRUST }, /reviewer-key-untrusted/u],
    ["別Jobへの転用", { attestationOuterJobBinding: otherBinding }, /reviewer-attestation-subject-mismatch:jobId.*reviewer-attestation-subject-mismatch:outerJobBindingSha256/u],
    ["MP4差替え", { attestationSubjectOverrides: { videoSha256: "9".repeat(64) } }, /reviewer-attestation-subject-mismatch:videoSha256/u],
    ["contact sheet差替え", { attestationSubjectOverrides: { contactSheetSha256: "9".repeat(64) } }, /reviewer-attestation-subject-mismatch:contactSheetSha256/u],
    ["review notes改変", { attestationSubjectOverrides: { reviewNotesContentSha256: "9".repeat(64) } }, /reviewer-attestation-subject-mismatch:reviewNotesContentSha256/u],
    ["reviewer context再申告", { attestationSubjectOverrides: { reviewer: { host: "codex", id: "independent-reviewer", contextId: "review-context-other" } } }, /reviewer-attestation-subject-mismatch:reviewerContextId/u],
    ["署名対象の末尾空白", { mutateAttestation: (a) => { a.subject.videoSha256 = `${a.subject.videoSha256} `; } }, /reviewer-attestation-subject-noncanonical:videoSha256/u],
    ["署名対象のHex大文字化", { mutateAttestation: (a) => { a.subject.executionIdentityDigest = a.subject.executionIdentityDigest.toUpperCase(); } }, /reviewer-attestation-subject-noncanonical:executionIdentityDigest/u],
    ["署名bytes改変", { mutateAttestation: (a) => { a.signature = tamperSignature(a.signature); } }, /reviewer-attestation-signature-invalid/u],
    ["埋め込みreview notesと申告digestの不一致", { reviewNotesContentSha256: "8".repeat(64) }, /reviewNotesContentSha256が埋め込まれたreview notesと一致しない/u],
  ];
  for (const [name, options, expected] of cases) {
    await t.test(name, async () => {
      const root = await mkdtemp(join(tmpdir(), "video-koya-reviewer-attestation-negative-"));
      try {
        const fixture = await completedKoyaOuterFixture(root, options);
        await assert.rejects(
          createVideoHarnessRunReceipt({ job: fixture.job, outcome: fixture.outcome, reviewerTrust: REVIEWER_TRUST }),
          expected,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
  await t.test("信頼リスト未設定ならcompletedにしない", async () => {
    const root = await mkdtemp(join(tmpdir(), "video-koya-reviewer-trust-unconfigured-"));
    try {
      const fixture = await completedKoyaOuterFixture(root);
      await assert.rejects(
        createVideoHarnessRunReceipt({ job: fixture.job, outcome: fixture.outcome, env: {} }),
        /reviewer-trust-unconfigured/u,
      );
      const passing = await createVideoHarnessRunReceipt({ job: fixture.job, outcome: fixture.outcome, reviewerTrust: REVIEWER_TRUST });
      assert.equal(passing.receipt.outcome, "pass");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("Koyaのaudit/signoffがpassでも壊れたfinal MP4は共通実デコードgateで拒否する", async () => {
  const root = await mkdtemp(join(tmpdir(), "video-koya-broken-final-"));
  try {
    const fixture = await completedKoyaOuterFixture(root, { brokenVideo: true });
    await assert.rejects(
      createVideoHarnessRunReceipt({ job: fixture.job, outcome: fixture.outcome }),
      /final-video.*(?:ffprobe|全映像・音声デコード|映像stream)/iu,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Koya outer Job bindingの欠落・改ざん・別Job流用を共通finalizeで拒否する", async (t) => {
  // 形式としては完全に妥当な、別 Job の binding。ここが v1 の欠けた形だと
  // 「別Jobの流用」ではなく「必須項目が無い」で落ち、流用拒否を測れない。
  const unrelated = createKoyaOuterJobBinding({
    jobId: "video-koya-manga-video-cccccccccccccccc",
    identityDigest: "c".repeat(64),
    executionIdentityDigest: "7".repeat(64),
    resolvedProductionContractSha256: "8".repeat(64),
  });
  const cases = [
    ["audit binding欠落", { reportOuterJobBinding: null }, /outer Job binding is required/iu],
    ["signoff binding欠落", { signoffOuterJobBinding: null }, /outer Job binding is required/iu],
    ["binding digest改ざん", {
      reportOuterJobBinding: { ...unrelated, bindingSha256: "f".repeat(64) },
      signoffOuterJobBinding: { ...unrelated, bindingSha256: "f".repeat(64) },
    }, /binding digest or contract is invalid/iu],
    ["別Jobのbinding", {
      reportOuterJobBinding: unrelated,
      signoffOuterJobBinding: unrelated,
    }, /binding belongs to another Job/iu],
  ];
  for (const [name, options, expected] of cases) {
    await t.test(name, async () => {
      const root = await mkdtemp(join(tmpdir(), "video-koya-outer-binding-negative-"));
      try {
        const fixture = await completedKoyaOuterFixture(root, options);
        await assert.rejects(
          createVideoHarnessRunReceipt({ job: fixture.job, outcome: fixture.outcome }),
          expected,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("Koya Jobのexecution identity欠落・改変・大文字化・末尾空白・Channel Pack検証差替えを共通finalizeで拒否する", async (t) => {
  // hash は所有者への暗号学的対抗手段ではない。ここで測るのは「同じ Job 内で
  // 識別子・契約・検証済み pack のどれかがずれたら、finalize がその理由で止まる」こと。
  const cases = [
    ["欠落", (job) => { delete job.executionIdentityDigest; }, /execution identity is missing/iu],
    ["空文字", (job) => { job.executionIdentityDigest = ""; }, /execution identity is missing/iu],
    ["大文字化", (job) => { job.executionIdentityDigest = job.executionIdentityDigest.toUpperCase(); }, /not a canonical lowercase SHA-256/iu],
    ["末尾空白", (job) => { job.executionIdentityDigest = `${job.executionIdentityDigest} `; }, /not a canonical lowercase SHA-256/iu],
    ["改変", (job) => { job.executionIdentityDigest = "0".repeat(64); }, /execution identity does not match/iu],
    ["契約override差替え", (job) => { job.resolvedProductionContract = { ...job.resolvedProductionContract, episodeOverrideFileSha256: "5".repeat(64) }; }, /execution identity does not match/iu],
    ["Channel Pack検証payload差替え", (job) => { job.channelPackVerification = { ...job.channelPackVerification, payloadSha256: "4".repeat(64) }; }, /execution identity does not match/iu],
    ["Channel Pack信頼鍵差替え", (job) => { job.channelPackVerification = { ...job.channelPackVerification, trustedPublicKeyId: "another-trusted" }; }, /execution identity does not match/iu],
    ["Channel Pack検証欠落", (job) => { delete job.channelPackVerification; }, /execution identity does not match/iu],
  ];
  for (const [name, mutate, expected] of cases) {
    await t.test(name, async () => {
      const root = await mkdtemp(join(tmpdir(), "video-koya-execution-identity-negative-"));
      try {
        const fixture = await completedKoyaOuterFixture(root);
        mutate(fixture.job);
        await assert.rejects(
          createVideoHarnessRunReceipt({ job: fixture.job, outcome: fixture.outcome }),
          expected,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("Koya reportとsignoffが同じ架空contract digestを自己申告しても実契約と違えば拒否する", async () => {
  const root = await mkdtemp(join(tmpdir(), "video-koya-fake-contract-"));
  try {
    const fixture = await completedKoyaOuterFixture(root, {
      reportedContractDigest: "d".repeat(64),
    });
    await assert.rejects(
      createVideoHarnessRunReceipt({ job: fixture.job, outcome: fixture.outcome }),
      /現在のKoya production contract/iu,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Koya contractの意味が同じでもdoctor後に実file bytesが変わればfinalizeしない", async () => {
  const root = await mkdtemp(join(tmpdir(), "video-koya-contract-byte-drift-"));
  try {
    const contractPath = join(root, "koya-contract.json");
    const original = await readFile(join(process.cwd(), "config/koya-manga-production-contract.json"));
    await writeFile(contractPath, original);
    const fixture = await completedKoyaOuterFixture(root, { contractPath });
    await writeFile(contractPath, Buffer.concat([original, Buffer.from("\n")]));
    await assert.rejects(
      createVideoHarnessRunReceipt({ job: fixture.job, outcome: fixture.outcome }),
      /解決済み制作契約がdoctor後に変わった/iu,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("raw script→durable Koya Job→adapter child→RunReceipt→Canvasを完走しresumeで二重課金しない", async () => {
  const root = await mkdtemp(join(tmpdir(), "video-koya-real-outer-job-"));
  try {
    const deployment = join(root, "deployment");
    const workspace = join(root, "workspace");
    const pack = join(root, "signed-pack");
    await Promise.all([
      mkdir(join(root, "config"), { recursive: true }),
      mkdir(join(deployment, "production"), { recursive: true }),
      mkdir(workspace, { recursive: true }),
      mkdir(pack, { recursive: true }),
    ]);
    await writeFile(join(deployment, "canonical.mjs"), "import './production/shared.mjs';\n");
    await writeFile(join(deployment, "production", "shared.mjs"), "export const runtime = 'fixture';\n");
    await writeFile(join(root, "config", "harness-deployments.json"), `${JSON.stringify({
      deployments: [{ harnessId: "koya-manga-video", root: "deployment", entrypoint: "node canonical.mjs" }],
    }, null, 2)}\n`);
    const rawScript = join(root, "raw-script.txt");
    await writeFile(rawScript, "これは共通Jobを端から端まで通すKoya台本です。\n");
    await writeFile(join(pack, "envelope.json"), "{\"fixture\":true}\n");

    const created = await createVideoHarnessJob({
      projectDir: root,
      scriptPath: rawScript,
      channelPackPath: pack,
      harnessId: "koya-manga-video",
      repoRoot: root,
      options: {
        episodeId: "koya-real-outer-fixture",
        protagonistSpeakerId: "lead",
        characterBiblePath: join(root, "character-bible.json"),
        storyReviewPath: join(root, "story-review.json"),
      },
      now: () => "2026-09-01T00:00:00.000Z",
    });
    const childOutput = join(root, "child-output");
    await mkdir(childOutput, { recursive: true });
    // 共通 Job の prepare が永続化する検証結果と同一のもの。子側の識別子も
    // これから導かれるので、別オブジェクトを手打ちすると識別子が合わない。
    const packEvidence = {
      id: "koya-pack",
      version: "1.0.0",
      harnessId: "koya-manga-video",
      payloadKind: "koya-handoff",
      payloadSha256: "3".repeat(64),
      fileCount: 3,
      signerKeyId: "signer",
      trustedPublicKeyId: "trusted",
    };
    const childFixture = await completedKoyaOuterFixture(childOutput, {
      episodeId: "koya-real-outer-fixture",
      outerJob: created.job,
      channelPackVerification: packEvidence,
    });
    const byKind = new Map(childFixture.outcome.artifacts.map((entry) => [entry.kind, entry]));
    const childPayload = {
      status: "final-koya-audited",
      knownRemainingIssues: [],
      videoPath: byKind.get("final-video").path,
      reportPath: byKind.get("audit-report").path,
      contactSheetPath: byKind.get("contact-sheet").path,
      visualSignoffPath: byKind.get("signoff-report").path,
      visualSignoffSha256: childFixture.signoff.sha256,
      mediaJobs: childFixture.mediaJobs,
    };
    let childCalls = 0;
    let doctorCalls = 0;
    const canvasSnapshots = [];
    const canvasResults = [];
    const projectCanvas = async (current) => {
      canvasSnapshots.push({
        jobId: current.id,
        revision: current.revision,
        status: current.status,
        mediaJobCount: current.mediaJobs?.length || 0,
      });
      canvasResults.push(await projectVideoHarnessJob(current, {
        feedbackCollector: async () => ({
          version: "buzzassist-canvas-feedback-collection-v1",
          ok: true,
          operation: "collect-feedback",
          jobId: current.id,
          captured: 0,
        }),
      }));
    };
    const run = () => runVideoHarnessJob({
      projectDir: root,
      jobId: created.job.id,
      prepare: async () => ({
        ok: true,
        executionProjectDir: workspace,
        evidence: structuredClone(packEvidence),
      }),
      doctor: async () => {
        doctorCalls += 1;
        return { version: "harness-doctor-v1", ready: true, blocking: [], checks: [{ id: "fixture", required: true, ok: true }] };
      },
      adapter: (context) => executeVideoHarnessAdapter({
        ...context,
        runChild: async () => {
          childCalls += 1;
          return { code: 0, signal: null, stderr: "", stdout: JSON.stringify(childPayload) };
        },
      }),
      projectCanvas,
      now: () => "2026-09-01T00:00:00.000Z",
    });

    const completed = await run();
    assert.equal(completed.status, "completed", JSON.stringify({ error: completed.error, issues: completed.knownRemainingIssues }));
    assert.equal(childCalls, 1);
    assert.equal(doctorCalls, 1);
    assert.equal(completed.mediaJobs.length, 2);
    assert.equal(completed.resolvedProductionContract?.harnessId, "koya-manga-video");
    assert.match(completed.resolvedProductionContract?.contractDigest || "", /^[a-f0-9]{64}$/u);
    assert.equal(new Set(completed.mediaJobs.map((row) => row.inputHash)).size, 2);
    const receiptArtifact = completed.artifacts.find((entry) => entry.kind === "run-receipt");
    const receipt = JSON.parse(await readFile(receiptArtifact.path, "utf8"));
    assert.equal(receipt.outcome, "pass");
    assert.equal(receipt.mediaJobs.length, 2);
    assert.equal(receipt.approvals[0].evidenceDigest, childFixture.signoff.sha256);
    assert.equal(receipt.harnessBuild.productionDependencies.deployment.digest,
      completed.canonicalIdentity.productionDependencies.deployment.digest);
    const canvasRun = JSON.parse(await readFile(resolveCanvasRunStateFile({ projectDir: root }, completed.id), "utf8"));
    assert.equal(canvasRun.status, "complete");
    assert.equal(canvasRun.artifacts.find((entry) => entry.kind === "final-mp4").sha256,
      `sha256:${byKind.get("final-video").sha256}`);
    assert.equal(canvasRun.artifacts.find((entry) => entry.kind === "contact-sheet").sha256,
      `sha256:${byKind.get("contact-sheet").sha256}`);
    assert.equal(canvasRun.signoffs[0].evidenceSha256, `sha256:${childFixture.signoff.sha256}`);
    const canvasScene = JSON.parse(await readFile(join(root, "canvas", "excalidraw-canvas.json"), "utf8"));
    const projectedMedia = canvasScene.elements.filter((element) =>
      element.customData?.buzzassistRunId === completed.id
      && element.customData?.buzzassistEntityKind === "artifact-media"
      && !element.isDeleted);
    assert.deepEqual(
      new Set(projectedMedia.map((element) => element.customData.buzzassistArtifactSha256)),
      new Set([
        `sha256:${byKind.get("final-video").sha256}`,
        `sha256:${byKind.get("contact-sheet").sha256}`,
      ]),
    );

    const receiptBytesBeforeResume = await readFile(receiptArtifact.path);
    const resumed = await run();
    assert.equal(resumed.status, "completed");
    assert.equal(childCalls, 1, "terminal resume must not invoke the paid child twice");
    assert.equal(doctorCalls, 1, "terminal resume must not rerun doctor");
    assert.equal(resumed.mediaJobs.length, 2);
    assert.deepEqual(await readFile(receiptArtifact.path), receiptBytesBeforeResume);
    assert.equal(canvasSnapshots.at(-1).status, "completed");
    assert.equal(canvasResults.at(-1).added, 0);
    assert.equal(canvasResults.at(-1).updated, 0);
    assert.equal(canvasResults.at(-1).mediaProjection.added, 0);
    assert.equal(canvasResults.at(-1).mediaProjection.updated, 0);
    assert.equal(canvasResults.at(-1).mediaProjection.projectedMedia, 2);
    assert.deepEqual(await readVideoHarnessJob({ projectDir: root, jobId: created.job.id }), resumed);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Koya audit後にsignoff bytesが変わればouter finalize前に拒否する", async () => {
  const root = await mkdtemp(join(tmpdir(), "video-koya-signoff-tamper-"));
  try {
    const fixture = await completedKoyaOuterFixture(root);
    await writeFile(fixture.signoff.path, JSON.stringify({ pass: true, changed: true }));
    await assert.rejects(
      createVideoHarnessRunReceipt({ job: fixture.job, outcome: fixture.outcome }),
      /SHA-256|evidence SHA/iu,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SHA検証済みreport・完全roster・独立signoffから共通RunReceiptを作る", async () => {
  const root = await mkdtemp(join(tmpdir(), "video-receipt-"));
  try {
    const outcome = await completedFixture(root);
    const result = await createVideoHarnessRunReceipt({
      job: job(root),
      outcome,
      now: () => "2026-09-01T00:00:00.000Z",
    });
    assert.equal(result.receipt.outcome, "pass");
    assert.equal(result.receipt.harnessBuild.channelPack[0].source, "signed-envelope");
    assert.equal(result.receipt.mediaJobs.length, 1);
    assert.match(result.receipt.inputDigests.channelPackRuntimeIdentity, /^[a-f0-9]{64}$/u);
    assert.match(result.receipt.inputDigests.adapterRuntimeIdentity, /^[a-f0-9]{64}$/u);
    assert.match(result.receipt.inputDigests.adapterCapabilityProbes, /^[a-f0-9]{64}$/u);
    assert.equal(result.receipt.artifacts.length, 6);
    assert.equal(result.receipt.approvals.length, 1);
    assert.equal(result.receipt.approvals[0].type, "independent-agent");
    assert.equal(result.receipt.artifacts[0].sha256, outcome.artifacts[0].sha256);
    // narrated でも Koya と同じ信頼リスト・署名者が Receipt から追跡できる。
    assert.equal(result.receipt.inputDigests.reviewerTrustSha256, sha256(REVIEWER_TRUST.sha256));
    assert.equal(
      result.receipt.inputDigests.reviewerAttestations,
      sha256(JSON.stringify([{ signerKeyId: REVIEWER_KEY.keyId, reviewerLabel: "fixture reviewer", trustSha256: REVIEWER_TRUST.sha256 }])),
    );
    const stored = JSON.parse(await readFile(result.path, "utf8"));
    assert.equal(stored.finalized, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Job に残った作ったホスト・再開したホストと所要時間を、共通 RunReceipt に digest つきで写す", async () => {
  const root = await mkdtemp(join(tmpdir(), "video-receipt-host-"));
  try {
    const outcome = await completedFixture(root);
    const call = (overrides) => ({
      host: "claude-code",
      hostVersion: "9.9.1",
      clientName: "claude-code",
      candidates: [],
      model: "synthetic-model-a",
      modelSource: "caller-declared",
      buzzassistVersion: "0.1.27",
      via: "mcp",
      detectedFrom: "mcp-client-info",
      operation: "start",
      mode: "plan-only",
      at: "2026-09-01T00:00:00.000Z",
      ...overrides,
    });
    const invocation = {
      version: "buzzassist-host-invocation-v1",
      createdBy: call(),
      resumedBy: [call({ host: "codex", hostVersion: "9.9.2", clientName: "codex-mcp-client", model: "unknown", modelSource: "unavailable", operation: "resume", mode: "execute", at: "2026-09-01T00:30:00.000Z" })],
    };
    const hosted = {
      ...job(root),
      createdAt: "2026-09-01T00:00:00.000Z",
      stages: [{ id: "doctor", status: "pass", startedAt: "2026-09-01T00:30:00.000Z" }],
      metadata: { invocation },
    };
    const result = await createVideoHarnessRunReceipt({ job: hosted, outcome, now: () => "2026-09-01T01:00:00.000Z" });
    assert.equal(result.receipt.outcome, "pass");
    assert.equal(result.receipt.schemaRevision, RUN_RECEIPT_SCHEMA_REVISION);
    assert.deepEqual(result.receipt.invocation.createdBy, invocation.createdBy);
    assert.deepEqual(result.receipt.invocation.resumedBy, invocation.resumedBy);
    assert.equal(result.receipt.timing.durationSeconds, 1800, "最後に doctor を始めてから Receipt を確定するまで");
    assert.equal(result.receipt.timing.receiptOnlyRetry, false);
    const written = JSON.parse(await readFile(result.path, "utf8"));
    assert.equal(verifyRunReceiptInvocation(written).ok, true, "書き出した Receipt の invocation は digest と合う");
    written.invocation.resumedBy[0].host = "claude-code";
    assert.deepEqual(verifyRunReceiptInvocation(written).failures, ["invocation-digest-mismatch"]);

    // ホストの記録が無い Job（この変更より前に作った Job）の Receipt は、作ったホストを推測しない。
    const plain = await createVideoHarnessRunReceipt({ job: job(root), outcome, now: () => "2026-09-01T01:00:00.000Z" });
    assert.equal(plain.receipt.invocation.createdBy, null);
    assert.equal(plain.receipt.timing.durationSeconds, null);
    // Receipt の確定だけをやり直す回は、人待ちを含むことを印で残す。
    const retried = await createVideoHarnessRunReceipt({
      job: { ...hosted, pendingReceiptFinalization: { version: "buzzassist-video-harness-pending-receipt-v1" } },
      outcome,
      now: () => "2026-09-02T00:00:00.000Z",
    });
    assert.equal(retried.receipt.timing.receiptOnlyRetry, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adapter自己申告がaudit reportと矛盾すれば拒否する", async () => {
  const root = await mkdtemp(join(tmpdir(), "video-receipt-conflict-"));
  try {
    const checks = { ...CHECKS, audioIntegratedLoudness: false };
    const outcome = await completedFixture(root, { checks });
    outcome.auditChecks = CHECKS;
    await assert.rejects(
      createVideoHarnessRunReceipt({ job: job(root), outcome }),
      /adapter outcomeの監査結果.*audit-reportと一致しない/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("audit reportの宣言SHAと実file SHAが違えば拒否する", async () => {
  const root = await mkdtemp(join(tmpdir(), "video-receipt-sha-"));
  try {
    const outcome = await completedFixture(root);
    outcome.artifacts[0].sha256 = "f".repeat(64);
    await assert.rejects(
      createVideoHarnessRunReceipt({ job: job(root), outcome }),
      /audit-report成果物のSHA-256が実fileと一致しない/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("audit reportが指したsignoff evidenceの実fileが変われば拒否する", async () => {
  const root = await mkdtemp(join(tmpdir(), "video-receipt-signoff-sha-"));
  try {
    const outcome = await completedFixture(root);
    await writeFile(join(root, "signoff.json"), JSON.stringify({
      version: "buzzassist-narrated-story-contact-sheet-signoff-v2",
      reviewer: "different-reviewer",
      reviewerContextId: "different-context",
      approved: true,
    }));
    await assert.rejects(
      createVideoHarnessRunReceipt({ job: job(root), outcome }),
      /signoffs\[0\]のevidence SHAが実fileと一致しない/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("narrated signoffは現行contract・現在の成果物SHA・別review contextにfail-closedで結合する", async (t) => {
  const cases = [
    ["旧contract", { signoffOverrides: { version: "buzzassist-narrated-story-contact-sheet-signoff-v0" } }, /signoff contract/u],
    ["採点の無いv1 signoff", { signoffOverrides: { version: "buzzassist-narrated-story-contact-sheet-signoff-v1" } }, /signoff contract/u],
    ["未承認", { signoffOverrides: { approved: false } }, /signoff contract/u],
    // 合格した回が別の signoff（別の回）のものなら、今の承認を合格の根拠にしない。
    ["品質ループの合格が別のsignoffに結合", { auditCheckOverrides: { qualityLoopPassed: { pass: true, signoffSha256: "e".repeat(64), videoSha256: "e".repeat(64), contactSheetSha256: "e".repeat(64), contractDigest: QUALITY_CONTRACT_DIGEST } } }, /auditChecks\.qualityLoopPassed/u],
    ["採点が別の品質契約", { signoffOverrides: { qualityReview: { contractDigest: "8".repeat(64), evaluatorContextId: "review-context-001", rubricScores: {}, notes: "別の契約の採点" } } }, /品質ループの契約/u],
    ["品質ループ未合格", { checks: { ...CHECKS, qualityLoopPassed: false } }, /auditChecks\.qualityLoopPassed/u],
    ["人物の同一性の採点が下限割れ", { signoffOverrides: { qualityReview: { contractDigest: QUALITY_CONTRACT_DIGEST, evaluatorContextId: "review-context-001", rubricScores: { "character-identity": 70 }, notes: "下限割れの採点" } } }, /人物の同一性/u],
    ["人物の同一性の採点が署名と違う", { signoffOverrides: { qualityReview: { contractDigest: QUALITY_CONTRACT_DIGEST, evaluatorContextId: "review-context-001", rubricScores: { "character-identity": 85 }, notes: "報告と違う採点" } } }, /人物の同一性/u],
    ["別video SHA", { signoffOverrides: { videoSha256: "e".repeat(64) } }, /final-video SHA/u],
    ["別contact sheet SHA", { signoffOverrides: { contactSheetSha256: "e".repeat(64) } }, /contact-sheet SHA/u],
    ["productionと同じcontext", {
      signoffOverrides: { reviewerContextId: job("/fixture").id },
    }, /production Jobと同じcontext/u],
    ["別Jobのaudit", { reportOverrides: { jobId: "video-narrated-story-video-bbbbbbbbbbbbbbbb" } }, /現在のJob/u],
    ["別videoを指すaudit", { reportOverrides: { videoSha256: "e".repeat(64) } }, /final-video SHA/u],
  ];
  for (const [name, fixtureOptions, expected] of cases) {
    await t.test(name, async () => {
      const root = await mkdtemp(join(tmpdir(), "video-receipt-signoff-binding-"));
      try {
        const outcome = await completedFixture(root, fixtureOptions);
        await assert.rejects(createVideoHarnessRunReceipt({ job: job(root), outcome }), expected);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

// R2-S1: narrated の completed は鍵で結合されていなかった（reviewerContextId の
// 自己申告比較だけ）。Koya と同じ信頼リスト・署名方式で閉じ、各迂回を別コードで落とす。
test("narrated signoffのreviewer attestationを共通finalizeで再検証し、署名無し・失効鍵・未登録鍵・別Job転用・本文改変・成果物差替え・信頼リスト未設定を拒否する", async (t) => {
  const cases = [
    ["署名無しの自作signoff（鍵を持たない端末）", { attest: "none" }, /reviewer-attestation-missing/u],
    ["失効前に署名された鍵", { attest: "revoked" }, /reviewer-key-revoked/u],
    ["信頼リストに無い鍵", { attest: "stranger" }, /reviewer-key-untrusted/u],
    ["別Jobへの署名を転用", { attest: "otherJob" }, /reviewer-attestation-subject-mismatch:jobId.*reviewer-attestation-subject-mismatch:identityDigest/u],
    ["署名後にapprovedを書き換え", {
      signoffOverrides: { approved: true },
      mutateAfterSigning: (signoff) => { signoff.findings = ["approved-by-editing"]; signoff.findings.length = 0; signoff.reviewedAt = "2026-09-02T00:00:00.000Z"; },
    }, /reviewer-attestation-subject-mismatch:signoffBodySha256/u],
    ["署名後にreviewerを別名へ書き換え", {
      mutateAfterSigning: (signoff) => { signoff.reviewer = "someone-else"; },
    }, /reviewer-attestation-subject-mismatch:(?:signoffBodySha256|reviewerId)/u],
    ["署名後にreviewerContextIdを書き換え", {
      mutateAfterSigning: (signoff) => { signoff.reviewerContextId = "review-context-999"; },
    }, /reviewer-attestation-subject-mismatch:(?:signoffBodySha256|reviewerContextId)/u],
    ["署名後にattestationのsignedAtを書き換え", {
      mutateAfterSigning: (signoff) => { signoff.reviewerAttestation.signedAt = "2026-09-03T00:00:00.000Z"; },
    }, /reviewer-attestation-signature-invalid/u],
    ["署名後にsigner keyIdを失効鍵へ差し替え", {
      mutateAfterSigning: (signoff) => { signoff.reviewerAttestation.signer.keyId = REVOKED_KEY.keyId; },
    }, /reviewer-key-revoked/u],
    ["attestationのversionをKoya版へ差し替え", {
      mutateAfterSigning: (signoff) => { signoff.reviewerAttestation.version = "koya-review-attestation-v1"; },
    }, /reviewer-attestation-version-unsupported/u],
    ["attestationを削除", {
      mutateAfterSigning: (signoff) => { delete signoff.reviewerAttestation; },
    }, /reviewer-attestation-missing/u],
  ];
  for (const [name, fixtureOptions, expected] of cases) {
    await t.test(name, async () => {
      const root = await mkdtemp(join(tmpdir(), "video-receipt-narrated-attestation-"));
      try {
        const outcome = await completedFixture(root, fixtureOptions);
        await assert.rejects(createVideoHarnessRunReceipt({ job: job(root), outcome }), expected);
        // attestation 以外の既存 gate を新たに落としていない（理由は attestation 系だけ）。
        await assert.rejects(createVideoHarnessRunReceipt({ job: job(root), outcome }), /reviewer attestationが無効/u);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
  await t.test("成果物を差し替えれば署名より先に既存SHA gateが落ちる（両方が独立に効く）", async () => {
    const root = await mkdtemp(join(tmpdir(), "video-receipt-narrated-attestation-swap-"));
    try {
      const outcome = await completedFixture(root);
      // 署名済み signoff・report はそのまま、contact sheet のbytesだけを別物に差し替える。
      const sheet = outcome.artifacts.find((entry) => entry.kind === "contact-sheet");
      const replaced = Buffer.from("another contact sheet");
      await writeFile(sheet.path, replaced);
      sheet.sha256 = sha256(replaced);
      sheet.bytes = replaced.length;
      await assert.rejects(createVideoHarnessRunReceipt({ job: job(root), outcome }), /contact-sheet SHA/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  await t.test("信頼リスト未設定ならnarratedもcompletedにしない（Koyaと同じfail-closed）", async () => {
    const root = await mkdtemp(join(tmpdir(), "video-receipt-narrated-trust-unconfigured-"));
    try {
      const outcome = await completedFixture(root);
      await assert.rejects(createVideoHarnessRunReceipt({ job: job(root), outcome, env: {} }), /reviewer-trust-unconfigured/u);
      // R5-1: Receipt の reviewerTrust 引数も env を無視できない。env 未設定 → unconfigured、別内容 → conflict。
      await assert.rejects(createVideoHarnessRunReceipt({ job: job(root), outcome, reviewerTrust: REVIEWER_TRUST, env: {} }), /reviewer-trust-unconfigured/u, "in-memory trust だけでは信頼アンカーにならない");
      await assert.rejects(createVideoHarnessRunReceipt({ job: job(root), outcome, reviewerTrust: STRANGER_TRUST }), /reviewer-trust-conflict/u, "env と別内容の trust object は conflict");
      const passing = await createVideoHarnessRunReceipt({ job: job(root), outcome, reviewerTrust: REVIEWER_TRUST });
      assert.equal(passing.receipt.outcome, "pass");
      assert.equal(passing.receipt.inputDigests.reviewerTrustSha256, sha256(REVIEWER_TRUST.sha256), "採られるのは env 側の信頼リスト");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  await t.test("別Jobのidentityで署名されたsignoffは、Job側のidentityDigestを差し替えても通らない", async () => {
    const root = await mkdtemp(join(tmpdir(), "video-receipt-narrated-identity-"));
    try {
      const outcome = await completedFixture(root);
      const forged = { ...job(root), identityDigest: "7".repeat(64) };
      await assert.rejects(createVideoHarnessRunReceipt({ job: forged, outcome }), /reviewer-attestation-subject-mismatch:identityDigest/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("report自身が必須監査集合を縮小しても拒否する", async () => {
  const root = await mkdtemp(join(tmpdir(), "video-receipt-audits-"));
  try {
    const outcome = await completedFixture(root, { requiredAuditIds: ["audioIntegratedLoudness"] });
    await assert.rejects(
      createVideoHarnessRunReceipt({ job: job(root), outcome }),
      /必須監査集合がHarness宣言と一致しない/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("必須artifact、Media Job、signoffの欠落をcompletedとして受理しない", async (t) => {
  const cases = [
    ["final-video", (outcome) => { outcome.artifacts = outcome.artifacts.filter((entry) => entry.kind !== "final-video"); }, /final-video/u],
    ["contact-sheet", (outcome) => { outcome.artifacts = outcome.artifacts.filter((entry) => entry.kind !== "contact-sheet"); }, /contact-sheet/u],
    ["audio", (outcome) => { outcome.artifacts = outcome.artifacts.filter((entry) => entry.kind !== "audio"); }, /audio/u],
    ["subtitle", (outcome) => { outcome.artifacts = outcome.artifacts.filter((entry) => entry.kind !== "subtitle"); }, /subtitle/u],
    ["bgm", (outcome) => { outcome.artifacts = outcome.artifacts.filter((entry) => entry.kind !== "bgm"); }, /bgm/u],
    ["media job", (outcome) => { outcome.mediaJobs = []; }, /Media Job roster/u],
  ];
  for (const [name, mutate, expected] of cases) {
    await t.test(name, async () => {
      const root = await mkdtemp(join(tmpdir(), "video-receipt-roster-"));
      try {
        const outcome = await completedFixture(root);
        mutate(outcome);
        await assert.rejects(createVideoHarnessRunReceipt({ job: job(root), outcome }), expected);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  await t.test("signoff", async () => {
    const root = await mkdtemp(join(tmpdir(), "video-receipt-signoff-"));
    try {
      const outcome = await completedFixture(root, { includeSignoff: false });
      await assert.rejects(
        createVideoHarnessRunReceipt({ job: job(root), outcome }),
        /独立signoff evidenceが無い/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("audit evidence無しのcompleted自己申告は拒否する", async () => {
  const root = await mkdtemp(join(tmpdir(), "video-receipt-missing-"));
  try {
    const audit = await artifact(root, "audit-report", "audit.json", "{}");
    await assert.rejects(
      createVideoHarnessRunReceipt({
        job: job(root),
        outcome: { status: "completed", artifacts: [audit] },
      }),
      /実測auditSteps\/auditChecksが無い/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// R3-4: attestation の形は harness id のハードコードではなく宣言 reviewAttestation.subject
// で決める。宣言が無い／未知の harness は completed にしない（fail-closed）。
test("signoff attestation dispatch is driven by the harness declaration and fails closed without reviewAttestation.subject", async (t) => {
  const HARNESS_DIR = fileURLToPath(new URL("../config/harnesses/", import.meta.url));
  const declarationOf = async (id) => JSON.parse(await readFile(join(HARNESS_DIR, `${id}.harness.json`), "utf8"));
  await t.test("shipped declarations name their attestation subject", async () => {
    for (const id of ["koya-manga-video", "narrated-story-video"]) {
      assert.equal((await declarationOf(id)).reviewAttestation?.subject, id, `${id}.harness.json must declare reviewAttestation.subject`);
    }
    const { _testing } = await import("../lib/videoHarnessReceipt.mjs");
    assert.throws(() => _testing.requiredAttestationSubject({ id: "x", guarantees: [] }), /reviewer-attestation-unsupported-harness/u);
    assert.throws(() => _testing.requiredAttestationSubject({ id: "x", reviewAttestation: { subject: "future-harness" } }), /reviewer-attestation-unsupported-harness/u);
    // R5-F2 / R5-3: 案内は「Job 作成前に宣言が要る・既存 Job は復旧不能・新 Job を作る」であり、
    // 「宣言を足して resume」（identity drift を招く）を指示しない。
    assert.throws(() => _testing.requiredAttestationSubject({ id: "x", guarantees: [] }), (error) => {
      assert.match(error.message, /Job 作成前に/u);
      assert.match(error.message, /復旧不能/u);
      assert.match(error.message, /新しい Job を作る/u);
      assert.match(error.message, /requestKey journal/u);
      assert.match(error.message, /canonical-identity-drift/u);
      assert.doesNotMatch(error.message, /宣言すること。宣言の無い/u, "宣言編集での復旧を促す旧文言を残さない");
      assert.doesNotMatch(error.message, /宣言を(?:足|追加|直)して(?:から)?\s*resume|drift を戻してから resume/u, "既存 Job の宣言編集＋resume を復旧経路として案内しない");
      return true;
    });
    assert.equal(_testing.requiredAttestationSubject({ id: "x", reviewAttestation: { subject: "narrated-story-video" } }), "narrated-story-video");
  });
  const cases = [
    ["宣言に reviewAttestation が無い", (declaration) => { delete declaration.reviewAttestation; }],
    ["宣言の subject が未知", (declaration) => { declaration.reviewAttestation = { subject: "future-harness" }; }],
    ["宣言の subject が空", (declaration) => { declaration.reviewAttestation = { subject: "" }; }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const root = await mkdtemp(join(tmpdir(), "video-receipt-declaration-"));
      try {
        const declarationsDir = join(root, "harnesses");
        await mkdir(declarationsDir, { recursive: true });
        const declaration = await declarationOf("narrated-story-video");
        mutate(declaration);
        await writeFile(join(declarationsDir, "narrated-story-video.harness.json"), JSON.stringify(declaration, null, 2));
        const outcome = await completedFixture(root);
        // 署名も信頼リストも正しいのに、宣言が無いだけで completed にならない。
        await assert.rejects(
          createVideoHarnessRunReceipt({ job: job(root), outcome, reviewerTrust: REVIEWER_TRUST, harnessDeclarationsDir: declarationsDir }),
          /reviewer-attestation-unsupported-harness/u,
        );
        // 同じ fixture は出荷宣言では pass する（宣言の欠落だけが原因）。
        const passing = await createVideoHarnessRunReceipt({ job: job(root), outcome, reviewerTrust: REVIEWER_TRUST });
        assert.equal(passing.receipt.outcome, "pass");
        assert.equal(passing.receipt.inputDigests.reviewerAttestationSubject, sha256("narrated-story-video"));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
  await t.test("a declaration cannot borrow another harness's subject: the signed jobId schema still rejects it", async () => {
    const root = await mkdtemp(join(tmpdir(), "video-receipt-declaration-borrow-"));
    try {
      const declarationsDir = join(root, "harnesses");
      await mkdir(declarationsDir, { recursive: true });
      const declaration = await declarationOf("narrated-story-video");
      declaration.reviewAttestation = { subject: "koya-manga-video" };
      await writeFile(join(declarationsDir, "narrated-story-video.harness.json"), JSON.stringify(declaration, null, 2));
      const outcome = await completedFixture(root);
      await assert.rejects(
        createVideoHarnessRunReceipt({ job: job(root), outcome, reviewerTrust: REVIEWER_TRUST, harnessDeclarationsDir: declarationsDir }),
        (error) => !/reviewer-attestation-unsupported-harness/u.test(String(error?.message)) && error instanceof Error,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("failed からの再開で完成した Job は、Job 層の再開記録を共通 RunReceipt に写す", async () => {
  const root = await mkdtemp(join(tmpdir(), "video-receipt-resume-"));
  try {
    const outcome = await completedFixture(root);
    const resumed = {
      ...job(root),
      resumeFromFailed: {
        version: "buzzassist-video-harness-failed-resume-v1",
        attempts: 1,
        resumedAt: "2026-09-01T00:00:00.000Z",
        previousFailure: {
          failedAt: "2026-08-31T23:00:00.000Z",
          failedStage: "production",
          error: "render crashed",
          blockers: [],
          knownRemainingIssues: ["render crashed"],
        },
        mediaJobRecovery: [{ requestKey: "req-r", jobId: "media-r", before: "recovery-required", after: "completed" }],
        mediaJobs: {
          reused: [{ requestKey: "req-a", jobId: "media-a", kind: "image", provider: "fixture", artifactSha256: "a".repeat(64) }],
          recovered: [{ requestKey: "req-r", jobId: "media-r", kind: "voice.synthesis", provider: "fixture", artifactSha256: "c".repeat(64) }],
          reissued: [],
          issued: [],
          carried: [],
        },
        history: [],
      },
    };
    const result = await createVideoHarnessRunReceipt({ job: resumed, outcome, now: () => "2026-09-01T00:00:00.000Z" });
    assert.equal(result.receipt.outcome, "pass");
    assert.equal(result.receipt.resumeFromFailed.attempts, 1);
    assert.equal(result.receipt.resumeFromFailed.previousFailure.failedStage, "production");
    assert.equal(result.receipt.resumeFromFailed.previousFailure.error, "render crashed");
    assert.equal(result.receipt.resumeFromFailed.mediaJobs.reused[0].requestKeyDigest, createHash("sha256").update("req-a").digest("hex"));
    assert.equal(result.receipt.resumeFromFailed.mediaJobs.recovered.length, 1);
    assert.deepEqual(result.receipt.resumeFromFailed.mediaJobRecovery.map((row) => row.after), ["completed"]);
    const written = JSON.parse(await readFile(result.path, "utf8"));
    assert.equal(written.resumeFromFailed.previousFailure.error, "render crashed", "書き出した Receipt にも残る");
    assert.equal(JSON.stringify(written).includes('"req-a"'), false, "requestKey の生値は Receipt に残さない");

    const plain = await createVideoHarnessRunReceipt({ job: job(root), outcome, now: () => "2026-09-01T00:00:00.000Z" });
    assert.equal(plain.receipt.resumeFromFailed, undefined, "再開していない Job の Receipt に再開記録を作らない");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("画像の失敗分を指紋迂回で作り直した Job は、その事実を共通 RunReceipt に 1 件写す（最新回が未使用でも history の最後の使用回）", async () => {
  const root = await mkdtemp(join(tmpdir(), "video-receipt-image-retry-"));
  try {
    const outcome = await completedFixture(root);
    const retriedFailed = { requested: true, jobIds: ["image:2"], count: 1, attempts: 2, completed: 1 };
    const retried = { ...job(root), imageRetry: { requested: true, retriedFailed }, imageSummary: { total: 3, complete: 3, failed: 0, reused: 2, paidImages: 3, attempts: 4, retriedFailed } };
    const result = await createVideoHarnessRunReceipt({ job: retried, outcome, now: () => "2026-09-01T00:00:00.000Z" });
    assert.equal(result.receipt.outcome, "pass");
    assert.deepEqual(result.receipt.imageRetry, {
      requested: true, jobIdDigests: [createHash("sha256").update("image:2").digest("hex")], count: 1, attempts: 2, completed: 1,
    });
    const written = JSON.parse(await readFile(result.path, "utf8"));
    assert.equal(written.imageRetry.attempts, 2, "再課金の回数が書き出した Receipt に残る");
    assert.equal(JSON.stringify(written).includes("image:2"), false);

    // 最新回は未使用でも、history に使用回があればその最後を写す。
    const historic = {
      ...job(root),
      imageRetry: { requested: false, retriedFailed: null },
      imageRetryHistory: [{ recordedAt: "2026-08-31T00:00:00.000Z", requested: true, retriedFailed: { ...retriedFailed, attempts: 5 } }],
    };
    const fromHistory = await createVideoHarnessRunReceipt({ job: historic, outcome, now: () => "2026-09-01T00:00:00.000Z" });
    assert.equal(fromHistory.receipt.imageRetry.attempts, 5);

    const plain = await createVideoHarnessRunReceipt({ job: { ...job(root), imageRetry: { requested: false, retriedFailed: null } }, outcome, now: () => "2026-09-01T00:00:00.000Z" });
    assert.equal(plain.receipt.imageRetry, undefined, "迂回引数を使っていない Job には作らない");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// 効力のあった契約で測る（共通 Receipt）。監査契約を上げたあとも、上げる前の版のまま確定を待っている
// Job は、その版の必須監査で確定する。宣言に足した保証は「当時は無かった」（not-in-force）であって、
// 未実施ではない。ただし今の版の Job（この宣言で計画された Job）は、足した保証の監査が要る。
// ---------------------------------------------------------------------------------------------

const NARRATED_DECLARATION_PATH = fileURLToPath(new URL("../config/harnesses/narrated-story-video.harness.json", import.meta.url));
const NARRATED_SERIES = "buzzassist-narrated-story-audit";

async function pastNarratedAudits(version) {
  const fixture = JSON.parse(await readFile(fileURLToPath(new URL("./fixtures/narrated-past-contract-audits.json", import.meta.url)), "utf8"));
  const entry = fixture.contracts.find((row) => row.version === version);
  if (!entry) throw new Error(`fixture has no ${version}`);
  return entry.requiredAudits;
}

// Job が計画されたときの宣言（canonicalIdentity に残る SHA）。今の宣言と同じなら「今の版の Job」。
function plannedJob(root, declarationSha256) {
  return {
    ...job(root),
    canonicalIdentity: { harnessDeclaration: { path: NARRATED_DECLARATION_PATH, sha256: declarationSha256 } },
  };
}

const OLDER_DECLARATION_SHA = "4".repeat(64);
const onlyChecks = (ids) => Object.fromEntries(ids.map((id) => [id, true]));

test("監査契約を上げる前の版で確定を待っている narrated Job は、共通 Receipt でもその版の必須監査で確定し、足した保証は not-in-force になる", async (t) => {
  const visual = ["burned-subtitles-legible", "camera-motion-declared", "episode-opening-provenance", "review-layout"];
  const cases = [
    // v5→v6 で見た目の実測の保証を足した。
    { version: `${NARRATED_SERIES}-v5`, notInForce: [...visual].sort() },
    { version: `${NARRATED_SERIES}-v4`, notInForce: ["asset-quality-loop", "scene-image-provenance", ...visual].sort() },
    // v3→v4 のときも同じ穴だった（人物の同一性の signoff 結合と声の監査を後から求めていた）。
    { version: `${NARRATED_SERIES}-v3`, notInForce: ["asset-quality-loop", "character-identity", "scene-image-provenance", "voice-quality", ...visual].sort() },
  ];
  for (const { version, notInForce } of cases) {
    await t.test(version, async () => {
      const root = await mkdtemp(join(tmpdir(), "video-receipt-past-contract-"));
      try {
        const audits = await pastNarratedAudits(version);
        // 実際の narrated の audit-report は requiredAuditIds を持たない。持っていても当時の一覧なら通る。
        for (const includeRequiredAuditIds of [false, true]) {
          const outcome = await completedFixture(root, {
            checks: onlyChecks(audits),
            requiredAuditIds: audits,
            includeRequiredAuditIds,
            reportOverrides: { contractVersion: version },
          });
          const result = await createVideoHarnessRunReceipt({ job: plannedJob(root, OLDER_DECLARATION_SHA), outcome, now: () => "2026-09-25T00:00:00.000Z" });
          assert.equal(result.receipt.outcome, "pass", JSON.stringify(result.receipt.summary));
          assert.deepEqual([...result.receipt.summary.notInForceGates].sort(), notInForce);
          for (const id of notInForce) assert.equal(result.receipt.gates[id].verdict, "skip", "測っていないものを pass と書かない");
          assert.equal(result.receipt.summary.skipped, 0);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("効力のある契約の必須監査が欠ければ、過去の版の Job でも今の版の Job でも共通 Receipt は落ちる", async (t) => {
  const declarationSha256 = sha256(await readFile(NARRATED_DECLARATION_PATH));
  const v4 = await pastNarratedAudits(`${NARRATED_SERIES}-v4`);
  const v5 = await pastNarratedAudits(`${NARRATED_SERIES}-v5`);
  const v6 = Object.keys(CHECKS);
  const cases = [
    ["v4 の Job で v4 の必須監査（声のテイク）が欠けた", plannedJob, OLDER_DECLARATION_SHA, `${NARRATED_SERIES}-v4`, v4.filter((id) => id !== "voiceTakeQuality")],
    ["v5 の Job で途中の成果物の品質ループの監査が欠けた", plannedJob, OLDER_DECLARATION_SHA, `${NARRATED_SERIES}-v5`, v5.filter((id) => id !== "sceneImageAssetLoopPassed")],
    ["v6 の Job で見た目の実測（カメラの動き）の監査が欠けた", plannedJob, declarationSha256, `${NARRATED_SERIES}-v6`, v6.filter((id) => id !== "cameraMotionMeasured")],
    // 今の宣言で計画された Job が、audit-report で古い版を名乗っても、宣言が書かれた版（v6）で測る。
    ["今の宣言で計画された Job が v5 を名乗った", plannedJob, declarationSha256, `${NARRATED_SERIES}-v5`, v5],
    ["今の宣言で計画された Job が v4 を名乗った", plannedJob, declarationSha256, `${NARRATED_SERIES}-v4`, v4],
    // 計画時の宣言の記録が無い Job は、今の宣言で計画されたものとして扱う（欠落を免除にしない）。
    ["計画時の宣言の記録が無い Job が v4 を名乗った", (root) => job(root), "", `${NARRATED_SERIES}-v4`, v4],
  ];
  for (const [name, makeJob, planned, version, audits] of cases) {
    await t.test(name, async () => {
      const root = await mkdtemp(join(tmpdir(), "video-receipt-in-force-missing-"));
      try {
        const outcome = await completedFixture(root, {
          checks: onlyChecks(audits),
          includeRequiredAuditIds: false,
          reportOverrides: { contractVersion: version },
        });
        await assert.rejects(
          createVideoHarnessRunReceipt({ job: makeJob(root, planned), outcome }),
          /共通RunReceiptがpassにならなかった/u,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
  await t.test("v6 の Job で全部の監査が揃えば合格し、対象外は無い", async () => {
    const root = await mkdtemp(join(tmpdir(), "video-receipt-in-force-current-"));
    try {
      const outcome = await completedFixture(root, { includeRequiredAuditIds: false, reportOverrides: { contractVersion: `${NARRATED_SERIES}-v6` } });
      const result = await createVideoHarnessRunReceipt({ job: plannedJob(root, declarationSha256), outcome });
      assert.equal(result.receipt.outcome, "pass");
      assert.equal(result.receipt.summary.notInForce, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  await t.test("過去の版の Job の report が、当時の必須監査より縮んだ一覧を名乗れば拒否する", async () => {
    const root = await mkdtemp(join(tmpdir(), "video-receipt-in-force-roster-"));
    try {
      const outcome = await completedFixture(root, {
        checks: onlyChecks(v4),
        requiredAuditIds: v4.filter((id) => id !== "voiceCastRouting"),
        reportOverrides: { contractVersion: `${NARRATED_SERIES}-v4` },
      });
      await assert.rejects(
        createVideoHarnessRunReceipt({ job: plannedJob(root, OLDER_DECLARATION_SHA), outcome }),
        /必須監査集合がHarness宣言と一致しない/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("漫画: Job に固定した制作契約（v53 でも v54 でも）の必須監査で測り、v53→v54 で確定待ちの Job を落とさない", async (t) => {
  const current = JSON.parse(await readFile(join(process.cwd(), "config/koya-manga-production-contract.json"), "utf8"));
  assert.equal(current.version, "koya-manga-production-v54", "この試験は v54 の契約を前提にしている（上げたら v54 を過去の版として足す）");
  const past = JSON.parse(await readFile(fileURLToPath(new URL("./fixtures/koya-past-contract-audits.json", import.meta.url)), "utf8"));
  // v53 の契約: 途中の成果物の品質ループの節（v54 から）が無く、必須監査は当時の一覧（asset-quality-loops が無い）。
  const v53 = structuredClone(current);
  v53.version = "koya-manga-production-v53";
  delete v53.assetQualityGate;
  v53.requiredAudits = [...past.contracts.find((entry) => entry.version === "koya-manga-production-v53").requiredAudits];
  assert.equal(v53.requiredAudits.includes("asset-quality-loops"), false);
  assert.equal(current.requiredAudits.includes("asset-quality-loops"), true, "v54 は途中の成果物の品質ループの監査を足した");
  for (const [name, contract, notInForce] of [["v53", v53, ["asset-quality-loops"]], ["v54", current, []]]) {
    await t.test(`${name} の契約に固定した Job は合格する`, async () => {
      const root = await mkdtemp(join(tmpdir(), `video-koya-contract-${name}-`));
      try {
        const contractPath = join(root, `koya-contract-${name}.json`);
        await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
        const fixture = await completedKoyaOuterFixture(root, { contractPath });
        assert.equal(fixture.job.resolvedProductionContract.contractVersion, contract.version);
        const result = await createVideoHarnessRunReceipt({ job: fixture.job, outcome: fixture.outcome });
        assert.equal(result.receipt.outcome, "pass", JSON.stringify(result.receipt.summary));
        assert.deepEqual(result.receipt.summary.notInForceGates, notInForce, "v54 で足した保証だけが v53 の Job で対象外");
        for (const id of notInForce) assert.equal(result.receipt.gates[id].verdict, "skip");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    await t.test(`${name} の契約に固定した Job で、契約の必須監査（wardrobe-readiness）を走らせなければ落ちる`, async () => {
      const root = await mkdtemp(join(tmpdir(), `video-koya-contract-${name}-missing-`));
      try {
        const contractPath = join(root, `koya-contract-${name}.json`);
        await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
        const fixture = await completedKoyaOuterFixture(root, { contractPath, omitAuditIds: ["wardrobe-readiness"] });
        await assert.rejects(
          createVideoHarnessRunReceipt({ job: fixture.job, outcome: fixture.outcome }),
          /必須監査集合がHarness宣言と一致しない[\s\S]*wardrobe-readiness/u,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
