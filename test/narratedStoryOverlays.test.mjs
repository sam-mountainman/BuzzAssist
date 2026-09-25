#!/usr/bin/env node

// 固定の重ね物（Pack の overlays。lib/narratedStoryOverlays.mjs）: Pack に置いた PNG を宣言の区間・位置に重ね、
// 置き場所が字幕・感想の配置の枠・顔の範囲と重ならないことを有料生成の前に検査し、完成 MP4 の輝度で重ねたことを
// 測る。画像はどれも試験の中で FFmpeg で作る合成の図形（実在のロゴではない）。有料 API は使わない。

import assert from "node:assert/strict";
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
import { normalizeNarratedBookendsConfig } from "../lib/narratedStoryBookends.mjs";
import {
  OVERLAY_ABSENT_MAX_MATCH,
  OVERLAY_PRESENT_MIN_MATCH,
  inspectOverlayPng,
  loadNarratedOverlayConfig,
  measureNarratedOverlays,
} from "../lib/narratedStoryOverlays.mjs";
import { inspectNarratedStoryPlan } from "../lib/narratedStoryPipeline.mjs";
import { normalizeNarratedSubtitlesConfig } from "../lib/narratedStorySubtitles.mjs";
import { runNarratedStoryVideo } from "../lib/narratedStoryVideo.mjs";
import { runPastAssetLoops } from "./fixtures/narratedAssetLoopFixture.mjs";
import {
  BOOKEND_FIXTURE_SCRIPT,
  bookendFixtureAdapters,
  bookendFixtureChannelConfig,
  createBookendFixtureMedia,
  passingVoiceQualityGate,
  writeBookendPackAssets,
} from "./fixtures/narratedBookendFixture.mjs";
import { ff, findJapaneseFontFile, outlineSubtitleConfig, writeSubtitlePackFont } from "./fixtures/narratedVisualFixture.mjs";
import { acceptScriptForTests } from "./helpers/scriptQualityAcceptance.mjs";

const toolchain = await resolveFfmpegToolchain();
const fontPath = await findJapaneseFontFile();
const RENDER = { width: 640, height: 360, fps: 24 };
const EXEMPT = new Set(["perceptualReviewChecks", "perceptualReviewBoundToOutput", "perceptualEvidenceHashes", "contactSheetOriginalDetailReviewed", "qualityLoopPassed", "characterIdentityReviewed"]);

/** 合成の重ね物の画像: 不透明な色の板に白い帯、外周は半透明の縁。 */
async function writeOverlayImage(path, { color = "0x1e5aa0", opacity = 1 } = {}) {
  await ff(toolchain, [
    "-f", "lavfi", "-i", `color=c=${color}@${opacity}:s=96x40,format=rgba`,
    "-vf", "drawbox=x=8:y=10:w=80:h=20:color=white@1:t=fill,pad=100:44:2:2:color=black@0.5",
    "-frames:v", "1", path,
  ]);
}

// 合成の置き場所（どのチャンネルの値でもない）。
const FACES = { story: [{ x: 0.25, y: 0.1, width: 0.5, height: 0.6 }], review: [{ x: 0.3, y: 0.1, width: 0.4, height: 0.6 }] };

