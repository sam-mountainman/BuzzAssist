import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";

import {
  AUTO_ASSET_QUALITY_CREATOR,
  AUTO_ASSET_QUALITY_EVIDENCE_TAG,
  assetHumanRejectionCandidates,
  assetRoundLearningCandidates,
  captureAssetLearning,
} from "../lib/assetQualityLearning.mjs";
import {
  APPROVED_REFERENCES_VERSION,
  createAssetQualityContract,
  recordAssetHumanVerification,
  recordAssetQualityRound,
  startAssetQualityLoop,
} from "../lib/assetQualityLoop.mjs";
import { childAgentEnvironment } from "../lib/harnessLearningGuard.mjs";
import { HARNESS_LEARNING_ROUTES } from "../lib/harnessLearningTargets.mjs";
import { PROPOSAL_METADATA_CREATORS, ledgerPathFor, loadTargets } from "../scripts/harness-learn.mjs";

// 対象 id・所見・パスはすべて合成の値。本文・所見・対象 id が提案へ運ばれないことを確かめるために置く。
const sha = (value) => createHash("sha256").update(value).digest("hex");
const SUBJECT = "synthetic-subject-q7";
const NOTES = "合成の所見: 左手の指が二本に見える";
const FINGERPRINT = "quality-failure:abcdefabcdefabcdefabcdef";
const { contract: CHARACTER } = createAssetQualityContract({ harnessId: "koya-manga-video", stage: "character" });

let clock = Date.parse("2026-09-25T00:00:00.000Z");
const now = () => {
  clock += 60_000;
  return new Date(clock).toISOString();
};

function captureHarness() {
  const rows = [];
  return {
    rows,
    options: {
      signals: { terms: [], castIds: [] },
      privateVocabulary: null,
      homeRoot: "",
      env: {},
      ledgerPathResolver: (target, kind) => (String(target).startsWith("channel-pack:")
        ? join(tmpdir(), "synthetic-private-channel", `${kind}.jsonl`)
        : join(tmpdir(), "synthetic-public-core", "docs", "learning", `${kind}.jsonl`)),
      append: (_file, entry) => rows.push(entry),
      read: () => rows,
      lock: (_file, action) => action(),
      refreshCatalog: () => ({ written: false }),
    },
  };
}

function failingRound(overrides = {}) {
  const state = {
    status: "active",
    stopReason: "",
    contractDigest: CHARACTER.digest,
    startedAt: "2026-09-25T00:00:00.000Z",
    asset: { harnessId: "koya-manga-video", stage: "character", subjectId: SUBJECT, versions: [] },
    ...overrides.state,
  };
  const round = {
    index: 2,
    score: 81.5,
    floorFailures: ["identity-match"],
    failedGateIds: ["reference-approved"],
    failureFingerprint: FINGERPRINT,
    reviewDigest: sha("review"),
    reviews: [{ notes: NOTES }],
    ...overrides.round,
  };
  const version = {
    label: "v2-synthetic",
    assetPath: "assets/private-folder/v2.png",
    assetSha256: sha("asset-v2"),
    findings: [NOTES],
    ...overrides.version,
  };
  return { state, round, version, contract: CHARACTER };
}

test("学習の宛先は、そのハーネスの Channel Pack の非公開台帳（共有の learning 台帳と分かれている）", () => {
  for (const [harnessId, packId] of [["koya-manga-video", "koya"], ["narrated-story-video", "narrated-story"]]) {
    const target = HARNESS_LEARNING_ROUTES[harnessId].channel;
    assert.equal(target, `channel-pack:${packId}`);
    const definition = loadTargets()[target];
    assert.equal(definition.scope, "channel-pack");
    assert.equal(definition.confidential, true);
    assert.equal(definition.mode, "review-only");
    assert.ok(ledgerPathFor(target).includes(["channel-packs", packId].join(sep)), ledgerPathFor(target));
    assert.notEqual(ledgerPathFor(target), ledgerPathFor("genre:manga-video-production"));
  }
});

