// 最小改善（minimumImprovement）の既定を 1 → 5 点に上げた後も、それより前に始めた品質ループ（状態ファイルの契約が
// 最小改善 1 点の世代）は、始めたときの値のまま読めて続き、合否・停滞の判定が変わらないことの試験。
// 新しく始めるループだけが 5 点になる。台本・依頼・会話 id・対象 id はすべて合成の値で、モデルも有料 API も呼ばない。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import test from "node:test";

import { createAssetQualityContract, assetQualityPaths, recordAssetQualityRound, startAssetQualityLoop } from "../lib/assetQualityLoop.mjs";
import { createExplainerVideoQualityContract, explainerQualityPaths, resolveExplainerVideoQualityContract } from "../lib/explainerQualityLoop.mjs";
import { createNarratedQualityContract, narratedQualityPaths, resolveNarratedQualityContract } from "../lib/narratedStoryQualityLoop.mjs";
import { createScriptQualityContract, recordScriptQualityRound, scriptQualityPaths, startScriptQualityLoop } from "../lib/scriptQualityLoop.mjs";
import { createStrategyBriefQualityContract, recordStrategyBriefRound, startStrategyBriefLoop, strategyBriefQualityPaths } from "../lib/strategyBriefQualityLoop.mjs";
import { MAKER, reviewFor, stageInputs, workspace as assetWorkspace, writeReview as writeAssetReview } from "./fixtures/assetQualityFixtures.mjs";
import { evidenceRow, jsonBytes, metricsOutput, sampleBrief, writeJson as writeBriefJson } from "./helpers/strategyBriefFixture.mjs";

const LEGACY = "minimum-improvement-1";
const sha = (value) => createHash("sha256").update(value).digest("hex");
let clock = Date.parse("2026-09-27T00:00:00.000Z");
const now = () => {
  clock += 60_000;
  return new Date(clock).toISOString();
};

