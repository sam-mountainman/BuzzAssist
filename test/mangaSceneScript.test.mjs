// 台本ツールから届く「場面台本」形式（冒頭ブロック＋「#場面 N 場所・時間帯」）の読み取り。
// 名前・場所はすべて架空の汎用名。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  detectMangaScriptFormat,
  parseSceneScriptFrontMatter,
  planSceneCutBoundaries,
  splitSceneHeading,
} from "../lib/mangaSceneScript.mjs";
import { parseMangaScript } from "../lib/mangaVideoPipeline.mjs";
import { createMangaScriptImagePlan } from "../lib/mangaScriptImagePipeline.mjs";
import { detectMangaEyeOpenBeats } from "../lib/mangaEyeOpenBeats.mjs";
import {
  assertKoyaDeclaredProtagonist,
  resolveKoyaProtagonistSpeaker,
} from "../lib/koyaMangaProductionContract.mjs";
import { createKoyaStoryReviewDraft } from "../lib/koyaChannelGovernance.mjs";
import { planKoyaMangaProduction } from "../lib/koyaMangaProduction.mjs";

const BOM = "\uFEFF";

const SCENE_SCRIPT = `---
タイトル: 企画書の本当の作者
サムネ:
  帯1行目: 企画書を奪った先輩
  帯2行目: 記録が全部残っていた
  テロップ: 記録
  型: 2コマ
  吹き出し:
    - 話者: 佐藤健
      文言: 記録だと!?
    - 話者: 山田花子
      文言: 全部／残ってます
登場人物:
  - 名前: 山田花子
    区分: 今回限り
    主人公: はい
    性別: 女
    年齢: 28
    職業: 経理課の社員
    見た目: 黒髪のボブ、眼鏡
  - 名前: 佐藤健
    区分: 固定
    主人公: いいえ
  - 名前: 鈴木
    区分: 固定
    主人公: いいえ
場所: オフィス／喫茶店
---

#場面 1 オフィス・昼

その企画書を書いたのは私だ。三週間、毎晩残って詰めた。

佐藤健：この企画、俺が一から考えたものでね
山田花子（心）：一字一句、私の文章のままだ

#場面 2 会議室・昼

鈴木：その企画書、作成者の記録を確認させてください
佐藤健：「証拠でもあるのか」
山田花子：記録が残っています

会議室が静まり返った。

佐藤健：記録だと！？

#場面 3 喫茶店・夜

課長：あの二人、どうなったんだ
佐藤健が静かに開眼した。
そのとき、店長が言った：「今日は貸し切りだよ」
午前10:30、店の扉が開いた。
`;

const REGISTRY = {
  characters: [
    { id: "hanako", name: "山田花子", aliases: ["花子"], status: "approved" },
    { id: "ken", name: "佐藤健", aliases: [], status: "approved" },
  ],
  voices: [],
};

const PLAN_PATHS = { assetDir: "/nonexistent/canvas/assets/x", canvasDir: "/nonexistent/canvas" };

function lineOf(script, text) {
  const index = script.split("\n").findIndex((line) => line.includes(text));
  assert.ok(index >= 0, `fixture line not found: ${text}`);
  return index + 1;
}

function speakerHash(name) {
  return `speaker-${createHash("sha256").update(name).digest("hex").slice(0, 10)}`;
}

function sceneScript({ frontMatter = "", body }) {
  return frontMatter ? `---\n${frontMatter}\n---\n\n${body}` : body;
}

function codesAndLines(warnings) {
  return warnings.map(({ code, line }) => ({ code, line }));
}

test("scene-script front matter is read as a two-level map with the thumbnail block kept verbatim", () => {
  const parsed = parseMangaScript(SCENE_SCRIPT, { registry: REGISTRY });
  assert.equal(parsed.format, "scene-script");
  assert.equal(parsed.title, "企画書の本当の作者");
  assert.deepEqual(parsed.frontMatter, {
    タイトル: "企画書の本当の作者",
    サムネ: {
      帯1行目: "企画書を奪った先輩",
      帯2行目: "記録が全部残っていた",
      テロップ: "記録",
      型: "2コマ",
      吹き出し: [
        { 話者: "佐藤健", 文言: "記録だと!?" },
        { 話者: "山田花子", 文言: "全部／残ってます" },
      ],
    },
    登場人物: [
      { 名前: "山田花子", 区分: "今回限り", 主人公: "はい", 性別: "女", 年齢: "28", 職業: "経理課の社員", 見た目: "黒髪のボブ、眼鏡" },
      { 名前: "佐藤健", 区分: "固定", 主人公: "いいえ" },
      { 名前: "鈴木", 区分: "固定", 主人公: "いいえ" },
    ],
    場所: "オフィス／喫茶店",
  });
  assert.deepEqual(parsed.cast, [
    { name: "山田花子", category: "one-off", isProtagonist: true, gender: "女", age: "28", occupation: "経理課の社員", appearance: "黒髪のボブ、眼鏡" },
    { name: "佐藤健", category: "fixed", isProtagonist: false, gender: "", age: "", occupation: "", appearance: "" },
    { name: "鈴木", category: "fixed", isProtagonist: false, gender: "", age: "", occupation: "", appearance: "" },
  ]);
  assert.equal(parsed.protagonistName, "山田花子");
});

