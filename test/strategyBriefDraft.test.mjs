// 戦略の道具の作業フォルダからブリーフの下書きを組み立てる（strategy-brief.mjs draft --from-hyp）の試験。
// 作業フォルダ・文書・根拠の表・分析の出力・受け渡しファイルはすべて合成で、形だけを真似て作る。
// 戦略の道具のスクリプトもモデルも呼ばない。
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  evidencePremiseStaleness,
  strategyBriefPremiseDigests,
  strategySkillFingerprint,
  validateStrategyBrief,
} from "../lib/strategyBrief.mjs";
import {
  STRATEGY_TOOL_HANDOFF_VERSION,
  draftStrategyBriefFromTool,
  parseCsv,
} from "../lib/strategyBriefDraft.mjs";
import { DRAFT_CONTEXT_PLACEHOLDER } from "../lib/strategyBriefNext.mjs";
import { runStrategyBriefCli } from "../scripts/strategy-brief.mjs";
import {
  jsonBytes,
  metricsOutput,
  referralsOutput,
  sampleBrief,
  sha,
  snapshotOutput,
  workspace,
  writeAudienceRun,
  writeBytes,
  writeJson,
} from "./helpers/strategyBriefFixture.mjs";

const NOW = () => "2026-09-26T10:00:00.000Z";
const CHANNEL = "sample-channel";

/** 合成の戦略の道具の作業フォルダ（初期化が作る名前の文書・根拠の表・分析の出力）。 */
async function toolWorkDir(t) {
  const root = await workspace(t, "strategy-draft-");
  for (const name of ["brief.md", "diagnosis.md", "content-plan.md", "experiments.md", "data-dictionary.md"]) {
    await writeBytes(root, name, Buffer.from(`# 合成の${name}\n合成の本文。\n`, "utf8"));
  }
  const notes = await writeBytes(root, path.join("research", "notes.md"), Buffer.from("合成の調査メモ\n", "utf8"));
  const csv = [
    "evidence_id,observation,source_type,source_url_or_file,accessed_at,period_and_conditions,limitations",
    `E01,"合成の観測: 冒頭30秒で離れる人が多い, 特に初見",実測,research/notes.md,2026-09-20,"公開後7日、長尺のみ",一部の動画だけ`,
    "E02,\"合成の観測:\n改行を含む観測の文\",公開観察,https://example.invalid/synthetic,不明,,",
    ",空の id の行,公開観察,,,,",
  ].join("\r\n");
  const csvFile = await writeBytes(root, "evidence.csv", Buffer.from(`\uFEFF${csv}\r\n`, "utf8"));
  const run = await writeAudienceRun(root, "research/run-001");
  const staleRun = await writeAudienceRun(root, "research/run-stale");
  const receipt = JSON.parse(await readFile(path.join(staleRun.runDir, "completed", "taka.json"), "utf8"));
  await writeFile(path.join(staleRun.runDir, "results", receipt.result_file), "# 差し替えた合成の本文\n");
  const metrics = await writeJson(root, "analytics/metrics.json", metricsOutput());
  const referrals = await writeJson(root, "analytics/referrals.json", referralsOutput());
  const snapshot = await writeJson(root, "collection/snapshot.json", snapshotOutput());
  await writeJson(root, "analytics/unrelated.json", { synthetic: true });
  await writeJson(root, "quality/strategy-brief-loop.json", { synthetic: "state" });
  const skillDir = await workspace(t, "strategy-skill-");
  await writeBytes(skillDir, "SKILL.md", Buffer.from("合成のスキル\n"));
  await writeBytes(skillDir, "references/a.md", Buffer.from("合成の参照\n"));
  return { root, notes, csvFile, run, staleRun, metrics, referrals, snapshot, skillDir };
}

/** 上位の AI が needsAuthoring を埋めたことにする（合成の文面）。 */
function authored(draft, overrides = {}) {
  return {
    ...draft,
    channel: { ...draft.channel, designVersion: draft.channel.designVersion || "design-v1" },
    question: draft.question || "合成の問い: 最初の一手は何か",
    audience: draft.audience.who ? draft.audience : { who: "合成の視聴者像: 家業を継ぐか迷う30代", whyWatch: "合成の理由: 決断の材料がほしい" },
    entry: draft.entry.promises.length ? draft.entry : { promises: [{ id: "p-title", surface: "title", text: "合成のタイトルの約束" }] },
    payoffs: draft.payoffs.length ? draft.payoffs : [{ promiseId: "p-title", where: "合成の本文の中盤で回収する" }],
    production: draft.production.format ? draft.production : { format: "long", conditions: ["合成の制作条件: 既存の声を使う"] },
    postPublish: draft.postPublish.metrics.length ? draft.postPublish : sampleBrief().postPublish,
    provenance: { ...draft.provenance, host: "claude-code", contextId: "ctx-upper-1" },
    ...overrides,
  };
}

