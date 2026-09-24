import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  REVIEWER_TRUST_JSON_ENV,
  REVIEWER_TRUST_PATH_ENV,
  REVIEWER_TRUST_VERSION,
  createReviewerTrustEntry,
  generateReviewerKeyPair,
  normalizeReviewerTrust,
  verifyNarratedReviewSignoff,
} from "../lib/koyaReviewAttestation.mjs";
import {
  NARRATED_STORY_SIGNOFF_VERSION,
  narratedStoryRunPaths,
  writeNarratedReviewSignoff,
} from "../lib/narratedStoryPipeline.mjs";
import { signNarratedStoryVideoReview } from "../lib/narratedStoryVideo.mjs";
import { createNarratedQualityContract, narratedQualityReviewSheet } from "../lib/narratedStoryQualityLoop.mjs";

const execFile = promisify(execFileCallback);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO_ROOT, "scripts", "narrated-story-video.mjs");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const JOB_ID = "video-narrated-story-video-0123456789abcdef";
const IDENTITY_DIGEST = "5a".repeat(32);
const QUALITY_CONTRACT = createNarratedQualityContract();
const allScores = (score = 95) => Object.fromEntries(QUALITY_CONTRACT.rubric.map((criterion) => [criterion.id, score]));
const PASSING_REVIEW = Object.freeze({ rubricScores: allScores(95), notes: "全尺を通して見て、画と語りと字幕を確かめた", findings: [] });

async function fixtureProject() {
  const project = await mkdtemp(join(tmpdir(), "narrated-signoff-project-"));
  const outside = await mkdtemp(join(tmpdir(), "narrated-signoff-outside-"));
  const jobDir = join(project, "canvas", "harness-runs", JOB_ID);
  await mkdir(jobDir, { recursive: true });
  await writeFile(join(jobDir, "job.json"), JSON.stringify({
    id: JOB_ID,
    runDir: jobDir,
    projectDir: project,
    identityDigest: IDENTITY_DIGEST,
    harness: { id: "narrated-story-video" },
    status: "awaiting-human-review",
  }, null, 2));
  const paths = narratedStoryRunPaths({ deploymentRoot: project, jobId: JOB_ID });
  await mkdir(join(paths.runDir, "render"), { recursive: true });
  await mkdir(join(paths.runDir, "audit"), { recursive: true });
  const videoPath = join(paths.runDir, "render", "preview.mp4");
  const sheetPath = join(paths.runDir, "audit", "contact-sheet.png");
  await writeFile(videoPath, "fixture preview mp4 bytes");
  await writeFile(sheetPath, "fixture contact sheet bytes");
  await writeFile(paths.statePath, JSON.stringify({
    jobId: JOB_ID,
    phase: "awaiting-human-review",
    artifacts: {
      previewVideo: { path: videoPath, sha256: sha256("fixture preview mp4 bytes"), bytes: 25 },
      contactSheet: { path: sheetPath, sha256: sha256("fixture contact sheet bytes"), bytes: 27 },
    },
    // production が書く、reviewer が採点に使う品質契約の写し。
    review: { quality: narratedQualityReviewSheet(QUALITY_CONTRACT, paths.runDir) },
  }, null, 2));
  const reviewPath = join(outside, "review-scores.json");
  await writeFile(reviewPath, JSON.stringify(PASSING_REVIEW, null, 2));
  return { project, outside, paths, videoPath, sheetPath, reviewPath };
}

function trustFor(...entries) {
  return { version: REVIEWER_TRUST_VERSION, reviewers: entries };
}