test("front matter parser mirrors the intake checker and keeps hostile keys as plain data", () => {
  const frontMatter = parseSceneScriptFrontMatter([
    "タイトル：全角コロンの題",
    "__proto__: 汚染しない",
    "登場人物:",
    "  - 名前: 田中",
    "    区分: 準レギュラー",
    "  - ただの文字列",
    "場所:",
    "メモ: 10:30に集合",
  ]);
  assert.equal(frontMatter.タイトル, "全角コロンの題");
  assert.equal(Object.getPrototypeOf(frontMatter), Object.prototype);
  assert.equal(Object.prototype.hasOwnProperty.call(frontMatter, "__proto__"), true);
  assert.equal({}.polluted, undefined);
  // A list item without a colon becomes an empty map, exactly like the checker.
  assert.deepEqual(frontMatter.登場人物, [{ 名前: "田中", 区分: "準レギュラー" }, {}]);
  // An empty value opens a nested map, as in the checker.
  assert.deepEqual(frontMatter.場所, {});
  assert.equal(frontMatter.メモ, "10:30に集合");

  // Unknown 区分 values are kept as given.
  const parsed = parseMangaScript(sceneScript({
    frontMatter: "登場人物:\n  - 名前: 田中\n    区分: 準レギュラー\n    主人公: はい",
    body: "#場面 1 会議室・朝\n田中：おはようございます",
  }));
  assert.equal(parsed.cast[0].category, "準レギュラー");
  // An empty タイトル (a nested map) does not become the title.
  assert.equal(parseMangaScript(sceneScript({
    frontMatter: "タイトル:\n登場人物:\n  - 名前: 田中\n    主人公: はい",
    body: "#場面 1 会議室・朝\n田中：おはようございます",
  })).title, "漫画動画");
});

test("three scenes become cuts with scene, place, and location; narration and inner voice keep their presets", () => {
  const parsed = parseMangaScript(SCENE_SCRIPT, { registry: REGISTRY });
  assert.deepEqual(parsed.cuts.map((cut) => cut.id), ["cut-01", "cut-02", "cut-03", "cut-04"]);
  assert.deepEqual(parsed.cuts.map((cut) => cut.number), [1, 2, 3, 4]);
  assert.deepEqual(parsed.cuts.map((cut) => cut.purpose), ["オフィス・昼", "会議室・昼", "会議室・昼", "喫茶店・夜"]);
  assert.deepEqual(parsed.cuts[0].scene, { number: 1, heading: "オフィス・昼", place: "オフィス", timeOfDay: "昼" });
  assert.deepEqual(parsed.cuts[2].scene, { number: 2, heading: "会議室・昼", place: "会議室", timeOfDay: "昼" });
  assert.deepEqual(parsed.cuts.map((cut) => cut.location), [
    { name: "オフィス" }, { name: "会議室" }, { name: "会議室" }, { name: "喫茶店" },
  ]);
  assert.deepEqual(parsed.cuts[0].utterances, [
    {
      id: "cut-01-u01",
      cutId: "cut-01",
      order: 1,
      speakerName: "ナレーション",
      speakerId: "narration",
      text: "その企画書を書いたのは私だ。三週間、毎晩残って詰めた。",
      bubbleId: "bubble-cut-01-u01",
      preset: "narration",
      isProtagonist: false,
      innerVoice: false,
    },
    {
      id: "cut-01-u02",
      cutId: "cut-01",
      order: 2,
      speakerName: "佐藤健",
      speakerId: "ken",
      text: "この企画、俺が一から考えたものでね",
      bubbleId: "bubble-cut-01-u02",
      preset: "dialogue",
      isProtagonist: false,
      innerVoice: false,
    },
    {
      id: "cut-01-u03",
      cutId: "cut-01",
      order: 3,
      speakerName: "山田花子",
      speakerId: "hanako",
      text: "一字一句、私の文章のままだ",
      bubbleId: "bubble-cut-01-u03",
      preset: "thought",
      isProtagonist: true,
      innerVoice: true,
    },
  ]);
  // Scene 2 has five lines: 3 + 2, cut at the blank line.
  const scene2 = parsed.cuts.slice(1, 3).flatMap((cut) => cut.utterances);
  assert.deepEqual(parsed.cuts.slice(1, 3).map((cut) => cut.utterances.length), [3, 2]);
  assert.deepEqual(scene2.map((entry) => [entry.speakerName, entry.preset]), [
    ["鈴木", "dialogue"],
    ["佐藤健", "dialogue"],
    ["山田花子", "dialogue"],
    ["ナレーション", "narration"],
    ["佐藤健", "shout"],
  ]);
  assert.equal(scene2[1].text, "証拠でもあるのか", "dialogue unwraps outer quotes like the legacy parser");
  assert.equal(scene2[2].isProtagonist, true);
  assert.equal(scene2[0].speakerId, speakerHash("鈴木"));
  assert.deepEqual(parsed.cuts[2].utterances.map((entry) => entry.id), ["cut-03-u01", "cut-03-u02"]);
  assert.deepEqual(parsed.utterances.map((entry) => entry.id), parsed.cuts.flatMap((cut) => cut.utterances.map((entry) => entry.id)));

  // Inner voice is a thought even when the punctuation says shout; plain
  // dialogue keeps the legacy heuristics.
  const presets = parseMangaScript(sceneScript({
    frontMatter: "登場人物:\n  - 名前: 山田花子\n    主人公: はい\n  - 名前: 佐藤健",
    body: "#場面 1 会議室・昼\n山田花子(心):許せない！\n佐藤健：本当にそうだろうか\n佐藤健：待て！",
  }));
  assert.deepEqual(presets.utterances.map((entry) => [entry.preset, entry.innerVoice]), [
    ["thought", true],
    ["thought", false],
    ["shout", false],
  ]);
});

