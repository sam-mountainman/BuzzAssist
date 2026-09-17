import assert from "node:assert/strict";
import test from "node:test";

import {
  assertKoyaOuterJobBinding,
  createKoyaOuterJobBinding,
  sameKoyaOuterJobBinding,
} from "../lib/koyaOuterJobBinding.mjs";
import {
  assertVideoHarnessExecutionIdentity,
  channelPackVerificationSha256,
  createVideoHarnessExecutionIdentityDigest,
  VIDEO_HARNESS_EXECUTION_IDENTITY_NO_CHANNEL_PACK,
} from "../lib/videoHarnessExecutionIdentity.mjs";

// v2 の binding は 4 項目すべてが揃って初めて成立する。ここを 2 項目で
// 組むと、否定テストが**期待した理由より手前**で落ちる——改ざん検出を
// 検証しているつもりで、必須項目の欠落しか見ていない状態になる。
const JOB_ID = "video-koya-manga-video-aaaaaaaaaaaaaaaa";
const IDENTITY_DIGEST = "a".repeat(64);
const EXECUTION_IDENTITY_DIGEST = "1".repeat(64);
const CONTRACT_SHA256 = "2".repeat(64);

const v2 = (overrides = {}) => ({
  jobId: JOB_ID,
  identityDigest: IDENTITY_DIGEST,
  executionIdentityDigest: EXECUTION_IDENTITY_DIGEST,
  resolvedProductionContractSha256: CONTRACT_SHA256,
  ...overrides,
});

test("Koya outer Job binding keeps the stable canonical identity and rejects tamper", () => {
  const binding = createKoyaOuterJobBinding(v2());
  assert.deepEqual(assertKoyaOuterJobBinding(binding, {
    required: true,
    expectedJobId: binding.jobId,
    expectedIdentityDigest: binding.identityDigest,
    expectedExecutionIdentityDigest: binding.executionIdentityDigest,
    expectedResolvedProductionContractSha256: binding.resolvedProductionContractSha256,
  }), binding);
  assert.equal(sameKoyaOuterJobBinding(binding, structuredClone(binding)), true);

  // 4 項目のどれを差し替えても、封印した bindingSha256 と合わなくなる。
  for (const [field, value] of [
    ["identityDigest", "b".repeat(64)],
    ["executionIdentityDigest", "3".repeat(64)],
    ["resolvedProductionContractSha256", "4".repeat(64)],
  ]) {
    const tampered = structuredClone(binding);
    tampered[field] = value;
    assert.throws(
      () => assertKoyaOuterJobBinding(tampered, { required: true }),
      /derived|digest/iu,
      field,
    );
    assert.equal(sameKoyaOuterJobBinding(binding, tampered), false, field);
  }
});

test("Koya outer Job binding cannot be borrowed from another Job's execution identity", () => {
  // 形式として正しい binding でも、いま実行中の Job のものでなければ拒む。
  const binding = createKoyaOuterJobBinding(v2());
  assert.throws(() => assertKoyaOuterJobBinding(binding, {
    required: true,
    expectedJobId: "video-koya-manga-video-cccccccccccccccc",
  }), /belongs to another Job/iu);
  assert.throws(() => assertKoyaOuterJobBinding(binding, {
    required: true,
    expectedIdentityDigest: "c".repeat(64),
  }), /another canonical identityDigest/iu);
  assert.throws(() => assertKoyaOuterJobBinding(binding, {
    required: true,
    expectedExecutionIdentityDigest: "5".repeat(64),
  }), /another executionIdentityDigest/iu);
  assert.throws(() => assertKoyaOuterJobBinding(binding, {
    required: true,
    expectedResolvedProductionContractSha256: "6".repeat(64),
  }), /another resolved production contract digest/iu);
});

