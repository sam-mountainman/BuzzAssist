import assert from "node:assert/strict";
import test from "node:test";

import {
  findGaps,
  harnessKeywords,
  loadHarnesses,
  matchHarnesses,
  validateHarness,
} from "../scripts/harness-registry.mjs";

const base = () => ({
  id: "x", displayName: "テスト", status: "in-production",
  produces: { kind: "test-video", description: "説明" },
  requiresFromOperator: [{ id: "script", what: "台本", blocking: true }],
  guarantees: [{ id: "g1", what: "何かを保証する" }],
});

test("宣言にクライアントを特定できる語を入れられない", () => {
  // この台帳は共有される前提なので、ここが緩むと外へ出せなくなる。
  for (const banned of ["漫画動画ハーネス", "マイク", "narrated-story", "manga-channel"]) {
    const bad = { ...base(), statusNote: `${banned}さんの案件` };
    assert.ok(
      validateHarness(bad).some((e) => /クライアントを特定/u.test(e)),
      `${banned} が素通りした`,
    );
  }
  assert.deepEqual(validateHarness(base()), []);
});

test("何を保証するか書いていないハーネスは登録できない", () => {
  // 保証の無いものを候補に並べると、選ぶ側が判断できない。
  assert.ok(validateHarness({ ...base(), guarantees: [] }).some((e) => /guarantees/u.test(e)));
  assert.ok(validateHarness({ ...base(), guarantees: undefined }).some((e) => /guarantees/u.test(e)));
  assert.ok(validateHarness({ ...base(), requiresFromOperator: [] }).some((e) => /requiresFromOperator/u.test(e)));
  assert.ok(validateHarness({ ...base(), produces: {} }).some((e) => /produces\.kind/u.test(e)));
});

test("日本語の依頼文でハーネスを言い当てる", () => {
  // 依頼文を空白で刻む実装では日本語が1語になって一致しない。
  const harnesses = [
    { ...base(), id: "manga", keywords: ["漫画", "吹き出し"] },
    { ...base(), id: "narrated", keywords: ["ナレーション", "朗読"] },
  ];
  const m = matchHarnesses(harnesses, "漫画で解説する動画を作りたい");
  assert.equal(m.length, 1);
  assert.equal(m[0].harness.id, "manga");
  assert.deepEqual(m[0].hits, ["漫画"]);

  const n = matchHarnesses(harnesses, "ナレーションを入れた朗読の動画");
  assert.equal(n[0].harness.id, "narrated");
  assert.equal(n[0].score, 2, "複数一致がスコアに反映されていない");
});

test("当たらない依頼には空を返す（無理に候補を出さない）", () => {
  const harnesses = [{ ...base(), keywords: ["漫画"] }];
  assert.deepEqual(matchHarnesses(harnesses, "料理のレシピを書いて"), []);
  assert.deepEqual(matchHarnesses(harnesses, ""), []);
  assert.deepEqual(matchHarnesses(harnesses, null), []);
});

test("keywords が無くても id と kind から手掛かりを作る", () => {
  const kw = harnessKeywords({ id: "narrated-story-video", produces: { kind: "manga-video" } });
  assert.ok(kw.includes("narrated"));
  assert.ok(kw.includes("manga"));
  // 短すぎる断片は手掛かりにならない
  assert.ok(!kw.includes("id"));
});

test("保証の偏りは共有数の少ない順に出る", () => {
  const gaps = findGaps([
    { id: "a", guarantees: [{ id: "shared" }, { id: "only-a" }] },
    { id: "b", guarantees: [{ id: "shared" }] },
  ]);
  assert.equal(gaps[0].id, "only-a");
  assert.equal(gaps[0].sharedBy, 1);
  assert.equal(gaps[1].id, "shared");
  assert.deepEqual(gaps[1].owners, ["a", "b"]);
});

test("実在の宣言がすべて検証を通る", () => {
  const harnesses = loadHarnesses();
  assert.ok(harnesses.length >= 2, "宣言が読み込めていない");
  for (const h of harnesses) assert.deepEqual(validateHarness(h), [], `${h.id} が不正`);
  // 実在の宣言で日本語の依頼が当たること
  assert.ok(matchHarnesses(harnesses, "漫画の動画が作りたい").length > 0);
  assert.ok(matchHarnesses(harnesses, "ナレーション付きの物語動画").length > 0);
});
