// 途中の成果物の品質ループの工程 video-clip（動画クリップ）。機械ゲート（形式・全フレームのデコード・尺・fps・
// 解像度・音声の有無・参照の承認）・評価項目と下限・人の確認・評価シート・batch・CLI の測定・学習の捕捉を見る。
// 動画は試験の中で ffmpeg の lavfi で作る（有料 API・ネットワークは使わない）。人物・会話 id・対象 id・所見は合成の値。
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path, { join } from "node:path";
import test from "node:test";

import { assetRoundLearningCandidates } from "../lib/assetQualityLearning.mjs";
import {
  ASSET_MACHINE_GATES,
  ASSET_QUALITY_BATCH_REVIEW_VERSION,
  ASSET_QUALITY_BATCH_VERSION,
  ASSET_QUALITY_HARNESSES,
  ASSET_REVIEW_SHEET_FORBIDDEN_KEYS,
  assetQualityBatchReviewTemplate,
  assetQualityReviewTemplate,
  assetQualityStatus,
  createAssetQualityContract,
  normalizeAssetQualityBatch,
  recordAssetQualityBatch,
  recordAssetQualityRound,
  requiredHumanChecks,
  startAssetQualityLoop,
} from "../lib/assetQualityLoop.mjs";
import {
  VIDEO_CLIP_DECLARATION_VERSION,
  VIDEO_CLIP_GATE_IDS,
  VIDEO_CLIP_MEASUREMENT_VERSION,
  evaluateVideoClipMeasurement,
  measureVideoClip,
  normalizeVideoClipDeclaration,
  writeVideoClipMeasurement,
} from "../lib/videoClipMeasurement.mjs";
import { runAssetQualityCli } from "../scripts/asset-quality-loop.mjs";
import {
  MAKER,
  VIDEO_DECLARATION,
  now,
  reviewFor,
  sha,
  stageInputs,
  synthVideo,
  verify,
  workspace,
  writeReview,
} from "./fixtures/assetQualityFixtures.mjs";

const STAGE = "video-clip";

async function clip(root, name, options = {}) {
  const rel = `assets/${name}.mp4`;
  const bytes = await synthVideo(join(root, rel), { salt: name, ...options });
  return { rel, sha: sha(bytes) };
}

async function measure(root, version, declaration = VIDEO_DECLARATION) {
  const rel = `measure/${path.basename(version.rel)}.json`;
  await writeVideoClipMeasurement({ assetPath: join(root, version.rel), declaration, outputPath: join(root, rel) });
  return rel;
}

test("工程 video-clip は漫画とナレーション物語の両方のハーネスで使え、評価項目・下限・機械ゲート・人の確認の欄を持つ", () => {
  for (const harnessId of ["koya-manga-video", "narrated-story-video"]) {
    assert.ok(ASSET_QUALITY_HARNESSES[harnessId].stages.includes(STAGE), `${harnessId} で video-clip を使える`);
  }
  const { contract } = createAssetQualityContract({ harnessId: "narrated-story-video", stage: STAGE });
  const floors = Object.fromEntries(contract.rubric.map((row) => [row.id, row.minimumScore]));
  assert.deepEqual(floors, {
    "source-intent-match": 80,
    "character-identity": 80,
    "motion-integrity": 60,
    "hand-safety": 100,
    "art-style-match": 60,
    "no-text-or-logo": 100,
  });
  assert.equal(Math.round(contract.rubric.reduce((sum, row) => sum + row.weight, 0)), 100);
  assert.equal(contract.media, "video");
  for (const id of VIDEO_CLIP_GATE_IDS) {
    assert.ok(contract.machineGates.includes(id), `機械ゲート ${id}`);
    assert.ok(ASSET_MACHINE_GATES[id], `${id} の説明が一覧にある`);
  }
  for (const id of ["asset-readable", "reference-declared", "reference-approved", "human-rejection-absent"]) assert.ok(contract.machineGates.includes(id));
  // 人の確認: 参照があるか、評価者が人物が写っていると答えた版は、同一性と手指を人が見る。
  assert.deepEqual(requiredHumanChecks(STAGE, { referenceSha256s: ["a".repeat(64)] }), ["identity", "hand-safety"]);
  assert.deepEqual(requiredHumanChecks(STAGE, { referenceSha256s: [], charactersVisible: true }), ["identity", "hand-safety"]);
  assert.deepEqual(requiredHumanChecks(STAGE, { referenceSha256s: [], charactersVisible: false }), []);
});

