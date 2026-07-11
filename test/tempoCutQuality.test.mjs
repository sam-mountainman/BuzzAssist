import test from "node:test";
import assert from "node:assert/strict";

import {
  applySilenceCutDecisions,
  buildTempoCutRepeatRetakeCandidates,
  buildTempoCutScribePlan,
  snapCutRangesToEnergy,
} from "../lib/tempoCut.mjs";
import { ensureJapaneseTokenizer } from "../lib/subtitleGeneration.mjs";

// Synthetic envelope helper: speech(=-20dB) / silence(=-70dB) per 10ms frame.
function makeEnvelope(speechRanges, durationSeconds, hopSeconds = 0.01) {
  const frames = new Float32Array(Math.round(durationSeconds / hopSeconds)).fill(-70);
  for (const [start, end] of speechRanges) {
    for (let i = Math.round(start / hopSeconds); i < Math.round(end / hopSeconds); i += 1) {
      if (i >= 0 && i < frames.length) frames[i] = -20;
    }
  }
  return { hopSeconds, frames, noiseFloorDb: -70, speechThresholdDb: -40 };
}

function word(text, start, end) {
  return { text, start, end, type: "word" };
}

test("cut boundaries snap to the real speech edges", () => {
  // Speech 0-1.0s and 3.0-4.0s; ASR-derived cut drifts into both words.
  const envelope = makeEnvelope([[0, 1.0], [3.0, 4.0]], 4.0);
  const snapped = snapCutRangesToEnergy([{ start: 0.93, end: 3.08 }], envelope);
  assert.equal(snapped.length, 1);
  // Start moves to just AFTER the speech tail (≥1.0s), never clipping it.
  assert.ok(snapped[0].start >= 1.0 && snapped[0].start <= 1.05, `start=${snapped[0].start}`);
  // End releases right AT the next onset (≤3.0s).
  assert.ok(snapped[0].end <= 3.0 && snapped[0].end >= 2.95, `end=${snapped[0].end}`);
});

test("boundaries deep inside continuous speech are left untouched", () => {
  const envelope = makeEnvelope([[0, 4.0]], 4.0);
  const snapped = snapCutRangesToEnergy([{ start: 1.0, end: 2.0 }], envelope);
  assert.equal(snapped.length, 1);
  assert.equal(snapped[0].start, 1.0);
  assert.equal(snapped[0].end, 2.0);
});

test("demonstrative あの/その stays; filler あの gets cut", async () => {
  const tokenizer = await ensureJapaneseTokenizer();
  const duration = 10;
  // 「あの人が…」: あの attaches straight onto 人 → demonstrative, protect.
  const demonstrative = buildTempoCutScribePlan({
    duration,
    words: [word("あの", 1.0, 1.2), word("人が", 1.25, 1.6), word("来た", 1.65, 2.0)],
    detectSeconds: 0.6,
    keepSeconds: 0.25,
    preMarginSeconds: 0.08,
    postMarginSeconds: 0.12,
    fillerRemoval: 60,
    coughRemoval: 0,
    retakeRemoval: 0,
    tokenizer,
  });
  assert.equal(demonstrative.candidates.filter((c) => c.type === "filler").length, 0, "あの人 must not be cut");

  // 「あの……（0.6s pause）今日は」: pause after あの → filler, cut.
  const filler = buildTempoCutScribePlan({
    duration,
    words: [word("あの", 1.0, 1.2), word("今日は", 1.8, 2.2)],
    detectSeconds: 0.6,
    keepSeconds: 0.25,
    preMarginSeconds: 0.08,
    postMarginSeconds: 0.12,
    fillerRemoval: 60,
    coughRemoval: 0,
    retakeRemoval: 0,
    tokenizer,
  });
  assert.equal(filler.candidates.filter((c) => c.type === "filler").length, 1, "pause-separated あの must be cut");
});

test("repeated-phrase restarts are detected as retakes; clean sentences are not", () => {
  const duration = 20;
  // Aborted take then restart of the same phrase after a pause.
  const retake = buildTempoCutRepeatRetakeCandidates([
    word("今日はですね", 1.0, 2.0),
    word("今日はですね", 3.0, 4.0),
    word("晴れです", 4.05, 4.8),
  ], duration, 50);
  assert.equal(retake.length, 1, "restart must be detected");
  assert.equal(retake[0].reason, "repeated_phrase_restart");
  // The cut removes the aborted take and the pause, ending before the restart.
  assert.ok(retake[0].start <= 1.0 && retake[0].end <= 3.0 && retake[0].end > 2.5);

  // Intentional repetition ending on 。 must NOT be treated as a retake.
  const intentional = buildTempoCutRepeatRetakeCandidates([
    word("大事です。", 1.0, 2.0),
    word("大事です。", 3.0, 4.0),
  ], duration, 50);
  assert.equal(intentional.length, 0, "sentence-final repetition is rhetoric, not a retake");
});

test("marker words alone only cut the interjection, never the previous phrase", () => {
  const plan = buildTempoCutScribePlan({
    duration: 10,
    words: [word("これは", 1.0, 1.5), word("いや", 1.6, 1.9), word("違う話", 2.0, 2.6)],
    detectSeconds: 0.6,
    keepSeconds: 0.25,
    preMarginSeconds: 0.08,
    postMarginSeconds: 0.12,
    fillerRemoval: 0,
    coughRemoval: 0,
    retakeRemoval: 80,
    tokenizer: null,
  });
  const markers = plan.candidates.filter((c) => c.reason === "retake_marker");
  assert.equal(markers.length, 1);
  assert.ok(markers[0].start >= 1.6, "the cut must not rewind into the previous phrase");
  assert.equal(plan.candidates.some((c) => c.reason === "retake_marker_with_previous_phrase"), false);
});

test("review decisions rebuild the cut list: veto, adjust, add", () => {
  const candidates = [
    { id: "c001", start: 1.0, end: 2.0, type: "word_gap" },
    { id: "c002", start: 3.0, end: 3.4, type: "filler" },
    { id: "c003", start: 5.0, end: 6.0, type: "retake" },
  ];
  const ranges = applySilenceCutDecisions(candidates, [
    { id: "c002", accept: false },
    { id: "c003", accept: true, start: 5.2, end: 5.8 },
  ], [{ start: 8.0, end: 8.5 }]);
  assert.deepEqual(ranges, [
    { start: 1.0, end: 2.0 },
    { start: 5.2, end: 5.8 },
    { start: 8.0, end: 8.5 },
  ]);
});