test("undeclared speakers, colons inside narration, and empty lines are reported as warnings", () => {
  const parsed = parseMangaScript(SCENE_SCRIPT, { registry: REGISTRY });
  const last = parsed.cuts[3].utterances;
  assert.deepEqual(last.map((entry) => [entry.speakerName, entry.speakerId, entry.preset, entry.text]), [
    ["課長", speakerHash("課長"), "dialogue", "あの二人、どうなったんだ"],
    ["ナレーション", "narration", "narration", "佐藤健が静かに開眼した。"],
    ["ナレーション", "narration", "narration", "そのとき、店長が言った：「今日は貸し切りだよ」"],
    // A clock time is not a speaker separator.
    ["ナレーション", "narration", "narration", "午前10:30、店の扉が開いた。"],
  ]);
  assert.deepEqual(codesAndLines(parsed.warnings), [
    { code: "undeclared-speaker", line: lineOf(SCENE_SCRIPT, "課長：") },
    { code: "narration-colon", line: lineOf(SCENE_SCRIPT, "そのとき、店長") },
    { code: "narration-colon", line: lineOf(SCENE_SCRIPT, "午前10:30") },
  ]);
  assert.ok(parsed.warnings.every((entry) => typeof entry.message === "string" && entry.message.length > 0));
  assert.match(parsed.warnings[0].message, /課長/u);

  const script = sceneScript({
    frontMatter: "登場人物:\n  - 名前: 山田花子\n    主人公: はい",
    body: [
      "#場面 1 オフィス・朝",
      "課長：一回目",
      "課長：二回目",
      "とても長い前置きの文章がここに二十文字を超えて続いている：本文",
      "山田花子(心):半角の心の声",
      "ナレーター：説明の文",
      "地の文：さらに説明",
      "山田花子：",
      "山田花子：「」",
      "ナレーション：",
      "10:30課長：遅いぞ",
      "課長！：驚いた",
      "午前１０：３０、会議が始まった。",
    ].join("\n"),
  });
  const repeated = parseMangaScript(script);
  // One undeclared-speaker warning per speaker, at its first line.
  assert.deepEqual(codesAndLines(repeated.warnings), [
    { code: "undeclared-speaker", line: lineOf(script, "課長：一回目") },
    { code: "narration-colon", line: lineOf(script, "とても長い前置き") },
    { code: "empty-utterance", line: lineOf(script, "山田花子：") },
    { code: "empty-utterance", line: lineOf(script, "山田花子：「」") },
    { code: "empty-utterance", line: lineOf(script, "ナレーション：") },
    { code: "narration-colon", line: lineOf(script, "10:30課長") },
    { code: "narration-colon", line: lineOf(script, "課長！") },
    { code: "narration-colon", line: lineOf(script, "午前１０") },
  ]);
  assert.deepEqual(repeated.utterances.map((entry) => [entry.speakerName, entry.preset, entry.innerVoice, entry.text]), [
    ["課長", "dialogue", false, "一回目"],
    ["課長", "dialogue", false, "二回目"],
    ["ナレーション", "narration", false, "とても長い前置きの文章がここに二十文字を超えて続いている：本文"],
    ["山田花子", "thought", true, "半角の心の声"],
    ["ナレーション", "narration", false, "説明の文"],
    ["ナレーション", "narration", false, "さらに説明"],
    ["ナレーション", "narration", false, "10:30課長：遅いぞ"],
    ["ナレーション", "narration", false, "課長！：驚いた"],
    ["ナレーション", "narration", false, "午前１０：３０、会議が始まった。"],
  ]);
  // The explicit narrator prefix is removed and leaves no colon behind.
  assert.ok(!repeated.warnings.some((entry) => entry.line === lineOf(script, "ナレーター：")));
});

test("long scenes split into cuts of at most four lines, preferring blank lines deterministically", () => {
  // Nine lines, blank lines after line 2 and line 6: sizes 2/4/3 beat 3/3/3
  // because the 3/3/3 boundaries fall where the writer left no blank line.
  const nine = sceneScript({
    frontMatter: "タイトル: 分割\n登場人物:\n  - 名前: 山田花子\n    主人公: はい\n  - 名前: 佐藤健",
    body: [
      "#場面 1 オフィス・夜",
      "",
      "一行目の地の文。",
      "山田花子：二行目",
      "",
      "佐藤健：三行目",
      "山田花子：四行目",
      "佐藤健：五行目",
      "山田花子：六行目",
      "",
      "",
      "七行目の地の文。",
      "佐藤健：八行目",
      "山田花子：九行目",
      "",
    ].join("\n"),
  });
  const parsed = parseMangaScript(nine);
  assert.deepEqual(parsed.cuts.map((cut) => cut.utterances.length), [2, 4, 3]);
  assert.deepEqual(parsed.cuts.map((cut) => cut.id), ["cut-01", "cut-02", "cut-03"]);
  assert.deepEqual(parsed.cuts.map((cut) => cut.utterances[0].id), ["cut-01-u01", "cut-02-u01", "cut-03-u01"]);
  assert.ok(parsed.cuts.every((cut) => cut.purpose === "オフィス・夜" && cut.scene.number === 1));
  assert.equal(parsed.cuts[1].utterances[0].text, "三行目");
  assert.deepEqual(parsed.warnings, []);

  // Without blank lines the most even split wins; ties go to the earliest boundary.
  const flat = parseMangaScript(nine.replace(/\n\n+(?=佐藤健：三行目|七行目)/gu, "\n"));
  assert.deepEqual(flat.cuts.map((cut) => cut.utterances.length), [3, 3, 3]);
  assert.deepEqual(planSceneCutBoundaries(5, []), [2]);
  assert.deepEqual(planSceneCutBoundaries(5, [3]), [3]);
  assert.deepEqual(planSceneCutBoundaries(6, [2]), [2]);
  assert.deepEqual(planSceneCutBoundaries(6, [4]), [4]);
  assert.deepEqual(planSceneCutBoundaries(10, [2, 6]), [2, 6]);
  // A blank line does not justify a one-line cut next to a four-line cut.
  assert.deepEqual(planSceneCutBoundaries(5, [1]), [2]);
  // Every cut is at most four lines, so blank lines cannot pull a cut past it.
  assert.deepEqual(planSceneCutBoundaries(8, [1, 2, 3, 5, 6, 7]), [4]);
  assert.deepEqual(planSceneCutBoundaries(4, []), []);
  assert.deepEqual(planSceneCutBoundaries(0, []), []);
  assert.deepEqual(planSceneCutBoundaries(7, [], { maxUtterancesPerCut: 2 }), [1, 3, 5]);
  // [2, 4, 5] and [2, 4, 6] cost the same; the earlier boundary wins.
  assert.deepEqual(planSceneCutBoundaries(7, new Set([4]), { maxUtterancesPerCut: 2 }), [2, 4, 5]);
  for (let count = 1; count <= 40; count += 1) {
    for (const maximum of [1, 2, 3, 4, 5]) {
      const boundaries = planSceneCutBoundaries(count, [3, 7, 11], { maxUtterancesPerCut: maximum });
      const edges = [0, ...boundaries, count];
      const sizes = edges.slice(1).map((edge, index) => edge - edges[index]);
      assert.equal(sizes.length, Math.ceil(count / maximum), `${count}/${maximum}`);
      assert.ok(sizes.every((size) => size >= 1 && size <= maximum), `${count}/${maximum}: ${sizes}`);
      assert.deepEqual(planSceneCutBoundaries(count, [3, 7, 11], { maxUtterancesPerCut: maximum }), boundaries, "deterministic");
    }
  }

  const two = parseMangaScript(nine, { maxUtterancesPerCut: 2 });
  assert.equal(two.cuts.length, 5);
  assert.ok(two.cuts.every((cut) => cut.utterances.length <= 2));
  assert.deepEqual(two.cuts.map((cut) => cut.id), ["cut-01", "cut-02", "cut-03", "cut-04", "cut-05"]);
  assert.throws(() => parseMangaScript(nine, { maxUtterancesPerCut: 0 }), /maxUtterancesPerCut/u);
  assert.throws(() => parseMangaScript(nine, { maxUtterancesPerCut: 2.5 }), /maxUtterancesPerCut/u);
  assert.throws(() => planSceneCutBoundaries(5, [], { maxUtterancesPerCut: -1 }), /maxUtterancesPerCut/u);
});

