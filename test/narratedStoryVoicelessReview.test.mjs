#!/usr/bin/env node

// 声なしの部（感想パート）の時間割と境目の実測（lib/narratedStoryBookends.mjs）。合成の値だけを使う。

import assert from "node:assert/strict";
import test from "node:test";

import { planNarratedBookendProgram } from "../lib/narratedStoryBookends.mjs";

test("時間割: 声なしの感想の部に voice: none が付き、声ありの部には付かない", () => {
  const transitions = { storyToReview: { type: "hard-cut", durationSeconds: 0, leadInSeconds: 0.25 } };
  const story = [{ id: "p1", durationSeconds: 1 }];
  const review = [{ id: "r1", durationSeconds: 1.5 }];
  const voiceless = planNarratedBookendProgram({ fps: 24, story, review, reviewVoice: "none", transitions });
  assert.equal(voiceless.parts.find((part) => part.id === "review").voice, "none");
  const voiced = planNarratedBookendProgram({ fps: 24, story, review, transitions });
  assert.equal(voiced.parts.find((part) => part.id === "review").voice, undefined);
});
