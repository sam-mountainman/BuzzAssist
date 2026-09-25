import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path, { join } from "node:path";
import test from "node:test";

import { createChannelPackEnvelope } from "../lib/channelPackEnvelope.mjs";
import {
  ASSET_HUMAN_VERIFIED,
  ASSET_QUALITY_CHANNEL_CONFIG_FILE,
  ASSET_QUALITY_CHANNEL_CONFIG_VERSION,
  ASSET_QUALITY_HARNESSES,
  ASSET_QUALITY_LIMIT_DEFAULTS,
  ASSET_REVIEW_SHEET_FORBIDDEN_KEYS,
  ASSET_STAGES,
  assetQualityPaths,
  assetQualityReviewSheet,
  assetQualityReviewTemplate,
  assetQualityStage,
  assetQualityStatus,
  createAssetQualityContract,
  listAssetQualityStatus,
  normalizeAssetChannelConfig,
  recordAssetQualityRound,
  requiredHumanChecks,
  startAssetQualityLoop,
  workDirRelative,
} from "../lib/assetQualityLoop.mjs";
import { HUMAN_VERIFIED } from "../scripts/harness-learn.mjs";
import {
  MAKER,
  now,
  png,
  reviewFor,
  sha,
  stageInputs,
  verify,
  workspace,
  writeReview,
} from "./fixtures/assetQualityFixtures.mjs";

// 人物・会話 id・対象 id・所見はすべて合成の値（test/fixtures/assetQualityFixtures.mjs）。

test("工程ごとの既定の評価項目・下限を持ち、場所は漫画固有、Pack は項目を足し下限を上げることだけできる", () => {
  const ids = (harnessId, stage) => createAssetQualityContract({ harnessId, stage }).contract.rubric.map((row) => row.id);
  assert.deepEqual(ids("koya-manga-video", "character"), ["identity-match", "art-style-match", "wardrobe-match", "hand-safety"]);
  assert.deepEqual(ids("koya-manga-video", "location"), ["layout-match", "art-style-match", "not-photographic"]);
  assert.deepEqual(ids("koya-manga-video", "scene-image"), ["scene-intent-match", "character-identity", "hand-safety", "art-style-match"]);
  assert.deepEqual(ids("narrated-story-video", "thumbnail"), ["readable-at-decided-size", "distinct-idea-axes", "lettering-design", "character-identity", "hand-safety", "no-real-brand-logo"]);
  assert.deepEqual(ids("narrated-story-video", "voice-take"), ["voice-continuity", "line-fits-context"]);
  // サムネと人物は両方のハーネス、場所は漫画だけ。
  assert.deepEqual(ASSET_QUALITY_HARNESSES["koya-manga-video"].stages, ASSET_STAGES);
  assert.equal(ASSET_QUALITY_HARNESSES["narrated-story-video"].stages.includes("location"), false);
  assert.throws(() => createAssetQualityContract({ harnessId: "narrated-story-video", stage: "location" }), /manga ジャンル固有/u);
  for (const harnessId of Object.keys(ASSET_QUALITY_HARNESSES)) {
    for (const stage of ASSET_QUALITY_HARNESSES[harnessId].stages) {
      const { contract } = createAssetQualityContract({ harnessId, stage });
      assert.equal(Math.round(contract.rubric.reduce((sum, row) => sum + row.weight, 0)), 100);
      assert.equal(contract.limits.targetScore, ASSET_QUALITY_LIMIT_DEFAULTS.targetScore);
    }
  }
  const floor = (contract, id) => contract.rubric.find((row) => row.id === id).minimumScore;
  const character = createAssetQualityContract({ harnessId: "koya-manga-video", stage: "character" }).contract;
  assert.equal(floor(character, "identity-match"), 80);
  assert.equal(floor(character, "hand-safety"), 100);
  // 声のテイクの測定値はハード・ゲート、聞いた印象だけが評価項目。
  assert.ok(createAssetQualityContract({ harnessId: "koya-manga-video", stage: "voice-take" }).contract.machineGates.includes("voice-metrics-pass"));

  const channelConfig = {
    version: ASSET_QUALITY_CHANNEL_CONFIG_VERSION,
    stages: {
      thumbnail: {
        criteria: [{ id: "band-contrast", label: "帯の読みやすさ", weight: 10, minimumScore: 70, description: "帯と文字の明度差が決定サイズで読める" }],
        floors: { "distinct-idea-axes": 75 },
        weights: { "readable-at-decided-size": 30 },
        limits: { targetScore: 92, maximumReviewRounds: 6 },
      },
    },
  };
  const { contract, blockers } = createAssetQualityContract({ harnessId: "koya-manga-video", stage: "thumbnail", channelConfig, channelSource: { kind: "unsigned-file" } });
  assert.deepEqual(blockers, []);
  assert.equal(floor(contract, "distinct-idea-axes"), 75);
  assert.equal(contract.rubric.find((row) => row.id === "band-contrast").origin, "channel");
  assert.equal(contract.limits.targetScore, 92);
  assert.equal(contract.limits.maximumReviewRounds, 6);

  const blocked = (stages, harnessId = "koya-manga-video") => normalizeAssetChannelConfig({ version: ASSET_QUALITY_CHANNEL_CONFIG_VERSION, stages }, { harnessId }).blockers;
  assert.deepEqual(blocked({ character: { floors: { "hand-safety": 90 } } }), ["asset-quality.stages.character.floors.hand-safety-cannot-lower"]);
  assert.deepEqual(blocked({ character: { rubric: [] } }), ["asset-quality.stages.character.rubric-not-replaceable"]);
  assert.deepEqual(blocked({ location: {} }, "narrated-story-video"), ["asset-quality.stages.location-not-in-harness"]);
  assert.deepEqual(blocked({ banner: {} }), ["asset-quality.stages.banner-unknown"]);
  assert.deepEqual(blocked({ thumbnail: { criteria: [{ id: "hand-safety", label: "x", weight: 1, minimumScore: 1, description: "説明文です" }] } }), ["asset-quality.stages.thumbnail.criteria.hand-safety-collides-with-default"]);
  assert.deepEqual(blocked({ thumbnail: { limits: { targetScore: 70 } } }), ["asset-quality.stages.thumbnail.limits.targetScore"]);
  assert.deepEqual(normalizeAssetChannelConfig({ stages: {} }, { harnessId: "koya-manga-video" }).blockers, ["asset-quality.version"]);
});

