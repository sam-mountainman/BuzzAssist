import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  approvedKoyaDialogueCutCheckpoint,
  alignmentSpeechSpan,
  envelopeDistance,
  applyKoyaSpeechPronunciations,
  buildKoyaDialogueRequest,
  generateKoyaDialogueSpeech,
  KoyaUsageLimitError,
  koyaPerformanceTag,
  normalizeKoyaSpeechCutConcurrency,
  normalizeKoyaDialogueMediaJobReceipt,
  prepareKoyaDialogueCut,
  quietestBoundarySeconds,
  splitKoyaProviderSpeechText,
  spectralEnvelope,
  scoreKoyaDialogueTake,
  selectKoyaDialogueTake,
  runKoyaSpeechCutPool,
} from "../lib/koyaDialogueSpeech.mjs";

const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");
const mediaReceipt = (cutId, takeIndex) => ({
  version: "paid-media-job-receipt-v1",
  jobId: `job-${cutId}-${takeIndex}`,
  requestKey: `koya:${cutId}:take:${takeIndex + 1}:${sha256(`${cutId}:${takeIndex}`)}`,
  status: "completed",
  kind: "voice.dialogue",
  provider: "elevenlabs",
  adapterVersion: "elevenlabs-dialogue-server-v1",
  providerJobId: `provider-${cutId}-${takeIndex}`,
  model: "eleven_v3",
  voiceId: "dialogue-fixture",
  inputHash: sha256(`input:${cutId}:${takeIndex}`),
  reservation: {},
  usage: { units: 10, cost: 0.01, currency: "USD" },
  artifact: { sha256: sha256(`artifact:${cutId}:${takeIndex}`), mimeType: "audio/wav", bytes: 128 },
  attempts: { total: 1, retries: [] },
});

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

test("Koya dialogue Media Job receipts require the exact completed paid adapter and artifact binding", () => {
  const normalized = normalizeKoyaDialogueMediaJobReceipt(mediaReceipt("cut-01", 0));
  assert.equal(normalized.status, "completed");
  assert.equal(normalized.artifact.sha256, sha256("artifact:cut-01:0"));
  assert.throws(
    () => normalizeKoyaDialogueMediaJobReceipt({ ...mediaReceipt("cut-01", 0), model: "wrong" }),
    /exact paid adapter identity/iu,
  );
  assert.throws(
    () => normalizeKoyaDialogueMediaJobReceipt({
      ...mediaReceipt("cut-01", 0),
      artifact: { sha256: "missing", mimeType: "audio/wav", bytes: 128 },
    }),
    /artifact\.sha256/iu,
  );
});

test("long narration is split into ordered provider inputs without changing the logical utterance", () => {
  const speechText = [
    "朝の商店街では、受付係が予約表を丁寧に確認していた。",
    "その横では、席札を並べ直しながら来客の名前を一人ずつ読み上げていた。",
    "店の奥では、記録係が時刻と受け渡しの順番を静かに照合していた。",
    "全員が持ち場を守り、開店前の準備は滞りなく進んでいた。",
  ].join("");
  const parts = splitKoyaProviderSpeechText(speechText, { preset: "narration" });
  assert.ok(parts.length > 1);
  assert.equal(parts.join(""), speechText);
  assert.ok(parts.every((part) => [...part].length <= 50));
  assert.deepEqual(splitKoyaProviderSpeechText(speechText, { preset: "dialogue" }), [speechText]);

  const longManifest = {
    utterances: [
      { id: "cut-02-u01", text: speechText, speechText, speakerId: "lead", voiceId: "voice-a", preset: "narration" },
    ],
  };
  const plan = prepareKoyaDialogueCut(longManifest, { id: "cut-02", utteranceIds: ["cut-02-u01"] });
  assert.equal(plan.inputs.length, 1);
  assert.equal(plan.providerInputs.length, parts.length);
  assert.deepEqual(plan.inputs[0].providerInputIndices, parts.map((_part, index) => index));
  assert.equal(buildKoyaDialogueRequest(plan, 0).inputs.length, parts.length);
  assert.deepEqual(plan.providerInputs.map((entry) => entry.parentUtteranceId), parts.map(() => "cut-02-u01"));
});

