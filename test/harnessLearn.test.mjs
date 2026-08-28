import assert from "node:assert/strict";
import test from "node:test";

import {
  LEARNING_TARGETS,
  PROPOSAL_KINDS,
  buildProposal,
  clusterForConsolidation,
  isActuallyApplied,
  loadTargets,
  proposalId,
  renderOverlay,
  resolveTarget,
  sanitizeForOverlay,
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
  for (const [target, def] of Object.entries(loadTargets())) {
    if (def.relativeToDeployment) {
      // 配置先はクライアント固有なので追跡しない。未設定の環境では
      // パスを勝手に決めず、設定を促して落ちるのが正しい。
      continue;
    }
    assert.doesNotThrow(() => make({ target }), `${target} が弾かれた`);
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
  // 名前空間を3層へ変えたので、旧IDは resolveTarget を通して引く。
  assert.equal(targets[resolveTarget("ledger:koya")].mode, "review-only");
  assert.equal(targets[resolveTarget("doc:mike-audio-gates")].mode, "review-only");
  assert.equal(targets[resolveTarget("ledger:koya")].overlay, undefined, "台帳に overlay があってはいけない");
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

// --- Codexレビュー(2026-08-29)で指摘された経路 ---

test("記録があるだけでは反映済みにならない（正本に実在すること）", () => {
  // 以前は applied.jsonl に id が1行あれば status から消えた。
  // 正本を1文字も変えずに apply を通せてしまっていた。
  const canon = { "docs/x.md": "ここに規則が書いてある" };
  const read = (rel) => canon[rel] ?? null;

  assert.equal(isActuallyApplied({ id: "a" }, read), false, "id だけで通った");
  assert.equal(isActuallyApplied({ id: "a", reviewer: "x" }, read), false, "targetPath 無しで通った");
  assert.equal(
    isActuallyApplied({ id: "a", reviewer: "x", targetPath: "docs/x.md", note: "存在しない文言" }, read),
    false,
    "正本に無い記述で通った",
  );
  assert.equal(
    isActuallyApplied({ id: "a", reviewer: "x", targetPath: "docs/x.md", note: "ここに規則が書いてある" }, read),
    true,
  );
  // 正本が後から差し戻されたら、反映済みではなくなる
  assert.equal(
    isActuallyApplied({ id: "a", reviewer: "x", targetPath: "docs/gone.md", note: "何か" }, read),
    false,
  );
});

test("反映が取り消されたら status に戻る", () => {
  const entry = make();
  const record = { id: entry.id, reviewer: "taiyu", targetPath: "docs/x.md", note: "書いた規則" };
  const withRule = summarizeProposals([entry], [record], () => "書いた規則がある正本");
  assert.equal(withRule[0].applied, true);
  // 正本から消えたら未反映へ戻る
  const withoutRule = summarizeProposals([entry], [record], () => "規則が消された正本");
  assert.equal(withoutRule[0].applied, false, "差し戻しても反映済みのままだった");
});

test("overlay へ入る文字列は記法を無効化する", () => {
  // overlay は次のセッションが指示として読む。改行や見出しで
  // 項目の外へ出て、正規の指示に見える行を作れてはいけない。
  const injected = "通常の指摘\n\n## 偽の見出し\n\n- 偽の指示";
  const clean = sanitizeForOverlay(injected);
  assert.ok(!clean.includes("\n"), "改行が残った");
  assert.ok(!/^##/u.test(clean), "行頭の見出しが残った");
  assert.equal(sanitizeForOverlay("`code`"), "'code'");
  assert.equal(sanitizeForOverlay("<!-- コメント -->"), "コメント");
  assert.equal(sanitizeForOverlay("  > 引用  "), "引用");
  assert.equal(sanitizeForOverlay(null), "");

  // 実際に描画しても項目の外へ出ないこと
  const out = renderOverlay([
    { id: "x", kind: "fact", text: injected, evidence: [injected], occurrences: 1, firstSeenAt: "2026-08-01T00:00:00Z" },
  ], "2026-08-29T00:00:00Z");
  const bogus = out.split("\n").filter((l) => l.startsWith("## 偽の見出し"));
  assert.equal(bogus.length, 0, "偽の見出しが立った");
});

// --- 3層の名前空間（Codexレビュー g1/g3 を受けて） ---

test("宛先は platform / genre / channel-pack の3層に分かれる", () => {
  // g1 の判定で、番組規則は「番組固有」「ジャンル共通」「共通基盤」の
  // 3種が混在していた。2層で扱うと必ずどれかが混ざる。
  const targets = loadTargets();
  const scopes = new Set(Object.values(targets).map((t) => t.scope));
  assert.ok(scopes.has("platform"));
  assert.ok(scopes.has("genre"));
  assert.ok(scopes.has("channel-pack"));
  for (const [id, def] of Object.entries(targets)) {
    assert.ok(id.startsWith(`${def.scope}:`), `${id} と scope=${def.scope} が食い違う`);
  }
});

test("channel-pack は自動反映せず、共有してはいけないと印がある", () => {
  const targets = loadTargets();
  for (const [id, def] of Object.entries(targets)) {
    if (def.scope !== "channel-pack") continue;
    assert.equal(def.mode, "review-only", `${id} が自動反映になっている`);
    assert.equal(def.confidential, true, `${id} に confidential 印が無い`);
    assert.equal(def.overlay, undefined, `${id} に overlay がある`);
  }
});

test("名前を変えても過去の記録が孤児にならない", () => {
  // 提案IDは kind+target+text から作るので、記録の target を書き換えると
  // IDが変わって過去の apply 記録と結び付かなくなる。解決時だけ翻訳する。
  assert.equal(resolveTarget("ledger:koya"), "channel-pack:koya");
  assert.equal(resolveTarget("skill:manga-page-camera"), "genre:manga-page-camera");
  assert.equal(resolveTarget("skill:harness-parallel-execution"), "platform:harness-parallel-execution");
  // 新しいIDはそのまま通る
  assert.equal(resolveTarget("genre:manga-page-camera"), "genre:manga-page-camera");
  // 未知のものは触らない
  assert.equal(resolveTarget("unknown:x"), "unknown:x");
  // 旧IDでも宛先として解決できる
  assert.ok(LEARNING_TARGETS["ledger:koya"], "旧IDが解決できない");
});

test("保存した digest は照合に使う（保存するだけにしない）", () => {
  const record = { id: "a", reviewer: "x", targetPath: "docs/x.md", note: "書いた規則", targetSha256: "aaa" };
  const read = () => "書いた規則がある正本";
  // digest が一致すれば反映済み
  assert.equal(isActuallyApplied(record, read, () => "aaa"), true);
  // 正本が変わっていれば、文言が残っていても別の版に対する記録
  assert.equal(isActuallyApplied(record, read, () => "bbb"), false);
  // 照合手段が無いときは文言だけで判断（後方互換）
  assert.equal(isActuallyApplied(record, read), true);
});
