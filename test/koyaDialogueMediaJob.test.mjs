import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  KoyaUsageLimitError,
  prepareKoyaDialogueCut,
  requestElevenLabsDialogue,
  requestKoyaDialogueMediaJob,
} from "../lib/koyaDialogueSpeech.mjs";
import { createPaidMediaJobBroker } from "../lib/paidMediaJobBroker.mjs";

function response(status, payload, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] || null },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function plan() {
  const manifest = {
    utterances: [
      { id: "cut-01-u01", text: "おはよう。", speakerId: "a", voiceId: "voice-a" },
      { id: "cut-01-u02", text: "おはよう。", speakerId: "b", voiceId: "voice-b" },
    ],
  };
  return prepareKoyaDialogueCut(manifest, {
    id: "cut-01",
    utteranceIds: ["cut-01-u01", "cut-01-u02"],
  }, { takeCount: 2 });
}

function completedJob(overrides = {}) {
  return {
    jobId: "job-eleven-1",
    providerJobId: "eleven-provider-1",
    requestKey: `koya:cut-01:take:1:${"1".repeat(64)}`,
    inputHash: "1".repeat(64),
    kind: "voice.dialogue",
    provider: "elevenlabs",
    adapterVersion: "elevenlabs-dialogue-server-v1",
    model: "eleven_v3",
    voiceId: "dialogue-voice-hash",
    status: "completed",
    reservation: { reservationId: "reserve-eleven-1", status: "committed" },
    usage: { units: 12, seconds: 2.5, cost: 0.12, currency: "USD" },
    result: {
      artifact: { url: "https://artifacts.invalid/dialogue.wav", sha256: "a".repeat(64) },
      outputFormat: "wav_44100",
      requestId: "request-eleven-1",
      voiceSegments: [
        { dialogue_input_index: 0, start_time_seconds: 0, end_time_seconds: 1 },
        { dialogue_input_index: 1, start_time_seconds: 1, end_time_seconds: 2.5 },
      ],
      alignment: { characters: ["お"], character_start_times_seconds: [0], character_end_times_seconds: [0.2] },
    },
    attempts: { total: 1, retries: [] },
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:01.000Z",
    ...overrides,
  };
}

