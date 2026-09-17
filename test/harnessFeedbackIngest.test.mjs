import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createHarnessFeedbackUploadHandler,
  decideHarnessFeedbackBundle,
  enrollHarnessFeedbackOperator,
  ingestHarnessFeedbackBundle,
  loadApprovedHarnessFeedbackImports,
  loadHarnessFeedbackImportLedger,
  revokeHarnessFeedbackOperator,
} from "../lib/harnessFeedbackIngest.mjs";
import {
  buildHarnessFeedbackPayload,
  feedbackProposalId,
  signHarnessFeedbackBundle,
} from "../lib/harnessFeedbackBundle.mjs";

function keys() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }),
  };
}

function payload({
  occurrenceDigests = ["1".repeat(64), "2".repeat(64)],
  generatedAt = "2026-09-01T00:00:00.000Z",
  channelPackId = "operator-pack",
} = {}) {
  return buildHarnessFeedbackPayload({
    curatorReport: {
      readOnly: true,
      pending: [{
        id: "6edb2451ffe2",
        kind: "constraint",
        target: "genre:narrated-story-video",
        text: "台本から完成動画までの制作hot pathへYouTube Analyticsやyt-quality-loopを混ぜない",
        occurrences: occurrenceDigests.length,
        localOccurrenceDigests: occurrenceDigests,
        evidenceDigests: ["a".repeat(64)],
      }],
      observedGates: [{
        harnessId: "narrated-story-video",
        harnessVersion: "1.2.0",
        declarationDigest: "b".repeat(64),
        gateId: "audio-loudness",
        pass: 1,
        fail: 0,
        skip: 0,
      }],
    },
    coreVersion: "0.1.25",
    harnessId: "narrated-story-video",
    harnessVersion: "1.2.0",
    skillDigests: ["c".repeat(64)],
    channelPack: { id: channelPackId, version: "1.0.0", payloadSha256: "d".repeat(64) },
    sourceHost: "codex",
    generatedAt,
  });
}

async function enroll(root, pair, operatorId = "operator-1") {
  const enrolledBuild = payload().build;
  return enrollHarnessFeedbackOperator({
    rootDir: root,
    operatorId,
    publicKeyPem: pair.publicKeyPem,
    allowedHarnessIds: ["narrated-story-video"],
    allowedBuilds: [enrolledBuild],
    approvedBy: "buzzassist-owner",
    enrolledAt: "2026-09-01T00:00:00.000Z",
  });
}