for (const harnessId of Object.keys(ASSET_QUALITY_HARNESSES)) {
  for (const stage of ASSET_QUALITY_HARNESSES[harnessId].stages) {
    test(`${harnessId} の ${stage}: 不合格 → 直しの差分なしは拒否 → 差分つきで合格 → status`, async (t) => {
      const root = await workspace(t);
      const subjectId = `synthetic-${stage}-1`;
      const started = await startAssetQualityLoop({ workDir: root, harnessId, stage, subjectId, generatorContextId: MAKER, generatorHost: "claude-code", now });
      assert.equal(started.started, true);
      const contract = started.state.asset.contract;
      const fx = await stageInputs(root, stage);
      const record = async (version, label, reviewPath, extra = {}) => recordAssetQualityRound({
        workDir: root, stage, subjectId, assetPath: version.rel, versionLabel: label, reviewPath, now, ...(await fx.recordExtra(version)), ...extra,
      });

      const v1 = await fx.asset(1);
      const failingId = contract.rubric[0].id;
      const round1 = await record(v1, "v1", await writeReview(root, "r1", reviewFor({ stage, context: "ctx-eval-1", assetSha: v1.sha, refs: fx.refs, contract, overrides: { [failingId]: 40 } })));
      assert.equal(round1.recorded, true, JSON.stringify(round1.issues));
      assert.equal(round1.state.status, "active");
      assert.deepEqual(round1.round.floorFailures, [failingId]);
      assert.deepEqual(round1.round.failedGateIds, []);
      const fingerprint = round1.round.failureFingerprint;
      assert.match(fingerprint, /^quality-failure:[a-f0-9]{24}$/u);

      const v2 = await fx.asset(2);
      const review2 = await writeReview(root, "r2", reviewFor({ stage, context: "ctx-eval-2", assetSha: v2.sha, refs: fx.refs, contract }));
      const noDelta = await record(v2, "v2", review2);
      assert.equal(noDelta.recorded, false);
      assert.deepEqual(noDelta.issues, [`asset-quality-revision-delta-required:${fingerprint}`]);
      const deltaOnly = await record(v2, "v2", review2, { revisionDelta: "参照の渡し方を直した" });
      assert.deepEqual(deltaOnly.issues, [`asset-quality-previous-failure-mismatch:${fingerprint}`], "前回の失敗指紋も必須");
      const passed = await record(v2, "v2", review2, { revisionDelta: "参照の渡し方を直した", previousFailureFingerprint: fingerprint });
      assert.equal(passed.recorded, true, JSON.stringify(passed.issues));
      assert.equal(passed.state.status, "passed");
      assert.equal(passed.round.previousFailureFingerprint, fingerprint);
      assert.equal(passed.state.rounds.length, 2, "人待ちの試みは回として数えない");

      // 版の記録: 成果物の SHA・作った文脈とホスト・経路・参照の SHA・評価文脈。
      const version = passed.version;
      assert.equal(version.assetSha256, v2.sha);
      assert.deepEqual(version.producerContexts, [MAKER]);
      assert.equal(version.producerHost, "claude-code");
      assert.equal(version.generationRoute, assetQualityStage(stage).media === "audio" ? "broker" : "codex");
      assert.deepEqual(version.referenceSha256s, fx.refs);
      assert.equal(version.evaluatorContextId, "ctx-eval-2");
      if (stage === "voice-take") assert.deepEqual(version.voiceMetrics, { utmos: 3.4, cer: 0.04 });

      const required = requiredHumanChecks(stage, version);
      const before = await assetQualityStatus({ workDir: root, stage, subjectId });
      if (required.length === 0) {
        assert.equal(before.pass, true);
      } else {
        assert.equal(before.pass, false, "人の確認が無いと合格にならない");
        assert.equal(before.check.status, "awaiting-human-verification");
        assert.deepEqual(before.check.humanVerification.missing, required);
        await verify(root, stage, subjectId, v2.rel, required);
        const after = await assetQualityStatus({ workDir: root, stage, subjectId, assetPath: v2.rel });
        assert.equal(after.pass, true, JSON.stringify(after.issues));
      }
      // 合格した版以外のファイルを「使う」ことはできない。
      const other = await assetQualityStatus({ workDir: root, stage, subjectId, assetPath: v1.rel });
      assert.equal(other.pass, false);
      assert.ok(other.issues.includes("asset-quality-candidate-not-reviewed-version"));
    });
  }
}

