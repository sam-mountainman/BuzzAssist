import assert from "node:assert/strict";
import test from "node:test";

import {
  LEARNING_TARGETS,
  PROPOSAL_KINDS,
  buildProposal,
  clusterForConsolidation,
  loadTargets,
  proposalId,
  renderOverlay,
  summarizeProposals,
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

test("overlay は機械が丸ごと所有し、正本は別ファイルのまま", () => {
  // 当初は正本の中にマーカーを埋める方式にしたが、機械が人の文書の一部を
  // 編集する構造だと、マーカー破損が人の記述を巻き込む。ファイル単位に改めた。
  const targets = loadTargets();
  for (const [id, def] of Object.entries(targets)) {
    assert.ok(def.canonical, `${id}: canonical が無い`);
    if (def.mode === "auto-guidance") {
      assert.ok(def.overlay, `${id}: auto-guidance なのに overlay が無い`);
      assert.notEqual(def.overlay, def.canonical, `${id}: overlay と canonical が同じ`);
    }
  }
});

test("承認と監査の記録は自動反映しない", () => {
  // 台帳とゲート基準は、機械が書き足すと何を人が決めたのか分からなくなる。
  const targets = loadTargets();
  assert.equal(targets["ledger:koya"].mode, "review-only");
  assert.equal(targets["doc:mike-audio-gates"].mode, "review-only");
  assert.equal(targets["ledger:koya"].overlay, undefined, "台帳に overlay があってはいけない");
});

test("overlay は自分が正本でないと明記する", () => {
  // 次のセッションがこれを読む。証跡として使われないことが本文から分かる必要がある。
  const out = renderOverlay([], "2026-08-29T00:00:00Z");
  assert.match(out, /SKILL\.md が優先/u);
  assert.match(out, /証跡には使えません/u);
  assert.match(out, /手で編集しないでください/u);
});

test("overlay には根拠と繰り返し回数が残る", () => {
  const out = renderOverlay([
    { id: "x", kind: "correction", text: "二度言われたこと", evidence: ["根拠A", "根拠B"], occurrences: 2, firstSeenAt: "2026-08-01T00:00:00Z" },
  ], "2026-08-29T00:00:00Z");
  assert.match(out, /2回指摘/u);
  assert.match(out, /根拠A/u);
  assert.match(out, /根拠B/u);
  assert.match(out, /`x`/u);
});

test("同じ入力なら同じ overlay になる（sync が毎回差分を作らない）", () => {
  const entries = [{ id: "x", kind: "fact", text: "同じ値", evidence: [], occurrences: 1, firstSeenAt: "2026-08-01T00:00:00Z" }];
  const now = "2026-08-29T00:00:00Z";
  assert.equal(renderOverlay(entries, now), renderOverlay(entries, now));
});

test("空でも overlay は成立し、内容が無いと分かる", () => {
  assert.match(renderOverlay([], "2026-08-29T00:00:00Z"), /まだ自動反映された項目はありません/u);
});
