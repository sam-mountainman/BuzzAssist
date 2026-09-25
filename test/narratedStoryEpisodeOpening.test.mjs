#!/usr/bin/env node

// 回ごとの OP 映像（運営者が外で作った短い動画）を、来歴つきで公式経路へ取り込み、完成 MP4 の OP が
// その動画であることを測る。動画は試験の中で FFmpeg の lavfi で作る（有料 API・ネットワークは使わない）。

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
import { normalizeNarratedBookendsConfig } from "../lib/narratedStoryBookends.mjs";
import { inspectNarratedStoryPlan } from "../lib/narratedStoryPipeline.mjs";
import {
  OPERATOR_VIDEO_MANIFEST_UNBOUND_CODE,
  assertOperatorVideoManifestBoundToJob,
  runNarratedStoryVideo,
} from "../lib/narratedStoryVideo.mjs";
import { OPENING_FRAME_MAX_DIFF, narratedEpisodeOpeningCheck } from "../lib/narratedStoryVisuals.mjs";
import {
  OPERATOR_VIDEO_MANIFEST_VERSION,
  checkOperatorVideoImport,
  readOperatorVideoManifest,
} from "../lib/operatorVideoImport.mjs";
import { passOperatorVideoLoops, runPastAssetLoops } from "./fixtures/narratedAssetLoopFixture.mjs";
import {
  BOOKEND_FIXTURE_SCRIPT,
  bookendFixtureAdapters,
  bookendFixtureChannelConfig,
  createBookendFixtureMedia,
  passingVoiceQualityGate,
  writeBookendPackAssets,
} from "./fixtures/narratedBookendFixture.mjs";
import { ff } from "./fixtures/narratedVisualFixture.mjs";

const toolchain = await resolveFfmpegToolchain();
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const SLOT_RULES = { "episode-opening": { required: true, minSeconds: 1, maxSeconds: 4, aspect: 16 / 9, aspectTolerance: 0.02, requireAudio: true } };
const CONVERSATION = "https://example.invalid/fixture-conversation/0001";