test("人の確認の欄: 人物は同一性と手指、サムネは手指をいつも・同一性は人物が写るとき、本編の画は同一性だけ", () => {
  const withRefs = { referenceSha256s: ["a".repeat(64)] };
  assert.deepEqual(requiredHumanChecks("character", withRefs), ["identity", "hand-safety"]);
  assert.deepEqual(requiredHumanChecks("thumbnail", withRefs), ["identity", "hand-safety"]);
  assert.deepEqual(requiredHumanChecks("thumbnail", { referenceSha256s: [] }), ["hand-safety"]);
  assert.deepEqual(requiredHumanChecks("scene-image", withRefs), ["identity"]);
  assert.deepEqual(requiredHumanChecks("scene-image", { referenceSha256s: [] }), []);
  assert.deepEqual(requiredHumanChecks("location", withRefs), []);
  assert.deepEqual(requiredHumanChecks("voice-take", withRefs), []);
  assert.equal(ASSET_HUMAN_VERIFIED, HUMAN_VERIFIED, "人の確認の印は harness-learn と同じ値");
});

test("作った文脈・start の文脈・作る係の名乗り・前の回の文脈では採点できない（例外ではなく人待ち）", async (t) => {
  const root = await workspace(t);
  const stage = "character";
  const subjectId = "synthetic-cast-1";
  const { state } = await startAssetQualityLoop({ workDir: root, harnessId: "koya-manga-video", stage, subjectId, generatorContextId: MAKER, now });
  const contract = state.asset.contract;
  const fx = await stageInputs(root, stage);
  const v1 = await fx.asset(1);
  const attempt = async (name, reviewExtra, recordExtra = {}) => recordAssetQualityRound({
    workDir: root, stage, subjectId, assetPath: v1.rel, versionLabel: "v1", now, ...(await fx.recordExtra(v1)), ...recordExtra,
    reviewPath: await writeReview(root, name, reviewFor({ stage, assetSha: v1.sha, refs: fx.refs, contract, context: "ctx-eval-1", ...reviewExtra })),
  });
  assert.deepEqual((await attempt("a", { context: MAKER })).issues, ["asset-quality-evaluator-not-independent"]);
  assert.deepEqual((await attempt("b", { context: "ctx-maker-2" }, { producerContexts: ["ctx-maker-2"] })).issues, ["asset-quality-evaluator-not-independent"]);
  assert.deepEqual((await attempt("c", { extra: { evaluatorId: "asset-maker" } })).issues, ["asset-quality-evaluator-not-independent"]);
  const mismatch = await attempt("d", { assetSha: "b".repeat(64) });
  assert.deepEqual(mismatch.issues, ["asset-quality-review-asset-mismatch"]);
  const noComparison = await attempt("e", { extra: { identityComparison: { face: "見た", hair: "", body: "" } } });
  assert.deepEqual(noComparison.issues, ["asset-quality-review-identity-comparison-missing"], "属性の一致だけで済ませない");
  const notCompared = await attempt("f", { extra: { comparedReferenceSha256s: [] } });
  assert.deepEqual(notCompared.issues, ["asset-quality-review-references-not-compared"]);
  const ok = await attempt("g", { overrides: { "wardrobe-match": 30 } });
  assert.equal(ok.recorded, true);

  // 前の版を作った文脈も、次の版を採点できない。前の回の評価文脈も使えない。
  const v2 = await fx.asset(2);
  const second = async (name, context, producerContexts = ["ctx-maker-3"]) => recordAssetQualityRound({
    workDir: root, stage, subjectId, assetPath: v2.rel, versionLabel: "v2", now, ...(await fx.recordExtra(v2)), producerContexts,
    revisionDelta: "衣装の襟の形を設定どおりに直した", previousFailureFingerprint: ok.round.failureFingerprint,
    reviewPath: await writeReview(root, name, reviewFor({ stage, assetSha: v2.sha, refs: fx.refs, contract, context })),
  });
  assert.deepEqual((await second("h", "ctx-eval-1")).issues, ["asset-quality-fresh-review-required"]);
  // 同じバイト列の版は採点し直させない。
  const unchanged = await recordAssetQualityRound({
    workDir: root, stage, subjectId, assetPath: v1.rel, versionLabel: "v1b", now, ...(await fx.recordExtra(v1)),
    reviewPath: await writeReview(root, "i", reviewFor({ stage, assetSha: v1.sha, refs: fx.refs, contract, context: "ctx-eval-9" })),
  });
  assert.deepEqual(unchanged.issues, ["asset-quality-asset-unchanged:v1"]);
  const persisted = JSON.parse(await readFile(assetQualityPaths(root, stage, subjectId).statePath, "utf8"));
  assert.equal(persisted.rounds.length, 1, "人待ちの試みは回として数えない");
  // 経路は宣言の一覧から選ぶ。作業フォルダの外のファイルは受けない。
  await assert.rejects(recordAssetQualityRound({
    workDir: root, stage, subjectId, assetPath: v2.rel, versionLabel: "v2", reviewPath: "reviews/h.json", producerContexts: [MAKER], producerHost: "codex", generationRoute: "somewhere", now,
  }), /--route/u);
  await assert.rejects(recordAssetQualityRound({
    workDir: root, stage, subjectId, assetPath: "../outside.png", versionLabel: "v9", reviewPath: "reviews/g.json", producerContexts: [MAKER], producerHost: "codex", generationRoute: "codex", now,
  }), /作業フォルダの中/u);
});