test("CSV: 引用符・引用符の中のカンマと改行・CRLF・BOM を読み、閉じない引用符は例外にする", () => {
  assert.deepEqual(parseCsv("\uFEFFa,b\r\n\"x,1\",\"y\n2\"\r\n\"q\"\"\",z\n"), [["a", "b"], ["x,1", "y\n2"], ["q\"", "z"]]);
  assert.throws(() => parseCsv("a,\"b\n"), { code: "strategy-draft-csv-unreadable" });
});

test("draft --from-hyp: 作業フォルダから根拠を集め、stale な run は外し、埋められない欄を needsAuthoring で返す", async (t) => {
  const fx = await toolWorkDir(t);
  const result = await draftStrategyBriefFromTool({ fromDir: fx.root, channelId: CHANNEL, strategySkillDir: fx.skillDir, now: NOW });
  assert.equal(result.modelCallsAttempted, false);
  assert.equal(result.strategyToolScriptsRun, false);
  const draft = result.briefDraft;
  const byKind = (kind) => draft.evidence.filter((row) => row.kind === kind);

  // 4分析の run は現行のものだけ。stale は理由つきで外す。
  assert.deepEqual(byKind("audience-run").map((row) => [row.path, row.sha256]), [["research/run-001", fx.run.reportManifestSha256]]);
  const excludedRun = result.excludedEvidence.find((row) => row.kind === "audience-run");
  assert.equal(excludedRun.path, "research/run-stale");
  assert.equal(excludedRun.reasonCode, "strategy-evidence-audience-run-stale");
  // 指標・関連元・取得スナップショット。実測の集計は前提に依らない。知らない JSON と品質ループの状態は根拠にしない。
  assert.deepEqual(byKind("metrics").map((row) => [row.path, row.sha256, row.premiseBound]), [["analytics/metrics.json", fx.metrics.sha256, false]]);
  assert.deepEqual(byKind("referrals").map((row) => row.path), ["analytics/referrals.json"]);
  assert.deepEqual(byKind("snapshot").map((row) => [row.path, row.collected.at]), [["collection/snapshot.json", "2026-09-20T00:00:00Z"]]);
  assert.ok(!draft.evidence.some((row) => row.path.startsWith("quality/") || row.path.endsWith("unrelated.json")));
  assert.deepEqual(result.sources.ignoredJson, [{ path: "analytics/unrelated.json", reason: "not-a-known-output" }]);
  // 作業文書は種類と SHA だけ（中身は読まない）。データの定義は前提に依らない。
  assert.deepEqual(result.sources.documents.map((row) => row.name), ["brief.md", "diagnosis.md", "content-plan.md", "experiments.md", "data-dictionary.md"]);
  assert.equal(byKind("planning-document").length, 5);
  assert.equal(byKind("planning-document").find((row) => row.path === "data-dictionary.md").premiseBound, false);
  // 根拠の表の行。作業フォルダのファイルを指す行はそのファイルの SHA、URL の行は表そのものの SHA に結ぶ。
  const csvRows = draft.evidence.filter((row) => row.id.startsWith("csv-"));
  assert.deepEqual(csvRows.map((row) => [row.id, row.path, row.sha256, row.collected.at]), [
    ["csv-e01", "research/notes.md", fx.notes.sha256, "2026-09-20"],
    ["csv-e02", "evidence.csv", fx.csvFile.sha256, "unknown"],
  ]);
  assert.equal(csvRows[0].collected.conditions, "公開後7日、長尺のみ");
  assert.deepEqual(result.sources.evidenceCsv.skipped, [{ line: 4, reason: "evidence-id-missing" }]);
  assert.deepEqual(draft.observations.map((row) => [row.id, row.evidenceIds]), [["obs-e01", ["csv-e01"]], ["obs-e02", ["csv-e02"]]]);
  assert.match(draft.observations[0].statement, /特に初見/u);
  // どれも provisional（verified には自動でしない）。パスは / 区切りの相対。
  assert.ok(draft.evidence.every((row) => row.state === "provisional"));
  assert.ok(draft.evidence.every((row) => !row.path.includes("\\") && !path.isAbsolute(row.path)));
  // 使った戦略の道具の版。
  assert.deepEqual(draft.provenance.strategySkill, { fingerprint: (await strategySkillFingerprint(fx.skillDir)).fingerprint, fileCount: 2 });
  assert.equal(draft.provenance.contextId, DRAFT_CONTEXT_PLACEHOLDER);

  // 企画の判断そのものは埋めない（null・空のまま。形の検査を通らない）。どの成果物から埋めるかを返す。
  assert.equal(draft.question, null);
  assert.ok(result.draftIssues.includes("missing:question"));
  const need = Object.fromEntries(result.needsAuthoring.map((row) => [row.field, row]));
  for (const field of ["question", "audience.who", "audience.whyWatch", "entry.promises", "payoffs", "production.format", "production.conditions", "postPublish.metrics", "channel.designVersion", "provenance.host", "provenance.contextId"]) {
    assert.equal(need[field]?.action, "author", field);
    assert.equal(need[field].priority, "required", field);
  }
  assert.deepEqual(need["entry.promises"].from, [{ path: "content-plan.md", role: "content-plan" }]);
  assert.ok(need["audience.who"].from.some((row) => row.path === "research/run-001" && row.role === "audience-run"));
  assert.ok(need["postPublish.metrics"].from.some((row) => row.path === "analytics/metrics.json"));
  assert.equal(need.hypotheses.priority, "recommended");
  assert.ok(result.nextSteps.some((line) => line.includes("applicability")));

  // 上位の AI が埋めると、形の検査を通る。
  const finished = authored(draft);
  assert.deepEqual(validateStrategyBrief(finished), { ok: true, issues: [], linkIssues: [] });
});