test("CRLF line endings and a UTF-8 BOM parse exactly like the plain file", () => {
  const plain = parseMangaScript(SCENE_SCRIPT, { registry: REGISTRY });
  const windowsText = `${BOM}${SCENE_SCRIPT.replace(/\n/g, "\r\n")}`;
  assert.equal(windowsText.charCodeAt(0), 0xfeff);
  const windows = parseMangaScript(windowsText, { registry: REGISTRY });
  assert.deepEqual(windows, plain);
  assert.equal(detectMangaScriptFormat(windowsText), "scene-script");
  // Old Mac line endings too.
  assert.deepEqual(parseMangaScript(SCENE_SCRIPT.replace(/\n/g, "\r"), { registry: REGISTRY }), plain);
});

test("full-width scene numbers, gaps, empty scenes, and text before the first heading are read with warnings", () => {
  const script = sceneScript({
    frontMatter: "タイトル: 番号\n登場人物:\n  - 名前: 山田花子\n    主人公: はい\n場所: 喫茶店／オフィス",
    body: [
      "# 見出しは読み上げない",
      "",
      "開店前の静かな時間だった。",
      "山田花子：準備しよう",
      "",
      "#場面 １ 喫茶店・朝",
      "山田花子：いらっしゃいませ",
      "#場面 ３ 駅前・商店街・夕方",
      "山田花子：ただいま",
      "#場面4",
      "山田花子：場所の無い場面",
      "#場面 オフィス",
      "---",
      "#場面 ５：屋上・夜",
      "",
      "#場面１２ 会議室・昼",
      "山田花子：二桁の場面",
    ].join("\n"),
  });
  const parsed = parseMangaScript(script);
  assert.deepEqual(parsed.cuts.map((cut) => cut.scene), [
    { number: 0, heading: "", place: "喫茶店", timeOfDay: "" },
    { number: 1, heading: "喫茶店・朝", place: "喫茶店", timeOfDay: "朝" },
    { number: 3, heading: "駅前・商店街・夕方", place: "駅前・商店街", timeOfDay: "夕方" },
    { number: 4, heading: "", place: "", timeOfDay: "" },
    { number: 12, heading: "会議室・昼", place: "会議室", timeOfDay: "昼" },
  ]);
  assert.deepEqual(parsed.cuts.map((cut) => cut.location), [
    { name: "喫茶店" }, { name: "喫茶店" }, { name: "駅前・商店街" }, undefined, { name: "会議室" },
  ]);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed.cuts[3], "location"), false);
  assert.deepEqual(parsed.cuts.map((cut) => cut.purpose), ["", "喫茶店・朝", "駅前・商店街・夕方", "", "会議室・昼"]);
  assert.deepEqual(parsed.cuts.map((cut) => cut.id), ["cut-01", "cut-02", "cut-03", "cut-04", "cut-05"]);
  assert.equal(parsed.utterances.length, 6);
  assert.deepEqual(codesAndLines(parsed.warnings), [
    { code: "text-before-first-scene", line: lineOf(script, "開店前の") },
    { code: "scene-number-sequence", line: lineOf(script, "#場面 ３") },
    { code: "unrecognized-heading", line: lineOf(script, "#場面 オフィス") },
    { code: "separator-line", line: script.split("\n").lastIndexOf("---") + 1 },
    { code: "empty-scene", line: lineOf(script, "#場面 ５") },
    { code: "scene-number-sequence", line: lineOf(script, "#場面１２") },
  ]);
  assert.deepEqual(splitSceneHeading("オフィス"), { place: "オフィス", timeOfDay: "" });

  // Without 場所 the implicit scene has no place and no location.
  const noPlace = parseMangaScript("---\nタイトル: 場所なし\n---\n前置きの文。\n#場面 1 会議室・昼\n前置きの後。");
  assert.deepEqual(noPlace.cuts[0].scene, { number: 0, heading: "", place: "", timeOfDay: "" });
  assert.equal("location" in noPlace.cuts[0], false);
  assert.equal(parseMangaScript("---\nタイトル: 半角\n場所: 公園/駅\n---\n前置きの文。").cuts[0].scene.place, "公園");
});