test("Koya dialogue sends a typed ElevenLabs job through the server adapter", async () => {
  const cutPlan = plan();
  const queued = completedJob({ status: "queued", result: null });
  const completed = completedJob();
  let submitted;
  let waited;
  let artifactReads = 0;
  const mediaJobBroker = {
    start: async (spec) => { submitted = spec; return queued; },
    waitFor: async (ref) => { waited = ref; return completed; },
  };
  const result = await requestKoyaDialogueMediaJob(cutPlan, 0, {
    sourceDir: "/unused",
    mediaJobBroker,
    artifactReader: async (job) => {
      artifactReads += 1;
      assert.equal(job, completed);
      return Buffer.from("RIFF-dialogue");
    },
  });

  assert.equal(submitted.kind, "voice.dialogue");
  assert.equal(submitted.provider, "elevenlabs");
  assert.equal(submitted.adapterVersion, "elevenlabs-dialogue-server-v1");
  assert.equal(submitted.model, "eleven_v3");
  assert.equal(submitted.input.inputs.length, 2);
  assert.deepEqual(submitted.output.acceptedFormats, ["wav_44100", "wav_24000"]);
  assert.match(submitted.requestKey, /^koya:cut-01:take:1:[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(submitted).includes("api.elevenlabs.io"), false);
  assert.equal(JSON.stringify(submitted).includes("apiKey"), false);
  assert.deepEqual(waited, { requestKey: queued.requestKey });
  assert.equal(artifactReads, 1);
  assert.equal(result.job.providerJobId, "eleven-provider-1");
  assert.equal(result.mediaJobReceipt.artifact.url, undefined);
});

test("Koya dialogue never downloads or resubmits a recovery-required job", async () => {
  const recovery = completedJob({
    status: "recovery-required",
    result: null,
    error: { message: "recover provider job", status: 200 },
  });
  let starts = 0;
  let reads = 0;
  const mediaJobBroker = {
    start: async () => { starts += 1; return recovery; },
    waitFor: async () => recovery,
  };
  await assert.rejects(() => requestKoyaDialogueMediaJob(plan(), 0, {
    sourceDir: "/unused",
    mediaJobBroker,
    artifactReader: async () => { reads += 1; return Buffer.alloc(1); },
  }), /recover provider job/u);
  assert.equal(starts, 1);
  assert.equal(reads, 0);
});

test("Koya dialogue maps an exhausted 429 to the existing usage-limit contract", async () => {
  const error = Object.assign(new Error("HTTP 429 usage limit"), { status: 429 });
  await assert.rejects(() => requestKoyaDialogueMediaJob(plan(), 0, {
    sourceDir: "/unused",
    mediaJobBroker: { start: async () => { throw error; } },
  }), (received) => received instanceof KoyaUsageLimitError && received.details.status === 429);
});

test("legacy direct ElevenLabs transport is fail-closed outside injected tests", async () => {
  await assert.rejects(() => requestElevenLabsDialogue({
    url: new URL("https://example.invalid/tts"),
    apiKey: "not-used",
    body: {},
  }), /Direct ElevenLabs transport is disabled/u);
});

test("a usage-limit park resumes on re-run under a fresh requestKey without resubmitting the refunded job", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "koya-parked-take-"));
  try {
    const cutPlan = plan();
    const posts = [];
    let serverMode = "rate-limited";
    const apiFetch = async (url, options) => {
      assert.equal(options.method, "POST", "a parked take must not poll or recover; it only resubmits under a new key");
      const body = JSON.parse(options.body);
      posts.push(body.requestKey);
      if (serverMode === "rate-limited") {
        // The server refunds a provider 429 and leaves the requestKey terminal (failed).
        return response(200, { job: {
          jobId: `pmj_${"a".repeat(24)}`,
          requestKey: body.requestKey,
          inputHash: body.inputHash,
          status: "failed",
          reservation: { reservationId: "pmr_refunded", status: "refunded" },
          error: { message: "The provider rate limit was reached; this job was not resubmitted.", code: "provider_rate_limited", status: 429, retryable: true, charged: false },
        } });
      }
      return response(200, { job: completedJob({
        jobId: `pmj_${"b".repeat(24)}`,
        requestKey: body.requestKey,
        inputHash: body.inputHash,
      }) });
    };
    const mediaJobBroker = createPaidMediaJobBroker({
      stateDir,
      apiBase: "https://broker.invalid/api/media/jobs",
      apiFetch,
      sleepFn: async () => {},
    });
    const context = { sourceDir: stateDir, mediaJobBroker, artifactReader: async () => Buffer.from("RIFF-dialogue") };
    const baseKey = /^koya:cut-01:take:1:[a-f0-9]{64}$/u;

    // Run 1: provider rate limit → park. Exactly one paid submission.
    await assert.rejects(() => requestKoyaDialogueMediaJob(cutPlan, 0, context),
      (error) => error instanceof KoyaUsageLimitError && error.details.status === 429);
    assert.equal(posts.length, 1);
    assert.match(posts[0], baseKey);

    // Run 2 (operator re-runs while still limited): the refunded key is terminal on both
    // sides, so the take moves to a deterministic sibling key and parks again.
    await assert.rejects(() => requestKoyaDialogueMediaJob(cutPlan, 0, context),
      (error) => error instanceof KoyaUsageLimitError && error.details.status === 429);
    assert.equal(posts.length, 2);
    assert.equal(posts[1], `${posts[0]}:r1`);

    // Run 3 (quota restored): completes under the next key; earlier refunded keys are never re-posted.
    serverMode = "ready";
    const result = await requestKoyaDialogueMediaJob(cutPlan, 0, context);
    assert.equal(posts.length, 3);
    assert.equal(posts[2], `${posts[0]}:r2`);
    assert.equal(new Set(posts).size, 3);
    assert.equal(result.job.status, "completed");
    assert.equal(result.job.requestKey, posts[2]);
    assert.equal(result.mediaJobReceipt.requestKey, posts[2]);

    // Run 4: the completed take is attached from the journal — no fourth submission.
    const again = await requestKoyaDialogueMediaJob(cutPlan, 0, context);
    assert.equal(posts.length, 3);
    assert.equal(again.job.jobId, result.job.jobId);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("insufficient BuzzAssist credits (402) park the take instead of failing it", async () => {
  const error = Object.assign(new Error("paid media voice.dialogue start が HTTP 402 で失敗: (provider body omitted)"), { status: 402, charged: false });
  await assert.rejects(() => requestKoyaDialogueMediaJob(plan(), 0, {
    sourceDir: "/unused",
    mediaJobBroker: { start: async () => { throw error; } },
  }), (received) => received instanceof KoyaUsageLimitError && received.details.status === 402);
});

test("a transport-level 429 that the server never acknowledged keeps the base requestKey and never opens a second paid job", async () => {
  // C-1: HTTP 429 from an edge/WAF/proxy leaves a `local-…` failed journal with
  // charged=false (NonRetryablePaidApiError default). That is not proof the server
  // refunded anything — the app behind the limiter may already hold a dispatched
  // job under this key. Re-running must stay parked on the base key, not advance
  // to `:r1` and submit a fresh paid job.
  const stateDir = await mkdtemp(join(tmpdir(), "koya-transport-429-"));
  try {
    const cutPlan = plan();
    const posts = [];
    let serverMode = "edge-429";
    const apiFetch = async (url, options) => {
      assert.equal(options.method, "POST");
      posts.push(JSON.parse(options.body).requestKey);
      if (serverMode === "edge-429") {
        return response(429, { error: "rate limited" });
      }
      const body = JSON.parse(options.body);
      return response(200, { job: completedJob({
        jobId: `pmj_${"c".repeat(24)}`,
        requestKey: body.requestKey,
        inputHash: body.inputHash,
      }) });
    };
    const mediaJobBroker = createPaidMediaJobBroker({
      stateDir,
      apiBase: "https://broker.invalid/api/media/jobs",
      apiFetch,
      sleepFn: async () => {},
      maxAttempts: 2,
    });
    const context = { sourceDir: stateDir, mediaJobBroker, artifactReader: async () => Buffer.from("RIFF-dialogue") };

    // Run 1: the edge answers 429 on every attempt → park. Only the base key is ever posted.
    await assert.rejects(() => requestKoyaDialogueMediaJob(cutPlan, 0, context),
      (error) => error instanceof KoyaUsageLimitError && error.details.status === 429);
    assert.ok(posts.length >= 1);
    const baseKey = posts[0];
    assert.match(baseKey, /^koya:cut-01:take:1:[a-f0-9]{64}$/u);
    assert.equal(new Set(posts).size, 1);
    const journal = await mediaJobBroker.getLocal({ requestKey: baseKey });
    assert.equal(journal.status, "failed");
    assert.match(journal.jobId, /^local-/u);
    assert.equal(journal.error.charged, false);
    const postsAfterRun1 = posts.length;

    // Run 2: even with the edge healthy again, the unacknowledged key must not be
    // abandoned for `:r1`. The take attaches to the base journal (no HTTP) and stays parked.
    serverMode = "ready";
    await assert.rejects(() => requestKoyaDialogueMediaJob(cutPlan, 0, context),
      (error) => error instanceof KoyaUsageLimitError && error.details.status === 429);
    assert.equal(posts.length, postsAfterRun1, "no new submission after an unacknowledged transport 429");
    assert.ok(!posts.some((key) => key.includes(":r")), "requestKey must never advance past a local- journal");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("a transport-level 402 without server acknowledgement also stays on the base requestKey", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "koya-transport-402-"));
  try {
    const cutPlan = plan();
    const posts = [];
    const apiFetch = async (url, options) => {
      posts.push(JSON.parse(options.body).requestKey);
      return response(402, { error: "payment required" });
    };
    const mediaJobBroker = createPaidMediaJobBroker({
      stateDir,
      apiBase: "https://broker.invalid/api/media/jobs",
      apiFetch,
      sleepFn: async () => {},
    });
    const context = { sourceDir: stateDir, mediaJobBroker };
    await assert.rejects(() => requestKoyaDialogueMediaJob(cutPlan, 0, context),
      (error) => error instanceof KoyaUsageLimitError && error.details.status === 402);
    assert.equal(posts.length, 1);
    await assert.rejects(() => requestKoyaDialogueMediaJob(cutPlan, 0, context),
      (error) => error instanceof KoyaUsageLimitError && error.details.status === 402);
    assert.equal(posts.length, 1, "402 from transport is not a server refund receipt; do not resubmit");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
