#!/usr/bin/env node

// 感想パートの TV 枠の中身（Pack の bookends.review.layout.tv.content）: 本編の場面の画を本編のカメラの型で
// 動かした映像（scene-motion）か、運営者が渡した短い動画（operator-video、取り込みの枠 review-tv）を、公式経路で
// 実際に描いて完成 MP4 のフレームで測る。合成の Pack・台本パッケージ・画・声・動画で、有料 API は使わない。

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { extractNarratedChannelPackRuntime } from "../lib/harnessChannelPackRuntime.mjs";
import { resolveFfmpegToolchain } from "../lib/harnessRuntimeResolver.mjs";
import {
  REVIEWER_TRUST_PATH_ENV,
  REVIEWER_TRUST_VERSION,
  createReviewerTrustEntry,
  generateReviewerKeyPair,
} from "../lib/koyaReviewAttestation.mjs";
import { inspectNarratedStoryPlan } from "../lib/narratedStoryPipeline.mjs";
import {
  TV_MOTION_MIN_EXPECTED_CHANGE,
  measureNarratedReviewLayout,
  normalizeNarratedReviewLayoutConfig,
  planNarratedReviewSections,
} from "../lib/narratedStoryReviewLayout.mjs";
import { runNarratedStoryVideo } from "../lib/narratedStoryVideo.mjs";
import { OPERATOR_VIDEO_MANIFEST_VERSION } from "../lib/operatorVideoImport.mjs";
import { passOperatorVideoLoops, runPastAssetLoops } from "./fixtures/narratedAssetLoopFixture.mjs";
import {
  bookendFixtureAdapters,
  bookendFixtureChannelConfig,
  createBookendFixtureMedia,
  passingVoiceQualityGate,
  writeBookendPackAssets,
} from "./fixtures/narratedBookendFixture.mjs";
import { ff, makeTexturedStill } from "./fixtures/narratedVisualFixture.mjs";
import { acceptScriptForTests } from "./helpers/scriptQualityAcceptance.mjs";

const toolchain = await resolveFfmpegToolchain();
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const RENDER = { width: 320, height: 180, fps: 24 };
const EXEMPT = new Set(["perceptualReviewChecks", "perceptualReviewBoundToOutput", "perceptualEvidenceHashes", "contactSheetOriginalDetailReviewed", "qualityLoopPassed", "characterIdentityReviewed"]);
// 合成の配置とカメラ（どのチャンネルの値でもない）。
const layoutWith = (content) => ({
  default: "tv-left-presenter-right",
  backgroundColor: "#203040",
  tv: { x: 0.04, y: 0.12, width: 0.56, height: 0.56, borderColor: "#000000", borderRatio: 0.02, ...(content ? { content } : {}) },
  presenterFrame: { x: 0.66, y: 0.12, width: 0.3, height: 0.7, borderColor: "#ffffff", borderRatio: 0.02, emptyColor: "#606060" },
});
const CAMERA_PACK = {
  moves: { "slow-push-in": { zoomPerSecond: 0.03, maxZoom: 1.15 }, "pan-left": { panPerSecond: 0.05, zoom: 1.12 } },
  sequence: ["slow-push-in", "pan-left"],
};

test("TV の中身の宣言: 省略は still、知らない種類・知らない欄は止める。operator-video の TV は場面を使わない", () => {
  assert.equal(normalizeNarratedReviewLayoutConfig(layoutWith(""), { render: RENDER }).config.tv.content, "still");
  assert.equal(normalizeNarratedReviewLayoutConfig(layoutWith("scene-motion"), { render: RENDER }).config.tv.content, "scene-motion");
  assert.ok(normalizeNarratedReviewLayoutConfig(layoutWith("slideshow"), { render: RENDER }).blockers.includes("bookends.review.layout.tv.content"));
  const operator = normalizeNarratedReviewLayoutConfig(layoutWith("operator-video"), { render: RENDER }).config;
  const planned = planNarratedReviewSections({
    segments: [
      { id: "r1", partStartFrame: 0, frames: 10, tvScene: "p2" },
      { id: "r2", partStartFrame: 10, frames: 10 },
      { id: "r3", partStartFrame: 20, frames: 10, reviewLayout: "plain" },
    ],
    layout: operator,
    storyScenes: [],
  });
  assert.deepEqual(planned.problems, [], "場面が無くても operator-video の TV は描ける");
  assert.deepEqual(planned.sections.map((section) => [section.layout, section.tvScene, section.frames]), [["tv-left-presenter-right", "", 20], ["plain", "", 10]]);
});

