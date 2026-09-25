#!/usr/bin/env node

// 感想パートの配置（plain / tv-left-presenter-right）を、合成の Pack・台本パッケージ・画・声・人物の映像で
// 公式経路に通し、完成 MP4 のフレームで区間ごとの配置を測る。有料 API もネットワークも使わない。

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveFfmpegToolchain } from "../lib/harnessRuntimeResolver.mjs";
import {
  REVIEWER_TRUST_PATH_ENV,
  REVIEWER_TRUST_VERSION,
  createReviewerTrustEntry,
  generateReviewerKeyPair,
} from "../lib/koyaReviewAttestation.mjs";
import {
  LAYOUT_REGION_MAX_DIFF,
  measureNarratedReviewLayout,
  normalizeNarratedReviewLayoutConfig,
  planNarratedReviewSections,
} from "../lib/narratedStoryReviewLayout.mjs";
import { runNarratedStoryVideo } from "../lib/narratedStoryVideo.mjs";
import { OPERATOR_VIDEO_MANIFEST_VERSION } from "../lib/operatorVideoImport.mjs";
import { runPastAssetLoops } from "./fixtures/narratedAssetLoopFixture.mjs";
import {
  bookendFixtureAdapters,
  bookendFixtureChannelConfig,
  createBookendFixtureMedia,
  passingVoiceQualityGate,
  writeBookendPackAssets,
} from "./fixtures/narratedBookendFixture.mjs";
import { ff } from "./fixtures/narratedVisualFixture.mjs";

const toolchain = await resolveFfmpegToolchain();
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const RENDER = { width: 320, height: 180 };

// 合成の配置（どのチャンネルの値でもない）。
const LAYOUT = {
  default: "tv-left-presenter-right",
  backgroundColor: "#203040",
  tv: { x: 0.04, y: 0.12, width: 0.56, height: 0.56, borderColor: "#000000", borderRatio: 0.02 },
  presenterFrame: { x: 0.66, y: 0.12, width: 0.3, height: 0.7, borderColor: "#ffffff", borderRatio: 0.02, emptyColor: "#606060" },
};

test("Pack の配置: 型・背景・TV 枠・人物の枠を割合で宣言し、はみ出し・重なり・知らない欄は止める", () => {
  const ok = normalizeNarratedReviewLayoutConfig(LAYOUT, { render: RENDER });
  assert.deepEqual(ok.blockers, []);
  assert.equal(ok.config.tv.width % 2, 0);
  assert.ok(ok.config.tv.borderPx >= 2);
  const { blockers } = normalizeNarratedReviewLayoutConfig({
    ...LAYOUT,
    default: "split",
    tv: { ...LAYOUT.tv, x: 0.6, glow: true },
    presenterFrame: { ...LAYOUT.presenterFrame, width: 0.5, emptyColor: "grey" },
  }, { render: RENDER });
  for (const expected of [
    "bookends.review.layout.default",
    "bookends.review.layout.tv.glow-unknown",
    "bookends.review.layout.presenterFrame.outside-frame",
    "bookends.review.layout.presenterFrame.emptyColor",
  ]) assert.ok(blockers.includes(expected), `${expected}: ${blockers.join(", ")}`);
  assert.ok(normalizeNarratedReviewLayoutConfig({ ...LAYOUT, presenterFrame: { ...LAYOUT.presenterFrame, x: 0.3 } }, { render: RENDER }).blockers.includes("bookends.review.layout.frames-overlap"));
});

test("区間: 同じ型・同じ中身の隣り合う文をまとめ、TV の中は指定の場面か本編の場面を順に使う", () => {
  const layout = normalizeNarratedReviewLayoutConfig(LAYOUT, { render: RENDER }).config;
  const segments = [
    { id: "r1", partStartFrame: 0, frames: 10, reviewLayout: "tv-left-presenter-right", tvScene: "p2" },
    { id: "r1.t2", partStartFrame: 10, frames: 6, reviewLayout: "tv-left-presenter-right", tvScene: "p2" },
    { id: "r2", partStartFrame: 16, frames: 8, reviewLayout: "plain" },
    { id: "r3", partStartFrame: 24, frames: 8 },
    { id: "r4", partStartFrame: 32, frames: 8 },
  ];
  const storyScenes = [{ sceneId: "p1", imagePath: "a.png" }, { sceneId: "p2", imagePath: "b.png" }];
  const planned = planNarratedReviewSections({ segments, layout, storyScenes });
  assert.deepEqual(planned.problems, []);
  assert.deepEqual(planned.sections.map((section) => [section.layout, section.tvScene, section.startFrame, section.frames]), [
    ["tv-left-presenter-right", "p2", 0, 16],
    ["plain", "", 16, 8],
    ["tv-left-presenter-right", "p1", 24, 8],
    ["tv-left-presenter-right", "p2", 32, 8],
  ]);
  assert.equal(planned.sections[0].tvImagePath, "b.png");
  assert.deepEqual(planNarratedReviewSections({ segments: [{ id: "r9", partStartFrame: 0, frames: 4, tvScene: "p9" }], layout, storyScenes }).problems, ["review-tv-scene-unknown:r9"]);
});