test("approved dialogue checkpoints resume only exact inputs and current multi-speaker UTMOS evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "koya-dialogue-checkpoint-"));
  try {
    const paths = {
      filePath: join(dir, "line.wav"),
      alignmentPath: join(dir, "line.wav.json"),
      sourceDialoguePath: join(dir, "take.wav"),
      sourceDialogueMetadataPath: join(dir, "take.wav.json"),
    };
    await Promise.all(Object.values(paths).map((path) => writeFile(path, "checkpoint")));
    const multiManifest = {
      utterances: [
        { id: "cut-03-u01", text: "確認する。", speakerId: "a", voiceId: "voice-a" },
        { id: "cut-03-u02", text: "お願いします。", speakerId: "b", voiceId: "voice-b" },
      ],
    };
    const plan = prepareKoyaDialogueCut(multiManifest, {
      id: "cut-03",
      utteranceIds: ["cut-03-u01", "cut-03-u02"],
    });
    const selection = {
      method: "alignment-completeness-edge-room-scene-paced-cps-and-r194-voice-quality",
      selectedTakeIndex: 0,
      candidates: [{
        takeIndex: 0,
        voiceQuality: {
          hardFail: false,
          missingRequiredMetrics: [],
          problems: [],
          metrics: { utmos: 2.5, segments: [{ id: "cut-03-u01", cer: 0 }, { id: "cut-03-u02", cer: 0 }] },
        },
      }],
    };
    for (let index = 0; index < plan.inputs.length; index += 1) {
      const input = plan.inputs[index];
      plan.utterances[index].audio = {
        pipeline: "koya-dialogue-v44",
        utteranceId: input.utteranceId,
        displayText: input.displayText,
        speechText: input.speechText,
        performancePrompt: input.performancePrompt,
        providerText: input.providerText,
        voiceId: input.voiceId,
        model: "eleven_v3",
        selectedTakeIndex: 0,
        candidateSelection: selection,
        ...paths,
      };
    }
    assert.equal(await approvedKoyaDialogueCutCheckpoint(plan), null, "old whole-clip-only UTMOS is not reusable");
    selection.candidates[0].voiceQuality.metrics.segmentUtmosApplied = true;
    selection.candidates[0].voiceQuality.metrics.segments = [
      { id: "cut-03-u01", utmos: 3.1, cer: 0 },
      { id: "cut-03-u02", utmos: 3.0, cer: 0 },
    ];
    assert.deepEqual(await approvedKoyaDialogueCutCheckpoint(plan), {
      selectedTakeIndex: 0,
      sourcePath: paths.sourceDialoguePath,
    });
    plan.utterances[0].audio.performancePrompt = "[wrong]";
    assert.equal(await approvedKoyaDialogueCutCheckpoint(plan), null, "changed performance direction invalidates reuse");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Koya cut concurrency never exceeds the shared four-request ceiling", () => {
  assert.equal(normalizeKoyaSpeechCutConcurrency("auto", 2), 2);
  assert.equal(normalizeKoyaSpeechCutConcurrency(99, 2), 2);
  assert.equal(normalizeKoyaSpeechCutConcurrency("auto", 3), 1);
  assert.throws(() => normalizeKoyaSpeechCutConcurrency("auto", 8), /exceeds.*limit/iu);
  assert.throws(() => normalizeKoyaSpeechCutConcurrency(0, 2), /positive integer/iu);
});

