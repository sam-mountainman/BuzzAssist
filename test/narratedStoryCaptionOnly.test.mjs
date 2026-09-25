#!/usr/bin/env node

// 感想パートの「声を作らずに字幕だけを出す文」（台本パッケージの captionOnlySeconds）。声の Media Job を
// 作らず、宣言の秒数の無音を置き、字幕と BGM だけで進むことを公式経路で確かめる。

import assert from "node:assert/strict";
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
import { validateNarratedScriptPackage } from "../lib/narratedStoryScriptPackage.mjs";
import { runNarratedStoryVideo } from "../lib/narratedStoryVideo.mjs";
import { runPastAssetLoops } from "./fixtures/narratedAssetLoopFixture.mjs";
import {
  bookendFixtureAdapters,
  createBookendFixtureMedia,
  passingVoiceQualityGate,
  writeBookendPack,
} from "./fixtures/narratedBookendFixture.mjs";
import { acceptScriptForTests } from "./helpers/scriptQualityAcceptance.mjs";

const toolchain = await resolveFfmpegToolchain();
const EXEMPT = new Set(["perceptualReviewChecks", "perceptualReviewBoundToOutput", "perceptualEvidenceHashes", "contactSheetOriginalDetailReviewed", "qualityLoopPassed", "characterIdentityReviewed"]);

function scriptPackage(review) {
  return JSON.stringify({
    format: "buzzassist-narrated-script-package-v1",
    story: [{ id: "p1", text: "最初の物語です。" }, { id: "p2", text: "次の場面です。" }],
    reviewMarker: "---感想---",
    review,
  });
}

test("台本パッケージ: captionOnlySeconds は感想の文だけに、0.5〜30 秒で書ける", () => {
  const ok = validateNarratedScriptPackage(JSON.parse(scriptPackage([{ id: "r1", text: "感想です。" }, { id: "r2", text: "字幕だけ。", captionOnlySeconds: 1.5 }])));
  assert.equal(ok.ok, true, ok.problems.join(", "));
  const bad = validateNarratedScriptPackage(JSON.parse(scriptPackage([{ id: "r1", text: "感想です。", captionOnlySeconds: 60 }])));
  assert.ok(bad.problems.includes("script-package-invalid:review[0].captionOnlySeconds"));
  const story = validateNarratedScriptPackage({ format: "buzzassist-narrated-script-package-v1", story: [{ id: "p1", text: "本文。", captionOnlySeconds: 2 }] });
  assert.ok(story.problems.includes("script-package-invalid:story[0].captionOnlySeconds-unknown"));
});

async function run(root, review) {
  await mkdir(root, { recursive: true });
  const reviewer = generateReviewerKeyPair();
  const trustPath = join(root, "trust.json");
  await writeFile(trustPath, JSON.stringify({ version: REVIEWER_TRUST_VERSION, reviewers: [createReviewerTrustEntry({ publicKeyPem: reviewer.publicKeyPem, label: "caption fixture" })] }));
  const fixture = await createBookendFixtureMedia(join(root, "fixture-media"), toolchain);
  const payloadDir = join(root, "pack");
  await writeBookendPack(payloadDir, toolchain);
  const scriptPath = join(root, "script-package.json");
  await writeFile(scriptPath, scriptPackage(review), "utf8");
  // 台本の関門（監査契約 v8 から）はこの試験の対象外。台本を人がそのまま使うと認めた記録を置く。
  await acceptScriptForTests(scriptPath);
  const adapters = bookendFixtureAdapters(fixture);
  const options = {
    command: "full",
    scriptPath,
    channelPackDir: payloadDir,
    jobId: "video-narrated-story-video-capt10n000000001",
    jobIdentityDigest: "9".repeat(64),
    deploymentRoot: join(root, "run"),
    mediaJobRunner: adapters.mediaJobRunner,
    mediaJobProbe: adapters.mediaJobProbe,
    ffmpegToolchain: toolchain,
    voiceQualityGate: passingVoiceQualityGate,
    env: { ...process.env, [REVIEWER_TRUST_PATH_ENV]: trustPath },
  };
  const outcome = await runPastAssetLoops(() => runNarratedStoryVideo(options, { allowDirectUnboundJobForTests: true }));
  return { outcome, adapters };
}

test("字幕だけの文: 声を作らず無音と字幕と BGM だけで進み、自動監査は声のある文だけで語りの聞こえ方を測る", {
  skip: toolchain.ok ? false : "ffmpeg/ffprobe is unavailable",
}, async () => {
  const temp = await mkdtemp(join(os.tmpdir(), "narrated-caption-only-"));
  try {
    const { outcome, adapters } = await run(temp, [
      { id: "r1", text: "感想の一文目です。" },
      { id: "r2", text: "字幕だけの一文です。", captionOnlySeconds: 1.5 },
      { id: "r3", text: "感想の三文目です。" },
    ]);
    assert.equal(outcome.status, "awaiting-human-review", JSON.stringify(outcome.knownRemainingIssues));
    for (const [auditId, value] of Object.entries(outcome.auditChecks)) {
      if (EXEMPT.has(auditId)) continue;
      assert.equal(value.pass, true, `${auditId}: ${value.detail}`);
    }
    // 声の Media Job は本編 2 + 感想 2（字幕だけの文の分は作らない）。
    assert.equal(adapters.calls.kinds.filter((kind) => kind === "voice.synthesis").length, 4);
    const manifest = JSON.parse(await readFile(outcome.artifacts.generationManifest.path, "utf8"));
    const captionOnly = manifest.segments.find((segment) => segment.id === "r2");
    assert.equal(captionOnly.captionOnly, true);
    assert.equal(captionOnly.voiceSha256, null);
    assert.match(captionOnly.silenceSha256, /^[a-f0-9]{64}$/u);
    assert.ok(Math.abs(captionOnly.durationSeconds - 1.5) < 0.01);
    assert.deepEqual(outcome.auditChecks.narrationBedSeparation.intervals.map((entry) => entry.id), ["p1", "p2", "r1", "r3"]);
    // 字幕は字幕だけの文にも出る（字幕のトラックの数 = 文の数）。
    assert.equal(outcome.auditChecks.audioBoundaryBreathV16.measurement.end.captionCount, 5);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("字幕だけの文で感想パートを始める台本は、有料生成の前に止まる（境目で語りと字幕が同時に始まることを確かめられない）", {
  skip: toolchain.ok ? false : "ffmpeg/ffprobe is unavailable",
}, async () => {
  const temp = await mkdtemp(join(os.tmpdir(), "narrated-caption-only-first-"));
  try {
    const { outcome, adapters } = await run(temp, [
      { id: "r1", text: "字幕だけの一文です。", captionOnlySeconds: 1.5 },
      { id: "r2", text: "感想の二文目です。" },
    ]);
    assert.equal(outcome.status, "awaiting-operator-input");
    assert.deepEqual(outcome.knownRemainingIssues, ["caption-only-cannot-open-review:r1"]);
    assert.equal(adapters.calls.generation, 0);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
