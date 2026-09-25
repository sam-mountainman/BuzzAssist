import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { evidencePremiseStaleness, strategyBriefPremiseDigests, validateStrategyBrief } from "../lib/strategyBrief.mjs";
import { DRAFT_CONTEXT_PLACEHOLDER, draftNextStrategyBrief, nextBriefLabel } from "../lib/strategyBriefNext.mjs";
import { runStrategyBriefCli } from "../scripts/strategy-brief.mjs";
import {
  jsonBytes,
  metricsOutput,
  referralsOutput,
  sampleBrief,
  sha,
  workspace,
  writeAudienceRun,
  writeBytes,
  writeJson,
} from "./helpers/strategyBriefFixture.mjs";

// チャンネル・動画 ID・文面はすべて合成の値。
const NOW = () => "2026-10-05T00:00:00.000Z";
const COMPARISON = { format: "long", window: "first_7d", traffic_source: "browse", metric_definition: "local-views-v1" };

const POST_METRICS = [
  { id: "m-ctr", source: "metrics", metric: "estimated_weighted_ctr_pct", comparison: COMPARISON, expectation: "合成: クリック率", expected: { comparator: ">=", value: 4.5 }, promiseIds: ["p-title"] },
  { id: "m-video-views", source: "metrics", metric: "views", videoId: "SYNTHVID002", comparison: COMPARISON, expectation: "合成: 本数", expected: { comparator: ">=", value: 1000 } },
  { id: "m-watch", source: "metrics", metric: "watch_time_hours", comparison: COMPARISON, expectation: "合成: 視聴時間", expected: { comparator: ">=", value: 100 } },
  { id: "m-28d", source: "metrics", metric: "views", comparison: { ...COMPARISON, window: "first_28d" }, expectation: "合成: 28日の本数", expected: { comparator: ">=", value: 1 } },
  { id: "m-ext", source: "referrals", metric: "external_share_pct", context: { format: "long" }, expectation: "合成: 外部からの流入", expected: { comparator: ">=", value: 50 } },
  { id: "m-noexp", source: "metrics", metric: "impressions", comparison: { ...COMPARISON, traffic_source: "Browse" }, expectation: "合成: 表示回数（照合だけ）" },
];

async function setup(t) {
  const root = await workspace(t);
  const notes = await writeBytes(root, "evidence/notes.md", Buffer.from("合成の調査メモ\n"));
  const brief = sampleBrief({
    label: "r3",
    // Windows の区切りで書かれた根拠のパス。
    evidence: [{ id: "e-notes", kind: "market-research", path: "evidence\\notes.md", sha256: notes.sha256, state: "provisional", collected: { at: "2026-09-20", conditions: "合成の調査" } }],
    changes: { previous: null, keep: [{ point: "合成の残す点", evidenceIds: ["e-notes"] }], change: [] },
    postPublish: { metrics: POST_METRICS },
  });
  const bytes = jsonBytes(brief);
  await writeBytes(root, "brief-r3.json", bytes);
  await writeJson(root, "post/metrics.json", metricsOutput());
  await writeJson(root, "post/referrals.json", referralsOutput());
  return { root, brief, briefSha256: sha(bytes), fromPath: path.join(root, "brief-r3.json") };
}

test("版の名前は末尾の数字を進める", () => {
  assert.equal(nextBriefLabel("r3"), "r4");
  assert.equal(nextBriefLabel("ep-12-r9"), "ep-12-r10");
  assert.equal(nextBriefLabel("draft"), "draft-next");
});

test("数字あり: 期待の数値と照らして残す点・変える点の候補にし、根拠のファイルへ結び付ける。無い・一部の数字は比べない", async (t) => {
  const { root, brief, briefSha256, fromPath } = await setup(t);
  const result = await draftNextStrategyBrief({
    fromPath,
    metricsPath: path.join(root, "post", "metrics.json"),
    referralsPath: path.join(root, "post", "referrals.json"),
    now: NOW,
  });
  assert.equal(result.modelCallsAttempted, false);
  const byId = Object.fromEntries(result.observations.map((row) => [row.metricId, row]));
  assert.equal(byId["m-ctr"].judgement, "met");
  assert.equal(byId["m-ctr"].observed, 5);
  assert.equal(byId["m-ctr"].caution, "pooled-group");
  assert.equal(byId["m-video-views"].judgement, "not-met");
  assert.equal(byId["m-video-views"].observed, 800);
  assert.equal(byId["m-watch"].status, "partial");
  assert.equal(byId["m-watch"].judgement, null);
  assert.equal(byId["m-28d"].status, "missing");
  assert.equal(byId["m-28d"].observed, null);
  assert.equal(byId["m-28d"].reasonCode, "metrics-group-not-found");
  assert.equal(byId["m-ext"].judgement, "met");
  assert.equal(byId["m-noexp"].status, "observed");
  assert.equal(byId["m-noexp"].reasonCode, "no-expected-value");

  assert.deepEqual(result.candidates.keep.map((row) => [row.metricId, row.evidenceIds]), [["m-ctr", ["post-metrics"]], ["m-ext", ["post-referrals"]]]);
  assert.deepEqual(result.candidates.change.map((row) => [row.metricId, row.evidenceIds]), [["m-video-views", ["post-metrics"]]]);
  assert.deepEqual(result.candidates.undetermined.map((row) => row.metricId), ["m-watch", "m-28d", "m-noexp"]);
  assert.match(result.candidates.undetermined[1].point, /推測で埋めない/u);

  const draft = result.briefDraft;
  assert.equal(draft.label, "r4");
  assert.deepEqual(draft.changes.previous, { label: "r3", sha256: briefSha256 });
  assert.equal(draft.question, brief.question);
  assert.deepEqual(draft.evidence.map((row) => row.id), ["e-notes", "post-metrics", "post-referrals"]);
  // 引き継いだ根拠は / 区切りになり、集めたときの前提（前のブリーフの前提）が書かれる。
  assert.equal(draft.evidence[0].path, "evidence/notes.md");
  assert.deepEqual(draft.evidence[0].collected.premise, strategyBriefPremiseDigests(brief));
  assert.ok(draft.evidence.every((row) => !row.path.includes("\\")));
  assert.ok(draft.evidence.slice(1).every((row) => row.state === "provisional" && row.premiseBound === false));
  // 作った文脈は空欄のまま（仕上げる会話が書く）。それ以外は形が合う。
  assert.equal(draft.provenance.contextId, DRAFT_CONTEXT_PLACEHOLDER);
  assert.deepEqual(result.draftIssues, ["invalid:provenance.contextId"]);
  const finished = { ...draft, provenance: { ...draft.provenance, contextId: "ctx-planner-2" } };
  assert.equal(validateStrategyBrief(finished).ok, true);

  // 下書きのまま問いを変えると、前の前提で集めた根拠（調査メモ）は古くなる。実測の数字は古くならない。
  const changed = evidencePremiseStaleness({ ...finished, question: "合成の別の問いに変えた" });
  assert.deepEqual(changed.stale.map((row) => row.id), ["e-notes"]);
});