test("宣言は範囲と音声の有無を必須にし、壊れた宣言では測らない", async (t) => {
  assert.equal(normalizeVideoClipDeclaration(VIDEO_DECLARATION).ok, true);
  assert.deepEqual(normalizeVideoClipDeclaration({ ...VIDEO_DECLARATION, audio: "maybe" }).problems, ["audio"]);
  assert.deepEqual(normalizeVideoClipDeclaration({ ...VIDEO_DECLARATION, durationSeconds: { min: 5, max: 1 } }).problems, ["durationSeconds.min-above-max"]);
  assert.deepEqual(normalizeVideoClipDeclaration({ ...VIDEO_DECLARATION, frameRate: undefined }).problems, ["frameRate-required"]);
  assert.deepEqual(normalizeVideoClipDeclaration({ ...VIDEO_DECLARATION, extra: 1 }).problems, ["extra-unknown"]);
  const root = await workspace(t);
  const version = await clip(root, "declared");
  await assert.rejects(measureVideoClip({ assetPath: join(root, version.rel), declaration: { ...VIDEO_DECLARATION, version: "v0" } }), /宣言が読めない/u);
});

test("機械ゲート: 壊れた動画・途中で切れた動画・尺の外れ・fps の外れ・解像度の外れ・音声の有無の不一致は、測定から落ちる", async (t) => {
  const root = await workspace(t);
  const gatesOf = async (version, declaration = VIDEO_DECLARATION) => {
    const measurement = await measureVideoClip({ assetPath: join(root, version.rel), declaration });
    // 測定のファイルに書くのは数値だけ。測定は測ったファイルの sha256 を持ち、パスは持たない。
    assert.equal(measurement.version, VIDEO_CLIP_MEASUREMENT_VERSION);
    assert.equal(measurement.assetSha256, version.sha);
    assert.equal(JSON.stringify(measurement).includes(root), false, "測定にパスを残さない");
    const verdict = evaluateVideoClipMeasurement(measurement, { assetSha256: version.sha });
    return Object.entries(verdict.gates).filter(([, pass]) => !pass).map(([id]) => id).sort();
  };
  const good = await clip(root, "good");
  assert.deepEqual(await gatesOf(good), []);

  // 壊れた動画（動画ではないバイト列・先頭だけの MP4）。
  await writeFile(join(root, "assets", "garbage.mp4"), Buffer.from("synthetic bytes that are not a video"));
  const garbage = { rel: "assets/garbage.mp4", sha: sha(await readFile(join(root, "assets", "garbage.mp4"))) };
  assert.deepEqual(await gatesOf(garbage), [
    "video-duration-declared", "video-format-readable", "video-frame-rate-declared", "video-full-decode", "video-resolution-declared",
  ]);
  const whole = await readFile(join(root, good.rel));
  await writeFile(join(root, "assets", "truncated.mp4"), whole.subarray(0, Math.floor(whole.length / 2)));
  const truncated = { rel: "assets/truncated.mp4", sha: sha(await readFile(join(root, "assets", "truncated.mp4"))) };
  const truncatedGates = await gatesOf(truncated);
  assert.ok(truncatedGates.includes("video-full-decode"), `途中で切れた動画を最後までデコードできたことにしない: ${truncatedGates}`);

  // 尺・fps・解像度の外れ。
  assert.deepEqual(await gatesOf(await clip(root, "long", { seconds: 4 })), ["video-duration-declared"]);
  assert.deepEqual(await gatesOf(await clip(root, "fast", { rate: 60 })), ["video-frame-rate-declared"]);
  assert.deepEqual(await gatesOf(await clip(root, "square", { size: "240x240" })), ["video-resolution-declared"], "縦横比の外れ");
  assert.deepEqual(await gatesOf(await clip(root, "small", { size: "128x72" })), ["video-resolution-declared"], "最小の寸法の外れ");

  // 音声の有無の不一致（禁止なのにある・必須なのに無い）。optional はどちらでも通る。
  const withAudio = await clip(root, "with-audio", { audio: true });
  assert.deepEqual(await gatesOf(withAudio), ["video-audio-declared"]);
  assert.deepEqual(await gatesOf(good, { ...VIDEO_DECLARATION, audio: "required" }), ["video-audio-declared"]);
  assert.deepEqual(await gatesOf(withAudio, { ...VIDEO_DECLARATION, audio: "required" }), []);
  assert.deepEqual(await gatesOf(withAudio, { ...VIDEO_DECLARATION, audio: "optional" }), []);

  // 別のクリップの測定・版の無い測定は、どのゲートも通さない（測定に書いた合否は読まない）。
  const measurement = await measureVideoClip({ assetPath: join(root, good.rel), declaration: VIDEO_DECLARATION });
  const other = evaluateVideoClipMeasurement(measurement, { assetSha256: withAudio.sha });
  assert.equal(other.bound, false);
  assert.ok(Object.values(other.gates).every((pass) => pass === false));
  assert.ok(other.problems.includes("measurement-not-bound-to-clip"));
  const forged = evaluateVideoClipMeasurement({ ...measurement, pass: true, probe: { ...measurement.probe, durationSeconds: 9 } }, { assetSha256: good.sha });
  assert.equal(forged.gates["video-duration-declared"], false, "数値から決め直す");
});

