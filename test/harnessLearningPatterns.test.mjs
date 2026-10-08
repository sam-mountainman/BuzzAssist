// 学びのパターンの記録（lib/harnessLearningPatterns.mjs）と、学びの束（learned-auto.md）への組み込み。
// 提案・パターンの本文は合成のもの。
import assert from "node:assert/strict";
import test from "node:test";

import {
  PATTERN_RECORD_VERSION,
  buildPatternRevision,
  latestPatterns,
  patternCoverage,
  patternInspectionText,
  renderPatternRuleLines,
} from "../lib/harnessLearningPatterns.mjs";
import { planOverlaySync, renderOverlay, suggestPatternGroups } from "../scripts/harness-learn.mjs";

const NOW = "2026-10-09T00:00:00.000Z";
const TARGET = "platform:sample-target";
const proposal = (id, kind, text, extra = {}) => ({
  id, kind, text, target: TARGET, occurrences: 1, firstSeenAt: "2026-10-01T00:00:00.000Z", evidence: [], applied: false, ...extra,
});
const proposals = [
  proposal("aaaaaaaaaaa1", "fact", "合成の事実その一。再送の前に受理済みかを確かめる"),
  proposal("aaaaaaaaaaa2", "correction", "合成の訂正。受理済みの仕事を新しい鍵で送り直さない"),
  proposal("aaaaaaaaaaa3", "constraint", "合成の禁止。鍵を記録に書かない"),
  proposal("aaaaaaaaaaa4", "fact", "合成の事実その二。別の話題"),
];
const options = (extra = {}) => ({
  now: NOW,
  knownTargets: [TARGET, "platform:other-target"],
  proposalTargets: new Map(proposals.map((entry) => [entry.id, TARGET])),
  ...extra,
});
const draft = (extra = {}) => ({
  id: "pat-sample-resend",
  target: TARGET,
  title: "受理済みの仕事を送り直さない",
  rule: "課金の仕事を送り直す前に、受理済みかを確かめる。受理済みなら同じ鍵で状態を見に行く",
  problem: "受理済みの仕事を新しい鍵で送り直し、二重に課金された",
  appliesWhen: "有料の生成を時間切れのあとに再開するとき",
  notWhen: "受理の前に失敗したと確かめられたとき",
  causeHypotheses: [{ text: "時間切れを失敗と同じに扱っていた", status: "confirmed" }, { text: "受理の記録を読んでいなかった" }],
  proposalIds: ["aaaaaaaaaaa1", "aaaaaaaaaaa2"],
  scope: { hosts: ["claude", "codex"] },
  successEvidence: [{ text: "受理を確かめてから再開した回は二重課金が無かった", ref: "synthetic-run-1" }],
  status: "active",
  note: "最初の版",
  ...extra,
});

test("パターンの1版を検証して作る（元の提案・原因の見立て・当てはまる条件が要る）", () => {
  const { record, problems } = buildPatternRevision(draft(), options());
  assert.deepEqual(problems, []);
  assert.equal(record.version, PATTERN_RECORD_VERSION);
  assert.equal(record.revision, 1);
  assert.equal(record.updatedBy, "agent");
  assert.deepEqual(record.causeHypotheses.map((cause) => cause.status), ["confirmed", "hypothesis"], "状態の無い見立ては仮説");
  assert.equal(record.createdAt, NOW);

  // 版を上げると createdAt は保ち、revision が増える。
  const next = buildPatternRevision(draft({ note: "反証を足した", counterEvidence: [{ text: "受理済みでも鍵を替えてよい経路があった" }] }), options({ previous: record, now: "2026-10-10T00:00:00.000Z" }));
  assert.deepEqual(next.problems, []);
  assert.equal(next.record.revision, 2);
  assert.equal(next.record.createdAt, NOW);

  const bad = (extra, pattern) => {
    const { record: none, problems: found } = buildPatternRevision(draft(extra), options());
    assert.equal(none, null);
    assert.ok(found.some((problem) => pattern.test(problem)), `${pattern}: ${found.join(" / ")}`);
  };
  bad({ id: "sample" }, /id は pat-/u);
  bad({ target: "platform:unknown" }, /target が宛先の一覧にありません/u);
  bad({ proposalIds: [] }, /proposalIds/u);
  bad({ proposalIds: ["bbbbbbbbbbb1"] }, /台帳にありません/u);
  bad({ causeHypotheses: [] }, /原因の見立て/u);
  bad({ appliesWhen: "" }, /appliesWhen/u);
  bad({ note: "" }, /note/u);
  bad({ causeHypotheses: [{ text: "否定された見立てだけ", status: "refuted" }] }, /否定されていない原因の見立て/u);
  bad({ status: "superseded" }, /supersededBy/u);
  bad({ status: "refuted" }, /counterEvidence/u);
  bad({ scope: { hosts: ["other"] } }, /scope\.hosts/u);
  // 別の宛先の提案は入れられない。
  const otherTarget = buildPatternRevision(draft(), options({ proposalTargets: new Map([["aaaaaaaaaaa1", "platform:other-target"], ["aaaaaaaaaaa2", TARGET]]) }));
  assert.ok(otherTarget.problems.some((problem) => /宛先.*違います/u.test(problem)));
  // 宛先は版をまたいで変えられない。
  const moved = buildPatternRevision(draft({ target: "platform:other-target", proposalIds: [] }), options({ previous: { revision: 1, target: TARGET } }));
  assert.ok(moved.problems.some((problem) => /宛先は変えられません/u.test(problem)));
});

