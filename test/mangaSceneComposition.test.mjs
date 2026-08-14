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

test("spoken evidence dialogue never uses a face-hiding overhead setup", () => {
  const manifest = {
    id: "spoken-evidence-face",
    cuts: [{ id: "cut-01", utteranceIds: ["cut-01-u01", "cut-01-u02"] }],
    utterances: [
      { id: "cut-01-u01", cutId: "cut-01", speakerId: "narration", preset: "narration", text: "古い記録を調べた。" },
      { id: "cut-01-u02", cutId: "cut-01", speakerId: "hero", speakerName: "佐藤", preset: "dialogue", text: "小さな利用者を消したのは、路線ではなく記録のほうです" },
    ],
  };
  const plan = planMangaSceneCompositions({ manifest });
  const dialogue = plan.beats[1];
  assert.notEqual(dialogue.setup.id, "overhead-workbench");
  assert.match(buildMangaSceneImagePrompt(dialogue), /Spoken-dialogue face contract/u);
});

test("new scene openings and reunion establishing beats never default to an overhead insert", () => {
  const plan = planMangaSceneCompositions({
    manifest: {
      id: "scene-establishing-test",
      cuts: [{ id: "c1", description: "大学4年、高校の同窓会", utteranceIds: ["u1", "u2"] }],
      utterances: [
        { id: "u1", cutId: "c1", speakerId: "narration", preset: "narration", text: "時は流れ、俺は大学4年生になっていた。" },
        { id: "u2", cutId: "c1", speakerId: "narration", preset: "narration", text: "華やかな同窓会の会場で周りを見渡すと目が合った。" },
      ],
    },
  });
  assert.ok(plan.beats.every((beat) => ["establishing-deep", "exterior-through-glass"].includes(beat.setup.id)));
  assert.ok(plan.beats.every((beat) => beat.setup.elevation !== "overhead"));
});

test("a location word in the cut title establishes only the opening and does not flatten later dialogue coverage", () => {
  const plan = planMangaSceneCompositions({
    manifest: {
      id: "scene-title-scope-test",
      cuts: [{ id: "c1", description: "秋の放課後、音楽室での別れ", utteranceIds: ["u1", "u2", "u3"] }],
      utterances: [
        { id: "u1", cutId: "c1", speakerId: "sakura", speakerName: "花園さくら", preset: "dialogue", text: "話があるの" },
        { id: "u2", cutId: "c1", speakerId: "arano", speakerName: "荒野", preset: "dialogue", text: "冗談だろ？" },
        { id: "u3", cutId: "c1", speakerId: "sakura", speakerName: "花園さくら", preset: "dialogue", text: "がっかりしたわ" },
      ],
    },
  });
  assert.equal(plan.beats[0].intent, "scene-establishing");
  assert.notEqual(plan.beats[1].intent, "scene-establishing");
  assert.notEqual(plan.beats[2].intent, "scene-establishing");
  assert.ok(plan.beats.slice(1).every((beat) => !["establishing-deep", "exterior-through-glass"].includes(beat.setup.id)));
});

test("season transitions and education choices avoid generic overhead workbench narration", () => {
  const plan = planMangaSceneCompositions({
    manifest: {
      id: "semantic-narration-test",
      cuts: [{ id: "c1", description: "音楽室", utteranceIds: ["u1", "u2", "u3"] }],
      utterances: [
        { id: "u1", cutId: "c1", speakerId: "sakura", preset: "dialogue", text: "話があるの" },
        { id: "u2", cutId: "c1", speakerId: "narration", preset: "narration", text: "新学期が始まって間もない秋の放課後。" },
        { id: "u3", cutId: "c1", speakerId: "narration", preset: "narration", text: "英語を専門的に学べる大学を選んだ。" },
      ],
    },
  });
  assert.equal(plan.beats[1].intent, "time-transition");
  assert.equal(plan.beats[2].intent, "purpose-reflection");
  assert.ok(plan.beats.slice(1).every((beat) => beat.setup.id !== "overhead-workbench"));
});

test("departure narration shows the exit and remaining reactions instead of a hands macro", () => {
  const plan = planMangaSceneCompositions({
    manifest: {
      id: "departure-narration-test",
      cuts: [{ id: "c1", description: "同窓会", utteranceIds: ["u1", "u2"] }],
      utterances: [
        { id: "u1", cutId: "c1", speakerId: "sakura", preset: "dialogue", text: "私は帰るわ" },
        { id: "u2", cutId: "c1", speakerId: "narration", preset: "narration", text: "彼女は同級生たちを無視して去っていった。" },
      ],
    },
  });
  const departure = plan.beats[1];
  assert.equal(departure.intent, "departure");
  assert.ok(["ots-entry", "doorway-low-intrusion", "exterior-through-glass"].includes(departure.setup.id));
  assert.notEqual(departure.setup.id, "macro-hands");
  assert.notEqual(departure.setup.elevation, "overhead");
  assert.match(departure.visibleAction, /departing character/u);
  assert.match(buildMangaSceneImagePrompt(departure, { location: "同窓会", cast: ["荒野", "花園さくら"] }), /non-primary crowd/u);
});

test("arrival and confidence-collapse narration use readable character reactions instead of workbench inserts", () => {
  const plan = planMangaSceneCompositions({
    manifest: {
      id: "arrival-reaction-test",
      cuts: [{ id: "c1", description: "街中", utteranceIds: ["u1", "u2", "u3"] }],
      utterances: [
        { id: "u1", cutId: "c1", speakerId: "arano", preset: "dialogue", text: "もう関係ない" },
        { id: "u2", cutId: "c1", speakerId: "narration", preset: "narration", text: "そこへ天音が到着した。" },
        { id: "u3", cutId: "c1", speakerId: "narration", preset: "narration", text: "天音の言葉に、さくらの勢いは完全に削がれた。" },
      ],
    },
  });
  assert.equal(plan.beats[1].intent, "arrival");
  assert.ok(["ots-entry", "doorway-low-intrusion", "exterior-through-glass", "ots-reaction"].includes(plan.beats[1].setup.id));
  assert.equal(plan.beats[2].intent, "deflation-reaction");
  assert.ok(["ots-reaction", "high-vulnerable-single", "negative-space-profile"].includes(plan.beats[2].setup.id));
  assert.ok(plan.beats.slice(1).every((beat) => beat.setup.id !== "overhead-workbench" && beat.setup.id !== "macro-hands"));
});
