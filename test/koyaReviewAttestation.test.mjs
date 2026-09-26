import test from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function tamperSignature(signature) {
  // 末尾を "AA" にする改変は Ed25519 の S 上位 bit が常に 0 のため no-op になり得る（実測6%）。
  // 先頭 32 byte（R）の 1 文字を必ず別の値に置き換えて、bytes が確実に変わるようにする。
  const index = 10;
  const replacement = signature[index] === "A" ? "B" : "A";
  return `${signature.slice(0, index)}${replacement}${signature.slice(index + 1)}`;
}

import { canonicalJson } from "../lib/channelPackEnvelope.mjs";
import { createKoyaOuterJobBinding } from "../lib/koyaOuterJobBinding.mjs";
import {
  KOYA_REVIEW_ATTESTATION_VERSION,
  KOYA_REVIEWER_TRUST_JSON_ENV,
  KOYA_REVIEWER_TRUST_PATH_ENV,
  KOYA_REVIEWER_TRUST_VERSION,
  NARRATED_REVIEW_ATTESTATION_SUBJECT_FIELDS,
  NARRATED_REVIEW_ATTESTATION_VERSION,
  REVIEW_ATTESTATION_HARNESS_IDS,
  REVIEWER_TRUST_JSON_ENV,
  REVIEWER_TRUST_PATH_ENV,
  REVIEWER_TRUST_VERSION,
  REVIEW_ATTESTATION_EXPECTED_SUBJECT_PREFIX,
  REVIEWER_TRUST_CONFLICT_CODE,
  REVIEWER_TRUST_UNCONFIGURED_CODE,
  REVIEWER_TRUST_UNREADABLE_CODE,
  assertReviewerKeyPathOutsideRepository,
  createKoyaReviewAttestation,
  createKoyaReviewAttestationSubject,
  createKoyaReviewerTrustEntry,
  createNarratedReviewAttestationSubject,
  createReviewAttestation,
  declaredReviewAttestationSubject,
  expectedSubjectFailureCodes,
  generateKoyaReviewerKeyPair,
  loadKoyaReviewerTrust,
  loadReviewerTrust,
  narratedSignoffBodySha256,
  narratedSignoffReviewer,
  normalizeKoyaReviewerTrust,
  reviewerTrustFailureCode,
  signNarratedReviewSignoff,
  trustedKoyaReviewerTrustFromEnvironment,
  trustedReviewerTrustFromEnvironment,
  verifyKoyaReviewAttestation,
  verifyNarratedReviewSignoff,
  verifyReviewAttestation,
  writeReviewerKeyPairFiles,
  REVIEWER_KEY_MATERIAL_VALUE_PATTERN,
  REVIEWER_KEY_OPTION_PATTERN,
  REVIEWER_TRUST_NO_ACTIVE_CODE,
  REVIEWER_TRUST_OPTION_PATTERN,
  activeReviewerCount,
  preflightReviewerTrust,
} from "../lib/koyaReviewAttestation.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const REVIEWER = generateKoyaReviewerKeyPair();
const REVOKED = generateKoyaReviewerKeyPair();
const STRANGER = generateKoyaReviewerKeyPair();

function trustRaw({ revokedActive = false } = {}) {
  const revokedEntry = createKoyaReviewerTrustEntry({ publicKeyPem: REVOKED.publicKeyPem, label: "leaked laptop" });
  return {
    version: KOYA_REVIEWER_TRUST_VERSION,
    reviewers: [
      createKoyaReviewerTrustEntry({ publicKeyPem: REVIEWER.publicKeyPem, label: "independent reviewer" }),
      revokedActive
        ? revokedEntry
        : { ...revokedEntry, status: "revoked", revokedAt: "2026-08-31T00:00:00.000Z", reason: "fixture: key holder reported the laptop stolen" },
    ],
  };
}

const TRUST = normalizeKoyaReviewerTrust(trustRaw());
const TRUST_BEFORE_REVOCATION = normalizeKoyaReviewerTrust(trustRaw({ revokedActive: true }));
const STRANGER_TRUST = normalizeKoyaReviewerTrust({
  version: KOYA_REVIEWER_TRUST_VERSION,
  reviewers: [createKoyaReviewerTrustEntry({ publicKeyPem: STRANGER.publicKeyPem })],
});

const BINDING = createKoyaOuterJobBinding({
  jobId: "video-koya-manga-video-aaaaaaaaaaaaaaaa",
  identityDigest: "a".repeat(64),
  // 英字を含む digest にしておく。全部数字だと toUpperCase が無変化で大小差し替えを測れない。
  executionIdentityDigest: "ab12".repeat(16),
  resolvedProductionContractSha256: "2".repeat(64),
});
const OTHER_BINDING = createKoyaOuterJobBinding({
  jobId: "video-koya-manga-video-eeeeeeeeeeeeeeee",
  identityDigest: "e".repeat(64),
  executionIdentityDigest: "3".repeat(64),
  resolvedProductionContractSha256: "4".repeat(64),
});
const REVIEWER_PROVENANCE = Object.freeze({ host: "codex", id: "codex:review-context-1", contextId: "review-context-1" });

function subjectFixture(overrides = {}) {
  return createKoyaReviewAttestationSubject({
    episodeId: "episode-1",
    outerJobBinding: BINDING,
    contractDigest: "d".repeat(64),
    videoSha256: "a".repeat(64),
    contactSheetSha256: "b".repeat(64),
    reviewNotesContentSha256: "c".repeat(64),
    reviewer: REVIEWER_PROVENANCE,
    ...overrides,
  });
}

/** 検証器の正規形検査を測るため、ライブラリの入力検査を通さずに署名を作る。 */
function rawSignedAttestation(subject, keyPair = REVIEWER, signedAt = "2026-09-01T00:00:00.000Z") {
  const body = {
    version: KOYA_REVIEW_ATTESTATION_VERSION,
    subject,
    signer: { algorithm: "Ed25519", keyId: keyPair.keyId },
    signedAt,
  };
  const signature = cryptoSign(null, Buffer.from(canonicalJson(body)), createPrivateKey(keyPair.privateKeyPem)).toString("base64url");
  return { ...body, signature };
}

test("reviewer attestation subject accepts only canonical values and rejects each drift with a field-level code", () => {
  const subject = subjectFixture();
  assert.equal(subject.jobId, BINDING.jobId);
  assert.equal(subject.outerJobBindingSha256, BINDING.bindingSha256);
  assert.equal(subject.reviewerContextId, "review-context-1");
  assert.throws(() => subjectFixture({ videoSha256: "A".repeat(64) }), /reviewer-attestation-expected-subject-noncanonical:videoSha256/u);
  assert.throws(() => subjectFixture({ contactSheetSha256: `${"b".repeat(64)} ` }), /reviewer-attestation-expected-subject-noncanonical:contactSheetSha256/u);
  assert.throws(() => subjectFixture({ reviewNotesContentSha256: "" }), /reviewer-attestation-expected-subject-noncanonical:reviewNotesContentSha256/u);
  assert.throws(() => subjectFixture({ episodeId: " episode-1" }), /reviewer-attestation-expected-subject-noncanonical:episodeId/u);
  assert.throws(() => subjectFixture({ reviewer: { ...REVIEWER_PROVENANCE, contextId: "short" } }), /reviewer-attestation-expected-subject-noncanonical:reviewerContextId/u);
  assert.throws(() => subjectFixture({ reviewer: { ...REVIEWER_PROVENANCE, host: "human" } }), /reviewer-attestation-expected-subject-noncanonical:reviewerHost/u);
  assert.throws(() => subjectFixture({ outerJobBinding: null }), /reviewer-attestation-expected-subject-invalid:outerJobBinding/u);
});

