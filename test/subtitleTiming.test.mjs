import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applySubtitleDisplayTimingRules,
  computeAudioRmsEnvelope,
  readSubtitleWordsSidecar,
  rebuildSubtitleLinesFromPlan,
  repairSubtitleLines,
  snapSubtitleLinesToSpeechOnsets,
  writeSubtitleWordsSidecar,
} from "../lib/subtitleGeneration.mjs";

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.FFMPEG_PATH || "ffmpeg", ["-y", "-v", "error", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `ffmpeg exited ${code}`))));
  });
}

async function ffmpegAvailable() {
  try {
    await runFfmpeg(["-f", "lavfi", "-i", "anullsrc=d=0.05", "-f", "null", "-"]);
    return true;
  } catch {
    return false;
  }
}

// Synthetic calibration clip: silence, then a tone burst at exactly 1.0-2.0s.
// aevalsrc evaluates PER SAMPLE, so the burst edges are sample-accurate
// (volume-gating with eval=frame quantizes edges to ~64ms frames).
async function writeToneBurstWav(filePath) {
  await runFfmpeg([
    "-f", "lavfi",
    "-i", "aevalsrc='if(between(t,1.0,2.0),0.8*sin(2*PI*440*t),0)':s=16000:d=3",
    "-ac", "1",
    "-c:a", "pcm_s16le",
    filePath,
  ]);
}

// Synthetic envelope for pure-function tests: 10ms hops, "speech" frames at
// -20dB between speechStart and speechEnd (seconds), silence at -80dB.
function syntheticEnvelope(totalSeconds, speechRangesSeconds) {
  const hopSeconds = 0.01;
  const frames = new Float32Array(Math.round(totalSeconds / hopSeconds)).fill(-80);
  for (const [from, to] of speechRangesSeconds) {
    for (let i = Math.round(from / hopSeconds); i < Math.round(to / hopSeconds) && i < frames.length; i += 1) {
      frames[i] = -20;
    }
  }
  return { hopSeconds, frames, noiseFloorDb: -80, speechThresholdDb: -40 };
}

test("onset snap pulls cue boundaries to the true speech edges (synthetic envelope)", () => {
  const envelope = syntheticEnvelope(4, [[1.0, 2.0]]);
  const snapped = snapSubtitleLinesToSpeechOnsets(
    [{ start: 1.08, end: 1.93, text: "テスト" }],
    envelope,
  );
  // ASR said 1.08s; the audio actually starts at 1.00s.
  assert.ok(Math.abs(snapped[0].start - 1.0) <= 0.02, `start snapped to ${snapped[0].start}`);
  // ASR said 1.93s; the audio actually ends at 2.00s.
  assert.ok(Math.abs(snapped[0].end - 2.0) <= 0.03, `end snapped to ${snapped[0].end}`);
});

test("onset snap leaves ambiguous boundaries untouched", () => {
  // Speech spans the whole search window — the true onset is not visible.
  const envelope = syntheticEnvelope(4, [[0.5, 3.5]]);
  const snapped = snapSubtitleLinesToSpeechOnsets(
    [{ start: 1.5, end: 2.5, text: "テスト" }],
    envelope,
  );
  assert.equal(snapped[0].start, 1.5);
  assert.equal(snapped[0].end, 2.5);
});

test("onset snap never lets neighbours overlap", () => {
  const envelope = syntheticEnvelope(4, [[0.9, 1.5], [1.6, 2.5]]);
  const snapped = snapSubtitleLinesToSpeechOnsets(
    [
      { start: 0.95, end: 1.45, text: "前" },
      { start: 1.66, end: 2.4, text: "後" },
    ],
    envelope,
  );
  assert.ok(snapped[1].start >= snapped[0].end);
});

