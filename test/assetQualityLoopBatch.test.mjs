// 途中の成果物の品質ループの「まとめて評価する回」（batch）。1回の評価（1つの評価文脈）で同じ工程・同じ
// 作業フォルダの複数の対象を採点し、対象ごとの判定を sha256 つきで記録する。保証は1件ずつの記録と同じ:
// 対象ごとに作った文脈とは別の評価者の判定・人の確認は対象ごと・1つの不合格は他の合格を消さない・再評価は
// 不合格の対象だけ・評価シートに合格点や前回の点数を載せない。人物・会話 id・対象 id・所見はすべて合成の値。
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path, { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ASSET_QUALITY_BATCH_MAX_ITEMS,
  ASSET_QUALITY_BATCH_REVIEW_VERSION,
  ASSET_QUALITY_BATCH_VERSION,
  ASSET_REVIEW_SHEET_FORBIDDEN_KEYS,
  assetQualityBatchPaths,
  assetQualityBatchReviewTemplate,
  assetQualityStatus,
  normalizeAssetQualityBatch,
  recordAssetQualityBatch,
  recordAssetQualityRound,
  startAssetQualityLoop,
} from "../lib/assetQualityLoop.mjs";
import { checkKoyaAssetQuality } from "../lib/koyaAssetQualityGate.mjs";
import { brokerSceneLoopSubject, gateNarratedAssetLoops } from "../lib/narratedStoryAssetLoops.mjs";
import { runAssetQualityCli } from "../scripts/asset-quality-loop.mjs";
import { MAKER, now, png, reviewFor, sha, stageInputs, verify, wav, workspace, writeReview } from "./fixtures/assetQualityFixtures.mjs";
import { currentKoyaContract } from "./helpers/koyaAssetQualityFixture.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** 対象ごとの成果物（声は wav、画は png）を作業フォルダに書く。 */
async function writeAsset(root, stage, subjectId, n) {
  const audio = stage === "voice-take";
  const rel = `assets/${subjectId}-v${n}.${audio ? "wav" : "png"}`;
  const bytes = audio ? wav(`${subjectId}-${n}`) : png(1024, 1024, `${subjectId}-${n}`);
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, rel), bytes);
  return { rel, sha: sha(bytes) };
}

/** 対象ごとのループを始め、成果物と（声なら）測定を置き、batch の1行を返す。 */
async function prepareItems(root, { harnessId = "koya-manga-video", stage, subjects, refs = false }) {
  const fx = await stageInputs(root, stage);
  const items = [];
  const versions = {};
  let contract = null;
  for (const subjectId of subjects) {
    const started = await startAssetQualityLoop({ workDir: root, harnessId, stage, subjectId, generatorContextId: MAKER, generatorHost: "claude-code", now });
    assert.equal(started.started, true);
    contract = started.state.asset.contract;
    const version = await writeAsset(root, stage, subjectId, 1);
    versions[subjectId] = version;
    const extra = await fx.recordExtra(version);
    items.push({
      subjectId,
      asset: version.rel,
      version: "v1",
      ...(extra.measurementPath ? { measurement: extra.measurementPath } : {}),
      ...(refs ? { references: fx.refs } : (stage === "scene-image" || stage === "thumbnail" ? { referenceExemptReason: "人物の写らない背景だけの画" } : {})),
    });
  }
  const manifest = {
    version: ASSET_QUALITY_BATCH_VERSION,
    stage,
    producerContexts: [MAKER],
    producerHost: "claude-code",
    route: stage === "voice-take" ? "broker" : "codex",
    ...(refs ? { approvedReferences: "refs/approved.json" } : {}),
    items,
  };
  return { fx, items, versions, contract, manifest };
}

async function writeJson(root, rel, body) {
  await mkdir(path.dirname(join(root, rel)), { recursive: true });
  await writeFile(join(root, rel), `${JSON.stringify(body, null, 2)}\n`);
  return rel;
}

