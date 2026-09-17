import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHarnessCuratorReport,
  dedupeProposalOccurrences,
  textSimilarity,
} from "../lib/harnessLearningCurator.mjs";

const base = {
  id: "same-proposal",
  kind: "fact",
  target: "platform:platform-craft",
  text: "課金APIは同じrequest keyで二重送信しない",
  evidence: "fixture evidence",
};

test("同じproposal・同じsessionの再捕捉をoccurrenceとして水増ししない", () => {
  const rows = [
    { ...base, session: "s1", capturedAt: "2026-09-01T00:00:00Z" },
    { ...base, session: "s1", capturedAt: "2026-09-01T00:01:00Z", evidence: "second evidence" },
    { ...base, session: "s2", capturedAt: "2026-09-02T00:00:00Z" },
  ];
  const deduped = dedupeProposalOccurrences(rows);
  assert.equal(deduped.length, 2);
  const report = buildHarnessCuratorReport({ proposals: rows, generatedAt: "2026-09-03T00:00:00Z" });
  assert.equal(report.counts.rawProposalRows, 3);
  assert.equal(report.counts.uniqueSessionOccurrences, 2);
  assert.equal(report.pending[0].occurrences, 2);
  assert.equal(report.readOnly, true);
  assert.equal(report.writesCanonical, false);
});

test("類似提案は統合候補にするが、RunReceiptの実測gateとは混ぜない", () => {
  const proposals = [
    { ...base, id: "p1", session: "s1", text: "課金APIは同じrequest keyで二重送信しない" },
    { ...base, id: "p2", session: "s2", text: "課金APIは同じrequest keyなら二重送信を止める" },
  ];
  const receipt = {
    file: "fixture.json",
    receipt: {
      finalized: true,
      outcome: "fail",
      harnessBuild: {
        harness: { id: "fixture", version: "1.0.0", declarationDigest: "a".repeat(64) },
        genreSkills: {},
      },
      gates: { audio: { verdict: "fail" } },
    },
  };
  assert.ok(textSimilarity(proposals[0].text, proposals[1].text) > 0.42);
  const report = buildHarnessCuratorReport({ proposals, receipts: [receipt] });
  assert.equal(report.semanticClusters[0].classification, "similar-proposals");
  assert.equal(report.observedGates[0].source, "run-receipt");
  assert.equal(report.observedGates[0].gateId, "audio");
  assert.equal(report.pending.some((entry) => entry.id === "audio"), false);
});

test("owner承認済みremote feedbackは既知proposalの観測数だけを加算し、未知IDから本文を捏造しない", () => {
  const proposals = [{ ...base, id: "known", session: "local-1" }];
  const approvedFeedbackImports = [{
    bundleDigest: "b".repeat(64),
    operator: { operatorId: "operator-1", signerKeyId: "key-1" },
    proposalObservations: [
      {
        proposalId: "known",
        kind: "fact",
        target: "platform:platform-craft",
        occurrences: 3,
        occurrenceDigests: ["1".repeat(64), "2".repeat(64), "3".repeat(64)],
        evidenceDigests: ["c".repeat(64)],
      },
      {
        proposalId: "remote-only",
        kind: "correction",
        target: "genre:narrated-story-video",
        occurrences: 2,
        occurrenceDigests: ["4".repeat(64), "5".repeat(64)],
        evidenceDigests: ["d".repeat(64)],
      },
    ],
    gateObservations: [{
      harnessId: "narrated-story-video",
      harnessVersion: "1.2.0",
      declarationDigest: "e".repeat(64),
      gateId: "full-decode",
      pass: 1,
      fail: 0,
      skip: 0,
    }],
  }];
  const report = buildHarnessCuratorReport({ proposals, approvedFeedbackImports });
  assert.equal(report.pending[0].localOccurrences, 1);
  assert.equal(report.pending[0].approvedRemoteOccurrences, 3);
  assert.equal(report.pending[0].occurrences, 4);
  assert.deepEqual(report.unmatchedRemoteProposalIds, ["remote-only"]);
  assert.equal(report.pending.some((entry) => entry.id === "remote-only"), false);
  assert.equal(report.approvedRemoteGateObservations[0].source, "owner-approved-feedback-bundle");
  assert.equal(report.observedGates.length, 0, "remote gateをlocal RunReceipt実測へ混ぜない");
});

