import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createPaidMediaJobBroker,
  normalizePaidMediaJobSpec,
  paidMediaJobReceiptSummary,
  paidMediaRequestIdentity,
  probePaidMediaJobAdapter,
  readPaidMediaJobArtifact,
} from "../lib/paidMediaJobBroker.mjs";

const noSleep = async () => {};
const wav = () => {
  const bytes = Buffer.alloc(64);
  bytes.write("RIFF", 0, "ascii");
  return bytes;
};
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function response(status, payload, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] || null },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

const spec = (overrides = {}) => ({
  kind: "voice.synthesis",
  provider: "fish-audio",
  model: "s2-pro",
  adapterVersion: "fish-audio-server-v3",
  voiceId: "approved-voice-A",
  input: { text: "雨の日の話です。", speed: 1 },
  output: { format: "wav", sampleRate: 44_100 },
  reservation: { unit: "seconds", estimatedSeconds: 4.2, estimatedCost: 0.08, currency: "USD" },
  ...overrides,
});

test("paid media identity is stable, input-bound, and rejects client secrets", () => {
  const left = paidMediaRequestIdentity(spec());
  const reordered = paidMediaRequestIdentity({
    ...spec(),
    input: { speed: 1, text: "雨の日の話です。" },
  });
  assert.deepEqual(left, reordered);
  assert.notEqual(left.requestKey, paidMediaRequestIdentity(spec({ input: { text: "別の本文", speed: 1 } })).requestKey);
  assert.throws(
    () => normalizePaidMediaJobSpec(spec({ input: { text: "x", apiKey: "provider-secret-value" } })),
    /Provider secrets must stay on the BuzzAssist server/u,
  );
  assert.throws(
    () => normalizePaidMediaJobSpec(spec({ input: { text: "x", token: "provider-secret-value" } })),
    /Provider secrets must stay on the BuzzAssist server/u,
  );
  assert.throws(
    () => normalizePaidMediaJobSpec(spec({ input: { text: "x", clientSecret: "provider-secret-value" } })),
    /Provider secrets must stay on the BuzzAssist server/u,
  );
});

test("adapter capability probe is read-only, identity-bound, and fail-closed", async () => {
  const calls = [];
  const ready = await probePaidMediaJobAdapter({
    kind: "voice.synthesis",
    provider: "fish-audio",
    model: "s2-pro",
    adapterVersion: "fish-audio-tts-server-v1",
  }, {
    stateDir: join(tmpdir(), "unused-paid-media-probe-state"),
    apiBase: "https://broker.invalid/api/media/jobs",
    apiFetch: async (url, options) => {
      calls.push({ url: String(url), method: options.method });
      return response(200, {
        status: "ready",
        adapter: {
          kind: "voice.synthesis",
          provider: "fish-audio",
          model: "s2-pro",
          adapterVersion: "fish-audio-tts-server-v1",
          available: true,
        },
        serverVersion: "fixture-server-v1",
      });
    },
  });
  assert.equal(ready.ok, true);
  assert.equal(ready.status, "ready");
  assert.equal(ready.serverVersion, "fixture-server-v1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.match(calls[0].url, /\/capabilities\?/u);

  const mismatched = await probePaidMediaJobAdapter({
    kind: "voice.synthesis",
    provider: "fish-audio",
    model: "s2-pro",
    adapterVersion: "fish-audio-tts-server-v1",
  }, {
    stateDir: join(tmpdir(), "unused-paid-media-probe-state"),
    apiFetch: async () => response(200, {
      status: "ready",
      adapter: {
        kind: "voice.synthesis",
        provider: "fish-audio",
        model: "different-model",
        adapterVersion: "fish-audio-tts-server-v1",
        available: true,
      },
    }),
  });
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.status, "identity-mismatch");

  const unreachable = await probePaidMediaJobAdapter({
    kind: "image.generation",
    provider: "buzzassist",
    model: "image-model-v1",
    adapterVersion: "image-adapter-v1",
  }, {
    stateDir: join(tmpdir(), "unused-paid-media-probe-state"),
    apiFetch: async () => { throw new Error("Authorization: Bearer server-secret-123456"); },
  });
  assert.equal(unreachable.ok, false);
  assert.equal(unreachable.status, "unreachable");
  assert.equal(unreachable.detail.includes("server-secret"), false);
});