/** 評価者が書く batch の採点ファイル（1つの評価文脈・対象ごとの採点）。所見は対象ごとに書く。 */
function batchReview({ stage, context, contract, entries, refs = [] }) {
  return {
    version: ASSET_QUALITY_BATCH_REVIEW_VERSION,
    evaluatorId: "evaluator",
    evaluatorContextId: context,
    evaluatorHost: "codex",
    reviews: entries.map(({ subjectId, assetSha, overrides = {}, notes = "" }) => {
      const { evaluatorId: _id, evaluatorContextId: _ctx, evaluatorHost: _host, ...entry } = reviewFor({ stage, context, assetSha, refs, contract, overrides });
      return { subjectId, ...entry, notes: notes || `${entry.notes}／${subjectId} は冒頭と語尾を聞き直した` };
    }),
  };
}

test("batch の記録: 1回の評価で複数の対象を採点し、対象ごとの判定を sha256 つきで記録する。1つが不合格でも他の合格は有効", async (t) => {
  const root = await workspace(t);
  const stage = "voice-take";
  const subjects = ["synthetic-line-001", "synthetic-line-002", "synthetic-line-003"];
  const { manifest, versions, contract } = await prepareItems(root, { stage, subjects });
  const manifestPath = await writeJson(root, "batches/m1.json", manifest);

  const { sheet, template, excluded } = await assetQualityBatchReviewTemplate({ workDir: root, stage, manifestPath: join(root, manifestPath) });
  assert.deepEqual(excluded, []);
  assert.deepEqual(sheet.items.map((row) => [row.subjectId, row.asset.sha256]), subjects.map((id) => [id, versions[id].sha]));
  assert.deepEqual(template.reviews.map((row) => row.subjectId), subjects);
  assert.ok(template.reviews.every((row) => Object.values(row.rubricScores).every((value) => value === null)));

  const review = await writeJson(root, "reviews/batch-1.json", batchReview({
    stage, context: "ctx-eval-batch-1", contract,
    entries: subjects.map((subjectId) => ({ subjectId, assetSha: versions[subjectId].sha, overrides: subjectId === subjects[1] ? { "voice-continuity": 40 } : {} })),
  }));
  const result = await recordAssetQualityBatch({ workDir: root, stage, manifestPath: join(root, manifestPath), reviewPath: review, now });
  assert.deepEqual(result.issues.filter((issue) => !issue.startsWith(`${subjects[1]}:`)), [], JSON.stringify(result.issues));
  assert.deepEqual(result.results.map((row) => [row.subjectId, row.recorded, row.check.status]), [
    [subjects[0], true, "passed"],
    [subjects[1], true, "active"],
    [subjects[2], true, "passed"],
  ]);
  // 対象ごとの判定: 状態は1件ずつの記録と同じ場所・同じ形（関門はこれを読む）。
  for (const subjectId of subjects) {
    const status = await assetQualityStatus({ workDir: root, stage, subjectId, assetPath: versions[subjectId].rel });
    assert.equal(status.pass, subjectId !== subjects[1], subjectId);
    const version = status.state.asset.versions.at(-1);
    assert.equal(version.assetSha256, versions[subjectId].sha);
    assert.equal(version.evaluatorContextId, "ctx-eval-batch-1");
    assert.equal(version.batch.recordId, result.recordId);
    assert.match(version.reviewSha256, /^[a-f0-9]{64}$/u, "対象ごとの採点の digest（batch のファイル全体の SHA ではない）");
    assert.equal(version.reviewPath, "reviews/batch-1.json");
  }
  assert.deepEqual(result.results[1].round.floorFailures, ["voice-continuity"]);

  // batch の記録（私有の作業フォルダ）: 対象ごとの判定を sha256 つきで残す。
  const record = JSON.parse(await readFile(assetQualityBatchPaths(root, stage, result.recordId).recordPath, "utf8"));
  assert.equal(record.evaluatorContextId, "ctx-eval-batch-1");
  assert.equal(record.reviewSha256, sha(await readFile(join(root, review))));
  assert.deepEqual(record.items.map((row) => [row.subjectId, row.assetSha256, row.recorded, row.loopStatus]), [
    [subjects[0], versions[subjects[0]].sha, true, "passed"],
    [subjects[1], versions[subjects[1]].sha, true, "active"],
    [subjects[2], versions[subjects[2]].sha, true, "passed"],
  ]);

  // 同じ batch の採点を記録し直しても、回は増えない（二重起動・再実行）。
  const again = await recordAssetQualityBatch({ workDir: root, stage, manifestPath: join(root, manifestPath), reviewPath: review, now });
  assert.deepEqual(again.results.map((row) => [row.recorded, row.alreadyRecorded === true]), [[false, true], [false, true], [false, true]]);
  for (const subjectId of subjects) {
    assert.equal((await assetQualityStatus({ workDir: root, stage, subjectId })).state.rounds.length, 1);
  }

  // 漫画の関門（使う前の照合）は、batch の記録も1件ずつの記録と同じに読む。
  const koyaContract = await currentKoyaContract(repoRoot);
  const koya = await checkKoyaAssetQuality({ contract: koyaContract, workDir: root, stage, subjectId: subjects[0], assetPath: versions[subjects[0]].rel });
  assert.equal(koya.pass, true, JSON.stringify(koya));
  const koyaFailed = await checkKoyaAssetQuality({ contract: koyaContract, workDir: root, stage, subjectId: subjects[1], assetPath: versions[subjects[1]].rel });
  assert.equal(koyaFailed.reason, "not-passed");
});

