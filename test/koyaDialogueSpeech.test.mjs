import assert from "node:assert/strict";
import { test } from "node:test";

import {
  alignmentSpeechSpan,
  envelopeDistance,
  applyKoyaSpeechPronunciations,
  buildKoyaDialogueRequest,
  koyaPerformanceTag,
  prepareKoyaDialogueCut,
  quietestBoundarySeconds,
  spectralEnvelope,
  scoreKoyaDialogueTake,
  selectKoyaDialogueTake,
} from "../lib/koyaDialogueSpeech.mjs";

const manifest = {
  utterances: [
    { id: "cut-01-u01", text: "今日はいい日だ。", speechText: "今日は、いい日だ。", speakerId: "lead", voiceId: "voice-a", preset: "narration" },
    { id: "cut-01-u02", text: "絶対に守る！", speakerId: "lead", voiceId: "voice-a", preset: "dialogue" },
  ],
};
const cut = { id: "cut-01", utteranceIds: ["cut-01-u01", "cut-01-u02"] };

test("generic Koya dialogue planning keeps narration plain and tags dialogue", () => {
  const plan = prepareKoyaDialogueCut(manifest, cut, { takeCount: 3 });
  assert.equal(plan.takeCount, 3);
  assert.equal(plan.inputs[0].performancePrompt, "");
  assert.equal(plan.inputs[0].providerText, "今日は、いい日だ。");
  assert.equal(plan.inputs[1].performancePrompt, "[angry]");
  assert.match(plan.inputs[1].providerText, /^\[angry\]/u);
  const request = buildKoyaDialogueRequest(plan, 1);
  assert.equal(request.model_id, "eleven_v3");
  assert.equal(request.inputs.length, 2);
  assert.equal(request.seed, 440011);
});

test("performance tags are deterministic and do not tag narration", () => {
  assert.equal(koyaPerformanceTag({ preset: "narration", text: "静かな朝だった。" }), "");
  assert.equal(koyaPerformanceTag({ preset: "dialogue", text: "ありがとう、嬉しい。" }), "[warm]");
  assert.equal(koyaPerformanceTag({ preset: "dialogue", text: "絶対に負けない。" }), "[determined]");
});

test("approved pronunciations reach the provider text without spoken ruby duplication", () => {
  const pronouncedManifest = {
    speech: {
      pronunciations: [
        { from: "上沢天音", to: "かんざわ あまね" },
        { from: "荒野", to: "あらの" },
      ],
    },
    utterances: [
      { id: "cut-02-u01", text: "荒野くん。", speakerId: "a", voiceId: "voice-a" },
      { id: "cut-02-u02", text: "上沢天音（かんざわ あまね）です。", speakerId: "b", voiceId: "voice-b" },
    ],
  };
  const pronouncedCut = { id: "cut-02", utteranceIds: ["cut-02-u01", "cut-02-u02"] };
  const plan = prepareKoyaDialogueCut(pronouncedManifest, pronouncedCut);
  assert.equal(plan.inputs[0].speechText, "あらのくん。");
  assert.equal(plan.inputs[1].speechText, "かんざわ あまねです。");
  assert.equal(
    applyKoyaSpeechPronunciations("花園さくら", [
      { from: "花園", to: "はなぞの" },
      { from: "花園さくら", to: "はなぞのさくら" },
    ]),
    "はなぞのさくら",
  );
});