test("数字なし: 関連元を渡さなければ source-not-provided、合う区分が無ければ missing で、候補に推測を入れない", async (t) => {
  const { root, fromPath } = await setup(t);
  await writeJson(root, "post/empty-metrics.json", metricsOutput({ groups: [] }));
  const result = await draftNextStrategyBrief({ fromPath, metricsPath: path.join(root, "post", "empty-metrics.json"), now: NOW });
  assert.deepEqual(result.candidates.keep, []);
  assert.deepEqual(result.candidates.change, []);
  assert.ok(result.observations.every((row) => row.observed === null && row.judgement === null));
  const ext = result.observations.find((row) => row.metricId === "m-ext");
  assert.equal(ext.status, "source-not-provided");
  assert.equal(result.sources.referrals.provided, false);
  assert.deepEqual(result.briefDraft.changes.keep, []);
  assert.deepEqual(result.briefDraft.changes.change, []);
});

test("4分析の run: 現行なら前の前提つきで根拠にし、stale なら理由つきで外す", async (t) => {
  const { root, brief, fromPath } = await setup(t);
  const current = await writeAudienceRun(root, "post/run-current");
  const stale = await writeAudienceRun(root, "post/run-stale");
  const receipt = JSON.parse(await readFile(path.join(stale.runDir, "completed", "taka.json"), "utf8"));
  await writeFile(path.join(stale.runDir, "results", receipt.result_file), "# 差し替えた合成の本文\n");

  const withCurrent = await draftNextStrategyBrief({ fromPath, metricsPath: path.join(root, "post", "metrics.json"), audienceRunPath: current.runDir, now: NOW });
  const row = withCurrent.briefDraft.evidence.find((entry) => entry.kind === "audience-run");
  assert.equal(row.path, "post/run-current");
  assert.equal(row.sha256, current.reportManifestSha256);
  assert.equal(row.state, "provisional");
  assert.deepEqual(row.collected.premise, strategyBriefPremiseDigests(brief));
  assert.equal(withCurrent.sources.audienceRun.status, "current");

  const withStale = await draftNextStrategyBrief({ fromPath, metricsPath: path.join(root, "post", "metrics.json"), audienceRunPath: stale.runDir, now: NOW });
  assert.ok(!withStale.briefDraft.evidence.some((entry) => entry.kind === "audience-run"));
  assert.equal(withStale.excludedEvidence[0].reasonCode, "strategy-evidence-audience-run-stale");
  assert.ok(withStale.excludedEvidence[0].reasons.some((reason) => reason.includes("taka")));
});

test("作業フォルダの外の数字は使わず、--out は既存のファイルを上書きしない。CLI も同じ結果", async (t) => {
  const { root, fromPath } = await setup(t);
  const outside = await workspace(t, "strategy-outside-");
  await writeJson(outside, "metrics.json", metricsOutput());
  await assert.rejects(
    draftNextStrategyBrief({ fromPath, metricsPath: path.join(outside, "metrics.json"), now: NOW }),
    { code: "strategy-next-outside-work-dir" },
  );
  await writeJson(root, "post/bad.json", { schema_version: "1.0", groups: [] });
  await assert.rejects(
    draftNextStrategyBrief({ fromPath, metricsPath: path.join(root, "post", "bad.json"), now: NOW }),
    { code: "strategy-next-metrics-format" },
  );

  const out = path.join(root, "brief-r4.json");
  const chunks = [];
  const cli = await runStrategyBriefCli(
    ["next", "--from", fromPath, "--metrics", path.join(root, "post", "metrics.json"), "--out", out],
    { stdout: { write: (chunk) => chunks.push(chunk) }, now: NOW },
  );
  assert.equal(cli.exitCode, 0);
  const printed = JSON.parse(chunks.join(""));
  assert.equal(printed.written.path, "brief-r4.json");
  const written = JSON.parse(await readFile(out, "utf8"));
  assert.equal(written.label, "r4");
  assert.equal(printed.written.sha256, sha(await readFile(out)));
  await assert.rejects(
    draftNextStrategyBrief({ fromPath, metricsPath: path.join(root, "post", "metrics.json"), outPath: out, now: NOW }),
    { code: "strategy-next-out-exists" },
  );
});