async function writeLayoutPack(payloadDir, { presenterRequired = false } = {}) {
  await mkdir(payloadDir, { recursive: true });
  await writeBookendPackAssets(payloadDir, toolchain);
  const config = bookendFixtureChannelConfig();
  config.bookends.review.presenter = { required: presenterRequired, episodeVideo: true, backgroundColor: "#101010" };
  config.bookends.review.layout = LAYOUT;
  await writeFile(join(payloadDir, "narrated-story.json"), JSON.stringify(config, null, 2), "utf8");
}

async function writePresenterManifest(folder) {
  await mkdir(join(folder, "clips"), { recursive: true });
  const clip = join(folder, "clips", "presenter.mp4");
  await ff(toolchain, ["-f", "lavfi", "-i", "testsrc=size=240x320:rate=30:duration=3", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", clip]);
  const manifestPath = join(folder, "video-manifest.json");
  await writeFile(manifestPath, JSON.stringify({
    version: OPERATOR_VIDEO_MANIFEST_VERSION,
    clips: [{
      slot: "review-presenter",
      video: { path: "clips/presenter.mp4", sha256: sha256(await readFile(clip)) },
      route: "recorded",
      generatedAt: "2026-09-25T10:00:00+09:00",
    }],
  }), "utf8");
  return { manifestPath, clip };
}

const SCRIPT = JSON.stringify({
  format: "buzzassist-narrated-script-package-v1",
  story: [
    { id: "p1", text: "最初の物語です。" },
    { id: "p2", text: "次の場面です。" },
    { id: "p3", text: "終わりの場面です。" },
  ],
  reviewMarker: "---感想---",
  review: [
    { id: "r1", text: "感想の一文目です。", tvScene: "p2" },
    { id: "r2", text: "感想の二文目です。", layout: "plain" },
    { id: "r3", text: "感想の三文目です。" },
  ],
});

async function runLayoutFixture(root, { presenter }) {
  const reviewer = generateReviewerKeyPair();
  const trustPath = join(root, "trust.json");
  await mkdir(root, { recursive: true });
  await writeFile(trustPath, JSON.stringify({ version: REVIEWER_TRUST_VERSION, reviewers: [createReviewerTrustEntry({ publicKeyPem: reviewer.publicKeyPem, label: "layout fixture" })] }));
  const fixture = await createBookendFixtureMedia(join(root, "fixture-media"), toolchain);
  const payloadDir = join(root, "pack");
  await writeLayoutPack(payloadDir);
  const scriptPath = join(root, "script-package.json");
  await writeFile(scriptPath, SCRIPT, "utf8");
  const video = presenter ? await writePresenterManifest(join(root, "operator")) : null;
  const adapters = bookendFixtureAdapters(fixture);
  const options = {
    command: "full",
    scriptPath,
    channelPackDir: payloadDir,
    jobId: `video-narrated-story-video-1ay0ut${presenter ? "p" : "e"}000000001`,
    jobIdentityDigest: "d".repeat(64),
    deploymentRoot: join(root, "run"),
    mediaJobRunner: adapters.mediaJobRunner,
    mediaJobProbe: adapters.mediaJobProbe,
    ffmpegToolchain: toolchain,
    voiceQualityGate: passingVoiceQualityGate,
    env: { ...process.env, [REVIEWER_TRUST_PATH_ENV]: trustPath },
    ...(video ? { operatorVideoManifestPath: video.manifestPath } : {}),
  };
  const outcome = await runPastAssetLoops(() => runNarratedStoryVideo(options, { allowDirectUnboundJobForTests: true }));
  return { outcome, adapters, video };
}

const EXEMPT = new Set(["perceptualReviewChecks", "perceptualReviewBoundToOutput", "perceptualEvidenceHashes", "contactSheetOriginalDetailReviewed", "qualityLoopPassed", "characterIdentityReviewed"]);

for (const presenter of [true, false]) {
  test(`感想の配置（人物の映像${presenter ? "あり" : "なし＝空の枠"}）: 区間ごとの型が完成 MP4 のフレームで測れ、別の絵を入れた版は落ちる`, {
    skip: toolchain.ok ? false : "ffmpeg/ffprobe is unavailable",
  }, async () => {
    const temp = await mkdtemp(join(os.tmpdir(), "narrated-review-layout-"));
    try {
      const { outcome, adapters, video } = await runLayoutFixture(temp, { presenter });
      assert.equal(outcome.status, "awaiting-human-review", JSON.stringify(outcome.knownRemainingIssues));
      for (const [auditId, value] of Object.entries(outcome.auditChecks)) {
        if (EXEMPT.has(auditId)) continue;
        assert.equal(value.pass, true, `${auditId}: ${value.detail} ${JSON.stringify(value.measurement?.sections?.filter((row) => !row.pass) || "")}`);
      }
      const measured = outcome.auditChecks.reviewLayoutMeasured.measurement;
      assert.deepEqual(measured.sections.map((section) => [section.layout, section.tvScene]), [
        ["tv-left-presenter-right", "p2"],
        ["plain", null],
        ["tv-left-presenter-right", "p1"],
      ]);
      // 画が要るのは本編の3場面と、人物の映像が無いときの plain の感想の文だけ（TV の文は本編の画を使う）。
      const images = adapters.calls.kinds.filter((kind) => kind === "image.generation").length;
      assert.equal(images, presenter ? 3 : 4);
      const manifest = JSON.parse(await readFile(outcome.artifacts.generationManifest.path, "utf8"));
      assert.equal(manifest.reviewLayout.sections.length, 3);
      assert.equal(manifest.reviewLayout.presenter?.source || null, presenter ? "operator-video" : null);

      // 壊した版: TV の中に別の絵が入っている、人物の枠の中身が計画と違う。
      const other = join(temp, "other.png");
      await ff(toolchain, ["-f", "lavfi", "-i", "smptebars=size=320x180:rate=1:duration=0.1", "-frames:v", "1", other]);
      const layout = normalizeNarratedReviewLayoutConfig(LAYOUT, { render: RENDER }).config;
      const reviewPart = manifest.bookends.parts.find((part) => part.id === "review");
      const sections = manifest.reviewLayout.sections.map((section) => ({ ...section, tvImagePath: other }));
      const wrongTv = await measureNarratedReviewLayout({
        ffmpeg: toolchain.ffmpeg,
        videoPath: outcome.artifacts.previewVideo.path,
        sections,
        layout,
        render: { ...RENDER, fps: 24 },
        reviewStartFrame: reviewPart.startFrame,
        presenterPath: video?.clip || "",
        presenterBackground: "#101010",
      });
      assert.equal(wrongTv.pass, false);
      assert.ok(wrongTv.problems.includes("tv-content-differs-from-story-scene"), wrongTv.problems.join(", "));
      assert.ok(wrongTv.sections[0].metrics.every((entry) => entry.tvContentDiff > LAYOUT_REGION_MAX_DIFF));
      const flipped = await measureNarratedReviewLayout({
        ffmpeg: toolchain.ffmpeg,
        videoPath: outcome.artifacts.previewVideo.path,
        sections: manifest.reviewLayout.sections.map((section, index) => ({ ...section, tvImagePath: join(outcome.artifacts.previewVideo.path, "..", "..", "media", "images", `${index === 0 ? "p2" : "p1"}.png`) })),
        layout,
        render: { ...RENDER, fps: 24 },
        reviewStartFrame: reviewPart.startFrame,
        // 人物の映像の有無を逆に申告する（人物が映っていない枠を「映っている」、映っている枠を「空」と測る）。
        presenterPath: presenter ? "" : (await writePresenterManifest(join(temp, "stray"))).clip,
        presenterBackground: "#101010",
      });
      assert.equal(flipped.pass, false);
      assert.ok(flipped.problems.some((problem) => ["empty-presenter-frame-not-empty", "presenter-video-not-in-frame", "plain-presenter-video-not-observed", "plain-section-shows-tv-layout"].includes(problem)), flipped.problems.join(", "));
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
}
