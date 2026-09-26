// 解説動画のハーネス（explainer-video）の人の確認（全編の試聴と初見の評価）の試験。
// 評価者の名前・文脈 id・鍵・動画はすべて合成の値（鍵はこの試験の中で作り、一時フォルダにだけ置く）。
// signoff の記録、署名の改ざん・別の MP4 への署名・評価者が生成の文脈と同じ・サムネのループ未合格のときは
// completed にならないこと、全部揃えば completed に確定すること（共通の RunReceipt が検証し直す）を見る。

import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EXPLAINER_QUALITY_LIMIT_DEFAULTS,
  EXPLAINER_REVIEW_SHEET_FORBIDDEN_KEYS,
  createExplainerVideoQualityContract,
  explainerVideoReviewSheet,
  explainerVideoScoringTemplate,
} from "../lib/explainerQualityLoop.mjs";
import {
  EXPLAINER_HUMAN_REVIEW_ISSUE,
  EXPLAINER_HUMAN_REVIEW_WAITING_ISSUE,
  EXPLAINER_SIGNOFF_VERSION,
  explainerReviewPaths,
  writeExplainerReviewSignoff,
} from "../lib/explainerVideo.mjs";
import {
  REVIEWER_TRUST_PATH_ENV,
  createExplainerReviewAttestationSubject,
  createNarratedReviewAttestationSubject,
  createReviewAttestation,
  createReviewerTrustEntry,
  generateReviewerKeyPair,
  narratedSignoffBodySha256,
  narratedSignoffReviewer,
  normalizeReviewerTrust,
  signExplainerReviewSignoff,
  verifyExplainerReviewSignoff,
  verifyReviewAttestation,
} from "../lib/koyaReviewAttestation.mjs";
import { SCRIPT_QUALITY_GENRES } from "../lib/scriptQualityLoop.mjs";
import { createVideoHarnessRunReceipt } from "../lib/videoHarnessReceipt.mjs";
import { passKoyaAssetQualityLoop } from "./helpers/koyaAssetQualityFixture.mjs";
import {
  createFixture,
  makeVideo,
  needsFfmpeg,
  packPayload,
  runJob,
  sha256,
  signPack,
} from "./helpers/explainerFixture.mjs";
import { acceptScriptForTests } from "./helpers/scriptQualityAcceptance.mjs";

const REVIEWER = generateReviewerKeyPair();
const STRANGER = generateReviewerKeyPair();
const trustRaw = () => ({
  version: "koya-reviewer-trust-v1",
  reviewers: [createReviewerTrustEntry({ publicKeyPem: REVIEWER.publicKeyPem, label: "synthetic-listener" })],
});
const TRUST = normalizeReviewerTrust(trustRaw());
const JOB = Object.freeze({ id: "video-explainer-video-0123456789abcdef", identityDigest: "a".repeat(64) });
const SHAS = Object.freeze({ videoSha256: "b".repeat(64), contactSheetSha256: "c".repeat(64), deliverySha256: "d".repeat(64) });

function signoffBody(overrides = {}) {
  return {
    version: EXPLAINER_SIGNOFF_VERSION,
    jobId: JOB.id,
    reviewer: "synthetic-listener",
    reviewerKind: "human",
    reviewerContextId: "ctx-synthetic-listen-1",
    approved: true,
    fullLengthViewed: true,
    ...SHAS,
    findings: [],
    knownRemainingIssues: [],
    qualityReview: { contractDigest: "e".repeat(64), rubricScores: {}, notes: "合成の所見", evaluatorContextId: "ctx-synthetic-listen-1" },
    reviewedAt: "2026-09-26T00:00:00.000Z",
    ...overrides,
  };
}

function scoresFor(contract, value = 95) {
  return Object.fromEntries(contract.rubric.map((criterion) => [criterion.id, value]));
}