test("display rules add a lead-in, enforce minimum duration, and bridge flicker gaps", () => {
  const cues = applySubtitleDisplayTimingRules(
    [
      { start: 1.0, end: 1.4, text: "短い" },
      { start: 3.0, end: 4.0, text: "普通" },
      { start: 4.12, end: 5.5, text: "近い" },
    ],
    { durationSeconds: 10 },
  );
  // 80ms perceptual lead-in.
  assert.ok(Math.abs(cues[0].start - 0.92) < 1e-6, `lead-in start ${cues[0].start}`);
  // 0.4s cue extended to at least 1s on screen.
  assert.ok(cues[0].end - cues[0].start >= 1.0 - 1e-6, `min duration ${cues[0].end - cues[0].start}`);
  // The 3rd cue starts 120ms after the 2nd ends (after its own lead-in) —
  // that sub-200ms gap is bridged so the telop does not flicker.
  assert.ok(Math.abs(cues[1].end - cues[2].start) < 1e-6, `bridged gap ${cues[2].start - cues[1].end}`);
  // Never overlapping.
  assert.ok(cues[1].start >= cues[0].end);
  assert.ok(cues[2].start >= cues[1].end);
});

test("local repair merges blink-short cues and re-wraps over-long lines", () => {
  const repaired = repairSubtitleLines(
    [
      { start: 0, end: 1.5, text: "これは普通のキュー", startWordIndex: 0, endWordIndex: 4 },
      { start: 1.55, end: 1.7, text: "です", startWordIndex: 5, endWordIndex: 5 },
      { start: 5, end: 7, text: "今日は良い天気なので散歩に出かけましたよ", startWordIndex: 6, endWordIndex: 9 },
    ],
    { maxChars: 15, lineCount: 2 },
  );
  // The 150ms "です" merged into its neighbour, keeping the word anchors.
  assert.equal(repaired.length, 2);
  assert.match(repaired[0].text.replace(/\n/g, ""), /これは普通のキューです/);
  assert.equal(repaired[0].endWordIndex, 5);
  assert.ok(Math.abs(repaired[0].end - 1.7) < 1e-6);
  // The 40-char cue got re-wrapped to the line budget.
  for (const line of repaired[1].text.split("\n")) {
    assert.ok(line.length <= 15 + 4, `line still too long: ${line.length}`);
  }
});

test("agent refine plan rebuilds cues with word-anchored timing", () => {
  const words = [
    { text: "今日", start: 0.5, end: 0.8 },
    { text: "は", start: 0.8, end: 0.9 },
    { text: "良い", start: 0.9, end: 1.2 },
    { text: "天気", start: 1.2, end: 1.6 },
    { text: "です", start: 1.6, end: 2.0 },
    { text: "散歩", start: 3.0, end: 3.4 },
    { text: "に", start: 3.4, end: 3.5 },
    { text: "行く", start: 3.5, end: 3.9 },
  ];
  const cues = rebuildSubtitleLinesFromPlan(words, [
    { startWordIndex: 0, endWordIndex: 4, lines: ["今日は良い天気です"] },
    // Kanji fix via lines: the agent corrected 行く→逝く-style homophone errors here
    { startWordIndex: 5, endWordIndex: 7, lines: ["散歩に行く"] },
  ], { lineCount: 2, maxCharsPerLine: 30 });
  assert.equal(cues.length, 2);
  // Times come ONLY from the word anchors, not from the provided text.
  assert.equal(cues[0].start, 0.5);
  assert.equal(cues[0].end, 2.0);
  assert.equal(cues[1].start, 3.0);
  assert.equal(cues[1].end, 3.9);
  assert.equal(cues[0].text, "今日は良い天気です");
  // Invalid plans are rejected loudly.
  assert.throws(() => rebuildSubtitleLinesFromPlan(words, [{ startWordIndex: 3, endWordIndex: 1 }]), /invalid word range/);
  assert.throws(() => rebuildSubtitleLinesFromPlan(words, [
    { startWordIndex: 0, endWordIndex: 4 },
    { startWordIndex: 4, endWordIndex: 7 },
  ]), /overlaps/);
});

