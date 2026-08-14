import test from "node:test";
import assert from "node:assert/strict";

import {
  auditMangaEditorialPlan,
  classifyMangaEditorialBeat,
} from "../lib/mangaEditorialGrammar.mjs";

test("a story-three montage takes precedence over an incompatible characterless plate", () => {
  const result = classifyMangaEditorialBeat({
    utterance: { id: "n1", preset: "narration", text: "翌週、約束の光だけが静かに残った。" },
    montageBeatCount: 3,
  });
  assert.equal(result.backgroundOnly.recommended, false);
  assert.equal(result.editorialPlate.type, null);
  assert.equal(result.editorialPlate.environmentPolicy, "none");
  assert.equal(result.split.type, "story-3");
  assert.equal(result.split.composition, "post-composite-on-black-then-flatten");
  assert.equal(result.split.panelCamera, "static");
  assert.equal(result.split.pageCamera, "single-continuous");
  assert.equal(result.split.flattenBeforeCamera, true);
  assert.equal(result.bubble.preset, "narration");
});

test("opening premise and heavy counterpoint select white and black plates, never rooms", () => {
  const opening = classifyMangaEditorialBeat({
    utterance: { id: "n-white", preset: "narration", text: "写真は光を証明する。" },
    openingExposition: true,
  });
  const counterpoint = classifyMangaEditorialBeat({
    utterance: { id: "n-black", preset: "narration", text: "けれど名前まで守ってくれるわけではない。" },
    openingExposition: true,
  });
  assert.equal(opening.editorialPlate.type, "white-solid");
  assert.equal(counterpoint.editorialPlate.type, "black-solid");
  assert.equal(opening.backgroundOnly.style, "white-solid");
  assert.equal(counterpoint.backgroundOnly.environmentPolicy, "none");
});

test("thoughtful narration remains narration rather than becoming an inner voice", () => {
  const result = classifyMangaEditorialBeat({
    utterance: {
      id: "n-thoughtful",
      preset: "narration",
      text: "写真は光を証明する。",
      performancePrompt: "[thoughtful]",
    },
    openingExposition: true,
  });
  assert.equal(result.bubble.preset, "narration");
  assert.equal(result.thoughtFocus.recommended, false);
});

test("private uncertainty selects the radial thought balloon and compact face light", () => {
  const result = classifyMangaEditorialBeat({
    utterance: { id: "t1", preset: "thought", text: "澪なのか？ 東京にいるはずじゃ……" },
  });
  assert.equal(result.thoughtFocus.recommended, true);
  assert.equal(result.thoughtFocus.dimOpacity, 0.31);
  assert.equal(result.thoughtFocus.faceBrightnessLift, 0.1);
  assert.deepEqual(result.thoughtFocus.faceRadiusScale, { x: 0.69, y: 0.7 });
  assert.equal(result.bubble.preset, "thought");
});

test("a firm confrontation selects a two-panel contrast and curved burst", () => {
  const result = classifyMangaEditorialBeat({
    utterance: { id: "s1", preset: "dialogue", text: "私は戻らない。絶対に譲らない！" },
    visibleParticipantCount: 2,
  });
  assert.equal(result.split.type, "vertical-2");
  assert.equal(result.bubble.preset, "shout");
});

test("the frame-37 balloon is gated to rare stammered apologies", () => {
  const rare = classifyMangaEditorialBeat({
    utterance: { id: "p1", preset: "dialogue", text: "ご、ごごごめんなさぁぁぁい!!" },
  });
  const ordinary = classifyMangaEditorialBeat({
    utterance: { id: "p2", preset: "dialogue", text: "ごめんなさい" },
  });
  assert.equal(rare.bubble.preset, "tremble");
  assert.equal(ordinary.bubble.preset, "dialogue");
});

test("audit reports the applied visual grammar without promoting every line", () => {
  const audit = auditMangaEditorialPlan([
    { utterance: { preset: "thought", text: "どうしよう" } },
    { utterance: { preset: "dialogue", text: "おはよう" } },
    { utterance: { preset: "narration", text: "翌週、約束の光が静かに残った。" }, montageBeatCount: 3 },
  ]);
  assert.equal(audit.counts.thoughtFocus, 1);
  assert.equal(audit.counts.backgroundOnly, 0);
  assert.equal(audit.counts.pastelPlate, 0);
  assert.equal(audit.counts.split3, 1);
  assert.equal(audit.counts.tremble, 0);
});