test("PNG を読む: 寸法と不透明な画素の数（alpha の無い PNG は全部が不透明）", { skip: toolchain.ok ? false : "ffmpeg is unavailable" }, async () => {
  const dir = await mkdtemp(join(os.tmpdir(), "narrated-overlay-png-"));
  try {
    const rgba = join(dir, "rgba.png");
    await writeOverlayImage(rgba);
    const inspected = inspectOverlayPng(await readFile(rgba));
    assert.equal(inspected.width, 100);
    assert.equal(inspected.height, 44);
    assert.equal(inspected.opaquePixels, 96 * 40, "外周 2px の半透明の縁は数えない");
    const rgb = join(dir, "rgb.png");
    await ff(toolchain, ["-f", "lavfi", "-i", "color=c=red:s=30x20", "-frames:v", "1", "-pix_fmt", "rgb24", rgb]);
    assert.equal(inspectOverlayPng(await readFile(rgb)).opaquePixels, 600);
    const clear = join(dir, "clear.png");
    await writeOverlayImage(clear, { opacity: 0.4 });
    assert.ok(inspectOverlayPng(await readFile(clear)).opaquePixels < 96 * 40);
    assert.deepEqual(inspectOverlayPng(Buffer.from("not a png")), { problem: "image-not-png" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("置き場所の宣言: 字幕・TV 枠・人物の枠・顔の範囲と重なる、顔の範囲の宣言が無い、画面の外、不透明な画素が無い、は有料生成の前に止める", { skip: toolchain.ok ? false : "ffmpeg is unavailable" }, async () => {
  const dir = await mkdtemp(join(os.tmpdir(), "narrated-overlay-config-"));
  try {
    await mkdir(join(dir, "overlays"), { recursive: true });
    await writeOverlayImage(join(dir, "overlays", "notice.png"));
    await writeOverlayImage(join(dir, "overlays", "faint.png"), { opacity: 0.3 });
    await ff(toolchain, ["-f", "lavfi", "-i", "color=c=black@0.0:s=40x40,format=rgba", "-frames:v", "1", join(dir, "overlays", "clear.png")]);
    const subtitles = normalizeNarratedSubtitlesConfig(outlineSubtitleConfig("fonts/subtitle.ttf"), { render: RENDER }).config;
    const base = bookendFixtureChannelConfig();
    base.bookends.review.layout = {
      default: "tv-left-presenter-right",
      backgroundColor: "#203040",
      tv: { x: 0.04, y: 0.12, width: 0.56, height: 0.56, borderColor: "#000000", borderRatio: 0.02 },
      presenterFrame: { x: 0.66, y: 0.12, width: 0.3, height: 0.7, borderColor: "#ffffff", borderRatio: 0.02, emptyColor: "#606060" },
    };
    const bookends = normalizeNarratedBookendsConfig(base.bookends, { render: RENDER }).config;
    const load = (overlays) => loadNarratedOverlayConfig(overlays, { render: RENDER, channelPackDir: dir, subtitles, bookends });
    const item = (overrides = {}) => ({ id: "notice", image: "overlays/notice.png", part: "story", x: 0.02, y: 0.02, width: 0.2, ...overrides });
    const ok = await load({ items: [item()], faceRegions: FACES });
    assert.deepEqual(ok.blockers, []);
    assert.deepEqual(ok.config.items[0].box, { x: 12, y: 8, width: 128, height: 56 });
    const cases = [
      [{ items: [item({ y: 0.8 })], faceRegions: FACES }, "overlays.items.notice.overlaps-subtitles"],
      [{ items: [item({ x: 0.4, y: 0.2 })], faceRegions: FACES }, "overlays.items.notice.overlaps-face-region"],
      [{ items: [item()] }, "overlays.items.notice.face-regions-undeclared:story"],
      [{ items: [item({ part: "review", x: 0.1, y: 0.2 })], faceRegions: FACES }, "overlays.items.notice.overlaps-tv-frame"],
      [{ items: [item({ part: "review", x: 0.7, y: 0.3 })], faceRegions: FACES }, "overlays.items.notice.overlaps-presenter-frame"],
      [{ items: [item({ x: 0.9 })], faceRegions: FACES }, "overlays.items.notice.outside-frame"],
      [{ items: [item({ image: "overlays/clear.png" })], faceRegions: FACES }, "overlays.items.notice.image-needs-opaque-pixels"],
      [{ items: [item({ image: "overlays/missing.png" })], faceRegions: FACES }, "overlays.items.notice.image-missing"],
      [{ items: [item({ image: "../escape.png" })], faceRegions: FACES }, "overlays.items.notice.image-invalid-pack-path"],
      [{ items: [item({ part: "opening" })], faceRegions: FACES }, "overlays.items.notice.part"],
      [{ items: [item({ blink: true })], faceRegions: FACES }, "overlays.items[0].blink-unknown"],
      [{ items: [item({ startSeconds: 5, endSeconds: 2 })], faceRegions: FACES }, "overlays.items.notice.endSeconds"],
      [{ items: [] }, "overlays.items"],
    ];
    for (const [overlays, expected] of cases) {
      const { blockers } = await load(overlays);
      assert.ok(blockers.includes(expected), `${expected}: ${blockers.join(", ")}`);
    }
    // 感想パートの無い番組に感想パートの重ね物は置けない。
    const noReview = await loadNarratedOverlayConfig({ items: [item({ part: "review", x: 0.02 })], faceRegions: FACES }, { render: RENDER, channelPackDir: dir, subtitles, bookends: { enabled: false } });
    assert.ok(noReview.blockers.includes("overlays.items.notice.part-review-without-bookends-review"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("公式経路: 本編と感想パートに重ね物を宣言した番組は、宣言の区間・位置に重なり、字幕・カメラ・境目・配置の監査も通る。位置・区間・画像を変えた宣言で測ると落ちる", {
  skip: toolchain.ok ? false : "ffmpeg/ffprobe is unavailable",
}, async (t) => {
  assert.ok(fontPath, "日本語の書体が見つからない（Linux は fonts-noto-cjk、Windows は日本語の補助フォント）");
  const temp = await mkdtemp(join(os.tmpdir(), "narrated-overlay-pipeline-"));
  try {
    const reviewer = generateReviewerKeyPair();
    const trustPath = join(temp, "trust.json");
    await writeFile(trustPath, JSON.stringify({ version: REVIEWER_TRUST_VERSION, reviewers: [createReviewerTrustEntry({ publicKeyPem: reviewer.publicKeyPem, label: "overlay fixture" })] }));
    const fixture = await createBookendFixtureMedia(join(temp, "fixture-media"), toolchain);
    const payloadDir = join(temp, "pack");
    await mkdir(join(payloadDir, "overlays"), { recursive: true });
    await writeBookendPackAssets(payloadDir, toolchain);
    await writeOverlayImage(join(payloadDir, "overlays", "notice.png"));
    await writeOverlayImage(join(payloadDir, "overlays", "badge.png"), { color: "0xc04020" });
    const fontFile = await writeSubtitlePackFont(payloadDir, fontPath);
    const config = {
      ...bookendFixtureChannelConfig(),
      render: RENDER,
      subtitles: outlineSubtitleConfig(fontFile),
      overlays: {
        items: [
          // 本編の途中だけ（区間の前後に「出ていない」フレームがある）と、感想パート全体。
          { id: "notice", image: "overlays/notice.png", part: "story", startSeconds: 0.25, endSeconds: 1.5, x: 0.02, y: 0.02, width: 0.2 },
          { id: "badge", image: "overlays/badge.png", part: "review", x: 0.78, y: 0.02, width: 0.18 },
        ],
        faceRegions: FACES,
      },
    };
    await writeFile(join(payloadDir, "narrated-story.json"), JSON.stringify(config, null, 2), "utf8");
    const scriptPath = join(temp, "script.txt");
    await writeFile(scriptPath, `${BOOKEND_FIXTURE_SCRIPT}\n`, "utf8");
    await acceptScriptForTests(scriptPath);
    const adapters = bookendFixtureAdapters(fixture);
    const outcome = await runPastAssetLoops(() => runNarratedStoryVideo({
      command: "full",
      scriptPath,
      channelPackDir: payloadDir,
      jobId: "video-narrated-story-video-0ver1ay000000001",
      jobIdentityDigest: "b".repeat(64),
      deploymentRoot: join(temp, "run"),
      mediaJobRunner: adapters.mediaJobRunner,
      mediaJobProbe: adapters.mediaJobProbe,
      ffmpegToolchain: toolchain,
      voiceQualityGate: passingVoiceQualityGate,
      env: { ...process.env, [REVIEWER_TRUST_PATH_ENV]: trustPath },
    }, { allowDirectUnboundJobForTests: true }));
    assert.equal(outcome.status, "awaiting-human-review", JSON.stringify(outcome.knownRemainingIssues));
    for (const [auditId, value] of Object.entries(outcome.auditChecks)) {
      if (EXEMPT.has(auditId)) continue;
      assert.equal(value.pass, true, `${auditId}: ${value.detail} ${JSON.stringify(value.measurement?.items?.filter((row) => !row.pass) || "")}`);
    }
    const measured = outcome.auditChecks.fixedOverlaysMeasured.measurement;
    t.diagnostic(`基準版: ${JSON.stringify(measured.items.map((row) => row.samples))}`);
    assert.equal(measured.itemCount, 2);
    const notice = measured.items.find((row) => row.id === "notice");
    assert.ok(notice.samples.filter((sample) => sample.expected === "absent").length === 2, "区間の前後の両方で出ていないことを測った");
    const manifest = JSON.parse(await readFile(outcome.artifacts.generationManifest.path, "utf8"));
    assert.deepEqual(manifest.overlays.items.map((item) => [item.id, item.part]), [["notice", "story"], ["badge", "review"]]);
    const storyPart = manifest.bookends.parts.find((part) => part.id === "story");
    assert.equal(manifest.overlays.items[0].startFrame, storyPart.startFrame + 6);
    assert.equal(manifest.overlays.items[0].endFrame, storyPart.startFrame + 36);

    // 壊した版: 同じ MP4 を、位置をずらした・区間をずらした・別の画像の宣言で測る。
    const loaded = await loadNarratedOverlayConfig(config.overlays, {
      render: RENDER,
      channelPackDir: payloadDir,
      subtitles: normalizeNarratedSubtitlesConfig(config.subtitles, { render: RENDER }).config,
      bookends: normalizeNarratedBookendsConfig(config.bookends, { render: RENDER }).config,
    });
    const layer = (change) => ({
      totalFrames: manifest.bookends.totalFrames,
      items: loaded.config.items.map((item, index) => ({ ...item, ...manifest.overlays.items[index], imagePath: item.imagePath, ...change(item) })),
    });
    const measure = (change) => measureNarratedOverlays({ ffmpeg: toolchain.ffmpeg, videoPath: outcome.artifacts.previewVideo.path, layer: layer(change), fps: RENDER.fps });
    const moved = await measure((item) => ({ box: { ...manifest.overlays.items.find((entry) => entry.id === item.id).box, x: 200 } }));
    t.diagnostic(`位置をずらした版: ${JSON.stringify(moved.items.map((row) => row.samples))}`);
    assert.equal(moved.pass, false);
    assert.ok(moved.problems.includes("overlay-not-observed-in-range"));
    const shifted = await measure((item) => {
      const entry = manifest.overlays.items.find((candidate) => candidate.id === item.id);
      return item.id === "notice" ? { startFrame: entry.startFrame + 6, endFrame: entry.endFrame + 6 } : {};
    });
    t.diagnostic(`区間をずらした版: ${JSON.stringify(shifted.items.map((row) => row.samples))}`);
    assert.equal(shifted.pass, false);
    assert.ok(shifted.problems.some((problem) => ["overlay-observed-outside-range", "overlay-not-observed-in-range"].includes(problem)), shifted.problems.join(", "));
    const other = join(temp, "other.png");
    await writeOverlayImage(other, { color: "0x30c040" });
    const swapped = await measure(() => ({ imagePath: other }));
    t.diagnostic(`別の画像の版: ${JSON.stringify(swapped.items.map((row) => row.samples))}`);
    assert.equal(swapped.pass, false);
    for (const row of measured.items) {
      for (const sample of row.samples) {
        if (sample.expected === "present") assert.ok(sample.match >= OVERLAY_PRESENT_MIN_MATCH);
        else assert.ok(sample.match <= OVERLAY_ABSENT_MAX_MATCH);
      }
    }

    // 不正な置き場所は plan-only でも止まり、durable Job へ持ち込む形の検査は知らない欄を止める。
    await writeFile(join(payloadDir, "narrated-story.json"), JSON.stringify({ ...config, overlays: { ...config.overlays, items: [{ ...config.overlays.items[0], y: 0.8 }] } }), "utf8");
    const plan = await inspectNarratedStoryPlan({ scriptPath, channelPackDir: payloadDir });
    assert.ok(plan.blockers.includes("channel-pack-config-required:overlays.items.notice.overlaps-subtitles"), plan.blockers.join(", "));
    await writeFile(join(payloadDir, "narrated-story.json"), JSON.stringify({ ...config, overlays: { ...config.overlays, items: [{ ...config.overlays.items[0], glow: 1 }] } }), "utf8");
    await assert.rejects(extractNarratedChannelPackRuntime({ payloadDir, evidence: { harnessId: "narrated-story-video", payloadSha256: "d".repeat(64) } }), /overlays\.items\[0\] contains unsupported fields: glow/u);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