test("再評価は不合格の対象だけ: シートは合格した対象を外し、合格した対象の採点は記録し直さない。直した対象には差分が要る", async (t) => {
  const root = await workspace(t);
  const stage = "voice-take";
  const subjects = ["synthetic-line-101", "synthetic-line-102", "synthetic-line-103"];
  const { manifest, versions, contract, fx } = await prepareItems(root, { stage, subjects });
  const manifestPath = join(root, await writeJson(root, "batches/m1.json", manifest));
  const first = await recordAssetQualityBatch({
    workDir: root, stage, manifestPath, now,
    reviewPath: await writeJson(root, "reviews/b1.json", batchReview({
      stage, context: "ctx-eval-b1", contract,
      entries: subjects.map((subjectId) => ({ subjectId, assetSha: versions[subjectId].sha, overrides: subjectId === subjects[1] ? { "line-fits-context": 30 } : {} })),
    })),
  });
  const fingerprint = first.results[1].round.failureFingerprint;
  assert.match(fingerprint, /^quality-failure:/u);

  // 直した版（不合格の対象だけ）。
  const v2 = await writeAsset(root, stage, subjects[1], 2);
  const extra = await fx.recordExtra(v2);
  const retryManifest = {
    ...manifest,
    items: manifest.items.map((item) => (item.subjectId === subjects[1]
      ? { ...item, asset: v2.rel, version: "v2", measurement: extra.measurementPath, previousFailureFingerprint: fingerprint, revisionDelta: "台詞の前の間を詰めて録り直した" }
      : item)),
  };
  const retryPath = join(root, await writeJson(root, "batches/m2.json", retryManifest));
  const { sheet, excluded } = await assetQualityBatchReviewTemplate({ workDir: root, stage, manifestPath: retryPath });
  assert.deepEqual(sheet.items.map((row) => row.subjectId), [subjects[1]], "シートに載るのは不合格の対象だけ");
  assert.deepEqual(excluded.map((row) => [row.subjectId, row.reason]), [[subjects[0], "already-passed"], [subjects[2], "already-passed"]]);

  // 評価者が全部を採点し直しても、合格した対象は記録し直さない（回を消費しない）。
  const allAgain = batchReview({
    stage, context: "ctx-eval-b2", contract,
    entries: [
      { subjectId: subjects[0], assetSha: versions[subjects[0]].sha },
      { subjectId: subjects[1], assetSha: v2.sha },
      { subjectId: subjects[2], assetSha: versions[subjects[2]].sha },
    ],
  });
  const second = await recordAssetQualityBatch({ workDir: root, stage, manifestPath: retryPath, reviewPath: await writeJson(root, "reviews/b2.json", allAgain), now });
  assert.deepEqual(second.results.map((row) => [row.subjectId, row.recorded]), [[subjects[0], false], [subjects[1], true], [subjects[2], false]]);
  assert.ok(second.results[0].issues.includes("asset-quality-loop-already-passed"));
  assert.equal(second.results[1].check.status, "passed");
  assert.equal(second.results[1].round.previousFailureFingerprint, fingerprint);
  for (const subjectId of [subjects[0], subjects[2]]) {
    assert.equal((await assetQualityStatus({ workDir: root, stage, subjectId })).state.rounds.length, 1, "合格した対象の回は増えない");
  }

  // 直しの差分が無い対象だけが止まり、同じ batch の他の対象は進む。
  const third = await prepareItems(root, { stage, subjects: ["synthetic-line-201", "synthetic-line-202"] });
  const thirdPath = join(root, await writeJson(root, "batches/m3.json", third.manifest));
  const failAll = await recordAssetQualityBatch({
    workDir: root, stage, manifestPath: thirdPath, now,
    reviewPath: await writeJson(root, "reviews/b3.json", batchReview({
      stage, context: "ctx-eval-b3", contract: third.contract,
      entries: third.items.map((item) => ({ subjectId: item.subjectId, assetSha: third.versions[item.subjectId].sha, overrides: { "voice-continuity": 50 } })),
    })),
  });
  assert.ok(failAll.results.every((row) => row.recorded && row.check.status === "active"));
  const fixedOne = await writeAsset(root, stage, "synthetic-line-201", 2);
  const fixedTwo = await writeAsset(root, stage, "synthetic-line-202", 2);
  const retry = {
    ...third.manifest,
    items: [
      { subjectId: "synthetic-line-201", asset: fixedOne.rel, version: "v2", measurement: (await third.fx.recordExtra(fixedOne)).measurementPath, previousFailureFingerprint: failAll.results[0].round.failureFingerprint, revisionDelta: "声の響きを直前の地の文に合わせた" },
      { subjectId: "synthetic-line-202", asset: fixedTwo.rel, version: "v2", measurement: (await third.fx.recordExtra(fixedTwo)).measurementPath },
    ],
  };
  const partial = await recordAssetQualityBatch({
    workDir: root, stage, now,
    manifestPath: join(root, await writeJson(root, "batches/m4.json", retry)),
    reviewPath: await writeJson(root, "reviews/b4.json", batchReview({
      stage, context: "ctx-eval-b4", contract: third.contract,
      entries: [{ subjectId: "synthetic-line-201", assetSha: fixedOne.sha }, { subjectId: "synthetic-line-202", assetSha: fixedTwo.sha }],
    })),
  });
  assert.deepEqual(partial.results.map((row) => [row.subjectId, row.recorded]), [["synthetic-line-201", true], ["synthetic-line-202", false]]);
  assert.deepEqual(partial.results[1].issues, [`asset-quality-revision-delta-required:${failAll.results[1].round.failureFingerprint}`]);
});