test("人の確認は対話端末＋--human-verified だけが数え、機械の申告は数えない。否は合格を止める", async (t) => {
  const root = await workspace(t);
  const stage = "thumbnail";
  const subjectId = "synthetic-thumb-1";
  const { state } = await startAssetQualityLoop({ workDir: root, harnessId: "koya-manga-video", stage, subjectId, generatorContextId: MAKER, now });
  const contract = state.asset.contract;
  const fx = await stageInputs(root, stage);
  const v1 = await fx.asset(1);

  // 機械は人の確認を記録できない: 対話端末でない --human-verified は拒否、--agent-attested は数えない。
  await assert.rejects(verify(root, stage, subjectId, v1.rel, ["hand-safety"], "pass", { isInteractive: false }), /対話端末/u);
  await assert.rejects(verify(root, stage, subjectId, v1.rel, ["hand-safety"], "pass", { isInteractive: false, humanVerified: false }), /裏づけがありません/u);
  const agent = await verify(root, stage, subjectId, v1.rel, ["identity", "hand-safety"], "pass", { humanVerified: false, agentAttested: true, isInteractive: false });
  assert.equal(agent.counted, false);
  assert.equal(agent.verifications[0].attestedBy, "agent-self-attested");
  assert.equal(agent.verifications[0].reviewer, "agent");
  const claimed = await verify(root, stage, subjectId, v1.rel, ["identity", "hand-safety"], "pass", { humanVerified: false });
  assert.equal(claimed.counted, false);
  assert.equal(claimed.verifications[0].attestedBy, "cli-interactive-claimed");
  await assert.rejects(verify(root, stage, subjectId, v1.rel, ["wardrobe"]), /欄に無い/u);
  await assert.rejects(verify(root, "location", "synthetic-place", v1.rel, ["identity"]), /人の確認の欄が無い/u);

  const passed = await recordAssetQualityRound({
    workDir: root, stage, subjectId, assetPath: v1.rel, versionLabel: "v1", now, ...(await fx.recordExtra(v1, "chatgpt-web")),
    reviewPath: await writeReview(root, "r1", reviewFor({ stage, context: "ctx-eval-1", assetSha: v1.sha, refs: fx.refs, contract })),
  });
  assert.equal(passed.state.status, "passed");
  let status = await assetQualityStatus({ workDir: root, stage, subjectId });
  assert.equal(status.pass, false, "機械の申告と対話端末だけの申告は数えない");
  assert.deepEqual(status.check.humanVerification.missing, ["identity", "hand-safety"]);
  assert.deepEqual(status.check.humanVerification.uncounted, ["hand-safety:agent-self-attested", "hand-safety:cli-interactive-claimed", "identity:agent-self-attested", "identity:cli-interactive-claimed"]);

  await verify(root, stage, subjectId, v1.rel, ["identity"]);
  status = await assetQualityStatus({ workDir: root, stage, subjectId });
  assert.deepEqual(status.check.humanVerification.missing, ["hand-safety"]);
  assert.equal(status.pass, false);
  const rejected = await verify(root, stage, subjectId, v1.rel, ["hand-safety"], "reject");
  assert.equal(rejected.counted, true);
  status = await assetQualityStatus({ workDir: root, stage, subjectId });
  assert.equal(status.check.status, "human-rejected");
  assert.ok(status.issues.includes("asset-quality-human-rejected:hand-safety"));
  // 否とされたループは始め直せる。人の確認の記録は引き継ぐので、同じ成果物はもう通らない。
  const restarted = await startAssetQualityLoop({ workDir: root, harnessId: "koya-manga-video", stage, subjectId, generatorContextId: MAKER, now, restart: true, restartReason: "手元のジェスチャーを描き直す" });
  assert.equal(restarted.started, true);
  assert.equal(restarted.state.asset.history[0].effectiveStatus, "human-rejected");
  const again = await recordAssetQualityRound({
    workDir: root, stage, subjectId, assetPath: v1.rel, versionLabel: "v1", now, ...(await fx.recordExtra(v1, "chatgpt-web")),
    reviewPath: await writeReview(root, "r2", reviewFor({ stage, context: "ctx-eval-2", assetSha: v1.sha, refs: fx.refs, contract })),
  });
  assert.equal(again.recorded, true);
  assert.deepEqual(again.round.failedGateIds, ["human-rejection-absent"], "人が否とした成果物は評価者が満点でも通らない");
  assert.notEqual(again.state.status, "passed");
});