/** 場面ごとに模様の違う画を返す fixture の adapter（台本の場面の番号で3枚を回す）。 */
function distinctSceneAdapters(fixture, images) {
  const base = bookendFixtureAdapters(fixture);
  return {
    ...base,
    mediaJobRunner: async (spec) => {
      const result = await base.mediaJobRunner(spec);
      if (spec.kind !== "image.generation") return result;
      const bytes = images[Number(String(spec.input?.segmentId || "").replace(/\D/gu, "") || 0) % images.length];
      return { ...result, bytes, receipt: { ...result.receipt, artifact: { ...result.receipt.artifact, sha256: sha256(bytes), bytes: bytes.length } } };
    },
  };
}

async function writeTvVideoManifest(folder, source = "testsrc2") {
  await mkdir(join(folder, "clips"), { recursive: true });
  const clip = join(folder, "clips", `tv-${source}.mp4`);
  await ff(toolchain, ["-f", "lavfi", "-i", `${source}=size=320x180:rate=30:duration=2`, "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", clip]);
  const manifestPath = join(folder, "video-manifest.json");
  await writeFile(manifestPath, JSON.stringify({
    version: OPERATOR_VIDEO_MANIFEST_VERSION,
    clips: [{ slot: "review-tv", video: { path: `clips/tv-${source}.mp4`, sha256: sha256(await readFile(clip)) }, route: "recorded", generatedAt: "2026-09-25T10:00:00+09:00" }],
  }), "utf8");
  return { manifestPath, clip };
}

async function runTvFixture(root, { content, review }) {
  await mkdir(root, { recursive: true });
  const reviewer = generateReviewerKeyPair();
  const trustPath = join(root, "trust.json");
  await writeFile(trustPath, JSON.stringify({ version: REVIEWER_TRUST_VERSION, reviewers: [createReviewerTrustEntry({ publicKeyPem: reviewer.publicKeyPem, label: "tv content fixture" })] }));
  const fixture = await createBookendFixtureMedia(join(root, "fixture-media"), toolchain);
  const images = [];
  for (let index = 0; index < 3; index += 1) {
    const still = join(root, `distinct-${index}.png`);
    await makeTexturedStill(toolchain, still, { width: 320, height: 180, phase: index * 23 });
    images.push(await readFile(still));
  }
  const payloadDir = join(root, "pack");
  await mkdir(payloadDir, { recursive: true });
  await writeBookendPackAssets(payloadDir, toolchain);
  const config = bookendFixtureChannelConfig();
  config.camera = CAMERA_PACK;
  config.bookends.review.presenter = { required: false, backgroundColor: "#101010" };
  config.bookends.review.layout = layoutWith(content);
  await writeFile(join(payloadDir, "narrated-story.json"), JSON.stringify(config, null, 2), "utf8");
  const scriptPath = join(root, "script-package.json");
  await writeFile(scriptPath, JSON.stringify({
    format: "buzzassist-narrated-script-package-v1",
    story: [
      { id: "p1", text: "最初の物語です。" },
      { id: "p2", text: "次の場面です。" },
      { id: "p3", text: "終わりの場面です。" },
    ],
    reviewMarker: "---感想---",
    review,
  }), "utf8");
  await acceptScriptForTests(scriptPath);
  const video = content === "operator-video" ? await writeTvVideoManifest(join(root, "operator")) : null;
  if (video) await passOperatorVideoLoops({ folder: join(root, "operator"), manifestPath: video.manifestPath });
  const adapters = distinctSceneAdapters(fixture, images);
  const options = {
    command: "full",
    scriptPath,
    channelPackDir: payloadDir,
    jobId: `video-narrated-story-video-7vc0ntent${content === "operator-video" ? "o" : "m"}000001`,
    jobIdentityDigest: "a".repeat(64),
    deploymentRoot: join(root, "run"),
    mediaJobRunner: adapters.mediaJobRunner,
    mediaJobProbe: adapters.mediaJobProbe,
    ffmpegToolchain: toolchain,
    voiceQualityGate: passingVoiceQualityGate,
    env: { ...process.env, [REVIEWER_TRUST_PATH_ENV]: trustPath },
    ...(video ? { operatorVideoManifestPath: video.manifestPath } : {}),
  };
  const outcome = await runPastAssetLoops(() => runNarratedStoryVideo(options, { allowDirectUnboundJobForTests: true }));
  return { outcome, video, payloadDir, scriptPath };
}