test("解説動画の署名の subject は、Job・完成 MP4・contact sheet・納品の記録・signoff の本文に結び付き、どれを変えても落ちる", async () => {
  const signed = await signExplainerReviewSignoff({ signoff: signoffBody(), jobId: JOB.id, identityDigest: JOB.identityDigest, privateKeyPem: REVIEWER.privateKeyPem, trust: TRUST });
  assert.equal(signed.reviewerAttestation.version, "explainer-video-review-attestation-v1");
  assert.equal(signed.reviewerAttestation.subject.harnessId, "explainer-video");
  const truth = { jobId: JOB.id, identityDigest: JOB.identityDigest, ...SHAS, trust: TRUST };
  assert.equal(verifyExplainerReviewSignoff(signed, truth).pass, true);
  const cases = [
    ["別の MP4 への署名", signed, { ...truth, videoSha256: "9".repeat(64) }, "reviewer-attestation-subject-mismatch:videoSha256"],
    ["別の納品の記録への署名", signed, { ...truth, deliverySha256: "9".repeat(64) }, "reviewer-attestation-subject-mismatch:deliverySha256"],
    ["contact sheet の差し替え", signed, { ...truth, contactSheetSha256: "9".repeat(64) }, "reviewer-attestation-subject-mismatch:contactSheetSha256"],
    ["承認を後から書き換え", { ...signed, approved: false }, truth, "reviewer-attestation-subject-mismatch:signoffBodySha256"],
    ["点数を後から書き換え", { ...signed, qualityReview: { ...signed.qualityReview, notes: "書き換えた所見" } }, truth, "reviewer-attestation-subject-mismatch:signoffBodySha256"],
    ["信頼リストに無い鍵", await signExplainerReviewSignoff({ signoff: signoffBody(), jobId: JOB.id, identityDigest: JOB.identityDigest, privateKeyPem: STRANGER.privateKeyPem, trust: normalizeReviewerTrust({ version: "koya-reviewer-trust-v1", reviewers: [createReviewerTrustEntry({ publicKeyPem: STRANGER.publicKeyPem })] }) }), truth, "reviewer-key-untrusted"],
    ["別の Job", signed, { ...truth, jobId: "video-explainer-video-fedcba9876543210" }, "reviewer-attestation-subject-mismatch:jobId"],
  ];
  for (const [name, doc, expectation, code] of cases) {
    const result = verifyExplainerReviewSignoff(doc, expectation);
    assert.equal(result.pass, false, name);
    assert.ok(result.failures.includes(code), `${name}: ${JSON.stringify(result.failures)}`);
  }
  // ナレーション物語の署名を解説動画の期待で検証しても通らない（subject の形が違う）。
  const narratedSubject = createNarratedReviewAttestationSubject({
    jobId: "video-narrated-story-video-0123456789abcdef",
    identityDigest: JOB.identityDigest,
    videoSha256: SHAS.videoSha256,
    contactSheetSha256: SHAS.contactSheetSha256,
    signoffBodySha256: narratedSignoffBodySha256(signoffBody()),
    reviewer: narratedSignoffReviewer(signoffBody()),
  });
  const narrated = await createReviewAttestation({ subject: narratedSubject, privateKeyPem: REVIEWER.privateKeyPem, trust: TRUST });
  const explainerSubject = createExplainerReviewAttestationSubject({
    jobId: JOB.id,
    identityDigest: JOB.identityDigest,
    ...SHAS,
    signoffBodySha256: narratedSignoffBodySha256(signoffBody()),
    reviewer: narratedSignoffReviewer(signoffBody()),
  });
  const crossed = verifyReviewAttestation(narrated, { expectedSubject: explainerSubject, trust: TRUST });
  assert.equal(crossed.pass, false);
  assert.ok(crossed.failures.includes("reviewer-attestation-version-unsupported"));
});

test("完成動画の評価項目は共通の解説動画の項目から作り、評価シートには合格点・下限・重みを載せない", () => {
  const contract = createExplainerVideoQualityContract();
  const common = new Map(SCRIPT_QUALITY_GENRES.explainer.rubric.map((row) => [row.id, row]));
  const ids = contract.rubric.map((criterion) => criterion.id);
  assert.ok(ids.includes("visual-narration-alignment") && ids.includes("pacing") && ids.includes("first-view-comprehension"));
  assert.ok(ids.includes("listenability"), "完成した音でしか分からない聞きやすさ");
  assert.ok(!ids.includes("evidence-scope"), "根拠の範囲は台本の品質ループで見る");
  for (const criterion of contract.rubric.filter((row) => row.id !== "listenability")) {
    assert.equal(criterion.label, common.get(criterion.id).label, criterion.id);
    assert.equal(criterion.minimumScore, common.get(criterion.id).minimumScore, criterion.id);
  }
  assert.equal(contract.limits.targetScore, EXPLAINER_QUALITY_LIMIT_DEFAULTS.targetScore);
  const sheet = explainerVideoReviewSheet(contract);
  const text = JSON.stringify(sheet);
  for (const key of EXPLAINER_REVIEW_SHEET_FORBIDDEN_KEYS) assert.ok(!text.includes(`"${key}"`), `評価シートに ${key} がある`);
  // 採点ファイルの雛形は評価シートとは別で、点は空（前の回の点を渡さない）。
  const template = explainerVideoScoringTemplate(contract);
  assert.deepEqual(Object.keys(template.rubricScores), ids);
  assert.ok(Object.values(template.rubricScores).every((value) => value === null));
  // 二者・回数固定のようなチャンネル専用の決まりは契約に無い。
  assert.equal(contract.acceptance, undefined);
});