test("人の確認が要る対象は、batch で採点しても対象ごとに人の確認が要る（batch の人の確認は無い）", async (t) => {
  const root = await workspace(t);
  const stage = "scene-image";
  const subjects = ["synthetic-cut-01", "synthetic-cut-02"];
  const { manifest, versions, contract, fx } = await prepareItems(root, { stage, subjects, refs: true });
  const manifestPath = join(root, await writeJson(root, "batches/m.json", manifest));
  const result = await recordAssetQualityBatch({
    workDir: root, stage, manifestPath, now,
    reviewPath: await writeJson(root, "reviews/b.json", batchReview({ stage, context: "ctx-eval-img", contract, refs: fx.refs, entries: subjects.map((subjectId) => ({ subjectId, assetSha: versions[subjectId].sha })) })),
  });
  assert.deepEqual(result.results.map((row) => row.check.status), ["awaiting-human-verification", "awaiting-human-verification"]);
  await verify(root, stage, subjects[0], versions[subjects[0]].rel, ["identity"]);
  assert.equal((await assetQualityStatus({ workDir: root, stage, subjectId: subjects[0], assetPath: versions[subjects[0]].rel })).pass, true);
  assert.equal((await assetQualityStatus({ workDir: root, stage, subjectId: subjects[1], assetPath: versions[subjects[1]].rel })).pass, false, "1件の人の確認は他の対象に効かない");
  const stdout = { write: () => {} };
  await assert.rejects(
    runAssetQualityCli(["verify", "--work-dir", root, "--stage", stage, "--batch", manifestPath, "--check", "identity", "--pass", "--reviewer", "synthetic-reviewer", "--note", "並べて見た", "--human-verified"], { stdout, now, isInteractive: true }),
    /人の確認は対象ごと/u,
  );
});