test("参照の承認・人物の写り・サムネの寸法・声の測定は機械ゲートで落ちる（満点でも合格しない）", async (t) => {
  const root = await workspace(t);
  const setup = async (stage, subjectId, harnessId = "koya-manga-video") => {
    const { state } = await startAssetQualityLoop({ workDir: root, harnessId, stage, subjectId, generatorContextId: MAKER, now });
    return { contract: state.asset.contract, fx: await stageInputs(root, stage) };
  };
  // 参照が承認一覧に無い / 一覧が無い。
  {
    const { contract, fx } = await setup("character", "synthetic-cast-2");
    const v1 = await fx.asset(1);
    const other = join(root, "refs", "unapproved.png");
    await writeFile(other, png(512, 512, "unapproved"));
    const otherSha = sha(await readFile(other));
    const result = await recordAssetQualityRound({
      workDir: root, stage: "character", subjectId: "synthetic-cast-2", assetPath: v1.rel, versionLabel: "v1", now, ...(await fx.recordExtra(v1)), references: [other],
      reviewPath: await writeReview(root, "c1", reviewFor({ stage: "character", context: "ctx-eval-1", assetSha: v1.sha, refs: [otherSha], contract })),
    });
    assert.deepEqual(result.round.failedGateIds, ["reference-approved"]);
    const v2 = await fx.asset(2);
    const noList = await recordAssetQualityRound({
      workDir: root, stage: "character", subjectId: "synthetic-cast-2", assetPath: v2.rel, versionLabel: "v2", now,
      ...(await fx.recordExtra(v2)), approvedReferencesPath: "",
      revisionDelta: "承認済みの設定画を参照にした", previousFailureFingerprint: result.round.failureFingerprint,
      reviewPath: await writeReview(root, "c2", reviewFor({ stage: "character", context: "ctx-eval-2", assetSha: v2.sha, refs: fx.refs, contract })),
    });
    assert.deepEqual(noList.round.failedGateIds, ["reference-approved"], "承認一覧が無いのは許可ではない");
    // 人物の設定画は参照が必須。
    const v3 = await fx.asset(3);
    const noRef = await recordAssetQualityRound({
      workDir: root, stage: "character", subjectId: "synthetic-cast-2", assetPath: v3.rel, versionLabel: "v3", now,
      ...(await fx.recordExtra(v3)), references: [],
      reviewPath: await writeReview(root, "c3", reviewFor({ stage: "character", context: "ctx-eval-3", assetSha: v3.sha, contract })),
    });
    assert.deepEqual(noRef.issues, ["asset-quality-reference-required"]);
  }
  // 本編の画: 参照しない理由を書いても、評価者が人物が写っていると答えれば落ちる。理由も無ければ記録しない。
  {
    const { contract, fx } = await setup("scene-image", "synthetic-cut-1", "narrated-story-video");
    const v1 = await fx.asset(1);
    const noReason = await recordAssetQualityRound({
      workDir: root, stage: "scene-image", subjectId: "synthetic-cut-1", assetPath: v1.rel, versionLabel: "v1", now, ...(await fx.recordExtra(v1)), references: [],
      reviewPath: await writeReview(root, "s0", reviewFor({ stage: "scene-image", context: "ctx-eval-1", assetSha: v1.sha, contract })),
    });
    assert.deepEqual(noReason.issues, ["asset-quality-reference-required-or-exempt"]);
    const exempt = await recordAssetQualityRound({
      workDir: root, stage: "scene-image", subjectId: "synthetic-cut-1", assetPath: v1.rel, versionLabel: "v1", now, ...(await fx.recordExtra(v1)), references: [],
      referenceExemptReason: "人物の写らない風景のカット",
      reviewPath: await writeReview(root, "s1", reviewFor({ stage: "scene-image", context: "ctx-eval-1", assetSha: v1.sha, contract, extra: { charactersVisible: true } })),
    });
    assert.deepEqual(exempt.round.failedGateIds, ["reference-declared"]);
    assert.equal(exempt.version.referenceExemptReason, "人物の写らない風景のカット");
  }
  // サムネの寸法。
  {
    const { contract, fx } = await setup("thumbnail", "synthetic-thumb-2");
    await writeFile(join(root, "assets", "square.png"), png(1000, 1000, "square"));
    const squareSha = sha(await readFile(join(root, "assets", "square.png")));
    const result = await recordAssetQualityRound({
      workDir: root, stage: "thumbnail", subjectId: "synthetic-thumb-2", assetPath: "assets/square.png", versionLabel: "v1", now,
      ...(await fx.recordExtra({ rel: "assets/square.png", sha: squareSha })),
      reviewPath: await writeReview(root, "t1", reviewFor({ stage: "thumbnail", context: "ctx-eval-1", assetSha: squareSha, refs: fx.refs, contract })),
    });
    assert.deepEqual(result.round.failedGateIds, ["thumbnail-aspect-16x9"]);
    // 決定サイズで見ていない採点は記録しない。
    const v2 = await fx.asset(2);
    const notViewed = await recordAssetQualityRound({
      workDir: root, stage: "thumbnail", subjectId: "synthetic-thumb-2", assetPath: v2.rel, versionLabel: "v2", now,
      ...(await fx.recordExtra(v2)), revisionDelta: "16:9 に描き直した", previousFailureFingerprint: result.round.failureFingerprint,
      reviewPath: await writeReview(root, "t2", reviewFor({ stage: "thumbnail", context: "ctx-eval-2", assetSha: v2.sha, refs: fx.refs, contract, extra: { viewedAtDecidedSize: false } })),
    });
    assert.deepEqual(notViewed.issues, ["asset-quality-review-decided-size-not-viewed"]);
  }
  // 声のテイク: 測定が無い・このテイクに結び付かない・必須の指標が欠けている。
  {
    const { contract, fx } = await setup("voice-take", "synthetic-line-1", "narrated-story-video");
    const v1 = await fx.asset(1);
    const noMeasure = await recordAssetQualityRound({
      workDir: root, stage: "voice-take", subjectId: "synthetic-line-1", assetPath: v1.rel, versionLabel: "v1", now, ...(await fx.recordExtra(v1)), measurementPath: "",
      reviewPath: await writeReview(root, "v1", reviewFor({ stage: "voice-take", context: "ctx-eval-1", assetSha: v1.sha, contract })),
    });
    assert.deepEqual(noMeasure.round.failedGateIds, ["voice-metrics-pass"]);
    const v2 = await fx.asset(2);
    await writeFile(join(root, "measure", "missing-cer.json"), JSON.stringify({
      checks: [{ id: "take", type: "voiceQuality", inputSha256: { [v2.rel]: v2.sha }, status: "pass", metrics: { utmos: 3.9 }, problems: [] }],
    }));
    const missingCer = await recordAssetQualityRound({
      workDir: root, stage: "voice-take", subjectId: "synthetic-line-1", assetPath: v2.rel, versionLabel: "v2", now, ...(await fx.recordExtra(v2)),
      measurementPath: "measure/missing-cer.json", revisionDelta: "測定を付けた", previousFailureFingerprint: noMeasure.round.failureFingerprint,
      reviewPath: await writeReview(root, "v2", reviewFor({ stage: "voice-take", context: "ctx-eval-2", assetSha: v2.sha, contract })),
    });
    assert.deepEqual(missingCer.round.failedGateIds, ["voice-metrics-pass"], "測れなかった指標を合格にしない");
    assert.equal(missingCer.version.voiceMetricsReason, "required-metric-missing");
  }
});

