#!/usr/bin/env node

// ナレーション物語の公式経路（lib/narratedStoryVideo.mjs → lib/narratedStoryPipeline.mjs）で、見た目の機能
// （焼き込み字幕・カメラ・感想の配置・回ごとの OP）を合成の Pack・台本・画・声で実際に描き、完成 MP4 を
// 測る監査が通ること、壊した入力で止まることを確かめる。有料 API もネットワークも使わない。

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveFfmpegToolchain } from "../lib/harnessRuntimeResolver.mjs";
import {
  KOYA_REVIEWER_TRUST_JSON_ENV,
  KOYA_REVIEWER_TRUST_PATH_ENV,
  REVIEWER_TRUST_JSON_ENV,
  REVIEWER_TRUST_PATH_ENV,
  REVIEWER_TRUST_VERSION,
  createReviewerTrustEntry,
  generateReviewerKeyPair,
} from "../lib/koyaReviewAttestation.mjs";
import { extractNarratedChannelPackRuntime } from "../lib/harnessChannelPackRuntime.mjs";
import { inspectNarratedStoryPlan } from "../lib/narratedStoryPipeline.mjs";
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
import { bandSubtitleConfig, findJapaneseFontFile, outlineSubtitleConfig, writeSubtitlePackFont } from "./fixtures/narratedVisualFixture.mjs";
import { acceptScriptForTests } from "./helpers/scriptQualityAcceptance.mjs";

const toolchain = await resolveFfmpegToolchain();
const fontPath = await findJapaneseFontFile();
const TRUST_ENV_NAMES = [REVIEWER_TRUST_PATH_ENV, REVIEWER_TRUST_JSON_ENV, KOYA_REVIEWER_TRUST_PATH_ENV, KOYA_REVIEWER_TRUST_JSON_ENV];
const IDENTITY = "c".repeat(64);
let jobCounter = 0;

function cleanTrustEnv(overrides = {}) {
  const env = { ...process.env };
  for (const name of TRUST_ENV_NAMES) delete env[name];
  return { ...env, ...overrides };
}

async function trustEnv(dir) {
  const reviewer = generateReviewerKeyPair();
  const trustPath = join(dir, "operator-reviewer-trust.json");
  await writeFile(trustPath, JSON.stringify({
    version: REVIEWER_TRUST_VERSION,
    reviewers: [createReviewerTrustEntry({ publicKeyPem: reviewer.publicKeyPem, label: "visual fixture reviewer" })],
  }), "utf8");
  return cleanTrustEnv({ [REVIEWER_TRUST_PATH_ENV]: trustPath });
}

/** bookend の fixture の Pack に、見た目の宣言を足して書く（render は字幕を測れる 640x360）。 */
async function writeVisualPack(payloadDir, extend) {
  await mkdir(payloadDir, { recursive: true });
  await writeBookendPackAssets(payloadDir, toolchain);
  const fontFile = await writeSubtitlePackFont(payloadDir, fontPath);
  const config = { ...bookendFixtureChannelConfig(), render: { width: 640, height: 360, fps: 24 } };
  await writeFile(join(payloadDir, "narrated-story.json"), `${JSON.stringify(extend(config, { fontFile }), null, 2)}\n`, "utf8");
}

async function runVisualFixture({ root, env, fixture, extend, script = BOOKEND_FIXTURE_SCRIPT, extraOptions = {} }) {
  const payloadDir = join(root, "pack");
  await writeVisualPack(payloadDir, extend);
  const scriptPath = join(root, "script.txt");
  await writeFile(scriptPath, `${script}\n`, "utf8");
  // 台本の関門（監査契約 v8 から）はこの試験の対象外。台本を人がそのまま使うと認めた記録を置く。
  await acceptScriptForTests(scriptPath);
  const adapters = bookendFixtureAdapters(fixture);
  jobCounter += 1;
  const options = {
    command: "full",
    scriptPath,
    channelPackDir: payloadDir,
    jobId: `video-narrated-story-video-${String(jobCounter).padStart(4, "0")}visual00000000`,
    jobIdentityDigest: IDENTITY,
    deploymentRoot: root,
    mediaJobRunner: adapters.mediaJobRunner,
    mediaJobProbe: adapters.mediaJobProbe,
    ffmpegToolchain: toolchain,
    voiceQualityGate: passingVoiceQualityGate,
    env,
    ...extraOptions,
  };
  const outcome = await runPastAssetLoops(() => runNarratedStoryVideo(options, { allowDirectUnboundJobForTests: true }));
  return { outcome, adapters, payloadDir, scriptPath };
}

