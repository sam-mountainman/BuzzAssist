import assert from "node:assert/strict";
import test from "node:test";

import {
  alignmentFromBuzzAssist,
  generateBuzzAssistSpeech,
} from "../lib/buzzassistVoice.mjs";

function completedJob(overrides = {}) {
  return {
    jobId: "job-voice-1",
    providerJobId: "provider-voice-1",
    requestKey: "voice:test:1",
    inputHash: "a".repeat(64),
    identityHash: "b".repeat(64),
    kind: "voice.synthesis",
    provider: "buzzassist",
    adapterVersion: "buzzassist-voice-server-v1",
    model: "default",
    voiceId: "voice-1",
    status: "completed",
    reservation: { reservationId: "reservation-1", status: "committed" },
    usage: { seconds: 1.25, units: 4, cost: 0.04, currency: "USD", freeRegeneration: false },
    result: {
      artifact: { url: "https://artifacts.invalid/private.wav", sha256: "c".repeat(64), mimeType: "audio/wav", bytes: 64 },
      durationSeconds: 1.25,
      requestId: "request-1",
      alignment: [
        { char: "テ", start: 0, end: 0.5 },
        { char: "ス", start: 0.5, end: 1 },
      ],
      data: { quota: { remainingMin: 8.5 } },
    },
    attempts: { total: 1, retries: [] },
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:01.000Z",
    ...overrides,
  };
}

test("alignmentFromBuzzAssist preserves the legacy ElevenLabs-shaped contract", () => {
  assert.deepEqual(alignmentFromBuzzAssist([
    { char: "あ", start: -1, end: 0.4 },
    { char: "", start: 0.4, end: 0.5 },
  ]), {
    characters: ["あ"],
    characterStartTimesSeconds: [0],
    characterEndTimesSeconds: [0.4],
  });
});

test("generateBuzzAssistSpeech submits a typed media job and returns a receipt-safe result", async () => {
  let submitted;
  let startOptions;
  let artifactReads = 0;
  const job = completedJob();
  const mediaJobBroker = {
    start: async (spec, options) => {
      submitted = spec;
      startOptions = options;
      return job;
    },
    waitFor: async () => { throw new Error("completed jobs must not be polled"); },
  };

  const result = await generateBuzzAssistSpeech({
    text: "テスト",
    voiceId: "voice-1",
    format: "wav",
    speed: 1.1,
    requestKey: "voice:test:1",
    mediaJobBroker,
    artifactReader: async (received) => {
      artifactReads += 1;
      assert.equal(received, job);
      return Buffer.from("RIFF-test");
    },
  });

  assert.equal(submitted.kind, "voice.synthesis");
  assert.equal(submitted.provider, "buzzassist");
  assert.equal(submitted.adapterVersion, "buzzassist-voice-server-v1");
  assert.equal(submitted.voiceId, "voice-1");
  assert.equal(submitted.requestKey, "voice:test:1");
  assert.equal(submitted.input.text, "テスト");
  assert.equal(submitted.output.format, "wav");
  assert.equal(submitted.reservation.unit, "seconds");
  assert.equal(startOptions.timeoutMs, 300_000);
  assert.equal(artifactReads, 1);
  assert.equal(result.mediaJobId, "job-voice-1");
  assert.equal(result.providerJobId, "provider-voice-1");
  assert.equal(result.chargedSeconds, 1.25);
  assert.equal(result.durationSeconds, 1.25);
  assert.deepEqual(result.alignment.characters, ["テ", "ス"]);
  assert.equal(result.mediaJobReceipt.artifact.url, undefined);
  assert.equal(result.mediaJobReceipt.adapterVersion, "buzzassist-voice-server-v1");
  assert.equal(JSON.stringify(result.mediaJobReceipt).includes("テスト"), false);
});

test("generateBuzzAssistSpeech waits by requestKey and fails closed on recovery-required", async () => {
  let waitedRef;
  let artifactReads = 0;
  const queued = completedJob({ status: "queued", result: null });
  const recovery = completedJob({
    status: "recovery-required",
    result: null,
    error: { message: "既存の provider job を照会してください" },
  });
  const mediaJobBroker = {
    start: async () => queued,
    waitFor: async (ref) => {
      waitedRef = ref;
      return recovery;
    },
  };

  await assert.rejects(() => generateBuzzAssistSpeech({
    text: "失敗",
    voiceId: "voice-1",
    mediaJobBroker,
    artifactReader: async () => { artifactReads += 1; return Buffer.alloc(1); },
  }), /provider job/u);
  assert.deepEqual(waitedRef, { requestKey: queued.requestKey });
  assert.equal(artifactReads, 0);
});