test("評価者に渡すシートには、合格点・下限・重み・前の回の点数を載せない", async (t) => {
  const root = await workspace(t);
  const stage = "thumbnail";
  const subjectId = "synthetic-thumb-3";
  const channelConfig = join(root, "asset-quality.json");
  await writeFile(channelConfig, JSON.stringify({ version: ASSET_QUALITY_CHANNEL_CONFIG_VERSION, stages: { thumbnail: { limits: { targetScore: 97 } } } }));
  const { state } = await startAssetQualityLoop({ workDir: root, harnessId: "koya-manga-video", stage, subjectId, generatorContextId: MAKER, channelConfig, now });
  const contract = state.asset.contract;
  const fx = await stageInputs(root, stage);
  const v1 = await fx.asset(1);
  const failed = await recordAssetQualityRound({
    workDir: root, stage, subjectId, assetPath: v1.rel, versionLabel: "v1", now, ...(await fx.recordExtra(v1)),
    reviewPath: await writeReview(root, "r1", reviewFor({ stage, context: "ctx-eval-1", assetSha: v1.sha, refs: fx.refs, contract, overrides: { "lettering-design": 41 } })),
  });
  assert.equal(failed.recorded, true);
  const v2 = await fx.asset(2);
  const { sheet, template } = await assetQualityReviewTemplate({ workDir: root, stage, subjectId, assetPath: v2.rel, references: fx.refs });
  const keys = [];
  const numbers = [];
  const walk = (value) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) { keys.push(key); walk(child); }
    else if (typeof value === "number") numbers.push(value);
  };
  walk(sheet);
  for (const forbidden of ASSET_REVIEW_SHEET_FORBIDDEN_KEYS) assert.equal(keys.includes(forbidden), false, `評価シートに ${forbidden} が載っている`);
  assert.deepEqual(numbers.sort((a, b) => a - b), [0, 100], "数値は尺度だけ");
  const text = JSON.stringify(sheet);
  assert.equal(text.includes(String(failed.round.score)), false, "前の回の点数を載せない");
  assert.equal(text.includes(failed.round.failureFingerprint), false, "前の回の失敗指紋を載せない");
  assert.equal(text.includes(assetQualityPaths(root, stage, subjectId).statePath), false, "状態の置き場を載せない");
  assert.deepEqual(sheet.rubric.map((row) => row.id), contract.rubric.map((row) => row.id), "何を採点するかは全部載せる");
  assert.ok(sheet.rubric.every((row) => row.label && row.description));
  assert.equal(sheet.asset.sha256, v2.sha);
  assert.deepEqual(sheet.referenceSha256s, fx.refs);
  assert.deepEqual(sheet.reviewRequirements.map((row) => row.id), ["charactersVisible", "comparedReferenceSha256s", "identityComparison", "viewedAtDecidedSize"]);
  // 雛形は点数を埋めない（null）。合否の材料はループ側（契約）にだけある。
  assert.ok(Object.values(template.rubricScores).every((value) => value === null));
  assert.equal(template.assetSha256, v2.sha);
  const templateKeys = [];
  const collect = (value) => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) { templateKeys.push(key); collect(child); }
  };
  collect(template);
  for (const forbidden of ASSET_REVIEW_SHEET_FORBIDDEN_KEYS) assert.equal(templateKeys.includes(forbidden), false, `雛形に ${forbidden} が載っている`);
  assert.equal(contract.limits.targetScore, 97, "合否の材料はループ側（契約）にだけある");
  // 契約の写しから直接作っても、数値は尺度だけ。
  const direct = [];
  const numbersOf = (value) => {
    if (Array.isArray(value)) value.forEach(numbersOf);
    else if (value && typeof value === "object") Object.values(value).forEach(numbersOf);
    else if (typeof value === "number") direct.push(value);
  };
  numbersOf(assetQualityReviewSheet(contract, { assetSha256: v2.sha }));
  assert.deepEqual(direct.sort((a, b) => a - b), [0, 100]);
});