test("同じoperatorの累積snapshotを複数回承認してもoccurrenceをset-unionする", () => {
  const proposals = [{ ...base, id: "known", session: "local-1" }];
  const makeImport = (bundleDigest, digests) => ({
    bundleDigest,
    operator: { operatorId: "operator-1", signerKeyId: "key-1" },
    proposalObservations: [{
      proposalId: "known",
      kind: "fact",
      target: "platform:platform-craft",
      occurrences: digests.length,
      occurrenceDigests: digests,
      evidenceDigests: [],
    }],
    gateObservations: [],
  });
  const report = buildHarnessCuratorReport({
    proposals,
    approvedFeedbackImports: [
      makeImport("a".repeat(64), ["1".repeat(64), "2".repeat(64)]),
      makeImport("b".repeat(64), ["1".repeat(64), "2".repeat(64), "3".repeat(64)]),
    ],
  });
  assert.equal(report.pending[0].localOccurrences, 1);
  assert.equal(report.pending[0].approvedRemoteOccurrences, 3);
  assert.equal(report.pending[0].occurrences, 4);
  assert.equal(report.counts.approvedRemoteProposalObservations, 3);
});

test("公開catalogはid/kind/targetだけを持ち、channel-pack宛と別semanticの同一IDを通さない", async () => {
  const {
    PUBLIC_PROPOSAL_CATALOG_KEYS,
    buildPublicProposalCatalog,
    comparePublicProposalCatalog,
    parsePublicProposalCatalog,
    renderPublicProposalCatalog,
  } = await import("../lib/harnessLearningCurator.mjs");
  const privateText = ["運営者", "名", "と", "顧客", "path"].join("");
  const rows = [
    { id: "0123456789ab", kind: "fact", target: "skill:manga-video-production", text: privateText, evidence: ["", "Users", "private-builder", "x"].join("/"), session: "s1" },
    { id: "0123456789ab", kind: "fact", target: "genre:manga-video-production", text: privateText, session: "s2" },
    { id: "ba9876543210", kind: "correction", target: "channel-pack:koya", text: "番組固有", session: "s3" },
    { id: "ffffffffffff", kind: "constraint", target: "platform:platform-craft", text: "共通", session: "s4" },
  ];
  const catalog = buildPublicProposalCatalog(rows);
  assert.deepEqual(catalog.entries, [
    { id: "0123456789ab", kind: "fact", target: "genre:manga-video-production" },
    { id: "ffffffffffff", kind: "constraint", target: "platform:platform-craft" },
  ], "旧alias targetは正規化し、同じIDは1行に畳み、channel-pack宛は出さない");
  assert.equal(catalog.counts.confidentialExcluded, 1);
  const rendered = renderPublicProposalCatalog(catalog.entries);
  assert.equal(rendered.includes(privateText), false);
  assert.equal(rendered.includes("private-builder"), false);
  for (const line of rendered.trim().split("\n")) {
    assert.deepEqual(Object.keys(JSON.parse(line)), [...PUBLIC_PROPOSAL_CATALOG_KEYS]);
  }
  assert.equal(comparePublicProposalCatalog({ ledgerRows: rows, catalogText: rendered }).ok, true);

  assert.throws(() => buildPublicProposalCatalog([
    ...rows,
    { id: "0123456789ab", kind: "correction", target: "genre:manga-video-production", text: "別semantic", session: "s5" },
  ]), /同じIDが別のkind\/target/u);
  assert.throws(() => parsePublicProposalCatalog('{"id":"0123456789ab","kind":"fact","target":"genre:manga-video-production","text":"本文"}\n'), /許可外field/u);
  assert.throws(() => parsePublicProposalCatalog('{"id":"0123456789ab","kind":"fact","target":"channel-pack:koya"}\n'), /不正/u);

  const stale = comparePublicProposalCatalog({
    ledgerRows: [...rows, { id: "abcdefabcdef", kind: "fact", target: "platform:platform-craft", text: "新規", session: "s6" }],
    catalogText: rendered,
  });
  assert.equal(stale.ok, false);
  assert.deepEqual(stale.missing, ["abcdefabcdef"]);
});