test("draft --from-hyp: --previous の問い・見る人・約束・制作条件・仮説・未確認事項と根拠を引き継ぎ、前提を変えると確認待ちになる", async (t) => {
  const fx = await toolWorkDir(t);
  const previousBrief = sampleBrief({
    label: "r3",
    evidence: [
      { id: "e-notes", kind: "market-research", path: "research/notes.md", sha256: fx.notes.sha256, state: "provisional", collected: { at: "2026-09-20", conditions: "合成" } },
      { id: "e-metrics", kind: "metrics", path: "analytics/metrics.json", sha256: fx.metrics.sha256, state: "provisional", collected: { at: "unknown", conditions: "合成" }, premiseBound: false, premiseIndependenceReason: "合成: 公開済みの実測" },
    ],
    changes: { previous: null, keep: [{ point: "合成の残す点", evidenceIds: ["e-notes"] }], change: [] },
    hypotheses: [{ id: "h-1", statement: "合成の仮説: 約束の回収が遅い", evidenceIds: ["e-notes"], status: "supported" }],
    openQuestions: [{ id: "q-1", question: "合成の未確認: 答えの深さ", blocksProduction: false, plannedCheck: "合成: コメントの4分析" }],
    provenance: { host: "codex", contextId: "ctx-planner-0", createdAt: "2026-09-21T00:00:00Z", strategySkill: { fingerprint: `sha256:${"0".repeat(64)}`, fileCount: 1 } },
  });
  const prevBytes = jsonBytes(previousBrief);
  await writeBytes(fx.root, "strategy-brief-r3.json", prevBytes);

  const result = await draftStrategyBriefFromTool({
    fromDir: fx.root, channelId: CHANNEL, previousPath: path.join(fx.root, "strategy-brief-r3.json"), strategySkillDir: fx.skillDir, now: NOW,
  });
  const draft = result.briefDraft;
  assert.equal(draft.label, "r4");
  assert.deepEqual(draft.changes.previous, { label: "r3", sha256: sha(prevBytes) });
  assert.equal(draft.question, previousBrief.question);
  assert.deepEqual(draft.audience, previousBrief.audience);
  assert.deepEqual(draft.entry, previousBrief.entry);
  assert.deepEqual(draft.production, previousBrief.production);
  assert.deepEqual(draft.hypotheses, previousBrief.hypotheses);
  assert.deepEqual(draft.openQuestions, previousBrief.openQuestions);
  assert.equal(draft.channel.designVersion, "design-v1");
  // 同じファイルは前のブリーフの行（id）を保ち、作業フォルダを読んだ行と二重にしない。
  assert.equal(draft.evidence.filter((row) => row.path === "analytics/metrics.json").length, 1);
  assert.equal(draft.evidence.find((row) => row.path === "analytics/metrics.json").id, "e-metrics");
  // 前提に結び付く引き継いだ行には、集めたときの前提（前のブリーフの前提）が付く。
  const notes = draft.evidence.find((row) => row.id === "e-notes");
  assert.deepEqual(notes.collected.premise, strategyBriefPremiseDigests(previousBrief));
  // 引き継いだ欄は「確かめる」、無い欄だけ「埋める」。
  const need = Object.fromEntries(result.needsAuthoring.map((row) => [row.field, row]));
  assert.equal(need.question.action, "confirm");
  assert.equal(need.question.filledFrom, "previous-brief");
  assert.equal(need["provenance.contextId"].action, "author");
  // 前の版と違う戦略の道具の版で作った（途中で黙って切り替えない）。
  assert.ok(result.issues.includes("strategy-skill-changed-from-previous"));

  const finished = authored(draft);
  assert.deepEqual(validateStrategyBrief(finished).issues, []);
  assert.deepEqual(validateStrategyBrief(finished).linkIssues, []);
  // 入口の言い方だけを変えても確認待ちにはならない。問いを変えると、前提に結び付く引き継いだ行が確認待ちになる。
  const entryOnly = { ...finished, entry: { promises: finished.entry.promises.map((row) => ({ ...row, text: `${row.text}（言い換え）` })) } };
  assert.deepEqual(evidencePremiseStaleness(entryOnly).stale, []);
  const changed = evidencePremiseStaleness({ ...finished, question: "合成の別の問い: 何から削るか" });
  assert.deepEqual(changed.reviewRequired.map((row) => row.id), ["e-notes"]);
});

