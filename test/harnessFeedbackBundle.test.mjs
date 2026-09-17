import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  buildHarnessFeedbackPayload,
  feedbackProposalId,
  signHarnessFeedbackBundle,
  verifyHarnessFeedbackBundle,
} from "../lib/harnessFeedbackBundle.mjs";

function keys() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }),
  };
}

function fixture() {
  const proposal = {
    kind: "constraint",
    target: "genre:narrated-story-video",
    text: "台本から完成動画までの制作hot pathへYouTube Analyticsやyt-quality-loopを混ぜない",
  };
  return buildHarnessFeedbackPayload({
    curatorReport: {
      readOnly: true,
      pending: [{
        id: feedbackProposalId(proposal),
        ...proposal,
        occurrences: 2,
        localOccurrenceDigests: ["1".repeat(64), "2".repeat(64)],
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
    channelPack: { id: "operator-pack", version: "1.0.0", payloadSha256: "d".repeat(64) },
    sourceHost: "codex",
    generatedAt: "2026-09-01T00:00:00.000Z",
  });
}

test("feedback bundle removes raw text and verifies with an external key", async () => {
  const { privateKeyPem, publicKeyPem } = keys();
  const payload = fixture();
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes("台本から完成動画まで"), false);
  const signed = await signHarnessFeedbackBundle({ payload, privateKeyPem });
  const result = await verifyHarnessFeedbackBundle({
    bundle: signed,
    trustedPublicKeyPem: publicKeyPem,
    expectedHarnessId: "narrated-story-video",
    expectedCoreVersion: "0.1.25",
  });
  assert.equal(result.ok, true);
  assert.equal(result.proposalCount, 1);
  assert.equal(result.observedGateCount, 1);
});

test("tampering and forbidden fields fail closed", async () => {
  const { privateKeyPem, publicKeyPem } = keys();
  const signed = await signHarnessFeedbackBundle({ payload: fixture(), privateKeyPem });
  signed.proposals[0].occurrences = 999;
  await assert.rejects(
    verifyHarnessFeedbackBundle({ bundle: signed, trustedPublicKeyPem: publicKeyPem }),
    /署名が一致しない|semantic feedback snapshot|occurrenceDigests件数/u,
  );
  await assert.rejects(
    signHarnessFeedbackBundle({ payload: { ...fixture(), apiKey: "must-not-leak" }, privateKeyPem }),
    /未許可field|含められない/u,
  );
});

test("署名前にnested schemaを正規化し、未知fieldや型coercionを拒否する", async () => {
  const { privateKeyPem } = keys();
  const nestedBuildField = structuredClone(fixture());
  nestedBuildField.build.note = "OPENAI_API_KEY=must-not-leak";
  await assert.rejects(
    signHarnessFeedbackBundle({ payload: nestedBuildField, privateKeyPem }),
    /buildに未許可field: note/u,
  );

  const proposalText = structuredClone(fixture());
  proposalText.proposals[0].text = "署名対象へ戻してはいけない本文";
  await assert.rejects(
    signHarnessFeedbackBundle({ payload: proposalText, privateKeyPem }),
    /proposalに未許可field: text/u,
  );

  const coercedCount = structuredClone(fixture());
  coercedCount.observedGates[0].pass = "1";
  await assert.rejects(
    signHarnessFeedbackBundle({ payload: coercedCount, privateKeyPem }),
    /gate\.passは0\.\.1000000000の整数/u,
  );

  const duplicateProposal = structuredClone(fixture());
  duplicateProposal.proposals.push(structuredClone(duplicateProposal.proposals[0]));
  await assert.rejects(
    signHarnessFeedbackBundle({ payload: duplicateProposal, privateKeyPem }),
    /proposal IDが重複/u,
  );

  const duplicateGate = structuredClone(fixture());
  duplicateGate.observedGates.push(structuredClone(duplicateGate.observedGates[0]));
  await assert.rejects(
    signHarnessFeedbackBundle({ payload: duplicateGate, privateKeyPem }),
    /observed gate IDが重複/u,
  );

  const semanticExfiltration = structuredClone(fixture());
  semanticExfiltration.proposals[0].id = Buffer.from("RAW_SCRIPT: API_TOKEN=secret").toString("base64url");
  await assert.rejects(
    signHarnessFeedbackBundle({ payload: semanticExfiltration, privateKeyPem }),
    /12桁lowercase hex/u,
    "自由なID fieldをraw/base64本文の搬送路にできない",
  );
});

test("buildの自由文字列fieldをcredential搬送路にしない", async () => {
  const { privateKeyPem } = keys();
  const cases = [
    ["coreVersion", (value) => { value.build.coreVersion = "eyJabcdefghijk.abcdefghijk.signature"; }],
    ["harnessVersion", (value) => { value.build.harnessVersion = "Bearer.secretvalue"; }],
    ["channelPack.id", (value) => { value.build.channelPack.id = "sk-proj-EXFILTRATED12345"; }],
    ["channelPack.version", (value) => { value.build.channelPack.version = "Bearer.secretvalue"; }],
  ];
  for (const [label, mutate] of cases) {
    const candidate = structuredClone(fixture());
    mutate(candidate);
    await assert.rejects(
      signHarnessFeedbackBundle({ payload: candidate, privateKeyPem }),
      /credentialらしい値/u,
      `${label}をsecret搬送路にできない`,
    );
  }
});

test("署名済みpayloadの空白・hex大小・配列順をcovert channelにしない", async () => {
  const { privateKeyPem, publicKeyPem } = keys();
  const canonical = await signHarnessFeedbackBundle({ payload: fixture(), privateKeyPem });
  const cases = [
    (value) => { value.build.channelPack.id = `${value.build.channelPack.id} \t`; },
    (value) => { value.build.channelPack.payloadSha256 = value.build.channelPack.payloadSha256.toUpperCase(); },
    (value) => { value.proposals[0].evidenceDigests.push(value.proposals[0].evidenceDigests[0]); },
    (value) => { value.build.skillDigests = ["e".repeat(64), ...value.build.skillDigests]; },
  ];
  for (const mutate of cases) {
    const changed = structuredClone(canonical);
    mutate(changed);
    await assert.rejects(
      verifyHarnessFeedbackBundle({ bundle: changed, trustedPublicKeyPem: publicKeyPem }),
      /canonical表現|semantic feedback snapshot|署名が一致しない/u,
    );
  }
});

test("catalog未登録の提案はbundleへ入れず、匿名化した草案としてbundle外へ出す", async () => {
  const {
    buildUnregisteredProposalDraft,
    parseHarnessFeedbackProposalCatalog,
    partitionCuratorPendingByCatalog,
  } = await import("../lib/harnessFeedbackBundle.mjs");
  const catalog = parseHarnessFeedbackProposalCatalog(
    '{"id":"6edb2451ffe2","kind":"constraint","target":"genre:narrated-story-video"}\n'
    + '{"id":"aaaaaaaaaaaa","kind":"fact","target":"platform:platform-craft"}\n',
  );
  const privateTerm = ["架空", "アルファ"].join("");
  const localPath = ["", "Users", "private-builder", "work", "notes.md"].join("/");
  const flattenedPath = ["", "Users", "private-builder", "work"].join("-");
  const novel = {
    kind: "fact",
    target: "genre:manga-video-production",
    text: `${privateTerm} の参照は ${localPath} と ~/.codex/cache と ${flattenedPath} を見る`,
  };
  const pending = [
    { id: "6edb2451ffe2", kind: "constraint", target: "genre:narrated-story-video", text: "既知", localOccurrenceDigests: ["1".repeat(64)], evidenceDigests: [] },
    { id: "aaaaaaaaaaaa", kind: "correction", target: "platform:platform-craft", text: "kind違い", localOccurrenceDigests: ["2".repeat(64)], evidenceDigests: [] },
    { id: feedbackProposalId(novel), ...novel, session: "operator-session", evidence: ["逐語の根拠"], localOccurrenceDigests: ["3".repeat(64), "4".repeat(64)], evidenceDigests: ["a".repeat(64)], firstSeenAt: "2026-09-05T00:00:00.000Z", lastSeenAt: "2026-09-05T00:00:00.000Z" },
    { id: "bbbbbbbbbbbb", kind: "fact", target: "channel-pack:koya", text: "番組固有", localOccurrenceDigests: ["5".repeat(64)], evidenceDigests: [] },
  ];
  const partition = partitionCuratorPendingByCatalog({ curatorReport: { readOnly: true, pending, observedGates: [] }, catalog });
  assert.deepEqual(partition.registered.map((entry) => entry.id), ["6edb2451ffe2"]);
  assert.deepEqual(partition.semanticMismatch.map((entry) => entry.id), ["aaaaaaaaaaaa"]);
  assert.deepEqual(partition.unregistered.map((entry) => entry.id).sort(), [feedbackProposalId(novel), "bbbbbbbbbbbb"].sort());
  assert.deepEqual(partition.registeredReport.pending.map((entry) => entry.id), ["6edb2451ffe2"], "bundleへ渡すreportは既知IDだけ");

  const draft = buildUnregisteredProposalDraft({
    ...partition,
    catalogSha256: "f".repeat(64),
    build: { coreVersion: "0.1.25", harnessId: "koya-manga-video", harnessVersion: "1.1.0" },
    sourceHost: "codex",
    signals: { terms: [privateTerm], castIds: [] },
    homeRoot: ["", "Users", "private-builder"].join("/"),
    generatedAt: "2026-09-05T00:00:00.000Z",
  });
  const serialized = JSON.stringify(draft);
  assert.equal(draft.transmittedInBundle, false);
  assert.equal(draft.writesCanonical, false);
  assert.equal(draft.counts.candidates, 1, "channel-pack宛は草案にも出さない");
  assert.equal(draft.counts.confidentialExcluded, 1);
  assert.deepEqual(draft.semanticMismatchIds, ["aaaaaaaaaaaa"]);
  assert.equal(serialized.includes("番組固有"), false);
  assert.equal(serialized.includes("逐語の根拠"), false, "evidence本文は草案に出さない");
  assert.equal(serialized.includes("operator-session"), false);
  assert.equal(serialized.includes(privateTerm), false);
  assert.equal(serialized.includes("private-builder"), false);
  assert.equal(draft.candidates[0].redactionHits, 4);
  assert.equal(draft.candidates[0].occurrences, 2);
  assert.match(draft.candidates[0].redactedText, /<channel-term> の参照は <machine-path> と <machine-path> と <machine-path> を見る/u);
});

test("redactSharedLearningText は overlay 生成経路から使える形で端末path・credential・Channel Pack語を置換する", async () => {
  const { redactSharedLearningText } = await import("../lib/harnessFeedbackBundle.mjs");
  const term = ["非", "公開", "キャスト"].join("");
  const scratch = ["/private/tmp/", "scratch-", "777", "/old"].join("");
  const input = `根拠: client-work/x/report.md を ${scratch} で確認。${term}のOL衣装。Bearer abcdefghijklmnop。掃除先 ~/.codex/generated`;
  const { text, hits } = redactSharedLearningText(input, { terms: [term], castIds: ["castx"], homeRoot: "/Users/someone" });
  assert.equal(text.includes(scratch), false);
  assert.equal(text.includes(term), false);
  assert.equal(text.includes("abcdefghijklmnop"), false);
  assert.equal(text.includes("~/.codex"), false);
  assert.match(text, /<machine-path> で確認。<channel-term>のOL衣装。<credential>。掃除先 <machine-path>/u);
  assert.equal(hits, 4);
  // 語彙が無いときは path と credential だけ。固有名詞の除去は保証しない（evidence を落とす方が確実）
  assert.equal(redactSharedLearningText(`${term}は残る`, {}).text, `${term}は残る`);
});