test("take scorer selects the complete natural-paced candidate", () => {
  const plan = prepareKoyaDialogueCut(manifest, cut);
  const candidate = (takeIndex, firstEnd, secondStart, secondEnd) => ({
    cutId: "cut-01",
    takeIndex,
    sourcePath: `take-${takeIndex}.wav`,
    sourceDurationSeconds: secondEnd + 0.2,
    voiceSegments: [
      { dialogue_input_index: 0, start_time_seconds: 0.2, end_time_seconds: firstEnd },
      { dialogue_input_index: 1, start_time_seconds: secondStart, end_time_seconds: secondEnd },
    ],
  });
  const good = candidate(0, 1.8, 2.1, 3.7);
  const rushed = candidate(1, 0.7, 0.71, 1.3);
  assert.ok(scoreKoyaDialogueTake(good, plan).score < scoreKoyaDialogueTake(rushed, plan).score);
  assert.equal(selectKoyaDialogueTake([rushed, good], plan).takeIndex, 0);
  assert.equal(selectKoyaDialogueTake([rushed, good], plan, 1).takeIndex, 1);
});

test("R134 split boundaries follow the character alignment, not the reported segment bounds", () => {
  // The provider reports segment 1 as starting at 10.0 while its first spoken
  // character lands at 10.9: the 0.9 s in between is the previous speaker's
  // still-sounding tail. Cutting at the reported midpoint would move that tail
  // into the next character's line.
  const metadata = {
    alignment: {
      characters: [..."あい", ..."うえ"],
      character_start_times_seconds: [8.0, 8.5, 10.9, 11.4],
      character_end_times_seconds: [8.5, 9.6, 11.4, 12.0],
    },
    voiceSegments: [
      { dialogue_input_index: 0, character_start_index: 0, character_end_index: 2, start_time_seconds: 8.0, end_time_seconds: 10.0 },
      { dialogue_input_index: 1, character_start_index: 2, character_end_index: 4, start_time_seconds: 10.0, end_time_seconds: 12.0 },
    ],
  };
  const cutPlan = { inputs: [{ speechText: "あい" }, { speechText: "うえ" }] };

  assert.deepEqual(alignmentSpeechSpan(metadata, cutPlan, 0), { startSeconds: 8.0, endSeconds: 9.6 });
  assert.deepEqual(alignmentSpeechSpan(metadata, cutPlan, 1), { startSeconds: 10.9, endSeconds: 12.0 });

  // Alignment is unavailable for astral-plane text, so the caller must fall
  // back rather than mis-index.
  assert.equal(alignmentSpeechSpan({ alignment: null, voiceSegments: [] }, cutPlan, 0), null);
});

test("R134 the physical cut lands in the quietest part of the inter-utterance window", () => {
  const sampleRate = 48_000;
  const samples = new Float32Array(sampleRate * 2);
  for (let index = 0; index < samples.length; index += 1) {
    const seconds = index / sampleRate;
    // Speech either side of a 0.2 s silence centred on 1.0 s.
    samples[index] = seconds > 0.9 && seconds < 1.1 ? 0 : Math.sin(seconds * 900);
  }
  const boundary = quietestBoundarySeconds(samples, 0.8, 1.2, sampleRate);
  assert.ok(boundary > 0.9 && boundary < 1.1, `boundary ${boundary} should sit inside the silence`);

  // A degenerate window falls back to the midpoint instead of throwing.
  assert.equal(quietestBoundarySeconds(samples, 1.0, 1.0, sampleRate), 1.0);
});