test("draft --from-hyp: strategy-handoff.json を優先して取り込み、SHA はここで計算し、変わった・stale な根拠は外す", async (t) => {
  const fx = await toolWorkDir(t);
  const extra = await writeBytes(fx.root, path.join("research", "competitors.md"), Buffer.from("合成の競合の観察\n"));
  const handoff = {
    version: STRATEGY_TOOL_HANDOFF_VERSION,
    channel: { id: CHANNEL, designVersion: "design-v2" },
    strategySkill: { fingerprint: (await strategySkillFingerprint(fx.skillDir)).fingerprint },
    producedBy: { host: "codex", contextId: "ctx-tool-1" },
    question: "合成の問い（受け渡し）: 最初に削るものは何か",
    audience: { who: "合成の視聴者像（受け渡し）", whyWatch: "合成の理由（受け渡し）" },
    entry: { promises: [{ id: "p-title", surface: "title", text: "合成の約束（受け渡し）" }] },
    payoffs: [{ promiseId: "p-title", where: "合成の回収の箇所（受け渡し）" }],
    production: { format: "long", conditions: ["合成の条件（受け渡し）"], targetDurationSeconds: 1200 },
    changes: { keep: [{ point: "合成の残す点（受け渡し）", evidenceIds: ["h-competitors"] }], change: [] },
    hypotheses: [{ id: "h-a", statement: "合成の仮説（受け渡し）", evidenceIds: [], status: "untested" }],
    openQuestions: [{ id: "q-a", question: "合成の未確認（受け渡し）", blocksProduction: true, plannedCheck: "合成の確かめ方（受け渡し）" }],
    observations: [{ id: "o-a", statement: "合成の観測（受け渡し）", evidenceIds: ["h-competitors"] }],
    postPublish: sampleBrief().postPublish,
    evidence: [
      // Windows の区切りで書かれた相対パスも / へそろえる。
      { id: "h-competitors", kind: "market-research", path: "research\\competitors.md", collected: { at: "2026-09-24", conditions: "合成の観察の条件" } },
      { id: "h-changed", kind: "other", path: "research/notes.md", sha256: "0".repeat(64), collected: { at: "2026-09-24", conditions: "合成" } },
      { id: "h-verified", kind: "other", path: "brief.md", state: "verified", collected: { at: "2026-09-24", conditions: "合成" } },
      { id: "h-stale-run", kind: "audience-run", path: "research/run-stale", collected: { at: "2026-09-24", conditions: "合成" } },
      { id: "h-outside", kind: "other", path: "../outside.md", collected: { at: "2026-09-24", conditions: "合成" } },
    ],
    steps: [{ id: "audience-analysis", status: "partial", outputs: ["research/run-001"], note: "合成: 1本だけ" }],
  };
  await writeJson(fx.root, "strategy-handoff.json", handoff);
  const result = await draftStrategyBriefFromTool({ fromDir: fx.root, channelId: CHANNEL, strategySkillDir: fx.skillDir, now: NOW });
  const draft = result.briefDraft;
  assert.equal(result.sources.handoff.provided, true);
  assert.equal(result.sources.handoff.version, STRATEGY_TOOL_HANDOFF_VERSION);
  assert.deepEqual(result.sources.handoff.steps.map((row) => [row.id, row.status]), [["audience-analysis", "partial"]]);
  assert.equal(draft.question, handoff.question);
  assert.equal(draft.channel.designVersion, "design-v2");
  assert.deepEqual(draft.openQuestions, handoff.openQuestions);
  assert.deepEqual(draft.changes.keep, handoff.changes.keep);
  assert.equal(result.filledFrom.question, "handoff");
  const competitors = draft.evidence.find((row) => row.id === "h-competitors");
  assert.equal(competitors.path, "research/competitors.md");
  assert.equal(competitors.sha256, extra.sha256);
  assert.equal(competitors.state, "provisional");
  // 確かめ方の無い verified は provisional へ下げる（自動で verified にしない）。
  assert.equal(draft.evidence.find((row) => row.id === "h-verified").state, "provisional");
  assert.ok(result.issues.includes("strategy-handoff-evidence-state-downgraded:h-verified"));
  const excluded = Object.fromEntries(result.excludedEvidence.filter((row) => row.source === "handoff").map((row) => [row.id, row.reasonCode]));
  assert.equal(excluded["h-changed"], "strategy-handoff-evidence-changed");
  assert.equal(excluded["h-stale-run"], "strategy-evidence-audience-run-stale");
  assert.equal(excluded["h-outside"], "strategy-evidence-path-invalid");
  // 受け渡しの観測は根拠の表の観測より先。
  assert.equal(draft.observations[0].id, "o-a");
  // 受け渡しで埋まった欄は確かめるだけ。残る「埋める」は作った文脈だけ。
  const author = result.needsAuthoring.filter((row) => row.action === "author").map((row) => row.field);
  assert.deepEqual(author, ["provenance.host", "provenance.contextId"]);
  assert.ok(!result.issues.includes("strategy-skill-fingerprint-mismatch-with-handoff"));
  const finished = { ...draft, provenance: { ...draft.provenance, host: "claude-code", contextId: "ctx-upper-2" } };
  assert.deepEqual(validateStrategyBrief(finished), { ok: true, issues: [], linkIssues: [] });

  // 別のチャンネルの受け渡しは混ぜない。
  await assert.rejects(
    () => draftStrategyBriefFromTool({ fromDir: fx.root, channelId: "other-channel", now: NOW }),
    { code: "strategy-draft-channel-mismatch" },
  );
});

