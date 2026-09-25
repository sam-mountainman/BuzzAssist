// 工程ごとの所要時間（RunReceipt の timing.stages、schema revision 3）の試験。値は全て合成。
import assert from "node:assert/strict";
import test from "node:test";

import {
  RUN_RECEIPT_SCHEMA_REVISION,
  RUN_RECEIPT_STAGE_TIMINGS_IN_FORCE_SINCE,
  finalizeRunReceipt,
  openRunReceipt,
  recordGate,
  redactForPlatform,
} from "../lib/harnessRunReceipt.mjs";
import { executeVideoHarnessAdapter } from "../lib/videoHarnessAdapters.mjs";
import { _testing as jobTesting } from "../lib/videoHarnessJob.mjs";
import { SOURCE_ROOT, hostCall, invocationRecord } from "./fixtures/hostInvocationFixtures.mjs";

const STAGES = {
  version: "koya-stage-timings-v1",
  stages: [
    { id: "images", startedAt: "2026-09-25T00:00:00.000Z", finishedAt: "2026-09-25T00:20:00.000Z", durationMs: 1_200_000 },
    { id: "speech-overlap", startedAt: "2026-09-25T00:01:00.000Z", finishedAt: "2026-09-25T00:12:00.000Z", durationMs: 660_000, overlapsWith: "images", status: "complete" },
    { id: "prepare", startedAt: "2026-09-25T00:20:00.000Z", finishedAt: "2026-09-25T00:21:00.000Z", durationMs: 60_000 },
    { id: "Bad Id", startedAt: "2026-09-25T00:21:00.000Z", finishedAt: "2026-09-25T00:22:00.000Z", durationMs: 60_000 },
    { id: "render", startedAt: "not-a-time", finishedAt: "2026-09-25T00:30:00.000Z", durationMs: 1 },
    { id: "audit", startedAt: "2026-09-25T00:30:00.000Z", finishedAt: "2026-09-25T00:31:00.000Z", durationMs: -5 },
  ],
};

test("timing.stages keeps only well-formed stage rows and is shared as durations without timestamps", () => {
  assert.ok(RUN_RECEIPT_SCHEMA_REVISION >= 3, "timing.stages は版 3 から");
  assert.equal(RUN_RECEIPT_STAGE_TIMINGS_IN_FORCE_SINCE, 3);
  const receipt = openRunReceipt({
    projectDir: SOURCE_ROOT,
    harnessId: "narrated-story-video",
    entrypoint: "scripts/run-video-harness.mjs",
    action: "full",
    inputs: { scriptSha256: "7".repeat(64) },
    invocation: invocationRecord(hostCall()),
    timing: { jobCreatedAt: "2026-09-24T23:59:00.000Z", runStartedAt: "2026-09-25T00:00:00.000Z", stages: STAGES.stages },
  });
  assert.equal(receipt.schemaRevision, RUN_RECEIPT_SCHEMA_REVISION);
  assert.deepEqual(receipt.timing.stages.map((row) => row.id), ["images", "speech-overlap", "prepare"], "形の崩れた行は落とす");
  assert.equal(receipt.timing.stages[1].overlapsWith, "images");
  assert.equal("status" in receipt.timing.stages[1], false, "id・時刻・長さ・重ねた相手の他は持たない");
  for (const id of receipt.harnessBuild.declaredGates) recordGate(receipt, { id, verdict: "pass", evidence: { synthetic: id } });
  const done = finalizeRunReceipt(receipt, { outcome: "pass", timestamp: "2026-09-25T00:40:00.000Z" });
  assert.equal(done.timing.durationSeconds, 2400);
  const shared = redactForPlatform(done);
  assert.deepEqual(shared.stageDurations, [
    { id: "images", durationMs: 1_200_000 },
    { id: "speech-overlap", durationMs: 660_000, overlapsWith: "images" },
    { id: "prepare", durationMs: 60_000 },
  ]);
  assert.equal(JSON.stringify(shared.stageDurations).includes("2026-09-25"), false, "時刻は返さない");
});

test("a receipt opened without stage timings records an empty list", () => {
  const receipt = openRunReceipt({
    projectDir: SOURCE_ROOT,
    harnessId: "narrated-story-video",
    entrypoint: "scripts/run-video-harness.mjs",
    action: "full",
    invocation: invocationRecord(hostCall()),
  });
  assert.deepEqual(receipt.timing.stages, []);
});

test("the Koya adapter passes the child's stage timings to the Job, which keeps them for the receipt", async () => {
  const job = {
    id: "video-koya-manga-video-7777777777777777",
    harness: { id: "koya-manga-video" },
    projectDir: "/work/jobs",
    script: { path: "/work/jobs/script.txt" },
    options: {
      episodeId: "manga-stage-timing-fixture",
      protagonistSpeakerId: "fixture-lead",
      characterBiblePath: "/work/jobs/character-bible.json",
      storyReviewPath: "/work/jobs/story-review.json",
    },
    stages: [],
  };
  const payload = { episodeId: "manga-stage-timing-fixture", status: "awaiting-human-review", waiting: false, knownRemainingIssues: ["fixture"], stageTimings: STAGES };
  const outcome = await executeVideoHarnessAdapter({
    job,
    runChild: async () => ({ code: 3, signal: null, stdout: `${JSON.stringify(payload)}\n`, stderr: "" }),
  });
  assert.deepEqual(outcome.stageTimings, STAGES);
  const evidence = jobTesting.imageEvidenceFromOutcome(job, outcome, [], () => "2026-09-25T00:40:00.000Z");
  assert.equal(evidence.stageTimings.version, "koya-stage-timings-v1");
  assert.deepEqual(evidence.stageTimings.stages.map((row) => row.id), ["images", "speech-overlap", "prepare"]);
  assert.equal(evidence.stageTimings.stages[1].overlapsWith, "images");
});