test("reviewer trust list rejects alias key ids, non-Ed25519 keys, duplicates, and undocumented revocations", () => {
  assert.equal(TRUST.reviewers.size, 2);
  assert.equal(TRUST.reviewers.get(REVIEWER.keyId).status, "active");
  assert.equal(TRUST.reviewers.get(REVOKED.keyId).status, "revoked");
  assert.match(TRUST.sha256, /^[a-f0-9]{64}$/u);
  const good = trustRaw();
  const aliased = structuredClone(good);
  aliased.reviewers[0].keyId = STRANGER.keyId;
  assert.throws(() => normalizeKoyaReviewerTrust(aliased), /reviewer-trust-invalid:reviewers\[0\]:key-id-fingerprint-mismatch/u);
  const duplicated = structuredClone(good);
  duplicated.reviewers.push(structuredClone(good.reviewers[0]));
  assert.throws(() => normalizeKoyaReviewerTrust(duplicated), /reviewer-trust-invalid:reviewers\[2\]:duplicate-key-id/u);
  const undocumented = structuredClone(good);
  delete undocumented.reviewers[1].reason;
  assert.throws(() => normalizeKoyaReviewerTrust(undocumented), /reviewer-trust-invalid:reviewers\[1\]:revocation-reason-missing/u);
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
  assert.throws(
    () => createKoyaReviewerTrustEntry({ publicKeyPem: ec.publicKey.export({ type: "spki", format: "pem" }) }),
    /reviewer-trust-invalid:entry:not-ed25519/u,
  );
  assert.throws(() => normalizeKoyaReviewerTrust({ version: "other", reviewers: [] }), /reviewer-trust-invalid:version-unsupported/u);
  assert.throws(() => normalizeKoyaReviewerTrust({ version: KOYA_REVIEWER_TRUST_VERSION, reviewers: [] }), /reviewer-trust-invalid:reviewers-empty/u);
  const badStatus = structuredClone(good);
  badStatus.reviewers[0].status = "trusted";
  assert.throws(() => normalizeKoyaReviewerTrust(badStatus), /reviewer-trust-invalid:reviewers\[0\]:status-invalid/u);
});