test("最新の版だけを読み、active のパターンでまとめた提案と、禁止・まとまっていない提案に分ける", () => {
  const first = buildPatternRevision(draft({ status: "draft" }), options()).record;
  const second = buildPatternRevision(draft({ note: "active にした" }), options({ previous: first })).record;
  const latest = latestPatterns([second, first, { version: "other", id: "pat-x" }, { ...first, id: "bad id" }]);
  assert.deepEqual([...latest.keys()], ["pat-sample-resend"]);
  assert.equal(latest.get("pat-sample-resend").revision, 2);

  const coverage = patternCoverage(proposals, [...latest.values()]);
  assert.deepEqual(coverage.covered.map((entry) => entry.id), ["aaaaaaaaaaa1", "aaaaaaaaaaa2"]);
  assert.deepEqual(coverage.mandatory.map((entry) => entry.id), ["aaaaaaaaaaa3"], "禁止は原文のまま残す");
  assert.deepEqual(coverage.uncovered.map((entry) => entry.id), ["aaaaaaaaaaa4"]);
  // 禁止をパターンに入れても、原文は残す。
  const withConstraint = buildPatternRevision(draft({ id: "pat-sample-keys", proposalIds: ["aaaaaaaaaaa3"] }), options()).record;
  assert.deepEqual(patternCoverage(proposals, [withConstraint]).mandatory.map((entry) => entry.id), ["aaaaaaaaaaa3"]);
  // draft のパターンは学びの束に載せない（まとめた扱いにしない）。
  assert.equal(patternCoverage(proposals, [first]).covered.length, 0);
});

test("学びの束では、規則・条件・確かめた原因・元の提案を載せ、否定された原因は載せない", () => {
  const record = buildPatternRevision(draft({ causeHypotheses: [{ text: "確かめた原因", status: "confirmed" }, { text: "否定された原因", status: "refuted" }] }), options()).record;
  const lines = renderPatternRuleLines([record]).join("\n");
  assert.match(lines, /\*\*受理済みの仕事を送り直さない\*\*: 課金の仕事を送り直す前に/u);
  assert.match(lines, /当てはまるとき: 有料の生成を時間切れのあとに再開するとき/u);
  assert.match(lines, /当てはまらないとき: 受理の前に失敗したと確かめられたとき/u);
  assert.match(lines, /原因（確かめた）: 確かめた原因/u);
  assert.doesNotMatch(lines, /否定された原因/u);
  assert.match(lines, /パターン: `pat-sample-resend` 第1版 \/ 元の提案: `aaaaaaaaaaa1`, `aaaaaaaaaaa2`/u);
  // 検査にかける本文には、全ての文字列欄が入る（成功・反証の根拠も）。
  assert.match(patternInspectionText(record), /受理を確かめてから再開した回/u);
});

test("sync: overlayMode が patterns の宛先だけ、まとめた規則と残りの提案で学びの束を作る", () => {
  const record = buildPatternRevision(draft(), options()).record;
  const targets = {
    [TARGET]: { mode: "auto-guidance", overlay: ".agents/skills/sample/references/learned-auto.md", overlayMode: "patterns", scope: "platform" },
    "platform:other-target": { mode: "auto-guidance", overlay: ".agents/skills/other/references/learned-auto.md", scope: "platform" },
  };
  const other = proposal("ccccccccccc1", "fact", "別の宛先の合成の事実", { target: "platform:other-target" });
  const plan = planOverlaySync([...proposals, other], targets, { homeRoot: "/nonexistent-home", patternRows: [record] });
  const sample = plan.overlays.find((item) => item.target === TARGET);
  assert.deepEqual(sample.patterns.map((pattern) => pattern.id), ["pat-sample-resend"]);
  assert.equal(sample.coveredCount, 2);
  assert.deepEqual(sample.entries.map((entry) => entry.id), ["aaaaaaaaaaa3", "aaaaaaaaaaa4"]);
  const plain = plan.overlays.find((item) => item.target === "platform:other-target");
  assert.equal(plain.patterns, undefined, "patterns でない宛先は今までどおり");
  assert.deepEqual(plain.entries.map((entry) => entry.id), ["ccccccccccc1"]);

  const context = { vocabulary: null, channelTerms: [], castIds: [], homeRoot: "/nonexistent-home" };
  const text = renderOverlay(sample.entries, NOW, context, { patterns: sample.patterns });
  assert.match(text, /## まとめた規則（パターン）/u);
  assert.match(text, /## 禁止と、まだパターンにまとまっていない指摘/u);
  assert.match(text, /合成の禁止。鍵を記録に書かない/u);
  assert.match(text, /合成の事実その二/u);
  assert.doesNotMatch(text, /合成の訂正。受理済みの仕事を新しい鍵で送り直さない\*\*/u, "まとめた提案は1件ずつ並べない");
  // パターンの無い学びの束は今までと同じ形。
  assert.doesNotMatch(renderOverlay(plain.entries, NOW, context), /まとめた規則/u);
});

test("下書きの材料: 文の近い提案を組にする（書かない）", () => {
  const groups = suggestPatternGroups([
    proposal("ddddddddddd1", "fact", "再送の前に受理済みかを確かめる"),
    proposal("ddddddddddd2", "fact", "再送の前に受理済みかを必ず確かめる", { occurrences: 3 }),
    proposal("ddddddddddd3", "fact", "まったく別の話題の合成の事実"),
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].entries.map((entry) => entry.id).sort(), ["ddddddddddd1", "ddddddddddd2"]);
});