test("Koya cut pool is bounded, returns input-order outcomes, and stops claiming after failure or cancellation", async () => {
  let active = 0;
  let maximumActive = 0;
  const settled = [];
  const ordered = await runKoyaSpeechCutPool([0, 1, 2, 3], {
    concurrency: 2,
    worker: async (item) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((done) => { setTimeout(done, (4 - item) * 2); });
      active -= 1;
      return `cut-${item}`;
    },
    onSettled: async (outcome) => { settled.push(outcome.value); },
  });
  assert.equal(maximumActive, 2);
  assert.deepEqual(ordered.outcomes.map((outcome) => outcome.value), ["cut-0", "cut-1", "cut-2", "cut-3"]);
  assert.notDeepEqual(settled, ordered.outcomes.map((outcome) => outcome.value), "completion order may differ from output order");

  const started = [];
  const failed = await runKoyaSpeechCutPool([0, 1, 2, 3], {
    concurrency: 2,
    worker: async (item) => {
      started.push(item);
      if (item === 0) throw new Error("injected failure");
      await new Promise((done) => { setTimeout(done, 5); });
      return item;
    },
  });
  assert.match(failed.firstError.message, /injected failure/u);
  assert.deepEqual(started.sort(), [0, 1]);
  assert.deepEqual(failed.unscheduled, [2, 3]);

  let paidCalls = 0;
  const cancelled = await runKoyaSpeechCutPool([0, 1], {
    concurrency: 2,
    shouldStop: async () => true,
    worker: async () => { paidCalls += 1; },
  });
  assert.equal(cancelled.cancelled, true);
  assert.equal(paidCalls, 0, "cancellation is checked before a cut can start paid work");
});