test("reviewer trust anchor: only the operator environment counts; explicit path / inline JSON / object are cross-checks and fail closed alone", async () => {
  const root = await mkdtemp(join(tmpdir(), "koya-reviewer-trust-"));
  try {
    const trustPath = join(root, "reviewer-trust.json");
    await writeFile(trustPath, JSON.stringify(trustRaw()));
    const otherPath = join(root, "self-minted-trust.json");
    await writeFile(otherPath, JSON.stringify({ version: REVIEWER_TRUST_VERSION, reviewers: [createKoyaReviewerTrustEntry({ publicKeyPem: STRANGER.publicKeyPem })] }));
    const OTHER = normalizeKoyaReviewerTrust(JSON.parse(await readFile(otherPath, "utf8")));
    const envPath = { [REVIEWER_TRUST_PATH_ENV]: trustPath };
    const envJson = { [KOYA_REVIEWER_TRUST_JSON_ENV]: JSON.stringify(trustRaw()) };

    // env が正: path env / inline env / 旧名 env のどれでも読める。
    assert.equal((await loadKoyaReviewerTrust({ env: envPath })).sha256, TRUST.sha256);
    assert.equal((await loadKoyaReviewerTrust({ env: envJson })).sha256, TRUST.sha256);
    assert.equal((await loadKoyaReviewerTrust({ env: { [KOYA_REVIEWER_TRUST_PATH_ENV]: trustPath } })).sha256, TRUST.sha256);

    // env 未設定: 明示入力があっても信頼アンカーは立たない（要求側だけで自己承認へ退化させない）。
    await assert.rejects(loadKoyaReviewerTrust({ env: {} }), new RegExp(`^Error: ${REVIEWER_TRUST_UNCONFIGURED_CODE}`, "u"));
    await assert.rejects(loadKoyaReviewerTrust({ trustPath, env: {} }), new RegExp(`^Error: ${REVIEWER_TRUST_UNCONFIGURED_CODE}`, "u"));
    await assert.rejects(loadKoyaReviewerTrust({ trustJson: JSON.stringify(trustRaw()), env: {} }), new RegExp(`^Error: ${REVIEWER_TRUST_UNCONFIGURED_CODE}`, "u"));
    await assert.rejects(loadKoyaReviewerTrust({ trust: TRUST, env: {} }), new RegExp(`^Error: ${REVIEWER_TRUST_UNCONFIGURED_CODE}`, "u"));
    await assert.rejects(loadKoyaReviewerTrust({ trust: trustRaw(), env: {} }), new RegExp(`^Error: ${REVIEWER_TRUST_UNCONFIGURED_CODE}`, "u"));
    assert.throws(() => trustedKoyaReviewerTrustFromEnvironment({}), /reviewer-trust-unconfigured/u);
    await assert.rejects(loadKoyaReviewerTrust({ trustPath, env: {} }), (error) => /照合にだけ使い/u.test(error.message) && !error.message.includes(root), "案内は照合用だと言い、path 文字列は載せない");

    // env あり + 一致する明示入力 → env 側を返す（写しではなく運営者側）。
    const agreedPath = await loadKoyaReviewerTrust({ trustPath, env: envPath });
    assert.equal(agreedPath.sha256, TRUST.sha256);
    assert.equal((await loadKoyaReviewerTrust({ trustJson: JSON.stringify(trustRaw()), env: envJson })).sha256, TRUST.sha256);
    assert.equal((await loadKoyaReviewerTrust({ trust: TRUST, env: envPath })).sha256, TRUST.sha256);
    assert.notEqual(await loadKoyaReviewerTrust({ trust: TRUST, env: envPath }), TRUST, "in-memory object をそのまま返さず env から読んだ方を返す");
    assert.equal((await loadKoyaReviewerTrust({ trust: trustRaw(), env: envPath })).sha256, TRUST.sha256);

    // env あり + 別内容の明示入力 → conflict（黙ってどちらかを採らない）。
    const conflict = new RegExp(`^Error: ${REVIEWER_TRUST_CONFLICT_CODE}`, "u");
    await assert.rejects(loadKoyaReviewerTrust({ trustPath: otherPath, env: envPath }), conflict);
    await assert.rejects(loadKoyaReviewerTrust({ trustJson: await readFile(otherPath, "utf8"), env: envPath }), conflict);
    await assert.rejects(loadKoyaReviewerTrust({ trust: OTHER, env: envPath }), conflict);
    await assert.rejects(loadKoyaReviewerTrust({ trust: JSON.parse(await readFile(otherPath, "utf8")), env: envJson }), conflict);
    await assert.rejects(loadKoyaReviewerTrust({ trustPath: otherPath, env: envPath }), (error) => !error.message.includes(root) && /sha256 [0-9a-f]{16}…/u.test(error.message), "conflict 文には sha だけ載り path は載らない");

    // 読めない / 壊れた file: env 側でも明示側でも理由コードで落ち、path 文字列は例外文に残さない（R5-4）。
    const missing = join(root, "missing.json");
    await assert.rejects(loadKoyaReviewerTrust({ env: { [REVIEWER_TRUST_PATH_ENV]: missing } }), (error) => new RegExp(`^${REVIEWER_TRUST_UNREADABLE_CODE}`, "u").test(error.message) && !error.message.includes("missing.json") && /ENOENT/u.test(error.message));
    await assert.rejects(loadKoyaReviewerTrust({ trustPath: missing, env: envPath }), (error) => new RegExp(`^${REVIEWER_TRUST_UNREADABLE_CODE}`, "u").test(error.message) && !error.message.includes("missing.json"));
    await writeFile(join(root, "broken.json"), "{not json");
    await assert.rejects(loadKoyaReviewerTrust({ trustPath: join(root, "broken.json"), env: envPath }), /reviewer-trust-invalid:json-unparseable/u);
    await assert.rejects(loadKoyaReviewerTrust({ env: { [REVIEWER_TRUST_PATH_ENV]: join(root, "broken.json") } }), /reviewer-trust-invalid:json-unparseable/u);
    assert.equal(reviewerTrustFailureCode(new Error("reviewer-trust-invalid:reviewers[0]:status-invalid")), "reviewer-trust-invalid:reviewers[0]:status-invalid");
    assert.equal(reviewerTrustFailureCode(new Error("reviewer-trust-unreadable: ENOENT")), "reviewer-trust-unreadable");
    assert.equal(reviewerTrustFailureCode(new Error("reviewer-trust-conflict: 明示した信頼リスト…")), "reviewer-trust-conflict");
    assert.equal(reviewerTrustFailureCode(new Error("something else")), "reviewer-trust-unconfigured");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a trusted reviewer signs the subject; the attestation verifies only against the trust list, never a bundled key", async () => {
  const subject = subjectFixture();
  const attestation = await createKoyaReviewAttestation({
    subject,
    privateKeyPem: REVIEWER.privateKeyPem,
    trust: TRUST,
    signedAt: "2026-09-01T00:00:00.000Z",
  });
  assert.equal(attestation.version, KOYA_REVIEW_ATTESTATION_VERSION);
  assert.equal(attestation.signer.keyId, REVIEWER.keyId);
  assert.equal(Object.hasOwn(attestation, "publicKeyPem"), false);
  const verified = verifyKoyaReviewAttestation(attestation, { expectedSubject: subject, trust: TRUST });
  assert.deepEqual(verified.failures, []);
  assert.equal(verified.pass, true);
  assert.equal(verified.signerKeyId, REVIEWER.keyId);
  assert.equal(verified.reviewerLabel, "independent reviewer");
  assert.equal(verified.trustSha256, TRUST.sha256);
  // 署名は決定的。同じ subject・同じ鍵・同じ時刻なら byte 単位で一致する。
  const again = await createKoyaReviewAttestation({ subject, privateKeyPem: REVIEWER.privateKeyPem, trust: TRUST, signedAt: "2026-09-01T00:00:00.000Z" });
  assert.equal(again.signature, attestation.signature);
});

test("signing refuses keys that are not active in the trust list and never takes key material from argv-like strings", async () => {
  const subject = subjectFixture();
  await assert.rejects(
    createKoyaReviewAttestation({ subject, privateKeyPem: STRANGER.privateKeyPem, trust: TRUST }),
    /^Error: reviewer-key-untrusted/u,
  );
  await assert.rejects(
    createKoyaReviewAttestation({ subject, privateKeyPem: REVOKED.privateKeyPem, trust: TRUST }),
    /^Error: reviewer-key-revoked/u,
  );
  await assert.rejects(
    createKoyaReviewAttestation({ subject, privateKeyPem: REVIEWER.privateKeyPem, trust: null }),
    /^Error: reviewer-trust-unconfigured/u,
  );
  await assert.rejects(
    createKoyaReviewAttestation({ subject, trust: TRUST }),
    /^Error: reviewer-private-key-missing/u,
  );
  await assert.rejects(
    createKoyaReviewAttestation({ subject, privateKeyPem: "not a pem", trust: TRUST }),
    /^Error: reviewer-private-key-invalid/u,
  );
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
  await assert.rejects(
    createKoyaReviewAttestation({ subject, privateKeyPem: ec.privateKey.export({ type: "pkcs8", format: "pem" }), trust: TRUST }),
    /^Error: reviewer-private-key-invalid/u,
  );
  await assert.rejects(
    createKoyaReviewAttestation({ subject: { ...subject, videoSha256: "A".repeat(64) }, privateKeyPem: REVIEWER.privateKeyPem, trust: TRUST }),
    /reviewer-attestation-subject-noncanonical:videoSha256/u,
  );
});

test("verification rejects revoked keys, untrusted keys, borrowed Jobs, tampered artifacts, missing attestations, and non-canonical spellings with distinct codes", async (t) => {
  const subject = subjectFixture();
  const good = await createKoyaReviewAttestation({ subject, privateKeyPem: REVIEWER.privateKeyPem, trust: TRUST, signedAt: "2026-09-01T00:00:00.000Z" });
  const signedBeforeRevocation = await createKoyaReviewAttestation({
    subject,
    privateKeyPem: REVOKED.privateKeyPem,
    trust: TRUST_BEFORE_REVOCATION,
    signedAt: "2026-08-01T00:00:00.000Z",
  });
  const byStranger = await createKoyaReviewAttestation({ subject, privateKeyPem: STRANGER.privateKeyPem, trust: STRANGER_TRUST });
  const forOtherJob = await createKoyaReviewAttestation({
    subject: subjectFixture({ outerJobBinding: OTHER_BINDING }),
    privateKeyPem: REVIEWER.privateKeyPem,
    trust: TRUST,
  });
  const cases = [
    ["attestation missing", undefined, ["reviewer-attestation-missing"]],
    ["attestation null", null, ["reviewer-attestation-missing"]],
    ["attestation not an object", "signed", ["reviewer-attestation-invalid"]],
    // 失効前の日付で署名されていても拒否する。signedAt は署名者の自己申告。
    ["key revoked after signing", signedBeforeRevocation, ["reviewer-key-revoked"]],
    ["unregistered key", byStranger, ["reviewer-key-untrusted"]],
    ["borrowed from another Job", forOtherJob, [
      "reviewer-attestation-subject-mismatch:jobId",
      "reviewer-attestation-subject-mismatch:identityDigest",
      "reviewer-attestation-subject-mismatch:executionIdentityDigest",
      "reviewer-attestation-subject-mismatch:resolvedProductionContractSha256",
      "reviewer-attestation-subject-mismatch:outerJobBindingSha256",
    ]],
    ["MP4 replaced after signing", await createKoyaReviewAttestation({ subject: subjectFixture({ videoSha256: "9".repeat(64) }), privateKeyPem: REVIEWER.privateKeyPem, trust: TRUST }), ["reviewer-attestation-subject-mismatch:videoSha256"]],
    ["contact sheet replaced after signing", await createKoyaReviewAttestation({ subject: subjectFixture({ contactSheetSha256: "9".repeat(64) }), privateKeyPem: REVIEWER.privateKeyPem, trust: TRUST }), ["reviewer-attestation-subject-mismatch:contactSheetSha256"]],
    ["review notes edited after signing", await createKoyaReviewAttestation({ subject: subjectFixture({ reviewNotesContentSha256: "9".repeat(64) }), privateKeyPem: REVIEWER.privateKeyPem, trust: TRUST }), ["reviewer-attestation-subject-mismatch:reviewNotesContentSha256"]],
    ["contract digest differs", await createKoyaReviewAttestation({ subject: subjectFixture({ contractDigest: "9".repeat(64) }), privateKeyPem: REVIEWER.privateKeyPem, trust: TRUST }), ["reviewer-attestation-subject-mismatch:contractDigest"]],
    ["reviewer context re-declared", await createKoyaReviewAttestation({ subject: subjectFixture({ reviewer: { ...REVIEWER_PROVENANCE, contextId: "review-context-2" } }), privateKeyPem: REVIEWER.privateKeyPem, trust: TRUST }), ["reviewer-attestation-subject-mismatch:reviewerContextId"]],
    ["trailing space in signed videoSha256", rawSignedAttestation({ ...subject, videoSha256: `${subject.videoSha256} ` }), [
      "reviewer-attestation-subject-noncanonical:videoSha256",
      "reviewer-attestation-subject-mismatch:videoSha256",
    ]],
    ["upper-cased signed contactSheetSha256", rawSignedAttestation({ ...subject, contactSheetSha256: subject.contactSheetSha256.toUpperCase() }), [
      "reviewer-attestation-subject-noncanonical:contactSheetSha256",
      "reviewer-attestation-subject-mismatch:contactSheetSha256",
    ]],
    ["upper-cased signed executionIdentityDigest", rawSignedAttestation({ ...subject, executionIdentityDigest: subject.executionIdentityDigest.toUpperCase() }), [
      "reviewer-attestation-subject-noncanonical:executionIdentityDigest",
      "reviewer-attestation-subject-mismatch:executionIdentityDigest",
    ]],
    ["extra field smuggled into the signed subject", rawSignedAttestation({ ...subject, note: "looks fine" }), ["reviewer-attestation-subject-noncanonical:note"]],
    ["signature bytes tampered", { ...good, signature: tamperSignature(good.signature) }, ["reviewer-attestation-signature-invalid"]],
    ["signature missing", { ...good, signature: "" }, ["reviewer-attestation-signature-invalid"]],
    ["signedAt rewritten after signing", { ...good, signedAt: "2026-09-02T00:00:00.000Z" }, ["reviewer-attestation-signature-invalid"]],
    ["subject rewritten after signing", { ...good, subject: { ...good.subject, videoSha256: subject.videoSha256 } , signature: forOtherJob.signature }, ["reviewer-attestation-signature-invalid"]],
    ["signer key id swapped to another trusted key", { ...good, signer: { ...good.signer, keyId: REVOKED.keyId } }, ["reviewer-key-revoked"]],
    ["signer algorithm changed", { ...good, signer: { ...good.signer, algorithm: "RSA" } }, ["reviewer-attestation-signer-invalid"]],
    ["version downgraded", { ...good, version: "koya-review-attestation-v0" }, ["reviewer-attestation-version-unsupported", "reviewer-attestation-signature-invalid"]],
  ];
  for (const [name, attestation, expectedFailures] of cases) {
    await t.test(name, () => {
      const result = verifyKoyaReviewAttestation(attestation, { expectedSubject: subject, trust: TRUST });
      assert.equal(result.pass, false);
      for (const code of expectedFailures) {
        assert.ok(result.failures.includes(code), `${name}: expected ${code} in ${JSON.stringify(result.failures)}`);
      }
    });
  }
  await t.test("trust list unconfigured", () => {
    const result = verifyKoyaReviewAttestation(good, { expectedSubject: subject, trust: null });
    assert.deepEqual(result.failures, ["reviewer-trust-unconfigured"]);
  });
  await t.test("expected subject itself must be canonical", () => {
    const result = verifyKoyaReviewAttestation(good, { expectedSubject: { ...subject, videoSha256: "A".repeat(64) }, trust: TRUST });
    assert.ok(result.failures.includes("reviewer-attestation-expected-subject-noncanonical:videoSha256"));
  });
  await t.test("the untouched attestation still verifies", () => {
    assert.equal(verifyKoyaReviewAttestation(good, { expectedSubject: subject, trust: TRUST }).pass, true);
  });
});

// ---------------------------------------------------------------------------
// R2-S1: narrated-story-video も同じ信頼リスト・同じ署名方式で reviewer を鍵に結合する。
// 1 つの finalizer の中に「署名が要る harness」と「自己申告で通る harness」を同居させない。
// ---------------------------------------------------------------------------

const NARRATED_JOB = Object.freeze({ id: "video-narrated-story-video-aaaaaaaaaaaaaaaa", identityDigest: "ab12".repeat(16) });
const OTHER_NARRATED_JOB = Object.freeze({ id: "video-narrated-story-video-eeeeeeeeeeeeeeee", identityDigest: "e".repeat(64) });

function narratedSignoffFixture(overrides = {}) {
  return {
    version: "buzzassist-narrated-story-contact-sheet-signoff-v1",
    reviewer: "independent-reviewer",
    reviewerContextId: "review-context-narrated-1",
    approved: true,
    originalDetailReviewed: true,
    videoSha256: "a".repeat(64),
    contactSheetSha256: "b".repeat(64),
    findings: [],
    knownRemainingIssues: [],
    ...overrides,
  };
}

test("narrated review attestation subject accepts only canonical values and never carries Koya-only fields", () => {
  const signoff = narratedSignoffFixture();
  const subject = createNarratedReviewAttestationSubject({
    jobId: NARRATED_JOB.id,
    identityDigest: NARRATED_JOB.identityDigest,
    videoSha256: signoff.videoSha256,
    contactSheetSha256: signoff.contactSheetSha256,
    signoffBodySha256: narratedSignoffBodySha256(signoff),
    reviewer: narratedSignoffReviewer(signoff),
  });
  assert.equal(subject.version, NARRATED_REVIEW_ATTESTATION_VERSION);
  assert.equal(subject.harnessId, "narrated-story-video");
  assert.deepEqual(Object.keys(subject).sort(), [...NARRATED_REVIEW_ATTESTATION_SUBJECT_FIELDS].sort());
  const base = {
    jobId: NARRATED_JOB.id,
    identityDigest: NARRATED_JOB.identityDigest,
    videoSha256: "a".repeat(64),
    contactSheetSha256: "b".repeat(64),
    signoffBodySha256: "c".repeat(64),
    reviewer: { id: "independent-reviewer", contextId: "review-context-narrated-1" },
  };
  assert.throws(() => createNarratedReviewAttestationSubject({ ...base, jobId: "video-koya-manga-video-aaaaaaaaaaaaaaaa" }), /reviewer-attestation-expected-subject-noncanonical:jobId/u);
  assert.throws(() => createNarratedReviewAttestationSubject({ ...base, identityDigest: base.identityDigest.toUpperCase() }), /reviewer-attestation-expected-subject-noncanonical:identityDigest/u);
  assert.throws(() => createNarratedReviewAttestationSubject({ ...base, videoSha256: `${"a".repeat(64)} ` }), /reviewer-attestation-expected-subject-noncanonical:videoSha256/u);
  assert.throws(() => createNarratedReviewAttestationSubject({ ...base, signoffBodySha256: "" }), /reviewer-attestation-expected-subject-noncanonical:signoffBodySha256/u);
  assert.throws(() => createNarratedReviewAttestationSubject({ ...base, reviewer: { id: "", contextId: "review-context-narrated-1" } }), /reviewer-attestation-expected-subject-noncanonical:reviewerId/u);
  assert.throws(() => createNarratedReviewAttestationSubject({ ...base, reviewer: { id: "r", contextId: "short" } }), /reviewer-attestation-expected-subject-noncanonical:reviewerContextId/u);
  // signoff 本文 digest は reviewerAttestation を除いた全体。承認内容の書き換えは digest を変える。
  assert.equal(narratedSignoffBodySha256({ ...signoff, reviewerAttestation: { any: "thing" } }), narratedSignoffBodySha256(signoff));
  assert.notEqual(narratedSignoffBodySha256({ ...signoff, approved: false }), narratedSignoffBodySha256(signoff));
  assert.notEqual(narratedSignoffBodySha256({ ...signoff, findings: ["x"] }), narratedSignoffBodySha256(signoff));
  // reviewer は文字列でも object でも同じ申告として読む。
  assert.deepEqual(narratedSignoffReviewer(signoff), { id: "independent-reviewer", contextId: "review-context-narrated-1" });
  assert.deepEqual(narratedSignoffReviewer({ reviewer: { id: "r2", contextId: "ctx-object-form" } }), { id: "r2", contextId: "ctx-object-form" });
});

test("a trusted reviewer signs a narrated signoff and the Receipt-side verifier rebuilds the subject from Job and disk truth", async (t) => {
  const signoff = narratedSignoffFixture();
  const signed = await signNarratedReviewSignoff({
    signoff,
    jobId: NARRATED_JOB.id,
    identityDigest: NARRATED_JOB.identityDigest,
    privateKeyPem: REVIEWER.privateKeyPem,
    trust: TRUST,
    signedAt: "2026-09-01T00:00:00.000Z",
  });
  assert.equal(signed.reviewerAttestation.version, NARRATED_REVIEW_ATTESTATION_VERSION);
  assert.equal(signed.reviewerAttestation.signer.keyId, REVIEWER.keyId);
  assert.equal(signed.reviewerAttestation.subject.signoffBodySha256, narratedSignoffBodySha256(signoff));
  // JSON 往復（file へ書いて読む）後も同じ digest で検証できる。
  const reloaded = JSON.parse(JSON.stringify(signed));
  const truth = { jobId: NARRATED_JOB.id, identityDigest: NARRATED_JOB.identityDigest, videoSha256: signoff.videoSha256, contactSheetSha256: signoff.contactSheetSha256, trust: TRUST };
  const ok = verifyNarratedReviewSignoff(reloaded, truth);
  assert.equal(ok.pass, true, JSON.stringify(ok.failures));
  assert.equal(ok.signerKeyId, REVIEWER.keyId);
  assert.equal(ok.reviewerLabel, "independent reviewer");
  assert.equal(ok.trustSha256, TRUST.sha256);
  // 再署名は既存 attestation を本文から除く（署名が自分自身を含まない）。
  const resigned = await signNarratedReviewSignoff({ signoff: signed, jobId: NARRATED_JOB.id, identityDigest: NARRATED_JOB.identityDigest, privateKeyPem: REVIEWER.privateKeyPem, trust: TRUST, signedAt: "2026-09-01T00:00:00.000Z" });
  assert.deepEqual(resigned, signed);

  const cases = [
    ["unsigned signoff written by a keyless terminal", signoff, truth, ["reviewer-attestation-missing"]],
    ["attestation deleted after signing", { ...signed, reviewerAttestation: undefined }, truth, ["reviewer-attestation-missing"]],
    ["approved flipped after signing", { ...signed, approved: false }, truth, ["reviewer-attestation-subject-mismatch:signoffBodySha256"]],
    ["findings emptied after signing", { ...(await signNarratedReviewSignoff({ signoff: narratedSignoffFixture({ findings: ["blurry frame 12"] }), jobId: NARRATED_JOB.id, identityDigest: NARRATED_JOB.identityDigest, privateKeyPem: REVIEWER.privateKeyPem, trust: TRUST })), findings: [] }, truth, ["reviewer-attestation-subject-mismatch:signoffBodySha256"]],
    ["reviewer renamed after signing", { ...signed, reviewer: "someone-else" }, truth, ["reviewer-attestation-subject-mismatch:signoffBodySha256", "reviewer-attestation-subject-mismatch:reviewerId"]],
    ["reviewer context re-declared after signing", { ...signed, reviewerContextId: "review-context-narrated-9" }, truth, ["reviewer-attestation-subject-mismatch:signoffBodySha256", "reviewer-attestation-subject-mismatch:reviewerContextId"]],
    ["borrowed for another Job", signed, { ...truth, ...OTHER_NARRATED_JOB, jobId: OTHER_NARRATED_JOB.id }, ["reviewer-attestation-subject-mismatch:jobId", "reviewer-attestation-subject-mismatch:identityDigest"]],
    ["MP4 replaced after signing", signed, { ...truth, videoSha256: "9".repeat(64) }, ["reviewer-attestation-subject-mismatch:videoSha256"]],
    ["contact sheet replaced after signing", signed, { ...truth, contactSheetSha256: "9".repeat(64) }, ["reviewer-attestation-subject-mismatch:contactSheetSha256"]],
    ["key revoked after signing", await signNarratedReviewSignoff({ signoff, jobId: NARRATED_JOB.id, identityDigest: NARRATED_JOB.identityDigest, privateKeyPem: REVOKED.privateKeyPem, trust: TRUST_BEFORE_REVOCATION, signedAt: "2026-08-01T00:00:00.000Z" }), truth, ["reviewer-key-revoked"]],
    ["unregistered key", await signNarratedReviewSignoff({ signoff, jobId: NARRATED_JOB.id, identityDigest: NARRATED_JOB.identityDigest, privateKeyPem: STRANGER.privateKeyPem, trust: STRANGER_TRUST }), truth, ["reviewer-key-untrusted"]],
    ["signature tampered", { ...signed, reviewerAttestation: { ...signed.reviewerAttestation, signature: tamperSignature(signed.reviewerAttestation.signature) } }, truth, ["reviewer-attestation-signature-invalid"]],
    ["signedAt rewritten", { ...signed, reviewerAttestation: { ...signed.reviewerAttestation, signedAt: "2026-09-02T00:00:00.000Z" } }, truth, ["reviewer-attestation-signature-invalid"]],
    ["Koya attestation version presented for narrated", { ...signed, reviewerAttestation: { ...signed.reviewerAttestation, version: KOYA_REVIEW_ATTESTATION_VERSION } }, truth, ["reviewer-attestation-version-unsupported", "reviewer-attestation-signature-invalid"]],
    ["Koya-shaped subject smuggled into a narrated attestation", { ...signed, reviewerAttestation: { ...signed.reviewerAttestation, subject: { ...signed.reviewerAttestation.subject, episodeId: "episode-1" } } }, truth, ["reviewer-attestation-subject-noncanonical:episodeId", "reviewer-attestation-signature-invalid"]],
    ["trust list unconfigured", signed, { ...truth, trust: null }, ["reviewer-trust-unconfigured"]],
    ["Job truth itself non-canonical (upper-cased identityDigest)", signed, { ...truth, identityDigest: NARRATED_JOB.identityDigest.toUpperCase() }, ["reviewer-attestation-expected-subject-noncanonical:identityDigest"]],
    ["signoff is not an object", "approved", truth, ["narrated-signoff-invalid"]],
  ];
  for (const [name, doc, expectation, expectedFailures] of cases) {
    await t.test(name, () => {
      const result = verifyNarratedReviewSignoff(doc, expectation);
      assert.equal(result.pass, false, name);
      for (const code of expectedFailures) {
        assert.ok(result.failures.includes(code), `${name}: expected ${code} in ${JSON.stringify(result.failures)}`);
      }
    });
  }
  await t.test("signing refuses an untrusted or revoked key and a non-canonical signoff", async () => {
    await assert.rejects(signNarratedReviewSignoff({ signoff, jobId: NARRATED_JOB.id, identityDigest: NARRATED_JOB.identityDigest, privateKeyPem: STRANGER.privateKeyPem, trust: TRUST }), /^Error: reviewer-key-untrusted/u);
    await assert.rejects(signNarratedReviewSignoff({ signoff, jobId: NARRATED_JOB.id, identityDigest: NARRATED_JOB.identityDigest, privateKeyPem: REVOKED.privateKeyPem, trust: TRUST }), /^Error: reviewer-key-revoked/u);
    await assert.rejects(signNarratedReviewSignoff({ signoff, jobId: NARRATED_JOB.id, identityDigest: NARRATED_JOB.identityDigest, trust: TRUST }), /reviewer-private-key-missing/u);
    await assert.rejects(signNarratedReviewSignoff({ signoff: narratedSignoffFixture({ videoSha256: "A".repeat(64) }), jobId: NARRATED_JOB.id, identityDigest: NARRATED_JOB.identityDigest, privateKeyPem: REVIEWER.privateKeyPem, trust: TRUST }), /reviewer-attestation-expected-subject-noncanonical:videoSha256/u);
    await assert.rejects(signNarratedReviewSignoff({ signoff: narratedSignoffFixture({ reviewer: "" }), jobId: NARRATED_JOB.id, identityDigest: NARRATED_JOB.identityDigest, privateKeyPem: REVIEWER.privateKeyPem, trust: TRUST }), /reviewer-attestation-expected-subject-noncanonical:reviewerId/u);
  });
});

test("the generic verifier rejects a Koya attestation against a narrated expectation and vice versa", async () => {
  const koyaSubject = subjectFixture();
  const koya = await createReviewAttestation({ subject: koyaSubject, privateKeyPem: REVIEWER.privateKeyPem, trust: TRUST });
  assert.equal(koya.version, KOYA_REVIEW_ATTESTATION_VERSION);
  assert.equal(verifyReviewAttestation(koya, { expectedSubject: koyaSubject, trust: TRUST }).pass, true);
  const signoff = narratedSignoffFixture();
  const narratedSubject = createNarratedReviewAttestationSubject({
    jobId: NARRATED_JOB.id,
    identityDigest: NARRATED_JOB.identityDigest,
    videoSha256: signoff.videoSha256,
    contactSheetSha256: signoff.contactSheetSha256,
    signoffBodySha256: narratedSignoffBodySha256(signoff),
    reviewer: narratedSignoffReviewer(signoff),
  });
  const crossed = verifyReviewAttestation(koya, { expectedSubject: narratedSubject, trust: TRUST });
  assert.equal(crossed.pass, false);
  assert.ok(crossed.failures.includes("reviewer-attestation-version-unsupported"));
  assert.ok(crossed.failures.includes("reviewer-attestation-subject-mismatch:harnessId"));
  const narrated = await createReviewAttestation({ subject: narratedSubject, privateKeyPem: REVIEWER.privateKeyPem, trust: TRUST });
  const reversed = verifyReviewAttestation(narrated, { expectedSubject: koyaSubject, trust: TRUST });
  assert.equal(reversed.pass, false);
  assert.ok(reversed.failures.includes("reviewer-attestation-version-unsupported"));
  assert.ok(reversed.failures.includes("reviewer-attestation-subject-mismatch:harnessId"));
  // 未知の harness は subject を組めない（黙って汎用形にしない）。
  await assert.rejects(createReviewAttestation({ subject: { ...narratedSubject, harnessId: "future-harness" }, privateKeyPem: REVIEWER.privateKeyPem, trust: TRUST }), /reviewer-attestation-subject-noncanonical:harnessId/u);
  assert.deepEqual([...REVIEW_ATTESTATION_HARNESS_IDS].sort(), ["explainer-video", "koya-manga-video", "narrated-story-video"]);
});

test("the shared trust list is read from the generic environment name, the legacy KOYA name means the same list, and conflicting values are refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "reviewer-trust-env-"));
  try {
    const trustPath = join(root, "reviewer-trust.json");
    await writeFile(trustPath, JSON.stringify(trustRaw()));
    const otherPath = join(root, "other-trust.json");
    await writeFile(otherPath, JSON.stringify(trustRaw()));
    assert.equal((await loadReviewerTrust({ env: { [REVIEWER_TRUST_PATH_ENV]: trustPath } })).sha256, TRUST.sha256);
    assert.equal((await loadReviewerTrust({ env: { [REVIEWER_TRUST_JSON_ENV]: JSON.stringify(trustRaw()) } })).sha256, TRUST.sha256);
    assert.equal((await loadReviewerTrust({ env: { [KOYA_REVIEWER_TRUST_PATH_ENV]: trustPath } })).sha256, TRUST.sha256);
    assert.equal((await loadReviewerTrust({ env: { [REVIEWER_TRUST_PATH_ENV]: trustPath, [KOYA_REVIEWER_TRUST_PATH_ENV]: trustPath } })).sha256, TRUST.sha256);
    await assert.rejects(
      loadReviewerTrust({ env: { [REVIEWER_TRUST_PATH_ENV]: trustPath, [KOYA_REVIEWER_TRUST_PATH_ENV]: otherPath } }),
      /reviewer-trust-invalid:env-ambiguous:path/u,
    );
    await assert.rejects(
      loadReviewerTrust({ env: { [REVIEWER_TRUST_JSON_ENV]: JSON.stringify(trustRaw()), [KOYA_REVIEWER_TRUST_JSON_ENV]: "{}" } }),
      /reviewer-trust-invalid:env-ambiguous:json/u,
    );
    assert.throws(() => trustedReviewerTrustFromEnvironment({}), /reviewer-trust-unconfigured/u);
    // 旧名 env が唯一のアンカーでも、明示 path はそれと照合される（一致 → 通る / 別内容 → conflict）。
    assert.equal((await loadReviewerTrust({ trustPath, env: { [KOYA_REVIEWER_TRUST_PATH_ENV]: trustPath } })).sha256, TRUST.sha256);
    const strangerPath = join(root, "stranger-trust.json");
    await writeFile(strangerPath, JSON.stringify({ version: REVIEWER_TRUST_VERSION, reviewers: [createKoyaReviewerTrustEntry({ publicKeyPem: STRANGER.publicKeyPem })] }));
    await assert.rejects(loadReviewerTrust({ trustPath: strangerPath, env: { [KOYA_REVIEWER_TRUST_PATH_ENV]: trustPath } }), /^Error: reviewer-trust-conflict/u);
    await assert.rejects(loadReviewerTrust({ trustPath: strangerPath, env: {} }), /^Error: reviewer-trust-unconfigured/u);
    // 旧 export 名は同じ実装を指す。
    assert.equal(loadKoyaReviewerTrust, loadReviewerTrust);
    assert.equal(verifyKoyaReviewAttestation, verifyReviewAttestation);
    assert.equal(createKoyaReviewAttestation, createReviewAttestation);
    assert.equal(KOYA_REVIEWER_TRUST_VERSION, REVIEWER_TRUST_VERSION);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// R2-S5: 期待 subject を「組めない」失敗（Job・成果物・reviewer 申告側の欠落）は、
// 署名済み subject が壊れている失敗とは別の理由コードで報告する。
test("expected-subject build failures use a distinct code family from signed-subject failures", () => {
  assert.equal(REVIEW_ATTESTATION_EXPECTED_SUBJECT_PREFIX, "reviewer-attestation-expected-subject");
  let caught = null;
  try {
    createKoyaReviewAttestationSubject({
      episodeId: "episode-1",
      outerJobBinding: BINDING,
      contractDigest: "c".repeat(64),
      videoSha256: "not-a-sha",
      contactSheetSha256: "b".repeat(64),
      reviewNotesContentSha256: "d".repeat(64),
      reviewer: REVIEWER_PROVENANCE,
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught);
  assert.deepEqual(expectedSubjectFailureCodes(caught), ["reviewer-attestation-expected-subject-noncanonical:videoSha256"]);
  assert.doesNotMatch(String(caught.message), /reviewer-attestation-subject-noncanonical/u);
  // 検証側で署名済み subject が壊れている場合は従来コードのまま。
  const signed = rawSignedAttestation({ ...subjectFixture(), videoSha256: "A".repeat(64) });
  const verified = verifyKoyaReviewAttestation(signed, { expectedSubject: subjectFixture(), trust: TRUST });
  assert.ok(verified.failures.includes("reviewer-attestation-subject-noncanonical:videoSha256"));
  assert.ok(!verified.failures.some((code) => code.startsWith("reviewer-attestation-expected-subject-")));
  // 理由コード以外（メッセージ本文）は返さない。
  assert.deepEqual(expectedSubjectFailureCodes(new Error("something unrelated")), ["reviewer-attestation-expected-subject-invalid"]);
});

// R3-4: attestation の形は harness 宣言が申告する。既知の subject 以外は空（呼び出し側で fail-closed）。
test("harness declarations must declare a known reviewAttestation.subject", () => {
  assert.equal(declaredReviewAttestationSubject({ reviewAttestation: { subject: "koya-manga-video" } }), "koya-manga-video");
  assert.equal(declaredReviewAttestationSubject({ reviewAttestation: { subject: "narrated-story-video" } }), "narrated-story-video");
  assert.equal(declaredReviewAttestationSubject({}), "");
  assert.equal(declaredReviewAttestationSubject({ reviewAttestation: {} }), "");
  assert.equal(declaredReviewAttestationSubject({ reviewAttestation: { subject: "future-harness" } }), "");
  assert.equal(declaredReviewAttestationSubject({ reviewAttestation: { subject: " koya-manga-video" } }), "");
  assert.equal(declaredReviewAttestationSubject(null), "");
  for (const id of REVIEW_ATTESTATION_HARNESS_IDS) {
    assert.equal(declaredReviewAttestationSubject({ reviewAttestation: { subject: id } }), id);
  }
});

// R2-S2 / R2-S4: 秘密鍵の置き場。リポジトリ／project／git 作業ツリー配下を拒否し、
// 公開鍵側の衝突でも秘密鍵だけが残らないよう、両 path を先に検査してから書く。
test("reviewer key files refuse repository, project, and git working-tree locations and never leave a lone private key", async (t) => {
  const outside = await mkdtemp(join(tmpdir(), "reviewer-key-outside-"));
  const project = await mkdtemp(join(tmpdir(), "reviewer-key-project-"));
  const noGit = async () => "";
  try {
    await t.test("refuses this repository root", async () => {
      await assert.rejects(
        writeReviewerKeyPairFiles({ privateKeyPath: join(REPO_ROOT, "tmp-reviewer.pem"), detectGitToplevel: noGit }),
        /^Error: reviewer-key-path-inside-repository/u,
      );
      await assert.rejects(
        writeReviewerKeyPairFiles({ privateKeyPath: join(REPO_ROOT, "config", "reviewer.pem"), detectGitToplevel: noGit }),
        /^Error: reviewer-key-path-inside-repository/u,
      );
    });
    await t.test("refuses the project dir even outside the repository", async () => {
      await assert.rejects(
        writeReviewerKeyPairFiles({ privateKeyPath: join(project, "keys", "reviewer.pem"), projectDir: project, detectGitToplevel: noGit }),
        /^Error: reviewer-key-path-inside-repository/u,
      );
    });
    await t.test("refuses any git working tree reported by git rev-parse --show-toplevel", async () => {
      const seen = [];
      await assert.rejects(
        writeReviewerKeyPairFiles({
          privateKeyPath: join(outside, "worktree", "deep", "reviewer.pem"),
          detectGitToplevel: async (directory) => { seen.push(directory); return join(outside, "worktree"); },
        }),
        /^Error: reviewer-key-path-inside-repository/u,
      );
      // 鍵 file はまだ無いので、実在する最寄りの祖先（symlink を解いた realpath）から git を問う。
      assert.deepEqual(seen, [await realpath(outside)]);
      // 実際の git を使った検査: このリポジトリ配下は git が toplevel を返すので拒否される。
      await assert.rejects(
        assertReviewerKeyPathOutsideRepository(join(REPO_ROOT, "docs", "reviewer.pem"), { repositoryRoots: [] }),
        /^Error: reviewer-key-path-inside-repository/u,
      );
    });
    await t.test("F-1: refuses a symlink that resolves into the repository or project even though the spelled path is outside", async () => {
      const link = join(outside, "via-link");
      await symlink(REPO_ROOT, link, "dir");
      await assert.rejects(
        writeReviewerKeyPairFiles({ privateKeyPath: join(link, "keys", "reviewer.pem"), detectGitToplevel: noGit }),
        /^Error: reviewer-key-path-inside-repository/u,
      );
      const projectLink = join(outside, "project-link");
      await symlink(project, projectLink, "dir");
      await assert.rejects(
        writeReviewerKeyPairFiles({ privateKeyPath: join(projectLink, "reviewer.pem"), projectDir: project, detectGitToplevel: noGit }),
        /^Error: reviewer-key-path-inside-repository/u,
      );
      // 逆向き: root 側が symlink 表記で、鍵 path が realpath 表記でも同じ場所なら拒否。
      await assert.rejects(
        writeReviewerKeyPairFiles({ privateKeyPath: join(project, "reviewer.pem"), projectDir: projectLink, detectGitToplevel: noGit }),
        /^Error: reviewer-key-path-inside-repository/u,
      );
      // 秘密鍵は一切書かれていない。
      await assert.rejects(stat(join(REPO_ROOT, "keys", "reviewer.pem")), (error) => error?.code === "ENOENT");
      await assert.rejects(stat(join(project, "reviewer.pem")), (error) => error?.code === "ENOENT");
    });
    await t.test("F-1: refuses case-variant spellings of the repository / project on a case-insensitive file system", async () => {
      const swapCase = (value) => value.replace(/[a-z]/gu, (letter) => letter.toUpperCase());
      const variant = join(dirname(project), swapCase(project.slice(dirname(project).length + 1)));
      assert.notEqual(variant, project);
      // 大文字小文字を区別しない FS として比較（macOS/Windows の既定）。
      await assert.rejects(
        writeReviewerKeyPairFiles({ privateKeyPath: join(variant, "reviewer.pem"), projectDir: project, detectGitToplevel: noGit, caseInsensitive: true }),
        /^Error: reviewer-key-path-inside-repository/u,
      );
      await assert.rejects(
        assertReviewerKeyPathOutsideRepository(join(swapCase(REPO_ROOT), "docs", "reviewer.pem"), { repositoryRoots: [REPO_ROOT], detectGitToplevel: noGit, caseInsensitive: true }),
        /^Error: reviewer-key-path-inside-repository/u,
      );
      // このホストが実際に case-insensitive なら、既定値でも同じ結果になる（realpath が正規の綴りへ戻す）。
      let hostIsCaseInsensitive = false;
      try { await stat(variant); hostIsCaseInsensitive = true; } catch { hostIsCaseInsensitive = false; }
      if (hostIsCaseInsensitive) {
        await assert.rejects(
          writeReviewerKeyPairFiles({ privateKeyPath: join(variant, "reviewer.pem"), projectDir: project, detectGitToplevel: noGit }),
          /^Error: reviewer-key-path-inside-repository/u,
        );
      }
      await assert.rejects(stat(join(project, "reviewer.pem")), (error) => error?.code === "ENOENT");
    });
    await t.test("refuses a public-key collision before writing the private key", async () => {
      const privateKeyPath = join(outside, "collide", "reviewer.pem");
      const publicKeyPath = `${privateKeyPath}.pub`;
      await writeFile(join(outside, "collide.pub.placeholder"), "x");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(dirname(publicKeyPath), { recursive: true });
      await writeFile(publicKeyPath, "existing public key");
      await assert.rejects(
        writeReviewerKeyPairFiles({ privateKeyPath, detectGitToplevel: noGit }),
        /^Error: reviewer-key-path-exists/u,
      );
      await assert.rejects(stat(privateKeyPath), (error) => error?.code === "ENOENT", "no private key may be left behind");
      assert.equal(await readFile(publicKeyPath, "utf8"), "existing public key");
    });
    await t.test("writes 0600 private / 0644 public keys once and refuses to overwrite either", async () => {
      const privateKeyPath = join(outside, "keys", "reviewer.pem");
      const created = await writeReviewerKeyPairFiles({ privateKeyPath, label: "fixture reviewer", detectGitToplevel: noGit });
      assert.equal(created.privateKeyPath, privateKeyPath);
      assert.equal(created.publicKeyPath, `${privateKeyPath}.pub`);
      assert.match(created.keyId, /^ed25519:[a-f0-9]{24}$/u);
      assert.equal(created.trustEntry.keyId, created.keyId);
      assert.equal(created.trustEntry.status, "active");
      assert.equal(created.trustEntry.label, "fixture reviewer");
      assert.equal(created.trustListVersion, REVIEWER_TRUST_VERSION);
      if (process.platform !== "win32") {
        assert.equal((await stat(privateKeyPath)).mode & 0o777, 0o600);
        assert.equal((await stat(created.publicKeyPath)).mode & 0o777, 0o644);
      }
      assert.match(await readFile(privateKeyPath, "utf8"), /BEGIN PRIVATE KEY/u);
      assert.match(await readFile(created.publicKeyPath, "utf8"), /BEGIN PUBLIC KEY/u);
      // 生成した鍵は信頼リスト entry と一致し、そのまま署名に使える。
      const trust = normalizeKoyaReviewerTrust({ version: REVIEWER_TRUST_VERSION, reviewers: [created.trustEntry] });
      const attestation = await createReviewAttestation({ subject: subjectFixture(), privateKeyPath, trust });
      assert.equal(attestation.signer.keyId, created.keyId);
      assert.equal(verifyReviewAttestation(attestation, { expectedSubject: subjectFixture(), trust }).pass, true);
      await assert.rejects(writeReviewerKeyPairFiles({ privateKeyPath, detectGitToplevel: noGit }), /^Error: reviewer-key-path-exists/u);
      await assert.rejects(writeReviewerKeyPairFiles({ privateKeyPath: join(outside, "keys", "other.pem"), publicKeyPath: created.publicKeyPath, detectGitToplevel: noGit }), /^Error: reviewer-key-path-exists/u);
      await assert.rejects(stat(join(outside, "keys", "other.pem")), (error) => error?.code === "ENOENT");
    });
    await t.test("refuses relative paths and identical private/public paths", async () => {
      await assert.rejects(writeReviewerKeyPairFiles({ privateKeyPath: "relative/reviewer.pem", detectGitToplevel: noGit }), /reviewer-key-path-not-absolute/u);
      await assert.rejects(writeReviewerKeyPairFiles({ privateKeyPath: join(outside, "same.pem"), publicKeyPath: join(outside, "same.pem"), detectGitToplevel: noGit }), /reviewer-key-path-conflict/u);
      await assert.rejects(writeReviewerKeyPairFiles({ detectGitToplevel: noGit }), /reviewer-key-path-missing/u);
    });
  } finally {
    await rm(outside, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test("R6-1: preflightReviewerTrust answers ok only when the operator env is set, readable, unambiguous, and holds an active key; it never throws and never leaks paths", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "reviewer-trust-preflight-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const activePair = generateKoyaReviewerKeyPair();
  const activeList = { version: "koya-reviewer-trust-v1", reviewers: [createKoyaReviewerTrustEntry({ publicKeyPem: activePair.publicKeyPem, label: "active" })] };
  const revokedList = {
    version: "koya-reviewer-trust-v1",
    reviewers: [{ ...createKoyaReviewerTrustEntry({ publicKeyPem: activePair.publicKeyPem, label: "retired" }), status: "revoked", revokedAt: "2026-09-01T00:00:00.000Z", reason: "fixture" }],
  };
  const activePath = join(dir, "active.json");
  const otherPath = join(dir, "other.json");
  await writeFile(activePath, JSON.stringify(activeList));
  await writeFile(otherPath, JSON.stringify({ version: "koya-reviewer-trust-v1", reviewers: [createKoyaReviewerTrustEntry({ publicKeyPem: generateKoyaReviewerKeyPair().publicKeyPem, label: "other" })] }));

  const unconfigured = await preflightReviewerTrust({ env: {} });
  assert.equal(unconfigured.ok, false);
  assert.equal(unconfigured.code, "reviewer-trust-unconfigured");
  assert.equal(unconfigured.source, "");
  const withPathOnly = await preflightReviewerTrust({ env: {}, trustPath: activePath });
  assert.equal(withPathOnly.code, "reviewer-trust-unconfigured", "明示 path だけでは信頼アンカーにならない");
  assert.ok(!withPathOnly.detail.includes(dir), "detail に path を載せない");

  const unreadable = await preflightReviewerTrust({ env: { BUZZASSIST_REVIEWER_TRUST: join(dir, "missing.json") } });
  assert.equal(unreadable.code, "reviewer-trust-unreadable");
  assert.ok(!unreadable.detail.includes(dir));

  const ambiguous = await preflightReviewerTrust({ env: { BUZZASSIST_REVIEWER_TRUST: activePath, BUZZASSIST_KOYA_REVIEWER_TRUST: otherPath } });
  assert.equal(ambiguous.code, "reviewer-trust-invalid:env-ambiguous:path");
  assert.equal(ambiguous.source, "ambiguous");

  const noActive = await preflightReviewerTrust({ env: { BUZZASSIST_REVIEWER_TRUST_JSON: JSON.stringify(revokedList) } });
  assert.equal(noActive.ok, false);
  assert.equal(noActive.code, REVIEWER_TRUST_NO_ACTIVE_CODE);
  assert.equal(noActive.activeReviewers, 0);
  assert.match(noActive.sha256, /^[a-f0-9]{64}$/u, "読めた事実は残す");

  const conflict = await preflightReviewerTrust({ env: { BUZZASSIST_REVIEWER_TRUST: activePath }, trustPath: otherPath });
  assert.equal(conflict.code, "reviewer-trust-conflict");

  const ok = await preflightReviewerTrust({ env: { BUZZASSIST_REVIEWER_TRUST: activePath }, trustPath: activePath });
  assert.deepEqual({ ok: ok.ok, code: ok.code, active: ok.activeReviewers, source: ok.source }, { ok: true, code: "", active: 1, source: "path" });
  const okJson = await preflightReviewerTrust({ env: { BUZZASSIST_KOYA_REVIEWER_TRUST_JSON: JSON.stringify(activeList) } });
  assert.equal(okJson.ok, true);
  assert.equal(okJson.source, "json");

  // 注入した loadTrust が例外を投げても preflight は throw せず code へ畳む。
  const injected = await preflightReviewerTrust({ env: { BUZZASSIST_REVIEWER_TRUST: activePath }, loadTrust: async () => { throw new Error("reviewer-trust-invalid:json-unparseable"); } });
  assert.equal(injected.code, "reviewer-trust-invalid:json-unparseable");
  assert.equal(activeReviewerCount(normalizeKoyaReviewerTrust(activeList)), 1);
  assert.equal(activeReviewerCount(normalizeKoyaReviewerTrust(revokedList)), 0);
  assert.equal(activeReviewerCount(null), 0);
});

test("R6-F6: the reviewer option rejection patterns are exported once for the service and Job layers", () => {
  for (const key of ["reviewerTrustPath", "reviewer_trust_json", "koyaReviewerTrust"]) assert.ok(REVIEWER_TRUST_OPTION_PATTERN.test(key), key);
  for (const key of ["reviewerPrivateKeyPem", "privateKey", "reviewer_private_key", "reviewerKeyPath", "reviewerPublicKeyPath", "reviewer_key_path", "anythingPem"]) {
    assert.ok(REVIEWER_KEY_OPTION_PATTERN.test(key), key);
  }
  for (const key of ["characterBiblePath", "storyReviewPath", "episodeId", "reviewerContextId"]) {
    assert.ok(!REVIEWER_KEY_OPTION_PATTERN.test(key) && !REVIEWER_TRUST_OPTION_PATTERN.test(key), key);
  }
  assert.ok(REVIEWER_KEY_MATERIAL_VALUE_PATTERN.test("-----BEGIN PRIVATE KEY-----\nabc"));
  assert.ok(REVIEWER_KEY_MATERIAL_VALUE_PATTERN.test('{"version":"koya-reviewer-trust-v1","reviewers": [ ]}'));
  assert.ok(!REVIEWER_KEY_MATERIAL_VALUE_PATTERN.test("/secure/reviewer.pem"));
});

test("R6-4: a dangling symlink at the key path is refused with a reason code, never a raw EEXIST", async (t) => {
  const outside = await mkdtemp(join(tmpdir(), "reviewer-key-dangling-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const noGit = async () => "";

  // 先がリポジトリ内（まだ無い file）を指す dangling symlink → inside-repository。
  const intoRepo = join(outside, "into-repo.pem");
  await symlink(join(REPO_ROOT, "never-created-reviewer.pem"), intoRepo);
  await assert.rejects(
    writeReviewerKeyPairFiles({ privateKeyPath: intoRepo, detectGitToplevel: noGit }),
    /^Error: reviewer-key-path-inside-repository/u,
  );
  // 公開鍵側だけが dangling でリポジトリ内を指しても同じ。
  const intoRepoPub = join(outside, "into-repo.pub");
  await symlink(join(REPO_ROOT, "never-created-reviewer.pub"), intoRepoPub);
  await assert.rejects(
    writeReviewerKeyPairFiles({ privateKeyPath: join(outside, "fresh.pem"), publicKeyPath: intoRepoPub, detectGitToplevel: noGit }),
    /^Error: reviewer-key-path-inside-repository/u,
  );

  // 先がリポジトリ外の存在しない file を指す dangling symlink → path-exists（symlink 自体が既に在る）。
  const danglingOutside = join(outside, "dangling.pem");
  await symlink(join(outside, "nowhere", "target.pem"), danglingOutside);
  await assert.rejects(
    writeReviewerKeyPairFiles({ privateKeyPath: danglingOutside, detectGitToplevel: noGit }),
    (error) => /^reviewer-key-path-exists/u.test(error.message) && !/EEXIST/u.test(error.message),
  );
  const danglingPub = join(outside, "dangling.pub");
  await symlink(join(outside, "nowhere", "target.pub"), danglingPub);
  await assert.rejects(
    writeReviewerKeyPairFiles({ privateKeyPath: join(outside, "fresh2.pem"), publicKeyPath: danglingPub, detectGitToplevel: noGit }),
    (error) => /^reviewer-key-path-exists/u.test(error.message) && !/EEXIST/u.test(error.message),
  );
  // 秘密鍵だけが残らない: 拒否後に fresh2.pem は書かれていない。
  await assert.rejects(stat(join(outside, "fresh2.pem")), { code: "ENOENT" });
  await assert.rejects(stat(join(outside, "fresh.pem")), { code: "ENOENT" });
});