test("R138 speaker identity comes from spectral timbre, not pitch", () => {
  const sampleRate = 48_000;
  // Source-filter model: a harmonic source shaped by fixed formant resonances.
  // Formants stay put when the speaker changes pitch, which is precisely why
  // timbre survives the octave errors that make autocorrelation pitch useless
  // at a line's onset.
  const build = (fundamental, formants) => {
    const gain = (hz) => formants.reduce(
      (sum, [centre, width]) => sum + Math.exp(-(((hz - centre) / width) ** 2)),
      0.02,
    );
    const harmonics = [];
    for (let hz = fundamental; hz < 6000; hz += fundamental) harmonics.push([hz, gain(hz)]);
    return Float32Array.from({ length: sampleRate }, (_value, index) => harmonics.reduce(
      (sum, [hz, amplitude]) => sum + amplitude * Math.sin(2 * Math.PI * hz * index / sampleRate),
      0,
    ) * 0.05);
  };
  const speakerA = [[700, 160], [1220, 220], [2600, 300]];
  const speakerB = [[400, 160], [2000, 220], [3400, 300]];

  const lowPitch = spectralEnvelope(build(110, speakerA), 0.1, 0.9);
  const highPitch = spectralEnvelope(build(220, speakerA), 0.1, 0.9);
  const otherSpeaker = spectralEnvelope(build(110, speakerB), 0.1, 0.9);
  assert.ok(lowPitch && highPitch && otherSpeaker);
  assert.ok(
    envelopeDistance(lowPitch, otherSpeaker) > envelopeDistance(lowPitch, highPitch),
    `different vocal tract ${envelopeDistance(lowPitch, otherSpeaker)} must exceed same tract at another pitch ${envelopeDistance(lowPitch, highPitch)}`,
  );
  assert.ok(envelopeDistance(lowPitch, lowPitch) < 1e-9);

  // Silence carries no identity and must be reported as such, never guessed.
  assert.equal(spectralEnvelope(new Float32Array(sampleRate), 0.1, 0.9), null);
});

test("課金TTSは 5xx だけ再送し、4xx と 2xx は再送しない", async () => {
  // ここには再送が1つも無く、一過性の503でテイクが死んでいた。
  // 反対に 4xx を再送すると、結果は変わらず課金だけ増える。
  const { requestElevenLabsDialogue } = await import("../lib/koyaDialogueSpeech.mjs");
  const url = new URL("https://api.elevenlabs.io/v1/text-to-dialogue/with-timestamps");
  const noSleep = async () => {};

  let calls = 0;
  const recovered = await requestElevenLabsDialogue({
    url,
    apiKey: "xi-secret-0123456789",
    body: {},
    sleepFn: noSleep,
    fetchImpl: async () => {
      calls += 1;
      return calls < 3
        ? { ok: false, status: 503, json: async () => ({ detail: "upstream" }) }
        : { ok: true, status: 200, json: async () => ({ audio_base64: "AAA" }) };
    },
  });
  assert.equal(calls, 3, "5xx を再送すること");
  assert.equal(recovered.response.ok, true);

  let fourxx = 0;
  const denied = await requestElevenLabsDialogue({
    url,
    apiKey: "xi-secret-0123456789",
    body: {},
    sleepFn: noSleep,
    fetchImpl: async () => {
      fourxx += 1;
      return { ok: false, status: 422, json: async () => ({ detail: "output format" }) };
    },
  });
  assert.equal(fourxx, 1, "4xx を再送しないこと（課金だけ増える）");
  assert.equal(denied.response.status, 422);
  assert.deepEqual(denied.payload, { detail: "output format" }, "本文が呼び出し側へ渡ること");

  let ok = 0;
  await requestElevenLabsDialogue({
    url, apiKey: "xi-secret-0123456789", body: {}, sleepFn: noSleep,
    fetchImpl: async () => { ok += 1; return { ok: true, status: 200, json: async () => ({ audio_base64: "AAA" }) }; },
  });
  assert.equal(ok, 1, "成功を再送しないこと");
});

test("課金TTSの例外に API キーが載らない", async () => {
  const { requestElevenLabsDialogue } = await import("../lib/koyaDialogueSpeech.mjs");
  const apiKey = "xi-secret-0123456789abcdef";
  await assert.rejects(
    () => requestElevenLabsDialogue({
      url: new URL("https://api.elevenlabs.io/v1/text-to-dialogue/with-timestamps"),
      apiKey,
      body: {},
      maxAttempts: 2,
      sleepFn: async () => {},
      fetchImpl: async () => { throw new Error(`connect failed for key ${apiKey}`); },
    }),
    (error) => {
      assert.equal(error.message.includes(apiKey), false, "例外はログとレポートに残る");
      assert.match(error.message, /\[redacted\]/u);
      return true;
    },
  );
});