test("words sidecar roundtrips through the canvas directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "subtitle-sidecar-"));
  try {
    const payload = { words: [{ text: "テスト", start: 0, end: 1 }], lineCount: 2, maxChars: 30, elementId: "el1" };
    await writeSubtitleWordsSidecar(dir, "subtitles-1.srt", payload);
    const loaded = await readSubtitleWordsSidecar(dir, "subtitles-1.srt");
    assert.equal(loaded.words.length, 1);
    assert.equal(loaded.elementId, "el1");
    assert.ok(loaded.sidecarPath.includes(".subtitle-words"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("calibration: envelope + snap recover a known tone onset from real audio", async (t) => {
  if (!(await ffmpegAvailable())) {
    t.skip("ffmpeg not available");
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "subtitle-timing-"));
  try {
    const wavPath = join(dir, "burst.wav");
    await writeToneBurstWav(wavPath);
    const envelope = await computeAudioRmsEnvelope(wavPath);
    assert.ok(envelope, "envelope missing");
    const snapped = snapSubtitleLinesToSpeechOnsets(
      [{ start: 1.09, end: 1.92, text: "テスト" }],
      envelope,
    );
    assert.ok(Math.abs(snapped[0].start - 1.0) <= 0.03, `real-audio start ${snapped[0].start}`);
    assert.ok(Math.abs(snapped[0].end - 2.0) <= 0.05, `real-audio end ${snapped[0].end}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("calibration: a FLAC chunk cut at -ss keeps the tone onset sample-accurate", async (t) => {
  if (!(await ffmpegAvailable())) {
    t.skip("ffmpeg not available");
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "subtitle-timing-"));
  try {
    const wavPath = join(dir, "burst.wav");
    await writeToneBurstWav(wavPath);
    // Encode with the same recipe as splitAudioForDirectSubtitleUpload's FLAC
    // path, cutting from 0.5s: inside the chunk the burst must sit at 0.5s.
    const chunkPath = join(dir, "chunk.flac");
    await runFfmpeg([
      "-ss", "0.5",
      "-i", wavPath,
      "-t", "2.0",
      "-map", "0:a:0",
      "-vn",
      "-ac", "1",
      "-af", "highpass=f=80",
      "-ar", "16000",
      "-c:a", "flac",
      "-f", "flac",
      chunkPath,
    ]);
    const envelope = await computeAudioRmsEnvelope(chunkPath);
    assert.ok(envelope, "chunk envelope missing");
    const snapped = snapSubtitleLinesToSpeechOnsets(
      [{ start: 0.56, end: 1.44, text: "テスト" }],
      envelope,
    );
    // Systematic codec/seek offset would show up here as a shifted onset.
    assert.ok(Math.abs(snapped[0].start - 0.5) <= 0.03, `chunk onset ${snapped[0].start}`);
    assert.ok(Math.abs(snapped[0].end - 1.5) <= 0.05, `chunk tail ${snapped[0].end}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("POS boundary penalties keep modifiers, conjugations, and suffixes on one line", async () => {
  const { ensureJapaneseTokenizer, scoreJapanesePosBoundaryPenalty } = await import("../lib/subtitleGeneration.mjs");
  const tokenizer = await ensureJapaneseTokenizer();
  if (!tokenizer) return; // kuromoji dictionary unavailable — nothing to assert
  assert.ok(scoreJapanesePosBoundaryPenalty("大きな", "猫が好き") > 0, "連体詞|名詞 must be penalized");
  assert.ok(scoreJapanesePosBoundaryPenalty("音声", "認識の話") > 0, "複合名詞の分断 must be penalized");
  assert.ok(scoreJapanesePosBoundaryPenalty("食べ", "られた") > 0, "活用の途中 must be penalized");
  assert.ok(scoreJapanesePosBoundaryPenalty("山田", "さんが来た") > 0, "接尾語の分離 must be penalized");
  assert.equal(scoreJapanesePosBoundaryPenalty("です。", "さて次は"), 0, "文末→接続詞 is a fine break");
});

test("predicate base-form before a noun is treated as 連体修飾 and kept together", async () => {
  const { ensureJapaneseTokenizer, scoreJapanesePosBoundaryPenalty } = await import("../lib/subtitleGeneration.mjs");
  const tokenizer = await ensureJapaneseTokenizer();
  if (!tokenizer) return; // dictionary unavailable — heuristic silently off
  assert.ok(scoreJapanesePosBoundaryPenalty("昨日会った", "人がいた") > 0, "た＋名詞 (会った|人) must be penalized");
  assert.ok(scoreJapanesePosBoundaryPenalty("走る", "人を見た") > 0, "基本形＋名詞 (走る|人) must be penalized");
  assert.ok(scoreJapanesePosBoundaryPenalty("走った", "ときの話") > 0, "た＋非自立名詞 (走った|とき) must be penalized");
  assert.ok(scoreJapanesePosBoundaryPenalty("楽しい", "時間だった") > 0, "形容詞＋名詞 (楽しい|時間) must be penalized");
});
