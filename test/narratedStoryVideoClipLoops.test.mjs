// ナレーション物語: 回ごとの運営者の動画（OP 映像・感想パートの人物の映像）は、途中の成果物の品質ループの
// 工程 video-clip で合格した版でなければ使わない（監査契約 v7 から）。取り込みの記録の assetLoop の検査、関門の
// 理由コード、確定の前の再照合、古い契約の扱いを見る。ループは本物の実装で回し、動画は ffmpeg の lavfi で作る。
// 有料 API もネットワークも使わない。人名・会話 id・枠の中身はすべて合成。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  NARRATED_ASSET_LOOP_AUDIT_IDS,
  NARRATED_VIDEO_CLIP_LOOP_AUDIT_ID,
  NARRATED_VIDEO_CLIP_LOOP_SINCE,
  gateNarratedAssetLoops,
  narratedVideoClipLoopsRequired,
  operatorVideoLoopSubject,
  reverifyNarratedAssetLoops,
} from "../lib/narratedStoryAssetLoops.mjs";
import { NARRATED_STORY_AUDIT_IDS } from "../lib/narratedStoryOutcome.mjs";
import { NARRATED_STORY_AUDIT_CONTRACT_VERSION } from "../lib/narratedStoryPipeline.mjs";
import { narratedOperatorVideoDeclaration } from "../lib/narratedStoryVisuals.mjs";
import {
  OPERATOR_VIDEO_IMPORT_VERSION,
  OPERATOR_VIDEO_MANIFEST_VERSION,
  materializeOperatorVideos,
  readOperatorVideoManifest,
} from "../lib/operatorVideoImport.mjs";
import { startAssetQualityLoop } from "../lib/assetQualityLoop.mjs";
import { normalizeVideoClipDeclaration, writeVideoClipMeasurement } from "../lib/videoClipMeasurement.mjs";
import { synthVideo } from "./fixtures/assetQualityFixtures.mjs";
import { passOperatorVideoLoops, recordAssetLoopRound } from "./fixtures/narratedAssetLoopFixture.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const SERIES = "buzzassist-narrated-story-audit";

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function tempDir(t, prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** 記録のフォルダに、合成の動画1本と記録（assetLoop なし）を書く。 */
async function operatorFolder(t, { slot = "episode-opening", route = "recorded" } = {}) {
  const folder = await tempDir(t, "narrated-video-clip-");
  await mkdir(path.join(folder, "clips"), { recursive: true });
  const clip = path.join(folder, "clips", `${slot}.mp4`);
  const bytes = await synthVideo(clip, { salt: `${slot}-${route}`, seconds: 2, rate: 24, size: "320x180" });
  const manifest = {
    version: OPERATOR_VIDEO_MANIFEST_VERSION,
    clips: [{ slot, video: { path: `clips/${slot}.mp4`, sha256: sha256(bytes) }, route, generatedAt: "2026-09-25T10:00:00+09:00" }],
  };
  const manifestPath = path.join(folder, "video-manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return { folder, clip, manifestPath, manifest, sha: sha256(bytes) };
}

function subjectsOf(read, copies = new Map()) {
  return read.clips.map((clip) => operatorVideoLoopSubject(clip.slot, {
    assetPath: copies.get(clip.slot)?.path || clip.video.full,
    sourcePath: clip.video.full,
    assetSha256: clip.video.sha256,
    assetLoopStatePath: clip.assetLoop?.full || "",
  }));
}

test("監査の id と効力: 動画の関門は監査契約 v7 から（v6 以前は求めない。読めない版は要る側に倒す）", () => {
  assert.ok(NARRATED_STORY_AUDIT_IDS.includes(NARRATED_VIDEO_CLIP_LOOP_AUDIT_ID));
  assert.equal(NARRATED_ASSET_LOOP_AUDIT_IDS.includes(NARRATED_VIDEO_CLIP_LOOP_AUDIT_ID), false, "v5 の関門の一覧には入れない（v6 以前の state の確定を変えない）");
  assert.equal(NARRATED_VIDEO_CLIP_LOOP_SINCE, `${SERIES}-v7`);
  // 今の監査契約（v8 で台本の品質ループの合格を足した）でも動画の関門は効いている。
  assert.equal(narratedVideoClipLoopsRequired(NARRATED_STORY_AUDIT_CONTRACT_VERSION), true);
  assert.equal(narratedVideoClipLoopsRequired(`${SERIES}-v6`), false);
  assert.equal(narratedVideoClipLoopsRequired(`${SERIES}-v7`), true);
  assert.equal(narratedVideoClipLoopsRequired("unreadable"), true);
});

test("枠の決まりから測定の宣言を作る（OP が音を使うなら音声は必須、人物の映像は問わない）", () => {
  const opening = narratedOperatorVideoDeclaration({ required: true, minSeconds: 1, maxSeconds: 4, aspect: 16 / 9, aspectTolerance: 0.02, requireAudio: true });
  assert.equal(normalizeVideoClipDeclaration(opening).ok, true);
  assert.deepEqual(opening.durationSeconds, { min: 1, max: 4 });
  assert.equal(opening.audio, "required");
  assert.deepEqual(opening.aspectRatio, { width: 1778, height: 1000, tolerance: 0.02 });
  const presenter = narratedOperatorVideoDeclaration({ required: false, minSeconds: 1, maxSeconds: 3600 });
  assert.equal(normalizeVideoClipDeclaration(presenter).ok, true);
  assert.equal(presenter.audio, "optional");
  assert.equal(presenter.aspectRatio, undefined);
});

test("取り込みの記録の assetLoop: 形・置き場・合格した版と取り込む動画の一致を見て、書いていない記録の指紋は変えない", async (t) => {
  const { folder, manifestPath, manifest, sha } = await operatorFolder(t);
  const plain = await readOperatorVideoManifest({ manifestPath });
  assert.deepEqual(plain.problems, []);
  assert.equal(plain.clips[0].assetLoop, null);
  // 従来の記録（assetLoop なし）の指紋は、この変更の前と同じ式のまま。
  assert.equal(plain.digest, sha256(canonicalJson({
    version: OPERATOR_VIDEO_IMPORT_VERSION,
    manifestSha256: plain.manifestSha256,
    files: [{ slot: "episode-opening", video: sha, prompt: "" }],
  })));
  const write = async (assetLoop) => {
    await writeFile(manifestPath, JSON.stringify({ ...manifest, clips: [{ ...manifest.clips[0], assetLoop }] }));
    return readOperatorVideoManifest({ manifestPath });
  };
  assert.ok((await write({ statePath: "quality/assets/video-clip--episode-opening.json" })).problems.includes("operator-video-asset-loop-record-invalid:episode-opening"));
  assert.ok((await write({ statePath: "quality/assets/video-clip--episode-opening.json", passedSha256: sha, extra: 1 })).problems.includes("operator-video-asset-loop-record-invalid:episode-opening"));
  assert.ok((await write({ statePath: "../outside.json", passedSha256: sha })).problems.includes("operator-video-asset-loop-record-invalid:episode-opening"));
  assert.ok((await write({ statePath: "quality/assets/video-clip--episode-opening.json", passedSha256: sha })).problems.includes("operator-video-asset-loop-state-missing:episode-opening"));
  const mismatch = await write({ statePath: "quality/assets/video-clip--episode-opening.json", passedSha256: "a".repeat(64) });
  assert.ok(mismatch.problems.includes("operator-video-asset-loop-pass-mismatch:episode-opening"));

  // ループを回して assetLoop を書くと、記録は通り、状態の sha256 が指紋に入る（状態が変われば作り直す）。
  await writeFile(manifestPath, JSON.stringify(manifest));
  await passOperatorVideoLoops({ folder, manifestPath });
  const passed = await readOperatorVideoManifest({ manifestPath });
  assert.deepEqual(passed.problems, []);
  assert.equal(passed.clips[0].assetLoop.passedSha256, sha);
  assert.match(passed.clips[0].assetLoop.stateSha256, /^[a-f0-9]{64}$/u);
  assert.notEqual(passed.digest, plain.digest);
  // 公開面へ出す記録には sha256 だけ。
  const runDir = await tempDir(t, "narrated-video-clip-run-");
  const materialized = await materializeOperatorVideos({ manifest: passed, outputDir: path.join(runDir, "media"), privateDir: path.join(runDir, "private") });
  assert.deepEqual(materialized.publicRecord.clips[0].assetLoop, { stateSha256: passed.clips[0].assetLoop.stateSha256, passedSha256: sha });
  assert.equal(JSON.stringify(materialized.publicRecord).includes(folder), false, "公開面の記録にパスを残さない");
});

test("関門: assetLoop が無い・ループが未合格・写しが差し替わった・置き場が違う動画は止まり、合格した写しは通る", async (t) => {
  const { folder, manifestPath } = await operatorFolder(t, { slot: "review-presenter" });
  const runDir = await tempDir(t, "narrated-video-clip-gate-");

  // 記録に assetLoop が無い。
  const bare = await readOperatorVideoManifest({ manifestPath });
  const noRecord = await gateNarratedAssetLoops({ runDir, contractVersion: NARRATED_STORY_AUDIT_CONTRACT_VERSION, videos: subjectsOf(bare) });
  assert.equal(noRecord.pass, false);
  assert.deepEqual(noRecord.issues, ["video-clip-asset-loop-not-passed:review-presenter:record-required"]);
  assert.equal(noRecord.checks[NARRATED_VIDEO_CLIP_LOOP_AUDIT_ID].pass, false);
  assert.equal(noRecord.summary.pending[0].stage, "video-clip");
  assert.equal(noRecord.summary.pending[0].assetPath, path.resolve(bare.clips[0].video.full), "ループの作業フォルダが決まる前は元の動画のパス");
  assert.match(noRecord.summary.detail, /measure-video/u);

  // ループを始めただけ（採点が無い）→ review-required。
  await startAssetQualityLoop({ workDir: folder, harnessId: "narrated-story-video", stage: "video-clip", subjectId: "review-presenter", generatorContextId: "fixture-operator-video-maker" });
  const rawManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  rawManifest.clips[0].assetLoop = { statePath: "quality/assets/video-clip--review-presenter.json", passedSha256: bare.clips[0].video.sha256 };
  await writeFile(manifestPath, JSON.stringify(rawManifest));
  const reviewing = await readOperatorVideoManifest({ manifestPath });
  assert.deepEqual(reviewing.problems, []);
  const notReviewed = await gateNarratedAssetLoops({ runDir, videos: subjectsOf(reviewing) });
  assert.deepEqual(notReviewed.issues, ["video-clip-asset-loop-not-passed:review-presenter:review-required"]);
  assert.equal(notReviewed.summary.pending[0].assetPath, "clips/review-presenter.mp4", "評価者に渡すのは記録のフォルダの中の相対パス");
  assert.equal(notReviewed.summary.pending[0].subjectId, "review-presenter");

  // 合格させる（別の文脈の評価者の採点。人物が写らない合成の動画なので人の確認は要らない）。
  const clipInFolder = path.join(folder, "clips", "review-presenter.mp4");
  const measurementRel = "quality/measure/review-presenter.json";
  await writeVideoClipMeasurement({
    assetPath: clipInFolder,
    outputPath: path.join(folder, ...measurementRel.split("/")),
    declaration: narratedOperatorVideoDeclaration({ minSeconds: 1, maxSeconds: 3600 }),
  });
  await recordAssetLoopRound({
    workDir: folder, stage: "video-clip", subjectId: "review-presenter", assetPath: clipInFolder,
    generatorContextId: "fixture-operator-video-maker", route: "recorded", charactersVisible: false,
    referenceExemptReason: "人物の写らない合成の動画", measurementPath: measurementRel,
  });
  const passedRead = await readOperatorVideoManifest({ manifestPath });
  // Job の作業フォルダへの写し（描くのはこちら）で照合する。
  const copies = (await materializeOperatorVideos({ manifest: passedRead, outputDir: path.join(runDir, "media", "operator-videos"), privateDir: path.join(runDir, "operator-videos") })).clips;
  const passed = await gateNarratedAssetLoops({ runDir, contractVersion: NARRATED_STORY_AUDIT_CONTRACT_VERSION, videos: subjectsOf(passedRead, copies) });
  assert.equal(passed.pass, true, passed.issues.join(", "));
  assert.equal(passed.checks[NARRATED_VIDEO_CLIP_LOOP_AUDIT_ID].pass, true);
  assert.deepEqual(passed.summary.counts.videoClips, { passed: 1, total: 1 });
  assert.equal(passed.plan.videos.length, 1);

  // 描く写しが差し替わった（取り込みの記録の sha256 と違う）→ 合格の照合より先に止める。
  const copyPath = copies.get("review-presenter").path;
  const original = await readFile(copyPath);
  await writeFile(copyPath, Buffer.concat([original, Buffer.from("synthetic-edit")]));
  const swapped = await gateNarratedAssetLoops({ runDir, videos: passed.plan.videos });
  assert.deepEqual(swapped.issues, ["video-clip-asset-loop-not-passed:review-presenter:sha256-mismatch"]);
  await writeFile(copyPath, original);

  // 合格した版と別の動画を、同じ状態で取り込もうとした（記録の sha256 ごと差し替えた）→ sha256-mismatch。
  const other = path.join(folder, "clips", "other.mp4");
  const otherBytes = await synthVideo(other, { salt: "other-presenter", seconds: 2 });
  const otherSubject = operatorVideoLoopSubject("review-presenter", {
    assetPath: other, assetSha256: sha256(otherBytes), assetLoopStatePath: passedRead.clips[0].assetLoop.full,
  });
  assert.deepEqual((await gateNarratedAssetLoops({ runDir, videos: [otherSubject] })).issues, ["video-clip-asset-loop-not-passed:review-presenter:sha256-mismatch"]);

  // 状態の置き場が工程の規則と違う（別の工程の状態を指している）。
  const misplaced = operatorVideoLoopSubject("review-presenter", {
    assetPath: copyPath, assetSha256: bare.clips[0].video.sha256, assetLoopStatePath: path.join(folder, "quality", "assets", "scene-image--review-presenter.json"),
  });
  assert.deepEqual((await gateNarratedAssetLoops({ runDir, videos: [misplaced] })).issues, ["video-clip-asset-loop-not-passed:review-presenter:asset-loop-state-not-this-stage"]);

  // 取り込んだ動画が無い回は、見る物が無いのが正しいので合格（本編の画・声と違い、動画は任意）。
  const none = await gateNarratedAssetLoops({ runDir, videos: [] });
  assert.equal(none.pass, true);
  assert.equal(none.checks[NARRATED_VIDEO_CLIP_LOOP_AUDIT_ID].pass, true);
  assert.equal(none.summary.counts.videoClips, undefined, "動画が無い回は数を載せない");
});

test("確定の前の再照合: v7 の plan は動画の記録が要り、v6 の plan は動画の関門を求めない", async (t) => {
  const runDir = await tempDir(t, "narrated-video-clip-reverify-");
  const v7 = await reverifyNarratedAssetLoops({ runDir, plan: { version: "buzzassist-narrated-asset-loop-gate-v1", contractVersion: `${SERIES}-v7`, scenes: [{ sceneId: "s001" }], voices: [{ segmentId: "s001" }] } });
  assert.deepEqual(v7.issues, ["asset-quality-loop-plan-missing"]);
  assert.equal(v7.checks[NARRATED_VIDEO_CLIP_LOOP_AUDIT_ID].pass, false, "v7 の plan に動画の記録が無いのは、描いた動画を合格に結び付けられない");
  const v6 = await reverifyNarratedAssetLoops({ runDir, plan: { version: "buzzassist-narrated-asset-loop-gate-v1", contractVersion: `${SERIES}-v6`, scenes: [], voices: [] } });
  assert.deepEqual(v6.issues, ["asset-quality-loop-plan-missing"]);
  assert.equal(NARRATED_VIDEO_CLIP_LOOP_AUDIT_ID in v6.checks, false, "v6 の state には当時無かった動画の監査を求めない");
  // v6 の plan（動画の記録なし）で本編の画と声の再照合に進んでも、動画の関門は走らない。
  const plan = { version: "buzzassist-narrated-asset-loop-gate-v1", contractVersion: `${SERIES}-v6`, scenes: [{ sceneId: "s001", recordProblem: "record-required" }], voices: [{ segmentId: "s001", candidates: [] }] };
  const legacy = await reverifyNarratedAssetLoops({ runDir, plan });
  assert.equal(NARRATED_VIDEO_CLIP_LOOP_AUDIT_ID in legacy.checks, false);
  assert.equal(legacy.issues.some((issue) => issue.startsWith("video-clip-")), false);
});

test("Windows の区切り: 記録のパスは \"/\" 区切りの相対だけを受け、\"\\\\\" や絶対パスは受けない", async (t) => {
  const { manifestPath, manifest, sha } = await operatorFolder(t);
  for (const statePath of ["quality\\assets\\video-clip--episode-opening.json", "C:\\work\\state.json", "/abs/state.json"]) {
    await writeFile(manifestPath, JSON.stringify({ ...manifest, clips: [{ ...manifest.clips[0], assetLoop: { statePath, passedSha256: sha } }] }));
    const read = await readOperatorVideoManifest({ manifestPath });
    assert.ok(read.problems.includes("operator-video-asset-loop-record-invalid:episode-opening"), `${statePath}: ${read.problems.join(", ")}`);
  }
  // 同じ記録をフォルダごと別の場所へ写しても（ドライブ名・区切りが変わっても）、相対パスなので読める。
  const moved = await tempDir(t, "narrated-video-clip-moved-");
  await cp(path.dirname(manifestPath), moved, { recursive: true });
  await writeFile(path.join(moved, "video-manifest.json"), JSON.stringify(manifest));
  assert.deepEqual((await readOperatorVideoManifest({ manifestPath: path.join(moved, "video-manifest.json") })).problems, []);
});
