import assert from "node:assert/strict";
import test from "node:test";

import {
  LEARNED_BEGIN,
  LEARNED_END,
  LEARNING_TARGETS,
  PROPOSAL_KINDS,
  buildProposal,
  clusterForConsolidation,
  extractLearnedSection,
  proposalId,
  renderLearnedSection,
  summarizeProposals,
  writeLearnedSection,
} from "../scripts/harness-learn.mjs";

const NOW = "2026-08-29T00:00:00.000Z";
const make = (over = {}) => buildProposal({
  kind: "correction",
  target: "ledger:koya",
  text: "完了報告の前に必ず実測する",
  evidence: "本日3件の自作サインオフを検出",
  now: NOW,
  ...over,
});

test("提案の宛先は正本と台帳に限る", () => {
  // 次のセッションが必ず読む場所以外へ書いても学習にならない。
  for (const target of Object.keys(LEARNING_TARGETS)) {
    assert.doesNotThrow(() => make({ target }));
  }
  assert.throws(() => make({ target: "skill:does-not-exist" }), /未知の target/u);
  assert.throws(() => make({ target: "README.md" }), /未知の target/u);
});

test("種別と粒度を満たさない提案は受け取らない", () => {
  assert.throws(() => make({ kind: "whatever" }), /correction \/ preference/u);
  for (const kind of PROPOSAL_KINDS) assert.doesNotThrow(() => make({ kind }));
  // 「だめ」だけでは、次に読む人が何を直せばいいか判断できない。
  // 弾きたいのは「次に何をすればいいか分からない反応」だけ。
  assert.throws(() => make({ text: "だめ" }), /短すぎます/u);
  assert.throws(() => make({ text: "違う" }), /短すぎます/u);
  assert.throws(() => make({ text: "   " }), /短すぎます/u);
  assert.throws(() => make({ text: 123 }), /短すぎます/u);
  // 日本語では短くても具体的な指摘が成立する。これは通す。
  assert.doesNotThrow(() => make({ text: "目の左右が逆" }));
});

test("同じ指摘は同じIDになり、言い回しが違えば別IDになる", () => {
  assert.equal(make().id, make().id);
  assert.equal(make({ evidence: "別の根拠" }).id, make().id, "根拠が違ってもIDは同じであるべき");
  assert.notEqual(make({ text: "別の指摘だと分かる文" }).id, make().id);
  assert.notEqual(make({ target: "skill:manga-page-camera" }).id, make().id);
  assert.notEqual(make({ kind: "preference" }).id, make().id);
});

test("繰り返された指摘ほど上に来る", () => {
  const repeated = make();
  const once = make({ text: "一度だけ言われたこと" });
  const summary = summarizeProposals([repeated, once, repeated, repeated], []);
  assert.equal(summary[0].id, repeated.id);
  assert.equal(summary[0].occurrences, 3, "繰り返しが数えられていない");
  assert.equal(summary[1].occurrences, 1);
});

test("根拠は重複を除いて積み上がる", () => {
  const a = make({ evidence: "根拠A" });
  const b = make({ evidence: "根拠B" });
  const summary = summarizeProposals([a, b, a], []);
  assert.deepEqual(summary[0].evidence, ["根拠A", "根拠B"]);
});

test("反映済みは未反映より後ろへ回る", () => {
  const done = make({ text: "既に反映した指摘です" });
  const pending = make();
  const summary = summarizeProposals([done, pending], [{ id: done.id }]);
  assert.equal(summary[0].id, pending.id);
  assert.equal(summary[0].applied, false);
  assert.equal(summary[1].applied, true);
});

test("同じ宛先に溜まったら、個別追記ではなくまとめて書くよう促す", () => {
  // hermes の curator が言う「1セッション1スキルの蓄積は失敗」を、
  // 機械的に検出できる形にしたもの。
  const two = summarizeProposals(
    [make(), make({ text: "同じ宛先の別の指摘です" })],
    [],
  );
  const clusters = clusterForConsolidation(two);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].entries.length, 2);
  assert.match(clusters[0].recommendation, /まとめて/u);

  const one = clusterForConsolidation(summarizeProposals([make()], []));
  assert.match(one[0].recommendation, /既存の節へ吸収/u);
});