const AUTOMATIC_EXEMPT = new Set(["perceptualReviewChecks", "perceptualReviewBoundToOutput", "perceptualEvidenceHashes", "contactSheetOriginalDetailReviewed", "qualityLoopPassed", "characterIdentityReviewed"]);

function assertAutomaticAuditsPass(outcome) {
  for (const [auditId, value] of Object.entries(outcome.auditChecks || {})) {
    if (AUTOMATIC_EXEMPT.has(auditId)) continue;
    const failedRows = [...(value.measurement?.cues || []), ...(value.measurement?.shots || [])].filter((row) => row.pass === false);
    assert.equal(value.pass, true, `${auditId}: ${value.detail} ${JSON.stringify(failedRows.map((row) => [row.id, row.problems, row.metrics]))}`);
  }
}

for (const [style, subtitleConfig] of [["縁", outlineSubtitleConfig], ["帯", bandSubtitleConfig]]) test(`焼き込み字幕（${style}）: 公式経路で OP→本編→感想の全部の文の字幕を焼き込み、完成 MP4 で測った監査が通る（境目の監査も字幕のまま通る）`, {
  skip: toolchain.ok ? false : "ffmpeg/ffprobe is unavailable",
}, async () => {
  assert.ok(fontPath, "日本語の書体が見つからない（Linux は fonts-noto-cjk、Windows は日本語の補助フォント）");
  const temp = await mkdtemp(join(os.tmpdir(), "narrated-visual-subtitles-"));
  try {
    const env = await trustEnv(temp);
    const fixture = await createBookendFixtureMedia(join(temp, "fixture-media"), toolchain);
    const { outcome, payloadDir } = await runVisualFixture({
      root: join(temp, "run"),
      env,
      fixture,
      extend: (config, { fontFile }) => ({ ...config, subtitles: subtitleConfig(fontFile) }),
    });
    assert.equal(outcome.status, "awaiting-human-review", JSON.stringify(outcome.knownRemainingIssues));
    assertAutomaticAuditsPass(outcome);
    const measured = outcome.auditChecks.burnedSubtitlesMeasured;
    assert.equal(measured.measurement.cueCount, 5, "本編 3 文 + 感想 2 文の字幕");
    assert.ok(measured.measurement.minimumContrast >= 60);
    const manifestText = await readFile(outcome.artifacts.generationManifest.path, "utf8");
    const manifest = JSON.parse(manifestText);
    assert.equal(manifest.subtitles.burnIn, true);
    assert.equal(manifest.subtitles.cueCount, 5);
    for (const forbidden of ["最初の物語", "感想の一文目"]) assert.equal(manifestText.includes(forbidden), false, `manifest leaked ${forbidden}`);
    // durable Job へ持ち込む Pack の形の検査も subtitles を受ける（知らない欄は止める）。
    const evidence = { harnessId: "narrated-story-video", payloadSha256: "d".repeat(64) };
    await extractNarratedChannelPackRuntime({ payloadDir, evidence });
    const source = JSON.parse(await readFile(join(payloadDir, "narrated-story.json"), "utf8"));
    source.subtitles.shadow = true;
    await writeFile(join(payloadDir, "narrated-story.json"), JSON.stringify(source));
    await assert.rejects(extractNarratedChannelPackRuntime({ payloadDir, evidence }), /subtitles contains unsupported fields: shadow/u);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("焼き込み字幕: 書体に無い字を含む台本は、有料生成の前に止まり plan-only でも同じ理由が出る", {
  skip: toolchain.ok ? false : "ffmpeg/ffprobe is unavailable",
}, async () => {
  assert.ok(fontPath, "日本語の書体が見つからない");
  const temp = await mkdtemp(join(os.tmpdir(), "narrated-visual-glyphs-"));
  try {
    const env = await trustEnv(temp);
    const fixture = await createBookendFixtureMedia(join(temp, "fixture-media"), toolchain);
    const script = BOOKEND_FIXTURE_SCRIPT.replace("最初の物語です。", "最初の\u{10FFFD}物語です。");
    const { outcome, adapters, payloadDir, scriptPath } = await runVisualFixture({
      root: join(temp, "run"),
      env,
      fixture,
      script,
      extend: (config, { fontFile }) => ({ ...config, subtitles: outlineSubtitleConfig(fontFile) }),
    });
    assert.equal(outcome.status, "awaiting-operator-input");
    assert.ok(outcome.knownRemainingIssues.some((issue) => issue.startsWith("subtitle-font-missing-glyphs:1:U+10FFFD")), JSON.stringify(outcome.knownRemainingIssues));
    assert.equal(adapters.calls.generation, 0, "有料生成へ進まない");
    const plan = await inspectNarratedStoryPlan({ scriptPath, channelPackDir: payloadDir });
    assert.ok(plan.blockers.some((issue) => issue.startsWith("subtitle-font-missing-glyphs:1:")), plan.blockers.join(", "));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

const CAMERA_PACK = {
  moves: { "slow-push-in": { zoomPerSecond: 0.02, maxZoom: 1.12 }, "pan-left": { panPerSecond: 0.03, zoom: 1.1 } },
  sequence: ["slow-push-in"],
};

function cameraScript(story) {
  return JSON.stringify({
    format: "buzzassist-narrated-script-package-v1",
    story,
    reviewMarker: "---感想---",
    review: [{ id: "r1", text: "感想の一文目です。" }],
  });
}

test("カメラ: 台本パッケージで1つの場面を文ごとに分けても1つの動きで通し、場面の指定した型を使い、完成 MP4 で測った動きが計画どおり", {
  skip: toolchain.ok ? false : "ffmpeg/ffprobe is unavailable",
}, async () => {
  assert.ok(fontPath, "日本語の書体が見つからない");
  const temp = await mkdtemp(join(os.tmpdir(), "narrated-visual-camera-"));
  try {
    const env = await trustEnv(temp);
    const fixture = await createBookendFixtureMedia(join(temp, "fixture-media"), toolchain);
    const { outcome } = await runVisualFixture({
      root: join(temp, "run"),
      env,
      fixture,
      script: cameraScript([
        { id: "p1", text: "最初の物語です。次の場面です。終わりの場面です。" },
        { id: "p2", text: "最初の物語です。", camera: "pan-left" },
      ]),
      extend: (config) => ({ ...config, camera: CAMERA_PACK }),
    });
    assert.equal(outcome.status, "awaiting-human-review", JSON.stringify(outcome.knownRemainingIssues));
    assertAutomaticAuditsPass(outcome);
    const camera = outcome.auditChecks.cameraMotionMeasured.measurement;
    assert.deepEqual(camera.shots.map((shot) => [shot.move, shot.segmentIds.length]), [["slow-push-in", 3], ["pan-left", 1]]);
    // 同じ画の中の文の境目（2か所）でも、動きは計画どおりに続いている（始め直していない）。
    assert.equal(camera.shots[0].intervals.filter((interval) => interval.kind === "cut").length, 2);
    const manifest = JSON.parse(await readFile(outcome.artifacts.generationManifest.path, "utf8"));
    assert.equal(manifest.camera.source, "channel-pack");
    assert.deepEqual(manifest.camera.shots.map((shot) => shot.requested), [false, true]);
    assert.ok(manifest.segments.filter((segment) => segment.part === "story").every((segment) => ["slow-push-in", "pan-left"].includes(segment.camera.mode)));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("カメラ: 台本パッケージが Pack に無い型を指定したら、有料生成の前に止まる", {
  skip: toolchain.ok ? false : "ffmpeg/ffprobe is unavailable",
}, async () => {
  assert.ok(fontPath, "日本語の書体が見つからない");
  const temp = await mkdtemp(join(os.tmpdir(), "narrated-visual-camera-undeclared-"));
  try {
    const env = await trustEnv(temp);
    const fixture = await createBookendFixtureMedia(join(temp, "fixture-media"), toolchain);
    const { outcome, adapters } = await runVisualFixture({
      root: join(temp, "run"),
      env,
      fixture,
      script: cameraScript([{ id: "p1", text: "最初の物語です。", camera: "pan-right" }]),
      extend: (config) => ({ ...config, camera: CAMERA_PACK }),
    });
    assert.equal(outcome.status, "awaiting-operator-input");
    assert.ok(outcome.knownRemainingIssues.includes("camera-move-undeclared:p1"), JSON.stringify(outcome.knownRemainingIssues));
    assert.equal(adapters.calls.generation, 0);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

// 運営者の見本のような、ごく小さな寄り（1.010 倍）とパン。
const FOCUS_CAMERA_PACK = {
  moves: { "slow-push-in": { zoomPerSecond: 0.03, maxZoom: 1.01 }, "pan-left": { panPerSecond: 0.005, zoom: 1.02 } },
  sequence: ["slow-push-in"],
};

test("カメラの焦点: 台本パッケージの場面の焦点（1.010 倍の寄りとパン）で描き、完成 MP4 のフレームで焦点どおりの見せ方を測る。焦点の無い場面は Pack の型ごとの焦点のまま", {
  skip: toolchain.ok ? false : "ffmpeg/ffprobe is unavailable",
}, async () => {
  assert.ok(fontPath, "日本語の書体が見つからない");
  const temp = await mkdtemp(join(os.tmpdir(), "narrated-visual-camera-focus-"));
  try {
    const env = await trustEnv(temp);
    const fixture = await createBookendFixtureMedia(join(temp, "fixture-media"), toolchain);
    const { outcome } = await runVisualFixture({
      root: join(temp, "run"),
      env,
      fixture,
      script: cameraScript([
        { id: "p1", text: "最初の物語です。次の場面です。", cameraFocus: { x: 0.2, y: 0.3 } },
        { id: "p2", text: "最初の物語です。", camera: "pan-left", cameraFocus: { x: 0.7, y: 0.75 } },
        { id: "p3", text: "終わりの場面です。" },
      ]),
      extend: (config) => ({ ...config, camera: FOCUS_CAMERA_PACK }),
    });
    assert.equal(outcome.status, "awaiting-human-review", JSON.stringify(outcome.knownRemainingIssues));
    assertAutomaticAuditsPass(outcome);
    const focus = outcome.auditChecks.cameraFocusMeasured;
    assert.equal(focus.pass, true, focus.detail);
    // 焦点を指定した2つの場面だけを測り、どちらも Pack の型ごとの焦点の見せ方と許容を越えて違う（焦点が効いた）。
    assert.deepEqual(focus.measurement.shots.map((shot) => [shot.move, shot.segmentIds.length, shot.focus.x, shot.focus.y]), [["slow-push-in", 2, 0.2, 0.3], ["pan-left", 1, 0.7, 0.75]]);
    assert.equal(focus.measurement.distinguishableCount, 2);
    const manifest = JSON.parse(await readFile(outcome.artifacts.generationManifest.path, "utf8"));
    const storyShots = manifest.camera.shots.filter((shot) => shot.part === "story");
    assert.deepEqual(storyShots.map((shot) => shot.focus || null), [
      { x: 0.2, y: 0.3, source: "script-package" },
      { x: 0.7, y: 0.75, source: "script-package" },
      null,
    ]);
    const p1 = manifest.segments.filter((segment) => segment.sourceSegmentId === "p1");
    assert.equal(p1.length, 2);
    for (const segment of p1) assert.deepEqual(segment.cameraFocus, { x: 0.2, y: 0.3 });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("カメラの焦点: 焦点を書かない台本では何も測らずに通り（Pack の型ごとの焦点）、形の誤った焦点は有料生成の前に理由コードつきで止まる", {
  skip: toolchain.ok ? false : "ffmpeg/ffprobe is unavailable",
}, async () => {
  assert.ok(fontPath, "日本語の書体が見つからない");
  const temp = await mkdtemp(join(os.tmpdir(), "narrated-visual-camera-focus-none-"));
  try {
    const env = await trustEnv(temp);
    const fixture = await createBookendFixtureMedia(join(temp, "fixture-media"), toolchain);
    const plain = await runVisualFixture({
      root: join(temp, "plain"),
      env,
      fixture,
      script: cameraScript([{ id: "p1", text: "最初の物語です。" }]),
      extend: (config) => ({ ...config, camera: FOCUS_CAMERA_PACK }),
    });
    assert.equal(plain.outcome.status, "awaiting-human-review", JSON.stringify(plain.outcome.knownRemainingIssues));
    assert.equal(plain.outcome.auditChecks.cameraFocusMeasured.pass, true);
    assert.equal(plain.outcome.auditChecks.cameraFocusMeasured.measurement.shotCount, 0);
    const bad = await runVisualFixture({
      root: join(temp, "bad"),
      env,
      fixture,
      script: cameraScript([{ id: "p1", text: "最初の物語です。", cameraFocus: { x: 0.2, y: 1.3 } }]),
      extend: (config) => ({ ...config, camera: FOCUS_CAMERA_PACK }),
    });
    assert.equal(bad.outcome.status, "awaiting-operator-input");
    assert.ok(bad.outcome.knownRemainingIssues.includes("script-package-invalid:story[0].cameraFocus.y"), JSON.stringify(bad.outcome.knownRemainingIssues));
    assert.equal(bad.adapters.calls.generation, 0, "有料生成へ進まない");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
