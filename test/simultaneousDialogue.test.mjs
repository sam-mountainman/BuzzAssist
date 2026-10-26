import test from "node:test";
import assert from "node:assert/strict";
import { buildEpisodeAudioMixFilter, compileEpisodeTiming } from "../lib/mangaVideoPipeline.mjs";
import { applyKoyaCharacterBibleSpeechDirectives } from "../lib/koyaMangaProduction.mjs";

// 2人同時の台詞：台本では2行に分けて書かれ、同じコマで前の行と同時に言う行。
// 声は人物ごとに別の WAV、コマの時間割で出だしをそろえて重ねる。

const VIDEO = {
  preRollSeconds: 0.1,
  speakerChangeGapSeconds: 0.3,
  sameSpeakerGapSeconds: 0.2,
  bubbleLeadSeconds: 0.05,
  bubbleHoldSeconds: 0.2,
  cutTailSeconds: 0.3,
  fps: 30,
};

function line(id, speakerId, durationSeconds, speechStartSeconds, extra = {}) {
  return {
    id,
    cutId: "cut-1",
    speakerId,
    text: "変わりすぎだろッ！",
    audio: {
      filePath: `/tmp/${id}.wav`,
      durationSeconds,
      speechStartSeconds,
      speechEndSeconds: durationSeconds - 0.1,
    },
    ...extra,
  };
}

function manifest(utterances) {
  return {
    video: VIDEO,
    cuts: [{ id: "cut-1", utteranceIds: utterances.map((entry) => entry.id) }],
    utterances,
  };
}

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test("a simultaneous line starts with the previous line's speech onset instead of after it", () => {
  const compiled = compileEpisodeTiming(manifest([
    line("u1", "a", 1.0, 0.1),
    line("u2", "b", 1.4, 0.15, { simultaneousWithPrevious: true }),
    line("u3", "a", 0.8, 0.1),
  ]));
  const [first, second, third] = compiled.utterances;
  close(first.timing.audioStartInCutSeconds, 0.1);
  // 出だし（声の始まり）をそろえる：0.1 + 0.1 - 0.15
  close(second.timing.audioStartInCutSeconds, 0.05);
  assert.equal(second.timing.simultaneousWithUtteranceId, "u1");
  // 次の行は、組の中で一番遅く終わる音（u2 の 0.05 + 1.4）のあとに続く。
  close(third.timing.audioStartInCutSeconds, 1.45 + 0.3);
  close(compiled.cuts[0].timing.durationSeconds, 1.75 + 0.8 + 0.3);
});

test("a simultaneous group shows its bubbles together, ends them together, and halves the summed power", () => {
  const compiled = compileEpisodeTiming(manifest([
    line("u1", "a", 1.0, 0.1),
    line("u2", "b", 1.4, 0.15, { simultaneousWithPrevious: true }),
    line("u3", "a", 0.8, 0.1),
  ]));
  const [first, second, third] = compiled.utterances;
  assert.equal(first.timing.simultaneousGroupId, "u1");
  assert.equal(second.timing.simultaneousGroupId, "u1");
  assert.equal(first.timing.simultaneousGroupSize, 2);
  assert.equal(first.timing.mixGain, 0.7071);
  assert.equal(second.timing.mixGain, 0.7071);
  assert.equal(third.timing.mixGain, undefined);
  // 2つの吹き出しは同時に出ていて、一緒に消える。
  assert.ok(first.timing.bubbleEndInCutSeconds > second.timing.bubbleStartInCutSeconds);
  assert.equal(first.timing.bubbleEndInCutSeconds, second.timing.bubbleEndInCutSeconds);
  // 組の吹き出しは、次の行の吹き出しの前に消える（いつもの入れ替えの間を守る）。
  assert.ok(second.timing.bubbleEndInCutSeconds <= third.timing.bubbleStartInCutSeconds - (2 / 30) + 1e-9);

  const mix = buildEpisodeAudioMixFilter(compiled.utterances, { sampleRate: 48_000, sampleCount: 200_000 });
  assert.match(mix.filterGraph, /aresample=48000,volume=0\.7071,adelay=\d+S:all=1\[episodea0\]/u);
  assert.match(mix.filterGraph, /aresample=48000,volume=0\.7071,adelay=\d+S:all=1\[episodea1\]/u);
  assert.match(mix.filterGraph, /aresample=48000,adelay=\d+S:all=1\[episodea2\]/u);
});