test("失効鍵のimportはrevoked-after-approvalとして分離し、観測数へ加算しない", () => {
  const proposals = [{ ...base, id: "known", session: "local-1" }];
  const observation = {
    proposalId: "known",
    kind: "fact",
    target: "platform:platform-craft",
    occurrences: 2,
    occurrenceDigests: ["1".repeat(64), "2".repeat(64)],
    evidenceDigests: [],
  };
  const report = buildHarnessCuratorReport({
    proposals,
    approvedFeedbackImports: [
      {
        bundleDigest: "a".repeat(64),
        operator: { operatorId: "operator-1", signerKeyId: "key-1" },
        proposalObservations: [observation],
        gateObservations: [{ harnessId: "h", harnessVersion: "1.0.0", declarationDigest: "e".repeat(64), gateId: "g", pass: 1, fail: 0, skip: 0 }],
      },
      // 呼び出し側の取り違えで失効済みが混ざっても、curatorは自分で弾く。
      {
        bundleDigest: "b".repeat(64),
        status: "revoked-after-approval",
        operator: { operatorId: "operator-2", signerKeyId: "key-2" },
        proposalObservations: [{ ...observation, occurrenceDigests: ["3".repeat(64), "4".repeat(64)] }],
        gateObservations: [{ harnessId: "h", harnessVersion: "1.0.0", declarationDigest: "e".repeat(64), gateId: "g", pass: 0, fail: 1, skip: 0 }],
      },
    ],
    revokedFeedbackImports: [{
      bundleDigest: "c".repeat(64),
      status: "revoked-after-approval",
      operator: { operatorId: "operator-3", signerKeyId: "key-3" },
      signer: { keyId: "key-3", status: "revoked", revokedAt: "2026-09-01T03:00:00.000Z" },
    }],
  });
  assert.equal(report.pending[0].approvedRemoteOccurrences, 2, "active鍵のimportだけを数える");
  assert.equal(report.pending[0].occurrences, 3);
  assert.equal(report.counts.approvedFeedbackImports, 1);
  assert.equal(report.counts.revokedAfterApprovalImports, 2);
  assert.deepEqual(report.revokedAfterApprovalImports.map((entry) => entry.bundleDigest), ["b".repeat(64), "c".repeat(64)]);
  assert.equal(report.approvedRemoteGateObservations.length, 1, "失効鍵のgate観測も混ぜない");
  assert.equal(JSON.stringify(report.revokedAfterApprovalImports).includes("occurrenceDigests"), false,
    "分離記録は観測本体を持たない");
});

test("revoked-after-approvalの報告記録はdigest/operator/keyId/revokedAtだけを持つ", () => {
  const report = buildHarnessCuratorReport({
    proposals: [{ ...base, session: "local-1" }],
    revokedFeedbackImports: [{
      bundleDigest: "d".repeat(64),
      candidateDigest: "f".repeat(64),
      status: "revoked-after-approval",
      approvedBy: "owner-should-not-leak",
      approvedAt: "2026-08-30T00:00:00.000Z",
      operator: { operatorId: "operator-4", signerKeyId: "key-4", displayName: "should-not-leak" },
      signer: { keyId: "key-4", status: "revoked", revokedAt: "2026-09-02T00:00:00.000Z", revokedBy: "owner" },
      proposalObservations: [{ proposalId: "same-proposal", occurrenceDigests: ["9".repeat(64)] }],
    }],
  });
  assert.equal(report.counts.revokedAfterApprovalImports, 1);
  assert.deepEqual(report.revokedAfterApprovalImports, [{
    status: "revoked-after-approval",
    bundleDigest: "d".repeat(64),
    operatorId: "operator-4",
    signerKeyId: "key-4",
    revokedAt: "2026-09-02T00:00:00.000Z",
  }]);
  assert.equal(report.pending[0].occurrences, 1, "失効importの観測は数えない");
});