test("不合格の回からは、工程・失敗指紋・評価項目 id・機械ゲート id だけの候補を1件作る（件数は evidence 側）", () => {
  const candidates = assetRoundLearningCandidates(failingRound());
  assert.equal(candidates.length, 1);
  const [candidate] = candidates;
  for (const forbidden of [SUBJECT, "subject-q7", "合成の所見", "指が二本", "81.5", "v2-synthetic", "private-folder", "assets/"]) {
    assert.equal(candidate.text.includes(forbidden), false, `本文に ${forbidden} が運ばれた`);
  }
  assert.ok(candidate.text.includes("人物の設定画"));
  assert.ok(candidate.text.includes(FINGERPRINT));
  assert.ok(candidate.text.includes("下限割れ: identity-match"));
  assert.ok(candidate.text.includes("機械ゲート: reference-approved"));
  assert.deepEqual(candidate.gateIds, ["identity-match", "reference-approved"]);
  assert.deepEqual(candidate.counts, { floors: 1, gates: 1 });
  // 止まったループは止まった理由のコードも本文に入る。合格した回からは何も作らない。
  const stopped = assetRoundLearningCandidates(failingRound({ state: { status: "needs-human-approval", stopReason: "round-limit" } }));
  assert.match(stopped[0].text, /needs-human-approval（round-limit）で止まった/u);
  assert.deepEqual(assetRoundLearningCandidates(failingRound({ state: { status: "passed" } })), []);
  // 人の確認の否は欄ごとに1件。
  const human = assetHumanRejectionCandidates({
    state: failingRound().state,
    version: null,
    verifications: [{ check: "hand-safety", verdict: "reject", assetSha256: sha("x") }, { check: "identity", verdict: "pass" }],
    contract: CHARACTER,
  });
  assert.equal(human.length, 1);
  assert.match(human[0].text, /人の確認（hand-safety）が否だった（評価者の採点: 未採点）/u);
  assert.deepEqual(human[0].gateIds, ["human-hand-safety"]);
});

test("Channel Pack の台帳へ積み、同じ失敗指紋を同じ版から二重に積まない（別の版なら同じ提案の再発）", async () => {
  const harness = captureHarness();
  const input = failingRound();
  const first = await captureAssetLearning({ event: "round", ...input, env: {}, now, captureOptions: harness.options });
  assert.equal(first.target, "channel-pack:koya");
  assert.equal(first.captured, 1);
  const [row] = harness.rows;
  assert.equal(row.target, "channel-pack:koya");
  assert.equal(row.kind, "fact");
  assert.match(row.evidence, new RegExp(`^${AUTO_ASSET_QUALITY_EVIDENCE_TAG} source=asset-quality-round harness=koya-manga-video stage=character round=2 floors=1 gates=1 `, "u"));
  assert.ok(row.session.startsWith(`${AUTO_ASSET_QUALITY_CREATOR}:`));
  assert.deepEqual(row.gateIds, ["identity-match", "reference-approved"]);
  assert.equal(row.harness.id, "koya-manga-video");
  assert.equal(row.receiptDigest.length, 64);
  // 捕捉経路の印は、harness-learn の許可一覧にあるときだけ付く（無い値は台帳が拒否する）。
  assert.equal(row.createdBy, PROPOSAL_METADATA_CREATORS.has(AUTO_ASSET_QUALITY_CREATOR) ? AUTO_ASSET_QUALITY_CREATOR : undefined);
  const serialized = JSON.stringify(row);
  for (const forbidden of [SUBJECT, "合成の所見", "private-folder", "v2-synthetic"]) {
    assert.equal(serialized.includes(forbidden), false, `台帳へ ${forbidden} が運ばれた`);
  }

  const again = await captureAssetLearning({ event: "round", ...input, env: {}, now, captureOptions: harness.options });
  assert.equal(again.captured, 0);
  assert.equal(again.duplicates, 1);
  assert.equal(harness.rows.length, 1, "同じ版・同じ指紋は二重に積まない");

  const nextVersion = await captureAssetLearning({
    event: "round", ...failingRound({ round: { index: 3 }, version: { label: "v3-synthetic", assetSha256: sha("asset-v3") } }), env: {}, now, captureOptions: harness.options,
  });
  assert.equal(nextVersion.captured, 1);
  assert.equal(harness.rows[1].id, harness.rows[0].id, "同じ失敗指紋は同じ提案の再発として数える");
  assert.notEqual(harness.rows[1].session, harness.rows[0].session);

  // ナレーション物語のハーネスは、そのチャンネルの台帳へ。
  const narrated = await captureAssetLearning({
    event: "round", ...failingRound({ state: { asset: { harnessId: "narrated-story-video", stage: "thumbnail", subjectId: SUBJECT } } }),
    contract: createAssetQualityContract({ harnessId: "narrated-story-video", stage: "thumbnail" }).contract,
    env: {}, now, captureOptions: harness.options,
  });
  assert.equal(narrated.target, "channel-pack:narrated-story");
  assert.match(harness.rows.at(-1).text, /サムネ/u);
});