test("Pack の別の工程の設定を変えても、走っているループの契約は変わらない（同じ工程を変えたら止まる）", async (t) => {
  const root = await workspace(t);
  const configPath = join(root, "asset-quality.json");
  const write = (stages) => writeFile(configPath, JSON.stringify({ version: ASSET_QUALITY_CHANNEL_CONFIG_VERSION, stages }));
  await write({ thumbnail: { floors: { "distinct-idea-axes": 70 } } });
  const stage = "thumbnail";
  const subjectId = "synthetic-thumb-4";
  const { state } = await startAssetQualityLoop({ workDir: root, harnessId: "koya-manga-video", stage, subjectId, generatorContextId: MAKER, channelConfig: configPath, now });
  const fx = await stageInputs(root, stage);
  const v1 = await fx.asset(1);
  const review = await writeReview(root, "r1", reviewFor({ stage, context: "ctx-eval-1", assetSha: v1.sha, refs: fx.refs, contract: state.asset.contract, overrides: { "readable-at-decided-size": 20 } }));
  await write({ thumbnail: { floors: { "distinct-idea-axes": 70 } }, character: { floors: { "wardrobe-match": 80 } } });
  const ok = await recordAssetQualityRound({ workDir: root, stage, subjectId, assetPath: v1.rel, versionLabel: "v1", reviewPath: review, now, ...(await fx.recordExtra(v1)) });
  assert.equal(ok.recorded, true, JSON.stringify(ok.issues));
  await write({ thumbnail: { floors: { "distinct-idea-axes": 90 } } });
  const v2 = await fx.asset(2);
  const changed = await recordAssetQualityRound({
    workDir: root, stage, subjectId, assetPath: v2.rel, versionLabel: "v2", now, ...(await fx.recordExtra(v2)),
    revisionDelta: "人物を大きくした", previousFailureFingerprint: ok.round.failureFingerprint,
    reviewPath: await writeReview(root, "r2", reviewFor({ stage, context: "ctx-eval-2", assetSha: v2.sha, refs: fx.refs, contract: state.asset.contract })),
  });
  assert.deepEqual(changed.issues, ["asset-quality-contract-changed"]);
  // 続いているループは始め直せない。
  const restart = await startAssetQualityLoop({ workDir: root, harnessId: "koya-manga-video", stage, subjectId, generatorContextId: MAKER, channelConfig: configPath, now, restart: true, restartReason: "理由を書いても不可" });
  assert.deepEqual(restart.issues, ["asset-quality-loop-active-cannot-restart"]);
});