test("an unclosed front matter is reported instead of silently read as the body", () => {
  const script = "---\ntitle: 閉じ忘れ\n\n#場面 1 会議室・昼\n佐藤健：こんにちは";
  const parsed = parseMangaScript(script);
  assert.equal(parsed.format, "scene-script");
  assert.deepEqual(parsed.frontMatter, {});
  assert.equal(parsed.warnings[0].code, "front-matter-unclosed");
  assert.equal(parsed.warnings[0].line, 1);
  assert.ok(parsed.warnings.some((entry) => entry.code === "text-before-first-scene"));
});

test("protagonist count warnings and title precedence", () => {
  const none = parseMangaScript(sceneScript({
    frontMatter: "title: 英字キーの題\n登場人物:\n  - 名前: 佐藤健\n    主人公: いいえ",
    body: "# 見出しの題\n#場面 1 オフィス・昼\n佐藤健：こんにちは",
  }));
  assert.equal(none.title, "英字キーの題");
  assert.equal(none.protagonistName, "");
  assert.deepEqual(codesAndLines(none.warnings), [{ code: "protagonist-count", line: 3 }]);
  assert.match(none.warnings[0].message, /0人/u);
  assert.ok(none.utterances.every((entry) => entry.isProtagonist === false));

  const two = parseMangaScript(sceneScript({
    frontMatter: "タイトル: 日本語キーの題\ntitle: 英字キーの題\n登場人物:\n  - 名前: 山田花子\n    主人公: はい\n  - 名前: 佐藤健\n    主人公: はい",
    body: "#場面 1 オフィス・昼\n佐藤健：こんにちは",
  }), { title: "指定した題" });
  assert.equal(two.title, "指定した題");
  assert.equal(two.protagonistName, "");
  assert.equal(two.warnings[0].code, "protagonist-count");
  assert.match(two.warnings[0].message, /2人/u);
  assert.ok(two.utterances.every((entry) => entry.isProtagonist === false));
  assert.equal(parseMangaScript(sceneScript({
    frontMatter: "タイトル: 日本語キーの題\ntitle: 英字キーの題",
    body: "#場面 1 オフィス・昼\nこんにちは",
  })).title, "日本語キーの題");
  assert.equal(parseMangaScript(sceneScript({
    frontMatter: "title: 英字キーの題",
    body: "タイトル：本文の題\n#場面 1 オフィス・昼\nこんにちは",
  })).title, "英字キーの題");
  assert.equal(parseMangaScript("# 見出しの題\n\n#場面 1 オフィス・昼\n佐藤健：こんにちは").title, "見出しの題");
  assert.equal(parseMangaScript("#場面 1 オフィス・昼\n佐藤健：こんにちは").title, "漫画動画");
});

test("without a cast list the legacy name-colon rule decides dialogue", () => {
  const script = [
    "#場面 1 オフィス・昼",
    "佐藤健：こんにちは",
    "そのとき、店長が言った：待て",
    "午前10:30、会議が始まった。",
    "【カット9：古い見出し】",
    "佐藤健：さようなら",
  ].join("\n");
  const parsed = parseMangaScript(script);
  assert.equal(parsed.format, "scene-script");
  assert.deepEqual(parsed.cast, []);
  assert.deepEqual(parsed.utterances.map((entry) => [entry.speakerName, entry.preset]), [
    ["佐藤健", "dialogue"],
    ["そのとき、店長が言った", "dialogue"],
    ["ナレーション", "narration"],
    ["佐藤健", "dialogue"],
  ]);
  assert.deepEqual(parsed.cuts.map((cut) => cut.scene.number), [1, 9]);
  assert.deepEqual(codesAndLines(parsed.warnings), [
    { code: "protagonist-count", line: 1 },
    { code: "undeclared-speaker", line: 2 },
    { code: "undeclared-speaker", line: 3 },
    { code: "narration-colon", line: 4 },
    { code: "cut-heading-in-scene-script", line: 5 },
    { code: "scene-number-sequence", line: 5 },
  ]);
});

test("format detection only switches for scene-script markers", () => {
  assert.equal(detectMangaScriptFormat("タイトル：題\n【カット1：会話】\n佐藤健：こんにちは"), "cut-heading");
  assert.equal(detectMangaScriptFormat("---\ntitle: 題\n---\n【カット1：会話】\n佐藤健：こんにちは"), "cut-heading");
  assert.equal(detectMangaScriptFormat("---\n場所: 会議室\n---\n佐藤健：こんにちは"), "cut-heading");
  assert.equal(detectMangaScriptFormat("---\n登場人物:\n  - 名前: 佐藤健\n---\n佐藤健：こんにちは"), "scene-script");
  assert.equal(detectMangaScriptFormat("---\nタイトル: 題\n---\n本文"), "scene-script");
  assert.equal(detectMangaScriptFormat(`${BOM}---\r\nタイトル: 題\r\n---\r\n本文`), "scene-script");
  assert.equal(detectMangaScriptFormat("前置き\n#場面２ 会議室"), "scene-script");
  assert.equal(detectMangaScriptFormat("前置き\n  #場面 3 会議室"), "scene-script");
  assert.equal(detectMangaScriptFormat("# 場面の話\n#場面 会議室"), "cut-heading");
  assert.equal(detectMangaScriptFormat("＃場面 1 会議室"), "cut-heading");
  assert.equal(detectMangaScriptFormat("---\n#場面 1 front matter の中は本文ではない\n---\n佐藤健：こんにちは"), "cut-heading");
  assert.equal(detectMangaScriptFormat(""), "cut-heading");
  assert.equal(detectMangaScriptFormat(undefined), "cut-heading");
  // A legacy script parses to the legacy shape plus the format field.
  assert.deepEqual(Object.keys(parseMangaScript("【カット1：会話】\n佐藤健：こんにちは")), ["title", "cuts", "utterances", "format"]);
});