test("品質ループ: 測定が無い・別のクリップの測定・音声の不一致は機械ゲートで落ち、満点でも合格しない。直した版で合格し、人の確認まで要る", async (t) => {
  const root = await workspace(t);
  const fx = await stageInputs(root, STAGE);
  const loop = async (subjectId) => {
    const started = await startAssetQualityLoop({ workDir: root, harnessId: "koya-manga-video", stage: STAGE, subjectId, generatorContextId: MAKER, generatorHost: "codex", now });
    const contract = started.state.asset.contract;
    return async (version, label, context, extra = {}) => recordAssetQualityRound({
      workDir: root, stage: STAGE, subjectId, assetPath: version.rel, versionLabel: label, now,
      producerContexts: [MAKER], producerHost: "codex", generationRoute: "media-generation",
      references: fx.refs, approvedReferencesPath: join(root, "refs", "approved.json"),
      reviewPath: await writeReview(root, `${subjectId}-${label}`, reviewFor({ stage: STAGE, context, assetSha: version.sha, refs: fx.refs, contract })),
      ...extra,
    });
  };

  // 測定が無い版・別のクリップの測定を付けた版は、動画のゲートが全部落ちる。
  const v1 = await clip(root, "v1");
  const noMeasurement = await (await loop("synthetic-ep.video.cut-01"))(v1, "v1", "ctx-eval-1");
  assert.equal(noMeasurement.recorded, true);
  assert.deepEqual(noMeasurement.round.failedGateIds, [...VIDEO_CLIP_GATE_IDS].sort(), "測定が無ければ動画のゲートは全部落ちる");
  assert.deepEqual(noMeasurement.version.videoMeasurement.problems, ["measurement-missing"]);
  const v2 = await clip(root, "v2");
  const wrongClip = await (await loop("synthetic-ep.video.cut-02"))(v2, "v1", "ctx-eval-1", { measurementPath: await measure(root, v1) });
  assert.deepEqual(wrongClip.round.failedGateIds, [...VIDEO_CLIP_GATE_IDS].sort(), "別のクリップの測定では通さない");

  // 音声が禁止の宣言なのに音声トラックがある版 → 外して直した版で合格。
  const record = await loop("synthetic-ep.video.cut-03");
  const subjectId = "synthetic-ep.video.cut-03";
  const v3 = await clip(root, "v3", { audio: true });
  const audioMismatch = await record(v3, "v3", "ctx-eval-3", { measurementPath: await measure(root, v3) });
  assert.deepEqual(audioMismatch.round.failedGateIds, ["video-audio-declared"]);
  assert.ok(audioMismatch.version.videoMeasurement.sha256, "測定のファイルの sha256 を版に残す");
  assert.equal(audioMismatch.version.videoMeasurement.metrics.hasAudio, true);
  assert.ok(audioMismatch.round.evidence.some((row) => row.sha256 === audioMismatch.version.videoMeasurement.sha256), "測定は回の証拠に sha256 で入る");

  const v4 = await clip(root, "v4");
  const passed = await record(v4, "v4", "ctx-eval-4", {
    measurementPath: await measure(root, v4), revisionDelta: "音声トラックを外して書き出した", previousFailureFingerprint: audioMismatch.round.failureFingerprint,
  });
  assert.equal(passed.state.status, "passed", JSON.stringify(passed.issues));
  assert.equal(passed.version.media, "video");
  assert.equal(passed.version.generationRoute, "media-generation");
  let status = await assetQualityStatus({ workDir: root, stage: STAGE, subjectId, assetPath: v4.rel });
  assert.equal(status.pass, false, "人の確認（同一性・手指）が要る");
  assert.deepEqual(status.check.humanVerification.missing, ["identity", "hand-safety"]);
  await verify(root, STAGE, subjectId, v4.rel, ["identity", "hand-safety"]);
  status = await assetQualityStatus({ workDir: root, stage: STAGE, subjectId, assetPath: v4.rel });
  assert.equal(status.pass, true, JSON.stringify(status.issues));
  // 合格した版と違うファイルは使えない。
  const other = await assetQualityStatus({ workDir: root, stage: STAGE, subjectId, assetPath: v3.rel });
  assert.equal(other.pass, false);
  assert.ok(other.issues.includes("asset-quality-candidate-not-reviewed-version"));
});