async function tempRoot(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** 既定を変える前に書かれた状態ファイルと同じ形にする（契約の写しと digest が最小改善 1 点の世代）。 */
async function rewriteAsLegacy(statePath, layer, legacyContract) {
  const state = JSON.parse(await readFile(statePath, "utf8"));
  await writeFile(statePath, JSON.stringify({ ...state, contractDigest: legacyContract.digest, [layer]: { ...state[layer], contract: legacyContract } }, null, 2));
}

test("各ループの新しい契約の最小改善は 5 点で、前の世代の契約は 1 点（それ以外の上限は同じ）", () => {
  const pairs = [
    [createScriptQualityContract().contract, createScriptQualityContract({ limitDefaults: LEGACY }).contract],
    [createAssetQualityContract({ harnessId: "koya-manga-video", stage: "character" }).contract, createAssetQualityContract({ harnessId: "koya-manga-video", stage: "character", limitDefaults: LEGACY }).contract],
    [createStrategyBriefQualityContract(), createStrategyBriefQualityContract({ limitDefaults: LEGACY })],
    [createNarratedQualityContract(), createNarratedQualityContract({ limitDefaults: LEGACY })],
    [createExplainerVideoQualityContract(), createExplainerVideoQualityContract({ limitDefaults: LEGACY })],
  ];
  for (const [current, legacy] of pairs) {
    assert.equal(current.limits.minimumImprovement, 5);
    assert.equal(legacy.limits.minimumImprovement, 1);
    assert.notEqual(current.digest, legacy.digest);
    assert.deepEqual({ ...current.limits, minimumImprovement: 0 }, { ...legacy.limits, minimumImprovement: 0 });
  }
  // Channel Pack が最小改善を書けば、どちらの世代でもその値（上書きは今までどおり効く）。
  const packed = { version: "buzzassist-script-quality-channel-v1", limits: { minimumImprovementPoints: 2 } };
  assert.equal(createScriptQualityContract({ channelConfig: packed }).contract.limits.minimumImprovement, 2);
  assert.equal(createNarratedQualityContract({ limits: { minimumImprovement: 2 } }).limits.minimumImprovement, 2);
});

const DRAFTS = ["「合成の台詞」\n合成の地の文その1。\n", "「合成の台詞」\n合成の地の文その2。\n", "「合成の台詞」\n合成の地の文その3。\n"];

/** 台本のループを3回回す。毎回、総合点が 1.8 点ずつ伸びる（1 点の最小改善では改善、5 点では停滞）。 */
async function runScriptRounds(root) {
  const results = [];
  const { contract } = createScriptQualityContract();
  for (const [index, text] of DRAFTS.entries()) {
    const file = `draft-${index + 1}.md`;
    await writeFile(join(root, file), text);
    const value = 80 + index * 2;
    const reviewPath = `quality/reviews/r${index + 1}.json`;
    await writeFile(join(root, reviewPath), JSON.stringify({
      evaluatorId: "evaluator",
      evaluatorContextId: `ctx-eval-${index + 1}`,
      scriptSha256: sha(text),
      ...(index > 0 ? { baseScriptSha256: sha(DRAFTS[index - 1]) } : {}),
      rubricScores: Object.fromEntries(contract.rubric.map((row) => [row.id, row.id === "review-first-person-marker" ? 100 : value])),
      notes: `全行を読んだ所見（${index + 1} 回目）`,
      findings: [],
    }));
    const result = await recordScriptQualityRound({
      workDir: root, scriptPath: file, versionLabel: `v${index + 1}`, stage: index === 0 ? "draft" : "revision", reviewPath, now,
      ...(index > 0 ? { revisionDelta: `地の文を直した（${index + 1} 回目）` } : {}),
    });
    assert.equal(result.recorded, true, JSON.stringify(result.issues));
    results.push(result);
  }
  return results;
}

test("台本: 既定を変える前に始めたループは最小改善 1 点のまま続き、同じ伸びでも新しいループだけが停滞で止まる", async (t) => {
  const legacyRoot = await tempRoot(t, "script-legacy-");
  await mkdir(join(legacyRoot, "quality", "reviews"), { recursive: true });
  await startScriptQualityLoop({ workDir: legacyRoot, generatorContextId: "ctx-writer-1", now });
  const legacyContract = createScriptQualityContract({ limitDefaults: LEGACY }).contract;
  await rewriteAsLegacy(scriptQualityPaths(legacyRoot).statePath, "script", legacyContract);
  const legacy = await runScriptRounds(legacyRoot);
  assert.equal(legacy.at(-1).state.contractDigest, legacyContract.digest, "始めたときの契約のまま続く（契約が変わったで止まらない）");
  assert.deepEqual(legacy.map((row) => row.state.stagnantRounds), [0, 0, 0]);
  assert.equal(legacy.at(-1).state.status, "active");

  const freshRoot = await tempRoot(t, "script-fresh-");
  await mkdir(join(freshRoot, "quality", "reviews"), { recursive: true });
  await startScriptQualityLoop({ workDir: freshRoot, generatorContextId: "ctx-writer-1", now });
  const fresh = await runScriptRounds(freshRoot);
  assert.deepEqual(fresh.map((row) => row.state.stagnantRounds), [0, 1, 2]);
  assert.equal(fresh.at(-1).state.status, "needs-human-approval");
  assert.equal(fresh.at(-1).state.stopReason, "no-improvement");
});

test("途中の成果物: 既定を変える前に始めたループの状態ファイルは、契約が変わったで止まらずに回を記録できる", async (t) => {
  const root = await assetWorkspace(t);
  const stage = "character";
  const subjectId = "synthetic-cast-1";
  await startAssetQualityLoop({ workDir: root, harnessId: "koya-manga-video", stage, subjectId, generatorContextId: MAKER, now });
  const legacyContract = createAssetQualityContract({ harnessId: "koya-manga-video", stage, limitDefaults: LEGACY }).contract;
  await rewriteAsLegacy(assetQualityPaths(root, stage, subjectId).statePath, "asset", legacyContract);
  const fx = await stageInputs(root, stage);
  const v1 = await fx.asset(1);
  const result = await recordAssetQualityRound({
    workDir: root, stage, subjectId, assetPath: v1.rel, versionLabel: "v1", now, ...(await fx.recordExtra(v1)),
    reviewPath: await writeAssetReview(root, "r1", reviewFor({ stage, assetSha: v1.sha, refs: fx.refs, contract: legacyContract, context: "ctx-eval-1", overrides: { "wardrobe-match": 30 } })),
  });
  assert.equal(result.recorded, true, JSON.stringify(result.issues));
  assert.equal(result.state.contractDigest, legacyContract.digest);
});

test("企画ブリーフ: 既定を変える前に始めたループの状態ファイルは、契約が変わったで止まらずに回を記録できる", async (t) => {
  const root = await tempRoot(t, "strategy-legacy-");
  const metrics = await writeBriefJson(root, "evidence/metrics.json", metricsOutput());
  const brief = sampleBrief({
    evidence: [evidenceRow(metrics, { id: "e-metrics", kind: "metrics", premiseBound: false, premiseIndependenceReason: "合成: 公開済みの動画の実測" })],
    changes: { previous: null, keep: [{ point: "合成の残す点", evidenceIds: ["e-metrics"] }], change: [] },
  });
  const bytes = jsonBytes(brief);
  await writeFile(path.join(root, "brief-r1.json"), bytes);
  await startStrategyBriefLoop({ workDir: root, generatorContextId: "ctx-planner-1", now });
  const legacyContract = createStrategyBriefQualityContract({ limitDefaults: LEGACY });
  await rewriteAsLegacy(strategyBriefQualityPaths(root).statePath, "strategy", legacyContract);
  const reviewRel = "quality/reviews/r1.json";
  await writeBriefJson(root, reviewRel, {
    evaluatorId: "evaluator",
    evaluatorContextId: "ctx-eval-1",
    evaluatorHost: "codex",
    briefSha256: sha(bytes),
    rubricScores: Object.fromEntries(legacyContract.rubric.map((row) => [row.id, 92])),
    notes: "ブリーフと根拠のファイルを開いて照合した所見",
    findings: [],
  });
  const result = await recordStrategyBriefRound({ workDir: root, briefPath: "brief-r1.json", reviewPath: reviewRel, now });
  assert.equal(result.recorded, true, JSON.stringify(result.issues));
  assert.equal(result.state.contractDigest, legacyContract.digest);
  assert.equal(result.state.status, "passed");
});

test("署名済みレビューのループ（ナレーション物語・解説動画）: Job の状態・前の Job・評価シートの digest から、始めたときの世代の契約を選ぶ", async (t) => {
  const root = await tempRoot(t, "signed-legacy-");
  const legacyNarrated = createNarratedQualityContract({ limitDefaults: LEGACY });
  const runDir = join(root, "video-narrated-story-video-0000000000000001");
  // 新しい Job（何も無い）は今の既定。
  assert.equal((await resolveNarratedQualityContract({ runDir })).limits.minimumImprovement, 5);
  // 評価シートを前の世代の契約で渡していた（回はまだ無い）Job は、前の世代の契約で signoff を受ける。
  assert.equal((await resolveNarratedQualityContract({ runDir, sheetDigests: [legacyNarrated.digest] })).digest, legacyNarrated.digest);
  // 前の Job のループを引き継ぐ Job は、前の Job の契約の世代で続ける。
  const predecessorId = "video-narrated-story-video-0000000000000002";
  const predecessorState = narratedQualityPaths(join(root, predecessorId)).statePath;
  await mkdir(path.dirname(predecessorState), { recursive: true });
  await writeFile(predecessorState, JSON.stringify({ contractDigest: legacyNarrated.digest, rounds: [] }));
  await mkdir(narratedQualityPaths(runDir).dir, { recursive: true });
  await writeFile(narratedQualityPaths(runDir).revisionDeltaPath, JSON.stringify({ predecessorJobId: predecessorId }));
  const predecessorStatePath = (id) => narratedQualityPaths(join(root, id)).statePath;
  assert.equal((await resolveNarratedQualityContract({ runDir, predecessorStatePath })).digest, legacyNarrated.digest);
  // この Job の品質ループの状態があれば、それだけを見る。
  await writeFile(narratedQualityPaths(runDir).statePath, JSON.stringify({ contractDigest: createNarratedQualityContract().digest, rounds: [] }));
  assert.equal((await resolveNarratedQualityContract({ runDir, predecessorStatePath, sheetDigests: [legacyNarrated.digest] })).limits.minimumImprovement, 5);

  const legacyExplainer = createExplainerVideoQualityContract({ limitDefaults: LEGACY });
  const workDir = join(root, "video-explainer-video-0000000000000001", "explainer");
  const sheetPath = join(workDir, "review", "review-sheet.json");
  assert.equal((await resolveExplainerVideoQualityContract({ workDir, jobsDir: root, sheetPath })).limits.minimumImprovement, 5);
  await mkdir(path.dirname(sheetPath), { recursive: true });
  await writeFile(sheetPath, JSON.stringify({ contractDigest: legacyExplainer.digest }));
  assert.equal((await resolveExplainerVideoQualityContract({ workDir, jobsDir: root, sheetPath })).digest, legacyExplainer.digest);
  await mkdir(explainerQualityPaths(workDir).dir, { recursive: true });
  await writeFile(explainerQualityPaths(workDir).statePath, JSON.stringify({ contractDigest: legacyExplainer.digest, rounds: [] }));
  assert.equal((await resolveExplainerVideoQualityContract({ workDir, jobsDir: root })).digest, legacyExplainer.digest);
});