test("子エージェント・自動捕捉の停止・合格した回では積まない。台帳が分離されていなければ理由を返す", async () => {
  const harness = captureHarness();
  assert.equal((await captureAssetLearning({ ...failingRound(), env: childAgentEnvironment({}), captureOptions: harness.options })).skippedReason, "child-agent");
  assert.equal((await captureAssetLearning({ ...failingRound(), env: { BUZZASSIST_LEARNING_AUTO_CAPTURE: "0" }, captureOptions: harness.options })).skippedReason, "disabled");
  assert.equal((await captureAssetLearning({ ...failingRound({ state: { status: "passed" } }), env: {}, captureOptions: harness.options })).skippedReason, "passed");
  assert.equal(harness.rows.length, 0);
  const refused = await captureAssetLearning({
    ...failingRound(),
    env: {},
    capture: () => { throw new Error("Channel Pack proposal台帳が共有learning台帳から分離されていない。"); },
  });
  assert.equal(refused.skippedReason, "ledger-not-isolated");
});

test("品質ループの record は不合格の回でだけ、verify は人の確認の否でだけ学習の捕捉を呼ぶ", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "asset-quality-learning-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ["assets", "reviews", "refs"]) await mkdir(join(root, dir), { recursive: true });
  const png = (salt) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`synthetic-${salt}`)]);
  const reference = join(root, "refs", "sheet.png");
  await writeFile(reference, png("reference"));
  const refSha = sha(png("reference"));
  const approved = join(root, "refs", "approved.json");
  await writeFile(approved, JSON.stringify({ version: APPROVED_REFERENCES_VERSION, references: [refSha] }));
  const stage = "character";
  await startAssetQualityLoop({ workDir: root, harnessId: "koya-manga-video", stage, subjectId: SUBJECT, generatorContextId: "ctx-maker", now });
  const harness = captureHarness();
  const captureLearning = (input) => captureAssetLearning({ ...input, env: {}, now, captureOptions: harness.options });
  const writeVersion = async (n) => {
    await writeFile(join(root, "assets", `v${n}.png`), png(`v${n}`));
    return { rel: `assets/v${n}.png`, sha: sha(png(`v${n}`)) };
  };
  const review = async (name, context, assetSha, overrides = {}) => {
    await writeFile(join(root, "reviews", `${name}.json`), JSON.stringify({
      evaluatorId: "evaluator", evaluatorContextId: context, assetSha256: assetSha,
      comparedReferenceSha256s: [refSha], identityComparison: { face: "輪郭を並べて見た", hair: "分け目を並べて見た", body: "頭身を並べて見た" },
      rubricScores: Object.fromEntries(CHARACTER.rubric.map((row) => [row.id, overrides[row.id] ?? (row.minimumScore >= 100 ? 100 : 95)])),
      // 所見は評価ごとに違う（前の回の所見の写しは品質ループが採点に使わない）。
      notes: `${NOTES}（${context}）`,
    }));
    return `reviews/${name}.json`;
  };
  const common = { workDir: root, stage, subjectId: SUBJECT, producerContexts: ["ctx-maker"], producerHost: "codex", generationRoute: "chatgpt-web", references: [reference], approvedReferencesPath: approved, now, captureLearning };
  const v1 = await writeVersion(1);
  const failed = await recordAssetQualityRound({ ...common, assetPath: v1.rel, versionLabel: "v1", reviewPath: await review("r1", "ctx-eval-1", v1.sha, { "hand-safety": 0 }) });
  assert.equal(failed.recorded, true);
  assert.equal(failed.learning.captured, 1);
  assert.match(harness.rows[0].text, /下限割れ: hand-safety/u);
  assert.equal(JSON.stringify(harness.rows).includes(SUBJECT), false);

  const v2 = await writeVersion(2);
  let called = false;
  const passed = await recordAssetQualityRound({
    ...common, assetPath: v2.rel, versionLabel: "v2", reviewPath: await review("r2", "ctx-eval-2", v2.sha),
    revisionDelta: "手元を描き直した", previousFailureFingerprint: failed.round.failureFingerprint, captureLearning: () => { called = true; },
  });
  assert.equal(passed.state.status, "passed");
  assert.equal(called, false, "合格した回からは積まない");

  const verifyArgs = { workDir: root, stage, subjectId: SUBJECT, assetPath: v2.rel, reviewer: "synthetic-reviewer", note: "並べて見た", humanVerified: true, isInteractive: true, now, captureLearning };
  const ok = await recordAssetHumanVerification({ ...verifyArgs, checks: ["identity"], verdict: "pass" });
  assert.equal(ok.learning, null);
  const rejected = await recordAssetHumanVerification({ ...verifyArgs, checks: ["hand-safety"], verdict: "reject" });
  assert.equal(rejected.learning.captured, 1);
  assert.match(harness.rows.at(-1).text, /人の確認（hand-safety）が否だった（評価者の採点: 合格）/u);
  // 機械の申告の否は人の確認ではないので積まない。
  const agent = await recordAssetHumanVerification({ ...verifyArgs, checks: ["identity"], verdict: "reject", humanVerified: false, agentAttested: true, isInteractive: false });
  assert.equal(agent.counted, false);
  assert.equal(agent.learning, null);
});