function assertAutomaticAuditsPass(outcome) {
  for (const [auditId, value] of Object.entries(outcome.auditChecks)) {
    if (EXEMPT.has(auditId)) continue;
    assert.equal(value.pass, true, `${auditId}: ${value.detail} ${JSON.stringify(value.measurement?.sections?.filter((row) => !row.pass) || "")}`);
  }
}

test("TV の中身 scene-motion: 本編でその場面に当てたカメラの型で、TV の中の場面が区間の長さで動き、完成 MP4 で測れる。止めた・逆へ動かした計画で測ると落ちる", {
  skip: toolchain.ok ? false : "ffmpeg/ffprobe is unavailable",
}, async (t) => {
  const temp = await mkdtemp(join(os.tmpdir(), "narrated-tv-scene-motion-"));
  try {
    const { outcome } = await runTvFixture(temp, {
      content: "scene-motion",
      review: [
        { id: "r1", text: "感想の一文目です。", tvScene: "p2" },
        { id: "r2", text: "感想の二文目です。", tvScene: "p2" },
        { id: "r3", text: "感想の三文目です。", layout: "plain" },
      ],
    });
    assert.equal(outcome.status, "awaiting-human-review", JSON.stringify(outcome.knownRemainingIssues));
    assertAutomaticAuditsPass(outcome);
    const measured = outcome.auditChecks.reviewLayoutMeasured.measurement;
    const tvRows = measured.sections.filter((section) => section.layout === "tv-left-presenter-right");
    t.diagnostic(`scene-motion: ${JSON.stringify(tvRows.map((row) => ({ tvMotion: row.tvMotion, metrics: row.metrics.map((entry) => entry.tvContentDiff) })))}`);
    assert.equal(tvRows.length, 1);
    assert.equal(tvRows[0].tvContent, "scene-motion");
    assert.ok(tvRows[0].tvMotion.expectedChange >= TV_MOTION_MIN_EXPECTED_CHANGE, `動きを測れる大きさ: ${JSON.stringify(tvRows[0].tvMotion)}`);
    const manifest = JSON.parse(await readFile(outcome.artifacts.generationManifest.path, "utf8"));
    assert.equal(manifest.reviewLayout.tvContent, "scene-motion");
    const tvSection = manifest.reviewLayout.sections.find((section) => section.layout === "tv-left-presenter-right");
    assert.equal(tvSection.tvMotion.move, "pan-left", "p2 の本編の型（sequence の2番目）");

    const layout = normalizeNarratedReviewLayoutConfig(layoutWith("scene-motion"), { render: RENDER }).config;
    const reviewPart = manifest.bookends.parts.find((part) => part.id === "review");
    const images = join(outcome.artifacts.previewVideo.path, "..", "..", "media", "images");
    const sections = manifest.reviewLayout.sections.map((section) => ({ ...section, tvImagePath: section.tvScene ? join(images, `${section.tvScene}.png`) : "", tvMotion: section.tvMotion ? { ...section.tvMotion, frames: section.frames, easing: { kind: "linear", linearShare: 1 } } : undefined }));
    const measure = (overrides, layoutOverride = layout) => measureNarratedReviewLayout({
      ffmpeg: toolchain.ffmpeg,
      videoPath: outcome.artifacts.previewVideo.path,
      sections: sections.map((section) => (section.tvMotion ? { ...section, ...overrides(section) } : section)),
      layout: layoutOverride,
      render: { ...RENDER, fps: 24 },
      reviewStartFrame: reviewPart.startFrame,
    });
    // 同じ計画で測り直すと通る（manifest の記録だけから測れる）。
    assert.equal((await measure(() => ({}))).pass, true);
    // 壊した版 1: 止まった画（still）と比べる。
    const still = await measure(() => ({}), { ...layout, tv: { ...layout.tv, content: "still" } });
    t.diagnostic(`still と比べた版: ${JSON.stringify(still.sections.map((row) => row.metrics.map((entry) => entry.tvContentDiff)))}`);
    assert.equal(still.pass, false);
    assert.ok(still.problems.includes("tv-content-differs-from-story-scene"), still.problems.join(", "));
    // 壊した版 2: 逆へ動く計画と比べる。
    const reversed = await measure((section) => ({ tvMotion: { ...section.tvMotion, from: section.tvMotion.to, to: section.tvMotion.from } }));
    assert.equal(reversed.pass, false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("TV の中身 operator-video: 運営者の動画を取り込みの記録と品質ループつきで TV 枠へ流し、完成 MP4 で測れる。別の動画と比べると落ち、記録が無ければ有料生成の前に止まる", {
  skip: toolchain.ok ? false : "ffmpeg/ffprobe is unavailable",
}, async (t) => {
  const temp = await mkdtemp(join(os.tmpdir(), "narrated-tv-operator-video-"));
  try {
    const { outcome, video, payloadDir, scriptPath } = await runTvFixture(temp, {
      content: "operator-video",
      review: [
        { id: "r1", text: "感想の一文目です。" },
        { id: "r2", text: "感想の二文目です。" },
        { id: "r3", text: "感想の三文目です。", layout: "plain" },
      ],
    });
    assert.equal(outcome.status, "awaiting-human-review", JSON.stringify(outcome.knownRemainingIssues));
    assertAutomaticAuditsPass(outcome);
    const measured = outcome.auditChecks.reviewLayoutMeasured.measurement;
    const tvRows = measured.sections.filter((section) => section.layout === "tv-left-presenter-right");
    t.diagnostic(`operator-video: ${JSON.stringify(tvRows.map((row) => ({ tvMotion: row.tvMotion, metrics: row.metrics.map((entry) => entry.tvContentDiff) })))}`);
    assert.equal(tvRows[0].tvContent, "operator-video");
    assert.equal(tvRows[0].tvScene, null);
    assert.ok(tvRows[0].tvMotion.expectedChange >= TV_MOTION_MIN_EXPECTED_CHANGE);
    const manifest = JSON.parse(await readFile(outcome.artifacts.generationManifest.path, "utf8"));
    assert.equal(manifest.reviewLayout.tvVideo.sha256, sha256(await readFile(video.clip)));
    assert.ok(manifest.operatorVideos.clips.some((clip) => clip.slot === "review-tv"));

    const layout = normalizeNarratedReviewLayoutConfig(layoutWith("operator-video"), { render: RENDER }).config;
    const reviewPart = manifest.bookends.parts.find((part) => part.id === "review");
    const other = await writeTvVideoManifest(join(temp, "other"), "testsrc");
    const wrong = await measureNarratedReviewLayout({
      ffmpeg: toolchain.ffmpeg,
      videoPath: outcome.artifacts.previewVideo.path,
      sections: manifest.reviewLayout.sections,
      layout,
      render: { ...RENDER, fps: 24 },
      reviewStartFrame: reviewPart.startFrame,
      tvVideoPath: other.clip,
    });
    assert.equal(wrong.pass, false);
    assert.ok(wrong.problems.includes("tv-content-differs-from-story-scene"), wrong.problems.join(", "));

    // 記録を渡さなければ、plan-only でも有料生成の前に止まる。durable Job へ持ち込む形の検査は content を受け、知らない欄を止める。
    const plan = await inspectNarratedStoryPlan({ scriptPath, channelPackDir: payloadDir });
    assert.ok(plan.blockers.includes("operator-video-manifest-required"), plan.blockers.join(", "));
    const evidence = { harnessId: "narrated-story-video", payloadSha256: "d".repeat(64) };
    await extractNarratedChannelPackRuntime({ payloadDir, evidence });
    const source = JSON.parse(await readFile(join(payloadDir, "narrated-story.json"), "utf8"));
    source.bookends.review.layout.tv.loop = true;
    await writeFile(join(payloadDir, "narrated-story.json"), JSON.stringify(source));
    await assert.rejects(extractNarratedChannelPackRuntime({ payloadDir, evidence }), /layout\.tv contains unsupported fields: loop/u);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