test("Koya outer Job binding cannot be created from partial or unrelated identity", () => {
  assert.throws(
    () => createKoyaOuterJobBinding({ jobId: JOB_ID }),
    /Job identityDigest is invalid/u,
  );
  assert.throws(
    () => createKoyaOuterJobBinding(v2({ executionIdentityDigest: "" })),
    /executionIdentityDigest is invalid/u,
  );
  assert.throws(
    () => createKoyaOuterJobBinding(v2({ resolvedProductionContractSha256: "" })),
    /resolvedProductionContractSha256 is invalid/u,
  );
  assert.throws(
    () => createKoyaOuterJobBinding(v2({ identityDigest: "b".repeat(64) })),
    /not derived/iu,
  );
});

test("Koya outer Job binding rejects upper-cased or padded digest spellings instead of normalizing them", () => {
  // 正規化して受けると、大文字化・空白付きの写しが元と同じ bindingSha256 に
  // 収束し、封印した digest で写しと原本を区別できなくなる。
  const hex = "ab".repeat(32);
  assert.throws(() => createKoyaOuterJobBinding(v2({ executionIdentityDigest: hex.toUpperCase() })), /executionIdentityDigest is invalid/u);
  assert.throws(() => createKoyaOuterJobBinding(v2({ executionIdentityDigest: `${hex} ` })), /executionIdentityDigest is invalid/u);
  assert.throws(() => createKoyaOuterJobBinding(v2({ resolvedProductionContractSha256: ` ${hex}` })), /resolvedProductionContractSha256 is invalid/u);
  assert.throws(() => createKoyaOuterJobBinding(v2({ identityDigest: `${IDENTITY_DIGEST}\n` })), /identityDigest is invalid/u);
  assert.throws(() => createKoyaOuterJobBinding(v2({ jobId: `${JOB_ID} ` })), /Job id is invalid/u);
  const binding = createKoyaOuterJobBinding(v2());
  assert.throws(
    () => assertKoyaOuterJobBinding({ ...binding, bindingSha256: `${binding.bindingSha256} ` }, { required: true }),
    /digest or contract is invalid/iu,
  );
  assert.throws(
    () => assertKoyaOuterJobBinding({ ...binding, executionIdentityDigest: binding.executionIdentityDigest.toUpperCase().replace(/1/gu, "A") }, { required: true }),
    /executionIdentityDigest is invalid|digest or contract is invalid/iu,
  );
});

const RESOLVED_CONTRACT = Object.freeze({
  version: "buzzassist-resolved-production-contract-v1",
  harnessId: "koya-manga-video",
  episodeId: "ep-01",
  contractVersion: "fixture-contract-v1",
  contractDigest: "f".repeat(64),
  contractPath: "/fixture/koya-manga-production-contract.json",
  contractFileSha256: "9".repeat(64),
  contractSource: "fixture",
  episodeOverridePath: "/fixture/ep-01.override.json",
  episodeOverrideFileSha256: "8".repeat(64),
});
const CHANNEL_PACK_VERIFICATION = Object.freeze({
  envelopeVersion: "buzzassist-channel-pack-envelope-v1",
  id: "koya-pack",
  version: "1.2.0",
  harnessId: "koya-manga-video",
  payloadKind: "koya-handoff",
  payloadSha256: "c".repeat(64),
  fileCount: 4,
  signerKeyId: "ed25519:signer",
  trustedPublicKeyId: "ed25519:signer",
});

function identityJob(overrides = {}) {
  const job = {
    id: JOB_ID,
    identityDigest: IDENTITY_DIGEST,
    resolvedProductionContract: structuredClone(RESOLVED_CONTRACT),
    channelPackVerification: structuredClone(CHANNEL_PACK_VERIFICATION),
    ...overrides,
  };
  job.executionIdentityDigest = createVideoHarnessExecutionIdentityDigest({
    jobId: job.id,
    identityDigest: job.identityDigest,
    resolvedProductionContract: job.resolvedProductionContract,
    channelPackVerification: job.channelPackVerification,
  });
  return job;
}