test("反映済みだけになったら統合対象は空になる", () => {
  const entry = make();
  const summary = summarizeProposals([entry], [{ id: entry.id }]);
  assert.deepEqual(clusterForConsolidation(summary), []);
});

test("提案IDは記録の順序に依存しない", () => {
  // 後から手で並べ替えても同じ指摘が別物にならないこと。
  const entry = { kind: "fact", target: "ledger:koya", text: "実測した値" };
  assert.equal(proposalId(entry), proposalId({ ...entry }));
  assert.equal(
    proposalId(entry),
    proposalId({ text: "実測した値", target: "ledger:koya", kind: "fact" }),
  );
});

// --- 自動反映（sync）が触ってよい範囲 ---

test("自動反映はマーカーの内側だけを書き換える", () => {
  const before = [
    "# 人が書いた見出し",
    "",
    "人が書いた本文。ここは機械が触ってはいけない。",
    "",
    LEARNED_BEGIN,
    "",
    "_古い内容_",
    "",
    LEARNED_END,
    "",
    "## これも人が書いた節",
    "末尾の本文。",
  ].join("\n");

  const after = writeLearnedSection(before, [
    { id: "abc123", kind: "fact", text: "測った値", evidence: ["実測"], occurrences: 1, firstSeenAt: "2026-08-29T00:00:00Z" },
  ], "2026-08-29T00:00:00Z");

  // 人が書いた部分が1文字も変わっていないこと
  assert.ok(after.startsWith("# 人が書いた見出し\n\n人が書いた本文。ここは機械が触ってはいけない。\n\n"));
  assert.ok(after.endsWith("## これも人が書いた節\n末尾の本文。"));
  // 機械区画は差し替わっていること
  assert.ok(!after.includes("_古い内容_"), "古い機械区画が残っている");
  assert.match(after, /測った値/u);
  assert.match(after, /根拠: 実測/u);
  // マーカーは1組のまま
  assert.equal(after.split(LEARNED_BEGIN).length - 1, 1);
  assert.equal(after.split(LEARNED_END).length - 1, 1);
});

test("マーカーの無い文書には節を作らない", () => {
  // 人の文書の構造を機械が勝手に変えることの方が、反映漏れより高くつく。
  assert.equal(writeLearnedSection("# マーカーのない文書\n\n本文。", [], "2026-08-29T00:00:00Z"), null);
  assert.equal(extractLearnedSection("マーカーなし"), null);
});

test("マーカーの順序が壊れていたら黙って直さず落とす", () => {
  assert.throws(
    () => extractLearnedSection(`${LEARNED_END}\n中身\n${LEARNED_BEGIN}`),
    /順序が逆/u,
  );
});

test("繰り返し回数と根拠が自動区画に残る", () => {
  const out = renderLearnedSection([
    { id: "x", kind: "correction", text: "二度言われたこと", evidence: ["根拠A", "根拠B"], occurrences: 2, firstSeenAt: "2026-08-01T00:00:00Z" },
  ], "2026-08-29T00:00:00Z");
  assert.match(out, /2回指摘/u);
  assert.match(out, /根拠A/u);
  assert.match(out, /根拠B/u);
  assert.match(out, /2026-08-01/u);
  // 由来を追えるよう id を残す
  assert.match(out, /`x`/u);
});

test("空でも区画は成立し、内容が無いと分かる", () => {
  const out = renderLearnedSection([], "2026-08-29T00:00:00Z");
  assert.match(out, /まだ自動反映された項目はありません/u);
});

test("同じ入力なら同じ区画になる（sync が毎回差分を作らない）", () => {
  const entries = [{ id: "x", kind: "fact", text: "同じ値", evidence: [], occurrences: 1, firstSeenAt: "2026-08-01T00:00:00Z" }];
  const now = "2026-08-29T00:00:00Z";
  assert.equal(renderLearnedSection(entries, now), renderLearnedSection(entries, now));
});