test("start journals reservation before submission, retries 5xx, and emits a receipt-safe summary", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "paid-media-start-"));
  try {
    const identity = paidMediaRequestIdentity(spec());
    let calls = 0;
    const retryNotices = [];
    let broker;
    broker = createPaidMediaJobBroker({
      stateDir,
      sleepFn: noSleep,
      onRetry: (event) => retryNotices.push(event),
      apiBase: "https://broker.invalid/api/media/jobs",
      apiFetch: async (_url, options) => {
        calls += 1;
        if (options.method === "GET") {
          return response(200, { job: { jobId: "job-1", status: "completed" } });
        }
        const reserved = await broker.getLocal({ requestKey: identity.requestKey });
        assert.equal(reserved.status, "reserved", "reservation intent must be durable before network I/O");
        assert.equal(reserved.adapterVersion, "fish-audio-server-v3");
        assert.equal(reserved.reservation.estimatedSeconds, 4.2);
        assert.equal(options.headers["idempotency-key"], identity.requestKey);
        if (calls === 1) return response(503, { error: "雨の日の話です。 Authorization: Bearer provider-secret-123456" });
        return response(201, {
          job: {
            jobId: "job-1",
            providerJobId: "fish-task-9",
            status: "completed",
            reservation: { id: "reserve-1", status: "captured", estimatedSeconds: 4.2 },
            usage: { seconds: 4.1, cost: 0.077, currency: "USD", freeRegeneration: false },
            result: {
              artifact: { url: "https://artifact.invalid/job-1.wav", sha256: "a".repeat(64), mimeType: "audio/wav", bytes: 123 },
              durationSeconds: 4.1,
              data: { upstreamNote: "Authorization: Bearer server-secret-123456" },
            },
          },
        });
      },
    });
    const job = await broker.start(spec());
    assert.equal(calls, 2);
    assert.equal(JSON.stringify(retryNotices).includes("雨の日"), false);
    assert.equal(JSON.stringify(retryNotices).includes("provider-secret"), false);
    assert.equal(job.status, "completed");
    assert.equal(job.providerJobId, "fish-task-9");
    assert.equal(job.result.data.upstreamNote.includes("server-secret"), false);
    assert.equal(job.reservation.reservationId, "reserve-1");
    const receipt = paidMediaJobReceiptSummary(job);
    assert.equal(receipt.usage.seconds, 4.1);
    assert.equal(receipt.adapterVersion, "fish-audio-server-v3");
    assert.equal(receipt.identityHash, identity.identityHash);
    assert.equal(receipt.usage.cost, 0.077);
    assert.equal(receipt.reservation.estimatedCost, 0.08);
    assert.equal(receipt.reservation.unit, "seconds");
    assert.match(receipt.reservation.requestedAt, /^\d{4}-\d{2}-\d{2}T/u);
    assert.equal(receipt.attempts.retries[0].status, 503);
    assert.equal(receipt.artifact.sha256, "a".repeat(64));
    const serialized = JSON.stringify(receipt);
    assert.equal(serialized.includes("雨の日"), false, "source text must not enter RunReceipt");
    assert.equal(serialized.includes("artifact.invalid"), false, "signed artifact URL is not receipt-safe");
    const refreshed = await broker.get({ requestKey: identity.requestKey });
    assert.equal(calls, 3);
    assert.equal(refreshed.usage.cost, 0.077, "partial status responses must not erase durable usage");
    assert.equal(refreshed.reservation.estimatedCost, 0.08);
    assert.equal(refreshed.result.artifact.sha256, "a".repeat(64));
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("apiBase を渡さない broker は BUZZASSIST_MEDIA_JOB_API_BASE（doctor が probe する住所）へ送り、明示の apiBase はそれに勝つ", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "paid-media-env-base-"));
  const saved = process.env.BUZZASSIST_MEDIA_JOB_API_BASE;
  process.env.BUZZASSIST_MEDIA_JOB_API_BASE = "https://media-from-env.invalid/v1/media/jobs";
  try {
    const urls = [];
    const refuse = async (url) => {
      urls.push(String(url));
      return response(400, { error: { code: "invalid_request", message: "fixture" } });
    };
    await assert.rejects(() => createPaidMediaJobBroker({ stateDir: join(stateDir, "env"), sleepFn: noSleep, apiFetch: refuse }).start(spec()));
    assert.ok(urls[0].startsWith("https://media-from-env.invalid/v1/media/jobs"), urls[0]);
    await assert.rejects(() => createPaidMediaJobBroker({
      stateDir: join(stateDir, "explicit"),
      sleepFn: noSleep,
      apiFetch: refuse,
      apiBase: "https://explicit.invalid/api/media/jobs",
    }).start(spec()));
    assert.ok(urls[1].startsWith("https://explicit.invalid/api/media/jobs"), urls[1]);
  } finally {
    if (saved === undefined) delete process.env.BUZZASSIST_MEDIA_JOB_API_BASE;
    else process.env.BUZZASSIST_MEDIA_JOB_API_BASE = saved;
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("a 2xx decode failure is attempted once, records provider id, and requires recovery", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "paid-media-decode-"));
  try {
    let calls = 0;
    const broker = createPaidMediaJobBroker({
      stateDir,
      sleepFn: noSleep,
      apiFetch: async () => {
        calls += 1;
        return {
          ok: true,
          status: 202,
          headers: { get: (name) => ({
            "x-buzzassist-job-id": "job-decode",
            "x-provider-job-id": "provider-decode",
            "x-reservation-id": "reserve-decode",
          })[name] || null },
          json: async () => { throw new Error("socket closed while decoding JSON"); },
          text: async () => "",
        };
      },
    });
    const identity = paidMediaRequestIdentity(spec());
    await assert.rejects(() => broker.start(spec()), /could not be decoded/u);
    assert.equal(calls, 1, "2xx body/decode failure must never resubmit generation");
    const local = await broker.getLocal({ requestKey: identity.requestKey });
    assert.equal(local.status, "recovery-required");
    assert.equal(local.jobId, "job-decode");
    assert.equal(local.providerJobId, "provider-decode");
    assert.equal(local.reservation.reservationId, "reserve-decode");
    assert.equal(local.attempts.total, 1);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("an ambiguous 504 is never retried and remains recoverable", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "paid-media-ambiguous-"));
  try {
    let calls = 0;
    const broker = createPaidMediaJobBroker({
      stateDir,
      sleepFn: noSleep,
      apiFetch: async () => {
        calls += 1;
        return response(504, { error: "upstream timeout after acceptance is unknown" });
      },
    });
    const identity = paidMediaRequestIdentity(spec());
    await assert.rejects(() => broker.start(spec()), /二重に払う/u);
    assert.equal(calls, 1);
    const local = await broker.getLocal({ requestKey: identity.requestKey });
    assert.equal(local.status, "recovery-required");
    assert.equal(local.error.charged, null);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("an aborted submission is never blindly retried and remains recoverable", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "paid-media-aborted-"));
  try {
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    const broker = createPaidMediaJobBroker({
      stateDir,
      sleepFn: noSleep,
      apiFetch: async () => {
        calls += 1;
        throw Object.assign(new Error("operator cancelled"), { name: "AbortError" });
      },
    });
    const identity = paidMediaRequestIdentity(spec());
    await assert.rejects(() => broker.start(spec(), { signal: controller.signal }), /二重に払う/u);
    assert.equal(calls, 1);
    const local = await broker.getLocal({ requestKey: identity.requestKey });
    assert.equal(local.status, "recovery-required");
    assert.equal(local.error.charged, null);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("recover/get/cancel/resume use the durable job identity and never create a second job", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "paid-media-controls-"));
  try {
    const calls = [];
    const broker = createPaidMediaJobBroker({
      stateDir,
      sleepFn: noSleep,
      apiBase: "https://broker.invalid/api/media/jobs",
      apiFetch: async (url, options) => {
        calls.push({ url: String(url), method: options.method, body: options.body });
        if (String(url).endsWith("/recover")) {
          return response(200, { job: { jobId: "job-control", status: "queued", providerJobId: "p-control" } });
        }
        if (String(url).endsWith("/cancel")) return response(200, { job: { jobId: "job-control", status: "cancelled" } });
        if (String(url).endsWith("/resume")) return response(200, { job: { jobId: "job-control", status: "running" } });
        if (options.method === "GET") return response(200, { job: { jobId: "job-control", status: "running" } });
        return {
          ok: true,
          status: 202,
          headers: { get: (name) => name === "x-buzzassist-job-id" ? "job-control" : null },
          json: async () => { throw new Error("lost acceptance body"); },
          text: async () => "",
        };
      },
    });
    const identity = paidMediaRequestIdentity(spec());
    await assert.rejects(() => broker.start(spec()));
    await broker.recover({ requestKey: identity.requestKey });
    await broker.get({ requestKey: identity.requestKey });
    await broker.cancel({ requestKey: identity.requestKey });
    await broker.resume({ requestKey: identity.requestKey });
    assert.equal(calls.filter((entry) => entry.method === "POST" && entry.url === "https://broker.invalid/api/media/jobs").length, 1);
    assert.ok(calls.some((entry) => entry.url.endsWith("/recover")));
    assert.ok(calls.some((entry) => entry.url.endsWith("/cancel")));
    assert.ok(calls.some((entry) => entry.url.endsWith("/resume")));
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("concurrent and restarted starts with one requestKey submit only once", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "paid-media-concurrency-"));
  try {
    let calls = 0;
    const apiFetch = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return response(201, { job: { jobId: "job-once", status: "completed", result: {} } });
    };
    const brokerA = createPaidMediaJobBroker({ stateDir, apiFetch, lockPollMs: 2, sleepFn: (ms) => new Promise((r) => setTimeout(r, ms)) });
    const brokerB = createPaidMediaJobBroker({ stateDir, apiFetch, lockPollMs: 2, sleepFn: (ms) => new Promise((r) => setTimeout(r, ms)) });
    const [left, right] = await Promise.all([brokerA.start(spec()), brokerB.start(spec())]);
    assert.equal(calls, 1);
    assert.equal(left.jobId, "job-once");
    assert.equal(right.jobId, "job-once");
    const restarted = createPaidMediaJobBroker({ stateDir, apiFetch });
    assert.equal((await restarted.start(spec())).jobId, "job-once");
    assert.equal(calls, 1, "restart must reuse the durable idempotency record");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("restart dispatches a reservation journaled before the first HTTP request exactly once", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "paid-media-before-dispatch-crash-"));
  try {
    const normalized = normalizePaidMediaJobSpec(spec());
    const jobsDir = join(stateDir, "jobs");
    await mkdir(jobsDir, { recursive: true });
    const timestamp = "2026-09-01T00:00:00.000Z";
    await writeFile(join(jobsDir, `${sha256(normalized.requestKey)}.json`), `${JSON.stringify({
      version: "buzzassist-paid-media-job-v1",
      jobId: `local-${normalized.identityHash.slice(0, 24)}`,
      requestKey: normalized.requestKey,
      inputHash: normalized.inputHash,
      identityHash: normalized.identityHash,
      kind: normalized.kind,
      provider: normalized.provider,
      adapterVersion: normalized.adapterVersion,
      providerJobId: "",
      model: normalized.model,
      voiceId: normalized.voiceId,
      status: "reserved",
      reservation: { ...normalized.reservation, reservationId: "", requestedAt: timestamp },
      usage: { seconds: null, units: null, cost: null, currency: "", freeRegeneration: false },
      result: null,
      attempts: { total: 0, retries: [] },
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    })}\n`);

    let calls = 0;
    const broker = createPaidMediaJobBroker({
      stateDir,
      apiBase: "https://broker.invalid/api/media/jobs",
      apiFetch: async (_url, options) => {
        calls += 1;
        assert.equal(options.method, "POST");
        assert.equal(options.headers["idempotency-key"], normalized.requestKey);
        return response(200, {
          job: {
            jobId: "job-after-local-crash",
            providerJobId: "provider-after-local-crash",
            requestKey: normalized.requestKey,
            inputHash: normalized.inputHash,
            identityHash: normalized.identityHash,
            status: "completed",
          },
        });
      },
    });

    const recovered = await broker.start(spec());
    assert.equal(recovered.status, "completed");
    assert.equal(recovered.jobId, "job-after-local-crash");
    assert.equal(calls, 1);
    assert.equal((await broker.start(spec())).jobId, "job-after-local-crash");
    assert.equal(calls, 1, "a remote/accepted journal must remain attach-only");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("a live owner lock is not stolen merely because its heartbeat is old", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "paid-media-live-lock-"));
  try {
    const identity = paidMediaRequestIdentity(spec());
    const digest = sha256(identity.requestKey);
    const lock = join(stateDir, "locks", digest);
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, "owner.json"), `${JSON.stringify({
      pid: process.pid,
      heartbeatAt: "2000-01-01T00:00:00.000Z",
    })}\n`);
    const broker = createPaidMediaJobBroker({
      stateDir,
      lockTimeoutMs: 20,
      staleLockMs: 1,
      lockPollMs: 2,
      sleepFn: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      apiFetch: async () => { throw new Error("must not submit"); },
    });
    await assert.rejects(() => broker.start(spec()), /Timed out waiting/u);
    assert.ok(await readFile(join(lock, "owner.json"), "utf8"), "live lock must remain owned");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("artifact decode/hash failures never resubmit the paid job", async () => {
  const bytes = wav();
  const complete = {
    status: "completed",
    result: { artifact: {
      url: "https://artifact.invalid/a.wav",
      sha256: sha256(bytes),
      mimeType: "audio/wav",
      bytes: bytes.length,
    } },
  };
  let downloads = 0;
  let requestOptions;
  assert.deepEqual(await readPaidMediaJobArtifact(complete, {
    allowedOrigins: ["https://artifact.invalid"],
    fetchImpl: async (_url, options) => {
      downloads += 1;
      requestOptions = options;
      return {
        ok: true,
        status: 200,
        url: "https://artifact.invalid/a.wav",
        headers: { "content-length": String(bytes.length), "content-type": "audio/wav; charset=binary" },
        arrayBuffer: async () => bytes,
      };
    },
  }), bytes);
  assert.equal(downloads, 1);
  assert.equal(requestOptions.redirect, "error");

  downloads = 0;
  await assert.rejects(() => readPaidMediaJobArtifact(complete, {
    allowedOrigins: ["https://artifact.invalid"],
    fetchImpl: async () => {
      downloads += 1;
      return {
        ok: true,
        status: 200,
        headers: { "content-length": String(bytes.length), "content-type": "audio/wav" },
        arrayBuffer: async () => { throw new Error("decode failed"); },
      };
    },
  }), /2xx/u);
  assert.equal(downloads, 1);
});

