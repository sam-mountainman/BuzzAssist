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
  assert.match(prompt, /public venue, workplace, street, or event hall by itself does not authorize invented bystanders/u);
  assert.match(prompt, /1920x1080/);
});

test("spoken evidence dialogue never uses a face-hiding overhead or extreme-macro setup", () => {
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
  assert.notEqual(dialogue.setup.id, "macro-hands");
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

test("same-location cut boundaries preserve the scripted physical action instead of resetting to an establishing shot", () => {
  const plan = planMangaSceneCompositions({
    manifest: {
      id: "same-location-action-test",
      cuts: [
        { id: "c1", description: "小さな地域催事場", locationId: "event-hall", utteranceIds: ["u1"] },
        { id: "c2", description: "同じ受付でテスト話者Aが動く", locationId: "event-hall", utteranceIds: ["u2"] },
      ],
      utterances: [
        { id: "u1", cutId: "c1", speakerId: "narration", preset: "narration", text: "開場前の受付は静かだった。" },
        { id: "u2", cutId: "c2", speakerId: "narration", preset: "narration", text: "テスト話者Aは箱の上から前足で偽パスを床へ落とした。" },
      ],
    },
  });
  assert.equal(plan.beats[0].intent, "scene-establishing");
  assert.equal(plan.beats[1].intent, "object-action");
  assert.match(plan.beats[1].purpose, /required destination/u);
  assert.match(plan.beats[1].visibleAction, /direction of travel/u);
});

test("multi-action narration in the final cut becomes a coherent resolution tableau", () => {
  const plan = planMangaSceneCompositions({
    manifest: {
      id: "closing-resolution-test",
      cuts: [
        { id: "c1", description: "受付での対決", locationId: "event-hall", utteranceIds: ["u1"] },
        { id: "c2", description: "同じ会場での締め", locationId: "event-hall", utteranceIds: ["u2", "u3"] },
      ],
      utterances: [
        { id: "u1", cutId: "c1", speakerId: "hero", speakerName: "主人公", preset: "dialogue", text: "証拠は残っています。" },
        { id: "u2", cutId: "c2", speakerId: "narration", preset: "narration", text: "悪役は出口で固まり、時計を袖で隠した。店主はうなずき、主人公は静かに受付へ戻った。" },
        { id: "u3", cutId: "c2", speakerId: "hero", speakerName: "主人公", preset: "dialogue", text: "終わりました。" },
      ],
    },
  });
  const resolution = plan.beats.find((beat) => beat.utteranceId === "u2");
  assert.equal(resolution.intent, "resolution-montage");
  assert.match(resolution.purpose, /simultaneous closing outcomes/u);
  assert.match(resolution.visibleAction, /closing tableau/u);
  assert.match(buildMangaSceneImagePrompt(resolution, { cast: ["悪役", "店主", "主人公"] }), /do not contort anatomy/u);
});

test("abstract closing narration is not mistaken for a multi-character physical tableau", () => {
  const plan = planMangaSceneCompositions({
    manifest: {
      id: "closing-principle-test",
      cuts: [{ id: "c1", description: "締め", locationId: "event-hall", utteranceIds: ["u1", "u2"] }],
      utterances: [
        { id: "u1", cutId: "c1", speakerId: "hero", speakerName: "主人公", preset: "dialogue", text: "終わりました。" },
        { id: "u2", cutId: "c1", speakerId: "narration", preset: "narration", text: "消された席は元に戻り、催事は予定通り始まった。仕組みは事実を残す。その事実を使うのは人間の役目だ。" },
      ],
    },
  });
  assert.equal(plan.beats[1].intent, "narration");
});

test("a real location change still establishes the new scene", () => {
  const plan = planMangaSceneCompositions({
    manifest: {
      id: "new-location-establishing-test",
      cuts: [
        { id: "c1", description: "店内", locationId: "shop", utteranceIds: ["u1"] },
        { id: "c2", description: "駅前", locationId: "station", utteranceIds: ["u2"] },
      ],
      utterances: [
        { id: "u1", cutId: "c1", speakerId: "narration", preset: "narration", text: "店を出た。" },
        { id: "u2", cutId: "c2", speakerId: "narration", preset: "narration", text: "駅前で時計を見た。" },
      ],
    },
  });
  assert.equal(plan.beats[1].intent, "scene-establishing");
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