test("評価者の独立と所見は対象ごと: 作った文脈で採点した対象・所見を写した対象だけが止まり、他は記録する", async (t) => {
  const root = await workspace(t);
  const stage = "voice-take";
  const subjects = ["synthetic-line-301", "synthetic-line-302", "synthetic-line-303", "synthetic-line-304"];
  const { manifest, versions, contract } = await prepareItems(root, { stage, subjects });
  // 2件目は別の会話が作った版で、その会話が評価者を名乗っている。
  manifest.items[1].producerContexts = ["ctx-eval-shared"];
  const manifestPath = join(root, await writeJson(root, "batches/m.json", manifest));
  const body = batchReview({ stage, context: "ctx-eval-shared", contract, entries: subjects.map((subjectId) => ({ subjectId, assetSha: versions[subjectId].sha })) });
  // 3件目と4件目は同じ所見の写し（1件ずつ見た証拠にならない）。
  body.reviews[2].notes = "全体を通して聞いた。問題なし";
  body.reviews[3].notes = "全体を通して聞いた。問題なし";
  const result = await recordAssetQualityBatch({ workDir: root, stage, manifestPath, reviewPath: await writeJson(root, "reviews/b.json", body), now });
  assert.deepEqual(result.results.map((row) => [row.subjectId, row.recorded]), [[subjects[0], true], [subjects[1], false], [subjects[2], false], [subjects[3], false]]);
  assert.ok(result.results[1].issues.includes("asset-quality-evaluator-not-independent"));
  for (const row of result.results.slice(2)) assert.ok(row.issues.includes("asset-quality-batch-review-notes-duplicated"), JSON.stringify(row.issues));
});

test("batch の上限・対象の重複・頼んでいない対象の採点・工程の違いは、何も記録せずに止める", async (t) => {
  const root = await workspace(t);
  const stage = "voice-take";
  const tooMany = { version: ASSET_QUALITY_BATCH_VERSION, stage, items: Array.from({ length: ASSET_QUALITY_BATCH_MAX_ITEMS + 1 }, (_, index) => ({ subjectId: `synthetic-line-${index}`, asset: `assets/l${index}.wav`, version: "v1" })) };
  assert.equal(ASSET_QUALITY_BATCH_MAX_ITEMS, 50);
  assert.throws(() => normalizeAssetQualityBatch(tooMany, { workDir: root, stage }), /50 件まで/u);
  const duplicated = { version: ASSET_QUALITY_BATCH_VERSION, stage, items: [{ subjectId: "a", asset: "assets/a.wav", version: "v1" }, { subjectId: "a", asset: "assets/b.wav", version: "v1" }] };
  assert.throws(() => normalizeAssetQualityBatch(duplicated, { workDir: root, stage }), /重複/u);
  assert.throws(() => normalizeAssetQualityBatch({ ...duplicated, stage: "scene-image", items: [] }, { workDir: root, stage }), /工程/u);
  assert.throws(() => normalizeAssetQualityBatch({ version: "x", stage, items: [] }, { workDir: root, stage }), /buzzassist-asset-quality-batch-v1/u);

  const subjects = ["synthetic-line-401", "synthetic-line-402"];
  const { manifest, versions, contract } = await prepareItems(root, { stage, subjects });
  const manifestPath = join(root, await writeJson(root, "batches/m.json", manifest));
  const extra = batchReview({ stage, context: "ctx-eval-x", contract, entries: [...subjects.map((subjectId) => ({ subjectId, assetSha: versions[subjectId].sha })), { subjectId: "synthetic-not-asked", assetSha: "a".repeat(64) }] });
  const refused = await recordAssetQualityBatch({ workDir: root, stage, manifestPath, reviewPath: await writeJson(root, "reviews/x.json", extra), now });
  assert.equal(refused.recorded, 0);
  assert.deepEqual(refused.issues, ["asset-quality-batch-review-unexpected:synthetic-not-asked"]);
  for (const subjectId of subjects) assert.equal((await assetQualityStatus({ workDir: root, stage, subjectId })).state.rounds.length, 0, "何も記録しない");
  const oversized = { ...extra, reviews: Array.from({ length: ASSET_QUALITY_BATCH_MAX_ITEMS + 1 }, (_, index) => ({ ...extra.reviews[0], subjectId: `synthetic-line-${index}` })) };
  const tooLarge = await recordAssetQualityBatch({ workDir: root, stage, manifestPath, reviewPath: await writeJson(root, "reviews/y.json", oversized), now });
  assert.deepEqual(tooLarge.issues, ["asset-quality-batch-review-too-many-entries"]);
  // 採点の無い対象は、その対象だけが止まる。
  const missingOne = batchReview({ stage, context: "ctx-eval-y", contract, entries: [{ subjectId: subjects[0], assetSha: versions[subjects[0]].sha }] });
  const partial = await recordAssetQualityBatch({ workDir: root, stage, manifestPath, reviewPath: await writeJson(root, "reviews/z.json", missingOne), now });
  assert.deepEqual(partial.results.map((row) => [row.subjectId, row.recorded]), [[subjects[0], true], [subjects[1], false]]);
  assert.deepEqual(partial.results[1].issues, ["asset-quality-batch-entry-missing"]);
});