/** 運営者の動画の取り込みの記録と、それが指す動画・プロンプトを書く（合成）。 */
async function writeVideoManifest(folder, { source = "testsrc2", seconds = 2, rate = 30, audio = true, route = "grok", prompt = true, slot = "episode-opening" } = {}) {
  await mkdir(join(folder, "clips"), { recursive: true });
  await mkdir(join(folder, "prompts"), { recursive: true });
  const clip = join(folder, "clips", `${slot}-${source}.mp4`);
  await ff(toolchain, [
    "-f", "lavfi", "-i", `${source}=size=320x180:rate=${rate}:duration=${seconds}`,
    ...(audio ? ["-f", "lavfi", "-i", `sine=frequency=523:duration=${seconds}:sample_rate=48000`] : []),
    // 音は bookend の fixture の OP の音と同じ小ささ（語りより大きな OP の音は番組の音量の監査が落とす）。
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", ...(audio ? ["-af", "volume=0.05", "-c:a", "aac", "-shortest"] : []), clip,
  ]);
  const promptText = "fixture opening prompt: a short synthetic clip";
  await writeFile(join(folder, "prompts", `${slot}.txt`), promptText, "utf8");
  const manifest = {
    version: OPERATOR_VIDEO_MANIFEST_VERSION,
    clips: [{
      slot,
      video: { path: `clips/${slot}-${source}.mp4`, sha256: sha256(await readFile(clip)) },
      route,
      ...(route === "recorded" ? {} : { modelLabel: "fixture video model" }),
      ...(prompt ? { prompt: { path: `prompts/${slot}.txt`, sha256: sha256(promptText) } } : {}),
      generatedAt: "2026-09-25T10:00:00+09:00",
      conversationUrl: CONVERSATION,
    }],
  };
  const manifestPath = join(folder, "video-manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return { manifestPath, clip, manifest };
}

test("Pack の OP: episode-video は尺の範囲と音の扱いを宣言し、映像の音と Pack の OP の音を重ねない", () => {
  const base = bookendFixtureChannelConfig().bookends;
  const ok = normalizeNarratedBookendsConfig({ ...base, opening: { kind: "episode-video", minSeconds: 1, maxSeconds: 4, useEmbeddedAudio: true } });
  assert.deepEqual(ok.blockers, []);
  assert.equal(ok.config.opening.useEmbeddedAudio, true);
  const bad = normalizeNarratedBookendsConfig({ ...base, opening: { kind: "episode-video", maxSeconds: 400, useEmbeddedAudio: true, audio: "assets/opening-audio.wav" } });
  for (const expected of ["bookends.opening.minSeconds", "bookends.opening.maxSeconds", "bookends.opening.audio-conflicts-with-embedded-audio"]) {
    assert.ok(bad.blockers.includes(expected), `${expected}: ${bad.blockers.join(", ")}`);
  }
});

test("運営者の動画の取り込み: sha256・尺・縦横比・音・来歴を有料生成の前に確かめる", { skip: toolchain.ok ? false : "ffmpeg is unavailable" }, async () => {
  const dir = await mkdtemp(join(os.tmpdir(), "operator-video-import-"));
  try {
    const good = await writeVideoManifest(join(dir, "good"));
    const read = await readOperatorVideoManifest({ manifestPath: good.manifestPath, ffprobe: toolchain.ffprobe });
    assert.deepEqual(read.problems, []);
    assert.equal(read.clips[0].probe.hasAudio, true);
    assert.ok(Math.abs(read.clips[0].probe.durationSeconds - 2) < 0.1);
    assert.deepEqual(checkOperatorVideoImport({ manifest: read, slots: SLOT_RULES }).issues, []);
    // 尺が範囲の外・音が無い・決まりの無い枠。
    const long = await readOperatorVideoManifest({ manifestPath: (await writeVideoManifest(join(dir, "long"), { seconds: 5 })).manifestPath, ffprobe: toolchain.ffprobe });
    assert.ok(checkOperatorVideoImport({ manifest: long, slots: SLOT_RULES }).issues.includes("operator-video-too-long:episode-opening"));
    const silent = await readOperatorVideoManifest({ manifestPath: (await writeVideoManifest(join(dir, "silent"), { audio: false })).manifestPath, ffprobe: toolchain.ffprobe });
    assert.ok(checkOperatorVideoImport({ manifest: silent, slots: SLOT_RULES }).issues.includes("operator-video-audio-required:episode-opening"));
    assert.ok(checkOperatorVideoImport({ manifest: read, slots: {} }).issues.includes("operator-video-slot-unexpected:episode-opening"));
    assert.ok(checkOperatorVideoImport({ manifest: { clips: [], problems: [] }, slots: SLOT_RULES }).issues.includes("operator-video-slot-missing:episode-opening"));
    // sha256 の不一致・生成した経路のプロンプトの欠落。人が撮った映像（recorded）はプロンプトが無くてよい。
    const tampered = { ...good.manifest, clips: [{ ...good.manifest.clips[0], video: { ...good.manifest.clips[0].video, sha256: "0".repeat(64) } }] };
    await writeFile(good.manifestPath, JSON.stringify(tampered));
    assert.ok((await readOperatorVideoManifest({ manifestPath: good.manifestPath, ffprobe: toolchain.ffprobe })).problems.includes("operator-video-sha256-mismatch:episode-opening"));
    const noPrompt = await readOperatorVideoManifest({ manifestPath: (await writeVideoManifest(join(dir, "noprompt"), { prompt: false })).manifestPath, ffprobe: toolchain.ffprobe });
    assert.ok(noPrompt.problems.includes("operator-video-prompt-required:episode-opening"));
    const recorded = await readOperatorVideoManifest({ manifestPath: (await writeVideoManifest(join(dir, "recorded"), { prompt: false, route: "recorded" })).manifestPath, ffprobe: toolchain.ffprobe });
    assert.deepEqual(recorded.problems, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Job の束縛: 子へ渡す動画の manifest は、上位 Job の options.operatorVideoManifestPath と同じでなければ止める", async () => {
  const dir = await mkdtemp(join(os.tmpdir(), "operator-video-binding-"));
  try {
    const jobPath = join(dir, "job.json");
    await writeFile(jobPath, JSON.stringify({ options: { operatorVideoManifestPath: join(dir, "declared.json") } }));
    await assertOperatorVideoManifestBoundToJob({ upstreamJobPath: jobPath, operatorVideoManifestPath: join(dir, "declared.json") });
    await assert.rejects(
      assertOperatorVideoManifestBoundToJob({ upstreamJobPath: jobPath, operatorVideoManifestPath: join(dir, "other.json") }),
      (error) => error?.code === OPERATOR_VIDEO_MANIFEST_UNBOUND_CODE,
    );
    await assert.rejects(
      assertOperatorVideoManifestBoundToJob({ upstreamJobPath: jobPath, operatorVideoManifestPath: "" }),
      (error) => error?.code === OPERATOR_VIDEO_MANIFEST_UNBOUND_CODE,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function writeEpisodeOpeningPack(payloadDir) {
  await mkdir(payloadDir, { recursive: true });
  await writeBookendPackAssets(payloadDir, toolchain);
  const config = bookendFixtureChannelConfig();
  config.bookends.opening = { kind: "episode-video", minSeconds: 1, maxSeconds: 4, useEmbeddedAudio: true, backgroundColor: "#000000" };
  await writeFile(join(payloadDir, "narrated-story.json"), JSON.stringify(config, null, 2), "utf8");
}

test("回ごとの OP 映像: 公式経路で冒頭に入り、来歴は私有の Job フォルダにだけ残り、完成 MP4 の OP がその動画だと測れる", {
  skip: toolchain.ok ? false : "ffmpeg/ffprobe is unavailable",
}, async () => {
  const temp = await mkdtemp(join(os.tmpdir(), "narrated-episode-opening-"));
  try {
    const reviewer = generateReviewerKeyPair();
    const trustPath = join(temp, "trust.json");
    await writeFile(trustPath, JSON.stringify({ version: REVIEWER_TRUST_VERSION, reviewers: [createReviewerTrustEntry({ publicKeyPem: reviewer.publicKeyPem, label: "opening fixture" })] }));
    const env = { ...process.env, [REVIEWER_TRUST_PATH_ENV]: trustPath };
    const fixture = await createBookendFixtureMedia(join(temp, "fixture-media"), toolchain);
    const payloadDir = join(temp, "pack");
    await writeEpisodeOpeningPack(payloadDir);
    const scriptPath = join(temp, "script.txt");
    await writeFile(scriptPath, `${BOOKEND_FIXTURE_SCRIPT}\n`, "utf8");
    const { manifestPath } = await writeVideoManifest(join(temp, "operator"));
    const adapters = bookendFixtureAdapters(fixture);
    const options = {
      command: "full",
      scriptPath,
      channelPackDir: payloadDir,
      jobId: "video-narrated-story-video-0pen1ng000000001",
      jobIdentityDigest: "f".repeat(64),
      deploymentRoot: join(temp, "run"),
      mediaJobRunner: adapters.mediaJobRunner,
      mediaJobProbe: adapters.mediaJobProbe,
      ffmpegToolchain: toolchain,
      voiceQualityGate: passingVoiceQualityGate,
      env,
    };
    // 動画の manifest が無ければ、有料生成の前に止まる（plan-only でも同じ理由）。
    const missing = await runNarratedStoryVideo(options, { allowDirectUnboundJobForTests: true });
    assert.equal(missing.status, "awaiting-operator-input");
    assert.deepEqual(missing.knownRemainingIssues, ["operator-video-manifest-required"]);
    assert.equal(adapters.calls.generation, 0);
    assert.ok((await inspectNarratedStoryPlan({ scriptPath, channelPackDir: payloadDir })).blockers.includes("operator-video-manifest-required"));
    // 監査契約 v7: 取り込む動画は、記録のフォルダで回した工程 video-clip の品質ループの合格が要る。記録に assetLoop が
    // 無ければ、plan-only でも公式経路でも有料の処理の前に人待ちで止まる。
    assert.deepEqual(
      (await inspectNarratedStoryPlan({ scriptPath, channelPackDir: payloadDir, operatorVideoManifestPath: manifestPath, ffprobe: toolchain.ffprobe })).blockers,
      ["video-clip-asset-loop-not-passed:episode-opening:record-required"],
    );
    const unreviewed = await runNarratedStoryVideo({ ...options, operatorVideoManifestPath: manifestPath }, { allowDirectUnboundJobForTests: true });
    assert.equal(unreviewed.status, "awaiting-human-review");
    assert.deepEqual(unreviewed.knownRemainingIssues, ["video-clip-asset-loop-not-passed:episode-opening:record-required"]);
    assert.deepEqual(unreviewed.assetQualityLoop.pending.map((row) => [row.stage, row.slot, row.reason, row.declaration?.audio]), [["video-clip", "episode-opening", "record-required", "required"]]);
    assert.equal(unreviewed.auditChecks.operatorVideoAssetLoopPassed.pass, false);
    assert.equal(adapters.calls.generation, 0, "動画のループが合格するまで有料の処理へ進まない");
    await passOperatorVideoLoops({ folder: join(temp, "operator"), manifestPath, declarations: { "episode-opening": unreviewed.assetQualityLoop.pending[0].declaration } });
    assert.deepEqual((await inspectNarratedStoryPlan({ scriptPath, channelPackDir: payloadDir, operatorVideoManifestPath: manifestPath, ffprobe: toolchain.ffprobe })).blockers, []);

    const outcome = await runPastAssetLoops(() => runNarratedStoryVideo({ ...options, operatorVideoManifestPath: manifestPath }, { allowDirectUnboundJobForTests: true }));
    assert.equal(outcome.status, "awaiting-human-review", JSON.stringify(outcome.knownRemainingIssues));
    for (const [auditId, value] of Object.entries(outcome.auditChecks)) {
      if (["perceptualReviewChecks", "perceptualReviewBoundToOutput", "perceptualEvidenceHashes", "contactSheetOriginalDetailReviewed", "qualityLoopPassed", "characterIdentityReviewed"].includes(auditId)) continue;
      assert.equal(value.pass, true, `${auditId}: ${value.detail} ${JSON.stringify(value.measurement?.boundaries?.map((entry) => entry.metrics) || "")}`);
    }
    const opening = outcome.auditChecks.episodeOpeningProvenance;
    assert.equal(opening.frames, 48, "2 秒の動画を 24fps で 48 フレーム");
    assert.ok(opening.maxFrameDiff <= OPENING_FRAME_MAX_DIFF);
    assert.equal(opening.record.route, "grok");
    // 公開面（生成記録・監査・outcome）には会話の URL もプロンプトの本文も出ない。私有の Job フォルダにだけある。
    const manifestText = await readFile(outcome.artifacts.generationManifest.path, "utf8");
    for (const text of [manifestText, JSON.stringify(outcome)]) {
      assert.equal(text.includes(CONVERSATION), false);
      assert.equal(text.includes("fixture opening prompt"), false);
    }
    assert.equal(JSON.parse(manifestText).operatorVideos.clips[0].conversationUrlSha256, sha256(CONVERSATION));
    // 動画の品質ループの合格は公開面には sha256 だけで出る（合格した版＝取り込んだ動画）。
    const publicClip = JSON.parse(manifestText).operatorVideos.clips[0];
    assert.equal(publicClip.assetLoop.passedSha256, publicClip.source.sha256);
    assert.equal(outcome.auditChecks.operatorVideoAssetLoopPassed.pass, true, outcome.auditChecks.operatorVideoAssetLoopPassed.detail);
    const privateRecord = await readFile(join(options.deploymentRoot, ".media", "narrated-story-video", options.jobId, "operator-videos", "import-record.json"), "utf8");
    assert.ok(privateRecord.includes(CONVERSATION));
    // OP の境目の転換も、動画の OP のまま実測で通る。
    assert.equal(outcome.auditChecks.bookendTransitionMeasured.pass, true);

    // 壊した版: OP の部に別の動画が入っている（取り込んだ動画と違う絵）。
    const other = await writeVideoManifest(join(temp, "other"), { source: "smptebars" });
    const otherRead = await readOperatorVideoManifest({ manifestPath: other.manifestPath, ffprobe: toolchain.ffprobe });
    const swapped = await narratedEpisodeOpeningCheck({
      ffmpeg: toolchain.ffmpeg,
      videoPath: outcome.artifacts.previewVideo.path,
      config: { render: { width: 320, height: 180, fps: 24 }, bookends: { enabled: true, opening: { kind: "episode-video", minSeconds: 1, maxSeconds: 4, backgroundColor: "#000000" } } },
      operatorVideos: {
        clips: new Map([["episode-opening", { path: other.clip, probe: otherRead.clips[0].probe }]]),
        publicRecord: { clips: [{ slot: "episode-opening", route: "grok", promptSha256: "a".repeat(64), source: { sha256: otherRead.clips[0].video.sha256 } }] },
      },
      bookendPlan: { parts: [{ id: "opening", frames: 48 }] },
    });
    assert.equal(swapped.pass, false);
    assert.ok(swapped.problems.includes("opening-frames-differ-from-imported-video"), swapped.detail);
    assert.ok(swapped.maxFrameDiff > OPENING_FRAME_MAX_DIFF * 2);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
