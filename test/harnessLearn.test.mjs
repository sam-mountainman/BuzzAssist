import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { HUMAN_VERIFIED } from "../scripts/harness-learn.mjs";

import {
  LEARNING_TARGETS,
  PROPOSAL_KINDS,
  buildProposal,
  clusterForConsolidation,
  evidenceDigest,
  isActuallyApplied,
  loadTargets,
  canonicalHasPromotionEvidence,
  promotionMarker,
  proposalId,
  redactForOverlay,
  redactVocabularyDigestTokens,
  renderOverlay,
  resolveTarget,
  sanitizeForOverlay,
  summarizeProposals,
} from "../scripts/harness-learn.mjs";
import {
  buildSensitiveVocabularyDigest,
  parseSensitiveVocabularyDigest,
  SENSITIVE_VOCABULARY_KEY_ENV,
} from "../lib/packageTarballAudit.mjs";

// テスト用の検査語彙の鍵。本番の鍵はリポジトリの外にだけ置く。
const TEST_VOCABULARY_KEY = "3c".repeat(32);

// テストで使う固有語はすべて合成語。実在のキャスト名・顧客識別子・端末 path を
// テストの平文へ書かない（テストファイルも公開リポジトリに載る）。
const SYNTHETIC_CAST = "ゼンタロウ架空";
const SYNTHETIC_CAST_ID = "zentaro_fictional";
const SYNTHETIC_HOME = "/Users/synthetic-operator";
const SYNTHETIC_CLIENT = "fictional-client-xq";
const NO_REDACTION = { terms: [], castIds: [], homeRoot: "", vocabulary: null };

const NOW = "2026-08-29T00:00:00.000Z";
const make = (over = {}) => buildProposal({
  kind: "correction",
  target: "ledger:koya",
  text: "完了報告の前に必ず実測する",
  evidence: "本日3件の自作サインオフを検出",
  session: "test-session",
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
  assert.throws(() => make({ session: "" }), /session が必要/u);
});

test("同じ指摘は同じIDになり、言い回しが違えば別IDになる", () => {
  assert.equal(make().id, make().id);
  assert.equal(make({ evidence: "別の根拠" }).id, make().id, "根拠が違ってもIDは同じであるべき");
  assert.notEqual(make({ text: "別の指摘だと分かる文" }).id, make().id);
  assert.notEqual(make({ target: "skill:manga-page-camera" }).id, make().id);
  assert.notEqual(make({ kind: "preference" }).id, make().id);
});