test("batch の評価シートには、合格点・下限・重み・前の回の点数と失敗指紋・状態の置き場を載せない", async (t) => {
  const root = await workspace(t);
  const stage = "thumbnail";
  const subjects = ["synthetic-thumb-a", "synthetic-thumb-b"];
  const fx = await stageInputs(root, stage);
  const manifestItems = [];
  let failed = null;
  for (const subjectId of subjects) {
    const { state } = await startAssetQualityLoop({ workDir: root, harnessId: "narrated-story-video", stage, subjectId, generatorContextId: MAKER, now });
    const bytes = png(1280, 720, `${subjectId}-1`);
    const rel = `assets/${subjectId}-v1.png`;
    await writeFile(join(root, rel), bytes);
    if (subjectId === subjects[0]) {
      failed = await recordAssetQualityRound({
        workDir: root, stage, subjectId, assetPath: rel, versionLabel: "v0", now, ...(await fx.recordExtra({ rel, sha: sha(bytes) })),
        reviewPath: await writeReview(root, "single", reviewFor({ stage, context: "ctx-eval-0", assetSha: sha(bytes), refs: fx.refs, contract: state.asset.contract, overrides: { "lettering-design": 33 } })),
      });
      assert.equal(failed.recorded, true);
      const fixedBytes = png(1280, 720, `${subjectId}-2`);
      await writeFile(join(root, `assets/${subjectId}-v2.png`), fixedBytes);
      manifestItems.push({ subjectId, asset: `assets/${subjectId}-v2.png`, version: "v1", references: fx.refs });
    } else {
      manifestItems.push({ subjectId, asset: rel, version: "v1", references: fx.refs });
    }
  }
  const manifestPath = join(root, await writeJson(root, "batches/t.json", { version: ASSET_QUALITY_BATCH_VERSION, stage, items: manifestItems }));
  const { sheet, template } = await assetQualityBatchReviewTemplate({ workDir: root, stage, manifestPath });
  const keys = [];
  const numbers = [];
  const walk = (value) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) { keys.push(key); walk(child); }
    else if (typeof value === "number") numbers.push(value);
  };
  walk(sheet);
  for (const forbidden of ASSET_REVIEW_SHEET_FORBIDDEN_KEYS) assert.equal(keys.includes(forbidden), false, `batch の評価シートに ${forbidden} が載っている`);
  assert.deepEqual([...new Set(numbers)].sort((a, b) => a - b), [0, 100], "数値は尺度だけ");
  const text = JSON.stringify({ sheet, template });
  assert.equal(text.includes(failed.round.failureFingerprint), false, "前の回の失敗指紋を載せない");
  assert.equal(text.includes(String(failed.round.score)), false, "前の回の点数を載せない");
  assert.equal(text.includes(path.join("quality", "assets")), false, "状態の置き場を載せない");
  assert.deepEqual(sheet.items.map((row) => row.subjectId), subjects);
  assert.deepEqual(sheet.items[0].reviewRequirements.map((row) => row.id), ["charactersVisible", "comparedReferenceSha256s", "identityComparison", "viewedAtDecidedSize"]);
  const templateKeys = [];
  const collect = (value) => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) { templateKeys.push(key); collect(child); }
  };
  collect(template);
  for (const forbidden of ASSET_REVIEW_SHEET_FORBIDDEN_KEYS) assert.equal(templateKeys.includes(forbidden), false, `batch の雛形に ${forbidden} が載っている`);
});