test("three speakers can join one simultaneous group, all aligned to the first line", () => {
  const compiled = compileEpisodeTiming(manifest([
    line("u1", "a", 1.0, 0.1),
    line("u2", "b", 0.9, 0.12, { simultaneousWithPrevious: true }),
    line("u3", "c", 1.1, 0.08, { simultaneousWithPrevious: true }),
  ]));
  const [, second, third] = compiled.utterances;
  assert.equal(second.timing.simultaneousWithUtteranceId, "u1");
  assert.equal(third.timing.simultaneousWithUtteranceId, "u1");
  close(third.timing.audioStartInCutSeconds, 0.12);
  assert.equal(third.timing.mixGain, 0.5774);
});

test("a simultaneous line ignores an authored pause and refuses to start a cut or repeat a speaker", () => {
  const compiled = compileEpisodeTiming(manifest([
    line("u1", "a", 1.0, 0.1),
    line("u2", "b", 1.0, 0.1, { simultaneousWithPrevious: true, pauseBeforeSeconds: 2 }),
  ]));
  close(compiled.utterances[1].timing.audioStartInCutSeconds, 0.1);
  assert.throws(
    () => compileEpisodeTiming(manifest([line("u1", "a", 1.0, 0.1, { simultaneousWithPrevious: true })])),
    /first line of cut-1/u,
  );
  assert.throws(
    () => compileEpisodeTiming(manifest([
      line("u1", "a", 1.0, 0.1),
      line("u2", "a", 1.0, 0.1, { simultaneousWithPrevious: true }),
    ])),
    /already speaks in that simultaneous group/u,
  );
});

test("a line without the flag keeps the existing sequential timing", () => {
  const compiled = compileEpisodeTiming(manifest([
    line("u1", "a", 1.0, 0.1),
    line("u2", "b", 1.0, 0.1),
  ]));
  close(compiled.utterances[1].timing.audioStartInCutSeconds, 0.1 + 1.0 + 0.3);
  assert.equal(compiled.utterances[1].timing.simultaneousWithUtteranceId, undefined);
  assert.equal(compiled.utterances[0].timing.mixGain, undefined);
});

test("a character-bible speech direction marks a line as simultaneous only after a different speaker in the same cut", () => {
  const base = {
    cuts: [{ id: "cut-1", utteranceIds: ["u1", "u2"] }, { id: "cut-2", utteranceIds: ["u3"] }],
    utterances: [
      { id: "u1", cutId: "cut-1", speakerId: "a", text: "！" },
      { id: "u2", cutId: "cut-1", speakerId: "b", text: "！" },
      { id: "u3", cutId: "cut-2", speakerId: "b", text: "！" },
    ],
  };
  const marked = applyKoyaCharacterBibleSpeechDirectives(base, {
    speechDirections: [{ utteranceId: "u2", performancePrompt: "", speechText: "っ！", simultaneousWithPrevious: true }],
  });
  assert.equal(marked.utterances[1].simultaneousWithPrevious, true);
  assert.equal(marked.utterances[1].speechOverride, "っ！");
  assert.throws(
    () => applyKoyaCharacterBibleSpeechDirectives(base, {
      speechDirections: [{ utteranceId: "u3", performancePrompt: "", simultaneousWithPrevious: true }],
    }),
    /needs an earlier line in the same cut/u,
  );
  assert.throws(
    () => applyKoyaCharacterBibleSpeechDirectives(base, {
      speechDirections: [{ utteranceId: "u2", performancePrompt: "", simultaneousWithPrevious: "yes" }],
    }),
    /must be a boolean/u,
  );
  const sameSpeaker = structuredClone(base);
  sameSpeaker.utterances[1].speakerId = "a";
  assert.throws(
    () => applyKoyaCharacterBibleSpeechDirectives(sameSpeaker, {
      speechDirections: [{ utteranceId: "u2", performancePrompt: "", simultaneousWithPrevious: true }],
    }),
    /needs a different speaker/u,
  );
});