test("採点ファイル: 始まり・中ほど・終わりのフレームを見た記録が無ければ記録しない。評価シートに合格点・下限・前の回の点数を載せない", async (t) => {
  const root = await workspace(t);
  const subjectId = "synthetic-opening";
  const { state } = await startAssetQualityLoop({ workDir: root, harnessId: "narrated-story-video", stage: STAGE, subjectId, generatorContextId: MAKER, now });
  const contract = state.asset.contract;
  const version = await clip(root, "opening");
  const measurementPath = await measure(root, version);
  const base = { workDir: root, stage: STAGE, subjectId, assetPath: version.rel, versionLabel: "v1", now, producerContexts: [MAKER], producerHost: "human", generationRoute: "grok", measurementPath, referenceExemptReason: "人物の写らない題字の映像" };
  const noFrames = await recordAssetQualityRound({
    ...base,
    reviewPath: await writeReview(root, "no-frames", reviewFor({ stage: STAGE, context: "ctx-eval-1", assetSha: version.sha, contract, extra: { framesReviewed: { start: "見た", middle: "", end: "" } } })),
  });
  assert.deepEqual(noFrames.issues, ["asset-quality-review-frames-not-reviewed"]);
  // 人物が写らないと答えた版（参照なし・理由つき）は、人の確認なしで合格する。
  const ok = await recordAssetQualityRound({ ...base, reviewPath: await writeReview(root, "ok", reviewFor({ stage: STAGE, context: "ctx-eval-1", assetSha: version.sha, contract })) });
  assert.equal(ok.state.status, "passed", JSON.stringify(ok.issues));
  assert.equal((await assetQualityStatus({ workDir: root, stage: STAGE, subjectId, assetPath: version.rel })).pass, true);
  // 人物が写っていると答えたのに参照が無い版は reference-declared で落ちる。
  const restarted = await startAssetQualityLoop({ workDir: root, harnessId: "narrated-story-video", stage: STAGE, subjectId: "synthetic-presenter", generatorContextId: MAKER, now });
  const presenter = await clip(root, "presenter");
  const visible = await recordAssetQualityRound({
    ...base, subjectId: "synthetic-presenter", assetPath: presenter.rel, measurementPath: await measure(root, presenter),
    reviewPath: await writeReview(root, "visible", reviewFor({ stage: STAGE, context: "ctx-eval-2", assetSha: presenter.sha, contract: restarted.state.asset.contract, extra: { charactersVisible: true } })),
  });
  assert.deepEqual(visible.round.failedGateIds, ["reference-declared"]);

  const { sheet, template } = await assetQualityReviewTemplate({ workDir: root, stage: STAGE, subjectId, assetPath: version.rel });
  const keys = [];
  const walk = (value) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) { keys.push(key); walk(child); }
  };
  walk(sheet);
  for (const forbidden of ASSET_REVIEW_SHEET_FORBIDDEN_KEYS) assert.equal(keys.includes(forbidden), false, `評価シートに ${forbidden} が載っている`);
  assert.ok(sheet.reviewRequirements.some((row) => row.id === "framesReviewed"));
  assert.deepEqual(template.framesReviewed, { start: "", middle: "", end: "" });
});