test("legacy cut-heading scripts parse exactly as before apart from the format field", async () => {
  // Generated from the bf85e67 checkout, before the scene-script format existed.
  const fixture = JSON.parse(await readFile(resolve("test/fixtures/manga-script-legacy-parse.json"), "utf8"));
  const empty = { characters: [], voices: [] };
  const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  assert.equal(fixture.scripts.length, 2);
  for (const entry of fixture.scripts) {
    const text = await readFile(resolve(entry.path), "utf8");
    assert.equal(createHash("sha256").update(text).digest("hex"), entry.scriptSha256, `${entry.path} changed; regenerate the fixture at the base commit`);
    assert.equal(detectMangaScriptFormat(text), "cut-heading", entry.path);
    const withoutFormat = (parsed, label) => {
      const { format, ...rest } = parsed;
      assert.equal(format, "cut-heading", `${entry.path} ${label}`);
      return rest;
    };
    const plain = withoutFormat(parseMangaScript(text), "plain");
    assert.deepEqual(plain, entry.expected, entry.path);
    assert.equal(JSON.stringify(plain), JSON.stringify(entry.expected), `${entry.path}: key order changed`);
    const variants = {
      emptyRegistry: parseMangaScript(text, { registry: empty }),
      exampleRegistry: parseMangaScript(text, { registry: fixture.registry }),
      title: parseMangaScript(text, { registry: empty, title: "上書きタイトル" }),
      crlfBom: parseMangaScript(`${BOM}${text.replace(/\n/g, "\r\n")}`, { registry: empty }),
    };
    assert.deepEqual(Object.keys(variants).sort(), Object.keys(entry.digests).sort());
    for (const [name, parsed] of Object.entries(variants)) {
      assert.equal(digest(withoutFormat(parsed, name)), entry.digests[name], `${entry.path} ${name} differs from the pre-change output`);
    }
    const plan = createMangaScriptImagePlan({ scriptText: text, registry: empty, ...PLAN_PATHS });
    assert.deepEqual(plan.manifest.cuts.map((cut) => cut.locationId), entry.locationIds, entry.path);
    for (const key of ["scriptFormat", "declaredProtagonistName", "scriptWarnings"]) {
      assert.equal(Object.prototype.hasOwnProperty.call(plan.manifest, key), false, `${entry.path} manifest gained ${key}`);
    }
    assert.ok(plan.manifest.utterances.every((utterance) => !("isProtagonist" in utterance) && !("innerVoice" in utterance)));
    assert.ok(plan.manifest.cuts.every((cut) => !("scene" in cut) && !("location" in cut)));
  }
});

test("scene places give image-plan locations a stable id", () => {
  const script = sceneScript({
    frontMatter: "タイトル: 場所\n登場人物:\n  - 名前: 山田花子\n    主人公: はい",
    body: [
      "#場面 1 オフィス・昼",
      "山田花子：おはよう",
      "#場面 2 Cafe Blue・夜",
      "山田花子：こんばんは",
      "#場面 3 オフィス・夜",
      "山田花子：おつかれさま",
      "#場面 4 写真館・昼",
      "山田花子：場所の名前が規則表に当たっても見出しの場所を使う",
      "#場面 5",
      "山田花子：場所の無い場面は従来の推定に戻る",
      "#場面 6 会議室A・昼",
      "山田花子：会議室",
      "#場面 7 倉庫A・昼",
      "山田花子：倉庫",
      "#場面 8 Ｃａｆｅ Ｂｌｕｅ・朝",
      "山田花子：全角の英字",
    ].join("\n"),
  });
  const plan = createMangaScriptImagePlan({ scriptText: script, registry: { characters: [], voices: [] }, ...PLAN_PATHS });
  const hashId = (name) => `location-${createHash("sha256").update(name).digest("hex").slice(0, 10)}`;
  const officeId = hashId("オフィス");
  // Mixed names are hashed: a slug would reduce both 会議室A and 倉庫A to "a".
  assert.deepEqual(plan.manifest.cuts.map((cut) => cut.locationId), [
    officeId, "cafe-blue", officeId, hashId("写真館"), "primary-location", hashId("会議室A"), hashId("倉庫A"), "cafe-blue",
  ]);
  assert.notEqual(hashId("会議室A"), hashId("倉庫A"));
  assert.equal(plan.manifest.declaredProtagonistName, "山田花子");
  assert.equal(plan.manifest.scriptFormat, "scene-script");
  assert.deepEqual(plan.manifest.scriptWarnings, []);
  assert.deepEqual(plan.manifest.cuts[1].scene, { number: 2, heading: "Cafe Blue・夜", place: "Cafe Blue", timeOfDay: "夜" });
  const environments = plan.jobs.filter((job) => job.kind === "environment-sheet").map((job) => job.id).sort();
  assert.deepEqual(environments, [
    `environment-sheet:${officeId}`,
    "environment-sheet:cafe-blue",
    `environment-sheet:${hashId("写真館")}`,
    "environment-sheet:primary-location",
    `environment-sheet:${hashId("会議室A")}`,
    `environment-sheet:${hashId("倉庫A")}`,
  ].sort());
  assert.ok(plan.jobs.find((job) => job.id === `environment-sheet:${officeId}`).prompt.includes("Location: オフィス."));
  // The same script plans the same ids and job hashes every time.
  const again = createMangaScriptImagePlan({ scriptText: script, registry: { characters: [], voices: [] }, ...PLAN_PATHS });
  assert.deepEqual(again.jobs.map((job) => [job.id, job.inputHash]), plan.jobs.map((job) => [job.id, job.inputHash]));

  const warned = createMangaScriptImagePlan({ scriptText: SCENE_SCRIPT, registry: REGISTRY, ...PLAN_PATHS });
  assert.deepEqual(warned.manifest.scriptWarnings.map((entry) => entry.code), ["undeclared-speaker", "narration-colon", "narration-colon"]);
});