test("artifact download rejects SSRF, redirects, missing receipt identity, MIME and byte-budget mismatches before reuse", async () => {
  const bytes = wav();
  const artifact = {
    url: "https://storage.example/media.wav",
    sha256: sha256(bytes),
    mimeType: "audio/wav",
    bytes: bytes.length,
  };
  const job = { status: "completed", result: { artifact } };
  let fetches = 0;
  const response = (overrides = {}) => ({
    ok: true,
    status: 200,
    url: artifact.url,
    headers: { "content-length": String(bytes.length), "content-type": "audio/wav" },
    arrayBuffer: async () => bytes,
    ...overrides,
  });

  await assert.rejects(() => readPaidMediaJobArtifact(job, {
    fetchImpl: async () => { fetches += 1; return response(); },
  }), /origin is not allowlisted/u);
  assert.equal(fetches, 0, "origin validation must happen before network I/O");

  for (const [label, changed, expected] of [
    ["missing-sha", { ...artifact, sha256: "" }, /requires a lowercase SHA-256/u],
    ["insecure-origin", { ...artifact, url: "http://storage.example/media.wav" }, /must use HTTPS/u],
    ["oversized-declaration", { ...artifact, bytes: 1000 }, /byte count/u],
    ["missing-mime", { ...artifact, mimeType: "" }, /MIME type/u],
  ]) {
    await assert.rejects(
      () => readPaidMediaJobArtifact({ status: "completed", result: { artifact: changed } }, {
        allowedOrigins: [new URL(changed.url).origin],
        maxBytes: bytes.length,
        fetchImpl: async () => { throw new Error("must not fetch"); },
      }),
      expected,
      label,
    );
  }

  await assert.rejects(() => readPaidMediaJobArtifact(job, {
    allowedOrigins: ["https://storage.example"],
    fetchImpl: async () => response({ url: "https://redirected.example/media.wav" }),
  }), /crossed an origin boundary/u);
  await assert.rejects(() => readPaidMediaJobArtifact(job, {
    allowedOrigins: ["https://storage.example"],
    fetchImpl: async () => response({ headers: { "content-length": String(bytes.length), "content-type": "text/html" } }),
  }), /Content-Type/u);
  await assert.rejects(() => readPaidMediaJobArtifact(job, {
    allowedOrigins: ["https://storage.example"],
    fetchImpl: async () => response({ headers: { "content-length": String(bytes.length + 1), "content-type": "audio/wav" } }),
  }), /Content-Length/u);
  await assert.rejects(() => readPaidMediaJobArtifact(job, {
    allowedOrigins: ["https://storage.example"],
    fetchImpl: async () => response({ headers: { "content-length": "", "content-type": "audio/wav" }, arrayBuffer: async () => Buffer.concat([bytes, Buffer.from([0])]) }),
  }), /2xx/u);
});