test("batch: 動画クリップも1つの評価文脈でまとめて採点でき、対象ごとに記録する。1つが機械ゲートで落ちても他は有効", async (t) => {
  const root = await workspace(t);
  const fx = await stageInputs(root, STAGE);
  const subjects = ["synthetic-ep.video.cut-01", "synthetic-ep.video.cut-02"];
  const items = [];
  const versions = {};
  let contract = null;
  for (const [index, subjectId] of subjects.entries()) {
    const started = await startAssetQualityLoop({ workDir: root, harnessId: "koya-manga-video", stage: STAGE, subjectId, generatorContextId: MAKER, now });
    contract = started.state.asset.contract;
    // 2つ目は音声トラックつき（宣言は禁止）。
    const version = await clip(root, `batch-${index + 1}`, { audio: index === 1 });
    versions[subjectId] = version;
    items.push({ subjectId, asset: version.rel, version: "v1", measurement: await measure(root, version), references: fx.refs });
  }
  const manifest = {
    version: ASSET_QUALITY_BATCH_VERSION, stage: STAGE, producerContexts: [MAKER], producerHost: "codex", route: "media-generation",
    approvedReferences: "refs/approved.json", items,
  };
  await writeFile(join(root, "batch.json"), JSON.stringify(manifest));
  const { sheet } = await assetQualityBatchReviewTemplate({ workDir: root, stage: STAGE, manifestPath: join(root, "batch.json") });
  assert.deepEqual(sheet.items.map((row) => row.subjectId), subjects);
  assert.ok(sheet.items.every((row) => row.reviewRequirements.some((req) => req.id === "framesReviewed")));
  const review = {
    version: ASSET_QUALITY_BATCH_REVIEW_VERSION, evaluatorId: "evaluator", evaluatorContextId: "ctx-eval-batch", evaluatorHost: "codex",
    reviews: subjects.map((subjectId) => {
      const { evaluatorId: _id, evaluatorContextId: _ctx, evaluatorHost: _host, ...entry } = reviewFor({ stage: STAGE, context: "ctx-eval-batch", assetSha: versions[subjectId].sha, refs: fx.refs, contract });
      return { subjectId, ...entry, notes: `${entry.notes}／${subjectId} を通しで再生した` };
    }),
  };
  const reviewPath = await writeReview(root, "batch-review", review);
  const result = await recordAssetQualityBatch({ workDir: root, stage: STAGE, manifestPath: join(root, "batch.json"), reviewPath, now });
  assert.deepEqual(result.results.map((row) => [row.subjectId, row.recorded, row.check.loopStatus]), [
    [subjects[0], true, "passed"],
    [subjects[1], true, "active"],
  ]);
  assert.deepEqual(result.results[1].round.failedGateIds, ["video-audio-declared"]);
  // 人の確認は batch では記録できない（合格した対象も人の確認待ち）。
  const first = await assetQualityStatus({ workDir: root, stage: STAGE, subjectId: subjects[0], assetPath: versions[subjects[0]].rel });
  assert.equal(first.check.status, "awaiting-human-verification");
});

test("batch の対象の一覧は、Windows の区切り（path.win32）でも動画と測定を作業フォルダの中として読む", () => {
  const workDir = "C:\\work\\canvas";
  const batch = normalizeAssetQualityBatch({
    version: ASSET_QUALITY_BATCH_VERSION,
    stage: STAGE,
    producerContexts: [MAKER],
    producerHost: "codex",
    route: "media-generation",
    items: [{ subjectId: "synthetic-ep.video.cut-01", asset: "manga-videos\\ep\\video-substitution\\cut-01\\clip.mp4", version: "v1", measurement: "manga-videos\\ep\\video-substitution\\cut-01\\measurement.json" }],
  }, { workDir, stage: STAGE, pathApi: path.win32 });
  assert.equal(batch.items[0].asset.rel, "manga-videos/ep/video-substitution/cut-01/clip.mp4");
  assert.equal(batch.items[0].asset.full, path.win32.join(workDir, "manga-videos", "ep", "video-substitution", "cut-01", "clip.mp4"));
  assert.equal(batch.items[0].measurement.rel, "manga-videos/ep/video-substitution/cut-01/measurement.json");
  assert.throws(() => normalizeAssetQualityBatch({
    version: ASSET_QUALITY_BATCH_VERSION, stage: STAGE, producerContexts: [MAKER], producerHost: "codex", route: "media-generation",
    items: [{ subjectId: "synthetic-outside", asset: "D:\\elsewhere\\clip.mp4", version: "v1" }],
  }, { workDir, stage: STAGE, pathApi: path.win32 }), /作業フォルダの中/u);
});

