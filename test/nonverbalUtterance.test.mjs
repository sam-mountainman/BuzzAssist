import assert from "node:assert/strict";
import { test } from "node:test";

import {
  defaultNonverbalSpeechText,
  isNonverbalUtteranceText,
  nonverbalPerformanceTag,
} from "../lib/nonverbalUtterance.mjs";
import { koyaPerformanceTag, prepareKoyaDialogueCut } from "../lib/koyaDialogueSpeech.mjs";
import { applyKoyaCharacterBibleSpeechDirectives } from "../lib/koyaMangaProduction.mjs";
import { voiceQualityPenalty } from "../lib/voiceQualityGate.mjs";

test("symbol-only lines are nonverbal, lines with any word are not", () => {
  for (const text of ["！", "…", "？", "！？", "…ッ！", "……", "っ！"]) {
    assert.equal(isNonverbalUtteranceText(text), true, text);
  }
  for (const text of ["う…", "くっ…！", "そ、それは…", "え？", "", "   "]) {
    assert.equal(isNonverbalUtteranceText(text), false, text);
  }
});

test("nonverbal lines get a speakable default reading and a non-angry tag", () => {
  assert.equal(defaultNonverbalSpeechText("！"), "っ！");
  assert.equal(defaultNonverbalSpeechText("…"), "…っ");
  assert.equal(defaultNonverbalSpeechText("…ッ！"), "…っ！");
  assert.equal(defaultNonverbalSpeechText("！？"), "っ！？");
  assert.equal(defaultNonverbalSpeechText("？"), "ん？");
  assert.equal(nonverbalPerformanceTag("！"), "[gasps]");
  assert.equal(nonverbalPerformanceTag("…"), "[sighs]");
  assert.equal(koyaPerformanceTag({ text: "！", preset: "shout" }), "[gasps]");
  assert.equal(koyaPerformanceTag({ text: "絶対に守る！" }), "[angry]", "worded lines keep the old rule");
});

test("dialogue cut sends a speakable reading for a nonverbal line and marks only that input", () => {
  const manifest = {
    utterances: [
      { id: "c-u01", text: "知ってるよ", speakerId: "a", voiceId: "voice-a", preset: "dialogue" },
      { id: "c-u02", text: "！", speechText: "!", speakerId: "b", voiceId: "voice-b", preset: "shout" },
      { id: "c-u03", text: "…ッ！", speechOverride: "…くっ！", speakerId: "a", voiceId: "voice-a", preset: "dialogue" },
    ],
  };
  const plan = prepareKoyaDialogueCut(manifest, { id: "c", utteranceIds: ["c-u01", "c-u02", "c-u03"] });
  assert.equal(plan.inputs[0].nonverbal, undefined, "worded inputs keep their recorded shape");
  assert.equal(Object.hasOwn(plan.inputs[0], "nonverbal"), false);
  assert.equal(plan.inputs[1].nonverbal, true);
  assert.equal(plan.inputs[1].speechText, "っ！");
  assert.equal(plan.inputs[1].providerText, "[gasps] っ！");
  assert.equal(plan.inputs[2].speechText, "...くっ!", "an authored reading wins over the default");
});

test("character-bible speech directions may set a reading for a nonverbal line", () => {
  const manifest = { utterances: [{ id: "u1", text: "…ッ！" }, { id: "u2", text: "…" }] };
  const directed = applyKoyaCharacterBibleSpeechDirectives(manifest, {
    cast: [],
    speechDirections: [{ utteranceId: "u1", performancePrompt: "[gasps]", speechText: "…っ！" }],
  });
  assert.equal(directed.utterances[0].speechOverride, "…っ！");
  assert.equal(directed.utterances[0].text, "…ッ！", "the displayed text is unchanged");
  assert.equal(directed.utterances[1].speechOverride, undefined);
  assert.throws(
    () => applyKoyaCharacterBibleSpeechDirectives(manifest, {
      cast: [],
      speechDirections: [{ utteranceId: "u2", performancePrompt: "", speechText: "  " }],
    }),
    /speechText must be a non-empty string/u,
  );
});

test("a voiced nonverbal segment satisfies the CER requirement, a silent one does not", () => {
  const check = (voiced) => ({
    status: voiced ? "pass" : "fail",
    problems: voiced ? [] : ["nonverbal[u2] silent"],
    metrics: {
      segmentUtmosApplied: false,
      utmos: 3.4,
      segments: [
        { id: "u1", cer: 0.02 },
        { id: "u2", nonverbal: true, nonverbalVoiced: voiced, nonverbalPeakDbfs: voiced ? -18 : -60 },
      ],
    },
  });
  const voiced = voiceQualityPenalty(check(true), { requiredMetrics: ["utmos", "cer"] });
  assert.equal(voiced.hardFail, false);
  assert.deepEqual(voiced.missingRequiredMetrics, []);
  const silent = voiceQualityPenalty(check(false), { requiredMetrics: ["utmos", "cer"] });
  assert.equal(silent.hardFail, true);
  assert.deepEqual(silent.missingRequiredMetrics, ["cer"]);
  const unmarked = voiceQualityPenalty({
    status: "pass",
    metrics: { utmos: 3.4, segments: [{ id: "u2", nonverbalVoiced: true }] },
  }, { requiredMetrics: ["cer"] });
  assert.equal(unmarked.hardFail, true, "only segments marked nonverbal may skip CER");
});