test("scene-script narration opens eyes for a named candidate while dialogue never does", () => {
  const parsed = parseMangaScript(SCENE_SCRIPT, { registry: REGISTRY });
  const candidates = [{ characterId: "ken", names: ["佐藤健"] }];
  const { beats, unresolved } = detectMangaEyeOpenBeats({ cuts: parsed.cuts, candidates });
  assert.deepEqual(unresolved, []);
  const cue = parsed.cuts[3].utterances[1];
  assert.equal(cue.text, "佐藤健が静かに開眼した。");
  assert.equal(cue.preset, "narration");
  assert.deepEqual(beats.map((beat) => beat.utteranceId), parsed.cuts[3].utterances.slice(1).map((entry) => entry.id));
  assert.ok(beats.every((beat) => beat.characterId === "ken" && beat.source === "script-cue"));
  assert.equal(beats[0].cue, "佐藤健が静かに開眼した");

  // The name may be an alias of the candidate.
  const aliasOnly = detectMangaEyeOpenBeats({ cuts: parsed.cuts, candidates: [{ characterId: "c1", names: ["別名", "佐藤健"] }] });
  assert.equal(aliasOnly.beats.length, 3);
  assert.ok(aliasOnly.beats.every((beat) => beat.characterId === "c1"));

  // Dialogue and inner voice are never cues, even when they say the same words.
  const spoken = parseMangaScript(sceneScript({
    frontMatter: "登場人物:\n  - 名前: 山田花子\n    主人公: はい\n  - 名前: 佐藤健",
    body: "#場面 1 喫茶店・夜\n山田花子：佐藤健が開眼したら終わりよ\n佐藤健：目を見開いてよく見ろ\n山田花子（心）：佐藤健が静かに開眼した",
  }));
  assert.deepEqual(spoken.utterances.map((entry) => entry.preset), ["dialogue", "dialogue", "thought"]);
  assert.deepEqual(detectMangaEyeOpenBeats({ cuts: spoken.cuts, candidates }).beats, []);
});

test("the declared protagonist is honoured and a disagreeing explicit protagonist is refused", () => {
  const parsed = parseMangaScript(SCENE_SCRIPT, { registry: REGISTRY });
  const manifest = { utterances: parsed.utterances, declaredProtagonistName: parsed.protagonistName };
  // No explicit value: the declaration decides, even though 佐藤健 speaks first.
  assert.equal(resolveKoyaProtagonistSpeaker(manifest).speakerId, "hanako");
  assert.equal(resolveKoyaProtagonistSpeaker(manifest, "山田花子").speakerId, "hanako");
  assert.equal(resolveKoyaProtagonistSpeaker(manifest, "hanako").speakerName, "山田花子");
  assert.throws(() => resolveKoyaProtagonistSpeaker(manifest, "佐藤健"), /does not match the protagonist declared in the script.*山田花子/u);
  assert.throws(() => resolveKoyaProtagonistSpeaker(manifest, "ken"), /declared in the script/u);
  assert.throws(() => resolveKoyaProtagonistSpeaker(manifest, "存在しない"), /declared in the script/u);
  assert.throws(
    () => resolveKoyaProtagonistSpeaker({ ...manifest, production: { protagonistSpeakerId: "ken" } }),
    /declared in the script/u,
  );
  // Parse output carries the declaration too.
  assert.throws(() => assertKoyaDeclaredProtagonist(parsed, "佐藤健"), /declared in the script/u);
  assert.equal(assertKoyaDeclaredProtagonist(parsed, "hanako"), "山田花子");
  // Without the manifest-level declaration, isProtagonist marks alone do not bind an explicit request.
  assert.equal(assertKoyaDeclaredProtagonist({ utterances: parsed.utterances }, "佐藤健"), "");

  // A registry alias of the protagonist is the same speaker.
  const alias = parseMangaScript(sceneScript({
    frontMatter: "登場人物:\n  - 名前: 山田花子\n    主人公: はい\n  - 名前: 佐藤健",
    body: "#場面 1 オフィス・昼\n佐藤健：始めよう\n花子：はい",
  }), { registry: REGISTRY });
  assert.deepEqual(alias.utterances.map((entry) => [entry.speakerId, entry.isProtagonist]), [["ken", false], ["hanako", true]]);
  const aliasManifest = { utterances: alias.utterances, declaredProtagonistName: alias.protagonistName };
  assert.equal(resolveKoyaProtagonistSpeaker(aliasManifest).speakerId, "hanako");
  assert.equal(resolveKoyaProtagonistSpeaker(aliasManifest, "花子").speakerId, "hanako");
  assert.equal(assertKoyaDeclaredProtagonist(aliasManifest, "花子"), "山田花子");

  // The protagonist narrates but never speaks: the declaration still binds and
  // resolution stops instead of guessing the only other speaker.
  const silent = parseMangaScript(sceneScript({
    frontMatter: "タイトル: 語り手\n登場人物:\n  - 名前: 山田花子\n    主人公: はい\n  - 名前: 佐藤健",
    body: "#場面 1 オフィス・昼\nあの日のことは忘れない。\n佐藤健：始めよう",
  }), { registry: REGISTRY });
  const plan = createMangaScriptImagePlan({ scriptText: "", parsed: silent, registry: REGISTRY, ...PLAN_PATHS });
  assert.equal(plan.manifest.declaredProtagonistName, "山田花子");
  assert.throws(() => assertKoyaDeclaredProtagonist(plan.manifest, "佐藤健"), /declared in the script/u);
  assert.equal(assertKoyaDeclaredProtagonist(plan.manifest, "山田花子"), "山田花子");
  assert.equal(assertKoyaDeclaredProtagonist(plan.manifest, ""), "");
  assert.throws(() => resolveKoyaProtagonistSpeaker(plan.manifest), /山田花子.*has no dialogue line/u);
  assert.throws(() => resolveKoyaProtagonistSpeaker(plan.manifest, "山田花子"), /has no dialogue line/u);

  // Two protagonists declared: nothing is declared, so the explicit value decides.
  const ambiguous = parseMangaScript(sceneScript({
    frontMatter: "登場人物:\n  - 名前: 山田花子\n    主人公: はい\n  - 名前: 佐藤健\n    主人公: はい",
    body: "#場面 1 オフィス・昼\nあの日のことは忘れない。\n佐藤健：始めよう\n山田花子：はい",
  }), { registry: REGISTRY });
  const ambiguousManifest = { utterances: ambiguous.utterances, declaredProtagonistName: ambiguous.protagonistName };
  assert.throws(() => resolveKoyaProtagonistSpeaker(ambiguousManifest), /protagonist is ambiguous/u);
  assert.equal(resolveKoyaProtagonistSpeaker(ambiguousManifest, "佐藤健").speakerId, "ken");

  // Legacy manifests declare nothing, so any unique speaker is still accepted.
  const legacy = { utterances: parseMangaScript("【カット1：会話】\n悠斗：行こう\n美咲：うん").utterances };
  assert.equal(assertKoyaDeclaredProtagonist(legacy, "美咲"), "");
  assert.equal(resolveKoyaProtagonistSpeaker(legacy, "美咲").speakerName, "美咲");
  assert.throws(() => resolveKoyaProtagonistSpeaker(legacy), /protagonist is ambiguous/u);
  assert.throws(() => resolveKoyaProtagonistSpeaker(legacy, "存在しない"), /does not uniquely match a dialogue speaker/u);
  const marked = { utterances: legacy.utterances.map((entry) => ({ ...entry, isProtagonist: entry.speakerName === "悠斗" })) };
  assert.equal(resolveKoyaProtagonistSpeaker(marked).speakerName, "悠斗");
  assert.equal(resolveKoyaProtagonistSpeaker(marked, "美咲").speakerName, "美咲");
});