test("署名済みでもowner登録release tupleと完全一致しないbuildは保存しない", async () => {
  const root = await mkdtemp(join(tmpdir(), "feedback-build-scope-"));
  try {
    const pair = keys();
    await enroll(root, pair);
    const changed = payload({ channelPackId: "operator-pack-covert-value" });
    const bundle = await signHarnessFeedbackBundle({ payload: changed, privateKeyPem: pair.privateKeyPem });
    await assert.rejects(
      ingestHarnessFeedbackBundle({ rootDir: root, bundle }),
      (error) => error?.code === "FEEDBACK_BUILD_NOT_ALLOWED" && error?.statusCode === 403,
    );
    const names = await readdir(root);
    for (const directory of ["accepted", "curation", "sources", "receipts"]) {
      assert.equal(names.includes(directory), false, `${directory}へ未登録buildを残さない`);
    }
    const storedText = await readFile(join(root, "quarantine", (await readdir(join(root, "quarantine")))[0]), "utf8");
    assert.equal(storedText.includes("operator-pack-covert-value"), false, "reject metadataへ自由入力値を残さない");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("登録済みoperator署名だけを隔離受理し、exact duplicateとsource replayを分離する", async () => {
  const root = await mkdtemp(join(tmpdir(), "feedback-ingest-"));
  try {
    const pair = keys();
    const enrolled = await enroll(root, pair);
    assert.equal(enrolled.attached, false);
    assert.equal((await enroll(root, pair)).attached, true);

    const firstBundle = await signHarnessFeedbackBundle({ payload: payload(), privateKeyPem: pair.privateKeyPem });
    const firstBytes = Buffer.from(JSON.stringify(firstBundle));
    const first = await ingestHarnessFeedbackBundle({
      rootDir: root,
      bundle: firstBundle,
      bundleBytes: firstBytes,
      receivedAt: "2026-09-01T01:00:00.000Z",
    });
    assert.equal(first.status, "verified-quarantine");
    assert.equal(first.ownerApprovalRequired, true);
    assert.equal(first.duplicate, false);

    const duplicate = await ingestHarnessFeedbackBundle({
      rootDir: root,
      bundle: firstBundle,
      bundleBytes: firstBytes,
      receivedAt: "2026-09-01T01:01:00.000Z",
    });
    assert.equal(duplicate.bundleDigest, first.bundleDigest);
    assert.equal(duplicate.duplicate, true);

    const replayPayload = payload({ generatedAt: "2026-09-01T00:01:00.000Z" });
    const replay = await signHarnessFeedbackBundle({ payload: replayPayload, privateKeyPem: pair.privateKeyPem });
    await assert.rejects(
      ingestHarnessFeedbackBundle({
        rootDir: root,
        bundle: replay,
        bundleBytes: Buffer.from(JSON.stringify(replay)),
        receivedAt: "2026-09-01T01:02:00.000Z",
      }),
      (error) => error?.code === "FEEDBACK_SOURCE_REPLAY_CONFLICT",
    );
    const expandedPayload = payload({ occurrenceDigests: ["1".repeat(64), "2".repeat(64), "3".repeat(64)] });
    const expanded = await signHarnessFeedbackBundle({ payload: expandedPayload, privateKeyPem: pair.privateKeyPem });
    const expandedReceipt = await ingestHarnessFeedbackBundle({
      rootDir: root,
      bundle: expanded,
      bundleBytes: Buffer.from(JSON.stringify(expanded)),
      receivedAt: "2026-09-01T01:03:00.000Z",
    });
    assert.equal(expandedReceipt.duplicate, false, "新しいoccurrence集合は新snapshotとして受理する");
    assert.equal((await readdir(join(root, "quarantine"))).some((name) => name.startsWith("rejected-")), true);

    const decision = await decideHarnessFeedbackBundle({
      rootDir: root,
      bundleDigest: first.bundleDigest,
      decision: "approve",
      approvedBy: "buzzassist-owner",
      reason: "署名と対象scopeを確認してcurator観測へ昇格する",
      decidedAt: "2026-09-01T02:00:00.000Z",
    });
    assert.equal(decision.decision, "approve");
    const imports = await loadApprovedHarnessFeedbackImports({ rootDir: root });
    assert.equal(imports.length, 1);
    assert.equal(imports[0].proposalObservations[0].proposalId, "6edb2451ffe2");
    assert.deepEqual(imports[0].proposalObservations[0].occurrenceDigests, ["1".repeat(64), "2".repeat(64)]);
    assert.equal(imports[0].writesCanonical, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("未登録signerはraw bundleを保存せずquarantine metadataだけ残す", async () => {
  const root = await mkdtemp(join(tmpdir(), "feedback-unknown-signer-"));
  try {
    const enrolledPair = keys();
    const unknownPair = keys();
    await enroll(root, enrolledPair);
    const bundle = await signHarnessFeedbackBundle({ payload: payload(), privateKeyPem: unknownPair.privateKeyPem });
    await assert.rejects(
      ingestHarnessFeedbackBundle({ rootDir: root, bundle, bundleBytes: Buffer.from(JSON.stringify(bundle)) }),
      (error) => error?.code === "FEEDBACK_SIGNER_NOT_ENROLLED",
    );
    const names = await readdir(join(root, "quarantine"));
    assert.equal(names.length, 1);
    assert.equal((await readdir(root)).includes("accepted"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("署名が正しくても管理側catalogに無いproposalは保存前に拒否する", async () => {
  const root = await mkdtemp(join(tmpdir(), "feedback-unknown-proposal-"));
  try {
    const pair = keys();
    await enroll(root, pair);
    const proposal = {
      kind: "fact",
      target: "genre:narrated-story-video",
      text: "管理側が意味を知らない端末固有の提案",
    };
    const unknownPayload = buildHarnessFeedbackPayload({
      curatorReport: {
        readOnly: true,
        pending: [{
          id: feedbackProposalId(proposal),
          ...proposal,
          occurrences: 1,
          localOccurrenceDigests: ["9".repeat(64)],
          evidenceDigests: [],
        }],
        observedGates: [],
      },
      coreVersion: "0.1.25",
      harnessId: "narrated-story-video",
      harnessVersion: "1.2.0",
      skillDigests: ["c".repeat(64)],
      channelPack: { id: "operator-pack", version: "1.0.0", payloadSha256: "d".repeat(64) },
      sourceHost: "codex",
      generatedAt: "2026-09-01T00:00:00.000Z",
    });
    const bundle = await signHarnessFeedbackBundle({ payload: unknownPayload, privateKeyPem: pair.privateKeyPem });
    await assert.rejects(
      ingestHarnessFeedbackBundle({ rootDir: root, bundle }),
      (error) => error?.code === "FEEDBACK_PROPOSAL_NOT_REGISTERED",
    );
    assert.equal((await readdir(root)).includes("accepted"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("upload APIはBearerとoperator署名の二重認証で、同じbundleへ冪等に再接続する", async () => {
  const root = await mkdtemp(join(tmpdir(), "feedback-http-"));
  let server;
  try {
    const pair = keys();
    await enroll(root, pair);
    const bundle = await signHarnessFeedbackBundle({ payload: payload(), privateKeyPem: pair.privateKeyPem });
    server = createServer(createHarnessFeedbackUploadHandler({
      rootDir: root,
      uploadToken: "provider-free-upload-token",
      now: () => "2026-09-01T03:00:00.000Z",
    }));
    await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}/v1/feedback/bundles`;
    const unauthorized = await fetch(url, {
      method: "POST",
      body: JSON.stringify(bundle),
      headers: { "content-type": "application/json" },
    });
    assert.equal(unauthorized.status, 401);
    const upload = () => fetch(url, {
      method: "POST",
      body: JSON.stringify(bundle),
      headers: {
        "content-type": "application/json",
        authorization: "Bearer provider-free-upload-token",
      },
    });
    const first = await upload();
    assert.equal(first.status, 202);
    const firstBody = await first.json();
    assert.equal(firstBody.ownerApprovalRequired, true);
    assert.equal(Object.hasOwn(firstBody, "acceptedPath"), false, "server local pathをupload responseへ出さない");
    assert.equal(Object.hasOwn(firstBody, "candidatePath"), false, "server local pathをupload responseへ出さない");
    const duplicate = await upload();
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).duplicate, true);

    const malformed = await fetch(url, {
      method: "POST",
      body: "{not-json",
      headers: { authorization: "Bearer provider-free-upload-token" },
    });
    assert.equal(malformed.status, 400);
    assert.equal((await readdir(join(root, "quarantine"))).length, 1);
  } finally {
    if (server) await new Promise((resolveClose) => server.close(resolveClose));
    await rm(root, { recursive: true, force: true });
  }
});

test("candidate/import改変はowner承認とcurator読込の両境界でfail-closed", async (t) => {
  await t.test("candidate改変", async () => {
    const root = await mkdtemp(join(tmpdir(), "feedback-candidate-tamper-"));
    try {
      const pair = keys();
      await enroll(root, pair);
      const bundle = await signHarnessFeedbackBundle({ payload: payload(), privateKeyPem: pair.privateKeyPem });
      const receipt = await ingestHarnessFeedbackBundle({ rootDir: root, bundle });
      const candidate = JSON.parse(await readFile(receipt.candidatePath, "utf8"));
      candidate.proposals[0].occurrences = 999999;
      await writeFile(receipt.candidatePath, JSON.stringify(candidate));
      await assert.rejects(
        decideHarnessFeedbackBundle({
          rootDir: root,
          bundleDigest: receipt.bundleDigest,
          decision: "approve",
          approvedBy: "buzzassist-owner",
          reason: "改変されていない候補だけを承認するための確認",
        }),
        (error) => error?.code === "FEEDBACK_INGEST_STORAGE_TAMPER",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("approved import改変", async () => {
    const root = await mkdtemp(join(tmpdir(), "feedback-import-tamper-"));
    try {
      const pair = keys();
      await enroll(root, pair);
      const bundle = await signHarnessFeedbackBundle({ payload: payload(), privateKeyPem: pair.privateKeyPem });
      const receipt = await ingestHarnessFeedbackBundle({ rootDir: root, bundle });
      await decideHarnessFeedbackBundle({
        rootDir: root,
        bundleDigest: receipt.bundleDigest,
        decision: "approve",
        approvedBy: "buzzassist-owner",
        reason: "正しい候補をowner確認して観測へ昇格する",
      });
      const importPath = join(root, "imports", `${receipt.bundleDigest}.json`);
      const approvedImport = JSON.parse(await readFile(importPath, "utf8"));
      approvedImport.proposalObservations[0].occurrences = 999999;
      await writeFile(importPath, JSON.stringify(approvedImport));
      await assert.rejects(
        loadApprovedHarnessFeedbackImports({ rootDir: root }),
        (error) => error?.code === "FEEDBACK_INGEST_STORAGE_TAMPER",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("duplicate/owner decisionの再接続は欠損fileだけを同じ署名chainから修復する", async () => {
  const root = await mkdtemp(join(tmpdir(), "feedback-crash-repair-"));
  try {
    const pair = keys();
    await enroll(root, pair);
    const bundle = await signHarnessFeedbackBundle({ payload: payload(), privateKeyPem: pair.privateKeyPem });
    const first = await ingestHarnessFeedbackBundle({ rootDir: root, bundle });
    await Promise.all([
      unlink(first.acceptedPath),
      unlink(first.candidatePath),
      unlink(join(root, "sources", `${first.sourceReplayKey}.json`)),
    ]);
    const reattached = await ingestHarnessFeedbackBundle({ rootDir: root, bundle });
    assert.equal(reattached.duplicate, true);
    await Promise.all([
      readFile(first.acceptedPath),
      readFile(first.candidatePath),
      readFile(join(root, "sources", `${first.sourceReplayKey}.json`)),
    ]);
    const decisionArgs = {
      rootDir: root,
      bundleDigest: first.bundleDigest,
      decision: "approve",
      approvedBy: "buzzassist-owner",
      reason: "crash後も同じowner decisionからimportだけを修復する",
      decidedAt: "2026-09-01T04:00:00.000Z",
    };
    await decideHarnessFeedbackBundle(decisionArgs);
    const importPath = join(root, "imports", `${first.bundleDigest}.json`);
    await unlink(importPath);
    const repaired = await decideHarnessFeedbackBundle({
      ...decisionArgs,
      decidedAt: "2026-09-01T05:00:00.000Z",
    });
    assert.equal(repaired.attached, true);
    assert.equal((await loadApprovedHarnessFeedbackImports({ rootDir: root })).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("operator keyを失効して新鍵へrotationでき、旧鍵uploadは拒否する", async () => {
  const root = await mkdtemp(join(tmpdir(), "feedback-key-rotation-"));
  try {
    const firstPair = keys();
    const secondPair = keys();
    const firstEnrollment = await enroll(root, firstPair, "operator-rotate");
    const originalPayload = payload();
    const originalBundle = await signHarnessFeedbackBundle({ payload: originalPayload, privateKeyPem: firstPair.privateKeyPem });
    assert.equal((await ingestHarnessFeedbackBundle({ rootDir: root, bundle: originalBundle })).ok, true);
    await revokeHarnessFeedbackOperator({
      rootDir: root,
      operatorId: "operator-rotate",
      revokedBy: "buzzassist-owner",
      reason: "端末移行に伴い旧operator keyを失効する",
      revokedAt: "2026-09-01T05:00:00.000Z",
    });
    await assert.rejects(
      ingestHarnessFeedbackBundle({ rootDir: root, bundle: originalBundle }),
      (error) => error?.code === "FEEDBACK_SIGNER_NOT_ENROLLED",
    );
    const secondEnrollment = await enroll(root, secondPair, "operator-rotate");

    const rotatedReplay = await signHarnessFeedbackBundle({ payload: originalPayload, privateKeyPem: secondPair.privateKeyPem });
    await assert.rejects(
      ingestHarnessFeedbackBundle({ rootDir: root, bundle: rotatedReplay }),
      (error) => error?.code === "FEEDBACK_SOURCE_REPLAY_CONFLICT",
      "key rotationで同じoperator/source reportを再投入できない",
    );

    const nextPayload = payload({ occurrenceDigests: ["1".repeat(64), "2".repeat(64), "3".repeat(64)] });
    const nextBundle = await signHarnessFeedbackBundle({ payload: nextPayload, privateKeyPem: secondPair.privateKeyPem });
    assert.equal((await ingestHarnessFeedbackBundle({ rootDir: root, bundle: nextBundle })).ok, true);

    const revokedCurrent = await revokeHarnessFeedbackOperator({
      rootDir: root,
      operatorId: "operator-rotate",
      revokedBy: "buzzassist-owner",
      reason: "rotation後の現active keyを省略指定で失効する",
      revokedAt: "2026-09-01T06:00:00.000Z",
    });
    assert.equal(revokedCurrent.operator.keyId, secondEnrollment.operator.keyId);
    assert.notEqual(revokedCurrent.operator.keyId, firstEnrollment.operator.keyId);
    await assert.rejects(
      ingestHarnessFeedbackBundle({ rootDir: root, bundle: nextBundle }),
      (error) => error?.code === "FEEDBACK_SIGNER_NOT_ENROLLED",
    );
    await assert.rejects(
      revokeHarnessFeedbackOperator({
        rootDir: root,
        operatorId: "operator-rotate",
        revokedBy: "buzzassist-owner",
        reason: "履歴が複数なら対象keyを明示させる",
      }),
      (error) => error?.code === "FEEDBACK_OPERATOR_REVOKE_AMBIGUOUS",
    );
    const explicitRetry = await revokeHarnessFeedbackOperator({
      rootDir: root,
      operatorId: "operator-rotate",
      keyId: secondEnrollment.operator.keyId,
      revokedBy: "buzzassist-owner",
      reason: "失効済み現行keyへ明示的に再接続する",
    });
    assert.equal(explicitRetry.attached, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("署名検証後にrevokeが完了したuploadをlock内再認証で拒否する", async () => {
  const root = await mkdtemp(join(tmpdir(), "feedback-revoke-race-"));
  try {
    const pair = keys();
    await enroll(root, pair, "operator-race");
    const bundle = await signHarnessFeedbackBundle({ payload: payload(), privateKeyPem: pair.privateKeyPem });
    let verifiedResolve;
    let continueResolve;
    const verified = new Promise((resolveVerified) => { verifiedResolve = resolveVerified; });
    const continueIngest = new Promise((resolveContinue) => { continueResolve = resolveContinue; });
    const pending = ingestHarnessFeedbackBundle({
      rootDir: root,
      bundle,
      afterSignatureVerified: async () => {
        verifiedResolve();
        await continueIngest;
      },
    });
    await verified;
    await revokeHarnessFeedbackOperator({
      rootDir: root,
      operatorId: "operator-race",
      revokedBy: "buzzassist-owner",
      reason: "署名検証と保存の間に失効するraceを再現する",
    });
    continueResolve();
    await assert.rejects(pending, (error) => error?.code === "FEEDBACK_SIGNER_NOT_ENROLLED" && error?.statusCode === 403);
    for (const name of ["accepted", "curation", "sources", "receipts"]) {
      assert.equal((await readdir(root)).includes(name), false, `${name}へ失効後データを残さない`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("operator鍵の失効はapproveと承認済みimportの観測集計まで伝播する", async () => {
  const root = await mkdtemp(join(tmpdir(), "feedback-revoke-propagation-"));
  try {
    const pair = keys();
    await enroll(root, pair, "operator-revoked-later");
    // 2つのbundleを同じ鍵でingestし、片方は失効前にapprove済みにしておく。
    const approvedBundle = await signHarnessFeedbackBundle({ payload: payload(), privateKeyPem: pair.privateKeyPem });
    const approvedReceipt = await ingestHarnessFeedbackBundle({ rootDir: root, bundle: approvedBundle });
    await decideHarnessFeedbackBundle({
      rootDir: root,
      bundleDigest: approvedReceipt.bundleDigest,
      decision: "approve",
      approvedBy: "buzzassist-owner",
      reason: "失効前に正しい鍵で署名された候補を承認する",
      decidedAt: "2026-09-01T02:00:00.000Z",
    });
    const pendingBundle = await signHarnessFeedbackBundle({
      payload: payload({ occurrenceDigests: ["1".repeat(64), "2".repeat(64), "3".repeat(64)] }),
      privateKeyPem: pair.privateKeyPem,
    });
    const pendingReceipt = await ingestHarnessFeedbackBundle({ rootDir: root, bundle: pendingBundle });
    assert.equal(pendingReceipt.status, "verified-quarantine");
    assert.equal((await loadApprovedHarnessFeedbackImports({ rootDir: root })).length, 1);

    await revokeHarnessFeedbackOperator({
      rootDir: root,
      operatorId: "operator-revoked-later",
      revokedBy: "buzzassist-owner",
      reason: "端末紛失の疑いでoperator keyを失効する",
      revokedAt: "2026-09-01T03:00:00.000Z",
    });

    // 1) quarantine中のbundleは失効後にapproveできない（reject理由コード付き）。
    await assert.rejects(
      decideHarnessFeedbackBundle({
        rootDir: root,
        bundleDigest: pendingReceipt.bundleDigest,
        decision: "approve",
        approvedBy: "buzzassist-owner",
        reason: "失効した鍵の署名を後から信用しようとする",
        decidedAt: "2026-09-01T04:00:00.000Z",
      }),
      (error) => error?.code === "FEEDBACK_SIGNER_REVOKED" && error?.statusCode === 403,
    );
    assert.equal((await readdir(root)).includes("decisions") && (await readdir(join(root, "decisions"))).includes(`${pendingReceipt.bundleDigest}.json`), false,
      "失効後のapproveはowner decisionを残さない");
    assert.equal((await readdir(join(root, "imports"))).includes(`${pendingReceipt.bundleDigest}.json`), false);

    // rejectは失効後も記録できる（無害な向きのdecisionは塞がない）。
    const rejected = await decideHarnessFeedbackBundle({
      rootDir: root,
      bundleDigest: pendingReceipt.bundleDigest,
      decision: "reject",
      approvedBy: "buzzassist-owner",
      reason: "失効鍵で署名されたquarantine候補を明示的に却下する",
      decidedAt: "2026-09-01T04:30:00.000Z",
    });
    assert.equal(rejected.decision, "reject");

    // 2) 失効前にapprove済みだったbundleは観測集計から外れ、revoked-after-approvalとして分離される。
    const imports = await loadApprovedHarnessFeedbackImports({ rootDir: root });
    assert.equal(imports.length, 0, "失効した鍵のimportはcurator観測へ数えない");
    const ledger = await loadHarnessFeedbackImportLedger({ rootDir: root });
    assert.equal(ledger.approved.length, 0);
    assert.equal(ledger.revokedAfterApproval.length, 1);
    assert.equal(ledger.revokedAfterApproval[0].bundleDigest, approvedReceipt.bundleDigest);
    assert.equal(ledger.revokedAfterApproval[0].status, "revoked-after-approval");
    assert.equal(ledger.revokedAfterApproval[0].signer.revokedAt, "2026-09-01T03:00:00.000Z");
    assert.equal(Object.hasOwn(ledger.revokedAfterApproval[0], "proposalObservations"), false,
      "分離記録に観測本体を載せて再集計の入口を残さない");

    // approve済みdecisionの再接続（import修復）も失効後は拒否する。
    await assert.rejects(
      decideHarnessFeedbackBundle({
        rootDir: root,
        bundleDigest: approvedReceipt.bundleDigest,
        decision: "approve",
        approvedBy: "buzzassist-owner",
        reason: "失効前に正しい鍵で署名された候補を承認する",
        decidedAt: "2026-09-01T05:00:00.000Z",
      }),
      (error) => error?.code === "FEEDBACK_SIGNER_REVOKED",
    );

    // 3) 新鍵へrotationしても、旧鍵で署名されたbundleは復活しない（例外承認経路は無い）。
    await enroll(root, keys(), "operator-revoked-later");
    assert.equal((await loadApprovedHarnessFeedbackImports({ rootDir: root })).length, 0);
    await assert.rejects(
      decideHarnessFeedbackBundle({
        rootDir: root,
        bundleDigest: approvedReceipt.bundleDigest,
        decision: "approve",
        approvedBy: "buzzassist-owner",
        reason: "失効前に正しい鍵で署名された候補を承認する",
      }),
      (error) => error?.code === "FEEDBACK_SIGNER_REVOKED",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
