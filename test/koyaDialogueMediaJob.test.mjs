import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  // job under this key. Re-running must stay on the base key, not advance to `:r1`
  // and submit a fresh paid job. The re-run re-sends the *same* requestKey
  // (review q4-paid-media §3-2): the server is idempotent on it, so a job it already
  // holds comes back instead of a second charge.
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

    // Run 2: with the edge healthy again, the unacknowledged key is not abandoned for
    // `:r1`; the base key is re-sent once and the server's job for it is attached.
    serverMode = "ready";
    const result = await requestKoyaDialogueMediaJob(cutPlan, 0, context);
    assert.equal(posts.length, postsAfterRun1 + 1, "exactly one same-key re-send after an unacknowledged transport 429");
    assert.equal(new Set(posts).size, 1, "only the base requestKey is ever posted");
    assert.ok(!posts.some((key) => key.includes(":r")), "requestKey must never advance past a local- journal");
    assert.equal(result.job.status, "completed");
    assert.equal(result.job.requestKey, baseKey);
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
    // 402 from transport is not a server refund receipt, so the key never advances to `:r1`.
    // The re-run re-sends the same requestKey (idempotent on the server) and parks again.
    assert.equal(posts.length, 2);
    assert.equal(new Set(posts).size, 1, "a transport 402 is re-sent only under the same requestKey");
    assert.ok(!posts.some((key) => key.includes(":r")));
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

// review q4-paid-media §3-1 / §3-2 ------------------------------------------------

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const journalPath = (stateDir, requestKey) => join(stateDir, "jobs", `${sha256(requestKey)}.json`);

async function withoutArtifactOriginEnv(callback) {
  const saved = process.env.BUZZASSIST_MEDIA_ARTIFACT_ORIGINS;
  delete process.env.BUZZASSIST_MEDIA_ARTIFACT_ORIGINS;
  try {
    return await callback();
  } finally {
    if (saved === undefined) delete process.env.BUZZASSIST_MEDIA_ARTIFACT_ORIGINS;
    else process.env.BUZZASSIST_MEDIA_ARTIFACT_ORIGINS = saved;
  }
}

