import test from "node:test";
import assert from "node:assert/strict";

import { parseEbur128Summary, parseSilenceDetectLog } from "../lib/mangaVideoQuality.mjs";

test("ffmpeg silence detection events are paired with measured durations", () => {
  const log = `
[silencedetect @ 0x1] silence_start: 2.4
[silencedetect @ 0x1] silence_end: 3.75 | silence_duration: 1.35
[silencedetect @ 0x1] silence_start: 7
[silencedetect @ 0x1] silence_end: 7.6 | silence_duration: 0.6`;
  assert.deepEqual(parseSilenceDetectLog(log), [
    { startSeconds: 2.4, endSeconds: 3.75, durationSeconds: 1.35 },
    { startSeconds: 7, endSeconds: 7.6, durationSeconds: 0.6 },
  ]);
});

test("EBU R128 final summary is parsed instead of frame-by-frame readings", () => {
  const log = `I: -70.0 LUFS
Summary:
  Integrated loudness:
    I:         -18.2 LUFS
  Loudness range:
    LRA:         5.6 LU
  True peak:
    Peak:       -1.7 dBFS`;
  assert.deepEqual(parseEbur128Summary(log), {
    integratedLufs: -18.2,
    loudnessRangeLu: 5.6,
    truePeakDbfs: -1.7,
  });
});

