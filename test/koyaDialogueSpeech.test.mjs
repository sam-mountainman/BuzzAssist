import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyKoyaSpeechPronunciations,
  buildKoyaDialogueRequest,
  koyaPerformanceTag,
  prepareKoyaDialogueCut,
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