test("動画クリップ（video-clip）の不合格も、両ハーネスとも Channel Pack の非公開台帳へ工程・落ちた機械ゲートだけで積む", async () => {
  for (const [harnessId, target] of [["koya-manga-video", "channel-pack:koya"], ["narrated-story-video", "channel-pack:narrated-story"]]) {
    const harness = captureHarness();
    const { contract } = createAssetQualityContract({ harnessId, stage: "video-clip" });
    const input = failingRound({
      state: { contractDigest: contract.digest, asset: { harnessId, stage: "video-clip", subjectId: SUBJECT, versions: [] } },
      round: { floorFailures: ["motion-integrity"], failedGateIds: ["video-audio-declared", "video-full-decode"] },
    });
    const result = await captureAssetLearning({ event: "round", ...input, contract, env: {}, now, captureOptions: harness.options });
    assert.equal(result.target, target);
    assert.equal(result.captured, 1);
    const [row] = harness.rows;
    assert.match(row.evidence, new RegExp(`harness=${harnessId} stage=video-clip round=2 floors=1 gates=2 `, "u"));
    assert.match(row.text, /動画クリップ/u);
    assert.deepEqual(row.gateIds, ["motion-integrity", "video-audio-declared", "video-full-decode"]);
    for (const forbidden of [SUBJECT, "合成の所見", "private-folder"]) assert.equal(JSON.stringify(row).includes(forbidden), false, `${forbidden} を運ばない`);
  }
});