/** この試験の中でだけ効く信頼リスト（運営者の環境変数を模す）と、評価者の鍵のファイル（一時フォルダ）。 */
async function withReviewerTrust(action) {
  const keyDir = await mkdtemp(path.join(tmpdir(), "explainer-reviewer-key-"));
  const keyPath = path.join(keyDir, "reviewer-ed25519.pem");
  await writeFile(keyPath, REVIEWER.privateKeyPem, { mode: 0o600 });
  const trustPath = path.join(keyDir, "reviewer-trust.json");
  await writeFile(trustPath, JSON.stringify(trustRaw()));
  const previous = process.env[REVIEWER_TRUST_PATH_ENV];
  process.env[REVIEWER_TRUST_PATH_ENV] = trustPath;
  try {
    return await action({ keyPath, keyDir });
  } finally {
    if (previous === undefined) delete process.env[REVIEWER_TRUST_PATH_ENV];
    else process.env[REVIEWER_TRUST_PATH_ENV] = previous;
    await rm(keyDir, { recursive: true, force: true });
  }
}

async function writeReview(dir, name, contract, { findings = [], value = 95 } = {}) {
  const file = path.join(dir, name);
  await writeFile(file, JSON.stringify({ rubricScores: scoresFor(contract, value), notes: "合成の所見: 最初から最後まで通して聞き、図と説明の対応を見た", findings }));
  return file;
}

