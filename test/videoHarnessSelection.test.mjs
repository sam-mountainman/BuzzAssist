import assert from "node:assert/strict";
import test from "node:test";

import { analyzeHarnessRequest, loadHarnesses } from "../scripts/harness-registry.mjs";
import { selectVideoHarness, VIDEO_HARNESS_CHOICE_REQUIRED_CODE } from "../lib/videoHarnessJob.mjs";

// 依頼文からハーネスを選ぶとき、否定の節（〜は使わず、〜ではなく、〜なし、〜じゃなくて、
// not / without）の中の語まで加点していた。「漫画、固定キャスト、吹き出しは使わず、朗読動画に
// したい」で漫画ハーネスが選ばれていた（外部レビューで再現）。否定の節の語は減点し、同点か
// 根拠が弱い（両方に言及している）ときは1つに決めず「どちらにしますか」を返す。

const harnesses = loadHarnesses();

function choice(want) {
  let caught = null;
  try {
    selectVideoHarness({ harnesses, want });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, `「${want}」で1つに決めてしまった`);
  assert.equal(caught.code, VIDEO_HARNESS_CHOICE_REQUIRED_CODE, caught.message);
  return caught;
}

test("否定の節の語で漫画ハーネスを選ばない（外部レビューの再現例）", () => {
  const error = choice("漫画、固定キャスト、吹き出しは使わず、朗読動画にしたい");
  assert.match(error.question, /どちらにしますか/u);
  assert.deepEqual(error.candidates.map((entry) => entry.id).sort(), ["koya-manga-video", "narrated-story-video"]);
  const manga = error.candidates.find((entry) => entry.id === "koya-manga-video");
  assert.deepEqual(manga.negatedHits, ["吹き出し"], "否定の節の語は減点として記録する");
});

test("否定だけで片方を外せるときは、もう片方を選ぶ", () => {
  for (const want of [
    "吹き出しは使わず、朗読の動画にしたい",
    "吹き出しは使わずに朗読の動画にしたい",
    "吹き出しなしで朗読の動画を作りたい",
  ]) {
    assert.equal(selectVideoHarness({ harnesses, want }).harness.id, "narrated-story-video", want);
  }
});

test("対比（〜ではなく、〜じゃなくて、not / without）の前の語は加点しない", () => {
  for (const want of [
    "漫画ではなく朗読の動画にしたい",
    "漫画じゃなくて、物語の朗読にしたい",
    "Not manga. 朗読の動画にしたい",
    "朗読の動画、without manga",
  ]) {
    const selected = selectVideoHarness({ harnesses, want });
    assert.equal(selected.harness.id, "narrated-story-video", want);
    assert.ok(selected.evidence.negatedHits.length === 0, "選んだ側に否定の語は無い");
  }
  const reversed = selectVideoHarness({ harnesses, want: "朗読ではなく、漫画で作りたい" });
  assert.equal(reversed.harness.id, "koya-manga-video");
});

test("両方に肯定で言及していて差が小さいときは1つに決めない", () => {
  choice("漫画と朗読の両方の良さを持つ動画にしたい");
  choice("漫画の朗読動画にしたい");
  // 差が大きければ決めてよい（漫画3語・ナレーション1語）。
  assert.equal(
    selectVideoHarness({ harnesses, want: "漫画のキャラと吹き出しで、ナレーションも入れたい" }).harness.id,
    "koya-manga-video",
  );
});

test("否定された語しか無い依頼も1つに決めず、何にも当たらない依頼は従来どおり止める", () => {
  const error = choice("漫画は使わない");
  assert.equal(error.candidates.length, harnesses.length, "どれも根拠が無いので全候補を並べる");
  assert.throws(() => selectVideoHarness({ harnesses, want: "料理のレシピを書いて" }), /一致する動画ハーネスが無い/u);
});

test("既存の選択結果は変わらない", () => {
  assert.equal(selectVideoHarness({ harnesses, want: "漫画の動画が作りたい" }).harness.id, "koya-manga-video");
  assert.equal(selectVideoHarness({ harnesses, want: "ナレーション付きの物語動画" }).harness.id, "narrated-story-video");
  assert.equal(selectVideoHarness({ harnesses, want: "スカッとする漫画を作る" }).harness.id, "koya-manga-video");
  assert.equal(selectVideoHarness({ harnesses, want: "感動する実話の朗読" }).harness.id, "narrated-story-video");
  // 「昔ばなし」「お話し」は否定の「なし」ではない。
  assert.equal(selectVideoHarness({ harnesses, want: "昔ばなしの朗読" }).harness.id, "narrated-story-video");
});

test("解析結果は肯定・否定の語を分けて返す", () => {
  const rows = analyzeHarnessRequest(harnesses, "漫画、吹き出しは使わず、朗読動画にしたい");
  const manga = rows.find((row) => row.harness.id === "koya-manga-video");
  const narrated = rows.find((row) => row.harness.id === "narrated-story-video");
  assert.deepEqual(manga.positiveHits, ["漫画"]);
  assert.deepEqual(manga.negatedHits, ["吹き出し"]);
  assert.equal(manga.score, 0);
  assert.deepEqual(narrated.positiveHits, ["朗読"]);
  assert.equal(narrated.score, 1);
});