test("Koya dialogue downloads the official broker's Convex storage artifact without BUZZASSIST_MEDIA_ARTIFACT_ORIGINS, and a custom broker still needs it", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "koya-convex-artifact-"));
  try {
    await withoutArtifactOriginEnv(async () => {
      const audio = Buffer.alloc(64);
      audio.write("RIFF", 0, "ascii");
      const artifactUrl = "https://happy-otter-123.convex.cloud/api/storage/0f5c2d4e-1a2b-4c3d-8e9f-001122334455";
      const downloads = [];
      const artifactFetch = async (url, options) => {
        downloads.push(url);
        assert.equal(options.redirect, "error");
        return {
          ok: true,
          status: 200,
          url,
          headers: { "content-length": String(audio.length), "content-type": "audio/wav" },
          arrayBuffer: async () => audio,
        };
      };
      const apiFetch = async (_url, options) => {
        const body = JSON.parse(options.body);
        return response(200, { job: completedJob({
          jobId: `pmj_${"d".repeat(24)}`,
          requestKey: body.requestKey,
          inputHash: body.inputHash,
          result: {
            ...completedJob().result,
            artifact: { url: artifactUrl, sha256: sha256(audio), mimeType: "audio/wav", bytes: audio.length },
          },
        }) });
      };
      const official = createPaidMediaJobBroker({
        stateDir: join(stateDir, "official"),
        apiBase: "https://buzzassist.ai/api/media/jobs",
        apiFetch,
        sleepFn: async () => {},
        machineSlots: false,
      });
      const result = await requestKoyaDialogueMediaJob(plan(), 0, {
        sourceDir: stateDir,
        mediaJobBroker: official,
        artifactFetch,
      });
      assert.deepEqual(result.audioBuffer, audio);
      assert.deepEqual(downloads, [artifactUrl]);

      const custom = createPaidMediaJobBroker({
        stateDir: join(stateDir, "custom"),
        apiBase: "https://broker.invalid/api/media/jobs",
        apiFetch,
        sleepFn: async () => {},
        machineSlots: false,
      });
      await assert.rejects(() => requestKoyaDialogueMediaJob(plan(), 0, {
        sourceDir: stateDir,
        mediaJobBroker: custom,
        artifactFetch,
      }), /origin is not allowlisted/u);
      assert.equal(downloads.length, 1, "a custom broker's Convex URL is refused before any download");
    });
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("a pre-deployment 404 that never reached the server is re-sent under the same requestKey once the server is reachable", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "koya-local-404-"));
  try {
    const cutPlan = plan();
    const posts = [];
    let serverMode = "not-deployed";
    const apiFetch = async (_url, options) => {
      assert.equal(options.method, "POST");
      const body = JSON.parse(options.body);
      posts.push(body.requestKey);
      if (serverMode === "not-deployed") return response(404, { error: "not found" });
      return response(200, { job: completedJob({
        jobId: `pmj_${"e".repeat(24)}`,
        requestKey: body.requestKey,
        inputHash: body.inputHash,
      }) });
    };
    const mediaJobBroker = createPaidMediaJobBroker({
      stateDir,
      apiBase: "https://broker.invalid/api/media/jobs",
      apiFetch,
      sleepFn: async () => {},
      machineSlots: false,
    });
    const context = { sourceDir: stateDir, mediaJobBroker, artifactReader: async () => Buffer.from("RIFF-dialogue") };

    // Run 1: the route is not deployed yet → 404, never accepted, not charged.
    await assert.rejects(() => requestKoyaDialogueMediaJob(cutPlan, 0, context), /HTTP 404/u);
    assert.equal(posts.length, 1);
    const baseKey = posts[0];
    const journal = await mediaJobBroker.getLocal({ requestKey: baseKey });
    assert.equal(journal.status, "failed");
    assert.match(journal.jobId, /^local-/u);
    assert.equal(journal.error.charged, false);
    assert.equal(journal.error.status, 404);

    // Run 2 (server deployed): the same take is re-sent under the same key and completes.
    serverMode = "ready";
    const result = await requestKoyaDialogueMediaJob(cutPlan, 0, context);
    assert.deepEqual(posts, [baseKey, baseKey]);
    assert.equal(result.job.status, "completed");
    assert.equal(result.job.jobId, `pmj_${"e".repeat(24)}`);

    // Run 3: the completed take attaches from the journal; nothing is posted again.
    await requestKoyaDialogueMediaJob(cutPlan, 0, context);
    assert.equal(posts.length, 2);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("a charged:null failure and a server-accepted (pmj_) failure are never re-sent by the uncharged-local replay", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "koya-no-replay-"));
  try {
    const cutPlan = plan();
    const posts = [];
    let serverMode = "not-deployed";
    const apiFetch = async (_url, options) => {
      assert.equal(options.method, "POST", "a settled failure must not be polled or recovered here");
      const body = JSON.parse(options.body);
      posts.push(body.requestKey);
      if (serverMode === "not-deployed") return response(404, { error: "not found" });
      if (serverMode === "accepted-failed") {
        return response(200, { job: {
          jobId: `pmj_${"f".repeat(24)}`,
          requestKey: body.requestKey,
          inputHash: body.inputHash,
          status: "failed",
          reservation: { reservationId: "pmr_released", status: "released" },
          error: { message: "The adapter rejected the dialogue input.", code: "invalid_request", status: 400, retryable: false, charged: false },
        } });
      }
      return response(200, { job: completedJob({ jobId: `pmj_${"9".repeat(24)}`, requestKey: body.requestKey, inputHash: body.inputHash }) });
    };
    const mediaJobBroker = createPaidMediaJobBroker({
      stateDir,
      apiBase: "https://broker.invalid/api/media/jobs",
      apiFetch,
      sleepFn: async () => {},
      machineSlots: false,
    });
    const context = { sourceDir: stateDir, mediaJobBroker, artifactReader: async () => Buffer.from("RIFF-dialogue") };

    // charged:null — the journal no longer proves the provider was never charged.
    await assert.rejects(() => requestKoyaDialogueMediaJob(cutPlan, 0, context), /HTTP 404/u);
    const baseKey = posts[0];
    const path = journalPath(stateDir, baseKey);
    const unknown = JSON.parse(await readFile(path, "utf8"));
    unknown.error.charged = null;
    await writeFile(path, `${JSON.stringify(unknown, null, 2)}\n`);
    serverMode = "ready";
    await assert.rejects(() => requestKoyaDialogueMediaJob(cutPlan, 0, context));
    assert.equal(posts.length, 1, "a charged:null failure is not re-sent");

    // pmj_ — the server accepted the key and fixed it as failed; the same key is not re-sent.
    await rm(path, { force: true });
    serverMode = "accepted-failed";
    await assert.rejects(() => requestKoyaDialogueMediaJob(cutPlan, 0, context), /rejected the dialogue input/u);
    assert.equal(posts.length, 2);
    const accepted = await mediaJobBroker.getLocal({ requestKey: baseKey });
    assert.equal(accepted.jobId, `pmj_${"f".repeat(24)}`);
    assert.equal(accepted.error.charged, false);
    serverMode = "ready";
    await assert.rejects(() => requestKoyaDialogueMediaJob(cutPlan, 0, context), /rejected the dialogue input/u);
    assert.equal(posts.length, 2, "a server-accepted failure is not re-sent under the same key");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
