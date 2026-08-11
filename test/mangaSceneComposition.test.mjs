import test from "node:test";
import assert from "node:assert/strict";

import {
  auditMangaCompositionSequence,
  buildMangaSceneImagePrompt,
  planMangaSceneCompositions,
} from "../lib/mangaSceneComposition.mjs";

const manifest = {
  id: "composition-test",
  utterances: [
    { id: "u1", cutId: "c1", speakerId: "narration", preset: "narration", text: "雨の写真店で現像を続けていた。" },
    { id: "u2", cutId: "c1", speakerId: "ren", speakerName: "蓮", preset: "dialogue", text: "この現像だけ終わらせよう" },
    { id: "u3", cutId: "c2", speakerId: "mio", speakerName: "澪", preset: "dialogue", text: "帰ってきたの。帰りたい場所が分からない" },
    { id: "u4", cutId: "c2", speakerId: "ren", speakerName: "蓮", preset: "thought", text: "澪なのか？" },
    { id: "u5", cutId: "c3", speakerId: "ren", speakerName: "蓮", preset: "dialogue", text: "十年前のネガと依頼票が残っています" },
    { id: "u6", cutId: "c3", speakerId: "reiji", speakerName: "玲司", preset: "dialogue", text: "そんな古い記録が何になる" },
  ],
};

test("semantic composition planner changes at least three camera axes between adjacent beats", () => {
  const plan = planMangaSceneCompositions({ manifest });
  assert.equal(plan.beats.length, manifest.utterances.length);
  assert.equal(plan.diagnostics.consecutiveTooSimilarCount, 0);
  assert.ok(plan.diagnostics.uniqueSetupCount >= 5);
  assert.ok(plan.beats.slice(1).every((beat) => beat.changeFromPreviousAxes >= 3));
  assert.deepEqual(auditMangaCompositionSequence(plan), { ok: true, issueCount: 0, issues: [] });
});

test("generated image prompt binds camera to visible story action and forbids copying reference poses", () => {
  const plan = planMangaSceneCompositions({ manifest });
  const evidence = plan.beats.find((beat) => beat.utteranceId === "u5");
  const prompt = buildMangaSceneImagePrompt(evidence, { location: "雨夜の写真店", cast: ["蓮", "玲司"] });
  assert.match(prompt, /exact evidence or recording medium/i);
  assert.match(prompt, /Do not copy their camera position or pose/);
  assert.match(prompt, /No speech bubble/);
  assert.match(prompt, /1920x1080/);
});