test("繰り返された指摘ほど上に来る", () => {
  const repeated = make({ session: "repeat-1" });
  const repeatedAgain = make({ session: "repeat-2" });
  const repeatedThird = make({ session: "repeat-3" });
  const once = make({ text: "一度だけ言われたこと" });
  const summary = summarizeProposals([repeated, once, repeatedAgain, repeatedThird], []);
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

test("同じproposalを同じsessionで再捕捉してもoccurrenceを水増ししない", () => {
  const a = make({ session: "session-1", evidence: "根拠A" });
  const repeatedByHook = make({ session: "session-1", evidence: "根拠B" });
  const independent = make({ session: "session-2", evidence: "根拠C" });
  const summary = summarizeProposals([a, repeatedByHook, independent], []);
  assert.equal(summary[0].occurrences, 2);
  assert.deepEqual(summary[0].evidence, ["根拠A", "根拠B", "根拠C"]);
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

test("overlay には根拠の digest と繰り返し回数が残る（逐語は残らない）", () => {
  const out = renderOverlay([
    { id: "x", kind: "correction", text: "二度言われたこと", evidence: ["根拠A", "根拠B"], occurrences: 2, firstSeenAt: "2026-08-01T00:00:00Z" },
  ], "2026-08-29T00:00:00Z", NO_REDACTION);
  assert.match(out, /2回指摘/u);
  assert.doesNotMatch(out, /根拠A/u, "evidence の逐語が overlay に出た");
  assert.doesNotMatch(out, /根拠B/u, "evidence の逐語が overlay に出た");
  assert.ok(out.includes(evidenceDigest("根拠A")), "根拠A の digest が無い");
  assert.ok(out.includes(evidenceDigest("根拠B")), "根拠B の digest が無い");
  assert.match(out, /根拠digest:/u);
  assert.match(out, /`x`/u);
  // digest は sha256 の先頭12桁。台帳側の逐語と突き合わせるための鍵になる。
  assert.match(evidenceDigest("根拠A"), /^[a-f0-9]{12}$/u);
  assert.notEqual(evidenceDigest("根拠A"), evidenceDigest("根拠B"));
});

test("同じ入力なら同じ overlay になる（sync が毎回差分を作らない）", () => {
  const entries = [{ id: "x", kind: "fact", text: "同じ値", evidence: [], occurrences: 1, firstSeenAt: "2026-08-01T00:00:00Z" }];
  const now = "2026-08-29T00:00:00Z";
  assert.equal(renderOverlay(entries, now, NO_REDACTION), renderOverlay(entries, now, NO_REDACTION));
});

// --- 2026-09-05 独立レビュー D-1: overlay 経由の私的情報流出 ---

test("overlay に evidence 逐語が出ない（語彙に無い固有名詞も digest 化で消える）", () => {
  // capture 時の検査（channelTermsInSharedEntry）は Channel Pack 由来の語しか
  // 見ないので、語彙に無い顧客識別子や端末 path は evidence に残って overlay へ
  // 逐語で出ていた。語彙に何も無くても evidence が漏れないことが要件。
  const evidence = `client-work/${SYNTHETIC_CLIENT}/v1/reports/review.md を ${SYNTHETIC_HOME}/scratch で確認。${SYNTHETIC_CAST}のOL衣装`;
  const out = renderOverlay([
    { id: "y", kind: "fact", text: "設定画バッチの検品は機械検出へ昇格する", evidence: [evidence], occurrences: 1, firstSeenAt: "2026-08-01T00:00:00Z" },
  ], "2026-08-29T00:00:00Z", NO_REDACTION);
  for (const leaked of [SYNTHETIC_CLIENT, SYNTHETIC_HOME, SYNTHETIC_CAST, "client-work", "reports/review.md"]) {
    assert.ok(!out.includes(leaked), `evidence の逐語が overlay に残った: ${leaked}`);
  }
  assert.ok(out.includes(evidenceDigest(evidence)));
  // 同じ evidence が複数回積まれても digest は1つ
  const dup = renderOverlay([
    { id: "y", kind: "fact", text: "設定画バッチの検品は機械検出へ昇格する", evidence: [evidence, evidence], occurrences: 2, firstSeenAt: "2026-08-01T00:00:00Z" },
  ], "2026-08-29T00:00:00Z", NO_REDACTION);
  assert.equal(dup.split(evidenceDigest(evidence)).length - 1, 1);
});

test("overlay の text 側は redactSharedLearningText と digest 語彙を通る", () => {
  const vocabulary = parseSensitiveVocabularyDigest(
    buildSensitiveVocabularyDigest([SYNTHETIC_CLIENT, "架空太郎"], { key: TEST_VOCABULARY_KEY, generatedAt: "2026-09-05T00:00:00Z" }),
    { key: TEST_VOCABULARY_KEY },
  );
  const context = { terms: [SYNTHETIC_CAST], castIds: [SYNTHETIC_CAST_ID], homeRoot: SYNTHETIC_HOME, vocabulary };
  const text = `${SYNTHETIC_CAST}の衣装は ${SYNTHETIC_HOME}/wardrobe に置く。${SYNTHETIC_CAST_ID} は client-work/${SYNTHETIC_CLIENT} 由来。運営者架空太郎さんの指示`;
  const out = renderOverlay([
    { id: "z", kind: "constraint", text, evidence: [], occurrences: 1, firstSeenAt: "2026-08-01T00:00:00Z" },
  ], "2026-08-29T00:00:00Z", context);
  for (const leaked of [SYNTHETIC_CAST, SYNTHETIC_CAST_ID, SYNTHETIC_HOME, SYNTHETIC_CLIENT, "架空太郎"]) {
    assert.ok(!out.includes(leaked), `text の固有語が overlay に残った: ${leaked}`);
  }
  assert.match(out, /<channel-term>/u);
  assert.match(out, /<channel-id>/u);
  assert.match(out, /<machine-path>/u);
  assert.match(out, /<private-term>/u);

  // digest 語彙は監査と同じ tokenizer で照合する（Latin token の `-` 区切り部分、漢字連の部分列）。
  const redacted = redactVocabularyDigestTokens(`運営者架空太郎さん / ${SYNTHETIC_CLIENT}`, vocabulary);
  assert.ok(redacted.hits >= 2);
  assert.ok(!redacted.text.includes("架空太郎"));
  assert.ok(!redacted.text.includes(SYNTHETIC_CLIENT));
  // 語彙が無ければ何もしない（digest 方式が主で、語彙は補助）
  assert.deepEqual(redactVocabularyDigestTokens("そのまま", null), { text: "そのまま", hits: 0 });
  // redaction 後も記法は無効化される
  assert.ok(!redactForOverlay("a\n\n## 偽の見出し", NO_REDACTION).includes("\n"));
});

test("再生成済みの overlay に evidence 逐語の行が残っていない", async () => {
  // sync の出力そのもの。ここが緑でも配布時の再 sync を怠れば戻るので、
  // tarball 監査（private-term）と二重に見る。
  const { readFileSync, existsSync, readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = fileURLToPath(new URL("..", import.meta.url));
  const skillsRoot = join(root, ".agents", "skills");
  if (!existsSync(skillsRoot)) return;
  let checked = 0;
  for (const name of readdirSync(skillsRoot)) {
    const overlay = join(skillsRoot, name, "references", "learned-auto.md");
    if (!existsSync(overlay)) continue;
    checked += 1;
    for (const line of readFileSync(overlay, "utf8").split("\n")) {
      assert.doesNotMatch(line, /^\s+- 根拠: /u, `${name}: evidence 逐語の行が残っている`);
      assert.doesNotMatch(line, /\/(?:Users|home|private\/tmp|var\/folders)\//u, `${name}: 端末 path が残っている`);
      assert.doesNotMatch(line, /client-work\//u, `${name}: 顧客作業 path が残っている`);
    }
  }
  assert.ok(checked > 0, "overlay が1つも無い");
});

test("空でも overlay は成立し、内容が無いと分かる", () => {
  assert.match(renderOverlay([], "2026-08-29T00:00:00Z"), /まだ自動反映された項目はありません/u);
});

// --- Codexレビュー(2026-08-29)で指摘された経路 ---

test("記録があるだけでは反映済みにならない（正本に実在すること）", () => {
  // 以前は applied.jsonl に id が1行あれば status から消えた。
  // 正本を1文字も変えずに apply を通せてしまっていた。
  const canon = { "docs/x.md": "buzzassist-learning:a\nここに十分長い規則が書いてある" };
  const read = (rel) => canon[rel] ?? null;

  assert.equal(isActuallyApplied({ id: "a" }, read), false, "id だけで通った");
  assert.equal(isActuallyApplied({ id: "a", reviewer: "x" }, read), false, "targetPath 無しで通った");
  assert.equal(
    isActuallyApplied({ id: "a", reviewer: "x", attestedBy: HUMAN_VERIFIED, targetPath: "docs/x.md", note: "存在していない十分長い文言" }, read),
    false,
    "正本に無い記述で通った",
  );
  assert.equal(
    isActuallyApplied({ id: "a", reviewer: "x", attestedBy: HUMAN_VERIFIED, targetPath: "docs/x.md", note: "ここに十分長い規則が書いてある" }, read),
    true,
  );
  // 正本が後から差し戻されたら、反映済みではなくなる
  assert.equal(
    isActuallyApplied({ id: "a", reviewer: "x", attestedBy: HUMAN_VERIFIED, targetPath: "docs/gone.md", note: "何か" }, read),
    false,
  );
});

test("反映が取り消されたら status に戻る", () => {
  const entry = make();
  const record = { id: entry.id, reviewer: "taiyu", attestedBy: HUMAN_VERIFIED, targetPath: "docs/x.md", note: "正本へ書いた十分に長い規則本文" };
  const withRule = summarizeProposals([entry], [record], () => `${promotionMarker(entry.id)}\n正本へ書いた十分に長い規則本文`);
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
  ], "2026-08-29T00:00:00Z", NO_REDACTION);
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
  const record = { id: "a", reviewer: "x", attestedBy: HUMAN_VERIFIED, targetPath: "docs/x.md", note: "正本へ書いた十分に長い規則本文", targetSha256: "aaa" };
  const read = () => "buzzassist-learning:a\n正本へ書いた十分に長い規則本文";
  // digest が一致すれば反映済み
  assert.equal(isActuallyApplied(record, read, () => "aaa"), true);
  // 正本が変わっていれば、文言が残っていても別の版に対する記録
  assert.equal(isActuallyApplied(record, read, () => "bbb"), false);
  // 照合手段が無いときは文言だけで判断（後方互換）
  assert.equal(isActuallyApplied(record, read), true);
});

test("TTY は人の証明ではない、という前提で組まれている", async () => {
  // 最初の修正は TTY の有無で人と機械を分けた。Codex のレビューで
  // `script -q /dev/null node ...` を通せば isTTY が true になることが
  // 実測され、しかも当時は TTY を先に見ていたので **PTY 経由で
  // --agent-attested を付けても「人の確認」として記録された**。
  const { attestationFor, HUMAN_VERIFIED } = await import("../scripts/harness-learn.mjs");

  // 明示が推測に勝つこと。ここが逆順だったのが穴。
  const spoofed = attestationFor({ reviewer: "someone", isInteractive: true, agentAttested: true });
  assert.equal(spoofed.attestation.reviewer, "agent", "PTY を割り当てても機械は機械として記録すること");
  assert.equal(spoofed.attestation.attestedBy, "agent-self-attested");
  assert.equal(spoofed.attestation.claimedReviewer, "someone", "何を名乗ろうとしたかは残すこと");

  // TTY だけでは人の確認にならない。記録は残るが印は弱い方。
  const tty = attestationFor({ reviewer: "someone", isInteractive: true });
  assert.equal(tty.ok, true);
  assert.equal(tty.attestation.attestedBy, "cli-interactive-claimed",
    "対話端末だったという事実であって、人が読んだ証拠ではない");
  assert.notEqual(tty.attestation.attestedBy, HUMAN_VERIFIED);

  // 人の確認は、対話端末＋明示の二手を要る。
  assert.equal(
    attestationFor({ reviewer: "someone", isInteractive: true, humanVerified: true })
      .attestation.attestedBy, HUMAN_VERIFIED,
  );
  assert.equal(
    attestationFor({ reviewer: "someone", isInteractive: false, humanVerified: true }).ok, false,
    "非対話から --human-verified を通してはいけない",
  );

  // 裏づけが何も無い経路は既定で拒否。
  const bare = attestationFor({ reviewer: "someone", isInteractive: false });
  assert.equal(bare.ok, false);
  assert.match(bare.message, /--agent-attested/u, "どうすればよいかを示すこと");
  assert.equal(attestationFor({ reviewer: "", isInteractive: true }).ok, false, "名前が空なら拒否");
});

test("人の確認が無い記録は「反映済み」として数えない", async () => {
  // ここが実効の中心だった。isActuallyApplied は reviewer が空でないこと
  // しか見ていなかったので、agent-self-attested も unverified-agent-typed も
  // attestedBy 欠落も、人の確認と同じ効力で applied になっていた。
  // しかも applied は未反映一覧から消えるので、**後から人が昇格しようと
  // すると「既に反映済み」で拒まれる**——機械の自己申告が人の確認を
  // 締め出す向きに働いていた。
  const { isActuallyApplied, summarizeProposals, HUMAN_VERIFIED } =
    await import("../scripts/harness-learn.mjs");
  const readCanonical = () => "buzzassist-learning:p1\n正本にこの十分長い一節が書いてある";
  const base = { id: "p1", reviewer: "someone", targetPath: "t.md", note: "正本にこの十分長い一節が書いてある" };

  for (const attestedBy of ["agent-self-attested", "unverified-agent-typed", "cli-interactive-claimed", undefined, "", "でたらめ"]) {
    assert.equal(
      isActuallyApplied({ ...base, attestedBy }, readCanonical), false,
      `attestedBy=${String(attestedBy)} を反映済みとして数えてはいけない`,
    );
  }
  assert.equal(isActuallyApplied({ ...base, attestedBy: HUMAN_VERIFIED }, readCanonical), true);

  // 未確認の記録が、未反映一覧から提案を消さないこと。
  const proposals = [{ id: "p1", text: "何か" }];
  const machine = summarizeProposals(proposals, [{ ...base, attestedBy: "agent-self-attested" }], readCanonical);
  assert.equal(
    JSON.stringify(machine).includes("p1"), true,
    "機械の自己申告で提案が一覧から消えてはいけない",
  );
});

test("反映証跡の本文は marker の近くに無ければ認めない（別の変更の文を流用できない）", async () => {
  // marker が1行あり、note が正本の「どこか」にあれば通っていた。40 行以上離れた
  // 別の節の文を --note に渡せば、その提案を書いていなくても反映済みにできた。
  const { canonicalHasPromotionEvidence, PROMOTION_EVIDENCE_WINDOW_LINES } = await import("../scripts/harness-learn.mjs");
  const note = "別の節に元からある十分長い規則の本文";
  const far = ["buzzassist-learning:near1", ...Array(PROMOTION_EVIDENCE_WINDOW_LINES + 5).fill("- 無関係の行"), note].join("\n");
  assert.equal(canonicalHasPromotionEvidence({ id: "near1", note }, far), false, "窓の外の文を証拠にしないこと");
  const close = ["buzzassist-learning:near1", ...Array(5).fill("- 無関係の行"), note].join("\n");
  assert.equal(canonicalHasPromotionEvidence({ id: "near1", note }, close), true);
  const before = [note, ...Array(3).fill("- 無関係の行"), "buzzassist-learning:near1"].join("\n");
  assert.equal(canonicalHasPromotionEvidence({ id: "near1", note }, before), true, "note が marker の前にあってもよい");
  const multiline = ["buzzassist-learning:near1", "規則:", "  一行目の十分長い本文", "  二行目の本文"].join("\n");
  assert.equal(canonicalHasPromotionEvidence({ id: "near1", note: "一行目の十分長い本文\n  二行目の本文" }, multiline), true, "複数行の note も認める");
});

test("正本への反映証跡はproposal固有markerと十分長い完全一致本文を両方要求する", () => {
  const text = "buzzassist-learning:abc123\n同じ失敗を避けるための十分長い規則本文";
  assert.equal(canonicalHasPromotionEvidence({ id: "abc123", note: "同じ失敗を避けるための十分長い規則本文" }, text), true);
  assert.equal(canonicalHasPromotionEvidence({ id: "other", note: "同じ失敗を避けるための十分長い規則本文" }, text), false);
  assert.equal(canonicalHasPromotionEvidence({ id: "abc123", note: "十分長い規則" }, text), false);
  assert.equal(canonicalHasPromotionEvidence({ id: "abc123", note: "正本には存在しない十分長い規則本文" }, text), false);
});

test("既存の記録に、人の確認が取れていないことが残っている", async () => {
  // 消さない（スキルの原則）。ただし「人が確認した」と読めないようにする。
  const { readFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = fileURLToPath(new URL("..", import.meta.url));
  const file = join(root, "docs/learning/applied.jsonl");
  if (!existsSync(file)) return;
  const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  for (const row of rows) {
    assert.ok(row.attestedBy, `${row.id}: 誰が名乗ったかが記録されていない`);
    assert.notEqual(row.attestedBy, "human-interactive",
      "TTY だけを根拠にした古い印が残っている（人の証明ではない）");
    if (row.attestedBy === "unverified-agent-typed") {
      assert.equal(row.reviewer, "agent", "未確認の記録に人の名前を残さない");
      assert.ok(row.attestationNote, "なぜ未確認なのかを残すこと");
    }
  }
});

test("チャンネル宛の捕捉は、公開側の台帳へ書かれない", async () => {
  // capture は宛先に関わらず共有台帳（公開リポジトリで追跡）へ書いていた。
  // 固有語の検査は「共有層宛の提案に固有語が入っていないか」しか見ないので、
  // 宛先が channel-pack: なら固有語ごと通り、そのまま公開側へ溜まった。
  // 層を分けたつもりが、分けていたのは宛先のラベルだけで書き先は1つだった。
  // 実害: 別セッションが捕捉するたび公開面の検査が赤くなり、手で移していた。
  const { ledgerPathFor } = await import("../scripts/harness-learn.mjs");
  const shared = ledgerPathFor("genre:manga-video-production");
  const channel = ledgerPathFor("channel-pack:koya");
  assert.notEqual(channel, shared, "チャンネル宛と共有層で書き先が違うこと");
  assert.ok(channel.includes("channel-packs"), "チャンネル宛は pack 側へ書くこと");
  assert.ok(!shared.includes("channel-packs"), "共有層は共有台帳へ書くこと");
  assert.equal(ledgerPathFor("platform:craft"), shared, "platform も共有台帳");
  assert.equal(ledgerPathFor(""), shared, "宛先不明は共有台帳（既定は変えない）");
  // applied 側も同じ規則で分かれること。
  assert.ok(ledgerPathFor("channel-pack:koya", "applied").includes("channel-packs"));
  assert.notEqual(
    ledgerPathFor("channel-pack:koya"),
    ledgerPathFor("channel-pack:narrated-story"),
    "active pack環境変数が別channel targetを同じ台帳へ潰してはいけない",
  );
});

// --- 2026-09-06 再レビュー R2-L1: 語彙欠落を許可として扱わない ---

test("digest 語彙が無ければ overlay の redaction 材料を作らず throw する（fail-closed）", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { overlayRedactionContext, OVERLAY_VOCABULARY_MISSING_NOTE } = await import("../scripts/harness-learn.mjs");
  const projectDir = mkdtempSync(join(tmpdir(), "harness-learn-vocab-"));
  try {
    // 壊れている時は元から throw していた。無い時も同じ扱いになること。
    assert.throws(
      () => overlayRedactionContext({ projectDir, homeRoot: SYNTHETIC_HOME }),
      /sensitive-vocabulary\.digest\.json/u,
    );
    // 明示フラグでだけ通り、返り値に印が付く
    const allowed = overlayRedactionContext({ projectDir, homeRoot: SYNTHETIC_HOME, allowMissingVocabulary: true });
    assert.equal(allowed.vocabularyMissing, true);
    assert.equal(allowed.vocabulary, null);
    // 印は overlay ヘッダへ刻まれる（空の overlay でも）
    const empty = renderOverlay([], "2026-09-06T00:00:00Z", allowed);
    assert.ok(empty.includes(OVERLAY_VOCABULARY_MISSING_NOTE), "空 overlay に語彙照合なしの印が無い");
    assert.match(empty, /語彙照合なし/u);
    const filled = renderOverlay([
      { id: "w", kind: "fact", text: "合成語だけの提案本文です", evidence: [], occurrences: 1, firstSeenAt: "2026-08-01T00:00:00Z" },
    ], "2026-09-06T00:00:00Z", allowed);
    assert.match(filled, /語彙照合なし/u);
    // 語彙があれば印は付かない
    mkdirSync(join(projectDir, "docs", "learning"), { recursive: true });
    writeFileSync(
      join(projectDir, "docs", "learning", "sensitive-vocabulary.digest.json"),
      JSON.stringify(buildSensitiveVocabularyDigest([SYNTHETIC_CLIENT], { key: TEST_VOCABULARY_KEY, generatedAt: "2026-09-06T00:00:00Z" })),
    );
    // 一覧はあるのに鍵が無い＝照合できない。「語彙あり」とも「無し」とも丸めず止める。
    const savedKey = process.env[SENSITIVE_VOCABULARY_KEY_ENV];
    process.env[SENSITIVE_VOCABULARY_KEY_ENV] = "";
    const savedHome = process.env.HOME;
    process.env.HOME = join(projectDir, "..", `${projectDir.split(/[\\/]/u).pop()}-nohome`);
    try {
      assert.throws(
        () => overlayRedactionContext({ projectDir, homeRoot: SYNTHETIC_HOME }),
        /照合できない/u,
      );
    } finally {
      process.env.HOME = savedHome;
    }
    process.env[SENSITIVE_VOCABULARY_KEY_ENV] = TEST_VOCABULARY_KEY;
    let present;
    try {
      present = overlayRedactionContext({ projectDir, homeRoot: SYNTHETIC_HOME });
    } finally {
      if (savedKey === undefined) delete process.env[SENSITIVE_VOCABULARY_KEY_ENV];
      else process.env[SENSITIVE_VOCABULARY_KEY_ENV] = savedKey;
    }
    assert.equal(present.vocabularyMissing, false);
    assert.ok(present.vocabulary && present.vocabulary.count === 1);
    const clean = renderOverlay([], "2026-09-06T00:00:00Z", present);
    assert.doesNotMatch(clean, /語彙照合なし/u, "語彙がある overlay に欠落の印が付いた");
    // テスト用の素通しコンテキスト（vocabulary: null のみ）は印を付けない
    assert.doesNotMatch(renderOverlay([], "2026-09-06T00:00:00Z", NO_REDACTION), /語彙照合なし/u);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("sync CLI は digest 語彙が無いと止まり、--allow-missing-vocabulary の説明が help にある", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../scripts/harness-learn.mjs", import.meta.url), "utf8");
  // sync が overlayRedactionContext に allowMissingVocabulary を渡し、既定は false であること
  assert.match(source, /overlayRedactionContext\(\{ allowMissingVocabulary \}\)/u);
  assert.match(source, /args\.allowMissingVocabulary === true/u);
  assert.match(source, /--allow-missing-vocabulary/u);
});

test("共有台帳への捕捉は、同じロックの中で公開 catalog を作り直す", async () => {
  // catalog は台帳からの派生物なのに、捕捉は台帳だけに書いていた。別セッションが
  // 捕捉するたびに catalog がずれてテストが落ち、手で再生成していた
  // （2026-09-17 には台帳 74 件・catalog 63 件）。
  const { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { captureLearningProposal, refreshPublicProposalCatalog } = await import("../scripts/harness-learn.mjs");
  const { comparePublicProposalCatalog } = await import("../lib/harnessLearningCurator.mjs");
  const root = mkdtempSync(join(tmpdir(), "learn-catalog-"));
  try {
    const shared = join(root, "shared", "proposals.jsonl");
    const pack = join(root, "pack", "proposals.jsonl");
    const catalog = join(root, "shared", "proposals.public.jsonl");
    mkdirSync(join(root, "shared"), { recursive: true });
    mkdirSync(join(root, "pack"), { recursive: true });
    const resolver = (target) => (String(target).startsWith("channel-pack:") ? pack : shared);
    const calls = [];
    const refreshCatalog = (ledgerPath) => {
      calls.push(ledgerPath);
      return ledgerPath === shared ? refreshPublicProposalCatalog({ ledgerPath, catalogPath: catalog }) : { written: false, skipped: true };
    };
    const signals = { terms: [], castIds: [] };
    const base = { kind: "fact", evidence: "", session: "s1", now: "2026-09-17T00:00:00Z" };

    const first = captureLearningProposal(
      { ...base, target: "platform:platform-craft", text: "共有層の一般的な規則その一" },
      { ledgerPathResolver: resolver, refreshCatalog, signals },
    );
    assert.equal(first.appended, true);
    assert.equal(first.catalog.written, true, "共有台帳へ書いたら catalog も作り直すこと");
    const ledgerRows = readFileSync(shared, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(comparePublicProposalCatalog({ ledgerRows, catalogText: readFileSync(catalog, "utf8") }).ok, true,
      "作り直した catalog が台帳と一致すること");
    assert.ok(readFileSync(catalog, "utf8").includes(first.entry.id));
    assert.equal(readFileSync(catalog, "utf8").includes("一般的な規則"), false, "catalog に本文を載せない");

    // 同じ捕捉の繰り返しは台帳も catalog も変えない。
    const again = captureLearningProposal(
      { ...base, target: "platform:platform-craft", text: "共有層の一般的な規則その一" },
      { ledgerPathResolver: resolver, refreshCatalog, signals },
    );
    assert.equal(again.appended, false);
    assert.equal(again.catalog.written, false);

    // pack 宛の捕捉は公開 catalog の材料ではない。
    const before = readFileSync(catalog, "utf8");
    const packed = captureLearningProposal(
      { ...base, target: "channel-pack:narrated-story", text: "チャンネル固有の規則" },
      { ledgerPathResolver: resolver, refreshCatalog, signals },
    );
    assert.equal(packed.appended, true);
    assert.equal(readFileSync(catalog, "utf8"), before, "pack 宛の捕捉で公開 catalog を変えない");
    assert.equal(existsSync(pack), true);

    // 既定の作り直しは、共有台帳以外への書き込みでは何もしない。
    const defaulted = captureLearningProposal(
      { ...base, target: "channel-pack:narrated-story", text: "チャンネル固有の規則その二" },
      { ledgerPathResolver: resolver, signals },
    );
    assert.equal(defaulted.catalog.skipped, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("共有台帳への捕捉は、検査語彙に一致する語（人の名前や顧客の識別子）を拒否する", async () => {
  // 捕捉の検査は Channel Pack の語しか見ていなかったので、語彙ファイルにだけある語
  // ——依頼者の名前と発言の引用、顧客のエピソード ID、端末の作業ディレクトリ名——が
  // 共有台帳へ入り、公開リポジトリへ push されるところだった。
  const { captureLearningProposal, privateTermsInSharedEntry } = await import("../scripts/harness-learn.mjs");
  const vocabulary = parseSensitiveVocabularyDigest(
    buildSensitiveVocabularyDigest(["架空依頼者", "episode-xyz"], { key: TEST_VOCABULARY_KEY }),
    { key: TEST_VOCABULARY_KEY },
  );
  const writes = [];
  const options = {
    signals: { terms: [], castIds: [] },
    append: (file, entry) => writes.push({ file, entry }),
    read: () => [],
    lock: (_file, action) => action(),
    refreshCatalog: () => ({ written: false }),
    privateVocabulary: vocabulary,
  };
  const base = { kind: "fact", session: "s1", now: "2026-09-17T00:00:00Z", target: "platform:platform-craft" };

  assert.throws(
    () => captureLearningProposal({ ...base, text: "共有層の一般的な規則", evidence: "架空依頼者さんの発言より" }, options),
    (error) => /公開してはいけない語/u.test(error.message) && !error.message.includes("架空依頼者"),
    "人の名前を含む根拠を共有台帳へ書かせない（拒否の文に語を出さない）",
  );
  assert.throws(
    () => captureLearningProposal({ ...base, text: "共有層の一般的な規則", evidence: "episodes/episode-xyz-v1/audits" }, options),
    /公開してはいけない語/u,
  );
  assert.equal(writes.length, 0, "拒否したものは台帳へ書かない");

  // 一般的な言い方なら通る。
  const ok = captureLearningProposal({ ...base, text: "共有層の一般的な規則", evidence: "依頼者の指摘より" }, options);
  assert.equal(ok.appended, true);
  // pack 宛は対象外（pack 側の台帳は公開しない）。
  assert.equal(privateTermsInSharedEntry({ target: "channel-pack:koya", text: "架空依頼者" }, vocabulary).ok, true);
  // 語彙を照合できない環境では止めない（push 前の検査が同じ語彙で止める）。
  assert.deepEqual(privateTermsInSharedEntry({ target: "platform:platform-craft", text: "架空依頼者" }, null), { ok: true, hits: 0, checked: false });
});