test("a 2xx envelope carrying a terminal failed job keeps the server error detail for park decisions", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "paid-media-failed-envelope-"));
  try {
    let polled = 0;
    const failedEnvelope = (requestKey, inputHash) => response(200, { job: {
      jobId: "pmj_" + "c".repeat(24),
      requestKey,
      inputHash,
      status: "failed",
      reservation: { reservationId: "pmr_refunded", status: "refunded" },
      error: { message: "The provider rate limit was reached; this job was not resubmitted.", code: "provider_rate_limited", status: 429, retryable: true, charged: false },
    } });
    const broker = createPaidMediaJobBroker({
      stateDir,
      sleepFn: noSleep,
      apiBase: "https://broker.invalid/api/media/jobs",
      apiFetch: async (url, options) => {
        if (options.method === "GET") { polled += 1; return failedEnvelope(); }
        const body = JSON.parse(options.body);
        return failedEnvelope(body.requestKey, body.inputHash);
      },
    });
    const started = await broker.start(spec());
    assert.equal(started.status, "failed");
    assert.equal(started.error?.status, 429);
    assert.equal(started.error?.charged, false);
    assert.equal(started.error?.code, "provider_rate_limited");
    assert.equal(started.reservation.status, "refunded");
    const fetched = await broker.get({ requestKey: started.requestKey });
    assert.equal(polled, 1);
    assert.equal(fetched.error?.status, 429, "get must not blank the terminal error either");
    const journaled = JSON.parse(await readFile(join(stateDir, "jobs", `${sha256(started.requestKey)}.json`), "utf8"));
    assert.equal(journaled.error?.status, 429);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