test("completed-cut checkpoints resume a failed parallel run without duplicate generation and keep manifest order", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "koya-speech-parallel-resume-"));
  try {
    const episodeDir = join(projectDir, "episode");
    const canvasDir = join(projectDir, "canvas");
    const manifestPath = join(episodeDir, "manifest.json");
    await mkdir(episodeDir, { recursive: true });
    const original = {
      id: "parallel-resume",
      utterances: [
        { id: "u1", text: "一。", speakerId: "a", voiceId: "voice-a" },
        { id: "u2", text: "二。", speakerId: "a", voiceId: "voice-a" },
        { id: "u3", text: "三。", speakerId: "a", voiceId: "voice-a" },
      ],
      cuts: [
        { id: "cut-01", utteranceIds: ["u1"] },
        { id: "cut-02", utteranceIds: ["u2"] },
        { id: "cut-03", utteranceIds: ["u3"] },
      ],
      production: {},
    };
    await writeFile(manifestPath, `${JSON.stringify(original, null, 2)}\n`);
    const approvedCheckpointImpl = async (plan) => (
      plan.utterances.every((utterance) => utterance.audio?.fixtureApproved === true)
        ? { selectedTakeIndex: 0, sourcePath: `/fixture/${plan.cutId}.wav` }
        : null
    );
    const firstCalls = [];
    const first = await generateKoyaDialogueSpeech({
      projectDir,
      canvasDir,
      manifestPath,
      contract: { audio: { takeCount: 2 } },
      voiceQualityGate: false,
      speechConcurrency: "auto",
      requireMediaJobReceipts: true,
      approvedCheckpointImpl,
      cutRunner: async ({ cut, workerManifest }) => {
        firstCalls.push(cut.id);
        if (cut.id === "cut-02") {
          await new Promise((done) => { setTimeout(done, 1); });
          throw new KoyaUsageLimitError("injected usage limit", { cutId: cut.id });
        }
        await new Promise((done) => { setTimeout(done, 15); });
        const utterance = workerManifest.utterances.find((entry) => cut.utteranceIds.includes(entry.id));
        utterance.audio = { fixtureApproved: true, cutId: cut.id };
        return {
          manifest: workerManifest,
          reportRow: { cutId: cut.id, status: "complete" },
          mediaJobs: [mediaReceipt(cut.id, 0), mediaReceipt(cut.id, 1)],
        };
      },
    });
    assert.equal(first.waiting, true);
    assert.deepEqual(firstCalls.sort(), ["cut-01", "cut-02"]);
    assert.deepEqual(first.report.completedCutIds, ["cut-01"]);
    assert.deepEqual(first.report.pendingCutIds, ["cut-02", "cut-03"]);
    assert.deepEqual(first.report.cuts.map((row) => row.cutId), ["cut-01", "cut-02", "cut-03"]);
    const checkpointed = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(checkpointed.production.checkpoint.version, "koya-speech-cut-set-v1");
    assert.equal("nextCutId" in checkpointed.production.checkpoint, false);
    assert.deepEqual(checkpointed.production.checkpoint.completedCutIds, ["cut-01"]);
    assert.equal(checkpointed.utterances[0].audio.fixtureApproved, true);
    assert.deepEqual(first.report.mediaJobs.map((row) => row.requestKey), [
      mediaReceipt("cut-01", 0).requestKey,
      mediaReceipt("cut-01", 1).requestKey,
    ]);

    const resumeCalls = [];
    const resumed = await generateKoyaDialogueSpeech({
      projectDir,
      canvasDir,
      manifestPath,
      contract: { audio: { takeCount: 2 } },
      voiceQualityGate: false,
      speechConcurrency: "auto",
      requireMediaJobReceipts: true,
      approvedCheckpointImpl,
      cutRunner: async ({ cut, workerManifest }) => {
        resumeCalls.push(cut.id);
        const utterance = workerManifest.utterances.find((entry) => cut.utteranceIds.includes(entry.id));
        utterance.audio = { fixtureApproved: true, cutId: cut.id };
        return {
          manifest: workerManifest,
          reportRow: { cutId: cut.id, status: "complete" },
          mediaJobs: [mediaReceipt(cut.id, 0), mediaReceipt(cut.id, 1)],
        };
      },
    });
    assert.equal(resumed.waiting, false);
    assert.equal(resumed.partial, false);
    assert.deepEqual(resumeCalls.sort(), ["cut-02", "cut-03"], "completed cut-01 must not be generated twice");
    assert.deepEqual(resumed.report.completedCutIds, ["cut-01", "cut-02", "cut-03"]);
    assert.deepEqual(resumed.report.pendingCutIds, []);
    assert.deepEqual(resumed.manifest.utterances.map((entry) => entry.id), ["u1", "u2", "u3"]);
    assert.equal("checkpoint" in resumed.manifest.production, false);
    assert.equal(resumed.report.mediaJobs.length, 6, "all paid takes survive resume and are deduplicated");
    assert.equal(new Set(resumed.report.mediaJobs.map((row) => row.requestKey)).size, 6);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Koya speech cancellation checkpoints an in-flight success and starts no later cut", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "koya-speech-parallel-cancel-"));
  try {
    const episodeDir = join(projectDir, "episode");
    const manifestPath = join(episodeDir, "manifest.json");
    await mkdir(episodeDir, { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify({
      id: "parallel-cancel",
      utterances: [
        { id: "u1", text: "一。", speakerId: "a", voiceId: "voice-a" },
        { id: "u2", text: "二。", speakerId: "a", voiceId: "voice-a" },
      ],
      cuts: [
        { id: "cut-01", utteranceIds: ["u1"] },
        { id: "cut-02", utteranceIds: ["u2"] },
      ],
      production: {},
    }, null, 2)}\n`);
    let cancellationChecks = 0;
    const calls = [];
    const result = await generateKoyaDialogueSpeech({
      projectDir,
      canvasDir: join(projectDir, "canvas"),
      manifestPath,
      contract: { audio: { takeCount: 2 } },
      voiceQualityGate: false,
      speechConcurrency: 1,
      approvedCheckpointImpl: async () => null,
      isCancellationRequested: async () => {
        cancellationChecks += 1;
        return cancellationChecks > 1;
      },
      cutRunner: async ({ cut, workerManifest }) => {
        calls.push(cut.id);
        workerManifest.utterances.find((entry) => cut.utteranceIds.includes(entry.id)).audio = {
          fixtureApproved: true,
        };
        return { manifest: workerManifest, reportRow: { cutId: cut.id, status: "complete" } };
      },
    });
    assert.equal(result.cancelled, true);
    assert.deepEqual(calls, ["cut-01"]);
    assert.deepEqual(result.report.completedCutIds, ["cut-01"]);
    assert.deepEqual(result.report.pendingCutIds, ["cut-02"]);
    const saved = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.deepEqual(saved.production.checkpoint.completedCutIds, ["cut-01"]);
    assert.equal(saved.utterances[0].audio.fixtureApproved, true);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
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
