// 戦略の道具の作業フォルダからブリーフの下書きを組み立てる（strategy-brief.mjs draft --from-hyp）の試験。
// 作業フォルダ・文書・根拠の表・分析の出力・受け渡しファイルはすべて合成で、形だけを真似て作る。
// 戦略の道具のスクリプトもモデルも呼ばない。
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  evidencePremiseStaleness,
  recordEvidenceApplicability,
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

const CSV_HEADER = "evidence_id,observation,source_type,source_url_or_file,accessed_at,period_and_conditions,limitations";

/** 根拠の行を、注記に書いた evidence_id ごとに数える（表の行から作った行だけ）。 */
function csvEvidenceById(evidence) {
  const out = new Map();
  for (const row of evidence) {
    const match = /^evidence\.csv の ([^（。]+)/u.exec(String(row.note ?? ""));
    if (match) out.set(match[1], [...(out.get(match[1]) || []), row]);
  }
  return out;
}

test("draft --previous: 根拠の表の同じ evidence_id は前の版の id のまま今の表で置き換え、前提と判定はファイルが同じときだけ引き継ぐ", async (t) => {
  const fx = await toolWorkDir(t);
  await writeBytes(fx.root, "research/a.md", Buffer.from("合成の調査 a（初版）\n", "utf8"));
  const movedBytes = Buffer.from("合成の調査 b\n", "utf8");
  await writeBytes(fx.root, "research/b.md", movedBytes);
  await writeBytes(fx.root, "research/c.md", Buffer.from("合成の調査 c\n", "utf8"));
  const csvV1 = [
    CSV_HEADER,
    "E01,合成の観測: 冒頭で離れる,実測,research/notes.md,2026-09-20,公開後7日,一部の動画だけ",
    "E02,合成の観測: 公開の観察,公開観察,https://example.invalid/synthetic-2,2026-09-20,,",
    "E03,合成の観測: 書き直す調査,調査,research/a.md,2026-09-20,,",
    "E04,合成の観測: 置き場を移す調査,調査,research/b.md,2026-09-20,,",
    "E05,合成の観測: 表から消す調査,調査,research/c.md,2026-09-20,,",
    "E_09,合成の観測: 表から消す別の根拠,公開観察,https://example.invalid/synthetic-9,2026-09-20,,",
    "E06,合成の観測: 限界を書き直す観察,公開観察,https://example.invalid/synthetic-6,2026-09-20,,古い限界",
  ].join("\n");
  await writeBytes(fx.root, "evidence.csv", Buffer.from(`${csvV1}\n`, "utf8"));

  // r1: 前の版なし。r2: 同じ作業フォルダ・同じ表で r1 から下書きする（重複が出ていた形）。
  const r1Draft = await draftStrategyBriefFromTool({ fromDir: fx.root, channelId: CHANNEL, strategySkillDir: fx.skillDir, now: NOW });
  const r1 = authored(r1Draft.briefDraft);
  await writeBytes(fx.root, "strategy-brief-r1.json", jsonBytes(r1));
  const r1CsvIds = r1.evidence.filter((row) => row.id.startsWith("csv-")).map((row) => row.id);
  assert.deepEqual(r1CsvIds, ["csv-e01", "csv-e02", "csv-e03", "csv-e04", "csv-e05", "csv-e-09", "csv-e06"]);

  const r2Draft = await draftStrategyBriefFromTool({
    fromDir: fx.root, channelId: CHANNEL, previousPath: path.join(fx.root, "strategy-brief-r1.json"), strategySkillDir: fx.skillDir, now: NOW,
  });
  const r2Evidence = r2Draft.briefDraft.evidence;
  assert.equal(new Set(r2Evidence.map((row) => row.id)).size, r2Evidence.length, "根拠の id が重ならない");
  assert.deepEqual(r2Evidence.filter((row) => row.id.startsWith("csv-")).map((row) => row.id), r1CsvIds, "前の版の id のまま・添字なし");
  assert.ok([...csvEvidenceById(r2Evidence).values()].every((rows) => rows.length === 1), "evidence_id ごとに1行");
  assert.equal(r2Draft.sources.evidenceCsv.reused, 7);
  assert.deepEqual(r2Draft.refreshedEvidence.filter((row) => row.id.startsWith("csv-")), []);
  const p1 = strategyBriefPremiseDigests(r1);
  for (const entry of r2Evidence.filter((row) => row.id.startsWith("csv-"))) assert.deepEqual(entry.collected.premise, p1, entry.id);
  assert.deepEqual(r2Draft.briefDraft.observations.map((row) => row.evidenceIds[0]), r1CsvIds, "観測は前の版の id を指す");
  assert.deepEqual(r2Draft.draftIssues.filter((code) => code.startsWith("link:")), []);

  // r2 を仕上げる: 問いを変え（前提が変わる）、表の3行に当てはまりの判定を書き、上位の AI が種類を直し、仮説を結ぶ。
  let r2 = authored(r2Draft.briefDraft, {
    question: "合成の問い（r2）: 何から削るか",
    hypotheses: [{ id: "h-1", statement: "合成の仮説: 書き直す調査が効く", evidenceIds: ["csv-e03"], status: "untested" }],
  });
  r2.evidence = r2.evidence.map((row) => (row.id === "csv-e01" ? { ...row, kind: "market-research" } : row));
  for (const evidenceId of ["csv-e01", "csv-e02", "csv-e03"]) {
    r2 = recordEvidenceApplicability(r2, { evidenceId, applies: true, reason: "合成の判定: 今の問いにも当てはまる", decidedBy: "ctx-judge-1" }).brief;
  }
  await writeBytes(fx.root, "strategy-brief-r2.json", jsonBytes(r2));
  const p2 = strategyBriefPremiseDigests(r2);

  // 作業フォルダを進める: E03 は書き直し、E04 は置き場を移し、E05・E_09 は表から消し、E-09・E07 を足し、E06 は限界を直す。
  // E01 はそのまま。E02 は表そのものに結ぶ行で、行の記載は変えない（表の SHA だけ変わる）。
  const rewritten = await writeBytes(fx.root, "research/a.md", Buffer.from("合成の調査 a（取り直し）\n", "utf8"));
  await writeBytes(fx.root, "research/moved/b.md", movedBytes);
  const added = await writeBytes(fx.root, "research/d.md", Buffer.from("合成の調査 d\n", "utf8"));
  const csvV2 = [
    CSV_HEADER,
    "E01,合成の観測: 冒頭で離れる,実測,research/notes.md,2026-09-20,公開後7日,一部の動画だけ",
    "E02,合成の観測: 公開の観察,公開観察,https://example.invalid/synthetic-2,2026-09-20,,",
    "E03,合成の観測: 書き直す調査,調査,research/a.md,2026-09-25,取り直した条件,",
    "E04,合成の観測: 置き場を移す調査,調査,research/moved/b.md,2026-09-20,,",
    "E-09,合成の観測: 新しい別の根拠,公開観察,https://example.invalid/synthetic-9b,2026-09-25,,",
    "E06,合成の観測: 限界を書き直す観察,公開観察,https://example.invalid/synthetic-6,2026-09-20,,新しい限界",
    "E07,合成の観測: 新しく足した根拠,調査,research/d.md,2026-09-25,,",
  ].join("\n");
  const csvV2File = await writeBytes(fx.root, "evidence.csv", Buffer.from(`${csvV2}\n`, "utf8"));

  const result = await draftStrategyBriefFromTool({
    fromDir: fx.root, channelId: CHANNEL, previousPath: path.join(fx.root, "strategy-brief-r2.json"), strategySkillDir: fx.skillDir, now: NOW,
  });
  const draft = result.briefDraft;
  const ids = draft.evidence.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length, "根拠の id が重ならない");
  const byCsvId = csvEvidenceById(draft.evidence);
  assert.ok([...byCsvId.values()].every((rows) => rows.length === 1), "evidence_id ごとに1行（古いパスの版と新しいパスの版を並べない）");
  const row = (sourceId) => byCsvId.get(sourceId)[0];
  assert.deepEqual(
    ["E01", "E02", "E03", "E04", "E05", "E_09", "E06", "E-09", "E07"].map((sourceId) => row(sourceId).id),
    ["csv-e01", "csv-e02", "csv-e03", "csv-e04", "csv-e05", "csv-e-09", "csv-e06", "csv-e-09-2", "csv-e07"],
    "添字は本当に別の根拠（表から消えた E_09 と新しい E-09）のときだけ",
  );
  assert.equal(result.sources.evidenceCsv.reused, 5);

  // 同じファイル・同じ SHA: id・上位の AI が直した種類・集めたときの前提・当てはまりの判定を引き継ぐ。
  assert.equal(row("E01").kind, "market-research");
  assert.equal(row("E01").sha256, fx.notes.sha256);
  assert.deepEqual(row("E01").collected.premise, p1);
  assert.equal(row("E01").applicability.premiseDigest, p2.digest);
  // 表そのものに結ぶ行は、表の SHA が変わっても行の記載が同じなら同じ根拠（SHA だけ今の表へ）。
  assert.equal(row("E02").path, "evidence.csv");
  assert.equal(row("E02").sha256, csvV2File.sha256);
  assert.deepEqual(row("E02").collected.premise, p1);
  assert.equal(row("E02").applicability.premiseDigest, p2.digest);
  // SHA が変わった行・パスが変わった行・記載を直した表の行は取り直した根拠: 今の表で置き換え、前の前提と判定を外す。
  assert.equal(row("E03").sha256, rewritten.sha256);
  assert.deepEqual(row("E03").collected, { at: "2026-09-25", conditions: "取り直した条件" });
  assert.equal(row("E03").applicability, undefined);
  assert.equal(row("E04").path, "research/moved/b.md");
  assert.equal(row("E04").sha256, sha(movedBytes));
  assert.equal(row("E04").collected.premise, undefined);
  assert.match(row("E06").note, /新しい限界/u);
  assert.equal(row("E06").collected.premise, undefined);
  assert.deepEqual(
    result.refreshedEvidence.filter((entry) => entry.id.startsWith("csv-")),
    [{ id: "csv-e03", path: "research/a.md" }, { id: "csv-e04", path: "research/moved/b.md", previousPath: "research/b.md" }, { id: "csv-e06", path: "evidence.csv" }],
  );
  // 前の版にだけある根拠は今までどおりそのまま引き継ぐ。新しい根拠は新しい id で provisional。
  assert.equal(row("E05").path, "research/c.md");
  assert.deepEqual(row("E05").collected.premise, p1);
  assert.deepEqual(row("E07"), {
    id: "csv-e07", kind: "other", path: "research/d.md", sha256: added.sha256, state: "provisional",
    collected: { at: "2026-09-25", conditions: "evidence.csv に条件の記載なし" }, note: "evidence.csv の E07（調査）",
  });
  // 観測・仮説は置き換えた後の id（前の版の id）を指す。
  const observed = Object.fromEntries(draft.observations.map((entry) => [entry.statement, entry.evidenceIds]));
  assert.deepEqual(observed["合成の観測: 冒頭で離れる"], ["csv-e01"]);
  assert.deepEqual(observed["合成の観測: 置き場を移す調査"], ["csv-e04"]);
  assert.deepEqual(observed["合成の観測: 新しい別の根拠"], ["csv-e-09-2"]);
  assert.deepEqual(draft.hypotheses, r2.hypotheses);

  const finished = authored(draft);
  assert.deepEqual(validateStrategyBrief(finished), { ok: true, issues: [], linkIssues: [] });
  // 前提が同じなら判定が効く。取り直した根拠と新しい根拠は今の前提に結び付くので確認は要らない。
  const same = evidencePremiseStaleness(finished);
  const status = (staleness, id) => staleness.rows.find((entry) => entry.id === id)?.status ?? null;
  assert.equal(status(same, "csv-e01"), "reusable");
  assert.equal(status(same, "csv-e02"), "reusable");
  for (const id of ["csv-e03", "csv-e04", "csv-e06", "csv-e07", "csv-e-09-2"]) assert.equal(status(same, id), null, id);
  assert.equal(status(same, "csv-e05"), "applicability-review-required");
  // 前提を変えると、前の前提への判定しかない引き継いだ行は確認待ちに戻る。
  const moved = evidencePremiseStaleness({ ...finished, question: "合成の問い（r3）: 誰に向けるか" });
  assert.equal(status(moved, "csv-e01"), "applicability-review-required");
  assert.equal(status(moved, "csv-e02"), "applicability-review-required");
  for (const id of ["csv-e03", "csv-e04", "csv-e06", "csv-e07"]) assert.equal(status(moved, id), null, id);
});

