#!/usr/bin/env node

// Windows で長い動画を作る: 長い台本（本編 45 文・場面 45）を、Windows の長い path に当たる深いフォルダの
// Job で公式経路に通し、公式経路が組み立てた ffmpeg の呼び出しを全部記録して、どれも Windows のコマンド行の
// 上限（32,767 字）に収まることを測る。場面ごとの `-loop 1 -i <画>` と文ごとの `-i <声>` を1回の呼び出しに
// 並べると上限を越える長さにしてある（それも測って確かめる）。合成の Pack・台本・画・声で、有料 API は使わない。

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FFMPEG_COMMAND_LINE_BUDGET, WINDOWS_COMMAND_LINE_MAX, windowsQuotedArgument } from "../lib/ffmpegFilterArgs.mjs";
import { resolveFfmpegToolchain } from "../lib/harnessRuntimeResolver.mjs";
import {
  REVIEWER_TRUST_PATH_ENV,
  REVIEWER_TRUST_VERSION,
  createReviewerTrustEntry,
  generateReviewerKeyPair,
} from "../lib/koyaReviewAttestation.mjs";
import { runNarratedStoryVideo } from "../lib/narratedStoryVideo.mjs";
import { runPastAssetLoops } from "./fixtures/narratedAssetLoopFixture.mjs";
import {
  bookendFixtureAdapters,
  bookendFixtureChannelConfig,
  createBookendFixtureMedia,
  passingVoiceQualityGate,
  writeBookendPackAssets,
} from "./fixtures/narratedBookendFixture.mjs";
import { recordedCommandLines, recordingToolchain } from "./helpers/ffmpegCommandLineRecording.mjs";
import { acceptScriptForTests } from "./helpers/scriptQualityAcceptance.mjs";

const toolchain = await resolveFfmpegToolchain();
const STORY_SENTENCES = 45;
const EXEMPT = new Set(["perceptualReviewChecks", "perceptualReviewBoundToOutput", "perceptualEvidenceHashes", "contactSheetOriginalDetailReviewed", "qualityLoopPassed", "characterIdentityReviewed"]);

test("Windows で長い動画: 深いフォルダの長い台本でも、公式経路が組み立てる ffmpeg の呼び出しは全部コマンド行の上限に収まり、完成 MP4 の監査が通る", {
  skip: toolchain.ok ? false : "ffmpeg/ffprobe is unavailable",
}, async (t) => {
  const temp = await mkdtemp(join(os.tmpdir(), "narrated-long-cmdline-"));
  try {
    // Windows の長い path（1段 200 字 × 3 段の下に Job の作業フォルダ）。
    const root = join(temp, "p".repeat(200), "q".repeat(200), "r".repeat(200));
    await mkdir(root, { recursive: true });
    const reviewer = generateReviewerKeyPair();
    const trustPath = join(temp, "trust.json");
    await writeFile(trustPath, JSON.stringify({ version: REVIEWER_TRUST_VERSION, reviewers: [createReviewerTrustEntry({ publicKeyPem: reviewer.publicKeyPem, label: "long script fixture" })] }));
    const fixture = await createBookendFixtureMedia(join(temp, "fixture-media"), toolchain);
    const payloadDir = join(temp, "pack");
    await mkdir(payloadDir, { recursive: true });
    await writeBookendPackAssets(payloadDir, toolchain);
    await writeFile(join(payloadDir, "narrated-story.json"), JSON.stringify(bookendFixtureChannelConfig(), null, 2), "utf8");
    // 本編 45 文（生テキストは文ごとに1場面）と感想 2 文。
    const story = Array.from({ length: STORY_SENTENCES }, (_, index) => `場面${index + 1}の物語です。`);
    const scriptPath = join(temp, "script.txt");
    await writeFile(scriptPath, `${[...story, "---感想---", "感想の一文目です。", "感想の二文目です。"].join("\n")}\n`, "utf8");
    await acceptScriptForTests(scriptPath);
    const logPath = join(temp, "ffmpeg-command-lines.jsonl");
    const adapters = bookendFixtureAdapters(fixture);
    const jobId = "video-narrated-story-video-10ngscr1pt000001";
    const outcome = await runPastAssetLoops(() => runNarratedStoryVideo({
      command: "full",
      scriptPath,
      channelPackDir: payloadDir,
      jobId,
      jobIdentityDigest: "e".repeat(64),
      deploymentRoot: root,
      mediaJobRunner: adapters.mediaJobRunner,
      mediaJobProbe: adapters.mediaJobProbe,
      ffmpegToolchain: recordingToolchain(toolchain, logPath),
      voiceQualityGate: passingVoiceQualityGate,
      env: { ...process.env, [REVIEWER_TRUST_PATH_ENV]: trustPath },
    }, { allowDirectUnboundJobForTests: true }));
    assert.equal(outcome.status, "awaiting-human-review", JSON.stringify(outcome.knownRemainingIssues));
    for (const [auditId, value] of Object.entries(outcome.auditChecks)) {
      if (EXEMPT.has(auditId)) continue;
      assert.equal(value.pass, true, `${auditId}: ${value.detail}`);
    }
    // 組み立てたコマンド行の長さ（本物の ffmpeg の path と引数で、Windows の規則で数えた長さ）。
    const calls = await recordedCommandLines(logPath);
    const longest = Math.max(...calls.map((call) => call.length));
    t.diagnostic(`ffmpeg の呼び出し ${calls.length} 回、最長のコマンド行 ${longest} 字、入力の最多 ${Math.max(...calls.map((call) => call.inputs))} 本`);
    assert.ok(calls.length > 50, `${calls.length} calls`);
    assert.ok(longest < WINDOWS_COMMAND_LINE_MAX, `最長の呼び出し ${longest} 字`);
    assert.ok(longest <= FFMPEG_COMMAND_LINE_BUDGET + 2_000);
    // 1回に並べていたら上限を越えた長さであること（場面の画の入力だけで数える）。
    const imagePath = join(root, ".media", "narrated-story-video", jobId, "media", "images", "s001.png");
    const oneCommandImages = STORY_SENTENCES * ["-loop", "1", "-framerate", "24", "-i", imagePath].map((token) => windowsQuotedArgument(token).length + 1).reduce((sum, value) => sum + value, 0);
    assert.ok(oneCommandImages > WINDOWS_COMMAND_LINE_MAX, `場面の画の入力だけで ${oneCommandImages} 字`);
    t.diagnostic(`1回に並べた場合の場面の画の入力だけの長さ ${oneCommandImages} 字`);
    // 描いた証拠: 本編の場面は塊に分けて描き、声も塊に分けてつないだ。
    const manifest = JSON.parse(await readFile(outcome.artifacts.generationManifest.path, "utf8"));
    assert.equal(manifest.segments.filter((segment) => segment.part === "story").length, STORY_SENTENCES);
    const report = JSON.parse(await readFile(outcome.artifacts.auditReport.path, "utf8"));
    const graphs = report.auditChecks.parentAudioPcmPreserved.renderGraphs;
    assert.ok(graphs.storyVideo && graphs.voiceStem);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