test("CLI measure-video: 作業フォルダの中に測定を書き、同じクリップ・同じ宣言なら測り直さない。見込みで落ちるゲートがあれば 3", async (t) => {
  const root = await workspace(t);
  const out = [];
  const stdout = { write: (text) => out.push(text) };
  const toolchain = { ok: true, ffmpeg: { command: "ffmpeg", args: [] }, ffprobe: { command: "ffprobe", args: [] } };
  const version = await clip(root, "cli");
  await writeFile(join(root, "declaration.json"), JSON.stringify(VIDEO_DECLARATION));
  const args = ["measure-video", "--work-dir", root, "--asset", version.rel, "--declaration", join(root, "declaration.json"), "--json"];
  const first = await runAssetQualityCli(args, { stdout, toolchain });
  assert.equal(first.exitCode, 0);
  assert.equal(first.result.reused, false);
  assert.equal(first.result.measurementPath, `quality/video-clip-measurements/${version.sha.slice(0, 16)}.json`);
  const written = JSON.parse(await readFile(join(root, ...first.result.measurementPath.split("/")), "utf8"));
  assert.equal(written.assetSha256, version.sha);
  const again = await runAssetQualityCli(args, { stdout, toolchain });
  assert.equal(again.result.reused, true);
  assert.equal(again.result.sha256, first.result.sha256);
  await writeFile(join(root, "declaration-audio.json"), JSON.stringify({ ...VIDEO_DECLARATION, audio: "required" }));
  const mismatch = await runAssetQualityCli(["measure-video", "--work-dir", root, "--asset", version.rel, "--declaration", join(root, "declaration-audio.json"), "--out", "measure/cli-audio.json"], { stdout, toolchain });
  assert.equal(mismatch.exitCode, 3);
  assert.match(out.join(""), /video-audio-declared/u);
  await assert.rejects(runAssetQualityCli(["measure-video", "--work-dir", root, "--asset", "../outside.mp4", "--declaration", join(root, "declaration.json")], { stdout, toolchain }), /作業フォルダの中/u);
  await assert.rejects(runAssetQualityCli(["measure-video", "--work-dir", root, "--asset", version.rel, "--declaration", join(root, "declaration.json"), "--out", "../escape.json"], { stdout, toolchain }), /作業フォルダの中/u);
});

test("学習: 動画クリップの不合格の回は、工程・失敗指紋・落ちた機械ゲート id だけで候補になる（対象 id・所見は運ばない）", async (t) => {
  const root = await workspace(t);
  const subjectId = "synthetic-private-cut";
  const { state } = await startAssetQualityLoop({ workDir: root, harnessId: "koya-manga-video", stage: STAGE, subjectId, generatorContextId: MAKER, now });
  const contract = state.asset.contract;
  const fx = await stageInputs(root, STAGE);
  const version = await clip(root, "learning", { audio: true });
  const captured = [];
  const result = await recordAssetQualityRound({
    workDir: root, stage: STAGE, subjectId, assetPath: version.rel, versionLabel: "v1", now,
    producerContexts: [MAKER], producerHost: "codex", generationRoute: "media-generation",
    references: fx.refs, approvedReferencesPath: join(root, "refs", "approved.json"), measurementPath: await measure(root, version),
    reviewPath: await writeReview(root, "learn", reviewFor({ stage: STAGE, context: "ctx-eval-1", assetSha: version.sha, refs: fx.refs, contract, overrides: { "motion-integrity": 30 } })),
    captureLearning: async (input) => {
      captured.push(input);
      return { captured: 1 };
    },
  });
  assert.equal(result.recorded, true);
  assert.equal(captured.length, 1);
  const candidates = assetRoundLearningCandidates({ state: captured[0].state, round: captured[0].round, contract: captured[0].contract });
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].gateIds, ["motion-integrity", "video-audio-declared"]);
  assert.match(candidates[0].text, /動画クリップ/u);
  assert.equal(candidates[0].text.includes(subjectId), false, "対象 id を運ばない");
});

test("宣言の版は定数と同じ（測定のファイルの形を試験が固定する）", () => {
  assert.equal(VIDEO_DECLARATION.version, VIDEO_CLIP_DECLARATION_VERSION);
});