test("draft CLI: --out は作業フォルダの中に書き、既存のファイルは上書きしない。外は拒む", async (t) => {
  const fx = await toolWorkDir(t);
  const out = path.join(fx.root, "strategy-brief-draft.json");
  const chunks = [];
  const result = await runStrategyBriefCli(["draft", "--from-hyp", fx.root, "--channel", CHANNEL, "--out", out], { stdout: { write: (text) => chunks.push(text) }, now: NOW });
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(chunks.join("")).written.path, "strategy-brief-draft.json");
  assert.ok(result.result.issues.includes("strategy-skill-version-unrecorded"));
  const written = JSON.parse(await readFile(out, "utf8"));
  assert.equal(written.channel.id, CHANNEL);
  // 書いた下書きは次の draft で根拠に数えない（ブリーフは根拠ではない）。
  const again = await draftStrategyBriefFromTool({ fromDir: fx.root, channelId: CHANNEL, now: NOW });
  assert.ok(!again.briefDraft.evidence.some((row) => row.path === "strategy-brief-draft.json"));
  await assert.rejects(() => runStrategyBriefCli(["draft", "--from-hyp", fx.root, "--channel", CHANNEL, "--out", out], { stdout: { write: () => {} }, now: NOW }), { code: "strategy-draft-out-exists" });
  await assert.rejects(
    () => runStrategyBriefCli(["draft", "--from-hyp", fx.root, "--channel", CHANNEL, "--out", path.join(path.dirname(fx.root), "outside-draft.json")], { stdout: { write: () => {} }, now: NOW }),
    { code: "strategy-draft-out-outside-work-dir" },
  );
  await assert.rejects(() => draftStrategyBriefFromTool({ fromDir: fx.root, channelId: "bad id" }), { code: "strategy-draft-channel-invalid" });
});
