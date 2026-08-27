import assert from "node:assert/strict";
import test from "node:test";

import { selectKoyaDialogueTake } from "../lib/koyaDialogueSpeech.mjs";
import {
  activeReadingEntries,
  exportElevenLabsLexicon,
  mergeIntoPronunciations,
  recordMisreading,
} from "../lib/readingDictionary.mjs";
import { voiceQualityPenalty } from "../lib/voiceQualityGate.mjs";

test("misreadings escalate to active on the second observation", () => {
  const dictionary = { entries: [] };
  const first = recordMisreading(dictionary, { surface: "誠司", reading: "せいじ", context: "canary cut-01" });
  assert.equal(first.status, "candidate");
  assert.equal(activeReadingEntries(dictionary).length, 0);
  const second = recordMisreading(dictionary, { surface: "誠司", reading: "せいじ", context: "arano cut-03" });
  assert.equal(second.status, "active");
  assert.equal(second.occurrences, 2);
  assert.deepEqual(second.contexts, ["canary cut-01", "arano cut-03"]);
  assert.throws(
    () => recordMisreading(dictionary, { surface: "誠司", reading: "まさし" }),
    /conflicting reading/,
  );
});

test("episode pronunciations win over channel dictionary on merge", () => {
  const dictionary = {
    entries: [
      { from: "誠司", to: "せいじ", status: "active" },
      { from: "点検", to: "てんけん", status: "candidate" },
      { from: "山間", to: "さんかん", status: "active" },
    ],
  };
  const merged = mergeIntoPronunciations(dictionary, [{ from: "誠司", to: "まさし" }]);
  const bySurface = Object.fromEntries(merged.map((entry) => [entry.from, entry.to]));
  assert.equal(bySurface["誠司"], "まさし");
  assert.equal(bySurface["山間"], "さんかん");
  assert.equal(bySurface["点検"], undefined);
});

test("lexicon export produces PLS alias entries for active readings only", () => {
  const dictionary = {
    entries: [
      { from: "誠司", to: "せいじ", status: "active" },
      { from: "点検", to: "てんけん", status: "candidate" },
    ],
  };
  const xml = exportElevenLabsLexicon(dictionary);
  assert.match(xml, /<grapheme>誠司<\/grapheme>/);
  assert.match(xml, /<alias>せいじ<\/alias>/);
  assert.ok(!xml.includes("点検"));
  assert.match(xml, /pronunciation-lexicon/);
});

test("voice quality penalties reorder take selection and hard failures sink", () => {
  const pass = voiceQualityPenalty({ status: "pass", metrics: { utmos: 3.8, cer: 0.03 }, problems: [] });
  const bad = voiceQualityPenalty({ status: "fail", metrics: { utmos: 3.9, cer: 0.4 }, problems: ["cer"] });
  assert.equal(pass.hardFail, false);
  assert.equal(bad.hardFail, true);
  assert.ok(bad.penalty > 100);
  assert.throws(() => voiceQualityPenalty({ status: "maybe" }), /gate check result/);

  const cutPlan = { cutId: "cut-01", inputs: [] };
  const candidates = [
    { takeIndex: 0, sourcePath: "a.wav", quality: { score: 0.2, rows: [] } },
    { takeIndex: 1, sourcePath: "b.wav", quality: { score: 0.35, rows: [] } },
  ];
  const withoutGate = selectKoyaDialogueTake(candidates, cutPlan);
  assert.equal(withoutGate.takeIndex, 0);
  const withGate = selectKoyaDialogueTake(candidates, cutPlan, null, { 0: bad, 1: pass });
  assert.equal(withGate.takeIndex, 1);
  assert.equal(
    withGate.candidateSelection.method,
    "alignment-completeness-edge-room-scene-paced-cps-and-r194-voice-quality",
  );
  const sunk = withGate.candidateSelection.candidates.find((entry) => entry.takeIndex === 0);
  assert.ok(sunk.combinedScore > 100);
});