test("writeNarratedReviewSignoff signs the reviewed MP4/contact sheet from disk with a trusted key and the Receipt-side verifier accepts it", async (t) => {
  const { project, outside, paths, videoPath, sheetPath } = await fixtureProject();
  const reviewer = generateReviewerKeyPair();
  const stranger = generateReviewerKeyPair();
  const trustRaw = trustFor(createReviewerTrustEntry({ publicKeyPem: reviewer.publicKeyPem, label: "fixture reviewer" }));
  const trust = normalizeReviewerTrust(trustRaw);
  const keyPath = join(outside, "reviewer.pem");
  await writeFile(keyPath, reviewer.privateKeyPem, { mode: 0o600 });
  const strangerKeyPath = join(outside, "stranger.pem");
  await writeFile(strangerKeyPath, stranger.privateKeyPem, { mode: 0o600 });
  const base = {
    deploymentRoot: project,
    jobId: JOB_ID,
    identityDigest: IDENTITY_DIGEST,
    reviewerHost: "codex",
    reviewerContextId: "review-task-independent-001",
    reviewerPrivateKeyPath: keyPath,
    // in-memory trust は照合用。信頼アンカーは env（inline JSON）。
    reviewerTrust: trust,
    env: { [REVIEWER_TRUST_JSON_ENV]: JSON.stringify(trustRaw) },
    review: PASSING_REVIEW,
    pass: true,
    signedAt: "2026-09-06T00:00:00.000Z",
  };
  try {
    await t.test("happy path binds Job truth and disk SHAs; the file is the canonical review path", async () => {
      const written = await writeNarratedReviewSignoff(base);
      assert.equal(written.outputPath, paths.signoffPath);
      assert.equal(written.signerKeyId, reviewer.keyId);
      assert.equal(written.videoSha256, sha256("fixture preview mp4 bytes"));
      assert.equal(written.contactSheetSha256, sha256("fixture contact sheet bytes"));
      const onDisk = JSON.parse(await readFile(paths.signoffPath, "utf8"));
      assert.equal(onDisk.version, NARRATED_STORY_SIGNOFF_VERSION);
      assert.equal(onDisk.reviewer, "codex:review-task-independent-001");
      assert.equal(onDisk.reviewerContextId, "review-task-independent-001");
      assert.equal(onDisk.approved, true);
      assert.equal(onDisk.originalDetailReviewed, true);
      assert.deepEqual(onDisk.findings, []);
      assert.deepEqual(onDisk.knownRemainingIssues, []);
      // 採点は品質契約に結合され、評価文脈は reviewer の文脈そのもの。署名は採点ごと覆う。
      assert.equal(onDisk.qualityReview.contractDigest, QUALITY_CONTRACT.digest);
      assert.equal(onDisk.qualityReview.evaluatorContextId, "review-task-independent-001");
      assert.deepEqual(onDisk.qualityReview.rubricScores, allScores(95));
      assert.equal(onDisk.reviewerAttestation.signer.keyId, reviewer.keyId);
      const verified = verifyNarratedReviewSignoff(onDisk, {
        jobId: JOB_ID,
        identityDigest: IDENTITY_DIGEST,
        videoSha256: sha256("fixture preview mp4 bytes"),
        contactSheetSha256: sha256("fixture contact sheet bytes"),
        trust,
      });
      assert.deepEqual(verified.failures, []);
      assert.equal(verified.pass, true);
      // 別 Job / 別成果物には結合されない。
      assert.ok(verifyNarratedReviewSignoff(onDisk, { jobId: JOB_ID, identityDigest: "7".repeat(64), videoSha256: sha256("fixture preview mp4 bytes"), contactSheetSha256: sha256("fixture contact sheet bytes"), trust }).failures.includes("reviewer-attestation-subject-mismatch:identityDigest"));
      assert.ok(verifyNarratedReviewSignoff(onDisk, { jobId: JOB_ID, identityDigest: IDENTITY_DIGEST, videoSha256: "9".repeat(64), contactSheetSha256: sha256("fixture contact sheet bytes"), trust }).failures.includes("reviewer-attestation-subject-mismatch:videoSha256"));
    });
    await t.test("refuses to overwrite an existing signoff unless force is given", async () => {
      await assert.rejects(writeNarratedReviewSignoff(base), /^Error: signoff-exists/u);
      const rewritten = await writeNarratedReviewSignoff({ ...base, force: true, reviewerContextId: "review-task-independent-002" });
      assert.equal(JSON.parse(await readFile(rewritten.outputPath, "utf8")).reviewerContextId, "review-task-independent-002");
    });
    await t.test("refuses the production Job's own context, missing identityDigest, untrusted keys, unconfigured trust, and pass=false", async () => {
      const other = { ...base, outputPath: join(outside, "other-signoff.json") };
      await assert.rejects(writeNarratedReviewSignoff({ ...other, reviewerContextId: JOB_ID }), /independent-reviewer-context/u);
      await assert.rejects(writeNarratedReviewSignoff({ ...other, reviewerContextId: `production:${JOB_ID}` }), /independent-reviewer-context/u);
      await assert.rejects(writeNarratedReviewSignoff({ ...other, reviewerContextId: "short" }), /reviewer-context-id/u);
      await assert.rejects(writeNarratedReviewSignoff({ ...other, identityDigest: "" }), /reviewer-attestation-expected-subject-unavailable:identityDigest/u);
      await assert.rejects(writeNarratedReviewSignoff({ ...other, identityDigest: IDENTITY_DIGEST.toUpperCase() }), /reviewer-attestation-expected-subject-unavailable:identityDigest/u);
      await assert.rejects(writeNarratedReviewSignoff({ ...other, reviewerPrivateKeyPath: strangerKeyPath }), /^Error: reviewer-key-untrusted/u);
      await assert.rejects(writeNarratedReviewSignoff({ ...other, reviewerTrust: null, env: {} }), /reviewer-trust-unconfigured/u);
      await assert.rejects(writeNarratedReviewSignoff({ ...other, env: {} }), /reviewer-trust-unconfigured/u, "in-memory trust だけでは信頼アンカーにならない");
      const selfMinted = normalizeReviewerTrust(trustFor(createReviewerTrustEntry({ publicKeyPem: stranger.publicKeyPem, label: "self-minted" })));
      await assert.rejects(writeNarratedReviewSignoff({ ...other, reviewerPrivateKeyPath: strangerKeyPath, reviewerTrust: selfMinted }), /^Error: reviewer-trust-conflict/u, "env と別内容の trust は conflict（自作リストで自分の鍵を通せない）");
      await assert.rejects(writeNarratedReviewSignoff({ ...other, pass: false }), /--pass/u);
      await assert.rejects(writeNarratedReviewSignoff({ ...other, pass: true, fail: true }), /exactly one of --pass/u);
      await assert.rejects(writeNarratedReviewSignoff({ ...other, reviewerHost: "human" }), /--reviewer must be claude or codex/u);
      await assert.rejects(writeNarratedReviewSignoff({ ...other, reviewerPrivateKeyPath: "" }), /reviewer-private-key-missing/u);
      await assert.rejects(stat(other.outputPath), (error) => error?.code === "ENOENT", "a refused signoff must not be written");
    });
    await t.test("the review must score every criterion of the Job's quality contract, and the verdict must agree with the findings", async () => {
      const other = { ...base, outputPath: join(outside, "scored-signoff.json") };
      await assert.rejects(writeNarratedReviewSignoff({ ...other, review: null }), /quality-review-required/u);
      const { "narration-voice": _omitted, ...missingVoice } = allScores(95);
      await assert.rejects(writeNarratedReviewSignoff({ ...other, review: { ...PASSING_REVIEW, rubricScores: missingVoice } }), /quality-review-scores-invalid: missing=narration-voice/u);
      await assert.rejects(writeNarratedReviewSignoff({ ...other, review: { ...PASSING_REVIEW, rubricScores: { ...allScores(95), extra: 90 } } }), /unknown=extra/u);
      await assert.rejects(writeNarratedReviewSignoff({ ...other, review: { ...PASSING_REVIEW, rubricScores: { ...allScores(95), "narration-voice": "90" } } }), /invalid=narration-voice/u);
      await assert.rejects(writeNarratedReviewSignoff({ ...other, review: { ...PASSING_REVIEW, notes: "" } }), /quality-review-notes-required/u);
      await assert.rejects(writeNarratedReviewSignoff({ ...other, review: { ...PASSING_REVIEW, findings: ["声が途中で変わる"] } }), /quality-review-findings-conflict/u, "承認なのに直す点が残る signoff は書かない");
      await assert.rejects(writeNarratedReviewSignoff({ ...other, pass: false, fail: true }), /quality-review-findings-required/u, "差し戻しは直す点が要る");
      await assert.rejects(stat(other.outputPath), (error) => error?.code === "ENOENT");
      // 差し戻しは approved: false と findings で書かれ、署名も通る（品質ループの1回になる）。
      const rejected = await writeNarratedReviewSignoff({
        ...other,
        pass: false,
        fail: true,
        reviewerContextId: "review-task-independent-009",
        review: { rubricScores: { ...allScores(95), "character-identity": 55 }, notes: "5場面目から主人公の顔が別人になる", findings: ["5場面目以降の主人公の顔を設定画に合わせる"] },
      });
      const onDisk = JSON.parse(await readFile(rejected.outputPath, "utf8"));
      assert.equal(onDisk.approved, false);
      assert.deepEqual(onDisk.findings, ["5場面目以降の主人公の顔を設定画に合わせる"]);
      assert.equal(onDisk.qualityReview.rubricScores["character-identity"], 55);
      assert.equal(verifyNarratedReviewSignoff(onDisk, {
        jobId: JOB_ID,
        identityDigest: IDENTITY_DIGEST,
        videoSha256: sha256("fixture preview mp4 bytes"),
        contactSheetSha256: sha256("fixture contact sheet bytes"),
        trust,
      }).pass, true);
      // 品質契約の写しが無い Job（production 前）では採点できない。
      const state = JSON.parse(await readFile(paths.statePath, "utf8"));
      await writeFile(paths.statePath, JSON.stringify({ ...state, review: {} }));
      try {
        await assert.rejects(writeNarratedReviewSignoff({ ...other, outputPath: join(outside, "no-contract.json") }), /quality-review-contract-unavailable/u);
      } finally {
        await writeFile(paths.statePath, JSON.stringify(state));
      }
    });
    await t.test("signNarratedStoryVideoReview reads identityDigest from the durable Job and rejects another harness's Job", async () => {
      const written = await signNarratedStoryVideoReview({
        ...base,
        identityDigest: undefined,
        projectDir: project,
        deploymentRoot: "",
        outputPath: join(outside, "from-job.json"),
        videoPath,
        contactSheetPath: sheetPath,
      });
      assert.equal(written.signoff.reviewerAttestation.subject.identityDigest, IDENTITY_DIGEST);
      assert.equal(written.signoff.reviewerAttestation.subject.jobId, JOB_ID);
      await assert.rejects(
        signNarratedStoryVideoReview({ ...base, projectDir: project, jobId: "video-narrated-story-video-ffffffffffffffff" }),
        /durable Job を読めない/u,
      );
      const koyaJobDir = join(project, "canvas", "harness-runs", "video-koya-manga-video-0123456789abcdef");
      await mkdir(koyaJobDir, { recursive: true });
      await writeFile(join(koyaJobDir, "job.json"), JSON.stringify({ id: "video-koya-manga-video-0123456789abcdef", identityDigest: IDENTITY_DIGEST, harness: { id: "koya-manga-video" } }));
      await assert.rejects(
        signNarratedStoryVideoReview({ ...base, projectDir: project, jobId: "video-koya-manga-video-0123456789abcdef" }),
        /not the requested narrated-story-video Job/u,
      );
    });
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("the real narrated CLI creates a reviewer key outside the repository and signs a signoff the verifier accepts", async (t) => {
  const { project, outside, paths, reviewPath } = await fixtureProject();
  try {
    const keyPath = join(outside, "keys", "reviewer-ed25519.pem");
    const created = JSON.parse((await execFile(process.execPath, [
      CLI, "reviewer-key-create", "--reviewer-key-path", keyPath, "--reviewer-label", "cli reviewer", "--project-dir", project,
    ], { windowsHide: true })).stdout);
    assert.equal(created.privateKeyPath, keyPath);
    assert.equal(created.publicKeyPath, `${keyPath}.pub`);
    assert.match(created.keyId, /^ed25519:[a-f0-9]{24}$/u);
    assert.equal(created.trustEntry.keyId, created.keyId);
    assert.equal(created.trustEntry.label, "cli reviewer");
    if (process.platform !== "win32") assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
    // 秘密鍵の中身は stdout に出ない。
    assert.doesNotMatch(JSON.stringify(created), /BEGIN PRIVATE KEY/u);

    await t.test("refuses keys inside the repository or the project dir", async () => {
      for (const forbidden of [join(REPO_ROOT, "reviewer.pem"), join(project, "reviewer.pem")]) {
        await assert.rejects(
          execFile(process.execPath, [CLI, "reviewer-key-create", "--reviewer-key-path", forbidden, "--project-dir", project], { windowsHide: true }),
          (error) => /reviewer-key-path-inside-repository/u.test(String(error?.stderr)) && error.code === 1,
        );
        await assert.rejects(stat(forbidden), (error) => error?.code === "ENOENT");
      }
      await assert.rejects(
        execFile(process.execPath, [CLI, "reviewer-key-create", "--reviewer-key-path", keyPath], { windowsHide: true }),
        (error) => /reviewer-key-path-exists/u.test(String(error?.stderr)),
      );
    });

    const trustPath = join(outside, "reviewer-trust.json");
    await writeFile(trustPath, JSON.stringify(trustFor(created.trustEntry), null, 2));
    const trust = normalizeReviewerTrust(JSON.parse(await readFile(trustPath, "utf8")));

    const noTrustEnv = { ...process.env, [REVIEWER_TRUST_PATH_ENV]: "", BUZZASSIST_REVIEWER_TRUST_JSON: "", BUZZASSIST_KOYA_REVIEWER_TRUST: "", BUZZASSIST_KOYA_REVIEWER_TRUST_JSON: "" };
    const operatorEnv = { ...noTrustEnv, [REVIEWER_TRUST_PATH_ENV]: trustPath };

    await t.test("signoff requires --pass or --fail, a key path and a review file, never key material on argv", async () => {
      await assert.rejects(
        execFile(process.execPath, [CLI, "signoff", "--job-id", JOB_ID, "--project-dir", project, "--reviewer", "codex", "--reviewer-context-id", "cli-review-task-0001", "--reviewer-key-path", keyPath, "--review-path", reviewPath, "--reviewer-trust-path", trustPath], { windowsHide: true, env: operatorEnv }),
        (error) => /--pass/u.test(String(error?.stderr)),
      );
      await assert.rejects(
        execFile(process.execPath, [CLI, "signoff", "--job-id", JOB_ID, "--project-dir", project, "--reviewer", "codex", "--reviewer-context-id", "cli-review-task-0001", "--review-path", reviewPath, "--reviewer-trust-path", trustPath, "--pass"], { windowsHide: true, env: operatorEnv }),
        (error) => /--reviewer-key-path/u.test(String(error?.stderr)),
      );
      await assert.rejects(
        execFile(process.execPath, [CLI, "signoff", "--job-id", JOB_ID, "--project-dir", project, "--reviewer", "codex", "--reviewer-context-id", "cli-review-task-0001", "--reviewer-key-path", keyPath, "--reviewer-trust-path", trustPath, "--pass"], { windowsHide: true, env: operatorEnv }),
        (error) => /--review-path/u.test(String(error?.stderr)),
        "採点ファイルの無い signoff は書かない",
      );
      await assert.rejects(stat(paths.signoffPath), (error) => error?.code === "ENOENT");
    });

    await t.test("--reviewer-trust-path alone is not a trust anchor: env unset → unconfigured, env differs → conflict", async () => {
      const selfMintedPath = join(outside, "self-minted-trust.json");
      await writeFile(selfMintedPath, JSON.stringify(trustFor(createReviewerTrustEntry({ publicKeyPem: generateReviewerKeyPair().publicKeyPem, label: "self-minted" })), null, 2));
      const signoffArgs = [CLI, "signoff", "--job-id", JOB_ID, "--project-dir", project, "--reviewer", "codex", "--reviewer-context-id", "cli-review-task-0001", "--reviewer-key-path", keyPath, "--review-path", reviewPath, "--pass"];
      await assert.rejects(
        execFile(process.execPath, [...signoffArgs, "--reviewer-trust-path", trustPath], { windowsHide: true, env: noTrustEnv }),
        (error) => /reviewer-trust-unconfigured/u.test(String(error?.stderr)) && !String(error?.stderr).includes("reviewer-trust.json"),
        "正しい内容の path でも env 未設定なら fail-closed（path 文字列は stderr の理由コード行に載らない）",
      );
      await assert.rejects(
        execFile(process.execPath, [...signoffArgs, "--reviewer-trust-path", selfMintedPath], { windowsHide: true, env: operatorEnv }),
        (error) => /reviewer-trust-conflict/u.test(String(error?.stderr)),
        "env あり + 別内容の path は conflict",
      );
      await assert.rejects(stat(paths.signoffPath), (error) => error?.code === "ENOENT");
    });

    await t.test("signoff with an explicit trust path that matches the operator env writes a verifiable signed signoff into the Job workspace", async () => {
      const { stdout } = await execFile(process.execPath, [
        CLI, "signoff",
        "--job-id", JOB_ID,
        "--project-dir", project,
        "--reviewer", "codex",
        "--reviewer-context-id", "cli-review-task-0001",
        "--reviewer-key-path", keyPath,
        "--reviewer-trust-path", trustPath,
        "--review-path", reviewPath,
        "--pass",
      ], { windowsHide: true, env: operatorEnv });
      const printed = JSON.parse(stdout);
      assert.equal(printed.outputPath, paths.signoffPath);
      assert.equal(printed.reviewerKeyId, created.keyId);
      assert.equal(printed.reviewer, "codex:cli-review-task-0001");
      const signoff = JSON.parse(await readFile(paths.signoffPath, "utf8"));
      const verified = verifyNarratedReviewSignoff(signoff, {
        jobId: JOB_ID,
        identityDigest: IDENTITY_DIGEST,
        videoSha256: sha256("fixture preview mp4 bytes"),
        contactSheetSha256: sha256("fixture contact sheet bytes"),
        trust,
      });
      assert.deepEqual(verified.failures, []);
      assert.equal(verified.signerKeyId, created.keyId);
      assert.equal(verified.reviewerLabel, "cli reviewer");
    });

    await t.test("signoff resolves the trust list from the environment when --reviewer-trust-path is absent, and fails closed without it", async () => {
      const outputPath = join(outside, "env-signoff.json");
      await assert.rejects(
        execFile(process.execPath, [CLI, "signoff", "--job-id", JOB_ID, "--project-dir", project, "--reviewer", "claude", "--reviewer-context-id", "cli-review-session-0002", "--reviewer-key-path", keyPath, "--review-path", reviewPath, "--signoff-path", outputPath, "--pass"], {
          windowsHide: true,
          env: { ...process.env, [REVIEWER_TRUST_PATH_ENV]: "", BUZZASSIST_REVIEWER_TRUST_JSON: "", BUZZASSIST_KOYA_REVIEWER_TRUST: "", BUZZASSIST_KOYA_REVIEWER_TRUST_JSON: "" },
        }),
        (error) => /reviewer-trust-unconfigured/u.test(String(error?.stderr)),
      );
      await assert.rejects(stat(outputPath), (error) => error?.code === "ENOENT");
      await execFile(process.execPath, [CLI, "signoff", "--job-id", JOB_ID, "--project-dir", project, "--reviewer", "claude", "--reviewer-context-id", "cli-review-session-0002", "--reviewer-key-path", keyPath, "--review-path", reviewPath, "--signoff-path", outputPath, "--pass"], {
        windowsHide: true,
        env: { ...process.env, [REVIEWER_TRUST_PATH_ENV]: trustPath },
      });
      const signoff = JSON.parse(await readFile(outputPath, "utf8"));
      assert.equal(signoff.reviewerAttestation.signer.keyId, created.keyId);
      assert.equal(verifyNarratedReviewSignoff(signoff, {
        jobId: JOB_ID,
        identityDigest: IDENTITY_DIGEST,
        videoSha256: sha256("fixture preview mp4 bytes"),
        contactSheetSha256: sha256("fixture contact sheet bytes"),
        trust,
      }).pass, true);
    });

    await t.test("--help advertises both reviewer commands", async () => {
      const { stdout } = await execFile(process.execPath, [CLI, "--help"], { windowsHide: true });
      assert.match(stdout, /reviewer-key-create --reviewer-key-path/u);
      assert.match(stdout, /signoff --job-id ID --project-dir DIR --reviewer claude\|codex/u);
      assert.match(stdout, /--review-path REVIEW\.json/u);
      assert.match(stdout, /--pass\|--fail/u);
      assert.match(stdout, /--reviewer-trust-path JSON/u);
      assert.match(stdout, new RegExp(REVIEWER_TRUST_PATH_ENV, "u"));
      assert.match(stdout, /BUZZASSIST_REVIEWER_TRUST \(legacy alias BUZZASSIST_KOYA_REVIEWER_TRUST/u, "新名を主、旧名は互換として表記");
      assert.match(stdout, /--reviewer-trust-path is a cross-check/u);
      assert.doesNotMatch(stdout, /trust list from --reviewer-trust-path or/u);
    });
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