test("execution identity is derived once from Job, fixed contract and verified Channel Pack, and is deterministic", () => {
  const job = identityJob();
  const verified = assertVideoHarnessExecutionIdentity(job);
  assert.equal(verified.executionIdentityDigest, job.executionIdentityDigest);
  assert.match(verified.resolvedProductionContractSha256, /^[a-f0-9]{64}$/u);
  assert.equal(verified.channelPackVerificationSha256, channelPackVerificationSha256(CHANNEL_PACK_VERIFICATION));
  assert.equal(identityJob().executionIdentityDigest, job.executionIdentityDigest, "same inputs give the same identity");
  // 同じ Job・同じ契約でも、検証済み pack が違えば別の実行識別子になる。
  assert.notEqual(
    identityJob({ channelPackVerification: { ...CHANNEL_PACK_VERIFICATION, trustedPublicKeyId: "ed25519:other" } }).executionIdentityDigest,
    job.executionIdentityDigest,
  );
  // pack 無しは明示の "none" として畳み込む。無しと有りが同じ識別子になれない。
  assert.equal(channelPackVerificationSha256(null), VIDEO_HARNESS_EXECUTION_IDENTITY_NO_CHANNEL_PACK);
  assert.notEqual(identityJob({ channelPackVerification: null }).executionIdentityDigest, job.executionIdentityDigest);
  // 検証結果に構造体が混ざる（署名本文など）のは識別子の入力にしない。
  assert.throws(
    () => channelPackVerificationSha256({ payloadSha256: { nested: true } }),
    /must be a scalar/u,
  );
  assert.throws(() => channelPackVerificationSha256({ unrelated: "x" }), /carries no identity field/u);
});

test("execution identity rejects missing, tampered, upper-cased, padded, re-contracted, re-packed and borrowed Jobs with a distinct reason", () => {
  const cases = [
    ["missing", (job) => { delete job.executionIdentityDigest; }, /execution identity is missing/u],
    ["null", (job) => { job.executionIdentityDigest = null; }, /execution identity is missing/u],
    ["empty", (job) => { job.executionIdentityDigest = ""; }, /execution identity is missing/u],
    ["upper-cased", (job) => { job.executionIdentityDigest = job.executionIdentityDigest.toUpperCase(); }, /not a canonical lowercase SHA-256/u],
    ["trailing whitespace", (job) => { job.executionIdentityDigest = `${job.executionIdentityDigest} `; }, /not a canonical lowercase SHA-256/u],
    ["leading whitespace", (job) => { job.executionIdentityDigest = ` ${job.executionIdentityDigest}`; }, /not a canonical lowercase SHA-256/u],
    ["trailing newline", (job) => { job.executionIdentityDigest = `${job.executionIdentityDigest}\n`; }, /not a canonical lowercase SHA-256/u],
    ["tampered digest", (job) => { job.executionIdentityDigest = "0".repeat(64); }, /does not match/u],
    ["contract override changed", (job) => { job.resolvedProductionContract.episodeOverrideFileSha256 = "7".repeat(64); }, /does not match/u],
    ["contract version changed", (job) => { job.resolvedProductionContract.contractVersion = "fixture-contract-v2"; }, /does not match/u],
    ["contract removed", (job) => { delete job.resolvedProductionContract; }, /resolved production contract is required/u],
    ["channel pack payload changed", (job) => { job.channelPackVerification.payloadSha256 = "d".repeat(64); }, /does not match/u],
    ["channel pack trusted key changed", (job) => { job.channelPackVerification.trustedPublicKeyId = "ed25519:other"; }, /does not match/u],
    ["channel pack verification dropped", (job) => { delete job.channelPackVerification; }, /does not match/u],
    ["borrowed by another Job", (job) => {
      job.id = `video-koya-manga-video-${"b".repeat(16)}`;
      job.identityDigest = "b".repeat(64);
    }, /does not match/u],
    ["identityDigest upper-cased", (job) => { job.identityDigest = "ab".repeat(32).toUpperCase(); }, /base identity is invalid/u],
    ["Job id not derived from identityDigest", (job) => { job.identityDigest = "b".repeat(64); }, /base identity is invalid/u],
  ];
  for (const [name, mutate, expected] of cases) {
    const job = identityJob();
    mutate(job);
    assert.throws(() => assertVideoHarnessExecutionIdentity(job), expected, name);
  }
});