test("署名済み Channel Pack の asset-quality.json を、信頼した公開鍵で検証してから読む", async (t) => {
  const root = await workspace(t);
  const source = join(root, "pack-source");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, ASSET_QUALITY_CHANNEL_CONFIG_FILE), JSON.stringify({
    version: ASSET_QUALITY_CHANNEL_CONFIG_VERSION,
    stages: { character: { criteria: [{ id: "silhouette-read", label: "シルエットで読める", weight: 10, minimumScore: 70, description: "黒く塗っても誰か分かる輪郭になっている" }] } },
  }));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const bundle = join(root, "signed-pack");
  await createChannelPackEnvelope({
    sourceDir: source, outputDir: bundle, id: "synthetic-channel", version: "1.0.0", harnessId: "narrated-story-video",
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
  });
  const start = (env, harnessId = "narrated-story-video") => startAssetQualityLoop({
    workDir: root, harnessId, stage: "character", subjectId: "synthetic-cast-9", generatorContextId: MAKER, channelPack: bundle, env, now,
  });
  await assert.rejects(start({}), /公開鍵が未設定/u);
  const env = { BUZZASSIST_CHANNEL_PACK_PUBLIC_KEY_PEM: publicKey.export({ type: "spki", format: "pem" }) };
  await assert.rejects(start(env, "koya-manga-video"), /対象Harnessが違う/u);
  const started = await start(env);
  assert.equal(started.started, true);
  const contract = started.state.asset.contract;
  assert.ok(contract.rubric.some((row) => row.id === "silhouette-read" && row.origin === "channel"));
  assert.deepEqual(Object.keys(contract.channelSource).sort(), ["kind", "packId", "stageConfigSha256"]);
  assert.equal(started.state.asset.channelProvenance.packVersion, "1.0.0");
});

test("Windows の区切りでも、作業フォルダの中だけを受け、状態には / 区切りの相対パスで残す", async (t) => {
  const win = path.win32;
  assert.equal(workDirRelative("C:\\work\\ep1", "C:\\work\\ep1\\assets\\cast\\v1.png", "--asset", { pathApi: win }).rel, "assets/cast/v1.png");
  assert.equal(workDirRelative("C:\\work\\ep1", "assets\\v1.png", "--asset", { pathApi: win }).rel, "assets/v1.png");
  assert.throws(() => workDirRelative("C:\\work\\ep1", "C:\\work\\other\\v1.png", "--asset", { pathApi: win }), /作業フォルダの中/u);
  assert.throws(() => workDirRelative("C:\\work\\ep1", "D:\\ep1\\v1.png", "--asset", { pathApi: win }), /作業フォルダの中/u);
  assert.throws(() => workDirRelative("C:\\work\\ep1", "..\\v1.png", "--asset", { pathApi: win }), /作業フォルダの中/u);
  // "..x" は外ではない（前方一致の取り違えをしない）。
  assert.equal(workDirRelative("C:\\work\\ep1", "C:\\work\\ep1\\..x.png", "--asset", { pathApi: win }).rel, "..x.png");

  const root = await workspace(t);
  const paths = assetQualityPaths(root, "scene-image", "cut-01--b");
  assert.equal(paths.statePath, join(root, "quality", "assets", "scene-image--cut-01--b.json"));
  assert.throws(() => assetQualityPaths(root, "scene-image", "cut:01"), /--subject/u);
  const { state } = await startAssetQualityLoop({ workDir: root, harnessId: "koya-manga-video", stage: "scene-image", subjectId: "cut-01--b", generatorContextId: MAKER, now });
  const fx = await stageInputs(root, "scene-image");
  await mkdir(join(root, "assets", "nested"), { recursive: true });
  const bytes = png(1024, 1024, "nested");
  await writeFile(join(root, "assets", "nested", "v1.png"), bytes);
  const recorded = await recordAssetQualityRound({
    workDir: root, stage: "scene-image", subjectId: "cut-01--b", assetPath: join(root, "assets", "nested", "v1.png"), versionLabel: "v1", now,
    ...(await fx.recordExtra({ rel: "assets/nested/v1.png", sha: sha(bytes) })),
    reviewPath: join(root, "reviews", "w.json"),
  }).catch(() => null);
  assert.equal(recorded, null, "採点ファイルが無ければ入力の誤り");
  await writeReview(root, "w", reviewFor({ stage: "scene-image", context: "ctx-eval-1", assetSha: sha(bytes), refs: fx.refs, contract: state.asset.contract }));
  const ok = await recordAssetQualityRound({
    workDir: root, stage: "scene-image", subjectId: "cut-01--b", assetPath: join(root, "assets", "nested", "v1.png"), versionLabel: "v1", now,
    ...(await fx.recordExtra({ rel: "assets/nested/v1.png", sha: sha(bytes) })), reviewPath: join(root, "reviews", "w.json"),
  });
  assert.equal(ok.version.assetPath, ["assets", "nested", "v1.png"].join("/"));
  assert.equal(ok.version.reviewPath, "reviews/w.json");
  // 一覧は、対象 id に "--" が入っていても工程と取り違えない。
  const listed = await listAssetQualityStatus({ workDir: root });
  assert.deepEqual(listed.entries.map((entry) => [entry.stage, entry.subjectId]), [["scene-image", "cut-01--b"]]);
});