test("the story review draft refuses a protagonist that disagrees with the script", async () => {
  const showBible = JSON.parse(await readFile(resolve("test/fixtures/channel-pack/config/koya-show-bible.json"), "utf8"));
  const parsed = parseMangaScript(SCENE_SCRIPT);
  assert.throws(
    () => createKoyaStoryReviewDraft({ showBible, scriptText: SCENE_SCRIPT, parsed, protagonistSpeakerId: "佐藤健" }),
    /does not match the protagonist declared in the script/u,
  );
  const draft = createKoyaStoryReviewDraft({ showBible, scriptText: SCENE_SCRIPT, parsed, protagonistSpeakerId: "山田花子" });
  assert.equal(draft.protagonistSpeakerId, "山田花子");
  assert.equal(draft.utteranceInventory.length, parsed.utterances.length);
});

test("Koya planning refuses a protagonist that disagrees with the script before any paid step", async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), "koya-scene-script-protagonist-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  const scriptPath = join(projectDir, "script.txt");
  await writeFile(scriptPath, SCENE_SCRIPT);
  let generatorCalls = 0;
  await assert.rejects(() => planKoyaMangaProduction({
    // The refusal comes before the channel authority is read, so no channel
    // pack is needed; the flag only mirrors the other planning tests.
    allowBorrowedChannelData: true,
    projectDir,
    scriptPath,
    episodeId: "koya-scene-script-mismatch",
    protagonistSpeakerId: "佐藤健",
    contractPath: resolve("config/koya-manga-production-contract.json"),
    generateImage: async () => { generatorCalls += 1; throw new Error("must not generate"); },
  }), /does not match the protagonist declared in the script/u);
  assert.equal(generatorCalls, 0);
  assert.equal(existsSync(join(projectDir, "canvas", "manga-videos", "koya-scene-script-mismatch")), false);
  assert.equal(existsSync(join(projectDir, "canvas", "assets", "koya-scene-script-mismatch")), false);

  // Without narration the protagonist voice is never resolved, so only the
  // explicit check stands between the wrong protagonist and generation.
  const dialogueOnlyPath = join(projectDir, "dialogue-only.txt");
  await writeFile(dialogueOnlyPath, sceneScript({
    frontMatter: "タイトル: 会話だけ\n登場人物:\n  - 名前: 山田花子\n    主人公: はい\n  - 名前: 佐藤健",
    body: "#場面 1 会議室・昼\n佐藤健：始めよう\n山田花子：はい",
  }));
  await assert.rejects(() => planKoyaMangaProduction({
    allowBorrowedChannelData: true,
    projectDir,
    scriptPath: dialogueOnlyPath,
    episodeId: "koya-scene-script-dialogue-only",
    protagonistSpeakerId: "佐藤健",
    contractPath: resolve("config/koya-manga-production-contract.json"),
  }), /does not match the protagonist declared in the script/u);
  assert.equal(existsSync(join(projectDir, "canvas", "manga-videos", "koya-scene-script-dialogue-only")), false);
});