test("draft --previous: 以前の下書きが二重にした行は前の版の id へまとめて参照を付け替え、表の中で重なる evidence_id は別の行として知らせる", async (t) => {
  const fx = await toolWorkDir(t);
  const csv = [
    CSV_HEADER,
    `E01,"合成の観測: 冒頭30秒で離れる人が多い, 特に初見",実測,research/notes.md,2026-09-20,"公開後7日、長尺のみ",一部の動画だけ`,
    "E02,合成の観測: 公開の観察,公開観察,https://example.invalid/synthetic-2,不明,,",
    "E02,合成の観測: 同じ id の別の行,公開観察,https://example.invalid/synthetic-2b,不明,,",
  ].join("\n");
  await writeBytes(fx.root, "evidence.csv", Buffer.from(`${csv}\n`, "utf8"));
  const note = "evidence.csv の E01（実測）。限界: 一部の動画だけ";
  const previousBrief = sampleBrief({
    label: "r3",
    evidence: [
      { id: "csv-e01", kind: "other", path: "research/old-notes.md", sha256: "a".repeat(64), state: "provisional", collected: { at: "2026-09-19", conditions: "合成" }, note },
      { id: "csv-e01-2", kind: "other", path: "research/notes.md", sha256: fx.notes.sha256, state: "provisional", collected: { at: "2026-09-20", conditions: "合成" }, note },
    ],
    hypotheses: [{ id: "h-1", statement: "合成の仮説: 冒頭の約束が遅い", evidenceIds: ["csv-e01-2"], status: "supported" }],
  });
  await writeBytes(fx.root, "strategy-brief-r3.json", jsonBytes(previousBrief));
  const result = await draftStrategyBriefFromTool({ fromDir: fx.root, channelId: CHANNEL, previousPath: path.join(fx.root, "strategy-brief-r3.json"), now: NOW });
  const draft = result.briefDraft;
  const byCsvId = csvEvidenceById(draft.evidence);
  assert.deepEqual(byCsvId.get("E01").map((row) => [row.id, row.path, row.sha256]), [["csv-e01", "research/notes.md", fx.notes.sha256]]);
  assert.deepEqual(result.excludedEvidence.filter((row) => row.source === "previous"),
    [{ source: "previous", id: "csv-e01-2", reasonCode: "strategy-draft-evidence-duplicate-csv-row", keptId: "csv-e01" }]);
  assert.deepEqual(draft.hypotheses[0].evidenceIds, ["csv-e01"]);
  assert.deepEqual(draft.observations.find((row) => row.id === "obs-e01").evidenceIds, ["csv-e01"]);
  // 表の中で evidence_id が重なる行は別々の根拠のまま残し（添字が付く）、表を直すよう知らせる。
  assert.deepEqual(byCsvId.get("E02").map((row) => row.id), ["csv-e02", "csv-e02-2"]);
  assert.ok(result.issues.includes("strategy-draft-csv-evidence-id-duplicate:E02"));
  assert.deepEqual(validateStrategyBrief(authored(draft)).linkIssues, []);
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