test("Job: 人の確認が揃い、機械の監査とサムネのループが通れば completed に確定し、共通の RunReceipt が署名を検証し直す", needsFfmpeg, async () => {
  const fixture = await createFixture();
  const projectDir = path.join(fixture.base, "project");
  await mkdir(projectDir, { recursive: true });
  try {
    await withReviewerTrust(async ({ keyPath }) => {
      await acceptScriptForTests(fixture.scriptPath, { workDir: path.join(fixture.videoRoot, "production") });
      const { bundleDir, publicKeyPem } = await signPack(fixture, packPayload(fixture));
      const { run } = await runJob({ fixture, bundleDir, publicKeyPem, projectDir });
      const first = await run();
      assert.equal(first.status, "awaiting-human-review");
      assert.ok(first.knownRemainingIssues.some((issue) => issue.startsWith(EXPLAINER_HUMAN_REVIEW_ISSUE)));
      const workDir = path.join(first.runDir, "explainer");
      const paths = explainerReviewPaths(workDir);
      await access(paths.contactSheetPath);
      const sheet = JSON.parse(await readFile(paths.sheetPath, "utf8"));
      for (const key of EXPLAINER_REVIEW_SHEET_FORBIDDEN_KEYS) assert.ok(!JSON.stringify(sheet).includes(`"${key}"`), key);
      const template = JSON.parse(await readFile(paths.templatePath, "utf8"));
      assert.ok(Object.values(template.rubricScores).every((value) => value === null), "雛形の点は空");
      const contract = createExplainerVideoQualityContract();
      const reviewDir = path.join(fixture.base, "reviews");
      await mkdir(reviewDir, { recursive: true });

      // 評価者が生成の文脈と同じ・全編を見ていない signoff は書かない。
      const review1 = await writeReview(reviewDir, "r1.json", contract);
      const signoffArgs = { job: first, reviewerId: "synthetic-listener", reviewerPrivateKeyPath: keyPath, reviewPath: review1, pass: true, fullLengthViewed: true };
      await assert.rejects(writeExplainerReviewSignoff({ ...signoffArgs, reviewerContextId: `production:${first.id}` }), /independent-reviewer-context/u);
      await assert.rejects(writeExplainerReviewSignoff({ ...signoffArgs, reviewerContextId: "ctx-synthetic-listen-1", fullLengthViewed: false }), /full-length-viewing-required/u);

      // サムネのループが未合格の間は、署名が正しくても回を記録せず（回を消費しない）、completed にならない。
      const written = await writeExplainerReviewSignoff({ ...signoffArgs, reviewerContextId: "ctx-synthetic-listen-1" });
      assert.equal(written.signoff.approved, true);
      assert.equal(written.deliverySha256, sha256(await readFile(path.join(fixture.videoRoot, "out", "DELIVERY.json"))));
      const waiting = await run();
      assert.equal(waiting.status, "awaiting-human-review");
      assert.ok(waiting.knownRemainingIssues.includes("asset-quality-required:thumbnail:thumbnail:loop-not-started"), waiting.knownRemainingIssues.join(" / "));
      assert.ok(waiting.knownRemainingIssues.some((issue) => issue.startsWith(EXPLAINER_HUMAN_REVIEW_WAITING_ISSUE)));
      assert.equal(waiting.auditChecks.humanReviewSigned.pass, true);
      assert.equal(waiting.auditChecks.qualityLoopPassed.pass, false);
      await assert.rejects(access(path.join(workDir, "quality", "quality-loop-state.json")), "機械の監査が通る前に回を消費しない");
      assert.ok(!waiting.artifacts.some((row) => row.kind === "final-video"), "確定するまで完成 MP4 を成果物に載せない");

      // サムネのループを合格させて resume すると、同じ signoff で回が記録され、completed に確定する。
      await passKoyaAssetQualityLoop({ harnessId: "explainer-video", workDir: fixture.videoRoot, stage: "thumbnail", subjectId: "thumbnail", assetPath: "out/thumbnail.jpg" });
      const done = await run();
      assert.equal(done.status, "completed", JSON.stringify(done.knownRemainingIssues));
      assert.deepEqual(done.knownRemainingIssues, []);
      assert.deepEqual(
        done.artifacts.map((row) => row.kind).sort(),
        ["audit-report", "contact-sheet", "delivery-manifest", "final-video", "genre-run-receipt", "run-receipt"],
      );
      assert.equal(done.artifacts.find((row) => row.kind === "final-video").path, fixture.delivery.video.file, "元のファイルを指し、写さない");
      const receiptPath = done.artifacts.find((row) => row.kind === "run-receipt").path;
      const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
      assert.equal(receipt.outcome, "pass");
      assert.deepEqual(receipt.knownRemainingIssues, []);
      assert.match(String(receipt.inputDigests?.reviewerAttestationSubject || ""), /^[a-f0-9]{64}$/u, "署名の subject の種類を入力の digest に残す");
      assert.equal(receipt.approvals.length, 1);
      assert.equal(receipt.approvals[0].type, "human");
      assert.equal(receipt.gates["human-review-signed"].verdict, "pass");
      assert.equal(receipt.gates["quality-loop"].verdict, "pass");
      const state = JSON.parse(await readFile(path.join(workDir, "quality", "quality-loop-state.json"), "utf8"));
      assert.equal(state.status, "passed");
      assert.equal(state.rounds.length, 1);
      assert.ok(!JSON.stringify(receipt).includes("合成の台本の一文目"), "RunReceipt に台本の本文を残さない");

      // 共通の RunReceipt は、署名した MP4 と別の MP4 を完成品として渡されたら確定しない。
      const other = path.join(fixture.base, "other.mp4");
      await makeVideo(other, { color: "green" });
      const otherBytes = await readFile(other);
      const swapped = done.artifacts
        .filter((row) => row.kind !== "run-receipt")
        .map((row) => (row.kind === "final-video" ? { ...row, path: other, sha256: sha256(otherBytes), bytes: otherBytes.length } : row));
      await assert.rejects(
        createVideoHarnessRunReceipt({ job: { ...done, runDir: path.join(fixture.base, "receipt-probe") }, outcome: { status: "completed", artifacts: swapped, auditChecks: done.auditChecks, mediaJobs: [], knownRemainingIssues: [] } }),
        /現在のfinal-video SHAに結合されていない/u,
      );
    });
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("Job: 署名を改ざんした signoff・別の MP4 に署名した signoff・生成の文脈の評価では completed にならない", needsFfmpeg, async () => {
  const fixture = await createFixture();
  const projectDir = path.join(fixture.base, "project");
  await mkdir(projectDir, { recursive: true });
  try {
    await withReviewerTrust(async ({ keyPath }) => {
      await acceptScriptForTests(fixture.scriptPath, { workDir: path.join(fixture.videoRoot, "production") });
      await passKoyaAssetQualityLoop({ harnessId: "explainer-video", workDir: fixture.videoRoot, stage: "thumbnail", subjectId: "thumbnail", assetPath: "out/thumbnail.jpg" });
      const { bundleDir, publicKeyPem } = await signPack(fixture, packPayload(fixture));
      const { run } = await runJob({ fixture, bundleDir, publicKeyPem, projectDir });
      const first = await run();
      assert.equal(first.status, "awaiting-human-review");
      assert.deepEqual(first.knownRemainingIssues.filter((issue) => !issue.startsWith(EXPLAINER_HUMAN_REVIEW_ISSUE)), [], "人の確認だけが残る");
      const workDir = path.join(first.runDir, "explainer");
      const paths = explainerReviewPaths(workDir);
      const contract = createExplainerVideoQualityContract();
      const reviewDir = path.join(fixture.base, "reviews");
      await mkdir(reviewDir, { recursive: true });
      const review = await writeReview(reviewDir, "r.json", contract);
      const written = await writeExplainerReviewSignoff({ job: first, reviewerId: "synthetic-listener", reviewerContextId: "ctx-synthetic-listen-2", reviewerPrivateKeyPath: keyPath, reviewPath: review, pass: true, fullLengthViewed: true });

      // 1. 署名の後に本文（点数）を書き換えた。
      const tampered = { ...written.signoff, qualityReview: { ...written.signoff.qualityReview, rubricScores: scoresFor(contract, 100) } };
      await writeFile(paths.signoffPath, JSON.stringify(tampered));
      const afterTamper = await run();
      assert.equal(afterTamper.status, "awaiting-human-review");
      assert.equal(afterTamper.auditChecks.humanReviewSigned.pass, false);
      assert.ok(afterTamper.knownRemainingIssues.some((issue) => issue.includes("reviewer-attestation-subject-mismatch:signoffBodySha256")), afterTamper.knownRemainingIssues.join(" / "));

      // 2. 別の MP4 の SHA に正しく署名した（鍵は信頼リストにあるが、この Job の完成 MP4 ではない）。
      const trust = normalizeReviewerTrust(trustRaw());
      const otherVideo = await signExplainerReviewSignoff({
        signoff: { ...written.signoff, reviewerAttestation: undefined, videoSha256: "9".repeat(64) },
        jobId: first.id,
        identityDigest: first.identityDigest,
        privateKeyPath: keyPath,
        trust,
      });
      await writeFile(paths.signoffPath, JSON.stringify(otherVideo));
      const afterOther = await run();
      assert.equal(afterOther.status, "awaiting-human-review");
      assert.ok(afterOther.knownRemainingIssues.some((issue) => issue.includes("signoff-video-sha")), afterOther.knownRemainingIssues.join(" / "));

      // 3. 生成の文脈（production:<jobId>）を名乗る評価に正しく署名した（CLI を通さずに作っても受けない）。
      const sameContext = await signExplainerReviewSignoff({
        signoff: {
          ...written.signoff,
          reviewerAttestation: undefined,
          reviewerContextId: `production:${first.id}`,
          qualityReview: { ...written.signoff.qualityReview, evaluatorContextId: `production:${first.id}` },
        },
        jobId: first.id,
        identityDigest: first.identityDigest,
        privateKeyPath: keyPath,
        trust,
      });
      await writeFile(paths.signoffPath, JSON.stringify(sameContext));
      const afterSame = await run();
      assert.equal(afterSame.status, "awaiting-human-review");
      assert.ok(afterSame.knownRemainingIssues.some((issue) => issue.includes("independent-reviewer-context")), afterSame.knownRemainingIssues.join(" / "));
      await assert.rejects(access(path.join(workDir, "quality", "quality-loop-state.json")), "使えない signoff では回を記録しない");

      // 4. 評価者の差し戻し（--fail）は点数が高くても不合格の回（completed にならない）。
      const rejectReview = await writeReview(reviewDir, "reject.json", contract, { findings: ["合成の指摘: 3 章の図の数字と読み上げが違う"] });
      await writeExplainerReviewSignoff({ job: first, reviewerId: "synthetic-listener", reviewerContextId: "ctx-synthetic-listen-3", reviewerPrivateKeyPath: keyPath, reviewPath: rejectReview, fail: true, fullLengthViewed: true, force: true });
      const afterReject = await run();
      assert.equal(afterReject.status, "awaiting-human-review");
      assert.ok(afterReject.knownRemainingIssues.some((issue) => issue.startsWith("explainer-human-review-rejected")), afterReject.knownRemainingIssues.join(" / "));
      assert.ok(afterReject.knownRemainingIssues.some((issue) => issue.startsWith("quality-loop-round-1-not-passed")));
    });
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});