test("ナレーション物語の関門は、batch で記録した本編の画のループも1件ずつの記録と同じに読む", async (t) => {
  const runDir = await workspace(t);
  const stage = "scene-image";
  const subjects = ["s001", "s002"];
  const { manifest, versions, contract } = await prepareItems(runDir, { harnessId: "narrated-story-video", stage, subjects });
  const manifestPath = join(runDir, await writeJson(runDir, "batches/m.json", manifest));
  const result = await recordAssetQualityBatch({
    workDir: runDir, stage, manifestPath, now,
    reviewPath: await writeJson(runDir, "reviews/b.json", batchReview({ stage, context: "ctx-eval-narrated", contract, entries: subjects.map((subjectId) => ({ subjectId, assetSha: versions[subjectId].sha })) })),
  });
  assert.deepEqual(result.results.map((row) => row.check.status), ["passed", "passed"]);
  const gate = await gateNarratedAssetLoops({
    runDir,
    scenes: subjects.map((sceneId) => brokerSceneLoopSubject(sceneId, { runDir, imagePath: join(runDir, versions[sceneId].rel) })),
  });
  assert.equal(gate.pass, true, gate.issues.join(", "));
  assert.equal(gate.checks.sceneImageAssetLoopPassed.pass, true);
});

test("Windows の区切りでも、batch の成果物は作業フォルダの中だけを受け、/ 区切りの相対パスで残す", async (t) => {
  const win = path.win32;
  const normalized = normalizeAssetQualityBatch({
    version: ASSET_QUALITY_BATCH_VERSION,
    stage: "voice-take",
    items: [
      { subjectId: "synthetic-line-1", asset: "media\\voice\\l1.wav", version: "v1", measurement: "quality\\voice-take-measurements\\l1.json" },
      { subjectId: "synthetic-line-2", asset: "C:\\work\\job\\media\\voice\\l2.wav", version: "v1" },
    ],
  }, { workDir: "C:\\work\\job", stage: "voice-take", pathApi: win });
  assert.deepEqual(normalized.items.map((item) => item.asset.rel), ["media/voice/l1.wav", "media/voice/l2.wav"]);
  assert.equal(normalized.items[0].measurement.rel, "quality/voice-take-measurements/l1.json");
  assert.throws(() => normalizeAssetQualityBatch({
    version: ASSET_QUALITY_BATCH_VERSION, stage: "voice-take", items: [{ subjectId: "x", asset: "D:\\other\\x.wav", version: "v1" }],
  }, { workDir: "C:\\work\\job", stage: "voice-take", pathApi: win }), /作業フォルダの中/u);
  const root = await workspace(t);
  const paths = assetQualityBatchPaths(root, "voice-take", "0123456789abcdef");
  assert.equal(paths.recordPath, join(root, "quality", "assets", "batches", "voice-take--0123456789abcdef.json"));
});

test("CLI: sheet --batch と record --batch（人待ちが残れば 3）、--batch と --subject は同時に使えない", async (t) => {
  const root = await workspace(t);
  const stage = "voice-take";
  const subjects = ["synthetic-line-501", "synthetic-line-502"];
  const { manifest, versions, contract } = await prepareItems(root, { stage, subjects });
  const manifestPath = join(root, await writeJson(root, "batches/m.json", manifest));
  const out = [];
  const stdout = { write: (value) => out.push(value) };
  const env = { BUZZASSIST_LEARNING_AUTO_CAPTURE: "0" };
  const sheetRun = await runAssetQualityCli(["sheet", "--work-dir", root, "--stage", stage, "--batch", manifestPath], { stdout });
  assert.equal(sheetRun.exitCode, 0);
  assert.deepEqual(JSON.parse(out.join("")).sheet.items.map((row) => row.subjectId), subjects);
  const review = await writeJson(root, "reviews/cli.json", batchReview({ stage, context: "ctx-eval-cli", contract, entries: [{ subjectId: subjects[0], assetSha: versions[subjects[0]].sha }] }));
  const recorded = await runAssetQualityCli(["record", "--work-dir", root, "--stage", stage, "--batch", manifestPath, "--review", review, "--json"], { stdout, now, env });
  assert.equal(recorded.exitCode, 3, "採点の無い対象が残れば人待ち");
  assert.equal(recorded.result.recorded, 1);
  await assert.rejects(runAssetQualityCli(["record", "--work-dir", root, "--stage", stage, "--batch", manifestPath, "--subject", subjects[0], "--review", review], { stdout, now, env }), /--batch と --subject/u);
});
